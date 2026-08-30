/**
 * The built-in reasoning engine.
 *
 * Ain is fully intelligent with no API key and no network, because this
 * provider does the work a hosted model would do — classify the request,
 * resolve which records it is about, plan and run tools, and write a grounded
 * answer — deterministically, against the workspace's own database. Every
 * decision it makes is reported in `reasoning[]`, every fact it states carries
 * a citation, and the same code path runs whether or not a frontier model is
 * configured, so behaviour never changes underneath a demo.
 */
import type { AiCompletion, AiCompletionRequest, AiProvider, AiToolCall, AiToolDef } from '../kernel/ai';
import type { Ctx } from '../kernel/context';
import type { AiCallContext, AinAiRuntime, PendingApproval, AiTraceSpan } from './runtime';
import { classifyIntent, describeIntent, type IntentResult, type TaskIntent } from './intent';
import { defaultWindow, describeWindow, resolveWindow, type TimeWindow } from './dates';
import { entityIndex, workspaceProfile, type WorkspaceProfile } from './grounding';
import { extractMentions, mentionedTypes, resolveEntities, type ResolvedEntity } from './resolve';
import { detectGrouping, detectMetric, stageSets, type GroupBy, type MetricDetection, type MetricSubject } from './metrics';
import { planSteps, replan, type PlannedStep } from './plan';
import {
  accountProfile, businessMetric, recordAggregate, recordSearch, recordTimeline, workspaceSearch,
  type AccountProfileResult, type TimelineItem,
} from './functions';
import { composeDraft, detectDraftKind, detectTone, type DraftKind, type DraftResult, type Tone } from './draft';
import { extractStructured } from './extract';
import { synthesise, type StepResult } from './synth';
import { accountUsage, estimateTokens, messageTokens, toolTokens } from './usage';
import { truncate } from './text';

export const ENGINE_MODEL = 'ain-engine-1';

export interface EngineAnalysis {
  question: string;
  intent: IntentResult;
  window: TimeWindow;
  windowFromQuestion: boolean;
  entities: { id: string; label: string; type: string; score: number; rule: string; mention: string }[];
  subject: MetricSubject | null;
  metric: { id: string; label: string; matched: string; score: number } | null;
  groupBy: GroupBy;
  types: string[];
  tone: Tone;
  draftKind: DraftKind | null;
  plan: { tool: string; why: string; args: Record<string, unknown> }[];
  steps: { tool: string; ok: boolean; code: string | null; ms: number }[];
  passes: number;
}

const SUBJECT_TYPES = ['company', 'customer', 'contact'];

const asSubject = (entity: ResolvedEntity | undefined): MetricSubject | null =>
  entity ? { id: entity.entity.id, type: entity.entity.type, label: entity.entity.label } : null;

/** Run one of the engine's own capabilities directly, by name. */
function callBuiltin(name: string, args: Record<string, unknown>, ctx: Ctx, orgId: string): unknown {
  switch (name) {
    case 'workspace_search': return workspaceSearch(ctx, orgId, args as { query: string; types?: string[]; limit?: number });
    case 'account_profile': return accountProfile(ctx, orgId, args as { id: string });
    case 'business_metric': return businessMetric(ctx, orgId, args as Parameters<typeof businessMetric>[2]);
    case 'record_search': return recordSearch(ctx, orgId, args as Parameters<typeof recordSearch>[2]);
    case 'record_aggregate': return recordAggregate(ctx, orgId, args as Parameters<typeof recordAggregate>[2]);
    case 'record_timeline': return recordTimeline(ctx, orgId, args as { record_id: string; limit?: number });
    default: throw new Error(`No built-in capability named "${name}".`);
  }
}

