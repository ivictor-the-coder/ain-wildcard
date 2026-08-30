/**
 * Human-readable pricing copy, generated from the price itself.
 *
 * A pricing page that hand-writes "$0.0004 per event" next to a price object
 * eventually lies. These helpers render the strings straight from the stored
 * amounts — and, wherever a headline figure could disagree with the invoice,
 * straight from the pricing engine itself — so the marketing surface and the
 * invoice can never say different things.
 *
 * Three rules hold every string in this file honest:
 *  1. Nothing is described as free unless the engine charges nothing for it.
 *  2. `from` is a real total the engine produced, never a per-unit rate that a
 *     customer could never actually pay.
 *  3. Quantities are printed in the customer's own units. A price with
 *     `transform_quantity` bills in packages; the copy converts every rate and
 *     every tier boundary back into the units the customer counts in.
 */
import { exponentOf, ratRound, type Rational } from '../../../shared/money';
import {
  decimalToRat, exactAmount, pluralUnit, ratToDecimal, resolveForCurrency, tierCap, tierFlat, tierUnit,
} from './engine';
import type { Price, PriceTier, Product, TransformQuantity } from './types';

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

const qty = (n: number, locale = 'en-US') => n.toLocaleString(locale);

/* ------------------------------- tier bands ------------------------------- */

/** A tier's span, expressed in the units the customer actually counts. */
interface TierBand {
  lower: number;
  /** Inclusive upper bound, or null for the open-ended final tier. */
  upper: number | null;
}

const activeTransform = (t: TransformQuantity | null | undefined): TransformQuantity | null =>
  t && t.divide_by > 1 ? t : null;

/**
 * Tier bounds are stored in *billable* units — packages, once
 * `transform_quantity` has bucketed the quantity — while a customer counts in
 * events or gigabytes. With `divide_by: 100`, a tier ending at package 5 ends
 * at event 500 when part packages round up, and at event 599 when they round
 * down (event 600 is the sixth package). Both are computed here so a tier table
 * never quotes a boundary the customer cannot recognise.
 */
function tierBands(tiers: PriceTier[], transform: TransformQuantity | null | undefined): TierBand[] {
  const t = activeTransform(transform);
  const divide = t ? t.divide_by : 1;
  const slack = t && t.round === 'down' ? divide - 1 : 0;
  const bands: TierBand[] = [];
  let previousUpper = 0;
  for (const tier of tiers) {
    const cap = tierCap(tier);
    const upper = Number.isFinite(cap) ? cap * divide + slack : null;
    bands.push({ lower: previousUpper + 1, upper });
    if (upper !== null) previousUpper = upper;
  }
  return bands;
}

function bandLabel(band: TierBand, unitNoun: string, locale: string, only: boolean): string {
  if (only) return 'any quantity';
  if (band.upper === null) return `${qty(band.lower, locale)} and above`;
  if (band.lower === 1) return `first ${qty(band.upper, locale)} ${pluralUnit(unitNoun, band.upper)}`;
  return `${qty(band.lower, locale)}–${qty(band.upper, locale)}`;
}

/* --------------------------------- display -------------------------------- */

export interface PriceDisplay {
  /**
   * The headline figure, already formatted — the number a pricing card sets in
   * large type. On a tiered price this is what the customer meets first: the
   * entry tier's base charge when it has one, otherwise its per-unit rate.
   */
  amount: string | null;
  /**
   * What completes the headline when the figure alone would mislead —
   * "+ $0.50 per event" beside a "$10.00" base. Null when `amount` says it all.
   */
  amount_detail: string | null;
  /** `amount` and `amount_detail` joined: one string a card can print verbatim. */
  headline: string | null;
  /** "Billed monthly", "One-time" — the caption under the headline figure. */
  cadence: string;
  /** "per seat", "per 10 GB" — null whenever `amount` is not a per-unit rate. */
  unit: string | null;
  /** "per month", "per year", null for one-off charges. */
  interval: string | null;
  /** One line a pricing page can print verbatim. */
  summary: string;
  /** Per-tier copy, in order, for the details drawer. */
  tiers: string[] | null;
  /**
   * The least this price can charge: the exact total the engine computes for a
   * single unit, base charges included. Never below `compute(price, 1).amount`,
   * which is what makes "from $x" copy safe to print.
   */
  from: string | null;
  /** That same floor in minor units, so callers compare without parsing. */
  from_amount: number | null;
  /** The cheapest per-unit rate a customer can reach, for "down to $x" copy. */
  cheapest_unit: string | null;
}

