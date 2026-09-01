import { defineModule } from '../../kernel/module';
import type { Ctx } from '../../kernel/context';
import type { AiCompletionRequest, AiMessage } from '../../kernel/ai';
import { created, list, roleAtLeast, type Req } from '../../kernel/http';
import { badRequest, forbidden, notFound } from '../../../shared/errors';
import type { SchemaNode } from '../../../shared/validate';
import v from '../../../shared/validate';
import { DAY, dayKey, formatDate } from '../../../shared/time';
import { AI_MIGRATIONS } from './schema';
import { AiStore, publicApproval, publicMessage, publicRun, publicSpan, publicThread, recordNamer } from './store';
import { aiTools, metricCatalogue } from './tools';
import {
  aiRuntime, type AiCallContext, type AiTraceSink, type AinCompletion, type PendingApproval,
} from '../../ai/runtime';
import { accountUsage, describeUsage } from '../../ai/usage';
import { workspaceProfile } from '../../ai/grounding';
import { stageSets } from '../../ai/metrics';
import { invalidateIndex } from '../../ai/grounding';
import { accountProfile, recordSearch, recordTimeline } from '../../ai/functions';
import { recordStanding, type RecordStanding } from '../../ai/query';
import { composeDraft, detectDraftKind, detectTone, DRAFT_KINDS, TONES, type DraftKind, type DraftResult, type Tone } from '../../ai/draft';
import { truncate } from '../../ai/text';

/**
 * Argument fields that name a record a write will land on.
 *
 * `assignee_id` and `owner_id` point at users rather than CRM records, so they
 * are deliberately absent: this list is the set of things whose disappearance
 * makes the write itself wrong.
 */
const TARGET_FIELDS = ['record_id', 'record_ids', 'id', 'associate_to', 'associated_to', 'parent_id'];

/** Every CRM record id an approval's arguments will write to. */
function writeTargets(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const field of TARGET_FIELDS) {
    const value = args[field];
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') out.push(item);
  }
  return [...new Set(out)];
}

/** How a target that has moved under the approval reads to the person approving. */
function describeStanding(standing: RecordStanding): string {
  switch (standing.state) {
    case 'missing': return `${standing.id} no longer exists`;
    case 'archived': return `${standing.name ?? standing.id} has been archived`;
    case 'merged': return `${standing.name ?? standing.id} was merged into ${standing.mergedInto}`;
    default: return `${standing.name ?? standing.id} is unchanged`;
  }
}

/* --------------------------- the AI trust boundary ------------------------ */

/**
 * `allow_writes` and `approvals` are the AI surface's authority parameters:
 * together they let a caller execute a write tool with nobody else in the loop,
 * so the requester is also the approver. That is precisely the authority
 * `POST /v1/ai/approvals/:id` carries, and that route is gated at `member` —
 * so these two fields are gated at `member` too.
 *
 * The route itself stays open to every role, because reading the workspace
 * through the copilot is what an analyst is for. Gating the whole endpoint
 * would take the read surface away; gating only the fields closes the hole,
 * which is that a readonly session refused `POST /v1/records/:id/activities`
 * could write the identical note by asking the copilot for it.
 */
function assertMayAuthoriseWrites(req: Req): void {
  const body = req.body as { allow_writes?: boolean; approvals?: string[] } | undefined;
  const asking = body?.allow_writes === true || !!body?.approvals?.length;
  if (!asking || roleAtLeast(req.auth.role, 'member')) return;
  throw forbidden(
    `Your role (${req.auth.role}) cannot let an agent write to this workspace. `
    + 'Ask again without `allow_writes` to read, or have a teammate with the member role or higher run it from the approvals queue.',
  );
}

