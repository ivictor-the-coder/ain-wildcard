import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from './layout';
import { ChevronLeftIcon, ChevronRightIcon, Icons } from './icons';
import { IconButton } from './controls';
import { formatNumber } from './format';
import './nav.css';

/* ================================= Tabs =================================== */

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  count?: number;
  icon?: ReactNode;
  disabled?: boolean;
  /** For `<Tabs as="link">`, the href each tab navigates to. */
  href?: string;
}

export interface TabsProps<T extends string> {
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  variant?: 'underline' | 'pill';
  /** Tabs that control a panel below get `role="tablist"`; navigation tabs don't. */
  role?: 'tablist' | 'navigation';
  'aria-label': string;
  className?: string;
}

/** Arrow keys move between tabs and select as they go, per WAI-ARIA. */
export function Tabs<T extends string>({
  tabs, value, onChange, variant = 'underline', role = 'tablist', className, ...aria
}: TabsProps<T>) {
  const ref = useRef<HTMLDivElement>(null);

  // Selecting a tab has to carry focus with it. Home and End used to call
  // `onChange` on their own, which moved the roving tabindex to the new tab
  // while `document.activeElement` stayed on the old one — the ring sat on
  // "Invoices" while "Usage" was selected, and the next Tab left the tablist
  // from a tab that was no longer part of it.
  const selectTab = (id: T) => {
    onChange(id);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"]`)?.focus());
  };

  const move = (delta: number) => {
    const enabled = tabs.filter((t) => !t.disabled);
    const index = enabled.findIndex((t) => t.id === value);
    const next = enabled[(index + delta + enabled.length) % enabled.length];
    if (!next) return;
    selectTab(next.id);
  };

  return (
    <div className="ain-tabs__scroll">
      <div
        ref={ref}
        role={role === 'tablist' ? 'tablist' : undefined}
        aria-label={aria['aria-label']}
        className={cx('ain-tabs', `ain-tabs--${variant}`, className)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
          else if (e.key === 'Home') { e.preventDefault(); const f = tabs.find((t) => !t.disabled); if (f) selectTab(f.id); }
          else if (e.key === 'End') { e.preventDefault(); const l = [...tabs].reverse().find((t) => !t.disabled); if (l) selectTab(l.id); }
        }}
      >
        {tabs.map((tab) => {
          const selected = tab.id === value;
          return (
            <button
              key={tab.id}
              type="button"
              data-tab={tab.id}
              // `TabPanel` labels itself with `aria-labelledby={id}`; without
              // this the reference pointed at nothing and a screen reader
              // announced the panel unnamed.
              id={role === 'tablist' ? tab.id : undefined}
              role={role === 'tablist' ? 'tab' : undefined}
              aria-selected={selected}
              aria-controls={role === 'tablist' ? `panel-${tab.id}` : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={tab.disabled}
              className="ain-tabs__tab"
              onClick={() => onChange(tab.id)}
            >
              {tab.icon}
              {tab.label}
              {tab.count !== undefined && <span className="ain-tabs__count">{formatNumber(tab.count)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TabPanel({ id, active, children }: { id: string; active: boolean; children: ReactNode }) {
  if (!active) return null;
  return <div role="tabpanel" id={`panel-${id}`} aria-labelledby={id} tabIndex={0}>{children}</div>;
}

/* ============================== Breadcrumbs =============================== */

export interface Crumb {
  label: ReactNode;
  href?: string;
  onClick?: () => void;
}

export interface BreadcrumbsProps {
  items: Crumb[];
  /** Collapse the middle when the trail is deep. */
  maxItems?: number;
  className?: string;
}

export function Breadcrumbs({ items, maxItems = 4, className }: BreadcrumbsProps) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = !expanded && items.length > maxItems;
  const shown = collapsed ? [items[0], ...items.slice(items.length - (maxItems - 1))] : items;

  return (
    <nav aria-label="Breadcrumb" className={cx('ain-crumbs', className)}>
      {shown.map((item, i) => {
        const isLast = i === shown.length - 1;
        const showEllipsis = collapsed && i === 1;
        return (
          <span className="ain-crumbs__item" key={i}>
            {i > 0 && <span className="ain-crumbs__sep" aria-hidden><ChevronRightIcon size={12} /></span>}
            {showEllipsis && (
              <>
                <button type="button" className="ain-crumbs__link" onClick={() => setExpanded(true)} aria-label="Show the full trail">…</button>
                <span className="ain-crumbs__sep" aria-hidden><ChevronRightIcon size={12} /></span>
              </>
            )}
            {isLast ? (
              <span className="ain-crumbs__current" aria-current="page">{item.label}</span>
            ) : item.href ? (
              <a className="ain-crumbs__link" href={item.href} onClick={item.onClick}>{item.label}</a>
            ) : (
              <button type="button" className="ain-crumbs__link" onClick={item.onClick}>{item.label}</button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/* =============================== Pagination =============================== */

export interface PaginationProps {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  /** Renders "1–25 of 312" beside the controls. */
  total?: number;
  pageSize?: number;
  className?: string;
}

/** Window of page numbers around the current page, with … for the gaps. */
export function pageWindow(page: number, pageCount: number, span = 1): (number | 'gap')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const pages = new Set<number>([1, pageCount, page]);
  for (let d = 1; d <= span; d++) {
    if (page - d > 1) pages.add(page - d);
    if (page + d < pageCount) pages.add(page + d);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  let previous = 0;
  for (const p of sorted) {
    if (previous && p - previous > 1) out.push('gap');
    out.push(p);
    previous = p;
  }
  return out;
}

export function Pagination({ page, pageCount, onChange, total, pageSize, className }: PaginationProps) {
  const items = useMemo(() => pageWindow(page, pageCount), [page, pageCount]);
  const from = pageSize ? (page - 1) * pageSize + 1 : null;
  const to = pageSize && total !== undefined ? Math.min(total, page * pageSize) : null;

  return (
    <nav className={cx('ain-pagination', className)} aria-label="Pagination">
      {total !== undefined && from !== null && (
        <span className="ain-pagination__info">
          {formatNumber(from)}–{formatNumber(to ?? 0)} of {formatNumber(total)}
        </span>
      )}
      <IconButton size="sm" label="Previous page" icon={<ChevronLeftIcon size={15} />} disabled={page <= 1} onClick={() => onChange(page - 1)} />
      {items.map((item, i) => (
        item === 'gap'
          ? <span className="ain-pagination__gap" key={`gap-${i}`} aria-hidden>…</span>
          : (
            <button
              key={item}
              type="button"
              className="ain-pagination__page"
              aria-current={item === page ? 'page' : undefined}
              aria-label={`Page ${item}`}
              onClick={() => onChange(item)}
            >
              {item}
            </button>
          )
      ))}
      <IconButton size="sm" label="Next page" icon={<ChevronRightIcon size={15} />} disabled={page >= pageCount} onClick={() => onChange(page + 1)} />
    </nav>
  );
}

/* ================================= Steps ================================== */

export interface StepDef {
  id: string;
  label: ReactNode;
  description?: ReactNode;
}

export interface StepsProps {
  steps: StepDef[];
  /** Index of the step in progress; everything before it reads as complete. */
  current: number;
  orientation?: 'horizontal' | 'vertical';
  onStepClick?: (index: number) => void;
  className?: string;
}

export function Steps({ steps, current, orientation = 'horizontal', onStepClick, className }: StepsProps) {
  return (
    <ol className={cx('ain-steps', orientation === 'vertical' && 'ain-steps--vertical', className)} aria-label="Progress">
      {steps.map((step, i) => {
        const complete = i < current;
        const isCurrent = i === current;
        const Marker = onStepClick && i <= current ? 'button' : 'div';
        return (
          <li
            key={step.id}
            className={cx('ain-steps__step', complete && 'is-complete', isCurrent && 'is-current')}
            aria-current={isCurrent ? 'step' : undefined}
          >
            {orientation === 'horizontal' && i > 0 && <span className={cx('ain-steps__bar', complete && 'is-done')} aria-hidden />}
            <Marker
              className="ain-steps__marker"
              {...(Marker === 'button' ? { type: 'button' as const, onClick: () => onStepClick?.(i) } : {})}
            >
              {complete ? <Icons.check size={13} /> : i + 1}
            </Marker>
            <span className="ain-steps__text">
              <span className="ain-steps__label">{step.label}</span>
              {step.description && <span className="ain-steps__desc">{step.description}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* =============================== Accordion ================================ */

export interface AccordionItemDef {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  aside?: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface AccordionProps {
  items: AccordionItemDef[];
  /** Ids open on first render. */
  defaultOpen?: string[];
  /** Only one panel at a time. */
  exclusive?: boolean;
  plain?: boolean;
  className?: string;
}

export function Accordion({ items, defaultOpen = [], exclusive, plain, className }: AccordionProps) {
  const [open, setOpen] = useState<string[]>(defaultOpen);
  const toggle = (id: string) => {
    setOpen((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return exclusive ? [id] : [...prev, id];
    });
  };
  return (
    <div className={cx('ain-accordion', plain && 'ain-accordion--plain', className)}>
      {items.map((item) => {
        const isOpen = open.includes(item.id);
        return (
          <div className="ain-accordion__item" key={item.id}>
            <button
              type="button"
              className="ain-accordion__trigger"
              aria-expanded={isOpen}
              aria-controls={`acc-${item.id}`}
              id={`acc-trigger-${item.id}`}
              disabled={item.disabled}
              onClick={() => toggle(item.id)}
            >
              <span className="ain-accordion__chevron"><ChevronRightIcon size={14} /></span>
              {item.icon}
              <span className="ain-accordion__text">
                <span>{item.title}</span>
                {item.description && <span className="ain-accordion__desc">{item.description}</span>}
              </span>
              {item.aside}
            </button>
            {isOpen && (
              <div className="ain-accordion__panel" id={`acc-${item.id}`} role="region" aria-labelledby={`acc-trigger-${item.id}`}>
                {item.content}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export interface CollapsibleProps {
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}

export function Collapsible({ title, defaultOpen = false, children, className }: CollapsibleProps) {
  return <Accordion plain className={className} items={[{ id: 'only', title, content: children }]} defaultOpen={defaultOpen ? ['only'] : []} />;
}

/* =============================== AnchorNav ================================ */

export interface AnchorNavProps {
  /** Section ids in document order; the nav tracks which one is on screen. */
  items: { id: string; label: ReactNode }[];
  title?: ReactNode;
  className?: string;
}

export function AnchorNav({ items, title, className }: AnchorNavProps) {
  const [active, setActive] = useState(items[0]?.id ?? '');
  const ids = items.map((i) => i.id).join(',');

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const elements = items.map((item) => document.getElementById(item.id)).filter((el): el is HTMLElement => !!el);
    if (!elements.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-72px 0px -60% 0px', threshold: 0 },
    );
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [ids]);

  return (
    <nav className={cx('ain-anchornav', className)} aria-label="On this page">
      {title && <div className="ain-anchornav__title">{title}</div>}
      {items.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          className={cx('ain-anchornav__link', active === item.id && 'is-active')}
          aria-current={active === item.id ? 'true' : undefined}
          onClick={(e) => {
            const el = document.getElementById(item.id);
            if (!el) return;
            e.preventDefault();
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setActive(item.id);
          }}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
