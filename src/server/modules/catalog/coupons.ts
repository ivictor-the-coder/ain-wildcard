/**
 * Reading and writing coupons, the codes that hand them out, and the rows that
 * record them being taken up.
 *
 * The same two rules as the rest of the catalog. Every statement filters on
 * `org_id`; and a coupon that has been redeemed can no longer change what it is
 * worth — you archive it and issue another — because the invoice that took 20%
 * off last quarter has to keep saying 20% forever.
 *
 * `times_redeemed` is a `COUNT(*)` over the redemption rows, never a column.
 * A counter would have to be decremented by every undo path in the platform
 * and would be wrong the first time one forgot.
 */
import type { Ctx } from '../../kernel/context';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { cursorOf, newId, parseCursor } from '../../../shared/ids';
import { assertCurrency } from './currencies';
import {
  couponValidity, PERCENT_BASIS, promotionCodeValidity, type PromotionCodeContext,
} from './discounts';
import { diff, type Page, type WriteMeta } from './store';
import {
  COUPON_DURATIONS, type Coupon, type CouponAppliesTo, type CouponDuration, type CouponRedemption,
  type PromotionCode, type PromotionCodeInvalidReason, type Validity,
} from './types';

/* --------------------------------- inputs --------------------------------- */

export interface CouponInput {
  id?: string;
  name?: string | null;
  /** 20 means 20%; at most two decimal places. Exclusive with `amount_off`. */
  percent_off?: number | null;
  /** The same figure with no float in it: hundredths of a percent. */
  percent_off_basis_points?: number | null;
  amount_off?: number | null;
  currency?: string | null;
  duration?: CouponDuration;
  duration_in_periods?: number | null;
  max_redemptions?: number | null;
  redeem_by?: number | null;
  applies_to?: { products?: string[]; prices?: string[] };
  active?: boolean;
  metadata?: Record<string, string>;
}

export interface PromotionCodeInput {
  id?: string;
  coupon: string;
  /** Upper-cased on the way in; generated when omitted. */
  code?: string | null;
  active?: boolean;
  expires_at?: number | null;
  max_redemptions?: number | null;
  max_redemptions_per_customer?: number | null;
  minimum_amount?: number | null;
  minimum_amount_currency?: string | null;
  first_time_transaction?: boolean;
  metadata?: Record<string, string>;
}

export interface CouponListFilter {
  active?: boolean;
  /** Redeemable right now — active, in date, and not exhausted. */
  valid?: boolean;
  duration?: CouponDuration;
  currency?: string;
  query?: string;
  limit?: number;
  cursor?: string | null;
}

export interface PromotionCodeListFilter {
  coupon?: string;
  code?: string;
  active?: boolean;
  limit?: number;
  cursor?: string | null;
}

export interface RedemptionInput {
  coupon: string;
  promotion_code?: string | null;
  customer?: string | null;
  /** What will hold the discount — `{ type: 'subscription', id: 'sub_…' }`. */
  ref?: { type: string; id: string } | null;
}

export interface RedemptionListFilter {
  coupon?: string;
  promotion_code?: string;
  customer?: string;
  limit?: number;
}

/* ------------------------------- hydration -------------------------------- */

const parseIds = (raw: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
};

export function hydrateCoupon(row: any, now: number): Coupon {
  const bps = row.percent_off_bps === null || row.percent_off_bps === undefined ? null : Number(row.percent_off_bps);
  const coupon: Coupon = {
    object: 'coupon',
    id: row.id,
    name: row.name ?? null,
    percent_off: bps === null ? null : bps / 100,
    percent_off_basis_points: bps,
    amount_off: row.amount_off === null || row.amount_off === undefined ? null : Number(row.amount_off),
    currency: row.currency ?? null,
    duration: row.duration as CouponDuration,
    duration_in_periods: row.duration_in_periods ?? null,
    max_redemptions: row.max_redemptions ?? null,
    times_redeemed: Number(row.times_redeemed ?? 0),
    redeem_by: row.redeem_by ?? null,
    applies_to: { products: parseIds(row.applies_to_products), prices: parseIds(row.applies_to_prices) },
    active: !!row.active,
    valid: false,
    metadata: JSON.parse(String(row.metadata ?? '{}')),
    created: Number(row.created),
    updated: Number(row.updated),
    livemode: !!row.livemode,
  };
  coupon.valid = couponValidity(coupon, now).valid;
  return coupon;
}

export function hydratePromotionCode(row: any, coupon: Coupon, now: number): PromotionCode {
  const code: PromotionCode = {
    object: 'promotion_code',
    id: row.id,
    code: row.code,
    coupon: row.coupon_id,
    active: !!row.active,
    expires_at: row.expires_at ?? null,
    max_redemptions: row.max_redemptions ?? null,
    max_redemptions_per_customer: row.max_redemptions_per_customer ?? null,
    times_redeemed: Number(row.times_redeemed ?? 0),
    restrictions: {
      minimum_amount: row.minimum_amount ?? null,
      minimum_amount_currency: row.minimum_amount_currency ?? null,
      first_time_transaction: !!row.first_time_transaction,
    },
    valid: false,
    metadata: JSON.parse(String(row.metadata ?? '{}')),
    created: Number(row.created),
    updated: Number(row.updated),
    livemode: !!row.livemode,
  };
  code.valid = promotionCodeValidity(code, coupon, now).valid;
  return code;
}

