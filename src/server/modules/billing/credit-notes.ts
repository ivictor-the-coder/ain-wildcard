/**
 * Credit notes — the only legal way to reduce a finalised invoice.
 *
 * An invoice in this module is write-once on purpose: once it is finalised it
 * is a statement of what was billed, and quietly editing it would make every
 * number downstream of it a guess. A credit note is the document that corrects
 * one without rewriting it. It names the invoice, names the *lines* it reduces,
 * carries a reason, and is numbered in its own gapless sequence, so a
 * correction can be sent to the customer and reconciled years later.
 *
 * Three rules decide everything here:
 *
 *  1. **Nothing may be credited that was not billed.** Every credit line points
 *     at an invoice line and can never exceed what that line still has left to
 *     credit, and no note may exceed what the invoice as a whole still has left.
 *     Both are refused with a 400 that says what the remaining amount is —
 *     never clamped, because a clamp turns "I asked for the wrong number" into
 *     "the system silently disagreed with me".
 *  2. **Where the money goes depends on whether it was collected.** On a bill
 *     that has not been paid the credit comes off `amount_due` — the customer
 *     simply owes less. On one that has been paid there is nothing left to
 *     reduce, so the value goes onto the customer's balance and comes off the
 *     next invoice. The note records which of the two happened and by how much.
 *  3. **The preview and the note are one function.** `preview()` and `issue()`
 *     both build the same draft; `issue()` is `preview()` plus the writes. A
 *     quote and a correction cannot disagree, for the same reason a proration
 *     preview and its charge cannot.
 */
import type { Ctx } from '../../kernel/context';
import type { Bindable } from '../../kernel/db';
import { badRequest, conflict, internal, notFound } from '../../../shared/errors';
import { cursorOf, newId, parseCursor, randomId } from '../../../shared/ids';
import { allocate, formatMoney, money, mulFraction } from '../../../shared/money';
import { hydrateCreditNote, hydrateCreditNoteLine, type Page, type WriteMeta } from './records';
import { orgPrefix } from './invoices';
import type { Billing } from './store';
import { formatPercentage } from './tax';
import type {
  CreditNote, CreditNoteLine, CreditNoteReason, Invoice, InvoiceLine,
} from './types';

/* ---------------------------------- inputs -------------------------------- */

export interface CreditNoteLineInput {
  invoice_line_item: string;
  /**
   * The gross amount to take off this line, tax included. Left out, the line is
   * credited in full — or by `quantity`, if that is given instead.
   */
  amount?: number;
  /** Credit this many of the line's units, priced pro rata. */
  quantity?: number;
}

export interface CreditNoteInput {
  invoice: string;
  /** The total to credit, tax included. Allocated across the invoice's lines. */
  amount?: number;
  lines?: CreditNoteLineInput[];
  reason?: CreditNoteReason;
  memo?: string | null;
  metadata?: Record<string, string>;
}

export interface CreditNoteListFilter {
  invoice?: string;
  customer?: string;
  status?: 'issued' | 'void' | 'all';
  limit?: number;
  cursor?: string | null;
}

/** One line of a note before it has an id. */
interface DraftCreditLine {
  invoiceLine: InvoiceLine;
  description: string;
  explanation: string;
  quantity: number;
  amount: number;
  taxAmount: number;
}

/** What `preview()` returns and `issue()` writes. */
export interface CreditNoteDraft {
  invoice: Invoice;
  lines: DraftCreditLine[];
  subtotal: number;
  tax: number;
  total: number;
  /** What the invoice would still have left to credit afterwards. */
  remaining_after: number;
  /** What the invoice had left to credit before this note. */
  creditable_before: number;
  routing: 'pre_payment' | 'post_payment';
  reason: CreditNoteReason;
  memo: string | null;
}

/* --------------------------------- the store ------------------------------ */

export class CreditNotes {
  constructor(private readonly ctx: Ctx, private readonly billing: Billing) {}

