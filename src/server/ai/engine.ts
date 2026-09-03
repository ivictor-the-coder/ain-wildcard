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
  currencyMention, currencyShaped, detectGrouping, detectMetric, isRankingQuestion, linkedCustomerIds, metricById, metricIds,
  measureWords, metricUndefinedWhenEmpty, stageSets, unknownMeasure, withoutGroupingPhrase,
  type GroupBy, type MetricDetection, type MetricSubject, type StageSets,
} from './metrics';
import { comprehend, isUsableEntity, pronounBoundInSentence, refusalFor, workspaceVocabulary, type Refusal } from './clarify';
import {
  QualifierLedger, creditUnitsFor, crmVocabulary, crowdedOut, currencyBooks, dateNounIn, isBalanceQuestion,
  kindNoun, meteredNoun, parseQualifiers, pipelineIn, qualifierRefusal, rankingLimit, rankingOrder,
  readableWords, resolveOwnerSlots, settleUnitAgainstResults, stageLabels, stepCarries, unitsNamed,
  unitVocabulary, unknownModifier, waiverSentence, withoutPipelinePhrase,
  type Qualifier, type RecordFilter,
} from './qualifiers';
import {
  acceptsWindow, askedFor, inferConditions, ledgerToolFor, namedCapability, outcomeStages, planTools, planWrite,
  replan, isWriteBlocked,
  type BlockedCapability, type BuiltinTool, type PlannedStep, type SkippedTool, type WindowPair, type WriteBlocked,
} from './plan';
import {
  dimensionsIn, dimensionsOf, numericDimensionsIn, recordsMatching, unknownDimensionValue, type UnknownValue,
} from './dimensions';
import { propertyMap } from './query';
import {
  auditCoverage, carriesComparison, coverageRefusal, numbersIn, NEGATIONS as NEGATION_WORDS,
  type CoverageClaim, type CoverageNumeric,
} from './coverage';
import {
  accountProfile, businessMetric, recordAggregate, recordSearch, recordTimeline, workspaceSearch,
  type AccountProfileResult, type TimelineItem,
} from './functions';
import { composeDraft, detectDraftKind, detectTone, type DraftKind, type DraftResult, type Tone } from './draft';
import { countedRows, extractStructured, normaliseResponseSchema } from './extract';
import { synthesise, type ResultOutcome, type StepResult } from './synth';
import { accountUsage, estimateTokens, messageTokens, toolTokens } from './usage';
import { EMAIL_PATTERN, ID_PATTERN, QUOTED_PATTERN, acronymOf, contentWords, humanise, listPhrase, normalise, stem, truncate } from './text';

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
  /**
   * Every qualifier the question named and the state it ended in — bound,
   * refused or explicitly waived. A caller can read this field and see, in one
   * place, exactly which words of their question reached the query.
   */
  qualifiers: Qualifier[];
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
 * How much of a meter's own name the question has to hold before an account
 * that shares one word with it stops mattering. Two thirds: "Peak connected
 * robots" written out in full is the meter; "operative at its seat" holding one
 * word of "Active operator seats" is a company's name and a question's
 * furniture.
 */
const METER_LABEL_COVERAGE = 0.66;

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
  // A meter is not an antecedent. "How many telemetry events did they meter in
  // August 2026?" resolves the *meter* strongly and the pronoun not at all, and
  // a strong match of any type used to cancel the carry — so the thread's
  // account was dropped and the workspace's 97,205,652 events were stated as
  // the answer, with the account's own 5,231,475 printed two lines below it.
  // A pronoun with an antecedent is a scope, whatever else the sentence named.
  const namedSubject = strong.some((e) => SUBJECT_TYPES.includes(e.entity.type));
  if (strong.length && (namedSubject || !input.deictic || !carried)) {
    // The turn named something itself, so nothing is carried into it.
    return { entities: dedupeEntities([...strong, ...input.turn]), carried: null };
  }
  if (carried && (input.deictic || !input.turn.length)) {
    // A weak match on a word like "line" must not outrank the account the
    // conversation is pinned to. Everything this turn matched strongly still
    // comes along — the meter it named is what the pronoun is being measured
    // in, not a rival for the subject.
    return { entities: dedupeEntities([carried, ...strong, ...input.turn.filter((e) => e.score >= STRONG)]), carried };
  }
  if (input.turn.length) return { entities: input.turn, carried: null };
  return { entities: input.history, carried: input.history.length ? null : carried };
}

/**
 * A name is one kind of thing.
 *
 * "How much pipeline does Marcus Ilori own?" resolved Marcus Ilori the
 * teammate, and *also* Marcus Barnes, Marcus Brennan and Marcus Vandermeer —
 * three contacts who share his first name. The first of those became the
 * subject, and the answer came back about Whitcombe Aerospace: a real company,
 * a real figure, and nothing to do with the question.
 *
 * An owner slot takes an owner. A weaker match of a different type on the same
 * person's name is not a fallback for one — it is a different question — so it
 * is dropped here rather than allowed to become the subject downstream.
 */
export function dropTypeConfusion(entities: ResolvedEntity[]): ResolvedEntity[] {
  const owners = entities.filter((e) => e.entity.type === 'user' && e.score >= 0.62);
  if (!owners.length) return entities;
  const best = Math.max(...owners.map((o) => o.score));
  const ownerTokens = new Set<string>();
  for (const owner of owners) {
    for (const token of normalise(owner.entity.label).split(' ')) if (token.length > 2) ownerTokens.add(token);
  }
  return entities.filter((entity) => {
    if (entity.entity.type === 'user') return true;
    const shares = normalise(entity.entity.label).split(' ').some((token) => ownerTokens.has(token));
    return !shares || entity.score > best;
  });
}

/**
 * A word the question spent on a period is not a name.
 *
 * "Which open deals close before March 2026?" resolved "March" onto Marcus
 * Ilori — a 0.55 trigram on four shared letters — and the plan then listed that
 * rep's open deals with the period dropped entirely. A month is a period. A
 * resolution of the wrong kind is a different question, not a weaker match for
 * this one, so only an exact hit on the record's own name survives inside a
 * period phrase.
 */
export function dropPeriodWords(entities: ResolvedEntity[], question: string): ResolvedEntity[] {
  const spans = periodMentions(question).map((m) => ` ${normalise(m.text)} `);
  if (!spans.length) return entities;
  const exact = new Set(['id', 'email', 'domain', 'name_exact', 'alias_exact', 'core_exact']);
  return entities.filter((entity) => exact.has(entity.rule)
    || !spans.some((span) => span.includes(` ${normalise(entity.mention)} `)));
}

/**
 * A word the question spent on a record filter is not a name either.
 *
 * "How many contacts are decision makers?" names a buying role this workspace
 * defines. The resolver read "are decision" as a 47% trigram on Ardennes
 * Précision, the plan scoped the count to that one account, and the answer
 * named it — a precise figure about a company the question never mentioned.
 * A span that produced a typed filter has been spent; only an exact hit on a
 * record's own name may claim it back.
 */
export function dropQualifierWords(entities: ResolvedEntity[], filters: RecordFilter[]): ResolvedEntity[] {
  const words = new Set(filters.flatMap((filter) => normalise(filter.matched).split(' ').filter((w) => w.length > 2)));
  if (!words.size) return entities;
  const exact = new Set(['id', 'email', 'domain', 'name_exact', 'alias_exact', 'core_exact', 'acronym']);
  return entities.filter((entity) => exact.has(entity.rule)
    || !normalise(entity.mention).split(' ').some((word) => words.has(word)));
}

/**
 * The record filters a question names, as ledger-ready qualifiers.
 *
 * `inferConditions` has always read these out of the sentence; what was missing
 * was any record that it had. The label comes from the workspace's own property
 * options, so a refusal or a waiver names the status the way the reader's
 * screen does.
 */
export function recordPropertyFilters(
  ctx: Ctx,
  orgId: string,
  question: string,
  types: string[],
  stages: StageSets,
): RecordFilter[] {
  let out: RecordFilter[] = [];
  const text = ` ${normalise(question)} `;
  // The pipeline and stage labels belong to their own qualifier kinds. Reading
  // them again as enumerated values would put two entries in the ledger for one
  // word — and a question naming two of a kind is refused, so "the Renewal
  // pipeline" would have refused itself.
  const vocabulary = crmVocabulary(ctx, orgId);
  const reserved = new Set<string>([
    ...vocabulary.pipelines.flatMap((p) => [normalise(p.label), normalise(p.value.replace(/_/g, ' '))]),
    ...vocabulary.stages.flatMap((st) => [
      ...st.aliases.map((alias) => normalise(alias.label)), normalise(st.value.replace(/_/g, ' ')),
    ]),
  ]);
  // Every dimension the workspace enumerates its own records on — a lead
  // source, a competitor, a forecast category, an industry. These are the
  // qualifiers the ledger could not hold, so nothing could refuse them and the
  // workspace total was stated as the answer to every one of them.
  // A deal question can be scoped by a property of the *account* it is with —
  // an industry, a sales region, a lifecycle stage. "How many open deals are
  // in the EMEA region?" named no company noun at all, so the company's own
  // dimensions were never read and the answer was the workspace's 38.
  const scanTypes = types.includes('deal') && !types.includes('company') ? [...types, 'company'] : types;
  for (const objectType of scanTypes) {
    if (!CRM_OBJECT_TYPES.has(objectType)) continue;
    // A number with a unit on it is a filter too. "A 36-month contract term"
    // and "stuck in Negotiation for more than 60 days" were both dropped, and
    // both came back as the whole open book.
    for (const hit of numericDimensionsIn(ctx, orgId, question, objectType, ctx.now())) {
      out.push({
        objectType: hit.objectType, property: hit.property, value: hit.value,
        matched: hit.matched, label: hit.label, noun: hit.noun, op: hit.op,
      });
    }
    for (const hit of dimensionsIn(question, dimensionsOf(ctx, orgId, objectType, reserved))) {
      out.push({
        objectType: hit.objectType,
        property: hit.property,
        value: hit.value,
        matched: hit.matched,
        label: hit.label,
        noun: hit.noun,
        // A record can run Siemens *and* Fanuc, and the column holds both. The
        // test is membership; equality against it answered "0 companies" for
        // the 24 that do.
        ...(hit.multi ? { op: 'has' as const } : {}),
        // The rows this filter picks out, so a question about pharmaceutical
        // *companies* can scope a query over *deals* to exactly those accounts
        // rather than losing the word on the way in.
        ids: recordsMatching(ctx, orgId, hit.objectType, hit.property, hit.value, hit.multi),
      });
    }
  }
  for (const objectType of scanTypes) {
    // A deal's pipeline, stage and outcome are already typed qualifiers of
    // their own; reading them a second time here would double-count them.
    if (objectType === 'deal' || !CRM_OBJECT_TYPES.has(objectType)) continue;
    const properties = propertyMap(ctx, orgId, objectType);
    // A status this workspace spells out in more than one word, written into
    // the question verbatim, is that status. "How many tickets are waiting on
    // us?" fell through to the general open-ticket set and answered 7 for a
    // question whose answer is the two sitting in that one column — a wider,
    // confident number under the reader's own narrower sentence. One word is
    // deliberately not enough: "new", "open" and "closed" are English before
    // they are statuses, and the general reading of those is the right one.
    for (const property of ['status', 'priority']) {
      const options = properties.get(property)?.options ?? [];
      const named = options.filter((option) => normalise(option.label).includes(' ')
        && text.includes(` ${normalise(option.label)} `));
      if (named.length !== 1) continue;
      const spelling = named[0].label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      out.push({
        objectType, property, value: named[0].value, label: named[0].label,
        matched: question.match(new RegExp(spelling, 'i'))?.[0] ?? named[0].label,
      });
    }
    for (const condition of inferConditions(question, objectType, stages)) {
      if (!condition.matched || condition.op === 'is_set' || condition.op === 'is_not_set') continue;
      // A word already spent naming a value of another dimension is not also a
      // value of this one. "Partner referral" is a lead source, and reading
      // "partner" out of it as a company relationship refused a question whose
      // answer this engine computes exactly.
      if (out.some((held) => ` ${normalise(held.matched)} `.includes(` ${normalise(condition.matched!)} `)
        && normalise(held.matched) !== normalise(condition.matched!))) continue;
      if (typeof condition.value === 'number') continue;
      const values = condition.values ?? (condition.value === undefined ? [] : [String(condition.value)]);
      if (!values.length) continue;
      const options = properties.get(condition.property)?.options ?? [];
      const labels = values.map((value) => options.find((option) => option.value === value)?.label ?? humanise(value));
      out.push({
        objectType,
        property: condition.property,
        ...(condition.values ? { values: condition.values } : { value: String(condition.value) }),
        matched: condition.matched,
        label: listPhrase(labels),
        noun: properties.get(condition.property)?.label,
        // The rows this filter picks out, so a deal question scoped to
        // "prospects" can be measured over the deals of those accounts rather
        // than losing the word: "how much open pipeline is with prospects?"
        // came back as the $9,010,960 whole book.
        ...(condition.values ? {} : { ids: recordsMatching(ctx, orgId, objectType, condition.property, String(condition.value)) }),
      });
    }
  }
  // A value written inside a longer value is not a second filter.
  //
  // "How many pilot conversion deals are there?" names the deal type "Pilot
  // conversion"; the word "pilot" inside it is also an automation maturity of a
  // company, so a second filter scoped the count to the two accounts in a pilot
  // cell and the answer was "0 deals" for a question whose answer is 25. The
  // longer span is the one the reader wrote.
  const spans = out.map((filter) => normalise(filter.matched));
  const swallowed = out.filter((filter, at) => spans.some((span, other) =>
    other !== at && span.length > spans[at].length && ` ${span} `.includes(` ${spans[at]} `)));
  out = out.filter((filter) => !swallowed.includes(filter));
  // One filter per column. The dimension pass and the pattern pass can both
  // read the same word, and two entries for one span reads to the ledger as a
  // question naming two of a kind — which is a refusal, on a sentence that
  // named one.
  const seen = new Set<string>();
  return out.filter((filter) => {
    const key = `${filter.objectType}.${filter.property}`;
    // One span, one filter. A company carries `lead_source` as well as a deal
    // does, so "how much open pipeline came from trade shows?" produced both —
    // the deal filter and, redundantly, an account filter reading the same
    // words back a second time. The type the question is about comes first in
    // the scan, so the first match wins.
    const span = `${filter.property}:${normalise(filter.matched)}`;
    if (seen.has(key) || seen.has(span)) return false;
    seen.add(key);
    seen.add(span);
    return true;
  });
}

