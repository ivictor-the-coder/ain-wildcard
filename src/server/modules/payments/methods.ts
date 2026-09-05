/**
 * What a customer can be charged with.
 *
 * The one rule this file exists to enforce: **nothing resembling a card number
 * ever reaches the database.** A payment method here is a brand, four digits,
 * an expiry and a declared behaviour. `assertNoPan` refuses any field carrying
 * a run of twelve or more digits, so a caller who pastes a real card in gets a
 * 400 rather than a stored primary account number.
 *
 * The second rule is smaller but saves a class of bug: a card whose expiry has
 * passed declines as `expired_card` whatever its declared behaviour says,
 * because that is what an issuer does and because a demo that runs for a year
 * should watch its own cards go stale.
 */
import type { Ctx } from '../../kernel/context';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { cursorOf, newId, parseCursor } from '../../../shared/ids';
import { daysInMonth } from '../../../shared/time';
import { hash32, last4For } from './simulator';
import { hydrateMethod, type Page, type WriteMeta } from './records';
import {
  BANK_DEBIT_BEHAVIORS, CARD_BEHAVIORS,
  type BankAccountType, type CardBrand, type CardFunding, type PaymentMethod, type PaymentMethodType,
  type SimulatedBehavior,
} from './types';

export interface MethodInput {
  type: PaymentMethodType;
  customer: string;
  /**
   * Keep an id a subscription already points at. Migrating a book of business
   * off another processor arrives with `pm_…` ids already written into terms,
   * mandates and stored subscriptions; minting new ones would break every one
   * of those references on day one.
   */
  id?: string;
  brand?: CardBrand;
  exp_month?: number;
  exp_year?: number;
  funding?: CardFunding;
  country?: string;
  bank_name?: string;
  account_type?: BankAccountType;
  last4?: string;
  simulated_behavior?: SimulatedBehavior;
  simulated_decline_count?: number | null;
  billing_name?: string;
  billing_email?: string;
  set_default?: boolean;
  metadata?: Record<string, string>;
}

export interface MethodUpdateInput {
  exp_month?: number;
  exp_year?: number;
  billing_name?: string;
  billing_email?: string;
  simulated_behavior?: SimulatedBehavior;
  simulated_decline_count?: number | null;
  metadata?: Record<string, string>;
}

export interface MethodListFilter {
  customer?: string;
  type?: PaymentMethodType;
  status?: 'attached' | 'detached' | 'all';
  behavior?: SimulatedBehavior;
  limit?: number;
  cursor?: string | null;
}

const BRAND_LABELS: Record<CardBrand, string> = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover',
  jcb: 'JCB', diners: 'Diners Club', unionpay: 'UnionPay', unknown: 'Card',
};

const PAN_SHAPED = /\d[\d\s-]{10,}\d/;

/** Refuse anything that could be a real primary account number. */
export function assertNoPan(input: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue;
    const digits = value.replace(/[\s-]/g, '');
    if (PAN_SHAPED.test(value) && /^\d{12,19}$/.test(digits)) {
      throw badRequest(
        'card_number_refused',
        'Ain never stores card numbers. This is a simulated processor: give it a brand, an expiry and the behaviour you want to test.',
        key,
      );
    }
  }
}

export const monthEnd = (year: number, month: number): number =>
  Date.UTC(year, month - 1, daysInMonth(year, month - 1), 23, 59, 59, 999);

export class Methods {
  constructor(private readonly ctx: Ctx) {}

  /* --------------------------------- reading ------------------------------ */

