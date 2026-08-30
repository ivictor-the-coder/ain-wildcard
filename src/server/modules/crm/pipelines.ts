import type { Ctx } from '../../kernel/context';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { newId } from '../../../shared/ids';
import { PIPELINE_BINDINGS, type PipelineSeed } from './builtin';
import type { PipelineBinding, PipelineDef, PipelineStageDef } from './types';

/**
 * Pipelines, and the stages that own the consequences of a stage change.
 *
 * A stage carries its probability, whether it closes the record and whether
 * that close is a win. Every derived field on a deal — probability, forecast
 * category, close date, days to close — is read from here on write, so the
 * board and the forecast cannot disagree with one another, and a rep never
 * types a probability. A workspace running new-business and renewal motions
 * gets two pipelines with genuinely different stages, exactly like the two
 * motions really are.
 */

export interface StageInput {
  name: string;
  label: string;
  description?: string | null;
  probability?: number;
  is_closed?: boolean;
  is_won?: boolean;
  forecast_category?: string | null;
  color?: string;
}

export interface PipelineInput {
  name: string;
  label: string;
  description?: string | null;
  is_default?: boolean;
  position?: number;
  stages: StageInput[];
}

export interface PipelinePatch {
  label?: string;
  description?: string | null;
  is_default?: boolean;
  archived?: boolean;
  position?: number;
  stages?: StageInput[];
}

export interface StageUsage {
  records: number;
  amount: number;
  weighted_amount: number;
}

interface PipelineRow {
  id: string; org_id: string; object_type: string; name: string; label: string;
  description: string | null; is_default: number; archived: number; system: number;
  position: number; created: number; updated: number;
}

interface StageRow {
  id: string; org_id: string; object_type: string; pipeline: string; name: string; label: string;
  description: string | null; probability: number; is_closed: number; is_won: number;
  forecast_category: string | null; color: string; position: number; created: number; updated: number;
}

const NAME_RE = /^[a-z][a-z0-9_]{1,60}$/;

export class Pipelines {
  private cache = new Map<string, PipelineDef[]>();

  constructor(private readonly ctx: Ctx, private readonly onSchemaChange: () => void) {}

  invalidate(): void { this.cache.clear(); }

  /* ------------------------------- bindings ------------------------------ */

  binding(objectType: string): PipelineBinding | null {
    return PIPELINE_BINDINGS.find((b) => b.object_type === objectType) ?? null;
  }

  requireBinding(objectType: string): PipelineBinding {
    const found = this.binding(objectType);
    if (!found) {
      const supported = PIPELINE_BINDINGS.map((b) => b.object_type).join(', ');
      throw badRequest(
        'pipelines_unsupported',
        `${objectType} records do not move through a pipeline. Pipelines exist for: ${supported}.`,
        'object_type',
      );
    }
    return found;
  }

  boundTypes(): string[] { return PIPELINE_BINDINGS.map((b) => b.object_type); }

  /* --------------------------------- reads ------------------------------- */

  list(orgId: string, objectType: string, opts: { includeArchived?: boolean } = {}): PipelineDef[] {
    const key = `${orgId}:${objectType}`;
    let all = this.cache.get(key);
    if (!all) {
      const rows = this.ctx.db.all<PipelineRow>(
        `SELECT * FROM crm_pipelines WHERE org_id = ? AND object_type = ? ORDER BY position, label`, orgId, objectType);
      const stages = this.ctx.db.all<StageRow>(
        `SELECT * FROM crm_pipeline_stages WHERE org_id = ? AND object_type = ? ORDER BY pipeline, position`, orgId, objectType);
      all = rows.map((row) => hydrate(row, stages.filter((s) => s.pipeline === row.name)));
      this.cache.set(key, all);
    }
    return opts.includeArchived ? all : all.filter((p) => !p.archived);
  }

  find(orgId: string, objectType: string, key: string): PipelineDef | null {
    return this.list(orgId, objectType, { includeArchived: true })
      .find((p) => p.name === key || p.id === key) ?? null;
  }

