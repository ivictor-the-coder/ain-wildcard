/**
 * The engine's own capabilities.
 *
 * These are plain functions over the workspace database. The `ai` module wraps
 * each of them in a registered `AiToolDef` so agents, the copilot and any other
 * module can call them, and the engine falls back to calling them directly when
 * a caller supplies its own restricted tool list — either way the same code
 * produces the number, so a tool result and a copilot sentence can never
 * disagree.
 */
import type { Ctx } from '../kernel/context';
import { DAY, formatDate, formatRelative } from '../../shared/time';
import { formatMoney } from '../../shared/money';
import { billingSources, entityIndex, workspaceProfile, type WorkspaceProfile } from './grounding';
import { resolveEntities, type ResolvedEntity } from './resolve';
import {
  accountSnapshot, detectGrouping, metricById, metricIds, topAccounts,
  type GroupBy, type MetricResult, type MetricSubject,
} from './metrics';
import { aggregate, associatedRecords, fetchRecords, getRecord, propertyMap, type Condition, type RecordSummary } from './query';
import { defaultWindow, previousWindow, type TimeWindow } from './dates';
import { humanise, truncate } from './text';

export interface SearchHit {
  id: string;
  type: string;
  label: string;
  sublabel: string | null;
  score: number;
  why: string;
}

export interface WorkspaceSearchResult {
  query: string;
  matches: SearchHit[];
  /** Records the query described but could not pin down to one record. */
  ambiguous: boolean;
}

/** Rank every nameable record in the workspace against a phrase. */
export function workspaceSearch(ctx: Ctx, orgId: string, args: { query: string; types?: string[]; limit?: number }): WorkspaceSearchResult {
  const index = entityIndex(ctx, orgId);
  const hits = resolveEntities(args.query, index, {
    only: args.types?.length ? args.types : undefined,
    limit: Math.min(args.limit ?? 8, 25),
    dedupe: true,
  });
  const matches = hits.map((hit) => ({
    id: hit.entity.id,
    type: hit.entity.type,
    label: hit.entity.label,
    sublabel: hit.entity.sublabel,
    score: hit.score,
    why: hit.explain,
  }));
  return {
    query: args.query,
    matches,
    ambiguous: matches.length > 1 && matches[0].score - matches[1].score < 0.08,
  };
}

export interface AccountProfileResult {
  id: string;
  name: string;
  object_type: string;
  owner: string | null;
  properties: Record<string, unknown>;
  headline: string;
  contacts: { id: string; name: string; title: string | null; email: string | null; role: string | null }[];
  open_deals: { id: string; name: string; amount: number; amount_formatted: string; stage: string; close_date: number | null; owner: string | null }[];
  won_deals: { id: string; name: string; amount_formatted: string; closed: number | null }[];
  open_tickets: { id: string; subject: string; status: string; priority: string; created: number }[];
  totals: {
    open_pipeline: number; open_pipeline_formatted: string;
    lifetime_won: number; lifetime_won_formatted: string;
    contacts: number; open_tickets: number;
  };
  last_activity: { at: number | null; days_ago: number | null; summary: string | null };
  next_close_date: number | null;
}

const personName = (workspace: WorkspaceProfile, id: string | null | undefined): string | null =>
  (id ? workspace.people.find((p) => p.id === id)?.name ?? null : null);

/** Show the picklist label an operator sees, not the stored enum value. */
function optionLabel(ctx: Ctx, orgId: string, objectType: string, property: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const definition = propertyMap(ctx, orgId, objectType).get(property);
  const option = definition?.options.find((o) => o.value === String(value));
  return option?.label ?? humanise(String(value));
}

