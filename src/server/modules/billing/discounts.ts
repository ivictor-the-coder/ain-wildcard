/**
 * Taking the coupon off the bill.
 *
 * The catalogue owns what a coupon *is* — the percentage, the duration, the
 * restrictions, and the exact arithmetic of one coupon against a set of amounts.
 * This file owns the other half: which coupon is fastened to which account, how
 * much of its duration is left, and what happens to an invoice, a preview and
 * MRR while it runs. Nothing here re-implements the subtraction; every figure
 * comes back through `ctx.svc.catalog.distributeDiscount`, so a discount rounds
 * the way the price book rounds and not one minor unit differently.
 *
 * Three decisions are worth stating, because each of them is a different number
 * on the bill:
 *
 *  1. **The discount is a line, not a footer.** `sum(lines.amount) = subtotal`
 *     is the invariant the whole module holds, so a negative line inside that
 *     sum *is* a reduced taxable base. Every rate on the bill is then charged
 *     on what the customer actually pays.
 *  2. **Its tax is the tax it removed, not the tax on a negative number.** The
 *     line's tax is computed as the difference between taxing each covered line
 *     gross and taxing it net of its share — per jurisdiction, at that line's
 *     own behaviour. So `invoice.tax` is exactly the tax on the discounted
 *     lines, to the minor unit, and a coupon that only covers a reverse-charged
 *     supply removes no tax at all rather than inventing a credit for some.
 *  3. **A duration is counted in periods billed, not months elapsed.** The
 *     count advances when a bill applies the discount, and the instant the last
 *     of those periods ends is written onto the row and enqueued as a job — so
 *     `POST /v1/time/advance` retires "20% off year one" on the same cycle a
 *     real year would.
 */
import type { Ctx } from '../../kernel/context';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { formatMoney, money } from '../../../shared/money';
import type { Period } from '../../../shared/time';
import type { Coupon, TaxBehavior } from '../catalog/types';
import type { WriteMeta } from './records';
import type { ResolvedRate, TaxRates } from './tax';
import type { Discount, InvoiceLineTax, LineTaxAmount, Subscription } from './types';

/** The job that retires a discount whose last discounted period has ended. */
export const DISCOUNT_EXPIRE_JOB = 'billing.discount_expire';

/* -------------------------------- hydration ------------------------------- */

export function hydrateDiscount(row: Record<string, unknown>, periods: number | null): Discount {
  const end = row.end_at;
  const endedAt = row.ended_at;
  return {
    object: 'discount',
    id: String(row.id),
    customer: String(row.customer_id),
    subscription: (row.subscription_id as string | null) ?? null,
    coupon: String(row.coupon_id),
    promotion_code: (row.promotion_code_id as string | null) ?? null,
    start: Number(row.start),
    end: end === null || end === undefined ? null : Number(end),
    periods_used: Number(row.periods_used ?? 0),
    last_period_start: row.last_period_start === null || row.last_period_start === undefined
      ? null : Number(row.last_period_start),
    duration_periods: periods,
    status: row.status === 'ended' ? 'ended' : 'active',
    ended_at: endedAt === null || endedAt === undefined ? null : Number(endedAt),
    created: Number(row.created),
    updated: Number(row.updated),
  };
}

/** A discount and the coupon behind it, read together because neither answers alone. */
export interface ActiveDiscount {
  discount: Discount;
  coupon: Coupon;
}

/**
 * The discount governing one bill, and everything the line it becomes needs to
 * describe itself: which period of the coupon's duration this is, and the
 * window the line covers.
 *
 * Carried as one object so that `taxDrafts` — the single call the charge and
 * every prediction of it share — cannot be handed a discount by one caller and
 * left without it by another.
 */
export interface DiscountContext extends ActiveDiscount {
  /** Which period of the duration this bill is, counting from 0. */
  periodIndex: number;
  period: Period;
  subscription: string | null;
}

/* -------------------------------- arithmetic ------------------------------ */

/** One line the coupon might come off, as the rate engine will see it. */
export interface DiscountableLine {
  price: string | null;
  product: string | null;
  /** What the pricing engine produced — gross for an inclusive price. */
  amount: number;
  behavior: TaxBehavior;
}

