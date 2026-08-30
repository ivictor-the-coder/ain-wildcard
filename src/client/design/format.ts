/**
 * Every number, date and quantity that reaches a screen goes through here so
 * the whole product speaks one dialect: the workspace's locale, currency and
 * timezone. Nothing below reads `Date.now()` — callers pass workspace time.
 */
import { useMemo } from 'react';
import {
  exponentOf, formatMoney as formatMoneyBase, parseMoney as parseMoneyBase,
  type Currency, type Money,
} from '../../shared/money';
import {
  DAY, HOUR, MINUTE, SECOND, formatDate as formatDateBase, formatDuration as formatDurationBase,
  formatRelative as formatRelativeBase,
} from '../../shared/time';
import { useSession } from '../kernel/session';

export interface FormatLocale {
  locale: string;
  currency: Currency;
  timeZone: string;
}

export const DEFAULT_LOCALE: FormatLocale = { locale: 'en-US', currency: 'usd', timeZone: 'UTC' };

/* ------------------------------- numbers --------------------------------- */

const numCache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = locale + '|' + JSON.stringify(opts);
  let f = numCache.get(key);
  if (!f) { f = new Intl.NumberFormat(locale, opts); numCache.set(key, f); }
  return f;
}

export interface NumberOptions {
  locale?: string;
  decimals?: number;
  maxDecimals?: number;
  signDisplay?: Intl.NumberFormatOptions['signDisplay'];
  grouping?: boolean;
}

export function formatNumber(value: number, o: NumberOptions = {}): string {
  if (!Number.isFinite(value)) return '—';
  const min = o.decimals ?? 0;
  const max = o.maxDecimals ?? Math.max(min, o.decimals ?? 0);
  return nf(o.locale || DEFAULT_LOCALE.locale, {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
    signDisplay: o.signDisplay || 'auto',
    useGrouping: o.grouping ?? true,
  }).format(value);
}

/** 1_240 → "1.2K", 3_400_000 → "3.4M". Used on axes and dense metric tiles. */
export function formatCompact(value: number, o: NumberOptions = {}): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  return nf(o.locale || DEFAULT_LOCALE.locale, {
    notation: 'compact',
    maximumFractionDigits: abs >= 1000 ? 1 : (o.maxDecimals ?? 0),
    signDisplay: o.signDisplay || 'auto',
  }).format(value);
}

export interface PercentOptions extends NumberOptions {
  /** When true (the default) the input is a 0–1 fraction; otherwise 0–100 points. */
  fraction?: boolean;
}

export function formatPercent(value: number, o: PercentOptions = {}): string {
  if (!Number.isFinite(value)) return '—';
  const v = o.fraction === false ? value / 100 : value;
  const decimals = o.decimals ?? (Math.abs(v) < 0.1 && v !== 0 ? 1 : 0);
  return nf(o.locale || DEFAULT_LOCALE.locale, {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: o.maxDecimals ?? decimals,
    signDisplay: o.signDisplay || 'auto',
  }).format(v);
}

/** A signed change for deltas: "+12.4%", "−3 pts". */
export function formatDelta(value: number, o: PercentOptions & { unit?: 'percent' | 'number' } = {}): string {
  if (!Number.isFinite(value)) return '—';
  const signDisplay = o.signDisplay ?? 'exceptZero';
  if (o.unit === 'number') return formatNumber(value, { ...o, signDisplay });
  return formatPercent(value, { ...o, signDisplay });
}

export function formatOrdinal(value: number, locale = DEFAULT_LOCALE.locale): string {
  const pr = new Intl.PluralRules(locale, { type: 'ordinal' });
  const suffix: Record<string, string> = { one: 'st', two: 'nd', few: 'rd', other: 'th', zero: 'th', many: 'th' };
  return `${formatNumber(value, { locale })}${suffix[pr.select(value)] ?? 'th'}`;
}

/* -------------------------------- money ---------------------------------- */

export interface MoneyOptions {
  locale?: string;
  currency?: Currency;
  compact?: boolean;
  /** Hide ".00" when the amount is a whole unit. */
  trimZeroFraction?: boolean;
  signDisplay?: 'auto' | 'always' | 'never' | 'exceptZero';
}

/** Accepts either a Money object or raw minor units plus a currency. */
export function formatMoney(value: Money | number, o: MoneyOptions = {}): string {
  const m: Money = typeof value === 'number'
    ? { amount: Math.round(value), currency: (o.currency || DEFAULT_LOCALE.currency).toLowerCase() }
    : value;
  if (!Number.isFinite(m.amount)) return '—';
  return formatMoneyBase(m, {
    locale: o.locale || DEFAULT_LOCALE.locale,
    compact: o.compact,
    trimZeroFraction: o.trimZeroFraction,
    signDisplay: o.signDisplay,
  });
}

