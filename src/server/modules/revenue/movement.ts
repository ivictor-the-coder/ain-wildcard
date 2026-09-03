/**
 * MRR movement, churn and cohorts — all four from one matrix.
 *
 * Movement is classified **per customer**, not per subscription. A customer who
 * cancels a monthly plan and signs an annual one on the same day has not
 * churned and re-joined; they have expanded or contracted, and only a
 * customer-level comparison can tell which. That is also why "new" and
 * "reactivation" can be told apart: the matrix knows the first instant an
 * account ever carried revenue, so a return after a gap is never counted as a
 * fresh logo.
 *
 * Every month is one subtraction: `closing - opening` per customer, bucketed by
 * the sign and by whether either end was zero. Because the buckets partition
 * that difference exactly, `opening + new + expansion + reactivation + resumed
 * - contraction - churn - paused` *is* `closing`, to the cent, with no plug.
 * The reconciliation block on every row re-derives the closing figure from the
 * movements and compares it against a closing figure summed straight from the
 * subscription timelines, so a disagreement is reported rather than drawn.
 *
 * A collection pause is not a cancellation. The account's recognised MRR does
 * go to zero — nothing is being collected — but the contract is intact, which
 * is why the matrix reads the paused pool beside the recognised one: an account
 * whose recognised MRR fell to zero while its contract survived is `paused`,
 * one whose recognised MRR came back out of that pool is `resumed`, and churn
 * is left meaning what a controller means by it — the contract ended.
 */
import { monthKey } from '../../../shared/time';
import type { MonthCell } from './grid';
import { ratio, type Ratio } from './ratio';
import { OPEN_ENDED, mrrAt, pausedAt, type SubscriptionTimeline } from './timeline';

export interface RevenueMatrix {
  instants: number[];
  /** customer id → MRR in minor units at each instant. */
  values: Map<string, number[]>;
  /**
   * customer id → contracted-but-paused MRR at each instant. Zero outside a
   * collection pause; inside one, what the account would be worth if it were
   * being collected.
   */
  paused: Map<string, number[]>;
  /** customer id → the first instant it ever carried recurring revenue. */
  firstRevenue: Map<string, number>;
  /** Total at each instant, summed over subscriptions rather than customers. */
  totals: number[];
  customers: string[];
}

/**
 * Read every subscription timeline at every instant once.
 *
 * `totals` is deliberately summed over subscriptions while `values` is grouped
 * by customer: the two aggregations meet again in the reconciliation check, and
 * a bug in the grouping shows up there instead of in a chart.
 */
export function buildMatrix(timelines: SubscriptionTimeline[], instants: number[]): RevenueMatrix {
  const values = new Map<string, number[]>();
  const paused = new Map<string, number[]>();
  const firstRevenue = new Map<string, number>();
  const totals = new Array<number>(instants.length).fill(0);

  for (const timeline of timelines) {
    let row = values.get(timeline.customer);
    let held = paused.get(timeline.customer);
    if (!row) { row = new Array<number>(instants.length).fill(0); values.set(timeline.customer, row); }
    if (!held) { held = new Array<number>(instants.length).fill(0); paused.set(timeline.customer, held); }
    for (let i = 0; i < instants.length; i++) {
      const amount = mrrAt(timeline, instants[i]);
      row[i] += amount;
      totals[i] += amount;
      held[i] += pausedAt(timeline, instants[i]);
    }
    for (const segment of timeline.segments) {
      if (segment.mrr <= 0) continue;
      const known = firstRevenue.get(timeline.customer);
      if (known === undefined || segment.from < known) firstRevenue.set(timeline.customer, segment.from);
      break;
    }
  }

  return { instants, values, paused, firstRevenue, totals, customers: [...values.keys()] };
}

/* -------------------------------- movement -------------------------------- */

export interface MovementCounts {
  /**
   * Accounts with a live contract at the open — recognised or paused. An
   * account whose collection is paused is still an account, and counting it
   * only when it churns would put it in the numerator of logo churn and never
   * in the denominator.
   */
  accounts_at_open: number;
  accounts_at_close: number;
  new_accounts: number;
  reactivated_accounts: number;
  expanded_accounts: number;
  contracted_accounts: number;
  /** Accounts whose contract ended this month, paused or not. */
  churned_accounts: number;
  paused_accounts: number;
  resumed_accounts: number;
}

