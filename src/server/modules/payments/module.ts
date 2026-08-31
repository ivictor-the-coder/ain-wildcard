import { defineModule } from '../../kernel/module';
import type { Ctx } from '../../kernel/context';
import { created, list, type Req } from '../../kernel/http';
import { conflict, notFound } from '../../../shared/errors';
import { formatMoney, money } from '../../../shared/money';
import v from '../../../shared/validate';
import { billingStore } from '../billing/module';
import type { Invoice } from '../billing/types';
import { DEFAULT_POLICY, type DunningListFilter, type RecoverySummary } from './dunning';
import type { ChargeListFilter, CollectionResult, IntentListFilter, RefundInput } from './gateway';
import type { MethodInput, MethodListFilter, MethodUpdateInput } from './methods';
import { PAYMENTS_MIGRATIONS } from './schema';
import { seedPayments } from './seed';
import { paymentsStore } from './store';
import { DECLINES, DECLINE_CODES } from './simulator';
import {
  BANK_ACCOUNT_TYPES, CARD_BRANDS, CARD_FUNDING, DISPUTE_REASONS, DUNNING_END_BEHAVIORS,
  PAYMENT_INTENT_STATUSES, PAYMENT_METHOD_TYPES, REFUND_REASONS, SIMULATED_BEHAVIORS,
  type Charge, type Dispute, type Dunning, type DunningPolicy, type DunningView,
  type PaymentMethod, type Refund,
} from './types';

/* --------------------------------- service -------------------------------- */

/**
 * What the rest of the platform needs from payments.
 *
 * `collectInvoice` is the one that matters: it is the same call the automatic
 * charge, the scheduled retry and the human "retry now" all make, so there is
 * exactly one code path by which money is taken in this platform.
 */
export interface PaymentsService {
  methods(orgId: string, customerId: string): PaymentMethod[];
  defaultMethod(orgId: string, customerId: string): PaymentMethod | null;
  /** Charge a bill with the best method on file. Never throws on a decline. */
  collectInvoice(orgId: string, invoiceId: string, opts?: { methodId?: string | null; offSession?: boolean }): CollectionResult;
  /** Collected against this bill beyond what it was owed, as account credit. */
  amountOverpaid(orgId: string, invoiceId: string): number;
  /** Every subscription in recovery, with the action a human should take. */
  recoveryQueue(orgId: string, filter?: DunningListFilter): DunningView[];
  recoverySummary(orgId: string): RecoverySummary;
  dunningForInvoice(orgId: string, invoiceId: string): Dunning | null;
  policy(orgId: string): DunningPolicy;
  charges(orgId: string, filter?: ChargeListFilter): Charge[];
  refund(orgId: string, input: RefundInput): Refund;
}

declare module '../../kernel/services' {
  interface ServiceRegistry { payments: PaymentsService }
}

const writeMeta = (req: Req) => ({
  actorId: req.auth.userId ?? req.auth.keyId ?? null,
  actorType: (req.auth.kind === 'api_key' ? 'api_key' : req.auth.kind === 'system' ? 'system' : 'user') as
    'user' | 'api_key' | 'system',
  requestId: req.requestId,
  livemode: req.auth.livemode,
});

const localeOf = (ctx: Ctx, orgId: string): string => {
  try { return ctx.svc.core.org(orgId).locale || 'en-US'; }
  catch { return 'en-US'; }
};

/* ------------------------------- validators ------------------------------- */

const methodCreateBody = v.object({
  type: v.default(v.enum(PAYMENT_METHOD_TYPES), 'card'),
  customer: v.id('cus'),
  id: v.optional(v.id('pm')),
  brand: v.optional(v.enum(CARD_BRANDS)),
  exp_month: v.optional(v.int({ min: 1, max: 12 })),
  exp_year: v.optional(v.int({ min: 2000, max: 2100 })),
  funding: v.optional(v.enum(CARD_FUNDING)),
  country: v.optional(v.string({ max: 80 })),
  bank_name: v.optional(v.string({ max: 120 })),
  account_type: v.optional(v.enum(BANK_ACCOUNT_TYPES)),
  last4: v.optional(v.string({ min: 4, max: 4 })),
  simulated_behavior: v.optional(v.enum(SIMULATED_BEHAVIORS)),
  simulated_decline_count: v.optional(v.int({ min: 0, max: 20 })),
  billing_name: v.optional(v.string({ max: 200 })),
  billing_email: v.optional(v.email()),
  set_default: v.optional(v.boolean()),
  metadata: v.metadata(),
});

const methodUpdateBody = v.object({
  exp_month: v.optional(v.int({ min: 1, max: 12 })),
  exp_year: v.optional(v.int({ min: 2000, max: 2100 })),
  billing_name: v.optional(v.string({ max: 200 })),
  billing_email: v.optional(v.email()),
  simulated_behavior: v.optional(v.enum(SIMULATED_BEHAVIORS)),
  simulated_decline_count: v.optional(v.int({ min: 0, max: 20 })),
  metadata: v.optional(v.metadata()),
});

const intentCreateBody = v.object({
  customer: v.id('cus'),
  amount: v.optional(v.int({ min: 1, max: 100_000_000 })),
  currency: v.optional(v.currency()),
  payment_method: v.optional(v.id('pm')),
  invoice: v.optional(v.id('in')),
  description: v.optional(v.string({ max: 500 })),
  statement_descriptor: v.optional(v.string({ max: 22 })),
  off_session: v.optional(v.boolean()),
  confirm: v.optional(v.boolean()),
  idempotency_key: v.optional(v.string({ max: 200 })),
  metadata: v.metadata(),
});

