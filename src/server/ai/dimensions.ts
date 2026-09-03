/**
 * Every dimension the workspace's own records are enumerated on.
 *
 * The qualifier ledger began life holding the eleven narrowings someone had
 * written a parser for. That is a guard-per-qualifier scheme wearing an
 * invariant's name: a question that scoped itself on a *twelfth* dimension —
 * a lead source, a competitor, a forecast category, a deal type, an industry —
 * named nothing the ledger could hold, so nothing could refuse it, and the
 * workspace total was stated as the answer. Measured on this workspace:
 * "partner referrals" is $690,260 across 3 open deals and came back as
 * $9,010,960 across 38; "trade shows" is $2,634,940 across 7 and came back as
 * the same $9,010,960; "commit" is $3,163,840 across 15 and came back as the
 * same figure again. Three different questions, one number, no hedge.
 *
 * So the dimensions are not a list in this file. They are read from
 * `crm_properties` — the workspace's own enumerations, with the workspace's own
 * option labels — which means a workspace that adds a `product_line` picklist
 * gets the invariant over it for free, and a workspace that renames "Trade
 * show" to "Expo" is answered about expos.
 *
 * What *is* in this file is the ambiguity policy, because option labels are
 * English before they are values. "Closed" is a forecast category and a deal
 * outcome; "New business" is a deal type and the name of a pipeline;
 * "Expansion" is both of those and a lead source. Matching those bare would
 * turn working questions into refusals, which is its own wrong answer. So a
 * label is matched on its own only when it is *distinctive* — more than one
 * word, or one long word that no other vocabulary here claims — and otherwise
 * only next to the name of the dimension itself ("commit forecast category",
 * "the New business deal type").
 */
import type { Ctx } from '../kernel/context';
import { DAY } from '../../shared/time';
import { propertyMap } from './query';
import { normalise } from './text';

/** One value of an enumerated property, with every way this workspace writes it. */
export interface DimensionOption {
  value: string;
  label: string;
  /** The surface forms that name it on their own, longest first. */
  open: string[];
  /** The surface forms that name it only beside the dimension's own name. */
  anchored: string[];
}

export interface Dimension {
  objectType: string;
  property: string;
  /** True when a record may hold several of these at once. */
  multi: boolean;
  /** What a person calls the dimension — "Competitor", "Original source". */
  noun: string;
  /** The phrases that name the dimension itself, for an anchored match. */
  anchors: string[];
  options: DimensionOption[];
}

/**
 * The properties another qualifier kind already owns.
 *
 * A deal's pipeline and stage are parsed by `qualifiers.ts` with their own
 * aliasing rules and their own refusals; reading them a second time here would
 * put two entries in the ledger for one word and refuse the question for
 * naming two of a kind.
 */
const CLAIMED: Record<string, string[]> = {
  deal: ['pipeline', 'deal_stage', 'deal_status'],
  ticket: ['pipeline'],
  company: ['type'],
  contact: ['buying_role'],
};

/**
 * Words that are English, or another vocabulary's, before they are a value.
 *
 * A single-word label in here never matches on its own. The list is short on
 * purpose: every entry is a word this engine already reads as something else,
 * so allowing it would make one span two qualifiers.
 */
const AMBIGUOUS = new Set([
  'open', 'closed', 'close', 'won', 'lost', 'new', 'other', 'none', 'all', 'total',
  'high', 'low', 'medium', 'urgent', 'price', 'standard', 'premium', 'commit',
  'email', 'phone', 'chat', 'portal', 'agent', 'lead', 'leads', 'customer', 'customers',
  'prospect', 'prospects', 'partner', 'partners', 'vendor', 'reseller', 'opportunity',
  'pipeline', 'expansion', 'renewal', 'business', 'quality', 'finance', 'executive',
  'billing', 'hardware', 'security', 'integration', 'dashboards', 'mobile', 'api',
  'food', 'energy', 'timing', 'connected', 'progress',
  // "Pilot" is an automation maturity here and the first word of "pilot
  // conversion", a deal type, and of half the deal names in the book.
  'pilot', 'pilots',
]);

