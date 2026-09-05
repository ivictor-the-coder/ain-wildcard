/**
 * The AI engine's public shapes, and the reads the copilot surface makes.
 *
 * Every claim this UI renders — the answer, the citations, the steps, the token
 * count, the confidence — is a field the engine wrote when the run happened.
 * Nothing here re-derives a number the server did not already publish.
 */
import { useMemo } from 'react';
import { useQuery, type ApiClientError, type ListEnvelope, type QueryResult } from '@/client/kernel/api';
import { refusalOf } from './answer-core';
import type { Vocabulary } from './scope-core';
import { recordLink, writeTargetLabel, type Citation } from './citations';
import type { AiTemplate, Engine, NearestOnWire } from './templates-core';

export {
  CITATION_ICON, citationHref, citationResolution, dedupeCitations, needsProbe, recordLink, writeTargetLabel, writeTargets,
} from './citations';
export type { Citation, CitationProbe, CitationResolution } from './citations';

export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }

export interface AiMessage {
  object: 'ai_message';
  id: string;
  thread_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls: ToolCall[];
  citations: Citation[];
  run_id: string | null;
  actor_id: string | null;
  created: number;
}

export interface AiThread {
  object: 'ai_thread';
  id: string;
  title: string;
  feature: string;
  status: 'open' | 'archived' | string;
  subject: { id: string; type: string | null } | null;
  created_by: string | null;
  message_count: number;
  last_message_at: number | null;
  created: number;
  updated: number;
}

export interface AiSpan {
  object: 'ai_span';
  id: string;
  run_id: string;
  seq: number;
  kind: 'tool' | 'plan' | 'resolve' | 'synthesis' | 'provider';
  name: string;
  args: Record<string, unknown>;
  summary: string;
  ok: boolean;
  error: { code: string; message: string } | null;
  started: number;
  duration_ms: number;
}

export interface AiUsage {
  input_tokens: number;
  output_tokens: number;
  credits: number;
  cost_cents: number;
  cost_micros: number;
}

export interface AiRun {
  object: 'ai_run';
  id: string;
  thread_id: string | null;
  feature: string;
  provider: string;
  model: string;
  status: 'running' | 'succeeded' | 'failed' | 'needs_approval' | string;
  actor_id: string | null;
  actor_type: string;
  question: string;
  answer: string | null;
  intent: string | null;
  confidence: number | null;
  reasoning: string[];
  citations: Citation[];
  steps: number;
  span_count: number;
  usage: AiUsage;
  error: string | null;
  started: number;
  finished: number | null;
  duration_ms: number;
  trace?: AiSpan[];
  /**
   * What the template engine records about a run, when it does. `provider`
   * and `model` are read when these are absent, so a run written by the old
   * engine still says which engine answered it.
   */
  engine?: Engine | null;
  nearest?: NearestOnWire[] | null;
  template?: unknown;
}

export interface AiApproval {
  object: 'ai_approval';
  id: string;
  run_id: string;
  thread_id: string | null;
  tool: string;
  args: Record<string, unknown>;
  /** The write in plain English, one line per fact. */
  preview: string[];
  reason: string;
  status: 'pending' | 'approved' | 'declined' | string;
  outcome: string | null;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created: number;
}

export interface RunDetail extends AiRun {
  trace: AiSpan[];
  approvals: AiApproval[];
  timings: { total_ms: number; tool_ms: number; slowest: AiSpan[] };
}

export interface ThreadDetail extends AiThread {
  messages: AiMessage[];
  runs: AiRun[];
}

export interface AiTool {
  object: 'ai_tool';
  name: string;
  description: string;
  read_only: boolean;
  requires_approval: boolean;
  tags: string[];
}

export interface AiStatus {
  object: 'ai_status';
  provider: { id: string; label: string; hosted: boolean };
  providers: { id: string; label: string; available: boolean }[];
  tools: number;
  metrics: number;
  runs_today: number;
  pending_approvals: number;
}

