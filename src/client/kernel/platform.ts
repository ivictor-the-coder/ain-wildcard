/**
 * What this installation can actually do, and searching across it.
 *
 * The shell never assumes a module is present. It reads the served routes from
 * `/v1/system/map` once per session and everything downstream — search sources,
 * create actions, the time machine — is derived from that.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClientError, request, useQuery, type ListEnvelope } from './api';
import { routeSetFrom, serves, type SystemMapShape } from './shell-core';
import { buildSources, hitsFrom, mergeHits, type CrmObjectType, type SearchHit, type SearchSource } from './search-core';
import { ROUTES } from '../generated/registry';

export interface Platform {
  routes: Set<string>;
  serves: (method: string, path: string) => boolean;
  ready: boolean;
  /**
   * Set when the module list itself could not be read. Everything downstream —
   * every dashboard card, every search source, every create action — is derived
   * from this one answer, so a screen that ignores it renders "no module is
   * installed" when the truth is "the server did not answer".
   */
  error: ApiClientError | null;
  retry: () => void;
}

export function usePlatform(enabled: boolean): Platform {
  const { data, error, refetch } = useQuery<SystemMapShape>('/v1/system/map', undefined, { enabled });
  const routes = useMemo(() => routeSetFrom(data), [data]);
  // `ready` means the question has been answered, not that the answer was yes —
  // otherwise a failed map would leave every dependent panel loading forever.
  const settled = !!data || !!error || !enabled;
  return useMemo(() => ({
    routes,
    serves: (method: string, path: string) => serves(routes, method, path),
    ready: settled,
    error: enabled ? error : null,
    retry: refetch,
  }), [routes, settled, error, enabled, refetch]);
}

interface CrmSchema { object_types?: CrmObjectType[] }

export function useSearchSources(platform: Platform): SearchSource[] {
  const hasCrm = platform.serves('GET', '/v1/crm/schema');
  const { data } = useQuery<CrmSchema>('/v1/crm/schema', undefined, { enabled: hasCrm });
  const registered = useMemo(() => ROUTES.map((route) => route.path), []);
  return useMemo(
    () => buildSources({ objectTypes: data?.object_types ?? [], routes: platform.routes, registered }),
    [data, platform.routes, registered],
  );
}

export interface SearchFailure {
  source: SearchSource;
  error: ApiClientError;
}

export interface SearchState {
  hits: SearchHit[];
  /** Hits grouped by source, in source order — what the result surface renders. */
  groups: { source: SearchSource; hits: SearchHit[] }[];
  /** Sources that answered with an error. Named, not silently dropped. */
  failures: SearchFailure[];
  loading: boolean;
  error: ApiClientError | null;
  query: string;
  /** Ask every source again — what a failed source's "Try again" calls. */
  retry: () => void;
}

const EMPTY = { hits: [], groups: [], failures: [], loading: false, error: null, query: '' };

/**
 * Free-text search across every installed source, debounced and abortable.
 * Each source is asked in parallel; one that fails cannot take the palette down
 * with it, but it is reported by name rather than passed off as "no matches".
 */
export function useGlobalSearch(
  query: string,
  sources: SearchSource[],
  opts: { perSource?: number; limit?: number; delay?: number; minLength?: number } = {},
): SearchState {
  const { perSource = 5, limit = 40, delay = 160, minLength = 2 } = opts;
  const [state, setState] = useState<Omit<SearchState, 'retry'>>(EMPTY);
  const [attempt, setAttempt] = useState(0);
  const runId = useRef(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const trimmed = query.trim();
  const sourceKey = sources.map((s) => s.id).join(',');

  useEffect(() => {
    if (trimmed.length < minLength || !sources.length) {
      runId.current += 1;
      setState(EMPTY);
      return;
    }
    const id = ++runId.current;
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true, query: trimmed }));

    const timer = setTimeout(() => {
      Promise.all(sources.map(async (source) => {
        try {
          const body = await request<ListEnvelope<Record<string, unknown>>>(source.path, {
            query: { ...source.params, [source.queryKey]: trimmed, limit: perSource },
            signal: controller.signal,
          });
          return { source, hits: hitsFrom(source, body?.data ?? [], trimmed).slice(0, perSource), error: null };
        } catch (e) {
          const error = e instanceof ApiClientError ? e : null;
          return { source, hits: [] as SearchHit[], error };
        }
      })).then((results) => {
        if (id !== runId.current) return;
        const groups = results.filter((group) => group.hits.length).map(({ source, hits }) => ({ source, hits }));
        const failures = results
          .filter((row): row is typeof row & { error: ApiClientError } => !!row.error)
          .map(({ source, error }) => ({ source, error }));
        setState({
          hits: mergeHits(groups.map((group) => group.hits), limit),
          groups,
          failures,
          loading: false,
          error: failures.length === results.length ? failures[0].error : null,
          query: trimmed,
        });
      });
    }, delay);

    return () => { clearTimeout(timer); controller.abort(); };
  }, [trimmed, sourceKey, perSource, limit, delay, minLength, sources, attempt]);

  return useMemo(() => ({ ...state, retry }), [state, retry]);
}

