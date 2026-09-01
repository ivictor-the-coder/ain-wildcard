/**
 * The revenue analytics surface: the board, usage, credits and recovery.
 *
 * Registration only — each screen lives in its own file. Everything these
 * pages show is read from the reporting, metering, credits and payments
 * endpoints at render time; nothing here holds a number of its own.
 */
import { useQuery, type ListEnvelope } from '../../kernel/api';
import { useNavigate } from '../../kernel/router';
import type { CommandDef, NavItem, RouteDef, WidgetDef } from '../../kernel/registry-types';
import {
  Badge, Button, Card, EmptyState, Inline, Skeleton, Sparkline, Stack, Stat,
  formatNumber, humanize, pluralize, useFormat,
  ArrowRightIcon,
} from '../../design';
import { RevenueBoardPage } from './board';
import { UsagePage, MeterDetailPage } from './usage';
import { CreditsPage } from './credits';
import { DunningPage } from './dunning';
import { SectionError, moneyIn, rateText, useDefaultCurrency } from './common';
import type { CreditsOverview, DunningCampaign, DunningSummary, RevenueSummary } from './types';

/* ================================= widgets ================================ */

function RevenueWidget() {
  const f = useFormat();
  const currency = useDefaultCurrency();
  const navigate = useNavigate();
  const summary = useQuery<RevenueSummary>('/v1/revenue/summary', { months: 12, currency });
  const data = summary.data;

  if (summary.error) return <Card title="Revenue"><SectionError error={summary.error} path="GET /v1/revenue/summary" onRetry={summary.refetch} /></Card>;
  if (!data) return <Card title="Revenue"><Skeleton height={110} /></Card>;

  const points = data.series
    .map((row) => row.mrr)
    .filter((value): value is number => value !== null);

  return (
    <Card
      title="Revenue"
      description={`The ${currency.toUpperCase()} book over twelve months`}
      actions={<Button size="sm" variant="ghost" iconRight={<ArrowRightIcon size={13} />} onClick={() => navigate('/revenue')}>Open</Button>}
    >
      <Stack gap={5}>
        <Stat
          label="Monthly recurring revenue"
          value={moneyIn(f, data.headline.mrr, currency)}
          caption={`${moneyIn(f, data.headline.arr, currency)} a year · NRR ${rateText(data.headline.net_revenue_retention)}`}
          sparkline={points.length > 1 ? points : undefined}
        />
        <Inline gap={4} wrap>
          <Badge tone={data.balanced ? 'success' : 'danger'} dot size="sm">{data.balanced ? 'Every figure reconciles' : 'A reconciliation failed'}</Badge>
          <span className="rv-sub">{moneyIn(f, data.headline.past_due, currency)} past due</span>
        </Inline>
      </Stack>
    </Card>
  );
}

function RecoveryWidget() {
  const f = useFormat();
  const navigate = useNavigate();
  const summary = useQuery<DunningSummary>('/v1/dunning/summary');
  const queue = useQuery<ListEnvelope<DunningCampaign>>('/v1/dunning', { status: 'recovering', limit: 5 });
  const rows = queue.data?.data ?? [];

  if (summary.error) return <Card title="Recovery"><SectionError error={summary.error} path="GET /v1/dunning/summary" onRetry={summary.refetch} /></Card>;
  if (!summary.data) return <Card title="Recovery"><Skeleton height={110} /></Card>;

  return (
    <Card
      title="Recovery"
      description="Bills the bank refused"
      actions={<Button size="sm" variant="ghost" iconRight={<ArrowRightIcon size={13} />} onClick={() => navigate('/revenue/dunning')}>Open</Button>}
    >
      {rows.length === 0
        ? (
          <EmptyState
            size="sm"
            inline
            illustration={null}
            title="Nothing is in recovery"
            body="Every automatic charge is clearing."
          />
        )
        : (
          <div className="rv-rows">
            {rows.map((row) => (
              <button
                type="button"
                key={row.id}
                className="rv-row"
                onClick={() => navigate('/revenue/dunning')}
                style={{ background: 'none', border: 0, borderBlockEnd: '1px solid var(--border-subtle)', cursor: 'pointer', width: '100%', textAlign: 'start', color: 'inherit' }}
              >
                <div className="rv-row__main">
                  <div className="rv-row__title">{row.customer_name}</div>
                  <div className="rv-row__sub">
                    {row.last_failure_code ? humanize(row.last_failure_code) : 'Awaiting the first attempt'} · attempt {formatNumber(row.attempt_count)} of {formatNumber(row.max_attempts)}
                  </div>
                </div>
                <div className="rv-row__aside">{moneyIn(f, row.amount_at_risk, row.currency)}</div>
              </button>
            ))}
          </div>
        )}
    </Card>
  );
}

