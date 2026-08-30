/**
 * Turning "last quarter" into an exact half-open millisecond range.
 *
 * Every window is resolved against `ctx.now()` — the workspace clock — so the
 * time machine and the answers agree. Boundaries are UTC calendar boundaries,
 * matching `src/shared/time.ts` and therefore matching how every other module
 * buckets a month.
 */
import { DAY, addInterval, formatDate, interval, startOfDay, startOfMonth } from '../../shared/time';

export type WindowGrain = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'range';

export interface TimeWindow {
  /** Inclusive start, exclusive end. */
  start: number;
  end: number;
  /** Human label as an analyst would write it: "Q2 2025", "the last 30 days". */
  label: string;
  grain: WindowGrain;
  /** The words in the question that produced this window. */
  matched: string;
  /** True when the window is still running, so totals are partial. */
  partial: boolean;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export const startOfYearUtc = (ts: number): number => Date.UTC(new Date(ts).getUTCFullYear(), 0, 1);
export const quarterIndex = (ts: number): number => Math.floor(new Date(ts).getUTCMonth() / 3);

export function startOfQuarter(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), quarterIndex(ts) * 3, 1);
}

export function addQuarters(ts: number, count: number): number {
  return addInterval(startOfQuarter(ts), interval('month', count * 3), 1);
}

export function startOfWeek(ts: number): number {
  const day = new Date(ts).getUTCDay();
  const mondayOffset = (day + 6) % 7;
  return startOfDay(ts) - mondayOffset * DAY;
}

const quarterLabel = (ts: number): string => `Q${quarterIndex(ts) + 1} ${new Date(ts).getUTCFullYear()}`;
const monthLabel = (ts: number): string => formatDate(ts, { timeZone: 'UTC' }).replace(/\s\d+,/, '');

function makeWindow(start: number, end: number, label: string, grain: WindowGrain, matched: string, now: number): TimeWindow {
  return { start, end, label, grain, matched, partial: end > now };
}

/** Format a window the way a finance analyst writes a period. */
export function describeWindow(w: TimeWindow, locale = 'en-US'): string {
  if (w.grain === 'quarter' || w.grain === 'year' || w.grain === 'month') return w.label;
  const from = formatDate(w.start, { locale, timeZone: 'UTC' });
  const to = formatDate(w.end - 1, { locale, timeZone: 'UTC' });
  return `${from} – ${to}`;
}

/** The equivalent window immediately before this one, for like-for-like deltas. */
export function previousWindow(w: TimeWindow): TimeWindow {
  switch (w.grain) {
    case 'quarter': {
      const start = addQuarters(w.start, -1);
      return { start, end: w.start, label: quarterLabel(start), grain: 'quarter', matched: `${w.matched} (prior)`, partial: false };
    }
    case 'month': {
      const start = addInterval(w.start, interval('month', -1), 1);
      return { start, end: w.start, label: `${monthLabel(start)} ${new Date(start).getUTCFullYear()}`, grain: 'month', matched: `${w.matched} (prior)`, partial: false };
    }
    case 'year': {
      const start = Date.UTC(new Date(w.start).getUTCFullYear() - 1, 0, 1);
      return { start, end: w.start, label: String(new Date(start).getUTCFullYear()), grain: 'year', matched: `${w.matched} (prior)`, partial: false };
    }
    default: {
      const span = w.end - w.start;
      return { start: w.start - span, end: w.start, label: 'the preceding period', grain: w.grain, matched: `${w.matched} (prior)`, partial: false };
    }
  }
}

interface Rule {
  re: RegExp;
  build(match: RegExpMatchArray, now: number): TimeWindow | null;
}

const UNIT_MS: Record<string, number> = { day: DAY, week: 7 * DAY, fortnight: 14 * DAY };

