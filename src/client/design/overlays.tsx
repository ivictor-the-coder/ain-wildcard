import {
  cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo,
  useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from './layout';
import { Button, IconButton, Kbd } from './controls';
import { AlertTriangleIcon, ArrowRightIcon, ChevronDownIcon, ChevronRightIcon, Icons } from './icons';
import { useClickOutside, useFocusTrap, useIsomorphicLayoutEffect, useScrollLock } from './hooks';
import { computePosition, floatingElement, rectOf, repositionFloating, viewportSize, type Placement } from './position';
import { rankCommands } from './overlays-core';
import './overlays.css';

/* ================================ Portal ================================== */

export function Portal({ children }: { children: ReactNode }) {
  const [host] = useState(() => (typeof document === 'undefined' ? null : document.createElement('div')));
  // Attaching in a layout effect matters: child layout effects run before the
  // parent's, so an overlay that measures itself on open sees a host that is
  // already in the document. Attached in a passive effect, the first — and for
  // a popover the only — measurement reads 0×0 off a detached node.
  useIsomorphicLayoutEffect(() => {
    if (!host) return;
    host.setAttribute('data-ain-portal', '');
    document.body.appendChild(host);
    return () => { host.remove(); };
  }, [host]);
  if (!host) return null;
  return createPortal(children, host);
}

/**
 * Overlays stack in the order they opened, so a menu raised from inside a modal
 * always paints above it without anyone hand-tuning a z-index.
 */
let openLayers = 0;
function useLayer(active: boolean, base = 600): number {
  const [depth, setDepth] = useState(0);
  useEffect(() => {
    if (!active) return;
    openLayers += 1;
    setDepth(openLayers);
    return () => { openLayers = Math.max(0, openLayers - 1); };
  }, [active]);
  return base + depth * 10;
}

/* ================================ Modal =================================== */

export type ModalSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  size?: ModalSize;
  children?: ReactNode;
  footer?: ReactNode;
  /** Push the first footer node to the left — usually a destructive action. */
  footerBetween?: boolean;
  /** Circle icon beside the title for confirmations. */
  icon?: ReactNode;
  iconTone?: 'danger' | 'warning' | 'brand';
  /** `false` blocks Esc and backdrop clicks — use for irreversible steps only. */
  dismissable?: boolean;
  showClose?: boolean;
  flush?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
}

