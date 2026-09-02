/**
 * Structured extraction.
 *
 * When a caller passes `responseSchema`, the answer has to be JSON of exactly
 * that shape. Fields are filled in four passes: business-aware conventions
 * (amount, company, due_date, sentiment…), a deep search of the tool results
 * for a key that means the same thing, an explicit "field: value" scan of the
 * message, and finally the schema's own default. A field that cannot be filled
 * honestly is left null rather than hallucinated, and the caller is told which
 * ones those were.
 */
import type { SchemaNode } from '../../shared/validate';
import { MONEY_PATTERN, EMAIL_PATTERN, contentWords, normalise, sentences, stem, trigramSimilarity } from './text';
import type { WorkspaceProfile } from './grounding';
import type { ResolvedEntity } from './resolve';
import type { TimeWindow } from './dates';
import { parseMoney } from '../../shared/money';

export interface ExtractionContext {
  question: string;
  answer: string;
  workspace: WorkspaceProfile;
  entities: ResolvedEntity[];
  window: TimeWindow;
  results: { tool: string; result: unknown }[];
  metricValue: number | null;
  metricFormatted: string | null;
  /**
   * True when the question was about the metric itself.
   *
   * "What is our MRR?" makes the metric the subject of the run; "summarise the
   * largest open deal" does not, and pasting the run's metric into that deal's
   * `amount` is how a record ends up written with the workspace's total in it.
   */
  metricIsSubject: boolean;
  /** The currencies the metric came back in — more than one means no single figure. */
  metricCurrencies?: string[];
  /** The metric this run computed, so a field named after it can be filled. */
  metricId?: string | null;
  metricLabel?: string | null;
  /**
   * How many rows the figure was computed over, and of what type.
   *
   * A schema field called `deal_count` came back null next to an `open_pipeline`
   * the same aggregate had filled — the count sat in the same object, one key
   * away, because only a field whose name matched the metric's id was looked
   * for.
   */
  rowCount?: number | null;
  rowType?: string | null;
  /** The rep the run was scoped to, when a name in the question put it there. */
  owner?: string | null;
  /**
   * The dimensions this run was scoped to, keyed by the names a schema gives
   * them — `pipeline`, `pipeline_name`, `stage`, `owner`, `account`.
   *
   * A field named for a dimension takes the dimension's value and never the
   * measure's. "pipeline" is the name of a scope and the id of a measure at the
   * same time here, so `{"pipeline": {"type": "string"}}` came back holding
   * "$3,162,060" — money in a field named for a book.
   */
  scope?: Record<string, string>;
  confidence: number;
}

export interface ExtractionOutcome {
  value: unknown;
  filled: string[];
  missing: string[];
}

/**
 * A response schema, in whichever spelling the caller wrote it.
 *
 * This engine's own schema nodes name an object's members `fields`; every other
 * JSON-Schema tool on earth names them `properties`, and a schema written that
 * way used to come back as the JSON literal `null` with a 200 — indistinguishable
 * from "nothing could be extracted". Both spellings are accepted, and an object
 * schema carrying neither is rejected by the caller with the shape named.
 */
export function normaliseResponseSchema(node: unknown): SchemaNode {
  if (!node || typeof node !== 'object') return { type: 'string' };
  const raw = node as Record<string, unknown>;
  const type = typeof raw.type === 'string' ? raw.type : Array.isArray(raw.properties ?? raw.fields) ? 'array' : raw.properties || raw.fields ? 'object' : 'string';
  const out: SchemaNode = { ...(raw as unknown as SchemaNode), type };
  const members = (raw.fields ?? raw.properties) as Record<string, unknown> | undefined;
  if (members && typeof members === 'object') {
    out.fields = Object.fromEntries(Object.entries(members).map(([key, child]) => [key, normaliseResponseSchema(child)]));
  }
  // JSON Schema spells an array's element type `items`.
  const element = (raw.of ?? raw.items) as unknown;
  if (element && typeof element === 'object') out.of = normaliseResponseSchema(element);
  const loose = out as unknown as Record<string, unknown>;
  delete loose.properties;
  delete loose.items;
  delete loose.required;
  return out;
}

