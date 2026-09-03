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
import { describeWrite } from '../../ai/writes';
import { newId } from '../../../shared/ids';
import { dayKey } from '../../../shared/time';
import { maskSecrets } from '../../ai/runtime';
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

/**
 * Names for the ids inside a queued write.
 *
 * The approval card is the last thing a person reads before the write lands, so
 * it has to say "Rheinwerk Antriebstechnik", not "cmp_nw_21". Archived and
 * merged records still resolve here on purpose: an approval whose target has
 * moved is refused at execution, and the card reads better naming what it was
 * prepared against than showing a primary key.
 */
export function recordNamer(ctx: Ctx, orgId: string): (id: string) => string | null {
  const cache = new Map<string, string | null>();
  return (id: string) => {
    if (cache.has(id)) return cache.get(id) ?? null;
    const record = ctx.db.get<{ display_name: string }>(
      `SELECT display_name FROM crm_records WHERE org_id = ? AND id = ?`, orgId, id);
    const user = record ? null : ctx.db.get<{ name: string }>(
      `SELECT u.name AS name FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE m.org_id = ? AND u.id = ?`, orgId, id);
    const name = record?.display_name || user?.name || null;
    cache.set(id, name);
    return name;
  };
}

/**
 * The card as a person reads it.
 *
 * The stored arguments are the ones that will run, so the card shows them
 * whole: masked where a field is credential-shaped, never truncated. Capping
 * the rendering at 400 characters — as the trace does — would put an operator
 * in the position of approving a note whose decisive last sentence they cannot
 * see, which is the same gap as executing text that was never shown, read from
 * the other side.
 */
export const publicApproval = (row: ApprovalRow, nameOf: (id: string) => string | null = () => null) => {
  const args = maskSecrets(parseJson<Record<string, unknown>>(row.args, {}));
  return {
    object: 'ai_approval' as const,
    id: row.id,
    run_id: row.run_id,
    thread_id: row.thread_id,
    tool: row.tool,
    args,
    /** The write in plain English, so a person can approve it without reading JSON. */
    preview: describeWrite(row.tool, args, nameOf),
    reason: row.reason,
    status: row.status,
    outcome: row.outcome,
    requested_by: row.requested_by,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    created: row.created,
  };
};

