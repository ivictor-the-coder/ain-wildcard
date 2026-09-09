/**
 * Taking money off, exactly.
 *
 * A coupon is the price book's only subtraction, and it has to obey the same
 * three rules the pricing engine does or an invoice will stop adding up:
 *
 *  1. Nothing is a float. A percentage is stored as an integer number of basis
 *     points — hundredths of a percent, so 20% is 2000 and 33.33% is 3333 —
 *     and multiplied through `src/shared/money.ts`'s BigInt rationals.
 *  2. **Rounding happens exactly once, half-up, on the discount itself** — never
 *     on the remainder. 20% of 9,999 minor units is 1,999.8; the discount is
 *     2,000 and the customer pays 7,999. The half-minor-unit goes to the
 *     customer, and it goes there once: rounding the remainder instead would
 *     agree on one line and disagree on ten, because ten remainders round ten
 *     times and ten discounts round once.
 *  3. The per-line shares are reconciled to that single total by largest
 *     remainder (`allocateExact`, the same function the tier breakdown uses),
 *     so what the invoice shows always sums to what the customer is charged.
 *
 * Everything here is pure: no database, no clock, no org. The store calls it,
 * the routes call it, and billing will call it through `ctx.svc.catalog`.
 */
import { rat, ratMul, ratRound, type Rational } from '../../../shared/money';
import { badRequest } from '../../../shared/errors';
import { allocateExact, ratToDecimal } from './engine';
import { currencyName } from './currencies';
import { formatMinor } from './format';
import type {
  AppliedDiscount, Coupon, CouponInvalidReason, DiscountedLine, PromotionCode,
  PromotionCodeInvalidReason, Validity,
} from './types';

/** Basis points in a whole 100%. A coupon's percentage is an integer of these. */
export const PERCENT_BASIS = 10_000;

/* -------------------------------- validity -------------------------------- */

/** "US dollar (USD)" — the currency named, not just coded, as the engine says it. */
const currencyPhrase = (code: string): string => `${currencyName(code)} (${code.toUpperCase()})`;

/** What a coupon is called in a sentence a person reads. */
const couponName = (coupon: Coupon): string => coupon.name?.trim() || coupon.id;

/** "20% off" / "$50.00 off" — the offer in four words, for a refusal or a row. */
export function describeCoupon(coupon: Coupon, locale = 'en-US'): string {
  const off = coupon.percent_off_basis_points !== null
    ? `${formatPercent(coupon.percent_off_basis_points)}% off`
    : `${formatMinor(coupon.amount_off ?? 0, coupon.currency ?? 'usd', locale)} off`;
  switch (coupon.duration) {
    case 'forever': return `${off}, forever`;
    case 'repeating': return `${off} for ${coupon.duration_in_periods} billing periods`;
    default: return `${off} once`;
  }
}