export interface MovementReconciliation {
  /** `opening + new + expansion + reactivation + resumed - contraction - churn - paused`. */
  computed_closing: number;
  /** Closing summed straight from the subscription timelines. */
  reported_closing: number;
  difference: number;
  balanced: boolean;
  /** Present only when the two paths disagree. */
  note: string | null;
}

export type MovementKind = 'new' | 'expansion' | 'reactivation' | 'contraction' | 'churn' | 'paused' | 'resumed';

export interface Mover {
  customer: string;
  name: string;
  kind: MovementKind;
  /** The currency this movement is in. Null only on a mixed-book row, which is why one is never published. */
  currency: string | null;
  /** Signed: what this account added to, or took off, the month. */
  amount: number;
  from: number;
  to: number;
}

export interface MovementRow {
  month: string;
  period: { start: number; end: number };
  /** The instants the two figures were read at. */
  opening_at: number;
  closing_at: number;
  complete: boolean;
  currency: string | null;
  opening: number;
  new_business: number;
  expansion: number;
  reactivation: number;
  /** Recognised MRR that came back out of a collection pause. */
  resumed: number;
  /** Positive magnitudes: what came off. */
  contraction: number;
  churn: number;
  /** Recognised MRR that went into a collection pause: not collected, not lost. */
  paused: number;
  net: number;
  closing: number;
  counts: MovementCounts;
  /** The accounts that moved the month most, largest absolute movement first. */
  top_movers: Mover[];
  reconciliation: MovementReconciliation;
}

interface CustomerDelta {
  customer: string;
  opening: number;
  closing: number;
  /** The paused pool at each end: contracted, not collected. */
  paused_at_open: number;
  paused_at_close: number;
}

function classify(
  matrix: RevenueMatrix, index: number, cell: MonthCell, names: Map<string, string>, topMovers: number,
  currency: string | null,
): Omit<MovementRow, 'month' | 'period' | 'opening_at' | 'closing_at' | 'complete' | 'currency'> {
  let opening = 0, newBusiness = 0, expansion = 0, reactivation = 0, resumed = 0, contraction = 0, churn = 0, paused = 0;
  const counts: MovementCounts = {
    accounts_at_open: 0, accounts_at_close: 0, new_accounts: 0, reactivated_accounts: 0,
    expanded_accounts: 0, contracted_accounts: 0, churned_accounts: 0, paused_accounts: 0, resumed_accounts: 0,
  };
  const movers: Mover[] = [];
  const moved = (customer: string, kind: MovementKind, amount: number, delta: CustomerDelta) => {
    movers.push({
      customer, kind, amount, currency, name: names.get(customer) ?? customer,
      from: delta.opening, to: delta.closing,
    });
  };

  for (const [customer, row] of matrix.values) {
    const held = matrix.paused.get(customer);
    const delta: CustomerDelta = {
      customer,
      opening: row[index],
      closing: row[index + 1],
      paused_at_open: held ? held[index] : 0,
      paused_at_close: held ? held[index + 1] : 0,
    };
    const contractOpen = delta.opening + delta.paused_at_open;
    const contractClose = delta.closing + delta.paused_at_close;
    opening += delta.opening;
    if (contractOpen !== 0) counts.accounts_at_open += 1;
    if (contractClose !== 0) counts.accounts_at_close += 1;
    // Logo churn is about contracts, not collection: an account that cancels
    // while paused has churned even though the bar cannot show it (its
    // recognised MRR was already zero), and one that pauses has not.
    if (contractOpen !== 0 && contractClose === 0) counts.churned_accounts += 1;
    if (delta.closing === delta.opening) continue;

    if (delta.opening === 0) {
      if (delta.paused_at_open !== 0) {
        resumed += delta.closing;
        counts.resumed_accounts += 1;
        moved(customer, 'resumed', delta.closing, delta);
        continue;
      }
      const first = matrix.firstRevenue.get(customer) ?? OPEN_ENDED;
      if (first >= cell.start) {
        newBusiness += delta.closing;
        counts.new_accounts += 1;
        moved(customer, 'new', delta.closing, delta);
      } else {
        reactivation += delta.closing;
        counts.reactivated_accounts += 1;
        moved(customer, 'reactivation', delta.closing, delta);
      }
    } else if (delta.closing === 0) {
      if (delta.paused_at_close !== 0) {
        paused += delta.opening;
        counts.paused_accounts += 1;
        moved(customer, 'paused', -delta.opening, delta);
      } else {
        churn += delta.opening;
        moved(customer, 'churn', -delta.opening, delta);
      }
    } else if (delta.closing > delta.opening) {
      expansion += delta.closing - delta.opening;
      counts.expanded_accounts += 1;
      moved(customer, 'expansion', delta.closing - delta.opening, delta);
    } else {
      contraction += delta.opening - delta.closing;
      counts.contracted_accounts += 1;
      moved(customer, 'contraction', delta.closing - delta.opening, delta);
    }
  }

  const computed = opening + newBusiness + expansion + reactivation + resumed - contraction - churn - paused;
  const reported = matrix.totals[index + 1];
  const difference = computed - reported;

  return {
    opening,
    new_business: newBusiness,
    expansion,
    reactivation,
    resumed,
    contraction,
    churn,
    paused,
    net: newBusiness + expansion + reactivation + resumed - contraction - churn - paused,
    closing: reported,
    counts,
    top_movers: movers
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.customer.localeCompare(b.customer))
      .slice(0, topMovers),
    reconciliation: {
      computed_closing: computed,
      reported_closing: reported,
      difference,
      balanced: difference === 0,
      note: difference === 0
        ? null
        : `Opening plus movements comes to ${computed} minor units but the subscription ledger closes at ${reported}. ` +
          'The difference is shown rather than absorbed; the bar for this month is not safe to read.',
    },
  };
}