/**
 * A value the question named for a dimension this workspace has no option for.
 *
 * "How many open deals are we losing to Siemens?" answered "14 closed-lost
 * deals" — every deal this workspace has ever lost, for a competitor it has
 * never met. An unknown pipeline, an unknown account and an unknown measure are
 * all refused by name; this was the same word in the same sentence position.
 */
export function unknownFilterValue(
  ctx: Ctx,
  orgId: string,
  question: string,
  types: string[],
  matched: RecordFilter[],
): UnknownValue | null {
  const vocabulary = crmVocabulary(ctx, orgId);
  const reserved = new Set<string>([
    ...vocabulary.pipelines.flatMap((p) => [normalise(p.label), normalise(p.value.replace(/_/g, ' '))]),
    ...vocabulary.stages.flatMap((st) => [
      ...st.aliases.map((alias) => normalise(alias.label)), normalise(st.value.replace(/_/g, ' ')),
    ]),
  ]);
  const found = matched.map((filter) => ({ property: filter.property, objectType: filter.objectType }));
  for (const objectType of types) {
    if (!CRM_OBJECT_TYPES.has(objectType)) continue;
    const dimensions = dimensionsOf(ctx, orgId, objectType, reserved);
    const unknown = unknownDimensionValue(question, dimensions,
      found.filter((f) => f.objectType === objectType).map((f) => ({ ...f, noun: '', value: '', label: '', matched: '', multi: false })));
    if (unknown) return unknown;
  }
  return null;
}

/**
 * The dimensions a run bound, keyed by the field names a caller writes for them.
 *
 * Structured mode fills from the same ledger the prose is scoped by, so a field
 * called `pipeline` holds the pipeline rather than the measure that shares its
 * id.
 */
function scopeFields(ledger: QualifierLedger): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of ledger.bound()) {
    if (!entry.resolved || entry.kind === 'metric' || entry.kind === 'limit') continue;
    for (const alias of [entry.kind, `${entry.kind}_name`, `${entry.kind}_label`]) {
      if (out[alias] === undefined) out[alias] = entry.resolved.label;
    }
  }
  return out;
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
/**
 * A follow-up carries the question it follows.
 *
 * "And how many of those are in Negotiation?" names no measure and no object
 * type on its own, and reading it alone refused it — with a sentence denying
 * the workspace holds a stage it lists by name elsewhere. The subject of the
 * conversation is the last question a person asked, not the sentence in
 * isolation.
 */
const FOLLOW_UP = /^\s*(and|also|what\s+about|how\s+about|ok|okay|then|now|plus)\b|\b(of\s+(?:those|them|these)|those|them|the\s+same)\b|\b(?:largest|biggest|smallest|highest|lowest|best|worst|first|last|next|other|same|which)\s+ones?\b/i;

function priorQuestion(req: AiCompletionRequest): string | null {
  const turns = req.messages.filter((m) => m.role === 'user');
  const prior = turns.slice(0, -1).reverse().find((m) => m.content.trim().length > 0);
  return prior?.content ?? null;
}

/**
 * The whole chain of follow-ups this turn belongs to, newest first.
 *
 * A scope survives more than one turn. "How much open pipeline does Priya
 * Raman own?" → "And in the Renewal pipeline?" → "What about Marcus Ilori?" →
 * "Show me the three smallest of those." is one question in four sentences,
 * and reading only the sentence before this one lost the pipeline on turn
 * four: "those" named a two-row set and came back as nine deals from three
 * pipelines, two of them new business.
 *
 * The chain stops at the turn that started it — the first one back that is not
 * itself a follow-up — so a scope cannot leak across a change of subject.
 */
function followUpChain(req: AiCompletionRequest): string[] {
  const turns = req.messages.filter((m) => m.role === 'user' && m.content.trim().length > 0);
  const prior = turns.slice(0, -1).reverse();
  const chain: string[] = [];
  for (const turn of prior) {
    chain.push(turn.content);
    if (!FOLLOW_UP.test(turn.content)) break;
  }
  return chain;
}

function priorEntities(req: AiCompletionRequest, index: EntityIndex, options: Parameters<typeof resolveEntities>[2]): ResolvedEntity[] {
  const turns = req.messages.filter((m) => m.role === 'user').slice(0, -1).slice(-CARRY_TURNS).reverse();
  const out: ResolvedEntity[] = [];
  for (const turn of turns) out.push(...resolveEntities(focusText(turn.content), index, options));
  return out;
}

/** The two periods a comparison will measure, and how they were chosen. */
/**
 * The narrowings a planned step actually carries.
 *
 * Read off the arguments rather than off a list of tool names, so a capability
 * added tomorrow is measured by the same rule: a property in a `conditions`
 * entry, a stage, an owner, a pipeline, a subject, a meter, an association.
 */
export function narrowingKeys(step: { tool: string; args: Record<string, unknown> }): Set<string> {
  const keys = new Set<string>();
  const conditions = step.args.conditions;
  if (Array.isArray(conditions)) {
    for (const condition of conditions) {
      const property = (condition as { property?: unknown } | null)?.property;
      if (typeof property === 'string') keys.add(property);
    }
  }
  for (const name of ['stage', 'stages', 'owner_id', 'pipeline', 'subject_id', 'customer_id', 'meter', 'associated_to_any', 'status']) {
    const value = step.args[name];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && !value.length) continue;
    keys.add(name);
  }
  return keys;
}

/** The rows a step measures, so two steps are only compared over the same ones. */
function stepDomain(step: { tool: string; args: Record<string, unknown> }): string | null {
  const objectType = step.args.object_type;
  if (typeof objectType === 'string') return objectType;
  const metric = step.args.metric;
  // Every sales measure in this catalogue is computed over deal rows, so a
  // deal search and a pipeline total are two readings of the same set.
  if (typeof metric === 'string') return DEAL_METRICS.has(metric) ? 'deal' : `metric:${metric}`;
  return null;
}

/** Narrowings a measure carries by definition rather than because it was asked for. */
const IMPLICIT_KEYS = new Set(['deal_stage', 'stage', 'stages', 'status']);

const DEAL_METRICS = new Set([
  'pipeline', 'weighted_pipeline', 'closed_won', 'closed_lost', 'bookings', 'deal_count',
  'average_deal_size', 'win_rate', 'sales_cycle', 'forecast',
]);

/**
 * Drop every step that measures the same rows as another step with strictly
 * fewer of the question's narrowings on it.
 *
 * The survivor is the step that carries the reader's words. Nothing is dropped
 * when the two steps measure different things — a ticket count beside a deal
 * total is two answers to a two-part question, not a wide one and a narrow one.
 */
export function narrowestSteps<T extends { tool: string; args: Record<string, unknown> }>(steps: T[]): T[] {
  if (steps.length < 2) return steps;
  const keyed = steps.map((step) => ({ step, domain: stepDomain(step), keys: narrowingKeys(step) }));
  return keyed
    .filter((candidate) => !keyed.some((other) => other !== candidate
      && other.domain !== null && other.domain === candidate.domain
      && other.keys.size > candidate.keys.size
      && [...candidate.keys].every((key) => other.keys.has(key))
      // A stage set is not a narrowing the reader wrote — it is how the wider
      // measure is defined. The briefing runs `business_metric` beside a search
      // over the open stages, and dropping the overview because its evidence
      // rows name the stages it is already over left the reader's period bound
      // to nothing. Only a genuinely extra dimension demotes a step.
      && [...other.keys].some((key) => !candidate.keys.has(key) && !IMPLICIT_KEYS.has(key))))
    .map((candidate) => candidate.step);
}

/**
 * The intents whose answers state a number.
 *
 * The failure this gate exists to stop is a figure that answers a different
 * question, so it runs over the question shapes that produce figures. A draft,
 * a plan, a briefing and a diagnosis are prose built from cited facts and are
 * governed by the citation rules instead; holding a summary to the same token
 * accounting would refuse "catch me up on Meridian" for the word "catch".
 */
const COVERED_INTENTS = new Set<TaskIntent>(['aggregate', 'compare', 'lookup']);

/** The grain, counting and boundary words a period is written with. */
const PERIOD_WORDS = [
  'year', 'years', 'quarter', 'quarters', 'month', 'months', 'week', 'weeks', 'day', 'days',
  'hour', 'hours', 'fortnight', 'half', 'halves', 'season', 'ytd', 'qtd', 'mtd', 'trailing',
  // "in the past 30 days" spends "past" on the window it resolved to. Nothing
  // spends it when no window resolved, which is what makes "past their close
  // date" a comparison this plan has to carry or refuse.
  'past',
  'rolling', 'over', 'through', 'across', 'ending', 'ended', 'starting', 'started', 'between',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'twenty', 'thirty', 'sixty', 'ninety',
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june',
  'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october', 'nov',
  'november', 'dec', 'december',
];

/** The words that ask for one end of an ordering. */
const SUPERLATIVES = [
  'biggest', 'largest', 'highest', 'greatest', 'top', 'best', 'most', 'maximum', 'max',
  'smallest', 'lowest', 'least', 'fewest', 'worst', 'bottom', 'minimum', 'min',
  'oldest', 'newest', 'latest', 'soonest', 'first', 'last', 'longest', 'shortest',
  'biggest', 'ranked', 'ranking', 'rank', 'order', 'ordered', 'sorted', 'leading',
];

