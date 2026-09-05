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
  /** A person or record id as its display name — or the id, when nothing knows it. */
  name(id: string): string;
}

/**
 * Tools that change the workspace rather than measure it. Their arguments name
 * the record being written, which is not a scope, and the approval card already
 * states every one of them.
 */
const WRITES = /^(create|update|delete|log|send|move|assign)_/;

/** The dimensions every measuring call in the plan actually narrowed on. */
export function slotChipsFromPlan(calls: readonly ToolCallLike[], vocab: Vocabulary, f: SlotFormat): SlotChip[] {
  const out: SlotChip[] = [];
  const push = (chip: SlotChip) => {
    if (!out.some((c) => c.kind === chip.kind && c.value === chip.value)) out.push(chip);
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
    if (scope.ownerId) push({ kind: 'owner', label: 'Owner', value: f.name(scope.ownerId) });
    if (scope.subjectId) push({ kind: 'account', label: 'Account', value: f.name(scope.subjectId) });
    if (scope.objectType) push({ kind: 'object', label: 'Records', value: humanizeName(scope.objectType) });
    if (scope.groupBy) push({ kind: 'group', label: 'By', value: humanizeName(scope.groupBy) });
    if (scope.limit !== null && cutsRows(scope)) push({ kind: 'limit', label: 'Top', value: String(scope.limit) });
    if (scope.currency) push({ kind: 'currency', label: 'Book', value: scope.currency.toUpperCase() });
  }
  return out;
}

/** The chips for one turn: the binding when the run carries it, else the plan's calls. */
export function slotChips(input: {
  binding: TemplateBinding | null;
  toolCalls: readonly ToolCallLike[];
  vocab: Vocabulary;
  format: SlotFormat;
}): SlotChip[] {
  const bound = input.binding ? slotChipsFromBinding(input.binding) : [];
  return bound.length ? bound : slotChipsFromPlan(input.toolCalls, input.vocab, input.format);
}

export { windowText };
