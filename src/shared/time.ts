/**
 * Billing-grade time helpers. Everything is unix epoch milliseconds (UTC).
 * Period maths follow calendar rules — a monthly subscription anchored on the
 * 31st bills on the 30th/28th in short months and snaps back afterwards, which
 * is the behaviour every serious billing system needs and most get wrong.
 */

export type Millis = number;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

export type IntervalUnit = 'day' | 'week' | 'month' | 'year';

export interface Interval {
  unit: IntervalUnit;
  count: number;
}

export const interval = (unit: IntervalUnit, count = 1): Interval => ({ unit, count });

/** Days in a given UTC month (month is 0-indexed). */
export const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/**
 * Add an interval to a timestamp, preserving the anchor day-of-month.
 * `anchorDay` (1–31) lets a subscription anchored on the 31st return to the
 * 31st after passing through February.
 */
export function addInterval(ts: Millis, iv: Interval, anchorDay?: number): Millis {
  const d = new Date(ts);
  switch (iv.unit) {
    case 'day': return ts + iv.count * DAY;
    case 'week': return ts + iv.count * WEEK;
    case 'month':
    case 'year': {
      const months = iv.unit === 'year' ? iv.count * 12 : iv.count;
      const targetMonthIndex = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
      const year = Math.floor(targetMonthIndex / 12);
      const month = ((targetMonthIndex % 12) + 12) % 12;
      const wanted = anchorDay ?? d.getUTCDate();
      const day = Math.min(wanted, daysInMonth(year, month));
      return Date.UTC(year, month, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
    }
  }
}

export const subInterval = (ts: Millis, iv: Interval, anchorDay?: number): Millis =>
  addInterval(ts, { ...iv, count: -iv.count }, anchorDay);

export interface Period {
  start: Millis;
  end: Millis;
}

export const periodLength = (p: Period): Millis => p.end - p.start;

export const contains = (p: Period, ts: Millis): boolean => ts >= p.start && ts < p.end;

/** Fraction of a period remaining at `ts`, as an exact {n, d} pair of millis. */
export function remainingFraction(p: Period, ts: Millis): { n: number; d: number } {
  const d = Math.max(1, p.end - p.start);
  const n = Math.min(Math.max(p.end - ts, 0), d);
  return { n, d };
}

export function elapsedFraction(p: Period, ts: Millis): { n: number; d: number } {
  const { n, d } = remainingFraction(p, ts);
  return { n: d - n, d };
}

/** The billing period containing `ts` for a cycle anchored at `anchor`. */
export function periodFor(anchor: Millis, iv: Interval, ts: Millis, anchorDay?: number): Period {
  const day = anchorDay ?? new Date(anchor).getUTCDate();
  let start = anchor;
  let end = addInterval(start, iv, day);
  if (ts < start) {
    while (ts < start) { end = start; start = subInterval(start, iv, day); }
    return { start, end };
  }
  let guard = 0;
  while (ts >= end && guard++ < 10_000) { start = end; end = addInterval(start, iv, day); }
  return { start, end };
}

/** Number of whole intervals between two timestamps (used for schedule phases). */
export function intervalsBetween(from: Millis, to: Millis, iv: Interval, anchorDay?: number): number {
  let count = 0;
  let cursor = from;
  const day = anchorDay ?? new Date(from).getUTCDate();
  while (cursor < to && count < 10_000) { cursor = addInterval(cursor, iv, day); count++; }
  return count;
}

/* ------------------------------- formatting ------------------------------ */

export const toIso = (ts: Millis): string => new Date(ts).toISOString();
export const fromIso = (iso: string): Millis => Date.parse(iso);

const dtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(opts);
  let f = dtCache.get(key);
  if (!f) { f = new Intl.DateTimeFormat(locale, opts); dtCache.set(key, f); }
  return f;
}

export interface DateFormatOptions { locale?: string; timeZone?: string; withTime?: boolean; withYear?: boolean }

export function formatDate(ts: Millis, o: DateFormatOptions = {}): string {
  const locale = o.locale || 'en-US';
  const tz = o.timeZone || 'UTC';
  return dtf(locale, {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    ...(o.withYear === false ? {} : { year: 'numeric' }),
    ...(o.withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(ts);
}

export function formatDateTime(ts: Millis, o: DateFormatOptions = {}): string {
  return formatDate(ts, { ...o, withTime: true });
}

/** "3 days ago", "in 2 months" — Intl.RelativeTimeFormat with sane thresholds. */
export function formatRelative(ts: Millis, now: Millis, locale = 'en-US'): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const diff = ts - now;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * DAY], ['month', 30 * DAY], ['week', WEEK],
    ['day', DAY], ['hour', HOUR], ['minute', MINUTE], ['second', SECOND],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(0, 'second');
}

/** "2 mo 14 d" style duration for dashboards and SLA timers. */
export function formatDuration(ms: number, maxParts = 2): string {
  const neg = ms < 0;
  let rest = Math.abs(ms);
  const parts: string[] = [];
  const units: [string, number][] = [['d', DAY], ['h', HOUR], ['m', MINUTE], ['s', SECOND]];
  for (const [label, size] of units) {
    if (parts.length >= maxParts) break;
    const n = Math.floor(rest / size);
    if (n > 0 || (parts.length === 0 && label === 's')) { parts.push(`${n}${label}`); rest -= n * size; }
  }
  return (neg ? '-' : '') + (parts.join(' ') || '0s');
}

export const startOfDay = (ts: Millis): Millis => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
export const endOfDay = (ts: Millis): Millis => startOfDay(ts) + DAY - 1;
export const startOfMonth = (ts: Millis): Millis => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
export const endOfMonth = (ts: Millis): Millis => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1; };
export const monthKey = (ts: Millis): string => new Date(ts).toISOString().slice(0, 7);
export const dayKey = (ts: Millis): string => new Date(ts).toISOString().slice(0, 10);

/** Enumerate month keys inclusive of both ends — for MRR/cohort series. */
export function monthRange(from: Millis, to: Millis): string[] {
  const out: string[] = [];
  let cursor = startOfMonth(from);
  const last = startOfMonth(to);
  while (cursor <= last && out.length < 600) { out.push(monthKey(cursor)); cursor = addInterval(cursor, interval('month', 1), 1); }
  return out;
}

export function dayRange(from: Millis, to: Millis): string[] {
  const out: string[] = [];
  let cursor = startOfDay(from);
  const last = startOfDay(to);
  while (cursor <= last && out.length < 1500) { out.push(dayKey(cursor)); cursor += DAY; }
  return out;
}
