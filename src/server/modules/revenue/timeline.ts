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
  /** Billing's own figure for today, in monthly minor units. */
  current_mrr: number;
  /**
   * What the contract is worth a month regardless of status — the figure a
   * trialing or paused subscription would contribute if it were recognised.
   */
  contracted_mrr: number;
  segments: MrrSegment[];
  changes: ContractChange[];
}

/**
 * When a subscription stopped being recurring revenue, and why.
 *
 * `ended_at` is durable and exact. A collection pause is neither — billing
 * records no instant for it — so the pause is dated at `updated`, the last time
 * the row was written, which is the instant `pauseSubscription()` set it. That
 * is stated in every `basis` block rather than buried here, because it is the
 * one date in this module that is inferred rather than read.
 */
function endOf(sub: Subscription): { at: number; because: SubscriptionTimeline['ended_because'] } {
  if (sub.status === 'incomplete' || sub.status === 'incomplete_expired') {
    return { at: -1, because: 'never_started' };
  }
  if (isTerminal(sub.status)) {
    return { at: sub.ended_at ?? sub.canceled_at ?? sub.updated, because: 'canceled' };
  }
  if (sub.status === 'paused') return { at: sub.updated, because: 'collection_paused' };
  return { at: OPEN_ENDED, because: null };
}

/** The first instant a subscription bills: free trial time is not revenue. */
function startOf(sub: Subscription): number {
  if (sub.trial_end !== null && sub.trial_end > sub.start_date) return sub.trial_end;
  return sub.start_date;
}

export function buildTimeline(
  sub: Subscription, book: Pricebook, changes: ContractChange[],
): SubscriptionTimeline {
  const contracted = subscriptionMrr(sub, book);
  const liveFrom = startOf(sub);
  const end = endOf(sub);
  const liveTo = Math.max(liveFrom, end.at);
  const applicable = changes
    .filter((change) => change.at > liveFrom && change.at < liveTo && change.delta !== 0)
    .sort((a, b) => a.at - b.at);

  const segments: MrrSegment[] = [];
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
    current_mrr: countsAsRevenue(sub.status) ? contracted : 0,
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
