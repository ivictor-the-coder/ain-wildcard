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

/** Whole months from the start of one to the start of the other. */
const monthsBetween = (from: number, to: number): number => {
  const a = new Date(from), b = new Date(to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
};

/**
 * What was dropped when a requested window was longer than the grid draws.
 *
 * A report that silently answers a different question than the one asked is
 * worse than one that refuses, so the clip is named: how many months were
 * asked for, which ones survived, and exactly which ones were dropped.
 */
export interface WindowClip {
  requested_months: number;
  months_drawn: number;
  dropped_months: number;
  /** `1990-01` — the first month that was asked for and not drawn. */
  dropped_from: string;
  /** `2016-05` — the last one. */
  dropped_to: string;
  note: string;
}

export interface MonthGrid {
  cells: MonthCell[];
  /** Null whenever the whole requested window was drawn. */
  clipped: WindowClip | null;
}

/**
 * Every month from `from` to `to` inclusive, capped at `max`.
 *
 * When the span is longer than the cap it is the **most recent** `max` months
 * that survive, never the oldest: a request for 1990 to today is a request that
 * includes today, and answering it with the 1990s — which is what keeping the
 * head did — is a wrong answer wearing a right answer's shape. The months that
 * went are named in `clipped` so the caller can say so rather than draw a
 * series that quietly stops before the present.
 */
export function monthGrid(from: number, to: number, now: number, max = 120): MonthGrid {
  const first = startOfMonth(from);
  const last = startOfMonth(to);
  if (last < first) return { cells: [], clipped: null };

  const requested = monthsBetween(first, last) + 1;
  const drawFrom = requested > max
    ? addInterval(last, interval('month', -(max - 1)), 1)
    : first;

  const cells: MonthCell[] = [];
  let cursor = drawFrom;
  while (cursor <= last) {
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

  return { cells, clipped: clipBetween(first, drawFrom, cells, max) };
}

/**
 * The clip between the months a caller asked for and the months a report drew.
 *
 * Reported separately from `monthGrid` because a full-history grid legitimately
 * starts before the requested window: what matters to the caller is whether
 * *their* window survived, not whether the history behind it did.
 */
export function clipBetween(
  requestedFrom: number, drawnFrom: number, cells: MonthCell[], max: number,
): WindowClip | null {
  const first = startOfMonth(requestedFrom);
  const start = startOfMonth(drawnFrom);
  if (start <= first) return null;
  const dropped = monthsBetween(first, start);
  const lastDropped = monthKey(addInterval(start, interval('month', -1), 1));
  return {
    requested_months: dropped + cells.length,
    months_drawn: cells.length,
    dropped_months: dropped,
    dropped_from: monthKey(first),
    dropped_to: lastDropped,
    note:
      `This range asks for ${dropped + cells.length} months and this report draws at most ${max}, so the ${dropped} ` +
      `months from ${monthKey(first)} to ${lastDropped} were dropped. The series runs ${cells[0]?.key ?? '—'} to ` +
      `${cells[cells.length - 1]?.key ?? '—'}: the most recent months are kept, and every rate, cohort and total in ` +
      `this response is computed over those months alone. Ask for a narrower window, or read it ${max} months at a time.`,
  };
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
