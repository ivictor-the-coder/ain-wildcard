/**
 * The reader.
 *
 * Revenue owns no table. Everything it publishes is assembled here out of
 * billing's subscriptions, invoices and proration ledger, payments' dunning
 * history, credits' settlement ledger and metering's meters — which is why
 * every response carries a `sources` block naming the row counts it read. If a
 * number looks wrong, the block says exactly which rows to go and count.
 *
 * Two rules run through all of it:
 *
 *  - **A money figure is stated in a currency or it is not stated.** When the
 *    book touches more than one currency every money scalar is `null` and the
 *    `by_currency` block is the answer — see `currency.ts` for why adding minor
 *    units across currencies is the worst thing a revenue report can do.
 *  - **Every figure is dated by something durable.** History is reached through
 *    the proration ledger and the event log, never through a `updated` column
 *    that the next unrelated write moves.
 */
import type { Ctx } from '../../kernel/context';
import { rat, ratRound } from '../../../shared/money';
import { startOfMonth } from '../../../shared/time';
import { Pricebook } from '../billing/cycle';
import { billingStore } from '../billing/module';
import type { Subscription } from '../billing/types';
import {
  clipBetween, instantsOf, monthGrid, resolveRange, type MonthCell, type Range, type WindowClip,
} from './grid';
import { ratio } from './ratio';
import {
  buildMatrix, churnSeries, cohortMatrix, movementSeries,
  type MovementSeries, type RevenueMatrix,
} from './movement';
import { recognise, scheduleFor, type RecognitionLine, type RecognitionReport } from './recognition';
import {
  ageBook, collectionsReport, recoveryReport, type CollectionsReport, type InvoiceRow,
} from './collections';
import { usageReport, type UsageReport } from './usage';
import {
  annualise, buildTimeline, readCollectionPauses, readContractChanges,
  type ContractChange, type SubscriptionTimeline,
} from './timeline';
import {
  RULE, currencyScope, mixedWarning, only, onlyIn, type CurrencyScope, type Scalar,
} from './currency';

/** More subscriptions than any workspace this platform is built for. */
const MAX_SUBSCRIPTIONS = 5_000;

/** More months than any reporting window this module will draw in one request. */
const MAX_MONTHS = 120;

export interface RevenueQuery {
  from?: number;
  to?: number;
  currency?: string;
  months?: number;
}

export interface Basis {
  summary: string;
  rules: string[];
  currency: CurrencyScope;
}

export type Sources = Record<string, number>;

export interface Envelope {
  as_of: number;
  range: { from: number; to: number; months: number };
  /** The currency every money scalar below is in — `null` when several are in scope. */
  currency: string | null;
  basis: Basis;
  sources: Sources;
  /** True when the book was larger than this module will read in one request. */
  truncated: boolean;
  /** Set when the requested window was longer than this module will draw. */
  window_clipped: WindowClip | null;
  /** Everything about this response a reader must know before trusting a figure. */
  warnings: string[];
}

/* --------------------------------- helpers -------------------------------- */

const meanOf = (values: number[]): number =>
  values.length ? Number(ratRound(rat(values.reduce((sum, v) => sum + v, 0), values.length), 'half_up')) : 0;

