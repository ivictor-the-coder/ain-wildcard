/**
 * The pricing engine.
 *
 * Every invoice line in the platform is produced here, so the rules are worth
 * stating precisely:
 *
 *  1. Nothing is a float. Unit amounts, tiers and prorations are exact BigInt
 *     rationals from `src/shared/money.ts`.
 *  2. Rounding happens exactly once, on the final total, half-up. The rows of
 *     the breakdown are then reconciled to that total by largest remainder, so
 *     the explanation always adds up to the number the customer is charged.
 *  3. `unit_amount_decimal` is a decimal string in *minor units*, matching
 *     Stripe: "0.04" is 0.04 cents, i.e. $0.0004 per event.
 */
import {
  rat, ratAdd, ratMul, ratSub, ratCmp, ratRound, type Rational, type RoundingMode,
} from '../../../shared/money';
import { badRequest } from '../../../shared/errors';
import type {
  CurrencyOption, CurvePoint, CustomUnitAmount, LineAmount, LineBreakdownRow, Price,
  PriceCurve, PriceTier, TaxBehavior, TransformQuantity, UsageAggregation, UsageRecord,
} from './types';

const ZERO = rat(0n);
const ONE = rat(1n);

/* ------------------------------ exact decimals ---------------------------- */

const DECIMAL_RE = /^-?(\d+(\.\d*)?|\.\d+)$/;

/** Parse a decimal string of minor units into an exact rational. */
export function decimalToRat(input: string | number, param = 'unit_amount_decimal'): Rational {
  const s = typeof input === 'number' ? String(input) : String(input).trim();
  if (!DECIMAL_RE.test(s)) {
    throw badRequest('parameter_invalid', `"${s}" is not a decimal amount. Use a plain decimal string such as "0.04".`, param);
  }
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const [intPart = '0', fracPart = ''] = body.split('.');
  if (fracPart.length > 12) {
    throw badRequest('parameter_invalid', 'Decimal amounts support at most 12 decimal places.', param);
  }
  const digits = `${intPart || '0'}${fracPart}`;
  const n = BigInt(digits || '0') * (negative ? -1n : 1n);
  return rat(n, 10n ** BigInt(fracPart.length));
}

/** Render an exact rational as the shortest decimal string, rounding half-up. */
export function ratToDecimal(value: Rational, places = 12): string {
  const scaled = ratRound(ratMul(value, rat(10n ** BigInt(places), 1n)), 'half_up');
  const negative = scaled < 0n;
  const raw = (negative ? -scaled : scaled).toString().padStart(places + 1, '0');
  const intPart = raw.slice(0, raw.length - places);
  const frac = raw.slice(raw.length - places).replace(/0+$/, '');
  const out = `${intPart}${frac ? `.${frac}` : ''}`;
  return negative && out !== '0' ? `-${out}` : out;
}

function ratFloor(v: Rational): bigint {
  const q = v.n / v.d;
  return v.n < 0n && q * v.d !== v.n ? q - 1n : q;
}

/* --------------------------- per-currency resolution ---------------------- */

export interface ResolvedPrice {
  currency: string;
  unitAmount: Rational | null;
  unitAmountDecimal: string | null;
  tiers: PriceTier[] | null;
  customUnitAmount: CustomUnitAmount | null;
  taxBehavior: TaxBehavior;
}

export const currenciesOf = (price: Price): string[] =>
  [price.currency, ...Object.keys(price.currency_options || {})].filter((c, i, all) => all.indexOf(c) === i);

const optionIsOffered = (o: CurrencyOption): boolean =>
  o.unit_amount !== null && o.unit_amount !== undefined
  || !!o.unit_amount_decimal
  || (Array.isArray(o.tiers) && o.tiers.length > 0)
  || !!o.custom_unit_amount?.enabled;