const RULES: Rule[] = [
  {
    re: /\b(?:the\s+)?(?:last|past|previous|prior|trailing)\s+(\d{1,3})\s*(day|days|week|weeks|month|months|quarter|quarters|year|years)\b/i,
    build(m, now) {
      const count = Number(m[1]);
      const unit = m[2].toLowerCase().replace(/s$/, '');
      const end = now;
      let start: number;
      if (unit === 'day' || unit === 'week') start = end - count * UNIT_MS[unit];
      else if (unit === 'month') start = addInterval(end, interval('month', -count));
      else if (unit === 'quarter') start = addInterval(end, interval('month', -3 * count));
      else start = addInterval(end, interval('year', -count));
      const label = `the last ${count} ${count === 1 ? unit : `${unit}s`}`;
      return makeWindow(start, end, label, 'range', m[0], now);
    },
  },
  {
    re: /\b(?:this|current|the\s+current)\s+(quarter|month|year|week)\b|\b(qtd|mtd|ytd|wtd)\b/i,
    build(m, now) {
      const key = (m[1] || m[2] || '').toLowerCase();
      if (key === 'quarter' || key === 'qtd') {
        const start = startOfQuarter(now);
        return makeWindow(start, addQuarters(start, 1), `${quarterLabel(start)} to date`, 'quarter', m[0], now);
      }
      if (key === 'month' || key === 'mtd') {
        const start = startOfMonth(now);
        return makeWindow(start, addInterval(start, interval('month', 1), 1), `${monthLabel(start)} ${new Date(start).getUTCFullYear()} to date`, 'month', m[0], now);
      }
      if (key === 'week' || key === 'wtd') {
        const start = startOfWeek(now);
        return makeWindow(start, start + 7 * DAY, 'this week', 'week', m[0], now);
      }
      const start = startOfYearUtc(now);
      return makeWindow(start, Date.UTC(new Date(start).getUTCFullYear() + 1, 0, 1), `${new Date(start).getUTCFullYear()} to date`, 'year', m[0], now);
    },
  },
  {
    re: /\b(?:last|previous|prior)\s+(quarter|month|year|week)\b/i,
    build(m, now) {
      const key = m[1].toLowerCase();
      if (key === 'quarter') {
        const start = addQuarters(now, -1);
        return makeWindow(start, startOfQuarter(now), quarterLabel(start), 'quarter', m[0], now);
      }
      if (key === 'month') {
        const start = addInterval(startOfMonth(now), interval('month', -1), 1);
        return makeWindow(start, startOfMonth(now), `${monthLabel(start)} ${new Date(start).getUTCFullYear()}`, 'month', m[0], now);
      }
      if (key === 'week') {
        const start = startOfWeek(now) - 7 * DAY;
        return makeWindow(start, startOfWeek(now), 'last week', 'week', m[0], now);
      }
      const year = new Date(now).getUTCFullYear() - 1;
      return makeWindow(Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1), String(year), 'year', m[0], now);
    },
  },
  {
    re: /\bq([1-4])(?:\s+(?:of\s+)?(?:fy)?\s*((?:19|20)\d{2}))?\b/i,
    build(m, now) {
      const q = Number(m[1]) - 1;
      const year = m[2] ? Number(m[2]) : new Date(now).getUTCFullYear();
      const start = Date.UTC(year, q * 3, 1);
      if (!m[2] && start > now) {
        const prior = Date.UTC(year - 1, q * 3, 1);
        return makeWindow(prior, addQuarters(prior, 1), quarterLabel(prior), 'quarter', m[0], now);
      }
      return makeWindow(start, addQuarters(start, 1), quarterLabel(start), 'quarter', m[0], now);
    },
  },
  {
    re: /\b(yesterday|today)\b/i,
    build(m, now) {
      const isToday = m[1].toLowerCase() === 'today';
      const start = isToday ? startOfDay(now) : startOfDay(now) - DAY;
      return makeWindow(start, start + DAY, isToday ? 'today' : 'yesterday', 'day', m[0], now);
    },
  },
  {
    re: /\b(?:in|during|for|of)\s+((?:19|20)\d{2})\b/i,
    build(m, now) {
      const year = Number(m[1]);
      return makeWindow(Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1), String(year), 'year', m[0], now);
    },
  },
  {
    re: new RegExp(`\\b(?:in|during|for|since)?\\s*(${MONTHS.join('|')})\\s*((?:19|20)\\d{2})?\\b`, 'i'),
    build(m, now) {
      const month = MONTHS.indexOf(m[1].toLowerCase());
      const explicitYear = m[2] ? Number(m[2]) : null;
      const nowYear = new Date(now).getUTCFullYear();
      let year = explicitYear ?? nowYear;
      let start = Date.UTC(year, month, 1);
      if (!explicitYear && start > now) { year -= 1; start = Date.UTC(year, month, 1); }
      const end = addInterval(start, interval('month', 1), 1);
      const since = /since/i.test(m[0]);
      return since
        ? makeWindow(start, now, `since ${MONTHS[month].replace(/^./, (c) => c.toUpperCase())} ${year}`, 'range', m[0], now)
        : makeWindow(start, end, `${MONTHS[month].replace(/^./, (c) => c.toUpperCase())} ${year}`, 'month', m[0], now);
    },
  },
  {
    re: /\b(?:since|after)\s+((?:19|20)\d{2}-\d{2}-\d{2})\b/i,
    build(m, now) {
      const start = Date.parse(`${m[1]}T00:00:00Z`);
      if (!Number.isFinite(start)) return null;
      return makeWindow(start, now, `since ${formatDate(start, { timeZone: 'UTC' })}`, 'range', m[0], now);
    },
  },
  {
    re: /\bbetween\s+((?:19|20)\d{2}-\d{2}-\d{2})\s+and\s+((?:19|20)\d{2}-\d{2}-\d{2})\b/i,
    build(m, now) {
      const start = Date.parse(`${m[1]}T00:00:00Z`);
      const end = Date.parse(`${m[2]}T00:00:00Z`) + DAY;
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      return makeWindow(start, end, `${formatDate(start, { timeZone: 'UTC' })} – ${formatDate(end - 1, { timeZone: 'UTC' })}`, 'range', m[0], now);
    },
  },
  {
    re: /\b(?:all\s+time|ever|to\s+date|lifetime|since\s+the\s+beginning)\b/i,
    build(m, now) {
      return makeWindow(0, now, 'all time', 'range', m[0], now);
    },
  },
];