/** True when an object schema names no members at all, in either spelling. */
export function schemaNamesNoFields(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const raw = node as Record<string, unknown>;
  if (raw.type !== 'object') return false;
  const members = (raw.fields ?? raw.properties) as Record<string, unknown> | undefined;
  return !members || typeof members !== 'object' || !Object.keys(members).length;
}

const POSITIVE = ['happy', 'great', 'excellent', 'pleased', 'thanks', 'love', 'win', 'won', 'resolved', 'smooth', 'good', 'positive', 'excited'];
const NEGATIVE = ['angry', 'frustrated', 'unhappy', 'broken', 'failed', 'failing', 'churn', 'cancel', 'escalate', 'escalated', 'delay', 'blocked', 'bad', 'terrible', 'disappointed', 'lost'];

function sentimentOf(text: string): 'positive' | 'neutral' | 'negative' {
  const tokens = new Set(contentWords(text).map(stem));
  let score = 0;
  for (const word of POSITIVE) if (tokens.has(stem(word))) score++;
  for (const word of NEGATIVE) if (tokens.has(stem(word))) score--;
  return score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
}

/** Depth-first hunt through tool results for a key that means `name`. */
function findInResults(name: string, results: { tool: string; result: unknown }[]): unknown {
  const target = normalise(name);
  const targetStems = new Set(contentWords(name).map(stem));
  let fallback: unknown;
  const visit = (node: unknown, depth: number): unknown => {
    if (!node || typeof node !== 'object' || depth > 5) return undefined;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 20)) {
        const found = visit(item, depth + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const normalisedKey = normalise(key);
      if (normalisedKey === target) return value;
      if (fallback === undefined && value !== null && typeof value !== 'object') {
        const keyStems = new Set(contentWords(key).map(stem));
        const shared = [...targetStems].filter((t) => keyStems.has(t)).length;
        if (shared && shared === targetStems.size) fallback = value;
        else if (trigramSimilarity(normalisedKey, target) > 0.72) fallback = value;
      }
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = visit(value, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const exact = visit(results.map((r) => r.result), 0);
  return exact !== undefined ? exact : fallback;
}

/** "priority: high" or "Priority — High" written in the message itself. */
function findInMessage(name: string, message: string): string | undefined {
  const label = name.replace(/_/g, '[ _-]');
  const match = message.match(new RegExp(`\\b${label}\\s*[:=—-]\\s*([^\\n,.;]{1,80})`, 'i'));
  return match ? match[1].trim() : undefined;
}

function moneyInText(text: string, currency: string): number | null {
  const match = MONEY_PATTERN.exec(text);
  MONEY_PATTERN.lastIndex = 0;
  if (!match) return null;
  const magnitude = (match[2] || '').toLowerCase();
  const multiplier = magnitude.startsWith('k') || magnitude === 'thousand' ? 1_000
    : magnitude.startsWith('m') || magnitude === 'million' ? 1_000_000
    : magnitude.startsWith('b') || magnitude === 'billion' ? 1_000_000_000 : 1;
  try {
    const base = parseMoney(match[1], currency);
    return base.amount * multiplier;
  } catch { return null; }
}

function coerce(node: SchemaNode, raw: unknown, context: ExtractionContext): unknown {
  if (raw === undefined || raw === null || raw === '') return null;
  switch (node.type) {
    case 'integer':
    case 'number': {
      const value = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.-]/g, ''));
      if (!Number.isFinite(value)) return null;
      return node.type === 'integer' ? Math.round(value) : value;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const text = String(raw).toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(text)) return true;
      if (['false', 'no', 'n', '0'].includes(text)) return false;
      return null;
    }
    case 'array': {
      const items = Array.isArray(raw) ? raw : String(raw).split(/\n|;|,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
      return items.slice(0, node.max ?? 20).map((item) => (node.of ? coerce(node.of, item, context) : item)).filter((v) => v !== null);
    }
    case 'object': {
      if (!node.fields) return typeof raw === 'object' ? raw : null;
      const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.fields)) out[key] = coerce(child, source[key], context);
      return out;
    }
    default: {
      const text = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
      if (node.enum?.length) {
        const normalised = normalise(text);
        return node.enum.find((option) => normalise(option) === normalised)
          ?? node.enum.find((option) => normalised.includes(normalise(option)))
          ?? node.enum.find((option) => trigramSimilarity(option, text) > 0.6)
          ?? null;
      }
      if (node.format === 'unix-ms' || node.type === 'integer') {
        const parsed = Date.parse(text);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return node.max ? text.slice(0, node.max) : text;
    }
  }
}

