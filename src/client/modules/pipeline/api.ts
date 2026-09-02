/**
 * The shapes the deal board reads, and the reads themselves.
 *
 * Nothing in this module holds a figure of its own: a stage's probability, a
 * deal's weighted amount and the median time a stage takes are all computed by
 * the server and quoted here. Where this file does arithmetic — a column total —
 * it sums values the API returned for the deals actually on screen.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, useQuery, type ApiClientError, type ListEnvelope, type QueryResult } from '@/client/kernel/api';
import { useSession } from '@/client/kernel/session';
import { useFormat, type DateOptions, type Formatter } from '@/client/design';

/* --------------------------- what the board is ---------------------------- */

export {
  ALL_PIPELINES, DAY_MS, HORIZON_LABEL, HORIZONS, SIX_WEEK_DAYS, SORTS, conditionsOf, describeBoardState,
  horizonWindow, matchesHorizon, quarterEnd, quarterStart, sameBoardState, stageKey, stateToView,
  viewToState,
} from './board-core';
export type {
  BoardState, FilterCondition, FilterGroup, FilterNode, Horizon, StoredView,
} from './board-core';

import { DAY_MS, stageKey, type FilterNode } from './board-core';

/* -------------------------------- payloads ------------------------------- */

export interface PipelineStage {
  id: string;
  name: string;
  label: string;
  description: string | null;
  probability: number;
  is_closed: boolean;
  is_won: boolean;
  forecast_category: string | null;
  color: string;
  position: number;
  record_count: number;
  /** Present only when the object type's pipeline binding names a money property. */
  amount?: number;
  weighted_amount?: number;
}

export interface Pipeline {
  object: 'pipeline';
  id: string;
  object_type: string;
  name: string;
  label: string;
  description: string | null;
  is_default: boolean;
  archived: boolean;
  position: number;
  pipeline_property: string;
  stage_property: string;
  record_count: number;
  open_amount?: number;
  weighted_amount?: number;
  won_amount?: number;
  stages: PipelineStage[];
}

export interface RecordAssociation {
  id: string;
  association_type: string;
  label: string;
  direction: 'outgoing' | 'incoming' | string;
  record_id: string;
  object_type: string;
  display_name: string;
  is_primary: boolean;
  created: number;
}

export interface DealRecord {
  object: 'record';
  id: string;
  object_type: string;
  display_name: string;
  properties: Record<string, unknown>;
  owner_id: string | null;
  source: string | null;
  archived: boolean;
  merged_into: string | null;
  created: number;
  updated: number;
  associations?: RecordAssociation[];
}

export interface PropertyOption { value: string; label: string; color?: string }

export interface PropertyDef {
  name: string;
  label: string;
  description: string | null;
  type: string;
  group: string;
  required: boolean;
  read_only: boolean;
  calculated: string | null;
  options: PropertyOption[];
  currency?: string;
}

export interface WorkspaceUser {
  id: string;
  name: string;
  email: string;
  title: string | null;
  avatar_url: string | null;
  role: string;
}

export interface TimelineItem {
  id: string;
  kind: string;
  at: number;
  title: string;
  body: string | null;
  icon: string;
  actor_id: string | null;
  actor_type: string;
  record_id: string | null;
  data?: Record<string, unknown>;
}

export interface StageSpell {
  pipeline: string;
  pipeline_label: string;
  stage: string;
  stage_label: string;
  probability: number;
  is_closed: boolean;
  is_won: boolean;
  entered_at: number;
  exited_at: number | null;
  days_in_stage: number;
  is_current: boolean;
  moved_by: string | null;
  moved_to: string | null;
}

export interface StageHistory extends ListEnvelope<StageSpell> {
  record_id: string;
  stage_property: string;
  current_stage: string;
  days_in_current_stage: number;
  total_days: number;
}

export interface StageVelocity {
  stage: string;
  label: string;
  position: number;
  probability: number;
  is_closed: boolean;
  is_won: boolean;
  current_records: number;
  current_amount: number;
  current_weighted_amount: number;
  entered_records: number;
  median_days_in_stage: number;
  average_days_in_stage: number;
  median_days_waiting: number;
  longest_days_waiting: number;
  advance_rate: number;
  stalled_records: number;
  stalled_after_days: number;
}

export interface PipelineVelocity {
  pipeline: string;
  label: string;
  records: number;
  stalled_records: number;
  median_days_to_close: number;
  stages: StageVelocity[];
}

