/**
 * Meter values are exact.
 *
 * Every quantity is stored as an integer number of micro-units (1 unit =
 * 1,000,000 micro), so a sum is integer addition in SQLite and a JS float never
 * touches a number on its way to becoming money. Totals are read back as text
 * and parsed into BigInt, because a busy month can exceed what a double can
 * represent exactly and silently rounding it would be the worst kind of bug.
 */
import { badRequest } from '../../../shared/errors';

export const MICRO = 1_000_000n;
export const MAX_DECIMALS = 6;

/** The largest value one event may carry, in units. */
export const MAX_EVENT_VALUE = 1_000_000_000n;

/**
 * SQLite stores an INTEGER in 64 bits. Every `*_micro` column is bounded by
 * this, and a write that would pass it is refused at the boundary with a 400 —
 * a store that accepts a number it cannot read back is the worst possible shape
 * for billing data.
 */
export const MAX_MICRO = 9_223_372_036_854_775_807n;

const DECIMAL_RE = /^-?(\d+(\.\d*)?|\.\d+)$/;

/** Parse a value written as a number or a decimal string into micro-units. */
export function parseMicro(input: number | string, param = 'value', max?: bigint): bigint {
  const raw = typeof input === 'number' ? decimalOfNumber(input, param) : String(input).trim();
  if (!DECIMAL_RE.test(raw)) {
    throw badRequest('parameter_invalid', `"${raw}" is not a numeric meter value. Use a number or a plain decimal string such as "12.5".`, param);
  }
  const negative = raw.startsWith('-');
  const body = negative ? raw.slice(1) : raw;
  const [intPart = '0', fracPart = ''] = body.split('.');
  if (fracPart.length > MAX_DECIMALS) {
    throw badRequest(
      'parameter_invalid',
      `Meter values carry at most ${MAX_DECIMALS} decimal places; "${raw}" has ${fracPart.length}.`,
      param,
    );
  }
  const padded = (fracPart + '0'.repeat(MAX_DECIMALS)).slice(0, MAX_DECIMALS);
  const micro = BigInt(`${intPart || '0'}${padded}`) * (negative ? -1n : 1n);
  if (micro < 0n) {
    throw badRequest('parameter_invalid', 'Meter values cannot be negative. Record a correction as its own meter, not as negative usage.', param);
  }
  if (max !== undefined && micro > max * MICRO) {
    throw badRequest('parameter_invalid', `A single meter event cannot carry more than ${Number(max).toLocaleString('en-US')} units.`, param);
  }
  return micro;
}

/** Parse the value carried by one ingested event. */
export const toMicro = (input: number | string, param = 'value'): bigint => parseMicro(input, param, MAX_EVENT_VALUE);

function decimalOfNumber(value: number, param: string): string {
  if (!Number.isFinite(value)) throw badRequest('parameter_invalid', 'Meter values must be finite.', param);
  // Exponential notation ("1e-7") would not survive the decimal parser.
  return Math.abs(value) < 1e-6 && value !== 0 ? value.toFixed(MAX_DECIMALS) : String(value);
}

/** Render micro-units as the shortest exact decimal string. */
export function microToDecimal(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / MICRO;
  const frac = (abs % MICRO).toString().padStart(MAX_DECIMALS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** A convenience number for JSON consumers; `*_decimal` stays authoritative. */
export const microToNumber = (micro: bigint): number => Number(microToDecimal(micro));

/** Round micro-units to a whole billable unit, half-up, exactly once. */
export function microToWholeUnits(micro: bigint): number {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const rounded = (abs + MICRO / 2n) / MICRO;
  const out = negative ? -rounded : rounded;
  if (out > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw badRequest('quantity_too_large', 'This period aggregates to more units than can be billed on one line.');
  }
  return Number(out);
}

export const unitsToMicro = (units: number): bigint => BigInt(Math.round(units)) * MICRO;

/**
 * Refuse a value that cannot survive the round trip into a `*_micro` column.
 *
 * SQLite would either overflow the column or, for a value past 2^63, throw
 * "BigInt value is too large to bind" as an unhandled 500 — and a store that
 * accepts a number it cannot read back is the worst possible shape for billing
 * data. Naming the ceiling and the way out turns that into something a caller
 * can act on.
 */
export function assertStorableMicro(
  micro: bigint,
  opts: { subject: string; param: string; remedy: string },
): bigint {
  if (micro > MAX_MICRO || micro < -MAX_MICRO) {
    throw badRequest(
      'amount_out_of_range',
      `${opts.subject} comes to ${microToDecimal(micro)}, past the largest value this platform stores exactly (${microToDecimal(MAX_MICRO)}). ${opts.remedy}`,
      opts.param,
      { maximum_decimal: microToDecimal(MAX_MICRO) },
    );
  }
  return micro;
}

/** SQLite returns sums as text so a 64-bit total never becomes a lossy double. */
export const bigOf = (raw: unknown): bigint => {
  if (raw === null || raw === undefined || raw === '') return 0n;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') return BigInt(Math.round(raw));
  return BigInt(String(raw));
};
