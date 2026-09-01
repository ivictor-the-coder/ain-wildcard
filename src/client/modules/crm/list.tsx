/**
 * The object list — the screen a salesperson lives in.
 *
 * It is one component for every object type in the workspace, because the
 * object model is data: the columns, the filterable properties, the enum
 * colours and the create form all come from `/v1/objects/:type/properties`.
 * A custom object defined this morning gets this screen with no code.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Banner, Button, ConfirmDialog, DataTable, EmptyState, Icons, Inline, MenuButton, Modal,
  Page, Pill, SearchInput, Skeleton, Spinner, Tabs, Tooltip,
  FilterXIcon, RotateCcwIcon, humanize, useDebouncedValue, useFormat, useToast,
  type DataTableColumn, type Density, type MenuSection, type TableState,
} from '@/client/design';
import { useRouter } from '@/client/kernel/router';
import { useSession } from '@/client/kernel/session';
import type { ApiClientError } from '@/client/kernel/api';
import {
  archiveRecord, crmChanged, deleteView, fetchAllRecords, restoreRecord, updateView, useProperties,
  useRecordSearch, useSchema, useUserIndex, useUsers, useViews,
  type CrmRecord, type FilterNode, type ObjectTypeDef, type PropertyDef, type PropertyValue,
  type SortSpec, type ViewDef,
} from './api';
import { FilterBuilder, FilterSummary, RECORD_FIELDS, countConditions, filterableProperties, pruneFilter } from './filter-builder';
import { BulkLinkDialog, BulkOwnerDialog, BulkPropertyDialog, RecordFormDialog, SaveViewDialog } from './dialogs';
import { UserChip, ValueView, cellValue, exportValue } from './values';
import { downloadCsv, exportFilename, toCsv } from './csv';

/* --------------------------------- helpers -------------------------------- */

/** A record's value for a column id, whether it is a property or a record field. */
export function fieldValue(record: CrmRecord, name: string): PropertyValue {
  switch (name) {
    case 'id': return record.id;
    case 'display_name': return record.display_name;
    case 'owner_id': return record.owner_id;
    case 'source': return record.source;
    case 'archived': return record.archived;
    case 'created': case 'created_at': return record.created;
    case 'updated': case 'updated_at': return record.updated;
    case 'created_by': return record.created_by;
    case 'updated_by': return record.updated_by;
    default: return record.properties[name] ?? null;
  }
}

const RECORD_FIELD_INDEX = new Map(RECORD_FIELDS.map((f) => [f.name, f]));

export const definitionFor = (index: Map<string, PropertyDef>, name: string): PropertyDef | undefined =>
  index.get(name) ?? RECORD_FIELD_INDEX.get(name);

export const listHref = (objectType: string): string =>
  objectType === 'contact' ? '/contacts' : objectType === 'company' ? '/companies' : `/records/${objectType}`;

export const recordHref = (objectType: string, id: string): string => `${listHref(objectType)}/${id}`;

const defaultColumns = (objectDef: ObjectTypeDef, views: ViewDef[]): string[] => {
  const preferred = views.find((v) => v.is_default) ?? views[0];
  if (preferred?.columns.length) return preferred.columns;
  return [objectDef.primary_property, ...(objectDef.secondary_property ? [objectDef.secondary_property] : []), 'owner_id', 'updated'];
};

const sameFilter = (a: FilterNode | null, b: FilterNode | null): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* ------------------------------- url carriage ----------------------------- */

/**
 * "Look at this list" has to be a link. The search box, the filter tree and
 * the sort all ride in the query string beside `view`, so a reload, the back
 * button and a message to a teammate all land on the same rows — without
 * making anyone name and share a saved view for something they wanted to look
 * at for thirty seconds.
 */
export function encodeFilterParam(node: FilterNode | null | undefined): string {
  if (!node) return '';
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(node));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch {
    return '';
  }
}

/**
 * "The view's filter, deliberately turned off" is not the same state as "no
 * opinion", and only the second one should fall back to the view on reload.
 */
export const NONE = 'none';

export function decodeFilterParam(raw: string | undefined | null): FilterNode | null {
  if (!raw || raw === NONE) return null;
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' ? (parsed as FilterNode) : null;
  } catch {
    // A hand-edited or truncated link should show the list, not an error page.
    return null;
  }
}

