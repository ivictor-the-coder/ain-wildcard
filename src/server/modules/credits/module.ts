import { defineModule } from '../../kernel/module';
import type { Ctx } from '../../kernel/context';
import type { AinEvent } from '../../kernel/events';
import { created, list, status as httpStatus, type Req } from '../../kernel/http';
import { isApiError, notFound } from '../../../shared/errors';
import { formatMoney, money } from '../../../shared/money';
import { DAY } from '../../../shared/time';
import v, { type Validator } from '../../../shared/validate';
import type { SettlePeriodJob } from '../metering/module';
import { BURN_ORDER } from './burn';
import { CREDITS_MIGRATIONS } from './schema';
import { seedCredits } from './seed';
import { Credits, type GrantListFilter, type ItemListFilter, type SettlementListFilter } from './store';
import {
  BILLABLE_ITEM_KINDS, BILLABLE_ITEM_STATUSES, CREDIT_CATEGORIES, CREDIT_KINDS, GRANT_STATUSES,
  ROLLOVER_POLICIES, SETTLEMENT_STATUSES,
  type BillableItem, type CreditBalance, type CreditGrant, type GrantInput, type LedgerEntry,
  type Settlement, type SettlementResult, type SettleUsageInput, type SkipSettlementInput,
  type TopUpInput, type TopUpResult,
} from './types';

/* -------------------------------- service --------------------------------- */

/**
 * What the rest of the platform needs from credits. Invoicing asks what a
 * period costs after credit, the customer portal asks what is left, and the
 * copilot asks both.
 */
export interface CreditsService {
  grants(orgId: string, filter?: GrantListFilter): CreditGrant[];
  grant(orgId: string, id: string): CreditGrant | null;
  requireGrant(orgId: string, id: string): CreditGrant;
  createGrant(orgId: string, input: GrantInput): CreditGrant;
  voidGrant(orgId: string, id: string, reason?: string): CreditGrant;
  refundGrant(orgId: string, id: string, opts?: { amount?: number | string; reason?: string }): { grant: CreditGrant; line: BillableItem | null; refunded: number };

  ledger(orgId: string, grantId: string, limit?: number): { grant: CreditGrant; entries: LedgerEntry[]; reconciled: boolean };
  balance(orgId: string, customerId: string): CreditBalance;

  /** Buy a credit pack: the invoice line and the grant, or neither. */
  topUp(orgId: string, input: TopUpInput): TopUpResult;
  /**
   * Price a usage period, draw credit against it and freeze the meter window.
   * `created` is false when the window was already settled — nothing is written
   * twice — and `drift` then says how far the meter has moved since.
   */
  settleUsage(orgId: string, input: SettleUsageInput): SettlementResult;
  settlement(orgId: string, id: string): Settlement | null;
  settlements(orgId: string, filter?: SettlementListFilter): Settlement[];
  /** Record — as a row, not a log line — a period the run refused to settle. */
  recordSkippedSettlement(orgId: string, input: SkipSettlementInput): Settlement;

  /** Lines credits have produced that are not yet on an invoice. */
  billableItems(orgId: string, filter?: ItemListFilter): BillableItem[];
  /** Credit purchases still waiting for the charge that makes them spendable. */
  unbilledPurchases(orgId: string, limit?: number): BillableItem[];
  markInvoiced(orgId: string, ids: string[], invoiceId: string, invoiceItemIds?: Record<string, string>): BillableItem[];
  /** Claim everything this customer's credits owe an invoice. */
  drainOutbox(orgId: string, customerId: string, invoiceId: string): BillableItem[];

  /** The documented burn-down order, for anything that needs to explain it. */
  burnOrder(): string[];
}

declare module '../../kernel/services' {
  interface ServiceRegistry { credits: CreditsService }
}

/**
 * Whatever an invoice event turns out to carry, these are the two facts this
 * module needs from it: which invoice, and whose. Read defensively, because the
 * producer is another module and a missing field must mean "not for us" rather
 * than a failed handler.
 */
interface InvoiceEvent {
  id?: string;
  invoice?: string;
  customer?: string;
}

/**
 * The part of `subscription.invoice_due` worth carrying forward.
 *
 * Billing publishes this when a cycle turns over; it is the only invoice-shaped
 * event this platform actually emits. Everything here is passed straight
 * through onto `credit.items_ready`, so the metered lines credits computed
 * travel in the same payload as the recurring lines billing computed.
 */
interface InvoiceDueJob {
  customer: string;
  subscription: string | null;
  currency: string | null;
  reason: string | null;
  period: { start: number; end: number } | null;
  arrears_period: { start: number; end: number } | null;
  lines: unknown[];
  pending_item_ids: string[];
}

/** Settlement failures a retry cannot fix, so the job reports them and stops. */
const FINAL_SETTLEMENT_FAILURES = new Set([
  'usage_period_already_settled',
  'meter_period_overlaps_closure',
  'resource_missing',
  'meter_required',
  'amount_out_of_range',
]);

function invoiceOf(event: AinEvent<InvoiceEvent>): { invoice: string; customer: string } | null {
  const data = event.data ?? {};
  const invoice = data.invoice ?? data.id ?? event.object_id ?? null;
  const customer = data.customer ?? null;
  return invoice && customer ? { invoice, customer } : null;
}

/**
 * Customers holding more than one subscription item against the same metered
 * price. Stripe forbids this at creation; billing here allows it, so the least
 * we can do is name it — it is the root cause of every refused period, and
 * without it the refusals look like a bug rather than a configuration.
 */
function contentionOf(skipped: Settlement[]): { customer: string; price: string; subscription_items: string[]; periods_refused: number }[] {
  const groups = new Map<string, { customer: string; price: string; items: Set<string>; periods: number }>();
  for (const row of skipped) {
    const key = `${row.customer}:${row.price}`;
    const group = groups.get(key) ?? { customer: row.customer, price: row.price, items: new Set<string>(), periods: 0 };
    if (row.subscription_item) group.items.add(row.subscription_item);
    group.periods += 1;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.periods - a.periods || a.customer.localeCompare(b.customer))
    .map((g) => ({ customer: g.customer, price: g.price, subscription_items: [...g.items].sort(), periods_refused: g.periods }));
}

