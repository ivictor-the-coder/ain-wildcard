/**
 * The workspace's own vocabulary of scopes.
 *
 * The pipelines and stages its CRM defines and the currency books its ledger
 * keeps, read from the tables rather than from a list in this file — so a
 * workspace that renames "Negotiation" to "Red lines" is answered about red
 * lines, and one with no renewal pipeline cannot be asked about one.
 *
 * `QualifierKind` is the kind a bound template slot is reported under in a
 * run's analysis: the one place a caller can see which words of their sentence
 * reached the query. The client reconciles against this exact list.
 */
import type { Ctx } from '../kernel/context';
import { billingSources, hasTable } from './grounding';
import { normalise } from './text';

export type QualifierKind =
  | 'pipeline' | 'stage' | 'owner' | 'account' | 'period'
  | 'status' | 'metric' | 'meter' | 'currency' | 'unit' | 'limit';

export interface PipelineTerm { value: string; label: string }

/**
 * One of the names this workspace gives a stage, and where it uses it.
 *
 * A stage *value* can carry a different label in every pipeline: `discovery` is
 * "Discovery" in New business and "Scoping" in Expansion; `closed_lost` is
 * "Closed lost" everywhere except Renewal, where it is "Churned". All of them
 * are this workspace's own words, so all of them bind.
 */
export interface StageAlias { label: string; pipelines: string[] }

export interface StageTerm {
  value: string;
  /** The name to read the stage back by when nothing narrows it to one pipeline. */
  label: string;
  /** Every name this workspace gives it, with the pipelines that use each. */
  aliases: StageAlias[];
  pipelines: string[];
  closed: boolean;
  won: boolean;
}

export interface QualifierVocabulary {
  pipelines: PipelineTerm[];
  stages: StageTerm[];
}

/** The name a stage goes by inside one pipeline, or its general name. */
export function stageLabelIn(vocabulary: QualifierVocabulary, value: string, pipeline?: string | null): string | null {
  const stage = vocabulary.stages.find((st) => st.value === value);
  if (!stage) return null;
  if (pipeline) {
    const scoped = stage.aliases.find((alias) => alias.pipelines.includes(pipeline));
    if (scoped) return scoped.label;
  }
  return stage.label;
}

const vocabularyCache = new Map<string, { stamp: number; vocabulary: QualifierVocabulary }>();

export function crmVocabulary(ctx: Ctx, orgId: string): QualifierVocabulary {
  const key = `${orgId}`;
  const stamp = hasTable(ctx.db, 'crm_pipeline_stages')
    ? Number(ctx.db.pluck<number>(`SELECT MAX(updated) FROM crm_pipeline_stages WHERE org_id = ?`, orgId) ?? 0)
    : 0;
  const cached = vocabularyCache.get(key);
  if (cached && cached.stamp === stamp) return cached.vocabulary;

  const pipelines: PipelineTerm[] = hasTable(ctx.db, 'crm_pipelines')
    ? ctx.db.all<{ name: string; label: string }>(
      `SELECT name, label FROM crm_pipelines WHERE org_id = ? AND object_type = 'deal' AND archived = 0 ORDER BY position`, orgId)
      .map((row) => ({ value: row.name, label: row.label }))
    : [];

  const stageRows = hasTable(ctx.db, 'crm_pipeline_stages')
    ? ctx.db.all<{ name: string; label: string; pipeline: string; is_closed: number; is_won: number }>(
      `SELECT name, label, pipeline, is_closed, is_won FROM crm_pipeline_stages
       WHERE org_id = ? AND object_type = 'deal' ORDER BY pipeline, position`, orgId)
    : [];
  const byValue = new Map<string, StageTerm>();
  for (const row of stageRows) {
    const held = byValue.get(row.name);
    if (held) {
      if (!held.pipelines.includes(row.pipeline)) held.pipelines.push(row.pipeline);
      const alias = held.aliases.find((a) => normalise(a.label) === normalise(row.label));
      if (alias) { if (!alias.pipelines.includes(row.pipeline)) alias.pipelines.push(row.pipeline); }
      else held.aliases.push({ label: row.label, pipelines: [row.pipeline] });
      continue;
    }
    byValue.set(row.name, {
      value: row.name, label: row.label, aliases: [{ label: row.label, pipelines: [row.pipeline] }],
      pipelines: [row.pipeline], closed: row.is_closed === 1, won: row.is_won === 1,
    });
  }
  // The general name is the label that matches the stored value — "Discovery"
  // for `discovery` — rather than one pipeline's own word for it.
  for (const stage of byValue.values()) {
    const general = stage.aliases.find((alias) => normalise(alias.label) === normalise(stage.value.replace(/_/g, ' ')));
    stage.label = general?.label
      ?? [...stage.aliases].sort((a, b) => b.label.length - a.label.length)[0].label;
  }
  const vocabulary = { pipelines, stages: [...byValue.values()] };
  vocabularyCache.set(key, { stamp, vocabulary });
  return vocabulary;
}

/** The currency books this workspace actually keeps, from its invoices. */
export function currencyBooks(ctx: Ctx, orgId: string): string[] {
  const books = new Set<string>();
  const invoices = billingSources(ctx.db).invoices;
  if (invoices?.currencyColumn) {
    for (const row of ctx.db.all<{ currency: string | null }>(
      `SELECT DISTINCT ${invoices.currencyColumn} AS currency FROM ${invoices.table} WHERE org_id = ? ORDER BY 1`, orgId)) {
      const code = normalise(row.currency ?? '');
      if (code) books.add(code);
    }
  }
  return [...books];
}