/**
 * `POST /v1/ai/complete`, as the conversation reads it.
 *
 * The one route that says which engine answered and, on a refusal, which
 * shapes come closest — so the conversation posts its turns here (with the
 * thread id, which makes the completion a turn of that thread) and remembers
 * `engine`, `nearest` and `template` by run id for the session.
 */
export interface AiCompletion {
  object: 'ai_completion';
  run_id: string;
  provider: string;
  model: string;
  content: string;
  finish_reason: string;
  engine?: Engine | null;
  nearest?: NearestOnWire[] | null;
  template?: unknown;
  /** The engine's working notes in structure; `qualifiers` lists every slot it bound. */
  analysis?: unknown;
  tool_calls: ToolCall[];
  citations: Citation[];
  reasoning: string[];
  pending_approvals: { tool: string; args: Record<string, unknown>; reason: string }[];
  usage: { input_tokens: number; output_tokens: number; credits: number; cost_cents: number };
  duration_ms: number;
}

export type { AiTemplate } from './templates-core';

/* --------------------------------- reads --------------------------------- */

export const useThreads = (status: string): QueryResult<ListEnvelope<AiThread>> =>
  useQuery<ListEnvelope<AiThread>>('/v1/ai/threads', { limit: 50, ...(status ? { status } : {}) });

export const useThread = (id: string | null): QueryResult<ThreadDetail> =>
  useQuery<ThreadDetail>(id ? `/v1/ai/threads/${encodeURIComponent(id)}` : null);

export const useRun = (id: string | null, enabled = true): QueryResult<RunDetail> =>
  useQuery<RunDetail>(id ? `/v1/ai/runs/${encodeURIComponent(id)}` : null, undefined, { enabled });

/** The whitelist: every question shape the built-in engine answers, with workspace values. */
export const useTemplates = (): QueryResult<ListEnvelope<AiTemplate>> =>
  useQuery<ListEnvelope<AiTemplate>>('/v1/ai/templates');

/**
 * The queue answers 50 rows unless asked otherwise, and this is the only read
 * of it: a conversation re-read next month has to find the write it approved,
 * and the approvals tab has to be the whole queue rather than its first page.
 * 200 is the server's own ceiling on this route.
 */
export const useApprovals = (status = 'pending'): QueryResult<ListEnvelope<AiApproval>> =>
  useQuery<ListEnvelope<AiApproval>>('/v1/ai/approvals', { status, limit: 200 });

/**
 * Every approval, whatever it was decided.
 *
 * `/v1/ai/approvals` answers one status at a time, and a conversation has to
 * show what happened to a write after it was decided — not only the ones still
 * waiting — so the three lists are read together and merged. Each is cached by
 * the query layer, so re-reading them after a decision costs one round trip.
 */
export interface ApprovalIndex {
  all: AiApproval[];
  byRun: Map<string, AiApproval[]>;
  loading: boolean;
  error: ApiClientError | null;
  refetch: () => void;
}

export function useAllApprovals(): ApprovalIndex {
  const pending = useApprovals('pending');
  const approved = useApprovals('approved');
  const declined = useApprovals('declined');
  return useMemo(() => {
    const all = [
      ...(pending.data?.data ?? []),
      ...(approved.data?.data ?? []),
      ...(declined.data?.data ?? []),
    ].sort((a, b) => a.created - b.created);
    const byRun = new Map<string, AiApproval[]>();
    for (const approval of all) {
      const list = byRun.get(approval.run_id) ?? [];
      list.push(approval);
      byRun.set(approval.run_id, list);
    }
    return {
      all,
      byRun,
      loading: pending.loading || approved.loading || declined.loading,
      error: pending.error ?? approved.error ?? declined.error,
      refetch: () => { pending.refetch(); approved.refetch(); declined.refetch(); },
    };
  }, [pending, approved, declined]);
}

/**
 * What a run really ended as.
 *
 * The engine writes `needs_approval` when it stops for a person and never
 * revisits it, so a run whose write was declined an hour ago still reads as
 * waiting — and the "Needs approval" filter, which is exactly the queue a person
 * scans for work, never drains. The approvals themselves know the answer.
 */