/**
 * The record a run actually returned of one type, when the question named none.
 *
 * "Summarise the largest open deal" resolves no deal entity — the deal is
 * whatever the search came back with — so `deal_name` had nothing to fill it
 * and came back null beside a correct amount and stage.
 */
function topRecord(context: ExtractionContext, objectType: string): { id?: string; name?: string } | undefined {
  for (const { result } of context.results) {
    if (!result || typeof result !== 'object') continue;
    const list = result as { object_type?: string; records?: { id?: string; name?: string }[] };
    if (list.object_type === objectType && Array.isArray(list.records) && list.records.length) return list.records[0];
    const profile = result as { object_type?: string; id?: string; name?: string };
    if (profile.object_type === objectType && typeof profile.name === 'string') return profile;
  }
  return undefined;
}

/* ------------------------- one record, not several ------------------------ */

/**
 * The record family a field name belongs to.
 *
 * An extraction that fills `deal_name` from one deal and `amount` from another
 * returns a record that never existed — every field individually true, the
 * object as a whole a fabrication. Fields are grouped by the record they
 * describe, and each group is filled from one row.
 */
const FIELD_FAMILY: [RegExp, string][] = [
  [/^(company|account|organisation|organization|customer|company_name|account_name|company_id|account_id|customer_id)$/, 'company'],
  [/^(contact|person|contact_name|full_name|contact_id|person_id|job_title)$/, 'contact'],
  [/^(deal|opportunity|deal_name|deal_id|opportunity_id)$/, 'deal'],
  [/^(ticket|ticket_subject|issue|ticket_id)$/, 'ticket'],
];

/** Most specific first: a schema naming a deal and a company is about the deal. */
const FAMILY_ORDER = ['deal', 'ticket', 'contact', 'company'];

export function fieldFamily(name: string): string | null {
  const key = normalise(name).replace(/\s+/g, '_');
  return FIELD_FAMILY.find(([pattern]) => pattern.test(key))?.[1] ?? null;
}

export interface BoundRows {
  /** One row per record type the run returned, each a real row from the database. */
  rows: Record<string, Record<string, unknown>>;
  /** The record every un-typed field is filled from. */
  primary: string | null;
}

/** Flatten a record row so `properties.amount` answers to `amount`. */
function flatten(row: Record<string, unknown>): Record<string, unknown> {
  const properties = row.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? { ...(properties as Record<string, unknown>), ...row }
    : row;
}

/**
 * The one row per record type this run actually returned.
 *
 * Read from the account profile and from any typed search, so an extraction
 * has a row to bind to rather than a haystack to rummage through.
 */
export function bindRows(context: ExtractionContext, schema: SchemaNode): BoundRows {
  const rows: Record<string, Record<string, unknown>> = {};
  const keep = (type: string, row: unknown) => {
    if (!rows[type] && row && typeof row === 'object') rows[type] = flatten(row as Record<string, unknown>);
  };
  for (const { result } of context.results) {
    if (!result || typeof result !== 'object') continue;
    const payload = result as Record<string, unknown>;
    if (typeof payload.object_type === 'string' && Array.isArray(payload.records)) {
      keep(payload.object_type, (payload.records as unknown[])[0]);
      continue;
    }
    if (typeof payload.object_type === 'string' && typeof payload.name === 'string') {
      keep(payload.object_type, payload);
      // The profile carries the account's own largest deal, first contact and
      // first open ticket. They are real rows on that account, so a schema that
      // names one is filled from it rather than from whatever the run also saw.
      keep('deal', (payload.open_deals as unknown[] | undefined)?.[0]);
      keep('contact', (payload.contacts as unknown[] | undefined)?.[0]);
      keep('ticket', (payload.open_tickets as unknown[] | undefined)?.[0]);
    }
  }
  const named = new Set(Object.keys(schema.fields ?? {}).map(fieldFamily).filter((f): f is string => !!f));
  const primary = FAMILY_ORDER.find((family) => named.has(family) && rows[family])
    ?? FAMILY_ORDER.find((family) => rows[family])
    ?? null;
  return { rows, primary };
}

