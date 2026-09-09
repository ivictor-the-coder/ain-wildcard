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
  catalogueFor, explainUnbound, matchTemplates, nearestTemplates, type Nearest, type PlanStep, type StepOutcome, type Template, type TemplateIntent,
} from './templates';
import { NO_FACTS, renderRefusal, type Citation, type Facts } from './answer';
import { fillSchema, normaliseResponseSchema } from './extract';
import { accountUsage, estimateTokens, messageTokens, toolTokens } from './usage';
import type { QualifierKind } from './qualifiers';

export const ENGINE_MODEL = 'ain-engine-1';

export type RefusalCode = 'no_template' | 'slot_unbound' | 'no_tools' | 'tool_failed';

/** Which measure was refused, in which currency, and what this workspace holds. */
export interface RefusedCurrency {
  measure: string;
  currency: string;
  books: string[];
}

export interface EngineAnalysis {
  question: string;
  /** Which engine produced this answer. */
  engine: 'template';
  intent: TemplateIntent | null;
  template: { id: string; kind: string; description: string; example: string | null } | null;
  /** Every slot the question filled, and the typed value it bound to. */
  slots: { name: string; kind: string; text: string; label: string; qualifier: QualifierKind | null }[];
  refusal: { code: RefusalCode; why: string } | null;
  /**
   * A money measure the engine would not narrow to the currency that was asked
   * for, as facts: which measure, which currency, and the books the workspace
   * actually holds. The card used to recover these from the refusal sentence
   * with a regex, so every improvement to the wording silently disabled it.
   */
  refusedCurrency: RefusedCurrency | null;
  /** The shapes offered instead, as concrete questions. */
  nearest: Nearest[];
  plan: PlanStep[];
  steps: { tool: string; ok: boolean; code: string | null; ms: number }[];
  writeBlocked: { wanted: string; reason: string } | null;
  /**
   * The measure this question inherited from the one before it, when it named
   * none of its own — "And by owner?" after "What is our open pipeline?".
   * Null when the question stood on its own words, which is almost always.
   */
  carried: { measure: string; from: string } | null;
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
    case 'movement': return value.label;
    case 'ageing-bucket': return value.label;
    default: return b.text;
  }
}

/**
 * A follow-up that names a dimension and nothing else: "And by owner?".
 *
 * The prefix is optional so "by stage?" on its own counts, and the rest of the
 * sentence has to be the grouping — anything that carries its own subject is
 * not a follow-up and is matched, or refused, on its own words.
 */
const FOLLOW_UP = /^(?:and|so|ok(?:ay)?|now|then|also|what about|how about)?[\s,]*((?:broken down |split )?by\s+\S.*?)\s*\??$/i;

/**
 * The question a bare follow-up is really asking.
 *
 * "And by owner?" names no measure, and the engine answers one question at a
 * time — so it refused, three words after answering the question it is a
 * follow-up to. The measure is taken from the previous turn by re-asking that
 * question with this one's grouping on the end, which means the follow-up is
 * matched, checked and planned by the same templates as anything else: nothing
 * here decides what an answer is, only which sentence gets answered.
 *
 * Only a *measure* is inherited. A record — the account or teammate an earlier
 * question named — is never carried: a later question that named no subject was
 * answered for one account's $315,900 against a workspace book of $9,010,960,
 * and the fix for that was to stop carrying it, not to warn about it.
 */
