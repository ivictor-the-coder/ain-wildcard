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
import { isTimestamp } from './calendar-core';

export interface FormatLocale {
  locale: string;
  currency: Currency;
  timeZone: string;
}

export const DEFAULT_LOCALE: FormatLocale = { locale: 'en-US', currency: 'usd', timeZone: 'UTC' };

/* --------------------------- a usable environment ------------------------- */

/**
 * A stored locale or timezone the platform cannot actually format with.
 *
 * `Intl` throws a `RangeError` on a tag it does not recognise — `"en_US"` with
 * an underscore, `"Europe/Nowhere"`, a value pasted into a settings field. The
 * throw happens inside render, React unmounts the tree that was formatting,
 * and because every screen in the product formats something, *every* screen
 * goes blank at once — including Settings, which is the only place a person
 * could have put it back. There is no way out from inside the product.
 *
 * So the format layer refuses to be the thing that takes the app down: an
 * unusable value degrades to the default and the screen keeps rendering, with
 * the wrong grouping or the wrong offset, which a person can see and fix. The
 * verdict is cached per string, so this costs one constructor per bad value
 * rather than one per formatted cell.
 */
const usable = new Map<string, boolean>();
function works(key: string, build: () => unknown): boolean {
  const cached = usable.get(key);
  if (cached !== undefined) return cached;
  let ok = true;
  try { build(); } catch { ok = false; }
  usable.set(key, ok);
  return ok;
}

/** The locale to format in: the one asked for when `Intl` accepts it, otherwise the default. */
export function usableLocale(locale: string | undefined | null): string {
  if (!locale) return DEFAULT_LOCALE.locale;
  return works(`l:${locale}`, () => new Intl.NumberFormat(locale)) ? locale : DEFAULT_LOCALE.locale;
}

/** The zone to read instants in: the one asked for when `Intl` accepts it, otherwise UTC. */
export function usableZone(timeZone: string | undefined | null): string {
  if (!timeZone) return DEFAULT_LOCALE.timeZone;
  return works(`z:${timeZone}`, () => new Intl.DateTimeFormat('en-US', { timeZone })) ? timeZone : DEFAULT_LOCALE.timeZone;
}

/* ------------------------------- numbers --------------------------------- */