export interface DealListEnvelope extends ListEnvelope<DealRecord> {
  total_count: number;
}

export interface PropertyEnvelope extends ListEnvelope<PropertyDef> {
  groups: string[];
}

/* --------------------------------- reads --------------------------------- */

/** Every pipeline a deal can sit in, with its stages and live stage totals. */
/* ------------------------------ saved views ------------------------------- */

export interface DealView {
  object: 'view';
  id: string;
  object_type: string;
  name: string;
  description: string | null;
  columns: string[];
  filter: FilterNode | null;
  sort: { property: string; direction?: 'asc' | 'desc' }[];
  shared: boolean;
  owner_id: string | null;
  is_default: boolean;
  system: boolean;
  position: number;
  created: number;
  updated: number;
}

export const useDealViews = (): QueryResult<ListEnvelope<DealView>> =>
  useQuery<ListEnvelope<DealView>>('/v1/views', { object_type: 'deal' });

export const usePipelines = (): QueryResult<ListEnvelope<Pipeline>> =>
  useQuery<ListEnvelope<Pipeline>>('/v1/pipelines/deal');

export const useDealProperties = (): QueryResult<PropertyEnvelope> =>
  useQuery<PropertyEnvelope>('/v1/objects/deal/properties');

export const useUsers = (): QueryResult<ListEnvelope<WorkspaceUser>> =>
  useQuery<ListEnvelope<WorkspaceUser>>('/v1/users');

export function useUserIndex(users: WorkspaceUser[] | undefined): Map<string, WorkspaceUser> {
  return useMemo(() => new Map((users ?? []).map((user) => [user.id, user])), [users]);
}

export const useVelocity = (pipeline: string | undefined): QueryResult<PipelineVelocity> =>
  useQuery<PipelineVelocity>(
    pipeline ? `/v1/pipelines/deal/${encodeURIComponent(pipeline)}/velocity` : null,
  );

export interface VelocityIndex {
  /** Every stage of every pipeline asked for, keyed by `stageKey`. */
  byStage: Map<string, StageVelocity>;
  byPipeline: Map<string, PipelineVelocity>;
  /** Open deals past their own stage's stall threshold, across the pipelines asked for. */
  stalledOpen: number;
  loading: boolean;
  error: ApiClientError | null;
  refetch: () => void;
}

/**
 * Stage velocity for several pipelines at once.
 *
 * `useVelocity` reads one, which is all a single-pipeline board needs. The
 * all-pipelines board needs every one of them, and a hook cannot be called in a
 * loop, so this reads them together and indexes the result by (pipeline, stage).
 */
export function useVelocities(pipelines: string[]): VelocityIndex {
  const key = pipelines.join(',');
  const [rows, setRows] = useState<PipelineVelocity[] | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!key) { setRows([]); setError(null); return; }
    let live = true;
    setError(null);
    Promise.all(key.split(',').map((name) => (
      api.get<PipelineVelocity>(`/v1/pipelines/deal/${encodeURIComponent(name)}/velocity`)
    )))
      .then((all) => { if (live) { setRows(all); setError(null); } })
      .catch((raw: unknown) => { if (live) { setRows(null); setError(raw as ApiClientError); } });
    return () => { live = false; };
  }, [key, nonce]);

  return useMemo(() => {
    const byStage = new Map<string, StageVelocity>();
    const byPipeline = new Map<string, PipelineVelocity>();
    let stalledOpen = 0;
    for (const pipeline of rows ?? []) {
      byPipeline.set(pipeline.pipeline, pipeline);
      for (const stage of pipeline.stages) {
        byStage.set(stageKey(pipeline.pipeline, stage.stage), stage);
        // A deal in a closed stage has finished, not stalled, however long it
        // has sat there.
        if (!stage.is_closed) stalledOpen += stage.stalled_records;
      }
    }
    return {
      byStage,
      byPipeline,
      stalledOpen,
      loading: !!key && rows === null && !error,
      error,
      refetch: () => setNonce((n) => n + 1),
    };
  }, [rows, error, key]);
}

/* -------------------------- searching the whole set ----------------------- */