/** Extra ways people name a dimension, beyond the words of its own label. */
const EXTRA_ANCHORS: Record<string, string[]> = {
  competitor: ['competitor', 'competitors', 'competition', 'competing', 'compete', 'up against', 'losing to', 'lose to', 'lost to', 'losing them to', 'displacing', 'displaced by'],
  forecast_category: ['forecast', 'forecasting'],
  deal_type: ['deal type', 'type of deal', 'types of deal'],
  lead_source: ['source', 'sources', 'came from', 'come from', 'originated', 'origin', 'channel'],
  lifecycle_stage: ['lifecycle', 'life cycle'],
  industry: ['industry', 'industries', 'sector', 'sectors', 'vertical', 'verticals'],
  region: ['region', 'regions', 'geography', 'geo'],
  support_tier: ['tier', 'tiers'],
  automation_maturity: ['maturity'],
  controls_platform: ['controls', 'plc', 'platform'],
  close_reason: ['reason', 'reasons', 'why we lost', 'why we won'],
  priority: ['priority', 'priorities'],
  category: ['category', 'categories'],
  product_area: ['product area', 'area'],
  source_channel: ['channel', 'channels'],
  department: ['department', 'departments', 'function'],
  lead_status: ['lead status'],
  status: ['status', 'statuses'],
};

const plural = (form: string): string[] => {
  const out = [form];
  if (/[^s]s$/.test(form)) out.push(form.slice(0, -1));
  else if (/(ch|sh|s|x|z)$/.test(form)) out.push(`${form}es`);
  else out.push(`${form}s`);
  if (/ies$/.test(form)) out.push(`${form.slice(0, -3)}y`);
  return out;
};

/**
 * Every way this workspace writes one option.
 *
 * "Metals & mining" is written "metals and mining" by anyone typing a question,
 * and "Pharmaceuticals" is written "pharmaceutical companies". Both are the
 * label; neither is the label's own characters. The head of an ampersand pair
 * counts too — "aerospace" is how people ask about "Aerospace & defence" — but
 * only the head, because the tail of one pair ("mining") is the whole of
 * somebody's company name.
 */
function surfaceForms(label: string, value: string): string[] {
  const out = new Set<string>();
  const add = (form: string) => { for (const one of plural(normalise(form))) if (one.length > 2) out.add(one); };
  add(label);
  add(label.replace(/\s*[&\/]\s*/g, ' and '));
  // The stored value counts as a spelling only when it *is* the label written
  // for a machine — `trade_show`, `waiting_on_customer` — never when it is a
  // shorthand somebody chose. `close_reason` stores "Lost to competitor" as
  // `competitor`, and reading that bare word as the value made "how many open
  // deals have the Tulip competitor?" answer 0: the word naming the dimension
  // was consumed as a value of a different one.
  if (value.includes('_') || normalise(value) === normalise(label)) add(value.replace(/_/g, ' '));
  // …and when it is the label's own opening, abbreviated. `pharma` is stored
  // for "Pharmaceuticals" and `litmus` for "Litmus Edge"; both are how this
  // workspace itself spells the value, and refusing them said "Northwind
  // Robotics records no industry called \"pharma\"" about the string in its own
  // column. Five characters and a shared opening, so a shorthand somebody chose
  // for something else — `competitor` for "Lost to competitor" — is still not a
  // spelling of it.
  if (normalise(value).length >= 5 && normalise(label).startsWith(normalise(value))) add(value);
  const head = label.split(/\s*[&/]\s*/)[0];
  if (head && head !== label) add(head);
  return [...out].sort((a, b) => b.length - a.length);
}

