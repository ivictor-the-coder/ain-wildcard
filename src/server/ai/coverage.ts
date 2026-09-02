/**
 * Whether the plan accounts for the *whole* question.
 *
 * Five rounds of this engine tried to stop it answering a different question
 * from the one it was asked, and each round did the same thing: enumerate the
 * qualifiers that were leaking and write a guard for each. A critic then probed
 * it and found thirty-one substitutions still live, with the verdict that "the
 * invariant is a lexicon, not a guarantee". They were right. The set of ways a
 * person can narrow a question is not finite, so a list of the narrowings
 * somebody thought of can only ever move the leak.
 *
 * This file inverts the default. The old rule was *parse what you can, bind
 * what you recognise, compose an answer out of whatever survived*. The rule
 * here is:
 *
 *   > An answer is composed only from a plan in which every meaningful token of
 *   > the question is accounted for. Anything unaccounted for is a refusal that
 *   > names what was not understood.
 *
 * So the walk is over the question's own tokens, not over a catalogue of
 * qualifier kinds. A token is accounted for when some part of the run *claims*
 * it — the metric it matched, an entity's mention, a period, a record filter, a
 * tool argument, an object type — or when it is closed-class grammar: articles,
 * auxiliaries, question words, politeness, and the workspace's own name. There
 * is no third category. A content word that no part of the plan claimed is a
 * gap, whatever kind of thing it happens to name, and a gap is a refusal.
 *
 * That is the whole guarantee, and it is a guarantee rather than a lexicon
 * because the ignorable set is *closed* — English function words do not grow
 * when someone invents a new way to narrow a report. Coverage drops as a
 * result, and that is the trade this file exists to make: on a platform that
 * quotes money, a refusal that names the word it could not read is cheaper than
 * a confident figure answering a question nobody asked.
 *
 * A refusal still has to be useful, so every gap carries the nearest phrasing
 * this workspace *can* answer, built from the workspace's own dimension labels,
 * numeric properties, meters and measures — never a bare "I don't know".
 */
import { COMMON_WORDS, STOPWORDS, normalise, listPhrase, stem, trigramSimilarity } from './text';

/** A span of the question some part of the run consumed, and what consumed it. */
export interface CoverageClaim {
  /** The words, as the run saw them. Matched case- and punctuation-insensitively. */
  text: string;
  /** For the trace: "the metric", "the period Q2 2026", "`record_search`.conditions". */
  by: string;
}

export interface CoverageGap {
  /** The reader's own word, as they wrote it. */
  token: string;
  /** What the run could not do with it. */
  why: string;
  /** The nearest question this workspace can answer, or `null` when there is none. */
  suggestion: string | null;
}

export interface CoverageDimension {
  objectType: string;
  property: string;
  /** What a person calls the dimension — "Category", "Product area". */
  noun: string;
  options: { value: string; label: string }[];
}

export interface CoverageNumeric {
  objectType: string;
  property: string;
  noun: string;
}

export interface CoverageVocabulary {
  dimensions: CoverageDimension[];
  numeric: CoverageNumeric[];
  meters: string[];
  metrics: string[];
}

export interface CoverageInput {
  question: string;
  claims: CoverageClaim[];
  /** Every number that reached a tool argument, in minor units or as written. */
  boundNumbers: number[];
  /** True when some planned argument carries a comparison — `gt`, `lte`, `between`. */
  boundComparison: boolean;
  /** The object types the plan actually queried, for the suggestion's noun. */
  objectTypes: string[];
  vocabulary: CoverageVocabulary;
  workspaceName: string;
}

export interface CoverageReport {
  /** Every content token walked, in order. */
  tokens: string[];
  /** The tokens some part of the run claimed, with the claimant. */
  accounted: { token: string; by: string }[];
  /** The tokens classified as closed-class grammar or the workspace's own name. */
  ignored: string[];
  gaps: CoverageGap[];
}

/* -------------------------------------------------------------------------- */
/*  The closed class                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Function words and question furniture.
 *
 * Deliberately closed-class: determiners, pronouns, auxiliaries, prepositions,
 * conjunctions, question words, degree adverbs and politeness. Nothing in here
 * can narrow a report, which is the only reason it is safe to drop in silence.
 * A domain noun must never be added — "security", "escalated" and "past due"
 * all read as furniture to a careless eye and each of them is a filter.
 */
