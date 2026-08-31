/**
 * The reader.
 *
 * Revenue owns no table. Everything it publishes is assembled here out of
 * billing's subscriptions, invoices and proration ledger, payments' dunning
 * history, credits' settlement ledger and metering's meters — which is why
 * every response carries a `sources` block naming the row counts it read. If a
 * number looks wrong, the block says exactly which rows to go and count.
 */
import type { Ctx } from '../../kernel/context';
import { rat, ratRound } from '../../../shared/money';
import { startOfMonth } from '../../../shared/time';
import { Pricebook } from '../billing/cycle';
import { billingStore } from '../billing/module';
import type { Subscription } from '../billing/types';
import { instantsOf, monthGrid, resolveRange, type MonthCell, type Range } from './grid';
import { ratio } from './ratio';
import { buildMatrix, churnSeries, cohortMatrix, movementSeries, type RevenueMatrix } from './movement';
import { recognise, scheduleFor, type RecognitionLine, type RecognitionReport } from './recognition';
import {
  ageBook, collectionsReport, recoveryReport, type CollectionsReport, type InvoiceRow,
} from './collections';
import { usageReport, type UsageReport } from './usage';
import {
  annualise, buildTimeline, readContractChanges, type ContractChange, type SubscriptionTimeline,
} from './timeline';

/** More subscriptions than any workspace this platform is built for. */
const MAX_SUBSCRIPTIONS = 5_000;

export interface RevenueQuery {
  from?: number;
  to?: number;
  currency?: string;
  months?: number;
}

export interface CurrencyBasis {
  mode: 'single' | 'mixed';
  reporting: string;
  currencies: string[];
  note: string;
}

export interface Basis {
  summary: string;
  rules: string[];
  currency: CurrencyBasis;
}

export type Sources = Record<string, number>;

export interface Envelope {
  as_of: number;
  range: { from: number; to: number; months: number };
  currency: string;
  basis: Basis;
  sources: Sources;
  /** True when the book was larger than this module will read in one request. */
  truncated: boolean;
}

/* --------------------------------- helpers -------------------------------- */

const meanOf = (values: number[]): number =>
  values.length ? Number(ratRound(rat(values.reduce((sum, v) => sum + v, 0), values.length), 'half_up')) : 0;

/**
 * Every workspace here sells in more than one currency, and there is no rate
 * table in this platform to convert them with — inventing one would be the
 * single most dishonest thing a revenue report could do. So a mixed request
 * sums minor units across currencies, exactly as `/v1/subscriptions/overview`
 * does, and says so in every response; `?currency=eur` gives a figure that
 * needs no caveat.
 */
function currencyBasis(requested: string | undefined, reporting: string, present: string[]): CurrencyBasis {
  if (requested) {
    return {
      mode: 'single',
      reporting: requested,
      currencies: [requested],
      note: `Only ${requested.toUpperCase()} subscriptions and invoices are in scope, so every figure is a real ${requested.toUpperCase()} amount.`,
    };
  }
  if (present.length <= 1) {
    return {
      mode: 'single',
      reporting,
      currencies: present.length ? present : [reporting],
      note: `The whole book bills in ${(present[0] ?? reporting).toUpperCase()}, so no conversion arises.`,
    };
  }
  return {
    mode: 'mixed',
    reporting,
    currencies: present,
    note:
      `This workspace bills in ${present.map((c) => c.toUpperCase()).join(', ')}. There is no exchange-rate table in ` +
      'this platform, so nothing is converted: totals are minor units added across currencies, the same convention ' +
      '/v1/subscriptions/overview uses. Pass ?currency=' + present[0] + ' for a figure that needs no caveat, or read ' +
      'the by_currency block, which is exact.',
  };
}

/* ---------------------------------- store --------------------------------- */

export interface CustomerRow {
  id: string;
  name: string;
  currency: string;
  created: number;
}

export interface Book {
  range: Range;
  cells: MonthCell[];
  instants: number[];
  timelines: SubscriptionTimeline[];
  subscriptions: Subscription[];
  customers: Map<string, CustomerRow>;
  names: Map<string, string>;
  matrix: RevenueMatrix;
  changes: ContractChange[];
  currencies: string[];
  reporting: string;
  requested: string | undefined;
  truncated: boolean;
  now: number;
}

export class Revenue {
  constructor(private readonly ctx: Ctx) {}

  reportingCurrency(orgId: string): string {
    try { return this.ctx.svc.core.currency(orgId); }
    catch { return 'usd'; }
  }

