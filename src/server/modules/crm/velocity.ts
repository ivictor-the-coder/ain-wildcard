import type { Ctx } from '../../kernel/context';
import { DAY } from '../../../shared/time';
import type { Crm } from './store';
import { safeMinorUnits } from './pipelines';
import type { ChangeSource, CrmRecord, PipelineDef, PipelineStageDef, StageSpell } from './types';

/**
 * Stage velocity, read off the audit trail rather than stored.
 *
 * HubSpot answers "how long has this been sitting here" by auto-provisioning
 * three properties per stage per pipeline — `hs_date_entered_<id>`,
 * `hs_date_exited_<id>`, `hs_time_in_<id>` — which is dozens of columns that
 * exist only to cache something the history already knows. Ain keeps one
 * stamp (`stage_entered_at`, so the question is answerable with a filter) and
 * reconstructs everything else from the property history, which now has a
 * monotonic sequence and can therefore be replayed exactly.
 *
 * The consequence is that this works for stages a record left months ago, for
 * records that pre-date the stamp, and for a pipeline you rearranged
 * yesterday — none of which a per-stage cached column survives.
 */

interface StageRow {
  record_id: string;
  from_value: string | null;
  to_value: string | null;
  changed_at: number;
  seq: number;
  actor_id: string | null;
  source: ChangeSource;
}

interface SpellSeed {
  stage: string;
  entered_at: number;
  entered_by: string | null;
  source: ChangeSource | null;
  exited_at: number | null;
  moved_to: string | null;
}

/**
 * Replay one record's stage transitions into a list of continuous spells.
 * The row whose `from` is empty is the record being born into its first stage,
 * not a move; every other row closes the spell before it and opens the next.
 */
function replay(
  rows: StageRow[],
  born: { at: number; by: string | null; stage: string | null },
  currentStage: string | null,
  stampedEntry: number | null,
): SpellSeed[] {
  const spells: SpellSeed[] = [];
  let stage = born.stage;
  let enteredAt = born.at;
  let enteredBy = born.by;
  let source: ChangeSource | null = null;

  for (const row of rows) {
    const to = row.to_value;
    if (!to) continue;
    if (!row.from_value) {
      // The creation row. It names the stage the record started in; it is not
      // a move out of anything, so it opens the first spell instead of closing
      // one, and the record's own created timestamp is the honest entry time.
      stage = to;
      enteredAt = Math.min(enteredAt, row.changed_at);
      continue;
    }
    if (stage === null) stage = row.from_value;
    spells.push({ stage, entered_at: enteredAt, entered_by: enteredBy, source, exited_at: row.changed_at, moved_to: to });
    stage = to;
    enteredAt = row.changed_at;
    enteredBy = row.actor_id;
    source = row.source;
  }

  // A record whose current stage disagrees with its history — written before
  // history existed, or moved by a path that bypassed it — still gets a spell,
  // dated from its own stamp rather than invented.
  if (currentStage && stage !== currentStage) {
    if (stage !== null) {
      spells.push({ stage, entered_at: enteredAt, entered_by: enteredBy, source, exited_at: stampedEntry ?? enteredAt, moved_to: currentStage });
    }
    stage = currentStage;
    enteredAt = stampedEntry ?? enteredAt;
    enteredBy = null;
    source = null;
  }
  if (stage) {
    spells.push({ stage, entered_at: stampedEntry !== null && !spells.length ? stampedEntry : enteredAt, entered_by: enteredBy, source, exited_at: null, moved_to: null });
  }
  return spells;
}

const stageFinder = (pipelines: PipelineDef[], preferred: string | null) => {
  const ordered = [...pipelines].sort((a, b) => Number(b.name === preferred) - Number(a.name === preferred));
  return (name: string): { pipeline: PipelineDef; stage: PipelineStageDef } | null => {
    for (const pipeline of ordered) {
      const stage = pipeline.stages.find((s) => s.name === name);
      if (stage) return { pipeline, stage };
    }
    return null;
  };
};

const daysBetween = (from: number, to: number): number => Math.max(0, Math.round((to - from) / DAY));

