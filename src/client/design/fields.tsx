import {
  createContext, forwardRef, useCallback, useContext, useEffect, useId, useLayoutEffect,
  useMemo, useRef, useState,
  type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { cx } from './layout';
import { AlertCircleIcon, ChevronDownIcon, ChevronUpIcon, ChevronsUpDownIcon, EyeOffIcon, Icons, XCircleIcon } from './icons';
import { IconButton, type ControlSize } from './controls';
import { Popover } from './overlays';
import { Spinner } from './feedback';
import { currencySymbol, formatMoney, formatNumber, parseMoneyInput } from './format';
import { exponentOf, type Currency } from '../../shared/money';
import { useCopyToClipboard, useDebouncedValue } from './hooks';
import './fields.css';

/* ================================= Field ================================== */

interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required?: boolean;
  disabled?: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Wires label, hint, error and aria-* onto whichever control sits inside. */
export function useFieldControl(props: { id?: string; invalid?: boolean; disabled?: boolean; 'aria-describedby'?: string } = {}) {
  const ctx = useContext(FieldContext);
  return {
    id: props.id ?? ctx?.id,
    invalid: props.invalid ?? ctx?.invalid ?? false,
    disabled: props.disabled ?? ctx?.disabled,
    required: ctx?.required,
    'aria-describedby': [props['aria-describedby'], ctx?.describedBy].filter(Boolean).join(' ') || undefined,
  };
}

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Renders a quiet "Optional" marker; use on forms where most fields are required. */
  optional?: boolean;
  disabled?: boolean;
  /** Right-aligned node in the label row — a "Learn more" link, say. */
  aside?: ReactNode;
  /** `n / max` counter under the control. */
  counter?: { value: number; max: number };
  layout?: 'stacked' | 'horizontal';
  id?: string;
  className?: string;
  children: ReactNode;
}

