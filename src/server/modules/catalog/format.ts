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
import { exponentOf, rat, ratCmp, ratRound, ratSub, type Rational } from '../../../shared/money';
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

/* ------------------------------ where it steps ---------------------------- */

/** A band the summary names, and what the customer notices on reaching it. */
type TierStep =
  | { index: number; direction: 'falling' | 'rising' }
  /** A band that keeps the rate but charges `oneOff` to enter. */
  | { index: number; direction: 'plus'; oneOff: Rational };

/**
 * Every band after the entry clause where the engine's real cost changes, in
 * the order a customer meets them, and whether each one costs less or more.
 *
 * Returning only the cheapest band is what made the summary lie: a ladder that
 * dips to $0.50 at 1,000 and climbs to $2.00 at 10,000 was advertised as
 * "falling to $0.50", a rate the price has already abandoned by the time the
 * invoice is cut. The whole remaining ladder is returned instead, so whatever
 * the sentence says along the way, the last rate it quotes is the one the
 * customer keeps paying.
 *
 * A tier's own `unit_amount` cannot answer which way a band moves: a volume
 * tier that cuts the rate from $0.50 to $0.10 and adds a $500 base charge bills
 * 33x more at the boundary, not less. So both figures come out of the engine,
 * and each mode is measured the way it actually bills — volume re-prices the
 * whole quantity, so what changes either side of the step is the total per
 * unit; graduated leaves every earlier unit at its own rate, so what changes is
 * the price of the next unit. Each band is measured against the last one the
 * sentence quoted rather than against the opening, because that is the number
 * the reader is comparing it with. Nothing is "falling" unless the figure it
 * compares really fell, and a band that keeps the rate but charges to enter is
 * reported as the one-off it is rather than passed over in silence.
 */
