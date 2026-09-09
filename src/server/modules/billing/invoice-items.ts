/**
 * Invoice items — lines written by hand, waiting for a bill.
 *
 * A subscription bill is assembled from the catalogue: the period's recurring
 * lines, the prorations a change left waiting, the usage the credits module
 * settled. None of those can say "a setup fee of $1,500 we agreed on the
 * phone" or "a $200 goodwill credit for the outage", and a finance team that
 * cannot raise that bill raises it somewhere else. This is Stripe's invoice
 * item: an amount and a description on a customer, priced by nobody, that
 * lands on the customer's next invoice exactly the way a proration does — or
 * on a bill raised for it on the spot with `POST /v1/invoices`.
 *
 * Three rules keep it honest:
 *
 *  1. **An item is in the customer's currency, or it is refused.** A bill
 *     carries one currency, and a line that is not in it cannot be on it.
 *  2. **An item is claimed by exactly one bill.** It is stamped with the
 *     invoice that swept it, and released again only when that invoice is
 *     voided — the same hold a proration has.
 *  3. **An item carries its own tax behaviour**, because there is no price
 *     behind it to read one from. `exclusive` adds tax on top of the amount;
 *     `inclusive` keeps the amount as the customer's gross and takes the tax
 *     out of it; `unspecified` is exclusive, as it is everywhere else here.
 */
import type { Ctx } from '../../kernel/context';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { cursorOf, newId, parseCursor } from '../../../shared/ids';
import { formatMoney, money } from '../../../shared/money';
import type { TaxBehavior } from '../catalog/types';
import { hydrateInvoiceItem, type Page, type WriteMeta } from './records';
import type { Billing } from './store';
import type { InvoiceItem, InvoiceItemStatus } from './types';

/* ---------------------------------- inputs -------------------------------- */

export interface InvoiceItemInput {
  customer: string;
  description: string;
  /** The whole line, signed. Exactly one of `amount` and `unit_amount` is given. */
  amount?: number;
  /** Per unit, signed, multiplied by `quantity`. */
  unit_amount?: number;
  quantity?: number;
  /** Must be the customer's own currency; that is the only currency a bill of theirs can carry. */
  currency?: string;
  tax_behavior?: TaxBehavior;
  period?: { start: number; end: number };
  subscription?: string;
  metadata?: Record<string, string>;
}

export interface InvoiceItemListFilter {
  customer?: string;
  subscription?: string;
  invoice?: string;
  status?: InvoiceItemStatus | 'all';
  limit?: number;
  cursor?: string | null;
}

/* --------------------------------- the store ------------------------------ */

export class InvoiceItems {
  constructor(private readonly ctx: Ctx, private readonly billing: Billing) {}

  /* --------------------------------- reading ------------------------------ */

  get(orgId: string, id: string): InvoiceItem | null {
    const row = this.ctx.db.get<Record<string, unknown>>(
      `SELECT * FROM billing_invoice_items WHERE org_id = ? AND id = ?`, orgId, id,
    );
    return row ? hydrateInvoiceItem(row) : null;
  }

  require(orgId: string, id: string): InvoiceItem {
    const found = this.get(orgId, id);
    if (!found) throw notFound('invoice item', id);
    return found;
  }

  list(orgId: string, filter: InvoiceItemListFilter = {}): Page<InvoiceItem> {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.subscription) { clauses.push('subscription_id = ?'); params.push(filter.subscription); }
    if (filter.invoice) { clauses.push('invoice_id = ?'); params.push(filter.invoice); }
    // Withdrawn items are kept as the record that they were withdrawn, and
    // shown only when asked for by name. Asked for by invoice, the answer is
    // the bill's items, which are by definition no longer waiting.
    const status = filter.status ?? (filter.invoice ? 'all' : 'pending');
    if (status !== 'all') { clauses.push('status = ?'); params.push(status); }
    const where = clauses.join(' AND ');
    const totalCount = this.ctx.db.count(`SELECT COUNT(*) FROM billing_invoice_items WHERE ${where}`, ...(params as string[]));

