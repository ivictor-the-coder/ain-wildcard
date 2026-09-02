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
import { billingSources, entityIndex, hasTable, workspaceProfile, type WorkspaceProfile } from './grounding';
import { crmVocabulary, stageLabelIn } from './qualifiers';
import { resolveEntities, type ResolvedEntity } from './resolve';
import {
  accountSnapshot, detectGrouping, metricById, metricIds, stageSets, topAccounts,
  type GroupBy, type MetricResult, type MetricSubject,
} from './metrics';
import { aggregate, associatedRecords, fetchRecords, getRecord, propertyMap, type Condition, type RecordSummary } from './query';
import { defaultWindow, previousWindow, type TimeWindow } from './dates';
import { humanise, listPhrase, truncate } from './text';

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
  /**
   * The pipeline and stage this figure was narrowed to, when the question
   * named one. Rendered into the headline, because a scoped number under an
   * unscoped sentence is the substitution that made this field necessary.
   */
  scope: { pipeline: string | null; stage: string | null; label: string } | null;
  change: { previous: number; previous_formatted: string; delta: number; percent: number | null } | null;
  top_accounts: { id: string; label: string; formatted: string; currency: string | null }[];
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

/**
 * Resolve ids to display names so citations read as records, not primary keys.
 *
 * A citation a reader cannot identify is not a citation. The MRR answer cited
 * `sub_i4bvky9acvO3okb7` six times, with the id as its own label, because the
 * rows behind recurring revenue are subscriptions and `getRecord` only knows
 * the CRM. Subscriptions and invoices are named through the ledger that owns
 * them, and anything that still cannot be named is dropped rather than printed.
 */
function labelIds(ctx: Ctx, orgId: string, ids: string[], fallbackType: string): { id: string; label: string; type: string }[] {
  if (!ids.length) return [];
  const out: { id: string; label: string; type: string }[] = [];
  const billing = ctx.svc.billing;
  for (const id of ids) {
    const record = getRecord(ctx, orgId, id);
    if (record) { out.push({ id, label: record.display_name, type: record.object_type }); continue; }
    if (billing && id.startsWith('sub_')) {
      const sub = billing.subscription(orgId, id);
      const name = sub ? billing.customer(orgId, sub.customer)?.name : null;
      // Two subscriptions on one account are two rows a reader has to tell
      // apart, so the plan they are on is part of the name.
      if (name) {
        // The ledger's own description often already opens with the account
        // name; repeating it makes "Meridian Forge Systems — Meridian Forge
        // Systems — Predictive Maintenance AI".
        const plan = sub?.description?.trim() ?? '';
        const detail = plan && !plan.toLowerCase().startsWith(name.toLowerCase()) ? plan : '';
        out.push({ id, label: detail ? `${name} — ${detail}` : plan || `${name} subscription`, type: 'subscription' });
        continue;
      }
    }
    if (billing && id.startsWith('in_')) {
      const invoice = billing.invoice(orgId, id);
      if (invoice?.number) { out.push({ id, label: invoice.number, type: 'invoice' }); continue; }
    }
    if (billing && id.startsWith('cus_')) {
      const name = billing.customer(orgId, id)?.name;
      if (name) { out.push({ id, label: name, type: 'customer' }); continue; }
    }
    void fallbackType;
  }
  return out;
}