export interface MovementSeries {
  rows: MovementRow[];
  totals: {
    opening: number;
    new_business: number;
    expansion: number;
    reactivation: number;
    resumed: number;
    contraction: number;
    churn: number;
    paused: number;
    net: number;
    closing: number;
  };
  reconciliation: MovementReconciliation;
  /** Months whose movements did not add up. Empty is the only good answer. */
  unbalanced_months: string[];
}

export function movementSeries(
  matrix: RevenueMatrix,
  cells: MonthCell[],
  currency: string | null,
  opts: { names?: Map<string, string>; topMovers?: number } = {},
): MovementSeries {
  const names = opts.names ?? new Map<string, string>();
  const topMovers = opts.topMovers ?? 5;
  const rows: MovementRow[] = cells.map((cell, index) => ({
    month: cell.key,
    period: { start: cell.start, end: cell.end },
    opening_at: cell.opens_at,
    closing_at: cell.at,
    complete: cell.complete,
    currency,
    ...classify(matrix, index, cell, names, topMovers, currency),
  }));

  const totals = {
    opening: rows.length ? rows[0].opening : 0,
    new_business: rows.reduce((sum, row) => sum + row.new_business, 0),
    expansion: rows.reduce((sum, row) => sum + row.expansion, 0),
    reactivation: rows.reduce((sum, row) => sum + row.reactivation, 0),
    resumed: rows.reduce((sum, row) => sum + row.resumed, 0),
    contraction: rows.reduce((sum, row) => sum + row.contraction, 0),
    churn: rows.reduce((sum, row) => sum + row.churn, 0),
    paused: rows.reduce((sum, row) => sum + row.paused, 0),
    net: 0,
    closing: rows.length ? rows[rows.length - 1].closing : 0,
  };
  totals.net = totals.new_business + totals.expansion + totals.reactivation + totals.resumed
    - totals.contraction - totals.churn - totals.paused;
  const computed = totals.opening + totals.net;
  const difference = computed - totals.closing;

  return {
    rows,
    totals,
    reconciliation: {
      computed_closing: computed,
      reported_closing: totals.closing,
      difference,
      balanced: difference === 0,
      note: difference === 0
        ? null
        : `The range opens at ${totals.opening} and its movements sum to ${totals.net}, which comes to ${computed}, ` +
          `but the closing month reads ${totals.closing}.`,
    },
    unbalanced_months: rows.filter((row) => !row.reconciliation.balanced).map((row) => row.month),
  };
}

/* ---------------------------------- churn --------------------------------- */

