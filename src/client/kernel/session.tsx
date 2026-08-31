import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, invalidate, useAuthLoss, useQuery, type ApiClientError, type AuthLoss } from './api';

export interface SessionUser {
  id: string; email: string; name: string; avatar_url: string | null; title: string | null;
}
export interface SessionOrg {
  id: string; name: string; slug: string; domain: string | null; logo_url: string | null;
  brand_color: string; default_currency: string; timezone: string; locale: string;
  settings: Record<string, unknown>;
}
export interface Me {
  user: SessionUser | null;
  role: string;
  auth_kind: string;
  org: SessionOrg;
  clock: { kind: string; offset_ms: number; now: number };
  teammates: (SessionUser & { role: string })[];
}

export type Theme = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';

export interface SessionValue {
  me: Me | null;
  loading: boolean;
  signedIn: boolean;
  /**
   * Set when a call came back 401 on a workspace that *was* signed in — the
   * session died rather than never existing. The sign-in screen says so, with
   * the server's own message and request id, instead of pretending you arrived.
   */
  sessionEnded: AuthLoss | null;
  /**
   * Set when `/v1/me` failed for a reason that is not "you are signed out" —
   * a 429, a 500, a dead connection. Showing a sign-in form for one of those
   * blames the operator for an outage and invites them to type a password that
   * would not have worked either.
   */
  unreachable: ApiClientError | null;
  refresh: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signInDemo: () => Promise<void>;
  signOut: () => Promise<void>;
  theme: Theme;
  setTheme: (t: Theme) => void;
  resolvedTheme: 'light' | 'dark';
  density: Density;
  setDensity: (d: Density) => void;
  /** Current workspace time — respects the time machine offset. */
  now: () => number;
  currency: string;
  locale: string;
  timeZone: string;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

/** Workspace-aware formatting helpers, wired to org locale/currency/timezone. */
export function useWorkspaceFormat() {
  const { currency, locale, timeZone } = useSession();
  return useMemo(() => ({ currency, locale, timeZone }), [currency, locale, timeZone]);
}

const readStored = <T,>(key: string, fallback: T): T => {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
};
const writeStored = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } };

export function SessionProvider({ children }: { children: ReactNode }) {
  const { data, loading, error, refetch } = useQuery<Me>('/v1/me');
  const authLoss = useAuthLoss();
  // Hold the last answer while a new one is in flight. Without this, anything
  // that drops the client cache — the time machine, a refresh — briefly makes
  // `me` null, and the shell tears itself down to the boot spinner, losing the
  // operator's scroll position and every open overlay.
  //
  // The pin has to break the moment the server says 401, though. Held through a
  // dead session it is what let the time machine walk the clock past the
  // session's own expiry and leave a signed-out browser rendering a full shell
  // over nine empty panels.
  const known = useRef<Me | null>(null);
  const handledLoss = useRef(0);
  const everSignedIn = useRef(false);
  const [deliberateSignOut, setDeliberateSignOut] = useState(false);
  if (authLoss && authLoss.at !== handledLoss.current) {
    handledLoss.current = authLoss.at;
    known.current = null;
  }
  if (data) { known.current = data; if (data.user) everSignedIn.current = true; }
  const me = data ?? known.current;
  const sessionEnded = authLoss && everSignedIn.current && !deliberateSignOut ? authLoss : null;
  const unreachable = error && error.status !== 401 && !me?.user ? error : null;
  const [themeState, setThemeState] = useState<Theme>(() => readStored<Theme>('ain.theme', 'system'));
  const [density, setDensityState] = useState<Density>(() => readStored<Density>('ain.density', 'comfortable'));
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const listener = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }, []);

  const resolvedTheme: 'light' | 'dark' = themeState === 'system' ? (systemDark ? 'dark' : 'light') : themeState;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    document.documentElement.setAttribute('data-density', density);
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme, density]);

  useEffect(() => { if (data?.clock) setOffset(data.clock.now - Date.now()); }, [data?.clock?.now]);

  const setTheme = useCallback((t: Theme) => { setThemeState(t); writeStored('ain.theme', t); }, []);
  const setDensity = useCallback((d: Density) => { setDensityState(d); writeStored('ain.density', d); }, []);

  const value = useMemo<SessionValue>(() => ({
    me,
    loading: loading && !me,
    signedIn: !!me?.user,
    sessionEnded,
    unreachable,
    refresh: () => { invalidate('/v1/me'); refetch(); },
    async signIn(email, password) {
      await api.post('/v1/auth/login', { email, password });
      setDeliberateSignOut(false);
      invalidate();
      refetch();
    },
    async signInDemo() {
      await api.post('/v1/auth/demo');
      setDeliberateSignOut(false);
      invalidate();
      refetch();
    },
    async signOut() {
      setDeliberateSignOut(true);
      everSignedIn.current = false;
      await api.post('/v1/auth/logout');
      known.current = null;
      invalidate();
      refetch();
    },
    theme: themeState, setTheme, resolvedTheme, density, setDensity,
    now: () => Date.now() + offset,
    currency: me?.org?.default_currency ?? 'usd',
    locale: me?.org?.locale ?? 'en-US',
    timeZone: me?.org?.timezone ?? 'UTC',
  }), [me, loading, sessionEnded, unreachable, refetch, themeState, setTheme, resolvedTheme, density, setDensity, offset]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
