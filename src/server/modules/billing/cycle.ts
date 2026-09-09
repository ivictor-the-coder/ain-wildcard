/**
 * Billing-cycle arithmetic: anchors, periods, recurring lines and MRR.
 *
 * The anchor is the whole trick. A subscription stores the instant its cycle is
 * measured from *and* the day of the month it wants (1–31) separately, so a
 * subscription anchored on the 31st bills the 28th in February and returns to
 * the 31st in March instead of silently drifting to the 28th forever.
 */
import type { Ctx } from '../../kernel/context';
import { badRequest } from '../../../shared/errors';
import { mulFraction, money, type Money } from '../../../shared/money';
import {
  addInterval, daysInMonth, formatDate, interval as makeInterval, periodFor,
  type Interval, type IntervalUnit, type Period,
} from '../../../shared/time';
import type { Coupon, LineAmount, Price, Product } from '../catalog/types';
import { Discounts } from './discounts';
import type { Cadence, RecurringLine, Subscription } from './types';

/* ------------------------------- the pricebook ---------------------------- */

/**
 * A per-request view of the catalog with memoised lookups. Subscriptions touch
 * the same handful of prices over and over — once per item, per line, per
 * preview — and every one of those has to be the same object.
 */
export interface ComputeInput {
  proration?: { numerator: number; denominator: number } | null;
  /** Required for a negotiated (`custom`) price; rejected for any other. */
  customUnitAmount?: number | null;
}

export class Pricebook {
  private readonly prices = new Map<string, Price>();
  private readonly products = new Map<string, Product | null>();
  private discountIndex: { bySubscription: Map<string, Coupon>; byCustomer: Map<string, Coupon> } | null = null;

  constructor(private readonly ctx: Ctx, private readonly orgId: string) {}

  /**
   * The coupon still reducing what a subscription is worth, or null.
   *
   * Read as one index the first time it is asked for, because the callers that
   * ask walk hundreds of subscriptions and the answer changes for none of them
   * mid-loop. A subscription's own discount beats the account's, exactly as the
   * invoice decides it — a run rate that netted one concession while the bill
   * applied another would be a forecast of a bill nobody sends.
   */
  runningDiscount(subscriptionId: string | null, customerId: string | null): Coupon | null {
    if (!subscriptionId && !customerId) return null;
    if (!this.discountIndex) this.discountIndex = new Discounts(this.ctx).runningIndex(this.orgId, this.ctx.now());
    return (subscriptionId ? this.discountIndex.bySubscription.get(subscriptionId) : undefined)
      ?? (customerId ? this.discountIndex.byCustomer.get(customerId) : undefined)
      ?? null;
  }

  price(id: string): Price {
    let found = this.prices.get(id);
    if (!found) { found = this.ctx.svc.catalog.requirePrice(this.orgId, id); this.prices.set(id, found); }
    return found;
  }

  find(id: string): Price | null {
    try { return this.price(id); } catch { return null; }
  }

  product(price: Price): Product | null {
    if (!this.products.has(price.product)) {
      this.products.set(price.product, this.ctx.svc.catalog.product(this.orgId, price.product));
    }
    return this.products.get(price.product) ?? null;
  }

  /**
   * The name a human would use for this line on an invoice.
   *
   * The product's own name is right for the plan it sells — "Telemetry Cloud
   * Growth" — but wrong for the seats and add-ons that hang off the same
   * product, which is exactly what a price nickname is for. The product's
   * default price speaks for the product; every other price speaks for itself.
   */
  label(price: Price): string {
    const product = this.product(price);
    if (product && product.default_price === price.id && product.name) return product.name;
    return price.nickname || product?.name || price.lookup_key || price.id;
  }

  unitLabel(price: Price): string | null {
    return this.product(price)?.unit_label ?? null;
  }

  /**
   * How much of one coupon each of these amounts carries, in minor units.
   *
   * The catalogue does the arithmetic — one rounding, half up, on the discount
   * itself, and the per-line shares reconciled to it by largest remainder — so
   * a discount taken off a run rate rounds the way the same discount rounds on
   * the invoice, rather than a second implementation that agrees until it does
   * not.
   */
  discountShares(coupon: Coupon, lines: { price: string; amount: number }[], currency: string): number[] {
    if (!lines.length) return [];
    const applied = this.ctx.svc.catalog.distributeDiscount(
      coupon,
      lines.map((line) => ({ price: line.price, product: this.find(line.price)?.product ?? null, amount: line.amount })),
      currency,
    );
    return applied.lines.map((line) => line.discount);
  }

  /**
   * The one call into the pricing engine. Everything a line needs travels
   * together: the fraction of the period, the negotiated amount for a `custom`
   * price, and the product's unit label so the breakdown reads in the
   * customer's own nouns.
   */
  compute(price: Price, quantity: number, currency: string, opts: ComputeInput = {}): LineAmount {
    return this.ctx.svc.catalog.compute(price, quantity, currency, {
      unitLabel: this.unitLabel(price),
      proration: opts.proration ?? null,
      customUnitAmount: opts.customUnitAmount ?? null,
    });
  }
}