function stepLadder(
  price: Price,
  currency: string,
  unitNoun: string,
  bands: TierBand[],
  entryIndex: number,
  entryRate: Rational,
  volumePriced: boolean,
): TierStep[] {
  const transform = activeTransform(price.transform_quantity);
  // A package price charges per package: one package is its smallest real step.
  const stride = transform ? transform.divide_by : 1;

  const perUnitAt = (quantity: number): Rational | null => {
    if (quantity < 1) return null;
    const exact = exactAt(price, quantity, currency, unitNoun);
    return exact === null ? null : rat(exact.n, exact.d * BigInt(quantity));
  };

  /**
   * The cost of one more rate-unit to a customer already inside the band. Both
   * quantities sit in the same band, so the band's own entry charge cancels and
   * what is left is the rate the customer keeps paying.
   */
  const marginalIn = (i: number): Rational | null => {
    const { lower, upper } = bands[i];
    if (upper !== null && upper - lower < stride) return null;
    const before = exactAt(price, lower, currency, unitNoun);
    const after = exactAt(price, lower + stride, currency, unitNoun);
    return before === null || after === null ? null : ratSub(after, before);
  };

  /*
   * The rate a customer was on before band `i`. A band too narrow to hold a
   * whole rate-unit has no rate to measure, so the search walks back to the
   * last band that does, and falls back to the entry rate the summary has
   * already quoted — which is the figure the reader is comparing against.
   */
  const rateBefore = (i: number): Rational => {
    for (let j = i - 1; j >= entryIndex; j--) {
      const marginal = marginalIn(j);
      if (marginal !== null) return marginal;
    }
    return entryRate;
  };

  /** What the customer pays to go from the last unit before a band to its first. */
  const crossingInto = (i: number): Rational | null => {
    const after = exactAt(price, bands[i].lower, currency, unitNoun);
    const before = exactAt(price, bands[i].lower - 1, currency, unitNoun);
    return after === null || before === null ? null : ratSub(after, before);
  };

  /*
   * What a clause about band `i` commits the price to, at the last quantity it
   * covers — the figure the next band is compared against. On volume that is
   * the cost per unit at the top of the band, which is where a base charge has
   * spread as thin as it ever will; on graduated it is simply the band's rate.
   */
  const committedBy = (i: number): Rational | null => (volumePriced
    ? perUnitAt(bands[i].upper ?? bands[i].lower)
    : marginalIn(i) ?? (i === entryIndex ? entryRate : null));

  let quoted = committedBy(entryIndex);
  const steps: TierStep[] = [];

  for (let i = entryIndex + 1; i < bands.length; i++) {
    const cost = volumePriced ? perUnitAt(bands[i].lower) : marginalIn(i);
    if (cost === null) {
      // Too narrow to hold a whole rate-unit, so it has no rate of its own —
      // but a band one unit wide can still carry a base charge, and a customer
      // who steps into it pays that on top of the rate they were already on.
      const crossing = volumePriced ? null : crossingInto(i);
      const oneOff = crossing === null ? null : ratSub(crossing, rateBefore(i));
      if (oneOff && oneOff.n > 0n) steps.push({ index: i, direction: 'plus', oneOff });
      continue;
    }
    let moved = quoted === null ? 0 : ratCmp(cost, quoted);
    if (moved === 0 && volumePriced) {
      /*
       * The cost per unit can land on the same number either side of a volume
       * step and still be a different price: a band that carries a base charge
       * keeps getting cheaper per unit inside itself, and a band that drops the
       * base while doubling the rate can match at the boundary and diverge from
       * there. So look one unit deeper, then at the rate the band charges.
       */
      const { lower, upper } = bands[i];
      const deeper = upper === null || lower + 1 <= upper ? perUnitAt(lower + 1) : null;
      moved = deeper === null ? 0 : ratCmp(deeper, cost);
      if (moved === 0) {
        const rate = marginalIn(i);
        moved = rate === null ? 0 : ratCmp(rate, rateBefore(i));
      }
    }
    if (moved !== 0) {
      steps.push({ index: i, direction: moved < 0 ? 'falling' : 'rising' });
      quoted = committedBy(i) ?? cost;
      continue;
    }
    if (!volumePriced) {
      // The rate did not move, but crossing still costs: a base charge on the
      // band that reading the rate alone would never reveal.
      const crossing = crossingInto(i);
      const oneOff = crossing === null ? null : ratSub(crossing, cost);
      if (oneOff && oneOff.n > 0n) steps.push({ index: i, direction: 'plus', oneOff });
    }
  }
  return steps;
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

interface Charge { display: string; amount: number; exact: Rational }

/**
 * What the engine really bills for `quantity` — the anchor for all "from" copy.
 * This is the same exact sum `computeLineAmount` rounds, so a headline can
 * never drift from the invoice line it is describing.
 */
function chargeAt(price: Price, quantity: number, currency: string, locale: string, unitLabel: string): Charge | null {
  const exact = exactAt(price, quantity, currency, unitLabel);
  if (exact === null) return null;
  return {
    display: formatMinorDecimal(ratToDecimal(exact), currency, locale),
    amount: Number(ratRound(exact, 'half_up')),
    exact,
  };
}

function exactAt(price: Price, quantity: number, currency: string, unitLabel: string): Rational | null {
  try { return exactAmount(price, quantity, currency, { unitLabel }); }
  catch { return null; }
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
      /*
       * Two tiers that bill the same amount are one price to the customer.
       * Counting them separately advertises a step at a quantity where the
       * engine charges no differently than it did the unit before.
       */
      const steps = totals.reduce<number[]>((keep, total, i) => {
        if (i === 0 || (total && totals[keep[keep.length - 1]]?.amount !== total.amount)) keep.push(i);
        return keep;
      }, []);
      const last = totals[steps[steps.length - 1]];
      const head = first?.display ?? zeroMoney;
      let summary = `${head}${intervalSuffix}`;
      if (steps.length > 1 && first && last) {
        const changesAt = bands[steps[1]].lower - 1;
        const direction = last.amount < first.amount ? 'falling' : 'rising';
        const opening = `${head}${intervalSuffix} up to ${qty(changesAt, locale)} ${pluralUnit(unitNoun, changesAt)}`;
        const reachedAt = bands[steps[steps.length - 1]].lower - 1;
        summary = steps.length === 2
          ? `${opening}, then ${last.display}${intervalSuffix}`
          : `${opening}, ${direction} through ${steps.length} tiers to ${last.display}${intervalSuffix} above ${qty(reachedAt, locale)} ${pluralUnit(unitNoun, 2)}`;
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
    /*
     * Everything under the first paid tier is an allowance, whether it is
     * priced at zero or carries no per-unit rate at all — either way the
     * customer is not charged per unit until this many units have gone by.
     */
    const allowance = entryIndex > 0 && bands[entryIndex].lower > 1 ? bands[entryIndex].lower - 1 : null;
    /*
     * What the allowance really costs, from the engine. The entry tier's own
     * flat amount cannot answer that: a base charge sitting on a tier in
     * between belongs to the allowance too, and reading only the first tier
     * calls a band that bills $500 "free".
     */
    const allowanceExact = allowance === null ? null : exactAt(price, allowance, resolved.currency, unitNoun);
    const freeAllowance = allowanceExact !== null && allowanceExact.n === 0n ? allowance : null;
    const base = allowance === null
      ? (paidFlat(0) ? money(flats[0]!) : null)
      : (allowanceExact !== null && allowanceExact.n !== 0n ? money(allowanceExact) : null);
    const volumePriced = price.tiers_mode === 'volume';
    const inUnits = (n: number) => `${qty(n, locale)} ${pluralUnit(unitNoun, n)}`;

    /**
     * What a customer inside band `i` pays, in the words the mode makes true.
     * Volume re-prices the whole quantity, so its rate is charged "for every"
     * unit; graduated charges it only on the units inside the band.
     */
    const ratePhrase = (i: number): string => {
      const flat = paidFlat(i) ? `${money(flats[i]!)} base` : null;
      const unit = paidUnit(i) ? `${money(units[i]!)}${volumePriced ? ` for every ${rateNoun}` : ` ${perRate}`}` : null;
      if (flat && unit) return `${flat} + ${unit}`;
      if (flat) return `${flat} and no ${noChargeNoun}`;
      return unit ?? 'no charge at all';
    };

    // Volume tiering re-prices every unit at the tier it lands in, so "then
    // $1.00 per event" would understate it: every event costs $1.00, not just
    // the ones past the allowance.
    const thenRate = ratePhrase(entryIndex);

    const clauses: string[] = [];
    if (base && allowance !== null) {
      clauses.push(volumePriced
        ? `${base}${intervalSuffix} up to ${inUnits(allowance)}, then ${thenRate}`
        : `${base}${intervalSuffix} including the first ${inUnits(allowance)}, then ${thenRate}`);
    } else if (base) {
      clauses.push(`${base}${intervalSuffix} + ${entryRate} ${perRate}`);
    } else if (freeAllowance !== null) {
      clauses.push(volumePriced
        ? `Free up to ${inUnits(freeAllowance)}, then ${thenRate}`
        : `First ${inUnits(freeAllowance)} included, then ${thenRate}`);
    } else {
      clauses.push(`${entryRate} ${perRate}${intervalSuffix}`);
    }

    /*
     * The whole remaining ladder, not just its cheapest rung. Consecutive bands
     * that move the same way collapse into one clause — the wording the ladder
     * of base charges above already uses — while a change of direction always
     * earns a clause of its own, and the final band always gets one. That is
     * what keeps the last rate the sentence quotes the rate the customer is
     * still paying at the top of the range.
     */
    const steps = stepLadder(price, resolved.currency, unitNoun, bands, entryIndex, units[entryIndex]!, volumePriced);
    const runs = steps.reduce<TierStep[][]>((grouped, step) => {
      const open = grouped[grouped.length - 1];
      if (open && step.direction !== 'plus' && open[0].direction === step.direction) open.push(step);
      else grouped.push([step]);
      return grouped;
    }, []);

    const stepClause = (run: TierStep[]): string => {
      const last = run[run.length - 1];
      const from = bands[last.index].lower - 1;
      if (last.direction === 'plus') {
        return `plus a ${money(last.oneOff)} base once you pass ${qty(from, locale)}`;
      }
      // A run covers the band it stepped away from as well as the ones it reached.
      const reached = run.length === 1
        ? `${last.direction} to`
        : `${last.direction} through ${run.length + 1} tiers to`;
      return volumePriced
        ? `${reached} ${ratePhrase(last.index)} once you pass ${qty(from, locale)}`
        : `${reached} ${ratePhrase(last.index)} beyond ${inUnits(from)}`;
    };

    /*
     * A ladder that changes direction over and over would run the sentence off
     * the card, so past three turns the middle is counted rather than spelled
     * out — `tiers` below still lists every band — and the final one is always
     * spelled out, because that is the rate the reader will budget against.
     */
    if (runs.length <= 3) {
      for (const run of runs) clauses.push(stepClause(run));
    } else {
      clauses.push(stepClause(runs[0]));
      const between = runs.slice(1, -1).reduce((n, run) => n + run.length, 0);
      clauses.push(`${qty(between, locale)} more price changes`);
      clauses.push(`then ${stepClause(runs[runs.length - 1])}`);
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
