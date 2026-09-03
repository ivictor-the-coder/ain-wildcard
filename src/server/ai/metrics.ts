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
import { billingSources, entityIndex, schemaOf, type WorkspaceProfile } from './grounding';
import { resolveEntities } from './resolve';
import { aggregate, associatedRecords, fetchRecords, getRecord, type AggregateResult, type Condition, type RecordSummary } from './query';
import { bucketGrain, type TimeWindow } from './dates';
import { humanise, listPhrase, normalise } from './text';

export type MetricUnit = 'money' | 'count' | 'percent' | 'days' | 'hours' | 'score';
export type GroupBy = 'time' | 'owner' | 'stage' | 'pipeline' | 'industry' | 'account' | 'status' | 'priority' | 'source' | 'none';

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
  /**
   * One book, when the question named one. "What is our MRR in USD?" is a
   * question with a single answer, and returning all three currencies to it is
   * as much a non-answer as adding them together was a wrong one.
   */
  currency?: string | null;
  /**
   * The deal pipeline the question named, as a filter on the rows measured.
   *
   * "What is the Renewal pipeline worth?" is a question about six deals worth
   * $1.46M. Answering it with the workspace's $9.0M open pipeline is a precise
   * answer to a question nobody asked, so a metric built on deals takes the
   * pipeline as an argument and a metric built on anything else refuses it.
   */
  pipeline?: string | null;
  /** The one deal stage the question named, same rule as `pipeline`. */
  stage?: string | null;
}

export interface MetricGroup {
  key: string;
  label: string;
  value: number;
  count: number;
  formatted: string;
  /** The currency this row's money is in. Null for counts, rates and durations. */
  currency: string | null;
}

/**
 * One currency's worth of a money metric.
 *
 * There is no exchange-rate table in this platform, so EUR, GBP and USD are
 * three books, not three parts of one number. Adding them and stamping the
 * workspace's own symbol on the sum reported a 45%-inflated MRR and printed a
 * euro account's revenue with a dollar sign — so a money metric carries its
 * books and the sentence names each one.
 */
export interface MoneyBook {
  currency: string;
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
  /**
   * The money behind this metric, one entry per currency. Empty for a metric
   * that is not money. A caller that needs one scalar may only use `value` when
   * `mixedCurrency` is false.
   */
  books: MoneyBook[];
  /** True when more than one currency is behind the number. */
  mixedCurrency: boolean;
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
  /** The words people use for this measure, published with the catalogue. */
  keywords: string[];
  supportsSubject: boolean;
  /**
   * The rows this metric measures, when a pipeline filter can apply. A metric
   * with no `scope` cannot be narrowed that way and says so rather than
   * ignoring the qualifier.
   */
  scope?: 'deal';
  /**
   * Whether one named stage can replace this metric's own stage set.
   *
   * True for the snapshot measures over open deals. False for closed-won,
   * closed-lost, win rate and the averages, whose stage set *is* their
   * definition — "closed-won bookings in Negotiation" is not a narrower
   * question, it is an empty one, and the honest answer is to refuse it.
   */
  stageFilter?: boolean;
  /** A snapshot metric ignores the window and reports "as of now". */
  snapshot?: boolean;
  compute(input: MetricInput): MetricResult;
}

/* -------------------------------- helpers -------------------------------- */

const money = (amount: number, workspace: WorkspaceProfile, currency?: string | null) =>
  formatMoney({ amount: Math.round(amount), currency: currency ?? workspace.currency }, { locale: workspace.locale, trimZeroFraction: true });

const formatValue = (value: number, unit: MetricUnit, workspace: WorkspaceProfile, currency?: string | null): string => {
  switch (unit) {
    case 'money': return money(value, workspace, currency);
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
      currency: unit === 'money' ? workspace.currency : null,
    }));
}

/**
 * Every currency a set of books is written in, in a stable order so two runs of
 * the same question read the same way.
 */
const currenciesOf = (books: MoneyBook[]): string[] => books.map((b) => b.currency.toUpperCase());

