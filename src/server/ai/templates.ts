/**
 * The template whitelist.
 *
 * A template is a question shape with typed slots — "how many {object} are
 * {state}", "what is the {pipeline} pipeline worth" — and each one compiles to
 * exactly one plan with every argument bound from its slots. Matching is
 * normalisation plus exact shape: the words of the question, minus politeness,
 * must equal a pattern with its slots filled. Not fuzzy, never a best partial
 * match. If nothing matches, the answer is a refusal that hands the reader the
 * three nearest shapes as concrete questions this workspace can answer.
 *
 * There are no default slot values. A shape that needs a period has {period}
 * in it, and a question without one does not match that shape.
 */
import type { WorkspaceProfile } from './grounding';
import type { Condition } from './query';
import type { TimeWindow } from './dates';
import type {
  AccountProfileResult, DelinquentCustomersResult, MeteredUsageResult, MetricToolResult, RecordAggregateResult,
  RecordSearchResult, StaleAccountsResult, TimelineItem,
} from './functions';
import type { DraftResult } from './draft';
import { linkedCustomerIds } from './metrics';
import { plural, humanise, listPhrase } from './text';
import {
  bind, bindsAnywhere, bound, slotSpan, stripPoliteness, tokenise,
  type Bindings, type Bound, type SlotKind, type SlotValue, type Token, type Vocabulary,
} from './slots';
import {
  NO_FACTS, citationsOf, dateOf, money, periodPhrase, renderAggregateCount, renderAggregateMeasure, renderBreakdown,
  renderCompare, renderCount, renderDelinquent, renderDraft, renderField, renderGroupedCount, renderInvoices, renderList,
  renderMetric, renderPrices, renderProfile, renderQuote, renderRank, renderStale, renderSubscriptions, renderTimeline,
  renderUsage, type InvoiceRow, type Rendered, type SubscriptionRow,
} from './answer';

/* --------------------------------- types --------------------------------- */

export interface PlanStep { tool: string; args: Record<string, unknown>; why: string }

export interface StepOutcome {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  ms: number;
}

export type TemplateKind =
  | 'count' | 'list' | 'metric' | 'breakdown' | 'rank' | 'compare' | 'lookup' | 'usage' | 'quote' | 'ledger' | 'draft' | 'write';

export type TemplateIntent = 'lookup' | 'aggregate' | 'compare' | 'draft' | 'act' | 'summarise';

export interface Template {
  id: string;
  kind: TemplateKind;
  intent: TemplateIntent;
  description: string;
  patterns: string[];
  /** Tool names the plan calls; a run that cannot reach them is not offered this shape. */
  tools: string[];
  example(v: Vocabulary): string | null;
  /** A reason the bound slots cannot be answered together, or null. */
  check?(b: Bindings, v: Vocabulary): string | null;
  plan(b: Bindings, v: Vocabulary): PlanStep[];
  render(steps: StepOutcome[], b: Bindings, v: Vocabulary): Rendered;
}

/* --------------------------------- DSL ----------------------------------- */

type Element =
  | { kind: 'lit'; word: string }
  | { kind: 'slot'; name: string; slot: SlotKind }
  | { kind: 'alt'; options: string[][] };

const parsed = new Map<string, Element[]>();

export function parsePattern(src: string): Element[] {
  const cached = parsed.get(src);
  if (cached) return cached;
  const out: Element[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ') { i++; continue; }
    if (ch === '{') {
      const end = src.indexOf('}', i);
      const [name, kind] = src.slice(i + 1, end).split(':');
      out.push({ kind: 'slot', name, slot: (kind ?? name) as SlotKind });
      i = end + 1;
      continue;
    }
    if (ch === '(') {
      const end = src.indexOf(')', i);
      out.push({ kind: 'alt', options: src.slice(i + 1, end).split('|').map((o) => o.trim().split(/\s+/).filter(Boolean)) });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < src.length && src[j] !== ' ') j++;
    out.push({ kind: 'lit', word: src.slice(i, j) });
    i = j;
  }
  parsed.set(src, out);
  return out;
}

/** The literal words a pattern carries, for ranking the nearest shapes. */
function literalWords(src: string): string[] {
  const words: string[] = [];
  for (const el of parsePattern(src)) {
    if (el.kind === 'lit') words.push(el.word);
    if (el.kind === 'alt') for (const option of el.options) words.push(...option);
  }
  return words;
}

/* ------------------------------- matching -------------------------------- */

interface MatchResult { template: Template; bindings: Bindings; slotWords: number }

function matchElements(
  els: Element[], ei: number, tokens: Token[], ti: number, raw: string, vocab: Vocabulary,
  acc: Bindings, check: (b: Bindings) => boolean,
): Bindings | null {
  if (ei === els.length) return ti === tokens.length && check(acc) ? acc : null;
  const el = els[ei];
  if (el.kind === 'lit') {
    return tokens[ti]?.text === el.word ? matchElements(els, ei + 1, tokens, ti + 1, raw, vocab, acc, check) : null;
  }
  if (el.kind === 'alt') {
    for (const option of el.options) {
      if (!option.every((w, k) => tokens[ti + k]?.text === w)) continue;
      const found = matchElements(els, ei + 1, tokens, ti + option.length, raw, vocab, acc, check);
      if (found) return found;
    }
    return null;
  }
  const remaining = tokens.length - ti;
  if (el.slot === 'text') {
    if (remaining < 1 || ei !== els.length - 1) return null;
    const values = bind('text', tokens, ti, remaining, raw, vocab);
    if (!values.length) return null;
    const complete = { ...acc, [el.name]: bound(el.name, 'text', tokens, ti, remaining, raw, values[0]) };
    return check(complete) ? complete : null;
  }
  const span = slotSpan(el.slot, vocab);
  // Longest first, so "closed won deals" is one state and not "closed" plus a
  // word nothing binds.
  for (let len = Math.min(span.max, remaining); len >= span.min; len--) {
    for (const value of bind(el.slot, tokens, ti, len, raw, vocab)) {
      const next = { ...acc, [el.name]: bound(el.name, el.slot, tokens, ti, len, raw, value) };
      const found = matchElements(els, ei + 1, tokens, ti + len, raw, vocab, next, check);
      if (found) return found;
    }
  }
  return null;
}

/** A state and an object bound in one sentence must be about the same object. */
function consistent(b: Bindings): boolean {
  const object = Object.values(b).find((x) => x.value.kind === 'object')?.value as (SlotValue & { kind: 'object' }) | undefined;
  if (!object) return true;
  for (const one of Object.values(b)) {
    if (one.value.kind === 'state' && one.value.objectType !== object.type) return false;
    if (one.value.kind === 'option' && one.value.objectType !== object.type) return false;
    if (one.value.kind === 'property' && one.value.objectType !== object.type) return false;
  }
  return true;
}

export interface MatchOutcome {
  match: MatchResult | null;
  /** A shape whose words fitted but whose slots cannot be answered together. */
  rejected: { template: Template; reason: string }[];
  tokens: Token[];
}

/** The one template the question is, or nothing. */
export function matchTemplates(question: string, vocab: Vocabulary, catalogue: Template[]): MatchOutcome {
  const raw = question;
  const tokens = stripPoliteness(tokenise(raw));
  const rejected: { template: Template; reason: string }[] = [];
  const matches: MatchResult[] = [];
  for (const template of catalogue) {
    for (const pattern of template.patterns) {
      let reason: string | null = null;
      const found = matchElements(parsePattern(pattern), 0, tokens, 0, raw, vocab, {}, (b) => {
        if (!consistent(b)) return false;
        reason = template.check?.(b, vocab) ?? null;
        return reason === null;
      });
      if (found) {
        const slotWords = Object.values(found).reduce((sum, one) => sum + one.text.split(' ').length, 0);
        // The whole normalised sentence, for a plan that reads a literal word
        // its pattern accepted — "paid" against "issued", "total" against "average".
        const question = tokens.map((t) => t.text).join(' ');
        found.$question = { name: '$question', slot: 'text', text: question, raw, value: { kind: 'text', text: question }, qualifier: null };
        matches.push({ template, bindings: found, slotWords });
        break;
      }
      if (reason) rejected.push({ template, reason });
    }
  }
  // The shape with the most literal words wins a tie: it is the more specific
  // question. Catalogue order settles the rest, so the same sentence always
  // takes the same shape.
  matches.sort((a, b) => a.slotWords - b.slotWords);
  return { match: matches[0] ?? null, rejected, tokens };
}

/* ------------------------------- nearest --------------------------------- */

const FURNITURE = new Set(['the', 'a', 'an', 'our', 'my', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'we', 'of', 'in', 'to', 'for', 'and', 'on', 'at', 'by', 'with']);

export interface Nearest { id: string; example: string; overlap: number }

/**
 * The three shapes closest to what was typed, as concrete questions: ranked by
 * word overlap with each shape's example and literal words, and lifted when the
 * question already contains something that binds one of the shape's slots.
 */
export function nearestTemplates(question: string, tokens: Token[], vocab: Vocabulary, catalogue: Template[], limit = 3): Nearest[] {
  const raw = question;
  const asked = new Set(tokens.map((t) => t.text).filter((w) => !FURNITURE.has(w)));
  const bindable = new Map<SlotKind, boolean>();
  const bindsSomewhere = (kind: SlotKind): boolean => {
    const held = bindable.get(kind);
    if (held !== undefined) return held;
    const result = bindsAnywhere(kind, tokens, raw, vocab);
    bindable.set(kind, result);
    return result;
  };
  const scored: (Nearest & { order: number })[] = [];
  catalogue.forEach((template, order) => {
    const example = template.example(vocab);
    if (!example) return;
    const words = new Set<string>();
    for (const w of tokenise(example)) if (!FURNITURE.has(w.text)) words.add(w.text);
    for (const pattern of template.patterns) for (const w of literalWords(pattern)) if (!FURNITURE.has(w)) words.add(w);
    let shared = 0;
    for (const w of asked) if (words.has(w)) shared++;
    const union = new Set([...asked, ...words]).size || 1;
    let score = shared / union;
    const slots = new Set<SlotKind>();
    for (const pattern of template.patterns) for (const el of parsePattern(pattern)) if (el.kind === 'slot') slots.add(el.slot);
    // A slot the question already fills is a hint, never the whole ranking:
    // "my" binding the asker as an owner must not outrank the words typed.
    for (const slot of slots) if (bindsSomewhere(slot)) score += shared ? 0.08 : 0.02;
    scored.push({ id: template.id, example, overlap: Math.round(score * 1000) / 1000, order });
  });
  scored.sort((a, b) => b.overlap - a.overlap || a.order - b.order);
  return scored.slice(0, limit).map(({ id, example, overlap }) => ({ id, example, overlap }));
}

/* ------------------------------- helpers --------------------------------- */

type Of<K extends SlotValue['kind']> = Extract<SlotValue, { kind: K }>;

function slot<K extends SlotValue['kind']>(b: Bindings, name: string, kind: K): Of<K> {
  const held = b[name];
  if (!held || held.value.kind !== kind) throw new Error(`template slot "${name}" is not bound as ${kind}`);
  return held.value as Of<K>;
}

const maybe = <K extends SlotValue['kind']>(b: Bindings, name: string, kind: K): Of<K> | null =>
  (b[name] && b[name].value.kind === kind ? (b[name].value as Of<K>) : null);

const resultOf = <T>(steps: StepOutcome[], index = 0): T => steps[index].result as T;

const OUR = '(our|the|my|)';
const WHAT_IS = '(what is|what are|whats|tell me|show me)';
const WHAT_WAS = '(what was|what were|what is|what are|whats|tell me|show me)';
const LIST = '(list|show me|show|give me|what are)';

const thingOf = (state: Of<'state'> | null, object: Of<'object'>): string =>
  (state ? `${state.noun} ${object.singular}|${state.noun} ${object.plural}` : `${object.singular}|${object.plural}`);

const dealThing = (state: Of<'state'> | null): string => (state ? `${state.noun} deal|${state.noun} deals` : 'deal|deals');

const windowArgs = (w: TimeWindow) => ({ start: w.start, end: w.end, window_label: w.label });

const closeWindow = (w: TimeWindow) => ({ date_property: 'close_date', start: w.start, end: w.end });

const ORDER_BY: Record<string, string | undefined> = { deal: 'amount' };

function searchArgs(object: string, conditions: Condition[], extra: Record<string, unknown> = {}, limit = 10): Record<string, unknown> {
  return { object_type: object, conditions, limit, ...(ORDER_BY[object] ? { order_by: ORDER_BY[object], direction: 'desc' } : {}), ...extra };
}

const countArgs = (object: string, conditions: Condition[], extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ object_type: object, measure: 'count', conditions, ...extra });

const BREAKDOWNS: Record<string, string[]> = {
  pipeline: ['owner', 'stage', 'pipeline', 'source', 'account'],
  weighted_pipeline: ['stage', 'pipeline', 'source'],
  closed_won: ['owner', 'pipeline', 'source', 'account', 'stage'],
  closed_lost: ['pipeline', 'source', 'stage'],
  win_rate: ['owner', 'source', 'pipeline'],
  deal_count: ['stage', 'pipeline', 'source'],
  revenue: ['account', 'status'],
  invoiced: ['account', 'status'],
  spend: ['account'],
  outstanding: ['account', 'status'],
  overdue: ['account', 'status'],
  mrr: ['account'],
  arr: ['account'],
  customers: ['industry'],
  new_customers: ['industry'],
  connected_assets: ['industry'],
  open_tickets: ['status', 'priority'],
};

/** Which end of the year the examples point at: a completed one, with data in it. */
const exampleYear = (v: Vocabulary): number => new Date(v.workspace.now).getUTCFullYear() - 1;

interface Samples {
  account: string | null;
  contact: string | null;
  deal: string | null;
  owner: string | null;
  pipeline: string | null;
  stage: string | null;
  meter: string | null;
  pricedMeter: string | null;
  plan: string | null;
  currency: string | null;
  industry: string | null;
  source: string | null;
  competitor: string | null;
  forecast: string | null;
  region: string | null;
  year: number;
}

const sampleCache = new WeakMap<Vocabulary['phrases'], Samples>();

