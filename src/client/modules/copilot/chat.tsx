/**
 * The copilot.
 *
 * A chat over the workspace's own records, with three things a chat box on its
 * own does not give you: every claim carries the records it was read from, every
 * step the engine took is inspectable down to the arguments it passed, and a
 * write stops at an approval card that shows exactly what it would do.
 *
 * When the engine refuses — an unparseable period, a record it could not resolve
 * — the refusal is rendered as a refusal. A low-confidence answer is labelled
 * as one. Neither is dressed up.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, invalidate, useMutation, useQuery, type ApiClientError, type ListEnvelope } from '@/client/kernel/api';
import { useRouter } from '@/client/kernel/router';
import { useSession } from '@/client/kernel/session';
import {
  Badge, Banner, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Icons, Input, MenuButton,
  MessageSquareIcon, Modal, Page, SearchInput, Select, Skeleton, SkeletonText, Switch, Textarea,
  humanize, useFormat, useHotkey, usePrefersReducedMotion, useToast, type MenuSection, type SelectOption,
} from '@/client/design';
import {
  boardHref, carriedScope, carriedThrough, contradictsCarried, correctedProse, decidedBadge,
  dealNamedIn, dedupeCitations, deniedPipeline, editHref, metricsMeasured, misreadRefusal,
  noWritePrepared,
  parseBlocks, parseBreakdown, propertyAsked,
  reconcileBreakdown, reconcileScope, refusalDisprovedByThread,
  refusalOf, rephraseAsBreakdown, splitToolEcho, useAiStatus, useAllApprovals, useSuggestions,
  withoutRefusedQualifier,
  useThread, useThreads,
  useTools, useRun, useVocabulary, withoutBreakdown,
  type AiApproval, type AiMessage, type AiReply, type AiRun, type AiThread,
  type ThreadDetail,
  type StepNote, type ToolEcho, type Vocabulary,
} from './api';
import {
  ApprovalCard, ApprovalResolution, CitationChips, ConfidenceBadge, ReasoningList, TraceSteps,
} from './trace';
import { BoardLink, BreakdownPanel, RephraseLink, ScopeBar, ScopeWarning } from './scope';
import { DraftDialog } from './draft';

/* ------------------------------- typewriter ------------------------------- */

/**
 * The answer arrives in one response, so there is nothing to stream — but a
 * paragraph that snaps into place reads as a canned string, and one that fills
 * in reads as an answer being written. Only the newest message does this, and
 * a reader who has asked for less motion gets the whole thing at once.
 */
function useReveal(text: string, active: boolean): { shown: string; done: boolean } {
  const reduced = usePrefersReducedMotion();
  const [count, setCount] = useState(active && !reduced ? 0 : text.length);
  useEffect(() => {
    if (!active || reduced) { setCount(text.length); return; }
    setCount(0);
    let index = 0;
    const step = Math.max(2, Math.ceil(text.length / 90));
    const timer = setInterval(() => {
      index += step;
      if (index >= text.length) { setCount(text.length); clearInterval(timer); }
      else setCount(index);
    }, 16);
    return () => clearInterval(timer);
  }, [text, active, reduced]);
  return { shown: text.slice(0, count), done: count >= text.length };
}

/* -------------------------------- messages -------------------------------- */

function AnswerBody({ content, revealing }: { content: string; revealing: boolean }) {
  const blocks = parseBlocks(content);
  return (
    <div className="cp-answer__body">
      {blocks.map((block, i) => (
        block.kind === 'list'
          ? <ul key={i}>{block.lines.map((line, j) => <li key={j}>{line}</li>)}</ul>
          : (
            <p key={i}>
              {block.lines.join('\n')}
              {revealing && i === blocks.length - 1 && <span className="cp-answer__caret" />}
            </p>
          )
      ))}
      {blocks.length === 0 && revealing && <p><span className="cp-answer__caret" /></p>}
    </div>
  );
}

/**
 * What a tool reported that the answer did not spend, under the answer.
 *
 * Collapsed, named for what it is, and with the engine's internal identifiers
 * written out — a list reading "New business / expansion / renewal" is three
 * pipelines, two of them printed as database values, and it belongs beside the
 * answer rather than inside it.
 */
function ToolEchoes({ echoes, notes }: { echoes: ToolEcho[]; notes: StepNote[] }) {
  if (!echoes.length && !notes.length) return null;
  const total = echoes.reduce((n, echo) => n + echo.items.length, 0) + notes.length;
  return (
    <details className="cp-details cp-echo">
      <summary>
        {total === 1 ? 'One more thing a tool returned' : `${total} more things the tools returned`}
        {' — not used in the answer'}
      </summary>
      <div className="cp-echo__body">
        {echoes.map((echo) => (
          <div key={echo.tool}>
            <p className="cp-note">
              <span className="cp-mono">{echo.tool}</span> also returned:
            </p>
            <ul>
              {echo.items.map((item) => <li key={item}>{humanize(item)}</li>)}
            </ul>
          </div>
        ))}
        {notes.map((note) => (
          <p className="cp-note" key={note.step}>
            Nothing in the answer came from the <strong>{note.step}</strong> step.
            What it returned is in the steps below.
          </p>
        ))}
      </div>
    </details>
  );
}

/** The steps behind one answer, fetched only when a person asks to see them. */
function TracePanel({ runId }: { runId: string }) {
  const run = useRun(runId);
  if (run.error) {
    return (
      <ErrorState
        title="The trace did not answer"
        message={run.error.body.message}
        code={`${run.error.status} /v1/ai/runs/${runId}`}
        requestId={run.error.body.request_id ?? null}
        action={<Button size="sm" variant="primary" onClick={run.refetch}>Try again</Button>}
      />
    );
  }
  if (!run.data) return <SkeletonText lines={4} />;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <TraceSteps spans={run.data.trace} decidedAfter={run.data.finished} />
      <details className="cp-details">
        <summary>The engine’s working notes ({run.data.reasoning.length})</summary>
        <div style={{ marginTop: 'var(--space-4)' }}>
          <ReasoningList lines={run.data.reasoning} />
        </div>
      </details>
    </div>
  );
}