/** Every stage one record has been through, oldest first. */
export function stageHistory(ctx: Ctx, crm: Crm, orgId: string, record: CrmRecord): StageSpell[] {
  const binding = crm.pipelines.requireBinding(orgId, record.object_type);
  const now = ctx.now();
  const pipelines = crm.pipelines.list(orgId, record.object_type, { includeArchived: true });
  const currentPipeline = record.properties[binding.pipeline_property];
  const find = stageFinder(pipelines, typeof currentPipeline === 'string' ? currentPipeline : null);

  const rows = crm.history(orgId, record.id, { property: binding.stage_property, order: 'asc', limit: 500 })
    .map((entry): StageRow => ({
      record_id: entry.record_id,
      from_value: entry.from_value === null ? null : String(entry.from_value),
      to_value: entry.to_value === null ? null : String(entry.to_value),
      changed_at: entry.changed_at,
      seq: entry.seq,
      actor_id: entry.actor_id,
      source: entry.source,
    }));

  const currentStage = record.properties[binding.stage_property];
  const stamped = binding.derived.stage_entered_at ? record.properties[binding.derived.stage_entered_at] : null;
  const seeds = replay(
    rows,
    { at: record.created, by: record.created_by, stage: null },
    typeof currentStage === 'string' ? currentStage : null,
    typeof stamped === 'number' ? stamped : null,
  );

  return seeds.map((seed) => {
    const found = find(seed.stage);
    const end = seed.exited_at ?? now;
    return {
      object: 'stage_spell' as const,
      pipeline: found?.pipeline.name ?? (typeof currentPipeline === 'string' ? currentPipeline : ''),
      pipeline_label: found?.pipeline.label ?? '',
      stage: seed.stage,
      stage_label: found?.stage.label ?? seed.stage,
      probability: found ? found.stage.probability : null,
      is_closed: found?.stage.is_closed ?? false,
      is_won: found?.stage.is_won ?? false,
      entered_at: seed.entered_at,
      exited_at: seed.exited_at,
      duration_ms: Math.max(0, end - seed.entered_at),
      days_in_stage: daysBetween(seed.entered_at, end),
      is_current: seed.exited_at === null,
      moved_by: seed.entered_by,
      source: seed.source,
      moved_to: seed.moved_to,
    };
  });
}

/* ------------------------------ the funnel -------------------------------- */

export interface StageVelocity {
  object: 'stage_velocity';
  stage: string;
  label: string;
  position: number;
  probability: number;
  is_closed: boolean;
  is_won: boolean;
  current_records: number;
  current_amount: number | null;
  current_weighted_amount: number | null;
  entered_records: number;
  completed_spells: number;
  median_days_in_stage: number | null;
  average_days_in_stage: number | null;
  median_days_waiting: number | null;
  longest_days_waiting: number | null;
  advance_rate: number | null;
  stalled_records: number;
  stalled_after_days: number | null;
}

