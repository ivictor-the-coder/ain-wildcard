/**
 * What an answer was actually measured over, and whether that is what was asked.
 *
 * The engine parses a qualifier out of a question — a pipeline, a stage, an
 * owner, a period, a status — and when it cannot bind that qualifier to the
 * query it is about to run it has, repeatedly, run the unqualified query and
 * stated the result as the answer. "What is the Renewal pipeline worth?"
 * answered with the $9,010,960 workspace total for a $1,463,440 pipeline;
 * "How many deals are in Negotiation?" answered with the open-deal count.
 *
 * The client cannot make the engine bind the qualifier. It can refuse to let an
 * unscoped answer be read as a scoped one, and that is what this file is: the
 * scope the query actually used, read off the arguments the engine passed, and
 * checked against the qualifiers the question named in this workspace's own
 * vocabulary. Nothing here guesses at a number; it only compares things the
 * engine already published — the tool call it made, the figure that call
 * returned, its own qualifier ledger, and the question it was all for.
 *
 * The engine's ledger is read but not trusted: `bound → business_metric` is
 * accepted only when that call's arguments really carry the value, because
 * "I bound it" over a query with no such filter is the defect, not the fix.
 *
 * No React and no fetch, so every rule below is testable on its own.
 */

/* ------------------------------- vocabulary ------------------------------- */

export interface VocabStage { pipeline: string; pipelineLabel: string; name: string; label: string; isClosed: boolean; isWon: boolean }
export interface VocabPipeline { name: string; label: string; stages: VocabStage[] }
export interface VocabPerson { id: string; name: string }
/** One row of `GET /v1/ai/metrics` — the platform's own metric catalogue. */
export interface VocabMetric { id: string; label: string; unit: string; keywords: string[]; snapshot: boolean }

/** A pipeline that holds records other than deals — the ticket process, say. */
export interface VocabOtherPipeline { name: string; label: string; objectType: string }

/**
 * One value of one enumerated CRM property, as this workspace spells it.
 *
 * `lead_source = trade_show`, labelled "Trade show" under "Original source".
 * These are the dimensions the qualifier vocabulary did not have: "How many
 * open deals came from a trade show?" was answered "38 open deals" — 5.4× the
 * true 7 — with no chip, no banner and nothing anywhere on the card naming the
 * words "trade show", because a question could name a record property and the
 * ledger had no slot to refuse it in.
 */
export interface VocabPropertyValue {
  /** The property's machine name — `lead_source`. */
  property: string;
  /** What the CRM calls that property — "Original source". */
  propertyLabel: string;
  /** The option's machine value — `trade_show`. */
  value: string;
  /** The option's label — "Trade show". */
  label: string;
}

/** One enumerated property as `GET /v1/objects/:type/properties` returns it. */
export interface VocabPropertyDef {
  name: string;
  label: string;
  options: { value: string; label: string }[];
}

/** The workspace's own names for the things a question can narrow to. */
export interface Vocabulary {
  pipelines: VocabPipeline[];
  people: VocabPerson[];
  metrics: VocabMetric[];
  /**
   * The pipelines this engine does not measure over.
   *
   * `crm_pipelines` holds a `support` pipeline of 35 tickets, and "How many
   * tickets are in the Support pipeline?" is answered "No deal pipeline in this
   * workspace is called 'Support'… The pipelines Northwind Robotics has are
   * 'New business', 'Expansion' and 'Renewal'." Every clause of that is
   * literally true and the paragraph is false: this workspace has a Support
   * pipeline, and the reader has just been told it does not.
   */
  otherPipelines?: VocabOtherPipeline[];
  /**
   * The enumerated record properties a question can narrow on.
   *
   * Built by `propertyVocabulary` from the CRM's own `crm_properties`, so the
   * words this surface will hold an answer to are the workspace's own words
   * and not a list somebody typed here.
   */
  properties?: VocabPropertyValue[];
}

export const EMPTY_VOCABULARY: Vocabulary = { pipelines: [], people: [], metrics: [], otherPipelines: [], properties: [] };

/**
 * `technical_validation` → `Technical validation`.
 *
 * The same rule as the design system's `humanize`, restated here rather than
 * imported: that module pulls in React and the session, and this one has to
 * stay loadable in a plain node test.
 */
export const humanizeName = (input: string): string => {
  const s = input.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
};

const norm = (value: string): string => value.replace(/[_\-&]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

export const openStagesOf = (vocab: Vocabulary, pipeline?: string | null): VocabStage[] =>
  vocab.pipelines
    .filter((p) => !pipeline || p.name === pipeline)
    .flatMap((p) => p.stages.filter((s) => !s.isClosed));

/* ------------------------------ the tool call ----------------------------- */

export interface ToolCallLike { name: string; arguments: Record<string, unknown> }

/**
 * Every dimension an answer can be narrowed on, and therefore every dimension
 * this file must be able to contradict.
 *
 * The list is the contract: a kind the scope bar is willing to draw a chip for
 * has to be a kind the reconciliation can call wrong. `currency` was drawn as a
 * calm "BOOK EUR" chip straight off the tool argument while being unreadable by
 * every rule below — an unscoped workspace total captioned as a EUR total, one
 * qualifier to the left of the substitution this file exists to refuse.
 */
export const QUALIFIER_KINDS = [
  'pipeline', 'stage', 'owner', 'period', 'status', 'metric',
  'currency', 'account', 'unit', 'meter',
  /** The row cut-off a "top 5" question named. */
  'limit',
  /** The kind of record the figure counted — deals, tickets, companies. */
  'object',
  /** The dimension a "break it down by…" or "which … is biggest" question asked for. */
  'group',
  /**
   * A value of an enumerated record property — a lead source, a deal type, a
   * competitor. The dimension this list did not have, and the one a question
   * could therefore name without anything being able to refuse it.
   */
  'property',
] as const;

export type QualifierKind = (typeof QUALIFIER_KINDS)[number];

/** A filter condition as the record tools take them. */
interface Condition { property?: unknown; op?: unknown; value?: unknown; values?: unknown }

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

const num = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = str(value);
  return text && /^\d+$/.test(text) ? Number(text) : null;
};

const conditionsOf = (args: Record<string, unknown>): Condition[] => {
  const raw = args.conditions;
  return Array.isArray(raw) ? raw.filter((row): row is Condition => !!row && typeof row === 'object') : [];
};

const valuesOf = (condition: Condition): string[] => {
  const single = str(condition.value);
  if (single) return [single];
  return Array.isArray(condition.values) ? condition.values.filter((v): v is string => typeof v === 'string') : [];
};

const conditionOn = (args: Record<string, unknown>, property: string): Condition | null =>
  conditionsOf(args).find((c) => str(c.property) === property) ?? null;

export interface BoundScope {
  /** Pipeline machine name the query filtered to, or null for every pipeline. */
  pipeline: string | null;
  /** Stage machine names the query filtered to. Empty means every stage. */
  stages: string[];
  ownerId: string | null;
  /** A company, contact or billing customer the metric was scoped to. */
  subjectId: string | null;
  window: { start: number | null; end: number | null; label: string | null } | null;
  /** `open`, `won` or `lost` when the stage list is exactly one of those sets. */
  status: string | null;
  currency: string | null;
  groupBy: string | null;
  /** The record type the query ran over: `deal`, `ticket`, `company`, … */
  objectType: string | null;
  /** The metric id `business_metric` was asked for, when it was the tool. */
  metric: string | null;
  /** The row cut-off the query ran with, from whichever argument carried it. */
  limit: number | null;
  /** The query said `group_by: "none"`: one total came back, not rows. */
  oneTotal: boolean;
}

const EMPTY_SCOPE: BoundScope = {
  pipeline: null, stages: [], ownerId: null, subjectId: null, window: null,
  status: null, currency: null, groupBy: null, objectType: null, metric: null, limit: null,
  oneTotal: false,
};

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...new Set(a)].every((value) => b.includes(value));

/**
 * The scope one tool call actually ran with.
 *
 * A `deal_stage in (…)` condition listing every open stage in the workspace is
 * not a stage filter, it is "open deals" — reading it as a stage filter would
 * put eight stage chips over an answer that narrowed to nothing.
 */
export function boundScopeOf(call: ToolCallLike, vocab: Vocabulary): BoundScope {
  const args = call.arguments ?? {};
  // Either shape: a filter condition on the record tools, or the plain `stage`
  // and `stages` arguments `business_metric` takes.
  const stageCondition = conditionOn(args, 'deal_stage') ?? conditionOn(args, 'stage');
  const plainStage = str(args.stage);
  const plainStages = Array.isArray(args.stages) ? args.stages.filter((v): v is string => typeof v === 'string') : [];
  const stageValues = stageCondition ? valuesOf(stageCondition) : plainStages.length ? plainStages : plainStage ? [plainStage] : [];
  const openNames = [...new Set(openStagesOf(vocab).map((s) => s.name))];
  const closedNames = [...new Set(vocab.pipelines.flatMap((p) => p.stages.filter((s) => s.isClosed).map((s) => s.name)))];
  const wonNames = [...new Set(vocab.pipelines.flatMap((p) => p.stages.filter((s) => s.isClosed && s.isWon).map((s) => s.name)))];
  const lostNames = closedNames.filter((name) => !wonNames.includes(name));

  let status = str((args as { deal_status?: unknown }).deal_status);
  let stages = stageValues;
  // A `deal_stage in (…)` listing every open stage in the workspace is not a
  // stage filter, it is "open deals": reading it as one would put eight stage
  // chips over an answer that narrowed to nothing.
  if (stageValues.length > 1 && openNames.length && sameSet(stageValues, openNames)) { status = 'open'; stages = []; }
  // Naming only won stages, or only lost ones, *is* a status filter — and also
  // still a stage filter, so both are reported. "Which deals did we lose in Q2"
  // answered with `deal_stage in (closed_lost)` has honoured the status.
  else if (stages.length && wonNames.length && stages.every((name) => wonNames.includes(name))) status = status ?? 'won';
  else if (stages.length && lostNames.length && stages.every((name) => lostNames.includes(name))) status = status ?? 'lost';
  else if (stages.length && closedNames.length && stages.every((name) => closedNames.includes(name))) status = status ?? 'closed';
  else if (stages.length && openNames.length && stages.every((name) => openNames.includes(name))) status = status ?? 'open';

  const statusCondition = conditionOn(args, 'deal_status');
  if (statusCondition) status = valuesOf(statusCondition)[0] ?? status;

  const start = typeof args.start === 'number' ? args.start : null;
  const end = typeof args.end === 'number' ? args.end : null;
  const label = str(args.window_label);

  return {
    ...EMPTY_SCOPE,
    pipeline: str(args.pipeline) ?? valuesOf(conditionOn(args, 'pipeline') ?? {})[0] ?? null,
    stages,
    ownerId: str(args.owner_id) ?? valuesOf(conditionOn(args, 'owner_id') ?? {})[0] ?? null,
    // `account_profile` spells its subject `id` rather than `subject_id`, and
    // reading only the other three names is why "What is the CSAT for Meridian
    // Forge Systems?" — answered with that company's profile card — carried no
    // scope row at all: the one step that ran looked, from here, like a call
    // that had narrowed to nothing. `id` is only a subject on that tool; on a
    // write it is the record being changed, which is a different claim.
    subjectId: str(args.subject_id) ?? str(args.associated_to) ?? str(args.customer)
      ?? (call.name === 'account_profile' ? str(args.id) : null),
    window: start !== null || end !== null || label ? { start, end, label } : null,
    status: status ?? null,
    currency: str(args.currency),
    groupBy: (str(args.group_by) === 'none' ? null : str(args.group_by)),
    objectType: str(args.object_type),
    metric: str(args.metric),
    // The engine spells the cut-off three ways depending on the tool it lands
    // on — `limit` on a search, `top` on a ranking, `group_limit` on a grouped
    // metric — and a reader of one of those names reports the other two as no
    // cut-off at all.
    limit: num(args.limit) ?? num(args.top) ?? num(args.group_limit),
    oneTotal: str(args.group_by) === 'none',
  };
}

/**
 * Whether the query returned rows a cut-off could actually cut.
 *
 * A grouped metric ranks its buckets and a record search ranks its records; a
 * metric grouped by nothing returns one number, and a `limit` beside it is
 * inert however plainly it appears in the arguments. This is the engine's own
 * `returnsRows` rule, read off the same arguments — the point is to hold the
 * engine to the test it set itself, not to invent a second one that would
 * disagree with it in either direction.
 */
export const cutsRows = (scope: BoundScope): boolean =>
  (scope.groupBy ? true : !scope.oneTotal && !scope.metric);

/** Whether a call narrowed on anything at all, which is what makes it worth captioning. */
export const isNarrowed = (scope: BoundScope): boolean =>
  !!(scope.pipeline || scope.stages.length || scope.ownerId || scope.subjectId || scope.window
    || scope.status || scope.currency || scope.groupBy || scope.objectType || scope.metric
    || scope.limit !== null);

/* ----------------------------- what it returned --------------------------- */

/**
 * `Ran business_metric in 2ms → $9,010,960 (38 open deals).`
 *
 * The engine writes one of these per step it ran, in order, which is the only
 * place a thread's message carries what a tool *returned* — the run detail with
 * its trace is a second request this surface should not make per message.
 */
const RAN = /^Ran ([a-z_][a-z0-9_.]*) in [\d.]+\s*ms\s*→\s*([\s\S]+?)\.?$/;

