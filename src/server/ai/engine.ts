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
import {
  allTimeWindow, asksYearOverYear, defaultWindow, describeWindow, periodMentions, previousWindow,
  resolveWindows, reversedRange, shiftWindowYears, unresolvedPeriods, type TimeWindow,
} from './dates';
import { entityIndex, workspaceProfile, type EntityIndex, type WorkspaceProfile } from './grounding';
import { CRM_OBJECT_TYPES, extractMentions, mentionedTypes, resolveEntities, type ResolvedEntity } from './resolve';
import {
  detectGrouping, detectMetric, isRankingQuestion, linkedCustomerIds, metricById, metricIds, stageSets,
  type GroupBy, type MetricDetection, type MetricSubject,
} from './metrics';
import { comprehend, isUsableEntity, pronounBoundInSentence, refusalFor, workspaceVocabulary, type Refusal } from './clarify';
import {
  askedFor, ledgerToolFor, namedCapability, planTools, planWrite, replan, isWriteBlocked,
  type BlockedCapability, type BuiltinTool, type PlannedStep, type SkippedTool, type WindowPair, type WriteBlocked,
} from './plan';
import { propertyMap } from './query';
import {
  accountProfile, businessMetric, recordAggregate, recordSearch, recordTimeline, workspaceSearch,
  type AccountProfileResult, type TimelineItem,
} from './functions';
import { composeDraft, detectDraftKind, detectTone, type DraftKind, type DraftResult, type Tone } from './draft';
import { extractStructured, normaliseResponseSchema } from './extract';
import { synthesise, type ResultOutcome, type StepResult } from './synth';
import { accountUsage, estimateTokens, messageTokens, toolTokens } from './usage';
import { EMAIL_PATTERN, ID_PATTERN, QUOTED_PATTERN, normalise, truncate } from './text';

export const ENGINE_MODEL = 'ain-engine-1';

export interface EngineAnalysis {
  question: string;
  intent: IntentResult;
  window: TimeWindow;
  /** Every period the question named — a comparison must measure two. */
  windows: TimeWindow[];
  comparison: WindowPair | null;
  /** Why the engine declined to answer, when it did. */
  refusal: { code: string; why: string } | null;
  /** Set when an `act` request could not be turned into a write. */
  writeBlocked: WriteBlocked | null;
  /** Tool names the caller scoped this run to, `null` for the full catalogue. */
  scopedTools: string[] | null;
  /** True when the plan died on the run's step or time budget. */
  budgetExhausted: boolean;
  windowFromQuestion: boolean;
  entities: { id: string; label: string; type: string; score: number; rule: string; mention: string }[];
  subject: MetricSubject | null;
  metric: { id: string; label: string; matched: string; score: number } | null;
  groupBy: GroupBy;
  types: string[];
  tone: Tone;
  draftKind: DraftKind | null;
  plan: { tool: string; why: string; args: Record<string, unknown> }[];
  /** Tools the question matched but could not arm, and what they were missing. */
  skipped: SkippedTool[];
  /** Ledger capabilities the question asked for and this run refused to fake. */
  blocked: BlockedCapability[];
  /** Every successful step, and whether the answer rendered its result or said why not. */
  results: ResultOutcome[];
  /** The record carried in from the conversation when this turn named none. */
  carriedSubject: MetricSubject | null;
  steps: { tool: string; ok: boolean; code: string | null; ms: number }[];
  passes: number;
}

const SUBJECT_TYPES = ['company', 'customer', 'contact'];

const asSubject = (entity: ResolvedEntity | undefined): MetricSubject | null =>
  entity ? { id: entity.entity.id, type: entity.entity.type, label: entity.entity.label } : null;

/**
 * A word that points at something already on the table.
 *
 * "This quarter" and "that many" point at a period and a number, not at an
 * account, so they are stripped before the test — otherwise every question with
 * a period in it would look like a follow-up.
 */
const DEICTIC = /\b(they|them|their|theirs|it|its|this|that|these|those)\b/i;
const TIME_DEICTIC = /\b(this|that|these|those|the)\s+(quarter|quarters|month|months|year|years|week|weeks|period|periods|day|days|time|many|much|far|point)\b/gi;

export function deicticMention(text: string): string | null {
  const hit = text.replace(TIME_DEICTIC, ' ').match(DEICTIC);
  return hit ? hit[0] : null;
}

