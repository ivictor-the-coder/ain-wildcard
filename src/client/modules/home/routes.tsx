/**
 * The dashboard.
 *
 * Every figure on this screen is read from the API at render time — the CRM
 * overview, the billing overview, the meters, the credit ledger, the price
 * book, the event log and the job queue. Cards whose module is not installed on
 * this workspace are simply absent; nothing here invents a number.
 *
 * And a read that fails is a failure, never an absence. A billing dashboard
 * that answers an outage with "$0" or "the queue is empty" is worse than one
 * that does not load at all, so every panel below renders what the server said,
 * the request id support can grep for, and a way to ask again.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { CommandDef, NavItem, RouteDef } from '../../kernel/registry-types';
import { useSession } from '../../kernel/session';
import { useQuery, type ApiClientError } from '../../kernel/api';
import { useRouter } from '../../kernel/router';
import { usePlatform, useTimeMachine } from '../../kernel/platform';
import { aftermathOf } from '../../kernel/time-machine';
import { useShell } from '../../kernel/shell';
import {
  clockOutcome, eventSubject, eventTitle, firstRegistered, greetingFor, orderSetup, setupProgress,
  type SetupStep,
} from '../../kernel/shell-core';
import { ROUTES, WIDGETS } from '../../generated/registry';
import {
  BarChart, Badge, Banner, Button, Card, Divider, EmptyState, ErrorBoundary, ErrorState, Icons,
  ProgressBar, SegmentedControl, Skeleton, SkeletonText, Stat, Page, formatCompact, humanize,
  iconByName, toMajorUnits, useFormat, useToast,
} from '../../design';
import { creditOutstanding } from './home-core';
import './home.css';

/* ------------------------------ API payloads ----------------------------- */

interface CrmOverview {
  records: { name: string; label: string; icon: string; category: string; count: number }[];
  pipeline: {
    pipeline_label: string; stage: string; label: string; is_closed: boolean;
    deals: number; amount: number; weighted_amount: number;
  }[];
  open_pipeline: { deals: number; amount: number; weighted_amount: number };
  activity_last_30_days: { type: string; count: number }[];
}
interface BillingOverview {
  subscriptions: number; live: number; mrr: number; arr: number; customers: number;
  delinquent_customers: number; renewing_next_30_days: number; by_status: Record<string, number>;
}
interface MeteringOverview {
  meters: { id: string; name: string; unit_label: string; events_30d: number; customers_30d: number }[];
  open_late_arrivals: number;
}
interface CreditsOverview {
  grants: { total: number; active: number; scheduled: number; expired: number };
  outstanding: { currency: string; monetary_outstanding: number; unit_pots: number; monetary_outstanding_display: string }[];
  expiring_within_7_days: { id: string; name: string; expires_at: number }[];
}
interface Catalog {
  totals: { products: number; prices: number; active_prices: number };
  plans: {
    product: { id: string; name: string; tagline: string | null };
    base: { month: { display: { summary: string } } | null; year: unknown };
  }[];
}
interface EventRow {
  id: string; type: string; object_type: string | null; object_id: string | null;
  actor_type: string; created: number; data?: unknown;
}
interface JobRow { id: string; type: string; status: string; run_at: number }
interface AiStatus {
  provider: { id: string; label: string };
  providers: { id: string; label: string; available: boolean }[];
  tools: number; runs_today: number; pending_approvals: number;
}

/* -------------------------------- helpers -------------------------------- */

/** CRM object types name icons the design set does not carry one-for-one. */
const ICON_ALIAS: Record<string, string> = {
  'life-buoy': 'tickets',
  'sticky-note': 'note',
  'check-square': 'check-circle',
};

const EVENT_ICON: [RegExp, string][] = [
  [/^email/, 'mail'],
  [/^call/, 'phone'],
  [/^meeting/, 'calendar'],
  [/^note/, 'note'],
  [/^task/, 'check-circle'],
  [/^invoice/, 'invoice'],
  [/^credit/, 'coins'],
  [/^subscription|^billing/, 'repeat'],
  [/^customer/, 'wallet'],
  [/^meter|^usage/, 'gauge'],
  [/^deal/, 'trending-up'],
  [/^contact/, 'user'],
  [/^company/, 'building'],
  [/^ticket/, 'tickets'],
  [/^ai|^agent/, 'sparkles'],
  [/^user/, 'users'],
  [/^workflow/, 'workflows'],
  [/^price|^product/, 'tag'],
];
const eventIcon = (type: string): string => EVENT_ICON.find(([re]) => re.test(type))?.[1] ?? 'activity';