  /**
   * Everything a report needs, read once.
   *
   * Building the whole month grid up front — not just the requested window —
   * is what makes a cohort matrix possible: a cohort that signed in 2024 has to
   * be readable at every month since, and the opening figure for the first
   * month in a range has to come from before it.
   */
  book(orgId: string, query: RevenueQuery, opts: { fullHistory?: boolean } = {}): Book {
    const now = this.ctx.now();
    const range = resolveRange(query, now, query.months ?? 12);
    const requested = query.currency?.toLowerCase();

    const ids = this.ctx.db.all<{ id: string }>(
      `SELECT id FROM billing_subscriptions WHERE org_id = ? ORDER BY start_date ASC, id ASC LIMIT ?`,
      orgId, MAX_SUBSCRIPTIONS + 1,
    ).map((row) => row.id);
    const truncated = ids.length > MAX_SUBSCRIPTIONS;

    const store = billingStore(this.ctx).billing;
    const priced = new Pricebook(this.ctx, orgId);
    const subscriptions: Subscription[] = [];
    for (const id of ids.slice(0, MAX_SUBSCRIPTIONS)) {
      const sub = store.subscription(orgId, id);
      if (!sub) continue;
      if (requested && sub.currency !== requested) continue;
      subscriptions.push(sub);
    }

    const changesBySub = readContractChanges(this.ctx, orgId, priced);
    const timelines = subscriptions.map((sub) => buildTimeline(sub, priced, changesBySub.get(sub.id) ?? []));

    const customers = new Map<string, CustomerRow>();
    for (const row of this.ctx.db.all<CustomerRow>(
      `SELECT id, name, currency, created FROM billing_customers WHERE org_id = ?`, orgId,
    )) {
      if (requested && row.currency !== requested) continue;
      customers.set(row.id, row);
    }
    const names = new Map([...customers].map(([id, row]) => [id, row.name]));

    // The grid runs from the first month anything was sold, so cohorts and
    // openings both have somewhere to read from.
    const earliest = timelines.reduce(
      (min, line) => (line.segments.length ? Math.min(min, line.segments[0].from) : min),
      range.from,
    );
    const gridFrom = opts.fullHistory ? Math.min(earliest, range.from) : range.from;
    const cells = monthGrid(gridFrom, range.to, now);
    const instants = instantsOf(cells);
    const matrix = buildMatrix(timelines, instants);

    const currencies = [...new Set(subscriptions.map((sub) => sub.currency))].sort();

    return {
      range,
      cells,
      instants,
      timelines,
      subscriptions,
      customers,
      names,
      matrix,
      changes: timelines.flatMap((line) => line.changes),
      currencies,
      reporting: requested ?? this.reportingCurrency(orgId),
      requested,
      truncated,
      now,
    };
  }

  /** The month cells inside the requested window, for a book built full-history. */
  windowOf(book: Book): MonthCell[] {
    const first = startOfMonth(book.range.from);
    return book.cells.filter((cell) => cell.start >= first);
  }

  private envelope(book: Book, summary: string, rules: string[], sources: Sources, over?: MonthCell[]): Envelope {
    const cells = over ?? this.windowOf(book);
    return {
      as_of: book.now,
      range: { from: cells.length ? cells[0].start : book.range.from, to: book.range.to, months: cells.length },
      currency: book.reporting,
      basis: {
        summary,
        rules,
        currency: currencyBasis(book.requested, book.reporting, book.currencies),
      },
      truncated: book.truncated,
      sources: {
        billing_subscriptions: book.subscriptions.length,
        billing_customers: book.customers.size,
        billing_pending_items_contract_changes: book.changes.length,
        months_in_series: cells.length,
        ...sources,
      },
    };
  }

  /* --------------------------------- MRR --------------------------------- */