/** The verbs a metered workspace measures volume with. */
const USAGE_VERBS = [
  'send', 'sent', 'sending', 'stream', 'streamed', 'streaming', 'ingest', 'ingested',
  'consume', 'consumed', 'consumption', 'burn', 'burned', 'burnt', 'push', 'pushed',
  'emit', 'emitted', 'upload', 'uploaded', 'store', 'stored', 'storing', 'meter',
  'metered', 'metering', 'use', 'used', 'usage', 'peak', 'peaked', 'draw', 'drew', 'drawn',
];

/**
 * The operators that mean "not this", and the words a reader writes them with.
 *
 * A negation is the only kind of qualifier that narrows a question by removing
 * rows, and it used to be furniture: "never", "no" and "without" were dropped
 * in silence, so a question about the companies with no deals was answered with
 * every company. The words are accounted for exactly when the plan carries one
 * of these operators — or when the capability that ran is itself published in
 * those words, which is how `stale_accounts` ("no logged activity", "what have
 * we not touched") spends them.
 */
const NEGATING_OPS = new Set(['is_not_set', 'not_in', 'neq', 'ne', 'not_contains', 'is_null', '!=', '<>']);

const NEGATIONS = [...NEGATION_WORDS];

/** The words that put a name in an owner slot. */
const OWNERSHIP = [
  'own', 'owns', 'owned', 'owning', 'owner', 'owners', 'ownership',
  'assigned', 'belongs', 'belonging', 'managed', 'manages', 'managing', 'manager',
  'carrying', 'carries', 'carry', 'carried', 'book', 'books', 'led', 'leads', 'leading',
  'rep', 'reps', 'representative', 'seller', 'ae', 'quota', 'working', 'runs', 'run',
];

/** The nouns a question uses for each object type this engine can query. */
const TYPE_NOUNS: Record<string, string[]> = {
  deal: ['deal', 'deals', 'opportunity', 'opportunities', 'pipeline'],
  company: ['company', 'companies', 'account', 'accounts', 'business', 'businesses', 'logo', 'logos', 'organisation', 'organization'],
  customer: ['customer', 'customers', 'client', 'clients', 'account', 'accounts'],
  contact: ['contact', 'contacts', 'person', 'people', 'buyer', 'buyers', 'champion', 'champions', 'stakeholder', 'stakeholders'],
  ticket: ['ticket', 'tickets', 'case', 'cases', 'issue', 'issues', 'escalation', 'escalations'],
  invoice: ['invoice', 'invoices', 'bill', 'bills'],
  subscription: ['subscription', 'subscriptions', 'plan', 'plans'],
  credit: ['credit', 'credits', 'grant', 'grants', 'balance', 'balances'],
  usage: ['usage', 'used', 'consumption', 'consumed', 'metered', 'meter', 'meters', 'metering'],
  activity: ['activity', 'activities', 'meeting', 'meetings', 'call', 'calls', 'email', 'emails', 'note', 'notes', 'task', 'tasks'],
  payment: ['payment', 'payments', 'paid', 'collection', 'collections'],
  product: ['product', 'products', 'price', 'prices', 'plan', 'plans'],
};

/**
 * The rows each measure in the catalogue is computed over.
 *
 * Used to check that the object type the question named is the object type some
 * planned step actually queries — the difference between "how many billing
 * tickets do we have?" answered from the support desk and answered with
 * $76,450.05 of collected revenue.
 */
const METRIC_ROWS: Record<string, string> = {
  spend: 'invoice', revenue: 'invoice', invoiced: 'invoice', outstanding: 'invoice',
  pipeline: 'deal', weighted_pipeline: 'deal', closed_won: 'deal', closed_lost: 'deal',
  win_rate: 'deal', avg_deal_size: 'deal', sales_cycle: 'deal', deal_count: 'deal',
  new_customers: 'company', customers: 'company', churn: 'company',
  open_tickets: 'ticket', tickets_created: 'ticket', resolution_time: 'ticket', csat: 'ticket',
  activities: 'activity', meetings: 'activity',
  connected_assets: 'company',
  net_revenue_retention: 'subscription', gross_revenue_retention: 'subscription',
  mrr: 'subscription', arr: 'subscription',
};

/** The object types some planned step really reads rows from. */
export function queriedTypes(plan: { tool: string; args: Record<string, unknown> }[], groupBy: GroupBy = 'none'): Set<string> {
  const out = new Set<string>();
  // A breakdown by account reads the accounts, whatever the measure is over.
  if (groupBy === 'account') { out.add('company'); out.add('customer'); }
  if (groupBy === 'owner') out.add('user');
  for (const step of plan) {
    const objectType = step.args.object_type;
    if (typeof objectType === 'string') out.add(objectType);
    const metric = step.args.metric;
    if (typeof metric === 'string' && METRIC_ROWS[metric]) out.add(METRIC_ROWS[metric]);
    if (step.args.meter) out.add('usage');
    // A capability named for its own domain reads that domain's rows. The
    // ledger names itself with a dot — `credits.balance` — so the split has to
    // take both separators, or a credit question is refused for naming grants.
    const domain = step.tool.split(/[._]/)[0];
    if (domain === 'billing') out.add('invoice');
    if (domain === 'credits') out.add('credit');
    if (step.tool.includes('invoice')) out.add('invoice');
    if (step.tool.includes('subscription')) out.add('subscription');
    if (step.tool.includes('usage') || step.tool.includes('meter')) out.add('usage');
    if (step.tool.includes('customer') || step.tool.includes('account')) { out.add('customer'); out.add('company'); }
    if (step.tool === 'account_profile') { out.add('company'); out.add('customer'); out.add('deal'); out.add('contact'); out.add('ticket'); }
    if (step.tool === 'record_timeline' || step.tool === 'workspace_search') out.add('activity');
  }
  // A company question and a customer question read the same accounts.
  if (out.has('company')) out.add('customer');
  if (out.has('customer')) out.add('company');
  return out;
}

/** Every record id that reached a planned step's arguments. */
export function idsInPlan(plan: { args: Record<string, unknown> }[]): Set<string> {
  const out = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === 'string') { if (/^[a-z][a-z_]*_[A-Za-z0-9]{2,}$/.test(value)) out.add(value); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>)) visit(item, depth + 1);
  };
  for (const step of plan) visit(step.args, 0);
  return out;
}

/**
 * Every word this workspace's own job titles are made of, plus their acronyms.
 *
 * A profile step hands back the account's buying committee, so a question that
 * names a role is answered by it — and "CFO" is how anyone writes "Chief
 * Financial Officer".
 */
const titleCache = new Map<string, string[]>();
export function jobTitleWords(ctx: Ctx, orgId: string): string[] {
  const cached = titleCache.get(orgId);
  if (cached) return cached;
  const titles = ctx.db.all<{ title: string }>(
    `SELECT DISTINCT json_extract(properties, '$.job_title') AS title FROM crm_records
      WHERE org_id = ? AND object_type = 'contact' AND json_extract(properties, '$.job_title') IS NOT NULL`,
    orgId,
  ).map((row) => row.title).filter(Boolean);
  const out = new Set<string>();
  for (const title of titles) {
    for (const word of normalise(title).split(' ')) if (word.length > 1) out.add(word);
    const acronym = acronymOf(title);
    if (acronym.length >= 2) out.add(normalise(acronym));
  }
  const words = [...out];
  titleCache.set(orgId, words);
  return words;
}

/**
 * Every word this workspace enumerates, which a tool's prose may not spend.
 *
 * The nouns it calls its rows, and every surface form of every value of every
 * enumeration it holds. Each of these has a place in the plan to reach — the
 * object-type rule, a record filter, the qualifier ledger — and until it reaches
 * one, the question is not accounted for. Letting a capability's description
 * claim them instead is how "how many tickets are about connectivity?" was
 * answered with the quarter's ticket volume: `business_metric` publishes its
 * whole metric list in its blurb, and the blurb was read as comprehension.
 */
const enumeratedCache = new Map<string, Set<string>>();
export function enumeratedWords(ctx: Ctx, orgId: string, types: string[]): Set<string> {
  const key = `${orgId}:${[...types].sort().join(',')}`;
  const cached = enumeratedCache.get(key);
  if (cached) return cached;
  const out = new Set<string>();
  const add = (phrase: string): void => {
    for (const word of normalise(phrase).split(' ')) if (word.length > 2) out.add(word);
  };
  for (const nouns of Object.values(TYPE_NOUNS)) for (const noun of nouns) add(noun);
  // Only the types this question is about. "New" is a lead status and a ticket
  // status, and reserving it for every question made `revenue_movement`'s own
  // published word — "new, expansion, contraction, churn" — unreadable, so
  // "how much new MRR did we add last quarter?" refused a report it holds.
  for (const type of new Set(types)) {
    if (!CRM_OBJECT_TYPES.has(type)) continue;
    for (const dimension of dimensionsOf(ctx, orgId, type, new Set())) {
      for (const option of dimension.options) {
        add(option.label);
        for (const form of option.open) add(form);
      }
    }
  }
  enumeratedCache.set(key, out);
  return out;
}

/** Every numeric property a record search can compare against, per type. */
export function numericProperties(ctx: Ctx, orgId: string, types: string[]): CoverageNumeric[] {
  const out: CoverageNumeric[] = [];
  for (const objectType of types) {
    if (!CRM_OBJECT_TYPES.has(objectType)) continue;
    for (const [property, definition] of propertyMap(ctx, orgId, objectType)) {
      if (definition.type !== 'number' && definition.type !== 'currency') continue;
      out.push({ objectType, property, noun: definition.label });
    }
  }
  return out;
}

/**
 * Every span of the question some part of this run consumed.
 *
 * One entry per claimant, with the claimant named, so a refusal can tell the
 * reader what *was* read as well as what was not.
 */
