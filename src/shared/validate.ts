import { badRequest } from './errors';

/**
 * A dependency-free, zod-shaped validator. Every failure surfaces as the same
 * Stripe-style `invalid_request_error` with a dotted `param` path, so bad input
 * is reported identically by the API, the SDK and the forms in the UI.
 */
export interface Validator<T> {
  readonly _t?: T;
  parse(value: unknown, path?: string): T;
  describe(): SchemaNode;
}

export interface SchemaNode {
  type: string;
  optional?: boolean;
  nullable?: boolean;
  enum?: readonly string[];
  of?: SchemaNode;
  fields?: Record<string, SchemaNode>;
  min?: number;
  max?: number;
  pattern?: string;
  format?: string;
  default?: unknown;
  description?: string;
}

export type Infer<V> = V extends Validator<infer T> ? T : never;

const fail = (path: string, message: string, detail?: unknown): never => {
  throw badRequest('parameter_invalid', message, path || undefined, detail);
};

function make<T>(node: SchemaNode, parse: (value: unknown, path: string) => T): Validator<T> {
  return { parse: (value, path = '') => parse(value, path), describe: () => node };
}

/* ------------------------------- primitives ------------------------------ */

export interface StringOpts { min?: number; max?: number; pattern?: RegExp; trim?: boolean; description?: string }

export const string = (o: StringOpts = {}): Validator<string> =>
  make<string>({ type: 'string', min: o.min, max: o.max, pattern: o.pattern?.source, description: o.description }, (raw, path) => {
    if (typeof raw !== 'string') return fail(path, `Expected a string, received ${typeName(raw)}.`);
    const value = o.trim === false ? raw : raw.trim();
    if (o.min !== undefined && value.length < o.min) return fail(path, `Must be at least ${o.min} character${o.min === 1 ? '' : 's'}.`);
    if (o.max !== undefined && value.length > o.max) return fail(path, `Must be at most ${o.max} characters.`);
    if (o.pattern && !o.pattern.test(value)) return fail(path, `Does not match the required format.`);
    return value;
  });

const EMAIL_RE = /^[^\s@,;<>()[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export const email = (): Validator<string> =>
  make<string>({ type: 'string', format: 'email' }, (raw, path) => {
    const s = string({ min: 3, max: 320 }).parse(raw, path).toLowerCase();
    if (!EMAIL_RE.test(s)) return fail(path, `"${s}" is not a valid email address.`);
    return s;
  });

export const url = (): Validator<string> =>
  make<string>({ type: 'string', format: 'uri' }, (raw, path) => {
    const s = string({ min: 1, max: 2048 }).parse(raw, path);
    try { const u = new URL(s); if (!/^https?:$/.test(u.protocol)) throw 0; return u.toString(); }
    catch { return fail(path, `"${s}" is not a valid http(s) URL.`); }
  });

export interface NumberOpts { min?: number; max?: number; description?: string }

export const number = (o: NumberOpts = {}): Validator<number> =>
  make<number>({ type: 'number', min: o.min, max: o.max, description: o.description }, (raw, path) => {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n)) return fail(path, `Expected a number, received ${typeName(raw)}.`);
    if (o.min !== undefined && n < o.min) return fail(path, `Must be greater than or equal to ${o.min}.`);
    if (o.max !== undefined && n > o.max) return fail(path, `Must be less than or equal to ${o.max}.`);
    return n;
  });

export const int = (o: NumberOpts = {}): Validator<number> =>
  make<number>({ type: 'integer', min: o.min, max: o.max, description: o.description }, (raw, path) => {
    const n = number(o).parse(raw, path);
    if (!Number.isInteger(n)) return fail(path, `Must be a whole number.`);
    return n;
  });

export const boolean = (): Validator<boolean> =>
  make<boolean>({ type: 'boolean' }, (raw, path) => {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return fail(path, `Expected a boolean, received ${typeName(raw)}.`);
  });

/** Unix epoch milliseconds. Accepts a number or an ISO-8601 string. */
export const timestamp = (): Validator<number> =>
  make<number>({ type: 'integer', format: 'unix-ms' }, (raw, path) => {
    if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
    if (typeof raw === 'string') {
      const t = Date.parse(raw);
      if (Number.isFinite(t)) return t;
    }
    return fail(path, `Expected a unix millisecond timestamp or ISO-8601 date string.`);
  });