/** A returned value that is a figure rather than a name. */
const FIGURE = /^[^\s(]*[\d]/;

/**
 * A returned value that is a serialised payload rather than a figure.
 *
 * `Ran credits.balance in 1ms → {"object":"credit_balance","customer":"cus_dgqX…`
 * is the step handing back its whole row. It passes the figure test — the
 * customer id has digits in it and there is no space before them — and every
 * consequence of that is wrong: the answer is captioned with a scope read off a
 * step that quoted nothing, and with two such steps the scope bar prints the
 * JSON itself as the name of the figure it is captioning.
 */
const PAYLOAD = /^[[{]/;

export interface Measurement {
  tool: string;
  args: Record<string, unknown>;
  /** The figure the step returned, exactly as the engine printed it. */
  figure: string | null;
  scope: BoundScope;
}

/**
 * Every tool call this answer made, paired with the figure it returned.
 *
 * The pairing is positional per tool name, which is how the engine writes them:
 * the nth `Ran business_metric` line belongs to the nth `business_metric` call.
 * A reasoning trail this cannot read leaves every figure null, and everything
 * downstream falls back to "these are the scopes this answer measured over" —
 * still true, just less precise.
 */
export function measurementsOf(calls: ToolCallLike[], reasoning: string[], vocab: Vocabulary): Measurement[] {
  const returned = new Map<string, string[]>();
  for (const line of reasoning) {
    const match = RAN.exec(line.trim());
    if (!match) continue;
    const list = returned.get(match[1]) ?? [];
    list.push(match[2].trim());
    returned.set(match[1], list);
  }
  const taken = new Map<string, number>();
  return calls.map((call) => {
    const index = taken.get(call.name) ?? 0;
    taken.set(call.name, index + 1);
    const raw = returned.get(call.name)?.[index] ?? null;
    const head = raw ? raw.split(' (')[0].trim() : null;
    return {
      tool: call.name,
      args: call.arguments ?? {},
      figure: head && !PAYLOAD.test(head) && FIGURE.test(head) ? head : null,
      scope: boundScopeOf(call, vocab),
    };
  });
}

/* -------------------------------- currency -------------------------------- */

const SYMBOL_OF: [string, string][] = [['$', 'usd'], ['€', 'eur'], ['£', 'gbp'], ['¥', 'jpy'], ['₹', 'inr']];

/** The books this workspace's money can be held in, as ISO codes and as words. */
const CURRENCY_WORDS: Record<string, string> = {
  dollar: 'usd', dollars: 'usd', euro: 'eur', euros: 'eur',
  pound: 'gbp', pounds: 'gbp', sterling: 'gbp', yen: 'jpy',
};
const ISO_CODE = /(^|[^a-z0-9])(usd|eur|gbp|jpy|cad|aud|chf|sek|nok|dkk|nzd|sgd|hkd|inr|brl|mxn|zar|pln|czk|huf)([^a-z0-9]|$)/;

/**
 * The currency a printed figure is in, read off the glyph the engine wrote.
 *
 * This is the whole check available to a client that makes no extra request:
 * an answer captioned "the EUR book" whose own figure carries a `$` was not
 * measured in EUR, whatever the tool argument says. `$9,148,979` → `usd`.
 */
export function currencyOfFigure(figure: string | null): string | null {
  return currenciesOfFigure(figure)[0] ?? null;
}

/**
 * Every book a printed figure names.
 *
 * More than one — `$27,839.34, €3,005 and £2,285` — is three books added into
 * one sentence, which is not the EUR figure however the arguments read.
 */
export function currenciesOfFigure(figure: string | null): string[] {
  if (!figure) return [];
  const found = SYMBOL_OF.filter(([symbol]) => figure.includes(symbol)).map(([, code]) => code);
  for (const match of figure.matchAll(/(^|[^A-Za-z])([A-Z]{3})([^A-Za-z]|$)/g)) {
    const code = match[2].toLowerCase();
    if (!found.includes(code)) found.push(code);
  }
  return found;
}

/**
 * The steps whose figure the answer is actually quoting.
 *
 * "How much pipeline does Marcus Ilori own?" ran three steps: an aggregate over
 * Marcus's deals, an account profile, and a metric over the company that
 * profile happened to land on. The prose quotes only the third — so the scope a
 * reader is looking at is that third step's, and reporting the first step's
 * owner filter as this answer's scope would be a second substitution on top of
 * the first.
 */
export function answeringMeasurements(measurements: Measurement[], prose: string): Measurement[] {
  const withFigure = measurements.filter((m) => m.figure);
  const quoted = withFigure.filter((m) => m.figure !== null && prose.includes(m.figure));
  if (quoted.length) return quoted;
  if (withFigure.length) return withFigure;
  // A credit balance, an entitlement set, a timeline: steps that answer in
  // prose rather than in one number. They still ran with a scope — one account,
  // one meter — and dropping them left the reader of a credit answer with no
  // statement of scope at all. A run that called nothing still returns nothing,
  // which is what keeps a refusal free of scope warnings.
  return measurements.filter((m) => isNarrowed(m.scope));
}

/* ------------------------- what the question named ------------------------ */

export interface NamedQualifier {
  kind: QualifierKind;
  /** The words the question used. */
  text: string;
  /** The workspace's label for what those words name. */
  label: string;
  /** The machine value, where there is one. */
  value: string | null;
  /**
   * The shape of the question the qualifier was read out of.
   *
   * `count` is "How many contacts are in the Expansion pipeline?" — a question
   * whose answer is a number of records. It matters because an answer to it
   * denominated in money has counted nothing, whatever record type the query
   * happened to run over, and that is not a fact the arguments can show.
   */
  frame?: 'count';
  /**
   * The CRM's own name for the dimension this qualifier narrows.
   *
   * Only `property` carries one: every other kind is its own dimension, and
   * "Original source" is what the reader has to see beside "Trade show" for
   * the chip and the sentence to name anything they can check.
   */
  dimension?: string;
}

const hasPhrase = (haystack: string, phrase: string): boolean => {
  const needle = norm(phrase);
  if (!needle) return false;
  return new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(haystack);
};

const PIPELINE_CUE = /(^|[^a-z])(pipelines?|funnel|board)([^a-z]|$)/;

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const PERIOD_PATTERNS: RegExp[] = [
  new RegExp(`(${MONTHS})\\s+(\\d{4})`),
  new RegExp(`(${MONTHS})(?![a-z])`),
  /q[1-4]\s*(\d{4}|fy\d{2})?/,
  /(last|this|next|previous|current)\s+(week|month|quarter|year|fortnight)/,
  /(year|quarter|month)\s+to\s+date/,
  /\bytd\b/,
  /(in|during|for|since)\s+(19|20)\d{2}/,
  /\b(20)\d{2}\b/,
  /last\s+\d+\s+(days?|weeks?|months?|quarters?|years?)/,
];

/** "august 2026" → "August 2026", "q2 2026" → "Q2 2026". The question is matched lower-cased. */
export const prettyPeriod = (text: string): string =>
  text.replace(new RegExp(`\\b(${MONTHS}|q[1-4]|ytd)\\b`, 'g'), (word) =>
    (word.length <= 3 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)));

/**
 * The dimension a "break this down by…" or "which … is biggest" question asks
 * for, against the group-by vocabulary `business_metric` actually takes.
 *
 * `pipeline` is in the list and not in that vocabulary, which is the point:
 * "Which pipeline has the most open deals?" is answered with the eight largest
 * deals in the workspace, ranking nothing, and the surface has to say so.
 */
const GROUP_DIMENSIONS: { word: RegExp; value: string; label: string }[] = [
  { word: /(pipelines?|boards?|funnels?)/, value: 'pipeline', label: 'pipeline' },
  { word: /(stages?|columns?)/, value: 'stage', label: 'stage' },
  { word: /(owners?|reps?|salespeople|salesperson|teammates?|sellers?)/, value: 'owner', label: 'owner' },
  { word: /(months?|quarters?|weeks?|years?)/, value: 'time', label: 'period' },
  { word: /(accounts?|customers?|companies|company)/, value: 'account', label: 'account' },
  { word: /(industry|industries|sectors?)/, value: 'industry', label: 'industry' },
  { word: /(sources?|channels?)/, value: 'source', label: 'source' },
];

const RANKING_CUE = /\b(?:which|what)\b[^?]*\b(?:most|biggest|largest|highest|top|best|worst|fewest|smallest|lowest)\b/;

/* --------------------------- the thing being counted ---------------------- */

/**
 * The kinds of record a question can ask for a count of, in the words people
 * write them in.
 *
 * Deliberately short. Every entry here becomes a claim on screen about what a
 * figure counted, and a noun that is also the name of a measure — "accounts" is
 * a keyword of Customers — would spend the same word twice and accuse a correct
 * answer of measuring the wrong thing.
 */
const OBJECT_NOUNS: { word: RegExp; value: string; label: string }[] = [
  { word: /^deals?$/, value: 'deal', label: 'deals' },
  { word: /^tickets?$/, value: 'ticket', label: 'tickets' },
  { word: /^(?:companies|company)$/, value: 'company', label: 'companies' },
  { word: /^contacts?$/, value: 'contact', label: 'contacts' },
  { word: /^invoices?$/, value: 'invoice', label: 'invoices' },
  { word: /^subscriptions?$/, value: 'subscription', label: 'subscriptions' },
];

const COUNT_FRAME = /\b(?:how many|number of|count of)\s+(?:(?:the|our|open|active|closed|won|lost|new)\s+)*([a-z]+)\b/;

/**
 * `How many contacts are in the Expansion pipeline?` → contacts.
 *
 * The head noun of a counting question is the whole question: the engine
 * answered that one with "$3,162,060 in open pipeline, from 10 open deals" and
 * its own working notes never contained the word "contacts" at all. Nothing in
 * the arguments of that call can be compared against a word the ledger never
 * received, so the word is read here and entered as a qualifier of its own.
 */
export function countedObject(text: string): { value: string; label: string; text: string } | null {
  const match = COUNT_FRAME.exec(norm(text));
  if (!match) return null;
  const found = OBJECT_NOUNS.find((row) => row.word.test(match[1]));
  return found ? { value: found.value, label: found.label, text: match[0] } : null;
}

/* ------------------------ enumerated record properties -------------------- */

/**
 * Properties whose values another qualifier kind already speaks for.
 *
 * A stage is a `deal_stage` value and a pipeline is a `pipeline` value; both
 * have rules of their own above, and claiming them twice is how one question
 * grows two contradicting warnings.
 */
const OWNED_ELSEWHERE = new Set(['pipeline', 'deal_stage', 'deal_status', 'stage', 'status', 'owner_id']);

/**
 * Option labels too generic to read as a claim about scope.
 *
 * Every entry in this vocabulary becomes a red banner when the query did not
 * carry it, so a word that turns up in ordinary questions has to stay out:
 * "What is the price?" is not a question about the `Price` close reason.
 */
const TOO_GENERIC = new Set(['price', 'none', 'other', 'closed', 'open', 'commit', 'pipeline', 'won', 'lost']);

/**
 * The enumerated property values this surface will hold an answer to.
 *
 * Taken from the CRM's own `crm_properties`, minus the values another
 * qualifier kind already owns, the ones a metric's vocabulary already spends,
 * and short single words that appear in ordinary sentences. What survives —
 * "Trade show", "Partner referral", "Webinar", "Pilot conversion" — are the
 * board's own filters, and each is a question a rev-ops lead actually asks.
 */
export function propertyVocabulary(
  defs: VocabPropertyDef[],
  pipelines: VocabPipeline[],
  metrics: VocabMetric[],
): VocabPropertyValue[] {
  const taken = new Set<string>();
  for (const pipeline of pipelines) {
    taken.add(norm(pipeline.label));
    taken.add(norm(humanizeName(pipeline.name)));
    for (const stage of pipeline.stages) {
      taken.add(norm(stage.label));
      taken.add(norm(humanizeName(stage.name)));
    }
  }
  for (const metric of metrics) {
    taken.add(norm(metric.label));
    for (const keyword of metric.keywords) taken.add(norm(keyword));
  }
  const out: VocabPropertyValue[] = [];
  const seen = new Set<string>();
  for (const def of defs) {
    if (OWNED_ELSEWHERE.has(def.name)) continue;
    for (const option of def.options ?? []) {
      const label = norm(option.label);
      if (!label || taken.has(label) || seen.has(label)) continue;
      if (TOO_GENERIC.has(label)) continue;
      // A single short word is a word people write for other reasons.
      if (!label.includes(' ') && label.length < 6) continue;
      seen.add(label);
      out.push({ property: def.name, propertyLabel: def.label, value: option.value, label: option.label });
    }
  }
  return out;
}

/* --------------------- a record named, and a record used ------------------ */

/** The words a question used to name a record, beside the record that answered. */
export interface RecordMismatch {
  /** The phrase the question named, exactly as it wrote it. */
  asked: string;
  /** The record the engine resolved that phrase to. */
  used: string;
}

const tokensOf = (text: string): string[] =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * Words that end a record's name rather than continuing it.
 *
 * "the Sakamoto Seiki deal" names a record partially and contradicts nothing;
 * "the Sakamoto Seiki — packaging line uplift deal" carries a disambiguator,
 * and a resolution that ignores it has answered about a different record.
 */
const AFTER_A_NAME = new Set([
  'a', 'an', 'the', 'this', 'that', 'to', 'into', 'for', 'from', 'with', 'on', 'at', 'in', 'by', 'of',
  'and', 'or', 'as', 'then', 'please', 'is', 'are', 'was', 'were', 'be', 'has', 'have', 'had',
  'it', 'its', 'their', 'our', 'my', 'your', 'right', 'now', 'worth', 'value', 'amount', 'total',
  'deal', 'deals', 'opportunity', 'opportunities', 'ticket', 'tickets', 'company', 'companies',
  'contact', 'contacts', 'account', 'accounts', 'customer', 'customers', 'record', 'records',
  'note', 'notes', 'task', 'tasks', 'invoice', 'invoices', 'subscription', 'subscriptions',
  'stage', 'stages', 'pipeline', 'pipelines', 'owner', 'owners',
  // "Add a note to Meridian Forge Systems about the renewal deal" ends the
  // record's name at "about". Without these the residue rule below reads the
  // rest of the sentence as a disambiguator the record lacks.
  'about', 'regarding', 'concerning', 'saying', 'because', 'when', 'where', 'which', 'who',
]);

/**
 * Words that narrow a set rather than name a second record.
 *
 * "the Pemberton Auto Systems open deals" is a question about that account's
 * open deals; reading "open" as a disambiguator the account's name lacks would
 * put a red "this is not the record you named" over a correct answer.
 */
const DESCRIBES_A_SET = new Set([
  'open', 'closed', 'won', 'lost', 'active', 'inactive', 'new', 'current', 'latest', 'recent',
  'biggest', 'largest', 'smallest', 'oldest', 'newest', 'top', 'bottom', 'remaining', 'other',
  'overdue', 'stalled', 'upcoming', 'live', 'every', 'all',
]);

/** The nouns a person puts after a record's name when they are naming a record. */
const RECORD_NOUNS = new Set([
  'deal', 'deals', 'opportunity', 'opportunities', 'ticket', 'tickets', 'company', 'companies',
  'contact', 'contacts', 'account', 'accounts', 'customer', 'customers', 'record', 'records',
  'invoice', 'invoices', 'subscription', 'subscriptions',
]);

/** The exact substring of the question a token run came from, punctuation and all. */
const rawPhrase = (question: string, tokens: string[]): string | null => {
  const pattern = new RegExp(
    tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^A-Za-z0-9]+'), 'i',
  );
  const hit = pattern.exec(question);
  return hit ? hit[0].trim() : null;
};

/**
 * A question that named one record, answered about a record that contains it.
 *
 * "Move the Sakamoto Seiki — packaging line uplift deal to Negotiation" was
 * prepared as a write on *Sakamoto Seiki — multi-site rollout*, a closed-won
 * deal for $321,840, and the card a person approved showed the user's sentence
 * and the wrong record's name three lines apart. "How much is the Sakamoto
 * Seiki — packaging line uplift deal worth?" answered $724,140 — both Sakamoto
 * deals — for a deal worth $402,300.
 *
 * One rule covers both, because it is one defect: the question's phrase begins
 * with the resolved record's name and then carries words that record does not
 * have. That residue is a qualifier, and a resolution that dropped it landed on
 * a sibling. A question that names the record in full, or names only a prefix
 * of it and stops, contradicts nothing and is left alone.
 */
export function recordPhraseMismatch(question: string, recordName: string): RecordMismatch | null {
  const target = tokensOf(recordName);
  const asked = tokensOf(question);
  if (!target.length || !asked.length) return null;
  let best: { matched: number; run: string[] } | null = null;
  for (let i = 0; i < asked.length; i += 1) {
    if (asked[i] !== target[0]) continue;
    let matched = 0;
    while (matched < target.length && asked[i + matched] === target[matched]) matched += 1;
    const next = asked[i + matched];
    if (!next || next.length < 3 || AFTER_A_NAME.has(next)) continue;
    const rest = asked.slice(i + matched);
    // The noun that ends a record's name ends the phrase, however much of the
    // name sits in front of it. Stopping at the first "to" or "of" cut "pilot
    // expansion to 3 lines" down to "pilot" — and "pilot" is a word the *other*
    // Pemberton deal happens to carry, which stood the whole guard down: the
    // approval card for "Move the Pemberton Auto Systems pilot expansion to 3
    // lines deal to Proposal" was prepared against *first pilot attempt*,
    // closed-lost at $223,440, with no warning and one click to run it.
    const nounAt = rest.findIndex((word) => RECORD_NOUNS.has(word));
    const fillerAt = rest.findIndex((word) => AFTER_A_NAME.has(word));
    const cut = nounAt >= 0 && nounAt <= NAME_WORDS ? nounAt : (fillerAt >= 0 ? fillerAt : rest.length);
    const run = rest.slice(0, cut);
    const terminator = rest[cut] ?? null;
    if (!run.length) continue;
    // The whole residue against the whole name, not one token against the bag
    // of the name's words. "the Northwind renewal deal" is *Northwind Robotics
    // — renewal 2027* with a word left out — the residue continues the name in
    // order, so nothing is contradicted. "pilot expansion" does not continue
    // "first pilot attempt", whichever of its words appear somewhere in it.
    if (continuesName(run, target, matched)) continue;
    // A residue made only of words that narrow a set — "the Pemberton Auto
    // Systems open deals" — names no second record.
    if (run.every((word) => AFTER_A_NAME.has(word) || DESCRIBES_A_SET.has(word))) continue;
    // A residue is only a record's own name when the question is using it as
    // one: "the Sakamoto Seiki — packaging line uplift **deal**" names a
    // record, and "Sakamoto Seiki — packaging" carries the separator this
    // workspace writes compound record names with. "How much has Sakamoto
    // Seiki spent recently?" carries neither, and reading its verbs as a
    // record name would put a red banner over a correct account answer.
    const joined = rawPhrase(question, [target[matched - 1], run[0]]) ?? '';
    const compound = /[\u2014\u2013]|(?:\S)\s*[:-]\s*(?:\S)/.test(joined);
    if (!compound && !RECORD_NOUNS.has(terminator ?? '')) continue;
    if (!best || matched > best.matched) best = { matched, run };
  }
  if (!best) return null;
  const phrase = [...target.slice(0, best.matched), ...best.run];
  return { asked: rawPhrase(question, phrase) ?? phrase.join(' '), used: recordName };
}

/** How far past the name a record noun may sit and still be its terminator. */
const NAME_WORDS = 8;

/**
 * Whether a residue is the rest of the record's own name, words left out.
 *
 * `["renewal"]` against `Northwind Robotics — renewal 2027` from index 1 is:
 * the question named the record partially. `["pilot", "expansion"]` against
 * `Pemberton Auto Systems — first pilot attempt` is not — "expansion" never
 * follows "pilot" there — so the question named a different record.
 */
const continuesName = (run: string[], target: string[], from: number): boolean => {
  let at = from;
  for (const word of run) {
    const found = target.indexOf(word, at);
    if (found === -1) return false;
    at = found + 1;
  }
  return true;
};

/** Whether one name is the whole of the start of another — "Sakamoto Seiki" of the deal. */
export const isWiderName = (asked: string, used: string): boolean => {
  const inner = tokensOf(used);
  const outer = tokensOf(asked);
  return inner.length > 0 && inner.length < outer.length && inner.every((word, i) => outer[i] === word);
};

/**
 * `Break open pipeline down by pipeline` / `Which pipeline has the most open
 * deals?` / `What are our top 3 accounts by spend?`
 *
 * The third shape names the dimension immediately after the cut-off, and
 * reading only the first two had a cost beyond the missing group chip: nothing
 * claimed the word "accounts", so the metric catalogue claimed it instead — it
 * is a keyword of `customers` — and a correct answer about customer spend was
 * accused, in red, of measuring the wrong thing.
 */
export function groupAsked(text: string): { value: string; label: string; text: string; noun: string } | null {
  const ranking = RANKING_CUE.test(text);
  for (const dimension of GROUP_DIMENSIONS) {
    // "by customer" is a breakdown; "per customer" is a ratio, and reading it
    // as a breakdown put a warning over a correct total.
    const split = new RegExp(`\\bby\\s+(?:the\\s+|each\\s+)?(${dimension.word.source})\\b`).exec(text);
    if (split) return { value: dimension.value, label: dimension.label, text: split[0], noun: split[1] };
    // "top 5 accounts" carries its own ranking cue, so it does not wait for a
    // "which" or a "what" the way the bare-noun form has to.
    const cut = new RegExp(`\\b(?:top|bottom)\\s+\\d+\\s+(?:the\\s+)?(${dimension.word.source})\\b`).exec(text);
    if (cut) return { value: dimension.value, label: dimension.label, text: cut[0], noun: cut[1] };
    if (!ranking) continue;
    const asked = new RegExp(`\\b(?:which|what)\\s+(${dimension.word.source})\\b`).exec(text);
    if (asked) return { value: dimension.value, label: dimension.label, text: asked[0], noun: asked[1] };
  }
  return null;
}

/**
 * "Marcus" is the teammate only when the next word does not finish somebody
 * else's name.
 *
 * "What is the open pipeline for Marcus Brennan?" — a contact — was answered
 * correctly and then topped with "You asked about Marcus Ilori", a sentence
 * about the reader's own question that the reader can see is false. This
 * workspace has three other Marcuses in the CRM; the question's own next token
 * is the cheapest way to tell them apart without a second read.
 */
const finishesAnotherName = (raw: string, first: string): boolean => {
  const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^A-Za-z])${escaped}\\s+([A-Za-z][A-Za-z'’-]*)`, 'gi');
  for (const match of raw.matchAll(pattern)) {
    if (/^[A-Z]/.test(match[2])) return true;
  }
  return false;
};

const STATUS_WORDS: { word: RegExp; value: string; label: string }[] = [
  { word: /(^|[^a-z])(won|win|wins)([^a-z]|$)/, value: 'won', label: 'Won deals' },
  { word: /(^|[^a-z])(lost|lose|losing|churned)([^a-z]|$)/, value: 'lost', label: 'Lost deals' },
  /**
   * The word this list did not have, and the answer it cost.
   *
   * "How many deals did we close in Q2 2026?" is answered "Northwind Robotics
   * has 0 open deals closing in Q2 2026" — the status inverted to its exact
   * opposite and asserted as the scope, against a true 8 deals worth $613,760.
   * The same question written "Show me the deals we closed in Q2 2026" returns
   * all 8, so one bare verb splits one question into two answers 8× apart, and
   * nothing on this surface could contradict "open only" over a sentence that
   * said "close" because no rule here knew the word.
   *
   * "closing" is deliberately not matched: a deal closing next month is open.
   * Nor is "close date", which names a column rather than a status.
   */
  { word: /(^|[^a-z])(closed?|closes)(?!\s+dates?)([^a-z]|$)/, value: 'closed', label: 'Closed deals' },
  { word: /(^|[^a-z])(open)([^a-z]|$)/, value: 'open', label: 'Open deals' },
];

/**
 * The qualifiers a question names, matched against this workspace's vocabulary.
 *
 * Precision matters more than recall here, because every match becomes a claim
 * on screen. A pipeline is only read out of the question when the question also
 * says "pipeline" (or funnel, or board) — so "support tickets" is not a claim
 * about the Support pipeline — and a person is only read out of a bare first
 * name when exactly one teammate has it.
 */
export function namedQualifiers(question: string, vocab: Vocabulary): NamedQualifier[] {
  const text = norm(question);
  const found: NamedQualifier[] = [];
  const seen = new Set<string>();
  const add = (q: NamedQualifier) => {
    const key = `${q.kind}:${q.value ?? q.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(q);
  };

  const cue = PIPELINE_CUE.exec(text);
  if (cue) {
    for (const pipeline of vocab.pipelines) {
      const phrase = [pipeline.label, humanizeName(pipeline.name)].find((candidate) => hasPhrase(text, candidate));
      if (phrase) add({ kind: 'pipeline', text: phrase, label: pipeline.label, value: pipeline.name });
    }
  }
  // The words another qualifier has already taken. "the Expansion pipeline" has
  // spent the word "pipeline" on the pipeline; letting the metric catalogue
  // spend it a second time is what accuses a correct deal count of measuring
  // open pipeline.
  const consumed = new Set<string>(found.some((q) => q.kind === 'pipeline') && cue ? [cue[2]] : []);

  // A stage name that reads as a pipeline name in the same breath ("the Renewal
  // pipeline") is the pipeline, not the stage: claiming both would put two
  // warnings on one question.
  const pipelineWords = found.filter((q) => q.kind === 'pipeline').map((q) => norm(q.text));
  // A stage name sitting inside a longer measure name is that measure's own
  // words. "What is closed-won bookings in EUR this year?" names the metric
  // `Closed-won bookings`, and reading "Closed won" out of it as a stage filter
  // put "You asked about Closed won. This figure counts every stage." over a
  // correct bookings figure — beside the one warning on that card that was
  // true. Only a strictly longer measure overrides the stage, so "How many
  // deals are in Closed won?" still names the column.
  const measureName = norm(metricAsked(text, vocab, consumed)?.phrase ?? '');
  for (const stage of vocab.pipelines.flatMap((p) => p.stages)) {
    const phrase = [stage.label, humanizeName(stage.name)].find((candidate) => hasPhrase(text, candidate));
    if (!phrase || pipelineWords.includes(norm(phrase))) continue;
    if (measureName.length > norm(phrase).length && hasPhrase(measureName, phrase)) continue;
    add({ kind: 'stage', text: phrase, label: stage.label, value: stage.name });
  }

  for (const person of vocab.people) {
    if (hasPhrase(text, person.name)) { add({ kind: 'owner', text: person.name, label: person.name, value: person.id }); continue; }
    const first = person.name.split(/\s+/)[0];
    const unique = vocab.people.filter((other) => other.name.split(/\s+/)[0] === first).length === 1;
    if (unique && first.length > 2 && hasPhrase(text, first) && !finishesAnotherName(question, first)) {
      add({ kind: 'owner', text: first, label: person.name, value: person.id });
    }
  }

  for (const pattern of PERIOD_PATTERNS) {
    const match = pattern.exec(text);
    if (match) { add({ kind: 'period', text: match[0].trim(), label: prettyPeriod(match[0].trim()), value: null }); break; }
  }

  // A status word inside the name of a measure is the measure's own word, not a
  // filter the answer failed to apply: "win rate" is a metric in this catalogue
  // and "win" is inside it, which put "You asked about won deals. This figure
  // counts every status." over a correct win-rate answer.
  const measurePhrase = norm(metricAsked(text, vocab, consumed)?.phrase ?? '');
  for (const status of STATUS_WORDS) {
    const hit = status.word.exec(text);
    if (!hit) continue;
    if (measurePhrase && hasPhrase(measurePhrase, hit[2])) break;
    add({ kind: 'status', text: status.value, label: status.label, value: status.value });
    break;
  }

  const book = currencyAsked(question);
  if (book) add({ kind: 'currency', text: book.text, label: book.code.toUpperCase(), value: book.code });

  const group = groupAsked(text);
  if (group) {
    add({ kind: 'group', text: group.text, label: group.label, value: group.value });
    // The dimension a ranking is cut on has spent that word. Letting the metric
    // catalogue spend it again is what turned "top 3 accounts by spend" into an
    // accusation that the answer measured Customers.
    consumed.add(norm(group.noun));
  }

  // "How many contacts are in the Expansion pipeline?" is a question about
  // contacts that also names a pipeline, and the pipeline used to win: the
  // object qualifier was inferred from the pipeline cue and came out as
  // "deals", so the one word the answer got wrong was the one word nothing on
  // this surface was holding it to. The head noun of a counting question is
  // what the question is about, and it outranks anything inferred.
  const counted = countedObject(text);
  if (counted) add({ kind: 'object', text: counted.text, label: counted.label, value: counted.value, frame: 'count' });

  // A question that names a deal pipeline, one of its stages, or deals outright
  // is a question about deals. Which record type answered it is then a fact the
  // reader is owed: "Break down open pipeline by pipeline" is answered with
  // seven support tickets, under a banner that never says the word.
  const aboutDeals = !!cue || /(^|[^a-z])deals?([^a-z]|$)/.test(text)
    || found.some((q) => q.kind === 'pipeline' || q.kind === 'stage');
  if (aboutDeals && !counted) add({ kind: 'object', text: 'deals', label: 'deals', value: 'deal' });

  // A value of an enumerated record property — a lead source, a deal type, a
  // competitor. "How many open deals came from a trade show?" was answered
  // "38 open deals", 5.4x the true 7, with nothing on the card naming the
  // words the question turned on. The values come from the CRM's own property
  // options, so this claims only what the workspace itself defines.
  for (const row of vocab.properties ?? []) {
    if (consumed.has(norm(row.label))) continue;
    if (!hasPhrase(text, row.label)) continue;
    add({ kind: 'property', text: row.label, label: row.label, value: row.value, dimension: row.propertyLabel });
  }

  // A measure the catalogue does not define wins over the catalogue entry its
  // first word happens to match: "pipeline velocity" is not open pipeline.
  const unknown = unknownMeasure(text, vocab, consumed);
  const metric = unknown ? null : metricAsked(text, vocab, consumed);
  // The head noun of a counting question has already spent those words.
  // "open deals" is a keyword of Open pipeline as well as the thing being
  // counted, so "How many open deals came from a trade show?" — answered with
  // a correct deal count — was topped with a red "You asked for Open pipeline.
  // This figure is Deals, which is a different measure." A guard that fires on
  // correct answers is how the ones over real substitutions get ignored.
  const spentOnTheCount = !!counted && !!metric && norm(counted.text).includes(norm(metric.phrase));
  if (unknown) add({ kind: 'metric', text: unknown, label: humanizeName(unknown), value: null });
  else if (metric && !spentOnTheCount) {
    add({ kind: 'metric', text: metric.phrase, label: metric.metric.label, value: metric.metric.id });
  }

  return found;
}

/**
 * The book a question names, as an ISO code, a currency word or a lone symbol.
 *
 * `$100k` is not a book — the symbol has to stand on its own, the way "in €"
 * does — because a threshold in a question is not a claim about which ledger
 * the answer should come from.
 */
export function currencyAsked(question: string): { code: string; text: string } | null {
  const text = norm(question);
  const iso = ISO_CODE.exec(text);
  if (iso) return { code: iso[2], text: iso[2].toUpperCase() };
  for (const [word, code] of Object.entries(CURRENCY_WORDS)) {
    if (hasPhrase(text, word)) return { code, text: word };
  }
  for (const [symbol, code] of SYMBOL_OF) {
    const at = question.indexOf(symbol);
    if (at >= 0 && !/^\s*[\d.,]/.test(question.slice(at + symbol.length))) return { code, text: symbol };
  }
  return null;
}

/**
 * The metric the question names, out of the platform's own catalogue.
 *
 * "What is our weighted pipeline?" matches two of them — `pipeline` on the word
 * "pipeline" and `weighted_pipeline` on the word "weighted" — and the engine
 * has answered it with `pipeline`, roughly twice the figure asked for. The
 * longest phrase wins, so the full label "weighted pipeline" beats the single
 * word, and an exact tie claims nothing rather than guessing.
 */
export function metricAsked(
  question: string,
  vocab: Vocabulary,
  consumed: ReadonlySet<string> = new Set(),
): { metric: VocabMetric; phrase: string } | null {
  const text = norm(question);
  let best: { metric: VocabMetric; phrase: string } | null = null;
  let tied = false;
  for (const metric of vocab.metrics) {
    const phrases = [metric.label, ...metric.keywords]
      .filter((candidate) => !consumed.has(norm(candidate)))
      .filter((candidate) => hasPhrase(text, candidate));
    if (!phrases.length) continue;
    const longest = phrases.reduce((a, b) => (norm(b).length > norm(a).length ? b : a));
    if (!best || norm(longest).length > norm(best.phrase).length) { best = { metric, phrase: longest }; tied = false; }
    else if (norm(longest).length === norm(best.phrase).length) tied = true;
  }
  return best && !tied ? best : null;
}

/**
 * Words that carry no measure of their own, so a metric word next to one of
 * them is still that metric: "our pipeline", "the pipeline today".
 */
const FILLER = new Set([
  'a', 'an', 'the', 'our', 'my', 'your', 'their', 'its', 'this', 'that', 'these', 'those', 'all',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could',
  'in', 'on', 'at', 'of', 'for', 'from', 'to', 'by', 'with', 'about', 'across', 'over', 'per', 'and', 'or',
  'much', 'many', 'more', 'most', 'big', 'biggest', 'large', 'largest', 'total', 'sum', 'number', 'count',
  'what', 'whats', 'which', 'who', 'how', 'when', 'where', 'why', 'show', 'give', 'tell', 'me', 'us', 'we',
  'now', 'today', 'currently', 'right', 'still', 'yet', 'so', 'far', 'each', 'every', 'any', 'some',
  'value', 'figure', 'amount', 'worth', 'here', 'there', 'it', 'they', 'them', 'please',
]);

/**
 * A measure the question names that this workspace's catalogue does not define.
 *
 * "What is our pipeline velocity?" is answered with open pipeline — a different,
 * standard, larger number — with no warning, because the catalogue matches the
 * word "pipeline" and nothing at all matches "velocity". The test is the
 * catalogue's own vocabulary: a content word sitting directly against the one
 * word a metric was claimed from, which appears in no metric's label or
 * keywords anywhere, makes the pair a measure nobody here defines. "Churn rate"
 * survives that test, because "rate" is a word the catalogue does use.
 */
export function unknownMeasure(question: string, vocab: Vocabulary, consumed: ReadonlySet<string> = new Set()): string | null {
  const claimed = metricAsked(question, vocab, consumed);
  if (!claimed) return null;
  const phrase = norm(claimed.phrase);
  if (phrase.includes(' ')) return null;
  const known = new Set(
    vocab.metrics.flatMap((metric) => [metric.label, ...metric.keywords]).flatMap((entry) => norm(entry).split(' ')),
  );
  const words = norm(question).split(' ');
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] !== phrase) continue;
    const next = words[i + 1]?.replace(/[^a-z0-9]/g, '') ?? '';
    if (next.length < 3 || FILLER.has(next) || known.has(next) || consumed.has(next)) continue;
    // "deals closing this month" is a search, not a measure called "deals
    // closing": a participle after the noun is describing the records, not
    // naming a different number.
    if (/(?:ing|ed)$/.test(next)) continue;
    return `${phrase} ${next}`;
  }
  return null;
}

/**
 * A pipeline the answer says does not exist, that does.
 *
 * The engine's sentence is hedged — "No *deal* pipeline is called Support" —
 * and then it lists the three deal pipelines as "the pipelines Northwind
 * Robotics has". A reader takes that as "there is no Support pipeline". There
 * is one; it holds tickets, and this says so rather than leaving the denial to
 * stand.
 */
const PIPELINE_DENIAL = /no\s+(?:deal\s+)?pipeline[^.]*?is called\s+["“']([^"”']+)["”']/i;

export function deniedPipeline(prose: string, vocab: Vocabulary): VocabOtherPipeline | null {
  const denial = PIPELINE_DENIAL.exec(prose);
  if (!denial) return null;
  const named = norm(denial[1]);
  return (vocab.otherPipelines ?? []).find((row) => norm(row.label) === named || norm(row.name) === named) ?? null;
}

/* ----------------------- a refusal with a false reason --------------------- */

const REFUSED_QUALIFIER = /\b(pipeline|stage|owner|account|period|status|meter|currency|unit|limit)\s+"([^"]+)"/gi;

/** A refusal whose stated reason this workspace's own catalogue disproves. */
export interface MisreadRefusal {
  /** The kind the engine says it could not bind. */
  kind: string;
  /** The words it says it could not bind. */
  text: string;
  /** What those words actually name here. */
  metric: VocabMetric;
}

/**
 * "Which owner has the most open pipeline?" refused, one line under a chip
 * offering the rephrasing that answers it.
 *
 * The reason given is `1 qualifier could not be bound: status "open pipeline"`
 * — and "open pipeline" is not a status, it is the measure this platform
 * computes constantly and publishes in its own catalogue. The same run's notes
 * read `Metric: Open pipeline (matched "open pipeline", score 1)` and
 * `business_metric … grouped by owner to rank them`: the plan existed and was
 * thrown away. The client cannot make the engine keep it. It can refuse to
 * print a reason the card disproves two lines above.
 */
export function misreadRefusal(
  refusal: { code: string; message: string } | null | undefined,
  vocab: Vocabulary,
): MisreadRefusal | null {
  if (!refusal || refusal.code !== 'qualifier_unbound') return null;
  for (const match of refusal.message.matchAll(REFUSED_QUALIFIER)) {
    const named = metricAsked(match[2], vocab);
    if (named && norm(named.phrase) === norm(match[2])) {
      return { kind: match[1].toLowerCase(), text: match[2], metric: named.metric };
    }
  }
  return null;
}

/* -------------------- sentences the answer should not keep ---------------- */

/** "A", "A and B", "A, B and C". */
const joinList = (items: string[]): string =>
  (items.length <= 1 ? items[0] ?? '' : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

const DENIAL_SENTENCE = /\s*No\s+(?:deal\s+)?pipeline[^.]*?is called\s+["\u201c'][^"\u201d']+["\u201d']\.\s*/i;
const PIPELINE_ENUMERATION = /\s*The pipelines [^.]*?\bhas are[^.]*\.\s*/i;

/**
 * The denial, replaced rather than rebutted.
 *
 * "How many tickets are in the Support pipeline?" is answered "No deal
 * pipeline in this workspace is called 'Support'… The pipelines Northwind
 * Robotics has are 'New business', 'Expansion' and 'Renewal'." The workspace
 * has a Support pipeline holding 35 tickets, and the enumeration that is meant
 * to be helpful is a three-item list missing one of them. A correcting banner
 * above it was better than nothing and still left the falsehood on screen
 * under it, in the engine's own confident voice.
 */
export function correctPipelineDenial(prose: string, denied: VocabOtherPipeline, vocab: Vocabulary): string {
  const deals = vocab.pipelines.map((p) => `\u201c${p.label}\u201d`);
  const others = (vocab.otherPipelines ?? []).map((p) => `\u201c${p.label}\u201d (${p.objectType}s)`);
  const truth = `\u201c${denied.label}\u201d is a ${denied.objectType} pipeline in this workspace, `
    + `so a deal measure cannot be computed over it.`;
  const enumeration = deals.length || others.length
    ? ` This workspace\u2019s pipelines are ${joinList([...deals.map((n) => `${n} (deals)`), ...others])}.`
    : '';
  return prose
    .replace(DENIAL_SENTENCE, ` ${truth} `)
    .replace(PIPELINE_ENUMERATION, `${enumeration} `)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,])/g, '$1')
    .trim();
}

const CURRENCY_CLAIM = /(^|\n)[^\n]*?\bScoped to the [A-Za-z]{3} book\b[^\n]*(\n|$)/;

/**
 * The engine's claim about which book a figure is in, dropped when the figure
 * contradicts it.
 *
 * "What is closed-won bookings in EUR this year?" answers `$2,443,640` and
 * then writes "Scoped to the EUR book, which is the currency you named — the
 * other books are not in this figure." The banner above already says the
 * opposite. Printing a claim and its refutation in one card leaves the reader
 * to pick, which is not a choice a reader can make.
 */
export function withoutCurrencyClaim(prose: string): string {
  return prose.replace(CURRENCY_CLAIM, '\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

const WRITES_PARAMETER = /Send\s+`?allow_writes:?\s*true`?[^.]*\./i;

/**
 * The refusal that tells a sales lead to send an API parameter.
 *
 * "I changed nothing… Send `allow_writes: true` and I will prepare it for your
 * approval." The thing they need is the switch under the box, which has a name
 * and is six inches away.
 */
export function withoutWriteParameter(prose: string): string {
  if (!WRITES_PARAMETER.test(prose)) return prose;
  return prose.replace(
    WRITES_PARAMETER,
    'Turn on \u201cLet it prepare writes\u201d under the message box and ask again \u2014 it will be prepared for your approval, and nothing is written until you approve it.',
  );
}

const ONE_PLURAL = /\b1 ([a-z][a-z-]*) (were|are|have)\b/g;
const AGREE: Record<string, string> = { were: 'was', are: 'is', have: 'has' };

/** "1 deal were created in July 2026." — count agreement, off the count. */
export function agreeWithTheCount(prose: string): string {
  return prose.replace(ONE_PLURAL, (whole, noun: string, verb: string) =>
    (noun.endsWith('s') ? whole : `1 ${noun} ${AGREE[verb] ?? verb}`));
}

/**
 * Every correction this surface makes to the engine's own sentences.
 *
 * Each one is a statement the same card contradicts elsewhere. Correcting a
 * sentence is a heavier thing than adding a banner beside it, so the list is
 * short and every entry is a fact this file can prove from what the engine
 * itself published — the glyph on its figure, the workspace's own pipelines,
 * the parameter name in its own refusal.
 */
export function correctedProse(
  prose: string,
  o: { verdicts: QualifierVerdict[]; denied: VocabOtherPipeline | null; vocab: Vocabulary },
): string {
  let out = prose;
  if (o.denied) out = correctPipelineDenial(out, o.denied, o.vocab);
  if (o.verdicts.some((v) => v.kind === 'currency' && v.state !== 'bound')) out = withoutCurrencyClaim(out);
  out = withoutWriteParameter(out);
  return agreeWithTheCount(out);
}

/* ------------------------------ reconciliation ---------------------------- */

/**
 * What became of one qualifier, in this surface's words.
 *
 * `unchecked` is the honest fifth state and the reason the other four can be
 * trusted. A kind this file has no rule for used to fall through a `default:`
 * that returned `unbound` — a confident claim that the figure counted
 * everything, printed over answers that had narrowed perfectly well. Saying
 * "this was not checked" is the only true thing to say there, and it keeps the
 * red banner for the dimensions that really were dropped.
 */
export type QualifierState = 'bound' | 'unbound' | 'substituted' | 'waived' | 'unchecked';

export interface QualifierVerdict {
  kind: QualifierKind;
  /** What the question asked to narrow to. */
  asked: string;
  state: QualifierState;
  /** What the query used on this dimension instead, in plain words. */
  used: string;
  /** The tool whose figure the answer quotes. */
  tool: string | null;
  /** The CRM's name for the dimension, where it is not the kind's own name. */
  dimension?: string;
}

export interface ScopeReport {
  measurements: Measurement[];
  /** The measurements whose figures the prose quotes. */
  answering: Measurement[];
  verdicts: QualifierVerdict[];
  /** Every named qualifier the answer did not narrow to. */
  unscoped: QualifierVerdict[];
  /** Qualifiers this surface can neither confirm nor contradict — never a warning. */
  unchecked: QualifierVerdict[];
  /** The id → name lookup the report was built with, so chips can use it too. */
  resolve: (id: string) => string | null;
}

/**
 * A measure the question named that this answer never computed.
 *
 * Not the same statement as "it measured something else": `account_profile`
 * measures nothing at all, and a CSAT question answered with a company card is
 * an answer with no figure in it wearing "question read at 98%".
 */
export const UNMEASURED = 'not measured at all';

/** A counting question answered in money. */
export const MONEY_TOTAL = 'a money total';

const DURATION_WORDS = new Set(['day', 'hour', 'minute', 'week', 'month', 'year']);

/**
 * Whether a printed figure is denominated the way a measure is.
 *
 * The client cannot recompute a metric, and does not try. It can read the
 * glyph: an Outstanding balance is money, a Win rate is a percentage, an
 * Average sales cycle is days. `9 records` is none of those, and neither is a
 * step that printed no figure at all.
 */
export function figureSpeaks(figure: string | null, unit: string): boolean {
  if (!figure) return false;
  const money = currenciesOfFigure(figure).length > 0;
  switch (unit) {
    case 'money': return money;
    case 'percent': return figure.includes('%');
    case 'days': case 'hours': case 'minutes':
      return figureUnits(figure).some((word) => DURATION_WORDS.has(word));
    default: return !money && /\d/.test(figure);
  }
}

export const WIDE_SCOPE: Record<QualifierKind, string> = {
  pipeline: 'every pipeline',
  stage: 'every stage',
  owner: 'every owner',
  period: 'with no reporting period',
  status: 'every status',
  metric: 'a different measure',
  currency: 'every book at once',
  account: 'every account',
  unit: 'every unit',
  meter: 'every meter',
  object: 'a different kind of record',
  group: 'one total, not broken down',
  limit: 'every row, uncut',
  property: 'every value of it',
};

export interface ReconcileInput {
  question: string;
  prose: string;
  toolCalls: ToolCallLike[];
  reasoning: string[];
  vocab: Vocabulary;
  /** Turns a record id the engine bound into the name a reader knows it by. */
  resolveId?: (id: string) => string | null;
}

/**
 * The question's qualifiers against the scope the quoted figure was measured at.
 *
 * `substituted` is the worst of the three and the reason this exists: the query
 * did narrow on that dimension, to something else. An owner question answered
 * with one company's pipeline is not a wider answer than was asked for, it is a
 * different answer, and it reads as the right one.
 */
export function reconcileScope(input: ReconcileInput): ScopeReport {
  const measurements = measurementsOf(input.toolCalls, input.reasoning, input.vocab);
  const answering = answeringMeasurements(measurements, input.prose);
  const named = namedQualifiers(input.question, input.vocab);
  const ledger = parseLedger(input.reasoning);
  const evidence: Evidence = { prose: input.prose };
  const resolve = resolver(input.resolveId, ledger);
  const verdicts: QualifierVerdict[] = [];
  const claimed = new Set<LedgerEntry>();

  for (const qualifier of named) {
    const entry = ledgerFor(qualifier, ledger, claimed);
    const verdict = entry
      ? againstLedger(qualifier, entry, measurements, answering, input.vocab, resolve, evidence)
      : verdictFor(qualifier, answering, input.vocab, resolve, evidence);
    if (verdict) verdicts.push(verdict);
  }

  // A qualifier the engine did not bind counts even where the question's own
  // words did not match this workspace's vocabulary: the engine parsed it, and
  // then said out loud that it did not use it.
  //
  // `pending` belongs here as much as `waived` does. The engine's own comment
  // beside the line that writes this ledger says a pending entry in a finished
  // run "is the state this whole mechanism says cannot exist" — and it exists,
  // because `unit` is the one kind exempted from the refusal that would have
  // settled it. Reading only two of the three states is how `unit "event"
  // pending` reached a reader as nothing at all.
  for (const entry of ledger) {
    if (!answering.length) break;
    if (claimed.has(entry) || entry.state === 'bound') continue;
    const qualifier: NamedQualifier = {
      kind: entry.kind, text: entry.text, label: entry.text, value: null,
      ...(entry.dimension ? { dimension: entry.dimension } : {}),
    };
    // Checked, not assumed, in both directions: an engine that says it dropped
    // the unit while printing every figure in that unit has honoured it, and a
    // red banner over that answer is the same lie pointing the other way. Only
    // a positive finding overturns the engine's own word, though — "I could not
    // check this" is not evidence that a waived qualifier was honoured after
    // all, and treating it as such is how a warning goes quiet by accident.
    const checked = verdictFor(qualifier, answering, input.vocab, resolve, evidence);
    const overturned = checked && (checked.state === 'bound' || checked.state === 'substituted');
    verdicts.push(overturned
      ? { ...checked, asked: entry.text, tool: entry.tool ?? checked.tool }
      : {
          kind: entry.kind,
          asked: entry.text,
          ...(entry.dimension ? { dimension: entry.dimension } : {}),
          // `pending` is the engine never getting to an answer about this
          // dimension; `waived` and `refused` are it deciding not to use one.
          state: entry.state === 'pending' ? (checked?.state ?? 'unbound') : 'waived',
          used: checked && checked.state !== 'unchecked' ? checked.used : WIDE_SCOPE[entry.kind],
          tool: entry.tool,
        });
  }

  // A question that named one record, answered for the record above it.
  //
  // Nothing in the arguments can catch this: `subject_id: "cmp_nw_44"` is a
  // perfectly bound account filter, and the engine's ledger says `account
  // "Sakamoto Seiki" bound` in so many words. The contradiction is between the
  // record's name and the phrase the question used — the question carried a
  // deal name and the answer carried the account's — and that comparison is
  // the only place it exists.
  if (!verdicts.some((verdict) => verdict.kind === 'account')) {
    for (const measurement of answering) {
      const subject = measurement.scope.subjectId;
      const name = subject ? resolve(subject) : null;
      if (!name || looksLikeRecordId(name)) continue;
      const mismatch = recordPhraseMismatch(input.question, name);
      if (!mismatch) continue;
      verdicts.push({
        kind: 'account', asked: mismatch.asked, state: 'substituted', used: mismatch.used, tool: measurement.tool,
      });
      break;
    }
  }

  // An answer measured over the wrong kind of record has one thing wrong with
  // it, and saying "this figure counts every deal status" about seven support
  // tickets is a third sentence about a filter on records nobody asked for.
  //
  // The same holds for an answer nobody asked about deals at all: "How many
  // open tickets do we have?" is answered by a ticket search, and "open" in it
  // is the name of the measure, not a deal status. That reached the reader as a
  // red "You asked about open deals. This figure counts every status." over a
  // correct ticket count — the cry-wolf half of the defect this file exists for.
  const wrongObject = verdicts.some((v) => v.kind === 'object' && v.state === 'substituted');
  const measuredType = answering.map((m) => m.scope.objectType).find((type) => !!type) ?? null;
  const kept = wrongObject || (measuredType !== null && measuredType !== 'deal')
    ? verdicts.filter((v) => v.state === 'bound' || !DEAL_DIMENSIONS.includes(v.kind))
    : verdicts;

  return {
    measurements,
    answering,
    verdicts: kept,
    unscoped: kept.filter((v) => v.state !== 'bound' && v.state !== 'unchecked'),
    unchecked: kept.filter((v) => v.state === 'unchecked'),
    resolve,
  };
}

/**
 * A record id turned into the name a reader knows it by, or into nothing.
 *
 * `credits.balance` is called with `customer: "cus_dgqX6o9tM1BGxIWi"` and the
 * answer cites the company, not the billing customer — so the one chip on that
 * answer read `ACCOUNT cus_dgqX6o9tM1BGxIWi`, which is a database id where the
 * scope of a money figure should be. The engine already published the name in
 * its own ledger (`account "Meridian Forge Systems" bound`), so when exactly
 * one account is on that ledger there is no guessing to do.
 */
const RECORD_ID = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_]{3,}$/;

export const looksLikeRecordId = (value: string): boolean => RECORD_ID.test(value.trim());

/**
 * The id prefixes that name an account. A teammate id is deliberately not one
 * of them: naming `usr_seed02` after the single account on the ledger would
 * swap one record for another, which is the defect, not the repair.
 */
const ACCOUNT_PREFIX = new Set(['cus', 'cust', 'cmp', 'com', 'acct', 'org']);

function resolver(
  given: ((id: string) => string | null) | undefined,
  ledger: LedgerEntry[],
): (id: string) => string | null {
  const accounts = [...new Set(ledger.filter((e) => e.kind === 'account' && e.state === 'bound').map((e) => e.text))];
  return (id: string) => {
    const named = given?.(id) ?? null;
    if (named && !looksLikeRecordId(named)) return named;
    const isAccount = looksLikeRecordId(id) && ACCOUNT_PREFIX.has(id.split('_')[0]);
    if (accounts.length === 1 && isAccount) return accounts[0];
    return named;
  };
}

/** Dimensions that only mean anything on a deal. */
const DEAL_DIMENSIONS: QualifierKind[] = ['pipeline', 'stage', 'status'];

const ledgerFor = (
  qualifier: NamedQualifier,
  ledger: LedgerEntry[],
  claimed: Set<LedgerEntry>,
): LedgerEntry | null => {
  const sameKind = ledger.filter((entry) => entry.kind === qualifier.kind && !claimed.has(entry));
  const wanted = norm(qualifier.text);
  const entry = sameKind.find((row) => norm(row.text).includes(wanted) || wanted.includes(norm(row.text)))
    ?? sameKind[0]
    ?? null;
  if (entry) claimed.add(entry);
  return entry;
};

/**
 * The answer as it was printed, which is the only unit evidence a client has.
 *
 * A metered figure carries its unit in the text — `97,205,652 events`,
 * `153 days`, `5 of 51 seats` — and a money figure carries a glyph instead.
 * That is enough to tell a credit balance answered in events from the same
 * balance answered as "$0.00 available", which is the substitution the billing
 * screens shipped and this one must never repeat.
 */
export interface Evidence { prose: string }

const UNIT_WORD = /(\d[\d,.]*)\s+([A-Za-z][A-Za-z-]{2,})/g;

/** Every unit word attached to a number in a piece of text, singular and lower-cased. */
export function figureUnits(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(UNIT_WORD)) {
    const word = singularOf(match[2].toLowerCase());
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

const singularOf = (word: string): string =>
  word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('ses') ? word.slice(0, -2)
    : word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;

/**
 * The engine's claim about one qualifier, checked against the query it names.
 *
 * `bound → record_aggregate` is accepted only when that call's arguments really
 * carry the value. The engine has written `bound` over a query with no such
 * filter before — that is the whole defect — so the claim is evidence, not
 * proof, and where it is unsupported the surface says exactly that.
 */
function againstLedger(
  qualifier: NamedQualifier,
  entry: LedgerEntry,
  measurements: Measurement[],
  answering: Measurement[],
  vocab: Vocabulary,
  resolve: (id: string) => string | null,
  evidence: Evidence,
): QualifierVerdict | null {
  // Nothing was measured, so there is no scope to be wrong about: a refusal
  // says what it could not do in its own banner.
  if (!answering.length) return null;
  const fallback = verdictFor(qualifier, answering, vocab, resolve, evidence);

  if (entry.state !== 'bound') {
    // The engine's own account of a qualifier it did not settle, checked the
    // same way its `bound` is: an answer whose every figure is denominated in
    // the unit it says it dropped did narrow to it, whatever the ledger says.
    if (fallback && fallback.state === 'bound') return fallback;
    return {
      kind: qualifier.kind,
      asked: qualifier.label,
      state: entry.state === 'pending' ? (fallback?.state ?? 'unbound') : 'waived',
      used: fallback?.used ?? WIDE_SCOPE[qualifier.kind],
      tool: entry.tool ?? fallback?.tool ?? null,
    };
  }

  // Reading the arguments is a second chance to confirm the claim, never a veto
  // over one this file's own rules already recognise: `deal_stage in
  // (closed_lost)` is the lost status without the word "lost" appearing in it.
  if (fallback?.state === 'bound') return fallback;

  // The period is timestamps by the time it reaches a tool, so there is nothing
  // to string-match; its own rules already read the window and the metric.
  //
  // The currency is here for the opposite reason: `currency: "eur"` really is in
  // the arguments, the engine really does write `currency "eur" bound`, and the
  // figure that comes back is the same `$9,148,979` as the unscoped question.
  // An argument that changed nothing is not a binding, so the printed figure —
  // which its own rule reads — decides this one, not the ledger.
  if (qualifier.kind === 'period' || qualifier.kind === 'metric' || qualifier.kind === 'currency'
    || qualifier.kind === 'unit') return fallback;

  const calls = measurements.filter((m) => !entry.tool || m.tool === entry.tool);
  const needles = [qualifier.value ?? '', qualifier.text, qualifier.label];
  const supported = (calls.length ? calls : measurements).some((m) => argsMention(m.args, needles));
  if (supported) return { kind: qualifier.kind, asked: qualifier.label, state: 'bound', used: qualifier.label, tool: entry.tool };

  return {
    kind: qualifier.kind,
    asked: qualifier.label,
    state: fallback?.state === 'substituted' ? 'substituted' : 'unbound',
    used: fallback?.used ?? WIDE_SCOPE[qualifier.kind],
    tool: entry.tool ?? fallback?.tool ?? null,
  };
}

function verdictFor(
  qualifier: NamedQualifier,
  answering: Measurement[],
  vocab: Vocabulary,
  resolve: (id: string) => string | null,
  evidence: Evidence,
): QualifierVerdict | null {
  if (!answering.length) return null;
  // With several quoted figures, the qualifier only counts as honoured when
  // every one of them narrowed to it. A dimension one step bound is still bound
  // for this answer, though — which is what lets a credit balance read by one
  // step and named by another state the account it was scoped to.
  const states = answering.map((m) => stateOf(qualifier, m, vocab, resolve, evidence));
  const bound = states.find((s) => s.state === 'bound');
  const worst = states.find((s) => s.state === 'substituted')
    ?? (bound ?? states.find((s) => s.state === 'unbound'))
    ?? states[0];
  const tool = answering[states.indexOf(worst)]?.tool ?? null;
  return {
    kind: qualifier.kind,
    asked: qualifier.label,
    state: worst.state,
    used: worst.used,
    tool,
    ...(qualifier.dimension ? { dimension: qualifier.dimension } : {}),
  };
}

function stateOf(
  qualifier: NamedQualifier,
  measurement: Measurement,
  vocab: Vocabulary,
  resolve: (id: string) => string | null,
  evidence: Evidence,
): { state: QualifierState; used: string } {
  const scope = measurement.scope;
  const wide = WIDE_SCOPE[qualifier.kind];
  switch (qualifier.kind) {
    case 'pipeline': {
      if (!scope.pipeline) {
        // A stage filter naming stages of exactly one pipeline is a pipeline
        // filter in everything but name, and the engine does write those.
        const owners = pipelinesBehind(scope.stages, vocab);
        if (owners.length === 1) {
          return owners[0] === qualifier.value
            ? { state: 'bound', used: labelOfPipeline(owners[0], vocab) }
            : { state: 'substituted', used: labelOfPipeline(owners[0], vocab) };
        }
        if (scope.subjectId) return { state: 'substituted', used: resolve(scope.subjectId) ?? scope.subjectId };
        return { state: 'unbound', used: wide };
      }
      return scope.pipeline === qualifier.value
        ? { state: 'bound', used: labelOfPipeline(scope.pipeline, vocab) }
        : { state: 'substituted', used: labelOfPipeline(scope.pipeline, vocab) };
    }
    case 'stage': {
      if (!scope.stages.length) {
        if (scope.status) return { state: 'substituted', used: `every ${scope.status} deal` };
        return { state: 'unbound', used: wide };
      }
      if (scope.stages.includes(qualifier.value ?? '')) {
        return scope.stages.length === 1
          ? { state: 'bound', used: labelOfStage(scope.stages[0], scope.pipeline, vocab) }
          : { state: 'substituted', used: `${scope.stages.length} stages together` };
      }
      return { state: 'substituted', used: scope.stages.map((s) => labelOfStage(s, scope.pipeline, vocab)).join(', ') };
    }
    case 'owner': {
      if (!scope.ownerId) {
        if (scope.subjectId) return { state: 'substituted', used: resolve(scope.subjectId) ?? scope.subjectId };
        return { state: 'unbound', used: wide };
      }
      return scope.ownerId === qualifier.value
        ? { state: 'bound', used: qualifier.label }
        : { state: 'substituted', used: resolve(scope.ownerId) ?? scope.ownerId };
    }
    case 'period': {
      const measure = scope.metric ? vocab.metrics.find((m) => m.id === scope.metric) : undefined;
      // A snapshot metric — open pipeline, outstanding balance, deal count — is
      // measured as of now and ignores whatever window it was handed, so it did
      // not answer over the period the question named however the args read.
      if (measure?.snapshot) return { state: 'unbound', used: 'as of now' };
      if (!scope.window) return { state: 'unbound', used: wide };
      return { state: 'bound', used: scope.window.label ?? 'the dates it was given' };
    }
    case 'status': {
      // A metric can carry the status in its own definition: `pipeline` is
      // "Open pipeline" and `closed_lost` is "Closed-lost value", so an answer
      // computed from one of those is already narrowed to that status and
      // saying otherwise would be a warning about nothing.
      const fromMetric = scope.metric
        ? vocab.metrics.find((m) => m.id === scope.metric)
        : undefined;
      if (fromMetric && hasPhrase(norm(fromMetric.label), qualifier.value ?? '')) {
        return { state: 'bound', used: fromMetric.label };
      }
      if (!scope.status) return { state: 'unbound', used: wide };
      return scope.status === qualifier.value
        ? { state: 'bound', used: `${scope.status} deals` }
        : { state: 'substituted', used: `${scope.status} deals` };
    }
    case 'metric': {
      // A measure this catalogue does not define — "pipeline velocity" — is
      // never honoured by a metric that is in it, however close the words are.
      if (qualifier.value === null) {
        // Only a run that named a measure out of the catalogue can have
        // substituted one. A record search carries no measure to contradict,
        // and calling its list of deals "a different measure" is a warning
        // about nothing.
        const ran = scope.metric ? vocab.metrics.find((m) => m.id === scope.metric) : undefined;
        return scope.metric
          ? { state: 'substituted', used: ran?.label ?? humanizeName(scope.metric) }
          : { state: 'bound', used: qualifier.label };
      }
      if (!scope.metric) {
        // A tool with no metric argument may still have measured the thing —
        // `record_aggregate` summing `amount` over one pipeline *is* open
        // pipeline — so the test is the denomination of the figure it printed,
        // the same evidence the currency and unit rules turn on. A money
        // measure answered with a list of records, and a score answered with a
        // company card, were both being reported as honoured: the engine's own
        // notes read `Metric: Customer satisfaction (matched "CSAT")` and then
        // `account "Meridian Forge Systems" → pending`, recognised and dropped.
        const measure = vocab.metrics.find((m) => m.id === qualifier.value);
        if (measure && !figureSpeaks(measurement.figure, measure.unit)) {
          return { state: 'unbound', used: UNMEASURED };
        }
        return { state: 'bound', used: qualifier.label };
      }
      if (scope.metric === qualifier.value) return { state: 'bound', used: qualifier.label };
      const used = vocab.metrics.find((m) => m.id === scope.metric);
      return { state: 'substituted', used: used?.label ?? humanizeName(scope.metric) };
    }
    case 'currency': {
      // The only currency evidence a client has that costs nothing: the glyph
      // the engine printed its own figure with.
      const books = currenciesOfFigure(measurement.figure);
      const printed = books.length === 1 ? books[0] : null;
      const bound = scope.currency ? scope.currency.toLowerCase() : null;
      if (books.length > 1) {
        return books.includes(qualifier.value ?? '')
          ? { state: 'substituted', used: `${books.map((b) => b.toUpperCase()).join(', ')} together` }
          : { state: 'substituted', used: books.map((b) => b.toUpperCase()).join(', ') };
      }
      if (printed && printed !== qualifier.value) return { state: 'substituted', used: printed.toUpperCase() };
      if (printed && printed === qualifier.value) return { state: 'bound', used: printed.toUpperCase() };
      if (bound) {
        return bound === qualifier.value
          ? { state: 'bound', used: bound.toUpperCase() }
          : { state: 'substituted', used: bound.toUpperCase() };
      }
      return { state: 'unbound', used: wide };
    }
    case 'object': {
      if (scope.objectType && scope.objectType !== qualifier.value) {
        return { state: 'substituted', used: pluralOf(humanizeName(scope.objectType).toLowerCase()) };
      }
      // "How many companies are in the Renewal pipeline?" came back as
      // "$1,463,440 … from 6 open deals": a money total counts no companies,
      // whatever record type the query underneath it ran over, and the answer
      // to a counting question has to be a count.
      if (qualifier.frame === 'count' && currenciesOfFigure(measurement.figure).length) {
        return { state: 'substituted', used: MONEY_TOTAL };
      }
      return { state: 'bound', used: qualifier.label };
    }
    case 'group': {
      if (!scope.groupBy) {
        // "Which stage has the most open pipeline?" comes back as a top-10
        // list of individual deals. Captioning that "one total, not broken
        // down" is wrong in the other direction — there is no total either,
        // there are rows — and the chip said so next to a body listing eight.
        return { state: 'unbound', used: cutsRows(scope) ? 'a list of records, not a ranking' : wide };
      }
      if (scope.groupBy === qualifier.value) return { state: 'bound', used: qualifier.label };
      return { state: 'substituted', used: `${humanizeName(scope.groupBy).toLowerCase()}` };
    }
    case 'property': {
      // The only evidence there is: whether the value the question named is
      // anywhere in the arguments the query ran with. `lead_source =
      // trade_show` is; a metric over every deal in the workspace is not.
      const needles = [qualifier.value ?? '', qualifier.text, qualifier.label];
      if (argsMention(measurement.args, needles)) return { state: 'bound', used: qualifier.label };
      const dimension = qualifier.dimension ? `every ${qualifier.dimension.toLowerCase()}` : wide;
      return { state: 'unbound', used: dimension };
    }
    case 'account': {
      if (!scope.subjectId) return { state: 'unbound', used: wide };
      const name = resolve(scope.subjectId) ?? scope.subjectId;
      return norm(name) === norm(qualifier.label) || norm(name) === norm(qualifier.text)
        ? { state: 'bound', used: name }
        : { state: 'substituted', used: name };
    }
    case 'unit': {
      // A count of things is denominated in the thing. The engine prints that
      // denomination in its own figure — `9,131.22 events available` — so the
      // question "how many events" answered `$0.00 available` contradicts
      // itself on screen, and this is where that is caught. It is the same
      // check the currency rule makes, on the other half of the glyph.
      const asked = singularOf(norm(qualifier.value ?? qualifier.text));
      if (!asked) return { state: 'unchecked', used: wide };
      // The step's own figure first; the prose only when that figure carries no
      // denomination at all, which is every step that answers in a payload
      // rather than in one number — a credit balance, an entitlement set.
      const carried = (text: string) => ({ units: figureUnits(text), books: currenciesOfFigure(text) });
      const own = carried(measurement.figure ?? '');
      const printed = own.units.length || own.books.length ? own : carried(evidence.prose);
      if (printed.units.includes(asked)) return { state: 'bound', used: pluralOf(asked) };
      if (printed.books.length) {
        const books = [...new Set(printed.books)].map((b) => b.toUpperCase()).join(', ');
        return { state: 'substituted', used: `money in ${books}` };
      }
      // A bare number is not evidence either way: `7` is seven of whatever the
      // step counted, and naming some other unit off a stray word in the prose
      // would be a guess wearing the same confidence as the check above.
      return { state: 'unchecked', used: wide };
    }
    case 'meter': {
      // A meter arrives as an id (`mtr_nw_telemetry`) and is named in words
      // ("Telemetry events"), so the arguments are the only place it can be
      // confirmed — `againstLedger` reads those. Nothing here can add to that,
      // and saying "every meter" over a figure that named one would be the
      // false claim the `default:` used to make for every kind without a rule.
      return { state: 'unchecked', used: wide };
    }
    case 'limit': {
      // An argument that changed nothing is not a binding — the same rule the
      // currency case turns on the printed glyph. `business_metric` is handed
      // `limit: 2` and `group_by: "none"` on the very run the engine settles as
      // `limit "2" waived`: there is one total, and a cut-off over one row cuts
      // nothing. Rows to cut is the test, not the presence of the argument.
      if (scope.limit === null || !cutsRows(scope)) return { state: 'unbound', used: wide };
      const asked = Number(qualifier.value ?? qualifier.text.replace(/[^\d]/g, ''));
      if (!Number.isFinite(asked) || asked === 0) return { state: 'bound', used: `top ${scope.limit}` };
      return scope.limit === asked
        ? { state: 'bound', used: `top ${scope.limit}` }
        : { state: 'substituted', used: `top ${scope.limit}` };
    }
    default:
      // Unreachable while every kind above has a case of its own, and proved so
      // at compile time: `qualifier.kind` is `never` here, so a kind added to
      // `QualifierKind` without a rule fails the build rather than falling
      // through into a confident "unbound" it cannot support. That fall-through
      // is what put "this figure counts every unit" over answers denominated in
      // exactly the unit that was asked for.
      return exhausted(qualifier.kind, { state: 'unchecked', used: wide });
  }
}

/** Compiles only while every `QualifierKind` has been handled before it. */
const exhausted = <T>(_kind: never, fallback: T): T => fallback;

/**
 * "company" → "companies", not "companys".
 *
 * The design system's own rule, restated here for the same reason `humanizeName`
 * is: that module pulls in React, and this one has to load in a plain test.
 */
const IRREGULAR_PLURAL: Record<string, string> = { company: 'companies', person: 'people', activity: 'activities' };

export const pluralOf = (word: string): string => {
  if (IRREGULAR_PLURAL[word]) return IRREGULAR_PLURAL[word];
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
};

const pipelinesBehind = (stages: string[], vocab: Vocabulary): string[] => {
  if (!stages.length) return [];
  const owners = new Set<string>();
  for (const pipeline of vocab.pipelines) {
    if (pipeline.stages.some((stage) => stages.includes(stage.name))) owners.add(pipeline.name);
  }
  return [...owners];
};

export const labelOfPipeline = (name: string, vocab: Vocabulary): string =>
  vocab.pipelines.find((p) => p.name === name)?.label ?? humanizeName(name);

export const labelOfStage = (name: string, pipeline: string | null, vocab: Vocabulary): string => {
  const stages = vocab.pipelines.flatMap((p) => p.stages).filter((s) => s.name === name && (!pipeline || s.pipeline === pipeline));
  const labels = [...new Set(stages.map((s) => s.label))];
  return labels.length === 1 ? labels[0] : humanizeName(name);
};

/**
 * The same question in the words this engine answers.
 *
 * Three phrasings of the single most common pipeline-review question get three
 * different wrong outcomes. "Which owner has the most open pipeline?" is
 * refused with "You asked about the status 'open pipeline', and I could not
 * apply it to anything I can measure" — which is false, that measure is
 * computed constantly. "Break open pipeline down by owner." is refused because
 * the verb "break" is read as a measure. And "Open pipeline by owner" answers
 * perfectly, with the correct breakdown.
 *
 * The client cannot make the engine parse the first two. It can read the
 * dimension and the measure out of them — it already does, for the scope bar —
 * and hand back the third, as one press. A refusal that ends in a full stop is
 * a dead end.
 */
export function rephraseAsBreakdown(question: string, vocab: Vocabulary): string | null {
  const text = norm(question);
  const group = groupAsked(text);
  if (!group) return null;
  // The dimension has spent that word, exactly as `namedQualifiers` spends it:
  // otherwise "which account has the most spend" matches the Customers metric
  // on the word "account" and suggests measuring the wrong thing.
  const metric = metricAsked(text, vocab, new Set([norm(group.noun)]));
  if (!metric) return null;
  const rephrased = `${metric.metric.label} by ${group.label}`;
  return norm(rephrased) === text ? null : rephrased;
}

/**
 * The board, narrowed to what the question named.
 *
 * The engine refuses time-in-stage and win-rate-per-owner, and answers a
 * pipeline question over every pipeline — and the deal board one screen away
 * draws the per-stage medians, the per-owner filter and each column's own
 * total. A refusal that ends in a full stop is a dead end; a refusal that hands
 * over the screen where the figure exists is not.
 */
export function boardHref(question: string, vocab: Vocabulary): { href: string; label: string } | null {
  const named = namedQualifiers(question, vocab);
  const pipeline = named.find((q) => q.kind === 'pipeline' && q.value);
  const owner = named.find((q) => q.kind === 'owner' && q.value);
  if (!pipeline && !owner) return null;
  const params: string[] = [];
  if (pipeline?.value) params.push(`pipeline=${encodeURIComponent(pipeline.value)}`);
  if (owner?.value) params.push(`owner=${encodeURIComponent(owner.value)}`);
  const both = pipeline && owner;
  return {
    href: `/deals?${params.join('&')}`,
    label: both ? `${pipeline.label} · ${owner.label}` : (pipeline?.label ?? owner?.label ?? ''),
  };
}

/* ------------------------------- the warning ------------------------------ */

/**
 * One sentence per dimension, in the reader's own terms, for the banner.
 *
 * It lives here rather than beside the banner it fills so that a kind added to
 * `QualifierKind` cannot reach the screen without one: the map is exhaustive by
 * type, and `tests/pipeline.test.ts` walks every kind in every state that can
 * reach a reader and fails on a sentence that comes back empty.
 */
const SENTENCE: Record<QualifierKind, (v: QualifierVerdict) => string> = {
  pipeline: (v) => v.state === 'substituted'
    ? `You asked about the ${v.asked} pipeline. This figure was measured over ${v.used} instead.`
    : `You asked about the ${v.asked} pipeline. This figure was measured over ${v.used} — every deal in the workspace, not ${v.asked}’s.`,
  stage: (v) => v.state === 'substituted'
    ? `You asked about ${v.asked}. This figure was measured over ${v.used} instead.`
    : `You asked about ${v.asked}. This figure counts ${v.used} — it is not the ${v.asked} figure.`,
  owner: (v) => v.state === 'substituted'
    ? `You asked about ${v.asked}. This figure was measured for ${v.used} — a different record, not ${v.asked}’s book.`
    : `You asked about ${v.asked}. This figure covers ${v.used}, not the records ${v.asked} owns.`,
  period: (v) => v.state === 'bound'
    ? `You named ${v.asked}. This figure was measured over ${v.used}.`
    : `You named ${v.asked}. This figure was measured ${v.used}, not over ${v.asked}.`,
  status: (v) => `You asked about ${v.asked.toLowerCase()}. This figure counts ${v.used}.`,
  metric: (v) => (v.state === 'substituted'
    ? `You asked for ${v.asked}. This figure is ${v.used}, which is a different measure.`
    : v.used === UNMEASURED
      ? `You asked for ${v.asked}. Nothing in this answer measured it${v.tool ? ` — ${v.tool} computes no measure` : ''}.`
      : `You asked for ${v.asked}. Nothing in this workspace’s metric catalogue is that measure, and the figure below is ${v.used}.`),
  currency: (v) => (v.state === 'substituted'
    ? `You asked for the ${v.asked} book. This figure is in ${v.used} — it is not the ${v.asked} figure.`
    : `You asked for the ${v.asked} book. This figure was not scoped to a currency: it is ${v.used}.`),
  account: (v) => (v.state === 'substituted'
    ? isWiderName(v.asked, v.used)
      ? `You named ${v.asked}. This figure was measured over the whole of ${v.used} — every record on that account, not the one you named.`
      : `You asked about ${v.asked}. This figure was measured for ${v.used}.`
    : `You asked about ${v.asked}. This figure covers ${v.used}.`),
  unit: (v) => (v.state === 'substituted'
    ? `You asked for ${pluralOf(singularOf(v.asked))}. This figure is in ${v.used}, which is not a count of ${pluralOf(singularOf(v.asked))}.`
    : `You asked for ${pluralOf(singularOf(v.asked))}. This figure was not scoped to that unit — it counts ${v.used}.`),
  meter: (v) => `You named the ${v.asked} meter. This figure was not scoped to it — it counts ${v.used}.`,
  // The engine's own words for this one are "the answer is not cut to the
  // number you named", and it says them in a line of prose above a figure. A
  // reader who quotes "our top 2" out of a workspace total has been misled by
  // the shape of the answer, not by its arithmetic.
  limit: (v) => (v.state === 'substituted'
    ? `You asked for the top ${v.asked}. This answer was cut to ${v.used} instead.`
    : `You asked for the top ${v.asked}. This answer was not cut to it — the figure below counts every row the query found.`),
  object: (v) => (v.state === 'substituted'
    ? v.used === MONEY_TOTAL
      ? `You asked how many ${v.asked} there are. This figure is ${v.used} — it counts no ${v.asked} at all.`
      : `You asked about ${v.asked}. This figure counts ${v.used}, which are not ${v.asked}.`
    : `You asked about ${v.asked}. This figure was measured over ${v.used}.`),
  group: (v) => (v.state === 'substituted'
    ? `You asked for this broken down by ${v.asked}. It came back broken down by ${v.used} instead.`
    : `You asked for this broken down by ${v.asked}. It came back as ${v.used} — nothing here ranks the ${v.asked}s.`),
  property: (v) => (v.state === 'substituted'
    ? `You asked for ${v.dimension ?? 'records'} “${v.asked}”. This figure was filtered to ${v.used} instead.`
    : `You asked for ${v.dimension ?? 'records'} “${v.asked}”. Nothing in this answer filtered on it — the figure counts ${v.used}.`),
};

/** What the banner says about one dimension the answer did not narrow to. */
export const warningSentence = (verdict: QualifierVerdict): string => SENTENCE[verdict.kind](verdict);

/* --------------------------- the scope on screen -------------------------- */

export interface ScopeChip {
  kind: QualifierKind;
  label: string;
  value: string;
  /** The query left this dimension open, and the question named it. */
  wide: boolean;
  /**
   * Drawn from a tool argument nothing has corroborated.
   *
   * A `BOOK EUR` chip pushed straight from `currency: "eur"` is the surface
   * vouching for a narrowing it never checked — over a figure printed with a
   * `$`, that chip is the lie. Where the reconciliation could not confirm the
   * dimension, the chip says so instead of stating it calmly.
   */
  unchecked?: boolean;
}

/* --------------------------- the period on screen ------------------------- */

/** Enough of a formatter to state a window, so the rule below is testable alone. */
export interface WindowFormat {
  dateRange(start: number, end: number): string;
  date(ts: number): string;
}

/**
 * The last instant a half-open window contains.
 *
 * Every window the engine passes is `[start, end)` — Q4 2026 is
 * `2026-10-01T00:00Z` to `2027-01-01T00:00Z` — so formatting `end` as a date
 * names a day the query did not measure, and formatting it in the reader's own
 * timezone names a different day again. The chip whose entire job is to state
 * truthfully what was measured read "Sep 30, 2026 – Dec 31, 2026" for Q4: a
 * start one day before the period asked for.
 */
export const lastInstantOf = (end: number): number => end - 1;

/** A window as the scope row states it: the engine's label, or its own dates. */
export function windowText(
  w: { start: number | null; end: number | null; label: string | null },
  f: WindowFormat,
): string {
  if (w.label) return w.label;
  if (w.start !== null && w.end !== null) return f.dateRange(w.start, lastInstantOf(w.end));
  if (w.start !== null) return `from ${f.date(w.start)}`;
  return `to ${f.date(lastInstantOf(w.end ?? 0))}`;
}

/** Every dimension the query narrowed to, plus the ones a question named and it did not. */
export function scopeChips(
  measurement: Measurement,
  vocab: Vocabulary,
  verdicts: QualifierVerdict[],
  o: { window: (w: { start: number | null; end: number | null; label: string | null }) => string; name: (id: string) => string },
): ScopeChip[] {
  const scope = measurement.scope;
  const chips: ScopeChip[] = [];
  const metric = scope.metric ? vocab.metrics.find((m) => m.id === scope.metric) : undefined;
  if (scope.metric) chips.push({ kind: 'metric', label: 'Measure', value: metric?.label ?? humanizeName(scope.metric), wide: false });
  // Open pipeline is a snapshot: the engine hands it a window and the metric
  // ignores it. Printing "Period Q3 2026 to date" over an answer whose own last
  // sentence says it ignores the reporting period is the surface contradicting
  // the answer it is captioning.
  if (metric?.snapshot) chips.push({ kind: 'period', label: 'As of', value: 'now', wide: false });
  else if (scope.window) chips.push({ kind: 'period', label: 'Period', value: o.window(scope.window), wide: false });
  if (scope.pipeline) chips.push({ kind: 'pipeline', label: 'Pipeline', value: labelOfPipeline(scope.pipeline, vocab), wide: false });
  if (scope.stages.length) {
    chips.push({
      kind: 'stage',
      label: scope.stages.length === 1 ? 'Stage' : 'Stages',
      value: scope.stages.map((stage) => labelOfStage(stage, scope.pipeline, vocab)).join(', '),
      wide: false,
    });
  }
  if (scope.status) chips.push({ kind: 'status', label: 'Status', value: `${scope.status} only`, wide: false });
  if (scope.ownerId) chips.push(named('owner', 'Owner', o.name(scope.ownerId)));
  if (scope.subjectId) {
    // Red when the question named a narrower record than the one that answered.
    // A calm `ACCOUNT Sakamoto Seiki` chip over $724,140 is the surface
    // vouching for a scope the question did not ask for: the deal named in it
    // is worth $402,300.
    const scoped = verdicts.find((v) => v.kind === 'account');
    const chip = named('account', 'Account', o.name(scope.subjectId));
    chips.push(scoped && scoped.state !== 'bound' && scoped.state !== 'unchecked' ? { ...chip, wide: true } : chip);
  }
  // The record type is part of the scope and used not to be drawn at all, which
  // is how "Break down open pipeline by pipeline" answered in support tickets
  // reached a reader with nothing on screen saying "tickets".
  if (scope.objectType) {
    // Red when the question was about deals and this is not: the chip is the
    // one place the reader can see, at a glance, what was counted.
    const counted = verdicts.find((v) => v.kind === 'object');
    chips.push({
      kind: 'object',
      label: 'Records',
      value: humanizeName(scope.objectType),
      wide: !!counted && counted.state !== 'bound',
    });
  }
  if (scope.groupBy) chips.push({ kind: 'group', label: 'By', value: humanizeName(scope.groupBy), wide: false });
  // The cut-off is part of the scope of a ranked answer: "the 5 largest of 77"
  // is a different statement from "77 deals", and only one of them is on the
  // screen unless this says which one the figure came from.
  if (scope.limit !== null && cutsRows(scope)) {
    chips.push({ kind: 'limit', label: 'Top', value: String(scope.limit), wide: false });
  }
  // Only a book the reconciliation confirmed is stated as one. The argument on
  // its own has been true and inert at the same time.
  if (scope.currency) {
    const verdict = verdicts.find((v) => v.kind === 'currency');
    // A book the reconciliation contradicted is left to the loop below, which
    // states in red what the figure was actually printed in.
    if (!verdict || verdict.state === 'bound') {
      chips.push({
        kind: 'currency',
        label: 'Book',
        value: scope.currency.toUpperCase(),
        wide: false,
        ...(verdict ? {} : { unchecked: true }),
      });
    }
  }

  // The dimensions the question named and the query left open are part of the
  // scope too — the widest possible part of it — so they stand in the same row
  // rather than only in the banner. A dimension this surface could not check is
  // here for the opposite reason: it makes no claim, and saying so out loud is
  // the difference between a chip that reports and a chip that vouches.
  for (const verdict of verdicts) {
    if (verdict.state === 'bound') continue;
    // Only where the row is otherwise silent on that dimension: a snapshot
    // metric already shows "As of · now", and repeating it as a red "Period ·
    // as of now" says the same thing twice in two voices.
    if (chips.some((chip) => chip.kind === verdict.kind)) continue;
    const label = verdict.dimension ?? LABEL_OF[verdict.kind];
    // A chip whose label is already the dimension does not have to spell the
    // dimension again: "Original source · every original source" says one
    // thing twice, where "Original source · not filtered" says it once.
    const value = verdict.dimension && verdict.state !== 'substituted' ? 'not filtered' : verdict.used;
    chips.push(verdict.state === 'unchecked'
      ? { kind: verdict.kind, label, value: verdict.asked, wide: false, unchecked: true }
      : { kind: verdict.kind, label, value, wide: true });
  }
  // One rule instead of three. A chip drawn from the arguments states what the
  // query used; where the reconciliation has already found that value to be the
  // wrong one, the chip is the surface vouching for it. `STATUS open only` sat
  // in calm grey beside a red banner reading "You asked about closed deals.
  // This figure counts open deals" — the same contradiction the account and
  // object chips each got a hand-written line for, on a dimension nobody had
  // written one for yet.
  const contradicted = new Set(
    verdicts.filter((v) => v.state === 'substituted' || v.state === 'unbound' || v.state === 'waived')
      .map((v) => v.kind),
  );
  return chips.map((chip) => (contradicted.has(chip.kind) && !chip.unchecked ? { ...chip, wide: true } : chip));
}

/**
 * A chip that states a record, or states that it cannot name one.
 *
 * `credits.balance` is called with a billing customer id and the answer cites
 * the company, so the single chip over that money figure read `ACCOUNT
 * cus_dgqX6o9tM1BGxIWi`. A database id is not a scope a reader can check the
 * figure against; it only looks like one, which is worse than an empty row.
 */
const named = (kind: QualifierKind, label: string, value: string): ScopeChip =>
  (looksLikeRecordId(value)
    ? { kind, label, value: 'one record, unnamed in this answer', wide: false, unchecked: true }
    : { kind, label, value, wide: false });

const LABEL_OF: Record<QualifierKind, string> = {
  pipeline: 'Pipeline',
  stage: 'Stage',
  owner: 'Owner',
  period: 'Period',
  status: 'Status',
  metric: 'Measure',
  currency: 'Book',
  account: 'Account',
  unit: 'Unit',
  meter: 'Meter',
  object: 'Records',
  group: 'By',
  limit: 'Top',
  property: 'Property',
};


/* ------------------------- the engine's own ledger ------------------------ */

/**
 * What the engine says it did with each qualifier it parsed.
 *
 * It writes one line per run — `Qualifier ledger settled: metric "pipeline"
 * bound → record_aggregate; pipeline "Renewal" bound → record_aggregate; period
 * "in August 2026" waived.` — which is the engine's own account of the thing
 * this surface exists to check. It is read, and then checked: `bound` is only
 * accepted when the query it names actually carries that value in its
 * arguments, because "I bound it" was exactly the claim that was false.
 */
export interface LedgerEntry {
  kind: QualifierKind;
  /** The words the engine matched, as it quoted them. */
  text: string;
  state: 'bound' | 'waived' | 'refused' | 'pending';
  tool: string | null;
  /** The engine's own name for a dimension this file has no kind of its own for. */
  dimension?: string;
}

const LEDGER_LINE = /^Qualifier ledger settled:\s*(.+?)\.?$/;
const LEDGER_ENTRY = /^([a-z_]+)\s+"([^"]*)"\s+(bound|waived|refused|pending)(?:\s*(?:→|->)\s*([a-z_][a-z0-9_.]*))?/i;
/**
 * Every kind the engine writes into its ledger — the server's own union, whole.
 *
 * This list is the defect, twice over. `account`, `currency`, `unit` and `meter`
 * were dropped here while the scope bar went on drawing `ACCOUNT` and `BOOK`
 * chips for two of them; then `limit` was dropped in the same way, so "What is
 * our top 2 pipeline by value?" — which the engine settles as `limit "2"
 * waived`, in those words — reached the reader as the $9,010,960 workspace
 * total under a scope row with nothing red in it at all.
 *
 * A list of kinds is exactly the per-qualifier guard this surface exists to
 * stop trusting, so it is no longer allowed to drift: `tests/pipeline.test.ts`
 * maps the server's `QualifierKind` onto this file's and fails to compile if a
 * kind is ever added there without a rule here.
 */