export type RunOutcome =
  'succeeded' | 'failed' | 'running' | 'needs_approval' | 'written' | 'scheduled' | 'declined' | 'refused';

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  running: 'Running',
  needs_approval: 'Needs approval',
  written: 'Approved and written',
  scheduled: 'Approved and scheduled',
  declined: 'Declined',
  refused: 'Refused',
};

export const OUTCOME_TONE: Record<RunOutcome, 'success' | 'danger' | 'warning' | 'info' | 'neutral'> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'info',
  needs_approval: 'warning',
  written: 'success',
  scheduled: 'info',
  declined: 'neutral',
  refused: 'warning',
};

/**
 * What became of one approved write.
 *
 * `scheduled` is the one that is neither written nor pending: the tool booked
 * a job and the record itself is untouched until the job fires. A follow-up
 * approved today is a note that lands next week, and calling it "written"
 * sent people to a timeline with nothing on it.
 */
export type WriteOutcome = 'pending' | 'declined' | 'written' | 'scheduled' | 'failed';

/** The booking a `schedule_followup` write made, read off the tool's own return line. */
export interface ScheduledFollowup {
  recordId: string | null;
  /** When the note lands, as the engine stamped it. */
  due: number;
  note: string;
}

/**
 * The follow-up an approved write booked, or null for every other write.
 *
 * `scheduled=true record_id=cmp_nw_42 due=1789219881805 note=Chase the MSA.
 * idempotency_key=…` is the whole of what the tool hands back, and every fact
 * the resolution card can state — the day, the record, the words — is in it.
 */
export function scheduledFollowup(approval: Pick<AiApproval, 'status' | 'outcome'>): ScheduledFollowup | null {
  if (approval.status !== 'approved' || !approval.outcome) return null;
  const fields = keyValues(approval.outcome);
  if (!fields || fields.scheduled !== 'true') return null;
  const due = Number(fields.due);
  if (!Number.isFinite(due) || due <= 0) return null;
  return { recordId: fields.record_id ?? null, due, note: (fields.note ?? '').trim() };
}

const FAILED_OUTCOME = /^\s*(?:failed|error)\b/i;

/**
 * Whether an approved write actually landed.
 *
 * The first wrong-target attempt in the critic's run — `commercial_terms` on a
 * New business deal — came back `Failed: "commercial_terms" belongs to the
 * Renewal pipeline`, and the card carried a green "Approved and written" badge
 * and a "WRITTEN TO deal_nw_15" link above that sentence. Nothing was written.
 * `status` records the decision a person made; `outcome` records what the tool
 * did with it, and only the second one can say whether the workspace changed.
 */
export function approvalOutcome(approval: Pick<AiApproval, 'status' | 'outcome'>): WriteOutcome {
  if (approval.status === 'pending') return 'pending';
  if (approval.status !== 'approved') return 'declined';
  if (!approval.outcome) return 'written';
  if (scheduledFollowup(approval)) return 'scheduled';
  // A landed write hands back its own row — `object=record id=note_… …`. A
  // failure hands back a sentence, and it starts by saying so.
  return keyValues(approval.outcome) ? 'written' : (FAILED_OUTCOME.test(approval.outcome) ? 'failed' : 'written');
}

/**
 * The badge on a turn whose write has been decided.
 *
 * It read the *decision* — `status === 'approved'` — and stamped a green
 * "decided — written" on a write the tool then refused: `Failed:
 * "commercial_terms" belongs to the Renewal pipeline, not New business.` The
 * resolution block three lines below said so correctly, and the badge above it
 * said the opposite. What the tool did is the only thing that says whether the
 * workspace changed.
 */
export function decidedBadge(approvals: Pick<AiApproval, 'status' | 'outcome'>[]): {
  label: string;
  tone: 'success' | 'danger' | 'neutral' | 'info';
} {
  const outcomes = approvals.map(approvalOutcome);
  if (outcomes.includes('failed')) return { label: 'decided — the write failed', tone: 'danger' };
  if (outcomes.includes('written')) return { label: 'decided — written', tone: 'success' };
  if (outcomes.includes('scheduled')) return { label: 'decided — scheduled', tone: 'info' };
  return { label: 'decided — declined', tone: 'neutral' };
}

