/**
 * What one assistant turn shows, decided in one place.
 *
 * The card used to make its decisions inline — a dozen banners, each reading
 * the question with its own regex and each finding a reason to fire on answers
 * that were right. Everything the card draws now comes out of `answerCard`, so
 * a corpus of correct template answers can be run through it and the number
 * of banners counted: zero.
 */
import { carriedMeasure, nearestFromReasoning, noWritePrepared, refusalOf, splitRefusalOffer, writeNeedsSwitch } from './answer-core';
import { bindingOf, numberAsked, slotChips, type SlotChip, type SlotFormat } from './slots-core';
import type { ToolCallLike, Vocabulary } from './scope-core';
import {
  engineLine, engineOf, nearestFromWire, nearestTemplates,
  type AiTemplate, type Engine, type EngineLine, type NearestChip, type NearestOnWire,
} from './templates-core';

/** What the completion said about a run, kept for the session by run id. */
export interface Remembered {
  engine: Engine | null;
  nearest: NearestOnWire[] | null;
  template: unknown;
  /** The completion's `analysis`, whose `qualifiers` are the slots it bound. */
  analysis?: unknown;
}

/** The facts about a run this decision reads. Every field is optional on purpose. */
export interface RunFacts {
  status?: string | null;
  error?: string | null;
  reasoning?: string[] | null;
  provider?: string | null;
  model?: string | null;
  engine?: string | null;
  nearest?: NearestOnWire[] | null;
  template?: unknown;
  analysis?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The nearest shapes wherever the engine put them.
 *
 * The completion documents `nearest` at the top level and sends it inside
 * `analysis` — the client read the first, remembered `undefined`, and drew
 * three shapes it had ranked itself under a refusal that listed three others
 * in its own prose. A run carries neither, but its working notes carry the
 * examples. All of it is read, in that order.
 */
export function nearestOf(
  source: { nearest?: NearestOnWire[] | null; analysis?: unknown; reasoning?: string[] | null } | null | undefined,
): NearestOnWire[] | null {
  if (!source) return null;
  if (Array.isArray(source.nearest) && source.nearest.length) return source.nearest;
  const analysis = source.analysis;
  if (isRecord(analysis) && Array.isArray(analysis.nearest)) {
    const rows = analysis.nearest.filter(isRecord).map((row) => ({
      id: typeof row.id === 'string' ? row.id : null,
      template_id: typeof row.template_id === 'string' ? row.template_id : null,
      example: typeof row.example === 'string' ? row.example : null,
    }));
    if (rows.length) return rows;
  }
  const noted = nearestFromReasoning(source.reasoning);
  return noted.length ? noted : null;
}

export interface TurnInput {
  question: string;
  /** The answer's prose, whose closing "Try one of these" list is the engine's own offer. */
  content?: string;
  toolCalls: readonly ToolCallLike[];
  run: RunFacts | null | undefined;
  remembered: Remembered | null | undefined;
  templates: readonly AiTemplate[];
  /** Whether a hosted model is configured on this workspace. */
  hosted: boolean;
  vocab: Vocabulary;
  format: SlotFormat;
}

export interface Refusal {
  code: string;
  /** The engine's own reason, when it wrote one apart from the answer text. */
  message: string | null;
  nearest: NearestChip[];
  /** False when the chips were ranked by wording and nothing overlapped. */
  matched: boolean;
}

export type CardBanner = 'refused' | 'failed' | 'no_write' | 'switch_off';

export interface AnswerCard {
  engine: Engine;
  indicator: EngineLine;
  refusal: Refusal | null;
  slots: SlotChip[];
  noWrite: { tool: string; why: string } | null;
  /** A write asked for with "Let it prepare writes" off: the switch is the fix. */
  switchOff: { tool: string } | null;
  /**
   * The measure a bare follow-up inherited, and the question it came from.
   *
   * Stated, never offered as removable: taking the measure off "And by owner?"
   * leaves nothing to ask. A carried *record* is a different thing and this
   * engine does not carry one — a later question that named no subject was once
   * answered for an earlier one's account, and the fix was to stop.
   */
  carried: { measure: string; from: string } | null;
  failed: string | null;
  /** Every banner the card will draw. A scoped answer draws none. */
  banners: CardBanner[];
}

export function answerCard(input: TurnInput): AnswerCard {
  const { run, remembered } = input;
  const engine = engineOf(run, remembered?.engine ?? null);
  const indicator = engineLine(engine, input.hosted, run?.model);

  // The refusal line is read off the run's own notes; a run that carries none
  // is a run that refused nothing in words, whatever `nearest` says.
  const notes = run ? { reasoning: run.reasoning ?? undefined } : null;
  const refused = refusalOf(notes);
  // The engine's own list first — remembered from the completion, carried on
  // the run, or read off its notes — then the offer at the foot of the prose,
  // and only when every one of those is empty a guess ranked by wording.
  const wire = nearestOf(remembered) ?? nearestOf(run) ?? null;
  const offered = input.content ? splitRefusalOffer(input.content).offered : [];
  let refusal: Refusal | null = null;
  if (refused || (wire && wire.length) || offered.length) {
    const served = wire
      ? nearestFromWire(wire, input.templates)
      : nearestFromWire(offered.map((example) => ({ example })), input.templates);
    const ranked = served.length ? { chips: served, matched: true } : nearestTemplates(input.question, input.templates);
    refusal = {
      code: refused?.code ?? 'refused',
      message: refused?.message ?? null,
      nearest: ranked.chips,
      matched: ranked.matched,
    };
  }

  const carried = carriedMeasure({ reasoning: run?.reasoning ?? undefined, analysis: remembered?.analysis })
    ?? carriedMeasure({ reasoning: run?.reasoning ?? undefined, analysis: run?.analysis });
  const noWrite = noWritePrepared(notes);
  const switchOff = writeNeedsSwitch({ reasoning: run?.reasoning ?? undefined, analysis: remembered?.analysis });
  const failed = run?.status === 'failed' ? (run.error ?? 'The run failed before it answered.') : null;
  const slots = refusal
    ? []
    : slotChips({
      binding: bindingOf(remembered ?? undefined) ?? bindingOf(run ?? undefined),
      toolCalls: input.toolCalls,
      vocab: input.vocab,
      format: input.format,
      // The number the person typed, as the engine recorded binding it — from
      // the completion this session saw, or the run's own notes on a re-read.
      asked: numberAsked(remembered ?? undefined) ?? numberAsked(run ? { reasoning: run.reasoning } : undefined),
    });

  const banners: CardBanner[] = [];
  if (refusal) banners.push('refused');
  if (failed) banners.push('failed');
  if (noWrite) banners.push('no_write');
  if (switchOff) banners.push('switch_off');

  return { engine, indicator, refusal, slots, noWrite, switchOff, failed, carried, banners };
}
