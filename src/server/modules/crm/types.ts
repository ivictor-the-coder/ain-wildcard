/** The vocabulary of the CRM substrate. Every other module speaks this. */

export type PropertyType =
  | 'string' | 'text' | 'number' | 'currency' | 'date' | 'datetime' | 'bool'
  | 'enum' | 'multi_enum' | 'url' | 'email' | 'phone' | 'user' | 'reference'
  | 'json' | 'computed';

export type PropertyValue = string | number | boolean | string[] | Record<string, unknown> | null;

export type ChangeSource = 'user' | 'import' | 'workflow' | 'agent' | 'api' | 'merge' | 'system';

/**
 * Canonicalisation applied to a value before it is stored, indexed and
 * compared. This is what makes a "unique" property actually unique:
 * `ANDINAENVASES.CL`, `www.andinaenvases.cl` and `andinaenvases.cl ` all
 * become the same bytes, so the uniqueness check, the duplicate finder and
 * the filter engine can never disagree about whether two records match.
 */
export type PropertyNormaliser = 'none' | 'lower' | 'upper' | 'domain' | 'digits';

export type ActorType = 'user' | 'api_key' | 'system' | 'agent' | 'workflow';

export interface PropertyOption {
  value: string;
  label: string;
  /** Design-token colour name (`violet`, `teal`, …) resolved by the client. */
  color?: string;
  description?: string;
  position?: number;
}

export interface PropertyValidation {
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  pattern?: string;
  /** Values outside the option list are rejected for enums unless this is true. */
  allow_other?: boolean;
}

export interface PropertyDef {
  org_id: string;
  object_type: string;
  name: string;
  id: string;
  label: string;
  description: string | null;
  type: PropertyType;
  group: string;
  options: PropertyOption[];
  reference_type: string | null;
  required: boolean;
  unique: boolean;
  read_only: boolean;
  system: boolean;
  hidden: boolean;
  default_value: PropertyValue;
  validation: PropertyValidation;
  /** Expression evaluated on every write; makes the property derived. */
  calculated: string | null;
  /** Canonical form applied on write, before uniqueness and indexing. */
  normalize: PropertyNormaliser;
  currency: string | null;
  position: number;
  created: number;
  updated: number;
}

export interface ObjectTypeDef {
  org_id: string;
  name: string;
  id: string;
  label: string;
  plural_label: string;
  description: string | null;
  icon: string;
  color: string | null;
  primary_property: string;
  secondary_property: string | null;
  searchable: string[];
  /** `record` for business objects, `activity` for engagements on a timeline. */
  category: 'record' | 'activity';
  system: boolean;
  position: number;
  created: number;
  updated: number;
}

/* -------------------------------- pipelines ------------------------------- */

/**
 * A stage is the unit that carries consequence: its probability drives the
 * forecast, `is_closed` stamps the close date and `is_won` decides whether the
 * deal counts as bookings. Nothing about a stage is typed in by a rep.
 */
export interface PipelineStageDef {
  object: 'pipeline_stage';
  id: string;
  pipeline: string;
  object_type: string;
  name: string;
  label: string;
  description: string | null;
  /** 0–100. The forecast reads this, never a hand-typed number. */
  probability: number;
  is_closed: boolean;
  is_won: boolean;
  forecast_category: string | null;
  color: string;
  position: number;
}

export interface PipelineDef {
  object: 'pipeline';
  id: string;
  org_id: string;
  object_type: string;
  name: string;
  label: string;
  description: string | null;
  is_default: boolean;
  archived: boolean;
  position: number;
  stages: PipelineStageDef[];
  created: number;
  updated: number;
}

/**
 * How an object type is wired to its pipelines: which property names the
 * pipeline, which one names the stage, and which properties the stage owns.
 * Everything the stage owns is refused on write with a message pointing at the
 * stage, so a deal's probability can never disagree with where it sits.
 */
export interface PipelineBinding {
  object_type: string;
  /** Human name used in error copy: "sales pipeline", "support pipeline". */
  noun: string;
  pipeline_property: string;
  stage_property: string;
  /** Money property summed for the board header, when the object has one. */
  amount_property?: string;
  derived: {
    probability?: string;
    forecast_category?: string;
    status?: string;
    closed_at?: string;
    days_to_close?: string;
    minutes_to_close?: string;
    /** Rep-set expected close date, snapped to reality the day it closes. */
    expected_close_date?: string;
    /** When the record entered the stage it is in now — stage velocity. */
    stage_entered_at?: string;
  };
  /** True when the binding was provisioned onto a user-defined object type. */
  custom?: boolean;
}

export interface CrmRecord {
  object: 'record';
  id: string;
  object_type: string;
  properties: Record<string, PropertyValue>;
  display_name: string;
  owner_id: string | null;
  source: string;
  archived: boolean;
  merged_into: string | null;
  created: number;
  updated: number;
  created_by: string | null;
  updated_by: string | null;
  associations?: AssociationSummary[];
}

export interface AssociationSummary {
  id: string;
  association_type: string;
  label: string;
  direction: 'outgoing' | 'incoming';
  record_id: string;
  object_type: string;
  display_name: string;
  is_primary: boolean;
  created: number;
}

export interface AssociationTypeDef {
  org_id: string;
  name: string;
  id: string;
  from_object: string;
  to_object: string;
  label: string;
  inverse_label: string;
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  system: boolean;
  created: number;
}

