/**
 * The deal board.
 *
 * A column per stage of one pipeline, the deals inside it, and — the number a
 * sales leader actually opens this screen for — the weighted forecast each
 * column carries. Every figure is the server's: the stage probabilities come
 * from `/v1/pipelines/deal`, each card's `weighted_amount` is computed by the
 * CRM when the deal is written, and the column totals are those values summed
 * over the cards on screen.
 *
 * Moving a card is a real write. Dropping it into a stage that closes the deal,
 * or one the workspace has required properties for, stops at a confirmation
 * that says what the move does to the forecast and collects what is missing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, useMutation, useQuery, type ApiClientError } from '@/client/kernel/api';
import { useRouter } from '@/client/kernel/router';
import { useSession } from '@/client/kernel/session';
import {
  AlertTriangleIcon, ArrowRightIcon, Avatar, Badge, Banner, Button, Card, CheckCircleIcon,
  DataTable, EmptyState, ErrorState, GitBranchIcon, humanize, Icons, MenuButton, Page, SearchInput,
  SegmentedControl, Select, Skeleton, SortDescIcon, Stat, Switch, useToast, XCircleIcon,
  activeFilterCount, activeFilters, describeFilter, filterRows, searchRows,
  type CellValue, type DataTableColumn, type MenuSection, type SelectOption,
  type TableState,
} from '@/client/design';
import {
  HORIZON_LABEL, SORTS, viewToState,
  accountOf, civilDay, dealAmount, dealCloseDate, dealEnteredStage, dealPipeline, dealStage,
  dealWeighted, num, recordHref, str, totalsOf, useDealFormat, useDealProperties, usePipelines,
  useUserIndex, useUsers, useVelocity,
  type BoardState, type CalendarFormat, type DealListEnvelope, type DealRecord, type DealView,
  type Horizon, type Pipeline, type PipelineStage, type StageVelocity,
} from './api';
import { ViewBar } from './views';
import { NewDealDialog, StageMoveDialog } from './dialogs';
import { BulkOwnerDialog, BulkStageDialog } from './bulk';

const DAY_MS = 86_400_000;
const PAGE_SIZE = 200;

type Display = 'board' | 'table';

const quarterEnd = (now: number): number => {
  const date = new Date(now);
  const month = date.getUTCMonth();
  return Date.UTC(date.getUTCFullYear(), month - (month % 3) + 3, 1);
};

/**
 * A stat tile's label, badged when the figure under it is the filtered set
 * rather than the whole pipeline — the two answer different questions and the
 * screen has to say which one it is answering.
 */
function StatLabel({ filtered, children }: { filtered: boolean; children: React.ReactNode }) {
  return (
    <span className="pl-statlabel">
      {children}
      {filtered && <Badge size="sm" tone="warning">filtered</Badge>}
    </span>
  );
}

/* --------------------------------- card ---------------------------------- */

