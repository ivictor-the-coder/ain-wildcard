import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { cx } from './layout';
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, Icons, XCircleIcon } from './icons';
import { Button, IconButton } from './controls';
import { Popover } from './overlays';
import { useFieldControl } from './fields';
import { formatDate, formatDateRange, useFormat } from './format';
import { startOfDay } from '../../shared/time';
import {
  addDays, addMonths, dayOf, inRange, isSameDay, isTimestamp, monthMatrix, monthOf, nextRange,
  startOfMonthUtc, weekdayLabels, RANGE_PRESETS, type DateRange,
} from './calendar-core';
import './fields.css';

export interface CalendarProps {
  value?: number | null;
  onSelect?: (ts: number) => void;
  range?: DateRange;
  /** Preview the range while hovering the second endpoint. */
  hoverTs?: number | null;
  onHover?: (ts: number | null) => void;
  month: number;
  onMonthChange: (month: number) => void;
  min?: number;
  max?: number;
  locale?: string;
  timeZone?: string;
  weekStartsOn?: number;
  today?: number;
  /** Hide the arrows when two calendars share one header. */
  hideNav?: 'left' | 'right' | 'none';
  /**
   * Mirrors out the day the roving tabindex is on, so the popover that owns the
   * calendar can hand focus straight to it. Opening a picker with the keyboard
   * used to land on "Previous month", two Tabs away from the grid, where the
   * arrow keys the calendar implements did nothing at all.
   */
  dayRef?: MutableRefObject<HTMLButtonElement | null>;
  className?: string;
}

