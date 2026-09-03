/**
 * Exact aggregation over the CRM substrate.
 *
 * The engine never estimates. Every number it says out loud comes from one of
 * these queries against `crm_record_values` — the decomposed, typed copy of
 * every property — so a total in a sentence and the same total in a report are
 * the same SQL. Property and object names are always bound parameters, never
 * interpolated, so a hostile question cannot reach the query planner.
 */
import type { Ctx } from '../kernel/context';
import { parseJson } from '../kernel/db';
import { hasTable } from './grounding';
import { bucketKey, type WindowGrain } from './dates';

export type ConditionOp =
  | 'eq' | 'neq' | 'in' | 'not_in' | 'gte' | 'gt' | 'lte' | 'lt' | 'is_set' | 'is_not_set' | 'contains' | 'has';

export interface Condition {
  property: string;
  op: ConditionOp;
  value?: string | number | boolean;
  values?: (string | number)[];
}

export type MeasureFn = 'sum' | 'avg' | 'min' | 'max' | 'count';

export interface AggregateSpec {
  objectType: string;
  conditions?: Condition[];
  /** Restrict to records whose date property falls inside [start, end). */
  window?: { property: string; start: number; end: number };
  measure?: { property: string; fn: Exclude<MeasureFn, 'count'> };
  groupBy?: string;
  groupByDate?: { property: string; grain: WindowGrain };
  /** Only records associated with this record id (any association type). */
  associatedTo?: string;
  /**
   * Only records associated with *one of* these record ids.
   *
   * A dimension can narrow a table the answer does not measure: "how much open
   * pipeline is with pharmaceutical companies" filters companies and sums
   * deals. Without a set-shaped association filter the industry could only be
   * waived, and it was dropped in silence instead — $308,880 stated for a set
   * worth $849,660.
   */
  associatedToAny?: string[];
  /** Only records owned by this teammate. */
  ownerId?: string;
  groupLimit?: number;
  sampleIds?: number;
}

export interface AggregateGroup {
  key: string;
  value: number;
  count: number;
}

export interface AggregateResult {
  /** The measure, or the record count when no measure was asked for. */
  value: number;
  count: number;
  groups: AggregateGroup[];
  ids: string[];
  sql: string;
}

interface Fragment { sql: string; params: unknown[] }

const NUMERIC_OPS = new Set<ConditionOp>(['gte', 'gt', 'lte', 'lt']);

function conditionFragment(c: Condition): Fragment {
  const params: unknown[] = [c.property];
  const numeric = typeof c.value === 'number' || (c.values ?? []).every((v) => typeof v === 'number');
  const column = numeric && (NUMERIC_OPS.has(c.op) || typeof c.value === 'number') ? 'value_number' : 'value_text';
  switch (c.op) {
    case 'is_set':
      return { sql: `EXISTS (SELECT 1 FROM crm_record_values x WHERE x.record_id = r.id AND x.property = ? AND (x.value_text IS NOT NULL OR x.value_number IS NOT NULL OR x.value_date IS NOT NULL))`, params };
    case 'is_not_set':
      return { sql: `NOT EXISTS (SELECT 1 FROM crm_record_values x WHERE x.record_id = r.id AND x.property = ? AND (x.value_text IS NOT NULL OR x.value_number IS NOT NULL OR x.value_date IS NOT NULL))`, params };
    case 'in':
    case 'not_in': {
      const values = c.values ?? [];
      if (!values.length) return { sql: c.op === 'in' ? '0 = 1' : '1 = 1', params: [] };
      const holes = values.map(() => '?').join(', ');
      const negate = c.op === 'not_in' ? 'NOT ' : '';
      return {
        sql: `${negate}EXISTS (SELECT 1 FROM crm_record_values x WHERE x.record_id = r.id AND x.property = ? AND x.${column} IN (${holes}))`,
        params: [...params, ...values],
      };
    }
    case 'neq':
      return {
        sql: `NOT EXISTS (SELECT 1 FROM crm_record_values x WHERE x.record_id = r.id AND x.property = ? AND x.${column} = ?)`,
        params: [...params, c.value ?? null],
      };
    // A multi-select column holds every value of one record in one cell, wrapped
    // in separators — `;siemens;fanuc;`. Equality against it matches nothing, so
    // "how many companies run Siemens controls?" came back as a confident zero
    // for 24 accounts that do. This is membership, not equality.
    case 'has':
      return {
        sql: `EXISTS (SELECT 1 FROM crm_record_values x WHERE x.record_id = r.id AND x.property = ? AND x.value_text LIKE ? ESCAPE '\\')`,
        params: [...params, `%;${String(c.value ?? '').toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)};%`],
      };
    case 'contains':
      return {
        sql: `EXISTS (SELECT 1 FROM crm_record_values x WHERE x.record_id = r.id AND x.property = ? AND x.value_text LIKE ? ESCAPE '\\')`,
        params: [...params, `%${String(c.value ?? '').toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`],
      };
    default: {
      const operator = { eq: '=', gte: '>=', gt: '>', lte: '<=', lt: '<' }[c.op];
      return {
        sql: `EXISTS (SELECT 1 FROM crm_record_values x WHERE x.record_id = r.id AND x.property = ? AND x.${column} ${operator} ?)`,
        params: [...params, c.value ?? null],
      };
    }
  }
}