export function coverageClaims(input: {
  question: string;
  metric: MetricDetection | null;
  windows: TimeWindow[];
  mentions: { text: string }[];
  entities: ResolvedEntity[];
  qualifiers: QualifierLedger;
  recordFilters: RecordFilter[];
  types: string[];
  meter: ResolvedEntity | null;
  currencyWord: { code: string; matched: string } | null;
  order: { text: string } | null;
  /** The record ids that reached a planned step's arguments. */
  usedIds: Set<string>;
  /** The object types some planned step actually queries. */
  queriedTypes: Set<string>;
  ranking: boolean;
  ownerBound: boolean;
  dateNoun: { property: string; label: string; text: string } | null;
  /** Every phrase this workspace uses to name one of its own dimensions. */
  dimensionAnchors: string[];
  /** The capabilities the plan runs, with the words they publish themselves under. */
  capabilities: { name: string; description: string }[];
  plannedArgs: { tool: string; args: Record<string, unknown> }[];
  balance: boolean;
  usage: boolean;
  /** Job titles and their acronyms, when a step returns people. */
  roleWords: string[];
  /** The meters and features a ledger step's numbers are denominated in. */
  units: string[];
  /**
   * Every word this workspace enumerates as a value, a row noun or a measure.
   *
   * A capability's description is a catalogue of everything it *could* do —
   * `business_metric` publishes the whole metric list, `record_search`
   * publishes "open deals over $100k, tickets escalated this week, companies in
   * a region" — and reading it as a claim let the prose spend the reader's own
   * qualifier. "How many tickets are about connectivity?" came back as the
   * quarter's 14 tickets with the category gone, and "how many billing tickets
   * do we have?" came back as $76,450.05 of collected revenue: in both, the
   * word that narrowed the question was reported as understood because a tool's
   * blurb happened to contain it. A word this workspace enumerates has to reach
   * an argument. Prose may only spend the words nothing here enumerates.
   */
  reservedWords: Set<string>;
}): CoverageClaim[] {
  const claims: CoverageClaim[] = [];
  const reserved = (word: string): boolean => input.reservedWords.has(word) || input.reservedWords.has(stem(word));
  if (input.metric) claims.push({ text: input.metric.matched, by: `the measure ${input.metric.metric.label}` });
  for (const window of input.windows) claims.push({ text: window.matched, by: `the period ${window.label}` });
  for (const mention of input.mentions) claims.push({ text: mention.text, by: 'a period' });
  // The grain and counting words a period is written with. "over the last six
  // months" resolves to one window whose own `matched` span is shorter than the
  // phrase the reader typed; the rest of that phrase is the period, not stray
  // content, and it is spent the moment the window binds.
  if (input.windows.length || input.mentions.length) {
    for (const word of PERIOD_WORDS) claims.push({ text: word, by: 'the period' });
  }
  // A record only spends the reader's words when the plan actually queried it.
  //
  // "How many security tickets do we have?" resolved the ticket *called*
  // "Security review: outbound firewall rules for OT segment" at 0.56, ran
  // nothing about it, and the word "security" was reported as read — so the
  // answer was all 35 tickets with the reader's filter silently gone. A record
  // the plan never reached explains nothing and claims nothing.
  for (const entity of input.entities) {
    if (!input.usedIds.has(entity.entity.id)) continue;
    claims.push({ text: entity.mention, by: `the ${entity.entity.type} ${entity.entity.label}` });
    claims.push({ text: entity.entity.label, by: `the ${entity.entity.type} ${entity.entity.label}` });
    for (const alias of entity.entity.aliases) claims.push({ text: alias, by: `the ${entity.entity.type} ${entity.entity.label}` });
  }
  for (const entry of input.qualifiers.entries) {
    claims.push({ text: entry.text, by: `the ${kindNoun(entry.kind)} "${entry.text}"` });
    if (entry.resolved?.label) claims.push({ text: entry.resolved.label, by: `the ${kindNoun(entry.kind)} "${entry.text}"` });
  }
  for (const filter of input.recordFilters) {
    claims.push({ text: filter.matched, by: `the ${(filter.noun ?? filter.property).toLowerCase()} filter` });
    if (filter.label) claims.push({ text: filter.label, by: `the ${(filter.noun ?? filter.property).toLowerCase()} filter` });
  }
  // The noun a question uses for its rows is only spent when some step queried
  // those rows. "How many billing tickets do we have?" planned `business_metric`
  // over *invoices* and answered with $76,450.05 collected — a revenue figure
  // under a question about support tickets, with the word "tickets" reported as
  // understood because the sentence contained it.
  for (const type of input.types) {
    if (!input.queriedTypes.has(type)) continue;
    for (const noun of TYPE_NOUNS[type] ?? [type]) claims.push({ text: noun, by: `the ${type} rows` });
  }
  if (input.meter && input.usedIds.has(input.meter.entity.id)) {
    claims.push({ text: input.meter.mention, by: `the meter ${input.meter.entity.label}` });
    claims.push({ text: input.meter.entity.label, by: `the meter ${input.meter.entity.label}` });
  }
  if (input.currencyWord) claims.push({ text: input.currencyWord.matched, by: `the currency ${input.currencyWord.code.toUpperCase()}` });
  if (input.order) claims.push({ text: input.order.text, by: 'the ordering' });
  // A superlative is the instruction that produced the ordering, and the
  // ordering is in the plan. "Who is my biggest customer?" spends "biggest" on
  // the ranking exactly as "in Q2" spends its words on the period.
  const ordered = input.plannedArgs.some((step) => step.args.order_by !== undefined
    || step.args.direction !== undefined || step.args.limit !== undefined);
  if (input.ranking || input.order || ordered) {
    for (const word of SUPERLATIVES) claims.push({ text: word, by: 'the ranking' });
  }
  // The verbs that put a name in an owner slot, once an owner is bound.
  if (input.ownerBound) {
    for (const word of OWNERSHIP) claims.push({ text: word, by: 'the owner' });
  }
  // The noun that picked the date column — "created", "closing", "due".
  if (input.dateNoun) claims.push({ text: input.dateNoun.text, by: `the ${input.dateNoun.label} column` });
  // A measure's own vocabulary. "What is the Renewal pipeline worth?" spends
  // "worth" on Open pipeline, and "how much did we book" spends "book" on
  // closed-won bookings — both are the measure's own words, not stray content.
  if (input.metric) {
    for (const phrase of [input.metric.metric.label, ...(input.metric.metric.phrases ?? []), ...input.metric.metric.keywords]) {
      claims.push({ text: phrase, by: `the measure ${input.metric.metric.label}` });
    }
  }
  // The names this workspace gives its own dimensions — "stage", "category",
  // "product area", "came from". A dimension's *name* narrows nothing on its
  // own; only a value does, and a value is claimed only when it binds.
  for (const anchor of input.dimensionAnchors) claims.push({ text: anchor, by: 'a dimension this workspace enumerates' });
  // A capability spends the words of its own name and of the sentence this
  // workspace publishes it under. "Show me the recovery queue" runs
  // `payments_recovery_queue`; "which accounts have gone quiet" runs the
  // capability whose own description is about accounts that have gone quiet.
  // Those words are read, by the tool, and reading them is what the plan is.
  const negation = new Set(NEGATIONS);
  const askedWords = new Set(normalise(input.question).split(' ').filter(Boolean).map(stem));
  for (const capability of input.capabilities) {
    claims.push({ text: capability.name.replace(/[._]/g, ' '), by: `\`${capability.name}\``, exact: true });
    for (const word of capability.name.split(/[._]/)) claims.push({ text: word, by: `\`${capability.name}\``, exact: true });
    const described = contentWords(capability.description).filter((word) => !reserved(word));
    for (const word of described) {
      // A negation is the one word a description may not spend on its own.
      // `record_search` publishes its operator list — "eq, neq, in, not_in …" —
      // so every plan that touched it claimed the reader's "no" and "not", and
      // "how many companies have no open deals?" came back as $9,010,960 of
      // open pipeline. A capability spends a negation only where it is talking
      // about the same absence the reader is: the words beside it in the
      // description have to be words the question itself uses, which is how
      // `stale_accounts` ("what have we not touched") answers for "which
      // accounts have not been touched in 90 days".
      if (!negation.has(word)) { claims.push({ text: word, by: `\`${capability.name}\``, exact: true }); continue; }
      const at = described.indexOf(word);
      const nearby = described.slice(Math.max(0, at - 3), at + 4).filter((near) => !negation.has(near));
      if (nearby.some((near) => askedWords.has(stem(near)))) {
        claims.push({ text: word, by: `\`${capability.name}\``, exact: true });
      }
    }
  }
  // The names of the arguments a step was actually given. `stale_accounts` is
  // called with `days: 120`, so the reader's word "days" is the parameter this
  // plan filled — reading it back as an unknown noun refused a question this
  // engine answers exactly.
  for (const step of input.plannedArgs) {
    for (const [key, value] of Object.entries(step.args)) {
      if (value === undefined || value === null) continue;
      for (const word of key.split('_')) claims.push({ text: word, by: `\`${step.tool}.${key}\`` });
      // A column the step was told to order, group or date by is named in the
      // sentence too: "by amount", "closing soonest", "by stage".
      if (['order_by', 'group_by', 'date_property', 'measure', 'property'].includes(key) && typeof value === 'string') {
        for (const word of value.split('_')) claims.push({ text: word, by: `\`${step.tool}.${key}\`` });
      }
    }
    // "a 36-month contract term" is `contract_term_months`, and the column's
    // own name is what the reader wrote.
    const conditions = step.args.conditions;
    if (!Array.isArray(conditions)) continue;
    for (const condition of conditions) {
      const property = (condition as { property?: unknown } | null)?.property;
      if (typeof property !== 'string') continue;
      for (const word of property.split('_')) claims.push({ text: word, by: `the ${property.replace(/_/g, ' ')} filter` });
      // A negation in the question is an operator, and this is the operator.
      // "Which deals have no next step?" runs `next_step is_not_set`, and that
      // is what spends the reader's "no"; a plan with no negation in it spends
      // nothing, so "how many companies have never had a deal?" is a gap rather
      // than a count of every company.
      const op = String((condition as { op?: unknown } | null)?.op ?? '');
      if (NEGATING_OPS.has(op)) {
        for (const word of NEGATIONS) claims.push({ text: word, by: `the \`${property} ${op.replace(/_/g, ' ')}\` filter` });
      }
    }
  }
  // The vocabulary of every measure in the catalogue, once one of them bound.
  // "How many open deals do we have and what are they worth?" measures the
  // count and mentions the value; the second measure is a second question, not
  // an unread word, and the answer names both.
  //
  // Word for word, though, and never over a word this workspace enumerates.
  // The shared-opening rule let `connected_assets` spend the reader's
  // "connectivity" — a ticket category — and `tickets_created` spend the
  // "tickets" in a question the plan answered from the invoice book: two
  // questions answered with two confident figures about something else.
  if (input.metric) {
    for (const word of measureWords()) {
      if (reserved(word)) continue;
      claims.push({ text: word, by: 'the measure vocabulary', exact: true });
      // "we booked" and "did we book" are the same verb as "bookings"; one
      // stemming pass leaves "booking", which is not the word the reader wrote.
      const twice = stem(stem(word));
      if (twice !== word && twice.length >= 3) claims.push({ text: twice, by: 'the measure vocabulary', exact: true });
    }
  }
  // The predicate that made this a balance question rather than a consumption
  // question — "left", "remaining", "unused".
  if (input.balance) for (const word of ['left', 'remaining', 'remain', 'remains', 'unused', 'balance']) {
    claims.push({ text: word, by: 'the credit balance' });
  }
  // A meter in a balance question names the denomination of the pot rather than
  // a filter on it — "how many telemetry events are left" is a credit question
  // measured in telemetry events — so the meter's own words are spent by it.
  if (input.balance && input.meter) {
    claims.push({ text: input.meter.mention, by: `the unit ${input.meter.entity.label}` });
    claims.push({ text: input.meter.entity.label, by: `the unit ${input.meter.entity.label}` });
  }
  // The verbs a metered workspace measures with, once the plan reads a meter.
  if (input.usage) for (const word of USAGE_VERBS) claims.push({ text: word, by: 'the metered volume' });
  // A step that returns an account's card returns its buying committee with it,
  // so the job titles this workspace holds — and their acronyms — are words
  // that step reads. "Who is the CFO at Meridian Forge Systems?" is answered
  // off the profile, and "CFO" is the workspace's own Chief Financial Officer.
  for (const role of input.roleWords) claims.push({ text: role, by: 'a job title this workspace holds' });
  for (const unit of input.units) claims.push({ text: unit, by: 'a unit this workspace meters in' });
  // "Broken down by owner" is an instruction to the query, and the words that
  // spell it are spent on the grouping.
  const grouping = input.question.match(/\b(?:split|splits|broken\s+(?:down|out)|break\s+(?:down|out)|grouped|group|bucketed|segmented|sliced)(?:\s+up)?\s+by\s+[a-z]+\b/i)
    ?? input.question.match(/\b(?:by|per|each)\s+(?:month|quarter|week|day|year|rep|reps|owner|owners|stage|stages|industry|industries|region|regions|product|products|customer|customers|account|accounts|pipeline|pipelines|source|sources|type|types|category|categories)\b/i);
  if (grouping) claims.push({ text: grouping[0], by: 'the grouping' });
  return claims;
}

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
      const vocabulary = crmVocabulary(ctx, orgId);
      // A pipeline the question scopes to has already spent the word
      // "pipeline"; scoring a measure over it too turned "how much did we book
      // in the New business pipeline" into $4,385,460 of open pipeline, with
      // the metric qualifier reported bound to a question nobody asked. The
      // measure is read from the sentence with the scope taken out of it, and
      // only falls back to the whole sentence when that leaves no measure at
      // all — "what is the Renewal pipeline worth" names its metric there.
      const namedPipeline = pipelineIn(question, vocabulary);
      // The grouping dimension comes out too, for the same reason: "break down
      // bookings by pipeline" writes the word "pipeline" only because of the
      // grouping, and scoring the measure over it answered a bookings question
      // with open pipeline.
      const scoped = namedPipeline ? withoutPipelinePhrase(question, namedPipeline.text) : question;
      const measureText = withoutGroupingPhrase(scoped);
      const ownMetric = (measureText !== question ? detectMetric(measureText) : null) ?? detectMetric(question);
      // A follow-up inherits the measure of the turn it follows. Without this
      // the second turn of every thread reads as a question with no measure in
      // it and is refused, having just been answered.
      const carriedQuestion = priorQuestion(req);
      // A follow-up is the same question with a word changed, and the scope of
      // the turn before it is still in force: "what is the Renewal pipeline
      // worth?" then "and the smallest deal in it?" used to answer with an
      // Expansion deal, the pipeline gone and nothing in the reply saying so.
      // Every turn of the chain this one continues, so a scope set two turns
      // ago is still the scope. Newest first, so a turn that narrowed the
      // pipeline again wins over the one that set it originally.
      const threadScope = carriedQuestion && FOLLOW_UP.test(question)
        ? followUpChain(req).join(' \u2014 ')
        : null;
      const followsOn = !ownMetric && !!carriedQuestion && FOLLOW_UP.test(question);
      const inheritedMetric = followsOn ? detectMetric(carriedQuestion!) : null;
      let metric = ownMetric ?? inheritedMetric;
      if (inheritedMetric) {
        reasoning.push(`"${question.trim()}" names no measure of its own; carried ${inheritedMetric.metric.label} forward from "${truncate(carriedQuestion!, 60)}", the question it follows.`);
      }
      if (namedPipeline && measureText !== question) {
        reasoning.push(`"${namedPipeline.text}" is a pipeline in this workspace, so the measure is read from "${measureText.replace(/\s+/g, ' ').trim()}" — the sentence with the scope taken out of it${metric ? `, which names ${metric.metric.label}` : ''}.`);
      }
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
      // A dimension value can contain the noun of a record type it has nothing
      // to do with: "the Best case forecast category" holds the word "case",
      // which read as a *ticket* — so a question about deals arrived carrying a
      // ticket status filter and refused itself for naming two statuses. The
      // words a dimension value spends are not also a type cue, so the types
      // are read again from the sentence with those spans taken out.
      const firstTypes = mentionedTypes(question);
      const firstFilters = intent.intent === 'act' || intent.intent === 'draft'
        ? []
        : recordPropertyFilters(ctx, orgId, question, firstTypes, stageSets(ctx, orgId));
      const spent = firstFilters.reduce((text, filter) => text.replace(filter.matched, ' '), question);
      const ownTypes = spent === question ? firstTypes : mentionedTypes(spent);
      // The object type comes forward with the measure: "how many of those" is
      // a question about the same rows as the turn before it.
      const namedTypes = ownTypes.length || !followsOn ? ownTypes : mentionedTypes(carriedQuestion!);
      // Filters the sentence names on records that are not deals — a ticket's
      // status, a company's relationship, a contact's buying role. They are
      // read before resolution because the words that named one are not also
      // the name of a company: "how many contacts are decision makers" matched
      // "are decision" against Ardennes Précision at 0.47 and answered about
      // that one account, having been asked about the whole book.
      let recordFilters = intent.intent === 'act' || intent.intent === 'draft'
        ? []
        : ownTypes === firstTypes && namedTypes === ownTypes
          ? firstFilters
          : recordPropertyFilters(ctx, orgId, question, namedTypes, stageSets(ctx, orgId));
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
      // A name the sentence wrote into an owner slot is an owner. The contact
      // who shares a rep's first name is not a weaker match for one — it is a
      // different record, and letting it stay in the list is how a question
      // about Marcus Ilori's pipeline was answered about Whitcombe Aerospace.
      // A dimension value that sits inside a record's own name is part of that
      // name, not a filter the question wrote. "Summarise the Dashboard loads
      // slowly with 900 assets selected ticket" names one ticket exactly; read
      // as a `product_area` filter, that whole question was refused for naming
      // a dimension nothing could bind.
      // The test is whether the sentence wrote *more of the record's name* than
      // the value itself: "Dashboard loads slowly with 900 assets selected"
      // carries five more words of that ticket's name, so "Dashboard" is the
      // name. "pharmaceutical companies" carries none of Wexler
      // Pharmaceutical's other words, so it is the industry.
      const asked = ` ${normalise(question)} `;
      const insideAName = (matched: string): boolean => carriedFrom.entities.some((e) => {
        if (e.score < 0.7) return false;
        const value = normalise(matched);
        const label = normalise(e.entity.label);
        if (!` ${label} `.includes(` ${value} `)) return false;
        const rest = label.split(' ').filter((word) => word.length > 2 && !value.split(' ').includes(word));
        return rest.some((word) => asked.includes(` ${word} `));
      });
      const named = recordFilters.filter((filter) => !insideAName(filter.matched));
      if (named.length !== recordFilters.length) {
        reasoning.push(`Dropped ${recordFilters.length - named.length} record ${recordFilters.length - named.length === 1 ? 'filter' : 'filters'} whose words are part of a record's own name (${recordFilters.filter((f) => insideAName(f.matched)).map((f) => `"${f.matched}"`).join(', ')}) — a value inside a name is the name.`);
        recordFilters = named;
      }
      let entities = dropQualifierWords(
        resolveOwnerSlots(question, dropPeriodWords(dropTypeConfusion(carriedFrom.entities), question)),
        recordFilters,
      );
      // "How much pipeline do I own?" names an owner — the person asking — and
      // the first person was not in any vocabulary, so the name was dropped and
      // the $9,010,960 workspace figure was stated as the answer to a question
      // about one rep's book.
      const firstPerson = /\b(?:do|does|did)\s+i\s+(?:own|have|manage|carry)\b|\bi\s+own\b|\bmy\s+(?:open\s+|weighted\s+|closed\s+|won\s+|lost\s+|current\s+|total\s+)*(?:pipeline|deals?|book|quota|forecast|accounts?|tickets?|customers?|numbers?)\b|\bassigned\s+to\s+me\b|\bmine\b|\bowned\s+by\s+me\b/i;
      if (firstPerson.test(question) && call.actorId && !entities.some((e) => e.entity.type === 'user')) {
        const me = index.entities.find((e) => e.type === 'user' && e.id === call.actorId);
        if (me) {
          entities.unshift({
            entity: me,
            score: 0.95,
            rule: 'id',
            mention: question.match(firstPerson)?.[0] ?? 'I',
            explain: `${me.label} — the person asking, named in the first person`,
          });
          reasoning.push(`"${question.match(firstPerson)?.[0]}" names the person asking; this answer is scoped to ${me.label}, not to the workspace.`);
        }
      }
      const carried = carriedFrom.carried;
      if (entities.length < carriedFrom.entities.length) {
        const dropped = carriedFrom.entities.filter((e) => !entities.includes(e));
        reasoning.push(`Dropped ${dropped.length} weaker ${dropped.length === 1 ? 'match' : 'matches'} on a teammate's own name (${dropped.map((e) => `${e.entity.label} — ${e.entity.type}`).join(', ')}): a person named in an owner slot is an owner, and a lower-scoring record of another type is a different question, not a fallback.`);
      }
      let subject = asSubject(entities.find((e) => SUBJECT_TYPES.includes(e.entity.type)));
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
      // A meter matched on words that belong to an account's own name is not a
      // meter. "Is Fairhaven Dairy Co-operative at its seat limit?" resolved
      // "Active operator seats" out of "operative at its seat" — half the
      // company's name and half the question's furniture — and then refused the
      // whole question because nothing in the plan takes a meter.
      const subjectWords = new Set(entities
        .filter((e) => SUBJECT_TYPES.includes(e.entity.type))
        .flatMap((e) => normalise(e.entity.label).split(' ').filter((word) => word.length > 3)));
      // A meter whose *whole name* is written in the question is that meter,
      // whatever account name shares a word with it.
      //
      // `Peak connected robots` was unreachable by every phrasing: the account
      // Granite Peak Mining Equipment lends the word "peak" to the subject-word
      // filter, and the filter dropped the meter on that one overlap — so
      // "Peak connected robots for August 2026" came back as Granite Peak's
      // 132 connected assets, a different account's number under the meter's
      // own name. The test is how much of the meter's name the question
      // actually holds, not whether one word of it is also somebody's.
      const labelCoverage = (m: ResolvedEntity): number => {
        const asked = new Set(normalise(question).split(' '));
        const label = normalise(m.entity.label).split(' ').filter((word) => word.length > 2);
        return label.length ? label.filter((word) => asked.has(word)).length / label.length : 0;
      };
      const meters = resolveEntities(question, index, { only: ['meter'], limit: 3, minScore: METER_MIN })
        .filter((m) => ['id', 'name_exact', 'alias_exact', 'core_exact'].includes(m.rule)
          || labelCoverage(m) >= METER_LABEL_COVERAGE
          || !normalise(m.mention).split(' ').some((word) => subjectWords.has(word)));
      // A meter's name is matched against a span of the sentence, and the span
      // carries the sentence's furniture with it: "How many robots did
      // Ironwood Packaging Group peak at in August 2026?" matched "many robots
      // did" against "Peak connected robots" at 0.577 — over the bar to be a
      // candidate, under the bar to be the question's subject — so the meter
      // entered the ledger, bound to nothing, and the whole question was
      // refused. Scored on the words the two actually share, it is the meter.
      for (let at = 0; at < meters.length; at += 1) {
        const shared = sharedWords(meters[at].mention, [meters[at].entity.label]);
        if (!shared || normalise(shared) === normalise(meters[at].mention)) continue;
        const cleaned = resolveEntities(shared, index, { only: ['meter'], limit: 1, minScore: METER_MIN })[0];
        if (cleaned && cleaned.entity.id === meters[at].entity.id && cleaned.score > meters[at].score) {
          meters[at] = cleaned;
        }
      }
      meters.sort((a, b) => b.score - a.score);
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
      // A decisive meter in a question that asks for a quantity of it *is* the
      // question, whatever the span it matched on scored. "How many robots did
      // Ironwood Packaging Group peak at in August 2026?" matched "Peak
      // connected robots" — the only meter that matched at all — at 0.577,
      // three hundredths under the bar, and the whole question came back as
      // 'you asked about the meter "many robots did"'. The meter is live and
      // the number exists.
      const quantityAsked = /\bhow\s+(?:many|much)\b/i.test(question)
        && /\b(meter|meters|metered|metering|peak|peaked|use|used|using|consume[ds]?|consumed|ingest(?:ed)?|stream(?:ed)?|store[ds]?|send|sent|burn(?:ed|t)?)\b/i.test(question);
      // The question wrote a meter's whole name, and a sales measure matched on
      // a fragment of that same name. `Peak connected robots` lost every
      // phrasing to the `connected_assets` metric and to the account Granite
      // Peak Mining Equipment, both of which matched on words belonging to the
      // meter — so a published meter was unreachable and one phrasing answered
      // it with a different account's asset count. When the meter's name is
      // what the sentence says, the meter is the measure and the words are its
      // own, not a company's.
      const meterOwnsMeasure = !!meter && labelCoverage(meter) >= METER_LABEL_COVERAGE
        && (!metric || normalise(metric.matched).split(' ').filter((w) => w.length > 2)
          .every((word) => normalise(meter.entity.label).split(' ').includes(word)));
      if (meterOwnsMeasure && meter) {
        const meterWords = new Set(normalise(meter.entity.label).split(' ').filter((w) => w.length > 2));
        // Only the content of the span counts: "was our peak" is the word
        // "peak" plus two words of grammar, and the record it matched borrowed
        // that one word from the meter.
        const borrowed = entities.filter((e) => {
          if (e.entity.type === 'meter') return false;
          const said = contentWords(e.mention).filter((word) => word.length > 2);
          return said.length > 0 && said.every((word) => meterWords.has(word));
        });
        reasoning.push(`"${question.trim()}" writes out ${meter.entity.label} in full, so ${metric ? `the measure "${metric.matched}"` : 'the measure'} and ${borrowed.length ? listPhrase(borrowed.map((e) => e.entity.label)) : 'nothing else'} matched on that meter's own words; the meter is what this question names.`);
        metric = null;
        entities = entities.filter((e) => !borrowed.includes(e));
        subject = asSubject(entities.find((e) => SUBJECT_TYPES.includes(e.entity.type)));
      }
      const usageFromMeter = !!meters[0] && !metric
        && (meters[0].score >= METER_STRONG || (!!meter && quantityAsked)
          // The question wrote the meter's name out; that is not a weak match,
          // it is the name.
          || (!!meter && labelCoverage(meters[0]) >= METER_LABEL_COVERAGE))
        && !namedTypes.includes('usage')
        // A question that writes a meter's name out is a usage question however
        // it is phrased: "Peak connected robots for August 2026" is not a
        // lookup of an account whose name shares a word with it.
        && (intent.intent === 'aggregate' || intent.intent === 'compare' || meterOwnsMeasure);
      const meterTypes = usageFromMeter ? [...namedTypes, 'usage'] : namedTypes;
      if (usageFromMeter) {
        reasoning.push(`"${meters[0].mention}" is ${meters[0].entity.label}, a meter in ${workspace.name}, and the question names no sales metric — so this is a question about metered usage.`);
      }
      // "How many telemetry events does Meridian have left?" measures in a
      // meter and asks about a pot. Consumption is not an answer to it — it is
      // a different number, 3,700 times larger on this book — so the credit
      // ledger takes the question and the meter stays a denomination.
      const balanceQuestion = isBalanceQuestion(question, meterTypes);
      const types = balanceQuestion
        ? ['credit', ...meterTypes.filter((t) => t !== 'usage' && t !== 'credit')]
        : meterTypes;
      if (balanceQuestion) {
        reasoning.push(`"${question.match(/\b(left|remaining|remain|remains|unused|drawn\s+down|balance)\b/i)?.[0]}" asks what is left, which is a balance on the credit ledger — metered consumption is a different quantity and cannot settle it.`);
      }

      /* 4. which metric and grouping */
      if (metric) reasoning.push(`Metric: ${metric.metric.label} (matched "${metric.matched}", score ${metric.score})${metric.alternatives.length ? `, over ${metric.alternatives.map((a) => a.id).join(', ')}` : ''}.`);
      if (groupBy !== 'none') reasoning.push(`Grouping requested: by ${groupBy}.`);
      if (ranking) reasoning.push(`The question asks for a ranking, so the answer leads with the ordered groups rather than a list of records.`);

      /* 4b. every qualifier the question named, in one typed ledger */
      // One invariant instead of a guard per qualifier: whatever narrows the
      // question — a pipeline, a stage, an owner, a period, a status, a measure,
      // a meter, a currency, a unit, a ranking cut-off — is parsed here once and
      // has to be bound, refused or explicitly waived before an answer exists.
      const unknownMetric = unknownMeasure(question);
      const asking = intent.intent !== 'act' && intent.intent !== 'draft';
      // A currency word that is also a name in this workspace is a currency
      // only when it is written as one. "Sterling" is Sterling Heat Treating,
      // Sterling Amoretti and Sterling Prendergast here, and "how much pipeline
      // does Sterling own?" traced a GBP scope nobody asked for — harmless only
      // because the owner refused first.
      const currencyWord = currencyMention(question);
      const namedAlso = currencyWord
        ? index.entities.some((e) => [e.label, ...e.aliases].some((name) => normalise(name).split(' ').includes(normalise(currencyWord.matched))))
        : false;
      const currency = currencyWord && (!namedAlso || currencyShaped(question, currencyWord.matched))
        ? currencyWord.code
        : null;
      if (currencyWord && !currency) {
        reasoning.push(`"${currencyWord.matched}" is a ${currencyWord.code.toUpperCase()} word and a name this workspace holds; it is written here as a name, so no currency book was applied.`);
      }
      // "Smallest", "lowest", "closing soonest" — the half of a ranking that
      // decides which end of the book the reader is shown. It used not to exist
      // at all: descending by amount was the only order the planner could emit,
      // so those questions were answered with their own inverse.
      const namedOrder = asking ? rankingOrder(question) : null;
      const qualifiers = asking
        ? parseQualifiers({
            question,
            intent: intent.intent,
            vocabulary,
            entities,
            windows,
            unresolvedPeriods: unresolved,
            metric,
            unknownMetric,
            // A meter in a balance question names the denomination of the pot,
            // not a filter on it: the pot is read from the grant. The `unit`
            // entry carries that denomination and settles against the figure
            // the credit ledger actually returns.
            meter: balanceQuestion ? null : meter,
            currency,
            currencyBooks: currencyBooks(ctx, orgId),
            limit: rankingLimit(question),
            order: namedOrder,
            units: unitsNamed(question, unitVocabulary(ctx, orgId)),
            stages: stageSets(ctx, orgId),
            recordFilters,
            workspaceName: workspace.name,
            carriedQuestion: threadScope,
          })
        : new QualifierLedger();
      if (qualifiers.entries.length) reasoning.push(qualifiers.describe());

      /* 5. can this be answered at all, or must it be refused */
      // The comprehension check reads record names and aliases; a stage label,
      // a pipeline label and anything a qualifier already resolved are names
      // this workspace holds too. Without them "How much is sitting in Proposal
      // sent?" was refused with a sentence denying two words of a stage the
      // same engine lists by name.
      const comprehension = comprehend(question, readableWords(vocabulary, qualifiers, workspaceVocabulary(index), measureWords()));
      // A quantity this workspace has no meter for is a refusal, not a reason
      // to print the meter catalogue: "how many widgets did we meter in August
      // 2026?" came back as six meter definitions with the word "widgets"
      // nowhere in the answer and nothing saying it had not been understood.
      const quantity = asking && !meter ? meteredNoun(question) : null;
      if (quantity && comprehension.unknown.some((word) => normalise(word) === normalise(quantity))) {
        const meters = index.entities.filter((e) => e.type === 'meter').map((e) => e.label);
        qualifiers.add({
          kind: 'meter', text: quantity, resolved: null, state: 'refused', binding: null,
          detail: `Nothing in ${workspace.name} meters ${quantity.toLowerCase()}.${meters.length ? ` The meters this workspace publishes are ${listPhrase(meters.slice(0, 8).map((m) => `"${m}"`))}.` : ''}`,
        });
        reasoning.push(`"${quantity}" is the quantity this question asks to be counted, and no meter here measures it — refused rather than answered with the meter catalogue.`);
      }
      // A value the sentence put in a dimension's slot that this workspace has
      // no option for. "Losing to Siemens" was answered with every deal
      // Northwind ever lost, against a competitor it has never faced.
      const unknownValue = asking ? unknownFilterValue(ctx, orgId, question, namedTypes, recordFilters) : null;
      if (unknownValue) {
        qualifiers.add({
          kind: 'status', text: unknownValue.text, resolved: null, state: 'refused', binding: null,
          noun: unknownValue.noun,
          detail: `${workspace.name} records no ${unknownValue.noun.toLowerCase()} called "${unknownValue.text}" on any deal.`
            + `${unknownValue.known.length ? ` The ones it does record are ${listPhrase(unknownValue.known.map((one) => `"${one}"`))}.` : ''}`,
        });
        reasoning.push(`"${unknownValue.text}" sits where this question names a ${unknownValue.noun.toLowerCase()}, and this workspace holds no such value — refused rather than answered with the unfiltered set.`);
      }
      // A content word adjacent to a bound measure modifies it. One that
      // resolved to nothing is a different measure, not decoration: "flurbo
      // revenue" was answered with revenue, and the word appeared nowhere in
      // the run.
      const modifier = metric && asking ? unknownModifier(question, metric.matched, comprehension.unknown) : null;
      if (modifier) {
        qualifiers.add({
          kind: 'metric', text: modifier, resolved: null, state: 'refused', binding: null,
          detail: `"${modifier}" narrows ${metric!.metric.label} to something this workspace does not hold — it is not a product line, a segment, a book or a pipeline here, and I will not answer the unnarrowed measure under your wording.`,
        });
        reasoning.push(`"${modifier}" sits directly in front of "${metric!.matched}" and resolves to nothing, so it is a refused qualifier rather than a word dropped in silence.`);
      }
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
      // A qualifier that named something this workspace does not have is
      // refused before anything runs. "Pipeline coverage" is not open pipeline
      // and "Technical validation" is not a deal whose name contains the word.
      const parseTimeRefusal = qualifierRefusal(qualifiers.refused(), workspace.name, {
        stages: stageLabels(vocabulary),
        pipelines: vocabulary.pipelines.map((pl) => pl.label),
        metrics: metricIds().map((id) => metricById(id)?.label ?? id),
        owners: workspace.people.map((p) => p.name),
      });
      const qualifierParseRefusal: Refusal | null = parseTimeRefusal
        ? { code: 'qualifier_unbound', why: parseTimeRefusal.why, content: parseTimeRefusal.content }
        : null;
      const refusalOrNull: Refusal | null = danglingReference ?? refusalFor({
        question, workspace, intent, comprehension, metric, entities, types, windows, mentions,
        unresolved, reversedRange: backwards,
        metrics: metricIds().map((id) => metricById(id)?.label ?? id),
        countableTypes,
      }) ?? qualifierParseRefusal;

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
        // "Created last month" and "closing next month" name the same period
        // and two different columns; the noun in the question picks which.
        dateProperty: dateNounIn(question)?.property ?? null,
        order: namedOrder,
        currency,
        qualifiers,
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
      // A step that measures more than the question asked for never leads.
      //
      // "Which open deals are worth over $400,000?" planned `business_metric`
      // for the whole open book *and* `record_search` for the seven rows above
      // the threshold, and the answer opened "Northwind Robotics is carrying
      // $9,010,960 in open pipeline, from 38 open deals" — the reader's own
      // threshold gone from the headline, and a reader stops at the first
      // number. A step that carries strictly fewer of the question's
      // narrowings than another step over the same rows is not a wider
      // context, it is a different question, so it is dropped rather than
      // printed first and qualified afterwards.
      const plan = narrowestSteps(planned.steps);
      if (plan.length !== planned.steps.length) {
        const dropped = planned.steps.filter((step) => !plan.includes(step));
        reasoning.push(`Dropped ${dropped.length} ${dropped.length === 1 ? 'step' : 'steps'} that measure more than the question asked for (${dropped.map((s) => `\`${s.tool}\``).join(', ')}): ${listPhrase(plan.map((s) => `\`${s.tool}\``))} ${plan.length === 1 ? 'carries' : 'carry'} every narrowing this question named, and a wider figure in the first sentence is the answer a reader keeps.`);
      }
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
      /* 6b. settle every qualifier against the plan that is about to run */
      // A snapshot has no reporting period to be measured over, and a count has
      // no currency book. Neither is a dropped qualifier — the measure cannot
      // take it at all — so each is waived by name and the answer says so in
      // its first sentence rather than in a note under the number.
      // …unless the window is a close-date filter over the open book, which
      // `record_aggregate` applies exactly. Waiving it there states something
      // false about what this engine can do.
      // A creation date is as much a filter on the open book as a close date is:
      // "how much pipeline was created in Q2 2026?" is answered by
      // `record_aggregate` on `created`, and waiving it with "a snapshot cannot
      // take a period" stated something false about a query this engine runs.
      const datedColumn = dateNounIn(question)?.property ?? null;
      const closeWindow = !!metric?.metric.snapshot && windows.length > 0
        && (datedColumn === 'close_date' || datedColumn === 'created'
          || outcomeStages(metric?.metric.id ?? null, qualifiers).length > 0);
      if (metric?.metric.snapshot && windows.length && qualifiers.first('period') && !closeWindow) {
        qualifiers.waive('period', `${metric.metric.label} is a snapshot of the book as it stands today, so ${listPhrase(windows.map((w) => w.label))} cannot be applied to it — this is the figure right now, not for that period.`);
      }
      if (metric && metric.metric.unit !== 'money' && qualifiers.first('currency')) {
        qualifiers.waive('currency', `${metric.metric.label} is not a money measure, so restricting it to one currency book would change nothing.`);
      }
      // A comparison measures exactly two periods, and which two is decided
      // before the plan: "the same period last year" is one phrase and one
      // instruction, and the year it names is measured as the shifted quarter
      // rather than on its own. Any further period the question named is
      // waived by name — the answer already says which two it compared.
      const measuredWindows = comparison ? [comparison.a, comparison.b] : windows;
      if (comparison) {
        for (const entry of qualifiers.pending()) {
          if (entry.kind !== 'period') continue;
          if (measuredWindows.some((w) => w.label === entry.resolved?.value)) continue;
          const folded = comparison.source === 'year_over_year';
          qualifiers.mark(entry, folded ? 'bound' : 'waived',
            folded
              ? `"${entry.text}" is the instruction to compare like for like, so it is measured as ${comparison.b.label} rather than as a period of its own.`
              : `A comparison is between two periods; ${comparison.a.label} and ${comparison.b.label} are the two, so "${entry.text}" is not measured here — ask about it on its own.`);
          if (folded) entry.binding = null;
        }
      }
      const planArgs = plan.map((step) => ({ tool: step.tool, args: step.args }));
      qualifiers.settleAgainst(planArgs, measuredWindows);
      // A period nothing in the plan can be told about is waived, with the
      // capability named. Silently listing the whole book under the month's
      // name is the failure this replaces.
      if (plan.length && qualifiers.pending().some((q) => q.kind === 'period')) {
        const blind = plan.filter((step) => {
          const definition = toolIndex.get(step.tool);
          return definition ? !acceptsWindow(definition) : false;
        });
        if (blind.length === plan.length) {
          qualifiers.waive('period', `${listPhrase(blind.map((b) => `\`${b.tool}\``))} ${blind.length === 1 ? 'takes' : 'take'} no reporting period, so this is the position as it stands today rather than a figure for ${listPhrase(windows.map((w) => w.label))}.`);
        }
      }
      // A ranking cut-off nothing in the plan can take is *not* waived.
      //
      // A waiver is honest when the narrowing cannot change the figure — a
      // snapshot has no period, a count has no currency book. A cut-off is not
      // that: "what is the top 3 by open pipeline?" came back with the waiver
      // in front of "$9,010,960 in open pipeline, from 38 open deals", which is
      // the whole book under a question that asked for three rows of it. A
      // reader stops at the first number, and that number was thirty-eight
      // deals wider than the question. It stays pending, and the gate below
      // refuses it by name.

      // Nothing ran, so nothing was substituted. A question with no capability
      // behind it, or one whose capability this run refused to fake, already
      // says so in its own words — a second refusal about a qualifier would be
      // an apology for not narrowing an answer that does not exist.
      if (!plan.length) {
        for (const entry of qualifiers.pending()) {
          qualifiers.mark(entry, 'waived', 'nothing was measured for this question, so nothing was narrowed to it.');
        }
      }

      // A run the caller scoped to a tool list is not a run that dropped the
      // reader's qualifier — the caller removed the capability that would have
      // taken it, and the answer says the run was scoped. Waiving names both.
      if (scopedTools) {
        for (const entry of qualifiers.pending()) {
          qualifiers.mark(entry, 'waived',
            `this run was scoped to ${scopedTools.length ? listPhrase(scopedTools.map((t) => `\`${t}\``)) : 'no tools at all'}, and nothing in that list takes ${entry.kind === 'period' ? 'a reporting period' : `a ${entry.kind}`}.`);
        }
      }

      // Everything still pending is a qualifier the plan quietly dropped, and
      // everything the plan claims to carry is checked against the plan itself.
      const violations = qualifiers.verify(planArgs);
      // Everything except the entries that are settled against the figure
      // rather than against the plan — the entry carries that fact itself, so
      // this gate has no list of exceptions in it.
      const blockingQualifiers = qualifiers.pending().filter((q) => !q.settlesAfterRun);
      // A second pipeline, stage, account or owner the plan could not carry is
      // refused *as a second one*, not as an unreadable word: the reader gets
      // told which of the two names they wrote this run measured.
      for (const entry of blockingQualifiers) {
        if (entry.detail || !entry.resolved) continue;
        // Two entries of one kind are only "two of a kind" when they narrow the
        // same dimension. A deal's outcome and a company's industry are both
        // record filters and both land under `status`; telling the reader their
        // industry crowded out the word "open" names two things that were never
        // in competition.
        const dimension = (q: Qualifier): string =>
          `${q.kind}:${q.resolved?.objectType ?? ''}.${q.resolved?.property ?? ''}`;
        const held = qualifiers.bound().find((other) =>
          dimension(other) === dimension(entry) && other.resolved && other !== entry);
        if (held) entry.detail = crowdedOut(entry, held);
      }
      const unbound = qualifierRefusal(blockingQualifiers, workspace.name, {
        stages: stageLabels(vocabulary),
        pipelines: vocabulary.pipelines.map((pl) => pl.label),
        metrics: metricIds().map((id) => metricById(id)?.label ?? id),
        owners: workspace.people.map((p) => p.name),
      });
      // The entries that caused the refusal are settled as refused, so what the
      // caller reads back has three states and not four. A `pending` entry in a
      // finished run is the state this whole mechanism says cannot exist.
      if (unbound) {
        for (const entry of blockingQualifiers) {
          qualifiers.mark(entry, 'refused', entry.detail
            ?? `Nothing in this plan takes ${/^[aeiou]/i.test(kindNoun(entry.kind)) ? 'an' : 'a'} ${kindNoun(entry.kind)}, so the answer is not narrowed to "${entry.text}".`);
        }
      }
      const violated = violations.filter((violation) => violation.reason !== 'unsettled');
      // A name that binds two kinds at once is not an unproven scope, it is an
      // ambiguous question, and the answer is the question back.
      const ambiguous = violated.filter((violation) => violation.reason === 'type_mismatch');
      const qualifierRefused: Refusal | null = ambiguous.length
        ? {
            code: 'ambiguous_reference',
            why: `One mention binds two kinds: ${ambiguous.map((violation) => `${violation.kind} "${violation.text}"`).join('; ')}.`,
            content: [
              ambiguous.map((violation) => violation.detail).join(' '),
              `I have not picked one for you — a confident answer about the wrong record is worse than a question. Say which you mean.`,
            ].join(' '),
          }
        : violated.length
        ? {
            code: 'qualifier_unbound',
            why: `Qualifier ledger violated: ${violated.map((violation) => `${violation.kind} "${violation.text}" (${violation.reason})`).join('; ')}.`,
            content: [
              `I could not prove that this answer was scoped to ${listPhrase(violated.map((violation) => `the ${violation.kind} "${violation.text}"`))} you named,`,
              `so I have not given you the wider figure with your own words on top of it.`,
              violated.map((violation) => violation.detail).join(' '),
            ].join(' '),
          }
        : unbound
          ? { code: 'qualifier_unbound', why: unbound.why, content: unbound.content }
          : null;
      if (qualifierRefused) {
        reasoning.push(`Refused (qualifier_unbound): ${qualifierRefused.why}`);
        runtime?.note(call, 'plan', 'qualifier_unbound', qualifierRefused.why);
      } else if (qualifiers.entries.length) {
        reasoning.push(`Qualifier ledger settled: ${qualifiers.entries.map((q) => `${q.kind} "${q.text}" ${q.state}${q.binding ? ` → ${q.binding.tool}` : ''}`).join('; ')}.`);
      }
      /* 6c. account for the whole question, not the parts that were recognised */
      // The ledger above is a lexicon: it holds the qualifier kinds somebody
      // enumerated, and a question that narrowed itself on a twenty-sixth kind
      // named nothing it could hold. This gate is the inverse. It walks the
      // question's own tokens and requires each one to be claimed by some part
      // of the plan — the measure, a period, a record, a filter, an object
      // type, a tool argument — or to be closed-class grammar. Everything else
      // is a gap, and a gap is a refusal that names the word.
      // Nothing was planned, so nothing can be substituted: a question with no
      // capability behind it already refuses itself in its own words, and a
      // second refusal about an unread token would be an apology for not
      // narrowing an answer that does not exist.
      const coverage = asking && !refusal && !qualifierRefused && plan.length > 0 && COVERED_INTENTS.has(intent.intent)
        ? auditCoverage({
            question,
            claims: coverageClaims({
              metric, windows, mentions, entities, qualifiers, recordFilters, types,
              meter, currencyWord, order: namedOrder, question,
              usedIds: idsInPlan(plan),
              // A scope applied through a set of associated records reads those
              // records too: "how much open pipeline is with metals and mining
              // accounts?" runs over deals, through the accounts whose industry
              // it is, and the reader's word for them is "accounts".
              queriedTypes: (() => {
                const reached = queriedTypes(plan, groupBy);
                for (const entry of qualifiers.bound()) {
                  const through = entry.binding?.args?.associated_to_any ?? entry.binding?.args?.associated_to;
                  if (through === undefined || !entry.resolved?.objectType) continue;
                  reached.add(entry.resolved.objectType);
                  if (entry.resolved.objectType === 'company') reached.add('customer');
                }
                return reached;
              })(),
              ranking,
              ownerBound: qualifiers.entries.some((q) => q.kind === 'owner')
                || entities.some((e) => e.entity.type === 'user') || groupBy === 'owner',
              dateNoun: dateNounIn(question),
              dimensionAnchors: [...new Set([...types, 'deal', 'company', 'ticket', 'contact']
                .filter((type) => CRM_OBJECT_TYPES.has(type))
                .flatMap((type) => dimensionsOf(ctx, orgId, type, new Set()).flatMap((d) => d.anchors)))],
              // A capability the plan reached brings its whole family with it:
              // `credits.balance` is one verb of the credit ledger, and the
              // ledger's own words for what it holds — grants, burn order,
              // settlement — are published by its siblings. A question that
              // names the ledger in one of those words has named the thing the
              // plan is reading, not a word nobody here uses.
              capabilities: (() => {
                const families = new Set(plan.map((step) => step.tool.split(/[._]/)[0]));
                return available
                  .filter((tool) => plan.some((step) => step.tool === tool.name)
                    || families.has(tool.name.split(/[._]/)[0]))
                  .map((tool) => ({ name: tool.name, description: tool.description }));
              })(),
              // The meters and features these ledgers are denominated in.
              units: plan.some((step) => /credit|entitlement|meter|usage|subscription/.test(step.tool))
                ? index.entities.filter((e) => e.type === 'meter').flatMap((e) => [e.label, ...e.aliases])
                : [],
              plannedArgs: plan.map((step) => ({ tool: step.tool, args: step.args })),
              balance: balanceQuestion,
              usage: types.includes('usage') || !!meter || plan.some((step) => !!step.args.meter),
              roleWords: plan.some((step) => step.tool === 'account_profile' || step.args.object_type === 'contact'
                || step.tool === 'record_timeline')
                ? jobTitleWords(ctx, orgId)
                : [],
              reservedWords: enumeratedWords(ctx, orgId, types),
            }),
            boundNumbers: plan.flatMap((step) => numbersIn(step.args)),
            boundComparison: plan.some((step) => carriesComparison(step.args)),
            objectTypes: types,
            vocabulary: {
              dimensions: [...new Set([...types, ...(types.includes('deal') ? ['company'] : [])])]
                .filter((type) => CRM_OBJECT_TYPES.has(type))
                .flatMap((type) => dimensionsOf(ctx, orgId, type, new Set())
                  .map((d) => ({ objectType: d.objectType, property: d.property, noun: d.noun, options: d.options }))),
              numeric: numericProperties(ctx, orgId, types),
              meters: index.entities.filter((e) => e.type === 'meter').map((e) => e.label),
              metrics: metricIds().map((id) => metricById(id)?.label ?? id),
              people: workspace.people.map((person) => person.name),
            },
            workspaceName: workspace.name,
          })
        : null;
      const uncovered = coverage ? coverageRefusal(coverage, workspace.name) : null;
      if (coverage) {
        reasoning.push(`Token accounting: ${coverage.accounted.length} of ${coverage.tokens.length} content tokens claimed by the plan, ${coverage.ignored.length} closed-class, ${coverage.gaps.length} unaccounted${coverage.gaps.length ? ` (${coverage.gaps.map((g) => `"${g.token}"`).join(', ')})` : ''}.`);
      }
      if (uncovered) {
        reasoning.push(`Refused (question_not_covered): ${uncovered.why}`);
        runtime?.note(call, 'plan', 'question_not_covered', uncovered.why);
      }
      const notCovered: Refusal | null = uncovered
        ? { code: 'qualifier_unbound', why: uncovered.why, content: uncovered.content }
        : null;
      const runnable = qualifierRefused || notCovered ? [] : plan;

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
      let passes = runnable.length ? 1 : 0;

      for (const step of runnable) {
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
      const second = refusal || qualifierRefused || notCovered ? [] : replan(planInput, executed, Math.min(remaining, 2), planned.skipped);
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

      // A unit is settled against the figure rather than against the query: it
      // is bound when the answer actually holds a count in that unit. A credit
      // pot in events reported as "$0.00 available" is not a rounding problem,
      // it is the wrong quantity in the wrong type.
      settleUnitAgainstResults(qualifiers, executed, creditUnitsFor(ctx, orgId, planInput.subjectCustomerIds));
      // A qualifier that was an argument of a step which then errored is not
      // bound: the query never ran. The alternative — which shipped — is a
      // scoped question answered with "nothing I hold answers that", while the
      // capability's own explanation of why sits in the trace where nobody
      // reads it.
      // A capability that returns `{ error }` did not fail the call, but it did
      // not answer either — `business_metric` reports an impossible narrowing
      // that way rather than throwing.
      const refusedByTool = (step: StepResult): string | null => {
        const payload = step.result as { error?: unknown } | null;
        return payload && typeof payload === 'object' && typeof payload.error === 'string' ? payload.error : null;
      };
      const succeeded = steps
        .filter((step) => step.ok && !refusedByTool(step))
        .map((step) => ({ tool: step.tool, args: step.args }));
      const lost: Qualifier[] = [];
      for (const entry of qualifiers.bound()) {
        const binding = entry.binding;
        if (!binding) continue;
        if (succeeded.some((step) => step.tool === binding.tool && stepCarries(step, binding) === null)) continue;
        const failure = steps.find((step) => step.tool === binding.tool && (!step.ok || refusedByTool(step)));
        qualifiers.unbind(entry, (failure ? refusedByTool(failure) ?? failure.error?.message : null)
          ?? `The step that was to carry "${entry.text}" never returned, so nothing was narrowed to it.`);
        lost.push(entry);
      }
      // The post-run gate. Anything still pending here is a qualifier no step
      // and no result settled, and an answer composed over it would be the
      // silent drop this whole mechanism exists to make impossible — so it is
      // refused by name, whatever kind it is.
      const stillPending = qualifiers.pending();
      for (const entry of stillPending) {
        qualifiers.mark(entry, 'refused', entry.kind === 'unit'
          ? `Nothing this run measured is denominated in ${entry.text}s.`
          : `Nothing this run returned carries "${entry.text}", so the answer is not scoped to it.`);
      }
      lost.push(...stillPending);
      const afterRun = lost.length ? qualifierRefusal(lost, workspace.name, {
        stages: stageLabels(vocabulary),
        pipelines: vocabulary.pipelines.map((pl) => pl.label),
        metrics: metricIds().map((id) => metricById(id)?.label ?? id),
        owners: workspace.people.map((p) => p.name),
      }) : null;
      if (afterRun) {
        reasoning.push(`Refused after the run (qualifier_unbound): ${afterRun.why}`);
        runtime?.note(call, 'plan', 'qualifier_unbound', afterRun.why);
      }
      const answerRefusal: Refusal | null = refusal ?? qualifierRefused ?? notCovered
        ?? (afterRun ? { code: 'qualifier_unbound' as const, why: afterRun.why, content: afterRun.content } : null);

      /* 8. draft, extract or answer */
      const tone = detectTone(question);
      const draftKind = !answerRefusal && intent.intent === 'draft' ? detectDraftKind(question) : null;
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

      const synthesis = answerRefusal
        ? { content: answerRefusal.content, citations: [], rendering: [] as ResultOutcome[] }
        : synthesise({
            question, intent, workspace, window, windows, comparison, ranking, subject, entities, steps, metric, draft,
            stages: planInput.stages,
            vocabulary,
            pendingApprovals: (call.pendingApprovals ?? []) as PendingApproval[],
            writeBlocked,
            scopedTools,
            // A tool the second pass managed to arm is not a tool that was skipped.
            skippedTools: skipped.filter((s) => !steps.some((step) => step.tool === s.tool && step.ok)),
            blocked,
            // The scopes a run applied through a set of associated records, so
            // the sentence names them: a figure narrowed to three accounts and
            // read back as though it were the workspace's is the substitution
            // this engine exists to refuse, printed one step later.
            associationScopes: qualifiers.bound()
              .filter((q) => q.resolved?.ids?.length && Array.isArray(q.binding?.args?.associated_to_any))
              .map((q) => ({
                ids: q.resolved!.ids!,
                label: q.resolved!.label,
                noun: q.resolved!.noun ?? kindNoun(q.kind),
                objectType: q.resolved!.objectType ?? 'company',
              })),
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

      // A waived qualifier earns the first sentence, not a footnote. The reader
      // has to know which word of their question this answer does not apply
      // before they read the number, not after they have quoted it.
      const waiver = answerRefusal || !plan.length || blocked.length ? null : waiverSentence(qualifiers);
      // A name matched through a typo is a name the reader did not write. The
      // answer is about the record this workspace holds, and the first sentence
      // says which — a fuzzy hop stated silently is the same substitution as a
      // dropped qualifier, one letter at a time.
      const boundAccount = subject ? entities.find((e) => e.entity.id === subject.id) : undefined;
      const renamed = boundAccount && ['trigram', 'edit_distance'].includes(boundAccount.rule)
        && normalise(boundAccount.mention) !== normalise(boundAccount.entity.label) && !answerRefusal
        ? `You wrote "${boundAccount.mention}"; the closest account this workspace holds is ${boundAccount.entity.label}, and this answer is about ${boundAccount.entity.label}.`
        : null;
      const lead = [renamed, waiver].filter(Boolean).join(' ') || null;
      let content = budgetExhausted
        ? [
            `I ran out of this run's ${budget.timeMs.toLocaleString('en-US')}ms / ${budget.steps}-step budget before ${plan.length === 1 ? 'the planned step' : 'any planned step'} returned, so I have no answer for you rather than a partial one.`,
            `Planned: ${plan.map((s) => s.tool).join(' → ')}. Ask again with a shorter prompt, or raise \`max_steps\`.`,
          ].join(' ')
        : lead ? `${lead}\n\n${synthesis.content}` : synthesis.content;
      if (req.responseSchema) {
        const metricResult = executed.map((e) => e.result).find((r) => !!r && typeof r === 'object' && 'formatted' in (r as object)) as {
          metric?: string; value?: number; formatted?: string; books?: { currency: string }[]; mixedCurrency?: boolean;
          count?: number; matched_records?: number; object_type?: string; source?: string;
        } | undefined;
        // A catalogue measure names the rows it counted in its own `source` —
        // "5 issued invoices" — and carries no object type. Without reading it
        // an `invoice_count` field came back null next to prose that stated the
        // number in words.
        const countedNoun = metricResult?.object_type
          ?? metricResult?.source?.trim().split(/\s+/).pop()?.replace(/s$/, '')
          ?? null;
        // A measure the prose declines to state has no value for a schema field
        // either. `{"win_rate": 0}` came back beside prose saying there is no
        // rate to report — the two halves of the same run contradicting each
        // other, and only the JSON reaches an automation.
        // Every list capability carries its own row count — `billing_list_subscriptions`
        // returns `{ total: 31, subscriptions: [...] }` — and without reading it
        // a run whose prose said "31 subscriptions" filled no count field at all.
        const listed = countedRows(executed);
        const measureUndefined = !!metricResult && metricResult.count === 0
          && metricUndefinedWhenEmpty(metricResult.metric ?? metric?.metric.id ?? null);
        const extraction = extractStructured(normaliseResponseSchema(req.responseSchema), {
          question,
          answer: synthesis.content,
          workspace,
          entities,
          window,
          results: executed,
          metricValue: measureUndefined ? null : metricResult?.value ?? null,
          metricFormatted: measureUndefined ? null : metricResult?.formatted ?? null,
          // A measurement question is about its metric; every other question
          // merely mentions one, and pasting it into that question's `amount`
          // writes the workspace's total onto one record.
          metricIsSubject: !!metric && (intent.intent === 'aggregate' || intent.intent === 'compare'),
          metricCurrencies: (metricResult?.books ?? []).map((b) => b.currency),
          metricId: metric?.metric.id ?? null,
          metricLabel: metric?.metric.label ?? null,
          // The measure's own one-word names, so a schema field spelt the way
          // the catalogue itself writes it is filled from the figure it holds.
          metricWords: metric
            ? [...(metric.metric.phrases ?? []), ...metric.metric.keywords].filter((word) => !word.includes(' '))
            : [],
          // The row count the same aggregate carries, so a `deal_count` field
          // is not null next to an `open_pipeline` it filled.
          rowCount: metricResult?.matched_records ?? metricResult?.count ?? listed?.count ?? null,
          rowType: countedNoun ?? listed?.type ?? null,
          // …and every word this platform calls those rows, so a field named
          // with the reader's own noun for them is filled from the same figure
          // the prose states.
          rowNouns: TYPE_NOUNS[countedNoun ?? listed?.type ?? ''] ?? [],
          metricUnit: metric?.metric.unit ?? null,
          // The words the reader actually wrote, so a field name that adds one
          // of its own — `churned_subscriptions` over a question about active
          // ones — is left null rather than filled with the wrong population.
          askedWords: new Set(normalise(question).split(' ').filter(Boolean).flatMap((word) => [word, stem(word)])),
          owner: qualifiers.label('owner'),
          // Every dimension this run really bound, under the names a schema
          // gives it — so a field named for a scope is filled from the scope
          // and not from whatever number the run also produced.
          scope: scopeFields(qualifiers),
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
        refusal: answerRefusal ? { code: answerRefusal.code, why: answerRefusal.why } : null,
        writeBlocked,
        scopedTools,
        budgetExhausted,
        // A refused period is never "from the question": the caller has to be
        // able to see, in one field, that nothing they named was measured.
        windowFromQuestion: !!explicit && answerRefusal?.code !== 'period_unresolved'
          && !qualifiers.waived().some((q) => q.kind === 'period'),
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
        qualifiers: [...qualifiers.entries] as Qualifier[],
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
