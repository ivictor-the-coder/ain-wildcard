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

/**
 * The other reason no write was prepared: nobody asked for one.
 *
 * With "Let it prepare writes" off the engine stops before its write extractor
 * — "this run is read-only. Send `allow_writes: true` and I will prepare it for
 * your approval" — and writes that in the same sentence shape as the extractor
 * giving up. Read as the second, the card printed "The copilot cannot set the
 * amount on a deal — it reads a stage change and nothing else" over prose
 * saying the write *will* be prepared once the switch is on. Both cannot be
 * true, and on that run the loud one was the false one: the limit is real, and
 * this run never reached it.
 */
const RUN_IS_READ_ONLY = /^this run is read-only\b/i;

export function noWritePrepared(run: { reasoning?: string[] } | undefined | null): { tool: string; why: string } | null {
  for (const line of run?.reasoning ?? []) {
    const match = NO_WRITE.exec(line.trim());
    if (!match) continue;
    return RUN_IS_READ_ONLY.test(match[2].trim()) ? null : { tool: match[1].replace(/\s+/g, '_'), why: match[2] };
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

/**
 * The nearest shapes, read back off the run's own working notes.
 *
 * The completion carries them in structure, once, and only to the session
 * that asked. A thread reopened later has the run, and the run has the line
 * the engine wrote as it refused — `Nearest shapes: "…"; "…"; "…".` — which
 * is the same three questions. Reading them here is what lets a redrawn
 * refusal offer what the engine offered rather than a guess ranked by wording.
 */
export function nearestFromReasoning(reasoning: readonly string[] | null | undefined): { example: string }[] {
  for (const line of reasoning ?? []) {
    const match = /^Nearest shapes:\s*(.+?)\.?\s*$/.exec(line.trim());
    if (!match) continue;
    const examples = [...match[1].matchAll(/"([^"]+)"/g)].map((hit) => hit[1].trim()).filter(Boolean);
    if (examples.length) return examples.map((example) => ({ example }));
  }
  return [];
}

/**
 * The refusal's own offer, split off the refusal.
 *
 * The engine ends a refusal with "Try one of these:" and three bullets, and
 * the card draws those three as chips. Left in the prose too, the same three
 * questions appeared twice on one card — once as text nobody can press and
 * once as buttons — and when the chips came from a different list, the card
 * disagreed with itself. The bullets are read out here so the card can show
 * them once, as the thing a person presses.
 */
export function splitRefusalOffer(content: string): { prose: string; offered: string[] } {
  const match = /\n{2,}Try one of these:\s*\n+((?:\s*[•\-*]\s+.+\n?)+)\s*$/.exec(content);
  if (!match) return { prose: content, offered: [] };
  const offered = match[1].split('\n').map((line) => line.trim().replace(/^[•\-*]\s+/, '')).filter(Boolean);
  return { prose: content.slice(0, match.index).trimEnd(), offered };
}

/* --------------------------- a currency refusal --------------------------- */

/**
 * A money measure the engine refused to narrow to the currency that was named.
 *
 * Two sentences come back for this, and both are statements about the *whole*
 * measure written from a read that had already been narrowed to the currency:
 *
 *   "Overdue balance" is measured from records that carry no currency book in
 *   this workspace, so it cannot be narrowed to GBP: the figure I hold is the
 *   whole of it, in USD.
 *
 * Asked without the currency, the same measure answers "Overdue balance is
 * held in 2 currencies … $127,840.00 in USD and €1,007.00 in EUR", so the
 * sentence above is not true of this workspace — and the ageing answer even
 * names the GBP book it says does not exist. The card must not print that as
 * prose. It is read here so the surface can say what it can actually stand
 * behind and hand over the question that gets a true answer.
 */
export interface CurrencyRefusal {
  /** The measure as the engine labels it — "Overdue balance", "Monthly recurring revenue". */
  measure: string;
  /** The three-letter code that was asked for, upper case. */
  currency: string;
  /** The engine's own sentence, so it can be lifted out of the prose. */
  claim: string;
  /** The same question with the currency taken off it, when it can be taken off cleanly. */
  unscoped: string | null;
}

const CURRENCY_CLAIMS = [
  /"([^"]+)" is held in [^—]*?there is no ([A-Za-z]{3}) book in it[^.]*\./,
  /"([^"]+)" is measured from records that carry no currency book[^:]*?cannot be narrowed to ([A-Za-z]{3})[^.]*\./,
];

/**
 * The question with the currency removed — `… in GBP?` → `…?`.
 *
 * Null rather than a guess when the code is not in the sentence at all: the
 * engine can bind a currency from a word the question never spells ("yen"),
 * and offering "What is our overdue balance in yen?" back would be the same
 * dead end twice.
 */
function withoutCurrency(question: string, code: string): string | null {
  const stripped = question.replace(new RegExp(`\\s*\\b(?:in|for)\\s+${code}\\b`, 'i'), '');
  return stripped !== question ? stripped.replace(/\s+([?.!])/, '$1').trim() : null;
}

