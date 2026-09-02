/**
 * Tool planning.
 *
 * The engine has a canonical plan for each kind of task — the sequence a good
 * analyst would run — and a generic matcher that scores any other registered
 * tool against the question and tries to fill its arguments from what has
 * already been resolved. A tool whose required arguments cannot be filled is
 * never planned, so the runtime is never asked to run something that cannot
 * work.
 */
import type { AiToolDef } from '../kernel/ai';
import type { SchemaNode } from '../../shared/validate';
import type { TaskIntent } from './intent';
import type { ResolvedEntity } from './resolve';
import type { GroupBy, MetricDetection, MetricSubject, StageSets } from './metrics';
import { detectCurrency, isValueQuestion, metricById } from './metrics';
import type { TimeWindow } from './dates';
import { resolveDueDate } from './dates';
import { DAY } from '../../shared/time';
import type { WorkspaceProfile } from './grounding';
import { isLedgerType } from './resolve';
import { capitalise, contentWords, normalise, stem, trigramSimilarity, truncate } from './text';

export type BuiltinTool =
  | 'workspace_search' | 'account_profile' | 'business_metric'
  | 'record_search' | 'record_aggregate' | 'record_timeline';

export const BUILTIN_TOOLS: BuiltinTool[] = [
  'workspace_search', 'account_profile', 'business_metric', 'record_search', 'record_aggregate', 'record_timeline',
];

export interface PlannedStep {
  tool: string;
  args: Record<string, unknown>;
  why: string;
  builtin: BuiltinTool | null;
  relevance: number;
}

/** The two periods a comparison is actually about, both named in the answer. */
export interface WindowPair {
  a: TimeWindow;
  b: TimeWindow;
  /** How the second window was chosen — for the trace and the answer. */
  source: 'both_named' | 'year_over_year' | 'preceding_period';
}

export interface PlanInput {
  question: string;
  /** Which deal stages count as open, won and lost in this workspace. */
  stages: StageSets;
  /** True when the question actually names something — an id, email, domain or proper noun. */
  namedSomething: boolean;
  intent: TaskIntent;
  window: TimeWindow;
  /** Every period the question named, in the order it named them. */
  windows: TimeWindow[];
  /** Set for a comparison: exactly the two periods that will be measured. */
  comparison: WindowPair | null;
  entities: ResolvedEntity[];
  subject: MetricSubject | null;
  metric: MetricDetection | null;
  groupBy: GroupBy;
  types: string[];
  tools: AiToolDef[];
  workspace: WorkspaceProfile;
  maxSteps: number;
  /** Tool names this run is scoped to; `null` means the whole catalogue. */
  allowedTools: Set<string> | null;
  /** Who is asking — the default assignee for anything scheduled. */
  actorId: string | null;
  /** Picklist values for deal_stage, so "move it to Negotiation" writes a real stage. */
  dealStages: { value: string; label: string }[];
  /** Whether this run may change data at all. */
  allowWrites: boolean;
  /** True when the question asks who is biggest, not what the total is. */
  ranking: boolean;
  /**
   * The billing customers the resolved account maps to.
   *
   * A CRM company and its billing customer are two rows with two ids, and every
   * ledger tool takes the second. Without this the planner reported "no value
   * for customer" and answered an invoice question with the company card.
   */
  subjectCustomerIds: string[];
  /**
   * The meter the question named, as the metering module takes it.
   *
   * A workspace that sells metered telemetry answers "how much did they send"
   * from a meter, and every usage capability takes one. Without it that
   * question was answered with closed-won bookings — a different number about
   * a different thing, stated in the same confident register.
   */
  meter: string | null;
  /**
   * The price that meter is billed on, when the workspace prices it.
   *
   * "How much would 50 million telemetry events cost?" is a price question, and
   * answering it with a usage volume close to the number in the question is the
   * substitution this engine exists to refuse.
   */
  meterPrice?: string | null;
  /** A quantity the question names, for a price question that has one. */
  quantity?: number | null;
  /**
   * Meters that matched the question equally well.
   *
   * "How much telemetry did Pemberton meter in August?" names a word two meters
   * answer to. Measuring both and saying so beats picking one — which is a
   * different number half the time — and beats the six-line catalogue, which is
   * not an answer at all.
   */
  meterCandidates?: string[];
}

/**
 * One account, once.
 *
 * A company and its billing customer are two rows with the same name, and the
 * resolver returns both. Pairing them produced a "comparison" of an account
 * against itself, labelled on one side with a raw `cus_` id, while the second
 * account the question actually named was pushed out of the pair entirely.
 * CRM records win because they are the ones with a display name.
 */
export function distinctAccounts(entities: ResolvedEntity[]): ResolvedEntity[] {
  const rank: Record<string, number> = { company: 0, contact: 1, customer: 2 };
  const best = new Map<string, ResolvedEntity>();
  for (const entity of entities) {
    const key = normalise(entity.entity.label);
    const held = best.get(key);
    if (!held) { best.set(key, entity); continue; }
    const better = (rank[entity.entity.type] ?? 3) < (rank[held.entity.type] ?? 3);
    if (better) best.set(key, entity);
  }
  return entities.filter((entity) => best.get(normalise(entity.entity.label)) === entity);
}

const OPEN_TICKET_STATUSES = ['new', 'waiting_on_us', 'waiting_on_customer', 'escalated'];

/**
 * A question that really is a request to list a type.
 *
 * The unfiltered listing is a fine answer to "list our deals" and a confidently
 * wrong one to anything else, because it is ordered by recency and says so
 * nowhere.
 */
/** A question whose answer is a set of records, not a figure. */
const RECORD_QUESTION =
  /\b(which|what|who)\s+(?:\w+\s+){0,2}?(accounts?|customers?|companies|company|deals?|contacts?|tickets?|invoices?|subscriptions?|logos?)\b/i;

/** A question that asks for the state of the business, which the overview is. */
const OVERVIEW_QUESTION =
  /\b(how\s+(?:are|is|was)\s+(?:we|things|it|business|the\s+business|the\s+quarter|the\s+month)|how'?s\s+(?:it|business|everything|things)|state\s+of\s+(?:the\s+)?(?:business|play|things)|overview|brief\s+me|catch\s+me\s+up|dashboard|where\s+do\s+we\s+stand|how\s+did\s+we\s+do)\b/i;

const LIST_REQUEST =
  /\b(list|show|give\s+me|what\s+are|who\s+are|find|search|browse|pull\s+up|all\s+(?:our|the|of))\b/i;

/** "What happened on X recently?" — a request for one record's history. */
const RECENT_HISTORY =
  /\b(what\s+(?:has\s+)?happen(?:ed|ing)?|what'?s\s+going\s+on|what\s+is\s+going\s+on|latest\s+on|recent\s+activity|bring\s+me\s+up\s+to\s+speed|catch\s+me\s+up|where\s+are\s+we\s+(?:with|on))\b/i;

/** The phrases people use for an account nobody has touched. */
const GONE_QUIET =
  /\b(gone\s+(?:quiet|cold|dark|silent)|going\s+(?:quiet|cold)|no\s+(?:recent\s+)?(?:activity|contact|touch(?:es|points?)?)|not\s+(?:been\s+)?(?:touched|contacted)|haven'?t\s+(?:touched|contacted|spoken\s+to|heard\s+from)|hasn'?t\s+been\s+touched|stale\s+accounts?|neglected|slipping\s+through|dormant|inactive\s+accounts?|which\s+accounts?\s+.{0,24}\bquiet\b)/i;

export interface InferredCondition {
  property: string;
  op: 'eq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_set' | 'is_not_set';
  value?: string | number;
  values?: string[];
}

/**
 * A money threshold written into the question.
 *
 * "Which open deals are worth more than $500,000?" is the single most common
 * sentence anyone types at a CRM copilot, and dropping the threshold answered
 * it with eight deals, four of them under the number the reader named. The
 * amount is read in whole units and stored in minor units, which is how every
 * money property in this platform is held.
 */
const MONEY_ABOVE = /\b(?:more\s+than|greater\s+than|larger\s+than|bigger\s+than|over|above|north\s+of|exceeding|in\s+excess\s+of|worth\s+over)\s*(?:[$£€]\s*)?([\d][\d,.]*)\s*(k|m|bn|thousand|million|billion)?\b/i;
const MONEY_AT_LEAST = /\b(?:at\s+least|no\s+less\s+than|minimum\s+of|from)\s*(?:[$£€]\s*)?([\d][\d,.]*)\s*(k|m|bn|thousand|million|billion)?\b/i;
const MONEY_BELOW = /\b(?:less\s+than|smaller\s+than|under|below|beneath|south\s+of|worth\s+under)\s*(?:[$£€]\s*)?([\d][\d,.]*)\s*(k|m|bn|thousand|million|billion)?\b/i;
const MONEY_AT_MOST = /\b(?:at\s+most|no\s+more\s+than|up\s+to)\s*(?:[$£€]\s*)?([\d][\d,.]*)\s*(k|m|bn|thousand|million|billion)?\b/i;
/** The threshold is about money only when the sentence says so. */
const MONEY_SHAPED = /[$£€]|\b(?:\d[\d,.]*\s*(?:k|m|bn|thousand|million|billion)\b|worth|value|amount|revenue|deal\s+size|pipeline|dollars?|euros?|pounds?)\b/i;

const MAGNITUDE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };

/** The whole-unit figure a phrase names, or null when it names none. */
function moneyAmount(match: RegExpMatchArray | null): number | null {
  if (!match) return null;
  const digits = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(digits)) return null;
  const scale = match[2] ? MAGNITUDE[match[2].toLowerCase()] ?? 1 : 1;
  const amount = digits * scale;
  // A bare "over 5" is a count, not a sum of money. A magnitude word, a
  // currency symbol or a figure a person would only write about money is
  // what makes it one.
  if (!match[2] && amount < 1000) return null;
  return Math.round(amount);
}

/**
 * The money condition a question carries, in minor units, on the property that
 * holds the money for this object type.
 */
export function moneyThreshold(question: string, property: string): InferredCondition | null {
  if (!MONEY_SHAPED.test(question)) return null;
  const candidates: [RegExpMatchArray | null, InferredCondition['op']][] = [
    [question.match(MONEY_ABOVE), 'gt'],
    [question.match(MONEY_AT_LEAST), 'gte'],
    [question.match(MONEY_BELOW), 'lt'],
    [question.match(MONEY_AT_MOST), 'lte'],
  ];
  for (const [match, op] of candidates) {
    const amount = moneyAmount(match);
    if (amount !== null) return { property, op, value: amount * 100 };
  }
  return null;
}

/** The money property of an object type, when it has one. */
const MONEY_PROPERTY: Record<string, string> = { deal: 'amount', company: 'total_open_deal_value' };

/** "which deals have no next step" — an emptiness test, not a value test. */
const MISSING_FIELD = /\bno\s+(next\s+step|owner|close\s+date|amount|next\s+action)\b/i;
const MISSING_PROPERTY: Record<string, string> = {
  'next step': 'next_step', 'next action': 'next_step', owner: 'owner_id', 'close date': 'close_date', amount: 'amount',
};

/**
 * "Which tickets need attention" is not a request for every ticket ever filed.
 * Qualifiers in the question become real conditions, most specific first.
 */
