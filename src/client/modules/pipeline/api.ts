/**
 * The shapes the deal board reads, and the reads themselves.
 *
 * Nothing in this module holds a figure of its own: a stage's probability, a
 * deal's weighted amount and the median time a stage takes are all computed by
 * the server and quoted here. Where this file does arithmetic — a column total —
 * it sums values the API returned for the deals actually on screen.
 */
import { useMemo } from 'react';
import { useQuery, type ListEnvelope, type QueryResult } from '@/client/kernel/api';

/* -------------------------------- payloads ------------------------------- */

export interface PipelineStage {
  id: string;
  name: string;
  label: string;
  description: string | null;
  probability: number;
  is_closed: boolean;
  is_won: boolean;
  forecast_category: string | null;
  color: string;
  position: number;
  record_count: number;
  /** Present only when the object type's pipeline binding names a money property. */
  amount?: number;
  weighted_amount?: number;
}

export interface Pipeline {
  object: 'pipeline';
  id: string;
  object_type: string;
  name: string;
  label: string;
  description: string | null;
  is_default: boolean;
  archived: boolean;
  position: number;
  pipeline_property: string;
  stage_property: string;
  record_count: number;
  open_amount?: number;
  weighted_amount?: number;
  won_amount?: number;
  stages: PipelineStage[];
}

export interface RecordAssociation {
  id: string;
  association_type: string;
  label: string;
  direction: 'outgoing' | 'incoming' | string;
  record_id: string;
  object_type: string;
  display_name: string;
  is_primary: boolean;
  created: number;
}

export interface DealRecord {
  object: 'record';
  id: string;
  object_type: string;
  display_name: string;
  properties: Record<string, unknown>;
  owner_id: string | null;
  source: string | null;
  archived: boolean;
  merged_into: string | null;
  created: number;
  updated: number;
  associations?: RecordAssociation[];
}

export interface PropertyOption { value: string; label: string }

export interface PropertyDef {
  name: string;
  label: string;
  description: string | null;
  type: string;
  group: string;
  required: boolean;
  read_only: boolean;
  calculated: string | null;
  options: PropertyOption[];
  currency?: string;
}

export interface WorkspaceUser {
  id: string;
  name: string;
  email: string;
  title: string | null;
  avatar_url: string | null;
  role: string;
}

export interface TimelineItem {
  id: string;
  kind: string;
  at: number;
  title: string;
  body: string | null;
  icon: string;
  actor_id: string | null;
  actor_type: string;
  record_id: string | null;
  data?: Record<string, unknown>;
}

export interface StageSpell {
  pipeline: string;
  pipeline_label: string;
  stage: string;
  stage_label: string;
  probability: number;
  is_closed: boolean;
  is_won: boolean;
  entered_at: number;
  exited_at: number | null;
  days_in_stage: number;
  is_current: boolean;
  moved_by: string | null;
  moved_to: string | null;
}

export interface StageHistory extends ListEnvelope<StageSpell> {
  record_id: string;
  stage_property: string;
  current_stage: string;
  days_in_current_stage: number;
  total_days: number;
}

export interface StageVelocity {
  stage: string;
  label: string;
  position: number;
  probability: number;
  is_closed: boolean;
  is_won: boolean;
  current_records: number;
  current_amount: number;
  current_weighted_amount: number;
  entered_records: number;
  median_days_in_stage: number;
  average_days_in_stage: number;
  median_days_waiting: number;
  longest_days_waiting: number;
  advance_rate: number;
  stalled_records: number;
  stalled_after_days: number;
}

export interface PipelineVelocity {
  pipeline: string;
  label: string;
  records: number;
  stalled_records: number;
  median_days_to_close: number;
  stages: StageVelocity[];
}

export interface DealListEnvelope extends ListEnvelope<DealRecord> {
  total_count: number;
}

export interface PropertyEnvelope extends ListEnvelope<PropertyDef> {
  groups: string[];
}

/* --------------------------------- reads --------------------------------- */

/** Every pipeline a deal can sit in, with its stages and live stage totals. */
export const usePipelines = (): QueryResult<ListEnvelope<Pipeline>> =>
  useQuery<ListEnvelope<Pipeline>>('/v1/pipelines/deal');