export interface PipelineVelocity {
  object: 'pipeline_velocity';
  pipeline: string;
  label: string;
  object_type: string;
  generated_at: number;
  records: number;
  stalled_records: number;
  median_days_to_close: number | null;
  stages: StageVelocity[];
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

const mean = (values: number[]): number | null =>
  (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

/**
 * The Deal Stage Funnel, computed rather than cached: how many records have
 * ever been in each stage, how long they stayed, how many moved forward, and
 * which of the ones sitting there now have stopped moving.
 */
export function pipelineVelocity(
  ctx: Ctx, crm: Crm, orgId: string, objectType: string, pipelineKey: string,
): PipelineVelocity {
  const binding = crm.pipelines.requireBinding(orgId, objectType);
  const pipeline = crm.pipelines.get(orgId, objectType, pipelineKey);
  const now = ctx.now();
  const amountProperty = binding.amount_property;
  const enteredProperty = binding.derived.stage_entered_at;
  const closedProperty = binding.derived.closed_at;

  const records = ctx.db.all<{
    id: string; created: number; created_by: string | null; stage: string | null;
    amount: number | null; entered_at: number | null; closed_at: number | null;
  }>(
    `SELECT r.id, r.created, r.created_by,
            sv.value_text AS stage,
            ${amountProperty ? 'av.value_number' : 'NULL'} AS amount,
            ${enteredProperty ? 'ev.value_date' : 'NULL'} AS entered_at,
            ${closedProperty ? 'cv.value_date' : 'NULL'} AS closed_at
       FROM crm_records r
       JOIN crm_record_values pv ON pv.record_id = r.id AND pv.property = ?
       LEFT JOIN crm_record_values sv ON sv.record_id = r.id AND sv.property = ?
       ${amountProperty ? 'LEFT JOIN crm_record_values av ON av.record_id = r.id AND av.property = ?' : ''}
       ${enteredProperty ? 'LEFT JOIN crm_record_values ev ON ev.record_id = r.id AND ev.property = ?' : ''}
       ${closedProperty ? 'LEFT JOIN crm_record_values cv ON cv.record_id = r.id AND cv.property = ?' : ''}
      WHERE r.org_id = ? AND r.object_type = ? AND r.archived = 0 AND r.merged_into IS NULL
        AND pv.value_text = ?`,
    binding.pipeline_property, binding.stage_property,
    ...(amountProperty ? [amountProperty] : []),
    ...(enteredProperty ? [enteredProperty] : []),
    ...(closedProperty ? [closedProperty] : []),
    orgId, objectType, pipeline.name,
  );

  const byRecord = new Map<string, StageRow[]>();
  for (let i = 0; i < records.length; i += 400) {
    const chunk = records.slice(i, i + 400);
    const rows = ctx.db.all<StageRow>(
      `SELECT record_id, from_value, to_value, changed_at, seq, actor_id, source
         FROM crm_property_history
        WHERE org_id = ? AND property = ? AND record_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY changed_at ASC, seq ASC`,
      orgId, binding.stage_property, ...chunk.map((r) => r.id),
    );
    for (const row of rows) {
      const bucket = byRecord.get(row.record_id);
      if (bucket) bucket.push(row); else byRecord.set(row.record_id, [row]);
    }
  }

  interface Bucket {
    entered: number;
    completedDays: number[];
    advanced: number;
    waitingDays: number[];
    currentAmounts: number[];
  }
  const buckets = new Map<string, Bucket>();
  const bucketOf = (name: string): Bucket => {
    let bucket = buckets.get(name);
    if (!bucket) { bucket = { entered: 0, completedDays: [], advanced: 0, waitingDays: [], currentAmounts: [] }; buckets.set(name, bucket); }
    return bucket;
  };
  const positionOf = new Map(pipeline.stages.map((s) => [s.name, s.position]));
  const closeDurations: number[] = [];

  for (const record of records) {
    const seeds = replay(
      byRecord.get(record.id) ?? [],
      { at: record.created, by: record.created_by, stage: null },
      record.stage,
      record.entered_at,
    );
    for (const seed of seeds) {
      const bucket = bucketOf(seed.stage);
      bucket.entered++;
      if (seed.exited_at !== null) {
        bucket.completedDays.push(daysBetween(seed.entered_at, seed.exited_at));
        const from = positionOf.get(seed.stage);
        const to = seed.moved_to ? positionOf.get(seed.moved_to) : undefined;
        if (from !== undefined && to !== undefined && to > from) bucket.advanced++;
      } else {
        bucket.waitingDays.push(daysBetween(seed.entered_at, now));
        if (record.amount !== null) bucket.currentAmounts.push(record.amount);
      }
    }
    if (record.closed_at) closeDurations.push(daysBetween(record.created, record.closed_at));
  }

  let stalledTotal = 0;
  const stages: StageVelocity[] = pipeline.stages.map((stage) => {
    const bucket = bucketOf(stage.name);
    const medianCompleted = median(bucket.completedDays);
    // "Stalled" has to mean something a person can check, so it is measured
    // against how long this stage normally takes: twice its own median, never
    // less than three days. The threshold ships in the response.
    const threshold = medianCompleted === null ? null : Math.max(3, medianCompleted * 2);
    const stalled = threshold === null ? 0 : bucket.waitingDays.filter((d) => d > threshold).length;
    stalledTotal += stalled;
    const currentAmount = bucket.currentAmounts.reduce((a, b) => a + b, 0);
    return {
      object: 'stage_velocity' as const,
      stage: stage.name,
      label: stage.label,
      position: stage.position,
      probability: stage.probability,
      is_closed: stage.is_closed,
      is_won: stage.is_won,
      current_records: bucket.waitingDays.length,
      current_amount: amountProperty ? safeMinorUnits(currentAmount) : null,
      current_weighted_amount: amountProperty ? safeMinorUnits((currentAmount * stage.probability) / 100) : null,
      entered_records: bucket.entered,
      completed_spells: bucket.completedDays.length,
      median_days_in_stage: medianCompleted,
      average_days_in_stage: mean(bucket.completedDays),
      median_days_waiting: median(bucket.waitingDays),
      longest_days_waiting: bucket.waitingDays.length ? Math.max(...bucket.waitingDays) : null,
      advance_rate: bucket.completedDays.length
        ? Math.round((bucket.advanced / bucket.completedDays.length) * 100) / 100
        : null,
      stalled_records: stalled,
      stalled_after_days: threshold,
    };
  });

  return {
    object: 'pipeline_velocity',
    pipeline: pipeline.name,
    label: pipeline.label,
    object_type: objectType,
    generated_at: now,
    records: records.length,
    stalled_records: stalledTotal,
    median_days_to_close: median(closeDurations),
    stages,
  };
}
