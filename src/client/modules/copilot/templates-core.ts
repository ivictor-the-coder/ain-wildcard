/**
 * The template whitelist, as pure functions.
 *
 * The built-in engine no longer interprets free text. It answers a fixed list
 * of question shapes — `GET /v1/ai/templates` — each with slots the workspace
 * fills (a period, an owner, a pipeline), and refuses everything else with the
 * nearest shapes it does answer. Everything this surface says about that list
 * is derived here, without React and without a fetch, so each rule can be held
 * to a fixture: how the list is grouped, which five open an empty thread,
 * which three sit under a refusal, and which engine an answer came from.
 */

/**
 * One slot a template binds from the workspace before it runs.
 *
 * The endpoint spells the slot's kind `kind` (`{ name: 'deal', kind: 'deal',
 * values: null }`); `type` is kept for rows written the older way.
 */
export interface TemplateSlot { name: string; type?: string; kind?: string; values?: string[] | null }

/** One row of `GET /v1/ai/templates`. */
export interface AiTemplate {
  object?: 'ai_template';
  id: string;
  /** The question shape with its slots, e.g. `How many {status} deals closed in {period}?`. */
  shape: string;
  slots: TemplateSlot[];
  /** The shape with real workspace values in it — the sentence a person presses. */
  example: string;
  description: string;
  /**
   * The endpoint may say which group a shape belongs to. When it does not, the
   * group is read off the id's first segment, then off the wording.
   */
  group?: string | null;
  /** `count`, `list`, `write`, … — what the shape does when it runs. */
  kind?: string | null;
  /** The wordings the engine matches, in its own grammar: `who owns {deal}`. */
  patterns?: string[] | null;
}

export type TemplateGroupId = 'revenue' | 'pipeline' | 'customers' | 'usage' | 'people' | 'other';

export interface TemplateGroupDef { id: TemplateGroupId; label: string; blurb: string }

/** The five the panel is organised around, in the order they are shown. */
export const TEMPLATE_GROUPS: readonly TemplateGroupDef[] = [
  { id: 'revenue', label: 'Revenue', blurb: 'ARR, bookings, invoices and what is still owed' },
  { id: 'pipeline', label: 'Pipeline', blurb: 'Open deals, stages, forecasts and close dates' },
  { id: 'customers', label: 'Customers', blurb: 'Accounts, subscriptions, plans and health' },
  { id: 'usage', label: 'Usage', blurb: 'Meters, consumption and prepaid credit' },
  { id: 'people', label: 'People', blurb: 'Owners, teammates and who is carrying what' },
  { id: 'other', label: 'Everything else', blurb: 'Shapes that belong to none of the groups above' },
];

const GROUP_IDS = new Set<string>(TEMPLATE_GROUPS.map((g) => g.id));

/**
 * Where a shape sits when the endpoint did not say.
 *
 * Only for arranging the panel: a shape filed under the wrong heading is a
 * cosmetic miss, not a substituted answer, so a small word list is the right
 * size of tool here. Ordered so that a shape about *who owns* the pipeline
 * lands under People rather than Pipeline, and one about metered credit lands
 * under Usage rather than Customers.
 */
const GROUP_WORDS: readonly [TemplateGroupId, RegExp][] = [
  ['usage', /\b(usage|meter(?:ed|s)?|consum(?:ed|ption)|credits?|prepaid|overage|units? recorded)\b/i],
  ['people', /\b(owners?|reps?|teammates?|who owns|who is carrying|assigned to|per owner|by owner)\b/i],
  ['revenue', /\b(arr|mrr|revenue|bookings?|invoices?|owed|overdue|collected|payments?|dunning|billing)\b/i],
  ['pipeline', /\b(pipeline|deals?|stages?|forecast|closing|close date|won|lost|negotiation|proposal)\b/i],
  ['customers', /\b(customers?|accounts?|compan(?:y|ies)|subscriptions?|plans?|churn|renewals?|contacts?|tickets?)\b/i],
];

const normaliseGroup = (value: string | null | undefined): TemplateGroupId | null => {
  const text = (value ?? '').trim().toLowerCase();
  return GROUP_IDS.has(text) ? (text as TemplateGroupId) : null;
};

