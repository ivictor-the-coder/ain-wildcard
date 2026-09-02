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
 */
import type { Ctx } from '../kernel/context';
import { hasTable } from './grounding';
import { extractMentions, type ResolvedEntity } from './resolve';
import type { PeriodMention, TimeWindow } from './dates';
import type { MetricDetection } from './metrics';
import type { TaskIntent } from './intent';
import { COMMON_WORDS, STOPWORDS, listPhrase, normalise } from './text';

export type QualifierKind =
  | 'pipeline' | 'stage' | 'owner' | 'account' | 'period'
  | 'status' | 'metric' | 'meter' | 'currency' | 'unit' | 'limit';

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
  kind: QualifierKind;
  /** The value a query takes. */
  value: string | number;
  /** What a person calls it. */
  label: string;
  /** The CRM property this qualifier filters, when it is a record filter. */
  property?: string;
  /**
   * The set of stored values this qualifier stands for, when it is a word
   * rather than a value. "Lost" is not a stage — it is every stage this
   * workspace marks closed-and-not-won — so the binding is checked against the
   * set, not against the word.
   */
  values?: (string | number)[];
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
  kind: QualifierKind;
  /** The words in the question that produced this entry. */
  text: string;
  /** What the text resolved to, or `null` when it named nothing of this kind. */
  resolved: QualifierValue | null;
  state: QualifierState;
  binding: QualifierBinding | null;
  /** Why it was refused, or what the answer ignores. */
  detail: string | null;
}