/**
 * The negations, which are operators rather than furniture.
 *
 * A negation selects rows by their absence, so it narrows a question exactly as
 * a threshold does. Two of them are two characters long and one is a determiner,
 * which is how they were being dropped twice over — once by the furniture list
 * and once by the short-token rule — and "how many companies have never had a
 * deal?" came back as the count of every company in the book.
 */
export const NEGATIONS = new Set<string>([
  'no', 'not', 'never', 'without', 'neither', 'nor', 'except', 'excluding', 'none', 'nothing',
]);

const FURNITURE = new Set<string>([
  ...STOPWORDS,
  // question words and their contractions, already normalised
  'how', 'what', 'whats', 'which', 'who', 'whose', 'whom', 'where', 'when', 'why', 'whether',
  // auxiliaries, modals and copulas
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done', 'doing',
  'has', 'have', 'had', 'having', 'will', 'would', 'shall', 'should', 'can', 'could', 'may',
  'might', 'must', 'got', 'get', 'gets', 'getting',
  // determiners, quantifiers and degree
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'some', 'any', 'all', 'both', 'each',
  // "no" and "none" are determiners and they are also the negation: "companies
  // with no deals" selects rows by their absence. They are claimed by the
  // operator that carries them, like every other negation, and never dropped.
  'every', 'much', 'many', 'more', 'most', 'few', 'fewer', 'less', 'least',
  'very', 'quite', 'really', 'just', 'only', 'even', 'still', 'yet', 'already', 'ever',
  'right', 'now', 'currently', 'exactly', 'roughly', 'about', 'around',
  // pronouns and possessives
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours', 'he', 'him',
  'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them', 'their', 'theirs', 'there', 'here',
  // prepositions and conjunctions
  'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'onto', 'off', 'out',
  'and', 'or', 'but', 'if', 'so', 'as', 'than', 'then', 'because', 'while', 'per', 'via',
  'up', 'down', 'across', 'between', 'against', 'within', 'per',
  // identity and possession: closed class, and never a filter on their own.
  // A possession verb points at an owner slot; the *name* in that slot is what
  // narrows the question, and an unresolvable name is refused on its own.
  'same', 'identical', 'equivalent', 'both', 'either', 'such',
  'own', 'owns', 'owned', 'owning', 'owner', 'owners', 'ownership', 'belongs', 'belonging',
  'assigned', 'assign', 'manages', 'managed', 'managing',
  'carry', 'carries', 'carrying', 'carried', 'hold', 'holds', 'holding', 'held',
  'sit', 'sits', 'sitting', 'sat', 'stand', 'stands', 'standing', 'stood',
  // temporal deixis: which period, never which rows.
  // "past" is not here: "in the past 30 days" is a period, and a period claims
  // it, but "past their close date" is a comparison on a column and dropping it
  // answered a question about four slipped deals with the whole open book.
  'last', 'next', 'previous', 'prior', 'coming', 'upcoming', 'recent', 'recently',
  'current', 'latest', 'today', 'yesterday', 'tomorrow', 'ago', 'since', 'until', 'till',
  'ongoing', 'far', 'date', 'dates', 'time', 'times', 'period', 'periods', 'window',
  // the platform's own word for the whole book, which narrows nothing
  'workspace', 'org', 'overall', 'altogether', 'whole', 'entire', 'full', 'everything',
  // change verbs: they ask for a delta, they do not select rows
  'grow', 'grew', 'grown', 'growing', 'growth', 'add', 'added', 'adding',
  'increase', 'increased', 'decrease', 'decreased', 'change', 'changed', 'changing',
  'rise', 'rose', 'risen', 'fall', 'fell', 'fallen', 'drop', 'dropped', 'improve', 'improved',
  'move', 'moved', 'moving', 'trend', 'trending', 'trended',
  // Negation is NOT here, and the omission is the point. "How many companies
  // have never had a deal?" was answered "Northwind Robotics has 48 companies"
  // — every company in the book — because "never" read as furniture and the
  // rest of the sentence resolved. A negation is an operator: it is accounted
  // for when the plan carries one (`is_not_set`, `not_in`, `neq`) or when the
  // capability that ran publishes itself in those words, and it is a gap
  // otherwise. Only "other", which selects nothing on its own, stays.
  'other',
  // comparison and framing verbs that set up a question rather than narrow it
  'compare', 'compared', 'comparing', 'comparison', 'versus', 'vs', 'against',
  'break', 'broken', 'split', 'splits', 'grouped', 'group', 'bucketed', 'segmented', 'sliced',
  'looking', 'looks', 'doing', 'going', 'stand', 'stands', 'standing', 'sitting', 'sits',
  // politeness and framing verbs that ask for the answer rather than narrow it
  'please', 'thanks', 'thank', 'hi', 'hey', 'hello', 'ok', 'okay', 'sorry',
  'show', 'tell', 'give', 'list', 'find', 'look', 'lookup', 'pull', 'fetch', 'bring', 'see',
  'want', 'need', 'know', 'let', 'make', 'take', 'go', 'going', 'like', 'say', 'said',
  // the copular verbs of possession a business question is built from
  'there', 'thereare', 'hold', 'holds', 'holding', 'sitting', 'sits', 'sat', 'stand', 'stands',
  'currently', 'total', 'totals', 'totalling',
]);

