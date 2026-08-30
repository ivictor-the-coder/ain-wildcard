import { badRequest } from '../../../shared/errors';
import { DAY, HOUR, MINUTE, WEEK, addInterval, startOfDay, startOfMonth } from '../../../shared/time';
import type { PropertyDef, PropertyNormaliser, PropertyValue, RelativeUnit } from './types';

/**
 * Property values have to survive three different worlds: JSON on the way in,
 * a typed row in `crm_record_values` for the filter engine, and a legible
 * string in the history log. This module is the single place that translates
 * between them, so a date filter and a date column can never disagree.
 */

export const isEmptyValue = (value: unknown): boolean =>
  value === null || value === undefined || value === '' ||
  (Array.isArray(value) && value.length === 0);

/* ------------------------------ date parsing ----------------------------- */

const QUARTER_START = (ts: number): number => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
};

export function shiftByUnit(ts: number, count: number, unit: RelativeUnit): number {
  switch (unit) {
    case 'minute': return ts + count * MINUTE;
    case 'hour': return ts + count * HOUR;
    case 'day': return ts + count * DAY;
    case 'week': return ts + count * WEEK;
    case 'month': return addInterval(ts, { unit: 'month', count });
    case 'quarter': return addInterval(ts, { unit: 'month', count: count * 3 });
    case 'year': return addInterval(ts, { unit: 'year', count });
  }
}

const RELATIVE_OFFSET = /^([+-]?\d+)\s*(m|min|minutes?|h|hours?|d|days?|w|weeks?|mo|months?|q|quarters?|y|years?)$/i;
const UNIT_ALIAS: Record<string, RelativeUnit> = {
  m: 'minute', min: 'minute', minute: 'minute', minutes: 'minute',
  h: 'hour', hour: 'hour', hours: 'hour',
  d: 'day', day: 'day', days: 'day',
  w: 'week', week: 'week', weeks: 'week',
  mo: 'month', month: 'month', months: 'month',
  q: 'quarter', quarter: 'quarter', quarters: 'quarter',
  y: 'year', year: 'year', years: 'year',
};

/**
 * Accepts unix millis, an ISO-8601 string, or one of the relative tokens saved
 * views rely on (`today`, `start_of_quarter`, `-30d`, `+2w`).
 */
export function resolveDate(raw: unknown, now: number): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null;
  if (typeof raw !== 'string') return null;
  const token = raw.trim().toLowerCase();

  switch (token) {
    case 'now': return now;
    case 'today': case 'start_of_day': return startOfDay(now);
    case 'end_of_day': return startOfDay(now) + DAY - 1;
    case 'yesterday': return startOfDay(now) - DAY;
    case 'tomorrow': return startOfDay(now) + DAY;
    case 'start_of_week': {
      const d = new Date(startOfDay(now));
      return startOfDay(now) - ((d.getUTCDay() + 6) % 7) * DAY;
    }
    case 'end_of_week': {
      const d = new Date(startOfDay(now));
      return startOfDay(now) + (7 - ((d.getUTCDay() + 6) % 7)) * DAY - 1;
    }
    case 'start_of_month': return startOfMonth(now);
    case 'end_of_month': return addInterval(startOfMonth(now), { unit: 'month', count: 1 }) - 1;
    case 'start_of_quarter': return QUARTER_START(now);
    case 'end_of_quarter': return addInterval(QUARTER_START(now), { unit: 'month', count: 3 }) - 1;
    case 'start_of_year': return Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
    case 'end_of_year': return Date.UTC(new Date(now).getUTCFullYear() + 1, 0, 1) - 1;
  }

  const offset = RELATIVE_OFFSET.exec(token);
  if (offset) {
    const count = Number(offset[1]);
    const unit = UNIT_ALIAS[offset[2].toLowerCase()];
    if (unit) return shiftByUnit(now, count, unit);
  }

  if (/^-?\d+$/.test(token)) return Number(token);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ----------------------------- canonical forms ---------------------------- */

/**
 * The canonical form of a web domain: no scheme, no `www.`, no path, no port,
 * no trailing dot, lowercased and trimmed. `https://WWW.Andinaenvases.CL/about`
 * and `andinaenvases.cl ` are the same company, and a dedupe key that cannot
 * see that is not a dedupe key.
 */