function carriedTurn(
  question: string,
  messages: readonly { role: string; content: string }[],
  vocab: Vocabulary,
  catalogue: Template[],
): { outcome: ReturnType<typeof matchTemplates>; measure: string; from: string } | null {
  const follow = FOLLOW_UP.exec(question.trim());
  if (!follow) return null;
  const asked = messages.filter((m) => m.role === 'user').map((m) => m.content.trim()).filter(Boolean);
  // The last one is this question. Walk back past any follow-ups before it: a
  // follow-up carries no measure either, so re-asking the one immediately
  // before produced "And by owner by stage?" — a sentence with no subject in
  // it, refused three words after the engine had answered the same measure
  // grouped the other way, and refused by quoting the word "And" back at the
  // person. The measure belongs to the last question that stood on its own
  // words, however many groupings have been asked of it since.
  let previous: string | undefined;
  for (let i = asked.length - 2; i >= 0; i -= 1) {
    if (!FOLLOW_UP.test(asked[i])) { previous = asked[i]; break; }
  }
  if (!previous) return null;
  const outcome = matchTemplates(`${previous.replace(/[?\s]+$/, '')} ${follow[1].trim()}?`, vocab, catalogue);
  if (!outcome.match) return null;
  const metric = Object.values(outcome.match.bindings).find((b) => b.value.kind === 'metric');
  if (!metric || metric.value.kind !== 'metric') return null;
  return { outcome, measure: metric.value.label, from: previous };
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

      let outcome = matchTemplates(question, vocab, catalogue);
      let carried: EngineAnalysis['carried'] = null;
      if (!outcome.match && catalogue.length) {
        const carry = carriedTurn(question, req.messages, vocab, catalogue);
        if (carry) {
          outcome = carry.outcome;
          carried = { measure: carry.measure, from: carry.from };
          reasoning.push(`This question names no measure of its own; carried "${carry.measure}" from "${carry.from}".`);
          runtime.note(call, 'plan', 'carry_measure', `${carry.measure} from "${carry.from}"`);
        }
      }
      const facts: Facts = { ...NO_FACTS };
      let content = '';
      let citations: Citation[] = [];
      let refusal: EngineAnalysis['refusal'] = null;
      let refusedCurrency: RefusedCurrency | null = null;
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
        // A shape whose words all fitted and whose one slot did not bind is
        // refused by naming that slot — the word it choked on and, for a slot
        // with a closed set of values, the values — so the reader can fix the
        // question rather than guess at what the engine could not read.
        const unbound = rejected ? null : explainUnbound(question, outcome.tokens, vocab, catalogue);
        if (rejected) refuse('slot_unbound', rejected.reason);
        else if (unbound) refuse('slot_unbound', unbound);
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
          // A tool that refuses may say why in fields as well as in a sentence.
          // Carry those through rather than leaving the card to parse the
          // sentence back apart — it did, with a regex, and went silent the
          // third time the sentence was improved.
          refusedCurrency = (failed.result as { refused_currency?: RefusedCurrency } | undefined)?.refused_currency ?? null;
          refuse('tool_failed', `${failed.tool} could not answer: ${failed.error?.message ?? 'it failed'}`);
        } else if (steps.some((s) => s.result && typeof s.result === 'object' && 'error' in (s.result as object))) {
          const refusing = steps.find((s) => s.result && typeof s.result === 'object' && 'error' in (s.result as object));
          const error = steps.map((s) => (s.result as { error?: string }).error).find(Boolean) ?? 'the tool refused the arguments';
          // A tool that refuses may also say why in fields. Carry those through
          // rather than leaving the card to parse the sentence back apart.
          refusedCurrency = (refusing?.result as { refused_currency?: RefusedCurrency })?.refused_currency ?? null;
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
        // A JSON number carries no unit, and this one is a hundred times the
        // figure the same run states in prose. Say which it is, beside the
        // formatted figure, so nothing has to be inferred from the field name.
        if (extraction.filled.length && facts.unit === 'money' && facts.value !== null && facts.currency && !facts.mixed) {
          reasoning.push(`Money is in ${facts.currency.toUpperCase()} minor units, as on every other field of this API: ${facts.value} is ${facts.formatted}.`);
        }
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
        refusedCurrency,
        nearest,
        plan,
        steps: steps.map((s) => ({ tool: s.tool, ok: s.ok, code: s.error?.code ?? null, ms: s.ms })),
        writeBlocked,
        carried,
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