const hydrateRedemption = (row: any): CouponRedemption => ({
  object: 'coupon_redemption',
  id: row.id,
  coupon: row.coupon_id,
  promotion_code: row.promotion_code_id ?? null,
  customer: row.customer_id ?? null,
  ref: row.ref_type ? { type: row.ref_type, id: row.ref_id } : null,
  created: Number(row.created),
});

/* ------------------------------- normalising ------------------------------ */

const MAX_MINOR_UNITS = 1_000_000_000_000;
const MAX_PERIODS = 600;
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * The economics — what a coupon is worth and what it is worth it on. These are
 * exactly the fields that stop being editable once the coupon has been
 * redeemed, listed once so the refusal can name the ones the caller touched.
 */
export const COUPON_TERMS = [
  'percent_off', 'percent_off_basis_points', 'amount_off', 'currency',
  'duration', 'duration_in_periods', 'applies_to',
] as const;

/**
 * A percentage, in basis points, from either spelling.
 *
 * `percent_off: 33.33` is the readable one and a float, so it is checked back
 * against the integer it produced: 33.333 would otherwise land silently on
 * 33.33 and quietly overcharge every customer the campaign reached by a
 * hundredth of a percent.
 */
function readPercent(input: { percent_off?: number | null; percent_off_basis_points?: number | null }): number | null {
  const { percent_off: percent, percent_off_basis_points: bps } = input;
  if (bps !== null && bps !== undefined) {
    if (percent !== null && percent !== undefined) {
      throw badRequest(
        'parameter_invalid',
        'Send percent_off or percent_off_basis_points, not both — they are two spellings of one number.',
        'percent_off_basis_points',
      );
    }
    if (!Number.isInteger(bps)) throw badRequest('parameter_invalid', 'Basis points are whole numbers — 2000 is 20%.', 'percent_off_basis_points');
    return checkPercentRange(bps, 'percent_off_basis_points');
  }
  if (percent === null || percent === undefined) return null;
  if (!Number.isFinite(percent)) throw badRequest('parameter_invalid', 'percent_off must be a number.', 'percent_off');
  const scaled = Math.round(percent * 100);
  if (Math.abs(percent * 100 - scaled) > 1e-6) {
    throw badRequest('parameter_invalid', 'A percentage carries at most two decimal places — 33.33, not 33.333.', 'percent_off');
  }
  return checkPercentRange(scaled, 'percent_off');
}

function checkPercentRange(bps: number, param: string): number {
  if (bps <= 0) {
    throw badRequest('parameter_invalid', 'A coupon takes something off: the percentage must be greater than 0.', param);
  }
  if (bps > PERCENT_BASIS) {
    throw badRequest('parameter_invalid', 'A coupon cannot take more than 100% off — that would pay the customer to buy.', param);
  }
  return bps;
}

function checkAmountOff(amount: number, currency: string | null | undefined, param = 'amount_off'): { amount: number; currency: string } {
  if (!Number.isInteger(amount)) throw badRequest('parameter_invalid', 'Amounts are whole numbers of minor units — 1999 means 19.99.', param);
  if (amount <= 0) throw badRequest('parameter_invalid', 'A coupon takes something off: the amount must be greater than 0.', param);
  if (amount > MAX_MINOR_UNITS) throw badRequest('parameter_invalid', 'Amount is implausibly large.', param);
  if (!currency) {
    throw badRequest(
      'parameter_missing',
      'An amount-off coupon has to say which currency it is denominated in — 5000 off is $50 or ¥5000 depending on the answer.',
      'currency',
    );
  }
  return { amount, currency: assertCurrency(currency.toLowerCase(), 'currency') };
}

function checkDuration(duration: CouponDuration, periods: number | null | undefined): number | null {
  if (!COUPON_DURATIONS.includes(duration)) {
    throw badRequest('parameter_invalid', `Duration must be one of: ${COUPON_DURATIONS.join(', ')}.`, 'duration');
  }
  if (duration === 'repeating') {
    if (periods === null || periods === undefined) {
      throw badRequest('parameter_missing', 'A repeating coupon has to say how many billing periods it repeats for.', 'duration_in_periods');
    }
    if (!Number.isInteger(periods) || periods < 1 || periods > MAX_PERIODS) {
      throw badRequest('parameter_invalid', `duration_in_periods is a whole number of periods between 1 and ${MAX_PERIODS}.`, 'duration_in_periods');
    }
    return periods;
  }
  if (periods !== null && periods !== undefined) {
    throw badRequest(
      'parameter_invalid',
      `duration_in_periods only means something on a repeating coupon. "${duration}" already says how long this one lasts.`,
      'duration_in_periods',
    );
  }
  return null;
}