/** Comparison words. Each has to reach an operator or it is a gap. */
// A comparator is only a comparator when it has something to compare to: a
// number or a money amount within a couple of words. "over the last six
// months" is temporal, and reading it as a threshold refused a question whose
// answer this engine computes exactly.
const COMPARATOR =
  /\b(over|above|more\s+than|greater\s+than|larger\s+than|bigger\s+than|at\s+least|no\s+less\s+than|under|below|less\s+than|fewer\s+than|smaller\s+than|at\s+most|no\s+more\s+than|exceeding|north\s+of|upwards\s+of|between)\s+(?:[a-z]+\s+){0,2}(?=[$€£¥]|\d)/gi;

/** A number the reader wrote, with the currency symbol and magnitude on it. */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, ninety: 90, hundred: 100,
};

/**
 * A quantity as the reader wrote it, with its currency symbol, its magnitude
 * and the unit noun that follows it. "$400,000", "50 million telemetry events"
 * and "six months" are each one quantity; the unit is part of it, so a bound
 * number spends the word beside it rather than leaving it as a gap.
 */
const UNIT_NOUN = 'days?|weeks?|months?|quarters?|years?|hours?|minutes?|seats?|events?|gb|tb|mb|robots?|assets?|alerts?|units?|records?|rows?|deals?|tickets?|invoices?|accounts?|customers?|contacts?|companies|percent|%';
const QUANTITY = new RegExp(
  `(?:[$€£¥]\\s?)?\\b(?:\\d[\\d,]*(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`
  + `(?:\\s?(?:k|m|bn?|thousand|million|billion))?(?:\\s+(?:${UNIT_NOUN}))?\\b%?`, 'gi');

const MAGNITUDE: Record<string, number> = {
  k: 1_000, thousand: 1_000, m: 1_000_000, million: 1_000_000, b: 1_000_000_000,
  bn: 1_000_000_000, billion: 1_000_000_000,
};

/** Every value one written quantity could mean — as written, and in minor units. */
export function quantityValues(written: string): number[] {
  const match = new RegExp(
    `^(?:[$€£¥]\\s?)?([\\d,]*\\d(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`
    + `\\s?(k|m|bn?|thousand|million|billion)?(?:\\s+(?:${UNIT_NOUN}))?%?$`, 'i').exec(written.trim());
  if (!match) return [];
  const word = NUMBER_WORDS[match[1].toLowerCase()];
  const base = word ?? Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return [];
  const scaled = base * (match[2] ? MAGNITUDE[match[2].toLowerCase()] ?? 1 : 1);
  return [...new Set([scaled, scaled * 100, scaled / 100, base, base * 100])];
}

/* -------------------------------------------------------------------------- */
/*  The walk                                                                  */
/* -------------------------------------------------------------------------- */

const tokensOf = (text: string): string[] => normalise(text).split(' ').filter(Boolean);

/**
 * Mark every position of the question that a claim covers.
 *
 * A claim is matched as a contiguous run of tokens, and a single-token claim is
 * matched everywhere it occurs — "Q2 2026" claims both its words, and the
 * metric's own span claims every word of it. Stems are compared so a claim on
 * "Dashboards" covers the reader's "dashboard".
 */
/**
 * Whether a word of the question and a word of a claim are the same word.
 *
 * Equality, then stems, then a five-character shared prefix — which is what
 * makes "subscribed" the same word as "subscriptions" and "raise" the same word
 * as "raised". Five is deliberate: four would make "bill" claim "billing", and
 * a revenue measure quietly spending the word "billing" is how a question about
 * billing *tickets* was answered with collected revenue.
 */
