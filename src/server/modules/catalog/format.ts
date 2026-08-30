/**
 * Human-readable pricing copy, generated from the price itself.
 *
 * A pricing page that hand-writes "$0.0004 per event" next to a price object
 * eventually lies. These helpers render the strings straight from the stored
 * amounts, so the marketing surface and the invoice can never disagree.
 */
import { exponentOf } from '../../../shared/money';
import { decimalToRat, pluralUnit, ratToDecimal, resolveForCurrency, tierCap, tierFlat, tierUnit } from './engine';
import type { Price, PriceTier, Product } from './types';

const numberFmt = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string, locale: string, min: number, max: number): Intl.NumberFormat {
  const key = `${locale}|${currency}|${min}|${max}`;
  let f = numberFmt.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      style: 'currency', currency: currency.toUpperCase(),
      minimumFractionDigits: min, maximumFractionDigits: max,
    });
    numberFmt.set(key, f);
  }
  return f;
}

/** Shift a decimal string of minor units into major units, exactly. */
export function minorToMajorDecimal(decimal: string, currency: string): string {
  const exp = exponentOf(currency);
  if (exp === 0) return decimal;
  const negative = decimal.startsWith('-');
  const body = negative ? decimal.slice(1) : decimal;
  const [intRaw = '0', frac = ''] = body.split('.');
  const digits = `${intRaw}${frac}`;
  const pointFromRight = frac.length + exp;
  const padded = digits.padStart(pointFromRight + 1, '0');
  const whole = padded.slice(0, padded.length - pointFromRight) || '0';
  const rest = padded.slice(padded.length - pointFromRight).replace(/0+$/, '');
  const out = `${whole}${rest ? `.${rest}` : ''}`;
  return negative && /[1-9]/.test(out) ? `-${out}` : out;
}

/**
 * Format an amount given as a decimal string of minor units. Sub-cent prices
 * keep their precision ($0.0004); whole amounts keep the currency's exponent.
 */
export function formatMinorDecimal(decimal: string, currency: string, locale = 'en-US', maxPlaces = 6): string {
  const major = minorToMajorDecimal(decimal, currency);
  const fraction = major.split('.')[1]?.length ?? 0;
  const exp = exponentOf(currency);
  const max = Math.min(Math.max(exp, fraction), maxPlaces);
  return currencyFormatter(currency, locale, Math.min(exp, max), max).format(Number(major));
}

export const formatMinor = (amount: number, currency: string, locale = 'en-US'): string =>
  formatMinorDecimal(String(Math.trunc(amount)), currency, locale);

const INTERVAL_NOUN: Record<string, string> = { day: 'day', week: 'week', month: 'month', year: 'year' };

const ADVERB: Record<string, string> = { day: 'daily', week: 'weekly', month: 'monthly', year: 'annually' };

/** How the charge lands on an invoice: "Billed monthly", "One-time". */
export function cadencePhrase(price: Price): string {
  if (!price.recurring) return 'One-time';
  const { interval, interval_count } = price.recurring;
  return interval_count === 1
    ? `Billed ${ADVERB[interval] ?? `per ${interval}`}`
    : `Billed every ${interval_count} ${interval}s`;
}

export function intervalPhrase(price: Price): string | null {
  if (!price.recurring) return null;
  const { interval, interval_count } = price.recurring;
  const noun = INTERVAL_NOUN[interval] ?? interval;
  return interval_count === 1 ? `per ${noun}` : `every ${interval_count} ${noun}s`;
}

const qty = (n: number) => n.toLocaleString('en-US');

function tierLine(tier: PriceTier, previousCap: number, currency: string, locale: string, unitNoun: string): string {
  const unit = tierUnit(tier);
  const flat = tierFlat(tier);
  const upper = tier.up_to === 'inf' ? null : tier.up_to;
  const range = upper === null
    ? `${qty(previousCap + 1)} and above`
    : previousCap === 0 ? `first ${qty(upper)}` : `${qty(previousCap + 1)}–${qty(upper)}`;
  const parts: string[] = [];
  if (flat && flat.n !== 0n) parts.push(`${formatMinorDecimal(ratToDecimal(flat), currency, locale)} base`);
  if (unit) {
    parts.push(unit.n === 0n
      ? 'included'
      : `${formatMinorDecimal(ratToDecimal(unit), currency, locale)} per ${unitNoun}`);
  }
  return `${range}: ${parts.join(' + ')}`;
}

export interface PriceDisplay {
  /** The headline figure, already formatted. */
  amount: string | null;
  /** "Billed monthly", "One-time" — the caption under the headline figure. */
  cadence: string;
  /** "per seat", "per 10 GB", null for flat prices. */
  unit: string | null;
  /** "per month", "per year", null for one-off charges. */
  interval: string | null;
  /** One line a pricing page can print verbatim. */
  summary: string;
  /** Per-tier copy, in order, for the details drawer. */
  tiers: string[] | null;
  /** Cheapest per-unit rate, for "from $x" copy on tiered prices. */
  from: string | null;
}