function DealCard({
  deal, stages, currentStage, velocity, ownerName, busy, dragging, onOpen, onMove, onDragStart, onDragEnd,
}: {
  deal: DealRecord;
  stages: PipelineStage[];
  currentStage: PipelineStage | undefined;
  velocity: StageVelocity | undefined;
  ownerName: string | null;
  busy: boolean;
  dragging: boolean;
  onOpen: () => void;
  onMove: (stage: PipelineStage) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const f = useDealFormat();
  const session = useSession();
  const now = session.now();
  const account = accountOf(deal);
  const entered = dealEnteredStage(deal);
  const daysInStage = entered ? Math.floor((now - entered) / DAY_MS) : null;
  const stalledAfter = velocity?.stalled_after_days ?? null;
  const stalled = daysInStage !== null && stalledAfter !== null && daysInStage > stalledAfter;
  const close = dealCloseDate(deal);
  // A close date is a calendar day: "overdue" is measured against the day the
  // workspace is on, not against this instant in UTC.
  const overdue = close !== null && f.calendarDaysUntil(close) < 0 && !currentStage?.is_closed;

  const sections: MenuSection[] = [
    {
      id: 'open',
      items: [
        { id: 'open', label: 'Open deal', icon: <Icons.external size={14} />, onSelect: onOpen },
      ],
    },
    {
      id: 'move',
      label: 'Move to stage',
      items: stages
        .filter((stage) => stage.name !== currentStage?.name)
        .map((stage) => ({
          id: stage.name,
          label: stage.label,
          description: `${stage.probability}% · ${f.money(Math.round((dealAmount(deal) * stage.probability) / 100))} weighted`,
          icon: stage.is_won ? <CheckCircleIcon size={14} /> : stage.is_closed ? <XCircleIcon size={14} /> : <ArrowRightIcon size={14} />,
          onSelect: () => onMove(stage),
        })),
    },
  ];

  return (
    <li
      className={`pl-card${dragging ? ' is-dragging' : ''}${busy ? ' is-busy' : ''}`}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', deal.id); e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnd={onDragEnd}
      data-deal={deal.id}
      data-stage={currentStage?.name ?? ''}
    >
      <div className="pl-card__top">
        <button type="button" className="pl-card__name" onClick={onOpen} title={deal.display_name}>
          {deal.display_name}
        </button>
        <MenuButton
          className="pl-card__menu"
          sections={sections}
          label={`Actions for ${deal.display_name}`}
          size="sm"
          icon={<Icons.more size={14} />}
        />
      </div>

      {account && (
        <span className="pl-card__account">
          <Icons.building size={12} />
          <span className="u-truncate">{account.display_name}</span>
        </span>
      )}

      <div className="pl-card__row">
        <span className="pl-card__amount">{f.money(dealAmount(deal))}</span>
        <Badge size="sm" tone={currentStage?.is_won ? 'success' : currentStage?.is_closed ? 'neutral' : 'info'}>
          {f.money(dealWeighted(deal))}
        </Badge>
      </div>

      <div className="pl-card__meta">
        {ownerName && <Avatar name={ownerName} seed={deal.owner_id ?? deal.id} size={18} title={ownerName} />}
        {close !== null && (
          <span className={overdue ? 'pl-card__stalled' : undefined}>
            <Icons.calendar size={11} /> {f.calendarDate(close, { withYear: false })}
          </span>
        )}
        {daysInStage !== null && (
          <span className={stalled ? 'pl-card__stalled' : undefined}>
            {stalled ? <AlertTriangleIcon size={11} /> : <Icons.clock size={11} />}
            {' '}
            {f.plural(daysInStage, 'day')} in stage
            {stalled && stalledAfter !== null ? ` · stalls after ${stalledAfter}` : ''}
          </span>
        )}
      </div>
    </li>
  );
}

/* -------------------------------- column --------------------------------- */

function StageColumn({
  stage, deals, velocity, ceiling, children, over, onDragOver, onDragLeave, onDrop, onAdd,
}: {
  stage: PipelineStage;
  deals: DealRecord[];
  velocity: StageVelocity | undefined;
  ceiling: number;
  children: React.ReactNode;
  over: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onAdd: () => void;
}) {
  const f = useDealFormat();
  const totals = totalsOf(deals);
  const share = ceiling > 0 ? Math.min(100, Math.round((totals.amount / ceiling) * 100)) : 0;

  return (
    <section
      className={`pl-col${over ? ' is-over' : ''}${stage.is_closed ? ' is-closed' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-label={`${stage.label} — ${f.plural(totals.deals, 'deal')}, ${f.money(totals.amount)}`}
      data-stage={stage.name}
    >
      <header className="pl-col__head">
        <div className="pl-col__title">
          <Badge size="sm" tone={stage.is_won ? 'success' : stage.is_closed ? 'neutral' : 'info'}>{stage.probability}%</Badge>
          <span className="pl-col__name u-truncate" title={stage.description ?? stage.label}>{stage.label}</span>
          <span className="pl-col__count">{totals.deals}</span>
        </div>
        <div className="pl-col__money">
          <span className="pl-col__amount">{f.money(totals.amount)}</span>
          {!stage.is_closed && <span className="pl-col__weighted">{f.money(totals.weighted)} weighted</span>}
        </div>
        <div className="pl-col__bar"><span className="pl-col__barfill" style={{ width: `${share}%` }} /></div>
        {velocity && velocity.median_days_in_stage > 0 && (
          <span className="pl-col__weighted">
            Median {f.plural(velocity.median_days_in_stage, 'day')} here
            {velocity.stalled_records > 0 ? ` · ${velocity.stalled_records} stalled` : ''}
          </span>
        )}
      </header>
      <ol className="pl-col__body">
        {children}
        {deals.length === 0 && (
          <li className="pl-col__empty">
            Nothing in {stage.label.toLowerCase()}.
            {!stage.is_closed && (
              <>
                {' '}
                <Button size="sm" variant="link" onClick={onAdd}>Add a deal here</Button>
              </>
            )}
          </li>
        )}
      </ol>
    </section>
  );
}

/* ================================== page ================================== */

export function DealsPage() {
  const session = useSession();
  const f = useDealFormat();
  const toast = useToast();
  const { location, navigate, setQuery } = useRouter();

  const pipelines = usePipelines();
  const properties = useDealProperties();
  const users = useUsers();
  const userIndex = useUserIndex(users.data?.data);

  const display = (location.query.display === 'table' ? 'table' : 'board') as Display;
  const pipelineName = location.query.pipeline ?? '';
  const owner = location.query.owner ?? '';
  const horizon = (location.query.horizon ?? 'all') as Horizon;
  const forecast = location.query.forecast ?? '';
  const sortKey = location.query.sort ?? 'amount';
  const showClosed = location.query.closed === '1';
  const [search, setSearch] = useState(location.query.q ?? '');
  const [query, setQueryText] = useState(location.query.q ?? '');

  // The board asks the server for the free-text match rather than filtering a
  // page of 200 in the browser — a match on deal 640 would otherwise never
  // appear at all.
  useEffect(() => {
    const timer = setTimeout(() => setQueryText(search), 220);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => { setQuery({ q: query || undefined }, { replace: true }); }, [query, setQuery]);

  const sort = SORTS.find((s) => s.value === sortKey) ?? SORTS[0];
  const deals = useQuery<DealListEnvelope>('/v1/records/deal', {
    limit: PAGE_SIZE,
    expand: 'associations',
    sort: sort.sort,
    order: sort.order,
    ...(owner ? { owner_id: owner } : {}),
    ...(query ? { q: query } : {}),
  });

  const board = useMemo(() => {
    const list = pipelines.data?.data ?? [];
    return list.find((p) => p.name === pipelineName) ?? list.find((p) => p.is_default) ?? list[0];
  }, [pipelines.data, pipelineName]);

  const velocity = useVelocity(board?.name);
  const velocityByStage = useMemo(
    () => new Map((velocity.data?.stages ?? []).map((row) => [row.stage, row])),
    [velocity.data],
  );

  const [newOpen, setNewOpen] = useState(location.query.new === '1');
  const [newStage, setNewStage] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [move, setMove] = useState<{ deal: DealRecord; stage: PipelineStage } | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  // Held here, not inside the grid: the tiles and the subtitle total the same
  // set the table shows, so the page cannot narrow in one place and not another.
  const [tableState, setTableState] = useState<TableState>(
    () => ({ query: '', sort: { columnId: 'amount', direction: 'desc' }, filters: {} }),
  );
  const [bulkStage, setBulkStage] = useState<PipelineStage | null>(null);
  const [bulkOwner, setBulkOwner] = useState(false);
  const [refocus, setRefocus] = useState<string | null>(null);

  useEffect(() => { if (location.query.new === '1') setNewOpen(true); }, [location.query.new]);

  const closeNew = useCallback(() => {
    setNewOpen(false);
    setNewStage(undefined);
    if (location.query.new) setQuery({ new: undefined }, { replace: true });
  }, [location.query.new, setQuery]);

  /* -------------------------- optimistic stage moves ---------------------- */

  // A pending override is dropped the moment the refetched record agrees with
  // it; holding it any longer would paper over a write the server rejected.
  useEffect(() => {
    if (!deals.data || !Object.keys(pending).length) return;
    const settled = deals.data.data.filter((deal) => pending[deal.id] === dealStage(deal)).map((deal) => deal.id);
    if (settled.length) {
      setPending((prev) => {
        const next = { ...prev };
        for (const id of settled) delete next[id];
        return next;
      });
    }
  }, [deals.data, pending]);

  const moveNow = useMutation<{ deal: DealRecord; stage: PipelineStage }, DealRecord>(
    ({ deal, stage }) => api.patch<DealRecord>(`/v1/records/deal/${encodeURIComponent(deal.id)}`, {
      properties: { deal_stage: stage.name },
    }),
    {
      invalidates: ['/v1/records/deal', '/v1/pipelines', '/v1/crm/overview'],
      onSuccess: (updated, args) => {
        toast.success(
          `Moved to ${args.stage.label}`,
          `${updated.display_name} now forecasts ${f.money(num(updated.properties.weighted_amount))} at ${num(updated.properties.probability)}%.`,
        );
      },
      onError: (e: ApiClientError) => toast.error('The stage did not change', e.body.message),
    },
  );

  /**
   * Put the keyboard back on the card that was just acted on.
   *
   * A move remounts the card into another column, so whatever the menu or the
   * dialog would have restored focus to is gone by the time it tries and the
   * caret falls to `<body>` — which on a 22-card board means tabbing in from the
   * sidebar again. The card is found by the id it carries in the DOM, after the
   * column it landed in has rendered.
   */
  useEffect(() => {
    if (!refocus) return;
    let timer = 0;
    let cancelled = false;
    const until = Date.now() + 1400;
    const land = () => {
      if (cancelled) return;
      // The card is remounted twice — once when the optimistic move drops it in
      // its new column, again when the server's answer replaces it — and each
      // remount drops whatever was focused inside it. So the caret is put back
      // for as long as the move takes, and only ever when it has been lost:
      // a person who has clicked somewhere else keeps their focus.
      const lost = !document.activeElement || document.activeElement === document.body;
      const card = document.querySelector<HTMLElement>(`.pl-card[data-deal="${CSS.escape(refocus)}"]`);
      const target = card?.querySelector<HTMLElement>('.pl-card__menu') ?? card?.querySelector<HTMLElement>('.pl-card__name');
      if (lost && target) target.focus();
      if (Date.now() < until) timer = window.setTimeout(land, 60);
      else setRefocus(null);
    };
    timer = window.setTimeout(land, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [refocus]);

  const requestMove = useCallback((deal: DealRecord, stage: PipelineStage) => {
    if (dealStage(deal) === stage.name) return;
    const props = properties.data?.data ?? [];
    const needs = stage.is_closed
      || props.some((p) => p.required && !p.read_only && !p.calculated
        && (deal.properties[p.name] === undefined || deal.properties[p.name] === null || deal.properties[p.name] === ''));
    if (needs) { setMove({ deal, stage }); return; }
    setPending((prev) => ({ ...prev, [deal.id]: stage.name }));
    setRefocus(deal.id);
    void moveNow.run({ deal, stage }).catch(() => {
      setPending((prev) => { const next = { ...prev }; delete next[deal.id]; return next; });
    });
  }, [moveNow, properties.data]);

  /* -------------------------------- grouping ------------------------------ */

  const stageOf = useCallback((deal: DealRecord): string => pending[deal.id] ?? dealStage(deal), [pending]);

  const now = session.now();
  // Close dates are calendar days stored at midnight UTC, so every comparison
  // against them is made against the workspace's own civil day rather than this
  // instant — otherwise "overdue" flips for four hours every evening.
  const today = civilDay(now, session.timeZone);
  const visible = useMemo(() => {
    const rows = (deals.data?.data ?? []).filter((deal) => !deal.archived && dealPipeline(deal) === board?.name);
    const lastDay = horizon === '30'
      ? today + 30 * DAY_MS
      : horizon === 'quarter' ? quarterEnd(today) - DAY_MS : null;
    return rows.filter((deal) => {
      if (forecast && str(deal.properties.forecast_category) !== forecast) return false;
      if (horizon === 'all') return true;
      const close = dealCloseDate(deal);
      if (close === null) return false;
      if (horizon === 'overdue') return close < today;
      return lastDay !== null && close <= lastDay;
    });
  }, [deals.data, board?.name, forecast, horizon, today]);

  const columns = useMemo(
    () => (board?.stages ?? []).filter((stage) => showClosed || !stage.is_closed),
    [board, showClosed],
  );

  // Both views show the same set: hiding the closed columns has to take those
  // deals out of the table as well, or the header count and the grid disagree.
  const inView = useMemo(() => {
    const names = new Set(columns.map((stage) => stage.name));
    return visible.filter((deal) => names.has(stageOf(deal)));
  }, [columns, visible, stageOf]);

  const byStage = useMemo(() => {
    const map = new Map<string, DealRecord[]>();
    for (const stage of columns) map.set(stage.name, []);
    for (const deal of inView) {
      const list = map.get(stageOf(deal));
      if (list) list.push(deal);
    }
    return map;
  }, [columns, inView, stageOf]);

  const ceiling = useMemo(() => {
    let top = 0;
    for (const stage of columns) top = Math.max(top, totalsOf(byStage.get(stage.name) ?? []).amount);
    return top;
  }, [columns, byStage]);

  const boardShown = useMemo(() => columns.reduce((n, stage) => n + (byStage.get(stage.name)?.length ?? 0), 0), [columns, byStage]);
  const toolbarFiltered = !!query || !!owner || !!forecast || horizon !== 'all';
  const truncated = !!deals.data?.has_more;

  const toolbarSummary = useMemo(() => [
    query && `“${query}”`,
    owner && (userIndex.get(owner)?.name ?? owner),
    forecast && humanize(forecast),
    horizon !== 'all' && HORIZON_LABEL[horizon].toLowerCase(),
  ].filter(Boolean), [query, owner, forecast, horizon, userIndex]);

  const stageByName = useMemo(
    () => new Map((board?.stages ?? []).map((stage) => [stage.name, stage])),
    [board],
  );

  /* ------------------------------- toolbars ------------------------------- */

  const ownerOptions = useMemo<SelectOption[]>(() => [
    { value: '', label: 'Every owner' },
    ...(users.data?.data ?? []).map((user) => ({ value: user.id, label: user.name })),
  ], [users.data]);

  const forecastOptions = useMemo<SelectOption[]>(() => {
    const property = (properties.data?.data ?? []).find((p) => p.name === 'forecast_category');
    return [
      { value: '', label: 'Every forecast category' },
      ...(property?.options ?? []).map((option) => ({ value: option.value, label: option.label })),
    ];
  }, [properties.data]);

  const openDeal = useCallback((deal: DealRecord) => navigate(recordHref('deal', deal.id)), [navigate]);

  /* -------------------------------- views -------------------------------- */

  const activeView = location.query.view ?? '';

  // The board as a saved view would hold it. The pipeline is the *effective*
  // one, not the empty string that means "whichever is default": a view named
  // after New business has to keep pointing at New business when the workspace
  // makes another pipeline the default.
  const boardState: BoardState = useMemo(() => ({
    pipeline: board?.name ?? pipelineName,
    owner,
    forecast,
    horizon,
    sort: sortKey,
    closed: showClosed,
  }), [board?.name, pipelineName, owner, forecast, horizon, sortKey, showClosed]);

  const applyView = useCallback((view: DealView | null) => {
    if (!view) { setQuery({ view: undefined }); return; }
    const { state, readable } = viewToState(view);
    setQuery({
      view: readable ? view.id : undefined,
      pipeline: state.pipeline || undefined,
      owner: state.owner || undefined,
      forecast: state.forecast || undefined,
      horizon: state.horizon === 'all' ? undefined : state.horizon,
      sort: state.sort === 'amount' ? undefined : state.sort,
      closed: state.closed ? '1' : undefined,
    });
    if (!readable) {
      toast.info(
        `“${view.name}” is only partly shown`,
        'It also filters on conditions this board has no control for, so it is not marked as the view you are on. What it could take is on the board.',
      );
    }
  }, [setQuery, toast]);

  const pipelineLabel = useCallback(
    (name: string) => (pipelines.data?.data ?? []).find((p) => p.name === name)?.label ?? name,
    [pipelines.data],
  );
  const ownerName = useCallback(
    (id: string) => userIndex.get(id)?.name ?? id,
    [userIndex],
  );
  const forecastLabel = useCallback((value: string) => {
    const property = (properties.data?.data ?? []).find((p) => p.name === 'forecast_category');
    return property?.options?.find((option) => option.value === value)?.label ?? humanize(value);
  }, [properties.data]);

  // Clearing has to reset the box as well as the address: the search text is
  // held here and written into the URL, so dropping only the parameter puts it
  // straight back on the next debounce.
  const clearFilters = useCallback(() => {
    setSearch('');
    setQueryText('');
    setTableState((state) => ({ ...state, query: '', filters: {} }));
    setQuery({ q: undefined, owner: undefined, forecast: undefined, horizon: undefined, view: undefined });
  }, [setQuery]);

  /* --------------------------------- table -------------------------------- */

  const stageLabel = useCallback(
    (name: string) => (board?.stages ?? []).find((stage) => stage.name === name)?.label ?? humanize(name),
    [board],
  );

  const tableColumns = useMemo<DataTableColumn<DealRecord>[]>(() => [
    {
      id: 'name',
      header: 'Deal',
      pinned: true,
      width: 300,
      accessor: (row) => row.display_name,
      cell: (row) => (
        <span className="u-truncate" title={row.display_name}>{row.display_name}</span>
      ),
    },
    {
      id: 'account',
      header: 'Account',
      width: 190,
      accessor: (row) => accountOf(row)?.display_name ?? '',
      filter: 'set',
      cell: (row) => accountOf(row)?.display_name ?? <span className="pl-muted">—</span>,
    },
    {
      id: 'stage',
      header: 'Stage',
      width: 160,
      accessor: (row) => stageLabel(stageOf(row)),
      filter: 'set',
      cell: (row) => <Badge size="sm" tone="info">{stageLabel(stageOf(row))}</Badge>,
    },
    {
      id: 'amount',
      header: 'Amount',
      align: 'right',
      width: 140,
      sortable: true,
      filter: 'number',
      accessor: (row) => dealAmount(row),
      cell: (row) => f.money(dealAmount(row)),
      total: (_rows, sum) => f.money(sum),
    },
    {
      id: 'probability',
      header: 'Probability',
      align: 'right',
      width: 110,
      sortable: true,
      accessor: (row) => num(row.properties.probability),
      cell: (row) => `${num(row.properties.probability)}%`,
    },
    {
      id: 'weighted',
      header: 'Weighted',
      align: 'right',
      width: 140,
      sortable: true,
      accessor: (row) => dealWeighted(row),
      cell: (row) => f.money(dealWeighted(row)),
      total: (_rows, sum) => f.money(sum),
    },
    {
      id: 'close_date',
      header: 'Close date',
      width: 130,
      sortable: true,
      filter: 'date',
      accessor: (row) => dealCloseDate(row) ?? 0,
      cell: (row) => {
        const close = dealCloseDate(row);
        return close === null ? <span className="pl-muted">—</span> : f.calendarDate(close);
      },
    },
    {
      id: 'owner',
      header: 'Owner',
      width: 150,
      filter: 'set',
      accessor: (row) => (row.owner_id ? userIndex.get(row.owner_id)?.name ?? row.owner_id : 'Unassigned'),
    },
    {
      id: 'stage_age',
      header: 'In stage',
      align: 'right',
      width: 100,
      sortable: true,
      accessor: (row) => {
        const entered = dealEnteredStage(row);
        return entered ? Math.floor((now - entered) / DAY_MS) : 0;
      },
      cell: (row) => {
        const entered = dealEnteredStage(row);
        return entered ? f.plural(Math.floor((now - entered) / DAY_MS), 'day') : <span className="pl-muted">—</span>;
      },
    },
  ], [f, now, stageOf, stageLabel, userIndex]);

  /**
   * The table's own search box and column chips, lifted out of the grid.
   *
   * `DataTable` will filter itself perfectly well, but then only it knows what
   * is on screen: the stat tiles above stayed on the pipeline-wide totals and
   * the subtitle kept quoting 22 deals over a grid showing 2. The state lives
   * here so the whole page answers one question — the same thing the board's
   * own filters already do.
   */
  const tableSearchable = useMemo(
    () => tableColumns.filter((column) => !column.unsearchable).map((column) => column.id),
    [tableColumns],
  );

  const tableAccessor = useCallback((row: DealRecord, columnId: string): CellValue => {
    const column = tableColumns.find((c) => c.id === columnId);
    return column?.accessor ? column.accessor(row) : null;
  }, [tableColumns]);

  const tableNarrows = display === 'table'
    && (!!tableState.query.trim() || activeFilterCount(tableState.filters) > 0);

  const narrowed = useMemo(() => {
    if (!tableNarrows) return visible;
    const searched = tableState.query.trim()
      ? searchRows(visible, tableState.query, tableSearchable, tableAccessor)
      : visible;
    return filterRows(searched, tableState.filters, tableAccessor);
  }, [tableNarrows, visible, tableState.query, tableState.filters, tableSearchable, tableAccessor]);

  // What the grid itself will show, once it has re-run the same narrowing over
  // the rows it was handed. The subtitle counts these.
  const gridRows = useMemo(() => {
    if (!tableNarrows) return inView;
    const names = new Set(columns.map((stage) => stage.name));
    return narrowed.filter((deal) => names.has(stageOf(deal)));
  }, [tableNarrows, inView, narrowed, columns, stageOf]);

  const filtered = toolbarFiltered || tableNarrows;
  const shown = display === 'table' ? gridRows.length : boardShown;
  const onScreen = display === 'table' ? gridRows : inView;
  // Whether there is anything for the surface to draw at all. The table keeps
  // its own toolbar when its search matches nothing — replacing the grid with a
  // page-level empty state would take away the box the text was typed into.
  const populated = display === 'table' ? inView.length : boardShown;

  const filterSummary = useMemo(() => {
    const parts = [...toolbarSummary];
    if (tableNarrows) {
      if (tableState.query.trim()) parts.push(`“${tableState.query.trim()}”`);
      for (const [columnId, filter] of activeFilters(tableState.filters)) {
        const column = tableColumns.find((c) => c.id === columnId);
        const label = typeof column?.header === 'string' ? column.header : columnId;
        parts.push(`${label.toLowerCase()} ${describeFilter(filter, { formatDate: (ts) => f.calendarDate(ts) })}`);
      }
    }
    return parts.join(' · ');
  }, [toolbarSummary, tableNarrows, tableState.query, tableState.filters, tableColumns, f]);

  /**
   * The stat row, over the deals a filter has left on screen.
   *
   * `/v1/pipelines/deal` computes its totals over every deal on the pipeline,
   * which is the right answer to "what is my pipeline" and the wrong answer to
   * "what is Priya carrying". Filter the board — from the toolbar or from the
   * table's own controls — and these tiles answer the second question, so the
   * screen never shows two open-pipeline figures at once.
   */
  const filteredTotals = useMemo(() => {
    let open = 0;
    let weighted = 0;
    let won = 0;
    let stalled = 0;
    let openDeals = 0;
    let wonDeals = 0;
    for (const deal of narrowed) {
      const stage = stageByName.get(stageOf(deal));
      if (stage?.is_won) { won += dealAmount(deal); wonDeals += 1; continue; }
      if (stage?.is_closed) continue;
      open += dealAmount(deal);
      weighted += dealWeighted(deal);
      openDeals += 1;
      const entered = dealEnteredStage(deal);
      const stallsAfter = velocityByStage.get(stage?.name ?? '')?.stalled_after_days ?? 0;
      if (entered && stallsAfter > 0 && Math.floor((now - entered) / DAY_MS) > stallsAfter) stalled += 1;
    }
    return { open, weighted, won, stalled, openDeals, wonDeals, deals: narrowed.length };
  }, [narrowed, stageByName, stageOf, velocityByStage, now]);

  const rowActions = useCallback((row: DealRecord): MenuSection[] => [
    { id: 'open', items: [{ id: 'open', label: 'Open deal', icon: <Icons.external size={14} />, onSelect: () => openDeal(row) }] },
    {
      id: 'move',
      label: 'Move to stage',
      items: (board?.stages ?? [])
        .filter((stage) => stage.name !== stageOf(row))
        .map((stage) => ({
          id: stage.name,
          label: stage.label,
          description: `${stage.probability}%`,
          onSelect: () => requestMove(row, stage),
        })),
    },
  ], [board, openDeal, requestMove, stageOf]);

  /* -------------------------------- render -------------------------------- */

  const error = deals.error ?? pipelines.error;
  const loading = deals.loading || pipelines.loading;

  // A sum over an array that has not arrived is not a measurement. While the
  // board is loading or broken the subtitle says so rather than asserting
  // "0 deals · $0.00 open" above a stat card reading several million.
  // A filtered tile is a sum over the deals on screen, so it cannot be quoted
  // until they have arrived. The unfiltered tiles come from `/v1/pipelines/deal`
  // and stay true even when the deal list itself fails.
  const unmeasured = filtered && (loading || !!deals.error);
  const unmeasuredWhy = deals.error
    ? 'The deal list did not answer, so this filter cannot be totalled'
    : 'Counting the deals that match…';

  const headline = error
    ? 'The board could not be built'
    : loading
      ? `Reading ${board ? board.label : 'the pipeline'}…`
      : board
        ? (() => {
          const openRows = onScreen.filter((deal) => !board.stages.find((s) => s.name === stageOf(deal))?.is_closed);
          const open = totalsOf(openRows);
          return [
            `${f.plural(shown, 'deal')} on ${board.label}${showClosed ? '' : ', open stages only'}`,
            `${f.money(open.amount)} open`,
            `${f.money(open.weighted)} weighted`,
          ].join(' · ');
        })()
        : 'Deals, by stage';

  return (
    <Page
      title="Deals"
      subtitle={headline}
      width="wide"
      actions={
        <>
          <SegmentedControl<Display>
            value={display}
            onChange={(next) => setQuery({ display: next === 'board' ? undefined : next })}
            aria-label="How to show deals"
            options={[
              { value: 'board', label: 'Board', icon: <Icons.columns size={14} /> },
              { value: 'table', label: 'Table', icon: <Icons.table size={14} /> },
            ]}
          />
          <Button variant="primary" iconLeft={<Icons.plus size={14} />} onClick={() => setNewOpen(true)}>
            New deal
          </Button>
        </>
      }
    >
      {board && (
        <div className="pl-summary">
          <Card padding="tight">
            <Stat
              label={<StatLabel filtered={filtered}>Open pipeline</StatLabel>}
              value={unmeasured ? '—' : f.money(filtered ? filteredTotals.open : board.open_amount ?? 0)}
              icon={<Icons.funnel size={15} />}
              caption={unmeasured
                ? unmeasuredWhy
                : filtered
                  ? `${f.plural(filteredTotals.openDeals, 'open deal')} matching ${filterSummary}`
                  : `${f.plural(board.record_count, 'deal')} have passed through ${board.label}`}
            />
          </Card>
          <Card padding="tight">
            <Stat
              label={<StatLabel filtered={filtered}>Weighted forecast</StatLabel>}
              value={unmeasured ? '—' : f.money(filtered ? filteredTotals.weighted : board.weighted_amount ?? 0)}
              icon={<Icons.target size={15} />}
              caption={unmeasured ? unmeasuredWhy : 'Each open deal at its stage probability'}
            />
          </Card>
          <Card padding="tight">
            <Stat
              label={<StatLabel filtered={filtered}>Closed won</StatLabel>}
              value={unmeasured ? '—' : f.money(filtered ? filteredTotals.won : board.won_amount ?? 0)}
              icon={<CheckCircleIcon size={15} />}
              caption={unmeasured
                ? unmeasuredWhy
                : filtered
                  ? `${f.plural(filteredTotals.wonDeals, 'won deal')} in this filter`
                  : velocity.data
                    ? `Median ${f.plural(velocity.data.median_days_to_close, 'day')} to close`
                    : 'Booked on this pipeline'}
            />
          </Card>
          <Card padding="tight">
            <Stat
              label={<StatLabel filtered={filtered}>Stalled</StatLabel>}
              value={unmeasured
                ? '—'
                : filtered
                  ? f.number(filteredTotals.stalled)
                  : velocity.data ? f.number(velocity.data.stalled_records) : '—'}
              icon={<AlertTriangleIcon size={15} />}
              caption={unmeasured ? unmeasuredWhy : "Sitting longer than twice their stage's median"}
            />
          </Card>
        </div>
      )}

      <div className="pl-toolbar">
        <ViewBar
          state={boardState}
          activeId={activeView}
          onApply={applyView}
          pipelineLabel={pipelineLabel}
          ownerName={ownerName}
          forecastLabel={forecastLabel}
        />
        <span className="pl-toolbar__rule" aria-hidden="true" />
        <Select
          value={board?.name ?? ''}
          onChange={(next) => setQuery({ pipeline: next })}
          size="sm"
          icon={<Icons.layers size={13} />}
          aria-label="Pipeline"
          options={(pipelines.data?.data ?? []).map<SelectOption>((p) => ({
            value: p.name,
            label: `${p.label}${p.is_default ? ' (default)' : ''}`,
          }))}
        />
        <Select
          value={owner}
          onChange={(next) => setQuery({ owner: next || undefined })}
          size="sm"
          icon={<Icons.user size={13} />}
          aria-label="Owner"
          options={ownerOptions}
        />
        <Select
          value={forecast}
          onChange={(next) => setQuery({ forecast: next || undefined })}
          size="sm"
          icon={<Icons.target size={13} />}
          aria-label="Forecast category"
          options={forecastOptions}
        />
        <Select
          value={horizon}
          onChange={(next) => setQuery({ horizon: next === 'all' ? undefined : next })}
          size="sm"
          icon={<Icons.calendar size={13} />}
          aria-label="Close date"
          options={(Object.keys(HORIZON_LABEL) as Horizon[]).map<SelectOption>((value) => ({ value, label: HORIZON_LABEL[value] }))}
        />
        <Select
          value={sortKey}
          onChange={(next) => setQuery({ sort: next === 'amount' ? undefined : next })}
          size="sm"
          icon={<SortDescIcon size={13} />}
          aria-label="Sort deals"
          options={SORTS.map<SelectOption>((option) => ({ value: option.value, label: option.label }))}
        />
        <div className="pl-toolbar__spacer" />
        <div className="pl-toolbar__search">
          <SearchInput
            value={search}
            onChange={setSearch}
            size="sm"
            placeholder="Search deals"
            aria-label="Search deals"
          />
        </div>
        <Switch
          checked={showClosed}
          onChange={(next) => setQuery({ closed: next ? '1' : undefined })}
          label="Closed stages"
          size="sm"
        />
      </div>

      {truncated && (
        <Banner tone="info" compact bar>
          Showing the first {f.number(PAGE_SIZE)} deals of {f.number(deals.data?.total_count ?? 0)} by {sort.label.toLowerCase()}.
          The stat cards above are computed by the server over every deal on this pipeline; the column totals cover the ones on screen.
        </Banner>
      )}

      {error && (
        <Card>
          <ErrorState
            title="The board could not be built"
            message={error.body.message}
            code={`${error.status} ${deals.error ? '/v1/records/deal' : '/v1/pipelines/deal'}`}
            requestId={error.body.request_id ?? null}
            action={
              <Button variant="primary" iconLeft={<Icons.refresh size={14} />} onClick={() => { deals.refetch(); pipelines.refetch(); }}>
                Try again
              </Button>
            }
          />
        </Card>
      )}

      {!error && loading && (
        <div className="pl-board">
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={420} />)}
        </div>
      )}

      {!error && !loading && !board && (
        <EmptyState
          title="No deal pipeline exists yet"
          body="Deals move through pipelines whose stages own the probability and the forecast category. Create one in the data model, then this board fills itself in."
          action={<Button variant="primary" onClick={() => navigate('/records')}>Open the data model</Button>}
        />
      )}

      {!error && !loading && board && populated === 0 && (
        <EmptyState
          title={filtered ? 'No deal matches these filters' : `${board.label} has no deals yet`}
          body={filtered
            ? `Nothing on ${board.label} matches ${filterSummary}.`
            : `Open the first opportunity and it lands in ${board.stages[0]?.label ?? 'the first stage'} at ${board.stages[0]?.probability ?? 0}%.`}
          action={filtered
            ? <Button variant="primary" onClick={clearFilters}>Clear filters</Button>
            : <Button variant="primary" iconLeft={<Icons.plus size={14} />} onClick={() => setNewOpen(true)}>New deal</Button>}
          secondaryAction={filtered ? <Button onClick={() => setNewOpen(true)}>New deal</Button> : undefined}
        />
      )}

      {!error && !loading && board && populated > 0 && display === 'board' && (
        <div className="pl-board">
          {columns.map((stage) => (
            <StageColumn
              key={stage.name}
              stage={stage}
              deals={byStage.get(stage.name) ?? []}
              velocity={velocityByStage.get(stage.name)}
              ceiling={ceiling}
              over={over === stage.name}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(stage.name); }}
              onDragLeave={() => setOver((current) => (current === stage.name ? null : current))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const id = e.dataTransfer.getData('text/plain') || dragging;
                setDragging(null);
                const deal = inView.find((row) => row.id === id);
                if (deal) requestMove(deal, stage);
              }}
              onAdd={() => { setNewStage(stage.name); setNewOpen(true); }}
            >
              {(byStage.get(stage.name) ?? []).map((deal) => (
                <DealCard
                  key={deal.id}
                  deal={deal}
                  stages={board.stages}
                  currentStage={board.stages.find((s) => s.name === stageOf(deal))}
                  velocity={velocityByStage.get(stageOf(deal))}
                  ownerName={deal.owner_id ? userIndex.get(deal.owner_id)?.name ?? null : null}
                  busy={!!pending[deal.id]}
                  dragging={dragging === deal.id}
                  onOpen={() => openDeal(deal)}
                  onMove={(stageTo) => requestMove(deal, stageTo)}
                  onDragStart={() => setDragging(deal.id)}
                  onDragEnd={() => { setDragging(null); setOver(null); }}
                />
              ))}
            </StageColumn>
          ))}
        </div>
      )}

      {!error && !loading && board && populated > 0 && display === 'table' && (
        <DataTable<DealRecord>
          rows={inView}
          columns={tableColumns}
          getRowId={(row) => row.id}
          caption={`Deals on ${board.label}`}
          onRowClick={openDeal}
          rowActions={rowActions}
          selectable
          selected={selection}
          onSelectionChange={setSelection}
          bulkActions={(ids) => {
            const picked = inView.filter((row) => ids.includes(row.id));
            const totals = totalsOf(picked);
            return (
              <>
                <span className="ain-table__bulknote">
                  {f.money(totals.amount)} · {f.money(totals.weighted)} weighted
                </span>
                <MenuButton
                  size="sm"
                  variant="secondary"
                  label="Move the selected deals to a stage"
                  icon={<GitBranchIcon size={13} />}
                  sections={[{
                    id: 'stages',
                    label: 'Move to stage',
                    // A deal already sitting in the destination is not moved, so
                    // it is not quoted either: this preview is computed over the
                    // same set the confirmation will commit.
                    items: (board?.stages ?? []).map((stage) => {
                      const moving = picked.filter((row) => stageOf(row) !== stage.name);
                      const amount = moving.reduce((sum, row) => sum + dealAmount(row), 0);
                      return {
                        id: stage.name,
                        label: stage.label,
                        description: moving.length === 0
                          ? 'All of them are here already'
                          : `${f.plural(moving.length, 'deal')} · ${stage.probability}% · ${f.money(Math.round((amount * stage.probability) / 100))} weighted`,
                        disabled: moving.length === 0,
                        icon: stage.is_won
                          ? <CheckCircleIcon size={14} />
                          : stage.is_closed ? <XCircleIcon size={14} /> : <ArrowRightIcon size={14} />,
                        onSelect: () => setBulkStage(stage),
                      };
                    }),
                  }]}
                >
                  Move stage
                </MenuButton>
                <Button size="sm" variant="secondary" iconLeft={<Icons.user size={13} />} onClick={() => setBulkOwner(true)}>
                  Reassign
                </Button>
              </>
            );
          }}
          searchable
          searchPlaceholder="Filter the deals on screen"
          stickyFooter
          showColumnToggle
          showFilters
          value={tableState}
          onChange={setTableState}
          footer={<span className="pl-note">{f.plural(gridRows.length, 'deal')} on {board.label}{showClosed ? '' : ', open stages only'}</span>}
        />
      )}

      <NewDealDialog
        open={newOpen}
        onClose={closeNew}
        pipelines={pipelines.data?.data ?? []}
        properties={properties.data?.data ?? []}
        users={users.data?.data ?? []}
        defaultPipeline={board?.name}
        defaultStage={newStage}
        onCreated={(deal) => navigate(recordHref('deal', deal.id))}
      />

      <BulkStageDialog
        open={!!bulkStage}
        deals={inView.filter((row) => selection.includes(row.id))}
        stage={bulkStage}
        stages={board?.stages ?? []}
        properties={properties.data?.data ?? []}
        onClose={() => setBulkStage(null)}
        onDone={() => { setBulkStage(null); setSelection([]); }}
      />

      <BulkOwnerDialog
        open={bulkOwner}
        deals={inView.filter((row) => selection.includes(row.id))}
        users={users.data?.data ?? []}
        onClose={() => setBulkOwner(false)}
        onDone={() => { setBulkOwner(false); setSelection([]); }}
      />

      <StageMoveDialog
        open={!!move}
        deal={move?.deal ?? null}
        from={move ? board?.stages.find((s) => s.name === dealStage(move.deal)) : undefined}
        to={move?.stage ?? null}
        properties={properties.data?.data ?? []}
        onClose={() => { const id = move?.deal.id ?? null; setMove(null); setRefocus(id); }}
        onMoved={() => { const id = move?.deal.id ?? null; setMove(null); setRefocus(id); }}
      />
    </Page>
  );
}

export type { Pipeline };
