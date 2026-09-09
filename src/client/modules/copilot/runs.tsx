/**
 * Agent observability.
 *
 * Every run the platform has made — copilot questions, agent work, approvals —
 * with what it was asked, what it decided, which tools it called with which
 * arguments, how long each took, what it cost in tokens and credits, and how it
 * ended. HubSpot will tell you Breeze did something; this says why.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, useQuery, type ApiClientError, type ListEnvelope } from '@/client/kernel/api';
import { useRouter } from '@/client/kernel/router';
import {
  AlertTriangleIcon, Badge, Banner, BarChart, Button, Card, DataTable, EmptyState, ErrorState, Icons,
  MessageSquareIcon, Page, SearchInput, SegmentedControl, Select, SkeletonText, Stat, humanize, useFormat,
  useToast,
  type DataTableColumn, type SelectOption,
} from '@/client/design';
import {
  OUTCOME_LABEL, OUTCOME_TONE, answerCard, currencyRefusal, humanTool, runOutcome, useAiStatus, useAiUsage,
  useAllApprovals, useApprovals, useFeatureCatalogue, useRun, useTemplates, useTools, useVocabulary, windowText,
  type AiRun, type AiUsageBucket, type RunDetail, type RunOutcome,
} from './api';
import { ApprovalQueue, CitationChips, ReasoningList, RunFacts, TraceSteps } from './trace';
import { CarriedMeasure, CurrencyRefusalNote, EngineIndicator, RefusalHelp, SlotChips, currencyRefusalTitle } from './card';
import { filterTools, tagLabel, toolSummary } from './tools-core';
import { dayStart, everyDay } from './usage-core';

/** How many runs one read of the log brings back, and how far each “show more” goes. */
const PAGE = 100;

export type RunsTab = 'runs' | 'approvals' | 'usage' | 'tools';

const TABS: readonly RunsTab[] = ['runs', 'approvals', 'usage', 'tools'];

/** Where each tab lives: the queue has its own address, the rest are views of the log. */
const tabHref = (tab: RunsTab): string =>
  tab === 'approvals' ? '/copilot/approvals' : tab === 'runs' ? '/copilot/runs' : `/copilot/runs?tab=${tab}`;

/* ------------------------------- run list --------------------------------- */