/** Pick the amounts a price charges in `currency`, or explain why it can't. */
export function resolveForCurrency(price: Price, currency?: string): ResolvedPrice {
  const want = (currency || price.currency).toLowerCase();
  if (want === price.currency) {
    return {
      currency: want,
      unitAmount: unitAmountRat(price.unit_amount, price.unit_amount_decimal),
      unitAmountDecimal: amountDecimal(price.unit_amount, price.unit_amount_decimal),
      tiers: price.tiers,
      customUnitAmount: price.custom_unit_amount,
      taxBehavior: price.tax_behavior,
    };
  }
  const option = (price.currency_options || {})[want];
  if (!option || !optionIsOffered(option)) {
    throw badRequest(
      'currency_not_supported',
      `Price ${price.id} is not offered in ${want.toUpperCase()}. It sells in ${currenciesOf(price).map((c) => c.toUpperCase()).join(', ')}.`,
      'currency',
    );
  }
  return {
    currency: want,
    unitAmount: unitAmountRat(option.unit_amount ?? null, option.unit_amount_decimal ?? null),
    unitAmountDecimal: amountDecimal(option.unit_amount ?? null, option.unit_amount_decimal ?? null),
    tiers: option.tiers ?? null,
    customUnitAmount: option.custom_unit_amount ?? null,
    taxBehavior: option.tax_behavior ?? price.tax_behavior,
  };
}

function unitAmountRat(amount: number | null | undefined, decimal: string | null | undefined): Rational | null {
  if (decimal !== null && decimal !== undefined && decimal !== '') return decimalToRat(decimal);
  if (amount !== null && amount !== undefined) return rat(BigInt(Math.trunc(amount)));
  return null;
}

function amountDecimal(amount: number | null | undefined, decimal: string | null | undefined): string | null {
  if (decimal !== null && decimal !== undefined && decimal !== '') return ratToDecimal(decimalToRat(decimal));
  if (amount !== null && amount !== undefined) return String(Math.trunc(amount));
  return null;
}

export const tierUnit = (t: PriceTier): Rational | null => unitAmountRat(t.unit_amount, t.unit_amount_decimal);
export const tierFlat = (t: PriceTier): Rational | null => unitAmountRat(t.flat_amount, t.flat_amount_decimal);
export const tierCap = (t: PriceTier): number => (t.up_to === 'inf' ? Number.POSITIVE_INFINITY : t.up_to);

/* ------------------------------ quantity shaping -------------------------- */

/** Package pricing: 2,300 units at "per 1,000, round up" bills as 3. */
export function applyTransform(quantity: number, transform: TransformQuantity | null | undefined): number {
  if (!transform || transform.divide_by <= 1) return quantity;
  const blocks = quantity / transform.divide_by;
  return transform.round === 'down' ? Math.floor(blocks) : Math.ceil(blocks);
}

export function assertQuantity(quantity: number, param = 'quantity'): number {
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity)) {
    throw badRequest('parameter_invalid', 'Quantity must be a whole number.', param);
  }
  if (quantity < 0) throw badRequest('parameter_invalid', 'Quantity cannot be negative.', param);
  if (quantity > Number.MAX_SAFE_INTEGER) throw badRequest('parameter_invalid', 'Quantity is too large to bill.', param);
  return quantity;
}

/* --------------------------------- tiering -------------------------------- */

interface RawRow {
  kind: LineBreakdownRow['kind'];
  label: string;
  tier: number | null;
  up_to: number | 'inf' | null;
  quantity: number;
  unitDecimal: string | null;
  value: Rational;
}

/**
 * Unit labels are nouns the operator typed ("seat", "event") or units of
 * measure ("GB", "kWh"). Only the former take a plural.
 */
