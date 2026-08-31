import { createHash } from 'node:crypto';
import { parseJson } from '../../kernel/db';
import type { Ctx } from '../../kernel/context';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { newId, randomId } from '../../../shared/ids';
import { compileFilter, compileSort, isBuiltinProperty, type CompileEnv, type PropertyIndex } from './filter';
import { analyzeExpression, evaluateExpression, ExpressionError } from './expr';
import {
  MAX_MINOR_UNITS, MAX_NUMBER, NORMALISERS, canonicalLookupValue, coerceValue, historyText,
  indexValue, isEmptyValue, valuesEqual,
} from './values';
import { Pipelines } from './pipelines';
import { deriveStage, stageOwnedExplanation } from './derive';
import type {
  ActorType, AssociationSummary, AssociationTypeDef, ChangeSource, CrmRecord, FilterNode, HistoryEntry,
  HistoryPage, ObjectTypeDef, PropertyDef, PropertyValue, SearchQuery, SearchResult, ViewDef, WriteOptions,
} from './types';

/** How the audit trail is read: filtered, ordered, and paged on a real cursor. */
export interface HistoryQuery {
  limit?: number;
  property?: string;
  /** Only changes strictly before this instant (unix ms). */
  before?: number;
  /** Only changes at or after this instant (unix ms). */
  since?: number;
  /** Opaque cursor from a previous page's `next_cursor`. */
  after?: string;
  order?: 'asc' | 'desc';
}

interface HistoryRow {
  id: string; org_id: string; record_id: string; object_type: string; property: string;
  from_value: string | null; to_value: string | null; changed_at: number; seq: number;
  write_id: string; actor_id: string | null; actor_type: ActorType; source: ChangeSource;
  request_id: string | null;
}

interface RecordRow {
  id: string; org_id: string; object_type: string; properties: string; display_name: string;
  search_blob: string; owner_id: string | null; source: string; archived: number;
  merged_into: string | null; created: number; updated: number;
  created_by: string | null; updated_by: string | null;
}

interface PropertyRow {
  org_id: string; object_type: string; name: string; id: string; label: string; description: string | null;
  type: PropertyDef['type']; group_name: string; options: string; reference_type: string | null;
  required: number; unique_value: number; read_only: number; system: number; hidden: number;
  default_value: string | null; validation: string; calculated: string | null; currency: string | null;
  normalize: string; position: number; created: number; updated: number;
}

interface ObjectTypeRow {
  org_id: string; name: string; id: string; label: string; plural_label: string; description: string | null;
  icon: string; color: string | null; primary_property: string; secondary_property: string | null;
  searchable: string; category: string; system: number; position: number; created: number; updated: number;
}

export interface AssociateInput {
  fromId: string;
  toId: string;
  associationType?: string;
  primary?: boolean;
}

/**
 * The CRM engine. Every write goes through here so that the JSON blob, the
 * typed value index, the property history and the event stream can never
 * disagree with one another.
 */
export class Crm {
  private propertyCache = new Map<string, PropertyIndex>();
  private objectCache = new Map<string, ObjectTypeDef>();
  /** Pipelines live beside the schema: a stage change is a schema-driven write. */
  readonly pipelines: Pipelines;
  /** Lazily seeded from the table so restarts continue the sequence. */
  private historySeq: number | null = null;

  constructor(private readonly ctx: Ctx) {
    this.pipelines = new Pipelines(ctx, () => this.invalidateSchema());
  }

  /**
   * The audit trail's ordering key. A millisecond clock cannot order writes —
   * six of them land in the same tick every time a stage moves — so every
   * history row gets a number that only ever goes up, and cursors page on it.
   */
  private nextHistorySeq(): number {
    if (this.historySeq === null) {
      this.historySeq = this.ctx.db.count(`SELECT COALESCE(MAX(seq), 0) FROM crm_property_history`);
    }
    this.historySeq += 1;
    return this.historySeq;
  }

  /** Drop the schema cache after a bulk install writes rows directly. */
  reloadSchema(): void { this.invalidateSchema(); }

  private invalidateSchema(): void {
    this.propertyCache.clear();
    this.objectCache.clear();
    this.pipelines.invalidate();
  }

  /* ------------------------------ object types --------------------------- */

  objectTypes(orgId: string): ObjectTypeDef[] {
    return this.ctx.db
      .all<ObjectTypeRow>(`SELECT * FROM crm_object_types WHERE org_id = ? ORDER BY position, label`, orgId)
      .map(hydrateObjectType);
  }

  objectTypeOrNull(orgId: string, name: string): ObjectTypeDef | null {
    const key = `${orgId}:${name}`;
    const cached = this.objectCache.get(key);
    if (cached) return cached;
    const row = this.ctx.db.get<ObjectTypeRow>(`SELECT * FROM crm_object_types WHERE org_id = ? AND name = ?`, orgId, name);
    if (!row) return null;
    const hydrated = hydrateObjectType(row);
    this.objectCache.set(key, hydrated);
    return hydrated;
  }

  objectType(orgId: string, name: string): ObjectTypeDef {
    const found = this.objectTypeOrNull(orgId, name);
    if (!found) {
      const known = this.objectTypes(orgId).map((o) => o.name).join(', ');
      throw notFound(`object type "${name}". Known types: ${known}`);
    }
    return found;
  }

  activityTypes(orgId: string): string[] {
    return this.objectTypes(orgId).filter((o) => o.category === 'activity').map((o) => o.name);
  }

