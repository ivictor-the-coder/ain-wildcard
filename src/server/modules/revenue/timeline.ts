/**
 * What every subscription's recurring revenue was worth, at any instant.
 *
 * This is the one primitive the whole module is built on, and it is built to
 * agree with billing rather than to have an opinion of its own:
 *
 *  - **The value today is billing's own number.** `subscriptionMrr()` and
 *    `countsAsRevenue()` are imported from `billing/`, not reimplemented, so
 *    `GET /v1/revenue/mrr` and `GET /v1/subscriptions/overview` can never drift
 *    apart. There is a test that asserts exactly that.
 *  - **The past is reached by walking backwards from today** through the
 *    contract changes billing actually recorded. Every mid-cycle change writes
 *    a proration set to `billing_pending_items` — a credit line for what the
 *    customer held and a charge line for what they moved to, each naming its
 *    price and quantity — so the whole-period value of the change is priced by
 *    the same engine that priced the change itself, and MRR steps on the day
 *    the change landed rather than at the next renewal.
 *  - **Normalisation is exact.** An annual price is divided by twelve as a
 *    BigInt rational and rounded once, per item, in the same order billing
 *    rounds it. `£1,188.00/year` is `£99.00/month`, and `£1,187.99/year` is
 *    `£99.00/month` too — because that is what rounding once means.
 *
 * What it deliberately does not do: invent history it cannot read. A change
 * made with `proration_behavior=none` writes no dated line, so it moves MRR at
 * the next renewal, and the `basis` block on every endpoint says so.
 */
import type { Ctx } from '../../kernel/context';
import { money, mulFraction, rat, ratMul, ratRound } from '../../../shared/money';
import type { IntervalUnit } from '../../../shared/time';
import { Pricebook, isMetered, isRecurring, subscriptionMrr } from '../billing/cycle';
import { countsAsRevenue, isTerminal } from '../billing/status';
import type { Price } from '../catalog/types';
import type { Subscription, SubscriptionStatus } from '../billing/types';

/** The end of an open-ended segment. Comparable, and safe to serialise. */
export const OPEN_ENDED = Number.MAX_SAFE_INTEGER;

/**
 * Weeks and days per month as exact fractions — the same table `billing/cycle`
 * uses, so a weekly plan normalises to the same cent in both modules.
 */
const NORMALISERS: Record<IntervalUnit, { numerator: number; denominator: number }> = {
  month: { numerator: 1, denominator: 1 },
  year: { numerator: 1, denominator: 12 },
  week: { numerator: 52, denominator: 12 },
  day: { numerator: 365, denominator: 12 },
};

/**
 * One item's whole-interval amount as a monthly figure, rounded once — the
 * same fraction, in the same order, that `billing/cycle` applies per item.
 */
export function toMonthly(amount: number, currency: string, unit: IntervalUnit, count: number): number {
  const norm = NORMALISERS[unit];
  return mulFraction(money(amount, currency), norm.numerator, norm.denominator * Math.max(1, count)).amount;
}

/** ARR is twelve months of MRR. Integer minor units, no rounding to do. */
export const annualise = (mrr: number): number => mrr * 12;

/**
 * The part of a subscription's monthly value that is gross of tax.
 *
 * MRR is what the contract says, and on a `tax_behavior: inclusive` price what
 * the contract says includes the tax that will be remitted — so that part of
 * MRR is larger than the revenue the same money will be recognised at. Two
 * accounts on identical 49,900 prices, one inclusive, contribute the same
 * 49,900 to MRR and 41,583 and 49,900 to recognised revenue, and a report that
 * puts both figures on one screen owes the reader the reason.
 *
 * This is that reason, and it is only the base: the *rate* depends on where the
 * account is registered and is resolved when the invoice is raised, never
 * against a contract. Item by item, in the same order and with the same single
 * rounding `subscriptionMrr()` uses, so the part can never exceed the whole.
 */
export function taxInclusiveMrr(sub: Subscription, book: Pricebook): number {
  let total = 0;
  for (const item of sub.items) {
    const price = book.find(item.price);
    if (!price || isMetered(price) || !isRecurring(price)) continue;
    if (price.tax_behavior !== 'inclusive') continue;
    const line = book.compute(price, item.quantity, sub.currency, { customUnitAmount: item.custom_unit_amount });
    total += toMonthly(line.amount, sub.currency, sub.interval, sub.interval_count);
  }
  return total;
}

