/**
 * Sorting, filtering, selection and URL-serialisation maths for the DataTable.
 * Pure and generic so the same rules can be unit-tested and reused by list
 * views that do not want the full table chrome.
 */
import { DAY, startOfDay } from '../../shared/time';

export type SortDirection = 'asc' | 'desc';
export interface SortState { columnId: string; direction: SortDirection }

export type CellValue = string | number | boolean | null | undefined | Date;

/**
 * Strip diacritics and case so a US keyboard finds "Nina Kovač" by typing
 * "kovac". `compareValues` already sorts with `sensitivity: 'base'`; searching
 * and text filtering fold the same way so the system is consistent about it.
 */
export function fold(input: string): string {
  return input.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * One comparison for every kind of cell we render. Blanks always sink to the
 * bottom regardless of direction — an empty cell is never "the smallest value".
 */
export function compareValues(a: CellValue, b: CellValue): number {
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  if (typeof av === 'boolean' || typeof bv === 'boolean') return Number(av) - Number(bv);
  return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
}

const isBlank = (v: CellValue): boolean => v === null || v === undefined || v === '';

export function sortRows<T>(rows: T[], sort: SortState | null, accessor: (row: T, columnId: string) => CellValue): T[] {
  if (!sort) return rows;
  const factor = sort.direction === 'asc' ? 1 : -1;
  // Stable: decorate with the original index so equal keys keep their order.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const av = accessor(a.row, sort.columnId);
      const bv = accessor(b.row, sort.columnId);
      // Blanks sink to the bottom whichever way the column is sorted — an empty
      // cell is missing information, not the smallest value.
      const aBlank = isBlank(av);
      const bBlank = isBlank(bv);
      if (aBlank !== bBlank) return aBlank ? 1 : -1;
      const result = compareValues(av, bv);
      return result !== 0 ? result * factor : a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** asc → desc → unsorted, the cycle every data grid worth using implements. */
export function toggleSort(current: SortState | null, columnId: string): SortState | null {
  if (!current || current.columnId !== columnId) return { columnId, direction: 'asc' };
  if (current.direction === 'asc') return { columnId, direction: 'desc' };
  return null;
}

/* ========================================================================== *
 * Filters — a typed stack, one entry per property, each with its own operator
 * ========================================================================== */

export type TextOperator = 'contains' | 'not_contains' | 'is' | 'starts_with';
export type NumberOperator = 'between' | 'gte' | 'lte' | 'eq';
export type DateOperator = 'between' | 'after' | 'before' | 'is';
export type SetOperator = 'any_of' | 'none_of';

export type ColumnFilter =
  | { kind: 'text'; value: string; op?: TextOperator }
  | { kind: 'set'; values: string[]; op?: SetOperator }
  | { kind: 'number'; min?: number; max?: number; op?: NumberOperator }
  /** `from`/`to` are inclusive day boundaries in UTC, matching `shared/time`. */
  | { kind: 'date'; from?: number; to?: number; op?: DateOperator };

export type FilterKind = ColumnFilter['kind'];

export type FilterMap = Record<string, ColumnFilter | undefined>;

/** A filter with no payload matches everything, so it is not worth keeping. */
export function isFilterEmpty(filter: ColumnFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.kind === 'text') return filter.value.trim() === '';
  if (filter.kind === 'set') return filter.values.length === 0;
  if (filter.kind === 'number') return filter.min === undefined && filter.max === undefined;
  return filter.from === undefined && filter.to === undefined;
}

/** How many chips the "Filters" button should be badged with. */
export function activeFilterCount(filters: FilterMap): number {
  return Object.values(filters).filter((f) => !isFilterEmpty(f)).length;
}

export function activeFilters(filters: FilterMap): [string, ColumnFilter][] {
  return Object.entries(filters).filter(([, f]) => !isFilterEmpty(f)) as [string, ColumnFilter][];
}

const toTimestamp = (value: CellValue): number | null => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

export function matchesFilter(value: CellValue, filter: ColumnFilter): boolean {
  if (filter.kind === 'text') {
    const needle = fold(filter.value.trim());
    if (!needle) return true;
    const hay = fold(String(value ?? ''));
    switch (filter.op ?? 'contains') {
      case 'not_contains': return !hay.includes(needle);
      case 'is': return hay === needle;
      case 'starts_with': return hay.startsWith(needle);
      default: return hay.includes(needle);
    }
  }
  if (filter.kind === 'set') {
    if (!filter.values.length) return true;
    const present = filter.values.includes(String(value ?? ''));
    return (filter.op ?? 'any_of') === 'none_of' ? !present : present;
  }
  if (filter.kind === 'date') {
    if (filter.from === undefined && filter.to === undefined) return true;
    const ts = toTimestamp(value);
    if (ts === null) return false;
    const day = startOfDay(ts);
    if (filter.from !== undefined && day < startOfDay(filter.from)) return false;
    // `to` is inclusive: the whole of that calendar day counts as inside.
    if (filter.to !== undefined && day > startOfDay(filter.to)) return false;
    return true;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return false;
  if (filter.min !== undefined && numeric < filter.min) return false;
  if (filter.max !== undefined && numeric > filter.max) return false;
  return true;
}

export function filterRows<T>(rows: T[], filters: FilterMap, accessor: (row: T, columnId: string) => CellValue): T[] {
  const active = activeFilters(filters);
  if (!active.length) return rows;
  return rows.filter((row) => active.every(([columnId, filter]) => matchesFilter(accessor(row, columnId), filter)));
}

/** Free-text search across the columns the caller marks as searchable. */
export function searchRows<T>(rows: T[], query: string, columnIds: string[], accessor: (row: T, columnId: string) => CellValue): T[] {
  const q = fold(query.trim());
  if (!q) return rows;
  return rows.filter((row) => columnIds.some((id) => fold(String(accessor(row, id) ?? '')).includes(q)));
}

/* ------------------------- describing a filter chip ----------------------- */

export interface FilterLabelOptions {
  /** Turns a raw cell value into the label the column's cells already show. */
  optionLabel?: (value: string) => string;
  /** Formats a day timestamp; defaults to an ISO date so it is never locale-wrong. */
  formatDate?: (ts: number) => string;
  /** Formats a number for the `number` kind. */
  formatNumber?: (value: number) => string;
}

const isoDay = (ts: number): string => new Date(startOfDay(ts)).toISOString().slice(0, 10);

/**
 * The right-hand half of a chip: "is any of Open, Past due", "is after 1 Jul".
 * Kept here (not in the component) so the same phrasing can be unit-tested and
 * reused by saved-view summaries.
 */
export function describeFilter(filter: ColumnFilter, o: FilterLabelOptions = {}): string {
  const label = o.optionLabel ?? ((v: string) => v);
  const date = o.formatDate ?? isoDay;
  const num = o.formatNumber ?? ((v: number) => String(v));
  if (filter.kind === 'text') {
    const verb = filter.op === 'not_contains' ? 'does not contain'
      : filter.op === 'is' ? 'is'
        : filter.op === 'starts_with' ? 'starts with' : 'contains';
    return `${verb} “${filter.value.trim()}”`;
  }
  if (filter.kind === 'set') {
    const names = filter.values.map(label);
    const shown = names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
    return `${filter.op === 'none_of' ? 'is none of' : 'is'} ${shown}`;
  }
  if (filter.kind === 'date') {
    if (filter.from !== undefined && filter.to !== undefined) {
      return startOfDay(filter.from) === startOfDay(filter.to)
        ? `is ${date(filter.from)}`
        : `is ${date(filter.from)} – ${date(filter.to)}`;
    }
    if (filter.from !== undefined) return `is after ${date(filter.from - DAY)}`;
    if (filter.to !== undefined) return `is before ${date(filter.to + DAY)}`;
    return 'is any date';
  }
  if (filter.min !== undefined && filter.max !== undefined) {
    return filter.min === filter.max ? `is ${num(filter.min)}` : `is ${num(filter.min)} – ${num(filter.max)}`;
  }
  if (filter.min !== undefined) return `is at least ${num(filter.min)}`;
  if (filter.max !== undefined) return `is at most ${num(filter.max)}`;
  return 'is any value';
}

/* ------------------------- URL / share serialisation ---------------------- */

export interface TableState {
  query: string;
  sort: SortState | null;
  filters: FilterMap;
}

export const EMPTY_TABLE_STATE: TableState = { query: '', sort: null, filters: {} };

const esc = (s: string): string => s.replace(/([\\,;~])/g, '\\$1');
const splitEscaped = (s: string, sep: string): string[] => {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) { current += s[++i]; continue; }
    if (ch === sep) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out;
};

const numOrUndef = (raw: string): number | undefined => {
  if (raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * `status~set~any_of~open,past_due;issuedAt~date~between~1719792000000,1727740800000`
 *
 * Readable enough to eyeball in a URL bar, short enough to paste into Slack,
 * and lossless — `decodeFilters(encodeFilters(f))` is `f`.
 */
export function encodeFilters(filters: FilterMap): string {
  return activeFilters(filters)
    .map(([columnId, filter]) => {
      const head = `${esc(columnId)}~${filter.kind}~${filter.op ?? ''}`;
      if (filter.kind === 'text') return `${head}~${esc(filter.value.trim())}`;
      if (filter.kind === 'set') return `${head}~${filter.values.map(esc).join(',')}`;
      if (filter.kind === 'number') return `${head}~${filter.min ?? ''},${filter.max ?? ''}`;
      return `${head}~${filter.from ?? ''},${filter.to ?? ''}`;
    })
    .join(';');
}

export function decodeFilters(raw: string): FilterMap {
  const out: FilterMap = {};
  if (!raw) return out;
  for (const part of splitEscaped(raw, ';')) {
    if (!part) continue;
    const [columnId, kind, op, payload = ''] = splitEscaped(part, '~');
    if (!columnId || !kind) continue;
    if (kind === 'text') {
      const value = payload;
      if (value.trim()) out[columnId] = { kind: 'text', value, ...(op ? { op: op as TextOperator } : {}) };
    } else if (kind === 'set') {
      const values = splitEscaped(payload, ',').filter(Boolean);
      if (values.length) out[columnId] = { kind: 'set', values, ...(op ? { op: op as SetOperator } : {}) };
    } else if (kind === 'number') {
      const [min, max] = splitEscaped(payload, ',');
      const filter: ColumnFilter = { kind: 'number', min: numOrUndef(min ?? ''), max: numOrUndef(max ?? ''), ...(op ? { op: op as NumberOperator } : {}) };
      if (!isFilterEmpty(filter)) out[columnId] = filter;
    } else if (kind === 'date') {
      const [from, to] = splitEscaped(payload, ',');
      const filter: ColumnFilter = { kind: 'date', from: numOrUndef(from ?? ''), to: numOrUndef(to ?? ''), ...(op ? { op: op as DateOperator } : {}) };
      if (!isFilterEmpty(filter)) out[columnId] = filter;
    }
  }
  return out;
}

export const encodeSort = (sort: SortState | null): string => (sort ? `${sort.columnId}:${sort.direction}` : '');

export function decodeSort(raw: string): SortState | null {
  if (!raw) return null;
  const [columnId, direction] = raw.split(':');
  if (!columnId) return null;
  return { columnId, direction: direction === 'desc' ? 'desc' : 'asc' };
}

/** The three query parameters a host route writes to make a view shareable. */
export function encodeTableState(state: TableState): { q?: string; sort?: string; filter?: string } {
  const q = state.query.trim();
  const sort = encodeSort(state.sort);
  const filter = encodeFilters(state.filters);
  return { q: q || undefined, sort: sort || undefined, filter: filter || undefined };
}

export function decodeTableState(params: { q?: string; sort?: string; filter?: string }): TableState {
  return {
    query: params.q ?? '',
    sort: decodeSort(params.sort ?? ''),
    filters: decodeFilters(params.filter ?? ''),
  };
}

export const tableStateIsEmpty = (state: TableState): boolean =>
  !state.query.trim() && state.sort === null && activeFilterCount(state.filters) === 0;

/* ================================ selection =============================== */

export type SelectionState = 'none' | 'some' | 'all';

export function selectionState(selected: ReadonlySet<string> | string[], visibleIds: string[]): SelectionState {
  const set = Array.isArray(selected) ? new Set(selected) : selected;
  if (!visibleIds.length || set.size === 0) return 'none';
  let count = 0;
  for (const id of visibleIds) if (set.has(id)) count++;
  if (count === 0) return 'none';
  return count === visibleIds.length ? 'all' : 'some';
}

export interface SelectionSplit {
  /** Selected rows the current filter still shows — what actions apply to. */
  visible: string[];
  /** Selected rows the current filter hides. The dangerous half. */
  hidden: string[];
}

/**
 * Selection outlives filtering, so a bulk action can otherwise reach rows the
 * operator cannot see. Splitting it is what lets the bar say "82 selected · 2
 * not shown" and keep Void off the two invisible ones.
 */
export function splitSelection(selected: string[], visibleIds: string[]): SelectionSplit {
  const shown = new Set(visibleIds);
  const visible: string[] = [];
  const hidden: string[] = [];
  for (const id of selected) (shown.has(id) ? visible : hidden).push(id);
  return { visible, hidden };
}

/** Shift-click and Shift+Arrow select the contiguous run between two rows. */
export function rangeBetween(ids: string[], anchorId: string, targetId: string): string[] {
  const a = ids.indexOf(anchorId);
  const b = ids.indexOf(targetId);
  if (a < 0 || b < 0) return [targetId];
  const [from, to] = a <= b ? [a, b] : [b, a];
  return ids.slice(from, to + 1);
}

/** Union of the current selection with the run from the anchor to the target. */
export function extendSelection(selected: string[], ids: string[], anchorId: string | null, targetId: string): string[] {
  if (!anchorId) return selected.includes(targetId) ? selected : [...selected, targetId];
  return [...new Set([...selected, ...rangeBetween(ids, anchorId, targetId)])];
}

export function toggleId(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

/** Column totals for the sticky footer: sums only over numeric cells. */
export function sumColumn<T>(rows: T[], columnId: string, accessor: (row: T, columnId: string) => CellValue): number {
  let total = 0;
  for (const row of rows) {
    const value = accessor(row, columnId);
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) total += numeric;
  }
  return total;
}

export function uniqueValues<T>(rows: T[], columnId: string, accessor: (row: T, columnId: string) => CellValue): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const value = accessor(row, columnId);
    if (value === null || value === undefined || value === '') continue;
    set.add(String(value));
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Distinct values with how many rows carry each — the counts a facet shows. */
export function valueCounts<T>(rows: T[], columnId: string, accessor: (row: T, columnId: string) => CellValue): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = accessor(row, columnId);
    if (value === null || value === undefined || value === '') continue;
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true }));
}

/** The span of a date column, used to bound the filter's calendar. */
export function dateExtent<T>(rows: T[], columnId: string, accessor: (row: T, columnId: string) => CellValue): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const ts = toTimestamp(accessor(row, columnId));
    if (ts === null) continue;
    if (ts < min) min = ts;
    if (ts > max) max = ts;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}