/** One field, read off one row — by its own name or the row's name for it. */
export function valueIn(name: string, row: Record<string, unknown>): unknown {
  const key = normalise(name).replace(/\s+/g, '_');
  for (const [candidate, value] of Object.entries(row)) {
    if (normalise(candidate).replace(/\s+/g, '_') === key) return value;
  }
  // `deal_name` on a deal row is `name`; `ticket_subject` is `subject`.
  const stripped = key.replace(/^(deal|ticket|company|account|contact|customer|opportunity)_/, '');
  if (stripped !== key) {
    for (const [candidate, value] of Object.entries(row)) {
      if (normalise(candidate).replace(/\s+/g, '_') === stripped) return value;
    }
  }
  return undefined;
}

/** A field's value from the row it is bound to, and from nowhere else. */
function rowValue(name: string, bound: BoundRows, family: string | null): unknown {
  const row = bound.rows[family ?? bound.primary ?? ''];
  return row ? valueIn(name, row) : undefined;
}

function conventionalValue(name: string, node: SchemaNode, context: ExtractionContext): unknown {
  const key = normalise(name).replace(/\s+/g, '_');
  const company = context.entities.find((e) => e.entity.type === 'company' || e.entity.type === 'customer');
  const contact = context.entities.find((e) => e.entity.type === 'contact');
  const deal = context.entities.find((e) => e.entity.type === 'deal');

  if (/^(summary|answer|response|description|text|body|explanation|rationale|analysis)$/.test(key)) return context.answer;
  if (/^(headline|title|subject)$/.test(key)) return sentences(context.answer)[0] ?? context.answer.slice(0, 120);
  if (/^(company|account|organisation|organization|customer|company_name|account_name)$/.test(key)) return company?.entity.label ?? topRecord(context, 'company')?.name;
  if (/^(company_id|account_id|customer_id|record_id)$/.test(key)) return company?.entity.id ?? topRecord(context, 'company')?.id;
  if (/^(contact|person|contact_name|full_name)$/.test(key)) return contact?.entity.label ?? topRecord(context, 'contact')?.name;
  if (/^(contact_id|person_id)$/.test(key)) return contact?.entity.id ?? topRecord(context, 'contact')?.id;
  if (/^(deal|opportunity|deal_name)$/.test(key)) return deal?.entity.label ?? topRecord(context, 'deal')?.name;
  if (/^(deal_id|opportunity_id)$/.test(key)) return deal?.entity.id ?? topRecord(context, 'deal')?.id;
  if (/^(ticket|ticket_subject|issue)$/.test(key)) return topRecord(context, 'ticket')?.name;
  if (/^(email|email_address)$/.test(key)) {
    const inMessage = context.question.match(EMAIL_PATTERN)?.[0];
    return inMessage ?? contact?.entity.aliases.find((a) => a.includes('@')) ?? company?.entity.aliases.find((a) => a.includes('@'));
  }
  if (/^(amount|value|total|revenue|spend|price|cost|sum)$/.test(key)) {
    // The run's metric is only this field's value when the run was ABOUT the
    // metric. Asked to summarise the largest open deal, this returned the whole
    // $9,010,960 pipeline as that deal's `amount` — twelve times its real value,
    // with nothing in `missing` to warn the automation persisting it.
    if (!context.metricIsSubject) {
      return findInResults(name, context.results) ?? moneyInText(context.answer, context.workspace.currency)
        ?? moneyInText(context.question, context.workspace.currency);
    }
    // Several books, no exchange rates, one `amount` field: filling it with the
    // largest one under-reported recurring revenue by a third and flagged
    // nothing. There is no honest single number, so there is no number.
    if (context.metricCurrencies && context.metricCurrencies.length > 1) return undefined;
    return context.metricValue ?? moneyInText(context.question, context.workspace.currency);
  }
  if (/^(currency)$/.test(key)) {
    if (context.metricCurrencies && context.metricCurrencies.length > 1) return undefined;
    return context.metricCurrencies?.[0] ?? context.workspace.currency;
  }
  // A field named after the measure this run computed. `mrr`, `open_pipeline`
  // and `net_revenue_retention` are not conventions this file can enumerate —
  // they are the catalogue's own ids and labels — and each came back null while
  // the engine held the figure two objects away.
  // A field named exactly after the measure this run computed is unambiguous,
  // whatever the verb on the front of the question was: `open_pipeline` can
  // only mean open pipeline. Gating it on the intent left it null under
  // "summarise the open pipeline for Priya Raman" while the engine held it.
  // A field named for a dimension takes the dimension, never the measure that
  // happens to share its id.
  const scoped = context.scope?.[key];
  if (scoped !== undefined) return scoped;
  if (context.metricId) {
    const ids = new Set([normalise(context.metricId), normalise(context.metricLabel ?? '')].filter(Boolean));
    if (ids.has(normalise(name))) {
      if (context.metricCurrencies && context.metricCurrencies.length > 1) return undefined;
      return node.type === 'string' ? context.metricFormatted ?? context.metricValue : context.metricValue;
    }
  }
  // A count field takes the row count the aggregate carries, not the metric's
  // money value. `<type>_count` only counts when the aggregate counted that
  // type — a `ticket_count` filled from a deal aggregate is a wrong number in
  // the right shape.
  const countHit = key.match(/^(?:(\w+)_)?(?:count|records?|rows?)$/) ?? key.match(/^(?:num|no)_(\w+)s?$/);
  if (countHit) {
    const family = countHit[1] ?? '';
    const type = normalise(context.rowType ?? '');
    const generic = !family || /^(record|records|row|rows|result|results|total)$/.test(family);
    if ((generic || (type && (family === type || family === `${type}s` || `${family}s` === type)))
      && typeof context.rowCount === 'number') return context.rowCount;
  }
  if (/^(count|quantity|number|records?)$/.test(key)) return context.metricIsSubject ? context.metricValue : undefined;
  if (/^(period|window|timeframe|period_label)$/.test(key)) return context.window.label;
  if (/^(start|start_date|period_start|from)$/.test(key)) return context.window.start;
  if (/^(end|end_date|period_end|to)$/.test(key)) return context.window.end;
  if (/^(sentiment|mood|tone)$/.test(key)) return sentimentOf(`${context.question} ${context.answer}`);
  if (/^(priority|urgency|severity)$/.test(key)) {
    const text = context.question.toLowerCase();
    if (/\b(urgent|critical|p1|asap|down|outage)\b/.test(text)) return 'urgent';
    if (/\b(high|important|escalat)\b/.test(text)) return 'high';
    if (/\b(low|minor|whenever)\b/.test(text)) return 'low';
    return 'medium';
  }
  // Only a field literally named `confidence`, and only when its description
  // says whose confidence it is. `score` was being filled with the intent
  // router's own certainty: asked for an expansion-risk score on an account,
  // the engine answered 0.3 — how sure it was about the intent — with `risk`
  // and `reason` null beside it. An automation scoring accounts nightly would
  // have persisted router confidence as a business number.
  if (key === 'confidence' && /\b(engine|model|classif|intent|router|answer)\b/i.test(node.description ?? '')) {
    return node.type === 'string' ? String(context.confidence) : context.confidence;
  }
  if (/^(next_steps?|actions?|recommendations?|todos?)$/.test(key)) {
    const bullets = context.answer.split('\n').filter((line) => line.trim().startsWith('•')).map((line) => line.replace(/^[\s•]+/, '').trim());
    return bullets.length ? bullets : sentences(context.answer).slice(-2);
  }
  if (/^(tags|keywords|topics)$/.test(key)) return [...new Set(contentWords(context.question))].slice(0, 6);
  if (/^(owner|assignee|rep|owner_name)$/.test(key)) {
    const profile = context.results.map((r) => r.result).find((r) => r && typeof r === 'object' && 'owner' in (r as object));
    // A run scoped to a rep by name has no account profile to read the owner
    // off; the name in the question is the owner.
    return (profile as { owner?: string } | undefined)?.owner ?? context.owner ?? undefined;
  }
  return undefined;
}