export const currency = (): Validator<string> =>
  make<string>({ type: 'string', format: 'currency', pattern: '^[a-z]{3}$' }, (raw, path) => {
    const s = string({ min: 3, max: 3 }).parse(raw, path).toLowerCase();
    if (!/^[a-z]{3}$/.test(s)) return fail(path, `"${s}" is not a 3-letter ISO-4217 currency code.`);
    return s;
  });

export const id = (prefix?: string): Validator<string> =>
  make<string>({ type: 'string', format: prefix ? `id:${prefix}` : 'id' }, (raw, path) => {
    const s = string({ min: 1, max: 255 }).parse(raw, path);
    if (prefix && !s.startsWith(`${prefix}_`)) return fail(path, `Expected an id beginning with "${prefix}_", received "${s}".`);
    return s;
  });

export const literal = <T extends string | number | boolean>(value: T): Validator<T> =>
  make<T>({ type: 'literal', enum: [String(value)] }, (raw, path) =>
    raw === value ? (raw as T) : fail(path, `Expected ${JSON.stringify(value)}.`));

export const enumOf = <const T extends readonly string[]>(values: T): Validator<T[number]> =>
  make<T[number]>({ type: 'string', enum: values }, (raw, path) => {
    if (typeof raw !== 'string' || !values.includes(raw)) {
      return fail(path, `Must be one of: ${values.join(', ')}.`, { allowed: values });
    }
    return raw as T[number];
  });

export const any = (): Validator<unknown> => make<unknown>({ type: 'any' }, (raw) => raw);

export const json = (): Validator<unknown> =>
  make<unknown>({ type: 'json' }, (raw, path) => {
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { return fail(path, 'Expected valid JSON.'); }
  });

/* ------------------------------- combinators ----------------------------- */

export const optional = <T>(inner: Validator<T>): Validator<T | undefined> =>
  make<T | undefined>({ ...inner.describe(), optional: true }, (raw, path) =>
    raw === undefined || raw === '' ? undefined : inner.parse(raw, path));

export const nullable = <T>(inner: Validator<T>): Validator<T | null> =>
  make<T | null>({ ...inner.describe(), nullable: true }, (raw, path) =>
    raw === null || raw === undefined ? null : inner.parse(raw, path));

export const withDefault = <T>(inner: Validator<T>, def: T): Validator<T> =>
  make<T>({ ...inner.describe(), optional: true, default: def as unknown }, (raw, path) =>
    raw === undefined || raw === null || raw === '' ? def : inner.parse(raw, path));

export interface ArrayOpts { min?: number; max?: number }

export const array = <T>(inner: Validator<T>, o: ArrayOpts = {}): Validator<T[]> =>
  make<T[]>({ type: 'array', of: inner.describe(), min: o.min, max: o.max }, (raw, path) => {
    if (!Array.isArray(raw)) return fail(path, `Expected an array, received ${typeName(raw)}.`);
    if (o.min !== undefined && raw.length < o.min) return fail(path, `Must contain at least ${o.min} item${o.min === 1 ? '' : 's'}.`);
    if (o.max !== undefined && raw.length > o.max) return fail(path, `Must contain at most ${o.max} items.`);
    return raw.map((item, i) => inner.parse(item, path ? `${path}[${i}]` : `[${i}]`));
  });

export const record = <T>(inner: Validator<T>): Validator<Record<string, T>> =>
  make<Record<string, T>>({ type: 'object', of: inner.describe() }, (raw, path) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return fail(path, `Expected an object, received ${typeName(raw)}.`);
    }
    const out: Record<string, T> = {};
    for (const [k, val] of Object.entries(raw)) out[k] = inner.parse(val, path ? `${path}.${k}` : k);
    return out;
  });