export interface ChurnRow {
  month: string;
  period: { start: number; end: number };
  complete: boolean;
  currency: string | null;
  opening_mrr: number;
  closing_mrr: number;
  churned_mrr: number;
  contraction_mrr: number;
  expansion_mrr: number;
  reactivation_mrr: number;
  /** Recognised MRR that went into a collection pause this month. */
  paused_mrr: number;
  /** Recognised MRR that came back out of one. */
  resumed_mrr: number;
  accounts_at_open: number;
  churned_accounts: number;
  paused_accounts: number;
  logo_churn: Ratio;
  logo_retention: Ratio;
  /** Churn plus downgrades over opening MRR. A pause is in neither. */
  gross_revenue_churn: Ratio;
  /**
   * Gross revenue retention: opening less churn, contraction and pauses. Paused
   * MRR is not lost, but it is not retained either — nothing is being
   * collected — so it is the third share, and the three add to 100%.
   */
  gross_revenue_retention: Ratio;
  /** The share of opening MRR that went into a pause this month. */
  paused_share: Ratio;
  /** Net dollar retention: what the accounts open at the start close at, over what they opened at. */
  net_revenue_retention: Ratio;
}

export function churnSeries(series: MovementSeries): {
  rows: ChurnRow[];
  totals: {
    opening_mrr: number;
    closing_mrr: number;
    churned_mrr: number;
    contraction_mrr: number;
    expansion_mrr: number;
    reactivation_mrr: number;
    paused_mrr: number;
    resumed_mrr: number;
    churned_accounts: number;
    paused_accounts: number;
    /** Sum of every month's opening — the denominator for the range rates. */
    exposed_mrr: number;
    exposed_accounts: number;
    logo_churn: Ratio;
    gross_revenue_churn: Ratio;
    gross_revenue_retention: Ratio;
    paused_share: Ratio;
    net_revenue_retention: Ratio;
  };
} {
  const rows: ChurnRow[] = series.rows.map((row) => {
    const kept = row.opening - row.churn - row.contraction - row.paused;
    return {
      month: row.month,
      period: row.period,
      complete: row.complete,
      currency: row.currency,
      opening_mrr: row.opening,
      closing_mrr: row.closing,
      churned_mrr: row.churn,
      contraction_mrr: row.contraction,
      expansion_mrr: row.expansion,
      reactivation_mrr: row.reactivation,
      paused_mrr: row.paused,
      resumed_mrr: row.resumed,
      accounts_at_open: row.counts.accounts_at_open,
      churned_accounts: row.counts.churned_accounts,
      paused_accounts: row.counts.paused_accounts,
      logo_churn: ratio(row.counts.churned_accounts, row.counts.accounts_at_open),
      logo_retention: ratio(row.counts.accounts_at_open - row.counts.churned_accounts, row.counts.accounts_at_open),
      gross_revenue_churn: ratio(row.churn + row.contraction, row.opening),
      gross_revenue_retention: ratio(kept, row.opening),
      paused_share: ratio(row.paused, row.opening),
      net_revenue_retention: ratio(kept + row.expansion + row.reactivation + row.resumed, row.opening),
    };
  });

  const exposedMrr = rows.reduce((sum, row) => sum + row.opening_mrr, 0);
  const exposedAccounts = rows.reduce((sum, row) => sum + row.accounts_at_open, 0);
  const churnedMrr = rows.reduce((sum, row) => sum + row.churned_mrr, 0);
  const contraction = rows.reduce((sum, row) => sum + row.contraction_mrr, 0);
  const expansion = rows.reduce((sum, row) => sum + row.expansion_mrr, 0);
  const reactivation = rows.reduce((sum, row) => sum + row.reactivation_mrr, 0);
  const pausedMrr = rows.reduce((sum, row) => sum + row.paused_mrr, 0);
  const resumedMrr = rows.reduce((sum, row) => sum + row.resumed_mrr, 0);
  const churnedAccounts = rows.reduce((sum, row) => sum + row.churned_accounts, 0);
  const pausedAccounts = rows.reduce((sum, row) => sum + row.paused_accounts, 0);
  const kept = exposedMrr - churnedMrr - contraction - pausedMrr;

  return {
    rows,
    totals: {
      opening_mrr: series.totals.opening,
      closing_mrr: series.totals.closing,
      churned_mrr: churnedMrr,
      contraction_mrr: contraction,
      expansion_mrr: expansion,
      reactivation_mrr: reactivation,
      paused_mrr: pausedMrr,
      resumed_mrr: resumedMrr,
      churned_accounts: churnedAccounts,
      paused_accounts: pausedAccounts,
      exposed_mrr: exposedMrr,
      exposed_accounts: exposedAccounts,
      logo_churn: ratio(churnedAccounts, exposedAccounts),
      gross_revenue_churn: ratio(churnedMrr + contraction, exposedMrr),
      gross_revenue_retention: ratio(kept, exposedMrr),
      paused_share: ratio(pausedMrr, exposedMrr),
      net_revenue_retention: ratio(kept + expansion + reactivation + resumedMrr, exposedMrr),
    },
  };
}

