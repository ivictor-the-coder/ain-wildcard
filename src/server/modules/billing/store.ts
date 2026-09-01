/**
 * Reading and writing customers, subscriptions and the money that moves
 * between them.
 *
 * House rules that this file never breaks:
 *  - every statement filters on `org_id`;
 *  - every mutation runs inside `ctx.atomic()` so its events publish only if
 *    the write commits;
 *  - every deferred consequence — a renewal, a scheduled cancellation, a
 *    trial reminder — is a row in `jobs` with a `run_at`, never a timer;
 *  - all times come from `ctx.now()`.
 */
import type { Ctx } from '../../kernel/context';
import { parseJson } from '../../kernel/db';
import { badRequest, conflict, internal, notFound } from '../../../shared/errors';
import { cursorOf, newId, parseCursor, randomId } from '../../../shared/ids';
import { formatMoney, money } from '../../../shared/money';
import { DAY, HOUR, addInterval, type Interval, type Period } from '../../../shared/time';
import type { Price, ProrationBehavior } from '../catalog/types';
import { CreditNotes } from './credit-notes';
import {
  hydrateBalanceTransaction, hydrateCustomer, hydrateItem, hydratePendingItem, hydratePeriod,
  describeAutomaticTax, hydrateSubscription, like, normaliseAddress, taxSummaryOf,
  type AddressInput, type CancelInput, type CustomerInput, type CustomerListFilter, type Page,
  type ResolvedItem, type SubscriptionCreateInput, type SubscriptionItemInput,
  type SubscriptionListFilter, type SubscriptionUpdateInput, type WriteMeta,
} from './records';
import {
  anchorDayOf, anchorLandsOnDay, assertFlatQuantity, cadenceHasAnchorDay, describeCadence, intervalOf, isMetered,
  isRecurring, longDate, periodAt, Pricebook, recurringLines, recurringSubtotal,
  resolveInterval, sameCadence, snapToAnchorDay, subscriptionMrr, type PricedItem,
} from './cycle';
import { Invoices, describeWindow, type DraftLine } from './invoices';
import { previewChange, prorate, type ItemState, type ProrationSet } from './proration';
import { assertTransition, countsAsRevenue, isTerminal, transitionEvent } from './status';
import {
  checkTaxId, defaultVerificationNote, isCheckableTaxIdType, normaliseTaxIdValue, pendingVerification,
  type TaxIdVerificationStatus,
} from './tax';
import {
  type AutomaticTax,
  type BalanceTransaction, type BalanceTransactionType, type BilledPeriod, type Cadence,
  type CancellationReason,
  type ChangePreview, type CollectionMethod, type Customer, type Invoice, type InvoiceBillingReason,
  type PauseBehavior, type PaymentBehavior,
  type PendingInvoiceItem, type PendingItemStatus, type PeriodStatus, type ProrationLine,
  type RecurringLine, type SchedulePhase, type Subscription, type SubscriptionItem,
  type SubscriptionStatus, type TaxId, type TaxIdVerification, type TrialEndBehavior,
} from './types';

/**
 * How many waiting proration lines one bill sweeps up.
 *
 * A cap, because an invoice is bounded work; anything past it stays `pending`
 * and rides the bill after. It is a constant rather than a literal because
 * three different callers have to read the ledger to exactly this depth or
 * they describe different bills: `claimPendingItems` decides what the invoice
 * carries, `previewInvoice` predicts it, and the customer summary quotes it to
 * a support agent. The summary read 200 of them while the bill claimed 500, so
 * an account with 210 waiting lines was told $14.50 was outstanding on a bill
 * that went out carrying $43.50 of it.
 */
export const PENDING_ITEMS_PER_INVOICE = 500;

/* --------------------------------- the store ------------------------------ */

export class Billing {
  /**
   * A schedule phase boundary is a billing period boundary: the phase's items
   * have to be in place before the period they cover is priced and invoiced.
   * The schedules layer installs itself here at boot so the renewal can ask,
   * rather than billing importing schedules and schedules importing billing.
   */
  onPeriodBoundary: ((orgId: string, sub: Subscription, at: number) => Subscription) | null = null;

  /** The invoicing half of the module: assembling, totalling and settling bills. */
  readonly invoices: Invoices;

  /** The only legal way to reduce a finalised bill. */
  readonly creditNotes: CreditNotes;

  constructor(private readonly ctx: Ctx) {
    this.invoices = new Invoices(ctx, this);
    this.creditNotes = new CreditNotes(ctx, this);
  }

  book(orgId: string): Pricebook { return new Pricebook(this.ctx, orgId); }

  locale(orgId: string): string {
    try { return this.ctx.svc.core.org(orgId).locale || 'en-US'; }
    catch { return 'en-US'; }
  }

  defaultCurrency(orgId: string): string {
    try { return this.ctx.svc.core.currency(orgId); }
    catch { return 'usd'; }
  }

  /* ------------------------------- customers ------------------------------ */

  listCustomers(orgId: string, filter: CustomerListFilter = {}): Page<Customer> {
    const clauses = ['c.org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.email) { clauses.push('c.email = ?'); params.push(filter.email.toLowerCase()); }
    if (filter.delinquent !== undefined) { clauses.push('c.delinquent = ?'); params.push(filter.delinquent ? 1 : 0); }
    if (filter.currency) { clauses.push('c.currency = ?'); params.push(filter.currency.toLowerCase()); }
    if (filter.crm_record_id) { clauses.push('c.crm_record_id = ?'); params.push(filter.crm_record_id); }
    if (filter.query) {
      clauses.push('(c.name LIKE ? ESCAPE \'\\\' OR c.email LIKE ? ESCAPE \'\\\' OR c.description LIKE ? ESCAPE \'\\\' OR c.id = ?)');
      const l = like(filter.query);
      params.push(l, l, l, filter.query);
    }
    if (filter.has_subscription !== undefined) {
      clauses.push(
        `${filter.has_subscription ? 'EXISTS' : 'NOT EXISTS'} (SELECT 1 FROM billing_subscriptions s WHERE s.customer_id = c.id AND s.status NOT IN ('canceled','incomplete_expired'))`,
      );
    }
    const where = clauses.join(' AND ');
    const totalCount = this.ctx.db.count(`SELECT COUNT(*) FROM billing_customers c WHERE ${where}`, ...(params as any[]));

    const paged = [...params];
    let cursorClause = '';
    if (filter.cursor) {
      const parsed = parseCursor(filter.cursor);
      if (!parsed) throw badRequest('cursor_invalid', 'That pagination cursor is not readable. Start the list again.', 'cursor');
      cursorClause = ' AND (c.created < ? OR (c.created = ? AND c.id < ?))';
      paged.push(parsed.createdAt, parsed.createdAt, parsed.id);
    }
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 200);
    const rows = this.ctx.db.all<any>(
      `SELECT c.* FROM billing_customers c WHERE ${where}${cursorClause} ORDER BY c.created DESC, c.id DESC LIMIT ?`,
      ...(paged as any[]), limit + 1,
    );
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(hydrateCustomer);
    const last = data[data.length - 1];
    return { data, hasMore, nextCursor: hasMore && last ? cursorOf(last.created, last.id) : null, totalCount };
  }