/** Whether a form names its value on its own, rather than only beside the dimension. */
function distinctive(form: string, reserved: Set<string>): boolean {
  if (reserved.has(form)) return false;
  const words = form.split(' ');
  if (words.length > 1) return true;
  return form.length >= 5 && !AMBIGUOUS.has(form);
}

/**
 * The enumerated dimensions of one object type, as this workspace defines them.
 *
 * `reserved` holds the phrases another qualifier already owns — the pipeline
 * and stage labels — so a deal type called "Renewal" cannot be read out of "the
 * Renewal pipeline" and counted twice.
 */
export function dimensionsOf(ctx: Ctx, orgId: string, objectType: string, reserved: Set<string>): Dimension[] {
  const out: Dimension[] = [];
  const claimed = new Set(CLAIMED[objectType] ?? []);
  for (const [property, definition] of propertyMap(ctx, orgId, objectType)) {
    if (claimed.has(property)) continue;
    if (definition.type !== 'enum' && definition.type !== 'multi_enum') continue;
    if (!definition.options.length) continue;
    const anchors = [
      ...new Set([
        ...normalise(definition.label).split(' ').filter((word) => word.length >= 4),
        normalise(definition.label),
        ...(EXTRA_ANCHORS[property] ?? []).map(normalise),
      ]),
    ].filter(Boolean);
    const options: DimensionOption[] = [];
    for (const option of definition.options) {
      // "None identified" is the absence of a value, not a value anybody asks
      // about by name; a question that names it is asking for the rest.
      if (option.value === 'none' || option.value === 'other') continue;
      const forms = surfaceForms(option.label, option.value);
      options.push({
        value: option.value,
        label: option.label,
        open: forms.filter((form) => distinctive(form, reserved)),
        anchored: forms,
      });
    }
    if (options.length) out.push({ objectType, property, noun: definition.label, anchors, options, multi: definition.type === 'multi_enum' });
  }
  return out;
}

export interface DimensionMatch {
  objectType: string;
  property: string;
  noun: string;
  value: string;
  label: string;
  /** True when the column holds several values per record, so the test is membership. */
  multi: boolean;
  /** The words in the question that named it. */
  matched: string;
}

const phraseAt = (haystack: string, needle: string): number => {
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    const before = at === 0 ? ' ' : haystack[at - 1];
    const after = at + needle.length >= haystack.length ? ' ' : haystack[at + needle.length];
    if (before === ' ' && after === ' ') return at;
    at = haystack.indexOf(needle, at + 1);
  }
  return -1;
};

/**
 * The words a reader puts inside a stored label without changing it.
 *
 * "Waiting on customer" is the workspace's own spelling; "waiting on the
 * customer" is how anybody would type it. One article between two words of a
 * label broke the match, so that question was answered with all 7 open tickets
 * instead of the 2 sitting in that column.
 */
const FILLER = '(?:the|a|an|our|their|its|my|this|that)';

/** The reader's own spelling of a span this matched on the normalised text. */
function spelling(question: string, form: string): string {
  const pattern = form.split(' ')
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(`[^a-z0-9]+(?:${FILLER}[^a-z0-9]+)?`);
  return question.match(new RegExp(`\\b${pattern}\\b`, 'i'))?.[0] ?? form;
}

/** The question with the articles between words taken out, for matching only. */
const deArticled = (text: string): string => {
  let out = text;
  for (let pass = 0; pass < 3; pass += 1) out = out.replace(new RegExp(` ${FILLER} `, 'g'), ' ');
  return out;
};

/**
 * Every enumerated value the question names.
 *
 * One match per dimension — the longest form wins, so "metals and mining" is
 * read whole rather than as "metals" — because a question naming two values of
 * one dimension is a breakdown request, and the second entry would only ever
 * refuse it.
 */