/** Minor units → major units as a number, for chart scales. */
export function toMajorUnits(amount: number, currency: Currency = DEFAULT_LOCALE.currency): number {
  return amount / 10 ** exponentOf(currency);
}

export function parseMoneyInput(input: string, currency: Currency = DEFAULT_LOCALE.currency): Money | null {
  try { return parseMoneyBase(input, currency); } catch { return null; }
}

/** The symbol alone, e.g. "$" or "€" — for input prefixes. */
export function currencySymbol(currency: Currency = DEFAULT_LOCALE.currency, locale = DEFAULT_LOCALE.locale): string {
  const parts = nf(locale, { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 0 }).formatToParts(0);
  return parts.find((p) => p.type === 'currency')?.value ?? currency.toUpperCase();
}

/* --------------------------------- time ---------------------------------- */

export interface DateOptions {
  locale?: string;
  timeZone?: string;
  withTime?: boolean;
  withYear?: boolean;
}

export function formatDate(ts: number | null | undefined, o: DateOptions = {}): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '—';
  return formatDateBase(ts, {
    locale: o.locale || DEFAULT_LOCALE.locale,
    timeZone: o.timeZone || DEFAULT_LOCALE.timeZone,
    withTime: o.withTime,
    withYear: o.withYear,
  });
}

export function formatDateTime(ts: number | null | undefined, o: DateOptions = {}): string {
  return formatDate(ts, { ...o, withTime: true });
}

export function formatTime(ts: number | null | undefined, o: DateOptions = {}): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '—';
  return new Intl.DateTimeFormat(o.locale || DEFAULT_LOCALE.locale, {
    timeZone: o.timeZone || DEFAULT_LOCALE.timeZone, hour: 'numeric', minute: '2-digit',
  }).format(ts);
}

export function formatMonth(ts: number, o: DateOptions = {}): string {
  return new Intl.DateTimeFormat(o.locale || DEFAULT_LOCALE.locale, {
    timeZone: o.timeZone || DEFAULT_LOCALE.timeZone, month: 'short', year: o.withYear === false ? undefined : 'numeric',
  }).format(ts);
}

export function formatRelative(ts: number | null | undefined, now: number, locale = DEFAULT_LOCALE.locale): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '—';
  return formatRelativeBase(ts, now, locale);
}

/** "3 days ago" under a week, an absolute date beyond it — how activity feeds read. */
export function formatWhen(ts: number, now: number, o: DateOptions = {}): string {
  return Math.abs(now - ts) < 6 * DAY
    ? formatRelative(ts, now, o.locale)
    : formatDate(ts, { ...o, withYear: new Date(ts).getUTCFullYear() !== new Date(now).getUTCFullYear() });
}

export function formatDateRange(start: number, end: number, o: DateOptions = {}): string {
  const locale = o.locale || DEFAULT_LOCALE.locale;
  const timeZone = o.timeZone || DEFAULT_LOCALE.timeZone;
  const sameYear = new Date(start).getUTCFullYear() === new Date(end).getUTCFullYear();
  const left = formatDateBase(start, { locale, timeZone, withYear: !sameYear });
  const right = formatDateBase(end, { locale, timeZone });
  return `${left} – ${right}`;
}

export const formatDuration = (ms: number, maxParts = 2): string => formatDurationBase(ms, maxParts);

/** "4 min 12 s" — spelled out, for SLA copy rather than table cells. */
export function formatDurationLong(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MINUTE) return plural(Math.round(abs / SECOND), 'second');
  if (abs < HOUR) return plural(Math.round(abs / MINUTE), 'minute');
  if (abs < DAY) return plural(Math.round((abs / HOUR) * 10) / 10, 'hour');
  return plural(Math.round(abs / DAY), 'day');
}

/* ------------------------------ quantities ------------------------------- */

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatFileSize(bytes: number, locale = DEFAULT_LOCALE.locale): string {
  if (!Number.isFinite(bytes)) return '—';
  const neg = bytes < 0;
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) { value /= 1024; unit++; }
  const decimals = unit === 0 || Number.isInteger(value) || value >= 10 ? 0 : 1;
  return `${neg ? '-' : ''}${formatNumber(value, { locale, decimals, maxDecimals: decimals })} ${SIZE_UNITS[unit]}`;
}

const IRREGULAR: Record<string, string> = {
  person: 'people', company: 'companies', activity: 'activities', entry: 'entries',
  property: 'properties', category: 'categories', policy: 'policies', reply: 'replies',
  is: 'are', has: 'have', was: 'were', this: 'these',
};