/** `created` and `updated` live on the record itself, not in the value table. */
const isRecordDate = (property: string): boolean => property === 'created' || property === 'updated';

function windowFragment(w: { property: string; start: number; end: number }): Fragment {
  if (isRecordDate(w.property)) {
    return { sql: `r.${w.property} >= ? AND r.${w.property} < ?`, params: [w.start, w.end] };
  }
  return {
    sql: `EXISTS (SELECT 1 FROM crm_record_values w WHERE w.record_id = r.id AND w.property = ? AND w.value_date >= ? AND w.value_date < ?)`,
    params: [w.property, w.start, w.end],
  };
}

const GRAIN_FORMAT: Record<string, string> = {
  day: '%Y-%m-%d', month: '%Y-%m', quarter: '%Y-%m', year: '%Y', week: '%Y-%W', range: '%Y-%m',
};

/** One aggregation, one round trip, exact to the cent. */
export function aggregate(ctx: Ctx, orgId: string, spec: AggregateSpec): AggregateResult {
  if (!hasTable(ctx.db, 'crm_records')) return { value: 0, count: 0, groups: [], ids: [], sql: '' };

  const where: string[] = [`r.org_id = ?`, `r.object_type = ?`, `r.archived = 0`, `r.merged_into IS NULL`];
  const params: unknown[] = [orgId, spec.objectType];

  for (const condition of spec.conditions ?? []) {
    const fragment = conditionFragment(condition);
    where.push(fragment.sql);
    params.push(...fragment.params);
  }
  if (spec.window) {
    const fragment = windowFragment(spec.window);
    where.push(fragment.sql);
    params.push(...fragment.params);
  }
  if (spec.associatedTo) {
    where.push(`EXISTS (SELECT 1 FROM crm_associations a WHERE a.org_id = ? AND ((a.from_id = ? AND a.to_id = r.id) OR (a.to_id = ? AND a.from_id = r.id)))`);
    params.push(orgId, spec.associatedTo, spec.associatedTo);
  }
  if (spec.associatedToAny?.length) {
    const holes = spec.associatedToAny.map(() => '?').join(', ');
    where.push(`EXISTS (SELECT 1 FROM crm_associations a WHERE a.org_id = ? AND ((a.to_id = r.id AND a.from_id IN (${holes})) OR (a.from_id = r.id AND a.to_id IN (${holes}))))`);
    params.push(orgId, ...spec.associatedToAny, ...spec.associatedToAny);
  }
  if (spec.ownerId) { where.push(`r.owner_id = ?`); params.push(spec.ownerId); }

  const joins: string[] = [];
  const joinParams: unknown[] = [];
  let measureExpr = 'COUNT(DISTINCT r.id)';
  if (spec.measure) {
    joins.push(`LEFT JOIN crm_record_values m ON m.record_id = r.id AND m.property = ?`);
    joinParams.push(spec.measure.property);
    measureExpr = `${spec.measure.fn.toUpperCase()}(m.value_number)`;
  }

  let groupExpr: string | null = null;
  if (spec.groupByDate) {
    const format = GRAIN_FORMAT[spec.groupByDate.grain] ?? '%Y-%m';
    if (isRecordDate(spec.groupByDate.property)) {
      groupExpr = `strftime('${format}', r.${spec.groupByDate.property} / 1000, 'unixepoch')`;
    } else {
      joins.push(`LEFT JOIN crm_record_values g ON g.record_id = r.id AND g.property = ?`);
      joinParams.push(spec.groupByDate.property);
      groupExpr = `strftime('${format}', g.value_date / 1000, 'unixepoch')`;
    }
  } else if (spec.groupBy) {
    joins.push(`LEFT JOIN crm_record_values g ON g.record_id = r.id AND g.property = ?`);
    joinParams.push(spec.groupBy);
    groupExpr = `COALESCE(g.value_text, CAST(g.value_number AS TEXT), '—')`;
  }

  const whereSql = where.join(' AND ');
  const joinSql = joins.join(' ');
  const totalSql = `SELECT ${measureExpr} AS v, COUNT(DISTINCT r.id) AS n FROM crm_records r ${joinSql} WHERE ${whereSql}`;
  const total = ctx.db.get<{ v: number | null; n: number }>(totalSql, ...(joinParams as never[]), ...(params as never[]));

  let groups: AggregateGroup[] = [];
  if (groupExpr) {
    const groupSql =
      `SELECT ${groupExpr} AS k, ${measureExpr} AS v, COUNT(DISTINCT r.id) AS n FROM crm_records r ${joinSql} ` +
      `WHERE ${whereSql} GROUP BY k ORDER BY v DESC LIMIT ?`;
    groups = ctx.db.all<{ k: string | null; v: number | null; n: number }>(
      groupSql, ...(joinParams as never[]), ...(params as never[]), spec.groupLimit ?? 12,
    ).map((row) => ({ key: row.k ?? '—', value: Number(row.v ?? 0), count: Number(row.n ?? 0) }));
    if (spec.groupByDate) groups.sort((a, b) => a.key.localeCompare(b.key));
  }

  const ids = spec.sampleIds
    ? ctx.db.all<{ id: string }>(
        `SELECT DISTINCT r.id FROM crm_records r ${joinSql} WHERE ${whereSql} ORDER BY r.updated DESC LIMIT ?`,
        ...(joinParams as never[]), ...(params as never[]), spec.sampleIds,
      ).map((row) => row.id)
    : [];

  return {
    value: Number(total?.v ?? 0),
    count: Number(total?.n ?? 0),
    groups,
    ids,
    sql: totalSql,
  };
}