/** The record this conversation is pinned to, as a resolved entity. */
function pinnedSubject(call: AiCallContext, index: EntityIndex): ResolvedEntity | null {
  if (!call.subjectId) return null;
  const entity = index.entities.find((e) => e.id === call.subjectId);
  if (!entity) return null;
  return {
    entity,
    score: 1,
    rule: 'id',
    mention: 'this conversation',
    explain: `${entity.label} — the record this conversation is pinned to (${entity.id})`,
  };
}

/**
 * The price a meter is billed on.
 *
 * Metering measures; the catalogue prices. The link between them is the meter's
 * own `price_lookup_key`, which is how the seeded graduated telemetry price is
 * found from the meter a question named.
 */
function meterPriceKey(ctx: Ctx, orgId: string, meterId: string | null): string | null {
  if (!meterId || !ctx.svc.metering) return null;
  const meter = ctx.svc.metering.meter(orgId, meterId);
  const key = meter?.metadata?.price_lookup_key ?? meter?.metadata?.price ?? null;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

/** Magnitude words as people write them next to a quantity. */
const MAGNITUDES: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };

/**
 * The quantity a question names, for a price question that has one.
 *
 * "How much would 50 million telemetry events cost?" carries the number the
 * price has to be evaluated at. A year is not a quantity, and neither is a
 * figure written with a currency symbol in front of it — that is a price.
 */
export function quantityIn(question: string): number | null {
  let best: number | null = null;
  const pattern = /(^|[^\w$£€])(\d[\d,.]*)\s*(k|m|bn|thousand|million|billion)?\b/gi;
  for (const match of question.matchAll(pattern)) {
    const digits = Number(match[2].replace(/,/g, ''));
    if (!Number.isFinite(digits)) continue;
    const scale = match[3] ? MAGNITUDES[match[3].toLowerCase()] ?? 1 : 1;
    // A bare four-digit number in the 1900–2100 range is a year.
    if (!match[3] && digits >= 1900 && digits <= 2100 && Number.isInteger(digits)) continue;
    const value = Math.round(digits * scale);
    if (value > 0 && (best === null || value > best)) best = value;
  }
  return best;
}

/** A hit strong enough to be what this sentence is about, not a near-miss. */
const STRONG = 0.7;

/**
 * How a question reaches a meter.
 *
 * `METER_MIN` is the floor for considering one at all; `METER_STRONG` is what
 * it takes for a meter alone to make the sentence a usage question, so the word
 * "telemetry" inside a question about a product's price does not turn it into
 * one; `METER_MARGIN` is how far ahead the best meter has to be before the
 * engine will pick it rather than ask which was meant.
 */
const METER_MIN = 0.5;
const METER_STRONG = 0.6;
const METER_MARGIN = 0.06;

/**
 * The words that actually did the matching, for the sentence that asks which
 * meter was meant. The mention a resolver scores on is an n-gram with the
 * sentence's filler still in it — quoting "much telemetry did" back at someone
 * reads as a parser talking to itself.
 */
export function sharedWords(mention: string, labels: string[]): string {
  const inEvery = normalise(mention).split(' ').filter((word) =>
    word.length > 2 && labels.every((label) => normalise(label).split(' ').includes(word)));
  return inEvery.join(' ') || mention;
}

/**
 * Which records this turn is about, given that it is turn five of a
 * conversation about one account.
 *
 * A turn that names something outright is about what it names. A turn that says
 * "they" is about whatever the conversation is already about — the record it is
 * pinned to, or the last account an earlier turn resolved. Reading only the
 * literal words of the current turn is what answered "how much have they spent"
 * with the whole workspace's spend while the thread sat on one account.
 */
export function carryConversation(input: {
  turn: ResolvedEntity[];
  history: ResolvedEntity[];
  pinned: ResolvedEntity | null;
  deictic: string | null;
}): { entities: ResolvedEntity[]; carried: ResolvedEntity | null } {
  const strong = input.turn.filter((e) => e.score >= STRONG);
  const carried = input.pinned
    ?? input.history.find((e) => SUBJECT_TYPES.includes(e.entity.type))
    ?? null;
  if (strong.length) {
    // The turn named something itself, so nothing is carried into it.
    return { entities: dedupeEntities([...strong, ...input.turn]), carried: null };
  }
  if (carried && (input.deictic || !input.turn.length)) {
    // A weak match on a word like "line" must not outrank the account the
    // conversation is pinned to.
    return { entities: dedupeEntities([carried, ...input.turn.filter((e) => e.score >= STRONG)]), carried };
  }
  if (input.turn.length) return { entities: input.turn, carried: null };
  return { entities: input.history, carried: input.history.length ? null : carried };
}

