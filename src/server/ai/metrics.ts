/**
 * The metric catalogue.
 *
 * Every question that ends in a number resolves to exactly one definition here,
 * and every definition states where its number came from — "9 paid invoices",
 * "14 closed-won deals" — so an answer can always be audited back to rows. When
 * a source is missing (billing not installed in this workspace), the metric
 * says so and offers the nearest honest substitute instead of guessing.
 */
import type { Ctx } from '../kernel/context';
import { formatMoney } from '../../shared/money';
import { DAY, formatDate } from '../../shared/time';
import { billingSources, schemaOf, type WorkspaceProfile } from './grounding';
import { aggregate, associatedRecords, fetchRecords, getRecord, type AggregateResult, type Condition } from './query';
import { bucketGrain, type TimeWindow } from './dates';
import { humanise, normalise } from './text';

export type MetricUnit = 'money' | 'count' | 'percent' | 'days' | 'hours' | 'score';
export type GroupBy = 'time' | 'owner' | 'stage' | 'industry' | 'account' | 'status' | 'priority' | 'source' | 'none';

export interface MetricSubject {
  id: string;
  type: string;
  label: string;
}

export interface MetricInput {
  ctx: Ctx;
  workspace: WorkspaceProfile;
  window: TimeWindow;
  subject?: MetricSubject | null;
  groupBy?: GroupBy;
  limit?: number;
}

export interface MetricGroup {
  key: string;
  label: string;
  value: number;
  count: number;
  formatted: string;
}

export interface MetricResult {
  metric: string;
  label: string;
  unit: MetricUnit;
  value: number;
  formatted: string;
  currency: string | null;
  /** Rows behind the number. */
  count: number;
  source: string;
  sourceKind: 'invoices' | 'subscriptions' | 'deals' | 'tickets' | 'activities' | 'records' | 'unavailable';
  window: TimeWindow;
  subject: MetricSubject | null;
  groups: MetricGroup[];
  ids: string[];
  /** Set when the metric had to substitute a source, or is a snapshot. */
  note: string | null;
  /** True for "right now" metrics such as open pipeline, which ignore the period. */
  snapshot: boolean;
  /** Same metric over the preceding window, when a like-for-like exists. */
  previous?: { value: number; formatted: string } | null;
}

export interface MetricDefinition {
  id: string;
  label: string;
  unit: MetricUnit;
  /** Phrases that select this metric, strongest first. */
  patterns: RegExp[];
  keywords: string[];
  supportsSubject: boolean;
  /** A snapshot metric ignores the window and reports "as of now". */
  snapshot?: boolean;
  compute(input: MetricInput): MetricResult;
}

/* -------------------------------- helpers -------------------------------- */

const money = (amount: number, workspace: WorkspaceProfile) =>
  formatMoney({ amount: Math.round(amount), currency: workspace.currency }, { locale: workspace.locale, trimZeroFraction: true });

const formatValue = (value: number, unit: MetricUnit, workspace: WorkspaceProfile): string => {
  switch (unit) {
    case 'money': return money(value, workspace);
    case 'percent': return `${Number(value.toFixed(1))}%`;
    case 'days': return `${Number(value.toFixed(1))} ${value === 1 ? 'day' : 'days'}`;
    case 'hours': return `${Number(value.toFixed(1))} ${value === 1 ? 'hour' : 'hours'}`;
    case 'score': return value.toFixed(2);
    default: return Math.round(value).toLocaleString(workspace.locale);
  }
};

function groupsFrom(result: AggregateResult, unit: MetricUnit, workspace: WorkspaceProfile, labeller?: (key: string) => string): MetricGroup[] {
  return result.groups
    .filter((g) => g.count > 0)
    .map((g) => ({
      key: g.key,
      label: labeller ? labeller(g.key) : humanise(g.key),
      value: g.value,
      count: g.count,
      formatted: formatValue(g.value, unit, workspace),
    }));
}

const FALLBACK_OPEN_STAGES = ['qualification', 'discovery', 'technical_validation', 'proposal', 'negotiation'];
const OPEN_TICKET_STATUSES = ['new', 'waiting_on_us', 'waiting_on_customer', 'escalated'];

export interface StageSets { open: string[]; won: string[]; lost: string[] }

const stageCache = new WeakMap<object, Map<string, { stamp: number; sets: StageSets }>>();

/**
 * Which deal stages count as open, won and lost.
 *
 * Read from the pipeline definition when the CRM publishes one, so renaming or
 * adding a stage never silently drops deals out of a total; the built-in stage
 * names are only a fallback for a workspace that has no pipeline table.
 */