const LEDGER_KINDS: QualifierKind[] = [
  'pipeline', 'stage', 'owner', 'period', 'status', 'metric',
  'account', 'currency', 'unit', 'meter', 'limit',
];

export function parseLedger(reasoning: string[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of reasoning) {
    const settled = LEDGER_LINE.exec(line.trim());
    if (!settled) continue;
    for (const piece of settled[1].split(';')) {
      const match = LEDGER_ENTRY.exec(piece.trim());
      if (!match) continue;
      const written = match[1].toLowerCase();
      const kind = written as QualifierKind;
      const state = match[3].toLowerCase() as LedgerEntry['state'];
      const tool = match[4] ?? null;
      if (LEDGER_KINDS.includes(kind)) { out.push({ kind, text: match[2], state, tool }); continue; }
      // A kind this file has no rule for is not a kind to drop. Dropping is
      // what the list above did, and the cost was a refused qualifier reaching
      // the reader as nothing at all — which is the substitution this whole
      // file exists to refuse, wearing a name nobody here had typed yet.
      // `ranking` is the one deliberate exception: it is an order, not a
      // narrowing, and the answer's own rows already state it.
      if (written === 'ranking') continue;
      out.push({ kind: 'property', text: match[2], state, tool, dimension: humanizeName(written) });
    }
  }
  return out;
}