/** One WHERE clause for both the page of approvals and the count beside it. */
function approvalScope(orgId: string, opts: { status?: string; runId?: string }): { where: string; params: unknown[] } {
  const where = ['org_id = ?'];
  const params: unknown[] = [orgId];
  if (opts.status) { where.push('status = ?'); params.push(opts.status); }
  if (opts.runId) { where.push('run_id = ?'); params.push(opts.runId); }
  return { where: where.join(' AND '), params };
}

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

  /**
   * Rename a conversation, or move it between open and archived.
   *
   * `updated` is deliberately left alone: archiving a thread is housekeeping,
   * not activity, and bumping it would jump the thread to the top of the list it
   * was just filed away from.
   */
  updateThread(orgId: string, id: string, patch: { title?: string; status?: 'open' | 'archived' }): ThreadRow | undefined {
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.title = patch.title.slice(0, 200);
    if (patch.status !== undefined) fields.status = patch.status;
    if (Object.keys(fields).length) {
      if (patch.title !== undefined) fields.updated = this.ctx.now();
      this.ctx.db.run(
        `UPDATE ai_threads SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE org_id = ? AND id = ?`,
        ...(Object.values(fields) as never[]), orgId, id,
      );
    }
    return this.thread(orgId, id);
  }

  /**
   * Delete a conversation and its messages.
   *
   * The runs stay. A run is the record of what the engine did — which tools it
   * called, what it cost, what a person approved — and that is an audit trail,
   * not correspondence; deleting the thread it was asked in must not erase it.
   * Their `thread_id` is cleared so nothing offers to open a conversation that
   * is gone.
   */
  deleteThread(orgId: string, id: string): number {
    const messages = this.ctx.db.count(`SELECT COUNT(*) FROM ai_messages WHERE org_id = ? AND thread_id = ?`, orgId, id);
    this.ctx.db.run(`DELETE FROM ai_messages WHERE org_id = ? AND thread_id = ?`, orgId, id);
    this.ctx.db.run(`UPDATE ai_runs SET thread_id = NULL WHERE org_id = ? AND thread_id = ?`, orgId, id);
    this.ctx.db.run(`UPDATE ai_approvals SET thread_id = NULL WHERE org_id = ? AND thread_id = ?`, orgId, id);
    this.ctx.db.run(`DELETE FROM ai_threads WHERE org_id = ? AND id = ?`, orgId, id);
    return messages;
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
      // The row is stamped with whoever answered, so a run that fell back to
      // the local engine is not filed under the provider that refused it.
      provider: finish.provider,
      model: finish.model,
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

  /**
   * Re-stamp a run's step count from the spans it actually has.
   *
   * `span_count` is written once, when the run finishes. A write that stopped
   * for approval and executed later appends a span after that, so the stored
   * count and the trace disagreed — the run list said 5 steps where the run's
   * own trace listed 6.
   */
  syncSpanCount(orgId: string, runId: string): void {
    this.ctx.db.run(
      `UPDATE ai_runs SET span_count = (SELECT COUNT(*) FROM ai_spans WHERE org_id = ? AND run_id = ?) WHERE org_id = ? AND id = ?`,
      orgId, runId, orgId, runId,
    );
  }

  spans(orgId: string, runId: string): SpanRow[] {
    return this.ctx.db.all<SpanRow>(`SELECT * FROM ai_spans WHERE org_id = ? AND run_id = ? ORDER BY seq ASC`, orgId, runId);
  }

  /* ------------------------------ approvals ------------------------------ */

  /**
   * Queue one write for a person to confirm, without queueing it twice.
   *
   * The dedupe is what stops one tool call from raising two identical cards
   * when the gate is reached more than once, and it has to be keyed on the
   * *write*, not on the tool. Keyed on `(run, tool)` alone it also collapsed
   * two genuinely different writes — a note on Rheinwerk and a note on Vektor,
   * planned in one run — into the first one's row: the completion answered
   * `pending_approvals: [two writes]`, the queue held one card, and approving
   * it executed the first while the second was lost with nothing anywhere
   * saying so. That is the same identity the decide route is claimed for, at
   * the other end: one approval is one write, so two writes are two approvals.
   */
  requestApproval(input: PendingApproval & { runId: string; orgId: string; actorId: string | null; threadId?: string | null }): ApprovalRow {
    // The *executable* arguments, not the display copy. `input.args` has been
    // through the trace's 400-character cap, and this column is what the
    // decide route re-parses and re-runs: storing the capped copy both
    // executed a truncated write and made every pair of writes agreeing in
    // their first 400 characters look like one card to the dedupe below.
    const args = JSON.stringify(input.rawArgs ?? input.args);
    const existing = this.ctx.db.get<ApprovalRow>(
      `SELECT * FROM ai_approvals WHERE org_id = ? AND run_id = ? AND tool = ? AND args = ? AND status = 'pending'`,
      input.orgId, input.runId, input.tool, args,
    );
    if (existing) return existing;
    const row: ApprovalRow = {
      id: newId('approval'), org_id: input.orgId, run_id: input.runId, thread_id: input.threadId ?? null,
      tool: input.tool, args, reason: input.reason, status: 'pending',
      outcome: null, requested_by: input.actorId, decided_by: null, decided_at: null, created: this.ctx.now(),
    };
    this.ctx.db.insert('ai_approvals', { ...row });
    return row;
  }

  approval(orgId: string, id: string): ApprovalRow | undefined {
    return this.ctx.db.get<ApprovalRow>(`SELECT * FROM ai_approvals WHERE org_id = ? AND id = ?`, orgId, id);
  }

  /**
   * Cards, narrowed by what is being asked for.
   *
   * `runId` is a filter rather than something the caller applies afterwards.
   * Reading the newest 50 in the workspace and *then* keeping the ones from one
   * run means a run audits as having asked for nothing the moment fifty newer
   * cards exist — the run detail is exactly where "what did this agent want to
   * do" is answered, so it may not be answered by a workspace-wide window.
   */
  approvals(orgId: string, opts: { status?: string; runId?: string; limit?: number; offset?: number } = {}): ApprovalRow[] {
    const { where, params } = approvalScope(orgId, opts);
    return this.ctx.db.all<ApprovalRow>(
      `SELECT * FROM ai_approvals WHERE ${where} ORDER BY created DESC LIMIT ? OFFSET ?`,
      ...(params as never[]), Math.min(opts.limit ?? 50, 200), opts.offset ?? 0,
    );
  }

  /** How many cards that same scope holds, so a truncated page can say so. */
  countApprovals(orgId: string, opts: { status?: string; runId?: string } = {}): number {
    const { where, params } = approvalScope(orgId, opts);
    return this.ctx.db.count(`SELECT COUNT(*) FROM ai_approvals WHERE ${where}`, ...(params as never[]));
  }

  /**
   * Take exclusive hold of a pending approval before acting on it.
   *
   * The same claim `JobQueue.runOne` makes before it runs a job row, for the
   * same reason and against a worse loss. Reading the row, checking it is
   * pending and then executing the write is not one transaction — there is an
   * `await` in the middle — so two people pressing Approve, or one client
   * retrying without an idempotency key, both saw `pending` and both executed:
   * two notes on the customer's timeline, two `ai.approval.granted` events, two
   * audit rows, and a single approval record that says the write happened once.
   *
   * `decided_at` is the claim. Exactly one caller sees `changes === 1`; the
   * row stays `pending` until that caller writes the real decision onto it, so
   * a claim that is never finished is released rather than left holding a
   * write nobody made.
   */
  claimApproval(orgId: string, id: string, decidedBy: string | null): boolean {
    return this.ctx.db.run(
      `UPDATE ai_approvals SET decided_by = ?, decided_at = ? WHERE org_id = ? AND id = ? AND status = 'pending' AND decided_at IS NULL`,
      decidedBy, this.ctx.now(), orgId, id,
    ).changes === 1;
  }

  /** Give a claim back, for a decision that ended somewhere it did not expect. */
  releaseApproval(orgId: string, id: string): void {
    this.ctx.db.run(
      `UPDATE ai_approvals SET decided_by = NULL, decided_at = NULL WHERE org_id = ? AND id = ? AND status = 'pending'`,
      orgId, id,
    );
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