function CreditWidget() {
  const f = useFormat();
  const navigate = useNavigate();
  const overview = useQuery<CreditsOverview>('/v1/credits/overview');
  const data = overview.data;

  if (overview.error) return <Card title="Prepaid credit"><SectionError error={overview.error} path="GET /v1/credits/overview" onRetry={overview.refetch} /></Card>;
  if (!data) return <Card title="Prepaid credit"><Skeleton height={110} /></Card>;

  return (
    <Card
      title="Prepaid credit"
      description="Outstanding balances by currency"
      actions={<Button size="sm" variant="ghost" iconRight={<ArrowRightIcon size={13} />} onClick={() => navigate('/revenue/credits')}>Open</Button>}
    >
      <Stack gap={4}>
        {data.outstanding.length === 0
          ? <EmptyState size="sm" inline illustration={null} title="No credit outstanding" body="Nothing has been prepaid." />
          : data.outstanding.map((row) => (
            <div className="rv-row" key={row.currency}>
              <div className="rv-row__main">
                <div className="rv-row__title">{row.currency.toUpperCase()}</div>
                <div className="rv-row__sub">{row.unit_pots ? f.plural(row.unit_pots, 'unit pot') : 'monetary credit only'}</div>
              </div>
              <div className="rv-row__aside">{row.monetary_outstanding_display}</div>
            </div>
          ))}
        <Inline gap={4} wrap>
          <span className="rv-sub">{f.plural(data.grants.active, 'active grant')}</span>
          {data.expiring_within_7_days.length > 0 && (
            <Badge tone="warning" size="sm">{f.plural(data.expiring_within_7_days.length, 'grant')} expiring this week</Badge>
          )}
        </Inline>
      </Stack>
    </Card>
  );
}

function UsageWidget() {
  const f = useFormat();
  const navigate = useNavigate();
  const overview = useQuery<{ meters: { id: string; name: string; events_30d: number; unit_label: string | null }[]; open_late_arrivals: number }>('/v1/metering/overview');
  const data = overview.data;

  if (overview.error) return <Card title="Usage"><SectionError error={overview.error} path="GET /v1/metering/overview" onRetry={overview.refetch} /></Card>;
  if (!data) return <Card title="Usage"><Skeleton height={110} /></Card>;

  const meters = [...data.meters].sort((a, b) => b.events_30d - a.events_30d).slice(0, 4);
  const max = Math.max(1, ...meters.map((m) => m.events_30d));

  return (
    <Card
      title="Usage"
      description="Events measured in the last 30 days"
      actions={<Button size="sm" variant="ghost" iconRight={<ArrowRightIcon size={13} />} onClick={() => navigate('/revenue/usage')}>Open</Button>}
    >
      {meters.length === 0
        ? <EmptyState size="sm" inline illustration={null} title="No meters yet" body="Create one and start sending events." />
        : (
          <div className="rv-rows">
            {meters.map((meter) => (
              <div className="rv-row" key={meter.id}>
                <div className="rv-row__main">
                  <div className="rv-row__title">{meter.name}</div>
                  <div className="rv-row__sub">{f.plural(meter.events_30d, 'event')}{meter.unit_label && meter.unit_label !== 'event' ? ` · ${pluralize(meter.unit_label, 2)}` : ''}</div>
                </div>
                <div className="rv-row__aside">
                  <Sparkline values={[0, meter.events_30d / max]} width={70} height={22} autoTone label={`${meter.name} volume`} />
                </div>
              </div>
            ))}
          </div>
        )}
    </Card>
  );
}

/* ============================== registration ============================== */

export const routes: RouteDef[] = [
  { path: '/revenue', element: RevenueBoardPage, title: 'Revenue' },
  { path: '/revenue/usage', element: UsagePage, title: 'Usage' },
  { path: '/revenue/usage/:id', element: MeterDetailPage, title: 'Meter' },
  { path: '/revenue/credits', element: CreditsPage, title: 'Credits' },
  { path: '/revenue/dunning', element: DunningPage, title: 'Recovery' },
];

export const nav: NavItem[] = [
  {
    id: 'revenue',
    label: 'Revenue',
    to: '/revenue',
    group: 'insights',
    order: 10,
    icon: 'chart-line',
    // The section's own link is the board, so it has no child of its own: a
    // child sharing the parent's path wins the breadcrumb lookup, and every
    // screen under it then read "Home › Overview › Usage".
    children: [
      { id: 'revenue.usage.nav', label: 'Usage', to: '/revenue/usage' },
      { id: 'revenue.credits.nav', label: 'Credits', to: '/revenue/credits' },
      { id: 'revenue.dunning.nav', label: 'Recovery', to: '/revenue/dunning' },
    ],
  },
];