export function canonicalDomain(raw: unknown): string {
  let value = String(raw ?? '').trim().toLowerCase();
  if (!value) return '';
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.replace(/^[^@/]*@/, '');
  value = value.split(/[/?#]/)[0];
  value = value.replace(/:\d+$/, '');
  value = value.replace(/^www\./, '');
  return value.replace(/\.+$/, '');
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export const canonicalDigits = (raw: unknown): string => String(raw ?? '').replace(/\D/g, '');

/** Apply a property's declared canonical form. Runs before uniqueness. */
export function normaliseText(value: string, normalize: PropertyNormaliser): string {
  switch (normalize) {
    case 'lower': return value.trim().toLowerCase();
    case 'upper': return value.trim().toUpperCase();
    case 'domain': return canonicalDomain(value);
    case 'digits': return canonicalDigits(value);
    case 'none': default: return value;
  }
}

export const NORMALISERS: PropertyNormaliser[] = ['none', 'lower', 'upper', 'domain', 'digits'];

/**
 * The form a value takes once stored, used when looking a record up by one of
 * its properties. `findBy('domain', 'WWW.Andina.CL')` has to find the record
 * stored as `andina.cl`, or keyed imports create a duplicate every run.
 */
export function canonicalLookupValue(prop: PropertyDef | null, value: string | number): string | number {
  if (typeof value !== 'string' || !prop) return value;
  if (prop.type === 'email') return value.trim().toLowerCase();
  if (prop.normalize !== 'none') return normaliseText(value, prop.normalize);
  return value;
}

/* -------------------------------- coercion ------------------------------- */

/**
 * Ceilings on stored text. Without them a 50,000-character company name
 * becomes the display name in every list and a 6 MB note becomes a row every
 * query has to carry. HubSpot caps single-line text at 65,536; Ain is stricter
 * on the properties that get rendered in a table cell.
 */
const MAX_LENGTH: Partial<Record<PropertyDef['type'], number>> = {
  string: 500, text: 65_536, url: 2048, email: 320, phone: 40,
  enum: 200, user: 120, reference: 120, computed: 2000,
};
const MAX_MULTI_ITEMS = 100;
const MAX_JSON_BYTES = 64 * 1024;

const PHONE_RE = /^[+]?[0-9 ()\-.]{6,32}$/;
const EMAIL_RE = /^[^\s@,;<>()[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export interface CoerceContext {
  now: number;
  /** Property path prefix used in validation errors (`properties.amount`). */
  path?: string;
}

/** Normalise one incoming value to its property's canonical shape, or throw. */
export function coerceValue(prop: PropertyDef, raw: unknown, ctx: CoerceContext): PropertyValue {
  const param = ctx.path ? `${ctx.path}.${prop.name}` : prop.name;
  const reject = (message: string): never => { throw badRequest('property_invalid', message, param); };

  if (isEmptyValue(raw)) {
    if (prop.required) reject(`${prop.label} is required.`);
    return prop.type === 'multi_enum' ? [] : null;
  }

  const v = prop.validation;
  switch (prop.type) {
    case 'number':
    case 'currency': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[, $€£]/g, ''));
      if (!Number.isFinite(n)) reject(`${prop.label} must be a number.`);
      if (prop.type === 'currency' && !Number.isInteger(n)) {
        reject(`${prop.label} is money and must be an integer number of minor units (cents), not ${n}.`);
      }
      if (v.min !== undefined && n < v.min) reject(`${prop.label} must be at least ${v.min}.`);
      if (v.max !== undefined && n > v.max) reject(`${prop.label} must be at most ${v.max}.`);
      return n;
    }
    case 'date':
    case 'datetime': {
      const ts = resolveDate(raw, ctx.now);
      if (ts === null) reject(`${prop.label} must be a date — unix millis, an ISO-8601 string, or a token like "today".`);
      return prop.type === 'date' ? startOfDay(ts as number) : (ts as number);
    }
    case 'bool': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(s)) return true;
      if (['false', '0', 'no', 'n'].includes(s)) return false;
      return reject(`${prop.label} must be true or false.`);
    }
    case 'enum': {
      const s = normaliseText(String(raw), prop.normalize);
      if (s.length > (v.max_length ?? MAX_LENGTH.enum!)) {
        reject(`${prop.label} must be at most ${v.max_length ?? MAX_LENGTH.enum} characters.`);
      }
      if (prop.options.length && !v.allow_other && !prop.options.some((o) => o.value === s)) {
        reject(`"${s}" is not an option for ${prop.label}. Allowed: ${prop.options.map((o) => o.value).join(', ')}.`);
      }
      return s;
    }
    case 'multi_enum': {
      const items = (Array.isArray(raw) ? raw.map((x) => String(x)) : String(raw).split(';').map((s) => s.trim()).filter(Boolean))
        .map((item) => normaliseText(item, prop.normalize));
      if (items.length > MAX_MULTI_ITEMS) reject(`${prop.label} accepts at most ${MAX_MULTI_ITEMS} values; ${items.length} were sent.`);
      if (items.some((item) => item.length > MAX_LENGTH.enum!)) reject(`Each ${prop.label} value must be at most ${MAX_LENGTH.enum} characters.`);
      if (prop.options.length && !v.allow_other) {
        const allowed = new Set(prop.options.map((o) => o.value));
        const bad = items.find((i) => !allowed.has(i));
        if (bad) reject(`"${bad}" is not an option for ${prop.label}. Allowed: ${[...allowed].join(', ')}.`);
      }
      return [...new Set(items)];
    }
    case 'email': {
      const s = String(raw).trim().toLowerCase();
      if (s.length > MAX_LENGTH.email!) reject(`${prop.label} must be at most ${MAX_LENGTH.email} characters.`);
      if (!EMAIL_RE.test(s)) reject(`"${s}" is not a valid email address.`);
      return s;
    }
    case 'url': {
      const s = String(raw).trim();
      if (s.length > MAX_LENGTH.url!) reject(`${prop.label} must be at most ${MAX_LENGTH.url} characters.`);
      const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
      try { return new URL(withScheme).toString().replace(/\/$/, ''); }
      catch { return reject(`"${s}" is not a valid URL.`); }
    }
    case 'phone': {
      const s = normaliseText(String(raw).trim(), prop.normalize);
      if (s.length > MAX_LENGTH.phone!) reject(`${prop.label} must be at most ${MAX_LENGTH.phone} characters.`);
      if (!PHONE_RE.test(s)) reject(`"${s}" is not a valid phone number.`);
      return s;
    }
    case 'json': {
      const parsed = typeof raw === 'string'
        ? (() => { try { return JSON.parse(raw) as PropertyValue; } catch { return reject(`${prop.label} must be valid JSON.`); } })()
        : (raw as PropertyValue);
      const encoded = JSON.stringify(parsed) ?? '';
      if (encoded.length > MAX_JSON_BYTES) {
        reject(`${prop.label} must be at most ${Math.round(MAX_JSON_BYTES / 1024)}KB of JSON; ${Math.round(encoded.length / 1024)}KB were sent.`);
      }
      return parsed;
    }
    case 'computed':
      return typeof raw === 'number' || typeof raw === 'boolean' ? raw : String(raw);
    case 'user':
    case 'reference':
    case 'string':
    case 'text':
    default: {
      const s = normaliseText(String(raw), prop.normalize);
      const ceiling = v.max_length ?? MAX_LENGTH[prop.type] ?? MAX_LENGTH.string!;
      if (v.min_length !== undefined && s.length < v.min_length) reject(`${prop.label} must be at least ${v.min_length} characters.`);
      if (s.length > ceiling) {
        reject(`${prop.label} must be at most ${ceiling.toLocaleString('en-US')} characters — ${s.length.toLocaleString('en-US')} were sent.`);
      }
      if (prop.normalize === 'domain' && s && !DOMAIN_RE.test(s)) {
        reject(`"${String(raw)}" is not a domain. Give the bare host, like "andinaenvases.cl".`);
      }
      if (v.pattern) {
        let re: RegExp;
        try { re = new RegExp(v.pattern); }
        catch { return reject(`${prop.label} has an invalid validation pattern configured.`); }
        if (!re.test(s)) reject(`${prop.label} does not match the required format.`);
      }
      return s;
    }
  }
}

