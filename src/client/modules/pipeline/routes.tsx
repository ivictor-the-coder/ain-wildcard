/**
 * The deal surface: a kanban board that moves real deals, a table view of the
 * same set, and the deal record.
 */
import { useMemo } from 'react';
import type { CommandDef, NavItem, RouteDef, WidgetDef } from '@/client/kernel/registry-types';
import { useQuery } from '@/client/kernel/api';
import { useRouter } from '@/client/kernel/router';
import {
  Badge, Button, Card, ChevronRightIcon, EmptyState, ErrorState, Icons, SkeletonText
} from '@/client/design';
import { DealsPage } from './deals';
import { DealRecordPage } from './record';
import {
  accountOf, dealAmount, dealCloseDate, recordHref, str, useDealFormat,
  type DealListEnvelope, type DealRecord,
} from './api';
import './pipeline.css';

const DAY_MS = 86_400_000;

const DealRecordRoute = () => {
  const { params } = useRouter();
  return <DealRecordPage key={params.id} id={params.id} />;
};

/* --------------------------------- widget --------------------------------- */

/** The open deals whose close date is inside the next six weeks, soonest first. */
function ClosingSoon() {
  const f = useDealFormat();
  const { navigate } = useRouter();
  const today = f.calendarToday();
  const { data, error, loading, refetch } = useQuery<DealListEnvelope>('/v1/records/deal', {
    sort: 'close_date', order: 'asc', limit: 60, expand: 'associations',
  });

  const rows = useMemo(() => {
    const horizon = today + 42 * DAY_MS;
    return (data?.data ?? [])
      .filter((deal: DealRecord) => str(deal.properties.deal_status) === 'open')
      .filter((deal) => {
        const close = dealCloseDate(deal);
        return close !== null && close <= horizon;
      })
      .slice(0, 6);
  }, [data, today]);

  const committed = rows.reduce((sum, deal) => sum + dealAmount(deal), 0);

  return (
    <Card
      title="Closing in the next six weeks"
      description={rows.length ? `${f.money(committed)} across ${f.plural(rows.length, 'deal')}` : 'Open deals by close date'}
      actions={<Button size="sm" variant="ghost" onClick={() => navigate('/deals?horizon=quarter')}>Open the board</Button>}
    >
      {error && (
        <ErrorState
          title="The deal list did not answer"
          message={error.body.message}
          code={`${error.status} /v1/records/deal`}
          requestId={error.body.request_id ?? null}
          action={<Button size="sm" variant="primary" onClick={refetch}>Try again</Button>}
        />
      )}
      {!error && loading && <SkeletonText lines={5} />}
      {!error && !loading && rows.length === 0 && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="Nothing is due in the next six weeks"
          body="Every open deal closes later than that, or has no close date set."
          action={<Button size="sm" variant="primary" onClick={() => navigate('/deals?new=1')}>New deal</Button>}
        />
      )}
      {!error && rows.map((deal) => {
        const close = dealCloseDate(deal);
        const overdue = close !== null && close < today;
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
            {overdue && <Badge tone="warning" size="sm">overdue</Badge>}
            <ChevronRightIcon size={14} />
          </button>
        );
      })}
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

export const commands: CommandDef[] = [
  {
    id: 'pipeline.board',
    title: 'Deal board',
    subtitle: 'Every pipeline, by stage, with the weighted forecast',
    group: 'Go to',
    keywords: ['deals', 'pipeline', 'kanban', 'forecast', 'opportunities'],
    icon: 'deals',
    run: (go) => go('/deals'),
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
    id: 'pipeline.new-deal',
    title: 'New deal',
    subtitle: 'Open an opportunity on a pipeline',
    group: 'Create',
    keywords: ['deal', 'opportunity', 'add'],
    icon: 'plus',
    run: (go) => go('/deals?new=1'),
  },
  {
    id: 'pipeline.closing',
    title: 'Deals closing this quarter',
    subtitle: 'Filtered to the current quarter’s close dates',
    group: 'Go to',
    keywords: ['forecast', 'quarter', 'close'],
    icon: 'calendar-check',
    run: (go) => go('/deals?horizon=quarter'),
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
