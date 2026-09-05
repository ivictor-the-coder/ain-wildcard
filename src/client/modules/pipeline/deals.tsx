/**
 * The deal board.
 *
 * A column per stage of a pipeline, the deals inside it, and — the number a
 * sales leader actually opens this screen for — the weighted forecast each
 * column carries. Every figure is the server's: the stage probabilities come
 * from `/v1/pipelines/deal`, each card's `weighted_amount` is computed by the
 * CRM when the deal is written, and the column totals are those values summed
 * over the cards on screen.
 *
 * It draws one pipeline, or every pipeline at once as a strip each. The second
 * is not a nicety: the dashboard counts commit across pipelines, so a card
 * reading "$3,636,580.00 across 14 deals" had nowhere to send you but a board
 * showing seven of them. Stages are identified by (pipeline, stage) throughout,
 * because all three of this workspace's pipelines have a stage called
 * `qualification` and two of them call it something different on screen.
 *
 * Moving a card is a real write. Dropping it into a stage that closes the deal,
 * or one the workspace has required properties for, stops at a confirmation
 * that says what the move does to the forecast and collects what is missing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, useMutation, useQuery, type ApiClientError } from '@/client/kernel/api';
import { useRouter } from '@/client/kernel/router';
import { useSession } from '@/client/kernel/session';
import {
  AlertTriangleIcon, ArrowRightIcon, Avatar, Badge, Banner, Button, Card, CheckCircleIcon,
  DataTable, EmptyState, ErrorState, GitBranchIcon, humanize, Icons, MenuButton, Page, SearchInput,
  Select, Skeleton, SortDescIcon, Stat, Switch, toMajorUnits, useToast, XCircleIcon, XIcon,
  activeFilterCount, activeFilters, describeFilter, filterRows, searchRows,
  type CellValue, type DataTableColumn, type MenuSection, type SelectOption,
  type TableState,
} from '@/client/design';
import {
  ALL_PIPELINES, CUSTOM_SORT, HORIZON_LABEL, HORIZONS, SORTS, TABLE_SORT, boardHeadline, boardMove, boardTabStop,
  columnsFor, describeTableSort, isBoardKey, matchesHorizon, moneyLine, needsYear, outcomeWord, reverseClearedSort,
  snapshotMove, sortKeyOf, stageKey, viewToState,
  accountOf, civilDay, dealAmount, dealCloseDate, dealEnteredStage, dealPipeline, dealStage,
  dealWeighted, num, recordHref, str, totalsOf, useDealFormat, useDealProperties, usePipelines,
  useUserIndex, useUsers, useVelocities,
  type BoardGrid, type BoardState, type CalendarFormat, type DealListEnvelope, type DealRecord, type DealView,
  type Horizon, type OutcomeFilter, type Pipeline, type PipelineStage, type StageVelocity,
} from './api';
import { ViewBar } from './views';
import { NewDealDialog, StageMoveDialog, useUndoMove } from './dialogs';
import { BulkOwnerDialog, BulkStageDialog } from './bulk';
import { DisplaySwitch, type DealDisplay } from './display';
import { dealCsv, dealExportColumns } from './export-core';
import { downloadCsv, exportFilename, toCsv } from '../crm/csv';

const DAY_MS = 86_400_000;
const PAGE_SIZE = 200;

type Display = 'board' | 'table';

/** Where the keyboard should land after a stage-move dialog closes. */
const landedFrom = (move: { deal: DealRecord; stage: PipelineStage } | null) => (
  move ? { id: move.deal.id, stage: move.stage.name, pipeline: dealPipeline(move.deal) } : null
);

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
  deal, stages, currentStage, velocity, ownerName, reasonLabel, busy, dragging, tabStop, onOpen, onMove, onDragStart,
  onDragEnd, onFocus, onKeyDown,
}: {
  deal: DealRecord;
  stages: PipelineStage[];
  currentStage: PipelineStage | undefined;
  velocity: StageVelocity | undefined;
  ownerName: string | null;
  /** The close reason as the workspace labels it — what a closed card carries in place of a weighted chip. */
  reasonLabel: string | null;
  busy: boolean;
  dragging: boolean;
  /** This is the one card on the board that Tab reaches; the rest are arrowed to. */
  tabStop: boolean;
  onOpen: () => void;
  onMove: (stage: PipelineStage) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onFocus: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const f = useDealFormat();
  const session = useSession();
  const now = session.now();
  const card = useRef<HTMLLIElement>(null);
  const account = accountOf(deal);

  // The card's own menu carries every action on the deal, so it belongs in the
  // tab order beside the card that holds the tab stop — and out of it on the
  // other twenty-one. `MenuButton` takes no `tabIndex`, so it is set on the
  // element: the alternative is 22 extra tab stops, which is the defect.
  useEffect(() => {
    const menu = card.current?.querySelector<HTMLElement>('.pl-card__menu');
    if (menu) menu.tabIndex = tabStop ? 0 : -1;
  }, [tabStop]);
  const entered = dealEnteredStage(deal);
  const daysInStage = entered ? Math.floor((now - entered) / DAY_MS) : null;
  // A deal parked in Closed won has not stalled, it has finished — however long
  // it has sat there. The column header already refuses to count those; the card
  // did not, so a board whose closed stages have ever been left (a deal reopened,
  // a stage corrected) badged every finished deal "stalls after 3 days" while the
  // header above it reported none.
  const stalledAfter = currentStage?.is_closed ? null : velocity?.stalled_after_days ?? null;
  const stalled = daysInStage !== null && stalledAfter !== null && daysInStage > stalledAfter;
  const close = dealCloseDate(deal);
  // A close date is a calendar day: "overdue" is measured against the day the
  // workspace is on, not against this instant in UTC.
  const overdue = close !== null && f.calendarDaysUntil(close) < 0 && !currentStage?.is_closed;
  // A closed deal is not waiting anywhere. Its card leads with the outcome and
  // the day it closed, and carries the reason where an open card carries the
  // weighted figure — "95 days in stage" over a "$0.00" chip described a deal
  // that had finished as if it were still stuck.
  const outcome = outcomeWord(currentStage);
  const closeDate = close !== null ? f.calendarDate(close, { withYear: needsYear(close, f.calendarToday()) }) : null;

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
      ref={card}
      className={`pl-card${dragging ? ' is-dragging' : ''}${busy ? ' is-busy' : ''}`}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', deal.id); e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnd={onDragEnd}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      data-deal={deal.id}
      data-stage={currentStage?.name ?? ''}
    >
      <div className="pl-card__top">
        <button
          type="button"
          className="pl-card__name"
          tabIndex={tabStop ? 0 : -1}
          aria-keyshortcuts={tabStop ? 'ArrowUp ArrowDown ArrowLeft ArrowRight Home End' : undefined}
          onClick={onOpen}
          title={deal.display_name}
        >
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
        {outcome
          ? reasonLabel && (
            <Badge size="sm" tone={currentStage?.is_won ? 'success' : 'neutral'} title="Close reason">
              <span className="u-visually-hidden">Close reason: </span>{reasonLabel}
            </Badge>
          )
          : (
            <Badge size="sm" tone="info" title={`Weighted at ${num(deal.properties.probability)}%`}>
              <span className="u-visually-hidden">Weighted </span>{f.money(dealWeighted(deal))}
            </Badge>
          )}
      </div>

      <div className="pl-card__meta">
        {ownerName && <Avatar name={ownerName} seed={deal.owner_id ?? deal.id} size={18} title={ownerName} />}
        {outcome && (
          <span className={`pl-card__outcome${currentStage?.is_won ? ' is-won' : ' is-lost'}`}>
            {currentStage?.is_won ? <CheckCircleIcon size={11} /> : <XCircleIcon size={11} />}
            {' '}
            {outcome}{closeDate ? ` ${closeDate}` : ''}
          </span>
        )}
        {!outcome && closeDate && (
          <span className={overdue ? 'pl-card__stalled' : undefined}>
            <Icons.calendar size={11} /> {closeDate}
          </span>
        )}
        {!outcome && daysInStage !== null && (
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
  stage, pipeline, pipelineLabel, deals, stalled, velocity, ceiling, children, over, blocked, onDragOver,
  onDragLeave, onDrop, onAdd,
}: {
  stage: PipelineStage;
  pipeline: string;
  pipelineLabel: string;
  deals: DealRecord[];
  /** How many of the cards *on screen* are past this stage's own threshold. */
  stalled: number;
  velocity: StageVelocity | undefined;
  ceiling: number;
  children: React.ReactNode;
  over: boolean;
  /** A card from another pipeline is being held over this column, and cannot land. */
  blocked: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onAdd: () => void;
}) {
  const f = useDealFormat();
  const totals = totalsOf(deals);
  const share = ceiling > 0 ? Math.min(100, Math.round((totals.amount / ceiling) * 100)) : 0;
  // Counted over the cards drawn here, not over the stage: every other figure
  // in this header is, and a filtered column reading "0 deals · $0.00 · 2
  // stalled" is counting deals it is not showing. A deal in a closed stage is
  // finished, not stuck, however long it has sat there, so a closed column
  // never reports stalled deals at all.
  const medianLine = stage.is_closed
    ? 'Deals do not wait here'
    : velocity && velocity.median_days_in_stage > 0
      ? `Median ${f.plural(velocity.median_days_in_stage, 'day')} here${stalled > 0 ? ` · ${stalled} stalled` : ''}`
      : 'No median yet';

  return (
    // `tabIndex={-1}` keeps the column out of the Tab order — eight columns
    // before the first card would be punishing — while leaving it somewhere the
    // keyboard can be *put* when the card it was following has left the board.
    <section
      className={`pl-col${over && !blocked ? ' is-over' : ''}${over && blocked ? ' is-blocked' : ''}${stage.is_closed ? ' is-closed' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-label={`${stage.label} — ${f.plural(totals.deals, 'deal')}, ${f.money(totals.amount)}`}
      data-stage={stage.name}
      data-pipeline={pipeline}
      tabIndex={-1}
    >
      <header className="pl-col__head">
        <div className="pl-col__title">
          <Badge size="sm" tone={stage.is_won ? 'success' : stage.is_closed ? 'neutral' : 'info'}>{stage.probability}%</Badge>
          <span className="pl-col__name u-truncate" title={stage.description ?? stage.label}>{stage.label}</span>
          <span className="pl-col__count">{totals.deals}</span>
        </div>
        <div className="pl-col__money">
          <span className="pl-col__amount">{f.money(totals.amount)}</span>
          {/* Every header has the same rows, so the cards under them start on
              the same line: a closed column says how it counts where an open one
              quotes its weighted figure, and the median line is always drawn. */}
          <span className="pl-col__weighted">
            {stage.is_closed
              ? (stage.is_won ? 'Booked in full' : 'Nothing forecast')
              : `${f.money(totals.weighted)} weighted`}
          </span>
        </div>
        <div className="pl-col__bar"><span className="pl-col__barfill" style={{ width: `${share}%` }} /></div>
        {/* One line, always, so the cards below every header start together;
            the title carries the whole sentence for the narrowest column. */}
        <span className="pl-col__weighted pl-col__median" title={medianLine}>{medianLine}</span>
      </header>
      {/* Chromium makes an overflowing container focusable when nothing inside
          it is — which, with a roving tabindex over the cards, is every column
          but one. That put a tab stop back on each column and undid half the
          grid. The cards are reachable by arrow key and focusing one scrolls it
          into view, so the scroller needs no stop of its own. */}
      {over && blocked && (
        <div className="pl-col__blocked" role="status">
          <XCircleIcon size={13} />
          <span>Only {pipelineLabel} deals land here. Open the deal and use “Move to another pipeline”.</span>
        </div>
      )}
      <ol className="pl-col__body" tabIndex={-1}>
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
  // Won and lost deals sit in the closed stages, so narrowing to either turns
  // those columns on — a board filtered to "won" with the won column hidden is
  // an empty board with a badge on it.
  const status: OutcomeFilter = location.query.status === 'won' || location.query.status === 'lost' ? location.query.status : '';
  const showClosed = location.query.closed === '1' || status !== '';
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

  const known = useMemo(() => pipelines.data?.data ?? [], [pipelines.data]);

  /**
   * Whether the board is showing every pipeline at once.
   *
   * A pipeline actually named `all` wins, because the lookup below runs first —
   * the sentinel can only mean "every pipeline" in a workspace that has no
   * pipeline by that name.
   */
  const allMode = pipelineName === ALL_PIPELINES && !known.some((p) => p.name === ALL_PIPELINES);

  /** The pipeline everything single-pipeline hangs off: the one that is selected. */
  const board = useMemo(
    () => known.find((p) => p.name === pipelineName) ?? known.find((p) => p.is_default) ?? known[0],
    [known, pipelineName],
  );

  /** The pipelines drawn on this board — one, or every one of them. */
  const boards = useMemo(
    () => (allMode ? known : board ? [board] : []),
    [allMode, known, board],
  );

  const boardNames = useMemo(() => boards.map((p) => p.name), [boards]);
  const onBoard = useMemo(() => new Set(boardNames), [boardNames]);
  const pipelineByName = useMemo(() => new Map(known.map((p) => [p.name, p])), [known]);

  /**
   * How many deals have genuinely stopped moving.
   *
   * `/v1/pipelines/deal/:id/velocity` counts every record sitting in its stage
   * longer than that stage's own threshold, and a closed stage has a threshold
   * like any other — so the 25 deals parked in Closed won were counted as
   * stalled, and the tile read "28 stalled" over a board of 22 open deals. A
   * deal that has closed has not stalled, it has finished. Only the open stages
   * can stall, and the same rule already governs the figure this tile shows
   * once a filter is on, so the two now measure the same thing.
   *
   * Indexed by (pipeline, stage): all three pipelines have a `qualification`
   * stage, and a threshold learned from one of them is not a fact about the
   * others.
   */
  const velocity = useVelocities(boardNames);
  const velocityByStage = velocity.byStage;
  const stalledOpen = velocity.stalledOpen;

  const [newOpen, setNewOpen] = useState(location.query.new === '1');
  const [newStage, setNewStage] = useState<string | undefined>(undefined);
  const [newPipeline, setNewPipeline] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState<string | null>(null);
  // The same id, readable inside the very next dragover: the first one fires
  // before React has rendered the state above, and a column that judged the
  // card by stale state let a foreign card hover without recording it.
  const draggingRef = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /**
   * The foreign column a card was last held over, so letting go there gets an
   * answer. The browser only fires `drop` on a column that accepted the
   * dragover, and a column refusing a card from another pipeline used to
   * refuse it silently: no highlight, no drop, no toast — the card snapped back
   * and the person was left to guess whether the move had been declined or
   * had never been noticed.
   */
  const refused = useRef<{ deal: DealRecord; pipeline: string } | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [move, setMove] = useState<{ deal: DealRecord; stage: PipelineStage } | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  // Held here, not inside the grid: the tiles and the subtitle total the same
  // set the table shows, so the page cannot narrow in one place and not another.
  // The sort opens as whatever the toolbar says, so the two controls agree from
  // the first paint.
  const [tableState, setTableState] = useState<TableState>(
    () => ({ query: '', sort: TABLE_SORT[sortKey] ?? TABLE_SORT.amount, filters: {} }),
  );
  const [bulkStage, setBulkStage] = useState<PipelineStage | null>(null);
  const [bulkOwner, setBulkOwner] = useState(false);
  const [bulkDone, setBulkDone] = useState(0);
  const [refocus, setRefocus] = useState<{ id: string; stage: string; pipeline: string } | null>(null);
  const newDealButton = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (location.query.new === '1') setNewOpen(true); }, [location.query.new]);

  const closeNew = useCallback(() => {
    setNewOpen(false);
    setNewStage(undefined);
    setNewPipeline(undefined);
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

  /**
   * A drop lands the moment the pointer is released — there is no confirmation
   * on an open-to-open move and there should not be one — so the way back
   * travels with the notification instead.
   */
  const offerUndo = useUndoMove();

  const moveNow = useMutation<{ deal: DealRecord; stage: PipelineStage }, DealRecord>(
    ({ deal, stage }) => api.patch<DealRecord>(`/v1/records/deal/${encodeURIComponent(deal.id)}`, {
      properties: { deal_stage: stage.name },
    }),
    {
      invalidates: ['/v1/records/deal', '/v1/pipelines', '/v1/crm/overview'],
      onSuccess: (updated, args) => {
        const from = board?.stages.find((s) => s.name === dealStage(args.deal));
        toast.success(
          `Moved to ${args.stage.label}`,
          `${updated.display_name} now forecasts ${f.money(num(updated.properties.weighted_amount))} at ${num(updated.properties.probability)}%.`,
          { action: offerUndo(snapshotMove(args.deal, { deal_stage: args.stage.name }), from?.label ?? 'its old stage') },
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
    // Past this the card has had every chance to come back; if it has not, it
    // is not going to, and waiting out the rest of the window would leave the
    // caret on `<body>` for another second.
    const settled = Date.now() + 800;
    const lostFocus = () => !document.activeElement || document.activeElement === document.body;
    const land = () => {
      if (cancelled) return;
      // The card is remounted twice — once when the optimistic move drops it in
      // its new column, again when the server's answer replaces it — and each
      // remount drops whatever was focused inside it. So the caret is put back
      // for as long as the move takes, and only ever when it has been lost:
      // a person who has clicked somewhere else keeps their focus.
      const card = document.querySelector<HTMLElement>(`.pl-card[data-deal="${CSS.escape(refocus.id)}"]`);
      const target = card?.querySelector<HTMLElement>('.pl-card__menu') ?? card?.querySelector<HTMLElement>('.pl-card__name');
      if (lostFocus() && target) target.focus();
      const gone = !card && Date.now() > settled;
      if (!gone && Date.now() < until) { timer = window.setTimeout(land, 60); return; }
      // A close through the dialog usually ends with the card nowhere on the
      // board — closed stages are hidden by default, and a filtered board drops
      // it too. Landing on the destination column announces where it went; the
      // header's own primary action is the last resort, and both beat `<body>`,
      // which is 25 Tab stops from anything on this page.
      if (lostFocus()) {
        const column = document.querySelector<HTMLElement>(
          `.pl-col[data-pipeline="${CSS.escape(refocus.pipeline)}"][data-stage="${CSS.escape(refocus.stage)}"]`,
        );
        (column ?? newDealButton.current)?.focus();
      }
      setRefocus(null);
    };
    timer = window.setTimeout(land, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [refocus]);

  /**
   * The one key over the sidebar, the top bar and the whole toolbar.
   *
   * It lands on the card the grid's own arrow keys start from — the first card
   * of the first column — rather than on the board container, because a
   * container that only holds `tabIndex={-1}` columns announces nothing and
   * leaves the next Tab back at the top of the toolbar. When the board is
   * empty there is no card, so the region takes the caret and the empty state
   * inside it is what gets read.
   */
  const focusFirstCard = useCallback(() => {
    const card = document.querySelector<HTMLElement>('.pl-card__name[tabindex="0"]')
      ?? document.querySelector<HTMLElement>('.pl-card__name')
      ?? document.querySelector<HTMLElement>('#pl-board');
    card?.focus();
    card?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, []);

  /**
   * Put the keyboard back in the grid after a bulk write.
   *
   * `Modal` restores focus to whatever opened it, and what opened these two is
   * a button inside the table's bulk bar — which is gone by the time the dialog
   * closes, because the write cleared the selection that drew it. So the
   * restore lands on `<body>`, 49 Tab presses from anything on this page. The
   * grid's own entry row is where the next action is.
   */
  useEffect(() => {
    if (!bulkDone) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const row = document.querySelector<HTMLElement>('.ain-table tbody tr[tabindex]');
      (row ?? newDealButton.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [bulkDone]);

  const requestMove = useCallback((deal: DealRecord, stage: PipelineStage) => {
    if (dealStage(deal) === stage.name) return;
    const props = properties.data?.data ?? [];
    const needs = stage.is_closed
      || props.some((p) => p.required && !p.read_only && !p.calculated
        && (deal.properties[p.name] === undefined || deal.properties[p.name] === null || deal.properties[p.name] === ''));
    if (needs) { setMove({ deal, stage }); return; }
    setPending((prev) => ({ ...prev, [deal.id]: stage.name }));
    setRefocus({ id: deal.id, stage: stage.name, pipeline: dealPipeline(deal) });
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
    const rows = (deals.data?.data ?? []).filter((deal) => !deal.archived && onBoard.has(dealPipeline(deal)));
    return rows.filter((deal) => {
      if (forecast && str(deal.properties.forecast_category) !== forecast) return false;
      if (status && str(deal.properties.deal_status) !== status) return false;
      return matchesHorizon(dealCloseDate(deal), horizon, today);
    });
  }, [deals.data, onBoard, forecast, status, horizon, today]);

  /** The columns each drawn pipeline contributes, in pipeline order. */
  const columnsOf = useCallback(
    (pipeline: Pipeline) => columnsFor(pipeline.stages, showClosed, status),
    [showClosed, status],
  );

  /** Every column on screen, keyed by the pipeline it belongs to as well as its name. */
  const columnKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const pipeline of boards) for (const stage of columnsOf(pipeline)) keys.add(stageKey(pipeline.name, stage.name));
    return keys;
  }, [boards, columnsOf]);

  const keyOf = useCallback((deal: DealRecord) => stageKey(dealPipeline(deal), stageOf(deal)), [stageOf]);

  // Both views show the same set: hiding the closed columns has to take those
  // deals out of the table as well, or the header count and the grid disagree.
  const inView = useMemo(
    () => visible.filter((deal) => columnKeys.has(keyOf(deal))),
    [columnKeys, visible, keyOf],
  );

  const byStage = useMemo(() => {
    const map = new Map<string, DealRecord[]>();
    for (const key of columnKeys) map.set(key, []);
    for (const deal of inView) map.get(keyOf(deal))?.push(deal);
    return map;
  }, [columnKeys, inView, keyOf]);

  /**
   * The tallest column's money, per pipeline.
   *
   * The bar under a column head is that column's share of the biggest one, and
   * on an all-pipelines board a single workspace-wide ceiling flattens a small
   * pipeline into three invisible slivers. Each pipeline is scaled against its
   * own busiest stage, which is the comparison the bar is there to make.
   */
  const ceilings = useMemo(() => {
    const map = new Map<string, number>();
    for (const pipeline of boards) {
      let top = 0;
      for (const stage of columnsOf(pipeline)) {
        top = Math.max(top, totalsOf(byStage.get(stageKey(pipeline.name, stage.name)) ?? []).amount);
      }
      map.set(pipeline.name, top);
    }
    return map;
  }, [boards, columnsOf, byStage]);

  /**
   * The board as a grid of deal ids, column by column in the order they are
   * drawn — the value the keyboard moves around in.
   */
  const grid = useMemo<BoardGrid>(
    () => boards.flatMap((pipeline) => columnsOf(pipeline)
      .map((stage) => (byStage.get(stageKey(pipeline.name, stage.name)) ?? []).map((deal) => deal.id))),
    [boards, columnsOf, byStage],
  );

  const [roving, setRoving] = useState<string | null>(null);
  const tabStop = boardTabStop(grid, roving);

  const focusCard = useCallback((id: string) => {
    const card = document.querySelector<HTMLElement>(`.pl-card[data-deal="${CSS.escape(id)}"]`);
    (card?.querySelector<HTMLElement>('.pl-card__name') ?? card)?.focus();
  }, []);

  /**
   * Arrow keys across the board, the way every other grid on this platform
   * moves. Anything else — Tab, Enter, the menu's own keys — is left alone.
   */
  const onCardKey = useCallback((id: string, e: React.KeyboardEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey || !isBoardKey(e.key)) return;
    const next = boardMove(grid, id, e.key);
    if (!next) return;
    e.preventDefault();
    setRoving(next);
    focusCard(next);
  }, [grid, focusCard]);

  const boardShown = inView.length;
  const toolbarFiltered = !!query || !!owner || !!forecast || !!status || horizon !== 'all';
  const truncated = !!deals.data?.has_more;

  const toolbarSummary = useMemo(() => [
    query && `“${query}”`,
    owner && (userIndex.get(owner)?.name ?? owner),
    forecast && humanize(forecast),
    status && `closed ${status}`,
    horizon !== 'all' && HORIZON_LABEL[horizon].toLowerCase(),
  ].filter(Boolean), [query, owner, forecast, status, horizon, userIndex]);

  const stageByKey = useMemo(() => {
    const map = new Map<string, PipelineStage>();
    for (const pipeline of known) for (const stage of pipeline.stages) map.set(stageKey(pipeline.name, stage.name), stage);
    return map;
  }, [known]);

  /** The stage a deal is actually in, read from its own pipeline's stage list. */
  const stageFor = useCallback((deal: DealRecord) => stageByKey.get(keyOf(deal)), [stageByKey, keyOf]);

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
    pipeline: allMode ? ALL_PIPELINES : board?.name ?? pipelineName,
    owner,
    forecast,
    horizon,
    sort: sortKey,
    closed: showClosed,
  }), [allMode, board?.name, pipelineName, owner, forecast, horizon, sortKey, showClosed]);

  const applyView = useCallback((view: DealView | null) => {
    if (!view) { setQuery({ view: undefined }); return; }
    const { state, readable } = viewToState(view, today);
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
  }, [setQuery, toast, today]);

  const pipelineLabel = useCallback(
    (name: string) => (name === ALL_PIPELINES ? 'Every pipeline' : pipelineByName.get(name)?.label ?? name),
    [pipelineByName],
  );
  const ownerName = useCallback(
    (id: string) => userIndex.get(id)?.name ?? id,
    [userIndex],
  );
  const forecastLabel = useCallback((value: string) => {
    const property = (properties.data?.data ?? []).find((p) => p.name === 'forecast_category');
    return property?.options?.find((option) => option.value === value)?.label ?? humanize(value);
  }, [properties.data]);

  /**
   * The reason a closed deal closed for, as the workspace's own picklist labels
   * it. The card shows it where an open card shows its weighted figure; a deal
   * closed with no reason recorded shows nothing there rather than a guess.
   */
  const reasonLabel = useCallback((deal: DealRecord): string | null => {
    const value = str(deal.properties.close_reason);
    if (!value) return null;
    const property = (properties.data?.data ?? []).find((p) => p.name === 'close_reason');
    return property?.options?.find((option) => option.value === value)?.label ?? humanize(value);
  }, [properties.data]);

  // Clearing has to reset the box as well as the address: the search text is
  // held here and written into the URL, so dropping only the parameter puts it
  // straight back on the next debounce.
  const clearFilters = useCallback(() => {
    setSearch('');
    setQueryText('');
    setTableState((state) => ({ ...state, query: '', filters: {} }));
    setQuery({ q: undefined, owner: undefined, forecast: undefined, status: undefined, horizon: undefined, view: undefined });
  }, [setQuery]);

  /* --------------------------------- table -------------------------------- */

  // The label its own pipeline gives that stage. Reading it off whichever
  // pipeline is selected renders an Expansion deal sitting in "Expansion
  // identified" as "Qualification", because both pipelines call that stage
  // `qualification` internally.
  const stageLabel = useCallback(
    (deal: DealRecord) => stageFor(deal)?.label ?? humanize(stageOf(deal)),
    [stageFor, stageOf],
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
    ...(allMode ? [{
      id: 'pipeline',
      header: 'Pipeline',
      width: 150,
      accessor: (row: DealRecord) => pipelineLabel(dealPipeline(row)),
      filter: 'set' as const,
      cell: (row: DealRecord) => pipelineLabel(dealPipeline(row)),
    }] : []),
    {
      id: 'stage',
      header: 'Stage',
      width: 160,
      accessor: (row) => stageLabel(row),
      filter: 'set',
      cell: (row) => <Badge size="sm" tone="info">{stageLabel(row)}</Badge>,
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
    {
      // Hidden until asked for, but sortable from the toolbar: "Recently
      // updated" is one of the four orders the board offers, and an order the
      // table cannot show is an order the two controls cannot agree on.
      id: 'updated',
      header: 'Updated',
      width: 130,
      sortable: true,
      defaultHidden: true,
      unsearchable: true,
      accessor: (row) => row.updated,
      cell: (row) => f.relative(row.updated),
    },
  ], [allMode, f, now, pipelineLabel, stageLabel, userIndex]);

  /**
   * One sort, read and written by two controls.
   *
   * On the table the grid's own sort state is the truth — a header click is
   * the most direct way to say "by close date" — and the toolbar reflects it:
   * as the option that means the same thing when there is one, and as a
   * named custom order when there is not. Choosing from the toolbar writes the
   * grid's sort back, and the address, so the board opens in the same order
   * when the view switches. It used to be two truths: the header sorted the
   * grid ascending by close date while the toolbar went on reading "Largest
   * first".
   */
  const tableSortKey = display === 'table' ? sortKeyOf(tableState.sort) ?? CUSTOM_SORT : sortKey;
  const sortOptions = useMemo<SelectOption[]>(() => {
    const options = SORTS.map<SelectOption>((option) => ({ value: option.value, label: option.label }));
    if (tableSortKey !== CUSTOM_SORT || !tableState.sort) return options;
    const column = tableColumns.find((c) => c.id === tableState.sort?.columnId);
    const header = typeof column?.header === 'string' ? column.header : tableState.sort.columnId;
    return [...options, { value: CUSTOM_SORT, label: describeTableSort(tableState.sort, header) }];
  }, [tableSortKey, tableState.sort, tableColumns]);

  const chooseSort = useCallback((next: string) => {
    if (next === CUSTOM_SORT) return;
    setQuery({ sort: next === 'amount' ? undefined : next });
    setTableState((prev) => ({ ...prev, sort: TABLE_SORT[next] ?? prev.sort }));
  }, [setQuery]);

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
    return narrowed.filter((deal) => columnKeys.has(keyOf(deal)));
  }, [tableNarrows, inView, narrowed, columnKeys, keyOf]);

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
    let lost = 0;
    let stalled = 0;
    let openDeals = 0;
    let wonDeals = 0;
    let lostDeals = 0;
    for (const deal of narrowed) {
      const stage = stageFor(deal);
      if (stage?.is_won) { won += dealAmount(deal); wonDeals += 1; continue; }
      if (stage?.is_closed) { lost += dealAmount(deal); lostDeals += 1; continue; }
      open += dealAmount(deal);
      weighted += dealWeighted(deal);
      openDeals += 1;
      const entered = dealEnteredStage(deal);
      const stallsAfter = velocityByStage.get(keyOf(deal))?.stalled_after_days ?? 0;
      if (entered && stallsAfter > 0 && Math.floor((now - entered) / DAY_MS) > stallsAfter) stalled += 1;
    }
    return { open, weighted, won, lost, stalled, openDeals, wonDeals, lostDeals, deals: narrowed.length };
  }, [narrowed, stageFor, keyOf, velocityByStage, now]);

  /**
   * The server's own totals for the pipelines on screen.
   *
   * `/v1/pipelines/deal` publishes them per pipeline; showing several at once
   * adds them up rather than recomputing anything from the page of deals, so
   * the unfiltered tiles stay whole-set figures however many pipelines are on.
   */
  const boardTotals = useMemo(() => {
    let open = 0;
    let weighted = 0;
    let won = 0;
    let records = 0;
    for (const pipeline of boards) {
      open += pipeline.open_amount ?? 0;
      weighted += pipeline.weighted_amount ?? 0;
      won += pipeline.won_amount ?? 0;
      records += pipeline.record_count;
    }
    return { open, weighted, won, records };
  }, [boards]);

  // A median is a property of one pipeline's own closed deals; there is no
  // honest way to average three of them, so the all-pipelines board says what
  // it is showing instead of quoting a number nothing measured.
  const medianDaysToClose = !allMode && board
    ? velocity.byPipeline.get(board.name)?.median_days_to_close ?? null
    : null;

  /**
   * The rows on screen, as a file.
   *
   * What the table shows is what leaves: the toolbar's filters, the table's own
   * search and column filters, and the closed-stages switch all apply, so the
   * export of "Priya's commit this quarter" is exactly those rows. Values are
   * the stored ones — money as a decimal, the close date as an ISO day — the
   * same shape the CRM's contact and company exports use.
   */
  const exportRows = useCallback(() => {
    const columns = dealExportColumns({
      allMode,
      major: (minor) => toMajorUnits(minor, session.currency),
      now,
      accountName: (row) => accountOf(row as DealRecord)?.display_name ?? '',
      pipelineLabel: (row) => pipelineLabel(dealPipeline(row as DealRecord)),
      stageLabel: (row) => stageLabel(row as DealRecord),
      ownerName: (id) => (id ? userIndex.get(id)?.name ?? id : ''),
    });
    const { headers, lines } = dealCsv(gridRows, columns);
    const label = allMode ? 'Deals' : `Deals ${board?.label ?? ''}`;
    downloadCsv(exportFilename(label, now, session.timeZone), toCsv(headers, lines));
    toast.success(
      `${f.plural(gridRows.length, 'deal')} exported`,
      'The rows on screen, with the filters applied. Money is a decimal and dates are ISO-8601, ready for a spreadsheet.',
    );
  }, [allMode, board?.label, f, gridRows, now, pipelineLabel, session.currency, session.timeZone, stageLabel, toast, userIndex]);

  const rowActions = useCallback((row: DealRecord): MenuSection[] => [
    { id: 'open', items: [{ id: 'open', label: 'Open deal', icon: <Icons.external size={14} />, onSelect: () => openDeal(row) }] },
    {
      // A deal's stages are its own pipeline's stages. Offering the selected
      // pipeline's list would put "Move to Renewal outreach" on a new-business
      // deal, which is a pipeline change the record page does properly.
      id: 'move',
      label: 'Move to stage',
      items: (pipelineByName.get(dealPipeline(row))?.stages ?? [])
        .filter((stage) => stage.name !== stageOf(row))
        .map((stage) => ({
          id: stage.name,
          label: stage.label,
          description: `${stage.probability}%`,
          onSelect: () => requestMove(row, stage),
        })),
    },
  ], [pipelineByName, openDeal, requestMove, stageOf]);

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
        ? boardHeadline({
          shown,
          where: allMode ? `across ${f.plural(boards.length, 'pipeline')}` : `on ${board.label}`,
          showClosed,
          status,
          open: totalsOf(onScreen.filter((deal) => !stageFor(deal)?.is_closed)),
          closed: totalsOf(onScreen.filter((deal) => !!stageFor(deal)?.is_closed)),
          plural: f.plural,
          money: f.money,
        })
        : 'Deals, by stage';

  return (
    <Page
      title="Deals"
      subtitle={headline}
      width="wide"
      actions={
        <>
          <DisplaySwitch
            value={display}
            onChange={(next: DealDisplay) => {
              if (next !== 'forecast') { setQuery({ display: next === 'board' ? undefined : next }); return; }
              // The forecast keeps the pipeline and, when the window is one it
              // reads over, the close-date window; the rest of the toolbar is
              // the board's own business.
              const params = new URLSearchParams();
              if (allMode) params.set('pipeline', ALL_PIPELINES);
              else if (board) params.set('pipeline', board.name);
              if (['quarter', 'next_quarter', 'last_quarter', 'year'].includes(horizon)) params.set('period', horizon);
              navigate(`/deals/forecast?${params.toString()}`);
            }}
          />
          <Button ref={newDealButton} variant="primary" iconLeft={<Icons.plus size={14} />} onClick={() => setNewOpen(true)}>
            New deal
          </Button>
        </>
      }
    >
      {/* Thirty-six Tab presses from a fresh load to the first deal card: sixteen
          through the sidebar, nine through the top bar, ten more through the
          view toggle, the filters and the search box. The copilot has had a skip
          link for this since its own tunnel was measured; the board is the
          screen people live on and had none. It is the first focusable thing
          here, and it lands on the card the arrow keys start from. */}
      <a
        className="pl-skip"
        href="#pl-board"
        onClick={(e) => {
          e.preventDefault();
          focusFirstCard();
        }}
      >
        Skip to the board
      </a>

      {board && (
        <div className="pl-summary">
          <Card padding="tight">
            <Stat
              label={<StatLabel filtered={filtered}>Open pipeline</StatLabel>}
              value={unmeasured ? '—' : f.money(filtered ? filteredTotals.open : boardTotals.open)}
              icon={<Icons.funnel size={15} />}
              caption={unmeasured
                ? unmeasuredWhy
                : filtered
                  ? `${f.plural(filteredTotals.openDeals, 'open deal')} matching ${filterSummary}`
                  : `${f.plural(boardTotals.records, 'deal')} have passed through ${allMode ? `${f.plural(boards.length, 'pipeline')}` : board.label}`}
            />
          </Card>
          <Card padding="tight">
            <Stat
              label={<StatLabel filtered={filtered}>Weighted forecast</StatLabel>}
              value={unmeasured ? '—' : f.money(filtered ? filteredTotals.weighted : boardTotals.weighted)}
              icon={<Icons.target size={15} />}
              caption={unmeasured ? unmeasuredWhy : 'Each open deal at its stage probability'}
            />
          </Card>
          <Card padding="tight">
            {/* Narrowed to the lost deals, the tile that would otherwise read
                "Closed won · $0.00" is the one figure the filter is about. */}
            {status === 'lost' ? (
              <Stat
                label={<StatLabel filtered={filtered}>Closed lost</StatLabel>}
                value={unmeasured ? '—' : f.money(filteredTotals.lost)}
                icon={<XCircleIcon size={15} />}
                caption={unmeasured ? unmeasuredWhy : `${f.plural(filteredTotals.lostDeals, 'lost deal')} in this filter`}
              />
            ) : (
              <Stat
                label={<StatLabel filtered={filtered}>Closed won</StatLabel>}
                value={unmeasured ? '—' : f.money(filtered ? filteredTotals.won : boardTotals.won)}
                icon={<CheckCircleIcon size={15} />}
                caption={unmeasured
                  ? unmeasuredWhy
                  : filtered
                    ? `${f.plural(filteredTotals.wonDeals, 'won deal')} in this filter`
                    : allMode
                      ? `Booked across ${f.plural(boards.length, 'pipeline')}`
                      : medianDaysToClose !== null
                        ? `Median ${f.plural(medianDaysToClose, 'day')} to close`
                        : 'Booked on this pipeline'}
              />
            )}
          </Card>
          <Card padding="tight">
            <Stat
              label={<StatLabel filtered={filtered}>Stalled</StatLabel>}
              value={unmeasured
                ? '—'
                : filtered
                  ? f.number(filteredTotals.stalled)
                  : velocity.byStage.size ? f.number(stalledOpen) : '—'}
              icon={<AlertTriangleIcon size={15} />}
              caption={unmeasured ? unmeasuredWhy : "Open deals sitting longer than twice their stage's median"}
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
          value={allMode ? ALL_PIPELINES : board?.name ?? ''}
          onChange={(next) => setQuery({ pipeline: next })}
          size="sm"
          icon={<Icons.layers size={13} />}
          aria-label="Pipeline"
          options={[
            ...known.map<SelectOption>((p) => ({
              value: p.name,
              label: `${p.label}${p.is_default ? ' (default)' : ''}`,
            })),
            // Offered only when it means something: with one pipeline in the
            // workspace, "every pipeline" is the pipeline.
            ...(known.length > 1 && !known.some((p) => p.name === ALL_PIPELINES)
              ? [{ value: ALL_PIPELINES, label: 'Every pipeline' }]
              : []),
          ]}
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
          options={HORIZONS.map<SelectOption>((value) => ({ value, label: HORIZON_LABEL[value] }))}
        />
        <Select
          value={tableSortKey}
          onChange={chooseSort}
          size="sm"
          icon={<SortDescIcon size={13} />}
          aria-label="Sort deals"
          options={sortOptions}
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
          // Narrowed to won or lost, the closed columns are the whole board;
          // the switch has nothing to turn off until that narrowing is cleared.
          disabled={status !== ''}
        />
        {status && (
          <Button
            size="sm"
            variant="secondary"
            className="pl-toolbar__status"
            title="Clear this filter"
            iconLeft={status === 'won' ? <CheckCircleIcon size={13} /> : <XCircleIcon size={13} />}
            iconRight={<XIcon size={12} />}
            onClick={() => setQuery({ status: undefined })}
          >
            Closed {status} only<span className="u-visually-hidden"> — clear this filter</span>
          </Button>
        )}
      </div>

      {truncated && (
        <Banner tone="info" compact bar>
          Showing the first {f.number(PAGE_SIZE)} deals of {f.number(deals.data?.total_count ?? 0)} by {sort.label.toLowerCase()}.
          The stat cards above are computed by the server over every deal on {allMode ? 'every pipeline' : 'this pipeline'}; the column totals cover the ones on screen.
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
              <Button variant="primary" iconLeft={<Icons.refresh size={14} />} onClick={() => { deals.refetch(); pipelines.refetch(); velocity.refetch(); }}>
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
          size={filtered || display !== 'board' ? 'md' : 'sm'}
          inline={!filtered && display === 'board'}
          illustration={!filtered && display === 'board' ? null : undefined}
          title={filtered ? 'No deal matches these filters' : `${allMode ? 'No pipeline' : board.label} has ${allMode ? 'any' : 'no'} deals yet`}
          body={filtered
            ? `Nothing on ${allMode ? 'any pipeline' : board.label} matches ${filterSummary}.`
            : `Open the first opportunity and it lands in ${board.stages[0]?.label ?? 'the first stage'} at ${board.stages[0]?.probability ?? 0}% — or add it straight into a stage below.`}
          action={filtered
            ? <Button variant="primary" onClick={clearFilters}>Clear filters</Button>
            : <Button variant="primary" iconLeft={<Icons.plus size={14} />} onClick={() => setNewOpen(true)}>New deal</Button>}
          secondaryAction={filtered ? <Button onClick={() => setNewOpen(true)}>New deal</Button> : undefined}
        />
      )}

      {/* An empty pipeline still has stages, and each one takes a deal. The
          board used to vanish entirely behind the empty state, so a brand-new
          pipeline showed no column to add into — while the all-pipelines strip
          drew them with "Add a deal here". A filtered-to-nothing board keeps
          the plain empty state: its columns would all be empty for a reason
          the message already gives. */}
      {!error && !loading && board && (populated > 0 || !filtered) && display === 'board' && (
      <div
        id="pl-board"
        tabIndex={-1}
        className={`pl-boardregion${populated === 0 ? ' pl-board--empty' : ''}${status ? ' pl-board--outcome' : ''}`}
        aria-label="Deal board"
      >
      {boards.map((pipeline) => {
        const strip = columnsOf(pipeline);
        const rows = strip.flatMap((stage) => byStage.get(stageKey(pipeline.name, stage.name)) ?? []);
        const openRows = rows.filter((deal) => !stageFor(deal)?.is_closed);
        const closedRows = rows.filter((deal) => !!stageFor(deal)?.is_closed);
        // With every pipeline on and a filter narrowing them, a pipeline that
        // holds no match is one line rather than five columns of "Add a deal
        // here" — which is what pushed Priya's four commit deals below the fold.
        const collapsed = allMode && toolbarFiltered && rows.length === 0;
        return (
          <section className={`pl-strip${collapsed ? ' pl-strip--collapsed' : ''}`} key={pipeline.name} aria-label={pipeline.label}>
            {allMode && (
              <header className="pl-strip__head">
                <h2 className="pl-strip__name">{pipeline.label}</h2>
                <span className="pl-strip__meta">
                  {collapsed
                    ? `Nothing on ${pipeline.label} matches`
                    : `${f.plural(rows.length, 'deal')} · ${moneyLine({ status, open: totalsOf(openRows), closed: totalsOf(closedRows), money: f.money })}`}
                </span>
                {!collapsed && (
                  <Button
                    size="sm"
                    variant="link"
                    onClick={() => setQuery({ pipeline: pipeline.name })}
                  >
                    Only {pipeline.label}
                  </Button>
                )}
              </header>
            )}
            {!collapsed && (
            <div className="pl-board">
              {strip.map((stage) => {
                const key = stageKey(pipeline.name, stage.name);
                const held = byStage.get(key) ?? [];
                const after = velocityByStage.get(key)?.stalled_after_days ?? 0;
                const stalled = after <= 0 ? 0 : held.filter((deal) => {
                  const entered = dealEnteredStage(deal);
                  return entered !== null && Math.floor((now - entered) / DAY_MS) > after;
                }).length;
                // A card can only be dropped into its own pipeline: dragging a
                // renewal into a new-business column would be a pipeline change,
                // which the deal record does properly and a drop cannot say.
                const dragged = dragging ? inView.find((row) => row.id === dragging) : undefined;
                const draggedHere = !!dragged && dealPipeline(dragged) === pipeline.name;
                const blocked = !!dragged && !draggedHere;
                return (
                  <StageColumn
                    key={key}
                    stage={stage}
                    pipeline={pipeline.name}
                    pipelineLabel={pipeline.label}
                    deals={held}
                    stalled={stalled}
                    velocity={velocityByStage.get(key)}
                    ceiling={ceilings.get(pipeline.name) ?? 0}
                    over={over === key}
                    blocked={blocked}
                    onDragOver={(e) => {
                      // A foreign card is still accepted as a hover, so the
                      // column can say why it will not take it; the effect
                      // tells the pointer the same thing.
                      e.preventDefault();
                      const heldId = draggingRef.current;
                      const held = heldId ? inView.find((row) => row.id === heldId) : undefined;
                      const foreign = !!held && dealPipeline(held) !== pipeline.name;
                      e.dataTransfer.dropEffect = foreign ? 'none' : 'move';
                      if (foreign && held) refused.current = { deal: held, pipeline: pipeline.name };
                      setOver(key);
                    }}
                    onDragLeave={() => {
                      setOver((current) => (current === key ? null : current));
                      if (refused.current?.pipeline === pipeline.name) refused.current = null;
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setOver(null);
                      refused.current = null;
                      const id = e.dataTransfer.getData('text/plain') || draggingRef.current;
                      draggingRef.current = null;
                      setDragging(null);
                      const deal = inView.find((row) => row.id === id);
                      if (!deal) return;
                      if (dealPipeline(deal) !== pipeline.name) {
                        toast.info(
                          'That deal is on another pipeline',
                          `${deal.display_name} is on ${pipelineLabel(dealPipeline(deal))}. Open it and use “Move to another pipeline” — the stage and the forecast are restamped together.`,
                        );
                        return;
                      }
                      requestMove(deal, stage);
                    }}
                    onAdd={() => { setNewStage(stage.name); setNewPipeline(pipeline.name); setNewOpen(true); }}
                  >
                    {held.map((deal) => (
                      <DealCard
                        key={deal.id}
                        deal={deal}
                        stages={pipeline.stages}
                        currentStage={stageFor(deal)}
                        velocity={velocityByStage.get(keyOf(deal))}
                        ownerName={deal.owner_id ? userIndex.get(deal.owner_id)?.name ?? null : null}
                        reasonLabel={reasonLabel(deal)}
                        busy={!!pending[deal.id]}
                        dragging={dragging === deal.id}
                        tabStop={deal.id === tabStop}
                        onFocus={() => setRoving(deal.id)}
                        onKeyDown={(e) => onCardKey(deal.id, e)}
                        onOpen={() => openDeal(deal)}
                        onMove={(stageTo) => requestMove(deal, stageTo)}
                        onDragStart={() => { draggingRef.current = deal.id; setDragging(deal.id); }}
                        onDragEnd={() => {
                          draggingRef.current = null;
                          setDragging(null);
                          setOver(null);
                          // Let go over a column that would not take it: no
                          // drop fired, so the answer is given here.
                          const held = refused.current;
                          refused.current = null;
                          if (held) {
                            toast.info(
                              'That deal is on another pipeline',
                              `${held.deal.display_name} is on ${pipelineLabel(dealPipeline(held.deal))}, so it cannot be dropped into ${pipelineLabel(held.pipeline)}. Open it and use “Move to another pipeline” — the stage and the forecast are restamped together.`,
                            );
                          }
                        }}
                      />
                    ))}
                  </StageColumn>
                );
              })}
            </div>
            )}
          </section>
        );
      })}
      </div>
      )}

      {!error && !loading && board && populated > 0 && display === 'table' && (
        <DataTable<DealRecord>
          rows={inView}
          columns={tableColumns}
          getRowId={(row) => row.id}
          caption={allMode ? 'Deals across every pipeline' : `Deals on ${board.label}`}
          onRowClick={openDeal}
          rowActions={rowActions}
          selectable
          selected={selection}
          onSelectionChange={setSelection}
          bulkActions={(ids) => {
            const picked = inView.filter((row) => ids.includes(row.id));
            const totals = totalsOf(picked);
            // Stages belong to a pipeline. A selection spanning two of them has
            // no shared stage list, so the menu says which pipelines are in the
            // way rather than offering a move that would silently mean two
            // different things.
            const spans = [...new Set(picked.map(dealPipeline))];
            const one = spans.length === 1 ? pipelineByName.get(spans[0]) : undefined;
            return (
              <>
                <span className="ain-table__bulknote">
                  {f.money(totals.amount)} · {f.money(totals.weighted)} weighted
                </span>
                {!one && (
                  <span className="ain-table__bulknote">
                    On {spans.map(pipelineLabel).join(' and ')} — pick one pipeline to move stage.
                  </span>
                )}
                {one && (
                <MenuButton
                  size="sm"
                  variant="secondary"
                  label="Move the selected deals to a stage"
                  icon={<GitBranchIcon size={13} />}
                  sections={[{
                    id: 'stages',
                    label: `Move to a ${one.label} stage`,
                    // A deal already sitting in the destination is not moved, so
                    // it is not quoted either: this preview is computed over the
                    // same set the confirmation will commit.
                    items: (one?.stages ?? []).map((stage) => {
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
                )}
                <Button size="sm" variant="secondary" iconLeft={<Icons.user size={13} />} onClick={() => setBulkOwner(true)}>
                  Reassign
                </Button>
              </>
            );
          }}
          toolbar={(
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<Icons.download size={13} />}
              disabled={gridRows.length === 0}
              onClick={exportRows}
            >
              Export CSV
            </Button>
          )}
          searchable
          searchPlaceholder="Filter the deals on screen"
          stickyFooter
          showColumnToggle
          showFilters
          value={tableState}
          onChange={(next) => setTableState((prev) => reverseClearedSort(prev, next))}
          footer={(
            <span className="pl-note">
              {f.plural(gridRows.length, 'deal')} {allMode ? `across ${f.plural(boards.length, 'pipeline')}` : `on ${board.label}`}
              {showClosed ? '' : ', open stages only'}
            </span>
          )}
        />
      )}

      <NewDealDialog
        open={newOpen}
        onClose={closeNew}
        pipelines={pipelines.data?.data ?? []}
        properties={properties.data?.data ?? []}
        users={users.data?.data ?? []}
        defaultPipeline={newPipeline ?? (allMode ? known.find((p) => p.is_default)?.name ?? known[0]?.name : board?.name)}
        defaultStage={newStage}
        onCreated={(deal) => navigate(recordHref('deal', deal.id))}
      />

      <BulkStageDialog
        open={!!bulkStage}
        deals={inView.filter((row) => selection.includes(row.id))}
        stage={bulkStage}
        stages={bulkStage
          ? known.find((p) => p.stages.some((s) => s.name === bulkStage.name && s.id === bulkStage.id))?.stages ?? []
          : []}
        properties={properties.data?.data ?? []}
        onClose={() => setBulkStage(null)}
        onDone={() => { setBulkStage(null); setSelection([]); setBulkDone((n) => n + 1); }}
      />

      <BulkOwnerDialog
        open={bulkOwner}
        deals={inView.filter((row) => selection.includes(row.id))}
        users={users.data?.data ?? []}
        onClose={() => setBulkOwner(false)}
        onDone={() => { setBulkOwner(false); setSelection([]); setBulkDone((n) => n + 1); }}
      />

      <StageMoveDialog
        open={!!move}
        deal={move?.deal ?? null}
        from={move ? board?.stages.find((s) => s.name === dealStage(move.deal)) : undefined}
        to={move?.stage ?? null}
        properties={properties.data?.data ?? []}
        onClose={() => { setMove(null); setRefocus(landedFrom(move)); }}
        onMoved={() => { setMove(null); setRefocus(landedFrom(move)); }}
      />
    </Page>
  );
}

export type { Pipeline };
