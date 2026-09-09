/**
 * One definition of "still owed" and one of "late", for the whole engine.
 *
 * There were three. The overdue metric tested `due_date IS NOT NULL AND
 * due_date < now` over `status IN (open, past_due, unpaid, uncollectible)` and
 * summed the invoice's face value; the invoice list asked the ledger for
 * `open_like` bills with `due_before`, which is a fourth set again; and
 * "which customers are past due?" started from the *subscription* delinquency
 * flag. At one instant on the demo book those paths answered 1 past-due
 * invoice, 1 past-due invoice and 2 past-due customers, while the collections
 * report — the page a finance team actually works from — aged 3 bills in two
 * currencies. Every one of those numbers was printed as fact.
 *
 * The definition here is the collections report's, because that is the one the
 * rest of the product uses (`src/server/modules/revenue/collections.ts`) and
 * the one the dunning module chases on:
 *
 *  - A receivable is a **finalised** bill that has not been settled. Settled is
 *    paid, voided or written off — an uncollectible bill is a loss, not an
 *    asset, and never belongs in a receivables figure.
 *  - What it is worth is **what is still due**, never the face value: a credit
 *    note or an absorbed account credit reduces the debt and leaves `total`
 *    untouched.
 *  - It is **late** once the day it falls due has passed, and a bill with no
 *    due date is due on receipt — it ages from the day it was finalised. Six of
 *    the seven open bills on the demo book carry no due date, so the
 *    `due_date IS NOT NULL` test was not a filter, it was a blindfold.
 */
import { DAY } from '../../shared/time';
import type { Ctx } from '../kernel/context';
import { billingSources, type InvoiceSource } from './grounding';

export interface ReceivableScope {
  /** SQL predicates, ANDed, against the invoice table with no alias. */
  clauses: string[];
  params: unknown[];
  /** The column holding what is still owed — the only column a receivable is worth. */
  amountColumn: string;
  /** The day the bill falls due, with the due-on-receipt fallbacks the ageing uses. */
  dueExpr: string;
  /**
   * False when this workspace's invoice table cannot express the definition —
   * no amount-due column, so the face value is standing in for the debt. The
   * caller says so rather than quoting the figure as if it were exact.
   */
  exact: boolean;
}

/**
 * The receivables predicate for whichever invoice schema this workspace has.
 *
 * Both tests are applied where the columns exist: the settlement instants,
 * which is how the collections report reconstructs the book at any moment, and
 * the status, which is how a workspace that keeps no such instants records the
 * same thing. They agree on our own ledger; on a partial schema whichever one
 * is available carries the definition alone.
 */
export function receivableScope(invoices: InvoiceSource, at: number, opts: { overdue?: boolean } = {}): ReceivableScope {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const finalized = invoices.finalizedDateColumn;
  if (finalized) {
    clauses.push(`${finalized} IS NOT NULL`, `${finalized} <= ?`);
    params.push(at);
  }
  // Each settlement column is its own way for a bill to leave the book, and
  // missing any one of them puts money back into the total that the business
  // has already stopped expecting.
  for (const column of [invoices.paidDateColumn, invoices.voidedDateColumn, invoices.uncollectibleDateColumn]) {
    if (column) clauses.push(`${column} IS NULL`);
  }
  if (invoices.statusColumn) clauses.push(`${invoices.statusColumn} NOT IN ('draft', 'void', 'deleted', 'paid', 'uncollectible')`);

  const amountColumn = invoices.dueAmountColumn ?? invoices.amountColumn;
  // A bill a credit note has taken down to nothing is off the book even though
  // no one paid it; the ageing report skips those rows and so does this.
  clauses.push(`${amountColumn} > 0`);

  const ageFrom = [...new Set([invoices.dueDateColumn, finalized, invoices.issuedDateColumn, invoices.createdDateColumn].filter((c): c is string => !!c))];
  const dueExpr = ageFrom.length > 1 ? `COALESCE(${ageFrom.join(', ')})` : ageFrom[0] ?? invoices.issuedDateColumn;
  if (opts.overdue) {
    clauses.push(`${dueExpr} <= ?`);
    params.push(at);
  }

  return { clauses, params, amountColumn, dueExpr, exact: !!invoices.dueAmountColumn };
}