/** Everything a human would want on screen before talking to an account. */
export function accountProfile(ctx: Ctx, orgId: string, args: { id: string }): AccountProfileResult | { error: string } {
  const workspace = workspaceProfile(ctx, orgId);
  let record = getRecord(ctx, orgId, args.id);
  if (record && record.object_type === 'contact') {
    const parent = associatedRecords(ctx, orgId, record.id, 'company', 1)[0];
    if (parent) record = parent;
  }
  if (!record) return { error: `No record with id ${args.id} in this workspace.` };

  const snapshot = accountSnapshot(ctx, workspace, record.id);
  const currency = workspace.currency;
  const asMoney = (amount: number) => formatMoney({ amount, currency }, { locale: workspace.locale, trimZeroFraction: true });
  const lastActivityAt = Number(record.properties.last_activity_at ?? 0) || null;
  const recentActivity = recordTimeline(ctx, orgId, { record_id: record.id, limit: 1 }).items[0] ?? null;

  return {
    id: record.id,
    name: record.display_name,
    object_type: record.object_type,
    owner: personName(workspace, record.owner_id),
    properties: record.properties,
    headline: [
      optionLabel(ctx, orgId, record.object_type, 'industry', record.properties.industry),
      record.properties.employee_count ? `${Number(record.properties.employee_count).toLocaleString('en-US')} employees` : '',
      record.properties.connected_assets ? `${Number(record.properties.connected_assets).toLocaleString('en-US')} connected assets` : '',
      optionLabel(ctx, orgId, record.object_type, 'type', record.properties.type),
    ].filter(Boolean).join(' · '),
    contacts: snapshot.contacts.map((c) => ({
      id: c.id,
      name: c.display_name,
      title: (c.properties.job_title as string) ?? null,
      email: (c.properties.email as string) ?? null,
      role: c.properties.buying_role ? humanise(String(c.properties.buying_role)) : null,
    })),
    open_deals: snapshot.openDeals.map((d) => ({
      id: d.id,
      name: d.display_name,
      amount: Number(d.properties.amount ?? 0),
      amount_formatted: asMoney(Number(d.properties.amount ?? 0)),
      stage: humanise(String(d.properties.deal_stage ?? '')),
      close_date: Number(d.properties.close_date ?? 0) || null,
      owner: personName(workspace, d.owner_id),
    })).sort((a, b) => b.amount - a.amount),
    won_deals: snapshot.wonDeals.map((d) => ({
      id: d.id,
      name: d.display_name,
      amount_formatted: asMoney(Number(d.properties.amount ?? 0)),
      closed: Number(d.properties.close_date ?? 0) || null,
    })),
    open_tickets: snapshot.openTickets.map((t) => ({
      id: t.id,
      subject: String(t.properties.subject ?? t.display_name),
      status: humanise(String(t.properties.status ?? '')),
      priority: humanise(String(t.properties.priority ?? '')),
      created: t.created,
    })),
    totals: {
      open_pipeline: snapshot.openValue,
      open_pipeline_formatted: asMoney(snapshot.openValue),
      lifetime_won: snapshot.wonValue,
      lifetime_won_formatted: asMoney(snapshot.wonValue),
      contacts: snapshot.contacts.length,
      open_tickets: snapshot.openTickets.length,
    },
    last_activity: {
      at: lastActivityAt,
      days_ago: snapshot.daysSinceActivity,
      summary: recentActivity ? recentActivity.title : null,
    },
    next_close_date: snapshot.nextClose,
  };
}

export interface MetricToolResult extends Omit<MetricResult, 'window'> {
  window: { label: string; start: number; end: number; partial: boolean };
  change: { previous: number; previous_formatted: string; delta: number; percent: number | null } | null;
  top_accounts: { id: string; label: string; formatted: string }[];
  /** The rows behind the number, named — an answer can cite them by name. */
  evidence: { id: string; label: string; type: string }[];
}

/**
 * The name behind a billing customer id. A subject that is not a CRM record is
 * still something with a name, and an answer that prints the id instead is a
 * database row in a sentence a board reads.
 */
