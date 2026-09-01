/**
 * The AI engine's public shapes, and the reads the copilot surface makes.
 *
 * Every claim this UI renders — the answer, the citations, the steps, the token
 * count, the confidence — is a field the engine wrote when the run happened.
 * Nothing here re-derives a number the server did not already publish.
 */
import { useMemo } from 'react';
import { useQuery, type ApiClientError, type ListEnvelope, type QueryResult } from '@/client/kernel/api';

export interface Citation { id: string; label: string; type: string }

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

export const useApprovals = (status = 'pending'): QueryResult<ListEnvelope<AiApproval>> =>
  useQuery<ListEnvelope<AiApproval>>('/v1/ai/approvals', { status });

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
export type RunOutcome = 'succeeded' | 'failed' | 'running' | 'needs_approval' | 'written' | 'declined';

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  running: 'Running',
  needs_approval: 'Needs approval',
  written: 'Approved and written',
  declined: 'Declined',
};

export const OUTCOME_TONE: Record<RunOutcome, 'success' | 'danger' | 'warning' | 'info' | 'neutral'> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'info',
  needs_approval: 'warning',
  written: 'success',
  declined: 'neutral',
};

export function runOutcome(run: { status: string }, approvals: AiApproval[] | undefined): RunOutcome {
  const rows = approvals ?? [];
  if (rows.some((a) => a.status === 'pending')) return 'needs_approval';
  // The engine resolves a run to `succeeded` once an approved write executes,
  // but leaves a declined one on `needs_approval` for ever. Either way the
  // approvals are the record of what a person actually decided.
  if (rows.some((a) => a.status === 'approved')) return run.status === 'failed' ? 'failed' : 'written';
  if (rows.length && run.status === 'needs_approval') return 'declined';
  return (['succeeded', 'failed', 'running', 'needs_approval'] as const).includes(run.status as never)
    ? (run.status as RunOutcome)
    : 'succeeded';
}

/* ------------------------- what a write actually did ---------------------- */

const ID_PREFIX: Record<string, string> = { cmp: 'company', con: 'contact', deal: 'deal', tkt: 'ticket' };

/** The records a queued write names, so the conversation can link to them. */
export function writeTargets(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown) => { if (typeof value === 'string' && value) out.push(value); };
  for (const key of ['record_id', 'id', 'contact_id', 'company_id']) push(args[key]);
  for (const key of ['record_ids', 'associate_to']) {
    const value = args[key];
    if (Array.isArray(value)) for (const entry of value) push(entry);
  }
  return [...new Set(out)].filter((id) => ID_PREFIX[id.split('_')[0]]);
}

export function recordLink(id: string): { type: string; href: string } | null {
  const type = ID_PREFIX[id.split('_')[0]];
  if (!type) return null;
  return { type, href: citationHref({ id, label: id, type }) ?? `/records/${type}/${encodeURIComponent(id)}` };
}

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

export const useTools = (): QueryResult<ListEnvelope<AiTool>> => useQuery<ListEnvelope<AiTool>>('/v1/ai/tools');

/* -------------------------------- helpers -------------------------------- */

/** Where a cited record lives in this product, or null when nothing shows it. */
export function citationHref(citation: Citation): string | null {
  switch (citation.type) {
    case 'deal': return `/deals/${encodeURIComponent(citation.id)}`;
    case 'company':
    case 'customer_company': return `/companies/${encodeURIComponent(citation.id)}`;
    case 'contact': return `/contacts/${encodeURIComponent(citation.id)}`;
    case 'ticket': return `/records/ticket/${encodeURIComponent(citation.id)}`;
    case 'customer': return `/customers/${encodeURIComponent(citation.id)}`;
    case 'invoice': return `/invoices/${encodeURIComponent(citation.id)}`;
    case 'subscription': return `/subscriptions/${encodeURIComponent(citation.id)}`;
    default: return citation.id.startsWith('cmp_') ? `/companies/${encodeURIComponent(citation.id)}` : null;
  }
}

export const CITATION_ICON: Record<string, string> = {
  deal: 'deals',
  company: 'building',
  contact: 'user',
  ticket: 'tickets',
  customer: 'wallet',
  invoice: 'invoice',
  subscription: 'repeat',
  meter: 'gauge',
  price: 'tag',
  product: 'tag',
};

/**
 * A refusal, in the engine's own words.
 *
 * The reasoning trail is where the engine records that it declined to measure
 * something — `Refused (period_unresolved): …`. Surfacing it is the difference
 * between an honest "I did not answer that" and a confident-looking paragraph
 * that happens to contain no numbers.
 */
export function refusalOf(run: AiRun | undefined | null): { code: string; message: string } | null {
  for (const line of run?.reasoning ?? []) {
    const match = /^Refused \(([a-z_]+)\):\s*(.+)$/.exec(line);
    if (match) return { code: match[1], message: match[2] };
  }
  return null;
}

export type ConfidenceBand = 'high' | 'medium' | 'low';

export const confidenceBand = (confidence: number | null): ConfidenceBand =>
  confidence === null ? 'low' : confidence >= 0.8 ? 'high' : confidence >= 0.55 ? 'medium' : 'low';

/** Assistant prose arrives as paragraphs, some of them bullet lists. */
export interface Block { kind: 'text' | 'list'; lines: string[] }

export function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of content.split(/\n{2,}/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    const bullets = lines.filter((line) => /^[•\-*]\s+/.test(line.trim()));
    if (bullets.length && bullets.length === lines.length) {
      blocks.push({ kind: 'list', lines: lines.map((line) => line.trim().replace(/^[•\-*]\s+/, '')) });
    } else {
      blocks.push({ kind: 'text', lines });
    }
  }
  return blocks;
}

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