/**
 * Whether a tool call carries a value anywhere in its arguments.
 *
 * Shape-agnostic on purpose. The engine's argument names move — a stage arrived
 * as a `deal_stage` condition one week and as a plain `stage` argument the next
 * — and a reader of those arguments that only knows last week's shape reports a
 * correctly scoped answer as unscoped, which is the same lie in the other
 * direction.
 */
export function argsMention(value: unknown, needles: string[]): boolean {
  const wanted = needles.filter(Boolean).map((n) => n.toLowerCase());
  if (!wanted.length) return false;
  const walk = (node: unknown): boolean => {
    if (typeof node === 'string') return wanted.includes(node.toLowerCase());
    if (Array.isArray(node)) return node.some(walk);
    if (node && typeof node === 'object') return Object.values(node).some(walk);
    return false;
  };
  return walk(value);
}

/* ----------------------- the engine's own admissions ---------------------- */

const CARRIED = /^Unrecognised terms? carried through:\s*(.+?)\s*(?:—|--).*$/i;

/**
 * Terms the engine says it read in the question and then did not use.
 *
 * It writes this line itself — `Unrecognised terms carried through: "negotiation"
 * — answered anyway because the metric "Deals" resolved` — and most of what it
 * lists is filler ("worth", "own", "break"). The ones that are a stage, a
 * pipeline or a teammate in this workspace are not filler: they are the
 * question, dropped.
 */
