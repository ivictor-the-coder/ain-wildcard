/**
 * Calendar arithmetic in UTC, matching `shared/time`. Working in UTC keeps a
 * date from sliding a day when the workspace timezone differs from the browser.
 */
import { DAY, startOfDay } from '../../shared/time';

export interface CalendarDay {
  ts: number;
  day: number;
  /** Belongs to a neighbouring month but fills the grid. */
  outside: boolean;
  weekday: number;
}

export const utc = (year: number, month: number, day: number): number => Date.UTC(year, month, day);
export const yearOf = (ts: number): number => new Date(ts).getUTCFullYear();
export const monthOf = (ts: number): number => new Date(ts).getUTCMonth();
export const dayOf = (ts: number): number => new Date(ts).getUTCDate();
export const weekdayOf = (ts: number): number => new Date(ts).getUTCDay();

export const startOfMonthUtc = (ts: number): number => utc(yearOf(ts), monthOf(ts), 1);
export const addMonths = (ts: number, count: number): number => {
  const year = yearOf(ts);
  const month = monthOf(ts) + count;
  const day = dayOf(ts);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return utc(year, month, Math.min(day, lastDay));
};
export const addDays = (ts: number, count: number): number => startOfDay(ts) + count * DAY;
export const isSameDay = (a: number, b: number): boolean => startOfDay(a) === startOfDay(b);

/**
 * Six weeks of days covering the month, so the grid never changes height as the
 * user pages through months.
 */
export function monthMatrix(monthTs: number, weekStartsOn = 0): CalendarDay[] {
  const first = startOfMonthUtc(monthTs);
  const offset = (weekdayOf(first) - weekStartsOn + 7) % 7;
  const gridStart = first - offset * DAY;
  const month = monthOf(first);
  return Array.from({ length: 42 }, (_, i) => {
    const ts = gridStart + i * DAY;
    return { ts, day: dayOf(ts), outside: monthOf(ts) !== month, weekday: weekdayOf(ts) };
  });
}

export function weekdayLabels(locale = 'en-US', weekStartsOn = 0): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  // 2024-01-07 is a Sunday, so index 0 lines up with `getUTCDay() === 0`.
  return Array.from({ length: 7 }, (_, i) => fmt.format(Date.UTC(2024, 0, 7 + ((i + weekStartsOn) % 7))).slice(0, 2));
}

export interface DateRange { start: number | null; end: number | null }

export const inRange = (ts: number, range: DateRange): boolean => {
  if (range.start === null || range.end === null) return false;
  const day = startOfDay(ts);
  return day > startOfDay(range.start) && day < startOfDay(range.end);
};

/** Second click before the first anchors a backwards range instead of failing. */
export function nextRange(current: DateRange, ts: number): DateRange {
  if (current.start === null || current.end !== null) return { start: startOfDay(ts), end: null };
  const day = startOfDay(ts);
  return day < current.start ? { start: day, end: current.start } : { start: current.start, end: day };
}

export interface RangePreset { id: string; label: string; range: (now: number) => DateRange }

export const RANGE_PRESETS: RangePreset[] = [
  { id: 'today', label: 'Today', range: (now) => ({ start: startOfDay(now), end: startOfDay(now) }) },
  { id: 'last7', label: 'Last 7 days', range: (now) => ({ start: addDays(now, -6), end: startOfDay(now) }) },
  { id: 'last30', label: 'Last 30 days', range: (now) => ({ start: addDays(now, -29), end: startOfDay(now) }) },
  { id: 'last90', label: 'Last 90 days', range: (now) => ({ start: addDays(now, -89), end: startOfDay(now) }) },
  { id: 'mtd', label: 'Month to date', range: (now) => ({ start: startOfMonthUtc(now), end: startOfDay(now) }) },
  {
    id: 'lastmonth',
    label: 'Last month',
    range: (now) => ({ start: addMonths(startOfMonthUtc(now), -1), end: startOfMonthUtc(now) - DAY }),
  },
  { id: 'qtd', label: 'Quarter to date', range: (now) => ({ start: utc(yearOf(now), Math.floor(monthOf(now) / 3) * 3, 1), end: startOfDay(now) }) },
  { id: 'ytd', label: 'Year to date', range: (now) => ({ start: utc(yearOf(now), 0, 1), end: startOfDay(now) }) },
];
