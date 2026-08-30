/**
 * The behaviour half of the design system. Everything here is DOM-only — no
 * component imports — so any module can pull a single hook without dragging
 * stylesheets along.
 */
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  useSyncExternalStore, type DependencyList, type RefObject,
} from 'react';
import {
  clearToasts, dismissToast, getToasts, pushToast, subscribeToasts,
  type ToastOptions, type ToastRecord, type ToastTone,
} from './toast-store';

export const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/* ------------------------------- disclosure ------------------------------ */

export interface Disclosure {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setOpen: (v: boolean) => void;
  /** Spread onto the trigger for correct `aria-expanded`/`aria-controls`. */
  triggerProps: { 'aria-expanded': boolean; 'aria-controls': string };
  contentId: string;
}

export function useDisclosure(initial = false): Disclosure {
  const [isOpen, setOpen] = useState(initial);
  const contentId = useId();
  return useMemo(() => ({
    isOpen,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen((v) => !v),
    setOpen,
    triggerProps: { 'aria-expanded': isOpen, 'aria-controls': contentId },
    contentId,
  }), [isOpen, contentId]);
}

/* ------------------------------ controllable ----------------------------- */

/** Lets a component be used controlled or uncontrolled with one code path. */
export function useControllableState<T>(
  controlled: T | undefined,
  defaultValue: T,
  onChange?: (value: T) => void,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [internal, setInternal] = useState(defaultValue);
  const isControlled = controlled !== undefined;
  const value = isControlled ? (controlled as T) : internal;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const set = useCallback((next: T | ((prev: T) => T)) => {
    setInternal((prev) => {
      const base = isControlled ? (controlled as T) : prev;
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(base) : next;
      if (!Object.is(resolved, base)) onChangeRef.current?.(resolved);
      return isControlled ? prev : resolved;
    });
  }, [isControlled, controlled]);

  return [value, set];
}

/* ------------------------------ media queries ---------------------------- */

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((cb: () => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const mq = window.matchMedia(query);
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  }, [query]);
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

export const useIsNarrow = () => useMediaQuery('(max-width: 900px)');

/**
 * The workspace density, read from the `data-density` attribute the shell puts
 * on <html>. Components pick it up without importing the session, so the design
 * system stays free of app dependencies.
 */
export function useDocumentDensity(): 'comfortable' | 'compact' {
  const subscribe = useCallback((cb: () => void) => {
    if (typeof document === 'undefined') return () => {};
    const observer = new MutationObserver(cb);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-density'] });
    return () => observer.disconnect();
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => (typeof document !== 'undefined' && document.documentElement.getAttribute('data-density') === 'compact' ? 'compact' : 'comfortable'),
    () => 'comfortable' as const,
  );
}
export const usePrefersReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');

/* -------------------------------- hotkeys -------------------------------- */

const isTypingTarget = (el: EventTarget | null): boolean => {
  const node = el as HTMLElement | null;
  if (!node || !node.tagName) return false;
  const tag = node.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable;
};

/** `mod` is ⌘ on Apple platforms and Ctrl elsewhere. */
export function matchesHotkey(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts[parts.length - 1];
  const want = { mod: false, ctrl: false, meta: false, shift: false, alt: false };
  for (const p of parts.slice(0, -1)) {
    if (p === 'mod' || p === 'cmd' || p === 'command') want.mod = true;
    else if (p === 'ctrl' || p === 'control') want.ctrl = true;
    else if (p === 'meta') want.meta = true;
    else if (p === 'shift') want.shift = true;
    else if (p === 'alt' || p === 'option') want.alt = true;
  }
  const apple = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  const modPressed = apple ? e.metaKey : e.ctrlKey;
  if (want.mod && !modPressed) return false;
  if (!want.mod && !want.ctrl && !want.meta && (e.metaKey || e.ctrlKey)) return false;
  if (want.ctrl && !e.ctrlKey) return false;
  if (want.meta && !e.metaKey) return false;
  if (want.shift !== e.shiftKey && key.length === 1) return false;
  if (want.alt !== e.altKey) return false;
  const pressed = e.key.toLowerCase();
  return pressed === key || (key === 'esc' && pressed === 'escape') || (key === 'space' && pressed === ' ');
}

export interface HotkeyOptions {
  enabled?: boolean;
  /** Fire even when focus is in a text field (Escape and ⌘K usually should). */
  allowInInput?: boolean;
  preventDefault?: boolean;
  target?: RefObject<HTMLElement | null> | 'window';
}

export function useHotkey(
  combo: string | string[],
  handler: (e: KeyboardEvent) => void,
  opts: HotkeyOptions = {},
): void {
  const { enabled = true, allowInInput = false, preventDefault = true, target = 'window' } = opts;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const combos = useMemo(() => (Array.isArray(combo) ? combo : [combo]), [Array.isArray(combo) ? combo.join('|') : combo]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const node: EventTarget | null = target === 'window' ? window : target.current;
    if (!node) return;
    const onKeyDown = (event: Event) => {
      const e = event as KeyboardEvent;
      if (!allowInInput && isTypingTarget(e.target)) return;
      if (!combos.some((c) => matchesHotkey(e, c))) return;
      if (preventDefault) e.preventDefault();
      handlerRef.current(e);
    };
    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, [combos, enabled, allowInInput, preventDefault, target]);
}

/* ----------------------------- click outside ----------------------------- */

export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null> | RefObject<T | null>[],
  handler: (e: PointerEvent) => void,
  enabled = true,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const refsRef = useRef<RefObject<T | null>[]>([]);
  refsRef.current = Array.isArray(ref) ? ref : [ref];

  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || !document.contains(target)) return;
      for (const r of refsRef.current) if (r.current?.contains(target)) return;
      handlerRef.current(e);
    };
    // `pointerdown` on the document beats React's synthetic click ordering.
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [enabled]);
}