function AssistantMessage({
  message, run, approvals, newest, question, suggested, priors, vocab, vocabUnread, vocabPartial, vocabLoading,
  onDecided,
  onOpenRun,
  onAsk, onAskFresh, onOpenRecords,
}: {
  message: AiMessage;
  run: AiRun | undefined;
  approvals: AiApproval[];
  newest: boolean;
  /** The question this answer answers, as the run recorded it. */
  question: string;
  /** True when this workspace offered the question as a starter prompt. */
  suggested: boolean;
  /** What earlier turns in this thread measured, so a refusal can be held to them. */
  priors: { question: string; metrics: string[] }[];
  vocab: Vocabulary;
  /** True when the pipelines, teammates or metrics could not be read. */
  vocabUnread: boolean;
  /** Parts of the vocabulary that failed, so the dimensions they carry are unchecked. */
  vocabPartial: string[];
  /** True while they are still being read, so nothing is named yet. */
  vocabLoading: boolean;
  onDecided: () => void;
  onOpenRun: (id: string) => void;
  /** Puts a suggested rephrasing back into the thread as the next question. */
  onAsk: (question: string) => void;
  /** Asks the same question in a new conversation, so nothing is carried into it. */
  onAskFresh: (question: string) => void;
  /** Opens a screen this answer pointed at but could not measure over. */
  onOpenRecords: (href: string) => void;
}) {
  const f = useFormat();
  const [showTrace, setShowTrace] = useState(false);
  // The tool echo is not prose and is not typed out as prose: the answer is
  // what gets revealed, and what the tools returned beyond it sits under it.
  const { prose, echoes, notes } = useMemo(() => splitToolEcho(message.content), [message.content]);
  const refusal = refusalOf(run);
  const lowConfidence = !!run && run.confidence !== null && run.confidence < 0.55 && !refusal;

  // Deduped by record id: the engine cites the row it read, and a ticket read
  // twice — once for the count and once for the oldest — was listed twice in
  // SOURCES, which reads as two tickets.
  const citations = useMemo(
    () => dedupeCitations(message.citations.length ? message.citations : run?.citations ?? []),
    [message.citations, run?.citations],
  );

  /**
   * What this answer was measured over, against what the question asked for.
   *
   * Everything it reads was published by the engine with the answer — the
   * arguments of each tool call, the figures the reasoning trail says those
   * calls returned, and the question itself — so no extra request is made per
   * message and nothing is inferred about a number.
   */
  const scope = useMemo(() => reconcileScope({
    question,
    prose,
    toolCalls: message.tool_calls ?? [],
    reasoning: run?.reasoning ?? [],
    vocab,
    resolveId: (id) => citations.find((c) => c.id === id)?.label
      ?? vocab.people.find((person) => person.id === id)?.name
      ?? null,
  }), [question, prose, message.tool_calls, run?.reasoning, vocab, citations]);

  // Terms the engine itself recorded as read-and-dropped, kept only where this
  // workspace knows them as a stage or a teammate — the rest of that list is
  // filler like "worth" and "own". A run whose qualifier ledger already accounts
  // for that dimension has said something more precise, so this stays quiet.
  const carried = useMemo(
    () => carriedThrough(run?.reasoning ?? [], vocab)
      .filter((term) => !scope.verdicts.some((verdict) => verdict.kind === term.kind)),
    [run?.reasoning, vocab, scope.verdicts],
  );

  // Where the same question can be answered when this one could not be: the
  // board narrows by pipeline and by owner, and draws the per-stage medians and
  // the column totals the engine refuses or widens.
  const board = useMemo(() => boardHref(question, vocab), [question, vocab]);

  // The phrasing of the same question this engine does answer. Only offered on
  // a refusal: a question that was answered does not need rewording.
  const rephrase = useMemo(() => rephraseAsBreakdown(question, vocab), [question, vocab]);

  /**
   * The same question without the qualifier the engine could not bind.
   *
   * "Which support tickets need attention today?" is one of this product's own
   * five starter prompts and this engine refuses it on the word "today". The
   * same sentence without it answers with all seven tickets.
   */
  const dropped = useMemo(() => withoutRefusedQualifier(question, refusal), [question, refusal]);

  // A pipeline the answer says this workspace does not have, that it does.
  const denied = useMemo(() => deniedPipeline(prose, vocab), [prose, vocab]);

  // A refusal whose stated reason this workspace's own catalogue disproves:
  // "open pipeline" refused as an unbindable *status*, one line under a chip
  // offering the rephrasing that answers it perfectly.
  const misread = useMemo(() => misreadRefusal(refusal, vocab), [refusal, vocab]);

  // And the other disproof, which is stronger because the reader watched it
  // happen: this same conversation already measured the thing the refusal says
  // it cannot bind. "Break open pipeline down by owner." is refused for the
  // word "break", two turns after open pipeline was computed and ranked.
  const disproved = useMemo(
    () => refusalDisprovedByThread(refusal, question, vocab, priors),
    [refusal, question, vocab, priors],
  );

  /**
   * The scope this turn inherited from an earlier one.
   *
   * The engine writes it in its own notes and then answers "What is our open
   * pipeline?" with one carried-over contact's single deal. The chip states it
   * where the reader is looking, and takes it off in one press by asking the
   * same question in a conversation with no history to inherit.
   */
  const inherited = useMemo(() => carriedScope(run), [run]);
  const inheritedContradicted = inherited ? contradictsCarried(question, inherited) : false;

  // A request to set a property the engine's write extractor cannot read. The
  // deal is found on the account it did cite, so the dead end becomes a link
  // to the screen where the property is editable.
  const noWrite = useMemo(() => noWritePrepared(run), [run]);
  const wanted = noWrite ? propertyAsked(question) : null;
  const account = wanted ? citations.find((c) => c.type === 'company' || c.type === 'customer_company') : undefined;
  const accountDeals = useQuery<ListEnvelope<{ id: string; display_name: string }>>(
    account ? '/v1/records/deal' : null,
    account ? { q: account.label, limit: 25 } : undefined,
  );
  const settable = wanted && accountDeals.data
    ? dealNamedIn(question, accountDeals.data.data)
    : null;

  /**
   * The engine's own sentences, with the ones this card disproves corrected.
   *
   * Only three: a currency claim over a figure printed in another book, a
   * denial that a pipeline exists beside the pipeline, and a refusal that asks
   * a sales lead to send an API parameter. Each was previously rebutted in a
   * banner above and left standing underneath, which leaves the reader holding
   * a claim and its refutation with no way to tell which to trust.
   */
  const corrected = useMemo(
    () => correctedProse(prose, { verdicts: scope.verdicts, denied, vocab }),
    [prose, scope.verdicts, denied, vocab],
  );

  const breakdown = useMemo(() => {
    const parsed = parseBreakdown(prose);
    if (!parsed) return null;
    const pipeline = scope.answering[0]?.scope.pipeline ?? null;
    return { report: reconcileBreakdown(parsed.buckets, vocab, pipeline), pipeline };
  }, [prose, vocab, scope.answering]);

  // The breakdown sentence is lifted out of the prose so it can be reconciled
  // against the board rather than read as a settled list of stage figures.
  const body = breakdown ? withoutBreakdown(corrected) : corrected;
  /**
   * An answer with a filter nobody asked for in it is not shown as an answer.
   *
   * "How many deals did we close in Q2 2026?" is planned over the eight *open*
   * stages and answers "0". The banner above says so; a reader who has read the
   * 0 has already taken the 0, which is why the prose goes behind a disclosure
   * that names what it actually measured rather than sitting in the answer slot.
   */
  const quarantined = scope.invented.length > 0 && scope.answering.length > 0;
  const { shown, done } = useReveal(body, newest && !quarantined);

  // The prose was composed when the engine stopped: it says "Nothing has been
  // written" and always will. Once a decision has been made it is history, not
  // the current state of the workspace, and the turn has to say so.
  const waiting = approvals.filter((approval) => approval.status === 'pending');
  const decided = approvals.filter((approval) => approval.status !== 'pending');
  const superseded = decided.length > 0 && waiting.length === 0;

  return (
    <div className="cp-msg cp-msg--assistant">
      <div className={`cp-answer${scope.unscoped.length ? ' is-unscoped' : ''}`}>
        <div className="cp-answer__head">
          <Badge tone="brand" size="sm" icon={<Icons.sparkles size={11} />}>
            {run ? run.model : 'Copilot'}
          </Badge>
          {run && <ConfidenceBadge run={run} refused={!!refusal} unbound={scope.unscoped.length} />}
          {(waiting.length > 0 || (run?.status === 'needs_approval' && approvals.length === 0))
            && <Badge tone="warning" size="sm">waiting for approval</Badge>}
          {superseded && (
            <Badge tone={decidedBadge(decided).tone} size="sm">{decidedBadge(decided).label}</Badge>
          )}
          {run?.status === 'failed' && <Badge tone="danger" size="sm">failed</Badge>}
          <span>{f.relative(message.created)}</span>
          {run && (
            <>
              <span>·</span>
              <span>{f.number(run.duration_ms)} ms</span>
              <span>·</span>
              <span>{f.plural(run.usage.credits, 'credit')}</span>
            </>
          )}
        </div>

        {refusal && misread && (
          <Banner tone="danger" bar title={`The reason given for refusing this is not true of this workspace`}>
            <p>
              It says it could not bind <strong>“{misread.text}”</strong> as a {misread.kind}. “{misread.text}” is
              not a {misread.kind} here — it is <strong>{misread.metric.label}</strong>, a measure this workspace
              publishes and computes constantly. The ranking you asked for is one rephrasing away.
            </p>
            {rephrase && <RephraseLink question={rephrase} onAsk={onAsk} />}
            {board && <BoardLink board={board} />}
          </Banner>
        )}

        {refusal && !misread && disproved && (
          <Banner tone="danger" bar title="This conversation has already answered that">
            <p>
              It says it cannot bind what you asked for. <strong>{disproved.measure.label}</strong> is a
              measure this workspace publishes, and this thread computed it{' '}
              {priors.length === 1 ? 'one question ago' : 'earlier'} — for “{disproved.question}”. The
              refusal below is about the wording, not about the measure.
            </p>
            <p className="cp-note" style={{ marginTop: 'var(--space-3)' }}>
              {refusal.message} <span className="cp-mono">({refusal.code})</span>
            </p>
            {rephrase && <RephraseLink question={rephrase} onAsk={onAsk} />}
            {dropped && <RephraseLink question={dropped} onAsk={onAsk} />}
            {board && <BoardLink board={board} />}
          </Banner>
        )}

        {refusal && !misread && !disproved && (
          <Banner
            tone={suggested ? 'danger' : 'warning'}
            bar
            title={suggested
              ? 'This was one of the suggested questions, and it did not answer'
              : 'The engine refused to answer this one'}
          >
            {suggested && (
              <p>
                A prompt this workspace offered you is a promise. This one was refused
                {dropped ? ', and the same question without the part it could not place answers it:' : '.'}
              </p>
            )}
            <p className={suggested ? 'cp-note' : undefined} style={suggested ? { marginTop: 'var(--space-3)' } : undefined}>
              {refusal.message} <span className="cp-mono">({refusal.code})</span>
            </p>
            {dropped && <RephraseLink question={dropped} onAsk={onAsk} />}
            {rephrase && <RephraseLink question={rephrase} onAsk={onAsk} />}
            {board && <BoardLink board={board} />}
          </Banner>
        )}

        {noWrite && wanted && (
          <Banner tone="warning" bar title={`The copilot cannot set ${wanted.label} on a deal`}>
            <p>
              It reads a stage change and nothing else, so it prepared no write and changed nothing.
              {settable
                ? ' The field is editable on the deal itself:'
                : ' Open the deal and edit it there.'}
            </p>
            {settable && (
              <p className="cp-note" style={{ marginTop: 'var(--space-3)' }}>
                <a
                  className="cp-chip"
                  href={editHref(settable.id, wanted.group)}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    onOpenRecords(editHref(settable.id, wanted.group));
                  }}
                >
                  <Icons.edit size={12} />
                  <span className="u-truncate">Set {wanted.label} on {settable.display_name}</span>
                </a>
              </p>
            )}
          </Banner>
        )}

        {denied && (
          <Banner tone="warning" bar title={`${denied.label} is a ${denied.objectType} pipeline in this workspace`}>
            The engine answered that no pipeline is called “{denied.label}” and listed the deal
            pipelines as though they were all of them. One is — it holds {denied.objectType}s rather
            than deals, which is why the copilot cannot measure pipeline value over it. The answer
            below has been corrected to say so.
            {' '}
            <a
              className="cp-chip"
              href={`/records/${denied.objectType}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onOpenRecords(`/records/${denied.objectType}`);
              }}
            >
              <Icons.tickets size={12} />
              <span className="u-truncate">Open the {denied.objectType}s</span>
            </a>
          </Banner>
        )}

        {inherited?.subject && (
          <div className="cp-carried">
            <span className="cp-carried__label">Carried into this question</span>
            <span className="cp-carried__chip">
              <Icons.link size={11} />
              <span className="u-truncate">{inherited.subject}</span>
              <span className="cp-carried__from">
                {inherited.pinned ? 'this conversation’s record' : 'the question before it'}
              </span>
            </span>
            <button
              type="button"
              className="cp-carried__drop"
              onClick={() => onAskFresh(question)}
              title={`Ask “${question}” in a new conversation, where nothing is carried in`}
            >
              <Icons.x size={11} />
              Ask it without {inherited.subject}
            </button>
          </div>
        )}

        {inheritedContradicted && inherited?.subject && (
          <Banner tone="danger" bar title="This answer is scoped to a record you did not name">
            <p>
              You asked about the whole workspace. The answer below was measured for{' '}
              <strong>{inherited.subject}</strong> alone, carried in from{' '}
              {inherited.pinned ? 'the record this conversation is pinned to' : 'an earlier question'} —
              so the figure is one record’s, not Northwind Robotics’s.
            </p>
          </Banner>
        )}

        {scope.invented.length > 0 && scope.answering.length > 0 && (
          <Banner tone="danger" bar title="This is not an answer to the question you asked">
            <p>
              The query narrowed on something no word of your question named, and then reported the
              figure as the answer:
            </p>
            <ul className="cp-scope__reasons">
              {scope.invented.map((filter) => (
                <li key={`${filter.kind}:${filter.used}`}>
                  It filtered to <strong>{filter.used}</strong> and ANDed that into the query. No word of
                  your question produced that {filter.kind} filter — you asked about{' '}
                  {filter.asked.toLowerCase()}.
                </li>
              ))}
            </ul>
            <p className="cp-note" style={{ marginTop: 'var(--space-3)' }}>
              The figure is held back rather than printed as an answer to a question it did not answer.
            </p>
            {board && <BoardLink board={board} />}
          </Banner>
        )}

        <ScopeWarning
          report={scope}
          board={board}
          rephrase={rephrase && !refusal ? { question: rephrase, onAsk } : null}
        />

        {vocabUnread && scope.answering.length > 0 && (
          <Banner tone="warning" compact title="The scope of this answer was not checked">
            The pipelines, teammates and metric catalogue this workspace defines could not be read, so
            nothing below has been compared against what the question asked for.
          </Banner>
        )}

        {!vocabUnread && vocabPartial.length > 0 && scope.answering.length > 0 && (
          <Banner tone="warning" compact title="Part of this workspace’s vocabulary could not be read">
            {f.list(vocabPartial)} did not answer, so a question naming one of those was not checked
            against it. Everything else below was.
          </Banner>
        )}

        {carried.length > 0 && scope.answering.length > 0 && (
          <Banner tone="warning" title="The engine dropped part of the question" bar>
            It recorded reading {f.list(carried.map((term) => `“${term.label}”`))} in what you asked and then
            answering without {carried.length === 1 ? 'it' : 'them'}. The figure below is not narrowed to{' '}
            {carried.length === 1 ? 'that' : 'those'}.
          </Banner>
        )}

        {lowConfidence && run && (
          <Banner tone="warning" compact>
            Read this one carefully: the engine was only {Math.round((run.confidence ?? 0) * 100)}% sure it read the
            question as {humanize(run.intent ?? 'unknown').toLowerCase()}. Check the steps below before acting on it.
          </Banner>
        )}

        {run?.status === 'failed' && run.error && (
          <Banner tone="danger" title="This run failed">{run.error}</Banner>
        )}

        <ScopeBar report={scope} vocab={vocab} loading={vocabLoading} unread={vocabUnread} />

        {quarantined ? (
          <details className="cp-details cp-quarantine">
            <summary>Show the figure the engine returned, and what it measured instead</summary>
            <div className={superseded ? 'cp-superseded' : undefined}>
              <AnswerBody content={body} revealing={false} />
            </div>
          </details>
        ) : (
          <div className={superseded ? 'cp-superseded' : undefined}>
            <AnswerBody content={shown} revealing={!done} />
          </div>
        )}

        {done && !quarantined && breakdown && <BreakdownPanel report={breakdown.report} pipeline={breakdown.pipeline} />}

        {done && <ToolEchoes echoes={echoes} notes={notes} />}

        <CitationChips citations={citations} />

        {waiting.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} question={question} onDecided={onDecided} />
        ))}

        {superseded && (
          <p className="cp-note cp-superseded__note">
            The answer above was written before you decided. What actually happened:
          </p>
        )}

        {decided.map((approval) => (
          <ApprovalResolution key={approval.id} approval={approval} />
        ))}

        {run && (
          <div className="cp-chips">
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showTrace}
              iconLeft={<Icons.terminal size={13} />}
              onClick={() => setShowTrace((value) => !value)}
            >
              {showTrace ? 'Hide the steps' : 'Show the steps behind this'}
            </Button>
            <Button size="sm" variant="ghost" iconLeft={<Icons.external size={13} />} onClick={() => onOpenRun(run.id)}>
              Open the full trace
            </Button>
          </div>
        )}

        {showTrace && run && (
          <Card variant="sunken" padding="tight">
            <TracePanel runId={run.id} />
          </Card>
        )}
      </div>
    </div>
  );
}

/* ================================== page ================================== */

export function CopilotPage() {
  const session = useSession();
  const f = useFormat();
  const toast = useToast();
  const { location, navigate, setQuery } = useRouter();

  const [status, setStatus] = useState('open');
  const [filter, setFilter] = useState('');
  const threads = useThreads(status);
  const selected = location.query.thread ?? '';
  const thread = useThread(selected || null);
  const suggestions = useSuggestions();
  const approvals = useAllApprovals();
  const ai = useAiStatus();
  const tools = useTools();
  // The pipelines, the teammates and the metric catalogue: what an answer's
  // scope has to be checked against before it can be shown as a scoped answer.
  const vocabulary = useVocabulary();

  const [draft, setDraft] = useState(location.query.ask ?? '');
  const [allowWrites, setAllowWrites] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [newestMessage, setNewestMessage] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(location.query.draft === '1');
  // Set by the "drop it" control on the thread's carried-scope chip: the next
  // question is asked where there is no earlier turn to inherit a subject from.
  const [dropScope, setDropScope] = useState(false);
  const [renaming, setRenaming] = useState<AiThread | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const renameField = useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = useState<AiThread | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  // A thread has to be chosen before anything can be shown; the newest one is
  // the only sensible default, and it is written into the URL so the choice
  // survives a reload and can be linked to.
  const list = threads.data?.data ?? [];
  useEffect(() => {
    if (selected || !list.length || location.query.new === '1') return;
    setQuery({ thread: list[0].id }, { replace: true });
  }, [selected, list, location.query.new, setQuery]);

  useEffect(() => {
    if (location.query.draft === '1') { setDrafting(true); setQuery({ draft: undefined }, { replace: true }); }
  }, [location.query.draft, setQuery]);

  useEffect(() => {
    if (location.query.ask) {
      setDraft(location.query.ask);
      setQuery({ ask: undefined }, { replace: true });
      composerRef.current?.focus();
    }
  }, [location.query.ask, setQuery]);

  const messages = thread.data?.messages ?? [];
  const runsById = useMemo(
    () => new Map((thread.data?.runs ?? []).map((run) => [run.id, run])),
    [thread.data],
  );

  /**
   * The question an answer answers.
   *
   * The run records it, which is the reliable source — a follow-up rewritten by
   * the engine ("it" resolved to a deal) is still stored as what was typed. The
   * message before it is the fallback for an answer whose run has aged out.
   */
  const questionFor = useCallback((message: AiMessage, index: number): string => {
    const run = message.run_id ? runsById.get(message.run_id) : undefined;
    if (run?.question) return run.question;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return messages[i].content;
    }
    return '';
  }, [messages, runsById]);

  /**
   * What every earlier turn in this thread actually measured.
   *
   * A refusal that says a measure cannot be bound is disproved by this thread
   * having computed it two questions ago, and that is the disproof a reader can
   * check without leaving the screen.
   */
  const priorsFor = useCallback((index: number): { question: string; metrics: string[] }[] => {
    const out: { question: string; metrics: string[] }[] = [];
    for (let i = 0; i < index; i += 1) {
      const earlier = messages[i];
      if (earlier.role !== 'assistant') continue;
      const metrics = metricsMeasured(earlier.tool_calls ?? []);
      if (!metrics.length) continue;
      const run = earlier.run_id ? runsById.get(earlier.run_id) : undefined;
      out.push({ question: run?.question ?? messages[i - 1]?.content ?? '', metrics });
    }
    return out;
  }, [messages, runsById]);

  /** The scope this thread is currently carrying into questions that name none. */
  const threadScope = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role !== 'assistant') continue;
      const run = messages[i].run_id ? runsById.get(messages[i].run_id as string) : undefined;
      const held = carriedScope(run);
      if (held?.subject) return held;
      return null;
    }
    return null;
  }, [messages, runsById]);

  useEffect(() => {
    const node = streamRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, pendingQuestion]);

  /**
   * Where the keyboard is on this screen, which was nowhere.
   *
   * `<body>` is 49 Tab presses from the "Approve and run" button on a prepared
   * write — the whole sidebar, the shell chrome and the conversation list come
   * first — and that is where the caret sat on load and again after every
   * answer rendered, because the composer is cleared and re-rendered as the
   * turn lands. A pending approval is the one thing that outranks the composer:
   * it is a decision the run is blocked on.
   *
   * Focus is only ever *taken* from `<body>`; a person who has clicked into the
   * thread list or a citation keeps where they are.
   */
  const landFocus = useCallback(() => {
    const frame = requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const approve = document.querySelector<HTMLElement>('.cp-approval__actions button');
      (approve ?? composerRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // On mount, and again each time an answer lands.
  useEffect(landFocus, [landFocus, newestMessage]);

  // The way back to the box from anywhere on the screen. `allowInInput` is off,
  // so typing the letter C into the composer or the filter box types a C.
  useHotkey('c', () => composerRef.current?.focus());


  /**
   * The questions this workspace offers on its own empty state.
   *
   * They are printed as a promise — press one and get an answer — so a refusal
   * on one of them is a different, louder failure than a refusal on a sentence
   * somebody typed, and the card says which it is.
   */
  const starters = useMemo(
    () => new Set((suggestions.data?.data ?? []).map((row) => row.question)),
    [suggestions.data],
  );

  const visibleThreads = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? list.filter((row) => row.title.toLowerCase().includes(needle)) : list;
  }, [list, filter]);

  /* --------------------------------- send -------------------------------- */

  const refreshAfterAnswer = useCallback((threadId: string) => {
    invalidate(`/v1/ai/threads/${threadId}`, '/v1/ai/threads', '/v1/ai/approvals', '/v1/ai/runs', '/v1/ai/status');
  }, []);

  const send = useMutation<{ content: string; fresh?: boolean }, { threadId: string; messageId: string | null }>(
    async ({ content, fresh }) => {
      if (selected && !fresh) {
        const reply = await api.post<AiReply>(`/v1/ai/threads/${encodeURIComponent(selected)}/messages`, {
          content,
          ...(allowWrites ? { allow_writes: true } : {}),
        });
        return { threadId: reply.thread_id, messageId: reply.message.id };
      }
      // The thread is opened empty and the question posted to it, rather than
      // handed to POST /v1/ai/threads as `message`: only the messages route
      // carries `allow_writes`, so folding the two calls into one is what made
      // the first question of a conversation silently unable to prepare a write.
      const created = await api.post<ThreadDetail>('/v1/ai/threads', { title: content.slice(0, 120) });
      try {
        const reply = await api.post<AiReply>(`/v1/ai/threads/${encodeURIComponent(created.id)}/messages`, {
          content,
          ...(allowWrites ? { allow_writes: true } : {}),
        });
        return { threadId: created.id, messageId: reply.message.id };
      } catch (e) {
        // The thread exists only to hold the question. If the question never
        // landed, it is an empty row indistinguishable from a fresh
        // conversation — and one more of them for every retry — so it is rolled
        // back with the failure. The toast below still hands the sentence back.
        await api.del(`/v1/ai/threads/${encodeURIComponent(created.id)}`).catch(() => undefined);
        invalidate('/v1/ai/threads');
        throw e;
      }
    },
    {
      onSuccess: ({ threadId, messageId }) => {
        setPendingQuestion(null);
        setNewestMessage(messageId);
        refreshAfterAnswer(threadId);
        if (threadId !== selected) setQuery({ thread: threadId, new: undefined });
      },
      onError: (e: ApiClientError) => {
        setPendingQuestion(null);
        toast.error('The copilot did not answer', `${e.body.message} Your question is still in the box.`, { duration: 0 });
      },
    },
  );

  /* ---------------------------- housekeeping ----------------------------- */

  const refreshList = useCallback(() => { invalidate('/v1/ai/threads'); }, []);

  const setStatusOf = useMutation<{ thread: AiThread; to: 'open' | 'archived' }, AiThread>(
    ({ thread, to }) => api.patch<AiThread>(`/v1/ai/threads/${encodeURIComponent(thread.id)}`, { status: to }),
    {
      onSuccess: (updated, { to }) => {
        refreshList();
        invalidate(`/v1/ai/threads/${updated.id}`);
        // The thread has just left the list that is on screen, so the selection
        // has to leave with it or the rail highlights a row nobody can see.
        if (updated.id === selected && to !== status) setQuery({ thread: undefined, new: '1' });
        toast.success(
          to === 'archived' ? 'Archived' : 'Back in Open',
          to === 'archived'
            ? `“${updated.title}” is out of the way. Switch the list to Archived to read it again.`
            : `“${updated.title}” is in the open conversations again.`,
          {
            action: {
              label: to === 'archived' ? 'Undo' : 'Archive again',
              onClick: () => { void setStatusOf.run({ thread: updated, to: to === 'archived' ? 'open' : 'archived' }).catch(() => undefined); },
            },
          },
        );
      },
      onError: (e) => toast.error('The conversation did not move', e.body.message),
    },
  );

  const rename = useMutation<{ id: string; title: string }, AiThread>(
    ({ id, title }) => api.patch<AiThread>(`/v1/ai/threads/${encodeURIComponent(id)}`, { title }),
    {
      onSuccess: (updated) => {
        refreshList();
        invalidate(`/v1/ai/threads/${updated.id}`);
        setRenaming(null);
        toast.success('Renamed', `This conversation is now “${updated.title}”.`);
      },
      onError: (e) => { if (!e.body.param) toast.error('The rename did not stick', e.body.message); },
    },
  );

  const remove = useMutation<AiThread, void>(
    (thread) => api.del<void>(`/v1/ai/threads/${encodeURIComponent(thread.id)}`),
    {
      onSuccess: (_result, thread) => {
        refreshList();
        setDeleting(null);
        if (thread.id === selected) setQuery({ thread: undefined, new: '1' });
        toast.success('Deleted', `“${thread.title}” and its messages are gone. The runs behind it stay in the log.`);
      },
      onError: (e) => toast.error('The conversation was not deleted', e.body.message),
    },
  );

  const threadMenu = useCallback((row: AiThread): MenuSection[] => [
    {
      id: 'edit',
      items: [
        {
          id: 'rename',
          label: 'Rename…',
          icon: <Icons.edit size={14} />,
          onSelect: () => { setRenaming(row); setRenameTo(row.title); },
        },
        row.status === 'archived'
          ? {
            id: 'reopen',
            label: 'Move back to Open',
            icon: <Icons.inbox size={14} />,
            onSelect: () => { void setStatusOf.run({ thread: row, to: 'open' }).catch(() => undefined); },
          }
          : {
            id: 'archive',
            label: 'Archive',
            description: 'Stays readable under Archived',
            icon: <Icons.folder size={14} />,
            onSelect: () => { void setStatusOf.run({ thread: row, to: 'archived' }).catch(() => undefined); },
          },
      ],
    },
    {
      id: 'danger',
      items: [{
        id: 'delete',
        label: 'Delete',
        description: row.message_count ? `${f.plural(row.message_count, 'message')} go with it` : 'Nothing was ever said in it',
        icon: <Icons.trash size={14} />,
        danger: true,
        onSelect: () => setDeleting(row),
      }],
    },
  ], [f, setStatusOf]);

  /**
   * Ask, optionally in a conversation with no history to inherit.
   *
   * `fresh` is what the carried-scope chip's × does. The engine carries a
   * subject forward whenever a turn names none of its own, and there is no
   * per-message way to tell it not to — so the way to ask a question with
   * nothing carried into it is to ask it where there is nothing to carry.
   */
  const askIn = useCallback((question: string, fresh: boolean) => {
    const content = question.trim();
    if (!content || send.loading) return;
    setDraft('');
    setDropScope(false);
    setPendingQuestion(content);
    // The engine blipping is not a reason to lose the sentence a person typed.
    // It goes back in the box — unless they have already typed something else —
    // with the caret in it, so Enter retries.
    void send.run({ content, fresh }).catch(() => {
      setDraft((current) => current || content);
      requestAnimationFrame(() => composerRef.current?.focus());
    });
  }, [send]);

  const ask = useCallback((question: string) => askIn(question, dropScope), [askIn, dropScope]);
  const askFresh = useCallback((question: string) => askIn(question, true), [askIn]);

  const startNew = () => {
    setQuery({ thread: undefined, new: '1' });
    setDraft('');
    setPendingQuestion(null);
    composerRef.current?.focus();
  };

  const approvalsFor = (runId: string | null) => (runId ? approvals.byRun.get(runId) ?? [] : []);

  const provider = ai.data?.provider;
  const composing = !selected || location.query.new === '1';

  /**
   * The transcript takes whatever room is left, measured rather than guessed.
   *
   * The shell used to subtract a fixed 208px of chrome from the viewport. The
   * page header is not a fixed height: its subtitle grows a line the moment a
   * write is waiting for approval, and on a short window that one line pushed
   * the composer — the box you type in — off the bottom of the page. The top of
   * the shell is where it actually is, so the only thing that scrolls is the
   * stream.
   */
  const subtitleShape = `${provider?.label ?? ''}|${ai.data?.tools ?? 0}|${ai.data?.runs_today ?? 0}|${ai.data?.pending_approvals ?? 0}`;
  useLayoutEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const measure = () => {
      const top = Math.round(el.getBoundingClientRect().top + window.scrollY);
      el.style.setProperty('--cp-shell-top', `${top}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [subtitleShape]);

  /* -------------------------------- render -------------------------------- */

  return (
    <Page
      title="Copilot"
      width="wide"
      subtitle={
        ai.data
          ? `${provider?.label} · ${f.number(ai.data.tools)} tools · ${f.plural(ai.data.runs_today, 'run')} today${ai.data.pending_approvals ? ` · ${ai.data.pending_approvals} waiting for approval` : ''}`
          : 'Answers grounded in this workspace’s own records'
      }
      actions={
        <>
          <Button iconLeft={<Icons.edit size={14} />} onClick={() => setDrafting(true)}>
            Draft
          </Button>
          <Button iconLeft={<Icons.activity size={14} />} onClick={() => navigate('/copilot/runs')}>
            Runs &amp; traces
          </Button>
          <Button variant="primary" iconLeft={<Icons.plus size={14} />} onClick={startNew}>
            New conversation
          </Button>
        </>
      }
    >
      {ai.error && (
        <Banner tone="danger" title="The AI status could not be read" bar>
          {ai.error.body.message} The conversation below still works; only the provider and tool counts are missing.
        </Banner>
      )}

      {/* One key over the whole rail. Tabbing to the composer used to cost 26
          shell stops plus two more for every conversation in the list, and the
          tunnel grew with the thread count. */}
      <a
        className="cp-skip"
        href="#cp-composer"
        onClick={(e) => { e.preventDefault(); composerRef.current?.focus(); }}
      >
        Skip to the message box (C)
      </a>

      <div className="cp-shell" ref={shellRef}>
        <Card
          className="cp-rail"
          padding="tight"
          title="Conversations"
          actions={
            <Select
              value={status}
              onChange={setStatus}
              size="sm"
              aria-label="Conversation status"
              options={[{ value: 'open', label: 'Open' }, { value: 'archived', label: 'Archived' }] as SelectOption[]}
            />
          }
        >
          <SearchInput
            value={filter}
            onChange={setFilter}
            size="sm"
            placeholder="Filter conversations"
            aria-label="Filter conversations"
          />
          <div className="cp-rail__list" style={{ marginTop: 'var(--space-4)' }}>
            {threads.error && (
              <ErrorState
                title="The conversation list did not answer"
                message={threads.error.body.message}
                code={`${threads.error.status} /v1/ai/threads`}
                requestId={threads.error.body.request_id ?? null}
                action={<Button size="sm" variant="primary" onClick={threads.refetch}>Try again</Button>}
              />
            )}
            {!threads.error && threads.loading && <SkeletonText lines={6} />}
            {!threads.error && !threads.loading && visibleThreads.length === 0 && (
              <EmptyState
                size="sm"
                inline
                illustration={null}
                title={filter
                  ? 'No conversation matches'
                  : status === 'archived' ? 'Nothing is archived' : 'No conversations yet'}
                body={filter
                  ? `Nothing here is titled like “${filter}”.`
                  : status === 'archived'
                    ? 'Archive a conversation from the ⋯ menu on its row and it moves here — still readable, out of the way.'
                    : 'Ask the first question and it starts one.'}
                action={filter
                  ? <Button size="sm" onClick={() => setFilter('')}>Clear the filter</Button>
                  : status === 'archived'
                    ? <Button size="sm" onClick={() => setStatus('open')}>Back to the open ones</Button>
                    : <Button size="sm" variant="primary" onClick={startNew}>Ask something</Button>}
              />
            )}
            {visibleThreads.map((row: AiThread) => (
              <div className={`cp-threadrow${row.id === selected ? ' is-active' : ''}`} key={row.id}>
                <button
                  type="button"
                  className={`cp-thread${row.id === selected ? ' is-active' : ''}`}
                  aria-current={row.id === selected ? 'true' : undefined}
                  onClick={() => { setQuery({ thread: row.id, new: undefined }); setPendingQuestion(null); }}
                >
                  <span className="cp-thread__title">{row.title}</span>
                  <span className="cp-thread__meta">
                    <MessageSquareIcon size={11} />
                    {f.plural(row.message_count, 'message')}
                    <span>·</span>
                    {f.relative(row.last_message_at ?? row.updated)}
                    {row.status === 'archived' && (
                      <>
                        <span>·</span>
                        <span>archived</span>
                      </>
                    )}
                  </span>
                </button>
                <MenuButton
                  className="cp-threadrow__menu"
                  size="sm"
                  label={`Rename, archive or delete “${row.title}”`}
                  sections={threadMenu(row)}
                />
              </div>
            ))}
          </div>
        </Card>

        <div className="cp-convo">
          <div
            className="cp-stream"
            ref={streamRef}
            aria-live="polite"
            aria-busy={send.loading}
          >
            {thread.error && (
              <ErrorState
                title="This conversation could not be read"
                message={thread.error.body.message}
                code={`${thread.error.status} /v1/ai/threads/${selected}`}
                requestId={thread.error.body.request_id ?? null}
                action={<Button size="sm" variant="primary" onClick={thread.refetch}>Try again</Button>}
              />
            )}

            {!thread.error && selected && thread.loading && (
              <>
                <Skeleton height={64} />
                <Skeleton height={160} />
              </>
            )}

            {composing && !pendingQuestion && (
              <div style={{ display: 'grid', gap: 'var(--space-6)' }}>
                <EmptyState
                  title="Ask about this workspace"
                  body={
                    tools.data
                      ? `The copilot reads Northwind’s own records through ${f.plural(tools.data.data.length, 'tool')} — CRM, billing, metering, credits and revenue — and cites every record it used. Writes stop for your approval.`
                      : 'The copilot reads this workspace’s own records and cites every one it used.'
                  }
                  illustration={<Icons.sparkles size={40} />}
                />
                {suggestions.error && (
                  <Banner tone="warning" compact title="Starter questions could not be computed">
                    {suggestions.error.body.message}
                  </Banner>
                )}
                {suggestions.data && (
                  <div className="cp-suggest">
                    {suggestions.data.data.map((suggestion) => (
                      <button
                        key={suggestion.question}
                        type="button"
                        className="cp-suggest__item"
                        onClick={() => ask(suggestion.question)}
                      >
                        <span className="cp-suggest__q">{suggestion.question}</span>
                        <span className="cp-suggest__why">{suggestion.why}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!composing && messages.map((message, index) => (
              message.role === 'user' ? (
                <div className="cp-msg cp-msg--user" key={message.id}>
                  <div className="cp-bubble">{message.content}</div>
                  <span className="cp-note">
                    {message.actor_id === session.me?.user?.id ? 'You' : 'Teammate'} · {f.relative(message.created)}
                  </span>
                </div>
              ) : (
                <AssistantMessage
                  key={message.id}
                  message={message}
                  run={message.run_id ? runsById.get(message.run_id) : undefined}
                  approvals={approvalsFor(message.run_id)}
                  newest={message.id === newestMessage && index === messages.length - 1}
                  question={questionFor(message, index)}
                  suggested={starters.has(questionFor(message, index))}
                  priors={priorsFor(index)}
                  vocab={vocabulary.vocab}
                  vocabUnread={!!vocabulary.error}
                  vocabPartial={vocabulary.partial}
                  vocabLoading={vocabulary.loading}
                  onDecided={() => { if (selected) refreshAfterAnswer(selected); }}
                  onOpenRun={(id) => navigate(`/copilot/runs/${id}`)}
                  onAsk={ask}
                  onAskFresh={askFresh}
                  onOpenRecords={navigate}
                />
              )
            ))}

            {pendingQuestion && (
              <>
                <div className="cp-msg cp-msg--user">
                  <div className="cp-bubble">{pendingQuestion}</div>
                  <span className="cp-note">You · just now</span>
                </div>
                <div className="cp-msg">
                  <div className="cp-thinking" role="status">
                    <span className="cp-dot" /><span className="cp-dot" /><span className="cp-dot" />
                    <span>Reading {ai.data ? `${ai.data.tools} tools’ worth of` : 'the'} workspace data…</span>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* The scope this thread will put on the next question that names
              none of its own, before it is asked rather than after. Removing it
              is the only way to ask an unscoped question here: the engine
              carries a subject forward whenever a turn resolves nothing, and no
              message parameter turns that off. */}
          {threadScope?.subject && !composing && (
            <div className="cp-carried cp-carried--composer">
              <span className="cp-carried__label">This conversation is scoped to</span>
              <span className="cp-carried__chip">
                <Icons.link size={11} />
                <span className="u-truncate">{threadScope.subject}</span>
              </span>
              {dropScope ? (
                <span className="cp-note">
                  Dropped — your next question starts a new conversation, so nothing is carried into it.
                  {' '}
                  <button type="button" className="cp-carried__drop" onClick={() => setDropScope(false)}>
                    Keep it after all
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="cp-carried__drop"
                  onClick={() => setDropScope(true)}
                  title={`Questions that name no record are answered for ${threadScope.subject}. Drop it and the next one is asked with nothing carried in.`}
                >
                  <Icons.x size={11} />
                  Drop it
                </button>
              )}
            </div>
          )}

          {/* The landmark the skip link targets. Its name is deliberately not
              "Ask the copilot" — that is the textarea's own name, and two things
              with one accessible name is a region announced identically to the
              box inside it. */}
          <form
            className="cp-composer"
            id="cp-composer"
            aria-label="Copilot message box"
            onSubmit={(e) => { e.preventDefault(); ask(draft); }}
          >
            <Textarea
              ref={composerRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(draft); }
              }}
              minRows={2}
              maxRows={8}
              placeholder={selected && !composing ? 'Ask a follow-up — the thread keeps the context' : 'Ask anything about Northwind Robotics'}
              aria-label="Ask the copilot"
              disabled={send.loading}
            />
            <div className="cp-composer__foot">
              <Switch
                checked={allowWrites}
                onChange={setAllowWrites}
                size="sm"
                label="Let it prepare writes"
                hint="Nothing is written without your approval."
              />
              <span className="cp-composer__hint">Enter sends · Shift+Enter for a new line · C jumps back here</span>
              <Button
                type="submit"
                variant="primary"
                loading={send.loading}
                disabled={!draft.trim()}
                iconLeft={<Icons.send size={14} />}
              >
                Ask
              </Button>
            </div>
          </form>
        </div>
      </div>

      <DraftDialog open={drafting} onClose={() => setDrafting(false)} />

      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        size="sm"
        initialFocus={renameField}
        title="Rename this conversation"
        description="The title is how you will find it again in the rail. Nothing about the answers changes."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={rename.loading}
              disabled={!renameTo.trim() || renameTo.trim() === renaming?.title}
              onClick={() => {
                if (!renaming) return;
                void rename.run({ id: renaming.id, title: renameTo.trim() }).catch(() => undefined);
              }}
            >
              Rename
            </Button>
          </>
        }
      >
        <form
          className="pl-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!renaming || !renameTo.trim()) return;
            void rename.run({ id: renaming.id, title: renameTo.trim() }).catch(() => undefined);
          }}
        >
          <Field
            label="Title"
            required
            error={rename.error?.body.param === 'title' ? rename.error.body.message : null}
            hint="Up to 200 characters."
          >
            <Input
              ref={renameField}
              value={renameTo}
              onChange={(e) => setRenameTo(e.target.value)}
              maxLength={200}
              aria-label="Conversation title"
            />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={() => { if (deleting) void remove.run(deleting).catch(() => undefined); }}
        loading={remove.loading}
        title={`Delete “${deleting?.title ?? ''}”?`}
        body={
          deleting?.message_count
            ? `Its ${f.plural(deleting.message_count, 'message')} go with it and cannot be brought back. The runs behind them stay in the run log, with their traces and costs. Archive instead if you only want it out of the way.`
            : 'Nothing was ever said in this one, so there is nothing to lose. The runs behind it, if any, stay in the run log.'
        }
        confirmLabel="Delete the conversation"
      />
    </Page>
  );
}