/**
 * The list a run returned, when the caller asked for an array of them.
 *
 * An array schema is a request for rows. Building one element out of run-level
 * facts produced exactly one object with every field null — a shape that
 * validates, means nothing, and looks to an automation like "there is one
 * result and we know nothing about it".
 */
export function listRows(context: ExtractionContext): { rows: Record<string, unknown>[]; tool: string } | null {
  for (const { tool, result } of context.results) {
    if (!result || typeof result !== 'object') continue;
    const payload = result as Record<string, unknown>;
    for (const key of ['records', 'invoices', 'subscriptions', 'items', 'accounts', 'by_account', 'top_accounts', 'groups', 'matches']) {
      const rows = payload[key];
      if (Array.isArray(rows) && rows.length && rows.every((row) => !!row && typeof row === 'object')) {
        return { rows: (rows as Record<string, unknown>[]).map(flatten), tool };
      }
    }
    if (Array.isArray(result) && result.length && result.every((row) => !!row && typeof row === 'object')) {
      return { rows: (result as Record<string, unknown>[]).map(flatten), tool };
    }
  }
  return null;
}

/**
 * The rows a run returned, named, for an array of scalars.
 *
 * `{"deals": {"type": "array", "items": {"type": "string"}}}` over a question
 * that listed five real deals came back as `[]` — the row list was right there
 * in the results and only an array *of objects* was ever read from it. An empty
 * array is indistinguishable from "there are none", which was not the answer.
 */