/** Fold per-currency totals into the books a money metric reports. */
function booksFrom(
  totals: Iterable<[string, { value: number; count: number }]>,
  workspace: WorkspaceProfile,
): MoneyBook[] {
  return [...totals]
    .filter(([, row]) => row.count > 0 || row.value !== 0)
    .map(([currency, row]) => ({
      currency,
      value: row.value,
      count: row.count,
      formatted: money(row.value, workspace, currency),
    }))
    // The workspace's own currency leads; the rest follow alphabetically, so
    // the order never depends on which row the database returned first.
    .sort((a, b) =>
      Number(b.currency === workspace.currency) - Number(a.currency === workspace.currency)
      || a.currency.localeCompare(b.currency));
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

/**
 * The pipeline and stage filters the question named, as CRM conditions.
 *
 * A deal-sourced metric is measured over the rows that survive these. A metric
 * that is not deal-sourced never reaches this function — `businessMetric`
 * refuses the qualifier before computing anything, because narrowing invoiced
 * revenue by a deal stage is not a narrower answer, it is a different one.
 */
export function dealScopeConditions(input: MetricInput): Condition[] {
  const out: Condition[] = [];
  if (input.pipeline) out.push({ property: 'pipeline', op: 'eq', value: input.pipeline });
  if (input.stage) out.push({ property: 'deal_stage', op: 'eq', value: input.stage });
  return out;
}

/**
 * A stage the question named replaces the metric's own stage set.
 *
 * "How many deals are in Negotiation?" is not "how many open deals, of which
 * some are in Negotiation" — the named stage *is* the filter, so the metric's
 * open/won/lost condition is dropped in favour of it.
 */
function withDealScope(input: MetricInput, base: Condition[]): Condition[] {
  const scoped = dealScopeConditions(input);
  if (!scoped.length) return base;
  const kept = input.stage ? base.filter((c) => c.property !== 'deal_stage') : base;
  return [...kept, ...scoped];
}

function ownerLabeller(input: MetricInput): (key: string) => string {
  const byId = new Map(input.workspace.people.map((p) => [p.id, p.name]));
  return (key) => byId.get(key) ?? humanise(key);
}

/**
 * Billing customer ids are not names. A breakdown that reads "cus_7zob… $127,840"
 * is a database row leaking into a sentence a board sees, so every account group
 * is resolved back to the customer's own name before it reaches the answer.
 */
function customerLabeller(input: MetricInput): (key: string) => string {
  const customers = billingSources(input.ctx.db).customers;
  if (!customers?.nameColumn) return (key) => humanise(key);
  const byId = new Map<string, string>();
  for (const row of input.ctx.db.all<{ id: string; nm: string | null }>(
    `SELECT id, ${customers.nameColumn} AS nm FROM ${customers.table} WHERE org_id = ?`, input.workspace.orgId)) {
    if (row.nm) byId.set(row.id, row.nm);
  }
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
    case 'pipeline': return { groupBy: 'pipeline' };
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
    .map(([key, v]) => ({ key, label: names.get(key) ?? 'Unassigned', value: v.value, count: v.count, formatted: formatValue(v.value, unit, workspace), currency: unit === 'money' ? workspace.currency : null }))
    .sort((a, b) => b.value - a.value);
}

/* ------------------------------ money sources ----------------------------- */

export interface InvoiceFacts {
  available: boolean;
  total: number;
  count: number;
  ids: string[];
  groups: { key: string; value: number; count: number; currency: string | null }[];
  /** One entry per currency the matched invoices were raised in. */
  books: { currency: string; value: number; count: number }[];
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
  if (!ids.size) for (const id of meteringCustomerIds(ctx, orgId, subject)) ids.add(id);
  return [...ids];
}

/**
 * The metering ids an account streams under, when the billing book has no row
 * for it.
 *
 * A workspace can meter an account it has never invoiced — the seeded telemetry
 * stream has two of them, and they are the second and third biggest consumers
 * on the meter. Asking "how much telemetry did Pemberton meter" and being told
 * no customer could be identified is a refusal about a row that exists.
 */
export function meteringCustomerIds(ctx: Ctx, orgId: string, subject: MetricSubject): string[] {
  if (!schemaOf(ctx.db).tables.has('meter_event_summaries')) return [];
  const rows = ctx.db.all<{ customer_id: string }>(
    `SELECT DISTINCT customer_id FROM meter_event_summaries WHERE org_id = ? LIMIT 500`, orgId);
  if (!rows.length) return [];
  const index = entityIndex(ctx, orgId);
  const ids: string[] = [];
  for (const row of rows) {
    const hit = resolveEntities(row.customer_id, index, { only: ['company', 'customer'], limit: 1, minScore: 0.55 })[0];
    if (hit && (hit.entity.id === subject.id || normalise(hit.entity.label) === normalise(subject.label))) ids.push(row.customer_id);
  }
  return ids;
}

/** Sum invoices from whichever billing schema this workspace actually has. */
export function invoiceFacts(
  input: MetricInput,
  opts: { paidOnly?: boolean; outstanding?: boolean; overdue?: boolean } = {},
): InvoiceFacts {
  const { ctx, workspace, window, subject } = input;
  const sources = billingSources(ctx.db);
  const invoices = sources.invoices;
  if (!invoices) return { available: false, total: 0, count: 0, ids: [], groups: [], books: [], label: 'no invoice table in this workspace' };

  const amountColumn = opts.paidOnly && invoices.paidColumn ? invoices.paidColumn : invoices.amountColumn;
  // Cash collected is dated by when it was paid; everything else is dated by
  // when the bill was raised. An unpaid invoice has no payment date, so dating
  // the outstanding book on `paid_at` excludes every row it is asking about.
  const dateColumn = opts.paidOnly && invoices.paidDateColumn ? invoices.paidDateColumn : invoices.issuedDateColumn;
  // What is owed is owed today, whatever period the question named: an invoice
  // raised last year and still open is money the business is still owed.
  const windowed = !opts.outstanding;
  const where: string[] = [`org_id = ?`];
  const params: unknown[] = [workspace.orgId];
  // Overdue is a date test, not a status one. "How many overdue invoices are
  // there?" was answered with the whole open book — 7 invoices in three
  // currencies — when 1 of them was actually late; the other 6 are inside their
  // terms and calling them overdue is a claim about the customers who owe them.
  if (opts.overdue) {
    if (!invoices.dueDateColumn) {
      return { available: false, total: 0, count: 0, ids: [], groups: [], books: [], label: 'no due date on invoices in this workspace' };
    }
    where.push(`${invoices.dueDateColumn} IS NOT NULL`, `${invoices.dueDateColumn} < ?`);
    params.push(workspace.now);
  }
  if (windowed) {
    where.push(`${dateColumn} >= ?`, `${dateColumn} < ?`);
    params.push(window.start, window.end);
  }

  if (invoices.statusColumn) {
    if (opts.outstanding) { where.push(`${invoices.statusColumn} IN ('open', 'past_due', 'unpaid', 'uncollectible')`); }
    else if (opts.paidOnly) { where.push(`${invoices.statusColumn} = 'paid'`); }
    else { where.push(`${invoices.statusColumn} NOT IN ('draft', 'void', 'deleted')`); }
  }
  if (input.currency && invoices.currencyColumn) {
    where.push(`${invoices.currencyColumn} = ?`);
    params.push(input.currency);
  }
  const customerIds = linkedCustomerIds(ctx, workspace.orgId, subject);
  if (subject && invoices.customerColumn) {
    if (!customerIds.length) return { available: true, total: 0, count: 0, ids: [], groups: [], books: [], label: `${subject.label} has no billing account` };
    where.push(`${invoices.customerColumn} IN (${customerIds.map(() => '?').join(', ')})`);
    params.push(...customerIds);
  }

  const whereSql = where.join(' AND ');
  // Every money figure is grouped by the currency the bill was raised in. A
  // bare `SUM(total)` over a book that holds euros, sterling and dollars is a
  // number in no currency at all, and it was being printed with the
  // workspace's own symbol on the front of it.
  const currencyColumn = invoices.currencyColumn;
  const byCurrency = ctx.db.all<{ c: string | null; v: number | null; n: number }>(
    `SELECT ${currencyColumn ?? `'${workspace.currency}'`} AS c, SUM(${amountColumn}) AS v, COUNT(*) AS n
     FROM ${invoices.table} WHERE ${whereSql} GROUP BY c ORDER BY c`, ...(params as never[]),
  );
  const books = byCurrency
    .map((row) => ({ currency: (row.c ?? workspace.currency).toLowerCase(), value: Number(row.v ?? 0), count: Number(row.n) }))
    .filter((row) => row.count > 0);
  const count = books.reduce((a, b) => a + b.count, 0);
  const home = books.find((b) => b.currency === workspace.currency);
  const ids = ctx.db.all<{ id: string }>(
    `SELECT id FROM ${invoices.table} WHERE ${whereSql} ORDER BY ${dateColumn} DESC LIMIT 8`, ...(params as never[])).map((r) => r.id);

  const currencyKey = currencyColumn ?? `'${workspace.currency}'`;
  const grouped = (keyExpr: string, order: string, limit = ''): { key: string; value: number; count: number; currency: string | null }[] =>
    ctx.db.all<{ k: string; c: string | null; v: number | null; n: number }>(
      `SELECT ${keyExpr} AS k, ${currencyKey} AS c, SUM(${amountColumn}) AS v, COUNT(*) AS n
       FROM ${invoices.table} WHERE ${whereSql} GROUP BY k, c ORDER BY ${order}${limit}`, ...(params as never[]),
    ).map((r) => ({ key: r.k, value: Number(r.v ?? 0), count: r.n, currency: (r.c ?? workspace.currency).toLowerCase() }));

  let groups: { key: string; value: number; count: number; currency: string | null }[] = [];
  if (input.groupBy === 'time') {
    const format = bucketGrain(window) === 'day' ? '%Y-%m-%d' : bucketGrain(window) === 'year' ? '%Y' : '%Y-%m';
    groups = grouped(`strftime('${format}', ${dateColumn} / 1000, 'unixepoch')`, 'k');
  } else if (input.groupBy === 'account' && invoices.customerColumn) {
    groups = grouped(invoices.customerColumn, 'v DESC', ' LIMIT 40');
  } else if (input.groupBy === 'status' && invoices.statusColumn) {
    groups = grouped(invoices.statusColumn, 'v DESC');
  }

  const kind = opts.overdue ? 'overdue' : opts.outstanding ? 'outstanding' : opts.paidOnly ? 'paid' : 'issued';
  return {
    available: true,
    // Only ever the workspace's own book: a caller that wants the rest reads
    // `books`, and one that reads this scalar gets a number in one currency.
    total: home?.value ?? (books.length === 1 ? books[0].value : 0),
    count,
    ids,
    groups,
    books,
    label: `${count} ${kind} ${count === 1 ? 'invoice' : 'invoices'}`,
  };
}

function result(input: MetricInput, def: Pick<MetricDefinition, 'id' | 'label' | 'unit'> & { snapshot?: boolean }, fields: {
  value: number; count: number; source: string; sourceKind: MetricResult['sourceKind'];
  groups?: MetricGroup[]; ids?: string[]; note?: string | null;
  /** Per-currency totals. Given by every money metric that reads real money. */
  books?: MoneyBook[];
  /**
   * Set by a rate that is only defined inside one currency. There is no single
   * figure, so `value` must never be printed: the per-currency groups are the
   * answer, exactly as they are for a mixed money metric.
   */
  perCurrencyOnly?: boolean;
}): MetricResult {
  const books = def.unit === 'money' ? fields.books ?? [] : [];
  const mixed = books.length > 1 || !!fields.perCurrencyOnly;
  const single = books.length === 1 ? books[0] : null;
  // With one book the metric speaks that currency, whatever the workspace's
  // default is; with several there is no single figure and the sentence has to
  // say all of them rather than a sum stamped with the workspace's symbol.
  const currency = def.unit !== 'money' ? null : single ? single.currency : mixed ? null : input.workspace.currency;
  const formatted = fields.perCurrencyOnly
    ? listPhrase((fields.groups ?? []).map((g) => `${g.formatted} in ${g.key.toUpperCase()}`))
    : mixed
      ? listPhrase(books.map((b) => b.formatted))
      : formatValue(fields.value, def.unit, input.workspace, currency);
  const scopedNote = input.currency && def.unit === 'money'
    ? `Scoped to the ${input.currency.toUpperCase()} book, which is the currency you named — the other books are not in this figure.`
    : null;
  const mixedNote = mixed && !fields.perCurrencyOnly
    ? `${input.workspace.name} bills in ${listPhrase(currenciesOf(books))} and this platform holds no exchange rates,`
      + ` so there is no single ${def.label.toLowerCase()} figure — one book per currency: ${listPhrase(books.map((b) => `${b.formatted} (${b.currency.toUpperCase()}, ${b.count} ${b.count === 1 ? 'row' : 'rows'})`))}.`
      + ` They are not added together.`
    : null;
  return {
    metric: def.id,
    label: def.label,
    unit: def.unit,
    value: fields.value,
    formatted,
    currency,
    count: fields.count,
    source: fields.source,
    sourceKind: fields.sourceKind,
    window: input.window,
    subject: input.subject ?? null,
    groups: fields.groups ?? [],
    ids: fields.ids ?? [],
    books,
    mixedCurrency: mixed,
    note: [scopedNote, mixedNote, fields.note ?? null].filter(Boolean).join(' ') || null,
    snapshot: !!(def as { snapshot?: boolean }).snapshot,
  };
}

/**
 * Recurring revenue, taken from the billing module's own normalisation.
 *
 * MRR is not a column anywhere: a subscription is priced through its items, and
 * only the ledger knows how a quarterly price annualises or which statuses
 * count as revenue. Asking the service that owns those rules is what makes the
 * copilot and `GET /v1/subscriptions/overview` quote the same number to the
 * cent. With no ledger published, the metric says so instead of reporting zero.
 */
function recurringRevenue(input: MetricInput, months: 1 | 12): MetricResult {
  const def = {
    snapshot: true,
    id: months === 12 ? 'arr' : 'mrr',
    label: months === 12 ? 'Annual recurring revenue' : 'Monthly recurring revenue',
    unit: 'money' as const,
  };
  const orgId = input.workspace.orgId;
  const billing = input.ctx.svc.billing;
  if (!billing) {
    return result(input, def, {
      value: 0, count: 0, source: 'no subscription ledger in this workspace', sourceKind: 'unavailable',
      note: 'Recurring revenue needs a subscription ledger and no module in this workspace publishes one. Closed-won bookings and open pipeline are available instead.',
    });
  }
  const customerIds = new Set(linkedCustomerIds(input.ctx, orgId, input.subject));
  if (input.subject && !customerIds.size) {
    return result(input, def, {
      value: 0, count: 0, source: `${input.subject.label} has no billing account`, sourceKind: 'subscriptions',
      note: `${input.subject.label} is in the CRM but has no customer in the subscription ledger, so it carries no recurring revenue.`,
    });
  }

  const perCustomer = new Map<string, { value: number; count: number; currency: string }>();
  // A subscription is priced in one currency and there is no rate table here,
  // so recurring revenue is a book per currency rather than one addition.
  const perCurrency = new Map<string, { value: number; count: number }>();
  const ids: string[] = [];
  let counted = 0;
  for (const sub of billing.subscriptions(orgId, { status: 'all', limit: 500 })) {
    if (input.subject && !customerIds.has(sub.customer)) continue;
    // The ledger returns 0 for a status that is not billing — cancelled,
    // trialing, incomplete — so a subscription only counts when it is earning.
    const monthly = billing.mrr(orgId, sub);
    if (monthly <= 0) continue;
    const currency = (sub.currency || input.workspace.currency).toLowerCase();
    if (input.currency && currency !== input.currency) continue;
    counted += 1;
    ids.push(sub.id);
    const book = perCurrency.get(currency) ?? { value: 0, count: 0 };
    book.value += monthly * months;
    book.count += 1;
    perCurrency.set(currency, book);
    const bucket = perCustomer.get(sub.customer) ?? { value: 0, count: 0, currency };
    bucket.value += monthly * months;
    bucket.count += 1;
    perCustomer.set(sub.customer, bucket);
  }
  const books = booksFrom(perCurrency, input.workspace);

  const groups: MetricGroup[] = input.groupBy === 'account'
    ? [...perCustomer.entries()]
        .map(([customerId, row]) => ({
          key: customerId,
          label: billing.customer(orgId, customerId)?.name ?? customerId,
          value: row.value,
          count: row.count,
          formatted: formatValue(row.value, 'money', input.workspace, row.currency),
          currency: row.currency,
        }))
        .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
        .slice(0, 12)
    : [];

  return result(input, def, {
    value: books.find((b) => b.currency === input.workspace.currency)?.value ?? (books.length === 1 ? books[0].value : 0),
    count: counted,
    ids: ids.slice(0, 12),
    groups,
    books,
    source: `${counted} ${counted === 1 ? 'subscription' : 'subscriptions'} still billing`,
    sourceKind: 'subscriptions',
  });
}

/**
 * A ratio, broken down.
 *
 * A win rate is not a summable quantity: you cannot allocate the workspace's
 * 66.7% across four owners, because each owner's rate is their own won over
 * their own decided. So a grouped ratio is recomputed inside every group from
 * the deals that group actually decided — and where the grouping key is not
 * carried on a deal at all, the metric says so rather than dropping the request
 * on the floor and returning the workspace figure as if it had been asked for.
 */
function ratioGroups(
  input: MetricInput,
  stages: StageSets,
  window: { property: string; start: number; end: number },
  scope: { associatedTo?: string },
): { groups: MetricGroup[]; note: string | null } {
  const groupBy = input.groupBy ?? 'none';
  if (groupBy === 'none') return { groups: [], note: null };

  const subject = input.subject ? input.subject.label : input.workspace.name;
  const refuse = (why: string): { groups: MetricGroup[]; note: string | null } => ({
    groups: [],
    note: `Win rate cannot be broken down by ${groupBy}: ${why}. This is the rate for ${subject} as a whole.`,
  });
  if (groupBy === 'stage') return refuse('a decided deal sits in a won or lost stage, so the split would only restate the outcome');
  if (groupBy === 'account') return refuse('the rate per account is won over decided inside each account, and a deal carries the account as an association rather than a value this can group on');
  if (groupBy === 'industry') return refuse('industry is a property of the company, not of the deal that was won or lost');
  if (groupBy === 'status' || groupBy === 'priority') return refuse('that is a ticket property, and a win rate is computed from deals');

  const rows = fetchRecords(input.ctx, input.workspace.orgId, {
    objectType: 'deal',
    conditions: [{ property: 'deal_stage', op: 'in', values: [...stages.won, ...stages.lost] }],
    window,
    ...scope,
    limit: 2000,
  });
  // The same bucket keys the SQL grouping produces, so a grouped ratio and a
  // grouped sum label their periods identically.
  const grain = bucketGrain(input.window);
  const bucketKey = (at: number): string => {
    const iso = new Date(at).toISOString();
    return grain === 'day' ? iso.slice(0, 10) : grain === 'year' ? iso.slice(0, 4) : iso.slice(0, 7);
  };
  const keyOf = (row: RecordSummary): string | null => {
    if (groupBy === 'owner') return row.owner_id ?? 'unassigned';
    if (groupBy === 'source') return String(row.properties.lead_source ?? '—');
    if (groupBy === 'pipeline') return String(row.properties.pipeline ?? '—');
    const closed = Number(row.properties.close_date ?? 0);
    return closed ? bucketKey(closed) : null;
  };
  const owners = ownerLabeller(input);
  const buckets = new Map<string, { won: number; decided: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const bucket = buckets.get(key) ?? { won: 0, decided: 0 };
    bucket.decided += 1;
    if (stages.won.includes(String(row.properties.deal_stage ?? ''))) bucket.won += 1;
    buckets.set(key, bucket);
  }
  const label = (key: string): string => {
    if (groupBy === 'owner') return key === 'unassigned' ? 'Unassigned' : owners(key);
    if (groupBy === 'time') return timeLabeller()(key);
    return humanise(key);
  };
  const groups = [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: label(key),
      value: (bucket.won / bucket.decided) * 100,
      count: bucket.decided,
      formatted: formatValue((bucket.won / bucket.decided) * 100, 'percent', input.workspace),
      currency: null,
    }))
    .sort((a, b) => (groupBy === 'time' ? a.key.localeCompare(b.key) : b.value - a.value || a.label.localeCompare(b.label)));
  if (!groups.length) return { groups, note: null };
  return {
    groups,
    // Said every time, because a reader who adds these rows up gets a number
    // that means nothing and no warning that it does.
    note: `Win rate is a ratio, so each row is that ${groupBy === 'time' ? 'period' : groupBy}'s own won-of-decided count — the rows do not sum to the rate for ${subject}.`,
  };
}