/**
 * Raise the alert on a refused period's unbilled hours, or take it back.
 *
 * Coverage is worked out on read, so this is a pure function of what the
 * settlements around this window look like right now: an episode is opened
 * once, and closed the moment nothing is uncovered any more. Called from the
 * daily watch, and again the instant a fill settles, so the retraction does not
 * wait a day behind the money.
 */
function reviewSettlementGaps(ctx: Ctx, orgId: string, settlement: Settlement, filling: { start: number; end: number }[] = []): void {
  const gaps = (settlement.skip?.gaps ?? []).filter((gap) => gap.overdue);
  const opened = ctx.events.list(orgId, { types: ['credit.settlement_gap'], objectId: settlement.id, limit: 1 })[0];
  const closed = ctx.events.list(orgId, { types: ['credit.settlement_gap_closed'], objectId: settlement.id, limit: 1 })[0];
  const outstanding = !!opened && (!closed || closed.created < opened.created);
  const facts = {
    settlement: settlement.id, customer: settlement.customer, price: settlement.price,
    subscription: settlement.subscription, subscription_item: settlement.subscription_item,
    period_start: settlement.period_start, period_end: settlement.period_end,
    superseded_by: settlement.skip?.superseded_by ?? null,
  };
  // Raised once per episode and taken back when the hole is filled: a monthly
  // cadence over a short February can leave a sliver uncovered for longer than
  // a window, and an alert nobody ever retracts is an alert nobody reads.
  if (gaps.length && !outstanding) {
    ctx.emit(orgId, 'credit.settlement_gap', {
      ...facts, gaps,
      uncovered_ms: gaps.reduce((acc, gap) => acc + (gap.end - gap.start), 0),
      // What has been scheduled to bill it, so the alert is a work order and
      // not only a complaint.
      filling,
      message: settlement.skip?.summary ?? 'This period has usage nothing has billed.',
    }, { objectId: settlement.id, objectType: 'credit_settlement' });
  } else if (!gaps.length && outstanding) {
    ctx.emit(orgId, 'credit.settlement_gap_closed', {
      ...facts,
      coverage_percent: settlement.skip?.coverage_percent ?? 100,
      covered_by: settlement.skip?.covered_by ?? [],
      message: settlement.skip?.summary ?? 'Every hour of this period is billed now.',
    }, { objectId: settlement.id, objectType: 'credit_settlement' });
  }
}

/**
 * Bill the hole, not just name it.
 *
 * A refusal is usually right — settling a window whose usage another settlement
 * already covers would draw a customer's credit twice — but the hours nothing
 * covers are revenue, and the platform is holding every fact needed to bill
 * them: the customer, the price, the meter, the exact window and the cycle its
 * tiers belong to. So each overdue hole becomes a settlement job of its own,
 * for exactly the uncovered window, priced against the cycle the refused period
 * belonged to so it climbs the same tier ladder the run would have climbed.
 *
 * Asked once per window and no more: a window that has been settled needs
 * nothing, and one that has been refused has already been given a reason, so a
 * daily watch cannot turn either into a job that runs forever.
 */
function fillSettlementGaps(ctx: Ctx, store: Credits, orgId: string, settlement: Settlement): { start: number; end: number }[] {
  const enqueued: { start: number; end: number }[] = [];
  for (const gap of settlement.skip?.gaps ?? []) {
    if (!gap.overdue || !(gap.end > gap.start)) continue;
    if (store.settlementForWindow(orgId, settlement.customer, settlement.price, gap.start, gap.end)) continue;
    const stated = settlement.skip?.billing_period ?? null;
    const cycle = stated && stated.start <= gap.start && stated.end >= gap.end
      ? stated
      : { start: settlement.period_start, end: settlement.period_end };
    const job: SettlePeriodJob = {
      customer: settlement.customer,
      price: settlement.price,
      currency: settlement.currency,
      subscription: settlement.subscription,
      subscription_item: settlement.subscription_item,
      period_start: gap.start,
      period_end: gap.end,
      billing_period: cycle,
      fills_gap_in: settlement.id,
    };
    // Keyed by the window rather than by the refusal that raised it: two
    // subscription items on one price refuse the same month and leave the same
    // hole, and that hole is billed once.
    ctx.enqueue(orgId, 'credits.settle_period', job, {
      runAt: ctx.now(),
      idemKey: `credits.gap_fill:${settlement.customer}:${settlement.price}:${gap.start}:${gap.end}`,
    });
    enqueued.push({ start: gap.start, end: gap.end });
  }
  return enqueued;
}

const stores = new WeakMap<Ctx, Credits>();
export function creditsStore(ctx: Ctx): Credits {
  let store = stores.get(ctx);
  if (!store) { store = new Credits(ctx); stores.set(ctx, store); }
  return store;
}

/* ------------------------------- validators ------------------------------- */

const queryOf = <T>(req: Req, schema: Validator<T>): T => schema.parse(req.query);

const applicabilityBody = v.object({
  scope: v.default(v.enum(['all', 'targeted'] as const), 'targeted'),
  prices: v.default(v.array(v.string({ max: 80 }), { max: 50 }), []),
  meters: v.default(v.array(v.string({ max: 80 }), { max: 50 }), []),
  products: v.default(v.array(v.string({ max: 80 }), { max: 50 }), []),
});

const grantBody = v.object({
  customer: v.string({ min: 1, max: 120 }),
  name: v.optional(v.string({ min: 1, max: 140 })),
  category: v.default(v.enum(CREDIT_CATEGORIES), 'promotional'),
  kind: v.default(v.enum(CREDIT_KINDS), 'monetary'),
  currency: v.optional(v.currency()),
  meter: v.optional(v.string({ max: 80 })),
  unit_label: v.optional(v.string({ max: 40 })),
  amount: v.union(v.number({ min: 0 }), v.string({ max: 40 })),
  applicability: v.optional(applicabilityBody),
  effective_at: v.optional(v.timestamp()),
  expires_at: v.optional(v.timestamp()),
  priority: v.default(v.int({ min: -1000, max: 1000 }), 0),
  rollover: v.default(v.enum(ROLLOVER_POLICIES), 'none'),
  rollover_cap: v.optional(v.union(v.number({ min: 0 }), v.string({ max: 40 }))),
  metadata: v.metadata(),
  reason: v.optional(v.string({ max: 300 })),
});