/** A code a customer can read out over the phone: no O/0 or I/1 confusion. */
function generateCode(): string {
  let out = '';
  for (let i = 0; i < 10; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

/* --------------------------------- store ---------------------------------- */

/** `times_redeemed` counted where it is read, so it can never drift from the rows. */
const REDEEMED = `(SELECT COUNT(*) FROM catalog_coupon_redemptions r
   WHERE r.org_id = c.org_id AND r.coupon_id = c.id) AS times_redeemed`;

const CODE_REDEEMED = `(SELECT COUNT(*) FROM catalog_coupon_redemptions r
   WHERE r.org_id = p.org_id AND r.promotion_code_id = p.id) AS times_redeemed`;

export class Coupons {
  constructor(private readonly ctx: Ctx) {}

  /* -------------------------------- coupons ------------------------------- */

  listCoupons(orgId: string, filter: CouponListFilter = {}): Page<Coupon> {
    const clauses = ['c.org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.active !== undefined) { clauses.push('c.active = ?'); params.push(filter.active ? 1 : 0); }
    if (filter.duration) { clauses.push('c.duration = ?'); params.push(filter.duration); }
    if (filter.currency) { clauses.push('c.currency = ?'); params.push(filter.currency.toLowerCase()); }
    if (filter.query) {
      clauses.push(`(c.name LIKE ? ESCAPE '\\' OR c.id LIKE ? ESCAPE '\\')`);
      const like = `%${filter.query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like);
    }
    const where = clauses.join(' AND ');
    const totalCount = this.ctx.db.count(`SELECT COUNT(*) FROM catalog_coupons c WHERE ${where}`, ...(params as any[]));

    const paged = [...params];
    let cursorClause = '';
    if (filter.cursor) {
      const parsed = parseCursor(filter.cursor);
      if (!parsed) throw badRequest('cursor_invalid', 'That pagination cursor is not readable. Start the list again.', 'cursor');
      cursorClause = ' AND (c.created < ? OR (c.created = ? AND c.id < ?))';
      paged.push(parsed.createdAt, parsed.createdAt, parsed.id);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = this.ctx.db.all<any>(
      `SELECT c.*, ${REDEEMED} FROM catalog_coupons c WHERE ${where}${cursorClause}
       ORDER BY c.created DESC, c.id DESC LIMIT ?`,
      ...(paged as any[]), limit + 1,
    );
    const hasMore = rows.length > limit;
    const now = this.ctx.now();
    let data = rows.slice(0, limit).map((row) => hydrateCoupon(row, now));
    const last = data[data.length - 1];
    const nextCursor = hasMore && last ? cursorOf(last.created, last.id) : null;
    // `valid` is computed against the clock, not stored, so it is filtered here
    // rather than in SQL — the count above still reports the unfiltered page.
    if (filter.valid !== undefined) data = data.filter((coupon) => coupon.valid === filter.valid);
    return { data, hasMore, nextCursor, totalCount };
  }

  coupon(orgId: string, id: string): Coupon | null {
    const row = this.ctx.db.get<any>(
      `SELECT c.*, ${REDEEMED} FROM catalog_coupons c WHERE c.org_id = ? AND c.id = ?`, orgId, id,
    );
    return row ? hydrateCoupon(row, this.ctx.now()) : null;
  }

  requireCoupon(orgId: string, id: string): Coupon {
    const found = this.coupon(orgId, id);
    if (!found) throw notFound('coupon', id);
    return found;
  }

  createCoupon(orgId: string, input: CouponInput, meta: WriteMeta = {}): Coupon {
    const now = this.ctx.now();
    const bps = readPercent(input);
    const hasAmount = input.amount_off !== null && input.amount_off !== undefined;
    if (bps !== null && hasAmount) {
      throw badRequest(
        'parameter_invalid',
        'A coupon is either a percentage off or an amount off, not both — two subtractions on one line have no defined order.',
        'amount_off',
      );
    }
    if (bps === null && !hasAmount) {
      throw badRequest('parameter_missing', 'A coupon has to take something off: send percent_off or amount_off.', 'percent_off');
    }
    const money = hasAmount ? checkAmountOff(input.amount_off as number, input.currency) : null;
    if (bps !== null && input.currency) {
      throw badRequest(
        'parameter_invalid',
        'A percentage travels: 20% off is 20% off in every currency the price book sells in, so a percent coupon carries no currency.',
        'currency',
      );
    }
    const duration = input.duration ?? 'once';
    const periods = checkDuration(duration, input.duration_in_periods);

    if (input.max_redemptions !== null && input.max_redemptions !== undefined
        && (!Number.isInteger(input.max_redemptions) || input.max_redemptions < 1)) {
      throw badRequest('parameter_invalid', 'max_redemptions is a whole number of redemptions, at least 1.', 'max_redemptions');
    }
    if (input.redeem_by !== null && input.redeem_by !== undefined && input.redeem_by <= now) {
      throw badRequest(
        'parameter_invalid',
        'redeem_by is in the past, so this coupon would be born expired. Leave it out for a coupon with no end date.',
        'redeem_by',
      );
    }
    const appliesTo = this.checkAppliesTo(orgId, input.applies_to);

    const id = input.id ?? newId('coupon');
    if (this.ctx.db.get(`SELECT id FROM catalog_coupons WHERE id = ?`, id)) {
      throw conflict('resource_already_exists', `Coupon ${id} already exists.`);
    }
    this.ctx.db.insert('catalog_coupons', {
      id, org_id: orgId,
      name: input.name ?? null,
      percent_off_bps: bps,
      amount_off: money?.amount ?? null,
      currency: money?.currency ?? null,
      duration,
      duration_in_periods: periods,
      max_redemptions: input.max_redemptions ?? null,
      redeem_by: input.redeem_by ?? null,
      applies_to_products: JSON.stringify(appliesTo.products),
      applies_to_prices: JSON.stringify(appliesTo.prices),
      active: input.active === false ? 0 : 1,
      metadata: JSON.stringify(input.metadata ?? {}),
      created: now, updated: now,
      livemode: meta.livemode === false ? 0 : 1,
    });
    const coupon = this.requireCoupon(orgId, id);
    this.ctx.emit(orgId, 'coupon.created', coupon, {
      objectId: id, objectType: 'coupon', actorId: meta.actorId ?? null,
      actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
    });
    return coupon;
  }

  /**
   * Labels move freely; the economics do not, once the coupon has been taken
   * up. This is the price book's own immutability rule pointed at the other
   * direction: an invoice that took $50 off has to keep saying $50, so a
   * campaign that needs different terms is a new coupon and a new code.
   */
  updateCoupon(orgId: string, id: string, patch: Partial<CouponInput>, meta: WriteMeta = {}): Coupon {
    const before = this.requireCoupon(orgId, id);
    const touched = COUPON_TERMS.filter((field) => (patch as Record<string, unknown>)[field] !== undefined);
    if (touched.length && before.times_redeemed > 0) {
      throw conflict(
        'coupon_immutable',
        `${before.name ? `"${before.name}"` : id} has already been redeemed ${before.times_redeemed} time${before.times_redeemed === 1 ? '' : 's'}, so ${touched.join(', ')} cannot change. Archive it and create the coupon you meant — that keeps every discounted invoice reproducible.`,
        { coupon: id, field: touched[0], times_redeemed: before.times_redeemed },
      );
    }

    const changes: Record<string, any> = {};
    if (touched.length) {
      const patchedPercent = readPercent(patch);
      const patchedAmount = patch.amount_off ?? null;
      if (patchedPercent !== null && patchedAmount !== null) {
        throw badRequest(
          'parameter_invalid',
          'A coupon is either a percentage off or an amount off, not both — two subtractions on one line have no defined order.',
          'amount_off',
        );
      }
      // An edit that names neither leaves the coupon's kind alone; one that
      // names either replaces it outright, which is how a percentage off
      // becomes a fixed amount off without deleting and re-creating the row.
      const names = patch.percent_off !== undefined || patch.percent_off_basis_points !== undefined
        || patch.amount_off !== undefined;
      const bps = names ? patchedPercent : before.percent_off_basis_points;
      const amountOff = names ? patchedAmount : before.amount_off;
      if (bps === null && amountOff === null) {
        throw badRequest('parameter_missing', 'A coupon has to take something off: send percent_off or amount_off.', 'percent_off');
      }
      const currency = bps !== null
        ? (patch.currency ?? null)
        : (patch.currency !== undefined ? patch.currency : before.currency);
      const money = bps === null ? checkAmountOff(amountOff as number, currency) : null;
      if (bps !== null && currency) {
        throw badRequest('parameter_invalid', 'A percentage carries no currency: 20% off is 20% off in every currency.', 'currency');
      }
      const duration = patch.duration ?? before.duration;
      const periods = checkDuration(
        duration,
        patch.duration_in_periods !== undefined ? patch.duration_in_periods
          : (duration === before.duration ? before.duration_in_periods : null),
      );
      const appliesTo = patch.applies_to !== undefined ? this.checkAppliesTo(orgId, patch.applies_to) : before.applies_to;
      Object.assign(changes, {
        percent_off_bps: bps,
        amount_off: money?.amount ?? null,
        currency: money?.currency ?? null,
        duration,
        duration_in_periods: periods,
        applies_to_products: JSON.stringify(appliesTo.products),
        applies_to_prices: JSON.stringify(appliesTo.prices),
      });
    }

    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.active !== undefined) changes.active = patch.active ? 1 : 0;
    if (patch.metadata !== undefined) changes.metadata = JSON.stringify({ ...before.metadata, ...patch.metadata });
    if (patch.redeem_by !== undefined) changes.redeem_by = patch.redeem_by;
    if (patch.max_redemptions !== undefined) {
      const cap = patch.max_redemptions;
      if (cap !== null) {
        if (!Number.isInteger(cap) || cap < 1) {
          throw badRequest('parameter_invalid', 'max_redemptions is a whole number of redemptions, at least 1.', 'max_redemptions');
        }
        if (cap < before.times_redeemed) {
          throw badRequest(
            'parameter_invalid',
            `This coupon has already been redeemed ${before.times_redeemed} times, so a cap of ${cap} would be a number the ledger has already passed. Archive it instead to stop further redemptions.`,
            'max_redemptions',
          );
        }
      }
      changes.max_redemptions = cap;
    }
    if (!Object.keys(changes).length) return before;
    changes.updated = this.ctx.now();
    this.ctx.db.patch('catalog_coupons', 'id', id, changes);
    const after = this.requireCoupon(orgId, id);
    this.ctx.emit(orgId, 'coupon.updated', after, {
      objectId: id, objectType: 'coupon', previous: diff(before, after),
      actorId: meta.actorId ?? null, actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
    });
    return after;
  }

  deleteCoupon(orgId: string, id: string, meta: WriteMeta = {}): Coupon {
    const coupon = this.requireCoupon(orgId, id);
    if (coupon.times_redeemed > 0) {
      throw conflict(
        'coupon_in_use',
        `${coupon.name ? `"${coupon.name}"` : id} has been redeemed ${coupon.times_redeemed} time${coupon.times_redeemed === 1 ? '' : 's'} and cannot be deleted. Set active: false so it stops being redeemable but keeps explaining the invoices it discounted.`,
        { coupon: id, times_redeemed: coupon.times_redeemed },
      );
    }
    const codes = this.ctx.db.count(`SELECT COUNT(*) FROM catalog_promotion_codes WHERE org_id = ? AND coupon_id = ?`, orgId, id);
    if (codes > 0) {
      throw conflict(
        'coupon_has_promotion_codes',
        `${coupon.name ? `"${coupon.name}"` : id} still has ${codes} promotion code${codes === 1 ? '' : 's'} pointing at it. Delete or deactivate those first, so no code is left standing for a coupon that no longer exists.`,
        { coupon: id, promotion_codes: codes },
      );
    }
    this.ctx.db.run(`DELETE FROM catalog_coupons WHERE org_id = ? AND id = ?`, orgId, id);
    this.ctx.emit(orgId, 'coupon.deleted', coupon, {
      objectId: id, objectType: 'coupon', actorId: meta.actorId ?? null,
      actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
    });
    return coupon;
  }

  /**
   * A coupon that points at a product this workspace does not sell is a
   * restriction that silently covers nothing, which reads on screen as a
   * working coupon that never comes off the bill.
   */
  private checkAppliesTo(orgId: string, applies?: { products?: string[]; prices?: string[] }): CouponAppliesTo {
    const products = [...new Set(applies?.products ?? [])];
    const prices = [...new Set(applies?.prices ?? [])];
    for (const productId of products) {
      if (!this.ctx.db.get(`SELECT id FROM catalog_products WHERE org_id = ? AND id = ?`, orgId, productId)) {
        throw badRequest('parameter_invalid', `No such product: ${productId}`, 'applies_to.products');
      }
    }
    for (const priceId of prices) {
      if (!this.ctx.db.get(`SELECT id FROM catalog_prices WHERE org_id = ? AND id = ?`, orgId, priceId)) {
        throw badRequest('parameter_invalid', `No such price: ${priceId}`, 'applies_to.prices');
      }
    }
    return { products, prices };
  }

  /* ---------------------------- promotion codes --------------------------- */

  listPromotionCodes(orgId: string, filter: PromotionCodeListFilter = {}): Page<PromotionCode> {
    const clauses = ['p.org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.coupon) { clauses.push('p.coupon_id = ?'); params.push(filter.coupon); }
    if (filter.code) { clauses.push('p.code = ?'); params.push(filter.code.trim().toUpperCase()); }
    if (filter.active !== undefined) { clauses.push('p.active = ?'); params.push(filter.active ? 1 : 0); }
    const where = clauses.join(' AND ');
    const totalCount = this.ctx.db.count(`SELECT COUNT(*) FROM catalog_promotion_codes p WHERE ${where}`, ...(params as any[]));

    const paged = [...params];
    let cursorClause = '';
    if (filter.cursor) {
      const parsed = parseCursor(filter.cursor);
      if (!parsed) throw badRequest('cursor_invalid', 'That pagination cursor is not readable. Start the list again.', 'cursor');
      cursorClause = ' AND (p.created < ? OR (p.created = ? AND p.id < ?))';
      paged.push(parsed.createdAt, parsed.createdAt, parsed.id);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = this.ctx.db.all<any>(
      `SELECT p.*, ${CODE_REDEEMED} FROM catalog_promotion_codes p WHERE ${where}${cursorClause}
       ORDER BY p.created DESC, p.id DESC LIMIT ?`,
      ...(paged as any[]), limit + 1,
    );
    const hasMore = rows.length > limit;
    const now = this.ctx.now();
    const coupons = new Map<string, Coupon>();
    const data = rows.slice(0, limit).map((row) => {
      let coupon = coupons.get(row.coupon_id);
      if (!coupon) { coupon = this.requireCoupon(orgId, row.coupon_id); coupons.set(row.coupon_id, coupon); }
      return hydratePromotionCode(row, coupon, now);
    });
    const last = data[data.length - 1];
    return { data, hasMore, nextCursor: hasMore && last ? cursorOf(last.created, last.id) : null, totalCount };
  }

  promotionCode(orgId: string, id: string): PromotionCode | null {
    const row = this.ctx.db.get<any>(
      `SELECT p.*, ${CODE_REDEEMED} FROM catalog_promotion_codes p WHERE p.org_id = ? AND p.id = ?`, orgId, id,
    );
    if (!row) return null;
    return hydratePromotionCode(row, this.requireCoupon(orgId, row.coupon_id), this.ctx.now());
  }

  requirePromotionCode(orgId: string, id: string): PromotionCode {
    const found = this.promotionCode(orgId, id);
    if (!found) throw notFound('promotion code', id);
    return found;
  }

  /** Case and surrounding space are the customer's, not the code's. */
  promotionCodeByCode(orgId: string, code: string): PromotionCode | null {
    const row = this.ctx.db.get<any>(
      `SELECT p.*, ${CODE_REDEEMED} FROM catalog_promotion_codes p WHERE p.org_id = ? AND p.code = ?`,
      orgId, code.trim().toUpperCase(),
    );
    if (!row) return null;
    return hydratePromotionCode(row, this.requireCoupon(orgId, row.coupon_id), this.ctx.now());
  }

  createPromotionCode(orgId: string, input: PromotionCodeInput, meta: WriteMeta = {}): PromotionCode {
    const coupon = this.requireCoupon(orgId, input.coupon);
    const now = this.ctx.now();
    const code = (input.code ?? generateCode()).trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      throw badRequest(
        'parameter_invalid',
        'A promotion code is 3–40 characters of letters, digits, dashes and underscores, starting with a letter or digit. It is read aloud and typed in by hand.',
        'code',
      );
    }
    const clash = this.promotionCodeByCode(orgId, code);
    if (clash) {
      throw conflict(
        'promotion_code_in_use',
        `${code} already points at ${clash.coupon}. A code means one thing, so pick another or deactivate the existing one.`,
        { code, promotion_code: clash.id, coupon: clash.coupon },
      );
    }
    if (input.expires_at !== null && input.expires_at !== undefined) {
      if (input.expires_at <= now) {
        throw badRequest('parameter_invalid', 'expires_at is in the past, so this code would be born expired.', 'expires_at');
      }
      if (coupon.redeem_by !== null && input.expires_at > coupon.redeem_by) {
        throw badRequest(
          'parameter_invalid',
          `${coupon.name ?? coupon.id} stops being redeemable on ${new Date(coupon.redeem_by).toISOString().slice(0, 10)}, so a code that outlives it would advertise a discount the coupon refuses.`,
          'expires_at',
          { coupon: coupon.id, redeem_by: coupon.redeem_by },
        );
      }
    }
    for (const [param, value] of [
      ['max_redemptions', input.max_redemptions],
      ['max_redemptions_per_customer', input.max_redemptions_per_customer],
    ] as const) {
      if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 1)) {
        throw badRequest('parameter_invalid', `${param} is a whole number of redemptions, at least 1.`, param);
      }
    }
    const floor = input.minimum_amount ?? null;
    let floorCurrency: string | null = null;
    if (floor !== null) {
      if (!Number.isInteger(floor) || floor < 0) {
        throw badRequest('parameter_invalid', 'minimum_amount is a whole number of minor units, at least 0.', 'minimum_amount');
      }
      const supplied = input.minimum_amount_currency ?? coupon.currency;
      if (!supplied) {
        throw badRequest(
          'parameter_missing',
          'A minimum order value needs a currency: 5000 is $50 or ¥5000 depending on the answer, and a percentage coupon has no currency to borrow.',
          'minimum_amount_currency',
        );
      }
      floorCurrency = assertCurrency(supplied.toLowerCase(), 'minimum_amount_currency');
    }

    const id = input.id ?? newId('promo');
    if (this.ctx.db.get(`SELECT id FROM catalog_promotion_codes WHERE id = ?`, id)) {
      throw conflict('resource_already_exists', `Promotion code ${id} already exists.`);
    }
    this.ctx.db.insert('catalog_promotion_codes', {
      id, org_id: orgId, coupon_id: coupon.id, code,
      active: input.active === false ? 0 : 1,
      expires_at: input.expires_at ?? null,
      max_redemptions: input.max_redemptions ?? null,
      max_redemptions_per_customer: input.max_redemptions_per_customer ?? null,
      minimum_amount: floor,
      minimum_amount_currency: floorCurrency,
      first_time_transaction: input.first_time_transaction ? 1 : 0,
      metadata: JSON.stringify(input.metadata ?? {}),
      created: now, updated: now,
      livemode: meta.livemode === false ? 0 : 1,
    });
    const promotionCode = this.requirePromotionCode(orgId, id);
    this.ctx.emit(orgId, 'promotion_code.created', promotionCode, {
      objectId: id, objectType: 'promotion_code', actorId: meta.actorId ?? null,
      actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
    });
    return promotionCode;
  }

  /**
   * The code itself and the coupon behind it never move. A code is printed in
   * an email, read out on a call and typed by a customer; repointing it would
   * change what a promise already made means, and the honest way to withdraw
   * one is to deactivate it and issue another.
   */
  updatePromotionCode(orgId: string, id: string, patch: Partial<PromotionCodeInput>, meta: WriteMeta = {}): PromotionCode {
    const before = this.requirePromotionCode(orgId, id);
    if (patch.code !== undefined && patch.code !== null && patch.code.trim().toUpperCase() !== before.code) {
      throw badRequest(
        'parameter_invalid',
        `A promotion code cannot be renamed — ${before.code} may already be in an email or on a call. Deactivate it and create the code you meant.`,
        'code',
      );
    }
    if (patch.coupon !== undefined && patch.coupon !== before.coupon) {
      throw badRequest(
        'parameter_invalid',
        `${before.code} stands for ${before.coupon} and cannot be repointed at another coupon. Deactivate it and issue a new code.`,
        'coupon',
      );
    }
    const changes: Record<string, any> = {};
    if (patch.active !== undefined) changes.active = patch.active ? 1 : 0;
    if (patch.metadata !== undefined) changes.metadata = JSON.stringify({ ...before.metadata, ...patch.metadata });
    if (patch.expires_at !== undefined) changes.expires_at = patch.expires_at;
    if (patch.max_redemptions !== undefined) {
      const cap = patch.max_redemptions;
      if (cap !== null && (!Number.isInteger(cap) || cap < 1)) {
        throw badRequest('parameter_invalid', 'max_redemptions is a whole number of redemptions, at least 1.', 'max_redemptions');
      }
      if (cap !== null && cap < before.times_redeemed) {
        throw badRequest(
          'parameter_invalid',
          `${before.code} has already been used ${before.times_redeemed} times, so a cap of ${cap} is a number it has already passed. Deactivate it instead.`,
          'max_redemptions',
        );
      }
      changes.max_redemptions = cap;
    }
    if (patch.max_redemptions_per_customer !== undefined) {
      const cap = patch.max_redemptions_per_customer;
      if (cap !== null && (!Number.isInteger(cap) || cap < 1)) {
        throw badRequest('parameter_invalid', 'max_redemptions_per_customer is a whole number of redemptions, at least 1.', 'max_redemptions_per_customer');
      }
      changes.max_redemptions_per_customer = cap;
    }
    if (patch.first_time_transaction !== undefined) changes.first_time_transaction = patch.first_time_transaction ? 1 : 0;
    if (patch.minimum_amount !== undefined) {
      const floor = patch.minimum_amount;
      if (floor !== null && (!Number.isInteger(floor) || floor < 0)) {
        throw badRequest('parameter_invalid', 'minimum_amount is a whole number of minor units, at least 0.', 'minimum_amount');
      }
      changes.minimum_amount = floor;
      if (floor === null) changes.minimum_amount_currency = null;
      else {
        const coupon = this.requireCoupon(orgId, before.coupon);
        const supplied = patch.minimum_amount_currency ?? before.restrictions.minimum_amount_currency ?? coupon.currency;
        if (!supplied) {
          throw badRequest('parameter_missing', 'A minimum order value needs a currency.', 'minimum_amount_currency');
        }
        changes.minimum_amount_currency = assertCurrency(supplied.toLowerCase(), 'minimum_amount_currency');
      }
    } else if (patch.minimum_amount_currency !== undefined) {
      changes.minimum_amount_currency = patch.minimum_amount_currency
        ? assertCurrency(patch.minimum_amount_currency.toLowerCase(), 'minimum_amount_currency')
        : null;
    }
    if (!Object.keys(changes).length) return before;
    changes.updated = this.ctx.now();
    this.ctx.db.patch('catalog_promotion_codes', 'id', id, changes);
    const after = this.requirePromotionCode(orgId, id);
    this.ctx.emit(orgId, 'promotion_code.updated', after, {
      objectId: id, objectType: 'promotion_code', previous: diff(before, after),
      actorId: meta.actorId ?? null, actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
    });
    return after;
  }

  deletePromotionCode(orgId: string, id: string, meta: WriteMeta = {}): PromotionCode {
    const code = this.requirePromotionCode(orgId, id);
    if (code.times_redeemed > 0) {
      throw conflict(
        'promotion_code_in_use',
        `${code.code} has been redeemed ${code.times_redeemed} time${code.times_redeemed === 1 ? '' : 's'} and cannot be deleted. Set active: false so it stops working but keeps explaining the invoices it discounted.`,
        { promotion_code: id, times_redeemed: code.times_redeemed },
      );
    }
    this.ctx.db.run(`DELETE FROM catalog_promotion_codes WHERE org_id = ? AND id = ?`, orgId, id);
    this.ctx.emit(orgId, 'promotion_code.deleted', code, {
      objectId: id, objectType: 'promotion_code', actorId: meta.actorId ?? null,
      actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
    });
    return code;
  }

  /* ------------------------------ redemptions ----------------------------- */

  /** How many times one account has already used one code. */
  customerRedemptions(orgId: string, promotionCodeId: string, customerId: string): number {
    return this.ctx.db.count(
      `SELECT COUNT(*) FROM catalog_coupon_redemptions
        WHERE org_id = ? AND promotion_code_id = ? AND customer_id = ?`,
      orgId, promotionCodeId, customerId,
    );
  }

  /**
   * What a customer-facing code stands for, and whether it can be used.
   *
   * Never throws on an unusable code: a checkout showing "SPRNIG20 is not a
   * code we know" and "SPRING20 ran out yesterday" needs both answers in the
   * same shape, and the second is not an error in the request.
   */
  resolveCode(orgId: string, code: string, opts: PromotionCodeContext & { customer?: string | null } = {}):
    { promotion_code: PromotionCode; coupon: Coupon; validity: Validity<PromotionCodeInvalidReason> } | null {
    const promotionCode = this.promotionCodeByCode(orgId, code);
    if (!promotionCode) return null;
    const coupon = this.requireCoupon(orgId, promotionCode.coupon);
    const customerRedemptions = opts.customerRedemptions ?? (opts.customer
      ? this.customerRedemptions(orgId, promotionCode.id, opts.customer)
      : 0);
    return {
      promotion_code: promotionCode,
      coupon,
      validity: promotionCodeValidity(promotionCode, coupon, this.ctx.now(), { ...opts, customerRedemptions }),
    };
  }

  redemptions(orgId: string, filter: RedemptionListFilter = {}): CouponRedemption[] {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.coupon) { clauses.push('coupon_id = ?'); params.push(filter.coupon); }
    if (filter.promotion_code) { clauses.push('promotion_code_id = ?'); params.push(filter.promotion_code); }
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return this.ctx.db.all<any>(
      `SELECT * FROM catalog_coupon_redemptions WHERE ${clauses.join(' AND ')} ORDER BY created DESC, id DESC LIMIT ?`,
      ...(params as any[]), limit,
    ).map(hydrateRedemption);
  }

  redemption(orgId: string, ref: { type: string; id: string }, couponId: string): CouponRedemption | null {
    const row = this.ctx.db.get<any>(
      `SELECT * FROM catalog_coupon_redemptions
        WHERE org_id = ? AND coupon_id = ? AND ref_type = ? AND ref_id = ?`,
      orgId, couponId, ref.type, ref.id,
    );
    return row ? hydrateRedemption(row) : null;
  }

  /**
   * Spend one redemption.
   *
   * Idempotent on the thing that holds the discount: billing retrying "attach
   * this coupon to sub_…" must not burn a second redemption off a coupon
   * limited to 50, so a ref that already has this coupon gets its existing row
   * back rather than a new one.
   */
  redeem(orgId: string, input: RedemptionInput, meta: WriteMeta = {}): CouponRedemption {
    const coupon = this.requireCoupon(orgId, input.coupon);
    const now = this.ctx.now();
    if (input.ref) {
      const existing = this.redemption(orgId, input.ref, coupon.id);
      if (existing) return existing;
    }

    let promotionCode: PromotionCode | null = null;
    if (input.promotion_code) {
      promotionCode = this.requirePromotionCode(orgId, input.promotion_code);
      if (promotionCode.coupon !== coupon.id) {
        throw badRequest(
          'parameter_invalid',
          `${promotionCode.code} stands for ${promotionCode.coupon}, not ${coupon.id}.`,
          'promotion_code',
          { promotion_code: promotionCode.id, coupon: promotionCode.coupon },
        );
      }
      const customerRedemptions = input.customer
        ? this.customerRedemptions(orgId, promotionCode.id, input.customer)
        : 0;
      const standing = promotionCodeValidity(promotionCode, coupon, now, { customerRedemptions });
      if (!standing.valid) {
        throw conflict('promotion_code_not_redeemable', standing.message ?? `${promotionCode.code} cannot be redeemed.`, {
          promotion_code: promotionCode.id, coupon: coupon.id, reason: standing.reason,
        });
      }
    } else {
      const standing = couponValidity(coupon, now);
      if (!standing.valid) {
        throw conflict('coupon_not_redeemable', standing.message ?? `${coupon.id} cannot be redeemed.`, {
          coupon: coupon.id, reason: standing.reason,
        });
      }
    }

    const id = newId('discount');
    this.ctx.db.insert('catalog_coupon_redemptions', {
      id, org_id: orgId,
      coupon_id: coupon.id,
      promotion_code_id: promotionCode?.id ?? null,
      customer_id: input.customer ?? null,
      ref_type: input.ref?.type ?? null,
      ref_id: input.ref?.id ?? null,
      created: now,
    });
    const redemption = hydrateRedemption(
      this.ctx.db.get<any>(`SELECT * FROM catalog_coupon_redemptions WHERE id = ?`, id),
    );
    this.ctx.emit(orgId, 'coupon.redeemed', {
      ...redemption,
      // The counters as they now stand, so a webhook does not have to re-read
      // the coupon to know a campaign has just been used up.
      coupon_times_redeemed: this.requireCoupon(orgId, coupon.id).times_redeemed,
    }, {
      objectId: id, objectType: 'coupon_redemption', actorId: meta.actorId ?? null,
      actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
    });
    return redemption;
  }

  /**
   * Give a redemption back.
   *
   * The mirror of `redeem`, and the reason `times_redeemed` is a count rather
   * than a counter: a subscription cancelled before it ever billed must not
   * leave a 50-redemption campaign showing 49 remaining when it has 50.
   */
  releaseRedemption(orgId: string, ref: { type: string; id: string }, opts: { coupon?: string } = {}, meta: WriteMeta = {}): CouponRedemption[] {
    const clauses = ['org_id = ?', 'ref_type = ?', 'ref_id = ?'];
    const params: unknown[] = [orgId, ref.type, ref.id];
    if (opts.coupon) { clauses.push('coupon_id = ?'); params.push(opts.coupon); }
    const rows = this.ctx.db.all<any>(
      `SELECT * FROM catalog_coupon_redemptions WHERE ${clauses.join(' AND ')}`, ...(params as any[]),
    ).map(hydrateRedemption);
    for (const row of rows) {
      this.ctx.db.run(`DELETE FROM catalog_coupon_redemptions WHERE org_id = ? AND id = ?`, orgId, row.id);
      this.ctx.emit(orgId, 'coupon.redemption_released', row, {
        objectId: row.id, objectType: 'coupon_redemption', actorId: meta.actorId ?? null,
        actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
      });
    }
    return rows;
  }
}