/**
 * A filtered set of deals, counted over the *whole* set rather than the page.
 *
 * `GET /v1/records/deal` answers one page, so anything that totals its rows is
 * quoting a property of the page size. The dashboard widget did exactly that
 * and captioned six rows as if they were the six-week commit. This runs the
 * same filter the saved views store through `POST /v1/records/deal/search`,
 * follows the cursor to the end, and reports `total` from the server's own
 * count — so a caption can say what matched and, separately, how much of it is
 * drawn.
 */
export interface DealSearch {
  /** Every matching deal that was fetched, in the order the sort asked for. */
  deals: DealRecord[];
  /** What the server says matched, whether or not every row came back. */
  total: number;
  /** The sum of `amount` over the whole matching set, or null when truncated. */
  amount: number | null;
  /** True when the workspace holds more matches than the ceiling fetches. */
  truncated: boolean;
  loading: boolean;
  error: ApiClientError | null;
  refetch: () => void;
}

const SEARCH_PAGE = 200;
/** Past this the widget stops paging and says the total is the server's, not its own. */
export const SEARCH_CEILING = 2000;

export interface DealSearchBody {
  filter?: FilterNode;
  sort?: { property: string; direction?: 'asc' | 'desc' }[];
  expand?: string[];
  properties?: string[];
}

interface SearchPage extends ListEnvelope<DealRecord> { total_count?: number }

/** Every deal the filter matches, following the cursor to the end or the ceiling. */
export async function fetchDealSearch(
  body: DealSearchBody,
): Promise<{ deals: DealRecord[]; total: number; truncated: boolean }> {
  const deals: DealRecord[] = [];
  let cursor: string | null = null;
  let total = 0;
  for (let page = 0; page < SEARCH_CEILING / SEARCH_PAGE; page += 1) {
    const result: SearchPage = await api.post<SearchPage>('/v1/records/deal/search', {
      ...body,
      limit: SEARCH_PAGE,
      ...(cursor ? { cursor } : {}),
    });
    deals.push(...result.data);
    total = typeof result.total_count === 'number' ? result.total_count : deals.length;
    if (!result.has_more || !result.next_cursor) return { deals, total, truncated: false };
    cursor = result.next_cursor;
  }
  return { deals, total, truncated: true };
}

/**
 * Whether asking again is worth anything.
 *
 * A refusal that is about *this* request — a bad filter, a property that does
 * not exist — will be refused identically a second later. A rate limit, a
 * dropped connection or a server that fell over is about the moment, and a
 * dashboard card that gives up on the first one of those shows an error where a
 * number belongs.
 */
const worthRetrying = (e: ApiClientError): boolean =>
  e.status === 0 || e.status === 429 || e.status >= 500;

export function useDealSearch(body: DealSearchBody | null): DealSearch {
  const key = body ? JSON.stringify(body) : null;
  const [state, setState] = useState<{ deals: DealRecord[]; total: number; truncated: boolean } | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!key) { setState(null); setError(null); return; }
    let live = true;
    let timer = 0;
    setError(null);
    const attempt = (tries: number) => {
      fetchDealSearch(JSON.parse(key) as DealSearchBody)
        .then((result) => { if (live) { setState(result); setError(null); } })
        .catch((raw: unknown) => {
          if (!live) return;
          const e = raw as ApiClientError;
          if (tries < 2 && worthRetrying(e)) {
            timer = window.setTimeout(() => attempt(tries + 1), 1200 * (tries + 1));
            return;
          }
          setState(null);
          setError(e);
        });
    };
    attempt(0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [key, nonce]);

  return {
    deals: state?.deals ?? [],
    total: state?.total ?? 0,
    amount: state && !state.truncated ? state.deals.reduce((sum, deal) => sum + dealAmount(deal), 0) : null,
    truncated: state?.truncated ?? false,
    loading: !!key && !state && !error,
    error,
    refetch: () => setNonce((n) => n + 1),
  };
}

/* ------------------------------ calendar dates ---------------------------- */

/**
 * A close date is a day, not an instant.
 *
 * The CRM stores a `date` property as midnight UTC — that is what the calendar
 * writes when you click a cell, and what the server stamps when a deal closes.
 * Formatting one in the workspace's timezone therefore lands it on the previous
 * evening for every zone west of Greenwich, so a deal you close on the 1st reads
 * as closed on the 31st of the month before. Every surface in this module that
 * shows a `date` property goes through `calendarDate` instead, which reads the
 * stored day back exactly as the picker wrote it.
 *
 * Instants — `closed_at`, `stage_entered_at`, `created` — are genuine moments in
 * time and keep the workspace's zone. Only calendar days come through here.
 */