const refundCreateBody = v.object({
  charge: v.optional(v.id('ch')),
  payment_intent: v.optional(v.id('pi')),
  invoice: v.optional(v.id('in')),
  amount: v.optional(v.int({ min: 1, max: 100_000_000 })),
  reason: v.optional(v.enum(REFUND_REASONS)),
  description: v.optional(v.string({ max: 500 })),
});

const disputeCreateBody = v.object({
  charge: v.optional(v.id('ch')),
  invoice: v.optional(v.id('in')),
  reason: v.enum(DISPUTE_REASONS),
  amount: v.optional(v.int({ min: 1, max: 100_000_000 })),
  evidence_due_days: v.optional(v.int({ min: 1, max: 90 })),
});

const evidenceBody = v.object({
  product_description: v.optional(v.string({ max: 5000 })),
  customer_communication: v.optional(v.string({ max: 5000 })),
  service_documentation: v.optional(v.string({ max: 5000 })),
  cancellation_policy: v.optional(v.string({ max: 5000 })),
  uncategorized_text: v.optional(v.string({ max: 5000 })),
});

const policyBody = v.object({
  retry_days: v.optional(v.array(v.int({ min: 1, max: 60 }), { min: 1, max: 11 })),
  max_attempts: v.optional(v.int({ min: 1, max: 12 })),
  end_behavior: v.optional(v.enum(DUNNING_END_BEHAVIORS)),
  skip_weekends: v.optional(v.boolean()),
  hard_decline_multiplier: v.optional(v.number({ min: 1, max: 6 })),
  collection_hour: v.optional(v.int({ min: 0, max: 23 })),
  jitter_hours: v.optional(v.int({ min: 0, max: 12 })),
  give_up_codes: v.optional(v.array(v.enum(DECLINE_CODES), { max: 9 })),
});

/** The shape every collection route answers with — the outcome, in words. */
const collectionResponse = (ctx: Ctx, orgId: string, result: CollectionResult) => {
  const locale = localeOf(ctx, orgId);
  const store = paymentsStore(ctx);
  const campaign = store.dunning.forInvoice(orgId, result.invoice.id);
  const show = (amount: number) => formatMoney(money(amount, result.invoice.currency), { locale });
  const action = result.intent?.status === 'requires_action' ? result.intent.next_action : null;
  return {
    object: 'collection_attempt',
    collected: result.collected,
    invoice: result.invoice,
    payment_intent: result.intent,
    charge: result.charge,
    payment_method: result.method,
    failure: result.failure,
    skipped: result.skipped,
    /** Set when the issuer wants the cardholder: nothing was charged, and this is where they say yes. */
    next_action: action,
    dunning: campaign ? store.dunning.view(orgId, campaign) : null,
    summary: result.collected
      ? `${show(result.charge?.amount ?? 0)} collected against ${result.invoice.number}.`
      : action
        ? `The issuer wants the cardholder to confirm ${show(result.intent?.amount ?? result.invoice.amount_due)} against ${result.invoice.number}. Nothing has been charged yet — they approve it at POST ${action.authenticate_url}.`
        : result.skipped
          ?? `${result.invoice.number} was refused: ${result.failure?.message ?? 'the charge did not go through.'} ${result.failure?.advice ?? ''}`.trim(),
  };
};

/* --------------------------------- module --------------------------------- */

