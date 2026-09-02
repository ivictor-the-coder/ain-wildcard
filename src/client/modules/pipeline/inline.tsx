/**
 * Editing a deal property where it is read.
 *
 * The record page used to show every field as text with one "Edit" button that
 * opened a modal holding the whole group — so correcting a next step meant
 * opening a form of eleven inputs, finding the one, and saving all of them.
 * Here each row is its own control: click the value, get the editor its
 * declared type asks for, press Enter, and one PATCH carries one property.
 *
 * The editors are the same `PropertyInput` the dialogs use, so a currency is a
 * money field in minor units, a date is the calendar, an enum is the
 * workspace's own option list — and a validation failure comes back bound to
 * the `param` the server named, under the field that caused it.
 *
 * Two properties are deliberately not editable here. `pipeline` and
 * `deal_stage` restamp the probability, the forecast category and the close
 * stamps, so they keep their confirmation; this row links to it rather than
 * quietly writing the most consequential field on the record.
 */
import { useEffect, useRef, useState } from 'react';
import { api, invalidate, useMutation } from '@/client/kernel/api';
import {
  Badge, Button, GitBranchIcon, Icons, useToast,
} from '@/client/design';
import { emptyValue, type DealRecord, type PropertyDef } from './api';
import { PropertyInput, errorFor } from './dialogs';

/** Properties whose write is a stage move, and therefore a confirmation. */
export const STAGE_OWNED = new Set(['pipeline', 'deal_stage']);

export interface InlinePropertyProps {
  deal: DealRecord;
  property: PropertyDef;
  currency: string;
  /** The stored value, rendered the way a person reads it. */
  display: string;
  onSaved: (updated: DealRecord) => void;
  /** Opens the stage confirmation, for the two properties that need one. */
  onMoveStage: () => void;
  onMovePipeline: () => void;
}

export function InlineProperty({
  deal, property, currency, display, onSaved, onMoveStage, onMovePipeline,
}: InlinePropertyProps) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<unknown>(deal.properties[property.name]);
  const [saved, setSaved] = useState(false);
  const readButton = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  /**
   * The editor's value as of this instant, not as of the last render.
   *
   * `MoneyInput` and `NumberInput` hold the text a person is typing and only
   * push a parsed number up when the field commits. Enter commits it — but the
   * keystroke then bubbles to the row, whose handler ran with the `value` from
   * the render *before* that push. It saw no change and cancelled, so every
   * numeric Enter silently threw the typed amount away while the hint under the
   * field promised "Enter saves". The ref is written in the same synchronous
   * turn as `setValue`, so the row's handler reads what was typed.
   */
  const live = useRef<unknown>(deal.properties[property.name]);
  const setLive = (next: unknown) => { live.current = next; setValue(next); };

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2400);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const save = useMutation<unknown, DealRecord>(
    (next) => api.patch<DealRecord>(`/v1/records/deal/${encodeURIComponent(deal.id)}`, {
      properties: { [property.name]: next },
    }),
    {
      invalidates: ['/v1/records/deal', '/v1/pipelines', '/v1/crm/overview'],
      onSuccess: (updated) => {
        invalidate(`/v1/records/deal/${deal.id}`);
        setEditing(false);
        setSaved(true);
        onSaved(updated);
        // The caret goes back to the row it came from — a save that drops focus
        // on the floor costs a keyboard user the whole list again.
        requestAnimationFrame(() => readButton.current?.focus());
      },
      // A message the server bound to this property is rendered under the
      // editor; anything else has nowhere to live on a single row.
      onError: (e) => {
        if (!errorFor(e, property.name)) toast.error(`${property.label} was not saved`, e.body.message);
      },
    },
  );

  const start = () => {
    setLive(deal.properties[property.name]);
    save.reset();
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    requestAnimationFrame(() => readButton.current?.focus());
  };

  const commit = () => {
    // A control that parses on blur — the date picker's text field, and any
    // editor a future property type brings — gets one last chance to push its
    // value up before the comparison is made. `blur()` dispatches focusout
    // synchronously, so `live` is current by the next line.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && editor.current?.contains(focused)) focused.blur();
    const before = deal.properties[property.name] ?? null;
    const next = live.current === undefined ? null : live.current;
    if (JSON.stringify(before) === JSON.stringify(next)) { cancel(); return; }
    void save.run(next).catch(() => undefined);
  };

  /* --------------------------- the two exceptions -------------------------- */

  if (STAGE_OWNED.has(property.name)) {
    return (
      <span className="pl-inline pl-inline--linked">
        <span className="pl-inline__text">{display}</span>
        {/* Named for what it opens, and deliberately not "Move stage" — the page
            header already carries a control by that name, and two buttons with
            one accessible name is a screen reader announcing the same thing for
            two different things. */}
        <Button
          size="sm"
          variant="link"
          iconLeft={<GitBranchIcon size={12} />}
          onClick={property.name === 'pipeline' ? onMovePipeline : onMoveStage}
        >
          {property.name === 'pipeline' ? 'Move to another pipeline' : 'Move to another stage'}
        </Button>
      </span>
    );
  }

  if (property.read_only || property.calculated) {
    return (
      <span className="pl-inline pl-inline--derived">
        <span className="pl-inline__text">{display}</span>
        <Badge size="sm" tone="neutral">derived</Badge>
      </span>
    );
  }

  /* -------------------------------- editing -------------------------------- */

  if (editing) {
    const error = errorFor(save.error, property.name);
    // A textarea keeps Enter for its own newlines; everything else submits on it.
    const multiline = property.type === 'text';
    return (
      <div
        className="pl-inline pl-inline--editing"
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
          if (e.key === 'Enter' && !multiline && !e.shiftKey) { e.preventDefault(); commit(); }
        }}
      >
        <div className="pl-inline__editor" ref={editor}>
          <PropertyInput
            property={property}
            value={value}
            onChange={setLive}
            currency={currency}
            autoFocus
            invalid={!!error}
          />
        </div>
        <div className="pl-inline__actions">
          <Button size="sm" variant="primary" loading={save.loading} onClick={commit}>Save</Button>
          <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
        </div>
        {error && <p className="pl-inline__error" role="alert">{error}</p>}
        {!error && <p className="pl-inline__hint">{multiline ? 'Escape cancels' : 'Enter saves · Escape cancels'}</p>}
      </div>
    );
  }

  return (
    <span className="pl-inline">
      <button
        type="button"
        ref={readButton}
        className={`pl-inline__read${emptyValue(deal.properties[property.name]) ? ' is-empty' : ''}`}
        onClick={start}
        aria-label={`Edit ${property.label}${emptyValue(deal.properties[property.name]) ? '' : ` — currently ${display}`}`}
      >
        <span className="pl-inline__text">{emptyValue(deal.properties[property.name]) ? `Add ${property.label.toLowerCase()}` : display}</span>
        <Icons.edit size={12} className="pl-inline__pencil" />
      </button>
      {saved && <Badge size="sm" tone="success" icon={<Icons.check size={10} />}>saved</Badge>}
    </span>
  );
}
