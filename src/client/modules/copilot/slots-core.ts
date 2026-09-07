/**
 * The slot values an answer was bound to, read off the plan.
 *
 * A template answer is scoped by construction: the period, the owner, the
 * pipeline it ran over are arguments the plan actually passed, and those are
 * the only chips this surface draws. Nothing here reads the question, nothing
 * reads the prose, and nothing decides whether the answer was *right* — that
 * machinery guessed, and it guessed loudly on correct answers.
 *
 * Two sources, in order of preference. A run that carries its template binding
 * — `template: { id, slots: { period: "Q3 2026", owner: "Marcus Ilori" } }` —
 * is rendered from that verbatim. Otherwise the tool calls the turn recorded
 * are read for the dimensions they carried, which is the same plan seen from
 * its actions.
 */
import {
  boundScopeOf, cutsRows, humanizeName, labelOfPipeline, labelOfStage, windowText,
  type ToolCallLike, type Vocabulary,
} from './scope-core';

export interface SlotChip {
  /** `period`, `owner`, `pipeline`, … — the slot's own name. */
  kind: string;
  label: string;
  value: string;
  /**
   * The record this chip is bound to is real, but nothing on screen can name
   * it yet — the vocabulary or the citation that would is still in flight. The
   * chip says what it is bound to without asserting a name it does not have.
   */
  pending?: true;
  /**
   * The id behind the chip, kept so the screen can go and read the record's
   * name. It is never rendered: an id is not a name, and one on screen is the
   * defect this field exists to avoid printing.
   */
  id?: string;
}

/** A template binding as a run may carry it. Tolerant: absent on the old engine. */
export interface TemplateBinding {
  id: string;
  slots: Record<string, string | number | boolean | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The binding on a run or completion, when it carries one.
 *
 * Two shapes are read. `template: { id, slots: { period: "Q3 2026" } }` is the
 * binding stated outright. `analysis.qualifiers` is the engine's own ledger of
 * every slot it bound — `{ kind, text, state: "bound", resolved: { label } }`
 * — which the server documents as the one place a caller can see which words
 * of the sentence reached the query. Anything else is not a binding.
 */
export function bindingOf(source: { template?: unknown; analysis?: unknown } | null | undefined): TemplateBinding | null {
  const raw = source?.template;
  if (isRecord(raw) && typeof raw.id === 'string' && isRecord(raw.slots)) {
    const slots: TemplateBinding['slots'] = {};
    for (const [name, value] of Object.entries(raw.slots)) {
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        slots[name] = value as string | number | boolean | null;
      }
    }
    return { id: raw.id, slots };
  }
  const analysis = source?.analysis;
  if (!isRecord(analysis) || !Array.isArray(analysis.qualifiers)) return null;
  const slots: TemplateBinding['slots'] = {};
  for (const entry of analysis.qualifiers) {
    if (!isRecord(entry) || typeof entry.kind !== 'string' || entry.state !== 'bound') continue;
    const resolved = isRecord(entry.resolved) ? entry.resolved : null;
    const value = resolved && typeof resolved.label === 'string' && resolved.label
      ? resolved.label
      : resolved && typeof resolved.value === 'string' && resolved.value
        ? resolved.value
        : typeof entry.text === 'string' ? entry.text : '';
    if (!value) continue;
    slots[entry.kind] = slots[entry.kind] ? `${slots[entry.kind]}, ${value}` : value;
  }
  const id = typeof analysis.template === 'string' ? analysis.template : typeof analysis.intent === 'string' ? analysis.intent : 'analysis';
  return Object.keys(slots).length ? { id, slots } : null;
}

/** The binding as chips: one per slot the template filled. */
export function slotChipsFromBinding(binding: TemplateBinding): SlotChip[] {
  return Object.entries(binding.slots)
    .filter(([, value]) => value !== null && value !== '')
    .map(([name, value]) => ({ kind: name, label: humanizeName(name), value: String(value) }));
}

export interface SlotFormat {
  window(w: { start: number | null; end: number | null; label: string | null }): string;
  /** A person or record id as its display name, or null when nothing knows it yet. */
  name(id: string): string | null;
}

/**
 * Tools that change the workspace rather than measure it. Their arguments name
 * the record being written, which is not a scope, and the approval card already
 * states every one of them.
 */
const WRITES = /^(create|update|delete|log|send|move|assign)_/;

/**
 * The number the engine bound from the question, if it bound one.
 *
 * "Top 5 customers by revenue" binds `{number} = 5`; "Which invoices are
 * overdue?" binds no number at all and its plan still carries `limit: 25`,
 * because every list tool takes a page size. The chip strip used to print
 * that page size as "TOP 25" — a claim the person never made. The engine
 * records what it bound in two places this client can read: the completion's
 * `analysis.slots`, and the run's own note `Matched "top-n-accounts":
 * {number} = 5, …`. Neither is the wording of the question.
 */