const Glyph = ({ name, size = 15 }: { name: string; size?: number }) => {
  const Icon = iconByName(ICON_ALIAS[name] ?? name);
  return <Icon size={size} />;
};

const cell = (span: number): CSSProperties => ({ ['--span' as string]: span } as CSSProperties);

/* ------------------------------ failure cards ---------------------------- */

/** One API read, and which module's panels go dark when it fails. */
interface Feed {
  key: string;
  label: string;
  path: string;
  error: ApiClientError | null;
  retry: () => void;
}

const requestIdOf = (error: ApiClientError): string | null => error.body.request_id ?? null;

/**
 * A stat that could not be read, in the shape of the stat it replaces, so the
 * grid keeps its rhythm and the gap is named rather than silently closed.
 */
function TileFailure({ feed }: { feed: Feed & { error: ApiClientError } }) {
  return (
    <Card padding="tight">
      <div className="home-tilefail" role="alert">
        <span className="home-tilefail__head">
          <Glyph name="alert-triangle" size={14} />
          <span className="u-truncate">{feed.label} did not answer</span>
        </span>
        <span className="home-tilefail__msg">{feed.error.body.message}</span>
        <span className="home-tilefail__meta u-mono u-truncate">
          {feed.error.status} {feed.path}{requestIdOf(feed.error) ? ` · ${requestIdOf(feed.error)}` : ''}
        </span>
        <Button size="sm" variant="secondary" iconLeft={<Icons.refresh size={12} />} onClick={feed.retry}>
          Try again
        </Button>
      </div>
    </Card>
  );
}

/** A whole card whose one source failed — same treatment as the route boundary. */
function PanelFailure({ title, description, feed }: { title: string; description: string; feed: Feed }) {
  if (!feed.error) return null;
  return (
    <Card title={title} description={description}>
      <ErrorState
        title={`${feed.label} did not answer`}
        message={feed.error.body.message}
        code={`${feed.error.status} ${feed.path}`}
        requestId={requestIdOf(feed.error)}
        action={
          <Button size="sm" variant="primary" iconLeft={<Icons.refresh size={13} />} onClick={feed.retry}>
            Try again
          </Button>
        }
      />
    </Card>
  );
}

/* ================================== page ================================== */

