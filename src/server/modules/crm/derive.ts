import { badRequest } from '../../../shared/errors';
import { DAY, MINUTE, startOfDay } from '../../../shared/time';
import type { Pipelines } from './pipelines';
import type { PipelineStageDef, PropertyValue } from './types';
import { isEmptyValue, valuesEqual } from './values';

/**
 * What a stage change means, applied on the write itself.
 *
 * Moving a deal to Closed won is one field on the wire. Everything else — the
 * probability, the forecast category, the close date, the cycle time — is a
 * consequence, and consequences belong in the write path, not in a listener
 * that runs after the response has already been serialised. That is the
 * difference between a board you can trust and a board that says a closed-won
 * $100,000 deal is worth $50,000 of weighted forecast forever.
 */

export interface DeriveInput {
  orgId: string;
  objectType: string;
  /** The record's properties after the caller's own writes; mutated in place. */
  values: Record<string, PropertyValue>;
  /** Whether a property exists on this object type. */
  has: (property: string) => boolean;
  /** Property names the caller explicitly set in this request. */
  incoming: Set<string>;
  /** The record's properties before this write; absent when creating. */
  previous?: Record<string, PropertyValue>;
  createdAt: number;
  now: number;
}

export interface DeriveResult {
  stage: PipelineStageDef | null;
  changed: string[];
}

const text = (value: PropertyValue | undefined): string =>
  (isEmptyValue(value) ? '' : String(value));

const stageList = (stages: PipelineStageDef[]): string =>
  stages.map((s) => s.name).join(', ');

/**
 * Resolve the record's pipeline and stage, reject a stage that belongs to a
 * different pipeline, and restamp everything the stage owns.
 */
