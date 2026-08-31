/**
 * Proration — the one function.
 *
 * `prorate()` is pure. It takes the subscription as it stands, the items it is
 * being moved to, and the instant the change takes effect, and returns the
 * lines that change produces. Nothing is written, nothing is read from the
 * database, and both `POST /v1/subscriptions/:id/preview` and the update path
 * call it with the same arguments — which is what makes a preview provably the
 * same arithmetic as the charge rather than a second implementation that
 * happens to agree today.
 *
 * The rules it encodes:
 *
 *  - A change at instant `t` credits the unused remainder of what the customer
 *    already holds and charges for the remainder of what they are moving to.
 *    Both fractions are whole milliseconds of the period, `(end - t) / (end -
 *    start)`, and each line is rounded exactly once, inside the pricing engine.
 *  - Because the denominator is always the *whole* period, a second change in
 *    the same cycle prorates against the first: the credit at `t2` is measured
 *    on what `t1` installed, and the two charges meet exactly at `t2` with no
 *    gap and no overlap.
 *  - Metered items are never prorated. They bill in arrears on the usage that
 *    actually happened, so scaling them by a fraction of the period would
 *    charge twice for the same events.
 *  - A trial is free time. Changing plans mid-trial moves the items and
 *    charges nothing.
 */
import { formatMoney, money } from '../../../shared/money';
import { addInterval, formatDuration, type Interval, type Period } from '../../../shared/time';
import type { LineBreakdownRow, Price, ProrationBehavior } from '../catalog/types';
import {
  describeCadence, isMetered, longDate, Pricebook, recurringLines, recurringSubtotal, remainingMillis,
  sameCadence, shortDate, type PricedItem,
} from './cycle';
import type { Cadence, ChangePreview, ProrationLine, RecurringLine, SubscriptionStatus } from './types';

/** One item as it exists now, or as it is being asked to exist. */
export interface ItemState {
  /** The subscription item id. Null for an item being added. */
  id: string | null;
  price: Price;
  quantity: number;
  /** The agreed amount on a negotiated (`custom`) price. */
  customUnitAmount?: number | null;
}

export interface ProrateInput {
  subscriptionId: string;
  currency: string;
  locale: string;
  status: SubscriptionStatus;
  /** The period credits are measured against — what the customer already paid for. */
  currentPeriod: Period;
  /** The period charges cover. Differs from `currentPeriod` only when the anchor is reset. */
  nextPeriod: Period;
  /** The whole interval `currentPeriod` is part of, and the day it lands on. */
  interval: Interval;
  anchorDay: number;
  before: ItemState[];
  after: ItemState[];
  prorationDate: number;
  behavior: ProrationBehavior;
  book: Pricebook;
  /** When the subscription is trialing, the instant the free time ends. */
  trialEnd?: number | null;
}

export interface ProrationSet {
  lines: ProrationLine[];
  /** Sum of the negative lines (<= 0). */
  creditTotal: number;
  /** Sum of the positive lines (>= 0). */
  chargeTotal: number;
  net: number;
  /** The exact fraction each side was scaled by, for display. */
  creditFraction: { numerator: number; denominator: number };
  chargeFraction: { numerator: number; denominator: number };
  notices: string[];
}

const EMPTY_FRACTION = { numerator: 0, denominator: 1 };

const sameItem = (a: ItemState, b: ItemState): boolean =>
  a.price.id === b.price.id
  && a.quantity === b.quantity
  && (a.customUnitAmount ?? null) === (b.customUnitAmount ?? null);

const samePeriod = (a: Period, b: Period): boolean => a.start === b.start && a.end === b.end;

/**
 * The exact fraction of a *whole interval* still ahead of `ts`, in milliseconds.
 *
 * The denominator is the interval the period belongs to, never the period's own
 * length. A first period that covers only part of an interval was only charged
 * for that part, so crediting it against its own length would hand back more
 * than was ever paid: a fortnight billed at 14/31 of the month, credited at
 * half of a whole month. Charged and credited now share one denominator, which
 * makes them add up — for a whole period the two numbers are identical anyway.
 *
 * The numerator can never exceed either the days the customer actually holds or
 * one whole interval. Nothing that writes a period can produce one longer than
 * its interval — `periodFraction` refuses to price such a period at all — so
 * the cap only ever bites on data written before that rule existed, and it bites
 * in the one safe direction: a credit is never larger than a whole interval.
 */
function unusedFraction(
  period: Period, ts: number, iv: Interval, anchorDay: number,
): { numerator: number; denominator: number } {
  const wholeStart = addInterval(period.end, { ...iv, count: -iv.count }, anchorDay);
  const denominator = Math.max(1, period.end - wholeStart);
  const held = Math.max(0, period.end - period.start);
  const numerator = Math.min(Math.max(period.end - ts, 0), held, denominator);
  return { numerator, denominator };
}

