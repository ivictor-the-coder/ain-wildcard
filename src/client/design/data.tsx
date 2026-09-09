import { useMemo, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from './layout';
import { Icons } from './icons';
import { Sparkline } from './charts';
import { toneStyle, toneForStatus, type Tone } from './color';
import { formatDelta, formatNumber, formatPercent, humanize, initials as toInitials } from './format';
import './data.css';

/* ================================= Badge ================================== */

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  /** Rounded-full instead of the default square-ish chip. */
  pill?: boolean;
  solid?: boolean;
  dot?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', size = 'md', pill, solid, dot, icon, children, className, ...rest }: BadgeProps) {
  return (
    <span
      className={cx('ain-badge', `ain-badge--${tone}`, size !== 'md' && `ain-badge--${size}`, pill && 'ain-badge--pill', solid && 'ain-badge--solid', className)}
      {...rest}
    >
      {dot && <span className="ain-badge__dot" aria-hidden />}
      {icon}
      <span className="ain-badge__label">{children}</span>
    </span>
  );
}

/** Renders a domain status word with the tone the whole product agrees on. */
export function StatusBadge({ status, label, ...rest }: { status: string; label?: ReactNode } & Omit<BadgeProps, 'children' | 'tone'>) {
  return <Badge tone={toneForStatus(status)} dot {...rest}>{label ?? humanize(status)}</Badge>;
}

/* =============================== StatusDot ================================ */

export interface StatusDotProps {
  tone?: Tone;
  label?: ReactNode;
  /** Halo animation for live/running states. */
  pulse?: boolean;
  className?: string;
}

export function StatusDot({ tone = 'neutral', label, pulse, className }: StatusDotProps) {
  return (
    <span className={cx('ain-status', `ain-status--${tone}`, pulse && 'ain-status--pulse', className)}>
      <span className="ain-status__dot" aria-hidden />
      {label}
    </span>
  );
}

/* ================================== Tag =================================== */

export interface TagProps {
  children: ReactNode;
  onRemove?: () => void;
  /** Tint the chip deterministically from its own text. */
  colorSeed?: string;
  className?: string;
}

export function Tag({ children, onRemove, colorSeed, className }: TagProps) {
  const style = colorSeed ? toneStyle(colorSeed) : undefined;
  return (
    <span
      className={cx('ain-tag', !onRemove && 'ain-tag--plain', className)}
      style={style ? { background: style.background, color: style.color, borderColor: 'transparent' } : undefined}
    >
      <span className="u-truncate">{children}</span>
      {onRemove && (
        <button type="button" className="ain-tag__remove" onClick={onRemove} aria-label={`Remove ${typeof children === 'string' ? children : 'tag'}`}>
          <Icons.x size={11} />
        </button>
      )}
    </span>
  );
}

/* ================================= Pill =================================== */

export interface PillProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  active?: boolean;
  count?: number;
  icon?: ReactNode;
  children: ReactNode;
}

/** A filter chip. Groups of these replace a dropdown when there are few options. */
export function Pill({ active, count, icon, children, className, ...rest }: PillProps) {
  return (
    <button type="button" className={cx('ain-pill', className)} aria-pressed={!!active} {...rest}>
      {icon}
      {children}
      {count !== undefined && <span className="ain-pill__count">{formatNumber(count)}</span>}
    </button>
  );
}

export const PillGroup = ({ children, className, label }: { children: ReactNode; className?: string; label: string }) => (
  <div className={cx('ain-pillgroup', className)} role="group" aria-label={label}>{children}</div>
);

/* ================================= Avatar ================================= */

export interface AvatarProps {
  name: string;
  src?: string | null;
  size?: number;
  square?: boolean;
  presence?: 'online' | 'away' | 'offline';
  /** Defaults to the name; pass an id to keep colour stable across renames. */
  seed?: string;
  className?: string;
  title?: string;
}

export function Avatar({ name, src, size = 28, square, presence, seed, className, title }: AvatarProps) {
  const style = useMemo(() => toneStyle(seed ?? name), [seed, name]);
  return (
    <span
      className={cx('ain-avatar', square && 'ain-avatar--square', className)}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)), ...(src ? {} : { background: style.background, color: style.color }) }}
      title={title ?? name}
      role="img"
      aria-label={name}
    >
      {src ? <img src={src} alt="" /> : toInitials(name)}
      {presence && <span className={cx('ain-avatar__presence', `ain-avatar__presence--${presence}`)} aria-hidden />}
    </span>
  );
}

export interface AvatarGroupProps {
  people: { name: string; src?: string | null; id?: string }[];
  max?: number;
  size?: number;
  className?: string;
}