/* --------------------------------- intervals ------------------------------ */

export const isMetered = (price: Price): boolean => price.recurring?.usage_type === 'metered';

export const isRecurring = (price: Price): boolean => price.type === 'recurring' && !!price.recurring;

/**
 * A flat price is one fee for the whole subscription — the pricing engine bills
 * it identically at any quantity. Letting a quantity ride along on it means the
 * two halves of the module disagree: proration reads "0 seats, credit it all
 * back" while the recurring line goes on charging the fee in full. Quantity is
 * refused rather than ignored, the same way it is on a metered price.
 */
export function assertFlatQuantity(price: Price, quantity: number, param: string): void {
  if (price.model !== 'flat' || quantity === 1) return;
  throw badRequest(
    'flat_price_quantity',
    `Price ${price.id} is a flat fee for the whole subscription, so its quantity is always 1 — ${quantity} would bill exactly the same. Move to a per-unit price if this line should scale, or remove the item to stop charging for it.`,
    param,
  );
}

export function intervalOf(sub: Cadence): Interval {
  return makeInterval(sub.interval, sub.interval_count);
}

export const sameCadence = (a: Cadence, b: Cadence): boolean =>
  a.interval === b.interval && a.interval_count === b.interval_count;

export const describeCadence = (c: Cadence): string => describeInterval(c.interval_count, c.interval);

/** An anchor day only names a day of the month, so only these cycles have one. */
export const cadenceHasAnchorDay = (unit: IntervalUnit): boolean => unit === 'month' || unit === 'year';

/** 1–31, taken from the anchor unless the caller pinned a different day. */
export const anchorDayOf = (ts: number): number => new Date(ts).getUTCDate();

/**
 * The first instant at or after `ts` that lands on `day` of the month, keeping
 * the time of day and clamping to the length of a short month.
 *
 * This is what keeps an anchor honest. `periodFor` steps from the anchor to the
 * anchor day in the following month, so an anchor whose own date is the 1st
 * while its anchor day is the 15th produces a *forty-five day* first period —
 * one month's price for a month and a half. Snapping the anchor onto its own
 * day makes the first period run from the start date to the 15th, which is
 * exactly what naming the anchor as a timestamp already does.
 */
export function snapToAnchorDay(ts: number, day: number): number {
  const d = new Date(ts);
  const on = (year: number, month: number): number => Date.UTC(
    year, month, Math.min(day, daysInMonth(year, month)),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
  );
  const here = on(d.getUTCFullYear(), d.getUTCMonth());
  if (here >= ts) return here;
  const next = d.getUTCFullYear() * 12 + d.getUTCMonth() + 1;
  return on(Math.floor(next / 12), next % 12);
}

/**
 * Whether an anchor instant lands on the day the cycle claims. The last day of
 * a short month satisfies a higher anchor day: a cycle on the 31st anchored in
 * February is anchored on the 28th and still means the 31st.
 */
export function anchorLandsOnDay(anchor: number, day: number): boolean {
  const d = new Date(anchor);
  const own = d.getUTCDate();
  return own === day || (own === daysInMonth(d.getUTCFullYear(), d.getUTCMonth()) && day > own);
}

/**
 * Every recurring item on one subscription must bill on the same cycle —
 * otherwise "the current period" has no single meaning. Metered items are held
 * to the same rule because their arrears window is that same period.
 */
export function resolveInterval(prices: Price[]): Cadence {
  const recurring = prices.filter(isRecurring);
  if (!recurring.length) {
    throw badRequest(
      'subscription_requires_recurring_price',
      'A subscription needs at least one recurring price. One-time prices belong on an invoice, not a subscription.',
      'items',
    );
  }
  const first = recurring[0].recurring!;
  for (const price of recurring) {
    const r = price.recurring!;
    if (r.interval !== first.interval || r.interval_count !== first.interval_count) {
      throw badRequest(
        'subscription_interval_mismatch',
        `Every price on a subscription must share one billing interval. ${recurring[0].id} bills every ${describeInterval(first.interval_count, first.interval)} but ${price.id} bills every ${describeInterval(r.interval_count, r.interval)}.`,
        'items',
      );
    }
  }
  return { interval: first.interval, interval_count: first.interval_count };
}

export function describeInterval(count: number, unit: IntervalUnit): string {
  return count === 1 ? unit : `${count} ${unit}s`;
}

/* ---------------------------------- periods ------------------------------- */

/** The period containing `ts` for a cycle anchored at `anchor` on `anchorDay`. */
export function periodAt(anchor: number, iv: Interval, ts: number, anchorDay: number): Period {
  return periodFor(anchor, iv, ts, anchorDay);
}

/**
 * The exact fraction of `period` still ahead of `ts`, in milliseconds.
 * This is the only fraction proration ever uses: numerator and denominator are
 * both whole milliseconds, so the arithmetic is exact and the rounding happens
 * once, inside the pricing engine.
 */
