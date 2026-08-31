/**
 * The bill.
 *
 * Everything else in this module computes a number; this file is where those
 * numbers become something a customer can be charged. An invoice is assembled
 * from three sources and nothing else:
 *
 *  1. the subscription's own recurring lines for the period being entered,
 *     billed in advance and already scaled if the period is a partial one;
 *  2. the proration lines waiting in `billing_pending_items`, claimed here and
 *     stamped `invoiced` so no second invoice can pick them up;
 *  3. whatever the credits module has in its outbox for this customer — the
 *     usage it settled in arrears, the credit it covered, the packs it sold.
 *
 * Two identities hold on every row this file writes, and they are asserted
 * before the transaction is allowed to commit:
 *
 *     sum(lines.amount) === subtotal
 *     subtotal + balance_applied === total,  with total >= 0
 *
 * The second is what makes the customer balance honest: `balance_applied` is
 * whatever it takes to carry the difference, so a credit that exceeds the bill
 * leaves the remainder on the account instead of paying money out, and a
 * negative subtotal becomes credit rather than a negative invoice.
 */
import type { Ctx } from '../../kernel/context';
import { badRequest, conflict, internal, notFound } from '../../../shared/errors';
import { cursorOf, newId, parseCursor, randomId } from '../../../shared/ids';
import { formatMoney, money } from '../../../shared/money';
import { DAY, type Period } from '../../../shared/time';
import type { BillableItem } from '../credits/types';
import { longDate } from './cycle';
import { hydrateInvoice, hydrateInvoiceLine, like, type InvoiceListFilter, type Page, type WriteMeta } from './records';
import type { Billing } from './store';
import type {
  CollectionMethod, Invoice, InvoiceBillingReason, InvoiceLine, InvoiceLineKind, InvoiceLineSource,
  InvoiceStatus, PauseBehavior, PendingInvoiceItem, RecurringLine, Subscription,
} from './types';

/** The one call this file makes into another module, named so it is obvious. */
interface CreditsOutbox {
  drainOutbox(orgId: string, customerId: string, invoiceId: string): BillableItem[];
}

/** A line on its way onto an invoice, before it has an id. */
export interface DraftLine {
  source: { type: InvoiceLineSource; id: string | null };
  subscription: string | null;
  subscriptionItem: string | null;
  price: string | null;
  kind: InvoiceLineKind;
  proration: boolean;
  description: string;
  explanation: string;
  quantity: number;
  amount: number;
  currency: string;
  period: { start: number; end: number };
  fraction: { numerator: number; denominator: number } | null;
  breakdown: InvoiceLine['breakdown'];
}

export interface IssueInvoiceInput {
  reason: InvoiceBillingReason;
  customerId: string;
  subscription: Subscription | null;
  currency: string;
  /** The service window billed in advance. */
  period: Period;
  /** The window whose metered usage settles after this invoice, if any. */
  arrearsPeriod: Period | null;
  /** Recurring lines for `period`, already scaled to a partial period. */
  recurring: RecurringLine[];
  collectionMethod: CollectionMethod;
  daysUntilDue: number | null;
  /** A paused subscription's collection behaviour decides how this ends up. */
  pauseBehavior: PauseBehavior | null;
  /**
   * Restrict the proration sweep to these ids. Left out, the invoice claims
   * everything pending for the customer — which is what a cycle invoice does.
   */
  pendingItemIds?: string[];
  /** Backdated history: the invoice was raised, and settled, on the day. */
  createdAt?: number;
  paidAt?: number | null;
  meta?: WriteMeta;
}

/** How the three sources become lines, and how a totalled invoice is written. */
export class Invoices {
  constructor(private readonly ctx: Ctx, private readonly billing: Billing) {}

  /* --------------------------------- reading ------------------------------- */

  linesOf(orgId: string, invoiceId: string): InvoiceLine[] {
    return this.ctx.db.all<Record<string, unknown>>(
      `SELECT * FROM billing_invoice_lines WHERE org_id = ? AND invoice_id = ? ORDER BY position ASC, rowid ASC`,
      orgId, invoiceId,
    ).map(hydrateInvoiceLine);
  }

