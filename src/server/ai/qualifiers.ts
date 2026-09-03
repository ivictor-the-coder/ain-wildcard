/**
 * The qualifier ledger.
 *
 * A question is rarely "what is our pipeline". It is "what is the *Renewal*
 * pipeline worth", "how many deals are in *Negotiation*", "how much pipeline
 * does *Marcus Ilori* own", "what did we invoice in *August 2026*". Each of
 * those italicised words is a **qualifier**: it narrows the query, and dropping
 * it does not make the answer vaguer — it makes the answer a confident,
 * precise, wrong number about something else.
 *
 * This platform used to guard qualifiers one at a time. Owner got a guard.
 * Period got half of one. Pipeline, stage, status, unit and the rest leaked,
 * because a guard is written per qualifier and a question can carry any of
 * them. Fixing owner did not fix stage; fixing stage would not have fixed
 * pipeline.
 *
 * So there is one invariant instead of N guards. Every qualifier the question
 * names is parsed into this ledger, and before an answer is composed every
 * entry must be in exactly one of three states:
 *
 *   **bound**    — it is literally present in the arguments of a step that ran;
 *   **refused**  — it could not be bound, so the engine says so and answers
 *                  nothing else;
 *   **waived**   — the capability genuinely cannot take it, and the answer says
 *                  which qualifier it ignored in its first sentence.
 *
 * There is no fourth state. `verify()` does not take the planner's word for it:
 * a binding is a claim about a specific argument of a specific step, checked
 * against the plan that actually ran. A capability that forgets to pass a
 * qualifier through leaves an entry `pending`, and a pending entry is a refusal
 * — loudly, rather than an answer to a question nobody asked.
 *
 * One entry kind is settled later than the others, and says so on the entry
 * rather than through a list of exceptions somewhere else: a **unit** is a
 * claim about the *figure*, not about the query — "how many events are left"
 * is answered in events when the number that comes back is a count of events —
 * so `settlesAfterRun` marks it, the plan-time gate skips exactly those
 * entries, and the post-run gate refuses any that the results did not settle.
 * Three states still, one of them decided a step later.
 */
import type { Ctx } from '../kernel/context';
import { billingSources, hasTable } from './grounding';
import { extractMentions, type ResolvedEntity } from './resolve';
import type { PeriodMention, TimeWindow } from './dates';
import type { MetricDetection } from './metrics';
import type { TaskIntent } from './intent';
import { FURNITURE as CLOSED_CLASS } from './coverage';
import { COMMON_WORDS, STOPWORDS, listPhrase, normalise } from './text';

/**
 * Every dimension an answer can be *narrowed* on — the scope of a figure.
 *
 * This union is a published contract: the copilot's scope bar reconciles one
 * rule per member, so a kind added here has to be answerable by that surface
 * before it compiles.
 */
export type QualifierKind =
  | 'pipeline' | 'stage' | 'owner' | 'account' | 'period'
  | 'status' | 'metric' | 'meter' | 'currency' | 'unit' | 'limit';

/**
 * Everything the ledger holds, which is more than the narrowings.
 *
 * An order is not a scope: it does not change which rows are in the set, it
 * decides which end of the set the reader is shown. It is dropped, inverted
 * and substituted exactly like a scope though — "the smallest open deal"
 * answered with the largest, under the word "largest" — so it is settled by
 * the same three states and proved against the same plan.
 */
export type LedgerKind = QualifierKind | 'ranking';

export type QualifierState = 'pending' | 'bound' | 'refused' | 'waived';

/**
 * What a qualifier's surface text resolved to.
 *
 * `kind` is carried on the value as well as on the entry, and the two must
 * match. That is what stops "Marcus Ilori" — an owner — from being answered
 * with a company: a resolution of the wrong type is not a weaker match, it is
 * a different question.
 */
export interface QualifierValue {
  kind: LedgerKind;
  /** The value a query takes. */
  value: string | number;
  /** What a person calls it. */
  label: string;
  /** The CRM property this qualifier filters, when it is a record filter. */
  property?: string;
  /**
   * The object type the property belongs to, when this is a record filter on
   * something other than a deal.
   *
   * A ticket's status and a deal's stage are both `status`-kind qualifiers and
   * they are filters on different tables. The type is what lets the planner
   * see that `business_metric` — which counts the workspace's ticket intake
   * over a window — cannot take "escalated", and reach for the capability that
   * can rather than answering the unfiltered question.
   */
  objectType?: string;
  /**
   * The set of stored values this qualifier stands for, when it is a word
   * rather than a value. "Lost" is not a stage — it is every stage this
   * workspace marks closed-and-not-won — so the binding is checked against the
   * set, not against the word.
   */
  values?: (string | number)[];
  /**
   * What a person calls the dimension this value belongs to.
   *
   * One ledger kind covers every record filter — a ticket status, a deal's
   * competitor, a company's industry — because the invariant is the same for
   * all of them. The sentence a reader gets must not be: "the status
   * 'aerospace'" names the wrong dimension back at them, which reads as a
   * second misunderstanding on top of the first.
   */
  noun?: string;
  /**
   * The records this value picks out, when the filter is on a different table
   * from the one the answer measures.
   */
  ids?: string[];
  /**
   * How the value narrows, when it is not equality.
   *
   * "More than 60 days in Negotiation" is a threshold on a date column, not a
   * value on it. A threshold is still a qualifier — the $500,000 case has
   * always bound as one — so it settles the same way; it just is not a claim
   * that the set the step reads is inside a set of values.
   *
   * `has` is membership in a multi-select column: a company runs Siemens *and*
   * Fanuc, and equality against the cell holding both matched neither.
   */
  op?: 'eq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'has';
}

/**
 * A claim that a qualifier became part of the query.
 *
 * Every field named here is checked against the plan. `args` must be present on
 * the step with these values; `condition` must be one of the step's conditions.
 */
export interface QualifierBinding {
  tool: string;
  args?: Record<string, unknown>;
  condition?: { property: string; value?: string | number; values?: (string | number)[] };
  /** Why this counts as binding the qualifier, for the trace. */
  note?: string;
}

export interface Qualifier {
  kind: LedgerKind;
  /** The words in the question that produced this entry. */
  text: string;
  /** What the text resolved to, or `null` when it named nothing of this kind. */
  resolved: QualifierValue | null;
  state: QualifierState;
  binding: QualifierBinding | null;
  /** Why it was refused, or what the answer ignores. */
  detail: string | null;
  /**
   * The qualifier this one was read out of, when one span names two.
   *
   * "Churned" is the Renewal pipeline's name for `closed_lost`, so those words
   * are a stage *and* a pipeline. That is not the ambiguity `verify` guards
   * against — one name resolving to two unrelated records — it is one scope
   * spelt in one word, and both halves have to reach the query.
   */
  derivedFrom?: LedgerKind;
  /**
   * True when this entry is settled against the figure the run returns rather
   * than against the plan that produces it. The plan-time gate leaves these
   * alone; the post-run gate refuses any still pending.
   */
  settlesAfterRun?: boolean;
  /**
   * True when this qualifier came from an earlier turn rather than from this
   * sentence — the thread's standing scope, carried forward so a follow-up
   * cannot quietly widen back out to the workspace.
   */
  carried?: boolean;
  /**
   * What a person calls the dimension, when the entry resolved to nothing.
   *
   * A refusal has no resolved value to take the noun from, and 'you asked
   * about the status "Siemens"' names the wrong dimension back at the reader
   * on top of not answering them.
   */
  noun?: string;
}

export interface QualifierViolation {
  kind: LedgerKind;
  text: string;
  reason: 'unsettled' | 'type_mismatch' | 'step_missing' | 'argument_missing' | 'value_mismatch'
    | 'waiver_unexplained' | 'unscoped_step';
  detail: string;
}

/** A planned or executed step, as far as the ledger cares. */
export interface StepArgs {
  tool: string;
  args: Record<string, unknown>;
}

/* --------------------------- argument matching ---------------------------- */

const sameScalar = (a: unknown, b: unknown): boolean =>
  a === b || (a !== null && b !== null && a !== undefined && b !== undefined && String(a) === String(b));

interface ConditionShape { property?: unknown; value?: unknown; values?: unknown }

function conditionMatches(held: unknown, want: NonNullable<QualifierBinding['condition']>): boolean {
  if (!held || typeof held !== 'object') return false;
  const row = held as ConditionShape;
  if (String(row.property ?? '') !== want.property) return false;
  if (want.value === undefined && want.values === undefined) return true;
  const values = Array.isArray(row.values) ? row.values : row.value !== undefined ? [row.value] : [];
  if (want.value !== undefined) return values.some((v) => sameScalar(v, want.value));
  return (want.values ?? []).every((v) => values.some((held2) => sameScalar(held2, v)));
}

/** Whether one step really carries what a binding claims it carries. */
export function stepCarries(step: StepArgs, binding: QualifierBinding): QualifierViolation['reason'] | null {
  for (const [name, value] of Object.entries(binding.args ?? {})) {
    if (!(name in step.args)) return 'argument_missing';
    const held = step.args[name];
    if (Array.isArray(value)) {
      if (!Array.isArray(held) || held.length !== value.length || !value.every((v, i) => sameScalar(held[i], v))) return 'value_mismatch';
      continue;
    }
    if (!sameScalar(held, value)) return 'value_mismatch';
  }
  if (binding.condition) {
    const conditions = step.args.conditions;
    if (!Array.isArray(conditions)) return 'argument_missing';
    if (!conditions.some((c) => conditionMatches(c, binding.condition!))) return 'value_mismatch';
  }
  return null;
}

/**
 * Where a qualifier of each kind may legitimately land in a query.
 *
 * This is the auto-settlement table: after the plan is built, an entry is bound
 * when its resolved value is *literally in the arguments* of a step. The
 * planner never has to remember to declare it, which is the whole point — a
 * declaration a planner can forget is exactly the guard that leaked.
 */
const SLOTS: Record<LedgerKind, { args: string[]; conditions: string[] }> = {
  pipeline: { args: ['pipeline'], conditions: ['pipeline'] },
  stage: { args: ['stage'], conditions: ['deal_stage'] },
  owner: { args: ['owner_id', 'owner', 'assignee_id'], conditions: ['owner_id'] },
  account: { args: ['subject_id', 'associated_to', 'id', 'record_id', 'customer', 'customer_id', 'company_id', 'account'], conditions: [] },
  period: { args: [], conditions: [] },
  status: { args: ['status'], conditions: ['status', 'deal_stage', 'deal_status', 'subscription_status'] },
  metric: { args: ['metric'], conditions: [] },
  meter: { args: ['meter', 'meter_id'], conditions: [] },
  currency: { args: ['currency'], conditions: [] },
  unit: { args: [], conditions: [] },
  limit: { args: ['limit', 'top', 'group_limit'], conditions: [] },
  // The direction is the binding. A sort key with no direction beside it is
  // the engine's own default, and "the smallest open deal" answered with the
  // largest one — labelled "largest" — is what a qualifier that never entered
  // the ledger costs.
  ranking: { args: ['direction'], conditions: [] },
};

/**
 * The kinds that narrow *which records* a step reads.
 *
 * A binding of one of these is a claim about a set of rows, and it is a claim
 * about every step of the plan whose rows reach the answer — not about the one
 * step that happened to take the argument. "Summarise the Renewal pipeline"
 * bound `pipeline` to the metric and then printed, underneath it, the five
 * biggest open deals in the workspace: four of the five were not in the Renewal
 * pipeline and the top row was larger than that pipeline's largest deal.
 */
const RECORD_FILTER_KINDS = new Set<LedgerKind>(['pipeline', 'stage', 'status', 'owner', 'account']);

/** The tools whose results are records the answer prints as rows. */
const ROW_TOOLS = new Set(['record_search', 'record_aggregate']);

/** The argument a capability takes for a filter the record tools spell as a condition. */
const ARGUMENT_SLOT: Record<string, string> = { deal_stage: 'stage', pipeline: 'pipeline' };

/** The record filter an entry is, when it is one. */
export function recordFilter(entry: Qualifier): { property: string; objectType: string; values: (string | number)[] } | null {
  if (!entry.resolved || !RECORD_FILTER_KINDS.has(entry.kind)) return null;
  const property = entry.resolved.property;
  if (!property) return null;
  // A threshold narrows the set without naming its members, so "every step
  // that returns these rows must be narrowed *to these values*" is not a claim
  // it can make. It is settled by the argument check like any other entry.
  if (entry.resolved.op && entry.resolved.op !== 'eq' && entry.resolved.op !== 'in') return null;
  return {
    property,
    // A teammate owns records of every type, so an owner filter is a claim
    // about every row step in the plan — `*`. A pipeline and a stage are deal
    // columns and narrow nothing else. Reading the owner as a deal filter meant
    // a rep's ticket list was dropped from her own summary for not being a deal.
    objectType: property === 'owner_id' ? '*' : entry.resolved.objectType ?? 'deal',
    values: entry.resolved.values?.length ? [...entry.resolved.values] : [entry.resolved.value],
  };
}

/**
 * Whether a step is narrowed *to* a filter, rather than merely compatible with it.
 *
 * `conditionMatches` asks whether the value the question named is somewhere in
 * the condition, which a filter listing all eight open stages satisfies for any
 * one of them. That is the difference between "these are the Negotiation deals"
 * and "these are the open deals, and some of them are in Negotiation" — one
 * sentence of which is true. The set the step reads has to be inside the set
 * the question named.
 */
