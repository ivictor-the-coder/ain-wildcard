/**
 * The one utility every component in the system calls. It lives in its own leaf
 * module so the pieces that render a *fallback* — the error boundary and the
 * error state it draws — can be imported by `layout.tsx` without a cycle back
 * through it.
 */
export const cx = (...parts: unknown[]): string =>
  parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
