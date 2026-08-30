import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { RouteDef } from './registry-types';

export interface Location {
  path: string;
  search: string;
  hash: string;
  query: Record<string, string>;
  state: unknown;
}

export interface RouterValue {
  location: Location;
  params: Record<string, string>;
  route: RouteDef | null;
  navigate: (to: string, opts?: { replace?: boolean; state?: unknown }) => void;
  back: () => void;
  setQuery: (patch: Record<string, string | number | undefined | null>, opts?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error('useRouter must be used inside <RouterProvider>');
  return value;
}
export const useNavigate = () => useRouter().navigate;
export const useParams = () => useRouter().params;
export const useLocation = () => useRouter().location;

/** `useSearchParam('status')` reads & writes a single query parameter. */
export function useSearchParam(key: string, fallback = ''): [string, (v: string | undefined) => void] {
  const { location, setQuery } = useRouter();
  const value = location.query[key] ?? fallback;
  const set = useCallback((v: string | undefined) => setQuery({ [key]: v || undefined }, { replace: true }), [key, setQuery]);
  return [value, set];
}

function readLocation(): Location {
  const { pathname, search, hash } = window.location;
  return {
    path: pathname.replace(/\/+$/, '') || '/',
    search,
    hash,
    query: Object.fromEntries(new URLSearchParams(search).entries()),
    state: window.history.state?.usr ?? null,
  };
}

export function matchRoute(routes: RouteDef[], path: string): { route: RouteDef; params: Record<string, string> } | null {
  const parts = path.split('/').filter(Boolean);
  let wildcard: { route: RouteDef; params: Record<string, string> } | null = null;
  const scored = routes
    .map((r) => ({ r, segs: r.path.split('/').filter(Boolean) }))
    .sort((a, b) => {
      const aDyn = a.segs.filter((s) => s.startsWith(':')).length;
      const bDyn = b.segs.filter((s) => s.startsWith(':')).length;
      return aDyn - bDyn || b.segs.length - a.segs.length;
    });
  for (const { r, segs } of scored) {
    if (segs.includes('*')) {
      const prefix = segs.slice(0, segs.indexOf('*'));
      if (prefix.every((s, i) => s === parts[i])) {
        wildcard ||= { route: r, params: { '*': parts.slice(prefix.length).join('/') } };
      }
      continue;
    }
    if (segs.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.startsWith(':')) { params[seg.slice(1)] = decodeURIComponent(parts[i]); continue; }
      if (seg !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return wildcard;
}

export function RouterProvider({ routes, children }: { routes: RouteDef[]; children: ReactNode }) {
  const [location, setLocation] = useState<Location>(readLocation);

  useEffect(() => {
    const onPop = () => setLocation(readLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string, opts: { replace?: boolean; state?: unknown } = {}) => {
    if (/^https?:\/\//.test(to)) { window.location.href = to; return; }
    const current = window.location.pathname + window.location.search;
    if (to === current && !opts.replace) return;
    const method = opts.replace ? 'replaceState' : 'pushState';
    window.history[method]({ usr: opts.state ?? null }, '', to);
    setLocation(readLocation());
    if (!opts.replace) window.scrollTo({ top: 0 });
  }, []);

  const setQuery = useCallback((patch: Record<string, string | number | undefined | null>, opts: { replace?: boolean } = {}) => {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === '') params.delete(k);
      else params.set(k, String(v));
    }
    const qs = params.toString();
    navigate(window.location.pathname + (qs ? `?${qs}` : ''), { replace: opts.replace ?? true });
  }, [navigate]);

  const matched = useMemo(() => matchRoute(routes, location.path), [routes, location.path]);

  useEffect(() => {
    const title = matched?.route.title;
    const resolved = typeof title === 'function' ? title(matched?.params ?? {}) : title;
    document.title = resolved ? `${resolved} · Ain` : 'Ain';
  }, [matched]);

  const value = useMemo<RouterValue>(() => ({
    location,
    params: matched?.params ?? {},
    route: matched?.route ?? null,
    navigate,
    back: () => window.history.back(),
    setQuery,
  }), [location, matched, navigate, setQuery]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  replace?: boolean;
  state?: unknown;
}

export function Link({ to, replace, state, onClick, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.currentTarget.target && e.currentTarget.target !== '_self')) return;
        e.preventDefault();
        navigate(to, { replace, state });
      }}
      {...rest}
    />
  );
}

/** True when `to` matches the current path (exact, or as a section prefix). */
export function useIsActive(to: string, exact = false): boolean {
  const { location } = useRouter();
  const base = to.split('?')[0].replace(/\/+$/, '') || '/';
  if (exact || base === '/') return location.path === base;
  return location.path === base || location.path.startsWith(base + '/');
}
