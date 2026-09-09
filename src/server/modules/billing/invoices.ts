/**
 * The bill.
 *
 * Everything else in this module computes a number; this file is where those
 * numbers become something a customer can be charged. An invoice is assembled
 * from four sources and nothing else:
 *
 *  1. the subscription's own recurring lines for the period being entered,
 *     billed in advance and already scaled if the period is a partial one;
 *  2. the proration lines waiting in `billing_pending_items`, claimed here and
 *     stamped `invoiced` so no second invoice can pick them up;
 *  3. whatever the credits module has in its outbox for this customer — the
 *     usage it settled in arrears, the credit it covered, the packs it sold;
 *  4. the invoice items written by hand onto the customer — a setup fee, a
 *     negotiated credit — claimed and stamped exactly as a proration is.
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
import { DAY, startOfDay, type Period } from '../../../shared/time';
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
  AutomaticTaxStatus, CollectionMethod, Customer, Invoice, InvoiceBillingReason, InvoiceItem, InvoiceLine, InvoiceLineKind,
  InvoiceLineSource, InvoiceLineTax, InvoiceStatus, LineTaxAmount, PauseBehavior, PendingInvoiceItem,
  RecurringLine, Subscription,
} from './types';

/** The calls this file makes into the credits module, named so they are obvious. */
export interface CreditsOutbox {
  drainOutbox(orgId: string, customerId: string, invoiceId: string): BillableItem[];
  /** The same lines, read without claiming them — what the upcoming-invoice preview sees. */
  billableItems(orgId: string, filter: { customer?: string; status?: 'pending' | 'invoiced' | 'void'; limit?: number }): BillableItem[];
  /**
   * Where on the price's tier ladder a settled window sat. An allowance is
   * handed out once over a billing period, so a period billed in two windows
   * needs to know how much of it the first window already used up.
   */
  settlement(orgId: string, id: string): { billed_quantity: number; charged_quantity: number; tier_basis: { prior_quantity: number } } | null;
}

/**
 * The one question an invoice asks the entitlement engine: how many units of
 * this meter the customer's plan includes before anything is charged.
 *
 * Declared structurally rather than imported, because entitlements depends on
 * billing and not the other way round — and because naming the four fields a
 * bill actually uses is a better contract than a type with twenty.
 */
export interface AllowanceSource {
  allowanceFor(orgId: string, customerId: string, meter: string): {
    feature: string;
    feature_name: string;
    unit_label: string | null;
    included: number;
    granted_by: string;
  } | null;
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
  /**
   * The behaviour a line with no price behind it carries for itself. Left
   * out, the line is taxed the way the price that produced it says.
   */
  taxBehavior?: TaxBehavior;
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
 * The invoice book at a glance. The money fields are one book's figures — the
 * workspace's own currency, named in `headline_currency` — never minor units
 * added across currencies; `by_currency` carries every book. The counts are
 * counts, so they hold across the whole book.
 */
export interface InvoiceTotals extends Omit<InvoiceCurrencyTotals, 'currency'> {
  /** The currency `billed`, `collected`, `outstanding` and `written_off` are stated in. */
  headline_currency: string;
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
  /**
   * Restrict the invoice-item sweep to these ids. Left out, the bill claims
   * every item waiting for the customer — unless the proration sweep was
   * narrowed, in which case a bill for exactly those prorations carries no
   * hand-written items either.
   */
  invoiceItemIds?: string[];
  /** False leaves the bill as a draft for a person to look over; the default finalises it at once. */
  finalize?: boolean;
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