/**
 * What the coupon takes off the taxable base and off each jurisdiction's tax.
 *
 * The base half is what the discount line records as its `amount`; the tax half
 * is what it records as its tax, and is a *difference* rather than a figure of
 * its own — see `discountDelta`.
 */
export interface DiscountDelta {
  /** Negative minor units off the taxable base — the discount line's own amount. */
  amount: number;
  taxes: LineTaxAmount[];
  tax: InvoiceLineTax;
  behavior: TaxBehavior;
}

/** What the coupon takes off a bill, and what that does to the tax on it. */
export interface DiscountApplication extends DiscountDelta {
  /** Positive minor units each line handed in carries, in the order they came. */
  shares: number[];
  description: string;
  explanation: string;
}

/** One line the coupon came off, and the share of it that line carries. */
export interface DiscountedShare {
  /** The line's amount as the pricing engine produced it — gross for an inclusive price. */
  amount: number;
  /** Positive minor units of the coupon this line carries. Zero for a line it did not cover. */
  share: number;
  behavior: TaxBehavior;
}

/**
 * The discount's own tax: the tax it *removed*, jurisdiction by jurisdiction.
 *
 * Every covered line is split twice — once on what it would have been billed,
 * once on what it is billed after its share comes off — and the difference is
 * what the discount line carries. That is what makes the reduction happen
 * before tax rather than beside it: the document's tax ends up equal, to the
 * minor unit, to the tax on the discounted lines.
 *
 * Taxing one negative number at the account's headline rate is a different
 * answer, and on an inclusive price it is a materially different one: 20% off a
 * €120.00 all-in line is €24.00 off what the customer was quoted, leaving
 * €96.00 to pay, while −€24.00 taxed as an exclusive line takes €24.00 off the
 * base and €5.52 off the tax and bills €90.48.
 */
export function discountDelta(
  rates: TaxRates, resolved: ResolvedRate, where: string | null,
  shares: DiscountedShare[], currency: string,
): DiscountDelta {
  // One accumulator per jurisdiction the account is in, in the order the
  // resolution lists them — every split of the same resolution produces its
  // slices in that order, so the subtraction is positional and exact.
  const slices = resolved.entries.map((entry) => ({
    rate: entry.rate, reason: entry.reason, amount: 0, behavior: 'unspecified' as TaxBehavior,
  }));
  const behaviors = new Set<TaxBehavior>();
  let base = 0;
  for (const line of shares) {
    if (line.share === 0) continue;
    const gross = rates.split(line.amount, line.behavior, currency, resolved);
    const net = rates.split(line.amount - line.share, line.behavior, currency, resolved);
    base += net.base - gross.base;
    behaviors.add(gross.behavior);
    for (let i = 0; i < slices.length; i++) slices[i].amount += net.slices[i].amount - gross.slices[i].amount;
  }
  // A coupon that covered both an inclusive and an exclusive line reduced two
  // different bases, and naming either behaviour on the one line would be a
  // claim about the other that is false. `unspecified` is what this module has
  // always meant by "no single behaviour to honour".
  const behavior: TaxBehavior = behaviors.size === 1 ? [...behaviors][0] : 'unspecified';
  for (const slice of slices) slice.behavior = behavior;

  // A line that matched no rate still carries one entry, for the same reason
  // every other line does: "nothing is registered for this address" is an
  // answer the invoice has to give, and an empty list gives none.
  const entries = slices.length ? slices : [{ rate: null, reason: resolved.reason, amount: 0, behavior }];
  const taxes: LineTaxAmount[] = entries.map((slice) => ({
    object: 'invoice_line_tax_amount',
    amount: slice.amount,
    taxable_amount: base,
    rate: slice.rate?.id ?? null,
    display_name: slice.rate?.display_name ?? null,
    jurisdiction: slice.rate?.jurisdiction ?? null,
    percentage: slice.rate?.percentage ?? null,
    tax_type: slice.rate?.tax_type ?? null,
    behavior: slice.behavior,
    reason: slice.reason,
    explanation: rates.explainSlice(slice, resolved.registration_note, where),
  }));
  return { amount: base, taxes, tax: rollUp(taxes, behavior), behavior };
}

