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
import type { AutomaticTax, Cadence, ChangePreview, ProrationLine, RecurringLine, SubscriptionStatus } from './types';

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
  /**
   * The rate engine, as the bill will run it on these exact lines: the base
   * they will be recorded at and the tax beside it. `prorate()` is pure
   * arithmetic on list prices and stays that way; everything this preview
   * publishes as *money that moves* is priced through here instead, because a
   * figure taken off the price list and shown to a human as "collected now" is
   * short by the tax on every exclusive-priced account in the book.
   */
  taxOf(lines: { price: string | null; amount: number; currency: string }[]): { base: number; tax: number };
  /**
   * Whether a bill for this account can be placed. Read from the same call the
   * invoice makes, so a preview cannot promise a collection the bill it
   * predicts will be held back from making.
   */
  automaticTax: AutomaticTax;
  /**
   * Invoice items already waiting for this customer's next bill. An
   * `always_invoice` change sweeps them onto the bill it raises, so they are
   * part of what that bill collects — and of `amount_due_now`.
   */
  waitingLines?: { price: string | null; amount: number; currency: string }[];
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

  // Every proration line goes onto a bill, whichever way the set nets, so the
  // rate engine taxes a credit exactly as it taxed the charge it reverses.
  //
  // `net` is the lines' own arithmetic and stays pre-tax — the notices say so,
  // and it is what `credit_total` and `charge_total` are made of. What is
  // *collected* is not that number: `always_invoice` raises a bill, and a bill
  // is `base + tax + whatever the account balance settles`, floored at zero.
  // Publishing the pre-tax net as "collected now" understated a $75.00 upgrade
  // on a New York account by the $6.38 the card was actually charged, and the
  // screen that reads this field prints it on the button that takes the money.
  // So it is priced the way the invoice will price it, through the invoice's
  // own call.
  //
  // The bill is raised for exactly these lines whenever the behaviour settles
  // and there are any, which is the condition read here. Reading it as "and the
  // lines net positive" instead was the same mistake sign-flipped: a downgrade
  // that credits $200.00 against an account carrying $400.00 forward raises a
  // bill that collects $188.50, and the preview answered $0.00 for it — on the
  // same button, one direction over.
  const settles = input.behavior === 'always_invoice';
  // The bill sweeps what was already waiting along with these lines, so what
  // it collects is priced over both — the same claim `issue()` makes.
  const swept = settles && set.lines.length ? input.waitingLines ?? [] : [];
  const dueNow = settles && set.lines.length
    ? input.taxOf([
      ...set.lines.map((line) => ({ price: line.price, amount: line.amount, currency: line.currency })),
      ...swept,
    ])
    : null;
  const taxDueNow = dueNow ? dueNow.tax : 0;
  // The balance is drawn down by this bill and can never take it below zero,
  // exactly as `Invoices.issue()` decides it — so an account holding more
  // credit than the change is worth is collected from for nothing, and an
  // account that owes more than the change hands back still owes the rest.
  const amountDueNow = dueNow ? Math.max(0, dueNow.base + dueNow.tax + input.customerBalance) : 0;

  // The recurring fee for the period after the change, on the basis the bill
  // will record it: the taxable base, and the tax beside it. A tax-inclusive
  // price already contains its tax, so quoting the list price here as
  // `subtotal` states €250.00 for a bill whose subtotal will say €210.08 —
  // the same mistake, one panel over, that `next_invoice` on the customer
  // summary was carrying. `subtotal + tax` is the listed price either way.
  const billable = lines.filter((line) => !line.metered && line.amount !== null);
  const nextTaxed = input.taxOf(billable.map((line) => ({
    price: line.price, amount: line.amount as number, currency: line.currency,
  })));

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
  if (set.net < 0) {
    notices.push(
      `This change is worth ${formatMoney(money(-set.net, input.currency), { locale: input.locale })} back to the customer before tax. ` +
      'Credits are never paid out — the lines go onto a bill, which taxes them exactly as it taxed the charge they reverse, ' +
      `and whatever ${settles ? 'that bill' : 'the next invoice'} cannot absorb stays on the account balance.`,
    );
  }
  if (!settles && set.net !== 0 && set.lines.length) {
    notices.push('These lines wait on the next invoice for this subscription. Use proration_behavior=always_invoice to bill them straight away.');
  }
  if (swept.length) {
    const waiting = swept.reduce((total, line) => total + line.amount, 0);
    notices.push(
      `${swept.length} invoice item${swept.length === 1 ? '' : 's'} already waiting for this customer's next bill ` +
      `(${formatMoney(money(waiting, input.currency), { locale: input.locale })} before tax) ${swept.length === 1 ? 'is' : 'are'} billed on this one too, ` +
      'so amount_due_now covers more than the lines above.',
    );
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
    tax_due_now: taxDueNow,
    automatic_tax: input.automaticTax,
    customer_balance: input.customerBalance,
    next_invoice: {
      date: input.nextInvoiceDate,
      currency: input.currency,
      subtotal: nextTaxed.base,
      tax: nextTaxed.tax,
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