  get(orgId: string, objectType: string, key: string): PipelineDef {
    const found = this.find(orgId, objectType, key);
    if (!found) {
      const known = this.list(orgId, objectType).map((p) => p.name).join(', ');
      throw notFound(`pipeline "${key}" on ${objectType}. Known pipelines: ${known || 'none yet'}`);
    }
    return found;
  }

  defaultPipeline(orgId: string, objectType: string): PipelineDef | null {
    const all = this.list(orgId, objectType);
    return all.find((p) => p.is_default) ?? all[0] ?? null;
  }

  stage(orgId: string, objectType: string, pipeline: string, stage: string): PipelineStageDef | null {
    const found = this.find(orgId, objectType, pipeline);
    return found?.stages.find((s) => s.name === stage) ?? null;
  }

  /** Every pipeline that owns a stage of this name — the "wrong pipeline" hint. */
  pipelinesWithStage(orgId: string, objectType: string, stage: string): PipelineDef[] {
    return this.list(orgId, objectType).filter((p) => p.stages.some((s) => s.name === stage));
  }

  /** Stage names that do not close the record — what "open" means, from data. */
  openStages(orgId: string, objectType: string): string[] {
    const names = new Set<string>();
    for (const pipeline of this.list(orgId, objectType)) {
      for (const stage of pipeline.stages) if (!stage.is_closed) names.add(stage.name);
    }
    return [...names];
  }

  closedStages(orgId: string, objectType: string, opts: { wonOnly?: boolean } = {}): string[] {
    const names = new Set<string>();
    for (const pipeline of this.list(orgId, objectType)) {
      for (const stage of pipeline.stages) {
        if (stage.is_closed && (!opts.wonOnly || stage.is_won)) names.add(stage.name);
      }
    }
    return [...names];
  }

  /**
   * Live record counts and value per stage, straight out of the value index —
   * the numbers a board header shows, computed rather than cached.
   */
  usage(orgId: string, objectType: string): Map<string, StageUsage> {
    const binding = this.requireBinding(objectType);
    const amount = binding.amount_property;
    const rows = this.ctx.db.all<{ pipeline: string | null; stage: string | null; n: number; total: number }>(
      `SELECT pv.value_text AS pipeline, sv.value_text AS stage, COUNT(*) AS n,
              ${amount ? 'COALESCE(SUM(av.value_number), 0)' : '0'} AS total
         FROM crm_records r
         LEFT JOIN crm_record_values pv ON pv.record_id = r.id AND pv.property = ?
         LEFT JOIN crm_record_values sv ON sv.record_id = r.id AND sv.property = ?
         ${amount ? 'LEFT JOIN crm_record_values av ON av.record_id = r.id AND av.property = ?' : ''}
        WHERE r.org_id = ? AND r.object_type = ? AND r.archived = 0 AND r.merged_into IS NULL
        GROUP BY pv.value_text, sv.value_text`,
      binding.pipeline_property, binding.stage_property,
      ...(amount ? [amount] : []), orgId, objectType,
    );
    const out = new Map<string, StageUsage>();
    for (const row of rows) {
      if (!row.pipeline || !row.stage) continue;
      const stage = this.stage(orgId, objectType, row.pipeline, row.stage);
      const total = Math.round(row.total);
      out.set(`${row.pipeline}:${row.stage}`, {
        records: row.n,
        amount: total,
        weighted_amount: Math.round((total * (stage?.probability ?? 0)) / 100),
      });
    }
    return out;
  }

  /* -------------------------------- writes ------------------------------- */