function customerName(ctx: Ctx, orgId: string, id: string): string | null {
  const customers = billingSources(ctx.db).customers;
  if (!customers?.nameColumn) return null;
  const row = ctx.db.get<{ nm: string | null }>(
    `SELECT ${customers.nameColumn} AS nm FROM ${customers.table} WHERE org_id = ? AND id = ?`, orgId, id);
  return row?.nm?.trim() || null;
}

/** Resolve record ids to display names so citations read as records, not ids. */
function labelIds(ctx: Ctx, orgId: string, ids: string[], fallbackType: string): { id: string; label: string; type: string }[] {
  if (!ids.length) return [];
  const found = new Map<string, { label: string; type: string }>();
  for (const id of ids) {
    const record = getRecord(ctx, orgId, id);
    if (record) found.set(id, { label: record.display_name, type: record.object_type });
  }
  return ids.map((id) => ({ id, label: found.get(id)?.label ?? id, type: found.get(id)?.type ?? fallbackType }));
}

/** Compute one metric, with the previous period for context when it exists. */
export function businessMetric(ctx: Ctx, orgId: string, args: {
  metric: string; start?: number; end?: number; window_label?: string; subject_id?: string; group_by?: GroupBy; compare?: boolean;
}): MetricToolResult | { error: string; available: string[] } {
  const definition = metricById(args.metric);
  if (!definition) return { error: `Unknown metric "${args.metric}".`, available: metricIds() };
  const workspace = workspaceProfile(ctx, orgId);
  // `start: 0` is a real window — "all time" begins at the epoch — so this
  // guard tests for a number rather than for truthiness. Reading it as "no
  // window given" is what made a ranking over all time report this quarter.
  const bounded = Number.isFinite(args.start) && Number.isFinite(args.end) && Number(args.end) > Number(args.start);
  const window: TimeWindow = bounded
    ? {
        start: args.start as number,
        end: args.end as number,
        label: args.window_label ?? 'the selected period',
        grain: 'range',
        matched: '',
        partial: (args.end as number) > workspace.now && (args.start as number) <= workspace.now,
      }
    : defaultWindow(workspace.now);

  let subject: MetricSubject | null = null;
  if (args.subject_id) {
    const record = getRecord(ctx, orgId, args.subject_id);
    subject = record
      ? { id: record.id, type: record.object_type, label: record.display_name }
      : { id: args.subject_id, type: 'customer', label: customerName(ctx, orgId, args.subject_id) ?? args.subject_id };
  }

  const input = { ctx, workspace, window, subject, groupBy: args.group_by ?? 'none' };
  const result = definition.compute(input);
  const change = args.compare !== false && !definition.snapshot
    ? (() => {
        const prior = definition.compute({ ...input, window: previousWindow(window), groupBy: 'none' });
        const delta = result.value - prior.value;
        return {
          previous: prior.value,
          previous_formatted: prior.formatted,
          delta,
          percent: prior.value === 0 ? null : Number(((delta / Math.abs(prior.value)) * 100).toFixed(1)),
        };
      })()
    : null;

  const accounts = args.group_by === 'account' && !result.groups.length ? topAccounts(input, definition, 5) : [];

  return {
    ...result,
    window: { label: window.label, start: window.start, end: window.end, partial: window.partial },
    change,
    top_accounts: accounts.map((a) => ({ id: a.key, label: a.label, formatted: a.formatted })),
    evidence: labelIds(ctx, orgId, result.ids, result.sourceKind === 'invoices' ? 'invoice' : 'record'),
  };
}

export interface TimelineItem {
  id: string;
  kind: string;
  at: number;
  title: string;
  body: string | null;
  actor: string | null;
  when: string;
}