const grantPatchBody = v.object({
  name: v.optional(v.string({ min: 1, max: 140 })),
  priority: v.optional(v.int({ min: -1000, max: 1000 })),
  expires_at: v.optional(v.nullable(v.timestamp())),
  metadata: v.optional(v.metadata()),
});

const topUpBody = v.object({
  customer: v.string({ min: 1, max: 120 }),
  price: v.string({ min: 1, max: 80 }),
  quantity: v.default(v.int({ min: 1, max: 100_000 }), 1),
  currency: v.optional(v.currency()),
  grant_amount: v.optional(v.union(v.number({ min: 0 }), v.string({ max: 40 }))),
  kind: v.optional(v.enum(CREDIT_KINDS)),
  category: v.default(v.enum(CREDIT_CATEGORIES), 'paid'),
  name: v.optional(v.string({ min: 1, max: 140 })),
  effective_at: v.optional(v.timestamp()),
  expires_at: v.optional(v.timestamp()),
  priority: v.optional(v.int({ min: -1000, max: 1000 })),
  rollover: v.optional(v.enum(ROLLOVER_POLICIES)),
  rollover_cap: v.optional(v.union(v.number({ min: 0 }), v.string({ max: 40 }))),
  applicability: v.optional(applicabilityBody),
  metadata: v.metadata(),
});

const settleBody = v.object({
  customer: v.string({ min: 1, max: 120 }),
  price: v.string({ min: 1, max: 80 }),
  meter: v.optional(v.string({ max: 80 })),
  period_start: v.timestamp(),
  period_end: v.timestamp(),
  quantity: v.optional(v.number({ min: 0 })),
  currency: v.optional(v.currency()),
  idem_key: v.optional(v.string({ max: 200 })),
  /* Left undefined on purpose: the store closes a window whenever it resolved
     a meter, because pricing a metered period through this endpoint *is*
     billing it. `false` is the escape hatch for a caller who is pricing a
     window without invoicing it — a quote, or a quantity supplied by hand
     against a meter the bill is not drawn from. */
  close_period: v.optional(v.boolean()),
  billing_period_start: v.optional(v.timestamp()),
  billing_period_end: v.optional(v.timestamp()),
  subscription: v.optional(v.string({ max: 80 })),
  subscription_item: v.optional(v.string({ max: 80 })),
});

const grantListQuery = v.object({
  customer: v.optional(v.string({ max: 120 })),
  status: v.optional(v.enum(GRANT_STATUSES)),
  category: v.optional(v.enum(CREDIT_CATEGORIES)),
  kind: v.optional(v.enum(CREDIT_KINDS)),
  currency: v.optional(v.currency()),
  meter: v.optional(v.string({ max: 80 })),
  limit: v.optional(v.int({ min: 1, max: 500 })),
});

const itemListQuery = v.object({
  customer: v.optional(v.string({ max: 120 })),
  status: v.optional(v.enum(BILLABLE_ITEM_STATUSES)),
  kind: v.optional(v.enum(BILLABLE_ITEM_KINDS)),
  settlement: v.optional(v.string({ max: 80 })),
  limit: v.optional(v.int({ min: 1, max: 500 })),
});

const settlementListQuery = v.object({
  customer: v.optional(v.string({ max: 120 })),
  status: v.optional(v.enum([...SETTLEMENT_STATUSES, 'all'] as const)),
  price: v.optional(v.string({ max: 80 })),
  subscription: v.optional(v.string({ max: 80 })),
  limit: v.optional(v.int({ min: 1, max: 200 })),
});

const ledgerQuery = v.object({
  customer: v.optional(v.string({ max: 120 })),
  limit: v.optional(v.int({ min: 1, max: 500 })),
});

const grantLedgerQuery = v.object({
  limit: v.optional(v.int({ min: 1, max: 1000 })),
});

/* --------------------------------- module --------------------------------- */