/* --------------------------------- cohorts -------------------------------- */

export interface CohortCell {
  /** Months since the signup month. 0 is the signup month itself. */
  offset: number;
  month: string;
  complete: boolean;
  accounts: number;
  mrr: number;
  logo_retention: Ratio;
  net_revenue_retention: Ratio;
}

export interface CohortRow {
  /** Signup month: the month the account first carried recurring revenue. */
  cohort: string;
  accounts: number;
  initial_mrr: number;
  /**
   * A cohort is keyed by month **and** currency: a March cohort billing in
   * euros and one billing in dollars are two cohorts, because their retention
   * curves are two different numbers and adding them makes neither.
   */
  currency: string | null;
  cells: CohortCell[];
}

export function cohortMatrix(matrix: RevenueMatrix, cells: MonthCell[], currency: string | null): {
  rows: CohortRow[];
  totals: {
    cohorts: number;
    accounts: number;
    /** Logo retention by offset across every cohort old enough to have one. */
    by_offset: { offset: number; accounts: number; retained: number; logo_retention: Ratio; mrr: number; initial_mrr: number; net_revenue_retention: Ratio }[];
    unassigned_accounts: number;
  };
} {
  const indexOf = new Map(cells.map((cell, i) => [cell.key, i]));
  const members = new Map<string, string[]>();
  let unassigned = 0;

  for (const customer of matrix.customers) {
    const first = matrix.firstRevenue.get(customer);
    if (first === undefined) { unassigned += 1; continue; }
    const key = monthKey(first);
    if (!indexOf.has(key)) { unassigned += 1; continue; }
    const list = members.get(key);
    if (list) list.push(customer); else members.set(key, [customer]);
  }

  // Column i of the matrix is the opening instant; column i+1 closes month i.
  const closingAt = (monthIndex: number): number => monthIndex + 1;

  const rows: CohortRow[] = [];
  for (const cell of cells) {
    const cohortMembers = members.get(cell.key);
    if (!cohortMembers?.length) continue;
    const start = indexOf.get(cell.key) as number;
    const initial = cohortMembers.reduce(
      (sum, customer) => sum + ((matrix.values.get(customer) as number[])[closingAt(start)] ?? 0), 0,
    );
    const cohortCells: CohortCell[] = [];
    for (let offset = 0; start + offset < cells.length; offset++) {
      const column = closingAt(start + offset);
      let accounts = 0, mrr = 0;
      for (const customer of cohortMembers) {
        const amount = (matrix.values.get(customer) as number[])[column] ?? 0;
        if (amount !== 0) accounts += 1;
        mrr += amount;
      }
      cohortCells.push({
        offset,
        month: cells[start + offset].key,
        complete: cells[start + offset].complete,
        accounts,
        mrr,
        logo_retention: ratio(accounts, cohortMembers.length),
        net_revenue_retention: ratio(mrr, initial),
      });
    }
    rows.push({
      cohort: cell.key,
      accounts: cohortMembers.length,
      initial_mrr: initial,
      currency,
      cells: cohortCells,
    });
  }

  const maxOffset = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  const byOffset = [];
  for (let offset = 0; offset < maxOffset; offset++) {
    let accounts = 0, retained = 0, mrr = 0, initial = 0;
    for (const row of rows) {
      const cell = row.cells[offset];
      if (!cell) continue;
      accounts += row.accounts;
      retained += cell.accounts;
      mrr += cell.mrr;
      initial += row.initial_mrr;
    }
    byOffset.push({
      offset,
      accounts,
      retained,
      logo_retention: ratio(retained, accounts),
      mrr,
      initial_mrr: initial,
      net_revenue_retention: ratio(mrr, initial),
    });
  }

  return {
    rows,
    totals: {
      cohorts: rows.length,
      accounts: rows.reduce((sum, row) => sum + row.accounts, 0),
      by_offset: byOffset,
      unassigned_accounts: unassigned,
    },
  };
}