/** Compute one metric, with the previous period for context when it exists. */
export function businessMetric(ctx: Ctx, orgId: string, args: {
  metric: string; start?: number; end?: number; window_label?: string; subject_id?: string; group_by?: GroupBy; compare?: boolean;
  currency?: string; pipeline?: string; stage?: string; limit?: number; direction?: 'asc' | 'desc';
}): MetricToolResult | { error: string; available: string[] } {
  const definition = metricById(args.metric);
  if (!definition) return { error: `Unknown metric "${args.metric}".`, available: metricIds() };
  const workspace = workspaceProfile(ctx, orgId);

  // A pipeline or a stage this metric cannot be narrowed by is an error, never
  // a silently unfiltered figure. "What did we invoice on the Renewal
  // pipeline" has no answer; the workspace's invoiced total is not a smaller
  // version of it, it is a different number about a different thing.
  const vocabulary = crmVocabulary(ctx, orgId);
  if (args.pipeline) {
    if (!definition.scope) {
      return {
        error: `"${definition.label}" is not measured from deals, so it cannot be narrowed to the "${args.pipeline}" pipeline.`,
        available: metricIds().filter((id) => metricById(id)?.scope === 'deal'),
      };
    }
    if (vocabulary.pipelines.length && !vocabulary.pipelines.some((p) => p.value === args.pipeline)) {
      return {
        error: `No deal pipeline named "${args.pipeline}" in this workspace.`,
        available: vocabulary.pipelines.map((p) => p.value),
      };
    }
  }
  if (args.stage) {
    if (!definition.stageFilter) {
      return {
        error: `"${definition.label}" is defined by its own stage set, so it cannot also be narrowed to the "${args.stage}" stage.`,
        available: metricIds().filter((id) => metricById(id)?.stageFilter),
      };
    }
    if (vocabulary.stages.length && !vocabulary.stages.some((st) => st.value === args.stage)) {
      return {
        error: `No deal stage named "${args.stage}" in this workspace.`,
        available: vocabulary.stages.map((st) => st.value),
      };
    }
  }
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

  const input = {
    ctx, workspace, window, subject, groupBy: args.group_by ?? 'none',
    currency: args.currency ? args.currency.toLowerCase() : null,
    pipeline: args.pipeline ?? null,
    stage: args.stage ?? null,
    limit: args.limit,
  };
  const computed = definition.compute(input);
  // A currency book the metric never read is a scope the answer would claim and
  // not hold.
  //
  // "How much of our pipeline is in GBP?" came back as "Northwind Robotics is
  // carrying $9,010,960 in open pipeline, from 38 open deals. Scoped to the GBP
  // book, which is the currency you named" — the whole open book, in dollars,
  // under a sentence asserting a narrowing that does not exist. Deals carry no
  // currency here, so there is no GBP pipeline; the ledger metrics do, and they
  // answer for the books they actually hold. The test is the figure that came
  // back rather than a list of which metrics are supposed to support it.
  if (args.currency) {
    const asked = args.currency.toLowerCase();
    const held = computed.books.map((book) => book.currency.toLowerCase());
    if (definition.unit === 'money' && !held.includes(asked) && (computed.currency ?? '').toLowerCase() !== asked) {
      return {
        error: held.length
          ? `"${definition.label}" is held in ${listPhrase(held.map((code) => code.toUpperCase()))} here, and there is no ${asked.toUpperCase()} book in it — the unscoped figure is a different number, not a smaller version of the one you asked for.`
          : `"${definition.label}" is measured from records that carry no currency book in this workspace, so it cannot be narrowed to ${asked.toUpperCase()}: the figure I hold is the whole of it, in ${(computed.currency ?? workspace.currency).toUpperCase()}.`,
        available: metricIds().filter((id) => metricById(id)?.unit === 'money'),
      };
    }
  }
  // "Who has the least pipeline?" is "who has the most" with one word changed,
  // and every metric here ranks its groups largest first. Reversing the rows —
  // once, here, rather than in each metric — is what makes the smaller end of a
  // breakdown reachable at all; without it the two questions returned the same
  // rows in the same order, and the answer named the top of the list either way.
  // A time series is a sequence, not a ranking: reversing it would be a
  // different chart, not a different question.
  const ascending = args.direction === 'asc' && (args.group_by ?? 'none') !== 'time';
  const result = ascending && computed.groups.length
    ? { ...computed, groups: [...computed.groups].reverse() }
    : computed;
  // A delta needs two numbers in one currency. When the metric came back as
  // several books there is no single figure to subtract, and quoting one
  // anyway is how a 45%-inflated sum got a growth rate attached to it.
  const change = args.compare !== false && !definition.snapshot && !result.mixedCurrency
    ? (() => {
        const prior = definition.compute({ ...input, window: previousWindow(window), groupBy: 'none' });
        if (prior.mixedCurrency) return null;
        const delta = result.value - prior.value;
        return {
          previous: prior.value,
          previous_formatted: prior.formatted,
          delta,
          percent: prior.value === 0 ? null : Number(((delta / Math.abs(prior.value)) * 100).toFixed(1)),
        };
      })()
    : null;

  // A ranking cut-off the question wrote is a filter on the answer. "Top three
  // accounts" answered with five is the same class of drop as an ignored
  // pipeline, one row further down the page.
  const ranking = Math.min(Math.max(args.limit ?? 5, 1), 25);
  const accounts = args.group_by === 'account' && !result.groups.length
    ? (ascending ? [...topAccounts(input, definition, 1000)].reverse().slice(0, ranking) : topAccounts(input, definition, ranking))
    : [];

  // A grouping that was asked for and never applied has to be said out loud.
  // "What is our win rate by owner" answered with one workspace-wide number is
  // an answer to a different question, and nothing in it tells the reader that
  // the "by owner" half of their sentence was dropped on the way in.
  const requested = args.group_by && args.group_by !== 'none' ? args.group_by : null;
  const dropped = !!requested && !result.groups.length && !accounts.length && result.count > 0
    && !(result.note ?? '').includes(requested);
  const note = dropped
    ? [
        result.note,
        `${result.label} does not break down by ${requested} — nothing behind this number carries that grouping —`,
        `so this is the figure for ${subject?.label ?? workspace.name} as a whole.`,
      ].filter(Boolean).join(' ')
    : result.note;

  const pipelineLabel = args.pipeline ? vocabulary.pipelines.find((p) => p.value === args.pipeline)?.label ?? args.pipeline : null;
  // Read the stage back by the name the scoped pipeline gives it: `discovery`
  // is "Scoping" in Expansion and "Discovery" in New business, and answering
  // one under the other's name misdescribes the rows that were counted.
  const stageLabel = args.stage ? stageLabelIn(vocabulary, args.stage, args.pipeline ?? null) ?? args.stage : null;
  const scope = pipelineLabel || stageLabel
    ? {
        pipeline: args.pipeline ?? null,
        stage: args.stage ?? null,
        label: [
          pipelineLabel ? `in the ${pipelineLabel} pipeline` : '',
          stageLabel ? `at the ${stageLabel} stage` : '',
        ].filter(Boolean).join(' '),
      }
    : null;

  return {
    ...result,
    note,
    scope,
    window: { label: window.label, start: window.start, end: window.end, partial: window.partial },
    change,
    top_accounts: accounts.map((a) => ({ id: a.key, label: a.label, formatted: a.formatted, currency: a.currency })),
    evidence: labelIds(ctx, orgId, result.ids, result.sourceKind === 'invoices' ? 'invoice' : 'record'),
  };
}