/** 2000 → "20", 3333 → "33.33". No trailing zeros, no float in the arithmetic. */
export function formatPercent(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const frac = Math.abs(basisPoints % 100);
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

export function couponValidity(coupon: Coupon, now: number): Validity<CouponInvalidReason> {
  if (!coupon.active) {
    return { valid: false, reason: 'inactive', message: `${couponName(coupon)} has been archived and can no longer be redeemed.` };
  }
  if (coupon.redeem_by !== null && now > coupon.redeem_by) {
    return { valid: false, reason: 'expired', message: `${couponName(coupon)} stopped being redeemable on ${new Date(coupon.redeem_by).toISOString().slice(0, 10)}.` };
  }
  if (coupon.max_redemptions !== null && coupon.times_redeemed >= coupon.max_redemptions) {
    return {
      valid: false,
      reason: 'exhausted',
      message: `${couponName(coupon)} has been redeemed its full ${coupon.max_redemptions} times.`,
    };
  }
  return { valid: true, reason: null, message: null };
}

/** Everything a promotion code can be checked against without touching the DB. */
export interface PromotionCodeContext {
  /** How many times this customer has already redeemed this code. */
  customerRedemptions?: number;
  /** The order the code is being applied to, for the minimum-amount floor. */
  amount?: number | null;
  currency?: string | null;
  /** False when the account has been billed before, for `first_time_transaction`. */
  firstTransaction?: boolean;
}

/**
 * A code's standing *and* the coupon's, in one answer, because a customer who
 * types a code cares about the outcome and not about which of the two objects
 * behind it ran out first. The reasons stay distinct so an operator reading the
 * refusal knows which one to edit.
 */
export function promotionCodeValidity(
  code: PromotionCode, coupon: Coupon, now: number, opts: PromotionCodeContext = {},
): Validity<PromotionCodeInvalidReason> {
  const behind = couponValidity(coupon, now);
  if (!behind.valid) {
    return {
      valid: false,
      reason: `coupon_${behind.reason}` as PromotionCodeInvalidReason,
      message: `${code.code} is no longer redeemable: ${behind.message}`,
    };
  }
  if (!code.active) {
    return { valid: false, reason: 'code_inactive', message: `${code.code} has been switched off.` };
  }
  if (code.expires_at !== null && now > code.expires_at) {
    return { valid: false, reason: 'code_expired', message: `${code.code} expired on ${new Date(code.expires_at).toISOString().slice(0, 10)}.` };
  }
  if (code.max_redemptions !== null && code.times_redeemed >= code.max_redemptions) {
    return { valid: false, reason: 'code_exhausted', message: `${code.code} has been used its full ${code.max_redemptions} times.` };
  }
  const perCustomer = code.max_redemptions_per_customer;
  if (perCustomer !== null && (opts.customerRedemptions ?? 0) >= perCustomer) {
    return {
      valid: false,
      reason: 'customer_limit_reached',
      message: `${code.code} may be used ${perCustomer} time${perCustomer === 1 ? '' : 's'} per account, and this account has used it ${opts.customerRedemptions ?? 0}.`,
    };
  }
  const floor = code.restrictions.minimum_amount;
  if (floor !== null && opts.amount !== undefined && opts.amount !== null) {
    const floorCurrency = code.restrictions.minimum_amount_currency ?? 'usd';
    // A floor in one currency says nothing about an order in another: there is
    // no rate here to convert with, and inventing one would silently move money.
    if (opts.currency && opts.currency !== floorCurrency) {
      return {
        valid: false,
        reason: 'below_minimum_amount',
        message: `${code.code} has a minimum of ${formatMinor(floor, floorCurrency)} in ${currencyPhrase(floorCurrency)} and this order is in ${currencyPhrase(opts.currency)}.`,
      };
    }
    if (opts.amount < floor) {
      return {
        valid: false,
        reason: 'below_minimum_amount',
        message: `${code.code} applies to orders of ${formatMinor(floor, floorCurrency)} or more; this one is ${formatMinor(opts.amount, floorCurrency)}.`,
      };
    }
  }
  if (code.restrictions.first_time_transaction && opts.firstTransaction === false) {
    return {
      valid: false,
      reason: 'not_first_transaction',
      message: `${code.code} is for a first order only, and this account has been billed before.`,
    };
  }
  return { valid: true, reason: null, message: null };
}

/* ------------------------------- eligibility ------------------------------ */

/** A line a coupon might reduce. `amount` is integer minor units. */
export interface DiscountLine {
  /** The caller's own identifier, echoed back so it can match the shares up. */
  id?: string | null;
  price?: string | null;
  product?: string | null;
  amount: number;
}

/**
 * Whether a coupon restricted to particular prices or products covers a line.
 *
 * An unrestricted coupon covers everything. A restricted one covers only what
 * it names — and a line that names neither a price nor a product is *not*
 * covered, because the safe reading of "20% off the platform fee" against a
 * line that will not say what it is, is no.
 */
export function couponCovers(coupon: Coupon, line: { price?: string | null; product?: string | null }): boolean {
  const { products, prices } = coupon.applies_to;
  if (!products.length && !prices.length) return true;
  if (line.price && prices.includes(line.price)) return true;
  if (line.product && products.includes(line.product)) return true;
  return false;
}

/* -------------------------------- duration -------------------------------- */

/** How many billing periods the coupon applies to; null means without end. */
export function discountPeriods(coupon: Coupon): number | null {
  if (coupon.duration === 'forever') return null;
  if (coupon.duration === 'repeating') return coupon.duration_in_periods ?? 1;
  return 1;
}

/** Whether the coupon still applies to the `index`-th period, counting from 0. */
export function couponAppliesToPeriod(coupon: Coupon, index: number): boolean {
  if (index < 0) return false;
  const periods = discountPeriods(coupon);
  return periods === null || index < periods;
}

/* ------------------------------- arithmetic ------------------------------- */

/** The coupon's percentage as an exact fraction, or null on an amount-off one. */
function percentFraction(coupon: Coupon): Rational | null {
  if (coupon.percent_off_basis_points === null) return null;
  return rat(BigInt(coupon.percent_off_basis_points), BigInt(PERCENT_BASIS));
}

/**
 * An amount-off coupon is denominated. A $50-off coupon has nothing to say
 * about a bill in euros — there is no exchange rate in the price book, and
 * quietly treating 5000 minor units of one currency as 5000 of another is how
 * a €50 discount becomes a £58 one.
 */
function assertCurrencyMatches(coupon: Coupon, currency: string): void {
  if (coupon.amount_off === null || !coupon.currency) return;
  if (coupon.currency === currency) return;
  throw badRequest(
    'coupon_currency_mismatch',
    `${couponName(coupon)} takes ${formatMinor(coupon.amount_off, coupon.currency)} off a bill in ${currencyPhrase(coupon.currency)}, and this one is in ${currencyPhrase(currency)}. Use a percentage coupon, or add a separate ${currency.toUpperCase()} coupon.`,
    'coupon',
    { coupon: coupon.id, coupon_currency: coupon.currency, currency },
  );
}

/**
 * Spread one coupon across a set of lines.
 *
 * Only positive, covered lines form the base: a discount reduces what is owed,
 * so a credit line neither enlarges the base nor takes anything off — otherwise
 * a -$100 proration beside a $100 charge would earn a discount on $200.
 */
export function distributeDiscount(coupon: Coupon, lines: DiscountLine[], currency: string): AppliedDiscount {
  const code = currency.toLowerCase();
  assertCurrencyMatches(coupon, code);

  const eligible = lines.map((line) => couponCovers(coupon, line));
  const bases = lines.map((line, i) => (eligible[i] && line.amount > 0 ? line.amount : 0));
  const subtotal = lines.reduce((acc, line) => acc + line.amount, 0);
  const eligibleSubtotal = bases.reduce((acc, n) => acc + n, 0);

  const percent = percentFraction(coupon);
  // The exact discount, before it is rounded: the one place a percentage and a
  // fixed amount stop looking different.
  let exact: Rational;
  let capped = false;
  if (percent) {
    exact = ratMul(rat(BigInt(eligibleSubtotal)), percent);
  } else {
    const off = coupon.amount_off ?? 0;
    capped = off > eligibleSubtotal;
    exact = rat(BigInt(Math.min(off, eligibleSubtotal)));
  }

  // The single rounding. `exact` can never exceed the base — a percentage is at
  // most 100% of it and a fixed amount was already taken as a `min` — and
  // half-up is monotone, so the discount cannot turn a bill negative.
  const total = ratRound(exact, 'half_up');

  const shares = eligibleSubtotal > 0
    ? allocateExact(bases.map((base) => ratMul(exact, rat(BigInt(base), BigInt(eligibleSubtotal)))), total)
    : lines.map(() => 0n);

  const out: DiscountedLine[] = lines.map((line, i) => ({
    index: i,
    id: line.id ?? null,
    eligible: eligible[i],
    amount: line.amount,
    discount: Number(shares[i]),
    discount_decimal: eligibleSubtotal > 0
      ? ratToDecimal(ratMul(exact, rat(BigInt(bases[i]), BigInt(eligibleSubtotal))))
      : '0',
    remaining: line.amount - Number(shares[i]),
  }));

  return {
    object: 'applied_discount',
    coupon: coupon.id,
    currency: code,
    subtotal,
    eligible_subtotal: eligibleSubtotal,
    amount: Number(total),
    amount_decimal: ratToDecimal(exact),
    remaining: subtotal - Number(total),
    capped,
    lines: out,
  };
}

/**
 * The same arithmetic against a single amount — a subtotal, one invoice line,
 * one subscription item.
 *
 * A coupon restricted to named prices or products cannot answer for a bare
 * number, so it says so rather than guessing: silently discounting would ignore
 * the restriction and silently returning zero would look like a working coupon
 * that does nothing.
 */
export function discountOn(
  coupon: Coupon, amount: number, currency: string, subject: { price?: string | null; product?: string | null } = {},
): AppliedDiscount {
  const restricted = coupon.applies_to.products.length > 0 || coupon.applies_to.prices.length > 0;
  if (restricted && !subject.price && !subject.product) {
    throw badRequest(
      'coupon_restriction_unresolved',
      `${couponName(coupon)} only applies to particular prices, so it cannot be applied to a bare amount. Pass the price or product the amount came from, or send the lines instead.`,
      'coupon',
      { coupon: coupon.id, applies_to: coupon.applies_to },
    );
  }
  return distributeDiscount(coupon, [{ ...subject, amount }], currency);
}