    const paged = [...params];
    let cursorClause = '';
    if (filter.cursor) {
      const parsed = parseCursor(filter.cursor);
      if (!parsed) throw badRequest('cursor_invalid', 'That pagination cursor is not readable. Start the list again.', 'cursor');
      cursorClause = ' AND (created < ? OR (created = ? AND id < ?))';
      paged.push(parsed.createdAt, parsed.createdAt, parsed.id);
    }
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 200);
    const rows = this.ctx.db.all<Record<string, unknown>>(
      `SELECT * FROM billing_invoice_items WHERE ${where}${cursorClause} ORDER BY created DESC, id DESC LIMIT ?`,
      ...(paged as string[]), limit + 1,
    );
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(hydrateInvoiceItem);
    const last = data[data.length - 1];
    return { data, hasMore, nextCursor: hasMore && last ? cursorOf(last.created, last.id) : null, totalCount };
  }

  /** Every item waiting for this customer's next bill, oldest first — the order they go onto it. */
  pending(orgId: string, customerId: string, limit = 500): InvoiceItem[] {
    return this.ctx.db.all<Record<string, unknown>>(
      `SELECT * FROM billing_invoice_items WHERE org_id = ? AND customer_id = ? AND status = 'pending'
        ORDER BY created ASC, rowid ASC LIMIT ?`,
      orgId, customerId, Math.min(Math.max(limit, 1), 500),
    ).map(hydrateInvoiceItem);
  }

  /* --------------------------------- writing ------------------------------ */

  create(orgId: string, input: InvoiceItemInput, meta: WriteMeta = {}): InvoiceItem {
    return this.ctx.atomic(() => {
      const customer = this.billing.requireCustomer(orgId, input.customer);
      const locale = this.billing.locale(orgId);
      const now = this.ctx.now();

      if ((input.amount === undefined) === (input.unit_amount === undefined)) {
        throw badRequest(
          'invoice_item_amount_or_unit_amount',
          'An invoice item is priced either as one amount for the whole line or as a unit amount times a quantity — send amount, or unit_amount with quantity, not both and not neither.',
          input.amount === undefined ? 'amount' : 'unit_amount',
        );
      }
      if (input.amount !== undefined && input.quantity !== undefined && input.quantity !== 1) {
        throw badRequest(
          'invoice_item_amount_with_quantity',
          'amount is the whole line, so it cannot also be multiplied by a quantity. Send unit_amount with quantity to price a line per unit.',
          'quantity',
        );
      }
      if (!input.description.trim()) {
        throw badRequest('invoice_item_description_required', 'An invoice item needs a description: it is the words the customer reads on the bill.', 'description');
      }
      const quantity = input.quantity ?? 1;
      const unitAmount = input.unit_amount ?? (input.amount as number);
      const amount = input.amount ?? unitAmount * quantity;
      if (amount === 0) {
        throw badRequest('invoice_item_amount_zero', 'An invoice item has to charge or credit something. The line worked out to zero.', 'amount');
      }

      const currency = (input.currency ?? customer.currency).toLowerCase();
      if (currency !== customer.currency) {
        throw badRequest(
          'invoice_item_currency_mismatch',
          `${customer.name} is billed in ${customer.currency.toUpperCase()}, so a ${currency.toUpperCase()} line cannot go on their invoice. Price it in ${customer.currency.toUpperCase()}.`,
          'currency',
          { customer_currency: customer.currency },
        );
      }

      const subscription = input.subscription ? this.billing.requireSubscription(orgId, input.subscription) : null;
      if (subscription && subscription.customer !== customer.id) {
        throw badRequest(
          'subscription_customer_mismatch',
          `Subscription ${subscription.id} belongs to ${subscription.customer}, not to ${customer.id}.`,
          'subscription',
        );
      }

      if (input.period && input.period.end < input.period.start) {
        throw badRequest('invoice_item_period_invalid', 'The period an invoice item covers has to end after it starts.', 'period');
      }
      // Undated: both ends are the instant it was written, and the bill that
      // sweeps it dates the line on the day it is billed — the same rule an
      // undated usage line follows.
      const period = input.period ?? { start: now, end: now };

      const id = newId('invoiceitem');
      this.ctx.db.insert('billing_invoice_items', {
        id,
        org_id: orgId,
        customer_id: customer.id,
        subscription_id: subscription?.id ?? null,
        description: input.description.trim(),
        quantity,
        unit_amount: unitAmount,
        amount,
        currency,
        tax_behavior: input.tax_behavior ?? 'unspecified',
        period_start: period.start,
        period_end: period.end,
        status: 'pending',
        invoice_id: null,
        metadata: input.metadata ?? {},
        created: now,
        updated: now,
        livemode: meta.livemode === false ? 0 : 1,
      });
      const item = this.require(orgId, id);
      this.ctx.emit(orgId, 'invoice_item.created', {
        ...item,
        amount_display: formatMoney(money(item.amount, item.currency), { locale }),
      }, {
        objectId: id, objectType: 'invoice_item',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return item;
    });
  }

  /**
   * Withdraw an item no bill has picked up. One already on an invoice is
   * refused: the bill is the document now, and the way to take a line off a
   * finalised bill is a credit note, not the quiet removal of what it claimed.
   */
  delete(orgId: string, id: string, meta: WriteMeta = {}): InvoiceItem {
    return this.ctx.atomic(() => {
      const item = this.require(orgId, id);
      if (item.status === 'deleted') {
        throw badRequest('invoice_item_already_deleted', `Invoice item ${id} was already withdrawn.`, undefined, { status: item.status });
      }
      if (item.status === 'invoiced') {
        const invoice = item.invoice ? this.billing.invoices.invoice(orgId, item.invoice) : null;
        throw conflict(
          'invoice_item_invoiced',
          `This item is already on invoice ${invoice?.number ?? item.invoice}, so it cannot be withdrawn on its own. ${
            invoice?.status === 'draft'
              ? `Void the draft with POST /v1/invoices/${item.invoice}/void and the item goes back to waiting.`
              : `Credit the line with POST /v1/credit_notes, or void the bill if it should never have been sent.`
          }`,
          { invoice: item.invoice, status: item.status },
        );
      }
      const now = this.ctx.now();
      this.ctx.db.patch('billing_invoice_items', 'id', id, { status: 'deleted', updated: now });
      const after = this.require(orgId, id);
      this.ctx.emit(orgId, 'invoice_item.deleted', after, {
        objectId: id, objectType: 'invoice_item', previous: { status: item.status },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return after;
    });
  }

  /* --------------------------------- claiming ----------------------------- */

  /**
   * Claim a customer's waiting items onto a bill: stamp them `invoiced`, point
   * them at it, and hand back exactly what was claimed. `ids` narrows the claim
   * to a named set, for a bill that carries exactly those and nothing else;
   * `currency` keeps a claim from ever outrunning what the bill can carry.
   */
  claim(orgId: string, customerId: string, invoiceId: string, opts: { ids?: string[]; currency?: string } = {}): InvoiceItem[] {
    const items = this.pending(orgId, customerId)
      .filter((item) => (opts.currency ? item.currency === opts.currency : true))
      .filter((item) => (opts.ids ? opts.ids.includes(item.id) : true));
    const now = this.ctx.now();
    for (const item of items) {
      this.ctx.db.patch('billing_invoice_items', 'id', item.id, { status: 'invoiced', invoice_id: invoiceId, updated: now });
    }
    return items.map((item) => ({ ...item, status: 'invoiced' as InvoiceItemStatus, invoice: invoiceId }));
  }

  /** The mirror of `claim`: a voided bill lets go of the items it swept, so the replacement can carry them. */
  release(orgId: string, invoiceId: string): number {
    return this.ctx.db.run(
      `UPDATE billing_invoice_items SET status = 'pending', invoice_id = NULL, updated = ?
        WHERE org_id = ? AND invoice_id = ? AND status = 'invoiced'`,
      this.ctx.now(), orgId, invoiceId,
    ).changes;
  }
}
