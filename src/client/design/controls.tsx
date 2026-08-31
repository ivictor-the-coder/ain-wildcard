import {
  forwardRef, useCallback, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type ChangeEvent, type InputHTMLAttributes, type ReactNode,
} from 'react';
import { cx } from './cx';
import { Spinner } from './feedback';
import './controls.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'link';
export type ControlSize = 'sm' | 'md' | 'lg';

const ICON_SIZE: Record<ControlSize, number> = { sm: 14, md: 16, lg: 18 };

/* ================================ Button ================================== */

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ControlSize;
  loading?: boolean;
  /** Announced while `loading` so screen readers hear the pending state. */
  loadingLabel?: string;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  block?: boolean;
  selected?: boolean;
  type?: 'button' | 'submit' | 'reset';
  /** Renders an anchor that still looks and behaves like a button. */
  href?: string;
  target?: string;
  rel?: string;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, loadingLabel = 'Working…',
    iconLeft, iconRight, block, selected, className, children, disabled,
    type = 'button', href, target, rel, onClick, ...rest }, ref,
) {
  const classes = cx(
    'ain-btn', `ain-btn--${variant}`, size !== 'md' && `ain-btn--${size}`,
    block && 'ain-btn--block', loading && 'ain-btn--loading', selected && 'is-selected', className,
  );
  const inner = (
    <>
      {iconLeft && <span className="ain-btn__icon" aria-hidden>{iconLeft}</span>}
      {children !== undefined && children !== null && children !== false && <span className="ain-btn__label">{children}</span>}
      {iconRight && <span className="ain-btn__icon" aria-hidden>{iconRight}</span>}
      {loading && (
        <span className="ain-btn__spinner">
          <Spinner size={size === 'lg' ? 16 : 14} />
          <span className="u-visually-hidden">{loadingLabel}</span>
        </span>
      )}
    </>
  );

  if (href && !disabled) {
    return (
      <a
        href={href}
        target={target}
        rel={rel ?? (target === '_blank' ? 'noreferrer noopener' : undefined)}
        className={classes}
        aria-busy={loading || undefined}
        onClick={onClick as unknown as React.MouseEventHandler<HTMLAnchorElement>}
      >
        {inner}
      </a>
    );
  }

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-pressed={selected}
      onClick={onClick}
      {...rest}
    >
      {inner}
    </button>
  );
});

/* ============================== IconButton ================================ */

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  /** Required: icon-only controls must still have an accessible name. */
  label: string;
  icon: ReactNode;
  size?: ControlSize;
  variant?: 'ghost' | 'secondary' | 'primary' | 'danger';
  active?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'md', variant = 'ghost', active, className, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('ain-iconbtn', `ain-iconbtn--${variant}`, size !== 'md' && `ain-iconbtn--${size}`, active && 'is-active', className)}
      aria-label={label}
      title={label}
      {...rest}
    >
      {icon}
    </button>
  );
});

/* ============================== ButtonGroup =============================== */

export function ButtonGroup({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return <div role="group" className={cx('ain-btngroup', className)} {...rest}>{children}</div>;
}

/* =========================== SegmentedControl ============================= */

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** Tooltip / screen-reader text when the label is an icon alone. */
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  size?: 'sm' | 'md';
  full?: boolean;
  'aria-label': string;
  className?: string;
}

/** A radiogroup with roving focus: ←/→ move, Home/End jump, Space selects. */
export function SegmentedControl<T extends string>({
  value, onChange, options, size = 'md', full, className, ...aria
}: SegmentedControlProps<T>) {
  const ref = useRef<HTMLDivElement>(null);

  const move = (delta: number) => {
    const enabled = options.filter((o) => !o.disabled);
    if (!enabled.length) return;
    const idx = enabled.findIndex((o) => o.value === value);
    const next = enabled[(idx + delta + enabled.length) % enabled.length];
    onChange(next.value);
    requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
    });
  };

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={aria['aria-label']}
      className={cx('ain-segmented', size === 'sm' && 'ain-segmented--sm', full && 'ain-segmented--full', className)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Home') { e.preventDefault(); const f = options.find((o) => !o.disabled); if (f) onChange(f.value); }
        else if (e.key === 'End') { e.preventDefault(); const l = [...options].reverse().find((o) => !o.disabled); if (l) onChange(l.value); }
      }}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={checked}
            aria-label={option.title}
            title={option.title}
            tabIndex={checked ? 0 : -1}
            disabled={option.disabled}
            className="ain-segmented__item"
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ================================ Switch ================================== */

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md';
  'aria-label'?: string;
  className?: string;
  id?: string;
}

export function Switch({ checked, onChange, label, hint, disabled, size = 'md', className, id, ...aria }: SwitchProps) {
  const autoId = useId();
  const switchId = id ?? autoId;
  const hintId = hint ? `${switchId}-hint` : undefined;
  // A <label for> does not name a <button>, so the visible label is wired up
  // with aria-labelledby instead — otherwise the switch is anonymous.
  const labelId = label ? `${switchId}-label` : undefined;
  return (
    <div className={cx('ain-switch', size === 'sm' && 'ain-switch--sm', disabled && 'is-disabled', className)}>
      <button
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={labelId ? undefined : aria['aria-label']}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        disabled={disabled}
        className="ain-switch__track"
        onClick={() => !disabled && onChange(!checked)}
      >
        <span className="ain-switch__thumb" />
      </button>
      {(label || hint) && (
        <span className="ain-switch__text" onClick={() => !disabled && onChange(!checked)}>
          {label && <span className="ain-switch__label" id={labelId}>{label}</span>}
          {hint && <span className="ain-switch__hint" id={hintId}>{hint}</span>}
        </span>
      )}
    </div>
  );
}