/**
 * Find the period a question is about. Returns `null` when the question carries
 * no time expression — callers then decide their own default rather than
 * inventing one, so an answer never silently reports the wrong period.
 */
export function resolveWindow(text: string, now: number): TimeWindow | null {
  for (const rule of RULES) {
    const match = text.match(rule.re);
    if (!match) continue;
    const built = rule.build(match, now);
    if (built && built.end > built.start) return built;
  }
  return null;
}

/** The window a metric should use when the question says nothing about time. */
export function defaultWindow(now: number, grain: 'quarter' | 'month' | 'year' = 'quarter'): TimeWindow {
  if (grain === 'month') {
    const start = startOfMonth(now);
    return makeWindow(start, addInterval(start, interval('month', 1), 1), `${monthLabel(start)} ${new Date(start).getUTCFullYear()} to date`, 'month', '', now);
  }
  if (grain === 'year') {
    const start = startOfYearUtc(now);
    return makeWindow(start, Date.UTC(new Date(start).getUTCFullYear() + 1, 0, 1), `${new Date(start).getUTCFullYear()} to date`, 'year', '', now);
  }
  const start = startOfQuarter(now);
  return makeWindow(start, addQuarters(start, 1), `${quarterLabel(start)} to date`, 'quarter', '', now);
}

/** Bucket key for grouping a timestamp inside a window, matching the grain. */
export function bucketKey(ts: number, grain: WindowGrain): string {
  const d = new Date(ts);
  if (grain === 'year') return String(d.getUTCFullYear());
  if (grain === 'quarter') return quarterLabel(ts);
  if (grain === 'day') return new Date(startOfDay(ts)).toISOString().slice(0, 10);
  return `${monthLabel(ts)} ${d.getUTCFullYear()}`;
}

/** How a window should be sliced on a chart: never more than ~24 buckets. */
export function bucketGrain(w: TimeWindow): 'day' | 'month' | 'quarter' | 'year' {
  const span = w.end - w.start;
  if (span <= 62 * DAY) return 'day';
  if (span <= 800 * DAY) return 'month';
  if (span <= 5 * 365 * DAY) return 'quarter';
  return 'year';
}