export function runOutcome(
  run: { status: string; reasoning?: string[] },
  approvals: AiApproval[] | undefined,
): RunOutcome {
  const rows = approvals ?? [];
  if (rows.some((a) => a.status === 'pending')) return 'needs_approval';
  // The engine resolves a run to `succeeded` once an approved write executes,
  // but leaves a declined one on `needs_approval` for ever. Either way the
  // approvals are the record of what a person actually decided.
  // An approved write whose tool refused it is not a written run, whatever the
  // run's own status says: the workspace did not change.
  if (rows.some((a) => approvalOutcome(a) === 'failed')) return 'failed';
  if (rows.some((a) => a.status === 'approved')) {
    if (run.status === 'failed') return 'failed';
    // A run whose only approved write is a booking has changed nothing yet.
    return rows.some((a) => approvalOutcome(a) === 'written') ? 'written' : 'scheduled';
  }
  if (rows.length && run.status === 'needs_approval') return 'declined';
  if (run.status === 'failed' || run.status === 'running') return run.status;
  // A run that answered nothing is stamped `succeeded` all the same. The engine
  // writes `Refused (qualifier_unbound): …` into its own reasoning trail and
  // the conversation renders it as a refusal — but the run log counted it as a
  // success, so the one number that says whether this engine is answering
  // questions could not be read off the surface built to report on it.
  if (refusalOf(run)) return 'refused';
  return (['succeeded', 'needs_approval'] as const).includes(run.status as never)
    ? (run.status as RunOutcome)
    : 'succeeded';
}

/* ------------------------- what a write actually did ---------------------- */

/** `object=record id=note_x display_name=A note` → the pairs, or null for prose. */
export function keyValues(text: string): Record<string, string> | null {
  if (!/^[a-z_]+=/.test(text.trim())) return null;
  const out: Record<string, string> = {};
  for (const match of text.matchAll(/([a-z_]+)=(.*?)(?=\s+[a-z_]+=|$)/g)) out[match[1]] = match[2].trim();
  return Object.keys(out).length ? out : null;
}

/**
 * The words around an outcome that only the screen knows.
 *
 * The engine's line names a timestamp and user ids; the sentence a person
 * reads needs the day in the workspace's calendar and the people by name —
 * or as "you", when the reader is the one who pressed the button.
 */
export interface OutcomeContext {
  /** A timestamp as the workspace writes a day — “Sep 12, 2026 (in 7 days)”. */
  when?: (ts: number) => string;
  /** Who a follow-up is assigned to, already in the reader's terms; null when unknown. */
  assignee?: string | null;
  /** Who decided, in the reader's terms — “you” or a teammate's name; null when unknown. */
  decidedBy?: string | null;
  /** A stage's label in the pipeline vocabulary, for `Deal stage → negotiation`. */
  stage?: (name: string) => string | null;
}

/** The server's own stand-in for a name, written when the route was given no note. */
const DECLINED_BY_OPERATOR = /^Declined by an operator\.?$/i;

/**
 * Who made a decision, in the reader's own terms.
 *
 * `decided_by` is a user id. The person reading the card is usually the one
 * who pressed the button, so they are "you"; a teammate is named from the
 * workspace's roster; an id nobody on the roster carries — a key holder who
 * has since left — is nobody this can name.
 */
export function decidedByWords(
  decidedBy: string | null | undefined,
  meId: string | null | undefined,
  people: readonly { id: string; name: string }[],
): string | null {
  if (!decidedBy) return null;
  if (meId && decidedBy === meId) return 'you';
  return people.find((person) => person.id === decidedBy)?.name ?? null;
}