export function stepNarrowsTo(step: StepArgs, filter: { property: string; values: (string | number)[] }): boolean {
  const conditions = Array.isArray(step.args.conditions) ? step.args.conditions : [];
  for (const held of conditions) {
    if (!held || typeof held !== 'object') continue;
    const row = held as ConditionShape;
    if (String(row.property ?? '') !== filter.property) continue;
    const op = String((row as { op?: unknown }).op ?? 'eq');
    if (op !== 'eq' && op !== 'in') continue;
    const values = Array.isArray(row.values) ? row.values : row.value !== undefined ? [row.value] : [];
    if (!values.length) continue;
    if (values.every((value) => filter.values.some((want) => sameScalar(want, value)))) return true;
  }
  // A filter can also be a whole argument — an owner, an account, and the
  // `pipeline` and `stage` arguments a measure takes. One value in the slot is
  // already the narrowest the step can be.
  const slots = [filter.property, ARGUMENT_SLOT[filter.property], 'owner_id', 'associated_to', 'subject_id', 'customer', 'customer_id'];
  for (const name of slots) {
    if (!name) continue;
    const held = step.args[name];
    if (held !== undefined && filter.values.some((want) => sameScalar(want, held))) return true;
  }
  return false;
}

/**
 * Whether a step's result is a list of rows rather than one number.
 *
 * A ranking cut-off is a claim about how many rows come back, so it can only
 * bind to a step that returns rows. `business_metric` accepts a `limit`
 * argument and, with `group_by: "none"`, returns a single scalar whatever it is
 * set to — which is how "List the 5 biggest open deals" reported the cut-off
 * bound to `business_metric` while the answer was the $9,010,960 workspace
 * total, no list and no hedge.
 */
function returnsRows(step: StepArgs): boolean {
  const grouped = step.args.group_by;
  if (typeof grouped === 'string') return grouped !== 'none';
  return !('metric' in step.args);
}

function autoBinding(entry: Qualifier, steps: StepArgs[]): QualifierBinding | null {
  const resolved = entry.resolved;
  if (!resolved) return null;
  const slot = SLOTS[entry.kind];
  for (const step of steps) {
    if ((entry.kind === 'limit' || entry.kind === 'ranking') && !returnsRows(step)) continue;
    for (const name of slot.args) {
      if (!(name in step.args)) continue;
      const held = step.args[name];
      if (Array.isArray(held) ? held.some((v) => sameScalar(v, resolved.value)) : sameScalar(held, resolved.value)) {
        return { tool: step.tool, args: { [name]: held }, note: `${resolved.label} is the \`${name}\` argument of ${step.tool}.` };
      }
    }
    const conditions = step.args.conditions;
    if (!Array.isArray(conditions)) continue;
    // The property the qualifier names comes first: a ticket status is a
    // `status` filter, a contact's buying role a `buying_role` one, and the
    // slot table cannot list every property a workspace defines.
    const properties = resolved.property && !slot.conditions.includes(resolved.property)
      ? [resolved.property, ...slot.conditions]
      : slot.conditions;
    for (const property of properties) {
      for (const want of resolved.values?.length
        ? [{ property, values: resolved.values }, { property, value: resolved.value }]
        : [{ property, value: resolved.value }]) {
        if (conditions.some((c) => conditionMatches(c, want))) {
          return { tool: step.tool, condition: want, note: `${resolved.label} is a \`${property}\` filter on ${step.tool}.` };
        }
      }
    }
  }
  return null;
}

/**
 * A period is bound when a step measures exactly the range the question named —
 * on the column the question named.
 *
 * A step that filters `close_date` does not answer "which deals were created
 * last month", however exactly its range matches, so the range alone is not
 * the binding: the column is part of the claim.
 */
