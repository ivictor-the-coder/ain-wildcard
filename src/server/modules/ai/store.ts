/**
 * Persistence for runs, traces, threads, approvals and usage.
 *
 * The trace sink writes here on every single model call in the platform —
 * copilot, agents, workflows, scoring — so "what did the AI do, what did it
 * cost, and can I see the tool calls" has exactly one answer, whichever surface
 * asked the question.
 */
import type { Ctx } from '../../kernel/context';
import { parseJson } from '../../kernel/db';
import { describeWrite } from '../../ai/synth';
import { newId } from '../../../shared/ids';
import { dayKey } from '../../../shared/time';
import type { AiRunFinish, AiRunStart, AiTraceSpan, PendingApproval } from '../../ai/runtime';

export interface ThreadRow {
  id: string; org_id: string; title: string; feature: string; status: string;
  subject_type: string | null; subject_id: string | null; created_by: string | null;
  message_count: number; last_message_at: number | null; metadata: string;
  created: number; updated: number;
}

export interface MessageRow {
  id: string; org_id: string; thread_id: string; seq: number; role: string; content: string;
  tool_calls: string | null; citations: string | null; run_id: string | null;
  actor_id: string | null; created: number;
}

export interface RunRow {
  id: string; org_id: string; thread_id: string | null; feature: string; provider: string; model: string;
  actor_id: string | null; actor_type: string; status: string; question: string; answer: string;
  intent: string | null; confidence: number | null; reasoning: string; citations: string;
  steps: number; span_count: number; input_tokens: number; output_tokens: number;
  credits: number; cost_micros: number; error: string | null;
  started: number; finished: number | null; duration_ms: number;
}

export interface SpanRow {
  id: string; org_id: string; run_id: string; seq: number; kind: string; name: string;
  args: string | null; summary: string; ok: number; error_code: string | null;
  error_message: string | null; started: number; duration_ms: number;
}

export interface ApprovalRow {
  id: string; org_id: string; run_id: string; thread_id: string | null; tool: string; args: string;
  reason: string; status: string; outcome: string | null; requested_by: string | null;
  decided_by: string | null; decided_at: number | null; created: number;
}

export const publicThread = (row: ThreadRow) => ({
  object: 'ai_thread' as const,
  id: row.id,
  title: row.title,
  feature: row.feature,
  status: row.status,
  subject: row.subject_id ? { id: row.subject_id, type: row.subject_type } : null,
  created_by: row.created_by,
  message_count: row.message_count,
  last_message_at: row.last_message_at,
  metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
  created: row.created,
  updated: row.updated,
});

export const publicMessage = (row: MessageRow) => ({
  object: 'ai_message' as const,
  id: row.id,
  thread_id: row.thread_id,
  seq: row.seq,
  role: row.role,
  content: row.content,
  tool_calls: parseJson<unknown[]>(row.tool_calls, []),
  citations: parseJson<unknown[]>(row.citations, []),
  run_id: row.run_id,
  actor_id: row.actor_id,
  created: row.created,
});

export const publicSpan = (row: SpanRow) => ({
  object: 'ai_span' as const,
  id: row.id,
  run_id: row.run_id,
  seq: row.seq,
  kind: row.kind,
  name: row.name,
  args: parseJson<Record<string, unknown>>(row.args, {}),
  summary: row.summary,
  ok: !!row.ok,
  error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
  started: row.started,
  duration_ms: row.duration_ms,
});

export const publicRun = (row: RunRow, spans?: SpanRow[]) => ({
  object: 'ai_run' as const,
  id: row.id,
  thread_id: row.thread_id,
  feature: row.feature,
  provider: row.provider,
  model: row.model,
  status: row.status,
  actor_id: row.actor_id,
  actor_type: row.actor_type,
  question: row.question,
  answer: row.answer,
  intent: row.intent,
  confidence: row.confidence,
  reasoning: parseJson<string[]>(row.reasoning, []),
  citations: parseJson<{ id: string; label: string; type: string }[]>(row.citations, []),
  steps: row.steps,
  span_count: row.span_count,
  usage: {
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    credits: row.credits,
    cost_cents: Math.round(row.cost_micros / 1_000_000),
    cost_micros: row.cost_micros,
  },
  error: row.error,
  started: row.started,
  finished: row.finished,
  duration_ms: row.duration_ms,
  ...(spans ? { trace: spans.map(publicSpan) } : {}),
});