export interface OutstandingBill {
  id: string;
  number: string | null;
  customerId: string | null;
  customerName: string | null;
  currency: string;
  /** Minor units still owed. */
  amountDue: number;
  status: string;
  /** The day it falls due — its own, or the day it was finalised when it has none. */
  dueAt: number | null;
  /** Null when the bill is still inside its terms; never negative. */
  daysOverdue: number | null;
  /** True when the due date is the finalisation date standing in — due on receipt. */
  dueOnReceipt: boolean;
}

/**
 * The receivables book, oldest debt first.
 *
 * Oldest first because every reader of this list — a chase letter, a
 * collections queue, the copilot's answer — is working the arrears down from
 * the top.
 */
export function outstandingBills(
  ctx: Ctx,
  orgId: string,
  opts: { customerIds?: string[]; overdueOnly?: boolean; limit?: number } = {},
): { bills: OutstandingBill[]; total: number; books: { currency: string; amount: number; count: number }[]; exact: boolean } {
  const invoices = billingSources(ctx.db).invoices;
  if (!invoices) return { bills: [], total: 0, books: [], exact: true };
  if (opts.customerIds && !opts.customerIds.length) return { bills: [], total: 0, books: [], exact: true };

  const at = ctx.now();
  const scope = receivableScope(invoices, at, { overdue: opts.overdueOnly });
  const clauses = ['org_id = ?', ...scope.clauses];
  const params: unknown[] = [orgId, ...scope.params];
  if (opts.customerIds && invoices.customerColumn) {
    clauses.push(`${invoices.customerColumn} IN (${opts.customerIds.map(() => '?').join(', ')})`);
    params.push(...opts.customerIds);
  }
  const where = clauses.join(' AND ');
  const total = ctx.db.count(`SELECT COUNT(*) FROM ${invoices.table} WHERE ${where}`, ...(params as string[]));
  // One book per currency the debts were raised in. Minor units of two
  // currencies are not the same unit, so there is no scalar to add them into.
  const books = ctx.db.all<{ c: string | null; v: number | null; n: number }>(
    `SELECT ${invoices.currencyColumn ?? `'usd'`} AS c, SUM(${scope.amountColumn}) AS v, COUNT(*) AS n
     FROM ${invoices.table} WHERE ${where} GROUP BY c ORDER BY c`, ...(params as string[]),
  ).map((row) => ({ currency: (row.c ?? 'usd').toLowerCase(), amount: Number(row.v ?? 0), count: Number(row.n) }));

  const rows = ctx.db.all<{
    id: string; num: string | null; cust: string | null; cur: string | null; amt: number | null; st: string | null; due: number | null; own: number | null;
  }>(
    `SELECT id,
            ${invoices.numberColumn ?? 'NULL'} AS num,
            ${invoices.customerColumn ?? 'NULL'} AS cust,
            ${invoices.currencyColumn ?? `'usd'`} AS cur,
            ${scope.amountColumn} AS amt,
            ${invoices.statusColumn ?? `'open'`} AS st,
            ${scope.dueExpr} AS due,
            ${invoices.dueDateColumn ?? 'NULL'} AS own
     FROM ${invoices.table} WHERE ${where} ORDER BY due ASC, id ASC LIMIT ?`,
    ...(params as string[]), Math.min(opts.limit ?? 25, 200),
  );

  const customers = billingSources(ctx.db).customers;
  const names = new Map<string, string>();
  const ids = [...new Set(rows.map((r) => r.cust).filter((c): c is string => !!c))];
  if (customers?.nameColumn && ids.length) {
    for (const row of ctx.db.all<{ id: string; nm: string | null }>(
      `SELECT id, ${customers.nameColumn} AS nm FROM ${customers.table} WHERE org_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
      orgId, ...ids,
    )) if (row.nm) names.set(row.id, row.nm);
  }

  return {
    total,
    books,
    exact: scope.exact,
    bills: rows.map((row) => ({
      id: row.id,
      number: row.num,
      customerId: row.cust,
      customerName: row.cust ? names.get(row.cust) ?? null : null,
      currency: (row.cur ?? 'usd').toLowerCase(),
      amountDue: Number(row.amt ?? 0),
      status: row.st ?? 'open',
      dueAt: row.due,
      daysOverdue: row.due !== null && row.due <= at ? Math.floor((at - row.due) / DAY) : null,
      dueOnReceipt: row.own === null,
    })),
  };
}