/* ------------------------------ create menu ------------------------------ */

export interface CreateAction {
  id: string;
  label: string;
  icon: string;
  /** The screen that owns creating this, when a module has registered one. */
  to: string;
}

/**
 * Create actions are only offered when both halves exist: the API route that
 * would store the thing, and a screen registered to collect it.
 */
export function useCreateActions(platform: Platform, sources: SearchSource[]): CreateAction[] {
  return useMemo(() => {
    const registered = new Set(ROUTES.map((route) => route.path));
    const actions: CreateAction[] = [];
    for (const source of sources) {
      const listPattern = source.detailPattern?.replace(/\/:[A-Za-z_]+$/, '');
      if (!listPattern || !registered.has(listPattern)) continue;
      const writes = source.id === 'customer' ? 'POST /v1/customers'
        : source.id === 'invoice' ? 'POST /v1/invoices'
        : source.id === 'product' ? 'POST /v1/products'
        : 'POST /v1/records/:type';
      if (!platform.routes.has(writes)) continue;
      actions.push({
        id: `create.${source.id}`,
        label: `New ${source.singular.toLowerCase()}`,
        icon: source.icon,
        to: `${listPattern}?new=1`,
      });
    }
    return actions;
  }, [platform.routes, sources]);
}

/* ------------------------------ time machine ----------------------------- */

export interface ClockState {
  kind: string;
  offsetMs: number;
  now: number;
}

export interface AdvanceResult {
  object: 'clock';
  now: number;
  previous: number;
  offset_ms: number;
  jobs_run: number;
  jobs_failed: number;
}

export interface ClockMove {
  now: number;
  offsetMs: number;
  jobsRun: number;
  jobsFailed: number;
  /**
   * What the workspace answered when it was read back immediately after the
   * clock moved, if that read failed. Moving the clock is the one control that
   * can break the very session it is issued from — walk past the session's own
   * expiry and every following call is a 401 — so the move is not reported as a
   * success until the workspace has proved it can still be read.
   */
  aftermath: ApiClientError | null;
}

/**
 * A clock move, then a read-back. `POST /v1/time/advance` answering 200 only
 * says the jobs ran; it says nothing about whether the operator who asked can
 * still see the result.
 */
export function useTimeMachine(onSettled: () => void) {
  const [busy, setBusy] = useState(false);

  const move = useCallback(async (path: string, body?: unknown): Promise<ClockMove> => {
    setBusy(true);
    try {
      const result = await request<Partial<AdvanceResult>>(path, { method: 'POST', body });
      let aftermath: ApiClientError | null = null;
      try {
        await request('/v1/me');
      } catch (e) {
        aftermath = e instanceof ApiClientError ? e : new ApiClientError(0, {
          type: 'api_error', code: 'network_error',
          message: e instanceof Error ? e.message : 'The workspace could not be read back.',
        });
      }
      onSettled();
      return {
        now: result.now ?? Date.now(),
        offsetMs: result.offset_ms ?? 0,
        jobsRun: result.jobs_run ?? 0,
        jobsFailed: result.jobs_failed ?? 0,
        aftermath,
      };
    } finally { setBusy(false); }
  }, [onSettled]);

  const advance = useCallback(
    (body: { days?: number; hours?: number; to?: number }) => move('/v1/time/advance', body),
    [move],
  );
  const reset = useCallback(() => move('/v1/time/reset'), [move]);

  return { advance, reset, busy };
}