export const publicApproval = (row: ApprovalRow) => ({
  object: 'ai_approval' as const,
  id: row.id,
  run_id: row.run_id,
  thread_id: row.thread_id,
  tool: row.tool,
  args: parseJson<Record<string, unknown>>(row.args, {}),
  /** The write in plain English, so a person can approve it without reading JSON. */
  preview: describeWrite(row.tool, parseJson<Record<string, unknown>>(row.args, {})),
  reason: row.reason,
  status: row.status,
  outcome: row.outcome,
  requested_by: row.requested_by,
  decided_by: row.decided_by,
  decided_at: row.decided_at,
  created: row.created,
});

export class AiStore {
  constructor(private readonly ctx: Ctx) {}

  /* ------------------------------- threads ------------------------------- */

  createThread(orgId: string, input: {
    title: string; feature?: string; subjectId?: string | null; subjectType?: string | null;
    createdBy?: string | null; metadata?: Record<string, unknown>;
  }): ThreadRow {
    const now = this.ctx.now();
    const row: ThreadRow = {
      id: newId('thread'), org_id: orgId, title: input.title.slice(0, 200),
      feature: input.feature ?? 'copilot', status: 'open',
      subject_type: input.subjectType ?? null, subject_id: input.subjectId ?? null,
      created_by: input.createdBy ?? null, message_count: 0, last_message_at: null,
      metadata: JSON.stringify(input.metadata ?? {}), created: now, updated: now,
    };
    this.ctx.db.insert('ai_threads', { ...row });
    return row;
  }

  thread(orgId: string, id: string): ThreadRow | undefined {
    return this.ctx.db.get<ThreadRow>(`SELECT * FROM ai_threads WHERE org_id = ? AND id = ?`, orgId, id);
  }

