/**
 * The month grid every series in this module is drawn on.
 *
 * One rule holds all of it together: **the closing instant of a month is the
 * opening instant of the next one**. Openings are read at `start - 1` and
 * closings at `end - 1`, so `closing(March) === opening(April)` is the same
 * lookup rather than two lookups that agree by luck. That identity is what lets
 * `opening + movements == closing` be a proof instead of a hope.
 *
 * A month still in progress closes at `now` rather than at a future instant, so
 * the current bar never counts a renewal that has not happened or drops a
 * subscription that is only scheduled to cancel.
 */
import { DAY, addInterval, interval, monthKey, startOfMonth } from '../../../shared/time';

export interface MonthCell {
  /** `2026-03` */
  key: string;
  /** First instant of the month. */
  start: number;
  /** First instant of the following month — exclusive. */
  end: number;
  /** The instant this month's closing figures are read at: `min(end - 1, now)`. */
  at: number;
  /** The instant this month's opening figures are read at: `min(start - 1, now)`. */
  opens_at: number;
  /** False while the month is still running. */
  complete: boolean;
  days: number;
}

const MONTH = interval('month', 1);

export const nextMonth = (ts: number): number => addInterval(startOfMonth(ts), MONTH, 1);

/**
 * Every month from `from` to `to` inclusive, capped at 120 so a bad range can
 * never turn into a scan of the century.
 */
export function monthGrid(from: number, to: number, now: number, max = 120): MonthCell[] {
  const cells: MonthCell[] = [];
  let cursor = startOfMonth(from);
  const last = startOfMonth(to);
  while (cursor <= last && cells.length < max) {
    const end = nextMonth(cursor);
    cells.push({
      key: monthKey(cursor),
      start: cursor,
      end,
      at: Math.min(end - 1, now),
      opens_at: Math.min(cursor - 1, now),
      complete: end - 1 <= now,
      days: Math.round((end - cursor) / DAY),
    });
    cursor = end;
  }
  return cells;
}

/** The instants a month grid needs read, opening first, in chronological order. */
export function instantsOf(cells: MonthCell[]): number[] {
  if (!cells.length) return [];
  return [cells[0].opens_at, ...cells.map((cell) => cell.at)];
}

export interface Range {
  from: number;
  to: number;
}

/** Default reporting window: the last twelve months, ending now. */
export function resolveRange(query: { from?: number; to?: number }, now: number, months = 12): Range {
  const to = query.to ?? now;
  const from = query.from ?? addInterval(startOfMonth(to), interval('month', -(months - 1)), 1);
  if (from > to) return { from: to, to };
  return { from, to };
}