export type CalendarFormat = Formatter & {
  /** A date-only property, read back in the day it was stored as. */
  calendarDate(ts: number | null | undefined, o?: Omit<DateOptions, 'timeZone'>): string;
  /** Midnight UTC of the workspace's civil today — what a date picker would write. */
  calendarToday(): number;
  /** Whole days from the workspace's civil today to a stored calendar date. */
  calendarDaysUntil(ts: number): number;
  /** "today", "in 22 days", "3 days ago" — never "in -0 days". */
  calendarRelative(ts: number): string;
};

/** Midnight UTC of the civil day `now` falls on in `timeZone`. */
export function civilDay(now: number, timeZone: string): number {
  try {
    const iso = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const parsed = Date.parse(`${iso}T00:00:00.000Z`);
    if (Number.isFinite(parsed)) return parsed;
  } catch { /* an unknown zone falls through to UTC */ }
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The workspace formatter, plus the calendar-day helpers this module needs. */
export function useDealFormat(): CalendarFormat {
  const f = useFormat();
  const session = useSession();
  const timeZone = session.timeZone;
  const nowFn = session.now;
  return useMemo(() => {
    const today = () => civilDay(nowFn(), timeZone);
    const daysUntil = (ts: number) => Math.round((ts - today()) / DAY_MS);
    return {
      ...f,
      calendarDate: (ts, o) => f.date(ts, { ...o, timeZone: 'UTC' }),
      calendarToday: today,
      calendarDaysUntil: daysUntil,
      calendarRelative: (ts: number) => {
        const days = daysUntil(ts);
        if (days === 0) return 'today';
        if (days === 1) return 'tomorrow';
        if (days === -1) return 'yesterday';
        return days > 0 ? `in ${f.plural(days, 'day')}` : `${f.plural(-days, 'day')} ago`;
      },
    };
  }, [f, nowFn, timeZone]);
}

/* -------------------------------- accessors ------------------------------ */

export const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));
export const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
export const maybeNum = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const dealStage = (deal: DealRecord): string => str(deal.properties.deal_stage);
export const dealPipeline = (deal: DealRecord): string => str(deal.properties.pipeline);
export const dealAmount = (deal: DealRecord): number => num(deal.properties.amount);
export const dealWeighted = (deal: DealRecord): number => num(deal.properties.weighted_amount);
export const dealCloseDate = (deal: DealRecord): number | null => maybeNum(deal.properties.close_date);
export const dealEnteredStage = (deal: DealRecord): number | null => maybeNum(deal.properties.stage_entered_at);

export const accountOf = (deal: DealRecord): RecordAssociation | undefined =>
  deal.associations?.find((a) => a.association_type === 'deal_to_company');

export const contactsOf = (deal: DealRecord): RecordAssociation[] =>
  (deal.associations ?? []).filter((a) => a.association_type === 'deal_to_contact');

/** The href a record of this type has a screen at, or null when none is registered. */
export const recordHref = (objectType: string, id: string): string => {
  if (objectType === 'deal') return `/deals/${encodeURIComponent(id)}`;
  if (objectType === 'company') return `/companies/${encodeURIComponent(id)}`;
  if (objectType === 'contact') return `/contacts/${encodeURIComponent(id)}`;
  return `/records/${objectType}/${encodeURIComponent(id)}`;
};

/* --------------------------------- totals -------------------------------- */

export interface ColumnTotals {
  deals: number;
  amount: number;
  weighted: number;
}

/** Sums the server's own `amount` and `weighted_amount` over the deals shown. */
export function totalsOf(deals: DealRecord[]): ColumnTotals {
  let amount = 0;
  let weighted = 0;
  for (const deal of deals) {
    amount += dealAmount(deal);
    weighted += dealWeighted(deal);
  }
  return { deals: deals.length, amount, weighted };
}

/* ------------------------------ stage moves ------------------------------ */

/**
 * What a stage move has to collect before it is allowed to land.
 *
 * Both sources are read from the workspace's own property definitions rather
 * than written down here: any property the deal object marks `required` that
 * this deal has not filled in, and — when the destination stage closes the deal
 * — the writable properties in the object's outcome group, because a deal that
 * closes with no reason recorded is a forecast review nobody can hold.
 */