/** "12 x Growth operator seat" / "Telemetry Cloud Growth". */
function subject(book: Pricebook, price: Price, quantity: number): string {
  const label = book.label(price);
  return quantity > 1 ? `${quantity} x ${label}` : label;
}

/**
 * Turn one item and one fraction into a line. `sign` is -1 for the credit side
 * and +1 for the charge side; the pricing engine always returns a positive
 * amount, and the sign is applied to it and to every breakdown row, so the rows
 * still add up to the line.
 */
function lineFor(
  input: ProrateInput,
  item: ItemState,
  period: Period,
  fraction: { numerator: number; denominator: number },
  sign: 1 | -1,
): ProrationLine {
  const { book, currency, locale } = input;
  const custom = item.customUnitAmount ?? null;
  const full = book.compute(item.price, item.quantity, currency, { customUnitAmount: custom });
  const prorated = book.compute(item.price, item.quantity, currency, { proration: fraction, customUnitAmount: custom });
  const amount = sign * prorated.amount;
  const breakdown: LineBreakdownRow[] = prorated.breakdown.map((row) => ({ ...row, amount: sign * row.amount }));
  const covered = { start: Math.max(input.prorationDate, period.start), end: period.end };
  const when = shortDate(input.prorationDate, locale);
  const noun = sign < 0 ? 'Unused time on' : 'Remaining time on';
  const spent = sign < 0 ? 'unused' : 'remaining';

  return {
    object: 'proration_line',
    kind: sign < 0 ? 'unused_time' : 'remaining_time',
    description: `${noun} ${subject(book, item.price, item.quantity)} after ${when}`,
    explanation:
      `${formatMoney(money(full.amount, currency), { locale })} covers ${formatDuration(fraction.denominator)} ` +
      `(${longDate(period.start, locale)} to ${longDate(period.end, locale)}); ` +
      `${formatDuration(fraction.numerator)} of it ${spent} at ${when} ` +
      `= ${fraction.numerator}/${fraction.denominator} ms ` +
      `= ${formatMoney(money(amount, currency), { locale, signDisplay: 'always' })}`,
    subscription: input.subscriptionId,
    subscription_item: item.id,
    price: item.price.id,
    quantity: item.quantity,
    amount,
    currency,
    period: covered,
    proration: fraction,
    proration_date: input.prorationDate,
    breakdown,
  };
}

/**
 * The proration lines a change produces. Side-effect free: give it the same
 * inputs twice and it returns the same lines twice.
 */
export function prorate(input: ProrateInput): ProrationSet {
  const notices: string[] = [];
  const lines: ProrationLine[] = [];

  const anchorMoved = !samePeriod(input.currentPeriod, input.nextPeriod);
  const creditFraction = unusedFraction(input.currentPeriod, input.prorationDate, input.interval, input.anchorDay);
  // A period the anchor has moved onto starts here and runs a whole interval,
  // so it is charged in full; otherwise the charge covers the same remainder
  // the credit gave back, against the same denominator.
  const chargeFraction = anchorMoved ? remainingMillis(input.nextPeriod, input.prorationDate) : creditFraction;

  const beforeById = new Map(input.before.filter((i) => i.id).map((i) => [i.id as string, i]));
  const afterById = new Map(input.after.filter((i) => i.id).map((i) => [i.id as string, i]));

  const meteredSkipped: string[] = [];
  const collect = (
    side: ItemState[],
    sign: 1 | -1,
    period: Period,
    fraction: { numerator: number; denominator: number },
    counterparts: Map<string, ItemState>,
  ) => {
    for (const item of side) {
      const counterpart = item.id ? counterparts.get(item.id) : undefined;
      // An item that survives the change untouched keeps running: there is
      // nothing to give back and nothing to re-charge.
      if (counterpart && !anchorMoved && sameItem(item, counterpart)) continue;
      if (isMetered(item.price)) {
        const label = input.book.label(item.price);
        if (!meteredSkipped.includes(label)) meteredSkipped.push(label);
        continue;
      }
      if (fraction.numerator === 0) continue;
      const line = lineFor(input, item, period, fraction, sign);
      // A line worth nothing is noise, not information: a per-unit item moved
      // to quantity 0, or a fraction so small it rounds away. Dropping it on
      // the computed amount rather than on the quantity is what keeps a tiered
      // price with a tier-1 flat fee — which still costs money at quantity 0 —
      // credited and charged like everything else.
      if (line.amount === 0) continue;
      lines.push(line);
    }
  };

  const trialing = input.status === 'trialing'
    && input.trialEnd !== null && input.trialEnd !== undefined
    && input.prorationDate < input.trialEnd;

  if (input.behavior === 'none') {
    notices.push('Proration is off for this change, so nothing is credited or charged now — the new items bill in full on the next invoice.');
  } else if (trialing) {
    notices.push(`Trial time is free, so this change is not prorated. Billing starts on ${longDate(input.trialEnd as number, input.locale)}.`);
  } else if (input.status === 'canceled' || input.status === 'incomplete_expired') {
    notices.push('This subscription has ended, so there is nothing left in the period to prorate.');
  } else {
    collect(input.before, -1, input.currentPeriod, creditFraction, afterById);
    collect(input.after, +1, input.nextPeriod, chargeFraction, beforeById);
  }

  if (meteredSkipped.length) {
    notices.push(
      `Metered usage is never prorated — ${meteredSkipped.join(', ')} bills in arrears on the events actually recorded in the period.`,
    );
  }
  if (anchorMoved && lines.length) {
    notices.push('The billing cycle anchor moves to this instant, so the charge covers a full new period rather than the remainder of the old one.');
  }

  const creditTotal = lines.reduce((total, line) => (line.amount < 0 ? total + line.amount : total), 0);
  const chargeTotal = lines.reduce((total, line) => (line.amount > 0 ? total + line.amount : total), 0);

  return {
    lines,
    creditTotal,
    chargeTotal,
    net: creditTotal + chargeTotal,
    creditFraction: lines.length ? creditFraction : EMPTY_FRACTION,
    chargeFraction: lines.length ? chargeFraction : EMPTY_FRACTION,
    notices,
  };
}

