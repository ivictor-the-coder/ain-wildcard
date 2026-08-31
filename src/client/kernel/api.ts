import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

export interface ApiErrorBody {
  type: string;
  code: string;
  message: string;
  param?: string;
  detail?: unknown;
  doc_url?: string;
  request_id?: string;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body?.message || `Request failed with status ${status}`);
    this.name = 'ApiClientError';
    this.status = status;
    this.body = body;
  }
  get param() { return this.body?.param; }
  get code() { return this.body?.code; }
}

export interface ListEnvelope<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
  total_count?: number;
}

const BASE = '/api';

/* ---------------------------- cache + invalidation ------------------------ */

type CacheEntry = { data: unknown; error: ApiClientError | null; at: number; promise?: Promise<unknown> };
const cache = new Map<string, CacheEntry>();
const listeners = new Set<() => void>();
const notify = () => { for (const l of [...listeners]) l(); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/**
 * Bumped by every invalidation. Mounted queries subscribe to it, because
 * dropping an entry from the cache is not on its own enough to make the hook
 * that owns it ask again — its load effect is keyed on the request, which has
 * not changed. Without this counter, everything on screen after a mutation or a
 * jump of the workspace clock keeps rendering whatever it had.
 */
let version = 0;
const getVersion = (): number => version;

/** Drop cached responses whose key matches any prefix, then reload them. */
export function invalidate(...prefixes: string[]): void {
  if (!prefixes.length) cache.clear();
  for (const key of [...cache.keys()]) {
    if (prefixes.some((p) => key.includes(p))) cache.delete(key);
  }
  version += 1;
  notify();
}

export function primeCache(key: string, data: unknown): void {
  cache.set(key, { data, error: null, at: Date.now() });
  notify();
}

/* --------------------------- connection health --------------------------- */

/**
 * Two failures are not about one panel — they change what the whole product
 * should be doing — so they are held here rather than inside the hook that
 * happened to make the call. A 401 means the credentials this workspace was
 * read with are gone; a 429 means the server is refusing everyone for a while.
 * The session provider and the top bar read these, which is what stops a dead
 * session or a drained rate-limit budget from rendering as an empty workspace.
 */
export interface AuthLoss {
  at: number;
  message: string;
  requestId: string | null;
  /** The address whose 401 revealed it, quoted on the sign-in screen. */
  path: string;
}

export interface RateLimited {
  at: number;
  /** When the client will try again — from `Retry-After` when the server sends one. */
  retryAt: number;
  /** Seconds the server asked for, or null when it sent no `Retry-After` header. */
  retryAfter: number | null;
  message: string;
  requestId: string | null;
  /** Consecutive refused rounds, so the banner can stop claiming a blip. */
  streak: number;
}

let authLoss: AuthLoss | null = null;
let rateLimited: RateLimited | null = null;

/** `/v1/health` answers signed out, so its 401 would never mean anything. */
const PUBLIC_PATH = /\/v1\/health(\?|$)/;
/** A wrong password is a 401 about that form, not about the session. */
const AUTH_PATH = /\/v1\/auth\//;

export const currentAuthLoss = (): AuthLoss | null => authLoss;
export const currentRateLimit = (): RateLimited | null => rateLimited;

export function useAuthLoss(): AuthLoss | null {
  return useSyncExternalStore(subscribe, currentAuthLoss, () => null);
}
export function useRateLimit(): RateLimited | null {
  return useSyncExternalStore(subscribe, currentRateLimit, () => null);
}

/** Client backoff for a server that refuses without saying how long to wait. */
const RATE_LIMIT_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000];

export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - now) / 1000));
}

function noteFailure(url: string, status: number, body: ApiErrorBody, headers: Headers): void {
  if (status === 401 && !AUTH_PATH.test(url) && !PUBLIC_PATH.test(url)) {
    if (authLoss) return;
    authLoss = {
      at: Date.now(),
      message: body.message || 'This session is no longer valid.',
      requestId: body.request_id ?? lastId,
      path: url.startsWith(BASE) ? url.slice(BASE.length) : url,
    };
    // Everything cached was read with credentials that no longer work. Holding
    // on to it is what let a signed-out shell keep painting yesterday's numbers.
    for (const [key, entry] of cache) {
      if (entry.data !== undefined) cache.set(key, { ...entry, data: undefined });
    }
    notify();
    return;
  }
  if (status === 429) {
    const at = Date.now();
    const sameRound = !!rateLimited && at < rateLimited.retryAt;
    const streak = rateLimited ? (sameRound ? rateLimited.streak : rateLimited.streak + 1) : 1;
    const asked = parseRetryAfter(headers.get('retry-after'), at);
    const wait = asked !== null
      ? asked * 1000
      : RATE_LIMIT_BACKOFF_MS[Math.min(streak - 1, RATE_LIMIT_BACKOFF_MS.length - 1)];
    rateLimited = {
      at,
      retryAt: sameRound ? rateLimited!.retryAt : at + wait,
      retryAfter: asked,
      message: body.message || 'The server is refusing requests from this workspace.',
      requestId: body.request_id ?? lastId,
      streak,
    };
    notify();
  }
}

/** One call getting through is the only proof that the workspace is back. */
function noteSuccess(url: string): void {
  let changed = false;
  if (rateLimited) { rateLimited = null; changed = true; }
  if (authLoss && !PUBLIC_PATH.test(url)) { authLoss = null; changed = true; }
  if (changed) notify();
}