function periodBinding(window: TimeWindow, steps: StepArgs[], property: string | null): QualifierBinding | null {
  for (const step of steps) {
    const start = Number(step.args.start);
    const end = Number(step.args.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start !== window.start || end !== window.end) continue;
    const column = 'date_property' in step.args ? String(step.args.date_property) : null;
    if (property && column && column !== property) continue;
    return {
      tool: step.tool,
      args: { start, end, ...(column ? { date_property: column } : {}) },
      note: `${window.label} is the measured range of ${step.tool}${column ? ` on \`${column}\`` : ''}.`,
    };
  }
  return null;
}

/* ------------------------------- the ledger ------------------------------- */

const article = (noun: string): string => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;

/** What a person calls each kind of qualifier, for a sentence rather than a field name. */
const KIND_NOUN: Record<LedgerKind, string> = {
  pipeline: 'pipeline', stage: 'deal stage', owner: 'teammate', account: 'account', period: 'period',
  status: 'status', metric: 'measure', meter: 'meter', currency: 'currency', unit: 'unit', limit: 'ranking cut-off',
  ranking: 'ranking order',
};

export class QualifierLedger {
  private readonly items: Qualifier[];

  constructor(items: Qualifier[] = []) {
    this.items = items;
  }

  get entries(): readonly Qualifier[] { return this.items; }

  add(entry: Qualifier): void { this.items.push(entry); }

  all(kind: LedgerKind): Qualifier[] { return this.items.filter((q) => q.kind === kind); }

  first(kind: LedgerKind): Qualifier | undefined { return this.items.find((q) => q.kind === kind); }

  /** The resolved value for a kind, or null when the question named none. */
  value(kind: LedgerKind): string | number | null {
    return this.first(kind)?.resolved?.value ?? null;
  }

  label(kind: LedgerKind): string | null {
    return this.first(kind)?.resolved?.label ?? null;
  }

  /** Declare that a qualifier became part of a query. Checked in `verify`. */
  bind(kind: LedgerKind, binding: QualifierBinding): void {
    const entry = this.items.find((q) => q.kind === kind && q.state === 'pending');
    if (!entry) return;
    entry.state = 'bound';
    entry.binding = binding;
  }

  /**
   * Take a binding back.
   *
   * A qualifier is bound when it reached a query that *ran*. A step that
   * errored ran nothing, so a binding to it is a claim the answer cannot stand
   * on — and the answer under it was "nothing I hold answers that", with the
   * capability's own explanation of why left in the trace.
   */
  unbind(entry: Qualifier, why: string): void {
    if (entry.state !== 'bound') return;
    entry.state = 'refused';
    entry.binding = null;
    entry.detail = why;
  }

  /**
   * Declare that *this* entry became part of a query.
   *
   * `bind(kind, …)` settles the first pending entry of a kind, which is right
   * when a kind holds one entry and wrong the moment it holds several — a
   * question naming a competitor and an industry would have had the industry's
   * binding recorded against the competitor.
   */
  bindEntry(entry: Qualifier, binding: QualifierBinding): void {
    if (entry.state !== 'pending') return;
    entry.state = 'bound';
    entry.binding = binding;
  }

  /** Settle one entry by hand, when a rule applies to that entry and not its kind. */
  mark(entry: Qualifier, state: Exclude<QualifierState, 'pending'>, detail: string): void {
    if (entry.state !== 'pending') return;
    entry.state = state;
    entry.detail = detail;
  }

  /** The engine could not scope the query to this qualifier, so it answers nothing. */
  refuse(kind: LedgerKind, why: string): void {
    for (const entry of this.items) {
      if (entry.kind !== kind || entry.state !== 'pending') continue;
      entry.state = 'refused';
      entry.detail = why;
    }
  }

  /** The capability genuinely cannot take it — the answer must say so up front. */
  waive(kind: LedgerKind, why: string): void {
    for (const entry of this.items) {
      if (entry.kind !== kind || entry.state !== 'pending') continue;
      entry.state = 'waived';
      entry.detail = why;
    }
  }

  pending(): Qualifier[] { return this.items.filter((q) => q.state === 'pending'); }
  refused(): Qualifier[] { return this.items.filter((q) => q.state === 'refused'); }
  waived(): Qualifier[] { return this.items.filter((q) => q.state === 'waived'); }
  bound(): Qualifier[] { return this.items.filter((q) => q.state === 'bound'); }

  /**
   * Bind every entry the plan actually carries.
   *
   * Called with the steps that will run (and again with the steps that did),
   * so a binding is a fact about the query rather than a promise from whoever
   * wrote the branch.
   */
  settleAgainst(steps: StepArgs[], windows: TimeWindow[] = []): void {
    for (const entry of this.items) {
      if (entry.state !== 'pending' || !entry.resolved) continue;
      if (entry.kind === 'period') {
        // The entry holds the window's label, so the right window is found by
        // identity rather than by re-matching the surface text — which paired
        // both periods of a comparison with the first one and refused the
        // second as unbound.
        const window = windows.find((w) => w.label === entry.resolved!.value);
        const binding = window ? periodBinding(window, steps, entry.resolved.property ?? null) : null;
        if (binding) { entry.state = 'bound'; entry.binding = binding; }
        continue;
      }
      if (entry.kind === 'ranking') {
        // Both halves or neither. A step sorted by the key the question named,
        // in the direction it named, is the only thing that binds an order —
        // and "the 3 deals closing soonest" answered by the 8 largest carried
        // neither half while reporting the question as understood.
        const want = entry.resolved.property ?? null;
        const step = steps.find((candidate) => {
          if (!returnsRows(candidate) || !sameScalar(candidate.args.direction, entry.resolved!.value)) return false;
          // A grouped measure is ranked by the measure itself, so "the least"
          // is the whole instruction and there is no sort key to match. A date
          // order is not something a measure can be ranked by, and claiming it
          // was would be the substitution wearing a direction.
          if ('metric' in candidate.args) return !want || want === 'amount';
          return !want || sameScalar(candidate.args.order_by, want);
        });
        if (step) {
          entry.state = 'bound';
          entry.binding = {
            tool: step.tool,
            args: {
              direction: entry.resolved.value,
              ...(want && 'order_by' in step.args ? { order_by: want } : {}),
            },
            note: `${entry.resolved.label} is the order ${step.tool} ran in.`,
          };
        }
        continue;
      }
      const binding = autoBinding(entry, steps);
      if (binding) { entry.state = 'bound'; entry.binding = binding; }
    }
  }

  /**
   * Check every settled entry against the plan.
   *
   * A `bound` entry whose step is not in the plan, or whose argument does not
   * carry the value, is a violation — the engine claimed a scope it did not
   * apply. A `pending` entry is a violation too: it is the silent drop this
   * whole file exists to make impossible.
   */
  verify(steps: StepArgs[]): QualifierViolation[] {
    const out: QualifierViolation[] = [];
    // One name, one kind. "Marcus" is Marcus Ilori the teammate and Marcus
    // Barnes a contact at Whitcombe Aerospace, and a plan that bound the span
    // as both computed the rep's pipeline and then took the answer's subject
    // from the contact's employer — $315,900 about Whitcombe under a sentence
    // naming Marcus, with the ledger reporting both bindings as good.
    const byText = new Map<string, Qualifier>();
    for (const entry of this.items) {
      if (!entry.resolved || entry.state !== 'bound' || entry.derivedFrom) continue;
      const key = normalise(entry.text);
      const held = byText.get(key);
      if (held && held.kind !== entry.kind && held.resolved) {
        out.push({
          kind: entry.kind,
          text: entry.text,
          reason: 'type_mismatch',
          detail: `"${entry.text}" names two different records here — ${held.resolved.label} (${article(KIND_NOUN[held.kind])}) and ${entry.resolved.label} (${article(KIND_NOUN[entry.kind])}).`,
        });
      }
      byText.set(key, entry);
    }
    for (const entry of this.items) {
      if (entry.resolved && entry.resolved.kind !== entry.kind) {
        out.push({
          kind: entry.kind, text: entry.text, reason: 'type_mismatch',
          detail: `"${entry.text}" is a ${entry.kind} in this question and resolved to a ${entry.resolved.kind}.`,
        });
        continue;
      }
      if (entry.state === 'pending') {
        // An entry settled against the figure is pending on purpose until the
        // run returns; the post-run gate refuses it if nothing settled it.
        if (entry.settlesAfterRun) continue;
        out.push({
          kind: entry.kind, text: entry.text, reason: 'unsettled',
          detail: `"${entry.text}" is a ${entry.kind} qualifier that reached the answer neither bound, refused nor waived.`,
        });
        continue;
      }
      if (entry.state === 'waived' && !entry.detail) {
        out.push({
          kind: entry.kind, text: entry.text, reason: 'waiver_unexplained',
          detail: `"${entry.text}" was waived without saying why, which is a silent drop wearing a different word.`,
        });
        continue;
      }
      if (entry.state !== 'bound' || !entry.binding) continue;
      // A comparison runs the same capability twice over two periods, so the
      // question is whether *some* step of that tool carries the binding — not
      // whether the first one does, which refused the second period of every
      // comparison as unbound.
      const matching = steps.filter((s) => s.tool === entry.binding!.tool);
      if (!matching.length) {
        out.push({
          kind: entry.kind, text: entry.text, reason: 'step_missing',
          detail: `"${entry.text}" claims to be bound to ${entry.binding.tool}, which is not in the plan that ran.`,
        });
        continue;
      }
      const failures = matching.map((step) => stepCarries(step, entry.binding!));
      if (failures.every((failure) => failure !== null)) {
        out.push({
          kind: entry.kind, text: entry.text, reason: failures[0]!,
          detail: `"${entry.text}" claims to be bound to ${entry.binding.tool}, whose arguments do not carry it.`,
        });
      }
    }
    // A binding is a property of the plan, not of one step in it. Every step
    // that returns rows of the type a filter narrows has to be narrowed by it,
    // or its rows are a different question's answer printed under this one's
    // sentence — which is exactly how a Renewal-scoped summary came to list
    // four deals from two other pipelines.
    for (const entry of this.items) {
      if (entry.state !== 'bound') continue;
      const filter = recordFilter(entry);
      if (!filter) continue;
      // A comparison runs the same capability once per name, and each run is
      // narrowed to a different one. "Every row step must carry this filter"
      // is true of a scope and false of a comparison: it refused "compare open
      // pipeline for Dana Whitfield and Priya Raman" for measuring Priya on
      // the step that measures Priya. A step narrowed to a *sibling* of this
      // filter — another entry on the same column — is answering the same
      // question's other half, not a wider one.
      const siblings = this.items
        .filter((other) => other !== entry && other.state === 'bound')
        .map((other) => recordFilter(other))
        .filter((other): other is NonNullable<typeof other> => !!other && other.property === filter.property);
      for (const step of steps) {
        if (!ROW_TOOLS.has(step.tool)) continue;
        if (filter.objectType !== '*' && String(step.args.object_type ?? '') !== filter.objectType) continue;
        if (stepNarrowsTo(step, filter)) continue;
        if (siblings.some((other) => stepNarrowsTo(step, other))) continue;
        out.push({
          kind: entry.kind, text: entry.text, reason: 'unscoped_step',
          detail: `${step.tool} reads ${filter.objectType} records without "${entry.text}" on it, so the rows it returns are not the ones you asked about.`,
        });
      }
    }
    return out;
  }

  /** One line per entry, for the reasoning trace. */
  describe(): string {
    if (!this.items.length) return 'Qualifier ledger: the question names none.';
    return `Qualifier ledger: ${this.items.map((q) =>
      `${q.kind} "${q.text}" → ${q.state}${q.resolved ? ` (${q.resolved.label})` : ''}`).join('; ')}.`;
  }
}

/* ------------------------------- vocabulary ------------------------------- */

export interface PipelineTerm { value: string; label: string }

/**
 * One of the names this workspace gives a stage, and where it uses it.
 *
 * A stage *value* can carry a different label in every pipeline: `discovery` is
 * "Discovery" in New business and "Scoping" in Expansion; `closed_lost` is
 * "Closed lost" everywhere except Renewal, where it is "Churned". Keeping one
 * label per value threw the others away, and a question that wrote one of them
 * was refused with a sentence denying this workspace has a stage it plainly
 * has — or, with the word "stage" left out, answered with the whole open book.
 */
export interface StageAlias { label: string; pipelines: string[] }

export interface StageTerm {
  value: string;
  /** The name to read the stage back by when nothing narrows it to one pipeline. */
  label: string;
  /** Every name this workspace gives it, with the pipelines that use each. */
  aliases: StageAlias[];
  pipelines: string[];
  closed: boolean;
  won: boolean;
}

/** Every distinct name this workspace has for any stage. */
export const stageLabels = (vocabulary: QualifierVocabulary): string[] => {
  const out: string[] = [];
  for (const stage of vocabulary.stages) {
    for (const alias of stage.aliases) if (!out.includes(alias.label)) out.push(alias.label);
  }
  return out;
};

/** The name a stage goes by inside one pipeline, or its general name. */
export function stageLabelIn(vocabulary: QualifierVocabulary, value: string, pipeline?: string | null): string | null {
  const stage = vocabulary.stages.find((st) => st.value === value);
  if (!stage) return null;
  if (pipeline) {
    const scoped = stage.aliases.find((alias) => alias.pipelines.includes(pipeline));
    if (scoped) return scoped.label;
  }
  return stage.label;
}

export interface QualifierVocabulary {
  pipelines: PipelineTerm[];
  stages: StageTerm[];
}

const vocabularyCache = new Map<string, { stamp: number; vocabulary: QualifierVocabulary }>();

/**
 * The pipelines and stages this workspace actually has.
 *
 * Read from the CRM's own tables rather than from a list in this file, so a
 * workspace that renames "Negotiation" to "Red lines" is answered about red
 * lines and a workspace that has no renewal pipeline refuses the question
 * instead of quietly widening it.
 */
export function crmVocabulary(ctx: Ctx, orgId: string): QualifierVocabulary {
  const key = `${orgId}`;
  const stamp = hasTable(ctx.db, 'crm_pipeline_stages')
    ? Number(ctx.db.pluck<number>(`SELECT MAX(updated) FROM crm_pipeline_stages WHERE org_id = ?`, orgId) ?? 0)
    : 0;
  const cached = vocabularyCache.get(key);
  if (cached && cached.stamp === stamp) return cached.vocabulary;

  const pipelines: PipelineTerm[] = hasTable(ctx.db, 'crm_pipelines')
    ? ctx.db.all<{ name: string; label: string }>(
      `SELECT name, label FROM crm_pipelines WHERE org_id = ? AND object_type = 'deal' AND archived = 0 ORDER BY position`, orgId)
      .map((row) => ({ value: row.name, label: row.label }))
    : [];

  const stageRows = hasTable(ctx.db, 'crm_pipeline_stages')
    ? ctx.db.all<{ name: string; label: string; pipeline: string; is_closed: number; is_won: number }>(
      `SELECT name, label, pipeline, is_closed, is_won FROM crm_pipeline_stages
       WHERE org_id = ? AND object_type = 'deal' ORDER BY pipeline, position`, orgId)
    : [];
  const byValue = new Map<string, StageTerm>();
  for (const row of stageRows) {
    const held = byValue.get(row.name);
    if (held) {
      if (!held.pipelines.includes(row.pipeline)) held.pipelines.push(row.pipeline);
      // Two pipelines can label one stage value differently, and both names are
      // this workspace's own. They are all kept: dropping the loser is what
      // denied "Scoping", "Churned" and "Renewed" as stages nobody here has.
      const alias = held.aliases.find((a) => normalise(a.label) === normalise(row.label));
      if (alias) { if (!alias.pipelines.includes(row.pipeline)) alias.pipelines.push(row.pipeline); }
      else held.aliases.push({ label: row.label, pipelines: [row.pipeline] });
      continue;
    }
    byValue.set(row.name, {
      value: row.name, label: row.label, aliases: [{ label: row.label, pipelines: [row.pipeline] }],
      pipelines: [row.pipeline], closed: row.is_closed === 1, won: row.is_won === 1,
    });
  }
  // The general name is the one that reads as the stage itself rather than as
  // one pipeline's word for it — the label that matches the stored value. With
  // the longest label instead, "how many deals are in the Qualification stage"
  // was answered "6 deals at the Expansion identified stage", naming a label
  // that covers two of the six.
  for (const stage of byValue.values()) {
    const general = stage.aliases.find((alias) => normalise(alias.label) === normalise(stage.value.replace(/_/g, ' ')));
    stage.label = general?.label
      ?? [...stage.aliases].sort((a, b) => b.label.length - a.label.length)[0].label;
  }
  const vocabulary = { pipelines, stages: [...byValue.values()] };
  vocabularyCache.set(key, { stamp, vocabulary });
  return vocabulary;
}

/**
 * The currency books this workspace actually keeps.
 *
 * "How much did we invoice in JPY in 2026?" was answered "no invoiced recorded
 * for 2026 … scoped to the JPY book, which is the currency you named" — which
 * reads as "we invoiced nothing in yen" rather than "we have no yen book at
 * all". An unknown pipeline, stage, owner, account and metric are each refused
 * with the real vocabulary listed; a currency is the same kind of word.
 */
export function currencyBooks(ctx: Ctx, orgId: string): string[] {
  const books = new Set<string>();
  const sources = billingSources(ctx.db);
  const invoices = sources.invoices;
  if (invoices?.currencyColumn) {
    for (const row of ctx.db.all<{ currency: string | null }>(
      `SELECT DISTINCT ${invoices.currencyColumn} AS currency FROM ${invoices.table} WHERE org_id = ? ORDER BY 1`, orgId)) {
      const code = normalise(row.currency ?? '');
      if (code) books.add(code);
    }
  }
  return [...books];
}

/**
 * The units this workspace denominates things in.
 *
 * Read from the meters and the credit grants themselves, so "how many
 * telemetry events does Meridian have left" is answered in events because
 * `event` is what the grant is written in — not because this file has a list
 * of unit words in it.
 */
export function unitVocabulary(ctx: Ctx, orgId: string): string[] {
  const units = new Set<string>();
  for (const [table, column] of [['meters', 'unit_label'], ['credit_grants', 'unit_label']] as const) {
    if (!hasTable(ctx.db, table)) continue;
    for (const row of ctx.db.all<{ unit: string | null }>(
      // Ordered, because the order decides which unit a question that names
      // two is read as, and an unordered read answered the same sentence with
      // a figure on one run and a refusal on the next.
      `SELECT DISTINCT ${column} AS unit FROM ${table} WHERE org_id = ? AND ${column} IS NOT NULL AND ${column} <> '' ORDER BY ${column}`, orgId)) {
      const unit = normalise(row.unit ?? '');
      if (unit) units.add(unit);
    }
  }
  return [...units];
}

/**
 * The units a customer's credit pots are written in, spent or not.
 *
 * An exhausted grant still denominates the pot: Ironwood's event prepay is
 * spent and expired, and "what is their remaining event credit" has the answer
 * "nothing left", not "nothing this run measured is denominated in events".
 * The balance capability returns no row for an empty pot, so the denomination
 * is read from the grant that made it.
 */
export function creditUnitsFor(ctx: Ctx, orgId: string, customerIds: string[]): string[] {
  if (!customerIds.length || !hasTable(ctx.db, 'credit_grants')) return [];
  const holes = customerIds.map(() => '?').join(',');
  const rows = ctx.db.all<{ unit: string | null }>(
    `SELECT DISTINCT unit_label AS unit FROM credit_grants
     WHERE org_id = ? AND customer_id IN (${holes}) AND unit_label IS NOT NULL AND unit_label <> ''`,
    orgId, ...customerIds);
  return rows.map((row) => normalise(row.unit ?? '')).filter(Boolean);
}

/**
 * A question whose answer is a quantity, so the unit it names is binding.
 *
 * "How many telemetry events does Meridian have left" has to answer in events.
 * "How much would 50 million telemetry events cost" names the same unit and
 * asks for money — enforcing the unit there would refuse a question the engine
 * answers exactly, which is its own wrong answer.
 */
const QUANTITY_QUESTION = /\bhow\s+many\b|\b(left|remaining|remain|unused|drawn\s+down)\b/i;
const PRICE_OR_MONEY = /\b(cost|costs|costing|price|priced|pricing|charge|charged|quote|worth|spend|spent|revenue|invoiced|bill(?:ed)?|limit|cap)\b/i;

/**
 * Every unit a question asks its answer to be denominated in, in the order it
 * names them.
 *
 * "How many GB of telemetry events did we meter" names two units this
 * workspace uses, and reading whichever one the database happened to return
 * first answered it with an event count on one run and refused it on the next.
 * Both enter the ledger: the one the figure is actually in binds, and the one
 * nothing measured is refused by name.
 */
export function unitsNamed(question: string, units: string[]): string[] {
  if (!QUANTITY_QUESTION.test(question) || PRICE_OR_MONEY.test(question)) return [];
  const text = ` ${normalise(question)} `;
  const found: { unit: string; at: number }[] = [];
  for (const unit of units) {
    const at = phraseAt(text, unit) ? text.indexOf(` ${unit} `)
      : phraseAt(text, `${unit}s`) ? text.indexOf(` ${unit}s `)
      : -1;
    if (at >= 0) found.push({ unit, at });
  }
  return found.sort((a, b) => a.at - b.at).map((row) => row.unit);
}

/** The first unit a question names, for the callers that hold one. */
export function unitIn(question: string, units: string[]): string | null {
  return unitsNamed(question, units)[0] ?? null;
}

/** Every unit label anywhere in a result payload, however deeply nested. */
function unitsIn(node: unknown, depth = 0): string[] {
  if (!node || typeof node !== 'object' || depth > 5) return [];
  if (Array.isArray(node)) return node.slice(0, 40).flatMap((item) => unitsIn(item, depth + 1));
  const out: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'string' && /^(unit_label|unit|units|denomination)$/.test(key)) out.push(normalise(value));
    else out.push(...unitsIn(value, depth + 1));
  }
  return out;
}

/**
 * A unit qualifier binds against the figure, not against the query.
 *
 * "How many telemetry events does Meridian have left" is bound when the answer
 * has an event count in it. A currency amount and a unit count are different
 * types — `$0.00 available` under a live 9,131-event pot is not a rounding
 * problem, it is the wrong quantity — so this settles after the tools ran, on
 * what they actually returned.
 */
export function settleUnitAgainstResults(
  ledger: QualifierLedger,
  results: { tool: string; result: unknown }[],
  denominations: string[] = [],
): void {
  for (const entry of ledger.pending().filter((q) => q.kind === 'unit')) settleOneUnit(entry, results, denominations);
}

function settleOneUnit(
  entry: Qualifier,
  results: { tool: string; result: unknown }[],
  denominations: string[],
): void {
  if (!entry.resolved) return;
  const want = normalise(String(entry.resolved.value));
  for (const { tool, result } of results) {
    if (unitsIn(result).includes(want)) {
      entry.state = 'bound';
      entry.binding = { tool, note: `${entry.resolved.label} is the denomination of what ${tool} returned.` };
      return;
    }
  }
  // An empty pot is still an answer to a question about what is left — whether
  // this account's event prepay is spent or it never held one. Refusing the
  // second told a reader "nothing this run measured is denominated in events"
  // and then offered the workspace total, while the identical empty ledger one
  // account over answered "holds no spendable credit right now". Two spellings
  // of the same zero, one of them a refusal with a false claim in it.
  for (const { tool, result } of results) {
    if (!result || typeof result !== 'object') continue;
    const balance = result as { object?: unknown; balances?: unknown[]; scheduled?: unknown[] };
    if (balance.object !== 'credit_balance') continue;
    const held = (balance.balances?.length ?? 0) + (balance.scheduled?.length ?? 0);
    // Credit in other units is a real mismatch and stays a refusal: an account
    // holding a euro pot has not answered a question about events.
    if (held && !denominations.includes(want)) continue;
    entry.state = 'bound';
    entry.binding = {
      tool,
      note: held
        ? `The credit ${entry.resolved.label} pot ${tool} read is denominated in ${entry.resolved.label}s; it is empty.`
        : `${tool} read this account's credit ledger and it holds no grant at all — in ${entry.resolved.label}s or anything else — so the answer is none.`,
    };
    return;
  }
}

