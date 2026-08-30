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

/** Drop cached responses whose key matches any prefix, then re-render. */
export function invalidate(...prefixes: string[]): void {
  if (!prefixes.length) cache.clear();
  for (const key of [...cache.keys()]) {
    if (prefixes.some((p) => key.includes(p))) cache.delete(key);
  }
  notify();
}

export function primeCache(key: string, data: unknown): void {
  cache.set(key, { data, error: null, at: Date.now() });
  notify();
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

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  const json = text ? safeParse(text) : null;
  if (!res.ok) {
    const body = (json as any)?.error || { type: 'api_error', code: 'unknown', message: text || res.statusText };
    throw new ApiClientError(res.status, body);
  }
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
  const [, force] = useState(0);
  const validatingRef = useRef(false);

  const load = useCallback((bypass: boolean) => {
    if (!key) return;
    const existing = cache.get(key);
    if (existing?.promise) return;
    if (existing && !bypass) return;
    validatingRef.current = !!existing;
    const promise = request(key)
      .then((data) => { cache.set(key, { data, error: null, at: Date.now() }); })
      .catch((e: ApiClientError) => { cache.set(key, { data: existing?.data, error: e, at: Date.now() }); })
      .finally(() => { validatingRef.current = false; notify(); force((n) => n + 1); });
    cache.set(key, { ...(existing || { data: undefined, error: null, at: 0 }), promise } as CacheEntry);
    return promise;
  }, [key]);

  useEffect(() => { load(false); }, [load]);
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