/* ---------------------------- contract changes ---------------------------- */

export interface ContractChange {
  subscription: string;
  customer: string;
  currency: string;
  /** The instant the change took effect — billing's `proration_date`. */
  at: number;
  /** Monthly minor units this change added (negative for a downgrade). */
  delta: number;
  /** Whole-interval monthly value of what was moved to. */
  charged: number;
  /** Whole-interval monthly value of what was given back. */
  credited: number;
  lines: number;
  /**
   * True when a line's whole-interval amount had to be recovered from the
   * fraction it was scaled by rather than re-priced — a negotiated price whose
   * agreed amount does not live on the proration row. The number is still
   * exact to the cent it was rounded at; it just came the long way round.
   */
  reconstructed: boolean;
}

interface ProrationRow {
  subscription_id: string;
  customer_id: string;
  currency: string;
  price_id: string;
  quantity: number;
  amount: number;
  kind: string;
  proration_date: number;
  proration_numerator: number;
  proration_denominator: number;
}

/**
 * The whole-interval amount behind one proration line.
 *
 * Re-pricing beats un-scaling: the line was rounded once when it was written,
 * and dividing a rounded number by a fraction as small as 1/30 would multiply
 * that half-cent by thirty. So the price is asked again for the whole interval,
 * exactly as `recurringLines()` asks it, and un-scaling is only the fallback
 * for a negotiated amount that is not on the row.
 */
function wholeIntervalAmount(
  book: Pricebook, row: ProrationRow,
): { amount: number; price: Price | null; reconstructed: boolean } {
  const price = book.find(row.price_id);
  if (price && price.model !== 'custom') {
    try {
      return { amount: book.compute(price, row.quantity, row.currency).amount, price, reconstructed: false };
    } catch {
      /* fall through to the fraction */
    }
  }
  const numerator = Math.abs(row.proration_numerator);
  const denominator = Math.abs(row.proration_denominator);
  if (!numerator || !denominator) return { amount: Math.abs(row.amount), price, reconstructed: true };
  const scaled = ratMul(rat(BigInt(Math.abs(row.amount))), rat(denominator, numerator));
  return { amount: Number(ratRound(scaled, 'half_up')), price, reconstructed: true };
}

/**
 * Every dated contract change in the workspace, grouped into the sets billing
 * wrote them in. A set is one change: the credits and the charges that were
 * computed together against the same instant.
 */
export function readContractChanges(ctx: Ctx, orgId: string, book: Pricebook): Map<string, ContractChange[]> {
  const rows = ctx.db.all<ProrationRow>(
    `SELECT subscription_id, customer_id, currency, price_id, quantity, amount, kind,
            proration_date, proration_numerator, proration_denominator
       FROM billing_pending_items
      WHERE org_id = ?
        AND subscription_id IS NOT NULL
        AND kind IN ('unused_time', 'remaining_time')
        AND status IN ('pending', 'invoiced')
      ORDER BY subscription_id, proration_date, rowid`,
    orgId,
  );

  const bySubscription = new Map<string, ContractChange[]>();
  let current: ContractChange | null = null;
  for (const row of rows) {
    const at = Number(row.proration_date);
    if (!current || current.subscription !== row.subscription_id || current.at !== at) {
      current = {
        subscription: row.subscription_id,
        customer: row.customer_id,
        currency: row.currency,
        at,
        delta: 0,
        charged: 0,
        credited: 0,
        lines: 0,
        reconstructed: false,
      };
      const list = bySubscription.get(row.subscription_id);
      if (list) list.push(current); else bySubscription.set(row.subscription_id, [current]);
    }
    const { amount, price, reconstructed } = wholeIntervalAmount(book, row);
    // A metered line is never prorated, so one here would be a line from a
    // different world; skip it rather than let usage leak into MRR.
    if (price && (isMetered(price) || !isRecurring(price))) continue;
    const unit = price?.recurring?.interval ?? 'month';
    const count = price?.recurring?.interval_count ?? 1;
    const monthly = toMonthly(amount, row.currency, unit, count);
    if (row.kind === 'remaining_time') { current.charged += monthly; current.delta += monthly; }
    else { current.credited += monthly; current.delta -= monthly; }
    current.lines += 1;
    if (reconstructed) current.reconstructed = true;
  }
  return bySubscription;
}