export const encodeSortParam = (sort: SortSpec[]): string =>
  sort.map((s) => `${s.property}:${s.direction ?? 'desc'}`).join(',');

export const decodeSortParam = (raw: string | undefined | null): SortSpec[] =>
  (!raw || raw === NONE ? '' : raw)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [property, direction] = part.split(':');
      return { property, direction: direction === 'asc' ? 'asc' : 'desc' } satisfies SortSpec;
    })
    .filter((s) => !!s.property);

/* --------------------------- per-operator storage ------------------------- */

/**
 * Columns and row density are a glance, not a decision: adding "Founded" to
 * see one more field should survive a reload without forcing a naming-and-
 * sharing ceremony. They live per browser, keyed by object type and view, and
 * the saved view stays the default the moment the override is cleared.
 */
const prefKey = (kind: string, objectType: string, viewId: string | null | undefined): string =>
  `ain.crm.${kind}.${objectType}.${viewId || 'default'}`;

function readPref<T>(key: string, valid: (v: unknown) => v is T): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const writePref = (key: string, value: unknown): void => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};

const clearPref = (key: string): void => {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
};

const isColumnList = (v: unknown): v is string[] => Array.isArray(v) && v.every((c) => typeof c === 'string');
const isDensity = (v: unknown): v is Density => v === 'comfortable' || v === 'compact';

/** What the address bar asked for on the way in, consumed exactly once. */
interface LinkState {
  q: string;
  filter: FilterNode | null;
  hasFilter: boolean;
  sort: SortSpec[];
  hasSort: boolean;
  pending: boolean;
}

/* ------------------------------- the surface ------------------------------ */

export interface ObjectListPageProps {
  objectType: string;
}