  invoice(orgId: string, id: string): Invoice | null {
    const row = this.ctx.db.get<Record<string, unknown>>(
      `SELECT * FROM billing_invoices WHERE org_id = ? AND id = ?`, orgId, id,
    );
    return row ? hydrateInvoice(row, this.linesOf(orgId, id)) : null;
  }

  require(orgId: string, id: string): Invoice {
    const found = this.invoice(orgId, id);
    if (!found) throw notFound('invoice', id);
    return found;
  }

  list(orgId: string, filter: InvoiceListFilter = {}): Page<Invoice> {
    const clauses = ['i.org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.customer) { clauses.push('i.customer_id = ?'); params.push(filter.customer); }
    if (filter.subscription) { clauses.push('i.subscription_id = ?'); params.push(filter.subscription); }
    if (filter.status && filter.status !== 'all') {
      if (filter.status === 'open_like') clauses.push(`i.status IN ('draft','open')`);
      else { clauses.push('i.status = ?'); params.push(filter.status); }
    }
    if (filter.billing_reason) { clauses.push('i.billing_reason = ?'); params.push(filter.billing_reason); }
    if (filter.collection_method) { clauses.push('i.collection_method = ?'); params.push(filter.collection_method); }
    if (filter.created_after !== undefined) { clauses.push('i.created >= ?'); params.push(filter.created_after); }
    if (filter.created_before !== undefined) { clauses.push('i.created <= ?'); params.push(filter.created_before); }
    if (filter.due_before !== undefined) { clauses.push('i.due_date IS NOT NULL AND i.due_date <= ?'); params.push(filter.due_before); }
    if (filter.query) {
      clauses.push(
        `(i.number LIKE ? ESCAPE '\\' OR i.id = ? OR EXISTS (SELECT 1 FROM billing_customers c WHERE c.id = i.customer_id AND (c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\')))`,
      );
      const l = like(filter.query);
      params.push(l, filter.query, l, l);
    }
    const where = clauses.join(' AND ');
    const totalCount = this.ctx.db.count(`SELECT COUNT(*) FROM billing_invoices i WHERE ${where}`, ...(params as string[]));

    const paged = [...params];
    let cursorClause = '';
    if (filter.cursor) {
      const parsed = parseCursor(filter.cursor);
      if (!parsed) throw badRequest('cursor_invalid', 'That pagination cursor is not readable. Start the list again.', 'cursor');
      cursorClause = ' AND (i.created < ? OR (i.created = ? AND i.id < ?))';
      paged.push(parsed.createdAt, parsed.createdAt, parsed.id);
    }
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 200);
    const rows = this.ctx.db.all<Record<string, unknown>>(
      `SELECT i.* FROM billing_invoices i WHERE ${where}${cursorClause} ORDER BY i.created DESC, i.id DESC LIMIT ?`,
      ...(paged as string[]), limit + 1,
    );
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map((row) => hydrateInvoice(row, this.linesOf(orgId, String(row.id))));
    const last = data[data.length - 1];
    return { data, hasMore, nextCursor: hasMore && last ? cursorOf(last.created, last.id) : null, totalCount };
  }

  /**
   * The most recent bill for a subscription, in the shape a list row needs.
   * Stripe's `latest_invoice`, and the answer to "did that renewal go out?".
   */
  latestFor(orgId: string, subscriptionId: string): {
    id: string; number: string; status: InvoiceStatus; total: number; amount_due: number;
    due_date: number | null; created: number;
  } | null {
    const row = this.ctx.db.get<Record<string, unknown>>(
      `SELECT id, number, status, total, amount_due, due_date, created FROM billing_invoices
        WHERE org_id = ? AND subscription_id = ? ORDER BY created DESC, rowid DESC LIMIT 1`,
      orgId, subscriptionId,
    );
    if (!row) return null;
    return {
      id: String(row.id),
      number: String(row.number),
      status: row.status as InvoiceStatus,
      total: Number(row.total),
      amount_due: Number(row.amount_due),
      due_date: row.due_date === null || row.due_date === undefined ? null : Number(row.due_date),
      created: Number(row.created),
    };
  }