export function inferConditions(question: string, objectType: string, stages: StageSets): InferredCondition[] {
  const text = normalise(question);
  const out: InferredCondition[] = [];
  const has = (re: RegExp) => re.test(text);

  if (objectType === 'ticket') {
    if (has(/\bescalated\b/)) out.push({ property: 'status', op: 'eq', value: 'escalated' });
    if (has(/\b(urgent|critical|p1|on fire)\b/)) out.push({ property: 'priority', op: 'in', values: ['urgent', 'high'] });
    if (has(/\bhigh priority\b/)) out.push({ property: 'priority', op: 'in', values: ['urgent', 'high'] });
    if (has(/\bclosed\b/)) out.push({ property: 'status', op: 'eq', value: 'closed' });
    if (has(/\b(open|unresolved|outstanding|attention|backlog|active|pending|waiting|stuck|broken|failing)\b/)) {
      out.push({ property: 'status', op: 'in', values: OPEN_TICKET_STATUSES });
    }
  }
  if (objectType === 'deal') {
    for (const stage of ['negotiation', 'proposal', 'discovery', 'qualification']) {
      if (has(new RegExp(`\\b${stage}\\b`))) out.push({ property: 'deal_stage', op: 'eq', value: stage === 'proposal' ? 'proposal' : stage });
    }
    if (has(/\bwon\b/)) out.push({ property: 'deal_stage', op: 'in', values: stages.won });
    if (has(/\blost\b/)) out.push({ property: 'deal_stage', op: 'in', values: stages.lost });
    if (has(/\b(open|active|live|in flight|pipeline|slipping|stalled)\b/)) out.push({ property: 'deal_stage', op: 'in', values: stages.open });
  }
  if (objectType === 'company') {
    if (has(/\bcustomers?\b/)) out.push({ property: 'type', op: 'eq', value: 'customer' });
    else if (has(/\bprospects?\b/)) out.push({ property: 'type', op: 'eq', value: 'prospect' });
    else if (has(/\bpartners?\b/)) out.push({ property: 'type', op: 'eq', value: 'partner' });
    if (has(/\bkey accounts?\b/)) out.push({ property: 'is_key_account', op: 'eq', value: 'true' });
  }
  if (objectType === 'contact') {
    if (has(/\bchampions?\b/)) out.push({ property: 'buying_role', op: 'eq', value: 'champion' });
    else if (has(/\b(economic buyers?|decision makers?)\b/)) out.push({ property: 'buying_role', op: 'eq', value: 'economic_buyer' });
  }

  // A number the question names is a filter, not decoration. Without this the
  // answer listed the eight biggest deals under a headline naming the whole
  // population, four of them below the threshold the reader had just typed.
  const moneyProperty = MONEY_PROPERTY[objectType];
  if (moneyProperty) {
    const threshold = moneyThreshold(question, moneyProperty);
    if (threshold) out.push(threshold);
  }
  const missing = question.match(MISSING_FIELD);
  const missingProperty = missing ? MISSING_PROPERTY[missing[1].toLowerCase().replace(/\s+/g, ' ')] : null;
  if (missingProperty) out.push({ property: missingProperty, op: 'is_not_set' });

  const seen = new Set<string>();
  return out.filter((condition) => {
    if (seen.has(condition.property)) return false;
    seen.add(condition.property);
    return true;
  });
}

/**
 * A teammate the question names, whose records the answer must be scoped to.
 *
 * "How many open deals does Priya Raman have?" answered 38 — the workspace's
 * count — and never mentioned Priya, so the reader had no signal the filter had
 * been dropped. A named owner is a filter or the question is refused; it is
 * never silently widened to everybody.
 */
/**
 * The rows a money metric is computed from, so the same figure can be measured
 * for one rep. The metric catalogue measures the workspace; these are the CRM
 * conditions each of its money metrics is built on.
 */
const MONEY_METRIC_SHAPE: Record<string, {
  objectType: string;
  measure: 'sum' | 'count';
  property?: string;
  dateProperty?: string;
  conditions: (stages: StageSets) => InferredCondition[];
}> = {
  pipeline: { objectType: 'deal', measure: 'sum', property: 'amount', conditions: (s) => [{ property: 'deal_stage', op: 'in', values: s.open }] },
  weighted_pipeline: { objectType: 'deal', measure: 'sum', property: 'weighted_amount', conditions: (s) => [{ property: 'deal_stage', op: 'in', values: s.open }] },
  closed_won: { objectType: 'deal', measure: 'sum', property: 'amount', dateProperty: 'close_date', conditions: (s) => [{ property: 'deal_stage', op: 'in', values: s.won }] },
  closed_lost: { objectType: 'deal', measure: 'sum', property: 'amount', dateProperty: 'close_date', conditions: (s) => [{ property: 'deal_stage', op: 'in', values: s.lost }] },
  deal_count: { objectType: 'deal', measure: 'count', conditions: (s) => [{ property: 'deal_stage', op: 'in', values: s.open }] },
  avg_deal_size: { objectType: 'deal', measure: 'sum', property: 'amount', dateProperty: 'close_date', conditions: (s) => [{ property: 'deal_stage', op: 'in', values: s.won }] },
};

/**
 * A CRM record the question named that is not an account.
 *
 * A ticket, a deal or a note is a summarisable thing. "Summarise the Alert
 * storm from vibration thresholds ticket" resolved that ticket at 0.72 and was
 * then answered with the workspace's quarter, because only companies and
 * contacts counted as a subject.
 */
export function namedCrmRecord(input: PlanInput): ResolvedEntity | null {
  return input.entities.find((e) =>
    ['ticket', 'deal', 'note', 'task', 'call', 'meeting', 'email'].includes(e.entity.type) && e.score >= 0.7) ?? null;
}

export function namedOwner(input: PlanInput): ResolvedEntity | null {
  const person = input.entities.find((e) => e.entity.type === 'user' && e.score >= 0.55);
  return person ?? null;
}

const builtin = (tool: BuiltinTool, args: Record<string, unknown>, why: string, relevance = 1): PlannedStep =>
  ({ tool, args, why, builtin: tool, relevance });

/**
 * A ledger capability the question asked for and this run could not use.
 *
 * Reporting one of these is the whole point. The alternative — the one this
 * platform shipped — is answering the question that was not asked: a metered
 * usage question measured as closed-won bookings, a credit question answered
 * by searching `crm_records` for an object type nothing has ever written
 * there. Both come back confident, in the same register as a real answer, and
 * a person reads the first sentence and stops.
 */
export interface BlockedCapability {
  /** The object type the question named — usage, credit, entitlement, invoice. */
  objectType: string;
  scope: 'account' | 'workspace';
  reason: 'no_capability' | 'out_of_scope' | 'missing_arguments';
  /** The capability that would have answered it, when the workspace has one. */
  tool: string | null;
  /** The same capability at the other scope, when only that one is registered. */
  otherScope: { tool: string; scope: 'account' | 'workspace' } | null;
  /** Arguments nothing in the question or the resolved records could fill. */
  missing: string[];
  /** Values the missing argument could take, when the workspace knows them. */
  options?: { label: string; detail: string | null }[];
  /** True when several of those options matched and none is clearly the one meant. */
  ambiguous?: boolean;
  /** The words in the question that matched those options ambiguously. */
  matched?: string;
}

export type LedgerAttempt =
  | { ok: true; step: PlannedStep }
  | { ok: false; blocked: BlockedCapability };

/**
 * Whether a failed attempt must suppress the fallback.
 *
 * A scoped run is the exception: the caller named the tools this run may use,
 * so answering from one of them is their instruction rather than a
 * substitution, and the answer already says the run was scoped.
 */
const suppresses = (attempt: LedgerAttempt): boolean => !attempt.ok && attempt.blocked.reason !== 'out_of_scope';

/**
 * The ledger capability for an object type, armed from what already resolved.
 *
 * Fails loudly rather than returning nothing: a caller that cannot arm the
 * ledger must say so instead of falling through to a CRM search or a sales
 * metric, which is a different question with a different number.
 */
function ledgerAttempt(
  input: PlanInput,
  objectType: string,
  scope: 'account' | 'workspace',
  why: string,
  relevance = 0.95,
): LedgerAttempt {
  const tool = ledgerToolFor(input.tools, objectType, scope);
  const elsewhere = ledgerToolFor(input.tools, objectType, scope === 'account' ? 'workspace' : 'account');
  const otherScope = !tool && elsewhere
    ? { tool: elsewhere.name, scope: (scope === 'account' ? 'workspace' : 'account') as 'account' | 'workspace' }
    : null;
  // A run the caller scoped is a different thing from a workspace that has no
  // such capability, and saying "no module publishes that" when the caller
  // themselves excluded it would be its own confident falsehood.
  if (!tool || (input.allowedTools && !input.allowedTools.has(tool.name))) {
    const reason = input.allowedTools ? 'out_of_scope' : 'no_capability';
    return { ok: false, blocked: { objectType, scope, reason, tool: tool?.name ?? null, otherScope, missing: [] } };
  }
  const filled = fillArguments(tool, fillContextOf(input));
  if (filled.missing.length) {
    return {
      ok: false,
      blocked: { objectType, scope, reason: 'missing_arguments', tool: tool.name, otherScope: null, missing: filled.missing },
    };
  }
  return { ok: true, step: { tool: tool.name, args: filled.args, why, builtin: null, relevance } };
}

/**
 * Types whose rows only the ledger holds.
 *
 * `customer` is the exception: it is the billing word for a CRM company, and
 * listing companies for one is a real answer rather than a substitute for one.
 * For everything else `crm_records` returns zero rows every time, so a fallback
 * there is not a partial answer — it is a confident wrong one.
 */
export const ledgerOnlyType = (type: string): boolean => isLedgerType(type) && type !== 'customer';

/* ------------------------------- write plans ------------------------------ */

/**
 * Turning an instruction into a write.
 *
 * The rule that matters: the *instruction wrapper never reaches the record*.
 * "Add a note to Rheinwerk saying the pilot is delayed" writes "The pilot is
 * delayed" — not the sentence the user typed at the copilot. Everything below
 * exists to strip the wrapper and keep only the content, and to refuse when the
 * content is not there rather than pasting the prompt into a customer's
 * timeline.
 */
export interface WriteAction {
  tool: string;
  args: Record<string, unknown>;
  why: string;
  /** What the confirmation card shows, in plain English. */
  preview: string[];
}

export interface WriteBlocked {
  /** The write the phrasing asked for, which could not be prepared. */
  wanted: string;
  reason: string;
}

const TRAILING_TIME =
  /\s*(?:,\s*)?\b(?:next|this|by|on|before|due|in)\s+(?:the\s+)?(?:\d{1,3}\s+)?(?:day|days|week|weeks|month|months|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|morning|afternoon|eod|eow)\b.*$/i;

const CLOSERS = /\s*(?:please|thanks|thank you|asap|for me)\s*$/i;

/** Strip the command wrapper and the scheduling tail from an instruction. */
function contentOf(instruction: string, lead: RegExp): string | null {
  const match = instruction.match(lead);
  if (!match) return null;
  const rest = instruction.slice((match.index ?? 0) + match[0].length);
  const cleaned = rest.replace(TRAILING_TIME, '').replace(CLOSERS, '').replace(/[\s.]+$/, '').trim();
  return cleaned.length >= 3 ? cleaned : null;
}

/** The note body: quoted text wins, then the clause after "saying"/"that". */
export function noteBodyFrom(instruction: string): string | null {
  const quoted = instruction.match(/["“”']([^"“”']{6,2000})["“”']/);
  if (quoted) return quoted[1].trim();
  for (const lead of [
    /\b(?:saying|stating|that\s+says|which\s+says|to\s+say)\s+(?:that\s+)?/i,
    /\bnote\s*:\s*/i,
    /\bnote\s+that\s+/i,
    /\brecord(?:ing)?\s+that\s+/i,
    /\blog(?:ging)?\s+that\s+/i,
  ]) {
    const body = contentOf(instruction, lead);
    if (body) return capitalise(body).replace(/([^.!?])$/, '$1.');
  }
  return null;
}

/** A short, human subject line derived from the body — never the raw prompt. */
export function subjectFrom(body: string, max = 64): string {
  const first = body.split(/(?<=[.!?])\s+/)[0] ?? body;
  const trimmed = first.replace(/^(?:the|a|an)\s+/i, '').replace(/[.!?]+$/, '');
  if (trimmed.length <= max) return capitalise(trimmed);
  const cut = trimmed.slice(0, max);
  return capitalise(cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : max).trim());
}

/** "Create a task to call the plant manager next Tuesday" → "Call the plant manager". */
export function taskSubjectFrom(instruction: string): string | null {
  for (const lead of [
    /\b(?:task|to-?do|reminder|follow[-\s]?up)\s+(?:to|for|about|that|:)\s*/i,
    /\b(?:remind\s+me\s+to)\s*/i,
    /\b(?:create|add|log|make|set\s+up|open)\s+(?:a|an|the)\s+\w+\s+to\s+/i,
  ]) {
    const body = contentOf(instruction, lead);
    if (body) return capitalise(body);
  }
  return null;
}

