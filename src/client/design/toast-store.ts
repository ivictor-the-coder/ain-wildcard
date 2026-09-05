/**
 * The toast queue lives outside React so anything — a mutation callback, an
 * error boundary, a keyboard shortcut — can raise one without prop drilling.
 */
export type ToastTone = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'loading';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** ms on screen; `0` pins it until dismissed. Loading toasts default to pinned. */
  duration?: number;
  action?: ToastAction;
  /** Reuse an id to replace a toast in place, e.g. loading → success. */
  id?: string;
}

export interface ToastRecord extends ToastOptions {
  id: string;
  tone: ToastTone;
  createdAt: number;
}

const DEFAULT_DURATION: Record<ToastTone, number> = {
  default: 4500, success: 4000, info: 5000, warning: 7000, danger: 9000, loading: 0,
};

/**
 * A toast carrying an action is asking for a decision, so it gets the time to
 * make one — reaching Undo with the keyboard costs a hotkey and a glance, and
 * four seconds is not enough for either.
 */
const ACTION_DURATION = 12_000;

export const TOAST_LIMIT = 4;

let seq = 0;
let toasts: ToastRecord[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let autoMount: (() => void) | null = null;
let paused = false;

/**
 * Mounted viewports, in mount order. The first one paints; the rest stand by.
 *
 * The shell mounts a <Toaster/> and a page that wraps itself in <ToastProvider>
 * mounts another, which rendered every notification twice — two copies in the
 * accessibility tree, two identical cards on screen, and a focus hotkey that
 * bounced between them. One queue deserves one viewport.
 */
const viewports: symbol[] = [];
const viewportListeners = new Set<() => void>();
const emitViewports = () => { for (const l of [...viewportListeners]) l(); };

const emit = () => { for (const l of [...listeners]) l(); };

export function subscribeToasts(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const getToasts = (): ToastRecord[] => toasts;

/** Called by <Toaster/> on mount; the returned function releases the slot. */
export function mountToastViewport(token: symbol): () => void {
  viewports.push(token);
  emitViewports();
  return () => {
    const at = viewports.indexOf(token);
    if (at >= 0) viewports.splice(at, 1);
    emitViewports();
  };
}

/** The viewport that owns the screen right now — the earliest still mounted. */
export const toastViewportOwner = (): symbol | null => viewports[0] ?? null;

export function subscribeToastViewport(fn: () => void): () => void {
  viewportListeners.add(fn);
  return () => { viewportListeners.delete(fn); };
}

/** Registered once by toast.tsx; lets a toast appear even with no provider. */
export function setToastAutoMount(fn: () => void): void { autoMount = fn; }

export function toastDuration(t: ToastRecord): number {
  if (t.duration !== undefined) return t.duration;
  const base = DEFAULT_DURATION[t.tone];
  return base && t.action ? Math.max(base, ACTION_DURATION) : base;
}

function schedule(t: ToastRecord) {
  const existing = timers.get(t.id);
  if (existing) clearTimeout(existing);
  const duration = toastDuration(t);
  if (!duration || paused) return;
  timers.set(t.id, setTimeout(() => dismissToast(t.id), duration));
}

/**
 * Freeze every dismiss timer while someone is reading the stack.
 *
 * The pointer has always had this via `holdToast`. The keyboard needs it more:
 * focus arrives through a hotkey, and a toast that vanishes on its own timer
 * while it is holding focus drops that focus on the floor.
 */
export function setToastsPaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  if (paused) {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  } else {
    for (const t of toasts) schedule(t);
  }
}

export const toastsPaused = (): boolean => paused;

export function pushToast(opts: ToastOptions): string {
  const id = opts.id ?? `toast_${++seq}`;
  const record: ToastRecord = { ...opts, id, tone: opts.tone ?? 'default', createdAt: Date.now() };
  const idx = toasts.findIndex((t) => t.id === id);
  toasts = idx >= 0
    ? toasts.map((t) => (t.id === id ? record : t))
    : [...toasts, record].slice(-TOAST_LIMIT);
  schedule(record);
  if (viewports.length === 0) autoMount?.();
  emit();
  return id;
}

export function dismissToast(id: string): void {
  const timer = timers.get(id);
  if (timer) { clearTimeout(timer); timers.delete(id); }
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function clearToasts(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  toasts = [];
  emit();
}