/* =============================== Checkbox ================================= */

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'size'> {
  checked?: boolean;
  indeterminate?: boolean;
  onChange?: (checked: boolean, e: ChangeEvent<HTMLInputElement>) => void;
  label?: ReactNode;
  hint?: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, indeterminate, onChange, label, hint, disabled, className, id, ...rest }, ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const inner = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);

  return (
    <label htmlFor={inputId} className={cx('ain-check', disabled && 'is-disabled', className)}>
      <input
        ref={(node) => {
          (inner as React.MutableRefObject<HTMLInputElement | null>).current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
        }}
        id={inputId}
        type="checkbox"
        className="ain-check__input"
        checked={!!checked}
        disabled={disabled}
        aria-describedby={hint ? `${inputId}-hint` : undefined}
        onChange={(e) => onChange?.(e.target.checked, e)}
        {...rest}
      />
      <span className="ain-check__box" aria-hidden>
        {indeterminate && !checked
          ? <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          : <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.6 5.2 3.9 7.5 8.4 2.6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </span>
      {(label || hint) && (
        <span className="ain-check__text">
          {label && <span className="ain-check__label">{label}</span>}
          {hint && <span className="ain-check__hint" id={`${inputId}-hint`}>{hint}</span>}
        </span>
      )}
    </label>
  );
});

/* ================================ Radio =================================== */

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  onChange?: (checked: boolean) => void;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { label, hint, disabled, className, id, onChange, ...rest }, ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label htmlFor={inputId} className={cx('ain-check', disabled && 'is-disabled', className)}>
      <input
        ref={ref}
        id={inputId}
        type="radio"
        className="ain-check__input"
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        {...rest}
      />
      <span className="ain-check__box ain-check__box--radio" aria-hidden><span className="ain-check__dot" /></span>
      {(label || hint) && (
        <span className="ain-check__text">
          {label && <span className="ain-check__label">{label}</span>}
          {hint && <span className="ain-check__hint">{hint}</span>}
        </span>
      )}
    </label>
  );
});

export interface RadioGroupProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; hint?: ReactNode; disabled?: boolean }[];
  name?: string;
  label: string;
  direction?: 'column' | 'row';
  className?: string;
}

export function RadioGroup<T extends string>({ value, onChange, options, name, label, direction = 'column', className }: RadioGroupProps<T>) {
  const autoName = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cx('ain-radiogroup', direction === 'row' && 'ain-radiogroup--row', className)}>
      {options.map((o) => (
        <Radio
          key={o.value}
          name={name ?? autoName}
          value={o.value}
          checked={o.value === value}
          disabled={o.disabled}
          label={o.label}
          hint={o.hint}
          onChange={(checked) => checked && onChange(o.value)}
        />
      ))}
    </div>
  );
}

/* ================================ Slider ================================== */

export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** Rendered to the right of the track and announced as the value text. */
  format?: (value: number) => string;
  ticks?: [string, string];
  'aria-label': string;
  className?: string;
  id?: string;
}

export function Slider({
  value, onChange, min = 0, max = 100, step = 1, disabled, format, ticks, className, id, ...aria
}: SliderProps) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  const text = format ? format(value) : String(value);
  return (
    <div className={cx('ain-slider', className)}>
      <div className="ain-slider__row">
        <input
          id={id}
          type="range"
          className="ain-slider__input"
          style={{ ['--pct' as string]: pct }}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={aria['aria-label']}
          aria-valuetext={text}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output className="ain-slider__value" htmlFor={id}>{text}</output>
      </div>
      {ticks && <div className="ain-slider__ticks"><span>{ticks[0]}</span><span>{ticks[1]}</span></div>}
    </div>
  );
}

/* ================================== Kbd =================================== */

const KEY_GLYPH: Record<string, string> = {
  mod: typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl',
  cmd: '⌘', meta: '⌘', shift: '⇧', alt: '⌥', option: '⌥', ctrl: 'Ctrl', control: 'Ctrl',
  enter: '↵', esc: 'Esc', escape: 'Esc', backspace: '⌫', tab: '⇥', space: 'Space',
  up: '↑', down: '↓', left: '←', right: '→',
};

/** `<Kbd combo="mod+k" />` renders ⌘K on Apple platforms and Ctrl K elsewhere. */
export function Kbd({ combo, children }: { combo?: string; children?: ReactNode }) {
  if (!combo) return <kbd className="ain-kbd">{children}</kbd>;
  const keys = combo.split('+').map((k) => KEY_GLYPH[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k));
  return (
    <span className="u-row" style={{ gap: 2 }}>
      {keys.map((k, i) => <kbd className="ain-kbd" key={i}>{k}</kbd>)}
    </span>
  );
}

/** Copies the caller from writing the same `useState` for every toggle strip. */
export function useSegmented<T extends string>(initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  return [value, useCallback((v: T) => setValue(v), [])];
}

export { ICON_SIZE };