/* ------------------------------- indexing -------------------------------- */

export interface IndexedValue {
  value_text: string | null;
  value_number: number | null;
  value_date: number | null;
}

/**
 * Multi-selects are stored as `;a;b;` so a single indexed LIKE answers
 * "has any of these tags" without a join table.
 */
export const MULTI_SEP = ';';
export const encodeMulti = (items: string[]): string => `${MULTI_SEP}${items.join(MULTI_SEP)}${MULTI_SEP}`;

export function indexValue(prop: PropertyDef, value: PropertyValue): IndexedValue {
  if (isEmptyValue(value)) return { value_text: null, value_number: null, value_date: null };
  switch (prop.type) {
    case 'number':
    case 'currency':
      return { value_text: String(value), value_number: Number(value), value_date: null };
    case 'date':
    case 'datetime':
      return { value_text: new Date(Number(value)).toISOString(), value_number: Number(value), value_date: Number(value) };
    case 'bool':
      return { value_text: value ? 'true' : 'false', value_number: value ? 1 : 0, value_date: null };
    case 'multi_enum':
      return { value_text: encodeMulti(value as string[]), value_number: (value as string[]).length, value_date: null };
    case 'json':
      return { value_text: JSON.stringify(value), value_number: null, value_date: null };
    case 'computed': {
      const n = typeof value === 'number' ? value : Number(value);
      return { value_text: String(value), value_number: Number.isFinite(n) ? n : null, value_date: null };
    }
    default: {
      const text = String(value);
      const n = Number(text);
      return { value_text: text, value_number: text !== '' && Number.isFinite(n) ? n : null, value_date: null };
    }
  }
}

/** Which indexed column a property compares against. */
export function columnFor(type: PropertyDef['type']): 'value_text' | 'value_number' | 'value_date' {
  switch (type) {
    case 'number': case 'currency': return 'value_number';
    case 'date': case 'datetime': return 'value_date';
    case 'bool': return 'value_number';
    default: return 'value_text';
  }
}

/** Stable, human-legible rendering used by the property history log. */
export function historyText(prop: PropertyDef | undefined, value: PropertyValue): string | null {
  if (isEmptyValue(value)) return null;
  if (Array.isArray(value)) return value.join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  if (prop && (prop.type === 'date' || prop.type === 'datetime')) return new Date(Number(value)).toISOString();
  return String(value);
}

export function valuesEqual(a: PropertyValue, b: PropertyValue): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [];
    const bb = Array.isArray(b) ? b : [];
    return aa.length === bb.length && aa.every((x, i) => x === bb[i]);
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}