export function Calendar({
  value, onSelect, range, hoverTs, onHover, month: monthProp, onMonthChange, min, max,
  locale = 'en-US', weekStartsOn = 0, today = Date.now(), hideNav = 'none', dayRef, className,
}: CalendarProps) {
  // The month is a caller's number — an API field, a decoded query string, a bad
  // import. Out of range it makes every `getUTC*` NaN and throws in the month
  // label, which unmounts the tree that rendered the calendar. Fall back to the
  // month of today instead of taking the page down.
  const now = isTimestamp(today) ? today : Date.now();
  const month = isTimestamp(monthProp) ? monthProp : startOfMonthUtc(now);
  const days = useMemo(() => monthMatrix(month, weekStartsOn), [month, weekStartsOn]);
  const labels = useMemo(() => weekdayLabels(locale, weekStartsOn), [locale, weekStartsOn]);
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusTs, setFocusTs] = useState<number>(() => {
    const wanted = value ?? range?.start ?? now;
    return startOfDay(isTimestamp(wanted) ? wanted : now);
  });

  useEffect(() => {
    if (monthOf(focusTs) !== monthOf(month)) setFocusTs(startOfMonthUtc(month));
  }, [month, focusTs]);

  const disabled = (ts: number) => (min !== undefined && ts < startOfDay(min)) || (max !== undefined && ts > startOfDay(max));

  const effectiveRange: DateRange | null = range
    ? (range.start !== null && range.end === null && hoverTs
      ? (hoverTs < range.start ? { start: hoverTs, end: range.start } : { start: range.start, end: hoverTs })
      : range)
    : null;

  const move = (delta: number) => {
    const next = addDays(focusTs, delta);
    setFocusTs(next);
    if (monthOf(next) !== monthOf(month)) onMonthChange(startOfMonthUtc(next));
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>('[data-focus="true"]')?.focus());
  };

  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(month);

  return (
    <div className={cx('ain-cal', className)}>
      <div className="ain-cal__head">
        {hideNav !== 'left' ? (
          <IconButton size="sm" label="Previous month" icon={<ChevronLeftIcon size={15} />} onClick={() => onMonthChange(addMonths(month, -1))} />
        ) : <span style={{ width: 26 }} />}
        <div className="ain-cal__month" aria-live="polite">{monthLabel}</div>
        {hideNav !== 'right' ? (
          <IconButton size="sm" label="Next month" icon={<ChevronRightIcon size={15} />} onClick={() => onMonthChange(addMonths(month, 1))} />
        ) : <span style={{ width: 26 }} />}
      </div>
      <div
        className="ain-cal__grid"
        role="grid"
        aria-label={monthLabel}
        ref={gridRef}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); move(-7); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); move(7); }
          else if (e.key === 'Home') { e.preventDefault(); move(-((new Date(focusTs).getUTCDay() - weekStartsOn + 7) % 7)); }
          else if (e.key === 'End') { e.preventDefault(); move(6 - ((new Date(focusTs).getUTCDay() - weekStartsOn + 7) % 7)); }
          else if (e.key === 'PageUp') { e.preventDefault(); onMonthChange(addMonths(month, -1)); setFocusTs(addMonths(focusTs, -1)); }
          else if (e.key === 'PageDown') { e.preventDefault(); onMonthChange(addMonths(month, 1)); setFocusTs(addMonths(focusTs, 1)); }
        }}
      >
        {labels.map((label, i) => <div className="ain-cal__dow" key={i} role="columnheader" aria-label={label}>{label}</div>)}
        {days.map((d) => {
          const selected = value != null && isSameDay(d.ts, value);
          const isStart = effectiveRange?.start != null && isSameDay(d.ts, effectiveRange.start);
          const isEnd = effectiveRange?.end != null && isSameDay(d.ts, effectiveRange.end);
          const within = effectiveRange ? inRange(d.ts, effectiveRange) : false;
          const isToday = isSameDay(d.ts, now);
          const hasRovingFocus = isSameDay(d.ts, focusTs);
          return (
            <button
              key={d.ts}
              type="button"
              role="gridcell"
              ref={(node) => { if (dayRef && hasRovingFocus) dayRef.current = node; }}
              data-focus={hasRovingFocus}
              tabIndex={hasRovingFocus ? 0 : -1}
              disabled={disabled(d.ts)}
              aria-selected={selected || isStart || isEnd}
              aria-label={formatDate(d.ts, { locale, timeZone: 'UTC' })}
              className={cx(
                'ain-cal__day',
                d.outside && 'is-outside',
                isToday && 'is-today',
                (selected || isStart || isEnd) && 'is-selected',
                within && 'is-inrange',
                isStart && effectiveRange?.end && 'is-start',
                isEnd && 'is-end',
              )}
              onPointerEnter={() => onHover?.(d.ts)}
              onPointerLeave={() => onHover?.(null)}
              onClick={() => { setFocusTs(d.ts); onSelect?.(d.ts); }}
            >
              {dayOf(d.ts)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* =============================== DatePicker =============================== */

export interface DatePickerProps {
  value: number | null;
  onChange: (ts: number | null) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  clearable?: boolean;
  /** Quick action under the calendar; defaults to "Today". */
  footer?: ReactNode;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

export function DatePicker({
  value, onChange, min, max, placeholder = 'Pick a date', disabled, invalid, clearable = true,
  footer, id, className, ...aria
}: DatePickerProps) {
  const fmt = useFormat();
  const field = useFieldControl({ id, invalid, disabled });
  const anchor = useRef<HTMLButtonElement>(null);
  const day = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => startOfMonthUtc(value ?? fmt.now()));

  useEffect(() => { if (open) setMonth(startOfMonthUtc(value ?? fmt.now())); }, [open, value, fmt]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        id={field.id}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={aria['aria-label']}
        aria-invalid={field.invalid || undefined}
        aria-describedby={field['aria-describedby']}
        className={cx('ain-input', field.invalid && 'is-invalid', disabled && 'is-disabled', className)}
        style={{ cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left' }}
        onClick={() => setOpen((v) => !v)}
      >
        <Icons.calendar size={15} className="ain-input__icon" />
        <span className="ain-input__field u-truncate" style={{ color: value ? undefined : 'var(--text-placeholder)', display: 'flex', alignItems: 'center' }}>
          {value ? fmt.date(value, { timeZone: 'UTC' }) : placeholder}
        </span>
        {clearable && value !== null && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear date"
            className="ain-iconbtn ain-iconbtn--sm"
            onClick={(e) => { e.stopPropagation(); onChange(null); }}
          >
            <XCircleIcon size={14} />
          </span>
        )}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-start" flush ariaLabel="Choose a date" initialFocus={day}>
        <Calendar
          dayRef={day}
          value={value}
          month={month}
          onMonthChange={setMonth}
          onSelect={(ts) => { onChange(ts); setOpen(false); }}
          min={min}
          max={max}
          locale={fmt.locale}
          today={fmt.now()}
        />
        <div className="ain-cal__foot" style={{ padding: '0 var(--space-5) var(--space-5)' }}>
          {footer ?? (
            <>
              <Button size="sm" variant="ghost" onClick={() => { onChange(startOfDay(fmt.now())); setOpen(false); }}>Today</Button>
              {clearable && <Button size="sm" variant="ghost" onClick={() => { onChange(null); setOpen(false); }}>Clear</Button>}
            </>
          )}
        </div>
      </Popover>
    </>
  );
}

/* ============================ DateRangePicker ============================= */

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Named ranges down the left edge; pass `[]` to hide them. */
  presets?: typeof RANGE_PRESETS;
  placeholder?: string;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

export function DateRangePicker({
  value, onChange, min, max, disabled, presets = RANGE_PRESETS, placeholder = 'Select a period', id, className, ...aria
}: DateRangePickerProps) {
  const fmt = useFormat();
  const anchor = useRef<HTMLButtonElement>(null);
  const day = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(value);
  const [hover, setHover] = useState<number | null>(null);
  const [month, setMonth] = useState(() => startOfMonthUtc(addMonths(value.start ?? fmt.now(), 0)));

  useEffect(() => { if (open) { setDraft(value); setMonth(startOfMonthUtc(value.start ?? fmt.now())); } }, [open, value, fmt]);

  const label = value.start && value.end
    ? formatDateRange(value.start, value.end, { locale: fmt.locale, timeZone: 'UTC' })
    : placeholder;

  const activePreset = presets.find((p) => {
    const r = p.range(fmt.now());
    return value.start !== null && value.end !== null && r.start === value.start && r.end === value.end;
  });

  const pick = (ts: number) => {
    const next = nextRange(draft, ts);
    setDraft(next);
    if (next.end !== null) { onChange(next); setOpen(false); }
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={aria['aria-label'] ?? 'Date range'}
        className={cx('ain-input', disabled && 'is-disabled', className)}
        style={{ cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left', minWidth: 232 }}
        onClick={() => setOpen((v) => !v)}
      >
        <Icons.calendar size={15} className="ain-input__icon" />
        <span className="ain-input__field u-truncate" style={{ color: value.start ? undefined : 'var(--text-placeholder)', display: 'flex', alignItems: 'center' }}>
          {activePreset ? activePreset.label : label}
        </span>
        <ChevronDownIcon size={14} className="ain-input__icon" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-start" flush ariaLabel="Choose a date range" initialFocus={day}>
        <div className="ain-daterange__body" style={{ padding: 'var(--space-5)' }}>
          {presets.length > 0 && (
            <div className="ain-daterange__presets">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={cx('ain-daterange__preset', activePreset?.id === preset.id && 'is-active')}
                  onClick={() => { const r = preset.range(fmt.now()); onChange(r); setDraft(r); setOpen(false); }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
          <div className="ain-cal__months">
            <Calendar
              dayRef={day}
              month={month}
              onMonthChange={setMonth}
              range={draft}
              hoverTs={hover}
              onHover={setHover}
              onSelect={pick}
              min={min}
              max={max}
              hideNav="right"
              locale={fmt.locale}
              today={fmt.now()}
              className="ain-cal--range"
            />
            <Calendar
              month={addMonths(month, 1)}
              onMonthChange={(m) => setMonth(addMonths(m, -1))}
              range={draft}
              hoverTs={hover}
              onHover={setHover}
              onSelect={pick}
              min={min}
              max={max}
              hideNav="left"
              locale={fmt.locale}
              today={fmt.now()}
              className="ain-cal--range"
            />
          </div>
        </div>
        <div className="ain-popover__footer">
          <span style={{ marginInlineEnd: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            {draft.start && !draft.end ? `Starting ${fmt.date(draft.start, { timeZone: 'UTC' })} — pick an end date` : ''}
          </span>
          <Button size="sm" variant="ghost" onClick={() => { onChange({ start: null, end: null }); setOpen(false); }}>Clear</Button>
          <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>Done</Button>
        </div>
      </Popover>
    </>
  );
}

