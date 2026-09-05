import type { Ctx } from '../../kernel/context';
import { formatMoney, rat, ratCmp, ratDiv, type Rational } from '../../../shared/money';
import type { IntervalUnit } from '../../../shared/time';
import type { Price, PriceType, Product } from '../catalog/types';
import { lowerFirst, quantity } from './format';
import type { Feature, ProductFeature, UpgradePath } from './types';

/**
 * The ladder behind `upgrade_path`.
 *
 * A denial that says "upgrade your plan" is useless; the caller has to be able
 * to put a button on the screen, so every answer names the real product, the
 * real price, what that price actually costs in the customer's own currency and
 * exactly how much of the feature it grants. That means ranking plans against
 * each other, which means comparing a monthly fee with an annual one — done
 * here as an exact rational so a £152,000 annual term and a £15,200 monthly one
 * sort in the order a customer would put them in, with no float in sight.
 */
export interface LadderEntry {
  product: string;
  product_name: string;
  price: string;
  price_nickname: string | null;
  value: number | null;
  unlimited: boolean;
  amount: number | null;
  currency: string;
  amount_formatted: string | null;
  interval: IntervalUnit | null;
  interval_count: number;
  price_type: PriceType;
  /** The catalog's own one-line pricing prose, printed verbatim. */
  price_summary: string;
  /** List amount normalised to one month, for ranking. Null when negotiated. */
  monthly: Rational | null;
}

/** Months in one billing interval, exactly — a week is 12/52 of a month. */
function monthsPerInterval(unit: IntervalUnit, count: number): Rational {
  switch (unit) {
    case 'month': return rat(count, 1);
    case 'year': return rat(12 * count, 1);
    case 'week': return rat(12 * count, 52);
    case 'day': return rat(12 * count, 365);
  }
}

function monthlyEquivalent(amount: number | null, price: Price): Rational | null {
  if (amount === null) return null;
  if (!price.recurring) return rat(amount, 1);
  return ratDiv(rat(amount, 1), monthsPerInterval(price.recurring.interval, price.recurring.interval_count));
}

/** How much of the feature an entry reaches, for ordering. Unlimited is the top. */
const reachOf = (entry: { value: number | null; unlimited: boolean }): number =>
  entry.unlimited ? Number.POSITIVE_INFINITY : entry.value ?? 0;

function cheaper(a: LadderEntry, b: LadderEntry): number {
  if (a.monthly && b.monthly) return ratCmp(a.monthly, b.monthly);
  if (a.monthly) return -1;
  if (b.monthly) return 1;
  return 0;
}

export interface LadderDeps {
  ctx: Ctx;
  locale: string;
}

interface QuotedPrice {
  price: Price;
  amount: number | null;
  formatted: string | null;
  summary: string;
}

/**
 * Whether this price can be sold at all to somebody paying in `currency`.
 *
 * The catalog refuses — loudly, and rightly — to quote a yen-only price in
 * dollars. Listing a plan in a second currency is a routine morning's work for
 * a pricing team, and the accounts already on the price book must not notice.
 */
const sellableIn = (price: Price, currency: string): boolean =>
  price.currency === currency || !!price.currency_options?.[currency];

/**
 * The price a customer would actually be quoted for a product: its default
 * price when it has one, otherwise the cheapest active price it sells at. A
 * plan whose only price is inactive is not on anybody's upgrade path — and
 * neither is one that cannot be sold in the money this customer pays in.
 */
function entryPrice(ctx: Ctx, orgId: string, product: Product, currency: string, locale: string): QuotedPrice | null {
  const prices = ctx.svc.catalog.pricesFor(orgId, product.id, { active: true })
    .filter((p) => sellableIn(p, currency));
  if (!prices.length) return null;
  /**
   * A rung that cannot be priced is dropped, never thrown. `describe` still
   * raises on a currency option that names no amounts, and this is a gate: the
   * question in front of it is whether an account may push an event, and the
   * price book's shape is no reason to refuse to answer it.
   */
  const quote = (p: Price): QuotedPrice | null => {
    try {
      const display = ctx.svc.catalog.describe(p, currency, locale, product);
      return { price: p, amount: display.from_amount, formatted: display.amount ?? display.headline, summary: display.summary };
    } catch { return null; }
  };
  // The common case: the product already says which price it is sold at, so
  // describing the other three is work nobody asked for.
  const preferred = product.default_price ? prices.find((p) => p.id === product.default_price) : undefined;
  if (preferred) {
    const quoted = quote(preferred);
    if (quoted) return quoted;
  }
  const priced = prices.map(quote).filter((p): p is QuotedPrice => p !== null);
  if (!priced.length) return null;
  const recurring = priced.filter((p) => p.price.type === 'recurring');
  const pool = recurring.length ? recurring : priced;
  return pool.slice().sort((a, b) => {
    const am = monthlyEquivalent(a.amount, a.price);
    const bm = monthlyEquivalent(b.amount, b.price);
    if (am && bm) return ratCmp(am, bm);
    if (am) return -1;
    if (bm) return 1;
    return a.price.id.localeCompare(b.price.id);
  })[0];
}

