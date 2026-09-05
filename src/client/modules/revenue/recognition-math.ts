/**
 * The arithmetic behind the recognition screen.
 *
 * `GET /v1/revenue/deferred` publishes, per month, what was billed, what was
 * credited, what was earned and the deferred balance at the close. A finance
 * lead reads that as a roll-forward — opening balance, plus what was billed,
 * less what was credited, less what was earned, equals closing — and checks it
 * with a calculator. This module does the same check for every row so the
 * screen can badge each one, and re-adds a line's daily schedule so a
 * drill-down can prove the days sum back to the line.
 *
 * Pure: no React, no design system.
 */
import type { DeferredMonth, RecognitionDay } from './types';

export interface RollForwardRow {
  month: string;
  complete: boolean;
  /** Deferred balance at the open of the month: last month's closing. */
  opening: number;
  /** Billed this month before credit notes — `invoiced + credited`. */
  billed: number;
  /** Credit notes issued this month, as a positive magnitude. */
  credited: number;
  /** Earned this month. */
  recognised: number;
  /** The API's deferred balance at the close. */
  closing: number;
  /** `opening + billed - credited - recognised`, re-derived here. */
  computed: number;
  /** `closing - computed`; zero when the row rolls forward. */
  difference: number;
  balanced: boolean;
  /** Earned but not yet billed at the close, gross. */
  unbilled: number;
  /** Cumulative figures at the close, for the chart and the export. */
  invoicedToDate: number;
  recognisedToDate: number;
}

const money = (value: number | null): number => value ?? 0;

/**
 * The roll-forward, row by row. Months the report never reached (`in_scope`
 * false) are dropped: they carry zeros, not balances. A month with null money
 * — a mixed-currency scope — is dropped too; the screen asks for one currency
 * and there is nothing to roll forward until it does.
 */
export function rollForward(series: DeferredMonth[]): RollForwardRow[] {
  return series
    .filter((row) => row.in_scope && row.deferred_balance !== null)
    .map((row) => {
      const invoiced = money(row.invoiced);
      const credited = money(row.credited);
      const recognised = money(row.recognised);
      const invoicedToDate = money(row.invoiced_to_date);
      const recognisedToDate = money(row.recognised_to_date);
      // The balance at the open is the cumulative position before this
      // month's movements — the API's own figures, not last row's closing, so
      // the first row of a window has an opening too.
      const opening = (invoicedToDate - invoiced) - (recognisedToDate - recognised);
      const closing = money(row.deferred_balance);
      const computed = opening + invoiced - recognised;
      return {
        month: row.month,
        complete: row.complete,
        opening,
        billed: invoiced + credited,
        credited,
        recognised,
        closing,
        computed,
        difference: closing - computed,
        balanced: closing === computed,
        unbilled: money(row.unbilled_balance),
        invoicedToDate,
        recognisedToDate,
      };
    });
}

export interface ScheduleMonth {
  month: string;
  days: number;
  recognisedDays: number;
  amount: number;
  recognisedAmount: number;
  /** 'earned' once every day has elapsed, 'ahead' while none has, 'running' in between. */
  state: 'earned' | 'running' | 'ahead';
}

/** A line's day-by-day schedule folded into months, in calendar order. */
export function scheduleByMonth(days: RecognitionDay[]): ScheduleMonth[] {
  const months = new Map<string, ScheduleMonth>();
  for (const day of days) {
    const key = day.day.slice(0, 7);
    const row = months.get(key) ?? { month: key, days: 0, recognisedDays: 0, amount: 0, recognisedAmount: 0, state: 'ahead' as const };
    row.days += 1;
    row.amount += day.amount;
    if (day.recognised) { row.recognisedDays += 1; row.recognisedAmount += day.amount; }
    months.set(key, row);
  }
  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((row) => ({
      ...row,
      state: row.recognisedDays === row.days ? 'earned' : row.recognisedDays === 0 ? 'ahead' : 'running',
    }));
}

/** Does the schedule add back to the line, and does its earned part match recognised-to-date? */
export function scheduleReconciles(
  days: RecognitionDay[], line: { amount: number; recognised_to_date: number },
): { total: number; recognised: number; sumsToLine: boolean; matchesRecognised: boolean } {
  const total = days.reduce((sum, day) => sum + day.amount, 0);
  const recognised = days.reduce((sum, day) => sum + (day.recognised ? day.amount : 0), 0);
  return {
    total,
    recognised,
    sumsToLine: total === line.amount,
    matchesRecognised: recognised === line.recognised_to_date,
  };
}

/** The check names the API publishes, in words a person would use. */
export const CHECK_LABEL: Record<string, string> = {
  schedule_sums_to_line: 'Every daily schedule adds back to its line',
  cursor_matches_filter: 'Recognised-to-date agrees when derived a second way',
  credits_within_the_lines_they_reduce: 'No credit note exceeds the line it reduces',
  series_ends_at_totals: 'The monthly series ends on the total',
};