/* ------------------------------ metered usage ----------------------------- */

export interface MeteredUsageResult {
  object: 'metered_usage';
  meter: { id: string; name: string; event_name: string; aggregation: string; unit_label: string | null };
  scope: 'workspace' | 'account';
  subject: { id: string; label: string } | null;
  window: { label: string; start: number; end: number };
  value: number;
  formatted: string;
  event_count: number;
  accounts: number;
  /** The accounts behind the number, largest first. */
  by_account: { id: string; label: string; value: number; formatted: string; event_count: number }[];
  /** Stated whenever the aggregation makes a workspace figure mean something particular. */
  note: string | null;
}

/**
 * A count of units, which is not money.
 *
 * `formatMoney` and this function take different types on purpose. A grant of
 * 6,000,000 events rendered as "$60,000.00" is not a formatting slip — it is a
 * currency amount stated where a unit count belongs, and a reader has no way
 * to tell it apart from a real dollar figure.
 */
export const formatUnits = (value: number, unit: string | null, locale: string): string => {
  const number = Number.isInteger(value) ? value.toLocaleString(locale) : Number(value.toFixed(2)).toLocaleString(locale);
  // "49,716,642 event" is the kind of sentence that makes a reader distrust the
  // number in front of it. The meter's unit label is singular by convention.
  if (!unit) return number;
  // "GBs" is not a word. A symbol unit — GB, MB, CPU — is already plural.
  const symbol = unit === unit.toUpperCase() && /^[A-Z]{1,4}$/.test(unit);
  const plural = value === 1 || symbol || /s$/i.test(unit) ? unit : `${unit}s`;
  return `${number} ${plural}`;
};