/**
 * Every product that grants `feature` and can be sold in `currency`, cheapest
 * and smallest first. A plan the customer cannot be quoted is simply not on
 * their upgrade path, so the ladder comes back shorter rather than not at all.
 */
export function buildLadder(
  deps: LadderDeps, orgId: string, rows: ProductFeature[], currency: string,
): LadderEntry[] {
  const { ctx, locale } = deps;
  const entries: LadderEntry[] = [];
  for (const row of rows) {
    const product = ctx.svc.catalog.product(orgId, row.product);
    if (!product || !product.active) continue;
    const chosen = entryPrice(ctx, orgId, product, currency, locale);
    if (!chosen) continue;
    entries.push({
      product: product.id,
      product_name: product.name,
      price: chosen.price.id,
      price_nickname: chosen.price.nickname,
      value: row.unlimited ? null : row.value,
      unlimited: row.unlimited,
      amount: chosen.amount,
      currency: chosen.price.currency_options[currency] ? currency : chosen.price.currency,
      amount_formatted: chosen.formatted,
      interval: chosen.price.recurring?.interval ?? null,
      interval_count: chosen.price.recurring?.interval_count ?? 1,
      price_type: chosen.price.type,
      price_summary: chosen.summary,
      monthly: monthlyEquivalent(chosen.amount, chosen.price),
    });
  }
  return entries.sort((a, b) => (reachOf(a) - reachOf(b)) || cheaper(a, b) || a.product.localeCompare(b.product));
}

/**
 * The smallest upgrade that solves the problem.
 *
 * "Smallest" is deliberate: a customer who needs 4 more seats is shown the next
 * rung up, not the top of the price list. When nothing on the ladder covers the
 * need, the biggest rung is still the honest answer — its `value` says what it
 * would actually give them, so the caller can say so.
 */
export function bestUpgrade(
  ladder: LadderEntry[],
  current: { value: number | null; unlimited: boolean; product: string | null },
  needed: number,
): LadderEntry | null {
  if (current.unlimited) return null;
  const floor = current.value ?? 0;
  const better = ladder.filter((e) => e.product !== current.product && reachOf(e) > floor);
  if (!better.length) return null;
  const sufficient = better.filter((e) => reachOf(e) >= needed);
  const pool = sufficient.length ? sufficient : better;
  const target = reachOf(pool[0]);
  // Among the rungs that reach the same height, the cheapest one wins.
  return pool.filter((e) => reachOf(e) === target).sort(cheaper)[0] ?? pool[0];
}

export function toUpgradePath(entry: LadderEntry, feature: Feature, locale: string): UpgradePath {
  const named = lowerFirst(feature.name);
  const reach = entry.unlimited
    ? `makes ${named} unlimited`
    : feature.type === 'boolean'
      ? `includes ${named}`
      : `raises ${named} to ${quantity(entry.value ?? 0, feature.unit_label, locale)}`;
  const cost = entry.price_summary || (entry.amount === null
    ? 'priced after a conversation with sales'
    : formatMoney({ amount: entry.amount, currency: entry.currency }, { locale }));
  // A component whose product *is* the feature would otherwise stutter —
  // "Bulk data export makes bulk data export unlimited".
  const stutters = entry.product_name.toLowerCase() === feature.name.toLowerCase();
  const message = stutters
    ? `Add ${entry.product_name}: ${cost}.`
    : `${entry.product_name} ${reach}: ${cost}.`;
  return {
    object: 'entitlement_upgrade',
    product: entry.product,
    product_name: entry.product_name,
    price: entry.price,
    price_nickname: entry.price_nickname,
    value: entry.value,
    unlimited: entry.unlimited,
    amount: entry.amount,
    currency: entry.currency,
    amount_formatted: entry.amount === null
      ? null
      : formatMoney({ amount: entry.amount, currency: entry.currency }, { locale }),
    interval: entry.interval,
    interval_count: entry.interval_count,
    message,
  };
}
