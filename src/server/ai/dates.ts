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

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
/**
 * "Aug 2026" — month and year, which is the whole label. Every call site used
 * to append the year again, so every month period read "Aug 2026 2026".
 */
const monthLabel = (ts: number): string => {
  const d = new Date(ts);
  return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

function makeWindow(start: number, end: number, label: string, grain: WindowGrain, matched: string, now: number): TimeWindow {
  // A window is partial when the clock is inside it. A wholly future period —
  // "next quarter" — is not a period-to-date figure, it is a period with
  // nothing in it yet, and the answer has to read differently.
  return { start, end, label, grain, matched, partial: end > now && start <= now };
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
      return { start, end: w.start, label: monthLabel(start), grain: 'month', matched: `${w.matched} (prior)`, partial: false };
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
    re: /\b(?:this|current|the\s+current)\s+(quarter|month|year|week)\b|\b(quarter|month|year|week)\s+to\s+date\b|\b(qtd|mtd|ytd|wtd)\b/i,
    build(m, now) {
      const key = (m[1] || m[2] || m[3] || '').toLowerCase();
      if (key === 'quarter' || key === 'qtd') {
        const start = startOfQuarter(now);
        return makeWindow(start, addQuarters(start, 1), `${quarterLabel(start)} to date`, 'quarter', m[0], now);
      }
      if (key === 'month' || key === 'mtd') {
        const start = startOfMonth(now);
        return makeWindow(start, addInterval(start, interval('month', 1), 1), `${monthLabel(start)} to date`, 'month', m[0], now);
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
        return makeWindow(start, startOfMonth(now), monthLabel(start), 'month', m[0], now);
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
    // "the second quarter of 2026" is Q2 2026. Before this rule existed the
    // year inside it was the only thing that parsed, and the answer came back
    // about the whole of 2026.
    re: /\b(?:the\s+)?(first|second|third|fourth)\s+quarter(?:\s+(?:of|in)\s+(?:fy\s*)?((?:19|20)\d{2}))?\b/i,
    build(m, now) {
      const q = ['first', 'second', 'third', 'fourth'].indexOf(m[1].toLowerCase());
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
    // Nothing in this platform carries a fiscal calendar offset — every module
    // buckets on calendar months — so a fiscal year is the calendar year here,
    // and the label says which one it used rather than implying an offset.
    re: /\b(?:fiscal\s+year\s*|fy\s*'?)((?:19|20)?\d{2})\b/i,
    build(m, now) {
      const raw = Number(m[1]);
      const year = raw < 100 ? 2000 + raw : raw;
      if (year < 1990 || year > 2100) return null;
      return makeWindow(Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1), `FY${year} (the calendar year ${year})`, 'year', m[0], now);
    },
  },
  {
    re: /\b(?:next|the\s+coming|the\s+following)\s+(quarter|month|year|week)\b/i,
    build(m, now) {
      const key = m[1].toLowerCase();
      if (key === 'quarter') {
        const start = addQuarters(now, 1);
        return makeWindow(start, addQuarters(start, 1), quarterLabel(start), 'quarter', m[0], now);
      }
      if (key === 'month') {
        const start = addInterval(startOfMonth(now), interval('month', 1), 1);
        return makeWindow(start, addInterval(start, interval('month', 1), 1), monthLabel(start), 'month', m[0], now);
      }
      if (key === 'week') {
        const start = startOfWeek(now) + 7 * DAY;
        return makeWindow(start, start + 7 * DAY, 'next week', 'week', m[0], now);
      }
      const year = new Date(now).getUTCFullYear() + 1;
      return makeWindow(Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1), String(year), 'year', m[0], now);
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
    // The trailing guard stops "in 2026-02-30" being read as the year 2026:
    // half of a date is not a period, and a half-parsed date is exactly how an
    // answer ends up about a range nobody asked for.
    re: /\b(?:in|during|for|of)\s+((?:19|20)\d{2})\b(?!-\d)/i,
    build(m, now) {
      const year = Number(m[1]);
      return makeWindow(Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1), String(year), 'year', m[0], now);
    },
  },
  {
    re: new RegExp(`\\b((?:in|during|for|since|of)\\s+)?(${MONTHS.join('|')})\\s*((?:19|20)\\d{2})?\\b`, 'i'),
    build(m, now) {
      // "we may close it" is not the month of May. A bare month name only reads
      // as a period when a preposition or a year makes it one.
      if (m[2].toLowerCase() === 'may' && !m[1] && !m[3]) return null;
      const month = MONTHS.indexOf(m[2].toLowerCase());
      const explicitYear = m[3] ? Number(m[3]) : null;
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
 * Every period the question names, in the order they were written.
 *
 * "Compare Q1 2026 and Q2 2026 bookings" names two periods and must be answered
 * about those two, so this collects all of them rather than stopping at the
 * first. Overlapping matches are resolved leftmost-longest — "in March 2025"
 * is one period, not a month and a year.
 */
export interface WindowSpan {
  window: TimeWindow;
  /** Where in the question the phrase that produced this window sits. */
  at: number;
  to: number;
}

export function resolveWindowSpans(text: string, now: number, limit = 3): WindowSpan[] {
  const found: { at: number; to: number; rule: number; window: TimeWindow }[] = [];
  RULES.forEach((rule, index) => {
    const flags = rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`;
    for (const match of text.matchAll(new RegExp(rule.re.source, flags))) {
      if (match.index === undefined) continue;
      const built = rule.build(match, now);
      if (!built || built.end <= built.start) continue;
      found.push({ at: match.index, to: match.index + match[0].length, rule: index, window: built });
    }
  });
  found.sort((a, b) => a.at - b.at || (b.to - b.at) - (a.to - a.at) || a.rule - b.rule);

  const out: WindowSpan[] = [];
  const seen = new Set<string>();
  let consumed = -1;
  for (const candidate of found) {
    if (candidate.at < consumed) continue;
    consumed = candidate.to;
    const key = `${candidate.window.start}:${candidate.window.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ window: candidate.window, at: candidate.at, to: candidate.to });
    if (out.length >= limit) break;
  }
  return out;
}

export function resolveWindows(text: string, now: number, limit = 3): TimeWindow[] {
  return resolveWindowSpans(text, now, limit).map((span) => span.window);
}

/**
 * Find the period a question is about. Returns `null` when the question carries
 * no time expression — callers then decide their own default rather than
 * inventing one, so an answer never silently reports the wrong period.
 */
export function resolveWindow(text: string, now: number): TimeWindow | null {
  return resolveWindows(text, now, 1)[0] ?? null;
}

/**
 * Period-shaped phrases, including ones this engine cannot turn into a range.
 * The gap between what this finds and what `resolveWindows` parses is exactly
 * the set of periods the answer must refuse rather than quietly substitute.
 */
const PERIOD_MENTIONS: RegExp[] = [
  /\bq[1-9]\b(?:\s*(?:of\s+)?(?:fy)?\s*(?:'?\d{2,4}))?/gi,
  /\bh[12]\b\s*(?:of\s+)?(?:fy)?\s*(?:'?\d{2,4})?/gi,
  /\b(?:first|second|third|fourth)\s+(?:quarter|half)(?:\s+of\s+(?:19|20)\d{2})?/gi,
  /\bfy\s*'?\d{2,4}\b/gi,
  /\b(?:last|past|previous|prior|trailing|this|current|next|coming)\s+(?:\d{1,3}\s*)?(?:day|week|fortnight|month|quarter|half|year|semester)s?\b/gi,
  // Period shapes this engine cannot turn into a range. They are listed here
  // precisely because they do not parse: a phrase that lexes as a period and
  // resolves to nothing has to be refused, not quietly replaced by the default.
  /\b(?:the\s+)?(?:day|week|fortnight|month|quarter|half|year)\s+before\s+(?:last|this|that)\b/gi,
  /\b\d{1,3}\s+(?:days?|weeks?|fortnights?|months?|quarters?|years?)\s+ago\b/gi,
  /\b(?:the\s+)?(?:first|second|third|fourth|fifth|last)\s+(?:day|week|month)\s+of\b/gi,
  /\b(?:early|mid|late)[\s-]+(?:19|20)\d{2}\b/gi,
  new RegExp(`\\b(?:${MONTHS.join('|')})\\s*(?:(?:19|20)\\d{2})?\\b`, 'gi'),
  /\b(?:19|20)\d{2}\b/g,
  /\b(?:yesterday|today|tomorrow|ytd|mtd|qtd|wtd|year\s+to\s+date|month\s+to\s+date)\b/gi,
  // Any four-digit calendar date, not only the ones in a plausible century —
  // "between 9999-12-31 and 0001-01-01" is period-shaped and parses to nothing.
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\bweek\s+\d{1,2}\b/gi,
];

export interface PeriodMention { text: string; at: number; to: number }

export function periodMentions(text: string): PeriodMention[] {
  const spans: PeriodMention[] = [];
  const raw: { at: number; to: number; text: string }[] = [];
  for (const re of PERIOD_MENTIONS) {
    for (const match of text.matchAll(re)) {
      if (match.index === undefined) continue;
      const value = match[0].trim();
      // A bare "may" is the modal verb far more often than the month.
      if (/^may$/i.test(value)) continue;
      if (value) raw.push({ at: match.index, to: match.index + match[0].length, text: value });
    }
  }
  raw.sort((a, b) => a.at - b.at || (b.to - b.at) - (a.to - a.at));
  let consumed = -1;
  for (const span of raw) {
    if (span.at < consumed) continue;
    consumed = span.to;
    spans.push({ text: span.text, at: span.at, to: span.to });
  }
  return spans;
}

/**
 * Period phrases the question named that no resolved window covers.
 *
 * This is the whole-engine guard against substitution. Counting is not enough:
 * "the second quarter of 2026" names one period and used to resolve one window
 * — the year 2026 — so the counts agreed while the answer was about a different
 * range. A mention only counts as resolved when a window's own matched span
 * contains it, which is the only way to know the engine measured the phrase the
 * caller wrote rather than a fragment of it.
 */
export function unresolvedPeriods(text: string, now: number, limit = 8): PeriodMention[] {
  const spans = resolveWindowSpans(text, now, limit);
  return periodMentions(text).filter((mention) =>
    !spans.some((span) => span.at <= mention.at && span.to >= mention.to));
}

/**
 * An explicit range written backwards — "between 2026-12-31 and 2020-01-01".
 * It parses as two dates and resolves to nothing, so the refusal can say why
 * instead of only saying that it could not.
 */
export function reversedRange(text: string): { from: string; to: string } | null {
  for (const match of text.matchAll(/\bbetween\s+((?:19|20)\d{2}-\d{2}-\d{2})\s+and\s+((?:19|20)\d{2}-\d{2}-\d{2})\b/gi)) {
    const start = Date.parse(`${match[1]}T00:00:00Z`);
    const end = Date.parse(`${match[2]}T00:00:00Z`);
    if (Number.isFinite(start) && Number.isFinite(end) && end < start) return { from: match[1], to: match[2] };
  }
  return null;
}

/**
 * Everything on the books, for a question that ranks accounts without naming a
 * period. "Who is my biggest customer?" is not a question about this quarter.
 */
export function allTimeWindow(now: number): TimeWindow {
  return makeWindow(0, now, 'all time', 'range', '', now);
}

/** The same window one or more years earlier — "the same period last year". */
export function shiftWindowYears(w: TimeWindow, years: number): TimeWindow {
  const start = addInterval(w.start, interval('year', years), 1);
  const end = addInterval(w.end, interval('year', years), 1);
  const year = new Date(start).getUTCFullYear();
  const label = w.grain === 'quarter'
    ? quarterLabel(start)
    : w.grain === 'month'
      ? monthLabel(start)
      : w.grain === 'year'
        ? String(year)
        : `${formatDate(start, { timeZone: 'UTC' })} – ${formatDate(end - 1, { timeZone: 'UTC' })}`;
  return { start, end, label, grain: w.grain, matched: `${w.matched} (${Math.abs(years)}y earlier)`, partial: false };
}

/** Does the question ask for a like-for-like comparison against last year? */
export const asksYearOverYear = (text: string): boolean =>
  /\b(same\s+(?:period|quarter|month|time|week)\s+(?:in\s+|of\s+)?last\s+year|year[\s-]over[\s-]year|yoy|versus\s+last\s+year|vs\.?\s+last\s+year|against\s+last\s+year)\b/i.test(text);

/** The window a metric should use when the question says nothing about time. */
export function defaultWindow(now: number, grain: 'quarter' | 'month' | 'year' = 'quarter'): TimeWindow {
  if (grain === 'month') {
    const start = startOfMonth(now);
    return makeWindow(start, addInterval(start, interval('month', 1), 1), `${monthLabel(start)} to date`, 'month', '', now);
  }
  if (grain === 'year') {
    const start = startOfYearUtc(now);
    return makeWindow(start, Date.UTC(new Date(start).getUTCFullYear() + 1, 0, 1), `${new Date(start).getUTCFullYear()} to date`, 'year', '', now);
  }
  const start = startOfQuarter(now);
  return makeWindow(start, addQuarters(start, 1), `${quarterLabel(start)} to date`, 'quarter', '', now);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Work starts at 09:00 in the workspace's calendar day. */
const AT_NINE = (ts: number): number => startOfDay(ts) + 9 * 60 * 60 * 1000;

export interface DueDate {
  at: number;
  matched: string;
  label: string;
  /** Whole calendar days from now — what "in 5 days" has to mean. */
  days: number;
}

/**
 * "next Tuesday", "in 5 days", "tomorrow", "on 2026-09-14" — the phrases people
 * actually use when they ask for a task. Returns `null` rather than a default,
 * because a task with a made-up due date is worse than one the caller is asked
 * to date themselves.
 */
export function resolveDueDate(text: string, now: number): DueDate | null {
  const due = (at: number, matched: string): DueDate => ({
    at,
    matched,
    label: formatDate(at, { timeZone: 'UTC' }),
    days: Math.max(1, Math.round((startOfDay(at) - startOfDay(now)) / DAY)),
  });

  const iso = text.match(/\b(?:on|by|before|due)?\s*((?:19|20)\d{2}-\d{2}-\d{2})\b/i);
  if (iso) {
    const at = Date.parse(`${iso[1]}T09:00:00Z`);
    if (Number.isFinite(at)) return due(at, iso[0].trim());
  }

  const relative = text.match(/\bin\s+(\d{1,3})\s*(day|days|week|weeks|month|months)\b/i);
  if (relative) {
    const count = Number(relative[1]);
    const unit = relative[2].toLowerCase().replace(/s$/, '');
    const at = unit === 'month'
      ? AT_NINE(addInterval(now, interval('month', count), 1))
      : AT_NINE(startOfDay(now) + count * (unit === 'week' ? 7 : 1) * DAY);
    return due(at, relative[0]);
  }

  const tomorrow = text.match(/\btomorrow\b/i);
  if (tomorrow) {
    return due(AT_NINE(now + DAY), tomorrow[0]);
  }

  const weekday = text.match(new RegExp(`\\b(next|this|on|coming)?\\s*(${WEEKDAYS.join('|')})\\b`, 'i'));
  if (weekday) {
    const wanted = WEEKDAYS.indexOf(weekday[2].toLowerCase());
    const today = startOfDay(now);
    let ahead = (wanted - new Date(today).getUTCDay() + 7) % 7;
    if (ahead === 0) ahead = 7;
    // "next Tuesday" means the Tuesday of the following week, not the one in
    // three days' time; "this Tuesday" and a bare weekday mean the next one.
    if (/next/i.test(weekday[1] ?? '') && startOfWeek(today + ahead * DAY) === startOfWeek(today)) ahead += 7;
    return due(AT_NINE(today + ahead * DAY), weekday[0].trim());
  }

  const nextWeek = text.match(/\bnext\s+(week|month)\b/i);
  if (nextWeek) {
    return due(/week/i.test(nextWeek[1])
      ? AT_NINE(startOfWeek(now) + 7 * DAY)
      : AT_NINE(addInterval(startOfMonth(now), interval('month', 1), 1)), nextWeek[0]);
  }

  const endOfWeek = text.match(/\b(?:by\s+)?(?:the\s+)?end\s+of\s+(?:the\s+)?(week|month|quarter)\b/i);
  if (endOfWeek) {
    const unit = endOfWeek[1].toLowerCase();
    return due(unit === 'week'
      ? AT_NINE(startOfWeek(now) + 4 * DAY)
      : unit === 'month'
        ? AT_NINE(addInterval(startOfMonth(now), interval('month', 1), 1) - DAY)
        : AT_NINE(addQuarters(startOfQuarter(now), 1) - DAY), endOfWeek[0]);
  }

  return null;
}

/** Bucket key for grouping a timestamp inside a window, matching the grain. */
export function bucketKey(ts: number, grain: WindowGrain): string {
  const d = new Date(ts);
  if (grain === 'year') return String(d.getUTCFullYear());
  if (grain === 'quarter') return quarterLabel(ts);
  if (grain === 'day') return new Date(startOfDay(ts)).toISOString().slice(0, 10);
  return monthLabel(ts);
}

/** How a window should be sliced on a chart: never more than ~24 buckets. */
export function bucketGrain(w: TimeWindow): 'day' | 'month' | 'quarter' | 'year' {
  const span = w.end - w.start;
  if (span <= 62 * DAY) return 'day';
  if (span <= 800 * DAY) return 'month';
  if (span <= 5 * 365 * DAY) return 'quarter';
  return 'year';
}