export function groupOf(template: Pick<AiTemplate, 'id' | 'shape' | 'description' | 'group'>): TemplateGroupId {
  const stated = normaliseGroup(template.group);
  if (stated) return stated;
  const prefix = normaliseGroup(template.id.split(/[.:/_-]/)[0]);
  if (prefix) return prefix;
  const words = `${template.shape} ${template.description}`;
  for (const [group, pattern] of GROUP_WORDS) if (pattern.test(words)) return group;
  return 'other';
}

export interface TemplateGroup extends TemplateGroupDef { templates: AiTemplate[] }

/** The list arranged for the panel: the canonical order, empty groups left out. */
export function groupTemplates(rows: readonly AiTemplate[]): TemplateGroup[] {
  const buckets = new Map<TemplateGroupId, AiTemplate[]>();
  for (const row of rows) {
    const group = groupOf(row);
    const list = buckets.get(group) ?? [];
    list.push(row);
    buckets.set(group, list);
  }
  return TEMPLATE_GROUPS
    .filter((def) => (buckets.get(def.id) ?? []).length > 0)
    .map((def) => ({ ...def, templates: buckets.get(def.id) ?? [] }));
}

/**
 * The shapes an empty thread opens with.
 *
 * The endpoint lists templates in its own order of usefulness, so the first
 * five are the five — one per group where the list allows it, so the opening
 * screen shows the breadth of what can be asked rather than five ways to ask
 * about the pipeline.
 */
export function starterTemplates(rows: readonly AiTemplate[], count = 5): AiTemplate[] {
  const out: AiTemplate[] = [];
  const seen = new Set<TemplateGroupId>();
  for (const row of rows) {
    if (out.length >= count) break;
    const group = groupOf(row);
    if (seen.has(group)) continue;
    seen.add(group);
    out.push(row);
  }
  for (const row of rows) {
    if (out.length >= count) break;
    if (!out.includes(row)) out.push(row);
  }
  return out;
}

/* ------------------------------- filtering -------------------------------- */

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from', 'has', 'have', 'how',
  'in', 'is', 'it', 'its', 'many', 'me', 'much', 'my', 'of', 'on', 'or', 'our', 'show', 'that', 'the',
  'there', 'this', 'to', 'we', 'what', 'which', 'who', 'with', 'i', 'us', 'list', 'give', 'tell',
]);

const tokensOf = (text: string): string[] =>
  text.toLowerCase().replace(/[{}]/g, ' ').split(/[^a-z0-9$€£]+/).filter((w) => w.length > 1 && !STOP.has(w));

/**
 * A typed word reduced to the part every form of it shares.
 *
 * The panel's own placeholder suggested "owed", and "owed" found nothing: the
 * shapes say "owe" and "owes". A filter that rejects the word it proposed is a
 * filter nobody trusts twice, so an inflected word is matched on its stem —
 * "owed" and "owes" on "owe", "invoices" on "invoice", "closing" on "clos".
 */
export function stemOf(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length <= 3) return lower;
  for (const suffix of ['ing', 'ies', 's', 'ed', 'd']) {
    if (lower.endsWith(suffix) && lower.length - suffix.length >= 3) {
      const stem = lower.slice(0, -suffix.length);
      return suffix === 'ies' ? `${stem}y` : stem;
    }
  }
  return lower;
}

/** The rows whose example, shape, patterns or description mention every word typed, in any form. */
export function filterTemplates(rows: readonly AiTemplate[], query: string): AiTemplate[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((row) => {
    const hay = `${row.example} ${row.shape} ${row.description} ${(row.patterns ?? []).join(' ')}`.toLowerCase();
    return words.every((word) => hay.includes(word) || hay.includes(stemOf(word)));
  });
}

/* -------------------------------- refusals -------------------------------- */

/** A tappable way out of a refusal: one template, in its example wording. */
export interface NearestChip {
  templateId: string;
  question: string;
}

