/**
 * Agent observability: the parts of a run a person can inspect.
 *
 * A grounded answer is only grounded if you can get from the sentence to the
 * record it came from, and from the claim to the tool call that measured it.
 * These are the pieces that make that trip possible — citation chips that
 * navigate, steps that open to their exact arguments and result, and the
 * approval card that shows a write before it happens.
 */
import { useRef, useState } from 'react';
import { api, invalidate, useMutation, useQuery } from '@/client/kernel/api';
import { useRouter } from '@/client/kernel/router';
import {
  AlertTriangleIcon,
  Badge, Banner, Button, Card, Checkbox, ChevronDownIcon, ChevronUpIcon, EmptyState, Icons, humanize,
  iconByName, useFormat, useToast,
} from '@/client/design';
import {
  CITATION_ICON, OUTCOME_LABEL, OUTCOME_TONE, SPAN_ICON, SPAN_TONE, approvalOutcome, citationHref,
  confidenceBand, confidenceChip, consequenceLines,
  humanTool, isWiderName, linkedTargetOf, needsAcknowledgement, outcomeSummary, recordLink,
  recordPhraseMismatch,
  runOutcome, stageConsequences, stageWriteOf, useRun, useVocabulary, writeTargetLabel, writeTargets,
  type AiApproval, type AiRun, type AiSpan, type Citation, type StageConsequences,
} from './api';

/* ------------------------------- citations -------------------------------- */

/**
 * The records an answer was read from, as things a keyboard can get to.
 *
 * A chip whose record has no screen used to be a `disabled` button: skipped by
 * Tab, unannounced, with the only explanation in a `title` tooltip that appears
 * on hover and nowhere else. Most of them had a screen all along — the engine
 * cites logged calls, notes, emails and tasks constantly, and every one of
 * those is a record `/records/:type/:id` renders — so they are links now. What
 * genuinely has nowhere to go stays in the tab order as a labelled note,
 * carrying the reason in its accessible name instead of a tooltip.
 */
export function CitationChips({ citations, label = 'Sources' }: { citations: Citation[]; label?: string }) {
  const { navigate } = useRouter();
  if (!citations.length) return null;
  return (
    <div className="cp-chips">
      <span className="cp-chips__label">{label}</span>
      {citations.map((citation) => {
        const href = citationHref(citation);
        const Glyph = iconByName(CITATION_ICON[citation.type] ?? 'link');
        const body = (
          <>
            <Glyph size={12} />
            <span className="u-truncate">{citation.label}</span>
            <span className="cp-chip__type">{humanize(citation.type)}</span>
          </>
        );
        if (!href) {
          return (
            <span
              key={`${citation.type}:${citation.id}`}
              className="cp-chip cp-chip--flat"
              tabIndex={0}
              role="note"
              aria-label={`${citation.label} — ${humanize(citation.type)} ${citation.id}. No screen in this workspace opens it.`}
              title={`${citation.label} — ${citation.id} has no screen in this workspace`}
            >
              {body}
            </span>
          );
        }
        return (
          <a
            key={`${citation.type}:${citation.id}`}
            className="cp-chip"
            href={href}
            title={`Open ${citation.label} (${citation.id})`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate(href);
            }}
          >
            {body}
          </a>
        );
      })}
    </div>
  );
}

/**
 * Where the keyboard goes when a decision destroys the button that made it.
 *
 * "Approve and run" removes itself: the card becomes the record of what
 * happened, and the browser drops focus to `<body>` — the top of the shell,
 * with no announcement that anything was written. The outcome only exists once
 * the approvals and the thread have both come back, so this watches for it
 * rather than guessing at a frame count, and never takes focus from anywhere a
 * person has since put it.
 */
export function restoreFocusAfterDecision(): void {
  if (typeof document === 'undefined') return;
  let frames = 0;
  const settle = () => {
    const active = document.activeElement as HTMLElement | null;
    const adrift = !active || active === document.body || !active.isConnected;
    if (adrift) {
      const target = document.querySelector<HTMLElement>('.cp-approval__actions button')
        ?? [...document.querySelectorAll<HTMLElement>('.cp-resolution')].pop()
        ?? document.querySelector<HTMLElement>('textarea[aria-label="Ask the copilot"]');
      if (target?.isConnected) { target.focus({ preventScroll: true }); return; }
    }
    if (frames++ < 60) requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);
}

/* ---------------------------------- trace --------------------------------- */