export interface RecordSummary {
  id: string;
  object_type: string;
  display_name: string;
  owner_id: string | null;
  created: number;
  updated: number;
  properties: Record<string, unknown>;
}

/** Fetch records matching a spec, newest first — the evidence behind a number. */
export function fetchRecords(
  ctx: Ctx,
  orgId: string,
  spec: AggregateSpec & { limit?: number; orderBy?: string; direction?: 'asc' | 'desc' },
): RecordSummary[] {
  if (!hasTable(ctx.db, 'crm_records')) return [];
  const where: string[] = [`r.org_id = ?`, `r.object_type = ?`, `r.archived = 0`, `r.merged_into IS NULL`];
  const params: unknown[] = [orgId, spec.objectType];
  for (const condition of spec.conditions ?? []) {
    const fragment = conditionFragment(condition);
    where.push(fragment.sql);
    params.push(...fragment.params);
  }
  if (spec.window) {
    const fragment = windowFragment(spec.window);
    where.push(fragment.sql);
    params.push(...fragment.params);
  }
  if (spec.associatedTo) {
    where.push(`EXISTS (SELECT 1 FROM crm_associations a WHERE a.org_id = ? AND ((a.from_id = ? AND a.to_id = r.id) OR (a.to_id = ? AND a.from_id = r.id)))`);
    params.push(orgId, spec.associatedTo, spec.associatedTo);
  }
  if (spec.associatedToAny?.length) {
    const holes = spec.associatedToAny.map(() => '?').join(', ');
    where.push(`EXISTS (SELECT 1 FROM crm_associations a WHERE a.org_id = ? AND ((a.to_id = r.id AND a.from_id IN (${holes})) OR (a.from_id = r.id AND a.to_id IN (${holes}))))`);
    params.push(orgId, ...spec.associatedToAny, ...spec.associatedToAny);
  }
  if (spec.ownerId) { where.push(`r.owner_id = ?`); params.push(spec.ownerId); }
  let order = 'r.updated DESC';
  const orderParams: unknown[] = [];
  if (spec.orderBy) {
    // NULLS LAST on both directions: a deal with no amount is not the smallest
    // one, and floating the rows that hold nothing to the top of an ascending
    // list is the same wrong answer as ignoring the direction outright.
    const sense = spec.direction === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS LAST';
    order = `(SELECT COALESCE(o.value_number, o.value_date) FROM crm_record_values o WHERE o.record_id = r.id AND o.property = ?) ${sense}`;
    orderParams.push(spec.orderBy);
  }
  const rows = ctx.db.all<{
    id: string; object_type: string; display_name: string; owner_id: string | null;
    created: number; updated: number; properties: string;
  }>(
    `SELECT r.id, r.object_type, r.display_name, r.owner_id, r.created, r.updated, r.properties
     FROM crm_records r WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
    ...(params as never[]), ...(orderParams as never[]), spec.limit ?? 20,
  );
  return rows.map((row) => ({
    id: row.id, object_type: row.object_type, display_name: row.display_name, owner_id: row.owner_id,
    created: row.created, updated: row.updated, properties: parseJson<Record<string, unknown>>(row.properties, {}),
  }));
}

export function getRecord(ctx: Ctx, orgId: string, id: string): RecordSummary | null {
  if (!hasTable(ctx.db, 'crm_records')) return null;
  const row = ctx.db.get<{
    id: string; object_type: string; display_name: string; owner_id: string | null;
    created: number; updated: number; properties: string;
  }>(`SELECT id, object_type, display_name, owner_id, created, updated, properties FROM crm_records WHERE org_id = ? AND id = ?`, orgId, id);
  if (!row) return null;
  return {
    id: row.id, object_type: row.object_type, display_name: row.display_name, owner_id: row.owner_id,
    created: row.created, updated: row.updated, properties: parseJson<Record<string, unknown>>(row.properties, {}),
  };
}

export interface RecordStanding {
  id: string;
  state: 'live' | 'archived' | 'merged' | 'missing';
  name: string | null;
  /** Where a merged record's history now lives. */
  mergedInto: string | null;
}

/**
 * What has become of a record id.
 *
 * An approval can sit in the queue while the record it names is archived,
 * merged away or deleted, and `getRecord` answers "does a row exist" rather
 * than "is this still a record a write may land on". Executing onto an archived
 * account writes into a timeline nobody reads.
 */
export function recordStanding(ctx: Ctx, orgId: string, id: string): RecordStanding {
  if (!hasTable(ctx.db, 'crm_records')) return { id, state: 'missing', name: null, mergedInto: null };
  const row = ctx.db.get<{ display_name: string; archived: number; merged_into: string | null }>(
    `SELECT display_name, archived, merged_into FROM crm_records WHERE org_id = ? AND id = ?`, orgId, id);
  if (!row) return { id, state: 'missing', name: null, mergedInto: null };
  if (row.merged_into) return { id, state: 'merged', name: row.display_name, mergedInto: row.merged_into };
  if (row.archived) return { id, state: 'archived', name: row.display_name, mergedInto: null };
  return { id, state: 'live', name: row.display_name, mergedInto: null };
}

/** Records associated with `recordId`, optionally of one object type. */
export function associatedRecords(ctx: Ctx, orgId: string, recordId: string, objectType?: string, limit = 50): RecordSummary[] {
  if (!hasTable(ctx.db, 'crm_associations')) return [];
  const rows = ctx.db.all<{
    id: string; object_type: string; display_name: string; owner_id: string | null;
    created: number; updated: number; properties: string;
  }>(
    `SELECT r.id, r.object_type, r.display_name, r.owner_id, r.created, r.updated, r.properties
     FROM crm_associations a
     JOIN crm_records r ON r.id = CASE WHEN a.from_id = ? THEN a.to_id ELSE a.from_id END
     WHERE a.org_id = ? AND (a.from_id = ? OR a.to_id = ?) AND r.archived = 0 AND r.merged_into IS NULL
       ${objectType ? 'AND r.object_type = ?' : ''}
     ORDER BY r.updated DESC LIMIT ?`,
    recordId, orgId, recordId, recordId, ...(objectType ? [objectType] : []), limit,
  );
  return rows.map((row) => ({
    id: row.id, object_type: row.object_type, display_name: row.display_name, owner_id: row.owner_id,
    created: row.created, updated: row.updated, properties: parseJson<Record<string, unknown>>(row.properties, {}),
  }));
}

/** Property definitions for an object type, so tools can validate arguments. */
export function propertyMap(ctx: Ctx, orgId: string, objectType: string): Map<string, { label: string; type: string; options: { value: string; label: string }[] }> {
  const out = new Map<string, { label: string; type: string; options: { value: string; label: string }[] }>();
  if (!hasTable(ctx.db, 'crm_properties')) return out;
  for (const row of ctx.db.all<{ name: string; label: string; type: string; options: string }>(
    `SELECT name, label, type, options FROM crm_properties WHERE org_id = ? AND object_type = ?`, orgId, objectType)) {
    out.set(row.name, {
      label: row.label,
      type: row.type,
      options: parseJson<{ value: string; label: string }[]>(row.options, []),
    });
  }
  return out;
}

export const objectTypeNames = (ctx: Ctx, orgId: string): string[] =>
  hasTable(ctx.db, 'crm_object_types')
    ? ctx.db.all<{ name: string }>(`SELECT name FROM crm_object_types WHERE org_id = ? ORDER BY position`, orgId).map((r) => r.name)
    : [];

export { bucketKey };
