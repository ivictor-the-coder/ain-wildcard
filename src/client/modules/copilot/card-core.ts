/**
 * What one assistant turn shows, decided in one place.
 *
 * The card used to make its decisions inline — a dozen banners, each reading
 * the question with its own regex and each finding a reason to fire on answers
 * that were right. Everything the card draws now comes out of `answerCard`, so
 * a corpus of correct template answers can be run through it and the number
 * of banners counted: zero.
 */
import { noWritePrepared, refusalOf } from './answer-core';
import { bindingOf, slotChips, type SlotChip, type SlotFormat } from './slots-core';
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

export interface TurnInput {
  question: string;
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

export type CardBanner = 'refused' | 'failed' | 'no_write';

export interface AnswerCard {
  engine: Engine;
  indicator: EngineLine;
  refusal: Refusal | null;
  slots: SlotChip[];
  noWrite: { tool: string; why: string } | null;
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
  const wire = remembered?.nearest ?? run?.nearest ?? null;
  let refusal: Refusal | null = null;
  if (refused || (wire && wire.length)) {
    const served = wire ? nearestFromWire(wire, input.templates) : [];
    const ranked = served.length ? { chips: served, matched: true } : nearestTemplates(input.question, input.templates);
    refusal = {
      code: refused?.code ?? 'refused',
      message: refused?.message ?? null,
      nearest: ranked.chips,
      matched: ranked.matched,
    };
  }

  const noWrite = noWritePrepared(notes);
  const failed = run?.status === 'failed' ? (run.error ?? 'The run failed before it answered.') : null;
  const slots = refusal
    ? []
    : slotChips({
      binding: bindingOf(remembered ?? undefined) ?? bindingOf(run ?? undefined),
      toolCalls: input.toolCalls,
      vocab: input.vocab,
      format: input.format,
    });

  const banners: CardBanner[] = [];
  if (refusal) banners.push('refused');
  if (failed) banners.push('failed');
  if (noWrite) banners.push('no_write');

  return { engine, indicator, refusal, slots, noWrite, failed, banners };
}
