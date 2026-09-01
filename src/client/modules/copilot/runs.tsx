/**
 * Agent observability.
 *
 * Every run the platform has made — copilot questions, agent work, approvals —
 * with what it was asked, what it decided, which tools it called with which
 * arguments, how long each took, what it cost in tokens and credits, and how it
 * ended. HubSpot will tell you Breeze did something; this says why.
 */
import { useCallback, useMemo, useState } from 'react';
import { useQuery, type ListEnvelope } from '@/client/kernel/api';
import { useRouter } from '@/client/kernel/router';
import {
  AlertTriangleIcon, Badge, Banner, Button, Card, DataTable, EmptyState, ErrorState, Icons,
  MessageSquareIcon, Page, SegmentedControl, Select, SkeletonText, Stat, humanize, useFormat,
  type DataTableColumn, type SelectOption,
} from '@/client/design';
import {
  OUTCOME_LABEL, OUTCOME_TONE, refusalOf, runOutcome, useAllApprovals, useApprovals, useRun,
  type AiRun, type RunDetail, type RunOutcome,
} from './api';
import { ApprovalQueue, CitationChips, ReasoningList, RunFacts, TraceSteps } from './trace';

/* ------------------------------- run list --------------------------------- */

export function RunsPage() {
  const f = useFormat();
  const { location, navigate, setQuery } = useRouter();
  const status = location.query.status ?? '';
  const feature = location.query.feature ?? '';
  const tab = location.query.tab === 'approvals' ? 'approvals' : 'runs';

  // The outcome filter is applied here rather than by the server, because the
  // server's `needs_approval` never resolves once a person decides: a run whose
  // write was declined would sit in that filter for ever. The approvals say what
  // really happened, so the filter is computed from the same answer the column
  // shows.
  const runs = useQuery<ListEnvelope<AiRun>>('/v1/ai/runs', {
    limit: 100,
    ...(feature ? { feature } : {}),
  });
  const decisions = useAllApprovals();
  const approvals = useApprovals(location.query.approvals ?? 'pending');

  const outcomeOf = useCallback(
    (run: AiRun): RunOutcome => runOutcome(run, decisions.byRun.get(run.id)),
    [decisions],
  );

  const rows = useMemo(
    () => (runs.data?.data ?? []).filter((run) => !status || outcomeOf(run) === status),
    [runs.data, status, outcomeOf],
  );

  const features = useMemo(
    () => [...new Set(rows.map((run) => run.feature))].sort(),
    [rows],
  );

  const totals = useMemo(() => {
    let credits = 0;
    let tokens = 0;
    let ms = 0;
    let failed = 0;
    for (const run of rows) {
      credits += run.usage.credits;
      tokens += run.usage.input_tokens + run.usage.output_tokens;
      ms += run.duration_ms;
      if (run.status === 'failed') failed += 1;
    }
    return { credits, tokens, ms, failed, count: rows.length };
  }, [rows]);

  const columns = useMemo<DataTableColumn<AiRun>[]>(() => [
    {
      id: 'started',
      header: 'When',
      width: 130,
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
    {
      id: 'feature',
      header: 'Feature',
      filter: 'set',
      accessor: (row) => row.feature,
      cell: (row) => <Badge size="sm" tone="neutral">{humanize(row.feature)}</Badge>,
    },
    {
      id: 'status',
      header: 'Outcome',
      width: 180,
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
      filter: 'set',
      accessor: (row) => (row.intent ? humanize(row.intent) : '—'),
    },
    {
      id: 'confidence',
      header: 'Confidence',
      width: 118,
      align: 'right',
      sortable: true,
      accessor: (row) => row.confidence ?? 0,
      cell: (row) => (row.confidence === null ? <span className="cp-note">—</span> : `${Math.round(row.confidence * 100)}%`),
    },
    {
      id: 'steps',
      header: 'Steps',
      align: 'right',
      sortable: true,
      accessor: (row) => row.span_count,
    },
    {
      id: 'duration',
      header: 'Duration',
      align: 'right',
      sortable: true,
      accessor: (row) => row.duration_ms,
      cell: (row) => `${f.number(row.duration_ms)} ms`,
    },
    {
      id: 'tokens',
      header: 'Tokens',
      align: 'right',
      sortable: true,
      accessor: (row) => row.usage.input_tokens + row.usage.output_tokens,
      cell: (row) => f.number(row.usage.input_tokens + row.usage.output_tokens),
      total: (_rows, sum) => f.number(sum),
    },
    {
      id: 'credits',
      header: 'Credits',
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
      title="Runs and traces"
      width="wide"
      subtitle={
        runs.data
          ? `${f.plural(totals.count, 'run')} · ${f.number(totals.tokens)} tokens · ${f.plural(totals.credits, 'credit')}${totals.failed ? ` · ${totals.failed} failed` : ''}`
          : 'Every question the engine has been asked, and what it did about it'
      }
      actions={
        <>
          <SegmentedControl
            value={tab}
            onChange={(next) => setQuery({ tab: next === 'runs' ? undefined : next })}
            aria-label="Runs or approvals"
            options={[
              { value: 'runs', label: 'Runs', icon: <Icons.activity size={14} /> },
              { value: 'approvals', label: 'Approvals', icon: <Icons.shield size={14} /> },
            ]}
          />
          <Button variant="primary" iconLeft={<Icons.sparkles size={14} />} onClick={() => navigate('/copilot')}>
            Open the copilot
          </Button>
        </>
      }
    >
      {tab === 'approvals' ? (
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
            <ApprovalQueue approvals={approvals.data.data} onDecided={approvals.refetch} />
          )}
        </Card>
      ) : (
        <>
          <div className="pl-summary">
            <Card padding="tight">
              <Stat label="Runs in view" value={f.number(totals.count)} icon={<Icons.activity size={15} />} caption={status ? `Filtered to ${humanize(status)}` : 'Newest first, up to 100'} />
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
                { value: 'declined', label: 'Declined' },
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

/* ------------------------------- run detail ------------------------------- */

export function RunDetailPage({ id }: { id: string }) {
  const f = useFormat();
  const { navigate } = useRouter();
  const run = useRun(id);
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
  const refusal = refusalOf(detail);
  const outcome = runOutcome(detail, detail.approvals);
  // The header and the panel below it are counting the same array. They used to
  // read `span_count`, which is stamped when the run finishes and never sees the
  // step a post-approval execution appends.
  const steps = detail.trace.length;

  return (
    <Page
      width="wide"
      eyebrow={`${humanize(detail.feature)} run`}
      title={detail.question || 'Untitled run'}
      badge={<Badge size="sm" tone={OUTCOME_TONE[outcome]}>{OUTCOME_LABEL[outcome]}</Badge>}
      subtitle={`${f.dateTime(detail.started)} · ${detail.model} · ${f.plural(steps, 'step')} · ${f.number(detail.duration_ms)} ms`}
      actions={
        <>
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
      {refusal && (
        <Banner tone="warning" title="This run refused to answer" bar>
          {refusal.message} <span className="cp-mono">({refusal.code})</span>
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
            <ApprovalQueue approvals={detail.approvals} onDecided={run.refetch} />
          </Card>
        </>
      )}


      <Card title="Working notes" description="The engine's own reasoning trail, in order">
        <ReasoningList lines={detail.reasoning} />
      </Card>
    </Page>
  );
}