export function deriveStage(pipelines: Pipelines, input: DeriveInput): DeriveResult {
  const binding = pipelines.binding(input.orgId, input.objectType);
  if (!binding) return { stage: null, changed: [] };
  const { orgId, objectType, values, has } = input;
  if (!has(binding.pipeline_property) || !has(binding.stage_property)) return { stage: null, changed: [] };

  const available = pipelines.list(orgId, objectType);
  if (!available.length) return { stage: null, changed: [] };

  const changed: string[] = [];
  const set = (property: string, value: PropertyValue): void => {
    if (!has(property)) return;
    const current = values[property] ?? null;
    if (valuesEqual(current, value)) return;
    if (isEmptyValue(value)) delete values[property];
    else values[property] = value;
    changed.push(property);
  };

  /* ------------------------------- pipeline ------------------------------ */

  const pipelineName = text(values[binding.pipeline_property]);
  let pipeline = pipelineName ? pipelines.find(orgId, objectType, pipelineName) : null;
  if (pipelineName && (!pipeline || pipeline.archived)) {
    throw badRequest(
      pipeline ? 'pipeline_archived' : 'pipeline_unknown',
      pipeline
        ? `The ${pipeline.label} pipeline is archived, so nothing new can be put into it. Active pipelines: ${available.map((p) => p.name).join(', ')}.`
        : `"${pipelineName}" is not a ${binding.noun} in this workspace. Available: ${available.map((p) => p.name).join(', ')}. See GET /v1/pipelines/${objectType}.`,
      `properties.${binding.pipeline_property}`,
    );
  }
  if (!pipeline) {
    pipeline = pipelines.defaultPipeline(orgId, objectType);
    if (!pipeline) return { stage: null, changed };
    set(binding.pipeline_property, pipeline.name);
  }

  /* --------------------------------- stage ------------------------------- */

  const stageName = text(values[binding.stage_property]);
  let stage = stageName ? pipeline.stages.find((s) => s.name === stageName) ?? null : null;

  if (!stage) {
    const movedPipeline = input.incoming.has(binding.pipeline_property) && !input.incoming.has(binding.stage_property);
    if (!stageName || movedPipeline) {
      // Moving between pipelines without naming a stage lands on the entry
      // stage of the new one, which is the only stage guaranteed to be legal.
      stage = pipeline.stages[0];
      set(binding.stage_property, stage.name);
    } else {
      const elsewhere = pipelines.pipelinesWithStage(orgId, objectType, stageName).filter((p) => p.name !== pipeline!.name);
      if (elsewhere.length) {
        throw badRequest(
          'stage_wrong_pipeline',
          `"${stageName}" belongs to the ${elsewhere.map((p) => p.label).join(' and ')} pipeline, not ${pipeline.label}. ${pipeline.label} stages: ${stageList(pipeline.stages)}.`,
          `properties.${binding.stage_property}`,
        );
      }
      throw badRequest(
        'stage_unknown',
        `"${stageName}" is not a stage of the ${pipeline.label} pipeline. Stages: ${stageList(pipeline.stages)}.`,
        `properties.${binding.stage_property}`,
      );
    }
  }

  /* ------------------------- what the stage owns ------------------------- */

  const derived = binding.derived;

  // "Which deals are stuck" is the question a pipeline exists to answer, and
  // it needs one fact nobody types: when this record arrived where it is. The
  // stamp only moves when the stage does, so a rename or an amount edit never
  // resets the clock a forecast review is reading.
  if (derived.stage_entered_at) {
    // A record written before this stamp existed keeps an empty one rather
    // than a fabricated "arrived just now" — the stage history knows the truth
    // and the velocity report reads it from there.
    if (!input.previous) set(derived.stage_entered_at, input.createdAt);
    else if (text(input.previous[binding.stage_property]) !== stage.name) set(derived.stage_entered_at, input.now);
  }

  if (derived.probability) set(derived.probability, stage.probability);
  if (derived.forecast_category && stage.forecast_category) set(derived.forecast_category, stage.forecast_category);
  if (derived.status) set(derived.status, stage.is_closed ? (stage.is_won ? 'won' : 'lost') : 'open');

  if (stage.is_closed) {
    const existingStamp = Number(values[derived.closed_at ?? ''] ?? 0);
    const alreadyClosed = Number.isFinite(existingStamp) && existingStamp > 0;
    const closedAt = alreadyClosed ? existingStamp : input.now;
    if (derived.closed_at) set(derived.closed_at, closedAt);
    // The day it actually closed is the day the forecast should count it in,
    // whatever date the rep was hoping for last month — unless this same write
    // says otherwise. Editable afterwards like any other date.
    if (!alreadyClosed && derived.expected_close_date && !input.incoming.has(derived.expected_close_date)) {
      set(derived.expected_close_date, startOfDay(closedAt));
    }
    const elapsed = Math.max(0, closedAt - input.createdAt);
    if (derived.days_to_close) set(derived.days_to_close, Math.round(elapsed / DAY));
    if (derived.minutes_to_close) set(derived.minutes_to_close, Math.round(elapsed / MINUTE));
  } else {
    // Reopening a record has to clear the stamps, or the reports keep counting
    // it as closed business.
    if (derived.closed_at) set(derived.closed_at, null);
    if (derived.days_to_close) set(derived.days_to_close, null);
    if (derived.minutes_to_close) set(derived.minutes_to_close, null);
  }

  return { stage, changed };
}

/**
 * The explanation attached to "you cannot write this property": which stage
 * owns it, and where to change it instead.
 */
export function stageOwnedExplanation(
  pipelines: Pipelines, orgId: string, objectType: string, property: string,
): string | null {
  const binding = pipelines.binding(orgId, objectType);
  if (!binding) return null;
  const owned: Record<string, string> = {};
  if (binding.derived.stage_entered_at) owned[binding.derived.stage_entered_at] = 'the moment it last moved stage';
  if (binding.derived.probability) owned[binding.derived.probability] = 'the probability of the stage it sits in';
  if (binding.derived.forecast_category) owned[binding.derived.forecast_category] = 'the forecast category of its stage';
  if (binding.derived.status) owned[binding.derived.status] = 'whether its stage is closed, and whether that close is a win';
  if (binding.derived.closed_at) owned[binding.derived.closed_at] = 'the moment it reached a closed stage';
  if (binding.derived.days_to_close) owned[binding.derived.days_to_close] = 'the time between creation and the close stamp';
  if (binding.derived.minutes_to_close) owned[binding.derived.minutes_to_close] = 'the time between creation and the close stamp';
  const reason = owned[property];
  if (!reason) return null;
  return `It follows ${reason}. Set \`${binding.stage_property}\` instead, or change the stage itself with PATCH /v1/pipelines/${objectType}/{pipeline}.`;
}