  create(orgId: string, objectType: string, input: PipelineInput, opts: { system?: boolean; emit?: boolean } = {}): PipelineDef {
    this.requireBinding(objectType);
    if (!NAME_RE.test(input.name)) {
      throw badRequest('pipeline_name_invalid', 'A pipeline name must be lowercase letters, digits and underscores, e.g. "field_service".', 'name');
    }
    if (this.find(orgId, objectType, input.name)) {
      throw conflict('pipeline_exists', `A ${objectType} pipeline named "${input.name}" already exists.`, { pipeline: input.name });
    }
    const stages = this.validateStages(input.stages, objectType);
    const now = this.ctx.now();
    const existing = this.list(orgId, objectType, { includeArchived: true });
    const row = {
      id: newId('pipeline'), org_id: orgId, object_type: objectType, name: input.name,
      label: input.label, description: input.description ?? null,
      is_default: input.is_default || existing.length === 0 ? 1 : 0, archived: 0,
      system: opts.system ? 1 : 0, position: input.position ?? (existing.length + 1) * 10,
      created: now, updated: now,
    };
    this.ctx.db.insert('crm_pipelines', row);
    this.writeStages(orgId, objectType, input.name, stages, now);
    if (row.is_default) this.clearOtherDefaults(orgId, objectType, input.name);
    this.afterWrite(orgId, objectType);
    if (opts.emit !== false) {
      this.ctx.emit(orgId, 'pipeline.created', { object_type: objectType, name: input.name, label: input.label, stages: stages.length },
        { objectId: row.id, objectType: 'pipeline' });
    }
    return this.get(orgId, objectType, input.name);
  }

  update(orgId: string, objectType: string, key: string, patch: PipelinePatch): PipelineDef {
    const existing = this.get(orgId, objectType, key);
    const now = this.ctx.now();
    const changes: Record<string, unknown> = { updated: now };
    if (patch.label !== undefined) changes.label = patch.label;
    if (patch.description !== undefined) changes.description = patch.description;
    if (patch.position !== undefined) changes.position = patch.position;
    if (patch.is_default !== undefined) changes.is_default = patch.is_default ? 1 : 0;
    if (patch.archived !== undefined) {
      if (patch.archived) this.assertUnused(orgId, objectType, existing, 'archived');
      changes.archived = patch.archived ? 1 : 0;
    }

    if (patch.stages) {
      const stages = this.validateStages(patch.stages, objectType);
      const keep = new Set(stages.map((s) => s.name));
      for (const stage of existing.stages) {
        if (keep.has(stage.name)) continue;
        const used = this.recordsInStage(orgId, objectType, existing.name, stage.name);
        if (used > 0) {
          throw conflict(
            'stage_in_use',
            `${used} ${used === 1 ? 'record is' : 'records are'} in "${stage.label}". Move them to another stage before removing it.`,
            { stage: stage.name, records: used },
          );
        }
      }
      this.ctx.db.run(`DELETE FROM crm_pipeline_stages WHERE org_id = ? AND object_type = ? AND pipeline = ?`, orgId, objectType, existing.name);
      this.writeStages(orgId, objectType, existing.name, stages, now);
    }

    this.ctx.db.patch('crm_pipelines', 'id', existing.id, changes as Record<string, never>);
    if (patch.is_default) this.clearOtherDefaults(orgId, objectType, existing.name);
    this.afterWrite(orgId, objectType);
    this.ctx.emit(orgId, 'pipeline.updated', { object_type: objectType, name: existing.name, changes: Object.keys(changes) },
      { objectId: existing.id, objectType: 'pipeline', previous: { label: existing.label } });
    return this.get(orgId, objectType, existing.name);
  }

  remove(orgId: string, objectType: string, key: string): void {
    const existing = this.get(orgId, objectType, key);
    this.assertUnused(orgId, objectType, existing, 'deleted');
    if (this.list(orgId, objectType).length <= 1) {
      throw conflict('pipeline_last', `"${existing.label}" is the only ${objectType} pipeline. Create another one before deleting it.`);
    }
    this.ctx.db.run(`DELETE FROM crm_pipeline_stages WHERE org_id = ? AND object_type = ? AND pipeline = ?`, orgId, objectType, existing.name);
    this.ctx.db.run(`DELETE FROM crm_pipelines WHERE org_id = ? AND id = ?`, orgId, existing.id);
    this.afterWrite(orgId, objectType);
    if (existing.is_default) {
      const next = this.list(orgId, objectType)[0];
      if (next) {
        this.ctx.db.patch('crm_pipelines', 'id', next.id, { is_default: 1 });
        this.afterWrite(orgId, objectType);
      }
    }
    this.ctx.emit(orgId, 'pipeline.deleted', { object_type: objectType, name: existing.name }, { objectId: existing.id, objectType: 'pipeline' });
  }