const numCache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const safe = usableLocale(locale);
  const key = safe + '|' + JSON.stringify(opts);
  let f = numCache.get(key);
  if (!f) {
    // The locale is already known good, so the only thing left that throws is
    // a currency code the workspace stored and ISO does not have. A figure
    // without its symbol is a worse answer than one with it, and a blank
    // screen is worse than both.
    try { f = new Intl.NumberFormat(safe, opts); }
    catch { f = new Intl.NumberFormat(safe, { ...opts, style: 'decimal', currency: undefined }); }
    numCache.set(key, f);
  }
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
  return nf(usableLocale(o.locale), {
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
  return nf(usableLocale(o.locale), {
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
  return nf(usableLocale(o.locale), {
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
  const pr = new Intl.PluralRules(usableLocale(locale), { type: 'ordinal' });
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
    locale: usableLocale(o.locale),
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

export interface NumberSeparators { group: string; decimal: string }

/** What the locale writes between thousands and before the fraction: "," and "." for en-US, "." and "," for de-DE. */
export function numberSeparators(locale = DEFAULT_LOCALE.locale): NumberSeparators {
  const parts = nf(locale, { useGrouping: true, minimumFractionDigits: 1, maximumFractionDigits: 1 }).formatToParts(1234567.8);
  return {
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
  };
}

/**
 * Minor units as the text an amount field edits: grouped the way the locale
 * groups, with the currency's own fraction and no symbol — "4,600,000,000.00",
 * not "4600000000.00". Integer arithmetic throughout: the digits are split,
 * never divided.
 */
export function moneyInputText(minor: number | null | undefined, currency: Currency = DEFAULT_LOCALE.currency, locale = DEFAULT_LOCALE.locale): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return '';
  const exp = exponentOf(currency);
  const digits = String(Math.abs(Math.trunc(minor)));
  const whole = exp > 0 ? digits.slice(0, -exp) || '0' : digits;
  const fraction = exp > 0 ? digits.slice(-exp).padStart(exp, '0') : '';
  const grouped = nf(locale, { useGrouping: true, maximumFractionDigits: 0 }).format(BigInt(whole));
  const sign = minor < 0 ? '-' : '';
  return exp > 0 ? `${sign}${grouped}${numberSeparators(locale).decimal}${fraction}` : `${sign}${grouped}`;
}

/**
 * The reverse: text typed in the locale's notation — grouped, with its own
 * decimal mark — back to minor units. `null` when it is not a number at all.
 */
export function parseMoneyText(raw: string, currency: Currency = DEFAULT_LOCALE.currency, locale = DEFAULT_LOCALE.locale): Money | null {
  const { group, decimal } = numberSeparators(locale);
  const plain = (group ? raw.split(group).join('') : raw)
    .replace(/[\s\u00a0\u202f']/g, '')
    .split(decimal).join('.');
  return parseMoneyInput(plain, currency);
}

/* --------------------------------- time ---------------------------------- */

export interface DateOptions {
  locale?: string;
  timeZone?: string;
  withTime?: boolean;
  withYear?: boolean;
}

/**
 * A throw inside a formatter takes down whatever is rendering, and timestamps
 * arrive from query strings, saved views and API payloads — not all of them
 * sane. Every date helper below treats an instant outside `MAX_TIMESTAMP` the
 * same way it treats `null`: an em dash, never a `RangeError`.
 */
export function formatDate(ts: number | null | undefined, o: DateOptions = {}): string {
  if (!isTimestamp(ts)) return '—';
  return formatDateBase(ts, {
    locale: usableLocale(o.locale),
    timeZone: usableZone(o.timeZone),
    withTime: o.withTime,
    withYear: o.withYear,
  });
}

export function formatDateTime(ts: number | null | undefined, o: DateOptions = {}): string {
  return formatDate(ts, { ...o, withTime: true });
}

export function formatTime(ts: number | null | undefined, o: DateOptions = {}): string {
  if (!isTimestamp(ts)) return '—';
  return new Intl.DateTimeFormat(usableLocale(o.locale), {
    timeZone: usableZone(o.timeZone), hour: 'numeric', minute: '2-digit',
  }).format(ts);
}

export function formatMonth(ts: number, o: DateOptions = {}): string {
  if (!isTimestamp(ts)) return '—';
  return new Intl.DateTimeFormat(usableLocale(o.locale), {
    timeZone: usableZone(o.timeZone), month: 'short', year: o.withYear === false ? undefined : 'numeric',
  }).format(ts);
}

const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
function rtf(locale: string): Intl.RelativeTimeFormat {
  const safe = usableLocale(locale);
  let f = rtfCache.get(safe);
  if (!f) { f = new Intl.RelativeTimeFormat(safe, { numeric: 'auto' }); rtfCache.set(safe, f); }
  return f;
}

/** From a week to a quarter the day is the unit: "46 days ago", never "2 months ago". */
export const RELATIVE_DAYS_FROM = 7 * DAY;
export const RELATIVE_DAYS_UNTIL = 90 * DAY;

/**
 * Rounding to the nearest month from a week out is how a key created 46 days
 * ago read "2 months ago" and a renewal 40 days off read "in 1 month" — a
 * third of the truth gone, on the screens where the day is what matters.
 * Under a week the shared helper's hours and "yesterday" stand; past a
 * quarter, months are honest again.
 */
export function formatRelative(ts: number | null | undefined, now: number, locale = DEFAULT_LOCALE.locale): string {
  if (!isTimestamp(ts) || !isTimestamp(now)) return '—';
  const diff = ts - now;
  const abs = Math.abs(diff);
  if (abs >= RELATIVE_DAYS_FROM && abs < RELATIVE_DAYS_UNTIL) return rtf(locale).format(Math.round(diff / DAY), 'day');
  return formatRelativeBase(ts, now, usableLocale(locale));
}

/** "3 days ago" under a week, an absolute date beyond it — how activity feeds read. */
export function formatWhen(ts: number, now: number, o: DateOptions = {}): string {
  if (!isTimestamp(ts) || !isTimestamp(now)) return '—';
  return Math.abs(now - ts) < 6 * DAY
    ? formatRelative(ts, now, o.locale)
    : formatDate(ts, { ...o, withYear: new Date(ts).getUTCFullYear() !== new Date(now).getUTCFullYear() });
}

export function formatDateRange(start: number, end: number, o: DateOptions = {}): string {
  if (!isTimestamp(start) || !isTimestamp(end)) return `${formatDate(start, o)} – ${formatDate(end, o)}`;
  const locale = usableLocale(o.locale);
  const timeZone = usableZone(o.timeZone);
  const sameYear = new Date(start).getUTCFullYear() === new Date(end).getUTCFullYear();
  const left = formatDateBase(start, { locale, timeZone, withYear: !sameYear });
  const right = formatDateBase(end, { locale, timeZone });
  return `${left} – ${right}`;
}

export const formatDuration = (ms: number, maxParts = 2): string => formatDurationBase(ms, maxParts);

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
  return new Intl.ListFormat(usableLocale(o.locale), { style: 'long', type: o.type || 'conjunction' }).format(items);
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
  // Resolved once, here, so `fmt.locale` and `fmt.timeZone` are values a
  // caller can hand to `Intl` itself — the calendar builds its own formatters
  // out of them — rather than whatever string the workspace happens to hold.
  const locale = usableLocale(base.locale);
  const timeZone = usableZone(base.timeZone);
  const { currency } = base;
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