export interface HistoryEntry {
  object: 'property_history';
  id: string;
  record_id: string;
  object_type: string;
  property: string;
  property_label: string;
  from_value: PropertyValue;
  to_value: PropertyValue;
  changed_at: number;
  /**
   * Monotonic write order. `changed_at` alone cannot order an audit trail:
   * a save is one clock tick, and several land inside it. `(changed_at, seq)`
   * is a total order, and it is what history cursors page on.
   */
  seq: number;
  /** The save this row belongs to. Rows sharing it changed together. */
  write_id: string;
  actor_id: string | null;
  actor_type: ActorType;
  source: ChangeSource;
}

/** One page of property history, ordered newest first on (changed_at, seq). */
export interface HistoryPage {
  entries: HistoryEntry[];
  has_more: boolean;
  next_cursor: string | null;
}

/** One continuous spell a record spent in one stage, read off its history. */
export interface StageSpell {
  object: 'stage_spell';
  pipeline: string;
  pipeline_label: string;
  stage: string;
  stage_label: string;
  probability: number | null;
  is_closed: boolean;
  is_won: boolean;
  entered_at: number;
  exited_at: number | null;
  /** Milliseconds in the stage; for the current stage, up to `ctx.now()`. */
  duration_ms: number;
  days_in_stage: number;
  is_current: boolean;
  /** Who moved the record *into* this stage — the compliance answer. */
  moved_by: string | null;
  source: ChangeSource | null;
  /** The stage it went to next; null while the record is still here. */
  moved_to: string | null;
}

/* ------------------------------- filtering ------------------------------- */

export type FilterOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'not_contains' | 'starts_with' | 'ends_with'
  | 'in' | 'not_in' | 'is_set' | 'is_not_set'
  | 'between' | 'before' | 'after' | 'within_last' | 'within_next';

export const FILTER_OPERATORS: FilterOperator[] = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'starts_with',
  'ends_with', 'in', 'not_in', 'is_set', 'is_not_set', 'between', 'before', 'after',
  'within_last', 'within_next',
];

export type RelativeUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface PropertyCondition {
  property: string;
  operator: FilterOperator;
  value?: unknown;
  /** For `in` / `not_in` / `between`. */
  values?: unknown[];
  /** For `within_last` / `within_next`; defaults to `day`. */
  unit?: RelativeUnit;
  /** Compare against another property instead of a literal. */
  compare_property?: string;
}

export interface AssociationCondition {
  /** Associated object type (`deal`) or association type name (`deal_to_company`). */
  association: string;
  /** Which way to walk the graph. `both` is the default and the usual answer. */
  direction?: 'outgoing' | 'incoming' | 'both';
  /** Restrict the associated records before aggregating. */
  where?: FilterNode;
  /** Defaults to `count`. */
  aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** Property on the associated record to aggregate; required unless `count`. */
  aggregate_property?: string;
  operator: FilterOperator;
  value?: unknown;
  values?: unknown[];
  unit?: RelativeUnit;
}

export interface FilterGroup {
  op: 'and' | 'or' | 'not';
  filters: FilterNode[];
}

export type FilterNode = FilterGroup | PropertyCondition | AssociationCondition;

export interface SortSpec {
  property: string;
  direction?: 'asc' | 'desc';
}

export interface SearchQuery {
  filter?: FilterNode;
  /** Free-text across the object's searchable properties. */
  query?: string;
  sort?: SortSpec[];
  /** Property names to return; omit for the whole record. */
  properties?: string[];
  limit?: number;
  /** Opaque pagination token from the previous page's `next_cursor`. */
  after?: string;
  include_archived?: boolean;
  /** `associations` attaches the record's edges; `owner` is resolved by the API layer. */
  expand?: string[];
  /** Restrict to records associated with this record (any association type). */
  associated_to?: string;
}

export interface SearchResult {
  records: CrmRecord[];
  total: number;
  has_more: boolean;
  next_cursor: string | null;
  /** The SQL the filter compiled to — surfaced in the API for explainability. */
  explain: { sql: string; params: unknown[]; ms: number };
}

export interface TimelineItem {
  object: 'timeline_item';
  id: string;
  kind: 'activity' | 'property_change' | 'event' | 'association';
  at: number;
  title: string;
  body: string | null;
  icon: string;
  actor_id: string | null;
  actor_type: ActorType;
  record_id: string;
  /** Present when the item came from a record associated to the subject. */
  via: { id: string; object_type: string; display_name: string } | null;
  data: Record<string, unknown>;
}

export interface ViewDef {
  object: 'view';
  id: string;
  org_id: string;
  object_type: string;
  name: string;
  description: string | null;
  columns: string[];
  filter: FilterNode | null;
  sort: SortSpec[];
  shared: boolean;
  owner_id: string | null;
  is_default: boolean;
  system: boolean;
  position: number;
  created: number;
  updated: number;
}

export interface WriteOptions {
  actorId?: string | null;
  actorType?: ActorType;
  source?: ChangeSource;
  requestId?: string | null;
  /** Seeds and imports write history but stay off the event stream. */
  emit?: boolean;
  /** Set false to skip the property-history rows (bulk seeding). */
  history?: boolean;
  /** Record id to use instead of a generated one (seeding, imports). */
  id?: string;
  createdAt?: number;
  ownerId?: string | null;
  /**
   * Groups every history row this call writes into one save. Set it to fold
   * several store calls (a merge, a batch item) into a single timeline entry;
   * leave it unset and each call gets its own.
   */
  writeId?: string;
}