  customer(orgId: string, id: string): Customer | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM billing_customers WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydrateCustomer(row) : null;
  }

  requireCustomer(orgId: string, id: string): Customer {
    const found = this.customer(orgId, id);
    if (!found) throw notFound('customer', id);
    return found;
  }

  customerByCrmRecord(orgId: string, recordId: string): Customer | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM billing_customers WHERE org_id = ? AND crm_record_id = ?`, orgId, recordId);
    return row ? hydrateCustomer(row) : null;
  }

  customerByEmail(orgId: string, email: string): Customer | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM billing_customers WHERE org_id = ? AND email = ? ORDER BY created LIMIT 1`, orgId, email.toLowerCase());
    return row ? hydrateCustomer(row) : null;
  }

  createCustomer(orgId: string, input: CustomerInput, meta: WriteMeta = {}): Customer {
    return this.ctx.atomic(() => {
      const now = this.ctx.now();
      const id = input.id ?? newId('customer');
      if (this.ctx.db.get(`SELECT id FROM billing_customers WHERE org_id = ? AND id = ?`, orgId, id)) {
        throw conflict('customer_exists', `Customer ${id} already exists.`);
      }
      if (input.crm_record_id) {
        const existing = this.customerByCrmRecord(orgId, input.crm_record_id);
        if (existing) {
          throw conflict(
            'crm_record_already_billed',
            `${input.crm_record_id} is already billed as customer ${existing.id}. One CRM company has one billing customer so revenue never double-counts.`,
            { customer: existing.id },
          );
        }
      }
      const currency = (input.currency ?? this.defaultCurrency(orgId)).toLowerCase();
      const row = {
        id, org_id: orgId,
        name: input.name,
        email: input.email ? input.email.toLowerCase() : null,
        description: input.description ?? null,
        phone: input.phone ?? null,
        currency,
        currency_locked: 0,
        address: input.address ? normaliseAddress(input.address) : null,
        shipping: input.shipping
          ? { name: input.shipping.name ?? null, phone: input.shipping.phone ?? null, address: input.shipping.address ? normaliseAddress(input.shipping.address) : null }
          : null,
        tax_ids: this.readTaxIds(input.tax_ids ?? [], []),
        tax_exempt: input.tax_exempt ?? 'none',
        invoice_settings: {
          default_payment_method: input.invoice_settings?.default_payment_method ?? null,
          days_until_due: input.invoice_settings?.days_until_due ?? null,
          custom_fields: input.invoice_settings?.custom_fields ?? [],
          footer: input.invoice_settings?.footer ?? null,
        },
        balance: input.balance ?? 0,
        delinquent: 0,
        preferred_locales: input.preferred_locales ?? [],
        metadata: input.metadata ?? {},
        crm_record_id: input.crm_record_id ?? null,
        created: now, updated: now,
        livemode: meta.livemode === false ? 0 : 1,
      };
      this.ctx.db.insert('billing_customers', row as any);
      const customer = this.requireCustomer(orgId, id);
      this.ctx.emit(orgId, 'customer.created', customer, {
        objectId: id, objectType: 'customer', actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return customer;
    });
  }

  updateCustomer(orgId: string, id: string, input: Partial<CustomerInput>, meta: WriteMeta = {}): Customer {
    return this.ctx.atomic(() => {
      const before = this.requireCustomer(orgId, id);
      const changes: Record<string, unknown> = { updated: this.ctx.now() };
      const previous: Record<string, unknown> = {};

      if (input.currency !== undefined && input.currency.toLowerCase() !== before.currency) {
        this.assertCurrencyChangeable(orgId, before, input.currency.toLowerCase());
        changes.currency = input.currency.toLowerCase();
        previous.currency = before.currency;
      }
      const set = <K extends keyof Customer>(key: K, column: string, value: unknown) => {
        if (value === undefined) return;
        previous[key as string] = before[key];
        changes[column] = value as never;
      };
      set('name', 'name', input.name);
      set('email', 'email', input.email === undefined ? undefined : input.email ? input.email.toLowerCase() : null);
      set('description', 'description', input.description);
      set('phone', 'phone', input.phone);
      set('address', 'address', input.address === undefined ? undefined : input.address ? normaliseAddress(input.address) : null);
      set('shipping', 'shipping', input.shipping === undefined
        ? undefined
        : input.shipping
          ? { name: input.shipping.name ?? null, phone: input.shipping.phone ?? null, address: input.shipping.address ? normaliseAddress(input.shipping.address) : null }
          : null);
      set('tax_ids', 'tax_ids', input.tax_ids === undefined
        ? undefined
        : this.readTaxIds(input.tax_ids, before.tax_ids));
      set('tax_exempt', 'tax_exempt', input.tax_exempt);
      set('preferred_locales', 'preferred_locales', input.preferred_locales);
      set('metadata', 'metadata', input.metadata === undefined ? undefined : { ...before.metadata, ...input.metadata });
      set('crm_record_id', 'crm_record_id', input.crm_record_id);
      if (input.invoice_settings) {
        previous.invoice_settings = before.invoice_settings;
        changes.invoice_settings = {
          default_payment_method: input.invoice_settings.default_payment_method ?? before.invoice_settings.default_payment_method,
          days_until_due: input.invoice_settings.days_until_due ?? before.invoice_settings.days_until_due,
          custom_fields: input.invoice_settings.custom_fields ?? before.invoice_settings.custom_fields,
          footer: input.invoice_settings.footer ?? before.invoice_settings.footer,
        };
      }

      this.ctx.db.patch('billing_customers', 'id', id, changes as any);
      const after = this.requireCustomer(orgId, id);
      if (Object.keys(previous).length) {
        this.ctx.emit(orgId, 'customer.updated', after, {
          objectId: id, objectType: 'customer', previous, actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
        });
      }
      return after;
    });
  }

  /**
   * A customer's currency is the currency every invoice, credit and balance
   * entry on the account is denominated in. Once anything has been billed it
   * cannot move, because there is no honest exchange rate to restate history at.
   */
  private assertCurrencyChangeable(orgId: string, customer: Customer, next: string): void {
    if (customer.currency_locked) {
      throw conflict(
        'customer_currency_locked',
        `${customer.name} already bills in ${customer.currency.toUpperCase()}. A customer's currency is fixed once they have a subscription or an invoice — create a second customer to bill in ${next.toUpperCase()}.`,
        { currency: customer.currency },
      );
    }
    const subs = this.ctx.db.count(`SELECT COUNT(*) FROM billing_subscriptions WHERE org_id = ? AND customer_id = ?`, orgId, customer.id);
    if (subs > 0) {
      throw conflict(
        'customer_currency_locked',
        `${customer.name} has ${subs} subscription${subs === 1 ? '' : 's'} in ${customer.currency.toUpperCase()}, so the currency can no longer change.`,
        { currency: customer.currency, subscriptions: subs },
      );
    }
  }

  lockCurrency(orgId: string, customerId: string): void {
    this.ctx.db.run(`UPDATE billing_customers SET currency_locked = 1 WHERE org_id = ? AND id = ?`, orgId, customerId);
  }

  deleteCustomer(orgId: string, id: string, meta: WriteMeta = {}): { object: 'customer'; id: string; deleted: true } {
    return this.ctx.atomic(() => {
      const customer = this.requireCustomer(orgId, id);
      const live = this.ctx.db.count(
        `SELECT COUNT(*) FROM billing_subscriptions WHERE org_id = ? AND customer_id = ? AND status NOT IN ('canceled','incomplete_expired')`,
        orgId, id,
      );
      if (live > 0) {
        throw conflict(
          'customer_has_active_subscriptions',
          `${customer.name} still has ${live} live subscription${live === 1 ? '' : 's'}. Cancel them before deleting the customer.`,
          { subscriptions: live },
        );
      }
      this.ctx.db.run(`DELETE FROM billing_customers WHERE org_id = ? AND id = ?`, orgId, id);
      this.ctx.emit(orgId, 'customer.deleted', { id, name: customer.name }, {
        objectId: id, objectType: 'customer', actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return { object: 'customer' as const, id, deleted: true as const };
    });
  }

  /* -------------------------------- tax ids ------------------------------- */

  /**
   * Read the registration numbers off a write, refusing anything that is not
   * one.
   *
   * A number that survives this is stored the way its authority writes it, and
   * carries a verification state that starts at "not confirmed". A number that
   * is already on the account and comes back unchanged keeps whatever the
   * register said about it — editing a customer's phone number must not quietly
   * un-verify their VAT registration — and a number that has *changed* starts
   * again, because it is a different registration.
   */
  private readTaxIds(
    inputs: { type: string; value: string; country?: string | null }[],
    existing: TaxId[],
  ): TaxId[] {
    const seen = new Map<string, number>();
    return inputs.map((input, index) => {
      const check = checkTaxId(input.type, input.value);
      if (!check.ok) {
        throw badRequest(
          'tax_id_invalid',
          `${check.message} A registration that is not one is worse than none at all: it is what a customer would type to stop being charged tax the supplier still owes.`,
          'tax_ids',
          { index, type: input.type, value: input.value },
        );
      }
      const first = seen.get(check.value);
      if (first !== undefined) {
        throw badRequest(
          'tax_id_duplicated',
          `${check.value} is listed twice on this account, at positions ${first + 1} and ${index + 1}. One registration number, once.`,
          'tax_ids',
          { index, value: check.value },
        );
      }
      seen.set(check.value, index);
      const held = existing.find((t) => t.value === check.value && t.type === input.type);
      return {
        type: input.type,
        value: check.value,
        country: input.country ?? held?.country ?? null,
        verification: held?.verification ?? pendingVerification(input.type),
      };
    });
  }

  /**
   * Record what the register said about a registration number.
   *
   * This is a separate, deliberate act rather than a field on the customer for
   * one reason: the customer supplies the number, and the workspace — or the
   * connector that queries VIES or HMRC on its behalf — supplies the answer.
   * Only `verified` shifts the tax, so the two must not arrive in the same
   * write from the same hand.
   */
  verifyTaxId(
    orgId: string, customerId: string,
    input: { value: string; status: TaxIdVerificationStatus; verified_name?: string | null; verified_address?: string | null; note?: string | null },
    meta: WriteMeta = {},
  ): Customer {
    return this.ctx.atomic(() => {
      const customer = this.requireCustomer(orgId, customerId);
      // Matched the way the number is stored, so "DE 811 907 980" finds the
      // registration that went in as "de811907980".
      const index = customer.tax_ids.findIndex(
        (taxId) => taxId.value === normaliseTaxIdValue(taxId.type, input.value),
      );
      if (index < 0) {
        throw badRequest(
          'tax_id_not_on_customer',
          customer.tax_ids.length
            ? `${customer.name} has no registration ${input.value} on file. It holds ${customer.tax_ids.map((t) => t.value).join(', ')}.`
            : `${customer.name} has no tax registration on file, so there is nothing to verify. Add one with PATCH /v1/customers/${customerId} first.`,
          'value',
        );
      }
      const taxId = customer.tax_ids[index];
      if (input.status === 'verified' && !isCheckableTaxIdType(taxId.type)) {
        throw badRequest(
          'tax_id_type_not_checkable',
          `Ain holds no format for a "${taxId.type}" registration, so it cannot be treated as verified — and an unverified registration never moves the tax off this workspace. Record it under a type Ain knows, or leave the tax charged.`,
          'status',
          { type: taxId.type },
        );
      }
      const now = this.ctx.now();
      const verification: TaxIdVerification = {
        status: input.status,
        verified_name: input.verified_name ?? null,
        verified_address: input.verified_address ?? null,
        checked_at: now,
        note: input.note ?? defaultVerificationNote(input.status, taxId.value),
      };
      const taxIds = customer.tax_ids.map((held, at) => (at === index ? { ...held, verification } : held));
      this.ctx.db.patch('billing_customers', 'id', customerId, { tax_ids: taxIds as any, updated: now });
      const after = this.requireCustomer(orgId, customerId);
      this.ctx.emit(orgId, 'customer.tax_id_verified', {
        customer: customerId,
        tax_id: { type: taxId.type, value: taxId.value, country: taxId.country, verification },
        reverse_charge_eligible: input.status === 'verified',
      }, {
        objectId: customerId, objectType: 'customer',
        previous: { verification: taxId.verification },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return after;
    });
  }

  /* -------------------------------- balance ------------------------------- */

  /**
   * Move the customer balance and say why. A negative `amount` grants credit
   * (the Stripe convention) and a positive one takes it back or carries a
   * charge forward.
   */
  adjustBalance(
    orgId: string,
    customerId: string,
    amount: number,
    opts: { type: BalanceTransactionType; description: string; subscription?: string | null; invoice?: string | null; createdAt?: number },
  ): BalanceTransaction {
    const customer = this.requireCustomer(orgId, customerId);
    const created = opts.createdAt ?? this.ctx.now();
    const ending = customer.balance + amount;
    const id = newId('ledger');
    this.ctx.db.insert('billing_balance_transactions', {
      id, org_id: orgId, customer_id: customerId, amount, ending_balance: ending,
      currency: customer.currency, type: opts.type, description: opts.description,
      subscription_id: opts.subscription ?? null, invoice_id: opts.invoice ?? null, created,
    });
    this.ctx.db.patch('billing_customers', 'id', customerId, { balance: ending, updated: created });
    const txn = hydrateBalanceTransaction(
      this.ctx.db.get<any>(`SELECT * FROM billing_balance_transactions WHERE id = ?`, id),
    );
    this.ctx.emit(orgId, amount < 0 ? 'customer.credited' : 'customer.debited', txn, {
      objectId: customerId, objectType: 'customer', previous: { balance: customer.balance },
    });
    return txn;
  }

  balanceTransactions(orgId: string, customerId: string, limit = 25): BalanceTransaction[] {
    return this.ctx.db.all<any>(
      `SELECT * FROM billing_balance_transactions WHERE org_id = ? AND customer_id = ? ORDER BY created DESC, rowid DESC LIMIT ?`,
      orgId, customerId, Math.min(Math.max(limit, 1), 200),
    ).map(hydrateBalanceTransaction);
  }

  /* ------------------------------ subscriptions --------------------------- */

  items(subscriptionId: string): SubscriptionItem[] {
    return this.ctx.db.all<any>(
      `SELECT * FROM billing_subscription_items WHERE subscription_id = ? ORDER BY position ASC, created ASC, id ASC`,
      subscriptionId,
    ).map(hydrateItem);
  }

  subscription(orgId: string, id: string): Subscription | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM billing_subscriptions WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydrateSubscription(row, this.items(id)) : null;
  }

  requireSubscription(orgId: string, id: string): Subscription {
    const found = this.subscription(orgId, id);
    if (!found) throw notFound('subscription', id);
    return found;
  }

  listSubscriptions(orgId: string, filter: SubscriptionListFilter = {}): Page<Subscription> {
    const clauses = ['s.org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.customer) { clauses.push('s.customer_id = ?'); params.push(filter.customer); }
    if (filter.status && filter.status !== 'all') {
      if (filter.status === 'active_like') clauses.push(`s.status IN ('trialing','active','past_due','unpaid','paused')`);
      else { clauses.push('s.status = ?'); params.push(filter.status); }
    }
    if (filter.collection_method) { clauses.push('s.collection_method = ?'); params.push(filter.collection_method); }
    if (filter.schedule) { clauses.push('s.schedule_id = ?'); params.push(filter.schedule); }
    if (filter.created_after !== undefined) { clauses.push('s.created >= ?'); params.push(filter.created_after); }
    if (filter.created_before !== undefined) { clauses.push('s.created <= ?'); params.push(filter.created_before); }
    if (filter.price) {
      clauses.push('EXISTS (SELECT 1 FROM billing_subscription_items i WHERE i.subscription_id = s.id AND i.price_id = ?)');
      params.push(filter.price);
    }
    if (filter.query) {
      clauses.push(
        '(s.id = ? OR s.description LIKE ? ESCAPE \'\\\' OR EXISTS (SELECT 1 FROM billing_customers c WHERE c.id = s.customer_id AND (c.name LIKE ? ESCAPE \'\\\' OR c.email LIKE ? ESCAPE \'\\\')))',
      );
      const l = like(filter.query);
      params.push(filter.query, l, l, l);
    }
    const where = clauses.join(' AND ');
    const totalCount = this.ctx.db.count(`SELECT COUNT(*) FROM billing_subscriptions s WHERE ${where}`, ...(params as any[]));

    const paged = [...params];
    let cursorClause = '';
    if (filter.cursor) {
      const parsed = parseCursor(filter.cursor);
      if (!parsed) throw badRequest('cursor_invalid', 'That pagination cursor is not readable. Start the list again.', 'cursor');
      cursorClause = ' AND (s.created < ? OR (s.created = ? AND s.id < ?))';
      paged.push(parsed.createdAt, parsed.createdAt, parsed.id);
    }
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 200);
    const rows = this.ctx.db.all<any>(
      `SELECT s.* FROM billing_subscriptions s WHERE ${where}${cursorClause} ORDER BY s.created DESC, s.id DESC LIMIT ?`,
      ...(paged as any[]), limit + 1,
    );
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map((r) => hydrateSubscription(r, this.items(r.id)));
    const last = data[data.length - 1];
    return { data, hasMore, nextCursor: hasMore && last ? cursorOf(last.created, last.id) : null, totalCount };
  }

  /* ------------------------------ item resolution ------------------------- */

  /**
   * Turn the caller's `items` into the subscription's final item list.
   *
   * The rules, in the order they apply:
   *  - an entry naming an `id` updates (or, with `deleted`, removes) that item;
   *  - an entry with no `id` whose price is already on the subscription exactly
   *    once updates that item, so "set Growth to 14 seats" never silently
   *    creates a second Growth line;
   *  - anything else is added;
   *  - items the caller did not mention keep running untouched.
   */
  private resolveItems(current: SubscriptionItem[], inputs: SubscriptionItemInput[], book: Pricebook): ResolvedItem[] {
    const byId = new Map(current.map((i) => [i.id, i]));
    const byPrice = new Map<string, SubscriptionItem[]>();
    for (const item of current) byPrice.set(item.price, [...(byPrice.get(item.price) ?? []), item]);

    const removed = new Set<string>();
    const updates = new Map<string, Omit<ResolvedItem, 'id' | 'from'>>();
    const additions: Omit<ResolvedItem, 'id' | 'from'>[] = [];

    for (const input of inputs) {
      let target: SubscriptionItem | undefined;
      if (input.id) {
        target = byId.get(input.id);
        if (!target) throw notFound('subscription item', input.id);
      } else if (input.price) {
        // Only an item still standing after this call's own removals can be the
        // one being updated; otherwise "remove it, then add it back" would
        // silently collapse into a no-op.
        const matches = (byPrice.get(input.price) ?? []).filter((m) => !removed.has(m.id) && !updates.has(m.id));
        if (matches.length === 1) target = matches[0];
      }
      if (input.deleted) {
        if (!target) throw badRequest('item_not_found', 'Name the subscription item id you want to remove.', 'items');
        removed.add(target.id);
        continue;
      }
      const priceId = input.price ?? target?.price;
      if (!priceId) throw badRequest('item_price_required', 'Every subscription item needs a price.', 'items');
      const price = book.price(priceId);
      const quantity = input.quantity ?? target?.quantity ?? 1;
      const metadata = { ...(target?.metadata ?? {}), ...(input.metadata ?? {}) };
      const customUnitAmount = input.custom_unit_amount !== undefined
        ? input.custom_unit_amount
        : input.price && input.price !== target?.price ? null : target?.custom_unit_amount ?? null;
      if (target) updates.set(target.id, { price, quantity, customUnitAmount, metadata });
      else additions.push({ price, quantity, customUnitAmount, metadata });
    }

    const out: ResolvedItem[] = [];
    for (const item of current) {
      if (removed.has(item.id)) continue;
      const update = updates.get(item.id);
      out.push({
        id: item.id,
        price: update ? update.price : book.price(item.price),
        quantity: update ? update.quantity : item.quantity,
        customUnitAmount: update ? update.customUnitAmount : item.custom_unit_amount,
        metadata: update ? update.metadata : item.metadata,
        from: item,
      });
    }
    for (const add of additions) out.push({ ...add, id: null, from: null });

    this.assertItemSet(out);
    return out;
  }

  private assertItemSet(items: { price: Price; quantity: number; customUnitAmount?: number | null }[]): void {
    if (!items.length) {
      throw badRequest('subscription_requires_items', 'A subscription needs at least one item. Cancel it instead of emptying it.', 'items');
    }
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.price.id)) {
        throw badRequest(
          'duplicate_subscription_item',
          `Price ${item.price.id} appears twice. Change the quantity on the existing item instead of adding a second one.`,
          'items',
        );
      }
      seen.add(item.price.id);
      if (item.price.type === 'one_time') {
        throw badRequest(
          'one_time_price_on_subscription',
          `Price ${item.price.id} is a one-time price. Put it on an invoice; a subscription only carries recurring prices.`,
          'items',
        );
      }
      if (isMetered(item.price) && item.quantity !== 1) {
        throw badRequest(
          'metered_item_quantity',
          `Metered price ${item.price.id} bills on recorded usage, so its quantity is always 1.`,
          'items',
        );
      }
      assertFlatQuantity(item.price, item.quantity, 'items');
      const custom = item.customUnitAmount ?? null;
      if (item.price.model === 'custom' && custom === null) {
        throw badRequest(
          'custom_amount_required',
          `Price ${item.price.id} is negotiated. Supply custom_unit_amount (in minor units) — the agreed contract value for this account.`,
          'items',
        );
      }
      if (item.price.model !== 'custom' && custom !== null) {
        throw badRequest(
          'custom_amount_not_allowed',
          `Price ${item.price.id} has a published amount, so it cannot carry a negotiated custom_unit_amount.`,
          'items',
        );
      }
    }
    resolveInterval(items.map((i) => i.price));
  }

  /* -------------------------------- creation ------------------------------ */

  createSubscription(orgId: string, input: SubscriptionCreateInput, meta: WriteMeta = {}): Subscription {
    return this.ctx.atomic(() => {
      const book = this.book(orgId);
      const customer = this.requireCustomer(orgId, input.customer);
      const currency = (input.currency ?? customer.currency).toLowerCase();
      if (currency !== customer.currency) {
        throw badRequest(
          'currency_mismatch',
          `${customer.name} bills in ${customer.currency.toUpperCase()}, so this subscription cannot be in ${currency.toUpperCase()}.`,
          'currency',
        );
      }
      const resolved = input.items.map((i) => {
        if (!i.price) throw badRequest('item_price_required', 'Every subscription item needs a price.', 'items');
        return {
          id: null as string | null,
          price: book.price(i.price),
          quantity: i.quantity ?? 1,
          customUnitAmount: i.custom_unit_amount ?? null,
          metadata: i.metadata ?? {},
        };
      });
      this.assertItemSet(resolved);
      const { interval, interval_count } = resolveInterval(resolved.map((r) => r.price));
      // Every price must actually sell in this currency; ask now, not at renewal.
      for (const item of resolved) book.compute(item.price, item.quantity, currency, { customUnitAmount: item.customUnitAmount });

      const now = this.ctx.now();
      // A cancellation names a future instant. Stored in the past it is not a
      // cancellation but a contradiction: the `billing.cancel_at` job fires on
      // the next tick and ends a subscription that has already been invoiced
      // for a period it never served. The same guard runs on all three entry
      // points — create, PATCH and /cancel — so they cannot disagree about
      // what a valid `cancel_at` is.
      if (input.cancel_at !== undefined && input.cancel_at !== null && input.cancel_at <= now) {
        throw badRequest(
          'cancel_at_in_past',
          `cancel_at is ${new Date(input.cancel_at).toISOString()}, which has already passed. It names a future instant to end the subscription — to create one that has already ended, set backdate_start_date and then cancel it.`,
          'cancel_at',
        );
      }
      // `backdate_start_date` names when the subscription *already* began, so a
      // forward-dated one is not a late entry but a start that has not happened:
      // it would go active, count in MRR and raise an invoice today for a period
      // months away, and every proration measured against it would price a
      // period the customer has not entered. Refused rather than clamped.
      if (input.backdate_start_date !== undefined && input.backdate_start_date > now) {
        throw badRequest(
          'backdate_start_date_in_future',
          `backdate_start_date is ${new Date(input.backdate_start_date).toISOString()}, which is in the future. It records when a subscription already started, so it has to be in the past. To start one later, create a subscription schedule with that start_date, or set billing_cycle_anchor to move the first billing day.`,
          'backdate_start_date',
        );
      }
      const start = input.backdate_start_date ?? now;
      const trialEnd = resolveTrialEnd(input, resolved.map((r) => r.price), start);
      const iv: Interval = { unit: interval, count: interval_count };
      const { anchor, anchorDay } = resolveAnchor(input, iv, trialEnd, start);

      const trialing = trialEnd !== null && trialEnd > now;
      const period: Period = trialing
        ? { start, end: trialEnd as number }
        : clampFirstPeriod(periodAt(anchor, iv, start, anchorDay), start);

      const status: SubscriptionStatus = trialing
        ? 'trialing'
        : input.payment_behavior === 'default_incomplete' ? 'incomplete' : 'active';

      const id = input.id ?? newId('sub');
      this.ctx.db.insert('billing_subscriptions', {
        id, org_id: orgId, customer_id: customer.id, status, currency,
        interval, interval_count,
        billing_cycle_anchor: anchor, billing_cycle_anchor_day: anchorDay,
        current_period_start: period.start, current_period_end: period.end,
        start_date: start,
        ended_at: null, canceled_at: null,
        cancel_at: input.cancel_at ?? null,
        cancel_at_period_end: input.cancel_at_period_end ? 1 : 0,
        cancellation_reason: null, cancellation_comment: null,
        trial_start: trialEnd !== null ? start : null,
        trial_end: trialEnd,
        trial_from_plan: input.trial_from_plan ? 1 : 0,
        trial_settings: { end_behavior: { missing_payment_method: input.trial_settings?.end_behavior?.missing_payment_method ?? 'create_invoice' } },
        collection_method: input.collection_method ?? 'charge_automatically',
        days_until_due: input.days_until_due ?? (input.collection_method === 'send_invoice' ? customer.invoice_settings.days_until_due ?? 30 : null),
        default_payment_method: input.default_payment_method ?? null,
        pause_collection: null,
        proration_behavior: input.proration_behavior ?? 'create_prorations',
        schedule_id: input.schedule ?? null,
        description: input.description ?? null,
        metadata: input.metadata ?? {},
        created: start, updated: now,
        livemode: meta.livemode === false ? 0 : 1,
      } as any);

      resolved.forEach((item, index) => {
        this.insertItem(orgId, id, item, index, start);
        this.ctx.svc.catalog.registerUsage(orgId, item.price.id, { type: 'subscription', id });
      });

      this.lockCurrency(orgId, customer.id);
      const sub = this.requireSubscription(orgId, id);

      const fraction = trialing ? null : periodFraction(period, iv, anchorDay);
      this.recordPeriod(orgId, sub, period, trialing ? 'trial' : 'billed', book, fraction, { createdAt: start });

      this.ctx.emit(orgId, 'subscription.created', sub, {
        objectId: id, objectType: 'subscription', actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      if (trialing) {
        this.ctx.emit(orgId, 'subscription.trial_started', { subscription: id, customer: customer.id, trial_end: trialEnd }, {
          objectId: id, objectType: 'subscription',
        });
      } else {
        this.requestInvoice(orgId, sub, {
          reason: 'subscription_create',
          period,
          arrearsPeriod: null,
          fraction,
          book,
          immediate: true,
          // The bill is dated when the charge was incurred, not when the row
          // was written: a subscription backdated to last month was billed
          // last month, and its terms have been running since.
          createdAt: period.start,
          meta,
        });
      }
      this.scheduleLifecycleJobs(orgId, sub);
      return sub;
    });
  }

  private insertItem(
    orgId: string, subscriptionId: string,
    item: { price: Price; quantity: number; customUnitAmount?: number | null; metadata: Record<string, string> },
    position: number, createdAt: number,
  ): SubscriptionItem {
    const id = newId('subitem');
    this.ctx.db.insert('billing_subscription_items', {
      id, org_id: orgId, subscription_id: subscriptionId, price_id: item.price.id,
      quantity: item.quantity, metered: isMetered(item.price) ? 1 : 0,
      custom_unit_amount: item.customUnitAmount ?? null,
      metadata: item.metadata, position,
      created: createdAt, updated: createdAt,
    } as any);
    return hydrateItem(this.ctx.db.get<any>(`SELECT * FROM billing_subscription_items WHERE id = ?`, id));
  }

  /* --------------------------------- change ------------------------------- */

  /**
   * The preview and the update run the same arithmetic: both build the change
   * with `describeChange` and hand the identical inputs to `previewChange`.
   */
  private describeChange(orgId: string, sub: Subscription, input: SubscriptionUpdateInput) {
    const book = this.book(orgId);
    const customer = this.requireCustomer(orgId, sub.customer);
    const now = this.ctx.now();

    // A proration date outside the period would silently price against a period
    // the customer never held, so it is refused rather than clamped.
    const prorationDate = input.proration_date ?? Math.min(Math.max(now, sub.current_period_start), sub.current_period_end);
    if (prorationDate < sub.current_period_start || prorationDate > sub.current_period_end) {
      throw badRequest(
        'proration_date_out_of_range',
        `proration_date must fall inside the current period, ${new Date(sub.current_period_start).toISOString()} to ${new Date(sub.current_period_end).toISOString()}.`,
        'proration_date',
      );
    }
    const behavior = input.proration_behavior ?? sub.proration_behavior;

    const resolved: ResolvedItem[] = input.items
      ? this.resolveItems(sub.items, input.items, book)
      : sub.items.map((item) => ({
          id: item.id, price: book.price(item.price), quantity: item.quantity,
          customUnitAmount: item.custom_unit_amount, metadata: item.metadata, from: item,
        }));

    // The cadence belongs to the prices, not to the row. Swapping the monthly
    // Growth fee for the annual one is a change of cycle, and a cycle cannot
    // change without re-anchoring: an annual price on a monthly period bills
    // twelve times a year. So the anchor moves to the change instant, the old
    // period is credited back and the new cadence starts here.
    const cadenceBefore: Cadence = { interval: sub.interval, interval_count: sub.interval_count };
    const cadenceAfter: Cadence = resolveInterval(resolved.map((item) => item.price));
    const cadenceMoved = !sameCadence(cadenceBefore, cadenceAfter);
    if (cadenceMoved && input.billing_cycle_anchor === 'unchanged') {
      throw badRequest(
        'subscription_interval_change',
        `Subscription ${sub.id} bills every ${describeCadence(cadenceBefore)} but the requested items bill every ${describeCadence(cadenceAfter)}. A cadence cannot change while the cycle stays where it is — leave billing_cycle_anchor out, or send billing_cycle_anchor=now, and the cycle restarts on the new interval.`,
        'billing_cycle_anchor',
      );
    }
    const iv = intervalOf(cadenceAfter);

    const currentPeriod: Period = { start: sub.current_period_start, end: sub.current_period_end };
    // A trial is free time that runs to a date the customer was promised, so a
    // cadence change inside one moves the cadence without moving the trial: the
    // new cycle starts where the free time was always going to end.
    const inTrial = sub.status === 'trialing' && sub.trial_end !== null && prorationDate < sub.trial_end;
    const anchorReset = input.billing_cycle_anchor === 'now' || (cadenceMoved && !inTrial);
    const anchorDay = anchorReset ? anchorDayOf(prorationDate) : sub.billing_cycle_anchor_day;
    const nextPeriod: Period = anchorReset
      ? { start: prorationDate, end: addInterval(prorationDate, iv, anchorDay) }
      : currentPeriod;

    const before: ItemState[] = sub.items.map((item) => ({
      id: item.id, price: book.price(item.price), quantity: item.quantity, customUnitAmount: item.custom_unit_amount,
    }));
    const after: ItemState[] = resolved.map((item) => ({
      id: item.id, price: item.price, quantity: item.quantity, customUnitAmount: item.customUnitAmount,
    }));

    // Items as they will exist, carrying the ids they will keep so the preview's
    // next invoice is line-for-line what the next invoice will be.
    const itemsAfter: PricedItem[] = resolved.map((item) => ({
      id: item.from?.id ?? null,
      price: item.price.id,
      quantity: item.quantity,
      custom_unit_amount: item.customUnitAmount ?? null,
    }));

    const subAfter = { ...sub, ...cadenceAfter, items: itemsAfter, billing_cycle_anchor_day: anchorDay };
    const preview = previewChange({
      subscriptionId: sub.id,
      customerId: customer.id,
      customerBalance: customer.balance,
      currency: sub.currency,
      locale: this.locale(orgId),
      status: sub.status,
      currentPeriod,
      nextPeriod,
      // The period being left belongs to the cadence the subscription holds
      // today, whatever cadence the new items bill on.
      interval: intervalOf(cadenceBefore),
      anchorDay: sub.billing_cycle_anchor_day,
      before,
      after,
      prorationDate,
      behavior,
      book,
      trialEnd: sub.trial_end,
      itemsAfter,
      mrrBefore: subscriptionMrr(sub, book),
      mrrAfter: subscriptionMrr(subAfter, book),
      nextInvoiceDate: anchorReset ? nextPeriod.end : sub.current_period_end,
      intervalBefore: cadenceBefore,
      intervalAfter: cadenceAfter,
      // The same call `issue()` makes, on the same customer. A preview that
      // priced its lines any other way would be a second implementation that
      // happens to agree today.
      taxOf: (lines) => this.invoices.taxTotals(orgId, customer, lines),
      automaticTax: this.automaticTaxFor(orgId, customer),
    });

    return {
      book, customer, resolved, preview, behavior, prorationDate,
      anchorReset, anchorDay, nextPeriod, iv, cadenceAfter, cadenceMoved,
    };
  }

  previewSubscriptionChange(orgId: string, id: string, input: SubscriptionUpdateInput): ChangePreview {
    const sub = this.requireSubscription(orgId, id);
    return this.describeChange(orgId, sub, input).preview;
  }

  updateSubscription(
    orgId: string, id: string, input: SubscriptionUpdateInput, meta: WriteMeta = {},
  ): { subscription: Subscription; preview: ChangePreview } {
    return this.ctx.atomic(() => {
      const sub = this.requireSubscription(orgId, id);
      if (isTerminal(sub.status)) {
        throw conflict('subscription_ended', `Subscription ${id} is ${sub.status} and can no longer be changed.`, { status: sub.status });
      }
      const change = this.describeChange(orgId, sub, input);
      const { book, preview, behavior, prorationDate } = change;
      const now = this.ctx.now();
      const previous: Record<string, unknown> = {};

      /* items ---------------------------------------------------------- */
      if (input.items) {
        const keep = new Set<string>();
        change.resolved.forEach((item, index) => {
          if (item.from) {
            keep.add(item.from.id);
            const moved = item.from.price !== item.price.id
              || item.from.quantity !== item.quantity
              || (item.from.custom_unit_amount ?? null) !== (item.customUnitAmount ?? null)
              || JSON.stringify(item.from.metadata) !== JSON.stringify(item.metadata);
            if (moved) {
              if (item.from.price !== item.price.id) {
                this.ctx.svc.catalog.releaseUsage(orgId, item.from.price, { type: 'subscription', id });
                this.ctx.svc.catalog.registerUsage(orgId, item.price.id, { type: 'subscription', id });
              }
              this.ctx.db.patch('billing_subscription_items', 'id', item.from.id, {
                price_id: item.price.id, quantity: item.quantity, metered: isMetered(item.price) ? 1 : 0,
                custom_unit_amount: item.customUnitAmount ?? null,
                metadata: item.metadata as any, position: index, updated: now,
              });
            } else {
              this.ctx.db.patch('billing_subscription_items', 'id', item.from.id, { position: index });
            }
          } else {
            const inserted = this.insertItem(orgId, id, item, index, now);
            keep.add(inserted.id);
            this.ctx.svc.catalog.registerUsage(orgId, item.price.id, { type: 'subscription', id });
          }
        });
        for (const item of sub.items) {
          if (keep.has(item.id)) continue;
          this.ctx.db.run(`DELETE FROM billing_subscription_items WHERE id = ? AND org_id = ?`, item.id, orgId);
          this.ctx.svc.catalog.releaseUsage(orgId, item.price, { type: 'subscription', id });
        }
        previous.items = sub.items;
      }

      /* scalar fields --------------------------------------------------- */
      const changes: Record<string, unknown> = { updated: now };
      const setIf = <K extends keyof Subscription>(key: K, column: string, value: Subscription[K] | undefined, stored?: unknown) => {
        if (value === undefined) return;
        if (sub[key] === value) return;
        previous[key as string] = sub[key];
        changes[column] = stored === undefined ? (value as unknown) : stored;
      };
      setIf('cancel_at_period_end', 'cancel_at_period_end', input.cancel_at_period_end,
        input.cancel_at_period_end === undefined ? undefined : input.cancel_at_period_end ? 1 : 0);
      // A cancellation is a future event. Storing one in the past stamps an
      // `ended_at` before the subscription existed the moment the job runs, and
      // every churn report that buckets by that date inherits the lie.
      if (input.cancel_at !== undefined && input.cancel_at !== null && input.cancel_at <= now) {
        throw badRequest(
          'cancel_at_in_past',
          `cancel_at is ${new Date(input.cancel_at).toISOString()}, which has already passed. It names a future instant to end the subscription — to end it now, DELETE /v1/subscriptions/${id} or POST /v1/subscriptions/${id}/cancel.`,
          'cancel_at',
        );
      }
      setIf('cancel_at', 'cancel_at', input.cancel_at);
      setIf('collection_method', 'collection_method', input.collection_method);
      setIf('days_until_due', 'days_until_due', input.days_until_due);
      setIf('default_payment_method', 'default_payment_method', input.default_payment_method);
      setIf('description', 'description', input.description);
      if (input.metadata) { previous.metadata = sub.metadata; changes.metadata = { ...sub.metadata, ...input.metadata }; }
      if (input.cancel_at_period_end === false && sub.cancel_at_period_end) {
        changes.cancellation_reason = null;
        changes.cancellation_comment = null;
      }

      // Whenever the cycle is rebased the ledger has to be rebased with it,
      // or the periods a subscription has entered stop matching the periods it
      // actually holds.
      let rebased: Period | null = null;
      if (change.anchorReset) {
        previous.billing_cycle_anchor = sub.billing_cycle_anchor;
        previous.current_period_start = sub.current_period_start;
        previous.current_period_end = sub.current_period_end;
        changes.billing_cycle_anchor = prorationDate;
        changes.billing_cycle_anchor_day = change.anchorDay;
        changes.current_period_start = change.nextPeriod.start;
        changes.current_period_end = change.nextPeriod.end;
        rebased = change.nextPeriod;
      }
      if (change.cadenceMoved) {
        previous.interval = sub.interval;
        previous.interval_count = sub.interval_count;
        changes.interval = change.cadenceAfter.interval;
        changes.interval_count = change.cadenceAfter.interval_count;
      }

      /* trial end ------------------------------------------------------- */
      if (input.trial_end !== undefined) {
        if (sub.status !== 'trialing') {
          throw conflict(
            'subscription_not_trialing',
            `Subscription ${id} is ${sub.status}, so there is no trial to move. Free time on a running subscription is a credit, not a trial.`,
            { status: sub.status },
          );
        }
        const target = input.trial_end === 'now' ? now : input.trial_end;
        previous.trial_end = sub.trial_end;
        changes.trial_end = target;
        if (target <= now) {
          // Ending a trial early starts the first paid period here, so the
          // cycle is re-anchored here too. Deriving the period end from the old
          // anchor day while storing the new one is what turns "start billing
          // me now" into a forty-five day month at one month's price.
          const day = anchorDayOf(target);
          const first: Period = { start: target, end: addInterval(target, change.iv, day) };
          changes.current_period_start = first.start;
          changes.current_period_end = first.end;
          changes.billing_cycle_anchor = target;
          changes.billing_cycle_anchor_day = day;
          rebased = first;
        } else {
          changes.current_period_end = target;
        }
      }

      this.ctx.db.patch('billing_subscriptions', 'id', id, changes as any);

      /* settle the prorations ------------------------------------------ */
      const settlement = this.settle(orgId, sub, preview.lines, behavior, meta);
      const after = this.requireSubscription(orgId, id);

      if (input.trial_end !== undefined && sub.status === 'trialing' && after.trial_end !== null && after.trial_end <= now) {
        this.transition(orgId, after, 'active', { meta });
      }
      if (rebased) this.rebaseLedger(orgId, sub, rebased, preview.credit_total, book);

      const updated = this.requireSubscription(orgId, id);
      if (Object.keys(previous).length || preview.lines.length) {
        this.ctx.emit(orgId, 'subscription.updated', updated, {
          objectId: id, objectType: 'subscription', previous,
          actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
        });
      }
      if (preview.lines.length) {
        this.ctx.emit(orgId, 'subscription.prorated', {
          subscription: id, customer: updated.customer, currency: updated.currency,
          proration_date: prorationDate, proration_behavior: behavior,
          credit_total: preview.credit_total, charge_total: preview.charge_total, net: preview.net,
          pending_item_ids: settlement.pendingIds, lines: preview.lines,
        }, { objectId: id, objectType: 'subscription' });
      }
      // `always_invoice` means what it says whichever way the set nets. A
      // credit invoiced now is a document with the tax on it; a credit left to
      // the balance is a number with the tax silently kept.
      if (behavior === 'always_invoice' && settlement.pendingIds.length) {
        this.requestInvoice(orgId, updated, {
          reason: 'subscription_update',
          period: change.nextPeriod,
          arrearsPeriod: null,
          fraction: null,
          book,
          immediate: true,
          pendingItemIds: settlement.pendingIds,
          recurring: false,
          meta,
        });
      }
      if (change.anchorReset || input.trial_end !== undefined) this.scheduleLifecycleJobs(orgId, updated);
      if (input.cancel_at !== undefined) this.scheduleLifecycleJobs(orgId, updated);

      return { subscription: updated, preview };
    });
  }

  /**
   * Move the period ledger onto a rebased cycle.
   *
   * The period being left is closed at the instant the change lands and reduced
   * by exactly the credit that change handed back, so the ledger and the
   * proration lines tell one story: what the customer keeps for the days they
   * held plus what was credited is what they were originally charged. The
   * period being entered is then recorded in full. When the change lands
   * exactly on a period start those are the same row, and the upsert replaces
   * it rather than leaving a zero-length ghost behind.
   */
  private rebaseLedger(orgId: string, before: Subscription, period: Period, creditTotal: number, book: Pricebook): void {
    const closing = this.ctx.db.get<any>(
      `SELECT * FROM billing_subscription_periods WHERE org_id = ? AND subscription_id = ? AND period_start = ?`,
      orgId, before.id, before.current_period_start,
    );
    if (closing && Number(closing.period_end) > period.start && closing.status !== 'canceled') {
      this.ctx.db.patch('billing_subscription_periods', 'id', closing.id, {
        period_end: period.start,
        amount: Math.max(0, Number(closing.amount) + creditTotal),
      });
    }
    const sub = this.requireSubscription(orgId, before.id);
    const status: PeriodStatus = sub.status === 'trialing' ? 'trial' : sub.status === 'paused' ? 'paused' : 'billed';
    this.recordPeriod(orgId, sub, period, status, book, null);
  }

  /**
   * Write the proration lines somewhere they can be collected.
   *
   * Every line waits as a pending invoice item, whichever way the set nets.
   * That is the whole point: a credit is a line on a bill, so the rate engine
   * taxes it exactly as it taxed the charge it reverses, and $25.00 of unused
   * time on a 19% account hands back $29.75. Routing a negative net onto the
   * customer balance instead — which is what this did — kept the tax on
   * service that was never supplied, and made the tax outcome depend on the
   * sign of the net rather than on the supply.
   *
   * The balance is still the right home for what an invoice cannot carry, but
   * that is decided by `Invoices.issue()` after tax, on the residue, not here.
   */
  private settle(
    orgId: string, sub: Subscription, lines: ProrationLine[], behavior: ProrationBehavior, meta: WriteMeta,
  ): { pendingIds: string[] } {
    if (behavior === 'none' || !lines.length) return { pendingIds: [] };
    const now = this.ctx.now();
    const ids: string[] = [];
    for (const line of lines) {
      const id = newId('invoiceitem');
      ids.push(id);
      this.ctx.db.insert('billing_pending_items', {
        id, org_id: orgId, customer_id: sub.customer, subscription_id: sub.id,
        subscription_item_id: line.subscription_item, price_id: line.price, quantity: line.quantity,
        amount: line.amount, currency: line.currency, description: line.description, explanation: line.explanation,
        kind: line.kind, period_start: line.period.start, period_end: line.period.end,
        proration_numerator: line.proration.numerator, proration_denominator: line.proration.denominator,
        proration_date: line.proration_date, breakdown: line.breakdown as any,
        status: 'pending', invoice_id: null, created: now,
      } as any);
    }
    void meta;
    return { pendingIds: ids };
  }

  /* ------------------------------- transitions ---------------------------- */

  transition(
    orgId: string, sub: Subscription, to: SubscriptionStatus,
    opts: { reason?: CancellationReason; comment?: string | null; endedAt?: number; meta?: WriteMeta } = {},
  ): Subscription {
    assertTransition(sub.id, sub.status, to);
    if (sub.status === to) return sub;
    const now = this.ctx.now();
    const changes: Record<string, unknown> = { status: to, updated: now };
    if (to === 'canceled') {
      changes.canceled_at = sub.canceled_at ?? now;
      // A subscription cannot end before it began. Create, PATCH and /cancel
      // all refuse a past `cancel_at`, so nothing should reach here needing the
      // clamp; it is defence in depth, not the guard itself, and it keeps every
      // terminal row reportable if a future caller ever forgets one.
      changes.ended_at = Math.max(opts.endedAt ?? now, sub.start_date);
      if (opts.reason) changes.cancellation_reason = opts.reason;
      if (opts.comment !== undefined) changes.cancellation_comment = opts.comment;
    }
    if (to === 'active') changes.pause_collection = null;
    this.ctx.db.patch('billing_subscriptions', 'id', sub.id, changes as any);
    const after = this.requireSubscription(orgId, sub.id);
    this.refreshDelinquency(orgId, after.customer);

    const meta = opts.meta ?? {};
    this.ctx.emit(orgId, transitionEvent(to), after, {
      objectId: after.id, objectType: 'subscription', previous: { status: sub.status },
      actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
    });
    this.ctx.emit(orgId, 'subscription.updated', after, {
      objectId: after.id, objectType: 'subscription', previous: { status: sub.status },
      actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
    });
    return after;
  }

  /** Delinquent means "at least one live subscription is not being collected". */
  private refreshDelinquency(orgId: string, customerId: string): void {
    const bad = this.ctx.db.count(
      `SELECT COUNT(*) FROM billing_subscriptions WHERE org_id = ? AND customer_id = ? AND status IN ('past_due','unpaid')`,
      orgId, customerId,
    );
    const customer = this.customer(orgId, customerId);
    if (!customer) return;
    const delinquent = bad > 0;
    if (customer.delinquent === delinquent) return;
    this.ctx.db.patch('billing_customers', 'id', customerId, { delinquent: delinquent ? 1 : 0, updated: this.ctx.now() });
    this.ctx.emit(orgId, delinquent ? 'customer.marked_delinquent' : 'customer.cleared_delinquent',
      { customer: customerId, subscriptions_in_arrears: bad },
      { objectId: customerId, objectType: 'customer', previous: { delinquent: customer.delinquent } });
  }

  /* --------------------------------- cancel ------------------------------- */

  cancelSubscription(orgId: string, id: string, input: CancelInput = {}, meta: WriteMeta = {}): Subscription {
    return this.ctx.atomic(() => {
      const sub = this.requireSubscription(orgId, id);
      if (isTerminal(sub.status)) {
        throw conflict('subscription_ended', `Subscription ${id} is already ${sub.status}.`, { status: sub.status });
      }
      const now = this.ctx.now();

      if (input.cancel_at !== undefined && input.cancel_at !== null) {
        if (input.cancel_at <= now) throw badRequest('cancel_at_in_past', 'cancel_at must be in the future. Cancel immediately instead.', 'cancel_at');
        this.ctx.db.patch('billing_subscriptions', 'id', id, {
          cancel_at: input.cancel_at, cancel_at_period_end: 0,
          cancellation_reason: input.cancellation_reason ?? 'cancellation_requested',
          cancellation_comment: input.comment ?? null, updated: now,
        });
        const scheduled = this.requireSubscription(orgId, id);
        this.scheduleLifecycleJobs(orgId, scheduled);
        this.ctx.emit(orgId, 'subscription.cancellation_scheduled', scheduled, {
          objectId: id, objectType: 'subscription', previous: { cancel_at: sub.cancel_at },
          actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
        });
        return scheduled;
      }

      if (input.at_period_end) {
        this.ctx.db.patch('billing_subscriptions', 'id', id, {
          cancel_at_period_end: 1,
          cancellation_reason: input.cancellation_reason ?? 'cancellation_requested',
          cancellation_comment: input.comment ?? null, updated: now,
        });
        const scheduled = this.requireSubscription(orgId, id);
        this.scheduleLifecycleJobs(orgId, scheduled);
        this.ctx.emit(orgId, 'subscription.cancellation_scheduled', scheduled, {
          objectId: id, objectType: 'subscription', previous: { cancel_at_period_end: sub.cancel_at_period_end },
          actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
        });
        return scheduled;
      }

      return this.endNow(orgId, sub, {
        at: now,
        reason: input.cancellation_reason ?? 'cancellation_requested',
        comment: input.comment ?? null,
        prorate: input.prorate ?? false,
        meta,
      });
    });
  }

  /** Cancel right now, optionally giving back the unused remainder of the period. */
  endNow(
    orgId: string, sub: Subscription,
    opts: { at: number; reason: CancellationReason; comment?: string | null; prorate?: boolean; meta?: WriteMeta },
  ): Subscription {
    const book = this.book(orgId);
    const meta = opts.meta ?? {};
    if (opts.prorate && sub.status !== 'trialing') {
      const set = prorate({
        subscriptionId: sub.id,
        currency: sub.currency,
        locale: this.locale(orgId),
        status: sub.status,
        currentPeriod: { start: sub.current_period_start, end: sub.current_period_end },
        nextPeriod: { start: sub.current_period_start, end: sub.current_period_end },
        interval: intervalOf(sub),
        anchorDay: sub.billing_cycle_anchor_day,
        before: sub.items.map((item) => ({
          id: item.id, price: book.price(item.price), quantity: item.quantity, customUnitAmount: item.custom_unit_amount,
        })),
        after: [],
        prorationDate: opts.at,
        behavior: 'create_prorations',
        book,
        trialEnd: sub.trial_end,
      });
      this.settleCancellation(orgId, sub, set, book, meta);
    }
    this.ctx.db.run(
      `UPDATE billing_subscription_periods SET status = 'canceled' WHERE org_id = ? AND subscription_id = ? AND period_end > ?`,
      orgId, sub.id, opts.at,
    );
    for (const item of sub.items) this.ctx.svc.catalog.releaseUsage(orgId, item.price, { type: 'subscription', id: sub.id });
    const canceled = this.transition(orgId, sub, 'canceled', { reason: opts.reason, comment: opts.comment ?? null, endedAt: opts.at, meta });
    this.cancelJobs(orgId, sub.id);
    return canceled;
  }

  /**
   * Hand back the unused remainder of a period on the way out.
   *
   * The lines are written and invoiced on the spot rather than left waiting,
   * because a cancelled subscription has no next cycle to sweep them up. Going
   * through a real bill is also the only way the credit carries its tax: the
   * final invoice is a document with `unused time -$25.00` and `VAT -$4.75` on
   * it, and its value lands on the account balance because a bill can never go
   * below zero. A bare balance adjustment would have handed back the net and
   * kept the tax on service that was never supplied.
   */
  private settleCancellation(
    orgId: string, sub: Subscription, set: ProrationSet, book: Pricebook, meta: WriteMeta,
  ): void {
    if (!set.lines.length) return;
    const now = this.ctx.now();
    const ids: string[] = [];
    for (const line of set.lines) {
      const id = newId('invoiceitem');
      ids.push(id);
      this.ctx.db.insert('billing_pending_items', {
        id, org_id: orgId, customer_id: sub.customer, subscription_id: sub.id,
        subscription_item_id: line.subscription_item, price_id: line.price, quantity: line.quantity,
        amount: line.amount, currency: line.currency, description: line.description, explanation: line.explanation,
        kind: line.kind, period_start: line.period.start, period_end: line.period.end,
        proration_numerator: line.proration.numerator, proration_denominator: line.proration.denominator,
        proration_date: line.proration_date, breakdown: line.breakdown as any,
        status: 'pending', invoice_id: null, created: now,
      } as any);
    }
    this.requestInvoice(orgId, sub, {
      reason: 'subscription_update',
      period: { start: sub.current_period_start, end: sub.current_period_end },
      arrearsPeriod: null,
      fraction: null,
      book,
      immediate: true,
      pendingItemIds: ids,
      recurring: false,
      meta,
    });
  }

  /* ------------------------------ pause / resume -------------------------- */

  pauseSubscription(
    orgId: string, id: string, input: { behavior: PauseBehavior; resumes_at?: number | null }, meta: WriteMeta = {},
  ): Subscription {
    return this.ctx.atomic(() => {
      const sub = this.requireSubscription(orgId, id);
      const now = this.ctx.now();
      if (input.resumes_at !== undefined && input.resumes_at !== null && input.resumes_at <= now) {
        throw badRequest('resumes_at_in_past', 'resumes_at must be in the future.', 'resumes_at');
      }
      this.ctx.db.patch('billing_subscriptions', 'id', id, {
        pause_collection: { behavior: input.behavior, resumes_at: input.resumes_at ?? null } as any,
        updated: now,
      });
      const paused = this.transition(orgId, this.requireSubscription(orgId, id), 'paused', { meta });
      this.scheduleLifecycleJobs(orgId, paused);
      return paused;
    });
  }

  resumeSubscription(
    orgId: string, id: string, input: { billing_cycle_anchor?: 'now' | 'unchanged'; proration_behavior?: ProrationBehavior } = {}, meta: WriteMeta = {},
  ): Subscription {
    return this.ctx.atomic(() => {
      const sub = this.requireSubscription(orgId, id);
      if (sub.status !== 'paused') {
        throw conflict('subscription_not_paused', `Subscription ${id} is ${sub.status}, not paused. Nothing to resume.`, { status: sub.status });
      }
      const now = this.ctx.now();
      this.ctx.db.patch('billing_subscriptions', 'id', id, { pause_collection: null, updated: now });
      const target: SubscriptionStatus = sub.trial_end !== null && sub.trial_end > now ? 'trialing' : 'active';
      let resumed = this.transition(orgId, this.requireSubscription(orgId, id), target, { meta });
      if (input.billing_cycle_anchor === 'now') {
        resumed = this.updateSubscription(orgId, id, {
          billing_cycle_anchor: 'now',
          proration_behavior: input.proration_behavior ?? 'none',
        }, meta).subscription;
      }
      this.ctx.emit(orgId, 'subscription.resumed', resumed, {
        objectId: id, objectType: 'subscription', previous: { status: 'paused', pause_collection: sub.pause_collection },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      this.scheduleLifecycleJobs(orgId, resumed);
      return resumed;
    });
  }

  /* --------------------------------- renewal ------------------------------ */

  /**
   * The renewal job. It is idempotent by construction: a job that names a
   * period end the subscription has already moved past does nothing, so a
   * retry, a duplicate enqueue or a replayed clock can never bill twice.
   */
  renew(orgId: string, subscriptionId: string, expectedPeriodEnd: number): void {
    this.ctx.atomic(() => {
      const sub = this.subscription(orgId, subscriptionId);
      if (!sub || isTerminal(sub.status)) return;
      if (sub.current_period_end !== expectedPeriodEnd) return;
      const now = this.ctx.now();
      const book = this.book(orgId);
      const iv = intervalOf(sub);

      if (sub.cancel_at_period_end) {
        this.endNow(orgId, sub, {
          at: sub.current_period_end,
          reason: sub.cancellation_reason ?? 'cancellation_requested',
          comment: sub.cancellation_comment,
        });
        return;
      }

      let current = sub;
      if (sub.status === 'trialing') {
        this.ctx.emit(orgId, 'subscription.trial_ended', {
          subscription: sub.id, customer: sub.customer, trial_start: sub.trial_start, trial_end: sub.trial_end,
        }, { objectId: sub.id, objectType: 'subscription' });

        const customer = this.requireCustomer(orgId, sub.customer);
        const payable = sub.collection_method === 'send_invoice'
          || !!(sub.default_payment_method ?? customer.invoice_settings.default_payment_method);
        const behavior = sub.trial_settings.end_behavior.missing_payment_method;
        if (!payable && behavior === 'cancel') {
          this.endNow(orgId, sub, { at: now, reason: 'trial_ended_without_payment_method' });
          return;
        }
        if (!payable && behavior === 'pause') {
          this.ctx.db.patch('billing_subscriptions', 'id', sub.id, {
            pause_collection: { behavior: 'keep_as_draft', resumes_at: null } as any, updated: now,
          });
          current = this.transition(orgId, this.requireSubscription(orgId, sub.id), 'paused', {});
        } else {
          current = this.transition(orgId, sub, 'active', {});
        }
      }

      const closed: Period = { start: current.current_period_start, end: current.current_period_end };
      const start = current.current_period_end;
      // The next period runs to the next boundary of the *cycle*, which is not
      // always one whole interval away: a trial that ends on the 6th of a
      // subscription anchored on the 23rd leaves seventeen days before the
      // account's billing day, and those seventeen days are what is billed.
      const { end } = clampFirstPeriod(
        periodAt(current.billing_cycle_anchor, iv, start, current.billing_cycle_anchor_day), start,
      );
      this.ctx.db.patch('billing_subscriptions', 'id', current.id, {
        current_period_start: start, current_period_end: end, updated: now,
      });
      let renewed = this.requireSubscription(orgId, current.id);
      // Ask the schedule first: if a phase ends exactly here, the new phase's
      // items are the ones this period bills for.
      if (this.onPeriodBoundary) renewed = this.onPeriodBoundary(orgId, renewed, start);
      if (isTerminal(renewed.status)) return;

      // A schedule phase may have moved the cycle — onto a longer interval, or
      // onto a different anchor — so the period to bill is the one the
      // subscription now holds, not the one computed before the phase applied.
      const nextPeriod: Period = { start: renewed.current_period_start, end: renewed.current_period_end };
      const status: PeriodStatus = renewed.status === 'paused' ? 'paused' : 'billed';
      // A period shorter than its own interval — the stub between a trial
      // ending and the account's billing day — is charged for what it covers.
      const fraction = periodFraction(nextPeriod, intervalOf(renewed), renewed.billing_cycle_anchor_day);
      this.recordPeriod(orgId, renewed, nextPeriod, status, book, fraction);

      this.requestInvoice(orgId, renewed, {
        reason: 'subscription_cycle',
        period: nextPeriod,
        arrearsPeriod: closed,
        fraction,
        book,
        immediate: true,
        // A renewal job that runs late still bills for the cycle boundary it
        // was aimed at, so net terms run from the boundary rather than from
        // whenever the queue got to it.
        createdAt: nextPeriod.start,
      });
      this.ctx.emit(orgId, 'subscription.renewed', {
        subscription: renewed.id, customer: renewed.customer, status: renewed.status,
        previous_period: closed, current_period: nextPeriod,
      }, { objectId: renewed.id, objectType: 'subscription', previous: { current_period_start: closed.start, current_period_end: closed.end } });

      this.scheduleLifecycleJobs(orgId, renewed);
    });
  }

  /* ---------------------------------- jobs -------------------------------- */

  /**
   * Every deferred consequence of a subscription's current shape, re-derived
   * from that shape. Enqueueing is idempotent on the key, so calling this after
   * any change leaves exactly one renewal, one cancellation and one resume.
   */
  scheduleLifecycleJobs(orgId: string, sub: Subscription): void {
    if (isTerminal(sub.status)) { this.cancelJobs(orgId, sub.id); return; }

    this.ctx.enqueue(orgId, 'billing.renew', { subscription: sub.id, period_end: sub.current_period_end }, {
      runAt: sub.current_period_end, idemKey: `billing.renew:${sub.id}`,
    });

    if (sub.cancel_at) {
      this.ctx.enqueue(orgId, 'billing.cancel_at', { subscription: sub.id, cancel_at: sub.cancel_at }, {
        runAt: sub.cancel_at, idemKey: `billing.cancel_at:${sub.id}`,
      });
    } else {
      this.ctx.jobs.cancel(orgId, { idemKey: `billing.cancel_at:${sub.id}` }, this.ctx.now());
    }

    const resumesAt = sub.pause_collection?.resumes_at ?? null;
    if (resumesAt) {
      this.ctx.enqueue(orgId, 'billing.resume', { subscription: sub.id }, {
        runAt: resumesAt, idemKey: `billing.resume:${sub.id}`,
      });
    } else {
      this.ctx.jobs.cancel(orgId, { idemKey: `billing.resume:${sub.id}` }, this.ctx.now());
    }

    if (sub.status === 'trialing' && sub.trial_end) {
      const warnAt = sub.trial_end - 3 * DAY;
      if (warnAt > this.ctx.now()) {
        this.ctx.enqueue(orgId, 'billing.trial_will_end', { subscription: sub.id, trial_end: sub.trial_end }, {
          runAt: warnAt, idemKey: `billing.trial_will_end:${sub.id}`,
        });
      }
    }
    if (sub.status === 'incomplete') {
      this.ctx.enqueue(orgId, 'billing.incomplete_expire', { subscription: sub.id }, {
        runAt: sub.created + 23 * HOUR, idemKey: `billing.incomplete_expire:${sub.id}`,
      });
    }
  }

  cancelJobs(orgId: string, subscriptionId: string): void {
    const now = this.ctx.now();
    for (const key of ['renew', 'cancel_at', 'resume', 'trial_will_end', 'incomplete_expire']) {
      this.ctx.jobs.cancel(orgId, { idemKey: `billing.${key}:${subscriptionId}` }, now);
    }
  }

  /* -------------------------------- ledgers ------------------------------- */

  /**
   * Record a period the subscription has entered, with the recurring amount
   * recognised for it. This is the series revenue reporting charts, and it
   * exists whether or not an invoice has been raised yet.
   */
  recordPeriod(
    orgId: string, sub: Subscription, period: Period, status: PeriodStatus, book: Pricebook,
    fraction: { numerator: number; denominator: number } | null,
    opts: { createdAt?: number; invoiceId?: string | null } = {},
  ): BilledPeriod {
    const lines = recurringLines(sub.items, period, { book, currency: sub.currency, locale: this.locale(orgId) });
    let amount = status === 'trial' ? 0 : recurringSubtotal(lines);
    if (fraction && fraction.numerator !== fraction.denominator && status !== 'trial') {
      amount = sub.items.reduce((total, item) => {
        const price = book.price(item.price);
        if (isMetered(price)) return total;
        return total + book.compute(price, item.quantity, sub.currency, {
          proration: fraction, customUnitAmount: item.custom_unit_amount,
        }).amount;
      }, 0);
    }
    const id = randomId('period');
    this.ctx.db.run(
      `INSERT INTO billing_subscription_periods
         (id, org_id, subscription_id, customer_id, period_start, period_end, amount, currency, status, invoice_id, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subscription_id, period_start) DO UPDATE SET
         period_end = excluded.period_end, amount = excluded.amount, status = excluded.status`,
      id, orgId, sub.id, sub.customer, period.start, period.end, amount, sub.currency, status,
      opts.invoiceId ?? null, opts.createdAt ?? this.ctx.now(),
    );
    const row = this.ctx.db.get<any>(
      `SELECT * FROM billing_subscription_periods WHERE subscription_id = ? AND period_start = ?`, sub.id, period.start,
    );
    return hydratePeriod(row);
  }

  periods(orgId: string, filter: { subscription?: string; customer?: string; from?: number; to?: number; limit?: number } = {}): BilledPeriod[] {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.subscription) { clauses.push('subscription_id = ?'); params.push(filter.subscription); }
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.from !== undefined) { clauses.push('period_start >= ?'); params.push(filter.from); }
    if (filter.to !== undefined) { clauses.push('period_start <= ?'); params.push(filter.to); }
    return this.ctx.db.all<any>(
      `SELECT * FROM billing_subscription_periods WHERE ${clauses.join(' AND ')} ORDER BY period_start DESC LIMIT ?`,
      ...(params as any[]), Math.min(Math.max(filter.limit ?? 100, 1), 2000),
    ).map(hydratePeriod);
  }

  pendingItems(
    orgId: string, filter: { customer?: string; subscription?: string; status?: PendingItemStatus; limit?: number } = {},
  ): PendingInvoiceItem[] {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.subscription) { clauses.push('subscription_id = ?'); params.push(filter.subscription); }
    clauses.push('status = ?');
    params.push(filter.status ?? 'pending');
    return this.ctx.db.all<any>(
      `SELECT * FROM billing_pending_items WHERE ${clauses.join(' AND ')} ORDER BY created ASC, rowid ASC LIMIT ?`,
      ...(params as any[]), Math.min(Math.max(filter.limit ?? 100, 1), 500),
    ).map(hydratePendingItem);
  }

  /**
   * Claim a customer's waiting proration lines onto an invoice: stamp them
   * `invoiced`, point them at the bill, and hand back exactly what was claimed
   * so the caller can turn each one into a line.
   *
   * `ids` narrows it to one change — what `always_invoice` bills — and
   * `currency` keeps a claim from ever outrunning what the invoice can carry.
   * A row stamped `invoiced` that never becomes a line is money lost quietly,
   * which is why the filtering happens here rather than afterwards.
   */
  claimPendingItems(
    orgId: string, customerId: string, invoiceId: string,
    opts: { ids?: string[]; currency?: string } = {},
  ): PendingInvoiceItem[] {
    return this.ctx.atomic(() => {
      const items = this.pendingItems(orgId, { customer: customerId, status: 'pending', limit: PENDING_ITEMS_PER_INVOICE })
        .filter((item) => (opts.currency ? item.currency === opts.currency : true))
        .filter((item) => (opts.ids ? opts.ids.includes(item.id) : true));
      for (const item of items) {
        this.ctx.db.patch('billing_pending_items', 'id', item.id, { status: 'invoiced', invoice_id: invoiceId });
      }
      return items.map((item) => ({ ...item, status: 'invoiced' as PendingItemStatus, invoice: invoiceId }));
    });
  }

  /* -------------------------------- invoicing ----------------------------- */

  /**
   * Raise the invoice for a period, and tell the platform it happened.
   *
   * Two things come out of one call, on purpose. The `subscription.invoice_due`
   * event is the seam every other module reads — metering settles the arrears
   * window off it, webhooks and workflows fire from it — and it carries the
   * whole picture: the period, the recurring lines with their breakdowns, the
   * window that just closed, the prorations waiting and the customer balance.
   * The invoice itself is the durable object those numbers become, written in
   * this same transaction so a bill and the event announcing it can never
   * disagree.
   *
   * There is no invoice when there is nothing billable — a metered-only cycle
   * still raises the event that settles its usage, and that usage arrives on
   * the next bill.
   */
  private requestInvoice(
    orgId: string, sub: Subscription,
    opts: {
      reason: InvoiceBillingReason;
      period: Period;
      arrearsPeriod: Period | null;
      fraction: { numerator: number; denominator: number } | null;
      book: Pricebook;
      immediate: boolean;
      pendingItemIds?: string[];
      recurring?: boolean;
      createdAt?: number;
      paidAt?: number | null;
      meta?: WriteMeta;
    },
  ): Invoice | null {
    const scaled = this.periodLines(orgId, sub.items, sub.currency, opts.period, opts.fraction, opts.book, opts.recurring !== false);
    const customer = this.requireCustomer(orgId, sub.customer);
    const daysUntilDue = sub.days_until_due ?? customer.invoice_settings.days_until_due;
    // Read before the invoice claims them, so the event still says what this
    // cycle swept up rather than what is left afterwards, which is nothing.
    const pending = this.pendingItems(orgId, { subscription: sub.id, status: 'pending', limit: PENDING_ITEMS_PER_INVOICE });

    const invoice = this.invoices.issue(orgId, {
      reason: opts.reason,
      customerId: sub.customer,
      subscription: sub,
      currency: sub.currency,
      period: opts.period,
      arrearsPeriod: opts.arrearsPeriod,
      recurring: scaled,
      collectionMethod: sub.collection_method,
      daysUntilDue,
      pauseBehavior: sub.pause_collection?.behavior ?? null,
      pendingItemIds: opts.pendingItemIds,
      createdAt: opts.createdAt,
      paidAt: opts.paidAt,
      meta: opts.meta,
    });

    this.ctx.emit(orgId, 'subscription.invoice_due', {
      subscription: sub.id,
      customer: sub.customer,
      currency: sub.currency,
      reason: opts.reason,
      immediate: opts.immediate,
      collection_method: sub.collection_method,
      days_until_due: daysUntilDue,
      pause_behavior: sub.pause_collection?.behavior ?? null,
      period: opts.period,
      arrears_period: opts.arrearsPeriod,
      proration: opts.fraction,
      lines: scaled,
      subtotal: recurringSubtotal(scaled),
      pending_item_ids: opts.pendingItemIds ?? pending.map((item) => item.id),
      pending_total: pending.reduce((total, item) => total + item.amount, 0),
      customer_balance: customer.balance,
      // The bill these numbers became, so a subscriber can link straight to it
      // instead of guessing. Null when nothing was billable in advance.
      invoice: invoice?.id ?? null,
      invoice_number: invoice?.number ?? null,
      invoice_total: invoice?.total ?? 0,
    }, { objectId: sub.id, objectType: 'subscription' });

    return invoice;
  }

  /**
   * The recurring lines for one period, scaled once if the period is a stub —
   * the five days between a trial ending and the account's billing day are
   * charged as five days, not as a month.
   *
   * The same call backs the invoice, the `subscription.invoice_due` payload and
   * the upcoming-invoice preview, so all three quote the same numbers.
   */
  private periodLines(
    orgId: string, items: PricedItem[], currency: string, period: Period,
    fraction: { numerator: number; denominator: number } | null,
    book: Pricebook, include = true,
  ): RecurringLine[] {
    if (!include) return [];
    const lines = recurringLines(items, period, { book, currency, locale: this.locale(orgId) });
    if (!fraction || fraction.numerator === fraction.denominator) return lines;
    return lines.map((line, index) => {
      if (line.metered || line.amount === null) return line;
      const prorated = book.compute(book.price(line.price), line.quantity, currency, {
        proration: fraction, customUnitAmount: items[index].custom_unit_amount,
      });
      return { ...line, amount: prorated.amount, breakdown: prorated.breakdown, description: `${line.description} (partial period)` };
    });
  }

  /**
   * Write the invoice for something that has already happened.
   *
   * The difference from `requestInvoice` is the silence: no
   * `subscription.invoice_due` event. That event exists to make the *next*
   * thing happen — settle a usage window, fire a webhook, start a workflow —
   * and nothing should happen next for a month that ended a year ago. Seeding
   * the workspace's trading history is the only caller.
   */
  backfillInvoice(
    orgId: string, sub: Subscription,
    opts: {
      reason: InvoiceBillingReason;
      period: Period;
      book: Pricebook;
      createdAt: number;
      paidAt?: number | null;
      fraction?: { numerator: number; denominator: number } | null;
      recurring?: boolean;
      pendingItemIds?: string[];
    },
  ): Invoice | null {
    const customer = this.requireCustomer(orgId, sub.customer);
    return this.invoices.issue(orgId, {
      reason: opts.reason,
      customerId: sub.customer,
      subscription: sub,
      currency: sub.currency,
      period: opts.period,
      arrearsPeriod: null,
      recurring: this.periodLines(orgId, sub.items, sub.currency, opts.period, opts.fraction ?? null, opts.book, opts.recurring !== false),
      collectionMethod: sub.collection_method,
      daysUntilDue: sub.days_until_due ?? customer.invoice_settings.days_until_due,
      pauseBehavior: null,
      pendingItemIds: opts.pendingItemIds,
      createdAt: opts.createdAt,
      paidAt: opts.paidAt ?? null,
      meta: { actorType: 'system' },
    });
  }

  /**
   * Bill everything this account currently owes and nothing else: the
   * prorations waiting, the usage the credits module has settled, the balance.
   * The recurring fee is deliberately left out — it was billed when the period
   * opened, and charging it twice is what "invoice now" must never mean.
   */
  invoiceNow(
    orgId: string, customerId: string,
    opts: { subscription?: string | null; description?: string | null; meta?: WriteMeta } = {},
  ): Invoice {
    return this.ctx.atomic(() => {
      const customer = this.requireCustomer(orgId, customerId);
      const sub = opts.subscription ? this.requireSubscription(orgId, opts.subscription) : null;
      if (sub && sub.customer !== customer.id) {
        throw badRequest(
          'subscription_customer_mismatch',
          `Subscription ${sub.id} belongs to ${sub.customer}, not to ${customer.id}.`,
          'subscription',
        );
      }
      const now = this.ctx.now();
      const invoice = this.invoices.issue(orgId, {
        reason: 'manual',
        customerId: customer.id,
        subscription: sub,
        currency: customer.currency,
        period: sub
          ? { start: sub.current_period_start, end: sub.current_period_end }
          : { start: now, end: now },
        arrearsPeriod: null,
        recurring: [],
        collectionMethod: sub?.collection_method ?? 'send_invoice',
        daysUntilDue: sub?.days_until_due ?? customer.invoice_settings.days_until_due,
        pauseBehavior: null,
        meta: opts.meta,
      });
      if (!invoice) {
        throw conflict(
          'nothing_to_invoice',
          `${customer.name} has nothing waiting to be billed — no unbilled prorations, no settled usage and no credit purchases. The next charge lands when the current period renews.`,
        );
      }
      return invoice;
    });
  }

  /**
   * The upcoming invoice, optionally as it would look after a change — the same
   * arithmetic as the change preview, arranged as the bill the customer will
   * actually receive. Nothing is written.
   *
   * The lines are what the next invoice will really carry: the prorations this
   * change would leave waiting, anything already waiting, and the recurring fee
   * for the period that begins when the current one ends. Because a cadence
   * change re-anchors the cycle, "the period after next" is derived from the
   * subscription as it would be, not as it is.
   */
  previewInvoice(orgId: string, subscriptionId: string, input: SubscriptionUpdateInput): Invoice {
    const sub = this.requireSubscription(orgId, subscriptionId);
    const change = this.describeChange(orgId, sub, input);
    const { preview, book } = change;
    const customer = this.requireCustomer(orgId, sub.customer);
    const locale = this.locale(orgId);
    const now = this.ctx.now();

    // The period is derived exactly the way `renew()` derives it — from the
    // cycle the subscription would hold after this change — so the preview
    // cannot describe a window the renewal would not bill.
    const nextDate = preview.next_invoice.date;
    const anchor = change.anchorReset ? change.prorationDate : sub.billing_cycle_anchor;
    const period = clampFirstPeriod(periodAt(anchor, change.iv, nextDate, change.anchorDay), nextDate);
    const itemsAfter: PricedItem[] = change.resolved.map((item) => ({
      id: item.from?.id ?? null,
      price: item.price.id,
      quantity: item.quantity,
      custom_unit_amount: item.customUnitAmount ?? null,
    }));
    const upcoming = this.periodLines(
      orgId, itemsAfter, sub.currency, period,
      periodFraction(period, change.iv, change.anchorDay), book,
    );

    // Lines already waiting, plus the ones this change would add — including a
    // set that nets negative, which reaches the bill as credit lines and is
    // taxed there rather than being netted off in the balance.
    const waiting = this.pendingItems(orgId, { customer: customer.id, status: 'pending', limit: PENDING_ITEMS_PER_INVOICE });
    const proposed = preview.lines;
    const drafts: DraftLine[] = [
      ...this.invoices.recurringDrafts(orgId, sub.id, upcoming),
      ...this.invoices.prorationDrafts(waiting),
      ...proposed.map((line) => ({
        source: { type: 'pending_item' as const, id: null },
        subscription: line.subscription,
        subscriptionItem: line.subscription_item,
        price: line.price,
        kind: line.kind === 'metered' ? ('usage' as const) : line.kind,
        proration: line.kind === 'unused_time' || line.kind === 'remaining_time',
        description: line.description,
        explanation: line.explanation,
        quantity: line.quantity,
        amount: line.amount,
        currency: line.currency,
        period: line.period,
        fraction: line.proration,
        breakdown: line.breakdown,
      })),
    ];

    // The same call issuance makes, on the same customer: a preview that taxed
    // its lines differently from the invoice it predicts would not be a
    // preview of anything.
    const taxed = this.invoices.taxDrafts(orgId, customer, drafts);
    const automaticTax = this.automaticTaxFor(orgId, customer);
    const subtotal = taxed.reduce((total, line) => total + line.amount, 0);
    const tax = taxed.reduce((total, line) => total + line.tax.amount, 0);
    const starting = customer.balance;
    const total = Math.max(0, subtotal + tax + starting);
    const balanceApplied = total - subtotal - tax;

    const lines = taxed.map((line, index) => ({
      object: 'invoice_line_item' as const,
      id: `upcoming_${index}`,
      invoice: 'upcoming',
      subscription: line.subscription,
      subscription_item: line.subscriptionItem,
      source: line.source,
      price: line.price,
      kind: line.kind,
      proration: line.proration,
      description: line.description,
      explanation: line.explanation,
      quantity: line.quantity,
      amount: line.amount,
      currency: line.currency,
      period: line.period,
      proration_fraction: line.fraction,
      breakdown: line.breakdown,
      taxes: line.taxes,
      tax: line.tax,
      released: false,
    }));

    return {
      object: 'invoice',
      id: 'upcoming',
      number: 'UPCOMING',
      sequence: 0,
      customer: customer.id,
      subscription: sub.id,
      status: 'draft',
      billing_reason: input.items ? 'subscription_update' : 'subscription_cycle',
      currency: sub.currency,
      collection_method: sub.collection_method,
      period,
      arrears_period: { start: sub.current_period_start, end: sub.current_period_end },
      lines,
      subtotal,
      balance_applied: balanceApplied,
      tax,
      total_taxes: taxSummaryOf(lines),
      // A preview is the bill this account would be sent, and that includes
      // whether it could be sent at all.
      automatic_tax: automaticTax,
      total_excluding_tax: total - tax,
      pre_payment_credit_notes_amount: 0,
      post_payment_credit_notes_amount: 0,
      total,
      amount_paid: 0,
      amount_due: total,
      starting_balance: starting,
      ending_balance: starting - balanceApplied,
      due_date: sub.collection_method === 'send_invoice'
        ? nextDate + (sub.days_until_due ?? customer.invoice_settings.days_until_due ?? 30) * DAY
        : null,
      finalized_at: null,
      paid_at: null,
      voided_at: null,
      marked_uncollectible_at: null,
      payment_note: null,
      footer: customer.invoice_settings.footer,
      description: `Upcoming invoice for ${customer.name}, covering ${describeWindow(period, locale)}.`,
      metadata: {},
      created: now,
      updated: now,
      livemode: sub.livemode,
    };
  }

  /* ------------------------------- schedule glue -------------------------- */

  /** Replace a subscription's items to match a schedule phase, with proration. */
  applyPhase(orgId: string, sub: Subscription, phase: SchedulePhase, at: number, behavior?: ProrationBehavior): Subscription {
    // An item the next phase also carries keeps its identity and its history;
    // only what the phase drops is removed, so nothing is credited and
    // re-charged for standing still.
    const carried = new Set(phase.items.map((item) => item.price));
    // A phase job that fires late can name a boundary the subscription has
    // already renewed past; the change still lands, from the start of the
    // period it is actually in.
    const effectiveAt = Math.min(Math.max(at, sub.current_period_start), sub.current_period_end);
    const result = this.updateSubscription(orgId, sub.id, {
      items: [
        ...sub.items.filter((item) => !carried.has(item.price)).map((item) => ({ id: item.id, deleted: true })),
        ...phase.items.map((item) => ({
          price: item.price, quantity: item.quantity,
          custom_unit_amount: item.custom_unit_amount, metadata: item.metadata,
        })),
      ],
      proration_behavior: behavior ?? phase.proration_behavior,
      proration_date: effectiveAt,
      ...(phase.collection_method ? { collection_method: phase.collection_method } : {}),
      ...(phase.days_until_due !== null && phase.days_until_due !== undefined ? { days_until_due: phase.days_until_due } : {}),
    }, { actorType: 'system' });
    return result.subscription;
  }

  mrr(orgId: string, sub: Subscription): number {
    return countsAsRevenue(sub.status) ? subscriptionMrr(sub, this.book(orgId)) : 0;
  }

  /**
   * Whether a bill for this account can be placed, in the shape every payload
   * that predicts one publishes it.
   *
   * One reader, because the question is one question: the bill itself, the
   * upcoming-invoice preview and the change preview all have to give the same
   * answer, and three copies of "enabled, status, sentence" is how two of them
   * come to give a different one.
   */
  automaticTaxFor(orgId: string, customer: Customer): AutomaticTax {
    const enabled = this.invoices.automaticTaxEnabled(orgId);
    const status = this.invoices.taxStatusFor(orgId, customer);
    return { enabled, status, detail: describeAutomaticTax(status, enabled) };
  }
}

/* --------------------------------- helpers -------------------------------- */

function resolveTrialEnd(input: SubscriptionCreateInput, prices: Price[], start: number): number | null {
  if (input.trial_end !== undefined) return input.trial_end;
  if (input.trial_period_days !== undefined) return start + input.trial_period_days * DAY;
  if (input.trial_from_plan) {
    const days = prices
      .map((p) => (isRecurring(p) ? p.recurring?.trial_period_days ?? 0 : 0))
      .reduce((best, d) => Math.max(best, d ?? 0), 0);
    return days > 0 ? start + days * DAY : null;
  }
  return null;
}

/** A subscription that starts inside a period only holds the rest of it. */
function clampFirstPeriod(period: Period, start: number): Period {
  return period.start >= start ? period : { start, end: period.end };
}

/**
 * Where the billing cycle is measured from, and which day of the month it wants.
 *
 * There are two ways to say the same thing — `billing_cycle_anchor` as an
 * instant, `billing_cycle_anchor_day` as a day of the month — and they have to
 * mean the same thing, because they name the same cycle. The anchor instant is
 * therefore always moved onto its own anchor day: an anchor of 1 January with
 * an anchor day of the 15th means the cycle lands on 15 January, and the first
 * period is the fortnight in between, charged as a fortnight.
 */
function resolveAnchor(
  input: SubscriptionCreateInput, iv: Interval, trialEnd: number | null, start: number,
): { anchor: number; anchorDay: number } {
  const requested = input.billing_cycle_anchor ?? trialEnd ?? start;
  const day = input.billing_cycle_anchor_day;
  if (day === undefined) return { anchor: requested, anchorDay: anchorDayOf(requested) };

  if (!cadenceHasAnchorDay(iv.unit)) {
    throw badRequest(
      'anchor_day_not_applicable',
      `billing_cycle_anchor_day names a day of the month, so it only means something on a monthly or yearly cycle. These items bill every ${describeCadence({ interval: iv.unit, interval_count: iv.count })}.`,
      'billing_cycle_anchor_day',
    );
  }
  if (input.billing_cycle_anchor !== undefined && !anchorLandsOnDay(input.billing_cycle_anchor, day)) {
    throw badRequest(
      'billing_cycle_anchor_conflict',
      `billing_cycle_anchor falls on day ${anchorDayOf(input.billing_cycle_anchor)} of the month but billing_cycle_anchor_day says ${day}. They name the same cycle, so send one or the other.`,
      'billing_cycle_anchor_day',
    );
  }
  // The instant may be the trial end or the start date, neither of which knows
  // about the anchor day; move it forward onto the day the cycle actually wants.
  return { anchor: snapToAnchorDay(requested, day), anchorDay: day };
}

/**
 * How much of a whole interval the first period actually covers.
 *
 * A subscription started on the 8th but anchored to the 1st holds only the
 * remainder of the month, and must be charged for exactly that remainder. The
 * whole interval is the one that *ends* where this period ends, so the
 * denominator is a real calendar interval and not an average month.
 */
function periodFraction(
  period: Period, iv: Interval, anchorDay: number,
): { numerator: number; denominator: number } | null {
  const fullStart = addInterval(period.end, { ...iv, count: -iv.count }, anchorDay);
  const denominator = Math.max(1, period.end - fullStart);
  const numerator = Math.max(0, period.end - period.start);
  // A period longer than the interval it belongs to cannot be priced: there is
  // no fraction of one month that is a month and a half. Clamping it would
  // charge one interval's price for more than one interval and say nothing, so
  // the impossible period is surfaced instead of quietly rounded away.
  if (numerator > denominator) {
    throw internal(
      `A billing period cannot be longer than its own interval: ${new Date(period.start).toISOString()} to ${new Date(period.end).toISOString()} is longer than one ${describeCadence({ interval: iv.unit, interval_count: iv.count })} ending on day ${anchorDay}.`,
      { period, interval: iv, anchor_day: anchorDay },
    );
  }
  return numerator === denominator ? null : { numerator, denominator };
}