/** Recent activity on a record, newest first — calls, meetings, notes, changes. */
export function recordTimeline(ctx: Ctx, orgId: string, args: { record_id: string; limit?: number }): { record: string; items: TimelineItem[] } {
  const workspace = workspaceProfile(ctx, orgId);
  const limit = Math.min(args.limit ?? 10, 50);
  const record = getRecord(ctx, orgId, args.record_id);
  const items: TimelineItem[] = [];

  for (const type of ['note', 'call', 'meeting', 'email', 'task']) {
    for (const activity of associatedRecords(ctx, orgId, args.record_id, type, limit)) {
      const at = Number(activity.properties.occurred_at ?? activity.created);
      items.push({
        id: activity.id,
        kind: type,
        at,
        title: String(activity.properties.subject ?? activity.display_name),
        body: activity.properties.body ? truncate(String(activity.properties.body), 400) : null,
        actor: personName(workspace, activity.owner_id),
        when: formatRelative(at, workspace.now, workspace.locale),
      });
    }
  }

  for (const change of ctx.db.all<{ id: string; property: string; from_value: string | null; to_value: string | null; changed_at: number; actor_id: string | null }>(
    `SELECT id, property, from_value, to_value, changed_at, actor_id FROM crm_property_history
     WHERE org_id = ? AND record_id = ? ORDER BY changed_at DESC LIMIT ?`, orgId, args.record_id, limit)) {
    items.push({
      id: change.id,
      kind: 'property_change',
      at: change.changed_at,
      title: `${humanise(change.property)} changed to ${humanise(String(change.to_value ?? '—')).slice(0, 60)}`,
      body: change.from_value ? `was ${humanise(String(change.from_value)).slice(0, 60)}` : null,
      actor: personName(workspace, change.actor_id),
      when: formatRelative(change.changed_at, workspace.now, workspace.locale),
    });
  }

  items.sort((a, b) => b.at - a.at);
  return { record: record?.display_name ?? args.record_id, items: items.slice(0, limit) };
}

export interface RecordSearchResult {
  object_type: string;
  total: number;
  records: {
    id: string; name: string; owner: string | null; updated: number;
    properties: Record<string, unknown>;
  }[];
}

/** Filtered list of records of one object type — the generic "show me" tool. */
export function recordSearch(ctx: Ctx, orgId: string, args: {
  object_type: string; conditions?: Condition[]; start?: number; end?: number; date_property?: string;
  associated_to?: string; owner_id?: string; limit?: number; order_by?: string;
}): RecordSearchResult {
  const workspace = workspaceProfile(ctx, orgId);
  const window = args.start && args.end && args.date_property
    ? { property: args.date_property, start: args.start, end: args.end }
    : undefined;
  const spec = {
    objectType: args.object_type,
    conditions: args.conditions ?? [],
    window,
    associatedTo: args.associated_to,
    ownerId: args.owner_id,
    limit: Math.min(args.limit ?? 10, 50),
    orderBy: args.order_by,
  };
  const rows = fetchRecords(ctx, orgId, spec);
  const total = aggregate(ctx, orgId, spec).count;
  return {
    object_type: args.object_type,
    total,
    records: rows.map((row) => ({
      id: row.id,
      name: row.display_name,
      owner: personName(workspace, row.owner_id),
      updated: row.updated,
      properties: row.properties,
    })),
  };
}

export interface RecordAggregateResult {
  object_type: string;
  measure: string;
  value: number;
  formatted: string;
  matched_records: number;
  groups: { key: string; label: string; value: number; count: number }[];
  sample_ids: string[];
}

