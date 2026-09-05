/**
 * Import, the half of the CSV round trip the export copy promised.
 *
 * Everything here is pure: a header row is matched to the object's properties,
 * every cell is turned into the value the API stores for that property's type,
 * and the rows go to `POST /v1/records/:type/batch` as records. A cell that
 * cannot become a value is a named problem on a numbered row, never a silent
 * blank — the person importing 400 contacts has to know which three were not.
 */
import { parseMoney } from '../../../shared/money';
import type { BatchResult, PropertyDef, WorkspaceUser } from './api';

/** Where a column's values go: a property name, the record's id or owner, or nowhere. */
export type ImportTarget = string | 'id' | 'owner_id' | null;

export interface ImportContext {
  users: WorkspaceUser[];
  currency: string;
}

export interface ImportRecord {
  /** 1-based row number in the file, header excluded. */
  row: number;
  id?: string;
  owner_id?: string | null;
  properties: Record<string, unknown>;
}

export interface ImportProblem {
  row: number;
  column: string;
  message: string;
}

export interface ImportOutcome {
  row: number;
  status: 'created' | 'updated' | 'refused';
  display_name?: string;
  id?: string;
  /** The property the server or the mapping blamed, as its label. */
  blamed?: string;
  message?: string;
}

const normalise = (input: string): string => input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
/** "E-MAIL", "e_mail" and "email" are one header to a person. */
const squash = (input: string): string => input.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Properties a file may write to: stored values, never formulas or rollups. */
export const importableProperties = (properties: PropertyDef[]): PropertyDef[] =>
  properties.filter((p) => !p.hidden && !p.calculated && !p.rollup && !p.read_only && p.type !== 'computed');

/**
 * A header names a property by its label ("Job title"), its internal name
 * (`job_title`) or anything that slugs to it ("JOB-TITLE"). The export writes
 * labels, so a re-import maps itself; a spreadsheet someone typed the headers
 * into usually does too.
 */
export function autoMapColumns(headers: string[], properties: PropertyDef[]): ImportTarget[] {
  const targets = importableProperties(properties);
  const byName = new Map(targets.map((p) => [p.name, p.name]));
  const byLabel = new Map(targets.map((p) => [normalise(p.label), p.name]));
  const bySquash = new Map([...targets.map((p) => [squash(p.label), p.name] as const), ...targets.map((p) => [squash(p.name), p.name] as const)]);
  const taken = new Set<string>();
  return headers.map((header) => {
    const key = normalise(header);
    let target: ImportTarget = null;
    if (key === 'id' || key === 'record_id') target = 'id';
    else if (key === 'owner' || key === 'owner_id' || key === 'record_owner') target = 'owner_id';
    else target = byName.get(key) ?? byLabel.get(key) ?? bySquash.get(squash(header)) ?? null;
    if (target && taken.has(target)) return null;
    if (target) taken.add(target);
    return target;
  });
}

export type Coerced = { ok: true; value: unknown } | { ok: false; message: string };

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'on']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off']);

const matchOption = (property: PropertyDef, raw: string): string | null => {
  const wanted = raw.trim().toLowerCase();
  const hit = property.options.find((o) => o.value.toLowerCase() === wanted || o.label.toLowerCase() === wanted);
  return hit ? hit.value : null;
};

/** The value the API stores for one cell, or why the cell cannot become one. */
export function coerceImportValue(property: PropertyDef, raw: string, ctx: ImportContext): Coerced {
  const text = raw.trim();
  if (text === '') return { ok: true, value: undefined };
  switch (property.type) {
    case 'number': {
      const n = Number(text.replace(/[,\s]/g, ''));
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: `"${text}" is not a number.` };
    }
    case 'currency': {
      try {
        return { ok: true, value: parseMoney(text, property.currency ?? ctx.currency).amount };
      } catch {
        return { ok: false, message: `"${text}" is not an amount. Write money as a decimal, like 1250.00.` };
      }
    }
    case 'bool': {
      const word = text.toLowerCase();
      if (TRUE_WORDS.has(word)) return { ok: true, value: true };
      if (FALSE_WORDS.has(word)) return { ok: true, value: false };
      return { ok: false, message: `"${text}" is not yes or no.` };
    }
    case 'date':
    case 'datetime': {
      const ts = /^\d{12,13}$/.test(text) ? Number(text) : Date.parse(text);
      return Number.isFinite(ts)
        ? { ok: true, value: ts }
        : { ok: false, message: `"${text}" is not a date. ISO-8601 (2026-05-14 or 2026-05-14T09:30:00Z) is safest.` };
    }
    case 'enum': {
      if (!property.options.length) return { ok: true, value: text };
      const value = matchOption(property, text);
      return value !== null
        ? { ok: true, value }
        : { ok: false, message: `"${text}" is not one of ${property.label}'s options (${property.options.map((o) => o.label).join(', ')}).` };
    }
    case 'multi_enum': {
      const parts = text.split(/[;|]/).map((part) => part.trim()).filter(Boolean);
      if (!property.options.length) return { ok: true, value: parts };
      const values: string[] = [];
      for (const part of parts) {
        const value = matchOption(property, part);
        if (value === null) return { ok: false, message: `"${part}" is not one of ${property.label}'s options.` };
        values.push(value);
      }
      return { ok: true, value: [...new Set(values)] };
    }
    case 'user': {
      const id = resolveUser(text, ctx.users);
      return id ? { ok: true, value: id } : { ok: false, message: `No teammate called "${text}". Use their name, email or user id.` };
    }
    case 'json': {
      try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, message: `"${text}" is not valid JSON.` }; }
    }
    default:
      return { ok: true, value: text };
  }
}

