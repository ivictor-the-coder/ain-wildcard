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
export function refusalOf(run: { reasoning: string[] } | undefined | null): { code: string; message: string } | null {
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
