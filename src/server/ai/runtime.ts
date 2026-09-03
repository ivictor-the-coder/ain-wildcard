import type {
  AiCompletion, AiCompletionRequest, AiProvider, AiRuntime, AiToolCall, AiToolDef, AiUsage,
} from '../kernel/ai';
import type { Config, Ctx } from '../kernel/context';
import { isApiError } from '../../shared/errors';
import { newId, randomId } from '../../shared/ids';
import { builtinEngine, type EngineAnalysis } from './engine';
import { anthropicProvider } from './anthropic';

/**
 * The model gateway and the tool runtime.
 *
 * Providers are tried in priority order and the built-in deterministic engine
 * is always available, so the platform is fully intelligent with no network and
 * no keys. Every tool call — whoever asks for it, whichever provider decided to
 * make it — goes through `execute()`, which validates arguments, enforces the
 * read-only and approval gates, spends the run's step and time budget, applies
 * a per-org rate limit and records a trace span. That is the only path, so the
 * observability UI can never show a partial picture of what an agent did.
 */

export interface AiBudget {
  /** Maximum tool executions in one run. */
  steps: number;
  /** Wall-clock ceiling for the whole run, in milliseconds. */
  timeMs: number;
  /** Per-org tool executions per minute. */
  callsPerMinute: number;
}

export const DEFAULT_BUDGET: AiBudget = {
  steps: Number(process.env.AIN_AI_MAX_STEPS || 8),
  timeMs: Number(process.env.AIN_AI_TIME_BUDGET_MS || 10_000),
  callsPerMinute: Number(process.env.AIN_AI_TOOL_RATE || 600),
};

export type SpanKind = 'tool' | 'plan' | 'resolve' | 'synthesis' | 'provider';

export interface AiTraceSpan {
  id: string;
  runId: string;
  orgId: string;
  seq: number;
  kind: SpanKind;
  name: string;
  args: Record<string, unknown> | null;
  /** Short, redacted description of what came back. */
  summary: string;
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: number;
  durationMs: number;
}

export interface AiRunStart {
  runId: string;
  orgId: string;
  threadId: string | null;
  feature: string;
  provider: string;
  model: string;
  actorId: string | null;
  actorType: string;
  question: string;
  startedAt: number;
}

export interface AiRunFinish {
  runId: string;
  orgId: string;
  /**
   * The provider that actually produced this answer, which is not the one the
   * run started with when the preferred provider failed and another took over.
   * Cost and the run record follow this, never the intended provider.
   */
  provider: string;
  model: string;
  status: 'succeeded' | 'failed' | 'needs_approval';
  answer: string;
  usage: AiUsage;
  reasoning: string[];
  citations: { id: string; label: string; type: string }[];
  spans: AiTraceSpan[];
  steps: number;
  durationMs: number;
  finishedAt: number;
  error: string | null;
  pendingApprovals: PendingApproval[];
  intent: string | null;
  confidence: number | null;
}

export interface PendingApproval {
  tool: string;
  /**
   * What the card *shows*: secrets masked and long strings capped, because
   * this travels into the completion response, the `ai.approval.requested`
   * event and the trace.
   */
  args: Record<string, unknown>;
  /**
   * What the approval will actually *run*: the validated arguments, whole.
   *
   * These are two different things and were one. `ai_approvals.args` is
   * re-parsed and re-executed when a person presses Approve, so storing the
   * display copy meant a note longer than the 400-character display cap was
   * approved in full and written truncated — the approval executed a
   * different write from the one it showed. It also collapsed the dedupe:
   * two writes agreeing in their first 400 characters produced one card, the
   * exact failure `requestApproval` keys on the write to prevent.
   */
  rawArgs: Record<string, unknown>;
  reason: string;
  readOnly: boolean;
}

/** Where runs, spans and approval requests are persisted. Supplied by the `ai` module. */
export interface AiTraceSink {
  runStarted(run: AiRunStart): void;
  span(span: AiTraceSpan): void;
  runFinished(finish: AiRunFinish): void;
  approvalRequested(request: PendingApproval & { runId: string; orgId: string; actorId: string | null }): void;
}