export function resolveUser(raw: string, users: WorkspaceUser[]): string | null {
  const wanted = raw.trim().toLowerCase();
  if (!wanted) return null;
  const hit = users.find((u) => u.id.toLowerCase() === wanted || u.email.toLowerCase() === wanted || u.name.toLowerCase() === wanted);
  return hit?.id ?? null;
}

export interface BuiltImport {
  records: ImportRecord[];
  problems: ImportProblem[];
  /** Rows dropped before the request: every cell in them failed to map. */
  skipped: number;
}

/**
 * File rows → API records. A row with a problem in any mapped cell is held
 * back and reported, so a batch never half-writes a record whose email was
 * unreadable but whose name was fine.
 */
export function buildImportRows(
  rows: string[][],
  headers: string[],
  mapping: ImportTarget[],
  properties: PropertyDef[],
  ctx: ImportContext,
): BuiltImport {
  const index = new Map(properties.map((p) => [p.name, p]));
  const records: ImportRecord[] = [];
  const problems: ImportProblem[] = [];
  let skipped = 0;
  rows.forEach((cells, i) => {
    const row = i + 1;
    const record: ImportRecord = { row, properties: {} };
    let bad = false;
    let any = false;
    mapping.forEach((target, column) => {
      if (!target) return;
      const raw = (cells[column] ?? '').trim();
      if (raw === '') return;
      any = true;
      if (target === 'id') { record.id = raw; return; }
      if (target === 'owner_id') {
        const id = resolveUser(raw, ctx.users);
        if (!id) { problems.push({ row, column: headers[column], message: `No teammate called "${raw}". Use their name, email or user id.` }); bad = true; return; }
        record.owner_id = id;
        return;
      }
      const property = index.get(target);
      if (!property) return;
      const coerced = coerceImportValue(property, raw, ctx);
      if (!coerced.ok) { problems.push({ row, column: headers[column], message: coerced.message }); bad = true; return; }
      if (coerced.value !== undefined) record.properties[property.name] = coerced.value;
    });
    if (!any) { skipped++; return; }
    if (!bad) records.push(record);
  });
  return { records, problems, skipped };
}

/** `records[3].properties.email` → the property's label, for the result table. */
export function blamedLabel(param: string | undefined, properties: PropertyDef[]): string | undefined {
  if (!param) return undefined;
  const match = /\.properties\.([a-z0-9_]+)$/i.exec(param) ?? /^properties\.([a-z0-9_]+)$/i.exec(param);
  if (match) return properties.find((p) => p.name === match[1])?.label ?? match[1];
  if (/\.id$/.test(param)) return 'Record id';
  if (/owner_id$/.test(param)) return 'Owner';
  return undefined;
}

/** The server's per-row results, re-keyed to the file's row numbers. */
export function outcomesFrom(sent: ImportRecord[], result: BatchResult, properties: PropertyDef[]): ImportOutcome[] {
  return result.results.map((entry) => {
    const record = sent[entry.index];
    const row = record?.row ?? entry.index + 1;
    if (entry.status === 'error') {
      return { row, status: 'refused', blamed: blamedLabel(entry.error?.param, properties), message: entry.error?.message };
    }
    return { row, status: entry.status, id: entry.id, display_name: entry.display_name };
  });
}

export const IMPORT_BATCH_SIZE = 500;

export function chunk<T>(items: T[], size = IMPORT_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
