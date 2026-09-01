/**
 * Intents, charges, refunds, disputes — and the one place where any of this
 * touches a bill.
 *
 * Two boundaries are drawn deliberately here, because getting either of them
 * wrong is how a payments module quietly corrupts a ledger:
 *
 *  1. **Cash never moves without going through `applyCollection` /
 *     `reverseCollection`.** Both keep billing's own identity intact —
 *     `amount_paid + pre-payment credit notes + amount_due === total` — and
 *     both finish by calling billing's `assertBalanced`, so a mistake in this
 *     file takes the transaction down instead of reaching a customer. That
 *     identity is necessary and not sufficient: it can be satisfied by an
 *     invoice that took more than it was owed and dropped the difference, so
 *     the second rule below is what makes it mean something.
 *  1a. **Nothing collected is ever discarded, and nothing returned is paid
 *     twice.** A payment is refused before the card is touched when the bill
 *     has nothing left in it or already has a debit in flight covering it
 *     (`confirmIntent` re-reads the invoice and prices against the live
 *     balance less what is with the bank), and money that was already
 *     committed when the bill moved — a debit settling days later, a dispute
 *     won over a bill since credited — lands on the customer's balance as an
 *     `invoice_overpayment` rather than being truncated away. Reversal is the
 *     same rule run backwards: a refund or a chargeback empties that credit
 *     before it touches `amount_paid`, so the one identity this file exists to
 *     keep — **net cash in === `amount_paid` + overpayment credit**, on every
 *     bill, after any sequence of collect, reverse, refund, dispute and
 *     overpay — survives money going out as well as money coming in.
 *  2. **A subscription's status is never written here.** Failure emits
 *     `invoice.payment_failed` and recovery emits `invoice.paid`, both of which
 *     billing already listens for and turns into a status change through its
 *     own `transition()`. The one place payments needs a status change billing
 *     will not infer — giving up on an account — calls `transition()` directly.
 */
import type { Ctx } from '../../kernel/context';
import { badRequest, conflict, internal, notFound } from '../../../shared/errors';
import { cursorOf, newId, parseCursor } from '../../../shared/ids';
import { formatMoney, money } from '../../../shared/money';
import { DAY } from '../../../shared/time';
import { billingStore } from '../billing/module';
import type { Invoice } from '../billing/types';
import { hydrateCharge, hydrateDispute, hydrateIntent, hydrateRefund, type Page, type WriteMeta } from './records';
import {
  BANK_DEBIT_SETTLEMENT_DAYS, DECLINES, settleBankDebit, simulate,
  type AttemptContext, type SimulationResult,
} from './simulator';
import type { Payments } from './store';
import type {
  Charge, DeclineCode, Dispute, DisputeEvidence, DisputeReason, PaymentCancellationReason, PaymentIntent,
  PaymentIntentSource, PaymentMethod, Refund, RefundReason,
} from './types';

export interface IntentInput {
  customer: string;
  amount?: number;
  currency?: string;
  payment_method?: string;
  invoice?: string;
  description?: string;
  statement_descriptor?: string;
  off_session?: boolean;
  confirm?: boolean;
  idempotency_key?: string;
  source?: PaymentIntentSource;
  metadata?: Record<string, string>;
}

export interface IntentListFilter {
  customer?: string;
  invoice?: string;
  status?: PaymentIntent['status'] | 'all';
  source?: PaymentIntentSource;
  limit?: number;
  cursor?: string | null;
}

export interface ChargeListFilter {
  customer?: string;
  invoice?: string;
  payment_intent?: string;
  status?: Charge['status'] | 'all';
  disputed?: boolean;
  limit?: number;
  cursor?: string | null;
}

export interface RefundInput {
  charge?: string;
  payment_intent?: string;
  invoice?: string;
  amount?: number;
  reason?: RefundReason;
  description?: string;
}

export interface DisputeInput {
  charge?: string;
  invoice?: string;
  reason: DisputeReason;
  amount?: number;
  /** How long the network gives us to answer. 21 days is the usual window. */
  evidence_due_days?: number;
}

/** What one collection attempt did, in a shape dunning and the routes both read. */
export interface CollectionResult {
  invoice: Invoice;
  intent: PaymentIntent | null;
  charge: Charge | null;
  method: PaymentMethod | null;
  collected: boolean;
  /** Set when nothing was attempted at all, and says why in words. */
  skipped: string | null;
  failure: { code: DeclineCode; message: string; advice: string } | null;
}

/** How long we give the network before a silent dispute is treated as lost. */
const DEFAULT_EVIDENCE_DAYS = 21;

/**
 * The parameters a replayed `idempotency_key` has to match.
 *
 * Recorded from the *request*, not recomputed from the intent it produced,
 * because an invoice-bound intent is re-priced between the create and the
 * replay — comparing against the stored `amount` would refuse the very replay
 * idempotency exists to serve. Currency is normalised because `USD` and `usd`
 * are the same request; everything else is an id or a literal amount.
 */
function intentFingerprint(input: IntentInput): string {
  return [
    input.customer,
    input.invoice ?? '',
    input.amount ?? '',
    (input.currency ?? '').toLowerCase(),
    input.payment_method ?? '',
  ].join('|');
}

export class Gateway {
  /**
   * True while dunning is driving a collection itself.
   *
   * The callbacks below tell dunning about a result it did not ask for. It has
   * to be a flag rather than a look at the intent's `source`, because a direct
   * debit answers days after it was presented: by then dunning is not on the
   * stack, and the settlement is exactly the result it has been waiting for.
   */
  private drivenByDunning = false;

  constructor(private readonly ctx: Ctx, private readonly payments: Payments) {}

  private get billing() { return billingStore(this.ctx).billing; }

  /* --------------------------------- reading ------------------------------ */

