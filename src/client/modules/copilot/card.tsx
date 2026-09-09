/**
 * The three things every answer card says about itself, as hook-free pieces.
 *
 * Which engine answered; where to go when it refused; and the slot values the
 * template was bound to. Each takes what `answerCard` decided and draws it —
 * nothing here reads a question or a sentence of prose.
 */
import { Button, Icons } from '@/client/design';
import type { Refusal } from './card-core';
import type { SlotChip } from './slots-core';
import type { EngineLine } from './templates-core';

/**
 * "answered from a template" / "answered by the model".
 *
 * The footnote about what free text takes — a hosted model, an environment
 * variable — is said once, in the empty state and the "What can I ask?"
 * panel, where a person deciding what to ask will read it. It used to be
 * repeated on every card: thirty answers, thirty env vars in front of a sales
 * manager. The card keeps it as the tooltip, where the curious can find it.
 */
export function EngineIndicator({ line }: { line: EngineLine }) {
  const Glyph = line.engine === 'anthropic' ? Icons.sparkles : Icons.bolt;
  return (
    <span
      className={`cp-engine cp-engine--${line.engine}`}
      title={line.detail}
      data-engine={line.engine}
      data-needs-key={line.needsKey ? 'true' : undefined}
    >
      <Glyph size={11} />
      <span>{line.label}</span>
    </span>
  );
}

/**
 * A money measure the engine would not narrow to the currency that was named.
 *
 * The engine's own reason for this is a statement about the whole measure —
 * "Overdue balance is measured from records that carry no currency book in
 * this workspace … the figure I hold is the whole of it, in USD" — written
 * from a read that had already been narrowed to the currency. The same measure
 * asked without one answers "held in 2 currencies … $127,840.00 in USD and
 * €1,007.00 in EUR", so the sentence is not true of this workspace and the
 * surface does not repeat it. What is said instead is what this screen can
 * stand behind, and the question that gets a real answer is a press away.
 *
 * Drawn the same on the conversation and on the run's own page: a refusal that
 * reads as fact in one place and as a caveat in the other is two answers.
 */
export function CurrencyRefusalNote({ refusal, onAsk }: {
  refusal: { measure: string; currency: string; unscoped: string | null };
  onAsk?: (question: string) => void;
}) {
  const { currency, unscoped } = refusal;
  return (
    <>
      <p>
        Its reason is a claim about the whole measure, not about the {currency} book — and the same measure asked
        without a currency comes back as one figure per book, because this platform holds no exchange rates and never
        adds them together. That answer is what says whether {currency} is missing here or simply empty.
      </p>
      {unscoped && (
        <p className="cp-chips" style={{ marginTop: 'var(--space-3)' }}>
          <Button size="sm" variant="secondary" iconLeft={<Icons.sparkles size={13} />} onClick={() => onAsk?.(unscoped)}>
            {unscoped}
          </Button>
        </p>
      )}
    </>
  );
}

/** The banner title both surfaces put that note under. */
export const currencyRefusalTitle = (refusal: { measure: string; currency: string }): string =>
  `The copilot will not narrow ${refusal.measure} to ${refusal.currency}`;

/**
 * What a bare follow-up inherited from the question before it.
 *
 * "And by owner?" is a breakdown of something, and the something is two turns
 * up the screen. The card says which measure it carried and which question it
 * came from — and offers no way to take it off, because a follow-up with its
 * measure removed is not a question at all. (A carried *record* would be
 * different, and this engine deliberately carries none.)
 */
export function CarriedMeasure({ carried }: { carried: { measure: string; from: string } }) {
  const Corner = Icons['corner-down-right'];
  return (
    <p className="cp-carried">
      {Corner && <Corner size={12} aria-hidden />}
      <span className="cp-carried__key">Carried into this question</span>
      <span className="cp-carried__measure">{carried.measure}</span>
      <span className="cp-carried__from u-truncate" title={carried.from}>from “{carried.from}”</span>
    </p>
  );
}

/**
 * The way out of a refusal: the nearest shapes it does answer, one press each.
 *
 * This is the main interaction of the surface now. A refusal with nothing
 * under it is a dead end; a refusal with three real questions under it is a
 * menu.
 */
export function RefusalHelp({ refusal, onAsk, onSeeAll }: {
  refusal: Refusal;
  onAsk: (question: string) => void;
  onSeeAll?: () => void;
}) {
  const label = refusal.nearest.length
    ? (refusal.matched ? 'Closest questions it can answer' : 'Some questions it can answer')
    : 'No question shape is close to that one';
  return (
    <div className="cp-help" data-refusal={refusal.code}>
      <span className="cp-help__label">{label}</span>
      {refusal.nearest.map((chip) => (
        <button
          key={chip.templateId + chip.question}
          type="button"
          className="cp-help__chip"
          data-template-id={chip.templateId}
          title={`Ask “${chip.question}”`}
          onClick={() => onAsk(chip.question)}
        >
          <Icons.sparkles size={12} />
          <span>{chip.question}</span>
        </button>
      ))}
      {onSeeAll && (
        <button type="button" className="cp-help__more" onClick={onSeeAll}>
          <Icons.list size={12} />
          See everything it can answer
        </button>
      )}
    </div>
  );
}

const SLOT_ICON: Record<string, keyof typeof Icons> = {
  pipeline: 'columns',
  stage: 'flag',
  owner: 'user',
  period: 'calendar',
  status: 'check',
  metric: 'gauge',
  limit: 'list',
  account: 'building',
  currency: 'coins',
  object: 'database',
  group: 'layers',
  plan: 'tag',
  meter: 'activity',
};

/** The slot values this answer was bound to — the plan's own arguments, nothing inferred. */
export function SlotChips({ slots, label = 'Bound to' }: { slots: SlotChip[]; label?: string }) {
  if (!slots.length) return null;
  return (
    <div className="cp-slots" role="list" aria-label={label}>
      <span className="cp-slots__label">{label}</span>
      {slots.map((slot) => {
        const Glyph = Icons[SLOT_ICON[slot.kind] ?? 'tag'];
        return (
          <span
            className="cp-slot"
            role="listitem"
            key={`${slot.kind}:${slot.id ?? slot.value}`}
            // The title carries no id either: a tooltip is on screen too.
            title={slot.pending ? `${slot.label}: looking up the name` : `${slot.label}: ${slot.value}`}
            data-slot={slot.kind}
            data-pending={slot.pending ? '' : undefined}
          >
            <Glyph size={11} />
            <span className="cp-slot__key">{slot.label}</span>
            <span className="u-truncate">{slot.value}</span>
          </span>
        );
      })}
    </div>
  );
}