/**
 * Every account that streamed into one meter over a period.
 *
 * The metering module's own `/v1/meters/:id/customers` reads this from the
 * pre-aggregate; the copilot has to read the same rows or it answers with a
 * different total than the module it is quoting.
 */
function meterCustomerIds(ctx: Ctx, orgId: string, meterId: string, start: number, end: number): string[] {
  if (!hasTable(ctx.db, 'meter_event_summaries')) {
    const billing = ctx.svc.billing;
    return billing ? billing.customers(orgId, { limit: 500 }).map((c) => c.id) : [];
  }
  const HOUR_MS = 3_600_000;
  return ctx.db.all<{ customer_id: string }>(
    `SELECT customer_id FROM meter_event_summaries
     WHERE org_id = ? AND meter_id = ? AND hour_start >= ? AND hour_start < ?
     GROUP BY customer_id
     ORDER BY TOTAL(sum_micro) DESC, COALESCE(SUM(event_count), 0) DESC, customer_id ASC
     LIMIT 500`,
    orgId, meterId, Math.floor(start / HOUR_MS) * HOUR_MS, Math.ceil(end / HOUR_MS) * HOUR_MS,
  ).map((r) => r.customer_id);
}

/**
 * A metering customer id, in the words a reader recognises.
 *
 * The billing book names most of them. An account that meters without an
 * invoicing record still belongs to a company in the CRM, and the resolver
 * finds it from the id the same way it finds a company from a phrase — so
 * `cus_nw_pemberton` reads as "Pemberton Auto Systems" rather than as a primary
 * key. Anything that still cannot be named comes back null, and the caller says
 * so rather than pretending the id is a name.
 */
function meterCustomerLabel(ctx: Ctx, orgId: string, customerId: string): string | null {
  const billed = ctx.svc.billing?.customer(orgId, customerId)?.name ?? customerName(ctx, orgId, customerId);
  if (billed) return billed;
  const hits = resolveEntities(customerId, entityIndex(ctx, orgId), { only: ['company'], limit: 1, minScore: 0.55 });
  return hits[0]?.entity.label ?? null;
}

/**
 * How much of one meter was consumed, over one period.
 *
 * A workspace that sells metered telemetry gets asked "how many telemetry
 * events did we meter last month" constantly, and the only capability the
 * metering module publishes for it takes a single customer — so the question
 * used to reach `list_meters` and come back with the six-line catalogue and no
 * number in it. This sums the meter across the accounts that used it, honouring
 * the meter's own aggregation, and says out loud where a workspace figure means
 * something other than a total.
 */