export function pluralUnit(noun: string, n: number): string {
  if (n === 1 || /[A-Z]/.test(noun)) return noun;
  if (/(s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${pluralUnit(one, n)}`;
const rangeLabel = (from: number, to: number | 'inf'): string =>
  to === 'inf' ? `${from.toLocaleString('en-US')} and above` : `${from.toLocaleString('en-US')}–${to.toLocaleString('en-US')}`;

function graduatedRows(tiers: PriceTier[], quantity: number, unitNoun: string): RawRow[] {
  const rows: RawRow[] = [];
  let previousCap = 0;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const cap = tierCap(tier);
    const unitsInTier = Math.max(0, Math.min(quantity, cap) - previousCap);
    // The first tier is always entered: its flat amount is the plan's floor,
    // which is what makes "$99/month including 10,000 events" behave correctly.
    const entered = unitsInTier > 0 || i === 0;
    if (!entered) break;

    const flat = tierFlat(tier);
    if (flat && flat.n !== 0n) {
      rows.push({
        kind: 'tier_flat', label: `Tier ${i + 1} base charge (${rangeLabel(previousCap + 1, tier.up_to)})`,
        tier: i + 1, up_to: tier.up_to, quantity: 0, unitDecimal: null, value: flat,
      });
    }
    const unit = tierUnit(tier);
    if (unit && unitsInTier > 0) {
      const free = unit.n === 0n;
      rows.push({
        kind: free ? 'included' : 'tier',
        label: free
          ? `${plural(unitsInTier, unitNoun)} included (first ${cap === Number.POSITIVE_INFINITY ? '∞' : cap.toLocaleString('en-US')})`
          : `${plural(unitsInTier, unitNoun)} at tier ${i + 1} (${rangeLabel(previousCap + 1, tier.up_to)})`,
        tier: i + 1, up_to: tier.up_to, quantity: unitsInTier, unitDecimal: ratToDecimal(unit),
        value: ratMul(unit, rat(BigInt(unitsInTier))),
      });
    }
    previousCap = cap;
    if (quantity <= cap) break;
  }
  return rows;
}

function volumeRows(tiers: PriceTier[], quantity: number, unitNoun: string): RawRow[] {
  let index = tiers.findIndex((t) => quantity <= tierCap(t));
  if (index < 0) index = tiers.length - 1;
  const tier = tiers[index];
  const previousCap = index === 0 ? 0 : tierCap(tiers[index - 1]);
  const rows: RawRow[] = [];
  const flat = tierFlat(tier);
  if (flat && flat.n !== 0n) {
    rows.push({
      kind: 'tier_flat', label: `Tier ${index + 1} base charge (${rangeLabel(previousCap + 1, tier.up_to)})`,
      tier: index + 1, up_to: tier.up_to, quantity: 0, unitDecimal: null, value: flat,
    });
  }
  const unit = tierUnit(tier);
  if (unit) {
    const free = unit.n === 0n;
    rows.push({
      kind: free ? 'included' : 'tier',
      label: free
        ? `${plural(quantity, unitNoun)} included at tier ${index + 1}`
        : `${plural(quantity, unitNoun)} at the tier ${index + 1} rate (${rangeLabel(previousCap + 1, tier.up_to)})`,
      tier: index + 1, up_to: tier.up_to, quantity, unitDecimal: ratToDecimal(unit),
      value: ratMul(unit, rat(BigInt(quantity))),
    });
  }
  return rows;
}

/* -------------------------------- the engine ------------------------------ */

export interface ComputeOptions {
  /** Exact fraction of the period being charged, for mid-cycle changes. */
  proration?: { numerator: number; denominator: number } | null;
  /** Negotiated amount, in minor units, for a `custom` price. */
  customUnitAmount?: number | null;
  /** Overrides the default half-up rounding of the final total. */
  rounding?: RoundingMode;
  /** Noun used in breakdown copy — usually the product's `unit_label`. */
  unitLabel?: string | null;
}

function rawRowsFor(price: Price, resolved: ResolvedPrice, quantity: number, opts: ComputeOptions): { rows: RawRow[]; billable: number } {
  const unitNoun = (opts.unitLabel || 'unit').trim() || 'unit';

  if (price.model === 'flat') {
    const unit = resolved.unitAmount;
    if (!unit) throw badRequest('price_incomplete', `Price ${price.id} has no amount in ${resolved.currency.toUpperCase()}.`, 'price');
    const name = price.nickname || 'Flat fee';
    return {
      billable: 1,
      rows: [{
        kind: 'flat',
        // The quantity is not billed, so the row that swallowed it says so.
        label: quantity === 1
          ? name
          : `${name} — one charge whatever the quantity (${quantity.toLocaleString('en-US')} ${pluralUnit(unitNoun, quantity)} asked for, 1 billed)`,
        tier: null, up_to: null,
        quantity: 1, unitDecimal: ratToDecimal(unit), value: unit,
      }],
    };
  }

  if (price.model === 'custom') {
    const custom = resolved.customUnitAmount;
    const supplied = opts.customUnitAmount;
    if (supplied === null || supplied === undefined) {
      throw badRequest(
        'price_requires_custom_amount',
        `Price ${price.id} is a negotiated price. Supply custom_unit_amount (in minor units) to compute a line.`,
        'custom_unit_amount',
      );
    }
    if (!Number.isInteger(supplied)) throw badRequest('parameter_invalid', 'custom_unit_amount must be a whole number of minor units.', 'custom_unit_amount');
    if (custom?.minimum !== null && custom?.minimum !== undefined && supplied < custom.minimum) {
      throw badRequest('amount_too_small', `This price accepts at least ${custom.minimum} ${resolved.currency.toUpperCase()} minor units.`, 'custom_unit_amount');
    }
    if (custom?.maximum !== null && custom?.maximum !== undefined && supplied > custom.maximum) {
      throw badRequest('amount_too_large', `This price accepts at most ${custom.maximum} ${resolved.currency.toUpperCase()} minor units.`, 'custom_unit_amount');
    }
    const unit = rat(BigInt(supplied));
    const billable = applyTransform(quantity, price.transform_quantity);
    return {
      billable,
      rows: [{
        kind: 'custom', label: `${plural(billable, unitNoun)} at the negotiated rate`, tier: null, up_to: null,
        quantity: billable, unitDecimal: ratToDecimal(unit), value: ratMul(unit, rat(BigInt(billable))),
      }],
    };
  }

  const billable = applyTransform(quantity, price.transform_quantity);
  const tiers = resolved.tiers;

  if (price.billing_scheme === 'tiered') {
    if (!tiers || !tiers.length) {
      throw badRequest('price_incomplete', `Tiered price ${price.id} has no tiers in ${resolved.currency.toUpperCase()}.`, 'tiers');
    }
    const rows = price.tiers_mode === 'volume'
      ? volumeRows(tiers, billable, unitNoun)
      : graduatedRows(tiers, billable, unitNoun);
    return { billable, rows };
  }

  const unit = resolved.unitAmount;
  if (!unit) throw badRequest('price_incomplete', `Price ${price.id} has no amount in ${resolved.currency.toUpperCase()}.`, 'price');

  if (price.transform_quantity && price.transform_quantity.divide_by > 1) {
    const t = price.transform_quantity;
    return {
      billable,
      rows: [{
        kind: 'package',
        label: `${plural(billable, 'package')} of ${plural(t.divide_by, unitNoun)}${t.round === 'up' ? ' (part packages round up)' : ' (part packages are not charged)'}`,
        tier: null, up_to: null, quantity: billable, unitDecimal: ratToDecimal(unit),
        value: ratMul(unit, rat(BigInt(billable))),
      }],
    };
  }

  return {
    billable,
    rows: [{
      kind: 'per_unit', label: `${plural(billable, unitNoun)} at ${ratToDecimal(unit)} minor units each`,
      tier: null, up_to: null, quantity: billable, unitDecimal: ratToDecimal(unit),
      value: ratMul(unit, rat(BigInt(billable))),
    }],
  };
}

const sumRows = (rows: RawRow[]): Rational => rows.reduce((acc, r) => ratAdd(acc, r.value), ZERO);

/** The exact, unrounded amount for a quantity — the basis of everything else. */
export function exactAmount(price: Price, quantity: number, currency?: string, opts: ComputeOptions = {}): Rational {
  const resolved = resolveForCurrency(price, currency);
  return sumRows(rawRowsFor(price, resolved, assertQuantity(quantity), opts).rows);
}

/**
 * Turn a quantity into money, with an explanation that adds up to the cent.
 */
export function computeLineAmount(price: Price, quantity: number, currency?: string, opts: ComputeOptions = {}): LineAmount {
  assertQuantity(quantity);
  const resolved = resolveForCurrency(price, currency);
  const { rows, billable } = rawRowsFor(price, resolved, quantity, opts);

  const proration = opts.proration ?? null;
  let factor = ONE;
  if (proration) {
    if (!Number.isFinite(proration.numerator) || !Number.isFinite(proration.denominator) || proration.denominator === 0) {
      throw badRequest('parameter_invalid', 'Proration must be a fraction with a non-zero denominator.', 'proration');
    }
    factor = rat(BigInt(Math.round(proration.numerator)), BigInt(Math.round(proration.denominator)));
  }

  const scaled = rows.map((r) => (proration ? { ...r, value: ratMul(r.value, factor) } : r));
  const exact = sumRows(scaled);
  const total = ratRound(exact, opts.rounding ?? 'half_up');
  const shares = allocateExact(scaled.map((r) => r.value), total);

  const breakdown: LineBreakdownRow[] = scaled.map((r, i) => ({
    kind: r.kind,
    label: r.label,
    tier: r.tier,
    up_to: r.up_to,
    quantity: r.quantity,
    unit_amount_decimal: r.unitDecimal,
    amount: Number(shares[i]),
    amount_decimal: ratToDecimal(r.value),
  }));

  const marginal = price.model === 'flat'
    ? ZERO
    : ratSub(
        safeExact(price, resolved, quantity + 1, opts),
        safeExact(price, resolved, quantity, opts),
      );

  return {
    object: 'line_amount',
    price: price.id,
    currency: resolved.currency,
    quantity,
    billable_quantity: billable,
    amount: Number(total),
    amount_decimal: ratToDecimal(exact),
    effective_unit_amount_decimal: quantity > 0 ? ratToDecimal(rat(exact.n, exact.d * BigInt(quantity))) : '0',
    marginal_unit_amount_decimal: ratToDecimal(proration ? ratMul(marginal, factor) : marginal),
    breakdown,
    proration,
  };
}

function safeExact(price: Price, resolved: ResolvedPrice, quantity: number, opts: ComputeOptions): Rational {
  try { return sumRows(rawRowsFor(price, resolved, quantity, opts).rows); }
  catch { return ZERO; }
}

/**
 * Split an exact total across rows so the visible parts sum to the charged
 * total: floor every row, then hand the remaining minor units to the rows with
 * the largest fractional parts (largest-remainder, stable by position).
 */
export function allocateExact(values: Rational[], total: bigint): bigint[] {
  if (!values.length) return [];
  const floors = values.map(ratFloor);
  const allocated = floors.reduce((a, b) => a + b, 0n);
  let remainder = total - allocated;
  if (remainder === 0n) return floors;
  const step = remainder > 0n ? 1n : -1n;
  const order = values
    .map((v, i) => ({ i, frac: ratSub(v, rat(floors[i])) }))
    .sort((a, b) => (step > 0n ? ratCmp(b.frac, a.frac) : ratCmp(a.frac, b.frac)) || a.i - b.i);
  let k = 0;
  while (remainder !== 0n && k < order.length * 2) {
    floors[order[k % order.length].i] += step;
    remainder -= step;
    k++;
  }
  return floors;
}

/* ------------------------------- usage rollup ----------------------------- */

/** Collapse metered usage records into the quantity a price bills for. */
export function aggregateUsage(records: UsageRecord[], aggregation: UsageAggregation): number {
  if (!records.length) return 0;
  switch (aggregation) {
    case 'sum':
      return records.reduce((acc, r) => acc + r.quantity, 0);
    case 'max':
      return records.reduce((acc, r) => Math.max(acc, r.quantity), 0);
    case 'last_during_period':
    case 'last_ever': {
      let latest = records[0];
      for (const r of records) if (r.timestamp >= latest.timestamp) latest = r;
      return latest.quantity;
    }
    case 'unique': {
      const seen = new Set<string>();
      for (const r of records) seen.add(r.key ?? String(r.quantity));
      return seen.size;
    }
  }
}

/* -------------------------------- cost curve ------------------------------ */

export interface CurveOptions {
  from?: number;
  to?: number;
  /** Number of evenly spaced samples; tier boundaries are always added. */
  points?: number;
  /** Explicit quantities to price, overriding the range sampling. */
  quantities?: number[];
  customUnitAmount?: number | null;
  unitLabel?: string | null;
}

/** Boundary quantities where a price's marginal rate changes. */
export function boundariesOf(price: Price, currency?: string): number[] {
  const resolved = resolveForCurrency(price, currency);
  const out = new Set<number>();
  for (const tier of resolved.tiers ?? []) {
    const cap = tierCap(tier);
    if (Number.isFinite(cap)) out.add(cap);
  }
  const t = price.transform_quantity;
  if (t && t.divide_by > 1) for (let i = 1; i <= 6; i++) out.add(t.divide_by * i);
  return [...out].sort((a, b) => a - b);
}

/**
 * The effective unit-cost curve behind the pricing page's
 * "what would 25,000 events cost?" widget.
 */
export function previewCurve(price: Price, currency?: string, opts: CurveOptions = {}): PriceCurve {
  const resolved = resolveForCurrency(price, currency);
  const boundaries = boundariesOf(price, currency);
  const defaultTop = boundaries.length ? Math.ceil(boundaries[boundaries.length - 1] * 1.5) : 100;
  const from = Math.max(0, Math.floor(opts.from ?? 0));
  const to = Math.max(from + 1, Math.floor(opts.to ?? defaultTop));
  const sampleCount = Math.min(Math.max(opts.points ?? 24, 2), 250);

  const quantities = new Set<number>();
  if (opts.quantities?.length) {
    for (const q of opts.quantities) quantities.add(assertQuantity(Math.floor(q)));
  } else {
    for (let i = 0; i < sampleCount; i++) {
      quantities.add(Math.round(from + ((to - from) * i) / (sampleCount - 1)));
    }
    // The interesting shape of a tiered price lives at its boundaries.
    for (const b of boundaries) {
      for (const q of [b - 1, b, b + 1]) if (q >= from && q <= to && q >= 0) quantities.add(q);
    }
  }

  const boundarySet = new Set(boundaries);
  const points: CurvePoint[] = [...quantities]
    .sort((a, b) => a - b)
    .slice(0, 400)
    .map((quantity) => {
      const line = computeLineAmount(price, quantity, resolved.currency, {
        customUnitAmount: opts.customUnitAmount ?? null,
        unitLabel: opts.unitLabel ?? null,
      });
      return {
        quantity,
        amount: line.amount,
        effective_unit_amount_decimal: line.effective_unit_amount_decimal,
        marginal_unit_amount_decimal: line.marginal_unit_amount_decimal,
        boundary: boundarySet.has(quantity),
      };
    });

  const amounts = points.map((p) => p.amount);
  const priced = points.filter((p) => p.quantity > 0);
  const effective = priced.map((p) => decimalToRat(p.effective_unit_amount_decimal));
  const best = effective.length ? effective.reduce((a, b) => (ratCmp(a, b) <= 0 ? a : b)) : ZERO;
  const worst = effective.length ? effective.reduce((a, b) => (ratCmp(a, b) >= 0 ? a : b)) : ZERO;

  return {
    object: 'price_curve',
    price: price.id,
    currency: resolved.currency,
    from,
    to,
    points,
    boundaries,
    min_amount: amounts.length ? Math.min(...amounts) : 0,
    max_amount: amounts.length ? Math.max(...amounts) : 0,
    best_unit_amount_decimal: ratToDecimal(best),
    worst_unit_amount_decimal: ratToDecimal(worst),
  };
}

/* ------------------------------- shape checks ----------------------------- */

/** Tiers must be strictly ascending, priced, and end at infinity. */
export function validateTiers(tiers: PriceTier[], param = 'tiers'): void {
  if (!tiers.length) throw badRequest('parameter_invalid', 'A tiered price needs at least one tier.', param);
  let previous = 0;
  tiers.forEach((tier, i) => {
    const path = `${param}[${i}]`;
    const isLast = i === tiers.length - 1;
    if (tier.up_to === 'inf') {
      if (!isLast) throw badRequest('parameter_invalid', 'Only the final tier may be open-ended (up_to: "inf").', `${path}.up_to`);
    } else {
      if (!Number.isInteger(tier.up_to) || tier.up_to <= 0) {
        throw badRequest('parameter_invalid', 'up_to must be a positive whole number or "inf".', `${path}.up_to`);
      }
      if (tier.up_to <= previous) {
        throw badRequest('parameter_invalid', `up_to must increase: tier ${i + 1} ends at ${tier.up_to}, after tier ${i} already reached ${previous}.`, `${path}.up_to`);
      }
      previous = tier.up_to;
    }
    if (tierUnit(tier) === null && tierFlat(tier) === null) {
      throw badRequest('parameter_invalid', 'Every tier needs a unit_amount, a flat_amount, or both.', path);
    }
  });
  if (tiers[tiers.length - 1].up_to !== 'inf') {
    throw badRequest('parameter_invalid', 'The last tier must be open-ended: set up_to to "inf" so every quantity is priced.', `${param}[${tiers.length - 1}].up_to`);
  }
}