export function AvatarGroup({ people, max = 4, size = 24, className }: AvatarGroupProps) {
  const shown = people.slice(0, max);
  const overflow = people.length - shown.length;
  return (
    <span className={cx('ain-avatargroup', className)} role="group" aria-label={`${people.length} people`}>
      {shown.map((p, i) => <Avatar key={p.id ?? p.name + i} name={p.name} src={p.src} seed={p.id} size={size} />)}
      {overflow > 0 && (
        <span
          className="ain-avatar ain-avatargroup__more"
          style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.36)) }}
          title={people.slice(max).map((p) => p.name).join(', ')}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

/* ============================ DescriptionList ============================= */

export interface DescriptionItem {
  term: ReactNode;
  value: ReactNode;
  /** A small icon or help affordance beside the term. */
  hint?: ReactNode;
  key?: string;
}

export interface DescriptionListProps {
  items: DescriptionItem[];
  layout?: 'inline' | 'stacked';
  columns?: number;
  divided?: boolean;
  className?: string;
}

export function DescriptionList({ items, layout = 'inline', columns = 1, divided, className }: DescriptionListProps) {
  const style = layout === 'inline' && columns > 1
    ? { gridTemplateColumns: `repeat(${columns}, minmax(120px, max-content) 1fr)` }
    : undefined;
  return (
    <dl className={cx('ain-dl', `ain-dl--${layout}`, divided && 'ain-dl--divided', className)} style={style}>
      {items.map((item, i) => (
        <div className="ain-dl__row" key={item.key ?? i}>
          <dt className="ain-dl__term">{item.term}{item.hint}</dt>
          <dd className="ain-dl__value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface KeyValueProps {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
  total?: boolean;
  className?: string;
}

/** A single aligned line — invoice summaries are built from a stack of these. */
export function KeyValue({ label, value, strong, total, className }: KeyValueProps) {
  return (
    <div className={cx('ain-kv', strong && 'ain-kv--strong', total && 'ain-kv--total', className)}>
      <span className="ain-kv__k">{label}</span>
      <span className="ain-kv__v">{value}</span>
    </div>
  );
}

/* ================================ Timeline ================================ */

export interface TimelineEntry {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  time?: ReactNode;
  icon?: ReactNode;
  tone?: 'neutral' | 'brand' | 'success' | 'warning' | 'danger';
  /** Anything richer than a sentence: a quoted email, a diff, a payload. */
  children?: ReactNode;
}

export function Timeline({ entries, className }: { entries: TimelineEntry[]; className?: string }) {
  return (
    <ol className={cx('ain-timeline', className)}>
      {entries.map((entry) => (
        <li className="ain-timeline__item" key={entry.id}>
          <div className="ain-timeline__rail">
            <span className={cx('ain-timeline__marker', entry.tone && entry.tone !== 'neutral' && `ain-timeline__marker--${entry.tone}`)}>
              {entry.icon ?? <Icons.check size={12} />}
            </span>
          </div>
          <div className="ain-timeline__body">
            <div className="ain-timeline__head">
              <span className="ain-timeline__title">{entry.title}</span>
              {entry.time && <span className="ain-timeline__time">{entry.time}</span>}
            </div>
            {entry.description && <div className="ain-timeline__desc">{entry.description}</div>}
            {entry.children && <div className="ain-timeline__extra">{entry.children}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ================================= Delta ================================== */

export interface DeltaProps {
  /** Signed fraction, e.g. 0.124 for +12.4%. */
  value: number | null;
  /** For metrics where down is good — churn, cost per lead, time to resolve. */
  inverted?: boolean;
  unit?: 'percent' | 'number';
  suffix?: ReactNode;
  className?: string;
}

export function Delta({ value, inverted, unit = 'percent', suffix, className }: DeltaProps) {
  if (value === null || !Number.isFinite(value)) {
    return <span className={cx('ain-delta', 'ain-delta--flat', className)}>—</span>;
  }
  const direction = value > 0.0001 ? 'up' : value < -0.0001 ? 'down' : 'flat';
  const Icon = direction === 'up' ? Icons['arrow-up'] : direction === 'down' ? Icons['arrow-down'] : Icons.minus;
  return (
    <span className={cx('ain-delta', `ain-delta--${direction}`, inverted && 'ain-delta--inverted', className)}>
      <Icon size={13} />
      {formatDelta(Math.abs(value), { unit, signDisplay: 'never' })}
      {suffix}
    </span>
  );
}

/* ================================== Stat ================================== */

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  /** Signed fraction change against the comparison period. */
  delta?: number | null;
  deltaInverted?: boolean;
  caption?: ReactNode;
  icon?: ReactNode;
  sparkline?: number[];
  sparklineColor?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function Stat({
  label, value, delta, deltaInverted, caption, icon, sparkline, sparklineColor, size = 'md', className,
}: StatProps) {
  return (
    <div className={cx('ain-stat', size !== 'md' && `ain-stat--${size}`, className)}>
      <div className="ain-stat__head">
        {icon}
        <span className="ain-stat__label">{label}</span>
      </div>
      <div className="ain-stat__row">
        <span className="ain-stat__value">{value}</span>
        {sparkline && sparkline.length > 1 && (
          <span className="ain-stat__spark">
            <Sparkline values={sparkline} color={sparklineColor} autoTone={!sparklineColor} width={92} height={28} />
          </span>
        )}
      </div>
      {(delta !== undefined || caption) && (
        <div className="ain-stat__foot">
          {delta !== undefined && <Delta value={delta ?? null} inverted={deltaInverted} />}
          {caption && <span className="ain-stat__caption">{caption}</span>}
        </div>
      )}
    </div>
  );
}

export interface MetricTileProps extends StatProps {
  onClick?: () => void;
  href?: string;
}

export function MetricTile({ onClick, href, className, ...stat }: MetricTileProps) {
  const content = <Stat {...stat} />;
  if (href) return <a href={href} className={cx('ain-stat-tile', 'ain-stat-tile--interactive', className)}>{content}</a>;
  if (onClick) return <button type="button" onClick={onClick} className={cx('ain-stat-tile', 'ain-stat-tile--interactive', className)}>{content}</button>;
  return <div className={cx('ain-stat-tile', className)}>{content}</div>;
}

/* =============================== ProgressBar ============================== */

export interface ProgressBarProps {
  /** 0–1. Values outside the range are clamped. */
  value: number;
  label?: ReactNode;
  valueLabel?: ReactNode;
  tone?: 'brand' | 'success' | 'warning' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  indeterminate?: boolean;
  className?: string;
}

export function ProgressBar({ value, label, valueLabel, tone = 'brand', size = 'md', indeterminate, className }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className={cx('ain-progress', tone !== 'brand' && `ain-progress--${tone}`, size !== 'md' && `ain-progress--${size}`, indeterminate && 'ain-progress--indeterminate', className)}>
      {(label || valueLabel) && (
        <div className="ain-progress__head">
          <span className="ain-progress__label">{label}</span>
          <span className="ain-progress__value">{valueLabel ?? formatPercent(pct)}</span>
        </div>
      )}
      <div
        className="ain-progress__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(pct * 100)}
        aria-label={typeof label === 'string' ? label : undefined}
      >
        <div className="ain-progress__fill" style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

/* ================================= Meter ================================== */

export interface MeterProps {
  value: number;
  limit: number;
  label?: ReactNode;
  /** Formats both the value and the limit — usually a money or unit formatter. */
  format?: (value: number) => string;
  /** Fraction of the limit at which the bar turns amber, then red. */
  thresholds?: { warning: number; danger: number };
  /** A second mark on the track, e.g. last period's usage at the same point. */
  marker?: { value: number; label: string };
  footnote?: ReactNode;
  className?: string;
}

/** A usage bar that changes tone as the customer approaches their included limit. */
export function Meter({
  value, limit, label, format = (v) => formatNumber(v), thresholds = { warning: 0.8, danger: 1 }, marker, footnote, className,
}: MeterProps) {
  const ratio = limit > 0 ? value / limit : 0;
  const clamped = Math.max(0, Math.min(1, ratio));
  const color = ratio >= thresholds.danger ? 'var(--red-500)' : ratio >= thresholds.warning ? 'var(--amber-500)' : 'var(--accent)';
  return (
    <div className={cx('ain-meter', className)}>
      <div className="ain-meter__head">
        <span className="ain-meter__label">{label}</span>
        <span className="ain-meter__figures">
          {format(value)} <span className="ain-meter__limit">/ {format(limit)}</span>
        </span>
      </div>
      <div
        className="ain-meter__track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={value}
        aria-valuetext={`${format(value)} of ${format(limit)}`}
        aria-label={typeof label === 'string' ? label : undefined}
      >
        <div className="ain-meter__fill" style={{ width: `${clamped * 100}%`, background: color }} />
        {marker && limit > 0 && (
          <div className="ain-meter__marker" style={{ insetInlineStart: `${Math.min(100, (marker.value / limit) * 100)}%` }} title={marker.label} />
        )}
      </div>
      <div className="ain-meter__foot">
        <span>{formatPercent(clamped)} used</span>
        <span>{footnote ?? (ratio > 1 ? `${format(value - limit)} over` : `${format(Math.max(0, limit - value))} left`)}</span>
      </div>
    </div>
  );
}
