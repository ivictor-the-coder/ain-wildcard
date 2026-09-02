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
import { propertyVocabulary } from './scope-core';
import type { Vocabulary } from './scope-core';
import type { Citation } from './citations';

export { CITATION_ICON, citationHref, dedupeCitations, recordLink, writeTargetLabel, writeTargets } from './citations';
export type { Citation } from './citations';

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

export interface AiSuggestion { object: 'ai_suggestion'; question: string; why: string; intent: string }

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

export interface AiReply {
  object: 'ai_reply';
  thread_id: string;
  run_id: string;
  message: AiMessage;
  citations: Citation[];
  reasoning: string[];
  pending_approvals: { tool: string; args: Record<string, unknown>; reason: string }[];
  usage: { input_tokens: number; output_tokens: number; credits: number };
}

/* --------------------------------- reads --------------------------------- */

export const useThreads = (status: string): QueryResult<ListEnvelope<AiThread>> =>
  useQuery<ListEnvelope<AiThread>>('/v1/ai/threads', { limit: 50, ...(status ? { status } : {}) });

export const useThread = (id: string | null): QueryResult<ThreadDetail> =>
  useQuery<ThreadDetail>(id ? `/v1/ai/threads/${encodeURIComponent(id)}` : null);

export const useRun = (id: string | null, enabled = true): QueryResult<RunDetail> =>
  useQuery<RunDetail>(id ? `/v1/ai/runs/${encodeURIComponent(id)}` : null, undefined, { enabled });

export const useSuggestions = (): QueryResult<ListEnvelope<AiSuggestion>> =>
  useQuery<ListEnvelope<AiSuggestion>>('/v1/ai/suggestions');

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
  'succeeded' | 'failed' | 'running' | 'needs_approval' | 'written' | 'declined' | 'refused';

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  running: 'Running',
  needs_approval: 'Needs approval',
  written: 'Approved and written',
  declined: 'Declined',
  refused: 'Refused',
};

export const OUTCOME_TONE: Record<RunOutcome, 'success' | 'danger' | 'warning' | 'info' | 'neutral'> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'info',
  needs_approval: 'warning',
  written: 'success',
  declined: 'neutral',
  refused: 'warning',
};

