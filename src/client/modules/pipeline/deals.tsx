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
  DataTable, EmptyState, ErrorState, humanize, Icons, MenuButton, Page, SearchInput,
  SegmentedControl, Select, Skeleton, SortDescIcon, Stat, Switch, useFormat, useToast, XCircleIcon,
  type DataTableColumn, type MenuSection, type SelectOption
} from '@/client/design';
import {
  accountOf, dealAmount, dealCloseDate, dealEnteredStage, dealPipeline, dealStage, dealWeighted,
  num, recordHref, str, totalsOf, useDealProperties, usePipelines, useUserIndex, useUsers, useVelocity,
  type DealListEnvelope, type DealRecord, type Pipeline, type PipelineStage, type StageVelocity,
} from './api';
import { NewDealDialog, StageMoveDialog } from './dialogs';

const DAY_MS = 86_400_000;
const PAGE_SIZE = 200;

type Display = 'board' | 'table';
type Horizon = 'all' | 'overdue' | '30' | 'quarter';

const HORIZON_LABEL: Record<Horizon, string> = {
  all: 'Any close date',
  overdue: 'Past its close date',
  '30': 'Closing within 30 days',
  quarter: 'Closing this quarter',
};

const SORTS: { value: string; label: string; sort: string; order: 'asc' | 'desc' }[] = [
  { value: 'amount', label: 'Largest first', sort: 'amount', order: 'desc' },
  { value: 'close', label: 'Closing soonest', sort: 'close_date', order: 'asc' },
  { value: 'stage', label: 'Longest in stage', sort: 'stage_entered_at', order: 'asc' },
  { value: 'updated', label: 'Recently updated', sort: 'updated', order: 'desc' },
];