export function pluralize(word: string, count: number): string {
  if (count === 1) return word;
  const lower = word.toLowerCase();
  if (IRREGULAR[lower]) {
    const p = IRREGULAR[lower];
    return word[0] === word[0].toUpperCase() ? p[0].toUpperCase() + p.slice(1) : p;
  }
  if (/(s|x|z|ch|sh)$/.test(lower)) return word + 'es';
  if (/[^aeiou]y$/.test(lower)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

/** `plural(3, 'invoice')` → "3 invoices". Pass `hideCount` for the noun alone. */
export function plural(count: number, word: string, o: { locale?: string; hideCount?: boolean } = {}): string {
  const noun = pluralize(word, count);
  return o.hideCount ? noun : `${formatNumber(count, { locale: o.locale, maxDecimals: 1 })} ${noun}`;
}

export function formatList(items: string[], o: { locale?: string; type?: 'conjunction' | 'disjunction' } = {}): string {
  if (!items.length) return '';
  return new Intl.ListFormat(o.locale || DEFAULT_LOCALE.locale, { style: 'long', type: o.type || 'conjunction' }).format(items);
}

/* --------------------------------- text ---------------------------------- */

export function initials(name: string, max = 2): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, max).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).slice(0, max).toUpperCase();
}

export function titleCase(input: string): string {
  return input
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** `past_due` → "Past due" — how enum values are shown throughout the product. */
export function humanize(input: string): string {
  const s = input.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

export function truncateMiddle(input: string, max = 24): string {
  if (input.length <= max) return input;
  const half = Math.floor((max - 1) / 2);
  return `${input.slice(0, half)}…${input.slice(input.length - half)}`;
}

/* ----------------------------- bound formatter --------------------------- */

export interface Formatter extends FormatLocale {
  money(value: Money | number, o?: MoneyOptions): string;
  moneyCompact(value: Money | number, o?: MoneyOptions): string;
  number(value: number, o?: NumberOptions): string;
  compact(value: number, o?: NumberOptions): string;
  percent(value: number, o?: PercentOptions): string;
  delta(value: number, o?: PercentOptions & { unit?: 'percent' | 'number' }): string;
  date(ts: number | null | undefined, o?: DateOptions): string;
  dateTime(ts: number | null | undefined, o?: DateOptions): string;
  time(ts: number | null | undefined, o?: DateOptions): string;
  month(ts: number, o?: DateOptions): string;
  dateRange(start: number, end: number, o?: DateOptions): string;
  relative(ts: number | null | undefined, now?: number): string;
  when(ts: number, now?: number): string;
  duration(ms: number, maxParts?: number): string;
  fileSize(bytes: number): string;
  plural(count: number, word: string, o?: { hideCount?: boolean }): string;
  list(items: string[], type?: 'conjunction' | 'disjunction'): string;
  symbol(currency?: Currency): string;
  now(): number;
}

export function createFormatter(base: FormatLocale, now: () => number): Formatter {
  const { locale, currency, timeZone } = base;
  return {
    locale, currency, timeZone,
    money: (v, o) => formatMoney(v, { locale, currency, ...o }),
    moneyCompact: (v, o) => formatMoney(v, { locale, currency, compact: true, trimZeroFraction: true, ...o }),
    number: (v, o) => formatNumber(v, { locale, ...o }),
    compact: (v, o) => formatCompact(v, { locale, ...o }),
    percent: (v, o) => formatPercent(v, { locale, ...o }),
    delta: (v, o) => formatDelta(v, { locale, ...o }),
    date: (ts, o) => formatDate(ts, { locale, timeZone, ...o }),
    dateTime: (ts, o) => formatDateTime(ts, { locale, timeZone, ...o }),
    time: (ts, o) => formatTime(ts, { locale, timeZone, ...o }),
    month: (ts, o) => formatMonth(ts, { locale, timeZone, ...o }),
    dateRange: (s, e, o) => formatDateRange(s, e, { locale, timeZone, ...o }),
    relative: (ts, at) => formatRelative(ts, at ?? now(), locale),
    when: (ts, at) => formatWhen(ts, at ?? now(), { locale, timeZone }),
    duration: (ms, maxParts) => formatDuration(ms, maxParts),
    fileSize: (b) => formatFileSize(b, locale),
    plural: (count, word, o) => plural(count, word, { locale, ...o }),
    list: (items, type) => formatList(items, { locale, type }),
    symbol: (c) => currencySymbol(c || currency, locale),
    now,
  };
}

/**
 * The formatter bound to the signed-in workspace. Falls back to en-US/USD/UTC
 * outside a SessionProvider so the design lab and isolated tests still render.
 */
export function useFormat(): Formatter {
  let session: ReturnType<typeof useSession> | null = null;
  try { session = useSession(); } catch { session = null; }
  const locale = session?.locale ?? DEFAULT_LOCALE.locale;
  const currency = session?.currency ?? DEFAULT_LOCALE.currency;
  const timeZone = session?.timeZone ?? DEFAULT_LOCALE.timeZone;
  const nowFn = session?.now;
  return useMemo(
    () => createFormatter({ locale, currency, timeZone }, nowFn ?? (() => Date.now())),
    [locale, currency, timeZone, nowFn],
  );
}