/** What became of one approved write. */
export type WriteOutcome = 'pending' | 'declined' | 'written' | 'failed';

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
  tone: 'success' | 'danger' | 'neutral';
} {
  const outcomes = approvals.map(approvalOutcome);
  if (outcomes.includes('failed')) return { label: 'decided — the write failed', tone: 'danger' };
  if (outcomes.includes('written')) return { label: 'decided — written', tone: 'success' };
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
  if (rows.some((a) => a.status === 'approved')) return run.status === 'failed' ? 'failed' : 'written';
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
 * The tool's return value, in the same English the approval card speaks.
 *
 * The engine hands back a wire line — `object=record id=note_… display_name=…` —
 * which is the right thing for a debugger and the wrong thing for the sentence a
 * person reads after pressing Approve. The wire line stays, under the trace.
 */
export function outcomeSummary(approval: AiApproval): { text: string; raw: string | null } {
  const raw = approval.outcome;
  if (!raw) {
    return { text: approval.status === 'declined' ? 'Nothing was written.' : 'The write landed.', raw: null };
  }
  const fields = keyValues(raw);
  if (!fields) return { text: raw, raw: null };
  const headline = approval.preview[0] ?? `${humanTool(approval.tool)} ran`;
  const name = fields.display_name;
  const kind = fields.object_type ? fields.object_type.replace(/_/g, ' ') : 'record';
  return {
    text: name ? `${headline} — the ${kind} “${name}” is on the record.` : `${headline} — written.`,
    raw,
  };
}

export const humanTool = (tool: string): string => {
  const words = tool.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const useAiStatus = (): QueryResult<AiStatus> => useQuery<AiStatus>('/v1/ai/status');

export interface AiUsageBucket { key: string; runs: number; credits: number }
export interface AiUsageReport {
  object: 'ai_usage';
  totals: { runs: number; credits: number; input_tokens: number; output_tokens: number };
  by_feature: AiUsageBucket[];
  by_model: AiUsageBucket[];
}

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
interface PropertyPayload {
  name: string;
  label: string;
  type: string;
  options: { value: string; label: string }[] | null;
}

/**
 * The words this workspace uses for the things a question can narrow to.
 *
 * Three reads the copilot did not make before — the deal pipelines with their
 * stages, the teammates, and the platform's own metric catalogue — because
 * checking that an answer was measured over what was asked for is impossible
 * without knowing what "Renewal", "Negotiation", "Marcus Ilori" and "weighted
 * pipeline" name here. All three are small, cached by the query layer and
 * shared with the board, so the conversation pays for them once.
 */
export interface VocabularyRead {
  vocab: Vocabulary;
  loading: boolean;
  /** The reads every chip depends on failed: nothing below is checked. */
  error: ApiClientError | null;
  /** A narrower read failed: the dimensions it carries were not checked. */
  partial: string[];
}

export function useVocabulary(): VocabularyRead {
  const pipelines = useQuery<ListEnvelope<PipelinePayload>>('/v1/pipelines/deal');
  const users = useQuery<ListEnvelope<UserPayload>>('/v1/users', { limit: 100 });
  const metrics = useQuery<ListEnvelope<MetricPayload>>('/v1/ai/metrics');
  // The pipelines this engine cannot measure over, so an answer that says one
  // of them does not exist can be contradicted with the workspace's own data.
  const tickets = useQuery<ListEnvelope<PipelinePayload>>('/v1/pipelines/ticket');
  // The CRM's own enumerated properties — lead source, deal type, competitor,
  // forecast category. Without them a question can name a dimension the
  // qualifier ledger has no slot for, and "How many open deals came from a
  // trade show?" is answered 38 against a true 7 with the words "trade show"
  // appearing nowhere on the card.
  const properties = useQuery<ListEnvelope<PropertyPayload>>('/v1/objects/deal/properties');
  // Every read, for the wait. A check that has not run is not a check, and the
  // ticket pipelines and the enumerated properties are what let this surface
  // contradict "no pipeline is called Support" and "38 open deals" over a
  // question about a trade show. Waiting for them costs a moment.
  const loading = pipelines.loading || users.loading || metrics.loading
    || tickets.loading || properties.loading;
  // Only the three the whole scope row is drawn from, for the failure. Without
  // pipelines, teammates or measures there is nothing true to say about any
  // answer; without the ticket pipelines there is nothing true to say about one
  // narrow class of question, and blanking every chip on the card over that
  // would be a second, wider, silence.
  const error = pipelines.error ?? users.error ?? metrics.error;
  const vocab = useMemo<Vocabulary>(() => {
    const deal = (pipelines.data?.data ?? []).map((pipeline) => ({
      name: pipeline.name,
      label: pipeline.label,
      stages: (pipeline.stages ?? []).map((stage) => ({
        pipeline: pipeline.name,
        pipelineLabel: pipeline.label,
        name: stage.name,
        label: stage.label,
        isClosed: stage.is_closed,
        isWon: stage.is_won,
        // What the column restamps on a deal that lands in it. The approval
        // card states the forecast a write moves, and it cannot do that from
        // the write's own arguments — they carry one stage name.
        probability: stage.probability ?? null,
        forecastCategory: stage.forecast_category ?? null,
      })),
    }));
    const catalogue = (metrics.data?.data ?? []).map((metric) => ({
      id: metric.id, label: metric.label, unit: metric.unit, keywords: metric.keywords ?? [], snapshot: !!metric.snapshot,
    }));
    return {
      pipelines: deal,
      people: (users.data?.data ?? []).map((user) => ({ id: user.id, name: user.name })),
      metrics: catalogue,
      otherPipelines: (tickets.data?.data ?? []).map((pipeline) => ({
        name: pipeline.name, label: pipeline.label, objectType: 'ticket',
      })),
      properties: propertyVocabulary(
        (properties.data?.data ?? [])
          .filter((property) => property.type === 'enum')
          .map((property) => ({ name: property.name, label: property.label, options: property.options ?? [] })),
        deal,
        catalogue,
      ),
    };
  }, [pipelines.data, users.data, metrics.data, tickets.data, properties.data]);
  const partial = useMemo(() => [
    ...(tickets.error ? ['the pipelines that hold tickets'] : []),
    ...(properties.error ? ['this workspace’s own record properties'] : []),
  ], [tickets.error, properties.error]);
  return { vocab, loading, error, partial };
}

/* -------------------------------- helpers -------------------------------- */


export {
  carriedScope, confidenceBand, confidenceChip, contradictsCarried, noWritePrepared, parseBlocks,
  propertyAsked, refusalOf, splitToolEcho,
} from './answer-core';
export type { Block, CarriedScope, ConfidenceBand, StepNote, ToolEcho } from './answer-core';

export {
  consequenceLines, dealNamedIn, editHref, linkedTargetOf, needsAcknowledgement, stageConsequences,
  stageWriteOf, statusOfStage,
} from './write-core';
export type { Consequence, DealNow, StageConsequences, StageWrite } from './write-core';

export {
  EMPTY_VOCABULARY, MONEY_TOTAL, QUALIFIER_KINDS, UNMEASURED, agreeWithTheCount, boardHref, boundScopeOf,
  carriedThrough, correctPipelineDenial, correctedProse,
  countedObject, currencyAsked, currencyOfFigure, figureSpeaks, figureUnits, groupAsked, humanizeName,
  isWiderName, labelOfPipeline, labelOfStage, lastInstantOf, looksLikeRecordId, measurementsOf,
  metricAsked, metricsMeasured, misreadRefusal, namedQualifiers, openStagesOf, parseBreakdown,
  parseLedger, refusalDisprovedByThread,
  inventedFilters, propertyVocabulary, reconcileBreakdown,
  deniedPipeline, reconcileScope, recordPhraseMismatch, rephraseAsBreakdown, scopeChips, unknownMeasure,
  warningSentence, windowText, withoutCurrencyClaim, withoutRefusedQualifier, withoutWriteParameter,
  withoutBreakdown,
} from './scope-core';
export type {
  BoundScope, BreakdownBucket, BreakdownReport, BucketVerdict, DisprovedRefusal, Evidence,
  InventedFilter, LedgerEntry, Measurement, MisreadRefusal,
  NamedQualifier, QualifierKind, QualifierState, QualifierVerdict, RecordMismatch, ScopeChip,
  ScopeReport, VocabMetric, VocabOtherPipeline, VocabPipeline, VocabPropertyDef, VocabPropertyValue,
  VocabStage, Vocabulary, WindowFormat,
} from './scope-core';

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