function sameWord(token: string, wanted: string, tokenStem: string, wantedStem: string): boolean {
  if (token === wanted || tokenStem === wantedStem) return true;
  if (token.length < 5 || wanted.length < 5) return false;
  let shared = 0;
  while (shared < token.length && shared < wanted.length && token[shared] === wanted[shared]) shared += 1;
  return shared >= 5;
}

function markClaims(tokens: string[], claims: CoverageClaim[]): (string | null)[] {
  const by: (string | null)[] = tokens.map(() => null);
  // Two stemming passes, because one leaves "subscriptions" as "subscription"
  // and the reader wrote "subscribed"; "raised" and "raise" part the same way.
  // A claim is about a word, not about an inflection of it.
  const root = (word: string): string => stem(stem(word));
  const stems = tokens.map(root);
  for (const claim of claims) {
    const wanted = tokensOf(claim.text);
    if (!wanted.length) continue;
    const wantedStems = wanted.map(root);
    for (let at = 0; at + wanted.length <= tokens.length; at += 1) {
      let hit = true;
      for (let k = 0; k < wanted.length && hit; k += 1) {
        hit = sameWord(tokens[at + k], wanted[k], stems[at + k], wantedStems[k]);
      }
      if (!hit) continue;
      for (let k = 0; k < wanted.length; k += 1) if (!by[at + k]) by[at + k] = claim.by;
    }
    // A claim also spends its words one at a time, wherever they appear. "How
    // many anomaly alerts did Meridian raise last month?" is measured on the
    // meter *called* "Anomaly alerts raised", and the reader's "raise" is that
    // meter's own word even though the three words are not adjacent here. This
    // is safe because a claim only exists once the run used the thing that
    // makes it: a record the plan never queried claims nothing at all.
    for (let k = 0; k < wanted.length; k += 1) {
      for (let at = 0; at < tokens.length; at += 1) {
        if (!by[at] && sameWord(tokens[at], wanted[k], stems[at], wantedStems[k])) by[at] = claim.by;
      }
    }
  }
  return by;
}

/** The nearest phrasing this workspace can answer for a word it could not read. */
function suggestFor(token: string, input: CoverageInput): { why: string; suggestion: string | null } {
  const target = normalise(token);
  const near = (candidate: string): number => {
    const value = normalise(candidate);
    if (!value) return 0;
    if (value === target) return 1;
    if (value.split(' ').includes(target)) return 0.95;
    return trigramSimilarity(value, target);
  };

  // A value of one of this workspace's own enumerations, written without the
  // dimension beside it. "Security" is a ticket category here; on its own it is
  // also an English word, so the engine will not read it as the filter — but it
  // can say exactly how to write it so that it does.
  let best: { score: number; dimension: CoverageDimension; label: string } | null = null;
  for (const dimension of input.vocabulary.dimensions) {
    for (const option of dimension.options) {
      const score = Math.max(near(option.label), near(option.value.replace(/_/g, ' ')));
      if (score >= 0.6 && (!best || score > best.score)) best = { score, dimension, label: option.label };
    }
  }
  if (best) {
    const noun = plural(best.dimension.objectType);
    return {
      why: `"${token}" is a ${best.dimension.noun.toLowerCase()} of a ${best.dimension.objectType} here, but on its own it is an English word too, so I will not read it as a filter and then quote you a number as though I had.`,
      suggestion: `ask for "${noun} in the ${best.label} ${best.dimension.noun.toLowerCase()}" and I will filter on it exactly`,
    };
  }

  const meter = input.vocabulary.meters.map((name) => ({ name, score: near(name) }))
    .sort((a, b) => b.score - a.score)[0];
  if (meter && meter.score >= 0.55) {
    return {
      why: `"${token}" reads like metered usage, and no meter in ${input.workspaceName} answered to it in this question.`,
      suggestion: `ask for "${meter.name}" by name — that is the meter this workspace publishes closest to it`,
    };
  }

  const measure = input.vocabulary.metrics.map((name) => ({ name, score: near(name) }))
    .sort((a, b) => b.score - a.score)[0];
  if (measure && measure.score >= 0.6) {
    return {
      why: `"${token}" did not resolve to a measure this workspace computes.`,
      suggestion: `ask for "${measure.name}" — the closest measure I hold`,
    };
  }

  return {
    why: `"${token}" is not a record, a measure, a period, a meter or any value this workspace enumerates, and nothing in the plan I built takes it.`,
    suggestion: null,
  };
}