/** "Move the Rheinwerk deal to Negotiation" → the stage's machine value. */
export function stageFrom(instruction: string, options: { value: string; label: string }[]): { value: string; label: string } | null {
  const text = normalise(instruction);
  const target = text.match(/\b(?:to|into|at|as)\s+([a-z0-9 ]{3,40})$/)?.[1] ?? text;
  let best: { value: string; label: string } | null = null;
  for (const option of options) {
    const label = normalise(option.label);
    const value = normalise(option.value);
    if (!label && !value) continue;
    if (new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(target)
      || new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(target)) {
      // Prefer the longest label so "closed won" beats "won".
      if (!best || label.length > normalise(best.label).length) best = option;
    }
  }
  return best;
}

const WRITE_SHAPES: { wanted: string; re: RegExp }[] = [
  { wanted: 'add_note', re: /\b(?:add|write|log|leave|put|record)\s+(?:a|an|the)?\s*note\b|\bnote\s+(?:that|on|against)\b|\blog\s+(?:that|a\s+call|an\s+update)\b/i },
  { wanted: 'create_record', re: /\b(?:create|add|open|make|set\s+up|raise|file)\s+(?:a|an|the)?\s*(task|to-?do|reminder|ticket|deal|contact|company|case)\b/i },
  { wanted: 'update_record', re: /\b(?:move|update|change|set|advance|push|mark|reassign|assign|edit)\b/i },
  { wanted: 'schedule_followup', re: /\b(?:schedule|book|diarise|set\s+up)\s+(?:a\s+)?(?:follow[-\s]?up|check[-\s]?in|call\s+back)\b|\bfollow\s+up\s+(?:with|on|in)\b|\bremind\s+me\b/i },
];

/**
 * Choose the one write this instruction asks for and fill it from resolved
 * records. Returns the action, or what was wanted and why it could not be
 * prepared — never a read tool dressed up as a write.
 */
export function planWrite(input: PlanInput): WriteAction | WriteBlocked | null {
  const question = input.question;
  const wanted = WRITE_SHAPES.find((shape) => shape.re.test(question))?.wanted ?? null;
  if (!wanted) return null;

  const target = input.entities.find((e) => ['company', 'contact', 'deal', 'ticket', 'customer'].includes(e.entity.type));
  const person = input.entities.find((e) => e.entity.type === 'user');
  const assignee = person?.entity.id
    ?? (target?.entity.ownerId && target.entity.ownerId.startsWith('usr_') ? target.entity.ownerId : null)
    ?? (input.actorId && input.actorId.startsWith('usr_') ? input.actorId : null);
  const available = (name: string) =>
    input.tools.some((tool) => tool.name === name) && (!input.allowedTools || input.allowedTools.has(name));

  const noRecord = (verb: string): WriteBlocked => ({
    wanted,
    reason: `${verb} needs a record to write to, and nothing in the request resolved to one.`,
  });
  const noTool = (): WriteBlocked => ({
    wanted,
    reason: input.allowWrites
      ? `no "${wanted}" tool is registered in this workspace, or this run was scoped away from it.`
      : `this run is read-only. Send \`allow_writes: true\` and I will prepare it for your approval.`,
  });

  if (wanted === 'add_note') {
    if (!available('add_note')) return noTool();
    if (!target) return noRecord('Writing a note');
    const body = noteBodyFrom(question);
    if (!body) {
      return {
        wanted,
        reason: 'the note has no content — say what the note should read, e.g. add a note to an account saying "the pilot slipped to October".',
      };
    }
    const subject = subjectFrom(body);
    return {
      tool: 'add_note',
      args: { record_ids: [target.entity.id], subject, body },
      why: `Write the note onto ${target.entity.label}; the instruction wrapper is stripped so the timeline reads as a note, not as a prompt.`,
      preview: [`On ${target.entity.label}`, `Subject: ${subject}`, body],
    };
  }

  if (wanted === 'create_record') {
    const kind = question.match(/\b(?:create|add|open|make|set\s+up|raise|file)\s+(?:a|an|the)?\s*(task|to-?do|reminder|ticket|deal|contact|company|case)\b/i)?.[1]?.toLowerCase() ?? 'task';
    const objectType = /task|to-?do|reminder/.test(kind) ? 'task' : kind === 'case' ? 'ticket' : kind;
    if (objectType !== 'task') {
      return { wanted, reason: `creating a ${objectType} needs its required properties spelled out; ask me to draft it and I will show you the fields first.` };
    }
    if (!available('create_record')) return noTool();
    const subject = taskSubjectFrom(question) ?? (target ? `Follow up with ${target.entity.label}` : null);
    if (!subject) return { wanted, reason: 'the task has no subject — say what the task is, e.g. "create a task to call the plant manager".' };
    const due = resolveDueDate(question, input.workspace.now);
    const properties: Record<string, unknown> = {
      subject: truncate(subject, 120),
      occurred_at: input.workspace.now,
      status: 'not_started',
      task_type: /\bcall\b/i.test(subject) ? 'call' : /\bemail\b/i.test(subject) ? 'email' : 'follow_up',
      priority: /\b(urgent|asap|critical)\b/i.test(question) ? 'high' : 'medium',
      ...(due ? { due_at: due.at } : {}),
      ...(assignee ? { owner_id: assignee } : {}),
    };
    return {
      tool: 'create_record',
      args: { object_type: 'task', properties, ...(target ? { associate_to: [target.entity.id] } : {}) },
      why: `Create the task the request describes${target ? ` on ${target.entity.label}` : ''}${due ? `, due ${due.label}` : ''}.`,
      preview: [
        `Task: ${truncate(subject, 120)}`,
        target ? `On ${target.entity.label}` : 'Not linked to a record',
        due ? `Due ${due.label}` : 'No due date given',
      ],
    };
  }

  if (wanted === 'update_record') {
    if (!available('update_record')) return noTool();
    const deal = input.entities.find((e) => e.entity.type === 'deal');
    const stage = stageFrom(question, input.dealStages);
    if (!stage || !/\b(stage|move|advance|push|to\s+negotiation|to\s+proposal|closed)\b/i.test(question)) {
      return { wanted, reason: 'I could not tell which property to set — name the property and the value, e.g. "move <deal> to Negotiation".' };
    }
    if (!deal) return noRecord('Changing a deal stage');
    return {
      tool: 'update_record',
      args: { object_type: 'deal', id: deal.entity.id, properties: { deal_stage: stage.value } },
      why: `Set ${deal.entity.label} to the ${stage.label} stage; probability and forecast category restamp from the pipeline.`,
      preview: [`${deal.entity.label}`, `deal_stage → ${stage.label} (${stage.value})`],
    };
  }

  if (!available('schedule_followup')) return noTool();
  if (!target) return noRecord('Scheduling a follow-up');
  const due = resolveDueDate(question, input.workspace.now);
  const inDays = due?.days ?? null;
  if (!inDays) {
    return { wanted, reason: 'no due date was given — say when, e.g. "in 5 days", "next Tuesday" or "on 2026-09-14".' };
  }
  const purpose = taskSubjectFrom(question)
    ?? contentOf(question, /\b(?:follow\s+up|follow[-\s]?up|check\s+in)\s+(?:with\s+[^,]+?)?\s*(?:about|on|to|re)\s+/i)
    ?? `Follow up with ${target.entity.label}`;
  return {
    tool: 'schedule_followup',
    args: {
      record_id: target.entity.id,
      in_days: inDays,
      note: truncate(purpose, 200),
      ...(assignee ? { assignee_id: assignee } : {}),
    },
    why: `Schedule the follow-up on ${target.entity.label} for ${due!.label}${assignee ? `, assigned to its owner` : ''}.`,
    preview: [
      `On ${target.entity.label}`,
      `Due ${due!.label} (${inDays} ${inDays === 1 ? 'day' : 'days'} from now)`,
      truncate(purpose, 200),
    ],
  };
}

export const isWriteBlocked = (value: WriteAction | WriteBlocked | null): value is WriteBlocked =>
  !!value && 'reason' in value;

/**
 * The canonical sequence for the classified task.
 *
 * `blocked` is an out-parameter on purpose: a ledger capability the question
 * asked for and this run could not arm has to travel back with the plan, not
 * be swallowed by a fallback that answers something else.
 */
/**
 * The money metric a value question wants, when the metric that matched is not
 * one. "What are they worth?" next to "how many open deals" is a request for
 * the pipeline number, and the count alone is half an answer.
 */
function valueMetricFor(input: PlanInput): { id: string; label: string; snapshot: boolean } | null {
  if (!input.metric || !isValueQuestion(input.question)) return null;
  if (input.metric.metric.unit === 'money') {
    return { id: input.metric.metric.id, label: input.metric.metric.label, snapshot: !!input.metric.metric.snapshot };
  }
  for (const alternative of input.metric.alternatives) {
    const definition = metricById(alternative.id);
    if (definition?.unit === 'money') return { id: definition.id, label: definition.label, snapshot: !!definition.snapshot };
  }
  return null;
}

/**
 * A question about how a level MOVED, not about where it stands.
 *
 * "How did MRR change", "show me MRR movement", "how much new MRR did we add",
 * "what churned last quarter" — every one of these is a question about the
 * movement report, and every one of them used to be answered with the current
 * snapshot. The worst of it was the sentence underneath: the engine told the
 * reader the workspace keeps no history of recurring revenue while the movement
 * report was in the same catalogue, month by month, reconciled.
 */
export const MOVEMENT_QUESTION =
  /\b(movement|moved|compare[ds]?|comparison|versus|vs\.?|grow(?:n|ing|th)?|grew|increase[ds]?|decrease[ds]?|decline[ds]?|fall(?:en|ing)?|fell|rise|risen|rose|shrink|shrank|shrunk|trend(?:ing|ed)?|change[ds]?|churn(?:ed|ing)?|expansion|contraction|downgrade[ds]?|upgrade[ds]?|net\s+new|new\s+(?:mrr|arr|business|recurring)|add(?:ed|s|ing)?|gain(?:ed|s)?|lost|los(?:e|es|ing)|up\s+or\s+down|year\s+on\s+year|month\s+on\s+month|since\s+last)\b/i;

/** "net new MRR", "new ARR" — a movement phrase built out of the metric's name. */
const NEW_RECURRING = /\b(net\s+new|new|lost|churned|expansion|contraction)\s+(?:mrr|arr|recurring\s+revenue)\b/i;

/** The measure the movement report covers: recurring revenue, at any annualisation. */
const RECURRING_METRIC = /^(mrr|arr|net_revenue_retention|gross_revenue_retention|churn|net_new_mrr)$/;

/**
 * Measures the workspace's own revenue report restates.
 *
 * One metric gets one source. `business_metric` computes these over the period
 * the question named and says so; `revenue_summary` computes the same measures
 * over its own trailing window and labels none of them. Rendering both put
 * "GBP 100.00%" and "GBP 118.04% net revenue retention" in one answer, under a
 * closing line saying both were safe to quote.
 */
const RESTATED_BY_REVENUE_SUMMARY = /^(mrr|arr|net_revenue_retention|gross_revenue_retention|churn)$/;

/** The registered capability that holds month-by-month recurring-revenue movement. */
export const movementTool = (tools: AiToolDef[]): AiToolDef | undefined =>
  tools.find((t) => t.readOnly && /(^|[._])(revenue_)?movement$/.test(t.name));

/** How many months of movement the question is asking to see. */
export function movementMonths(input: PlanInput): number {
  const spelled = input.question.match(/\b(\d{1,2})\s+months?\b/i);
  if (spelled) return Math.max(1, Math.min(60, Number(spelled[1])));
  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, eighteen: 18 };
  const word = input.question.match(/\b(two|three|four|five|six|seven|eight|nine|ten|twelve|eighteen)\s+months?\b/i);
  if (word) return words[word[1].toLowerCase()] ?? 6;
  // A window the question named is measured in whole months, plus the opening
  // month so the reader can see what it moved from. When two periods were
  // named, the span reaches back to the earlier of them.
  const named = [...input.windows].filter((w) => w.start > 0 && w.end > w.start)
    .sort((a, b) => a.start - b.start)[0];
  if (named && named.start > 0 && named.end > named.start) {
    const months = Math.round((input.workspace.now - named.start) / (30 * DAY));
    if (months >= 1) return Math.max(2, Math.min(24, months + 1));
  }
  if (/\b(year|12\s*months|annual)\b/i.test(input.question)) return 12;
  if (/\bquarter\b/i.test(input.question)) return 6;
  return 6;
}