/**
 * The tool's return value, in the same English the approval card speaks.
 *
 * The engine hands back a wire line — `object=record id=note_… display_name=…` —
 * which is the right thing for a debugger and the wrong thing for the sentence a
 * person reads after pressing Approve. The wire line stays, under the trace.
 */
export function outcomeSummary(approval: AiApproval, ctx: OutcomeContext = {}): { text: string; raw: string | null } {
  const raw = approval.outcome;
  if (!raw) {
    return { text: approval.status === 'declined' ? 'Nothing was written.' : 'The write landed.', raw: null };
  }
  // The route writes "Declined by an operator." when it is handed no note. Dana
  // declined it, and the card can say so: the decision carries her id.
  if (approval.status === 'declined' && DECLINED_BY_OPERATOR.test(raw.trim())) {
    return { text: `Declined by ${ctx.decidedBy ?? 'an operator'}. Nothing was written.`, raw: null };
  }
  const fields = keyValues(raw);
  if (!fields) return { text: raw, raw: null };
  const headline = approval.preview[0] ?? `${humanTool(approval.tool)} ran`;
  // A booking, not a write. The badge above says "scheduled"; the sentence has
  // to say what a person opening the record today will and will not find.
  const booked = scheduledFollowup(approval);
  if (booked) {
    const target = writeTargetLabel(approval.tool, approval.args, approval.preview) ?? 'the record';
    const day = ctx.when ? ctx.when(booked.due) : new Date(booked.due).toISOString().slice(0, 10);
    const assigned = ctx.assignee ? `, assigned to ${ctx.assignee}` : '';
    const quoted = booked.note ? ` “${booked.note}”` : '';
    return {
      text: `${headline} is booked for ${day}${assigned}. Nothing is on ${target}’s timeline yet: the note${quoted} is written there when it comes due.`,
      raw,
    };
  }
  const name = fields.display_name;
  const kind = fields.object_type ? fields.object_type.replace(/_/g, ' ') : 'record';
  // A property write is not a record put on the record: what a person approved
  // is a change, and the sentence after it says which change landed where —
  // "Deal stage → Negotiation on Aconcagua Alimentos — pilot expansion to 3
  // lines", not the note's sentence with a deal name in it.
  const changes = propertyChanges(approval.preview, ctx.stage);
  if (approval.tool === 'update_record' && changes.length) {
    const target = name ?? writeTargetLabel(approval.tool, approval.args, approval.preview) ?? 'the record';
    return { text: `${changes.join('; ')} on ${target}.`, raw };
  }
  return {
    text: name ? `${headline} — the ${kind} “${name}” is on the record.` : `${headline} — written.`,
    raw,
  };
}

/**
 * The `Property → value` lines of a preview, with the value written for a person.
 *
 * A stage is looked up in the pipeline vocabulary when the caller has one —
 * `proposal` is "Proposal sent" on this board, which no amount of capitalising
 * the id would tell you — and humanised when it does not.
 */
export function propertyChanges(preview: readonly string[], stage?: (name: string) => string | null): string[] {
  const out: string[] = [];
  for (const line of preview) {
    const match = /^(.+?)\s*→\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    const property = match[1].trim();
    const value = match[2].trim();
    const isId = /^[a-z][a-z0-9_]*$/.test(value);
    const labelled = isId && /stage/i.test(property) && stage ? stage(value) : null;
    const spoken = labelled ?? (isId ? humanTool(value) : value);
    out.push(`${property} → ${spoken}`);
  }
  return out;
}