export function stageRequirements(
  deal: DealRecord | null,
  stage: PipelineStage,
  properties: PropertyDef[],
): { required: PropertyDef[]; optional: PropertyDef[] } {
  const writable = properties.filter((p) => !p.read_only && !p.calculated);
  const empty = (name: string): boolean => {
    const value = deal?.properties[name];
    return value === undefined || value === null || value === '';
  };
  const required = writable.filter((p) => p.required && empty(p.name));
  const optional: PropertyDef[] = [];
  if (stage.is_closed) {
    for (const property of writable) {
      if (property.group.toLowerCase() !== 'outcome') continue;
      if (required.some((p) => p.name === property.name)) continue;
      // An outcome picklist is the reason the deal ended; the free-text ones
      // beside it are colour, so they are offered rather than demanded.
      if (property.type === 'enum' && empty(property.name)) required.push(property);
      else optional.push(property);
    }
  }
  return { required, optional };
}

export const emptyValue = (value: unknown): boolean =>
  value === undefined || value === null || value === '';

/* --------------------------------- undo ---------------------------------- */

/**
 * Everything a stage move overwrote on one deal, so it can be put back.
 *
 * A move is the most consequential thing this board does — it restamps the
 * probability, the forecast category and, on a closing stage, the close date —
 * and until now the only way back from a mis-drop was to remember which column
 * the card came from. The snapshot is taken from the record as it was read,
 * before the write, and holds the previous value of every property the write
 * names plus the close date, which the server stamps on a close and does not
 * put back when the deal is reopened.
 *
 * The stage-owned fields are deliberately absent: `probability`,
 * `forecast_category`, `deal_status` and `closed_at` are derived from the stage
 * and the server refuses a write to them, so restoring the stage restores them.
 */
export interface MoveSnapshot {
  id: string;
  name: string;
  /** The stage it was in, for the sentence the undo toast is written in. */
  stage: string;
  properties: Record<string, unknown>;
}

export function snapshotMove(deal: DealRecord, written: Record<string, unknown>): MoveSnapshot {
  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(written)) {
    if (key === 'close_date') continue;
    properties[key] = deal.properties[key] ?? null;
  }
  properties.close_date = deal.properties.close_date ?? null;
  return { id: deal.id, name: deal.display_name, stage: dealStage(deal), properties };
}

/** Put one deal back exactly as the snapshot found it. */
export const revertMove = (snapshot: MoveSnapshot): Promise<DealRecord> =>
  api.patch<DealRecord>(`/v1/records/deal/${encodeURIComponent(snapshot.id)}`, { properties: snapshot.properties });

interface BatchOutcome { errors: number; results: { status: string }[] }

/** Put a whole bulk move back, in one batch, and say how many landed. */
export async function revertMoves(snapshots: MoveSnapshot[]): Promise<number> {
  const batch = await api.post<BatchOutcome>('/v1/records/deal/batch', {
    operation: 'update',
    records: snapshots.map((snapshot) => ({ id: snapshot.id, properties: snapshot.properties })),
  });
  return batch.results.filter((row) => row.status === 'updated').length;
}

/**
 * Who owned each deal before a reassignment.
 *
 * A bulk reassignment writes every deal on its own, exactly as a bulk stage
 * move does, so the way back is the same shape: each deal keeps the id of the
 * teammate it came from, and a deal that had no owner goes back to having
 * none. Reassigning three deals to the wrong rep used to mean opening and
 * fixing them one at a time, while the identical stage move next to it offered
 * Undo in the notification it landed with.
 */
export interface OwnerSnapshot {
  id: string;
  name: string;
  owner_id: string | null;
}

export const snapshotOwner = (deal: DealRecord): OwnerSnapshot =>
  ({ id: deal.id, name: deal.display_name, owner_id: deal.owner_id ?? null });

/** Hand every deal back to whoever held it, and say how many landed. */
export async function revertOwners(snapshots: OwnerSnapshot[]): Promise<number> {
  const batch = await api.post<BatchOutcome>('/v1/records/deal/batch', {
    operation: 'update',
    records: snapshots.map((snapshot) => ({ id: snapshot.id, properties: {}, owner_id: snapshot.owner_id })),
  });
  return batch.results.filter((row) => row.status === 'updated').length;
}

/* ---------------------------- win and loss reasons ------------------------ */

