/**
 * A date you can type.
 *
 * The design system's picker is a calendar behind a button — right for a date
 * you are browsing towards, slow for one you already know. A forecast review
 * that pushes twelve close dates to the end of next month is twelve rounds of
 * clicking through months, where HubSpot takes `11/30` and moves on. This is a
 * text field that reads the workspace locale's own date order, with the same
 * calendar beside it for the days you do not know yet. Whatever is typed is
 * parsed on Enter or when the field is left; a string that is not a date is
 * marked and kept, never silently dropped or guessed at.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/client/kernel/session';
import {
  Button, Calendar, IconButton, Icons, Input, Popover, startOfMonthUtc,
} from '@/client/design';
import { dateExample, dateOrderOf, parseTypedDate, useDealFormat } from './api';

export interface DateFieldProps {
  value: number | null;
  onChange: (ts: number | null) => void;
  invalid?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}

export function DateField({ value, onChange, invalid, autoFocus, disabled, id, ...aria }: DateFieldProps) {
  const f = useDealFormat();
  const session = useSession();
  const order = useMemo(() => dateOrderOf(session.locale), [session.locale]);
  const today = f.calendarToday();
  const label = aria['aria-label'] ?? 'Date';

  const shown = (ts: number | null) => (ts === null ? '' : f.calendarDate(ts));
  const [text, setText] = useState(() => shown(value));
  const [bad, setBad] = useState(false);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => startOfMonthUtc(value ?? today));
  const anchor = useRef<HTMLButtonElement>(null);
  const day = useRef<HTMLButtonElement | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // A value set from outside — the calendar, a reset when a dialog reopens —
  // is what the field shows; a string still being typed is left alone.
  const lastValue = useRef(value);
  useEffect(() => {
    if (lastValue.current === value) return;
    lastValue.current = value;
    setText(shown(value));
    setBad(false);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (open) setMonth(startOfMonthUtc(value ?? today)); }, [open, value, today]);

  /** Read what was typed. Returns whether it was a date (or empty). */
  const commit = (): boolean => {
    const trimmed = text.trim();
    if (!trimmed) {
      setBad(false);
      if (value !== null) { lastValue.current = null; onChange(null); }
      return true;
    }
    const parsed = parseTypedDate(trimmed, order, today);
    if (parsed === null) { setBad(true); return false; }
    setBad(false);
    setText(shown(parsed));
    if (parsed !== value) { lastValue.current = parsed; onChange(parsed); }
    return true;
  };

  const pick = (ts: number | null) => {
    lastValue.current = ts;
    setText(shown(ts));
    setBad(false);
    onChange(ts);
    setOpen(false);
    input.current?.focus();
  };

  const example = dateExample(order, today);

  return (
    <div className={`pl-datefield${bad ? ' is-bad' : ''}`}>
      <Input
        ref={input}
        id={id}
        value={text}
        disabled={disabled}
        autoFocus={autoFocus}
        invalid={invalid || bad}
        placeholder={example}
        aria-label={label}
        aria-invalid={bad || undefined}
        aria-describedby={bad ? `${id ?? label.replace(/\W+/g, '-')}-datehint` : undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => { setText(e.target.value); if (bad) setBad(false); }}
        onBlur={() => { commit(); }}
        onKeyDown={(e) => {
          // Enter reads the date; it is not also a submit, because the form
          // around this field would read the value before it landed.
          if (e.key === 'Enter') {
            const changed = text.trim() !== shown(value);
            if (changed) { e.preventDefault(); if (!commit()) e.stopPropagation(); }
          }
        }}
      />
      <IconButton
        ref={anchor}
        size="md"
        label={`${label} calendar`}
        icon={<Icons.calendar size={15} />}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-end" flush ariaLabel="Choose a date" initialFocus={day}>
        {/* Escape here closes the calendar and nothing else. The popover is
            portaled, but React still bubbles the keystroke up this tree — to
            an inline row whose Escape throws the whole edit away. */}
        <div
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            setOpen(false);
            anchor.current?.focus();
          }}
        >
        <Calendar
          dayRef={day}
          value={value}
          month={month}
          onMonthChange={setMonth}
          onSelect={pick}
          locale={f.locale}
          today={today}
        />
        <div className="pl-datefield__foot">
          <Button size="sm" variant="ghost" onClick={() => pick(today)}>Today</Button>
          {value !== null && <Button size="sm" variant="ghost" onClick={() => pick(null)}>Clear</Button>}
        </div>
        </div>
      </Popover>
      {bad && (
        <p className="pl-datefield__hint" id={`${id ?? label.replace(/\W+/g, '-')}-datehint`} role="alert">
          “{text.trim()}” is not a date this workspace can read. Try {example}, {f.calendarDate(today, { withYear: false })}, or “tomorrow”.
        </p>
      )}
    </div>
  );
}
