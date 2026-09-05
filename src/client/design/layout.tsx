import {
  forwardRef, type CSSProperties, type ElementType, type HTMLAttributes, type ReactNode,
} from 'react';
import { ErrorBoundary } from './error-boundary';
import { cx } from './cx';
import './layout.css';

export { cx } from './cx';

export type Space = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
const space = (n: Space | undefined): string | undefined => (n === undefined ? undefined : `var(--space-${n})`);


/* -------------------------------- Page ----------------------------------- */

export interface PageProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Small uppercase label above the title, e.g. the object type. */
  eyebrow?: ReactNode;
  breadcrumbs?: ReactNode;
  actions?: ReactNode;
  /** Rendered flush under the header — usually <Tabs/>. */
  tabs?: ReactNode;
  /** Badge or status chip shown inline with the title. */
  badge?: ReactNode;
  width?: 'narrow' | 'default' | 'wide';
  /** Remove body padding for full-bleed surfaces such as an inbox. */
  flush?: boolean;
  stickyHeader?: boolean;
  children?: ReactNode;
  className?: string;
}

export function Page({
  title, subtitle, eyebrow, breadcrumbs, actions, tabs, badge,
  width = 'default', flush = false, stickyHeader = true, children, className,
}: PageProps) {
  return (
    <div className={cx('ain-page', `ain-page--${width}`, className)}>
      <header className={cx('ain-page__header', !stickyHeader && 'is-static')}>
        <div className="ain-page__headerinner">
          {breadcrumbs && <div className="ain-page__crumbs">{breadcrumbs}</div>}
          <div className="ain-page__titlerow">
            <div className="ain-page__titles">
              {eyebrow && <div className="ain-page__eyebrow">{eyebrow}</div>}
              <h1 className="ain-page__title">
                {title}
                {badge}
              </h1>
              {subtitle && <p className="ain-page__subtitle">{subtitle}</p>}
            </div>
            {actions && <div className="ain-page__actions">{actions}</div>}
          </div>
        </div>
        {tabs && <div className="ain-page__tabs">{tabs}</div>}
      </header>
      <div className={cx('ain-page__body', flush && 'is-flush')}>
        {/* Every routed screen in the product is a Page, so this is the boundary
            that decides whether a bug in one module costs the operator a panel
            or the whole app. It costs a panel: the header, the nav and the
            command palette stay live and they can navigate away. */}
        <ErrorBoundary
          title="This page stopped rendering"
          message="Something in it threw while drawing. The rest of the app is unaffected — you can navigate away, or try again. If it keeps failing, quote the message below."
          resetKeys={[title]}
        >
          {children}
        </ErrorBoundary>
      </div>
    </div>
  );
}

/* ------------------------------- Section --------------------------------- */

export interface SectionProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Draw a rule under the heading — for long settings pages. */
  rule?: boolean;
  id?: string;
  children?: ReactNode;
  className?: string;
}

