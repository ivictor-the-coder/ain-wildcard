/**
 * This workspace's own words, and the scope a tool call actually ran at.
 *
 * The pipelines, the stages, the people and the metrics as this workspace
 * names them, so a chip can say "Renewal" where the plan said `pl_renewal`.
 * Beside them, `boundScopeOf` reads a tool call's own arguments and reports
 * what it really narrowed on — which is how the slot chips distinguish a
 * qualifier the plan bound from one it merely carried.
 *
 * This file was once far larger. It held a whole reconciliation: the engine
 * used to parse a qualifier out of a question, fail to bind it, and state the
 * unqualified result as the answer — "What is the Renewal pipeline worth?"
 * answered with the $9,010,960 workspace total — so the client checked every
 * answer against the question and drew a banner when they disagreed. The
 * engine is a template whitelist now: it binds every slot or refuses and names
 * the nearest templates, so there is no unbound qualifier left to catch. The
 * checking machinery outlived its purpose by a wave, cried wolf over correct
 * answers when it was run, and was kept alive only by its own tests. What
 * remains is what the surface still reads.
 *
 * No React and no fetch, so every rule below is testable on its own.
 */

/* ------------------------------- vocabulary ------------------------------- */

export interface VocabStage {
  pipeline: string;
  pipelineLabel: string;
  name: string;
  label: string;
  isClosed: boolean;
  isWon: boolean;
  /** The probability this column stamps on a deal, where the board publishes one. */
  probability?: number | null;
  /** The forecast bucket this column stamps — `pipeline`, `commit`, `closed`. */
  forecastCategory?: string | null;
}
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

const openStagesOf = (vocab: Vocabulary, pipeline?: string | null): VocabStage[] =>
  vocab.pipelines
    .filter((p) => !pipeline || p.name === pipeline)
    .flatMap((p) => p.stages.filter((s) => !s.isClosed));

/* ------------------------------ the tool call ----------------------------- */

export interface ToolCallLike { name: string; arguments: Record<string, unknown> }

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

export const labelOfPipeline = (name: string, vocab: Vocabulary): string =>
  vocab.pipelines.find((p) => p.name === name)?.label ?? humanizeName(name);

export const labelOfStage = (name: string, pipeline: string | null, vocab: Vocabulary): string => {
  const stages = vocab.pipelines.flatMap((p) => p.stages).filter((s) => s.name === name && (!pipeline || s.pipeline === pipeline));
  const labels = [...new Set(stages.map((s) => s.label))];
  return labels.length === 1 ? labels[0] : humanizeName(name);
};

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