const isMember = (ctx: Ctx, orgId: string, userId: string): boolean =>
  !!ctx.db.get<{ user_id: string }>(
    `SELECT user_id FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, userId);

/**
 * Who an AI run acts as.
 *
 * A write tool hands its actor to the CRM as the owner of what it writes, and
 * an API key id is not a person: `logActivity` puts the actor in `owner_id`,
 * which rejects anything that is not a member of the workspace. Passing
 * `auth.keyId` through is why every AI write tool answered `"ak_… is not a
 * member of this workspace"` for exactly the callers who integrate with us,
 * leaving the whole agent surface session-only.
 *
 * A key therefore acts as the teammate who created it. Anything that is not a
 * live member of this org — a key created by someone who has since left, a
 * session whose membership was revoked — resolves to null rather than to a
 * stranger: an unattributed note is a small loss, a 400 on every write is not.
 */
function actorFor(ctx: Ctx, auth: Req['auth']): string | null {
  if (auth.userId) return isMember(ctx, auth.orgId, auth.userId) ? auth.userId : null;
  if (!auth.keyId) return null;
  const key = ctx.db.get<{ created_by: string | null }>(
    `SELECT created_by FROM api_keys WHERE id = ? AND org_id = ?`, auth.keyId, auth.orgId);
  return key?.created_by && isMember(ctx, auth.orgId, key.created_by) ? key.created_by : null;
}

/* -------------------------------- service -------------------------------- */

export interface AskOptions {
  actorId?: string | null;
  actorType?: AiCallContext['actorType'];
  threadId?: string | null;
  feature?: string;
  allowWrites?: boolean;
  approvals?: string[];
  /** Restrict the run to these tool names; omit for the whole read-only catalogue. */
  toolNames?: string[];
  intent?: string;
  responseSchema?: SchemaNode;
  maxSteps?: number;
  model?: string;
}

export interface AskResult {
  runId: string;
  content: string;
  citations: { id: string; label: string; type: string }[];
  reasoning: string[];
  usage: AinCompletion['usage'];
  pendingApprovals: PendingApproval[];
  completion: AinCompletion;
}

/** What other modules get from `ctx.svc.ai`. */
export interface AiService {
  /** Ask a question in natural language and get a grounded answer with a trace. */
  ask(orgId: string, question: string, opts?: AskOptions): Promise<AskResult>;
  /** Full control: your own message list, tools and response schema. */
  complete(orgId: string, request: AiCompletionRequest, opts?: AskOptions): Promise<AinCompletion>;
  /** Fill a schema from the workspace's data — classification, extraction, scoring. */
  extract<T = unknown>(orgId: string, prompt: string, schema: SchemaNode, opts?: AskOptions): Promise<T | null>;
  /** Write something personalised from a record, without sending it. */
  draft(orgId: string, instruction: string, opts?: { recordId?: string; contactId?: string; kind?: DraftKind; tone?: Tone; actorId?: string | null }): DraftResult;
  createThread(orgId: string, input: { title: string; subjectId?: string | null; subjectType?: string | null; createdBy?: string | null; feature?: string }): { id: string };
  reply(orgId: string, threadId: string, message: string, opts?: AskOptions): Promise<AskResult>;
  /** Grounded starter questions for an empty copilot panel. */
  suggestions(orgId: string): { question: string; why: string; intent: string }[];
}

declare module '../../kernel/services' {
  interface ServiceRegistry { ai: AiService }
}

const SYSTEM_PROMPT = (ctx: Ctx, orgId: string): string => {
  const workspace = workspaceProfile(ctx, orgId);
  return [
    `You are the operating copilot for ${workspace.name}.`,
    `Today is ${formatDate(workspace.now, { locale: workspace.locale, timeZone: workspace.timezone, withTime: true })} in ${workspace.timezone}; money is ${workspace.currency.toUpperCase()}.`,
    `The team is ${workspace.people.map((p) => `${p.name} (${p.title ?? p.role})`).join(', ')}.`,
    'Answer only from the workspace records the tools return. Quote real names, real amounts and real dates, and say plainly when something is not there.',
  ].join(' ');
};

/** The engine's own working notes, in the API's snake_case shape. */
function describeAnalysis(completion: AinCompletion) {
  const analysis = completion.analysis;
  if (!analysis) return null;
  return {
    intent: analysis.intent.intent,
    confidence: analysis.intent.confidence,
    runner_up: analysis.intent.runnerUp,
    signals: analysis.intent.signals.map((signal) => ({
      id: signal.id, intent: signal.intent, matched: signal.matched,
      weight: signal.weight, applied: signal.applied, negated: signal.negated,
    })),
    negations: analysis.intent.negations,
    window: {
      label: analysis.window.label,
      start: analysis.window.start,
      end: analysis.window.end,
      grain: analysis.window.grain,
      partial: analysis.window.partial,
      from_question: analysis.windowFromQuestion,
    },
    windows: analysis.windows.map((w) => ({
      label: w.label, start: w.start, end: w.end, grain: w.grain, partial: w.partial, matched: w.matched.trim(),
    })),
    comparison: analysis.comparison
      ? {
          source: analysis.comparison.source,
          a: { label: analysis.comparison.a.label, start: analysis.comparison.a.start, end: analysis.comparison.a.end },
          b: { label: analysis.comparison.b.label, start: analysis.comparison.b.start, end: analysis.comparison.b.end },
        }
      : null,
    refusal: analysis.refusal,
    write_blocked: analysis.writeBlocked,
    scoped_tools: analysis.scopedTools,
    budget_exhausted: analysis.budgetExhausted,
    entities: analysis.entities,
    subject: analysis.subject,
    metric: analysis.metric,
    group_by: analysis.groupBy,
    object_types: analysis.types,
    tone: analysis.tone,
    draft_kind: analysis.draftKind,
    plan: analysis.plan,
    skipped: analysis.skipped,
    carried_subject: analysis.carriedSubject,
    steps: analysis.steps,
    passes: analysis.passes,
  };
}

/**
 * Models this platform can actually run. A request for one it does not have is
 * a 400, not a silent substitution — a caller comparing two models' answers has
 * to be able to trust that it ran the one it asked for.
 */
export const KNOWN_MODELS = ['ain-engine-1', 'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'];

function assertKnownModel(model: string): void {
  if (KNOWN_MODELS.includes(model)) return;
  throw badRequest(
    'unknown_model',
    `"${model}" is not a model this workspace can run. Available: ${KNOWN_MODELS.join(', ')}. Omit \`model\` to use whichever provider is configured.`,
    'model',
  );
}

/**
 * The transcript the engine sees.
 *
 * `reply()` stores the user's turn before it asks, so the history it reads back
 * already ends with this question. Appending it again put the same sentence in
 * twice, and the second copy pushed the turn that named the account out of the
 * window a pronoun is resolved against — which is why the fourth turn of every
 * conversation forgot what it was about.
 */
const toMessages = (ctx: Ctx, orgId: string, history: AiMessage[], question: string): AiMessage[] => {
  const last = history[history.length - 1];
  const alreadyAsked = !!last && last.role === 'user' && last.content === question;
  return [
    { role: 'system', content: SYSTEM_PROMPT(ctx, orgId) },
    ...history,
    ...(alreadyAsked ? [] : [{ role: 'user' as const, content: question }]),
  ];
};

/* --------------------------------- module -------------------------------- */

export default defineModule({
  name: 'ai',
  title: 'Intelligence',
  description: 'The reasoning engine, the tool runtime, durable copilot conversations, and a full trace, cost and approval record for every AI run in the platform.',
  dependsOn: ['core'],
  migrations: AI_MIGRATIONS,

  boot(ctx) {
    const store = new AiStore(ctx);
    const runtime = aiRuntime(ctx);

    /* Every run in the platform lands in these tables, whoever started it. */
    const sink: AiTraceSink = {
      runStarted(start) {
        store.startRun(start);
        ctx.emit(start.orgId, 'ai.run.started', {
          id: start.runId, feature: start.feature, provider: start.provider, model: start.model,
          question: truncate(start.question, 300), thread_id: start.threadId,
        }, { objectId: start.runId, objectType: 'ai_run', actorId: start.actorId, actorType: 'agent' });
      },
      span(span) { store.recordSpan(span); },
      runFinished(finish) {
        const row = store.run(finish.orgId, finish.runId);
        // Costed against the model that answered. When a hosted provider fails
        // and the local engine takes over, the run is free and must be recorded
        // that way, whatever model the run was started with.
        const model = finish.model;
        const { costMicros } = accountUsage(model, finish.usage.inputTokens, finish.usage.outputTokens);
        store.finishRun(finish, costMicros);
        store.recordUsage({
          orgId: finish.orgId,
          feature: row?.feature ?? 'api',
          userId: row?.actor_id ?? null,
          model,
          inputTokens: finish.usage.inputTokens,
          outputTokens: finish.usage.outputTokens,
          credits: finish.usage.credits,
          costMicros,
          toolCalls: finish.spans.filter((s) => s.kind === 'tool').length,
        });
        const payload = {
          id: finish.runId, status: finish.status, intent: finish.intent, confidence: finish.confidence,
          steps: finish.steps, duration_ms: finish.durationMs, credits: finish.usage.credits,
          citations: finish.citations.length, answer: truncate(finish.answer, 500), error: finish.error,
        };
        ctx.emit(finish.orgId, finish.status === 'failed' ? 'ai.run.failed' : 'ai.run.completed', payload, {
          objectId: finish.runId, objectType: 'ai_run', actorId: row?.actor_id ?? null, actorType: 'agent',
        });
      },
      approvalRequested(request) {
        const row = store.run(request.orgId, request.runId);
        const approval = store.requestApproval({ ...request, threadId: row?.thread_id ?? null });
        ctx.emit(request.orgId, 'ai.approval.requested', {
          id: approval.id, run_id: request.runId, tool: request.tool, args: request.args, reason: request.reason,
        }, { objectId: approval.id, objectType: 'ai_approval', actorId: request.actorId, actorType: 'agent' });
      },
    };
    runtime.setTraceSink(sink);

    const callContext = (orgId: string, opts: AskOptions = {}): AiCallContext => {
      // A conversation pinned to an account is pinned for every turn of it.
      // Turn two says "they", and this is the only place that knows who.
      const thread = opts.threadId ? store.thread(orgId, opts.threadId) : undefined;
      return {
        ctx,
        orgId,
        actorId: opts.actorId ?? null,
        actorType: opts.actorType ?? 'user',
        threadId: opts.threadId ?? null,
        subjectId: thread?.subject_id ?? null,
        subjectType: thread?.subject_type ?? null,
        feature: opts.feature ?? 'copilot',
        allowWrites: !!opts.allowWrites,
        approvals: opts.approvals ?? [],
        ...(opts.maxSteps ? { budget: { steps: opts.maxSteps } } : {}),
      };
    };

    /**
     * Resolve a caller's tool allowlist. An unknown name is a 400 rather than a
     * silent drop, and an empty list means "no tools" — the restriction an
     * integrator uses to scope an agent has to mean something.
     */
    const toolsFor = (opts: AskOptions) => {
      if (!opts.toolNames) return undefined;
      const resolved = [];
      const unknown = [];
      for (const name of opts.toolNames) {
        const tool = runtime.tool(name);
        if (tool) resolved.push(tool);
        else unknown.push(name);
      }
      if (unknown.length) {
        throw badRequest(
          'unknown_tool',
          `No tool named ${unknown.map((n) => `"${n}"`).join(', ')}. Available: ${runtime.tools().map((t) => t.name).join(', ')}.`,
          'tools',
        );
      }
      return resolved;
    };

    const service: AiService = {
      async complete(orgId, request, opts = {}) {
        const tools = toolsFor(opts);
        if (request.model) assertKnownModel(request.model);
        return runtime.complete({ ...request, ...(tools ? { tools } : {}) }, {
          ...callContext(orgId, opts),
          restrictTools: tools ? tools.map((tool) => tool.name) : null,
        });
      },

      async ask(orgId, question, opts = {}) {
        // Twelve messages is six turns of context. A pronoun in turn six still
        // has to reach the account turn one named, and the engine resolves it
        // out of this transcript — nothing else carries the subject forward.
        const history: AiMessage[] = opts.threadId
          ? store.messages(orgId, opts.threadId, 16)
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .slice(-12)
              .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
          : [];
        const completion = await service.complete(orgId, {
          messages: toMessages(ctx, orgId, history, question),
          intent: opts.intent,
          responseSchema: opts.responseSchema,
          model: opts.model,
        }, opts);
        return {
          runId: completion.runId,
          content: completion.content,
          citations: completion.citations ?? [],
          reasoning: completion.reasoning ?? [],
          usage: completion.usage,
          pendingApprovals: completion.pendingApprovals,
          completion,
        };
      },

      async extract<T>(orgId: string, prompt: string, schema: SchemaNode, opts: AskOptions = {}) {
        const answer = await service.ask(orgId, prompt, { ...opts, responseSchema: schema, feature: opts.feature ?? 'extraction' });
        try { return JSON.parse(answer.content) as T; }
        catch { return null; }
      },

      draft(orgId, instruction, opts = {}) {
        const workspace = workspaceProfile(ctx, orgId);
        const profile = opts.recordId ? accountProfile(ctx, orgId, { id: opts.recordId }) : null;
        const account = profile && !('error' in profile) ? profile : null;
        const timeline = account ? recordTimeline(ctx, orgId, { record_id: account.id, limit: 8 }).items : [];
        const sender = workspace.people.find((p) => p.id === opts.actorId) ?? workspace.people[0] ?? null;
        return composeDraft({
          workspace,
          kind: opts.kind ?? detectDraftKind(instruction),
          tone: opts.tone ?? detectTone(instruction),
          instruction,
          account,
          contactId: opts.contactId ?? null,
          timeline,
          sender: sender ? { name: sender.name, title: sender.title, email: sender.email } : null,
        });
      },

      createThread(orgId, input) {
        return store.createThread(orgId, input);
      },

      async reply(orgId, threadId, message, opts = {}) {
        const thread = store.thread(orgId, threadId);
        if (!thread) throw notFound('ai thread', threadId);
        store.addMessage(orgId, threadId, { role: 'user', content: message, actorId: opts.actorId ?? null });
        const answer = await service.ask(orgId, message, { ...opts, threadId });
        store.addMessage(orgId, threadId, {
          role: 'assistant', content: answer.content, runId: answer.runId,
          citations: answer.citations, toolCalls: answer.completion.toolCalls,
        });
        return answer;
      },

      suggestions(orgId) {
        const out: { question: string; why: string; intent: string }[] = [];
        const openDeals = recordSearch(ctx, orgId, {
          object_type: 'deal',
          conditions: [{ property: 'deal_stage', op: 'in', values: stageSets(ctx, orgId).open }],
          order_by: 'amount', limit: 3,
        });
        const biggest = openDeals.records[0];
        if (biggest) {
          const account = biggest.name.split('—')[0].trim();
          out.push({
            question: `Where does ${account} stand right now?`,
            why: `${biggest.name} is the largest open deal in the pipeline.`,
            intent: 'lookup',
          });
        }
        const stale = recordSearch(ctx, orgId, {
          object_type: 'company',
          conditions: [{ property: 'type', op: 'eq', value: 'customer' }],
          date_property: 'last_activity_at',
          start: 0,
          end: ctx.now() - 45 * DAY,
          limit: 1,
        }).records[0];
        if (stale) {
          out.push({
            question: `Draft a check-in email to ${stale.name}`,
            why: `Nobody has logged activity on ${stale.name} in over 45 days.`,
            intent: 'draft',
          });
        }
        const escalated = recordSearch(ctx, orgId, {
          object_type: 'ticket',
          conditions: [{ property: 'status', op: 'in', values: ['escalated', 'waiting_on_us'] }],
          limit: 1,
        });
        if (escalated.total) {
          out.push({
            question: 'Which support tickets need attention today?',
            why: `${escalated.total} ${escalated.total === 1 ? 'ticket is' : 'tickets are'} escalated or waiting on us.`,
            intent: 'troubleshoot',
          });
        }
        out.push(
          { question: 'What is our open pipeline by stage?', why: 'Reads every open deal and groups it by stage.', intent: 'aggregate' },
          { question: 'How did bookings last quarter compare with the quarter before?', why: 'Closed-won value with a like-for-like comparison.', intent: 'compare' },
        );
        return out.slice(0, 5);
      },
    };

    ctx.provide('ai', service);

    /* A scheduled follow-up is a durable job, so the time machine replays it. */
    ctx.jobs.handle('ai.followup', (payload: { recordId: string; note: string; assigneeId: string | null; runId: string | null }, job) => {
      // The same rule the request path applies, at the other end of a job that
      // may have been waiting a year: the note this writes carries its assignee
      // as `owner_id`, which rejects anyone who is not a member. A teammate who
      // has left since the follow-up was approved would otherwise turn it into a
      // row that retries and then fails for good, and the note the operator
      // approved never lands at all. Unassigned is the honest outcome.
      const assignee = payload.assigneeId && isMember(ctx, job.org_id, payload.assigneeId)
        ? payload.assigneeId
        : null;
      const crm = ctx.svc.crm;
      if (crm) {
        crm.logActivity(job.org_id, {
          type: 'note',
          subject: `Follow-up: ${truncate(payload.note, 80)}`,
          body: payload.note,
          occurredAt: ctx.now(),
          associateTo: [payload.recordId],
        }, { actorId: assignee, actorType: 'agent', source: 'agent' });
      }
      ctx.emit(job.org_id, 'ai.followup.due', {
        record_id: payload.recordId, note: payload.note, assignee_id: assignee, run_id: payload.runId,
      }, { objectId: payload.recordId, objectType: 'record', actorType: 'agent' });
    });

    /* Seeded conversations are real runs, executed once the queue first drains. */
    ctx.jobs.handle('ai.bootstrap', async (_payload, job) => {
      const orgId = job.org_id;
      if (store.countThreads(orgId) > 0) return;
      invalidateIndex(ctx.db, orgId);
      const owner = ctx.db.get<{ user_id: string }>(
        `SELECT user_id FROM memberships WHERE org_id = ? AND role = 'owner' LIMIT 1`, orgId)?.user_id ?? null;
      const questions = service.suggestions(orgId).slice(0, 3);
      for (const suggestion of questions) {
        const thread = store.createThread(orgId, {
          title: truncate(suggestion.question, 80), createdBy: owner, feature: 'copilot',
        });
        try {
          await service.reply(orgId, thread.id, suggestion.question, { actorId: owner, feature: 'copilot' });
        } catch (e) {
          ctx.log.warn('ai.bootstrap_question_failed', { question: suggestion.question, error: (e as Error).message });
        }
      }
    });
  },

  tools(ctx) { return aiTools(ctx); },

  seed(ctx, orgId) {
    // The demo workspace opens with real conversations, so they are generated
    // against the seeded records the moment the job queue first runs.
    ctx.jobs.enqueue(orgId, 'ai.bootstrap', {}, ctx.now(), { runAt: ctx.now(), idemKey: 'ai.bootstrap' });
  },

  routes(router, ctx) {
    const store = new AiStore(ctx);
    const runtime = aiRuntime(ctx);
    const svc = () => ctx.svc.ai;

    const askOptions = (req: Req, extra: Partial<AskOptions> = {}): AskOptions => ({
      actorId: actorFor(ctx, req.auth),
      actorType: req.auth.kind === 'session' ? 'user' : req.auth.kind === 'api_key' ? 'api_key' : 'system',
      ...extra,
    });

    /* ------------------------------ completion ----------------------------- */

    router.post('/v1/ai/complete', async (req: Req, c: Ctx) => {
      const body = req.body as {
        messages?: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[];
        prompt?: string; thread_id?: string; tools?: string[]; intent?: string;
        response_schema?: SchemaNode; allow_writes?: boolean; approvals?: string[];
        feature?: string; max_steps?: number; model?: string;
      };
      if (!body.messages?.length && !body.prompt) {
        throw badRequest('missing_prompt', 'Send either `prompt` or a `messages` array.', 'prompt');
      }
      assertMayAuthoriseWrites(req);
      const opts: AskOptions = askOptions(req, {
        threadId: body.thread_id ?? null,
        feature: body.feature ?? 'copilot',
        allowWrites: body.allow_writes,
        approvals: body.approvals,
        toolNames: body.tools,
        intent: body.intent,
        responseSchema: body.response_schema,
        maxSteps: body.max_steps,
        model: body.model,
      });

      const completion = body.messages?.length
        ? await svc().complete(req.auth.orgId, {
            messages: body.messages as AiMessage[],
            intent: body.intent,
            responseSchema: body.response_schema,
            model: body.model,
          }, opts)
        : (await svc().ask(req.auth.orgId, body.prompt!, opts)).completion;

      const run = store.run(req.auth.orgId, completion.runId);
      return {
        object: 'ai_completion',
        run_id: completion.runId,
        provider: completion.degraded ? completion.degraded.answeredBy : runtime.active().id,
        model: completion.model,
        content: completion.content,
        // A run whose plan died on the budget stopped; it did not finish.
        finish_reason: completion.analysis?.budgetExhausted ? 'budget_exhausted' : completion.finishReason,
        degraded: completion.degraded ?? null,
        tool_calls: completion.toolCalls,
        citations: completion.citations ?? [],
        reasoning: completion.reasoning ?? [],
        analysis: describeAnalysis(completion),
        pending_approvals: completion.pendingApprovals,
        usage: {
          input_tokens: completion.usage.inputTokens,
          output_tokens: completion.usage.outputTokens,
          credits: completion.usage.credits,
          cost_cents: completion.usage.costCents,
          explanation: describeUsage(completion.model, completion.usage, run?.cost_micros ?? 0),
        },
        trace: completion.spans.map((span) => ({
          id: span.id, seq: span.seq, kind: span.kind, name: span.name, args: span.args,
          summary: span.summary, ok: span.ok, duration_ms: span.durationMs,
          error: span.errorCode ? { code: span.errorCode, message: span.errorMessage } : null,
        })),
        duration_ms: run?.duration_ms ?? 0,
      };
    }, {
      summary: 'Run a completion against the workspace with tools and a full trace',
      description: 'Answers from the workspace\'s own records. Without an ANTHROPIC_API_KEY the built-in deterministic engine answers; with one, the hosted model takes over and uses the same tool runtime.',
      tags: ['ai'],
      body: v.object({
        prompt: v.optional(v.string({ min: 1, max: 20_000 })),
        messages: v.optional(v.array(v.object({
          role: v.enum(['system', 'user', 'assistant', 'tool'] as const),
          content: v.string({ max: 20_000 }),
        }), { max: 40 })),
        thread_id: v.optional(v.string({ max: 80 })),
        tools: v.optional(v.array(v.string({ max: 60 }), { max: 40 })),
        intent: v.optional(v.string({ max: 40 })),
        response_schema: v.optional(v.any()),
        allow_writes: v.optional(v.boolean()),
        approvals: v.optional(v.array(v.string({ max: 60 }), { max: 10 })),
        feature: v.optional(v.string({ max: 40 })),
        max_steps: v.optional(v.int({ min: 1, max: 12 })),
        model: v.optional(v.string({ max: 60 })),
      }),
    });

    /* -------------------------------- threads ------------------------------ */

    router.post('/v1/ai/threads', async (req: Req, c: Ctx) => {
      const body = req.body as { title?: string; message?: string; subject_id?: string; subject_type?: string };
      const title = body.title ?? (body.message ? truncate(body.message, 70) : 'New conversation');
      const startedBy = actorFor(ctx, req.auth);
      const thread = store.createThread(req.auth.orgId, {
        title,
        subjectId: body.subject_id ?? null,
        subjectType: body.subject_type ?? null,
        createdBy: startedBy,
      });
      c.emit(req.auth.orgId, 'ai.thread.created', { id: thread.id, title }, {
        objectId: thread.id, objectType: 'ai_thread', actorId: startedBy, actorType: 'user',
      });
      if (!body.message) return created({ ...publicThread(thread), messages: [] });
      const answer = await svc().reply(req.auth.orgId, thread.id, body.message, askOptions(req));
      return created({
        ...publicThread(store.thread(req.auth.orgId, thread.id)!),
        messages: store.messages(req.auth.orgId, thread.id).map(publicMessage),
        run_id: answer.runId,
      });
    }, {
      summary: 'Start a copilot conversation', tags: ['ai'],
      body: v.object({
        title: v.optional(v.string({ min: 1, max: 200 })),
        message: v.optional(v.string({ min: 1, max: 20_000 })),
        subject_id: v.optional(v.string({ max: 80 })),
        subject_type: v.optional(v.string({ max: 40 })),
      }),
    });

    router.get('/v1/ai/threads', (req: Req) => {
      const q = req.query as { status?: string; subject_id?: string; limit?: number; offset?: number };
      const rows = store.threads(req.auth.orgId, {
        status: q.status, subjectId: q.subject_id, limit: q.limit ?? 25, offset: q.offset ?? 0,
      });
      return list(rows.map(publicThread), {
        totalCount: store.countThreads(req.auth.orgId, q.status),
        hasMore: rows.length === (q.limit ?? 25),
      });
    }, {
      summary: 'List copilot conversations', tags: ['ai'],
      query: v.object({
        status: v.optional(v.enum(['open', 'archived'] as const)),
        subject_id: v.optional(v.string({ max: 80 })),
        limit: v.optional(v.int({ min: 1, max: 100 })),
        offset: v.optional(v.int({ min: 0, max: 10_000 })),
      }),
    });

    router.get('/v1/ai/threads/:id', (req: Req) => {
      const thread = store.thread(req.auth.orgId, req.params.id);
      if (!thread) throw notFound('ai thread', req.params.id);
      const messages = store.messages(req.auth.orgId, thread.id);
      const runs = store.runs(req.auth.orgId, { threadId: thread.id, limit: 25 });
      return {
        ...publicThread(thread),
        messages: messages.map(publicMessage),
        runs: runs.map((run) => publicRun(run)),
      };
    }, { summary: 'Retrieve a conversation with its messages and runs', tags: ['ai'] });

    router.get('/v1/ai/threads/:id/messages', (req: Req) => {
      const thread = store.thread(req.auth.orgId, req.params.id);
      if (!thread) throw notFound('ai thread', req.params.id);
      return list(store.messages(req.auth.orgId, thread.id).map(publicMessage), { totalCount: thread.message_count });
    }, { summary: 'List the messages in a conversation', tags: ['ai'] });

    router.post('/v1/ai/threads/:id/messages', async (req: Req) => {
      const thread = store.thread(req.auth.orgId, req.params.id);
      if (!thread) throw notFound('ai thread', req.params.id);
      assertMayAuthoriseWrites(req);
      const body = req.body as { content: string; allow_writes?: boolean; approvals?: string[]; tools?: string[] };
      const answer = await svc().reply(req.auth.orgId, thread.id, body.content, askOptions(req, {
        allowWrites: body.allow_writes,
        approvals: body.approvals,
        toolNames: body.tools,
      }));
      const messages = store.messages(req.auth.orgId, thread.id);
      return created({
        object: 'ai_reply',
        thread_id: thread.id,
        run_id: answer.runId,
        message: publicMessage(messages[messages.length - 1]),
        citations: answer.citations,
        reasoning: answer.reasoning,
        pending_approvals: answer.pendingApprovals,
        usage: {
          input_tokens: answer.usage.inputTokens,
          output_tokens: answer.usage.outputTokens,
          credits: answer.usage.credits,
        },
      });
    }, {
      summary: 'Send a message and get the grounded reply', tags: ['ai'],
      body: v.object({
        content: v.string({ min: 1, max: 20_000 }),
        allow_writes: v.optional(v.boolean()),
        approvals: v.optional(v.array(v.string({ max: 60 }), { max: 10 })),
        tools: v.optional(v.array(v.string({ max: 60 }), { max: 40 })),
      }),
    });

    /* --------------------------------- tools ------------------------------- */

    router.get('/v1/ai/tools', (req: Req, c: Ctx) => {
      const q = req.query as { tag?: string; read_only?: boolean };
      const tools = c.ai.tools({
        ...(q.tag ? { tags: [q.tag] } : {}),
        ...(q.read_only === undefined ? {} : { readOnly: q.read_only }),
      });
      return list(tools.map((tool) => ({
        object: 'ai_tool' as const,
        name: tool.name,
        description: tool.description,
        read_only: tool.readOnly,
        requires_approval: !!tool.requiresApproval,
        tags: tool.tags ?? [],
        input_schema: tool.input.describe(),
      })), { totalCount: c.ai.tools().length });
    }, {
      summary: 'The live tool catalogue every agent can call', tags: ['ai'],
      query: v.object({ tag: v.optional(v.string({ max: 40 })), read_only: v.optional(v.boolean()) }),
    });

    router.get('/v1/ai/metrics', () => list(metricCatalogue().map((m) => ({ object: 'ai_metric' as const, ...m }))),
      { summary: 'The metric catalogue the engine can compute', tags: ['ai'] });

    router.get('/v1/ai/suggestions', (req: Req) =>
      list(svc().suggestions(req.auth.orgId).map((s) => ({ object: 'ai_suggestion' as const, ...s }))),
      { summary: 'Starter questions computed from this workspace', tags: ['ai'] });

    /* ---------------------------------- runs ------------------------------- */

    router.get('/v1/ai/runs', (req: Req) => {
      const q = req.query as { status?: string; feature?: string; thread_id?: string; limit?: number; offset?: number };
      const rows = store.runs(req.auth.orgId, {
        status: q.status, feature: q.feature, threadId: q.thread_id, limit: q.limit ?? 25, offset: q.offset ?? 0,
      });
      return list(rows.map((row) => publicRun(row)), {
        totalCount: store.countRuns(req.auth.orgId, { status: q.status, feature: q.feature }),
        hasMore: rows.length === (q.limit ?? 25),
      });
    }, {
      summary: 'Every AI run, newest first', tags: ['ai'],
      query: v.object({
        status: v.optional(v.enum(['running', 'succeeded', 'failed', 'needs_approval'] as const)),
        feature: v.optional(v.string({ max: 40 })),
        thread_id: v.optional(v.string({ max: 80 })),
        limit: v.optional(v.int({ min: 1, max: 100 })),
        offset: v.optional(v.int({ min: 0, max: 10_000 })),
      }),
    });

    router.get('/v1/ai/runs/:id', (req: Req) => {
      const run = store.run(req.auth.orgId, req.params.id);
      if (!run) throw notFound('ai run', req.params.id);
      const spans = store.spans(req.auth.orgId, run.id);
      return {
        ...publicRun(run, spans),
        approvals: store.approvals(req.auth.orgId).filter((a) => a.run_id === run.id)
          .map((a) => publicApproval(a, recordNamer(ctx, req.auth.orgId))),
        timings: {
          total_ms: run.duration_ms,
          tool_ms: spans.filter((s) => s.kind === 'tool').reduce((a, s) => a + s.duration_ms, 0),
          slowest: spans.slice().sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 3).map(publicSpan),
        },
      };
    }, { summary: 'One run with its full trace, timings and cost', tags: ['ai'] });

    /* -------------------------------- approvals ---------------------------- */

    router.get('/v1/ai/approvals', (req: Req) => {
      const q = req.query as { status?: string };
      const nameOf = recordNamer(ctx, req.auth.orgId);
      return list(store.approvals(req.auth.orgId, q.status ?? 'pending').map((a) => publicApproval(a, nameOf)));
    }, {
      summary: 'Writes an agent is waiting to make', tags: ['ai'],
      query: v.object({ status: v.optional(v.enum(['pending', 'approved', 'declined'] as const)) }),
    });

    router.post('/v1/ai/approvals/:id', async (req: Req, c: Ctx) => {
      const approval = store.approval(req.auth.orgId, req.params.id);
      if (!approval) throw notFound('approval', req.params.id);
      // The same resolution the ask routes use: a key acts as the teammate who
      // created it, and a caller who is no longer a member acts as nobody. What
      // this route executes hands its actor to the CRM as an owner, so an id
      // that is not a live member fails the very write it was approving.
      const decidedBy = actorFor(c, req.auth);
      if (approval.status !== 'pending') {
        throw badRequest('approval_decided', `This request was already ${approval.status}.`, 'id');
      }
      const body = req.body as { decision: 'approve' | 'decline'; note?: string };
      if (body.decision === 'decline') {
        store.decideApproval(req.auth.orgId, approval.id, 'declined', decidedBy, body.note ?? 'Declined by an operator.');
        c.emit(req.auth.orgId, 'ai.approval.declined', { id: approval.id, tool: approval.tool, run_id: approval.run_id }, {
          objectId: approval.id, objectType: 'ai_approval', actorId: decidedBy, actorType: 'user',
        });
        return publicApproval(store.approval(req.auth.orgId, approval.id)!, recordNamer(c, req.auth.orgId));
      }

      // Arguments are re-validated here, not just when the plan was made: an
      // approval can sit in the queue while the schema, the record or the
      // assignee it names changes underneath it.
      const definition = runtime.tool(approval.tool);
      const args = JSON.parse(approval.args) as Record<string, unknown>;
      if (!definition) {
        store.decideApproval(req.auth.orgId, approval.id, 'declined', decidedBy,
          `Blocked: no tool named "${approval.tool}" is registered any more.`);
        throw badRequest('tool_unavailable', `"${approval.tool}" is no longer registered, so this approval cannot be executed.`, 'id');
      }
      try {
        definition.input.parse(args);
      } catch (e) {
        const message = (e as Error).message;
        store.decideApproval(req.auth.orgId, approval.id, 'declined', decidedBy, `Blocked: ${message}`);
        c.emit(req.auth.orgId, 'ai.approval.declined', {
          id: approval.id, tool: approval.tool, run_id: approval.run_id, reason: 'invalid_arguments',
        }, { objectId: approval.id, objectType: 'ai_approval', actorId: decidedBy, actorType: 'user' });
        throw badRequest(
          'approval_arguments_invalid',
          `This approval cannot run: ${message} It has been declined rather than executed with bad arguments.`,
          'args',
        );
      }

      // Shape is not the only thing that can change under a queued approval.
      // The record it names can be archived, merged or deleted while it waits,
      // and a note written onto a record that is gone is a write nobody asked
      // for landing where nobody will read it.
      const moved = writeTargets(args)
        .map((id) => recordStanding(c, req.auth.orgId, id))
        .filter((standing) => standing.state !== 'live');
      if (moved.length) {
        const why = moved.map(describeStanding).join('; ');
        store.decideApproval(req.auth.orgId, approval.id, 'declined', decidedBy,
          `Blocked: ${why}.`);
        c.emit(req.auth.orgId, 'ai.approval.declined', {
          id: approval.id, tool: approval.tool, run_id: approval.run_id, reason: 'target_changed',
          targets: moved.map((s) => ({ id: s.id, state: s.state })),
        }, { objectId: approval.id, objectType: 'ai_approval', actorId: decidedBy, actorType: 'user' });
        throw badRequest(
          'approval_target_changed',
          `This approval cannot run: ${why}. It was prepared against ${moved.length === 1 ? 'a record' : 'records'} that changed while it waited, so it has been declined rather than written to ${moved.length === 1 ? 'the wrong place' : 'the wrong places'}. Ask again and I will prepare it against what is there now.`,
          'args',
        );
      }

      const call: AiCallContext = {
        ctx: c,
        orgId: req.auth.orgId,
        actorId: decidedBy,
        actorType: 'user',
        runId: approval.run_id,
        threadId: approval.thread_id,
        feature: 'approval',
        allowWrites: true,
        approvals: [approval.tool],
        startedNs: process.hrtime.bigint(),
      };
      const execution = await runtime.execute(approval.tool, args, call, definition);
      store.decideApproval(
        req.auth.orgId, approval.id, 'approved', decidedBy,
        execution.ok ? execution.span.summary : `Failed: ${execution.error?.message}`,
      );
      const stillWaiting = c.db.count(
        `SELECT COUNT(*) FROM ai_approvals WHERE org_id = ? AND run_id = ? AND status = 'pending'`,
        req.auth.orgId, approval.run_id);
      if (execution.ok && !stillWaiting) {
        c.db.patch('ai_runs', 'id', approval.run_id, { status: 'succeeded' });
      }
      c.emit(req.auth.orgId, 'ai.approval.granted', {
        id: approval.id, tool: approval.tool, run_id: approval.run_id, ok: execution.ok,
      }, { objectId: approval.id, objectType: 'ai_approval', actorId: decidedBy, actorType: 'user' });
      c.audit({
        orgId: req.auth.orgId, actorId: decidedBy, actorType: 'user', action: 'ai.approval.granted',
        targetType: 'ai_approval', targetId: approval.id, summary: `Approved ${approval.tool} for run ${approval.run_id}`,
        after: execution.ok ? { result: execution.span.summary } : { error: execution.error?.message },
        requestId: req.requestId,
      });
      return {
        ...publicApproval(store.approval(req.auth.orgId, approval.id)!, recordNamer(c, req.auth.orgId)),
        executed: execution.ok,
        result: execution.ok ? execution.result : null,
        error: execution.error ?? null,
      };
    }, {
      summary: 'Approve or decline a write an agent asked to make', tags: ['ai'], roles: ['member'],
      body: v.object({
        decision: v.enum(['approve', 'decline'] as const),
        note: v.optional(v.string({ max: 500 })),
      }),
    });

    /* ---------------------------------- draft ------------------------------ */

    router.post('/v1/ai/draft', (req: Req) => {
      const body = req.body as { instruction: string; record_id?: string; contact_id?: string; kind?: DraftKind; tone?: Tone };
      const draft = svc().draft(req.auth.orgId, body.instruction, {
        recordId: body.record_id,
        contactId: body.contact_id,
        kind: body.kind,
        tone: body.tone,
        actorId: actorFor(ctx, req.auth),
      });
      return { object: 'ai_draft', ...draft };
    }, {
      summary: 'Draft an email, summary or note from a record', tags: ['ai'],
      body: v.object({
        instruction: v.string({ min: 3, max: 2000 }),
        record_id: v.optional(v.string({ max: 80 })),
        contact_id: v.optional(v.string({ max: 80 })),
        kind: v.optional(v.enum(DRAFT_KINDS)),
        tone: v.optional(v.enum(TONES)),
      }),
    });

    /* ---------------------------------- usage ------------------------------ */

    router.get('/v1/ai/usage', (req: Req, c: Ctx) => {
      const q = req.query as { days?: number; feature?: string; user_id?: string };
      const days = q.days ?? 30;
      const since = c.now() - days * DAY;
      const rows = store.usage(req.auth.orgId, { since, feature: q.feature, userId: q.user_id });
      const people = new Map(workspaceProfile(c, req.auth.orgId).people.map((p) => [p.id, p.name]));

      const sum = (key: 'runs' | 'credits' | 'input_tokens' | 'output_tokens' | 'cost_micros' | 'tool_calls') =>
        rows.reduce((total, row) => total + row[key], 0);

      const bucket = <T extends string>(pick: (row: (typeof rows)[number]) => T) => {
        const map = new Map<T, { runs: number; credits: number; input_tokens: number; output_tokens: number; cost_micros: number; tool_calls: number }>();
        for (const row of rows) {
          const key = pick(row);
          const entry = map.get(key) ?? { runs: 0, credits: 0, input_tokens: 0, output_tokens: 0, cost_micros: 0, tool_calls: 0 };
          entry.runs += row.runs; entry.credits += row.credits; entry.input_tokens += row.input_tokens;
          entry.output_tokens += row.output_tokens; entry.cost_micros += row.cost_micros; entry.tool_calls += row.tool_calls;
          map.set(key, entry);
        }
        return [...map.entries()].map(([key, value]) => ({ key, ...value, cost_cents: Math.round(value.cost_micros / 1_000_000) }));
      };

      return {
        object: 'ai_usage',
        period: { days, since: dayKey(since), until: dayKey(c.now()) },
        totals: {
          runs: sum('runs'),
          credits: sum('credits'),
          input_tokens: sum('input_tokens'),
          output_tokens: sum('output_tokens'),
          tool_calls: sum('tool_calls'),
          cost_cents: Math.round(sum('cost_micros') / 1_000_000),
          cost_micros: sum('cost_micros'),
        },
        by_day: bucket((row) => row.day).sort((a, b) => a.key.localeCompare(b.key)),
        by_feature: bucket((row) => row.feature).sort((a, b) => b.credits - a.credits),
        by_user: bucket((row) => row.user_id).map((row) => ({ ...row, name: people.get(row.key) ?? 'System' })).sort((a, b) => b.credits - a.credits),
        by_model: bucket((row) => row.model).sort((a, b) => b.credits - a.credits),
      };
    }, {
      summary: 'AI credit consumption by day, feature, user and model', tags: ['ai'],
      query: v.object({
        days: v.optional(v.int({ min: 1, max: 365 })),
        feature: v.optional(v.string({ max: 40 })),
        user_id: v.optional(v.string({ max: 80 })),
      }),
    });

    router.get('/v1/ai/status', (req: Req, c: Ctx) => {
      const active = c.ai.active();
      return {
        object: 'ai_status',
        provider: { id: active.id, label: active.label, hosted: active.id === 'anthropic' },
        providers: c.ai.providers.map((p) => ({ id: p.id, label: p.label, available: p.available() })),
        tools: c.ai.tools().length,
        metrics: metricCatalogue().length,
        runs_today: c.db.count(
          `SELECT COUNT(*) FROM ai_runs WHERE org_id = ? AND started >= ?`, req.auth.orgId, c.now() - DAY),
        pending_approvals: c.db.count(
          `SELECT COUNT(*) FROM ai_approvals WHERE org_id = ? AND status = 'pending'`, req.auth.orgId),
      };
    }, { summary: 'Which provider is answering, and what it can reach', tags: ['ai'] });
  },
});