export const useDealProperties = (): QueryResult<PropertyEnvelope> =>
  useQuery<PropertyEnvelope>('/v1/objects/deal/properties');

export const useUsers = (): QueryResult<ListEnvelope<WorkspaceUser>> =>
  useQuery<ListEnvelope<WorkspaceUser>>('/v1/users');

export function useUserIndex(users: WorkspaceUser[] | undefined): Map<string, WorkspaceUser> {
  return useMemo(() => new Map((users ?? []).map((user) => [user.id, user])), [users]);
}

export const useVelocity = (pipeline: string | undefined): QueryResult<PipelineVelocity> =>
  useQuery<PipelineVelocity>(
    pipeline ? `/v1/pipelines/deal/${encodeURIComponent(pipeline)}/velocity` : null,
  );

/* -------------------------------- accessors ------------------------------ */

export const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));
export const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
export const maybeNum = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const dealStage = (deal: DealRecord): string => str(deal.properties.deal_stage);
export const dealPipeline = (deal: DealRecord): string => str(deal.properties.pipeline);
export const dealAmount = (deal: DealRecord): number => num(deal.properties.amount);
export const dealWeighted = (deal: DealRecord): number => num(deal.properties.weighted_amount);
export const dealCloseDate = (deal: DealRecord): number | null => maybeNum(deal.properties.close_date);
export const dealEnteredStage = (deal: DealRecord): number | null => maybeNum(deal.properties.stage_entered_at);

export const accountOf = (deal: DealRecord): RecordAssociation | undefined =>
  deal.associations?.find((a) => a.association_type === 'deal_to_company');

export const contactsOf = (deal: DealRecord): RecordAssociation[] =>
  (deal.associations ?? []).filter((a) => a.association_type === 'deal_to_contact');

/** The href a record of this type has a screen at, or null when none is registered. */
export const recordHref = (objectType: string, id: string): string => {
  if (objectType === 'deal') return `/deals/${encodeURIComponent(id)}`;
  if (objectType === 'company') return `/companies/${encodeURIComponent(id)}`;
  if (objectType === 'contact') return `/contacts/${encodeURIComponent(id)}`;
  return `/records/${objectType}/${encodeURIComponent(id)}`;
};

/* --------------------------------- totals -------------------------------- */

export interface ColumnTotals {
  deals: number;
  amount: number;
  weighted: number;
}

/** Sums the server's own `amount` and `weighted_amount` over the deals shown. */
export function totalsOf(deals: DealRecord[]): ColumnTotals {
  let amount = 0;
  let weighted = 0;
  for (const deal of deals) {
    amount += dealAmount(deal);
    weighted += dealWeighted(deal);
  }
  return { deals: deals.length, amount, weighted };
}

/* ------------------------------ stage moves ------------------------------ */

/**
 * What a stage move has to collect before it is allowed to land.
 *
 * Both sources are read from the workspace's own property definitions rather
 * than written down here: any property the deal object marks `required` that
 * this deal has not filled in, and — when the destination stage closes the deal
 * — the writable properties in the object's outcome group, because a deal that
 * closes with no reason recorded is a forecast review nobody can hold.
 */
export function stageRequirements(
  deal: DealRecord | null,
  stage: PipelineStage,
  properties: PropertyDef[],
): { required: PropertyDef[]; optional: PropertyDef[] } {
  const writable = properties.filter((p) => !p.read_only && !p.calculated);
  const empty = (name: string): boolean => {
    const value = deal?.properties[name];
    return value === undefined || value === null || value === '';
  };
  const required = writable.filter((p) => p.required && empty(p.name));
  const optional: PropertyDef[] = [];
  if (stage.is_closed) {
    for (const property of writable) {
      if (property.group.toLowerCase() !== 'outcome') continue;
      if (required.some((p) => p.name === property.name)) continue;
      // An outcome picklist is the reason the deal ended; the free-text ones
      // beside it are colour, so they are offered rather than demanded.
      if (property.type === 'enum' && empty(property.name)) required.push(property);
      else optional.push(property);
    }
  }
  return { required, optional };
}

export const emptyValue = (value: unknown): boolean =>
  value === undefined || value === null || value === '';
