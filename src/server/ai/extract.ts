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

/**
 * A number is filled only when the run can account for it.
 *
 * Every numeric field that was not literally named "count" used to be handed
 * the run's one figure, whatever the field was called. Asking for the open
 * pipeline under a schema of `pipeline_value`, `average_deal_size`,
 * `biggest_deal_amount` and `win_rate_percent` answered 901096000 to all four:
 * a win rate of nine hundred million percent, an average deal the size of the
 * whole book, and a biggest deal that is every deal. One of those four numbers
 * was the answer and the schema gave the caller no way to tell which.
 *
 * A field is refused when its own name claims a figure this run did not
 * compute — an average, an extreme, a per-something, a rate, a duration, a
 * score — and the measure does not claim the same thing. "Average deal size"
 * asked of the average-deal-size metric is that metric and is filled; asked of
 * the pipeline total it is a different number and comes back null, named in
 * the run's reasoning beside the fields that were filled.
 *
 * Money stays in minor units, as it is everywhere else in this platform and on
 * every other field of this API: `amount_due` on an invoice and `amount` here
 * are the same money in the same unit, and the run's reasoning names the unit
 * and prints the formatted figure beside it so the raw number cannot be read
 * as major units by mistake.
 */
const COUNT_FIELD = /(^|_)(count|number|total_records|rows|records|how_many|n)($|_)/i;

/** An aggregation over the rows, rather than the aggregation the run performed. */
const OTHER_AGGREGATION = ['average', 'avg', 'mean', 'median', 'typical', 'biggest', 'largest', 'smallest', 'highest', 'lowest', 'min', 'minimum', 'max', 'maximum', 'per', 'each', 'best', 'worst'];
const RATE_WORDS = ['percent', 'pct', 'rate', 'ratio', 'share', 'bps', 'margin', 'conversion'];
const DURATION_WORDS = ['days', 'day', 'weeks', 'months', 'years', 'hours', 'minutes', 'age', 'ageing', 'aging', 'duration'];
const SCORE_WORDS = ['score', 'health', 'nps', 'csat'];

const wordsOf = (text: string | null): Set<string> => new Set(text?.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** True when the run's one figure is an honest answer to a field of this name. */
function accountedFor(name: string, facts: Facts): boolean {
  const field = wordsOf(name);
  const measure = wordsOf(facts.label);
  const claims = (words: string[], units: Facts['unit'][]): boolean =>
    words.some((w) => field.has(w)) && !words.some((w) => measure.has(w)) && !units.includes(facts.unit);
  if (claims(OTHER_AGGREGATION, [])) return false;
  if (claims(RATE_WORDS, ['percent'])) return false;
  if (claims(DURATION_WORDS, ['days', 'hours'])) return false;
  if (claims(SCORE_WORDS, ['score'])) return false;
  return true;
}

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
      if (facts.value === null || facts.mixed || !accountedFor(name, facts)) return null;
      return node.type === 'integer' ? Math.round(facts.value) : facts.value;
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