/**
 * The movement report, when the question is about movement in recurring revenue.
 *
 * Returns null when the question is about a level, when the metric is not a
 * recurring one, or when no module in this workspace publishes the report — in
 * which case the level, with an honest caveat, is still the best answer there is.
 */
function movementPlan(input: PlanInput): PlannedStep | null {
  if (!input.metric || !RECURRING_METRIC.test(input.metric.metric.id)) return null;
  // "Which accounts are at risk of churning?" is a question about records, not
  // about the total's movement. The movement report has no answer for it and
  // printing twelve months of book movement under it is a different question.
  if (input.groupBy === 'account' || input.ranking) return null;
  // The metric's own name is not a movement signal. "What is our churn rate"
  // asks for the rate; the word that made it a churn question cannot also be
  // the word that turns it into a movement question, or every metric named
  // after a movement is answered with the movement report instead of the rate.
  const residue = input.metric.matched
    ? input.question.replace(new RegExp(input.metric.matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ')
    : input.question;
  // "new MRR" is a movement phrase whose second word is the metric's own name,
  // so it has to be read before the name is stripped out of the sentence.
  if (!MOVEMENT_QUESTION.test(residue) && !NEW_RECURRING.test(input.question)) return null;
  const tool = movementTool(input.tools);
  if (!tool || (input.allowedTools && !input.allowedTools.has(tool.name))) return null;
  const currency = detectCurrency(input.question);
  return {
    tool: tool.name,
    args: { months: movementMonths(input), ...(currency ? { currency } : {}) },
    why: `The question asks how ${input.metric.metric.label.toLowerCase()} moved, and movement is a period measure — the snapshot cannot answer it, so the month-by-month movement report is read instead.`,
    builtin: null,
    relevance: 1,
  };
}

/** A question about what something costs, rather than about how much of it there was. */
export const PRICE_QUESTION =
  /\b(cost|costs|costing|price|prices|priced|pricing|charge|charged|charges|quote|quoted|bill(?:ed)?\s+for|what\s+would\s+.{0,40}\bbe\b)\b/i;

/** The capability that evaluates a price at a quantity. */
const quoteTool = (tools: AiToolDef[]): AiToolDef | undefined =>
  tools.find((t) => t.readOnly && /(^|[._])quote_price$/.test(t.name));

/**
 * The tier-by-tier arithmetic for a quantity on a meter's own price.
 *
 * Returns null unless the question names a price, a quantity and a meter this
 * workspace actually prices — a quote with a guessed price in it would be the
 * same failure in a different direction.
 */
function quotePlan(input: PlanInput): PlannedStep | null {
  if (!PRICE_QUESTION.test(input.question)) return null;
  const quantity = input.quantity ?? null;
  const price = input.meterPrice ?? null;
  if (!price || quantity === null) return null;
  const tool = quoteTool(input.tools);
  if (!tool || (input.allowedTools && !input.allowedTools.has(tool.name))) return null;
  const currency = detectCurrency(input.question);
  return {
    tool: tool.name,
    args: { price, quantity, ...(currency ? { currency } : {}) },
    why: `The question asks what a quantity costs, not how much of it there was, so ${quantity.toLocaleString('en-US')} is priced on the meter's own price (${price}) with the tier arithmetic shown.`,
    builtin: null,
    relevance: 1,
  };
}

function canonicalPlan(input: PlanInput, blocked: BlockedCapability[]): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const { subject, window, metric, groupBy, intent, entities } = input;

  // A price question is not a volume question. "How much would 50 million
  // telemetry events cost?" was answered with 52.1 million events metered — a
  // number close enough to the one in the question that a reader takes it for
  // the answer, containing no price at all.
  if (intent !== 'act' && intent !== 'draft') {
    const quote = quotePlan(input);
    if (quote) return [quote];
  }

  // Movement first: "how did MRR change" is not a smaller version of "what is
  // our MRR", and answering it with the level plus a paragraph denying the
  // history exists is the confident falsehood this engine exists to refuse.
  if (intent !== 'act' && intent !== 'draft' && !subject) {
    const movement = movementPlan(input);
    if (movement) return [movement];
  }
  const comparisonSubjects = distinctAccounts(
    entities.filter((e) => ['company', 'contact', 'customer'].includes(e.entity.type)),
  ).slice(0, 3);

  const currency = detectCurrency(input.question);
  const metricStep = (subjectId: string | undefined, label: string, over: TimeWindow = window, compare = true) =>
    builtin('business_metric', {
      metric: metric?.metric.id ?? 'closed_won',
      start: over.start,
      end: over.end,
      window_label: over.label,
      ...(subjectId ? { subject_id: subjectId } : {}),
      ...(currency ? { currency } : {}),
      group_by: groupBy,
      compare,
    }, label);

  // "Which accounts booked the most in 2025?" is a metric question wearing a
  // question word. Whatever the classifier called it, it is answered by the
  // grouped metric and ranked — never by a listing of the object type ordered
  // by recency, which is a confident answer to a question nobody asked.
  if (input.ranking && groupBy !== 'none' && intent !== 'act' && intent !== 'draft' && !subject) {
    const ranked = builtin('business_metric', {
      metric: metric?.metric.id ?? 'closed_won',
      start: window.start,
      end: window.end,
      window_label: window.label,
      ...(detectCurrency(input.question) ? { currency: detectCurrency(input.question)! } : {}),
      group_by: groupBy,
      compare: window.grain !== 'range' || window.start > 0,
    }, `The question asks which ${groupBy === 'account' ? 'accounts are' : `${groupBy} is`} biggest, so ${metric?.metric.label ?? 'closed-won bookings'} is computed for ${window.label} and grouped by ${groupBy} to rank them.`);
    return [ranked];
  }

  // "Explain invoice in_…" is a question about one bill. Measuring the
  // workspace's quarter, listing its open deals and counting its tickets
  // answers a different question and buries the one that was asked, so a record
  // named by id is left to the tools that can actually read it.
  // An invoice number is an id people can actually type. "Explain invoice
  // NR-000032" names one bill as precisely as "in_zWBua76XAnrENyoh" does, and
  // measuring the workspace's quarter instead answers a different question.
  // A product matched by name is not the same thing — a product name usually
  // appears as context inside a question about something else — so only an
  // exact hit on a ledger document counts.
  const ledgerRecord = entities.find((e) =>
    (e.rule === 'id' && ['invoice', 'subscription', 'product'].includes(e.entity.type))
    || (['name_exact', 'alias_exact'].includes(e.rule) && e.score >= 0.85 && ['invoice', 'subscription'].includes(e.entity.type)));

  switch (intent) {
    case 'aggregate': {
      // "How many telemetry events did we meter last month?" names both a
      // meter and a volume. The meter catalogue answers the first noun and not
      // the question: with a meter resolved, this is a usage question and the
      // usage capability is what has a number in it.
      // A meter the question named — decisively or ambiguously — makes this a
      // usage question. The catalogue answers "what do we meter", never "how
      // much did they meter", which is the question with a number in it.
      const measurable = input.meter || (input.meterCandidates?.length ?? 0) > 0
        ? [...input.types].sort((a, b) => Number(b === 'usage') - Number(a === 'usage'))
        : input.types;
      const namedType = measurable.find((t) => t !== 'activity' && t !== 'customer');
      // "How many telemetry events did they use last month?" counts rows the
      // CRM has never held. Measuring closed-won bookings instead answered a
      // different question in the same confident register, with no hint to the
      // reader that the question had been swapped.
      // The question named a word that two meters answer to. Both are measured
      // rather than one picked or the catalogue printed.
      const rivals = input.meterCandidates ?? [];
      if (!input.meter && rivals.length > 1 && namedType === 'usage') {
        const scope = subject ? 'account' : 'workspace';
        const tool = ledgerToolFor(input.tools, 'usage', scope);
        if (tool && (!input.allowedTools || input.allowedTools.has(tool.name))) {
          const base = fillContextOf(input);
          const armed = rivals.slice(0, 2).map((id) => ({ id, filled: fillArguments(tool, { ...base, meter: id }) }));
          if (armed.every((a) => !a.filled.missing.length)) {
            for (const one of armed) {
              steps.push({
                tool: tool.name,
                args: one.filled.args,
                why: `The question's wording matches ${rivals.length} meters equally well, so each is measured rather than one guessed at.`,
                builtin: null,
                relevance: 0.95,
              });
            }
            if (subject) steps.push(builtin('account_profile', { id: subject.id }, `Pull ${subject.label}'s record so the number has context.`, 0.7));
            break;
          }
        }
      }
      const ledger = !metric && namedType && isLedgerType(namedType)
        ? ledgerAttempt(input, namedType, subject ? 'account' : 'workspace',
            `${namedType} is measured by the module that owns those rows, not by the CRM and not by a sales metric.`)
        : null;
      if (ledger?.ok) {
        steps.push(ledger.step);
      } else if (ledger && suppresses(ledger)) {
        // The ledger could not be armed, so nothing is measured. Substituting
        // bookings here is what answered "how many telemetry events did they
        // use" with a sales number and no hint that the question had changed.
        blocked.push(ledger.blocked);
        return steps;
      } else if (!metric && namedType && !isLedgerType(namedType)) {
        // "How many X" with no metric behind it is a count of X, not a guess.
        const conditions = inferConditions(input.question, namedType, input.stages);
        const owner = namedOwner(input);
        steps.push(builtin('record_aggregate', {
          object_type: namedType,
          measure: 'count',
          ...(conditions.length ? { conditions } : {}),
          ...(subject ? { associated_to: subject.id } : {}),
          ...(owner ? { owner_id: owner.entity.id } : {}),
        }, `The question counts ${namedType} records${conditions.length ? ` qualified by ${conditions.map((c) => c.property).join(' and ')}` : ''}${owner ? ` and owned by ${owner.entity.label}` : ''}.`));
      } else if (namedOwner(input) && metric && MONEY_METRIC_SHAPE[metric.metric.id]) {
        // A metric with a rep's name next to it is that rep's number. The
        // metric catalogue measures the workspace, so the same figure is
        // computed over the same rows with the owner as a filter — which is
        // exact, rather than answering with everybody's total and never
        // mentioning the person the question named.
        const owner = namedOwner(input)!;
        const shape = MONEY_METRIC_SHAPE[metric.metric.id];
        steps.push(builtin('record_aggregate', {
          object_type: shape.objectType,
          measure: shape.measure,
          ...(shape.property ? { property: shape.property } : {}),
          conditions: shape.conditions(input.stages),
          owner_id: owner.entity.id,
          ...(shape.dateProperty ? { date_property: shape.dateProperty, start: window.start, end: window.end } : {}),
        }, `"${owner.mention}" is ${owner.entity.label}, so ${metric.metric.label} is computed over the rows they own rather than over the workspace.`));
      } else {
        steps.push(metricStep(subject?.id, metric
          ? `"${metric.matched}" is the ${metric.metric.label} metric${subject ? ` for ${subject.label}` : ''} over ${window.label}.`
          : `No explicit metric in the question — reporting bookings for ${window.label}.`));
      }
      // "How many open deals do we have and what are they worth?" asks two
      // things. Answering the first and dropping the second is how the total —
      // which this engine computes exactly — went missing from the answer.
      const companion = valueMetricFor(input);
      if (companion && companion.id !== metric?.metric.id) {
        steps.push(builtin('business_metric', {
          metric: companion.id,
          start: window.start,
          end: window.end,
          window_label: window.label,
          group_by: 'none',
          compare: !companion.snapshot,
        }, `The question also asks what that set is worth, so ${companion.label} is computed alongside the count.`, 0.95));
      }
      if (subject) steps.push(builtin('account_profile', { id: subject.id }, `Pull ${subject.label}'s record so the number has context.`, 0.8));
      break;
    }

    case 'compare':
      if (comparisonSubjects.length >= 2) {
        for (const candidate of comparisonSubjects.slice(0, 2)) {
          steps.push(metricStep(candidate.entity.id, `Compute ${metric?.metric.label ?? 'bookings'} for ${candidate.entity.label}.`));
        }
      } else if (input.comparison) {
        // Two periods were named, so two periods are measured. The delta the
        // answer quotes is between exactly the windows the question asked for.
        const { a, b } = input.comparison;
        steps.push(metricStep(subject?.id, `Measure ${metric?.metric.label ?? 'bookings'} over ${a.label} — the first period in the question.`, a, false));
        steps.push(metricStep(subject?.id, `Measure ${metric?.metric.label ?? 'bookings'} over ${b.label} — the second period, computed separately so the delta is between the two named periods.`, b, false));
      } else {
        steps.push(metricStep(subject?.id, `Compute ${metric?.metric.label ?? 'bookings'} for ${window.label} and the period before it.`));
      }
      break;

    case 'explain': {
      if (ledgerRecord && !subject) break;
      // "What happened on the Meridian account recently?" is a question about
      // one account's history, not about the workspace's quarter. It used to be
      // answered with the workspace's lost deals printed directly under a
      // Meridian-scoped sentence, citing three other companies.
      if (subject && RECENT_HISTORY.test(input.question)) {
        steps.push(builtin('record_timeline', { record_id: subject.id, limit: 12 },
          `The question asks what happened on ${subject.label}, which is its timeline — not the workspace's quarter.`));
        steps.push(builtin('account_profile', { id: subject.id }, `Load ${subject.label}'s record so the timeline has context.`, 0.85));
        break;
      }
      steps.push(metricStep(subject?.id, `Measure ${metric?.metric.label ?? 'the trend'} for ${window.label} against the previous period.`));
      // Every step of an account-scoped plan stays on that account. A
      // workspace-wide breakdown rendered beside subject-scoped prose reads as
      // the subject's own, whatever the citations underneath say.
      const scope = subject ? { associated_to: subject.id } : {};
      steps.push(builtin('record_aggregate', {
        object_type: 'deal',
        measure: 'sum',
        property: 'amount',
        group_by: 'deal_type',
        conditions: [{ property: 'deal_stage', op: 'eq', value: 'closed_won' }],
        date_property: 'close_date',
        start: window.start,
        end: window.end,
        ...scope,
      }, `Split what did close by deal type${subject ? ` on ${subject.label}` : ''} — new business, expansion and renewal move for different reasons.`, 0.9));
      steps.push(builtin('record_aggregate', {
        object_type: 'deal',
        measure: 'sum',
        property: 'amount',
        group_by: 'close_reason',
        conditions: [{ property: 'deal_stage', op: 'eq', value: 'closed_lost' }],
        date_property: 'close_date',
        start: window.start,
        end: window.end,
        ...scope,
      }, `Group losses by reason${subject ? ` on ${subject.label}` : ''} — the usual explanation for a drop.`, 0.85));
      break;
    }

    case 'lookup': {
      // "Which accounts have gone quiet?" is a question about last touch, and
      // it used to come back as the eight most recently created companies —
      // the exact opposite ordering — while the suggestion feed on the same
      // workspace already said which account nobody had touched in 45 days.
      if (GONE_QUIET.test(input.question) && !subject) {
        const tool = input.tools.find((t) => t.readOnly && (t.name === 'stale_accounts' || t.name.endsWith('_stale_accounts')));
        if (tool && (!input.allowedTools || input.allowedTools.has(tool.name))) {
          const filled = fillArguments(tool, fillContextOf(input));
          steps.push({
            tool: tool.name,
            args: filled.args,
            why: 'The question asks which accounts have gone quiet, which is a question about last touch — not about which records were created most recently.',
            builtin: null,
            relevance: 1,
          });
          return steps;
        }
      }
      const person = entities.find((e) => e.entity.type === 'user');
      if (person && !subject) {
        steps.push(builtin('record_search', {
          object_type: 'deal',
          conditions: [{ property: 'deal_stage', op: 'in', values: input.stages.open }],
          owner_id: person.entity.id,
          order_by: 'amount',
          limit: 8,
        }, `"${person.mention}" is ${person.entity.label}; show the open deals they own.`));
        steps.push(builtin('record_search', {
          object_type: 'ticket',
          conditions: [{ property: 'status', op: 'in', values: OPEN_TICKET_STATUSES }],
          owner_id: person.entity.id,
          limit: 5,
        }, `And the tickets assigned to ${person.entity.label}.`, 0.8));
        break;
      }
      if (subject) {
        steps.push(builtin('account_profile', { id: subject.id }, `"${subject.label}" resolved to a record; load its full profile.`));
        // "What does Rheinwerk pay us each month?" is a lookup with a number in
        // it. The profile alone answers the first half of that question.
        // A snapshot metric — what they are on right now — is a fact about the
        // record. A windowed one is a different question, and "the upcoming
        // invoice" is not a request for what was invoiced last quarter.
        if (metric?.metric.snapshot) {
          steps.push(metricStep(subject.id, `"${metric.matched}" is the ${metric.metric.label} metric for ${subject.label}.`));
        }
        // "What are their open tickets?" names a type as well as an account.
        // The profile mentions the count; only the list answers the question.
        const scopedType = input.types.find((t) => t !== 'activity' && t !== 'customer' && t !== 'company');
        if (scopedType && isLedgerType(scopedType)) {
          // Invoices, subscriptions, entitlements, credits and usage are not
          // CRM rows. Searching `crm_records` for them returns zero every time,
          // which is how an invoice question got answered with a company card.
          const ledger = ledgerAttempt(input, scopedType, 'account',
            `${scopedType} records for ${subject.label} live in the ledger, not in the CRM, so this reads them there.`);
          if (ledger.ok) steps.push(ledger.step);
          else if (suppresses(ledger)) {
            // The account card is not an answer to a question about the
            // ledger. Leading with it and burying the reason underneath is how
            // a reader ends up with a confident answer to another question.
            blocked.push(ledger.blocked);
            return [];
          }
        } else if (scopedType) {
          const conditions = inferConditions(input.question, scopedType, input.stages);
          steps.push(builtin('record_search', {
            object_type: scopedType,
            ...(conditions.length ? { conditions } : {}),
            associated_to: subject.id,
            ...(scopedType === 'deal' ? { order_by: 'amount' } : {}),
            limit: 10,
          }, `The question asks for ${scopedType} records on ${subject.label}${conditions.length ? `, qualified by ${conditions.map((c) => c.property).join(' and ')}` : ''}.`, 0.9));
        }
      } else if (input.namedSomething && !input.types.length) {
        // With an object type in the question, a typed list beats a fuzzy
        // workspace search — "which deals are slipping" is about deals, not
        // about a note whose title happens to contain the word "slipping".
        steps.push(builtin('workspace_search', { query: input.question, limit: 8 }, 'The question names something that did not resolve to one record — search the workspace first.'));
      }
      // "What are our open deals worth?" has a value at its head, and a list of
      // eight deals with no total under it answers a different question. The
      // metric that produces the total leads, and the list stays underneath it.
      const valued = valueMetricFor(input);
      if (!subject && valued) {
        steps.push(builtin('business_metric', {
          metric: valued.id,
          start: window.start,
          end: window.end,
          window_label: window.label,
          group_by: groupBy,
          compare: !valued.snapshot,
        }, `The question asks what a set is worth, so ${valued.label} is computed for ${window.label} — the total is the answer, the rows are the evidence.`));
      }
      // A phrase that is a capability's own title is a request for it, not for a
      // listing of whatever object type the sentence also mentions.
      if (!subject) {
        const named = namedCapability(input);
        if (named) { steps.push(named); break; }
      }
      if (!subject && input.types.length) {
        // "Customer" is a billing word for a CRM company; searching crm_records
        // for an object type nothing writes there returns zero, every time.
        const named = input.types[0];
        const objectType = named === 'activity' ? 'meeting' : named === 'customer' ? 'company' : named;
        // "Which customers are past due?" is a question about customers. The
        // subscription ledger holds a `past_due` status and happens to have two
        // rows with the same two names on this book, so the substitution was
        // invisible — on another book those two sets differ. The customer
        // ledger answers it when this workspace publishes that capability.
        const arrears = named === 'customer' && ARREARS_QUESTION.test(input.question)
          ? input.tools.find((t) => t.readOnly && /(^|[._])delinquent_customers$/.test(t.name))
          : undefined;
        if (arrears && (!input.allowedTools || input.allowedTools.has(arrears.name))) {
          steps.push({
            tool: arrears.name,
            args: fillArguments(arrears, fillContextOf(input)).args,
            why: 'The question asks which customers owe, which is a fact about the customer ledger — subscription status is a different table about a different thing.',
            builtin: null,
            relevance: 1,
          });
          break;
        }
        const ledgerType = named === 'customer' && BILLING_STATE.test(input.question) ? 'subscription' : named;
        // A period the question named outright is not optional. When the
        // capability that lists these rows cannot be told about it, listing the
        // whole book under the month's name is a confident answer to a
        // different question — so the windowed metric answers instead.
        const lister = ledgerToolFor(input.tools, ledgerType, 'workspace');
        if (input.windows.length && metric?.metric.unit === 'money' && !metric.metric.snapshot && lister && !acceptsWindow(lister)) {
          steps.push(metricStep(undefined, [
            `The question names ${window.label}, and \`${lister.name}\` takes no period —`,
            `listing the whole book under that month's name would answer a different question,`,
            `so ${metric.metric.label} is measured over ${window.label} instead.`,
          ].join(' ')));
          break;
        }
        const ledger = ledgerAttempt(input, ledgerType, 'workspace',
          `${ledgerType} records live in the ledger rather than in the CRM, so that is where the rows are read from.`);
        // Searching `crm_records` for rows the ledger owns returns zero every
        // time, and a zero next to the real list is noise at best.
        if (ledger.ok) { steps.push(ledger.step); break; }
        if (ledgerOnlyType(named) && suppresses(ledger)) { blocked.push(ledger.blocked); return []; }
        const conditions = inferConditions(input.question, objectType, input.stages);
        // "which deals are slipping this quarter" is about the deals due to
        // close in that quarter, not about every open deal on the book.
        const dated = objectType === 'deal' && input.windows.length > 0;
        const listOwner = namedOwner(input);
        // A recency-ordered dump of every row of a type is an answer to "list
        // the deals", and to nothing else. "Who should I call today?" came back
        // as "110 meeting records in the workspace. The 8 most recent of them",
        // and "which accounts are at risk of churning?" as the 8 most recently
        // created companies — both in the same confident register as a real
        // answer, neither saying the question had not been understood.
        if (!conditions.length && !dated && !listOwner && !LIST_REQUEST.test(input.question)) break;
        steps.push(builtin('record_search', {
          object_type: objectType,
          ...(conditions.length ? { conditions } : {}),
          ...(listOwner ? { owner_id: listOwner.entity.id } : {}),
          ...(objectType === 'deal' ? { order_by: 'amount' } : {}),
          ...(dated ? { date_property: 'close_date', start: window.start, end: window.end } : {}),
          limit: 10,
        }, [
          conditions.length
            ? `The question asks for ${objectType} records qualified by ${conditions.map((c) => c.property).join(' and ')}.`
            : `The question names ${objectType} records; list the most recent ones.`,
          dated ? `Scoped to deals closing in ${window.label}, the period the question named.` : '',
        ].filter(Boolean).join(' '), 0.7));
      }
      break;
    }

    case 'summarise':
      if (subject) {
        steps.push(builtin('account_profile', { id: subject.id }, `Summarising ${subject.label} starts with the account record.`));
        steps.push(builtin('record_timeline', { record_id: subject.id, limit: 12 }, 'Read the timeline so the summary is about what actually happened.'));
      } else if (namedCrmRecord(input)) {
        // "Summarise the Alert storm from vibration thresholds ticket" names a
        // record that is not an account. Summarising the quarter's bookings
        // instead is a confident answer to a question nobody asked.
        const record = namedCrmRecord(input)!;
        steps.push(builtin('record_timeline', { record_id: record.entity.id, limit: 12 },
          `"${record.mention}" is the ${record.entity.type} ${record.entity.label}; its own history is the summary.`));
        const reader = input.tools.find((t) => t.readOnly && /(^|[._])get_record$/.test(t.name));
        if (reader && (!input.allowedTools || input.allowedTools.has(reader.name))) {
          steps.push({
            tool: reader.name,
            args: { object_type: record.entity.type, id: record.entity.id },
            why: `Read ${record.entity.label} itself so the summary quotes its own fields.`,
            builtin: null,
            relevance: 0.95,
          });
        }
      } else {
        steps.push(metricStep(undefined, `Summarise ${window.label} with the headline number first.`));
        steps.push(builtin('record_search', {
          object_type: 'deal',
          conditions: [{ property: 'deal_stage', op: 'in', values: input.stages.open }],
          order_by: 'amount',
          limit: 8,
        }, 'List the largest open deals so the summary names names.', 0.9));
      }
      break;

    case 'plan':
      if (subject) {
        steps.push(builtin('account_profile', { id: subject.id }, `Recommendations need the current state of ${subject.label}.`));
        steps.push(builtin('record_timeline', { record_id: subject.id, limit: 8 }, 'Check the recent history before proposing a next step.'));
      } else {
        steps.push(builtin('record_search', {
          object_type: 'deal',
          conditions: [{ property: 'deal_stage', op: 'in', values: input.stages.open }],
          order_by: 'amount',
          limit: 10,
        }, 'Prioritise against the open pipeline, largest first.'));
        steps.push(metricStep(undefined, `Anchor the plan on ${metric?.metric.label ?? 'bookings'} for ${window.label}.`, ));
      }
      break;

    case 'troubleshoot':
      steps.push(builtin('record_search', {
        object_type: 'ticket',
        conditions: inferConditions(input.question, 'ticket', input.stages).length
          ? inferConditions(input.question, 'ticket', input.stages)
          : [{ property: 'status', op: 'in', values: OPEN_TICKET_STATUSES }],
        ...(subject ? { associated_to: subject.id } : {}),
        limit: 10,
      }, subject ? `Find the open tickets on ${subject.label}.` : 'Find the open tickets that match the problem.'));
      if (subject) {
        steps.push(builtin('record_timeline', { record_id: subject.id, limit: 10 }, 'Read what happened around the failure.'));
        steps.push(builtin('account_profile', { id: subject.id }, 'Check entitlement, support tier and open commercial context.', 0.8));
      }
      break;

    case 'draft':
      if (subject) {
        steps.push(builtin('account_profile', { id: subject.id }, `Personalise the draft with real facts about ${subject.label}.`));
        steps.push(builtin('record_timeline', { record_id: subject.id, limit: 6 }, 'Reference the last real interaction, not a generic opener.'));
      } else if (input.namedSomething) {
        steps.push(builtin('workspace_search', { query: input.question, limit: 5 }, 'Find who the message is about before writing it.'));
      }
      break;

    case 'act': {
      const write = planWrite(input);
      if (write && !isWriteBlocked(write)) {
        steps.push({ tool: write.tool, args: write.args, why: write.why, builtin: null, relevance: 1 });
      } else if (subject) {
        // Nothing writable was resolved. Load the record so the answer can say
        // what it knows — and say plainly that it changed nothing.
        steps.push(builtin('account_profile', { id: subject.id }, `No write could be prepared, so this reads ${subject.label} rather than pretending to change it.`));
      }
      break;
    }
  }

  // "How are we doing?" names nothing at all. Answer it with the state of the
  // business rather than with an apology.
  //
  // An `act` request is the exception: when nothing writable could be prepared
  // the honest answer is that nothing changed, and reading the quarter's
  // bookings to fill the silence would spend the budget and hang citations for
  // records the answer never mentions off a sentence about a failed write.
  // The overview is the answer to a question that asks for one. A question that
  // named an object type, a measure or a record and could not be turned into a
  // plan is a question this engine did not understand, and the overview under
  // it reads as an answer to it: "who should I call today?" came back as the
  // quarter's bookings, the five biggest open deals and the ticket backlog.
  const wantsOverview = OVERVIEW_QUESTION.test(input.question)
    || (!input.types.length && !metric && !entities.length && !input.windows.length);
  // A measure that resolved is the answer on its own. What it is not is a cue
  // to print the five biggest open deals and the ticket backlog underneath it.
  // …unless the question asked which records. A workspace-level rate under
  // "which accounts are at risk of churning?" answers a different question in
  // the same confident register, and names no account at all.
  const wantsRecords = RECORD_QUESTION.test(input.question);
  if (!steps.length && intent !== 'act' && !ledgerRecord && !wantsOverview && metric && !wantsRecords) {
    steps.push(metricStep(subject?.id, `"${metric.matched}" is the ${metric.metric.label} metric${subject ? ` for ${subject.label}` : ''} over ${window.label}.`));
  }
  if (!steps.length && intent !== 'act' && !ledgerRecord && wantsOverview) {
    steps.push(metricStep(undefined, `Nothing specific was named, so the answer opens with ${metric?.metric.label ?? 'bookings'} for ${window.label}.`));
    steps.push(builtin('record_search', {
      object_type: 'deal',
      conditions: [{ property: 'deal_stage', op: 'in', values: input.stages.open }],
      order_by: 'amount',
      limit: 5,
    }, 'Name the biggest open deals so the picture is concrete.', 0.8));
    steps.push(builtin('record_aggregate', {
      object_type: 'ticket',
      measure: 'count',
      conditions: [{ property: 'status', op: 'in', values: OPEN_TICKET_STATUSES }],
      group_by: 'priority',
    }, 'Put the support backlog next to the revenue picture.', 0.7));
  }

  return steps;
}

/* ---------------------------- generic matching ---------------------------- */

const TYPE_HINTS: Record<string, string[]> = {
  company: ['company', 'account', 'organisation', 'organization'],
  contact: ['contact', 'person', 'people', 'lead'],
  deal: ['deal', 'opportunity', 'pipeline'],
  ticket: ['ticket', 'case', 'escalation', 'helpdesk'],
  invoice: ['invoice', 'billing', 'payment'],
  subscription: ['subscription', 'plan'],
  product: ['product', 'price', 'catalog', 'catalogue'],
  customer: ['customer', 'account', 'subscriber', 'billing'],
};

/** How well a tool matches the question, 0–1. */
export function scoreTool(tool: AiToolDef, input: Pick<PlanInput, 'question' | 'intent' | 'types'>): number {
  const haystack = normalise(`${tool.name} ${tool.description} ${(tool.tags ?? []).join(' ')}`);
  const haystackStems = new Set(contentWords(haystack).map(stem));
  const questionStems = contentWords(input.question).map(stem);
  if (!questionStems.length) return 0;

  let hits = 0;
  for (const token of new Set(questionStems)) if (haystackStems.has(token)) hits++;
  let score = hits / Math.min(new Set(questionStems).size, 8);
  score = Math.min(score, 1) * 0.7 + trigramSimilarity(input.question, `${tool.name} ${tool.description.slice(0, 120)}`) * 0.3;

  let onTopic = !input.types.length;
  for (const type of input.types) {
    for (const hint of TYPE_HINTS[type] ?? []) if (haystack.includes(hint)) { score += 0.12; onTopic = true; break; }
  }
  // "What are their open tickets?" is not a question about invoices, however
  // many of its words a billing tool happens to share. A tool that speaks about
  // none of the object types the question named starts from further back.
  if (!onTopic) score *= 0.6;
  // A write is never chosen because it *sounds* relevant. Writes come only from
  // `planWrite`, which has to extract real arguments before it will propose one.
  if (!tool.readOnly) return 0;
  return Math.max(0, Math.min(1, score));
}

interface FillContext {
  question: string;
  window: TimeWindow;
  /** The workspace clock — "overdue" means before now, not before the window. */
  now: number;
  entities: ResolvedEntity[];
  subject: MetricSubject | null;
  metric: MetricDetection | null;
  groupBy: GroupBy;
  types: string[];
  /** Read tools may fall back to the raw question; writes may never. */
  readOnly: boolean;
  /** Billing customer ids for the account this question is about. */
  customerIds: string[];
  /**
   * The meter the question named, as the metering module takes it.
   *
   * Every usage capability measures one meter, and the workspace's meters are
   * the only place the phrase "telemetry events" means anything. Resolved from
   * `meters.name` and `meters.event_name` rather than guessed from the sentence.
   */
  meter: string | null;
  /** Ids the first pass returned — how a second pass reaches a typed argument. */
  harvestedIds?: string[];
}

const ID_FIELD = /(^|_)(id|ids|record_id|customer_id|company_id|account_id|contact_id|deal_id|subject_id|entity_id)$/;
/** Fields whose value genuinely is the sentence the person typed. */
const QUERY_FIELD = /^(q|query|search|text|term|question|prompt|message|body|content|input|instruction)$/;
const LIMIT_FIELD = /^(limit|max|count|top|size|per_page)$/;
const START_FIELD = /^(start|from|since|start_at|start_date|after|period_start)$/;
const END_FIELD = /^(end|to|until|end_at|end_date|before|period_end)$/;
const TYPE_FIELD = /^(object_type|type|entity_type|record_type|resource)$/;
/** A parameter that names an account rather than describing one. */
const ACCOUNT_FIELD = /^(customer|customer_ref|account|client|subscriber)$/;
/** A parameter named after the kind of record it takes. */
const ENTITY_FIELD = /^(invoice|subscription|charge|deal|company|contact|ticket|product|record)$/;
const DUE_FIELD = /^(due_before|overdue_before|due_by|before_date)$/;
const OVERDUE = /\b(overdue|past\s+due|late|owed|owing|outstanding|unpaid|arrears|not\s+paid)\b/i;

/**
 * An id of a stated kind, written in the question.
 *
 * `v.id('in')` publishes its prefix in the schema, so "Explain invoice
 * in_74A4fHpece5SDbwX" can hand `billing_explain_invoice` the id it contains
 * instead of the sentence that contains it — which is what the tool rejected.
 */
export const idPrefixOf = (node: SchemaNode): string | null =>
  node.format && node.format.startsWith('id:') ? node.format.slice(3) : null;

export function idOfKind(text: string, prefix: string): string | null {
  const match = text.match(new RegExp(`\\b${prefix}_[A-Za-z0-9][A-Za-z0-9_]{1,40}\\b`));
  return match ? match[0] : null;
}

/**
 * Words that select an enum member without spelling it. "Which invoices are
 * overdue" has to reach `status: open_like`, or the answer lists the whole book
 * and calls it the overdue ones.
 */
const ENUM_SYNONYMS: [string, RegExp][] = [
  ['past_due', /\b(past\s+due|overdue|dunning|failed\s+payment)\b/i],
  ['uncollectible', /\b(uncollectible|written\s+off|write[-\s]off)\b/i],
  ['open_like', /\b(open|overdue|past\s+due|outstanding|unpaid|owed|owing|due|not\s+paid)\b/i],
  ['active_like', /\b(active|live|running|current|still\s+on)\b/i],
  ['trialing', /\b(trial|trialing|trialling|in\s+trial)\b/i],
  ['canceled', /\b(cancell?ed|churned|ended)\b/i],
  ['paused', /\bpaused?\b/i],
  ['draft', /\bdrafts?\b/i],
  ['void', /\bvoid(ed)?\b/i],
  ['paid', /\b(paid|settled|collected)\b/i],
  ['all', /\b(all|every|any|whole\s+book)\b/i],
];

function enumFromQuestion(options: readonly string[], question: string): string | undefined {
  const text = normalise(question);
  // A member named outright wins over one inferred from a synonym.
  const named = options.find((option) => option.length > 3 && text.includes(normalise(option)));
  if (named) return named;
  for (const [option, pattern] of ENUM_SYNONYMS) {
    if (options.includes(option) && pattern.test(question)) return option;
  }
  return undefined;
}

function fillField(name: string, node: SchemaNode, context: FillContext): unknown {
  if (node.default !== undefined) return node.default;

  // A typed id is filled from an id of that type, or not at all. Handing a
  // `sub_`-shaped parameter a company id, or the sentence, is a call that can
  // only fail — and it failed invisibly, two lines under a confident answer.
  const prefix = idPrefixOf(node);
  if (prefix) {
    return idOfKind(context.question, prefix)
      ?? context.entities.find((e) => e.entity.id.startsWith(`${prefix}_`))?.entity.id
      ?? context.harvestedIds?.find((id) => id.startsWith(`${prefix}_`));
  }
  if (ACCOUNT_FIELD.test(name)) {
    return idOfKind(context.question, 'cus')
      ?? context.entities.find((e) => e.entity.type === 'customer')?.entity.id
      ?? context.customerIds[0]
      ?? context.harvestedIds?.find((id) => id.startsWith('cus_'));
  }
  // "Meter id or event name" — the meter the question named, resolved against
  // the workspace's own meter names and event names before the plan was built.
  if (name === 'meter' || name === 'meter_id') {
    return context.meter ?? context.entities.find((e) => e.entity.type === 'meter')?.entity.id;
  }
  if (name === 'feature' || name === 'feature_key') {
    return context.entities.find((e) => e.entity.type === 'feature')?.entity.id;
  }
  // A parameter named after a record type takes that record, when the question
  // resolved one. The id prefix is not derivable from the name — an invoice is
  // `in_`, not `inv_` — so this only trusts what actually resolved.
  if (ENTITY_FIELD.test(name)) {
    return context.entities.find((e) => e.entity.type === name)?.entity.id
      ?? (name === 'customer' ? context.customerIds[0] : undefined);
  }
  if (ID_FIELD.test(name)) {
    const wanted = name.replace(/_id$/, '');
    const match = context.entities.find((e) => e.entity.type === wanted) ?? context.entities[0];
    if (name.endsWith('ids')) return match ? [match.entity.id] : undefined;
    return match?.entity.id;
  }
  if (TYPE_FIELD.test(name)) {
    const named = context.types.find((t) => t !== 'activity');
    return named ?? context.entities[0]?.entity.type ?? 'company';
  }
  if (QUERY_FIELD.test(name)) return context.question;
  if (LIMIT_FIELD.test(name)) return node.type === 'integer' || node.type === 'number' ? Math.min(node.max ?? 10, 10) : undefined;
  if (DUE_FIELD.test(name)) return OVERDUE.test(context.question) ? context.now : undefined;
  if (START_FIELD.test(name)) return context.window.start;
  if (END_FIELD.test(name)) return context.window.end;
  // A capability that prints the period back has to print the period the
  // question named — "Aug 2026", not a pair of formatted timestamps.
  if (name === 'window_label' || name === 'period_label') return context.window.label;
  if (name === 'metric' && context.metric) return context.metric.metric.id;
  if (name === 'group_by' || name === 'groupby') return context.groupBy === 'none' ? undefined : context.groupBy;
  // Only when the question actually named a period. A default window turned
  // "which accounts have gone quiet" into "quiet for 92 days", which is this
  // quarter's length wearing a threshold's name.
  if (/^(days|days_back|lookback|window_days)$/.test(name)) {
    // A number of days written into the question is the threshold it asks for.
    const spelled = context.question.match(/\b(\d{1,4})\s*(?:days?|d)\b/i);
    if (spelled) return Number(spelled[1]);
    return context.window.matched
      ? Math.max(1, Math.round((context.window.end - context.window.start) / 86_400_000))
      : undefined;
  }

  if (node.enum?.length) return enumFromQuestion(node.enum, context.question);
  if (node.type === 'boolean') return undefined;
  if (node.type === 'integer' || node.type === 'number') {
    const match = context.question.match(/\b(\d{1,6})\b/);
    return match ? Number(match[1]) : undefined;
  }
  // Anything else required and free-text — a feature key, a price lookup key, a
  // meter — has no value that can be read out of the sentence. The step is
  // dropped rather than run with the prompt in the parameter: a tool call that
  // can only fail is worse than one that never happened, because it fails
  // quietly under an answer that looks finished.
  return undefined;
}

/**
 * A registered tool that lists an object type the CRM does not hold.
 *
 * Subscriptions and invoices live in the ledger, not in `crm_records`, so a
 * question that names them has to reach the module that owns them. Matched on
 * the catalogue's naming convention rather than on a module's tool names, so
 * the engine stays ignorant of which module happens to be installed.
 */
const BILLING_STATE = /\b(past\s+due|overdue|delinquent|dunning|churn(?:ed|ing)?|trialing|trialling|in\s+trial|paused|cancell?ed|unpaid|on\s+trial)\b/i;
/** The half of that which is about money owed rather than about a plan's state. */
const ARREARS_QUESTION = /\b(past\s+due|overdue|delinquent|in\s+arrears|owe[sd]?|owing|unpaid|behind\s+on\s+payment)\b/i;

export function ledgerListTool(tools: AiToolDef[], objectType: string): AiToolDef | undefined {
  const wanted = [`list_${objectType}s`, `list_${objectType}`, `${objectType}s_list`];
  return tools.find((tool) => tool.readOnly && wanted.some((suffix) => tool.name.endsWith(suffix)));
}

/**
 * The capability that answers a question about one object type, for one account.
 *
 * Same idea as `ledgerListTool` and the same rule: match on the catalogue's
 * naming convention, never on a module's name, so the engine stays ignorant of
 * which modules a workspace installed. The suffixes are the ones the platform's
 * own tool-naming convention uses for "everything about this account's X".
 */
const ACCOUNT_LEDGER_SUFFIXES: Record<string, string[]> = {
  invoice: ['list_invoices'],
  subscription: ['list_subscriptions'],
  entitlement: ['for_customer', 'entitlements'],
  credit: ['balance', 'settlement_for_period'],
  // `metered_usage` first: it takes the period's own label and names the
  // account, so an account-scoped answer reads as a sentence about that
  // account over that month rather than a raw date range.
  usage: ['metered_usage', 'usage_for_period'],
  customer: ['customer_summary'],
};

/** Capabilities that answer the same question for the whole workspace. */
const WORKSPACE_LEDGER_SUFFIXES: Record<string, string[]> = {
  invoice: ['list_invoices'],
  subscription: ['list_subscriptions'],
  // A meter question with no meter named is a catalogue question; a meter
  // question that names one is a question about a number, and the catalogue is
  // not that number.
  meter: ['list_meters'],
  usage: ['metered_usage'],
  product: ['list_products'],
  entitlement: ['at_limit'],
};

/**
 * Whether a capability can be told which period to read.
 *
 * "What did we invoice in August 2026?" reached `billing_list_invoices` with
 * `{limit: 10}` and answered "341 invoices are in the book", listing bills due
 * in October. The month was parsed, resolved, and then dropped on the way in —
 * which is the substitution this engine exists to refuse, wearing a list.
 */
export function acceptsWindow(tool: AiToolDef): boolean {
  const schema = tool.input.describe();
  if (schema.type !== 'object' || !schema.fields) return false;
  const names = Object.keys(schema.fields);
  // A pair of bounds, or a lookback the caller can set — both let the tool be
  // told which period the question meant. `due_before` does not count: it
  // filters a due date and cannot express "August 2026".
  if (names.some((n) => /^(months|days|days_back|lookback|window_days|period)$/.test(n))) return true;
  return names.some((n) => START_FIELD.test(n)) && names.some((n) => END_FIELD.test(n));
}

export function ledgerToolFor(tools: AiToolDef[], objectType: string, scope: 'account' | 'workspace'): AiToolDef | undefined {
  const suffixes = (scope === 'account' ? ACCOUNT_LEDGER_SUFFIXES : WORKSPACE_LEDGER_SUFFIXES)[objectType] ?? [];
  for (const suffix of suffixes) {
    const found = tools.find((tool) => tool.readOnly && (tool.name === suffix || tool.name.endsWith(`_${suffix}`) || tool.name.endsWith(`.${suffix}`)));
    if (found) return found;
  }
  return ledgerListTool(tools, objectType);
}

export const fillContextOf = (input: PlanInput): FillContext => ({
  question: input.question,
  window: input.window,
  now: input.workspace.now,
  entities: input.entities,
  subject: input.subject,
  metric: input.metric,
  groupBy: input.groupBy,
  types: input.types,
  readOnly: true,
  customerIds: input.subjectCustomerIds,
  meter: input.meter,
});

export interface FilledArguments {
  args: Record<string, unknown>;
  missing: string[];
}

/** Fill a tool's arguments from the resolved context; report what is missing. */
export function fillArguments(tool: AiToolDef, context: FillContext): FilledArguments {
  const schema = tool.input.describe();
  context = { ...context, readOnly: tool.readOnly };
  const args: Record<string, unknown> = {};
  const missing: string[] = [];
  if (schema.type !== 'object' || !schema.fields) return { args, missing };
  for (const [name, node] of Object.entries(schema.fields)) {
    const value = fillField(name, node, context);
    if (value === undefined || value === null) {
      if (!node.optional) missing.push(name);
      continue;
    }
    args[name] = value;
  }
  return { args, missing };
}

/**
 * A capability that identifies one record, with no record to identify.
 *
 * Only fires when every identifying parameter is optional — a required one is
 * already reported as missing — and none of them could be filled from the
 * question or from anything it resolved.
 */
function subjectless(tool: AiToolDef, context: FillContext): boolean {
  const schema = tool.input.describe();
  if (schema.type !== 'object' || !schema.fields) return false;
  const identifiers = Object.entries(schema.fields).filter(([name, node]) =>
    node.optional && (idPrefixOf(node) !== null || ID_FIELD.test(name) || ENTITY_FIELD.test(name) || ACCOUNT_FIELD.test(name)));
  if (!identifiers.length) return false;
  return identifiers.every(([name, node]) => fillField(name, node, context) === undefined);
}

/** A tool the question wanted and the question could not arm. */
export interface SkippedTool {
  tool: string;
  /** Parameters nothing in the question or the resolved records could fill. */
  missing: string[];
  relevance: number;
}

export interface PlanResult {
  steps: PlannedStep[];
  skipped: SkippedTool[];
  /** Ledger capabilities the question asked for and this run could not use. */
  blocked: BlockedCapability[];
}

/**
 * Build the ordered plan: the canonical steps for the intent, then any
 * registered tool that scores well enough and whose arguments can be filled.
 * A tool that matches but cannot be armed is reported rather than run with the
 * question in its parameters — a call that can only fail is worse than one that
 * never happened, because it fails quietly underneath a finished-looking answer.
 */
export function planTools(input: PlanInput): PlanResult {
  // A caller that scopes a run to two tools gets exactly those two. The
  // allowlist is applied to the canonical plan as well as to the generic
  // matcher, because the built-in capabilities are registered tools like any
  // other and an integrator scoping an agent means the whole run.
  const allowed = (name: string) => !input.allowedTools || input.allowedTools.has(name);
  const blocked: BlockedCapability[] = [];
  const steps = canonicalPlan(input, blocked).filter((step) => allowed(step.tool));
  const planned = new Set(steps.map((s) => s.tool));
  const context: FillContext = fillContextOf(input);

  // A question whose own capability could not be armed is refused, and a
  // generic match running underneath the refusal is the substitution again in
  // a smaller font. The one exception is a capability the question asked for by
  // name — "what is the credit burn order" names one, and answering it is not
  // a substitute for anything.
  const refusing = blocked.length > 0 && steps.length === 0;

  const offIntent = (name: string) =>
    (name === 'compose_message' && input.intent !== 'draft') ||
    (name === 'schedule_followup' && input.intent !== 'act') ||
    // A capability with one question behind it is planned by that question or
    // not at all. `stale_accounts` shares the words "open" and "accounts" with
    // half the questions a CRM gets, and the generic matcher put a list of
    // neglected accounts under "how many open deals do we have".
    (name === 'stale_accounts' && !GONE_QUIET.test(input.question)) ||
    // The meter catalogue is an answer to "what do we meter", never a
    // consolation prize under a question that named a meter and a number.
    (/(^|[._])list_meters$/.test(name) && !!input.meter) ||
    // Movement is planned by a movement question or not at all. The generic
    // matcher put twelve months of book movement under "which accounts are at
    // risk of churning" because the tool's description contains "churn".
    (/(^|[._])(revenue_)?movement$/.test(name) && !planned.has(name)) ||
    // One metric, one source. The question named a measure and the canonical
    // plan is computing it over a stated period; a broad report that restates
    // the same measure over its own unstated window puts two different numbers
    // for one metric into one answer.
    (/(^|[._])summary$/.test(name) && !!input.metric
      && RESTATED_BY_REVENUE_SUMMARY.test(input.metric.metric.id) && planned.has('business_metric'));

  // Two tools that read the same rows are one tool. A registered search that
  // duplicates a capability already in the plan buys nothing and costs a step.
  const OVERLAPS: Record<string, string[]> = {
    search_records: ['record_search', 'workspace_search', 'record_aggregate'],
    get_record: ['account_profile', 'record_timeline'],
  };
  const duplicates = (name: string) => (OVERLAPS[name] ?? []).some((covered) => planned.has(covered));

  // A period the question named outright rules out any capability that cannot
  // be told about it, once something in the plan is already measuring that
  // period. Listing the whole book beside a figure for one month is two answers
  // to one question, and only one of them is about the month.
  const windowed = input.windows.length > 0
    && steps.some((step) => step.tool === 'business_metric' && Number.isFinite(Number(step.args.start)));
  const ignoresWindow = (tool: AiToolDef) => windowed && !acceptsWindow(tool);

  const answeredMetric = !!input.metric && planned.has('business_metric');
  const candidates = input.tools
    .filter((tool) => tool.readOnly && allowed(tool.name) && !planned.has(tool.name)
      && !BUILTIN_TOOLS.includes(tool.name as BuiltinTool) && !offIntent(tool.name) && !duplicates(tool.name)
      && !ignoresWindow(tool)
      && (!refusing || askedFor(tool.name, input.question)))
    .map((tool) => ({ tool, relevance: scoreTool(tool, input) }))
    // A capability the question named in its own words clears a lower bar when
    // the alternative is refusing: "what is the credit burn order" names one,
    // and the scorer only gives it 0.37 because the tool's description is short.
    // A question that named a measure already has its answer in the canonical
    // plan. A second report earns a slot only if the question asked for it in
    // its own words, or matches strongly — otherwise a paragraph of receivables
    // lands under a question about churn and reads as part of the answer.
    .filter((c) => c.relevance >= (refusing ? 0.2
      : answeredMetric && !askedFor(c.tool.name, input.question) ? 0.58
      : 0.42))
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 4);

  const skipped: SkippedTool[] = [];
  for (const candidate of candidates) {
    // A capability that explains one named record, called with no record, does
    // not explain the question — it explains whichever row it happens to find.
    // `payments.explain_decline` ran under "what did we invoice in August 2026"
    // because its description contains the word "invoice", with `{}` for
    // arguments and a decline nobody had asked about for an answer.
    if (subjectless(candidate.tool, context)) continue;
    if (steps.length >= input.maxSteps) break;
    // Once the canonical plan has real coverage, only a strong match earns a slot.
    if (steps.length >= 2 && candidate.relevance < 0.55) break;
    const { args, missing } = fillArguments(candidate.tool, context);
    if (missing.length) {
      skipped.push({ tool: candidate.tool.name, missing, relevance: candidate.relevance });
      continue;
    }
    steps.push({
      tool: candidate.tool.name,
      args,
      why: `"${candidate.tool.name}" matches the question (relevance ${candidate.relevance.toFixed(2)}): ${candidate.tool.description.split('.')[0]}.`,
      builtin: null,
      relevance: candidate.relevance,
    });
    planned.add(candidate.tool.name);
  }

  // The refusal stands only if nothing the question named by its own words could
  // be armed. When something could, that is the answer, and the ledger note
  // would be a caveat about a capability the reader never asked after.
  if (refusing) return { steps: steps.slice(0, input.maxSteps), skipped: [], blocked: steps.length ? [] : blocked };

  // A capability the question asked for by name, needing a typed id the
  // question does not carry, gets a finder in front of it: list the records of
  // that kind for the account that did resolve, and the second pass arms the
  // tool from the single row that comes back.
  for (const candidate of skipped) {
    if (steps.length >= input.maxSteps) break;
    if (!askedFor(candidate.tool, input.question)) continue;
    for (const missing of candidate.missing) {
      const finder = ledgerListTool(input.tools, missing);
      if (!finder || planned.has(finder.name) || !allowed(finder.name)) continue;
      const filled = fillArguments(finder, context);
      if (filled.missing.length) continue;
      steps.push({
        tool: finder.name,
        args: filled.args,
        why: `"${candidate.tool}" needs a ${missing} the question does not name; this lists the ${missing} records it could mean.`,
        builtin: null,
        relevance: 0.8,
      });
      planned.add(finder.name);
    }
  }

  return { steps: steps.slice(0, input.maxSteps), skipped, blocked };
}