const plural = (objectType: string): string =>
  objectType.endsWith('y') ? `${objectType.slice(0, -1)}ies` : `${objectType}s`;

/**
 * Walk the question and report every token the plan did not account for.
 */
/**
 * The interrogative clause of a prompt.
 *
 * A prompt is not always a question: an operator pastes four thousand
 * characters of telemetry under "how did bookings do last quarter?", and the
 * asset ids in that paste are not qualifiers anybody wrote. The accounting is
 * over the question, so the question is where it ends — at the question mark,
 * or at the end of the first sentence of a long paste.
 */
export function interrogative(prompt: string): string {
  const mark = prompt.indexOf('?');
  if (mark > 0) return prompt.slice(0, mark + 1);
  if (prompt.length <= 240) return prompt;
  const stop = prompt.search(/[.;\n]/);
  return stop > 0 ? prompt.slice(0, stop + 1) : prompt.slice(0, 240);
}

export function auditCoverage(input: CoverageInput): CoverageReport {
  const asked = interrogative(input.question);
  const tokens = tokensOf(asked);
  const workspaceWords = new Set(tokensOf(input.workspaceName));
  const by = markClaims(tokens, input.claims);

  const accounted: { token: string; by: string }[] = [];
  const ignored: string[] = [];
  const gaps: CoverageGap[] = [];
  const seen = new Set<string>();

  /* Numbers and comparators are walked over the raw text, because "$400,000"
     and "more than" are one token to a reader and several to a tokeniser. */
  const bound = new Set(input.boundNumbers);
  /** Every word a written quantity spends, so the token walk does not see it twice. */
  const numericClaimed = new Set<string>();
  // A number is only a filter when the sentence marks it as one: a currency
  // symbol, a magnitude, a unit noun, or a comparator in front of it. A bare
  // numeral in prose — a serial number in a pasted note, a year inside a name —
  // narrows nothing, and refusing a four-thousand-character prompt for the
  // digits inside it is its own wrong answer.
  const marked = (written: string, at: number): boolean =>
    /[$€£¥%]/.test(written)
    || new RegExp(`\\s(?:k|m|bn?|thousand|million|billion|${UNIT_NOUN})\\b`, 'i').test(written)
    || /\b(over|above|under|below|more\s+than|less\s+than|fewer\s+than|greater\s+than|at\s+least|at\s+most|exceeding|between|top|largest|smallest|biggest|first|last|up\s+to)\s*$/i
      .test(asked.slice(Math.max(0, at - 24), at));

  for (const match of asked.matchAll(QUANTITY)) {
    const written = match[0].trim();
    if (!written) continue;
    const spelled = tokensOf(written);
    const values = quantityValues(written);
    if (!values.length) continue;
    // The number reached an argument, so every word of the quantity is spent —
    // "the three smallest of those" becomes `limit: 3`, and "three" is that.
    if (values.some((value) => bound.has(value))) {
      for (const token of spelled) numericClaimed.add(token);
      accounted.push({ token: written, by: 'a tool argument' });
      continue;
    }
    // A period already claimed these digits: "Q2 2026" is not a threshold.
    const digits = spelled.filter((token) => /\d/.test(token) || token.toLowerCase() in NUMBER_WORDS);
    if (digits.length && digits.every((digit) => by[tokens.indexOf(digit)] !== null)) {
      for (const token of spelled) numericClaimed.add(token);
      continue;
    }
    if (!marked(written, match.index ?? 0)) continue;
    if (seen.has(normalise(written))) { for (const token of spelled) numericClaimed.add(token); continue; }
    seen.add(normalise(written));
    const numeric = input.vocabulary.numeric.find((n) => input.objectTypes.includes(n.objectType))
      ?? input.vocabulary.numeric[0] ?? null;
    gaps.push({
      token: written,
      why: `"${written}" is a threshold, and no step in the plan I built carries it — the figure I would print is over every row, not over the rows above it.`,
      suggestion: numeric
        ? `ask for "${plural(numeric.objectType)} with ${numeric.noun.toLowerCase()} over ${Math.round(values[0] ?? 0)}" and I will filter on it exactly`
        : null,
    });
    for (const token of spelled) numericClaimed.add(token);
  }

  const comparators = [...asked.matchAll(COMPARATOR)]
    // "between 2026-01-01 and 2026-03-31" compares two dates, and the period
    // claim already spends them. A comparator whose operand the run bound is a
    // comparator the run read.
    .filter((match) => {
      const after = asked.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 32);
      const operand = /^[$€£¥]?\s?([\d,]*\d(?:\.\d+)?)/.exec(after);
      if (!operand) return true;
      return !quantityValues(operand[0]).some((value) => bound.has(value))
        && !tokensOf(operand[0]).every((token) => numericClaimed.has(token));
    })
    .map((match) => match[0].trim());
  if (comparators.length && !input.boundComparison && !gaps.length) {
    const numeric = input.vocabulary.numeric.find((n) => input.objectTypes.includes(n.objectType)) ?? null;
    gaps.push({
      token: comparators[0],
      why: `"${comparators[0]}" compares against something, and nothing in this plan carries a comparison — the answer would be the unfiltered set with your wording on top of it.`,
      suggestion: numeric
        ? `ask for "${plural(numeric.objectType)} with ${numeric.noun.toLowerCase()} over <number>"`
        : null,
    });
  }
  for (const comparator of comparators) for (const word of tokensOf(comparator)) numericClaimed.add(word);

  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (by[at]) { accounted.push({ token, by: by[at]! }); continue; }
    if (/^\d/.test(token) || numericClaimed.has(token)) { ignored.push(token); continue; }

    // A negation is never furniture and never too short to matter: "no" is two
    // characters and it is the whole of the filter in "companies with no deals".
    if ((FURNITURE.has(token) || token.length <= 2) && !NEGATIONS.has(token)) { ignored.push(token); continue; }
    if (workspaceWords.has(token)) { ignored.push(token); continue; }
    if (seen.has(token)) continue;
    seen.add(token);
    const { why, suggestion } = suggestFor(token, input);
    gaps.push({ token, why, suggestion });
  }

  return { tokens, accounted, ignored, gaps };
}

