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

export const TOAST_LIMIT = 4;

let seq = 0;
let toasts: ToastRecord[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let mountedViewports = 0;
let autoMount: (() => void) | null = null;

const emit = () => { for (const l of [...listeners]) l(); };

export function subscribeToasts(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const getToasts = (): ToastRecord[] => toasts;

/** Called by <Toaster/> so the store knows a viewport exists. */
export function registerViewport(): () => void {
  mountedViewports++;
  return () => { mountedViewports = Math.max(0, mountedViewports - 1); };
}

/** Registered once by toast.tsx; lets a toast appear even with no provider. */
export function setToastAutoMount(fn: () => void): void { autoMount = fn; }

function schedule(t: ToastRecord) {
  const existing = timers.get(t.id);
  if (existing) clearTimeout(existing);
  const duration = t.duration ?? DEFAULT_DURATION[t.tone];
  if (!duration) return;
  timers.set(t.id, setTimeout(() => dismissToast(t.id), duration));
}

export function pushToast(opts: ToastOptions): string {
  const id = opts.id ?? `toast_${++seq}`;
  const record: ToastRecord = { ...opts, id, tone: opts.tone ?? 'default', createdAt: Date.now() };
  const idx = toasts.findIndex((t) => t.id === id);
  toasts = idx >= 0
    ? toasts.map((t) => (t.id === id ? record : t))
    : [...toasts, record].slice(-TOAST_LIMIT);
  schedule(record);
  if (mountedViewports === 0) autoMount?.();
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

/** Pause the auto-dismiss timer while the pointer rests on the stack. */
export function holdToast(id: string): void {
  const timer = timers.get(id);
  if (timer) { clearTimeout(timer); timers.delete(id); }
}

export function resumeToast(id: string): void {
  const t = toasts.find((x) => x.id === id);
  if (t) schedule(t);
}