  /** Bootstrap the pipelines a new workspace starts with. */
  install(orgId: string, seeds: PipelineSeed[]): void {
    for (const seed of seeds) {
      if (this.find(orgId, seed.object_type, seed.name)) continue;
      this.create(orgId, seed.object_type, {
        name: seed.name, label: seed.label, description: seed.description,
        is_default: seed.is_default, position: seed.position, stages: seed.stages,
      }, { system: true, emit: false });
    }
  }

  /* ------------------------------- internals ----------------------------- */

  private validateStages(stages: StageInput[], objectType: string): StageInput[] {
    if (!stages.length) {
      throw badRequest('pipeline_stages_required', 'A pipeline needs at least one stage.', 'stages');
    }
    const seen = new Set<string>();
    for (const [i, stage] of stages.entries()) {
      if (!NAME_RE.test(stage.name)) {
        throw badRequest('stage_name_invalid', `"${stage.name}" is not a valid stage name. Use lowercase letters, digits and underscores, e.g. "technical_validation".`, `stages[${i}].name`);
      }
      if (seen.has(stage.name)) {
        throw badRequest('stage_duplicate', `"${stage.name}" appears twice in this pipeline. Stage names are unique within a pipeline.`, `stages[${i}].name`);
      }
      seen.add(stage.name);
      const probability = stage.probability ?? 0;
      if (probability < 0 || probability > 100) {
        throw badRequest('stage_probability_invalid', `The probability for "${stage.label}" must be between 0 and 100.`, `stages[${i}].probability`);
      }
    }
    if (!stages.some((s) => s.is_closed || s.is_won)) {
      throw badRequest(
        'pipeline_needs_closed_stage',
        `Every ${objectType} pipeline needs at least one stage with "is_closed": true, or nothing ever leaves it.`,
        'stages',
      );
    }
    return stages;
  }

  private writeStages(orgId: string, objectType: string, pipeline: string, stages: StageInput[], now: number): void {
    stages.forEach((stage, index) => {
      const closed = stage.is_won ? true : stage.is_closed === true;
      this.ctx.db.insert('crm_pipeline_stages', {
        id: newId('stage'), org_id: orgId, object_type: objectType, pipeline, name: stage.name,
        label: stage.label, description: stage.description ?? null,
        probability: stage.is_won ? 100 : closed ? 0 : Math.round(stage.probability ?? 0),
        is_closed: closed ? 1 : 0, is_won: stage.is_won ? 1 : 0,
        forecast_category: stage.forecast_category ?? (closed ? 'closed' : null),
        color: stage.color ?? (stage.is_won ? 'green' : closed ? 'red' : 'gray'),
        position: (index + 1) * 10, created: now, updated: now,
      });
    });
  }

  private clearOtherDefaults(orgId: string, objectType: string, keep: string): void {
    this.ctx.db.run(
      `UPDATE crm_pipelines SET is_default = 0 WHERE org_id = ? AND object_type = ? AND name <> ?`,
      orgId, objectType, keep);
    this.invalidate();
  }

  private assertUnused(orgId: string, objectType: string, pipeline: PipelineDef, verb: string): void {
    const used = this.recordsInPipeline(orgId, objectType, pipeline.name);
    if (used > 0) {
      throw conflict(
        'pipeline_in_use',
        `${used} ${used === 1 ? 'record is' : 'records are'} still in the ${pipeline.label} pipeline, so it cannot be ${verb}. Move them first.`,
        { pipeline: pipeline.name, records: used },
      );
    }
  }

  private recordsInPipeline(orgId: string, objectType: string, pipeline: string): number {
    const binding = this.requireBinding(objectType);
    return this.ctx.db.count(
      `SELECT COUNT(*) FROM crm_record_values v JOIN crm_records r ON r.id = v.record_id
        WHERE v.org_id = ? AND v.object_type = ? AND v.property = ? AND v.value_text = ? AND r.archived = 0 AND r.merged_into IS NULL`,
      orgId, objectType, binding.pipeline_property, pipeline);
  }