export function RunsPage({ tab: fixedTab }: { tab?: RunsTab } = {}) {
  const f = useFormat();
  const toast = useToast();
  const { location, navigate, setQuery } = useRouter();
  const status = location.query.status ?? '';
  const feature = location.query.feature ?? '';
  const asked = location.query.tab;
  const tab: RunsTab = fixedTab ?? (TABS.includes(asked as RunsTab) ? (asked as RunsTab) : 'runs');

  // The outcome filter is applied here rather than by the server, because the
  // server's `needs_approval` never resolves once a person decides: a run whose
  // write was declined would sit in that filter for ever. The approvals say what
  // really happened, so the filter is computed from the same answer the column
  // shows.
  const runs = useQuery<ListEnvelope<AiRun>>('/v1/ai/runs', {
    limit: PAGE,
    ...(feature ? { feature } : {}),
  });

  /**
   * The rest of the log, a page at a time.
   *
   * `/v1/ai/runs` answers at most 100 rows, and this screen used to ask for 100
   * and stop — so on an observability surface the run you are hunting is the one
   * you cannot reach. The next pages are fetched by offset and appended, which
   * keeps the table one growing list and keeps the tiles above totalling exactly
   * what is on screen.
   */
  const [older, setOlder] = useState<AiRun[]>([]);
  const [reading, setReading] = useState(false);
  useEffect(() => { setOlder([]); }, [feature]);

  const read = useMemo(() => {
    const seen = new Set<string>();
    const out: AiRun[] = [];
    for (const run of [...(runs.data?.data ?? []), ...older]) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      out.push(run);
    }
    return out;
  }, [runs.data, older]);

  const logged = runs.data?.total_count ?? read.length;

  const readMore = useCallback(async () => {
    setReading(true);
    try {
      const page = await api.get<ListEnvelope<AiRun>>('/v1/ai/runs', {
        limit: PAGE, offset: read.length, ...(feature ? { feature } : {}),
      });
      setOlder((current) => [...current, ...page.data]);
    } catch (e) {
      toast.error('The rest of the log did not answer', (e as ApiClientError).body.message);
    } finally {
      setReading(false);
    }
  }, [read.length, feature, toast]);

  const decisions = useAllApprovals();
  const approvals = useApprovals(location.query.approvals ?? 'pending');

  const outcomeOf = useCallback(
    (run: AiRun): RunOutcome => runOutcome(run, decisions.byRun.get(run.id)),
    [decisions],
  );

  const rows = useMemo(
    () => read.filter((run) => !status || outcomeOf(run) === status),
    [read, status, outcomeOf],
  );

  // Never from `rows`: those are already narrowed by the very control this list
  // fills, so picking a feature used to delete every other feature from the menu.
  const catalogue = useFeatureCatalogue();
  const features = useMemo(
    () => [...new Set([
      ...(catalogue.data?.by_feature ?? []).map((bucket) => bucket.key),
      ...read.map((run) => run.feature),
      ...(feature ? [feature] : []),
    ])].sort(),
    [catalogue.data, read, feature],
  );

  const totals = useMemo(() => {
    let credits = 0;
    let tokens = 0;
    let ms = 0;
    let failed = 0;
    let refused = 0;
    for (const run of rows) {
      credits += run.usage.credits;
      tokens += run.usage.input_tokens + run.usage.output_tokens;
      ms += run.duration_ms;
      if (run.status === 'failed') failed += 1;
      // Counted off the same rule the Outcome column shows, so the tile and
      // the table can never disagree about how many questions went unanswered.
      if (outcomeOf(run) === 'refused') refused += 1;
    }
    return { credits, tokens, ms, failed, refused, count: rows.length };
  }, [rows, outcomeOf]);

  const columns = useMemo<DataTableColumn<AiRun>[]>(() => [
    {
      id: 'started',
      header: 'When',
      width: 120,
      sortable: true,
      accessor: (row) => row.started,
      cell: (row) => <span title={f.dateTime(row.started)}>{f.relative(row.started)}</span>,
    },
    {
      id: 'question',
      header: 'Asked',
      pinned: true,
      width: 320,
      accessor: (row) => row.question,
      cell: (row) => <span className="u-truncate" title={row.question}>{row.question}</span>,
    },
    // Widths are set on every column that is not the question, so the header
    // never has to fit "Feature" into what is left: at 1512 wide the table
    // read "Feat…", "Aggre…" and "Dura…". They sum to 1,200px, which is what
    // the card has at that width; anything narrower scrolls inside the table
    // with the question pinned.
    {
      id: 'feature',
      header: 'Feature',
      width: 110,
      filter: 'set',
      accessor: (row) => row.feature,
      cell: (row) => <Badge size="sm" tone="neutral">{humanize(row.feature)}</Badge>,
    },
    {
      id: 'status',
      header: 'Outcome',
      width: 172,
      filter: 'set',
      accessor: (row) => OUTCOME_LABEL[outcomeOf(row)],
      cell: (row) => {
        const outcome = outcomeOf(row);
        return <Badge size="sm" tone={OUTCOME_TONE[outcome]}>{OUTCOME_LABEL[outcome]}</Badge>;
      },
    },
    {
      id: 'intent',
      header: 'Intent',
      width: 126,
      filter: 'set',
      accessor: (row) => (row.intent ? humanize(row.intent) : '—'),
    },
    {
      // Every template run reads its intent at 100%, so the column says the
      // same thing on every row; it is there for the model's runs, on demand.
      id: 'confidence',
      header: 'Confidence',
      width: 118,
      align: 'right',
      sortable: true,
      accessor: (row) => row.confidence ?? 0,
      cell: (row) => (row.confidence === null ? <span className="cp-note">—</span> : `${Math.round(row.confidence * 100)}%`),
      defaultHidden: true,
    },
    {
      id: 'steps',
      header: 'Steps',
      width: 72,
      align: 'right',
      sortable: true,
      accessor: (row) => row.span_count,
    },
    {
      id: 'duration',
      header: 'Duration',
      width: 104,
      align: 'right',
      sortable: true,
      accessor: (row) => row.duration_ms,
      cell: (row) => `${f.number(row.duration_ms)} ms`,
    },
    {
      id: 'tokens',
      header: 'Tokens',
      width: 92,
      align: 'right',
      sortable: true,
      accessor: (row) => row.usage.input_tokens + row.usage.output_tokens,
      cell: (row) => f.number(row.usage.input_tokens + row.usage.output_tokens),
      total: (_rows, sum) => f.number(sum),
    },
    {
      id: 'credits',
      header: 'Credits',
      width: 84,
      align: 'right',
      sortable: true,
      accessor: (row) => row.usage.credits,
      total: (_rows, sum) => f.number(sum),
    },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      sortable: true,
      accessor: (row) => row.usage.cost_micros,
      cell: (row) => (row.usage.cost_micros > 0 ? f.money(row.usage.cost_cents) : <span className="cp-note">none</span>),
      defaultHidden: true,
    },
    {
      id: 'model',
      header: 'Model',
      filter: 'set',
      accessor: (row) => row.model,
      defaultHidden: true,
    },
  ], [f, outcomeOf]);

  return (
    <Page
      title={tab === 'approvals' ? 'Approvals' : tab === 'usage' ? 'AI usage' : tab === 'tools' ? 'Tools' : 'Runs and traces'}
      width="wide"
      subtitle={
        tab === 'approvals'
          ? 'Writes an agent prepared and stopped on, until a person decides'
          : tab === 'usage'
            ? 'Credits, tokens and provider spend across the whole log — by day, feature, teammate and model'
            : tab === 'tools'
              ? 'Every tool the copilot and the agents read and write the workspace through'
              : runs.data
                ? `${f.plural(totals.count, 'run')} · ${f.number(totals.tokens)} tokens · ${f.plural(totals.credits, 'credit')}${totals.refused ? ` · ${totals.refused} refused` : ''}${totals.failed ? ` · ${totals.failed} failed` : ''}`
                : 'Every question the engine has been asked, and what it did about it'
      }
      actions={
        <>
          <SegmentedControl
            value={tab}
            onChange={(next) => navigate(tabHref(next as RunsTab))}
            aria-label="Runs, approvals, usage or tools"
            options={[
              { value: 'runs', label: 'Runs', icon: <Icons.activity size={14} /> },
              { value: 'approvals', label: 'Approvals', icon: <Icons.shield size={14} /> },
              { value: 'usage', label: 'Usage', icon: <Icons.gauge size={14} /> },
              { value: 'tools', label: 'Tools', icon: <Icons.terminal size={14} /> },
            ]}
          />
          <Button variant="primary" iconLeft={<Icons.sparkles size={14} />} onClick={() => navigate('/copilot')}>
            Open the copilot
          </Button>
        </>
      }
    >
      {tab === 'usage' && <UsagePanel />}
      {tab === 'tools' && <ToolsPanel />}
      {tab === 'approvals' && (
        <Card
          title="Writes waiting on a person"
          description="Each card shows the tool, the exact arguments and what it would change. Nothing runs until you approve it."
          actions={
            <Select
              value={location.query.approvals ?? 'pending'}
              onChange={(next) => setQuery({ approvals: next === 'pending' ? undefined : next })}
              size="sm"
              aria-label="Approval status"
              options={[
                { value: 'pending', label: 'Pending' },
                { value: 'approved', label: 'Approved' },
                { value: 'declined', label: 'Declined' },
              ] as SelectOption[]}
            />
          }
        >
          {approvals.error && (
            <ErrorState
              title="The approval queue did not answer"
              message={approvals.error.body.message}
              code={`${approvals.error.status} /v1/ai/approvals`}
              requestId={approvals.error.body.request_id ?? null}
              action={<Button size="sm" variant="primary" onClick={approvals.refetch}>Try again</Button>}
            />
          )}
          {!approvals.error && approvals.loading && <SkeletonText lines={6} />}
          {!approvals.error && approvals.data && (
            <ApprovalQueue
              approvals={approvals.data.data}
              onDecided={approvals.refetch}
              onAsk={() => navigate('/copilot?new=1&writes=1')}
              onShowDecided={(location.query.approvals ?? 'pending') === 'pending'
                ? () => setQuery({ approvals: 'approved' })
                : undefined}
            />
          )}
        </Card>
      )}
      {tab === 'runs' && (
        <>
          <div className="pl-summary">
            <Card padding="tight">
              <Stat
                label="Runs in view"
                value={f.number(totals.count)}
                icon={<Icons.activity size={15} />}
                caption={
                  status
                    ? `${f.plural(read.length, 'run')} read${logged > read.length ? ` of ${f.number(logged)} logged` : ''}, filtered to ${humanize(status).toLowerCase()}`
                    : logged > read.length
                      ? `The newest ${f.number(read.length)} of ${f.number(logged)} in the log`
                      : feature
                        ? `Every ${humanize(feature).toLowerCase()} run this workspace has logged`
                        // Not "every run": the draft engine composes without
                        // opening a run, so it has nothing to show here and the
                        // caption says so rather than over-claiming.
                        : 'Every question and agent run this workspace has logged — drafting does not open one'
                }
              />
            </Card>
            <Card padding="tight">
              <Stat label="Tokens" value={f.compact(totals.tokens)} icon={<Icons.cpu size={15} />} caption={`${f.plural(totals.credits, 'credit')} charged`} />
            </Card>
            <Card padding="tight">
              <Stat label="Engine time" value={`${f.number(totals.ms)} ms`} icon={<Icons.clock size={15} />} caption={totals.count ? `${f.number(Math.round(totals.ms / totals.count))} ms per run` : 'No runs yet'} />
            </Card>
            <Card padding="tight">
              <Stat label="Failed" value={f.number(totals.failed)} icon={<AlertTriangleIcon size={15} />} caption="Runs that ended in an error" />
            </Card>
            <Card padding="tight">
              {/* A refusal is not a failure and not a success: the engine read
                  the question, could not bind part of it and said so. It was
                  logged as "Succeeded", which made the single most important
                  operational number on this screen unreadable. */}
              <Stat
                label="Refused"
                value={f.number(totals.refused)}
                icon={<Icons.shield size={15} />}
                caption={totals.count ? `${Math.round((totals.refused / totals.count) * 100)}% of the runs in view` : 'No runs yet'}
              />
            </Card>
          </div>

          <div className="pl-toolbar">
            <Select
              value={status}
              onChange={(next) => setQuery({ status: next || undefined })}
              size="sm"
              aria-label="Run status"
              icon={<Icons.filter size={13} />}
              options={[
                { value: '', label: 'Every outcome' },
                { value: 'succeeded', label: 'Succeeded' },
                { value: 'needs_approval', label: 'Needs approval' },
                { value: 'written', label: 'Approved and written' },
                { value: 'scheduled', label: 'Approved and scheduled' },
                { value: 'declined', label: 'Declined' },
                { value: 'refused', label: 'Refused' },
                { value: 'failed', label: 'Failed' },
                { value: 'running', label: 'Running' },
              ] as SelectOption[]}
            />
            <Select
              value={feature}
              onChange={(next) => setQuery({ feature: next || undefined })}
              size="sm"
              aria-label="Feature"
              icon={<Icons.layers size={13} />}
              options={[
                { value: '', label: 'Every feature' },
                ...features.map<SelectOption>((name) => ({ value: name, label: humanize(name) })),
              ]}
            />
          </div>

          {runs.error && (
            <Card>
              <ErrorState
                title="The run log did not answer"
                message={runs.error.body.message}
                code={`${runs.error.status} /v1/ai/runs`}
                requestId={runs.error.body.request_id ?? null}
                action={<Button variant="primary" iconLeft={<Icons.refresh size={14} />} onClick={runs.refetch}>Try again</Button>}
              />
            </Card>
          )}

          {!runs.error && runs.data && logged > read.length && (
            <Banner tone="info" compact bar>
              The newest {f.number(read.length)} of {f.plural(logged, 'run')} are on screen, and every figure above totals those.
              {' '}
              <Button size="sm" variant="link" loading={reading} onClick={() => { void readMore(); }}>
                Read {f.number(Math.min(PAGE, logged - read.length))} more
              </Button>
            </Banner>
          )}

          {!runs.error && (
            <DataTable<AiRun>
              rows={rows}
              columns={columns}
              getRowId={(row) => row.id}
              caption="AI runs"
              loading={runs.loading}
              onRowClick={(row) => navigate(`/copilot/runs/${row.id}`)}
              searchable
              searchPlaceholder="Search the questions asked"
              showColumnToggle
              showFilters
              stickyFooter
              initialSort={{ columnId: 'started', direction: 'desc' }}
              empty={
                <EmptyState
                  title={status || feature ? 'No run matches this filter' : 'The engine has not run yet'}
                  body={status || feature
                    ? 'Clear the filters to see the whole log.'
                    : 'Ask the copilot a question and the run, its plan, its tool calls and its cost all land here.'}
                  action={
                    status || feature
                      ? <Button variant="primary" onClick={() => setQuery({ status: undefined, feature: undefined })}>Clear filters</Button>
                      : <Button variant="primary" onClick={() => navigate('/copilot')}>Open the copilot</Button>
                  }
                />
              }
            />
          )}
        </>
      )}
    </Page>
  );
}

