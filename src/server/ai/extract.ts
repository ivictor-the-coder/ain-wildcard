/**
 * Structured answers.
 *
 * A `response_schema` is filled from the facts a template run computed — its
 * one figure, the row count behind it, the period and the subject it was
 * measured at, the rows it listed — and from nothing else. A field the facts
 * do not hold comes back `null` and is named in the run's reasoning; nothing is
 * inferred from the wording of the question or the prose of the answer.
 */
import type { SchemaNode } from '../../shared/validate';
import type { Facts } from './answer';

export interface ExtractionOutcome {
  value: unknown;
  filled: string[];
  missing: string[];
}

/**
 * A response schema, in whichever spelling the caller wrote it.
 *
 * This engine's own schema nodes name an object's members `fields`; every other
 * JSON-Schema tool on earth names them `properties`. Both are accepted, and an
 * array's element type may be `of` or `items`.
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

const COUNT_FIELD = /(^|_)(count|number|total_records|rows|records|how_many|n)($|_)/i;
const PERIOD_FIELD = /(period|window|quarter|month|year|date_range|timeframe)/i;
const CURRENCY_FIELD = /currency/i;
const SUBJECT_ID_FIELD = /(company|account|customer|subject|record|contact|deal)_id$/i;
const SUBJECT_FIELD = /(company|account|customer|subject|record|contact|deal|name|who|owner|rep)/i;
const FORMATTED_FIELD = /(formatted|display|text|summary|answer|figure)/i;
const LABEL_FIELD = /(label|metric|measure|kind|what)/i;

function fillField(name: string, node: SchemaNode, facts: Facts, refused: boolean): unknown {
  if (refused) return node.type === 'array' ? [] : node.type === 'object' ? fillObject(node, facts, refused).value : null;
  switch (node.type) {
    case 'object': return fillObject(node, facts, refused).value;
    case 'array': {
      const element = node.of;
      if (element?.type === 'object') return facts.rows.map((row) => ({ id: row.id, name: row.label }));
      return facts.rows.map((row) => row.label);
    }
    case 'number':
    case 'integer': {
      if (COUNT_FIELD.test(name) && facts.count !== null) return facts.count;
      if (facts.value !== null && !facts.mixed) return node.type === 'integer' ? Math.round(facts.value) : facts.value;
      return null;
    }
    case 'string': {
      if (SUBJECT_ID_FIELD.test(name)) return facts.subjectId ?? null;
      if (PERIOD_FIELD.test(name)) return facts.period;
      if (CURRENCY_FIELD.test(name)) return facts.currency;
      if (FORMATTED_FIELD.test(name)) return facts.formatted;
      if (LABEL_FIELD.test(name)) return facts.label;
      if (SUBJECT_FIELD.test(name)) return facts.subject;
      return null;
    }
    default: return null;
  }
}

function fillObject(node: SchemaNode, facts: Facts, refused: boolean): ExtractionOutcome {
  const value: Record<string, unknown> = {};
  const filled: string[] = [];
  const missing: string[] = [];
  for (const [name, child] of Object.entries(node.fields ?? {})) {
    const got = fillField(name, child, facts, refused);
    value[name] = got;
    const empty = got === null || got === undefined || (Array.isArray(got) && !got.length);
    if (empty && child.type !== 'object') missing.push(name);
    else if (child.type !== 'object') filled.push(name);
    if (child.type === 'object') {
      const inner = fillObject(child, facts, refused);
      filled.push(...inner.filled.map((f) => `${name}.${f}`));
      missing.push(...inner.missing.map((f) => `${name}.${f}`));
    }
  }
  return { value, filled, missing };
}

/** Fill a schema from a run's facts. A refused run fills nothing. */
export function fillSchema(schema: SchemaNode, facts: Facts, refused: boolean): ExtractionOutcome {
  if (schema.type === 'object') return fillObject(schema, facts, refused);
  const value = fillField('value', schema, facts, refused);
  const empty = value === null || (Array.isArray(value) && !value.length);
  return { value, filled: empty ? [] : ['value'], missing: empty ? ['value'] : [] };
}