export function carriedThrough(reasoning: string[], vocab: Vocabulary): NamedQualifier[] {
  const terms: string[] = [];
  for (const line of reasoning) {
    const match = CARRIED.exec(line.trim());
    if (!match) continue;
    for (const piece of match[1].split(',')) {
      const term = piece.replace(/["“”]/g, '').trim();
      if (term) terms.push(term);
    }
  }
  if (!terms.length) return [];
  const vocabulary = namedQualifiers(terms.join(' '), { ...vocab, pipelines: vocab.pipelines });
  return vocabulary.filter((q) => q.kind === 'stage' || q.kind === 'owner' || q.kind === 'currency');
}

/* ------------------------------- breakdowns ------------------------------- */

export interface BreakdownBucket { label: string; figure: string }

const BREAKDOWN = /(^|\n)Breakdown:\s*([^\n]+)/;

/** The `Breakdown: A $1 · B $2` sentence the engine appends, as buckets. */
export function parseBreakdown(prose: string): { sentence: string; buckets: BreakdownBucket[] } | null {
  const match = BREAKDOWN.exec(prose);
  if (!match) return null;
  const body = match[2].replace(/\.$/, '');
  const buckets: BreakdownBucket[] = [];
  for (const piece of body.split('·')) {
    const item = piece.trim();
    if (!item) continue;
    const split = /^(.*\S)\s+(\S+)$/.exec(item);
    if (!split) return null;
    buckets.push({ label: split[1], figure: split[2] });
  }
  return buckets.length ? { sentence: match[0].replace(/^\n/, ''), buckets } : null;
}

/** The prose with the breakdown sentence taken out of it. */
export function withoutBreakdown(prose: string): string {
  const parsed = parseBreakdown(prose);
  if (!parsed) return prose;
  return prose.replace(parsed.sentence, '').replace(/\n{3,}/g, '\n\n').trim();
}

export interface BucketVerdict {
  bucket: BreakdownBucket;
  /** The board columns this caption could mean. */
  stages: VocabStage[];
  /** More than one pipeline's column carries this stage. */
  merged: boolean;
  /** No column on the board is called this. */
  mislabelled: boolean;
  /** Nothing on the board matches at all. */
  unknown: boolean;
}

export interface BreakdownReport {
  buckets: BucketVerdict[];
  /** Open columns the board draws inside the answer's scope. */
  columnsOnBoard: number;
  reconciles: boolean;
  /**
   * Whether this breakdown is about the board's stages at all.
   *
   * The engine appends a `Breakdown:` sentence to any grouped metric — open
   * tickets by category, revenue by month — and measuring those against the
   * deal board's columns produced "Onboarding is not a column on this board at
   * all" over a correct answer about support tickets. A breakdown where not one
   * bucket names a column is a breakdown of something else.
   */
  aboutStages: boolean;
}

/**
 * Whether a by-stage breakdown means the same thing the board's columns mean.
 *
 * The board has thirteen open columns across three pipelines. The engine keys
 * its buckets on the bare stage name, so three pipelines' "negotiation" become
 * one bucket, and it captions that bucket with whichever label it met first —
 * "Qualification" over a sum that includes Expansion's "Expansion identified",
 * "Usage review" over a column the board calls "Usage & value review". Every
 * figure adds up and every caption is wrong, which is the worst way for a
 * number to be wrong.
 */
export function reconcileBreakdown(
  buckets: BreakdownBucket[],
  vocab: Vocabulary,
  pipeline: string | null,
): BreakdownReport {
  const inScope = openStagesOf(vocab, pipeline);
  const verdicts = buckets.map<BucketVerdict>((bucket) => {
    const caption = norm(bucket.label);
    // Both readings count. A bucket captioned "Qualification" is New business's
    // column *and* Expansion's `qualification`, which that pipeline calls
    // "Expansion identified" — taking the label match alone would report a
    // one-pipeline bucket over a two-pipeline sum.
    const byLabel = inScope.filter((stage) => norm(stage.label) === caption);
    const byName = inScope.filter((stage) => norm(humanizeName(stage.name)) === caption || norm(stage.name) === caption);
    const named = new Set(byName.map((stage) => stage.name));
    const stages = [...byLabel.filter((stage) => !named.has(stage.name)), ...byName];
    const pipelines = new Set(stages.map((stage) => stage.pipeline));
    return {
      bucket,
      stages,
      merged: pipelines.size > 1,
      mislabelled: stages.length > 0 && stages.some((stage) => norm(stage.label) !== caption),
      unknown: stages.length === 0,
    };
  });
  const aboutStages = verdicts.some((v) => !v.unknown);
  return {
    buckets: verdicts,
    columnsOnBoard: inScope.length,
    reconciles: verdicts.every((v) => !v.merged && !v.mislabelled && !v.unknown),
    aboutStages,
  };
}