export const planSteps = (input: PlanInput): PlannedStep[] => planTools(input).steps;

/** Words in a tool name that describe the call, not the thing it reads. */
// `explain`, `preview` and `check` are verbs a person actually types, so they
// stay required: without them `billing_explain_invoice` matched the bare word
// "invoice" and told a reader it had not run, under a finished answer about
// what the workspace invoiced last quarter.
const GENERIC_TOOL_WORDS = new Set([
  'list', 'get', 'find', 'search', 'for', 'period',
  'summary', 'info', 'record', 'records', 'at', 'of', 'by',
]);

/**
 * Whether the question asked for this capability in its own words.
 *
 * A tool that could not be armed is worth a sentence in the answer when the
 * person asked for it — "show me the upcoming invoice" and no `sub_` id — and
 * is noise when they did not. Relevance cannot tell those apart: the scorer
 * gives `billing_customer_summary` 0.75 on "what is our MRR?".
 */
export function askedFor(tool: string, question: string): boolean {
  const words = tool.split(/[._]/).slice(1).filter((word) => !GENERIC_TOOL_WORDS.has(word));
  if (!words.length) return false;
  const asked = new Set(contentWords(question).map(stem));
  return words.every((word) => asked.has(stem(word)));
}

/**
 * A capability the question names by its own title.
 *
 * "Show me the recovery queue" names `payments.recovery_queue`; "what are the
 * properties on a deal" names `list_properties`. Both were refused — one with a
 * sentence asserting that "recovery" and "queue" match nothing in the workspace
 * while the capability sat in the live catalogue, the other with eight deal
 * records. The tool catalogue is part of the workspace's vocabulary, and a
 * phrase that is a capability's own name routes to it.
 */