  private recordsInStage(orgId: string, objectType: string, pipeline: string, stage: string): number {
    const binding = this.requireBinding(objectType);
    return this.ctx.db.count(
      `SELECT COUNT(*) FROM crm_records r
         JOIN crm_record_values pv ON pv.record_id = r.id AND pv.property = ?
         JOIN crm_record_values sv ON sv.record_id = r.id AND sv.property = ?
        WHERE r.org_id = ? AND r.object_type = ? AND pv.value_text = ? AND sv.value_text = ?
          AND r.archived = 0 AND r.merged_into IS NULL`,
      binding.pipeline_property, binding.stage_property, orgId, objectType, pipeline, stage);
  }

  private afterWrite(orgId: string, objectType: string): void {
    this.invalidate();
    this.syncProperties(orgId, objectType);
    this.onSchemaChange();
  }

  /**
   * The `pipeline` and stage properties are ordinary enums, so every list,
   * filter and form already understands them — but their options are generated
   * from the pipelines rather than hand-maintained, which is what stops the two
   * from drifting apart.
   */
  syncProperties(orgId: string, objectType: string): void {
    const binding = this.binding(objectType);
    if (!binding) return;
    const pipelines = this.list(orgId, objectType);
    if (!pipelines.length) return;
    const now = this.ctx.now();

    const pipelineOptions = pipelines.map((p, i) => ({
      value: p.name, label: p.label, color: 'violet',
      description: p.description ?? undefined, position: i,
    }));

    const stageOptions: { value: string; label: string; color: string; description: string; position: number }[] = [];
    const byName = new Map<string, { label: string; color: string; pipelines: string[] }>();
    for (const pipeline of pipelines) {
      for (const stage of pipeline.stages) {
        const entry = byName.get(stage.name);
        if (entry) { entry.pipelines.push(pipeline.label); continue; }
        byName.set(stage.name, { label: stage.label, color: stage.color, pipelines: [pipeline.label] });
      }
    }
    let position = 0;
    for (const [name, entry] of byName) {
      stageOptions.push({
        value: name, label: entry.label, color: entry.color,
        description: `${entry.pipelines.join(', ')} pipeline${entry.pipelines.length > 1 ? 's' : ''}`,
        position: position++,
      });
    }

    const write = (property: string, options: unknown[], defaultValue: string | null): void => {
      const exists = this.ctx.db.get<{ name: string }>(
        `SELECT name FROM crm_properties WHERE org_id = ? AND object_type = ? AND name = ?`, orgId, objectType, property);
      if (!exists) return;
      this.ctx.db.run(
        `UPDATE crm_properties SET options = ?, default_value = ?, updated = ? WHERE org_id = ? AND object_type = ? AND name = ?`,
        JSON.stringify(options), defaultValue === null ? null : JSON.stringify(defaultValue), now, orgId, objectType, property);
    };

    const fallback = pipelines.find((p) => p.is_default) ?? pipelines[0];
    write(binding.pipeline_property, pipelineOptions, fallback.name);
    write(binding.stage_property, stageOptions, fallback.stages[0]?.name ?? null);
  }
}

function hydrate(row: PipelineRow, stages: StageRow[]): PipelineDef {
  return {
    object: 'pipeline',
    id: row.id, org_id: row.org_id, object_type: row.object_type, name: row.name, label: row.label,
    description: row.description, is_default: !!row.is_default, archived: !!row.archived,
    position: row.position, created: row.created, updated: row.updated,
    stages: stages
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        object: 'pipeline_stage' as const,
        id: s.id, pipeline: s.pipeline, object_type: s.object_type, name: s.name, label: s.label,
        description: s.description, probability: s.probability, is_closed: !!s.is_closed,
        is_won: !!s.is_won, forecast_category: s.forecast_category, color: s.color, position: s.position,
      })),
  };
}
