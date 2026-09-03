/**
 * Typed slots.
 *
 * A template is a question shape with holes in it, and every hole has a type:
 * {owner} binds only to a teammate, {period} only to a window the calendar can
 * resolve, {plan} only to a product in the catalogue. A word that does not bind
 * to its slot's type is not "close enough" — it is a non-match, and the
 * question is refused. There are no default slot values anywhere in this file:
 * a template that needs a period has {period} in it, and a question that names
 * none does not match that template.
 *
 * Everything a slot can bind to is read from the workspace — its pipelines, its
 * stages, its people, its products, its meters, its currency books, its records
 * — so the vocabulary is exactly what the database holds, no more.
 */
import type { Ctx } from '../kernel/context';
import { exponentOf, formatMoney } from '../../shared/money';
import { entityIndex, hasTable, workspaceProfile, type WorkspaceProfile } from './grounding';
import { crmVocabulary, currencyBooks, type QualifierKind, type QualifierVocabulary } from './qualifiers';
import { METRICS, stageSets, type MetricUnit, type StageSets, type GroupBy } from './metrics';
import { propertyMap, type Condition } from './query';
import { resolveWindowSpans, type TimeWindow } from './dates';
import { coreName, foldAccents, normalise } from './text';
import { DRAFT_KINDS, TONES, type DraftKind, type Tone } from './draft';

/* ------------------------------- tokens ---------------------------------- */

export interface Token {
  /** The normalised word: lowercase, accent-folded, punctuation stripped. */
  text: string;
  /** Where the word it came from sits in the raw question. */
  start: number;
  end: number;
}

const CONTRACTIONS: Record<string, string> = {
  "what's": 'what is', whats: 'what is', "who's": 'who is', "where's": 'where is', "how's": 'how is',
  "that's": 'that is', "there's": 'there is', "isn't": 'is not', "aren't": 'are not', "don't": 'do not',
  "doesn't": 'does not', "didn't": 'did not', "we've": 'we have', "we're": 'we are', "i'm": 'i am',
  "they're": 'they are', "can't": 'can not', "won't": 'will not', "haven't": 'have not', "hasn't": 'has not',
  "wasn't": 'was not', "weren't": 'were not', "i've": 'i have', "i'd": 'i would', "we'd": 'we would',
};