interface Charge { display: string; amount: number }

/**
 * What the engine really bills for `quantity` — the anchor for all "from" copy.
 * This is the same exact sum `computeLineAmount` rounds, so a headline can
 * never drift from the invoice line it is describing.
 */
function chargeAt(price: Price, quantity: number, currency: string, locale: string, unitLabel: string): Charge | null {
  try {
    const exact = exactAmount(price, quantity, currency, { unitLabel });
    return {
      display: formatMinorDecimal(ratToDecimal(exact), currency, locale),
      amount: Number(ratRound(exact, 'half_up')),
    };
  } catch {
    return null;
  }
}

/** Everything a pricing page needs to render a price without doing maths. */
export function describePrice(price: Price, currency: string, locale = 'en-US', product?: Product | null): PriceDisplay {
  const resolved = resolveForCurrency(price, currency);
  const unitNoun = product?.unit_label || 'unit';
  const interval = intervalPhrase(price);
  const metered = price.recurring?.usage_type === 'metered';
  const money = (value: Rational) => formatMinorDecimal(ratToDecimal(value), resolved.currency, locale);
  const transform = activeTransform(price.transform_quantity);
  // A package price quotes its rate per package: "per 10 GB", not "per GB".
  const rateNoun = transform
    ? `${qty(transform.divide_by, locale)} ${pluralUnit(unitNoun, transform.divide_by)}`
    : unitNoun;
  const perRate = `per ${rateNoun}`;
  const noChargeNoun = transform ? `charge per ${rateNoun}` : `per-${unitNoun} charge`;
  const intervalSuffix = !metered && interval ? ` ${interval}` : '';
  const cadenceSuffix = metered ? ` — ${cadencePhrase(price).toLowerCase()}` : '';
  const zeroMoney = formatMinorDecimal('0', resolved.currency, locale);

  if (price.model === 'custom') {
    const preset = resolved.customUnitAmount?.preset;
    const minimum = resolved.customUnitAmount?.minimum;
    const anchor = preset ?? minimum ?? null;
    const anchorDisplay = anchor === null ? null : formatMinor(anchor, resolved.currency, locale);
    return {
      amount: anchorDisplay,
      amount_detail: null,
      headline: anchorDisplay,
      cadence: cadencePhrase(price),
      unit: null,
      interval,
      summary: anchorDisplay === null
        ? 'Custom pricing — talk to sales'
        : `From ${anchorDisplay} ${interval ?? ''}`.trim(),
      tiers: null,
      from: anchorDisplay,
      from_amount: anchor,
      cheapest_unit: null,
    };
  }

  const floor = chargeAt(price, 1, resolved.currency, locale, unitNoun);

  if (price.billing_scheme === 'tiered' && resolved.tiers?.length) {
    const tiers = resolved.tiers;
    const bands = tierBands(tiers, price.transform_quantity);
    const only = tiers.length === 1;
    const units = tiers.map(tierUnit);
    const flats = tiers.map(tierFlat);
    const paidUnit = (i: number) => !!units[i] && units[i]!.n !== 0n;
    const paidFlat = (i: number) => !!flats[i] && flats[i]!.n !== 0n;

    const lines = tiers.map((_, i) => {
      const unit = units[i];
      const flat = flats[i];
      const label = bandLabel(bands[i], unitNoun, locale, only);
      if (flat && flat.n !== 0n && unit && unit.n === 0n) {
        return `${label}: ${money(flat)} base, no ${noChargeNoun}`;
      }
      const parts: string[] = [];
      if (flat && flat.n !== 0n) parts.push(`${money(flat)} base`);
      if (unit) parts.push(unit.n === 0n ? 'included' : `${money(unit)} ${perRate}`);
      return `${label}: ${parts.length ? parts.join(' + ') : 'no charge'}`;
    });

    const anyPaidUnit = tiers.some((_, i) => paidUnit(i));
    const anyPaidFlat = tiers.some((_, i) => paidFlat(i));
    const cheapestUnitIndex = tiers.reduce((best, _, i) => {
      if (!paidUnit(i)) return best;
      if (best < 0) return i;
      return units[i]!.n * units[best]!.d < units[best]!.n * units[i]!.d ? i : best;
    }, -1);
    const cheapestUnit = cheapestUnitIndex < 0 ? null : money(units[cheapestUnitIndex]!);

    /* Nothing is charged at any quantity: the one case "included" is honest. */
    if (!anyPaidUnit && !anyPaidFlat) {
      const zero = floor?.display ?? zeroMoney;
      return {
        amount: zero,
        amount_detail: null,
        headline: zero,
        cadence: cadencePhrase(price),
        unit: perRate,
        interval,
        summary: `Included — no ${noChargeNoun}`,
        tiers: lines,
        from: floor?.display ?? zero,
        from_amount: floor?.amount ?? 0,
        cheapest_unit: cheapestUnit,
      };
    }

    /*
     * A ladder of base charges and no per-unit rate at all — an ordinary
     * platform fee. The charge is flat inside each band, so each band is priced
     * by the engine at its own first unit and quoted as the real total.
     */
    if (!anyPaidUnit) {
      const totals = bands.map((band) => chargeAt(price, band.lower, resolved.currency, locale, unitNoun));
      const first = totals[0];
      const last = totals[totals.length - 1];
      const head = first?.display ?? zeroMoney;
      const firstUpper = bands[0].upper;
      const lastLower = bands[bands.length - 1].lower;
      let summary = `${head}${intervalSuffix}`;
      if (bands.length > 1 && firstUpper !== null && last) {
        const direction = first && last.amount < first.amount ? 'falling' : 'rising';
        const opening = `${head}${intervalSuffix} up to ${qty(firstUpper, locale)} ${pluralUnit(unitNoun, firstUpper)}`;
        summary = bands.length === 2
          ? `${opening}, then ${last.display}${intervalSuffix}`
          : `${opening}, ${direction} through ${bands.length} tiers to ${last.display}${intervalSuffix} above ${qty(lastLower - 1, locale)} ${pluralUnit(unitNoun, 2)}`;
      }
      return {
        amount: head,
        amount_detail: null,
        headline: head,
        cadence: cadencePhrase(price),
        // Not a per-unit rate: "$50.00 per event" would be a 10x lie here.
        unit: null,
        interval,
        summary: `${summary}${cadenceSuffix}`,
        tiers: lines,
        from: floor?.display ?? head,
        from_amount: floor?.amount ?? null,
        cheapest_unit: null,
      };
    }

    /* The usual shape: a per-unit rate, possibly over a base and an allowance. */
    const entryIndex = tiers.findIndex((_, i) => paidUnit(i));
    const entryRate = money(units[entryIndex]!);
    const base = paidFlat(0) ? money(flats[0]!) : null;
    /*
     * Everything under the first paid tier is an allowance, whether it is
     * priced at zero or carries no per-unit rate at all — either way the
     * customer is not charged per unit until this many units have gone by.
     */
    const allowance = entryIndex > 0 && bands[entryIndex].lower > 1 ? bands[entryIndex].lower - 1 : null;
    const volumePriced = price.tiers_mode === 'volume';
    const inUnits = (n: number) => `${qty(n, locale)} ${pluralUnit(unitNoun, n)}`;
    const entryFlat = entryIndex > 0 && paidFlat(entryIndex) ? money(flats[entryIndex]!) : null;
    // Volume tiering re-prices every unit at the tier it lands in, so "then
    // $1.00 per event" would understate it: every event costs $1.00, not just
    // the ones past the allowance.
    const thenRate = `${entryFlat ? `${entryFlat} base + ` : ''}${entryRate}${volumePriced ? ` for every ${rateNoun}` : ` ${perRate}`}`;

    const clauses: string[] = [];
    if (base && allowance !== null) {
      clauses.push(volumePriced
        ? `${base}${intervalSuffix} up to ${inUnits(allowance)}, then ${thenRate}`
        : `${base}${intervalSuffix} including the first ${inUnits(allowance)}, then ${thenRate}`);
    } else if (base) {
      clauses.push(`${base}${intervalSuffix} + ${entryRate} ${perRate}`);
    } else if (allowance !== null) {
      clauses.push(volumePriced
        ? `Free up to ${inUnits(allowance)}, then ${thenRate}`
        : `First ${inUnits(allowance)} included, then ${thenRate}`);
    } else {
      clauses.push(`${entryRate} ${perRate}${intervalSuffix}`);
    }

    if (cheapestUnitIndex > entryIndex) {
      const target = paidFlat(cheapestUnitIndex)
        ? `${money(flats[cheapestUnitIndex]!)} base + ${cheapestUnit} ${perRate}`
        : cheapestUnit!;
      const from = bands[cheapestUnitIndex].lower - 1;
      clauses.push(volumePriced
        ? `falling to ${target} for every ${rateNoun} once you pass ${qty(from, locale)}`
        : `falling to ${target} for ${pluralUnit(unitNoun, 2)} beyond ${qty(from, locale)}`);
    }

    /*
     * Volume tiering charges one tier for the whole quantity, so a base that
     * only covers the allowance is not paid alongside the rate that follows it:
     * the headline says what it buys instead of adding the two together.
     */
    const buys = volumePriced && base !== null && allowance !== null ? `up to ${inUnits(allowance)}` : null;
    const detail = buys ?? (base ? `+ ${entryRate} ${perRate}` : null);
    const headline = base
      ? `${base} ${buys ?? `base + ${entryRate} ${perRate}`}`
      : `${entryRate} ${perRate}`;
    return {
      amount: base ?? entryRate,
      amount_detail: detail,
      headline,
      cadence: cadencePhrase(price),
      unit: base ? null : perRate,
      interval,
      summary: `${clauses.join(', ')}${cadenceSuffix}`,
      tiers: lines,
      from: floor?.display ?? headline,
      from_amount: floor?.amount ?? null,
      cheapest_unit: cheapestUnit,
    };
  }

  const decimal = resolved.unitAmountDecimal;
  if (decimal === null) {
    return {
      amount: null, amount_detail: null, headline: null, cadence: cadencePhrase(price), unit: null, interval,
      summary: 'Contact sales for pricing', tiers: null, from: null, from_amount: null, cheapest_unit: null,
    };
  }
  const amount = formatMinorDecimal(decimal, resolved.currency, locale);
  const unit = price.model === 'flat' ? null : perRate;
  const once = price.type === 'one_time' && !unit ? 'one-time' : null;
  const summary = metered
    ? `${[amount, unit].filter(Boolean).join(' ')} — ${cadencePhrase(price).toLowerCase()}`
    : [amount, unit, interval, once].filter(Boolean).join(' ');

  return {
    amount,
    amount_detail: null,
    headline: [amount, unit].filter(Boolean).join(' '),
    cadence: cadencePhrase(price),
    unit,
    interval,
    summary,
    tiers: null,
    from: floor?.display ?? amount,
    from_amount: floor?.amount ?? null,
    cheapest_unit: unit ? amount : null,
  };
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