/* --------------------------------- usage ---------------------------------- */

const USAGE_WINDOWS: SelectOption[] = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' },
];


/**
 * What the engine has cost, over the whole log.
 *
 * `/v1/ai/usage` has answered credits by day, feature, teammate and model all
 * along and nothing drew it: the run log's tiles totalled the rows on screen
 * — at most a hundred — and the subtitle's "51 tools" was the only thing said
 * about the tools. Every figure here is a field of that one response.
 */
function UsagePanel() {
  const f = useFormat();
  const { location, setQuery } = useRouter();
  const window = Number.parseInt(location.query.days ?? '', 10) || 30;
  const usage = useAiUsage(window);
  const report = usage.data;

  const bucketColumns = useMemo((): DataTableColumn<AiUsageBucket>[] => [
    { id: 'runs', header: 'Runs', align: 'right', sortable: true, accessor: (row) => row.runs, cell: (row) => f.number(row.runs), total: (_rows, sum) => f.number(sum) },
    { id: 'credits', header: 'Credits', align: 'right', sortable: true, accessor: (row) => row.credits, cell: (row) => f.number(row.credits), total: (_rows, sum) => f.number(sum) },
    {
      id: 'tokens',
      header: 'Tokens',
      align: 'right',
      sortable: true,
      accessor: (row) => row.input_tokens + row.output_tokens,
      cell: (row) => <span title={`${f.number(row.input_tokens)} in · ${f.number(row.output_tokens)} out`}>{f.number(row.input_tokens + row.output_tokens)}</span>,
      total: (_rows, sum) => f.number(sum),
    },
    { id: 'tool_calls', header: 'Tool calls', align: 'right', sortable: true, accessor: (row) => row.tool_calls, cell: (row) => f.number(row.tool_calls), total: (_rows, sum) => f.number(sum) },
    {
      id: 'spend',
      header: 'Provider spend',
      align: 'right',
      sortable: true,
      accessor: (row) => row.cost_micros,
      cell: (row) => (row.cost_micros > 0 ? f.money(row.cost_cents) : <span className="cp-note">none</span>),
    },
  ], [f]);

  const table = (
    title: string,
    description: string,
    rows: AiUsageBucket[],
    first: DataTableColumn<AiUsageBucket>,
  ) => (
    <Card title={title} description={description} padding="tight">
      <DataTable<AiUsageBucket>
        rows={rows}
        columns={[{ ...first, width: 260, pinned: true }, ...bucketColumns]}
        getRowId={(row) => row.key}
        caption={title}
        stickyFooter
        searchable={false}
        showColumnToggle={false}
        showFilters={false}
        showDensityToggle={false}
        initialSort={{ columnId: 'credits', direction: 'desc' }}
        empty={<EmptyState size="sm" inline illustration={null} title="Nothing ran in this window" body="Pick a longer window, or ask the copilot something." />}
      />
    </Card>
  );

  const days = report ? everyDay(report.period, report.by_day) : [];
  const busiest = report ? [...report.by_day].sort((a, b) => b.credits - a.credits)[0] : undefined;

  return (
    <div className="cp-usage" data-usage-days={window}>
      <div className="pl-toolbar">
        <Select
          value={String(window)}
          onChange={(next) => setQuery({ days: next === '30' ? undefined : next })}
          size="sm"
          aria-label="Usage window"
          icon={<Icons.calendar size={13} />}
          options={USAGE_WINDOWS}
        />
        {report && (
          <span className="cp-note">
            {f.dateRange(dayStart(report.period.since), dayStart(report.period.until), { timeZone: 'UTC' })} · every run the engine logged, whoever asked
          </span>
        )}
      </div>

      {usage.error && (
        <Card>
          <ErrorState
            title="The usage report did not answer"
            message={usage.error.body.message}
            code={`${usage.error.status} /v1/ai/usage`}
            requestId={usage.error.body.request_id ?? null}
            action={<Button variant="primary" iconLeft={<Icons.refresh size={14} />} onClick={usage.refetch}>Try again</Button>}
          />
        </Card>
      )}

      {!usage.error && !report && <SkeletonText lines={8} />}

      {report && (
        <>
          <div className="pl-summary" data-usage-totals>
            <Card padding="tight">
              <Stat label="Runs" value={f.number(report.totals.runs)} icon={<Icons.activity size={15} />} caption={`${f.plural(report.totals.tool_calls, 'tool call')} between them`} />
            </Card>
            <Card padding="tight">
              <Stat label="Credits charged" value={f.number(report.totals.credits)} icon={<Icons.coins size={15} />} caption={report.totals.runs ? `${f.number(Math.round(report.totals.credits / report.totals.runs))} per run` : 'No runs in this window'} />
            </Card>
            <Card padding="tight">
              <Stat label="Tokens" value={f.compact(report.totals.input_tokens + report.totals.output_tokens)} icon={<Icons.cpu size={15} />} caption={`${f.compact(report.totals.input_tokens)} in · ${f.compact(report.totals.output_tokens)} out`} />
            </Card>
            <Card padding="tight">
              <Stat
                label="Provider spend"
                value={report.totals.cost_micros > 0 ? f.money(report.totals.cost_cents) : f.money(0)}
                icon={<Icons.wallet size={15} />}
                caption={report.totals.cost_micros > 0 ? 'What the hosted model cost us' : 'Answered in-house — no provider spend'}
              />
            </Card>
          </div>

          <Card
            title="Credits by day"
            description={busiest
              ? `One bar per day of the window; the engine ran on ${f.plural(report.by_day.length, 'day')} of ${days.length}, busiest on ${f.date(dayStart(busiest.key), { timeZone: 'UTC' })}`
              : 'One bar per day of the window, in the engine’s own day boundaries'}
            padding="tight"
          >
            {report.by_day.length ? (
              <BarChart
                title="Credits charged by day"
                description={`${f.plural(report.totals.credits, 'credit')} over ${f.plural(report.by_day.length, 'day')} with runs${busiest ? `, the most on ${f.date(dayStart(busiest.key), { timeZone: 'UTC' })}` : ''}`}
                categories={days.map((row) => f.date(dayStart(row.key), { timeZone: 'UTC' }))}
                series={[{ id: 'credits', label: 'Credits', values: days.map((row) => row.credits) }]}
                valueFormat={(value) => f.number(value)}
                integer
                legend={false}
                height={200}
              />
            ) : (
              <EmptyState size="sm" inline illustration={null} title="Nothing ran in this window" body="Pick a longer window, or ask the copilot something." />
            )}
          </Card>

          <div className="cp-usage__tables">
            {table('By feature', 'The copilot, the agents, drafting — whatever opened the run', report.by_feature, {
              id: 'key', header: 'Feature', accessor: (row) => humanize(row.key), cell: (row) => <Badge size="sm" tone="neutral">{humanize(row.key)}</Badge>,
            })}
            {table('By teammate', 'Who asked; agent runs count under System', report.by_user, {
              id: 'key', header: 'Teammate', accessor: (row) => row.name ?? row.key, cell: (row) => row.name ?? row.key,
            })}
            {table('By model', 'The engine that answered', report.by_model, {
              id: 'key', header: 'Model', accessor: (row) => row.key, cell: (row) => <span className="cp-mono">{row.key}</span>,
            })}
          </div>
        </>
      )}
    </div>
  );
}