  method(orgId: string, id: string): PaymentMethod | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM payments_methods WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydrateMethod(row) : null;
  }

  require(orgId: string, id: string): PaymentMethod {
    const found = this.method(orgId, id);
    if (!found) throw notFound('payment method', id);
    return found;
  }

  list(orgId: string, filter: MethodListFilter = {}): Page<PaymentMethod> {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.type) { clauses.push('type = ?'); params.push(filter.type); }
    if (filter.behavior) { clauses.push('simulated_behavior = ?'); params.push(filter.behavior); }
    const status = filter.status ?? 'attached';
    if (status !== 'all') { clauses.push('status = ?'); params.push(status); }
    const where = clauses.join(' AND ');
    const totalCount = this.ctx.db.count(`SELECT COUNT(*) FROM payments_methods WHERE ${where}`, ...(params as any[]));

    const paged = [...params];
    let cursorClause = '';
    if (filter.cursor) {
      const parsed = parseCursor(filter.cursor);
      if (!parsed) throw badRequest('cursor_invalid', 'That pagination cursor is not readable. Start the list again.', 'cursor');
      cursorClause = ' AND (created < ? OR (created = ? AND id < ?))';
      paged.push(parsed.createdAt, parsed.createdAt, parsed.id);
    }
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 200);
    const rows = this.ctx.db.all<any>(
      `SELECT * FROM payments_methods WHERE ${where}${cursorClause} ORDER BY is_default DESC, created DESC, id DESC LIMIT ?`,
      ...(paged as any[]), limit + 1,
    );
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(hydrateMethod);
    const last = data[data.length - 1];
    return { data, hasMore, nextCursor: hasMore && last ? cursorOf(last.created, last.id) : null, totalCount };
  }

  forCustomer(orgId: string, customerId: string): PaymentMethod[] {
    return this.list(orgId, { customer: customerId, limit: 200 }).data;
  }

  defaultFor(orgId: string, customerId: string): PaymentMethod | null {
    const row = this.ctx.db.get<any>(
      `SELECT * FROM payments_methods WHERE org_id = ? AND customer_id = ? AND status = 'attached'
        ORDER BY is_default DESC, created ASC LIMIT 1`,
      orgId, customerId,
    );
    return row ? hydrateMethod(row) : null;
  }

  /**
   * The method a given bill should be charged with.
   *
   * A subscription's own default wins over the customer's, which is how one
   * account pays its platform fee on a corporate card and its overage on a
   * departmental one. A named method that no longer exists — a card deleted
   * out from under a subscription — falls back rather than failing: the point
   * is to collect the money, and there is a real card sitting right there.
   */
  resolve(orgId: string, customerId: string, preferred: (string | null | undefined)[]): PaymentMethod | null {
    for (const id of preferred) {
      if (!id) continue;
      const found = this.method(orgId, id);
      if (found && found.status === 'attached' && found.customer === customerId) return found;
    }
    return this.defaultFor(orgId, customerId);
  }

  /**
   * The behaviour that will actually apply, which is not always the declared
   * one: an issuer refuses an expired card no matter what else is true of it.
   */
  effectiveBehavior(method: PaymentMethod, now: number): { behavior: SimulatedBehavior; declineCount: number | null } {
    if (method.card && monthEnd(method.card.exp_year, method.card.exp_month) < now) {
      return { behavior: 'expired_card', declineCount: null };
    }
    return { behavior: method.simulated.behavior, declineCount: method.simulated.decline_count };
  }

  /* -------------------------------- writing ------------------------------- */

  create(orgId: string, input: MethodInput, meta: WriteMeta = {}): PaymentMethod {
    assertNoPan(input as unknown as Record<string, unknown>);
    return this.ctx.atomic(() => {
      const customer = this.ctx.svc.billing.requireCustomer(orgId, input.customer);
      const now = this.ctx.now();
      const behavior = input.simulated_behavior ?? 'succeeds';
      const allowed = input.type === 'card' ? CARD_BEHAVIORS : BANK_DEBIT_BEHAVIORS;
      if (!allowed.includes(behavior)) {
        throw badRequest(
          'simulated_behavior_unsupported',
          `A ${input.type === 'card' ? 'card' : 'direct debit'} cannot fail with "${behavior}". Choose one of: ${allowed.join(', ')}.`,
          'simulated_behavior',
          { allowed },
        );
      }
      const id = input.id ?? newId('method');
      if (input.id) {
        if (!/^pm_[A-Za-z0-9_]{1,60}$/.test(input.id)) {
          throw badRequest('id_invalid', 'A payment method id looks like "pm_" followed by letters, digits or underscores.', 'id');
        }
        if (this.method(orgId, input.id)) {
          throw conflict('payment_method_exists', `Payment method ${input.id} already exists in this workspace.`, { id: input.id });
        }
      }
      const last4 = input.last4 ?? last4For(`${id}:${input.customer}`);
      if (!/^\d{4}$/.test(last4)) {
        throw badRequest('last4_invalid', 'last4 is exactly four digits — and it is the only part of an account number this platform will hold.', 'last4');
      }

      const isCard = input.type === 'card';
      const brand: CardBrand = input.brand ?? 'visa';
      const expMonth = input.exp_month ?? 12;
      const expYear = input.exp_year ?? new Date(now).getUTCFullYear() + 3;
      if (isCard && (expMonth < 1 || expMonth > 12)) {
        throw badRequest('exp_month_invalid', 'exp_month is a calendar month, 1 through 12.', 'exp_month');
      }
      const bankName = input.bank_name ?? 'Midland Union Bank';
      const accountType: BankAccountType = input.account_type ?? 'checking';
      const displayName = isCard
        ? `${BRAND_LABELS[brand]} ending ${last4}, expires ${String(expMonth).padStart(2, '0')}/${expYear}`
        : `${bankName} ${accountType} ending ${last4}`;
      const fingerprint = `fp_${(hash32(isCard ? `card:${brand}:${last4}:${expMonth}:${expYear}` : `bank:${bankName}:${last4}`)).toString(36)}`;
      const declineCount = input.simulated_decline_count === undefined ? null : input.simulated_decline_count;
      if (declineCount !== null && declineCount < 0) {
        throw badRequest('decline_count_invalid', 'simulated_decline_count counts attempts, so it cannot be negative. Leave it out for a method that always declines.', 'simulated_decline_count');
      }

      const existingDefault = this.defaultFor(orgId, customer.id);
      const makeDefault = input.set_default ?? !existingDefault;
      if (makeDefault && existingDefault) this.clearDefault(orgId, customer.id, now);

      this.ctx.db.insert('payments_methods', {
        id, org_id: orgId, customer_id: customer.id, type: input.type, status: 'attached',
        is_default: makeDefault ? 1 : 0, display_name: displayName,
        brand: isCard ? brand : null, last4,
        exp_month: isCard ? expMonth : null, exp_year: isCard ? expYear : null,
        funding: isCard ? (input.funding ?? 'credit') : null,
        country: input.country ?? customer.address?.country ?? null,
        bank_name: isCard ? null : bankName,
        account_type: isCard ? null : accountType,
        mandate_reference: isCard ? null : `MND-${(hash32(`mandate:${id}`) % 1_000_000).toString().padStart(6, '0')}`,
        simulated_behavior: behavior,
        simulated_decline_count: declineCount,
        billing_name: input.billing_name ?? customer.name,
        billing_email: input.billing_email ?? customer.email,
        fingerprint,
        metadata: input.metadata ?? {},
        created: now, updated: now, detached_at: null,
        livemode: meta.livemode === false ? 0 : 1,
      } as any);

      const method = this.require(orgId, id);
      this.ctx.emit(orgId, 'payment_method.attached', method, {
        objectId: id, objectType: 'payment_method',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return method;
    });
  }

  update(orgId: string, id: string, input: MethodUpdateInput, meta: WriteMeta = {}): PaymentMethod {
    assertNoPan(input as unknown as Record<string, unknown>);
    return this.ctx.atomic(() => {
      const before = this.require(orgId, id);
      if (before.status === 'detached') {
        throw conflict('payment_method_detached', `Payment method ${id} was detached on ${new Date(before.detached_at ?? 0).toISOString().slice(0, 10)} and cannot be edited. Attach a new one.`);
      }
      const now = this.ctx.now();
      const changes: Record<string, unknown> = { updated: now };
      if (input.exp_month !== undefined || input.exp_year !== undefined) {
        if (!before.card) throw badRequest('not_a_card', 'Only a card has an expiry date.', 'exp_month');
        const expMonth = input.exp_month ?? before.card.exp_month;
        const expYear = input.exp_year ?? before.card.exp_year;
        changes.exp_month = expMonth;
        changes.exp_year = expYear;
        changes.display_name = `${BRAND_LABELS[before.card.brand]} ending ${before.card.last4}, expires ${String(expMonth).padStart(2, '0')}/${expYear}`;
      }
      if (input.billing_name !== undefined) changes.billing_name = input.billing_name;
      if (input.billing_email !== undefined) changes.billing_email = input.billing_email;
      if (input.simulated_behavior !== undefined) {
        const allowed = before.type === 'card' ? CARD_BEHAVIORS : BANK_DEBIT_BEHAVIORS;
        if (!allowed.includes(input.simulated_behavior)) {
          throw badRequest(
            'simulated_behavior_unsupported',
            `A ${before.type === 'card' ? 'card' : 'direct debit'} cannot fail with "${input.simulated_behavior}". Choose one of: ${allowed.join(', ')}.`,
            'simulated_behavior', { allowed },
          );
        }
        changes.simulated_behavior = input.simulated_behavior;
      }
      if (input.simulated_decline_count !== undefined) changes.simulated_decline_count = input.simulated_decline_count;
      if (input.metadata !== undefined) changes.metadata = input.metadata;

      this.ctx.db.patch('payments_methods', 'id', id, changes as any);
      const after = this.require(orgId, id);
      this.ctx.emit(orgId, 'payment_method.updated', after, {
        objectId: id, objectType: 'payment_method',
        previous: { display_name: before.display_name, simulated: before.simulated },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return after;
    });
  }

  attach(orgId: string, id: string, customerId: string, meta: WriteMeta = {}): PaymentMethod {
    return this.ctx.atomic(() => {
      const method = this.require(orgId, id);
      const customer = this.ctx.svc.billing.requireCustomer(orgId, customerId);
      if (method.customer && method.customer !== customerId && method.status === 'attached') {
        throw conflict(
          'payment_method_in_use',
          `${method.display_name} is already attached to another customer. A payment method belongs to one account.`,
          { customer: method.customer },
        );
      }
      const now = this.ctx.now();
      const existingDefault = this.defaultFor(orgId, customer.id);
      this.ctx.db.patch('payments_methods', 'id', id, {
        customer_id: customer.id, status: 'attached', detached_at: null,
        is_default: existingDefault ? 0 : 1, updated: now,
      });
      const after = this.require(orgId, id);
      this.ctx.emit(orgId, 'payment_method.attached', after, {
        objectId: id, objectType: 'payment_method', previous: { customer: method.customer, status: method.status },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return after;
    });
  }

  /**
   * Detaching keeps the row. Charges point at it, disputes are argued over it,
   * and a card that has been deleted still has to explain last March's invoice.
   */
  detach(orgId: string, id: string, meta: WriteMeta = {}): PaymentMethod {
    return this.ctx.atomic(() => {
      const method = this.require(orgId, id);
      if (method.status === 'detached') return method;
      const now = this.ctx.now();
      const customerId = method.customer;
      this.ctx.db.patch('payments_methods', 'id', id, {
        status: 'detached', is_default: 0, customer_id: null, detached_at: now, updated: now,
      });
      // The account is not left without a way to be charged if it has another.
      if (customerId && method.default_for_customer) {
        const next = this.defaultFor(orgId, customerId);
        if (next) this.ctx.db.patch('payments_methods', 'id', next.id, { is_default: 1, updated: now });
      }
      const after = this.require(orgId, id);
      this.ctx.emit(orgId, 'payment_method.detached', after, {
        objectId: id, objectType: 'payment_method', previous: { customer: customerId, status: method.status },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return after;
    });
  }

  setDefault(orgId: string, id: string, meta: WriteMeta = {}): PaymentMethod {
    return this.ctx.atomic(() => {
      const method = this.require(orgId, id);
      if (!method.customer || method.status !== 'attached') {
        throw conflict('payment_method_detached', `${method.display_name} is not attached to a customer, so it cannot be their default.`);
      }
      const now = this.ctx.now();
      this.clearDefault(orgId, method.customer, now);
      this.ctx.db.patch('payments_methods', 'id', id, { is_default: 1, updated: now });
      const after = this.require(orgId, id);
      this.ctx.emit(orgId, 'payment_method.default_changed', after, {
        objectId: id, objectType: 'payment_method', previous: { default_for_customer: method.default_for_customer },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return after;
    });
  }

  private clearDefault(orgId: string, customerId: string, now: number): void {
    this.ctx.db.run(
      `UPDATE payments_methods SET is_default = 0, updated = ? WHERE org_id = ? AND customer_id = ? AND is_default = 1`,
      now, orgId, customerId,
    );
  }
}