/**
 * The date the question is about.
 *
 * "Which deals were created last month?" and "which deals close next month?"
 * name the same period and two different columns. Binding both to `close_date`
 * answered the first with four deals that *close* in August — and reported the
 * period qualifier bound, so nothing in the reply told the reader it was about
 * a different field. The noun the question wrote picks the column; with no noun
 * the close date is the default a deal question means.
 */
const DATE_NOUNS: { pattern: RegExp; property: string; label: string }[] = [
  { pattern: /\b(created|opened|added|logged|raised|entered)\b/i, property: 'created', label: 'created' },
  { pattern: /\b(updated|changed|modified|last\s+touched|touched)\b/i, property: 'updated', label: 'last updated' },
  { pattern: /\b(clos(?:e|es|ed|ing)|due|expiring|expires?|renew(?:s|ing|al\s+date)?)\b/i, property: 'close_date', label: 'close date' },
];

/**
 * A period somewhere in the sentence, which is what makes a closing word point
 * at a column rather than describe a state.
 */
const PERIOD_MARKER =
  /\b(last|next|this|past|coming|previous|prior|since|before|after|during|between|within|q[1-4]|h[12]|fy|day|days|week|weeks|month|months|quarter|quarters|year|years|ytd|mtd|qtd|today|yesterday|tomorrow|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|20\d\d)\b/i;

/** The closing words that are also a lifecycle state when no period is named. */
const BARE_STATE = /^(closed|close|closes|closing|due|expired?)$/i;

export function dateNounIn(question: string): { property: string; label: string; text: string } | null {
  for (const noun of DATE_NOUNS) {
    const hit = question.match(noun.pattern);
    if (!hit) continue;
    // "How many deals are closed?" names no period, so "closed" is the state the
    // deal is in, not the column it would be measured on. Reading it as the
    // column let the close-date claim spend the reader's "closed", so the
    // question read as fully accounted and answered "38 open deals right now" —
    // the opposite of what was asked, with nothing left to refuse on. With a
    // period present ("closed won last quarter") the column is exactly right.
    if (noun.property === 'close_date' && BARE_STATE.test(hit[0]) && !PERIOD_MARKER.test(question)) continue;
    return { property: noun.property, label: noun.label, text: hit[0] };
  }
  return null;
}

/**
 * A question about what is *left* is a question about a balance.
 *
 * "How many telemetry events does Meridian have left?" names a meter, and the
 * meter is what the sentence measures in — not what it asks about. Reading the
 * meter as the subject answered it with 34,015,724 events consumed under a
 * question whose true answer was a 9,131-event pot, three orders of magnitude
 * apart and stated with no hedge. Consumption cannot settle a balance question
 * at all, whichever nouns the sentence borrows to ask it.
 */
const BALANCE_PREDICATE = /\b(left|remaining|remain|remains|unused|drawn\s+down|still\s+(?:has|have|got)|balance)\b/i;
const CONSUMPTION_PREDICATE = /\b(metered?|metering|consumed|consumption|ingested|used|sent|streamed|burned?|burnt)\b/i;

export function isBalanceQuestion(question: string, types: string[]): boolean {
  if (!BALANCE_PREDICATE.test(question)) return false;
  if (!types.includes('usage') && !types.includes('credit') && !types.includes('entitlement')) return false;
  // "How many events did they burn through of what is left" asks both; the
  // consumption verb is the explicit one, so it wins.
  return !CONSUMPTION_PREDICATE.test(question);
}

/* --------------------------------- parsing -------------------------------- */

/** Match a term as a whole phrase, so "renewal" never matches inside "renewals". */
function phraseAt(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const at = haystack.indexOf(needle);
  if (at < 0) return false;
  const before = at === 0 ? ' ' : haystack[at - 1];
  const after = at + needle.length >= haystack.length ? ' ' : haystack[at + needle.length];
  return before === ' ' && after === ' ';
}

/**
 * The pipeline a question names.
 *
 * Only ever next to the word "pipeline": bare "renewal" is a deal type, a
 * subscription event and half the sentences a revenue team writes, while "the
 * Renewal pipeline" is unambiguous. "Weighted pipeline" and "open pipeline"
 * name a measure, not a pipeline, and no pipeline in this workspace is called
 * either, so the vocabulary itself keeps them out.
 */
export interface PipelineMatch { term: PipelineTerm; text: string }

/**
 * Every pipeline a question names, in the order it names them.
 *
 * One entry per mention, not per kind: "what is the Renewal pipeline worth in
 * the Expansion pipeline" used to answer $3,162,060 for Expansion with Renewal
 * never entering the ledger at all — a precise figure for one half of a
 * question, under a sentence that asked for both. A capability that can only
 * take one narrows to the first and refuses the rest by name.
 */
export function pipelinesIn(question: string, vocabulary: QualifierVocabulary): PipelineMatch[] {
  const text = ` ${normalise(question)} `;
  const stageWords = new Set(vocabulary.stages.flatMap((st) =>
    [...st.aliases.map((alias) => normalise(alias.label)), normalise(st.value.replace(/_/g, ' '))]));
  const found: { term: PipelineTerm; text: string; at: number; length: number }[] = [];
  for (const term of vocabulary.pipelines) {
    let best: { term: PipelineTerm; text: string; at: number; length: number } | null = null;
    for (const alias of new Set([term.label, term.value.replace(/_/g, ' ')])) {
      const needle = normalise(alias);
      if (!needle) continue;
      // A pipeline is named next to the word ("the Renewal pipeline"), through
      // it ("the pipeline for new business"), or without it at all ("how many
      // deals are in Expansion"). Those three phrasings are a union, never a
      // choice. Choosing between them on whether the sentence contains the
      // token "pipeline" broke on the measure's own name: "how much open
      // pipeline is in Expansion?" carries the token twice, so only the
      // adjacent forms were tried, "in expansion" was never looked for, and
      // the workspace total was stated as the answer to a scoped question.
      const phrases = [
        `${needle} pipeline`, `pipeline ${needle}`, `pipeline for ${needle}`, `pipeline for the ${needle}`,
        `pipeline in ${needle}`, `pipeline in the ${needle}`, `${needle} pipelines`, `${needle} book`,
        // A bare label counts only in an explicit scope position, and only for
        // a label that names nothing else here: "in Negotiation" is a stage
        // everywhere, and reading it as a pipeline is its own wrong answer.
        ...(stageWords.has(needle)
          ? []
          : [`in ${needle}`, `in the ${needle}`, `for ${needle}`, `for the ${needle}`, `${needle} deals`]),
      ];
      for (const phrase of phrases) {
        if (!phraseAt(text, phrase)) continue;
        const at = text.indexOf(phrase);
        if (!best || needle.length > best.length) best = { term, text: alias, at, length: needle.length };
      }
    }
    if (best) found.push(best);
  }
  return found.sort((a, b) => a.at - b.at).map(({ term, text: matched }) => ({ term, text: matched }));
}

/** The pipeline a question names first, for the callers that can hold one. */
export function pipelineIn(question: string, vocabulary: QualifierVocabulary): PipelineMatch | null {
  return pipelinesIn(question, vocabulary)[0] ?? null;
}

/**
 * The words a pipeline qualifier consumed, so a measure is not read out of them.
 *
 * "How much did we book in the New business pipeline?" contains the token
 * "pipeline" twice over: once as the reader's scope and once, accidentally, as
 * the name of a measure. Scoring the measure over the whole sentence answered a
 * bookings question with $4.4M of open pipeline and called the metric bound.
 */
export function withoutPipelinePhrase(question: string, alias: string): string {
  const needle = alias.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return question
    .replace(new RegExp(`\\b(?:the\\s+)?${needle}\\s+pipelines?\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\bpipelines?\\s+(?:for|in)\\s+(?:the\\s+)?${needle}\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\bpipelines?\\s+${needle}\\b`, 'gi'), ' ');
}

/**
 * A stage name written into the question.
 *
 * The label wins over the machine name, and the longest matching label wins
 * over a shorter one, so "Proposal sent" is that stage rather than a proposal
 * document and "Technical validation" is that stage rather than the word
 * "technical".
 */
export interface StageMatch {
  term: StageTerm;
  /** The words the question wrote. */
  text: string;
  /** The label those words are, read back in the workspace's own spelling. */
  label: string;
  /**
   * The pipelines that call the stage by the name the question wrote — empty
   * when those words were the stage's stored value, which belongs to all of
   * them. "Churned" is the Renewal pipeline's word for `closed_lost`, and
   * answering it with every closed-lost deal in the workspace is a different
   * question, three pipelines wide.
   */
  aliasPipelines: string[];
}

/**
 * Every stage a question names, in the order it names them.
 *
 * "How many deals are in Negotiation and Proposal sent?" is two stages and 18
 * deals; it used to answer "10 deals at the Proposal sent stage" with the
 * other eight — and the other stage name — nowhere in the run.
 */
export function stagesIn(question: string, vocabulary: QualifierVocabulary): StageMatch[] {
  const text = ` ${normalise(question)} `;
  const found: { match: StageMatch; at: number; length: number }[] = [];
  for (const term of vocabulary.stages) {
    const stored = term.value.replace(/_/g, ' ');
    const candidates: { alias: string; label: string; pipelines: string[] }[] = [
      // The stored name is every pipeline's — "negotiation" is the stage, not
      // one book's word for it — so a question that writes it scopes nothing.
      // It is tried first so that a label spelt the same way as the stored
      // value ("Qualification") keeps the general reading, and only a name one
      // pipeline alone uses ("Scoping", "Churned") narrows the question.
      { alias: stored, label: term.label, pipelines: [] },
      ...term.aliases.map((alias) => ({ alias: alias.label, label: alias.label, pipelines: alias.pipelines })),
    ];
    let best: { match: StageMatch; at: number; length: number } | null = null;
    for (const candidate of candidates) {
      const needle = normalise(candidate.alias);
      if (needle.length < 4 || !phraseAt(text, needle)) continue;
      if (best && needle.length <= best.length) continue;
      best = {
        match: { term, text: candidate.alias, label: candidate.label, aliasPipelines: candidate.pipelines },
        at: text.indexOf(needle),
        length: needle.length,
      };
    }
    if (best) found.push(best);
  }
  // A stage name written inside another stage's name is one mention, not two.
  const spans = found.sort((a, b) => b.length - a.length);
  const kept: typeof spans = [];
  for (const span of spans) {
    if (kept.some((held) => span.at >= held.at && span.at + span.length <= held.at + held.length)) continue;
    kept.push(span);
  }
  return kept.sort((a, b) => a.at - b.at).map((span) => span.match);
}

export function stageIn(question: string, vocabulary: QualifierVocabulary): StageMatch | null {
  // The longest match, which is how a label that contains a shorter one wins.
  return [...stagesIn(question, vocabulary)]
    .sort((a, b) => normalise(b.text).length - normalise(a.text).length)[0] ?? null;
}

/**
 * A stage-shaped phrase that this workspace has no stage for.
 *
 * "Which deals are in Technical validation?" was refused with a sentence
 * denying the stage existed, while the same answer printed it. The inverse —
 * a phrase that looks like a stage and matches nothing — must refuse, not fall
 * through to the unfiltered list.
 */