function firstKey(v: Vocabulary, kind: SlotKind, prefer?: (key: string, value: SlotValue) => boolean): string | null {
  const map = v.phrases.get(kind);
  if (!map) return null;
  const keys = [...map.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (prefer) {
    for (const key of keys) if (map.get(key)!.some((value) => prefer(key, value))) return key;
  }
  return keys[0] ?? null;
}

function labelOf(v: Vocabulary, kind: SlotKind, key: string | null): string | null {
  if (!key) return null;
  const value = v.phrases.get(kind)?.get(key)?.[0];
  if (!value) return null;
  switch (value.kind) {
    case 'record': return value.label;
    case 'owner': return value.name;
    case 'pipeline': return value.label;
    case 'stage': return value.label;
    case 'meter': return value.name;
    case 'plan': return value.name;
    case 'option': return value.label;
    default: return key;
  }
}

export function samplesOf(v: Vocabulary): Samples {
  const held = sampleCache.get(v.phrases);
  if (held) return held;
  const companies = v.records.filter((r) => r.type === 'company').map((r) => r.label).sort();
  const customers = new Set(v.records.filter((r) => r.type === 'customer').map((r) => r.label));
  const account = companies.find((label) => customers.has(label)) ?? companies[0] ?? null;
  const contact = v.records.filter((r) => r.type === 'contact').map((r) => r.label).sort()[0] ?? null;
  const deal = v.records.filter((r) => r.type === 'deal').map((r) => r.label).sort()[0] ?? null;
  const owner = [...v.people].sort((a, b) => a.name.localeCompare(b.name))[0]?.name ?? null;
  const pipeline = v.crm.pipelines[0]?.label ?? null;
  const stage = v.crm.stages.find((s) => !s.closed && s.label.toLowerCase() === 'negotiation')?.label
    ?? v.crm.stages.find((s) => !s.closed)?.label ?? null;
  const priced = v.meters.find((m) => m.priceKey);
  const samples: Samples = {
    account, contact, deal, owner, pipeline, stage,
    meter: v.meters[0]?.name ?? null,
    pricedMeter: priced?.name ?? null,
    plan: labelOf(v, 'plan', firstKey(v, 'plan')),
    currency: (v.currencies.find((c) => c !== v.workspace.currency) ?? v.currencies[0] ?? null)?.toUpperCase() ?? null,
    industry: labelOf(v, 'industry', firstKey(v, 'industry')),
    source: labelOf(v, 'lead-source', firstKey(v, 'lead-source')),
    competitor: labelOf(v, 'competitor', firstKey(v, 'competitor')),
    forecast: labelOf(v, 'forecast-category', firstKey(v, 'forecast-category', (_, value) => value.kind === 'option' && value.value === 'commit')),
    region: labelOf(v, 'region', firstKey(v, 'region')),
    year: exampleYear(v),
  };
  sampleCache.set(v.phrases, samples);
  return samples;
}

const need = (...parts: (string | number | null)[]): string | null =>
  (parts.some((p) => p === null) ? null : parts.join(''));

/* ----------------------------- the catalogue ----------------------------- */

const T = (t: Template): Template => t;

/** Everything the state and object slots turned into, for a count or a list. */
function stateScope(b: Bindings): { object: Of<'object'>; state: Of<'state'> | null; conditions: Condition[]; scope: string } {
  const object = slot(b, 'object', 'object');
  const state = maybe(b, 'state', 'state');
  return { object, state, conditions: state?.conditions ?? [], scope: '' };
}

const ownerScope = (owner: Of<'owner'>): string => `owned by ${owner.name}`;

export const TEMPLATES: Template[] = [
  /* ------------------------------ CRM counts ----------------------------- */
  T({
    id: 'count-objects', kind: 'count', intent: 'aggregate',
    description: 'How many records of one object type the workspace holds.',
    patterns: [
      `how many {object} (are there|do we have|exist|are in the workspace|are in the crm|)`,
      `${WHAT_IS} the (number|total number|count) of {object}`,
      `count ${OUR} {object}`,
    ],
    tools: ['record_aggregate'],
    example: () => 'How many deals are there?',
    plan: (b) => {
      const { object } = stateScope(b);
      return [{ tool: 'record_aggregate', args: countArgs(object.type, []), why: `Count every ${object.singular} record.` }];
    },
    render: (steps, b, v) => {
      const { object } = stateScope(b);
      return renderAggregateCount(resultOf<RecordAggregateResult>(steps), thingOf(null, object), '', v.workspace);
    },
  }),
  T({
    id: 'count-state-objects', kind: 'count', intent: 'aggregate',
    description: 'How many records are in one lifecycle state — open deals, escalated tickets, prospect companies.',
    patterns: [
      `how many {state} {object} (are there|do we have|exist|) (in total|altogether|overall|)`,
      `how many {object} are {state} (in total|altogether|overall|)`,
      `${WHAT_IS} the (number|count) of {state} {object}`,
      `count ${OUR} {state} {object}`,
    ],
    tools: ['record_aggregate'],
    example: () => 'How many deals are closed won?',
    plan: (b) => {
      const { object, state, conditions } = stateScope(b);
      return [{ tool: 'record_aggregate', args: countArgs(object.type, conditions), why: `Count ${object.plural} whose ${state!.label} state holds.` }];
    },
    render: (steps, b, v) => {
      const { object, state } = stateScope(b);
      return renderAggregateCount(resultOf<RecordAggregateResult>(steps), thingOf(state, object), '', v.workspace);
    },
  }),
  T({
    id: 'list-objects', kind: 'list', intent: 'lookup',
    description: 'List records of one object type.',
    patterns: [`${LIST} (the|our|all|all the|all of the|every|) {object}`],
    tools: ['record_search'],
    example: () => 'List the companies',
    plan: (b) => {
      const { object } = stateScope(b);
      return [{ tool: 'record_search', args: searchArgs(object.type, []), why: `List ${object.plural}.` }];
    },
    render: (steps, b, v) => {
      const { object } = stateScope(b);
      return renderList(resultOf<RecordSearchResult>(steps), thingOf(null, object), '', v.workspace);
    },
  }),
  T({
    id: 'list-state-objects', kind: 'list', intent: 'lookup',
    description: 'List the records in one lifecycle state.',
    patterns: [
      `${LIST} (the|our|all|all the|all of the|every|) {state} {object}`,
      `which {object} are {state}`,
      `what {object} are {state}`,
    ],
    tools: ['record_search'],
    example: () => 'Which tickets are escalated?',
    plan: (b) => {
      const { object, state, conditions } = stateScope(b);
      return [{ tool: 'record_search', args: searchArgs(object.type, conditions), why: `List ${state!.label} ${object.plural}.` }];
    },
    render: (steps, b, v) => {
      const { object, state } = stateScope(b);
      return renderList(resultOf<RecordSearchResult>(steps), thingOf(state, object), '', v.workspace);
    },
  }),
  T({
    id: 'count-owner-objects', kind: 'count', intent: 'aggregate',
    description: 'How many records one teammate owns, optionally in one state.',
    patterns: [
      `how many {state} {object} does {owner} (own|have)`,
      `how many {object} does {owner} (own|have)`,
      `how many {state} {object} (is|are) {owner} (working on|on|carrying)`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How many open deals does ', samplesOf(v).owner, ' own?'),
    plan: (b) => {
      const { object, conditions } = stateScope(b);
      const owner = slot(b, 'owner', 'owner');
      return [{ tool: 'record_aggregate', args: countArgs(object.type, conditions, { owner_id: owner.id }), why: `Count ${object.plural} owned by ${owner.name}.` }];
    },
    render: (steps, b, v) => {
      const { object, state } = stateScope(b);
      const owner = slot(b, 'owner', 'owner');
      return renderAggregateCount(resultOf<RecordAggregateResult>(steps), thingOf(state, object), ownerScope(owner), v.workspace, { subject: owner.name });
    },
  }),
  T({
    id: 'list-owner-objects', kind: 'list', intent: 'lookup',
    description: 'The records one teammate owns, optionally in one state.',
    patterns: [
      `(which|what) {state} {object} does {owner} (own|have)`,
      `(which|what) {object} does {owner} (own|have)`,
      `${LIST} {owner} {state} {object}`,
      `${LIST} {owner} {object}`,
    ],
    tools: ['record_search'],
    example: (v) => need('Which open deals does ', samplesOf(v).owner, ' own?'),
    plan: (b) => {
      const { object, conditions } = stateScope(b);
      const owner = slot(b, 'owner', 'owner');
      return [{ tool: 'record_search', args: searchArgs(object.type, conditions, { owner_id: owner.id }), why: `List ${object.plural} owned by ${owner.name}.` }];
    },
    render: (steps, b, v) => {
      const { object, state } = stateScope(b);
      const owner = slot(b, 'owner', 'owner');
      return renderList(resultOf<RecordSearchResult>(steps), thingOf(state, object), ownerScope(owner), v.workspace, { subject: owner.name });
    },
  }),

  /* ------------------------------- thresholds ---------------------------- */
  T({
    id: 'count-deals-threshold', kind: 'count', intent: 'aggregate',
    description: 'How many deals are worth more or less than an amount.',
    patterns: [
      `how many {state:deal-state} deals are (worth|) {comparator} {money}`,
      `how many deals are (worth|) {comparator} {money}`,
    ],
    tools: ['record_aggregate'],
    example: () => 'How many open deals are worth more than $500,000?',
    plan: (b) => {
      const state = maybe(b, 'state', 'state');
      const comparator = slot(b, 'comparator', 'comparator');
      const amount = slot(b, 'money', 'money');
      return [{ tool: 'record_aggregate', args: countArgs('deal', [...(state?.conditions ?? []), { property: 'amount', op: comparator.op, value: amount.amount }]), why: `Count deals with an amount ${comparator.label} ${amount.formatted}.` }];
    },
    render: (steps, b, v) => {
      const comparator = slot(b, 'comparator', 'comparator');
      const amount = slot(b, 'money', 'money');
      return renderAggregateCount(resultOf<RecordAggregateResult>(steps), dealThing(maybe(b, 'state', 'state')), `worth ${comparator.label} ${amount.formatted}`, v.workspace);
    },
  }),
  T({
    id: 'list-deals-threshold', kind: 'list', intent: 'lookup',
    description: 'The deals worth more or less than an amount.',
    patterns: [
      `(which|what) {state:deal-state} deals are (worth|) {comparator} {money}`,
      `(which|what) deals are (worth|) {comparator} {money}`,
      `${LIST} (the|) {state:deal-state} deals (worth|) {comparator} {money}`,
      `${LIST} (the|) deals (worth|) {comparator} {money}`,
    ],
    tools: ['record_search'],
    example: () => 'Which open deals are worth more than $500,000?',
    plan: (b) => {
      const state = maybe(b, 'state', 'state');
      const comparator = slot(b, 'comparator', 'comparator');
      const amount = slot(b, 'money', 'money');
      return [{ tool: 'record_search', args: searchArgs('deal', [...(state?.conditions ?? []), { property: 'amount', op: comparator.op, value: amount.amount }]), why: `List deals with an amount ${comparator.label} ${amount.formatted}.` }];
    },
    render: (steps, b, v) => {
      const comparator = slot(b, 'comparator', 'comparator');
      const amount = slot(b, 'money', 'money');
      return renderList(resultOf<RecordSearchResult>(steps), dealThing(maybe(b, 'state', 'state')), `worth ${comparator.label} ${amount.formatted}`, v.workspace);
    },
  }),

  /* ------------------------------ closing dates -------------------------- */
  T({
    id: 'deals-closing-period', kind: 'list', intent: 'lookup',
    description: 'Open deals whose close date falls in a period.',
    patterns: [
      `(which|what) (open|) deals (close|are closing|are due to close|are set to close|are expected to close|are forecast to close|are scheduled to close) {period}`,
      `${LIST} (the|our|) (open|) deals closing {period}`,
      `${LIST} (the|our|) (open|) deals (that|which) close {period}`,
      `(open|) deals (closing|due to close|set to close) {period}`,
    ],
    tools: ['record_search'],
    example: () => 'Which deals close in the next 90 days?',
    plan: (b, v) => {
      const period = slot(b, 'period', 'period');
      return [{ tool: 'record_search', args: searchArgs('deal', [{ property: 'deal_stage', op: 'in', values: v.stages.open }], closeWindow(period.window)), why: `List open deals closing ${period.window.label}.` }];
    },
    render: (steps, b, v) => {
      const period = slot(b, 'period', 'period');
      return renderList(resultOf<RecordSearchResult>(steps), 'open deal closing|open deals closing', periodPhrase(period.window.label), v.workspace, { period: period.window.label });
    },
  }),
  T({
    id: 'count-deals-closing-period', kind: 'count', intent: 'aggregate',
    description: 'How many open deals close in a period.',
    patterns: [
      `how many (open|) deals (close|are closing|are due to close|are set to close|are expected to close|are forecast to close) {period}`,
      `how many (open|) deals have a close date {period}`,
    ],
    tools: ['record_aggregate'],
    example: () => 'How many deals close in the next 90 days?',
    plan: (b, v) => {
      const period = slot(b, 'period', 'period');
      return [{ tool: 'record_aggregate', args: countArgs('deal', [{ property: 'deal_stage', op: 'in', values: v.stages.open }], closeWindow(period.window)), why: `Count open deals closing ${period.window.label}.` }];
    },
    render: (steps, b, v) => {
      const period = slot(b, 'period', 'period');
      return renderAggregateCount(resultOf<RecordAggregateResult>(steps), 'open deal closing|open deals closing', periodPhrase(period.window.label), v.workspace, { period: period.window.label });
    },
  }),
  T({
    id: 'deals-decided-period', kind: 'list', intent: 'lookup',
    description: 'Deals won, lost or closed in a period.',
    patterns: [
      `(which|what) deals did we {verb:book-verb} {period}`,
      `(which|what) deals (closed|were closed|were decided) {period}`,
      `(which|what) deals (were|got) {state:deal-state} {period}`,
      `${LIST} (the|) deals (we|that we) {verb:book-verb} {period}`,
      `${LIST} (the|) deals {state:deal-state} {period}`,
    ],
    tools: ['record_search'],
    example: (v) => `Which deals did we win in ${samplesOf(v).year}?`,
    check: (b) => {
      const verb = maybe(b, 'verb', 'verb');
      if (verb && !['closed_won', 'closed_lost'].includes(verb.value)) return `"${b.verb.text}" is not a way a deal is decided.`;
      const state = maybe(b, 'state', 'state');
      if (state && state.label === 'open') return 'An open deal has not been decided in any period.';
      return null;
    },
    plan: (b, v) => {
      const period = slot(b, 'period', 'period');
      const verb = maybe(b, 'verb', 'verb');
      const state = maybe(b, 'state', 'state');
      const stagesFor = verb ? (verb.value === 'closed_won' ? v.stages.won : v.stages.lost) : state ? null : [...v.stages.won, ...v.stages.lost];
      const conditions: Condition[] = stagesFor ? [{ property: 'deal_stage', op: 'in', values: stagesFor }] : state!.conditions;
      return [{ tool: 'record_search', args: searchArgs('deal', conditions, closeWindow(period.window)), why: `List deals decided ${period.window.label}.` }];
    },
    render: (steps, b, v) => {
      const period = slot(b, 'period', 'period');
      const verb = maybe(b, 'verb', 'verb');
      const state = maybe(b, 'state', 'state');
      const noun = verb ? (verb.value === 'closed_won' ? 'closed-won' : 'closed-lost') : state ? state.noun : 'closed';
      return renderList(resultOf<RecordSearchResult>(steps), `${noun} deal|${noun} deals`, `closed ${periodPhrase(period.window.label)}`, v.workspace, { period: period.window.label });
    },
  }),
  T({
    id: 'count-deals-decided-period', kind: 'count', intent: 'aggregate',
    description: 'How many deals were won, lost or closed in a period.',
    patterns: [
      `how many deals did we {verb:book-verb} {period}`,
      `how many deals (closed|were closed|were decided) {period}`,
      `how many deals (were|got) {state:deal-state} {period}`,
      `how many {state:deal-state} deals (closed|were there|did we have) {period}`,
    ],
    tools: ['record_aggregate'],
    example: (v) => `How many deals did we win in ${samplesOf(v).year}?`,
    check: (b) => {
      const verb = maybe(b, 'verb', 'verb');
      if (verb && !['closed_won', 'closed_lost'].includes(verb.value)) return `"${b.verb.text}" is not a way a deal is decided.`;
      const state = maybe(b, 'state', 'state');
      if (state && state.label === 'open') return 'An open deal has not been decided in any period.';
      return null;
    },
    plan: (b, v) => {
      const period = slot(b, 'period', 'period');
      const verb = maybe(b, 'verb', 'verb');
      const state = maybe(b, 'state', 'state');
      const stagesFor = verb ? (verb.value === 'closed_won' ? v.stages.won : v.stages.lost) : state ? null : [...v.stages.won, ...v.stages.lost];
      const conditions: Condition[] = stagesFor ? [{ property: 'deal_stage', op: 'in', values: stagesFor }] : state!.conditions;
      return [{ tool: 'record_aggregate', args: countArgs('deal', conditions, closeWindow(period.window)), why: `Count deals decided ${period.window.label}.` }];
    },
    render: (steps, b, v) => {
      const period = slot(b, 'period', 'period');
      const verb = maybe(b, 'verb', 'verb');
      const state = maybe(b, 'state', 'state');
      const noun = verb ? (verb.value === 'closed_won' ? 'closed-won' : 'closed-lost') : state ? state.noun : 'closed';
      return renderAggregateCount(resultOf<RecordAggregateResult>(steps), `${noun} deal|${noun} deals`, `closed ${periodPhrase(period.window.label)}`, v.workspace, { period: period.window.label });
    },
  }),

  /* --------------------------- pipelines and stages ---------------------- */
  T({
    id: 'pipeline-worth', kind: 'metric', intent: 'aggregate',
    description: 'The open value of one deal pipeline.',
    patterns: [
      `${WHAT_IS} the {pipeline} pipeline worth`,
      `how much is ${OUR} {pipeline} pipeline worth`,
      `${WHAT_IS} ${OUR} open pipeline in the {pipeline} pipeline`,
      `how much open pipeline is in the {pipeline} pipeline`,
      `${WHAT_IS} the value of the {pipeline} pipeline`,
    ],
    tools: ['business_metric'],
    example: (v) => need('What is the ', samplesOf(v).pipeline, ' pipeline worth?'),
    plan: (b) => {
      const pipeline = slot(b, 'pipeline', 'pipeline');
      return [{ tool: 'business_metric', args: { metric: 'pipeline', pipeline: pipeline.value, compare: false }, why: `Open pipeline narrowed to the ${pipeline.label} pipeline.` }];
    },
    render: (steps, b, v) => renderMetric(resultOf<MetricToolResult>(steps), v.workspace, { scope: `in the ${slot(b, 'pipeline', 'pipeline').label} pipeline` }),
  }),
  T({
    id: 'count-deals-in-pipeline', kind: 'count', intent: 'aggregate',
    description: 'How many deals sit in one pipeline, optionally in one state.',
    patterns: [
      `how many {state:deal-state} deals are in the {pipeline} pipeline`,
      `how many deals are in the {pipeline} pipeline`,
      `how many {state:deal-state} deals does the {pipeline} pipeline have`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How many open deals are in the ', samplesOf(v).pipeline, ' pipeline?'),
    plan: (b) => {
      const pipeline = slot(b, 'pipeline', 'pipeline');
      const state = maybe(b, 'state', 'state');
      return [{ tool: 'record_aggregate', args: countArgs('deal', [...(state?.conditions ?? []), { property: 'pipeline', op: 'eq', value: pipeline.value }]), why: `Count deals in the ${pipeline.label} pipeline.` }];
    },
    render: (steps, b, v) => renderAggregateCount(resultOf<RecordAggregateResult>(steps), dealThing(maybe(b, 'state', 'state')), `in the ${slot(b, 'pipeline', 'pipeline').label} pipeline`, v.workspace),
  }),
  T({
    id: 'count-deals-at-stage', kind: 'count', intent: 'aggregate',
    description: 'How many deals sit at one stage.',
    patterns: [
      `how many deals are (in|at) (the|) {stage} (stage|)`,
      `how many deals are (in|at|sitting in|stuck in|sitting at) {stage}`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How many deals are at the ', samplesOf(v).stage, ' stage?'),
    plan: (b) => {
      const stage = slot(b, 'stage', 'stage');
      return [{ tool: 'record_aggregate', args: countArgs('deal', stage.conditions), why: `Count deals at the ${stage.label} stage.` }];
    },
    render: (steps, b, v) => renderAggregateCount(resultOf<RecordAggregateResult>(steps), 'deal|deals', `at the ${slot(b, 'stage', 'stage').label} stage`, v.workspace),
  }),
  T({
    id: 'list-deals-at-stage', kind: 'list', intent: 'lookup',
    description: 'The deals sitting at one stage.',
    patterns: [
      `(which|what) deals are (in|at) (the|) {stage} (stage|)`,
      `${LIST} (the|) deals (in|at) (the|) {stage} (stage|)`,
    ],
    tools: ['record_search'],
    example: (v) => need('Which deals are at the ', samplesOf(v).stage, ' stage?'),
    plan: (b) => {
      const stage = slot(b, 'stage', 'stage');
      return [{ tool: 'record_search', args: searchArgs('deal', stage.conditions), why: `List deals at the ${stage.label} stage.` }];
    },
    render: (steps, b, v) => renderList(resultOf<RecordSearchResult>(steps), 'deal|deals', `at the ${slot(b, 'stage', 'stage').label} stage`, v.workspace),
  }),
  T({
    id: 'pipeline-at-stage', kind: 'metric', intent: 'aggregate',
    description: 'The open value sitting at one stage.',
    patterns: [
      `${WHAT_IS} ${OUR} (open|) pipeline (in|at) (the|) {stage} (stage|)`,
      `how much (open|) pipeline is (in|at|sitting in|sitting at|stuck in) (the|) {stage} (stage|)`,
      `how much is (sitting in|sitting at|stuck in|in) (the|) {stage} (stage|)`,
    ],
    tools: ['business_metric'],
    example: (v) => need('How much pipeline is at the ', samplesOf(v).stage, ' stage?'),
    plan: (b) => {
      const stage = slot(b, 'stage', 'stage');
      return [{ tool: 'business_metric', args: { metric: 'pipeline', stage: stage.value, ...(stage.pipeline ? { pipeline: stage.pipeline } : {}), compare: false }, why: `Open pipeline narrowed to the ${stage.label} stage.` }];
    },
    render: (steps, b, v) => renderMetric(resultOf<MetricToolResult>(steps), v.workspace, { scope: `at the ${slot(b, 'stage', 'stage').label} stage` }),
  }),

  /* -------------------------------- metrics ------------------------------ */
  T({
    id: 'metric-snapshot', kind: 'metric', intent: 'aggregate',
    description: 'A snapshot measure as it stands now — open pipeline, MRR, ARR, outstanding balance, open tickets.',
    patterns: [
      `${WHAT_IS} ${OUR} {metric:snapshot-metric} (right now|today|at the moment|currently|now|)`,
      `how much is ${OUR} {metric:snapshot-metric}`,
      `how much {metric:snapshot-metric} do we have`,
      `how much do we have in {metric:snapshot-metric}`,
    ],
    tools: ['business_metric'],
    example: () => 'What is our ARR?',
    plan: (b) => {
      const metric = slot(b, 'metric', 'metric');
      return [{ tool: 'business_metric', args: { metric: metric.id, compare: false }, why: `${metric.label}, as it stands now.` }];
    },
    render: (steps, _b, v) => renderMetric(resultOf<MetricToolResult>(steps), v.workspace, {}),
  }),
  T({
    id: 'count-metric', kind: 'metric', intent: 'aggregate',
    description: 'How many of a counted thing the workspace has right now — customers, connected assets.',
    patterns: [
      `how many {metric:snapshot-metric} (do we have|are there|have we got|are we running)`,
      `how many (paying|) customers (do we have|are there|)`,
    ],
    tools: ['business_metric'],
    example: () => 'How many customers do we have?',
    check: (b) => {
      const metric = maybe(b, 'metric', 'metric');
      return metric && metric.unit !== 'count' ? `${metric.label} is ${metric.unit === 'money' ? 'money' : 'not a count'}, so "how many" does not apply to it.` : null;
    },
    plan: (b) => {
      const metric = maybe(b, 'metric', 'metric')?.id ?? 'customers';
      return [{ tool: 'business_metric', args: { metric, compare: false }, why: `${humanise(metric)}, counted now.` }];
    },
    render: (steps, _b, v) => renderMetric(resultOf<MetricToolResult>(steps), v.workspace, {}),
  }),
  T({
    id: 'metric-period', kind: 'metric', intent: 'aggregate',
    description: 'A measure over a period — revenue, closed-won bookings, win rate, tickets raised.',
    patterns: [
      `${WHAT_WAS} ${OUR} {metric:period-metric} {period}`,
      `how much {metric:period-metric} (did we|have we) (make|have|get|bring in|generate|book|do) {period}`,
    ],
    tools: ['business_metric'],
    example: (v) => `What was our revenue in ${samplesOf(v).year}?`,
    plan: (b) => {
      const metric = slot(b, 'metric', 'metric');
      const period = slot(b, 'period', 'period');
      return [{ tool: 'business_metric', args: { metric: metric.id, ...windowArgs(period.window), compare: false }, why: `${metric.label} over ${period.window.label}.` }];
    },
    render: (steps, b, v) => renderMetric(resultOf<MetricToolResult>(steps), v.workspace, { period: slot(b, 'period', 'period').window.label }),
  }),
  T({
    id: 'metric-verb-period', kind: 'metric', intent: 'aggregate',
    description: 'How much was booked, invoiced, collected or lost in a period.',
    patterns: [
      `how much (did we|have we) {verb:book-verb} {period}`,
      `how much (money|revenue|) (did we|have we) {verb:book-verb} {period}`,
      `how much (was|got) {verb:book-verb} {period}`,
    ],
    tools: ['business_metric'],
    example: (v) => `How much did we book in ${samplesOf(v).year}?`,
    plan: (b) => {
      const verb = slot(b, 'verb', 'verb');
      const period = slot(b, 'period', 'period');
      return [{ tool: 'business_metric', args: { metric: verb.value, ...windowArgs(period.window), compare: false }, why: `${humanise(verb.value)} over ${period.window.label}.` }];
    },
    render: (steps, b, v) => renderMetric(resultOf<MetricToolResult>(steps), v.workspace, { period: slot(b, 'period', 'period').window.label }),
  }),
  T({
    id: 'metric-currency-snapshot', kind: 'metric', intent: 'aggregate',
    description: 'A ledger snapshot in one currency book — MRR in EUR, outstanding balance in GBP.',
    patterns: [
      `${WHAT_IS} ${OUR} {metric:ledger-snapshot-metric} in {currency}`,
      `how much {metric:ledger-snapshot-metric} do we have in {currency}`,
    ],
    tools: ['business_metric'],
    example: (v) => need('What is our MRR in ', samplesOf(v).currency, '?'),
    plan: (b) => {
      const metric = slot(b, 'metric', 'metric');
      const currency = slot(b, 'currency', 'currency');
      return [{ tool: 'business_metric', args: { metric: metric.id, currency: currency.code, compare: false }, why: `${metric.label}, the ${currency.code.toUpperCase()} book only.` }];
    },
    render: (steps, b, v) => renderMetric(resultOf<MetricToolResult>(steps), v.workspace, { scope: `in ${slot(b, 'currency', 'currency').code.toUpperCase()}` }),
  }),
  T({
    id: 'metric-currency-period', kind: 'metric', intent: 'aggregate',
    description: 'Revenue or invoiced total in one currency book over a period.',
    patterns: [
      `${WHAT_WAS} ${OUR} {metric:ledger-period-metric} in {currency} {period}`,
      `${WHAT_WAS} ${OUR} {metric:ledger-period-metric} {period} in {currency}`,
      `how much (did we|have we) {verb:book-verb} in {currency} {period}`,
    ],
    tools: ['business_metric'],
    example: (v) => need('What was our revenue in ', samplesOf(v).currency, ` in ${samplesOf(v).year}?`),
    check: (b) => {
      const verb = maybe(b, 'verb', 'verb');
      return verb && !['invoiced', 'revenue'].includes(verb.value) ? `Deals carry no currency book, so "${b.verb.text}" cannot be narrowed to one.` : null;
    },
    plan: (b) => {
      const metric = maybe(b, 'metric', 'metric')?.id ?? slot(b, 'verb', 'verb').value;
      const currency = slot(b, 'currency', 'currency');
      const period = slot(b, 'period', 'period');
      return [{ tool: 'business_metric', args: { metric, currency: currency.code, ...windowArgs(period.window), compare: false }, why: `${humanise(metric)} in ${currency.code.toUpperCase()} over ${period.window.label}.` }];
    },
    render: (steps, b, v) => renderMetric(resultOf<MetricToolResult>(steps), v.workspace, { period: slot(b, 'period', 'period').window.label, scope: `in ${slot(b, 'currency', 'currency').code.toUpperCase()}` }),
  }),
  T({
    id: 'breakdown-snapshot', kind: 'breakdown', intent: 'aggregate',
    description: 'A snapshot measure broken down by owner, stage, pipeline, source, account, status, priority or industry.',
    patterns: [
      `${WHAT_IS} ${OUR} {metric:snapshot-metric} by {dimension}`,
      `(break down|breakdown of|split) ${OUR} {metric:snapshot-metric} by {dimension}`,
      `${OUR} {metric:snapshot-metric} by {dimension}`,
      `how (is|does) ${OUR} {metric:snapshot-metric} (look|split|break down) by {dimension}`,
    ],
    tools: ['business_metric'],
    example: () => 'What is our open pipeline by stage?',
    check: (b) => {
      const metric = slot(b, 'metric', 'metric');
      const dimension = slot(b, 'dimension', 'dimension');
      return (BREAKDOWNS[metric.id] ?? []).includes(dimension.groupBy) ? null
        : `${metric.label} does not break down by ${dimension.label} in this workspace${BREAKDOWNS[metric.id]?.length ? ` — it breaks down by ${listPhrase(BREAKDOWNS[metric.id], 'or')}` : ''}.`;
    },
    plan: (b) => {
      const metric = slot(b, 'metric', 'metric');
      const dimension = slot(b, 'dimension', 'dimension');
      return [{ tool: 'business_metric', args: { metric: metric.id, group_by: dimension.groupBy, limit: 25, compare: false }, why: `${metric.label} by ${dimension.label}.` }];
    },
    render: (steps, b, v) => renderBreakdown(resultOf<MetricToolResult>(steps), slot(b, 'dimension', 'dimension').label, v.workspace, {}),
  }),
  T({
    id: 'breakdown-period', kind: 'breakdown', intent: 'aggregate',
    description: 'A period measure broken down by a dimension over a period.',
    patterns: [
      `${WHAT_WAS} ${OUR} {metric:period-metric} by {dimension} {period}`,
      `${WHAT_WAS} ${OUR} {metric:period-metric} {period} by {dimension}`,
      `(break down|breakdown of|split) ${OUR} {metric:period-metric} by {dimension} {period}`,
      `${OUR} {metric:period-metric} by {dimension} {period}`,
    ],
    tools: ['business_metric'],
    example: (v) => `What was our win rate by owner in ${samplesOf(v).year}?`,
    check: (b) => {
      const metric = slot(b, 'metric', 'metric');
      const dimension = slot(b, 'dimension', 'dimension');
      return (BREAKDOWNS[metric.id] ?? []).includes(dimension.groupBy) ? null
        : `${metric.label} does not break down by ${dimension.label} in this workspace${BREAKDOWNS[metric.id]?.length ? ` — it breaks down by ${listPhrase(BREAKDOWNS[metric.id], 'or')}` : ''}.`;
    },
    plan: (b) => {
      const metric = slot(b, 'metric', 'metric');
      const dimension = slot(b, 'dimension', 'dimension');
      const period = slot(b, 'period', 'period');
      return [{ tool: 'business_metric', args: { metric: metric.id, group_by: dimension.groupBy, limit: 25, ...windowArgs(period.window), compare: false }, why: `${metric.label} by ${dimension.label} over ${period.window.label}.` }];
    },
    render: (steps, b, v) => renderBreakdown(resultOf<MetricToolResult>(steps), slot(b, 'dimension', 'dimension').label, v.workspace, { period: slot(b, 'period', 'period').window.label }),
  }),

  /* -------------------------------- owners ------------------------------- */
  T({
    id: 'owner-pipeline', kind: 'metric', intent: 'aggregate',
    description: 'How much open pipeline, weighted pipeline or open deals one teammate owns.',
    patterns: [
      `how much {metric:ownable-metric} does {owner} (own|have|carry)`,
      `${WHAT_IS} {owner} {metric:ownable-metric}`,
      `how (much|many) {metric:ownable-metric} (is|are) {owner} (carrying|working|working on)`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How much open pipeline does ', samplesOf(v).owner, ' own?'),
    plan: (b, v) => {
      const metric = slot(b, 'metric', 'metric');
      const owner = slot(b, 'owner', 'owner');
      const open: Condition[] = [{ property: 'deal_stage', op: 'in', values: v.stages.open }];
      const measure = metric.id === 'deal_count' ? {} : { measure: 'sum', property: metric.id === 'weighted_pipeline' ? 'weighted_amount' : 'amount' };
      return [{ tool: 'record_aggregate', args: { object_type: 'deal', conditions: open, owner_id: owner.id, ...(metric.id === 'deal_count' ? { measure: 'count' } : measure) }, why: `${metric.label} over the open deals ${owner.name} owns.` }];
    },
    render: (steps, b, v) => {
      const metric = slot(b, 'metric', 'metric');
      const owner = slot(b, 'owner', 'owner');
      const result = resultOf<RecordAggregateResult>(steps);
      if (metric.id === 'deal_count') return renderAggregateCount(result, 'open deal|open deals', ownerScope(owner), v.workspace, { subject: owner.name });
      const content = `${owner.name} owns ${result.formatted} of ${metric.label.toLowerCase()}, across ${result.matched_records} open ${plural(result.matched_records, 'deal')}.`;
      return { content, citations: result.samples.map((s) => ({ id: s.id, label: s.label, type: 'deal' })), facts: { ...NO_FACTS, value: result.value, formatted: result.formatted, unit: 'money', currency: v.workspace.currency, count: result.matched_records, label: metric.label, subject: owner.name, rows: result.samples } };
    },
  }),
  T({
    id: 'owner-bookings-period', kind: 'metric', intent: 'aggregate',
    description: 'How much one teammate booked or lost in a period.',
    patterns: [
      `how much did {owner} {verb:book-verb} {period}`,
      `${WHAT_WAS} {owner} (bookings|closed won bookings|closed won) {period}`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How much did ', samplesOf(v).owner, ` book in ${samplesOf(v).year}?`),
    check: (b) => {
      const verb = maybe(b, 'verb', 'verb');
      return verb && !['closed_won', 'closed_lost'].includes(verb.value) ? `"${b.verb.text}" is a ledger measure, and the ledger does not record who owns a bill.` : null;
    },
    plan: (b, v) => {
      const owner = slot(b, 'owner', 'owner');
      const period = slot(b, 'period', 'period');
      const lost = maybe(b, 'verb', 'verb')?.value === 'closed_lost';
      return [{ tool: 'record_aggregate', args: { object_type: 'deal', measure: 'sum', property: 'amount', conditions: [{ property: 'deal_stage', op: 'in', values: lost ? v.stages.lost : v.stages.won }], owner_id: owner.id, ...closeWindow(period.window) }, why: `${lost ? 'Closed-lost' : 'Closed-won'} amount for ${owner.name} over ${period.window.label}.` }];
    },
    render: (steps, b, v) => {
      const owner = slot(b, 'owner', 'owner');
      const period = slot(b, 'period', 'period');
      const lost = maybe(b, 'verb', 'verb')?.value === 'closed_lost';
      const result = resultOf<RecordAggregateResult>(steps);
      const content = `${owner.name} ${lost ? 'lost' : 'booked'} ${result.formatted} ${periodPhrase(period.window.label)}, across ${result.matched_records} ${lost ? 'closed-lost' : 'closed-won'} ${plural(result.matched_records, 'deal')}.`;
      return { content, citations: result.samples.map((s) => ({ id: s.id, label: s.label, type: 'deal' })), facts: { ...NO_FACTS, value: result.value, formatted: result.formatted, unit: 'money', currency: v.workspace.currency, count: result.matched_records, label: lost ? 'Closed-lost value' : 'Closed-won bookings', period: period.window.label, subject: owner.name, rows: result.samples } };
    },
  }),
  T({
    id: 'owner-deals-decided-period', kind: 'count', intent: 'aggregate',
    description: 'How many deals one teammate won or lost in a period.',
    patterns: [
      `how many deals did {owner} {verb:book-verb} {period}`,
      `how many {state:deal-state} deals did {owner} have {period}`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How many deals did ', samplesOf(v).owner, ` win in ${samplesOf(v).year}?`),
    check: (b) => {
      const verb = maybe(b, 'verb', 'verb');
      if (verb && !['closed_won', 'closed_lost'].includes(verb.value)) return `"${b.verb.text}" is not a way a deal is decided.`;
      const state = maybe(b, 'state', 'state');
      if (state && state.label === 'open') return 'An open deal has not been decided in any period.';
      return null;
    },
    plan: (b, v) => {
      const owner = slot(b, 'owner', 'owner');
      const period = slot(b, 'period', 'period');
      const verb = maybe(b, 'verb', 'verb');
      const state = maybe(b, 'state', 'state');
      const conditions: Condition[] = verb ? [{ property: 'deal_stage', op: 'in', values: verb.value === 'closed_won' ? v.stages.won : v.stages.lost }] : state!.conditions;
      return [{ tool: 'record_aggregate', args: countArgs('deal', conditions, { owner_id: owner.id, ...closeWindow(period.window) }), why: `Count deals ${owner.name} decided over ${period.window.label}.` }];
    },
    render: (steps, b, v) => {
      const owner = slot(b, 'owner', 'owner');
      const period = slot(b, 'period', 'period');
      const verb = maybe(b, 'verb', 'verb');
      const noun = verb ? (verb.value === 'closed_won' ? 'closed-won' : 'closed-lost') : slot(b, 'state', 'state').noun;
      return renderAggregateCount(resultOf<RecordAggregateResult>(steps), `${noun} deal|${noun} deals`, `${ownerScope(owner)} closed ${periodPhrase(period.window.label)}`, v.workspace, { subject: owner.name, period: period.window.label });
    },
  }),
  T({
    id: 'owner-win-rate-period', kind: 'metric', intent: 'aggregate',
    description: 'One teammate’s win rate over a period.',
    patterns: [
      `${WHAT_WAS} {owner} win rate {period}`,
      `what win rate did {owner} have {period}`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('What was ', samplesOf(v).owner, `'s win rate in ${samplesOf(v).year}?`),
    plan: (b, v) => {
      const owner = slot(b, 'owner', 'owner');
      const period = slot(b, 'period', 'period');
      return [
        { tool: 'record_aggregate', args: countArgs('deal', [{ property: 'deal_stage', op: 'in', values: v.stages.won }], { owner_id: owner.id, ...closeWindow(period.window) }), why: `Deals ${owner.name} won over ${period.window.label}.` },
        { tool: 'record_aggregate', args: countArgs('deal', [{ property: 'deal_stage', op: 'in', values: v.stages.lost }], { owner_id: owner.id, ...closeWindow(period.window) }), why: `Deals ${owner.name} lost over ${period.window.label}.` },
      ];
    },
    render: (steps, b, v) => {
      const owner = slot(b, 'owner', 'owner');
      const period = slot(b, 'period', 'period');
      const won = resultOf<RecordAggregateResult>(steps, 0).matched_records;
      const lost = resultOf<RecordAggregateResult>(steps, 1).matched_records;
      const decided = won + lost;
      if (!decided) return { content: `${owner.name} decided no deals ${periodPhrase(period.window.label)}, so there is no win rate to report.`, citations: [], facts: { ...NO_FACTS, unit: 'percent', count: 0, label: 'Win rate', period: period.window.label, subject: owner.name } };
      const rate = Math.round((won / decided) * 1000) / 10;
      void v;
      return { content: `${owner.name}'s win rate ${periodPhrase(period.window.label)} is ${rate}%: ${won} won of ${decided} decided ${plural(decided, 'deal')}.`, citations: [], facts: { ...NO_FACTS, value: rate, formatted: `${rate}%`, unit: 'percent', count: decided, label: 'Win rate', period: period.window.label, subject: owner.name } };
    },
  }),
  T({
    id: 'owner-activities-period', kind: 'count', intent: 'aggregate',
    description: 'How many calls, meetings, emails, notes or tasks one teammate logged in a period.',
    patterns: [
      `how many {object:activity-object} did {owner} (log|have|hold|make|send|book|record) {period}`,
      `how many {object:activity-object} has {owner} (logged|had|held|made|sent|booked|recorded) {period}`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How many meetings did ', samplesOf(v).owner, ' hold in the last 30 days?'),
    plan: (b) => {
      const object = slot(b, 'object', 'object');
      const owner = slot(b, 'owner', 'owner');
      const period = slot(b, 'period', 'period');
      return [{ tool: 'record_aggregate', args: countArgs(object.type, [], { owner_id: owner.id, date_property: 'occurred_at', start: period.window.start, end: period.window.end }), why: `Count ${object.plural} ${owner.name} logged over ${period.window.label}.` }];
    },
    render: (steps, b, v) => {
      const object = slot(b, 'object', 'object');
      const owner = slot(b, 'owner', 'owner');
      const period = slot(b, 'period', 'period');
      return renderAggregateCount(resultOf<RecordAggregateResult>(steps), thingOf(null, object), `logged by ${owner.name} ${periodPhrase(period.window.label)}`, v.workspace, { subject: owner.name, period: period.window.label });
    },
  }),
  T({
    id: 'rep-most-metric', kind: 'breakdown', intent: 'aggregate',
    description: 'Which teammate carries the most, or least, open pipeline.',
    patterns: [
      `(which|what) (rep|owner|teammate|seller|account executive|person) has the {most} (open|) pipeline`,
      `who has the {most} (open|) pipeline`,
      `who (owns|carries) the {most} (open|) pipeline`,
    ],
    tools: ['business_metric'],
    example: () => 'Who has the most open pipeline?',
    plan: (b) => {
      const most = slot(b, 'most', 'superlative');
      return [{ tool: 'business_metric', args: { metric: 'pipeline', group_by: 'owner', limit: 25, direction: most.direction, compare: false }, why: 'Open pipeline per owner.' }];
    },
    render: (steps, b, v) => {
      const most = slot(b, 'most', 'superlative');
      const result = resultOf<MetricToolResult>(steps);
      const groups = result.groups;
      if (!groups.length) return { content: 'No teammate owns any open pipeline.', citations: [], facts: { ...NO_FACTS, unit: 'money', label: result.label, mixed: true } };
      const top = groups[0];
      const lines = groups.map((g, i) => `${i + 1}. ${g.label} — ${g.formatted} (${g.count} open ${plural(g.count, 'deal')})`);
      void v;
      return { content: `${top.label} has the ${most.direction === 'desc' ? 'most' : 'least'} open pipeline, at ${top.formatted} across ${top.count} open ${plural(top.count, 'deal')}.\n\n${lines.join('\n')}`, citations: [], facts: { ...NO_FACTS, unit: 'money', label: result.label, mixed: true, rows: groups.map((g) => ({ id: g.key, label: g.label })) } };
    },
  }),
  T({
    id: 'rep-most-bookings-period', kind: 'breakdown', intent: 'aggregate',
    description: 'Which teammate booked the most, or least, in a period.',
    patterns: [
      `who (booked|won|closed) the {most} {period}`,
      `(which|what) (rep|owner|teammate|seller|account executive|person) (booked|won|closed) the {most} {period}`,
      `who had the {most} (bookings|closed won bookings) {period}`,
    ],
    tools: ['business_metric'],
    example: (v) => `Who booked the most in ${samplesOf(v).year}?`,
    plan: (b) => {
      const most = slot(b, 'most', 'superlative');
      const period = slot(b, 'period', 'period');
      return [{ tool: 'business_metric', args: { metric: 'closed_won', group_by: 'owner', limit: 25, direction: most.direction, ...windowArgs(period.window), compare: false }, why: `Closed-won bookings per owner over ${period.window.label}.` }];
    },
    render: (steps, b, v) => {
      const most = slot(b, 'most', 'superlative');
      const period = slot(b, 'period', 'period');
      const result = resultOf<MetricToolResult>(steps);
      const groups = result.groups;
      if (!groups.length) return { content: `Nobody booked anything ${periodPhrase(period.window.label)}.`, citations: [], facts: { ...NO_FACTS, unit: 'money', count: 0, label: result.label, period: period.window.label, mixed: true } };
      const top = groups[0];
      const lines = groups.map((g, i) => `${i + 1}. ${g.label} — ${g.formatted} (${g.count} ${plural(g.count, 'deal')})`);
      void v;
      return { content: `${top.label} booked the ${most.direction === 'desc' ? 'most' : 'least'} ${periodPhrase(period.window.label)}: ${top.formatted} across ${top.count} closed-won ${plural(top.count, 'deal')}.\n\n${lines.join('\n')}`, citations: result.evidence.slice(0, 6), facts: { ...NO_FACTS, unit: 'money', label: result.label, period: period.window.label, mixed: true, rows: groups.map((g) => ({ id: g.key, label: g.label })) } };
    },
  }),

  /* ------------------------------- rankings ------------------------------ */
  T({
    id: 'rank-accounts', kind: 'rank', intent: 'aggregate',
    description: 'The biggest or smallest accounts by a measure, on the books all time.',
    patterns: [
      `who (is|are) ${OUR} {superlative} (customer|customers|account|accounts|client|clients) by {metric:rank-metric}`,
      `(which|what) (customer|customers|account|accounts|company|companies) (is|are|has|have) ${OUR} {superlative} {metric:rank-metric}`,
      `(which|what) (is|are) ${OUR} {superlative} (customer|customers|account|accounts) by {metric:rank-metric}`,
    ],
    tools: ['business_metric'],
    example: () => 'Who is our biggest customer by closed-won bookings?',
    plan: (b, v) => {
      const metric = slot(b, 'metric', 'metric');
      const superlative = slot(b, 'superlative', 'superlative');
      return [{ tool: 'business_metric', args: { metric: metric.id, group_by: 'account', limit: 5, direction: superlative.direction, start: 0, end: v.workspace.now, window_label: 'all time', compare: false }, why: `${metric.label} per account, all time.` }];
    },
    render: (steps, b, v) => renderRank(resultOf<MetricToolResult>(steps), 'customer', slot(b, 'superlative', 'superlative').direction, 5, v.workspace, { period: 'all time' }),
  }),
  T({
    id: 'rank-accounts-period', kind: 'rank', intent: 'aggregate',
    description: 'The biggest or smallest accounts by a measure over a period.',
    patterns: [
      `who (is|are|was|were) ${OUR} {superlative} (customer|customers|account|accounts|client|clients) by {metric:rank-metric} {period}`,
      `(which|what) (customers|accounts|companies) (booked|spent|paid) the most {period}`,
      `(which|what) (customers|accounts|companies) (booked|spent|paid) the least {period}`,
    ],
    tools: ['business_metric'],
    example: (v) => `Which accounts booked the most in ${samplesOf(v).year}?`,
    check: (b) => {
      const metric = maybe(b, 'metric', 'metric');
      return metric?.snapshot ? `${metric.label} is a snapshot of right now, so it has no figure for a past period.` : null;
    },
    plan: (b) => {
      const period = slot(b, 'period', 'period');
      const metric = maybe(b, 'metric', 'metric');
      const words = b.$question.text;
      const id = metric?.id ?? (/\b(spent|paid)\b/.test(words) ? 'spend' : 'closed_won');
      const direction = maybe(b, 'superlative', 'superlative')?.direction ?? (/\bleast\b/.test(words) ? 'asc' : 'desc');
      return [{ tool: 'business_metric', args: { metric: id, group_by: 'account', limit: 5, direction, ...windowArgs(period.window), compare: false }, why: `${humanise(id)} per account over ${period.window.label}.` }];
    },
    render: (steps, b, v) => renderRank(resultOf<MetricToolResult>(steps), 'customer', maybe(b, 'superlative', 'superlative')?.direction ?? (/\bleast\b/.test(b.$question.text) ? 'asc' : 'desc'), 5, v.workspace, { period: slot(b, 'period', 'period').window.label }),
  }),
  T({
    id: 'top-n-accounts', kind: 'rank', intent: 'aggregate',
    description: 'The top N accounts by a measure, all time or over a period.',
    patterns: [
      `top {number} (customers|accounts|companies|clients) by {metric:rank-metric}`,
      `top {number} (customers|accounts|companies|clients) by {metric:rank-metric} {period}`,
      `${WHAT_IS} ${OUR} top {number} (customers|accounts|companies|clients) by {metric:rank-metric}`,
    ],
    tools: ['business_metric'],
    example: () => 'Top 5 customers by revenue',
    check: (b) => {
      const metric = slot(b, 'metric', 'metric');
      return maybe(b, 'period', 'period') && metric.snapshot ? `${metric.label} is a snapshot of right now, so it has no figure for a past period.` : null;
    },
    plan: (b, v) => {
      const metric = slot(b, 'metric', 'metric');
      const limit = Math.min(slot(b, 'number', 'number').value, 25);
      const period = maybe(b, 'period', 'period');
      const window = period ? windowArgs(period.window) : { start: 0, end: v.workspace.now, window_label: 'all time' };
      return [{ tool: 'business_metric', args: { metric: metric.id, group_by: 'account', limit, ...window, compare: false }, why: `Top ${limit} accounts by ${metric.label}.` }];
    },
    render: (steps, b, v) => renderRank(resultOf<MetricToolResult>(steps), 'customer', 'desc', Math.min(slot(b, 'number', 'number').value, 25), v.workspace, { period: maybe(b, 'period', 'period')?.window.label ?? 'all time' }),
  }),

  /* -------------------------------- ledger ------------------------------- */
  T({
    id: 'subscriptions-on-plan', kind: 'ledger', intent: 'lookup',
    description: 'The subscriptions carrying one product.',
    patterns: [
      `(which|what) subscriptions are on (the|) {plan} (plan|product|)`,
      `who is on (the|) {plan} (plan|product|)`,
      `${LIST} (the|) subscriptions on (the|) {plan} (plan|product|)`,
      `(which|what) (customers|accounts) are on (the|) {plan} (plan|product|)`,
    ],
    tools: ['subscriptions_on_plan'],
    example: (v) => need('Which subscriptions are on the ', samplesOf(v).plan, ' plan?'),
    plan: (b) => {
      const plan = slot(b, 'plan', 'plan');
      return [{ tool: 'subscriptions_on_plan', args: { product_id: plan.id, limit: 25 }, why: `Subscriptions with an item priced on ${plan.name}.` }];
    },
    render: (steps, b, v) => {
      const plan = slot(b, 'plan', 'plan');
      const result = resultOf<{ total: number; subscriptions: SubscriptionRow[] }>(steps);
      return renderSubscriptions(result.subscriptions, result.total, `on ${plan.name}`, v.workspace);
    },
  }),
  T({
    id: 'count-subscriptions-on-plan', kind: 'ledger', intent: 'aggregate',
    description: 'How many subscriptions carry one product.',
    patterns: [
      `how many subscriptions are on (the|) {plan} (plan|product|)`,
      `how many (customers|accounts) are on (the|) {plan} (plan|product|)`,
    ],
    tools: ['subscriptions_on_plan'],
    example: (v) => need('How many subscriptions are on the ', samplesOf(v).plan, ' plan?'),
    plan: (b) => {
      const plan = slot(b, 'plan', 'plan');
      return [{ tool: 'subscriptions_on_plan', args: { product_id: plan.id, limit: 1 }, why: `Count subscriptions with an item priced on ${plan.name}.` }];
    },
    render: (steps, b, v) => renderCount(resultOf<{ total: number }>(steps).total, 'subscription|subscriptions', `on ${slot(b, 'plan', 'plan').name}`, v.workspace),
  }),
  T({
    id: 'subscriptions-status', kind: 'ledger', intent: 'lookup',
    description: 'The subscriptions in one billing status.',
    patterns: [
      `(which|what) subscriptions are {status:subscription-status}`,
      `${LIST} (the|our|all|) {status:subscription-status} subscriptions`,
      `who is {status:subscription-status}`,
    ],
    tools: ['billing_list_subscriptions'],
    example: () => 'Which subscriptions are past due?',
    plan: (b) => {
      const status = slot(b, 'status', 'subscription-status');
      return [{ tool: 'billing_list_subscriptions', args: { status: status.value, limit: 25 }, why: `Subscriptions whose status is ${status.label}.` }];
    },
    render: (steps, b, v) => {
      const status = slot(b, 'status', 'subscription-status');
      const result = resultOf<{ total: number; subscriptions: SubscriptionRow[] }>(steps);
      return renderSubscriptions(result.subscriptions, result.total, status.label, v.workspace);
    },
  }),
  T({
    id: 'count-subscriptions-status', kind: 'ledger', intent: 'aggregate',
    description: 'How many subscriptions are in one billing status.',
    patterns: [
      `how many subscriptions are {status:subscription-status}`,
      `how many {status:subscription-status} subscriptions (do we have|are there|)`,
    ],
    tools: ['billing_list_subscriptions'],
    example: () => 'How many subscriptions are active?',
    plan: (b) => {
      const status = slot(b, 'status', 'subscription-status');
      return [{ tool: 'billing_list_subscriptions', args: { status: status.value, limit: 1 }, why: `Count subscriptions whose status is ${status.label}.` }];
    },
    render: (steps, b, v) => renderCount(resultOf<{ total: number }>(steps).total, `${slot(b, 'status', 'subscription-status').label} subscription|${slot(b, 'status', 'subscription-status').label} subscriptions`, '', v.workspace),
  }),
  T({
    id: 'customers-past-due', kind: 'ledger', intent: 'lookup',
    description: 'The customers who owe money on invoices past their due date.',
    patterns: [
      `(which|what) customers are (past due|overdue|in arrears|delinquent|behind on payments|late on payments|late paying)`,
      `who (owes us money|owes us|is past due|is overdue|is in arrears|is delinquent|is behind on payments)`,
      `(which|what) customers owe us (money|)`,
      `(which|what) accounts are (past due|overdue|in arrears|delinquent)`,
    ],
    tools: ['delinquent_customers'],
    example: () => 'Which customers are past due?',
    plan: () => [{ tool: 'delinquent_customers', args: { limit: 25 }, why: 'Customers with open invoices past their due date.' }],
    render: (steps, _b, v) => renderDelinquent(resultOf<DelinquentCustomersResult>(steps), v.workspace),
  }),
  T({
    id: 'invoices-status', kind: 'ledger', intent: 'lookup',
    description: 'The invoices in one status — open, paid, overdue, void.',
    patterns: [
      `(which|what) invoices are {status:invoice-status}`,
      `${LIST} (the|our|all|) {status:invoice-status} invoices`,
    ],
    tools: ['billing_list_invoices'],
    example: () => 'Which invoices are overdue?',
    plan: (b, v) => {
      const status = slot(b, 'status', 'invoice-status');
      return [{ tool: 'billing_list_invoices', args: { status: status.value, ...(status.overdue ? { due_before: v.workspace.now } : {}), limit: 25 }, why: `Invoices whose status is ${status.label}.` }];
    },
    render: (steps, b) => {
      const status = slot(b, 'status', 'invoice-status');
      const result = resultOf<{ total: number; invoices: (InvoiceRow & { due?: string })[] }>(steps);
      return renderInvoices(result.invoices, result.total, status.label);
    },
  }),
  T({
    id: 'count-invoices-status', kind: 'ledger', intent: 'aggregate',
    description: 'How many invoices are in one status.',
    patterns: [
      `how many invoices are {status:invoice-status}`,
      `how many {status:invoice-status} invoices (do we have|are there|)`,
    ],
    tools: ['billing_list_invoices'],
    example: () => 'How many invoices are open?',
    plan: (b, v) => {
      const status = slot(b, 'status', 'invoice-status');
      return [{ tool: 'billing_list_invoices', args: { status: status.value, ...(status.overdue ? { due_before: v.workspace.now } : {}), limit: 1 }, why: `Count invoices whose status is ${status.label}.` }];
    },
    render: (steps, b, v) => renderCount(resultOf<{ total: number }>(steps).total, `${slot(b, 'status', 'invoice-status').label} invoice|${slot(b, 'status', 'invoice-status').label} invoices`, '', v.workspace),
  }),
  T({
    id: 'count-invoices-period', kind: 'metric', intent: 'aggregate',
    description: 'How many invoices were issued or paid in a period.',
    patterns: [
      `how many invoices (did we|have we) (issue|raise|send|send out) {period}`,
      `how many invoices were (issued|raised|sent|paid) {period}`,
      `how many invoices (got|were) paid {period}`,
    ],
    tools: ['business_metric'],
    example: (v) => `How many invoices did we issue in ${samplesOf(v).year}?`,
    plan: (b) => {
      const period = slot(b, 'period', 'period');
      const paid = /\bpaid\b/.test(b.$question.text);
      const metric = paid ? 'revenue' : 'invoiced';
      return [{ tool: 'business_metric', args: { metric, ...windowArgs(period.window), compare: false }, why: `Invoices ${paid ? 'paid' : 'issued'} over ${period.window.label}.` }];
    },
    render: (steps, b, v) => {
      const period = slot(b, 'period', 'period');
      const result = resultOf<MetricToolResult>(steps);
      const paid = result.metric === 'revenue';
      return renderCount(result.count, `${paid ? 'paid' : 'issued'} invoice|${paid ? 'paid' : 'issued'} invoices`, periodPhrase(period.window.label), v.workspace, { period: period.window.label });
    },
  }),
  T({
    id: 'plan-prices', kind: 'ledger', intent: 'lookup',
    description: 'What one product costs, price by price.',
    patterns: [
      `(what does|how much does|how much is|what is the cost of|what is the price of|whats the price of) (the|) {plan} (plan|product|) (cost|)`,
      `how is (the|) {plan} (plan|product|) priced`,
    ],
    tools: ['catalog_list_products'],
    example: (v) => need('What does the ', samplesOf(v).plan, ' plan cost?'),
    plan: (b) => [{ tool: 'catalog_list_products', args: {}, why: `Prices attached to ${slot(b, 'plan', 'plan').name}.` }],
    render: (steps, b) => {
      const plan = slot(b, 'plan', 'plan');
      const products = resultOf<{ id: string; name: string; prices: { id: string; nickname: string | null; summary: string }[] }[]>(steps);
      const product = products.find((p) => p.id === plan.id) ?? { id: plan.id, name: plan.name, prices: [] };
      return renderPrices(product);
    },
  }),

  /* ------------------------------ quiet accounts ------------------------- */
  T({
    id: 'stale-accounts', kind: 'list', intent: 'lookup',
    description: 'Accounts nobody has touched for 45 days or more.',
    patterns: [
      `(which|what) accounts (have gone quiet|have gone cold|are stale|are quiet|have gone silent|have we not touched|have had no activity|have no recent activity)`,
      `(which|what) (companies|customers) (have gone quiet|have gone cold|are stale|have we not touched)`,
      `who (has gone quiet|have we not touched|has gone cold)`,
    ],
    tools: ['stale_accounts'],
    example: () => 'Which accounts have gone quiet?',
    plan: () => [{ tool: 'stale_accounts', args: { days: 45, limit: 10 }, why: 'Companies with no activity for 45 days or more, quietest first.' }],
    render: (steps, _b, v) => renderStale(resultOf<StaleAccountsResult>(steps), v.workspace),
  }),
  T({
    id: 'stale-accounts-days', kind: 'list', intent: 'lookup',
    description: 'Accounts with no activity for a number of days.',
    patterns: [
      `(which|what) accounts (have had no activity|have been quiet|have gone quiet|have we not touched|have not been touched|have no activity) (in|for) (the last|the past|over|) {number} days`,
      `(which|what) (companies|customers) (have had no activity|have been quiet|have we not touched|have not been touched) (in|for) (the last|the past|over|) {number} days`,
      `who (have we|has anyone) not touched (in|for) (the last|the past|over|) {number} days`,
    ],
    tools: ['stale_accounts'],
    example: () => 'Which accounts have had no activity in 60 days?',
    plan: (b) => {
      const days = slot(b, 'number', 'number').value;
      return [{ tool: 'stale_accounts', args: { days: Math.min(days, 3650), limit: 10 }, why: `Companies with no activity for ${days} days or more.` }];
    },
    render: (steps, _b, v) => renderStale(resultOf<StaleAccountsResult>(steps), v.workspace),
  }),

  /* ------------------------------- metering ------------------------------ */
  T({
    id: 'metered-usage', kind: 'usage', intent: 'aggregate',
    description: 'How much of one meter the workspace recorded over a period.',
    patterns: [
      `how (much|many) {meter} (did we|have we) (meter|record|use|consume|ingest|log|see) {period}`,
      `${WHAT_WAS} ${OUR} {meter} (usage|volume|consumption) {period}`,
      `how (much|many) {meter} (were|was) (metered|recorded|used|consumed|ingested|logged) {period}`,
    ],
    tools: ['metered_usage'],
    example: (v) => need('How many ', samplesOf(v).meter?.toLowerCase() ?? null, ' did we meter in the last 30 days?'),
    plan: (b) => {
      const meter = slot(b, 'meter', 'meter');
      const period = slot(b, 'period', 'period');
      return [{ tool: 'metered_usage', args: { meter: meter.id, start: period.window.start, end: period.window.end, window_label: period.window.label }, why: `${meter.name} over ${period.window.label}, across every account that metered.` }];
    },
    render: (steps, _b, v) => renderUsage(resultOf<MeteredUsageResult>(steps), v.workspace),
  }),
  T({
    id: 'account-metered-usage', kind: 'usage', intent: 'aggregate',
    description: 'How much of one meter one account recorded over a period.',
    patterns: [
      `how (much|many) {meter} (did|has) {account} (use|consume|meter|record|ingest|log) {period}`,
      `${WHAT_WAS} {account} {meter} (usage|volume|consumption) {period}`,
    ],
    tools: ['metered_usage'],
    example: (v) => need('How many ', samplesOf(v).meter?.toLowerCase() ?? null, ' did ', samplesOf(v).account, ' use in the last 30 days?'),
    check: (b, v) => {
      const account = slot(b, 'account', 'record');
      return linkedCustomerIds(v.ctx, v.orgId, { id: account.id, type: account.type, label: account.label }).length
        ? null
        : `${account.label} has no billing or metering account, so no meter reads for it.`;
    },
    plan: (b, v) => {
      const meter = slot(b, 'meter', 'meter');
      const account = slot(b, 'account', 'record');
      const period = slot(b, 'period', 'period');
      const customer = linkedCustomerIds(v.ctx, v.orgId, { id: account.id, type: account.type, label: account.label })[0];
      return [{ tool: 'metered_usage', args: { meter: meter.id, customer, start: period.window.start, end: period.window.end, window_label: period.window.label }, why: `${meter.name} for ${account.label} over ${period.window.label}.` }];
    },
    render: (steps, _b, v) => renderUsage(resultOf<MeteredUsageResult>(steps), v.workspace),
  }),
  T({
    id: 'quote-price', kind: 'quote', intent: 'lookup',
    description: 'What a quantity of a metered product would cost on its price.',
    patterns: [
      `how much (would|will|does|do|did) {quantity} {meter} cost`,
      `(what would|what does|what do) {quantity} {meter} cost`,
      `${WHAT_IS} the (price|cost) (of|for) {quantity} {meter}`,
      `(quote|price) (me|) {quantity} {meter}`,
    ],
    tools: ['catalog_quote_price'],
    example: (v) => need('How much would 50 million ', samplesOf(v).pricedMeter?.toLowerCase() ?? null, ' cost?'),
    check: (b) => (slot(b, 'meter', 'meter').priceKey ? null : `No price in the catalogue is attached to the ${slot(b, 'meter', 'meter').name} meter.`),
    plan: (b) => {
      const meter = slot(b, 'meter', 'meter');
      const quantity = slot(b, 'quantity', 'quantity');
      return [{ tool: 'catalog_quote_price', args: { price: meter.priceKey, quantity: quantity.value }, why: `${quantity.formatted} on the ${meter.name} price.` }];
    },
    render: (steps, b, v) => {
      const meter = slot(b, 'meter', 'meter');
      const result = resultOf<{ product: string | null; quantity: number; amount: number; amount_display: string; breakdown: string[]; warning: string | null }>(steps);
      const unit = meter.unit ? (result.quantity === 1 ? meter.unit : /^[A-Z]{1,4}$/.test(meter.unit) ? meter.unit : `${meter.unit}s`) : meter.name.toLowerCase();
      return renderQuote(result, unit, v.workspace.currency, v.workspace);
    },
  }),

  /* ------------------------------- accounts ------------------------------ */
  T({
    id: 'account-profile', kind: 'lookup', intent: 'lookup',
    description: 'Where one account stands: owner, open pipeline, lifetime won, contacts, tickets, last activity.',
    patterns: [
      `tell me about {account}`,
      `where does {account} stand (right now|now|today|)`,
      `what do we know about {account}`,
      `how is {account} (doing|looking)`,
      `(show me|give me|whats|what is) (the|) {account} (account|profile|account profile|overview|summary)`,
      `(summarise|summarize) {account}`,
    ],
    tools: ['account_profile'],
    example: (v) => need('Where does ', samplesOf(v).account, ' stand?'),
    plan: (b) => [{ tool: 'account_profile', args: { id: slot(b, 'account', 'record').id }, why: `The full picture of ${slot(b, 'account', 'record').label}.` }],
    render: (steps, _b, v) => renderProfile(resultOf<AccountProfileResult>(steps), v.workspace),
  }),
  T({
    id: 'account-owner', kind: 'lookup', intent: 'lookup',
    description: 'Who owns an account.',
    patterns: [
      `who owns {account}`,
      `who is the owner of {account}`,
      `who is {account} (owner|account owner|owned by)`,
      `who (looks after|manages|is responsible for) {account}`,
    ],
    tools: ['account_profile'],
    example: (v) => need('Who owns ', samplesOf(v).account, '?'),
    plan: (b) => [{ tool: 'account_profile', args: { id: slot(b, 'account', 'record').id }, why: `The owner on ${slot(b, 'account', 'record').label}.` }],
    render: (steps, b) => {
      const profile = resultOf<AccountProfileResult>(steps);
      const account = slot(b, 'account', 'record');
      return renderField('Owner', profile.owner ? `${profile.owner} owns ${profile.name}.` : `${profile.name} has no owner.`, { id: account.id, label: profile.name, type: profile.object_type });
    },
  }),
  T({
    id: 'account-spend-period', kind: 'metric', intent: 'aggregate',
    description: 'What one account paid over a period.',
    patterns: [
      `how much (did|has) {account} (spend|spent|pay us|paid us|pay|paid) {period}`,
      `${WHAT_WAS} {account} spend {period}`,
      `how much (revenue|) (did we|have we) (collect|collected|get|make) from {account} {period}`,
    ],
    tools: ['business_metric'],
    example: (v) => need('How much did ', samplesOf(v).account, ` spend in ${samplesOf(v).year}?`),
    plan: (b) => {
      const account = slot(b, 'account', 'record');
      const period = slot(b, 'period', 'period');
      return [{ tool: 'business_metric', args: { metric: 'spend', subject_id: account.id, ...windowArgs(period.window), compare: false }, why: `Paid invoices for ${account.label} over ${period.window.label}.` }];
    },
    render: (steps, b, v) => {
      const account = slot(b, 'account', 'record');
      const period = slot(b, 'period', 'period');
      const result = resultOf<MetricToolResult>(steps);
      if (result.unit === 'money' && result.books.length <= 1) {
        const content = result.count === 0
          ? `${account.label} paid nothing ${periodPhrase(period.window.label)} — ${result.source}.`
          : `${account.label} spent ${result.formatted} ${periodPhrase(period.window.label)}, across ${result.source}.`;
        return { content, citations: result.evidence.slice(0, 8), facts: { ...NO_FACTS, value: result.value, formatted: result.formatted, unit: 'money', currency: result.currency, count: result.count, label: 'Customer spend', period: period.window.label, subject: account.label } };
      }
      return renderMetric(result, v.workspace, { period: period.window.label, subject: account.label });
    },
  }),
  T({
    id: 'account-invoiced-period', kind: 'metric', intent: 'aggregate',
    description: 'What one account was invoiced over a period.',
    patterns: [
      `how much (did we|have we) (invoice|bill|invoiced|billed) {account} {period}`,
      `how much (was|were) {account} (invoiced|billed) {period}`,
    ],
    tools: ['business_metric'],
    example: (v) => need('How much did we invoice ', samplesOf(v).account, ` in ${samplesOf(v).year}?`),
    plan: (b) => {
      const account = slot(b, 'account', 'record');
      const period = slot(b, 'period', 'period');
      return [{ tool: 'business_metric', args: { metric: 'invoiced', subject_id: account.id, ...windowArgs(period.window), compare: false }, why: `Invoices raised to ${account.label} over ${period.window.label}.` }];
    },
    render: (steps, b, v) => renderMetric(resultOf<MetricToolResult>(steps), v.workspace, { period: slot(b, 'period', 'period').window.label, subject: slot(b, 'account', 'record').label }),
  }),
  T({
    id: 'account-snapshot-metric', kind: 'metric', intent: 'aggregate',
    description: 'A snapshot measure for one account — its open pipeline, MRR, outstanding balance, open tickets.',
    patterns: [
      `${WHAT_IS} {account} {metric:snapshot-metric}`,
      `${WHAT_IS} the {metric:snapshot-metric} (of|for|at|on|with) {account}`,
      `how much {metric:snapshot-metric} does {account} have`,
      `how much (open pipeline|pipeline) (do we have|is there) (with|at|for) {account}`,
    ],
    tools: ['business_metric'],
    example: (v) => need('What is ', samplesOf(v).account, "'s open pipeline?"),
    check: (b) => {
      const metric = maybe(b, 'metric', 'metric');
      return metric && !metric.supportsSubject ? `${metric.label} is a workspace-wide measure and cannot be narrowed to one account.` : null;
    },
    plan: (b) => {
      const account = slot(b, 'account', 'record');
      const metric = maybe(b, 'metric', 'metric')?.id ?? 'pipeline';
      return [{ tool: 'business_metric', args: { metric, subject_id: account.id, compare: false }, why: `${humanise(metric)} for ${account.label}.` }];
    },
    render: (steps, b, v) => renderMetric(resultOf<MetricToolResult>(steps), v.workspace, { subject: slot(b, 'account', 'record').label }),
  }),
  T({
    id: 'account-period-metric', kind: 'metric', intent: 'aggregate',
    description: 'A period measure for one account over a period.',
    patterns: [
      `${WHAT_WAS} {account} {metric:period-metric} {period}`,
      `${WHAT_WAS} the {metric:period-metric} (of|for|from|with|at) {account} {period}`,
    ],
    tools: ['business_metric'],
    example: (v) => need('What was ', samplesOf(v).account, `'s revenue in ${samplesOf(v).year}?`),
    check: (b) => (slot(b, 'metric', 'metric').supportsSubject ? null : `${slot(b, 'metric', 'metric').label} is a workspace-wide measure and cannot be narrowed to one account.`),
    plan: (b) => {
      const account = slot(b, 'account', 'record');
      const metric = slot(b, 'metric', 'metric');
      const period = slot(b, 'period', 'period');
      return [{ tool: 'business_metric', args: { metric: metric.id, subject_id: account.id, ...windowArgs(period.window), compare: false }, why: `${metric.label} for ${account.label} over ${period.window.label}.` }];
    },
    render: (steps, b, v) => renderMetric(resultOf<MetricToolResult>(steps), v.workspace, { period: slot(b, 'period', 'period').window.label, subject: slot(b, 'account', 'record').label }),
  }),
  T({
    id: 'account-owes', kind: 'metric', intent: 'aggregate',
    description: 'What one account still owes on open invoices.',
    patterns: [
      `(what|how much) does {account} owe (us|)`,
      `${WHAT_IS} {account} (outstanding balance|balance|outstanding)`,
      `how much is {account} (behind|outstanding)`,
      `how much (is|does) {account} (still|) (owe|owing) (us|)`,
    ],
    tools: ['business_metric'],
    example: (v) => need('What does ', samplesOf(v).account, ' owe?'),
    plan: (b) => [{ tool: 'business_metric', args: { metric: 'outstanding', subject_id: slot(b, 'account', 'record').id, compare: false }, why: `Open invoices for ${slot(b, 'account', 'record').label}.` }],
    render: (steps, b, v) => {
      const account = slot(b, 'account', 'record');
      const result = resultOf<MetricToolResult>(steps);
      if (result.unit === 'money' && result.books.length <= 1) {
        const content = result.count === 0
          ? `${account.label} owes nothing: no open invoice.`
          : `${account.label} owes ${result.formatted} across ${result.source}.`;
        return { content, citations: result.evidence.slice(0, 8), facts: { ...NO_FACTS, value: result.value, formatted: result.formatted, unit: 'money', currency: result.currency, count: result.count, label: 'Outstanding balance', subject: account.label } };
      }
      return renderMetric(result, v.workspace, { subject: account.label });
    },
  }),
  T({
    id: 'account-open-tickets-count', kind: 'count', intent: 'aggregate',
    description: 'How many open tickets one account has.',
    patterns: [
      `how many (open|) tickets does {account} have (open|)`,
      `how many (open|) tickets are (open|) (at|for|with|on) {account}`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How many open tickets does ', samplesOf(v).account, ' have?'),
    plan: (b) => [{ tool: 'record_aggregate', args: countArgs('ticket', [{ property: 'status', op: 'in', values: ['new', 'waiting_on_us', 'waiting_on_customer', 'escalated'] }], { associated_to: slot(b, 'account', 'record').id }), why: `Open tickets linked to ${slot(b, 'account', 'record').label}.` }],
    render: (steps, b, v) => renderAggregateCount(resultOf<RecordAggregateResult>(steps), 'open ticket|open tickets', `at ${slot(b, 'account', 'record').label}`, v.workspace, { subject: slot(b, 'account', 'record').label }),
  }),
  T({
    id: 'account-open-tickets', kind: 'list', intent: 'lookup',
    description: 'The open tickets on one account.',
    patterns: [
      `(which|what) tickets (does {account} have open|are open (at|for|with|on) {account})`,
      `${LIST} (the|) open tickets (at|for|with|on) {account}`,
      `${LIST} {account} open tickets`,
    ],
    tools: ['record_search'],
    example: (v) => need('Which tickets are open at ', samplesOf(v).account, '?'),
    plan: (b) => [{ tool: 'record_search', args: searchArgs('ticket', [{ property: 'status', op: 'in', values: ['new', 'waiting_on_us', 'waiting_on_customer', 'escalated'] }], { associated_to: slot(b, 'account', 'record').id }), why: `Open tickets linked to ${slot(b, 'account', 'record').label}.` }],
    render: (steps, b, v) => renderList(resultOf<RecordSearchResult>(steps), 'open ticket|open tickets', `at ${slot(b, 'account', 'record').label}`, v.workspace, { subject: slot(b, 'account', 'record').label }),
  }),
  T({
    id: 'account-contacts', kind: 'list', intent: 'lookup',
    description: 'The people we know at one account.',
    patterns: [
      `who do we know at {account}`,
      `(which|what) contacts (do we have|are there|are) (at|for|with) {account}`,
      `${LIST} (the|) contacts (at|for|with) {account}`,
      `who (works at|is at|is the contact at|are the contacts at) {account}`,
    ],
    tools: ['record_search'],
    example: (v) => need('Who do we know at ', samplesOf(v).account, '?'),
    plan: (b) => [{ tool: 'record_search', args: searchArgs('contact', [], { associated_to: slot(b, 'account', 'record').id }, 25), why: `Contacts linked to ${slot(b, 'account', 'record').label}.` }],
    render: (steps, b, v) => renderList(resultOf<RecordSearchResult>(steps), 'contact|contacts', `at ${slot(b, 'account', 'record').label}`, v.workspace, { subject: slot(b, 'account', 'record').label }),
  }),
  T({
    id: 'account-contacts-count', kind: 'count', intent: 'aggregate',
    description: 'How many contacts we hold at one account.',
    patterns: [
      `how many contacts (do we have|are there|are) (at|for|with) {account}`,
      `how many (people|contacts) do we know at {account}`,
      `how many contacts does {account} have`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How many contacts do we have at ', samplesOf(v).account, '?'),
    plan: (b) => [{ tool: 'record_aggregate', args: countArgs('contact', [], { associated_to: slot(b, 'account', 'record').id }), why: `Contacts linked to ${slot(b, 'account', 'record').label}.` }],
    render: (steps, b, v) => renderAggregateCount(resultOf<RecordAggregateResult>(steps), 'contact|contacts', `at ${slot(b, 'account', 'record').label}`, v.workspace, { subject: slot(b, 'account', 'record').label }),
  }),
  T({
    id: 'account-open-deals', kind: 'list', intent: 'lookup',
    description: 'The open deals on one account.',
    patterns: [
      `(which|what) deals (does {account} have open|are open (at|for|with|on) {account}|do we have open (at|for|with) {account})`,
      `(which|what) (open|) deals (does|do) (we have with|) {account} (have|)`,
      `${LIST} (the|) open deals (at|for|with|on) {account}`,
      `${LIST} {account} open deals`,
    ],
    tools: ['record_search'],
    example: (v) => need('Which deals are open at ', samplesOf(v).account, '?'),
    plan: (b, v) => [{ tool: 'record_search', args: searchArgs('deal', [{ property: 'deal_stage', op: 'in', values: v.stages.open }], { associated_to: slot(b, 'account', 'record').id }), why: `Open deals linked to ${slot(b, 'account', 'record').label}.` }],
    render: (steps, b, v) => renderList(resultOf<RecordSearchResult>(steps), 'open deal|open deals', `at ${slot(b, 'account', 'record').label}`, v.workspace, { subject: slot(b, 'account', 'record').label }),
  }),
  T({
    id: 'record-timeline', kind: 'lookup', intent: 'summarise',
    description: 'The recent history of one record — calls, meetings, emails, notes and changes.',
    patterns: [
      `what (happened|has happened|has been happening) (recently|lately|) (on|at|with) {record}`,
      `(show me|whats|what is) the (recent|) (history|timeline|activity) (on|of|for|at|with) {record}`,
      `(what is|whats) (the|) (latest|recent) (on|with|at) {record}`,
    ],
    tools: ['record_timeline'],
    example: (v) => need('What happened recently at ', samplesOf(v).account, '?'),
    plan: (b) => [{ tool: 'record_timeline', args: { record_id: slot(b, 'record', 'record').id, limit: 10 }, why: `Recent activity on ${slot(b, 'record', 'record').label}.` }],
    render: (steps, _b, v) => {
      const result = resultOf<{ record: string; items: TimelineItem[] }>(steps);
      return renderTimeline(result.record, result.items, v.workspace);
    },
  }),

  /* --------------------------------- deals ------------------------------- */
  T({
    id: 'deal-stage', kind: 'lookup', intent: 'lookup',
    description: 'Which stage one deal is at.',
    patterns: [
      `(what|which) stage is {deal} (in|at)`,
      `where is {deal} (in the pipeline|at)`,
      `${WHAT_IS} the stage of {deal}`,
    ],
    tools: ['get_record'],
    example: (v) => need('What stage is ', samplesOf(v).deal, ' at?'),
    plan: (b) => [{ tool: 'get_record', args: { object_type: 'deal', id: slot(b, 'deal', 'record').id }, why: `Read ${slot(b, 'deal', 'record').label}.` }],
    render: (steps, b, v) => {
      const deal = slot(b, 'deal', 'record');
      const record = resultOf<{ display_name: string; properties: Record<string, unknown>; formatted: Record<string, string> }>(steps);
      const value = String(record.properties.deal_stage ?? '');
      const pipeline = String(record.properties.pipeline ?? '');
      const stage = v.crm.stages.find((s) => s.value === value);
      const label = stage?.aliases.find((a) => a.pipelines.includes(pipeline))?.label ?? stage?.label ?? record.formatted.deal_stage ?? humanise(value);
      const pipelineLabel = v.crm.pipelines.find((p) => p.value === pipeline)?.label;
      return renderField('Stage', `${record.display_name} is at the ${label} stage${pipelineLabel ? ` of the ${pipelineLabel} pipeline` : ''}.`, { id: deal.id, label: record.display_name, type: 'deal' });
    },
  }),
  T({
    id: 'deal-close-date', kind: 'lookup', intent: 'lookup',
    description: 'When one deal is due to close.',
    patterns: [
      `when (does|will|is|did) {deal} (close|closing|due to close|expected to close|set to close)`,
      `${WHAT_IS} the close date (of|on|for) {deal}`,
    ],
    tools: ['get_record'],
    example: (v) => need('When does ', samplesOf(v).deal, ' close?'),
    plan: (b) => [{ tool: 'get_record', args: { object_type: 'deal', id: slot(b, 'deal', 'record').id }, why: `Read ${slot(b, 'deal', 'record').label}.` }],
    render: (steps, b, v) => {
      const deal = slot(b, 'deal', 'record');
      const record = resultOf<{ display_name: string; properties: Record<string, unknown> }>(steps);
      const at = Number(record.properties.close_date ?? 0);
      const status = String(record.properties.deal_status ?? 'open');
      const sentence = !at
        ? `${record.display_name} has no close date.`
        : status === 'open'
          ? `${record.display_name} is due to close on ${dateOf(at, v.workspace)}.`
          : `${record.display_name} closed on ${dateOf(at, v.workspace)} (${status}).`;
      return renderField('Close date', sentence, { id: deal.id, label: record.display_name, type: 'deal' });
    },
  }),
  T({
    id: 'deal-owner', kind: 'lookup', intent: 'lookup',
    description: 'Who owns one deal.',
    patterns: [
      `who owns {deal}`,
      `who is (the owner of|working|working on|running) {deal}`,
      `whose deal is {deal}`,
    ],
    tools: ['get_record'],
    example: (v) => need('Who owns ', samplesOf(v).deal, '?'),
    plan: (b) => [{ tool: 'get_record', args: { object_type: 'deal', id: slot(b, 'deal', 'record').id }, why: `Read ${slot(b, 'deal', 'record').label}.` }],
    render: (steps, b) => {
      const deal = slot(b, 'deal', 'record');
      const record = resultOf<{ display_name: string; owner: string | null }>(steps);
      return renderField('Owner', record.owner ? `${record.owner} owns ${record.display_name}.` : `${record.display_name} has no owner.`, { id: deal.id, label: record.display_name, type: 'deal' });
    },
  }),
  T({
    id: 'deal-amount', kind: 'lookup', intent: 'lookup',
    description: 'What one deal is worth.',
    patterns: [
      `how much is {deal} worth`,
      `${WHAT_IS} {deal} worth`,
      `${WHAT_IS} the (amount|value|size) (of|on) {deal}`,
    ],
    tools: ['get_record'],
    example: (v) => need('How much is ', samplesOf(v).deal, ' worth?'),
    plan: (b) => [{ tool: 'get_record', args: { object_type: 'deal', id: slot(b, 'deal', 'record').id }, why: `Read ${slot(b, 'deal', 'record').label}.` }],
    render: (steps, b, v) => {
      const deal = slot(b, 'deal', 'record');
      const record = resultOf<{ display_name: string; properties: Record<string, unknown> }>(steps);
      const amount = Number(record.properties.amount ?? 0);
      const rendered = renderField('Amount', `${record.display_name} is worth ${money(amount, v.workspace.currency, v.workspace)}.`, { id: deal.id, label: record.display_name, type: 'deal' });
      return { ...rendered, facts: { ...rendered.facts, value: amount, formatted: money(amount, v.workspace.currency, v.workspace), unit: 'money', currency: v.workspace.currency } };
    },
  }),
  T({
    id: 'largest-deal', kind: 'list', intent: 'lookup',
    description: 'The biggest or smallest deal, optionally in one state.',
    patterns: [
      `${WHAT_IS} ${OUR} {superlative} {state:deal-state} deal`,
      `${WHAT_IS} ${OUR} {superlative} deal`,
      `(which|what) (is|deal is) ${OUR} {superlative} {state:deal-state} deal`,
      `(which|what) (is|deal is) ${OUR} {superlative} deal`,
    ],
    tools: ['record_search'],
    example: () => 'What is our biggest open deal?',
    plan: (b) => {
      const superlative = slot(b, 'superlative', 'superlative');
      const state = maybe(b, 'state', 'state');
      return [{ tool: 'record_search', args: { object_type: 'deal', conditions: state?.conditions ?? [], order_by: 'amount', direction: superlative.direction, limit: 1 }, why: `The ${superlative.label} ${state?.noun ?? ''} deal by amount.` }];
    },
    render: (steps, b, v) => {
      const superlative = slot(b, 'superlative', 'superlative');
      const state = maybe(b, 'state', 'state');
      const result = resultOf<RecordSearchResult>(steps);
      const top = result.records[0];
      if (!top) return { content: `There are no ${state ? `${state.noun} ` : ''}deals.`, citations: [], facts: { ...NO_FACTS, count: 0 } };
      const amount = Number(top.properties.amount ?? 0);
      return {
        content: `${top.name} is the ${superlative.label} ${state ? `${state.noun} ` : ''}deal, at ${money(amount, v.workspace.currency, v.workspace)}${top.owner ? ` (${top.owner})` : ''}.`,
        citations: citationsOf([top], 'deal'),
        facts: { ...NO_FACTS, value: amount, formatted: money(amount, v.workspace.currency, v.workspace), unit: 'money', currency: v.workspace.currency, count: 1, label: `${superlative.label} deal`, subject: top.name, rows: [{ id: top.id, label: top.name }] },
      };
    },
  }),
  T({
    id: 'top-n-deals', kind: 'list', intent: 'lookup',
    description: 'The N biggest or smallest deals, optionally in one state.',
    patterns: [
      `(what are|list|show me|show|give me) ${OUR} {number} {superlative} {state:deal-state} deals`,
      `(what are|list|show me|show|give me) ${OUR} {number} {superlative} deals`,
      `top {number} {state:deal-state} deals`,
      `top {number} deals`,
      `${OUR} {number} {superlative} {state:deal-state} deals`,
    ],
    tools: ['record_search'],
    example: () => 'What are our 5 biggest open deals?',
    plan: (b) => {
      const direction = maybe(b, 'superlative', 'superlative')?.direction ?? 'desc';
      const limit = Math.min(slot(b, 'number', 'number').value, 50);
      const state = maybe(b, 'state', 'state');
      return [{ tool: 'record_search', args: { object_type: 'deal', conditions: state?.conditions ?? [], order_by: 'amount', direction, limit }, why: `The ${limit} ${direction === 'desc' ? 'largest' : 'smallest'} deals by amount.` }];
    },
    render: (steps, b, v) => {
      const direction = maybe(b, 'superlative', 'superlative')?.direction ?? 'desc';
      const state = maybe(b, 'state', 'state');
      const result = resultOf<RecordSearchResult>(steps);
      const limit = Math.min(slot(b, 'number', 'number').value, 50);
      const rows = result.records;
      if (!rows.length) return { content: `There are no ${state ? `${state.noun} ` : ''}deals.`, citations: [], facts: { ...NO_FACTS, count: 0 } };
      const lines = rows.map((row, i) => `${i + 1}. ${row.name} — ${money(Number(row.properties.amount ?? 0), v.workspace.currency, v.workspace)}${row.owner ? ` · ${row.owner}` : ''}`);
      return {
        content: `The ${rows.length} ${direction === 'desc' ? 'biggest' : 'smallest'} ${state ? `${state.noun} ` : ''}deals by amount:\n\n${lines.join('\n')}`,
        citations: citationsOf(rows, 'deal'),
        facts: { ...NO_FACTS, count: rows.length, label: `top ${limit} deals`, mixed: true, rows: rows.map((r) => ({ id: r.id, label: r.name })) },
      };
    },
  }),

  /* ------------------------------ comparisons ---------------------------- */
  T({
    id: 'compare-metric', kind: 'compare', intent: 'compare',
    description: 'One period measure across two periods, with the change between them.',
    patterns: [
      `compare ${OUR} {metric:period-metric} {a:period} (with|to|against|and|versus|vs) {b:period}`,
      `how (did|does) ${OUR} {metric:period-metric} {a:period} compare (with|to|against) {b:period}`,
      `${OUR} {metric:period-metric} {a:period} (versus|vs|compared with|compared to) {b:period}`,
      `${WHAT_WAS} ${OUR} {metric:period-metric} {a:period} (versus|vs|compared with|compared to) {b:period}`,
    ],
    tools: ['business_metric'],
    example: (v) => `How did our closed-won bookings in ${samplesOf(v).year} compare with ${samplesOf(v).year - 1}?`,
    plan: (b) => {
      const metric = slot(b, 'metric', 'metric');
      const a = slot(b, 'a', 'period');
      const c = slot(b, 'b', 'period');
      return [
        { tool: 'business_metric', args: { metric: metric.id, ...windowArgs(a.window), compare: false }, why: `${metric.label} over ${a.window.label}.` },
        { tool: 'business_metric', args: { metric: metric.id, ...windowArgs(c.window), compare: false }, why: `${metric.label} over ${c.window.label}.` },
      ];
    },
    render: (steps, b, v) => renderCompare(resultOf<MetricToolResult>(steps, 0), resultOf<MetricToolResult>(steps, 1), v.workspace, [slot(b, 'a', 'period').window.label, slot(b, 'b', 'period').window.label]),
  }),

  /* ------------------------------ dimensions ----------------------------- */
  T({
    id: 'count-by-dimension', kind: 'breakdown', intent: 'aggregate',
    description: 'How many records there are per value of one picklist property, or per owner.',
    patterns: [
      `how many {object} (are there|do we have|) by {dim:property-dim}`,
      `(break down|breakdown of|split) (the|our|) {object} by {dim:property-dim}`,
      `{object} by {dim:property-dim}`,
      `(count|number of) {object} by {dim:property-dim}`,
    ],
    tools: ['record_aggregate'],
    example: () => 'How many deals are there by stage?',
    plan: (b) => {
      const object = slot(b, 'object', 'object');
      const dim = slot(b, 'dim', 'property');
      return [{ tool: 'record_aggregate', args: countArgs(object.type, [], { group_by: dim.name }), why: `Count ${object.plural} per ${dim.label}.` }];
    },
    render: (steps, b, v) => renderGroupedCount(resultOf<RecordAggregateResult>(steps), thingOf(null, slot(b, 'object', 'object')), slot(b, 'dim', 'property').label.toLowerCase(), v.workspace),
  }),
  T({
    id: 'companies-in-industry', kind: 'list', intent: 'lookup',
    description: 'The companies in one industry.',
    patterns: [
      `(which|what) (companies|accounts) are in (the|) {industry} (industry|sector|vertical|)`,
      `(which|what) (companies|accounts) are {industry} (companies|accounts|)`,
      `${LIST} (the|our|) {industry} (companies|accounts)`,
      `${LIST} (the|our|) (companies|accounts) in (the|) {industry} (industry|sector|vertical|)`,
    ],
    tools: ['record_search'],
    example: (v) => need('Which companies are in the ', samplesOf(v).industry?.toLowerCase() ?? null, ' industry?'),
    plan: (b) => {
      const industry = slot(b, 'industry', 'option');
      return [{ tool: 'record_search', args: searchArgs('company', [{ property: 'industry', op: 'eq', value: industry.value }], {}, 25), why: `Companies whose industry is ${industry.label}.` }];
    },
    render: (steps, b, v) => renderList(resultOf<RecordSearchResult>(steps), 'company|companies', `in the ${slot(b, 'industry', 'option').label} industry`, v.workspace),
  }),
  T({
    id: 'count-companies-in-industry', kind: 'count', intent: 'aggregate',
    description: 'How many companies are in one industry.',
    patterns: [
      `how many (companies|accounts) are in (the|) {industry} (industry|sector|vertical|)`,
      `how many (companies|accounts) are {industry} (companies|accounts|)`,
      `how many {industry} (companies|accounts) (do we have|are there|)`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How many companies are in the ', samplesOf(v).industry?.toLowerCase() ?? null, ' industry?'),
    plan: (b) => {
      const industry = slot(b, 'industry', 'option');
      return [{ tool: 'record_aggregate', args: countArgs('company', [{ property: 'industry', op: 'eq', value: industry.value }]), why: `Count companies whose industry is ${industry.label}.` }];
    },
    render: (steps, b, v) => renderAggregateCount(resultOf<RecordAggregateResult>(steps), 'company|companies', `in the ${slot(b, 'industry', 'option').label} industry`, v.workspace),
  }),
  T({
    id: 'companies-in-region', kind: 'list', intent: 'lookup',
    description: 'The companies in one sales region.',
    patterns: [
      `(which|what) (companies|accounts) are in {region}`,
      `(which|what) (companies|accounts) are in the {region} region`,
      `${LIST} (the|our|) (companies|accounts) in (the|) {region} (region|)`,
    ],
    tools: ['record_search'],
    example: (v) => need('Which companies are in ', samplesOf(v).region, '?'),
    plan: (b) => {
      const region = slot(b, 'region', 'option');
      return [{ tool: 'record_search', args: searchArgs('company', [{ property: 'region', op: 'eq', value: region.value }], {}, 25), why: `Companies whose region is ${region.label}.` }];
    },
    render: (steps, b, v) => renderList(resultOf<RecordSearchResult>(steps), 'company|companies', `in ${slot(b, 'region', 'option').label}`, v.workspace),
  }),
  T({
    id: 'deals-from-source', kind: 'list', intent: 'lookup',
    description: 'The deals that came from one lead source.',
    patterns: [
      `(which|what) (open|) deals (came from|come from|originated from|were sourced from) {source:lead-source}`,
      `${LIST} (the|our|) (open|) deals (from|sourced from) {source:lead-source}`,
      `(which|what) {state:deal-state} deals (came from|come from) {source:lead-source}`,
    ],
    tools: ['record_search'],
    example: (v) => need('Which deals came from ', samplesOf(v).source?.toLowerCase() ?? null, 's?'),
    plan: (b, v) => {
      const source = slot(b, 'source', 'option');
      const state = maybe(b, 'state', 'state');
      const open = !state && /\bopen deals\b/.test(b.$question.text) ? [{ property: 'deal_stage', op: 'in', values: v.stages.open } as Condition] : [];
      const conditions: Condition[] = [{ property: 'lead_source', op: 'eq', value: source.value }, ...(state?.conditions ?? []), ...open];
      return [{ tool: 'record_search', args: searchArgs('deal', conditions), why: `Deals whose lead source is ${source.label}.` }];
    },
    render: (steps, b, v) => {
      const state = maybe(b, 'state', 'state');
      const open = !state && /\bopen deals\b/.test(b.$question.text);
      return renderList(resultOf<RecordSearchResult>(steps), open ? 'open deal|open deals' : dealThing(state), `from ${slot(b, 'source', 'option').label.toLowerCase()}`, v.workspace);
    },
  }),
  T({
    id: 'count-deals-from-source', kind: 'count', intent: 'aggregate',
    description: 'How many deals came from one lead source.',
    patterns: [
      `how many deals (came from|come from|originated from|were sourced from) {source:lead-source}`,
      `how many {state:deal-state} deals (came from|come from|originated from) {source:lead-source}`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How many deals came from ', samplesOf(v).source?.toLowerCase() ?? null, 's?'),
    plan: (b) => {
      const source = slot(b, 'source', 'option');
      const state = maybe(b, 'state', 'state');
      return [{ tool: 'record_aggregate', args: countArgs('deal', [{ property: 'lead_source', op: 'eq', value: source.value }, ...(state?.conditions ?? [])]), why: `Count deals whose lead source is ${source.label}.` }];
    },
    render: (steps, b, v) => renderAggregateCount(resultOf<RecordAggregateResult>(steps), dealThing(maybe(b, 'state', 'state')), `from ${slot(b, 'source', 'option').label.toLowerCase()}`, v.workspace),
  }),
  T({
    id: 'pipeline-from-source', kind: 'metric', intent: 'aggregate',
    description: 'How much open pipeline came from one lead source.',
    patterns: [
      `how much (open|) pipeline (came from|come from|comes from|originated from|is from) {source:lead-source}`,
      `${WHAT_IS} ${OUR} (open|) pipeline from {source:lead-source}`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How much open pipeline came from ', samplesOf(v).source?.toLowerCase() ?? null, 's?'),
    plan: (b, v) => {
      const source = slot(b, 'source', 'option');
      return [{ tool: 'record_aggregate', args: { object_type: 'deal', measure: 'sum', property: 'amount', conditions: [{ property: 'deal_stage', op: 'in', values: v.stages.open }, { property: 'lead_source', op: 'eq', value: source.value }] }, why: `Open deal amount where the lead source is ${source.label}.` }];
    },
    render: (steps, b, v) => renderAggregateMeasure(resultOf<RecordAggregateResult>(steps), 'total', 'open pipeline', true, `open deals from ${slot(b, 'source', 'option').label.toLowerCase()}`, v.workspace),
  }),
  T({
    id: 'deals-lost-to-competitor', kind: 'list', intent: 'lookup',
    description: 'The deals lost to one competitor.',
    patterns: [
      `(which|what) deals (did we lose|have we lost|were lost) to {competitor}`,
      `${LIST} (the|) deals (we lost|lost) to {competitor}`,
    ],
    tools: ['record_search'],
    example: (v) => need('Which deals did we lose to ', samplesOf(v).competitor, '?'),
    plan: (b, v) => {
      const competitor = slot(b, 'competitor', 'option');
      return [{ tool: 'record_search', args: searchArgs('deal', [{ property: 'deal_stage', op: 'in', values: v.stages.lost }, { property: 'competitor', op: 'eq', value: competitor.value }]), why: `Closed-lost deals where the competitor is ${competitor.label}.` }];
    },
    render: (steps, b, v) => renderList(resultOf<RecordSearchResult>(steps), 'closed-lost deal|closed-lost deals', `lost to ${slot(b, 'competitor', 'option').label}`, v.workspace),
  }),
  T({
    id: 'count-deals-lost-to-competitor', kind: 'count', intent: 'aggregate',
    description: 'How many deals were lost to one competitor.',
    patterns: [
      `how many deals (did we lose|have we lost|were lost) to {competitor}`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How many deals did we lose to ', samplesOf(v).competitor, '?'),
    plan: (b, v) => {
      const competitor = slot(b, 'competitor', 'option');
      return [{ tool: 'record_aggregate', args: countArgs('deal', [{ property: 'deal_stage', op: 'in', values: v.stages.lost }, { property: 'competitor', op: 'eq', value: competitor.value }]), why: `Count closed-lost deals where the competitor is ${competitor.label}.` }];
    },
    render: (steps, b, v) => renderAggregateCount(resultOf<RecordAggregateResult>(steps), 'closed-lost deal|closed-lost deals', `lost to ${slot(b, 'competitor', 'option').label}`, v.workspace),
  }),
  T({
    id: 'deals-in-forecast-category', kind: 'list', intent: 'lookup',
    description: 'The open deals in one forecast category.',
    patterns: [
      `(which|what) (open|) deals are in (the|) {forecast:forecast-category} (forecast category|category|forecast|)`,
      `${LIST} (the|our|) (open|) deals in (the|) {forecast:forecast-category} (forecast category|category|forecast|)`,
    ],
    tools: ['record_search'],
    example: (v) => need('Which deals are in the ', samplesOf(v).forecast, ' forecast category?'),
    plan: (b, v) => {
      const forecast = slot(b, 'forecast', 'option');
      return [{ tool: 'record_search', args: searchArgs('deal', [{ property: 'deal_stage', op: 'in', values: v.stages.open }, { property: 'forecast_category', op: 'eq', value: forecast.value }]), why: `Open deals whose forecast category is ${forecast.label}.` }];
    },
    render: (steps, b, v) => renderList(resultOf<RecordSearchResult>(steps), 'open deal|open deals', `in the ${slot(b, 'forecast', 'option').label} forecast category`, v.workspace),
  }),
  T({
    id: 'pipeline-in-forecast-category', kind: 'metric', intent: 'aggregate',
    description: 'How much open pipeline sits in one forecast category.',
    patterns: [
      `how much (open|) pipeline is in (the|) {forecast:forecast-category} (forecast category|category|forecast|)`,
      `${WHAT_IS} ${OUR} (open|) pipeline in (the|) {forecast:forecast-category} (forecast category|category|forecast|)`,
    ],
    tools: ['record_aggregate'],
    example: (v) => need('How much open pipeline is in the ', samplesOf(v).forecast, ' forecast category?'),
    plan: (b, v) => {
      const forecast = slot(b, 'forecast', 'option');
      return [{ tool: 'record_aggregate', args: { object_type: 'deal', measure: 'sum', property: 'amount', conditions: [{ property: 'deal_stage', op: 'in', values: v.stages.open }, { property: 'forecast_category', op: 'eq', value: forecast.value }] }, why: `Open deal amount in the ${forecast.label} forecast category.` }];
    },
    render: (steps, b, v) => renderAggregateMeasure(resultOf<RecordAggregateResult>(steps), 'total', 'open pipeline', true, `open deals in the ${slot(b, 'forecast', 'option').label} forecast category`, v.workspace),
  }),
  T({
    id: 'deals-with-term', kind: 'count', intent: 'aggregate',
    description: 'How many deals carry a given contract term.',
    patterns: [
      `how many deals have a {number} month (contract|contract term|term)`,
      `how many {state:deal-state} deals have a {number} month (contract|contract term|term)`,
      `how many deals are on a {number} month (contract|contract term|term)`,
    ],
    tools: ['record_aggregate'],
    example: () => 'How many deals have a 36-month contract term?',
    plan: (b) => {
      const months = slot(b, 'number', 'number').value;
      const state = maybe(b, 'state', 'state');
      return [{ tool: 'record_aggregate', args: countArgs('deal', [...(state?.conditions ?? []), { property: 'contract_term_months', op: 'eq', value: months }]), why: `Count deals with a ${months}-month contract term.` }];
    },
    render: (steps, b, v) => renderAggregateCount(resultOf<RecordAggregateResult>(steps), dealThing(maybe(b, 'state', 'state')), `with a ${slot(b, 'number', 'number').value}-month contract term`, v.workspace),
  }),
  T({
    id: 'objects-missing-property', kind: 'list', intent: 'lookup',
    description: 'Records with one property left empty — deals with no next step, contacts with no email.',
    patterns: [
      `(which|what) {object} have no {property}`,
      `(which|what) {object} (are missing|lack|have no value for|do not have) (a|an|the|) {property}`,
      `(which|what) {state} {object} have no {property}`,
      `${LIST} (the|) {object} (with no|without a|without an|missing a|missing) {property}`,
    ],
    tools: ['record_search'],
    example: () => 'Which deals have no next step?',
    plan: (b) => {
      const object = slot(b, 'object', 'object');
      const property = slot(b, 'property', 'property');
      const state = maybe(b, 'state', 'state');
      return [{ tool: 'record_search', args: searchArgs(object.type, [...(state?.conditions ?? []), { property: property.name, op: 'is_not_set' }]), why: `${object.plural} with no ${property.label}.` }];
    },
    render: (steps, b, v) => renderList(resultOf<RecordSearchResult>(steps), thingOf(maybe(b, 'state', 'state'), slot(b, 'object', 'object')), `with no ${slot(b, 'property', 'property').label.toLowerCase()}`, v.workspace),
  }),
  T({
    id: 'count-objects-missing-property', kind: 'count', intent: 'aggregate',
    description: 'How many records have one property left empty.',
    patterns: [
      `how many {object} have no {property}`,
      `how many {object} (are missing|lack|have no value for|do not have) (a|an|the|) {property}`,
      `how many {state} {object} have no {property}`,
    ],
    tools: ['record_aggregate'],
    example: () => 'How many deals have no next step?',
    plan: (b) => {
      const object = slot(b, 'object', 'object');
      const property = slot(b, 'property', 'property');
      const state = maybe(b, 'state', 'state');
      return [{ tool: 'record_aggregate', args: countArgs(object.type, [...(state?.conditions ?? []), { property: property.name, op: 'is_not_set' }]), why: `Count ${object.plural} with no ${property.label}.` }];
    },
    render: (steps, b, v) => renderAggregateCount(resultOf<RecordAggregateResult>(steps), thingOf(maybe(b, 'state', 'state'), slot(b, 'object', 'object')), `with no ${slot(b, 'property', 'property').label.toLowerCase()}`, v.workspace),
  }),
  T({
    id: 'average-property', kind: 'metric', intent: 'aggregate',
    description: 'The average or total of one numeric property across records, optionally in one state.',
    patterns: [
      `${WHAT_IS} the (average|avg|mean|total|sum of) {property:numeric-property} (of|for|across|on) (our|the|all|) {state} {object}`,
      `${WHAT_IS} the (average|avg|mean|total|sum of) {property:numeric-property} (of|for|across|on) (our|the|all|) {object}`,
    ],
    tools: ['record_aggregate'],
    example: () => 'What is the average contract term of open deals?',
    plan: (b) => {
      const object = slot(b, 'object', 'object');
      const property = slot(b, 'property', 'property');
      const state = maybe(b, 'state', 'state');
      const measure = /\b(total|sum of)\b/.test(b.$question.text) ? 'sum' : 'avg';
      return [{ tool: 'record_aggregate', args: { object_type: object.type, measure, property: property.name, conditions: state?.conditions ?? [] }, why: `${measure === 'sum' ? 'Sum' : 'Average'} of ${property.label} over ${state ? `${state.label} ` : ''}${object.plural}.` }];
    },
    render: (steps, b, v) => {
      const object = slot(b, 'object', 'object');
      const property = slot(b, 'property', 'property');
      const state = maybe(b, 'state', 'state');
      const result = resultOf<RecordAggregateResult>(steps);
      const measure = /^(sum|total)/.test(result.measure) ? 'total' : 'average';
      return renderAggregateMeasure(result, measure, property.label, property.type === 'currency', `${state ? `${state.noun} ` : ''}${object.plural}`, v.workspace);
    },
  }),
  T({
    id: 'count-created-period', kind: 'count', intent: 'aggregate',
    description: 'How many records were created, logged or raised in a period.',
    patterns: [
      `how many {object} (were|did we|have we|got) (created|added|logged|log|hold|held|send|sent|raise|raised|open|opened|create|add|book|booked|record|recorded|make|made) {period}`,
      `how many new {object} (were there|did we get|did we add|came in|) {period}`,
    ],
    tools: ['record_aggregate'],
    example: () => 'How many tickets were raised in the last 30 days?',
    plan: (b) => {
      const object = slot(b, 'object', 'object');
      const period = slot(b, 'period', 'period');
      const dated = ACTIVITY.has(object.type) ? 'occurred_at' : 'created';
      return [{ tool: 'record_aggregate', args: countArgs(object.type, [], { date_property: dated, start: period.window.start, end: period.window.end }), why: `Count ${object.plural} ${dated === 'created' ? 'created' : 'logged'} ${period.window.label}.` }];
    },
    render: (steps, b, v) => {
      const object = slot(b, 'object', 'object');
      const period = slot(b, 'period', 'period');
      const verb = ACTIVITY.has(object.type) ? 'logged' : 'created';
      return renderAggregateCount(resultOf<RecordAggregateResult>(steps), thingOf(null, object), `${verb} ${periodPhrase(period.window.label)}`, v.workspace, { period: period.window.label });
    },
  }),
  T({
    id: 'list-created-period', kind: 'list', intent: 'lookup',
    description: 'The records created, logged or raised in a period.',
    patterns: [
      `(which|what) {object} (were|did we|have we|got) (created|added|logged|held|sent|raised|opened|booked|recorded|made) {period}`,
      `${LIST} (the|) {object} (created|added|logged|held|sent|raised|opened|booked|recorded|made) {period}`,
      `(which|what) new {object} (came in|were there|did we get|did we add) {period}`,
    ],
    tools: ['record_search'],
    example: () => 'Which tickets were raised in the last 30 days?',
    plan: (b) => {
      const object = slot(b, 'object', 'object');
      const period = slot(b, 'period', 'period');
      const dated = ACTIVITY.has(object.type) ? 'occurred_at' : 'created';
      return [{ tool: 'record_search', args: searchArgs(object.type, [], { date_property: dated, start: period.window.start, end: period.window.end }), why: `${object.plural} ${dated === 'created' ? 'created' : 'logged'} ${period.window.label}.` }];
    },
    render: (steps, b, v) => {
      const object = slot(b, 'object', 'object');
      const period = slot(b, 'period', 'period');
      const verb = ACTIVITY.has(object.type) ? 'logged' : 'created';
      return renderList(resultOf<RecordSearchResult>(steps), thingOf(null, object), `${verb} ${periodPhrase(period.window.label)}`, v.workspace, { period: period.window.label });
    },
  }),
  T({
    id: 'count-new-customers-period', kind: 'metric', intent: 'aggregate',
    description: 'How many accounts became customers in a period.',
    patterns: [
      `how many new customers (did we|have we) (add|win|sign|get|land|close) {period}`,
      `how many (customers|accounts) (became customers|did we convert|converted) {period}`,
      `how many new (customers|logos) (were there|came on|did we get|) {period}`,
    ],
    tools: ['business_metric'],
    example: (v) => `How many new customers did we add in ${samplesOf(v).year}?`,
    plan: (b) => {
      const period = slot(b, 'period', 'period');
      return [{ tool: 'business_metric', args: { metric: 'new_customers', ...windowArgs(period.window), compare: false }, why: `Accounts that became customers over ${period.window.label}.` }];
    },
    render: (steps, b, v) => {
      const period = slot(b, 'period', 'period');
      return renderCount(resultOf<MetricToolResult>(steps).count, 'new customer|new customers', periodPhrase(period.window.label), v.workspace, { period: period.window.label });
    },
  }),

  /* -------------------------------- drafts ------------------------------- */
  T({
    id: 'draft-message', kind: 'draft', intent: 'draft',
    description: 'A message written from the account’s own records, in a chosen tone.',
    patterns: [
      `(draft|write|compose|prepare) (me|us|) (a|an|) {kind:draft-kind} (to|for|about|on) {record}`,
      `(draft|write|compose|prepare) (me|us|) (a|an|) {tone} {kind:draft-kind} (to|for|about|on) {record}`,
      `(draft|write|compose|prepare) (a|an|) {kind:draft-kind} (to|for|about|on) {record} in a {tone} tone`,
    ],
    tools: ['compose_message'],
    example: (v) => need('Draft a check-in email to ', samplesOf(v).account),
    check: (b) => (['company', 'contact', 'customer'].includes(slot(b, 'record', 'record').type) ? null : 'A message is drafted to a company or a contact, not to a deal or a ticket.'),
    plan: (b) => {
      const record = slot(b, 'record', 'record');
      const kind = slot(b, 'kind', 'draft-kind');
      const tone = maybe(b, 'tone', 'tone');
      return [{
        tool: 'compose_message',
        args: {
          instruction: `Write a ${humanise(kind.value).toLowerCase()} for ${record.label}`,
          record_id: record.id,
          ...(record.type === 'contact' ? { contact_id: record.id } : {}),
          kind: kind.value,
          ...(tone ? { tone: tone.value } : {}),
        },
        why: `Compose a ${humanise(kind.value).toLowerCase()}${tone ? ` in a ${tone.value} tone` : ''} from ${record.label}'s records.`,
      }];
    },
    render: (steps) => renderDraft(resultOf<DraftResult>(steps)),
  }),

  /* -------------------------------- writes ------------------------------- */
  T({
    id: 'write-note', kind: 'write', intent: 'act',
    description: 'Write a note onto a record’s timeline. Prepared for approval; nothing lands until a person approves it.',
    patterns: [
      `(add|write|log|leave|put|create) a note (to|on|for|against) {record} (saying|that says|reading|which says) {text}`,
      `(add|write|log|leave|put|create) a note (to|on|for|against) {record}: {text}`,
      `note (on|for|to) {record} (saying|that says|reading) {text}`,
    ],
    tools: ['add_note'],
    example: (v) => need('Add a note to ', samplesOf(v).account, ' saying "The pilot slipped to October"'),
    plan: (b) => {
      const record = slot(b, 'record', 'record');
      const text = slot(b, 'text', 'text');
      const body = sentenceCase(text.text);
      return [{ tool: 'add_note', args: { record_ids: [record.id], subject: subjectOf(body), body }, why: `Write the note onto ${record.label}; the instruction wrapper is stripped so the timeline reads as a note.` }];
    },
    render: (steps, b) => renderWrite(steps, `note on ${slot(b, 'record', 'record').label}`, `"${String(steps[0]?.args.body ?? '')}"`),
  }),
  T({
    id: 'write-stage', kind: 'write', intent: 'act',
    description: 'Move a deal to another stage. Prepared for approval; nothing changes until a person approves it.',
    patterns: [
      `(move|advance|push|set|put) {deal} to (the|) {stage} (stage|)`,
      `(move|advance|push|set|put) {deal} (into|onto) (the|) {stage} (stage|)`,
      `(mark|set) {deal} as {stage}`,
    ],
    tools: ['update_record'],
    example: (v) => need('Move ', samplesOf(v).deal, ' to the ', samplesOf(v).stage, ' stage'),
    plan: (b) => {
      const deal = slot(b, 'deal', 'record');
      const stage = slot(b, 'stage', 'stage');
      return [{ tool: 'update_record', args: { object_type: 'deal', id: deal.id, properties: { deal_stage: stage.value } }, why: `Set ${deal.label} to the ${stage.label} stage.` }];
    },
    render: (steps, b) => renderWrite(steps, `${slot(b, 'deal', 'record').label} moved to ${slot(b, 'stage', 'stage').label}`, ''),
  }),
  T({
    id: 'write-followup', kind: 'write', intent: 'act',
    description: 'Schedule a follow-up on a record. Prepared for approval; the note lands when it comes due.',
    patterns: [
      `(schedule|set up|set|create|book) a follow up (on|for|with|about) {record} in {number} days (saying|to|that says|reading) {text}`,
      `remind me in {number} days (on|about|for) {record} (to|saying) {text}`,
      `follow up (on|with|about) {record} in {number} days (saying|to|that says|reading) {text}`,
    ],
    tools: ['schedule_followup'],
    example: (v) => need('Schedule a follow up on ', samplesOf(v).account, ' in 7 days saying "Chase the signed MSA"'),
    plan: (b) => {
      const record = slot(b, 'record', 'record');
      const days = slot(b, 'number', 'number').value;
      const text = slot(b, 'text', 'text');
      return [{ tool: 'schedule_followup', args: { record_id: record.id, in_days: Math.min(days, 365), note: sentenceCase(text.text) }, why: `Follow up on ${record.label} in ${days} days.` }];
    },
    render: (steps, b) => renderWrite(steps, `follow-up on ${slot(b, 'record', 'record').label} in ${slot(b, 'number', 'number').value} days`, `"${String(steps[0]?.args.note ?? '')}"`),
  }),
];

const ACTIVITY = new Set(['call', 'meeting', 'email', 'note', 'task']);

/** "the pilot slipped to october" → "The pilot slipped to October." */
function sentenceCase(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capitalised = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

function subjectOf(body: string): string {
  const first = body.split(/(?<=[.!?])\s+/)[0].replace(/[.!?]$/, '');
  const trimmed = first.replace(/^(the|a|an)\s+/i, '');
  const subject = trimmed[0] ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
  return subject.length > 80 ? `${subject.slice(0, 79).trimEnd()}…` : subject;
}

/** What a write step came to: done, waiting, or refused. */
function renderWrite(steps: StepOutcome[], what: string, detail: string): Rendered {
  const step = steps[0];
  const facts = { ...NO_FACTS, label: what };
  if (!step) return { content: `I changed nothing: no write was prepared.`, citations: [], facts };
  if (step.ok) return { content: `Done — ${what}${detail ? `: ${detail}` : ''}.`, citations: [], facts };
  const code = step.error?.code;
  if (code === 'approval_required') {
    return { content: `The ${what} needs your approval first. Nothing has been written.${detail ? ` It will read ${detail}.` : ''}`, citations: [], facts };
  }
  if (code === 'write_not_permitted') {
    return { content: `I changed nothing. This run is read-only — send \`allow_writes: true\` and I will prepare the ${what} for your approval.`, citations: [], facts };
  }
  return { content: `I changed nothing. The ${what} could not be prepared: ${step.error?.message ?? 'the tool failed'}.`, citations: [], facts };
}

/* ------------------------------- catalogue ------------------------------- */

/** The templates this run can answer: every tool the plan calls must be reachable. */
export function catalogueFor(v: Vocabulary): Template[] {
  return TEMPLATES.filter((t) => t.tools.every((tool) => v.tools.has(tool)));
}

export interface PublishedTemplate {
  id: string;
  kind: TemplateKind;
  intent: TemplateIntent;
  description: string;
  patterns: string[];
  example: string | null;
  slots: { name: string; kind: SlotKind }[];
  tools: string[];
  available: boolean;
}

/** Every shape, with an example rendered from this workspace's own values. */
export function publishTemplates(v: Vocabulary): PublishedTemplate[] {
  return TEMPLATES.map((t) => {
    const slots = new Map<string, SlotKind>();
    for (const pattern of t.patterns) for (const el of parsePattern(pattern)) if (el.kind === 'slot') slots.set(el.name, el.slot);
    return {
      id: t.id,
      kind: t.kind,
      intent: t.intent,
      description: t.description,
      patterns: t.patterns,
      example: t.example(v),
      slots: [...slots.entries()].map(([name, kind]) => ({ name, kind })),
      tools: t.tools,
      available: t.tools.every((tool) => v.tools.has(tool)),
    };
  });
}

export type { Bindings, Bound, Vocabulary, WorkspaceProfile };