export interface AiCallContext {
  ctx: Ctx;
  orgId: string;
  actorId?: string | null;
  actorType?: 'user' | 'api_key' | 'system' | 'agent' | 'workflow';
  threadId?: string | null;
  /** The record a conversation is pinned to — what "they" means in turn two. */
  subjectId?: string | null;
  subjectType?: string | null;
  runId?: string;
  /** What used the model — copilot, agent, workflow, scoring, seed. */
  feature?: string;
  /** Tool names the operator has already approved for this run. */
  approvals?: string[];
  /**
   * Tool names this run is scoped to. `null`/absent means the whole catalogue;
   * an empty array means no tools at all. The engine plans against this list,
   * so scoping an agent actually scopes what it can do.
   */
  restrictTools?: string[] | null;
  /** Write tools are refused unless this is set. */
  allowWrites?: boolean;
  budget?: Partial<AiBudget>;
  /** Filled in by the runtime before the provider is called. */
  runtime?: AinAiRuntime;
  spans?: AiTraceSpan[];
  pendingApprovals?: PendingApproval[];
  /** Monotonic clock reading taken when the run started. */
  startedNs?: bigint;
  steps?: number;
  /** Receive assistant text as it is produced, when the provider streams. */
  onDelta?: (text: string) => void;
}

export interface ToolFailure {
  code: 'tool_not_found' | 'tool_not_permitted' | 'invalid_arguments' | 'write_not_permitted' | 'approval_required'
    | 'rate_limited' | 'step_budget_exhausted' | 'time_budget_exhausted' | 'tool_failed';
  message: string;
  param?: string;
  /** True when the engine can usefully try something else. */
  recoverable: boolean;
}

export interface ToolExecution {
  ok: boolean;
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: ToolFailure;
  span: AiTraceSpan;
}

export interface AinCompletion extends AiCompletion {
  runId: string;
  spans: AiTraceSpan[];
  pendingApprovals: PendingApproval[];
  analysis?: EngineAnalysis;
  /** Set when the preferred provider failed and another one answered. */
  degraded?: { provider: string; answeredBy: string; code: string; message: string } | null;
}

export interface AinAiRuntime extends AiRuntime {
  complete(req: AiCompletionRequest, ctx: unknown): Promise<AinCompletion>;
  execute(name: string, args: Record<string, unknown>, call: AiCallContext, definition?: AiToolDef): Promise<ToolExecution>;
  /** Record a non-tool step (planning, resolution, synthesis) on the trace. */
  note(call: AiCallContext, kind: SpanKind, name: string, summary: string, durationMs?: number): AiTraceSpan;
  setTraceSink(sink: AiTraceSink | null): void;
  budget(call: AiCallContext): AiBudget;
  config: Config;
}

/** Narrow the kernel-typed runtime to this implementation's richer surface. */
export const aiRuntime = (ctx: Ctx): AinAiRuntime => ctx.ai as AinAiRuntime;

/* ------------------------------- redaction ------------------------------- */

const SECRET_KEY = /(password|secret|token|api[_-]?key|authorization|credential)/i;

/**
 * Mask anything credential-shaped, and change nothing else.
 *
 * The two halves of redaction protect different things and belong to
 * different surfaces. Masking is a safety property — it must hold anywhere a
 * payload is shown. The 400-character cap is only about keeping a trace row
 * small, and it must not reach a surface where a person is being asked to
 * approve the text: an operator cannot consent to a note whose last sentence
 * has been replaced with an ellipsis.
 */
export function maskSecrets(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : value;
  }
  return out;
}