export function ObjectListPage({ objectType }: ObjectListPageProps) {
  const { location, navigate, setQuery } = useRouter();
  const session = useSession();
  const toast = useToast();
  const f = useFormat();

  const objects = useProperties(objectType);
  const views = useViews(objectType);
  const schema = useSchema();
  const users = useUsers();
  const userIndex = useUserIndex(users.data?.data);

  const objectDef = useMemo<ObjectTypeDef | undefined>(
    () => schema.data?.object_types.find((t) => t.name === objectType) as ObjectTypeDef | undefined,
    [schema.data, objectType],
  );

  const properties = useMemo(() => objects.data?.data ?? [], [objects.data]);
  const propertyIndex = useMemo(() => new Map(properties.map((p) => [p.name, p])), [properties]);
  const viewList = useMemo(() => views.data?.data ?? [], [views.data]);

  /* -------- view + query state, seeded from the saved view in the URL ------- */

  const viewId = location.query.view ?? '';
  const activeView = useMemo(
    () => viewList.find((v) => v.id === viewId) ?? viewList.find((v) => v.is_default) ?? viewList[0] ?? null,
    [viewList, viewId],
  );

  // What the link that opened this page asked for. Decoded once — the view that
  // arrives a moment later must not quietly throw it away, and the query string
  // must not be re-parsed on every keystroke.
  const bootRef = useRef<LinkState | null>(null);
  if (!bootRef.current) {
    bootRef.current = {
      q: location.query.q ?? '',
      filter: decodeFilterParam(location.query.f),
      hasFilter: !!location.query.f,
      sort: decodeSortParam(location.query.s),
      hasSort: !!location.query.s,
      pending: true,
    };
  }
  const boot = bootRef.current;

  const [columns, setColumns] = useState<string[]>([]);
  const [columnsPinned, setColumnsPinned] = useState(false);
  const [density, setDensity] = useState<Density>('comfortable');
  const [filter, setFilter] = useState<FilterNode | null>(null);
  const [sort, setSort] = useState<SortSpec[]>([]);
  const [seeded, setSeeded] = useState<string>('');
  const [search, setSearch] = useState(boot.q);
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const query = useDebouncedValue(search, 250);

  const columnsKey = prefKey('columns', objectType, activeView?.id);
  const densityKey = prefKey('density', objectType, activeView?.id);

  // Seeding is keyed on the view, not run once: switching view replaces the
  // whole working state, which is what makes a view a view. It waits for the
  // view list so that a link's own filter is never seeded twice, the second
  // time from a view that had not loaded yet.
  const seedKey = `${objectType}:${activeView?.id ?? 'none'}`;
  useEffect(() => {
    if (!objectDef || views.loading || seeded === seedKey) return;
    const link = boot;
    const stored = readPref(columnsKey, isColumnList);
    setColumns(stored ?? (activeView?.columns.length ? activeView.columns : defaultColumns(objectDef, viewList)));
    setColumnsPinned(!!stored);
    setDensity(readPref(densityKey, isDensity) ?? 'comfortable');
    setFilter(link.pending && link.hasFilter ? link.filter : (activeView?.filter ?? null));
    setSort(link.pending && link.hasSort ? link.sort : (activeView?.sort ?? []));
    link.pending = false;
    setSelected([]);
    setSeeded(seedKey);
  }, [seedKey, seeded, activeView, objectDef, viewList, views.loading, columnsKey, densityKey]);

  /* ------------------------ mirror the state into the url ------------------ */

  const pruned = useMemo(() => pruneFilter(filter) ?? null, [filter]);

  // Only what differs from the view rides in the query string, so a plain
  // saved view is still `?view=…` and a link is as short as what it changed.
  const filterParam = useMemo(() => {
    const mine = encodeFilterParam(pruned);
    const theirs = encodeFilterParam(pruneFilter(activeView?.filter ?? null) ?? null);
    if (mine === theirs) return '';
    return mine || (theirs ? NONE : '');
  }, [pruned, activeView]);

  const sortParam = useMemo(() => {
    const mine = encodeSortParam(sort);
    const theirs = encodeSortParam(activeView?.sort ?? []);
    if (mine === theirs) return '';
    return mine || (theirs ? NONE : '');
  }, [sort, activeView]);

  // Creating a record navigates straight to it, and the write that did so also
  // wakes this list one last time. Without this guard that final tick stamped
  // the list's sort onto the *record's* address bar.
  const ownPath = listHref(objectType);
  useEffect(() => {
    if (!seeded) return;
    const here = window.location.pathname.replace(/\/+$/, '') || '/';
    if (location.path !== ownPath || here !== ownPath) return;
    const patch: Record<string, string | undefined> = {};
    if ((location.query.q ?? '') !== query.trim()) patch.q = query.trim() || undefined;
    if ((location.query.f ?? '') !== filterParam) patch.f = filterParam || undefined;
    if ((location.query.s ?? '') !== sortParam) patch.s = sortParam || undefined;
    if (Object.keys(patch).length) setQuery(patch);
  }, [seeded, query, filterParam, sortParam, location.path, location.query.q, location.query.f, location.query.s, ownPath, setQuery]);

  const chooseColumns = useCallback((next: string[]) => {
    setColumns(next);
    setColumnsPinned(true);
    writePref(columnsKey, next);
  }, [columnsKey]);

  const chooseDensity = useCallback((next: Density) => {
    setDensity(next);
    writePref(densityKey, next);
  }, [densityKey]);

  const dirty = !!activeView && (
    !sameFilter(pruned, pruneFilter(activeView.filter) ?? null)
    || JSON.stringify(columns) !== JSON.stringify(activeView.columns)
    || JSON.stringify(sort) !== JSON.stringify(activeView.sort)
  );

  /* -------------------------------- the read ------------------------------- */

  const body = useMemo(() => ({
    ...(pruned ? { filter: pruned } : {}),
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(sort.length ? { sort } : {}),
    ...(showArchived ? { include_archived: true } : {}),
    limit: 50,
  }), [pruned, query, sort, showArchived]);

  const result = useRecordSearch(objectDef ? objectType : null, body);

  /* --------------------------------- dialogs -------------------------------- */

  const [creating, setCreating] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [savingView, setSavingView] = useState<'new' | 'update' | null>(null);
  const [bulk, setBulk] = useState<'owner' | 'property' | 'link' | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string[] | null>(null);
  const [confirmDeleteView, setConfirmDeleteView] = useState<ViewDef | null>(null);
  const [exporting, setExporting] = useState(false);

  // The shell's create button lands here with ?new=1.
  useEffect(() => {
    if (location.query.new === '1') {
      setCreating(true);
      setQuery({ new: undefined });
    }
  }, [location.query.new, setQuery]);

  // A custom object's route can only name itself by its slug. Once the schema
  // has answered, the tab says what the workspace calls it. The router sets the
  // static route title from an effect above this one in the tree, so the
  // correction is queued behind that flush rather than racing it.
  useEffect(() => {
    if (!objectDef) return;
    let live = true;
    queueMicrotask(() => { if (live) document.title = `${objectDef.plural_label} · Ain`; });
    return () => { live = false; };
  }, [objectDef]);

  /* --------------------------------- columns -------------------------------- */

  const tableColumns = useMemo<DataTableColumn<CrmRecord>[]>(() => {
    if (!objectDef) return [];
    const primary = objectDef.primary_property;
    const built: DataTableColumn<CrmRecord>[] = [{
      id: primary,
      header: objectDef.label,
      headerTitle: objectDef.label,
      pinned: true,
      sortable: true,
      width: 260,
      accessor: (row) => row.display_name,
      cell: (row) => (
        <a
          className="crm-cell__link"
          href={recordHref(objectType, row.id)}
          onClick={(e) => { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); navigate(recordHref(objectType, row.id)); } }}
        >
          <span className="crm-cell__name u-truncate">{row.display_name}</span>
          {objectDef.secondary_property && !columns.includes(objectDef.secondary_property) && (
            <span className="crm-cell__sub u-truncate">
              <ValueView property={propertyIndex.get(objectDef.secondary_property)} value={row.properties[objectDef.secondary_property] ?? null} users={userIndex} compact />
            </span>
          )}
          {row.archived && <Badge tone="neutral" size="sm">Archived</Badge>}
        </a>
      ),
    }];

    for (const name of columns) {
      if (name === primary) continue;
      const property = definitionFor(propertyIndex, name);
      if (!property) continue;
      built.push({
        id: name,
        header: property.label,
        // A header narrow enough to truncate ("Connected as…") is unreadable
        // without this; the browser tooltip carries the whole label.
        headerTitle: property.description ? `${property.label} — ${property.description}` : property.label,
        sortable: true,
        align: property.type === 'currency' || property.type === 'number' ? 'right' : 'left',
        // A numeric column is only as wide as its digits, so a long label like
        // "Connected assets" truncated while the figures beside it had room to
        // spare. Sizing it to its own header — and no wider — reads the label
        // without taking the width the enum badges need to stay whole.
        width: property.type === 'text'
          ? 280
          : property.type === 'currency' || property.type === 'number'
            ? Math.min(164, Math.max(96, property.label.length * 7 + 38))
            : undefined,
        accessor: (row) => cellValue(property, fieldValue(row, name)),
        cell: (row) => (name === 'owner_id'
          ? <UserChip id={row.owner_id} user={row.owner_id ? userIndex.get(row.owner_id) : undefined} />
          : <ValueView property={property} value={fieldValue(row, name)} users={userIndex} compact />),
        ...(property.type === 'currency'
          ? { total: (rows: CrmRecord[]) => <span className="crm-num">{f.money(rows.reduce((n, r) => n + Number(fieldValue(r, name) ?? 0), 0), { currency: property.currency ?? session.currency })}</span> }
          : {}),
      });
    }
    return built;
  }, [objectDef, columns, propertyIndex, userIndex, objectType, navigate, f, session.currency]);

  const tableState = useMemo<TableState>(() => ({
    query: '',
    sort: sort.length ? { columnId: sort[0].property, direction: sort[0].direction ?? 'desc' } : null,
    filters: {},
  }), [sort]);

  const onTableState = useCallback((next: TableState) => {
    setSort(next.sort ? [{ property: next.sort.columnId, direction: next.sort.direction }] : []);
  }, []);

  /* --------------------------------- actions -------------------------------- */

  const restore = async (row: CrmRecord) => {
    try {
      await restoreRecord(objectType, row.id);
      crmChanged();
      toast.success('Record restored', `${row.display_name} is back in the list.`);
    } catch (e) {
      toast.error('Record not restored', (e as ApiClientError).body.message);
    }
  };

  const archive = async (ids: string[]) => {
    let done = 0;
    for (const id of ids) {
      try { await archiveRecord(objectType, id); done++; } catch { /* counted below */ }
    }
    crmChanged();
    setSelected([]);
    if (done === ids.length) toast.success(`${done} archived`, 'Archived records stay searchable and can be restored.');
    else toast.warning(`${done} of ${ids.length} archived`, 'The rest were refused — open one to see why.');
  };

  const exportCsv = async (ids?: string[]) => {
    setExporting(true);
    try {
      const rows = ids?.length
        ? result.rows.filter((r) => ids.includes(r.id))
        : await fetchAllRecords(objectType, body);
      const headers = ['id', ...columns.map((name) => definitionFor(propertyIndex, name)?.label ?? name)];
      const lines = rows.map((row) => [
        row.id,
        ...columns.map((name) => exportValue(definitionFor(propertyIndex, name), fieldValue(row, name), userIndex)),
      ]);
      downloadCsv(exportFilename(objectDef?.plural_label ?? objectType, session.now()), toCsv(headers, lines));
      toast.success(
        `${rows.length} rows exported`,
        'Picklists and owners carry the labels the grid shows; money is a decimal and dates are ISO-8601, ready to re-import.',
      );
    } catch (e) {
      toast.error('Export failed', (e as ApiClientError).body?.message ?? 'The server did not answer.');
    } finally {
      setExporting(false);
    }
  };

  const removeView = async (view: ViewDef) => {
    try {
      await deleteView(view.id);
      crmChanged('/v1/views');
      toast.success('View deleted', `“${view.name}” is gone. The records are untouched.`);
      setQuery({ view: undefined });
      setSeeded('');
    } catch (e) {
      toast.error('View not deleted', (e as ApiClientError).body.message);
    }
  };

  /* ---------------------------------- render -------------------------------- */

  if (schema.error || objects.error) {
    const error = schema.error ?? objects.error;
    return (
      <Page title={humanize(objectType)} subtitle="This list could not be assembled">
        <Banner
          tone="danger"
          title="The object model could not be read"
          actions={<Button size="sm" onClick={() => { schema.refetch(); objects.refetch(); }}>Try again</Button>}
        >
          {error?.body.message} {error?.body.request_id ? `· ${error.body.request_id}` : null}
        </Banner>
      </Page>
    );
  }

  if (!objectDef) {
    if (schema.loading) {
      return (
        <Page title={humanize(objectType)} subtitle="Reading the object model…">
          <div className="crm-boot"><Skeleton height={38} /><Skeleton height={38} /><Skeleton height={300} /></div>
        </Page>
      );
    }
    return (
      <Page title={humanize(objectType)}>
        <EmptyState
          title={`No object type called “${objectType}”`}
          body="It may have been renamed or deleted. The data model page lists every object this workspace actually has."
          action={<Button variant="primary" onClick={() => navigate('/records')}>Open the data model</Button>}
        />
      </Page>
    );
  }

  const conditions = countConditions(pruned);
  const selectedRows = result.rows.filter((r) => selected.includes(r.id));

  const viewMenu: MenuSection[] = [
    {
      id: 'view',
      label: activeView ? activeView.name : 'This view',
      items: [
        ...(dirty && activeView && !activeView.system
          ? [{ id: 'save', label: 'Save changes to this view', icon: <Icons.check size={14} />, onSelect: () => setSavingView('update') }]
          : []),
        { id: 'saveas', label: 'Save as a new view', icon: <Icons.plus size={14} />, onSelect: () => setSavingView('new') },
        ...(dirty
          ? [{
            id: 'reset',
            label: 'Discard my changes',
            icon: <RotateCcwIcon size={14} />,
            onSelect: () => { clearPref(columnsKey); setColumnsPinned(false); setSeeded(''); },
          }]
          : []),
        ...(activeView && !activeView.system
          ? [{
            id: 'default',
            label: activeView.is_default ? 'Already the default view' : 'Make it the default view',
            icon: <Icons.star size={14} />,
            disabled: activeView.is_default,
            onSelect: async () => {
              await updateView(activeView.id, { is_default: true });
              crmChanged('/v1/views');
              toast.success('Default view set', `${objectDef.plural_label} open on “${activeView.name}” now.`);
            },
          }]
          : []),
        ...(activeView && !activeView.system
          ? [{ id: 'delete', label: 'Delete this view', icon: <Icons.trash size={14} />, danger: true, onSelect: () => setConfirmDeleteView(activeView) }]
          : []),
      ],
    },
  ];

  const columnMenu: MenuSection[] = [
    {
      id: 'columns',
      label: columnsPinned ? 'Columns · kept on this browser' : 'Columns on this view',
      items: [...properties.filter((p) => !p.hidden), ...RECORD_FIELDS].map((property) => ({
        id: property.name,
        label: property.label,
        description: property.group,
        checked: columns.includes(property.name),
        onSelect: () => chooseColumns(
          columns.includes(property.name) ? columns.filter((c) => c !== property.name) : [...columns, property.name],
        ),
      })),
    },
    ...(columnsPinned
      ? [{
        id: 'columns-reset',
        items: [{
          id: 'reset',
          label: `Back to the columns in “${activeView?.name ?? 'this view'}”`,
          icon: <RotateCcwIcon size={14} />,
          onSelect: () => {
            clearPref(columnsKey);
            setColumnsPinned(false);
            setColumns(activeView?.columns.length ? activeView.columns : defaultColumns(objectDef, viewList));
          },
        }],
      } satisfies MenuSection]
      : []),
  ];

  return (
    <Page
      title={objectDef.plural_label}
      eyebrow="Customers"
      width="wide"
      subtitle={
        result.loading || result.stale
          ? 'Reading the book of business…'
          // A failed read knows nothing about how many there are. Printing a
          // zero next to a retry button asserts an emptiness nobody measured.
          : result.error
            ? `— ${objectDef.plural_label.toLowerCase()}${activeView ? ` in “${activeView.name}”` : ''}`
            : `${f.number(result.total)} ${f.plural(result.total, objectDef.label.toLowerCase(), { hideCount: true })}${activeView ? ` in “${activeView.name}”` : ''}`
      }
      actions={
        <Inline gap={3}>
          <Button variant="ghost" iconLeft={<Icons.settings size={14} />} onClick={() => navigate(`/records?type=${objectType}`)}>
            Properties
          </Button>
          <Button variant="primary" iconLeft={<Icons.plus size={14} />} onClick={() => setCreating(true)}>
            New {objectDef.label.toLowerCase()}
          </Button>
        </Inline>
      }
    >
      {viewList.length > 0 && (
        <div className="crm-views">
          <Tabs
            aria-label={`${objectDef.plural_label} views`}
            role="navigation"
            variant="pill"
            value={activeView?.id ?? ''}
            onChange={(id) => { setQuery({ view: id }); setSeeded(''); }}
            tabs={viewList.map((view) => ({
              id: view.id,
              label: view.name,
              icon: view.shared ? undefined : <Icons.lock size={11} />,
            }))}
          />
          {dirty && <Badge tone="warning" size="sm">Modified</Badge>}
        </div>
      )}

      {conditions > 0 && (
        <div className="crm-activefilter">
          <Icons.filter size={13} />
          <FilterSummary filter={pruned} properties={propertyIndex} users={userIndex} schema={schema.data} />
          <Button size="sm" variant="ghost" iconLeft={<FilterXIcon size={13} />} onClick={() => setFilter(null)}>
            Clear
          </Button>
        </div>
      )}

      <DataTable<CrmRecord>
        rows={result.rows}
        columns={tableColumns}
        getRowId={(row) => row.id}
        caption={`${objectDef.plural_label} in this workspace`}
        loading={result.loading}
        error={result.error ? { message: result.error.body.message, requestId: result.error.body.request_id ?? null, code: result.error.body.code } : null}
        onRetry={result.refetch}
        searchable={false}
        showFilters={false}
        showColumnToggle={false}
        density={density}
        onDensityChange={chooseDensity}
        // Arrowing to a row and pressing Enter opens it, which is the whole
        // point of arrowing to a row. Modifier-clicks still go through the
        // per-cell link, so cmd-click opens a new tab.
        onRowClick={(row) => navigate(recordHref(objectType, row.id))}
        toolbar={
          <>
            <SearchInput
              value={search}
              onChange={setSearch}
              size="sm"
              wrapperClassName="crm-toolsearch"
              placeholder={`Search ${objectDef.plural_label.toLowerCase()}…`}
              aria-label={`Search ${objectDef.plural_label.toLowerCase()}`}
            />
            <Button
              size="sm"
              variant={conditions ? 'secondary' : 'ghost'}
              iconLeft={<Icons.filter size={14} />}
              onClick={() => setFiltersOpen(true)}
            >
              Filters{conditions ? ` · ${conditions}` : ''}
            </Button>
            <MenuButton sections={columnMenu} label="Choose columns" icon={<Icons.columns size={14} />} variant="ghost" size="sm">
              Columns
            </MenuButton>
            <MenuButton sections={viewMenu} label="View actions" icon={<Icons.bookmark size={14} />} variant="ghost" size="sm">
              View
            </MenuButton>
            <Tooltip content="Archived records keep their history and their id — they are just out of the way">
              <Pill active={showArchived} icon={<Icons.folder size={12} />} onClick={() => setShowArchived((v) => !v)}>
                Archived
              </Pill>
            </Tooltip>
            <Button
              size="sm"
              variant="ghost"
              iconLeft={exporting ? <Spinner size={13} /> : <Icons.download size={14} />}
              disabled={exporting || !result.total}
              onClick={() => { void exportCsv(); }}
            >
              Export CSV
            </Button>
          </>
        }
        selectable
        selected={selected}
        onSelectionChange={setSelected}
        value={tableState}
        onChange={onTableState}
        maxHeight="calc(100vh - 340px)"
        empty={
          <EmptyState
            title={conditions || query ? `No ${objectDef.plural_label.toLowerCase()} match` : `No ${objectDef.plural_label.toLowerCase()} yet`}
            body={conditions || query
              ? 'Loosen the filter, or clear the search box, and the grid fills again.'
              : `${objectDef.description ?? `The first ${objectDef.label.toLowerCase()} you create appears here.`}`}
            action={
              conditions || query
                ? <Button variant="secondary" onClick={() => { setFilter(null); setSearch(''); }}>Clear the filter</Button>
                : <Button variant="primary" iconLeft={<Icons.plus size={14} />} onClick={() => setCreating(true)}>New {objectDef.label.toLowerCase()}</Button>
            }
          />
        }
        rowActions={(row) => ([{
          id: 'row',
          items: [
            { id: 'open', label: `Open ${row.display_name}`, icon: <Icons.external size={14} />, onSelect: () => navigate(recordHref(objectType, row.id)) },
            { id: 'copy', label: 'Copy record id', icon: <Icons.copy size={14} />, onSelect: () => { void navigator.clipboard?.writeText(row.id); toast.info('Record id copied', row.id); } },
            { id: 'owner', label: 'Change owner', icon: <Icons.user size={14} />, onSelect: () => { setSelected([row.id]); setBulk('owner'); } },
            row.archived
              ? { id: 'restore', label: 'Restore', icon: <RotateCcwIcon size={14} />, onSelect: () => { void restore(row); } }
              : { id: 'archive', label: 'Archive', icon: <Icons.trash size={14} />, danger: true, onSelect: () => setConfirmArchive([row.id]) },
          ],
        }] satisfies MenuSection[])}
        bulkActions={(ids) => (
          <Inline gap={2} wrap>
            <Button size="sm" variant="secondary" iconLeft={<Icons.user size={13} />} onClick={() => { setSelected(ids); setBulk('owner'); }}>Change owner</Button>
            <Button size="sm" variant="secondary" iconLeft={<Icons.edit size={13} />} onClick={() => { setSelected(ids); setBulk('property'); }}>Set a property</Button>
            <Button size="sm" variant="secondary" iconLeft={<Icons.link size={13} />} onClick={() => { setSelected(ids); setBulk('link'); }}>Link to a record</Button>
            <Button size="sm" variant="ghost" iconLeft={<Icons.download size={13} />} onClick={() => { void exportCsv(ids); }}>Export</Button>
            <Button size="sm" variant="danger-ghost" iconLeft={<Icons.trash size={13} />} onClick={() => setConfirmArchive(ids)}>Archive</Button>
          </Inline>
        )}
        footer={
          <div className="crm-tablefoot">
            <span>
              {result.loading || result.stale
                ? 'Reading…'
                : result.error
                  ? `— ${objectDef.plural_label.toLowerCase()} match this view`
                  : `${f.number(result.total)} ${f.plural(result.total, objectDef.label.toLowerCase(), { hideCount: true })} match this view`}
            </span>
            {result.hasMore && (
              <Button size="sm" variant="secondary" loading={result.loadingMore} onClick={result.loadMore}>
                Load {Math.min(50, result.total - result.rows.length)} more
              </Button>
            )}
            {selectedRows.length > 0 && <Badge tone="brand" size="sm">{selectedRows.length} selected</Badge>}
          </div>
        }
      />

      <Modal
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        size="xl"
        title={`Filter ${objectDef.plural_label.toLowerCase()}`}
        description="Nested groups, nineteen operators, moving dates, and conditions that reach across associations."
        footer={
          <>
            <Button variant="ghost" onClick={() => setFilter(null)}>Clear everything</Button>
            <span className="u-spacer" />
            <Button variant="secondary" onClick={() => { setFiltersOpen(false); setSavingView('new'); }}>Save as a view</Button>
            {/* The count is dropped while the preview is in flight rather than
                left showing the number the previous filter matched. */}
            <Button
              variant="primary"
              iconLeft={result.loading || result.stale ? <Spinner size={13} /> : undefined}
              onClick={() => setFiltersOpen(false)}
            >
              {result.loading || result.stale || result.error
                ? `Show ${objectDef.plural_label.toLowerCase()}`
                : `Show ${f.number(result.total)} ${f.plural(result.total, objectDef.label.toLowerCase(), { hideCount: true })}`}
            </Button>
          </>
        }
        footerBetween
      >
        <FilterBuilder
          objectType={objectType}
          properties={properties}
          schema={schema.data}
          users={users.data?.data ?? []}
          value={filter}
          onChange={setFilter}
        />
      </Modal>

      <RecordFormDialog
        open={creating}
        onClose={() => setCreating(false)}
        objectType={objectDef}
        properties={properties}
        users={users.data?.data ?? []}
        onCreated={(record) => navigate(recordHref(objectType, record.id))}
      />

      <SaveViewDialog
        open={savingView !== null}
        onClose={() => setSavingView(null)}
        objectType={objectType}
        existing={savingView === 'update' ? activeView : null}
        columns={columns}
        filter={pruned}
        sort={sort}
        properties={filterableProperties(properties)}
        onSaved={(view) => {
          // The view now carries these columns, so the local override has
          // nothing left to say and the view becomes the default again.
          clearPref(prefKey('columns', objectType, view.id));
          clearPref(columnsKey);
          setColumnsPinned(false);
          setQuery({ view: view.id });
          setSeeded('');
        }}
      />

      <BulkOwnerDialog
        open={bulk === 'owner'}
        onClose={() => setBulk(null)}
        objectType={objectType}
        ids={selected}
        users={users.data?.data ?? []}
        onDone={() => setSelected([])}
      />
      <BulkPropertyDialog
        open={bulk === 'property'}
        onClose={() => setBulk(null)}
        objectType={objectType}
        ids={selected}
        properties={properties}
        users={users.data?.data ?? []}
        onDone={() => setSelected([])}
      />
      <BulkLinkDialog
        open={bulk === 'link'}
        onClose={() => setBulk(null)}
        ids={selected}
        objectTypeLabel={objectDef.plural_label}
        targetTypes={(schema.data?.object_types ?? [])
          .filter((t) => t.category === 'record' && t.name !== objectType)
          .map((t) => ({ name: t.name, label: t.label }))}
        onDone={() => setSelected([])}
      />

      <ConfirmDialog
        open={!!confirmArchive}
        onCancel={() => setConfirmArchive(null)}
        onConfirm={async () => { const ids = confirmArchive ?? []; setConfirmArchive(null); await archive(ids); }}
        title={`Archive ${confirmArchive?.length ?? 0} ${f.plural(confirmArchive?.length ?? 0, objectDef.label.toLowerCase(), { hideCount: true })}?`}
        body="Archived records leave the list but keep their history, their associations and their id. You can restore them from the record page."
        confirmLabel="Archive"
      />

      <ConfirmDialog
        open={!!confirmDeleteView}
        onCancel={() => setConfirmDeleteView(null)}
        onConfirm={async () => { const view = confirmDeleteView; setConfirmDeleteView(null); if (view) await removeView(view); }}
        title={`Delete the view “${confirmDeleteView?.name ?? ''}”?`}
        body="Only the saved filter, columns and sort go. Every record it showed stays exactly where it is."
        confirmLabel="Delete view"
      />
    </Page>
  );
}