// Deliberately narrow: the reader has to have written the word "stage". An
// earlier version accepted anything after "in" or "at" and refused "carried on
// one line" and "at risk of churning" as unknown stages — a refusal is only
// better than a wrong answer when the question really did name a stage.
const STAGE_SHAPED = /\b(?:in|at|to|reached|sitting\s+in|stuck\s+in)\s+(?:the\s+)?["“']?([A-Za-z][A-Za-z &]{3,30}?)["”']?\s+stage\b|\bstages?\s+["“']([^"“”']{3,40})["”']/;

export function stageShapedPhrase(question: string): string | null {
  const hit = question.match(STAGE_SHAPED);
  const phrase = (hit?.[1] ?? hit?.[2] ?? '').trim();
  return phrase.length >= 4 ? phrase : null;
}

/* ---------------------- names the question writes down --------------------- */

/**
 * Where in the sentence a proper noun sits, which is what decides its slot.
 *
 * "Owned by Jordan Fairweather" names an owner; "what is Bayside Logistics
 * carrying" names an account. The distinction matters because a name that
 * resolves to nothing has to be refused *as the thing it was written as* — the
 * reader who typed a rep's name needs the list of reps, not the list of
 * accounts — and because a name that is both a teammate and a contact is only
 * ambiguous when the sentence does not say which.
 */
export type SubjectPosition = 'owner' | 'owner_or_account' | 'account';

export interface NamedSubject {
  /** The proper-noun span exactly as the question wrote it. */
  text: string;
  position: SubjectPosition;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A name's comparable form.
 *
 * "Ironwood Packaging Group's" and "Ironwood Packaging Group" are the same
 * name; normalising alone turns the possessive into a stray "s" token and the
 * two stop matching, which refused a question about an account the workspace
 * plainly has.
 */
const nameKey = (value: string): string => normalise(String(value).replace(/['\u2019]s\b/gi, '').replace(/['\u2019]/g, ''));

/** Verbs that only a person who owns records can be the subject of. */
const OWNER_VERB = '(?:own|owns|owned|manage|manages|carry|carries|sold|sell|sells)';
const OUTCOME_VERB = '(?:win|won|wins|lose|lost|loses|close|closed|book|booked|forecast|quote|quoted)';

function positionOf(question: string, span: string): SubjectPosition {
  const name = escapeRegExp(span);
  const strong = [
    `\\bowned\\s+by\\s+${name}\\b`,
    `\\bassigned\\s+to\\s+${name}\\b`,
    `\\b(?:rep|reps|owner|owners|ae|seller|teammate|colleague)\\s+${name}\\b`,
    `\\b(?:does|do|did)\\s+${name}\\s+${OWNER_VERB}\\b`,
    `\\b(?:did|does|do)\\s+${name}\\s+${OUTCOME_VERB}\\b`,
    `\\b${name}\\s+${OWNER_VERB}\\b`,
    `\\b${name}(?:'s|’s|s')\\s+(?:pipeline|quota|book|forecast|number|numbers|deals?)\\b`,
  ];
  if (strong.some((pattern) => new RegExp(pattern, 'i').test(question))) return 'owner';
  // "How many open deals does Fiona Blackwood have?" reads as a rep question
  // and as an account question with equal grammar, so the slot stays open and
  // a refusal names both.
  if (new RegExp(`\\b(?:does|do|did)\\s+${name}\\s+(?:have|has|had)\\b`, 'i').test(question)) return 'owner_or_account';
  return 'account';
}

/**
 * Every proper noun the question writes as the name of somebody or something.
 *
 * A name that reaches this list has to be settled: it resolved to a record of
 * the right kind, or the question is refused. The alternative — which shipped —
 * is that "How much pipeline does Jordan Fairweather own?" deletes the name and
 * states the workspace total as the answer.
 *
 * The bar is deliberately two capitalised words, or one in an unmistakable
 * owner slot. A single capitalised word is as often a stage, a product, a month
 * or the first word of a sentence as it is a name, and refusing those would be
 * its own wrong answer.
 */
export function namedSubjects(question: string, exclude: string[] = []): NamedSubject[] {
  const blocked = exclude.map((phrase) => nameKey(phrase)).filter(Boolean);
  const out: NamedSubject[] = [];
  const seen = new Set<string>();
  for (const mention of extractMentions(question)) {
    if (mention.kind !== 'proper' && mention.kind !== 'quoted') continue;
    // A capitalised run that stops in the middle of a word is not a name. The
    // proper-noun scanner is ASCII, so "Is Ardennes Précision at its seat
    // limit?" hands back "Is Ardennes Pr" — refusing that as an unknown account
    // is a wrong answer about a company the workspace plainly has.
    if (truncatedSpan(question, mention.text)) continue;
    // The sentence's own punctuation is not part of the name. "Compare open
    // pipeline for Dana Whitfield and Priya Raman." captured "Priya Raman."
    // with the full stop attached, so the rep resolved to nobody and the
    // refusal quoted a name with a dot on the end back at the reader.
    const text = withoutLeadingFurniture(mention.text).replace(/[\s.,;:!?]+$/, '');
    const key = nameKey(text);
    if (!key || seen.has(key)) continue;
    const tokens = key.split(' ').filter(Boolean);
    // A span whose every word is question furniture is not a name; a span that
    // another qualifier already consumed ("the Renewal pipeline", "Negotiation
    // stage") is that qualifier, not a company nobody has heard of.
    if (tokens.every((t) => STOPWORDS.has(t) || COMMON_WORDS.has(t))) continue;
    if (blocked.some((phrase) => phrase === key || ` ${phrase} `.includes(` ${key} `) || ` ${key} `.includes(` ${phrase} `))) continue;
    const position = positionOf(question, text);
    if (tokens.length < 2 && position !== 'owner') continue;
    seen.add(key);
    out.push({ text, position });
  }
  return out;
}

/**
 * A span the capitalised-run scanner cut in the middle of a word.
 *
 * It reads ASCII only, so an accent ends the run: "Västerö Industriteknik"
 * comes back as "Is V". A truncated span is not evidence of anything and must
 * never become a refusal.
 */
function truncatedSpan(question: string, span: string): boolean {
  const at = question.indexOf(span);
  if (at < 0) return false;
  const after = question[at + span.length];
  return !!after && /\p{L}/u.test(after);
}

/**
 * The name inside a capitalised run that starts with the sentence's own verb.
 *
 * "Is Fairhaven Dairy Co-operative at its seat limit?" opens with a capital I,
 * and the run reads "Is Fairhaven Dairy Co-operative" — the account is in
 * there, with a question word welded to the front of it.
 */
const SENTENCE_OPENER = /^(is|are|was|were|do|does|did|has|have|had|can|could|should|would|will|what|which|who|whose|where|when|why|how|show|list|tell|give|find|please|draft|write|send|summarise|summarize|explain|compare|and|the|a|an|for|in|on|at|of)$/i;

function withoutLeadingFurniture(span: string): string {
  const parts = span.split(/\s+/).filter(Boolean);
  while (parts.length > 1 && SENTENCE_OPENER.test(parts[0])) parts.shift();
  return parts.join(' ') || span;
}

/** Whether a resolver's mention is the whole of the name the question wrote. */
export function mentionCoversSubject(subject: string, mention: string): boolean {
  const span = nameKey(subject);
  const matched = nameKey(mention);
  if (!span || !matched) return false;
  if (span === matched) return true;
  // A mention wider than the span still contains it — "Calder and Vance" is one
  // name written across two capitalised runs.
  return ` ${matched} `.includes(` ${span} `);
}

/**
 * The words a sentence puts in an owner slot, whatever their capitalisation.
 *
 * `namedSubjects` reads proper nouns, and "how much pipeline does marcus own"
 * has none — yet the grammar is unmistakable, and the lowercase spelling was
 * enough to send the answer to a contact who shares the first name. This reads
 * the slot from the verb instead, and is used only to prefer a teammate that
 * did resolve: a lowercase word that resolves to nobody is not evidence enough
 * to refuse a question on.
 */
const OWNER_SLOT_PATTERNS: RegExp[] = [
  /\bowned\s+by\s+([\w'’.\-]+(?:\s+[\w'’.\-]+){0,2})/gi,
  /\bassigned\s+to\s+([\w'’.\-]+(?:\s+[\w'’.\-]+){0,2})/gi,
  /\b(?:does|do|did)\s+(.+?)\s+(?:own|owns|owned|manage|manages)\b/gi,
  /\b(?:rep|owner|ae|seller|teammate)\s+([\w'’.\-]+(?:\s+[\w'’.\-]+){0,2})/gi,
];

const FURNITURE = (token: string): boolean =>
  STOPWORDS.has(token) || COMMON_WORDS.has(token)
  || /^(we|us|our|ours|they|them|their|i|me|my|you|your|he|she|his|her|team|teams|rep|reps|everyone|anyone|nobody|workspace|company|account)$/.test(token);

export function ownerSlotSpans(question: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const pattern of OWNER_SLOT_PATTERNS) {
    for (const hit of question.matchAll(pattern)) {
      const tokens = normalise(hit[1] ?? '').split(' ').filter(Boolean);
      while (tokens.length && FURNITURE(tokens[0])) tokens.shift();
      while (tokens.length && FURNITURE(tokens[tokens.length - 1])) tokens.pop();
      if (!tokens.length || tokens.length > 3) continue;
      const span = tokens.join(' ');
      if (seen.has(span)) continue;
      seen.add(span);
      out.push(span);
    }
  }
  return out;
}

/**
 * A name written into an owner slot is an owner, everywhere downstream.
 *
 * "How much pipeline does Marcus own?" resolves both Marcus Ilori (a teammate)
 * and Marcus Barnes (a contact at Whitcombe Aerospace). The plan computed the
 * rep's figure and then loaded the contact's account, and the answer took its
 * subject from the second — $315,900 about Whitcombe under a sentence naming
 * Marcus. The lower-scoring record of the wrong type is dropped here so no
 * step downstream can take its side.
 */
export function resolveOwnerSlots(question: string, entities: ResolvedEntity[], exclude: string[] = []): ResolvedEntity[] {
  const slots = [
    ...namedSubjects(question, exclude).filter((slot) => slot.position === 'owner').map((slot) => slot.text),
    ...ownerSlotSpans(question),
  ];
  if (!slots.length) return entities;
  const drop = new Set<string>();
  for (const slot of slots) {
    if (!entities.some((e) => e.entity.type === 'user' && mentionCoversSubject(slot, e.mention))) continue;
    for (const other of entities) {
      if (other.entity.type === 'user') continue;
      if (mentionCoversSubject(slot, other.mention)) drop.add(other.entity.id);
    }
  }
  return drop.size ? entities.filter((e) => !drop.has(e.entity.id)) : entities;
}

/** Whether the resolver matched a fragment of the name and dropped the rest. */
export function mentionIsFragmentOf(subject: string, mention: string): boolean {
  const span = nameKey(subject);
  const matched = nameKey(mention);
  if (!span || !matched || span === matched) return false;
  return ` ${span} `.includes(` ${matched} `);
}

/**
 * Metrics whose definition already *is* an outcome filter.
 *
 * "Our biggest open deals" names open deals twice — once as the measure and
 * once as the status — and open pipeline is by definition every deal not yet
 * closed. Recording the second one as a qualifier the query has to bind
 * separately refuses a question the engine answers exactly, which is its own
 * kind of wrong answer.
 */
const METRIC_IMPLIES_STATUS: Record<string, 'open' | 'won' | 'lost'> = {
  pipeline: 'open', weighted_pipeline: 'open', deal_count: 'open',
  closed_won: 'won', avg_deal_size: 'won', sales_cycle: 'won',
  closed_lost: 'lost',
  // A win rate is the won/lost split by definition; reading the "win" in its
  // own name as a separate status filter refused the question it names.
  win_rate: 'won',
};

/** Deal outcome words — a status qualifier that is not a stage name. */
const WON_WORDS = /\b(won|win|closed[\s-]?won|landed|signed)\b/i;
const LOST_WORDS = /\b(lost|lose|losing|closed[\s-]?lost|churned|dropped)\b/i;
const OPEN_WORDS = /\b(open|active|live|in\s+flight|outstanding)\s+(?:deals?|opportunit(?:y|ies)|pipeline)\b/i;
/**
 * "Closed", said of what already happened, means won *and* lost.
 *
 * "How many deals did we close in Q2 2026?" was answered "Northwind Robotics
 * has 0 open deals closing in Q2 2026" — a false zero, under a caption naming
 * the opposite of the question: the reader asked what was decided and the
 * engine counted the open book against a close-date column that no open deal in
 * that past quarter can satisfy. The tense is what tells the two apart: "deals
 * closing this month" is a forward look at the open book and stays one.
 */
const DECIDED_WORDS =
  /\b(?:did\s+(?:we|they|you|i)\s+clos(?:e|ed)|(?:we|they)\s+closed|closed\s+(?:deals?|opportunit(?:y|ies))|deals?\s+(?:we\s+)?closed|clos(?:e|ed)\s+out)\b/i;

export interface QualifierParseInput {
  question: string;
  intent: TaskIntent;
  vocabulary: QualifierVocabulary;
  /** Every entity this turn resolved, already type-filtered by the resolver. */
  entities: ResolvedEntity[];
  windows: TimeWindow[];
  /** Period phrases the parser could not turn into a range — named, not dropped. */
  unresolvedPeriods?: PeriodMention[];
  metric: MetricDetection | null;
  /** A measure the question named that the catalogue does not hold. */
  unknownMetric: string | null;
  meter: ResolvedEntity | null;
  currency: string | null;
  /** A ranking cut-off the question wrote — "top 3 accounts". */
  limit: number | null;
  /** The order the question asked its rows to be in, when it is not the default. */
  order?: RankingOrder | null;
  /** Every unit the question asked the answer to be denominated in. */
  units: string[];
  /** The currency books this workspace keeps, so an unknown one is refused. */
  currencyBooks?: string[];
  /** The stage values that count as open, won and lost here. */
  stages: { open: string[]; won: string[]; lost: string[] };
  /**
   * Filters the question named on records that are not deals.
   *
   * A ticket's status, a company's relationship, a contact's buying role: the
   * engine has always read these out of the sentence, and they never entered
   * the ledger — so "how many tickets are escalated" ran the workspace's
   * ticket intake for the quarter and stated 14 as the answer, with the word
   * the reader typed appearing nowhere in the run. A qualifier this file does
   * not hold is a qualifier the invariant cannot protect.
   */
  recordFilters?: RecordFilter[];
  /** The workspace's own name, which is never an account it does not have. */
  workspaceName?: string;
  /**
   * The question this one follows, when this turn is a follow-up.
   *
   * A scope established a turn ago is still the scope: "what is the Renewal
   * pipeline worth?" then "and the smallest deal in it?" is one question in two
   * sentences, and reading the second alone answered it with an Expansion deal.
   * The carried scope enters the ledger as an ordinary entry, so it has to be
   * bound to this turn's query or refused like any other — it is never a hint
   * the planner may ignore.
   */
  carriedQuestion?: string | null;
}

