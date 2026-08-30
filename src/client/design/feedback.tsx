import { useState, type CSSProperties, type ReactNode } from 'react';
import { cx } from './layout';
import { AlertTriangleIcon, Icons } from './icons';
import './feedback.css';

/* ================================ Spinner ================================= */

export interface SpinnerProps {
  size?: number;
  className?: string;
  /** Give the spinner a name when it is the only thing on screen. */
  label?: string;
}

export function Spinner({ size = 16, className, label }: SpinnerProps) {
  const r = (size - 2.4) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span role={label ? 'status' : undefined} aria-label={label} className={cx('u-row', className)}>
      <svg className="ain-spinner" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path
          d={`M ${size / 2} ${size / 2 - r} a ${r} ${r} 0 0 1 0 ${r * 2}`}
          fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
          strokeDasharray={`${c * 0.32} ${c}`}
        />
      </svg>
      {label && <span className="u-visually-hidden">{label}</span>}
    </span>
  );
}

/* =============================== Skeleton ================================= */

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  variant?: 'text' | 'circle' | 'block';
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ width, height, variant = 'block', className, style }: SkeletonProps) {
  return (
    <span
      className={cx('ain-skel', `ain-skel--${variant}`, className)}
      style={{
        width: typeof width === 'number' ? `${width}px` : width ?? '100%',
        height: typeof height === 'number' ? `${height}px` : height ?? (variant === 'text' ? undefined : '1em'),
        ...style,
      }}
      aria-hidden
    />
  );
}

/** A paragraph of shimmering lines with a naturally ragged last line. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span className={cx('ain-skel-lines', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} variant="text" width={i === lines - 1 ? '62%' : `${86 + ((i * 7) % 14)}%`} />
      ))}
    </span>
  );
}

/* ============================== Illustration ============================== */

/** The house empty-state drawing: a stack of cards with the top one missing. */
export function EmptyIllustration({ size = 76 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.72} viewBox="0 0 100 72" fill="none" aria-hidden>
      <rect x="14" y="26" width="72" height="40" rx="6" fill="var(--bg-sunken)" stroke="var(--border-default)" />
      <rect x="20" y="18" width="60" height="40" rx="6" fill="var(--bg-surface)" stroke="var(--border-default)" />
      <rect x="26" y="10" width="48" height="40" rx="6" fill="var(--bg-surface)" stroke="var(--border-strong)" strokeDasharray="4 3" />
      <path d="M36 24h28M36 32h20M36 40h14" stroke="var(--border-default)" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="74" cy="52" r="12" fill="var(--accent-subtle)" stroke="var(--border-brand)" strokeWidth="1.4" />
      <path d="M74 46.5v11M68.5 52h11" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/* ============================== EmptyState ================================ */

export interface EmptyStateProps {
  title: ReactNode;
  /** Say what will fill this space and how to make it happen. */
  body?: ReactNode;
  /** Any node: an illustration, an icon in a circle, or nothing. */
  illustration?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  size?: 'sm' | 'md';
  inline?: boolean;
  className?: string;
}

export function EmptyState({ title, body, illustration, action, secondaryAction, size = 'md', inline, className }: EmptyStateProps) {
  return (
    <div className={cx('ain-empty', size === 'sm' && 'ain-empty--sm', inline && 'ain-empty--inline', className)}>
      {illustration !== null && <div className="ain-empty__art">{illustration ?? <EmptyIllustration size={size === 'sm' ? 56 : 76} />}</div>}
      <div className="ain-empty__title">{title}</div>
      {body && <p className="ain-empty__body">{body}</p>}
      {(action || secondaryAction) && (
        <div className="ain-empty__actions">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

/* =============================== ErrorState =============================== */

export interface ErrorStateProps {
  title?: ReactNode;
  message?: ReactNode;
  /** Shown verbatim so a customer can quote it to support. */
  requestId?: string | null;
  code?: string | null;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
}

export function ErrorState({
  title = 'That request did not go through',
  message = 'The server refused the call. Retrying usually clears a transient failure; if it persists, quote the request id below.',
  requestId, code, action, secondaryAction, className,
}: ErrorStateProps) {
  return (
    <div className={cx('ain-errorstate', className)} role="alert">
      <div className="ain-errorstate__badge"><AlertTriangleIcon size={22} /></div>
      <div className="ain-errorstate__title">{title}</div>
      {message && <p className="ain-errorstate__body">{message}</p>}
      {(requestId || code) && (
        <div className="ain-errorstate__meta">
          {code && <span>{code}</span>}
          {code && requestId && <span aria-hidden>·</span>}
          {requestId && <span>{requestId}</span>}
        </div>
      )}
      {(action || secondaryAction) && <div className="ain-errorstate__actions">{action}{secondaryAction}</div>}
    </div>
  );
}

/* ================================ Banner ================================== */

export type BannerTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

const BANNER_ICON: Record<BannerTone, keyof typeof Icons> = {
  info: 'info', success: 'check-circle', warning: 'alert-triangle', danger: 'alert-octagon', neutral: 'info',
};

export interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  onDismiss?: () => void;
  /** Full-bleed variant for the top of a page. */
  bar?: boolean;
  compact?: boolean;
  className?: string;
}

export function Banner({ tone = 'info', title, children, actions, icon, onDismiss, bar, compact, className }: BannerProps) {
  const Icon = Icons[BANNER_ICON[tone]];
  return (
    <div
      className={cx('ain-banner', `ain-banner--${tone}`, bar && 'ain-banner--bar', compact && 'ain-banner--compact', className)}
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
    >
      <span className="ain-banner__icon">{icon ?? <Icon size={16} />}</span>
      <div className="ain-banner__content">
        {title && <div className="ain-banner__title">{title}</div>}
        {children && <div className="ain-banner__body">{children}</div>}
        {actions && <div className="ain-banner__actions">{actions}</div>}
      </div>
      {onDismiss && (
        <button type="button" className="ain-iconbtn ain-iconbtn--sm ain-banner__dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <Icons.x size={14} />
        </button>
      )}
    </div>
  );
}

/** A Banner that remembers it was dismissed for the life of the page. */
export function DismissibleBanner(props: BannerProps) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return <Banner {...props} onDismiss={() => { setOpen(false); props.onDismiss?.(); }} />;
}

export const InlineAlert = Banner;