  /** Everything still owed, for the customer summary and the dunning view. */
  openInvoices(orgId: string, customerId: string): Invoice[] {
    return this.ctx.db.all<Record<string, unknown>>(
      `SELECT * FROM billing_invoices WHERE org_id = ? AND customer_id = ? AND status IN ('draft','open')
        ORDER BY created ASC`, orgId, customerId,
    ).map((row) => hydrateInvoice(row, this.linesOf(orgId, String(row.id))));
  }

  /**
   * What this account has actually been billed over its life. Drafts are not
   * bills yet and voided invoices were withdrawn, so neither counts; an
   * uncollectible one does, because it was charged even though it was written
   * off, and hiding it would flatter the number.
   */
  lifetimeBilled(orgId: string, customerId: string): number {
    return this.ctx.db.count(
      `SELECT COALESCE(SUM(total), 0) FROM billing_invoices
        WHERE org_id = ? AND customer_id = ? AND status IN ('open','paid','uncollectible')`,
      orgId, customerId,
    );
  }

  /** What the workspace has collected, is still owed, and has written off. */
  totals(orgId: string): { billed: number; collected: number; outstanding: number; written_off: number; count: number } {
    const row = this.ctx.db.get<Record<string, number>>(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('open','paid','uncollectible') THEN total ELSE 0 END), 0) AS billed,
         COALESCE(SUM(amount_paid), 0) AS collected,
         COALESCE(SUM(CASE WHEN status IN ('draft','open') THEN amount_due ELSE 0 END), 0) AS outstanding,
         COALESCE(SUM(CASE WHEN status = 'uncollectible' THEN total ELSE 0 END), 0) AS written_off,
         COUNT(*) AS count
       FROM billing_invoices WHERE org_id = ?`, orgId,
    );
    return {
      billed: Number(row?.billed ?? 0),
      collected: Number(row?.collected ?? 0),
      outstanding: Number(row?.outstanding ?? 0),
      written_off: Number(row?.written_off ?? 0),
      count: Number(row?.count ?? 0),
    };
  }

  /* -------------------------------- assembling ----------------------------- */

  /** A subscription's own fee for the period. Metered lines are not billable yet. */
  recurringDrafts(orgId: string, subscriptionId: string | null, lines: RecurringLine[]): DraftLine[] {
    const locale = this.billing.locale(orgId);
    const out: DraftLine[] = [];
    for (const line of lines) {
      if (line.metered || line.amount === null) continue;
      out.push({
        source: { type: 'subscription_item', id: null },
        subscription: subscriptionId,
        subscriptionItem: line.subscription_item,
        price: line.price,
        kind: 'recurring',
        proration: false,
        description: line.description,
        explanation: `${line.description} for ${describeWindow(line.period, locale)}, billed in advance.`,
        quantity: line.quantity,
        amount: line.amount,
        currency: line.currency,
        period: line.period,
        fraction: null,
        breakdown: line.breakdown,
      });
    }
    return out;
  }

  prorationDrafts(items: PendingInvoiceItem[]): DraftLine[] {
    return items.map((item) => ({
      source: { type: 'pending_item' as InvoiceLineSource, id: item.id },
      subscription: item.subscription,
      subscriptionItem: item.subscription_item,
      price: item.price,
      kind: item.kind === 'metered' ? 'usage' : item.kind,
      proration: item.kind === 'unused_time' || item.kind === 'remaining_time',
      description: item.description,
      explanation: item.explanation,
      quantity: item.quantity,
      amount: item.amount,
      currency: item.currency,
      period: item.period,
      fraction: item.proration,
      breakdown: item.breakdown,
    }));
  }

  /**
   * What the credits module has been holding for this customer: usage it priced
   * when a period closed, the part of it prepaid credit already paid for, and
   * any credit packs bought since the last bill. `billed_amount` is what the
   * customer actually owes, which is zero on a credit-covered line — the line is
   * still worth showing, because "1,200 events, covered" is information.
   */
  usageDrafts(orgId: string, items: BillableItem[], subscriptionId: string | null, fallback: Period): DraftLine[] {
    const locale = this.billing.locale(orgId);
    return items.map((item) => {
      const dated = item.period_start !== null && item.period_end !== null;
      const period = dated ? { start: item.period_start as number, end: item.period_end as number } : fallback;
      const kind: InvoiceLineKind = item.kind === 'charged' ? 'usage'
        : item.kind === 'credit_covered' ? 'credit_covered'
          : item.kind === 'topup' ? 'topup' : 'true_up';
      return {
        source: { type: 'billable_item' as InvoiceLineSource, id: item.id },
        subscription: subscriptionId,
        subscriptionItem: null,
        price: item.price,
        kind,
        proration: false,
        description: item.description,
        explanation: kind === 'credit_covered'
          ? `${formatMoney(money(item.amount, item.currency), { locale })} of usage${dated ? ` for ${describeWindow(period, locale)}` : ''} was paid for out of prepaid credit, so nothing is charged for it here.`
          : `${item.description}${dated ? `, for usage recorded ${describeWindow(period, locale)} and priced when that window closed` : ''}.`,
        quantity: Math.max(1, Math.round(item.quantity)),
        amount: item.billed_amount,
        currency: item.currency,
        period,
        fraction: null,
        breakdown: [],
      };
    });
  }

  /* --------------------------------- issuing ------------------------------- */

  /**
   * Draw the invoice. Returns null when there is nothing billable — a cycle on
   * a metered-only subscription raises the event that settles the usage but has
   * no line of its own, and an invoice with no lines is not an invoice.
   *
   * Runs inside the caller's transaction, so the invoice, the claimed
   * prorations, the balance movement and the events all land together or not
   * at all.
   */
  issue(orgId: string, input: IssueInvoiceInput): Invoice | null {
    const customer = this.billing.requireCustomer(orgId, input.customerId);
    const createdAt = input.createdAt ?? this.ctx.now();
    const id = newId('invoice');
    const locale = this.billing.locale(orgId);

    const claimed = this.billing.claimPendingItems(orgId, customer.id, id, {
      ids: input.pendingItemIds, currency: input.currency,
    });
    const outbox = this.creditsOutbox()?.drainOutbox(orgId, customer.id, id) ?? [];
    for (const item of outbox) {
      if (item.currency === input.currency) continue;
      // Unreachable while a customer's currency is fixed at their first bill,
      // which is exactly why it must fail loudly rather than drop the line.
      throw internal(
        `Credits handed over a ${item.currency.toUpperCase()} line for a ${input.currency.toUpperCase()} invoice, so it cannot be billed.`,
        { invoice: id, item: item.id, currency: item.currency },
      );
    }

    const drafts: DraftLine[] = [
      ...this.recurringDrafts(orgId, input.subscription?.id ?? null, input.recurring),
      ...this.prorationDrafts(claimed),
      ...this.usageDrafts(orgId, outbox, input.subscription?.id ?? null, input.arrearsPeriod ?? input.period),
    ];
    if (!drafts.length) return null;

    const subtotal = drafts.reduce((total, line) => total + line.amount, 0);
    const starting = customer.balance;
    // One formula, and both invariants fall out of it: the invoice never goes
    // below zero, and whatever the bill and the balance cannot settle between
    // them stays on the account.
    const total = Math.max(0, subtotal + starting);
    const balanceApplied = total - subtotal;
    const ending = starting - balanceApplied;

    const dueDate = input.collectionMethod === 'send_invoice'
      ? createdAt + (input.daysUntilDue ?? customer.invoice_settings.days_until_due ?? 30) * DAY
      : null;

    this.ctx.db.insert('billing_invoices', {
      id,
      org_id: orgId,
      sequence: 0,
      number: id,
      customer_id: customer.id,
      subscription_id: input.subscription?.id ?? null,
      status: 'draft',
      billing_reason: input.reason,
      currency: input.currency,
      collection_method: input.collectionMethod,
      period_start: input.period.start,
      period_end: input.period.end,
      arrears_period_start: input.arrearsPeriod?.start ?? null,
      arrears_period_end: input.arrearsPeriod?.end ?? null,
      subtotal,
      balance_applied: balanceApplied,
      total,
      amount_paid: 0,
      amount_due: total,
      starting_balance: starting,
      ending_balance: ending,
      due_date: dueDate,
      finalized_at: null,
      paid_at: null,
      voided_at: null,
      marked_uncollectible_at: null,
      payment_note: null,
      footer: customer.invoice_settings.footer,
      description: input.subscription?.description ?? null,
      metadata: {},
      created: createdAt,
      updated: createdAt,
      livemode: input.subscription ? (input.subscription.livemode ? 1 : 0) : (input.meta?.livemode === false ? 0 : 1),
    });
    // The number is assigned after the row exists so the sequence is taken
    // under the same lock that guarantees it is not handed out twice.
    const sequence = this.ctx.db.count(
      `SELECT COALESCE(MAX(sequence), 0) + 1 FROM billing_invoices WHERE org_id = ?`, orgId,
    );
    this.ctx.db.patch('billing_invoices', 'id', id, { sequence, number: this.numberFor(orgId, sequence) });

    drafts.forEach((line, position) => {
      this.ctx.db.insert('billing_invoice_lines', {
        id: randomId('lineitem'),
        org_id: orgId,
        invoice_id: id,
        subscription_id: line.subscription,
        subscription_item_id: line.subscriptionItem,
        source_type: line.source.type,
        source_id: line.source.id,
        price_id: line.price,
        kind: line.kind,
        proration: line.proration ? 1 : 0,
        description: line.description,
        explanation: line.explanation,
        quantity: line.quantity,
        amount: line.amount,
        currency: line.currency,
        period_start: line.period.start,
        period_end: line.period.end,
        proration_numerator: line.fraction?.numerator ?? null,
        proration_denominator: line.fraction?.denominator ?? null,
        breakdown: line.breakdown,
        released: 0,
        position,
        created: createdAt,
      });
    });

    if (balanceApplied !== 0) {
      this.billing.adjustBalance(orgId, customer.id, -balanceApplied, {
        type: 'applied_to_invoice',
        description: balanceApplied < 0
          ? `${formatMoney(money(-balanceApplied, input.currency), { locale })} of account credit applied to invoice ${this.numberFor(orgId, sequence)}`
          : `${formatMoney(money(balanceApplied, input.currency), { locale })} carried forward onto invoice ${this.numberFor(orgId, sequence)}`,
        subscription: input.subscription?.id ?? null,
        invoice: id,
        createdAt,
      });
    }

    this.billing.lockCurrency(orgId, customer.id);
    // The period ledger and the invoice now point at each other, which is what
    // makes "what did we bill for August?" answerable from either end.
    if (input.subscription) {
      this.ctx.db.run(
        `UPDATE billing_subscription_periods SET invoice_id = ?
          WHERE org_id = ? AND subscription_id = ? AND period_start = ? AND invoice_id IS NULL`,
        id, orgId, input.subscription.id, input.period.start,
      );
    }

    this.assertBalanced(orgId, id);
    const draft = this.require(orgId, id);
    this.ctx.emit(orgId, 'invoice.created', draft, {
      objectId: id, objectType: 'invoice',
      actorId: input.meta?.actorId, actorType: input.meta?.actorType, requestId: input.meta?.requestId,
    });

    // A paused subscription says what happens to the bills raised while it is
    // paused; that is the whole point of `pause_collection.behavior`.
    if (input.pauseBehavior === 'keep_as_draft') return draft;
    if (input.pauseBehavior === 'void') return this.voidInvoice(orgId, id, input.meta, createdAt);
    if (input.pauseBehavior === 'mark_uncollectible') return this.markUncollectible(orgId, id, input.meta, createdAt);

    const open = this.finalize(orgId, id, input.meta, createdAt);
    if (open.total === 0) {
      return this.pay(orgId, id, { note: 'Nothing to collect — the balance covered it in full.', at: createdAt }, input.meta);
    }
    if (input.paidAt !== undefined && input.paidAt !== null) {
      return this.pay(orgId, id, { note: 'Collected on the day it was raised.', at: input.paidAt }, input.meta);
    }
    return open;
  }

  /* ------------------------------ state changes ---------------------------- */

  finalize(orgId: string, id: string, meta: WriteMeta | undefined, at?: number): Invoice {
    const invoice = this.require(orgId, id);
    if (invoice.status !== 'draft') {
      if (invoice.status === 'open') return invoice;
      throw conflict('invoice_not_draft', `Invoice ${invoice.number} is ${invoice.status}, so there is nothing left to finalise.`, { status: invoice.status });
    }
    const now = at ?? this.ctx.now();
    this.ctx.db.patch('billing_invoices', 'id', id, { status: 'open', finalized_at: now, updated: now });
    const after = this.require(orgId, id);
    this.ctx.emit(orgId, 'invoice.finalized', after, {
      objectId: id, objectType: 'invoice', previous: { status: invoice.status },
      actorId: meta?.actorId, actorType: meta?.actorType, requestId: meta?.requestId,
    });
    return after;
  }

  pay(orgId: string, id: string, opts: { note?: string | null; at?: number } = {}, meta?: WriteMeta): Invoice {
    const invoice = this.require(orgId, id);
    if (invoice.status === 'paid') return invoice;
    if (invoice.status === 'void') {
      throw conflict('invoice_void', `Invoice ${invoice.number} was voided, so it cannot be paid. Raise a new one.`, { status: invoice.status });
    }
    const now = opts.at ?? this.ctx.now();
    this.ctx.db.patch('billing_invoices', 'id', id, {
      status: 'paid', amount_paid: invoice.total, amount_due: 0,
      finalized_at: invoice.finalized_at ?? now, paid_at: now,
      payment_note: opts.note ?? invoice.payment_note, updated: now,
    });
    const after = this.require(orgId, id);
    this.ctx.emit(orgId, 'invoice.paid', after, {
      objectId: id, objectType: 'invoice', previous: { status: invoice.status },
      actorId: meta?.actorId, actorType: meta?.actorType, requestId: meta?.requestId,
    });
    return after;
  }

  /**
   * Withdraw a bill that should never have been sent. The balance it drew down
   * goes back where it came from, because a voided invoice consumed nothing.
   */
  voidInvoice(orgId: string, id: string, meta?: WriteMeta, at?: number): Invoice {
    const invoice = this.require(orgId, id);
    if (invoice.status === 'void') return invoice;
    if (invoice.status === 'paid') {
      throw conflict('invoice_paid', `Invoice ${invoice.number} has been paid. Issue a credit rather than voiding it.`, { status: invoice.status });
    }
    const now = at ?? this.ctx.now();
    this.ctx.db.patch('billing_invoices', 'id', id, {
      status: 'void', voided_at: now, amount_due: 0, updated: now,
    });
    if (invoice.balance_applied !== 0) {
      this.billing.adjustBalance(orgId, invoice.customer, invoice.balance_applied, {
        type: 'adjustment',
        description: `Balance returned when invoice ${invoice.number} was voided`,
        subscription: invoice.subscription, invoice: id, createdAt: now,
      });
    }
    this.releaseClaims(orgId, id);
    this.assertBalanced(orgId, id);
    const after = this.require(orgId, id);
    this.ctx.emit(orgId, 'invoice.voided', after, {
      objectId: id, objectType: 'invoice', previous: { status: invoice.status },
      actorId: meta?.actorId, actorType: meta?.actorType, requestId: meta?.requestId,
    });
    return after;
  }

  markUncollectible(orgId: string, id: string, meta?: WriteMeta, at?: number): Invoice {
    const invoice = this.require(orgId, id);
    if (invoice.status === 'uncollectible') return invoice;
    if (invoice.status === 'paid' || invoice.status === 'void') {
      throw conflict(
        'invoice_not_collectible',
        `Invoice ${invoice.number} is ${invoice.status}, so it cannot be written off.`,
        { status: invoice.status },
      );
    }
    const now = at ?? this.ctx.now();
    this.ctx.db.patch('billing_invoices', 'id', id, {
      status: 'uncollectible', marked_uncollectible_at: now,
      finalized_at: invoice.finalized_at ?? now, updated: now,
    });
    const after = this.require(orgId, id);
    this.ctx.emit(orgId, 'invoice.marked_uncollectible', after, {
      objectId: id, objectType: 'invoice', previous: { status: invoice.status },
      actorId: meta?.actorId, actorType: meta?.actorType, requestId: meta?.requestId,
    });
    return after;
  }

  /* --------------------------------- guards -------------------------------- */

  /**
   * The two identities, checked against what was actually written rather than
   * against what was computed. An invoice that does not add up is a bug that
   * must never reach a customer, so it takes the transaction down with it.
   */
  assertBalanced(orgId: string, id: string): void {
    const invoice = this.require(orgId, id);
    const lineTotal = invoice.lines.reduce((total, line) => total + line.amount, 0);
    if (lineTotal !== invoice.subtotal) {
      throw internal(
        `Invoice ${invoice.number}'s lines add up to ${lineTotal} but its subtotal says ${invoice.subtotal}.`,
        { invoice: id, lines: lineTotal, subtotal: invoice.subtotal },
      );
    }
    if (invoice.subtotal + invoice.balance_applied !== invoice.total || invoice.total < 0) {
      throw internal(
        `Invoice ${invoice.number} does not reconcile: ${invoice.subtotal} + ${invoice.balance_applied} is not ${invoice.total}.`,
        { invoice: id, subtotal: invoice.subtotal, balance_applied: invoice.balance_applied, total: invoice.total },
      );
    }
  }

  /* -------------------------------- internals ------------------------------ */

  /**
   * Give the claimed rows back when an invoice is withdrawn.
   *
   * The lines stay exactly where they are — a voided invoice is still the
   * record of what was withdrawn, and deleting half of it would leave a
   * document whose lines no longer add up to its subtotal. What is released is
   * the *hold*: the proration goes back to waiting, the period stops pointing
   * at a bill nobody owes, and the credits module takes its lines back, so the
   * replacement invoice can claim all three properly.
   */
  private releaseClaims(orgId: string, invoiceId: string): void {
    this.ctx.db.run(
      `UPDATE billing_pending_items SET status = 'pending', invoice_id = NULL
        WHERE org_id = ? AND invoice_id = ? AND status = 'invoiced'`,
      orgId, invoiceId,
    );
    this.ctx.db.run(
      `UPDATE billing_subscription_periods SET invoice_id = NULL WHERE org_id = ? AND invoice_id = ?`,
      orgId, invoiceId,
    );
    this.ctx.db.run(
      `UPDATE billing_invoice_lines SET released = 1 WHERE org_id = ? AND invoice_id = ?`, orgId, invoiceId,
    );
  }

  private creditsOutbox(): CreditsOutbox | null {
    const registry = this.ctx.svc as { credits?: CreditsOutbox };
    return registry.credits ?? null;
  }

  /**
   * `NR-000042`. The prefix is the workspace's initials so a human reading a
   * remittance advice knows whose invoice it is; the sequence is per workspace
   * and gapless, which is what most tax authorities actually require.
   */
  private numberFor(orgId: string, sequence: number): string {
    return `${orgPrefix(this.orgName(orgId))}-${String(sequence).padStart(6, '0')}`;
  }

  private orgName(orgId: string): string {
    try { return this.ctx.svc.core.org(orgId).name || 'Invoice'; }
    catch { return 'Invoice'; }
  }
}

/* --------------------------------- helpers -------------------------------- */

export function orgPrefix(name: string): string {
  const initials = name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word[0].toUpperCase()).join('');
  return (initials || 'IN').slice(0, 3);
}

export const describeWindow = (period: { start: number; end: number }, locale: string): string =>
  `${longDate(period.start, locale)} to ${longDate(period.end, locale)}`;

