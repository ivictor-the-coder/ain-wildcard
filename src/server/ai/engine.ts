/**
 * The built-in engine: a template whitelist.
 *
 * With no hosted model configured, this answers free text — and only the free
 * text that is one of the shapes in `templates.ts`, with every slot bound to a
 * typed value. Everything else is refused, with the three nearest shapes
 * offered as questions this workspace can answer. It runs its plan through the
 * same tool runtime, under the same read-only, allowlist, budget and approval
 * gates, and produces the same trace shape as the hosted provider; the trace
 * says which engine answered.
 */
import type { AiCompletion, AiCompletionRequest, AiProvider, AiToolCall, AiToolDef } from '../kernel/ai';
import type { AiCallContext, AinAiRuntime, AiTraceSpan } from './runtime';
import type { SchemaNode } from '../../shared/validate';
import { vocabulary, type Bindings, type Vocabulary } from './slots';
import {
  catalogueFor, matchTemplates, nearestTemplates, type Nearest, type PlanStep, type StepOutcome, type Template, type TemplateIntent,
} from './templates';
import { NO_FACTS, renderRefusal, type Citation, type Facts } from './answer';
import { fillSchema, normaliseResponseSchema } from './extract';
import { accountUsage, estimateTokens, messageTokens, toolTokens } from './usage';
import type { QualifierKind } from './qualifiers';

export const ENGINE_MODEL = 'ain-engine-1';

export type RefusalCode = 'no_template' | 'slot_unbound' | 'no_tools' | 'tool_failed';

export interface EngineAnalysis {
  question: string;
  /** Which engine produced this answer. */
  engine: 'template';
  intent: TemplateIntent | null;
  template: { id: string; kind: string; description: string; example: string | null } | null;
  /** Every slot the question filled, and the typed value it bound to. */
  slots: { name: string; kind: string; text: string; label: string; qualifier: QualifierKind | null }[];
  refusal: { code: RefusalCode; why: string } | null;
  /** The shapes offered instead, as concrete questions. */
  nearest: Nearest[];
  plan: PlanStep[];
  steps: { tool: string; ok: boolean; code: string | null; ms: number }[];
  writeBlocked: { wanted: string; reason: string } | null;
  scopedTools: string[] | null;
  budgetExhausted: boolean;
  facts: Facts;
}