export function meteredUsage(ctx: Ctx, orgId: string, args: {
  meter: string; customer?: string; start: number; end: number; window_label?: string;
}): MeteredUsageResult | { error: string; meters?: { id: string; name: string; event_name: string }[] } {
  const metering = ctx.svc.metering;
  const workspace = workspaceProfile(ctx, orgId);
  if (!metering) return { error: 'No module in this workspace meters usage, so there is nothing to total.' };
  const meter = metering.meter(orgId, args.meter);
  if (!meter) {
    return {
      error: `No meter in this workspace is called "${args.meter}".`,
      meters: metering.meters(orgId).map((m) => ({ id: m.id, name: m.name, event_name: m.event_name })),
    };
  }
  if (!(args.end > args.start)) return { error: 'The period ends before it starts.' };

  const window = { label: args.window_label ?? 'the selected period', start: args.start, end: args.end };
  const scope: 'workspace' | 'account' = args.customer ? 'account' : 'workspace';
  // The accounts that streamed into this meter, read from the meter's own
  // ledger. Building this list from the billing book instead silently dropped
  // every account that meters without an invoicing record — on the seeded
  // workspace that was 47.5M of 97.2M telemetry events, two of the three
  // biggest consumers, stated as the workspace total with no caveat.
  const customerIds = args.customer ? [args.customer] : meterCustomerIds(ctx, orgId, meter.id, args.start, args.end);

  const rows: MeteredUsageResult['by_account'] = [];
  let events = 0;
  let unnamed = 0;
  for (const customerId of customerIds) {
    const usage = metering.usageForPeriod(orgId, meter.id, customerId, args.start, args.end);
    if (!usage.event_count) continue;
    events += usage.event_count;
    const named = meterCustomerLabel(ctx, orgId, customerId);
    if (!named) unnamed += 1;
    rows.push({
      id: customerId,
      label: named ?? customerId,
      value: usage.value,
      formatted: formatUnits(usage.value, meter.unit_label, workspace.locale),
      event_count: usage.event_count,
    });
  }
  rows.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

  // Each aggregation composes differently across accounts, and three of the
  // five do not compose into "the workspace total" at all without saying so.
  const values = rows.map((r) => r.value);
  const total = values.reduce((a, v) => a + v, 0);
  const value = meter.aggregation === 'max' ? Math.max(0, ...values) : total;
  const unnamedNote = unnamed
    ? `${unnamed} of the ${rows.length} accounts on this meter have no billing customer record, so they are named by their metering id.`
    : null;
  const aggregationNote = scope === 'account' ? null
    : meter.aggregation === 'max'
      ? `${meter.name} records a high-water mark per account, so a workspace figure is the largest single account's peak — ${rows[0]?.label ?? 'no account'} — not a fleet-wide peak, which nothing here records.`
      : meter.aggregation === 'last'
        ? `${meter.name} is a closing reading per account, so the workspace figure is those closing readings added together.`
        : meter.aggregation === 'unique'
          ? `${meter.name} counts distinct subjects inside one account, so the workspace figure adds each account's own distinct count.`
          : null;
  const note = [aggregationNote, unnamedNote].filter(Boolean).join(' ') || null;

  return {
    object: 'metered_usage',
    meter: { id: meter.id, name: meter.name, event_name: meter.event_name, aggregation: meter.aggregation, unit_label: meter.unit_label },
    scope,
    subject: args.customer
      ? { id: args.customer, label: meterCustomerLabel(ctx, orgId, args.customer) ?? args.customer }
      : null,
    window,
    value,
    formatted: formatUnits(value, meter.unit_label, workspace.locale),
    event_count: events,
    accounts: rows.length,
    by_account: rows.slice(0, 8),
    note,
  };
}

/* ------------------------- customers who owe money ------------------------ */

export interface DelinquentCustomersResult {
  object: 'delinquent_customers';
  total: number;
  customers: {
    id: string; name: string; currency: string;
    outstanding: number; outstanding_formatted: string;
    open_invoices: number; oldest_due_at: number | null; days_overdue: number | null;
    past_due_subscriptions: number;
  }[];
}

/**
 * The customers who owe money, from the customer ledger.
 *
 * "Which customers are past due?" was answered from subscription status — a
 * different table about a different thing that happened to hold two rows with
 * the same names. On another book those two sets differ, and the substitution
 * would be invisible: the sentence says customers and the rows are
 * subscriptions.
 */