/**
 * 2000 → "20", 3333 → "33.33". A coupon's percentage is an integer number of
 * basis points and is spelled from those integers, never from a float: the
 * catalogue keeps it that way and a bill that prints "33.329999999999998%" for
 * a third off would undo the point of it.
 */
function percentPhrase(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const frac = Math.abs(basisPoints % 100);
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/** "20% off" / "$500.00 off" — the offer in three words, for the line it becomes. */
function describeOffer(coupon: Coupon, currency: string, locale: string): string {
  if (coupon.percent_off_basis_points !== null) return `${percentPhrase(coupon.percent_off_basis_points)}% off`;
  return `${formatMoney(money(coupon.amount_off ?? 0, coupon.currency ?? currency), { locale })} off`;
}

/**
 * The discount, priced as the bill will record it: the catalogue's subtraction,
 * spread over the lines, with `discountDelta` for what that does to the tax.
 *
 * Null when the coupon covers nothing on this bill, or covers only credit
 * lines: a zero line explains nothing and belongs on no document.
 */
export function applyDiscount(input: {
  ctx: Ctx;
  rates: TaxRates;
  resolved: ResolvedRate;
  /** The place a tax decision was made about, for a slice with no rate to name. */
  where: string | null;
  coupon: Coupon;
  lines: DiscountableLine[];
  currency: string;
  locale: string;
  /** Which period of the coupon's duration this bill is, counting from 0. */
  periodIndex: number;
  /** How many periods the coupon runs for; null means without end. */
  periods: number | null;
}): DiscountApplication | null {
  const { ctx, rates, resolved, coupon, lines, currency, locale } = input;
  const applied = ctx.svc.catalog.distributeDiscount(
    coupon,
    lines.map((line, index) => ({ id: String(index), price: line.price, product: line.product, amount: line.amount })),
    currency,
  );
  if (applied.amount === 0) return null;

  const shares = applied.lines.map((line) => line.discount);
  const delta = discountDelta(
    rates, resolved, input.where,
    lines.map((line, index) => ({ amount: line.amount, share: shares[index], behavior: line.behavior })),
    currency,
  );

  const show = (amount: number) => formatMoney(money(amount, currency), { locale });
  const offer = describeOffer(coupon, currency, locale);
  const named = coupon.name?.trim();
  const covered = applied.lines.filter((share) => share.eligible && share.amount > 0).length;
  const restricted = coupon.applies_to.products.length > 0 || coupon.applies_to.prices.length > 0;

  const sentences = [
    `${offer} ${show(applied.eligible_subtotal)}${restricted ? ' of covered charges' : ''} = ${show(applied.amount)}.`,
  ];
  if (applied.amount_decimal !== String(applied.amount)) {
    sentences.push(
      `The exact figure is ${applied.amount_decimal} minor units, rounded half up once — on the discount itself, never on what is left — so the per-line shares always add back to it.`,
    );
  }
  if (applied.capped) {
    sentences.push(`The coupon is worth more than this bill charges for what it covers, so it takes off ${show(applied.amount)} and no more.`);
  }
  if (restricted) {
    sentences.push(
      `It covers ${covered} of the ${applied.lines.filter((share) => share.amount > 0).length} charges here; the rest are billed at list.`,
    );
  }
  sentences.push(
    input.periods === null
      ? 'It comes off every period, without end.'
      : `Period ${input.periodIndex + 1} of ${input.periods}.`,
  );
  sentences.push('Taken off before tax, so every rate on this bill is charged on the discounted amount.');

  return {
    ...delta,
    shares,
    description: named ? `${named} (${offer})` : offer,
    explanation: sentences.join(' '),
  };
}

/**
 * The discount line's tax as one figure.
 *
 * `rollUpLineTax` cannot be reused here: it names the single rate behind a
 * figure by counting the entries that charged, and a discount line's entries
 * are all present and mostly zero because the jurisdictions that charged
 * nothing still had nothing removed. The rule is the same one — name a rate
 * only when exactly one produced the figure.
 */
function rollUp(taxes: LineTaxAmount[], behavior: TaxBehavior): InvoiceLineTax {
  const amount = taxes.reduce((total, entry) => total + entry.amount, 0);
  const moved = taxes.filter((entry) => entry.amount !== 0);
  const named = moved.length ? moved : taxes;
  const only = named.length === 1 ? named[0] : null;
  return {
    amount,
    rate: only?.rate ?? null,
    display_name: only?.display_name ?? (amount === 0 ? null : 'Tax'),
    jurisdiction: [...new Set(named.map((entry) => entry.jurisdiction).filter(Boolean))].join(' + ') || null,
    percentage: only?.percentage ?? null,
    tax_type: only?.tax_type ?? null,
    behavior,
    reason: only?.reason ?? named[0]?.reason ?? 'taxable',
    explanation: taxes.map((entry) => entry.explanation).filter(Boolean).join(' ') || null,
  };
}

/* --------------------------------- the store ------------------------------ */

export interface DiscountInput {
  /** A coupon id, when the deal desk attached it. */
  coupon?: string | null;
  /** A code the customer typed, or the promotion code's own id. */
  promotion_code?: string | null;
}

export class Discounts {
  constructor(private readonly ctx: Ctx) {}

  private periodsOf(coupon: Coupon): number | null {
    return this.ctx.svc.catalog.discountPeriods(coupon);
  }

  private locale(orgId: string): string {
    try { return this.ctx.svc.core.org(orgId).locale || 'en-US'; }
    catch { return 'en-US'; }
  }

  private read(sql: string, ...params: string[]): Discount | null {
    const row = this.ctx.db.get<Record<string, unknown>>(sql, ...params);
    if (!row) return null;
    const coupon = this.ctx.svc.catalog.coupon(String(row.org_id), String(row.coupon_id));
    return hydrateDiscount(row, coupon ? this.periodsOf(coupon) : null);
  }

  forCustomer(orgId: string, customerId: string): Discount | null {
    return this.read(
      `SELECT * FROM billing_discounts
        WHERE org_id = ? AND customer_id = ? AND subscription_id IS NULL AND status = 'active'`,
      orgId, customerId,
    );
  }

  forSubscription(orgId: string, subscriptionId: string): Discount | null {
    return this.read(
      `SELECT * FROM billing_discounts WHERE org_id = ? AND subscription_id = ? AND status = 'active'`,
      orgId, subscriptionId,
    );
  }

  discount(orgId: string, id: string): Discount | null {
    return this.read(`SELECT * FROM billing_discounts WHERE org_id = ? AND id = ?`, orgId, id);
  }

  /** Every discount on the book, newest first — the list a screen and a report read. */
  list(orgId: string, filter: { customer?: string; subscription?: string; status?: 'active' | 'ended' } = {}): Discount[] {
    const clauses = ['org_id = ?'];
    const params: string[] = [orgId];
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.subscription) { clauses.push('subscription_id = ?'); params.push(filter.subscription); }
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
    const rows = this.ctx.db.all<Record<string, unknown>>(
      `SELECT * FROM billing_discounts WHERE ${clauses.join(' AND ')} ORDER BY created DESC, id DESC LIMIT 500`,
      ...params,
    );
    return rows.map((row) => {
      const coupon = this.ctx.svc.catalog.coupon(orgId, String(row.coupon_id));
      return hydrateDiscount(row, coupon ? this.periodsOf(coupon) : null);
    });
  }

  /**
   * The discount that governs a bill, and the coupon behind it.
   *
   * A subscription's own discount beats the customer's, and does not stack with
   * it: "10% off the platform fee" negotiated onto one subscription is not an
   * extra 10% on top of the account-wide partner discount, and applying both
   * would need an order of application nothing defines.
   */
  governing(orgId: string, customerId: string, subscriptionId: string | null, periodStart: number): ActiveDiscount | null {
    const found = (subscriptionId ? this.forSubscription(orgId, subscriptionId) : null)
      ?? this.forCustomer(orgId, customerId);
    if (!found) return null;
    const coupon = this.ctx.svc.catalog.coupon(orgId, found.coupon);
    if (!coupon) return null;
    return this.appliesTo(found, coupon, periodStart) ? { discount: found, coupon } : null;
  }

  /**
   * Whether the discount still comes off a bill covering `periodStart`.
   *
   * The count is of periods, not of invoices: a period already discounted goes
   * on being discounted by every further bill raised inside it — an "invoice
   * now" for a mid-cycle upgrade is part of the same discounted month — and it
   * spends one period of the duration, not two.
   */
  appliesTo(discount: Discount, coupon: Coupon, periodStart: number): boolean {
    if (discount.status !== 'active') return false;
    const periods = this.periodsOf(coupon);
    if (periods === null) return true;
    if (discount.periods_used > 0 && discount.last_period_start === periodStart) return true;
    return discount.periods_used < periods;
  }

  /**
   * The discount a bill for this window carries, ready for `taxDrafts`.
   *
   * One call, made by the invoice and by every projection of it, so a preview
   * that showed a discount and a charge that forgot one cannot happen.
   */
  context(orgId: string, customerId: string, subscriptionId: string | null, period: Period): DiscountContext | null {
    const found = this.governing(orgId, customerId, subscriptionId, period.start);
    if (!found) return null;
    return {
      ...found,
      periodIndex: this.periodIndex(found.discount, period.start),
      period,
      subscription: subscriptionId,
    };
  }

  /**
   * Which period of the duration a bill covering `periodStart` is, from 0.
   *
   * A second bill inside a period the discount has already been spent on is
   * still that period — the mid-cycle upgrade and the cycle invoice around it
   * are both "month three of twelve", and numbering the second one four would
   * put a sentence on the document that contradicts the one above it.
   */
  periodIndex(discount: Discount, periodStart: number): number {
    return discount.periods_used > 0 && discount.last_period_start === periodStart
      ? discount.periods_used - 1
      : discount.periods_used;
  }

  /**
   * Whether the discount is still reducing what this account pays *now* —
   * which is the only question recurring revenue asks of it.
   *
   * It is not "has the duration been counted out": the last period a discount
   * covers is discounted right up to the day it ends, and MRR is a run rate,
   * so a subscription in the twelfth month of "20% off year one" is still worth
   * 80% of its list price. `end` is written when that last period is billed and
   * the job that retires the row is queued for the same instant.
   */
  running(discount: Discount, at: number): boolean {
    return discount.status === 'active' && (discount.end === null || at < discount.end);
  }

  /**
   * Every running discount on the book at once, keyed by what it governs.
   *
   * The one reader MRR uses. The overview, the customer summary and the revenue
   * roll-up each walk hundreds of subscriptions, and asking per row is two
   * queries per subscription for an answer that changes for none of them
   * mid-loop.
   */
  runningIndex(orgId: string, at: number): { bySubscription: Map<string, Coupon>; byCustomer: Map<string, Coupon> } {
    const bySubscription = new Map<string, Coupon>();
    const byCustomer = new Map<string, Coupon>();
    const coupons = new Map<string, Coupon | null>();
    for (const row of this.ctx.db.all<Record<string, unknown>>(
      `SELECT * FROM billing_discounts WHERE org_id = ? AND status = 'active'`, orgId,
    )) {
      const couponId = String(row.coupon_id);
      if (!coupons.has(couponId)) coupons.set(couponId, this.ctx.svc.catalog.coupon(orgId, couponId));
      const coupon = coupons.get(couponId) ?? null;
      if (!coupon) continue;
      const discount = hydrateDiscount(row, this.periodsOf(coupon));
      if (!this.running(discount, at)) continue;
      if (discount.subscription) bySubscription.set(discount.subscription, coupon);
      else byCustomer.set(discount.customer, coupon);
    }
    return { bySubscription, byCustomer };
  }

  /* -------------------------------- writing ------------------------------- */

  /**
   * Fasten a coupon to a customer or a subscription.
   *
   * The redemption is taken from the catalogue first, so a campaign that has
   * run out refuses here rather than silently discounting a bill: the id it
   * hands back *is* this row's id, which is what keeps `times_redeemed` an
   * honest count of the discounts that exist.
   */
  attach(
    orgId: string,
    input: DiscountInput & { customer: string; subscription?: Subscription | null; startedAt?: number },
    meta: WriteMeta = {},
  ): Discount {
    return this.ctx.atomic(() => {
      // Backdated history says when the concession was agreed, not when the row
      // was written: a contract signed in March that the workspace is seeded
      // with today started in March, and its first discounted bill is dated
      // there too. The redemption is still checked against the clock — a
      // campaign that ran out yesterday cannot be spent by backdating.
      const startedAt = input.startedAt ?? this.ctx.now();
      const sub = input.subscription ?? null;
      const holder = sub ? { type: 'subscription', id: sub.id } : { type: 'customer', id: input.customer };

      const code = input.promotion_code
        ? this.ctx.svc.catalog.promotionCode(orgId, input.promotion_code)
          ?? this.ctx.svc.catalog.promotionCodeByCode(orgId, input.promotion_code)
        : null;
      if (input.promotion_code && !code) throw notFound('promotion_code', input.promotion_code);
      const couponId = code?.coupon ?? input.coupon;
      if (!couponId) {
        throw badRequest('parameter_missing', 'Send a coupon to attach, or the promotion code the customer typed.', 'coupon');
      }
      if (code && input.coupon && input.coupon !== code.coupon) {
        throw badRequest(
          'parameter_invalid',
          `${code.code} stands for ${code.coupon}, not ${input.coupon}. Send one or the other.`,
          'coupon', { promotion_code: code.id, coupon: code.coupon },
        );
      }
      const coupon = this.ctx.svc.catalog.requireCoupon(orgId, couponId);

      const existing = sub ? this.forSubscription(orgId, sub.id) : this.forCustomer(orgId, input.customer);
      if (existing) {
        throw conflict(
          'discount_already_attached',
          `${holder.type === 'subscription' ? `Subscription ${holder.id}` : `This account`} already carries ${existing.coupon}. Two discounts on one bill would need an order of application that does not exist — remove the first one, then attach this.`,
          { discount: existing.id, coupon: existing.coupon },
        );
      }

      // An amount-off coupon is denominated, and the catalogue refuses to spend
      // it against another currency. Refusing at the moment of attachment says
      // so to the person attaching it, rather than a month later to a renewal
      // job that cannot draw the bill.
      const currency = sub?.currency ?? this.ctx.db.get<{ currency: string }>(
        `SELECT currency FROM billing_customers WHERE org_id = ? AND id = ?`, orgId, input.customer,
      )?.currency;
      if (coupon.amount_off !== null && coupon.currency && currency && coupon.currency !== currency) {
        throw badRequest(
          'coupon_currency_mismatch',
          `${coupon.name?.trim() || coupon.id} takes ${formatMoney(money(coupon.amount_off, coupon.currency), { locale: this.locale(orgId) })} off a ${coupon.currency.toUpperCase()} bill, and this account is billed in ${currency.toUpperCase()}. Use a percentage coupon, or add a ${currency.toUpperCase()} one.`,
          'coupon', { coupon: coupon.id, coupon_currency: coupon.currency, currency },
        );
      }

      const redemption = this.ctx.svc.catalog.redeem(orgId, {
        coupon: coupon.id,
        promotion_code: code?.id ?? null,
        customer: input.customer,
        ref: holder,
      });

      this.ctx.db.insert('billing_discounts', {
        id: redemption.id,
        org_id: orgId,
        customer_id: input.customer,
        subscription_id: sub?.id ?? null,
        coupon_id: coupon.id,
        promotion_code_id: code?.id ?? null,
        start: startedAt,
        end_at: null,
        periods_used: 0,
        last_period_start: null,
        status: 'active',
        ended_at: null,
        created: startedAt,
        updated: startedAt,
      });
      const discount = this.discount(orgId, redemption.id) as Discount;
      this.ctx.emit(orgId, 'customer.discount.created', discount, {
        objectId: discount.id, objectType: 'discount',
        actorId: meta.actorId ?? null, actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
      });
      return discount;
    });
  }

  /**
   * Take it off again.
   *
   * The redemption goes back to the catalogue, which is the mirror `redeem` was
   * written to have: a subscription that never billed must not leave a
   * 150-redemption campaign showing 149 remaining when it has 150. A discount
   * that has already come off a bill is *not* released — the redemption was
   * spent on a real document — so the row is retired instead.
   */
  remove(orgId: string, id: string, meta: WriteMeta = {}): Discount {
    return this.ctx.atomic(() => {
      const discount = this.discount(orgId, id);
      if (!discount) throw notFound('discount', id);
      const now = this.ctx.now();
      if (discount.periods_used === 0) {
        this.ctx.svc.catalog.releaseRedemption(
          orgId,
          discount.subscription ? { type: 'subscription', id: discount.subscription } : { type: 'customer', id: discount.customer },
          { coupon: discount.coupon },
        );
        this.ctx.db.run(`DELETE FROM billing_discounts WHERE org_id = ? AND id = ?`, orgId, id);
      } else {
        this.ctx.db.patch('billing_discounts', 'id', id, {
          status: 'ended', ended_at: now, end_at: discount.end ?? now, updated: now,
        });
      }
      const removed: Discount = { ...discount, status: 'ended', ended_at: now, end: discount.end ?? now, updated: now };
      this.ctx.emit(orgId, 'customer.discount.deleted', removed, {
        objectId: id, objectType: 'discount',
        actorId: meta.actorId ?? null, actorType: meta.actorType ?? 'system', requestId: meta.requestId ?? null,
      });
      return removed;
    });
  }

  /**
   * Record that a bill has spent one of the discount's periods.
   *
   * Called from inside the invoice's own transaction, so a bill that fails to
   * commit does not burn a month of "20% off year one". When the period just
   * spent is the last one, the instant it ends is written onto the row *and*
   * enqueued: nothing here sleeps on a timer, so the expiry replays under the
   * time machine exactly where a real calendar would have put it.
   */
  spend(orgId: string, discount: Discount, coupon: Coupon, period: { start: number; end: number }): void {
    const now = this.ctx.now();
    if (discount.periods_used > 0 && discount.last_period_start === period.start) return;
    const used = discount.periods_used + 1;
    const periods = this.periodsOf(coupon);
    const end = periods !== null && used >= periods ? period.end : null;
    this.ctx.db.patch('billing_discounts', 'id', discount.id, {
      periods_used: used, last_period_start: period.start, end_at: end, updated: now,
    });
    if (end === null) return;
    this.ctx.enqueue(orgId, DISCOUNT_EXPIRE_JOB, { discount: discount.id, end }, {
      runAt: end, idemKey: `${DISCOUNT_EXPIRE_JOB}:${discount.id}`,
    });
    // A period that had already ended when the bill for it was written — a
    // backfilled year of trading, a renewal drawn late — is over now, and the
    // row says so rather than waiting for a queue to catch up with the past.
    // The job is still what retires a discount whose last period is ahead of
    // it, and running twice costs nothing.
    if (end <= now) this.expire(orgId, discount.id);
  }

  /**
   * Retire a discount whose last discounted period has ended.
   *
   * Idempotent, and it re-reads `end_at` rather than trusting the payload: a
   * cadence change between the job being queued and it running moves the
   * boundary, and the row is what the bills agreed on.
   */
  expire(orgId: string, id: string): Discount | null {
    return this.ctx.atomic(() => {
      const discount = this.discount(orgId, id);
      if (!discount || discount.status !== 'active') return null;
      const now = this.ctx.now();
      if (discount.end === null || now < discount.end) return discount;
      this.ctx.db.patch('billing_discounts', 'id', id, { status: 'ended', ended_at: discount.end, updated: now });
      const ended: Discount = { ...discount, status: 'ended', ended_at: discount.end, updated: now };
      this.ctx.emit(orgId, 'customer.discount.ended', ended, { objectId: id, objectType: 'discount', actorType: 'system' });
      return ended;
    });
  }
}
