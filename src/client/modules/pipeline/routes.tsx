/**
 * The deal surface: a kanban board that moves real deals, a table view of the
 * same set, and the deal record.
 */
import type { CommandDef, NavItem, RouteDef, WidgetDef } from '@/client/kernel/registry-types';
import { useRouter } from '@/client/kernel/router';
import {
  Badge, Button, Card, ChevronRightIcon, EmptyState, ErrorState, SkeletonText,
} from '@/client/design';
import { DealsPage } from './deals';
import { DealRecordPage } from './record';
import {
  ALL_PIPELINES, SIX_WEEK_DAYS, accountOf, dealAmount, dealCloseDate, recordHref, useDealFormat,
  useDealSearch, type DealSearchBody,
} from './api';
import './pipeline.css';

const DealRecordRoute = () => {
  const { params } = useRouter();
  return <DealRecordPage key={params.id} id={params.id} />;
};

/* --------------------------------- widget --------------------------------- */

const SHOWN = 6;

/**
 * Where the card sends you, and it is the same set the card counted.
 *
 * The filter behind these numbers names no pipeline, so it counts across all of
 * them; the board it linked to could only ever draw one, and a card reading
 * "14 deals" opened a board headed "7 deals on New business". The board can now
 * hold every pipeline, so the link says so.
 */
const boardHref = (horizon: string) => `/deals?pipeline=${ALL_PIPELINES}&horizon=${horizon}`;

/** The filter the card counts, run by the server so the total is the whole set. */
const commitWindow: DealSearchBody = {
  filter: {
    op: 'and',
    filters: [
      { property: 'deal_status', operator: 'eq', value: 'open' },
      { property: 'close_date', operator: 'between', values: ['today', `+${SIX_WEEK_DAYS}d`] },
    ],
  },
  sort: [{ property: 'close_date', direction: 'asc' }],
  expand: ['associations'],
};

/** Open deals whose close date has already gone by — commit that is not commit. */
const pastDue: DealSearchBody = {
  filter: {
    op: 'and',
    filters: [
      { property: 'deal_status', operator: 'eq', value: 'open' },
      { property: 'close_date', operator: 'before', value: 'today' },
    ],
  },
  sort: [{ property: 'close_date', direction: 'asc' }],
};

/**
 * The open deals closing inside the next six weeks, soonest first.
 *
 * The money and the count are properties of the whole matching set, not of the
 * six rows there is room to draw: the card used to total its own render cap and
 * caption the result as the six-week number, which understated a live workspace
 * by 61%. Overdue deals are counted on their own line rather than folded in —
 * a deal whose close date went by in March is not next-six-weeks commit.
 */
function ClosingSoon() {
  const f = useDealFormat();
  const { navigate } = useRouter();
  const commit = useDealSearch(commitWindow);
  const overdue = useDealSearch(pastDue);

  const rows = commit.deals.slice(0, SHOWN);
  const caption = commit.amount === null
    ? `${f.plural(commit.total, 'deal')} — more than this card can total`
    : `${f.money(commit.amount)} across ${f.plural(commit.total, 'deal')}${commit.total > rows.length ? ` · showing ${rows.length}` : ''}`;

  return (
    <Card
      title="Closing in the next six weeks"
      description={commit.total ? caption : 'Open deals by close date'}
      actions={
        <Button size="sm" variant="ghost" onClick={() => navigate(boardHref('42'))}>
          Open the board
        </Button>
      }
    >
      {commit.error && (
        <ErrorState
          title="The deal list did not answer"
          message={commit.error.body.message}
          code={`${commit.error.status} /v1/records/deal/search`}
          requestId={commit.error.body.request_id ?? null}
          action={<Button size="sm" variant="primary" onClick={commit.refetch}>Try again</Button>}
        />
      )}
      {!commit.error && commit.loading && <SkeletonText lines={5} />}
      {!commit.error && !commit.loading && rows.length === 0 && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="Nothing is due in the next six weeks"
          body="Every open deal closes later than that, or has no close date set."
          action={<Button size="sm" variant="primary" onClick={() => navigate('/deals?new=1')}>New deal</Button>}
        />
      )}
      {!commit.error && rows.map((deal) => {
        const close = dealCloseDate(deal);
        return (
          <button
            key={deal.id}
            type="button"
            className="pl-widgetrow"
            onClick={() => navigate(recordHref('deal', deal.id))}
          >
            <span className="pl-widgetrow__text">
              <span className="pl-widgetrow__title u-truncate">{deal.display_name}</span>
              <span className="pl-widgetrow__sub u-truncate">
                {accountOf(deal)?.display_name ?? 'No account'} · {close !== null ? f.calendarDate(close, { withYear: false }) : 'no close date'}
              </span>
            </span>
            <span className="pl-widgetrow__amount">{f.money(dealAmount(deal))}</span>
            <ChevronRightIcon size={14} />
          </button>
        );
      })}
      {!commit.error && !commit.loading && commit.total > rows.length && (
        <button
          type="button"
          className="pl-widgetmore"
          onClick={() => navigate(boardHref('42'))}
        >
          {f.plural(commit.total - rows.length, 'more deal')} in this window
          <ChevronRightIcon size={13} />
        </button>
      )}
      {!overdue.error && !overdue.loading && overdue.total > 0 && (
        <button
          type="button"
          className="pl-widgetmore pl-widgetmore--warn"
          onClick={() => navigate(boardHref('overdue'))}
        >
          <Badge tone="warning" size="sm">overdue</Badge>
          {overdue.amount === null
            ? `${f.plural(overdue.total, 'open deal')} are already past their close date`
            : `${f.plural(overdue.total, 'open deal')} worth ${f.money(overdue.amount)} are already past their close date`}
          <ChevronRightIcon size={13} />
        </button>
      )}
    </Card>
  );
}

/* ------------------------------ registration ------------------------------ */

export const routes: RouteDef[] = [
  { path: '/deals', element: DealsPage, title: 'Deals' },
  { path: '/deals/:id', element: DealRecordRoute, title: 'Deal' },
];

export const nav: NavItem[] = [
  { id: 'pipeline.deals', label: 'Deals', to: '/deals', group: 'crm', order: 30, icon: 'deals' },
];

/**
 * "Go to Deals" and "Create New deal" come from the nav and the create menu,
 * so the palette only gets the views the sidebar cannot express.
 */
export const commands: CommandDef[] = [
  {
    id: 'pipeline.all',
    title: 'Every pipeline on one board',
    subtitle: 'Every pipeline stacked, each with its own stages and totals',
    group: 'Go to',
    keywords: ['deals', 'pipeline', 'all', 'kanban', 'forecast', 'everything'],
    icon: 'layers',
    run: (go) => go(`/deals?pipeline=${ALL_PIPELINES}`),
  },
  {
    id: 'pipeline.table',
    title: 'Deals as a table',
    subtitle: 'The same deals, sortable and filterable',
    group: 'Go to',
    keywords: ['deals', 'list', 'grid'],
    icon: 'table',
    run: (go) => go('/deals?display=table'),
  },
  {
    id: 'pipeline.closing',
    title: 'Deals closing this quarter',
    subtitle: 'Filtered to the current quarter’s close dates',
    group: 'Go to',
    keywords: ['forecast', 'quarter', 'close'],
    icon: 'calendar-check',
    run: (go) => go(boardHref('quarter')),
  },
];

export const widgets: WidgetDef[] = [
  {
    id: 'pipeline.closing-soon',
    title: 'Closing in the next six weeks',
    description: 'Open deals by close date',
    span: 4,
    component: ClosingSoon,
    group: 'crm',
  },
];
