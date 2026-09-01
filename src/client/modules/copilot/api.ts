/**
 * The AI engine's public shapes, and the reads the copilot surface makes.
 *
 * Every claim this UI renders — the answer, the citations, the steps, the token
 * count, the confidence — is a field the engine wrote when the run happened.
 * Nothing here re-derives a number the server did not already publish.
 */
import { useQuery, type ListEnvelope, type QueryResult } from '@/client/kernel/api';

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