/* -------------------------------- timelines ------------------------------- */

export interface MrrSegment {
  from: number;
  /** Exclusive. `OPEN_ENDED` while the subscription is still running. */
  to: number;
  mrr: number;
}

export interface SubscriptionTimeline {
  subscription: string;
  customer: string;
  currency: string;
  status: SubscriptionStatus;
  interval: IntervalUnit;
  interval_count: number;
  /** The first instant this subscription was recurring revenue. */
  live_from: number;
  /** The first instant it stopped being. `OPEN_ENDED` while it runs. */
  live_to: number;
  /** Why it stopped, when it has. */
  ended_because: 'canceled' | 'collection_paused' | 'never_started' | null;
  /**
   * Every stretch of paused collection this subscription has had, dated from
   * the event log. The segments below have the closed ones cut out of them.
   */
  pauses: PauseWindow[];
  /** Billing's own figure for today, in monthly minor units. */
  current_mrr: number;
  /**
   * How much of `current_mrr` sits on tax-inclusive prices, and is therefore
   * gross of a tax that revenue recognition will book net.
   */
  tax_inclusive_mrr: number;
  /**
   * What the contract is worth a month regardless of status — the figure a
   * trialing or paused subscription would contribute if it were recognised.
   */
  contracted_mrr: number;
  segments: MrrSegment[];
  changes: ContractChange[];
}

/* -------------------------------- pauses ---------------------------------- */

/** One stretch of paused collection. `to` is `OPEN_ENDED` while it is still on. */
export interface PauseWindow {
  from: number;
  to: number;
  /** True when the instant came from `updated` because no event row was found. */
  inferred: boolean;
}

/**
 * When collection was paused, read from the event log rather than from the row.
 *
 * `pause_collection` records no instant, so this module used to date a pause at
 * `subscription.updated` — the last time anything wrote the row. That made
 * history mutable: a `keep_as_draft` renewal two months later rewrote `updated`,
 * and two closed months of MRR appeared retroactively where there had been
 * none. The event log does record the instant, exactly once, and never moves it:
 * `subscription.paused` is emitted inside the same transaction that sets the
 * status, and `subscription.resumed` when collection comes back.
 *
 * A row with no event — one seeded straight into the table, or paused before
 * this log existed — still falls back to `updated`, and says so with
 * `inferred: true` so the caller can tell a read date from a guessed one.
 */
export function readCollectionPauses(ctx: Ctx, orgId: string): Map<string, PauseWindow[]> {
  const rows = ctx.db.all<{ object_id: string; type: string; created: number }>(
    `SELECT object_id, type, created FROM events
      WHERE org_id = ? AND object_type = 'subscription'
        AND type IN ('subscription.paused', 'subscription.resumed')
      ORDER BY object_id, created, rowid`,
    orgId,
  );

  const windows = new Map<string, PauseWindow[]>();
  for (const row of rows) {
    if (!row.object_id) continue;
    const list = windows.get(row.object_id) ?? [];
    if (!windows.has(row.object_id)) windows.set(row.object_id, list);
    const open = list.length && list[list.length - 1].to === OPEN_ENDED ? list[list.length - 1] : null;
    if (row.type === 'subscription.paused') {
      // A second pause with no resume between them is the same pause: keep the
      // first instant, which is the one collection actually stopped at.
      if (!open) list.push({ from: Number(row.created), to: OPEN_ENDED, inferred: false });
    } else if (open) {
      open.to = Math.max(open.from, Number(row.created));
    }
  }
  return windows;
}

