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
  confidence: number;
}

export interface ExtractionOutcome {
  value: unknown;
  filled: string[];
  missing: string[];
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

function conventionalValue(name: string, node: SchemaNode, context: ExtractionContext): unknown {
  const key = normalise(name).replace(/\s+/g, '_');
  const company = context.entities.find((e) => e.entity.type === 'company' || e.entity.type === 'customer');
  const contact = context.entities.find((e) => e.entity.type === 'contact');
  const deal = context.entities.find((e) => e.entity.type === 'deal');

  if (/^(summary|answer|response|description|text|body|explanation|rationale|analysis)$/.test(key)) return context.answer;
  if (/^(headline|title|subject)$/.test(key)) return sentences(context.answer)[0] ?? context.answer.slice(0, 120);
  if (/^(company|account|organisation|organization|customer|company_name|account_name)$/.test(key)) return company?.entity.label;
  if (/^(company_id|account_id|customer_id|record_id)$/.test(key)) return company?.entity.id;
  if (/^(contact|person|contact_name|full_name)$/.test(key)) return contact?.entity.label;
  if (/^(contact_id|person_id)$/.test(key)) return contact?.entity.id;
  if (/^(deal|opportunity|deal_name)$/.test(key)) return deal?.entity.label;
  if (/^(deal_id|opportunity_id)$/.test(key)) return deal?.entity.id;
  if (/^(email|email_address)$/.test(key)) {
    const inMessage = context.question.match(EMAIL_PATTERN)?.[0];
    return inMessage ?? contact?.entity.aliases.find((a) => a.includes('@')) ?? company?.entity.aliases.find((a) => a.includes('@'));
  }
  if (/^(amount|value|total|revenue|spend|price|cost|sum)$/.test(key)) {
    return context.metricValue ?? moneyInText(context.question, context.workspace.currency);
  }
  if (/^(currency)$/.test(key)) return context.workspace.currency;
  if (/^(count|quantity|number|records?)$/.test(key)) return context.metricValue;
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
  if (/^(confidence|score|certainty)$/.test(key)) return node.type === 'string' ? String(context.confidence) : context.confidence;
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