/** A filter on a record property, with the words that produced it. */
export interface RecordFilter {
  objectType: string;
  property: string;
  value?: string | number;
  values?: string[];
  /** The words in the question that named it. */
  matched: string;
  /** What a person calls the value — "Escalated", "Economic buyer". */
  label: string;
  /** How the value narrows, when it is not equality. */
  op?: 'eq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'has';
  /**
   * What a person calls the dimension — "Competitor", "Industry", "Priority".
   *
   * A refusal that says 'you asked about the status "aerospace"' names the
   * wrong dimension at the reader, which reads as the engine having
   * misunderstood twice. The ledger keeps one kind for every record filter and
   * takes the noun from the workspace's own property label.
   */
  noun?: string;
  /**
   * The rows this filter picks out, when it narrows a *different* table from
   * the one the answer measures.
   *
   * "How much open pipeline is with pharmaceutical companies?" filters
   * companies and sums deals. Without the ids the industry could only ever be
   * waived, and it was silently dropped instead — $308,880 stated for a set
   * worth $849,660.
   */
  ids?: string[];
}

const entry = (
  kind: LedgerKind,
  text: string,
  resolved: QualifierValue | null,
  state: QualifierState = 'pending',
  detail: string | null = null,
): Qualifier => ({ kind, text, resolved, state, binding: null, detail });

/**
 * Read every qualifier the question names into one typed list.
 *
 * A qualifier with no resolution is born `refused`: "Technical validation" that
 * matches no stage in this workspace is a refusal, never a fuzzy hop onto a
 * deal whose name happens to contain the word.
 */
