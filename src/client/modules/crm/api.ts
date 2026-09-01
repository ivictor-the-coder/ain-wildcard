/**
 * The CRM's client-side view of its own API.
 *
 * The object model is defined at runtime, not at build time — a workspace can
 * add an object type, a property or an association without a deploy — so every
 * screen in this module is driven by `/v1/objects`, `/v1/objects/:type/properties`
 * and `/v1/crm/schema` rather than by types hand-written against the seed data.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, invalidate, useQuery, type ApiClientError, type ListEnvelope } from '@/client/kernel/api';

/* ------------------------------- vocabulary ------------------------------- */

export type PropertyType =
  | 'string' | 'text' | 'number' | 'currency' | 'date' | 'datetime' | 'bool'
  | 'enum' | 'multi_enum' | 'url' | 'email' | 'phone' | 'user' | 'reference'
  | 'json' | 'computed';

export type PropertyValue = string | number | boolean | string[] | Record<string, unknown> | null;

export interface PropertyOption {
  value: string;
  label: string;
  color?: string;
  description?: string;
  position?: number;
}

export interface PropertyRollup {
  association: string;
  aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max';
  property?: string;
  direction?: 'outgoing' | 'incoming' | 'both';
  filter?: FilterNode;
}

export interface PropertyDef {
  object_type: string;
  name: string;
  id: string;
  label: string;
  description: string | null;
  type: PropertyType;
  group: string;
  options: PropertyOption[];
  reference_type: string | null;
  required: boolean;
  unique: boolean;
  read_only: boolean;
  system: boolean;
  hidden: boolean;
  default_value: PropertyValue;
  calculated: string | null;
  rollup: PropertyRollup | null;
  currency: string | null;
  position: number;
}

export interface ObjectTypeDef {
  name: string;
  id: string;
  label: string;
  plural_label: string;
  description: string | null;
  icon: string;
  color: string | null;
  primary_property: string;
  secondary_property: string | null;
  searchable: string[];
  category: 'record' | 'activity';
  system: boolean;
  position: number;
  record_count?: number;
  property_count?: number;
}

export interface AssociationSummary {
  id: string;
  association_type: string;
  label: string;
  direction: 'outgoing' | 'incoming';
  record_id: string;
  object_type: string;
  display_name: string;
  is_primary: boolean;
  created: number;
}

export interface AssociationTypeDef {
  name: string;
  id: string;
  from_object: string;
  to_object: string;
  label: string;
  inverse_label: string;
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  system: boolean;
}

export interface CrmRecord {
  object: 'record';
  id: string;
  object_type: string;
  properties: Record<string, PropertyValue>;
  display_name: string;
  owner_id: string | null;
  source: string;
  archived: boolean;
  merged_into: string | null;
  created: number;
  updated: number;
  created_by: string | null;
  updated_by: string | null;
  associations?: AssociationSummary[];
  merged_from?: string;
}

export type FilterOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'not_contains' | 'starts_with' | 'ends_with'
  | 'in' | 'not_in' | 'is_set' | 'is_not_set'
  | 'between' | 'before' | 'after' | 'within_last' | 'within_next';

export type RelativeUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface PropertyCondition {
  property: string;
  operator: FilterOperator;
  value?: unknown;
  values?: unknown[];
  unit?: RelativeUnit;
  compare_property?: string;
}

export interface AssociationCondition {
  association: string;
  direction?: 'outgoing' | 'incoming' | 'both';
  where?: FilterNode;
  aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max';
  aggregate_property?: string;
  operator: FilterOperator;
  value?: unknown;
  values?: unknown[];
  unit?: RelativeUnit;
}

export interface FilterGroup {
  op: 'and' | 'or' | 'not';
  filters: FilterNode[];
}

export type FilterNode = FilterGroup | PropertyCondition | AssociationCondition;