const perAccount = (mrr: number, accounts: number): number =>
  (accounts ? Number(ratRound(rat(mrr, accounts), 'half_up')) : 0);

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
  clipped: WindowClip | null;
  instants: number[];
  timelines: SubscriptionTimeline[];
  subscriptions: Subscription[];
  customers: Map<string, CustomerRow>;
  names: Map<string, string>;
  matrix: RevenueMatrix;
  /** The same matrix per currency, so a mixed book still has exact answers in it. */
  matrices: Map<string, RevenueMatrix>;
  changes: ContractChange[];
  scope: CurrencyScope;
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
    const requested = query.currency?.toLowerCase();
    const requestedRange = resolveRange(query, now, query.months ?? 12);

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
    const pausesBySub = readCollectionPauses(this.ctx, orgId);
    const timelines = subscriptions.map(
      (sub) => buildTimeline(sub, priced, changesBySub.get(sub.id) ?? [], pausesBySub.get(sub.id) ?? []),
    );

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
      requestedRange.from,
    );
    const gridFrom = opts.fullHistory ? Math.min(earliest, requestedRange.from) : requestedRange.from;
    const grid = monthGrid(gridFrom, requestedRange.to, now, MAX_MONTHS);
    const cells = grid.cells;
    // A full-history grid legitimately starts before the requested window; what
    // matters is whether the requested window itself survived the cap.
    const clipped = cells.length
      ? clipBetween(requestedRange.from, cells[0].start, cells, MAX_MONTHS)
      : null;
    const range: Range = cells.length && clipped ? { from: cells[0].start, to: requestedRange.to } : requestedRange;

    const instants = instantsOf(cells);
    const matrix = buildMatrix(timelines, instants);

    // Every currency this book touches, whether it is carrying revenue now or
    // only invoices: a report that reads both tables must be honest about both.
    const present = new Set<string>(subscriptions.map((sub) => sub.currency));
    for (const row of this.ctx.db.all<{ currency: string }>(
      `SELECT DISTINCT currency FROM billing_invoices WHERE org_id = ? AND status <> 'draft'`, orgId,
    )) present.add(row.currency);
    const scope = currencyScope(requested, this.reportingCurrency(orgId), [...present]);

    const matrices = new Map<string, RevenueMatrix>();
    for (const currency of scope.currencies) {
      matrices.set(
        currency,
        scope.single === currency && scope.currencies.length === 1
          ? matrix
          : buildMatrix(timelines.filter((line) => line.currency === currency), instants),
      );
    }

    return {
      range,
      cells,
      clipped,
      instants,
      timelines,
      subscriptions,
      customers,
      names,
      matrix,
      matrices,
      changes: timelines.flatMap((line) => line.changes),
      scope,
      reporting: requested ?? this.reportingCurrency(orgId),
      requested,
      truncated,
      now,
    };
  }

  /**
   * The currency a narrowed request is denominated in when it turns up empty.
   *
   * A report about one invoice, subscription or account is in that object's
   * currency whether or not it has any lines left — a voided bill leaves an
   * account whose figures are still dollars, not an unanswerable question.
   */
  private narrowedCurrencies(
    orgId: string, query: { customer?: string; subscription?: string; invoice?: string },
  ): string[] | null {
    const lookup = (table: string, id: string): string[] | null => {
      const row = this.ctx.db.get<{ currency: string }>(
        `SELECT currency FROM ${table} WHERE org_id = ? AND id = ?`, orgId, id,
      );
      return row ? [row.currency] : null;
    };
    if (query.invoice) return lookup('billing_invoices', query.invoice);
    if (query.subscription) return lookup('billing_subscriptions', query.subscription);
    if (query.customer) return lookup('billing_customers', query.customer);
    return null;
  }

  /** The month cells inside the requested window, for a book built full-history. */
  windowOf(book: Book): MonthCell[] {
    const first = startOfMonth(book.range.from);
    return book.cells.filter((cell) => cell.start >= first);
  }

  /** The matrix for one currency; the whole book's when only one is in scope. */
  private matrixOf(book: Book, currency: string): RevenueMatrix {
    return book.matrices.get(currency)
      ?? buildMatrix(book.timelines.filter((line) => line.currency === currency), book.instants);
  }

  private envelope(
    book: Book, summary: string, rules: string[], sources: Sources,
    opts: { over?: MonthCell[]; subject?: string; warnings?: string[]; scope?: CurrencyScope } = {},
  ): Envelope {
    const cells = opts.over ?? this.windowOf(book);
    const scope = opts.scope ?? book.scope;
    return {
      as_of: book.now,
      range: { from: cells.length ? cells[0].start : book.range.from, to: book.range.to, months: cells.length },
      currency: scope.single,
      basis: {
        summary,
        rules: [...rules, RULE],
        currency: scope,
      },
      truncated: book.truncated,
      window_clipped: book.clipped,
      warnings: [
        ...(book.clipped ? [book.clipped.note] : []),
        ...(book.truncated
          ? [`This workspace has more than ${MAX_SUBSCRIPTIONS} subscriptions and this report read the first ${MAX_SUBSCRIPTIONS} by start date. Every figure below is that subset, not the book.`]
          : []),
        ...mixedWarning(scope, opts.subject ?? 'This book'),
        ...(opts.warnings ?? []),
      ],
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
    const scope = book.scope;
    const cells = this.windowOf(book);
    const offset = book.cells.length - cells.length;

    const seriesOf = (matrix: RevenueMatrix) => cells.map((cell, i) => {
      const column = offset + i + 1;
      let mrr = 0, accounts = 0;
      for (const row of matrix.values.values()) {
        const amount = row[column];
        mrr += amount;
        if (amount !== 0) accounts += 1;
      }
      return {
        month: cell.key,
        at: cell.at,
        complete: cell.complete,
        mrr,
        arr: annualise(mrr),
        accounts,
        average_mrr_per_account: perAccount(mrr, accounts),
      };
    });

    const totalsOf = (lines: SubscriptionTimeline[]) => {
      const live = lines.filter((line) => line.current_mrr !== 0);
      const mrr = live.reduce((sum, line) => sum + line.current_mrr, 0);
      const accounts = new Set(live.map((line) => line.customer)).size;
      return {
        mrr,
        arr: annualise(mrr),
        accounts,
        subscriptions: live.length,
        average_mrr_per_account: perAccount(mrr, accounts),
      };
    };

    const whole = totalsOf(book.timelines);
    const wholeSeries = seriesOf(book.matrix);
    // With one currency in scope the whole book *is* that currency, so the
    // per-currency pass reuses what has already been computed rather than
    // walking the same matrix again.
    const perCurrency = scope.currencies.map((currency) => {
      const lines = scope.single === currency ? book.timelines : book.timelines.filter((line) => line.currency === currency);
      return {
        currency,
        ...(scope.single === currency ? whole : totalsOf(lines)),
        tax_inclusive_mrr: lines.reduce((sum, line) => sum + line.tax_inclusive_mrr, 0),
        trialing_mrr: lines.filter((line) => line.status === 'trialing').reduce((sum, line) => sum + line.contracted_mrr, 0),
        paused_mrr: lines.filter((line) => line.status === 'paused').reduce((sum, line) => sum + line.contracted_mrr, 0),
        series: scope.single === currency ? wholeSeries : seriesOf(this.matrixOf(book, currency)),
      };
    });

    const usage = this.usageRunRate(orgId, book, cells, perCurrency);

    // A cadence and a status are reported per currency: "23 monthly plans worth
    // 1,204,300" is only a sentence if the 1,204,300 is in something.
    const cadences = new Map<string, { currency: string; interval: string; interval_count: number; subscriptions: number; mrr: number }>();
    const statuses = new Map<string, { currency: string; status: string; subscriptions: number; mrr: number }>();
    for (const line of book.timelines) {
      const statusKey = `${line.currency}:${line.status}`;
      const status = statuses.get(statusKey)
        ?? { currency: line.currency, status: line.status, subscriptions: 0, mrr: 0 };
      status.subscriptions += 1;
      status.mrr += line.current_mrr;
      statuses.set(statusKey, status);

      if (line.current_mrr === 0) continue;
      const key = `${line.currency}:${line.interval_count}:${line.interval}`;
      const cell = cadences.get(key)
        ?? { currency: line.currency, interval: line.interval, interval_count: line.interval_count, subscriptions: 0, mrr: 0 };
      cell.subscriptions += 1;
      cell.mrr += line.current_mrr;
      cadences.set(key, cell);
    }
    const mrrIn = (currency: string) => perCurrency.find((row) => row.currency === currency)?.mrr ?? 0;

    return {
      object: 'revenue_mrr',
      ...this.envelope(
        book,
        'Contracted monthly recurring revenue, read from the subscription book and normalised to a month.',
        [
          'MRR today is billing\'s own figure: subscriptionMrr() per subscription, gated by countsAsRevenue(status). This module imports both rather than reimplementing them, so the per-currency figures here and /v1/subscriptions/overview cannot disagree.',
          'Every interval is normalised exactly, per item, rounded once: a year is 1/12, a week is 52/12, a day is 365/12, all as BigInt rationals. An annual price of 118,800 is 9,900 a month.',
          'Metered items are excluded from MRR. Usage is revenue but it is not recurring, and a forecast that treats it as contracted is wrong; the usage block below states its own basis separately.',
          'One-time prices are excluded: a subscription may only carry recurring prices, and one-time charges live on invoices.',
          'MRR is gross of tax on a tax-inclusive price, because that is what the contract says. The `tax` block below names exactly how much of it is, so the gap between MRR and the revenue the same money is recognised at is stated rather than left for someone to find.',
          'trialing, incomplete and incomplete_expired subscriptions contribute nothing; a trial only starts counting at trial_end.',
          'A collection pause contributes nothing from the instant the subscription.paused event was written, and comes back at subscription.resumed. Both are durable and neither moves when a later renewal writes the row; a paused subscription with no event in the log falls back to the row\'s `updated` and says so in its own pauses[] block.',
          'History is reached by walking backwards from today through the dated contract changes in billing_pending_items, so an upgrade moves MRR on the day it landed rather than at the next renewal. A change made with proration_behavior=none writes no dated line and therefore moves at the next renewal instead.',
        ],
        {
          subscription_timelines: book.timelines.length,
          revenue_subscriptions: book.timelines.filter((line) => line.current_mrr !== 0).length,
          contract_changes_priced_from_the_catalog: book.changes.filter((change) => !change.reconstructed).length,
          contract_changes_recovered_from_the_fraction: book.changes.filter((change) => change.reconstructed).length,
          subscriptions_with_a_collection_pause: book.timelines.filter((line) => line.pauses.length).length,
          collection_pauses_dated_from_the_row: book.timelines.filter((line) => line.pauses.some((pause) => pause.inferred)).length,
        },
        { subject: 'Recurring revenue' },
      ),
      series: wholeSeries.map((row, i) => ({
        month: row.month,
        at: row.at,
        complete: row.complete,
        mrr: only(scope, row.mrr),
        arr: only(scope, row.arr),
        accounts: row.accounts,
        average_mrr_per_account: only(scope, row.average_mrr_per_account),
        by_currency: perCurrency.map((part) => ({ currency: part.currency, ...part.series[i] })),
      })),
      totals: {
        mrr: only(scope, whole.mrr),
        arr: only(scope, whole.arr),
        accounts: whole.accounts,
        subscriptions: whole.subscriptions,
        average_mrr_per_account: only(scope, whole.average_mrr_per_account),
        currency: scope.single,
      },
      by_currency: perCurrency.map((part) => ({
        currency: part.currency,
        mrr: part.mrr,
        arr: part.arr,
        subscriptions: part.subscriptions,
        accounts: part.accounts,
        average_mrr_per_account: part.average_mrr_per_account,
        tax_inclusive_mrr: part.tax_inclusive_mrr,
      })),
      tax: {
        inclusive_mrr: only(scope, book.timelines.reduce((sum, line) => sum + line.tax_inclusive_mrr, 0)),
        inclusive_subscriptions: book.timelines.filter((line) => line.tax_inclusive_mrr !== 0).length,
        by_currency: perCurrency.map((part) => ({
          currency: part.currency, inclusive_mrr: part.tax_inclusive_mrr, mrr: part.mrr,
        })),
        note:
          'MRR is the contract, and on a tax-inclusive price the contract includes the tax that will be remitted. This ' +
          'much of the MRR above is therefore gross of tax, while /v1/revenue/deferred recognises the same money net of ' +
          'it — which is the whole of the difference between the two figures on this screen. No rate is applied here: ' +
          'the rate depends on where the account is registered and is resolved when the invoice is raised, never ' +
          'against a contract.',
      },
      by_cadence: [...cadences.values()]
        .sort((a, b) => a.currency.localeCompare(b.currency) || b.mrr - a.mrr)
        .map((cell) => ({ ...cell, share: ratio(cell.mrr, mrrIn(cell.currency)) })),
      by_status: [...statuses.values()]
        .sort((a, b) => a.currency.localeCompare(b.currency) || b.mrr - a.mrr),
      not_yet_revenue: {
        trialing_subscriptions: book.timelines.filter((line) => line.status === 'trialing').length,
        paused_subscriptions: book.timelines.filter((line) => line.status === 'paused').length,
        trialing_mrr: only(scope, book.timelines
          .filter((line) => line.status === 'trialing')
          .reduce((sum, line) => sum + line.contracted_mrr, 0)),
        paused_mrr: only(scope, book.timelines
          .filter((line) => line.status === 'paused')
          .reduce((sum, line) => sum + line.contracted_mrr, 0)),
        by_currency: perCurrency.map((part) => ({
          currency: part.currency, trialing_mrr: part.trialing_mrr, paused_mrr: part.paused_mrr,
        })),
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
  private usageRunRate(
    orgId: string, book: Book, cells: MonthCell[],
    perCurrency: { currency: string; mrr: number }[],
  ) {
    const scope = book.scope;
    const complete = cells.filter((cell) => cell.complete).slice(-3);
    const currencyClause = book.requested ? ' AND i.currency = ?' : '';
    const monthly = complete.map((cell) => {
      const params: unknown[] = [orgId, cell.start, cell.end];
      if (book.requested) params.push(book.requested);
      const rows = this.ctx.db.all<{ currency: string; amount: number }>(
        `SELECT i.currency AS currency, COALESCE(SUM(l.amount), 0) AS amount
           FROM billing_invoice_lines l
           JOIN billing_invoices i ON i.id = l.invoice_id AND i.org_id = l.org_id
          WHERE l.org_id = ? AND i.status IN ('open', 'paid', 'uncollectible')
            AND i.finalized_at >= ? AND i.finalized_at < ?
            AND l.kind IN ('usage', 'true_up', 'credit_covered')${currencyClause}
          GROUP BY i.currency`,
        ...(params as never[]),
      );
      return {
        month: cell.key,
        amount: rows.reduce((sum, row) => sum + Number(row.amount), 0),
        by_currency: new Map(rows.map((row) => [row.currency, Number(row.amount)])),
      };
    });

    const runRateIn = (currency: string) =>
      meanOf(monthly.map((row) => row.by_currency.get(currency) ?? 0));
    const runRate = meanOf(monthly.map((row) => row.amount));
    const mrrNow = book.timelines.reduce((sum, line) => sum + line.current_mrr, 0);

    return {
      run_rate: only(scope, runRate),
      months: monthly.map((row) => ({
        month: row.month,
        amount: only(scope, row.amount),
        by_currency: scope.currencies.map((currency) => ({ currency, amount: row.by_currency.get(currency) ?? 0 })),
      })),
      by_currency: perCurrency.map((part) => ({
        currency: part.currency,
        run_rate: runRateIn(part.currency),
        mrr_with_usage: part.mrr + runRateIn(part.currency),
        arr_with_usage: annualise(part.mrr + runRateIn(part.currency)),
      })),
      basis:
        monthly.length
          ? `The mean of the last ${monthly.length} complete month${monthly.length === 1 ? '' : 's'} of invoiced metered revenue ` +
            `(${monthly.map((row) => row.month).join(', ')}), taken from invoice lines of kind usage, true_up and credit_covered on ` +
            'finalised invoices. Credit-covered lines are included because the service was delivered and the credit was sold; ' +
            'the overage-only figure is in /v1/revenue/summary.'
          : 'No complete month in this range, so there is no run rate to state.',
      mrr_with_usage: only(scope, mrrNow + runRate),
      arr_with_usage: only(scope, annualise(mrrNow + runRate)),
    };
  }

  /* ------------------------------- movement ------------------------------ */

  movement(orgId: string, query: RevenueQuery & { top_movers?: number }, prebuilt?: Book) {
    const book = prebuilt ?? this.book(orgId, query);
    const scope = book.scope;
    const cells = this.windowOf(book);
    const offset = book.cells.length - cells.length;
    const topMovers = query.top_movers ?? 5;

    const whole = movementSeries(this.scopedMatrix(book.matrix, offset), cells, scope.single, {
      names: book.names, topMovers,
    });
    const parts = scope.currencies.map((currency) => ({
      currency,
      series: scope.single === currency ? whole : movementSeries(
        this.scopedMatrix(this.matrixOf(book, currency), offset), cells, currency, { names: book.names, topMovers },
      ),
    }));

    const movementOf = (row: MovementSeries['rows'][number]) => ({
      opening: row.opening,
      new_business: row.new_business,
      expansion: row.expansion,
      reactivation: row.reactivation,
      contraction: row.contraction,
      churn: row.churn,
      net: row.net,
      closing: row.closing,
      reconciliation: row.reconciliation,
    });

    const series = whole.rows.map((row, i) => {
      const slices = parts.map((part) => ({ currency: part.currency, ...movementOf(part.series.rows[i]) }));
      const balanced = row.reconciliation.balanced && slices.every((slice) => slice.reconciliation.balanced);
      return {
        month: row.month,
        period: row.period,
        opening_at: row.opening_at,
        closing_at: row.closing_at,
        complete: row.complete,
        currency: scope.single,
        opening: only(scope, row.opening),
        new_business: only(scope, row.new_business),
        expansion: only(scope, row.expansion),
        reactivation: only(scope, row.reactivation),
        contraction: only(scope, row.contraction),
        churn: only(scope, row.churn),
        net: only(scope, row.net),
        closing: only(scope, row.closing),
        counts: row.counts,
        // Ranking movers by size across currencies would be the same mistake as
        // adding them, so a mixed month names the largest movers in each.
        top_movers: scope.single ? row.top_movers : parts.flatMap((part) => part.series.rows[i].top_movers),
        reconciliation: {
          computed_closing: only(scope, row.reconciliation.computed_closing),
          reported_closing: only(scope, row.reconciliation.reported_closing),
          difference: only(scope, row.reconciliation.difference),
          balanced,
          note: balanced
            ? null
            : row.reconciliation.note
              ?? `Movement does not reconcile in ${slices.filter((slice) => !slice.reconciliation.balanced).map((slice) => slice.currency.toUpperCase()).join(', ')}.`,
        },
        by_currency: slices,
      };
    });

    const unbalanced = [...new Set([
      ...whole.unbalanced_months,
      ...parts.flatMap((part) => part.series.unbalanced_months),
    ])].sort();
    const balanced = unbalanced.length === 0
      && whole.reconciliation.balanced
      && parts.every((part) => part.series.reconciliation.balanced);

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
          'A collection pause takes a subscription out of recognised MRR from the instant the subscription.paused event was written, and puts it back at subscription.resumed. At customer level that reads as contraction, or as churn when it was the account\'s only subscription — which is the honest classification of an account that has stopped paying — and it comes back as reactivation when collection resumes.',
          'reconciliation.computed_closing is opening plus movements; reconciliation.reported_closing is the closing MRR summed straight from the subscription timelines. They are two different aggregations of the same reads, and unbalanced_months names any month where they differ.',
          'The identity is proved once per currency and once across the book, so a mixed month is reconciled in each of its currencies rather than in a sum of them.',
        ],
        {
          months_reconciled: series.filter((row) => row.reconciliation.balanced).length,
          months_unbalanced: unbalanced.length,
          currencies_reconciled: parts.filter((part) => part.series.reconciliation.balanced).length,
        },
        { subject: 'MRR movement' },
      ),
      series,
      totals: {
        opening: only(scope, whole.totals.opening),
        new_business: only(scope, whole.totals.new_business),
        expansion: only(scope, whole.totals.expansion),
        reactivation: only(scope, whole.totals.reactivation),
        contraction: only(scope, whole.totals.contraction),
        churn: only(scope, whole.totals.churn),
        net: only(scope, whole.totals.net),
        closing: only(scope, whole.totals.closing),
      },
      by_currency: parts.map((part) => ({
        currency: part.currency,
        totals: part.series.totals,
        reconciliation: part.series.reconciliation,
        unbalanced_months: part.series.unbalanced_months,
        balanced: part.series.unbalanced_months.length === 0 && part.series.reconciliation.balanced,
      })),
      reconciliation: {
        computed_closing: only(scope, whole.reconciliation.computed_closing),
        reported_closing: only(scope, whole.reconciliation.reported_closing),
        difference: only(scope, whole.reconciliation.difference),
        balanced,
        note: whole.reconciliation.note
          ?? parts.find((part) => !part.series.reconciliation.balanced)?.series.reconciliation.note
          ?? null,
      },
      unbalanced_months: unbalanced,
      balanced,
      warning: unbalanced.length
        ? `Movement does not reconcile for ${unbalanced.join(', ')}. The figures are published with the difference ` +
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
  private scopedMatrix(matrix: RevenueMatrix, offset: number): RevenueMatrix {
    if (offset === 0) return matrix;
    const values = new Map<string, number[]>();
    for (const [customer, row] of matrix.values) values.set(customer, row.slice(offset));
    return {
      instants: matrix.instants.slice(offset),
      values,
      firstRevenue: matrix.firstRevenue,
      totals: matrix.totals.slice(offset),
      customers: matrix.customers,
    };
  }

  /* --------------------------------- churn ------------------------------- */

  churn(orgId: string, query: RevenueQuery, prebuilt?: Book) {
    const book = prebuilt ?? this.book(orgId, query, { fullHistory: true });
    const scope = book.scope;
    const cells = this.windowOf(book);
    const offset = book.cells.length - cells.length;

    const movement = movementSeries(this.scopedMatrix(book.matrix, offset), cells, scope.single, { names: book.names });
    const whole = churnSeries(movement);
    const parts = scope.currencies.map((currency) => {
      const moved = scope.single === currency ? movement : movementSeries(
        this.scopedMatrix(this.matrixOf(book, currency), offset), cells, currency, { names: book.names },
      );
      return {
        currency,
        movement: moved,
        churn: scope.single === currency ? whole : churnSeries(moved),
        cohorts: cohortMatrix(this.matrixOf(book, currency), book.cells, currency),
      };
    });
    const unbalanced = [...new Set([
      ...movement.unbalanced_months,
      ...parts.flatMap((part) => part.movement.unbalanced_months),
    ])].sort();

    // A count is a count in any currency; a rate weighted by money is money, so
    // it goes the way every other money figure here goes.
    const rowOut = (row: (typeof whole.rows)[number], i: number) => ({
      month: row.month,
      period: row.period,
      complete: row.complete,
      currency: scope.single,
      opening_mrr: only(scope, row.opening_mrr),
      closing_mrr: only(scope, row.closing_mrr),
      churned_mrr: only(scope, row.churned_mrr),
      contraction_mrr: only(scope, row.contraction_mrr),
      expansion_mrr: only(scope, row.expansion_mrr),
      reactivation_mrr: only(scope, row.reactivation_mrr),
      accounts_at_open: row.accounts_at_open,
      churned_accounts: row.churned_accounts,
      logo_churn: row.logo_churn,
      logo_retention: row.logo_retention,
      gross_revenue_churn: onlyIn(scope, row.gross_revenue_churn),
      gross_revenue_retention: onlyIn(scope, row.gross_revenue_retention),
      net_revenue_retention: onlyIn(scope, row.net_revenue_retention),
      by_currency: parts.map((part) => ({ ...part.churn.rows[i], currency: part.currency })),
    });

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
          'Logo churn is a ratio of account counts and holds across currencies. Every revenue-weighted rate is a money figure in disguise and is reported per currency only.',
        ],
        {
          cohorts: parts.reduce((sum, part) => sum + part.cohorts.rows.length, 0),
          accounts_with_revenue: book.matrix.firstRevenue.size,
        },
        { subject: 'Churn and retention' },
      ),
      series: whole.rows.map(rowOut),
      totals: {
        opening_mrr: only(scope, whole.totals.opening_mrr),
        closing_mrr: only(scope, whole.totals.closing_mrr),
        churned_mrr: only(scope, whole.totals.churned_mrr),
        contraction_mrr: only(scope, whole.totals.contraction_mrr),
        expansion_mrr: only(scope, whole.totals.expansion_mrr),
        reactivation_mrr: only(scope, whole.totals.reactivation_mrr),
        churned_accounts: whole.totals.churned_accounts,
        exposed_mrr: only(scope, whole.totals.exposed_mrr),
        exposed_accounts: whole.totals.exposed_accounts,
        logo_churn: whole.totals.logo_churn,
        gross_revenue_churn: onlyIn(scope, whole.totals.gross_revenue_churn),
        gross_revenue_retention: onlyIn(scope, whole.totals.gross_revenue_retention),
        net_revenue_retention: onlyIn(scope, whole.totals.net_revenue_retention),
      },
      by_currency: parts.map((part) => ({ currency: part.currency, totals: part.churn.totals })),
      by_cohort: parts.flatMap((part) => part.cohorts.rows.map((row) => ({
        cohort: row.cohort,
        currency: part.currency,
        accounts: row.accounts,
        initial_mrr: row.initial_mrr,
        latest: row.cells[row.cells.length - 1] ?? null,
        months_observed: row.cells.length,
      }))).sort((a, b) => a.cohort.localeCompare(b.cohort) || a.currency.localeCompare(b.currency)),
      movement_reconciliation: {
        computed_closing: only(scope, movement.reconciliation.computed_closing),
        reported_closing: only(scope, movement.reconciliation.reported_closing),
        difference: only(scope, movement.reconciliation.difference),
        balanced: unbalanced.length === 0
          && movement.reconciliation.balanced
          && parts.every((part) => part.movement.reconciliation.balanced),
        note: movement.reconciliation.note
          ?? parts.find((part) => !part.movement.reconciliation.balanced)?.movement.reconciliation.note
          ?? null,
        by_currency: parts.map((part) => ({ currency: part.currency, ...part.movement.reconciliation })),
      },
      unbalanced_months: unbalanced,
    };
  }

  /* -------------------------------- cohorts ------------------------------ */

  cohorts(orgId: string, query: RevenueQuery, prebuilt?: Book) {
    const book = prebuilt ?? this.book(orgId, query, { fullHistory: true });
    const scope = book.scope;
    // A cohort is keyed by month and currency: a March cohort billing in euros
    // and one billing in dollars are two cohorts with two retention curves, and
    // there is no third number that is both.
    const parts = scope.currencies.map((currency) => ({
      currency, matrix: cohortMatrix(this.matrixOf(book, currency), book.cells, currency),
    }));
    const unassigned = [...book.matrix.customers]
      .filter((customer) => book.matrix.firstRevenue.get(customer) === undefined).length;

    const rows = parts
      .flatMap((part) => part.matrix.rows)
      .sort((a, b) => a.cohort.localeCompare(b.cohort) || String(a.currency).localeCompare(String(b.currency)));

    const offsets = new Map<number, { offset: number; accounts: number; retained: number }>();
    for (const part of parts) {
      for (const row of part.matrix.totals.by_offset) {
        const cell = offsets.get(row.offset) ?? { offset: row.offset, accounts: 0, retained: 0 };
        cell.accounts += row.accounts;
        cell.retained += row.retained;
        offsets.set(row.offset, cell);
      }
    }

    return {
      object: 'revenue_cohorts',
      ...this.envelope(
        book,
        'A retention matrix by signup month and currency: how many accounts, and how much MRR, each cohort still has n months later.',
        [
          'A cohort is the month an account first carried recurring revenue, paired with the currency it bills in. Accounts that have never carried any are counted in totals.unassigned_accounts rather than dropped silently.',
          'Offset 0 is the signup month itself, read at the close of that month — so an account that signed and cancelled inside its first month shows as offset-0 attrition rather than as a full retained logo.',
          'logo_retention is retained accounts over the cohort size. net_revenue_retention is the cohort\'s MRR at that offset over its MRR at offset 0, so it goes above 100% when the cohort expands.',
          'Every cell names the month it was read at, and the grid runs to the current month only — a cohort is never padded with months that have not happened.',
          'Logo retention by offset is pooled across currencies because it is a count. MRR retention by offset is not, because it is not.',
        ],
        { cohorts: rows.length, months_in_matrix: book.cells.length },
        { over: book.cells, subject: 'Cohort retention' },
      ),
      series: rows,
      totals: {
        cohorts: rows.length,
        accounts: rows.reduce((sum, row) => sum + row.accounts, 0),
        by_offset: [...offsets.values()]
          .sort((a, b) => a.offset - b.offset)
          .map((cell) => ({
            offset: cell.offset,
            accounts: cell.accounts,
            retained: cell.retained,
            logo_retention: ratio(cell.retained, cell.accounts),
            by_currency: parts.map((part) => {
              const row = part.matrix.totals.by_offset.find((entry) => entry.offset === cell.offset);
              return {
                currency: part.currency,
                accounts: row?.accounts ?? 0,
                retained: row?.retained ?? 0,
                mrr: row?.mrr ?? 0,
                initial_mrr: row?.initial_mrr ?? 0,
                net_revenue_retention: row?.net_revenue_retention ?? ratio(0, 0),
              };
            }),
          })),
        unassigned_accounts: unassigned,
        by_currency: parts.map((part) => ({
          currency: part.currency,
          cohorts: part.matrix.totals.cohorts,
          accounts: part.matrix.totals.accounts,
        })),
      },
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
         JOIN billing_invoices i ON i.id = l.invoice_id AND i.org_id = l.org_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY l.period_start ASC, l.id ASC`,
      ...(params as never[]),
    );

    const lineOf = (row: (typeof rows)[number]): RecognitionLine => ({
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
    });

    const lines: RecognitionLine[] = rows.map(lineOf);
    // The scope of a recognition report is the currencies of the lines it holds,
    // not the currencies of the workspace: ?invoice=in_… narrows to one bill,
    // and one bill is always in one currency, so its figures are stateable.
    const present = [...new Set(lines.map((line) => line.currency))];
    const scope = present.length
      ? currencyScope(book.requested, book.reporting, present)
      : currencyScope(book.requested, book.reporting, this.narrowedCurrencies(orgId, query) ?? book.scope.currencies);
    const report: RecognitionReport = recognise(lines, cells, asOf, scope.single);
    const parts = scope.currencies.map((currency) => ({
      currency,
      report: scope.single === currency
        ? report
        : recognise(lines.filter((line) => line.currency === currency), cells, asOf, currency),
    }));

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

    const balanced = report.reconciliation.balanced && parts.every((part) => part.report.reconciliation.balanced);

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
          'Every month in the series is read at its own close or at as_of, whichever is earlier, so the last cumulative figure in the series is the same number as totals.recognised rather than a later one.',
          'deferred goes negative where revenue was earned before it was billed — metered usage settles in arrears — and that part is reported separately as unbilled_balance rather than netted away silently.',
          'invoiced = recognised + deferred is an identity, not a check: deferred is defined as the difference. The checks that can actually fail are in reconciliation.checks — the daily schedule re-summed against its line, and recognised-to-date re-derived by a second traversal of the same days.',
        ],
        {
          billing_invoice_lines: lines.length,
          billing_invoices: new Set(lines.map((line) => line.invoice)).size,
          recognition_days: lines.reduce((sum, line) => sum + line.days, 0),
        },
        { subject: 'Recognised revenue', scope },
      ),
      series: report.rows.map((row, i) => ({
        month: row.month,
        period: row.period,
        complete: row.complete,
        read_at: row.read_at,
        in_scope: row.in_scope,
        currency: scope.single,
        invoiced: only(scope, row.invoiced),
        recognised: only(scope, row.recognised),
        invoiced_to_date: only(scope, row.invoiced_to_date),
        recognised_to_date: only(scope, row.recognised_to_date),
        deferred_balance: only(scope, row.deferred_balance),
        unbilled_balance: only(scope, row.unbilled_balance),
        by_currency: parts.map((part) => ({ ...part.report.rows[i], currency: part.currency })),
      })),
      totals: {
        lines: report.totals.lines,
        invoiced: only(scope, report.totals.invoiced),
        recognised: only(scope, report.totals.recognised),
        deferred_balance: only(scope, report.totals.deferred_balance),
        unbilled_balance: only(scope, report.totals.unbilled_balance),
        currency: scope.single,
      },
      by_currency: parts.map((part) => ({
        currency: part.currency,
        totals: part.report.totals,
        reconciliation: part.report.reconciliation,
      })),
      reconciliation: {
        invoiced: only(scope, report.reconciliation.invoiced),
        recognised: only(scope, report.reconciliation.recognised),
        deferred: only(scope, report.reconciliation.deferred),
        difference: only(scope, report.reconciliation.difference),
        balanced,
        note: report.reconciliation.note
          ?? parts.find((part) => !part.report.reconciliation.balanced)?.report.reconciliation.note
          ?? null,
        checks: report.reconciliation.checks,
      },
      balanced,
      lines: detail,
    };
  }

  /* ------------------------------ collections ---------------------------- */

  collections(orgId: string, query: RevenueQuery, prebuilt?: Book) {
    const book = prebuilt ?? this.book(orgId, query);
    const scope = book.scope;
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
    const creditNotes = this.ctx.db.all<{ currency: string; created: number; total: number }>(
      `SELECT currency, created, total FROM billing_credit_notes WHERE org_id = ? AND status = 'issued'${currencyClause}`,
      ...(invoiceParams as never[]),
    );

    const reportFor = (currency: string | null): CollectionsReport => collectionsReport({
      invoices: currency === null ? invoices : invoices.filter((row) => row.currency === currency),
      creditNotes: (currency === null ? creditNotes : creditNotes.filter((row) => row.currency === currency))
        .map((row) => ({ created: Number(row.created), total: Number(row.total) })),
      cells,
      from: book.range.from,
      to: book.range.to,
      currency,
      recovery: recoveryReport(this.ctx, orgId, book.range.from, book.range.to, currency),
    });

    const whole = reportFor(scope.single);
    const parts = scope.currencies.map((currency) => ({
      currency, report: scope.single === currency ? whole : reportFor(currency),
    }));
    const ageingOut = (report: CollectionsReport) => ({
      as_of: report.ageing.as_of,
      currency: scope.single,
      total: only(scope, report.ageing.total),
      invoices: report.ageing.invoices,
      buckets: report.ageing.buckets.map((bucket) => ({
        bucket: bucket.bucket,
        label: bucket.label,
        invoices: bucket.invoices,
        amount: only(scope, bucket.amount),
        share: onlyIn(scope, bucket.share),
        oldest_due: bucket.oldest_due,
      })),
      past_due_total: only(scope, report.ageing.past_due_total),
      past_due_share: onlyIn(scope, report.ageing.past_due_share),
      oldest_due: report.ageing.oldest_due,
      by_currency: parts.map((part) => ({ ...part.report.ageing, currency: part.currency })),
    });

    const oldest = (report: CollectionsReport) =>
      report.ageing.buckets.find((bucket) => bucket.bucket === 'd90_plus')?.amount ?? 0;

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
          'DSO is closing receivables divided by everything billed inside the range, times the days the range covers. Both figures use the same "what it asked for" definition, and both are in one currency — a DSO computed across currencies is a ratio of two numbers that were never in the same unit.',
          'Failed-payment exposure is the unrecovered balance of campaigns still in recovery. Recovery rate is money recovered over money at risk across campaigns that started inside the range, which is why it can differ from the attempt success rate beside it.',
          'Voided invoices are excluded everywhere: a withdrawn bill is not a receivable and never was.',
        ],
        {
          billing_invoices: invoices.length,
          billing_credit_notes: creditNotes.length,
          payments_dunning_campaigns: whole.recovery.campaigns_started,
          payments_dunning_attempts: whole.recovery.attempts.reduce((sum, row) => sum + row.attempts, 0),
        },
        { subject: 'Receivables' },
      ),
      series: whole.rows.map((row, i) => ({
        month: row.month,
        period: row.period,
        complete: row.complete,
        currency: scope.single,
        billed: only(scope, row.billed),
        collected: only(scope, row.collected),
        collected_on_billings: only(scope, row.collected_on_billings),
        credited: only(scope, row.credited),
        written_off: only(scope, row.written_off),
        outstanding: only(scope, row.outstanding),
        past_due: only(scope, row.past_due),
        collection_rate: onlyIn(scope, row.collection_rate),
        by_currency: parts.map((part) => ({ ...part.report.rows[i], currency: part.currency })),
      })),
      totals: {
        billed: only(scope, whole.totals.billed),
        collected: only(scope, whole.totals.collected),
        collected_on_billings: only(scope, whole.totals.collected_on_billings),
        credited: only(scope, whole.totals.credited),
        written_off: only(scope, whole.totals.written_off),
        outstanding: only(scope, whole.totals.outstanding),
        past_due: only(scope, whole.totals.past_due),
        collection_rate: onlyIn(scope, whole.totals.collection_rate),
        dso: onlyIn(scope, whole.totals.dso),
        dso_basis: whole.totals.dso_basis,
        days_in_range: whole.totals.days_in_range,
        currency: scope.single,
      },
      by_currency: parts.map((part) => ({
        currency: part.currency,
        totals: part.report.totals,
        ageing: part.report.ageing,
        recovery: part.report.recovery,
        exposure: {
          failed_payments: part.report.recovery.at_risk,
          campaigns: part.report.recovery.at_risk_campaigns,
          over_90_days: oldest(part.report),
          uncollectible_in_range: part.report.totals.written_off,
        },
      })),
      ageing: ageingOut(whole),
      recovery: {
        ...whole.recovery,
        at_risk: only(scope, whole.recovery.at_risk),
        amount_at_risk: only(scope, whole.recovery.amount_at_risk),
        amount_recovered: only(scope, whole.recovery.amount_recovered),
        recovery_rate: onlyIn(scope, whole.recovery.recovery_rate),
        by_status: whole.recovery.by_status.map((row) => ({
          status: row.status,
          campaigns: row.campaigns,
          amount_at_risk: only(scope, row.amount_at_risk),
          amount_recovered: only(scope, row.amount_recovered),
        })),
        top_failure_codes: whole.recovery.top_failure_codes.map((row) => ({
          code: row.code, campaigns: row.campaigns, amount: only(scope, row.amount),
        })),
      },
      exposure: {
        failed_payments: only(scope, whole.recovery.at_risk),
        campaigns: whole.recovery.at_risk_campaigns,
        over_90_days: only(scope, oldest(whole)),
        uncollectible_in_range: only(scope, whole.totals.written_off),
        note: whole.recovery.at_risk_campaigns
          ? `${whole.recovery.at_risk_campaigns} bill${whole.recovery.at_risk_campaigns === 1 ? ' is' : 's are'} still being retried.`
          : 'Nothing is in recovery: every failed charge in this range was either collected or written off.',
      },
    };
  }

  /* --------------------------------- usage -------------------------------- */

  usage(orgId: string, query: RevenueQuery, prebuilt?: Book) {
    const book = prebuilt ?? this.book(orgId, query);
    const scope = book.scope;
    const cells = this.windowOf(book);
    const report: UsageReport = usageReport(this.ctx, orgId, book.range.from, book.range.to, cells, scope);

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
          'A credit flow is a ledger and is reported like one: every field is the signed sum of one ledger type, so a burn is negative and a refund carries whichever sign the refund had. Rollovers in and out are named separately from grants — a rollover is credit moving between grants, not credit sold — and any type this report does not name lands in `other` rather than disappearing.',
          'Overage share is charged usage over everything invoiced in the range, on finalised invoices only.',
          'reconciliation.checks are the checks that can fail: the three settlement columns re-summed against each other, the named flow components against the movement of the ledger they came from, and every ledger row against the grant it belongs to.',
        ],
        {
          credit_settlements: report.totals.settlements,
          credit_settlements_skipped: report.totals.skipped_settlements,
          credit_grants: report.credit.grants,
          meters: report.meters.length,
          credit_ledger_entries: report.credit.flows.reduce((sum, flow) => sum + flow.entries, 0),
        },
        { subject: 'Usage revenue' },
      ),
      series: report.months.map((row, i) => ({
        month: row.month,
        period: row.period,
        complete: row.complete,
        settlements: row.settlements,
        metered_value: only(scope, row.metered_value),
        credit_covered: only(scope, row.credit_covered),
        charged: only(scope, row.charged),
        by_currency: report.by_currency.map((part) => ({ currency: part.currency, ...part.months[i] })),
      })),
      totals: {
        metered_value: only(scope, report.totals.metered_value),
        credit_covered: only(scope, report.totals.credit_covered),
        charged: only(scope, report.totals.charged),
        settlements: report.totals.settlements,
        skipped_settlements: report.totals.skipped_settlements,
        currency: scope.single,
        metered_share_of_invoiced: onlyIn(scope, report.totals.metered_share_of_invoiced),
        overage_share_of_invoiced: onlyIn(scope, report.totals.overage_share_of_invoiced),
        invoiced: only(scope, report.totals.invoiced),
      },
      by_currency: report.by_currency,
      meters: report.meters,
      credit: {
        flows: scope.single ? report.credit.flows : report.by_currency.flatMap((part) => part.credit.flows),
        purchased: only(scope, report.credit.purchased),
        purchase_lines: report.credit.purchase_lines,
        burned_against_usage: only(scope, report.credit.burned_against_usage),
        purchase_to_burn: onlyIn(scope, report.credit.purchase_to_burn),
        outstanding_monetary: only(scope, report.credit.outstanding_monetary),
        outstanding_unit_micro: report.credit.outstanding_unit_micro,
        grants: report.credit.grants,
      },
      invoiced_mix: report.invoiced_mix,
      reconciliation: report.reconciliation,
      balanced: report.reconciliation.balanced,
    };
  }

  /* -------------------------------- summary ------------------------------- */

  summary(orgId: string, query: RevenueQuery) {
    // Two books cover every section, and both are read once: the window for the
    // series, the full history for anything cohorted. Nothing below re-reads
    // the database, so the six sections cannot disagree with each other.
    const window = this.book(orgId, query);
    const history = this.book(orgId, query, { fullHistory: true });
    const scope = window.scope;
    const mrr = this.mrr(orgId, query, window);
    const movement = this.movement(orgId, query, window);
    const churn = this.churn(orgId, query, history);
    const collections = this.collections(orgId, query, window);
    const usage = this.usage(orgId, query, window);
    const deferred = this.deferred(orgId, query, window);

    const latest = movement.series[movement.series.length - 1] ?? null;
    const balanced = movement.balanced && deferred.balanced && usage.balanced;

    const currencyAt = <T extends { currency: string | null }>(rows: T[], currency: string): T | undefined =>
      rows.find((row) => row.currency === currency);

    // One row per month, drawn from the six sections rather than recomputed —
    // so a dashboard can chart recurring revenue, movement, recognition, cash
    // and usage on one axis and know they came from one read of the book.
    const series = movement.series.map((row, i) => ({
      month: row.month,
      period: row.period,
      complete: row.complete,
      mrr: row.closing,
      arr: row.closing === null ? null : annualise(row.closing),
      net_movement: row.net,
      new_business: row.new_business,
      expansion: row.expansion,
      reactivation: row.reactivation,
      contraction: row.contraction,
      churn: row.churn,
      reconciled: row.reconciliation.balanced,
      accounts: mrr.series[i]?.accounts ?? 0,
      invoiced: deferred.series[i]?.invoiced ?? null,
      recognised: deferred.series[i]?.recognised ?? null,
      deferred_balance: deferred.series[i]?.deferred_balance ?? null,
      billed: collections.series[i]?.billed ?? null,
      collected: collections.series[i]?.collected ?? null,
      receivables: collections.series[i]?.outstanding ?? null,
      metered_value: usage.series[i]?.metered_value ?? null,
      usage_charged: usage.series[i]?.charged ?? null,
      by_currency: scope.currencies.map((currency) => {
        const move = currencyAt(row.by_currency, currency);
        const rec = currencyAt(deferred.series[i]?.by_currency ?? [], currency);
        const cash = currencyAt(collections.series[i]?.by_currency ?? [], currency);
        const meter = currencyAt(usage.series[i]?.by_currency ?? [], currency);
        return {
          currency,
          mrr: move?.closing ?? 0,
          arr: annualise(move?.closing ?? 0),
          net_movement: move?.net ?? 0,
          invoiced: rec?.invoiced ?? 0,
          recognised: rec?.recognised ?? 0,
          deferred_balance: rec?.deferred_balance ?? 0,
          billed: cash?.billed ?? 0,
          collected: cash?.collected ?? 0,
          receivables: cash?.outstanding ?? 0,
          metered_value: meter?.metered_value ?? 0,
          usage_charged: meter?.charged ?? 0,
        };
      }),
    }));

    const headlineFor = (currency: string) => {
      const money = currencyAt(mrr.by_currency, currency);
      const run = currencyAt(mrr.usage.by_currency, currency);
      const move = currencyAt(movement.by_currency, currency);
      const retention = currencyAt(churn.by_currency, currency);
      const cash = currencyAt(collections.by_currency, currency);
      const rec = currencyAt(deferred.by_currency, currency);
      const meter = currencyAt(usage.by_currency, currency);
      return {
        currency,
        mrr: money?.mrr ?? 0,
        arr: money?.arr ?? 0,
        mrr_with_usage: run?.mrr_with_usage ?? money?.mrr ?? 0,
        arr_with_usage: run?.arr_with_usage ?? money?.arr ?? 0,
        accounts: money?.accounts ?? 0,
        net_new_mrr_this_month: currencyAt(latest?.by_currency ?? [], currency)?.net ?? 0,
        net_revenue_retention: retention?.totals.net_revenue_retention ?? ratio(0, 0),
        gross_revenue_retention: retention?.totals.gross_revenue_retention ?? ratio(0, 0),
        logo_churn: retention?.totals.logo_churn ?? ratio(0, 0),
        receivables: cash?.totals.outstanding ?? 0,
        past_due: cash?.totals.past_due ?? 0,
        dso: cash?.totals.dso ?? null,
        deferred_balance: rec?.totals.deferred_balance ?? 0,
        overage_share: meter?.totals.overage_share_of_invoiced ?? ratio(0, 0),
        closing_mrr: move?.totals.closing ?? 0,
      };
    };

    return {
      object: 'revenue_summary',
      as_of: mrr.as_of,
      range: mrr.range,
      currency: scope.single,
      basis: {
        summary: 'One screen of the revenue half of the business. Every section keeps its own basis and sources; nothing here is recomputed.',
        rules: [
          'Each block is the same computation the dedicated endpoint runs, so /v1/revenue/summary can never disagree with /v1/revenue/mrr, /movement, /churn, /collections, /deferred or /usage.',
          'The headline is only safe to read when balanced is true: it is false whenever a month\'s movement, the recognition schedule or the usage ledger failed its reconciliation.',
          ...mrr.basis.rules.slice(0, 3),
          RULE,
        ],
        currency: scope,
      },
      sources: {
        ...mrr.sources,
        ...collections.sources,
        ...usage.sources,
        ...deferred.sources,
      },
      truncated: window.truncated,
      window_clipped: window.clipped,
      balanced,
      series,
      totals: {
        currency: scope.single,
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
        credit_burned: usage.credit.burned_against_usage,
      },
      headline: {
        mrr: mrr.totals.mrr,
        arr: mrr.totals.arr,
        mrr_with_usage: mrr.usage.mrr_with_usage,
        arr_with_usage: mrr.usage.arr_with_usage,
        accounts: mrr.totals.accounts,
        net_new_mrr_this_month: latest?.net ?? null,
        net_revenue_retention: churn.totals.net_revenue_retention,
        gross_revenue_retention: churn.totals.gross_revenue_retention,
        logo_churn: churn.totals.logo_churn,
        receivables: collections.totals.outstanding,
        past_due: collections.totals.past_due,
        dso: collections.totals.dso,
        deferred_balance: deferred.totals.deferred_balance,
        overage_share: usage.totals.overage_share_of_invoiced,
      },
      by_currency: scope.currencies.map(headlineFor),
      movement: {
        latest_month: latest,
        totals: movement.totals,
        by_currency: movement.by_currency,
        reconciliation: movement.reconciliation,
        unbalanced_months: movement.unbalanced_months,
      },
      churn: {
        totals: churn.totals,
        by_currency: churn.by_currency,
        latest_month: churn.series[churn.series.length - 1] ?? null,
      },
      collections: {
        totals: collections.totals,
        by_currency: collections.by_currency,
        ageing: collections.ageing,
        exposure: collections.exposure,
      },
      usage: {
        totals: usage.totals,
        credit: usage.credit,
        meters: usage.meters.slice(0, 8),
        reconciliation: usage.reconciliation,
      },
      deferred: { totals: deferred.totals, reconciliation: deferred.reconciliation },
      mrr: { series: mrr.series, by_currency: mrr.by_currency, by_cadence: mrr.by_cadence, usage: mrr.usage },
      warnings: [
        ...mrr.warnings,
        ...(movement.warning ? [movement.warning] : []),
        ...(deferred.balanced ? [] : [`Recognition does not reconcile: ${deferred.reconciliation.note}`]),
        ...(usage.balanced ? [] : [`Usage does not reconcile: ${usage.reconciliation.note}`]),
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

    // An account almost always bills in one currency, and when it does every
    // figure below is a real amount in it. When it does not, the same rule
    // applies here as everywhere else.
    const currencies = [...new Set([
      ...timelines.map((line) => line.currency),
      ...(customer ? [customer.currency] : []),
    ])].sort();
    const scope = currencyScope(
      book.requested, customer?.currency ?? book.reporting, currencies.length ? currencies : [book.reporting],
    );
    const mrrIn = (currency: string) => timelines
      .filter((line) => line.currency === currency)
      .reduce((sum, line) => sum + line.current_mrr, 0);
    const mrrNow = timelines.reduce((sum, line) => sum + line.current_mrr, 0);

    const invoices = this.ctx.db.all<InvoiceRow>(
      `SELECT id, number, customer_id, subscription_id, currency, status, total, amount_due, amount_paid,
              due_date, finalized_at, paid_at, voided_at, marked_uncollectible_at, created
         FROM billing_invoices WHERE org_id = ? AND customer_id = ? AND status <> 'draft' AND voided_at IS NULL`,
      orgId, customerId,
    );
    const billed = this.ctx.db.all<{ currency: string; amount: number }>(
      `SELECT currency, COALESCE(SUM(amount_due + amount_paid), 0) AS amount FROM billing_invoices
        WHERE org_id = ? AND customer_id = ? AND status IN ('open', 'paid', 'uncollectible')
        GROUP BY currency`,
      orgId, customerId,
    );

    return {
      object: 'revenue_account',
      customer: customerId,
      name: customer?.name ?? customerId,
      currency: scope.single,
      basis: { currency: scope, rules: [RULE] },
      warnings: mixedWarning(scope, `${customer?.name ?? customerId}'s book`),
      as_of: book.now,
      first_revenue_at: first,
      cohort: first === null ? null : book.cells.find((cell) => first >= cell.start && first < cell.end)?.key ?? null,
      mrr: only(scope, mrrNow),
      arr: only(scope, annualise(mrrNow)),
      by_currency: scope.currencies.map((currency) => ({
        currency,
        mrr: mrrIn(currency),
        arr: annualise(mrrIn(currency)),
        lifetime_billed: billed.filter((line) => line.currency === currency).reduce((sum, line) => sum + Number(line.amount), 0),
        receivable: ageBook(invoices.filter((invoice) => invoice.currency === currency), book.now, currency),
      })),
      series: book.cells.map((cell, i) => ({
        month: cell.key,
        at: cell.at,
        mrr: only(scope, row ? row[i + 1] : 0),
        by_currency: scope.currencies.map((currency) => ({
          currency,
          mrr: (this.matrixOf(book, currency).values.get(customerId) ?? [])[i + 1] ?? 0,
        })),
      })),
      subscriptions: timelines,
      lifetime_billed: only(scope, billed.reduce((sum, line) => sum + Number(line.amount), 0)),
      receivable: scope.single
        ? ageBook(invoices, book.now, scope.single)
        : null,
    };
  }

  /* ------------------------------ account list ---------------------------- */

  /**
   * MRR by account.
   *
   * Sorted by currency first and size second, because sorting a mixed book by
   * size alone ranks a ¥100,000 account level with a $1,000.00 one: the numbers
   * are only comparable inside one currency. `?currency=` narrows it to one
   * group; without it the list is grouped rather than ranked.
   */
  accounts(orgId: string, query: RevenueQuery & { limit?: number }, prebuilt?: Book) {
    const book = prebuilt ?? this.book(orgId, query, { fullHistory: true });
    const scope = book.scope;

    // A row is an account **in a currency**, not an account: the rare customer
    // holding a dollar contract and a euro one has two books, and adding them
    // to fill one row would put the very figure this module refuses to state
    // back on the screen, under a currency label that only fits half of it.
    const rows = scope.currencies.flatMap((currency) => {
      const matrix = this.matrixOf(book, currency);
      return [...book.customers.values()]
        .map((customer) => {
          const lines = book.timelines.filter(
            (line) => line.customer === customer.id && line.currency === currency,
          );
          const mrr = lines.reduce((sum, line) => sum + line.current_mrr, 0);
          const series = matrix.values.get(customer.id);
          const previous = series ? series[Math.max(0, series.length - 2)] : 0;
          return {
            object: 'revenue_account_row' as const,
            customer: customer.id,
            name: customer.name,
            currency,
            mrr,
            arr: annualise(mrr),
            previous_month_mrr: previous,
            change: mrr - previous,
            subscriptions: lines.filter((line) => line.current_mrr !== 0).length,
            first_revenue_at: matrix.firstRevenue.get(customer.id) ?? null,
          };
        })
        .filter((row) => row.mrr !== 0 || row.previous_month_mrr !== 0)
        .sort((a, b) => b.mrr - a.mrr || a.name.localeCompare(b.name));
    });

    const groups = scope.currencies.map((currency) => {
      const inCurrency = rows.filter((row) => row.currency === currency);
      const mrr = inCurrency.reduce((sum, row) => sum + row.mrr, 0);
      return {
        currency,
        accounts: inCurrency.length,
        mrr,
        arr: annualise(mrr),
        largest: inCurrency[0]?.customer ?? null,
      };
    });

    return { rows, groups, scope };
  }
}

export type { CurrencyScope, Scalar };