  mrr(orgId: string, query: RevenueQuery, prebuilt?: Book) {
    const book = prebuilt ?? this.book(orgId, query);
    const cells = this.windowOf(book);
    const usage = this.usageRunRate(orgId, book, cells);

    const seriesAt = (index: number) => {
      const column = index + 1;
      let mrr = 0, accounts = 0;
      for (const row of book.matrix.values.values()) {
        const amount = row[column];
        mrr += amount;
        if (amount !== 0) accounts += 1;
      }
      return { mrr, accounts };
    };

    const offset = book.cells.length - cells.length;
    const series = cells.map((cell, i) => {
      const { mrr, accounts } = seriesAt(offset + i);
      return {
        month: cell.key,
        at: cell.at,
        complete: cell.complete,
        mrr,
        arr: annualise(mrr),
        accounts,
        average_mrr_per_account: accounts ? Number(ratRound(rat(mrr, accounts), 'half_up')) : 0,
      };
    });

    const live = book.timelines.filter((line) => line.current_mrr !== 0);
    const mrrNow = live.reduce((sum, line) => sum + line.current_mrr, 0);
    const byCurrency = [...new Set(book.timelines.map((line) => line.currency))].sort().map((currency) => {
      const lines = book.timelines.filter((line) => line.currency === currency);
      const amount = lines.reduce((sum, line) => sum + line.current_mrr, 0);
      return {
        currency,
        mrr: amount,
        arr: annualise(amount),
        subscriptions: lines.filter((line) => line.current_mrr !== 0).length,
        accounts: new Set(lines.filter((line) => line.current_mrr !== 0).map((line) => line.customer)).size,
      };
    });

    const cadences = new Map<string, { interval: string; interval_count: number; subscriptions: number; mrr: number }>();
    for (const line of book.timelines) {
      if (line.current_mrr === 0) continue;
      const key = `${line.interval_count}:${line.interval}`;
      const cell = cadences.get(key) ?? { interval: line.interval, interval_count: line.interval_count, subscriptions: 0, mrr: 0 };
      cell.subscriptions += 1;
      cell.mrr += line.current_mrr;
      cadences.set(key, cell);
    }

    const statuses = new Map<string, { status: string; subscriptions: number; mrr: number }>();
    for (const line of book.timelines) {
      const cell = statuses.get(line.status) ?? { status: line.status, subscriptions: 0, mrr: 0 };
      cell.subscriptions += 1;
      cell.mrr += line.current_mrr;
      statuses.set(line.status, cell);
    }

    const accountsNow = new Set(live.map((line) => line.customer)).size;

    return {
      object: 'revenue_mrr',
      ...this.envelope(
        book,
        'Contracted monthly recurring revenue, read from the subscription book and normalised to a month.',
        [
          'MRR today is billing\'s own figure: subscriptionMrr() per subscription, gated by countsAsRevenue(status). This module imports both rather than reimplementing them, so /v1/revenue/mrr and /v1/subscriptions/overview cannot disagree.',
          'Every interval is normalised exactly, per item, rounded once: a year is 1/12, a week is 52/12, a day is 365/12, all as BigInt rationals. An annual price of 118,800 is 9,900 a month.',
          'Metered items are excluded from MRR. Usage is revenue but it is not recurring, and a forecast that treats it as contracted is wrong; the usage block below states its own basis separately.',
          'One-time prices are excluded: a subscription may only carry recurring prices, and one-time charges live on invoices.',
          'trialing, incomplete and incomplete_expired subscriptions contribute nothing; a trial only starts counting at trial_end.',
          'A collection pause contributes nothing from the instant the pause was written (the subscription row\'s `updated`), which is the only date billing records for it.',
          'History is reached by walking backwards from today through the dated contract changes in billing_pending_items, so an upgrade moves MRR on the day it landed rather than at the next renewal. A change made with proration_behavior=none writes no dated line and therefore moves at the next renewal instead.',
        ],
        {
          subscription_timelines: book.timelines.length,
          revenue_subscriptions: live.length,
          contract_changes_priced_from_the_catalog: book.changes.filter((change) => !change.reconstructed).length,
          contract_changes_recovered_from_the_fraction: book.changes.filter((change) => change.reconstructed).length,
        },
      ),
      series,
      totals: {
        mrr: mrrNow,
        arr: annualise(mrrNow),
        accounts: accountsNow,
        subscriptions: live.length,
        average_mrr_per_account: accountsNow ? Number(ratRound(rat(mrrNow, accountsNow), 'half_up')) : 0,
        currency: book.reporting,
      },
      by_currency: byCurrency,
      by_cadence: [...cadences.values()]
        .sort((a, b) => b.mrr - a.mrr)
        .map((cell) => ({ ...cell, share: ratio(cell.mrr, mrrNow) })),
      by_status: [...statuses.values()].sort((a, b) => b.mrr - a.mrr),
      not_yet_revenue: {
        trialing_mrr: book.timelines
          .filter((line) => line.status === 'trialing')
          .reduce((sum, line) => sum + line.contracted_mrr, 0),
        trialing_subscriptions: book.timelines.filter((line) => line.status === 'trialing').length,
        paused_mrr: book.timelines
          .filter((line) => line.status === 'paused')
          .reduce((sum, line) => sum + line.contracted_mrr, 0),
        paused_subscriptions: book.timelines.filter((line) => line.status === 'paused').length,
        note: 'Trials and paused subscriptions are contracted but not recognised. They appear here so the gap between the book and the revenue is visible rather than missing.',
      },
      usage,
    };
  }