export function dimensionsIn(question: string, dimensions: Dimension[]): DimensionMatch[] {
  const text = deArticled(` ${normalise(question)} `);
  const out: DimensionMatch[] = [];
  for (const dimension of dimensions) {
    // Where the dimension names itself, so an ambiguous label counts only
    // beside it. "How much open pipeline is in the Commit forecast category?"
    // holds the word "pipeline" — which is also a forecast category — twice
    // over, and the longest match anywhere in the sentence read the reader's
    // scope as its opposite.
    const anchors: { at: number; length: number }[] = [];
    for (const anchor of dimension.anchors) {
      const at = phraseAt(text, anchor);
      if (at >= 0) anchors.push({ at, length: anchor.length });
    }
    let best: { option: DimensionOption; form: string; at: number } | null = null;
    for (const option of dimension.options) {
      for (const form of anchors.length ? option.anchored : option.open) {
        const at = phraseAt(text, form);
        if (at < 0) continue;
        // A form that names the value on its own may sit anywhere. One that
        // does not has to be next to the dimension's own name — that adjacency
        // is the only thing making it a value rather than an English word.
        const beside = option.open.includes(form)
          || anchors.some((anchor) => Math.abs(anchor.at - (at + form.length)) <= 2
            || Math.abs(at - (anchor.at + anchor.length)) <= 2);
        if (!beside) continue;
        if (!best || form.length > best.form.length) best = { option, form, at };
      }
    }
    if (!best) continue;
    out.push({
      objectType: dimension.objectType,
      property: dimension.property,
      noun: dimension.noun,
      value: best.option.value,
      label: best.option.label,
      multi: dimension.multi,
      matched: spelling(question, best.form),
    });
  }
  return out;
}

/**
 * Row nouns that are also a word inside a column's name.
 *
 * "by deal" is the object type, not the Deal type column, and grouping a
 * measure by `deal_type` because the reader wrote the word "deal" would be the
 * substitution this file exists to stop, wearing a `group_by`.
 */
const NOT_A_GROUPING = new Set(['deal', 'deals', 'company', 'companies', 'ticket', 'tickets',
  'contact', 'contacts', 'customer', 'customers', 'account', 'accounts', 'invoice', 'invoices',
  'lead', 'leads', 'sales', 'product', 'support', 'original', 'preferred', 'controls']);

/**
 * The dimension a breakdown is asked for, when it is one of this workspace's
 * own columns rather than one of the handful `GroupBy` enumerates.
 *
 * "Break down open pipeline by forecast category" is a real report — five rows
 * of it — and `record_aggregate` groups by any property there is. Without this
 * the phrase reached no argument at all, so the reader's own instruction was
 * either dropped under one undivided total or refused.
 */
export function groupingDimensionIn(
  question: string,
  dimensions: Dimension[],
): { objectType: string; property: string; noun: string; matched: string } | null {
  const text = ` ${deArticled(normalise(question))} `;
  const marker = /\b(?:split|splits|broken\s+(?:down|out)|break\s+(?:down|out)|grouped|group|bucketed|segmented|sliced)(?:\s+up)?\s+by\s+|\b(?:by|per|each)\s+/g;
  const tails = [...text.matchAll(marker)].map((hit) => text.slice((hit.index ?? 0) + hit[0].length));
  if (!tails.length) return null;
  let best: { objectType: string; property: string; noun: string; matched: string } | null = null;
  for (const dimension of dimensions) {
    for (const anchor of dimension.anchors) {
      if (anchor.length < 4 || NOT_A_GROUPING.has(anchor)) continue;
      if (!tails.some((tail) => tail.startsWith(`${anchor} `))) continue;
      if (best && anchor.length <= best.matched.length) continue;
      best = { objectType: dimension.objectType, property: dimension.property, noun: dimension.noun, matched: anchor };
    }
  }
  return best;
}