/** Count, sum or average any property of any object type, with grouping. */
export function recordAggregate(ctx: Ctx, orgId: string, args: {
  object_type: string; measure?: 'count' | 'sum' | 'avg' | 'min' | 'max'; property?: string;
  conditions?: Condition[]; group_by?: string; start?: number; end?: number; date_property?: string;
  associated_to?: string;
}): RecordAggregateResult | { error: string } {
  const workspace = workspaceProfile(ctx, orgId);
  const properties = propertyMap(ctx, orgId, args.object_type);
  if (!properties.size) return { error: `Unknown object type "${args.object_type}".` };
  const measure = args.measure ?? 'count';
  if (measure !== 'count' && !args.property) return { error: `A ${measure} needs a property to measure.` };
  if (args.property && !properties.has(args.property)) {
    return { error: `"${args.property}" is not a property of ${args.object_type}. Try: ${[...properties.keys()].slice(0, 12).join(', ')}.` };
  }
  if (args.group_by && !properties.has(args.group_by)) {
    return { error: `Cannot group by "${args.group_by}" — no such property on ${args.object_type}.` };
  }

  const result = aggregate(ctx, orgId, {
    objectType: args.object_type,
    conditions: args.conditions ?? [],
    window: args.start && args.end && args.date_property ? { property: args.date_property, start: args.start, end: args.end } : undefined,
    measure: measure === 'count' ? undefined : { property: args.property!, fn: measure },
    groupBy: args.group_by,
    associatedTo: args.associated_to,
    sampleIds: 6,
  });

  const definition = args.property ? properties.get(args.property) : undefined;
  const isMoney = definition?.type === 'currency';
  const format = (value: number) => (isMoney
    ? formatMoney({ amount: Math.round(value), currency: workspace.currency }, { locale: workspace.locale, trimZeroFraction: true })
    : Number(value.toFixed(2)).toLocaleString(workspace.locale));

  const optionLabels = new Map((args.group_by ? properties.get(args.group_by)?.options ?? [] : []).map((o) => [o.value, o.label]));
  return {
    object_type: args.object_type,
    measure: measure === 'count' ? 'count of records' : `${measure} of ${definition?.label ?? args.property}`,
    value: measure === 'count' ? result.count : result.value,
    formatted: measure === 'count' ? String(result.count) : format(result.value),
    matched_records: result.count,
    groups: result.groups.map((g) => ({
      key: g.key,
      label: optionLabels.get(g.key) ?? humanise(g.key),
      value: measure === 'count' ? g.count : g.value,
      count: g.count,
    })),
    sample_ids: result.ids,
  };
}

/* --------------------------- shared presentation -------------------------- */

export interface RecordLine { id: string; label: string; detail: string }

/** The one-line rendering of a record used in answers and citations. */
export function describeRecord(workspace: WorkspaceProfile, record: RecordSummary): RecordLine {
  const props = record.properties;
  const detail: string[] = [];
  if (record.object_type === 'deal') {
    detail.push(formatMoney({ amount: Number(props.amount ?? 0), currency: workspace.currency }, { locale: workspace.locale, trimZeroFraction: true }));
    if (props.deal_stage) detail.push(humanise(String(props.deal_stage)));
    // `close_date` is a calendar day stored as midnight UTC, not an instant:
    // read back in a zone west of Greenwich it reports the evening before, so
    // the citation under an answer disagrees with the deal board it links to.
    if (props.close_date) detail.push(`closes ${formatDate(Number(props.close_date), { locale: workspace.locale, timeZone: 'UTC' })}`);
  } else if (record.object_type === 'ticket') {
    if (props.priority) detail.push(`${humanise(String(props.priority))} priority`);
    if (props.status) detail.push(humanise(String(props.status)));
    detail.push(`opened ${formatDate(record.created, { locale: workspace.locale, timeZone: workspace.timezone })}`);
  } else if (record.object_type === 'contact') {
    if (props.job_title) detail.push(String(props.job_title));
    if (props.email) detail.push(String(props.email));
  } else if (record.object_type === 'company') {
    if (props.industry) detail.push(humanise(String(props.industry)));
    if (props.employee_count) detail.push(`${Number(props.employee_count).toLocaleString('en-US')} employees`);
    if (props.type) detail.push(humanise(String(props.type)));
  } else if (props.occurred_at) {
    detail.push(formatDate(Number(props.occurred_at), { locale: workspace.locale, timeZone: workspace.timezone }));
  }
  return { id: record.id, label: record.display_name, detail: detail.join(' · ') };
}

export const daysBetween = (from: number, to: number): number => Math.round((to - from) / DAY);

export type { GroupBy, MetricSubject, ResolvedEntity, RecordSummary };
export { detectGrouping };
