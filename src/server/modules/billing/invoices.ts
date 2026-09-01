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
 * Every line is then taxed by the customer's own rate before any of it is
 * written, so the subtotal this file records is a taxable base and never a
 * number that quietly contains tax.
 *
 * Five identities hold on every row this file writes, and they are asserted
 * before the transaction is allowed to commit:
 *
 *     sum(lines.amount)     === subtotal
 *     sum(lines.tax_amount) === tax
 *     subtotal + tax + balance_applied === total,  with total >= 0
 *     amount_paid + pre_payment_credit_notes_amount + amount_due === total
 *     sum(issued credit notes.total) <= total
 *
 * The third is what makes the customer balance honest: `balance_applied` is
 * whatever it takes to carry the difference, so a credit that exceeds the bill
 * leaves the remainder on the account instead of paying money out, and a
 * negative subtotal becomes credit rather than a negative invoice. The fourth
 * is what makes the *cash* honest — it is impossible to record more collected
 * than the bill could ever have collected, which is what a credit note raised
 * before payment changes. The fifth stops a bill being credited for more than
 * it was ever worth.
 */
import type { Ctx } from '../../kernel/context';
import { badRequest, conflict, internal, notFound } from '../../../shared/errors';
import { cursorOf, newId, parseCursor } from '../../../shared/ids';
import { formatMoney, money } from '../../../shared/money';
import { DAY, type Period } from '../../../shared/time';
import type { TaxBehavior } from '../catalog/types';
import type { BillableItem } from '../credits/types';
import { longDate } from './cycle';
import {
  hydrateInvoice, hydrateInvoiceLine, like, rollUpLineTax,
  type InvoiceListFilter, type Page, type WriteMeta,
} from './records';
import type { Billing } from './store';
import { TaxRates, type ResolvedRate, type TaxSplit } from './tax';
import type {
  AutomaticTaxStatus, CollectionMethod, Customer, Invoice, InvoiceBillingReason, InvoiceLine, InvoiceLineKind,
  InvoiceLineSource, InvoiceLineTax, InvoiceStatus, LineTaxAmount, PauseBehavior, PendingInvoiceItem,
  RecurringLine, Subscription,
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

/**
 * A draft after the rate engine has been through it. `amount` is now the
 * taxable base — for an inclusive price that is less than the number the
 * pricing engine produced, because the tax has been taken out of it — and
 * `tax` is the snapshot that explains the rest.
 */
export interface TaxedLine extends DraftLine {
  /** One entry per rate that touched the line — see `InvoiceLine.taxes`. */
  taxes: LineTaxAmount[];
  /** Those entries rolled up, so a caller that wants one figure has one. */
  tax: InvoiceLineTax;
}

/** One currency's slice of the invoice book. */
export interface InvoiceCurrencyTotals {
  currency: string;
  billed: number;
  collected: number;
  outstanding: number;
  written_off: number;
  count: number;
}

/**
 * The invoice book at a glance. The money fields are every currency's minor
 * units added together — read `by_currency` for figures that are amounts of
 * something. The counts are counts, so they hold across the whole book.
 */
export interface InvoiceTotals extends Omit<InvoiceCurrencyTotals, 'currency'> {
  untaxed: number;
  missing_tax_location: number;
  held_for_tax_location: number;
  currencies: string[];
  mixed_currency: boolean;
  by_currency: InvoiceCurrencyTotals[];
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

  /**
   * Whether this workspace holds a bill back over a customer location it could
   * not resolve.
   *
   * On by default, because a bill taxed at zero for want of an address is a
   * liability the *supplier* carries, not the customer. A workspace that knows
   * its book is not taxable anywhere turns it off, and the status is still
   * computed, still counted on the overview and still findable with
   * `?tax=missing` — only the hold goes away.
   */
  automaticTaxEnabled(orgId: string): boolean {
    try {
      return this.ctx.svc.core.setting<{ enabled?: boolean }>(orgId, 'billing.automatic_tax', {}).enabled !== false;
    } catch { return true; }
  }

  /** Could the tax on a bill for this account be worked out at all? */
  taxStatusFor(orgId: string, customer: Customer): AutomaticTaxStatus {
    return new TaxRates(this.ctx, orgId).forCustomer(customer).location_known
      ? 'complete'
      : 'requires_location_inputs';
  }

  invoice(orgId: string, id: string): Invoice | null {
    const row = this.ctx.db.get<Record<string, unknown>>(
      `SELECT * FROM billing_invoices WHERE org_id = ? AND id = ?`, orgId, id,
    );
    return row ? hydrateInvoice(row, this.linesOf(orgId, id), this.automaticTaxEnabled(orgId)) : null;
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
    // `missing` is not "no tax was charged": it is "no country could be
    // resolved, so nothing could be worked out", which is the queue a finance
    // team clears before those bills can go out.
    if (filter.tax === 'missing') clauses.push(`i.automatic_tax_status = 'requires_location_inputs'`);
    if (filter.tax === 'zero') clauses.push('i.tax = 0');
    if (filter.tax === 'charged') clauses.push('i.tax != 0');
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
    const enabled = this.automaticTaxEnabled(orgId);
    const data = rows.slice(0, limit).map((row) => hydrateInvoice(row, this.linesOf(orgId, String(row.id)), enabled));
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
    const enabled = this.automaticTaxEnabled(orgId);
    return this.ctx.db.all<Record<string, unknown>>(
      `SELECT * FROM billing_invoices WHERE org_id = ? AND customer_id = ? AND status IN ('draft','open')
        ORDER BY created ASC`, orgId, customerId,
    ).map((row) => hydrateInvoice(row, this.linesOf(orgId, String(row.id)), enabled));
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

  /**
   * What the workspace has collected, is still owed, and has written off.
   *
   * Bucketed by the currency it was billed in, for the same reason the MRR on
   * the overview is: minor units of different currencies are different things.
   * Northwind bills in dollars, euros and pounds, and adding those three
   * columns together produces `billed: 96,853,946` — a number that is not
   * 968,539.46 of anything, and that moves by 98,000 when a ¥98,000 bill is
   * raised. The flat figures are kept because they are what the shape has
   * always published and because the counts beside them are currency-free, but
   * `by_currency` is the one to read and the one to show.
   */
  totals(orgId: string): InvoiceTotals {
    const rows = this.ctx.db.all<Record<string, number | string>>(
      `SELECT
         currency,
         COALESCE(SUM(CASE WHEN status IN ('open','paid','uncollectible') THEN total ELSE 0 END), 0) AS billed,
         COALESCE(SUM(amount_paid), 0) AS collected,
         COALESCE(SUM(CASE WHEN status IN ('draft','open') THEN amount_due ELSE 0 END), 0) AS outstanding,
         COALESCE(SUM(CASE WHEN status = 'uncollectible' THEN total ELSE 0 END), 0) AS written_off,
         COUNT(*) AS count,
         -- A bill that charged no tax at all. Most are right — an exempt
         -- account, a reverse charge, a country nothing is registered in — and
         -- the next two columns are how many of them are not.
         COALESCE(SUM(CASE WHEN tax = 0 AND status != 'void' THEN 1 ELSE 0 END), 0) AS untaxed,
         COALESCE(SUM(CASE WHEN automatic_tax_status = 'requires_location_inputs' AND status != 'void' THEN 1 ELSE 0 END), 0)
           AS missing_tax_location,
         COALESCE(SUM(CASE WHEN automatic_tax_status = 'requires_location_inputs' AND status = 'draft' THEN 1 ELSE 0 END), 0)
           AS held_for_tax_location
       FROM billing_invoices WHERE org_id = ?
       GROUP BY currency ORDER BY currency ASC`, orgId,
    );
    const byCurrency: InvoiceCurrencyTotals[] = rows.map((row) => ({
      currency: String(row.currency),
      billed: Number(row.billed ?? 0),
      collected: Number(row.collected ?? 0),
      outstanding: Number(row.outstanding ?? 0),
      written_off: Number(row.written_off ?? 0),
      count: Number(row.count ?? 0),
    }));
    // Summed here rather than by a second query, so the buckets and the total
    // can never be two different readings of the same book.
    const of = (key: keyof Omit<InvoiceCurrencyTotals, 'currency'>) =>
      byCurrency.reduce((total, row) => total + row[key], 0);
    const counted = (key: string) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
    return {
      billed: of('billed'),
      collected: of('collected'),
      outstanding: of('outstanding'),
      written_off: of('written_off'),
      count: of('count'),
      untaxed: counted('untaxed'),
      missing_tax_location: counted('missing_tax_location'),
      held_for_tax_location: counted('held_for_tax_location'),
      currencies: byCurrency.map((row) => row.currency),
      mixed_currency: byCurrency.length > 1,
      by_currency: byCurrency,
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

  /* ----------------------------------- tax --------------------------------- */

  /**
   * Tax every line by the rate this customer actually pays.
   *
   * One resolution for the whole document — the address, the registration
   * numbers and any exemption are read once — and then one split per line,
   * against the `tax_behavior` the catalog recorded on the price that produced
   * it. An exclusive line keeps its amount and gains tax on top; an inclusive
   * line keeps its *gross* and gives up part of it, so its taxable base drops
   * and the customer pays exactly the listed price. A line with no price behind
   * it (a usage true-up, a manual item) has no behaviour to honour and is
   * treated as exclusive-by-default, which is what `unspecified` means.
   *
   * The rate is snapshotted onto every line rather than referenced, so an
   * invoice raised at 19% still says 19% after the rate is changed to 20%.
   */
  taxDrafts(orgId: string, customer: Customer, drafts: DraftLine[]): TaxedLine[] {
    const rates = new TaxRates(this.ctx, orgId);
    const resolved = rates.forCustomer(customer);
    const book = this.billing.book(orgId);
    const where = describeJurisdiction(customer, resolved);
    return drafts.map((draft) => {
      const behavior: TaxBehavior = draft.price ? book.find(draft.price)?.tax_behavior ?? 'unspecified' : 'unspecified';
      const split = rates.split(draft.amount, behavior, draft.currency, resolved);
      const taxes = snapshotTax(rates, split, where);
      return { ...draft, amount: split.base, taxes, tax: rollUpLineTax(taxes) };
    });
  }

  /**
   * What a set of amounts is worth *on a bill*: the base they will be recorded
   * at and the tax that will sit beside them.
   *
   * The projections — the change preview, the customer summary — have to state
   * numbers the bill will state, and the only way to be sure of that is to run
   * the bill's own call. It goes through `taxDrafts` rather than reaching for
   * the rate engine itself, so there is exactly one implementation of "what
   * does this line cost once tax is on it" and a preview cannot drift from the
   * charge it predicts. An exclusive line comes back with `base` equal to the
   * amount it went in as; an inclusive one comes back with the tax taken out of
   * it, and `base + tax` is the listed price either way.
   */
  taxTotals(
    orgId: string, customer: Customer, lines: { price: string | null; amount: number; currency: string }[],
  ): { base: number; tax: number } {
    if (!lines.length) return { base: 0, tax: 0 };
    const taxed = this.taxDrafts(orgId, customer, lines.map((line) => ({
      source: { type: 'subscription_item' as InvoiceLineSource, id: null },
      subscription: null,
      subscriptionItem: null,
      price: line.price,
      kind: 'recurring' as InvoiceLineKind,
      proration: false,
      description: '',
      explanation: '',
      quantity: 1,
      amount: line.amount,
      currency: line.currency,
      period: { start: 0, end: 0 },
      fraction: null,
      breakdown: [],
    })));
    return {
      base: taxed.reduce((total, line) => total + line.amount, 0),
      tax: taxed.reduce((total, line) => total + line.tax.amount, 0),
    };
  }

  /**
   * The tax columns beside a line's entry list, so the two can never drift.
   *
   * The list is what the line's tax is; these are the same thing rolled into
   * one figure, kept because a credit note, a total and plain SQL all read a
   * line's tax as a single number.
   */
  private taxColumns(tax: InvoiceLineTax, taxes: LineTaxAmount[]): Record<string, unknown> {
    return {
      taxes,
      tax_amount: tax.amount,
      tax_rate: tax.rate,
      tax_percentage: tax.percentage,
      tax_display_name: tax.display_name,
      tax_jurisdiction: tax.jurisdiction,
      tax_type: tax.tax_type,
      tax_behavior: tax.behavior,
      tax_reason: tax.reason,
      tax_explanation: tax.explanation,
    };
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

    const lines = this.taxDrafts(orgId, customer, drafts);
    const taxStatus = this.taxStatusFor(orgId, customer);
    const subtotal = lines.reduce((total, line) => total + line.amount, 0);
    const tax = lines.reduce((total, line) => total + line.tax.amount, 0);
    const starting = customer.balance;
    // One formula, and both invariants fall out of it: the invoice never goes
    // below zero, and whatever the bill, its tax and the balance cannot settle
    // between them stays on the account.
    const total = Math.max(0, subtotal + tax + starting);
    const balanceApplied = total - subtotal - tax;
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
      tax,
      automatic_tax_status: taxStatus,
      balance_applied: balanceApplied,
      total,
      amount_paid: 0,
      amount_due: total,
      pre_payment_credit_notes_amount: 0,
      post_payment_credit_notes_amount: 0,
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

    lines.forEach((line, position) => {
      this.ctx.db.insert('billing_invoice_lines', {
        id: newId('lineitem'),
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
        ...this.taxColumns(line.tax, line.taxes),
        released: 0,
        position,
        created: createdAt,
      });
    });

    if (balanceApplied !== 0) {
      const shown = formatMoney(money(Math.abs(balanceApplied), input.currency), { locale });
      this.billing.adjustBalance(orgId, customer.id, -balanceApplied, {
        type: 'applied_to_invoice',
        description: balanceApplied < 0
          ? `${shown} of account credit applied to invoice ${this.numberFor(orgId, sequence)}`
          // A bill whose lines are worth less than nothing — a mid-cycle
          // downgrade, a cancellation — cannot be a negative invoice, so what
          // it is worth goes onto the account instead of being paid out.
          : subtotal + tax < 0
            ? `${shown} placed on the account by invoice ${this.numberFor(orgId, sequence)}, where it comes off the next bill`
            : `${shown} carried forward onto invoice ${this.numberFor(orgId, sequence)}`,
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

    // A bill Ain could not place is not sent. It stays a draft naming what is
    // missing, because a zero-rated invoice raised out of ignorance is a
    // liability the supplier carries and cannot see.
    //
    // Asked before `mark_uncollectible`, because writing a bill off finalises
    // it: the paused behaviour would otherwise carry a held draft straight into
    // `uncollectible`, where the book counts it as billed and then forgiven.
    // Withdrawing one is still `void`, which is above and stays there.
    if (taxStatus === 'requires_location_inputs' && draft.automatic_tax.enabled) return draft;

    if (input.pauseBehavior === 'mark_uncollectible') return this.markUncollectible(orgId, id, input.meta, createdAt);

    const open = this.finalize(orgId, id, input.meta, createdAt);
    if (open.total === 0) {
      return this.pay(orgId, id, {
        note: subtotal + tax < 0
          ? `Nothing to collect — this bill is worth ${formatMoney(money(-(subtotal + tax), input.currency), { locale })} back to the customer, which went onto the account balance.`
          : 'Nothing to collect — the balance covered it in full.',
        at: createdAt,
      }, input.meta);
    }
    if (input.paidAt !== undefined && input.paidAt !== null) {
      return this.pay(orgId, id, { note: 'Collected on the day it was raised.', at: input.paidAt }, input.meta);
    }
    return open;
  }

  /* ------------------------------ state changes ---------------------------- */

  /**
   * Turn a draft into a bill that is owed.
   *
   * The tax location is asked again here rather than trusted from the moment
   * the draft was drawn: an address put on the account since is exactly what
   * unblocks a held bill, and re-asking is what makes "add the country, then
   * finalise" work without re-raising the invoice.
   */
  finalize(orgId: string, id: string, meta: WriteMeta | undefined, at?: number): Invoice {
    const invoice = this.require(orgId, id);
    if (invoice.status !== 'draft') {
      if (invoice.status === 'open') return invoice;
      throw conflict('invoice_not_draft', `Invoice ${invoice.number} is ${invoice.status}, so there is nothing left to finalise.`, { status: invoice.status });
    }
    const now = at ?? this.ctx.now();
    const customer = this.billing.requireCustomer(orgId, invoice.customer);
    const taxStatus = this.taxStatusFor(orgId, customer);
    // A draft raised before the country was known was taxed at nothing, because
    // there was nothing to tax it at. Letting it through now would turn "we did
    // not know" into a bill that says 0% and means it — the same under-charge,
    // one step further along and harder to see. So it is priced again.
    if (taxStatus === 'complete' && invoice.automatic_tax.status === 'requires_location_inputs') {
      this.retax(orgId, invoice, customer, now);
    }
    if (taxStatus !== invoice.automatic_tax.status) {
      this.ctx.db.patch('billing_invoices', 'id', id, { automatic_tax_status: taxStatus, updated: now });
    }
    if (taxStatus === 'requires_location_inputs' && invoice.automatic_tax.enabled) {
      throw badRequest(
        'customer_tax_location_invalid',
        `Invoice ${invoice.number} cannot be finalised: Ain has no country for ${customer.name}, so the tax on it was never worked out — a zero here would mean "we do not know", not "nothing is due". Put a country on the account (PATCH /v1/customers/${customer.id} with an address) and finalise again, or turn the hold off for the whole workspace with POST /v1/billing/automatic_tax.`,
        'customer',
        { invoice: id, customer: customer.id, automatic_tax_status: taxStatus },
      );
    }
    this.ctx.db.patch('billing_invoices', 'id', id, { status: 'open', finalized_at: now, updated: now });
    this.assertBalanced(orgId, id);
    const after = this.require(orgId, id);
    this.ctx.emit(orgId, 'invoice.finalized', after, {
      objectId: id, objectType: 'invoice', previous: { status: invoice.status },
      actorId: meta?.actorId, actorType: meta?.actorType, requestId: meta?.requestId,
    });
    return after;
  }

  /**
   * Price a held draft again, against the jurisdiction the account now has.
   *
   * Only ever a draft, and only one nobody has paid or credited: a draft is not
   * a document yet, so redrawing it is honest, while re-pricing anything that
   * money has moved against is not. Everything the invoice recorded moves with
   * it — the base, every jurisdiction's tax, the total and the account balance
   * it draws on — so the five identities still hold when it opens.
   */
  private retax(orgId: string, invoice: Invoice, customer: Customer, at: number): void {
    if (invoice.amount_paid !== 0
      || invoice.pre_payment_credit_notes_amount !== 0
      || invoice.post_payment_credit_notes_amount !== 0) {
      throw conflict(
        'invoice_tax_stale',
        `Invoice ${invoice.number} was drawn before ${customer.name} had a country on file, so its lines carry no tax — but money has already moved against it, so it cannot be priced again. Credit it and raise a new bill.`,
        { invoice: invoice.id, customer: customer.id },
      );
    }
    const rates = new TaxRates(this.ctx, orgId);
    const resolved = rates.forCustomer(customer);
    const book = this.billing.book(orgId);
    const where = describeJurisdiction(customer, resolved);
    const locale = this.billing.locale(orgId);

    let subtotal = 0;
    let tax = 0;
    for (const line of invoice.lines) {
      const behavior: TaxBehavior = line.price ? book.find(line.price)?.tax_behavior ?? 'unspecified' : 'unspecified';
      // The held line's `amount` is still the pricing engine's own number: a
      // line taxed at nothing had nothing taken out of it, whatever its
      // behaviour, so this is the same base `issue()` started from.
      const split = rates.split(line.amount, behavior, line.currency, resolved);
      const taxes = snapshotTax(rates, split, where);
      const rolled = rollUpLineTax(taxes);
      this.ctx.db.patch('billing_invoice_lines', 'id', line.id, {
        amount: split.base, ...this.taxColumns(rolled, taxes),
      });
      subtotal += split.base;
      tax += rolled.amount;
    }

    // The credit this bill may draw is the credit the account holds *now*, not
    // what it held on the day the draft was raised. Between the two, another
    // held bill for the same account can have been released and spent it, and
    // `starting_balance` is only a record of a moment that has passed. Pricing
    // against that stale figure hands out credit that is no longer there: two
    // held drafts against one 600.00 credit draw 546.21 and 141.00 between
    // them, the account ends 87.21 in debt nobody agreed to, and each invoice
    // states an `ending_balance` the account itself contradicts. So this bill's
    // own draw is put back first, and taken again from where the account
    // actually stands. A single held draft is untouched by this: nothing has
    // moved, so `customer.balance + balance_applied` is exactly the
    // `starting_balance` it was raised against.
    const starting = customer.balance + invoice.balance_applied;
    const total = Math.max(0, subtotal + tax + starting);
    const balanceApplied = total - subtotal - tax;
    const moved = balanceApplied - invoice.balance_applied;
    if (moved !== 0) {
      this.billing.adjustBalance(orgId, customer.id, -moved, {
        type: 'applied_to_invoice',
        description: `Invoice ${invoice.number} was priced again once ${customer.name} had a country on file, so what it draws from the account moved by ${formatMoney(money(Math.abs(moved), invoice.currency), { locale })}`,
        subscription: invoice.subscription,
        invoice: invoice.id,
        createdAt: at,
      });
    }
    this.ctx.db.patch('billing_invoices', 'id', invoice.id, {
      subtotal, tax, balance_applied: balanceApplied, total, amount_due: total,
      starting_balance: starting, ending_balance: starting - balanceApplied, updated: at,
    });
    this.ctx.emit(orgId, 'invoice.updated', this.require(orgId, invoice.id), {
      objectId: invoice.id, objectType: 'invoice',
      previous: { subtotal: invoice.subtotal, tax: invoice.tax, total: invoice.total },
    });
  }

  /**
   * Collect what is left to collect — never the face value of the bill.
   *
   * A credit note raised before the money arrived took its amount off what the
   * customer was ever going to pay, so recording `total` here would book cash
   * that never landed and overstate the workspace's collected figure by exactly
   * the credited amount. What is collectable is `total` less the pre-payment
   * credit notes, which is what `amount_due` has been carrying all along.
   */
  pay(orgId: string, id: string, opts: { note?: string | null; at?: number } = {}, meta?: WriteMeta): Invoice {
    const invoice = this.require(orgId, id);
    if (invoice.status === 'paid') return invoice;
    if (invoice.status === 'void') {
      throw conflict('invoice_void', `Invoice ${invoice.number} was voided, so it cannot be paid. Raise a new one.`, { status: invoice.status });
    }
    // The sibling of `finalize`. A bill held back for want of a country was
    // never sent, so nobody can have paid it — and recording cash here would
    // walk it straight past the hold into `paid`, untaxed, which is the whole
    // thing the hold exists to stop.
    if (invoice.status === 'draft'
      && invoice.automatic_tax.enabled
      && invoice.automatic_tax.status === 'requires_location_inputs') {
      throw badRequest(
        'customer_tax_location_invalid',
        `Invoice ${invoice.number} is still a draft: Ain has no country for this account, so the tax on it was never worked out and the bill was never sent. Put a country on the account and finalise it, then record the payment.`,
        'customer',
        { invoice: id, customer: invoice.customer, automatic_tax_status: invoice.automatic_tax.status },
      );
    }
    const now = opts.at ?? this.ctx.now();
    const collected = invoice.total - invoice.pre_payment_credit_notes_amount;
    this.ctx.db.patch('billing_invoices', 'id', id, {
      status: 'paid', amount_paid: collected, amount_due: 0,
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
      throw conflict(
        'invoice_paid',
        `Invoice ${invoice.number} has been paid, so withdrawing it would erase a bill the money was collected against. Credit it instead: POST /v1/credit_notes with { "invoice": "${invoice.id}" }.`,
        { status: invoice.status },
      );
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

  /**
   * Write a bill off. It was charged, and it is not going to be collected.
   *
   * The third door out of `draft`, and the same one `finalize` and `pay` hold
   * shut. Writing a bill off finalises it — `finalized_at` is stamped below —
   * and moves it into `uncollectible`, which the book counts as *billed* and
   * then written off. A held draft going through here becomes revenue that was
   * charged at a zero nobody decided on and then forgiven, and it leaves the
   * queue of bills waiting for a country on its way, so the one screen that
   * would have shown the mistake stops showing it.
   *
   * Only a draft is refused. An open bill was sent, whatever Ain knew about the
   * address when it went; writing that one off is a decision about collection,
   * not about tax.
   */
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
    if (invoice.status === 'draft'
      && invoice.automatic_tax.enabled
      && invoice.automatic_tax.status === 'requires_location_inputs') {
      throw badRequest(
        'customer_tax_location_invalid',
        `Invoice ${invoice.number} is still a draft: Ain has no country for this account, so the tax on it was never worked out and the bill was never sent. There is nothing to write off — put a country on the account and finalise it first, or withdraw it with POST /v1/invoices/${id}/void.`,
        'customer',
        { invoice: id, customer: invoice.customer, automatic_tax_status: invoice.automatic_tax.status },
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
   * The five identities, checked against what was actually written rather than
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
    const lineTax = invoice.lines.reduce((total, line) => total + line.tax.amount, 0);
    if (lineTax !== invoice.tax) {
      throw internal(
        `Invoice ${invoice.number}'s lines carry ${lineTax} of tax but its tax total says ${invoice.tax}.`,
        { invoice: id, lines: lineTax, tax: invoice.tax },
      );
    }
    // Every jurisdiction on a line adds up to the line's tax, and every rate on
    // the bill adds up to the bill's. Without the first, a stacked line can
    // charge a number no jurisdiction asked for; without the second, the tax
    // summary a customer reads is not the tax they were charged.
    for (const line of invoice.lines) {
      const entries = line.taxes.reduce((total, entry) => total + entry.amount, 0);
      if (line.taxes.length && entries !== line.tax.amount) {
        throw internal(
          `Invoice ${invoice.number}: "${line.description}" is taxed ${line.tax.amount} but its ${line.taxes.length} jurisdictions add up to ${entries}.`,
          { invoice: id, line: line.id, entries, tax: line.tax.amount },
        );
      }
    }
    const summarised = invoice.total_taxes.reduce((total, row) => total + row.amount, 0);
    if (summarised !== invoice.tax) {
      throw internal(
        `Invoice ${invoice.number}'s tax summary adds up to ${summarised} but its tax total says ${invoice.tax}.`,
        { invoice: id, summary: summarised, tax: invoice.tax },
      );
    }
    if (invoice.subtotal + invoice.tax + invoice.balance_applied !== invoice.total || invoice.total < 0) {
      throw internal(
        `Invoice ${invoice.number} does not reconcile: ${invoice.subtotal} + ${invoice.tax} + ${invoice.balance_applied} is not ${invoice.total}.`,
        {
          invoice: id, subtotal: invoice.subtotal, tax: invoice.tax,
          balance_applied: invoice.balance_applied, total: invoice.total,
        },
      );
    }
    // Cash and credit together account for the whole bill. Without this, an
    // invoice can record more collected than it was ever possible to collect —
    // a credit note raised before payment reduces what arrives, and `amount_paid`
    // is what the workspace's collected figure is summed from.
    if (invoice.status !== 'void'
      && invoice.amount_paid + invoice.pre_payment_credit_notes_amount + invoice.amount_due !== invoice.total) {
      throw internal(
        `Invoice ${invoice.number} does not account for itself: ${invoice.amount_paid} collected + ${invoice.pre_payment_credit_notes_amount} credited before payment + ${invoice.amount_due} still due is not the ${invoice.total} it was billed.`,
        {
          invoice: id, amount_paid: invoice.amount_paid, amount_due: invoice.amount_due,
          pre_payment_credit_notes_amount: invoice.pre_payment_credit_notes_amount, total: invoice.total,
        },
      );
    }
    // Nothing may be credited that was not billed. The ceiling is the bill
    // itself, so an invoice that account credit already paid down cannot hand
    // that same credit back a second time through a credit note.
    const credited = this.ctx.db.count(
      `SELECT COALESCE(SUM(total), 0) FROM billing_credit_notes
        WHERE org_id = ? AND invoice_id = ? AND status = 'issued'`,
      orgId, id,
    );
    if (credited > invoice.total) {
      throw internal(
        `Invoice ${invoice.number} has been credited ${credited}, which is more than the ${invoice.total} it was billed.`,
        { invoice: id, credited, total: invoice.total },
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

/**
 * The place a tax decision was made about, in the words the line will use when
 * there is no rate to name — "Iowa, US" rather than a bare country code, so
 * "why is there no tax on this?" is answered by the invoice.
 */
/**
 * One entry per rate that touched a line.
 *
 * A line that matched no rate still carries one entry, because "nothing is
 * registered for this address" is an answer the invoice has to give and an
 * empty list gives none.
 */
function snapshotTax(rates: TaxRates, split: TaxSplit, where: string | null): LineTaxAmount[] {
  const slices = split.slices.length
    ? split.slices
    : [{ rate: null, reason: split.reason, amount: 0, behavior: split.behavior }];
  return slices.map((slice) => ({
    object: 'invoice_line_tax_amount',
    amount: slice.amount,
    taxable_amount: split.base,
    rate: slice.rate?.id ?? null,
    display_name: slice.rate?.display_name ?? null,
    jurisdiction: slice.rate?.jurisdiction ?? null,
    percentage: slice.rate?.percentage ?? null,
    tax_type: slice.rate?.tax_type ?? null,
    behavior: slice.behavior,
    reason: slice.reason,
    explanation: rates.explainSlice(slice, split.note, where),
  }));
}

function describeJurisdiction(customer: Customer, resolved: ResolvedRate): string | null {
  if (resolved.rate) return resolved.rate.jurisdiction;
  if (!resolved.country) return null;
  const state = customer.address?.state?.trim();
  return state ? `${state}, ${resolved.country}` : resolved.country;
}