const quarterEnd = (now: number): number => {
  const date = new Date(now);
  const month = date.getUTCMonth();
  return Date.UTC(date.getUTCFullYear(), month - (month % 3) + 3, 1);
};

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
  const f = useFormat();
  const session = useSession();
  const now = session.now();
  const account = accountOf(deal);
  const entered = dealEnteredStage(deal);
  const daysInStage = entered ? Math.floor((now - entered) / DAY_MS) : null;
  const stalledAfter = velocity?.stalled_after_days ?? null;
  const stalled = daysInStage !== null && stalledAfter !== null && daysInStage > stalledAfter;
  const close = dealCloseDate(deal);
  const overdue = close !== null && close < now && !currentStage?.is_closed;

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
            <Icons.calendar size={11} /> {f.date(close, { withYear: false })}
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
  const f = useFormat();
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
  const f = useFormat();
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

  const requestMove = useCallback((deal: DealRecord, stage: PipelineStage) => {
    if (dealStage(deal) === stage.name) return;
    const props = properties.data?.data ?? [];
    const needs = stage.is_closed
      || props.some((p) => p.required && !p.read_only && !p.calculated
        && (deal.properties[p.name] === undefined || deal.properties[p.name] === null || deal.properties[p.name] === ''));
    if (needs) { setMove({ deal, stage }); return; }
    setPending((prev) => ({ ...prev, [deal.id]: stage.name }));
    void moveNow.run({ deal, stage }).catch(() => {
      setPending((prev) => { const next = { ...prev }; delete next[deal.id]; return next; });
    });
  }, [moveNow, properties.data]);

  /* -------------------------------- grouping ------------------------------ */

  const stageOf = useCallback((deal: DealRecord): string => pending[deal.id] ?? dealStage(deal), [pending]);

  const now = session.now();
  const visible = useMemo(() => {
    const rows = (deals.data?.data ?? []).filter((deal) => !deal.archived && dealPipeline(deal) === board?.name);
    const horizonEnd = horizon === '30' ? now + 30 * DAY_MS : horizon === 'quarter' ? quarterEnd(now) : null;
    return rows.filter((deal) => {
      if (forecast && str(deal.properties.forecast_category) !== forecast) return false;
      if (horizon === 'all') return true;
      const close = dealCloseDate(deal);
      if (close === null) return false;
      if (horizon === 'overdue') return close < now;
      return horizonEnd !== null && close <= horizonEnd;
    });
  }, [deals.data, board?.name, forecast, horizon, now]);

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

  const shown = useMemo(() => columns.reduce((n, stage) => n + (byStage.get(stage.name)?.length ?? 0), 0), [columns, byStage]);
  const filtered = !!query || !!owner || !!forecast || horizon !== 'all';
  const truncated = !!deals.data?.has_more;

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

  // Clearing has to reset the box as well as the address: the search text is
  // held here and written into the URL, so dropping only the parameter puts it
  // straight back on the next debounce.
  const clearFilters = useCallback(() => {
    setSearch('');
    setQueryText('');
    setQuery({ q: undefined, owner: undefined, forecast: undefined, horizon: undefined });
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
      accessor: (row) => stageLabel(stageOf(row)),
      filter: 'set',
      cell: (row) => <Badge size="sm" tone="info">{stageLabel(stageOf(row))}</Badge>,
    },
    {
      id: 'amount',
      header: 'Amount',
      align: 'right',
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
      sortable: true,
      accessor: (row) => num(row.properties.probability),
      cell: (row) => `${num(row.properties.probability)}%`,
    },
    {
      id: 'weighted',
      header: 'Weighted',
      align: 'right',
      sortable: true,
      accessor: (row) => dealWeighted(row),
      cell: (row) => f.money(dealWeighted(row)),
      total: (_rows, sum) => f.money(sum),
    },
    {
      id: 'close_date',
      header: 'Close date',
      sortable: true,
      filter: 'date',
      accessor: (row) => dealCloseDate(row) ?? 0,
      cell: (row) => {
        const close = dealCloseDate(row);
        return close === null ? <span className="pl-muted">—</span> : f.date(close);
      },
    },
    {
      id: 'owner',
      header: 'Owner',
      filter: 'set',
      accessor: (row) => (row.owner_id ? userIndex.get(row.owner_id)?.name ?? row.owner_id : 'Unassigned'),
    },
    {
      id: 'stage_age',
      header: 'In stage',
      align: 'right',
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

  const headline = board
    ? (() => {
      const openRows = inView.filter((deal) => !board.stages.find((s) => s.name === stageOf(deal))?.is_closed);
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
              label="Open pipeline"
              value={f.money(board.open_amount ?? 0)}
              icon={<Icons.funnel size={15} />}
              caption={`${f.plural(board.record_count, 'deal')} have passed through ${board.label}`}
            />
          </Card>
          <Card padding="tight">
            <Stat
              label="Weighted forecast"
              value={f.money(board.weighted_amount ?? 0)}
              icon={<Icons.target size={15} />}
              caption="Each open deal at its stage probability"
            />
          </Card>
          <Card padding="tight">
            <Stat
              label="Closed won"
              value={f.money(board.won_amount ?? 0)}
              icon={<CheckCircleIcon size={15} />}
              caption={velocity.data ? `Median ${f.plural(velocity.data.median_days_to_close, 'day')} to close` : 'Booked on this pipeline'}
            />
          </Card>
          <Card padding="tight">
            <Stat
              label="Stalled"
              value={velocity.data ? f.number(velocity.data.stalled_records) : '—'}
              icon={<AlertTriangleIcon size={15} />}
              caption="Sitting longer than twice their stage's median"
            />
          </Card>
        </div>
      )}

      <div className="pl-toolbar">
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

      {!error && !loading && board && shown === 0 && (
        <EmptyState
          title={filtered ? 'No deal matches these filters' : `${board.label} has no deals yet`}
          body={filtered
            ? `Nothing on ${board.label} matches ${[query && `“${query}”`, owner && userIndex.get(owner)?.name, forecast && humanize(forecast), horizon !== 'all' && HORIZON_LABEL[horizon].toLowerCase()].filter(Boolean).join(' · ')}.`
            : `Open the first opportunity and it lands in ${board.stages[0]?.label ?? 'the first stage'} at ${board.stages[0]?.probability ?? 0}%.`}
          action={filtered
            ? <Button variant="primary" onClick={clearFilters}>Clear filters</Button>
            : <Button variant="primary" iconLeft={<Icons.plus size={14} />} onClick={() => setNewOpen(true)}>New deal</Button>}
          secondaryAction={filtered ? <Button onClick={() => setNewOpen(true)}>New deal</Button> : undefined}
        />
      )}

      {!error && !loading && board && shown > 0 && display === 'board' && (
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

      {!error && !loading && board && shown > 0 && display === 'table' && (
        <DataTable<DealRecord>
          rows={inView}
          columns={tableColumns}
          getRowId={(row) => row.id}
          caption={`Deals on ${board.label}`}
          onRowClick={openDeal}
          rowActions={rowActions}
          searchable
          searchPlaceholder="Filter the deals on screen"
          stickyFooter
          showColumnToggle
          showFilters
          initialSort={{ columnId: 'amount', direction: 'desc' }}
          footer={<span className="pl-note">{f.plural(inView.length, 'deal')} on {board.label}{showClosed ? '' : ', open stages only'}</span>}
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

      <StageMoveDialog
        open={!!move}
        deal={move?.deal ?? null}
        from={move ? board?.stages.find((s) => s.name === dealStage(move.deal)) : undefined}
        to={move?.stage ?? null}
        properties={properties.data?.data ?? []}
        onClose={() => setMove(null)}
        onMoved={() => setMove(null)}
      />
    </Page>
  );
}

export type { Pipeline };