/**
 * The refusal a coverage gap earns.
 *
 * It names the token, says what could not be done with it, and offers the
 * nearest phrasing this workspace can answer. A bare "I don't know" is a bad
 * refusal — the reader has to leave with a question they can ask instead.
 */
export function coverageRefusal(report: CoverageReport, workspaceName: string): { why: string; content: string } | null {
  if (!report.gaps.length) return null;
  const named = report.gaps.slice(0, 3);
  const bound = report.accounted.filter((a) => a.by !== 'grammar');
  const parts: string[] = [];
  parts.push(named.length === 1
    ? `I did not understand ${quote(named[0].token)} in that question.`
    : `I did not understand ${listPhrase(named.map((gap) => quote(gap.token)))} in that question.`);
  for (const gap of named) parts.push(gap.why);
  const offers = named.map((gap) => gap.suggestion).filter((s): s is string => !!s);
  if (offers.length) parts.push(`You can ${listPhrase(offers, 'or')}.`);
  parts.push(bound.length
    ? `I read the rest of it — ${listPhrase([...new Set(bound.map((a) => a.by))].slice(0, 4))} — but I will not answer a question with a word missing out of it and call the wider figure your answer.`
    : `I have not answered a wider question instead: ${workspaceName}'s total is a precise answer to a question you did not ask.`);
  return {
    why: `${report.gaps.length} ${report.gaps.length === 1 ? 'token' : 'tokens'} unaccounted for: ${report.gaps.map((gap) => `"${gap.token}"`).join(', ')}.`,
    content: parts.join(' '),
  };
}

const quote = (text: string): string => `"${text}"`;

/** Every number reachable in a planned step's arguments, at any depth. */
export function numbersIn(value: unknown, depth = 0): number[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (typeof value === 'number') return Number.isFinite(value) ? [value] : [];
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, ''));
    return Number.isFinite(parsed) && value.trim() !== '' ? [parsed] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => numbersIn(item, depth + 1));
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap((item) => numbersIn(item, depth + 1));
  return [];
}

/** Whether any planned argument carries a comparison operator. */
export function carriesComparison(args: unknown, depth = 0): boolean {
  if (depth > 6 || !args || typeof args !== 'object') return false;
  if (Array.isArray(args)) return args.some((item) => carriesComparison(item, depth + 1));
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if ((key === 'op' || key === 'operator') && typeof value === 'string'
      && ['gt', 'gte', 'lt', 'lte', 'between', '>', '>=', '<', '<='].includes(value)) return true;
    if (/^(min|max)(_|$)/.test(key) && value !== null && value !== undefined) return true;
    if (carriesComparison(value, depth + 1)) return true;
  }
  return false;
}

export { COMMON_WORDS };