const lastUserMessage = (req: AiCompletionRequest): string =>
  [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

const elapsedMs = (from: bigint): number => Number((process.hrtime.bigint() - from) / 1_000_000n);

/** A slot's bound value, in one word a reader recognises. */
function labelOf(b: Bindings[string]): string {
  const value = b.value;
  switch (value.kind) {
    case 'object': return value.plural;
    case 'state': return value.label;
    case 'stage': return value.label;
    case 'pipeline': return value.label;
    case 'metric': return value.label;
    case 'period': return value.window.label;
    case 'currency': return value.code.toUpperCase();
    case 'owner': return value.name;
    case 'plan': return value.name;
    case 'subscription-status': return value.label;
    case 'invoice-status': return value.label;
    case 'money': return value.formatted;
    case 'comparator': return value.label;
    case 'number': return String(value.value);
    case 'record': return value.label;
    case 'meter': return value.name;
    case 'superlative': return value.label;
    case 'dimension': return value.label;
    case 'option': return value.label;
    case 'property': return value.label;
    case 'draft-kind': return value.label;
    case 'tone': return value.value;
    case 'text': return value.text;
    case 'quantity': return value.formatted;
    case 'verb': return value.label;
    default: return b.text;
  }
}

async function runPlan(
  plan: PlanStep[], call: AiCallContext, runtime: AinAiRuntime, definitions: Map<string, AiToolDef>,
): Promise<StepOutcome[]> {
  const out: StepOutcome[] = [];
  for (const step of plan) {
    const started = process.hrtime.bigint();
    const definition = definitions.get(step.tool) ?? runtime.tool(step.tool);
    const execution = await runtime.execute(step.tool, step.args, call, definition);
    out.push({
      tool: step.tool,
      args: step.args,
      ok: execution.ok,
      result: execution.result,
      error: execution.ok ? undefined : { code: execution.error?.code ?? 'tool_failed', message: execution.error?.message ?? 'The tool failed.' },
      ms: elapsedMs(started),
    });
    // A step that failed leaves the next one nothing honest to add.
    if (!execution.ok) break;
  }
  return out;
}

export function builtinEngine(): AiProvider {
  return {
    id: 'builtin',
    label: 'Ain template engine',
    available: () => true,

    async complete(req: AiCompletionRequest, input: unknown): Promise<AiCompletion> {
      const call = input as AiCallContext;
      if (!call?.ctx) throw new Error('The built-in engine needs a request context: pass ctx to ai.complete().');
      const runtime = call.runtime;
      if (!runtime) throw new Error('The built-in engine needs the tool runtime on the call context.');
      const ctx = call.ctx;
      const orgId = call.orgId;
      const question = lastUserMessage(req);
      const reasoning: string[] = [];
      const started = process.hrtime.bigint();

      /* which tools this run may reach */
      const definitions = new Map<string, AiToolDef>();
      for (const tool of runtime.tools()) definitions.set(tool.name, tool);
      for (const tool of req.tools ?? []) definitions.set(tool.name, tool);
      const reachable = [...definitions.keys()].filter((name) => !call.restrictTools || call.restrictTools.includes(name));
      const actor = call.actorId && call.actorId.startsWith('usr_') ? call.actorId : null;
      const vocab: Vocabulary = { ...vocabulary(ctx, orgId, { tools: reachable, actorId: actor }), ctx };
      const catalogue = catalogueFor(vocab);
      const scopedTools = call.restrictTools ?? null;

      reasoning.push(`Engine: template whitelist (${ENGINE_MODEL}); ${catalogue.length} question shapes reachable with ${reachable.length} ${reachable.length === 1 ? 'tool' : 'tools'}.`);
      runtime.note(call, 'provider', 'template-engine', `Matching against ${catalogue.length} shapes`);

      const outcome = matchTemplates(question, vocab, catalogue);
      const facts: Facts = { ...NO_FACTS };
      let content = '';
      let citations: Citation[] = [];
      let refusal: EngineAnalysis['refusal'] = null;
      let nearest: Nearest[] = [];
      let plan: PlanStep[] = [];
      let steps: StepOutcome[] = [];
      let template: Template | null = null;
      let bindings: Bindings = {};
      let writeBlocked: EngineAnalysis['writeBlocked'] = null;

      const refuse = (code: RefusalCode, why: string) => {
        refusal = { code, why };
        nearest = nearestTemplates(question, outcome.tokens, vocab, catalogue);
        content = renderRefusal(nearest, code === 'no_template' ? null : why);
        reasoning.push(`Refused (${code}): ${why}`);
        if (nearest.length) reasoning.push(`Nearest shapes: ${nearest.map((t) => `"${t.example}"`).join('; ')}.`);
      };

      if (!catalogue.length) {
        refuse('no_tools', scopedTools && !scopedTools.length
          ? 'This run is scoped to no tools at all, so no question shape can be answered.'
          : scopedTools
            ? `This run is scoped to ${scopedTools.map((t) => `\`${t}\``).join(', ')}, and no question shape can be answered with that alone.`
            : 'No tool this engine plans against is registered in this workspace.');
      } else if (!outcome.match) {
        const rejected = outcome.rejected[0];
        if (rejected) refuse('slot_unbound', rejected.reason);
        else refuse('no_template', 'Nothing in the question shapes this workspace answers matches it.');
      } else {
        template = outcome.match.template;
        bindings = outcome.match.bindings;
        const shown = Object.values(bindings).filter((one) => !one.name.startsWith('$'));
        reasoning.push(`Matched "${template.id}": ${shown.map((one) => `{${one.name}} = ${labelOf(one)}`).join(', ') || 'no slots'}.`);
        runtime.note(call, 'plan', 'match_template', `${template.id} — ${shown.map((one) => `${one.name}=${one.text}`).join(', ') || 'no slots'}`);
        plan = template.plan(bindings, vocab);
        for (const step of plan) reasoning.push(`Plan: ${step.tool} — ${step.why}`);
        steps = await runPlan(plan, call, runtime, definitions);
        for (const step of steps) {
          reasoning.push(step.ok
            ? `Ran ${step.tool} in ${step.ms}ms.`
            : `Ran ${step.tool} in ${step.ms}ms → ${step.error?.code}: ${step.error?.message}`);
        }
        const failed = steps.find((s) => !s.ok);
        const budgetExhausted = !!failed && ['step_budget_exhausted', 'time_budget_exhausted'].includes(failed.error?.code ?? '');
        if (template.kind === 'write') {
          const rendered = template.render(steps, bindings, vocab);
          content = rendered.content;
          citations = rendered.citations;
          Object.assign(facts, rendered.facts);
          if (failed && failed.error?.code !== 'approval_required') {
            writeBlocked = { wanted: plan[0]?.tool ?? template.id, reason: failed.error?.message ?? 'the write could not be prepared' };
          }
        } else if (budgetExhausted) {
          const budget = runtime.budget(call);
          content = `I ran out of this run's ${budget.timeMs.toLocaleString('en-US')}ms / ${budget.steps}-step budget before the plan finished, so I have no answer for you rather than a partial one. Planned: ${plan.map((s) => s.tool).join(' → ')}.`;
          refusal = { code: 'tool_failed', why: failed!.error?.message ?? 'budget exhausted' };
          reasoning.push(`Refused after the run (tool_failed): ${refusal.why}`);
        } else if (failed) {
          refuse('tool_failed', `${failed.tool} could not answer: ${failed.error?.message ?? 'it failed'}`);
        } else if (steps.some((s) => s.result && typeof s.result === 'object' && 'error' in (s.result as object))) {
          const error = steps.map((s) => (s.result as { error?: string }).error).find(Boolean) ?? 'the tool refused the arguments';
          refuse('tool_failed', String(error));
        } else {
          const rendered = template.render(steps, bindings, vocab);
          content = rendered.content;
          citations = rendered.citations;
          Object.assign(facts, rendered.facts);
          const record = shown.find((one) => one.value.kind === 'record');
          if (record && record.value.kind === 'record') {
            facts.subject ??= record.value.label;
            facts.subjectId = record.value.id;
          }
          runtime.note(call, 'synthesis', 'render_answer', `${template.kind}: ${content.split('\n')[0].slice(0, 120)}`);
        }
      }

      if (req.responseSchema) {
        const extraction = fillSchema(normaliseResponseSchema(req.responseSchema as SchemaNode), facts, refusal !== null);
        content = JSON.stringify(extraction.value, null, 2);
        reasoning.push(`Filled ${extraction.filled.length} schema ${extraction.filled.length === 1 ? 'field' : 'fields'}${extraction.missing.length ? `, left ${extraction.missing.join(', ')} null rather than guessing` : ''}.`);
      }

      const inputTokens = messageTokens(req.messages) + toolTokens(req.tools) + estimateTokens(reasoning.join(' '));
      const outputTokens = estimateTokens(content);
      const { usage, costMicros } = accountUsage(ENGINE_MODEL, inputTokens, outputTokens);
      reasoning.push(`Usage: ${usage.inputTokens} input + ${usage.outputTokens} output tokens, ${usage.credits} credits, ${costMicros === 0 ? 'no marginal cost (local engine)' : `${(costMicros / 1_000_000).toFixed(4)}¢`}; ${elapsedMs(started)}ms.`);

      const toolCalls: AiToolCall[] = steps.filter((s) => s.ok).map((s, index) => ({ id: `call_${index + 1}`, name: s.tool, arguments: s.args }));
      const budgetExhausted = steps.some((s) => ['step_budget_exhausted', 'time_budget_exhausted'].includes(s.error?.code ?? ''));

      const analysis: EngineAnalysis = {
        question,
        engine: 'template',
        intent: template?.intent ?? null,
        template: template ? { id: template.id, kind: template.kind, description: template.description, example: template.example(vocab) } : null,
        slots: Object.values(bindings).filter((one) => !one.name.startsWith('$')).map((one) => ({ name: one.name, kind: one.slot, text: one.text, label: labelOf(one), qualifier: one.qualifier })),
        refusal,
        nearest,
        plan,
        steps: steps.map((s) => ({ tool: s.tool, ok: s.ok, code: s.error?.code ?? null, ms: s.ms })),
        writeBlocked,
        scopedTools,
        budgetExhausted,
        facts,
      };

      const completion: AiCompletion & { analysis: EngineAnalysis; spans: AiTraceSpan[] } = {
        content,
        toolCalls,
        finishReason: budgetExhausted ? 'length' : (call.pendingApprovals?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
        usage,
        model: ENGINE_MODEL,
        reasoning,
        citations,
        analysis,
        spans: call.spans ?? [],
      };
      return completion;
    },
  };
}
