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

export type Horizon = 'all' | 'overdue' | '30' | 'quarter';

export const HORIZON_LABEL: Record<Horizon, string> = {
  all: 'Any close date',
  overdue: 'Past its close date',
  '30': 'Closing within 30 days',
  quarter: 'Closing this quarter',
};

export const SORTS: { value: string; label: string; sort: string; order: 'asc' | 'desc' }[] = [
  { value: 'amount', label: 'Largest first', sort: 'amount', order: 'desc' },
  { value: 'close', label: 'Closing soonest', sort: 'close_date', order: 'asc' },
  { value: 'stage', label: 'Longest in stage', sort: 'stage_entered_at', order: 'asc' },
  { value: 'updated', label: 'Recently updated', sort: 'updated', order: 'desc' },
];

/**
 * Everything a saved view remembers.
 *
 * Not the free-text search: a view is the shape of the question ("Priya's
 * commit deals closing this quarter"), and the search box is how you find one
 * record inside it. HubSpot draws the same line, and saving the search would
 * make every view stale the moment the deal it named was renamed.
 */
export interface BoardState {
  pipeline: string;
  owner: string;
  forecast: string;
  horizon: Horizon;
  sort: string;
  closed: boolean;
}

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

export interface FilterCondition { property: string; operator: string; value?: unknown; values?: unknown[] }
export interface FilterGroup { op: 'and' | 'or'; filters: (FilterGroup | FilterCondition)[] }
export type FilterNode = FilterGroup | FilterCondition;

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

const isGroup = (node: FilterNode): node is FilterGroup =>
  typeof (node as FilterGroup).op === 'string' && Array.isArray((node as FilterGroup).filters);

/** Every leaf condition in a view's filter, whatever it is nested inside. */
export function conditionsOf(node: FilterNode | null): FilterCondition[] {
  if (!node) return [];
  if (!isGroup(node)) return [node];
  return node.filters.flatMap((child) => conditionsOf(child));
}

const CLOSE_WINDOW: Record<string, Horizon> = {
  'today|+30d': '30',
  'start_of_quarter|end_of_quarter': 'quarter',
};

/**
 * A saved view, read back as the board controls that produced it.
 *
 * The server stores a real filter tree — the same one the record search
 * compiles — so a view saved here is a view the API understands, not an opaque
 * blob only this screen can read. Reading it back means recognising the handful
 * of shapes these controls can write; `readable` says whether that succeeded,
 * so a view built elsewhere is never silently shown as something it is not.
 */
export function viewToState(view: DealView): { state: BoardState; readable: boolean } {
  const state: BoardState = { pipeline: '', owner: '', forecast: '', horizon: 'all', sort: 'amount', closed: true };
  let readable = view.filter === null || isGroup(view.filter);
  for (const condition of conditionsOf(view.filter)) {
    const value = typeof condition.value === 'string' ? condition.value : '';
    if (condition.property === 'pipeline' && condition.operator === 'eq') state.pipeline = value;
    else if (condition.property === 'owner_id' && condition.operator === 'eq') state.owner = value;
    else if (condition.property === 'forecast_category' && condition.operator === 'eq') state.forecast = value;
    else if (condition.property === 'deal_status' && condition.operator === 'eq' && value === 'open') state.closed = false;
    else if (condition.property === 'close_date' && condition.operator === 'before' && value === 'today') state.horizon = 'overdue';
    else if (condition.property === 'close_date' && condition.operator === 'between') {
      const key = (condition.values ?? []).map(String).join('|');
      if (CLOSE_WINDOW[key]) state.horizon = CLOSE_WINDOW[key];
      else readable = false;
    } else readable = false;
  }
  const sort = SORTS.find((row) => row.sort === view.sort[0]?.property && row.order === (view.sort[0]?.direction ?? 'asc'));
  if (sort) state.sort = sort.value;
  return { state, readable };
}

/** The same journey the other way: the board's controls as a stored filter. */
export function stateToView(state: BoardState): { filter: FilterNode | null; sort: DealView['sort'] } {
  const filters: FilterCondition[] = [];
  if (state.pipeline) filters.push({ property: 'pipeline', operator: 'eq', value: state.pipeline });
  if (!state.closed) filters.push({ property: 'deal_status', operator: 'eq', value: 'open' });
  if (state.owner) filters.push({ property: 'owner_id', operator: 'eq', value: state.owner });
  if (state.forecast) filters.push({ property: 'forecast_category', operator: 'eq', value: state.forecast });
  if (state.horizon === 'overdue') filters.push({ property: 'close_date', operator: 'before', value: 'today' });
  if (state.horizon === '30') filters.push({ property: 'close_date', operator: 'between', values: ['today', '+30d'] });
  if (state.horizon === 'quarter') filters.push({ property: 'close_date', operator: 'between', values: ['start_of_quarter', 'end_of_quarter'] });
  const chosen = SORTS.find((row) => row.value === state.sort) ?? SORTS[0];
  return {
    filter: filters.length ? { op: 'and', filters } : null,
    sort: [{ property: chosen.sort, direction: chosen.order }],
  };
}

export const sameBoardState = (a: BoardState, b: BoardState): boolean =>
  a.pipeline === b.pipeline && a.owner === b.owner && a.forecast === b.forecast
  && a.horizon === b.horizon && a.sort === b.sort && a.closed === b.closed;

/** What a view narrows to, in the words its own controls use. */
export function describeBoardState(state: BoardState, o: {
  pipelineLabel: (name: string) => string;
  ownerName: (id: string) => string;
  forecastLabel: (value: string) => string;
}): string {
  const parts = [
    state.pipeline && o.pipelineLabel(state.pipeline),
    state.owner && o.ownerName(state.owner),
    state.forecast && o.forecastLabel(state.forecast),
    state.horizon !== 'all' && HORIZON_LABEL[state.horizon].toLowerCase(),
    state.closed ? 'closed stages included' : 'open stages only',
    (SORTS.find((row) => row.value === state.sort) ?? SORTS[0]).label.toLowerCase(),
  ].filter(Boolean);
  return parts.join(' · ');
}

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
export const DAY_MS = 86_400_000;

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