export default defineModule({
  name: 'credits',
  title: 'Prepaid credit & usage settlement',
  description: 'Credit grants with a ledger that is the balance, a documented burn-down order, expiry and rollover as jobs, and usage settled into credit-covered and charged invoice lines.',
  dependsOn: ['core', 'metering'],
  migrations: CREDITS_MIGRATIONS,

  boot(ctx) {
    const store = creditsStore(ctx);
    const service: CreditsService = {
      grants: (orgId, filter) => store.grants(orgId, filter),
      grant: (orgId, id) => store.grant(orgId, id),
      requireGrant: (orgId, id) => store.requireGrant(orgId, id),
      createGrant: (orgId, input) => store.createGrant(orgId, input),
      voidGrant: (orgId, id, reason) => store.voidGrant(orgId, id, reason),
      refundGrant: (orgId, id, opts) => store.refundGrant(orgId, id, opts),
      ledger: (orgId, grantId, limit) => store.ledger(orgId, grantId, limit),
      balance: (orgId, customerId) => store.balance(orgId, customerId),
      topUp: (orgId, input) => store.topUp(orgId, input),
      settleUsage: (orgId, input) => store.settleUsage(orgId, input),
      settlement: (orgId, id) => store.settlement(orgId, id),
      settlements: (orgId, filter) => store.settlements(orgId, filter),
      recordSkippedSettlement: (orgId, input) => store.recordSkippedSettlement(orgId, input),
      billableItems: (orgId, filter) => store.billableItems(orgId, filter),
      unbilledPurchases: (orgId, limit) => store.unbilledPurchases(orgId, limit),
      markInvoiced: (orgId, ids, invoiceId, invoiceItemIds) => store.markInvoiced(orgId, ids, invoiceId, invoiceItemIds),
      drainOutbox: (orgId, customerId, invoiceId) => store.drainOutbox(orgId, customerId, invoiceId),
      burnOrder: () => BURN_ORDER,
    };
    ctx.provide('credits', service);

    // Metering can price a billed period's drift exactly; it cannot bill
    // anybody for it. This is the module that can, so it says so once here
    // rather than being reached for by name from the other side.
    ctx.svc.metering.onTrueUp((orgId, request) => store.trueUp(orgId, request));

    /**
     * The job that turns a period that has ended into money.
     *
     * Metering enqueues one of these for every metered item on a subscription
     * whose cycle just turned over. Everything it needs was already here —
     * aggregation, pricing, the burn-down order, the two invoice lines, the
     * closure that freezes the period — and none of it ever ran on its own.
     * This is the row with a `run_at` that makes it run.
     */
    ctx.jobs.handle('credits.settle_period', (payload: SettlePeriodJob, job) => {
      const orgId = job.org_id;
      try {
        const { settlement, created } = store.settleUsage(orgId, {
          customer: payload.customer,
          price: payload.price,
          currency: payload.currency ?? undefined,
          period_start: payload.period_start,
          period_end: payload.period_end,
          billing_period_start: payload.billing_period?.start,
          billing_period_end: payload.billing_period?.end,
          subscription: payload.subscription,
          subscription_item: payload.subscription_item,
          // Freezing the meter period is the point: from here on, usage that
          // lands inside it is a true-up rather than a number that disagrees
          // with an invoice already sent. It is the default now, stated here
          // anyway because this is the path a whole year of invoices runs down.
          close_period: true,
        });
        if (created) {
          ctx.emit(orgId, 'credit.period_settled_automatically', {
            settlement: settlement.id, customer: settlement.customer, price: settlement.price,
            subscription: payload.subscription, subscription_item: payload.subscription_item,
            period_start: settlement.period_start, period_end: settlement.period_end,
            full_amount: settlement.full_amount, covered_amount: settlement.covered_amount,
            charged_amount: settlement.charged_amount, currency: settlement.currency,
            fills_gap_in: payload.fills_gap_in ?? null,
          }, { objectId: settlement.id, objectType: 'credit_settlement' });
        }
        // The hole this window was raised to fill is now billed, so the alert
        // that named it is taken back on the spot rather than at tomorrow's
        // watch — the pair of events is what a workflow keys off.
        if (payload.fills_gap_in) {
          const source = store.settlement(orgId, payload.fills_gap_in);
          if (source) reviewSettlementGaps(ctx, orgId, source);
        }
      } catch (e) {
        // Some failures are business facts rather than transient faults, and
        // retrying one eight times cannot make it true: usage already billed
        // under another window, a price that no longer exists, a metered price
        // with no meter behind it. Say so once, in the event log a human, a
        // webhook and a workflow all read, and stop.
        if (!isApiError(e) || !FINAL_SETTLEMENT_FAILURES.has(e.code)) throw e;
        // ...and the saying-so is a row. A revenue question the platform
        // declined to answer that lives only in the event log is a question
        // nobody ever sees again: the job is marked `done`, no failure count
        // moves, and the period is gone. The skipped settlement carries the
        // window, who asked for it, what superseded it and — the part that
        // decides whether anyone lost money — how much of the window that
        // something actually covers.
        const detail = (e.detail ?? {}) as { settlement?: string };
        store.recordSkippedSettlement(orgId, {
          customer: payload.customer,
          price: payload.price,
          currency: payload.currency ?? null,
          period_start: payload.period_start,
          period_end: payload.period_end,
          subscription: payload.subscription,
          subscription_item: payload.subscription_item,
          reason: e.code,
          message: e.message,
          superseded_by: typeof detail.settlement === 'string' ? detail.settlement : null,
          billing_period: payload.billing_period ?? null,
        });
      }
    });

    /**
     * Announce what credits are holding for this customer's next invoice.
     *
     * Deliberately a job rather than the handler on `subscription.invoice_due`
     * itself, and the ordering is the whole point: metering turns that event
     * into settlement jobs due right now, and this one is enqueued after them,
     * so by the time it runs the period that just closed has been priced and
     * its lines exist. Announced on the same event, the payload would carry
     * last month's lines and miss the one the invoice is for.
     */
    ctx.jobs.handle('credits.publish_ready_items', (payload: InvoiceDueJob, job) => {
      const orgId = job.org_id;
      const items = store.billableItems(orgId, { customer: payload.customer, status: 'pending', limit: 500 });
      if (!items.length) return;
      const currencies = [...new Set(items.map((i) => i.currency))].sort();
      ctx.emit(orgId, 'credit.items_ready', {
        customer: payload.customer,
        subscription: payload.subscription,
        currency: payload.currency,
        reason: payload.reason,
        period: payload.period,
        arrears_period: payload.arrears_period,
        // Carried through untouched so whoever draws the invoice has the whole
        // picture in one payload rather than two half-payloads to correlate.
        lines: payload.lines,
        pending_item_ids: payload.pending_item_ids,
        credit_items: items,
        credit_item_ids: items.map((i) => i.id),
        totals: currencies.map((currency) => {
          const mine = items.filter((i) => i.currency === currency);
          return {
            currency,
            amount: mine.reduce((acc, i) => acc + i.amount, 0),
            billed_total: mine.reduce((acc, i) => acc + i.billed_amount, 0),
            credit_applied_total: mine.reduce((acc, i) => acc + i.credit_applied, 0),
            line_count: mine.length,
          };
        }),
      }, { objectId: payload.subscription ?? payload.customer, objectType: 'subscription' });
    });

    // Expiry is a row with a `run_at`, not a timer, which is why the time
    // machine can show a grant lapsing on exactly the right day.
    ctx.jobs.handle('credits.expire_grant', (payload: { grant: string }, job) => {
      store.expireGrant(job.org_id, payload.grant);
    });

    ctx.jobs.handle('credits.activate_grant', (payload: { grant: string }, job) => {
      const grant = store.grant(job.org_id, payload.grant);
      if (!grant || grant.status !== 'active') return;
      ctx.emit(job.org_id, 'credit_grant.activated', grant, { objectId: grant.id, objectType: 'credit_grant' });
    });

    /**
     * The daily check that no metered period has quietly gone unbilled.
     *
     * A period the run refused usually loses nobody anything — the usage is
     * billed once, under the settlement that superseded it, and the sliver at
     * the end is picked up by the next cycle. A hole that survives a whole
     * billing cycle is the other thing entirely: usage nothing has billed and
     * nothing is going to. So each one becomes a settlement job for exactly the
     * uncovered window and an event that says so — the alert and the invoice
     * line, not the alert on its own.
     */
    ctx.jobs.handle('credits.settlement_watch', (_payload: Record<string, never>, job) => {
      const orgId = job.org_id;
      const now = ctx.now();
      for (const settlement of store.settlements(orgId, { status: 'skipped', limit: 200 })) {
        reviewSettlementGaps(ctx, orgId, settlement, fillSettlementGaps(ctx, store, orgId, settlement));
      }
      ctx.enqueue(orgId, 'credits.settlement_watch', {}, { runAt: now + DAY, idemKey: 'credits.settlement_watch' });
    });

    /**
     * The daily retry for a credit purchase nobody has charged for.
     *
     * A top-up raises its own charge the moment it is bought, so this runs
     * almost never — but "almost never" is exactly when a customer is left
     * holding a grant they cannot spend, and a business is left holding revenue
     * it never billed. Every pending purchase is offered to invoicing again;
     * the ones invoicing still cannot take are announced once each, with how
     * long they have been waiting, so the number is alertable rather than a
     * count somebody has to think to open.
     */
    ctx.jobs.handle('credits.purchase_watch', (_payload: Record<string, never>, job) => {
      const orgId = job.org_id;
      const now = ctx.now();
      const outcome = store.billUnbilledPurchases(orgId);
      const waiting = store.unbilledPurchases(orgId);
      if (outcome.charged.length) {
        ctx.emit(orgId, 'credit.purchases_charged', {
          lines: outcome.charged, count: outcome.charged.length,
        }, { objectId: orgId, objectType: 'organization' });
      }
      for (const item of waiting) {
        const announced = ctx.events.list(orgId, { types: ['credit.purchase_unbilled'], objectId: item.id, limit: 1 })[0];
        // Once a day at most, and only after a full day of waiting: a purchase
        // bought a minute ago whose account is not billable yet is not news.
        if (announced && now - announced.created < DAY) continue;
        if (now - item.created < DAY) continue;
        ctx.emit(orgId, 'credit.purchase_unbilled', {
          line: item.id, customer: item.customer, grant: item.grant,
          amount: item.amount, currency: item.currency,
          waiting_ms: now - item.created, since: item.created,
          reason: item.metadata.charge_deferred ?? null,
          message: item.metadata.charge_deferred_reason
            ?? `${item.description} has been waiting ${Math.floor((now - item.created) / DAY)} days for a charge, so the credit it bought is still held.`,
        }, { objectId: item.id, objectType: 'credit_billable_item' });
      }
      ctx.enqueue(orgId, 'credits.purchase_watch', {}, { runAt: now + DAY, idemKey: 'credits.purchase_watch' });
    });

    // A customer whose credit runs out mid-period is about to get a bill they
    // are not expecting. Warn while there is still time to buy another pack.
    ctx.jobs.handle('credits.expiry_digest', (_payload: Record<string, never>, job) => {
      const orgId = job.org_id;
      const now = ctx.now();
      const soon = now + 7 * DAY;
      const rows = ctx.db.all<{ customer_id: string }>(
        `SELECT DISTINCT customer_id FROM credit_grants
         WHERE org_id = ? AND expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?`,
        orgId, now, soon,
      );
      for (const row of rows) {
        const balance = store.balance(orgId, row.customer_id);
        const expiring = balance.balances.filter((b) => b.next_expiry && b.next_expiry.at <= soon);
        if (!expiring.length) continue;
        ctx.emit(orgId, 'credit.expiring_soon', {
          customer: row.customer_id,
          within_days: 7,
          pots: expiring.map((b) => ({
            currency: b.currency, kind: b.kind, meter: b.meter,
            available: b.available, available_decimal: b.available_decimal,
            expires_at: b.next_expiry?.at ?? null, grant: b.next_expiry?.grant ?? null,
          })),
        }, { objectId: row.customer_id, objectType: 'customer' });
      }
      ctx.enqueue(orgId, 'credits.expiry_digest', {}, { runAt: now + DAY, idemKey: 'credits.expiry_digest' });
    });
  },

  seed(ctx, orgId) {
    seedCredits(ctx, orgId);
    ctx.jobs.enqueue(orgId, 'credits.expiry_digest', {}, ctx.now(), { runAt: ctx.now() + DAY, idemKey: 'credits.expiry_digest' });
    ctx.jobs.enqueue(orgId, 'credits.settlement_watch', {}, ctx.now(), { runAt: ctx.now() + DAY, idemKey: 'credits.settlement_watch' });
    ctx.jobs.enqueue(orgId, 'credits.purchase_watch', {}, ctx.now(), { runAt: ctx.now() + DAY, idemKey: 'credits.purchase_watch' });
  },

  routes(router, ctx) {
    const store = creditsStore(ctx);

    /* -------------------------------- grants ------------------------------ */

    router.get('/v1/credit-grants', (req: Req, c: Ctx) => {
      const grants = c.svc.credits.grants(req.auth.orgId, queryOf(req, grantListQuery));
      return list(grants, { totalCount: grants.length });
    }, {
      summary: 'List credit grants with their derived balances', tags: ['credits'], query: grantListQuery,
      description: 'Each balance is the sum of that grant’s ledger. Nothing here reads a stored balance, because there is no stored balance to read.',
    });

    router.post('/v1/credit-grants', (req: Req, c: Ctx) =>
      created(c.svc.credits.createGrant(req.auth.orgId, req.body as GrantInput)), {
      summary: 'Issue credit to a customer', tags: ['credits'], roles: ['member'], body: grantBody,
      description:
        'Monetary grants are denominated in minor units of a currency; unit grants hold a meter’s own units and may only pay for that meter. Give an `expires_at` and expiry is scheduled as a job, so the time machine can show it lapse.',
    });

    router.get('/v1/credit-grants/:id', (req: Req, c: Ctx) => {
      const grant = c.svc.credits.grant(req.auth.orgId, req.params.id);
      if (!grant) throw notFound('credit grant', req.params.id);
      return grant;
    }, { summary: 'Retrieve a credit grant', tags: ['credits'] });

    router.patch('/v1/credit-grants/:id', (req: Req, c: Ctx) =>
      store.updateGrant(req.auth.orgId, req.params.id, req.body as { name?: string; priority?: number; expires_at?: number | null; metadata?: Record<string, string> }), {
      summary: 'Change a grant’s name, priority or expiry', tags: ['credits'], roles: ['member'], body: grantPatchBody,
      description: 'The amount and the applicability are fixed: the money has already been taken. Rescheduling `expires_at` moves the expiry job with it.',
    });

    router.post('/v1/credit-grants/:id/void', (req: Req, c: Ctx) => {
      const body = req.body as { reason?: string };
      return c.svc.credits.voidGrant(req.auth.orgId, req.params.id, body.reason);
    }, {
      summary: 'Withdraw the unused balance of a grant', tags: ['credits'], roles: ['admin'],
      body: v.object({ reason: v.optional(v.string({ max: 300 })) }),
    });

    router.post('/v1/credit-grants/:id/refund', (req: Req, c: Ctx) =>
      c.svc.credits.refundGrant(req.auth.orgId, req.params.id, req.body as { amount?: number; reason?: string }), {
      summary: 'Refund unused paid credit, pro rata to what was bought', tags: ['credits'], roles: ['admin'],
      body: v.object({
        amount: v.optional(v.union(v.number({ min: 0 }), v.string({ max: 40 }))),
        reason: v.optional(v.string({ max: 300 })),
      }),
    });

    router.get('/v1/credit-grants/:id/ledger', (req: Req, c: Ctx) => {
      const q = queryOf(req, grantLedgerQuery);
      const { grant, entries, reconciled } = c.svc.credits.ledger(req.auth.orgId, req.params.id, q.limit);
      return {
        object: 'credit_ledger',
        grant,
        reconciled,
        opening: 0,
        closing: entries.length ? entries[entries.length - 1].balance_after : 0,
        entries,
      };
    }, {
      summary: 'The full history of one grant, with the running balance', tags: ['credits'], query: grantLedgerQuery,
      description: '`reconciled` re-adds every delta on read and checks it against the running balance carried on each entry. It is a lie detector for this endpoint.',
    });

    /* ------------------------------- balances ----------------------------- */

    router.get('/v1/customers/:id/credit-balance', (req: Req, c: Ctx) =>
      c.svc.credits.balance(req.auth.orgId, req.params.id), {
      summary: 'A customer’s credit, per currency and per applicability', tags: ['credits'],
      description: 'Balances are grouped by what they may be spent on, because $500 that only pays for telemetry is not the same asset as $500 that pays for anything. Each pot carries its next expiry.',
    });

    router.get('/v1/credit-ledger', (req: Req, c: Ctx) => {
      const q = queryOf(req, ledgerQuery);
      const entries = store.customerLedger(req.auth.orgId, q.customer ?? null, q.limit);
      return list(entries, { totalCount: entries.length });
    }, {
      summary: 'Every credit movement, newest first — the whole workspace, or one customer', tags: ['credits'], query: ledgerQuery,
    });

    /* ------------------------------- top-ups ------------------------------ */

    router.post('/v1/credit-topups', (req: Req, c: Ctx) =>
      created(c.svc.credits.topUp(req.auth.orgId, req.body as TopUpInput)), {
      summary: 'Buy a credit pack — the invoice line and the grant, or neither', tags: ['credits'], roles: ['member'],
      body: topUpBody,
      description:
        'The charge comes first. The purchase line and the grant are written in one transaction, the charge is raised on the spot, and the grant only becomes spendable once that line is on an invoice — so a customer can never be charged for credit they did not receive, or hold credit nobody was billed for. When invoicing cannot take the charge yet, `charge_deferred` says why, the grant stays `scheduled` with `awaiting_payment: true`, and the daily purchase watch keeps offering it.',
    });

    /* ----------------------------- settlement ----------------------------- */

    router.post('/v1/credit-settlements', (req: Req, c: Ctx) => {
      const outcome = c.svc.credits.settleUsage(req.auth.orgId, req.body as SettleUsageInput);
      // 201 is a promise that something was written. A window that was already
      // settled is a read, and saying "created" over the top of a stale
      // quantity is how a period drifts away from its invoice unnoticed — so
      // the replay is a 200 and it carries what the meter says today.
      return outcome.created
        ? created(outcome.settlement)
        : httpStatus(200, { ...outcome.settlement, replayed: true, drift: outcome.drift });
    }, {
      summary: 'Price a usage period, draw credit against it and freeze the meter window', tags: ['credits'], roles: ['member'],
      body: settleBody,
      description:
        'The window is priced against the billing period’s running total, not from scratch: `tier_basis` says which settled windows of the same cycle came before it and what rung of the price’s tiers this one therefore starts on, so any way you cut a period into windows the pieces cost exactly what the whole costs and a graduated price gives its free tier away once. Pass `billing_period_start`/`billing_period_end` to state the cycle; leave them out and it is derived from the price’s own cadence, ending where this window ends. Unit credits then come off the quantity and monetary credits off the money, in the documented burn-down order, producing two invoice lines — the credit-covered portion and the charged portion — whose amounts always sum to `full_amount`. Pricing a metered period here is billing it, so the meter window is frozen at the same time: usage that lands inside it afterwards is filed as a late arrival and priced as a true-up rather than moving a total an invoice has already been drawn on. Pass `close_period: false` to price a window without claiming it has been billed. Settling the same period twice never draws the balance again: the first settlement comes back as `200 OK` with `replayed: true` and, when the meter no longer agrees with what was billed, a `drift` block naming the live total, what the difference is worth and the late arrivals waiting to be resolved.',
    });

    router.get('/v1/credit-settlements', (req: Req, c: Ctx) => {
      const settlements = c.svc.credits.settlements(req.auth.orgId, queryOf(req, settlementListQuery));
      return list(settlements, { totalCount: settlements.length });
    }, {
      summary: 'List settled usage periods — and the ones that were refused', tags: ['credits'],
      query: settlementListQuery,
      description:
        'A period the automatic run declined is a row here too, with `status: "skipped"`, the settlement that superseded it and how much of its window that settlement covers. `?status=skipped` is the list of every revenue question this platform decided not to answer — and what it did about each one: a gap that outlives a billing cycle is settled on its own by the daily watch, for exactly the uncovered window and against the cycle the refused period belonged to, so the refusal stays on the record while the usage still gets billed.',
    });

    router.get('/v1/credit-settlements/:id', (req: Req, c: Ctx) => {
      const settlement = c.svc.credits.settlement(req.auth.orgId, req.params.id);
      if (!settlement) throw notFound('credit settlement', req.params.id);
      return settlement;
    }, { summary: 'Retrieve one settlement, with every grant it drew from', tags: ['credits'] });

    /* --------------------------- billable outbox -------------------------- */

    router.get('/v1/credit-billable-items', (req: Req, c: Ctx) => {
      const items = c.svc.credits.billableItems(req.auth.orgId, queryOf(req, itemListQuery));
      return list(items, {
        totalCount: items.length,
        url: '/v1/credit-billable-items',
      });
    }, {
      summary: 'Lines credits have produced for an invoice', tags: ['credits'], query: itemListQuery,
      description:
        'Top-up purchases and the two halves of a settled usage period land here as pending lines. Billing claims them onto an invoice; `amount` is what the portion is worth and `billed_amount` is what the customer pays for it, which is zero on a credit-covered line.',
    });

    router.post('/v1/credit-billable-items/invoice', (req: Req, c: Ctx) => {
      const body = req.body as { items: string[]; invoice: string; invoice_items?: Record<string, string> };
      return c.svc.credits.markInvoiced(req.auth.orgId, body.items, body.invoice, body.invoice_items);
    }, {
      summary: 'Claim pending lines onto an invoice', tags: ['credits'], roles: ['member'],
      body: v.object({
        items: v.array(v.string({ max: 80 }), { min: 1, max: 500 }),
        invoice: v.string({ min: 1, max: 80 }),
        invoice_items: v.optional(v.record(v.string({ max: 80 }))),
      }),
    });

    /* ------------------------------- overview ----------------------------- */

    router.get('/v1/credits/overview', (req: Req, c: Ctx) => {
      const orgId = req.auth.orgId;
      const now = c.now();
      const grants = c.svc.credits.grants(orgId, { limit: 500 });
      const live = grants.filter((g) => g.status === 'active');
      const byCurrency = new Map<string, { currency: string; monetary_outstanding: number; unit_pots: number }>();
      for (const grant of live) {
        const row = byCurrency.get(grant.currency) ?? { currency: grant.currency, monetary_outstanding: 0, unit_pots: 0 };
        if (grant.kind === 'monetary') row.monetary_outstanding += grant.balance; else row.unit_pots += 1;
        byCurrency.set(grant.currency, row);
      }
      const pending = c.svc.credits.billableItems(orgId, { status: 'pending', limit: 500 });
      return {
        object: 'credits_overview',
        as_of: now,
        burn_order: BURN_ORDER,
        grants: { total: grants.length, active: live.length, scheduled: grants.filter((g) => g.status === 'scheduled').length, expired: grants.filter((g) => g.status === 'expired').length },
        outstanding: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map((row) => ({
          ...row,
          monetary_outstanding_display: formatMoney(money(row.monetary_outstanding, row.currency)),
        })),
        expiring_within_7_days: grants.filter((g) => g.status === 'active' && g.expires_at !== null && g.expires_at <= now + 7 * DAY)
          .map((g) => ({ id: g.id, customer: g.customer, name: g.name, balance: g.balance, balance_decimal: g.balance_decimal, expires_at: g.expires_at })),
        pending_invoice_lines: {
          count: pending.length,
          billed_total: pending.reduce((acc, i) => acc + i.billed_amount, 0),
          credit_applied_total: pending.reduce((acc, i) => acc + i.credit_applied, 0),
          oldest_at: pending.length ? Math.min(...pending.map((i) => i.created)) : null,
          oldest_age_ms: pending.length ? now - Math.min(...pending.map((i) => i.created)) : 0,
        },
        // A purchase nobody has charged for is the one line here that holds a
        // customer's credit hostage: the grant it bought is unspendable until
        // this clears, and the revenue is recognised nowhere. Aged, so it can
        // be alerted on rather than counted.
        unbilled_purchases: (() => {
          const waiting = c.svc.credits.unbilledPurchases(orgId);
          const oldest = waiting.length ? Math.min(...waiting.map((i) => i.created)) : null;
          return {
            count: waiting.length,
            amount_total: waiting.reduce((acc, i) => acc + i.amount, 0),
            oldest_at: oldest,
            oldest_age_ms: oldest === null ? 0 : now - oldest,
            held_grants: waiting.filter((i) => i.grant).length,
            lines: waiting.slice(0, 10).map((i) => ({
              line: i.id, customer: i.customer, grant: i.grant,
              amount: i.amount, currency: i.currency, since: i.created,
              waiting_ms: now - i.created,
              reason: i.metadata.charge_deferred ?? null,
              message: i.metadata.charge_deferred_reason ?? null,
            })),
          };
        })(),
        // A period the automatic run refused to settle is the one thing here a
        // human has to act on, so it is counted on the front page and readable
        // as rows, rather than buried in an event log nobody queries.
        skipped_settlements: (() => {
          const skipped = c.svc.credits.settlements(orgId, { status: 'skipped', limit: 200 });
          const gapped = skipped.filter((s) => (s.skip?.gaps ?? []).some((gap) => gap.overdue));
          const waiting = skipped.filter((s) => (s.skip?.gaps.length ?? 0) > 0 && !gapped.includes(s));
          return {
            count: skipped.length,
            fully_covered: skipped.length - gapped.length - waiting.length,
            awaiting_next_cycle: waiting.length,
            with_unbilled_gaps: gapped.length,
            unbilled_windows: gapped.slice(0, 10).map((s) => ({
              settlement: s.id, customer: s.customer, price: s.price,
              gaps: (s.skip?.gaps ?? []).filter((gap) => gap.overdue), summary: s.skip?.summary ?? null,
            })),
            contended_meters: contentionOf(skipped),
            recent: skipped.slice(0, 10).map((s) => ({
              id: s.id, customer: s.customer, price: s.price,
              subscription: s.subscription, subscription_item: s.subscription_item,
              period_start: s.period_start, period_end: s.period_end,
              reason: s.skip?.reason ?? null, superseded_by: s.skip?.superseded_by ?? null,
              coverage_percent: s.skip?.coverage_percent ?? null,
              summary: s.skip?.summary ?? null, at: s.created,
            })),
          };
        })(),
        settlements_skipped: c.svc.credits.settlements(orgId, { status: 'skipped', limit: 10 }).map((s) => ({
          settlement: s.id, reason: s.skip?.reason ?? 'usage_period_already_settled',
          customer: s.customer, price: s.price, subscription: s.subscription,
          period_start: s.period_start, period_end: s.period_end,
          message: s.skip?.message ?? '', summary: s.skip?.summary ?? null, at: s.created,
        })),
      };
    }, {
      summary: 'Outstanding credit, what is about to expire and what is waiting for an invoice', tags: ['credits'],
      description:
        '`skipped_settlements` is the honest half: periods the automatic run refused because their usage is already billed under another window. `fully_covered` lost nobody a cent — the usage is billed once, under the settlement named in `superseded_by`. `with_unbilled_gaps` is usage nothing has billed yet: the daily watch settles each of those windows on its own, so this is what is in flight rather than a queue somebody has to work through, and `contended_meters` names the customers holding more than one subscription item against the same metered price, which is the condition that causes it. `unbilled_purchases` is the other half: credit somebody bought that nothing has charged for yet, aged, with the grant it is holding unspendable until it clears.',
    });
  },

  tools(ctx) {
    return [
      {
        name: 'credits.balance',
        description: 'A customer’s credit balance, broken down per currency and per what it may be spent on, with the next expiry in each pot.',
        readOnly: true,
        tags: ['billing', 'credits'],
        input: v.object({ customer: v.string({ min: 1, max: 120 }) }),
        run: (args: { customer: string }, c: Ctx, meta) => c.svc.credits.balance(meta.orgId, args.customer),
      },
      {
        name: 'credits.explain_burn_order',
        description: 'The order credit grants are drawn down in, in words, so a customer question can be answered exactly.',
        readOnly: true,
        tags: ['billing', 'credits'],
        input: v.object({}),
        run: (_args: Record<string, never>, c: Ctx) => ({ object: 'credit_burn_order', order: c.svc.credits.burnOrder() }),
      },
      {
        name: 'credits.grant',
        description: 'Issue promotional or paid credit to a customer. Writes a grant and its opening ledger entry.',
        readOnly: false,
        requiresApproval: true,
        tags: ['billing', 'credits'],
        input: v.object({
          customer: v.string({ min: 1, max: 120 }),
          amount: v.int({ min: 1 }),
          currency: v.optional(v.currency()),
          name: v.optional(v.string({ max: 140 })),
          category: v.default(v.enum(CREDIT_CATEGORIES), 'promotional'),
          expires_at: v.optional(v.timestamp()),
          reason: v.optional(v.string({ max: 300 })),
        }),
        run: (args: GrantInput, c: Ctx, meta) => c.svc.credits.createGrant(meta.orgId, args),
      },
      {
        name: 'credits.unbilled_periods',
        description: 'Metered periods the automatic run refused to settle, and whether that cost anything — each one says how much of its window is billed elsewhere and which hours, if any, nothing has billed at all.',
        readOnly: true,
        tags: ['billing', 'credits'],
        input: v.object({ customer: v.optional(v.string({ max: 120 })), limit: v.optional(v.int({ min: 1, max: 100 })) }),
        run: (args: { customer?: string; limit?: number }, c: Ctx, meta) =>
          c.svc.credits.settlements(meta.orgId, { ...args, status: 'skipped' }).map((s) => ({
            settlement: s.id, customer: s.customer, price: s.price,
            subscription: s.subscription, subscription_item: s.subscription_item,
            period_start: s.period_start, period_end: s.period_end,
            superseded_by: s.skip?.superseded_by ?? null,
            coverage_percent: s.skip?.coverage_percent ?? null,
            unbilled_windows: (s.skip?.gaps ?? []).filter((gap) => gap.overdue),
            explanation: s.skip?.summary ?? null,
          })),
      },
      {
        name: 'credits.settlement_for_period',
        description: 'What a customer’s metered period cost, how much credit covered it, which grants paid and anything trued up since — the answer to “why is this line on my invoice?”.',
        readOnly: true,
        tags: ['billing', 'credits'],
        input: v.object({ customer: v.string({ min: 1, max: 120 }), limit: v.optional(v.int({ min: 1, max: 20 })) }),
        run: (args: { customer: string; limit?: number }, c: Ctx, meta) =>
          c.svc.credits.settlements(meta.orgId, { customer: args.customer, limit: args.limit ?? 5 }),
      },
    ];
  },

  /**
   * Stripe's load-bearing guarantee is that credit is applied at invoice
   * finalization and nobody has to ask. This is that: when an invoice is drawn
   * for a customer, the lines their credits have produced go onto it.
   */
  on: {
    /**
     * The event that actually fires.
     *
     * `invoice.created` is the right seam and it stays below, but nothing in
     * this build emits it — there is no invoicing module yet — so a settled
     * period used to be a row that waited forever. This is the event billing
     * really does publish, 445 times in a simulated year, and on it credits
     * announces what it is holding for that customer. The settled metered
     * lines now reach whoever draws the invoice on the same payload as the
     * recurring ones, today, with no other module needing to exist first.
     */
    'subscription.invoice_due': (event, ctx) => {
      const data = (event.data ?? {}) as {
        customer?: string; subscription?: string; currency?: string; reason?: string;
        period?: { start: number; end: number }; arrears_period?: { start: number; end: number } | null;
        lines?: unknown[]; pending_item_ids?: string[];
      };
      if (!data.customer) return;
      // Only when credits have something to say. A cycle with no metered line
      // and an empty outbox would announce an empty list, and an event that
      // carries nothing is a job somebody's queue runs for no reason.
      const metered = (data.lines ?? []).some((line) => (line as { metered?: boolean }).metered);
      const holding = metered
        || creditsStore(ctx).billableItems(event.org_id, { customer: data.customer, status: 'pending', limit: 1 }).length > 0;
      if (!holding) return;
      const period = data.period ?? null;
      const payload: InvoiceDueJob = {
        customer: data.customer,
        subscription: data.subscription ?? null,
        currency: data.currency ?? null,
        reason: data.reason ?? null,
        period,
        arrears_period: data.arrears_period ?? null,
        lines: data.lines ?? [],
        pending_item_ids: data.pending_item_ids ?? [],
      };
      ctx.enqueue(event.org_id, 'credits.publish_ready_items', payload, {
        runAt: ctx.now(),
        idemKey: `credits.publish:${data.subscription ?? data.customer}:${period?.start ?? 0}:${period?.end ?? 0}`,
      });
    },
    /**
     * And the claiming step, unchanged and still where it belongs: a line
     * leaves the outbox when an invoice takes it, not when one is announced.
     */
    'invoice.created': (event, ctx) => {
      const target = invoiceOf(event);
      if (target) creditsStore(ctx).drainOutbox(event.org_id, target.customer, target.invoice);
    },
    'invoice.finalized': (event, ctx) => {
      const target = invoiceOf(event);
      if (target) creditsStore(ctx).drainOutbox(event.org_id, target.customer, target.invoice);
    },
  },
});