  /* --------------------------------- reading ------------------------------ */

  linesOf(orgId: string, creditNoteId: string): CreditNoteLine[] {
    return this.ctx.db.all<Record<string, unknown>>(
      `SELECT * FROM billing_credit_note_lines WHERE org_id = ? AND credit_note_id = ? ORDER BY position ASC, rowid ASC`,
      orgId, creditNoteId,
    ).map(hydrateCreditNoteLine);
  }

  get(orgId: string, id: string): CreditNote | null {
    const row = this.ctx.db.get<Record<string, unknown>>(
      `SELECT * FROM billing_credit_notes WHERE org_id = ? AND id = ?`, orgId, id,
    );
    return row ? hydrateCreditNote(row, this.linesOf(orgId, id)) : null;
  }

  require(orgId: string, id: string): CreditNote {
    const found = this.get(orgId, id);
    if (!found) throw notFound('credit note', id);
    return found;
  }

  list(orgId: string, filter: CreditNoteListFilter = {}): Page<CreditNote> {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.invoice) { clauses.push('invoice_id = ?'); params.push(filter.invoice); }
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.status && filter.status !== 'all') { clauses.push('status = ?'); params.push(filter.status); }
    const where = clauses.join(' AND ');
    const totalCount = this.ctx.db.count(`SELECT COUNT(*) FROM billing_credit_notes WHERE ${where}`, ...(params as string[]));

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
      `SELECT * FROM billing_credit_notes WHERE ${where}${cursorClause} ORDER BY created DESC, id DESC LIMIT ?`,
      ...(paged as string[]), limit + 1,
    );
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map((row) => hydrateCreditNote(row, this.linesOf(orgId, String(row.id))));
    const last = data[data.length - 1];
    return { data, hasMore, nextCursor: hasMore && last ? cursorOf(last.created, last.id) : null, totalCount };
  }

  /** What a customer has been credited back over their life, notes voided aside. */
  lifetimeCredited(orgId: string, customerId: string): number {
    return this.ctx.db.count(
      `SELECT COALESCE(SUM(total), 0) FROM billing_credit_notes
        WHERE org_id = ? AND customer_id = ? AND status = 'issued'`,
      orgId, customerId,
    );
  }

  /** Everything issued against one invoice, in money terms. */
  issuedAgainst(orgId: string, invoiceId: string): number {
    return this.ctx.db.count(
      `SELECT COALESCE(SUM(total), 0) FROM billing_credit_notes
        WHERE org_id = ? AND invoice_id = ? AND status = 'issued'`,
      orgId, invoiceId,
    );
  }

  /* ------------------------------- creditability -------------------------- */

  /**
   * What one line still has left to credit: the gross it was billed for, less
   * everything already credited off it by notes that are still standing.
   *
   * A line whose gross is negative — the unused-time half of a mid-cycle change
   * — has nothing to credit. It is already a credit, and reducing it would mean
   * charging the customer more with a document called a credit note.
   */
  private creditableLine(orgId: string, line: InvoiceLine): number {
    const gross = line.amount + line.tax.amount;
    if (gross <= 0) return 0;
    const alreadyCredited = this.ctx.db.count(
      `SELECT COALESCE(SUM(l.amount + l.tax_amount), 0) FROM billing_credit_note_lines l
         JOIN billing_credit_notes n ON n.id = l.credit_note_id
        WHERE l.org_id = ? AND l.invoice_line_id = ? AND n.status = 'issued'`,
      orgId, line.id,
    );
    return Math.max(0, gross - alreadyCredited);
  }

  /**
   * What the invoice as a whole still has left to credit.
   *
   * The ceiling is `total`, not the sum of the lines: when account credit
   * already covered part of the bill, `balance_applied` took that money off it
   * and it was never charged, so it cannot be given back a second time.
   */
  creditable(orgId: string, invoice: Invoice): number {
    return Math.max(0, invoice.total - this.issuedAgainst(orgId, invoice.id));
  }

  /* --------------------------------- drafting ----------------------------- */

  /**
   * Work out the note without writing anything. Both `preview` and `issue` go
   * through here, which is what makes the preview provably the same arithmetic.
   */
  draft(orgId: string, input: CreditNoteInput): CreditNoteDraft {
    const invoice = this.billing.invoices.require(orgId, input.invoice);
    const locale = this.billing.locale(orgId);
    const show = (amount: number) => formatMoney(money(amount, invoice.currency), { locale });

    if (invoice.status === 'draft') {
      throw badRequest(
        'credit_note_invoice_draft',
        `Invoice ${invoice.number} is still a draft, so there is nothing to credit — edit or void the draft instead. A credit note corrects a bill that has already been finalised.`,
        'invoice',
      );
    }
    if (invoice.status === 'void') {
      throw badRequest(
        'credit_note_invoice_void',
        `Invoice ${invoice.number} was voided, so it is not owed and cannot be credited.`,
        'invoice',
      );
    }
    if ((input.amount === undefined) === (input.lines === undefined)) {
      throw badRequest(
        'credit_note_amount_or_lines',
        'A credit note needs either an amount to credit or the lines to credit — send one of the two, not both and not neither.',
        input.amount === undefined ? 'amount' : 'lines',
      );
    }

    const creditableBefore = this.creditable(orgId, invoice);
    if (creditableBefore <= 0) {
      throw badRequest(
        'credit_note_nothing_creditable',
        `Invoice ${invoice.number} has already been credited in full (${show(invoice.total)}), so there is nothing left to credit.`,
        'invoice',
      );
    }

    const targets = input.lines
      ? this.targetsFromLines(orgId, invoice, input.lines, show)
      : this.targetsFromAmount(orgId, invoice, input.amount as number, show);

    const total = targets.reduce((sum, t) => sum + t.gross, 0);
    if (total <= 0) {
      throw badRequest('credit_note_amount_zero', 'A credit note has to credit something. The amount worked out to zero.', 'amount');
    }
    if (total > creditableBefore) {
      throw badRequest(
        'credit_note_amount_too_large',
        `${show(total)} is more than invoice ${invoice.number} has left to credit. It was billed ${show(invoice.total)}${
          invoice.pre_payment_credit_notes_amount + invoice.post_payment_credit_notes_amount > 0
            ? `, ${show(invoice.pre_payment_credit_notes_amount + invoice.post_payment_credit_notes_amount)} of that has already been credited`
            : ''
        }, so at most ${show(creditableBefore)} can be credited now.`,
        'amount',
        { creditable: creditableBefore, requested: total, invoice_total: invoice.total },
      );
    }

    const lines: DraftCreditLine[] = targets.map(({ line, gross, quantity }) => {
      const { base, tax } = splitGross(gross, line);
      return {
        invoiceLine: line,
        description: line.description,
        explanation: explainCredit(line, invoice, gross, tax, quantity, show),
        quantity,
        amount: base,
        taxAmount: tax,
      };
    });

    const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
    const tax = lines.reduce((sum, l) => sum + l.taxAmount, 0);
    if (subtotal + tax !== total) {
      throw internal(
        `A credit note's lines add up to ${subtotal + tax} but its total says ${total}.`,
        { invoice: invoice.id, subtotal, tax, total },
      );
    }

    return {
      invoice,
      lines,
      subtotal,
      tax,
      total,
      creditable_before: creditableBefore,
      remaining_after: creditableBefore - total,
      // Nothing has been collected on an open or written-off bill, so the credit
      // reduces what is owed. On a paid one the money is already in, so the only
      // honest place for it is the customer's balance.
      routing: invoice.status === 'paid' ? 'post_payment' : 'pre_payment',
      reason: input.reason ?? 'billing_error',
      memo: input.memo ?? null,
    };
  }

  private targetsFromLines(
    orgId: string, invoice: Invoice, inputs: CreditNoteLineInput[], show: (amount: number) => string,
  ): { line: InvoiceLine; gross: number; quantity: number }[] {
    const seen = new Set<string>();
    return inputs.map((entry) => {
      const line = invoice.lines.find((l) => l.id === entry.invoice_line_item);
      if (!line) {
        throw badRequest(
          'credit_note_line_not_on_invoice',
          `Line ${entry.invoice_line_item} is not on invoice ${invoice.number}. A credit note can only credit lines of the invoice it names.`,
          'lines',
        );
      }
      if (seen.has(line.id)) {
        throw badRequest(
          'credit_note_line_duplicated',
          `Line ${line.id} appears twice in this credit note. Send one entry per invoice line, with the total to credit off it.`,
          'lines',
        );
      }
      seen.add(line.id);

      const gross = line.amount + line.tax.amount;
      const creditable = this.creditableLine(orgId, line);
      if (creditable <= 0) {
        throw badRequest(
          'credit_note_line_not_creditable',
          gross <= 0
            ? `"${line.description}" is already a credit of ${show(-gross)} on ${invoice.number}; crediting it would charge the customer more.`
            : `"${line.description}" on ${invoice.number} has already been credited in full.`,
          'lines',
          { invoice_line_item: line.id, creditable },
        );
      }
      if (entry.amount !== undefined && entry.quantity !== undefined) {
        throw badRequest(
          'credit_note_line_amount_or_quantity',
          'Credit a line by amount or by quantity, not both — they would have to agree, and if they did one of them is redundant.',
          'lines',
        );
      }

      let requested: number;
      let quantity = line.quantity;
      if (entry.amount !== undefined) {
        requested = entry.amount;
      } else if (entry.quantity !== undefined) {
        if (entry.quantity > line.quantity) {
          throw badRequest(
            'credit_note_line_quantity_too_large',
            `"${line.description}" billed ${line.quantity}, so ${entry.quantity} cannot be credited off it.`,
            'lines',
            { invoice_line_item: line.id, billed_quantity: line.quantity },
          );
        }
        quantity = entry.quantity;
        // Priced from the gross so the credit and the charge round the same way.
        requested = mulFraction(money(gross, line.currency), entry.quantity, line.quantity).amount;
      } else {
        requested = creditable;
      }

      if (requested <= 0) {
        throw badRequest(
          'credit_note_line_amount_zero',
          `The amount to credit off "${line.description}" worked out to nothing. A credit note line has to credit something.`,
          'lines',
          { invoice_line_item: line.id },
        );
      }
      if (requested > creditable) {
        throw badRequest(
          'credit_note_line_amount_too_large',
          `${show(requested)} is more than "${line.description}" has left to credit on ${invoice.number}. It was billed ${show(gross)}${
            creditable < gross ? ` and ${show(gross - creditable)} of that is already credited` : ''
          }, so at most ${show(creditable)} can come off it.`,
          'lines',
          { invoice_line_item: line.id, creditable, requested },
        );
      }
      return { line, gross: requested, quantity };
    });
  }

  /**
   * A bare amount is spread across the invoice's lines in proportion to what
   * each still has left to credit, and the remainder pennies are handed out by
   * `allocate` so the lines add back up to the amount asked for exactly. That
   * is more work than recording one lump sum, and it is the difference between
   * a credit note that can be reconciled line by line and one that cannot.
   */
  private targetsFromAmount(
    orgId: string, invoice: Invoice, amount: number, show: (amount: number) => string,
  ): { line: InvoiceLine; gross: number; quantity: number }[] {
    if (amount <= 0) {
      throw badRequest('credit_note_amount_invalid', 'The amount to credit has to be a positive number of minor units.', 'amount');
    }
    const candidates = invoice.lines
      .map((line) => ({ line, creditable: this.creditableLine(orgId, line) }))
      .filter((entry) => entry.creditable > 0);
    const available = candidates.reduce((sum, entry) => sum + entry.creditable, 0);
    if (amount > available) {
      throw badRequest(
        'credit_note_amount_too_large',
        `${show(amount)} is more than the lines of invoice ${invoice.number} have left to credit (${show(available)}).`,
        'amount',
        { creditable: available, requested: amount },
      );
    }
    const shares = allocate(money(amount, invoice.currency), candidates.map((entry) => entry.creditable));
    return candidates
      .map((entry, index) => ({ line: entry.line, gross: shares[index].amount, quantity: entry.line.quantity }))
      .filter((entry) => entry.gross !== 0);
  }

  /* --------------------------------- writing ------------------------------ */

  /** The note as it would be, with nothing written. */
  preview(orgId: string, input: CreditNoteInput): CreditNote {
    const draft = this.draft(orgId, input);
    const now = this.ctx.now();
    return {
      object: 'credit_note',
      id: 'preview',
      number: 'PREVIEW',
      sequence: 0,
      invoice: draft.invoice.id,
      customer: draft.invoice.customer,
      currency: draft.invoice.currency,
      status: 'issued',
      reason: draft.reason,
      memo: draft.memo,
      lines: draft.lines.map((line, index) => ({
        object: 'credit_note_line_item' as const,
        id: `preview_${index}`,
        credit_note: 'preview',
        invoice_line_item: line.invoiceLine.id,
        description: line.description,
        explanation: line.explanation,
        quantity: line.quantity,
        amount: line.amount,
        tax_amount: line.taxAmount,
        amount_including_tax: line.amount + line.taxAmount,
        tax_rate: line.invoiceLine.tax.rate,
        tax_percentage: line.invoiceLine.tax.percentage,
        tax_display_name: line.invoiceLine.tax.display_name,
        tax_behavior: line.invoiceLine.tax.behavior,
        tax_reason: line.invoiceLine.tax.reason,
        currency: line.invoiceLine.currency,
      })),
      subtotal: draft.subtotal,
      tax: draft.tax,
      total: draft.total,
      pre_payment_amount: draft.routing === 'pre_payment' ? draft.total : 0,
      post_payment_amount: draft.routing === 'post_payment' ? draft.total : 0,
      balance_transaction: null,
      invoice_status_at_issue: draft.invoice.status,
      voided_at: null,
      metadata: input.metadata ?? {},
      created: now,
      updated: now,
      livemode: draft.invoice.livemode,
    };
  }

  /**
   * Write the note and move the money.
   *
   * Everything lands in one transaction: the note, its lines, the invoice's new
   * `amount_due` or the customer's new balance, and the invariant check that
   * refuses to let an invoice that no longer adds up be committed.
   */
  issue(orgId: string, input: CreditNoteInput, meta: WriteMeta = {}): CreditNote {
    return this.ctx.atomic(() => {
      const draft = this.draft(orgId, input);
      const invoice = draft.invoice;
      const now = this.ctx.now();
      const locale = this.billing.locale(orgId);
      const show = (amount: number) => formatMoney(money(amount, invoice.currency), { locale });
      const id = newId('credit');

      this.ctx.db.insert('billing_credit_notes', {
        id,
        org_id: orgId,
        sequence: 0,
        number: id,
        invoice_id: invoice.id,
        customer_id: invoice.customer,
        currency: invoice.currency,
        status: 'issued',
        reason: draft.reason,
        memo: draft.memo,
        subtotal: draft.subtotal,
        tax: draft.tax,
        total: draft.total,
        pre_payment_amount: draft.routing === 'pre_payment' ? draft.total : 0,
        post_payment_amount: draft.routing === 'post_payment' ? draft.total : 0,
        balance_transaction_id: null,
        invoice_status_at_issue: invoice.status,
        voided_at: null,
        metadata: input.metadata ?? {},
        created: now,
        updated: now,
        livemode: invoice.livemode ? 1 : 0,
      });
      // Numbered after the row exists, under the same lock, so the sequence can
      // never be handed to two notes.
      const sequence = this.ctx.db.count(
        `SELECT COALESCE(MAX(sequence), 0) + 1 FROM billing_credit_notes WHERE org_id = ?`, orgId,
      );
      const number = this.numberFor(orgId, sequence);
      this.ctx.db.patch('billing_credit_notes', 'id', id, { sequence, number });

      draft.lines.forEach((line, position) => {
        this.ctx.db.insert('billing_credit_note_lines', {
          id: randomId('cnl'),
          org_id: orgId,
          credit_note_id: id,
          invoice_line_id: line.invoiceLine.id,
          description: line.description,
          explanation: line.explanation,
          quantity: line.quantity,
          amount: line.amount,
          tax_amount: line.taxAmount,
          tax_rate: line.invoiceLine.tax.rate,
          tax_percentage: line.invoiceLine.tax.percentage,
          tax_display_name: line.invoiceLine.tax.display_name,
          tax_behavior: line.invoiceLine.tax.behavior,
          tax_reason: line.invoiceLine.tax.reason,
          currency: line.invoiceLine.currency,
          position,
          created: now,
        });
      });

      if (draft.routing === 'pre_payment') {
        this.applyPrePayment(orgId, invoice, draft.total, number, now, meta);
      } else {
        const txn = this.billing.adjustBalance(orgId, invoice.customer, -draft.total, {
          type: 'credit_note',
          description: `${show(draft.total)} credited by ${number} against invoice ${invoice.number}`,
          subscription: invoice.subscription,
          invoice: invoice.id,
          createdAt: now,
        });
        this.ctx.db.patch('billing_invoices', 'id', invoice.id, {
          post_payment_credit_notes_amount: invoice.post_payment_credit_notes_amount + draft.total,
          updated: now,
        });
        this.ctx.db.patch('billing_credit_notes', 'id', id, { balance_transaction_id: txn.id });
      }

      this.billing.invoices.assertBalanced(orgId, invoice.id);
      const note = this.require(orgId, id);
      this.ctx.emit(orgId, 'credit_note.created', note, {
        objectId: id, objectType: 'credit_note',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return note;
    });
  }

  /**
   * Reduce what is owed, and settle the bill if the credit covers all of it.
   *
   * A bill whose remaining balance has been credited to nothing is not owed any
   * more, so it stops being open — but `amount_paid` stays where it is, because
   * no money was collected. That distinction is the difference between "we
   * collected $100" and "we billed $100 and then credited it".
   */
  private applyPrePayment(
    orgId: string, invoice: Invoice, amount: number, number: string, at: number, meta: WriteMeta,
  ): void {
    const preCredited = invoice.pre_payment_credit_notes_amount + amount;
    const amountDue = invoice.total - invoice.amount_paid - preCredited;
    this.ctx.db.patch('billing_invoices', 'id', invoice.id, {
      pre_payment_credit_notes_amount: preCredited,
      amount_due: amountDue,
      updated: at,
    });
    if (amountDue !== 0 || invoice.status !== 'open') return;
    this.ctx.db.patch('billing_invoices', 'id', invoice.id, {
      status: 'paid',
      paid_at: at,
      payment_note: `Settled in full by credit note ${number} — nothing was collected.`,
    });
    const settled = this.billing.invoices.require(orgId, invoice.id);
    this.ctx.emit(orgId, 'invoice.paid', settled, {
      objectId: invoice.id, objectType: 'invoice', previous: { status: invoice.status },
      actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
    });
  }

  /**
   * Withdraw a note that should not have been written, and put back exactly
   * what it took: the amount comes back onto `amount_due`, or off the balance it
   * was pushed onto, and an invoice the note had settled goes back to open.
   */
  void(orgId: string, id: string, meta: WriteMeta = {}): CreditNote {
    return this.ctx.atomic(() => {
      const note = this.require(orgId, id);
      if (note.status === 'void') return note;
      const invoice = this.billing.invoices.require(orgId, note.invoice);
      const now = this.ctx.now();
      const locale = this.billing.locale(orgId);
      const show = (amount: number) => formatMoney(money(amount, note.currency), { locale });

      this.ctx.db.patch('billing_credit_notes', 'id', id, { status: 'void', voided_at: now, updated: now });

      if (note.pre_payment_amount > 0) {
        const preCredited = invoice.pre_payment_credit_notes_amount - note.pre_payment_amount;
        const changes: Record<string, Bindable> = {
          pre_payment_credit_notes_amount: preCredited,
          amount_due: invoice.total - invoice.amount_paid - preCredited,
          updated: now,
        };
        // The note had settled the bill, so withdrawing it makes it owed again.
        if (invoice.status === 'paid' && invoice.amount_paid < invoice.total) {
          changes.status = 'open';
          changes.paid_at = null;
          changes.payment_note = `Reopened when credit note ${note.number} was voided.`;
        }
        this.ctx.db.patch('billing_invoices', 'id', invoice.id, changes);
      } else {
        this.billing.adjustBalance(orgId, note.customer, note.post_payment_amount, {
          type: 'credit_note_voided',
          description: `${show(note.post_payment_amount)} taken back when credit note ${note.number} was voided`,
          subscription: invoice.subscription,
          invoice: invoice.id,
          createdAt: now,
        });
        this.ctx.db.patch('billing_invoices', 'id', invoice.id, {
          post_payment_credit_notes_amount: invoice.post_payment_credit_notes_amount - note.post_payment_amount,
          updated: now,
        });
      }

      this.billing.invoices.assertBalanced(orgId, invoice.id);
      const after = this.require(orgId, id);
      this.ctx.emit(orgId, 'credit_note.voided', after, {
        objectId: id, objectType: 'credit_note', previous: { status: note.status },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return after;
    });
  }

  /* -------------------------------- internals ----------------------------- */

  /** `NR-CN-000007` — the invoice prefix, marked as a credit, gapless. */
  private numberFor(orgId: string, sequence: number): string {
    let name = 'Invoice';
    try { name = this.ctx.svc.core.org(orgId).name || 'Invoice'; } catch { /* org gone, prefix falls back */ }
    return `${orgPrefix(name)}-CN-${String(sequence).padStart(6, '0')}`;
  }
}

/* --------------------------------- helpers -------------------------------- */

/**
 * Split a gross credit into the base and the tax it is made of, in the same
 * proportion the line was billed in. `allocate` guarantees the two halves add
 * back up to the gross exactly, so a partial credit of a taxed line can never
 * leave a penny stranded.
 */
function splitGross(gross: number, line: InvoiceLine): { base: number; tax: number } {
  const lineTax = line.tax.amount;
  if (lineTax === 0) return { base: gross, tax: 0 };
  const [base, tax] = allocate(money(gross, line.currency), [line.amount, lineTax]);
  return { base: base.amount, tax: tax.amount };
}

function explainCredit(
  line: InvoiceLine, invoice: Invoice, gross: number, tax: number, quantity: number,
  show: (amount: number) => string,
): string {
  const lineGross = line.amount + line.tax.amount;
  const whole = gross === lineGross;
  const head = whole
    ? `The whole of "${line.description}" on invoice ${invoice.number} — ${show(lineGross)} — is credited back.`
    : `${show(gross)} of the ${show(lineGross)} charged for "${line.description}" on invoice ${invoice.number} is credited back${
      quantity !== line.quantity ? `, being ${quantity} of the ${line.quantity} billed` : ''
    }.`;
  if (tax === 0 || !line.tax.percentage) return head;
  return `${head} ${show(tax)} of that is ${line.tax.display_name ?? 'tax'} at ${formatPercentage(line.tax.percentage)}%, credited with it.`;
}