function pieces(word: string): string[] {
  let w = foldAccents(word.toLowerCase()).replace(/[’‘`´]/g, "'");
  w = w.replace(/^[^a-z0-9$€£]+|[^a-z0-9%]+$/g, '');
  if (!w) return [];
  const expanded = CONTRACTIONS[w];
  if (expanded) return expanded.split(' ');
  w = w.replace(/'s$/, '').replace(/'/g, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return [w];
  const money = w.match(/^([$€£])([0-9][0-9,]*(?:\.[0-9]+)?)(k|m|bn|b)?$/);
  if (money) return [`${money[1]}${money[2].replace(/,/g, '')}${money[3] ?? ''}`];
  const number = w.match(/^([0-9][0-9,]*(?:\.[0-9]+)?)(k|m|bn|b)?$/);
  if (number) return [`${number[1].replace(/,/g, '')}${number[2] ?? ''}`];
  return w.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

/** Every word of a question, normalised, with its place in the original text. */
export function tokenise(raw: string): Token[] {
  const out: Token[] = [];
  for (const match of raw.matchAll(/\S+/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    for (const text of pieces(match[0])) out.push({ text, start, end });
  }
  return out;
}

/**
 * Politeness is not part of a question's shape. Only these exact phrases are
 * stripped, at the ends, so nothing in the middle of a sentence is touched.
 */
const LEADING = [
  'can you please tell me', 'could you please tell me', 'can you tell me', 'could you tell me', 'please tell me',
  'can you please', 'could you please', 'would you please', 'i would like to know', 'i want to know', 'i need to know',
  'can you', 'could you', 'would you', 'will you', 'quick question', 'please', 'hey', 'hi', 'hello', 'ok', 'okay',
];
const TRAILING = ['thank you', 'thanks', 'please', 'for me', 'pls'];

export function stripPoliteness(tokens: Token[]): Token[] {
  let out = tokens;
  let changed = true;
  while (changed) {
    changed = false;
    for (const phrase of LEADING) {
      const words = phrase.split(' ');
      if (out.length > words.length && words.every((w, i) => out[i].text === w)) { out = out.slice(words.length); changed = true; break; }
    }
    for (const phrase of TRAILING) {
      const words = phrase.split(' ');
      const at = out.length - words.length;
      if (at > 0 && words.every((w, i) => out[at + i].text === w)) { out = out.slice(0, at); changed = true; break; }
    }
  }
  return out;
}

/* ------------------------------- values ---------------------------------- */

export type SlotValue =
  | { kind: 'object'; type: string; singular: string; plural: string }
  | { kind: 'state'; objectType: string; label: string; noun: string; conditions: Condition[] }
  | { kind: 'stage'; value: string; label: string; pipeline: string | null; conditions: Condition[] }
  | { kind: 'pipeline'; value: string; label: string }
  | { kind: 'metric'; id: string; label: string; unit: MetricUnit; snapshot: boolean; supportsSubject: boolean }
  | { kind: 'period'; window: TimeWindow }
  | { kind: 'currency'; code: string }
  | { kind: 'owner'; id: string; name: string }
  | { kind: 'plan'; id: string; name: string }
  | { kind: 'subscription-status'; value: string; label: string }
  | { kind: 'invoice-status'; value: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | 'open_like'; label: string; overdue: boolean }
  | { kind: 'money'; amount: number; currency: string; formatted: string }
  | { kind: 'comparator'; op: 'gt' | 'gte' | 'lt' | 'lte'; label: string }
  | { kind: 'number'; value: number }
  | { kind: 'record'; id: string; type: string; label: string }
  | { kind: 'meter'; id: string; name: string; event: string; unit: string | null; priceKey: string | null }
  | { kind: 'superlative'; direction: 'asc' | 'desc'; label: string }
  | { kind: 'dimension'; groupBy: GroupBy; label: string }
  | { kind: 'option'; objectType: string; property: string; propertyLabel: string; value: string; label: string }
  | { kind: 'property'; objectType: string; name: string; label: string; type: string }
  | { kind: 'draft-kind'; value: DraftKind; label: string }
  | { kind: 'tone'; value: Tone }
  | { kind: 'text'; text: string }
  | { kind: 'quantity'; value: number; formatted: string }
  | { kind: 'verb'; value: string; label: string };

export type SlotKind =
  | 'object' | 'activity-object' | 'state' | 'deal-state' | 'ticket-state' | 'stage' | 'pipeline'
  | 'snapshot-metric' | 'period-metric' | 'rank-metric' | 'ownable-metric' | 'ledger-snapshot-metric' | 'ledger-period-metric'
  | 'period' | 'currency' | 'owner' | 'plan' | 'subscription-status' | 'invoice-status'
  | 'money' | 'comparator' | 'number' | 'account' | 'contact' | 'deal' | 'record' | 'meter'
  | 'superlative' | 'most' | 'dimension' | 'industry' | 'lead-source' | 'competitor' | 'forecast-category' | 'region'
  | 'property' | 'numeric-property' | 'property-dim' | 'draft-kind' | 'tone' | 'text' | 'quantity' | 'book-verb';

export interface Bound {
  name: string;
  slot: SlotKind;
  /** The normalised words the slot consumed. */
  text: string;
  /** The same words as the reader wrote them. */
  raw: string;
  value: SlotValue;
  qualifier: QualifierKind | null;
}

export type Bindings = Record<string, Bound>;

/* ----------------------------- vocabulary -------------------------------- */

export interface Vocabulary {
  ctx: Ctx;
  orgId: string;
  workspace: WorkspaceProfile;
  stages: StageSets;
  crm: QualifierVocabulary;
  currencies: string[];
  /** Tool names this run may call; a template needing anything else is not offered. */
  tools: Set<string>;
  actorId: string | null;
  objects: { type: string; singular: string; plural: string }[];
  phrases: Map<SlotKind, Map<string, SlotValue[]>>;
  /** Longest phrase in each index, so the matcher knows how far to look. */
  longest: Map<SlotKind, number>;
  people: { id: string; name: string }[];
  plans: { id: string; name: string }[];
  meters: { id: string; name: string; event: string; unit: string | null; priceKey: string | null }[];
  records: { id: string; type: string; label: string }[];
}

const OPEN_TICKET_STATUSES = ['new', 'waiting_on_us', 'waiting_on_customer', 'escalated'];

const OBJECT_NOUNS: Record<string, string[]> = {
  company: ['companies', 'company', 'accounts', 'account', 'organisations', 'organizations'],
  contact: ['contacts', 'contact', 'people', 'person'],
  deal: ['deals', 'deal', 'opportunities', 'opportunity'],
  ticket: ['tickets', 'ticket', 'support tickets', 'support ticket', 'cases', 'case'],
  task: ['tasks', 'task', 'to dos', 'todos'],
  note: ['notes', 'note'],
  call: ['calls', 'call', 'phone calls'],
  meeting: ['meetings', 'meeting'],
  email: ['emails', 'email'],
};
const ACTIVITY_TYPES = new Set(['call', 'meeting', 'email', 'note', 'task']);

/**
 * The properties whose options read as a state of the object — "escalated
 * tickets", "prospect companies", "champion contacts". Listed in priority order
 * so a label two properties share binds the first one.
 */
const STATE_PROPERTIES: Record<string, string[]> = {
  ticket: ['status', 'priority'],
  company: ['type', 'lifecycle_stage', 'support_tier'],
  contact: ['buying_role', 'lead_status', 'lifecycle_stage', 'seniority', 'department'],
  task: ['status', 'priority', 'task_type'],
  call: ['direction', 'outcome'],
  meeting: ['outcome', 'meeting_type'],
  email: ['direction', 'status'],
};

/** How each metric is written by the people who ask for it. */
const METRIC_ALIASES: Record<string, string[]> = {
  revenue: ['revenue', 'collected revenue', 'cash collected', 'collections', 'paid revenue'],
  invoiced: ['invoiced', 'invoiced revenue', 'invoiced total', 'billings', 'amount invoiced'],
  outstanding: ['outstanding balance', 'outstanding', 'receivables', 'accounts receivable', 'ar balance', 'unpaid balance', 'outstanding invoices'],
  overdue: ['overdue balance', 'overdue', 'past due balance', 'arrears', 'overdue invoices', 'past due invoices'],
  pipeline: ['open pipeline', 'pipeline', 'pipeline value', 'open pipeline value', 'open deal value', 'total pipeline'],
  weighted_pipeline: ['weighted pipeline', 'weighted pipeline value', 'forecast', 'pipeline forecast', 'weighted forecast'],
  closed_won: ['closed won bookings', 'closed won', 'bookings', 'closed won revenue', 'won bookings', 'new bookings', 'closed won value'],
  closed_lost: ['closed lost value', 'closed lost', 'lost value', 'lost deal value', 'closed lost bookings'],
  win_rate: ['win rate', 'close rate', 'conversion rate', 'deal win rate'],
  avg_deal_size: ['average deal size', 'avg deal size', 'mean deal size', 'average contract value', 'acv', 'average deal value'],
  sales_cycle: ['average sales cycle', 'sales cycle', 'sales cycle length', 'time to close', 'days to close', 'average time to close'],
  deal_count: ['deal count', 'open deal count', 'number of open deals'],
  new_customers: ['new customers', 'new logos', 'customers added', 'new accounts'],
  customers: ['customer count', 'number of customers', 'total customers'],
  open_tickets: ['open tickets', 'open ticket count', 'support backlog', 'ticket backlog', 'number of open tickets'],
  tickets_created: ['tickets raised', 'tickets created', 'tickets opened', 'new tickets', 'tickets logged'],
  resolution_time: ['average time to resolution', 'resolution time', 'average resolution time', 'time to resolution', 'mean time to resolution', 'ticket resolution time'],
  csat: ['customer satisfaction', 'csat', 'csat score', 'satisfaction score', 'customer satisfaction score'],
  activities: ['logged activity', 'activity count', 'logged activities', 'activity volume'],
  meetings: ['meetings held', 'meeting count', 'number of meetings'],
  connected_assets: ['connected assets', 'connected asset count', 'asset count', 'total connected assets'],
  churn: ['logo churn', 'churn', 'churn rate', 'customer churn', 'logo churn rate'],
  net_revenue_retention: ['net revenue retention', 'nrr', 'net retention', 'net dollar retention', 'ndr'],
  gross_revenue_retention: ['gross revenue retention', 'grr', 'gross retention'],
  mrr: ['mrr', 'monthly recurring revenue', 'monthly run rate', 'recurring revenue'],
  arr: ['arr', 'annual recurring revenue', 'annualised recurring revenue', 'annualized recurring revenue', 'annual run rate'],
};
const RANKABLE = new Set(['spend', 'revenue', 'invoiced', 'closed_won', 'pipeline', 'open_tickets', 'mrr', 'arr']);
const OWNABLE = new Set(['pipeline', 'weighted_pipeline', 'deal_count']);
const LEDGER = new Set(['revenue', 'invoiced', 'outstanding', 'overdue', 'mrr', 'arr']);
const SPEND_ALIASES = ['spend', 'customer spend', 'spending'];

const DIMENSIONS: [GroupBy, string, string[]][] = [
  ['owner', 'owner', ['owner', 'owners', 'rep', 'reps', 'sales rep', 'salesperson', 'account executive', 'teammate', 'person', 'seller']],
  ['stage', 'stage', ['stage', 'stages', 'deal stage']],
  ['pipeline', 'pipeline', ['pipeline', 'pipelines']],
  ['industry', 'industry', ['industry', 'industries', 'sector', 'vertical']],
  ['account', 'account', ['account', 'accounts', 'customer', 'customers', 'company', 'companies']],
  ['status', 'status', ['status', 'statuses']],
  ['priority', 'priority', ['priority', 'priorities']],
  ['source', 'source', ['source', 'sources', 'lead source', 'lead sources', 'origin']],
];

const SUBSCRIPTION_STATUSES: [string, string, string[]][] = [
  ['active', 'active', ['active', 'live']],
  ['trialing', 'trialing', ['trialing', 'on trial', 'in trial', 'trialling']],
  ['past_due', 'past due', ['past due', 'overdue', 'behind on payment', 'in arrears']],
  ['paused', 'paused', ['paused', 'on pause']],
  ['canceled', 'canceled', ['canceled', 'cancelled']],
  ['unpaid', 'unpaid', ['unpaid']],
  ['incomplete', 'incomplete', ['incomplete']],
];

const INVOICE_STATUSES: [SlotValue & { kind: 'invoice-status' }, string[]][] = [
  [{ kind: 'invoice-status', value: 'paid', label: 'paid', overdue: false }, ['paid', 'settled']],
  [{ kind: 'invoice-status', value: 'open', label: 'open', overdue: false }, ['open', 'unpaid', 'outstanding', 'awaiting payment']],
  [{ kind: 'invoice-status', value: 'open_like', label: 'overdue', overdue: true }, ['overdue', 'past due', 'late']],
  [{ kind: 'invoice-status', value: 'void', label: 'void', overdue: false }, ['void', 'voided']],
  [{ kind: 'invoice-status', value: 'draft', label: 'draft', overdue: false }, ['draft']],
  [{ kind: 'invoice-status', value: 'uncollectible', label: 'uncollectible', overdue: false }, ['uncollectible', 'written off']],
];

const COMPARATORS: [SlotValue & { kind: 'comparator' }, string[]][] = [
  [{ kind: 'comparator', op: 'gt', label: 'more than' }, ['more than', 'over', 'above', 'greater than', 'higher than', 'bigger than', 'larger than', 'exceeding']],
  [{ kind: 'comparator', op: 'gte', label: 'at least' }, ['at least', 'no less than']],
  [{ kind: 'comparator', op: 'lt', label: 'less than' }, ['less than', 'under', 'below', 'smaller than', 'lower than']],
  [{ kind: 'comparator', op: 'lte', label: 'at most' }, ['at most', 'up to', 'no more than']],
];

const SUPERLATIVES: [SlotValue & { kind: 'superlative' }, string[]][] = [
  [{ kind: 'superlative', direction: 'desc', label: 'biggest' }, ['biggest', 'largest', 'top', 'highest', 'best', 'greatest']],
  [{ kind: 'superlative', direction: 'asc', label: 'smallest' }, ['smallest', 'lowest', 'least valuable', 'tiniest']],
];
const MOST: [SlotValue & { kind: 'superlative' }, string[]][] = [
  [{ kind: 'superlative', direction: 'desc', label: 'most' }, ['most', 'largest', 'biggest', 'highest']],
  [{ kind: 'superlative', direction: 'asc', label: 'least' }, ['least', 'fewest', 'smallest', 'lowest']],
];

const BOOK_VERBS: [string, string, string[]][] = [
  ['closed_won', 'booked', ['book', 'booked', 'win', 'won', 'close won', 'close']],
  ['closed_lost', 'lost', ['lose', 'lost']],
  ['invoiced', 'invoiced', ['invoice', 'invoiced', 'bill', 'billed']],
  ['revenue', 'collected', ['collect', 'collected', 'receive', 'received', 'get paid', 'got paid', 'take in', 'bring in']],
];

const DRAFT_ALIASES: Record<DraftKind, string[]> = {
  follow_up: ['follow up', 'follow up email', 'follow up note', 'follow up message'],
  intro: ['intro', 'intro email', 'introduction', 'introduction email', 'cold email', 'first touch email'],
  check_in: ['check in', 'check in email', 'check in note', 'check in message', 'touch base email'],
  renewal: ['renewal', 'renewal email', 'renewal note', 'renewal reminder', 'renewal message'],
  dunning: ['dunning', 'dunning notice', 'dunning email', 'payment reminder', 'overdue invoice reminder', 'collections email'],
  meeting_recap: ['meeting recap', 'meeting recap email', 'recap email', 'recap of the meeting'],
  call_summary: ['call summary', 'summary of the call', 'call recap'],
  meeting_notes: ['meeting notes', 'notes from the meeting'],
  deal_summary: ['deal summary', 'deal review', 'summary of the deal'],
  handover: ['handover', 'handover note', 'hand over note', 'account handover'],
  escalation_update: ['escalation update', 'incident update', 'status update on the ticket'],
  win_back: ['win back email', 'win back', 'winback email', 're engagement email'],
};

const TIER = /^(k|m|b|bn)$/;
const MAGNITUDE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

/* ------------------------------ building --------------------------------- */

const cache = new WeakMap<object, Map<string, { stamp: string; vocab: Vocabulary }>>();

function humanLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

/** Every spelling a picklist label answers to: as written, pluralised, and the stored value. */
function optionSpellings(label: string, value: string): string[] {
  const base = normalise(label);
  const out = new Set<string>([base, normalise(humanLabel(value))]);
  if (!base.endsWith('s')) out.add(`${base}s`);
  else out.add(base.replace(/s$/, ''));
  return [...out].filter(Boolean);
}

/**
 * Build (or reuse) everything a slot can bind to in this workspace. The tool
 * set is per call, so it is applied by the caller rather than cached.
 */
export function vocabulary(ctx: Ctx, orgId: string, opts: { tools: string[]; actorId: string | null }): Vocabulary {
  const index = entityIndex(ctx, orgId);
  const crm = crmVocabulary(ctx, orgId);
  const stamp = `${index.stamp}:${crm.stages.length}:${crm.pipelines.length}`;
  let byOrg = cache.get(ctx.db);
  if (!byOrg) { byOrg = new Map(); cache.set(ctx.db, byOrg); }
  const cached = byOrg.get(orgId);
  const base = cached && cached.stamp === stamp ? cached.vocab : build(ctx, orgId, index.entities, crm, stamp, byOrg);
  return { ...base, ctx, tools: new Set(opts.tools), actorId: opts.actorId };
}

function build(
  ctx: Ctx, orgId: string,
  entities: { id: string; type: string; label: string; aliases: string[] }[],
  crm: QualifierVocabulary, stamp: string,
  byOrg: Map<string, { stamp: string; vocab: Vocabulary }>,
): Vocabulary {
  const workspace = workspaceProfile(ctx, orgId);
  const stages = stageSets(ctx, orgId);
  const phrases = new Map<SlotKind, Map<string, SlotValue[]>>();
  const add = (kind: SlotKind, key: string, value: SlotValue) => {
    const k = normalise(key);
    if (!k) return;
    let map = phrases.get(kind);
    if (!map) { map = new Map(); phrases.set(kind, map); }
    const held = map.get(k);
    if (held) { if (!held.some((v) => JSON.stringify(v) === JSON.stringify(value))) held.push(value); }
    else map.set(k, [value]);
  };

  /* objects and their states */
  const objects: Vocabulary['objects'] = [];
  const objectTypes = hasTable(ctx.db, 'crm_object_types')
    ? ctx.db.all<{ name: string }>(`SELECT name FROM crm_object_types WHERE org_id = ? ORDER BY position`, orgId).map((r) => r.name)
    : Object.keys(OBJECT_NOUNS);
  for (const type of objectTypes) {
    const nouns = OBJECT_NOUNS[type] ?? [`${type}s`, type];
    const object: SlotValue = { kind: 'object', type, singular: nouns[1] ?? type, plural: nouns[0] };
    objects.push({ type, singular: object.singular, plural: object.plural });
    for (const spelling of nouns) {
      add('object', spelling, object);
      if (ACTIVITY_TYPES.has(type)) add('activity-object', spelling, object);
    }

    const properties = propertyMap(ctx, orgId, type);
    const seen = new Set<string>();
    const state = (label: string, noun: string, conditions: Condition[], spellings: string[]) => {
      const value: SlotValue = { kind: 'state', objectType: type, label, noun, conditions };
      for (const spelling of spellings) {
        const key = normalise(spelling);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        add('state', key, value);
        if (type === 'deal') add('deal-state', key, value);
        if (type === 'ticket') add('ticket-state', key, value);
      }
    };
    if (type === 'deal') {
      state('open', 'open', [{ property: 'deal_stage', op: 'in', values: stages.open }], ['open', 'active', 'in flight', 'in progress', 'live', 'unclosed']);
      state('closed-won', 'closed-won', [{ property: 'deal_stage', op: 'in', values: stages.won }], ['won', 'closed won', 'closed and won', 'successful']);
      state('closed-lost', 'closed-lost', [{ property: 'deal_stage', op: 'in', values: stages.lost }], ['lost', 'closed lost']);
      state('closed', 'closed', [{ property: 'deal_stage', op: 'in', values: [...stages.won, ...stages.lost] }], ['closed', 'decided']);
    }
    if (type === 'ticket') {
      state('open', 'open', [{ property: 'status', op: 'in', values: OPEN_TICKET_STATUSES }], ['open', 'unresolved', 'active', 'outstanding']);
      state('closed', 'closed', [{ property: 'status', op: 'eq', value: 'closed' }], ['resolved', 'closed', 'done']);
    }
    if (type === 'task') {
      state('open', 'open', [{ property: 'status', op: 'in', values: ['not_started', 'in_progress', 'waiting', 'deferred'] }], ['open', 'outstanding', 'pending', 'incomplete']);
      state('completed', 'completed', [{ property: 'status', op: 'eq', value: 'completed' }], ['done', 'finished', 'complete']);
    }
    for (const property of STATE_PROPERTIES[type] ?? []) {
      const definition = properties.get(property);
      if (!definition) continue;
      for (const option of definition.options) {
        const spellings = optionSpellings(option.label, option.value);
        if (property === 'priority') spellings.push(`${normalise(option.label)} priority`);
        state(option.label, option.label.toLowerCase(), [{ property, op: 'eq', value: option.value }], spellings);
      }
    }

    /* enumerated options of named dimensions, each from the object it narrows */
    const dimensionKinds: [SlotKind, string, string][] = [
      ['industry', 'industry', 'company'], ['lead-source', 'lead_source', 'deal'], ['competitor', 'competitor', 'deal'],
      ['forecast-category', 'forecast_category', 'deal'], ['region', 'region', 'company'],
    ];
    for (const [kind, property, owner] of dimensionKinds) {
      const definition = properties.get(property);
      if (!definition || owner !== type) continue;
      for (const option of definition.options) {
        if (property === 'competitor' && option.value === 'none') continue;
        const value: SlotValue = { kind: 'option', objectType: type, property, propertyLabel: definition.label, value: option.value, label: option.label };
        for (const spelling of optionSpellings(option.label, option.value)) add(kind, spelling, value);
      }
    }

    /* properties by name, for "have no {property}" and "by {property-dim}" */
    for (const [name, definition] of properties) {
      if (definition.type === 'computed') continue;
      const value: SlotValue = { kind: 'property', objectType: type, name, label: definition.label, type: definition.type };
      const spellings = new Set([normalise(definition.label), normalise(definition.label.replace(/\s*\(.*?\)\s*/g, ' ')), normalise(humanLabel(name))]);
      for (const spelling of spellings) {
        add('property', spelling, value);
        if (['number', 'currency'].includes(definition.type)) add('numeric-property', spelling, value);
        if (['enum', 'multi_enum', 'bool'].includes(definition.type)) add('property-dim', spelling, value);
      }
    }
    add('property-dim', 'owner', { kind: 'property', objectType: type, name: 'owner_id', label: 'Owner', type: 'owner' });
    add('property-dim', 'rep', { kind: 'property', objectType: type, name: 'owner_id', label: 'Owner', type: 'owner' });
  }

  /* stages and pipelines */
  for (const pipeline of crm.pipelines) {
    const value: SlotValue = { kind: 'pipeline', value: pipeline.value, label: pipeline.label };
    add('pipeline', pipeline.label, value);
    add('pipeline', humanLabel(pipeline.value), value);
  }
  for (const stage of crm.stages) {
    for (const alias of stage.aliases) {
      const general = normalise(alias.label) === normalise(stage.label);
      const scoped = !general && alias.pipelines.length === 1 ? alias.pipelines[0] : null;
      const conditions: Condition[] = [{ property: 'deal_stage', op: 'eq', value: stage.value }];
      if (scoped) conditions.push({ property: 'pipeline', op: 'eq', value: scoped });
      add('stage', alias.label, { kind: 'stage', value: stage.value, label: alias.label, pipeline: scoped, conditions });
    }
    add('stage', humanLabel(stage.value), { kind: 'stage', value: stage.value, label: stage.label, pipeline: null, conditions: [{ property: 'deal_stage', op: 'eq', value: stage.value }] });
  }

  /* metrics */
  for (const def of METRICS) {
    const value: SlotValue = { kind: 'metric', id: def.id, label: def.label, unit: def.unit, snapshot: !!def.snapshot, supportsSubject: def.supportsSubject };
    const aliases = def.id === 'spend' ? SPEND_ALIASES : [def.label, ...(METRIC_ALIASES[def.id] ?? [])];
    for (const alias of aliases) {
      // The open-deal count is labelled "Deals", and as a bare measure word
      // that turned "how many deals have we got" — every deal — into the 38
      // open ones. Its own aliases still say "open"; the label does not.
      const bareDeals = def.id === 'deal_count' && alias === def.label;
      if (def.id !== 'spend' && !bareDeals) add(def.snapshot ? 'snapshot-metric' : 'period-metric', alias, value);
      if (RANKABLE.has(def.id)) add('rank-metric', alias, value);
      if (OWNABLE.has(def.id)) add('ownable-metric', alias, value);
      if (LEDGER.has(def.id)) add(def.snapshot ? 'ledger-snapshot-metric' : 'ledger-period-metric', alias, value);
    }
  }

  /* people */
  const people = workspace.people.map((p) => ({ id: p.id, name: p.name }));
  const firstNames = new Map<string, number>();
  for (const person of workspace.people) {
    const first = normalise(person.name.split(/\s+/)[0]);
    firstNames.set(first, (firstNames.get(first) ?? 0) + 1);
  }
  for (const person of workspace.people) {
    const value: SlotValue = { kind: 'owner', id: person.id, name: person.name };
    add('owner', person.name, value);
    const first = normalise(person.name.split(/\s+/)[0]);
    if (firstNames.get(first) === 1) add('owner', first, value);
    add('owner', person.email.split('@')[0], value);
  }

  /* currencies */
  const currencies = currencyBooks(ctx, orgId);
  const CURRENCY_WORDS: Record<string, string[]> = {
    usd: ['usd', 'dollars', 'us dollars', 'us dollar'], eur: ['eur', 'euros', 'euro'], gbp: ['gbp', 'pounds', 'sterling', 'pounds sterling'],
    jpy: ['jpy', 'yen'], chf: ['chf', 'swiss francs'], cad: ['cad', 'canadian dollars'], aud: ['aud', 'australian dollars'],
  };
  for (const code of currencies) {
    for (const word of CURRENCY_WORDS[code] ?? [code]) add('currency', word, { kind: 'currency', code });
  }

  /* products, as plans */
  const plans: Vocabulary['plans'] = [];
  const products = entities.filter((e) => e.type === 'product');
  const productTokens = products.map((p) => normalise(p.label).split(' '));
  products.forEach((product, i) => {
    plans.push({ id: product.id, name: product.label });
    const value: SlotValue = { kind: 'plan', id: product.id, name: product.label };
    add('plan', product.label, value);
    // "Growth" is what people call "Telemetry Cloud Growth": the words after
    // the prefix it shares with its siblings, when those words name it alone.
    let shared = 0;
    productTokens.forEach((other, j) => {
      if (i === j) return;
      let l = 0;
      while (l < other.length && l < productTokens[i].length && other[l] === productTokens[i][l]) l++;
      shared = Math.max(shared, l);
    });
    if (shared > 0 && shared < productTokens[i].length) {
      const tail = productTokens[i].slice(shared);
      const unique = productTokens.filter((t) => t.slice(-tail.length).join(' ') === tail.join(' ')).length === 1;
      if (unique) add('plan', tail.join(' '), value);
    }
  });

  /* meters */
  const meters: Vocabulary['meters'] = [];
  if (hasTable(ctx.db, 'meters')) {
    for (const row of ctx.db.all<{ id: string; name: string; event_name: string; unit_label: string | null; metadata: string | null }>(
      `SELECT id, name, event_name, unit_label, metadata FROM meters WHERE org_id = ?`, orgId)) {
      let priceKey: string | null = null;
      try {
        const meta = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>;
        const key = meta.price_lookup_key ?? meta.price;
        priceKey = typeof key === 'string' && key.trim() ? key.trim() : null;
      } catch { priceKey = null; }
      const value: SlotValue = { kind: 'meter', id: row.id, name: row.name, event: row.event_name, unit: row.unit_label, priceKey };
      meters.push({ id: row.id, name: row.name, event: row.event_name, unit: row.unit_label, priceKey });
      const name = normalise(row.name);
      for (const spelling of [name, normalise(row.event_name), name.endsWith('s') ? name.replace(/s$/, '') : `${name}s`]) add('meter', spelling, value);
    }
  }

  /* subscription and invoice statuses, and the fixed lexicons */
  for (const [value, label, spellings] of SUBSCRIPTION_STATUSES) {
    for (const spelling of spellings) add('subscription-status', spelling, { kind: 'subscription-status', value, label });
  }
  for (const [value, spellings] of INVOICE_STATUSES) for (const spelling of spellings) add('invoice-status', spelling, value);
  for (const [value, spellings] of COMPARATORS) for (const spelling of spellings) add('comparator', spelling, value);
  for (const [value, spellings] of SUPERLATIVES) for (const spelling of spellings) add('superlative', spelling, value);
  for (const [value, spellings] of MOST) for (const spelling of spellings) add('most', spelling, value);
  for (const [groupBy, label, spellings] of DIMENSIONS) for (const spelling of spellings) add('dimension', spelling, { kind: 'dimension', groupBy, label });
  for (const [metric, label, spellings] of BOOK_VERBS) for (const spelling of spellings) add('book-verb', spelling, { kind: 'verb', value: metric, label });
  for (const kind of DRAFT_KINDS) {
    for (const spelling of DRAFT_ALIASES[kind]) add('draft-kind', spelling, { kind: 'draft-kind', value: kind, label: humanLabel(kind) });
  }
  for (const tone of TONES) add('tone', tone, { kind: 'tone', value: tone });

  /* records, by their exact names */
  const records: Vocabulary['records'] = [];
  const recordKinds: [SlotKind, string[]][] = [
    ['account', ['company', 'customer']], ['contact', ['contact']], ['deal', ['deal']],
    ['record', ['company', 'contact', 'deal', 'ticket']],
  ];
  for (const entity of entities) {
    if (!['company', 'customer', 'contact', 'deal', 'ticket'].includes(entity.type)) continue;
    records.push({ id: entity.id, type: entity.type, label: entity.label });
    const value: SlotValue = { kind: 'record', id: entity.id, type: entity.type, label: entity.label };
    const spellings = new Set<string>([normalise(entity.label)]);
    if (entity.type === 'company' || entity.type === 'customer') {
      const core = coreName(entity.label);
      if (core) spellings.add(core);
      for (const alias of entity.aliases) if (!/[@.]/.test(alias)) spellings.add(normalise(alias));
    }
    if (entity.type === 'contact') for (const alias of entity.aliases) if (!/[@.]/.test(alias)) spellings.add(normalise(alias));
    for (const [kind, types] of recordKinds) {
      if (!types.includes(entity.type)) continue;
      for (const spelling of spellings) add(kind, spelling, value);
    }
  }

  const longest = new Map<SlotKind, number>();
  for (const [kind, map] of phrases) {
    let max = 1;
    for (const key of map.keys()) max = Math.max(max, key.split(' ').length);
    longest.set(kind, max);
  }

  const vocab: Vocabulary = {
    ctx, orgId, workspace, stages, crm, currencies, tools: new Set(), actorId: null,
    objects, phrases, longest, people, plans, meters, records,
  };
  byOrg.set(orgId, { stamp, vocab });
  return vocab;
}

/* ------------------------------- binding --------------------------------- */

const QUALIFIER_OF: Partial<Record<SlotKind, QualifierKind>> = {
  pipeline: 'pipeline', stage: 'stage', owner: 'owner', account: 'account', period: 'period',
  state: 'status', 'deal-state': 'status', 'ticket-state': 'status', 'subscription-status': 'status', 'invoice-status': 'status',
  'snapshot-metric': 'metric', 'period-metric': 'metric', 'rank-metric': 'metric', 'ownable-metric': 'metric',
  'ledger-snapshot-metric': 'metric', 'ledger-period-metric': 'metric', meter: 'meter', currency: 'currency', number: 'limit',
};

/** How many words a slot may swallow, so the search stays small. */
export function slotSpan(kind: SlotKind, vocab: Vocabulary): { min: number; max: number } {
  switch (kind) {
    case 'text': return { min: 1, max: 400 };
    case 'period': return { min: 1, max: 7 };
    case 'money': return { min: 1, max: 3 };
    case 'quantity': return { min: 1, max: 2 };
    case 'number': return { min: 1, max: 1 };
    default: return { min: 1, max: vocab.longest.get(kind) ?? 1 };
  }
}

const PERIOD_LEAD = /^(?:in|during|for|over|within|across|of|throughout)\s+/i;
const EDGE_PUNCTUATION = /^[\s"'“”‘’(\[]+|[\s?!.,;:"'“”‘’)\]]+$/g;

function bindPeriod(text: string, now: number): SlotValue[] {
  const trimmed = text.replace(EDGE_PUNCTUATION, '');
  // A bare year is a period on its own: "compare 2025 with 2024".
  const raw = /^(?:19|20)\d{2}$/.test(trimmed) ? `in ${trimmed}` : trimmed;
  const attempt = (text: string): SlotValue | null => {
    const spans = resolveWindowSpans(text, now, 2);
    if (spans.length !== 1) return null;
    const span = spans[0];
    const before = text.slice(0, span.at).trim();
    const after = text.slice(span.to).trim();
    if (after) return null;
    // A comparator in front of the phrase is part of the period ("before
    // March 2026"); anything else in front of it is not.
    if (before && !/^(?:before|after|since|through|until|till|up to|prior to|earlier than|later than|no later than|on or before|on or after|ahead of)$/i.test(before)) return null;
    return { kind: 'period', window: span.window };
  };
  const whole = attempt(raw);
  if (whole) return [whole];
  const stripped = raw.replace(PERIOD_LEAD, '');
  if (stripped !== raw) {
    const inner = attempt(stripped);
    if (inner) return [inner];
  }
  return [];
}

function bindMoney(tokens: Token[], start: number, len: number, vocab: Vocabulary): SlotValue[] {
  const first = tokens[start].text;
  const symbolOf: Record<string, string> = { $: 'usd', '€': 'eur', '£': 'gbp' };
  const match = first.match(/^([$€£])?(\d+(?:\.\d+)?)(k|m|b|bn)?$/);
  if (!match) return [];
  let currency = match[1] ? symbolOf[match[1]] : null;
  let consumed = 1;
  let scale = match[3] ? MAGNITUDE[match[3]] : 1;
  if (len >= 2) {
    const second = tokens[start + 1].text;
    if (!match[3] && MAGNITUDE[second]) { scale = MAGNITUDE[second]; consumed = 2; }
    else if (!currency && ['dollars', 'usd', 'euros', 'eur', 'pounds', 'gbp'].includes(second)) {
      currency = second.startsWith('d') || second === 'usd' ? 'usd' : second.startsWith('e') ? 'eur' : 'gbp';
      consumed = 2;
    } else return [];
  }
  if (len === 3) {
    const third = tokens[start + 2].text;
    if (consumed === 2 && !currency && ['dollars', 'usd', 'euros', 'eur', 'pounds', 'gbp'].includes(third)) {
      currency = third.startsWith('d') || third === 'usd' ? 'usd' : third.startsWith('e') ? 'eur' : 'gbp';
      consumed = 3;
    } else return [];
  }
  if (consumed !== len) return [];
  const code = currency ?? vocab.workspace.currency;
  const major = Number(match[2]) * scale;
  if (!Number.isFinite(major) || major <= 0) return [];
  const amount = Math.round(major * 10 ** exponentOf(code));
  return [{ kind: 'money', amount, currency: code, formatted: formatMoney({ amount, currency: code }, { locale: vocab.workspace.locale, trimZeroFraction: true }) }];
}

function bindQuantity(tokens: Token[], start: number, len: number): SlotValue[] {
  const first = tokens[start].text.match(/^(\d+(?:\.\d+)?)(k|m|b|bn)?$/);
  if (!first) return [];
  let scale = first[2] ? MAGNITUDE[first[2]] : 1;
  if (len === 2) {
    const word = tokens[start + 1].text;
    if (first[2] || !MAGNITUDE[word] || TIER.test(word)) return [];
    scale = MAGNITUDE[word];
  }
  const value = Math.round(Number(first[1]) * scale);
  if (!Number.isFinite(value) || value <= 0) return [];
  return [{ kind: 'quantity', value, formatted: value.toLocaleString('en-US') }];
}

function bindNumber(tokens: Token[], start: number): SlotValue[] {
  const match = tokens[start].text.match(/^\d+$/);
  if (!match) return [];
  const value = Number(match[0]);
  return value > 0 && value < 100_000 ? [{ kind: 'number', value }] : [];
}

/** Candidates for one slot over exactly `len` words at `start`. */
export function bind(kind: SlotKind, tokens: Token[], start: number, len: number, raw: string, vocab: Vocabulary): SlotValue[] {
  if (start + len > tokens.length || len < 1) return [];
  switch (kind) {
    case 'period': return bindPeriod(raw.slice(tokens[start].start, tokens[start + len - 1].end), vocab.workspace.now);
    case 'money': return bindMoney(tokens, start, len, vocab);
    case 'quantity': return bindQuantity(tokens, start, len);
    case 'number': return len === 1 ? bindNumber(tokens, start) : [];
    case 'text': return [{ kind: 'text', text: unquote(raw.slice(tokens[start].start, tokens[start + len - 1].end)) }];
    default: break;
  }
  const key = tokens.slice(start, start + len).map((t) => t.text).join(' ');
  let found = vocab.phrases.get(kind)?.get(key) ?? [];
  if (kind === 'owner' && !found.length && len === 1 && ['me', 'i', 'my', 'myself', 'mine'].includes(key)) {
    const actor = vocab.people.find((p) => p.id === vocab.actorId);
    found = actor ? [{ kind: 'owner', id: actor.id, name: actor.name }] : [];
  }
  if (kind === 'account' || kind === 'record' || kind === 'contact' || kind === 'deal') {
    // A company and its billing customer share a name; the CRM record is the
    // one questions are about. Two different companies with one name is an
    // ambiguity nothing here may resolve for the reader.
    const companies = found.filter((v) => v.kind === 'record' && v.type === 'company');
    const chosen = companies.length ? companies : found;
    return chosen.length === 1 ? chosen : [];
  }
  // "Open" is a state of a deal, a ticket and a task, and "email" is a property
  // of a contact and of an email. Every reading is offered and the sentence's
  // object settles which one holds.
  if (kind === 'state' || kind === 'property' || kind === 'numeric-property' || kind === 'property-dim') return found;
  return found.length === 1 ? found : [];
}

const unquote = (text: string): string =>
  text.trim().replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').replace(/[.]+$/, (m) => (m.length > 1 ? '' : m)).trim();

export function bound(name: string, slot: SlotKind, tokens: Token[], start: number, len: number, raw: string, value: SlotValue): Bound {
  return {
    name,
    slot,
    text: tokens.slice(start, start + len).map((t) => t.text).join(' '),
    raw: raw.slice(tokens[start].start, tokens[start + len - 1].end),
    value,
    qualifier: QUALIFIER_OF[slot] ?? null,
  };
}

/** Whether any words of the question bind this slot kind at all — for ranking the nearest templates. */
export function bindsAnywhere(kind: SlotKind, tokens: Token[], raw: string, vocab: Vocabulary): boolean {
  if (kind === 'text') return false;
  const span = slotSpan(kind, vocab);
  for (let start = 0; start < tokens.length; start++) {
    for (let len = Math.min(span.max, tokens.length - start); len >= span.min; len--) {
      if (bind(kind, tokens, start, len, raw, vocab).length) return true;
    }
  }
  return false;
}
