import { defineModule } from '../../kernel/module';
import type { Ctx } from '../../kernel/context';
import { created, list, status as httpStatus, type Req } from '../../kernel/http';
import { notFound } from '../../../shared/errors';
import { formatMoney, money } from '../../../shared/money';
import v from '../../../shared/validate';
import { PRORATION_BEHAVIORS, type ProrationBehavior } from '../catalog/types';
import { BILLING_MIGRATIONS } from './schema';
import { describeCadence, describeInterval, isMetered, longDate, Pricebook, recurringLines, recurringSubtotal, subscriptionMrr } from './cycle';
import { Billing } from './store';
import { INVOICE_TAX_FILTERS } from './records';
import type {
  CustomerInput, CustomerListFilter, InvoiceListFilter, SubscriptionCreateInput, SubscriptionListFilter,
  SubscriptionUpdateInput,
} from './records';
import type { CreditNoteInput, CreditNoteListFilter } from './credit-notes';
import { renderInvoice } from './render';
import { Schedules, type ScheduleCreateInput, type ScheduleListFilter, type ScheduleUpdateInput } from './schedules';
import {
  TaxRates, TAX_EXEMPTIONS, TAX_ID_TYPES, TAX_ID_VERIFICATION_STATUSES, TAX_TYPES, formatPercentage,
  type TaxIdVerificationStatus, type TaxRate, type TaxRateInput,
} from './tax';
import { buildCustomerSummary, type CustomerSummary, type InvoiceReader } from './summary';
import { countsAsRevenue, describeStatus, isTerminal, legalTransitions } from './status';
import { seedBilling } from './seed';
import {
  BALANCE_TRANSACTION_TYPES, CANCELLATION_REASONS, COLLECTION_METHODS, CREDIT_NOTE_REASONS,
  INVOICE_BILLING_REASONS,
  INVOICE_STATUSES, PAUSE_BEHAVIORS,
  PAYMENT_BEHAVIORS, SCHEDULE_END_BEHAVIORS, SCHEDULE_STATUSES, SUBSCRIPTION_STATUSES, TRIAL_END_BEHAVIORS,
  type BalanceTransaction, type BilledPeriod, type ChangePreview, type CreditNote, type Customer,
  type Invoice, type InvoiceStatus, type PendingInvoiceItem,
  type Subscription, type SubscriptionSchedule, type SubscriptionStatus,
} from './types';

/* --------------------------------- service -------------------------------- */

/**
 * What the rest of the platform needs from billing.
 *
 * Three methods worth pointing at: `previewChange` is the same call the update
 * path makes, so a quote and a charge can never disagree; `previewInvoice`
 * arranges that same arithmetic as the document the customer will receive; and
 * `useInvoiceReader` lets a dedicated invoicing module take over the customer
 * summary's view of what is owed without either module importing the other.
 */
export interface BillingService {
  customers(orgId: string, filter?: CustomerListFilter): Customer[];
  customer(orgId: string, id: string): Customer | null;
  requireCustomer(orgId: string, id: string): Customer;
  customerByCrmRecord(orgId: string, recordId: string): Customer | null;
  customerByEmail(orgId: string, email: string): Customer | null;
  createCustomer(orgId: string, input: CustomerInput): Customer;
  summary(orgId: string, customerId: string): CustomerSummary;

  /** Move the customer balance. Negative grants credit, Stripe-style. */
  adjustBalance(orgId: string, customerId: string, amount: number, opts: { type: BalanceTransaction['type']; description: string; subscription?: string | null; invoice?: string | null }): BalanceTransaction;
  balanceTransactions(orgId: string, customerId: string, limit?: number): BalanceTransaction[];
  /** Called by invoicing when it issues a customer's first invoice. */
  lockCurrency(orgId: string, customerId: string): void;

  subscriptions(orgId: string, filter?: SubscriptionListFilter): Subscription[];
  subscription(orgId: string, id: string): Subscription | null;
  requireSubscription(orgId: string, id: string): Subscription;
  createSubscription(orgId: string, input: SubscriptionCreateInput): Subscription;
  /** Side-effect free. The update path settles exactly these lines. */
  previewChange(orgId: string, id: string, input: SubscriptionUpdateInput): ChangePreview;
  updateSubscription(orgId: string, id: string, input: SubscriptionUpdateInput): { subscription: Subscription; preview: ChangePreview };
  cancelSubscription(orgId: string, id: string, input?: { at_period_end?: boolean; prorate?: boolean }): Subscription;
  mrr(orgId: string, sub: Subscription): number;

  schedules(orgId: string, filter?: ScheduleListFilter): SubscriptionSchedule[];
  schedule(orgId: string, id: string): SubscriptionSchedule | null;

  invoices(orgId: string, filter?: InvoiceListFilter): Invoice[];
  invoice(orgId: string, id: string): Invoice | null;
  /** Bill everything an account currently owes, without re-billing the period. */
  invoiceNow(orgId: string, customerId: string, opts?: { subscription?: string | null }): Invoice;
  /** The next invoice as it stands, or as a proposed change would leave it. */
  previewInvoice(orgId: string, subscriptionId: string, input?: SubscriptionUpdateInput): Invoice;

  /** Proration lines waiting to be swept onto an invoice. */
  pendingItems(orgId: string, filter?: { customer?: string; subscription?: string }): PendingInvoiceItem[];
  /** Claim them onto an invoice. Returns exactly what was claimed. */
  claimPendingItems(orgId: string, customerId: string, invoiceId: string, opts?: { ids?: string[]; currency?: string }): PendingInvoiceItem[];
  /** Every period a subscription has entered, with the amount recognised. */
  periods(orgId: string, filter?: { subscription?: string; customer?: string; from?: number; to?: number }): BilledPeriod[];

  /** Invoicing registers here at boot so summaries can show real invoices. */
  useInvoiceReader(reader: InvoiceReader): void;
}

declare module '../../kernel/services' {
  interface ServiceRegistry { billing: BillingService }
}

