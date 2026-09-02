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

/** The workspace's own names for the things a question can narrow to. */
export interface Vocabulary {
  pipelines: VocabPipeline[];
  people: VocabPerson[];
  metrics: VocabMetric[];
}

export const EMPTY_VOCABULARY: Vocabulary = { pipelines: [], people: [], metrics: [] };

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
export type QualifierKind =
  | 'pipeline' | 'stage' | 'owner' | 'period' | 'status' | 'metric'
  | 'currency' | 'account' | 'unit' | 'meter'
  /** The kind of record the figure counted — deals, tickets, companies. */
  | 'object'
  /** The dimension a "break it down by…" or "which … is biggest" question asked for. */
  | 'group';

/** A filter condition as the record tools take them. */
interface Condition { property?: unknown; op?: unknown; value?: unknown; values?: unknown }

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

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
}

const EMPTY_SCOPE: BoundScope = {
  pipeline: null, stages: [], ownerId: null, subjectId: null, window: null,
  status: null, currency: null, groupBy: null, objectType: null, metric: null,
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
    subjectId: str(args.subject_id) ?? str(args.associated_to) ?? str(args.customer) ?? null,
    window: start !== null || end !== null || label ? { start, end, label } : null,
    status: status ?? null,
    currency: str(args.currency),
    groupBy: (str(args.group_by) === 'none' ? null : str(args.group_by)),
    objectType: str(args.object_type),
    metric: str(args.metric),
  };
}

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
      figure: head && FIGURE.test(head) ? head : null,
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
  return quoted.length ? quoted : withFigure;
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

