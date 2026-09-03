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
  AlertTriangleIcon, Badge, Banner, Button, Card, DataTable, EmptyState, ErrorState, Icons,
  MessageSquareIcon, Page, SegmentedControl, Select, SkeletonText, Stat, humanize, useFormat,
  useToast,
  type DataTableColumn, type SelectOption,
} from '@/client/design';
import {
  OUTCOME_LABEL, OUTCOME_TONE, answerCard, runOutcome, useAiStatus, useAllApprovals, useApprovals,
  useFeatureCatalogue, useRun, useTemplates, useVocabulary, windowText,
  type AiRun, type RunDetail, type RunOutcome,
} from './api';
import { ApprovalQueue, CitationChips, ReasoningList, RunFacts, TraceSteps } from './trace';
import { EngineIndicator, RefusalHelp, SlotChips } from './card';

/** How many runs one read of the log brings back, and how far each “show more” goes. */
const PAGE = 100;

/* ------------------------------- run list --------------------------------- */

export function RunsPage() {
  const f = useFormat();
  const toast = useToast();
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
          ? `${f.plural(totals.count, 'run')} · ${f.number(totals.tokens)} tokens · ${f.plural(totals.credits, 'credit')}${totals.refused ? ` · ${totals.refused} refused` : ''}${totals.failed ? ` · ${totals.failed} failed` : ''}`
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
        <Banner tone="warning" title="This run refused to answer" bar>
          {card.refusal.message && (
            <p>{card.refusal.message} <span className="cp-mono">({card.refusal.code})</span></p>
          )}
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
          <EngineIndicator line={card.indicator} onOpen={navigate} />
        </div>
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