/* ------------------------------- focus trap ------------------------------ */

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);
}

export interface FocusTrapOptions {
  /** Focus this instead of the first focusable child when the trap activates. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Return focus to whatever was focused before the trap opened. */
  restoreFocus?: boolean;
  autoFocus?: boolean;
}

export function useFocusTrap<T extends HTMLElement>(
  ref: RefObject<T | null>,
  active: boolean,
  opts: FocusTrapOptions = {},
): void {
  const { initialFocus, restoreFocus = true, autoFocus = true } = opts;
  const previous = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    previous.current = document.activeElement as HTMLElement | null;

    let frame = 0;
    if (autoFocus) {
      const target = initialFocus?.current ?? focusableWithin(root)[0] ?? root;
      // A frame of delay lets the open animation start before focus jumps.
      frame = requestAnimationFrame(() => {
        if (!target.hasAttribute('tabindex') && focusableWithin(root).length === 0) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      });
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusableWithin(root);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (activeEl === first || !root.contains(activeEl))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (activeEl === last || !root.contains(activeEl))) {
        e.preventDefault(); first.focus();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => {
      root.removeEventListener('keydown', onKeyDown);
      if (frame) cancelAnimationFrame(frame);
      if (restoreFocus) previous.current?.focus?.({ preventScroll: true });
    };
  }, [active, ref, initialFocus, restoreFocus, autoFocus]);
}

/** Locks background scroll while overlays are open; safe to nest. */
let scrollLocks = 0;
let priorOverflow = '';
let priorPaddingRight = '';

export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    if (scrollLocks === 0) {
      const gutter = window.innerWidth - document.documentElement.clientWidth;
      priorOverflow = document.body.style.overflow;
      priorPaddingRight = document.body.style.paddingRight;
      document.body.style.overflow = 'hidden';
      if (gutter > 0) document.body.style.paddingRight = `${gutter}px`;
    }
    scrollLocks++;
    return () => {
      scrollLocks--;
      if (scrollLocks === 0) {
        document.body.style.overflow = priorOverflow;
        document.body.style.paddingRight = priorPaddingRight;
      }
    };
  }, [active]);
}

/* ---------------------------- resize observer ---------------------------- */

export interface ElementSize { width: number; height: number }

export function useResizeObserver<T extends HTMLElement>(ref: RefObject<T | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number, h: number) => setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    apply(el.clientWidth, el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.contentRect;
        apply(Math.round(box.width), Math.round(box.height));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/* ---------------------------- row virtualisation ------------------------- */

export interface VirtualRowsOptions {
  count: number;
  rowHeight: number;
  overscan?: number;
  /** Below this many rows the list renders in full — virtualising is a cost. */
  threshold?: number;
}

export interface VirtualWindow {
  startIndex: number;
  endIndex: number;
  paddingTop: number;
  paddingBottom: number;
  totalHeight: number;
  virtualised: boolean;
  scrollToIndex: (index: number, align?: 'start' | 'center' | 'nearest') => void;
}

export function computeWindow(
  scrollTop: number, viewportHeight: number, count: number, rowHeight: number, overscan: number,
): { startIndex: number; endIndex: number } {
  const visible = Math.ceil(viewportHeight / rowHeight) + 1;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(count, startIndex + visible + overscan * 2);
  return { startIndex, endIndex };
}

/** Windows a long list inside a scroll container without measuring each row. */
export function useVirtualRows<T extends HTMLElement>(
  scrollRef: RefObject<T | null>,
  { count, rowHeight, overscan = 6, threshold = 80 }: VirtualRowsOptions,
): VirtualWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const virtualised = count > threshold;

  useIsomorphicLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !virtualised) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setScrollTop(el.scrollTop);
      setViewportHeight(el.clientHeight);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read); };
    read();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef, virtualised, rowHeight, count]);

  const scrollToIndex = useCallback((index: number, align: 'start' | 'center' | 'nearest' = 'nearest') => {
    const el = scrollRef.current;
    if (!el) return;
    const top = index * rowHeight;
    const bottom = top + rowHeight;
    if (align === 'start') el.scrollTop = top;
    else if (align === 'center') el.scrollTop = top - el.clientHeight / 2 + rowHeight / 2;
    else if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [scrollRef, rowHeight]);

  return useMemo(() => {
    if (!virtualised) {
      return {
        startIndex: 0, endIndex: count, paddingTop: 0, paddingBottom: 0,
        totalHeight: count * rowHeight, virtualised: false, scrollToIndex,
      };
    }
    const { startIndex, endIndex } = computeWindow(scrollTop, viewportHeight || 600, count, rowHeight, overscan);
    return {
      startIndex, endIndex,
      paddingTop: startIndex * rowHeight,
      paddingBottom: Math.max(0, (count - endIndex) * rowHeight),
      totalHeight: count * rowHeight,
      virtualised: true,
      scrollToIndex,
    };
  }, [virtualised, scrollTop, viewportHeight, count, rowHeight, overscan, scrollToIndex]);
}