async function executeStep(
  call: AiCallContext,
  step: PlannedStep,
  tools: Map<string, AiToolDef>,
): Promise<StepResult> {
  const runtime = call.runtime;
  const definition = tools.get(step.tool) ?? call.runtime?.tool(step.tool);
  // If nothing registered this capability, run our own implementation instead
  // of asking the runtime for a tool that does not exist.
  if (runtime && !definition && step.builtin) {
    const started = process.hrtime.bigint();
    try {
      const result = callBuiltin(step.builtin, step.args, call.ctx, call.orgId);
      runtime.note(call, 'tool', `${step.builtin} (built-in)`, summarise(result), Number((process.hrtime.bigint() - started) / 1_000_000n));
      return { tool: step.tool, ok: true, why: step.why, args: step.args, result };
    } catch (e) {
      return { tool: step.tool, ok: false, why: step.why, args: step.args, error: { code: 'tool_failed', message: (e as Error).message } };
    }
  }
  if (runtime) {
    const execution = await runtime.execute(step.tool, step.args, call, definition);
    if (execution.ok) {
      return { tool: step.tool, ok: true, why: step.why, args: step.args, result: execution.result };
    }
    // A capability the workspace never registered still works: it is our own
    // code, and the trace records it as a built-in rather than a tool call.
    if (execution.error?.code === 'tool_not_found' && step.builtin) {
      const started = process.hrtime.bigint();
      try {
        const result = callBuiltin(step.builtin, step.args, call.ctx, call.orgId);
        runtime.note(call, 'tool', `${step.builtin} (built-in)`, summarise(result), Number((process.hrtime.bigint() - started) / 1_000_000n));
        return { tool: step.tool, ok: true, why: step.why, args: step.args, result };
      } catch (e) {
        return { tool: step.tool, ok: false, why: step.why, args: step.args, error: { code: 'tool_failed', message: (e as Error).message } };
      }
    }
    return {
      tool: step.tool, ok: false, why: step.why, args: step.args,
      error: { code: execution.error?.code ?? 'tool_failed', message: execution.error?.message ?? 'Tool failed.' },
    };
  }
  try {
    const result = step.builtin
      ? callBuiltin(step.builtin, step.args, call.ctx, call.orgId)
      : await definition?.run(definition.input.parse(step.args), call.ctx, { orgId: call.orgId, actorId: call.actorId ?? undefined });
    return { tool: step.tool, ok: true, why: step.why, args: step.args, result };
  } catch (e) {
    return { tool: step.tool, ok: false, why: step.why, args: step.args, error: { code: 'tool_failed', message: (e as Error).message } };
  }
}

const summarise = (value: unknown): string => {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('formatted' in record) return `${String(record.formatted)} (${String(record.source ?? '')})`;
    if ('name' in record) return String(record.name);
    if ('matches' in record) return `${(record.matches as unknown[]).length} matches`;
    if ('items' in record) return `${(record.items as unknown[]).length} timeline items`;
    if ('records' in record) return `${(record.records as unknown[]).length} records`;
  }
  return truncate(JSON.stringify(value ?? null), 120);
};

