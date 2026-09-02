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
    return (profile as { owner?: string } | undefined)?.owner;
  }
  return undefined;
}

/** Fill a schema from everything the engine learned during the run. */
export function extractStructured(schema: SchemaNode, context: ExtractionContext): ExtractionOutcome {
  const filled: string[] = [];
  const missing: string[] = [];

  const build = (node: SchemaNode, name: string, path: string): unknown => {
    if (node.type === 'object' && node.fields) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.fields)) {
        out[key] = build(child, key, path ? `${path}.${key}` : key);
      }
      return out;
    }
    const candidates = [
      conventionalValue(name, node, context),
      findInResults(name, context.results),
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
    missing.push(path || name);
    return node.type === 'array' ? [] : null;
  };

  const value = schema.type === 'object' && schema.fields
    ? build(schema, 'root', '')
    : build(schema, 'value', 'value');

  return { value, filled, missing };
}

export { sentimentOf };