export function Modal({
  open, onClose, title, description, size = 'md', children, footer, footerBetween,
  icon, iconTone = 'brand', dismissable = true, showClose = true, flush, initialFocus, className,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const z = useLayer(open);

  useScrollLock(open);
  useFocusTrap(dialogRef, open, { initialFocus });

  useEffect(() => {
    if (!open || !dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Only the topmost overlay reacts, so Esc peels one layer at a time.
      const portals = document.querySelectorAll('[data-ain-portal]');
      if (portals.length && !portals[portals.length - 1].contains(dialogRef.current)) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, dismissable, onClose]);

  if (!open) return null;

  return (
    <Portal>
      <div
        className="ain-scrim"
        style={{ zIndex: z }}
        onPointerDown={(e) => { if (dismissable && e.target === e.currentTarget) onClose(); }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          aria-describedby={description ? descId : undefined}
          className={cx('ain-modal', `ain-modal--${size}`, className)}
        >
          {(title || showClose) && (
            <div className="ain-modal__header">
              {icon && <div className={cx('ain-modal__icon', `ain-modal__icon--${iconTone}`)}>{icon}</div>}
              <div className="ain-modal__headtext">
                {title && <h2 className="ain-modal__title" id={titleId}>{title}</h2>}
                {description && <p className="ain-modal__desc" id={descId}>{description}</p>}
              </div>
              {showClose && dismissable && (
                <IconButton className="ain-modal__close" label="Close" icon={<Icons.x size={16} />} onClick={onClose} />
              )}
            </div>
          )}
          <div className={cx('ain-modal__body', flush && 'is-flush', !title && !flush && 'has-divider')}>{children}</div>
          {footer && <div className={cx('ain-modal__footer', footerBetween && 'ain-modal__footer--between')}>{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}

/* ============================= ConfirmDialog ============================== */

export interface ConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'brand';
  loading?: boolean;
  /** Require typing this string before the confirm button enables. */
  confirmPhrase?: string;
}

export function ConfirmDialog({
  open, onCancel, onConfirm, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  tone = 'danger', loading, confirmPhrase,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) setTyped(''); }, [open]);
  const ready = !confirmPhrase || typed.trim() === confirmPhrase;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      title={title}
      description={body}
      icon={tone === 'danger' ? <AlertTriangleIcon size={18} /> : <Icons.help size={18} />}
      iconTone={tone === 'danger' ? 'danger' : 'brand'}
      initialFocus={confirmPhrase ? undefined : confirmRef}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>{cancelLabel}</Button>
          <Button
            ref={confirmRef}
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={loading}
            disabled={!ready}
            onClick={() => { void onConfirm(); }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {confirmPhrase && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            Type <strong style={{ fontFamily: 'var(--font-mono)' }}>{confirmPhrase}</strong> to continue.
          </span>
          <input
            className="ain-input__field"
            value={typed}
            autoFocus
            onChange={(e) => setTyped(e.target.value)}
            style={{
              height: 'var(--control-height)', padding: '0 var(--space-4)',
              border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
              background: 'var(--bg-surface)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)',
            }}
          />
        </label>
      )}
    </Modal>
  );
}

/* ================================ Drawer ================================== */

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side?: 'right' | 'bottom';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  children?: ReactNode;
  className?: string;
}

export function Drawer({
  open, onClose, side = 'right', size = 'md', title, description, actions, footer, flush, children, className,
}: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const z = useLayer(open);
  useScrollLock(open);
  useFocusTrap(ref, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <Portal>
      <div
        className="ain-scrim ain-scrim--drawer"
        style={{ zIndex: z }}
        onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          className={cx('ain-drawer', `ain-drawer--${side}`, side === 'right' && `is-${size}`, className)}
        >
          {side === 'bottom' && <div className="ain-drawer__grip" aria-hidden />}
          {(title || actions) && (
            <div className="ain-drawer__header">
              <div className="ain-modal__headtext">
                {title && <h2 className="ain-modal__title" id={titleId}>{title}</h2>}
                {description && <p className="ain-modal__desc">{description}</p>}
              </div>
              {actions}
              <IconButton label="Close" icon={<Icons.x size={16} />} onClick={onClose} />
            </div>
          )}
          <div className={cx('ain-drawer__body', flush && 'is-flush')}>{children}</div>
          {footer && <div className="ain-drawer__footer">{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}

/* =============================== Popover ================================== */

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  placement?: Placement;
  offset?: number;
  matchWidth?: boolean;
  title?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  /** Keep focus where it is — for hover cards and inline pickers. */
  autoFocus?: boolean;
  role?: 'dialog' | 'menu' | 'listbox' | 'none';
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  id?: string;
}

export function Popover({
  open, onClose, anchor, placement = 'bottom-start', offset = 6, matchWidth,
  title, footer, flush, autoFocus = true, role = 'dialog', ariaLabel, className, style, children, id,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; maxHeight: number; width?: number } | null>(null);
  const z = useLayer(open, 700);

  useClickOutside([ref, anchor], onClose, open);
  useFocusTrap(ref, open && autoFocus, { autoFocus, restoreFocus: true });

  const reposition = useCallback(() => {
    const anchorEl = anchor.current;
    const el = ref.current;
    if (!anchorEl || !el) return;
    // `repositionFloating` strips the clamp before it measures. Reading
    // `offsetHeight` with the previous pass's `max-height` still applied is what
    // used to keep a 286px filter editor pinned under a chip near the bottom
    // edge: clamped it measures 120px, 120px fits, so it never flipped up.
    const result = repositionFloating(floatingElement(el), rectOf(anchorEl), viewportSize(), { placement, offset, matchWidth });
    if (!result) return;
    setPos((prev) => (
      prev && prev.x === result.x && prev.y === result.y && prev.maxHeight === result.maxHeight && prev.width === result.width
        ? prev
        : { x: result.x, y: result.y, maxHeight: result.maxHeight, width: result.width }
    ));
  }, [anchor, placement, offset, matchWidth]);

  useLayoutEffect(() => { if (open) reposition(); }, [open, reposition, children]);

  useEffect(() => {
    if (!open) return;
    const handler = () => reposition();
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [open, reposition]);

  // Content that grows after opening — switching the date operator from "is on"
  // to "is between" adds the presets and a calendar — has to re-choose the side,
  // otherwise the box grows downwards off the bottom of the screen.
  useEffect(() => {
    const el = ref.current;
    if (!open || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => reposition());
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <Portal>
      <div
        ref={ref}
        id={id}
        role={role === 'none' ? undefined : role}
        aria-label={ariaLabel}
        className={cx('ain-popover', className)}
        style={{
          left: pos?.x ?? -9999, top: pos?.y ?? -9999, zIndex: z,
          maxHeight: pos?.maxHeight, width: pos?.width,
          visibility: pos ? 'visible' : 'hidden',
          ...style,
        }}
      >
        {title && <div className="ain-popover__header"><span className="ain-popover__title">{title}</span></div>}
        <div className={cx('ain-popover__body', flush && 'is-flush')}>{children}</div>
        {footer && <div className="ain-popover__footer">{footer}</div>}
      </div>
    </Portal>
  );
}

/* ================================= Menu =================================== */

export interface MenuItemDef {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Renders a tick and `role="menuitemcheckbox"`. */
  checked?: boolean;
  /** Nested items open to the side on hover, Enter or ArrowRight. */
  items?: MenuItemDef[];
  /** Plain-text label used for typeahead when `label` is a node. */
  searchText?: string;
}

export interface MenuSection {
  id: string;
  label?: string;
  items: MenuItemDef[];
}

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  sections: MenuSection[];
  placement?: Placement;
  ariaLabel: string;
  matchWidth?: boolean;
  className?: string;
}

const flatten = (sections: MenuSection[]): MenuItemDef[] => sections.flatMap((s) => s.items);
const textOf = (item: MenuItemDef): string => item.searchText ?? (typeof item.label === 'string' ? item.label : '');

export function Menu({ open, onClose, anchor, sections, placement = 'bottom-start', ariaLabel, matchWidth, className }: MenuProps) {
  const items = useMemo(() => flatten(sections).filter((i) => !i.disabled), [sections]);
  const [active, setActive] = useState(0);
  const [submenu, setSubmenu] = useState<string | null>(null);
  const submenuAnchor = useRef<HTMLDivElement>(null);
  const typed = useRef({ query: '', at: 0 });

  useEffect(() => { if (open) { setActive(0); setSubmenu(null); } }, [open]);

  const select = useCallback((item: MenuItemDef) => {
    if (item.disabled) return;
    if (item.items?.length) { setSubmenu(item.id); return; }
    item.onSelect?.();
    onClose();
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + items.length) % items.length); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(items.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const item = items[active]; if (item) select(item); }
    else if (e.key === 'ArrowRight') { const item = items[active]; if (item?.items?.length) { e.preventDefault(); setSubmenu(item.id); } }
    else if (e.key === 'ArrowLeft') { if (submenu) { e.preventDefault(); setSubmenu(null); } }
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      const now = Date.now();
      typed.current = { query: now - typed.current.at < 800 ? typed.current.query + e.key : e.key, at: now };
      const match = items.findIndex((i) => textOf(i).toLowerCase().startsWith(typed.current.query.toLowerCase()));
      if (match >= 0) setActive(match);
    }
  };

  const openSubmenuItem = submenu ? flatten(sections).find((i) => i.id === submenu) : null;

  return (
    <>
      <Popover
        open={open}
        onClose={onClose}
        anchor={anchor}
        placement={placement}
        matchWidth={matchWidth}
        role="none"
        flush
        className={cx('ain-menu-pop', className)}
        autoFocus
      >
        <div className="ain-menu" role="menu" aria-label={ariaLabel} tabIndex={-1} onKeyDown={onKeyDown}>
          {sections.map((section) => (
            <div className="ain-menu__section" key={section.id} role="group" aria-label={section.label}>
              {section.label && <div className="ain-menu__label">{section.label}</div>}
              {section.items.map((item) => {
                const index = items.indexOf(item);
                return (
                  <div
                    key={item.id}
                    ref={item.id === submenu ? submenuAnchor : undefined}
                    role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                    aria-checked={item.checked}
                    aria-disabled={item.disabled || undefined}
                    aria-haspopup={item.items?.length ? 'menu' : undefined}
                    aria-expanded={item.items?.length ? item.id === submenu : undefined}
                    tabIndex={-1}
                    className={cx('ain-menu__item', index === active && index >= 0 && 'is-active', item.danger && 'is-danger')}
                    onPointerEnter={() => { if (index >= 0) setActive(index); if (!item.items?.length) setSubmenu(null); }}
                    onClick={() => select(item)}
                  >
                    {(item.icon || item.checked !== undefined) && (
                      <span className="ain-menu__icon">
                        {item.checked !== undefined
                          ? (item.checked ? <Icons.check size={14} className="ain-menu__check" /> : null)
                          : item.icon}
                      </span>
                    )}
                    <span className="ain-menu__text">
                      <span className="u-truncate">{item.label}</span>
                      {item.description && <span className="ain-menu__desc">{item.description}</span>}
                    </span>
                    {item.shortcut && <span className="ain-menu__shortcut"><Kbd combo={item.shortcut} /></span>}
                    {item.items?.length ? <ChevronRightIcon size={14} className="ain-menu__shortcut" /> : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </Popover>
      {openSubmenuItem?.items && (
        <Menu
          open
          onClose={() => { setSubmenu(null); onClose(); }}
          anchor={submenuAnchor}
          placement="right-start"
          ariaLabel={typeof openSubmenuItem.label === 'string' ? openSubmenuItem.label : 'Submenu'}
          sections={[{ id: 'sub', items: openSubmenuItem.items }]}
        />
      )}
    </>
  );
}

export interface MenuButtonProps {
  sections: MenuSection[];
  label: string;
  /** Icon-only trigger when no children are given. */
  icon?: ReactNode;
  children?: ReactNode;
  placement?: Placement;
  variant?: 'ghost' | 'secondary' | 'primary';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** Trigger + menu in one, for the row-actions "…" case that appears everywhere. */
export function MenuButton({
  sections, label, icon, children, placement = 'bottom-end', variant = 'ghost', size = 'md', className,
}: MenuButtonProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      {children ? (
        <Button
          ref={anchor}
          variant={variant}
          size={size}
          className={className}
          aria-haspopup="menu"
          aria-expanded={open}
          iconRight={<ChevronDownIcon size={14} />}
          iconLeft={icon}
          onClick={() => setOpen((v) => !v)}
        >
          {children}
        </Button>
      ) : (
        <IconButton
          ref={anchor}
          label={label}
          variant={variant}
          size={size}
          className={className}
          aria-haspopup="menu"
          aria-expanded={open}
          icon={icon ?? <Icons.more size={16} />}
          onClick={() => setOpen((v) => !v)}
        />
      )}
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} sections={sections} placement={placement} ariaLabel={label} />
    </>
  );
}

/* ================================ Tooltip ================================= */

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  placement?: Placement;
  /** Hover dwell before showing. Keyboard focus shows immediately. */
  delay?: number;
  shortcut?: string;
  disabled?: boolean;
}

export function Tooltip({ content, children, placement = 'top', delay = 400, shortcut, disabled }: TooltipProps) {
  const anchor = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const id = useId();

  const show = (immediate = false) => {
    if (disabled) return;
    clearTimeout(timer.current);
    if (immediate) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => { clearTimeout(timer.current); setOpen(false); };

  useEffect(() => () => clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return;
    const size = { width: tip.current.offsetWidth, height: tip.current.offsetHeight };
    // A 0×0 box fits on every side, so it would place "above" and stay there.
    if (size.width === 0 && size.height === 0) return;
    const result = computePosition(rectOf(anchor.current), size, viewportSize(), { placement, offset: 8 });
    setPos({ x: result.x, y: result.y });
  }, [open, placement, content]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!isValidElement(children)) return children;

  const child = cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: (node: HTMLElement | null) => {
      anchor.current = node;
      const original = (children as unknown as { ref?: unknown }).ref;
      if (typeof original === 'function') (original as (n: HTMLElement | null) => void)(node);
      else if (original && typeof original === 'object') (original as { current: HTMLElement | null }).current = node;
    },
    'aria-describedby': open ? id : undefined,
    onPointerEnter: () => show(),
    onPointerLeave: hide,
    onFocus: () => show(true),
    onBlur: hide,
  } as Record<string, unknown>);

  return (
    <>
      {child}
      {open && !disabled && (
        <Portal>
          <div
            ref={tip}
            id={id}
            role="tooltip"
            className="ain-tooltip"
            style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
          >
            {content}
            {shortcut && <span className="ain-tooltip__shortcut"><Kbd combo={shortcut} /></span>}
          </div>
        </Portal>
      )}
    </>
  );
}

/* ============================== CommandList =============================== */

export interface CommandEntry {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  icon?: ReactNode;
  shortcut?: string;
  keywords?: string[];
  onSelect: () => void;
}

export interface CommandListProps {
  entries: CommandEntry[];
  placeholder?: string;
  /** Controlled query; omit to let the component own it. */
  query?: string;
  onQueryChange?: (value: string) => void;
  emptyState?: ReactNode;
  footer?: ReactNode;
  onDismiss?: () => void;
  autoFocus?: boolean;
  className?: string;
}

export const filterCommands = (entries: CommandEntry[], query: string): CommandEntry[] => rankCommands(entries, query);

export function CommandList({
  entries, placeholder = 'Search actions, records and settings…', query: controlledQuery, onQueryChange,
  emptyState, footer, onDismiss, autoFocus = true, className,
}: CommandListProps) {
  const [internalQuery, setInternalQuery] = useState('');
  const query = controlledQuery ?? internalQuery;
  const setQuery = onQueryChange ?? setInternalQuery;
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => filterCommands(entries, query), [entries, query]);
  useEffect(() => { setActive(0); }, [query]);

  const grouped = useMemo(() => {
    const map = new Map<string, CommandEntry[]>();
    for (const entry of results) {
      const arr = map.get(entry.group) ?? [];
      arr.push(entry);
      map.set(entry.group, arr);
    }
    return [...map.entries()];
  }, [results]);

  useEffect(() => {
    const container = listRef.current;
    const el = container?.querySelector<HTMLElement>('[data-active="true"]');
    if (!container || !el) return;
    // Scroll the list itself rather than calling scrollIntoView, which would
    // also drag the page behind the palette.
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < container.scrollTop) container.scrollTop = Math.max(0, top - 8);
    else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight + 8;
  }, [active]);

  const run = (entry: CommandEntry) => { entry.onSelect(); onDismiss?.(); };

  return (
    <div className={cx('ain-cmd', className)}>
      <div className="ain-cmd__search">
        <Icons.search size={18} style={{ color: 'var(--text-tertiary)' }} />
        <input
          className="ain-cmd__input"
          value={query}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label="Search commands"
          role="combobox"
          aria-expanded
          aria-controls="ain-cmd-list"
          aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); const entry = results[active]; if (entry) run(entry); }
            else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
            else if (e.key === 'End') { e.preventDefault(); setActive(results.length - 1); }
          }}
        />
        {query && <IconButton size="sm" label="Clear search" icon={<Icons.x size={14} />} onClick={() => setQuery('')} />}
      </div>
      <div className="ain-cmd__list" id="ain-cmd-list" role="listbox" aria-label="Commands" ref={listRef}>
        {results.length === 0 && (
          emptyState ?? <div className="ain-cmd__empty">Nothing matches “{query}”. Try a record name, an action, or a setting.</div>
        )}
        {grouped.map(([group, groupEntries]) => (
          <div className="ain-cmd__group" key={group}>
            <div className="ain-cmd__grouplabel">{group}</div>
            {groupEntries.map((entry) => {
              const index = results.indexOf(entry);
              return (
                <div
                  key={entry.id}
                  id={`cmd-${entry.id}`}
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active}
                  className={cx('ain-cmd__item', index === active && 'is-active')}
                  onPointerEnter={() => setActive(index)}
                  onClick={() => run(entry)}
                >
                  <span className="ain-cmd__icon">{entry.icon ?? <ArrowRightIcon size={14} />}</span>
                  <span className="ain-cmd__text">
                    <div className="ain-cmd__title u-truncate">{entry.title}</div>
                    {entry.subtitle && <div className="ain-cmd__sub u-truncate">{entry.subtitle}</div>}
                  </span>
                  {entry.shortcut && <Kbd combo={entry.shortcut} />}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {footer ?? (
        <div className="ain-cmd__footer">
          <span className="ain-cmd__hint"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span className="ain-cmd__hint"><Kbd>↵</Kbd> select</span>
          <span className="ain-cmd__hint"><Kbd combo="esc" /> close</span>
          <span style={{ marginInlineStart: 'auto' }}>{results.length} of {entries.length}</span>
        </div>
      )}
    </div>
  );
}
