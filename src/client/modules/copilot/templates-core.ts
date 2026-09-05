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

/** One slot a template binds from the workspace before it runs. */
export interface TemplateSlot { name: string; type: string }

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

/** The rows whose example, shape or description mentions every word typed. */
export function filterTemplates(rows: readonly AiTemplate[], query: string): AiTemplate[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((row) => {
    const hay = `${row.example} ${row.shape} ${row.description}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

/* -------------------------------- refusals -------------------------------- */

/** A tappable way out of a refusal: one template, in its example wording. */
export interface NearestChip {
  templateId: string;
  question: string;
}

/** `nearest` as the completion sends it. */
export interface NearestOnWire { template_id: string; example?: string | null }

/**
 * The server's own list of nearest shapes, resolved against the whitelist.
 *
 * The example is what a person presses, so a row that names a template this
 * client cannot find and carries no example of its own has nothing to offer
 * and is dropped rather than drawn as an empty chip.
 */
export function nearestFromWire(rows: readonly NearestOnWire[], templates: readonly AiTemplate[]): NearestChip[] {
  const byId = new Map(templates.map((t) => [t.id, t]));
  const out: NearestChip[] = [];
  for (const row of rows) {
    const question = (row.example ?? '').trim() || byId.get(row.template_id)?.example?.trim() || '';
    if (!question || out.some((chip) => chip.question === question)) continue;
    out.push({ templateId: row.template_id, question });
  }
  return out;
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