  intent(orgId: string, id: string): PaymentIntent | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM payments_intents WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydrateIntent(row) : null;
  }

  requireIntent(orgId: string, id: string): PaymentIntent {
    const found = this.intent(orgId, id);
    if (!found) throw notFound('payment intent', id);
    return found;
  }

  listIntents(orgId: string, filter: IntentListFilter = {}): Page<PaymentIntent> {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.invoice) { clauses.push('invoice_id = ?'); params.push(filter.invoice); }
    if (filter.source) { clauses.push('source = ?'); params.push(filter.source); }
    if (filter.status && filter.status !== 'all') { clauses.push('status = ?'); params.push(filter.status); }
    return this.page('payments_intents', clauses, params, filter.limit, filter.cursor, hydrateIntent);
  }

  charge(orgId: string, id: string): Charge | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM payments_charges WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydrateCharge(row) : null;
  }

  requireCharge(orgId: string, id: string): Charge {
    const found = this.charge(orgId, id);
    if (!found) throw notFound('charge', id);
    return found;
  }

  listCharges(orgId: string, filter: ChargeListFilter = {}): Page<Charge> {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.invoice) { clauses.push('invoice_id = ?'); params.push(filter.invoice); }
    if (filter.payment_intent) { clauses.push('payment_intent_id = ?'); params.push(filter.payment_intent); }
    if (filter.status && filter.status !== 'all') { clauses.push('status = ?'); params.push(filter.status); }
    if (filter.disputed !== undefined) { clauses.push('disputed = ?'); params.push(filter.disputed ? 1 : 0); }
    return this.page('payments_charges', clauses, params, filter.limit, filter.cursor, hydrateCharge);
  }

  refund(orgId: string, id: string): Refund | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM payments_refunds WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydrateRefund(row) : null;
  }

  listRefunds(orgId: string, filter: { charge?: string; invoice?: string; customer?: string; limit?: number; cursor?: string | null } = {}): Page<Refund> {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.charge) { clauses.push('charge_id = ?'); params.push(filter.charge); }
    if (filter.invoice) { clauses.push('invoice_id = ?'); params.push(filter.invoice); }
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    return this.page('payments_refunds', clauses, params, filter.limit, filter.cursor, hydrateRefund);
  }

  dispute(orgId: string, id: string): Dispute | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM payments_disputes WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydrateDispute(row) : null;
  }

  requireDispute(orgId: string, id: string): Dispute {
    const found = this.dispute(orgId, id);
    if (!found) throw notFound('dispute', id);
    return found;
  }

  listDisputes(orgId: string, filter: { customer?: string; invoice?: string; status?: Dispute['status'] | 'all'; limit?: number; cursor?: string | null } = {}): Page<Dispute> {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.invoice) { clauses.push('invoice_id = ?'); params.push(filter.invoice); }
    if (filter.status && filter.status !== 'all') { clauses.push('status = ?'); params.push(filter.status); }
    return this.page('payments_disputes', clauses, params, filter.limit, filter.cursor, hydrateDispute);
  }

  private page<T extends { created: number; id: string }>(
    table: string, clauses: string[], params: unknown[], limit: number | undefined,
    cursor: string | null | undefined, hydrate: (row: any) => T,
  ): Page<T> {
    const where = clauses.join(' AND ');
    const totalCount = this.ctx.db.count(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, ...(params as any[]));
    const paged = [...params];
    let cursorClause = '';
    if (cursor) {
      const parsed = parseCursor(cursor);
      if (!parsed) throw badRequest('cursor_invalid', 'That pagination cursor is not readable. Start the list again.', 'cursor');
      cursorClause = ' AND (created < ? OR (created = ? AND id < ?))';
      paged.push(parsed.createdAt, parsed.createdAt, parsed.id);
    }
    const size = Math.min(Math.max(limit ?? 25, 1), 200);
    const rows = this.ctx.db.all<any>(
      `SELECT * FROM ${table} WHERE ${where}${cursorClause} ORDER BY created DESC, id DESC LIMIT ?`,
      ...(paged as any[]), size + 1,
    );
    const hasMore = rows.length > size;
    const data = rows.slice(0, size).map(hydrate);
    const last = data[data.length - 1];
    return { data, hasMore, nextCursor: hasMore && last ? cursorOf(last.created, last.id) : null, totalCount };
  }

  /* ------------------------------ payment intents ------------------------- */

  createIntent(orgId: string, input: IntentInput, meta: WriteMeta = {}): PaymentIntent {
    return this.ctx.atomic(() => {
      const fingerprint = intentFingerprint(input);
      if (input.idempotency_key) {
        const replay = this.ctx.db.get<any>(
          `SELECT * FROM payments_intents WHERE org_id = ? AND idempotency_key = ?`, orgId, input.idempotency_key,
        );
        // The processor's own idempotency, under the platform's: a replayed
        // collection returns the intent it already made rather than a charge
        // the customer would see twice on their statement.
        //
        // Which is only true while the replay is the *same* request. A key is a
        // caller's own string, and two callers — or one caller whose counter
        // reset — can present the same one for different money. Handing back
        // the first intent then answers 201 with someone else's customer,
        // someone else's charge id and a `succeeded` status, while this
        // customer is charged nothing at all: a payment reported and never
        // made. The recorded request has to match before the replay is a
        // replay. A row written before fingerprints existed has none, and
        // keeps the old behaviour rather than being refused retroactively.
        if (replay) {
          const first = String(replay.idempotency_fingerprint ?? '');
          if (first && first !== fingerprint) {
            throw conflict(
              'idempotency_key_in_use',
              `Idempotency key "${input.idempotency_key}" was already used for a different payment (${replay.id}), so it cannot be reused for this one. A key only replays the request it was first sent with — send that request again, or use a new key.`,
              { payment_intent: replay.id, first_request: first, this_request: fingerprint },
            );
          }
          return hydrateIntent(replay);
        }
      }
      const customer = this.ctx.svc.billing.requireCustomer(orgId, input.customer);
      const invoice = input.invoice ? this.billing.invoices.require(orgId, input.invoice) : null;
      if (invoice && invoice.customer !== customer.id) {
        throw badRequest('invoice_customer_mismatch', `Invoice ${invoice.number} belongs to another customer.`, 'invoice');
      }
      const amount = input.amount ?? invoice?.amount_due ?? 0;
      if (amount <= 0) {
        throw badRequest('amount_invalid', 'A payment intent has to be for a positive amount. There is nothing here to collect.', 'amount');
      }
      const currency = (input.currency ?? invoice?.currency ?? customer.currency).toLowerCase();
      if (invoice && currency !== invoice.currency) {
        throw badRequest('currency_mismatch', `Invoice ${invoice.number} is in ${invoice.currency.toUpperCase()}, so it cannot be paid in ${currency.toUpperCase()}.`, 'currency');
      }
      const method = input.payment_method ? this.payments.methods.require(orgId, input.payment_method) : null;
      if (method && method.customer !== customer.id) {
        throw badRequest('payment_method_customer_mismatch', `${method.display_name} is not attached to ${customer.name}.`, 'payment_method');
      }

      const now = this.ctx.now();
      const id = newId('payment');
      this.ctx.db.insert('payments_intents', {
        id, org_id: orgId, customer_id: customer.id,
        payment_method_id: method?.id ?? null,
        invoice_id: invoice?.id ?? null,
        subscription_id: invoice?.subscription ?? null,
        amount, currency,
        status: method ? 'requires_confirmation' : 'requires_payment_method',
        description: input.description ?? (invoice ? `Invoice ${invoice.number}` : null),
        statement_descriptor: input.statement_descriptor ?? null,
        off_session: input.off_session ? 1 : 0,
        attempt_count: 0, next_action: null,
        last_error_code: null, last_error_message: null, last_error_advice: null,
        latest_charge_id: null, succeeded_at: null, canceled_at: null, cancellation_reason: null,
        idempotency_key: input.idempotency_key ?? null,
        idempotency_fingerprint: input.idempotency_key ? fingerprint : null,
        source: input.source ?? 'api',
        metadata: input.metadata ?? {},
        created: now, updated: now,
        livemode: meta.livemode === false ? 0 : 1,
      } as any);

      const created = this.requireIntent(orgId, id);
      this.ctx.emit(orgId, 'payment_intent.created', created, {
        objectId: id, objectType: 'payment_intent',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      if (input.confirm) return this.confirmIntent(orgId, id, { off_session: input.off_session }, meta);
      return created;
    });
  }

  confirmIntent(
    orgId: string, id: string,
    opts: { payment_method?: string; off_session?: boolean } = {}, meta: WriteMeta = {},
  ): PaymentIntent {
    return this.ctx.atomic(() => {
      const intent = this.requireIntent(orgId, id);
      if (intent.status === 'succeeded') return intent;
      if (intent.status === 'canceled') {
        throw conflict('payment_intent_canceled', `Payment intent ${id} was cancelled, so it cannot be confirmed. Create a new one.`);
      }
      if (intent.status === 'processing') {
        throw conflict('payment_intent_processing', `Payment intent ${id} is with the bank and will settle in a few days. Confirming it again would present the debit twice.`);
      }
      // The bill is re-read here, not trusted from when the intent was made.
      // Everything below this line moves money.
      if (intent.invoice) this.priceAgainstInvoice(orgId, intent, meta);
      const methodId = opts.payment_method ?? intent.payment_method;
      if (!methodId) {
        throw badRequest('payment_method_required', 'This payment intent has no payment method. Attach one before confirming.', 'payment_method');
      }
      const method = this.payments.methods.require(orgId, methodId);
      if (method.status !== 'attached' || method.customer !== intent.customer) {
        throw conflict('payment_method_unusable', `${method.display_name} is not attached to this customer, so it cannot be charged.`);
      }
      const now = this.ctx.now();
      if (opts.off_session !== undefined || opts.payment_method) {
        this.ctx.db.patch('payments_intents', 'id', id, {
          payment_method_id: method.id,
          off_session: (opts.off_session ?? intent.off_session) ? 1 : 0,
          updated: now,
        });
      }
      return this.runAttempt(orgId, this.requireIntent(orgId, id), method, { authenticated: false, meta });
    });
  }

  /**
   * Why charging this bill would take money nobody is owed, or null.
   *
   * Narrower than `uncollectableReason` on purpose, and the difference is
   * `send_invoice`: net terms stop the *automatic* charge, they do not stop a
   * customer paying their own bill by card. A hand-confirmed intent is exactly
   * that, so the only things refused here are the states in which the bill has
   * no money left in it.
   */
  private settledReason(orgId: string, invoice: Invoice): { code: string; message: string } | null {
    if (invoice.status === 'draft') {
      return { code: 'invoice_not_finalized', message: `Invoice ${invoice.number} has not been finalised, so nothing is owed on it yet.` };
    }
    if (invoice.status === 'void') {
      return { code: 'invoice_void', message: `Invoice ${invoice.number} was voided. Charging it would take money against a bill that no longer exists.` };
    }
    if (invoice.status === 'uncollectible') {
      return { code: 'invoice_uncollectible', message: `Invoice ${invoice.number} has been written off. Reopen it before collecting against it.` };
    }
    if (invoice.status === 'paid' || invoice.amount_due <= 0) {
      return {
        code: 'invoice_already_paid',
        message: `Invoice ${invoice.number} has nothing left to collect — it was settled before this intent was confirmed. Refund the charge that settled it if this payment was meant to replace it.`,
      };
    }
    const presented = this.alreadyPresentedReason(orgId, invoice);
    if (presented) {
      return {
        code: 'invoice_payment_in_flight',
        message: `${presented} Wait for the bank's answer, then refund the debit if this payment was meant to replace it — a debit that has been presented cannot be recalled.`,
      };
    }
    return null;
  }

  /**
   * Re-price an invoice-bound intent against the bill as it stands right now.
   *
   * An intent is a quote for a balance that was true when it was made. Between
   * the quote and the charge a credit note can land, a colleague can take the
   * money over the phone, or the very same intent can be confirmed a second
   * time — and every one of those ends with a card charged for money nobody is
   * owed. So the live `amount_due` decides, not the frozen `amount`: if there
   * is nothing left to collect the confirm is refused before the charge, and
   * if the bill has shrunk the intent shrinks with it. It is never re-priced
   * upwards; a part payment stays the part payment that was authorised.
   */
  private priceAgainstInvoice(orgId: string, intent: PaymentIntent, meta: WriteMeta): void {
    const invoice = this.billing.invoices.require(orgId, intent.invoice as string);
    const settled = this.settledReason(orgId, invoice);
    if (settled) {
      throw conflict(settled.code, settled.message, {
        invoice: invoice.id, status: invoice.status,
        amount_due: invoice.amount_due, amount_paid: invoice.amount_paid,
        amount_in_flight: this.inFlightOn(orgId, invoice.id).amount,
      });
    }
    const available = this.collectableNow(orgId, invoice);
    if (available >= intent.amount) return;
    const now = this.ctx.now();
    const locale = this.locale(orgId);
    this.ctx.db.patch('payments_intents', 'id', intent.id, { amount: available, updated: now });
    const after = this.requireIntent(orgId, intent.id);
    this.ctx.emit(orgId, 'payment_intent.amount_updated', {
      payment_intent: after.id, invoice: invoice.id, number: invoice.number, customer: invoice.customer,
      amount: after.amount, previous_amount: intent.amount, currency: after.currency,
      reason: `Invoice ${invoice.number} owed ${formatMoney(money(intent.amount, intent.currency), { locale })} when this intent was created and has ${formatMoney(money(available, invoice.currency), { locale })} left to present now. The charge follows the bill down rather than collecting the difference.`,
    }, {
      objectId: after.id, objectType: 'payment_intent', previous: { amount: intent.amount },
      actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
    });
  }

  /**
   * Stand in for the issuer's authentication page.
   *
   * Real 3-D Secure redirects the cardholder to their bank and comes back with
   * a yes or a no. This does the same thing over one route, which is the only
   * honest way to model it without a bank: the state machine is real, the page
   * is not, and the module says so in the `next_action`.
   */
  authenticate(orgId: string, id: string, approve: boolean, meta: WriteMeta = {}): PaymentIntent {
    return this.ctx.atomic(() => {
      const intent = this.requireIntent(orgId, id);
      if (intent.status !== 'requires_action') {
        throw conflict(
          'payment_intent_not_awaiting_action',
          `Payment intent ${id} is ${intent.status}, so there is nothing to authenticate.`,
          { status: intent.status },
        );
      }
      const method = this.payments.methods.require(orgId, intent.payment_method as string);
      if (!approve) {
        const profile = DECLINES.authentication_required;
        const attempt = this.attemptContext(orgId, intent, method, false, true);
        return this.recordFailure(orgId, intent, method, {
          result: 'declined', code: profile.code, profile,
          outcome: {
            type: profile.outcome_type, network_status: profile.network_status, reason: profile.code,
            risk_level: 'normal', risk_score: attempt.amount % 100,
            seller_message: 'The cardholder did not complete the authentication their bank asked for.',
            explanation: 'The bank asked the cardholder to confirm the payment and they did not. Nothing was charged.',
          },
        }, meta);
      }
      // An intent can sit at `requires_action` for as long as it takes the
      // cardholder to answer, and bills get settled in the meantime. The same
      // re-read that guards the confirm guards the approval.
      if (intent.invoice) this.priceAgainstInvoice(orgId, intent, meta);
      return this.runAttempt(orgId, this.requireIntent(orgId, id), method, { authenticated: true, meta });
    });
  }

  cancelIntent(orgId: string, id: string, reason: PaymentCancellationReason, meta: WriteMeta = {}): PaymentIntent {
    return this.ctx.atomic(() => {
      const intent = this.requireIntent(orgId, id);
      if (intent.status === 'canceled') return intent;
      if (intent.status === 'succeeded') {
        throw conflict('payment_intent_succeeded', `Payment intent ${id} has already been paid. Refund the charge instead.`, { charge: intent.latest_charge });
      }
      // The same rule that refuses a second confirm, from the other side: once
      // the instruction is with the bank it cannot be taken back by writing a
      // column here. Cancelling anyway would leave the charge pending for ever
      // — the settlement job only answers a `processing` intent — and a charge
      // that never settles is money `inFlightOn` counts against the bill for
      // ever, so the invoice could never be presented again and the campaign
      // chasing it would wait on an answer that was never coming.
      if (intent.status === 'processing') {
        const charge = intent.latest_charge ? this.charge(orgId, intent.latest_charge) : null;
        const settlesAt = charge ? charge.created + BANK_DEBIT_SETTLEMENT_DAYS * DAY : null;
        throw conflict(
          'payment_intent_processing',
          `Payment intent ${id} is with the bank and cannot be recalled${settlesAt ? ` — it is answered by ${new Date(settlesAt).toISOString().slice(0, 10)}` : ''}. Wait for the answer: a return unpaid reopens the bill on its own, and money that does arrive can be refunded.`,
          { status: intent.status, charge: intent.latest_charge, settles_at: settlesAt },
        );
      }
      const now = this.ctx.now();
      this.ctx.db.patch('payments_intents', 'id', id, {
        status: 'canceled', canceled_at: now, cancellation_reason: reason, next_action: null, updated: now,
      });
      const after = this.requireIntent(orgId, id);
      this.ctx.emit(orgId, 'payment_intent.canceled', after, {
        objectId: id, objectType: 'payment_intent', previous: { status: intent.status },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return after;
    });
  }

  /* ------------------------------ the attempt ----------------------------- */

  private attemptContext(
    orgId: string, intent: PaymentIntent, method: PaymentMethod, offSession: boolean, authenticated: boolean,
  ): AttemptContext {
    const { behavior, declineCount } = this.payments.methods.effectiveBehavior(method, this.ctx.now());
    // Counted from the last time the method was written, not from the
    // beginning of time: "decline the next two attempts" has to mean the next
    // two even on a card that has been paying happily for a year, or the
    // behaviour could never be set on an account with any history.
    const priorCharges = this.ctx.db.count(
      `SELECT COUNT(*) FROM payments_charges WHERE org_id = ? AND payment_method_id = ? AND created >= ?`,
      orgId, method.id, method.updated,
    );
    return {
      intentId: intent.id, methodId: method.id, methodType: method.type,
      behavior, declineCount, priorCharges, offSession, authenticated,
      amount: intent.amount, currency: intent.currency,
    };
  }

  private runAttempt(
    orgId: string, intent: PaymentIntent, method: PaymentMethod,
    opts: { authenticated: boolean; meta: WriteMeta },
  ): PaymentIntent {
    const now = this.ctx.now();
    const attempt = this.attemptContext(orgId, intent, method, intent.off_session, opts.authenticated);
    this.ctx.db.patch('payments_intents', 'id', intent.id, {
      attempt_count: intent.attempt_count + 1, updated: now,
    });
    const current = this.requireIntent(orgId, intent.id);
    const decision = simulate(attempt);

    if (decision.result === 'requires_action') {
      this.ctx.db.patch('payments_intents', 'id', intent.id, {
        status: 'requires_action',
        next_action: {
          type: 'authenticate',
          authenticate_url: `/v1/payment_intents/${intent.id}/authenticate`,
          description: decision.description,
        },
        // Whatever this method was refused for last time is superseded: the
        // bank is asking for the cardholder now, not reporting a decline.
        last_error_code: null, last_error_message: null, last_error_advice: null,
        updated: now,
      } as any);
      const after = this.requireIntent(orgId, intent.id);
      this.ctx.emit(orgId, 'payment_intent.requires_action', after, {
        objectId: after.id, objectType: 'payment_intent', previous: { status: current.status },
        actorId: opts.meta.actorId, actorType: opts.meta.actorType, requestId: opts.meta.requestId,
      });
      return after;
    }

    if (decision.result === 'processing') {
      const charge = this.writeCharge(orgId, current, method, {
        status: 'pending', amount: current.amount, outcome: decision.outcome,
        failure: null, authorizationCode: null, createdAt: now,
      });
      this.ctx.db.patch('payments_intents', 'id', intent.id, {
        status: 'processing', latest_charge_id: charge.id, next_action: null,
        last_error_code: null, last_error_message: null, last_error_advice: null, updated: now,
      });
      // The bank answers on its own schedule, so the answer is a job with a
      // `run_at` — which is what lets the time machine watch a debit come back
      // unpaid four days later exactly as it would in production.
      this.ctx.enqueue(orgId, 'payments.settle_debit', { intent: intent.id, charge: charge.id }, {
        runAt: now + BANK_DEBIT_SETTLEMENT_DAYS * DAY,
        idemKey: `payments.settle_debit:${charge.id}`,
      });
      const after = this.requireIntent(orgId, intent.id);
      this.ctx.emit(orgId, 'payment_intent.processing', after, {
        objectId: after.id, objectType: 'payment_intent', previous: { status: current.status },
        actorId: opts.meta.actorId, actorType: opts.meta.actorType, requestId: opts.meta.requestId,
      });
      return after;
    }

    if (decision.result === 'succeeded') {
      return this.recordSuccess(orgId, current, method, decision, opts.meta);
    }
    return this.recordFailure(orgId, current, method, decision, opts.meta);
  }

  /** The bank's answer to a direct debit, days after it was presented. */
  settleDebit(orgId: string, intentId: string, chargeId: string): void {
    this.ctx.atomic(() => {
      const intent = this.intent(orgId, intentId);
      const charge = this.charge(orgId, chargeId);
      if (!intent || !charge || intent.status !== 'processing' || charge.status !== 'pending') return;
      const method = intent.payment_method ? this.payments.methods.method(orgId, intent.payment_method) : null;
      if (!method) return;
      // The charge being settled is already on the table, so it is in the
      // count. The decision is about the presentations *before* this one.
      const context = this.attemptContext(orgId, intent, method, intent.off_session, true);
      const decision = settleBankDebit({ ...context, priorCharges: Math.max(0, context.priorCharges - 1) });
      const now = this.ctx.now();
      if (decision.result === 'succeeded') {
        this.ctx.db.patch('payments_charges', 'id', charge.id, {
          status: 'succeeded', paid: 1, captured: 1,
          authorization_code: decision.authorizationCode,
          outcome_type: decision.outcome.type, outcome_network_status: decision.outcome.network_status,
          outcome_reason: null, outcome_seller_message: decision.outcome.seller_message,
          outcome_explanation: decision.outcome.explanation,
        });
        this.finishSuccess(orgId, intent, this.requireCharge(orgId, charge.id), { actorType: 'system' }, now);
        return;
      }
      this.ctx.db.patch('payments_charges', 'id', charge.id, {
        status: 'failed', paid: 0, captured: 0,
        failure_code: decision.code, failure_message: decision.profile.message,
        outcome_type: decision.outcome.type, outcome_network_status: decision.outcome.network_status,
        outcome_reason: decision.code, outcome_seller_message: decision.outcome.seller_message,
        outcome_explanation: decision.outcome.explanation,
      });
      this.finishFailure(orgId, intent, this.requireCharge(orgId, charge.id), decision.code, decision.profile.message, decision.profile.advice, { actorType: 'system' }, now);
    });
  }

  private recordSuccess(
    orgId: string, intent: PaymentIntent, method: PaymentMethod,
    decision: Extract<SimulationResult, { result: 'succeeded' }>, meta: WriteMeta,
  ): PaymentIntent {
    const now = this.ctx.now();
    const charge = this.writeCharge(orgId, intent, method, {
      status: 'succeeded', amount: intent.amount, outcome: decision.outcome,
      failure: null, authorizationCode: decision.authorizationCode, createdAt: now,
    });
    this.finishSuccess(orgId, intent, charge, meta, now);
    return this.requireIntent(orgId, intent.id);
  }

  private finishSuccess(orgId: string, intent: PaymentIntent, charge: Charge, meta: WriteMeta, now: number): void {
    this.ctx.db.patch('payments_intents', 'id', intent.id, {
      status: 'succeeded', succeeded_at: now, latest_charge_id: charge.id, next_action: null,
      last_error_code: null, last_error_message: null, last_error_advice: null, updated: now,
    });
    const after = this.requireIntent(orgId, intent.id);
    this.ctx.emit(orgId, 'charge.succeeded', charge, {
      objectId: charge.id, objectType: 'charge',
      actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
    });
    this.ctx.emit(orgId, 'payment_intent.succeeded', after, {
      objectId: after.id, objectType: 'payment_intent', previous: { status: intent.status },
      actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
    });
    if (after.invoice) {
      const invoice = this.applyCollection(orgId, after.invoice, charge.amount, {
        note: `Collected by ${charge.id} on ${new Date(now).toISOString().slice(0, 10)}.`,
        at: now, charge: charge.id, meta,
      });
      this.ctx.emit(orgId, 'invoice.payment_succeeded', {
        invoice: invoice.id, number: invoice.number, customer: invoice.customer,
        subscription: invoice.subscription, amount: charge.amount, currency: invoice.currency,
        charge: charge.id, payment_intent: after.id, payment_method: after.payment_method,
        amount_paid: invoice.amount_paid, amount_due: invoice.amount_due,
        amount_overpaid: this.overpaidOn(orgId, invoice.id),
      }, {
        objectId: invoice.id, objectType: 'invoice',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      if (!this.drivenByDunning) this.payments.dunning.onCollectionSucceeded(orgId, invoice, after, charge);
    }
  }

  private recordFailure(
    orgId: string, intent: PaymentIntent, method: PaymentMethod,
    decision: Extract<SimulationResult, { result: 'declined' }>, meta: WriteMeta,
  ): PaymentIntent {
    const now = this.ctx.now();
    const charge = this.writeCharge(orgId, intent, method, {
      status: 'failed', amount: intent.amount, outcome: decision.outcome,
      failure: { code: decision.code, message: decision.profile.message }, authorizationCode: null, createdAt: now,
    });
    this.finishFailure(orgId, intent, charge, decision.code, decision.profile.message, decision.profile.advice, meta, now);
    return this.requireIntent(orgId, intent.id);
  }

  private finishFailure(
    orgId: string, intent: PaymentIntent, charge: Charge,
    code: DeclineCode, message: string, advice: string, meta: WriteMeta, now: number,
  ): void {
    // Stripe's machine has no `failed` state and neither does this one: a
    // declined intent is back where it started, needing a payment method that
    // works. Saying "failed" would hide that it is still collectable.
    this.ctx.db.patch('payments_intents', 'id', intent.id, {
      status: 'requires_payment_method', latest_charge_id: charge.id, next_action: null,
      last_error_code: code, last_error_message: message, last_error_advice: advice, updated: now,
    });
    const after = this.requireIntent(orgId, intent.id);
    this.ctx.emit(orgId, 'charge.failed', charge, {
      objectId: charge.id, objectType: 'charge',
      actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
    });
    this.ctx.emit(orgId, 'payment_intent.failed', after, {
      objectId: after.id, objectType: 'payment_intent', previous: { status: intent.status },
      actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
    });
    if (!after.invoice) return;

    const invoice = this.billing.invoices.require(orgId, after.invoice);
    // A decline is a fact about the card. It is only a fact about the *bill*
    // while the bill is still owed — and the answer to a presentation arrives
    // long after the presentation on every path that matters: a direct debit is
    // returned unpaid three days later, a cardholder closes the authentication
    // page after a colleague has taken the money over the phone, a credit note
    // cancels the whole invoice while the instruction is with the bank.
    // `confirmIntent` re-reads the invoice before it charges for exactly this
    // reason; nothing re-read it when the answer came back no. Reporting a
    // failure against a settled bill puts `invoice.payment_failed` on it, which
    // billing turns into a past-due — and then an unpaid — subscription, and
    // opens a recovery campaign whose amount at risk is zero: service withdrawn
    // over an invoice that owes nothing.
    if (this.nothingLeftToCollect(invoice)) {
      // And the campaign, if one is running, is chasing a bill that no longer
      // owes anything. Standing it down is the same call the invoice's own
      // settlement would have made; leaving it is how a schedule ends up with a
      // window it has already spent and no job to run the next one.
      if (!this.drivenByDunning) {
        this.payments.dunning.stopFor(
          orgId, invoice.id,
          `${invoice.number} was settled before ${charge.id} was answered, so the ${code} it came back with is not a bill to chase.`,
        );
      }
      return;
    }
    // Billing listens for this and moves the subscription to `past_due` through
    // its own transition function. Payments never writes that column.
    this.ctx.emit(orgId, 'invoice.payment_failed', {
      invoice: invoice.id, number: invoice.number, customer: invoice.customer,
      subscription: invoice.subscription, amount_due: invoice.amount_due, currency: invoice.currency,
      charge: charge.id, payment_intent: after.id, payment_method: after.payment_method,
      failure_code: code, failure_message: message, advice,
    }, {
      objectId: invoice.id, objectType: 'invoice',
      actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
    });
    // Stripe's own distinction, and it is the right one: this is not a card
    // that failed, it is a card the bank will not take without the cardholder.
    // No retry schedule can produce a cardholder, so the event says who has to.
    if (code === 'authentication_required' && after.off_session) {
      this.ctx.emit(orgId, 'invoice.payment_action_required', {
        invoice: invoice.id, number: invoice.number, customer: invoice.customer,
        subscription: invoice.subscription, amount_due: invoice.amount_due, currency: invoice.currency,
        charge: charge.id, payment_intent: after.id, payment_method: after.payment_method,
        reason: code,
        resolution: `Nobody was at the keyboard, so the issuer had no one to ask. Present ${invoice.number} again with ${this.customerName(orgId, invoice.customer)} there — POST /v1/invoices/${invoice.id}/retry with {"off_session": false} — and the intent comes back requires_action with the step to confirm at. The bank remembers the mandate afterwards, so the next off-session charge goes through.`,
      }, {
        objectId: invoice.id, objectType: 'invoice',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
    }
    if (!this.drivenByDunning) {
      this.payments.dunning.onCollectionFailed(orgId, invoice, after, charge, { code, message, advice });
    }
  }

  private writeCharge(
    orgId: string, intent: PaymentIntent, method: PaymentMethod,
    input: {
      status: Charge['status']; amount: number; outcome: Charge['outcome'];
      failure: { code: DeclineCode; message: string } | null;
      authorizationCode: string | null; createdAt: number;
    },
  ): Charge {
    const id = newId('charge');
    this.ctx.db.insert('payments_charges', {
      id, org_id: orgId, payment_intent_id: intent.id, customer_id: intent.customer,
      payment_method_id: method.id, invoice_id: intent.invoice, subscription_id: intent.subscription,
      amount: input.amount, amount_refunded: 0, amount_disputed: 0, currency: intent.currency,
      status: input.status,
      paid: input.status === 'succeeded' ? 1 : 0,
      captured: input.status === 'succeeded' ? 1 : 0,
      refunded: 0, disputed: 0,
      failure_code: input.failure?.code ?? null, failure_message: input.failure?.message ?? null,
      authorization_code: input.authorizationCode,
      outcome_type: input.outcome.type, outcome_network_status: input.outcome.network_status,
      outcome_reason: input.outcome.reason, outcome_risk_level: input.outcome.risk_level,
      outcome_risk_score: input.outcome.risk_score, outcome_seller_message: input.outcome.seller_message,
      outcome_explanation: input.outcome.explanation,
      created: input.createdAt, livemode: intent.livemode ? 1 : 0,
    } as any);
    return this.requireCharge(orgId, id);
  }

  /* ------------------------------- collection ----------------------------- */

  /**
   * Is there any money left in this bill at all?
   *
   * The question `settledReason` answers in words, without the parts of it that
   * are about *this* presentation — a debit in flight is money on its way, not
   * a bill that has been settled, and net terms are a reason not to charge a
   * card rather than a reason nothing is owed. What is left is the states in
   * which the invoice itself holds nothing: struck out, written off, paid, or
   * credited down to zero.
   */
  private nothingLeftToCollect(invoice: Invoice): boolean {
    return invoice.status === 'paid' || invoice.status === 'void'
      || invoice.status === 'uncollectible' || invoice.amount_due <= 0;
  }

  /** Why this bill cannot be charged right now, or null if it can. */
  uncollectableReason(invoice: Invoice): string | null {
    if (invoice.status === 'draft') return `Invoice ${invoice.number} has not been finalised yet, so nothing is owed on it.`;
    if (invoice.status === 'paid') return `Invoice ${invoice.number} is already paid in full.`;
    if (invoice.status === 'void') return `Invoice ${invoice.number} was voided, so there is nothing to collect.`;
    if (invoice.status === 'uncollectible') return `Invoice ${invoice.number} has been written off. Reopen it before collecting.`;
    if (invoice.amount_due <= 0) return `Invoice ${invoice.number} has nothing left to collect.`;
    if (invoice.collection_method === 'send_invoice') {
      return `Invoice ${invoice.number} is on ${invoice.due_date ? 'net terms' : 'invoice terms'} — it is paid by bank transfer, not by card on file.`;
    }
    return null;
  }

  /**
   * Cash already presented against this bill that the bank has not answered.
   *
   * `amount_due` is what a bill is owed. It is not what may be presented
   * against it: a direct debit sits with the bank for days and the invoice
   * stays open the whole time, so anything that prices a second presentation
   * off `amount_due` presents money that is already on its way. Three "retry
   * now" clicks in one afternoon become three debits against one bill, and the
   * overpayment ledger dutifully records the two the customer never owed.
   * `settlesAt` is when the last of them is answered — the first honest moment
   * to try again, and a decline reopens the bill on its own before then.
   */
  inFlightOn(orgId: string, invoiceId: string): { amount: number; settlesAt: number | null } {
    const row = this.ctx.db.get<{ amount: number | null; latest: number | null }>(
      `SELECT COALESCE(SUM(amount), 0) AS amount, MAX(created) AS latest FROM payments_charges
        WHERE org_id = ? AND invoice_id = ? AND status = 'pending'`,
      orgId, invoiceId,
    );
    const amount = Number(row?.amount ?? 0);
    if (amount <= 0 || !row?.latest) return { amount: Math.max(0, amount), settlesAt: null };
    return { amount, settlesAt: Number(row.latest) + BANK_DEBIT_SETTLEMENT_DAYS * DAY };
  }

  /** What may be presented against this bill right now — the balance, less what is in flight. */
  private collectableNow(orgId: string, invoice: Invoice): number {
    return Math.max(0, invoice.amount_due - this.inFlightOn(orgId, invoice.id).amount);
  }

  /** Why presenting this bill again right now would take the same money twice, or null. */
  private alreadyPresentedReason(orgId: string, invoice: Invoice): string | null {
    const inFlight = this.inFlightOn(orgId, invoice.id);
    if (inFlight.amount <= 0 || inFlight.amount < invoice.amount_due) return null;
    const locale = this.locale(orgId);
    const show = (amount: number) => formatMoney(money(amount, invoice.currency), { locale });
    const settles = inFlight.settlesAt ? new Date(inFlight.settlesAt).toISOString().slice(0, 10) : 'in a few working days';
    return `${show(inFlight.amount)} is already with the bank against ${invoice.number} and covers the ${show(invoice.amount_due)} still owed. Presenting it again would take the money twice — the debit is answered by ${settles}, and a return unpaid reopens the bill on its own.`;
  }

  /**
   * Why this bill cannot be charged at this moment: its own state, or cash
   * already committed against it. `uncollectableReason` answers the first
   * question alone, and dunning wants only that one — a debit in flight is a
   * reason to wait for the bank, never a reason to stop chasing the bill.
   */
  notCollectableNow(orgId: string, invoice: Invoice): string | null {
    return this.uncollectableReason(invoice) ?? this.alreadyPresentedReason(orgId, invoice);
  }

  /**
   * Charge a bill with the best method on file.
   *
   * This is the single entry point for money coming in: the automatic charge
   * when an invoice is finalised, the dunning retry days later, and the human
   * clicking "retry now" all arrive here, differing only in `source`.
   */
  collectInvoice(
    orgId: string, invoiceId: string,
    opts: { source: PaymentIntentSource; methodId?: string | null; offSession?: boolean; meta?: WriteMeta } ,
  ): CollectionResult {
    return this.ctx.atomic(() => {
      const invoice = this.billing.invoices.require(orgId, invoiceId);
      const meta = opts.meta ?? { actorType: 'system' as const };
      const blocked = this.notCollectableNow(orgId, invoice);
      if (blocked) return { invoice, intent: null, charge: null, method: null, collected: false, skipped: blocked, failure: null };
      const collectable = this.collectableNow(orgId, invoice);

      const customer = this.ctx.svc.billing.requireCustomer(orgId, invoice.customer);
      const subscription = invoice.subscription ? this.ctx.svc.billing.subscription(orgId, invoice.subscription) : null;
      const method = this.payments.methods.resolve(orgId, customer.id, [
        opts.methodId, subscription?.default_payment_method, customer.invoice_settings.default_payment_method,
      ]);
      if (!method) {
        return {
          invoice, intent: null, charge: null, method: null, collected: false,
          skipped: `${customer.name} has no payment method on file, so ${formatMoney(money(collectable, invoice.currency), { locale: this.locale(orgId) })} cannot be charged. Ask them for one.`,
          failure: null,
        };
      }

      const sequence = this.ctx.db.count(
        `SELECT COUNT(*) FROM payments_intents WHERE org_id = ? AND invoice_id = ?`, orgId, invoice.id,
      );
      // Off-session is the default because almost every collection here is one:
      // a renewal, a scheduled retry, a job. Passing false is the one thing
      // that can satisfy an `authentication_required` decline — the customer is
      // present, so the issuer has someone to ask.
      const offSession = opts.offSession ?? true;
      const intent = this.createIntent(orgId, {
        customer: customer.id,
        amount: collectable,
        currency: invoice.currency,
        payment_method: method.id,
        invoice: invoice.id,
        description: `Invoice ${invoice.number} — ${customer.name}`,
        off_session: offSession,
        source: opts.source,
        idempotency_key: `collect:${invoice.id}:${sequence}`,
      }, meta);
      const confirmed = intent.status === 'requires_confirmation'
        ? this.confirmIntent(orgId, intent.id, { off_session: offSession }, meta)
        : intent;
      const charge = confirmed.latest_charge ? this.charge(orgId, confirmed.latest_charge) : null;
      return {
        invoice: this.billing.invoices.require(orgId, invoice.id),
        intent: confirmed,
        charge,
        method,
        collected: confirmed.status === 'succeeded',
        skipped: null,
        failure: confirmed.last_payment_error
          ? { code: confirmed.last_payment_error.code, message: confirmed.last_payment_error.message, advice: confirmed.last_payment_error.advice }
          : null,
      };
    });
  }

  /**
   * The same collection, run by the retry schedule.
   *
   * Dunning records this attempt itself — with the attempt number, the window
   * it was scheduled for and what it decided to do next — so the callbacks are
   * held off for the duration of the call and no attempt is written twice.
   */
  collectForDunning(orgId: string, invoiceId: string): CollectionResult {
    this.drivenByDunning = true;
    try {
      return this.collectInvoice(orgId, invoiceId, { source: 'dunning_retry', meta: { actorType: 'system' } });
    } finally {
      this.drivenByDunning = false;
    }
  }

  /* ---------------------------- the cash on a bill ------------------------ */

  /**
   * Put money onto a bill.
   *
   * When the payment covers everything still owed this hands over to billing's
   * own `pay()`, so the invoice is settled by the module that owns it and the
   * `invoice.paid` event comes from where every other subscriber expects it.
   * A part payment — a won dispute over half a charge, say — is written here,
   * because billing has no notion of a bill that is partly collected and this
   * is the honest way to record one without inventing a status for it.
   */
  applyCollection(
    orgId: string, invoiceId: string, amount: number,
    opts: { note: string; at?: number; charge?: string | null; meta?: WriteMeta },
  ): Invoice {
    const invoice = this.billing.invoices.require(orgId, invoiceId);
    if (amount <= 0) return invoice;
    const now = opts.at ?? this.ctx.now();
    const collectable = invoice.total - invoice.pre_payment_credit_notes_amount;
    // What the bill can still absorb. A voided invoice absorbs nothing: it was
    // withdrawn, so money arriving against it belongs to the customer, not to
    // a document that has been struck out.
    const room = invoice.status === 'void' ? 0 : Math.max(0, collectable - invoice.amount_paid);
    // The split, and the whole point of this method: what the bill takes, and
    // what it cannot. Clamping `amount` to `room` and stopping there is how a
    // payments system takes a card payment and leaves no record of it — the
    // invoice invariant stays green precisely *because* the difference was
    // dropped. It is not dropped here; it is a value, and it goes somewhere.
    const applied = Math.min(amount, room);
    const excess = amount - applied;

    let after = invoice;
    if (applied > 0 && invoice.amount_paid + applied >= collectable) {
      after = this.billing.invoices.pay(orgId, invoiceId, { note: opts.note, at: now }, opts.meta);
    } else if (applied > 0) {
      this.ctx.db.patch('billing_invoices', 'id', invoiceId, {
        amount_paid: invoice.amount_paid + applied, amount_due: room - applied,
        payment_note: opts.note, updated: now,
      });
      this.billing.invoices.assertBalanced(orgId, invoiceId);
      after = this.billing.invoices.require(orgId, invoiceId);
      this.ctx.emit(orgId, 'invoice.partially_paid', after, {
        objectId: invoiceId, objectType: 'invoice', previous: { amount_paid: invoice.amount_paid, amount_due: invoice.amount_due },
        actorId: opts.meta?.actorId, actorType: opts.meta?.actorType, requestId: opts.meta?.requestId,
      });
    }
    if (excess > 0) {
      after = this.recordOverpayment(orgId, after, excess, { at: now, charge: opts.charge ?? null, meta: opts.meta });
    }
    return after;
  }

  /**
   * Money arrived that the bill could not absorb. It is the customer's.
   *
   * A payment that outruns its invoice is not a smaller payment. Stripe calls
   * the difference `amount_overpaid` and lands it as a customer balance
   * transaction, and that is the only honest place for it: the balance is a
   * ledger, so the money keeps a row, a description and an ending figure, and
   * billing's own `issue()` draws it down on the next bill without anyone
   * having to remember it is there.
   *
   * Confirming an invoice-bound intent can no longer produce one of these —
   * `priceAgainstInvoice` refuses first. What still can is a payment already
   * committed before the bill moved: a direct debit that settles three days
   * after a credit note landed, or a dispute won over a charge whose invoice
   * has since been credited.
   */
  private recordOverpayment(
    orgId: string, invoice: Invoice, excess: number,
    opts: { at: number; charge: string | null; meta?: WriteMeta },
  ): Invoice {
    const customer = this.ctx.svc.billing.requireCustomer(orgId, invoice.customer);
    if (customer.currency !== invoice.currency) {
      // Billing fixes a customer's currency at their first bill, so this
      // cannot happen — and if it ever does, taking the transaction down beats
      // filing dollars in a euro ledger where nobody would find them again.
      throw internal(
        `Invoice ${invoice.number} is in ${invoice.currency.toUpperCase()} but ${customer.name}'s balance is kept in ${customer.currency.toUpperCase()}, so the ${excess} collected beyond the bill cannot be credited to the account.`,
        { invoice: invoice.id, customer: customer.id, excess, invoice_currency: invoice.currency, customer_currency: customer.currency },
      );
    }
    const locale = this.locale(orgId);
    const shown = formatMoney(money(excess, invoice.currency), { locale });
    const txn = this.billing.adjustBalance(orgId, customer.id, -excess, {
      type: 'invoice_overpayment',
      description: opts.charge
        ? `${shown} more than invoice ${invoice.number} was owed arrived with ${opts.charge}. It is credit on the account and comes off the next bill.`
        : `${shown} more than invoice ${invoice.number} was owed was collected against it. It is credit on the account and comes off the next bill.`,
      subscription: invoice.subscription, invoice: invoice.id, createdAt: opts.at,
    });
    this.ctx.emit(orgId, 'invoice.overpaid', {
      invoice: invoice.id, number: invoice.number, customer: customer.id,
      subscription: invoice.subscription,
      amount_overpaid: excess, currency: invoice.currency,
      charge: opts.charge, balance_transaction: txn.id, customer_balance: txn.ending_balance,
      resolution: `${shown} was collected beyond what ${invoice.number} was owed and has been credited to ${customer.name}'s account balance. Refund it against ${opts.charge ?? 'the charge that collected it'} if the customer wants the money back rather than the credit.`,
    }, {
      objectId: invoice.id, objectType: 'invoice',
      actorId: opts.meta?.actorId, actorType: opts.meta?.actorType, requestId: opts.meta?.requestId,
    });
    return this.billing.invoices.require(orgId, invoice.id);
  }

  /**
   * What has been collected against this bill beyond what it was owed.
   *
   * Read back out of the balance ledger rather than kept in a column of its
   * own, so the figure and the money that produced it can never disagree.
   */
  overpaidOn(orgId: string, invoiceId: string): number {
    return this.ctx.db.count(
      `SELECT COALESCE(-SUM(amount), 0) FROM billing_balance_transactions
        WHERE org_id = ? AND invoice_id = ? AND type = 'invoice_overpayment'`,
      orgId, invoiceId,
    );
  }

  /**
   * Take money back off a bill — a refund, or a dispute the network has pulled.
   *
   * Cash that went past the bill is settled first, off the customer's balance,
   * and only what is left comes off `amount_paid`, where `amount_due` rises by
   * the same — the only way to keep billing's identity
   * `amount_paid + credited-before-payment + amount_due === total` true. If
   * that leaves anything owed, the invoice is open again, because a bill that
   * has had its money taken back is not a paid bill. What this deliberately
   * does *not* do is change what was billed: reducing the bill itself is a
   * credit note's job, and doing it here would erase the tax with it.
   */
  reverseCollection(
    orgId: string, invoiceId: string, amount: number,
    opts: { note: string; at?: number; meta?: WriteMeta },
  ): Invoice {
    const invoice = this.billing.invoices.require(orgId, invoiceId);
    if (amount <= 0) return invoice;
    const now = opts.at ?? this.ctx.now();
    // What this bill took beyond what it was owed. It is on the customer's
    // balance, not in `amount_paid`, and it is the first thing money leaving
    // has to come out of. Taking it off the bill instead is how a refund pays
    // a customer twice: the cash goes back, the credit that same cash created
    // stays on the account, and the bill it never owed reopens for the
    // difference. The mirror of `applyCollection`, which fills the bill first
    // and puts only the excess on the account — so a reversal empties the
    // account first and only then reaches into the bill.
    const overpaid = this.overpaidOn(orgId, invoiceId);
    // A withdrawn bill is refused only when it is genuinely holding nothing.
    // Being void is not on its own a reason: `voidInvoice` leaves whatever was
    // collected sitting in `amount_paid`, and a bill that was part paid before
    // it was struck out still holds the customer's money. Refusing there is how
    // a refund becomes impossible — the cash is recorded against a document
    // nobody can act on, and neither a refund nor a chargeback can reach it.
    if (invoice.status === 'void' && overpaid + invoice.amount_paid <= 0) {
      throw conflict('invoice_void', `Invoice ${invoice.number} was voided, so there is no payment on it to reverse.`);
    }
    const fromCredit = Math.min(amount, overpaid);
    let current = invoice;
    if (fromCredit > 0) {
      current = this.reverseOverpayment(orgId, invoice, fromCredit, { at: now, note: opts.note, meta: opts.meta });
    }
    const moved = Math.min(amount - fromCredit, current.amount_paid);
    if (fromCredit + moved !== amount) {
      // Neither the bill nor the account held what is leaving, which means the
      // cash taken against this invoice and the cash recorded against it had
      // already drifted apart before this call. Taking the transaction down
      // beats paying out money the platform has no record of collecting.
      throw internal(
        `Invoice ${current.number} cannot give back ${amount}: ${current.amount_paid} is recorded as collected on the bill and ${overpaid} as credit on the account, which is ${fromCredit + moved} in total.`,
        { invoice: invoiceId, amount, amount_paid: current.amount_paid, amount_overpaid: overpaid },
      );
    }
    if (moved <= 0) return current;
    const paid = current.amount_paid - moved;
    // A withdrawn bill is owed nothing and cannot become owed again: taking its
    // cash back leaves it struck out and empty, not open for the difference.
    // Every other status carries the rise on `amount_due`, which is what keeps
    // billing's identity true.
    const due = current.status === 'void' ? 0 : current.total - current.pre_payment_credit_notes_amount - paid;
    const reopened = due > 0 && (current.status === 'paid');
    this.ctx.db.patch('billing_invoices', 'id', invoiceId, {
      amount_paid: paid, amount_due: due,
      status: reopened ? 'open' : current.status,
      paid_at: due > 0 ? null : current.paid_at,
      payment_note: opts.note, updated: now,
    });
    this.billing.invoices.assertBalanced(orgId, invoiceId);
    const after = this.billing.invoices.require(orgId, invoiceId);
    this.ctx.emit(orgId, 'invoice.payment_reversed', {
      invoice: after.id, number: after.number, customer: after.customer, subscription: after.subscription,
      amount: moved, currency: after.currency, amount_paid: after.amount_paid, amount_due: after.amount_due,
      status: after.status, note: opts.note,
    }, {
      objectId: invoiceId, objectType: 'invoice',
      previous: { amount_paid: current.amount_paid, amount_due: current.amount_due, status: current.status },
      actorId: opts.meta?.actorId, actorType: opts.meta?.actorType, requestId: opts.meta?.requestId,
    });
    return after;
  }

  /**
   * Take back credit this bill put on the account, because the cash that made
   * it has gone back to the customer.
   *
   * The exact reverse of `recordOverpayment`, and it has to be, or the two
   * halves of one refund disagree: a positive `invoice_overpayment` row against
   * the same invoice, so `overpaidOn` and the customer's balance both fall by
   * what left, in step with the money. Nothing on the invoice moves — the bill
   * never held this cash.
   */
  private reverseOverpayment(
    orgId: string, invoice: Invoice, amount: number,
    opts: { at: number; note: string; meta?: WriteMeta },
  ): Invoice {
    const customer = this.ctx.svc.billing.requireCustomer(orgId, invoice.customer);
    const locale = this.locale(orgId);
    const shown = formatMoney(money(amount, invoice.currency), { locale });
    const txn = this.billing.adjustBalance(orgId, customer.id, amount, {
      type: 'invoice_overpayment',
      description: `${shown} of the credit invoice ${invoice.number} put on this account went back with the money that made it. ${opts.note}`,
      subscription: invoice.subscription, invoice: invoice.id, createdAt: opts.at,
    });
    this.ctx.emit(orgId, 'invoice.overpayment_reversed', {
      invoice: invoice.id, number: invoice.number, customer: customer.id,
      subscription: invoice.subscription,
      amount, currency: invoice.currency,
      amount_overpaid: this.overpaidOn(orgId, invoice.id),
      balance_transaction: txn.id, customer_balance: txn.ending_balance,
      note: opts.note,
      resolution: `${shown} was collected past what ${invoice.number} was owed and credited to ${customer.name}'s account. That cash has now gone back to them, so the credit went with it — the bill itself is unchanged, because it never held this money.`,
    }, {
      objectId: invoice.id, objectType: 'invoice',
      actorId: opts.meta?.actorId, actorType: opts.meta?.actorType, requestId: opts.meta?.requestId,
    });
    return this.billing.invoices.require(orgId, invoice.id);
  }

  /* --------------------------------- refunds ------------------------------ */

  createRefund(orgId: string, input: RefundInput, meta: WriteMeta = {}): Refund {
    return this.ctx.atomic(() => {
      const charge = this.resolveCharge(orgId, input);
      const remaining = charge.amount - charge.amount_refunded - charge.amount_disputed;
      const amount = input.amount ?? remaining;
      const locale = this.locale(orgId);
      if (amount <= 0) throw badRequest('amount_invalid', 'A refund has to be for a positive amount.', 'amount');
      if (amount > remaining) {
        throw badRequest(
          'refund_exceeds_charge',
          `${charge.id} has ${formatMoney(money(remaining, charge.currency), { locale })} left to refund, not ${formatMoney(money(amount, charge.currency), { locale })}.`,
          'amount', { remaining },
        );
      }
      const now = this.ctx.now();
      const id = newId('refund');
      const reason: RefundReason = input.reason ?? 'requested_by_customer';
      const shown = formatMoney(money(amount, charge.currency), { locale });

      let effect: string | null = null;
      if (charge.invoice) {
        const before = this.billing.invoices.require(orgId, charge.invoice);
        const after = this.reverseCollection(orgId, charge.invoice, amount, {
          note: `${shown} refunded to the customer on ${new Date(now).toISOString().slice(0, 10)} (${id}).`,
          at: now, meta,
        });
        effect = after.status === 'open' && before.status === 'paid'
          ? `Invoice ${after.number} is open again with ${formatMoney(money(after.amount_due, after.currency), { locale })} showing as due, because the money that settled it has gone back. Raise a credit note if the bill itself should be smaller.`
          : `Invoice ${after.number} now records ${formatMoney(money(after.amount_paid, after.currency), { locale })} collected.`;
      }

      this.ctx.db.insert('payments_refunds', {
        id, org_id: orgId, charge_id: charge.id, payment_intent_id: charge.payment_intent,
        customer_id: charge.customer, invoice_id: charge.invoice,
        amount, currency: charge.currency, reason, status: 'succeeded',
        description: input.description ?? null, invoice_effect: effect, created: now,
      } as any);
      const refunded = charge.amount_refunded + amount;
      this.ctx.db.patch('payments_charges', 'id', charge.id, {
        amount_refunded: refunded, refunded: refunded >= charge.amount ? 1 : 0,
      });

      const record = this.refund(orgId, id) as Refund;
      this.ctx.emit(orgId, 'charge.refunded', {
        refund: record, charge: this.requireCharge(orgId, charge.id),
      }, {
        objectId: charge.id, objectType: 'charge',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return record;
    });
  }

  private resolveCharge(orgId: string, input: { charge?: string; payment_intent?: string; invoice?: string }): Charge {
    if (input.charge) {
      const charge = this.requireCharge(orgId, input.charge);
      if (charge.status !== 'succeeded') {
        throw conflict('charge_not_succeeded', `${charge.id} is ${charge.status}, so there is no money on it to move.`, { status: charge.status });
      }
      return charge;
    }
    const clause = input.payment_intent ? 'payment_intent_id = ?' : 'invoice_id = ?';
    const value = input.payment_intent ?? input.invoice;
    if (!value) throw badRequest('charge_required', 'Name the charge, the payment intent or the invoice to act on.', 'charge');
    const row = this.ctx.db.get<any>(
      `SELECT * FROM payments_charges WHERE org_id = ? AND ${clause} AND status = 'succeeded' ORDER BY created DESC LIMIT 1`,
      orgId, value,
    );
    if (!row) throw notFound('successful charge', value);
    return hydrateCharge(row);
  }

  /* -------------------------------- disputes ------------------------------ */

  /**
   * Open a dispute. The money goes immediately.
   *
   * This is the detail most billing systems get wrong: the network withdraws
   * the funds the day the cardholder complains, not the day the case closes.
   * Modelling it any other way makes a workspace's cash position wrong for
   * three weeks at a time.
   */
  openDispute(orgId: string, input: DisputeInput, meta: WriteMeta = {}): Dispute {
    return this.ctx.atomic(() => {
      const charge = this.resolveCharge(orgId, input);
      const open = this.ctx.db.get<any>(
        `SELECT id FROM payments_disputes WHERE org_id = ? AND charge_id = ? AND status IN ('needs_response','under_review')`,
        orgId, charge.id,
      );
      if (open) throw conflict('dispute_already_open', `${charge.id} is already being disputed under ${open.id}.`, { dispute: open.id });
      const disputable = charge.amount - charge.amount_refunded - charge.amount_disputed;
      const amount = input.amount ?? disputable;
      const locale = this.locale(orgId);
      if (amount <= 0 || amount > disputable) {
        throw badRequest(
          'dispute_amount_invalid',
          `${charge.id} has ${formatMoney(money(Math.max(disputable, 0), charge.currency), { locale })} that can still be disputed.`,
          'amount', { disputable },
        );
      }
      const now = this.ctx.now();
      const dueDays = input.evidence_due_days ?? DEFAULT_EVIDENCE_DAYS;
      const id = newId('dispute');
      this.ctx.db.insert('payments_disputes', {
        id, org_id: orgId, charge_id: charge.id, payment_intent_id: charge.payment_intent,
        customer_id: charge.customer, invoice_id: charge.invoice, subscription_id: charge.subscription,
        amount, currency: charge.currency, reason: input.reason, status: 'needs_response',
        evidence: {
          product_description: null, customer_communication: null,
          service_documentation: null, cancellation_policy: null, uncategorized_text: null,
        },
        evidence_due_by: now + dueDays * DAY,
        submitted_at: null, closed_at: null, outcome_note: null,
        is_charge_refundable: 0, created: now, updated: now,
      } as any);
      this.ctx.db.patch('payments_charges', 'id', charge.id, {
        disputed: 1, amount_disputed: charge.amount_disputed + amount,
      });
      if (charge.invoice) {
        this.reverseCollection(orgId, charge.invoice, amount, {
          note: `${formatMoney(money(amount, charge.currency), { locale })} withdrawn by the card network while dispute ${id} is open.`,
          at: now, meta,
        });
      }
      // A dispute nobody answers is a dispute lost. The deadline is a row with
      // a `run_at`, so it is still true after a restart and still true in the
      // time machine.
      this.ctx.enqueue(orgId, 'payments.dispute_deadline', { dispute: id }, {
        runAt: now + dueDays * DAY, idemKey: `payments.dispute_deadline:${id}`,
      });
      const dispute = this.requireDispute(orgId, id);
      this.ctx.emit(orgId, 'charge.dispute.created', dispute, {
        objectId: id, objectType: 'dispute',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return dispute;
    });
  }

  submitEvidence(orgId: string, id: string, evidence: Partial<DisputeEvidence>, meta: WriteMeta = {}): Dispute {
    return this.ctx.atomic(() => {
      const dispute = this.requireDispute(orgId, id);
      if (dispute.status === 'won' || dispute.status === 'lost') {
        throw conflict('dispute_closed', `Dispute ${id} closed as ${dispute.status} and no longer takes evidence.`, { status: dispute.status });
      }
      const now = this.ctx.now();
      const merged: DisputeEvidence = { ...dispute.evidence, ...evidence };
      if (!Object.values(merged).some((value) => value && String(value).trim())) {
        throw badRequest('evidence_empty', 'Submitting nothing loses the dispute. Describe what was sold, and when.', 'evidence');
      }
      this.ctx.db.patch('payments_disputes', 'id', id, {
        evidence: merged as any, status: 'under_review', submitted_at: now, updated: now,
      });
      const after = this.requireDispute(orgId, id);
      this.ctx.emit(orgId, 'charge.dispute.updated', after, {
        objectId: id, objectType: 'dispute', previous: { status: dispute.status },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return after;
    });
  }

  closeDispute(orgId: string, id: string, won: boolean, note: string | null, meta: WriteMeta = {}): Dispute {
    return this.ctx.atomic(() => {
      const dispute = this.requireDispute(orgId, id);
      if (dispute.status === 'won' || dispute.status === 'lost') return dispute;
      const now = this.ctx.now();
      const locale = this.locale(orgId);
      const shown = formatMoney(money(dispute.amount, dispute.currency), { locale });
      const charge = this.requireCharge(orgId, dispute.charge);

      this.ctx.db.patch('payments_disputes', 'id', id, {
        status: won ? 'won' : 'lost', closed_at: now, updated: now,
        outcome_note: note ?? (won
          ? `The issuer found in our favour and returned ${shown}.`
          : `The issuer found for the cardholder and kept ${shown}.`),
        is_charge_refundable: won ? 1 : 0,
      });
      this.ctx.db.patch('payments_charges', 'id', charge.id, {
        amount_disputed: Math.max(0, charge.amount_disputed - (won ? dispute.amount : 0)),
        disputed: won ? 0 : 1,
      });

      if (dispute.invoice) {
        if (won) {
          this.applyCollection(orgId, dispute.invoice, dispute.amount, {
            note: `${shown} returned after dispute ${id} was won.`, at: now, charge: charge.id, meta,
          });
        } else {
          // The money is gone and will not be collected: that is precisely what
          // "uncollectible" means. Billing hears this and moves the subscription
          // to `unpaid` through its own transition.
          //
          // Only for a bill that is actually still owed, though. A withdrawal
          // does not always leave one: it comes off the customer's overpayment
          // credit first, and a bill can also have been collected again while
          // the case was open. Either way the invoice is settled, there is
          // nothing to write off — and billing refuses to write off a paid bill,
          // which took the whole close down with it and left the deadline job
          // failing on every run, so the dispute could never be closed at all.
          const invoice = this.billing.invoices.require(orgId, dispute.invoice);
          if (invoice.status === 'open' && invoice.amount_due > 0) {
            this.billing.invoices.markUncollectible(orgId, dispute.invoice, meta, now);
          }
          this.payments.dunning.stopFor(orgId, dispute.invoice, `Dispute ${id} was lost, so there is nothing left to recover.`);
        }
      }

      const after = this.requireDispute(orgId, id);
      this.ctx.emit(orgId, won ? 'charge.dispute.won' : 'charge.dispute.lost', after, {
        objectId: id, objectType: 'dispute', previous: { status: dispute.status },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      this.ctx.emit(orgId, 'charge.dispute.closed', after, {
        objectId: id, objectType: 'dispute', previous: { status: dispute.status },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return after;
    });
  }

  /** The deadline passed with nothing submitted, which the networks call a loss. */
  expireDispute(orgId: string, id: string): void {
    const dispute = this.dispute(orgId, id);
    if (!dispute || dispute.status !== 'needs_response') return;
    this.closeDispute(orgId, id, false, 'No evidence was submitted before the deadline, so the dispute was lost by default.', { actorType: 'system' });
  }

  private locale(orgId: string): string {
    try { return this.ctx.svc.core.org(orgId).locale || 'en-US'; }
    catch { return 'en-US'; }
  }

  private customerName(orgId: string, customerId: string): string {
    return this.ctx.svc.billing.customer(orgId, customerId)?.name ?? 'the customer';
  }
}