  /**
   * The metered run rate, stated rather than assumed.
   *
   * Usage does not recur, so averaging it is the only honest way to put it
   * beside MRR — and the average has to say how many months it used and which
   * ones, because three good months and three quiet ones are a different
   * business from six steady ones.
   */
  private usageRunRate(orgId: string, book: Book, cells: MonthCell[]) {
    const complete = cells.filter((cell) => cell.complete).slice(-3);
    const currencyClause = book.requested ? ' AND i.currency = ?' : '';
    const monthly = complete.map((cell) => {
      const params: unknown[] = [orgId, cell.start, cell.end];
      if (book.requested) params.push(book.requested);
      const row = this.ctx.db.get<{ amount: number }>(
        `SELECT COALESCE(SUM(l.amount), 0) AS amount
           FROM billing_invoice_lines l
           JOIN billing_invoices i ON i.id = l.invoice_id
          WHERE l.org_id = ? AND i.status IN ('open', 'paid', 'uncollectible')
            AND i.finalized_at >= ? AND i.finalized_at < ?
            AND l.kind IN ('usage', 'true_up', 'credit_covered')${currencyClause}`,
        ...(params as never[]),
      );
      return { month: cell.key, amount: Number(row?.amount ?? 0) };
    });
    const runRate = meanOf(monthly.map((row) => row.amount));
    const mrrNow = book.timelines.reduce((sum, line) => sum + line.current_mrr, 0);
    return {
      run_rate: runRate,
      months: monthly,
      basis:
        monthly.length
          ? `The mean of the last ${monthly.length} complete month${monthly.length === 1 ? '' : 's'} of invoiced metered revenue ` +
            `(${monthly.map((row) => row.month).join(', ')}), taken from invoice lines of kind usage, true_up and credit_covered on ` +
            'finalised invoices. Credit-covered lines are included because the service was delivered and the credit was sold; ' +
            'the overage-only figure is in /v1/revenue/summary.'
          : 'No complete month in this range, so there is no run rate to state.',
      mrr_with_usage: mrrNow + runRate,
      arr_with_usage: annualise(mrrNow + runRate),
    };
  }

  /* ------------------------------- movement ------------------------------ */

  movement(orgId: string, query: RevenueQuery & { top_movers?: number }, prebuilt?: Book) {
    const book = prebuilt ?? this.book(orgId, query);
    const cells = this.windowOf(book);
    const offset = book.cells.length - cells.length;
    const scoped = this.scopedMatrix(book, offset);
    const series = movementSeries(scoped, cells, book.reporting, {
      names: book.names,
      topMovers: query.top_movers ?? 5,
    });

    return {
      object: 'revenue_movement',
      ...this.envelope(
        book,
        'Month-by-month MRR movement, classified per customer and reconciled against the closing book.',
        [
          'A month opens at the last millisecond before it starts and closes at the last millisecond of the month, or at now if it has not finished. Closing March and opening April are the same instant, so the chain across months is an identity, not an approximation.',
          'Movement is classified per customer, not per subscription: an account that cancels a monthly plan and signs an annual one on the same day has expanded or contracted, it has not churned and re-joined.',
          'new is an account that had no MRR at the open and never had any before this month. reactivation is one that had none at the open but did once. churn is an account that had MRR at the open and none at the close.',
          'expansion and contraction are the signed difference for accounts that had MRR at both ends; both are reported as positive magnitudes and applied with their sign in the reconciliation.',
          'A collection pause takes a subscription out of recognised MRR from the instant the pause was written, exactly as billing\'s countsAsRevenue does. At customer level that reads as contraction, or as churn when it was the account\'s only subscription — which is the honest classification of an account that has stopped paying — and it comes back as reactivation when collection resumes.',
          'reconciliation.computed_closing is opening plus movements; reconciliation.reported_closing is the closing MRR summed straight from the subscription timelines. They are two different aggregations of the same reads, and unbalanced_months names any month where they differ.',
        ],
        {
          months_reconciled: series.rows.filter((row) => row.reconciliation.balanced).length,
          months_unbalanced: series.unbalanced_months.length,
        },
      ),
      series: series.rows,
      totals: series.totals,
      reconciliation: series.reconciliation,
      unbalanced_months: series.unbalanced_months,
      balanced: series.unbalanced_months.length === 0 && series.reconciliation.balanced,
      warning: series.unbalanced_months.length
        ? `Movement does not reconcile for ${series.unbalanced_months.join(', ')}. The figures are published with the difference ` +
          'shown rather than plugged; do not read those bars as movement until the difference is explained.'
        : null,
    };
  }

  /**
   * The matrix restricted to the requested window.
   *
   * The book is built over the whole history so cohorts have somewhere to read
   * from; movement only needs the requested months plus the instant before
   * them, and slicing is cheaper than reading the timelines twice.
   */
  private scopedMatrix(book: Book, offset: number): RevenueMatrix {
    if (offset === 0) return book.matrix;
    const values = new Map<string, number[]>();
    for (const [customer, row] of book.matrix.values) values.set(customer, row.slice(offset));
    return {
      instants: book.matrix.instants.slice(offset),
      values,
      firstRevenue: book.matrix.firstRevenue,
      totals: book.matrix.totals.slice(offset),
      customers: book.matrix.customers,
    };
  }

  /* --------------------------------- churn ------------------------------- */