const CAPABILITY_STOPWORDS = new Set([
  // Nouns that name the workspace's own subjects rather than a capability.
  // `billing_list_invoices` reduces to "invoices", and "what did we invoice in
  // August" is a question about a period, not a request for the whole book.
  'invoice', 'invoices', 'subscription', 'subscriptions', 'deal', 'deals', 'ticket', 'tickets',
  'company', 'companies', 'contact', 'contacts', 'customer', 'customers', 'product', 'products',
  'meter', 'meters', 'pipeline', 'pipelines', 'account', 'accounts', 'usage', 'credit', 'credits',
  'balance', 'summary', 'movement', 'collections', 'note', 'notes', 'task', 'tasks', 'meeting',
  'meetings', 'email', 'emails', 'message', 'messages', 'price', 'prices',
]);

export function namedCapability(input: PlanInput): PlannedStep | null {
  const candidates = input.tools
    .filter((tool) => tool.readOnly
      && !BUILTIN_TOOLS.includes(tool.name as BuiltinTool)
      && (!input.allowedTools || input.allowedTools.has(tool.name))
      && askedFor(tool.name, input.question)
      // A capability with one question behind it is planned by that question.
      && !(tool.name === 'stale_accounts' && !GONE_QUIET.test(input.question))
      && !(/(^|[._])list_meters$/.test(tool.name) && !!input.meter))
    .map((tool) => ({ tool, words: tool.name.split(/[._]/).slice(1).filter((w) => !GENERIC_TOOL_WORDS.has(w)) }))
    // One word is enough only when that word names a capability rather than one
    // of the workspace's own subjects: "the properties on a deal" names
    // `list_properties`, while "invoices" names the whole book and the question
    // that used it was about a month.
    .filter((c) => c.words.length > 1 || (c.words.length === 1 && !CAPABILITY_STOPWORDS.has(c.words[0])))
    // The most specific title wins: a two-word capability beats a one-word one.
    .sort((a, b) => b.words.length - a.words.length || a.tool.name.length - b.tool.name.length);
  const context = fillContextOf(input);
  for (const candidate of candidates) {
    const filled = fillArguments(candidate.tool, context);
    if (filled.missing.length) continue;
    return {
      tool: candidate.tool.name,
      args: filled.args,
      why: `"${candidate.words.join(' ')}" is the name of a capability this workspace publishes, so the question routes to it rather than to a record listing.`,
      builtin: null,
      relevance: 1,
    };
  }
  return null;
}