/* --------------------------------- tools ---------------------------------- */

/**
 * The catalogue the subtitle counts.
 *
 * "51 tools" was a number and nothing else. Each tool here says what it reads
 * or writes, in the words the engine itself is given, and whether a person
 * stands between it and the workspace.
 */
function ToolsPanel() {
  const f = useFormat();
  const tools = useTools();
  const [query, setQuery] = useState('');
  const rows = useMemo(() => filterTools(tools.data?.data ?? [], query), [tools.data, query]);
  const reads = rows.filter((tool) => tool.read_only).length;
  const writes = rows.length - reads;

  return (
    <Card
      title={tools.data ? `${f.plural(tools.data.data.length, 'tool')}` : 'Tools'}
      description={tools.data ? `${f.plural(reads, 'read')} the workspace; ${f.plural(writes, 'write')} to it, each stopping for a person's approval` : 'Reading the catalogue…'}
      actions={
        <SearchInput
          value={query}
          onChange={setQuery}
          size="sm"
          placeholder="Filter the tools"
          aria-label="Filter the tools"
        />
      }
    >
      {tools.error && (
        <ErrorState
          title="The tool catalogue did not answer"
          message={tools.error.body.message}
          code={`${tools.error.status} /v1/ai/tools`}
          requestId={tools.error.body.request_id ?? null}
          action={<Button variant="primary" iconLeft={<Icons.refresh size={14} />} onClick={tools.refetch}>Try again</Button>}
        />
      )}
      {!tools.error && tools.loading && <SkeletonText lines={8} />}
      {tools.data && rows.length === 0 && (
        <EmptyState
          size="sm"
          inline
          illustration={null}
          title="No tool matches"
          body={`None of the ${tools.data.data.length} tools mention “${query}”.`}
          action={<Button size="sm" onClick={() => setQuery('')}>Clear the filter</Button>}
        />
      )}
      {tools.data && rows.length > 0 && (
        <div className="cp-tools" data-tools={rows.length}>
          {rows.map((tool) => (
            <div className="cp-tool" key={tool.name} data-tool={tool.name}>
              <span>
                <span className="cp-tool__name">{humanTool(tool.name)}</span>
                <span className="cp-tool__wire">{tool.name}</span>
              </span>
              <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
                {tool.read_only
                  ? <Badge size="sm" tone="info" icon={<Icons.search size={11} />}>Reads</Badge>
                  : <Badge size="sm" tone="warning" icon={<Icons.shield size={11} />}>Writes · needs approval</Badge>}
              </span>
              <ToolWords tool={tool} />
              {tool.tags.length > 0 && (
                <span className="cp-tool__tags">
                  {tool.tags.map((tag) => <Badge key={tag} size="sm" tone="neutral">{tagLabel(tag)}</Badge>)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * What a tool does, for a person, with what the engine is told kept underneath.
 *
 * The catalogue printed the prompt text — "Pass a company id, or a contact id
 * to get the company behind it" — to whoever opened the tab. The first
 * sentence is the summary; the rest is how the model is told to call it, and
 * it is one disclosure away for anyone debugging a plan.
 */
function ToolWords({ tool }: { tool: { name: string; description: string; read_only: boolean; tags: string[] } }) {
  const { summary, guidance } = toolSummary(tool);
  return (
    <>
      <p className="cp-tool__desc">{summary}</p>
      {guidance && (
        <details className="cp-details cp-tool__guidance">
          <summary>How the engine is told to use it</summary>
          <p className="cp-tool__prompt">{guidance}</p>
        </details>
      )}
    </>
  );
}

/* ------------------------------- run detail ------------------------------- */

export function RunDetailPage({ id }: { id: string }) {
  const f = useFormat();
  const { navigate } = useRouter();
  const run = useRun(id);
  const vocabulary = useVocabulary();
  const templates = useTemplates();
  const ai = useAiStatus();
  const [showAnswer, setShowAnswer] = useState(true);

  if (run.error) {
    return (
      <Page title="Run" subtitle={id}>
        <Card>
          <ErrorState
            title={run.error.status === 404 ? 'No such run' : 'This run could not be read'}
            message={run.error.body.message}
            code={`${run.error.status} /v1/ai/runs/${id}`}
            requestId={run.error.body.request_id ?? null}
            action={<Button variant="primary" onClick={run.refetch}>Try again</Button>}
            secondaryAction={<Button onClick={() => navigate('/copilot/runs')}>Back to the run log</Button>}
          />
        </Card>
      </Page>
    );
  }

  if (!run.data) {
    return (
      <Page title="Run" subtitle="Loading the trace…">
        <SkeletonText lines={10} />
      </Page>
    );
  }

  const detail: RunDetail = run.data;
  const outcome = runOutcome(detail, detail.approvals);
  // The header and the panel below it are counting the same array. They used to
  // read `span_count`, which is stamped when the run finishes and never sees the
  // step a post-approval execution appends.
  const steps = detail.trace.length;

  /**
   * What the run's own page says about the answer — from the trace rather than
   * the message. The spans carry the arguments each tool really ran with, so
   * the slot chips here are first-hand; the engine and the nearest shapes are
   * read off the run.
   */
  const card = answerCard({
    question: detail.question,
    content: detail.answer ?? undefined,
    toolCalls: detail.trace.filter((span) => span.kind === 'tool').map((span) => ({ name: span.name, arguments: span.args })),
    run: detail,
    remembered: null,
    templates: templates.data?.data ?? [],
    hosted: ai.data ? ai.data.provider.hosted : true,
    vocab: vocabulary.vocab,
    format: {
      window: (w) => windowText(w, {
        dateRange: (start, end) => f.dateRange(start, end, { timeZone: 'UTC' }),
        date: (ts) => f.date(ts, { timeZone: 'UTC' }),
      }),
      name: (recordId) => detail.citations.find((c) => c.id === recordId)?.label
        ?? vocabulary.vocab.people.find((person) => person.id === recordId)?.name
        ?? recordId,
    },
  });
  const askAgain = (next: string) => navigate(`/copilot?new=1&ask=${encodeURIComponent(next)}`);
  const currency = currencyRefusal(detail.question, card.refusal, card.refusedCurrency);

  return (
    <Page
      width="wide"
      eyebrow={`${humanize(detail.feature)} run`}
      title={detail.question || 'Untitled run'}
      badge={<Badge size="sm" tone={OUTCOME_TONE[outcome]}>{OUTCOME_LABEL[outcome]}</Badge>}
      subtitle={`${f.dateTime(detail.started)} · ${detail.model} · ${f.plural(steps, 'step')} · ${f.number(detail.duration_ms)} ms`}
      actions={
        <>
          {detail.question && (
            <Button
              iconLeft={<Icons.refresh size={14} />}
              // Not a replay: the engine reads the workspace as it is now, so
              // this starts a new run whose trace can be put beside this one.
              title="Put the same question to the engine again, against today’s data"
              onClick={() => navigate(`/copilot?new=1&ask=${encodeURIComponent(detail.question)}`)}
            >
              Ask it again
            </Button>
          )}
          {detail.thread_id && (
            <Button
              iconLeft={<MessageSquareIcon size={14} />}
              onClick={() => navigate(`/copilot?thread=${detail.thread_id}`)}
            >
              Open the conversation
            </Button>
          )}
          <Button variant="secondary" iconLeft={<Icons.activity size={14} />} onClick={() => navigate('/copilot/runs')}>
            All runs
          </Button>
        </>
      }
    >
      {card.refusal && (
        <Banner
          tone="warning"
          bar
          title={currency ? currencyRefusalTitle(currency) : 'This run refused to answer'}
        >
          {/* The engine's reason, except when the reason is the currency claim
              its own unscoped answers contradict: that one is not restated
              here as this page's sentence either. The wire text is still in
              "Exactly what was returned to the caller", verbatim and labelled
              as the caller's copy. */}
          {currency
            ? <CurrencyRefusalNote refusal={currency} onAsk={askAgain} />
            : card.refusal.message && <p>{card.refusal.message}</p>}
          <RefusalHelp refusal={card.refusal} onAsk={askAgain} />
        </Banner>
      )}
      {detail.status === 'failed' && detail.error && (
        <Banner tone="danger" title="This run failed" bar>{detail.error}</Banner>
      )}

      <Card title="What it cost and how it ended">
        <RunFacts run={detail} toolMs={detail.timings.tool_ms} approvals={detail.approvals} steps={steps} />
      </Card>


      <Card
        title="Answer"
        description={detail.approvals.some((a) => a.status !== 'pending')
          ? 'Exactly what was returned to the caller when the run stopped — what happened after the decision is below'
          : 'Exactly what was returned to the caller'}
        actions={
          <Button size="sm" variant="ghost" onClick={() => setShowAnswer((value) => !value)} aria-expanded={showAnswer}>
            {showAnswer ? 'Hide' : 'Show'}
          </Button>
        }
      >
        <div className="cp-answer__head" style={{ marginBottom: 'var(--space-4)' }}>
          <EngineIndicator line={card.indicator} />
        </div>
        {card.carried && <CarriedMeasure carried={card.carried} />}
        <SlotChips slots={card.slots} />
        {showAnswer && (
          detail.answer
            ? <pre className="cp-code" style={{ whiteSpace: 'pre-wrap' }}>{detail.answer}</pre>
            : <EmptyState size="sm" inline illustration={null} title="No answer was produced" body="The run ended before anything was composed." />
        )}
        <div style={{ marginTop: 'var(--space-5)' }}>
          <CitationChips citations={detail.citations} label="Grounded in" />
        </div>
      </Card>


      <Card
        title="Trace"
        description={`${f.plural(steps, 'step')} · ${f.number(detail.timings.tool_ms)} ms of it inside tools · in the order they ran`}
      >
        <TraceSteps spans={detail.trace} decidedAfter={detail.finished} />
      </Card>

      {detail.approvals.length > 0 && (
        <>
              <Card title="Writes this run prepared" description="Each one had to be approved by a person before it could run">
            <ApprovalQueue approvals={detail.approvals} question={detail.question} onDecided={run.refetch} />
          </Card>
        </>
      )}


      <Card title="Working notes" description="The engine's own reasoning trail, in order">
        <ReasoningList lines={detail.reasoning} />
      </Card>
    </Page>
  );
}