const pretty = (value: unknown): string => {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};

function Step({ span, slowest }: { span: AiSpan; slowest: number }) {
  const [open, setOpen] = useState(false);
  const f = useFormat();
  const Glyph = iconByName(SPAN_ICON[span.kind] ?? 'terminal');
  const share = slowest > 0 ? Math.max(4, Math.round((span.duration_ms / slowest) * 100)) : 0;
  const hasArgs = Object.keys(span.args ?? {}).length > 0;

  return (
    <>
      <button
        type="button"
        className={`cp-step${span.ok ? '' : ' is-failed'}`}
        data-kind={span.kind}
        data-span={span.id}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Badge tone={span.ok ? SPAN_TONE[span.kind] ?? 'neutral' : 'danger'} size="sm" icon={<Glyph size={11} />}>
          {span.kind}
        </Badge>
        <span style={{ display: 'grid', gap: 'var(--space-1)', minWidth: 0 }}>
          <span className="cp-step__name">{span.name}</span>
          <span className="cp-step__summary">{span.ok ? span.summary : span.error?.message ?? 'failed'}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span className="cp-bar cp-bar--step">
            <span className="cp-bar__fill" style={{ width: `${share}%` }} />
          </span>
          <span className="cp-step__time">{span.duration_ms} ms</span>
          {open ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
        </span>
      </button>
      {open && (
        <div className="cp-step__detail">
          <div className="cp-note">
            Step {span.seq} · {humanize(span.kind)} · started {f.time(span.started)} · {span.ok ? 'succeeded' : 'failed'}
          </div>
          {!span.ok && span.error && (
            <Banner tone="danger" compact title={span.error.code}>{span.error.message}</Banner>
          )}
          <div>
            <div className="cp-chips__label">Result</div>
            <pre className="cp-code">{span.summary || '—'}</pre>
          </div>
          {hasArgs && (
            <div>
              <div className="cp-chips__label">Arguments</div>
              <pre className="cp-code">{pretty(span.args)}</pre>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * The steps, in the order they happened.
 *
 * A write approved ten minutes after the run stopped is executed then, not when
 * it was planned, and the store hands it back at whatever sequence number it was
 * allocated — which slots it above the plan that asked for it and makes the
 * causal story unreadable. Sorting by the clock puts it where it belongs, and a
 * divider marks the moment a person made the call.
 */
export function TraceSteps({ spans, decidedAfter }: { spans: AiSpan[]; decidedAfter?: number | null }) {
  const f = useFormat();
  if (!spans.length) {
    return <p className="cp-note">This run recorded no steps — nothing was planned and no tool was called.</p>;
  }
  const ordered = [...spans].sort((a, b) => (a.started - b.started) || (a.seq - b.seq));
  const slowest = ordered.reduce((top, span) => Math.max(top, span.duration_ms), 0);
  const boundary = decidedAfter ?? null;
  let dividerDrawn = false;
  return (
    <div className="cp-steps">
      {ordered.map((span) => {
        const after = boundary !== null && span.started > boundary && !dividerDrawn;
        if (after) dividerDrawn = true;
        return (
          <div key={span.id} style={{ display: 'contents' }}>
            {after && (
              <div className="cp-divider">
                <Icons.shield size={12} />
                <span>A person approved the write here — {f.dateTime(span.started)}</span>
              </div>
            )}
            <Step span={span} slowest={slowest} />
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------- approvals ------------------------------- */

/** One deal, as `/v1/records/deal/:id` returns it. */
interface DealRow { id: string; display_name: string; properties: Record<string, unknown> }

const pendingApproval = (approval: { status: string }): boolean => approval.status === 'pending';

const numberOf = (value: unknown): number | null =>
  (typeof value === 'number' && Number.isFinite(value) ? value : null);

const textOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

const dealNow = (row: DealRow) => ({
  id: row.id,
  name: row.display_name,
  stage: textOf(row.properties.deal_stage),
  status: textOf(row.properties.deal_status),
  amount: numberOf(row.properties.amount),
  probability: numberOf(row.properties.probability),
  forecastCategory: textOf(row.properties.forecast_category),
});

/**
 * Everything a stage write does, above the write it says it is.
 *
 * "Deal stage → negotiation" on a closed-lost deal reopens it. The stage line
 * is true and it is not the whole write: the status changes, the deal
 * re-enters open pipeline at its full amount, and the forecast picks it up at
 * the new stage's probability. Approving a one-line preview is not approving
 * that, so the card says all of it and the button waits for a person to
 * acknowledge the part they were not told.
 */
function WriteConsequences({ consequences, unread, onRetry }: {
  consequences: StageConsequences | null;
  unread: boolean;
  /** Reads the deal again — a rate-limited read must not latch the card shut. */
  onRetry: () => void;
}) {
  const f = useFormat();
  if (unread) {
    return (
      <Banner tone="warning" bar title="This write’s consequences could not be worked out">
        <p>
          This is a stage change, and the deal it names could not be read — so this card cannot tell you
          whether it reopens a closed deal or moves the forecast.
        </p>
        <p className="cp-chips" style={{ marginTop: 'var(--space-3)' }}>
          <Button size="sm" variant="secondary" onClick={onRetry}>Read the deal again</Button>
        </p>
      </Banner>
    );
  }
  if (!consequences) return null;
  const lines = consequenceLines(consequences, (minor) => f.money(minor));
  if (!lines.length && !consequences.wrongPipeline) return null;
  const closes = consequences.closedState !== 'unchanged';
  return (
    <Banner
      tone={closes || consequences.wrongPipeline ? 'danger' : 'info'}
      bar={closes || consequences.wrongPipeline}
      title={consequences.closedState === 'reopens'
        ? 'This write reopens a closed deal'
        : consequences.closedState === 'closes'
          ? 'This write closes an open deal'
          : 'What this write changes beyond the stage'}
    >
      {consequences.wrongPipeline && consequences.to && consequences.from && (
        <p>
          <strong>{consequences.to.label}</strong> is a column of {consequences.to.pipelineLabel}, and this
          deal is on {consequences.from.pipelineLabel}. The tool refuses a stage from another pipeline, so
          approving this will fail and nothing will be written.
        </p>
      )}
      <ul className="cp-scope__reasons">
        {lines.map((line) => <li key={line.text}>{line.text}</li>)}
      </ul>
    </Banner>
  );
}

/**
 * The last thing a person reads before a write lands.
 *
 * It shows the exact arguments the engine prepared, not a paraphrase, because
 * approving a summary of a write is not approving the write.
 */
export function ApprovalCard({ approval, question, onDecided }: {
  approval: AiApproval;
  /** The sentence this write was prepared from, so the target can be checked against it. */
  question?: string;
  onDecided?: () => void;
}) {
  const toast = useToast();
  const f = useFormat();
  const [showArgs, setShowArgs] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  /**
   * The record this write would land on, against the record the question named.
   *
   * "Move the Sakamoto Seiki — packaging line uplift deal to Negotiation" was
   * prepared against *Sakamoto Seiki — multi-site rollout* — a closed-won deal
   * for $321,840 — and the card showed the sentence and the wrong record's name
   * three lines apart, with none of the reconciliation apparatus a read answer
   * gets. A write is the one answer that cannot be taken back, so it gets the
   * loudest version of the same check.
   */
  // `linkedTargetOf` reads the "Linked to …" line wherever it sits: a task
  // prepared for "the Sakamoto Seiki — packaging line uplift deal" is
  // associated to the *company* and says so on its eighth preview line, under a
  // first line that reads "New task" — so the card raised nothing at all.
  const target = writeTargetLabel(approval.tool, approval.args, approval.preview)
    ?? linkedTargetOf(approval.preview);
  // The queue and the dashboard card hand no question down, and the guard that
  // catches a write prepared against the wrong record is the whole reason this
  // card is worth reading. The run knows what was asked, so the card asks it
  // rather than going without — one read, only where it is missing.
  const runRead = useRun(question ? null : approval.run_id, pendingApproval(approval));
  const asked = question ?? runRead.data?.question ?? '';
  const mismatch = asked && target ? recordPhraseMismatch(asked, target) : null;

  /**
   * What this write would do beyond the property it names.
   *
   * The deal is read here rather than taken from the write, because the write
   * carries one stage name and every consequence below is a difference between
   * that stage and the one the deal is in right now.
   */
  const stageWrite = stageWriteOf(approval.tool, approval.args);
  const vocabulary = useVocabulary();
  const dealRead = useQuery<DealRow>(
    stageWrite && pendingApproval(approval) ? `/v1/records/deal/${encodeURIComponent(stageWrite.recordId)}` : null,
  );
  const consequences = stageWrite && dealRead.data && vocabulary.vocab.pipelines.length
    ? stageConsequences(dealNow(dealRead.data), stageWrite.stage, vocabulary.vocab)
    : null;
  // A stage write whose deal or board could not be read is the one case where
  // silence is not available: this surface cannot say whether the write reopens
  // a closed deal, and saying nothing would let it through unseen.
  const consequencesUnread = !!stageWrite && pendingApproval(approval)
    && (!!dealRead.error || !!vocabulary.error || (!dealRead.loading && !vocabulary.loading && !consequences));
  const mustAcknowledge = needsAcknowledgement(consequences, consequencesUnread);

  /**
   * The way back from the write with the largest blast radius in this product.
   *
   * A card dropped into the wrong column on the board lands with "Undo" in its
   * notification, and pressing it restores the stage, the probability, the
   * forecast category and the close date the server stamped. The identical
   * write approved here — the one that reopens a closed-lost deal and puts
   * $223,440 back into the forecast — landed with "Written to the workspace"
   * and nothing else, and the only way back was to go and find the deal.
   *
   * The snapshot is taken from the record as this card read it, before the
   * write, so the notification already knows where the deal came from. Only
   * `deal_stage` and `close_date` are put back: the probability, the forecast
   * category and the status are stamped from the stage, and the server refuses
   * a write to them.
   */
  const undoTo = useRef<{ id: string; name: string; stage: string; closeDate: number | null; label: string } | null>(null);
  const captureUndo = () => {
    const row = dealRead.data;
    const stage = row ? textOf(row.properties.deal_stage) : null;
    undoTo.current = stageWrite && row && stage
      ? {
        id: row.id,
        name: row.display_name,
        stage,
        closeDate: numberOf(row.properties.close_date),
        label: consequences?.from?.label ?? humanize(stage),
      }
      : null;
  };

  const undo = useMutation<void, DealRow>(
    () => {
      const back = undoTo.current;
      if (!back) throw new Error('nothing to undo');
      return api.patch<DealRow>(`/v1/records/deal/${encodeURIComponent(back.id)}`, {
        properties: { deal_stage: back.stage, close_date: back.closeDate },
      });
    },
    {
      invalidates: ['/v1/records', '/v1/pipelines', '/v1/crm/overview', '/v1/events', '/v1/ai/runs'],
      onSuccess: (row) => {
        invalidate(`/v1/records/deal/${row.id}`);
        const status = textOf(row.properties.deal_status);
        toast.success(
          `Back in ${undoTo.current?.label ?? 'its old stage'}`,
          `${row.display_name} is ${status ?? 'where it was'} again, at the probability and forecast category that stage carries.`,
        );
        undoTo.current = null;
      },
      onError: (e) => toast.error('The write was not undone', e.body.message),
    },
  );

  const decide = useMutation<'approve' | 'decline', { executed?: boolean; status: string; outcome: string | null }>(
    (decision) => api.post(`/v1/ai/approvals/${encodeURIComponent(approval.id)}`, { decision }),
    {
      invalidates: ['/v1/ai/approvals', '/v1/ai/runs', '/v1/ai/threads', '/v1/ai/status', '/v1/records', '/v1/events'],
      onSuccess: (result, decision) => {
        if (decision === 'approve') {
          // The engine hands back a wire line; the person who pressed the button
          // gets the same sentence the card above it is written in — and a write
          // the tool refused is not announced as one that landed.
          const decided = { ...approval, status: 'approved', outcome: result.outcome };
          const { text } = outcomeSummary(decided);
          if (approvalOutcome(decided) === 'failed') {
            toast.error('Approved — and the write failed', `${text} Nothing changed.`, { duration: 0 });
          } else if (undoTo.current) {
            toast.success('Written to the workspace', text, {
              action: { label: 'Undo', onClick: () => { void undo.run().catch(() => undefined); } },
            });
          } else {
            toast.success('Written to the workspace', text);
          }
        } else {
          toast.info('Declined', `${humanTool(approval.tool)} was not run. Nothing changed.`);
        }
        onDecided?.();
        restoreFocusAfterDecision();
      },
      onError: (e) => toast.error('The decision was refused', e.body.message),
    },
  );

  const pending = approval.status === 'pending';
  const landed = approvalOutcome(approval);
  const summary = pending ? null : outcomeSummary(approval);
  const blocked = mismatch
    ? `This write targets ${mismatch.used}, not ${mismatch.asked}.`
    : consequencesUnread
      ? 'This card could not work out what this write does to the deal.'
      : consequences?.closedState === 'reopens'
        ? 'This reopens a closed deal and puts it back in the pipeline and the forecast.'
        : consequences?.closedState === 'closes'
          ? 'This closes an open deal and takes it out of the pipeline and the forecast.'
          : consequences?.wrongPipeline
            ? 'That stage belongs to another pipeline, so this write will fail.'
            : null;

  return (
    <Card
      variant="raised"
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <Icons.shield size={15} />
          {pending ? 'Waiting for your approval' : `${humanize(approval.status)} ${approval.decided_at ? f.relative(approval.decided_at) : ''}`}
        </span>
      }
      description={approval.reason}
    >
      <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
        {pending && mismatch && (
          <Banner tone="danger" bar title="This write is not on the record you named">
            <p>
              You asked about <strong>{mismatch.asked}</strong>. This write would land on{' '}
              <strong>{mismatch.used}</strong> — {isWiderName(mismatch.asked, mismatch.used)
                ? 'the account above it, not the record you named'
                : 'a different record on the same account'}, and nothing in the arguments below says
              which one you meant.
            </p>
            <p className="cp-note" style={{ marginTop: 'var(--space-3)' }}>
              Decline it and ask again naming the record in full, or tick the box to write to{' '}
              {mismatch.used} anyway.
            </p>
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Checkbox
                checked={acknowledged}
                onChange={setAcknowledged}
                label={`Yes — write to ${mismatch.used}`}
              />
            </div>
          </Banner>
        )}

        <div className="cp-approval__preview">
          {approval.preview.map((line, i) => <span key={i}>{line}</span>)}
        </div>

        {pending && (
          <WriteConsequences
            consequences={consequences}
            unread={consequencesUnread}
            onRetry={dealRead.refetch}
          />
        )}

        {pending && mustAcknowledge && !mismatch && (
          <Checkbox
            checked={acknowledged}
            onChange={setAcknowledged}
            label={consequencesUnread
              ? 'Yes — approve it without knowing what it does to the forecast'
              : consequences?.closedState === 'reopens'
                ? `Yes — reopen ${consequences.from ? `this ${consequences.from.label.toLowerCase()} deal` : 'this closed deal'} and put it back in the forecast`
                : consequences?.closedState === 'closes'
                  ? 'Yes — close this deal and take it out of the forecast'
                  : 'Yes — run it anyway'}
          />
        )}

        {decide.error && (
          <Banner tone="danger" title="The decision was refused">{decide.error.body.message}</Banner>
        )}

        {summary && (
          <Banner
            tone={landed === 'written' ? 'success' : landed === 'failed' ? 'danger' : 'neutral'}
            compact
            title={landed === 'failed' ? 'Approved — the write failed' : undefined}
          >
            {summary.text}
          </Banner>
        )}

        {landed === 'written' && <WrittenTo approval={approval} />}

        <div className="cp-approval__actions">
          <Badge tone="neutral" size="sm" icon={<Icons.terminal size={11} />}>{approval.tool}</Badge>
          <Button size="sm" variant="ghost" onClick={() => setShowArgs((value) => !value)} aria-expanded={showArgs}>
            {showArgs ? 'Hide the exact arguments' : 'Show the exact arguments'}
          </Button>
          {pending && (
            <>
              <div style={{ flex: '1 1 auto' }} />
              <Button
                size="sm"
                variant="secondary"
                loading={decide.loading}
                onClick={() => { void decide.run('decline').catch(() => undefined); }}
              >
                Decline
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={decide.loading}
                disabled={((!!mismatch || mustAcknowledge) && !acknowledged) || dealRead.loading}
                title={blocked
                  ? `${blocked} Confirm it above first.`
                  : undefined}
                iconLeft={<Icons.check size={13} />}
                onClick={() => {
                  captureUndo();
                  void decide.run('approve').catch(() => undefined);
                }}
              >
                {mismatch || mustAcknowledge ? 'Approve anyway' : 'Approve and run'}
              </Button>
            </>
          )}
        </div>

        {showArgs && (
          <>
            <pre className="cp-code">{pretty(approval.args)}</pre>
            {summary?.raw && (
              <>
                <div className="cp-chips__label">What the tool returned</div>
                <pre className="cp-code">{summary.raw}</pre>
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

/** The records a landed write is now on, as links. */
export function WrittenTo({ approval }: { approval: AiApproval }) {
  const { navigate } = useRouter();
  const targets = writeTargets(approval.args);
  if (!targets.length) return null;
  return (
    <div className="cp-chips">
      <span className="cp-chips__label">Written to</span>
      {targets.map((id) => {
        const link = recordLink(id);
        const Glyph = iconByName(CITATION_ICON[link?.type ?? ''] ?? 'link');
        // "Note on Ferro Norte Siderurgia" names the record; with more than one
        // target there is no way to tell which name belongs to which id, so the
        // id stands rather than a wrong name.
        const name = targets.length === 1
          ? / on (.+)$/.exec(approval.preview[0] ?? '')?.[1] ?? id
          : id;
        const body = (
          <>
            <Glyph size={12} />
            <span className="u-truncate">{name}</span>
            <span className="cp-chip__type">{humanize(link?.type ?? 'record')}</span>
          </>
        );
        return link ? (
          <a
            key={id}
            className="cp-chip"
            href={link.href}
            title={`Open ${name}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate(link.href);
            }}
          >
            {body}
          </a>
        ) : (
          <span
            key={id}
            className="cp-chip cp-chip--flat"
            tabIndex={0}
            role="note"
            aria-label={`${name} — no screen in this workspace opens it.`}
            title={`${id} has no screen in this workspace`}
          >
            {body}
          </span>
        );
      })}
    </div>
  );
}

/**
 * What became of a write, after the decision.
 *
 * The assistant's own turn was composed before anyone pressed anything — it says
 * "Nothing has been written" and it will say that forever. This block is the
 * conversation's record of what actually happened, so re-reading the thread a
 * week later tells the truth instead of the plan.
 */
export function ApprovalResolution({ approval }: { approval: AiApproval }) {
  const f = useFormat();
  const [showArgs, setShowArgs] = useState(false);
  // The decision a person made is not the same fact as what the tool did with
  // it. A write refused by the tool — `Failed: "commercial_terms" belongs to
  // the Renewal pipeline` — wore a green "Approved and written" badge and a
  // link to the record it had not written to, above the sentence saying so.
  const landed = approvalOutcome(approval);
  const written = landed === 'written';
  const summary = outcomeSummary(approval);
  const label = landed === 'written' ? 'Approved and written'
    : landed === 'failed' ? 'Approved — the write failed'
      : 'Declined';
  return (
    <div
      className={`cp-resolution${written ? ' is-written' : ''}${landed === 'failed' ? ' is-failed' : ''}`}
      data-approval={approval.id}
      data-outcome={landed}
      tabIndex={-1}
      role="status"
      aria-label={`${label}: ${summary.text}`}
    >
      <div className="cp-resolution__head">
        <Badge
          tone={landed === 'written' ? 'success' : landed === 'failed' ? 'danger' : 'neutral'}
          size="sm"
          icon={landed === 'written'
            ? <Icons.check size={11} />
            : landed === 'failed' ? <AlertTriangleIcon size={11} /> : <Icons.shield size={11} />}
        >
          {label}
        </Badge>
        <span className="cp-note">
          {approval.decided_at ? f.relative(approval.decided_at) : 'just now'} · {humanTool(approval.tool)}
        </span>
      </div>
      <p className="cp-resolution__line">{summary.text}</p>
      {written && <WrittenTo approval={approval} />}
      <div className="cp-chips">
        <Button size="sm" variant="ghost" aria-expanded={showArgs} onClick={() => setShowArgs((v) => !v)}>
          {showArgs ? 'Hide what ran' : 'Show what ran'}
        </Button>
      </div>
      {showArgs && (
        <>
          <pre className="cp-code">{pretty(approval.args)}</pre>
          {summary.raw && <pre className="cp-code">{summary.raw}</pre>}
        </>
      )}
    </div>
  );
}

export function ApprovalQueue({ approvals, question, onDecided }: {
  approvals: AiApproval[];
  /** The question every one of these was prepared from, where they share one. */
  question?: string;
  onDecided?: () => void;
}) {
  if (!approvals.length) {
    return (
      <EmptyState
        size="sm"
        inline
        illustration={null}
        title="Nothing is waiting on you"
        body="Write tools stop here before they run. When an agent prepares one, its exact arguments appear on this screen."
      />
    );
  }
  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} question={question} onDecided={onDecided} />
      ))}
    </div>
  );
}

/* --------------------------------- run bits ------------------------------- */

/**
 * The engine's confidence is in its *reading of the question*, not in the
 * answer — so the chip says so, and no longer says it in the words "question
 * read at". That label was highest exactly where the question had been read
 * worst: 98% on a CSAT question answered with a company card, 98% on an
 * outstanding-balance question answered with a deal list, 99% on the write that
 * moved the wrong deal. It measures the intent classifier's margin, so it is
 * named after that.
 *
 * And where a qualifier of the question went unbound the percentage does not
 * appear at all. Printing "intent read at 99%" beside "1 unbound" put the
 * number that is anti-correlated with trustworthiness first, in the biggest
 * type on the card, on exactly the answers that answered something else. The
 * count is the accurate half; the classifier's margin moves to the tooltip,
 * where it is still readable and no longer the headline.
 */
export function ConfidenceBadge({ run, refused, unbound = 0 }: {
  run: AiRun;
  refused?: boolean;
  /** Qualifiers the question named that the answer did not narrow to. */
  unbound?: number;
}) {
  if (run.confidence === null || refused) return null;
  const band = confidenceBand(run.confidence);
  const percent = Math.round(run.confidence * 100);
  const tone = unbound > 0 ? 'danger' : band === 'high' ? 'success' : band === 'medium' ? 'warning' : 'danger';
  return (
    <Badge
      size="sm"
      tone={tone}
      title={unbound > 0
        ? `The intent classifier was ${percent}% sure this is a ${humanize(run.intent ?? 'question').toLowerCase()} question, and ${unbound === 1 ? 'one qualifier of it was' : `${unbound} qualifiers of it were`} left unbound. It is not a claim about the answer.`
        : `The intent classifier was ${percent}% sure it read this as a ${humanize(run.intent ?? 'question').toLowerCase()} question. It is not a claim about the answer.`}
    >
      {confidenceChip(percent, unbound)}
    </Badge>
  );
}

export function RunFacts({ run, toolMs, approvals, steps }: {
  run: AiRun;
  toolMs?: number;
  /** Every approval this run raised, so a decided one is not still "waiting". */
  approvals?: AiApproval[];
  /** The trace as rendered, so the step count matches the panel below it. */
  steps?: number;
}) {
  const f = useFormat();
  const outcome = runOutcome(run, approvals);
  const stepCount = steps ?? run.span_count;
  const facts: { label: string; value: string; hint?: string }[] = [
    {
      label: 'Outcome',
      value: OUTCOME_LABEL[outcome],
      hint: run.error ?? (outcome === 'written' ? 'A person approved the write and it ran' : outcome === 'declined' ? 'A person declined it; nothing was written' : undefined),
    },
    { label: 'Answered by', value: run.model, hint: humanize(run.provider) },
    { label: 'Intent', value: run.intent ? humanize(run.intent) : '—', hint: run.confidence === null ? undefined : `intent read at ${Math.round(run.confidence * 100)}%` },
    { label: 'Duration', value: `${f.number(run.duration_ms)} ms`, hint: toolMs === undefined ? `${f.plural(stepCount, 'step')}` : `${f.number(toolMs)} ms in tools` },
    { label: 'Tokens', value: f.number(run.usage.input_tokens + run.usage.output_tokens), hint: `${f.number(run.usage.input_tokens)} in · ${f.number(run.usage.output_tokens)} out` },
    {
      // Credits are what the workspace is charged; provider spend is what it
      // cost us. "No marginal cost / 5 credits charged" read as a contradiction.
      label: 'Charged',
      value: f.plural(run.usage.credits, 'credit'),
      hint: run.usage.cost_micros > 0
        ? `${f.money(run.usage.cost_cents)} of provider spend`
        : 'Answered in-house — no provider spend',
    },
  ];
  return (
    <div className="cp-runfacts">
      {facts.map((fact) => (
        <div className="cp-runfact" key={fact.label}>
          <span className="cp-runfact__label">{fact.label}</span>
          <span className="cp-runfact__value">{fact.value}</span>
          {fact.hint && <span className="cp-runfact__hint">{fact.hint}</span>}
        </div>
      ))}
    </div>
  );
}

export function ReasoningList({ lines }: { lines: string[] }) {
  if (!lines.length) return <p className="cp-note">This run left no working notes.</p>;
  return (
    <ol className="cp-reasoning">
      {lines.map((line, i) => <li key={i}>{line}</li>)}
    </ol>
  );
}
