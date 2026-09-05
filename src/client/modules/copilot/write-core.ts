/**
 * What a queued write would actually do, as pure functions.
 *
 * The approval card is the last thing a person reads before a write lands, and
 * until now it printed the write's own arguments and nothing else. "Deal stage
 * → negotiation" on a closed-lost deal is one line, and approving it changed
 * five things: the stage, the deal's status from lost to open, its forecast
 * category from closed to commit, its probability from 0% to 80%, and the
 * $223,440 that had left the pipeline in March went back into open pipeline and
 * into the forecast. None of that was on the card. The operator approved
 * "change the stage".
 *
 * Everything here is derived from two things the client already has — the deal
 * as the API returns it, and the board's own stage definitions — so no number
 * below is invented and every one of them can be checked against the record.
 *
 * No React and no fetch, so each rule is testable on its own.
 */
import type { VocabStage, Vocabulary } from './scope-core';

/** The stage change a queued write carries, if it carries one. */
export interface StageWrite {
  recordId: string;
  objectType: string;
  stage: string;
}

const str = (value: unknown): string | null =>
  (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * The stage a write would set, read off the arguments the engine prepared.
 *
 * Only `update_record` on a deal writes one — `{object_type: "deal", id:
 * "deal_nw_15", properties: {deal_stage: "negotiation"}}` — and it is the one
 * write in this product whose consequences reach past the record it names.
 */
export function stageWriteOf(tool: string, args: Record<string, unknown>): StageWrite | null {
  if (tool !== 'update_record') return null;
  const properties = args.properties;
  if (!properties || typeof properties !== 'object') return null;
  const stage = str((properties as Record<string, unknown>).deal_stage);
  const recordId = str(args.id) ?? str(args.record_id);
  const objectType = str(args.object_type) ?? 'deal';
  if (!stage || !recordId || objectType !== 'deal') return null;
  return { recordId, objectType, stage };
}

/** The deal a stage write would land on, as the record API returns it. */
export interface DealNow {
  id: string;
  name: string;
  stage: string | null;
  status: string | null;
  amount: number | null;
  probability: number | null;
  forecastCategory: string | null;
}

/** One consequence of a write, in the words the card states it in. */
export interface Consequence {
  /** `closed` is the one that changes whether the deal is in the pipeline at all. */
  kind: 'closed' | 'status' | 'pipeline' | 'forecast' | 'probability' | 'stage';
  text: string;
  /** Money the consequence moves, in minor units — signed. */
  delta?: number;
}

export interface StageConsequences {
  from: VocabStage | null;
  to: VocabStage | null;
  /** Whether this write puts a closed deal back in play, or takes an open one out. */
  closedState: 'reopens' | 'closes' | 'unchanged';
  /** The deal's status before and after, in the CRM's own words. */
  status: { from: string; to: string } | null;
  /** What open pipeline gains or loses, in minor units. */
  pipelineDelta: number;
  /** What the weighted forecast gains or loses, in minor units. */
  forecastDelta: number;
  probability: { from: number; to: number } | null;
  forecastCategory: { from: string; to: string } | null;
  /** True when the target stage is not a column of this deal's pipeline. */
  wrongPipeline: boolean;
}

/** `closed_lost` → `lost`; an open column → `open`. */
export const statusOfStage = (stage: VocabStage | null): string | null =>
  (stage ? (stage.isClosed ? (stage.isWon ? 'won' : 'lost') : 'open') : null);

const weightedOf = (amount: number, probability: number | null | undefined): number =>
  (probability === null || probability === undefined ? 0 : Math.round((amount * probability) / 100));

/**
 * Every consequence of moving one deal to one stage.
 *
 * The two figures that matter are not on the write and not on the card: open
 * pipeline counts a deal at its full amount while it is open and not at all
 * once it closes, and the forecast counts it at its stage's probability. So a
 * closed-lost deal moved to Negotiation adds its whole amount to one and 80% of
 * it to the other, and the card has to say both.
 */
export function stageConsequences(deal: DealNow, target: string, vocab: Vocabulary): StageConsequences {
  const stages = vocab.pipelines.flatMap((pipeline) => pipeline.stages);
  const from = stages.find((stage) => stage.name === deal.stage) ?? null;
  // The deal's own pipeline decides which column `negotiation` means: three
  // pipelines carry a stage by that name and they stamp different forecasts.
  const inSamePipeline = from ? stages.filter((stage) => stage.pipeline === from.pipeline) : stages;
  const to = inSamePipeline.find((stage) => stage.name === target)
    ?? stages.find((stage) => stage.name === target)
    ?? null;
  const amount = deal.amount ?? 0;
  const wasOpen = from ? !from.isClosed : deal.status === 'open';
  const isOpen = to ? !to.isClosed : wasOpen;
  const fromStatus = statusOfStage(from) ?? deal.status;
  const toStatus = statusOfStage(to);
  const fromProbability = from?.probability ?? deal.probability ?? null;
  const toProbability = to?.probability ?? null;

  return {
    from,
    to,
    closedState: wasOpen === isOpen ? 'unchanged' : (isOpen ? 'reopens' : 'closes'),
    status: fromStatus && toStatus && fromStatus !== toStatus ? { from: fromStatus, to: toStatus } : null,
    pipelineDelta: (isOpen ? amount : 0) - (wasOpen ? amount : 0),
    forecastDelta: weightedOf(amount, toProbability) - weightedOf(amount, fromProbability),
    probability: fromProbability !== null && toProbability !== null && fromProbability !== toProbability
      ? { from: fromProbability, to: toProbability }
      : null,
    forecastCategory: from?.forecastCategory && to?.forecastCategory && from.forecastCategory !== to.forecastCategory
      ? { from: from.forecastCategory, to: to.forecastCategory }
      : null,
    // A stage that exists in another pipeline and not in this deal's is the
    // write the tool refuses — `"commercial_terms" belongs to the Renewal
    // pipeline, not New business` — and the card can say so before it is
    // approved rather than after it has failed.
    wrongPipeline: !!from && !!to && from.pipeline !== to.pipeline,
  };
}

/**
 * The consequences as sentences, money left to the caller's formatter.
 *
 * The closed-state line comes first and is written in those words, because it
 * is the one a person approving "change the stage" has not been told about.
 */
export function consequenceLines(
  c: StageConsequences,
  money: (minor: number) => string,
): Consequence[] {
  const out: Consequence[] = [];
  if (c.closedState === 'reopens') {
    out.push({
      kind: 'closed',
      text: `This changes the deal’s closed state: it is ${c.from ? c.from.label.toLowerCase() : 'closed'} today, and this reopens it.`,
    });
  } else if (c.closedState === 'closes') {
    out.push({
      kind: 'closed',
      text: `This changes the deal’s closed state: it is open today, and this closes it as ${c.to?.isWon ? 'won' : 'lost'}.`,
    });
  }
  if (c.status) out.push({ kind: 'status', text: `Status ${c.status.from} → ${c.status.to}.` });
  if (c.pipelineDelta !== 0) {
    out.push({
      kind: 'pipeline',
      delta: c.pipelineDelta,
      text: c.pipelineDelta > 0
        ? `Open pipeline gains ${money(c.pipelineDelta)} — this deal re-enters it.`
        : `Open pipeline loses ${money(-c.pipelineDelta)} — this deal leaves it.`,
    });
  }
  if (c.forecastDelta !== 0) {
    out.push({
      kind: 'forecast',
      delta: c.forecastDelta,
      text: c.forecastDelta > 0
        ? `The weighted forecast gains ${money(c.forecastDelta)}.`
        : `The weighted forecast loses ${money(-c.forecastDelta)}.`,
    });
  }
  if (c.forecastCategory) {
    out.push({ kind: 'forecast', text: `Forecast category ${c.forecastCategory.from} → ${c.forecastCategory.to}.` });
  }
  if (c.probability) {
    out.push({ kind: 'probability', text: `Probability ${c.probability.from}% → ${c.probability.to}%.` });
  }
  return out;
}

/**
 * Whether this write must be acknowledged before it can be approved.
 *
 * A write that changes whether a deal is closed is not a write anybody approves
 * by reading "Deal stage → negotiation". If the operator did not see the
 * consequence, the write must not do it — so the button waits, in exactly two
 * cases: the consequence is a closed-state change, or this surface could not
 * read the deal and therefore cannot tell them whether it is one.
 */
export const needsAcknowledgement = (c: StageConsequences | null, unread: boolean): boolean =>
  unread || (!!c && (c.closedState !== 'unchanged' || c.wrongPipeline));

/**
 * The record a write's own preview says it will land on, at any line.
 *
 * `writeTargetLabel` reads the first preview line, which is the record for a
 * note and the header "New task" for a task — so a task prepared for "the
 * Sakamoto Seiki — packaging line uplift deal" and associated to the *company*
 * `cmp_nw_35` had its target line, "Linked to Sakamoto Seiki", eight rows down
 * and unread, and the card raised nothing at all.
 */
export function linkedTargetOf(preview: string[]): string | null {
  for (const line of preview) {
    const match = /^(?:linked to|note on|follow-up on)\s+(.+)$/i.exec(line.trim());
    if (!match) continue;
    const one = match[1].split(',')[0].trim();
    if (one && one !== 'no record' && !one.includes('a record I can no longer name')) return one;
  }
  return null;
}

/**
 * The deal a question named, out of the deals on the account it cited.
 *
 * "Set the amount on the Kilbride Dairy Systems — line 3 instrumentation deal
 * to $2,000,000" cites only the company, because the engine gave up before it
 * resolved the deal. The account's own deals are one read away, and the
 * question already contains the name of exactly one of them.
 */
export function dealNamedIn(
  question: string,
  deals: { id: string; display_name: string }[],
): { id: string; display_name: string } | null {
  const asked = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const matches = deals.filter((deal) => {
    const words = deal.display_name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length) return false;
    // The name's words in the name's order, each one a whole word of the
    // sentence — "line 3 instrumentation" must not be found inside "line 32".
    let at = 0;
    for (const word of words) {
      const found = asked.indexOf(` ${word} `, at);
      if (found === -1) return false;
      at = found + word.length;
    }
    return true;
  });
  // Two deals whose names both sit inside the sentence is the sibling problem
  // this file exists to refuse, so it names neither.
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The deal record, open on the group that holds the property in question.
 *
 * The copilot cannot set an amount or an owner — its write extractor reads a
 * stage and nothing else — and the sentence it offers instead ("name the
 * property and the value") is advice the reader has already followed. This is
 * the link the surface gives them: the deal's own screen, with the field on it.
 * An owner sits in no property group, so an empty group opens the whole form.
 */
export const editHref = (dealId: string, group: string): string =>
  `/deals/${encodeURIComponent(dealId)}?edit=${encodeURIComponent(group || '1')}`;