export interface QualifierViolation {
  kind: QualifierKind;
  text: string;
  reason: 'unsettled' | 'type_mismatch' | 'step_missing' | 'argument_missing' | 'value_mismatch' | 'waiver_unexplained';
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
const SLOTS: Record<QualifierKind, { args: string[]; conditions: string[] }> = {
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
};

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
    if (entry.kind === 'limit' && !returnsRows(step)) continue;
    for (const name of slot.args) {
      if (!(name in step.args)) continue;
      const held = step.args[name];
      if (Array.isArray(held) ? held.some((v) => sameScalar(v, resolved.value)) : sameScalar(held, resolved.value)) {
        return { tool: step.tool, args: { [name]: held }, note: `${resolved.label} is the \`${name}\` argument of ${step.tool}.` };
      }
    }
    const conditions = step.args.conditions;
    if (!Array.isArray(conditions)) continue;
    for (const property of slot.conditions) {
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
const KIND_NOUN: Record<QualifierKind, string> = {
  pipeline: 'pipeline', stage: 'deal stage', owner: 'teammate', account: 'account', period: 'period',
  status: 'status', metric: 'measure', meter: 'meter', currency: 'currency', unit: 'unit', limit: 'ranking cut-off',
};

export class QualifierLedger {
  private readonly items: Qualifier[];

  constructor(items: Qualifier[] = []) {
    this.items = items;
  }

  get entries(): readonly Qualifier[] { return this.items; }

  add(entry: Qualifier): void { this.items.push(entry); }

  all(kind: QualifierKind): Qualifier[] { return this.items.filter((q) => q.kind === kind); }

  first(kind: QualifierKind): Qualifier | undefined { return this.items.find((q) => q.kind === kind); }

  /** The resolved value for a kind, or null when the question named none. */
  value(kind: QualifierKind): string | number | null {
    return this.first(kind)?.resolved?.value ?? null;
  }

  label(kind: QualifierKind): string | null {
    return this.first(kind)?.resolved?.label ?? null;
  }

  /** Declare that a qualifier became part of a query. Checked in `verify`. */
  bind(kind: QualifierKind, binding: QualifierBinding): void {
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

  /** Settle one entry by hand, when a rule applies to that entry and not its kind. */
  mark(entry: Qualifier, state: Exclude<QualifierState, 'pending'>, detail: string): void {
    if (entry.state !== 'pending') return;
    entry.state = state;
    entry.detail = detail;
  }

  /** The engine could not scope the query to this qualifier, so it answers nothing. */
  refuse(kind: QualifierKind, why: string): void {
    for (const entry of this.items) {
      if (entry.kind !== kind || entry.state !== 'pending') continue;
      entry.state = 'refused';
      entry.detail = why;
    }
  }

  /** The capability genuinely cannot take it — the answer must say so up front. */
  waive(kind: QualifierKind, why: string): void {
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
      if (!entry.resolved || entry.state !== 'bound') continue;
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
export interface StageTerm { value: string; label: string; pipelines: string[]; closed: boolean; won: boolean }

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
      held.pipelines.push(row.pipeline);
      // Two pipelines can label one stage value differently. Both labels have
      // to match the question, so the longer, more specific one is kept and
      // the other stays reachable through `name`.
      if (row.label.length > held.label.length) held.label = row.label;
      continue;
    }
    byValue.set(row.name, {
      value: row.name, label: row.label, pipelines: [row.pipeline],
      closed: row.is_closed === 1, won: row.is_won === 1,
    });
  }
  const vocabulary = { pipelines, stages: [...byValue.values()] };
  vocabularyCache.set(key, { stamp, vocabulary });
  return vocabulary;
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
      `SELECT DISTINCT ${column} AS unit FROM ${table} WHERE org_id = ? AND ${column} IS NOT NULL AND ${column} <> ''`, orgId)) {
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

/** The unit a question asks its answer to be denominated in, if any. */
export function unitIn(question: string, units: string[]): string | null {
  if (!QUANTITY_QUESTION.test(question) || PRICE_OR_MONEY.test(question)) return null;
  const text = ` ${normalise(question)} `;
  for (const unit of units) {
    if (phraseAt(text, unit) || phraseAt(text, `${unit}s`)) return unit;
  }
  return null;
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
  const entry = ledger.pending().find((q) => q.kind === 'unit');
  if (!entry?.resolved) return;
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

export function dateNounIn(question: string): { property: string; label: string; text: string } | null {
  for (const noun of DATE_NOUNS) {
    const hit = question.match(noun.pattern);
    if (hit) return { property: noun.property, label: noun.label, text: hit[0] };
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
export function pipelineIn(question: string, vocabulary: QualifierVocabulary): { term: PipelineTerm; text: string } | null {
  const text = ` ${normalise(question)} `;
  const stageLabels = new Set(vocabulary.stages.flatMap((st) => [normalise(st.label), normalise(st.value.replace(/_/g, ' '))]));
  let best: { term: PipelineTerm; text: string } | null = null;
  for (const term of vocabulary.pipelines) {
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
        ...(stageLabels.has(needle)
          ? []
          : [`in ${needle}`, `in the ${needle}`, `for ${needle}`, `for the ${needle}`, `${needle} deals`]),
      ];
      for (const phrase of phrases) {
        if (!phraseAt(text, phrase)) continue;
        if (!best || needle.length > normalise(best.term.label).length) best = { term, text: alias };
      }
    }
  }
  return best;
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
export function stageIn(question: string, vocabulary: QualifierVocabulary): { term: StageTerm; text: string } | null {
  const text = ` ${normalise(question)} `;
  let best: { term: StageTerm; text: string } | null = null;
  for (const term of vocabulary.stages) {
    for (const alias of new Set([term.label, term.value.replace(/_/g, ' ')])) {
      const needle = normalise(alias);
      if (needle.length < 4 || !phraseAt(text, needle)) continue;
      if (!best || needle.length > normalise(best.text).length) best = { term, text: alias };
    }
  }
  return best;
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
    const text = withoutLeadingFurniture(mention.text);
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
  /** A unit the question asked the answer to be denominated in. */
  unit: string | null;
  /** The stage values that count as open, won and lost here. */
  stages: { open: string[]; won: string[]; lost: string[] };
  /** The workspace's own name, which is never an account it does not have. */
  workspaceName?: string;
}

const entry = (
  kind: QualifierKind,
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
    const pipeline = pipelineIn(question, input.vocabulary);
    if (pipeline) {
      ledger.add(entry('pipeline', pipeline.text, {
        kind: 'pipeline', value: pipeline.term.value, label: pipeline.term.label, property: 'pipeline',
      }));
    } else {
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

    const stage = stageIn(question, input.vocabulary);
    // A stage name that is part of the measure's own name is the measure, not a
    // second filter. "Closed-won bookings" contains the stage "Closed won", and
    // reading it as a stage qualifier asked `business_metric` to narrow a
    // metric defined by that very stage set — which it correctly refuses,
    // leaving the comparison with no answer at all.
    const inMetricName = !!stage && !!input.metric
      && normalise(input.metric.matched).includes(normalise(stage.text));
    if (stage && !inMetricName) {
      ledger.add(entry('stage', stage.text, {
        kind: 'stage', value: stage.term.value, label: stage.term.label, property: 'deal_stage',
      }));
    } else if (!inMetricName) {
      const shaped = stageShapedPhrase(question);
      if (shaped && input.vocabulary.stages.length && !input.vocabulary.stages.some((s) => normalise(s.label) === normalise(shaped))) {
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
    ...input.vocabulary.stages.flatMap((st) => [st.label, st.value.replace(/_/g, ' ')]),
  ].filter(Boolean);
  const subjects = scoping ? namedSubjects(question, consumed) : [];

  const users = input.entities.filter((e) => e.entity.type === 'user' && e.score >= 0.55);
  const accountish = input.entities.filter((e) => ['company', 'customer', 'contact'].includes(e.entity.type));
  const accounts = accountish.filter((e) => e.score >= 0.7);
  const claimed = new Set<string>();
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
    const user = users.find((u) => mentionCoversSubject(slot.text, u.mention));
    if (user) {
      claimed.add(nameKey(slot.text));
      if (!ledger.first('owner')) ledger.add(entry('owner', user.mention, ownerValue(user)));
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
    if (claimed.has(nameKey(slot.text))) continue;
    const account = accounts.find((a) => mentionCoversSubject(slot.text, a.mention));
    if (account) {
      claimed.add(nameKey(slot.text));
      if (!ledger.first('account')) ledger.add(entry('account', account.mention, accountValue(account)));
      continue;
    }
    // A teammate's own name in a slot that reads as an account is still a
    // teammate: "what is the Renewal pipeline worth for Priya Raman" is scoped
    // to a rep, and refusing it as a company nobody has heard of is worse than
    // the substitution it was meant to stop.
    const teammate = users.find((u) => mentionCoversSubject(slot.text, u.mention));
    if (teammate) {
      claimed.add(nameKey(slot.text));
      if (!ledger.first('owner')) ledger.add(entry('owner', teammate.mention, ownerValue(teammate)));
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
  if (!ledger.first('account') && accounts.length) {
    ledger.add(entry('account', accounts[0].mention, accountValue(accounts[0])));
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
    const record = (status: 'open' | 'won' | 'lost', text: string, label: string, values: string[]) => {
      if (implied === status) return;
      ledger.add(entry('status', text, { kind: 'status', value: status, label, property: 'deal_stage', values }));
    };
    if (!stageNamed) {
      if (LOST_WORDS.test(question) && input.stages.lost.length) {
        record('lost', question.match(LOST_WORDS)![0], 'closed lost', input.stages.lost);
      } else if (WON_WORDS.test(question) && input.stages.won.length) {
        record('won', question.match(WON_WORDS)![0], 'closed won', input.stages.won);
      } else if (OPEN_WORDS.test(question) && input.stages.open.length) {
        record('open', question.match(OPEN_WORDS)![0], 'open', input.stages.open);
      }
    }
  }

  if (input.meter) {
    ledger.add(entry('meter', input.meter.mention, {
      kind: 'meter', value: input.meter.entity.id, label: input.meter.entity.label,
    }));
  }
  if (input.currency) {
    ledger.add(entry('currency', input.currency, { kind: 'currency', value: input.currency, label: input.currency.toUpperCase() }));
  }
  if (input.unit) {
    ledger.add(entry('unit', input.unit, { kind: 'unit', value: input.unit, label: input.unit }));
  }
  if (input.limit !== null) {
    ledger.add(entry('limit', String(input.limit), { kind: 'limit', value: input.limit, label: `top ${input.limit}` }));
  }
  return ledger;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** "the biggest open deal", "our largest customer" — a cut-off of exactly one. */
const SINGULAR_SUPERLATIVE =
  /\b(?:the|our|my|its|their)\s+(?:single\s+)?(?:biggest|largest|highest|best|worst|lowest|smallest|top)\s+(?:open\s+|closed\s+|won\s+|lost\s+|active\s+|outstanding\s+|unpaid\s+)*(?:deal|opportunity|account|customer|company|logo|invoice|subscription|ticket|rep|owner|seller)\b(?!s)/i;

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
  const hit = question.match(new RegExp(`\\b(?:top|biggest|largest|highest|best|worst|lowest|first)\\s+(${words})\\b`, 'i'))
    ?? question.match(new RegExp(`\\b(${words})\\s+(?:biggest|largest|highest|best|worst|lowest|smallest)\\b`, 'i'));
  // A singular superlative is a cut-off of one. "Who owns the biggest open
  // deal?" came back as eight rows with no sentence naming an owner, because
  // the number the reader wrote was the word "the".
  if (!hit) return SINGULAR_SUPERLATIVE.test(question) ? 1 : null;
  const raw = hit[1].toLowerCase();
  const value = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw] ?? 0;
  return value >= 1 && value <= 100 ? value : null;
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
  for (const stage of vocabulary.stages) { take(stage.label); take(stage.value.replace(/_/g, ' ')); }
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
export function unknownModifier(question: string, matched: string, unknown: string[]): string | null {
  if (!matched || !unknown.length) return null;
  const at = normalise(question).indexOf(normalise(matched));
  if (at <= 0) return null;
  const before = normalise(question).slice(0, at).trim().split(' ').filter(Boolean);
  const previous = before[before.length - 1];
  if (!previous) return null;
  const unresolved = new Set(unknown.map(normalise));
  return unresolved.has(previous) ? previous : null;
}

/* ------------------------------ what to say ------------------------------- */

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
  const kindWord: Record<QualifierKind, string> = { ...KIND_NOUN, owner: 'owner' };
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
  const detail = first.detail ?? `I could not scope the query to the ${kindWord[first.kind]} you named.`;
  return {
    code: 'qualifier_unbound',
    why: `${blocking.length} ${blocking.length === 1 ? 'qualifier' : 'qualifiers'} could not be bound: ${blocking.map((q) => `${q.kind} "${q.text}"`).join(', ')}.`,
    content: [
      `You asked about ${listPhrase(blocking.map((q) => `the ${kindWord[q.kind]} "${q.text}"`))}, and I could not apply ${blocking.length === 1 ? 'it' : 'them'} to anything I can measure.`,
      detail,
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
