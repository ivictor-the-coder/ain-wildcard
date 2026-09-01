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
  CITATION_ICON, SPAN_ICON, SPAN_TONE, citationHref, confidenceBand,
  type AiApproval, type AiRun, type AiSpan, type Citation,
} from './api';

/* ------------------------------- citations -------------------------------- */

export function CitationChips({ citations, label = 'Sources' }: { citations: Citation[]; label?: string }) {
  const { navigate } = useRouter();
  if (!citations.length) return null;
  return (
    <div className="cp-chips">
      <span className="cp-chips__label">{label}</span>
      {citations.map((citation) => {
        const href = citationHref(citation);
        const Glyph = iconByName(CITATION_ICON[citation.type] ?? 'link');
        return (
          <button
            key={`${citation.type}:${citation.id}`}
            type="button"
            className="cp-chip"
            disabled={!href}
            title={href ? `Open ${citation.label} (${citation.id})` : `${citation.label} — ${citation.id} has no screen in this workspace`}
            onClick={() => { if (href) navigate(href); }}
          >
            <Glyph size={12} />
            <span className="u-truncate">{citation.label}</span>
            <span className="cp-chip__type">{humanize(citation.type)}</span>
          </button>
        );
      })}
    </div>
  );
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

export function TraceSteps({ spans }: { spans: AiSpan[] }) {
  if (!spans.length) {
    return <p className="cp-note">This run recorded no steps — nothing was planned and no tool was called.</p>;
  }
  const slowest = spans.reduce((top, span) => Math.max(top, span.duration_ms), 0);
  return (
    <div className="cp-steps">
      {spans.map((span) => <Step key={span.id} span={span} slowest={slowest} />)}
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
          toast.success(`${approval.tool} ran`, result.outcome ?? 'The write landed.');
        } else {
          toast.info('Declined', `${approval.tool} was not run. Nothing changed.`);
        }
        onDecided?.();
      },
      onError: (e) => toast.error('The decision was refused', e.body.message),
    },
  );

  const pending = approval.status === 'pending';

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

        {!pending && approval.outcome && (
          <Banner tone={approval.status === 'approved' ? 'success' : 'neutral'} compact>
            {approval.outcome}
          </Banner>
        )}

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

        {showArgs && <pre className="cp-code">{pretty(approval.args)}</pre>}
      </div>
    </Card>
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

export function RunFacts({ run, toolMs }: { run: AiRun; toolMs?: number }) {
  const f = useFormat();
  const facts: { label: string; value: string; hint?: string }[] = [
    { label: 'Outcome', value: humanize(run.status), hint: run.error ?? undefined },
    { label: 'Answered by', value: run.model, hint: humanize(run.provider) },
    { label: 'Intent', value: run.intent ? humanize(run.intent) : '—', hint: run.confidence === null ? undefined : `question read at ${Math.round(run.confidence * 100)}%` },
    { label: 'Duration', value: `${f.number(run.duration_ms)} ms`, hint: toolMs === undefined ? `${f.plural(run.steps, 'step')}` : `${f.number(toolMs)} ms in tools` },
    { label: 'Tokens', value: f.number(run.usage.input_tokens + run.usage.output_tokens), hint: `${f.number(run.usage.input_tokens)} in · ${f.number(run.usage.output_tokens)} out` },
    {
      label: 'Cost',
      value: run.usage.cost_micros > 0 ? f.money(run.usage.cost_cents) : 'No marginal cost',
      hint: `${f.plural(run.usage.credits, 'credit')} charged`,
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