function rowLabels(name: string, context: ExtractionContext): string[] | null {
  const key = normalise(name).replace(/\s+/g, '_');
  const generic = /^(records?|rows?|results?|items?|matches|list)$/.test(key);
  for (const { result } of context.results) {
    if (!result || typeof result !== 'object') continue;
    const payload = result as { object_type?: string; records?: { name?: string }[]; groups?: { label?: string }[] };
    if (Array.isArray(payload.records) && payload.records.length) {
      const type = normalise(payload.object_type ?? '');
      if (!generic && key !== type && key !== `${type}s`) continue;
      const labels = payload.records.map((r) => r.name).filter((n): n is string => typeof n === 'string');
      if (labels.length) return labels;
    }
    if (Array.isArray(payload.groups) && payload.groups.length && generic) {
      const labels = payload.groups.map((g) => g.label).filter((n): n is string => typeof n === 'string');
      if (labels.length) return labels;
    }
  }
  return null;
}

/** Fill a schema from everything the engine learned during the run. */
export function extractStructured(schema: SchemaNode, context: ExtractionContext): ExtractionOutcome {
  const filled: string[] = [];
  const missing: string[] = [];
  const bound = bindRows(context, schema);

  const build = (node: SchemaNode, name: string, path: string, row?: Record<string, unknown>): unknown => {
    if (node.type === 'object' && node.fields) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.fields)) {
        out[key] = build(child, key, path ? `${path}.${key}` : key, row);
      }
      return out;
    }
    // An array of objects is one object per row of a list the run returned.
    if (node.type === 'array' && node.of?.type === 'object' && node.of.fields && !row) {
      const list = listRows(context);
      if (!list) { missing.push(path || name); return []; }
      filled.push(path || name);
      return list.rows.slice(0, node.max ?? 25).map((one) => build(node.of!, name, path, one));
    }
    // Every field of one object comes from one row. Mixing rows is how an
    // extraction returns a record that never existed: this deal's name beside
    // that deal's amount, each of them separately true.
    const family = fieldFamily(name);
    const source = row ?? bound.rows[family ?? bound.primary ?? ''];
    const candidates = [
      row ? valueIn(name, row) : rowValue(name, bound, family),
      conventionalValue(name, node, context),
      source ? undefined : findInResults(name, context.results),
      findInMessage(name, context.question),
      node.default,
    ];
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) continue;
      const value = coerce(node, candidate, context);
      if (value !== null && !(Array.isArray(value) && !value.length)) {
        filled.push(path || name);
        return value;
      }
    }
    // An array the conventions could not fill is still a request for the rows
    // this run returned, whatever the element type.
    if (node.type === 'array' && !row) {
      const labels = rowLabels(name, context);
      if (labels?.length) {
        filled.push(path || name);
        return labels.slice(0, node.max ?? 25)
          .map((label) => (node.of ? coerce(node.of, label, context) : label))
          .filter((v) => v !== null);
      }
    }
    missing.push(path || name);
    return node.type === 'array' ? [] : null;
  };

  const value = schema.type === 'object' && schema.fields
    ? build(schema, 'root', '')
    : build(schema, 'value', 'value');

  return { value, filled, missing };
}

export { sentimentOf };