  churn(orgId: string, query: RevenueQuery, prebuilt?: Book) {
    const book = prebuilt ?? this.book(orgId, query, { fullHistory: true });
    const cells = this.windowOf(book);
    const offset = book.cells.length - cells.length;
    const series = movementSeries(this.scopedMatrix(book, offset), cells, book.reporting, { names: book.names });
    const churn = churnSeries(series);
    const cohorts = cohortMatrix(book.matrix, book.cells, book.reporting);

    return {
      object: 'revenue_churn',
      ...this.envelope(
        book,
        'Logo and revenue churn, gross and net retention, by month and by signup cohort.',
        [
          'Logo churn is accounts that ended the month with no MRR over accounts that started it with some. An account with several subscriptions churns only when the last of them stops.',
          'Gross revenue churn is churned MRR plus contraction over opening MRR. Gross revenue retention is the same base less those two, so churn and retention always add to 100%.',
          'Net revenue retention adds expansion and reactivation from the same opening base. New business is never in it — that is the point of the measure.',
          'Range rates use the sum of every month\'s opening as the denominator, so a month with a large book weighs more than a small one. The monthly rates are unweighted and shown beside them.',
          'A cohort is the month an account first carried recurring revenue, not the month its customer record was created — a record created during a sales cycle is not a cohort.',
        ],
        { cohorts: cohorts.rows.length, accounts_with_revenue: book.matrix.firstRevenue.size },
      ),
      series: churn.rows,
      totals: churn.totals,
      by_cohort: cohorts.rows.map((row) => ({
        cohort: row.cohort,
        accounts: row.accounts,
        initial_mrr: row.initial_mrr,
        latest: row.cells[row.cells.length - 1] ?? null,
        months_observed: row.cells.length,
      })),
      movement_reconciliation: series.reconciliation,
      unbalanced_months: series.unbalanced_months,
    };
  }

  /* -------------------------------- cohorts ------------------------------ */

  cohorts(orgId: string, query: RevenueQuery, prebuilt?: Book) {
    const book = prebuilt ?? this.book(orgId, query, { fullHistory: true });
    const matrix = cohortMatrix(book.matrix, book.cells, book.reporting);

    return {
      object: 'revenue_cohorts',
      ...this.envelope(
        book,
        'A retention matrix by signup month: how many accounts, and how much MRR, each cohort still has n months later.',
        [
          'A cohort is the month an account first carried recurring revenue. Accounts that have never carried any are counted in totals.unassigned_accounts rather than dropped silently.',
          'Offset 0 is the signup month itself, read at the close of that month — so an account that signed and cancelled inside its first month shows as offset-0 attrition rather than as a full retained logo.',
          'logo_retention is retained accounts over the cohort size. net_revenue_retention is the cohort\'s MRR at that offset over its MRR at offset 0, so it goes above 100% when the cohort expands.',
          'Every cell names the month it was read at, and the grid runs to the current month only — a cohort is never padded with months that have not happened.',
        ],
        { cohorts: matrix.rows.length, months_in_matrix: book.cells.length },
        book.cells,
      ),
      series: matrix.rows,
      totals: matrix.totals,
    };
  }

  /* -------------------------------- deferred ----------------------------- */

  deferred(
    orgId: string,
    query: RevenueQuery & { as_of?: number; customer?: string; subscription?: string; invoice?: string; schedule?: boolean; limit?: number },
    prebuilt?: Book,
  ) {
    const book = prebuilt ?? this.book(orgId, query);
    const cells = this.windowOf(book);
    const asOf = query.as_of ?? book.now;

    const clauses = [
      'l.org_id = ?',
      `i.status IN ('open', 'paid', 'uncollectible')`,
      'i.finalized_at IS NOT NULL',
      'i.finalized_at <= ?',
      'l.released = 0',
    ];
    const params: unknown[] = [orgId, asOf];
    if (book.requested) { clauses.push('i.currency = ?'); params.push(book.requested); }
    if (query.customer) { clauses.push('i.customer_id = ?'); params.push(query.customer); }
    if (query.subscription) { clauses.push('l.subscription_id = ?'); params.push(query.subscription); }
    if (query.invoice) { clauses.push('l.invoice_id = ?'); params.push(query.invoice); }

    const rows = this.ctx.db.all<{
      id: string; invoice_id: string; number: string; status: string; customer_id: string; subscription_id: string | null;
      kind: string; description: string; currency: string; amount: number; finalized_at: number;
      period_start: number; period_end: number;
    }>(
      `SELECT l.id, l.invoice_id, i.number, i.status, i.customer_id, l.subscription_id, l.kind, l.description,
              l.currency, l.amount, i.finalized_at, l.period_start, l.period_end
         FROM billing_invoice_lines l
         JOIN billing_invoices i ON i.id = l.invoice_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY l.period_start ASC, l.id ASC`,
      ...(params as never[]),
    );

    const lines: RecognitionLine[] = rows.map((row) => ({
      invoice: row.invoice_id,
      invoice_number: row.number,
      invoice_status: row.status,
      line: row.id,
      customer: row.customer_id,
      subscription: row.subscription_id,
      kind: row.kind,
      description: row.description,
      currency: row.currency,
      amount: Number(row.amount),
      invoiced_at: Number(row.finalized_at),
      period: { start: Number(row.period_start), end: Number(row.period_end) },
      days: 0,
      recognised_to_date: 0,
      deferred: 0,
      unbilled: 0,
    }));

    const report: RecognitionReport = recognise(lines, cells, asOf, book.reporting);
    const wantSchedule = query.schedule === true || !!query.invoice;
    const limit = Math.min(query.limit ?? 100, 500);
    const detail = lines
      .filter((line) => (query.invoice ? true : line.deferred !== 0))
      .sort((a, b) => Math.abs(b.deferred) - Math.abs(a.deferred) || a.line.localeCompare(b.line))
      .slice(0, limit)
      .map((line) => ({
        ...line,
        customer_name: book.names.get(line.customer) ?? line.customer,
        ...(wantSchedule
          ? { schedule: scheduleFor(line.amount, line.currency, line.period.start, line.period.end, asOf) }
          : {}),
      }));

    return {
      object: 'revenue_deferred',
      as_of_recognition: asOf,
      ...this.envelope(
        book,
        'Revenue recognition: every finalised invoice line spread across the days of the period it covers.',
        [
          'Scope is every line of every finalised invoice (open, paid or uncollectible) raised on or before as_of. Drafts are not revenue and voided invoices were withdrawn, so neither is in scope; a voided invoice\'s lines are released and excluded by the same flag billing sets on them.',
          'A line is split across the days of its period with allocate(), weighted by the seconds of service in each day, so the days always sum back to the line to the cent and the last part-day is not rounded away.',
          'A day is recognised once it has fully elapsed at as_of. Recognised-to-date is the sum of elapsed days; the deferred balance is what was invoiced less what has been recognised.',
          'deferred goes negative where revenue was earned before it was billed — metered usage settles in arrears — and that part is reported separately as unbilled_balance rather than netted away silently.',
          'invoiced = recognised + deferred is checked on the way out, from two different accumulations, and reported in the reconciliation block.',
        ],
        {
          billing_invoice_lines: lines.length,
          billing_invoices: new Set(lines.map((line) => line.invoice)).size,
          recognition_days: lines.reduce((sum, line) => sum + line.days, 0),
        },
      ),
      series: report.rows,
      totals: report.totals,
      reconciliation: report.reconciliation,
      balanced: report.reconciliation.balanced,
      lines: detail,
    };
  }

