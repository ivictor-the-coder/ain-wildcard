import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, invalidate, useQuery } from './api';

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
  const { data, loading, refetch } = useQuery<Me>('/v1/me');
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
    me: data ?? null,
    loading,
    signedIn: !!data?.user,
    refresh: () => { invalidate('/v1/me'); refetch(); },
    async signIn(email, password) { await api.post('/v1/auth/login', { email, password }); invalidate(); refetch(); },
    async signInDemo() { await api.post('/v1/auth/demo'); invalidate(); refetch(); },
    async signOut() { await api.post('/v1/auth/logout'); invalidate(); refetch(); },
    theme: themeState, setTheme, resolvedTheme, density, setDensity,
    now: () => Date.now() + offset,
    currency: data?.org?.default_currency ?? 'usd',
    locale: data?.org?.locale ?? 'en-US',
    timeZone: data?.org?.timezone ?? 'UTC',
  }), [data, loading, refetch, themeState, setTheme, resolvedTheme, density, setDensity, offset]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