  createObjectType(orgId: string, input: Partial<ObjectTypeDef> & { name: string; label: string; plural_label: string }): ObjectTypeDef {
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(input.name)) {
      throw badRequest('object_name_invalid', 'An object type name must be lowercase letters, digits and underscores, e.g. "work_order".', 'name');
    }
    if (this.objectTypeOrNull(orgId, input.name)) {
      throw conflict('object_type_exists', `An object type named "${input.name}" already exists in this workspace.`);
    }
    const now = this.ctx.now();
    const row = {
      org_id: orgId, name: input.name, id: newId('object'), label: input.label,
      plural_label: input.plural_label, description: input.description ?? null,
      icon: input.icon ?? 'box', color: input.color ?? 'slate',
      primary_property: input.primary_property ?? 'name',
      secondary_property: input.secondary_property ?? null,
      searchable: JSON.stringify(input.searchable ?? [input.primary_property ?? 'name']),
      category: input.category ?? 'record', system: 0,
      position: input.position ?? 900, created: now, updated: now,
    };
    this.ctx.db.insert('crm_object_types', row);
    this.invalidateSchema();
    // A custom object is useless without its display property, so create it.
    const primary = row.primary_property;
    if (!this.propertyOrNull(orgId, row.name, primary)) {
      this.defineProperty(orgId, row.name, { name: primary, label: 'Name', type: 'string', required: true, position: 1, group: 'Details' });
    }
    this.ctx.emit(orgId, 'object_type.created', { name: row.name, label: row.label }, { objectId: row.id, objectType: 'object_type' });
    return this.objectType(orgId, row.name);
  }

  updateObjectType(orgId: string, name: string, patch: Partial<ObjectTypeDef>): ObjectTypeDef {
    const existing = this.objectType(orgId, name);
    const changes: Record<string, unknown> = { updated: this.ctx.now() };
    for (const key of ['label', 'plural_label', 'description', 'icon', 'color', 'primary_property', 'secondary_property', 'position'] as const) {
      if (patch[key] !== undefined) changes[key] = patch[key];
    }
    if (patch.searchable) changes.searchable = JSON.stringify(patch.searchable);
    if (changes.primary_property && !this.propertyOrNull(orgId, name, String(changes.primary_property))) {
      throw badRequest('property_unknown', `"${changes.primary_property}" is not a property of ${name}, so it cannot be the display property.`, 'primary_property');
    }
    this.ctx.db.run(
      `UPDATE crm_object_types SET ${Object.keys(changes).map((k) => `${k} = ?`).join(', ')} WHERE org_id = ? AND name = ?`,
      ...(Object.values(changes) as never[]), orgId, name,
    );
    this.invalidateSchema();
    this.ctx.emit(orgId, 'object_type.updated', { name, changes }, { objectId: existing.id, objectType: 'object_type', previous: { label: existing.label } });
    return this.objectType(orgId, name);
  }

  deleteObjectType(orgId: string, name: string): void {
    const existing = this.objectType(orgId, name);
    if (existing.system) throw badRequest('object_type_system', `"${name}" is a built-in object type and cannot be deleted. Hide the properties you do not use instead.`);
    const count = this.ctx.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = ?`, orgId, name);
    if (count > 0) throw conflict('object_type_in_use', `${count} ${existing.plural_label.toLowerCase()} still exist. Delete them before removing the object type.`);
    this.ctx.db.run(`DELETE FROM crm_properties WHERE org_id = ? AND object_type = ?`, orgId, name);
    this.ctx.db.run(`DELETE FROM crm_views WHERE org_id = ? AND object_type = ?`, orgId, name);
    this.ctx.db.run(`DELETE FROM crm_object_types WHERE org_id = ? AND name = ?`, orgId, name);
    this.invalidateSchema();
    this.ctx.emit(orgId, 'object_type.deleted', { name }, { objectId: existing.id, objectType: 'object_type' });
  }

  /* ------------------------------- properties ---------------------------- */

  propertyIndex(orgId: string, objectType: string): PropertyIndex {
    const key = `${orgId}:${objectType}`;
    const cached = this.propertyCache.get(key);
    if (cached) return cached;

    let index: PropertyIndex;
    if (objectType === 'activity' || objectType === 'any') {
      const types = objectType === 'activity' ? this.activityTypes(orgId) : this.objectTypes(orgId).map((o) => o.name);
      index = new Map();
      for (const t of types) {
        for (const [name, prop] of this.propertyIndex(orgId, t)) if (!index.has(name)) index.set(name, prop);
      }
    } else {
      const rows = this.ctx.db.all<PropertyRow>(
        `SELECT * FROM crm_properties WHERE org_id = ? AND object_type = ? ORDER BY position, label`, orgId, objectType);
      index = new Map(rows.map((r) => [r.name, hydrateProperty(r)]));
    }
    this.propertyCache.set(key, index);
    return index;
  }

  properties(orgId: string, objectType: string): PropertyDef[] {
    this.objectType(orgId, objectType);
    return [...this.propertyIndex(orgId, objectType).values()].sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
  }

  propertyOrNull(orgId: string, objectType: string, name: string): PropertyDef | null {
    return this.propertyIndex(orgId, objectType).get(name) ?? null;
  }

  property(orgId: string, objectType: string, name: string): PropertyDef {
    const prop = this.propertyOrNull(orgId, objectType, name);
    if (!prop) throw notFound(`property "${name}" on ${objectType}`);
    return prop;
  }

  defineProperty(orgId: string, objectType: string, input: Partial<PropertyDef> & { name: string; label: string; type: PropertyDef['type'] }): PropertyDef {
    if (!/^[a-z][a-z0-9_]{0,60}$/.test(input.name)) {
      throw badRequest('property_name_invalid', 'A property name must be lowercase letters, digits and underscores, e.g. "annual_revenue".', 'name');
    }
    if (isBuiltinProperty(input.name)) {
      throw badRequest('property_name_reserved', `"${input.name}" is a built-in record field and cannot be redefined as a property.`, 'name');
    }
    if (this.propertyOrNull(orgId, objectType, input.name)) {
      throw conflict('property_exists', `${objectType} already has a property named "${input.name}".`);
    }
    if (input.calculated) this.validateExpression(orgId, objectType, input.calculated, input.name);
    const now = this.ctx.now();
    this.ctx.db.insert('crm_properties', {
      org_id: orgId, object_type: objectType, name: input.name, id: newId('property'),
      label: input.label, description: input.description ?? null, type: input.type,
      group_name: input.group ?? 'Other', options: JSON.stringify(input.options ?? []),
      reference_type: input.reference_type ?? null,
      required: input.required ? 1 : 0, unique_value: input.unique ? 1 : 0,
      read_only: input.read_only || input.calculated ? 1 : 0, system: input.system ? 1 : 0,
      hidden: input.hidden ? 1 : 0,
      default_value: input.default_value === undefined || input.default_value === null ? null : JSON.stringify(input.default_value),
      validation: JSON.stringify(input.validation ?? {}), calculated: input.calculated ?? null,
      currency: input.currency ?? null, normalize: input.normalize ?? 'none',
      position: input.position ?? 500, created: now, updated: now,
    });
    this.invalidateSchema();
    this.ctx.emit(orgId, 'property.created', { object_type: objectType, name: input.name, type: input.type }, { objectType: 'property' });
    return this.property(orgId, objectType, input.name);
  }

  updateProperty(orgId: string, objectType: string, name: string, patch: Partial<PropertyDef>): PropertyDef {
    const existing = this.property(orgId, objectType, name);
    if (existing.system && (patch.type || patch.calculated !== undefined)) {
      throw badRequest('property_system', `"${name}" is a system property; its type cannot be changed.`, 'type');
    }
    const changes: Record<string, unknown> = { updated: this.ctx.now() };
    if (patch.label !== undefined) changes.label = patch.label;
    if (patch.description !== undefined) changes.description = patch.description;
    if (patch.group !== undefined) changes.group_name = patch.group;
    if (patch.options !== undefined) changes.options = JSON.stringify(patch.options);
    if (patch.required !== undefined) changes.required = patch.required ? 1 : 0;
    if (patch.unique !== undefined) changes.unique_value = patch.unique ? 1 : 0;
    if (patch.hidden !== undefined) changes.hidden = patch.hidden ? 1 : 0;
    if (patch.read_only !== undefined) changes.read_only = patch.read_only ? 1 : 0;
    if (patch.position !== undefined) changes.position = patch.position;
    if (patch.validation !== undefined) changes.validation = JSON.stringify(patch.validation);
    if (patch.normalize !== undefined) changes.normalize = patch.normalize;
    if (patch.default_value !== undefined) changes.default_value = patch.default_value === null ? null : JSON.stringify(patch.default_value);
    if (patch.calculated !== undefined) {
      if (patch.calculated) this.validateExpression(orgId, objectType, patch.calculated, name);
      changes.calculated = patch.calculated || null;
      changes.read_only = patch.calculated ? 1 : (patch.read_only ? 1 : 0);
    }
    this.ctx.db.run(
      `UPDATE crm_properties SET ${Object.keys(changes).map((k) => `${k} = ?`).join(', ')} WHERE org_id = ? AND object_type = ? AND name = ?`,
      ...(Object.values(changes) as never[]), orgId, objectType, name,
    );
    this.invalidateSchema();
    this.ctx.emit(orgId, 'property.updated', { object_type: objectType, name }, { objectType: 'property', previous: { label: existing.label } });
    return this.property(orgId, objectType, name);
  }

  deleteProperty(orgId: string, objectType: string, name: string): void {
    const existing = this.property(orgId, objectType, name);
    if (existing.system) throw badRequest('property_system', `"${name}" is a system property and cannot be deleted. Hide it instead.`);
    const objectDef = this.objectType(orgId, objectType);
    if (objectDef.primary_property === name) {
      throw badRequest('property_is_primary', `"${name}" is the display property for ${objectDef.plural_label.toLowerCase()} and cannot be deleted.`);
    }
    this.ctx.db.run(`DELETE FROM crm_record_values WHERE org_id = ? AND object_type = ? AND property = ?`, orgId, objectType, name);
    this.ctx.db.run(`DELETE FROM crm_properties WHERE org_id = ? AND object_type = ? AND name = ?`, orgId, objectType, name);
    this.invalidateSchema();
    this.ctx.emit(orgId, 'property.deleted', { object_type: objectType, name }, { objectType: 'property' });
  }

  private validateExpression(orgId: string, objectType: string, expression: string, selfName: string): void {
    let analysis: { properties: string[]; functions: string[] };
    try { analysis = analyzeExpression(expression); }
    catch (e) { throw badRequest('expression_invalid', (e as Error).message, 'calculated'); }
    const index = this.propertyIndex(orgId, objectType);
    for (const ref of analysis.properties) {
      if (ref === selfName) throw badRequest('expression_self_reference', `A calculated property cannot reference itself ("${ref}").`, 'calculated');
      if (!index.has(ref) && !isBuiltinProperty(ref)) {
        throw badRequest('expression_unknown_property', `The formula references "${ref}", which is not a property of ${objectType}.`, 'calculated');
      }
    }
  }

  /* -------------------------------- records ------------------------------ */

  get(orgId: string, objectType: string, id: string): CrmRecord | null {
    const row = this.ctx.db.get<RecordRow>(`SELECT * FROM crm_records WHERE org_id = ? AND id = ?`, orgId, id);
    if (!row) return null;
    if (objectType && row.object_type !== objectType) return null;
    return hydrateRecord(row);
  }

  require(orgId: string, objectType: string, id: string): CrmRecord {
    const record = this.get(orgId, objectType, id);
    if (!record) throw notFound(objectType || 'record', id);
    return record;
  }

  /** Follow a merge chain so old ids keep resolving after a deduplication. */
  resolve(orgId: string, id: string): CrmRecord | null {
    let current = this.ctx.db.get<RecordRow>(`SELECT * FROM crm_records WHERE org_id = ? AND id = ?`, orgId, id);
    let hops = 0;
    while (current?.merged_into && hops++ < 8) {
      const next = this.ctx.db.get<RecordRow>(`SELECT * FROM crm_records WHERE org_id = ? AND id = ?`, orgId, current.merged_into);
      if (!next) break;
      current = next;
    }
    return current ? hydrateRecord(current) : null;
  }

  getMany(orgId: string, ids: string[]): CrmRecord[] {
    if (!ids.length) return [];
    const chunks: CrmRecord[] = [];
    for (let i = 0; i < ids.length; i += 400) {
      const slice = ids.slice(i, i + 400);
      chunks.push(...this.ctx.db.all<RecordRow>(
        `SELECT * FROM crm_records WHERE org_id = ? AND id IN (${slice.map(() => '?').join(',')})`,
        orgId, ...slice,
      ).map(hydrateRecord));
    }
    return chunks;
  }

  findBy(orgId: string, objectType: string, property: string, value: string | number): CrmRecord | null {
    const prop = this.propertyOrNull(orgId, objectType, property);
    const column = prop && (prop.type === 'number' || prop.type === 'currency') ? 'value_number' : 'value_text';
    const needle = canonicalLookupValue(prop, value);
    const row = this.ctx.db.get<RecordRow>(
      `SELECT r.* FROM crm_records r JOIN crm_record_values v ON v.record_id = r.id
       WHERE r.org_id = ? AND r.object_type = ? AND v.property = ? AND v.${column} = ? AND r.archived = 0 AND r.merged_into IS NULL
       ORDER BY r.created LIMIT 1`,
      orgId, objectType, property, needle,
    );
    return row ? hydrateRecord(row) : null;
  }

  create(orgId: string, objectType: string, input: Record<string, unknown>, opts: WriteOptions = {}): CrmRecord {
    const objectDef = this.objectType(orgId, objectType);
    const index = this.propertyIndex(orgId, objectType);
    const now = this.ctx.now();
    const createdAt = opts.createdAt ?? now;
    const id = opts.id ?? randomId(prefixFor(objectType), 14);
    const { ownerId, properties: incoming } = splitOwner(input, opts);

    const values: Record<string, PropertyValue> = {};
    for (const prop of index.values()) {
      if (prop.calculated) continue;
      const raw = incoming[prop.name];
      if (raw === undefined) {
        if (prop.default_value !== null && prop.default_value !== undefined) values[prop.name] = prop.default_value;
        else if (prop.required) throw badRequest('property_required', `${prop.label} is required to create a ${objectDef.label.toLowerCase()}.`, `properties.${prop.name}`);
        continue;
      }
      if (prop.read_only && !MAINTAINED_SOURCES.has(opts.source ?? 'api')) throw this.readOnlyError(orgId, objectType, prop);
      const coerced = coerceValue(prop, raw, { now, path: 'properties' });
      if (!isEmptyValue(coerced)) values[prop.name] = coerced;
      else if (prop.required) throw badRequest('property_required', `${prop.label} is required to create a ${objectDef.label.toLowerCase()}.`, `properties.${prop.name}`);
    }
    rejectUnknown(incoming, index, objectType);
    deriveStage(this.pipelines, {
      orgId, objectType, values, has: (name) => index.has(name),
      incoming: new Set(Object.keys(incoming)), createdAt, now,
    });
    this.applyCalculated(index, values, now);
    this.assertUnique(orgId, objectType, index, values, id);

    if (ownerId) this.assertMember(orgId, ownerId);

    const row: RecordRow = {
      id, org_id: orgId, object_type: objectType, properties: JSON.stringify(values),
      display_name: this.displayNameFor(objectDef, values, id),
      search_blob: buildSearchBlob(objectDef, values),
      owner_id: ownerId ?? null, source: opts.source ?? 'api', archived: 0, merged_into: null,
      created: createdAt, updated: createdAt,
      created_by: opts.actorId ?? null, updated_by: opts.actorId ?? null,
    };
    this.ctx.db.insert('crm_records', row as unknown as Record<string, never>);
    this.writeValues(orgId, objectType, id, index, values, Object.keys(values));

    if (opts.history !== false) {
      // One save, one write id. Everything a record is born with belongs to
      // the same entry on the timeline, and nothing later can join it.
      const writeId = opts.writeId ?? newId('audit');
      for (const [name, value] of Object.entries(values)) {
        if (isEmptyValue(value)) continue;
        this.writeHistory(orgId, objectType, id, index.get(name), name, null, value, createdAt, { ...opts, writeId });
      }
    }

    const record = hydrateRecord(row);
    if (opts.emit !== false) {
      this.ctx.emit(orgId, `${objectType}.created`, record, {
        objectId: id, objectType, actorId: opts.actorId ?? null, actorType: opts.actorType ?? 'user', requestId: opts.requestId ?? null,
      });
    }
    return record;
  }

  update(orgId: string, objectType: string, id: string, input: Record<string, unknown>, opts: WriteOptions = {}): CrmRecord {
    const objectDef = this.objectType(orgId, objectType);
    const existing = this.require(orgId, objectType, id);
    const index = this.propertyIndex(orgId, objectType);
    const now = this.ctx.now();
    const { ownerId, properties: incoming, ownerProvided } = splitOwner(input, opts);
    rejectUnknown(incoming, index, objectType);

    const values: Record<string, PropertyValue> = { ...existing.properties };
    const previous: Record<string, PropertyValue> = {};
    const touched: string[] = [];

    for (const [name, raw] of Object.entries(incoming)) {
      const prop = index.get(name);
      if (!prop) continue;
      if (prop.calculated) throw badRequest('property_read_only', `${prop.label} is calculated from other properties and cannot be set directly.`, `properties.${name}`);
      if (prop.read_only && !MAINTAINED_SOURCES.has(opts.source ?? 'user')) throw this.readOnlyError(orgId, objectType, prop);
      const coerced = coerceValue(prop, raw, { now, path: 'properties' });
      if (valuesEqual(existing.properties[name] ?? null, coerced)) continue;
      previous[name] = existing.properties[name] ?? null;
      if (isEmptyValue(coerced)) delete values[name];
      else values[name] = coerced;
      touched.push(name);
    }

    const derived = deriveStage(this.pipelines, {
      orgId, objectType, values, has: (name) => index.has(name),
      incoming: new Set(Object.keys(incoming)), previous: existing.properties,
      createdAt: existing.created, now,
    });
    this.applyCalculated(index, values, now);
    // A rep moved the stage; Ain moved the probability. The history says so.
    const maintained = new Set<string>([
      ...derived.changed,
      ...[...index.values()].filter((p) => p.calculated).map((p) => p.name),
    ]);

    // The change set is rebuilt from the record's real before and after, so a
    // property the stage restamped or a formula recomputed lands in the history
    // exactly like one a person typed — and a write that cancels itself out
    // leaves no trace at all.
    touched.length = 0;
    for (const key of Object.keys(previous)) delete previous[key];
    for (const name of new Set([...Object.keys(existing.properties), ...Object.keys(values)])) {
      if (valuesEqual(existing.properties[name] ?? null, values[name] ?? null)) continue;
      previous[name] = existing.properties[name] ?? null;
      touched.push(name);
    }

    const ownerChanged = ownerProvided && (ownerId ?? null) !== existing.owner_id;
    if (ownerChanged && ownerId) this.assertMember(orgId, ownerId);
    if (!touched.length && !ownerChanged) return existing;

    this.assertUnique(orgId, objectType, index, values, id);

    this.ctx.db.patch('crm_records', 'id', id, {
      properties: JSON.stringify(values),
      display_name: this.displayNameFor(objectDef, values, id),
      search_blob: buildSearchBlob(objectDef, values),
      ...(ownerChanged ? { owner_id: ownerId ?? null } : {}),
      updated: now,
      updated_by: opts.actorId ?? null,
    });
    this.writeValues(orgId, objectType, id, index, values, touched);

    if (opts.history !== false) {
      // The stage a person moved and the five fields Ain restamped from it are
      // one save. They share a write id, so the timeline folds them into one
      // entry — and a different save in the same millisecond never joins them.
      const writeId = opts.writeId ?? newId('audit');
      for (const name of touched) {
        const source: ChangeSource = maintained.has(name) && !(name in incoming) ? 'system' : (opts.source ?? 'user');
        this.writeHistory(orgId, objectType, id, index.get(name), name, previous[name] ?? null, values[name] ?? null, now, { ...opts, source, writeId });
      }
      if (ownerChanged) {
        this.writeHistory(orgId, objectType, id, undefined, 'owner_id', existing.owner_id, ownerId ?? null, now, { ...opts, writeId });
      }
    }

    const updated = this.require(orgId, objectType, id);
    if (opts.emit !== false) {
      this.ctx.emit(orgId, `${objectType}.updated`, updated, {
        objectId: id, objectType, previous: { ...previous, ...(ownerChanged ? { owner_id: existing.owner_id } : {}) },
        actorId: opts.actorId ?? null, actorType: opts.actorType ?? 'user', requestId: opts.requestId ?? null,
      });
    }
    return updated;
  }

  /** Writes maintained fields (activity roll-ups, stage stamps) without history. */
  setSystemProperties(orgId: string, id: string, patch: Record<string, PropertyValue>): void {
    const row = this.ctx.db.get<RecordRow>(`SELECT * FROM crm_records WHERE org_id = ? AND id = ?`, orgId, id);
    if (!row) return;
    const index = this.propertyIndex(orgId, row.object_type);
    const values = parseJson<Record<string, PropertyValue>>(row.properties, {});
    const before = { ...values };
    const touched: string[] = [];
    for (const [name, value] of Object.entries(patch)) {
      if (!index.has(name)) continue;
      if (valuesEqual(values[name] ?? null, value)) continue;
      if (isEmptyValue(value)) delete values[name]; else values[name] = value;
      touched.push(name);
    }
    if (!touched.length) return;
    this.applyCalculated(index, values, this.ctx.now());
    for (const prop of index.values()) {
      if (!prop.calculated || touched.includes(prop.name)) continue;
      if (!valuesEqual(before[prop.name] ?? null, values[prop.name] ?? null)) touched.push(prop.name);
    }
    const objectDef = this.objectType(orgId, row.object_type);
    this.ctx.db.patch('crm_records', 'id', id, {
      properties: JSON.stringify(values),
      display_name: this.displayNameFor(objectDef, values, id),
      search_blob: buildSearchBlob(objectDef, values),
    });
    this.writeValues(orgId, row.object_type, id, index, values, touched);
  }

  archive(orgId: string, objectType: string, id: string, opts: WriteOptions = {}): CrmRecord {
    const existing = this.require(orgId, objectType, id);
    if (existing.archived) return existing;
    this.ctx.db.patch('crm_records', 'id', id, { archived: 1, updated: this.ctx.now(), updated_by: opts.actorId ?? null });
    this.writeHistory(orgId, objectType, id, undefined, 'archived', false, true, this.ctx.now(), opts);
    this.ctx.emit(orgId, `${objectType}.archived`, { id, object_type: objectType, display_name: existing.display_name }, {
      objectId: id, objectType, actorId: opts.actorId ?? null, actorType: opts.actorType ?? 'user',
    });
    return { ...existing, archived: true };
  }

  restore(orgId: string, objectType: string, id: string, opts: WriteOptions = {}): CrmRecord {
    const existing = this.require(orgId, objectType, id);
    if (!existing.archived) return existing;
    this.ctx.db.patch('crm_records', 'id', id, { archived: 0, updated: this.ctx.now(), updated_by: opts.actorId ?? null });
    this.writeHistory(orgId, objectType, id, undefined, 'archived', true, false, this.ctx.now(), opts);
    this.ctx.emit(orgId, `${objectType}.restored`, { id, object_type: objectType }, { objectId: id, objectType });
    return { ...existing, archived: false };
  }

  destroy(orgId: string, objectType: string, id: string, opts: WriteOptions = {}): void {
    const existing = this.require(orgId, objectType, id);
    this.ctx.db.run(`DELETE FROM crm_associations WHERE org_id = ? AND (from_id = ? OR to_id = ?)`, orgId, id, id);
    this.ctx.db.run(`DELETE FROM crm_record_values WHERE record_id = ?`, id);
    this.ctx.db.run(`DELETE FROM crm_property_history WHERE org_id = ? AND record_id = ?`, orgId, id);
    this.ctx.db.run(`DELETE FROM crm_records WHERE org_id = ? AND id = ?`, orgId, id);
    this.ctx.emit(orgId, `${objectType}.deleted`, { id, object_type: objectType, display_name: existing.display_name }, {
      objectId: id, objectType, actorId: opts.actorId ?? null, actorType: opts.actorType ?? 'user',
    });
  }

  /* ------------------------------- internals ----------------------------- */

  private displayNameFor(objectDef: ObjectTypeDef, values: Record<string, PropertyValue>, id: string): string {
    const primary = values[objectDef.primary_property];
    if (!isEmptyValue(primary)) return String(Array.isArray(primary) ? primary.join(', ') : primary).slice(0, 300);
    const body = values.body ?? values.subject ?? values.name;
    if (!isEmptyValue(body)) return String(body).split('\n')[0].slice(0, 120);
    return `${objectDef.label} ${id.slice(-6)}`;
  }

  private applyCalculated(index: PropertyIndex, values: Record<string, PropertyValue>, now: number): void {
    for (const prop of index.values()) {
      if (!prop.calculated) continue;
      try {
        const result = evaluateExpression(prop.calculated, { properties: values, now });
        if (result === null || result === '' || (typeof result === 'number' && !Number.isFinite(result))) {
          delete values[prop.name];
        } else if (prop.type === 'currency' || prop.type === 'number') {
          // A formula can multiply its way out of range even when every input
          // is legal. Clamping keeps the value serialisable, so one record can
          // never turn a workspace-wide sum into `null`.
          const ceiling = prop.type === 'currency' ? MAX_MINOR_UNITS : MAX_NUMBER;
          values[prop.name] = Math.max(-ceiling, Math.min(ceiling, Math.round(Number(result))));
        } else {
          values[prop.name] = result;
        }
      } catch (e) {
        if (e instanceof ExpressionError) throw badRequest('expression_failed', `The formula for ${prop.label} could not be evaluated: ${e.message}`, `properties.${prop.name}`);
        throw e;
      }
    }
  }

  private assertUnique(orgId: string, objectType: string, index: PropertyIndex, values: Record<string, PropertyValue>, selfId: string): void {
    for (const prop of index.values()) {
      if (!prop.unique) continue;
      const value = values[prop.name];
      if (isEmptyValue(value)) continue;
      const { value_text, value_number } = indexValue(prop, value);
      const column = value_number !== null && (prop.type === 'number' || prop.type === 'currency') ? 'value_number' : 'value_text';
      const clash = this.ctx.db.get<{ id: string; display_name: string }>(
        `SELECT r.id, r.display_name FROM crm_record_values v JOIN crm_records r ON r.id = v.record_id
         WHERE v.org_id = ? AND v.object_type = ? AND v.property = ? AND v.${column} = ? AND v.record_id <> ? AND r.archived = 0 AND r.merged_into IS NULL
         LIMIT 1`,
        orgId, objectType, prop.name, column === 'value_number' ? value_number : value_text, selfId,
      );
      if (clash) {
        throw conflict('property_not_unique', `${prop.label} must be unique — "${value_text}" already belongs to ${clash.display_name}.`, { property: prop.name, conflicting_id: clash.id });
      }
    }
  }

  private readOnlyError(orgId: string, objectType: string, prop: PropertyDef) {
    const why = stageOwnedExplanation(this.pipelines, orgId, objectType, prop.name);
    return badRequest(
      'property_read_only',
      `${prop.label} is maintained by Ain and cannot be written directly.${why ? ` ${why}` : ''}`,
      `properties.${prop.name}`,
    );
  }

  private assertMember(orgId: string, userId: string): void {
    const member = this.ctx.db.get<{ user_id: string }>(`SELECT user_id FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, userId);
    if (!member) throw badRequest('owner_unknown', `"${userId}" is not a member of this workspace, so records cannot be assigned to them.`, 'owner_id');
  }

  private writeValues(orgId: string, objectType: string, id: string, index: PropertyIndex, values: Record<string, PropertyValue>, touched: string[]): void {
    for (const name of touched) {
      const prop = index.get(name);
      if (!prop) continue;
      const value = values[name];
      if (isEmptyValue(value)) {
        this.ctx.db.run(`DELETE FROM crm_record_values WHERE record_id = ? AND property = ?`, id, name);
        continue;
      }
      const indexed = indexValue(prop, value);
      this.ctx.db.upsert('crm_record_values', {
        record_id: id, property: name, org_id: orgId, object_type: objectType,
        value_text: indexed.value_text, value_number: indexed.value_number, value_date: indexed.value_date,
      }, ['record_id', 'property']);
    }
  }

  private writeHistory(
    orgId: string, objectType: string, recordId: string, prop: PropertyDef | undefined,
    property: string, from: PropertyValue, to: PropertyValue, at: number, opts: WriteOptions,
  ): void {
    this.ctx.db.insert('crm_property_history', {
      id: newId('audit'), org_id: orgId, record_id: recordId, object_type: objectType, property,
      from_value: historyText(prop, from), to_value: historyText(prop, to), changed_at: at,
      seq: this.nextHistorySeq(), write_id: opts.writeId ?? newId('audit'),
      actor_id: opts.actorId ?? null, actor_type: opts.actorType ?? 'user',
      source: opts.source ?? 'user', request_id: opts.requestId ?? null,
    });
  }

  /** Append a history row directly — used by importers and the demo seed. */
  recordHistory(
    orgId: string, objectType: string, recordId: string, property: string,
    from: PropertyValue, to: PropertyValue, at: number, opts: WriteOptions = {},
  ): void {
    this.writeHistory(orgId, objectType, recordId, this.propertyOrNull(orgId, objectType, property) ?? undefined, property, from, to, at, opts);
  }

  /**
   * The audit trail, newest first, totally ordered on `(changed_at, seq)`.
   * `before` is a time filter a human can type; `after` is the opaque cursor
   * this endpoint emits, and paging on it can neither skip nor repeat a row
   * however many share a millisecond.
   */
  history(orgId: string, recordId: string, opts: HistoryQuery = {}): HistoryEntry[] {
    const merged = this.ctx.db.all<{ id: string }>(`SELECT id FROM crm_records WHERE org_id = ? AND merged_into = ?`, orgId, recordId).map((r) => r.id);
    const ids = [recordId, ...merged];
    const clauses = [`org_id = ?`, `record_id IN (${ids.map(() => '?').join(',')})`];
    const params: unknown[] = [orgId, ...ids];
    if (opts.property) { clauses.push('property = ?'); params.push(opts.property); }
    if (opts.before) { clauses.push('changed_at < ?'); params.push(opts.before); }
    if (opts.since) { clauses.push('changed_at >= ?'); params.push(opts.since); }
    // A cursor means "the row after this position in the order you are reading
    // in", so the comparison has to follow the sort. Fixed at `<` it paged the
    // wrong way round under `order=asc`: every page walked back towards the
    // oldest row, repeating what it had already returned and never reaching
    // the rest of the trail.
    const ascending = opts.order === 'asc';
    const direction = ascending ? 'ASC' : 'DESC';
    const after = decodeHistoryCursor(opts.after);
    if (after) {
      const beyond = ascending ? '>' : '<';
      clauses.push(`(changed_at ${beyond} ? OR (changed_at = ? AND seq ${beyond} ?))`);
      params.push(after.changed_at, after.changed_at, after.seq);
    }
    const rows = this.ctx.db.all<HistoryRow>(
      `SELECT * FROM crm_property_history WHERE ${clauses.join(' AND ')}
        ORDER BY changed_at ${direction}, seq ${direction} LIMIT ?`,
      ...(params as never[]), Math.min(Math.max(opts.limit ?? 100, 1), HISTORY_PAGE_MAX + 1),
    );
    return rows.map((row) => this.hydrateHistory(orgId, row));
  }

  /** One page plus the cursor that fetches the next, with an honest `has_more`. */
  historyPage(orgId: string, recordId: string, opts: HistoryQuery = {}): HistoryPage {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), HISTORY_PAGE_MAX);
    // Peek one row past the page: `has_more` should be a fact, not a guess
    // from whether the page came back exactly full.
    const rows = this.history(orgId, recordId, { ...opts, limit: limit + 1 });
    const has_more = rows.length > limit;
    const entries = has_more ? rows.slice(0, limit) : rows;
    const last = entries[entries.length - 1];
    return {
      entries,
      has_more,
      next_cursor: has_more && last ? encodeHistoryCursor(last.changed_at, last.seq) : null,
    };
  }

  /**
   * The write that brought a record into existence. Its rows are already told
   * by the "Record created" event, so the timeline does not repeat them as
   * fourteen separate "empty → value" changes.
   */
  creationWriteId(orgId: string, recordId: string): string | null {
    const row = this.ctx.db.get<{ write_id: string }>(
      `SELECT write_id FROM crm_property_history WHERE org_id = ? AND record_id = ?
        ORDER BY changed_at ASC, seq ASC LIMIT 1`,
      orgId, recordId,
    );
    return row?.write_id ?? null;
  }

  /** Every row written by one save, oldest first. */
  historyOfWrite(orgId: string, writeId: string): HistoryEntry[] {
    return this.ctx.db
      .all<HistoryRow>(`SELECT * FROM crm_property_history WHERE org_id = ? AND write_id = ? ORDER BY seq ASC`, orgId, writeId)
      .map((row) => this.hydrateHistory(orgId, row));
  }

  private hydrateHistory(orgId: string, row: HistoryRow): HistoryEntry {
    const prop = this.propertyOrNull(orgId, row.object_type, row.property);
    return {
      object: 'property_history',
      id: row.id, record_id: row.record_id, object_type: row.object_type, property: row.property,
      property_label: prop?.label ?? labelForBuiltin(row.property),
      from_value: row.from_value, to_value: row.to_value, changed_at: row.changed_at,
      seq: row.seq, write_id: row.write_id,
      actor_id: row.actor_id, actor_type: row.actor_type, source: row.source,
    };
  }

  /* -------------------------------- search ------------------------------- */

  env(orgId: string, objectType: string): CompileEnv {
    return {
      orgId,
      objectType,
      now: this.ctx.now(),
      propertiesOf: (type) => this.propertyIndex(orgId, type),
      resolveAssociation: (fromObject, association) => this.resolveAssociation(orgId, fromObject, association),
    };
  }

  resolveAssociation(orgId: string, fromObject: string, association: string): { objectTypes: string[]; associationTypes: string[] } {
    if (association === 'any') return { objectTypes: this.objectTypes(orgId).map((o) => o.name), associationTypes: [] };
    if (association === 'activity') return { objectTypes: this.activityTypes(orgId), associationTypes: [] };
    if (this.objectTypeOrNull(orgId, association)) return { objectTypes: [association], associationTypes: [] };
    const assoc = this.ctx.db.get<AssociationTypeDef>(`SELECT * FROM crm_association_types WHERE org_id = ? AND name = ?`, orgId, association);
    if (!assoc) return { objectTypes: [], associationTypes: [] };
    const other = assoc.from_object === fromObject ? assoc.to_object : assoc.from_object;
    return { objectTypes: other === '*' ? [] : [other], associationTypes: [assoc.name] };
  }

  search(orgId: string, objectType: string, query: SearchQuery = {}): SearchResult {
    this.objectType(orgId, objectType);
    const started = Date.now();
    const env = this.env(orgId, objectType);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = decodeCursor(query.after, signatureOf(objectType, query));

    const where: string[] = [`r.org_id = ?`, `r.object_type = ?`, `r.merged_into IS NULL`];
    const whereParams: unknown[] = [orgId, objectType];
    if (!query.include_archived) where.push('r.archived = 0');
    if (query.query && query.query.trim()) {
      where.push(`r.search_blob LIKE ? ESCAPE '\\'`);
      whereParams.push(`%${query.query.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (query.associated_to) {
      where.push(`EXISTS (SELECT 1 FROM crm_associations ax WHERE ax.org_id = ? AND ((ax.from_id = ? AND ax.to_id = r.id) OR (ax.to_id = ? AND ax.from_id = r.id)))`);
      whereParams.push(orgId, query.associated_to, query.associated_to);
    }
    const compiled = compileFilter(query.filter, env);
    if (query.filter) { where.push(compiled.sql); whereParams.push(...compiled.params); }

    const sort = compileSort(query.sort, env);
    const whereSql = where.join(' AND ');
    const sql = `SELECT r.* FROM crm_records r ${sort.joins} WHERE ${whereSql} ORDER BY ${sort.orderBy} LIMIT ? OFFSET ?`;
    const rows = this.ctx.db.all<RecordRow>(sql, ...(sort.params as never[]), ...(whereParams as never[]), limit + 1, offset);
    const total = this.ctx.db.count(`SELECT COUNT(*) FROM crm_records r WHERE ${whereSql}`, ...(whereParams as never[]));

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(hydrateRecord);
    if (query.properties?.length) {
      const keep = new Set([...query.properties, this.objectType(orgId, objectType).primary_property]);
      for (const record of page) {
        record.properties = Object.fromEntries(Object.entries(record.properties).filter(([k]) => keep.has(k)));
      }
    }
    if (query.expand?.includes('associations')) {
      for (const record of page) record.associations = this.associationsOf(orgId, record.id, { limit: 50 });
    }

    return {
      records: page,
      total,
      has_more: hasMore,
      next_cursor: hasMore ? encodeCursor(offset + limit, signatureOf(objectType, query)) : null,
      explain: { sql, params: [...sort.params, ...whereParams, limit + 1, offset], ms: Date.now() - started },
    };
  }

  count(orgId: string, objectType: string, filter?: FilterNode, opts: { includeArchived?: boolean } = {}): number {
    const env = this.env(orgId, objectType);
    const compiled = compileFilter(filter, env);
    const where = [`r.org_id = ?`, `r.object_type = ?`, `r.merged_into IS NULL`];
    const params: unknown[] = [orgId, objectType];
    if (!opts.includeArchived) where.push('r.archived = 0');
    if (filter) { where.push(compiled.sql); params.push(...compiled.params); }
    return this.ctx.db.count(`SELECT COUNT(*) FROM crm_records r WHERE ${where.join(' AND ')}`, ...(params as never[]));
  }

  /* ----------------------------- associations ---------------------------- */

  associationTypes(orgId: string): AssociationTypeDef[] {
    return this.ctx.db.all<any>(`SELECT * FROM crm_association_types WHERE org_id = ? ORDER BY from_object, name`, orgId)
      .map((r) => ({ ...r, system: !!r.system }));
  }

  private pickAssociationType(orgId: string, fromType: string, toType: string, explicit?: string): { type: AssociationTypeDef; swap: boolean } {
    const all = this.associationTypes(orgId);
    if (explicit) {
      const found = all.find((t) => t.name === explicit);
      if (!found) throw badRequest('association_type_unknown', `"${explicit}" is not an association type in this workspace.`, 'association_type');
      const matches = (a: string, b: string) => a === '*' || a === b;
      if (matches(found.from_object, fromType) && matches(found.to_object, toType)) return { type: found, swap: false };
      if (matches(found.from_object, toType) && matches(found.to_object, fromType)) return { type: found, swap: true };
      throw badRequest('association_type_mismatch', `The "${found.label}" association connects ${found.from_object} to ${found.to_object}, not ${fromType} to ${toType}.`, 'association_type');
    }
    const exact = all.find((t) => t.from_object === fromType && t.to_object === toType);
    if (exact) return { type: exact, swap: false };
    const reversed = all.find((t) => t.from_object === toType && t.to_object === fromType);
    if (reversed) return { type: reversed, swap: true };
    const wildcard = all.find((t) => t.from_object === '*' || t.to_object === '*');
    if (wildcard) {
      const activityTypes = this.activityTypes(orgId);
      return { type: wildcard, swap: activityTypes.includes(toType) && !activityTypes.includes(fromType) };
    }
    throw badRequest('association_undefined', `No association type connects ${fromType} to ${toType}. Create one with POST /v1/association-types.`, 'association_type');
  }

  associate(orgId: string, input: AssociateInput, opts: WriteOptions = {}): AssociationSummary {
    const fromRecord = this.resolve(orgId, input.fromId);
    if (!fromRecord) throw notFound('record', input.fromId);
    const toRecord = this.resolve(orgId, input.toId);
    if (!toRecord) throw notFound('record', input.toId);
    if (fromRecord.id === toRecord.id) throw badRequest('association_self', 'A record cannot be associated with itself.', 'to_id');

    const { type, swap } = this.pickAssociationType(orgId, fromRecord.object_type, toRecord.object_type, input.associationType);
    const from = swap ? toRecord : fromRecord;
    const to = swap ? fromRecord : toRecord;

    const existing = this.ctx.db.get<any>(
      `SELECT * FROM crm_associations WHERE org_id = ? AND association_type = ? AND from_id = ? AND to_id = ?`,
      orgId, type.name, from.id, to.id);
    if (existing) {
      if (input.primary && !existing.is_primary) this.setPrimary(orgId, type.name, from.id, existing.id);
      return this.summarise(existing, to, type, 'outgoing');
    }

    // `many_to_one` and `one_to_one` labels hold a single edge; replacing is the
    // behaviour people expect when they move a deal to a different account.
    if (type.cardinality === 'many_to_one' || type.cardinality === 'one_to_one') {
      const stale = this.ctx.db.all<any>(`SELECT * FROM crm_associations WHERE org_id = ? AND association_type = ? AND from_id = ?`, orgId, type.name, from.id);
      for (const edge of stale) this.removeAssociation(orgId, edge, opts);
    }

    const row = {
      id: newId('association'), org_id: orgId, association_type: type.name,
      from_id: from.id, from_type: from.object_type, to_id: to.id, to_type: to.object_type,
      is_primary: input.primary ? 1 : 0, created: opts.createdAt ?? this.ctx.now(), created_by: opts.actorId ?? null,
    };
    this.ctx.db.insert('crm_associations', row);
    if (input.primary) this.setPrimary(orgId, type.name, from.id, row.id);

    const activityTypes = this.activityTypes(orgId);
    if (activityTypes.includes(from.object_type)) this.rollUpActivity(orgId, from, to);
    else if (activityTypes.includes(to.object_type)) this.rollUpActivity(orgId, to, from);

    if (opts.emit !== false) {
      this.ctx.emit(orgId, 'association.created', {
        id: row.id, association_type: type.name, label: type.label,
        from: { id: from.id, object_type: from.object_type, display_name: from.display_name },
        to: { id: to.id, object_type: to.object_type, display_name: to.display_name },
      }, { objectId: from.id, objectType: from.object_type, actorId: opts.actorId ?? null, actorType: opts.actorType ?? 'user' });
    }
    return this.summarise(row, to, type, 'outgoing');
  }

  private setPrimary(orgId: string, associationType: string, fromId: string, keepId: string): void {
    this.ctx.db.run(`UPDATE crm_associations SET is_primary = 0 WHERE org_id = ? AND association_type = ? AND from_id = ?`, orgId, associationType, fromId);
    this.ctx.db.run(`UPDATE crm_associations SET is_primary = 1 WHERE org_id = ? AND id = ?`, orgId, keepId);
  }

  private rollUpActivity(orgId: string, activity: CrmRecord, subject: CrmRecord): void {
    const occurred = Number(activity.properties.occurred_at ?? activity.created);
    const index = this.propertyIndex(orgId, subject.object_type);
    const patch: Record<string, PropertyValue> = {};
    if (index.has('last_activity_at')) {
      const current = Number(subject.properties.last_activity_at ?? 0);
      if (occurred > current) patch.last_activity_at = occurred;
    }
    if (index.has('activity_count')) patch.activity_count = Number(subject.properties.activity_count ?? 0) + 1;
    if (index.has('last_contacted_at') && ['call', 'email', 'meeting'].includes(activity.object_type)) {
      const current = Number(subject.properties.last_contacted_at ?? 0);
      if (occurred > current) patch.last_contacted_at = occurred;
      if (isEmptyValue(subject.properties.first_contacted_at) && index.has('first_contacted_at')) patch.first_contacted_at = occurred;
    }
    if (Object.keys(patch).length) this.setSystemProperties(orgId, subject.id, patch);
  }

  private removeAssociation(orgId: string, row: any, opts: WriteOptions): void {
    this.ctx.db.run(`DELETE FROM crm_associations WHERE org_id = ? AND id = ?`, orgId, row.id);
    if (opts.emit !== false) {
      this.ctx.emit(orgId, 'association.deleted', {
        id: row.id, association_type: row.association_type, from_id: row.from_id, to_id: row.to_id,
      }, { objectId: row.from_id, objectType: row.from_type, actorId: opts.actorId ?? null, actorType: opts.actorType ?? 'user' });
    }
  }

  disassociate(orgId: string, filter: { id?: string; fromId?: string; toId?: string; associationType?: string }, opts: WriteOptions = {}): number {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.id) { clauses.push('id = ?'); params.push(filter.id); }
    if (filter.associationType) { clauses.push('association_type = ?'); params.push(filter.associationType); }
    if (filter.fromId && filter.toId) {
      clauses.push('((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))');
      params.push(filter.fromId, filter.toId, filter.toId, filter.fromId);
    } else if (filter.fromId) { clauses.push('(from_id = ? OR to_id = ?)'); params.push(filter.fromId, filter.fromId); }
    else if (filter.toId) { clauses.push('(from_id = ? OR to_id = ?)'); params.push(filter.toId, filter.toId); }

    const rows = this.ctx.db.all<any>(`SELECT * FROM crm_associations WHERE ${clauses.join(' AND ')}`, ...(params as never[]));
    for (const row of rows) this.removeAssociation(orgId, row, opts);
    return rows.length;
  }

  associationsOf(orgId: string, recordId: string, opts: { objectType?: string; associationType?: string; limit?: number } = {}): AssociationSummary[] {
    const types = new Map(this.associationTypes(orgId).map((t) => [t.name, t]));
    const limit = Math.min(opts.limit ?? 200, 1000);
    const rows = this.ctx.db.all<any>(
      `SELECT a.id AS id, a.association_type AS association_type, a.is_primary AS is_primary,
              a.created AS created, 'outgoing' AS direction, r.id AS record_id,
              r.object_type AS object_type, r.display_name AS display_name, r.archived AS archived
         FROM crm_associations a JOIN crm_records r ON r.id = a.to_id
        WHERE a.org_id = ? AND a.from_id = ?
       UNION ALL
       SELECT a.id AS id, a.association_type AS association_type, a.is_primary AS is_primary,
              a.created AS created, 'incoming' AS direction, r.id AS record_id,
              r.object_type AS object_type, r.display_name AS display_name, r.archived AS archived
         FROM crm_associations a JOIN crm_records r ON r.id = a.from_id
        WHERE a.org_id = ? AND a.to_id = ?
        ORDER BY is_primary DESC, created DESC LIMIT ?`,
      orgId, recordId, orgId, recordId, limit,
    );
    return rows
      .filter((r) => !r.archived)
      .filter((r) => (opts.objectType ? r.object_type === opts.objectType : true))
      .filter((r) => (opts.associationType ? r.association_type === opts.associationType : true))
      .map((r) => {
        const type = types.get(r.association_type);
        return {
          id: r.id, association_type: r.association_type,
          label: (r.direction === 'outgoing' ? type?.label : type?.inverse_label) ?? r.association_type,
          direction: r.direction as 'outgoing' | 'incoming',
          record_id: r.record_id, object_type: r.object_type, display_name: r.display_name,
          is_primary: !!r.is_primary, created: r.created,
        };
      });
  }

  associated(orgId: string, recordId: string, objectType: string, limit = 100): CrmRecord[] {
    const edges = this.associationsOf(orgId, recordId, { objectType, limit });
    const byId = new Map(this.getMany(orgId, edges.map((e) => e.record_id)).map((r) => [r.id, r]));
    return edges.map((e) => byId.get(e.record_id)).filter((r): r is CrmRecord => !!r);
  }

  private summarise(row: any, other: CrmRecord, type: AssociationTypeDef, direction: 'outgoing' | 'incoming'): AssociationSummary {
    return {
      id: row.id, association_type: type.name,
      label: direction === 'outgoing' ? type.label : type.inverse_label,
      direction, record_id: other.id, object_type: other.object_type,
      display_name: other.display_name, is_primary: !!row.is_primary, created: row.created,
    };
  }

  /* --------------------------------- views ------------------------------- */

  views(orgId: string, objectType?: string): ViewDef[] {
    const rows = objectType
      ? this.ctx.db.all<any>(`SELECT * FROM crm_views WHERE org_id = ? AND object_type = ? ORDER BY position, name`, orgId, objectType)
      : this.ctx.db.all<any>(`SELECT * FROM crm_views WHERE org_id = ? ORDER BY object_type, position, name`, orgId);
    return rows.map(hydrateView);
  }

  view(orgId: string, id: string): ViewDef {
    const row = this.ctx.db.get<any>(`SELECT * FROM crm_views WHERE org_id = ? AND id = ?`, orgId, id);
    if (!row) throw notFound('view', id);
    return hydrateView(row);
  }

  createView(orgId: string, input: Partial<ViewDef> & { object_type: string; name: string }, opts: WriteOptions = {}): ViewDef {
    this.objectType(orgId, input.object_type);
    if (input.filter) compileFilter(input.filter, this.env(orgId, input.object_type));
    if (input.sort) compileSort(input.sort, this.env(orgId, input.object_type));
    const now = this.ctx.now();
    const row = {
      id: newId('view'), org_id: orgId, object_type: input.object_type, name: input.name,
      description: input.description ?? null, columns: JSON.stringify(input.columns ?? []),
      filter: input.filter ? JSON.stringify(input.filter) : null, sort: JSON.stringify(input.sort ?? []),
      shared: input.shared === false ? 0 : 1, owner_id: opts.actorId ?? null,
      is_default: input.is_default ? 1 : 0, system: input.system ? 1 : 0,
      position: input.position ?? 500, created: now, updated: now,
    };
    this.ctx.db.insert('crm_views', row);
    if (row.is_default) this.ctx.db.run(`UPDATE crm_views SET is_default = 0 WHERE org_id = ? AND object_type = ? AND id <> ?`, orgId, input.object_type, row.id);
    this.ctx.emit(orgId, 'view.created', { id: row.id, name: row.name, object_type: row.object_type }, { objectId: row.id, objectType: 'view' });
    return this.view(orgId, row.id);
  }

  updateView(orgId: string, id: string, patch: Partial<ViewDef>): ViewDef {
    const existing = this.view(orgId, id);
    if (patch.filter) compileFilter(patch.filter, this.env(orgId, existing.object_type));
    if (patch.sort) compileSort(patch.sort, this.env(orgId, existing.object_type));
    const changes: Record<string, unknown> = { updated: this.ctx.now() };
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.description !== undefined) changes.description = patch.description;
    if (patch.columns !== undefined) changes.columns = JSON.stringify(patch.columns);
    if (patch.filter !== undefined) changes.filter = patch.filter ? JSON.stringify(patch.filter) : null;
    if (patch.sort !== undefined) changes.sort = JSON.stringify(patch.sort);
    if (patch.shared !== undefined) changes.shared = patch.shared ? 1 : 0;
    if (patch.position !== undefined) changes.position = patch.position;
    if (patch.is_default !== undefined) changes.is_default = patch.is_default ? 1 : 0;
    this.ctx.db.patch('crm_views', 'id', id, changes as Record<string, never>);
    if (patch.is_default) this.ctx.db.run(`UPDATE crm_views SET is_default = 0 WHERE org_id = ? AND object_type = ? AND id <> ?`, orgId, existing.object_type, id);
    this.ctx.emit(orgId, 'view.updated', { id, changes }, { objectId: id, objectType: 'view' });
    return this.view(orgId, id);
  }

  deleteView(orgId: string, id: string): void {
    const existing = this.view(orgId, id);
    if (existing.system) throw badRequest('view_system', `"${existing.name}" ships with Ain and cannot be deleted. Duplicate it and edit the copy.`);
    this.ctx.db.run(`DELETE FROM crm_views WHERE org_id = ? AND id = ?`, orgId, id);
    this.ctx.emit(orgId, 'view.deleted', { id, name: existing.name }, { objectId: id, objectType: 'view' });
  }
}

/* ------------------------------- hydration -------------------------------- */

function hydrateObjectType(row: ObjectTypeRow): ObjectTypeDef {
  return {
    org_id: row.org_id, name: row.name, id: row.id, label: row.label, plural_label: row.plural_label,
    description: row.description, icon: row.icon, color: row.color,
    primary_property: row.primary_property, secondary_property: row.secondary_property,
    searchable: parseJson<string[]>(row.searchable, []),
    category: row.category === 'activity' ? 'activity' : 'record',
    system: !!row.system, position: row.position, created: row.created, updated: row.updated,
  };
}

function hydrateProperty(row: PropertyRow): PropertyDef {
  return {
    org_id: row.org_id, object_type: row.object_type, name: row.name, id: row.id, label: row.label,
    description: row.description, type: row.type, group: row.group_name,
    options: parseJson(row.options, []), reference_type: row.reference_type,
    required: !!row.required, unique: !!row.unique_value, read_only: !!row.read_only,
    system: !!row.system, hidden: !!row.hidden,
    default_value: row.default_value === null ? null : parseJson<PropertyValue>(row.default_value, null),
    validation: parseJson(row.validation, {}), calculated: row.calculated, currency: row.currency,
    normalize: NORMALISERS.includes(row.normalize as PropertyDef['normalize']) ? (row.normalize as PropertyDef['normalize']) : 'none',
    position: row.position, created: row.created, updated: row.updated,
  };
}

function hydrateRecord(row: RecordRow): CrmRecord {
  return {
    object: 'record', id: row.id, object_type: row.object_type,
    properties: parseJson<Record<string, PropertyValue>>(row.properties, {}),
    display_name: row.display_name, owner_id: row.owner_id, source: row.source,
    archived: !!row.archived, merged_into: row.merged_into,
    created: row.created, updated: row.updated, created_by: row.created_by, updated_by: row.updated_by,
  };
}

function hydrateView(row: any): ViewDef {
  return {
    object: 'view', id: row.id, org_id: row.org_id, object_type: row.object_type, name: row.name,
    description: row.description, columns: parseJson<string[]>(row.columns, []),
    filter: row.filter ? parseJson<FilterNode | null>(row.filter, null) : null,
    sort: parseJson(row.sort, []), shared: !!row.shared, owner_id: row.owner_id,
    is_default: !!row.is_default, system: !!row.system, position: row.position,
    created: row.created, updated: row.updated,
  };
}

/* --------------------------------- helpers -------------------------------- */

/**
 * Sources allowed to write a maintained property. A person or an agent gets a
 * message pointing at what owns the value; a migration, a merge or an import of
 * historical records can still carry the stamp it already has.
 */
const MAINTAINED_SOURCES = new Set<ChangeSource>(['system', 'merge', 'import']);

const ID_PREFIXES: Record<string, string> = {
  contact: 'con', company: 'cmp', deal: 'deal', ticket: 'tkt',
  note: 'note', call: 'call', meeting: 'meet', email: 'em', task: 'task',
};
const prefixFor = (objectType: string): string => ID_PREFIXES[objectType] ?? `rec_${objectType.slice(0, 4)}`;

function splitOwner(input: Record<string, unknown>, opts: WriteOptions): { ownerId: string | null; ownerProvided: boolean; properties: Record<string, unknown> } {
  const properties = { ...input };
  let ownerProvided = false;
  let ownerId: string | null = null;
  if ('owner_id' in properties) {
    ownerProvided = true;
    const raw = properties.owner_id;
    ownerId = raw === null || raw === '' ? null : String(raw);
    delete properties.owner_id;
  }
  if (opts.ownerId !== undefined) { ownerProvided = true; ownerId = opts.ownerId; }
  return { ownerId, ownerProvided, properties };
}

function rejectUnknown(input: Record<string, unknown>, index: PropertyIndex, objectType: string): void {
  for (const key of Object.keys(input)) {
    if (index.has(key)) continue;
    throw badRequest(
      'property_unknown',
      `"${key}" is not a property of ${objectType}. Create it with POST /v1/objects/${objectType}/properties, or check the spelling.`,
      `properties.${key}`,
    );
  }
}

function buildSearchBlob(objectDef: ObjectTypeDef, values: Record<string, PropertyValue>): string {
  const names = objectDef.searchable.length ? objectDef.searchable : [objectDef.primary_property];
  const parts: string[] = [];
  for (const name of names) {
    const value = values[name];
    if (isEmptyValue(value)) continue;
    parts.push(Array.isArray(value) ? value.join(' ') : String(value));
  }
  return parts.join(' • ').toLowerCase().slice(0, 2000);
}

/** Record-level fields that get history rows without being properties. */
const BUILTIN_HISTORY_LABELS: Record<string, string> = {
  owner_id: 'Owner',
  archived: 'Archived',
  merged_from: 'Duplicate merged in',
};

function labelForBuiltin(name: string): string {
  return BUILTIN_HISTORY_LABELS[name] ?? name;
}

const SIGNATURE_KEYS = ['filter', 'query', 'sort', 'include_archived', 'associated_to'] as const;

function signatureOf(objectType: string, query: SearchQuery): string {
  const shape: Record<string, unknown> = { objectType };
  for (const key of SIGNATURE_KEYS) shape[key] = (query as Record<string, unknown>)[key] ?? null;
  return createHash('sha1').update(JSON.stringify(shape)).digest('base64url').slice(0, 12);
}

/**
 * The largest page `/history` will answer with. The row read is allowed one
 * past it, because the pager measures `has_more` by fetching a row it will not
 * show — clamping both to the same number made the maximum page the one page
 * that could never say there was more, and a deal with 800 audit rows ended at
 * 500 with `next_cursor: null`.
 */
const HISTORY_PAGE_MAX = 500;

/**
 * A history cursor is the exact position of the last row returned, not a
 * timestamp: `(changed_at, seq)` is a total order, so resuming from it lands on
 * the very next row even when a dozen changes share one millisecond.
 */
export function encodeHistoryCursor(changedAt: number, seq: number): string {
  return Buffer.from(`h1.${changedAt}.${seq}`).toString('base64url');
}

function decodeHistoryCursor(cursor: string | undefined): { changed_at: number; seq: number } | null {
  if (!cursor) return null;
  let decoded = '';
  try { decoded = Buffer.from(cursor, 'base64url').toString('utf8'); } catch { decoded = ''; }
  const [tag, changedAt, seq] = decoded.split('.');
  if (tag !== 'h1' || !Number.isInteger(Number(changedAt)) || !Number.isInteger(Number(seq))) {
    throw badRequest(
      'cursor_invalid',
      'That is not a history cursor. Pass the `next_cursor` from the previous page verbatim as `after`, or start again without it.',
      'after',
    );
  }
  return { changed_at: Number(changedAt), seq: Number(seq) };
}

function encodeCursor(offset: number, signature: string): string {
  return Buffer.from(`${offset}.${signature}`).toString('base64url');
}

function decodeCursor(cursor: string | undefined, signature: string): number {
  if (!cursor) return 0;
  let decoded: string;
  try { decoded = Buffer.from(cursor, 'base64url').toString('utf8'); }
  catch { throw badRequest('cursor_invalid', 'The pagination cursor is malformed. Start again from the first page.', 'after'); }
  const [offsetPart, sig] = decoded.split('.');
  const offset = Number(offsetPart);
  if (!Number.isInteger(offset) || offset < 0 || sig !== signature) {
    throw badRequest('cursor_invalid', 'This cursor belongs to a different query. Cursors are only valid for the filter and sort that produced them.', 'after');
  }
  return offset;
}