  /* ------------------------------ collections ---------------------------- */

  collections(orgId: string, query: RevenueQuery, prebuilt?: Book) {
    const book = prebuilt ?? this.book(orgId, query);
    const cells = this.windowOf(book);
    const currencyClause = book.requested ? ' AND currency = ?' : '';
    const invoiceParams: unknown[] = [orgId];
    if (book.requested) invoiceParams.push(book.requested);

    const invoices = this.ctx.db.all<InvoiceRow>(
      `SELECT id, number, customer_id, subscription_id, currency, status, total, amount_due, amount_paid,
              due_date, finalized_at, paid_at, voided_at, marked_uncollectible_at, created
         FROM billing_invoices
        WHERE org_id = ? AND status <> 'draft' AND voided_at IS NULL${currencyClause}`,
      ...(invoiceParams as never[]),
    );
    const creditNotes = this.ctx.db.all<{ created: number; total: number }>(
      `SELECT created, total FROM billing_credit_notes WHERE org_id = ? AND status = 'issued'${currencyClause}`,
      ...(invoiceParams as never[]),
    );

    const recovery = recoveryReport(this.ctx, orgId, book.range.from, book.range.to);
    const report: CollectionsReport = collectionsReport({
      invoices,
      creditNotes: creditNotes.map((row) => ({ created: Number(row.created), total: Number(row.total) })),
      cells,
      from: book.range.from,
      to: book.range.to,
      currency: book.reporting,
      recovery,
    });

    const oldest = report.ageing.buckets.find((bucket) => bucket.bucket === 'd90_plus');
    return {
      object: 'revenue_collections',
      ...this.envelope(
        book,
        'Receivables ageing, days sales outstanding, and what dunning is recovering.',
        [
          'What a bill asked for is amount_due + amount_paid, never total: a bill reduced by a credit note or absorbed by account credit was never owed in full, and ageing it at face value would invent receivables.',
          'Ageing is reconstructed at any instant from finalized_at, paid_at, voided_at and marked_uncollectible_at, so the outstanding line on the monthly series is a real month-end balance rather than today\'s figure repeated.',
          'A bill ages from its due date, or from the day it was finalised when it carries none (due on receipt).',
          'The collection rate is cohorted on billings: of what was raised in a month, how much has been collected since. Cash collected in a month is reported beside it but never divided by that month\'s billings — that ratio reads over 100% whenever long-dated terms land and says nothing about whether anyone paid.',
          'DSO is closing receivables divided by everything billed inside the range, times the days the range covers. Both figures use the same "what it asked for" definition.',
          'Failed-payment exposure is the unrecovered balance of campaigns still in recovery. Recovery rate is money recovered over money at risk across campaigns that started inside the range, which is why it can differ from the attempt success rate beside it.',
          'Voided invoices are excluded everywhere: a withdrawn bill is not a receivable and never was.',
        ],
        {
          billing_invoices: invoices.length,
          billing_credit_notes: creditNotes.length,
          payments_dunning_campaigns: recovery.campaigns_started,
          payments_dunning_attempts: recovery.attempts.reduce((sum, row) => sum + row.attempts, 0),
        },
      ),
      series: report.rows,
      totals: report.totals,
      ageing: report.ageing,
      recovery: report.recovery,
      exposure: {
        failed_payments: recovery.at_risk,
        campaigns: recovery.at_risk_campaigns,
        over_90_days: oldest?.amount ?? 0,
        uncollectible_in_range: report.totals.written_off,
        note: recovery.at_risk_campaigns
          ? `${recovery.at_risk_campaigns} bill${recovery.at_risk_campaigns === 1 ? ' is' : 's are'} still being retried.`
          : 'Nothing is in recovery: every failed charge in this range was either collected or written off.',
      },
    };
  }