export function delinquentCustomers(ctx: Ctx, orgId: string, args: { limit?: number } = {}): DelinquentCustomersResult | { error: string } {
  const billing = ctx.svc.billing;
  if (!billing) return { error: 'No module in this workspace keeps a customer ledger, so there is nothing to read.' };
  const workspace = workspaceProfile(ctx, orgId);
  const limit = Math.min(args.limit ?? 20, 50);
  const rows = billing.customers(orgId, { delinquent: true, limit: 200 });
  const customers = rows.map((customer) => {
    const invoices = billing.invoices(orgId, { customer: customer.id, status: 'open_like', limit: 100 })
      .filter((invoice) => invoice.amount_due > 0);
    const outstanding = invoices.reduce((sum, invoice) => sum + invoice.amount_due, 0);
    const dues = invoices.map((i) => i.due_date).filter((d): d is number => typeof d === 'number');
    const oldest = dues.length ? Math.min(...dues) : null;
    const currency = invoices[0]?.currency ?? customer.currency ?? workspace.currency;
    return {
      id: customer.id,
      name: customer.name,
      currency,
      outstanding,
      outstanding_formatted: formatMoney({ amount: outstanding, currency }, { locale: workspace.locale }),
      open_invoices: invoices.length,
      oldest_due_at: oldest,
      days_overdue: oldest && oldest < ctx.now() ? Math.floor((ctx.now() - oldest) / DAY) : null,
      past_due_subscriptions: billing.subscriptions(orgId, { customer: customer.id, limit: 50 })
        .filter((sub) => sub.status === 'past_due').length,
    };
  }).sort((a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name));
  return { object: 'delinquent_customers', total: customers.length, customers: customers.slice(0, limit) };
}

/* ----------------------------- accounts gone quiet ------------------------ */

export interface StaleAccountsResult {
  object: 'stale_accounts';
  threshold_days: number;
  total: number;
  accounts: {
    id: string; name: string; owner: string | null;
    days_since_activity: number | null; last_activity_at: number | null;
    open_pipeline: number; open_pipeline_formatted: string; type: string | null;
  }[];
}

/**
 * Accounts nobody has touched.
 *
 * "Which accounts have gone quiet?" used to come back as the eight most
 * recently created companies, ordered by recency, with no staleness in it at
 * all — while the suggestion feed on the same workspace was already saying
 * "nobody has logged activity on Aconcagua Alimentos in over 45 days". The
 * signal existed and the question could not reach it.
 */
