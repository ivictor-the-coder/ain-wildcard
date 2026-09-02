/**
 * Reading an answer, as pure functions.
 *
 * Everything here is about the *shape* of what the engine sent back — how its
 * prose divides into paragraphs and lists, what part of it is a tool echo
 * rather than an answer, and which confidence band a number falls in. No React
 * and no fetch, so it can be tested directly; `api.ts` re-exports all of it.
 */

export type ConfidenceBand = 'high' | 'medium' | 'low';

export const confidenceBand = (confidence: number | null): ConfidenceBand =>
  confidence === null ? 'low' : confidence >= 0.8 ? 'high' : confidence >= 0.55 ? 'medium' : 'low';

/**
 * What the confidence chip says.
 *
 * The percentage is the intent classifier's margin, and it was highest exactly
 * where the answer was worst: 99% on the write that moved the wrong deal, 98%
 * on a named-deal question answered for the whole account, 98% on a CSAT
 * refusal — against 79% and 67% on two correct, fully scoped answers. Printing
 * it first put the anti-correlated number in the biggest type on the card. The
 * unbound count is the half of this chip that is accurate, so where there is
 * one it is the whole chip, and the margin moves to the tooltip.
 */
export const confidenceChip = (percent: number, unbound: number): string => {
  if (unbound <= 0) return `intent read at ${percent}%`;
  return unbound === 1
    ? '1 qualifier of this question is unbound'
    : `${unbound} qualifiers of this question are unbound`;
};

/** Assistant prose arrives as paragraphs, some of them bullet lists. */
export interface Block { kind: 'text' | 'list'; lines: string[] }

/**
 * What a tool returned beyond the answer, split off from the answer itself.
 *
 * The engine appends the raw result of any tool whose output it did not fully
 * spend — "`list_pipelines` also returned:" followed by a bullet list mixing
 * one display label with two internal names. As prose under a finished answer
 * it reads like a debug console someone forgot to delete, and it repeats what
 * the citation chips and the trace already show properly. It is kept, because
 * throwing away what the engine reported would be worse, but it is kept as
 * what it is: a labelled aside, under the answer, not a paragraph of it.
 */
export interface ToolEcho { tool: string; items: string[] }

/**
 * A step that ran and put nothing in the answer, named as the engine named it.
 *
 * The engine closes an answer it could not fully spend with "I could not read
 * anything back from list pipelines: it carries no field I can name to you, and
 * printing the raw payload would put primary keys and column names in front of
 * you. It is on this run's trace." Two things are wrong with that as the last
 * paragraph of an answer. It is often false — the same run's trace reads
 * `list_pipelines — 3 items, 2/2 tools succeeded` — and it is plumbing narrated
 * at a sales manager: an internal capability, a warning about column names, and
 * an instruction to go and read a trace.
 *
 * The fact underneath it is worth keeping: something ran that the answer did
 * not use. So the claim is dropped and the fact is kept, beside the answer
 * rather than inside it, next to the steps that show what the step returned.
 */
export interface StepNote { step: string }

const ECHO_HEADING = /^`([a-z_][a-z0-9_]*)`\s+also returned:$/i;

const UNSPENT = /^I could not read anything back from ([a-z][a-z0-9 ]*):[\s\S]*run's trace\.$/i;

export function splitToolEcho(content: string): { prose: string; echoes: ToolEcho[]; notes: StepNote[] } {
  const chunks = content.split(/\n{2,}/);
  const echoes: ToolEcho[] = [];
  const notes: StepNote[] = [];
  const kept: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i].trim();
    const heading = ECHO_HEADING.exec(chunk);
    const next = chunks[i + 1]?.trim() ?? '';
    const lines = next ? next.split('\n').map((line) => line.trim()) : [];
    const bulleted = lines.length > 0 && lines.every((line) => /^[•\-*]\s+/.test(line));
    if (heading && bulleted) {
      echoes.push({ tool: heading[1], items: lines.map((line) => line.replace(/^[•\-*]\s+/, '')) });
      i += 1;
      continue;
    }
    const unspent = UNSPENT.exec(chunk);
    if (unspent) { notes.push({ step: unspent[1].trim() }); continue; }
    kept.push(chunks[i]);
  }
  return { prose: kept.join('\n\n'), echoes, notes };
}

export function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of content.split(/\n{2,}/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    const bullets = lines.filter((line) => /^[•\-*]\s+/.test(line.trim()));
    if (bullets.length && bullets.length === lines.length) {
      blocks.push({ kind: 'list', lines: lines.map((line) => line.trim().replace(/^[•\-*]\s+/, '')) });
    } else {
      blocks.push({ kind: 'text', lines });
    }
  }
  return blocks;
}

/* -------------------------------- refusals -------------------------------- */

/**
 * A refusal, in the engine's own words.
 *
 * The reasoning trail is where the engine records that it declined to measure
 * something — `Refused (period_unresolved): …`. Surfacing it is the difference
 * between an honest "I did not answer that" and a confident-looking paragraph
 * that happens to contain no numbers.
 */
/* ------------------------- what the thread carried ------------------------ */