/* ------------------------------- definitions ------------------------------ */

function moneyIn(
  input: MetricInput,
  opts: { paidOnly?: boolean; outstanding?: boolean; overdue?: boolean },
  def: Pick<MetricDefinition, 'id' | 'label' | 'unit'> & { snapshot?: boolean },
): MetricResult {
  const invoices = invoiceFacts(input, opts);
  if (invoices.available) {
    const labeller = input.groupBy === 'time'
      ? timeLabeller()
      : input.groupBy === 'account'
        ? customerLabeller(input)
        : (key: string) => humanise(key);
    const books = booksFrom(
      invoices.books.map((b) => [b.currency, { value: b.value, count: b.count }] as const),
      input.workspace,
    );
    return result(input, def, {
      value: invoices.total,
      count: invoices.count,
      source: invoices.label,
      sourceKind: 'invoices',
      ids: invoices.ids,
      books,
      note: def.snapshot
        ? opts.overdue
          ? 'Overdue is what is late right now — every open invoice whose due date has passed — so it ignores the reporting period, and it is a smaller set than the outstanding book.'
          : 'Outstanding balance is what is owed right now — every invoice still open, whenever it was raised — so it ignores the reporting period.'
        : null,
      groups: invoices.groups.map((g) => ({
        key: g.key,
        label: labeller(g.key),
        value: g.value,
        count: g.count,
        formatted: money(g.value, input.workspace, g.currency),
        currency: g.currency,
      })),
    });
  }
  // No billing tables: closed-won deals are the honest stand-in, and we say so.
  // That stand-in is a period figure whatever the metric normally is, so the
  // snapshot claim is dropped with the source it belonged to.
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
  return result(input, { ...def, snapshot: false }, {
    value: agg.value,
    count: agg.count,
    source: `${agg.count} closed-won ${agg.count === 1 ? 'deal' : 'deals'}`,
    sourceKind: 'deals',
    ids: agg.ids,
    groups,
    note: 'Measured from closed-won deals: this workspace has no invoice ledger installed.',
  });
}