/** Everything a pricing page needs to render a price without doing maths. */
export function describePrice(price: Price, currency: string, locale = 'en-US', product?: Product | null): PriceDisplay {
  const resolved = resolveForCurrency(price, currency);
  const unitNoun = product?.unit_label || 'unit';
  const interval = intervalPhrase(price);

  if (price.model === 'custom') {
    const preset = resolved.customUnitAmount?.preset;
    const minimum = resolved.customUnitAmount?.minimum;
    const anchor = preset ?? minimum ?? null;
    return {
      amount: anchor === null ? null : formatMinor(anchor, resolved.currency, locale),
      cadence: cadencePhrase(price),
      unit: null,
      interval,
      summary: anchor === null
        ? 'Custom pricing — talk to sales'
        : `From ${formatMinor(anchor, resolved.currency, locale)} ${interval ?? ''}`.trim(),
      tiers: null,
      from: anchor === null ? null : formatMinor(anchor, resolved.currency, locale),
    };
  }

  if (price.billing_scheme === 'tiered' && resolved.tiers?.length) {
    const lines: string[] = [];
    let previousCap = 0;
    for (const tier of resolved.tiers) {
      lines.push(tierLine(tier, previousCap, resolved.currency, locale, unitNoun));
      const cap = tierCap(tier);
      if (Number.isFinite(cap)) previousCap = cap;
    }
    // Headline the rate the customer meets first, then where it lands.
    let entryIndex = -1;
    let cheapestIndex = -1;
    resolved.tiers.forEach((tier, i) => {
      const unit = tierUnit(tier);
      if (!unit || unit.n === 0n) return;
      if (entryIndex < 0) entryIndex = i;
      const best = cheapestIndex < 0 ? null : tierUnit(resolved.tiers![cheapestIndex]);
      if (!best || unit.n * best.d < best.n * unit.d) cheapestIndex = i;
    });
    if (entryIndex < 0) {
      return {
        amount: null, cadence: cadencePhrase(price), unit: `per ${unitNoun}`, interval,
        summary: `Included — no per-${unitNoun} charge`, tiers: lines, from: null,
      };
    }
    const entry = formatMinorDecimal(ratToDecimal(tierUnit(resolved.tiers[entryIndex])!), resolved.currency, locale);
    const cheapest = formatMinorDecimal(ratToDecimal(tierUnit(resolved.tiers[cheapestIndex])!), resolved.currency, locale);
    const dropsAt = cheapestIndex > 0 ? tierCap(resolved.tiers[cheapestIndex - 1]) + 1 : null;
    const metered = price.recurring?.usage_type === 'metered';
    const head = `${entry} per ${unitNoun}${!metered && interval ? ` ${interval}` : ''}`;
    const falling = cheapestIndex > entryIndex && dropsAt !== null && Number.isFinite(dropsAt)
      ? `${head}, falling to ${cheapest} from ${dropsAt.toLocaleString(locale)}`
      : head;
    return {
      amount: entry, cadence: cadencePhrase(price), unit: `per ${unitNoun}`, interval,
      summary: metered ? `${falling} — ${cadencePhrase(price).toLowerCase()}` : falling,
      tiers: lines, from: cheapest,
    };
  }

  const decimal = resolved.unitAmountDecimal;
  if (decimal === null) {
    return { amount: null, cadence: cadencePhrase(price), unit: null, interval, summary: 'Contact sales for pricing', tiers: null, from: null };
  }
  const amount = formatMinorDecimal(decimal, resolved.currency, locale);
  const t = price.transform_quantity;
  const unit = price.model === 'flat'
    ? null
    : t && t.divide_by > 1
      ? `per ${qty(t.divide_by)} ${pluralUnit(unitNoun, t.divide_by)}`
      : `per ${unitNoun}`;
  const metered = price.recurring?.usage_type === 'metered';
  const once = price.type === 'one_time' && !unit ? 'one-time' : null;
  const summary = metered
    ? `${[amount, unit].filter(Boolean).join(' ')} — ${cadencePhrase(price).toLowerCase()}`
    : [amount, unit, interval, once].filter(Boolean).join(' ');

  return { amount, cadence: cadencePhrase(price), unit, interval, summary, tiers: null, from: amount };
}

/** The cheapest amount a price can charge for one unit, for sorting/compare. */
export function anchorUnitDecimal(price: Price, currency: string): string | null {
  const resolved = resolveForCurrency(price, currency);
  if (resolved.tiers?.length) {
    const units = resolved.tiers.map(tierUnit).filter((u): u is NonNullable<typeof u> => !!u);
    if (!units.length) return null;
    return ratToDecimal(units.reduce((a, b) => (a.n * b.d <= b.n * a.d ? a : b)));
  }
  return resolved.unitAmountDecimal;
}

export const decimalIsZero = (decimal: string | null): boolean =>
  decimal === null ? false : decimalToRat(decimal).n === 0n;