/* --------------------------------- fetch --------------------------------- */

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = path.startsWith('http') ? path : BASE + path;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) { for (const item of v) params.append(k, String(item)); }
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Every response carries a `request-id`. Holding on to the last one lets the
 * route error boundary quote something the server can be grepped for, even when
 * what threw was a render rather than a failed call.
 */
let lastId: string | null = null;
export const lastRequestId = (): string | null => lastId;

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  return requestUrl<T>(buildUrl(path, opts.query), opts);
}

/**
 * Fetch a URL that has already been through `buildUrl`. `useQuery` caches by
 * that URL and then asks for it directly — running it through `buildUrl` a
 * second time would prefix `/api` onto a path that already carries it.
 */
async function requestUrl<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  lastId = res.headers.get('request-id') || lastId;
  const text = await res.text();
  const json = text ? safeParse(text) : null;
  if (!res.ok) {
    const body: ApiErrorBody = (json as { error?: ApiErrorBody } | null)?.error
      ?? { type: 'api_error', code: 'unknown', message: text || res.statusText };
    noteFailure(url, res.status, body, res.headers);
    throw new ApiClientError(res.status, body);
  }
  noteSuccess(url);
  return json as T;
}

const safeParse = (t: string) => { try { return JSON.parse(t); } catch { return t; } };

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown, opts: RequestOptions = {}) => request<T>(path, { ...opts, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body }),
};

/* --------------------------------- hooks --------------------------------- */

export interface QueryResult<T> {
  data: T | undefined;
  error: ApiClientError | null;
  loading: boolean;
  refetch: () => void;
  /** True while revalidating with data already on screen. */
  validating: boolean;
}

export function useQuery<T = unknown>(
  path: string | null,
  query?: RequestOptions['query'],
  opts: { refreshMs?: number; enabled?: boolean } = {},
): QueryResult<T> {
  const key = path === null || opts.enabled === false ? null : buildUrl(path, query);
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (key ? cache.get(key) : undefined),
    () => undefined,
  );
  const version = useSyncExternalStore(subscribe, getVersion, () => 0);
  const [, force] = useState(0);
  const validatingRef = useRef(false);

  const load = useCallback((bypass: boolean) => {
    if (!key) return;
    const existing = cache.get(key);
    if (existing?.promise) return;
    if (existing && !bypass) return;
    if (authLoss && !PUBLIC_PATH.test(key)) {
      // Asking again only collects another 401. Say what happened instead of
      // spinning, so the panel can render the failure rather than an empty box.
      if (!existing?.error) {
        cache.set(key, {
          data: undefined,
          error: new ApiClientError(401, {
            type: 'authentication_error',
            code: 'unauthorized',
            message: authLoss.message,
            ...(authLoss.requestId ? { request_id: authLoss.requestId } : {}),
          }),
          at: Date.now(),
        });
        notify();
      }
      return;
    }
    validatingRef.current = !!existing;
    const promise = requestUrl(key)
      .then((data) => { cache.set(key, { data, error: null, at: Date.now() }); })
      .catch((e: ApiClientError) => {
        // A stale answer is still the best thing to show while a refresh fails —
        // unless the failure was the credentials, in which case it is a lie.
        const keep = e.status === 401 || e.status === 403 ? undefined : existing?.data;
        cache.set(key, { data: keep, error: e, at: Date.now() });
      })
      .finally(() => { validatingRef.current = false; notify(); force((n) => n + 1); });
    cache.set(key, { ...(existing || { data: undefined, error: null, at: 0 }), promise } as CacheEntry);
    return promise;
  }, [key]);

  // `version` is in the deps so an invalidation reloads what is on screen;
  // `load` returns immediately for a key that is still cached, so a query that
  // was not invalidated costs nothing.
  useEffect(() => { load(false); }, [load, version]);
  useEffect(() => {
    if (!opts.refreshMs || !key) return;
    const t = setInterval(() => load(true), opts.refreshMs);
    return () => clearInterval(t);
  }, [opts.refreshMs, key, load]);

  return {
    data: snapshot?.data as T | undefined,
    error: snapshot?.error ?? null,
    loading: !!key && !snapshot?.data && !snapshot?.error,
    validating: validatingRef.current,
    refetch: () => load(true),
  };
}

export interface MutationResult<A, T> {
  run: (args: A) => Promise<T>;
  loading: boolean;
  error: ApiClientError | null;
  reset: () => void;
}

export function useMutation<A = void, T = unknown>(
  fn: (args: A) => Promise<T>,
  opts: { invalidates?: string[]; onSuccess?: (result: T, args: A) => void; onError?: (e: ApiClientError) => void } = {},
): MutationResult<A, T> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const run = useCallback(async (args: A) => {
    setLoading(true); setError(null);
    try {
      const result = await fn(args);
      if (optsRef.current.invalidates?.length) invalidate(...optsRef.current.invalidates);
      optsRef.current.onSuccess?.(result, args);
      return result;
    } catch (e) {
      const err = e instanceof ApiClientError ? e : new ApiClientError(0, { type: 'api_error', code: 'network_error', message: (e as Error).message });
      setError(err);
      optsRef.current.onError?.(err);
      throw err;
    } finally { setLoading(false); }
  }, [fn]);

  return useMemo(() => ({ run, loading, error, reset: () => setError(null) }), [run, loading, error]);
}