/* --------------------------------- preview -------------------------------- */

export interface PreviewInput extends ProrateInput {
  customerId: string;
  customerBalance: number;
  /** Items in their final shape, carrying the ids the ones that exist will keep. */
  itemsAfter: PricedItem[];
  mrrBefore: number;
  mrrAfter: number;
  /** When the next invoice for the recurring items falls due. */
  nextInvoiceDate: number;
  /** The cadence the subscription bills on today. */
  intervalBefore: Cadence;
  /** The cadence it bills on afterwards — the new prices decide this, not the row. */
  intervalAfter: Cadence;
}

/**
 * The whole picture of a change: the prorations, what would be collected now,
 * what the next invoice looks like afterwards, and how recurring revenue moves.
 * The update path settles exactly the `lines` this returns.
 */
export function previewChange(input: PreviewInput): ChangePreview {
  const set = prorate(input);
  const lines: RecurringLine[] = recurringLines(
    input.itemsAfter,
    { start: input.nextPeriod.start, end: input.nextPeriod.end },
    { book: input.book, currency: input.currency, locale: input.locale },
  );

  // A negative proration set is a credit, and a credit is never a payment: it
  // lands on the customer's balance and reduces what the next invoice collects.
  const settles = input.behavior === 'always_invoice';
  const balanceApplied = set.net < 0 ? set.net : 0;
  const amountDueNow = settles && set.net > 0 ? set.net : 0;

  const notices = [...set.notices];
  if (!sameCadence(input.intervalBefore, input.intervalAfter)) {
    notices.push(
      `These items bill every ${describeCadence(input.intervalAfter)}, but this subscription bills every ` +
      `${describeCadence(input.intervalBefore)}. The cycle moves onto the new cadence from ` +
      `${longDate(input.prorationDate, input.locale)}, so the next period runs to ` +
      `${longDate(input.nextPeriod.end, input.locale)} and the invoice after that falls on the same date every ` +
      `${describeCadence(input.intervalAfter)}.`,
    );
  }
  if (balanceApplied < 0) {
    notices.push(
      `This change is worth ${formatMoney(money(-balanceApplied, input.currency), { locale: input.locale })} back to the customer. ` +
      'Credits are never paid out — it goes onto the account balance and comes off the next invoice.',
    );
  }
  if (!settles && set.net !== 0 && set.lines.length) {
    notices.push('These lines wait on the next invoice for this subscription. Use proration_behavior=always_invoice to bill them straight away.');
  }

  return {
    object: 'subscription_change_preview',
    subscription: input.subscriptionId,
    customer: input.customerId,
    currency: input.currency,
    proration_date: input.prorationDate,
    proration_behavior: input.behavior,
    current_period: { start: input.currentPeriod.start, end: input.currentPeriod.end },
    next_period: { start: input.nextPeriod.start, end: input.nextPeriod.end },
    interval_before: input.intervalBefore,
    interval_after: input.intervalAfter,
    lines: set.lines,
    credit_total: set.creditTotal,
    charge_total: set.chargeTotal,
    net: set.net,
    amount_due_now: amountDueNow,
    balance_applied: balanceApplied,
    customer_balance_before: input.customerBalance,
    customer_balance_after: input.customerBalance + balanceApplied,
    next_invoice: {
      date: input.nextInvoiceDate,
      currency: input.currency,
      subtotal: recurringSubtotal(lines),
      lines,
    },
    items_after: input.itemsAfter.map((item) => {
      const price = input.book.price(item.price);
      return {
        price: price.id,
        quantity: item.quantity,
        metered: isMetered(price),
        description: subject(input.book, price, item.quantity),
      };
    }),
    mrr_before: input.mrrBefore,
    mrr_after: input.mrrAfter,
    mrr_delta: input.mrrAfter - input.mrrBefore,
    notices,
  };
}