export function stageSets(ctx: Ctx, orgId: string): StageSets {
  let byOrg = stageCache.get(ctx.db);
  if (!byOrg) { byOrg = new Map(); stageCache.set(ctx.db, byOrg); }
  const schema = schemaOf(ctx.db);
  const stamp = schema.tables.size;
  const cached = byOrg.get(orgId);
  if (cached && cached.stamp === stamp) return cached.sets;

  const table = [...schema.tables.keys()].find((name) => /pipeline_stage/.test(name));
  const columns = table ? schema.tables.get(table)! : null;
  let sets: StageSets = { open: FALLBACK_OPEN_STAGES, won: ['closed_won'], lost: ['closed_lost'] };

  if (table && columns?.has('name') && columns.has('is_closed') && columns.has('is_won')) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (columns.has('org_id')) { where.push('org_id = ?'); params.push(orgId); }
    if (columns.has('object_type')) { where.push(`object_type = 'deal'`); }
    const rows = ctx.db.all<{ name: string; is_closed: number; is_won: number }>(
      `SELECT name, is_closed, is_won FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      ...(params as never[]),
    );
    if (rows.length) {
      // Several pipelines share stage names; the set is what matters.
      const names = (test: (row: { is_closed: number; is_won: number }) => boolean) =>
        [...new Set(rows.filter(test).map((r) => r.name))];
      sets = {
        open: names((r) => !r.is_closed),
        won: names((r) => !!r.is_closed && !!r.is_won),
        lost: names((r) => !!r.is_closed && !r.is_won),
      };
      if (!sets.open.length) sets.open = FALLBACK_OPEN_STAGES;
      if (!sets.won.length) sets.won = ['closed_won'];
      if (!sets.lost.length) sets.lost = ['closed_lost'];
    }
  }
  byOrg.set(orgId, { stamp, sets });
  return sets;
}

/** Deals attached to the subject account, when the question named one. */
function subjectScope(input: MetricInput): { associatedTo?: string } {
  const subject = input.subject;
  if (!subject) return {};
  if (subject.type === 'company' || subject.type === 'contact' || subject.type === 'customer') {
    return { associatedTo: subject.id };
  }
  return {};
}

function ownerLabeller(input: MetricInput): (key: string) => string {
  const byId = new Map(input.workspace.people.map((p) => [p.id, p.name]));
  return (key) => byId.get(key) ?? humanise(key);
}

function timeLabeller(): (key: string) => string {
  return (key) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return formatDate(Date.parse(`${key}T00:00:00Z`), { timeZone: 'UTC' });
    if (/^\d{4}-\d{2}$/.test(key)) return formatDate(Date.parse(`${key}-01T00:00:00Z`), { timeZone: 'UTC' }).replace(/\s\d+,/, '');
    return key;
  };
}

function groupSpec(input: MetricInput, dateProperty: string): Partial<Parameters<typeof aggregate>[2]> {
  switch (input.groupBy) {
    case 'time': return { groupByDate: { property: dateProperty, grain: bucketGrain(input.window) } };
    case 'owner': return {};
    case 'stage': return { groupBy: 'deal_stage' };
    case 'industry': return { groupBy: 'industry' };
    case 'status': return { groupBy: 'status' };
    case 'priority': return { groupBy: 'priority' };
    case 'source': return { groupBy: 'lead_source' };
    default: return {};
  }
}

/**
 * Owners live on the record row, not in a property, so "by rep" needs its own
 * query rather than the generic group-by.
 */
function groupByOwner(ctx: Ctx, orgId: string, objectType: string, conditions: Condition[], window: { property: string; start: number; end: number } | undefined, measure: { property: string; fn: 'sum' } | undefined, workspace: WorkspaceProfile, unit: MetricUnit, associatedTo?: string): MetricGroup[] {
  const rows = fetchRecords(ctx, orgId, { objectType, conditions, window, associatedTo, limit: 500 });
  const byOwner = new Map<string, { value: number; count: number }>();
  for (const row of rows) {
    const key = row.owner_id ?? 'unassigned';
    const entry = byOwner.get(key) ?? { value: 0, count: 0 };
    entry.count += 1;
    entry.value += measure ? Number(row.properties[measure.property] ?? 0) : 1;
    byOwner.set(key, entry);
  }
  const names = new Map(workspace.people.map((p) => [p.id, p.name]));
  return [...byOwner.entries()]
    .map(([key, v]) => ({ key, label: names.get(key) ?? 'Unassigned', value: v.value, count: v.count, formatted: formatValue(v.value, unit, workspace) }))
    .sort((a, b) => b.value - a.value);
}

/* ------------------------------ money sources ----------------------------- */

export interface InvoiceFacts {
  available: boolean;
  total: number;
  count: number;
  ids: string[];
  groups: { key: string; value: number; count: number }[];
  label: string;
}

/** Map a CRM company (or contact) onto the billing module's customer rows. */
export function linkedCustomerIds(ctx: Ctx, orgId: string, subject: MetricSubject | null | undefined): string[] {
  const sources = billingSources(ctx.db);
  if (!sources.customers || !subject) return [];
  const { table, nameColumn, emailColumn, companyColumn } = sources.customers;
  if (subject.type === 'customer') return [subject.id];
  const ids = new Set<string>();
  if (companyColumn) {
    for (const row of ctx.db.all<{ id: string }>(`SELECT id FROM ${table} WHERE org_id = ? AND ${companyColumn} = ?`, orgId, subject.id)) ids.add(row.id);
  }
  if (!ids.size && nameColumn) {
    const target = normalise(subject.label);
    for (const row of ctx.db.all<{ id: string; nm: string | null }>(`SELECT id, ${nameColumn} AS nm FROM ${table} WHERE org_id = ?`, orgId)) {
      if (row.nm && normalise(row.nm) === target) ids.add(row.id);
    }
  }
  if (!ids.size && emailColumn) {
    const record = ctx.db.get<{ properties: string }>(`SELECT properties FROM crm_records WHERE org_id = ? AND id = ?`, orgId, subject.id);
    const domain = record ? String(JSON.parse(record.properties || '{}').domain ?? '') : '';
    if (domain) {
      for (const row of ctx.db.all<{ id: string; em: string | null }>(`SELECT id, ${emailColumn} AS em FROM ${table} WHERE org_id = ?`, orgId)) {
        if (row.em && row.em.toLowerCase().endsWith(`@${domain.toLowerCase()}`)) ids.add(row.id);
      }
    }
  }
  return [...ids];
}

/** Sum invoices from whichever billing schema this workspace actually has. */
export function invoiceFacts(input: MetricInput, opts: { paidOnly?: boolean; outstanding?: boolean } = {}): InvoiceFacts {
  const { ctx, workspace, window, subject } = input;
  const sources = billingSources(ctx.db);
  const invoices = sources.invoices;
  if (!invoices) return { available: false, total: 0, count: 0, ids: [], groups: [], label: 'no invoice table in this workspace' };

  const amountColumn = opts.paidOnly && invoices.paidColumn ? invoices.paidColumn : invoices.amountColumn;
  const where: string[] = [`org_id = ?`, `${invoices.dateColumn} >= ?`, `${invoices.dateColumn} < ?`];
  const params: unknown[] = [workspace.orgId, window.start, window.end];

  if (invoices.statusColumn) {
    if (opts.outstanding) { where.push(`${invoices.statusColumn} IN ('open', 'past_due', 'unpaid', 'uncollectible')`); }
    else if (opts.paidOnly) { where.push(`${invoices.statusColumn} = 'paid'`); }
    else { where.push(`${invoices.statusColumn} NOT IN ('draft', 'void', 'deleted')`); }
  }
  const customerIds = linkedCustomerIds(ctx, workspace.orgId, subject);
  if (subject && invoices.customerColumn) {
    if (!customerIds.length) return { available: true, total: 0, count: 0, ids: [], groups: [], label: `${subject.label} has no billing account` };
    where.push(`${invoices.customerColumn} IN (${customerIds.map(() => '?').join(', ')})`);
    params.push(...customerIds);
  }

  const whereSql = where.join(' AND ');
  const total = ctx.db.get<{ v: number | null; n: number }>(
    `SELECT SUM(${amountColumn}) AS v, COUNT(*) AS n FROM ${invoices.table} WHERE ${whereSql}`, ...(params as never[]));
  const ids = ctx.db.all<{ id: string }>(
    `SELECT id FROM ${invoices.table} WHERE ${whereSql} ORDER BY ${invoices.dateColumn} DESC LIMIT 8`, ...(params as never[])).map((r) => r.id);

  let groups: { key: string; value: number; count: number }[] = [];
  if (input.groupBy === 'time') {
    const format = bucketGrain(window) === 'day' ? '%Y-%m-%d' : bucketGrain(window) === 'year' ? '%Y' : '%Y-%m';
    groups = ctx.db.all<{ k: string; v: number | null; n: number }>(
      `SELECT strftime('${format}', ${invoices.dateColumn} / 1000, 'unixepoch') AS k, SUM(${amountColumn}) AS v, COUNT(*) AS n
       FROM ${invoices.table} WHERE ${whereSql} GROUP BY k ORDER BY k`, ...(params as never[]),
    ).map((r) => ({ key: r.k, value: Number(r.v ?? 0), count: r.n }));
  } else if (input.groupBy === 'account' && invoices.customerColumn) {
    groups = ctx.db.all<{ k: string; v: number | null; n: number }>(
      `SELECT ${invoices.customerColumn} AS k, SUM(${amountColumn}) AS v, COUNT(*) AS n
       FROM ${invoices.table} WHERE ${whereSql} GROUP BY k ORDER BY v DESC LIMIT 12`, ...(params as never[]),
    ).map((r) => ({ key: r.k, value: Number(r.v ?? 0), count: r.n }));
  } else if (input.groupBy === 'status' && invoices.statusColumn) {
    groups = ctx.db.all<{ k: string; v: number | null; n: number }>(
      `SELECT ${invoices.statusColumn} AS k, SUM(${amountColumn}) AS v, COUNT(*) AS n
       FROM ${invoices.table} WHERE ${whereSql} GROUP BY k ORDER BY v DESC`, ...(params as never[]),
    ).map((r) => ({ key: r.k, value: Number(r.v ?? 0), count: r.n }));
  }

  const kind = opts.outstanding ? 'outstanding' : opts.paidOnly ? 'paid' : 'issued';
  return {
    available: true,
    total: Number(total?.v ?? 0),
    count: Number(total?.n ?? 0),
    ids,
    groups,
    label: `${total?.n ?? 0} ${kind} ${Number(total?.n ?? 0) === 1 ? 'invoice' : 'invoices'}`,
  };
}

function result(input: MetricInput, def: Pick<MetricDefinition, 'id' | 'label' | 'unit'> & { snapshot?: boolean }, fields: {
  value: number; count: number; source: string; sourceKind: MetricResult['sourceKind'];
  groups?: MetricGroup[]; ids?: string[]; note?: string | null;
}): MetricResult {
  return {
    metric: def.id,
    label: def.label,
    unit: def.unit,
    value: fields.value,
    formatted: formatValue(fields.value, def.unit, input.workspace),
    currency: def.unit === 'money' ? input.workspace.currency : null,
    count: fields.count,
    source: fields.source,
    sourceKind: fields.sourceKind,
    window: input.window,
    subject: input.subject ?? null,
    groups: fields.groups ?? [],
    ids: fields.ids ?? [],
    note: fields.note ?? null,
    snapshot: !!(def as { snapshot?: boolean }).snapshot,
  };
}

/* ------------------------------- definitions ------------------------------ */

function moneyIn(input: MetricInput, opts: { paidOnly?: boolean; outstanding?: boolean }, def: Pick<MetricDefinition, 'id' | 'label' | 'unit'>): MetricResult {
  const invoices = invoiceFacts(input, opts);
  if (invoices.available) {
    return result(input, def, {
      value: invoices.total,
      count: invoices.count,
      source: invoices.label,
      sourceKind: 'invoices',
      ids: invoices.ids,
      groups: invoices.groups.map((g) => ({
        key: g.key,
        label: input.groupBy === 'time' ? timeLabeller()(g.key) : humanise(g.key),
        value: g.value,
        count: g.count,
        formatted: money(g.value, input.workspace),
      })),
    });
  }
  // No billing tables: closed-won deals are the honest stand-in, and we say so.
  const scope = subjectScope(input);
  const conditions: Condition[] = [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).won }];
  const agg = aggregate(input.ctx, input.workspace.orgId, {
    objectType: 'deal',
    conditions,
    window: { property: 'close_date', start: input.window.start, end: input.window.end },
    measure: { property: 'amount', fn: 'sum' },
    sampleIds: 8,
    ...scope,
    ...groupSpec(input, 'close_date'),
  });
  const groups = input.groupBy === 'owner'
    ? groupByOwner(input.ctx, input.workspace.orgId, 'deal', conditions, { property: 'close_date', start: input.window.start, end: input.window.end }, { property: 'amount', fn: 'sum' }, input.workspace, 'money', scope.associatedTo)
    : groupsFrom(agg, 'money', input.workspace, input.groupBy === 'time' ? timeLabeller() : undefined);
  return result(input, def, {
    value: agg.value,
    count: agg.count,
    source: `${agg.count} closed-won ${agg.count === 1 ? 'deal' : 'deals'}`,
    sourceKind: 'deals',
    ids: agg.ids,
    groups,
    note: 'Measured from closed-won deals: this workspace has no invoice ledger installed.',
  });
}

const DEFS: MetricDefinition[] = [
  {
    id: 'spend', label: 'Customer spend', unit: 'money', supportsSubject: true,
    patterns: [/\b(spend|spent|spending)\b/i, /\bpaid\s+us\b/i, /\brevenue\s+from\b/i, /\bbilled\s+(?:to|for)\b/i],
    keywords: ['spend', 'spent', 'paid', 'billed'],
    compute: (input) => moneyIn(input, { paidOnly: true }, { id: 'spend', label: 'Customer spend', unit: 'money' }),
  },
  {
    id: 'revenue', label: 'Revenue', unit: 'money', supportsSubject: true,
    patterns: [/\b(revenue|billings?|income|collected|top\s?line)\b/i, /\bhow\s+much\s+(?:did\s+we\s+)?(?:make|earn|collect)\b/i],
    keywords: ['revenue', 'billings', 'collected'],
    compute: (input) => moneyIn(input, { paidOnly: true }, { id: 'revenue', label: 'Revenue', unit: 'money' }),
  },
  {
    id: 'invoiced', label: 'Invoiced', unit: 'money', supportsSubject: true,
    patterns: [/\binvoiced?\b/i, /\bissued\s+invoices?\b/i],
    keywords: ['invoiced', 'invoices'],
    compute: (input) => moneyIn(input, {}, { id: 'invoiced', label: 'Invoiced', unit: 'money' }),
  },
  {
    id: 'outstanding', label: 'Outstanding balance', unit: 'money', supportsSubject: true,
    patterns: [/\b(outstanding|unpaid|past\s+due|overdue|owed?|receivables?|ar\s+balance)\b/i],
    keywords: ['outstanding', 'overdue', 'unpaid'],
    compute: (input) => moneyIn(input, { outstanding: true }, { id: 'outstanding', label: 'Outstanding balance', unit: 'money' }),
  },
  {
    id: 'pipeline', label: 'Open pipeline', unit: 'money', supportsSubject: true, snapshot: true,
    patterns: [/\bpipelines?\b/i, /\bopen\s+deals?\b/i, /\bcoverage\b/i, /\bin\s+flight\b/i],
    keywords: ['pipeline', 'open deals'],
    compute: (input) => {
      const scope = subjectScope(input);
      const conditions: Condition[] = [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).open }];
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'deal', conditions, measure: { property: 'amount', fn: 'sum' }, sampleIds: 8, ...scope,
        ...(input.groupBy === 'time' ? { groupByDate: { property: 'close_date', grain: bucketGrain(input.window) } } : groupSpec(input, 'close_date')),
      });
      const groups = input.groupBy === 'owner'
        ? groupByOwner(input.ctx, input.workspace.orgId, 'deal', conditions, undefined, { property: 'amount', fn: 'sum' }, input.workspace, 'money', scope.associatedTo)
        : groupsFrom(agg, 'money', input.workspace, input.groupBy === 'time' ? timeLabeller() : undefined);
      return result(input, { snapshot: true, id: 'pipeline', label: 'Open pipeline', unit: 'money' }, {
        value: agg.value, count: agg.count, ids: agg.ids, groups,
        source: `${agg.count} open ${agg.count === 1 ? 'deal' : 'deals'}`, sourceKind: 'deals',
        note: 'Open pipeline is a snapshot of every deal not yet closed, so it ignores the reporting period.',
      });
    },
  },
  {
    id: 'weighted_pipeline', label: 'Weighted pipeline', unit: 'money', supportsSubject: true, snapshot: true,
    patterns: [/\bweighted\b/i, /\bforecast(?:ed)?\s+(?:value|revenue|number)\b/i, /\bexpected\s+value\b/i],
    keywords: ['weighted', 'forecast'],
    compute: (input) => {
      const scope = subjectScope(input);
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'deal',
        conditions: [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).open }],
        measure: { property: 'weighted_amount', fn: 'sum' }, sampleIds: 8, ...scope, ...groupSpec(input, 'close_date'),
      });
      return result(input, { snapshot: true, id: 'weighted_pipeline', label: 'Weighted pipeline', unit: 'money' }, {
        value: agg.value, count: agg.count, ids: agg.ids,
        groups: groupsFrom(agg, 'money', input.workspace, input.groupBy === 'time' ? timeLabeller() : undefined),
        source: `${agg.count} open ${agg.count === 1 ? 'deal' : 'deals'} weighted by probability`, sourceKind: 'deals',
      });
    },
  },
  {
    id: 'closed_won', label: 'Closed-won bookings', unit: 'money', supportsSubject: true,
    patterns: [/\bclosed[\s-]?won\b/i, /\bbookings?\b/i, /\bwon\s+deals?\b/i, /\bnew\s+business\s+closed\b/i, /\b(?:did\s+\w+\s+)?book(?:ed)?\b/i],
    keywords: ['closed won', 'bookings', 'won'],
    compute: (input) => {
      const scope = subjectScope(input);
      const conditions: Condition[] = [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).won }];
      const window = { property: 'close_date', start: input.window.start, end: input.window.end };
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'deal', conditions, window, measure: { property: 'amount', fn: 'sum' }, sampleIds: 8, ...scope, ...groupSpec(input, 'close_date'),
      });
      const groups = input.groupBy === 'owner'
        ? groupByOwner(input.ctx, input.workspace.orgId, 'deal', conditions, window, { property: 'amount', fn: 'sum' }, input.workspace, 'money', scope.associatedTo)
        : groupsFrom(agg, 'money', input.workspace, input.groupBy === 'time' ? timeLabeller() : undefined);
      return result(input, { id: 'closed_won', label: 'Closed-won bookings', unit: 'money' }, {
        value: agg.value, count: agg.count, ids: agg.ids, groups,
        source: `${agg.count} closed-won ${agg.count === 1 ? 'deal' : 'deals'}`, sourceKind: 'deals',
      });
    },
  },
  {
    id: 'closed_lost', label: 'Closed-lost value', unit: 'money', supportsSubject: true,
    patterns: [/\bclosed[\s-]?lost\b/i, /\blost\s+(?:deals?|revenue|business)\b/i, /\blosses\b/i],
    keywords: ['lost'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'deal',
        conditions: [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).lost }],
        window: { property: 'close_date', start: input.window.start, end: input.window.end },
        measure: { property: 'amount', fn: 'sum' }, sampleIds: 8, ...subjectScope(input),
        ...(input.groupBy === 'stage' ? { groupBy: 'close_reason' } : groupSpec(input, 'close_date')),
      });
      return result(input, { id: 'closed_lost', label: 'Closed-lost value', unit: 'money' }, {
        value: agg.value, count: agg.count, ids: agg.ids,
        groups: groupsFrom(agg, 'money', input.workspace, input.groupBy === 'time' ? timeLabeller() : undefined),
        source: `${agg.count} closed-lost ${agg.count === 1 ? 'deal' : 'deals'}`, sourceKind: 'deals',
      });
    },
  },
  {
    id: 'win_rate', label: 'Win rate', unit: 'percent', supportsSubject: true,
    patterns: [/\bwin\s+rate\b/i, /\bclose\s+rate\b/i, /\bconversion\s+rate\b/i, /\bhit\s+rate\b/i],
    keywords: ['win rate'],
    compute: (input) => {
      const window = { property: 'close_date', start: input.window.start, end: input.window.end };
      const scope = subjectScope(input);
      const stages = stageSets(input.ctx, input.workspace.orgId);
      const won = aggregate(input.ctx, input.workspace.orgId, { objectType: 'deal', conditions: [{ property: 'deal_stage', op: 'in', values: stages.won }], window, sampleIds: 5, ...scope });
      const lost = aggregate(input.ctx, input.workspace.orgId, { objectType: 'deal', conditions: [{ property: 'deal_stage', op: 'in', values: stages.lost }], window, ...scope });
      const decided = won.count + lost.count;
      return result(input, { id: 'win_rate', label: 'Win rate', unit: 'percent' }, {
        value: decided ? (won.count / decided) * 100 : 0,
        count: decided, ids: won.ids,
        source: `${won.count} won of ${decided} decided ${decided === 1 ? 'deal' : 'deals'}`, sourceKind: 'deals',
        note: decided === 0 ? 'No deals reached a decision in this period.' : null,
      });
    },
  },
  {
    id: 'avg_deal_size', label: 'Average deal size', unit: 'money', supportsSubject: true,
    patterns: [/\b(average|avg|mean|typical)\s+(?:deal|contract|acv|order)\b/i, /\bdeal\s+size\b/i, /\bacv\b/i],
    keywords: ['average deal', 'deal size'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'deal',
        conditions: [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).won }],
        window: { property: 'close_date', start: input.window.start, end: input.window.end },
        measure: { property: 'amount', fn: 'avg' }, sampleIds: 6, ...subjectScope(input),
      });
      return result(input, { id: 'avg_deal_size', label: 'Average deal size', unit: 'money' }, {
        value: agg.value, count: agg.count, ids: agg.ids,
        source: `${agg.count} closed-won ${agg.count === 1 ? 'deal' : 'deals'}`, sourceKind: 'deals',
      });
    },
  },
  {
    id: 'sales_cycle', label: 'Average sales cycle', unit: 'days', supportsSubject: true,
    patterns: [/\bsales\s+cycle\b/i, /\bdays?\s+to\s+close\b/i, /\btime\s+to\s+close\b/i],
    keywords: ['sales cycle'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'deal',
        conditions: [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).won }],
        window: { property: 'close_date', start: input.window.start, end: input.window.end },
        measure: { property: 'days_to_close', fn: 'avg' }, sampleIds: 5, ...subjectScope(input),
      });
      return result(input, { id: 'sales_cycle', label: 'Average sales cycle', unit: 'days' }, {
        value: agg.value, count: agg.count, ids: agg.ids,
        source: `${agg.count} closed-won ${agg.count === 1 ? 'deal' : 'deals'}`, sourceKind: 'deals',
      });
    },
  },
  {
    id: 'deal_count', label: 'Deals', unit: 'count', supportsSubject: true, snapshot: true,
    patterns: [/\bhow\s+many\s+(?:open\s+)?deals?\b/i, /\bnumber\s+of\s+deals?\b/i, /\bdeal\s+count\b/i],
    keywords: ['deals'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'deal', conditions: [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).open }],
        sampleIds: 8, ...subjectScope(input), ...groupSpec(input, 'close_date'),
      });
      return result(input, { snapshot: true, id: 'deal_count', label: 'Deals', unit: 'count' }, {
        value: agg.count, count: agg.count, ids: agg.ids,
        groups: groupsFrom(agg, 'count', input.workspace),
        source: `${agg.count} open ${agg.count === 1 ? 'deal' : 'deals'}`, sourceKind: 'deals',
      });
    },
  },
  {
    id: 'new_customers', label: 'New customers', unit: 'count', supportsSubject: false,
    patterns: [/\bnew\s+(?:customers?|logos?|accounts?)\b/i, /\bcustomers?\s+(?:added|won|signed)\b/i],
    keywords: ['new customers', 'new logos'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'company', conditions: [{ property: 'type', op: 'eq', value: 'customer' }],
        window: { property: 'became_customer_at', start: input.window.start, end: input.window.end },
        sampleIds: 8, ...groupSpec(input, 'became_customer_at'),
      });
      return result(input, { id: 'new_customers', label: 'New customers', unit: 'count' }, {
        value: agg.count, count: agg.count, ids: agg.ids,
        groups: groupsFrom(agg, 'count', input.workspace, input.groupBy === 'time' ? timeLabeller() : undefined),
        source: `${agg.count} ${agg.count === 1 ? 'account that became a customer' : 'accounts that became customers'}`, sourceKind: 'records',
      });
    },
  },
  {
    id: 'customers', label: 'Customers', unit: 'count', supportsSubject: false, snapshot: true,
    patterns: [/\bhow\s+many\s+(?:customers|accounts|logos)\b/i, /\b(?:customer|logo|account)\s+count\b/i, /\btotal\s+(?:customers|accounts)\b/i, /\bcustomer\s+base\b/i],
    keywords: ['customers', 'accounts'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'company', conditions: [{ property: 'type', op: 'eq', value: 'customer' }],
        sampleIds: 8, ...(input.groupBy === 'industry' ? { groupBy: 'industry' } : {}),
      });
      return result(input, { snapshot: true, id: 'customers', label: 'Customers', unit: 'count' }, {
        value: agg.count, count: agg.count, ids: agg.ids, groups: groupsFrom(agg, 'count', input.workspace),
        source: `${agg.count} ${agg.count === 1 ? 'account' : 'accounts'} marked as a customer`, sourceKind: 'records',
      });
    },
  },
  {
    id: 'open_tickets', label: 'Open tickets', unit: 'count', supportsSubject: true, snapshot: true,
    patterns: [/\bopen\s+tickets?\b/i, /\bsupport\s+backlog\b/i, /\bunresolved\b/i, /\btickets?\s+open\b/i],
    keywords: ['open tickets', 'backlog'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'ticket', conditions: [{ property: 'status', op: 'in', values: OPEN_TICKET_STATUSES }],
        sampleIds: 8, ...subjectScope(input),
        ...(input.groupBy === 'status' ? { groupBy: 'status' } : input.groupBy === 'priority' ? { groupBy: 'priority' } : { groupBy: 'category' }),
      });
      return result(input, { snapshot: true, id: 'open_tickets', label: 'Open tickets', unit: 'count' }, {
        value: agg.count, count: agg.count, ids: agg.ids,
        groups: groupsFrom(agg, 'count', input.workspace),
        source: `${agg.count} ${agg.count === 1 ? 'ticket' : 'tickets'} not yet closed`, sourceKind: 'tickets',
      });
    },
  },
  {
    id: 'tickets_created', label: 'Tickets raised', unit: 'count', supportsSubject: true,
    patterns: [/\btickets?\s+(?:created|opened|raised|logged|filed)\b/i, /\bhow\s+many\s+tickets?\b/i],
    keywords: ['tickets'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'ticket', window: { property: 'created', start: input.window.start, end: input.window.end },
        sampleIds: 8, ...subjectScope(input),
        ...(input.groupBy === 'time' ? { groupByDate: { property: 'created', grain: bucketGrain(input.window) } } : { groupBy: 'category' }),
      });
      return result(input, { id: 'tickets_created', label: 'Tickets raised', unit: 'count' }, {
        value: agg.count, count: agg.count, ids: agg.ids,
        groups: groupsFrom(agg, 'count', input.workspace, input.groupBy === 'time' ? timeLabeller() : undefined),
        source: `${agg.count} ${agg.count === 1 ? 'ticket' : 'tickets'} raised in the period`, sourceKind: 'tickets',
      });
    },
  },
  {
    id: 'resolution_time', label: 'Average time to resolution', unit: 'hours', supportsSubject: true,
    patterns: [/\bresolution\s+time\b/i, /\btime\s+to\s+resolve\b/i, /\bhow\s+long\s+.*\bresolve\b/i, /\bfirst\s+response\b/i],
    keywords: ['resolution time'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'ticket',
        window: { property: 'resolved_at', start: input.window.start, end: input.window.end },
        measure: { property: 'resolution_minutes', fn: 'avg' }, sampleIds: 5, ...subjectScope(input),
      });
      return result(input, { id: 'resolution_time', label: 'Average time to resolution', unit: 'hours' }, {
        value: agg.value / 60, count: agg.count, ids: agg.ids,
        source: `${agg.count} resolved ${agg.count === 1 ? 'ticket' : 'tickets'}`, sourceKind: 'tickets',
      });
    },
  },
  {
    id: 'csat', label: 'Customer satisfaction', unit: 'score', supportsSubject: true,
    patterns: [/\bcsat\b/i, /\bsatisfaction\b/i, /\bhappiness\b/i],
    keywords: ['csat', 'satisfaction'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'ticket',
        conditions: [{ property: 'satisfaction_score', op: 'is_set' }],
        window: { property: 'resolved_at', start: input.window.start, end: input.window.end },
        measure: { property: 'satisfaction_score', fn: 'avg' }, sampleIds: 5, ...subjectScope(input),
      });
      return result(input, { id: 'csat', label: 'Customer satisfaction', unit: 'score' }, {
        value: agg.value, count: agg.count, ids: agg.ids,
        source: `${agg.count} rated ${agg.count === 1 ? 'ticket' : 'tickets'} (1–5)`, sourceKind: 'tickets',
      });
    },
  },
  {
    id: 'activities', label: 'Logged activity', unit: 'count', supportsSubject: true,
    patterns: [/\bactivit(?:y|ies)\b/i, /\btouch(?:es|points?)\b/i, /\bengagement\b/i, /\bhow\s+often\s+.*\b(?:spoke|talked|met)\b/i],
    keywords: ['activity', 'touches'],
    compute: (input) => {
      const types = ['call', 'meeting', 'email', 'note', 'task'];
      let total = 0;
      const ids: string[] = [];
      const groups: MetricGroup[] = [];
      for (const type of types) {
        const agg = aggregate(input.ctx, input.workspace.orgId, {
          objectType: type, window: { property: 'occurred_at', start: input.window.start, end: input.window.end },
          sampleIds: 2, ...subjectScope(input),
        });
        total += agg.count;
        ids.push(...agg.ids);
        if (agg.count) groups.push({ key: type, label: humanise(`${type}s`), value: agg.count, count: agg.count, formatted: String(agg.count) });
      }
      groups.sort((a, b) => b.value - a.value);
      return result(input, { id: 'activities', label: 'Logged activity', unit: 'count' }, {
        value: total, count: total, ids: ids.slice(0, 8), groups,
        source: `${total} logged ${total === 1 ? 'activity' : 'activities'}`, sourceKind: 'activities',
      });
    },
  },
  {
    id: 'meetings', label: 'Meetings held', unit: 'count', supportsSubject: true,
    patterns: [/\bmeetings?\b/i, /\bqbrs?\b/i, /\bdemos?\b/i],
    keywords: ['meetings'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'meeting', window: { property: 'occurred_at', start: input.window.start, end: input.window.end },
        sampleIds: 6, ...subjectScope(input), groupBy: 'meeting_type',
      });
      return result(input, { id: 'meetings', label: 'Meetings held', unit: 'count' }, {
        value: agg.count, count: agg.count, ids: agg.ids, groups: groupsFrom(agg, 'count', input.workspace),
        source: `${agg.count} ${agg.count === 1 ? 'meeting' : 'meetings'} on the timeline`, sourceKind: 'activities',
      });
    },
  },
  {
    id: 'connected_assets', label: 'Connected assets', unit: 'count', supportsSubject: true, snapshot: true,
    patterns: [/\bconnected\s+assets?\b/i, /\bmachines?\b/i, /\brobots?\b/i, /\basset\s+count\b/i],
    keywords: ['assets', 'machines'],
    compute: (input) => {
      const subject = input.subject;
      if (subject && subject.type === 'company') {
        const record = getRecord(input.ctx, input.workspace.orgId, subject.id);
        const assets = Number(record?.properties.connected_assets ?? 0);
        return result(input, { snapshot: true, id: 'connected_assets', label: 'Connected assets', unit: 'count' }, {
          value: assets, count: record ? 1 : 0, ids: record ? [record.id] : [],
          source: `the asset count on ${record?.display_name ?? subject.label}`, sourceKind: 'records',
        });
      }
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'company',
        conditions: [{ property: 'type', op: 'eq', value: 'customer' }],
        measure: { property: 'connected_assets', fn: 'sum' }, sampleIds: 6,
        ...(input.groupBy === 'industry' ? { groupBy: 'industry' } : {}),
      });
      return result(input, { snapshot: true, id: 'connected_assets', label: 'Connected assets', unit: 'count' }, {
        value: agg.value, count: agg.count, ids: agg.ids, groups: groupsFrom(agg, 'count', input.workspace),
        source: `${agg.count} ${agg.count === 1 ? 'account' : 'accounts'} reporting telemetry`, sourceKind: 'records',
      });
    },
  },
  {
    id: 'mrr', label: 'Monthly recurring revenue', unit: 'money', supportsSubject: true, snapshot: true,
    patterns: [/\bmrr\b/i, /\bmonthly\s+recurring\b/i, /\barr\b/i, /\brun\s?rate\b/i, /\brecurring\s+revenue\b/i],
    keywords: ['mrr', 'arr'],
    compute: (input) => {
      const sources = billingSources(input.ctx.db);
      const subs = sources.subscriptions;
      if (!subs?.amountColumn) {
        return result(input, { snapshot: true, id: 'mrr', label: 'Monthly recurring revenue', unit: 'money' }, {
          value: 0, count: 0, source: 'no subscription ledger in this workspace', sourceKind: 'unavailable',
          note: 'Recurring revenue needs the subscriptions ledger, which is not installed here. Closed-won bookings and open pipeline are available instead.',
        });
      }
      const where = [`org_id = ?`];
      const params: unknown[] = [input.workspace.orgId];
      if (subs.statusColumn) where.push(`${subs.statusColumn} IN ('active', 'trialing', 'past_due')`);
      const customerIds = linkedCustomerIds(input.ctx, input.workspace.orgId, input.subject);
      if (input.subject && subs.customerColumn && customerIds.length) {
        where.push(`${subs.customerColumn} IN (${customerIds.map(() => '?').join(', ')})`);
        params.push(...customerIds);
      }
      const row = input.ctx.db.get<{ v: number | null; n: number }>(
        `SELECT SUM(${subs.amountColumn}) AS v, COUNT(*) AS n FROM ${subs.table} WHERE ${where.join(' AND ')}`, ...(params as never[]));
      return result(input, { snapshot: true, id: 'mrr', label: 'Monthly recurring revenue', unit: 'money' }, {
        value: Number(row?.v ?? 0), count: Number(row?.n ?? 0),
        source: `${row?.n ?? 0} active ${Number(row?.n ?? 0) === 1 ? 'subscription' : 'subscriptions'}`, sourceKind: 'subscriptions',
      });
    },
  },
];

export const METRICS: MetricDefinition[] = DEFS;
export const metricById = (id: string): MetricDefinition | undefined => DEFS.find((d) => d.id === id);
export const metricIds = (): string[] => DEFS.map((d) => d.id);

export interface MetricDetection {
  metric: MetricDefinition;
  matched: string;
  score: number;
  alternatives: { id: string; score: number }[];
}

/** Choose the metric a question is asking for, and say what matched. */
export function detectMetric(message: string): MetricDetection | null {
  const scored: { def: MetricDefinition; score: number; matched: string }[] = [];
  for (const def of DEFS) {
    let best = 0;
    let matched = '';
    def.patterns.forEach((pattern, index) => {
      const hit = message.match(pattern);
      if (!hit) return;
      // Earlier patterns are the canonical phrasing; later ones are synonyms.
      const weight = 1 - index * 0.08 + Math.min(hit[0].length, 24) / 100;
      if (weight > best) { best = weight; matched = hit[0]; }
    });
    if (best > 0) scored.push({ def, score: best, matched });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  return {
    metric: top.def,
    matched: top.matched,
    score: Number(top.score.toFixed(3)),
    alternatives: scored.slice(1, 4).map((s) => ({ id: s.def.id, score: Number(s.score.toFixed(3)) })),
  };
}

/** Which grouping the question asked for, if any. */
export function detectGrouping(message: string): GroupBy {
  const text = message.toLowerCase();
  if (/\bby\s+(month|quarter|week|day|year)\b|\bover\s+time\b|\btrend(?:ed|ing|line)?\b|\bmonth\s+by\s+month\b/.test(text)) return 'time';
  if (/\bby\s+(rep|owner|ae|seller|person|teammate)\b|\bper\s+rep\b|\bwho\s+(?:closed|sold|won)\b/.test(text)) return 'owner';
  if (/\bby\s+stage\b|\bstage\s+by\s+stage\b|\bfunnel\b/.test(text)) return 'stage';
  if (/\bby\s+industr(?:y|ies)\b|\bby\s+vertical\b|\bby\s+segment\b/.test(text)) return 'industry';
  if (/\bby\s+(account|customer|company|logo)\b/.test(text)) return 'account';
  if (/\b(top|biggest|largest|highest|best|worst|lowest)\s+\d*\s*(accounts?|customers?|companies|logos)\b/.test(text)) return 'account';
  if (/\bwhich\s+(accounts?|customers?|companies)\b/.test(text)) return 'account';
  if (/\bby\s+status\b/.test(text)) return 'status';
  if (/\bby\s+priorit(?:y|ies)\b/.test(text)) return 'priority';
  if (/\bby\s+source\b|\bby\s+channel\b/.test(text)) return 'source';
  return 'none';
}

/** Top accounts for a metric — the "who" behind an aggregate. */
export function topAccounts(input: MetricInput, metric: MetricDefinition, limit = 5): MetricGroup[] {
  if (!['spend', 'revenue', 'invoiced', 'closed_won', 'pipeline', 'open_tickets'].includes(metric.id)) return [];
  const companies = fetchRecords(input.ctx, input.workspace.orgId, { objectType: 'company', limit: 400 });
  const rows: MetricGroup[] = [];
  for (const company of companies) {
    const scoped = metric.compute({ ...input, subject: { id: company.id, type: 'company', label: company.display_name }, groupBy: 'none' });
    if (scoped.value > 0) {
      rows.push({ key: company.id, label: company.display_name, value: scoped.value, count: scoped.count, formatted: scoped.formatted });
    }
  }
  return rows.sort((a, b) => b.value - a.value).slice(0, limit);
}

/** Everything the account panel of a copilot answer needs, in one call. */
export function accountSnapshot(ctx: Ctx, workspace: WorkspaceProfile, companyId: string) {
  const stages = stageSets(ctx, workspace.orgId);
  const contacts = associatedRecords(ctx, workspace.orgId, companyId, 'contact', 25);
  const deals = associatedRecords(ctx, workspace.orgId, companyId, 'deal', 40);
  const tickets = associatedRecords(ctx, workspace.orgId, companyId, 'ticket', 40);
  const open = deals.filter((d) => stages.open.includes(String(d.properties.deal_stage ?? '')));
  const won = deals.filter((d) => stages.won.includes(String(d.properties.deal_stage ?? '')));
  const lost = deals.filter((d) => stages.lost.includes(String(d.properties.deal_stage ?? '')));
  const openTickets = tickets.filter((t) => OPEN_TICKET_STATUSES.includes(String(t.properties.status ?? '')));
  const sum = (rows: typeof deals) => rows.reduce((acc, d) => acc + Number(d.properties.amount ?? 0), 0);
  return {
    contacts,
    deals,
    openDeals: open,
    wonDeals: won,
    lostDeals: lost,
    tickets,
    openTickets,
    openValue: sum(open),
    wonValue: sum(won),
    nextClose: open
      .map((d) => Number(d.properties.close_date ?? 0))
      .filter((v) => v > 0)
      .sort((a, b) => a - b)[0] ?? null,
    daysSinceActivity: (() => {
      const last = Number(
        ctx.db.pluck<number>(
          `SELECT MAX(v.value_date) FROM crm_record_values v WHERE v.org_id = ? AND v.property = 'last_activity_at' AND v.record_id = ?`,
          workspace.orgId, companyId,
        ) ?? 0,
      );
      return last ? Math.floor((workspace.now - last) / DAY) : null;
    })(),
  };
}