  /**
   * What is missing from this account's address, named, so the refusal sends
   * whoever reads it to the field they have to fill in.
   *
   * A country-only address in a country registered state by state is as
   * unplaceable as one with no country at all, and telling that account's owner
   * to "put a country on the address" points at the one field that is already
   * right.
   */
  private taxLocationGap(orgId: string, customer: Customer): string {
    const resolved = new TaxRates(this.ctx, orgId).forCustomer(customer);
    return resolved.missing_location === 'state'
      ? `${customer.name}'s address says ${resolved.country} and no state, and ${resolved.country} tax is registered state by state, so Ain cannot tell which jurisdiction the supply is in`
      : `Ain has no country for ${customer.name}, so the tax on it was never worked out`;
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
    // `missing` is not "no tax was charged": it is "the address could not be
    // placed, so the tax on it was never worked out", which is the queue a
    // finance team clears before those bills can go out.
    //
    // A withdrawn bill is off that queue, and the count on the overview has
    // always said so — `missing_tax_location` excludes `void`, exactly as
    // `untaxed` and `held_for_tax_location` do. This filter did not, so the one
    // query the overview's own sentence sends you to went on listing a bill the
    // sentence beside it had stopped counting: void the held draft, which is
    // the escape hatch the hold leaves open, and the book reads "every bill was
    // taxed against an address Ain could place" over a queue that never empties.
    if (filter.tax === 'missing') clauses.push(`i.automatic_tax_status = 'requires_location_inputs' AND i.status != 'void'`);
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
   * Cash that actually settled this account's bills, over its life.
   *
   * `amount_paid` is what was collected and `amount_refunded` what went back:
   * a chargeback reverses the first, a refund is carried in the second and
   * leaves the bill paid, a credit note taken off a bill before payment was
   * never collected into either, and a withdrawn bill keeps whatever was
   * collected on it so a refund can still reach that money — which, until one
   * does, is real. An open bill's total is not in here, because a bill nobody
   * has paid is not value this customer has brought in yet.
   */
  lifetimeCollected(orgId: string, customerId: string): number {
    return this.ctx.db.count(
      `SELECT COALESCE(SUM(amount_paid - amount_refunded), 0) FROM billing_invoices WHERE org_id = ? AND customer_id = ?`,
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
   * raised. So the flat figures are never that sum: on a mixed book they are
   * the workspace's own currency's book alone, named in `headline_currency`,
   * and `by_currency` carries every book. The counts are currency-free and
   * hold across the whole book.
   */
  totals(orgId: string): InvoiceTotals {
    const rows = this.ctx.db.all<Record<string, number | string>>(
      `SELECT
         currency,
         COALESCE(SUM(CASE WHEN status IN ('open','paid','uncollectible') THEN total ELSE 0 END), 0) AS billed,
         COALESCE(SUM(amount_paid - amount_refunded), 0) AS collected,
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
    // Taken from the buckets rather than by a second query, so the headline and
    // its bucket can never be two different readings of the same book. A
    // workspace whose own currency has no bill yet has a zero headline, which
    // is a true figure in that currency — unlike the other books added up.
    const home = this.billing.defaultCurrency(orgId);
    const headline: InvoiceCurrencyTotals = (byCurrency.length === 1 ? byCurrency[0] : byCurrency.find((row) => row.currency === home))
      ?? { currency: home, billed: 0, collected: 0, outstanding: 0, written_off: 0, count: 0 };
    const counted = (key: string) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
    return {
      billed: headline.billed,
      collected: headline.collected,
      outstanding: headline.outstanding,
      written_off: headline.written_off,
      headline_currency: headline.currency,
      count: byCurrency.reduce((total, row) => total + row.count, 0),
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
   * Hand-written lines, priced by nobody. The explanation says so, and shows
   * the arithmetic, because "Setup fee — $1,500.00" with nothing behind it is
   * the one line on a bill a customer is most likely to ask about.
   */
  invoiceItemDrafts(orgId: string, items: InvoiceItem[], fallback: Period): DraftLine[] {
    const locale = this.billing.locale(orgId);
    return items.map((item) => {
      const dated = item.period.end > item.period.start;
      const period = dated ? item.period : fallback;
      const show = (amount: number) => formatMoney(money(amount, item.currency), { locale });
      const arithmetic = item.quantity === 1
        ? show(item.amount)
        : `${item.quantity} × ${show(item.unit_amount)} = ${show(item.amount)}`;
      return {
        source: { type: 'invoice_item' as InvoiceLineSource, id: item.id },
        subscription: item.subscription,
        subscriptionItem: null,
        price: null,
        kind: 'invoice_item' as InvoiceLineKind,
        proration: false,
        description: item.description,
        explanation: `${arithmetic}: ${item.amount < 0 ? 'a credit' : 'a charge'} written by hand on ${longDate(item.created, locale)} rather than priced from the catalogue${
          dated ? `, covering ${describeWindow(period, locale)}` : ''
        }${item.tax_behavior === 'inclusive' ? '. The amount is what the customer pays, tax included' : ''}.`,
        quantity: item.quantity,
        amount: item.amount,
        currency: item.currency,
        period,
        fraction: null,
        breakdown: [],
        taxBehavior: item.tax_behavior,
      };
    });
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
    const out: DraftLine[] = [];
    for (const item of items) {
      const dated = item.period_start !== null && item.period_end !== null;
      const period = dated ? { start: item.period_start as number, end: item.period_end as number } : fallback;
      const kind: InvoiceLineKind = item.kind === 'charged' ? 'usage'
        : item.kind === 'credit_covered' ? 'credit_covered'
          : item.kind === 'topup' ? 'topup' : 'true_up';
      out.push({
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
      });
      const included = this.includedAllowanceDraft(orgId, item, period, subscriptionId, locale);
      if (included) out.push(included);
    }
    return out;
  }

  /**
   * The allowance the plan sold, taken off the metered charge.
   *
   * "25,000,000 telemetry events included each month" is a promise the
   * catalogue makes, the pricing page prints, the Features screen meters
   * against and the entitlement engine enforces — and, until this line existed,
   * the bill ignored completely. The metered price charged from event one on
   * top of a plan fee that had already been paid for the first twenty-five
   * million, which over-billed Northwind's largest account by $7,400.00 in a
   * single period under a screen captioned "never out of step with the bill".
   *
   * The arithmetic, and why it is this and not something simpler:
   *
   *  - The allowance is a quantity, not a discount. Its worth is what the
   *    price's own ladder charges for those units — `f(to) - f(from)` on the
   *    graduated curve — so on Northwind's telemetry price 25,000,000 included
   *    events are worth exactly $7,400.00 and never a flat percentage.
   *  - It is handed out once per billing period, not once per settled window.
   *    `prior_quantity` is where the period's tier ladder had already climbed
   *    to, so a month billed in two pieces takes the two halves of one
   *    allowance and the pieces add back up to the whole.
   *  - It is applied to the ladder positions the *charged* units occupy, which
   *    is what makes it self-clamping: usage entirely inside the allowance
   *    zeroes the line, and the deduction can never make a charge negative.
   *  - It is its own line rather than a smaller `usage` line, because the
   *    settlement that priced the usage is a document too: line and settlement
   *    still state the same charge, and the bill shows the customer the
   *    subtraction instead of a number they cannot reconstruct.
   *
   * Only a `charged` line carries one. A `credit_covered` line already costs
   * nothing, a `topup` is a purchase rather than usage, and a `true_up` — usage
   * that arrived after its window was billed — is priced from a ladder position
   * this cannot reconstruct once several of them have stacked, so it is left
   * alone rather than guessed at. A late arrival inside an allowance the period
   * had not spent is therefore still charged, which is the one case this line
   * does not reach: the allowance belongs in the settlement itself, where the
   * quantity is priced in the first place.
   */
  private includedAllowanceDraft(
    orgId: string, item: BillableItem, period: Period, subscriptionId: string | null, locale: string,
  ): DraftLine | null {
    if (item.kind !== 'charged' || item.billed_amount <= 0 || !item.price || !item.meter) return null;
    const allowance = this.allowances()?.allowanceFor(orgId, item.customer, item.meter);
    if (!allowance || allowance.included <= 0) return null;
    const price = this.ctx.svc.catalog.price(orgId, item.price);
    if (!price) return null;

    // Where this window sat on the period's ladder. Read from the settlement
    // rather than guessed, because a window that started at 20,000,000 has
    // already spent that much of the allowance.
    const settlement = item.settlement ? this.credits()?.settlement(orgId, item.settlement) ?? null : null;
    const prior = Math.max(0, settlement?.tier_basis.prior_quantity ?? 0);
    const charged = Math.max(0, settlement?.charged_quantity ?? Math.round(item.quantity));
    const from = Math.min(prior, allowance.included);
    const to = Math.min(prior + charged, allowance.included);
    const units = to - from;
    if (units <= 0) return null;

    const upTo = (quantity: number): number => (quantity <= 0 ? 0
      : this.ctx.svc.catalog.compute(price, quantity, item.currency, { unitLabel: item.unit_label }).amount);
    const listed = upTo(to) - upTo(from);
    // Capped at what the line actually charges: prepaid credit may already have
    // taken money off it, and an allowance cannot give back more than is there.
    const worth = Math.min(listed, item.billed_amount);
    if (worth <= 0) return null;

    const noun = allowance.unit_label ?? item.unit_label ?? 'unit';
    const count = (value: number) => `${value.toLocaleString('en-US')} ${noun}${value === 1 ? '' : 's'}`;
    const show = (value: number) => formatMoney(money(value, item.currency), { locale });
    return {
      source: { type: 'subscription_item' as InvoiceLineSource, id: null },
      subscription: subscriptionId,
      subscriptionItem: null,
      // The metered price, so the allowance is taxed exactly the way the charge
      // it reduces is taxed and the two net to the tax on what is really owed.
      price: item.price,
      kind: 'included_allowance',
      proration: false,
      description: `${allowance.feature_name} — ${count(allowance.included)}`,
      explanation: `${allowance.granted_by}: ${count(allowance.included)} each period before the metered price charges anything.${
        prior > 0 ? ` ${count(prior)} of the allowance went on an earlier window of this period, so ${count(units)} of it lands here.` : ''
      } On this price's own tiers those ${count(units)} are worth ${show(listed)}${
        worth !== listed ? `, of which ${show(worth)} is all that is left to give back once prepaid credit had taken its share` : ''
      }, which comes off the ${show(item.billed_amount)} charged for ${describeWindow(period, locale)}.`,
      quantity: units,
      amount: -worth,
      currency: item.currency,
      period,
      fraction: null,
      breakdown: [],
    };
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
      const behavior: TaxBehavior = draft.taxBehavior
        ?? (draft.price ? book.find(draft.price)?.tax_behavior ?? 'unspecified' : 'unspecified');
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
    orgId: string, customer: Customer, lines: { price: string | null; amount: number; currency: string; taxBehavior?: TaxBehavior }[],
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
      taxBehavior: line.taxBehavior,
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
    // A bill narrowed to named prorations carries exactly those; every other
    // bill sweeps the hand-written items too, because an item left waiting
    // for "the next invoice" while one is being drawn may never be billed.
    const items = this.billing.invoiceItems.claim(orgId, customer.id, id, {
      ids: input.invoiceItemIds ?? (input.pendingItemIds ? [] : undefined), currency: input.currency,
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

    // A bill raised outside a cycle — `POST /v1/invoices` for an account with
    // no subscription, a credit pack bought on its own — arrives with the
    // instant it was raised as both ends of its period, and an undated line
    // would inherit that zero-length window. Nothing is supplied for no time
    // at all: such a line covers the day it was billed on, and the bill covers
    // whatever its lines cover.
    const fallbackWindow: Period = input.period.end > input.period.start
      ? input.period
      : { start: startOfDay(createdAt), end: startOfDay(createdAt) + DAY };
    const drafts: DraftLine[] = [
      ...this.recurringDrafts(orgId, input.subscription?.id ?? null, input.recurring),
      ...this.prorationDrafts(claimed),
      ...this.usageDrafts(orgId, outbox, input.subscription?.id ?? null, input.arrearsPeriod ?? fallbackWindow),
      ...this.invoiceItemDrafts(orgId, items, fallbackWindow),
    ];
    if (!drafts.length) return null;
    const period: Period = input.subscription ? input.period : spanOf(drafts, fallbackWindow);

    const lines = this.taxDrafts(orgId, customer, drafts);
    const taxStatus = this.taxStatusFor(orgId, customer);
    const { subtotal, tax, total, balanceApplied, ending } = billTotals(lines, customer.balance);
    const starting = customer.balance;

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
      period_start: period.start,
      period_end: period.end,
      arrears_period_start: input.arrearsPeriod?.start ?? null,
      arrears_period_end: input.arrearsPeriod?.end ?? null,
      subtotal,
      tax,
      automatic_tax_status: taxStatus,
      balance_applied: balanceApplied,
      total,
      amount_paid: 0,
      amount_refunded: 0,
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
    // A bill raised for a person to look over before it goes out. Stripe's
    // auto_advance=false: it is a draft until POST /v1/invoices/:id/finalize.
    if (input.finalize === false) return draft;

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
   *
   * The *rate* is asked again for the same reason, and that is a wider door
   * than the one this used to open. Finalisation is where tax resolves —
   * Stripe Tax works this way, and a draft is not a document yet — so a draft
   * is priced against the jurisdiction the account is in **now**, not the one
   * it was in when the draft was drawn. Only the missing-location case was
   * re-priced before, which left the ordinary correction wrong in exactly the
   * way nobody looks for: move an account from Texas to Ireland between
   * raising the draft and finalising it and the bill went out charging 6.25%
   * Texas sales tax on a document that prints a Dublin address, with a
   * `tax_jurisdiction` naming a state the customer does not trade in.
   */
  finalize(orgId: string, id: string, meta: WriteMeta | undefined, at?: number): Invoice {
    const invoice = this.require(orgId, id);
    if (invoice.status !== 'draft') {
      // Answering 200 to a transition that changed nothing hides a double
      // submit, a stale screen or a replayed webhook; Stripe refuses it and
      // names the state, so the caller can tell "done" from "done already".
      if (invoice.status === 'open') {
        throw badRequest(
          'invoice_already_finalized',
          `Invoice ${invoice.number} is already finalised and open, so there is nothing left to finalise. Record its payment with POST /v1/invoices/${id}/pay or withdraw it with POST /v1/invoices/${id}/void.`,
          undefined, { status: invoice.status },
        );
      }
      throw conflict('invoice_not_draft', `Invoice ${invoice.number} is ${invoice.status}, so there is nothing left to finalise.`, { status: invoice.status });
    }
    const now = at ?? this.ctx.now();
    const customer = this.billing.requireCustomer(orgId, invoice.customer);
    const taxStatus = this.taxStatusFor(orgId, customer);
    // A draft raised before the country was known was taxed at nothing, because
    // there was nothing to tax it at. Letting it through now would turn "we did
    // not know" into a bill that says 0% and means it — the same under-charge,
    // one step further along and harder to see. And a draft raised against an
    // address that has since been corrected is the same mistake wearing a
    // number: the document prints the new address and charges the old
    // jurisdiction. Both are the one question "what is this supply taxed at,
    // here, now?", so both are answered here, every time.
    //
    // `retax` writes nothing when the answer has not moved, so the bill this
    // call finalises a millisecond after `issue()` drew it is untouched.
    if (taxStatus === 'complete') this.retax(orgId, invoice, customer, now);
    if (taxStatus !== invoice.automatic_tax.status) {
      this.ctx.db.patch('billing_invoices', 'id', id, { automatic_tax_status: taxStatus, updated: now });
    }
    if (taxStatus === 'requires_location_inputs' && invoice.automatic_tax.enabled) {
      throw badRequest(
        'customer_tax_location_invalid',
        `Invoice ${invoice.number} cannot be finalised: ${this.taxLocationGap(orgId, customer)} — a zero here would mean "we do not know", not "nothing is due". Complete the address (PATCH /v1/customers/${customer.id}) and finalise again, or turn the hold off for the whole workspace with POST /v1/billing/automatic_tax.`,
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
   * Price a draft again, against the jurisdiction the account is in now.
   *
   * Only ever a draft, and only one nobody has paid or credited: a draft is not
   * a document yet, so redrawing it is honest, while re-pricing anything that
   * money has moved against is not. Everything the invoice recorded moves with
   * it — the base, every jurisdiction's tax, the total and the account balance
   * it draws on — so the five identities still hold when it opens.
   *
   * Nothing is written when nothing moved. That is what lets `finalize()` ask
   * this question of *every* draft rather than only of the ones held for want
   * of an address: a bill whose rate has not changed since it was drawn is
   * left exactly as it is, with no `invoice.updated` event announcing a change
   * that did not happen, and the money-has-moved refusal below is reached only
   * by a bill whose numbers really are about to change.
   */
  private retax(orgId: string, invoice: Invoice, customer: Customer, at: number): void {
    const rates = new TaxRates(this.ctx, orgId);
    const resolved = rates.forCustomer(customer);
    const book = this.billing.book(orgId);
    const where = describeJurisdiction(customer, resolved);
    const locale = this.billing.locale(orgId);

    let subtotal = 0;
    let tax = 0;
    const repriced = invoice.lines.map((line) => {
      // A line with a price behind it is taxed the way that price says, and a
      // line with none — a hand-written invoice item — carries its own
      // behaviour, which is the one it was drawn under. Reading the second as
      // `unspecified` re-split an inclusive $1,062.50 item as though it were
      // exclusive: the base went back up to the gross, tax was charged on top
      // of tax the customer had already paid, and the "amount is what the
      // customer pays, tax included" sentence on the line became false. It only
      // bit a held draft before this ran on every finalisation.
      const behavior: TaxBehavior = line.price
        ? book.find(line.price)?.tax_behavior ?? 'unspecified'
        : line.tax.behavior ?? 'unspecified';
      // The number `issue()` started from, rebuilt — not the number the held
      // line happens to carry.
      //
      // "A held line was taxed at nothing, so its `amount` is still the
      // pricing engine's own number" held only while a bill was held for want
      // of a country, when nothing could match. A bill held for want of a
      // *state* can already carry tax, because a country-wide rate matches an
      // address whose state is missing — and an inclusive line's `amount` is
      // then the base with that tax already taken out of it. Re-splitting the
      // base as though it were the listed price bills the customer less than
      // they were quoted and taxes every jurisdiction on the shortfall: a
      // $100.00 inclusive line held at a country-wide 2% and released into
      // 2% + 5.75% ends up a $98.04 bill. An exclusive line's amount is its base either way, which
      // is why this is a no-op for every bill raised before the state hold.
      const priced = line.tax.behavior === 'inclusive' ? line.amount + line.tax.amount : line.amount;
      const split = rates.split(priced, behavior, line.currency, resolved);
      const taxes = snapshotTax(rates, split, where);
      const rolled = rollUpLineTax(taxes);
      subtotal += split.base;
      tax += rolled.amount;
      return { line, base: split.base, taxes, rolled };
    });

    // The rate the draft already carries is the rate it should go out at, so
    // the draft goes out untouched. Compared line by line rather than on the
    // totals: two jurisdictions can swap a bill's tax between them and leave
    // the total identical, and an invoice that names the wrong authority is
    // wrong however well it adds up.
    const unchanged = repriced.every(({ line, base, rolled, taxes }) =>
      base === line.amount
      && rolled.amount === line.tax.amount
      && rolled.rate === line.tax.rate
      && rolled.jurisdiction === line.tax.jurisdiction
      && rolled.percentage === line.tax.percentage
      && taxes.length === line.taxes.length
      && taxes.every((entry, i) => entry.rate === line.taxes[i].rate && entry.amount === line.taxes[i].amount));
    if (unchanged) return;

    if (invoice.amount_paid !== 0
      || invoice.pre_payment_credit_notes_amount !== 0
      || invoice.post_payment_credit_notes_amount !== 0) {
      throw conflict(
        'invoice_tax_stale',
        `Invoice ${invoice.number} was drawn against a different tax position than ${customer.name} holds now, so finalising it would send a bill charging a jurisdiction the document does not name — but money has already moved against it, so it cannot be priced again. Credit it and raise a new bill.`,
        { invoice: invoice.id, customer: customer.id },
      );
    }

    for (const { line, base, taxes, rolled } of repriced) {
      this.ctx.db.patch('billing_invoice_lines', 'id', line.id, {
        amount: base, ...this.taxColumns(rolled, taxes),
      });
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
        description: `Invoice ${invoice.number} was priced again against ${customer.name}'s tax position at finalisation, so what it draws from the account moved by ${formatMoney(money(Math.abs(moved), invoice.currency), { locale })}`,
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
    if (invoice.status === 'paid') {
      throw badRequest(
        'invoice_already_paid',
        `Invoice ${invoice.number} is already paid in full, so recording another payment would count the same money twice. To hand money back, refund the charge (POST /v1/refunds) or credit the bill (POST /v1/credit_notes).`,
        undefined, { status: invoice.status },
      );
    }
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
        `Invoice ${invoice.number} is still a draft: Ain could not place this account's address, so the tax on it was never worked out and the bill was never sent. Complete the address — a country, and a state in a country whose tax is registered state by state — and finalise it, then record the payment.`,
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
   * Record cash handed back on a bill, without reopening it.
   *
   * Stripe's rule, and the right one: a bill the customer settled is settled.
   * The refund is a fact about the payment — it is recorded on the charge and
   * carried here in `amount_refunded` — not a fact about what was billed, so
   * `total`, `amount_paid` and `amount_due` do not move and `status` stays
   * `paid`. Nothing is queued for collection, because nothing is owed: a
   * customer who was given money back and then owes it again is owed it on a
   * new invoice a person raises, not on the old one quietly reopened under a
   * recovery campaign. Reducing the bill itself, and the tax on it, is a
   * credit note's job.
   *
   * A part-paid open bill and a withdrawn bill holding cash can give money
   * back the same way — the cash is real wherever the document stands — but
   * never more than they collected and have not already returned.
   */
  recordRefund(
    orgId: string, id: string, amount: number,
    opts: { note?: string | null; refund?: string | null; at?: number } = {}, meta?: WriteMeta,
  ): Invoice {
    const invoice = this.require(orgId, id);
    const locale = this.billing.locale(orgId);
    const show = (value: number) => formatMoney(money(value, invoice.currency), { locale });
    if (!Number.isInteger(amount) || amount <= 0) {
      throw badRequest('amount_invalid', 'A refund has to be for a positive whole number of minor units.', 'amount');
    }
    const refundable = invoice.amount_paid - invoice.amount_refunded;
    if (amount > refundable) {
      throw badRequest(
        'refund_exceeds_collected',
        refundable <= 0
          ? `Invoice ${invoice.number} holds no cash to give back: ${show(invoice.amount_paid)} was collected on it and ${show(invoice.amount_refunded)} has already gone back.`
          : `${show(amount)} is more than invoice ${invoice.number} can give back. ${show(invoice.amount_paid)} was collected on it${
            invoice.amount_refunded > 0 ? ` and ${show(invoice.amount_refunded)} has already gone back` : ''
          }, so at most ${show(refundable)} can be refunded now.`,
        'amount',
        { invoice: id, amount_paid: invoice.amount_paid, amount_refunded: invoice.amount_refunded, refundable: Math.max(0, refundable) },
      );
    }
    const now = opts.at ?? this.ctx.now();
    const refunded = invoice.amount_refunded + amount;
    this.ctx.db.patch('billing_invoices', 'id', id, {
      amount_refunded: refunded,
      payment_note: opts.note ?? invoice.payment_note,
      updated: now,
    });
    this.assertBalanced(orgId, id);
    const after = this.require(orgId, id);
    this.ctx.emit(orgId, 'invoice.refunded', {
      invoice: after.id, number: after.number, customer: after.customer, subscription: after.subscription,
      amount, currency: after.currency, amount_refunded: after.amount_refunded, amount_paid: after.amount_paid,
      amount_due: after.amount_due, status: after.status, refund: opts.refund ?? null, note: opts.note ?? null,
      resolution: `${show(amount)} of what was collected on ${after.number} went back to the customer${
        refunded >= after.amount_paid ? ', which is everything the bill collected' : ''
      }. The bill stays ${after.status}: what was billed and what was paid are unchanged, and nothing is queued for collection. If the customer owes this money again, raise a new invoice for it.`,
    }, {
      objectId: id, objectType: 'invoice',
      previous: { amount_refunded: invoice.amount_refunded },
      actorId: meta?.actorId, actorType: meta?.actorType, requestId: meta?.requestId,
    });
    return after;
  }

  /**
   * Withdraw a bill that should never have been sent. The balance it drew down
   * goes back where it came from, because a voided invoice consumed nothing.
   *
   * A bill with a credit note standing against it is refused for the same
   * reason a paid one is: the note is a numbered document that was already
   * sent, and withdrawing the bill under it leaves a correction pointing at
   * nothing. Nothing here reaches into the notes, because a reader that counts
   * them does not read through the invoice — `revenue/collections` sums
   * `billing_credit_notes` on their own while excluding voided invoices from
   * everything else, so the month goes on reporting a credit against a bill it
   * no longer says was billed. Voiding the notes first is the sequence that
   * leaves both books saying the same thing.
   */
  voidInvoice(orgId: string, id: string, meta?: WriteMeta, at?: number): Invoice {
    const invoice = this.require(orgId, id);
    if (invoice.status === 'void') {
      throw badRequest(
        'invoice_already_void',
        `Invoice ${invoice.number} was already voided, so there is nothing left to withdraw.`,
        undefined, { status: invoice.status },
      );
    }
    if (invoice.status === 'paid') {
      throw conflict(
        'invoice_paid',
        `Invoice ${invoice.number} has been paid, so withdrawing it would erase a bill the money was collected against. Credit it instead: POST /v1/credit_notes with { "invoice": "${invoice.id}" }.`,
        { status: invoice.status },
      );
    }
    const standing = this.ctx.db.all<{ id: string; number: string; total: number }>(
      `SELECT id, number, total FROM billing_credit_notes
        WHERE org_id = ? AND invoice_id = ? AND status = 'issued' ORDER BY sequence ASC`,
      orgId, id,
    );
    if (standing.length) {
      const worth = formatMoney(
        money(standing.reduce((total, note) => total + Number(note.total), 0), invoice.currency),
        { locale: this.billing.locale(orgId) },
      );
      throw conflict(
        'invoice_has_credit_notes',
        `Invoice ${invoice.number} has ${standing.length === 1 ? 'a credit note' : `${standing.length} credit notes`} standing against it (${standing.map((note) => note.number).join(', ')}, ${worth}), so withdrawing it would leave a correction the customer has already been sent pointing at a bill that no longer exists — and the credit would go on being reported against a bill that is not. Withdraw ${standing.length === 1 ? 'it' : 'them'} first with POST /v1/credit_notes/${standing[0].id}/void, then void this.`,
        { status: invoice.status, credit_notes: standing.map((note) => note.id) },
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
    if (invoice.status === 'uncollectible') {
      throw badRequest(
        'invoice_already_uncollectible',
        `Invoice ${invoice.number} was already written off, so there is nothing left to write off.`,
        undefined, { status: invoice.status },
      );
    }
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
        `Invoice ${invoice.number} is still a draft: Ain could not place this account's address, so the tax on it was never worked out and the bill was never sent. There is nothing to write off — complete the address and finalise it first, or withdraw it with POST /v1/invoices/${id}/void.`,
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
    // A withdrawn bill is owed nothing. It is the one identity the clause below
    // exempts void invoices from, so nothing else was left asserting it — and
    // `CreditNotes.void()` recomputes `amount_due` from `total` without ever
    // asking whether the bill it is putting back is still standing.
    if (invoice.status === 'void' && invoice.amount_due !== 0) {
      throw internal(
        `Invoice ${invoice.number} was withdrawn but says ${invoice.amount_due} is still due on it.`,
        { invoice: id, amount_due: invoice.amount_due, status: invoice.status },
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
    // Cash can only go back once, and only if it came in: a refund is carried
    // beside `amount_paid` rather than taken off it, so the pair has to be
    // asserted together or a bill could hand back money it never held.
    if (invoice.amount_refunded < 0 || invoice.amount_refunded > invoice.amount_paid) {
      throw internal(
        `Invoice ${invoice.number} records ${invoice.amount_refunded} refunded against ${invoice.amount_paid} collected, so money has gone back that was never collected on it.`,
        { invoice: id, amount_paid: invoice.amount_paid, amount_refunded: invoice.amount_refunded },
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
    this.billing.invoiceItems.release(orgId, invoiceId);
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

  /** The same, read-only, for the two places that price usage without claiming it. */
  credits(): CreditsOutbox | null {
    return this.creditsOutbox();
  }

  /**
   * The entitlement engine, if this workspace runs one.
   *
   * Reached the way credits and payments are, and for the same reason: billing
   * has to draw a bill in a deployment where the module is not installed. What
   * is lost when it is absent is the allowance line, and a workspace with no
   * entitlement engine has no allowance to lose.
   */
  private allowances(): AllowanceSource | null {
    const registry = this.ctx.svc as { entitlements?: AllowanceSource };
    return registry.entitlements ?? null;
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

/**
 * What a taxed set of lines is worth as a bill, once the account balance has
 * been drawn against it.
 *
 * One formula, and both invariants fall out of it: the invoice never goes below
 * zero, and whatever the bill, its tax and the balance cannot settle between
 * them stays on the account. It is a function, exported and called from both
 * `issue()` and the upcoming-invoice preview, for the same reason proration and
 * its preview are one function — a projection that recomputes the arithmetic
 * agrees with the charge only until one of the two copies is edited.
 */
export function billTotals(
  lines: TaxedLine[], startingBalance: number,
): { subtotal: number; tax: number; total: number; balanceApplied: number; ending: number } {
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const tax = lines.reduce((sum, line) => sum + line.tax.amount, 0);
  const total = Math.max(0, subtotal + tax + startingBalance);
  const balanceApplied = total - subtotal - tax;
  return { subtotal, tax, total, balanceApplied, ending: startingBalance - balanceApplied };
}

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

/** The window a set of lines covers: from the earliest start to the latest end of the lines that have one. */
function spanOf(lines: DraftLine[], fallback: Period): Period {
  const dated = lines.filter((line) => line.period.end > line.period.start);
  if (!dated.length) return fallback;
  return {
    start: Math.min(...dated.map((line) => line.period.start)),
    end: Math.max(...dated.map((line) => line.period.end)),
  };
}