/**
 * Churn and retention, from the revenue module's own recognition ledger.
 *
 * "What is our churn rate?" used to be refused with "I could not tell which
 * measure you want" next to a menu that contained no churn measure at all —
 * which describes the user as vague when the truth was that the measure was
 * unreachable. The arithmetic already existed: `revenue.churn` computes logo
 * churn, gross and net revenue retention over the same book the invoices come
 * from, with the numerator and denominator kept beside every rate.
 *
 * Logo churn is a ratio of account counts, so it holds across currencies. Every
 * revenue-weighted rate is money in disguise, so it is reported per currency and
 * never averaged into one figure.
 */
function retentionMetric(input: MetricInput, kind: 'churn' | 'nrr' | 'grr'): MetricResult {
  const def = {
    id: kind === 'churn' ? 'churn' : kind === 'nrr' ? 'net_revenue_retention' : 'gross_revenue_retention',
    label: kind === 'churn' ? 'Logo churn' : kind === 'nrr' ? 'Net revenue retention' : 'Gross revenue retention',
    unit: 'percent' as const,
  };
  const revenue = input.ctx.svc.revenue;
  if (!revenue) {
    return result(input, def, {
      value: 0, count: 0, source: 'no revenue ledger in this workspace', sourceKind: 'unavailable',
      note: `${def.label} is computed from month-by-month MRR movement, and no module in this workspace publishes one.`,
    });
  }
  const report = revenue.churn(input.workspace.orgId, { from: input.window.start, to: input.window.end });
  const totals = report.totals;
  const months = report.series.filter((row) => row.complete).length;
  if (!months) {
    return result(input, def, {
      value: 0, count: 0, source: 'no completed month in this period', sourceKind: 'subscriptions',
      note: `${def.label} is measured over completed months, and ${input.window.label} contains none yet.`,
    });
  }

  const pick = (row: { logo_churn: { bps: number; undefined_rate: boolean }; gross_revenue_retention: { bps: number; undefined_rate: boolean } | null; net_revenue_retention: { bps: number; undefined_rate: boolean } | null }) =>
    kind === 'churn' ? row.logo_churn : kind === 'nrr' ? row.net_revenue_retention : row.gross_revenue_retention;

  const whole = pick(totals);
  // A revenue-weighted rate is only defined inside one currency, so the
  // workspace figure is null in a mixed book and the per-currency rows are the
  // answer — the same rule the money metrics follow.
  const groups: MetricGroup[] = kind === 'churn' ? [] : report.by_currency
    .map((part) => ({ part, rate: pick(part.totals) }))
    .filter((row): row is { part: typeof row.part; rate: { bps: number; undefined_rate: boolean; percent: string } } => !!row.rate && !row.rate.undefined_rate)
    .map(({ part, rate }) => ({
      key: part.currency,
      label: part.currency.toUpperCase(),
      value: rate.bps / 100,
      count: months,
      formatted: rate.percent,
      currency: part.currency,
    }))
    .sort((a, b) => b.value - a.value);

  const defined = !!whole && !whole.undefined_rate;
  const scoped = defined ? whole!.bps / 100 : groups.length === 1 ? groups[0].value : 0;
  const note = kind === 'churn'
    ? `Logo churn is accounts that ended a month with no recurring revenue over accounts that started it with some, weighted across ${countOfMonths(months)}. An account with several subscriptions churns only when the last of them stops.`
    : whole && !whole.undefined_rate
      ? `${def.label} is measured from opening MRR, so new business is never in it.`
      : `${def.label} is a revenue-weighted rate, and this workspace bills in ${listPhrase(report.by_currency.map((p) => p.currency.toUpperCase()))} with no exchange rates behind them — so there is one rate per currency and no single figure.`;

  return result(input, def, {
    value: scoped,
    count: months,
    groups,
    perCurrencyOnly: !defined && groups.length > 1,
    source: `${months} completed ${months === 1 ? 'month' : 'months'} of MRR movement`,
    sourceKind: 'subscriptions',
    note,
  });
}