export function remainingMillis(period: Period, ts: number): { numerator: number; denominator: number } {
  const denominator = Math.max(1, period.end - period.start);
  const numerator = Math.min(Math.max(period.end - ts, 0), denominator);
  return { numerator, denominator };
}

/* ------------------------------- recurring lines -------------------------- */

/**
 * The least a line needs to be priced. A real subscription item satisfies it,
 * and so does an item a preview is only proposing — which is how the preview
 * shows the next invoice for a subscription that has not been changed yet.
 */
export interface PricedItem {
  id: string | null;
  price: string;
  quantity: number;
  custom_unit_amount: number | null;
}

export interface LineContext {
  book: Pricebook;
  currency: string;
  locale: string;
}

/**
 * What the subscription bills for one whole period, before prorations, taxes
 * and credits. Metered items appear with a null amount: their quantity is not
 * known until the period closes, which is exactly why they are never prorated.
 */
export function recurringLines(
  items: PricedItem[],
  period: Period,
  { book, currency }: LineContext,
): RecurringLine[] {
  return items.map((item) => {
    const price = book.price(item.price);
    const metered = isMetered(price);
    const label = book.label(price);
    const line = metered ? null : book.compute(price, item.quantity, currency, { customUnitAmount: item.custom_unit_amount });
    return {
      subscription_item: item.id,
      price: price.id,
      description: metered
        ? `${label} — metered, billed in arrears`
        : item.quantity > 1 ? `${item.quantity} x ${label}` : label,
      quantity: item.quantity,
      amount: line ? line.amount : null,
      currency,
      metered,
      period: { start: period.start, end: period.end },
      breakdown: line ? line.breakdown : [],
    };
  });
}

export const recurringSubtotal = (lines: RecurringLine[]): number =>
  lines.reduce((total, line) => total + (line.amount ?? 0), 0);

/* ----------------------------------- MRR ---------------------------------- */

/** Weeks per month and days per month as exact fractions, never as 4.33 or 30. */
const NORMALISERS: Record<IntervalUnit, { numerator: number; denominator: number }> = {
  month: { numerator: 1, denominator: 1 },
  year: { numerator: 1, denominator: 12 },
  week: { numerator: 52, denominator: 12 },
  day: { numerator: 365, denominator: 12 },
};

/**
 * Normalised monthly recurring revenue for one subscription, in minor units.
 * Metered items are excluded — usage is revenue, but it is not *recurring*
 * revenue, and pretending otherwise is how a forecast goes wrong.
 *
 * MRR is net of a discount that is still running: an account on "20% off year
 * one" is worth 80% of its list price for as long as that runs and its list
 * price again the month after, because a run rate that quotes a price nobody is
 * paying is a forecast of money that will not arrive. The subtraction is spread
 * over exactly the items counted here — the recurring ones — so a coupon
 * restricted to the platform fee takes nothing off a metered line that was
 * never in the figure to begin with.
 *
 * The discount is looked up rather than passed in, and that is deliberate: this
 * function is imported by the revenue module precisely so that its figures and
 * `/v1/subscriptions/overview` cannot disagree, and an argument every caller
 * has to remember is an argument one of them will forget. A subscription
 * synthesised for an arithmetic question — the two sides of a logged change —
 * carries no identity and is priced at list, which is what those callers ask
 * for. Pass `coupon` explicitly to override, `null` for the list price.
 */
export function subscriptionMrr(
  sub: Pick<Subscription, 'interval' | 'interval_count' | 'currency'> & {
    items: PricedItem[]; id?: string; customer?: string;
  },
  book: Pricebook,
  coupon?: Coupon | null,
): number {
  const running = coupon !== undefined ? coupon : book.runningDiscount(sub.id ?? null, sub.customer ?? null);
  const counted: { price: string; amount: number }[] = [];
  for (const item of sub.items) {
    const price = book.find(item.price);
    if (!price || isMetered(price) || !isRecurring(price)) continue;
    counted.push({
      price: price.id,
      amount: book.compute(price, item.quantity, sub.currency, { customUnitAmount: item.custom_unit_amount }).amount,
    });
  }
  const shares = running ? book.discountShares(running, counted, sub.currency) : counted.map(() => 0);
  const norm = NORMALISERS[sub.interval];
  let total = 0;
  counted.forEach((line, index) => {
    const amount: Money = money(line.amount - shares[index], sub.currency);
    total += mulFraction(amount, norm.numerator, norm.denominator * sub.interval_count).amount;
  });
  return total;
}

/* -------------------------------- formatting ------------------------------ */

export const shortDate = (ts: number, locale: string, timeZone = 'UTC'): string =>
  formatDate(ts, { locale, timeZone, withYear: false });

export const longDate = (ts: number, locale: string, timeZone = 'UTC'): string =>
  formatDate(ts, { locale, timeZone });