/** Every id a first pass returned, so a second pass can arm a typed parameter. */
export function harvestIds(results: unknown[]): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (found.size >= 80 || depth > 4) return;
    if (typeof value === 'string') {
      if (/^[a-z][a-z_]{1,14}_[A-Za-z0-9][A-Za-z0-9_]{1,40}$/.test(value)) found.add(value);
      return;
    }
    if (Array.isArray(value)) { for (const item of value.slice(0, 20)) walk(item, depth + 1); return; }
    if (value && typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1);
  };
  for (const result of results) walk(result, 0);
  // Only an id with no rival of its kind can arm a second pass. A list of 35
  // subscriptions does not tell you which one the question meant, and picking
  // the first is how a run answers confidently about the wrong account.
  const byPrefix = new Map<string, string[]>();
  for (const id of found) {
    const prefix = id.slice(0, id.indexOf('_'));
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), id]);
  }
  return [...byPrefix.values()].filter((ids) => ids.length === 1).map((ids) => ids[0]);
}

/**
 * The second pass. After the first wave of results the engine knows more —
 * a search that pinned down one record, an aggregate with an obvious follow-up
 * — so it may plan one more round inside the remaining budget.
 */
export function replan(
  input: PlanInput,
  executed: { tool: string; result: unknown }[],
  remaining: number,
  skipped: SkippedTool[] = [],
): PlannedStep[] {
  if (remaining <= 0) return [];
  const done = new Set(executed.map((e) => e.tool));
  const steps: PlannedStep[] = [];

  // A tool the first pass could not arm gets one more chance against what the
  // first pass returned: "the upcoming invoice for Sakamoto Seiki" names no
  // `sub_` id, but the step that listed their subscriptions did.
  const harvested = harvestIds(executed.map((e) => e.result));
  if (harvested.length) {
    const context: FillContext = { ...fillContextOf(input), harvestedIds: harvested };
    for (const candidate of skipped) {
      if (steps.length >= remaining || done.has(candidate.tool)) continue;
      if (input.allowedTools && !input.allowedTools.has(candidate.tool)) continue;
      const tool = input.tools.find((t) => t.name === candidate.tool);
      if (!tool || !tool.readOnly) continue;
      const { args, missing } = fillArguments(tool, context);
      if (missing.length) continue;
      steps.push({
        tool: tool.name,
        args,
        why: `The first pass returned the ${candidate.missing.join(' and ')} "${tool.name}" needed, so it can run now.`,
        builtin: null,
        relevance: candidate.relevance,
      });
      done.add(tool.name);
    }
  }

  const search = executed.find((e) => e.tool === 'workspace_search');
  if (search && !done.has('account_profile')) {
    const matches = (search.result as { matches?: { id: string; label: string; type: string; score: number }[] })?.matches ?? [];
    const best = matches.find((m) => ['company', 'contact', 'customer'].includes(m.type)) ?? matches[0];
    if (best && best.score >= 0.5) {
      steps.push(builtin('account_profile', { id: best.id }, `Search resolved "${best.label}"; load the record it points at.`, 0.9));
    }
  }

  const profile = executed.find((e) => e.tool === 'account_profile');
  if (profile && input.intent === 'aggregate' && input.metric && !done.has('business_metric')) {
    const record = profile.result as { id?: string; name?: string };
    if (record?.id) {
      steps.push(builtin('business_metric', {
        metric: input.metric.metric.id,
        start: input.window.start,
        end: input.window.end,
        window_label: input.window.label,
        subject_id: record.id,
        group_by: input.groupBy,
        compare: true,
      }, `Now that ${record.name} is identified, compute ${input.metric.metric.label} for it.`, 0.95));
    }
  }

  if ((input.intent === 'summarise' || input.intent === 'plan') && profile && !done.has('record_timeline')) {
    const record = profile.result as { id?: string; name?: string };
    if (record?.id) steps.push(builtin('record_timeline', { record_id: record.id, limit: 10 }, `Read ${record.name}'s recent history.`, 0.8));
  }

  return steps.slice(0, remaining);
}