export function Field({
  label, hint, error, required, optional, disabled, aside, counter, layout = 'stacked', id, className, children,
}: FieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  const ctx = useMemo<FieldContextValue>(
    () => ({ id: fieldId, describedBy, invalid: !!error, required, disabled }),
    [fieldId, describedBy, error, required, disabled],
  );

  return (
    <FieldContext.Provider value={ctx}>
      <div className={cx('ain-field', layout === 'horizontal' && 'ain-field--horizontal', className)}>
        {(label || aside) && (
          <div className="ain-field__labelrow">
            {label && (
              <label className="ain-field__label" htmlFor={fieldId}>
                {label}
                {required && <span className="ain-field__req" aria-hidden> *</span>}
              </label>
            )}
            {optional && !required && <span className="ain-field__opt">Optional</span>}
            {aside && <span className="ain-field__aside">{aside}</span>}
          </div>
        )}
        <div className="ain-stack" style={{ gap: 'var(--space-3)', minWidth: 0 }}>
          {hint && !error && <div className="ain-field__hint" id={hintId}>{hint}</div>}
          {children}
          {(error || counter) && (
            <div className="ain-field__foot">
              {error && (
                <div className="ain-field__error" id={errorId} role="alert">
                  <AlertCircleIcon size={13} style={{ marginTop: 1 }} />
                  <span>{error}</span>
                </div>
              )}
              {counter && (
                <span className="ain-field__count" style={{ color: counter.value > counter.max ? 'var(--text-danger)' : undefined }}>
                  {formatNumber(counter.value)}/{formatNumber(counter.max)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </FieldContext.Provider>
  );
}

/* ================================= Input ================================== */

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  size?: ControlSize;
  invalid?: boolean;
  /** Text or node before the value; `boxed` gives it its own tinted well. */
  prefix?: ReactNode;
  suffix?: ReactNode;
  boxedAffix?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  clearable?: boolean;
  onClear?: () => void;
  mono?: boolean;
  wrapperClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', invalid, prefix, suffix, boxedAffix, iconLeft, iconRight, clearable, onClear,
    mono, className, wrapperClassName, disabled, readOnly, value, onChange, ...rest }, ref,
) {
  const field = useFieldControl({ id: rest.id, invalid, disabled, 'aria-describedby': rest['aria-describedby'] });
  const showClear = clearable && !!value && !disabled && !readOnly;
  return (
    <div
      className={cx(
        'ain-input', size !== 'md' && `ain-input--${size}`, mono && 'ain-input--mono',
        field.invalid && 'is-invalid', disabled && 'is-disabled', readOnly && 'is-readonly', wrapperClassName,
      )}
    >
      {prefix && <span className={cx('ain-input__affix', boxedAffix && 'ain-input__affix--boxed')}>{prefix}</span>}
      {iconLeft && <span className="ain-input__icon">{iconLeft}</span>}
      <input
        ref={ref}
        className={cx('ain-input__field', className)}
        disabled={disabled}
        readOnly={readOnly}
        value={value}
        onChange={onChange}
        aria-invalid={field.invalid || undefined}
        aria-required={field.required || undefined}
        {...rest}
        id={field.id}
        aria-describedby={field['aria-describedby']}
      />
      {showClear && (
        <IconButton
          className="ain-input__clear"
          size="sm"
          label="Clear"
          icon={<XCircleIcon size={14} />}
          onClick={() => onClear?.()}
          tabIndex={-1}
        />
      )}
      {iconRight && <span className="ain-input__icon">{iconRight}</span>}
      {suffix && <span className={cx('ain-input__affix', boxedAffix && 'ain-input__affix--boxed ain-input__affix--suffix-boxed')}>{suffix}</span>}
    </div>
  );
});

/* ============================== SearchInput =============================== */

export interface SearchInputProps extends Omit<InputProps, 'onChange' | 'value' | 'iconLeft'> {
  value: string;
  onChange: (value: string) => void;
  /** Fires after the user stops typing — wire this to the API call. */
  onDebouncedChange?: (value: string) => void;
  debounceMs?: number;
  loading?: boolean;
  shortcut?: string;
}

export function SearchInput({
  value, onChange, onDebouncedChange, debounceMs = 240, loading, shortcut,
  placeholder = 'Search…', wrapperClassName, ...rest
}: SearchInputProps) {
  const debounced = useDebouncedValue(value, debounceMs);
  const cbRef = useRef(onDebouncedChange);
  cbRef.current = onDebouncedChange;
  useEffect(() => { cbRef.current?.(debounced); }, [debounced]);

  return (
    <Input
      {...rest}
      type="search"
      role="searchbox"
      value={value}
      placeholder={placeholder}
      wrapperClassName={cx('ain-search', wrapperClassName)}
      iconLeft={loading ? <Spinner size={14} /> : <Icons.search size={15} />}
      iconRight={shortcut && !value ? <kbd className="ain-kbd">{shortcut}</kbd> : undefined}
      clearable
      onClear={() => onChange('')}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange(''); } }}
    />
  );
}

/* ============================== NumberInput =============================== */

export interface NumberInputProps extends Omit<InputProps, 'value' | 'onChange' | 'type'> {
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  showSteppers?: boolean;
}