/** Remove every closed pause window from a set of segments. */
function carve(segments: MrrSegment[], windows: PauseWindow[]): MrrSegment[] {
  let out = segments;
  for (const window of windows) {
    if (window.to === OPEN_ENDED || window.to <= window.from) continue;
    const next: MrrSegment[] = [];
    for (const segment of out) {
      if (window.to <= segment.from || window.from >= segment.to) { next.push(segment); continue; }
      if (segment.from < window.from) next.push({ from: segment.from, to: window.from, mrr: segment.mrr });
      if (window.to < segment.to) next.push({ from: window.to, to: segment.to, mrr: segment.mrr });
    }
    out = next;
  }
  return out;
}

/**
 * When a subscription stopped being recurring revenue, and why.
 *
 * `ended_at` is durable and exact. A collection pause has no column of its own,
 * so it is dated from the `subscription.paused` event — durable, written once,
 * and never rewritten by a later renewal — falling back to `updated` only for a
 * row the log has nothing for. Which of the two was used is reported per
 * subscription in `pause.inferred` rather than left to be assumed.
 */
function endOf(sub: Subscription, windows: PauseWindow[]): {
  at: number; because: SubscriptionTimeline['ended_because']; pause: PauseWindow | null;
} {
  if (sub.status === 'incomplete' || sub.status === 'incomplete_expired') {
    return { at: -1, because: 'never_started', pause: null };
  }
  if (isTerminal(sub.status)) {
    return { at: sub.ended_at ?? sub.canceled_at ?? sub.updated, because: 'canceled', pause: null };
  }
  if (sub.status === 'paused') {
    const open = windows.find((window) => window.to === OPEN_ENDED)
      ?? { from: sub.updated, to: OPEN_ENDED, inferred: true };
    return { at: open.from, because: 'collection_paused', pause: open };
  }
  return { at: OPEN_ENDED, because: null, pause: null };
}

/** The first instant a subscription bills: free trial time is not revenue. */
function startOf(sub: Subscription): number {
  if (sub.trial_end !== null && sub.trial_end > sub.start_date) return sub.trial_end;
  return sub.start_date;
}

export function buildTimeline(
  sub: Subscription, book: Pricebook, changes: ContractChange[], pauses: PauseWindow[] = [],
): SubscriptionTimeline {
  const contracted = subscriptionMrr(sub, book);
  const liveFrom = startOf(sub);
  const end = endOf(sub, pauses);
  const liveTo = Math.max(liveFrom, end.at);
  const applicable = changes
    .filter((change) => change.at > liveFrom && change.at < liveTo && change.delta !== 0)
    .sort((a, b) => a.at - b.at);

  let segments: MrrSegment[] = [];
  if (end.because !== 'never_started' && liveTo > liveFrom) {
    // Walk backwards: today's contract minus every change made since.
    const values: number[] = new Array(applicable.length + 1);
    values[applicable.length] = contracted;
    for (let i = applicable.length - 1; i >= 0; i--) values[i] = values[i + 1] - applicable[i].delta;
    const bounds = [liveFrom, ...applicable.map((change) => change.at), liveTo];
    for (let i = 0; i < values.length; i++) {
      if (bounds[i + 1] <= bounds[i]) continue;
      segments.push({ from: bounds[i], to: bounds[i + 1], mrr: values[i] });
    }
    // A pause that has already ended is a hole in the timeline, not an end of
    // it: the months either side of it are unaffected, and the months inside it
    // earned nothing.
    segments = carve(segments, pauses);
  }

  return {
    subscription: sub.id,
    customer: sub.customer,
    currency: sub.currency,
    status: sub.status,
    interval: sub.interval,
    interval_count: sub.interval_count,
    live_from: liveFrom,
    live_to: end.because === 'never_started' ? liveFrom : liveTo,
    ended_because: end.because,
    pauses: end.pause && !pauses.includes(end.pause) ? [...pauses, end.pause] : pauses,
    current_mrr: countsAsRevenue(sub.status) ? contracted : 0,
    tax_inclusive_mrr: countsAsRevenue(sub.status) ? taxInclusiveMrr(sub, book) : 0,
    contracted_mrr: contracted,
    segments,
    changes: applicable,
  };
}

export const mrrAt = (timeline: SubscriptionTimeline, at: number): number => {
  for (const segment of timeline.segments) {
    if (at >= segment.from && at < segment.to) return segment.mrr;
  }
  return 0;
};