/* --------------------------------- toasts -------------------------------- */

export interface ToastApi {
  toasts: ToastRecord[];
  show: (opts: ToastOptions) => string;
  success: (title: string, description?: string, extra?: Partial<ToastOptions>) => string;
  error: (title: string, description?: string, extra?: Partial<ToastOptions>) => string;
  warning: (title: string, description?: string, extra?: Partial<ToastOptions>) => string;
  info: (title: string, description?: string, extra?: Partial<ToastOptions>) => string;
  loading: (title: string, description?: string, extra?: Partial<ToastOptions>) => string;
  /** Runs a promise and swaps a loading toast for the outcome in place. */
  promise: <T>(work: Promise<T>, copy: { loading: string; success: string | ((v: T) => string); error: string | ((e: unknown) => string) }) => Promise<T>;
  dismiss: (id: string) => void;
  clear: () => void;
}

const tone = (t: ToastTone) => (title: string, description?: string, extra?: Partial<ToastOptions>) =>
  pushToast({ title, description, tone: t, ...extra });

export function useToast(): ToastApi {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return useMemo(() => ({
    toasts,
    show: pushToast,
    success: tone('success'),
    error: tone('danger'),
    warning: tone('warning'),
    info: tone('info'),
    loading: tone('loading'),
    async promise(work, copy) {
      const id = pushToast({ title: copy.loading, tone: 'loading' });
      try {
        const value = await work;
        pushToast({ id, title: typeof copy.success === 'function' ? copy.success(value) : copy.success, tone: 'success' });
        return value;
      } catch (e) {
        pushToast({ id, title: typeof copy.error === 'function' ? copy.error(e) : copy.error, tone: 'danger' });
        throw e;
      }
    },
    dismiss: dismissToast,
    clear: clearToasts,
  }), [toasts]);
}

/* ------------------------------ small utilities -------------------------- */

export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => { ref.current = value; }, [value]);
  return ref.current;
}

export function useDebouncedValue<T>(value: T, delay = 220): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delay = 220, deps: DependencyList = []) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return useCallback((...args: A) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => fnRef.current(...args), delay);
  }, [delay, ...deps]);
}

/** Copies text and reports success for ~1.6s so buttons can show a tick. */
export function useCopyToClipboard(resetMs = 1600): [boolean, (text: string) => Promise<boolean>] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), resetMs);
    return () => clearTimeout(t);
  }, [copied, resetMs]);

  const copy = useCallback(async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const el = document.createElement('textarea');
        el.value = text;
        el.setAttribute('readonly', '');
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      setCopied(true);
      return true;
    } catch {
      setCopied(false);
      return false;
    }
  }, []);

  return [copied, copy];
}

export function useLocalStorage<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : initial; } catch { return initial; }
  });
  const set = useCallback((next: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      try { localStorage.setItem(key, JSON.stringify(resolved)); } catch { /* private mode */ }
      return resolved;
    });
  }, [key]);
  return [value, set];
}

/** Roving tabindex for menus, listboxes and toolbars. */
export function useRovingIndex(length: number, initial = 0) {
  const [index, setIndex] = useState(initial);
  useEffect(() => { if (index > length - 1) setIndex(Math.max(0, length - 1)); }, [length, index]);
  const move = useCallback((delta: number, wrap = true) => {
    setIndex((i) => {
      const next = i + delta;
      if (next < 0) return wrap ? length - 1 : 0;
      if (next > length - 1) return wrap ? 0 : length - 1;
      return next;
    });
  }, [length]);
  return { index, setIndex, move, first: () => setIndex(0), last: () => setIndex(Math.max(0, length - 1)) };
}

export { type ToastRecord, type ToastOptions, type ToastTone } from './toast-store';