export function numberAsked(source: { analysis?: unknown; reasoning?: readonly string[] | null } | null | undefined): number | null {
  const analysis = source?.analysis;
  if (isRecord(analysis) && Array.isArray(analysis.slots)) {
    for (const slot of analysis.slots) {
      if (!isRecord(slot) || (slot.kind !== 'number' && slot.name !== 'number')) continue;
      const value = Number(typeof slot.label === 'string' && slot.label ? slot.label : slot.text);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  for (const line of source?.reasoning ?? []) {
    const match = /^Matched "[^"]+":.*\{number\} = (\d+)/.exec(line.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * The dimensions every measuring call in the plan actually narrowed on.
 *
 * `asked` is the number the engine bound from the question, when it bound
 * one: a `limit` in the plan is drawn as a Top chip only when it is that
 * number, because a page size nobody asked for is not a scope.
 */
export function slotChipsFromPlan(
  calls: readonly ToolCallLike[],
  vocab: Vocabulary,
  f: SlotFormat,
  asked: number | null = null,
): SlotChip[] {
  const out: SlotChip[] = [];
  const push = (chip: SlotChip) => {
    // Two turns can bind the same record before and after its name arrives, so
    // identity is the record, not the placeholder standing in for it.
    const same = (c: SlotChip) => c.kind === chip.kind && (chip.id ? c.id === chip.id : c.value === chip.value);
    if (!out.some(same)) out.push(chip);
  };
  for (const call of calls) {
    if (WRITES.test(call.name)) continue;
    const scope = boundScopeOf(call, vocab);
    const metric = scope.metric ? vocab.metrics.find((m) => m.id === scope.metric) : undefined;
    if (scope.metric) push({ kind: 'metric', label: 'Measure', value: metric?.label ?? humanizeName(scope.metric) });
    // A snapshot measure ignores the window it was handed: "as of now" is the
    // truthful period, and "Period Q3 2026" over it would be the chip lying.
    if (metric?.snapshot) push({ kind: 'period', label: 'As of', value: 'now' });
    else if (scope.window) push({ kind: 'period', label: 'Period', value: f.window(scope.window) });
    if (scope.pipeline) push({ kind: 'pipeline', label: 'Pipeline', value: labelOfPipeline(scope.pipeline, vocab) });
    if (scope.stages.length) {
      push({
        kind: 'stage',
        label: scope.stages.length === 1 ? 'Stage' : 'Stages',
        value: scope.stages.map((stage) => labelOfStage(stage, scope.pipeline, vocab)).join(', '),
      });
    }
    if (scope.status) push({ kind: 'status', label: 'Status', value: scope.status });
    if (scope.ownerId) push({ kind: 'owner', label: 'Owner', ...named(scope.ownerId, f) });
    if (scope.subjectId) push({ kind: 'account', label: 'Account', ...named(scope.subjectId, f) });
    if (scope.objectType) push({ kind: 'object', label: 'Records', value: humanizeName(scope.objectType) });
    if (scope.groupBy) push({ kind: 'group', label: 'By', value: humanizeName(scope.groupBy) });
    if (scope.limit !== null && asked !== null && scope.limit === asked && cutsRows(scope)) {
      push({ kind: 'limit', label: 'Top', value: String(scope.limit) });
    }
    if (scope.currency) push({ kind: 'currency', label: 'Book', value: scope.currency.toUpperCase() });
  }
  return out;
}

/**
 * Anything shaped like one of this platform's ids.
 *
 * Deliberately a shape and not a list of prefixes. The list was the defect
 * twice: it named `cmp|con|deal|tkt`, so an owner's `usr_seed01` and an
 * account's `cus_…` walked onto the screen past a guard written to stop
 * exactly that. A new record type must not need this file edited to stay off
 * the screen — the safe default is that an id-shaped value is never a name.
 */
export const looksLikeRecordId = (value: string): boolean => /^[a-z]{2,8}_[A-Za-z0-9_]{4,}$/.test(value);

/** A name if the workspace knows one, else the chip is left pending. */
const named = (id: string, f: SlotFormat): Pick<SlotChip, 'value' | 'pending' | 'id'> => {
  const label = f.name(id);
  return label && !looksLikeRecordId(label) ? { value: label, id } : { value: '…', pending: true, id };
};

/**
 * The chips still carrying a record id where a name belongs.
 *
 * A chip's names come from the citations and the teammates; a plan that
 * measured an account which cited nothing leaves `cmp_nw_42` unnamed. The
 * screen reads those records once and draws the chips again with the names.
 * Ids it cannot read this way stay pending rather than printing themselves.
 */
export function rawRecordIds(slots: readonly SlotChip[]): string[] {
  const out: string[] = [];
  for (const slot of slots) {
    // Either shape of leak: a chip still waiting for a name, and a chip whose
    // value is itself an id because something upstream handed one over.
    const id = slot.pending ? slot.id : (looksLikeRecordId(slot.value) ? slot.value : undefined);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The chips for one turn: the binding when the run carries it, else the plan's calls. */
export function slotChips(input: {
  binding: TemplateBinding | null;
  toolCalls: readonly ToolCallLike[];
  vocab: Vocabulary;
  format: SlotFormat;
  /** The number the engine bound from the question, when it bound one. */
  asked?: number | null;
}): SlotChip[] {
  const bound = input.binding ? slotChipsFromBinding(input.binding) : [];
  return bound.length ? bound : slotChipsFromPlan(input.toolCalls, input.vocab, input.format, input.asked ?? null);
}

export { windowText };