export const isGroup = (node: FilterNode): node is FilterGroup =>
  typeof (node as FilterGroup).op === 'string' && Array.isArray((node as FilterGroup).filters);
export const isAssociationCondition = (node: FilterNode): node is AssociationCondition =>
  !isGroup(node) && typeof (node as AssociationCondition).association === 'string';

export interface SortSpec { property: string; direction?: 'asc' | 'desc' }

export interface ViewDef {
  object: 'view';
  id: string;
  object_type: string;
  name: string;
  description: string | null;
  columns: string[];
  filter: FilterNode | null;
  sort: SortSpec[];
  shared: boolean;
  owner_id: string | null;
  is_default: boolean;
  system: boolean;
  position: number;
}

export interface TimelineItem {
  object: 'timeline_item';
  id: string;
  kind: 'activity' | 'property_change' | 'event' | 'association';
  at: number;
  cursor: string;
  title: string;
  body: string | null;
  icon: string;
  actor_id: string | null;
  actor_type: string;
  record_id: string;
  via: { id: string; object_type: string; display_name: string } | null;
  data: Record<string, unknown>;
}

export interface SimilarMatch {
  record: CrmRecord;
  score: number;
  reasons: string[];
}

export interface WorkspaceUser {
  id: string;
  name: string;
  email: string;
  title: string | null;
  role: string;
  avatar_url: string | null;
}

export interface CrmSchema {
  object_types: Pick<ObjectTypeDef, 'name' | 'label' | 'plural_label' | 'icon' | 'color' | 'category' | 'primary_property' | 'secondary_property'>[];
  association_types: AssociationTypeDef[];
  pipelines: {
    object_type: string; name: string; label: string; is_default: boolean; stage_property: string;
    stages: { name: string; label: string; probability: number; is_closed: boolean; is_won: boolean }[];
  }[];
  operators: FilterOperator[];
  record_fields: string[];
  relative_dates: string[];
  expression_functions: string[];
}

export interface BatchResult {
  object: 'batch_result';
  created: number;
  updated: number;
  errors: number;
  has_errors: boolean;
  results: { index: number; status: 'created' | 'updated' | 'error'; id?: string; display_name?: string; error?: { message: string; param?: string } }[];
}

export interface MergeResult {
  winner: CrmRecord;
  properties_filled: string[];
  associations_moved: number;
  activities_moved?: number;
}

/* --------------------------- write notifications -------------------------- */

/**
 * The list view reads through `POST …/search`, which no GET cache can hold, so
 * a write has to say so out loud. `crmChanged()` bumps a counter every screen
 * in this module watches — and also clears the kernel's GET cache, so the
 * record page, the dashboard cards and the nav counts move together.
 */
let writeVersion = 0;
const writeListeners = new Set<() => void>();
const subscribeWrites = (fn: () => void): (() => void) => { writeListeners.add(fn); return () => { writeListeners.delete(fn); }; };

export function crmChanged(...prefixes: string[]): void {
  writeVersion += 1;
  invalidate('/v1/records', '/v1/objects', '/v1/views', '/v1/associations', '/v1/crm/', ...prefixes);
  for (const listener of [...writeListeners]) listener();
}

export const useCrmVersion = (): number =>
  useSyncExternalStore(subscribeWrites, () => writeVersion, () => 0);

/* --------------------------------- reads ---------------------------------- */

export interface SearchBody {
  filter?: FilterNode;
  query?: string;
  sort?: SortSpec[];
  properties?: string[];
  limit?: number;
  after?: string;
  include_archived?: boolean;
  associated_to?: string;
  expand?: string[];
}

export interface SearchPage extends ListEnvelope<CrmRecord> { total_count: number }

