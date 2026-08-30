import {
  useCallback, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { cx } from './layout';
import { ChevronDownIcon, ChevronsUpDownIcon, FilterXIcon, Icons } from './icons';
import { Button, Checkbox, SegmentedControl } from './controls';
import { Input, SearchInput, Select } from './fields';
import { Calendar } from './datepicker';
import { RANGE_PRESETS, startOfMonthUtc, type DateRange } from './calendar-core';
import { Menu, MenuButton, Popover, type MenuSection } from './overlays';
import { EmptyState, ErrorState, Skeleton } from './feedback';
import { formatNumber, humanize, useFormat } from './format';
import { useDocumentDensity, useIsomorphicLayoutEffect, useVirtualRows } from './hooks';
import { DAY, startOfDay } from '../../shared/time';
import {
  activeFilterCount, dateExtent, describeFilter, extendSelection, filterRows,
  isFilterEmpty, rangeBetween, searchRows, selectionState, sortRows, splitSelection, sumColumn,
  toggleId, toggleSort, valueCounts,
  type CellValue, type ColumnFilter, type DateOperator, type FilterKind, type FilterMap,
  type NumberOperator, type SortState, type TableState, type TextOperator,
} from './table-core';
import './table.css';

export type Density = 'comfortable' | 'compact';
const ROW_HEIGHT: Record<Density, number> = { comfortable: 42, compact: 34 };

/** Enum-shaped values get the same humanising the cells use, so the filter
 *  never shows `past_due` next to a badge reading "Past due". */
const defaultOptionLabel = (value: string): string => (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(value) ? humanize(value) : value);

export interface DataTableColumn<T> {
  id: string;
  header: ReactNode;
  /** The sortable, filterable, searchable value. Keep it primitive. */
  accessor?: (row: T) => CellValue;
  /** The rendered cell. Defaults to the accessor's value. */
  cell?: (row: T) => ReactNode;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  /**
   * Adds this column to the filter menu. `text` is a contains-match, `set` a
   * multi-select of the distinct values, `number` a range and `date` a
   * calendar with the shared range presets.
   */
  filter?: FilterKind;
  /** Renders a raw `set` value the way the column's cells render it. */
  filterOptionLabel?: (value: string) => string;
  /** Property name used in the filter menu and chips. Defaults to the header. */
  filterLabel?: string;
  /** Excluded from the free-text search box. */
  unsearchable?: boolean;
  /** Sticky first column — set on exactly one column. */
  pinned?: boolean;
  /** Sum this column in the sticky footer, formatted by this function. */
  total?: (rows: T[], sum: number) => ReactNode;
  hideable?: boolean;
  defaultHidden?: boolean;
  headerTitle?: string;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: DataTableColumn<T>[];
  getRowId: (row: T) => string;
  caption?: string;
  loading?: boolean;
  error?: { message?: string; requestId?: string | null; code?: string | null } | null;
  onRetry?: () => void;
  empty?: ReactNode;
  /** Rendered instead of the default empty state when filters hid everything. */
  emptyFiltered?: ReactNode;
  onRowClick?: (row: T) => void;
  rowActions?: (row: T) => MenuSection[];
  rowTone?: (row: T) => 'default' | 'danger';
  selectable?: boolean;
  selected?: string[];
  onSelectionChange?: (ids: string[]) => void;
  /**
   * Receives only the selected rows the current filter still shows, unless the
   * operator has explicitly opted into the hidden ones from the bulk bar.
   */
  bulkActions?: (ids: string[]) => ReactNode;
  /** Extra controls on the left of the toolbar, before search. */
  toolbar?: ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  initialSort?: SortState | null;
  /**
   * Controlled query + sort + filter stack. Hand it to a route and serialise it
   * with `encodeTableState` and the filtered grid becomes a shareable link.
   */
  value?: TableState;
  onChange?: (state: TableState) => void;
  density?: Density;
  onDensityChange?: (density: Density) => void;
  showDensityToggle?: boolean;
  showColumnToggle?: boolean;
  showFilters?: boolean;
  stickyFooter?: boolean;
  maxHeight?: number | string;
  /** Rows past this count are windowed; below it everything renders. */
  virtualiseAfter?: number;
  plain?: boolean;
  /** Footer strip under the table: counts, pagination, exports. */
  footer?: ReactNode;
  className?: string;
}

const defaultAccessor = <T,>(column: DataTableColumn<T>) => (row: T): CellValue => {
  if (column.accessor) return column.accessor(row);
  const value = (row as Record<string, unknown>)[column.id];
  return (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined)
    ? value
    : String(value ?? '');
};

const columnLabel = <T,>(column: DataTableColumn<T>): string =>
  column.filterLabel ?? column.headerTitle ?? (typeof column.header === 'string' ? column.header : column.id);

const KIND_ICON: Record<FilterKind, keyof typeof Icons> = {
  text: 'file-text', set: 'list', number: 'hash', date: 'calendar',
};

const emptyFilterFor = (kind: FilterKind): ColumnFilter => {
  if (kind === 'text') return { kind: 'text', value: '', op: 'contains' };
  if (kind === 'set') return { kind: 'set', values: [], op: 'any_of' };
  if (kind === 'number') return { kind: 'number', op: 'between' };
  return { kind: 'date', op: 'between' };
};

export function DataTable<T>({
  rows, columns, getRowId, caption, loading, error, onRetry, empty, emptyFiltered,
  onRowClick, rowActions, rowTone, selectable, selected, onSelectionChange, bulkActions,
  toolbar, searchable = true, searchPlaceholder = 'Search this table…', initialSort = null,
  value, onChange,
  density: densityProp, onDensityChange, showDensityToggle = true, showColumnToggle = true,
  showFilters = true, stickyFooter = true, maxHeight = 560, virtualiseAfter = 120, plain, footer, className,
}: DataTableProps<T>) {
  const [internalState, setInternalState] = useState<TableState>(() => ({ query: '', sort: initialSort, filters: {} }));
  const state = value ?? internalState;
  const { query, sort, filters } = state;
  const commitState = useCallback((next: TableState) => {
    if (value === undefined) setInternalState(next);
    onChange?.(next);
  }, [value, onChange]);

  const setQuery = useCallback((next: string) => commitState({ ...state, query: next }), [commitState, state]);
  const setSort = useCallback((next: SortState | null) => commitState({ ...state, sort: next }), [commitState, state]);
  const setFilters = useCallback((next: FilterMap) => commitState({ ...state, filters: next }), [commitState, state]);
  const setFilter = useCallback((columnId: string, filter: ColumnFilter | undefined) => {
    const next = { ...state.filters };
    if (filter) next[columnId] = filter; else delete next[columnId];
    commitState({ ...state, filters: next });
  }, [commitState, state]);
  const clearAll = useCallback(() => commitState({ ...state, query: '', filters: {} }), [commitState, state]);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openFilterId, setOpenFilterId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  /**
   * A chip the operator has added but not yet filled in. It deliberately lives
   * outside `filters` — an empty filter matches everything, so committing one
   * would put a no-op in the shared URL.
   */
  const [draft, setDraft] = useState<{ columnId: string; filter: ColumnFilter } | null>(null);
  const [internalDensity, setInternalDensity] = useState<Density | null>(null);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(
    () => new Set(columns.filter((c) => c.defaultHidden).map((c) => c.id)),
  );
  const [internalSelected, setInternalSelected] = useState<string[]>([]);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const [scrolledX, setScrolledX] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const columnsAnchor = useRef<HTMLButtonElement>(null);
  const addAnchor = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const workspaceDensity = useDocumentDensity();
  // The workspace setting wins until someone overrides it for this table.
  const density = densityProp ?? internalDensity ?? workspaceDensity;
  const setDensity = onDensityChange ?? setInternalDensity;
  const selection = selected ?? internalSelected;
  const setSelection = onSelectionChange ?? setInternalSelected;
  const selectionAnchor = useRef<string | null>(null);

  const accessors = useMemo(() => {
    const map = new Map<string, (row: T) => CellValue>();
    for (const column of columns) map.set(column.id, defaultAccessor(column));
    return map;
  }, [columns]);

  const accessor = useCallback(
    (row: T, columnId: string): CellValue => accessors.get(columnId)?.(row) ?? null,
    [accessors],
  );

  const visibleColumns = useMemo(() => columns.filter((c) => !hiddenColumns.has(c.id)), [columns, hiddenColumns]);
  const searchableIds = useMemo(() => columns.filter((c) => !c.unsearchable).map((c) => c.id), [columns]);
  const filterableColumns = useMemo(() => columns.filter((c) => c.filter), [columns]);

  const processed = useMemo(() => {
    let out = rows;
    if (query) out = searchRows(out, query, searchableIds, accessor);
    out = filterRows(out, filters, accessor);
    out = sortRows(out, sort, accessor);
    return out;
  }, [rows, query, searchableIds, filters, sort, accessor]);

  const visibleIds = useMemo(() => processed.map(getRowId), [processed, getRowId]);
  const selectState = selectionState(selection, visibleIds);
  const filterCount = activeFilterCount(filters);
  const filtersActive = filterCount > 0 || !!query;
  const chipFilters = useMemo<[string, ColumnFilter][]>(() => {
    const entries = Object.entries(filters).filter(([, f]) => f) as [string, ColumnFilter][];
    if (draft && !entries.some(([id]) => id === draft.columnId)) entries.push([draft.columnId, draft.filter]);
    return entries;
  }, [filters, draft]);

  const split = useMemo(() => splitSelection(selection, visibleIds), [selection, visibleIds]);
  const actionableIds = includeHidden ? selection : split.visible;

  // Opting into hidden rows is scoped to the filter that was on screen when the
  // operator agreed to it; changing the filter revokes the consent.
  useEffect(() => { setIncludeHidden(false); }, [filters, query]);

  // Rows can be taller than the density constant when a cell stacks two lines,
  // so the window is driven by the height actually rendered, not the guess.
  const [measuredRow, setMeasuredRow] = useState<number | null>(null);
  useIsomorphicLayoutEffect(() => {
    const row = bodyRef.current?.querySelector<HTMLElement>('tr[data-index]');
    const height = row?.offsetHeight ?? 0;
    if (height > 0 && height !== measuredRow) setMeasuredRow(height);
  });
  const rowHeight = measuredRow ?? ROW_HEIGHT[density];
  const virtual = useVirtualRows(scrollRef, {
    count: processed.length, rowHeight, overscan: 8, threshold: virtualiseAfter,
  });

  useEffect(() => { setFocusIndex(-1); }, [query, sort, filters]);
  useEffect(() => { setMeasuredRow(null); }, [density]);

  const toggleRow = (id: string, shiftKey: boolean) => {
    if (shiftKey && selectionAnchor.current) {
      const run = rangeBetween(visibleIds, selectionAnchor.current, id);
      setSelection([...new Set([...selection, ...run])]);
    } else {
      setSelection(toggleId(selection, id));
    }
    selectionAnchor.current = id;
  };

  const toggleAll = () => {
    if (selectState === 'all') setSelection(selection.filter((id) => !visibleIds.includes(id)));
    else setSelection([...new Set([...selection, ...visibleIds])]);
  };

  const addFilter = (columnId: string, kind: FilterKind) => {
    if (isFilterEmpty(filters[columnId])) setDraft({ columnId, filter: emptyFilterFor(kind) });
    setFiltersOpen(true);
    setAddOpen(false);
    setOpenFilterId(columnId);
  };

  /** An edit that empties a chip parks it as a draft rather than dropping it
   *  under the operator's cursor. */
  const changeFilter = (columnId: string, next: ColumnFilter) => {
    if (isFilterEmpty(next)) {
      setDraft({ columnId, filter: next });
      if (filters[columnId]) setFilter(columnId, undefined);
    } else {
      setDraft(null);
      setFilter(columnId, next);
    }
  };

  const removeFilter = (columnId: string) => {
    setOpenFilterId(null);
    if (draft?.columnId === columnId) setDraft(null);
    if (filters[columnId]) setFilter(columnId, undefined);
  };

  /** Closing an editor that was never filled in removes its chip again. */
  const closeEditor = (columnId: string) => {
    setOpenFilterId(null);
    if (draft?.columnId === columnId) setDraft(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTableSectionElement>) => {
    if (!processed.length) return;
    const moveTo = (next: number) => {
      setFocusIndex(next);
      virtual.scrollToIndex(next);
      if (e.shiftKey && selectable) {
        const targetId = getRowId(processed[next]);
        if (!selectionAnchor.current) {
          selectionAnchor.current = focusIndex >= 0 ? getRowId(processed[focusIndex]) : targetId;
        }
        setSelection(extendSelection(selection, visibleIds, selectionAnchor.current, targetId));
      }
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); moveTo(Math.min(processed.length - 1, focusIndex + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveTo(Math.max(0, focusIndex - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); moveTo(0); virtual.scrollToIndex(0, 'start'); }
    else if (e.key === 'End') { e.preventDefault(); moveTo(processed.length - 1); }
    else if (e.key === 'Enter' && focusIndex >= 0) { e.preventDefault(); onRowClick?.(processed[focusIndex]); }
    else if (e.key === ' ' && focusIndex >= 0 && selectable) { e.preventDefault(); toggleRow(getRowId(processed[focusIndex]), e.shiftKey); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && selectable) { e.preventDefault(); setSelection([...new Set([...selection, ...visibleIds])]); }
    else if (e.key === 'Escape' && selection.length) { setSelection([]); selectionAnchor.current = null; }
  };

  useEffect(() => {
    if (focusIndex < 0) return;
    const row = bodyRef.current?.querySelector<HTMLTableRowElement>(`[data-index="${focusIndex}"]`);
    row?.focus({ preventScroll: true });
  }, [focusIndex, virtual.startIndex]);

  const windowRows = virtual.virtualised ? processed.slice(virtual.startIndex, virtual.endIndex) : processed;
  const columnCount = visibleColumns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);
  const hasTotals = stickyFooter && visibleColumns.some((c) => c.total);
  const showFilterBar = showFilters && filterableColumns.length > 0 && (filtersOpen || chipFilters.length > 0);

  const addSections: MenuSection[] = useMemo(() => [{
    id: 'properties',
    label: 'Filter by property',
    items: filterableColumns.map((column) => {
      const Icon = Icons[KIND_ICON[column.filter as FilterKind]];
      return {
        id: column.id,
        label: columnLabel(column),
        searchText: columnLabel(column),
        icon: <Icon size={14} />,
        checked: !isFilterEmpty(filters[column.id]) ? true : undefined,
        onSelect: () => addFilter(column.id, column.filter as FilterKind),
      };
    }),
  }], [filterableColumns, filters, state]);

  return (
    <div
      className={cx('ain-table-wrap', plain && 'ain-table-wrap--plain', className)}
      style={{ ['--row-height' as string]: `${rowHeight}px` }}
    >
      {(toolbar || searchable || showDensityToggle || showColumnToggle || showFilters) && (
        <div className="ain-table__bar">
          {toolbar}
          {searchable && (
            <SearchInput
              value={query}
              onChange={setQuery}
              size="sm"
              placeholder={searchPlaceholder}
              wrapperClassName="ain-search"
              aria-label="Search table rows"
            />
          )}
          <span className="u-spacer" />
          {filtersActive && (
            <Button
              size="sm"
              variant="ghost"
              iconLeft={<FilterXIcon size={14} />}
              onClick={clearAll}
            >
              Clear
            </Button>
          )}
          {showFilters && filterableColumns.length > 0 && (
            <Button
              size="sm"
              variant={showFilterBar ? 'secondary' : 'ghost'}
              iconLeft={<Icons.filter size={14} />}
              aria-pressed={showFilterBar}
              aria-label={filterCount ? `Filters, ${filterCount} active` : 'Filters'}
              onClick={() => { setFiltersOpen((v) => !v); setOpenFilterId(null); }}
            >
              Filters
              {filterCount > 0 && <span className="ain-table__filtercount">{filterCount}</span>}
            </Button>
          )}
          {showColumnToggle && (
            <>
              <Button
                ref={columnsAnchor}
                size="sm"
                variant="ghost"
                iconLeft={<Icons.columns size={14} />}
                aria-haspopup="dialog"
                aria-expanded={columnsOpen}
                onClick={() => setColumnsOpen((v) => !v)}
              >
                Columns
              </Button>
              <Popover
                open={columnsOpen}
                onClose={() => setColumnsOpen(false)}
                anchor={columnsAnchor}
                placement="bottom-end"
                title="Visible columns"
                flush
              >
                <div className="ain-table__colmenu">
                  {columns.map((column) => (
                    <label className="ain-table__colitem" key={column.id}>
                      <Checkbox
                        checked={!hiddenColumns.has(column.id)}
                        disabled={column.hideable === false || column.pinned}
                        onChange={(checked) => setHiddenColumns((prev) => {
                          const next = new Set(prev);
                          if (checked) next.delete(column.id);
                          else next.add(column.id);
                          return next;
                        })}
                        label={column.headerTitle ?? (typeof column.header === 'string' ? column.header : column.id)}
                      />
                    </label>
                  ))}
                </div>
              </Popover>
            </>
          )}
          {showDensityToggle && (
            <SegmentedControl
              size="sm"
              aria-label="Row density"
              value={density}
              onChange={(d) => setDensity(d)}
              options={[
                { value: 'comfortable', label: <Icons.list size={14} />, title: 'Comfortable rows' },
                { value: 'compact', label: <Icons.menu size={14} />, title: 'Compact rows' },
              ]}
            />
          )}
        </div>
      )}

      {showFilterBar && (
        <div className="ain-table__bar ain-table__bar--filters" role="group" aria-label="Active filters">
          {chipFilters.map(([columnId, filter]) => {
            const column = columns.find((c) => c.id === columnId);
            if (!column) return null;
            return (
              <FilterChip
                key={columnId}
                column={column}
                rows={rows}
                accessor={accessor}
                filter={filter}
                open={openFilterId === columnId}
                onOpen={() => setOpenFilterId(columnId)}
                onClose={() => closeEditor(columnId)}
                onChange={(next) => changeFilter(columnId, next)}
                onRemove={() => removeFilter(columnId)}
              />
            );
          })}
          <Button
            ref={addAnchor}
            size="sm"
            variant="ghost"
            className="ain-table__addfilter"
            iconLeft={<Icons.plus size={13} />}
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => setAddOpen((v) => !v)}
          >
            Filter
          </Button>
          <Menu
            open={addOpen}
            onClose={() => setAddOpen(false)}
            anchor={addAnchor}
            sections={addSections}
            ariaLabel="Add a filter"
            placement="bottom-start"
          />
          {filterCount > 0 && (
            <>
              <span className="u-spacer" />
              <Button size="sm" variant="ghost" iconLeft={<FilterXIcon size={13} />} onClick={() => { setDraft(null); setOpenFilterId(null); setFilters({}); }}>
                Clear filters
              </Button>
            </>
          )}
        </div>
      )}

      {selectable && selection.length > 0 && (
        <div className="ain-table__bulk" role="region" aria-label="Bulk actions">
          <span className="ain-table__bulkcount">
            {formatNumber(selection.length)} selected
            {split.hidden.length > 0 && (
              <span className="ain-table__bulkhidden">
                {' · '}{formatNumber(split.hidden.length)} not shown
              </span>
            )}
          </span>
          {split.hidden.length > 0 && (
            <>
              {(includeHidden || split.visible.length > 0) && (
                <span className="ain-table__bulknote">
                  {includeHidden
                    ? `Actions apply to all ${formatNumber(selection.length)}, including rows this filter hides.`
                    : `Actions apply to the ${formatNumber(split.visible.length)} in view.`}
                </span>
              )}
              <Button size="sm" variant="ghost" onClick={() => { setSelection(split.visible); setIncludeHidden(false); }}>
                Drop hidden
              </Button>
              <Button size="sm" variant="ghost" aria-pressed={includeHidden} onClick={() => setIncludeHidden((v) => !v)}>
                {includeHidden ? 'Only the ones in view' : `Include all ${formatNumber(selection.length)}`}
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => { setSelection([]); setIncludeHidden(false); selectionAnchor.current = null; }}>Clear</Button>
          <span className="u-spacer" />
          {actionableIds.length > 0
            ? bulkActions?.(actionableIds)
            : <span className="ain-table__bulknote">Nothing selected is in view — drop the hidden rows or clear the filter.</span>}
        </div>
      )}

      <div
        className="ain-table__scroll"
        ref={scrollRef}
        style={{ maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight }}
        onScroll={(e) => setScrolledX(e.currentTarget.scrollLeft > 0)}
      >
        <table
          className={cx('ain-table', columns.some((c) => c.pinned) && 'ain-table--pinned', scrolledX && 'ain-table--scrolled')}
          aria-rowcount={processed.length}
        >
          {caption && <caption className="u-visually-hidden">{caption}</caption>}
          <colgroup>
            {selectable && <col style={{ width: 40 }} />}
            {visibleColumns.map((column) => (
              <col key={column.id} style={{ width: typeof column.width === 'number' ? `${column.width}px` : column.width }} />
            ))}
            {rowActions && <col style={{ width: 44 }} />}
          </colgroup>
          <thead>
            <tr>
              {selectable && (
                <th className="ain-table__selectcell is-pinned" scope="col">
                  <Checkbox
                    checked={selectState === 'all'}
                    indeterminate={selectState === 'some'}
                    onChange={toggleAll}
                    aria-label={selectState === 'all' ? 'Deselect all rows' : 'Select all rows'}
                  />
                </th>
              )}
              {visibleColumns.map((column) => {
                const sorted = sort?.columnId === column.id;
                const SortIcon = sorted && sort?.direction === 'desc' ? Icons['arrow-down'] : Icons['arrow-up'];
                return (
                  <th
                    key={column.id}
                    scope="col"
                    className={cx(column.align === 'right' && 'is-numeric', column.align === 'center' && 'is-center', column.pinned && 'is-pinned')}
                    aria-sort={sorted ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                    title={column.headerTitle}
                  >
                    {column.sortable === false ? (
                      <span className="u-truncate">{column.header}</span>
                    ) : (
                      <button
                        type="button"
                        className={cx('ain-table__sortbtn', sorted && 'is-sorted')}
                        onClick={() => setSort(toggleSort(sort, column.id))}
                      >
                        <span className="u-truncate">{column.header}</span>
                        <span className="ain-table__sortic">
                          {sorted ? <SortIcon size={12} /> : <ChevronsUpDownIcon size={12} />}
                        </span>
                      </button>
                    )}
                  </th>
                );
              })}
              {rowActions && <th className="ain-table__actioncell" scope="col"><span className="u-visually-hidden">Row actions</span></th>}
            </tr>
          </thead>

          <tbody ref={bodyRef} onKeyDown={onKeyDown}>
            {loading && rows.length === 0 && Array.from({ length: 8 }, (_, i) => (
              <tr className="ain-table__skelrow" key={`skeleton-${i}`}>
                {selectable && <td className="ain-table__selectcell"><Skeleton width={14} height={14} /></td>}
                {visibleColumns.map((column, index) => (
                  <td key={column.id} className={cx(column.align === 'right' && 'is-numeric', column.pinned && 'is-pinned')}>
                    <Skeleton width={index === 0 ? '62%' : `${34 + ((i * 13 + index * 17) % 40)}%`} height={10} />
                  </td>
                ))}
                {rowActions && <td className="ain-table__actioncell" />}
              </tr>
            ))}

            {!loading && virtual.paddingTop > 0 && <tr aria-hidden style={{ height: virtual.paddingTop }}><td colSpan={columnCount} style={{ padding: 0, border: 'none', height: virtual.paddingTop }} /></tr>}

            {!loading && !error && windowRows.map((row, i) => {
              const index = (virtual.virtualised ? virtual.startIndex : 0) + i;
              const id = getRowId(row);
              const isSelected = selection.includes(id);
              return (
                <tr
                  key={id}
                  data-index={index}
                  aria-rowindex={index + 1}
                  aria-selected={selectable ? isSelected : undefined}
                  tabIndex={index === focusIndex ? 0 : -1}
                  className={cx(
                    onRowClick && 'is-clickable',
                    isSelected && 'is-selected',
                    index === focusIndex && 'is-focused',
                    rowTone?.(row) === 'danger' && 'is-danger',
                  )}
                  onFocus={() => setFocusIndex(index)}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('button, a, input, label, [role="menuitem"]')) return;
                    onRowClick?.(row);
                  }}
                >
                  {selectable && (
                    <td className="ain-table__selectcell is-pinned">
                      <Checkbox
                        checked={isSelected}
                        aria-label={`Select row ${index + 1}`}
                        onChange={(_, e) => toggleRow(id, (e.nativeEvent as MouseEvent).shiftKey)}
                      />
                    </td>
                  )}
                  {visibleColumns.map((column) => (
                    <td
                      key={column.id}
                      className={cx(column.align === 'right' && 'is-numeric', column.align === 'center' && 'is-center', column.pinned && 'is-pinned')}
                    >
                      {column.cell ? column.cell(row) : renderValue(accessor(row, column.id))}
                    </td>
                  ))}
                  {rowActions && (
                    <td className="ain-table__actioncell">
                      <MenuButton
                        className="ain-table__rowmenu"
                        size="sm"
                        label="Row actions"
                        sections={rowActions(row)}
                        placement="bottom-end"
                      />
                    </td>
                  )}
                </tr>
              );
            })}

            {!loading && virtual.paddingBottom > 0 && <tr aria-hidden style={{ height: virtual.paddingBottom }}><td colSpan={columnCount} style={{ padding: 0, border: 'none', height: virtual.paddingBottom }} /></tr>}

            {!loading && error && (
              <tr>
                <td colSpan={columnCount} className="ain-table__state">
                  <ErrorState
                    message={error.message}
                    requestId={error.requestId}
                    code={error.code}
                    action={onRetry ? <Button variant="secondary" iconLeft={<Icons.refresh size={14} />} onClick={onRetry}>Try again</Button> : undefined}
                  />
                </td>
              </tr>
            )}

            {!loading && !error && processed.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="ain-table__state">
                  {filtersActive
                    ? (emptyFiltered ?? (
                      <EmptyState
                        size="sm"
                        illustration={null}
                        title="No rows match those filters"
                        body="Loosen a filter or clear the search to see the full list again."
                        action={<Button variant="secondary" size="sm" iconLeft={<FilterXIcon size={14} />} onClick={clearAll}>Clear filters</Button>}
                      />
                    ))
                    : (empty ?? <EmptyState title="Nothing here yet" body="Rows will appear as soon as there is data to show." />)}
                </td>
              </tr>
            )}
          </tbody>

          {hasTotals && processed.length > 0 && !error && (
            <tfoot>
              <tr>
                {selectable && <td className="ain-table__selectcell is-pinned" />}
                {visibleColumns.map((column) => (
                  <td
                    key={column.id}
                    className={cx(column.align === 'right' && 'is-numeric', column.align === 'center' && 'is-center', column.pinned && 'is-pinned')}
                  >
                    {column.total ? column.total(processed, sumColumn(processed, column.id, accessor)) : null}
                  </td>
                ))}
                {rowActions && <td className="ain-table__actioncell" />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {(footer || processed.length > 0) && (
        <div className="ain-table__pager">
          <span className="ain-table__count">
            {processed.length === rows.length
              ? `${formatNumber(rows.length)} ${rows.length === 1 ? 'row' : 'rows'}`
              : `${formatNumber(processed.length)} of ${formatNumber(rows.length)} rows`}
            {selection.length > 0 && ` · ${formatNumber(selection.length)} selected`}
            {split.hidden.length > 0 && ` (${formatNumber(split.hidden.length)} outside this filter)`}
          </span>
          {footer}
        </div>
      )}
    </div>
  );
}

function renderValue(value: CellValue): ReactNode {
  if (value === null || value === undefined || value === '') return <span style={{ color: 'var(--text-placeholder)' }}>—</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return formatNumber(value, { maxDecimals: 2 });
  return value;
}

/* ========================================================================== *
 * Filter chips — property → operator → value, the way Stripe and Linear read
 * ========================================================================== */

function FilterChip<T>({
  column, rows, accessor, filter, open, onOpen, onClose, onChange, onRemove,
}: {
  column: DataTableColumn<T>;
  rows: T[];
  accessor: (row: T, columnId: string) => CellValue;
  filter: ColumnFilter;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (filter: ColumnFilter) => void;
  onRemove: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const fmt = useFormat();
  const label = columnLabel(column);
  const optionLabel = column.filterOptionLabel ?? defaultOptionLabel;
  const summary = isFilterEmpty(filter)
    ? 'any'
    : describeFilter(filter, {
      optionLabel,
      formatDate: (ts) => fmt.date(ts, { timeZone: 'UTC' }),
      formatNumber: (v) => formatNumber(v),
    });

  return (
    <span className={cx('ain-chip', !isFilterEmpty(filter) && 'is-set', open && 'is-open')}>
      <button
        ref={anchor}
        type="button"
        className="ain-chip__main"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? onClose() : onOpen())}
      >
        <span className="ain-chip__prop">{label}</span>
        <span className="ain-chip__value u-truncate">{summary}</span>
        <ChevronDownIcon size={12} className="ain-chip__caret" />
      </button>
      <button type="button" className="ain-chip__remove" aria-label={`Remove the ${label} filter`} onClick={onRemove}>
        <Icons.x size={12} />
      </button>
      <Popover
        open={open}
        onClose={onClose}
        anchor={anchor}
        placement="bottom-start"
        title={label}
        flush
        ariaLabel={`${label} filter`}
      >
        <FilterEditor
          column={column}
          rows={rows}
          accessor={accessor}
          filter={filter}
          onChange={onChange}
          onDone={onClose}
          optionLabel={optionLabel}
        />
      </Popover>
    </span>
  );
}

function FilterEditor<T>({
  column, rows, accessor, filter, onChange, onDone, optionLabel,
}: {
  column: DataTableColumn<T>;
  rows: T[];
  accessor: (row: T, columnId: string) => CellValue;
  filter: ColumnFilter;
  onChange: (filter: ColumnFilter) => void;
  onDone: () => void;
  optionLabel: (value: string) => string;
}) {
  if (filter.kind === 'set') {
    return <SetEditor column={column} rows={rows} accessor={accessor} filter={filter} onChange={onChange} onDone={onDone} optionLabel={optionLabel} />;
  }
  if (filter.kind === 'date') {
    return <DateEditor column={column} rows={rows} accessor={accessor} filter={filter} onChange={onChange} onDone={onDone} />;
  }
  if (filter.kind === 'number') {
    return <NumberEditor filter={filter} label={columnLabel(column)} onChange={onChange} onDone={onDone} />;
  }
  return <TextEditor filter={filter} label={columnLabel(column)} onChange={onChange} onDone={onDone} />;
}

function EditorFooter({ onClear, onDone, clearLabel = 'Clear' }: { onClear: () => void; onDone: () => void; clearLabel?: string }) {
  return (
    <div className="ain-filtered__foot">
      <Button size="sm" variant="ghost" onClick={onClear}>{clearLabel}</Button>
      <span className="u-spacer" />
      <Button size="sm" variant="secondary" onClick={onDone}>Done</Button>
    </div>
  );
}

function SetEditor<T>({
  column, rows, accessor, filter, onChange, onDone, optionLabel,
}: {
  column: DataTableColumn<T>;
  rows: T[];
  accessor: (row: T, columnId: string) => CellValue;
  filter: Extract<ColumnFilter, { kind: 'set' }>;
  onChange: (filter: ColumnFilter) => void;
  onDone: () => void;
  optionLabel: (value: string) => string;
}) {
  const [search, setSearch] = useState('');
  const options = useMemo(() => valueCounts(rows, column.id, accessor), [rows, column.id, accessor]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => optionLabel(o.value).toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
  }, [options, search, optionLabel]);
  const selectedSet = new Set(filter.values);

  const toggle = (value: string) => {
    const next = selectedSet.has(value) ? filter.values.filter((v) => v !== value) : [...filter.values, value];
    onChange({ ...filter, values: next });
  };

  return (
    <div className="ain-filtered">
      <div className="ain-filtered__ops">
        <SegmentedControl
          size="sm"
          aria-label="Match"
          value={filter.op ?? 'any_of'}
          onChange={(op) => onChange({ ...filter, op })}
          options={[{ value: 'any_of', label: 'is any of' }, { value: 'none_of', label: 'is none of' }]}
        />
      </div>
      {options.length > 7 && (
        <div className="ain-filtered__search">
          <SearchInput value={search} onChange={setSearch} size="sm" placeholder={`Find a ${columnLabel(column).toLowerCase()}…`} aria-label="Find an option" />
        </div>
      )}
      <div className="ain-filtered__list" role="group" aria-label={`${columnLabel(column)} values`}>
        {shown.length === 0 && <p className="ain-filtered__none">No value matches “{search.trim()}”.</p>}
        {shown.map((option) => (
          <div className="ain-filtered__opt" key={option.value}>
            <Checkbox checked={selectedSet.has(option.value)} onChange={() => toggle(option.value)} label={optionLabel(option.value)} />
            <span className="ain-filtered__count">{formatNumber(option.count)}</span>
          </div>
        ))}
      </div>
      <EditorFooter
        onClear={() => onChange({ ...filter, values: [] })}
        onDone={onDone}
        clearLabel={filter.values.length ? `Clear ${filter.values.length}` : 'Clear'}
      />
    </div>
  );
}

const DATE_OPS: { value: DateOperator; label: string }[] = [
  { value: 'between', label: 'is between' },
  { value: 'after', label: 'is after' },
  { value: 'before', label: 'is before' },
  { value: 'is', label: 'is on' },
];

function DateEditor<T>({
  column, rows, accessor, filter, onChange, onDone,
}: {
  column: DataTableColumn<T>;
  rows: T[];
  accessor: (row: T, columnId: string) => CellValue;
  filter: Extract<ColumnFilter, { kind: 'date' }>;
  onChange: (filter: ColumnFilter) => void;
  onDone: () => void;
}) {
  const fmt = useFormat();
  const op = filter.op ?? 'between';
  const extent = useMemo(() => dateExtent(rows, column.id, accessor), [rows, column.id, accessor]);
  const anchorDay = op === 'after' && filter.from !== undefined ? filter.from - DAY
    : op === 'before' && filter.to !== undefined ? filter.to + DAY
      : filter.from ?? filter.to ?? null;
  const [month, setMonth] = useState(() => startOfMonthUtc(anchorDay ?? extent?.max ?? fmt.now()));
  const [hover, setHover] = useState<number | null>(null);

  const range: DateRange = { start: filter.from ?? null, end: filter.to ?? null };

  const setOp = (next: DateOperator) => {
    // Carry the day the operator was pointing at across the switch.
    const day = anchorDay;
    if (day === null) { onChange({ kind: 'date', op: next }); return; }
    if (next === 'after') onChange({ kind: 'date', op: next, from: day + DAY });
    else if (next === 'before') onChange({ kind: 'date', op: next, to: day - DAY });
    else if (next === 'is') onChange({ kind: 'date', op: next, from: day, to: day });
    else onChange({ kind: 'date', op: next, from: day, to: undefined });
  };

  const pick = (ts: number) => {
    const day = startOfDay(ts);
    if (op === 'after') { onChange({ kind: 'date', op, from: day + DAY }); return; }
    if (op === 'before') { onChange({ kind: 'date', op, to: day - DAY }); return; }
    if (op === 'is') { onChange({ kind: 'date', op, from: day, to: day }); return; }
    if (filter.from === undefined || filter.to !== undefined) {
      onChange({ kind: 'date', op, from: day, to: undefined });
    } else if (day < filter.from) {
      onChange({ kind: 'date', op, from: day, to: filter.from });
    } else {
      onChange({ kind: 'date', op, from: filter.from, to: day });
    }
  };

  return (
    <div className="ain-filtered ain-filtered--date">
      <div className="ain-filtered__ops">
        <Select
          size="sm"
          aria-label="Date operator"
          value={op}
          onChange={(v) => setOp(v as DateOperator)}
          options={DATE_OPS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </div>
      {op === 'between' && (
        <div className="ain-filtered__presets">
          {RANGE_PRESETS.map((preset) => {
            const r = preset.range(fmt.now());
            const active = filter.from === r.start && filter.to === r.end;
            return (
              <button
                key={preset.id}
                type="button"
                className={cx('ain-filtered__preset', active && 'is-active')}
                onClick={() => onChange({ kind: 'date', op: 'between', from: r.start ?? undefined, to: r.end ?? undefined })}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      )}
      <Calendar
        month={month}
        onMonthChange={setMonth}
        value={op === 'between' ? null : anchorDay}
        range={op === 'between' ? range : undefined}
        hoverTs={hover}
        onHover={setHover}
        onSelect={pick}
        locale={fmt.locale}
        today={fmt.now()}
      />
      <div className="ain-filtered__hint">
        {isFilterEmpty(filter)
          ? (op === 'between' ? 'Pick a start date, then an end date.' : 'Pick a date.')
          : describeFilter(filter, { formatDate: (ts) => fmt.date(ts, { timeZone: 'UTC' }) })}
      </div>
      <EditorFooter onClear={() => onChange({ kind: 'date', op })} onDone={onDone} />
    </div>
  );
}

const NUMBER_OPS: { value: NumberOperator; label: string }[] = [
  { value: 'between', label: 'is between' },
  { value: 'gte', label: 'is at least' },
  { value: 'lte', label: 'is at most' },
  { value: 'eq', label: 'is exactly' },
];

function NumberEditor({
  filter, label, onChange, onDone,
}: {
  filter: Extract<ColumnFilter, { kind: 'number' }>;
  label: string;
  onChange: (filter: ColumnFilter) => void;
  onDone: () => void;
}) {
  const op = filter.op ?? 'between';
  const num = (raw: string): number | undefined => (raw === '' ? undefined : Number(raw));
  return (
    <div className="ain-filtered">
      <div className="ain-filtered__ops">
        <Select
          size="sm"
          aria-label={`${label} operator`}
          value={op}
          onChange={(v) => {
            const next = v as NumberOperator;
            const seed = filter.min ?? filter.max;
            if (next === 'gte') onChange({ kind: 'number', op: next, min: seed });
            else if (next === 'lte') onChange({ kind: 'number', op: next, max: seed });
            else if (next === 'eq') onChange({ kind: 'number', op: next, min: seed, max: seed });
            else onChange({ kind: 'number', op: next, min: filter.min, max: filter.max });
          }}
          options={NUMBER_OPS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </div>
      <div className="ain-filtered__row">
        {(op === 'between' || op === 'gte') && (
          <Input
            size="sm" type="number" placeholder={op === 'between' ? 'From' : 'Minimum'}
            value={filter.min ?? ''} aria-label={`Minimum ${label}`}
            onChange={(e) => onChange({ ...filter, op, min: num(e.target.value) })}
          />
        )}
        {(op === 'between' || op === 'lte') && (
          <Input
            size="sm" type="number" placeholder={op === 'between' ? 'To' : 'Maximum'}
            value={filter.max ?? ''} aria-label={`Maximum ${label}`}
            onChange={(e) => onChange({ ...filter, op, max: num(e.target.value) })}
          />
        )}
        {op === 'eq' && (
          <Input
            size="sm" type="number" placeholder="Value"
            value={filter.min ?? ''} aria-label={`${label} equals`}
            onChange={(e) => { const n = num(e.target.value); onChange({ kind: 'number', op, min: n, max: n }); }}
          />
        )}
      </div>
      <EditorFooter onClear={() => onChange({ kind: 'number', op })} onDone={onDone} />
    </div>
  );
}

const TEXT_OPS: { value: TextOperator; label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'is', label: 'is exactly' },
  { value: 'starts_with', label: 'starts with' },
];

function TextEditor({
  filter, label, onChange, onDone,
}: {
  filter: Extract<ColumnFilter, { kind: 'text' }>;
  label: string;
  onChange: (filter: ColumnFilter) => void;
  onDone: () => void;
}) {
  return (
    <div className="ain-filtered">
      <div className="ain-filtered__ops">
        <Select
          size="sm"
          aria-label={`${label} operator`}
          value={filter.op ?? 'contains'}
          onChange={(v) => onChange({ ...filter, op: v as TextOperator })}
          options={TEXT_OPS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </div>
      <div className="ain-filtered__row">
        <Input
          size="sm"
          autoFocus
          placeholder={`${label}…`}
          aria-label={`Filter by ${label}`}
          value={filter.value}
          onChange={(e) => onChange({ ...filter, value: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') onDone(); }}
        />
      </div>
      <EditorFooter onClear={() => onChange({ ...filter, value: '' })} onDone={onDone} />
    </div>
  );
}
