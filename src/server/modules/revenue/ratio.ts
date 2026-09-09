/**
 * Ratios that can be checked by hand.
 *
 * A retention rate is a division, and a division is where a revenue report
 * usually stops being verifiable: the number arrives as `0.9734` and nobody can
 * say which two figures produced it. Every rate this module publishes carries
 * the numerator and the denominator it came from, and the rounding happens once
 * — from an exact BigInt rational into basis points — so `bps` and `percent`
 * are two renderings of one number rather than two chances to disagree.
 */
import { rat, ratMul, ratRound, type RoundingMode } from '../../../shared/money';

export interface Ratio {
  /** Basis points. 10_000 is 100%. Rounded half-up from the exact rational. */
  bps: number;
  /** The exact fraction behind `bps`, so the division can be redone by hand. */
  numerator: number;
  denominator: number;
  /** "97.34%", rendered from `bps`, never from a float. */
  percent: string;
  /** True when the denominator was zero and the rate has no meaning. */
  undefined_rate: boolean;
}

export function formatBps(bps: number): string {
  const sign = bps < 0 ? '-' : '';
  const abs = Math.abs(bps);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
}

/** `numerator / denominator` as basis points, with the fraction kept alongside. */
export function ratio(numerator: number, denominator: number): Ratio {
  if (denominator === 0) {
    return { bps: 0, numerator, denominator: 0, percent: 'n/a', undefined_rate: true };
  }
  const bps = Number(ratRound(ratMul(rat(numerator, denominator), rat(10_000n)), 'half_up'));
  return { bps, numerator, denominator, percent: formatBps(bps), undefined_rate: false };
}

/**
 * A quantity that is not money and not a rate — days of sales outstanding,
 * units per account — carried to two decimal places as an integer so nothing
 * downstream has to trust a float.
 */
export interface Decimal2 {
  /** The value times 100. */
  scaled: number;
  scale: 100;
  /** "42.31" */
  display: string;
  numerator: number;
  denominator: number;
  undefined_value: boolean;
}

export function decimal2(numerator: number, denominator: number, mode: RoundingMode = 'half_up'): Decimal2 {
  if (denominator === 0) {
    return { scaled: 0, scale: 100, display: 'n/a', numerator, denominator: 0, undefined_value: true };
  }
  const scaled = Number(ratRound(ratMul(rat(numerator, denominator), rat(100n)), mode));
  const sign = scaled < 0 ? '-' : '';
  const abs = Math.abs(scaled);
  return {
    scaled,
    scale: 100,
    display: `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`,
    numerator,
    denominator,
    undefined_value: false,
  };
}