  /* --------------------------------- usage -------------------------------- */

  usage(orgId: string, query: RevenueQuery, prebuilt?: Book) {
    const book = prebuilt ?? this.book(orgId, query);
    const cells = this.windowOf(book);
    const report: UsageReport = usageReport(this.ctx, orgId, book.range.from, book.range.to, cells, book.reporting);
    return {
      object: 'revenue_usage',
      ...this.envelope(
        book,
        'Usage economics: revenue per meter, credit bought against credit burned, and how much of the book is overage.',
        [
          'Every figure comes from the settlement ledger in credits, which prices a period once and records all three numbers for it: what the usage was worth, what prepaid credit absorbed, and what was charged.',
          'A settlement is counted in the month its period ends, because that is the window the meter closed on and the window the invoice settles.',
          'Credit-covered usage is revenue that was recognised when the credit was sold, not when it was burned. It is reported beside charged usage, never added to it.',
          'Quantities are micro-units: 1 unit is 1,000,000 micro, which is how metering stores them so a sum is integer arithmetic.',
          'Monetary credit is reported in minor units; unit-denominated credit stays in micro-units and says so with a micro flag, because a telemetry event is not a cent.',
          'Overage share is charged usage over everything invoiced in the range, on finalised invoices only.',
        ],
        {
          credit_settlements: report.totals.settlements,
          credit_settlements_skipped: report.totals.skipped_settlements,
          credit_grants: report.credit.grants,
          meters: report.meters.length,
        },
      ),
      series: report.months,
      totals: report.totals,
      meters: report.meters,
      credit: report.credit,
      invoiced_mix: report.invoiced_mix,
    };
  }

  /* -------------------------------- summary ------------------------------- */