export interface SearchState {
  rows: CrmRecord[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  /**
   * The rows and the count on hand answer a different request than the one the
   * screen is now asking. True from the render that changes the query, before
   * the effect that starts the fetch has even run — which is what lets a
   * "Show 48 companies" button stop quoting a number it is about to disprove.
   */
  stale: boolean;
  /** True while more pages are being appended, so the grid keeps its rows. */
  loadingMore: boolean;
  error: ApiClientError | null;
  refetch: () => void;
  loadMore: () => void;
}

/**
 * The list surface, paged on the engine's own cursor. Every page after the
 * first is appended rather than replacing what is on screen, because an
 * operator who has scrolled 200 rows into an account list and asked for more
 * has not asked to go back to the top.
 */
export function useRecordSearch(objectType: string | null, body: SearchBody): SearchState {
  const version = useCrmVersion();
  const key = objectType ? `${objectType}:${JSON.stringify(body)}:${version}` : null;
  const [state, setState] = useState<{ rows: CrmRecord[]; total: number; cursor: string | null; hasMore: boolean; key: string | null }>(
    { rows: [], total: 0, cursor: null, hasMore: false, key: null },
  );
  const [loading, setLoading] = useState(!!objectType);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const run = useRef(0);

  useEffect(() => {
    if (!objectType || !key) { setLoading(false); return; }
    const id = ++run.current;
    setLoading(true);
    setError(null);
    api.post<SearchPage>(`/v1/records/${objectType}/search`, body)
      .then((page) => {
        if (run.current !== id) return;
        setState({ rows: page.data, total: page.total_count ?? page.data.length, cursor: page.next_cursor, hasMore: page.has_more, key });
        setError(null);
      })
      .catch((e: ApiClientError) => { if (run.current === id) { setError(e); setState({ rows: [], total: 0, cursor: null, hasMore: false, key }); } })
      .finally(() => { if (run.current === id) setLoading(false); });
    return () => { /* a newer run invalidates this one through `run` */ };
    // `key` folds the object type, the whole request body and the write counter
    // into one dependency, which is what stops an inline object literal in the
    // caller from refetching on every keystroke elsewhere on the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const loadMore = useCallback(() => {
    if (!objectType || !state.cursor || loadingMore) return;
    const id = run.current;
    setLoadingMore(true);
    api.post<SearchPage>(`/v1/records/${objectType}/search`, { ...body, after: state.cursor })
      .then((page) => {
        if (run.current !== id) return;
        setState((prev) => ({
          ...prev,
          rows: [...prev.rows, ...page.data],
          total: page.total_count ?? prev.total,
          cursor: page.next_cursor,
          hasMore: page.has_more,
        }));
      })
      .catch((e: ApiClientError) => { if (run.current === id) setError(e); })
      .finally(() => { if (run.current === id) setLoadingMore(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectType, state.cursor, loadingMore, key]);

  return {
    rows: state.rows,
    total: state.total,
    hasMore: state.hasMore,
    loading,
    stale: !!key && state.key !== key,
    loadingMore,
    error,
    refetch: () => setAttempt((n) => n + 1),
    loadMore,
  };
}

/** Every page of a search, up to a cap — what an export has to read. */
export async function fetchAllRecords(objectType: string, body: SearchBody, cap = 5000): Promise<CrmRecord[]> {
  const rows: CrmRecord[] = [];
  let after: string | undefined;
  for (let page = 0; page < 60 && rows.length < cap; page++) {
    const result = await api.post<SearchPage>(`/v1/records/${objectType}/search`, { ...body, limit: 200, after });
    rows.push(...result.data);
    if (!result.has_more || !result.next_cursor) break;
    after = result.next_cursor;
  }
  return rows.slice(0, cap);
}

export interface PropertiesEnvelope extends ListEnvelope<PropertyDef> { groups: string[] }

export function useObjectTypes() {
  return useQuery<ListEnvelope<ObjectTypeDef>>('/v1/objects');
}
export function useProperties(objectType: string | null) {
  return useQuery<PropertiesEnvelope>(objectType ? `/v1/objects/${objectType}/properties` : null);
}
export function useSchema() {
  return useQuery<CrmSchema>('/v1/crm/schema');
}
export function useViews(objectType: string | null) {
  return useQuery<ListEnvelope<ViewDef>>('/v1/views', objectType ? { object_type: objectType } : undefined);
}
export function useUsers() {
  return useQuery<ListEnvelope<WorkspaceUser>>('/v1/users');
}
export function useRecord(objectType: string | null, id: string | null) {
  return useQuery<CrmRecord>(objectType && id ? `/v1/records/${objectType}/${id}` : null);
}
export function useSimilar(objectType: string | null, id: string | null) {
  return useQuery<ListEnvelope<SimilarMatch>>(objectType && id ? `/v1/records/${objectType}/${id}/similar` : null, { limit: 5 });
}
export function useAssociationTypes() {
  return useQuery<ListEnvelope<AssociationTypeDef>>('/v1/association-types');
}

/* -------------------------------- indexes --------------------------------- */

export function useUserIndex(users: WorkspaceUser[] | undefined): Map<string, WorkspaceUser> {
  return useMemo(() => {
    const map = new Map<string, WorkspaceUser>();
    for (const user of users ?? []) map.set(user.id, user);
    return map;
  }, [users]);
}

/* -------------------------------- writes ---------------------------------- */

export const createRecord = (objectType: string, properties: Record<string, unknown>, ownerId?: string | null, associateTo?: string[]) =>
  api.post<CrmRecord>(`/v1/records/${objectType}`, {
    properties,
    ...(ownerId !== undefined ? { owner_id: ownerId } : {}),
    ...(associateTo?.length ? { associate_to: associateTo } : {}),
  });

export const patchRecord = (objectType: string, id: string, patch: { properties?: Record<string, unknown>; owner_id?: string | null }) =>
  api.patch<CrmRecord>(`/v1/records/${objectType}/${id}`, patch);

export const archiveRecord = (objectType: string, id: string) =>
  api.del<void>(`/v1/records/${objectType}/${id}`);

/** The irreversible one. Archiving is the default everywhere else for a reason. */
export const destroyRecord = (objectType: string, id: string) =>
  api.del<void>(`/v1/records/${objectType}/${id}?permanent=true`);

export const restoreRecord = (objectType: string, id: string) =>
  api.post<CrmRecord>(`/v1/records/${objectType}/${id}/restore`);

export const batchUpdate = (objectType: string, records: { id: string; properties: Record<string, unknown>; owner_id?: string | null }[]) =>
  api.post<BatchResult>(`/v1/records/${objectType}/batch`, { operation: 'update', records });

export const logActivity = (objectType: string, id: string, input: {
  type: 'note' | 'call' | 'meeting' | 'email' | 'task';
  subject?: string; body?: string; occurred_at?: number;
  properties?: Record<string, unknown>; also_associate_to?: string[];
}) => api.post<CrmRecord>(`/v1/records/${objectType}/${id}/activities`, input);

export const associate = (input: { from_id: string; to_id: string; association_type?: string; primary?: boolean }) =>
  api.post<{ id: string }>('/v1/associations', input);

export const disassociate = (associationId: string) => api.del<void>(`/v1/associations/${associationId}`);

export const mergeRecords = (objectType: string, winnerId: string, fromId: string) =>
  api.post<MergeResult>(`/v1/records/${objectType}/${winnerId}/merge`, { from_id: fromId });

export const saveView = (input: { object_type: string; name: string; description?: string; columns: string[]; filter?: FilterNode | null; sort?: SortSpec[]; shared?: boolean }) =>
  api.post<ViewDef>('/v1/views', { ...input, filter: input.filter ?? undefined });

export const updateView = (id: string, patch: Partial<Pick<ViewDef, 'name' | 'description' | 'columns' | 'sort' | 'shared' | 'is_default'>> & { filter?: FilterNode | null }) =>
  api.patch<ViewDef>(`/v1/views/${id}`, patch);

export const deleteView = (id: string) => api.del<void>(`/v1/views/${id}`);

export const createObjectType = (input: {
  name: string; label: string; plural_label: string; description?: string; icon?: string; color?: string; primary_property?: string;
}) => api.post<ObjectTypeDef>('/v1/objects', input);

export const updateObjectType = (name: string, patch: {
  label?: string; plural_label?: string; description?: string; icon?: string; color?: string;
  primary_property?: string; secondary_property?: string; searchable?: string[];
}) => api.patch<ObjectTypeDef>(`/v1/objects/${name}`, patch);

/** Refused by the server while any record of the type still exists. */
export const deleteObjectType = (name: string) => api.del<void>(`/v1/objects/${name}`);

export interface PropertyInput {
  name: string;
  label: string;
  type: PropertyType;
  description?: string;
  group?: string;
  options?: PropertyOption[];
  reference_type?: string;
  required?: boolean;
  unique?: boolean;
  calculated?: string;
  rollup?: PropertyRollup;
  currency?: string;
}

export const createProperty = (objectType: string, input: PropertyInput) =>
  api.post<PropertyDef & { records_recalculated?: number }>(`/v1/objects/${objectType}/properties`, input);

export const updateProperty = (objectType: string, name: string, patch: Record<string, unknown>) =>
  api.patch<PropertyDef>(`/v1/objects/${objectType}/properties/${name}`, patch);

export const deleteProperty = (objectType: string, name: string) =>
  api.del<void>(`/v1/objects/${objectType}/properties/${name}`);

export const createAssociationType = (input: {
  name: string; from_object: string; to_object: string; label: string; inverse_label: string; cardinality?: string;
}) => api.post<AssociationTypeDef>('/v1/association-types', input);

/* -------------------------------- timeline -------------------------------- */

export interface TimelinePage extends ListEnvelope<TimelineItem> { next_page: string | null }

export interface TimelineState {
  items: TimelineItem[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: ApiClientError | null;
  refetch: () => void;
  loadMore: () => void;
}

export function useTimeline(objectType: string | null, id: string | null, kinds: string[], rollUp: boolean): TimelineState {
  const version = useCrmVersion();
  const kindKey = [...kinds].sort().join(',');
  const key = objectType && id ? `${objectType}/${id}:${kindKey}:${rollUp}:${version}` : null;
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(!!key);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const run = useRef(0);

  const query = useMemo(() => ({
    limit: 30,
    roll_up: rollUp,
    ...(kindKey ? { kinds: kindKey } : {}),
  }), [kindKey, rollUp]);

  useEffect(() => {
    if (!objectType || !id || !key) { setLoading(false); return; }
    const runId = ++run.current;
    setLoading(true);
    setError(null);
    api.get<TimelinePage>(`/v1/records/${objectType}/${id}/timeline`, query)
      .then((page) => {
        if (run.current !== runId) return;
        setItems(page.data);
        setCursor(page.next_cursor);
        setHasMore(page.has_more);
      })
      .catch((e: ApiClientError) => { if (run.current === runId) { setError(e); setItems([]); } })
      .finally(() => { if (run.current === runId) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const loadMore = useCallback(() => {
    if (!objectType || !id || !cursor || loadingMore) return;
    const runId = run.current;
    setLoadingMore(true);
    api.get<TimelinePage>(`/v1/records/${objectType}/${id}/timeline`, { ...query, after: cursor })
      .then((page) => {
        if (run.current !== runId) return;
        setItems((prev) => [...prev, ...page.data]);
        setCursor(page.next_cursor);
        setHasMore(page.has_more);
      })
      .catch((e: ApiClientError) => { if (run.current === runId) setError(e); })
      .finally(() => { if (run.current === runId) setLoadingMore(false); });
  }, [objectType, id, cursor, loadingMore, query]);

  return { items, loading, loadingMore, hasMore, error, refetch: () => setAttempt((n) => n + 1), loadMore };
}