/**
 * `nearest` as the engine sends it.
 *
 * Two spellings reach this client. The completion's `analysis.nearest` is the
 * engine's own — `{ id, example, overlap }` — and a run's working notes hand
 * the examples back with no id at all; `template_id` is the documented shape.
 * All three are read, because the chips were reading only the last and the
 * engine was sending the first.
 */
export interface NearestOnWire { template_id?: string | null; id?: string | null; example?: string | null }

/**
 * The server's own list of nearest shapes, resolved against the whitelist.
 *
 * The example is what a person presses. A row that names no template this
 * client can find still offers its example — the engine wrote it, so the
 * engine answers it — and only a row with neither is dropped rather than
 * drawn as an empty chip.
 */
export function nearestFromWire(rows: readonly NearestOnWire[], templates: readonly AiTemplate[]): NearestChip[] {
  const byId = new Map(templates.map((t) => [t.id, t]));
  const byExample = new Map(templates.map((t) => [t.example.trim(), t]));
  const out: NearestChip[] = [];
  for (const row of rows) {
    const stated = (row.template_id ?? row.id ?? '').trim();
    const question = (row.example ?? '').trim() || byId.get(stated)?.example?.trim() || '';
    if (!question || out.some((chip) => chip.question === question)) continue;
    out.push({ templateId: stated || byExample.get(question)?.id || '', question });
  }
  return out;
}

/* ------------------------- a question about one record ------------------- */

/**
 * One of the engine's own wordings, filled in.
 *
 * The grammar is the engine's: `{slot}` or `{slot:kind}` takes the value,
 * `(a|b|)` is a choice and the first option is taken, everything else is a
 * word. "who owns {deal}" with the deal named becomes "Who owns Aconcagua
 * Alimentos — pilot expansion to 3 lines?" — a sentence the engine matches by
 * construction, because it is the engine's own pattern read back to it.
 */
export function renderPattern(pattern: string, values: Record<string, string>): string {
  const words: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === ' ') { i += 1; continue; }
    if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) break;
      const name = pattern.slice(i + 1, end).split(':')[0];
      const value = values[name];
      if (value) words.push(value);
      i = end + 1;
      continue;
    }
    if (ch === '(') {
      const end = pattern.indexOf(')', i);
      if (end < 0) break;
      const first = pattern.slice(i + 1, end).split('|')[0].trim();
      if (first) words.push(first);
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < pattern.length && pattern[j] !== ' ') j += 1;
    words.push(pattern.slice(i, j));
    i = j;
  }
  const sentence = words.join(' ').trim();
  if (!sentence) return '';
  const capitalised = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return /^(what|which|who|whose|when|where|why|how|is|are|does|do|did|has|have|can|will)\b/i.test(capitalised)
    ? `${capitalised}?`
    : capitalised;
}

/** A question shape filled in for one record, ready to press. */
export interface RecordQuestion { template: AiTemplate; question: string }

/**
 * The read shapes that take one record, each worded for the record in hand.
 *
 * This is what a record's own copilot entry offers: not "Where does the deal
 * stand?" — which no shape answers — but the four things the engine does
 * answer about a deal, with that deal's name in them. Writes are left out;
 * the entry is a place to ask, not a place to move a deal from.
 */
export function templatesAbout(
  rows: readonly AiTemplate[],
  slotKind: string,
  name: string,
): RecordQuestion[] {
  const out: RecordQuestion[] = [];
  for (const template of rows) {
    if (template.kind === 'write' || /^write[-_.]/.test(template.id)) continue;
    const slot = (template.slots ?? []).find((one) => (one.kind ?? one.type) === slotKind);
    if (!slot || (template.slots ?? []).length !== 1) continue;
    const pattern = (template.patterns ?? [])[0];
    if (!pattern) continue;
    const question = renderPattern(pattern, { [slot.name]: name });
    if (question) out.push({ template, question });
  }
  return out;
}

/**
 * The record a screen sent this page to ask about, read off the question it
 * composed.
 *
 * The deal screen's "Ask the copilot about this deal" arrives as `?ask=Where
 * does <deal> stand right now?`, and no shape answers that for a deal: it was
 * refused every single time, which made the one record-aware entry in the
 * product a guaranteed dead end. The sentence still says which record was
 * meant, so it is read as a request to open the deal's own questions.
 */