/**
 * Which close reasons belong to a win, and which to a loss.
 *
 * The workspace keeps one `close_reason` picklist for both outcomes, so a flat
 * list lets you record "Closed won · Lost to competitor" — a state win/loss
 * reporting will believe. The split is not written down here: it is read from
 * the workspace's own closed deals, by asking which reasons it has actually
 * recorded against a won deal and which against a lost one. A reason nobody has
 * used yet falls back to the colour the workspace gave it, so a brand-new
 * workspace still gets a sensible half rather than an empty picker.
 */
export type Outcome = 'won' | 'lost';

export interface OutcomeSplit {
  /** property name → the reasons seen on won deals. */
  won: Map<string, Set<string>>;
  lost: Map<string, Set<string>>;
  /** How many closed deals the split was learned from. */
  sampled: number;
  loading: boolean;
  error: ApiClientError | null;
}

const WIN_COLOURS = new Set(['green', 'teal', 'emerald', 'lime', 'mint']);

const EMPTY_SPLIT: OutcomeSplit = { won: new Map(), lost: new Map(), sampled: 0, loading: false, error: null };

interface OutcomeRow { properties: Record<string, unknown> }

const splitCache = new Map<string, Promise<OutcomeSplit>>();

async function loadSplit(names: string[]): Promise<OutcomeSplit> {
  const page = await api.post<ListEnvelope<OutcomeRow>>('/v1/records/deal/search', {
    filter: { property: 'deal_status', operator: 'in', values: ['won', 'lost'] },
    properties: ['deal_status', ...names],
    limit: 200,
  });
  const won = new Map<string, Set<string>>();
  const lost = new Map<string, Set<string>>();
  for (const name of names) { won.set(name, new Set()); lost.set(name, new Set()); }
  for (const row of page.data) {
    const side = str(row.properties.deal_status) === 'won' ? won : lost;
    for (const name of names) {
      const value = str(row.properties[name]);
      if (value) side.get(name)?.add(value);
    }
  }
  return { won, lost, sampled: page.data.length, loading: false, error: null };
}

/**
 * Learn the win/loss split for every enum in the object's outcome group.
 *
 * One search, cached for the life of the tab: the answer only changes when a
 * deal closes with a reason nobody has used before, and the colour fallback
 * covers exactly that case until the next reload.
 */
export function useOutcomeSplit(properties: PropertyDef[], enabled: boolean): OutcomeSplit {
  const names = useMemo(
    () => properties
      .filter((p) => p.type === 'enum' && !p.read_only && !p.calculated && p.group.toLowerCase() === 'outcome')
      .map((p) => p.name)
      .sort(),
    [properties],
  );
  const key = names.join(',');
  const [state, setState] = useState<OutcomeSplit>(EMPTY_SPLIT);

  useEffect(() => {
    if (!enabled || !key) { setState(EMPTY_SPLIT); return; }
    let live = true;
    let pending = splitCache.get(key);
    if (!pending) {
      pending = loadSplit(key.split(','));
      splitCache.set(key, pending);
      pending.catch(() => splitCache.delete(key));
    }
    setState((prev) => (prev.sampled ? prev : { ...EMPTY_SPLIT, loading: true }));
    pending
      .then((result) => { if (live) setState(result); })
      .catch((e: unknown) => { if (live) setState({ ...EMPTY_SPLIT, error: e as ApiClientError }); });
    return () => { live = false; };
  }, [key, enabled]);

  return state;
}

/**
 * The half of a picklist that belongs to this outcome.
 *
 * Options the workspace has recorded on both sides stay on both — a genuinely
 * ambiguous reason is the workspace's own choice and hiding it would lose data.
 */
export function reasonOptions(
  property: PropertyDef,
  outcome: Outcome,
  split: OutcomeSplit,
): { options: PropertyOption[]; learned: boolean } {
  const seenWon = split.won.get(property.name) ?? new Set<string>();
  const seenLost = split.lost.get(property.name) ?? new Set<string>();
  const learned = seenWon.size > 0 || seenLost.size > 0;
  const options = property.options.filter((option) => {
    const onWon = seenWon.has(option.value);
    const onLost = seenLost.has(option.value);
    if (onWon || onLost) return outcome === 'won' ? onWon : onLost;
    return outcome === 'won' ? WIN_COLOURS.has(option.color ?? '') : !WIN_COLOURS.has(option.color ?? '');
  });
  return { options: options.length ? options : property.options, learned };
}
