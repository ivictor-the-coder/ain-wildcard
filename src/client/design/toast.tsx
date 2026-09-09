import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { cx } from './layout';
import { Icons } from './icons';
import { Button, IconButton } from './controls';
import { Spinner } from './feedback';
import {
  dismissToast, getToasts, mountToastViewport, setToastAutoMount, setToastsPaused,
  subscribeToasts, subscribeToastViewport, toastViewportOwner,
  type ToastRecord, type ToastTone,
} from './toast-store';
import './toast.css';

const ICONS: Record<ToastTone, keyof typeof Icons> = {
  default: 'info', success: 'check-circle', warning: 'alert-triangle',
  danger: 'alert-octagon', info: 'info', loading: 'refresh',
};

/**
 * The key that puts focus in the stack. Sonner uses F8, Windows narrators use
 * F6 to rotate landmarks; both are free in every browser we support, so both
 * work and the label advertises the one people already know.
 */
export const TOAST_FOCUS_KEYS = ['F6', 'F8'] as const;

function ToastCard({ toast }: { toast: ToastRecord }) {
  const Icon = Icons[ICONS[toast.tone]];
  const titleId = useId();
  const descId = useId();
  return (
    <div
      className={cx('ain-toast', `ain-toast--${toast.tone}`)}
      role={toast.tone === 'danger' ? 'alert' : 'status'}
      aria-live={toast.tone === 'danger' ? 'assertive' : 'polite'}
      // Focusable so the hotkey has somewhere to land on a toast with no action,
      // and so the message itself is read when focus arrives.
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={toast.description ? descId : undefined}
    >
      <span className="ain-toast__icon">
        {toast.tone === 'loading' ? <Spinner size={16} /> : <Icon size={16} />}
      </span>
      <div className="ain-toast__content">
        <div className="ain-toast__title" id={titleId}>{toast.title}</div>
        {toast.description && <div className="ain-toast__desc" id={descId}>{toast.description}</div>}
        {toast.action && (
          <Button
            className="ain-toast__action"
            variant="link"
            size="sm"
            // The button's own label is a verb — "Undo", "Download". The
            // description carries what it will act on.
            aria-describedby={toast.description ? `${titleId} ${descId}` : titleId}
            onClick={() => { toast.action?.onClick(); dismissToast(toast.id); }}
          >
            {toast.action.label}
          </Button>
        )}
      </div>
      <IconButton
        className="ain-toast__close"
        size="sm"
        label="Dismiss notification"
        icon={<Icons.x size={13} />}
        onClick={() => dismissToast(toast.id)}
      />
    </div>
  );
}

/** The viewport. Mount it once — <ToastProvider> does that for you. */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const ref = useRef<HTMLDivElement>(null);
  /** Where focus was when the hotkey pulled it into the stack. */
  const returnTo = useRef<HTMLElement | null>(null);
  const hovering = useRef(false);
  const focused = useRef(false);
  const [token] = useState(() => Symbol('ain-toaster'));
  const owner = useSyncExternalStore(subscribeToastViewport, toastViewportOwner, () => null);

  useEffect(() => mountToastViewport(token), [token]);
  // Never leave the queue frozen behind an unmounting viewport.
  useEffect(() => () => setToastsPaused(false), []);

  const syncPaused = useCallback(() => setToastsPaused(hovering.current || focused.current), []);

  const restore = useCallback(() => {
    const back = returnTo.current;
    returnTo.current = null;
    if (back?.isConnected) back.focus();
    else (document.activeElement as HTMLElement | null)?.blur?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!TOAST_FOCUS_KEYS.includes(e.key as typeof TOAST_FOCUS_KEYS[number])) return;
      if (e.metaKey || e.altKey) return;
      const root = ref.current;
      if (!root) return;
      if (root.contains(document.activeElement)) { e.preventDefault(); restore(); return; }
      const cards = root.querySelectorAll<HTMLElement>('.ain-toast');
      // Column-reverse stacking puts the newest toast last in the DOM and top of
      // the pile; that is the one the operator just triggered.
      const newest = cards[cards.length - 1];
      if (!newest) return;
      e.preventDefault();
      returnTo.current = document.activeElement as HTMLElement | null;
      (newest.querySelector<HTMLElement>('.ain-toast__action') ?? newest).focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [restore]);

  // A toast that dismisses while it holds focus — the action fired, or the timer
  // ran out during a hover — would otherwise drop focus on <body>.
  useEffect(() => {
    if (!returnTo.current) return;
    const root = ref.current;
    if (root?.contains(document.activeElement)) return;
    const active = document.activeElement;
    if (!active || active === document.body) restore();
  }, [toasts, restore]);

  // Everything above this line runs in every mounted viewport so the hooks stay
  // unconditional; only the owner paints.
  if (typeof document === 'undefined' || owner !== token) return null;
  return createPortal(
    <div
      className="ain-toaster"
      ref={ref}
      role="region"
      // The hotkey is in the name because a control nobody can find is the same
      // as no control: 59 Tab stops is not a route to a four-second button.
      aria-label={`Notifications (${TOAST_FOCUS_KEYS[0]})`}
      tabIndex={-1}
      onPointerEnter={() => { hovering.current = true; syncPaused(); }}
      onPointerLeave={() => { hovering.current = false; syncPaused(); }}
      onFocus={() => { focused.current = true; syncPaused(); }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        focused.current = false;
        syncPaused();
        // Focus left under its own steam (Tab, a click elsewhere): there is
        // nothing to hand back any more.
        if (e.relatedTarget) returnTo.current = null;
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        restore();
      }}
    >
      {toasts.map((toast) => <ToastCard key={toast.id} toast={toast} />)}
    </div>,
    document.body,
  );
}

export function ToastProvider({ children }: { children?: React.ReactNode }) {
  return <>{children}<Toaster /></>;
}

/**
 * If something raises a toast before any viewport is mounted, mount one. It
 * keeps `useToast()` honest in modules that forgot the provider.
 */
if (typeof document !== 'undefined') {
  let mounted = false;
  setToastAutoMount(() => {
    if (mounted) return;
    mounted = true;
    const host = document.createElement('div');
    host.setAttribute('data-ain-toaster', '');
    document.body.appendChild(host);
    createRoot(host).render(<Toaster />);
  });
}

export { pushToast, dismissToast, clearToasts } from './toast-store';