export default defineModule({
  name: 'payments',
  title: 'Payments & smart dunning',
  description: 'A deterministic simulated processor with the real intent state machine, refunds and disputes, and a retry engine that knows which declines are worth another attempt and which need a new card.',
  dependsOn: ['core', 'billing'],
  migrations: PAYMENTS_MIGRATIONS,

  boot(ctx) {
    const store = paymentsStore(ctx);
    const billing = billingStore(ctx).billing;

    const service: PaymentsService = {
      methods: (orgId, customerId) => store.methods.forCustomer(orgId, customerId),
      defaultMethod: (orgId, customerId) => store.methods.defaultFor(orgId, customerId),
      collectInvoice: (orgId, invoiceId, opts) =>
        store.gateway.collectInvoice(orgId, invoiceId, {
          source: 'api', methodId: opts?.methodId ?? null, offSession: opts?.offSession ?? true,
        }),
      amountOverpaid: (orgId, invoiceId) => store.gateway.overpaidOn(orgId, invoiceId),
      recoveryQueue: (orgId, filter) => store.dunning.queue(orgId, filter).data,
      recoverySummary: (orgId) => store.dunning.summary(orgId),
      dunningForInvoice: (orgId, invoiceId) => store.dunning.forInvoice(orgId, invoiceId),
      policy: (orgId) => store.dunning.policy(orgId),
      charges: (orgId, filter) => store.gateway.listCharges(orgId, filter).data,
      refund: (orgId, input) => store.gateway.createRefund(orgId, input),
    };
    ctx.provide('payments', service);

    /* ---------------------------------- jobs -------------------------------- */

    /**
     * Collect a bill that has just been finalised.
     *
     * It is a job rather than a call inside billing's own transaction on
     * purpose: a decline must not be able to roll back the invoice that
     * produced it, and the queue is what makes the charge replayable.
     */
    ctx.jobs.handle('payments.collect_invoice', (payload: { invoice: string }, job) => {
      const invoice = billing.invoices.invoice(job.org_id, payload.invoice);
      if (!invoice) return;
      if (store.gateway.uncollectableReason(invoice)) return;
      store.gateway.collectInvoice(job.org_id, invoice.id, { source: 'invoice_collection', meta: { actorType: 'system' } });
    });

    ctx.jobs.handle('payments.dunning_retry', (payload: { dunning: string }, job) => {
      store.dunning.runScheduledAttempt(job.org_id, payload.dunning);
    });

    ctx.jobs.handle('payments.settle_debit', (payload: { intent: string; charge: string }, job) => {
      store.gateway.settleDebit(job.org_id, payload.intent, payload.charge);
    });

    ctx.jobs.handle('payments.dispute_deadline', (payload: { dispute: string }, job) => {
      store.gateway.expireDispute(job.org_id, payload.dispute);
    });

    /* -------------------------- reactions to billing ------------------------ */

    /**
     * A finalised invoice on a card is a charge waiting to happen.
     *
     * Nothing is enqueued for an account with no method on file — there is
     * nothing to present, and a queue full of jobs that can only fail is how a
     * retry engine loses the ability to say anything useful.
     */
    ctx.events.on('invoice.finalized', (event) => {
      const invoice = event.data as Invoice;
      if (!invoice?.id || invoice.status !== 'open') return;
      if (invoice.collection_method !== 'charge_automatically' || invoice.amount_due <= 0) return;
      if (invoice.subscription) {
        // `unpaid` and `paused` both mean the same thing to this module: bills
        // keep being raised, and nobody is charging a card for them. Presenting
        // anyway would make both settings meaningless.
        const sub = ctx.svc.billing.subscription(event.org_id, invoice.subscription);
        if (sub && (sub.status === 'unpaid' || sub.status === 'paused')) return;
      }
      if (!store.methods.defaultFor(event.org_id, invoice.customer)) return;
      ctx.enqueue(event.org_id, 'payments.collect_invoice', { invoice: invoice.id }, {
        idemKey: `payments.collect_invoice:${invoice.id}`,
      });
    }, 'payments');

    /**
     * Settled by something other than a charge — a human marking it paid, a
     * credit note covering it, account balance absorbing it. Whatever it was,
     * there is no longer anything to recover.
     */
    ctx.events.on('invoice.paid', (event) => {
      const invoiceId = event.object_id;
      if (!invoiceId) return;
      const byCharge = ctx.db.count(
        `SELECT COUNT(*) FROM payments_charges WHERE org_id = ? AND invoice_id = ? AND status = 'succeeded'`,
        event.org_id, invoiceId,
      );
      if (byCharge > 0) return;
      store.dunning.stopFor(event.org_id, invoiceId, 'The invoice was settled outside the retry schedule, so recovery stopped.');
    }, 'payments');

    ctx.events.on('invoice.voided', (event) => {
      if (!event.object_id) return;
      store.dunning.stopFor(event.org_id, event.object_id, 'The invoice was withdrawn, so there is nothing left to chase.');
    }, 'payments');

    ctx.events.on('invoice.marked_uncollectible', (event) => {
      if (!event.object_id) return;
      store.dunning.stopFor(event.org_id, event.object_id, 'The invoice was written off, so recovery stopped.');
    }, 'payments');

    /**
     * Giving up on an account is the last thing that happens, not the first.
     *
     * The attempt that exhausted the schedule also emitted
     * `invoice.payment_failed`, and billing's own handler turns that into
     * `past_due`. Both are in flight together, so the end behaviour waits for
     * this event — emitted after it — and lands on top rather than underneath.
     */
    ctx.events.on('dunning.exhausted', (event) => {
      if (!event.object_id) return;
      store.dunning.applyEnd(event.org_id, event.object_id);
    }, 'payments');

    // A subscription that ends stops being chased. Its bills stay on the books.
    ctx.events.on('subscription.canceled', (event) => {
      if (!event.object_id) return;
      const rows = ctx.db.all<{ invoice_id: string }>(
        `SELECT invoice_id FROM payments_dunning WHERE org_id = ? AND subscription_id = ? AND status = 'recovering'`,
        event.org_id, event.object_id,
      );
      for (const row of rows) {
        store.dunning.stopFor(event.org_id, row.invoice_id, 'The subscription was cancelled, so the retry schedule was stood down.');
      }
    }, 'payments');
  },

  seed(ctx, orgId) {
    seedPayments(ctx, orgId);
  },

  routes(router) {
    /* ----------------------------- payment methods -------------------------- */

    router.get('/v1/payment_methods', (req: Req, c: Ctx) => {
      const q = req.query as MethodListFilter;
      const page = paymentsStore(c).methods.list(req.auth.orgId, {
        customer: q.customer, type: q.type, status: q.status, behavior: q.behavior,
        limit: q.limit, cursor: q.cursor ?? null,
      });
      return list(page.data, { hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: page.totalCount, url: '/v1/payment_methods' });
    }, {
      summary: 'List payment methods', tags: ['payments'],
      description: 'Cards and direct debits on file. Filter by behaviour to find every account whose card is set to decline.',
      query: v.object({
        customer: v.optional(v.id('cus')),
        type: v.optional(v.enum(PAYMENT_METHOD_TYPES)),
        status: v.optional(v.enum(['attached', 'detached', 'all'])),
        behavior: v.optional(v.enum(SIMULATED_BEHAVIORS)),
        limit: v.optional(v.int({ min: 1, max: 200 })),
        cursor: v.optional(v.string({ max: 200 })),
      }),
    });

    router.post('/v1/payment_methods', (req: Req, c: Ctx) =>
      created(paymentsStore(c).methods.create(req.auth.orgId, req.body as MethodInput, writeMeta(req))), {
      summary: 'Attach a payment method', tags: ['payments'], roles: ['member'], idempotent: true,
      description: 'This is a simulated processor and never accepts a card number. Give it a brand, an expiry and the outcome you want it to produce: simulated_behavior decides every charge against it, and simulated_decline_count says how many of the next attempts decline before it starts succeeding. Pass an id only when migrating a book of business whose subscriptions already name their pm_… methods.',
      body: methodCreateBody,
    });

    router.get('/v1/payment_methods/:id', (req: Req, c: Ctx) =>
      paymentsStore(c).methods.require(req.auth.orgId, req.params.id), {
      summary: 'Retrieve a payment method', tags: ['payments'],
    });

    router.patch('/v1/payment_methods/:id', (req: Req, c: Ctx) =>
      paymentsStore(c).methods.update(req.auth.orgId, req.params.id, req.body as MethodUpdateInput, writeMeta(req)), {
      summary: 'Update a payment method', tags: ['payments'], roles: ['member'],
      description: 'Change the expiry a customer sent through, or retune the simulated behaviour to reproduce a decline you are chasing.',
      body: methodUpdateBody,
    });

    router.post('/v1/payment_methods/:id/attach', (req: Req, c: Ctx) =>
      paymentsStore(c).methods.attach(req.auth.orgId, req.params.id, (req.body as { customer: string }).customer, writeMeta(req)), {
      summary: 'Attach a method to a customer', tags: ['payments'], roles: ['member'],
      body: v.object({ customer: v.id('cus') }),
    });

    router.post('/v1/payment_methods/:id/detach', (req: Req, c: Ctx) =>
      paymentsStore(c).methods.detach(req.auth.orgId, req.params.id, writeMeta(req)), {
      summary: 'Detach a payment method', tags: ['payments'], roles: ['member'],
      description: 'The row stays: charges point at it, and a detached card still has to explain last March’s invoice. If it was the default, the next method on the account takes over.',
    });

    router.post('/v1/payment_methods/:id/set_default', (req: Req, c: Ctx) =>
      paymentsStore(c).methods.setDefault(req.auth.orgId, req.params.id, writeMeta(req)), {
      summary: 'Make this the customer’s default method', tags: ['payments'], roles: ['member'],
    });

    router.get('/v1/customers/:id/payment_methods', (req: Req, c: Ctx) => {
      const store = paymentsStore(c);
      const methods = store.methods.forCustomer(req.auth.orgId, req.params.id);
      return list(methods, { totalCount: methods.length, url: `/v1/customers/${req.params.id}/payment_methods` });
    }, {
      summary: 'A customer’s payment methods', tags: ['payments'],
    });

    /* ----------------------------- payment intents -------------------------- */

    router.get('/v1/payment_intents', (req: Req, c: Ctx) => {
      const q = req.query as IntentListFilter;
      const page = paymentsStore(c).gateway.listIntents(req.auth.orgId, {
        customer: q.customer, invoice: q.invoice, status: q.status, source: q.source,
        limit: q.limit, cursor: q.cursor ?? null,
      });
      return list(page.data, { hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: page.totalCount, url: '/v1/payment_intents' });
    }, {
      summary: 'List payment intents', tags: ['payments'],
      query: v.object({
        customer: v.optional(v.id('cus')),
        invoice: v.optional(v.id('in')),
        status: v.optional(v.enum([...PAYMENT_INTENT_STATUSES, 'all'])),
        source: v.optional(v.enum(['api', 'invoice_collection', 'dunning_retry', 'manual_retry'])),
        limit: v.optional(v.int({ min: 1, max: 200 })),
        cursor: v.optional(v.string({ max: 200 })),
      }),
    });

    router.post('/v1/payment_intents', (req: Req, c: Ctx) =>
      created(paymentsStore(c).gateway.createIntent(req.auth.orgId, req.body as any, writeMeta(req))), {
      summary: 'Create a payment intent', tags: ['payments'], roles: ['member'], idempotent: true,
      description: 'Leave out amount and currency to charge exactly what an invoice still owes. Pass confirm=true to present it immediately; idempotency_key makes a replayed create return the first intent instead of charging twice. An amount named here is a ceiling, not a promise: an invoice-bound intent is re-priced against the live balance at confirm time and refused outright once there is nothing left to collect, so two intents on one bill can never both take the money.',
      body: intentCreateBody,
    });

    router.get('/v1/payment_intents/:id', (req: Req, c: Ctx) =>
      paymentsStore(c).gateway.requireIntent(req.auth.orgId, req.params.id), {
      summary: 'Retrieve a payment intent', tags: ['payments'],
    });

    router.post('/v1/payment_intents/:id/confirm', (req: Req, c: Ctx) => {
      const body = req.body as { payment_method?: string; off_session?: boolean };
      return paymentsStore(c).gateway.confirmIntent(req.auth.orgId, req.params.id, body, writeMeta(req));
    }, {
      summary: 'Confirm and present a payment intent', tags: ['payments'], roles: ['member'],
      description: 'off_session=true means nobody is at the keyboard, which is the difference between an authentication prompt and an authentication_required decline — exactly as it is with a real issuer. An intent bound to an invoice is priced against that invoice as it stands at this moment, not as it stood when the intent was made: a bill with nothing left owed refuses with invoice_already_paid, invoice_void, invoice_uncollectible or invoice_not_finalized before the card is touched, and a bill that has shrunk since — a credit note landed, someone paid part of it — takes the intent down with it rather than collecting the difference.',
      body: v.object({
        payment_method: v.optional(v.id('pm')),
        off_session: v.optional(v.boolean()),
      }),
    });

    router.post('/v1/payment_intents/:id/authenticate', (req: Req, c: Ctx) => {
      const body = req.body as { result: 'approve' | 'abandon' };
      return paymentsStore(c).gateway.authenticate(req.auth.orgId, req.params.id, body.result === 'approve', writeMeta(req));
    }, {
      summary: 'Complete the authentication step', tags: ['payments'], roles: ['member'],
      description: 'Stands in for the issuer’s 3-D Secure page. The state machine is real; the page is simulated, and the intent’s next_action says so.',
      body: v.object({ result: v.enum(['approve', 'abandon']) }),
    });

    router.post('/v1/payment_intents/:id/cancel', (req: Req, c: Ctx) => {
      const body = req.body as { cancellation_reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer' | 'abandoned' | 'superseded' };
      return paymentsStore(c).gateway.cancelIntent(req.auth.orgId, req.params.id, body.cancellation_reason ?? 'abandoned', writeMeta(req));
    }, {
      summary: 'Cancel a payment intent', tags: ['payments'], roles: ['member'],
      body: v.object({ cancellation_reason: v.optional(v.enum(['duplicate', 'fraudulent', 'requested_by_customer', 'abandoned', 'superseded'])) }),
    });

    /* --------------------------------- charges ------------------------------ */

    router.get('/v1/charges', (req: Req, c: Ctx) => {
      const q = req.query as ChargeListFilter;
      const page = paymentsStore(c).gateway.listCharges(req.auth.orgId, {
        customer: q.customer, invoice: q.invoice, payment_intent: q.payment_intent,
        status: q.status, disputed: q.disputed, limit: q.limit, cursor: q.cursor ?? null,
      });
      return list(page.data, { hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: page.totalCount, url: '/v1/charges' });
    }, {
      summary: 'List charges', tags: ['payments'],
      description: 'Every presentation, successful or not. Each carries an outcome explaining the issuer’s decision in words.',
      query: v.object({
        customer: v.optional(v.id('cus')),
        invoice: v.optional(v.id('in')),
        payment_intent: v.optional(v.id('pi')),
        status: v.optional(v.enum(['pending', 'succeeded', 'failed', 'all'])),
        disputed: v.optional(v.boolean()),
        limit: v.optional(v.int({ min: 1, max: 200 })),
        cursor: v.optional(v.string({ max: 200 })),
      }),
    });

    router.get('/v1/charges/:id', (req: Req, c: Ctx) =>
      paymentsStore(c).gateway.requireCharge(req.auth.orgId, req.params.id), {
      summary: 'Retrieve a charge', tags: ['payments'],
    });

    /* --------------------------------- refunds ------------------------------ */

    router.get('/v1/refunds', (req: Req, c: Ctx) => {
      const q = req.query as { charge?: string; invoice?: string; customer?: string; limit?: number; cursor?: string };
      const page = paymentsStore(c).gateway.listRefunds(req.auth.orgId, { ...q, cursor: q.cursor ?? null });
      return list(page.data, { hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: page.totalCount, url: '/v1/refunds' });
    }, {
      summary: 'List refunds', tags: ['payments'],
      query: v.object({
        charge: v.optional(v.id('ch')),
        invoice: v.optional(v.id('in')),
        customer: v.optional(v.id('cus')),
        limit: v.optional(v.int({ min: 1, max: 200 })),
        cursor: v.optional(v.string({ max: 200 })),
      }),
    });

    router.post('/v1/refunds', (req: Req, c: Ctx) =>
      created(paymentsStore(c).gateway.createRefund(req.auth.orgId, req.body as RefundInput, writeMeta(req))), {
      summary: 'Refund a charge', tags: ['payments'], roles: ['member'], idempotent: true,
      description: 'Moves cash back and takes it off what the invoice records as collected, which leaves the bill owed again. A refund does not rewrite what was billed — to reduce the bill itself, and the tax on it, raise a credit note.',
      body: refundCreateBody,
    });

    router.get('/v1/refunds/:id', (req: Req, c: Ctx) => {
      const refund = paymentsStore(c).gateway.refund(req.auth.orgId, req.params.id);
      if (!refund) throw notFound('refund', req.params.id);
      return refund;
    }, { summary: 'Retrieve a refund', tags: ['payments'] });

    /* -------------------------------- disputes ------------------------------ */

    router.get('/v1/disputes', (req: Req, c: Ctx) => {
      const q = req.query as { customer?: string; invoice?: string; status?: Dispute['status'] | 'all'; limit?: number; cursor?: string };
      const page = paymentsStore(c).gateway.listDisputes(req.auth.orgId, { ...q, cursor: q.cursor ?? null });
      return list(page.data, { hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: page.totalCount, url: '/v1/disputes' });
    }, {
      summary: 'List disputes', tags: ['payments'],
      query: v.object({
        customer: v.optional(v.id('cus')),
        invoice: v.optional(v.id('in')),
        status: v.optional(v.enum(['needs_response', 'under_review', 'won', 'lost', 'all'])),
        limit: v.optional(v.int({ min: 1, max: 200 })),
        cursor: v.optional(v.string({ max: 200 })),
      }),
    });

    router.post('/v1/disputes', (req: Req, c: Ctx) =>
      created(paymentsStore(c).gateway.openDispute(req.auth.orgId, req.body as any, writeMeta(req))), {
      summary: 'Open a dispute against a charge', tags: ['payments'], roles: ['member'], idempotent: true,
      description: 'The network withdraws the money the day the cardholder complains, so opening a dispute takes it straight back off the invoice. Answer before evidence_due_by or it is lost by default — that deadline is a scheduled job, not a reminder.',
      body: disputeCreateBody,
    });

    router.get('/v1/disputes/:id', (req: Req, c: Ctx) =>
      paymentsStore(c).gateway.requireDispute(req.auth.orgId, req.params.id), {
      summary: 'Retrieve a dispute', tags: ['payments'],
    });

    router.post('/v1/disputes/:id/evidence', (req: Req, c: Ctx) =>
      paymentsStore(c).gateway.submitEvidence(req.auth.orgId, req.params.id, req.body as any, writeMeta(req)), {
      summary: 'Submit dispute evidence', tags: ['payments'], roles: ['member'],
      body: evidenceBody,
    });

    router.post('/v1/disputes/:id/close', (req: Req, c: Ctx) => {
      const body = req.body as { status: 'won' | 'lost'; note?: string };
      return paymentsStore(c).gateway.closeDispute(req.auth.orgId, req.params.id, body.status === 'won', body.note ?? null, writeMeta(req));
    }, {
      summary: 'Close a dispute', tags: ['payments'], roles: ['member'],
      description: 'Winning returns the money to the invoice. Losing writes the invoice off as uncollectible, which billing turns into an unpaid subscription through its own status machine.',
      body: v.object({ status: v.enum(['won', 'lost']), note: v.optional(v.string({ max: 1000 })) }),
    });

    /* -------------------------------- recovery ------------------------------ */

    router.get('/v1/dunning', (req: Req, c: Ctx) => {
      const q = req.query as DunningListFilter;
      const queue = paymentsStore(c).dunning.queue(req.auth.orgId, {
        status: q.status, customer: q.customer, subscription: q.subscription, limit: q.limit,
      });
      return list(queue.data, { totalCount: queue.totalCount, url: '/v1/dunning' });
    }, {
      summary: 'The recovery queue', tags: ['payments'],
      description: 'Every invoice being chased, ordered by the next attempt: what is at risk, how many attempts are left, what the issuer said last time, and what a human should do about it today.',
      query: v.object({
        status: v.optional(v.enum(['open', 'recovering', 'recovered', 'exhausted', 'canceled', 'all'])),
        customer: v.optional(v.id('cus')),
        subscription: v.optional(v.id('sub')),
        limit: v.optional(v.int({ min: 1, max: 200 })),
      }),
    });

    router.get('/v1/dunning/summary', (req: Req, c: Ctx) =>
      paymentsStore(c).dunning.summary(req.auth.orgId), {
      summary: 'Recovery performance', tags: ['payments'],
      description: 'What is at risk, what has been recovered, what was lost, and the recovery rate in basis points — computed exactly from integers, not from a rounded percentage.',
    });

    router.get('/v1/dunning/:id', (req: Req, c: Ctx) => {
      const store = paymentsStore(c);
      return store.dunning.view(req.auth.orgId, store.dunning.require(req.auth.orgId, req.params.id));
    }, {
      summary: 'One recovery campaign, attempt by attempt', tags: ['payments'],
    });

    router.post('/v1/dunning/:id/cancel', (req: Req, c: Ctx) => {
      const body = req.body as { reason?: string };
      return paymentsStore(c).dunning.cancel(req.auth.orgId, req.params.id, body.reason ?? null, writeMeta(req));
    }, {
      summary: 'Stop chasing an invoice', tags: ['payments'], roles: ['member'],
      description: 'Stands the schedule down without touching the bill — for accounts being collected another way.',
      body: v.object({ reason: v.optional(v.string({ max: 500 })) }),
    });

    router.get('/v1/invoices/:id/payments', (req: Req, c: Ctx) => {
      const orgId = req.auth.orgId;
      const store = paymentsStore(c);
      const invoice = billingStore(c).billing.invoices.require(orgId, req.params.id);
      const locale = localeOf(c, orgId);
      const show = (amount: number) => formatMoney(money(amount, invoice.currency), { locale });
      const charges = store.gateway.listCharges(orgId, { invoice: invoice.id, status: 'all', limit: 100 }).data;
      const taken = charges.filter((charge) => charge.status === 'succeeded').reduce((total, charge) => total + charge.amount, 0);
      const refunds = store.gateway.listRefunds(orgId, { invoice: invoice.id, limit: 100 }).data;
      const disputes = store.gateway.listDisputes(orgId, { invoice: invoice.id, status: 'all', limit: 100 }).data;
      const campaign = store.dunning.forInvoice(orgId, invoice.id);
      const overpaid = store.gateway.overpaidOn(orgId, invoice.id);
      const blocked = store.gateway.uncollectableReason(invoice);
      const refunded = refunds.reduce((total, refund) => total + refund.amount, 0);
      const held = disputes
        .filter((dispute) => dispute.status === 'needs_response' || dispute.status === 'under_review' || dispute.status === 'lost')
        .reduce((total, dispute) => total + dispute.amount, 0);
      const returned = refunded + held;
      // Four different stories, and the wrong one is worse than none: a bill
      // settled from account credit has never seen a card, and saying "nothing
      // collected" about a paid invoice is how a support agent charges it twice.
      const headline = taken > 0
        ? overpaid > 0
          ? `${show(taken)} has been taken against ${invoice.number}: ${show(invoice.amount_paid)} settled the bill and ${show(overpaid)} went past it, which is credit on the account and comes off the next invoice.`
          : invoice.amount_due === 0
            ? `${show(taken)} was collected against ${invoice.number} and settled it in full.`
            : `${show(taken)} has been collected against ${invoice.number}, and ${show(invoice.amount_due)} is still owed.`
        : invoice.amount_paid > 0
          ? `No card or debit was ever presented against ${invoice.number}. The ${show(invoice.amount_paid)} on it was settled another way — account credit, a credit note, or recorded by hand.`
          : `Nothing has been collected against ${invoice.number} yet. ${blocked ?? `${show(invoice.amount_due)} is owed and can be presented now.`}`;
      return {
        object: 'invoice_payments',
        invoice: invoice.id,
        number: invoice.number,
        customer: invoice.customer,
        currency: invoice.currency,
        total: invoice.total,
        amount_paid: invoice.amount_paid,
        amount_due: invoice.amount_due,
        /**
         * Collected beyond what this bill was owed and credited to the account
         * balance, where the next invoice draws it down. Stripe's field, and
         * the reason a payment can never outrun its bill unnoticed here.
         */
        amount_overpaid: overpaid,
        amount_refunded: refunded,
        /** Withdrawn by the network and not yet returned — an open case, or one lost. */
        amount_disputed: held,
        cash_collected: taken,
        collectable: blocked === null,
        collectable_note: blocked,
        payment_intents: store.gateway.listIntents(orgId, { invoice: invoice.id, status: 'all', limit: 100 }).data,
        charges,
        refunds,
        disputes,
        dunning: campaign ? store.dunning.view(orgId, campaign) : null,
        summary: returned > 0 ? `${headline} ${show(returned)} of it has since gone back to the customer.` : headline,
      };
    }, {
      summary: 'What happened to the money on one invoice', tags: ['payments'],
      description: 'Every presentation, refund and dispute against one bill, with the recovery campaign chasing it and the two numbers that have to agree: what the customer’s account was actually charged, and what the platform did with it. amount_overpaid is anything collected past what the bill was owed — it is credit on the customer’s balance, never a difference that was dropped.',
    });

    router.post('/v1/invoices/:id/retry', (req: Req, c: Ctx) => {
      const store = paymentsStore(c);
      const orgId = req.auth.orgId;
      const invoice = billingStore(c).billing.invoices.require(orgId, req.params.id);
      const blocked = store.gateway.uncollectableReason(invoice);
      if (blocked) throw conflict('invoice_not_collectable', blocked, { status: invoice.status, amount_due: invoice.amount_due });
      const body = req.body as { payment_method?: string; off_session?: boolean } | undefined;
      const result = store.gateway.collectInvoice(orgId, invoice.id, {
        source: 'manual_retry', methodId: body?.payment_method ?? null,
        offSession: body?.off_session ?? true, meta: writeMeta(req),
      });
      return collectionResponse(c, orgId, result);
    }, {
      summary: 'Retry collection on an invoice now', tags: ['payments'], roles: ['member'], idempotent: true,
      description: 'Presents the bill immediately instead of waiting for the next scheduled window. The attempt is recorded against the recovery campaign like any other, so the audit trail stays one story. Pass off_session=false when the customer is with you: a card the issuer wants authenticated comes back requires_action with the step to approve at, instead of the authentication_required decline no retry schedule can ever satisfy.',
      body: v.object({
        payment_method: v.optional(v.id('pm')),
        off_session: v.optional(v.boolean()),
      }),
    });

    /* -------------------------------- settings ------------------------------ */

    router.get('/v1/payments/settings', (req: Req, c: Ctx) => {
      const policy = paymentsStore(c).dunning.policy(req.auth.orgId);
      return {
        object: 'payment_settings',
        dunning: policy,
        defaults: DEFAULT_POLICY,
        decline_codes: DECLINE_CODES.map((code) => ({
          code,
          severity: DECLINES[code].severity,
          message: DECLINES[code].message,
          advice: DECLINES[code].advice,
          retried: !policy.give_up_codes.includes(code) && DECLINES[code].severity !== 'final',
        })),
        schedule_explained: explainSchedule(policy),
      };
    }, {
      summary: 'Payment and dunning settings', tags: ['payments'],
      description: 'The retry policy in force, the defaults it was derived from, and every decline code with whether this workspace will retry it.',
    });

    router.patch('/v1/payments/settings', (req: Req, c: Ctx) => {
      const body = req.body as { dunning?: Partial<DunningPolicy> };
      const policy = paymentsStore(c).dunning.setPolicy(req.auth.orgId, body.dunning ?? {}, writeMeta(req));
      return { object: 'payment_settings', dunning: policy, schedule_explained: explainSchedule(policy) };
    }, {
      summary: 'Change the retry policy', tags: ['payments'], roles: ['admin'],
      description: 'retry_days are the gaps between attempts, not offsets from the first failure. A campaign already running keeps the policy it started under.',
      body: v.object({ dunning: policyBody }),
    });
  },

  tools() {
    return [
      {
        name: 'payments.recovery_queue',
        description: 'Every subscription in payment recovery: what is at risk, how many attempts are left, what the bank said last time and what to do about it today.',
        readOnly: true,
        tags: ['billing', 'payments'],
        input: v.object({
          status: v.optional(v.enum(['open', 'recovering', 'recovered', 'exhausted', 'canceled', 'all'])),
          customer: v.optional(v.string({ max: 120 })),
          limit: v.optional(v.int({ min: 1, max: 50 })),
        }),
        run: (args: DunningListFilter, c: Ctx, meta) => {
          const locale = localeOf(c, meta.orgId);
          const queue = paymentsStore(c).dunning.queue(meta.orgId, args);
          return {
            object: 'recovery_queue',
            total: queue.totalCount,
            campaigns: queue.data.map((row: DunningView) => ({
              dunning: row.id,
              customer: row.customer_name,
              invoice: row.invoice_number,
              at_risk: formatMoney(money(row.amount_at_risk, row.currency), { locale }),
              attempts: `${row.attempt_count} of ${row.max_attempts}`,
              last_decline: row.last_failure_code,
              next_attempt_at: row.next_attempt_at,
              payment_method: row.payment_method?.display_name ?? 'none on file',
              recommended_action: row.recommended_action,
              needs_human: row.needs_human,
            })),
          };
        },
      },
      {
        name: 'payments.explain_decline',
        description: 'Why a payment was refused and what to do about it, for a charge, a payment intent or an invoice.',
        readOnly: true,
        tags: ['billing', 'payments'],
        input: v.object({
          charge: v.optional(v.string({ max: 120 })),
          invoice: v.optional(v.string({ max: 120 })),
        }),
        run: (args: { charge?: string; invoice?: string }, c: Ctx, meta) => {
          const store = paymentsStore(c);
          const charge = args.charge
            ? store.gateway.charge(meta.orgId, args.charge)
            : store.gateway.listCharges(meta.orgId, { invoice: args.invoice, limit: 1 }).data[0] ?? null;
          if (!charge) return { object: 'decline_explanation', found: false, message: 'No charge has been presented for that yet.' };
          const code = charge.failure_code;
          return {
            object: 'decline_explanation',
            found: true,
            charge: charge.id,
            status: charge.status,
            amount: formatMoney(money(charge.amount, charge.currency), { locale: localeOf(c, meta.orgId) }),
            outcome: charge.outcome,
            decline_code: code,
            severity: code ? DECLINES[code].severity : null,
            what_to_do: code ? DECLINES[code].advice : 'Nothing — this charge went through.',
          };
        },
      },
      {
        name: 'payments.retry_invoice',
        description: 'Present an unpaid invoice to the card on file right now, instead of waiting for the next scheduled retry.',
        readOnly: false,
        requiresApproval: true,
        tags: ['billing', 'payments'],
        input: v.object({ invoice: v.string({ min: 1, max: 120 }) }),
        run: (args: { invoice: string }, c: Ctx, meta) => {
          const store = paymentsStore(c);
          const invoice = billingStore(c).billing.invoices.require(meta.orgId, args.invoice);
          const blocked = store.gateway.uncollectableReason(invoice);
          if (blocked) return { object: 'collection_attempt', collected: false, summary: blocked };
          const result = store.gateway.collectInvoice(meta.orgId, invoice.id, {
            source: 'manual_retry', meta: { actorType: 'agent', actorId: meta.actorId ?? null },
          });
          return collectionResponse(c, meta.orgId, result);
        },
      },
    ];
  },
});

/** The retry policy as a sentence, for the settings screen and the copilot. */
function explainSchedule(policy: DunningPolicy): string {
  const gaps = policy.retry_days.map((d) => `${d} day${d === 1 ? '' : 's'}`).join(', then ');
  const window = `${String(policy.collection_hour).padStart(2, '0')}:00 UTC`;
  const end = policy.end_behavior === 'cancel'
    ? 'the subscription is cancelled'
    : policy.end_behavior === 'mark_unpaid'
      ? 'the subscription is marked unpaid and stops being collected'
      : 'the subscription is left past due for someone to chase by hand';
  const spread = policy.jitter_hours > 0
    ? ` and spread across the ${policy.jitter_hours} hour${policy.jitter_hours === 1 ? '' : 's'} after it so a thousand accounts do not present at once`
    : ' with no spread, so every account presents at the top of the window';
  const givingUp = policy.give_up_codes.length
    ? ` ${policy.give_up_codes.join(', ')} stop the schedule immediately, because none of them clear by waiting — they need a person: new details, corrected ones, or the cardholder confirming once on-session.`
    : ' No decline ends the schedule early.';
  return `The first failure is attempt one. Retries follow after ${gaps}, each presented in the ${window} window${spread}${policy.skip_weekends ? ', never on a weekend' : ''}. A hard decline waits ${policy.hard_decline_multiplier}x longer;${givingUp} After ${policy.max_attempts} attempts ${end}.`;
}