  threads(orgId: string, opts: { status?: string; subjectId?: string; limit?: number; offset?: number } = {}): ThreadRow[] {
    const where = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts.subjectId) { where.push('subject_id = ?'); params.push(opts.subjectId); }
    return this.ctx.db.all<ThreadRow>(
      `SELECT * FROM ai_threads WHERE ${where.join(' AND ')} ORDER BY updated DESC LIMIT ? OFFSET ?`,
      ...(params as never[]), Math.min(opts.limit ?? 25, 100), opts.offset ?? 0,
    );
  }

  countThreads(orgId: string, status?: string): number {
    return status
      ? this.ctx.db.count(`SELECT COUNT(*) FROM ai_threads WHERE org_id = ? AND status = ?`, orgId, status)
      : this.ctx.db.count(`SELECT COUNT(*) FROM ai_threads WHERE org_id = ?`, orgId);
  }

  addMessage(orgId: string, threadId: string, input: {
    role: 'user' | 'assistant' | 'system' | 'tool'; content: string;
    toolCalls?: unknown[]; citations?: unknown[]; runId?: string | null; actorId?: string | null;
  }): MessageRow {
    const now = this.ctx.now();
    const seq = this.ctx.db.count(`SELECT COUNT(*) FROM ai_messages WHERE org_id = ? AND thread_id = ?`, orgId, threadId) + 1;
    const row: MessageRow = {
      id: newId('message'), org_id: orgId, thread_id: threadId, seq,
      role: input.role, content: input.content,
      tool_calls: input.toolCalls?.length ? JSON.stringify(input.toolCalls) : null,
      citations: input.citations?.length ? JSON.stringify(input.citations) : null,
      run_id: input.runId ?? null, actor_id: input.actorId ?? null, created: now,
    };
    this.ctx.db.insert('ai_messages', { ...row });
    this.ctx.db.run(
      `UPDATE ai_threads SET message_count = message_count + 1, last_message_at = ?, updated = ? WHERE org_id = ? AND id = ?`,
      now, now, orgId, threadId,
    );
    return row;
  }

  messages(orgId: string, threadId: string, limit = 100): MessageRow[] {
    return this.ctx.db.all<MessageRow>(
      `SELECT * FROM ai_messages WHERE org_id = ? AND thread_id = ? ORDER BY seq ASC LIMIT ?`,
      orgId, threadId, Math.min(limit, 500),
    );
  }

  /* --------------------------------- runs -------------------------------- */

  startRun(start: AiRunStart): void {
    this.ctx.db.insert('ai_runs', {
      id: start.runId, org_id: start.orgId, thread_id: start.threadId, feature: start.feature,
      provider: start.provider, model: start.model, actor_id: start.actorId, actor_type: start.actorType,
      status: 'running', question: start.question.slice(0, 4000), answer: '', intent: null, confidence: null,
      reasoning: '[]', citations: '[]', steps: 0, span_count: 0, input_tokens: 0, output_tokens: 0,
      credits: 0, cost_micros: 0, error: null, started: start.startedAt, finished: null, duration_ms: 0,
    });
  }

  recordSpan(span: AiTraceSpan): void {
    if (!this.ctx.db.get(`SELECT id FROM ai_runs WHERE id = ?`, span.runId)) return;
    this.ctx.db.insert('ai_spans', {
      id: span.id, org_id: span.orgId, run_id: span.runId, seq: span.seq, kind: span.kind, name: span.name,
      args: span.args ? JSON.stringify(span.args) : null, summary: span.summary.slice(0, 2000),
      ok: span.ok ? 1 : 0, error_code: span.errorCode, error_message: span.errorMessage,
      started: span.startedAt, duration_ms: span.durationMs,
    });
  }

  finishRun(finish: AiRunFinish, costMicros: number): void {
    this.ctx.db.patch('ai_runs', 'id', finish.runId, {
      status: finish.status,
      answer: finish.answer.slice(0, 20_000),
      intent: finish.intent,
      confidence: finish.confidence,
      reasoning: JSON.stringify(finish.reasoning),
      citations: JSON.stringify(finish.citations),
      steps: finish.steps,
      span_count: finish.spans.length,
      input_tokens: finish.usage.inputTokens,
      output_tokens: finish.usage.outputTokens,
      credits: finish.usage.credits,
      cost_micros: costMicros,
      error: finish.error,
      finished: finish.finishedAt,
      duration_ms: finish.durationMs,
    });
  }

  run(orgId: string, id: string): RunRow | undefined {
    return this.ctx.db.get<RunRow>(`SELECT * FROM ai_runs WHERE org_id = ? AND id = ?`, orgId, id);
  }

  runs(orgId: string, opts: { status?: string; feature?: string; threadId?: string; limit?: number; offset?: number } = {}): RunRow[] {
    const where = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts.feature) { where.push('feature = ?'); params.push(opts.feature); }
    if (opts.threadId) { where.push('thread_id = ?'); params.push(opts.threadId); }
    return this.ctx.db.all<RunRow>(
      `SELECT * FROM ai_runs WHERE ${where.join(' AND ')} ORDER BY started DESC LIMIT ? OFFSET ?`,
      ...(params as never[]), Math.min(opts.limit ?? 25, 100), opts.offset ?? 0,
    );
  }

  countRuns(orgId: string, opts: { status?: string; feature?: string } = {}): number {
    const where = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts.feature) { where.push('feature = ?'); params.push(opts.feature); }
    return this.ctx.db.count(`SELECT COUNT(*) FROM ai_runs WHERE ${where.join(' AND ')}`, ...(params as never[]));
  }

  spans(orgId: string, runId: string): SpanRow[] {
    return this.ctx.db.all<SpanRow>(`SELECT * FROM ai_spans WHERE org_id = ? AND run_id = ? ORDER BY seq ASC`, orgId, runId);
  }

  /* ------------------------------ approvals ------------------------------ */

  requestApproval(input: PendingApproval & { runId: string; orgId: string; actorId: string | null; threadId?: string | null }): ApprovalRow {
    const existing = this.ctx.db.get<ApprovalRow>(
      `SELECT * FROM ai_approvals WHERE org_id = ? AND run_id = ? AND tool = ? AND status = 'pending'`,
      input.orgId, input.runId, input.tool,
    );
    if (existing) return existing;
    const row: ApprovalRow = {
      id: newId('approval'), org_id: input.orgId, run_id: input.runId, thread_id: input.threadId ?? null,
      tool: input.tool, args: JSON.stringify(input.args), reason: input.reason, status: 'pending',
      outcome: null, requested_by: input.actorId, decided_by: null, decided_at: null, created: this.ctx.now(),
    };
    this.ctx.db.insert('ai_approvals', { ...row });
    return row;
  }

  approval(orgId: string, id: string): ApprovalRow | undefined {
    return this.ctx.db.get<ApprovalRow>(`SELECT * FROM ai_approvals WHERE org_id = ? AND id = ?`, orgId, id);
  }

  approvals(orgId: string, status?: string, limit = 50): ApprovalRow[] {
    return status
      ? this.ctx.db.all<ApprovalRow>(`SELECT * FROM ai_approvals WHERE org_id = ? AND status = ? ORDER BY created DESC LIMIT ?`, orgId, status, limit)
      : this.ctx.db.all<ApprovalRow>(`SELECT * FROM ai_approvals WHERE org_id = ? ORDER BY created DESC LIMIT ?`, orgId, limit);
  }

  decideApproval(orgId: string, id: string, status: 'approved' | 'declined', decidedBy: string | null, outcome?: string): void {
    this.ctx.db.run(
      `UPDATE ai_approvals SET status = ?, decided_by = ?, decided_at = ?, outcome = ? WHERE org_id = ? AND id = ?`,
      status, decidedBy, this.ctx.now(), outcome ?? null, orgId, id,
    );
  }

  /* -------------------------------- usage -------------------------------- */

  recordUsage(input: {
    orgId: string; feature: string; userId: string | null; model: string;
    inputTokens: number; outputTokens: number; credits: number; costMicros: number; toolCalls: number;
  }): void {
    const day = dayKey(this.ctx.now());
    const key = { org_id: input.orgId, day, feature: input.feature, user_id: input.userId ?? '', model: input.model };
    const existing = this.ctx.db.get<{ runs: number }>(
      `SELECT runs FROM ai_usage_daily WHERE org_id = ? AND day = ? AND feature = ? AND user_id = ? AND model = ?`,
      key.org_id, key.day, key.feature, key.user_id, key.model,
    );
    if (existing) {
      this.ctx.db.run(
        `UPDATE ai_usage_daily SET runs = runs + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
         credits = credits + ?, cost_micros = cost_micros + ?, tool_calls = tool_calls + ?, updated = ?
         WHERE org_id = ? AND day = ? AND feature = ? AND user_id = ? AND model = ?`,
        input.inputTokens, input.outputTokens, input.credits, input.costMicros, input.toolCalls, this.ctx.now(),
        key.org_id, key.day, key.feature, key.user_id, key.model,
      );
      return;
    }
    this.ctx.db.insert('ai_usage_daily', {
      ...key, runs: 1, input_tokens: input.inputTokens, output_tokens: input.outputTokens,
      credits: input.credits, cost_micros: input.costMicros, tool_calls: input.toolCalls, updated: this.ctx.now(),
    });
  }

  usage(orgId: string, opts: { since?: number; feature?: string; userId?: string } = {}): {
    day: string; feature: string; user_id: string; model: string; runs: number;
    input_tokens: number; output_tokens: number; credits: number; cost_micros: number; tool_calls: number;
  }[] {
    const where = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (opts.since) { where.push('day >= ?'); params.push(dayKey(opts.since)); }
    if (opts.feature) { where.push('feature = ?'); params.push(opts.feature); }
    if (opts.userId) { where.push('user_id = ?'); params.push(opts.userId); }
    return this.ctx.db.all(
      `SELECT day, feature, user_id, model, runs, input_tokens, output_tokens, credits, cost_micros, tool_calls
       FROM ai_usage_daily WHERE ${where.join(' AND ')} ORDER BY day DESC, credits DESC`,
      ...(params as never[]),
    );
  }
}