export function NumberInput({
  value, onChange, min, max, step = 1, precision = 0, showSteppers = true, wrapperClassName, suffix, ...rest
}: NumberInputProps) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const lastValue = useRef(value);
  useEffect(() => {
    if (value !== lastValue.current) { setText(value === null ? '' : String(value)); lastValue.current = value; }
  }, [value]);

  const clamp = (n: number) => {
    let out = n;
    if (min !== undefined) out = Math.max(min, out);
    if (max !== undefined) out = Math.min(max, out);
    return Number(out.toFixed(precision));
  };

  const commit = (raw: string) => {
    if (raw.trim() === '') { lastValue.current = null; onChange(null); return; }
    const parsed = Number(raw.replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(parsed)) { setText(value === null ? '' : String(value)); return; }
    const next = clamp(parsed);
    setText(String(next));
    lastValue.current = next;
    onChange(next);
  };

  const nudge = (delta: number) => {
    const base = value ?? min ?? 0;
    const next = clamp(base + delta * step);
    setText(String(next));
    lastValue.current = next;
    onChange(next);
  };

  return (
    <Input
      {...rest}
      type="text"
      inputMode="decimal"
      value={text}
      wrapperClassName={cx('ain-input--number', wrapperClassName)}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => { commit(e.target.value); rest.onBlur?.(e); }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') { e.preventDefault(); nudge(e.shiftKey ? 10 : 1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(e.shiftKey ? -10 : -1); }
        else if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
        rest.onKeyDown?.(e);
      }}
      aria-valuenow={value ?? undefined}
      aria-valuemin={min}
      aria-valuemax={max}
      suffix={
        <>
          {suffix}
          {showSteppers && (
            <span className="ain-input__stepper">
              <button type="button" className="ain-input__step" tabIndex={-1} aria-label="Increase" onClick={() => nudge(1)}>
                <ChevronUpIcon size={11} />
              </button>
              <button type="button" className="ain-input__step" tabIndex={-1} aria-label="Decrease" onClick={() => nudge(-1)}>
                <ChevronDownIcon size={11} />
              </button>
            </span>
          )}
        </>
      }
    />
  );
}

/* =============================== MoneyInput =============================== */

export interface MoneyInputProps extends Omit<InputProps, 'value' | 'onChange' | 'type' | 'prefix'> {
  /** Integer minor units, exactly as the API stores it. */
  value: number | null;
  onChange: (minorUnits: number | null) => void;
  currency?: Currency;
  locale?: string;
  min?: number;
  max?: number;
}

/**
 * Edits money without ever holding a float: the text is parsed straight into
 * minor units through `shared/money`, and re-formatted on blur.
 */
export function MoneyInput({
  value, onChange, currency = 'usd', locale = 'en-US', min, max, wrapperClassName, ...rest
}: MoneyInputProps) {
  const exp = exponentOf(currency);
  const toText = useCallback(
    (minor: number | null) => (minor === null ? '' : (minor / 10 ** exp).toFixed(exp)),
    [exp],
  );
  const [text, setText] = useState(() => toText(value));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) { setText(toText(value)); last.current = value; }
  }, [value, toText]);

  const commit = (raw: string) => {
    if (raw.trim() === '') { last.current = null; onChange(null); return; }
    const parsed = parseMoneyInput(raw, currency);
    if (!parsed) { setText(toText(value)); return; }
    let minor = parsed.amount;
    if (min !== undefined) minor = Math.max(min, minor);
    if (max !== undefined) minor = Math.min(max, minor);
    last.current = minor;
    setText(toText(minor));
    onChange(minor);
  };

  return (
    <Input
      {...rest}
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={rest.placeholder ?? (0).toFixed(exp)}
      wrapperClassName={cx('ain-input--number', wrapperClassName)}
      prefix={currencySymbol(currency, locale)}
      suffix={<span style={{ textTransform: 'uppercase', fontSize: 'var(--text-xs)' }}>{currency}</span>}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => { commit(e.target.value); rest.onBlur?.(e); }}
      onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); rest.onKeyDown?.(e); }}
      aria-label={rest['aria-label']}
      title={value !== null ? formatMoney({ amount: value, currency }, { locale }) : undefined}
    />
  );
}