export function staleAccounts(ctx: Ctx, orgId: string, args: { days?: number; limit?: number }): StaleAccountsResult {
  const workspace = workspaceProfile(ctx, orgId);
  const threshold = Math.max(1, args.days ?? 45);
  const cutoff = workspace.now - threshold * DAY;
  const limit = Math.min(args.limit ?? 8, 50);
  const stages = new Set(stageSets(ctx, orgId).open);
  const rows: StaleAccountsResult['accounts'] = [];
  for (const company of fetchRecords(ctx, orgId, { objectType: 'company', limit: 500 })) {
    const last = Number(company.properties.last_activity_at ?? 0) || null;
    // An account nobody has ever touched is quieter than one touched a year
    // ago, so it counts — with a null age rather than an invented one.
    if (last && last > cutoff) continue;
    const open = associatedRecords(ctx, orgId, company.id, 'deal', 40)
      .filter((d) => stages.has(String(d.properties.deal_stage ?? '')))
      .reduce((sum, d) => sum + Number(d.properties.amount ?? 0), 0);
    rows.push({
      id: company.id,
      name: company.display_name,
      owner: personName(workspace, company.owner_id),
      days_since_activity: last ? Math.floor((workspace.now - last) / DAY) : null,
      last_activity_at: last,
      open_pipeline: open,
      open_pipeline_formatted: formatMoney({ amount: open, currency: workspace.currency }, { locale: workspace.locale, trimZeroFraction: true }),
      type: typeof company.properties.type === 'string' ? company.properties.type : null,
    });
  }
  // Quietest first: never touched, then longest since.
  rows.sort((a, b) =>
    (b.days_since_activity ?? Number.MAX_SAFE_INTEGER) - (a.days_since_activity ?? Number.MAX_SAFE_INTEGER)
    || b.open_pipeline - a.open_pipeline
    || a.name.localeCompare(b.name));
  return { object: 'stale_accounts', threshold_days: threshold, total: rows.length, accounts: rows.slice(0, limit) };
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

/**
 * The date window a step was given, if it really has one.
 *
 * Written once because both readers had the same bug: `args.start && args.end`
 * treats the epoch as "no window", which is exactly the bound an open-ended
 * comparator produces.
 */
function datedWindow(args: { start?: number; end?: number; date_property?: string }):
  { property: string; start: number; end: number } | undefined {
  if (!args.date_property || !Number.isFinite(args.start) || !Number.isFinite(args.end)) return undefined;
  return { property: args.date_property, start: args.start as number, end: args.end as number };
}

/** Filtered list of records of one object type — the generic "show me" tool. */
export function recordSearch(ctx: Ctx, orgId: string, args: {
  object_type: string; conditions?: Condition[]; start?: number; end?: number; date_property?: string;
  associated_to?: string; associated_to_any?: string[]; owner_id?: string; limit?: number; order_by?: string; direction?: 'asc' | 'desc';
}): RecordSearchResult {
  const workspace = workspaceProfile(ctx, orgId);
  // `start: 0` is a real bound — "before March 2026" and "all time" both begin
  // at the epoch — and testing it for truthiness dropped the window silently,
  // so "which open deals close before March 2026" listed the whole open book
  // with the period quoted back in the sentence above it.
  const window = datedWindow(args);
  const spec = {
    objectType: args.object_type,
    conditions: args.conditions ?? [],
    window,
    associatedTo: args.associated_to,
    associatedToAny: args.associated_to_any,
    ownerId: args.owner_id,
    limit: Math.min(args.limit ?? 10, 50),
    orderBy: args.order_by,
    // "The smallest open deal" and "the largest open deal" are one query with
    // one word different, and the word was not read: descending was the only
    // order this engine had, so half the ranking questions it answered were
    // answered with their own inverse.
    direction: (args.direction === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc',
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
  /** The same rows, named — a citation reading "matched record" identifies nothing. */
  samples: { id: string; label: string }[];
}

/** Count, sum or average any property of any object type, with grouping. */
export function recordAggregate(ctx: Ctx, orgId: string, args: {
  object_type: string; measure?: 'count' | 'sum' | 'avg' | 'min' | 'max'; property?: string;
  conditions?: Condition[]; group_by?: string; start?: number; end?: number; date_property?: string;
  associated_to?: string; associated_to_any?: string[]; owner_id?: string;
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
    window: datedWindow(args),
    measure: measure === 'count' ? undefined : { property: args.property!, fn: measure },
    groupBy: args.group_by,
    associatedTo: args.associated_to,
    associatedToAny: args.associated_to_any,
    // A rep named in the question is a filter on the count. Without it "how
    // many open deals does Priya have" answered with the workspace's 38.
    ownerId: args.owner_id,
    sampleIds: 6,
  });

  const definition = args.property ? properties.get(args.property) : undefined;
  // An average over no rows is not zero — it does not exist. `aggregate`
  // returns 0 for it, and "$0 in average deal size across 0 closed-won deals"
  // is a figure a reader will quote. The catalogue's own averages refuse this
  // case by name; the row-level path has to refuse it too, or the same measure
  // answers differently depending on which capability the plan reached for.
  if ((measure === 'avg' || measure === 'min' || measure === 'max') && result.count === 0) {
    return {
      error: `No ${args.object_type} rows match that, so there is no ${measure === 'avg' ? 'average' : measure} `
        + `${definition?.label.toLowerCase() ?? args.property} to report — a zero would say the rows measured nothing, and there are no rows.`,
    };
  }
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
    samples: labelIds(ctx, orgId, result.ids, args.object_type).map((row) => ({ id: row.id, label: row.label })),
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