/** The record ids a dimension filter picks out, for a query one table over. */
export function recordsMatching(
  ctx: Ctx,
  orgId: string,
  objectType: string,
  property: string,
  value: string,
  multi = false,
): string[] {
  // A multi-select cell holds every value of the record at once, separated:
  // `;siemens;fanuc;`. Equality against it finds nobody.
  if (multi) {
    return ctx.db.all<{ id: string }>(
      `SELECT r.id FROM crm_records r JOIN crm_record_values v ON v.record_id = r.id
        WHERE r.org_id = ? AND r.object_type = ? AND r.archived = 0 AND r.merged_into IS NULL
          AND v.property = ? AND v.value_text LIKE ? ESCAPE '\\' ORDER BY r.id`,
      orgId, objectType, property, `%;${value.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)};%`,
    ).map((r) => r.id);
  }
  return ctx.db.all<{ id: string }>(
    `SELECT r.id FROM crm_records r JOIN crm_record_values v ON v.record_id = r.id
      WHERE r.org_id = ? AND r.object_type = ? AND r.archived = 0 AND r.merged_into IS NULL
        AND v.property = ? AND v.value_text = ? ORDER BY r.id`,
    orgId, objectType, property, value,
  ).map((row) => row.id);
}

/**
 * Where a question puts the *value* of a dimension, so an unknown one can be
 * refused by name.
 *
 * "How many open deals are we losing to Siemens?" came back as "Northwind
 * Robotics has 14 closed-lost deals" — a confident figure about every deal this
 * workspace ever lost, for a competitor it has never faced once. An unknown
 * pipeline is refused; an unknown account is refused; this is the same word in
 * the same sentence position and it was answered with the widest number in the
 * book.
 *
 * The capture is deliberately narrow: a proper noun directly after the phrase.
 * A lowercase word there is English ("we lost to price"), and refusing that
 * would be its own wrong answer.
 */
const VALUE_SLOTS: Record<string, RegExp> = {
  competitor: /\b(?:lose|losing|lost|loses|compete|competing|competed|up\s+against|going\s+up\s+against|beaten|displaced)\s+(?:them\s+)?(?:to|against|with|by)\s+(?:the\s+)?([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,2})/,
  industry: /\b(?:in|across|inside)\s+(?:the\s+)?([A-Za-z][A-Za-z&-]*(?:\s+(?:and\s+)?[A-Za-z][A-Za-z&-]*){0,2})\s+(?:industry|sector|vertical)\b/i,
};

export interface UnknownValue {
  /** The dimension the slot belongs to — "Competitor". */
  noun: string;
  /** The words the question put in the slot. */
  text: string;
  /** The values this workspace does hold for it. */
  known: string[];
}

/**
 * A value the question put in a dimension's slot that this workspace has no
 * option for.
 */
export function unknownDimensionValue(
  question: string,
  dimensions: Dimension[],
  matched: DimensionMatch[],
): UnknownValue | null {
  for (const dimension of dimensions) {
    const slot = VALUE_SLOTS[dimension.property];
    if (!slot) continue;
    if (matched.some((hit) => hit.property === dimension.property && hit.objectType === dimension.objectType)) continue;
    const hit = question.match(slot);
    const text = hit?.[1]?.trim();
    if (!text) continue;
    const wanted = normalise(text);
    const holds = dimension.options.some((option) =>
      option.anchored.some((form) => form === wanted || wanted.startsWith(`${form} `) || wanted.endsWith(` ${form}`)));
    if (holds) continue;
    return { noun: dimension.noun, text, known: dimension.options.map((option) => option.label) };
  }
  return null;
}

/* ---------------------------- numeric dimensions --------------------------- */

/**
 * A quantity the question names that is a *filter*, not a measure.
 *
 * Two shapes, both of which were dropped in silence:
 *
 *   - a stored number with a unit in its own label — "a 36-month contract
 *     term" is `contract_term_months = 36`, and the question came back as "38
 *     open deals", the whole book;
 *   - an age in a state — "stuck in Negotiation for more than 60 days" is a
 *     threshold on `stage_entered_at`, and the question came back as eight
 *     rows aged 18 to 39 days, under a headline naming the stage. The true
 *     answer is no rows at all, which is a different thing to say.
 *
 * Both are thresholds, and thresholds already have a ledger kind — the
 * $500,000 case binds correctly. These go through the same path rather than
 * being discarded for having a different unit on them.
 */