/* ================================ Textarea ================================ */

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'> {
  invalid?: boolean;
  /** Grow with the content up to `maxRows`, then scroll. */
  autosize?: boolean;
  minRows?: number;
  maxRows?: number;
  wrapperClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, autosize = true, minRows = 3, maxRows = 14, className, wrapperClassName, disabled, readOnly, value, onChange, ...rest }, ref,
) {
  const field = useFieldControl({ id: rest.id, invalid, disabled, 'aria-describedby': rest['aria-describedby'] });
  const inner = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback(() => {
    const el = inner.current;
    if (!el || !autosize) return;
    const style = window.getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, lineHeight * maxRows + padding);
    el.style.height = `${Math.max(next, lineHeight * minRows)}px`;
  }, [autosize, maxRows, minRows]);

  useLayoutEffect(resize, [value, resize]);

  return (
    <div className={cx('ain-input', 'ain-textarea', !autosize && 'ain-textarea--fixed', field.invalid && 'is-invalid', disabled && 'is-disabled', readOnly && 'is-readonly', wrapperClassName)}>
      <textarea
        ref={(node) => {
          inner.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
        }}
        className={cx('ain-input__field', className)}
        rows={minRows}
        disabled={disabled}
        readOnly={readOnly}
        value={value}
        aria-invalid={field.invalid || undefined}
        onChange={(e) => { onChange?.(e); resize(); }}
        {...rest}
        id={field.id}
        aria-describedby={field['aria-describedby']}
      />
    </div>
  );
});

/* ================================= Select ================================= */

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'onChange' | 'value'> {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  size?: 'sm' | 'md';
  invalid?: boolean;
  placeholder?: string;
  icon?: ReactNode;
  wrapperClassName?: string;
}