function dedupeEntities(entities: ResolvedEntity[]): ResolvedEntity[] {
  const seen = new Set<string>();
  const out: ResolvedEntity[] = [];
  for (const entity of entities) {
    if (seen.has(entity.entity.id)) continue;
    seen.add(entity.entity.id);
    out.push(entity);
  }
  return out.slice(0, 6);
}

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

/**
 * A capability nothing registered, wrapped so it runs behind the same gates.
 *
 * The engine implements these itself, which is why the copilot works in a
 * workspace that installed no modules. It is not a reason to run them outside
 * the caller's allowlist, step budget or rate limit: "scoped to no tools" has
 * to mean no tools, including ours, or the scope is not a guarantee.
 */
function builtinDefinition(name: string, builtin: BuiltinTool): AiToolDef {
  return {
    name,
    description: `Built-in capability ${builtin}, provided by the engine because no module registered it.`,
    readOnly: true,
    input: { parse: (value: unknown) => (value ?? {}) as Record<string, unknown>, describe: () => ({ type: 'object' }) },
    run: (args: Record<string, unknown>, ctx: Ctx, meta: { orgId: string }) => callBuiltin(builtin, args, ctx, meta.orgId),
  };
}

async function executeStep(
  call: AiCallContext,
  step: PlannedStep,
  tools: Map<string, AiToolDef>,
): Promise<StepResult> {
  const runtime = call.runtime;
  const registered = tools.get(step.tool) ?? call.runtime?.tool(step.tool);
  const definition = registered ?? (step.builtin ? builtinDefinition(step.tool, step.builtin) : undefined);
  // Whether this step changes the workspace decides what the answer may claim.
  const write = definition ? !definition.readOnly : false;
  if (runtime) {
    if (!definition) {
      return {
        tool: step.tool, ok: false, why: step.why, args: step.args, write,
        error: { code: 'tool_not_found', message: `No tool named "${step.tool}" is registered and the engine has no built-in for it.` },
      };
    }
    const execution = await runtime.execute(step.tool, step.args, call, definition);
    if (execution.ok) {
      return { tool: step.tool, ok: true, why: step.why, args: step.args, result: execution.result, write };
    }
    return {
      tool: step.tool, ok: false, why: step.why, args: step.args, write,
      error: { code: execution.error?.code ?? 'tool_failed', message: execution.error?.message ?? 'Tool failed.' },
    };
  }
  try {
    const result = step.builtin
      ? callBuiltin(step.builtin, step.args, call.ctx, call.orgId)
      : await definition?.run(definition.input.parse(step.args), call.ctx, { orgId: call.orgId, actorId: call.actorId ?? undefined });
    return { tool: step.tool, ok: true, why: step.why, args: step.args, result, write };
  } catch (e) {
    return { tool: step.tool, ok: false, why: step.why, args: step.args, write, error: { code: 'tool_failed', message: (e as Error).message } };
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

/**
 * A 20,000-character prompt is a pasted document with a question on top of it,
 * not twenty thousand characters of question. Resolution and classification see
 * the opening of the message plus anything explicitly quoted or given as an id
 * or an email further down — which keeps a long paste from spending the whole
 * run's time budget on trigram scoring.
 */
const FOCUS_CHARS = 800;

export function focusText(text: string): string {
  const value = String(text ?? '');
  if (value.length <= FOCUS_CHARS) return value;
  const head = value.slice(0, FOCUS_CHARS);
  const tail = value.slice(FOCUS_CHARS);
  const explicit: string[] = [];
  for (const match of tail.matchAll(QUOTED_PATTERN)) explicit.push(match[1]);
  for (const match of tail.matchAll(ID_PATTERN)) explicit.push(match[0]);
  for (const match of tail.matchAll(EMAIL_PATTERN)) explicit.push(match[0]);
  return [head, ...[...new Set(explicit)].slice(0, 40)].join('\n');
}

/** How many earlier turns a pronoun may reach back through. */
const CARRY_TURNS = 6;

/**
 * What a pronoun in this turn can point back at, newest turn first.
 *
 * Two things this must get right. It has to reach past the three-turn tail it
 * used to read, because the account is named once — in turn one — and a thread
 * that forgets it by turn four answers "and their invoices?" by refusing to
 * know who "they" are. And it has to keep the turns apart rather than resolving
 * one concatenated blob: when turn three names a second account, "their" in
 * turn four means that one, so the most recent naming turn is listed first and
 * the carry picks it.
 */
function priorEntities(req: AiCompletionRequest, index: EntityIndex, options: Parameters<typeof resolveEntities>[2]): ResolvedEntity[] {
  const turns = req.messages.filter((m) => m.role === 'user').slice(0, -1).slice(-CARRY_TURNS).reverse();
  const out: ResolvedEntity[] = [];
  for (const turn of turns) out.push(...resolveEntities(focusText(turn.content), index, options));
  return out;
}

/** The two periods a comparison will measure, and how they were chosen. */
export function comparisonWindows(question: string, windows: TimeWindow[], now: number): WindowPair | null {
  const named = windows.filter((w) => w.end > w.start);
  // "the same period last year" is one period and an instruction, not two
  // periods: the second window is the first one shifted, so a quarter is
  // compared with that quarter, never with a whole year.
  if (asksYearOverYear(question)) {
    const base = named.find((w) => !/\blast\s+year\b|\byear\s+ago\b/i.test(w.matched)) ?? defaultWindow(now);
    return { a: base, b: shiftWindowYears(base, -1), source: 'year_over_year' };
  }
  if (named.length >= 2) return { a: named[0], b: named[1], source: 'both_named' };
  const base = named[0] ?? defaultWindow(now);
  return { a: base, b: previousWindow(base), source: 'preceding_period' };
}

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
      const rawQuestion = lastUserMessage(req);
      const question = focusText(rawQuestion);
      const reasoning: string[] = [];
      const workspace = workspaceProfile(ctx, orgId);
      if (question.length < rawQuestion.length) {
        reasoning.push(`Prompt is ${rawQuestion.length.toLocaleString('en-US')} characters; resolution reads the leading ${FOCUS_CHARS} plus every quoted name, id and email after it.`);
      }

      reasoning.push(
        `Workspace ${workspace.name}: currency ${workspace.currency.toUpperCase()}, timezone ${workspace.timezone}, clock ${new Date(workspace.now).toISOString()}.`,
      );

      /* 1. what kind of task is this */
      const intent = classifyIntent(question, req.intent);
      reasoning.push(describeIntent(intent));
      runtime?.note(call, 'plan', 'classify_intent', describeIntent(intent));

      /* 2. what period — every one the question names, in the order it names them */
      // The metric is detected here rather than in step 3 because whether a
      // period even applies depends on it: a snapshot metric has no window.
      const metric = detectMetric(question);
      const windows = resolveWindows(question, workspace.now, 6);
      const mentions = periodMentions(question);
      const unresolved = unresolvedPeriods(question, workspace.now);
      const backwards = reversedRange(question);
      const groupBy = detectGrouping(question);
      const ranking = isRankingQuestion(question);
      const explicit = windows[0] ?? null;
      // A ranking question with no period in it is not a question about this
      // quarter: "who is my biggest customer" means on the books, all told.
      const fallbackWindow = ranking && groupBy === 'account'
        ? allTimeWindow(workspace.now)
        : defaultWindow(workspace.now);
      const window = explicit ?? fallbackWindow;
      const comparison = intent.intent === 'compare' ? comparisonWindows(question, windows, workspace.now) : null;
      reasoning.push(explicit
        ? `Period${windows.length > 1 ? 's' : ''} ${windows.map((w) => `"${w.matched.trim()}" → ${w.label} (${describeWindow(w, workspace.locale)})`).join('; ')}.`
        // Saying a snapshot metric "defaulted" to this quarter describes a
        // filter that will not be applied, which is worse than saying nothing.
        : metric?.metric.snapshot
          ? `No period in the question, and ${metric.metric.label} is measured as of now, so no reporting period applies.`
          : `No period in the question; defaulting to ${window.label}.`);
      if (unresolved.length) {
        reasoning.push(`Period expressions found: ${mentions.map((m) => `"${m.text}"`).join(', ')}; ${mentions.length - unresolved.length} of ${mentions.length} resolved to a date range. Unparsed: ${unresolved.map((m) => `"${m.text}"`).join(', ')}.`);
      }
      if (comparison) {
        reasoning.push(`Comparison windows: ${comparison.a.label} against ${comparison.b.label} (${comparison.source.replace(/_/g, ' ')}).`);
      }

      /* 3. which records — this turn's, and the ones the thread is already about */
      const namedTypes = mentionedTypes(question);
      const prefer = metric?.metric.supportsSubject ? ['company', 'customer', 'contact'] : namedTypes;
      const index = entityIndex(ctx, orgId);
      const options = { prefer, limit: 6, dedupe: true };
      const deictic = deicticMention(question);
      const carriedFrom = carryConversation({
        turn: resolveEntities(question, index, options),
        history: priorEntities(req, index, options),
        pinned: pinnedSubject(call, index),
        deictic,
      });
      const entities = carriedFrom.entities;
      const carried = carriedFrom.carried;
      const subject = asSubject(entities.find((e) => SUBJECT_TYPES.includes(e.entity.type)));
      reasoning.push(entities.length
        ? `Resolved ${entities.length} ${entities.length === 1 ? 'record' : 'records'}: ${entities.slice(0, 3).map((e) => `${e.entity.label} (${e.entity.type}, ${e.score.toFixed(2)}, ${e.rule})`).join('; ')}.`
        : 'No workspace record matched the question by id, email, domain, name, acronym or trigram similarity.');
      if (carried) {
        reasoning.push(`"${deictic ?? 'this turn'}" names nothing on its own; carried ${carried.entity.label} from ${call.subjectId === carried.entity.id ? 'the record this conversation is pinned to' : 'the previous turn'}, and the answer is scoped to it.`);
        runtime?.note(call, 'resolve', 'carry_subject', `${carried.entity.label} (${carried.entity.id}) carried into "${truncate(question, 60)}"`);
      }
      if (entities.length) {
        runtime?.note(call, 'resolve', 'resolve_entities', entities.slice(0, 4).map((e) => e.explain).join(' | '));
      }

      /* 3b. which meter — a workspace that sells metered usage names its meters */
      const meters = resolveEntities(question, index, { only: ['meter'], limit: 3, minScore: METER_MIN });
      const decisive = meters.length === 1 || (meters.length > 1 && meters[0].score - meters[1].score >= METER_MARGIN);
      const meter = decisive ? meters[0] : null;
      // Two meters matched and neither is clearly the one meant. Picking the
      // alphabetically-first is how a question about telemetry sent gets
      // answered with telemetry stored, which is a different number.
      const rivalMeters = decisive ? [] : meters.slice(0, 3);
      if (meter) {
        reasoning.push(`Meter: ${meter.entity.label} (matched "${meter.mention}", ${meter.score.toFixed(2)}, ${meter.rule}) — metered usage is read from the meter, not from a sales metric.`);
      } else if (rivalMeters.length) {
        reasoning.push(`${rivalMeters.length} meters match "${sharedWords(rivalMeters[0].mention, rivalMeters.map((m) => m.entity.label))}" within ${METER_MARGIN} of each other (${rivalMeters.map((m) => m.entity.label).join(', ')}); none is decisive, so no meter is passed to the usage capability.`);
      }
      // A question that names a meter and no metric is a usage question,
      // whatever nouns it happens to use for it: "how much telemetry did they
      // send" says nothing the CRM holds, and answering it from bookings is
      // the substitution this engine exists to refuse.
      const usageFromMeter = !!meters[0] && meters[0].score >= METER_STRONG && !metric
        && !namedTypes.includes('usage') && (intent.intent === 'aggregate' || intent.intent === 'compare');
      const types = usageFromMeter ? [...namedTypes, 'usage'] : namedTypes;
      if (usageFromMeter) {
        reasoning.push(`"${meters[0].mention}" is ${meters[0].entity.label}, a meter in ${workspace.name}, and the question names no sales metric — so this is a question about metered usage.`);
      }

      /* 4. which metric and grouping */
      if (metric) reasoning.push(`Metric: ${metric.metric.label} (matched "${metric.matched}", score ${metric.score})${metric.alternatives.length ? `, over ${metric.alternatives.map((a) => a.id).join(', ')}` : ''}.`);
      if (groupBy !== 'none') reasoning.push(`Grouping requested: by ${groupBy}.`);
      if (ranking) reasoning.push(`The question asks for a ranking, so the answer leads with the ordered groups rather than a list of records.`);

      /* 5. can this be answered at all, or must it be refused */
      const comprehension = comprehend(question, workspaceVocabulary(index));
      // A type is countable when something in this workspace can actually count
      // it: the CRM for its own object types, and a registered ledger tool for
      // the revenue half. Anything else names no measure, and a question that
      // wants a number and names no measure is refused rather than answered
      // with bookings under a different question's wording.
      const countableTypes = types.filter((t) => t !== 'activity' && t !== 'customer' && (
        CRM_OBJECT_TYPES.has(t)
        || !!ledgerToolFor(req.tools ?? [], t, 'account')
        || !!ledgerToolFor(req.tools ?? [], t, 'workspace')));
      // A pronoun with nothing behind it is not a question about the workspace.
      // Widening "how much have they spent" to every account in the book is how
      // a follow-up gets answered confidently about the wrong thing.
      // A pronoun the sentence answers itself is not a dangling reference. The
      // antecedent is named four words earlier, and refusing to read it turned
      // "how many open deals do we have and what are they worth" into an
      // apology about an unpinned conversation.
      const boundHere = deictic ? pronounBoundInSentence(question, deictic) : null;
      if (boundHere) {
        reasoning.push(`"${deictic}" is bound inside the question by "${boundHere}", so it is not an unresolved reference and nothing needs to be carried.`);
      }
      const danglingReference: Refusal | null = deictic && !boundHere && !entities.length && !carried
        ? {
            code: 'unresolved_reference',
            why: `"${deictic}" refers to nothing this conversation has established.`,
            content: [
              `I do not know what "${deictic}" refers to. This conversation is not pinned to a record and nothing before it named one,`,
              `so answering would mean picking an account for you.`,
              `Name the account, or open the thread on the record you mean and I will hold it for the whole conversation.`,
            ].join(' '),
          }
        : null;
      const refusalOrNull: Refusal | null = danglingReference ?? refusalFor({
        question, workspace, intent, comprehension, metric, entities, types, windows, mentions,
        unresolved, reversedRange: backwards,
        metrics: metricIds().map((id) => metricById(id)?.label ?? id),
        countableTypes,
      });

      /* 6. plan */
      const budget = runtime?.budget(call) ?? { steps: 6, timeMs: 10_000, callsPerMinute: 600 };
      const available = req.tools ?? [];
      const scopedTools = call.restrictTools ?? null;
      const toolIndex = new Map(available.map((tool) => [tool.name, tool]));
      const planInput = {
        question, intent: intent.intent, window, windows, comparison, entities, subject, metric, groupBy, types,
        ranking,
        stages: stageSets(ctx, orgId),
        namedSomething: extractMentions(question).some((mention) => mention.kind !== 'ngram'),
        tools: available, workspace, maxSteps: Math.max(1, budget.steps - 1),
        allowedTools: scopedTools ? new Set(scopedTools) : null,
        actorId: call.actorId ?? null,
        dealStages: [...propertyMap(ctx, orgId, 'deal').get('deal_stage')?.options ?? []],
        allowWrites: !!call.allowWrites,
        // A CRM company and its billing customer are two rows with two ids, and
        // every ledger tool takes the second one.
        subjectCustomerIds: linkedCustomerIds(ctx, orgId, subject),
        meter: meter?.entity.id ?? null,
        // The price the meter is billed on, so "how much would 50 million
        // telemetry events cost" reaches the price book rather than coming back
        // with a usage volume close enough to be mistaken for an answer.
        meterPrice: meterPriceKey(ctx, orgId, meter?.entity.id ?? null),
        // Two meters matched the same word and neither is decisive. Picking one
        // would answer a different question half the time; the catalogue is not
        // an answer either. Both are measured and the answer says why.
        meterCandidates: rivalMeters.filter((m) => m.score >= METER_STRONG).map((m) => m.entity.id),
        quantity: quantityIn(question),
      };
      // A phrase that is a capability's own title is not an unreadable question.
      // "Show me the recovery queue" was refused with a sentence asserting that
      // "recovery" and "queue" match nothing in this workspace, while
      // `payments.recovery_queue` sat in the live catalogue.
      const rescued = refusalOrNull && intent.intent !== 'act' ? namedCapability(planInput) : null;
      const refusal: Refusal | null = rescued ? null : refusalOrNull;
      if (rescued && refusalOrNull) {
        reasoning.push(`The measure did not resolve (${refusalOrNull.code}), but "${question.trim()}" names \`${rescued.tool}\` — a capability this workspace publishes — so that answers it.`);
      }
      if (refusal) {
        reasoning.push(`Refused (${refusal.code}): ${refusal.why}`);
        runtime?.note(call, 'plan', 'refuse_to_answer', `${refusal.code}: ${refusal.why}`);
      } else if (comprehension.unknown.length) {
        reasoning.push(`Unrecognised terms carried through: ${comprehension.unknown.slice(0, 5).map((w) => `"${w}"`).join(', ')} — answered anyway because ${metric ? `the metric "${metric.metric.label}"` : entities.filter(isUsableEntity).length ? 'a record' : 'an object type'} resolved.`);
      }
      const attempted = intent.intent === 'act' ? planWrite(planInput) : null;
      const writeBlocked = isWriteBlocked(attempted) ? attempted : null;
      if (writeBlocked) {
        reasoning.push(`No write prepared: the request looks like ${writeBlocked.wanted}, but ${writeBlocked.reason}`);
      }
      const planned = refusal
        ? { steps: [] as PlannedStep[], skipped: [] as SkippedTool[], blocked: [] as BlockedCapability[] }
        : planTools(planInput);
      const plan = planned.steps;
      // A capability the question asked for and the run could not arm is
      // reported with the values it was missing, using the workspace's own
      // names for them: "name a meter" is only actionable next to the meters.
      const meterOptions = (rivalMeters.length ? rivalMeters.map((m) => m.entity) : index.entities.filter((e) => e.type === 'meter'))
        .slice(0, 8)
        // The event name is what tells two similarly-named meters apart, which
        // is the whole job of this list.
        .map((entity) => ({ label: entity.label, detail: entity.aliases[0] ? `\`${entity.aliases[0]}\`` : entity.sublabel }));
      const blocked: BlockedCapability[] = planned.blocked.map((entry) => entry.missing.includes('meter')
        ? { ...entry, options: meterOptions, ambiguous: rivalMeters.length > 0, matched: rivalMeters.length ? sharedWords(rivalMeters[0].mention, rivalMeters.map((m) => m.entity.label)) : undefined }
        : entry);
      const blockedTools = new Set(blocked.map((b) => b.tool).filter((name): name is string => !!name));
      if (blocked.length) {
        reasoning.push(`Refused to substitute: ${blocked.map((b) => `${b.objectType} (${b.reason.replace(/_/g, ' ')}${b.missing.length ? `: ${b.missing.join(', ')}` : ''})`).join('; ')}. No CRM fallback was planned — a confident answer to another question is worse than none.`);
        runtime?.note(call, 'plan', 'refuse_substitution', blocked.map((b) => `${b.objectType}: ${b.tool ?? 'no capability'}${b.missing.length ? ` needs ${b.missing.join(', ')}` : ''}`).join(' | '));
      }
      // A tool the question wanted but could not arm is reported, not run with
      // the sentence in its parameters. The trace and the answer both say so.
      const skipped = planned.skipped
        .filter((s) => askedFor(s.tool, question) && !blockedTools.has(s.tool))
        .slice(0, 2);
      if (planned.skipped.length) {
        reasoning.push(`Not planned: ${planned.skipped.map((s) => `${s.tool} (no value for ${s.missing.join(', ')})`).join('; ')}.`);
      }
      if (scopedTools) {
        reasoning.push(`Run scoped to ${scopedTools.length ? scopedTools.map((t) => `"${t}"`).join(', ') : 'no tools'}; the plan is filtered against that list, not just the tools offered to the model.`);
      }
      reasoning.push(plan.length
        ? `Plan (${plan.length} ${plan.length === 1 ? 'step' : 'steps'}, budget ${budget.steps}): ${plan.map((s) => s.tool).join(' → ')}.`
        : refusal
          ? 'No tool ran: the question was refused before anything was measured.'
          : 'No tool was needed to answer this.');
      for (const step of plan) reasoning.push(`  ${step.tool}: ${step.why}`);
      runtime?.note(call, 'plan', 'plan_tools', plan.map((s) => `${s.tool}(${Object.keys(s.args).join(',')})`).join(' → ') || 'no tools required');

      /* 7. execute, then one replanning pass with whatever budget is left */
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
      const second = refusal ? [] : replan(planInput, executed, Math.min(remaining, 2), planned.skipped);
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

      /* 8. draft, extract or answer */
      const tone = detectTone(question);
      const draftKind = !refusal && intent.intent === 'draft' ? detectDraftKind(question) : null;
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

      const synthesis = refusal
        ? { content: refusal.content, citations: [], rendering: [] as ResultOutcome[] }
        : synthesise({
            question, intent, workspace, window, windows, comparison, ranking, subject, entities, steps, metric, draft,
            stages: planInput.stages,
            pendingApprovals: (call.pendingApprovals ?? []) as PendingApproval[],
            writeBlocked,
            scopedTools,
            // A tool the second pass managed to arm is not a tool that was skipped.
            skippedTools: skipped.filter((s) => !steps.some((step) => step.tool === s.tool && step.ok)),
            blocked,
            carriedSubject: carried ? { label: carried.entity.label, pinned: call.subjectId === carried.entity.id } : null,
            // What this thread has already been told. A profile paragraph
            // reprinted on turns two, three and four is four paragraphs the
            // reader has read, in front of the sentence they asked for.
            priorAnswers: req.messages.filter((m) => m.role === 'assistant').map((m) => m.content),
          });

      // A plan that died entirely on the run's budget did not answer the
      // question, and must not report itself as a finished answer.
      const budgetExhausted = plan.length > 0
        && steps.length > 0
        && steps.every((step) => !step.ok)
        && steps.some((step) => step.error?.code === 'time_budget_exhausted' || step.error?.code === 'step_budget_exhausted');

      let content = budgetExhausted
        ? [
            `I ran out of this run's ${budget.timeMs.toLocaleString('en-US')}ms / ${budget.steps}-step budget before ${plan.length === 1 ? 'the planned step' : 'any planned step'} returned, so I have no answer for you rather than a partial one.`,
            `Planned: ${plan.map((s) => s.tool).join(' → ')}. Ask again with a shorter prompt, or raise \`max_steps\`.`,
          ].join(' ')
        : synthesis.content;
      if (req.responseSchema) {
        const metricResult = executed.map((e) => e.result).find((r) => !!r && typeof r === 'object' && 'formatted' in (r as object)) as { value?: number; formatted?: string; books?: { currency: string }[]; mixedCurrency?: boolean } | undefined;
        const extraction = extractStructured(normaliseResponseSchema(req.responseSchema), {
          question,
          answer: synthesis.content,
          workspace,
          entities,
          window,
          results: executed,
          metricValue: metricResult?.value ?? null,
          metricFormatted: metricResult?.formatted ?? null,
          // A measurement question is about its metric; every other question
          // merely mentions one, and pasting it into that question's `amount`
          // writes the workspace's total onto one record.
          metricIsSubject: !!metric && (intent.intent === 'aggregate' || intent.intent === 'compare'),
          metricCurrencies: (metricResult?.books ?? []).map((b) => b.currency),
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
        windows,
        comparison,
        refusal: refusal ? { code: refusal.code, why: refusal.why } : null,
        writeBlocked,
        scopedTools,
        budgetExhausted,
        // A refused period is never "from the question": the caller has to be
        // able to see, in one field, that nothing they named was measured.
        windowFromQuestion: !!explicit && refusal?.code !== 'period_unresolved',
        entities: entities.map((e) => ({ id: e.entity.id, label: e.entity.label, type: e.entity.type, score: e.score, rule: e.rule, mention: e.mention })),
        subject,
        metric: metric ? { id: metric.metric.id, label: metric.metric.label, matched: metric.matched, score: metric.score } : null,
        groupBy,
        types,
        tone,
        draftKind,
        plan: plan.map((s) => ({ tool: s.tool, why: s.why, args: s.args })),
        skipped: planned.skipped,
        blocked,
        results: synthesis.rendering,
        carriedSubject: asSubject(carried ?? undefined),
        steps: traced,
        passes,
      };

      const completion: AiCompletion & { analysis: EngineAnalysis; spans: AiTraceSpan[] } = {
        content,
        toolCalls,
        finishReason: budgetExhausted ? 'length' : (call.pendingApprovals?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
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