  summary(orgId: string, query: RevenueQuery) {
    // Two books cover every section, and both are read once: the window for the
    // series, the full history for anything cohorted. Nothing below re-reads
    // the database, so the six sections cannot disagree with each other.
    const window = this.book(orgId, query);
    const history = this.book(orgId, query, { fullHistory: true });
    const mrr = this.mrr(orgId, query, window);
    const movement = this.movement(orgId, query, window);
    const churn = this.churn(orgId, query, history);
    const collections = this.collections(orgId, query, window);
    const usage = this.usage(orgId, query, window);
    const deferred = this.deferred(orgId, query, window);

    const latest = movement.series[movement.series.length - 1] ?? null;
    const balanced = movement.balanced && deferred.balanced;

    // One row per month, drawn from the six sections rather than recomputed —
    // so a dashboard can chart recurring revenue, movement, recognition, cash
    // and usage on one axis and know they came from one read of the book.
    const series = movement.series.map((row, i) => ({
      month: row.month,
      period: row.period,
      complete: row.complete,
      mrr: row.closing,
      arr: annualise(row.closing),
      net_movement: row.net,
      new_business: row.new_business,
      expansion: row.expansion,
      reactivation: row.reactivation,
      contraction: row.contraction,
      churn: row.churn,
      reconciled: row.reconciliation.balanced,
      accounts: mrr.series[i]?.accounts ?? 0,
      invoiced: deferred.series[i]?.invoiced ?? 0,
      recognised: deferred.series[i]?.recognised ?? 0,
      deferred_balance: deferred.series[i]?.deferred_balance ?? 0,
      billed: collections.series[i]?.billed ?? 0,
      collected: collections.series[i]?.collected ?? 0,
      receivables: collections.series[i]?.outstanding ?? 0,
      metered_value: usage.series[i]?.metered_value ?? 0,
      usage_charged: usage.series[i]?.charged ?? 0,
    }));

    return {
      object: 'revenue_summary',
      as_of: mrr.as_of,
      range: mrr.range,
      currency: mrr.currency,
      basis: {
        summary: 'One screen of the revenue half of the business. Every section keeps its own basis and sources; nothing here is recomputed.',
        rules: [
          'Each block is the same computation the dedicated endpoint runs, so /v1/revenue/summary can never disagree with /v1/revenue/mrr, /movement, /churn, /collections, /deferred or /usage.',
          'The headline is only safe to read when balanced is true: it is false whenever a month\'s movement or the recognition schedule failed its reconciliation.',
          ...mrr.basis.rules.slice(0, 3),
        ],
        currency: mrr.basis.currency,
      },
      sources: {
        ...mrr.sources,
        ...collections.sources,
        ...usage.sources,
        ...deferred.sources,
      },
      balanced,
      series,
      totals: {
        currency: mrr.currency,
        mrr: mrr.totals.mrr,
        arr: mrr.totals.arr,
        accounts: mrr.totals.accounts,
        subscriptions: mrr.totals.subscriptions,
        opening_mrr: movement.totals.opening,
        net_movement: movement.totals.net,
        closing_mrr: movement.totals.closing,
        invoiced: deferred.totals.invoiced,
        recognised: deferred.totals.recognised,
        deferred_balance: deferred.totals.deferred_balance,
        billed: collections.totals.billed,
        collected: collections.totals.collected,
        receivables: collections.totals.outstanding,
        past_due: collections.totals.past_due,
        metered_value: usage.totals.metered_value,
        usage_charged: usage.totals.charged,
        credit_purchased: usage.credit.purchased,
        credit_burned: usage.credit.burned,
      },
      headline: {
        mrr: mrr.totals.mrr,
        arr: mrr.totals.arr,
        mrr_with_usage: mrr.usage.mrr_with_usage,
        arr_with_usage: mrr.usage.arr_with_usage,
        accounts: mrr.totals.accounts,
        net_new_mrr_this_month: latest?.net ?? 0,
        net_revenue_retention: churn.totals.net_revenue_retention,
        gross_revenue_retention: churn.totals.gross_revenue_retention,
        logo_churn: churn.totals.logo_churn,
        receivables: collections.totals.outstanding,
        past_due: collections.totals.past_due,
        dso: collections.totals.dso,
        deferred_balance: deferred.totals.deferred_balance,
        overage_share: usage.totals.overage_share_of_invoiced,
      },
      movement: {
        latest_month: latest,
        totals: movement.totals,
        reconciliation: movement.reconciliation,
        unbalanced_months: movement.unbalanced_months,
      },
      churn: { totals: churn.totals, latest_month: churn.series[churn.series.length - 1] ?? null },
      collections: { totals: collections.totals, ageing: collections.ageing, exposure: collections.exposure },
      usage: { totals: usage.totals, credit: usage.credit, meters: usage.meters.slice(0, 8) },
      deferred: { totals: deferred.totals, reconciliation: deferred.reconciliation },
      mrr: { series: mrr.series, by_currency: mrr.by_currency, by_cadence: mrr.by_cadence, usage: mrr.usage },
      warnings: [
        ...(movement.warning ? [movement.warning] : []),
        ...(deferred.balanced ? [] : [`Recognition does not reconcile: ${deferred.reconciliation.note}`]),
      ],
    };
  }

  /* ------------------------------ one account ----------------------------- */

  /** The revenue story for a single account — the same maths, one customer. */
  account(orgId: string, customerId: string, query: RevenueQuery, prebuilt?: Book) {
    const book = prebuilt ?? this.book(orgId, query, { fullHistory: true });
    const customer = book.customers.get(customerId);
    const timelines = book.timelines.filter((line) => line.customer === customerId);
    const row = book.matrix.values.get(customerId);
    const first = book.matrix.firstRevenue.get(customerId) ?? null;
    return {
      object: 'revenue_account',
      customer: customerId,
      name: customer?.name ?? customerId,
      currency: customer?.currency ?? book.reporting,
      as_of: book.now,
      first_revenue_at: first,
      cohort: first === null ? null : book.cells.find((cell) => first >= cell.start && first < cell.end)?.key ?? null,
      mrr: timelines.reduce((sum, line) => sum + line.current_mrr, 0),
      arr: annualise(timelines.reduce((sum, line) => sum + line.current_mrr, 0)),
      series: book.cells.map((cell, i) => ({ month: cell.key, at: cell.at, mrr: row ? row[i + 1] : 0 })),
      subscriptions: timelines,
      lifetime_billed: this.ctx.db.count(
        `SELECT COALESCE(SUM(amount_due + amount_paid), 0) FROM billing_invoices
          WHERE org_id = ? AND customer_id = ? AND status IN ('open', 'paid', 'uncollectible')`,
        orgId, customerId,
      ),
      receivable: ageBook(
        this.ctx.db.all<InvoiceRow>(
          `SELECT id, number, customer_id, subscription_id, currency, status, total, amount_due, amount_paid,
                  due_date, finalized_at, paid_at, voided_at, marked_uncollectible_at, created
             FROM billing_invoices WHERE org_id = ? AND customer_id = ? AND status <> 'draft' AND voided_at IS NULL`,
          orgId, customerId,
        ),
        book.now,
        customer?.currency ?? book.reporting,
      ),
    };
  }
}