export function recordAsk(ask: string | null | undefined): { name: string } | null {
  const match = /^\s*where does (.+?) stand(?: right now| now| today)?\??\s*$/i.exec(ask ?? '');
  return match ? { name: match[1].trim() } : null;
}

/**
 * The closest shapes by wording, for a refusal whose `nearest` this client
 * does not hold — a conversation reopened next week reads its turns back from
 * the thread, and the thread carries the answer, not the completion envelope.
 *
 * Every chip is a real template, so the worst this can do is rank them badly;
 * it cannot offer a question the engine will not answer. `matched` says
 * whether any word of the question overlapped at all: when none did, the chips
 * are "some things it can answer", not "the closest things", and the caller
 * labels them so.
 */
export function nearestTemplates(
  question: string,
  templates: readonly AiTemplate[],
  count = 3,
): { chips: NearestChip[]; matched: boolean } {
  const asked = new Set(tokensOf(question));
  const scored = templates.map((template, index) => {
    const own = new Set(tokensOf(`${template.example} ${template.shape} ${template.description}`));
    let overlap = 0;
    for (const word of asked) if (own.has(word)) overlap += 1;
    const score = asked.size && own.size ? overlap / Math.sqrt(asked.size * own.size) : 0;
    return { template, index, score };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const top = scored.slice(0, count);
  return {
    chips: top.map(({ template }) => ({ templateId: template.id, question: template.example })),
    matched: top.some((row) => row.score > 0),
  };
}

/* --------------------------------- engines -------------------------------- */

export type Engine = 'template' | 'anthropic';

/**
 * Which engine answered, from the best evidence in hand.
 *
 * The completion says so outright (`engine`) and that is remembered for the
 * session. A turn read back from the thread has only the run: its provider is
 * whoever actually answered — a hosted run that fell back to the local engine
 * is recorded as the local engine — and a model named `claude-…` is the model.
 */
export function engineOf(
  run: { engine?: string | null; provider?: string | null; model?: string | null } | null | undefined,
  remembered?: Engine | null,
): Engine {
  if (remembered) return remembered;
  if (run?.engine === 'anthropic' || run?.engine === 'template') return run.engine;
  if (run?.provider === 'anthropic') return 'anthropic';
  if (/claude/i.test(run?.model ?? '')) return 'anthropic';
  return 'template';
}

/**
 * What it takes to ask free text: a hosted model, which the server reads from
 * this variable at boot. There is no screen for it — Settings › API keys mints
 * Ain's own credentials, and sending someone there for a model key was a link
 * to the wrong drawer.
 */
export const MODEL_KEY_VAR = 'ANTHROPIC_API_KEY';
export const MODEL_KEY_NOTE = `free text needs a hosted model — set ${MODEL_KEY_VAR} where the API runs`;

export interface EngineLine {
  engine: Engine;
  /** The words on the card. */
  label: string;
  /** What that means, in the tooltip and the panel. */
  detail: string;
  /** True when the only way to ask free text is to configure a hosted model. */
  needsKey: boolean;
}

/** The honest one-line account of who answered, and what it would take to ask more. */
export function engineLine(engine: Engine, hosted: boolean, model?: string | null): EngineLine {
  if (engine === 'anthropic') {
    return {
      engine,
      label: 'answered by the model',
      detail: `${model || 'The hosted model'} read this workspace through the same tools the templates use. The wording is the model’s own; the figures are cited.`,
      needsKey: false,
    };
  }
  if (hosted) {
    return {
      engine,
      label: 'answered from a template',
      detail: 'This question matched one of the fixed shapes the built-in engine answers. Every value in it was bound from the workspace, not read out of the wording.',
      needsKey: false,
    };
  }
  return {
    engine,
    label: 'answered from a template',
    detail: `No hosted model is configured, so every answer comes from the fixed list of shapes the built-in engine answers. A free-text question needs one: set ${MODEL_KEY_VAR} where the API runs and restart it.`,
    needsKey: true,
  };
}
