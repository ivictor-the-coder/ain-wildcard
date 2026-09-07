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
  // An open-ended range has no second date to print: "after December 2026" is
  // not "Jan 1, 2027 – Dec 31, 2199", and printing a horizon the workspace
  // does not have reads as a bound the reader never asked for.
  if (w.start === 0 || w.end === OPEN_ENDED) return w.label;
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
    // The forward twin of "the last 30 days". Its absence refused "which
    // subscriptions renew in the next 30 days" — a question about the future
    // that this platform answers from rows it already holds — with an apology
    // about an unparseable period, while the backward phrasing worked.
    re: /\b(?:the\s+)?(?:next|coming|following|upcoming)\s+(\d{1,3})\s*(day|days|week|weeks|month|months|quarter|quarters|year|years)\b/i,
    build(m, now) {
      const count = Number(m[1]);
      const unit = m[2].toLowerCase().replace(/s$/, '');
      const start = now;
      let end: number;
      if (unit === 'day' || unit === 'week') end = start + count * UNIT_MS[unit];
      else if (unit === 'month') end = addInterval(start, interval('month', count));
      else if (unit === 'quarter') end = addInterval(start, interval('month', 3 * count));
      else end = addInterval(start, interval('year', count));
      const label = `the next ${count} ${count === 1 ? unit : `${unit}s`}`;
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
    // The article is part of the phrase, as it already is for "the last 30
    // days": without it here, "in the last quarter" left "the" in front of a
    // resolved span and the period slot refused a question that "last
    // quarter" answered.
    re: /\b(?:the\s+)?(?:last|previous|prior)\s+(quarter|month|year|week)\b/i,
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
    // The forward twin of the rule above: "in the next quarter" binds the
    // same way "in the last quarter" does.
    re: /\b(?:the\s+)?(?:next|coming|following)\s+(quarter|month|year|week)\b/i,
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
    // The comparators are here rather than only in front of the phrase because
    // a bare year needs a preposition to read as a period at all, and
    // "created before 2026" was refused as an unresolvable year in the same
    // sentence that offered to resolve bare years. The direction is read back
    // off the matched span by `comparatorOf`.
    re: /\b(?:in|during|for|of|before|after|since|through|until|till|prior\s+to|up\s+to|earlier\s+than|later\s+than|no\s+later\s+than|on\s+or\s+(?:before|after))\s+((?:19|20)\d{2})\b(?!-\d)/i,
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
/**
 * A period bounded by a comparator instead of entered.
 *
 * "Which open deals close after December 2026?" names December 2026 and then
 * says the answer lies outside it. Reading the token and discarding the word in
 * front of it re-rendered the question as "close in December 2026" and stated
 * three deals — every one of them inside the range the reader had excluded, and
 * the true answer is none. A comparator is part of the period, so it becomes an
 * open-ended range here rather than being dropped on the way in.
 */
const OPEN_ENDED = Date.UTC(2200, 0, 1);

export type PeriodComparator = 'after' | 'before' | 'since' | 'through';

/** Comparators, longest first so "no later than" beats "later than". */
const COMPARATORS: [PeriodComparator, string][] = [
  ['through', 'no later than'], ['before', 'on or before'], ['after', 'on or after'],
  ['before', 'prior to'], ['before', 'earlier than'], ['before', 'ahead of'], ['before', 'up to'],
  ['after', 'later than'],
  ['before', 'before'], ['before', 'until'], ['before', 'till'],
  ['after', 'after'], ['since', 'since'], ['through', 'through'],
];

const COMPARATOR_ALTERNATION = COMPARATORS.map(([, word]) => word.replace(/ /g, '\\s+')).join('|');
const COMPARATOR_LEADS = new RegExp(`\\b(${COMPARATOR_ALTERNATION})\\s+(?:the\\s+)?$`, 'i');
const COMPARATOR_OWNED = new RegExp(`^(${COMPARATOR_ALTERNATION})\\s+`, 'i');

const comparatorKind = (word: string): PeriodComparator =>
  COMPARATORS.find(([, w]) => w === word.toLowerCase().replace(/\s+/g, ' '))?.[0] ?? 'after';

/**
 * The comparator in front of a resolved period, whether the rule swallowed it
 * ("before 2026") or left it in the sentence ("close after December 2026").
 */
function comparatorOf(text: string, at: number, matched: string): { kind: PeriodComparator; word: string } | null {
  const owned = matched.match(COMPARATOR_OWNED);
  if (owned) return { kind: comparatorKind(owned[1]), word: owned[1] };
  const lead = text.slice(0, at).match(COMPARATOR_LEADS);
  if (lead) return { kind: comparatorKind(lead[1]), word: lead[1] };
  return null;
}

/** The open-ended range a comparator turns a period into. */
function boundedWindow(w: TimeWindow, kind: PeriodComparator, word: string, now: number): TimeWindow {
  const inner = w.label.replace(new RegExp(`^${word.replace(/\s+/g, '\\s+')}\\s+`, 'i'), '');
  const label = `${word.toLowerCase().replace(/\s+/g, ' ')} ${inner}`;
  const matched = COMPARATOR_OWNED.test(w.matched) ? w.matched : `${word} ${w.matched}`;
  switch (kind) {
    // "after December 2026" starts where December ends, so a deal closing
    // inside December is not in it.
    case 'after': return makeWindow(w.end, OPEN_ENDED, label, 'range', matched, now);
    case 'before': return makeWindow(0, w.start, label, 'range', matched, now);
    case 'through': return makeWindow(0, w.end, label, 'range', matched, now);
    case 'since': return makeWindow(w.start, Math.max(now, w.end), label, 'range', matched, now);
  }
}

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
    const comparator = comparatorOf(text, candidate.at, candidate.window.matched);
    const window = comparator
      ? boundedWindow(candidate.window, comparator.kind, comparator.word, now)
      : candidate.window;
    out.push({ window, at: candidate.at, to: candidate.to });
    if (out.length >= limit) break;
  }
  return out;
}

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
