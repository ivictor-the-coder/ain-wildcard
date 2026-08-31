/**
 * When the engine should refuse.
 *
 * A copilot that always answers is worse than one that sometimes says "I can't
 * compute that". The failure mode this file exists to stop is *substitution*:
 * answering a nearby question — last quarter's bookings — because the question
 * actually asked could not be resolved. Every refusal here names what did
 * resolve, what did not, and what the caller can ask instead, and it happens
 * before a single tool runs so nothing is spent guessing.
 */
import type { WorkspaceProfile } from './grounding';
import type { EntityIndex } from './grounding';
import type { IntentResult } from './intent';
import type { MetricDetection } from './metrics';
import type { ResolvedEntity, MatchRule } from './resolve';
import type { PeriodMention, TimeWindow } from './dates';
import { COMMON_WORDS, contentWords, listPhrase, normalise, truncate } from './text';


const STRONG_RULES = new Set<MatchRule>([
  'id', 'alias_exact', 'name_exact', 'core_exact', 'prefix', 'acronym', 'token_subset',
]);

/** An entity confident enough to build an answer on, not just to offer. */
export const isUsableEntity = (entity: ResolvedEntity): boolean =>
  entity.score >= 0.62 && (STRONG_RULES.has(entity.rule) || entity.score >= 0.86);

const vocabularyCache = new WeakMap<EntityIndex, Set<string>>();

/** Everything this workspace calls things: record names, aliases and owners. */
export function workspaceVocabulary(index: EntityIndex): Set<string> {
  const cached = vocabularyCache.get(index);
  if (cached) return cached;
  const out = new Set<string>();
  for (const entity of index.entities) {
    for (const token of normalise(entity.label).split(' ')) if (token.length > 1) out.add(token);
    for (const alias of entity.aliases) {
      for (const token of normalise(alias).split(' ')) if (token.length > 1) out.add(token);
    }
  }
  vocabularyCache.set(index, out);
  return out;
}

export interface Comprehension {
  words: string[];
  known: string[];
  unknown: string[];
  /** Share of content words this workspace has any grounding for, 0–1. */
  ratio: number;
  injection: boolean;
  businessHealth: boolean;
}

/** A question about the business as a whole, which the briefing answers well. */
const BUSINESS_HEALTH =
  /\b(state\s+of\s+(?:the\s+)?(?:business|play|things|the\s+quarter)|how\s+(?:are|is)\s+(?:we|things|business|it|the\s+business|the\s+quarter)\s+(?:doing|going|looking|tracking|shaping)|how'?s\s+(?:business|it\s+going|the\s+quarter)|how\s+did\s+we\s+do|where\s+do\s+we\s+stand|give\s+me\s+(?:the|a)\s+(?:rundown|picture|overview|summary|numbers|update|headlines)|catch\s+me\s+up|brief\s+me|what'?s\s+(?:going\s+on|happening|new)|business\s+(?:overview|health|update)|what\s+should\s+(?:i|we)\s+(?:do|focus|know|worry))\b/i;

/** Text shaped like an injection attempt rather than a question. */
const INJECTION =
  /(\b(?:drop|truncate)\s+table\b|\bdelete\s+from\b|\bunion\s+(?:all\s+)?select\b|\binsert\s+into\b|\bupdate\s+\w+\s+set\b|--\s*$|;\s*--|<\s*script\b|\$\{.*\}|\{\{.*\}\})/i;

export function comprehend(question: string, vocabulary: Set<string>): Comprehension {
  const words = contentWords(question).filter((w) => !/^\d+$/.test(w));
  const known: string[] = [];
  const unknown: string[] = [];
  for (const word of words) {
    if (COMMON_WORDS.has(word) || vocabulary.has(word) || word.length <= 2) known.push(word);
    else unknown.push(word);
  }
  return {
    words,
    known,
    unknown,
    ratio: words.length ? known.length / words.length : 0,
    injection: INJECTION.test(question),
    businessHealth: BUSINESS_HEALTH.test(question),
  };
}

export type RefusalCode = 'unreadable' | 'injection' | 'unknown_terms' | 'no_measure' | 'period_unresolved';

export interface Refusal {
  code: RefusalCode;
  /** The answer the caller sees instead of a guess. */
  content: string;
  /** One line for the trace and the run record. */
  why: string;
}

export interface RefusalInput {
  question: string;
  workspace: WorkspaceProfile;
  intent: IntentResult;
  comprehension: Comprehension;
  metric: MetricDetection | null;
  entities: ResolvedEntity[];
  types: string[];
  windows: TimeWindow[];
  mentions: PeriodMention[];
  /** Period phrases no resolved window covers — the substitution guard. */
  unresolved: PeriodMention[];
  /** Set when the question wrote an explicit range back to front. */
  reversedRange: { from: string; to: string } | null;
  /** Labels of the metrics this workspace can actually compute. */
  metrics: string[];
  /** Object types that can be counted or listed. */
  countableTypes: string[];
}

const quoteList = (values: string[]): string => listPhrase(values.map((v) => `"${v}"`));

const examples = (workspace: WorkspaceProfile): string => [
  `"how much did we book in Q2 2026?"`,
  `"compare Q1 2026 and Q2 2026 bookings"`,
  `"where does <account> stand?"`,
].join(', ').replace('<account>', workspace.name === 'Northwind Robotics' ? 'Rheinwerk Antriebstechnik' : 'an account');

const metricMenu = (metrics: string[], limit = 8): string =>
  `${metrics.slice(0, limit).map((m) => m.toLowerCase()).join(', ')}${metrics.length > limit ? ` and ${metrics.length - limit} more` : ''}`;