/** `Break open pipeline down by pipeline` / `Which pipeline has the most open deals?` */
export function groupAsked(text: string): { value: string; label: string; text: string } | null {
  const ranking = RANKING_CUE.test(text);
  for (const dimension of GROUP_DIMENSIONS) {
    // "by customer" is a breakdown; "per customer" is a ratio, and reading it
    // as a breakdown put a warning over a correct total.
    const split = new RegExp(`\\bby\\s+(?:the\\s+|each\\s+)?${dimension.word.source}\\b`).exec(text);
    if (split) return { value: dimension.value, label: dimension.label, text: split[0] };
    if (!ranking) continue;
    const asked = new RegExp(`\\b(?:which|what)\\s+${dimension.word.source}\\b`).exec(text);
    if (asked) return { value: dimension.value, label: dimension.label, text: asked[0] };
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
  for (const stage of vocab.pipelines.flatMap((p) => p.stages)) {
    const phrase = [stage.label, humanizeName(stage.name)].find((candidate) => hasPhrase(text, candidate));
    if (!phrase || pipelineWords.includes(norm(phrase))) continue;
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

  for (const status of STATUS_WORDS) {
    if (status.word.test(text)) { add({ kind: 'status', text: status.value, label: status.label, value: status.value }); break; }
  }

  const book = currencyAsked(question);
  if (book) add({ kind: 'currency', text: book.text, label: book.code.toUpperCase(), value: book.code });

  const group = groupAsked(text);
  if (group) add({ kind: 'group', text: group.text, label: group.label, value: group.value });

  // A question that names a deal pipeline, one of its stages, or deals outright
  // is a question about deals. Which record type answered it is then a fact the
  // reader is owed: "Break down open pipeline by pipeline" is answered with
  // seven support tickets, under a banner that never says the word.
  const aboutDeals = !!cue || /(^|[^a-z])deals?([^a-z]|$)/.test(text)
    || found.some((q) => q.kind === 'pipeline' || q.kind === 'stage');
  if (aboutDeals) add({ kind: 'object', text: 'deals', label: 'deals', value: 'deal' });

  // A measure the catalogue does not define wins over the catalogue entry its
  // first word happens to match: "pipeline velocity" is not open pipeline.
  const unknown = unknownMeasure(text, vocab, consumed);
  const metric = unknown ? null : metricAsked(text, vocab, consumed);
  if (unknown) add({ kind: 'metric', text: unknown, label: humanizeName(unknown), value: null });
  else if (metric) add({ kind: 'metric', text: metric.phrase, label: metric.metric.label, value: metric.metric.id });

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

/* ------------------------------ reconciliation ---------------------------- */

export type QualifierState = 'bound' | 'unbound' | 'substituted' | 'waived';

export interface QualifierVerdict {
  kind: QualifierKind;
  /** What the question asked to narrow to. */
  asked: string;
  state: QualifierState;
  /** What the query used on this dimension instead, in plain words. */
  used: string;
  /** The tool whose figure the answer quotes. */
  tool: string | null;
}

export interface ScopeReport {
  measurements: Measurement[];
  /** The measurements whose figures the prose quotes. */
  answering: Measurement[];
  verdicts: QualifierVerdict[];
  /** Every named qualifier the answer did not narrow to. */
  unscoped: QualifierVerdict[];
  /** The id → name lookup the report was built with, so chips can use it too. */
  resolve: (id: string) => string | null;
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
  const resolve = input.resolveId ?? (() => null);
  const verdicts: QualifierVerdict[] = [];
  const claimed = new Set<LedgerEntry>();

  for (const qualifier of named) {
    const entry = ledgerFor(qualifier, ledger, claimed);
    const verdict = entry
      ? againstLedger(qualifier, entry, measurements, answering, input.vocab, resolve)
      : verdictFor(qualifier, answering, input.vocab, resolve);
    if (verdict) verdicts.push(verdict);
  }

  // A qualifier the engine says it waived counts even where the question's own
  // words did not match this workspace's vocabulary: the engine parsed it, and
  // then said out loud that it did not use it.
  for (const entry of ledger) {
    if (!answering.length) break;
    if (claimed.has(entry) || (entry.state !== 'waived' && entry.state !== 'refused')) continue;
    verdicts.push({
      kind: entry.kind,
      asked: entry.text,
      state: 'waived',
      used: WIDE_SCOPE[entry.kind],
      tool: entry.tool,
    });
  }

  // An answer measured over the wrong kind of record has one thing wrong with
  // it, and saying "this figure counts every deal status" about seven support
  // tickets is a third sentence about a filter on records nobody asked for.
  const wrongObject = verdicts.some((v) => v.kind === 'object' && v.state === 'substituted');
  const kept = wrongObject
    ? verdicts.filter((v) => v.state === 'bound' || !DEAL_DIMENSIONS.includes(v.kind))
    : verdicts;

  return { measurements, answering, verdicts: kept, unscoped: kept.filter((v) => v.state !== 'bound'), resolve };
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
): QualifierVerdict | null {
  // Nothing was measured, so there is no scope to be wrong about: a refusal
  // says what it could not do in its own banner.
  if (!answering.length) return null;
  const fallback = verdictFor(qualifier, answering, vocab, resolve);

  if (entry.state === 'waived' || entry.state === 'refused') {
    return {
      kind: qualifier.kind,
      asked: qualifier.label,
      state: 'waived',
      used: fallback?.used ?? WIDE_SCOPE[qualifier.kind],
      tool: entry.tool ?? fallback?.tool ?? null,
    };
  }
  if (entry.state !== 'bound') return fallback;

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
  if (qualifier.kind === 'period' || qualifier.kind === 'metric' || qualifier.kind === 'currency') return fallback;

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
): QualifierVerdict | null {
  if (!answering.length) return null;
  // With several quoted figures, the qualifier only counts as honoured when
  // every one of them narrowed to it.
  const states = answering.map((m) => stateOf(qualifier, m, vocab, resolve));
  const worst = states.find((s) => s.state === 'substituted') ?? states.find((s) => s.state === 'unbound') ?? states[0];
  const tool = answering[states.indexOf(worst)]?.tool ?? null;
  return { kind: qualifier.kind, asked: qualifier.label, state: worst.state, used: worst.used, tool };
}

function stateOf(
  qualifier: NamedQualifier,
  measurement: Measurement,
  vocab: Vocabulary,
  resolve: (id: string) => string | null,
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
      if (!scope.metric) return { state: 'bound', used: qualifier.label };
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
      if (!scope.objectType || scope.objectType === qualifier.value) return { state: 'bound', used: qualifier.label };
      return { state: 'substituted', used: pluralOf(humanizeName(scope.objectType).toLowerCase()) };
    }
    case 'group': {
      if (!scope.groupBy) return { state: 'unbound', used: wide };
      if (scope.groupBy === qualifier.value) return { state: 'bound', used: qualifier.label };
      return { state: 'substituted', used: `${humanizeName(scope.groupBy).toLowerCase()}` };
    }
    case 'account': {
      if (!scope.subjectId) return { state: 'unbound', used: wide };
      const name = resolve(scope.subjectId) ?? scope.subjectId;
      return norm(name) === norm(qualifier.label)
        ? { state: 'bound', used: name }
        : { state: 'substituted', used: name };
    }
    default:
      return { state: 'unbound', used: wide };
  }
}

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
  if (scope.ownerId) chips.push({ kind: 'owner', label: 'Owner', value: o.name(scope.ownerId), wide: false });
  if (scope.subjectId) chips.push({ kind: 'account', label: 'Account', value: o.name(scope.subjectId), wide: false });
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
  // rather than only in the banner.
  for (const verdict of verdicts) {
    if (verdict.state === 'bound') continue;
    // Only where the row is otherwise silent on that dimension: a snapshot
    // metric already shows "As of · now", and repeating it as a red "Period ·
    // as of now" says the same thing twice in two voices.
    if (chips.some((chip) => chip.kind === verdict.kind)) continue;
    chips.push({ kind: verdict.kind, label: LABEL_OF[verdict.kind], value: verdict.used, wide: true });
  }
  return chips;
}

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
}

const LEDGER_LINE = /^Qualifier ledger settled:\s*(.+?)\.?$/;
const LEDGER_ENTRY = /^([a-z_]+)\s+"([^"]*)"\s+(bound|waived|refused|pending)(?:\s*(?:→|->)\s*([a-z_][a-z0-9_.]*))?/i;
/**
 * Every kind the engine writes into its ledger.
 *
 * `account`, `currency`, `unit` and `meter` were dropped here — filtered out
 * one line before the loop that surfaces waived and refused qualifiers — while
 * the scope bar went on drawing `ACCOUNT` and `BOOK` chips for two of them. The
 * surface vouched loudest exactly where it checked least.
 */
const KINDS: QualifierKind[] = [
  'pipeline', 'stage', 'owner', 'period', 'status', 'metric', 'account', 'currency', 'unit', 'meter',
];

export function parseLedger(reasoning: string[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of reasoning) {
    const settled = LEDGER_LINE.exec(line.trim());
    if (!settled) continue;
    for (const piece of settled[1].split(';')) {
      const match = LEDGER_ENTRY.exec(piece.trim());
      if (!match) continue;
      const kind = match[1].toLowerCase() as QualifierKind;
      if (!KINDS.includes(kind)) continue;
      out.push({ kind, text: match[2], state: match[3].toLowerCase() as LedgerEntry['state'], tool: match[4] ?? null });
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
