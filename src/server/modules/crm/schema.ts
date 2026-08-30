import type { Migration } from '../../kernel/db';

/**
 * The CRM substrate. Records are stored twice on purpose: once as a JSON blob
 * (cheap to read whole, schemaless enough for user-defined objects) and once
 * decomposed into `crm_record_values`, one typed row per set property, so the
 * filter engine can index, compare and sort without ever parsing JSON in SQL.
 * The two are written in the same transaction and can never drift.
 */
export const CRM_MIGRATIONS: Migration[] = [
  {
    id: 'crm.0001_objects',
    sql: `
CREATE TABLE crm_object_types (
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  plural_label TEXT NOT NULL,
  description TEXT,
  icon TEXT NOT NULL DEFAULT 'circle',
  color TEXT,
  primary_property TEXT NOT NULL,
  secondary_property TEXT,
  searchable TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL DEFAULT 'record',
  system INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 100,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (org_id, name)
);
CREATE UNIQUE INDEX idx_crm_object_types_id ON crm_object_types(org_id, id);

CREATE TABLE crm_properties (
  org_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  name TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT 'Other',
  options TEXT NOT NULL DEFAULT '[]',
  reference_type TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  unique_value INTEGER NOT NULL DEFAULT 0,
  read_only INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  default_value TEXT,
  validation TEXT NOT NULL DEFAULT '{}',
  calculated TEXT,
  currency TEXT,
  position INTEGER NOT NULL DEFAULT 100,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (org_id, object_type, name)
);
CREATE INDEX idx_crm_properties_object ON crm_properties(org_id, object_type, position);

CREATE TABLE crm_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  display_name TEXT NOT NULL DEFAULT '',
  search_blob TEXT NOT NULL DEFAULT '',
  owner_id TEXT,
  source TEXT NOT NULL DEFAULT 'api',
  archived INTEGER NOT NULL DEFAULT 0,
  merged_into TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  created_by TEXT,
  updated_by TEXT
);
CREATE INDEX idx_crm_records_type ON crm_records(org_id, object_type, archived, created DESC);
CREATE INDEX idx_crm_records_owner ON crm_records(org_id, owner_id, archived);
CREATE INDEX idx_crm_records_updated ON crm_records(org_id, object_type, updated DESC);
CREATE INDEX idx_crm_records_merged ON crm_records(org_id, merged_into);

CREATE TABLE crm_record_values (
  record_id TEXT NOT NULL REFERENCES crm_records(id) ON DELETE CASCADE,
  property TEXT NOT NULL,
  org_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  value_text TEXT,
  value_number REAL,
  value_date INTEGER,
  PRIMARY KEY (record_id, property)
) WITHOUT ROWID;
CREATE INDEX idx_crm_values_text ON crm_record_values(org_id, object_type, property, value_text);
CREATE INDEX idx_crm_values_number ON crm_record_values(org_id, object_type, property, value_number);
CREATE INDEX idx_crm_values_date ON crm_record_values(org_id, object_type, property, value_date);

CREATE TABLE crm_property_history (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  property TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  changed_at INTEGER NOT NULL,
  actor_id TEXT,
  actor_type TEXT NOT NULL DEFAULT 'user',
  source TEXT NOT NULL DEFAULT 'user',
  request_id TEXT
);
CREATE INDEX idx_crm_history_record ON crm_property_history(org_id, record_id, changed_at DESC);
CREATE INDEX idx_crm_history_property ON crm_property_history(org_id, object_type, property, changed_at DESC);

CREATE TABLE crm_association_types (
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  id TEXT NOT NULL,
  from_object TEXT NOT NULL,
  to_object TEXT NOT NULL,
  label TEXT NOT NULL,
  inverse_label TEXT NOT NULL,
  cardinality TEXT NOT NULL DEFAULT 'many_to_many',
  system INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  PRIMARY KEY (org_id, name)
);

CREATE TABLE crm_associations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  association_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  created_by TEXT
);
CREATE UNIQUE INDEX idx_crm_assoc_unique ON crm_associations(org_id, association_type, from_id, to_id);
CREATE INDEX idx_crm_assoc_from ON crm_associations(org_id, from_id, to_type);
CREATE INDEX idx_crm_assoc_to ON crm_associations(org_id, to_id, from_type);

CREATE TABLE crm_views (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  columns TEXT NOT NULL DEFAULT '[]',
  filter TEXT,
  sort TEXT NOT NULL DEFAULT '[]',
  shared INTEGER NOT NULL DEFAULT 1,
  owner_id TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 100,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_crm_views_object ON crm_views(org_id, object_type, position);
`,
  },
  /**
   * Pipelines are records, not decoration. A stage owns its probability,
   * whether it closes the deal and whether that close counts as a win, so the
   * forecast is a consequence of where the card sits rather than a number a rep
   * re-types. The same migration canonicalises `domain`: a property declared
   * unique has to compare canonical bytes, or "unique" is a promise the
   * database does not keep.
   */
  {
    id: 'crm.0002_pipelines',
    sql: `
CREATE TABLE crm_pipelines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 100,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_crm_pipelines_name ON crm_pipelines(org_id, object_type, name);
CREATE INDEX idx_crm_pipelines_type ON crm_pipelines(org_id, object_type, position);

CREATE TABLE crm_pipeline_stages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  probability REAL NOT NULL DEFAULT 0,
  is_closed INTEGER NOT NULL DEFAULT 0,
  is_won INTEGER NOT NULL DEFAULT 0,
  forecast_category TEXT,
  color TEXT NOT NULL DEFAULT 'gray',
  position INTEGER NOT NULL DEFAULT 100,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_crm_stages_name ON crm_pipeline_stages(org_id, object_type, pipeline, name);
CREATE INDEX idx_crm_stages_pipeline ON crm_pipeline_stages(org_id, object_type, pipeline, position);

ALTER TABLE crm_properties ADD COLUMN normalize TEXT NOT NULL DEFAULT 'none';

CREATE TEMP TABLE _crm_domain_fix AS
  SELECT v.record_id AS record_id,
         v.value_text AS old_value,
         CASE WHEN lower(trim(v.value_text)) LIKE 'www.%'
              THEN substr(lower(trim(v.value_text)), 5)
              ELSE lower(trim(v.value_text)) END AS new_value
    FROM crm_record_values v
   WHERE v.property = 'domain' AND v.object_type = 'company' AND v.value_text IS NOT NULL;

UPDATE crm_records SET
  search_blob = replace(search_blob,
    lower((SELECT f.old_value FROM _crm_domain_fix f WHERE f.record_id = crm_records.id)),
    (SELECT f.new_value FROM _crm_domain_fix f WHERE f.record_id = crm_records.id)),
  properties = json_set(properties, '$.domain',
    (SELECT f.new_value FROM _crm_domain_fix f WHERE f.record_id = crm_records.id))
 WHERE id IN (SELECT record_id FROM _crm_domain_fix WHERE old_value <> new_value);

UPDATE crm_record_values SET
  value_text = (SELECT f.new_value FROM _crm_domain_fix f WHERE f.record_id = crm_record_values.record_id)
 WHERE property = 'domain' AND object_type = 'company'
   AND record_id IN (SELECT record_id FROM _crm_domain_fix WHERE old_value <> new_value);

DROP TABLE _crm_domain_fix;
`,
  },
];