export interface NumericDimension {
  objectType: string;
  property: string;
  noun: string;
  op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte';
  value: number;
  label: string;
  matched: string;
}

const UNIT_MULTIPLIER: Record<string, number> = { day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };

/**
 * Words a numeric property's label spends on grammar rather than on identity.
 *
 * "Total open deal value" and "Time to resolution (min)" are named by "deal"
 * and "resolution"; requiring the reader to write "total" or "time" as well
 * would make the filter unreachable, and treating those words as identifying
 * would let "how much time do we have" land on a column.
 */
const GENERIC_LABEL_WORD = new Set(['total', 'count', 'number', 'value', 'time', 'score', 'logged', 'stored']);

/**
 * The comparator in front of a number, and the operator it means.
 *
 * "a 24-month contract term" and "a contract term over 24 months" are two
 * different questions, and the second one used to be answered as the first:
 * `contract_term_months = 24` returned 17 deals where the reader's own
 * threshold returns 15. The comparator is half the filter, so it is read with
 * the number rather than after it.
 */
const COMPARATORS: [RegExp, 'gt' | 'gte' | 'lt' | 'lte'][] = [
  [/\b(?:more\s+than|greater\s+than|larger\s+than|longer\s+than|bigger\s+than|over|above|north\s+of|exceeding|in\s+excess\s+of|beyond)\s*$/i, 'gt'],
  [/\b(?:at\s+least|no\s+less\s+than|minimum\s+of|or\s+more\s+than)\s*$/i, 'gte'],
  [/\b(?:less\s+than|fewer\s+than|smaller\s+than|shorter\s+than|under|below|beneath|south\s+of)\s*$/i, 'lt'],
  [/\b(?:at\s+most|no\s+more\s+than|up\s+to|or\s+fewer\s+than)\s*$/i, 'lte'],
];

/** The operator the words immediately before a number ask for, or `eq`. */
function comparatorBefore(question: string, at: number): { op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'; matched: string } {
  const before = question.slice(Math.max(0, at - 28), at);
  for (const [pattern, op] of COMPARATORS) {
    const hit = before.match(pattern);
    if (hit) return { op, matched: hit[0].trim() };
  }
  return { op: 'eq', matched: '' };
}

/** How a person reads an operator back. */
const OP_WORD: Record<string, string> = { eq: '', gt: 'more than ', gte: 'at least ', lt: 'under ', lte: 'at most ' };

/** "for more than 60 days", "for over 3 months" — a duration the sentence names. */
const AGE_THRESHOLD =
  /\b(?:for\s+)?(more\s+than|over|longer\s+than|at\s+least|less\s+than|under|within|fewer\s+than)\s+(\d{1,4})\s*(day|days|week|weeks|month|months|year|years)\b/i;

/** The state whose age the question is asking about. */
const AGE_SUBJECT = /\b(stuck|sitting|sat|stalled|been|languish\w*|parked|idle|untouched|in)\b/i;

const LONGER = /^(more than|over|longer than|at least)$/i;

/**
 * Numeric filters the question names, read against this workspace's own
 * numeric properties.
 */