const stores = new WeakMap<Ctx, { billing: Billing; schedules: Schedules }>();
export function billingStore(ctx: Ctx): { billing: Billing; schedules: Schedules } {
  let found = stores.get(ctx);
  if (!found) {
    const billing = new Billing(ctx);
    found = { billing, schedules: new Schedules(ctx, billing) };
    stores.set(ctx, found);
  }
  return found;
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

const addressBody = v.object({
  line1: v.optional(v.string({ max: 200 })),
  line2: v.optional(v.string({ max: 200 })),
  city: v.optional(v.string({ max: 120 })),
  state: v.optional(v.string({ max: 120 })),
  postal_code: v.optional(v.string({ max: 40 })),
  country: v.optional(v.string({ max: 80 })),
}, { strict: true });

const invoiceSettingsBody = v.object({
  default_payment_method: v.optional(v.string({ max: 120 })),
  days_until_due: v.optional(v.int({ min: 0, max: 365 })),
  custom_fields: v.optional(v.array(v.object({ name: v.string({ min: 1, max: 40 }), value: v.string({ min: 1, max: 140 }) }), { max: 4 })),
  footer: v.optional(v.string({ max: 1000 })),
}, { strict: true });

/**
 * Every billing write body is strict, for the same reason the catalog's are: a
 * key this module does not read is a request that did not happen. `POST
 * /v1/subscriptions` used to take `start_date` and `trial_days`, answer 201 and
 * honour neither — the caller believed they had backdated a subscription and
 * given it a trial, and the bill said otherwise a month later. Unknown keys are
 * named and refused, the way Stripe answers `Received unknown parameter`.
 */
const CUSTOMER_FIELDS = {
  email: v.optional(v.email()),
  description: v.optional(v.string({ max: 1000 })),
  phone: v.optional(v.string({ max: 40 })),
  currency: v.optional(v.currency()),
  address: v.optional(addressBody),
  shipping: v.optional(v.object({
    name: v.optional(v.string({ max: 160 })),
    phone: v.optional(v.string({ max: 40 })),
    address: v.optional(addressBody),
  }, { strict: true })),
  tax_ids: v.optional(v.array(v.object({
    type: v.string({ min: 2, max: 40, description: `The kind of registration. Checked against its authority's format for: ${TAX_ID_TYPES.join(', ')}.` }),
    value: v.string({ min: 2, max: 60, description: 'The number as the register writes it — DE811907980, GB123456789, 12-3456789. Spaces and dots are removed; a number that is not the shape its authority issues is refused.' }),
    country: v.optional(v.string({ max: 80 })),
  }, { strict: true }), { max: 10 })),
  tax_exempt: v.optional(v.enum(TAX_EXEMPTIONS)),
  invoice_settings: v.optional(invoiceSettingsBody),
  preferred_locales: v.optional(v.array(v.string({ max: 12 }), { max: 6 })),
  metadata: v.metadata(),
  crm_record_id: v.optional(v.string({ max: 80 })),
};

const customerCreateBody = v.object({ name: v.string({ min: 1, max: 200 }), ...CUSTOMER_FIELDS }, { strict: true });
const customerUpdateBody = v.object({ name: v.optional(v.string({ min: 1, max: 200 })), ...CUSTOMER_FIELDS }, { strict: true });

const itemBody = v.object({
  id: v.optional(v.id('si')),
  price: v.optional(v.string({ min: 3, max: 120, description: 'A price id or a lookup key such as growth_monthly.' })),
  quantity: v.optional(v.int({ min: 0, max: 1_000_000 })),
  custom_unit_amount: v.optional(v.int({ min: 0, description: 'The agreed amount, in minor units, for a negotiated price.' })),
  metadata: v.metadata(),
  deleted: v.optional(v.boolean()),
}, { strict: true });

const subscriptionCreateBody = v.object({
  customer: v.id('cus'),
  items: v.array(itemBody, { min: 1, max: 30 }),
  currency: v.optional(v.currency()),
  billing_cycle_anchor: v.optional(v.timestamp()),
  billing_cycle_anchor_day: v.optional(v.int({ min: 1, max: 31, description: 'The billing day, when it is easier to say than an instant. The same cycle as billing_cycle_anchor, so send one or the other — a monthly or yearly cycle only.' })),
  backdate_start_date: v.optional(v.timestamp()),
  trial_period_days: v.optional(v.int({ min: 0, max: 730 })),
  trial_end: v.optional(v.timestamp()),
  trial_from_plan: v.optional(v.boolean()),
  trial_settings: v.optional(v.object({
    end_behavior: v.optional(v.object({ missing_payment_method: v.enum(TRIAL_END_BEHAVIORS) }, { strict: true })),
  }, { strict: true })),
  collection_method: v.optional(v.enum(COLLECTION_METHODS)),
  days_until_due: v.optional(v.int({ min: 0, max: 365 })),
  default_payment_method: v.optional(v.string({ max: 120 })),
  proration_behavior: v.optional(v.enum(PRORATION_BEHAVIORS)),
  payment_behavior: v.optional(v.enum(PAYMENT_BEHAVIORS)),
  cancel_at_period_end: v.optional(v.boolean()),
  cancel_at: v.optional(v.timestamp()),
  description: v.optional(v.string({ max: 500 })),
  metadata: v.metadata(),
}, { strict: true });

const CHANGE_FIELDS = {
  items: v.optional(v.array(itemBody, { max: 30 })),
  proration_behavior: v.optional(v.enum(PRORATION_BEHAVIORS)),
  proration_date: v.optional(v.timestamp()),
  billing_cycle_anchor: v.optional(v.enum(['now', 'unchanged'] as const)),
  trial_end: v.optional(v.union(v.literal('now'), v.timestamp())),
};

const subscriptionUpdateBody = v.object({
  ...CHANGE_FIELDS,
  cancel_at_period_end: v.optional(v.boolean()),
  cancel_at: v.optional(v.nullable(v.timestamp())),
  collection_method: v.optional(v.enum(COLLECTION_METHODS)),
  days_until_due: v.optional(v.int({ min: 0, max: 365 })),
  default_payment_method: v.optional(v.string({ max: 120 })),
  description: v.optional(v.string({ max: 500 })),
  metadata: v.metadata(),
}, { strict: true });

const previewBody = v.object(CHANGE_FIELDS, { strict: true });

const cancelBody = v.object({
  at_period_end: v.optional(v.boolean()),
  cancel_at: v.optional(v.timestamp()),
  prorate: v.optional(v.boolean()),
  cancellation_reason: v.optional(v.enum(CANCELLATION_REASONS)),
  comment: v.optional(v.string({ max: 1000 })),
}, { strict: true });

const pauseBody = v.object({
  behavior: v.default(v.enum(PAUSE_BEHAVIORS), 'keep_as_draft'),
  resumes_at: v.optional(v.timestamp()),
}, { strict: true });

const resumeBody = v.object({
  billing_cycle_anchor: v.optional(v.enum(['now', 'unchanged'] as const)),
  proration_behavior: v.optional(v.enum(PRORATION_BEHAVIORS)),
}, { strict: true });

const phaseBody = v.object({
  items: v.array(v.object({
    price: v.string({ min: 3, max: 120 }),
    quantity: v.optional(v.int({ min: 0, max: 1_000_000 })),
    custom_unit_amount: v.optional(v.int({ min: 0 })),
    metadata: v.metadata(),
  }, { strict: true }), { min: 1, max: 30 }),
  iterations: v.optional(v.int({ min: 1, max: 120 })),
  end_date: v.optional(v.timestamp()),
  start_date: v.optional(v.timestamp()),
  proration_behavior: v.optional(v.enum(PRORATION_BEHAVIORS)),
  trial: v.optional(v.boolean()),
  trial_end: v.optional(v.timestamp()),
  collection_method: v.optional(v.enum(COLLECTION_METHODS)),
  days_until_due: v.optional(v.int({ min: 0, max: 365 })),
  description: v.optional(v.string({ max: 300 })),
  metadata: v.metadata(),
}, { strict: true });

const scheduleCreateBody = v.object({
  customer: v.optional(v.id('cus')),
  from_subscription: v.optional(v.id('sub')),
  start_date: v.optional(v.timestamp()),
  end_behavior: v.optional(v.enum(SCHEDULE_END_BEHAVIORS)),
  phases: v.array(phaseBody, { min: 1, max: 24 }),
  metadata: v.metadata(),
}, { strict: true });

const scheduleUpdateBody = v.object({
  phases: v.optional(v.array(phaseBody, { min: 1, max: 24 })),
  end_behavior: v.optional(v.enum(SCHEDULE_END_BEHAVIORS)),
  metadata: v.metadata(),
}, { strict: true });

const invoicePreviewBody = v.object({
  subscription: v.id('sub'),
  items: v.optional(v.array(itemBody, { max: 30 })),
  proration_behavior: v.optional(v.enum(PRORATION_BEHAVIORS)),
  proration_date: v.optional(v.timestamp()),
  billing_cycle_anchor: v.optional(v.enum(['now', 'unchanged'] as const)),
}, { strict: true });

const taxRateBody = v.object({
  display_name: v.string({ min: 1, max: 60, description: 'What appears on the invoice: "VAT", "OH sales tax".' }),
  description: v.optional(v.string({ max: 300 })),
  jurisdiction: v.string({ min: 1, max: 80, description: 'The place, for a human: "Germany", "New York".' }),
  country: v.string({ min: 2, max: 80, description: 'An ISO-3166 two-letter code, or a country name this workspace can match.' }),
  state: v.optional(v.string({ max: 80, description: 'Spelled the way customer addresses spell it, since that is what it is matched against.' })),
  tax_type: v.optional(v.enum(TAX_TYPES)),
  percentage: v.string({ min: 1, max: 12, description: 'An exact decimal, never a float: "19", "8.875".' }),
  reverse_charge: v.optional(v.boolean()),
  active: v.optional(v.boolean()),
  metadata: v.metadata(),
}, { strict: true });

const creditNoteBody = v.object({
  invoice: v.id('in'),
  amount: v.optional(v.int({ min: 1, max: 1_000_000_000, description: 'The gross to credit, tax included, spread across the invoice lines in proportion to what each has left.' })),
  lines: v.optional(v.array(v.object({
    invoice_line_item: v.id('il'),
    amount: v.optional(v.int({ min: 1, max: 1_000_000_000, description: 'Gross, tax included. Left out, the line is credited in full.' })),
    quantity: v.optional(v.int({ min: 1, max: 1_000_000, description: 'Credit this many of the units billed, priced pro rata.' })),
  }, { strict: true }), { min: 1, max: 100 })),
  reason: v.optional(v.enum(CREDIT_NOTE_REASONS)),
  memo: v.optional(v.string({ max: 600 })),
  metadata: v.metadata(),
}, { strict: true });

const balanceBody = v.object({
  amount: v.int({ min: -100_000_000, max: 100_000_000, description: 'Signed minor units. Negative grants credit.' }),
  description: v.string({ min: 3, max: 300 }),
  type: v.default(v.enum(BALANCE_TRANSACTION_TYPES), 'adjustment'),
  subscription: v.optional(v.id('sub')),
}, { strict: true });

/* --------------------------------- payloads ------------------------------- */

const expandOf = (req: Req): string[] => String(req.query.expand ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function subscriptionPayload(ctx: Ctx, orgId: string, sub: Subscription, expand: string[]) {
  const store = billingStore(ctx).billing;
  const book = new Pricebook(ctx, orgId);
  const locale = localeOf(ctx, orgId);
  const lines = recurringLines(sub.items, { start: sub.current_period_start, end: sub.current_period_end }, { book, currency: sub.currency, locale });
  return {
    ...sub,
    items: sub.items.map((item, i) => ({ ...item, description: lines[i].description, amount: lines[i].amount })),
    recurring_subtotal: recurringSubtotal(lines),
    mrr: countsAsRevenue(sub.status) ? subscriptionMrr(sub, book) : 0,
    status_detail: describeStatus(sub.status),
    next_status_options: legalTransitions(sub.status),
    interval_display: describeInterval(sub.interval_count, sub.interval),
    latest_invoice: store.invoices.latestFor(orgId, sub.id),
    ...(expand.includes('customer') ? { customer_detail: store.customer(orgId, sub.customer) } : {}),
    ...(expand.includes('schedule') && sub.schedule ? { schedule_detail: billingStore(ctx).schedules.schedule(orgId, sub.schedule) } : {}),
  };
}

/** Accept a price id or a lookup key anywhere a price is named. */
function resolvePriceRef(ctx: Ctx, orgId: string, ref: string): string {
  const direct = ctx.svc.catalog.price(orgId, ref);
  if (direct) return direct.id;
  const byKey = ctx.svc.catalog.priceByLookupKey(orgId, ref);
  if (byKey) return byKey.id;
  throw notFound('price', ref);
}

const mapItemPrices = <T extends { price?: string }>(ctx: Ctx, orgId: string, items: T[] | undefined): T[] | undefined =>
  items?.map((item) => (item.price ? { ...item, price: resolvePriceRef(ctx, orgId, item.price) } : item));

/* ---------------------------------- module -------------------------------- */

export default defineModule({
  name: 'billing',
  title: 'Customers, subscriptions & invoices',
  description:
    'The customer record, the subscription lifecycle and the bill at the end of it: billing-cycle anchors that survive February, trials and their conversion, pausing, cancellation, exact mid-cycle proration that previews and charges through one function, multi-phase schedules that replay under the time machine, tax resolved from the customer\u2019s own address and snapshotted onto every line, credit notes as the only way to reduce a finalised bill, and invoices whose lines always add up to their total.',
  dependsOn: ['core', 'catalog', 'crm'],
  migrations: BILLING_MIGRATIONS,

  boot(ctx) {
    const { billing, schedules } = billingStore(ctx);
    // Billing draws its own invoices, so the customer summary reads real bills
    // rather than an empty stub. A dedicated invoicing module can still take
    // over by calling `useInvoiceReader`, and the summary will follow it.
    let invoiceReader: InvoiceReader = {
      openInvoices: (orgId, customerId) => billing.invoices.openInvoices(orgId, customerId).map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        status: invoice.status,
        currency: invoice.currency,
        total: invoice.total,
        amount_due: invoice.amount_due,
        due_date: invoice.due_date,
        created: invoice.created,
      })),
      lifetimeBilled: (orgId, customerId) => billing.invoices.lifetimeBilled(orgId, customerId),
    };

    const service: BillingService = {
      customers: (orgId, filter) => billing.listCustomers(orgId, { limit: 200, ...filter }).data,
      customer: (orgId, id) => billing.customer(orgId, id),
      requireCustomer: (orgId, id) => billing.requireCustomer(orgId, id),
      customerByCrmRecord: (orgId, recordId) => billing.customerByCrmRecord(orgId, recordId),
      customerByEmail: (orgId, email) => billing.customerByEmail(orgId, email),
      createCustomer: (orgId, input) => billing.createCustomer(orgId, input),
      summary: (orgId, customerId) => buildCustomerSummary(billing, orgId, customerId, invoiceReader, ctx.now()),

      adjustBalance: (orgId, customerId, amount, opts) => ctx.atomic(() => billing.adjustBalance(orgId, customerId, amount, opts)),
      balanceTransactions: (orgId, customerId, limit) => billing.balanceTransactions(orgId, customerId, limit),
      lockCurrency: (orgId, customerId) => billing.lockCurrency(orgId, customerId),

      subscriptions: (orgId, filter) => billing.listSubscriptions(orgId, { limit: 200, ...filter }).data,
      subscription: (orgId, id) => billing.subscription(orgId, id),
      requireSubscription: (orgId, id) => billing.requireSubscription(orgId, id),
      createSubscription: (orgId, input) => billing.createSubscription(orgId, input),
      previewChange: (orgId, id, input) => billing.previewSubscriptionChange(orgId, id, input),
      updateSubscription: (orgId, id, input) => billing.updateSubscription(orgId, id, input),
      cancelSubscription: (orgId, id, input) => billing.cancelSubscription(orgId, id, input ?? {}),
      mrr: (orgId, sub) => billing.mrr(orgId, sub),

      schedules: (orgId, filter) => schedules.list(orgId, { limit: 100, ...filter }).data,
      schedule: (orgId, id) => schedules.schedule(orgId, id),

      invoices: (orgId, filter) => billing.invoices.list(orgId, { limit: 200, ...filter }).data,
      invoice: (orgId, id) => billing.invoices.invoice(orgId, id),
      invoiceNow: (orgId, customerId, opts) => billing.invoiceNow(orgId, customerId, opts ?? {}),
      previewInvoice: (orgId, subscriptionId, input) => billing.previewInvoice(orgId, subscriptionId, input ?? {}),

      pendingItems: (orgId, filter) => billing.pendingItems(orgId, { ...filter, status: 'pending', limit: 500 }),
      claimPendingItems: (orgId, customerId, invoiceId, opts) => billing.claimPendingItems(orgId, customerId, invoiceId, opts),
      periods: (orgId, filter) => billing.periods(orgId, { ...filter, limit: 2000 }),

      useInvoiceReader(reader) { invoiceReader = reader; },
    };
    ctx.provide('billing', service);
    billing.onPeriodBoundary = (orgId, sub, at) => schedules.advanceIfDue(orgId, sub, at);

    /* ---------------------------------- jobs ------------------------------- */

    ctx.jobs.handle('billing.renew', (payload: { subscription: string; period_end: number }, job) => {
      billing.renew(job.org_id, payload.subscription, payload.period_end);
    });

    ctx.jobs.handle('billing.cancel_at', (payload: { subscription: string; cancel_at: number }, job) => {
      ctx.atomic(() => {
        const sub = billing.subscription(job.org_id, payload.subscription);
        if (!sub || isTerminal(sub.status)) return;
        if (sub.cancel_at !== payload.cancel_at) return;
        billing.endNow(job.org_id, sub, {
          at: payload.cancel_at,
          reason: sub.cancellation_reason ?? 'cancellation_requested',
          comment: sub.cancellation_comment,
        });
      });
    });

    ctx.jobs.handle('billing.resume', (payload: { subscription: string }, job) => {
      const sub = billing.subscription(job.org_id, payload.subscription);
      if (!sub || sub.status !== 'paused') return;
      billing.resumeSubscription(job.org_id, payload.subscription, {}, { actorType: 'system' });
    });

    ctx.jobs.handle('billing.trial_will_end', (payload: { subscription: string; trial_end: number }, job) => {
      const sub = billing.subscription(job.org_id, payload.subscription);
      if (!sub || sub.status !== 'trialing' || sub.trial_end !== payload.trial_end) return;
      const customer = billing.requireCustomer(job.org_id, sub.customer);
      ctx.emit(job.org_id, 'subscription.trial_will_end', {
        subscription: sub.id, customer: sub.customer, trial_end: sub.trial_end,
        has_payment_method: !!(sub.default_payment_method ?? customer.invoice_settings.default_payment_method),
        end_behavior: sub.trial_settings.end_behavior.missing_payment_method,
      }, { objectId: sub.id, objectType: 'subscription' });
    });

    ctx.jobs.handle('billing.incomplete_expire', (payload: { subscription: string }, job) => {
      ctx.atomic(() => {
        const sub = billing.subscription(job.org_id, payload.subscription);
        if (!sub || sub.status !== 'incomplete') return;
        billing.transition(job.org_id, sub, 'incomplete_expired', { meta: { actorType: 'system' } });
        billing.cancelJobs(job.org_id, sub.id);
      });
    });

    ctx.jobs.handle('billing.schedule.advance', (payload: { schedule: string; at: number }, job) => {
      schedules.advance(job.org_id, payload.schedule, payload.at);
    });

    /* ------------------------- reactions to invoicing ---------------------- */

    const subjectOf = (event: { data: unknown }): string | null => {
      const data = event.data as { subscription?: unknown } | null;
      const id = data && typeof data === 'object' ? data.subscription : null;
      return typeof id === 'string' && id.startsWith('sub_') ? id : null;
    };

    ctx.events.on('invoice.paid', (event) => {
      const id = subjectOf(event);
      if (!id) return;
      const sub = billing.subscription(event.org_id, id);
      if (!sub) return;
      if (sub.status !== 'incomplete' && sub.status !== 'past_due' && sub.status !== 'unpaid') return;
      // One paid invoice is not the same as a cleared account. Paying last
      // March's bill while this month's is still open leaves the subscription
      // in arrears, which is the only reading a collections team would accept.
      const stillOwed = ctx.db.count(
        `SELECT COUNT(*) FROM billing_invoices WHERE org_id = ? AND subscription_id = ? AND status IN ('draft','open')`,
        event.org_id, sub.id,
      );
      if (stillOwed > 0) return;
      ctx.atomic(() => billing.transition(event.org_id, sub, 'active', { meta: { actorType: 'system' } }));
    }, 'billing');

    ctx.events.on('invoice.payment_failed', (event) => {
      const id = subjectOf(event);
      if (!id) return;
      const sub = billing.subscription(event.org_id, id);
      if (!sub || sub.status === 'past_due' || isTerminal(sub.status)) return;
      if (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'unpaid') {
        ctx.atomic(() => billing.transition(event.org_id, sub, 'past_due', { meta: { actorType: 'system' } }));
      }
    }, 'billing');

    ctx.events.on('invoice.marked_uncollectible', (event) => {
      const id = subjectOf(event);
      if (!id) return;
      const sub = billing.subscription(event.org_id, id);
      if (!sub || isTerminal(sub.status) || sub.status === 'unpaid') return;
      // `pause_collection.behavior: mark_uncollectible` writes off the bills
      // raised while a subscription is paused — that is the setting working, not
      // dunning giving up, so the subscription stays paused and resumes on its
      // own date. Moving it to unpaid here would make every deliberate pause
      // look like a delinquency.
      if (sub.status === 'paused') return;
      ctx.atomic(() => billing.transition(event.org_id, sub, 'unpaid', { meta: { actorType: 'system' } }));
    }, 'billing');

    // A subscription that ends takes any schedule still driving it with it.
    ctx.events.on('subscription.canceled', (event) => {
      if (!event.object_id) return;
      schedules.onSubscriptionCanceled(event.org_id, event.object_id);
    }, 'billing');
  },

  seed(ctx, orgId) {
    seedBilling(ctx, orgId);
  },

  routes(router) {
    /* -------------------------------- customers --------------------------- */

    router.get('/v1/customers', (req: Req, c: Ctx) => {
      // The route's `query` validator has already coerced these, so they arrive
      // as booleans and numbers rather than the strings the URL carried.
      const q = req.query as CustomerListFilter;
      const page = billingStore(c).billing.listCustomers(req.auth.orgId, {
        query: q.query,
        email: q.email,
        currency: q.currency,
        crm_record_id: q.crm_record_id,
        delinquent: q.delinquent,
        has_subscription: q.has_subscription,
        limit: q.limit,
        cursor: q.cursor ?? null,
      });
      return list(page.data, { hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: page.totalCount, url: '/v1/customers' });
    }, {
      summary: 'List and search customers', tags: ['billing'],
      description: 'Free text matches name, email, description and id. Filter to the accounts that still have something live with has_subscription=true.',
      query: v.object({
        query: v.optional(v.string({ max: 160 })),
        email: v.optional(v.string({ max: 320 })),
        currency: v.optional(v.currency()),
        crm_record_id: v.optional(v.string({ max: 80 })),
        delinquent: v.optional(v.boolean()),
        has_subscription: v.optional(v.boolean()),
        limit: v.optional(v.int({ min: 1, max: 200 })),
        cursor: v.optional(v.string({ max: 200 })),
      }),
    });

    router.post('/v1/customers', (req: Req, c: Ctx) =>
      created(billingStore(c).billing.createCustomer(req.auth.orgId, req.body as CustomerInput, writeMeta(req))),
      { summary: 'Create a customer', tags: ['billing'], roles: ['member'], idempotent: true, body: customerCreateBody });

    router.get('/v1/customers/:id', (req: Req, c: Ctx) =>
      billingStore(c).billing.requireCustomer(req.auth.orgId, req.params.id),
      { summary: 'Retrieve a customer', tags: ['billing'] });

    router.patch('/v1/customers/:id', (req: Req, c: Ctx) =>
      billingStore(c).billing.updateCustomer(req.auth.orgId, req.params.id, req.body as Partial<CustomerInput>, writeMeta(req)),
      {
        summary: 'Update a customer', tags: ['billing'], roles: ['member'], body: customerUpdateBody,
        description: 'Currency can only be changed while the customer has never been billed.',
      });

    router.post('/v1/customers/:id/tax_ids/verify', (req: Req, c: Ctx) => {
      const body = req.body as { value: string; status: TaxIdVerificationStatus; verified_name?: string | null; verified_address?: string | null; note?: string | null };
      return billingStore(c).billing.verifyTaxId(req.auth.orgId, req.params.id, body, writeMeta(req));
    }, {
      summary: 'Record what the register said about a tax registration',
      tags: ['billing'], roles: ['member'],
      body: v.object({
        value: v.string({ min: 2, max: 60, description: 'The registration number already on the account.' }),
        status: v.enum(TAX_ID_VERIFICATION_STATUSES),
        verified_name: v.optional(v.string({ max: 200, description: 'The name the register holds, when it gave one back.' })),
        verified_address: v.optional(v.string({ max: 400 })),
        note: v.optional(v.string({ max: 400, description: 'Overrides the sentence the invoice prints about this registration.' })),
      }, { strict: true }),
      description:
        'A registration number is supplied by the customer; whether it is real is answered by the register that issued it. Only a `verified` number moves the tax onto the customer under the reverse charge — everything else is charged as normal, because the supplier is who the authority collects from. Point a VIES or HMRC connector at this route, or record a check a human made.',
    });

    router.del('/v1/customers/:id', (req: Req, c: Ctx) =>
      billingStore(c).billing.deleteCustomer(req.auth.orgId, req.params.id, writeMeta(req)),
      { summary: 'Delete a customer', tags: ['billing'], roles: ['admin'] });

    router.get('/v1/customers/:id/summary', (req: Req, c: Ctx) =>
      c.svc.billing.summary(req.auth.orgId, req.params.id),
      {
        summary: 'Everything about an account on one screen', tags: ['billing'],
        description: 'Subscriptions and their MRR, the balance and its ledger, lifetime value, the next invoice, open invoices and anything that needs attention.',
      });

    router.get('/v1/customers/:id/balance_transactions', (req: Req, c: Ctx) => {
      const s = billingStore(c).billing;
      s.requireCustomer(req.auth.orgId, req.params.id);
      const data = s.balanceTransactions(req.auth.orgId, req.params.id, (req.query as { limit?: number }).limit ?? 50);
      return list(data, { totalCount: data.length, url: `/v1/customers/${req.params.id}/balance_transactions` });
    }, {
      summary: 'The customer balance, as a ledger', tags: ['billing'],
      query: v.object({ limit: v.optional(v.int({ min: 1, max: 200 })) }),
    });

    router.post('/v1/customers/:id/balance_transactions', (req: Req, c: Ctx) => {
      const body = req.body as { amount: number; description: string; type: BalanceTransaction['type']; subscription?: string };
      return created(c.atomic(() => billingStore(c).billing.adjustBalance(req.auth.orgId, req.params.id, body.amount, {
        type: body.type, description: body.description, subscription: body.subscription ?? null,
      })));
    }, {
      summary: 'Credit or debit a customer', tags: ['billing'], roles: ['member'], idempotent: true, body: balanceBody,
      description: 'A negative amount grants credit that comes off the next invoice; a positive amount carries a charge forward.',
    });

    router.get('/v1/customers/:id/pending_items', (req: Req, c: Ctx) => {
      const s = billingStore(c).billing;
      s.requireCustomer(req.auth.orgId, req.params.id);
      const data = s.pendingItems(req.auth.orgId, { customer: req.params.id, status: 'pending', limit: 200 });
      return list(data, {
        totalCount: data.length,
        url: `/v1/customers/${req.params.id}/pending_items`,
      });
    }, {
      summary: 'Proration lines waiting for an invoice', tags: ['billing'],
      description: 'What the next invoice will pick up on top of the recurring charge. Each line carries the exact fraction and the breakdown behind it.',
    });

    /* ------------------------------ subscriptions ------------------------- */

    // Registered before /v1/subscriptions/:id so "overview" is never read as an id.
    router.get('/v1/subscriptions/overview', (req: Req, c: Ctx) => {
      const s = billingStore(c).billing;
      const orgId = req.auth.orgId;
      const now = c.now();
      const book = new Pricebook(c, orgId);
      const locale = localeOf(c, orgId);

      // Every subscription, not the first page of them. Read one page deep,
      // a book of 251 reported the MRR of 200 and said nothing about the rest —
      // and said it as though it were the whole number.
      const subs: Subscription[] = [];
      let cursor: string | null = null;
      do {
        const page = s.listSubscriptions(orgId, { status: 'all', limit: 200, cursor });
        subs.push(...page.data);
        cursor = page.hasMore ? page.nextCursor : null;
      } while (cursor);

      // Money is bucketed by the currency it is billed in, because minor units
      // of different currencies are different things. Adding a ¥98,000
      // subscription to a dollar book moves the dollar figure by 98,000, and
      // nothing in a single total can ever say that it did.
      const buckets = new Map<string, {
        currency: string; subscriptions: number; live: number; mrr: number; trial_mrr: number;
        renewing_next_30_days: number; scheduled_to_cancel: number;
      }>();
      const byStatus: Record<string, number> = {};
      let mrr = 0, trialMrr = 0;
      for (const sub of subs) {
        byStatus[sub.status] = (byStatus[sub.status] ?? 0) + 1;
        const bucket = buckets.get(sub.currency) ?? {
          currency: sub.currency, subscriptions: 0, live: 0, mrr: 0, trial_mrr: 0,
          renewing_next_30_days: 0, scheduled_to_cancel: 0,
        };
        bucket.subscriptions += 1;
        if (!isTerminal(sub.status)) {
          bucket.live += 1;
          if (sub.current_period_end <= now + 30 * 86_400_000) bucket.renewing_next_30_days += 1;
          if (sub.cancel_at_period_end || sub.cancel_at) bucket.scheduled_to_cancel += 1;
        }
        if (countsAsRevenue(sub.status)) {
          const amount = subscriptionMrr(sub, book);
          mrr += amount;
          bucket.mrr += amount;
        } else if (sub.status === 'trialing') {
          const amount = subscriptionMrr(sub, book);
          trialMrr += amount;
          bucket.trial_mrr += amount;
        }
        buckets.set(sub.currency, bucket);
      }

      const byCurrency = [...buckets.values()]
        .sort((a, b) => a.currency.localeCompare(b.currency))
        .map((row) => ({
          ...row,
          arr: row.mrr * 12,
          average_revenue_per_account: row.live ? Math.round(row.mrr / row.live) : 0,
          mrr_display: formatMoney(money(row.mrr, row.currency), { locale }),
          arr_display: formatMoney(money(row.mrr * 12, row.currency), { locale }),
          trial_mrr_display: formatMoney(money(row.trial_mrr, row.currency), { locale }),
        }));
      const currencies = byCurrency.map((row) => row.currency);
      const mixed = currencies.length > 1;
      const currency = s.defaultCurrency(orgId);
      const live = subs.filter((sub) => !isTerminal(sub.status));
      const invoices = s.invoices.totals(orgId);
      const prorations = c.db.all<{ currency: string; amount: number | string }>(
        `SELECT currency, COALESCE(SUM(amount), 0) AS amount FROM billing_pending_items
          WHERE org_id = ? AND status = 'pending' GROUP BY currency ORDER BY currency ASC`, orgId,
      ).map((row) => ({
        currency: String(row.currency),
        amount: Number(row.amount),
        amount_display: formatMoney(money(Number(row.amount), String(row.currency)), { locale }),
      }));
      return {
        object: 'billing_overview',
        as_of: now,
        /** The workspace's own currency. It is not a label for `mrr`. */
        currency,
        currencies,
        mixed_currency: mixed,
        subscriptions: subs.length,
        live: live.length,
        by_status: byStatus,
        /** Minor units summed across every currency billed. Read `by_currency`. */
        mrr,
        // A mixed sum is never dressed up as one currency: a figure with a $ in
        // front of it is a claim about dollars, and this one would not be true.
        mrr_display: mixed ? null : formatMoney(money(mrr, currency), { locale }),
        mrr_note: mixed
          ? `This book bills in ${currencies.join(', ')}, so mrr, arr, trial_mrr and average_revenue_per_account are every currency's minor units added together — a figure in no currency at all. by_currency is the one to read, and to show.`
          : null,
        arr: mrr * 12,
        trial_mrr: trialMrr,
        average_revenue_per_account: live.length ? Math.round(mrr / live.length) : 0,
        by_currency: byCurrency,
        customers: c.db.count(`SELECT COUNT(*) FROM billing_customers WHERE org_id = ?`, orgId),
        delinquent_customers: c.db.count(`SELECT COUNT(*) FROM billing_customers WHERE org_id = ? AND delinquent = 1`, orgId),
        renewing_next_30_days: live.filter((sub) => sub.current_period_end <= now + 30 * 86_400_000).length,
        scheduled_to_cancel: live.filter((sub) => sub.cancel_at_period_end || sub.cancel_at).length,
        // The last money figure on this payload, and it was the last one still
        // added up across every currency and published bare. A proration
        // waiting on a euro subscription is not worth what its minor units say
        // in dollars, so the flat figure is kept for the shape it has always
        // had and the buckets beside it are the ones that are amounts of
        // something — exactly what mrr and invoices above do.
        uninvoiced_prorations: prorations.reduce((total, row) => total + row.amount, 0),
        uninvoiced_prorations_by_currency: prorations,
        uninvoiced_prorations_note: prorations.length > 1
          ? `Prorations are waiting in ${prorations.map((row) => row.currency).join(', ')}, so uninvoiced_prorations is every currency's minor units added together — a figure in no currency at all. uninvoiced_prorations_by_currency is the one to read, and to show.`
          : null,
        invoices,
        // The same rule the MRR above follows: a mixed book publishes no single
        // money figure with a currency on it, and says where the real ones are.
        invoices_note: invoices.mixed_currency
          ? `Bills were raised in ${invoices.currencies.join(', ')}, so invoices.billed, collected, outstanding and written_off are every currency's minor units added together — a figure in no currency at all. invoices.by_currency is the one to read, and to show.`
          : null,
        // Bills that charged no tax, and how many of those are a figure nobody
        // decided on. `missing_tax_location` is the backlog: an account whose
        // address Ain could not place, billed at whatever it could work out.
        //
        // The sentence used to name the country and only the country, which is
        // the half of the question the hold started with. It now counts bills
        // whose country is perfectly good and whose *state* is missing in a
        // country registered state by state, and telling that finance team to
        // find an account with "no resolvable country" sends them looking at
        // the one field that is already right.
        untaxed_invoices: {
          count: invoices.untaxed,
          missing_tax_location: invoices.missing_tax_location,
          held_in_draft: invoices.held_for_tax_location,
          detail: invoices.missing_tax_location === 0
            ? 'Every bill on the book was taxed against an address Ain could place.'
            : `${invoices.missing_tax_location} bill${invoices.missing_tax_location === 1 ? ' was' : 's were'} raised for accounts whose address Ain could not place — it needs a country, and a state in a country whose tax is registered state by state — so the tax on ${invoices.missing_tax_location === 1 ? 'it' : 'them'} could not be worked out in full. Find ${invoices.missing_tax_location === 1 ? 'it' : 'them'} with GET /v1/invoices?tax=missing.`,
        },
      };
    }, {
      summary: 'The subscription book at a glance', tags: ['billing'],
      description:
        'Live count, MRR and ARR normalised across every interval, what renews in the next 30 days and what is set to cancel — over the whole book, not a page of it. Money is bucketed by the currency it is billed in; a mixed book publishes no single figure with a currency symbol on it.',
    });

    router.get('/v1/subscriptions', (req: Req, c: Ctx) => {
      const q = req.query as SubscriptionListFilter & { expand?: string };
      const page = billingStore(c).billing.listSubscriptions(req.auth.orgId, {
        ...q,
        price: q.price ? resolvePriceRef(c, req.auth.orgId, q.price) : undefined,
        cursor: q.cursor ?? null,
      });
      const expand = expandOf(req);
      return list(page.data.map((sub) => subscriptionPayload(c, req.auth.orgId, sub, expand)), {
        hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: page.totalCount, url: '/v1/subscriptions',
      });
    }, {
      summary: 'List subscriptions', tags: ['billing'],
      description: 'status=active_like covers everything still running (trialing, active, past_due, unpaid, paused). Pass expand=customer to inline the account.',
      query: v.object({
        customer: v.optional(v.id('cus')),
        status: v.optional(v.enum([...SUBSCRIPTION_STATUSES, 'active_like', 'all'] as const)),
        price: v.optional(v.string({ max: 120 })),
        collection_method: v.optional(v.enum(COLLECTION_METHODS)),
        schedule: v.optional(v.id('sub_sched')),
        query: v.optional(v.string({ max: 160 })),
        created_after: v.optional(v.timestamp()),
        created_before: v.optional(v.timestamp()),
        limit: v.optional(v.int({ min: 1, max: 200 })),
        cursor: v.optional(v.string({ max: 200 })),
        expand: v.optional(v.string({ max: 120 })),
      }),
    });

    router.post('/v1/subscriptions', (req: Req, c: Ctx) => {
      const body = req.body as SubscriptionCreateInput;
      const sub = billingStore(c).billing.createSubscription(req.auth.orgId, {
        ...body,
        items: mapItemPrices(c, req.auth.orgId, body.items) ?? body.items,
      }, writeMeta(req));
      return created(subscriptionPayload(c, req.auth.orgId, sub, expandOf(req)));
    }, {
      summary: 'Create a subscription', tags: ['billing'], roles: ['member'], idempotent: true,
      description:
        'Items may name a price id or a lookup key. The billing cycle anchor fixes the day of the month every future period lands on, so an anchor on the 31st bills the 28th in February and returns to the 31st in March. Naming the day (billing_cycle_anchor_day: 15) and naming the instant (billing_cycle_anchor: 15 Jan) are the same request: either way the first period runs from the start date to that day and is charged for exactly the days it covers.',
      body: subscriptionCreateBody,
    });

    router.get('/v1/subscriptions/:id', (req: Req, c: Ctx) =>
      subscriptionPayload(c, req.auth.orgId, billingStore(c).billing.requireSubscription(req.auth.orgId, req.params.id), expandOf(req)),
      { summary: 'Retrieve a subscription', tags: ['billing'] });

    router.patch('/v1/subscriptions/:id', (req: Req, c: Ctx) => {
      const body = req.body as SubscriptionUpdateInput;
      const result = billingStore(c).billing.updateSubscription(req.auth.orgId, req.params.id, {
        ...body,
        items: mapItemPrices(c, req.auth.orgId, body.items),
      }, writeMeta(req));
      return { ...subscriptionPayload(c, req.auth.orgId, result.subscription, expandOf(req)), proration: result.preview };
    }, {
      summary: 'Change a subscription', tags: ['billing'], roles: ['member'], body: subscriptionUpdateBody,
      description:
        'Runs the same arithmetic as POST /v1/subscriptions/:id/preview and returns the proration it settled, so what you previewed is what you were charged. Moving the items onto prices that bill on another interval moves the subscription onto that interval and restarts the cycle here — an annual price never runs on a monthly cadence. Send billing_cycle_anchor=unchanged to be told rather than moved.',
    });

    router.del('/v1/subscriptions/:id', (req: Req, c: Ctx) =>
      subscriptionPayload(c, req.auth.orgId, billingStore(c).billing.cancelSubscription(req.auth.orgId, req.params.id, {}, writeMeta(req)), []),
      { summary: 'Cancel a subscription immediately', tags: ['billing'], roles: ['member'] });

    router.post('/v1/subscriptions/:id/preview', (req: Req, c: Ctx) =>
      billingStore(c).billing.previewSubscriptionChange(req.auth.orgId, req.params.id, {
        ...(req.body as SubscriptionUpdateInput),
        items: mapItemPrices(c, req.auth.orgId, (req.body as SubscriptionUpdateInput).items),
      }),
      {
        summary: 'Preview a change before making it', tags: ['billing'], body: previewBody,
        description:
          'Returns the exact proration lines the change would produce, what would be collected now, what the next invoice becomes and how MRR moves. Send no body to preview the next invoice as things stand.',
      });

    router.post('/v1/subscriptions/:id/cancel', (req: Req, c: Ctx) => {
      const body = req.body as { at_period_end?: boolean; cancel_at?: number; prorate?: boolean; cancellation_reason?: never; comment?: string };
      return subscriptionPayload(c, req.auth.orgId,
        billingStore(c).billing.cancelSubscription(req.auth.orgId, req.params.id, body, writeMeta(req)), []);
    }, {
      summary: 'Cancel a subscription', tags: ['billing'], roles: ['member'], body: cancelBody,
      description:
        'Immediately by default. at_period_end lets it run to the end of the paid period; cancel_at ends it on a date. prorate=true gives back the unused remainder as account credit — a cancellation never becomes a payment.',
    });

    router.post('/v1/subscriptions/:id/pause', (req: Req, c: Ctx) =>
      subscriptionPayload(c, req.auth.orgId,
        billingStore(c).billing.pauseSubscription(req.auth.orgId, req.params.id, req.body as { behavior: 'keep_as_draft'; resumes_at?: number }, writeMeta(req)), []),
      {
        summary: 'Pause collection', tags: ['billing'], roles: ['member'], body: pauseBody,
        description: 'The cycle keeps advancing; invoices are held as drafts, marked uncollectible or voided according to the behaviour. Set resumes_at to un-pause automatically.',
      });

    router.post('/v1/subscriptions/:id/resume', (req: Req, c: Ctx) =>
      subscriptionPayload(c, req.auth.orgId,
        billingStore(c).billing.resumeSubscription(req.auth.orgId, req.params.id, req.body as { billing_cycle_anchor?: 'now' }, writeMeta(req)), []),
      {
        summary: 'Resume a paused subscription', tags: ['billing'], roles: ['member'], body: resumeBody,
        description: 'billing_cycle_anchor=now restarts the cycle from today instead of picking up the old one.',
      });

    router.get('/v1/subscriptions/:id/periods', (req: Req, c: Ctx) => {
      const s = billingStore(c).billing;
      s.requireSubscription(req.auth.orgId, req.params.id);
      const data = s.periods(req.auth.orgId, { subscription: req.params.id, limit: 500 });
      return list(data, { totalCount: data.length, url: `/v1/subscriptions/${req.params.id}/periods` });
    }, {
      summary: 'Every period this subscription has entered', tags: ['billing'],
      description: 'The recurring amount recognised for each period, whether or not an invoice has been raised for it yet.',
    });

    /* --------------------------------- invoices --------------------------- */

    // Registered before /v1/invoices/:id so "create_preview" is never an id.
    router.post('/v1/invoices/create_preview', (req: Req, c: Ctx) => {
      const body = req.body as { subscription: string } & SubscriptionUpdateInput;
      return invoicePayload(c, req.auth.orgId, billingStore(c).billing.previewInvoice(req.auth.orgId, body.subscription, {
        items: mapItemPrices(c, req.auth.orgId, body.items),
        proration_behavior: body.proration_behavior,
        proration_date: body.proration_date,
        billing_cycle_anchor: body.billing_cycle_anchor,
      }));
    }, {
      summary: 'Preview the next invoice, as it is or after a change', tags: ['billing'], body: invoicePreviewBody,
      description:
        'The upcoming bill as a real invoice: the recurring fee for the period that begins when this one ends, every proration still waiting, and the account balance drawn down. Send items to see what a change would do to it — the same arithmetic POST /v1/subscriptions/:id/preview runs, arranged as the document the customer receives. Pass the same proration_date to the preview and to the change and the numbers are identical.',
    });

    router.get('/v1/invoices', (req: Req, c: Ctx) => {
      const q = req.query as InvoiceListFilter;
      const page = billingStore(c).billing.invoices.list(req.auth.orgId, { ...q, cursor: q.cursor ?? null });
      return list(page.data.map((invoice) => invoicePayload(c, req.auth.orgId, invoice)), {
        hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: page.totalCount, url: '/v1/invoices',
      });
    }, {
      summary: 'List invoices', tags: ['billing'],
      description:
        'status=open_like is everything still owed — drafts held back by a paused subscription and finalised bills alike. due_before finds what is overdue. tax=missing is the other queue: bills still standing for an account whose address Ain could not place — no country, or no state in a country whose tax is registered state by state — where the figure means "we never learned where they are" rather than "nothing is due".',
      query: v.object({
        customer: v.optional(v.id('cus')),
        subscription: v.optional(v.id('sub')),
        status: v.optional(v.enum([...INVOICE_STATUSES, 'open_like', 'all'] as const)),
        billing_reason: v.optional(v.enum(INVOICE_BILLING_REASONS)),
        collection_method: v.optional(v.enum(COLLECTION_METHODS)),
        tax: v.optional(v.enum(INVOICE_TAX_FILTERS)),
        query: v.optional(v.string({ max: 160 })),
        created_after: v.optional(v.timestamp()),
        created_before: v.optional(v.timestamp()),
        due_before: v.optional(v.timestamp()),
        limit: v.optional(v.int({ min: 1, max: 200 })),
        cursor: v.optional(v.string({ max: 200 })),
      }),
    });

    router.post('/v1/invoices', (req: Req, c: Ctx) => {
      const body = req.body as { customer: string; subscription?: string };
      return created(invoicePayload(c, req.auth.orgId,
        billingStore(c).billing.invoiceNow(req.auth.orgId, body.customer, {
          subscription: body.subscription ?? null, meta: writeMeta(req),
        })));
    }, {
      summary: 'Bill what this account already owes', tags: ['billing'], roles: ['member'], idempotent: true,
      description:
        'Sweeps up every proration waiting, the usage the credits module has settled and any credit packs bought, applies the balance and finalises the bill. The recurring fee is not billed again — that happened when the period opened — so this can never double-charge a cycle.',
      body: v.object({ customer: v.id('cus'), subscription: v.optional(v.id('sub')) }, { strict: true }),
    });

    router.get('/v1/invoices/:id', (req: Req, c: Ctx) =>
      invoicePayload(c, req.auth.orgId, billingStore(c).billing.invoices.require(req.auth.orgId, req.params.id)),
      {
        summary: 'Retrieve an invoice', tags: ['billing'],
        description: 'Every line carries the window it covers and the sentence that reconstructs its number, so any figure on the bill can be explained without opening the code.',
      });

    router.post('/v1/invoices/:id/finalize', (req: Req, c: Ctx) =>
      invoicePayload(c, req.auth.orgId, c.atomic(() =>
        billingStore(c).billing.invoices.finalize(req.auth.orgId, req.params.id, writeMeta(req)))),
      {
        summary: 'Finalise a draft invoice', tags: ['billing'], roles: ['member'],
        description: 'Turns a draft — one held back while collection was paused — into an open bill with a due date.',
      });

    router.post('/v1/invoices/:id/pay', (req: Req, c: Ctx) => {
      const body = req.body as { note?: string };
      return invoicePayload(c, req.auth.orgId, c.atomic(() =>
        billingStore(c).billing.invoices.pay(req.auth.orgId, req.params.id, { note: body.note ?? null }, writeMeta(req))));
    }, {
      summary: 'Record payment of an invoice', tags: ['billing'], roles: ['member'], idempotent: true,
      body: v.object({ note: v.optional(v.string({ max: 300, description: 'How it was collected — bank transfer, card, offset against a PO.' })) }, { strict: true }),
      description: 'A subscription that was past due or unpaid comes back to active on the invoice that clears it.',
    });

    router.post('/v1/invoices/:id/void', (req: Req, c: Ctx) =>
      invoicePayload(c, req.auth.orgId, c.atomic(() =>
        billingStore(c).billing.invoices.voidInvoice(req.auth.orgId, req.params.id, writeMeta(req)))),
      {
        summary: 'Withdraw an invoice that should not have been sent', tags: ['billing'], roles: ['member'],
        description: 'The prorations it claimed go back to waiting and any balance it drew down is returned, so the next invoice bills them properly. A paid invoice cannot be voided — credit it with POST /v1/credit_notes instead.',
      });

    router.post('/v1/invoices/:id/mark_uncollectible', (req: Req, c: Ctx) =>
      invoicePayload(c, req.auth.orgId, c.atomic(() =>
        billingStore(c).billing.invoices.markUncollectible(req.auth.orgId, req.params.id, writeMeta(req)))),
      {
        summary: 'Write an invoice off', tags: ['billing'], roles: ['member'],
        description: 'The bill stands and still counts as billed; it is simply not going to be collected. The subscription moves to unpaid.',
      });


    router.get('/v1/invoices/:id/render', (req: Req, c: Ctx) => {
      const store = billingStore(c).billing;
      const invoice = store.invoices.require(req.auth.orgId, req.params.id);
      return httpStatus(200, renderInvoice(c, req.auth.orgId, store, invoice), {
        'content-type': 'text/html; charset=utf-8',
      });
    }, {
      summary: 'The invoice as a printable document', tags: ['billing'],
      description:
        'One self-contained HTML page — no stylesheet to fetch, no script to run — with the issuer and bill-to blocks, every line with the window it covers and its per-tier breakdown, the tax grouped by rate with the reason behind every zero, the totals, any credit notes raised against it and how to pay. This is what a finance team sends a customer.',
    });

    /* ------------------------------ credit notes -------------------------- */

    // Registered before /v1/credit_notes/:id so "preview" is never read as an id.
    router.post('/v1/credit_notes/preview', (req: Req, c: Ctx) =>
      creditNotePayload(c, req.auth.orgId, billingStore(c).billing.creditNotes.preview(req.auth.orgId, req.body as CreditNoteInput)),
      {
        summary: 'Price a credit note without writing one', tags: ['billing'],
        body: creditNoteBody,
        description:
          'The same arithmetic POST /v1/credit_notes runs, with nothing written — including the refusal, so an over-credit is a 400 here too rather than a surprise at the moment of issue.',
      });

    router.get('/v1/credit_notes', (req: Req, c: Ctx) => {
      const q = req.query as CreditNoteListFilter;
      const page = billingStore(c).billing.creditNotes.list(req.auth.orgId, { ...q, cursor: q.cursor ?? null });
      return list(page.data.map((note) => creditNotePayload(c, req.auth.orgId, note)), {
        hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: page.totalCount, url: '/v1/credit_notes',
      });
    }, {
      summary: 'List credit notes', tags: ['billing'],
      description: 'Every reduction ever made to a finalised invoice, newest first. Filter by invoice or by customer.',
      query: v.object({
        invoice: v.optional(v.id('in')),
        customer: v.optional(v.id('cus')),
        status: v.optional(v.enum(['issued', 'void', 'all'] as const)),
        limit: v.optional(v.int({ min: 1, max: 200 })),
        cursor: v.optional(v.string({ max: 200 })),
      }),
    });

    router.post('/v1/credit_notes', (req: Req, c: Ctx) =>
      created(creditNotePayload(c, req.auth.orgId,
        billingStore(c).billing.creditNotes.issue(req.auth.orgId, req.body as CreditNoteInput, writeMeta(req)))),
      {
        summary: 'Credit a finalised invoice', tags: ['billing'], roles: ['member'], idempotent: true,
        body: creditNoteBody,
        description:
          'Name an amount to spread across the invoice, or name the lines to reduce. On a bill that has not been collected the credit comes off amount_due; on one already paid it goes onto the customer balance and comes off the next invoice. Tax is reversed in the proportion the line was billed in. A note that would credit more than the invoice has left is refused, never clamped.',
      });

    router.get('/v1/credit_notes/:id', (req: Req, c: Ctx) =>
      creditNotePayload(c, req.auth.orgId, billingStore(c).billing.creditNotes.require(req.auth.orgId, req.params.id)),
      { summary: 'Retrieve a credit note', tags: ['billing'] });

    router.post('/v1/credit_notes/:id/void', (req: Req, c: Ctx) =>
      creditNotePayload(c, req.auth.orgId,
        billingStore(c).billing.creditNotes.void(req.auth.orgId, req.params.id, writeMeta(req))),
      {
        summary: 'Withdraw a credit note', tags: ['billing'], roles: ['member'],
        description: 'Puts back exactly what the note took: the amount returns to amount_due, or comes back off the balance it was pushed onto, and an invoice the note had settled goes back to open.',
      });

    /* ----------------------------- automatic tax -------------------------- */

    router.get('/v1/billing/automatic_tax', (req: Req, c: Ctx) =>
      automaticTaxPayload(c, req.auth.orgId),
      {
        summary: 'Whether bills are held back over a customer location Ain cannot resolve', tags: ['billing'],
        description:
          'On, an invoice for an account whose address Ain cannot place — no country, or no state in a country whose tax is registered state by state — is kept as a draft and POST /v1/invoices/:id/finalize answers customer_tax_location_invalid, because a short figure there means "we do not know" and the supplier is who the authority collects from. Off, the bill finalises anyway — the status is still computed, still counted on the overview and still findable with GET /v1/invoices?tax=missing.',
      });

    router.post('/v1/billing/automatic_tax', (req: Req, c: Ctx) => {
      const body = req.body as { enabled: boolean };
      c.atomic(() => c.svc.core.setSetting(req.auth.orgId, 'billing.automatic_tax', { enabled: body.enabled }));
      return automaticTaxPayload(c, req.auth.orgId);
    }, {
      summary: 'Turn the tax-location hold on or off', tags: ['billing'], roles: ['admin'],
      body: v.object({ enabled: v.boolean() }, { strict: true }),
      description:
        'Turning it off does not turn tax off: every bill is still taxed from the address, and every bill that could not be is still marked. It only stops those bills being held as drafts.',
    });

    /* -------------------------------- tax rates --------------------------- */

    router.get('/v1/tax_rates', (req: Req, c: Ctx) => {
      const q = req.query as { country?: string; active?: boolean; limit?: number };
      const rates = new TaxRates(c, req.auth.orgId);
      const data = rates.list(q);
      // The page is bounded at 500; the register is not. A workspace that has
      // registered its US districts has thousands, and a count taken from the
      // page would report the bound back as the size of the book.
      const totalCount = rates.count(q);
      return list(data.map(taxRatePayload), { totalCount, hasMore: data.length < totalCount, url: '/v1/tax_rates' });
    }, {
      summary: 'Where this workspace is registered to collect tax', tags: ['billing'],
      description:
        'A customer address is matched against every one of these, and owes the sum of all that match: a supply into Manhattan is in the state, the city and the transit district at once, so the bill carries a row for each and charges 4% + 4.5% + 0.375%. Country-wide rates match every address in the country and stack under the state ones. An address that matches nothing is charged nothing, and the invoice says so.',
      query: v.object({
        country: v.optional(v.string({ min: 2, max: 2 })),
        active: v.optional(v.boolean()),
        limit: v.optional(v.int({ min: 1, max: 500 })),
      }),
    });

    router.post('/v1/tax_rates', (req: Req, c: Ctx) =>
      created(taxRatePayload(c.atomic(() => new TaxRates(c, req.auth.orgId).create(req.body as TaxRateInput, c.now())))),
      {
        summary: 'Register a tax rate', tags: ['billing'], roles: ['admin'], idempotent: true, body: taxRateBody,
        description:
          'One active rate per jurisdiction, named by `jurisdiction`: registering the same one twice over an address would charge it twice and is refused, while a genuinely different jurisdiction over the same address stacks with it and both are charged. The percentage is stored as an exact decimal string and snapshotted onto every line it touches, which is why retiring a rate never changes an invoice already raised under it.',
      });

    router.get('/v1/tax_rates/:id', (req: Req, c: Ctx) =>
      taxRatePayload(new TaxRates(c, req.auth.orgId).require(req.params.id)),
      { summary: 'Retrieve a tax rate', tags: ['billing'] });

    router.post('/v1/tax_rates/:id/deactivate', (req: Req, c: Ctx) =>
      taxRatePayload(c.atomic(() => new TaxRates(c, req.auth.orgId).setActive(req.params.id, false, c.now()))),
      {
        summary: 'Retire a tax rate', tags: ['billing'], roles: ['admin'],
        description: 'Stops the rate matching new invoices. Every invoice already raised under it keeps its own snapshot and still explains itself.',
      });

    /* -------------------------------- schedules --------------------------- */

    router.get('/v1/subscription-schedules', (req: Req, c: Ctx) => {
      const q = req.query as ScheduleListFilter;
      const page = billingStore(c).schedules.list(req.auth.orgId, { ...q, cursor: q.cursor ?? null });
      return list(page.data.map((schedule) => schedulePayload(c, req.auth.orgId, schedule)), {
        hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: page.totalCount, url: '/v1/subscription-schedules',
      });
    }, {
      summary: 'List subscription schedules', tags: ['billing'],
      query: v.object({
        customer: v.optional(v.id('cus')),
        subscription: v.optional(v.id('sub')),
        status: v.optional(v.enum([...SCHEDULE_STATUSES, 'all'] as const)),
        limit: v.optional(v.int({ min: 1, max: 100 })),
        cursor: v.optional(v.string({ max: 200 })),
      }),
    });

    router.post('/v1/subscription-schedules', (req: Req, c: Ctx) => {
      const body = req.body as ScheduleCreateInput;
      const schedule = billingStore(c).schedules.create(req.auth.orgId, {
        ...body,
        phases: body.phases.map((phase) => ({
          ...phase,
          items: phase.items.map((item) => ({ ...item, price: resolvePriceRef(c, req.auth.orgId, item.price) })),
        })),
      }, writeMeta(req));
      return created(schedulePayload(c, req.auth.orgId, schedule));
    }, {
      summary: 'Create a subscription schedule', tags: ['billing'], roles: ['member'], idempotent: true,
      description:
        'Phases run back to back. Size a phase with iterations (billing intervals) or an end_date; the last phase may leave both out and runs one interval. end_behavior decides what happens after the final phase.',
      body: scheduleCreateBody,
    });

    router.get('/v1/subscription-schedules/:id', (req: Req, c: Ctx) =>
      schedulePayload(c, req.auth.orgId, billingStore(c).schedules.require(req.auth.orgId, req.params.id)),
      { summary: 'Retrieve a subscription schedule', tags: ['billing'] });

    router.patch('/v1/subscription-schedules/:id', (req: Req, c: Ctx) => {
      const body = req.body as ScheduleUpdateInput;
      const schedule = billingStore(c).schedules.update(req.auth.orgId, req.params.id, {
        ...body,
        phases: body.phases?.map((phase) => ({
          ...phase,
          items: phase.items.map((item) => ({ ...item, price: resolvePriceRef(c, req.auth.orgId, item.price) })),
        })),
      }, writeMeta(req));
      return schedulePayload(c, req.auth.orgId, schedule);
    }, {
      summary: 'Rewrite the phases still to come', tags: ['billing'], roles: ['member'], body: scheduleUpdateBody,
      description: 'Phases already started are kept; the replacement phases pick up from where the current one ends.',
    });

    router.post('/v1/subscription-schedules/:id/release', (req: Req, c: Ctx) =>
      schedulePayload(c, req.auth.orgId, billingStore(c).schedules.release(req.auth.orgId, req.params.id, writeMeta(req))),
      {
        summary: 'Release the subscription from its schedule', tags: ['billing'], roles: ['member'],
        description: 'The subscription carries on exactly as it is; only the future phases are dropped.',
      });

    router.post('/v1/subscription-schedules/:id/cancel', (req: Req, c: Ctx) =>
      schedulePayload(c, req.auth.orgId, billingStore(c).schedules.cancel(req.auth.orgId, req.params.id, req.body as { prorate?: boolean }, writeMeta(req))),
      {
        summary: 'Cancel the schedule and its subscription', tags: ['billing'], roles: ['member'],
        body: v.object({ prorate: v.optional(v.boolean()) }, { strict: true }),
      });

  },

  tools(ctx) {
    const locale = () => localeOf(ctx, ctx.config.defaultOrgId);
    const displayMoney = (amount: number, currency: string) => formatMoney(money(amount, currency), { locale: locale() });

    return [
      {
        name: 'billing_find_customer',
        description:
          'Find billing customers by company name, email or id. Returns their currency, balance, delinquency and how many subscriptions they have. Start here before quoting or changing anything.',
        readOnly: true,
        tags: ['billing', 'revenue'],
        input: v.object({
          query: v.string({ min: 1, max: 160 }),
          limit: v.optional(v.int({ min: 1, max: 25 })),
        }),
        run(args: { query: string; limit?: number }, c: Ctx, meta) {
          const s = billingStore(c).billing;
          return s.listCustomers(meta.orgId, { query: args.query, limit: args.limit ?? 10 }).data.map((customer) => ({
            id: customer.id,
            name: customer.name,
            email: customer.email,
            currency: customer.currency,
            balance: customer.balance,
            balance_display: displayMoney(customer.balance, customer.currency),
            delinquent: customer.delinquent,
            crm_record_id: customer.crm_record_id,
            subscriptions: c.db.count(
              `SELECT COUNT(*) FROM billing_subscriptions WHERE org_id = ? AND customer_id = ? AND status NOT IN ('canceled','incomplete_expired')`,
              meta.orgId, customer.id,
            ),
          }));
        },
      },
      {
        name: 'billing_customer_summary',
        description:
          'The full billing picture for one customer: every subscription and its MRR, the balance and why it is what it is, lifetime value, the next invoice and anything that needs attention.',
        readOnly: true,
        tags: ['billing', 'revenue', 'support'],
        input: v.object({ customer: v.string({ min: 3, max: 80 }) }),
        run(args: { customer: string }, c: Ctx, meta) {
          return c.svc.billing.summary(meta.orgId, args.customer);
        },
      },
      {
        name: 'billing_list_subscriptions',
        description:
          'List subscriptions, optionally filtered by customer, status or the price they are on. Use it to answer "who is on Growth?" or "what is past due?".',
        readOnly: true,
        tags: ['billing', 'revenue'],
        input: v.object({
          customer: v.optional(v.string({ max: 80 })),
          status: v.optional(v.enum([...SUBSCRIPTION_STATUSES, 'active_like', 'all'] as const)),
          price: v.optional(v.string({ max: 120, description: 'A price id or lookup key such as growth_monthly.' })),
          limit: v.optional(v.int({ min: 1, max: 50 })),
        }),
        run(args: { customer?: string; status?: SubscriptionStatus | 'active_like' | 'all'; price?: string; limit?: number }, c: Ctx, meta) {
          const s = billingStore(c).billing;
          const book = new Pricebook(c, meta.orgId);
          const page = s.listSubscriptions(meta.orgId, {
            customer: args.customer,
            status: args.status ?? 'active_like',
            price: args.price ? resolvePriceRef(c, meta.orgId, args.price) : undefined,
            limit: args.limit ?? 20,
          });
          return {
            total: page.totalCount,
            subscriptions: page.data.map((sub) => ({
              id: sub.id,
              customer: sub.customer,
              customer_name: s.customer(meta.orgId, sub.customer)?.name ?? null,
              status: sub.status,
              status_detail: describeStatus(sub.status),
              items: sub.items.map((item) => `${item.quantity} x ${book.label(book.price(item.price))}`),
              mrr_display: displayMoney(countsAsRevenue(sub.status) ? subscriptionMrr(sub, book) : 0, sub.currency),
              current_period_end: longDate(sub.current_period_end, locale()),
              cancel_at_period_end: sub.cancel_at_period_end,
            })),
          };
        },
      },
      {
        name: 'billing_list_invoices',
        description:
          'List invoices — the whole book, one account, or only what is still owed. Use status=open_like to answer "what is outstanding?" and due_before to answer "what is overdue?".',
        readOnly: true,
        tags: ['billing', 'revenue', 'support'],
        input: v.object({
          customer: v.optional(v.string({ max: 80 })),
          subscription: v.optional(v.id('sub')),
          status: v.optional(v.enum([...INVOICE_STATUSES, 'open_like', 'all'] as const)),
          due_before: v.optional(v.timestamp()),
          limit: v.optional(v.int({ min: 1, max: 50 })),
        }),
        run(args: { customer?: string; subscription?: string; status?: InvoiceStatus | 'open_like' | 'all'; due_before?: number; limit?: number }, c: Ctx, meta) {
          const s = billingStore(c).billing;
          const page = s.invoices.list(meta.orgId, { ...args, limit: args.limit ?? 20 });
          // Bucketed by the currency each bill was raised in, for the reason the
          // overview's mrr and invoices figures are. Adding the minor units up
          // and stamping the first row's symbol on the answer is how "what is
          // outstanding?" came back as $135,967.00 on a book owed $133,400.00,
          // €1,007.00 and £1,560.00 — a dollar figure that is not dollars, read
          // out loud to whoever asked. Every currency is named instead, so the
          // sentence the copilot writes is true whatever the page holds.
          const owed = new Map<string, number>();
          for (const invoice of page.data) {
            owed.set(invoice.currency, (owed.get(invoice.currency) ?? 0) + invoice.amount_due);
          }
          const outstanding = [...owed.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([currency, amount]) => ({ currency, amount, amount_display: displayMoney(amount, currency) }));
          const shown = outstanding.length
            ? outstanding.map((row) => row.amount_display)
            : [displayMoney(0, s.defaultCurrency(meta.orgId))];
          return {
            total: page.totalCount,
            outstanding_by_currency: outstanding,
            outstanding_display: shown.length === 1
              ? shown[0]
              : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`,
            outstanding_note: outstanding.length > 1
              ? `These bills were raised in ${outstanding.map((row) => row.currency).join(', ')}. Minor units of different currencies are not the same thing, so there is no single figure to quote — read outstanding_by_currency, and name each currency.`
              : null,
            invoices: page.data.map((invoice) => ({
              id: invoice.id,
              number: invoice.number,
              customer: invoice.customer,
              customer_name: s.customer(meta.orgId, invoice.customer)?.name ?? null,
              status: invoice.status,
              total_display: displayMoney(invoice.total, invoice.currency),
              amount_due_display: displayMoney(invoice.amount_due, invoice.currency),
              due: invoice.due_date === null ? 'on receipt' : longDate(invoice.due_date, locale()),
              billing_reason: invoice.billing_reason,
            })),
          };
        },
      },
      {
        name: 'billing_explain_invoice',
        description:
          'Read one invoice line by line, with the sentence behind every number — what period it covers, what fraction of it was billed and how the account balance was applied. This is the tool for "why is this bill what it is?".',
        readOnly: true,
        tags: ['billing', 'revenue', 'support'],
        input: v.object({ invoice: v.id('in') }),
        run(args: { invoice: string }, c: Ctx, meta) {
          const s = billingStore(c).billing;
          const invoice = s.invoices.require(meta.orgId, args.invoice);
          const show = (amount: number) => displayMoney(amount, invoice.currency);
          return {
            number: invoice.number,
            customer_name: s.customer(meta.orgId, invoice.customer)?.name ?? null,
            status: invoice.status,
            covers: `${longDate(invoice.period.start, locale())} to ${longDate(invoice.period.end, locale())}`,
            lines: invoice.lines.map((line) => ({
              description: line.description,
              amount_display: show(line.amount),
              proration: line.proration,
              why: line.explanation,
            })),
            subtotal_display: show(invoice.subtotal),
            tax_display: show(invoice.tax),
            taxes: invoice.total_taxes.map((row) => ({
              display_name: row.display_name,
              percentage: `${row.percentage}%`,
              jurisdiction: row.jurisdiction,
              amount_display: show(row.amount),
              why: row.explanation,
            })),
            balance_applied_display: show(invoice.balance_applied),
            total_display: show(invoice.total),
            // Why a bill is a draft is part of why it is what it is, and it is
            // the one answer that is not on the lines.
            automatic_tax: invoice.automatic_tax,
            status_detail: describeInvoiceStatus(invoice, locale()),
            // The same predicate the payload publishes, not a second reading of
            // it: an `adds_up: true` that checks fewer identities than
            // `assertBalanced` is a copilot telling a customer a bill is sound
            // on the strength of a question nobody asked it.
            adds_up: invoiceAddsUp(invoice),
          };
        },
      },
      {
        name: 'billing_upcoming_invoice',
        description:
          'The next bill a subscription will receive, before it is raised: the recurring fee for the coming period, every proration still waiting and the account credit that will come off it. Optionally shows what a change to the items would do to that bill.',
        readOnly: true,
        tags: ['billing', 'revenue'],
        input: v.object({
          subscription: v.id('sub'),
          items: v.optional(v.array(v.object({
            id: v.optional(v.id('si')),
            price: v.optional(v.string({ max: 120 })),
            quantity: v.optional(v.int({ min: 0, max: 1_000_000 })),
            deleted: v.optional(v.boolean()),
          }), { max: 30 })),
        }),
        run(args: { subscription: string; items?: { id?: string; price?: string; quantity?: number; deleted?: boolean }[] }, c: Ctx, meta) {
          const invoice = billingStore(c).billing.previewInvoice(meta.orgId, args.subscription, {
            items: mapItemPrices(c, meta.orgId, args.items),
          });
          const show = (amount: number) => displayMoney(amount, invoice.currency);
          return {
            due: longDate(invoice.period.start, locale()),
            covers: `${longDate(invoice.period.start, locale())} to ${longDate(invoice.period.end, locale())}`,
            lines: invoice.lines.map((line) => `${line.description}: ${show(line.amount)}`),
            subtotal_display: show(invoice.subtotal),
            // Without these the answer had a hole in it exactly the size of the
            // tax: $100.00 of lines, no balance applied, and a $108.88 total the
            // copilot had to explain with something it had made up. Every rate
            // that will be charged is named, because "why is it 108.88?" is the
            // question this tool exists to answer.
            tax_display: show(invoice.tax),
            taxes: invoice.total_taxes.map((row) =>
              `${row.display_name} ${row.percentage}% (${row.jurisdiction}): ${show(row.amount)}`),
            // Whether this bill can be sent at all. Reading out "their next
            // bill is $499.00" for an account Ain cannot place is a total
            // nobody will be asked to pay: that bill is held as a draft until
            // a country is on the record.
            automatic_tax: invoice.automatic_tax,
            balance_applied_display: show(invoice.balance_applied),
            total_display: show(invoice.total),
            // The same predicate the invoice payload publishes, for the reason
            // `invoiceAddsUp` gives: a shorter copy of it goes on answering
            // "adds up" for a bill whose jurisdictions do not.
            adds_up: invoiceAddsUp(invoice),
          };
        },
      },
      {
        name: 'billing_preview_subscription_change',
        description:
          'Work out exactly what changing a subscription would cost or credit, without changing anything. Shows the unused-time credit, the remaining-time charge, the exact fraction of the period behind each, how MRR moves, and — when the new prices bill on another interval — the cadence the subscription would move onto. Always run this before billing_update_subscription.',
        readOnly: true,
        tags: ['billing', 'revenue'],
        input: v.object({
          subscription: v.id('sub'),
          items: v.array(v.object({
            id: v.optional(v.id('si')),
            price: v.optional(v.string({ max: 120 })),
            quantity: v.optional(v.int({ min: 0, max: 1_000_000 })),
            custom_unit_amount: v.optional(v.int({ min: 0 })),
            deleted: v.optional(v.boolean()),
          }), { max: 30 }),
          proration_behavior: v.optional(v.enum(PRORATION_BEHAVIORS)),
          proration_date: v.optional(v.timestamp()),
        }),
        run(args: { subscription: string; items: { id?: string; price?: string; quantity?: number; custom_unit_amount?: number; deleted?: boolean }[]; proration_behavior?: ProrationBehavior; proration_date?: number }, c: Ctx, meta) {
          const preview = billingStore(c).billing.previewSubscriptionChange(meta.orgId, args.subscription, {
            items: mapItemPrices(c, meta.orgId, args.items),
            proration_behavior: args.proration_behavior,
            proration_date: args.proration_date,
          });
          return {
            ...preview,
            credit_display: displayMoney(preview.credit_total, preview.currency),
            charge_display: displayMoney(preview.charge_total, preview.currency),
            net_display: displayMoney(preview.net, preview.currency),
            mrr_delta_display: displayMoney(preview.mrr_delta, preview.currency),
            cadence_display: `every ${describeCadence(preview.interval_before)} → every ${describeCadence(preview.interval_after)}`,
          };
        },
      },
      {
        name: 'billing_update_subscription',
        description:
          'Apply a change to a subscription — swap the plan, change a quantity, add or remove an item — and settle the proration. Swapping in a price that bills on another interval moves the whole subscription onto that interval and restarts the cycle from today. Preview it first; this charges real money.',
        readOnly: false,
        requiresApproval: true,
        tags: ['billing', 'revenue'],
        input: v.object({
          subscription: v.id('sub'),
          items: v.array(v.object({
            id: v.optional(v.id('si')),
            price: v.optional(v.string({ max: 120 })),
            quantity: v.optional(v.int({ min: 0, max: 1_000_000 })),
            custom_unit_amount: v.optional(v.int({ min: 0 })),
            deleted: v.optional(v.boolean()),
          }), { min: 1, max: 30 }),
          proration_behavior: v.optional(v.enum(PRORATION_BEHAVIORS)),
        }),
        run(args: { subscription: string; items: { id?: string; price?: string; quantity?: number; custom_unit_amount?: number; deleted?: boolean }[]; proration_behavior?: ProrationBehavior }, c: Ctx, meta) {
          const result = billingStore(c).billing.updateSubscription(meta.orgId, args.subscription, {
            items: mapItemPrices(c, meta.orgId, args.items),
            proration_behavior: args.proration_behavior,
          }, { actorId: meta.actorId, actorType: 'agent' });
          return {
            subscription: result.subscription,
            settled: {
              net: result.preview.net,
              net_display: displayMoney(result.preview.net, result.preview.currency),
              amount_due_now: result.preview.amount_due_now,
              lines: result.preview.lines.map((line) => `${line.description}: ${displayMoney(line.amount, line.currency)}`),
            },
            billing_cycle: {
              before: `every ${describeCadence(result.preview.interval_before)}`,
              after: `every ${describeCadence(result.preview.interval_after)}`,
              current_period_end: longDate(result.subscription.current_period_end, localeOf(c, meta.orgId)),
            },
            notices: result.preview.notices,
          };
        },
      },
      {
        name: 'billing_cancel_subscription',
        description:
          'Cancel a subscription now or at the end of the paid period. Cancelling now with prorate=true returns the unused remainder as account credit rather than a refund.',
        readOnly: false,
        requiresApproval: true,
        tags: ['billing', 'revenue'],
        input: v.object({
          subscription: v.id('sub'),
          at_period_end: v.optional(v.boolean()),
          prorate: v.optional(v.boolean()),
          cancellation_reason: v.optional(v.enum(CANCELLATION_REASONS)),
          comment: v.optional(v.string({ max: 500 })),
        }),
        run(args: { subscription: string; at_period_end?: boolean; prorate?: boolean; cancellation_reason?: never; comment?: string }, c: Ctx, meta) {
          const sub = billingStore(c).billing.cancelSubscription(meta.orgId, args.subscription, args, {
            actorId: meta.actorId, actorType: 'agent',
          });
          return {
            id: sub.id, status: sub.status,
            cancel_at_period_end: sub.cancel_at_period_end,
            ends: longDate(sub.ended_at ?? sub.current_period_end, locale()),
          };
        },
      },
      {
        name: 'billing_pause_subscription',
        description:
          'Pause collection on a subscription, keeping the billing cycle running. Use resumes_at to bring it back automatically.',
        readOnly: false,
        requiresApproval: true,
        tags: ['billing', 'support'],
        input: v.object({
          subscription: v.id('sub'),
          behavior: v.default(v.enum(PAUSE_BEHAVIORS), 'keep_as_draft'),
          resumes_at: v.optional(v.timestamp()),
        }),
        run(args: { subscription: string; behavior: 'keep_as_draft' | 'mark_uncollectible' | 'void'; resumes_at?: number }, c: Ctx, meta) {
          const sub = billingStore(c).billing.pauseSubscription(meta.orgId, args.subscription, args, {
            actorId: meta.actorId, actorType: 'agent',
          });
          return { id: sub.id, status: sub.status, pause_collection: sub.pause_collection };
        },
      },
    ];
  },
});

/** The workspace's tax-location hold, and what it means for the next bill. */
function automaticTaxPayload(ctx: Ctx, orgId: string) {
  const store = billingStore(ctx).billing;
  const enabled = store.invoices.automaticTaxEnabled(orgId);
  const totals = store.invoices.totals(orgId);
  return {
    object: 'automatic_tax_settings',
    enabled,
    invoices_missing_a_tax_location: totals.missing_tax_location,
    invoices_held_in_draft: totals.held_for_tax_location,
    // Both halves of the question the hold actually asks. It began as "is
    // there a country?" and the sentence stayed there while the hold learned to
    // read the register: a US bill held for a missing state was explained, on
    // the settings screen that holds it, as an account with no country.
    detail: enabled
      ? 'A bill for an account whose address Ain cannot place — no country, or no state in a country whose tax is registered state by state — is held as a draft until the address is complete. Nothing goes out taxed at a figure nobody decided on.'
      : 'Bills for accounts whose address Ain cannot place finalise with whatever tax it could work out, which may be none of it. They are still marked, still counted on the overview, and still findable with GET /v1/invoices?tax=missing.',
  };
}

/**
 * Does this bill account for itself?
 *
 * The same identities `Invoices.assertBalanced` refuses to commit without,
 * asked as a question rather than thrown as a failure — so a screen and the
 * copilot both report exactly what the writer enforced. Every reader of this
 * must go through here: the two that had their own copy drifted the moment
 * stacked jurisdictions arrived, and the shorter one went on answering "adds
 * up" for a line whose jurisdictions did not.
 */
function invoiceAddsUp(invoice: Invoice): boolean {
  return invoice.lines.reduce((total, line) => total + line.amount, 0) === invoice.subtotal
    && invoice.lines.reduce((total, line) => total + line.tax.amount, 0) === invoice.tax
    && invoice.lines.every((line) => !line.taxes.length
      || line.taxes.reduce((total, entry) => total + entry.amount, 0) === line.tax.amount)
    && invoice.total_taxes.reduce((total, row) => total + row.amount, 0) === invoice.tax
    && invoice.subtotal + invoice.tax + invoice.balance_applied === invoice.total
    && invoice.total >= 0
    // Nothing may be credited that was not billed — the payload's own reading
    // of the ceiling `assertBalanced` takes from the notes themselves.
    && invoice.pre_payment_credit_notes_amount + invoice.post_payment_credit_notes_amount <= invoice.total
    // A withdrawn bill is owed nothing, and everything else accounts for
    // itself. The writer gained this clause when `CreditNotes.void()` was found
    // putting a bill's full value back as *due* on one that had been struck
    // out; this reader — the one a screen, the API's `reconciles` and the
    // copilot's `adds_up` all answer from — kept the older half of the pair and
    // went on saying a void invoice claiming $527.69 was due added up. A reader
    // that checks fewer identities than the writer enforces is not a shorter
    // answer, it is a wrong one, on the one state the writer cannot reach to
    // fix.
    && (invoice.status === 'void'
      ? invoice.amount_due === 0
      : invoice.amount_paid + invoice.pre_payment_credit_notes_amount + invoice.amount_due === invoice.total);
}

/**
 * An invoice with the two things a screen always needs on top of the row: the
 * money formatted in the workspace's locale, and the reconciliation stated out
 * loud. `reconciles` is not decoration — it is the invariant the module holds,
 * printed where anyone reading the API can check it.
 */
function invoicePayload(ctx: Ctx, orgId: string, invoice: Invoice) {
  const locale = localeOf(ctx, orgId);
  const display = (amount: number) => formatMoney(money(amount, invoice.currency), { locale });
  const store = billingStore(ctx).billing;
  return {
    ...invoice,
    customer_name: store.customer(orgId, invoice.customer)?.name ?? null,
    subtotal_display: display(invoice.subtotal),
    tax_display: display(invoice.tax),
    total_display: display(invoice.total),
    total_excluding_tax_display: display(invoice.total_excluding_tax),
    amount_due_display: display(invoice.amount_due),
    balance_applied_display: display(invoice.balance_applied),
    total_taxes: invoice.total_taxes.map((row) => ({ ...row, amount_display: display(row.amount) })),
    lines: invoice.lines.map((line) => ({
      ...line,
      amount_display: display(line.amount),
      taxes: line.taxes.map((entry) => ({ ...entry, amount_display: display(entry.amount) })),
      tax: { ...line.tax, amount_display: display(line.tax.amount) },
      amount_including_tax: line.amount + line.tax.amount,
    })),
    period_display: `${longDate(invoice.period.start, locale)} to ${longDate(invoice.period.end, locale)}`,
    status_detail: describeInvoiceStatus(invoice, locale),
    document_url: `/v1/invoices/${invoice.id}/render`,
    reconciles: invoiceAddsUp(invoice),
  };
}

function creditNotePayload(ctx: Ctx, orgId: string, note: CreditNote) {
  const locale = localeOf(ctx, orgId);
  const display = (amount: number) => formatMoney(money(amount, note.currency), { locale });
  const store = billingStore(ctx).billing;
  const invoice = store.invoices.invoice(orgId, note.invoice);
  return {
    ...note,
    customer_name: store.customer(orgId, note.customer)?.name ?? null,
    invoice_number: invoice?.number ?? null,
    subtotal_display: display(note.subtotal),
    tax_display: display(note.tax),
    total_display: display(note.total),
    lines: note.lines.map((line) => ({ ...line, amount_including_tax_display: display(line.amount_including_tax) })),
    // What is left on the bill after this note, so a caller never has to guess
    // how much more it could still credit.
    remaining_creditable: invoice ? store.creditNotes.creditable(orgId, invoice) : 0,
    routing_detail: note.post_payment_amount > 0
      ? `${display(note.post_payment_amount)} was put onto the customer's balance, because the invoice had already been paid. It comes off the next one.`
      : `${display(note.pre_payment_amount)} came off what the invoice asks for; nothing had been collected yet.`,
  };
}

function taxRatePayload(rate: TaxRate) {
  return {
    ...rate,
    percentage_display: `${formatPercentage(rate.percentage)}%`,
    applies_to: rate.state ? `${rate.state}, ${rate.country}` : rate.country,
    detail: rate.reverse_charge
      ? `${rate.display_name} ${formatPercentage(rate.percentage)}% in ${rate.jurisdiction}, reverse charged for a business that supplies a registration number.`
      : `${rate.display_name} ${formatPercentage(rate.percentage)}% in ${rate.jurisdiction}.`,
  };
}

function describeInvoiceStatus(invoice: Invoice, locale: string): string {
  switch (invoice.status) {
    case 'draft':
      // A draft has two reasons now, and they send a support agent to two
      // different places. The tax-location hold arrived without this sentence
      // being told about it, so every held bill blamed a pause that was not
      // there while the account sat without a country on it.
      return invoice.automatic_tax.status === 'requires_location_inputs' && invoice.automatic_tax.enabled
        ? 'Held as a draft — Ain could not place this account’s address, so the tax on it could not be worked out and nothing has been sent. It needs a country, and a state in a country whose tax is registered state by state. Complete the address and finalise it.'
        : 'Held as a draft — collection is paused on this subscription, so nothing has been sent.';
    case 'open':
      return invoice.due_date
        ? `Owed, due ${longDate(invoice.due_date, locale)}.`
        : 'Owed, payable on receipt.';
    case 'paid':
      return invoice.paid_at ? `Paid ${longDate(invoice.paid_at, locale)}.` : 'Paid.';
    case 'uncollectible':
      return 'Written off. It was billed, and it is not going to be collected.';
    case 'void':
      return 'Withdrawn. Anything it claimed went back to be billed properly.';
  }
}

function schedulePayload(ctx: Ctx, orgId: string, schedule: SubscriptionSchedule) {
  const book = new Pricebook(ctx, orgId);
  const locale = localeOf(ctx, orgId);
  const now = ctx.now();
  return {
    ...schedule,
    phases: schedule.phases.map((phase, index) => ({
      ...phase,
      index,
      state: schedule.current_phase === null
        ? 'upcoming'
        : index < schedule.current_phase ? 'complete' : index === schedule.current_phase ? 'current' : 'upcoming',
      summary: phase.items
        .map((item) => {
          const price = book.price(item.price);
          const label = book.label(price);
          if (isMetered(price)) return `${label} (metered)`;
          const line = book.compute(price, item.quantity, price.currency, { customUnitAmount: item.custom_unit_amount });
          return `${item.quantity > 1 ? `${item.quantity} x ` : ''}${label} — ${formatMoney(money(line.amount, price.currency), { locale })}`;
        })
        .join(', '),
      window: `${longDate(phase.start_date, locale)} to ${longDate(phase.end_date, locale)}`,
    })),
    current_phase_ends: schedule.current_phase !== null ? schedule.phases[schedule.current_phase]?.end_date ?? null : null,
    starts_in_days: schedule.start_date > now ? Math.ceil((schedule.start_date - now) / 86_400_000) : 0,
  };
}