export const commands: CommandDef[] = [
  {
    id: 'revenue.board',
    title: 'Revenue board',
    subtitle: 'MRR, movement, retention and receivables with the basis behind each',
    group: 'Go to',
    keywords: ['revenue', 'mrr', 'arr', 'nrr', 'retention', 'cohort', 'waterfall'],
    icon: 'chart-line',
    run: (nav) => nav('/revenue'),
  },
  {
    id: 'revenue.usage.open',
    title: 'Usage and meters',
    subtitle: 'Event volume, top customers and the ingestion record',
    group: 'Go to',
    keywords: ['usage', 'meter', 'metering', 'events', 'ingestion'],
    icon: 'gauge',
    run: (nav) => nav('/revenue/usage'),
  },
  {
    id: 'revenue.credits.open',
    title: 'Prepaid credit',
    subtitle: 'Grants, the ledger, burn-down and settlements',
    group: 'Go to',
    keywords: ['credit', 'grant', 'prepaid', 'ledger', 'burn', 'top-up'],
    icon: 'coins',
    run: (nav) => nav('/revenue/credits'),
  },
  {
    id: 'revenue.dunning.open',
    title: 'Recovery queue',
    subtitle: 'Every bill the bank refused, and what to do about each',
    group: 'Revenue',
    keywords: ['dunning', 'recovery', 'retry', 'decline', 'failed payment', 'past due'],
    icon: 'refresh',
    run: (nav) => nav('/revenue/dunning'),
  },
  {
    id: 'revenue.dunning.needs_human',
    title: 'Payments that need a person',
    subtitle: 'Declines no retry schedule can satisfy',
    group: 'Revenue',
    keywords: ['expired card', 'needs human', 'authentication required', 'stuck payment'],
    icon: 'alert-triangle',
    run: (nav) => nav('/revenue/dunning?status=all'),
  },
  {
    id: 'revenue.dunning.policy',
    title: 'Change the retry policy',
    subtitle: 'The schedule every failed charge is chased on',
    group: 'Revenue',
    keywords: ['dunning policy', 'retry schedule', 'smart retries', 'give up codes'],
    icon: 'sliders',
    run: (nav) => nav('/revenue/dunning?policy=1'),
  },
  {
    id: 'revenue.credit.grant',
    title: 'Issue credit to an account',
    subtitle: 'A grant this customer may draw against these charges',
    group: 'Create',
    keywords: ['grant credit', 'goodwill', 'promotional credit', 'prepay'],
    icon: 'gift',
    run: (nav) => nav('/revenue/credits?new=grant'),
  },
  {
    id: 'revenue.credit.topup',
    title: 'Sell a credit pack',
    subtitle: 'Raise the charge and hand over the credit in one transaction',
    group: 'Create',
    keywords: ['top up', 'credit pack', 'prepay', 'sell credit', 'purchase'],
    icon: 'credit-card',
    run: (nav) => nav('/revenue/credits?new=topup'),
  },
  {
    id: 'revenue.credit.settle',
    title: 'Settle a usage period',
    subtitle: 'Price a metered window, draw credit against it and freeze the meter',
    group: 'Create',
    keywords: ['settle usage', 'price period', 'close period', 'burn credit'],
    icon: 'receipt',
    run: (nav) => nav('/revenue/credits?new=settle'),
  },
  {
    id: 'revenue.meter.new',
    title: 'New meter',
    subtitle: 'A standing instruction turning events into one billable number',
    group: 'Create',
    keywords: ['create meter', 'metering', 'new meter', 'aggregation'],
    icon: 'gauge',
    run: (nav) => nav('/revenue/usage?new=meter'),
  },
  {
    id: 'revenue.usage.record',
    title: 'Record a usage event',
    subtitle: 'The same call your systems make, by hand',
    group: 'Create',
    keywords: ['meter event', 'ingest', 'send usage', 'record event'],
    icon: 'zap',
    run: (nav) => nav('/revenue/usage?new=event'),
  },
];

export const widgets: WidgetDef[] = [
  { id: 'revenue.mrr', title: 'Revenue', description: 'MRR, retention and what is past due', span: 4, component: RevenueWidget, group: 'revenue' },
  { id: 'revenue.recovery', title: 'Recovery', description: 'Bills the bank refused', span: 4, component: RecoveryWidget, group: 'revenue' },
  { id: 'revenue.credit', title: 'Prepaid credit', description: 'Outstanding balances by currency', span: 4, component: CreditWidget, group: 'revenue' },
  { id: 'revenue.usage', title: 'Usage', description: 'Events measured in the last 30 days', span: 4, component: UsageWidget, group: 'revenue' },
];