function Home() {
  const session = useSession();
  const shell = useShell();
  const f = useFormat();
  const { navigate } = useRouter();
  const platform = usePlatform(true);
  const has = (path: string) => platform.serves('GET', path);

  const crm = useQuery<CrmOverview>('/v1/crm/overview', undefined, { enabled: has('/v1/crm/overview') });
  const billing = useQuery<BillingOverview>('/v1/subscriptions/overview', undefined, { enabled: has('/v1/subscriptions/overview') });
  const metering = useQuery<MeteringOverview>('/v1/metering/overview', undefined, { enabled: has('/v1/metering/overview') });
  const credits = useQuery<CreditsOverview>('/v1/credits/overview', undefined, { enabled: has('/v1/credits/overview') });
  const catalog = useQuery<Catalog>('/v1/catalog', undefined, { enabled: has('/v1/catalog') });
  const events = useQuery<{ data: EventRow[] }>('/v1/events', { limit: 14 }, { enabled: has('/v1/events') });
  const jobs = useQuery<{ data: JobRow[] }>('/v1/jobs', { status: 'pending', limit: 200 }, { enabled: has('/v1/jobs') });
  const ai = useQuery<AiStatus>('/v1/ai/status', undefined, { enabled: has('/v1/ai/status') });
  const isAdmin = ['owner', 'admin'].includes(session.me?.role ?? '');
  const keys = useQuery<{ data: unknown[] }>('/v1/api-keys', undefined, { enabled: isAdmin && has('/v1/api-keys') });

  const booting = platform.ready === false;
  const now = session.now();
  const firstName = session.me?.user?.name.split(' ')[0];

  /* -------------------------------- failures ------------------------------ */

  // Every panel below is fed by exactly one of these reads, so a failure can be
  // attributed to a module by name rather than smeared into a blank screen.
  const feeds = useMemo<Feed[]>(() => [
    { key: 'billing', label: 'Subscriptions & invoicing', path: '/v1/subscriptions/overview', error: billing.error, retry: billing.refetch },
    { key: 'crm', label: 'CRM & pipeline', path: '/v1/crm/overview', error: crm.error, retry: crm.refetch },
    { key: 'metering', label: 'Usage metering', path: '/v1/metering/overview', error: metering.error, retry: metering.refetch },
    { key: 'credits', label: 'Prepaid credit', path: '/v1/credits/overview', error: credits.error, retry: credits.refetch },
    { key: 'ai', label: 'Agents', path: '/v1/ai/status', error: ai.error, retry: ai.refetch },
    { key: 'catalog', label: 'Price book', path: '/v1/catalog', error: catalog.error, retry: catalog.refetch },
    { key: 'events', label: 'Event log', path: '/v1/events', error: events.error, retry: events.refetch },
    { key: 'jobs', label: 'Job queue', path: '/v1/jobs', error: jobs.error, retry: jobs.refetch },
    { key: 'keys', label: 'API keys', path: '/v1/api-keys', error: keys.error, retry: keys.refetch },
  ], [billing.error, billing.refetch, crm.error, crm.refetch, metering.error, metering.refetch,
      credits.error, credits.refetch, ai.error, ai.refetch, catalog.error, catalog.refetch,
      events.error, events.refetch, jobs.error, jobs.refetch, keys.error, keys.refetch]);

  const failed = useMemo(() => feeds.filter((feed): feed is Feed & { error: ApiClientError } => !!feed.error), [feeds]);
  const feed = (key: string): Feed => feeds.find((row) => row.key === key)!;
  const retryFailed = () => { for (const row of failed) row.retry(); };

  /* ------------------------------- headline ------------------------------ */

  const headline = useMemo(() => {
    const parts: string[] = [f.date(now, { withYear: false })];
    if (billing.data) {
      parts.push(`${f.number(billing.data.live)} live subscriptions`);
      parts.push(`${f.money(billing.data.mrr)} MRR`);
      if (billing.data.delinquent_customers) parts.push(`${billing.data.delinquent_customers} past due`);
    }
    if (!billing.data && crm.data) {
      parts.push(`${f.number(crm.data.open_pipeline.deals)} open deals`);
      parts.push(`${f.money(crm.data.open_pipeline.amount)} in pipeline`);
    }
    // A headline that reads normally over a half-failed dashboard is the lie
    // this screen used to tell. Say how much of it is missing, in the headline.
    if (failed.length) {
      parts.push(`${failed.length} of ${feeds.length} sources did not answer`);
    }
    return parts.join(' · ');
  }, [billing.data, crm.data, failed.length, feeds.length, f, now]);

  /* --------------------------------- tiles ------------------------------- */

  const tiles = useMemo(() => {
    const out: { key: string; node: ReactNode }[] = [];
    if (billing.data) {
      out.push({
        key: 'mrr',
        node: <Stat
          label="Monthly recurring revenue"
          value={f.money(billing.data.mrr)}
          icon={<Glyph name="repeat" />}
          caption={`${f.money(billing.data.arr)} annualised · ${f.number(billing.data.customers)} billed accounts`}
        />,
      });
      out.push({
        key: 'renewals',
        node: <Stat
          label="Renewing in 30 days"
          value={f.number(billing.data.renewing_next_30_days)}
          icon={<Glyph name="calendar-check" />}
          caption={billing.data.delinquent_customers
            ? `${f.number(billing.data.delinquent_customers)} accounts are past due`
            : 'No account is past due'}
        />,
      });
    }
    if (crm.data) {
      out.push({
        key: 'pipeline',
        node: <Stat
          label="Open pipeline"
          value={f.money(crm.data.open_pipeline.amount)}
          icon={<Glyph name="funnel" />}
          caption={`${f.number(crm.data.open_pipeline.deals)} deals · ${f.money(crm.data.open_pipeline.weighted_amount)} weighted`}
        />,
      });
    }
    if (metering.data?.meters.length) {
      const ingested = metering.data.meters.reduce((n, meter) => n + meter.events_30d, 0);
      out.push({
        key: 'usage',
        node: <Stat
          label="Metered events, 30 days"
          value={f.compact(ingested)}
          icon={<Glyph name="gauge" />}
          caption={`Across ${f.plural(metering.data.meters.length, 'meter')}`}
        />,
      });
    }
    if (credits.data) {
      // The overview answers per currency, sorted by currency code. Taking the
      // first row showed whichever code sorts first: this tile read "£0.00"
      // next to an MRR and a pipeline in USD while the workspace held $1,250.00
      // of USD credit. The pot is chosen by currency now, and whatever a single
      // figure leaves out is said in the caption rather than dropped.
      const credit = creditOutstanding(credits.data.outstanding, session.currency);
      const grants = credits.data.grants;
      const clauses = [
        // Unit grants hold a meter's own units, so no money figure can express
        // them — the count is the only honest way to say they are also there.
        `${f.number(grants.active)} active ${grants.active === 1 ? 'grant' : 'grants'}${credit.unitGrants ? `, ${f.number(credit.unitGrants)} of them in meter units` : ''}`,
        `${f.number(grants.scheduled)} scheduled`,
      ];
      if (credit.note) clauses.push(credit.note);
      out.push({
        key: 'credits',
        node: <Stat
          label="Prepaid credit outstanding"
          value={credit.pot ? credit.pot.monetary_outstanding_display : f.money(0)}
          icon={<Glyph name="coins" />}
          caption={clauses.join(' · ')}
        />,
      });
    }
    if (ai.data) {
      out.push({
        key: 'ai',
        node: <Stat
          label="Agent runs today"
          value={f.number(ai.data.runs_today)}
          icon={<Glyph name="sparkles" />}
          caption={`${ai.data.provider.label} · ${f.number(ai.data.tools)} tools`}
        />,
      });
    }
    return out;
  }, [billing.data, crm.data, metering.data, credits.data, ai.data, session.currency, f]);

  /* -------------------------------- setup -------------------------------- */

  const routePaths = useMemo(() => ROUTES.map((route) => route.path), []);
  const steps = useMemo<SetupStep[]>(() => {
    const org = session.me?.org;
    const list: SetupStep[] = [{
      id: 'workspace',
      label: 'Workspace profile',
      detail: org?.domain
        ? `${org.name} · ${org.domain} · ${org.default_currency.toUpperCase()} · ${org.timezone.replace(/_/g, ' ')}`
        : 'Add a domain, currency and timezone so invoices and reports read correctly.',
      done: !!org?.domain,
      to: firstRegistered(routePaths, ['/settings', '/settings/workspace']) ?? undefined,
    }, {
      id: 'team',
      label: 'Teammates invited',
      detail: `${session.me?.teammates.length ?? 0} people can sign in to this workspace.`,
      done: (session.me?.teammates.length ?? 0) > 1,
      to: firstRegistered(routePaths, ['/settings/team', '/settings/users']) ?? undefined,
    }];
    if (catalog.data) list.push({
      id: 'catalog',
      label: 'Price book published',
      detail: `${catalog.data.totals.products} products carrying ${catalog.data.totals.active_prices} live prices.`,
      done: catalog.data.totals.active_prices > 0,
      to: firstRegistered(routePaths, ['/products', '/catalog']) ?? undefined,
    });
    if (metering.data) {
      const live = metering.data.meters.filter((meter) => meter.events_30d > 0).length;
      list.push({
        id: 'metering',
        label: 'Usage arriving',
        detail: live
          ? `${live} of ${metering.data.meters.length} meters received events in the last 30 days.`
          : 'No meter has seen an event in 30 days — point your product at POST /v1/meter-events.',
        done: live > 0,
        to: firstRegistered(routePaths, ['/meters', '/usage']) ?? undefined,
      });
    }
    if (billing.data) list.push({
      id: 'billing',
      label: 'Subscriptions billing',
      detail: `${billing.data.live} live of ${billing.data.subscriptions} subscriptions across ${billing.data.customers} accounts.`,
      done: billing.data.live > 0,
      to: firstRegistered(routePaths, ['/subscriptions', '/billing']) ?? undefined,
    });
    if (credits.data) list.push({
      id: 'credits',
      label: 'Prepaid credit configured',
      detail: credits.data.grants.total
        ? `${credits.data.grants.total} grants issued, ${credits.data.grants.active} still drawing down.`
        : 'Grant prepaid credit to bill committed spend up front.',
      done: credits.data.grants.total > 0,
      to: firstRegistered(routePaths, ['/credits', '/credit-grants']) ?? undefined,
    });
    if (isAdmin && keys.data) list.push({
      id: 'api-key',
      label: 'API key issued',
      detail: keys.data.data.length
        ? `${keys.data.data.length} key${keys.data.data.length === 1 ? '' : 's'} can call this workspace over HTTP.`
        : 'Create a key so your product can push usage and read invoices.',
      done: keys.data.data.length > 0,
      to: firstRegistered(routePaths, ['/settings/api-keys', '/developers']) ?? undefined,
    });
    if (ai.data) {
      const hosted = ai.data.providers.find((provider) => provider.id === 'anthropic');
      list.push({
        id: 'ai',
        label: 'Model provider connected',
        detail: hosted?.available
          ? `${ai.data.provider.label} is answering, with ${ai.data.tools} tools available.`
          : `${ai.data.provider.label} is answering. Set ANTHROPIC_API_KEY to route the agents to Claude instead.`,
        done: !!hosted?.available,
        to: firstRegistered(routePaths, ['/settings/ai', '/agents']) ?? undefined,
      });
    }
    return list;
  }, [session.me, catalog.data, metering.data, billing.data, credits.data, keys.data, ai.data, isAdmin, routePaths]);

  const ordered = useMemo(() => orderSetup(steps), [steps]);
  const progress = setupProgress(steps);
  // A check whose read failed is not a check that passed and not one that
  // failed — it is a check that was never made, and "2 of 2 complete" over a
  // dead API is the most confident wrong sentence on the screen.
  const SETUP_FEEDS = ['catalog', 'metering', 'billing', 'credits', 'keys', 'ai'];
  const unreadableChecks = failed.filter((feed) => SETUP_FEEDS.includes(feed.key));
  // Every gated read is skipped entirely when the module list did not answer,
  // so those panels have no error of their own to show — only the absence of a
  // question ever being asked. That is still not an empty workspace.
  const modulesUnknown = !!platform.error;
  const setupGap = platform.error
    ? {
      title: 'The rest of this checklist could not be made',
      body: 'The module list did not answer, so Ain cannot tell whether the price book, meters, subscriptions, prepaid credit, API keys and model provider are configured on this workspace.',
      error: platform.error,
      retry: platform.retry,
    }
    : unreadableChecks.length
      ? {
        title: `${unreadableChecks.length} of these checks could not be made`,
        body: `${unreadableChecks.map((feed) => feed.label).join(', ')} did not answer, so this count covers only what could be read.`,
        error: unreadableChecks[0].error,
        retry: retryFailed,
      }
      : null;

  /* ------------------------------- pipeline ------------------------------ */

  const openStages = useMemo(
    () => (crm.data?.pipeline ?? []).filter((row) => !row.is_closed && row.deals > 0),
    [crm.data],
  );
  // Northwind runs several pipelines and they share stage names ("Negotiation"
  // exists in both new business and expansion), so one chart per pipeline is the
  // only reading that is not ambiguous.
  const pipelines = useMemo(() => {
    const map = new Map<string, { label: string; amount: number }>();
    for (const row of openStages) {
      const found = map.get(row.pipeline_label);
      if (found) found.amount += row.amount;
      else map.set(row.pipeline_label, { label: row.pipeline_label, amount: row.amount });
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }, [openStages]);
  const [pipeline, setPipeline] = useState<string | null>(null);
  const shownPipeline = pipeline && pipelines.some((p) => p.label === pipeline) ? pipeline : pipelines[0]?.label;
  const stages = useMemo(
    () => openStages.filter((row) => row.pipeline_label === shownPipeline),
    [openStages, shownPipeline],
  );
  const moneyAxis = (value: number) => `${f.symbol()}${formatCompact(toMajorUnits(value, f.currency), { locale: f.locale })}`;

  return (
    <Page
      title={`${greetingFor(now, session.timeZone)}${firstName ? `, ${firstName}` : ''}`}
      subtitle={headline}
      width="wide"
      actions={
        <>
          <Button iconLeft={<Icons.search size={14} />} onClick={() => shell.openSearch()}>Search</Button>
          <Button variant="primary" iconLeft={<Icons.command size={14} />} onClick={shell.openPalette}>
            Command palette
          </Button>
        </>
      }
    >
      {booting && (
        <div className="home-tiles">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={92} />)}
        </div>
      )}

      {/* Every card on this screen is gated on the module list. When that read
          itself failed, "no module is installed" is a guess — and the guess
          renders as an empty, confident workspace. */}
      {platform.error && (
        <Card>
          <ErrorState
            title="This workspace could not list its modules"
            message={`${platform.error.body.message} Until it answers, the dashboard cannot tell which of CRM, billing, metering, credits and the price book are installed here, so it is showing nothing rather than guessing.`}
            code={platform.error.body.code}
            requestId={platform.error.body.request_id ?? null}
            action={
              <Button variant="primary" iconLeft={<Icons.refresh size={14} />} onClick={platform.retry}>
                Try again
              </Button>
            }
            secondaryAction={<Button onClick={shell.refresh}>Reload every panel</Button>}
          />
        </Card>
      )}

      {!booting && !platform.error && !tiles.length && !failed.length && (
        <EmptyState
          title="No module is reporting numbers yet"
          body="The dashboard fills in as modules are installed — the CRM overview, the billing overview, meters, credits and the price book all publish to this screen."
        />
      )}

      {(tiles.length > 0 || failed.length > 0) && (
        <div className="home-tiles">
          {tiles.map((tile) => (
            <Card key={tile.key} padding="tight">{tile.node}</Card>
          ))}
          {failed.map((feed) => (
            <TileFailure key={feed.key} feed={feed} />
          ))}
        </div>
      )}

      <div className="home-grid">
        {WIDGETS.map((widget) => (
          <div className="home-cell" key={widget.id} style={cell(widget.span)}>
            <ErrorBoundary
              title={`${widget.title} could not render`}
              message="The rest of the dashboard is unaffected."
            >
              <widget.component />
            </ErrorBoundary>
          </div>
        ))}

        {crm.error && (
          <div className="home-cell" style={cell(8)}>
            <PanelFailure
              title="Open pipeline by stage"
              description="Deal value by stage, read from the CRM overview"
              feed={feed('crm')}
            />
          </div>
        )}

        {!crm.error && stages.length > 0 && (
          <div className="home-cell" style={cell(8)}>
            <Card
              title="Open pipeline by stage"
              description={`${f.number(stages.reduce((n, stage) => n + stage.deals, 0))} deals worth ${f.money(stages.reduce((n, stage) => n + stage.amount, 0))}`}
              actions={
                <>
                  {pipelines.length > 1 && (
                    <SegmentedControl
                      size="sm"
                      aria-label="Pipeline"
                      value={shownPipeline ?? ''}
                      onChange={setPipeline}
                      options={pipelines.map((row) => ({ value: row.label, label: row.label }))}
                    />
                  )}
                  {pipelineLink(routePaths, navigate)}
                </>
              }
            >
              <BarChart
                title={`Open pipeline value by stage — ${shownPipeline}`}
                description="Total value of the deals sitting in each open stage of this pipeline."
                horizontal
                height={Math.max(260, stages.length * 48)}
                legend={false}
                categories={stages.map((stage) => stage.label)}
                valueFormat={moneyAxis}
                series={[{ id: 'amount', label: 'Open value', values: stages.map((stage) => stage.amount) }]}
              />
            </Card>
          </div>
        )}

        {!modulesUnknown && (
          <div className="home-cell" style={cell(4)}>
            <NextUp
              jobs={jobs.data?.data ?? []}
              loading={jobs.loading}
              error={jobs.error}
              onRetry={jobs.refetch}
            />
          </div>
        )}

        {!modulesUnknown && (
        <div className="home-cell" style={cell(4)}>
          <Card
            title="Activity"
            description="Straight off the event log"
            padding="none"
          >
            {events.error && (
              <div style={{ padding: 'var(--space-6)' }}>
                <ErrorState
                  title="The event log did not answer"
                  message={events.error.body.message}
                  code={events.error.body.code}
                  requestId={events.error.body.request_id ?? null}
                  action={
                    <Button size="sm" variant="primary" iconLeft={<Icons.refresh size={13} />} onClick={events.refetch}>
                      Try again
                    </Button>
                  }
                />
              </div>
            )}
            {!events.error && events.loading && <div style={{ padding: 'var(--space-6)' }}><SkeletonText lines={5} /></div>}
            {!events.error && !events.loading && !(events.data?.data.length) && (
              <div style={{ padding: 'var(--space-6)' }}>
                <EmptyState
                  size="sm"
                  inline
                  illustration={null}
                  title="Nothing has happened yet"
                  body="Every write emits an event. They land here the moment they do."
                />
              </div>
            )}
            <div className="home-list">
              {(events.data?.data ?? []).slice(0, 8).map((event) => (
                <div className="home-row" key={event.id}>
                  <span className="home-row__icon"><Glyph name={eventIcon(event.type)} size={14} /></span>
                  <span className="home-row__text">
                    <span className="home-row__title u-truncate">{eventTitle(event.type)}</span>
                    <span className="home-row__sub u-truncate">
                      {eventSubject(event.data) ?? event.object_id ?? 'system'}
                    </span>
                  </span>
                  <span className="home-row__when">{f.relative(event.created)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
        )}

        <div className="home-cell" style={cell(4)}>
          <Card
            title="Set-up"
            description={
              setupGap
                ? `${steps.filter((step) => step.done).length} of ${steps.length} checks passed · the rest could not be made`
                : `${steps.filter((step) => step.done).length} of ${steps.length} complete`
            }
            padding="none"
            footer={
              <ProgressBar
                value={progress}
                tone={setupGap ? 'warning' : progress === 1 ? 'success' : 'brand'}
                size="sm"
              />
            }
          >
            {setupGap && (
              <div style={{ padding: 'var(--space-5) var(--space-6) 0' }}>
                <Banner
                  tone="warning"
                  compact
                  title={setupGap.title}
                  actions={
                    <Button size="sm" variant="secondary" iconLeft={<Icons.refresh size={13} />} onClick={setupGap.retry}>
                      Try again
                    </Button>
                  }
                >
                  {setupGap.body} {setupGap.error.body.message}
                  {setupGap.error.body.request_id
                    ? <> <span className="u-mono">{setupGap.error.body.request_id}</span></>
                    : null}
                </Banner>
              </div>
            )}
            <div className="home-list">
              {ordered.map((step) => (
                <div className="home-step" key={step.id}>
                  <span className={`home-step__mark${step.done ? ' is-done' : ''}`}>
                    {step.done ? <Icons.check size={11} /> : null}
                  </span>
                  <span className="home-step__text">
                    <span className={`home-step__label${step.done ? ' is-done' : ''}`}>{step.label}</span>
                    <span className="home-step__detail">{step.detail}</span>
                  </span>
                  {step.to && !step.done && (
                    <Button size="sm" variant="ghost" onClick={() => navigate(step.to!)}>Open</Button>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </div>

        {catalog.error && (
          <div className="home-cell" style={cell(4)}>
            <PanelFailure
              title="Price book"
              description="Products and the live prices they carry"
              feed={feed('catalog')}
            />
          </div>
        )}

        {!catalog.error && catalog.data && catalog.data.plans.length > 0 && (
          <div className="home-cell" style={cell(4)}>
            <Card
              title="Price book"
              description={`${catalog.data.totals.products} products · ${catalog.data.totals.active_prices} live prices`}
              padding="none"
            >
              <div className="home-list">
                {catalog.data.plans.map((plan) => (
                  <div className="home-plan" key={plan.product.id}>
                    <span className="home-plan__name u-truncate">
                      {plan.product.name}
                      {plan.product.tagline && <div className="home-plan__tagline u-truncate">{plan.product.tagline}</div>}
                    </span>
                    <span className="home-plan__price">{plan.base.month?.display.summary ?? 'Custom'}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {crm.error && (
          <div className="home-cell" style={cell(12)}>
            <PanelFailure
              title="What this workspace holds"
              description="Live record counts and 30 days of logged activity"
              feed={feed('crm')}
            />
          </div>
        )}

        {!crm.error && crm.data && crm.data.records.length > 0 && (
          <div className="home-cell" style={cell(12)}>
            <Card
              title="What this workspace holds"
              description="Live record counts, and what the team logged in the last 30 days"
            >
              <div className="home-facts">
                {crm.data.records.filter((record) => record.category === 'record').map((record) => (
                  <div className="home-fact" key={record.name}>
                    <span className="home-fact__icon"><Glyph name={record.icon} size={14} /></span>
                    <span className="home-fact__value">{f.number(record.count)}</span>
                    <span className="home-fact__label">{record.label}</span>
                  </div>
                ))}
              </div>
              <Divider />
              <div className="home-facts">
                {crm.data.activity_last_30_days.map((row) => (
                  <div className="home-fact" key={row.type}>
                    <span className="home-fact__icon"><Glyph name={eventIcon(row.type)} size={14} /></span>
                    <span className="home-fact__value">{f.number(row.count)}</span>
                    <span className="home-fact__label">{humanize(row.type)}s · 30 days</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </div>
      {credits.data?.expiring_within_7_days.length ? (
        <Card title="Credit expiring this week" description="Grants that lapse within seven days of the workspace clock">
          <div className="home-list">
            {credits.data.expiring_within_7_days.map((grant) => (
              <div className="home-row" key={grant.id}>
                <span className="home-row__icon"><Glyph name="coins" size={14} /></span>
                <span className="home-row__text">
                  <span className="home-row__title u-truncate">{grant.name}</span>
                  <span className="home-row__sub u-mono">{grant.id}</span>
                </span>
                <Badge tone="warning" size="sm">{f.relative(grant.expires_at)}</Badge>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </Page>
  );
}

function pipelineLink(routePaths: string[], navigate: (to: string) => void): ReactNode {
  const to = firstRegistered(routePaths, ['/deals', '/crm/deals', '/pipeline']);
  if (!to) return null;
  return <Button size="sm" variant="ghost" onClick={() => navigate(to)}>Open pipeline</Button>;
}

/* ------------------------------- next up card ---------------------------- */

function NextUp({ jobs, loading, error, onRetry }: {
  jobs: JobRow[];
  loading: boolean;
  error: ApiClientError | null;
  onRetry: () => void;
}) {
  const session = useSession();
  const shell = useShell();
  const toast = useToast();
  const f = useFormat();
  const now = session.now();
  const canAdvance = session.me?.clock.kind === 'virtual' && ['owner', 'admin'].includes(session.me?.role ?? '');
  const { advance, busy } = useTimeMachine(shell.refresh);

  const upcoming = useMemo(
    () => jobs.filter((job) => job.run_at > now).sort((a, b) => a.run_at - b.run_at),
    [jobs, now],
  );
  const next = upcoming[0];

  const grouped = useMemo(() => {
    const map = new Map<string, { type: string; count: number; soonest: number }>();
    for (const job of upcoming) {
      const row = map.get(job.type);
      if (row) { row.count += 1; row.soonest = Math.min(row.soonest, job.run_at); }
      else map.set(job.type, { type: job.type, count: 1, soonest: job.run_at });
    }
    return [...map.values()].sort((a, b) => a.soonest - b.soonest).slice(0, 4);
  }, [upcoming]);

  const runToNext = async () => {
    if (!next) return;
    try {
      const move = await advance({ to: next.run_at + 1000 });
      const outcome = clockOutcome({
        movedTo: f.dateTime(move.now),
        label: `Ran the queue to ${humanize(next.type).toLowerCase()}`,
        jobsRun: move.jobsRun,
        jobsFailed: move.jobsFailed,
        aftermath: aftermathOf(move),
      });
      const raise = outcome.tone === 'success' ? toast.success : toast.error;
      raise(outcome.title, outcome.description, outcome.pinned ? { duration: 0 } : undefined);
    } catch (e) {
      toast.error(
        'The clock did not move',
        e instanceof Error ? e.message : 'The server refused the request.',
        { duration: 0 },
      );
    }
  };

  return (
    <Card
      title="Scheduled work"
      description="Nothing sleeps on a timer — every deferred job is a row with a due date"
    >
      {error && (
        <ErrorState
          title="The job queue did not answer"
          message={error.body.message}
          code={`${error.status} /v1/jobs`}
          requestId={error.body.request_id ?? null}
          action={
            <Button size="sm" variant="primary" iconLeft={<Icons.refresh size={13} />} onClick={onRetry}>
              Try again
            </Button>
          }
        />
      )}
      {!error && loading && <SkeletonText lines={4} />}
      {!error && !loading && !next && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="The queue is empty"
          body="No renewal, retry or expiry is waiting on the clock right now."
        />
      )}
      {!error && next && (
        <div className="home-next">
          <div>
            <div className="home-next__lede">Next up · {humanize(next.type)}</div>
            <div className="home-next__when">{f.relative(next.run_at)}</div>
            <div className="home-next__lede">{f.dateTime(next.run_at)}</div>
          </div>
          <div className="home-list">
            {grouped.map((row) => (
              <div className="home-row" key={row.type} style={{ paddingInline: 0 }}>
                <span className="home-row__icon"><Glyph name={eventIcon(row.type)} size={14} /></span>
                <span className="home-row__text">
                  <span className="home-row__title u-truncate">{humanize(row.type)}</span>
                  <span className="home-row__sub">{f.plural(row.count, 'job')} queued</span>
                </span>
                <span className="home-row__when">{f.relative(row.soonest)}</span>
              </div>
            ))}
          </div>
          {canAdvance && (
            <Button
              variant="secondary"
              block
              loading={busy}
              iconLeft={<Icons.zap size={14} />}
              onClick={runToNext}
            >
              Run the clock to {f.date(next.run_at, { withYear: false })}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------- registration ---------------------------- */

export const routes: RouteDef[] = [{ path: '/', element: Home, title: 'Home' }];

export const nav: NavItem[] = [
  { id: 'home', label: 'Home', to: '/', group: 'workspace', order: 0, icon: 'dashboard' },
];

export const commands: CommandDef[] = [
  {
    id: 'home.open',
    title: 'Dashboard',
    subtitle: 'Where the workspace stands right now',
    group: 'Go to',
    keywords: ['home', 'overview', 'dashboard'],
    icon: 'dashboard',
    run: (nav) => nav('/'),
  },
];