const countOfMonths = (n: number): string => `${n} completed ${n === 1 ? 'month' : 'months'}`;

const DEFS: MetricDefinition[] = [
  {
    id: 'spend', label: 'Customer spend', unit: 'money', supportsSubject: true,
    // "How much did <account> pay us last year?" is customer spend, and it was
    // refused by a sentence that then offered "customer spend" one line later.
    keywords: ['spend', 'spent', 'paid', 'pay us', 'billed'],
    compute: (input) => moneyIn(input, { paidOnly: true }, { id: 'spend', label: 'Customer spend', unit: 'money' }),
  },
  {
    id: 'revenue', label: 'Revenue', unit: 'money', supportsSubject: true,
    keywords: ['revenue', 'billings', 'collected'],
    compute: (input) => moneyIn(input, { paidOnly: true }, { id: 'revenue', label: 'Revenue', unit: 'money' }),
  },
  {
    id: 'invoiced', label: 'Invoiced', unit: 'money', supportsSubject: true,
    keywords: ['invoiced', 'invoices'],
    compute: (input) => moneyIn(input, {}, { id: 'invoiced', label: 'Invoiced', unit: 'money' }),
  },
  {
    id: 'outstanding', label: 'Outstanding balance', unit: 'money', supportsSubject: true, snapshot: true,
    // "Overdue" and "past due" are not here, and the omission is the measure.
    // They select the invoices whose due date has passed; this one selects
    // every invoice still open. Answering the first question with the second
    // called six invoices inside their terms late, and quoted €1,007 and £1,560
    // of money nobody is late on.
    keywords: ['outstanding', 'unpaid', 'receivables'],
    compute: (input) => moneyIn(input, { outstanding: true }, { id: 'outstanding', label: 'Outstanding balance', unit: 'money', snapshot: true }),
  },
  {
    id: 'overdue', label: 'Overdue balance', unit: 'money', supportsSubject: true, snapshot: true,
    keywords: ['overdue', 'past due', 'arrears', 'delinquent'],
    compute: (input) => moneyIn(input, { outstanding: true, overdue: true }, { id: 'overdue', label: 'Overdue balance', unit: 'money', snapshot: true }),
  },
  {
    id: 'pipeline', label: 'Open pipeline', unit: 'money', supportsSubject: true, snapshot: true,
    scope: 'deal', stageFilter: true,
    keywords: ['pipeline', 'open deals', 'worth'],
    compute: (input) => {
      const scope = subjectScope(input);
      const conditions: Condition[] = withDealScope(input,
        [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).open }]);
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
    scope: 'deal', stageFilter: true,
    // "What is our forecast for this quarter?" is the question a sales leader
    // asks most often. It was refused as an unrecognised measure — in a
    // sentence that offered "weighted pipeline" by name two lines below.
    keywords: ['weighted', 'forecast'],
    compute: (input) => {
      const scope = subjectScope(input);
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'deal',
        conditions: withDealScope(input, [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).open }]),
        measure: { property: 'weighted_amount', fn: 'sum' }, sampleIds: 8, ...scope, ...groupSpec(input, 'close_date'),
      });
      return result(input, { snapshot: true, id: 'weighted_pipeline', label: 'Weighted pipeline', unit: 'money' }, {
        value: agg.value, count: agg.count, ids: agg.ids,
        groups: groupsFrom(agg, 'money', input.workspace, input.groupBy === 'time' ? timeLabeller() : undefined),
        source: `${agg.count} open ${agg.count === 1 ? 'deal' : 'deals'} weighted by probability`, sourceKind: 'deals',
        note: 'Weighted pipeline is every open deal multiplied by its stage probability, as it stands today — a snapshot of the whole book, not a total for one close-date window.',
      });
    },
  },
  {
    id: 'closed_won', label: 'Closed-won bookings', unit: 'money', supportsSubject: true, scope: 'deal',
    // "Book" is a verb here and a noun three lines down: "how much did we
    // book" is closed-won bookings, "the Renewal book" is a pipeline's open
    // value. Matching the bare token either way scored 0.72 on "how much is
    // the Renewal book worth?", flipped the measure to bookings and dropped
    // the scope — so the verb has to have a subject in front of it.
    keywords: ['closed won', 'bookings', 'won'],
    compute: (input) => {
      const scope = subjectScope(input);
      const conditions: Condition[] = withDealScope(input,
        [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).won }]);
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
    id: 'closed_lost', label: 'Closed-lost value', unit: 'money', supportsSubject: true, scope: 'deal',
    keywords: ['lost'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'deal',
        conditions: withDealScope(input, [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).lost }]),
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
    id: 'win_rate', label: 'Win rate', unit: 'percent', supportsSubject: true, scope: 'deal',
    keywords: ['win rate'],
    compute: (input) => {
      const window = { property: 'close_date', start: input.window.start, end: input.window.end };
      const scope = subjectScope(input);
      const stages = stageSets(input.ctx, input.workspace.orgId);
      const won = aggregate(input.ctx, input.workspace.orgId, { objectType: 'deal', conditions: withDealScope(input, [{ property: 'deal_stage', op: 'in', values: stages.won }]), window, sampleIds: 5, ...scope });
      const lost = aggregate(input.ctx, input.workspace.orgId, { objectType: 'deal', conditions: withDealScope(input, [{ property: 'deal_stage', op: 'in', values: stages.lost }]), window, ...scope });
      const decided = won.count + lost.count;
      const grouped = ratioGroups(input, stages, window, scope);
      return result(input, { id: 'win_rate', label: 'Win rate', unit: 'percent' }, {
        value: decided ? (won.count / decided) * 100 : 0,
        count: decided, ids: won.ids,
        groups: grouped.groups,
        source: `${won.count} won of ${decided} decided ${decided === 1 ? 'deal' : 'deals'}`, sourceKind: 'deals',
        note: decided === 0 ? 'No deals reached a decision in this period.' : grouped.note,
      });
    },
  },
  {
    id: 'avg_deal_size', label: 'Average deal size', unit: 'money', supportsSubject: true, scope: 'deal',
    keywords: ['average deal', 'deal size'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'deal',
        conditions: withDealScope(input, [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).won }]),
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
    id: 'sales_cycle', label: 'Average sales cycle', unit: 'days', supportsSubject: true, scope: 'deal',
    keywords: ['sales cycle'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'deal',
        conditions: withDealScope(input, [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).won }]),
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
    scope: 'deal', stageFilter: true,
    // "How many open deals does Priya have" names this metric, not open
    // pipeline: the longest phrase written wins, so the count beats the money.
    keywords: ['deals'],
    compute: (input) => {
      const agg = aggregate(input.ctx, input.workspace.orgId, {
        objectType: 'deal',
        conditions: withDealScope(input, [{ property: 'deal_stage', op: 'in', values: stageSets(input.ctx, input.workspace.orgId).open }]),
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
        if (agg.count) groups.push({ key: type, label: humanise(`${type}s`), value: agg.count, count: agg.count, formatted: String(agg.count), currency: null });
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
    id: 'churn', label: 'Logo churn', unit: 'percent', supportsSubject: false,
    keywords: ['churn', 'logo churn', 'attrition'],
    compute: (input) => retentionMetric(input, 'churn'),
  },
  {
    id: 'net_revenue_retention', label: 'Net revenue retention', unit: 'percent', supportsSubject: false,
    keywords: ['nrr', 'net revenue retention'],
    compute: (input) => retentionMetric(input, 'nrr'),
  },
  {
    id: 'gross_revenue_retention', label: 'Gross revenue retention', unit: 'percent', supportsSubject: false,
    keywords: ['grr', 'gross revenue retention', 'retention'],
    compute: (input) => retentionMetric(input, 'grr'),
  },
  {
    id: 'mrr', label: 'Monthly recurring revenue', unit: 'money', supportsSubject: true, snapshot: true,
    keywords: ['mrr'],
    compute: (input) => recurringRevenue(input, 1),
  },
  {
    id: 'arr', label: 'Annual recurring revenue', unit: 'money', supportsSubject: true, snapshot: true,
    keywords: ['arr'],
    compute: (input) => recurringRevenue(input, 12),
  },
];

/**
 * Measures that are *undefined* over no rows rather than zero.
 *
 * A sum over nothing is zero: nothing was booked, and saying so is true. An
 * average over nothing is not zero — "Northwind has no average deal size in the
 * Expansion pipeline, so the honest answer is zero" says every deal in that
 * book is worth nothing, about a book carrying $3,162,060. A ratio with an
 * empty denominator is the same shape of falsehood, and the win rate already
 * refused it; every average has to refuse it too.
 */
const UNDEFINED_AT_ZERO = new Set([
  'win_rate', 'avg_deal_size', 'sales_cycle', 'resolution_time', 'csat',
  'churn', 'net_revenue_retention', 'gross_revenue_retention',
]);

export const metricUndefinedWhenEmpty = (id: string | null | undefined): boolean =>
  !!id && UNDEFINED_AT_ZERO.has(id);

export const METRICS: MetricDefinition[] = DEFS;
export const metricById = (id: string): MetricDefinition | undefined => DEFS.find((d) => d.id === id);
export const metricIds = (): string[] => DEFS.map((d) => d.id);

/** Top accounts for a metric — the "who" behind an aggregate. */
export function topAccounts(input: MetricInput, metric: MetricDefinition, limit = 5): MetricGroup[] {
  if (!['spend', 'revenue', 'invoiced', 'closed_won', 'pipeline', 'open_tickets'].includes(metric.id)) return [];
  const companies = fetchRecords(input.ctx, input.workspace.orgId, { objectType: 'company', limit: 400 });
  const rows: MetricGroup[] = [];
  for (const company of companies) {
    const scoped = metric.compute({ ...input, subject: { id: company.id, type: 'company', label: company.display_name }, groupBy: 'none' });
    if (scoped.value > 0) {
      rows.push({
        key: company.id, label: company.display_name, value: scoped.value, count: scoped.count,
        formatted: scoped.formatted, currency: scoped.currency,
      });
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