/**
 * Decide whether this question can be answered at all. Returns `null` when the
 * engine has enough to work with — the common case — and a refusal when
 * answering would mean quietly measuring something else.
 */
export function refusalFor(input: RefusalInput): Refusal | null {
  const { comprehension: read, workspace, intent } = input;
  const usable = input.entities.filter(isUsableEntity);
  const anchored = !!input.metric || usable.length > 0 || input.types.length > 0;

  if (read.injection) {
    return {
      code: 'injection',
      why: 'The prompt is shaped like an injection payload, not a question; nothing was executed.',
      content: [
        `That reads as a database fragment rather than a question, so I ran nothing against ${workspace.name}.`,
        `Every answer here comes from parameterised reads of the workspace — there is no path from a prompt to raw SQL.`,
        `Ask me something like ${examples(workspace)}.`,
      ].join(' '),
    };
  }

  if (!read.words.length) {
    return {
      code: 'unreadable',
      why: 'The question carries no content words to resolve.',
      content: [
        `There is nothing in that I can resolve to a record, a metric or a period.`,
        `Try ${examples(workspace)}.`,
      ].join(' '),
    };
  }

  if (!anchored && read.ratio < 0.5) {
    return {
      code: 'unreadable',
      why: `${read.unknown.length}/${read.words.length} words match nothing in the workspace vocabulary.`,
      content: [
        `I could not read that as a question about ${workspace.name}: ${quoteList(read.unknown.slice(0, 4))} ${read.unknown.length === 1 ? 'matches' : 'match'} no record, metric, property or period I hold.`,
        `I can compute ${metricMenu(input.metrics, 6)}, list any object type, and pull the profile of any account.`,
        `Try ${examples(workspace)}.`,
      ].join(' '),
    };
  }

  // The substitution guard, and it is not a comparison rule.
  //
  // Any question that names a period the parser cannot turn into a range is
  // refused, whatever its intent: answering "How much did we book in H1 2026?"
  // about the current quarter is the same failure as answering a two-period
  // comparison on one period, and it is worse, because a single figure with no
  // caveat reads as authoritative and gets quoted. Nothing is measured; the
  // phrase that did not parse is named back to the caller.
  if (input.unresolved.length) {
    const named = input.mentions.map((m) => m.text);
    const missed = input.unresolved.map((m) => m.text);
    const resolved = input.windows.map((w) => w.label);
    const comparison = intent.intent === 'compare' && named.length >= 2;
    const vocabulary =
      `I understand quarters ("Q1 2026"), months ("March 2025"), years ("2025"), relative periods ("last quarter", "the last 30 days") and explicit ranges ("between 2026-01-01 and 2026-03-31").`;
    const backwards = input.reversedRange
      ? `The range "${input.reversedRange.from} to ${input.reversedRange.to}" runs backwards — it ends before it starts.`
      : '';
    return {
      code: 'period_unresolved',
      why: `The question named ${named.length} ${named.length === 1 ? 'period' : 'periods'} (${named.join(', ')}) and ${resolved.length === 0 ? 'none' : `only ${resolved.length}`} resolved: ${missed.join(', ')} did not parse.`,
      content: comparison
        ? [
            `You asked me to compare ${quoteList(named.slice(0, 3))}, and I could only resolve ${resolved.length ? quoteList(resolved) : 'none of them'} to a date range.`,
            backwards,
            `I will not answer on one period and present it as a comparison.`,
            vocabulary,
          ].filter(Boolean).join(' ')
        : [
            `You named ${quoteList(missed.slice(0, 3))}, which I could not resolve to ${missed.length === 1 ? 'a date range' : 'date ranges'}.`,
            backwards,
            resolved.length
              ? `I did resolve ${quoteList(resolved)}, but I will not measure a period you did not ask for and report it as the answer, so I have run nothing.`
              : `I have not measured anything on a default period instead — a number about the wrong quarter is worse than no number.`,
            vocabulary,
          ].filter(Boolean).join(' '),
    };
  }

  const wantsNumber = intent.intent === 'aggregate' || intent.intent === 'compare';
  if (wantsNumber && !input.metric && !usable.length && !input.countableTypes.length) {
    const unknown = read.unknown.length ? ` I do not hold anything called ${quoteList(read.unknown.slice(0, 3))}.` : '';
    return {
      code: 'no_measure',
      why: `No metric matched "${truncate(input.question, 60)}" and no object type was named.`,
      content: [
        `I could not tell which measure you want, so I have not guessed one.${unknown}`,
        `I can compute ${metricMenu(input.metrics)} — over any period, for the workspace or for one account.`,
        `Name one of those (or an object type such as deals, tickets or companies) and I will run it.`,
      ].join(' '),
    };
  }

  if (!anchored && intent.confidence <= 0.31 && !read.businessHealth) {
    return {
      code: 'unknown_terms',
      why: 'No intent signal fired and nothing in the question resolved to a record, metric or object type.',
      content: [
        read.unknown.length
          ? `Nothing in that resolved: ${quoteList(read.unknown.slice(0, 3))} ${read.unknown.length === 1 ? 'is' : 'are'} not a record, a metric or an object type in ${workspace.name}.`
          : `I could not tell what you are asking about ${workspace.name} — the question names no record, metric, object type or period.`,
        `I can compute ${metricMenu(input.metrics, 6)}, summarise any account, or list deals, tickets, companies and contacts.`,
        `Try ${examples(workspace)}.`,
      ].join(' '),
    };
  }

  return null;
}