/** A native `<select>` — keyboard and mobile behaviour for free — but styled. */
export function Select({
  value, onChange, options, size = 'md', invalid, placeholder, icon, className, wrapperClassName, disabled, ...rest
}: SelectProps) {
  const field = useFieldControl({ id: rest.id, invalid, disabled, 'aria-describedby': rest['aria-describedby'] });
  const groups = useMemo(() => {
    const map = new Map<string, SelectOption[]>();
    for (const option of options) {
      const key = option.group ?? '';
      const arr = map.get(key) ?? [];
      arr.push(option);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [options]);

  return (
    <div className={cx('ain-select', size === 'sm' && 'ain-select--sm', icon && 'ain-select--hasicon', field.invalid && 'is-invalid', wrapperClassName)}>
      {icon && <span className="ain-select__icon">{icon}</span>}
      <select
        className={cx('ain-select__native', className)}
        value={value}
        disabled={disabled}
        aria-invalid={field.invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
        id={field.id}
        aria-describedby={field['aria-describedby']}
      >
        {placeholder && <option value="" disabled>{placeholder}</option>}
        {groups.map(([group, groupOptions]) => (
          group
            ? (
              <optgroup label={group} key={group}>
                {groupOptions.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
              </optgroup>
            )
            : groupOptions.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)
        ))}
      </select>
      <span className="ain-select__chevron"><ChevronDownIcon size={14} /></span>
    </div>
  );
}

/* =============================== Combobox ================================= */

export interface ComboOption {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  group?: string;
  disabled?: boolean;
}

export interface ComboboxProps {
  /** A single value, or an array when `multiple`. */
  value: string | string[];
  onChange: (value: string & string[]) => void;
  options?: ComboOption[];
  /** Async source. Called with the debounced query; return the matches. */
  onSearch?: (query: string) => Promise<ComboOption[]>;
  multiple?: boolean;
  placeholder?: string;
  emptyMessage?: string;
  /** Offer "Create <query>" when nothing matches. */
  onCreate?: (label: string) => void;
  createLabel?: (query: string) => string;
  disabled?: boolean;
  invalid?: boolean;
  size?: ControlSize;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

/** Highlights the matched run so the reason a row is in the list is visible. */
function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="ain-combo__mark">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

export function Combobox({
  value, onChange, options, onSearch, multiple, placeholder = 'Select…', emptyMessage = 'No matches',
  onCreate, createLabel = (q) => `Create “${q}”`, disabled, invalid, size = 'md', id, className, ...aria
}: ComboboxProps) {
  const field = useFieldControl({ id, invalid, disabled });
  const anchor = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [asyncOptions, setAsyncOptions] = useState<ComboOption[]>([]);
  const [loading, setLoading] = useState(false);
  const debounced = useDebouncedValue(query, 200);
  const listId = useId();

  const selected = useMemo(() => (Array.isArray(value) ? value : value ? [value] : []), [value]);

  useEffect(() => {
    if (!onSearch || !open) return;
    let cancelled = false;
    setLoading(true);
    onSearch(debounced)
      .then((result) => { if (!cancelled) setAsyncOptions(result); })
      .catch(() => { if (!cancelled) setAsyncOptions([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [debounced, onSearch, open]);

  const source = onSearch ? asyncOptions : options ?? [];
  const filtered = useMemo(() => {
    if (onSearch) return source;
    const q = query.trim().toLowerCase();
    if (!q) return source;
    return source.filter((o) => o.label.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q));
  }, [source, query, onSearch]);

  const enabled = filtered.filter((o) => !o.disabled);
  const canCreate = !!onCreate && query.trim().length > 0 && !filtered.some((o) => o.label.toLowerCase() === query.trim().toLowerCase());
  useEffect(() => { setActive(0); }, [query, open]);

  const labelFor = (v: string) => source.find((o) => o.value === v)?.label ?? options?.find((o) => o.value === v)?.label ?? v;

  const commit = (option: ComboOption) => {
    if (multiple) {
      const next = selected.includes(option.value) ? selected.filter((v) => v !== option.value) : [...selected, option.value];
      (onChange as (v: string[]) => void)(next);
      setQuery('');
      inputRef.current?.focus();
    } else {
      (onChange as (v: string) => void)(option.value);
      setQuery('');
      setOpen(false);
    }
  };

  const groups = useMemo(() => {
    const map = new Map<string, ComboOption[]>();
    for (const option of filtered) {
      const key = option.group ?? '';
      const arr = map.get(key) ?? [];
      arr.push(option);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [filtered]);

  const singleLabel = !multiple && selected[0] ? labelFor(selected[0]) : '';

  return (
    <div className={cx('ain-combo', className)}>
      <div
        ref={anchor}
        className={cx('ain-input', 'ain-combo__control', size !== 'md' && `ain-input--${size}`, field.invalid && 'is-invalid', disabled && 'is-disabled')}
        onClick={() => { if (!disabled) { setOpen(true); inputRef.current?.focus(); } }}
      >
        <Icons.search size={14} className="ain-input__icon" />
        {multiple && selected.map((v) => (
          <span className="ain-tag" key={v}>
            <span className="u-truncate">{labelFor(v)}</span>
            <button
              type="button"
              className="ain-tag__remove"
              aria-label={`Remove ${labelFor(v)}`}
              onClick={(e) => { e.stopPropagation(); (onChange as (x: string[]) => void)(selected.filter((s) => s !== v)); }}
            >
              <Icons.x size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={field.id}
          className="ain-combo__input"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && enabled[active] ? `${listId}-${enabled[active].value}` : undefined}
          aria-label={aria['aria-label']}
          aria-describedby={field['aria-describedby']}
          aria-invalid={field.invalid || undefined}
          disabled={disabled}
          value={open ? query : singleLabel || query}
          placeholder={selected.length ? (multiple ? '' : singleLabel) : placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(enabled.length - 1 + (canCreate ? 1 : 0), i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            else if (e.key === 'Enter') {
              e.preventDefault();
              if (active === enabled.length && canCreate) { onCreate?.(query.trim()); setQuery(''); }
              else if (enabled[active]) commit(enabled[active]);
            } else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); setQuery(''); }
            else if (e.key === 'Backspace' && !query && multiple && selected.length) {
              (onChange as (x: string[]) => void)(selected.slice(0, -1));
            } else if (e.key === 'Tab') setOpen(false);
          }}
        />
        {loading && <Spinner size={14} />}
        {!multiple && selected.length > 0 && !disabled && (
          <IconButton
            size="sm"
            label="Clear selection"
            icon={<XCircleIcon size={14} />}
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); (onChange as (v: string) => void)(''); setQuery(''); }}
          />
        )}
        <ChevronsUpDownIcon size={14} className="ain-input__icon" />
      </div>

      <Popover
        open={open && !disabled}
        onClose={() => setOpen(false)}
        anchor={anchor}
        matchWidth
        autoFocus={false}
        role="none"
        flush
        placement="bottom-start"
      >
        <div className="ain-combo__list" role="listbox" id={listId} aria-multiselectable={multiple}>
          {loading && filtered.length === 0 && <div className="ain-combo__status">Searching…</div>}
          {!loading && filtered.length === 0 && !canCreate && <div className="ain-combo__status">{emptyMessage}</div>}
          {groups.map(([group, groupOptions]) => (
            <div key={group || 'ungrouped'}>
              {group && <div className="ain-combo__group">{group}</div>}
              {groupOptions.map((option) => {
                const index = enabled.indexOf(option);
                const isSelected = selected.includes(option.value);
                return (
                  <div
                    key={option.value}
                    id={`${listId}-${option.value}`}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    className={cx('ain-combo__option', index === active && index >= 0 && 'is-active')}
                    onPointerEnter={() => index >= 0 && setActive(index)}
                    onClick={() => !option.disabled && commit(option)}
                  >
                    {option.icon}
                    <span className="ain-combo__optiontext">
                      <span className="u-truncate"><Highlight text={option.label} query={query} /></span>
                      {option.description && <span className="ain-combo__optionsub u-truncate">{option.description}</span>}
                    </span>
                    {isSelected && <Icons.check size={14} style={{ color: 'var(--accent)' }} />}
                  </div>
                );
              })}
            </div>
          ))}
          {canCreate && (
            <div
              className={cx('ain-combo__create', active === enabled.length && 'is-active')}
              onPointerEnter={() => setActive(enabled.length)}
              onClick={() => { onCreate?.(query.trim()); setQuery(''); }}
              role="option"
              aria-selected={false}
            >
              <Icons.plus size={14} />
              {createLabel(query.trim())}
            </div>
          )}
        </div>
      </Popover>
    </div>
  );
}

/* =============================== TagInput ================================= */

export interface TagInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  /** Keys that finish the current tag, on top of Enter. */
  delimiters?: string[];
  validate?: (tag: string) => string | null;
  max?: number;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

export function TagInput({
  value, onChange, placeholder = 'Add and press Enter', delimiters = [',', ' '],
  validate, max, disabled, invalid, id, className, ...aria
}: TagInputProps) {
  const field = useFieldControl({ id, invalid, disabled });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (raw: string) => {
    const tag = raw.trim().replace(/,$/, '');
    if (!tag) return;
    if (value.includes(tag)) { setDraft(''); return; }
    if (max !== undefined && value.length >= max) { setError(`Up to ${max} allowed`); return; }
    const problem = validate?.(tag) ?? null;
    if (problem) { setError(problem); return; }
    setError(null);
    onChange([...value, tag]);
    setDraft('');
  };

  return (
    <div className={className}>
      <div
        className={cx('ain-input', 'ain-taginput', (field.invalid || error) && 'is-invalid', disabled && 'is-disabled')}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((tag) => (
          <span className="ain-tag" key={tag}>
            <span className="u-truncate">{tag}</span>
            <button type="button" className="ain-tag__remove" aria-label={`Remove ${tag}`} onClick={() => onChange(value.filter((t) => t !== tag))}>
              <Icons.x size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={field.id}
          className="ain-taginput__input"
          value={draft}
          disabled={disabled}
          placeholder={value.length ? '' : placeholder}
          aria-label={aria['aria-label']}
          aria-describedby={field['aria-describedby']}
          aria-invalid={(field.invalid || !!error) || undefined}
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
          onBlur={() => add(draft)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (!/[,\n]/.test(text)) return;
            e.preventDefault();
            for (const part of text.split(/[,\n]/)) add(part);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || delimiters.includes(e.key)) { e.preventDefault(); add(draft); }
            else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
          }}
        />
      </div>
      {error && <div className="ain-field__error" role="alert" style={{ marginTop: 'var(--space-3)' }}><AlertCircleIcon size={13} />{error}</div>}
    </div>
  );
}

/* =========================== CopyField / CodeInput ======================== */

export interface CopyFieldProps {
  value: string;
  label?: string;
  /** Mask the value until revealed — for API keys and other secrets. */
  secret?: boolean;
  mono?: boolean;
  className?: string;
}

export function CopyField({ value, label = 'Copy', secret, mono = true, className }: CopyFieldProps) {
  const [copied, copy] = useCopyToClipboard();
  const [revealed, setRevealed] = useState(!secret);
  const shown = revealed ? value : `${value.slice(0, 7)}${'•'.repeat(Math.max(4, Math.min(18, value.length - 7)))}`;
  return (
    <div className={cx('ain-copyfield', !revealed && 'ain-copyfield--masked', className)}>
      <span className="ain-copyfield__value" style={mono ? undefined : { fontFamily: 'var(--font-sans)' }} title={revealed ? value : undefined}>
        {shown}
      </span>
      {secret && (
        <IconButton
          size="sm"
          label={revealed ? 'Hide value' : 'Reveal value'}
          icon={revealed ? <EyeOffIcon size={14} /> : <Icons.eye size={14} />}
          onClick={() => setRevealed((v) => !v)}
        />
      )}
      <IconButton
        size="sm"
        label={copied ? 'Copied' : label}
        icon={copied ? <Icons.check size={14} style={{ color: 'var(--text-success)' }} /> : <Icons.copy size={14} />}
        onClick={() => void copy(value)}
      />
    </div>
  );
}

export interface CodeInputProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  'aria-label'?: string;
}

/** One box per character — verification codes, with paste and arrow support. */
export function CodeInput({ length = 6, value, onChange, onComplete, disabled, ...aria }: CodeInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const chars = value.padEnd(length, ' ').slice(0, length).split('');

  const setAt = (index: number, char: string) => {
    const next = chars.map((c, i) => (i === index ? char : c)).join('').trimEnd();
    onChange(next);
    if (char && index < length - 1) refs.current[index + 1]?.focus();
    if (next.replace(/\s/g, '').length === length) onComplete?.(next);
  };

  return (
    <div className="u-row" style={{ gap: 'var(--space-3)' }} role="group" aria-label={aria['aria-label'] ?? 'Verification code'}>
      {chars.map((char, i) => (
        <input
          key={i}
          ref={(node) => { refs.current[i] = node; }}
          className="ain-input__field"
          style={{
            width: 40, height: 46, textAlign: 'center', fontSize: 'var(--text-xl)',
            fontFamily: 'var(--font-mono)', border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)', background: 'var(--bg-surface)',
          }}
          inputMode="numeric"
          maxLength={1}
          disabled={disabled}
          value={char.trim()}
          aria-label={`Digit ${i + 1}`}
          onChange={(e) => setAt(i, e.target.value.slice(-1))}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData('text').replace(/\s/g, '').slice(0, length);
            onChange(text);
            if (text.length === length) onComplete?.(text);
            refs.current[Math.min(length - 1, text.length)]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !char.trim() && i > 0) refs.current[i - 1]?.focus();
            else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
            else if (e.key === 'ArrowRight' && i < length - 1) refs.current[i + 1]?.focus();
          }}
        />
      ))}
    </div>
  );
}
