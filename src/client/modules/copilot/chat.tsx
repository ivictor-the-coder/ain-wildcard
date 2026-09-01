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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, invalidate, useMutation, type ApiClientError } from '@/client/kernel/api';
import { useRouter } from '@/client/kernel/router';
import { useSession } from '@/client/kernel/session';
import {
  Badge, Banner, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Icons, Input, MenuButton,
  MessageSquareIcon, Modal, Page, SearchInput, Select, Skeleton, SkeletonText, Switch, Textarea,
  humanize, useFormat, usePrefersReducedMotion, useToast, type MenuSection, type SelectOption,
} from '@/client/design';
import {
  parseBlocks, refusalOf, useAiStatus, useAllApprovals, useSuggestions, useThread, useThreads,
  useTools, useRun,
  type AiApproval, type AiMessage, type AiReply, type AiRun, type AiThread, type ThreadDetail,
} from './api';
import {
  ApprovalCard, ApprovalResolution, CitationChips, ConfidenceBadge, ReasoningList, TraceSteps,
} from './trace';
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
  message, run, approvals, newest, onDecided, onOpenRun,
}: {
  message: AiMessage;
  run: AiRun | undefined;
  approvals: AiApproval[];
  newest: boolean;
  onDecided: () => void;
  onOpenRun: (id: string) => void;
}) {
  const f = useFormat();
  const [showTrace, setShowTrace] = useState(false);
  const { shown, done } = useReveal(message.content, newest);
  const refusal = refusalOf(run);
  const lowConfidence = !!run && run.confidence !== null && run.confidence < 0.55 && !refusal;

  // The prose was composed when the engine stopped: it says "Nothing has been
  // written" and always will. Once a decision has been made it is history, not
  // the current state of the workspace, and the turn has to say so.
  const waiting = approvals.filter((approval) => approval.status === 'pending');
  const decided = approvals.filter((approval) => approval.status !== 'pending');
  const superseded = decided.length > 0 && waiting.length === 0;

  return (
    <div className="cp-msg cp-msg--assistant">
      <div className="cp-answer">
        <div className="cp-answer__head">
          <Badge tone="brand" size="sm" icon={<Icons.sparkles size={11} />}>
            {run ? run.model : 'Copilot'}
          </Badge>
          {run && <ConfidenceBadge run={run} refused={!!refusal} />}
          {(waiting.length > 0 || (run?.status === 'needs_approval' && approvals.length === 0))
            && <Badge tone="warning" size="sm">waiting for approval</Badge>}
          {superseded && (
            <Badge tone={decided.some((a) => a.status === 'approved') ? 'success' : 'neutral'} size="sm">
              {decided.some((a) => a.status === 'approved') ? 'decided — written' : 'decided — declined'}
            </Badge>
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

        {refusal && (
          <Banner tone="warning" title="The engine refused to answer this one" bar>
            {refusal.message}
            {' '}
            <span className="cp-mono">({refusal.code})</span>
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

        <div className={superseded ? 'cp-superseded' : undefined}>
          <AnswerBody content={shown} revealing={!done} />
        </div>

        <CitationChips citations={message.citations.length ? message.citations : run?.citations ?? []} />

        {waiting.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} onDecided={onDecided} />
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

  const [draft, setDraft] = useState(location.query.ask ?? '');
  const [allowWrites, setAllowWrites] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [newestMessage, setNewestMessage] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(location.query.draft === '1');
  const [renaming, setRenaming] = useState<AiThread | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [deleting, setDeleting] = useState<AiThread | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    const node = streamRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, pendingQuestion]);

  const visibleThreads = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? list.filter((row) => row.title.toLowerCase().includes(needle)) : list;
  }, [list, filter]);

  /* --------------------------------- send -------------------------------- */

  const refreshAfterAnswer = useCallback((threadId: string) => {
    invalidate(`/v1/ai/threads/${threadId}`, '/v1/ai/threads', '/v1/ai/approvals', '/v1/ai/runs', '/v1/ai/status');
  }, []);

  const send = useMutation<string, { threadId: string; messageId: string | null }>(
    async (content) => {
      if (selected) {
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

  const ask = useCallback((question: string) => {
    const content = question.trim();
    if (!content || send.loading) return;
    setDraft('');
    setPendingQuestion(content);
    // The engine blipping is not a reason to lose the sentence a person typed.
    // It goes back in the box — unless they have already typed something else —
    // with the caret in it, so Enter retries.
    void send.run(content).catch(() => {
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
  const composing = !selected || location.query.new === '1';

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

      <div className="cp-shell">
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
            className={`cp-stream${!composing && messages.length > 0 ? ' cp-stream--messages' : ''}`}
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
                  onDecided={() => { if (selected) refreshAfterAnswer(selected); }}
                  onOpenRun={(id) => navigate(`/copilot/runs/${id}`)}
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

          <form
            className="cp-composer"
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
              <span className="cp-composer__hint">Enter sends · Shift+Enter for a new line</span>
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
              value={renameTo}
              onChange={(e) => setRenameTo(e.target.value)}
              maxLength={200}
              autoFocus
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