/** Masking plus the trace's length cap. For spans and event payloads only. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(maskSecrets(args))) {
    if (typeof value === 'string' && value.length > 400) { out[key] = `${value.slice(0, 400)}…`; continue; }
    out[key] = value;
  }
  return out;
}

/** A one-line, human-readable description of a tool result for the trace. */
export function summariseResult(value: unknown): string {
  if (value === null || value === undefined) return 'no result';
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, val] of Object.entries(record)) {
    if (parts.length >= 5) break;
    if (SECRET_KEY.test(key)) { parts.push(`${key}=[redacted]`); continue; }
    if (val === null || val === undefined) continue;
    if (Array.isArray(val)) { parts.push(`${key}=${val.length}`); continue; }
    if (typeof val === 'object') continue;
    const text = String(val);
    parts.push(`${key}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
  }
  return parts.length ? parts.join(' ') : `${Object.keys(record).length} fields`;
}

/* ------------------------------ call context ----------------------------- */

const isCtx = (value: unknown): value is Ctx =>
  !!value && typeof value === 'object' && 'db' in (value as Record<string, unknown>) && 'now' in (value as Record<string, unknown>);

/**
 * Callers hand us whatever context they have: a bare `Ctx`, the per-request
 * `RequestCtx` (which knows the org and the user), or an explicit call context.
 * All three are accepted so no module has to learn a new calling convention.
 */
export function resolveCallContext(input: unknown, config: Config): AiCallContext {
  if (input && typeof input === 'object' && 'ctx' in (input as Record<string, unknown>)) {
    const call = input as AiCallContext;
    return { ...call, orgId: call.orgId || call.ctx.config.defaultOrgId };
  }
  if (isCtx(input)) {
    const auth = (input as { auth?: { orgId?: string; userId?: string; kind?: string } }).auth;
    return {
      ctx: input,
      orgId: auth?.orgId || input.config.defaultOrgId,
      actorId: auth?.userId ?? null,
      actorType: auth?.kind === 'session' ? 'user' : 'system',
      feature: 'api',
    };
  }
  throw new Error(`AI runtime: complete() needs a Ctx or an AiCallContext, received ${typeof input}. Pass the request context.`);
}

const elapsedMs = (from: bigint): number => Number((process.hrtime.bigint() - from) / 1_000_000n);

/* -------------------------------- runtime -------------------------------- */

export function createAiRuntime(config: Config): AinAiRuntime {
  const tools = new Map<string, AiToolDef>();
  const providers: AiProvider[] = [anthropicProvider(config), builtinEngine()];
  let sink: AiTraceSink | null = null;
  const buckets = new Map<string, { tokens: number; last: number }>();

  const budgetFor = (call: AiCallContext): AiBudget => ({ ...DEFAULT_BUDGET, ...(call.budget ?? {}) });

  /**
   * `now` is the workspace's own clock, which an operator moves in both
   * directions with `POST /v1/time/advance` and `POST /v1/time/reset`. A token
   * bucket cannot survive time going backwards: the refill term goes negative
   * by `elapsed × limit`, so returning a workspace to real time after a month
   * of replay left it ~2.6M tokens in deficit against a 600/minute refill, and
   * every tool call in that workspace answered `rate_limited` from then on —
   * the copilot reporting that it could not reach any of the workspace's own
   * data. Clamping `elapsed` at zero is the invariant: whatever the source of
   * the number, a bucket may only ever be refilled by time passing, never
   * emptied by it.
   */
  function rateLimit(orgId: string, now: number, limit: number): boolean {
    const bucket = buckets.get(orgId) ?? { tokens: limit, last: now };
    bucket.tokens = Math.min(limit, bucket.tokens + (Math.max(0, now - bucket.last) / 60_000) * limit);
    bucket.last = now;
    if (bucket.tokens < 1) { buckets.set(orgId, bucket); return false; }
    bucket.tokens -= 1;
    buckets.set(orgId, bucket);
    return true;
  }

  function record(call: AiCallContext, span: AiTraceSpan): AiTraceSpan {
    (call.spans ||= []).push(span);
    try { sink?.span(span); }
    catch (e) { call.ctx.log.warn('ai.span_sink_failed', { error: (e as Error).message }); }
    return span;
  }

  function makeSpan(call: AiCallContext, kind: SpanKind, name: string, args: Record<string, unknown> | null): AiTraceSpan {
    return {
      id: randomId('trc', 14),
      runId: call.runId ?? 'run_unbound',
      orgId: call.orgId,
      seq: (call.spans?.length ?? 0) + 1,
      kind,
      name,
      args: args ? redactArgs(args) : null,
      summary: '',
      ok: true,
      errorCode: null,
      errorMessage: null,
      startedAt: call.ctx.now(),
      durationMs: 0,
    };
  }

  const runtime: AinAiRuntime = {
    providers,
    config,

    active() {
      const preferred = config.aiProvider && config.aiProvider !== 'auto'
        ? providers.find((p) => p.id === config.aiProvider && p.available())
        : undefined;
      return preferred || providers.find((p) => p.available()) || providers[providers.length - 1];
    },

    budget: budgetFor,
    setTraceSink(next) { sink = next; },

    registerTool(tool) {
      if (tools.has(tool.name)) throw new Error(`Duplicate AI tool: ${tool.name}`);
      tools.set(tool.name, tool);
    },

    tools(filter) {
      let out = [...tools.values()];
      if (filter?.tags?.length) out = out.filter((t) => t.tags?.some((tag) => filter.tags!.includes(tag)));
      if (filter?.readOnly !== undefined) out = out.filter((t) => t.readOnly === filter.readOnly);
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },

    tool(name) { return tools.get(name); },

    note(call, kind, name, summary, durationMs = 0) {
      const span = makeSpan(call, kind, name, null);
      span.summary = summary;
      span.durationMs = durationMs;
      return record(call, span);
    },

    async execute(name, args, call, definition) {
      const started = process.hrtime.bigint();
      // A caller may hand the engine a tool that lives outside the registry
      // (an agent's private tool); it goes through the same gates either way.
      const tool = definition ?? tools.get(name);
      const span = makeSpan(call, 'tool', name, args);
      const budget = budgetFor(call);

      const fail = (error: ToolFailure): ToolExecution => {
        span.ok = false;
        span.errorCode = error.code;
        span.errorMessage = error.message;
        span.summary = `${error.code}: ${error.message}`;
        span.durationMs = elapsedMs(started);
        record(call, span);
        return { ok: false, tool: name, args, error, span };
      };

      if (!tool) {
        return fail({
          code: 'tool_not_found',
          message: `No tool named "${name}" is registered. Available: ${[...tools.keys()].slice(0, 12).join(', ')}.`,
          recoverable: true,
        });
      }
      // A caller that scoped this run to a set of tools gets that set enforced
      // here as well as in the planner, so no provider can widen it.
      if (call.restrictTools && !call.restrictTools.includes(name)) {
        return fail({
          code: 'tool_not_permitted',
          message: call.restrictTools.length
            ? `This run is scoped to ${call.restrictTools.map((t) => `"${t}"`).join(', ')}; "${name}" is not in that list.`
            : `This run was scoped to no tools, so "${name}" may not run.`,
          recoverable: false,
        });
      }
      call.steps = (call.steps ?? 0) + 1;
      if (call.steps > budget.steps) {
        return fail({ code: 'step_budget_exhausted', message: `This run already used its ${budget.steps}-step budget.`, recoverable: false });
      }
      if (call.startedNs && elapsedMs(call.startedNs) > budget.timeMs) {
        return fail({ code: 'time_budget_exhausted', message: `This run exceeded its ${budget.timeMs}ms budget.`, recoverable: false });
      }
      if (!rateLimit(call.orgId, call.ctx.now(), budget.callsPerMinute)) {
        return fail({ code: 'rate_limited', message: `This workspace is over its limit of ${budget.callsPerMinute} tool calls per minute.`, recoverable: false });
      }

      let parsed: unknown;
      try {
        parsed = tool.input.parse(args ?? {});
      } catch (e) {
        const apiError = isApiError(e) ? e : null;
        return fail({
          code: 'invalid_arguments',
          message: apiError?.message ?? (e as Error).message,
          param: apiError?.param,
          recoverable: true,
        });
      }

      if (!tool.readOnly && !call.allowWrites) {
        return fail({
          code: 'write_not_permitted',
          message: `"${name}" changes data and this run is read-only.`,
          recoverable: false,
        });
      }
      // Every write is confirmed by a person before it lands. A tool that forgot
      // to set `requiresApproval` does not get a free pass: changing a
      // customer's record is the thing being gated, not the flag.
      if ((!tool.readOnly || tool.requiresApproval) && !(call.approvals ?? []).includes(name)) {
        const pending: PendingApproval = {
          tool: name,
          args: redactArgs(parsed as Record<string, unknown>),
          rawArgs: parsed as Record<string, unknown>,
          reason: tool.readOnly
            ? `${name} is marked as needing a person to approve it before it runs.`
            : `${name} changes workspace data, so a person approves it before it runs.`,
          readOnly: tool.readOnly,
        };
        (call.pendingApprovals ||= []).push(pending);
        try { sink?.approvalRequested({ ...pending, runId: call.runId ?? 'run_unbound', orgId: call.orgId, actorId: call.actorId ?? null }); }
        catch (e) { call.ctx.log.warn('ai.approval_sink_failed', { error: (e as Error).message }); }
        return fail({
          code: 'approval_required',
          message: `"${name}" is waiting for approval before it can run.`,
          recoverable: false,
        });
      }

      try {
        const output = await tool.run(parsed, call.ctx, {
          orgId: call.orgId,
          actorId: call.actorId ?? undefined,
          runId: call.runId,
          threadId: call.threadId ?? undefined,
        });
        span.summary = summariseResult(output);
        span.durationMs = elapsedMs(started);
        record(call, span);
        return { ok: true, tool: name, args, result: output, span };
      } catch (e) {
        const apiError = isApiError(e) ? e : null;
        return fail({
          code: 'tool_failed',
          message: apiError?.message ?? (e as Error).message,
          param: apiError?.param,
          recoverable: true,
        });
      }
    },

    async complete(req, input) {
      const call = resolveCallContext(input, config);
      call.runtime = runtime;
      call.runId ||= newId('agentrun');
      call.spans ||= [];
      call.pendingApprovals ||= [];
      call.startedNs ||= process.hrtime.bigint();
      call.steps ||= 0;

      const preferred = runtime.active();
      // The copilot does not go offline because a key was mistyped: providers
      // are tried in order and the local engine is always the last one, so a
      // 401 downgrades the answer instead of taking the surface down.
      const chain = [preferred, ...providers.filter((p) => p !== preferred && p.available())];
      const provider = preferred;
      const model = req.model || (provider.id === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : 'ain-engine-1');
      const question = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const request: AiCompletionRequest = {
        ...req,
        // With no explicit tool list the engine sees the live catalogue, minus
        // the write tools unless the caller asked for an agent that can act.
        tools: req.tools ?? runtime.tools(call.allowWrites ? undefined : { readOnly: true }),
      };

      const start: AiRunStart = {
        runId: call.runId,
        orgId: call.orgId,
        threadId: call.threadId ?? null,
        feature: call.feature ?? 'api',
        provider: provider.id,
        model,
        actorId: call.actorId ?? null,
        actorType: call.actorType ?? 'system',
        question,
        startedAt: call.ctx.now(),
      };
      try { sink?.runStarted(start); }
      catch (e) { call.ctx.log.warn('ai.run_sink_failed', { error: (e as Error).message }); }

      try {
        let degraded: AinCompletion['degraded'] = null;
        let completion: AiCompletion | null = null;
        for (let i = 0; i < chain.length; i++) {
          const candidate = chain[i];
          try {
            completion = await candidate.complete(request, call);
            break;
          } catch (e) {
            const failure = isApiError(e) ? e : null;
            const message = (e as Error).message;
            const span = makeSpan(call, 'provider', candidate.id, null);
            span.ok = false;
            span.errorCode = failure?.code ?? 'ai_provider_error';
            span.errorMessage = message;
            span.summary = `${candidate.label} failed: ${message}`;
            record(call, span);
            const next = chain[i + 1];
            if (!next) throw e;
            call.ctx.log.warn('ai.provider_failed', { provider: candidate.id, fallback: next.id, error: message });
            degraded = {
              provider: candidate.id,
              answeredBy: next.id,
              code: failure?.code ?? 'ai_provider_error',
              message,
            };
          }
        }
        if (!completion) throw new Error('No AI provider produced a completion.');
        if (degraded) {
          completion = {
            ...completion,
            reasoning: [
              `${degraded.provider} failed (${degraded.code}): ${degraded.message}. Answered by ${degraded.answeredBy} instead — this answer is degraded, not the configured provider's.`,
              ...(completion.reasoning ?? []),
            ],
          };
        }
        const analysis = (completion as AinCompletion).analysis;
        const finish: AiRunFinish = {
          runId: call.runId,
          orgId: call.orgId,
          // A degraded run is billed and recorded as what answered it, not as
          // the hosted model that 401'd — otherwise the usage report invoices
          // Claude prices for work the local engine did for nothing.
          provider: degraded ? degraded.answeredBy : provider.id,
          model: completion.model,
          status: call.pendingApprovals.length ? 'needs_approval' : 'succeeded',
          answer: completion.content,
          usage: completion.usage,
          reasoning: completion.reasoning ?? [],
          citations: completion.citations ?? [],
          spans: call.spans,
          steps: call.steps ?? 0,
          durationMs: elapsedMs(call.startedNs),
          finishedAt: call.ctx.now(),
          error: null,
          pendingApprovals: call.pendingApprovals,
          // A template match is exact, so a matched question is read with
          // certainty and a refused one with none; the hosted model reports
          // neither.
          intent: analysis?.intent ?? null,
          confidence: analysis ? (analysis.refusal ? 0 : 1) : null,
        };
        try { sink?.runFinished(finish); }
        catch (e) { call.ctx.log.warn('ai.run_sink_failed', { error: (e as Error).message }); }
        return {
          ...completion,
          runId: call.runId,
          spans: call.spans,
          pendingApprovals: call.pendingApprovals,
          analysis,
          degraded,
        };
      } catch (e) {
        const message = (e as Error).message;
        try {
          sink?.runFinished({
            runId: call.runId, orgId: call.orgId, provider: provider.id, model, status: 'failed', answer: '',
            usage: { inputTokens: 0, outputTokens: 0, costCents: 0, credits: 0 },
            reasoning: [], citations: [], spans: call.spans, steps: call.steps ?? 0,
            durationMs: elapsedMs(call.startedNs), finishedAt: call.ctx.now(), error: message,
            pendingApprovals: call.pendingApprovals, intent: null, confidence: null,
          });
        } catch (sinkError) { call.ctx.log.warn('ai.run_sink_failed', { error: (sinkError as Error).message }); }
        throw e;
      }
    },
  };

  return runtime;
}

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5';

export const newToolCallId = (): string => randomId('call', 12);

export const toolCall = (name: string, args: Record<string, unknown>): AiToolCall => ({
  id: newToolCallId(),
  name,
  arguments: args,
});