export function parseQualifiers(input: QualifierParseInput): QualifierLedger {
  const ledger = new QualifierLedger();
  const question = input.question;
  const scoping = input.intent !== 'draft' && input.intent !== 'act';

  if (input.unknownMetric) {
    ledger.add(entry('metric', input.unknownMetric, null, 'refused',
      `"${input.unknownMetric}" is not a measure this platform defines.`));
  } else if (input.metric && (input.intent === 'aggregate' || input.intent === 'compare')) {
    // A measure is a qualifier only when the question asks for a number. "Which
    // invoices are overdue" mentions a measure and asks for rows, and holding
    // the answer to a `metric` argument it never needed would refuse a question
    // this engine answers exactly.
    ledger.add(entry('metric', input.metric.matched, {
      kind: 'metric', value: input.metric.metric.id, label: input.metric.metric.label,
    }));
  }

  if (scoping) {
    // A span another dimension has already claimed is that dimension. "How
    // much open pipeline is in the Expansion deal type?" writes the words
    // "deal type" outright, and reading "Expansion" a second time as the
    // pipeline made one span two qualifiers of different kinds — which the
    // ambiguity guard correctly refuses, on a question that named one thing.
    const spent = new Set((input.recordFilters ?? []).map((filter) => normalise(filter.matched)));
    const pipelines = pipelinesIn(question, input.vocabulary)
      .filter((pipeline) => !spent.has(normalise(pipeline.text)));
    // One entry per mention. A ledger that held one pipeline answered "what is
    // the Renewal pipeline worth in the Expansion pipeline" for Expansion
    // alone, with Renewal never entering the run — the second half of the
    // question dropped in silence, which is what this file exists to stop.
    for (const pipeline of pipelines) {
      ledger.add(entry('pipeline', pipeline.text, {
        kind: 'pipeline', value: pipeline.term.value, label: pipeline.term.label, property: 'pipeline',
      }));
    }
    if (!pipelines.length) {
      // A pipeline this workspace does not have is a refusal, not a silent
      // widening to the whole book. The test is deliberately narrow: only a
      // proper noun in front of the word counts, because "how much pipeline",
      // "our pipeline" and "weighted pipeline" all name a measure rather than
      // a pipeline, and refusing those would be its own wrong answer.
      const named = question.match(/(^|[^.?!]\s)(?:the\s+)?([A-Z][A-Za-z-]{2,})\s+pipelines?\b/);
      const word = named?.[2] ?? '';
      const measureWord = /^(Open|Weighted|Total|Sales|Our|The|New|Current|Whole|Entire|Full|Net|Gross|Closed|Forecast|Forecasted|Committed|Qualified|Healthy|Overall|Global|Active|Live|Much|Big|Deal|Company|Customer)$/.test(word);
      // "What pipelines do we have?" opens with a question word, not with the
      // name of a pipeline this workspace is missing. Refusing it named three
      // pipelines in the apology for not being able to name them.
      const furniture = /^(What|Which|Who|Whose|Whom|Where|When|Why|How|Show|List|Tell|Give|Find|Do|Does|Did|Is|Are|Was|Were|Can|Could|Should|Would|Will|Please|All|Every|Each|Any|Some|Both|Many|More|Most|Other|Same|Only|Also|And|But|Or|If|Then|Compare|Summarise|Summarize|Explain|My|Your|Their|His|Her|Its)$/.test(word);
      if (word && !measureWord && !furniture && input.vocabulary.pipelines.length) {
        ledger.add(entry('pipeline', `${word} pipeline`, null, 'refused',
          `No deal pipeline in this workspace is called "${word}".`));
      }
    }

    // A scope the thread already established, when this turn narrows nothing
    // of its own. It is marked so the answer can say where it came from.
    if (input.carriedQuestion && !pipelines.length) {
      for (const pipeline of pipelinesIn(input.carriedQuestion, input.vocabulary)) {
        ledger.add({
          kind: 'pipeline', text: pipeline.text, state: 'pending', binding: null, carried: true,
          resolved: { kind: 'pipeline', value: pipeline.term.value, label: pipeline.term.label, property: 'pipeline' },
          detail: null,
        });
        break;
      }
    }

    const stages = stagesIn(question, input.vocabulary);
    for (const stage of stages) {
      // A stage name that is part of the measure's own name is the measure, not
      // a second filter. "Closed-won bookings" contains the stage "Closed won",
      // and reading it as a stage qualifier asked `business_metric` to narrow a
      // metric defined by that very stage set — which it correctly refuses,
      // leaving the comparison with no answer at all. That only holds when the
      // measure is what the question asks for: "Which deals are in the Churned
      // stage" asks for rows, and suppressing the stage there left the sentence
      // scoped by nothing but the word "churned", which read as an outcome and
      // listed every closed-lost deal in all three pipelines.
      const inMetricName = !!input.metric && !!ledger.first('metric')?.resolved
        && normalise(input.metric.matched).includes(normalise(stage.text));
      if (inMetricName) continue;
      // A pipeline the question also names, and a stage name that pipeline does
      // not use, are a contradiction. "What is the New business pipeline worth
      // at the Scoping stage?" was answered $500,160 "at the Discovery stage" —
      // the engine quietly translating the reader's word into another
      // pipeline's and reporting four deals under a stage that book does not
      // have.
      const namedPipeline = ledger.first('pipeline')?.resolved;
      if (namedPipeline && stage.aliasPipelines.length
        && !stage.aliasPipelines.includes(String(namedPipeline.value))) {
        const owners = input.vocabulary.pipelines
          .filter((pl) => stage.aliasPipelines.includes(pl.value))
          .map((pl) => pl.label);
        ledger.add(entry('stage', stage.text, null, 'refused',
          `The ${namedPipeline.label} pipeline has no stage called "${stage.text}" — that is what ${listPhrase(owners)} calls ${stage.term.label.toLowerCase()}, and ${namedPipeline.label} calls it "${stageLabelIn(input.vocabulary, stage.term.value, String(namedPipeline.value)) ?? stage.term.label}".`));
        continue;
      }
      // A stage name only one pipeline uses carries that pipeline with it.
      // Read as a bare stage value, "which deals are in the Churned stage"
      // answers with every closed-lost deal in three pipelines — a bigger,
      // confident number about a question nobody asked.
      // ...and only when the stored value is shared: `technical_validation`
      // lives in one pipeline already and needs no second filter.
      const only = stage.aliasPipelines.length === 1 && stage.term.pipelines.length > 1
        ? stage.aliasPipelines[0] : null;
      if (only && !ledger.first('pipeline')) {
        const term = input.vocabulary.pipelines.find((pl) => pl.value === only);
        if (term) {
          ledger.add({
            kind: 'pipeline', text: stage.text, state: 'pending', binding: null, derivedFrom: 'stage',
            resolved: { kind: 'pipeline', value: term.value, label: term.label, property: 'pipeline' },
            detail: null,
          });
        }
      }
      ledger.add(entry('stage', stage.text, {
        // The label the reader wrote, not the one this file would have picked
        // for them: a workspace that calls `discovery` "Scoping" in Expansion
        // must hear "Scoping" back.
        kind: 'stage', value: stage.term.value, label: stage.label, property: 'deal_stage',
      }));
    }
    if (!stages.length && input.carriedQuestion) {
      for (const stage of stagesIn(input.carriedQuestion, input.vocabulary)) {
        ledger.add({
          kind: 'stage', text: stage.text, state: 'pending', binding: null, carried: true,
          resolved: { kind: 'stage', value: stage.term.value, label: stage.label, property: 'deal_stage' },
          detail: null,
        });
        break;
      }
    }
    if (!stages.length) {
      const shaped = stageShapedPhrase(question);
      const inMetricName = !!shaped && !!input.metric && !!ledger.first('metric')?.resolved
        && normalise(input.metric.matched).includes(normalise(shaped));
      if (shaped && !inMetricName && input.vocabulary.stages.length
        && !input.vocabulary.stages.some((st) => st.aliases.some((alias) => normalise(alias.label) === normalise(shaped)))) {
        ledger.add(entry('stage', shaped, null, 'refused',
          `No deal stage in this workspace is called "${shaped}".`));
      }
    }
  }

  // Every name the question wrote down, minus the ones another qualifier
  // already owns. A pipeline label, a stage label, a meter and a period are
  // spelt with capitals too, and reading one of those as an unknown company is
  // its own wrong answer.
  const consumed = [
    ...ledger.entries.map((q) => q.text),
    ...input.windows.map((w) => w.matched),
    ...(input.unresolvedPeriods ?? []).map((m) => m.text),
    ...(input.meter ? [input.meter.mention, input.meter.entity.label] : []),
    ...(input.metric ? [input.metric.matched] : []),
    ...(input.workspaceName ? [input.workspaceName] : []),
    ...(stageShapedPhrase(question) ? [stageShapedPhrase(question)!] : []),
    ...input.vocabulary.pipelines.flatMap((p) => [p.label, p.value.replace(/_/g, ' ')]),
    ...input.vocabulary.stages.flatMap((st) => [...st.aliases.map((alias) => alias.label), st.value.replace(/_/g, ' ')]),
  ].filter(Boolean);
  const subjects = scoping ? namedSubjects(question, consumed) : [];

  const users = input.entities.filter((e) => e.entity.type === 'user' && e.score >= 0.55);
  const accountish = input.entities.filter((e) => ['company', 'customer', 'contact'].includes(e.entity.type));
  // A company and its billing customer are two rows with one name, and the
  // resolver returns both. Counted as two accounts they read as a question
  // naming two — which, now that a second account is a refusal rather than a
  // silent drop, would refuse every account question this workspace bills.
  const rank: Record<string, number> = { company: 0, contact: 1, customer: 2 };
  const accounts: ResolvedEntity[] = [];
  for (const hit of [...accountish].filter((e) => e.score >= 0.7)
    .sort((a, b) => (rank[a.entity.type] ?? 3) - (rank[b.entity.type] ?? 3))) {
    const held = accounts.find((other) => nameKey(other.entity.label) === nameKey(hit.entity.label));
    // The CRM row is the one the answer is about, and the longest span either
    // row matched is the reader's own words for it — an accented name with a
    // verb in front of it resolves on the billing row and on no other, and
    // dropping that span made the account look like a name nobody has.
    if (!held) { accounts.push({ ...hit }); continue; }
    if (hit.mention.length > held.mention.length) held.mention = hit.mention;
  }
  const claimed = new Set<string>();
  /** The exact spans a slot above took, so a fragment of one is not a second name. */
  const claimedSpans: string[] = [];
  const ownerValue = (hit: ResolvedEntity): QualifierValue =>
    ({ kind: 'owner', value: hit.entity.id, label: hit.entity.label, property: 'owner_id' });
  const accountValue = (hit: ResolvedEntity): QualifierValue =>
    ({ kind: 'account', value: hit.entity.id, label: hit.entity.label });

  // A name in an owner slot is an owner or it is a refusal. It is never
  // deleted from the question so the workspace total can stand in for it, and
  // it is never answered with a contact who shares the rep's first name — a
  // resolution of the wrong type is a different question, not a weaker match.
  const grammatical: NamedSubject[] = ownerSlotSpans(question)
    .filter((span) => !subjects.some((slot) => mentionCoversSubject(slot.text, span) || mentionCoversSubject(span, slot.text)))
    // A lowercase span that resolves to nobody is a word, not a name: it takes
    // the owner slot only when a teammate actually answers to it.
    .filter((span) => users.some((u) => mentionCoversSubject(span, u.mention)))
    .map((span) => ({ text: span, position: 'owner' }));
  for (const slot of [...subjects, ...grammatical]) {
    if (slot.position === 'account') continue;
    claimedSpans.push(slot.text);
    const user = users.find((u) => mentionCoversSubject(slot.text, u.mention));
    if (user) {
      claimed.add(nameKey(slot.text));
      // One entry per teammate the question names. Holding one meant "how much
      // pipeline does Marcus Ilori own that Priya Raman owns" answered for
      // Marcus alone, with the second name nowhere in the run.
      if (!ledger.entries.some((held) => held.kind === 'owner' && held.resolved?.value === user.entity.id)) {
        ledger.add(entry('owner', user.mention, ownerValue(user)));
      }
      continue;
    }
    // "Does Meridian Forge Systems have" is an account question wearing a
    // verb a rep could also be the subject of; the account pass takes it.
    if (slot.position === 'owner_or_account' && accounts.some((a) => mentionCoversSubject(slot.text, a.mention))) continue;
    claimed.add(nameKey(slot.text));
    ledger.add(entry('owner', slot.text, null, 'refused', slot.position === 'owner'
      ? `No teammate in this workspace is called "${slot.text}".`
      : `Nothing in this workspace is called "${slot.text}" — not a teammate, and not an account.`));
  }
  if (!ledger.first('owner') && users.length) {
    ledger.add(entry('owner', users[0].mention, ownerValue(users[0])));
  }


  // The same rule for the account slot, plus the near-miss: a name that
  // resolved on a fragment of itself — "Bayside Logistics" onto Oranmore
  // Logistics, on the shared word — is a substitution, not a match, and it is
  // offered back as a question rather than answered as if it were the name.
  for (const slot of subjects) {
    claimedSpans.push(slot.text);
    if (claimed.has(nameKey(slot.text))) continue;
    const account = accounts.find((a) => mentionCoversSubject(slot.text, a.mention));
    if (account) {
      claimed.add(nameKey(slot.text));
      // Both companies, not the last one standing: "how much did Meridian Forge
      // Systems and Ironwood Packaging Group spend in Q2 2026" answered $9,012
      // — Ironwood's half — with Meridian dropped in silence, 48% of the figure
      // the reader asked for.
      if (!ledger.entries.some((held) => held.kind === 'account' && held.resolved?.value === account.entity.id)) {
        ledger.add(entry('account', account.mention, accountValue(account)));
      }
      continue;
    }
    // A teammate's own name in a slot that reads as an account is still a
    // teammate: "what is the Renewal pipeline worth for Priya Raman" is scoped
    // to a rep, and refusing it as a company nobody has heard of is worse than
    // the substitution it was meant to stop.
    const teammate = users.find((u) => mentionCoversSubject(slot.text, u.mention));
    if (teammate) {
      claimed.add(nameKey(slot.text));
      if (!ledger.entries.some((held) => held.kind === 'owner' && held.resolved?.value === teammate.entity.id)) {
        ledger.add(entry('owner', teammate.mention, ownerValue(teammate)));
      }
      continue;
    }
    claimed.add(nameKey(slot.text));
    const near = [...accountish, ...users].find((e) =>
      nameKey(e.entity.label) !== nameKey(slot.text)
      && (mentionIsFragmentOf(slot.text, e.mention) || mentionCoversSubject(slot.text, e.mention)));
    ledger.add(entry('account', slot.text, null, 'refused', near
      ? `No record in this workspace is called "${slot.text}". The nearest name I hold is ${near.entity.label}, a ${Math.round(near.score * 100)}% match on "${near.mention}" — too far to answer about it under your wording. Did you mean ${near.entity.label}?`
      : `No company, contact or customer in this workspace is called "${slot.text}".`));
  }
  // Every account the resolver found that no slot above claimed. The engine's
  // own comparison path measures two of them; a ledger that recorded one made
  // the second invisible to the invariant, so a capability that could take only
  // one dropped it without a word.
  // Longest mention first, so a name that contains another is read as the one
  // the reader wrote rather than as two.
  for (const hit of [...accounts].sort((a, b) => b.mention.length - a.mention.length)) {
    if (ledger.entries.some((held) => held.kind === 'account' && held.resolved?.value === hit.entity.id)) continue;
    if (claimed.has(nameKey(hit.mention))) continue;
    // A word inside a span another name already took is not a second account.
    // "Industrial" resolves to Tanaka Foods Industrial on its own, and it is
    // also the last word of "Castellón Cerámica Industrial" — read as a second
    // account it turns one answerable question into a refusal about two.
    const taken = [...claimedSpans, ...ledger.entries.filter((held) => held.kind === 'account').map((held) => held.text)];
    if (taken.some((span) => mentionCoversSubject(hit.mention, span))) continue;
    ledger.add(entry('account', hit.mention, accountValue(hit)));
  }

  const dateNoun = scoping ? dateNounIn(question) : null;
  for (const window of input.windows) {
    ledger.add(entry('period', window.matched.trim() || window.label, {
      kind: 'period', value: window.label, label: window.label,
      // The column is part of the period, not decoration on it: a range on
      // `close_date` is not an answer to a question about `created`.
      ...(dateNoun ? { property: dateNoun.property } : {}),
    }));
  }
  // A period phrase that resolved to nothing is still a period the question
  // named. It belongs in the ledger as a refusal rather than as an absence —
  // an absence is indistinguishable from a question that named no period.
  for (const mention of input.unresolvedPeriods ?? []) {
    ledger.add(entry('period', mention.text, null, 'refused',
      `"${mention.text}" is a period I could not resolve to a date range.`));
  }

  if (scoping) {
    // A status the question names is a filter on the outcome, and it is not the
    // same thing as a stage: "which deals did we lose in Q2" names no stage and
    // must not be answered with every deal that closed in Q2.
    const stageNamed = !!ledger.first('stage')?.resolved;
    // A measure only swallows the outcome it is defined by when the measure is
    // what runs. A list is filtered by `record_search`, which takes the stage
    // set as an argument, so suppressing the status there dropped the filter
    // and "which deals did we lose in Q2 2026?" listed every deal that closed.
    const measured = input.intent === 'aggregate' || input.intent === 'compare';
    const implied = measured && input.metric ? METRIC_IMPLIES_STATUS[input.metric.metric.id] ?? null : null;
    // A *snapshot* measure whose own name opens with the outcome word owns
    // that word, whatever the intent. "Summarise Kestrel Aerospace Components
    // and tell me their open pipeline" was refused with 'you asked about the
    // status "open pipeline"' — the measure shredded into a status by a
    // lexicon that ran first, on a question the engine answers exactly.
    //
    // Deliberately narrow. A decided measure is *not* covered: "which deals
    // did we lose in Q2 2026?" matches `closed_lost` on the same word the
    // status does, and suppressing the status there listed every deal that
    // closed in the quarter, won ones included.
    const ownsOutcome = (text: string): boolean => {
      if (!input.metric?.metric.snapshot) return false;
      const measure = normalise(input.metric.matched).split(' ');
      const word = normalise(text).split(' ');
      return word.length <= measure.length && word.every((one, at) => measure[at] === one);
    };
    const record = (status: 'open' | 'won' | 'lost' | 'decided', text: string, label: string, values: string[]) => {
      if (implied === status) return;
      if (METRIC_IMPLIES_STATUS[input.metric?.metric.id ?? ''] === status && ownsOutcome(text)) return;
      ledger.add(entry('status', text, { kind: 'status', value: status, label, property: 'deal_stage', values }));
    };
    if (!stageNamed) {
      // A measure that *is* an outcome owns the word: "what did we close last
      // quarter and why?" is closed-won bookings, and reading "close" as a
      // second, wider outcome filter refused a question the engine answers.
      // "What did we close last quarter and why?" is a request for the won and
      // lost splits side by side, which the explain plan builds out of two
      // aggregates; there is one outcome filter per aggregate and no single
      // one for the ledger to hold. The decided reading belongs to the
      // questions that end in one number or one list.
      const outcomeMeasure = METRIC_IMPLIES_STATUS[input.metric?.metric.id ?? ''];
      const counted = input.intent === 'aggregate' || input.intent === 'compare' || input.intent === 'lookup';
      if (counted && DECIDED_WORDS.test(question) && input.stages.won.length && input.stages.lost.length
        && outcomeMeasure !== 'won' && outcomeMeasure !== 'lost'
        && !WON_WORDS.test(question) && !LOST_WORDS.test(question)) {
        record('decided', question.match(DECIDED_WORDS)![0], 'closed — won or lost',
          [...input.stages.won, ...input.stages.lost]);
      } else if (LOST_WORDS.test(question) && input.stages.lost.length) {
        record('lost', question.match(LOST_WORDS)![0], 'closed lost', input.stages.lost);
      } else if (WON_WORDS.test(question) && input.stages.won.length) {
        record('won', question.match(WON_WORDS)![0], 'closed won', input.stages.won);
      } else if (OPEN_WORDS.test(question) && input.stages.open.length) {
        record('open', question.match(OPEN_WORDS)![0], 'open', input.stages.open);
      }
    }
  }

  // Every filter the engine reads off a non-deal record is a qualifier the
  // reader wrote, and it is settled like any other: bound when the query that
  // ran carries it, refused when nothing can.
  if (scoping) {
    for (const filter of input.recordFilters ?? []) {
      if (!filter.matched) continue;
      if (ledger.entries.some((q) => q.kind === 'status' && q.resolved?.property === filter.property
        && q.resolved.objectType === filter.objectType)) continue;
      ledger.add(entry('status', filter.matched, {
        kind: 'status', value: filter.value ?? (filter.values ?? [])[0] ?? '', label: filter.label,
        property: filter.property, objectType: filter.objectType,
        ...(filter.values?.length ? { values: filter.values } : {}),
        ...(filter.noun ? { noun: filter.noun } : {}),
        ...(filter.ids?.length ? { ids: filter.ids } : {}),
        ...(filter.op ? { op: filter.op } : {}),
      }));
    }
  }

  if (input.meter) {
    ledger.add(entry('meter', input.meter.mention, {
      kind: 'meter', value: input.meter.entity.id, label: input.meter.entity.label,
    }));
  }
  if (input.currency) {
    const books = input.currencyBooks ?? [];
    ledger.add(books.length && !books.includes(normalise(input.currency))
      ? entry('currency', input.currency, null, 'refused',
        `${input.workspaceName ?? 'This workspace'} keeps no ${input.currency.toUpperCase()} book — every amount here is written in ${listPhrase(books.map((book) => book.toUpperCase()))}. A zero for ${input.currency.toUpperCase()} would read as "we billed nothing in ${input.currency.toUpperCase()}", which is a different statement.`)
      : entry('currency', input.currency, { kind: 'currency', value: input.currency, label: input.currency.toUpperCase() }));
  }
  for (const unit of input.units) {
    ledger.add({
      ...entry('unit', unit, { kind: 'unit', value: unit, label: unit }),
      // A unit is a claim about the number, and the number does not exist until
      // the tools have run. `settleUnitAgainstResults` decides it; until then
      // it is pending on purpose, and the entry says so rather than an
      // allowlist in the engine saying it for it.
      settlesAfterRun: true,
    });
  }
  if (input.limit !== null) {
    ledger.add(entry('limit', String(input.limit), { kind: 'limit', value: input.limit, label: `top ${input.limit}` }));
  }
  if (input.order) {
    ledger.add(entry('ranking', input.order.text, {
      kind: 'ranking', value: input.order.direction, label: `${input.order.word} first`,
      property: input.order.property ?? undefined,
    }));
  }
  return ledger;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** "the biggest open deal", "our largest customer" — a cut-off of exactly one. */
const SINGULAR_SUPERLATIVE =
  /\b(?:the|our|my|its|their)\s+(?:single\s+)?(?:biggest|largest|highest|best|worst|lowest|smallest|top|cheapest|(?:least|most)[-\s](?:valuable|expensive|valued)|(?:lowest|highest)[-\s]valued?)\s+(?:open\s+|closed\s+|won\s+|lost\s+|active\s+|outstanding\s+|unpaid\s+)*(?:deal|opportunity|account|customer|company|logo|invoice|subscription|ticket|rep|owner|seller)\b(?!s)/i;

/**
 * The ranking cut-off a question wrote.
 *
 * "The top three accounts" answered with five rows is the same silent widening
 * as an ignored pipeline, one page further down — the reader asked for a
 * three-row answer and got a five-row one with no signal that the number they
 * typed was dropped.
 */
export function rankingLimit(question: string): number | null {
  const words = '\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten';
  // "The top 3" and "the 3 largest" are the same instruction. Only the first
  // was read, so "show me the 3 largest open deals owned by Marcus Ilori" came
  // back with eight rows and the cut-off never entered the ledger.
  const hit = question.match(new RegExp(`(?<!\\bat\\s)\\b(?:top|biggest|largest|highest|best|worst|lowest|smallest|bottom|fewest|first)\\s+(${words})\\b`, 'i'))
    ?? question.match(new RegExp(`\\b(${words})\\s+(?:biggest|largest|highest|best|worst|lowest|smallest|cheapest|oldest|newest|soonest)\\b`, 'i'))
    // A bare numeral in front of the noun is the same cut-off: "show me 3 open
    // deals" answered with eight is the reader's own number dropped, and the
    // sentence over the rows then states a count they never asked for.
    ?? question.match(new RegExp(`\\b(${words})\\s+(?:open\\s+|closed\\s+|won\\s+|lost\\s+|active\\s+|outstanding\\s+|unpaid\\s+|overdue\\s+|new\\s+)*(?:deals?|opportunit(?:y|ies)|accounts?|customers?|companies|company|invoices?|subscriptions?|tickets?|contacts?|records?|reps?|owners?)\\b`, 'i'));
  // A singular superlative is a cut-off of one. "Who owns the biggest open
  // deal?" came back as eight rows with no sentence naming an owner, because
  // the number the reader wrote was the word "the".
  if (!hit) return SINGULAR_SUPERLATIVE.test(question) ? 1 : null;
  const raw = hit[1].toLowerCase();
  const value = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw] ?? 0;
  return value >= 1 && value <= 100 ? value : null;
}