export function numericDimensionsIn(
  ctx: Ctx,
  orgId: string,
  question: string,
  objectType: string,
  now: number,
): NumericDimension[] {
  const out: NumericDimension[] = [];
  const text = ` ${normalise(question)} `;
  const properties = propertyMap(ctx, orgId, objectType);

  // A stored count with its unit written into the property's own label.
  for (const [property, definition] of properties) {
    if (definition.type !== 'number') continue;
    const unit = definition.label.match(/\b(months?|days?|weeks?|years?)\b/i)?.[1]?.toLowerCase().replace(/s$/, '');
    if (!unit) continue;
    const anchors = normalise(definition.label).split(' ')
      .filter((word) => word.length >= 4 && !/^(month|months|day|days|week|weeks|year|years)$/.test(word));
    if (anchors.length && !anchors.some((word) => text.includes(` ${word} `))) continue;
    const hit = new RegExp(`\\b(\\d{1,4})\\s*[-\u2013 ]?\\s*${unit}s?\\b`, 'i').exec(question);
    if (!hit) continue;
    // "over 24 months" is not "24 months". Reading the comparator with the
    // number is the difference between the 15 deals the reader asked for and
    // the 17 the equality returns.
    const comparator = comparatorBefore(question, hit.index);
    const amount = Number(hit[1]);
    out.push({
      objectType, property, noun: definition.label, op: comparator.op, value: amount,
      label: `${OP_WORD[comparator.op]}${hit[1]} ${unit}${amount === 1 ? '' : 's'}`,
      matched: comparator.matched ? `${comparator.matched} ${hit[0]}` : hit[0],
    });
  }

  // A threshold on any stored number, read against the property's own label.
  //
  // "How many companies have more than 500 connected assets?" named a column
  // this workspace holds, a comparator and a figure, and every part of it was
  // dropped: the engine could only threshold money, so the question came back
  // as a refusal naming "500" while `connected_assets` sat in the schema. The
  // comparator is required — a bare number beside a column name is a value
  // somebody is quoting, not a filter — and every distinctive word of the
  // label has to be in the sentence, so "over 24 months" cannot land on
  // "Days to close" for sharing the word "days".
  for (const [property, definition] of properties) {
    if (definition.type !== 'number') continue;
    if (out.some((entry) => entry.property === property)) continue;
    const words = normalise(definition.label).replace(/[^a-z0-9 ]+/g, ' ').split(' ')
      .filter((word) => word.length >= 4 && !GENERIC_LABEL_WORD.has(word));
    if (!words.length || !words.every((word) => text.includes(` ${word} `) || text.includes(` ${word}s `))) continue;
    for (const hit of question.matchAll(/\b(\d[\d,]*(?:\.\d+)?)\s*(%|percent)?\b/gi)) {
      const comparator = comparatorBefore(question, hit.index ?? 0);
      if (comparator.op === 'eq') continue;
      const amount = Number(hit[1].replace(/,/g, ''));
      if (!Number.isFinite(amount)) continue;
      out.push({
        objectType, property, noun: definition.label, op: comparator.op, value: amount,
        label: `${OP_WORD[comparator.op]}${amount.toLocaleString('en-US')} ${definition.label.toLowerCase()}`,
        matched: `${comparator.matched} ${hit[0]}`.trim(),
      });
      break;
    }
  }

  // An age in a state, which is a threshold on the date the state began.
  const stamp = properties.has('stage_entered_at') ? 'stage_entered_at' : null;
  const age = question.match(AGE_THRESHOLD);
  if (stamp && age && AGE_SUBJECT.test(question)) {
    const amount = Number(age[2]);
    const unit = age[3].toLowerCase().replace(/s$/, '');
    const span = amount * (UNIT_MULTIPLIER[unit] ?? DAY);
    // "Longer than 60 days" means the stage was entered *before* now minus 60
    // days. The comparison inverts because the column is a date, not an age.
    const longer = LONGER.test(age[1].trim());
    out.push({
      objectType,
      property: stamp,
      noun: properties.get(stamp)?.label ?? 'Entered stage',
      op: longer ? 'lt' : 'gte',
      value: now - span,
      label: `${longer ? 'more' : 'less'} than ${amount} ${unit}${amount === 1 ? '' : 's'} in stage`,
      matched: age[0],
    });
  }
  return out;
}