export const humanTool = (tool: string): string => {
  const words = tool.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * The engine's reason for stopping, with the tool named as a person names it.
 *
 * "add_note changes workspace data, so a person approves it before it runs."
 * opened every approval card with an identifier. The wire name stays under
 * "Show the exact arguments", where the arguments are.
 */
export function humanReason(reason: string, tool: string): string {
  if (!tool) return reason;
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return reason.replace(new RegExp(`(^|[^a-z0-9_])${escaped}(?![a-z0-9_])`, 'g'), (_match, before: string) => `${before}${humanTool(tool)}`);
}

/**
 * The name on a "Written to" chip.
 *
 * The chip read the record's name off "Note on <name>" and nothing else, so an
 * approved stage change linked to `deal_nw_71 · Deal`. The approval card
 * already knows how to read every preview shape it draws; the chip reads the
 * same way. With more than one target no name can be matched to an id, and
 * the id stands rather than a wrong name.
 */
export function writtenToLabel(
  approval: Pick<AiApproval, 'tool' | 'args' | 'preview'>,
  id: string,
  targets: number,
): string {
  if (targets !== 1) return id;
  return writeTargetLabel(approval.tool, approval.args, approval.preview)
    ?? / on (.+)$/.exec(approval.preview[0] ?? '')?.[1]
    ?? id;
}

export const useAiStatus = (): QueryResult<AiStatus> => useQuery<AiStatus>('/v1/ai/status');

export interface AiUsageBucket {
  key: string;
  runs: number;
  credits: number;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  cost_cents: number;
  cost_micros: number;
  /** Only on `by_user`: the teammate's name, or "System" for agent runs. */
  name?: string;
}
export interface AiUsageReport {
  object: 'ai_usage';
  period: { days: number; since: string; until: string };
  totals: {
    runs: number;
    credits: number;
    input_tokens: number;
    output_tokens: number;
    tool_calls: number;
    cost_cents: number;
    cost_micros: number;
  };
  by_day: AiUsageBucket[];
  by_feature: AiUsageBucket[];
  by_user: AiUsageBucket[];
  by_model: AiUsageBucket[];
}

/** Credits by day, feature, user and model over the last `days` days — the whole log, not the page in view. */
export const useAiUsage = (days: number): QueryResult<AiUsageReport> =>
  useQuery<AiUsageReport>('/v1/ai/usage', { days });

/**
 * Every feature the engine has run for, whatever the run log is filtered to.
 *
 * The feature menu used to be built from the rows on screen — which the server
 * had already filtered by feature — so choosing "agent" left "agent" as the
 * only option in the menu that chose it, and the way back to any other feature
 * was gone. `/v1/ai/usage` counts runs by feature independently of the list, so
 * the menu keeps every choice it started with.
 */
export const useFeatureCatalogue = (days = 365): QueryResult<AiUsageReport> =>
  useQuery<AiUsageReport>('/v1/ai/usage', { days });

export const useTools = (): QueryResult<ListEnvelope<AiTool>> => useQuery<ListEnvelope<AiTool>>('/v1/ai/tools');

/**
 * A record's display name, for an id the plan carried and nothing else knows.
 *
 * "What does Aconcagua Alimentos owe?" cites no record — the account owes
 * nothing, so there was no invoice to cite — and its ACCOUNT chip read
 * `cmp_nw_42`, because the chip's names come from the citations. One read of
 * the record itself is what turns the id back into the name that was typed.
 */
export function useRecordName(id: string | null): string | null {
  const link = id ? recordLink(id) : null;
  const read = useQuery<{ display_name?: string }>(
    link && id ? `/v1/records/${link.type}/${encodeURIComponent(id)}` : null,
  );
  return read.data?.display_name ?? null;
}

/* ------------------------------ the vocabulary ---------------------------- */

interface PipelinePayload {
  name: string;
  label: string;
  stages: {
    name: string;
    label: string;
    is_closed: boolean;
    is_won: boolean;
    probability?: number | null;
    forecast_category?: string | null;
  }[];
}
interface UserPayload { id: string; name: string }
interface MetricPayload { id: string; label: string; unit: string; keywords: string[]; snapshot: boolean }

/**
 * The words this workspace uses for the things a slot can be bound to.
 *
 * The pipelines with their stages, the teammates, and the metric catalogue:
 * what turns `owner_id: usr_seed02` into "Marcus Ilori" and `pipeline:
 * renewal` into "Renewal" on a slot chip, and what the approval card reads a
 * stage change's consequences from. All three are small, cached by the query
 * layer and shared with the board.
 */
export interface VocabularyRead {
  vocab: Vocabulary;
  loading: boolean;
  error: ApiClientError | null;
}

export function useVocabulary(): VocabularyRead {
  const pipelines = useQuery<ListEnvelope<PipelinePayload>>('/v1/pipelines/deal');
  const users = useQuery<ListEnvelope<UserPayload>>('/v1/users', { limit: 100 });
  const metrics = useQuery<ListEnvelope<MetricPayload>>('/v1/ai/metrics');
  const loading = pipelines.loading || users.loading || metrics.loading;
  const error = pipelines.error ?? users.error ?? metrics.error;
  const vocab = useMemo<Vocabulary>(() => ({
    pipelines: (pipelines.data?.data ?? []).map((pipeline) => ({
      name: pipeline.name,
      label: pipeline.label,
      stages: (pipeline.stages ?? []).map((stage) => ({
        pipeline: pipeline.name,
        pipelineLabel: pipeline.label,
        name: stage.name,
        label: stage.label,
        isClosed: stage.is_closed,
        isWon: stage.is_won,
        probability: stage.probability ?? null,
        forecastCategory: stage.forecast_category ?? null,
      })),
    })),
    people: (users.data?.data ?? []).map((user) => ({ id: user.id, name: user.name })),
    metrics: (metrics.data?.data ?? []).map((metric) => ({
      id: metric.id, label: metric.label, unit: metric.unit, keywords: metric.keywords ?? [], snapshot: !!metric.snapshot,
    })),
  }), [pipelines.data, users.data, metrics.data]);
  return { vocab, loading, error };
}

/* -------------------------------- helpers -------------------------------- */


export {
  confidenceBand, nearestFromReasoning, noWritePrepared, parseBlocks, propertyAsked, refusalOf, splitRefusalOffer,
  splitToolEcho, withoutApiInstruction, writeNeedsSwitch,
} from './answer-core';
export type { Block, ConfidenceBand, StepNote, ToolEcho } from './answer-core';

export {
  consequenceLines, dealNamedIn, editHref, linkedTargetOf, needsAcknowledgement, spokenPreview, stageConsequences,
  stageLabelIn, stageWriteOf, statusOfStage,
} from './write-core';
export type { Consequence, DealNow, StageConsequences, StageWrite } from './write-core';

/**
 * What is left of the scope machinery on the answer path: the two rules the
 * approval card uses to say a write was prepared against a sibling of the
 * record that was named. The reconciliation, the banners and the rephrasings
 * are unplugged — a template answer is scoped by construction.
 */
export { EMPTY_VOCABULARY, humanizeName, isWiderName, recordPhraseMismatch } from './scope-core';
export type { RecordMismatch, VocabMetric, VocabPipeline, VocabStage, Vocabulary } from './scope-core';

export { answerCard, nearestOf } from './card-core';
export type { AnswerCard, CardBanner, Refusal, Remembered, RunFacts } from './card-core';
export { numberAsked, rawRecordIds, slotChips, windowText } from './slots-core';
export { threadErrorCopy } from './thread-core';
export type { ThreadErrorCopy } from './thread-core';
export type { SlotChip, SlotFormat } from './slots-core';
export {
  MODEL_KEY_NOTE, MODEL_KEY_VAR, TEMPLATE_GROUPS, engineLine, engineOf, filterTemplates, groupTemplates,
  nearestTemplates, recordAsk, renderPattern, starterTemplates, templatesAbout,
} from './templates-core';
export type { Engine, EngineLine, NearestChip, NearestOnWire, RecordQuestion, TemplateGroup } from './templates-core';

export const SPAN_TONE: Record<AiSpan['kind'], 'brand' | 'info' | 'teal' | 'purple' | 'neutral'> = {
  plan: 'purple',
  resolve: 'teal',
  tool: 'brand',
  synthesis: 'info',
  provider: 'neutral',
};

export const SPAN_ICON: Record<AiSpan['kind'], string> = {
  plan: 'brain',
  resolve: 'search',
  tool: 'terminal',
  synthesis: 'sparkles',
  provider: 'cpu',
};