export function currencyRefusal(
  question: string,
  refusal: { code: string; message: string | null } | null | undefined,
  said?: { measure: string; currency: string } | null,
): CurrencyRefusal | null {
  // The facts first. The engine publishes which measure and which currency it
  // would not narrow, and the card resolves them, so this no longer reads them
  // back out of a sentence. It did, with a regex, and carried two patterns for
  // two past wordings; improving the sentence a third time turned this whole
  // card off in silence, which is how the browser suite found it.
  if (said) {
    const code = said.currency.toUpperCase();
    return {
      measure: said.measure,
      currency: code,
      claim: refusal?.message ?? '',
      unscoped: withoutCurrency(question, code),
    };
  }
  // And the sentences, for a thread answered before the engine carried facts.
  if (!refusal?.message || refusal.code !== 'tool_failed') return null;
  for (const pattern of CURRENCY_CLAIMS) {
    const match = pattern.exec(refusal.message);
    if (!match) continue;
    const currency = match[2].toUpperCase();
    return { measure: match[1], currency, claim: match[0], unscoped: withoutCurrency(question, currency) };
  }
  return null;
}

/** The refusal's prose with the engine's currency claim lifted out of it. */
export function withoutCurrencyClaim(content: string, claim: string): string {
  return content.replace(claim, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * A write asked for with the switch off.
 *
 * The engine stops before its write extractor and says so in its notes — `No
 * write prepared: the request looks like update_record, but this run is
 * read-only…`. The person who asked has a switch on the screen, not a request
 * body, so the card turns this into the action that fixes it.
 */
export function writeNeedsSwitch(run: { reasoning?: string[]; analysis?: unknown } | undefined | null): { tool: string } | null {
  // The template engine records the blocked write in structure —
  // `analysis.write_blocked: { wanted, reason }` — on the completion.
  const analysis = run?.analysis;
  if (analysis && typeof analysis === 'object' && !Array.isArray(analysis)) {
    const blocked = (analysis as Record<string, unknown>).write_blocked;
    if (blocked && typeof blocked === 'object') {
      const wanted = (blocked as Record<string, unknown>).wanted;
      const reason = (blocked as Record<string, unknown>).reason;
      if (typeof wanted === 'string' && wanted && (typeof reason !== 'string' || /read-only/i.test(reason))) return { tool: wanted };
    }
  }
  for (const line of run?.reasoning ?? []) {
    const text = line.trim();
    // The template engine's note: `Ran update_record in 1ms →
    // write_not_permitted: "update_record" changes data and this run is read-only.`
    const ran = /^Ran ([a-z_]+) in \d+ms → write_not_permitted:/.exec(text);
    if (ran) return { tool: ran[1] };
    // The older engine's: `No write prepared: the request looks like
    // update_record, but this run is read-only. …`
    const match = NO_WRITE.exec(text);
    if (match && RUN_IS_READ_ONLY.test(match[2].trim())) return { tool: match[1].replace(/\s+/g, '_') };
  }
  return null;
}

/**
 * The same answer without the request-body instruction.
 *
 * "I changed nothing. This run is read-only — send `allow_writes: true` and I
 * will prepare the stage change for your approval." is written for a caller
 * with a JSON body. On this screen the reader has a switch, and the card puts
 * the switch under the sentence; the sentence keeps the fact and drops the
 * instruction it cannot follow.
 */
export function withoutApiInstruction(content: string): string {
  return content.replace(
    /\s*—\s*send `allow_writes: true` and I will prepare (?:the |an? )?(.+?) for your approval\./i,
    '. The $1 was not prepared.',
  );
}

/**
 * The measure this question inherited from the one before it.
 *
 * "And by owner?" names no measure, so the engine takes one from the previous
 * turn and says so — in structure on the completion (`analysis.carried`) and in
 * its working notes, which is all a thread reopened a week later still has. A
 * breakdown whose subject came from a question that has scrolled off the top of
 * the screen has to say where it came from, or the rows underneath it are of
 * nothing in particular.
 */
export function carriedMeasure(
  source: { reasoning?: string[] | null; analysis?: unknown } | undefined | null,
): { measure: string; from: string } | null {
  const analysis = source?.analysis;
  if (analysis && typeof analysis === 'object' && !Array.isArray(analysis)) {
    const carried = (analysis as Record<string, unknown>).carried;
    if (carried && typeof carried === 'object' && !Array.isArray(carried)) {
      const measure = (carried as Record<string, unknown>).measure;
      const from = (carried as Record<string, unknown>).from;
      if (typeof measure === 'string' && measure && typeof from === 'string' && from) return { measure, from };
    }
  }
  for (const line of source?.reasoning ?? []) {
    const match = /names no measure of its own; carried "([^"]+)" from "([^"]+)"/.exec(line);
    if (match) return { measure: match[1], from: match[2] };
  }
  return null;
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