/** Metadata: a flat string→string map, capped like Stripe's (50 keys, 500 chars). */
export const metadata = (): Validator<Record<string, string>> =>
  make<Record<string, string>>({ type: 'object', format: 'metadata' }, (raw, path) => {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) return fail(path, 'Metadata must be an object of string values.');
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > 50) return fail(path, 'Metadata is limited to 50 keys.');
    const out: Record<string, string> = {};
    for (const [k, val] of entries) {
      if (k.length > 40) return fail(path ? `${path}.${k}` : k, 'Metadata keys are limited to 40 characters.');
      const s = val === null || val === undefined ? '' : String(val);
      if (s.length > 500) return fail(path ? `${path}.${k}` : k, 'Metadata values are limited to 500 characters.');
      out[k] = s;
    }
    return out;
  });

type ShapeOf<S> = { [K in keyof S]: S[K] extends Validator<infer T> ? T : never };

export interface ObjectOpts { strict?: boolean }

export const object = <S extends Record<string, Validator<any>>>(shape: S, o: ObjectOpts = {}): Validator<ShapeOf<S>> => {
  const fields: Record<string, SchemaNode> = {};
  for (const [k, val] of Object.entries(shape)) fields[k] = val.describe();
  return make<ShapeOf<S>>({ type: 'object', fields }, (raw, path) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return fail(path, `Expected an object, received ${typeName(raw)}.`);
    }
    const input = raw as Record<string, unknown>;
    if (o.strict) {
      const unknownKeys = Object.keys(input).filter((k) => !(k in shape));
      if (unknownKeys.length) {
        return fail(path ? `${path}.${unknownKeys[0]}` : unknownKeys[0], `Received unknown parameter: ${unknownKeys[0]}.`, { unknown: unknownKeys });
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(shape)) {
      const child = path ? `${path}.${k}` : k;
      const node = val.describe();
      if (!(k in input) || input[k] === undefined) {
        if (node.optional) { const parsed = val.parse(undefined, child); if (parsed !== undefined) out[k] = parsed; continue; }
        if (node.type === 'object' && node.format === 'metadata') { out[k] = {}; continue; }
        return fail(child, `Missing required parameter: ${k}.`);
      }
      out[k] = val.parse(input[k], child);
    }
    return out as ShapeOf<S>;
  });
};

export const union = <T extends readonly Validator<any>[]>(...options: T): Validator<Infer<T[number]>> =>
  make<Infer<T[number]>>({ type: 'union', fields: Object.fromEntries(options.map((o, i) => [String(i), o.describe()])) }, (raw, path) => {
    const errors: string[] = [];
    for (const opt of options) {
      try { return opt.parse(raw, path); }
      catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
    }
    return fail(path, `Value did not match any accepted shape.`, { tried: errors });
  });

/** Discriminated union keyed on a literal field — produces a precise error. */
export const variant = <K extends string>(key: K, map: Record<string, Validator<any>>): Validator<any> =>
  make<any>({ type: 'variant', fields: map ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.describe()])) : {} }, (raw, path) => {
    if (typeof raw !== 'object' || raw === null) return fail(path, `Expected an object, received ${typeName(raw)}.`);
    const tag = (raw as any)[key];
    const chosen = typeof tag === 'string' ? map[tag] : undefined;
    if (!chosen) return fail(path ? `${path}.${key}` : key, `Must be one of: ${Object.keys(map).join(', ')}.`, { allowed: Object.keys(map) });
    return chosen.parse(raw, path);
  });

export const refine = <T>(inner: Validator<T>, check: (value: T) => true | string): Validator<T> =>
  make<T>(inner.describe(), (raw, path) => {
    const value = inner.parse(raw, path);
    const result = check(value);
    if (result !== true) return fail(path, result);
    return value;
  });

export const transform = <T, U>(inner: Validator<T>, fn: (value: T) => U, node?: Partial<SchemaNode>): Validator<U> =>
  make<U>({ ...inner.describe(), ...node }, (raw, path) => fn(inner.parse(raw, path)));

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  const t = typeof v;
  return t === 'undefined' ? 'nothing' : t === 'object' ? 'an object' : `a ${t}`;
}

export const v = {
  string, email, url, number, int, boolean, timestamp, currency, id, literal,
  enum: enumOf, any, json, optional, nullable, default: withDefault, array,
  record, metadata, object, union, variant, refine, transform,
};
export default v;