export function Section({ title, description, actions, rule, id, children, className }: SectionProps) {
  return (
    <section id={id} className={cx('ain-section', rule && 'ain-section--rule', className)}>
      {(title || description || actions) && (
        <div className="ain-section__head">
          <div className="ain-section__heads">
            {title && <h2 className="ain-section__title">{title}</h2>}
            {description && <p className="ain-section__desc">{description}</p>}
          </div>
          {actions && <div className="ain-section__actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/* --------------------------------- Card ---------------------------------- */

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  variant?: 'default' | 'flat' | 'raised' | 'ghost' | 'sunken';
  padding?: 'default' | 'tight' | 'none';
  interactive?: boolean;
  selected?: boolean;
  as?: ElementType;
  children?: ReactNode;
}

export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { title, description, actions, footer, variant = 'default', padding = 'default',
    interactive, selected, as, children, className, ...rest }, ref,
) {
  const Tag = (as ?? (interactive ? 'button' : 'div')) as ElementType;
  const hasHeader = title || description || actions;
  return (
    <Tag
      ref={ref}
      className={cx('ain-card', `ain-card--${variant}`, interactive && 'ain-card--interactive', selected && 'ain-card--selected', className)}
      aria-pressed={interactive && selected !== undefined ? selected : undefined}
      {...(Tag === 'button' ? { type: 'button' } : {})}
      {...rest}
    >
      {hasHeader && (
        <div className="ain-card__header">
          <div className="ain-card__headtext">
            {title && <div className="ain-card__title">{title}</div>}
            {description && <div className="ain-card__desc">{description}</div>}
          </div>
          {actions && <div className="ain-card__actions">{actions}</div>}
        </div>
      )}
      <div className={cx('ain-card__body', padding === 'none' && 'is-flush', padding === 'tight' && 'is-tight')}>{children}</div>
      {footer && <div className="ain-card__footer">{footer}</div>}
    </Tag>
  );
});

/* --------------------------------- Panel --------------------------------- */

export interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

export function Panel({ title, actions, children, className, ...rest }: PanelProps) {
  return (
    <div className={cx('ain-panel', className)} {...rest}>
      {(title || actions) && (
        <div className="ain-panel__header">
          {title && <div className="ain-panel__title">{title}</div>}
          {actions}
        </div>
      )}
      <div className="ain-panel__body">{children}</div>
    </div>
  );
}

/* --------------------------------- Split --------------------------------- */

export interface SplitProps {
  /** Aside width. A number is px; a string is any grid track value. */
  asideWidth?: number | string;
  side?: 'left' | 'right';
  gap?: Space;
  sticky?: boolean;
  aside: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Split({ asideWidth = 320, side = 'right', gap = 7, sticky, aside, children, className }: SplitProps) {
  const track = typeof asideWidth === 'number' ? `${asideWidth}px` : asideWidth;
  return (
    <div
      className={cx('ain-split', sticky && 'ain-split--sticky', className)}
      style={{ gridTemplateColumns: side === 'right' ? `minmax(0,1fr) ${track}` : `${track} minmax(0,1fr)`, gap: space(gap) }}
    >
      {side === 'left' && <div className="ain-split__aside">{aside}</div>}
      <div className="ain-split__main">{children}</div>
      {side === 'right' && <div className="ain-split__aside">{aside}</div>}
    </div>
  );
}

/* ---------------------------- Stack / Inline ----------------------------- */

type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
type Justify = 'start' | 'center' | 'end' | 'between' | 'around';
const ALIGN: Record<Align, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };
const JUSTIFY: Record<Justify, string> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around' };

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  gap?: Space;
  align?: Align;
  justify?: Justify;
  as?: ElementType;
  children?: ReactNode;
}

export function Stack({ gap = 4, align, justify, as, children, className, style, ...rest }: StackProps) {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag
      className={cx('ain-stack', className)}
      style={{ gap: space(gap), alignItems: align && ALIGN[align], justifyContent: justify && JUSTIFY[justify], ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export interface InlineProps extends StackProps { wrap?: boolean }

export function Inline({ gap = 4, align = 'center', justify, wrap, as, children, className, style, ...rest }: InlineProps) {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag
      className={cx('ain-inline', wrap && 'ain-inline--wrap', className)}
      style={{ gap: space(gap), alignItems: ALIGN[align], justifyContent: justify && JUSTIFY[justify], ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** Pushes whatever follows it to the far edge of a flex row. */
export const Spacer = () => <div className="u-spacer" aria-hidden />;

/* --------------------------------- Grid ---------------------------------- */

export interface GridProps extends HTMLAttributes<HTMLDivElement> {
  columns?: number;
  /** Auto-fit tracks at least this wide — responsive without media queries. */
  minColumnWidth?: number;
  gap?: Space;
  rowGap?: Space;
  children?: ReactNode;
}

export function Grid({ columns, minColumnWidth, gap = 6, rowGap, children, className, style, ...rest }: GridProps) {
  const template = minColumnWidth
    ? `repeat(auto-fit, minmax(min(${minColumnWidth}px, 100%), 1fr))`
    : `repeat(${columns ?? 12}, minmax(0, 1fr))`;
  return (
    <div
      className={cx('ain-grid', className)}
      style={{ gridTemplateColumns: template, gap: space(gap), rowGap: space(rowGap), ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface GridItemProps extends HTMLAttributes<HTMLDivElement> { span?: number; children?: ReactNode }

export function GridItem({ span = 1, children, className, style, ...rest }: GridItemProps) {
  return (
    <div className={className} style={{ gridColumn: `span ${span} / span ${span}`, minWidth: 0, ...style }} {...rest}>
      {children}
    </div>
  );
}

/* ------------------------------- Divider --------------------------------- */

export interface DividerProps {
  orientation?: 'horizontal' | 'vertical';
  label?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Divider({ orientation = 'horizontal', label, className, style }: DividerProps) {
  if (label) {
    return (
      <div className={cx('ain-divider', 'ain-divider--labelled', className)} style={style} role="separator">
        <span className="ain-divider__label">{label}</span>
      </div>
    );
  }
  return (
    <div
      className={cx('ain-divider', orientation === 'vertical' ? 'ain-divider--v' : 'ain-divider--h', className)}
      style={style}
      role="separator"
      aria-orientation={orientation}
    />
  );
}

/* ------------------------------ ScrollArea -------------------------------- */

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  maxHeight?: number | string;
  /** Fade the top and bottom edges so clipped content reads as scrollable. */
  fade?: boolean;
  children?: ReactNode;
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { maxHeight, fade, children, className, style, ...rest }, ref,
) {
  return (
    <div
      ref={ref}
      className={cx('ain-scroll', fade && 'ain-scroll--fade', className)}
      style={{ maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
});

/* ------------------------------- Toolbar --------------------------------- */

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  sticky?: boolean;
  plain?: boolean;
  'aria-label'?: string;
  children?: ReactNode;
}

export function Toolbar({ sticky, plain, children, className, ...rest }: ToolbarProps) {
  return (
    <div
      role="toolbar"
      className={cx('ain-toolbar', sticky && 'ain-toolbar--sticky', plain && 'ain-toolbar--plain', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export const ToolbarGroup = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cx('ain-toolbar__group', className)}>{children}</div>
);

/* ------------------------------- Surface --------------------------------- */

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'sunken' | 'accent';
  padding?: Space;
  children?: ReactNode;
}

export function Surface({ variant = 'default', padding = 6, children, className, style, ...rest }: SurfaceProps) {
  return (
    <div
      className={cx('ain-surface', variant !== 'default' && `ain-surface--${variant}`, className)}
      style={{ padding: space(padding), ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}
