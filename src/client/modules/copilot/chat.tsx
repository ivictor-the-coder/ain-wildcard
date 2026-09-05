/**
 * The copilot.
 *
 * A chat over the workspace's own records, with three things a chat box on its
 * own does not give you: every claim carries the records it was read from, every
 * step the engine took is inspectable down to the arguments it passed, and a
 * write stops at an approval card that shows exactly what it would do.
 *
 * The built-in engine answers a whitelist of question shapes and nothing else.
 * So the surface shows the list ("What can I ask?"), opens an empty thread with
 * five of them, says on every answer which engine produced it, and — when the
 * engine refuses — puts the three nearest shapes it does answer directly under
 * the refusal, one press each. Every slot chip on an answer is read off the
 * plan the engine ran; nothing on the card is inferred from the wording.
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
  MODEL_KEY_VAR, answerCard, dealNamedIn, decidedBadge, dedupeCitations, editHref, filterTemplates,
  groupTemplates, parseBlocks, propertyAsked, splitToolEcho, starterTemplates, useAiStatus, useAllApprovals,
  useRun, useTemplates, useThread, useThreads, useTools, useVocabulary, windowText,
  type AiApproval, type AiCompletion, type AiMessage, type AiRun, type AiTemplate, type AiThread,
  type Remembered, type StepNote, type ThreadDetail, type ToolEcho, type Vocabulary,
} from './api';
import { ApprovalCard, ApprovalResolution, CitationChips, ReasoningList, TraceSteps } from './trace';
import { EngineIndicator, RefusalHelp, SlotChips } from './card';
import { TemplatePanel, TemplateStarters } from './templates';
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
  message, run, approvals, newest, question, remembered, templates, hosted, vocab,
  onDecided, onOpenRun, onAsk, onSeeAll, onOpenRecords,
}: {
  message: AiMessage;
  run: AiRun | undefined;
  approvals: AiApproval[];
  newest: boolean;
  /** The question this answer answers, as the run recorded it. */
  question: string;
  /** What the completion said about this run, when it was asked in this session. */
  remembered: Remembered | null;
  templates: AiTemplate[];
  /** Whether a hosted model is configured — the difference between the two engine footnotes. */
  hosted: boolean;
  vocab: Vocabulary;
  onDecided: () => void;
  onOpenRun: (id: string) => void;
  /** Puts a nearest-shape chip into the thread as the next question. */
  onAsk: (question: string) => void;
  /** Opens the full "What can I ask?" panel. */
  onSeeAll: () => void;
  /** Opens a screen this answer pointed at. */
  onOpenRecords: (href: string) => void;
}) {
  const f = useFormat();
  const [showTrace, setShowTrace] = useState(false);
  // The tool echo is not prose and is not typed out as prose: the answer is
  // what gets revealed, and what the tools returned beyond it sits under it.
  const { prose, echoes, notes } = useMemo(() => splitToolEcho(message.content), [message.content]);

  // Deduped by record id: the engine cites the row it read, and a ticket read
  // twice — once for the count and once for the oldest — was listed twice in
  // SOURCES, which reads as two tickets.
  const citations = useMemo(
    () => dedupeCitations(message.citations.length ? message.citations : run?.citations ?? []),
    [message.citations, run?.citations],
  );

  /**
   * Everything the card draws, decided in one place.
   *
   * The engine that answered, the refusal with its nearest shapes, the slot
   * values read off the plan — all from fields the engine published with the
   * answer. No request is made per message and nothing is inferred about the
   * wording of the question.
   */
  const card = useMemo(() => answerCard({
    question,
    toolCalls: message.tool_calls ?? [],
    run,
    remembered,
    templates,
    hosted,
    vocab,
    format: {
      // The engine's windows are UTC calendar boundaries and half-open, so
      // they are stated in UTC as inclusive dates — not in the viewer's zone,
      // where Q4 would read as starting on 30 September.
      window: (w) => windowText(w, {
        dateRange: (start, end) => f.dateRange(start, end, { timeZone: 'UTC' }),
        date: (ts) => f.date(ts, { timeZone: 'UTC' }),
      }),
      name: (id) => citations.find((c) => c.id === id)?.label
        ?? vocab.people.find((person) => person.id === id)?.name
        ?? id,
    },
  }), [question, message.tool_calls, run, remembered, templates, hosted, vocab, citations, f]);

  // A request to set a property the engine's write extractor cannot read. The
  // deal is found on the account it did cite, so the dead end becomes a link
  // to the screen where the property is editable.
  const wanted = card.noWrite ? propertyAsked(question) : null;
  const account = wanted ? citations.find((c) => c.type === 'company' || c.type === 'customer_company') : undefined;
  const accountDeals = useQuery<ListEnvelope<{ id: string; display_name: string }>>(
    account ? '/v1/records/deal' : null,
    account ? { q: account.label, limit: 25 } : undefined,
  );
  const settable = wanted && accountDeals.data
    ? dealNamedIn(question, accountDeals.data.data)
    : null;

  const { shown, done } = useReveal(prose, newest);

  // The prose was composed when the engine stopped: it says "Nothing has been
  // written" and always will. Once a decision has been made it is history, not
  // the current state of the workspace, and the turn has to say so.
  const waiting = approvals.filter((approval) => approval.status === 'pending');
  const decided = approvals.filter((approval) => approval.status !== 'pending');
  const superseded = decided.length > 0 && waiting.length === 0;

  return (
    <div className="cp-msg cp-msg--assistant">
      <div className={`cp-answer${card.refusal ? ' is-refused' : ''}`} data-engine={card.engine}>
        <div className="cp-answer__head">
          <Badge tone="brand" size="sm" icon={<Icons.sparkles size={11} />}>
            {run ? run.model : 'Copilot'}
          </Badge>
          <EngineIndicator line={card.indicator} />
          {card.refusal && <Badge tone="warning" size="sm">refused</Badge>}
          {(waiting.length > 0 || (run?.status === 'needs_approval' && approvals.length === 0))
            && <Badge tone="warning" size="sm">waiting for approval</Badge>}
          {superseded && (
            <Badge tone={decidedBadge(decided).tone} size="sm">{decidedBadge(decided).label}</Badge>
          )}
          {card.failed && <Badge tone="danger" size="sm">failed</Badge>}
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

        {card.noWrite && wanted && (
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
                  className="cp-chip cp-chip--wide"
                  title={`Open ${settable.display_name} with ${wanted.label} on screen`}
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

        {card.failed && (
          <Banner tone="danger" title="This run failed">{card.failed}</Banner>
        )}

        <SlotChips slots={card.slots} />

        <div className={superseded ? 'cp-superseded' : undefined}>
          <AnswerBody content={shown} revealing={!done} />
        </div>

        {/* The way out of a refusal sits directly under it: the refusal is the
            prose above, and the reason the engine recorded, when it recorded
            one apart from the prose, sits between the two. */}
        {card.refusal && done && (
          <>
            {card.refusal.message && !prose.includes(card.refusal.message) && (
              <p className="cp-note">
                {card.refusal.message} <span className="cp-mono">({card.refusal.code})</span>
              </p>
            )}
            <RefusalHelp refusal={card.refusal} onAsk={onAsk} onSeeAll={onSeeAll} />
          </>
        )}

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
  const templates = useTemplates();
  const approvals = useAllApprovals();
  const ai = useAiStatus();
  const tools = useTools();
  // The pipelines, the teammates and the metric catalogue: what turns the ids
  // in a plan's arguments into the names on a slot chip.
  const vocabulary = useVocabulary();

  const [draft, setDraft] = useState(location.query.ask ?? '');
  const [allowWrites, setAllowWrites] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [newestRun, setNewestRun] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(location.query.draft === '1');
  const [asking, setAsking] = useState(false);
  const [templateQuery, setTemplateQuery] = useState('');
  /**
   * What each completion said about its run, for the session.
   *
   * `engine`, `nearest` and the template binding come back on the completion
   * envelope and nowhere else; the thread read that redraws the turn carries
   * the message and the run. Kept by run id so the redraw can find them.
   */
  const [remembered, setRemembered] = useState<Map<string, Remembered>>(() => new Map());
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
  useEffect(landFocus, [landFocus, newestRun]);

  // The way back to the box from anywhere on the screen. `allowInInput` is off,
  // so typing the letter C into the composer or the filter box types a C.
  useHotkey('c', () => composerRef.current?.focus());

  const visibleThreads = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? list.filter((row) => row.title.toLowerCase().includes(needle)) : list;
  }, [list, filter]);

  const templateRows = useMemo(() => templates.data?.data ?? [], [templates.data]);
  const starters = useMemo(() => starterTemplates(templateRows, 5), [templateRows]);
  const groups = useMemo(
    () => groupTemplates(filterTemplates(templateRows, templateQuery)),
    [templateRows, templateQuery],
  );

  /* --------------------------------- send -------------------------------- */

  const refreshAfterAnswer = useCallback((threadId: string) => {
    invalidate(`/v1/ai/threads/${threadId}`, '/v1/ai/threads', '/v1/ai/approvals', '/v1/ai/runs', '/v1/ai/status');
  }, []);

  /**
   * A turn is posted as a completion on the thread.
   *
   * `POST /v1/ai/complete` with `thread_id` appends the turn exactly as the
   * messages route does, and it is the one route that says which engine
   * answered and which shapes come closest on a refusal. Both are kept for
   * the session by run id; the thread re-read that follows draws the turn.
   */
  const complete = (threadId: string, content: string) =>
    api.post<AiCompletion>('/v1/ai/complete', {
      thread_id: threadId,
      prompt: content,
      feature: 'copilot',
      ...(allowWrites ? { allow_writes: true } : {}),
    });

  const send = useMutation<{ content: string }, { threadId: string; completion: AiCompletion }>(
    async ({ content }) => {
      if (selected) {
        return { threadId: selected, completion: await complete(selected, content) };
      }
      // The thread is opened empty and the question posted to it: only the
      // completion route carries `allow_writes` and reports the engine.
      const created = await api.post<ThreadDetail>('/v1/ai/threads', { title: content.slice(0, 120) });
      try {
        return { threadId: created.id, completion: await complete(created.id, content) };
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
      onSuccess: ({ threadId, completion }) => {
        setPendingQuestion(null);
        setRemembered((current) => {
          const next = new Map(current);
          next.set(completion.run_id, {
            engine: completion.engine ?? null,
            nearest: completion.nearest ?? null,
            template: completion.template ?? null,
            analysis: completion.analysis ?? null,
          });
          return next;
        });
        setNewestRun(completion.run_id);
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

  const ask = useCallback((question: string) => {
    const content = question.trim();
    if (!content || send.loading) return;
    setDraft('');
    setAsking(false);
    setPendingQuestion(content);
    // The engine blipping is not a reason to lose the sentence a person typed.
    // It goes back in the box — unless they have already typed something else —
    // with the caret in it, so Enter retries.
    void send.run({ content }).catch(() => {
      setDraft((current) => current || content);
      requestAnimationFrame(() => composerRef.current?.focus());
    });
  }, [send]);

  const startNew = () => {
    setQuery({ thread: undefined, new: '1' });
    setDraft('');
    setPendingQuestion(null);
    composerRef.current?.focus();
  };

  const approvalsFor = (runId: string | null) => (runId ? approvals.byRun.get(runId) ?? [] : []);

  const provider = ai.data?.provider;
  // Until the status has answered nothing is claimed about a key either way.
  const hosted = ai.data ? ai.data.provider.hosted : true;
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

  const templatesState = (
    templates.error
      ? (
        <ErrorState
          title="The question list did not answer"
          message={templates.error.body.message}
          code={`${templates.error.status} /v1/ai/templates`}
          requestId={templates.error.body.request_id ?? null}
          action={<Button size="sm" variant="primary" onClick={templates.refetch}>Try again</Button>}
        />
      )
      : templates.loading
        ? <SkeletonText lines={6} />
        : null
  );

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
          <Button iconLeft={<Icons.help size={14} />} onClick={() => setAsking(true)}>
            What can I ask?
          </Button>
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
                      ? `The copilot reads Northwind’s own records through ${f.plural(tools.data.data.length, 'tool')} — CRM, billing, metering, credits and revenue — and cites every record it used. Writes stop for your approval.${hosted ? '' : ' Without a model key it answers the question shapes below and nothing else.'}`
                      : 'The copilot reads this workspace’s own records and cites every one it used.'
                  }
                  illustration={<Icons.sparkles size={40} />}
                />
                {templatesState}
                {templates.data && (
                  <TemplateStarters
                    templates={starters}
                    total={templateRows.length}
                    onAsk={ask}
                    onSeeAll={() => setAsking(true)}
                  />
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
                  newest={!!message.run_id && message.run_id === newestRun && index === messages.length - 1}
                  question={questionFor(message, index)}
                  remembered={message.run_id ? remembered.get(message.run_id) ?? null : null}
                  templates={templateRows}
                  hosted={hosted}
                  vocab={vocabulary.vocab}
                  onDecided={() => { if (selected) refreshAfterAnswer(selected); }}
                  onOpenRun={(id) => navigate(`/copilot/runs/${id}`)}
                  onAsk={ask}
                  onSeeAll={() => setAsking(true)}
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
        open={asking}
        onClose={() => setAsking(false)}
        size="lg"
        title="What can I ask?"
        description={hosted
          ? 'Every question shape the built-in engine answers, with this workspace’s own values in it. Pick one to ask it. A hosted model is configured, so free-text questions are answered too.'
          : `Every question shape the built-in engine answers, with this workspace’s own values in it. Pick one to ask it. No hosted model is configured, so these are the only questions it answers — free text needs ${MODEL_KEY_VAR} set where the API runs.`}
        footer={<Button onClick={() => setAsking(false)}>Close</Button>}
      >
        <div className="cp-templates__filter">
          <SearchInput
            value={templateQuery}
            onChange={setTemplateQuery}
            placeholder="Filter the questions — “deals”, “owed”, “Growth”"
            aria-label="Filter the questions"
          />
        </div>
        {templatesState}
        {templates.data && (
          <TemplatePanel groups={groups} onAsk={ask} query={templateQuery} total={templateRows.length} />
        )}
      </Modal>

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