/**
 * The order a question asks its rows to be in.
 *
 * "Show me the 3 smallest open deals" and "show me the 3 largest open deals"
 * are different questions, and this engine used to answer both with the
 * largest — printing the word "largest" over rows the reader had asked for the
 * opposite of. Direction is not decoration on a ranking, it *is* the ranking:
 * a 15.8x error with the adjective inverted reads exactly as confident as the
 * right answer.
 *
 * Only an order that is *not* what every row list here already does is
 * recorded. Largest-by-amount and most-recent are the defaults; an entry for
 * them would bind against every plan by construction and say nothing.
 */
export interface RankingOrder {
  /** The property to sort on, or `null` to keep the step's own sort key. */
  property: string | null;
  direction: 'asc' | 'desc';
  /** The words in the question that named it. */
  text: string;
  /** How the answer should describe the rows it is showing — "smallest". */
  word: string;
}

const ORDER_WORDS: { pattern: RegExp; property: string | null; direction: 'asc' | 'desc'; word: string }[] = [
  { pattern: /\b(smallest|tiniest)\b/i, property: 'amount', direction: 'asc', word: 'smallest' },
  { pattern: /\b(cheapest)\b/i, property: 'amount', direction: 'asc', word: 'cheapest' },
  // The hyphenated and adjectival forms of the same instruction. "The
  // lowest-value deals" and "the least valuable open deal" were both refused
  // — the first because the hyphen broke the phrase, the second because
  // "valuable" was lexed as a measure this workspace does not hold — while
  // "five smallest open deals" answered perfectly. One direction, one lexicon.
  { pattern: /\b(?:lowest|least|smallest)[-\s](?:value[ds]?|valuable|priced|cost)\b/i, property: 'amount', direction: 'asc', word: 'lowest-value' },
  { pattern: /\b(?:highest|most|largest|biggest)[-\s](?:value[ds]?|valuable|priced)\b/i, property: 'amount', direction: 'desc', word: 'highest-value' },
  { pattern: /(?<!\bat\s)\b(lowest|least)\b/i, property: 'amount', direction: 'asc', word: 'lowest' },
  { pattern: /\bbottom\b/i, property: 'amount', direction: 'asc', word: 'smallest' },
  { pattern: /\bfewest\b/i, property: null, direction: 'asc', word: 'fewest' },
  // A close date the question wants first is a different sort key as well as a
  // different direction: "the 3 deals closing soonest" answered by the 8
  // largest is two substitutions in one sentence.
  // "Next" is an ordering only when nothing follows it. "How much pipeline
  // closes next quarter?" names a period and a date column — a query this
  // engine runs exactly — and reading "closes next" as a sort order refused it
  // with a sentence about a ranking nobody asked for.
  { pattern: /\b(closing|close|closes|closed|due|expiring|expire|renewing|renew)\s+(soonest|first|earliest|next(?!\s+(?:\d|q[1-4]\b|quarter|month|year|week|day|fiscal|financial|half)))\b/i, property: 'close_date', direction: 'asc', word: 'soonest to close' },
  { pattern: /\b(soonest|earliest)\b/i, property: 'close_date', direction: 'asc', word: 'soonest to close' },
  { pattern: /\boldest\b/i, property: 'created', direction: 'asc', word: 'oldest' },
];

export function rankingOrder(question: string): RankingOrder | null {
  for (const candidate of ORDER_WORDS) {
    const hit = question.match(candidate.pattern);
    if (!hit) continue;
    return { property: candidate.property, direction: candidate.direction, text: hit[0], word: candidate.word };
  }
  return null;
}

/** The adjective an ordered list of rows should be described by. */
export function orderWord(order: { property?: unknown; order_by?: unknown; direction?: unknown } | null | undefined): string | null {
  if (!order) return null;
  // Read from either shape: this is called with a `RankingOrder` and with the
  // raw arguments of the step that ran, which spell the same thing `order_by`.
  const property = typeof order.property === 'string' ? order.property
    : typeof order.order_by === 'string' ? order.order_by
    : null;
  const ascending = order.direction === 'asc';
  if (property === 'close_date') return ascending ? 'closing soonest' : 'closing last';
  if (property === 'created' || property === 'updated') return ascending ? 'oldest' : 'most recent';
  if (property === 'amount') return ascending ? 'smallest' : 'largest';
  // No sort key is not a ranking. A list of tickets in recency order described
  // as "the largest" is the same wrong word as calling the smallest deals the
  // largest, one table over.
  if (!property) return null;
  return ascending ? 'smallest' : 'largest';
}

/**
 * The thing a metering question asks for a count of.
 *
 * "How many widgets did Meridian Forge Systems meter in August 2026?" names a
 * quantity this workspace does not measure, and the run answered it with the
 * six-meter catalogue — the word "widgets" appearing nowhere in the reply, no
 * refusal, no "there is no such meter here". An unknown company, an unknown
 * pipeline, an unknown metric and an unknown unit are all refused by name;
 * this is the same word in the same sentence position.
 */
const METERING_VERB = /\b(meter|meters|metered|metering|ingest|ingested|stream|streamed|consume|consumed)\b/i;

export function meteredNoun(question: string): string | null {
  if (!METERING_VERB.test(question)) return null;
  const hit = question.match(/\bhow\s+(?:many|much)\s+([A-Za-z][A-Za-z-]{2,})\b/i);
  return hit ? hit[1] : null;
}

/**
 * Every word this workspace has a name for, so a refusal never denies one.
 *
 * The comprehension check reads record names and aliases only, so "Proposal
 * sent" — a stage label printed in the same breath by the refusal path — came
 * back as 'I do not hold anything called "sent"'. Anything a qualifier already
 * resolved is, by definition, something this workspace holds.
 */
export function readableWords(
  vocabulary: QualifierVocabulary,
  ledger: QualifierLedger,
  base: Set<string>,
  measures: Iterable<string> = [],
): Set<string> {
  const out = new Set(base);
  for (const word of measures) out.add(word);
  const take = (phrase: string | undefined | null) => {
    for (const token of normalise(phrase ?? '').split(' ')) if (token.length > 1) out.add(token);
  };
  for (const pipeline of vocabulary.pipelines) { take(pipeline.label); take(pipeline.value.replace(/_/g, ' ')); }
  for (const stage of vocabulary.stages) {
    for (const alias of stage.aliases) take(alias.label);
    take(stage.value.replace(/_/g, ' '));
  }
  for (const entry of ledger.entries) {
    if (!entry.resolved) continue;
    take(entry.text);
    take(entry.resolved.label);
  }
  return out;
}

/**
 * A word nobody could resolve, sitting directly in front of the measure.
 *
 * "How much flurbo revenue did we book last quarter?" came back as the full
 * all-currency revenue answer with "flurbo" appearing nowhere in the run — no
 * qualifier, no refusal, no hedge. A content word adjacent to a bound measure
 * is a modifier of it, and an unresolvable modifier is a different measure. The
 * same silent path would swallow a real product line or segment.
 */
/**
 * The adjectives that name a *direction*, not a measure.
 *
 * "The least valuable open deal" put "valuable" directly in front of the
 * measure and it resolved to nothing, so the whole question was refused as
 * naming a measure this workspace does not hold — when the word is half of the
 * ranking the sentence already asked for.
 */
const DIRECTION_ADJECTIVE = new Set([
  'valuable', 'value', 'valued', 'priced', 'sized', 'biggest', 'largest', 'smallest', 'lowest',
  'highest', 'cheapest', 'best', 'worst', 'least', 'most', 'top', 'bottom', 'oldest', 'newest',
]);

export function unknownModifier(question: string, matched: string, unknown: string[]): string | null {
  if (!matched || !unknown.length) return null;
  const at = normalise(question).indexOf(normalise(matched));
  if (at <= 0) return null;
  const before = normalise(question).slice(0, at).trim().split(' ').filter(Boolean);
  const previous = before[before.length - 1];
  if (!previous || DIRECTION_ADJECTIVE.has(previous)) return null;
  // An auxiliary is not a modifier. "Which rep has the biggest book?" put "has"
  // in front of the measure and was refused with a sentence asserting that
  // "has" narrows Open pipeline to something this workspace does not hold —
  // a false statement about the reader's grammar, in place of an answer.
  if (CLOSED_CLASS.has(previous)) return null;
  const unresolved = new Set(unknown.map(normalise));
  return unresolved.has(previous) ? previous : null;
}

/* ------------------------------ what to say ------------------------------- */

/** What a person calls a qualifier of this kind, for a sentence rather than a field name. */
export const kindNoun = (kind: LedgerKind): string => KIND_NOUN[kind];

/**
 * The sentence a second mention earns when the run can only carry one.
 *
 * "How many deals are in Negotiation and Proposal sent?" is 18 deals across two
 * stages, and `business_metric` takes one stage. Answering 10 under the second
 * name — which is what a ledger holding one entry per kind did — is a precise
 * count of half the question. This says which half was measured and which was
 * not, instead.
 */
/** What to call this entry in a sentence: the dimension it names, or its kind. */
export const entryNoun = (entry: Qualifier): string =>
  (entry.noun ?? entry.resolved?.noun)?.toLowerCase() ?? KIND_NOUN[entry.kind];

export function crowdedOut(entry: Qualifier, held: Qualifier): string {
  const noun = entryNoun(entry);
  return [
    `I can scope one answer to a single ${noun}, and this run is scoped to ${held.resolved?.label ?? held.text}.`,
    `"${entry.text}" is a second ${noun}, so I have not folded it in — ask about it on its own,`,
    `or ask for the breakdown by ${noun} and you get both in one answer.`,
  ].join(' ');
}

/**
 * The refusal a question gets when one of its qualifiers could not be applied.
 *
 * It names the qualifier, says what did resolve, and offers the question the
 * engine *can* answer — because the alternative that shipped was the workspace
 * total under the reader's own scoped sentence.
 */
export function qualifierRefusal(
  blocking: Qualifier[],
  workspaceName: string,
  options: { stages?: string[]; pipelines?: string[]; metrics?: string[]; owners?: string[]; accounts?: string[] } = {},
): { code: string; why: string; content: string } | null {
  if (!blocking.length) return null;
  const first = blocking[0];
  const kindWord: Record<LedgerKind, string> = { ...KIND_NOUN, owner: 'owner' };
  const wordFor = (q: Qualifier): string => (q.noun ?? q.resolved?.noun)?.toLowerCase() ?? kindWord[q.kind];
  const menu = first.kind === 'stage' && options.stages?.length
    ? ` The stages ${workspaceName} has are ${listPhrase(options.stages.map((s) => `"${s}"`))}.`
    : first.kind === 'pipeline' && options.pipelines?.length
      ? ` The pipelines ${workspaceName} has are ${listPhrase(options.pipelines.map((p) => `"${p}"`))}.`
      : first.kind === 'metric' && options.metrics?.length
        ? ` I can compute ${listPhrase(options.metrics.slice(0, 8).map((m) => m.toLowerCase()))}.`
        : first.kind === 'owner' && options.owners?.length
          ? ` The people who own records in ${workspaceName} are ${listPhrase(options.owners.map((o) => o))}.`
          : first.kind === 'account' && options.accounts?.length
            ? ` The nearest names I do hold are ${listPhrase(options.accounts.slice(0, 5).map((a) => `"${a}"`))}.`
            : '';
  const named = listPhrase(blocking.map((q) => `the ${wordFor(q)} "${q.text}"`));
  // The reason the entry carries beats the generic one, and replaces the
  // sentence in front of it rather than following it: "I could not apply it to
  // anything I can measure" reads as a contradiction over "I can only take one,
  // and this run took Negotiation".
  const opening = first.detail
    ? `You asked about ${named}. ${first.detail}`
    : `You asked about ${named}, and I could not apply ${blocking.length === 1 ? 'it' : 'them'} to anything I can measure.`
      + ` I could not scope the query to the ${wordFor(first)} you named.`;
  return {
    code: 'qualifier_unbound',
    why: `${blocking.length} ${blocking.length === 1 ? 'qualifier' : 'qualifiers'} could not be bound: ${blocking.map((q) => `${q.kind} "${q.text}"`).join(', ')}.`,
    content: [
      opening,
      `I have not answered the unscoped question instead — ${workspaceName}'s total is a precise answer to a question you did not ask.${menu}`,
    ].join(' '),
  };
}

/**
 * The sentence a waived qualifier earns, which goes first — not in a footnote.
 */
export function waiverSentence(ledger: QualifierLedger): string | null {
  const waived = ledger.waived();
  if (!waived.length) return null;
  return `${listPhrase(waived.map((q) => `"${q.text}"`))} ${waived.length === 1 ? 'is' : 'are'} not applied to this answer: ${waived.map((q) => q.detail).filter(Boolean).join(' ')}`;
}