/**
 * A scope this answer inherited from an earlier question rather than from this
 * one.
 *
 * The engine writes it in its own notes — `"this turn" names nothing on its
 * own; carried Marcus Barnes from the previous turn, and the answer is scoped
 * to it.` — and then answers "What is our open pipeline?" with $315,900, one
 * contact's single deal, against a workspace total of $9,010,960. The prose
 * mentions it in a closing sentence under the number, and the scope row draws a
 * calm grey `ACCOUNT · Marcus Barnes` chip that reads as a scope the reader
 * asked for.
 *
 * A thread that narrows every later question to an earlier question's subject
 * has to say so where the reader is looking, and let them take it off.
 */
export interface CarriedScope {
  /** The record the answer was scoped to. */
  subject: string | null;
  /** True when it came from the record the conversation is pinned to. */
  pinned: boolean;
  /** A measure carried forward from the question this one follows. */
  measure: string | null;
  /** The earlier question a carried measure came from. */
  from: string | null;
}

const CARRIED_SUBJECT = /names nothing on its own; carried (.+?) from (the previous turn|the record this conversation is pinned to), and the answer is scoped to it\.?$/;
const CARRIED_MEASURE = /names no measure of its own; carried (.+?) forward from "(.*)", the question it follows\.?$/;

export function carriedScope(run: { reasoning?: string[] } | undefined | null): CarriedScope | null {
  let subject: string | null = null;
  let pinned = false;
  let measure: string | null = null;
  let from: string | null = null;
  for (const line of run?.reasoning ?? []) {
    const held = CARRIED_SUBJECT.exec(line.trim());
    if (held) { subject = held[1].trim(); pinned = held[2].startsWith('the record'); continue; }
    const inherited = CARRIED_MEASURE.exec(line.trim());
    if (inherited) { measure = inherited[1].trim(); from = inherited[2].trim(); }
  }
  return subject || measure ? { subject, pinned, measure, from } : null;
}

/**
 * Words that ask about the whole workspace, so a carried record contradicts them.
 *
 * "What is our open pipeline?" is a question about Northwind Robotics. Answered
 * $315,900 for a contact carried in from two questions ago, it is wrong by
 * 28×, and the only thing on the card that says which set it counted is a chip
 * the size of a postage stamp.
 */
const WHOLE_WORKSPACE = /(^|[^a-z])(our|the workspace|across the workspace|company[ -]wide|overall|in total|altogether)([^a-z]|$)/i;

/** Whether this question's own words contradict a scope carried into it. */
export function contradictsCarried(question: string, carried: CarriedScope | null): boolean {
  if (!carried?.subject) return false;
  const text = question.toLowerCase();
  if (text.includes(carried.subject.toLowerCase())) return false;
  return WHOLE_WORKSPACE.test(text);
}

/* --------------------------- a write not prepared ------------------------- */

/**
 * A request to change something that the engine read and then did nothing with.
 *
 * "Set the amount on the Kilbride Dairy Systems — line 3 instrumentation deal
 * to $2,000,000" comes back "I changed nothing… I could not tell which property
 * to set — name the property and the value, e.g. 'move <deal> to Negotiation'."
 * The property was named, in the first four words. The engine's write extractor
 * only reads a stage, and the example it offers is the one thing it can already
 * do — so the sentence is a dead end that reads like the reader's mistake.
 *
 * It is a fact worth keeping and a bad last word, so the fact is kept and the
 * surface hands over the screen where the property really can be set.
 */
const NO_WRITE = /^No write prepared: the request looks like ([a-z_]+), but (.+)$/;

export function noWritePrepared(run: { reasoning?: string[] } | undefined | null): { tool: string; why: string } | null {
  for (const line of run?.reasoning ?? []) {
    const match = NO_WRITE.exec(line.trim());
    if (match) return { tool: match[1].replace(/\s+/g, '_'), why: match[2] };
  }
  return null;
}

/** The deal properties this product can set, in the words a question writes them. */
const SETTABLE: { word: RegExp; property: string; label: string; group: string }[] = [
  { word: /\b(amount|value|deal size|acv|price)\b/i, property: 'amount', label: 'the amount', group: 'Deal information' },
  { word: /\b(owner|owned by|assign(?:ee|ed)?|rep)\b/i, property: 'owner_id', label: 'the owner', group: '' },
  { word: /\b(close date|closing date|expected close)\b/i, property: 'close_date', label: 'the close date', group: 'Deal information' },
  { word: /\b(next step)\b/i, property: 'next_step', label: 'the next step', group: 'Sales' },
];

/** The property a request named that the engine could not prepare a write for. */
export function propertyAsked(question: string): { property: string; label: string; group: string } | null {
  const found = SETTABLE.find((row) => row.word.test(question));
  return found ? { property: found.property, label: found.label, group: found.group } : null;
}

export function refusalOf(run: { reasoning?: string[] } | undefined | null): { code: string; message: string } | null {
  for (const line of run?.reasoning ?? []) {
    // "Refused (period_unresolved): …" and "Refused after the run
    // (qualifier_unbound): …" are both the engine declining to answer. Only the
    // first shape was read, so a question refused *after* a tool ran — which is
    // every refusal that needed the tool's own error to decide — rendered with
    // no refusal banner at all, and the prose was left to carry it alone.
    const match = /^Refused\b[^(]*\(([a-z_]+)\):\s*(.+)$/.exec(line);
    if (match) return { code: match[1], message: match[2] };
  }
  return null;
}