const lastUserMessage = (req: AiCompletionRequest): string =>
  [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

/** Earlier turns still name the account, so the whole thread feeds resolution. */
const conversationContext = (req: AiCompletionRequest): string =>
  req.messages.filter((m) => m.role === 'user').slice(-3).map((m) => m.content).join('\n');

export function builtinEngine(): AiProvider {
  return {
    id: 'builtin',
    label: 'Ain reasoning engine',
    available: () => true,

    async complete(req: AiCompletionRequest, input: unknown): Promise<AiCompletion> {
      const call = input as AiCallContext;
      if (!call?.ctx) throw new Error('The built-in engine needs a request context: pass ctx to ai.complete().');
      const runtime = call.runtime as AinAiRuntime | undefined;
      const ctx = call.ctx;
      const orgId = call.orgId;
      const question = lastUserMessage(req);
      const reasoning: string[] = [];
      const workspace = workspaceProfile(ctx, orgId);

      reasoning.push(
        `Workspace ${workspace.name}: currency ${workspace.currency.toUpperCase()}, timezone ${workspace.timezone}, clock ${new Date(workspace.now).toISOString()}.`,
      );

      /* 1. what kind of task is this */
      const intent = classifyIntent(question, req.intent);
      reasoning.push(describeIntent(intent));
      runtime?.note(call, 'plan', 'classify_intent', describeIntent(intent));

      /* 2. what period */
      const explicit = resolveWindow(question, workspace.now);
      const window = explicit ?? defaultWindow(workspace.now);
      reasoning.push(explicit
        ? `Period "${explicit.matched.trim()}" → ${window.label} (${describeWindow(window, workspace.locale)}).`
        : `No period in the question; defaulting to ${window.label}.`);

      /* 3. which records */
      const types = mentionedTypes(question);
      const metric = detectMetric(question);
      const prefer = metric?.metric.supportsSubject ? ['company', 'customer', 'contact'] : types;
      const entities = resolveEntities(conversationContext(req), entityIndex(ctx, orgId), {
        prefer, limit: 6, dedupe: true,
      });
      const subject = asSubject(entities.find((e) => SUBJECT_TYPES.includes(e.entity.type)));
      reasoning.push(entities.length
        ? `Resolved ${entities.length} ${entities.length === 1 ? 'record' : 'records'}: ${entities.slice(0, 3).map((e) => `${e.entity.label} (${e.entity.type}, ${e.score.toFixed(2)}, ${e.rule})`).join('; ')}.`
        : 'No workspace record matched the question by id, email, domain, name, acronym or trigram similarity.');
      if (entities.length) {
        runtime?.note(call, 'resolve', 'resolve_entities', entities.slice(0, 4).map((e) => e.explain).join(' | '));
      }

      /* 4. which metric and grouping */
      const groupBy = detectGrouping(question);
      if (metric) reasoning.push(`Metric: ${metric.metric.label} (matched "${metric.matched}", score ${metric.score})${metric.alternatives.length ? `, over ${metric.alternatives.map((a) => a.id).join(', ')}` : ''}.`);
      if (groupBy !== 'none') reasoning.push(`Grouping requested: by ${groupBy}.`);

      /* 5. plan */
      const budget = runtime?.budget(call) ?? { steps: 6, timeMs: 10_000, callsPerMinute: 600 };
      const available = req.tools ?? [];
      const toolIndex = new Map(available.map((tool) => [tool.name, tool]));
      const planInput = {
        question, intent: intent.intent, window, entities, subject, metric, groupBy, types,
        stages: stageSets(ctx, orgId),
        namedSomething: extractMentions(question).some((mention) => mention.kind !== 'ngram'),
        tools: available, workspace, maxSteps: Math.max(1, budget.steps - 1),
      };
      const plan = planSteps(planInput);
      reasoning.push(plan.length
        ? `Plan (${plan.length} ${plan.length === 1 ? 'step' : 'steps'}, budget ${budget.steps}): ${plan.map((s) => s.tool).join(' → ')}.`
        : 'No tool was needed to answer this.');
      for (const step of plan) reasoning.push(`  ${step.tool}: ${step.why}`);
      runtime?.note(call, 'plan', 'plan_tools', plan.map((s) => `${s.tool}(${Object.keys(s.args).join(',')})`).join(' → ') || 'no tools required');

      /* 6. execute, then one replanning pass with whatever budget is left */
      const steps: StepResult[] = [];
      const executed: { tool: string; result: unknown }[] = [];
      const traced: EngineAnalysis['steps'] = [];
      let passes = plan.length ? 1 : 0;

      for (const step of plan) {
        const before = process.hrtime.bigint();
        const outcome = await executeStep(call, step, toolIndex);
        const ms = Number((process.hrtime.bigint() - before) / 1_000_000n);
        steps.push(outcome);
        traced.push({ tool: step.tool, ok: outcome.ok, code: outcome.error?.code ?? null, ms });
        if (outcome.ok) {
          executed.push({ tool: step.tool, result: outcome.result });
          reasoning.push(`Ran ${step.tool} in ${ms}ms → ${summarise(outcome.result)}.`);
        } else {
          reasoning.push(`${step.tool} failed (${outcome.error?.code}): ${outcome.error?.message}`);
          if (outcome.error?.code === 'step_budget_exhausted' || outcome.error?.code === 'time_budget_exhausted') break;
        }
      }

      const remaining = Math.max(0, budget.steps - (call.steps ?? steps.length));
      const second = replan(planInput, executed, Math.min(remaining, 2));
      if (second.length) {
        passes += 1;
        reasoning.push(`Second pass: ${second.map((s) => `${s.tool} — ${s.why}`).join(' ')}`);
        for (const step of second) {
          const before = process.hrtime.bigint();
          const outcome = await executeStep(call, step, toolIndex);
          const ms = Number((process.hrtime.bigint() - before) / 1_000_000n);
          steps.push(outcome);
          traced.push({ tool: step.tool, ok: outcome.ok, code: outcome.error?.code ?? null, ms });
          if (outcome.ok) {
            executed.push({ tool: step.tool, result: outcome.result });
            reasoning.push(`Ran ${step.tool} in ${ms}ms → ${summarise(outcome.result)}.`);
          } else {
            reasoning.push(`${step.tool} failed (${outcome.error?.code}): ${outcome.error?.message}`);
          }
        }
      }

      /* 7. draft, extract or answer */
      const tone = detectTone(question);
      const draftKind = intent.intent === 'draft' ? detectDraftKind(question) : null;
      let draft: DraftResult | null = null;
      if (draftKind) {
        const profile = steps.map((s) => s.result).find((r) => !!r && typeof r === 'object' && 'totals' in (r as object)) as AccountProfileResult | undefined;
        const timeline = steps.map((s) => s.result).find((r) => !!r && typeof r === 'object' && 'items' in (r as object)) as { items: TimelineItem[] } | undefined;
        const sender = workspace.people.find((p) => p.id === call.actorId) ?? workspace.people[0] ?? null;
        draft = composeDraft({
          workspace,
          kind: draftKind,
          tone,
          instruction: question,
          account: profile ?? null,
          contactId: entities.find((e) => e.entity.type === 'contact')?.entity.id ?? null,
          timeline: timeline?.items ?? [],
          sender: sender ? { name: sender.name, title: sender.title, email: sender.email } : null,
        });
        reasoning.push(`Drafted a ${draftKind.replace(/_/g, ' ')} in a ${tone} tone from ${draft.personalisation.length} verified ${draft.personalisation.length === 1 ? 'fact' : 'facts'}.`);
      }

      const synthesis = synthesise({
        question, intent, workspace, window, subject, entities, steps, metric, draft,
        pendingApprovals: (call.pendingApprovals ?? []) as PendingApproval[],
      });

      let content = synthesis.content;
      if (req.responseSchema) {
        const metricResult = executed.map((e) => e.result).find((r) => !!r && typeof r === 'object' && 'formatted' in (r as object)) as { value?: number; formatted?: string } | undefined;
        const extraction = extractStructured(req.responseSchema, {
          question,
          answer: synthesis.content,
          workspace,
          entities,
          window,
          results: executed,
          metricValue: metricResult?.value ?? null,
          metricFormatted: metricResult?.formatted ?? null,
          confidence: intent.confidence,
        });
        content = JSON.stringify(extraction.value, null, 2);
        reasoning.push(`Filled ${extraction.filled.length} schema ${extraction.filled.length === 1 ? 'field' : 'fields'}${extraction.missing.length ? `, left ${extraction.missing.join(', ')} null rather than guessing` : ''}.`);
      }

      runtime?.note(call, 'synthesis', 'compose_answer',
        `${content.split('\n\n').length} blocks, ${synthesis.citations.length} citations, ${steps.filter((s) => s.ok).length}/${steps.length} tools succeeded`);

      /* 8. account for the run */
      const inputTokens = messageTokens(req.messages) + toolTokens(req.tools) + estimateTokens(reasoning.join(' '));
      const outputTokens = estimateTokens(content);
      const { usage, costMicros } = accountUsage(ENGINE_MODEL, inputTokens, outputTokens);
      reasoning.push(`Usage: ${usage.inputTokens} input + ${usage.outputTokens} output tokens, ${usage.credits} credits, ${costMicros === 0 ? 'no marginal cost (local engine)' : `${(costMicros / 1_000_000).toFixed(4)}¢`}.`);

      const toolCalls: AiToolCall[] = steps
        .filter((s) => s.ok)
        .map((s, index) => ({ id: `call_${index + 1}`, name: s.tool, arguments: s.args }));

      const analysis: EngineAnalysis = {
        question,
        intent,
        window,
        windowFromQuestion: !!explicit,
        entities: entities.map((e) => ({ id: e.entity.id, label: e.entity.label, type: e.entity.type, score: e.score, rule: e.rule, mention: e.mention })),
        subject,
        metric: metric ? { id: metric.metric.id, label: metric.metric.label, matched: metric.matched, score: metric.score } : null,
        groupBy,
        types,
        tone,
        draftKind,
        plan: plan.map((s) => ({ tool: s.tool, why: s.why, args: s.args })),
        steps: traced,
        passes,
      };

      const completion: AiCompletion & { analysis: EngineAnalysis; spans: AiTraceSpan[] } = {
        content,
        toolCalls,
        finishReason: (call.pendingApprovals?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
        usage,
        model: ENGINE_MODEL,
        reasoning,
        citations: synthesis.citations,
        analysis,
        spans: call.spans ?? [],
      };
      return completion;
    },
  };
}

export type { StepResult, TaskIntent, WorkspaceProfile };
