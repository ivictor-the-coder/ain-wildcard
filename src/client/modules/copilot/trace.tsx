/**
 * Agent observability: the parts of a run a person can inspect.
 *
 * A grounded answer is only grounded if you can get from the sentence to the
 * record it came from, and from the claim to the tool call that measured it.
 * These are the pieces that make that trip possible — citation chips that
 * navigate, steps that open to their exact arguments and result, and the
 * approval card that shows a write before it happens.
 */
import { useState } from 'react';
import { api, useMutation } from '@/client/kernel/api';
import { useRouter } from '@/client/kernel/router';
import {
  Badge, Banner, Button, Card, ChevronDownIcon, ChevronUpIcon, EmptyState, Icons, humanize,
  iconByName, useFormat, useToast,
} from '@/client/design';
import {
  CITATION_ICON, OUTCOME_LABEL, OUTCOME_TONE, SPAN_ICON, SPAN_TONE, citationHref, confidenceBand,
  humanTool, outcomeSummary, recordLink, runOutcome, writeTargets,
  type AiApproval, type AiRun, type AiSpan, type Citation,
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

/**
 * The last thing a person reads before a write lands.
 *
 * It shows the exact arguments the engine prepared, not a paraphrase, because
 * approving a summary of a write is not approving the write.
 */
export function ApprovalCard({ approval, onDecided }: { approval: AiApproval; onDecided?: () => void }) {
  const toast = useToast();
  const f = useFormat();
  const [showArgs, setShowArgs] = useState(false);

  const decide = useMutation<'approve' | 'decline', { executed?: boolean; status: string; outcome: string | null }>(
    (decision) => api.post(`/v1/ai/approvals/${encodeURIComponent(approval.id)}`, { decision }),
    {
      invalidates: ['/v1/ai/approvals', '/v1/ai/runs', '/v1/ai/threads', '/v1/ai/status', '/v1/records', '/v1/events'],
      onSuccess: (result, decision) => {
        if (decision === 'approve') {
          // The engine hands back a wire line; the person who pressed the button
          // gets the same sentence the card above it is written in.
          const { text } = outcomeSummary({ ...approval, status: 'approved', outcome: result.outcome });
          toast.success('Written to the workspace', text);
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
  const summary = pending ? null : outcomeSummary(approval);

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
        <div className="cp-approval__preview">
          {approval.preview.map((line, i) => <span key={i}>{line}</span>)}
        </div>

        {decide.error && (
          <Banner tone="danger" title="The decision was refused">{decide.error.body.message}</Banner>
        )}

        {summary && (
          <Banner tone={approval.status === 'approved' ? 'success' : 'neutral'} compact>
            {summary.text}
          </Banner>
        )}

        {approval.status === 'approved' && <WrittenTo approval={approval} />}

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
                iconLeft={<Icons.check size={13} />}
                onClick={() => { void decide.run('approve').catch(() => undefined); }}
              >
                Approve and run
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
  const written = approval.status === 'approved';
  const summary = outcomeSummary(approval);
  return (
    <div
      className={`cp-resolution${written ? ' is-written' : ''}`}
      data-approval={approval.id}
      tabIndex={-1}
      role="status"
      aria-label={`${written ? 'Approved and written' : 'Declined'}: ${summary.text}`}
    >
      <div className="cp-resolution__head">
        <Badge tone={written ? 'success' : 'neutral'} size="sm" icon={written ? <Icons.check size={11} /> : <Icons.shield size={11} />}>
          {written ? 'Approved and written' : 'Declined'}
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

export function ApprovalQueue({ approvals, onDecided }: { approvals: AiApproval[]; onDecided?: () => void }) {
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
      {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onDecided={onDecided} />)}
    </div>
  );
}

/* --------------------------------- run bits ------------------------------- */

/**
 * The engine's confidence is in its *reading of the question*, not in the
 * answer — so the chip says so. Labelling it "90% confident" beside a refusal
 * is the one place this surface could be read as claiming something it never
 * measured, which is why a refused run shows no badge at all.
 */
export function ConfidenceBadge({ run, refused }: { run: AiRun; refused?: boolean }) {
  if (run.confidence === null || refused) return null;
  const band = confidenceBand(run.confidence);
  const percent = Math.round(run.confidence * 100);
  return (
    <Badge
      size="sm"
      tone={band === 'high' ? 'success' : band === 'medium' ? 'warning' : 'danger'}
      title={`The engine was ${percent}% sure it read this as a ${humanize(run.intent ?? 'question').toLowerCase()} question. It is not a claim about the answer.`}
    >
      question read at {percent}%
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
    { label: 'Intent', value: run.intent ? humanize(run.intent) : '—', hint: run.confidence === null ? undefined : `question read at ${Math.round(run.confidence * 100)}%` },
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
