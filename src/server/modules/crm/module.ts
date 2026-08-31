import { defineModule } from '../../kernel/module';
import type { Ctx } from '../../kernel/context';
import { created, list, noContent, type Req } from '../../kernel/http';
import { ApiError, badRequest, isApiError, notFound } from '../../../shared/errors';
import v from '../../../shared/validate';
import { CRM_MIGRATIONS } from './schema';
import { Crm, type HistoryQuery } from './store';
import { buildTimeline, buildTimelinePage, type TimelineOptions, type TimelinePage } from './timeline';
import { findSimilar, mergeRecords, type MergeResult, type SimilarMatch } from './dedupe';
import { installBuiltins, seedCrm } from './seed';
import { EXPRESSION_FUNCTIONS } from './expr';
import { BUILTIN_PROPERTY_NAMES, suggestProperty } from './filter';
import { FILTER_OPERATORS } from './types';
import { CUSTOM_PIPELINE_PROPERTIES, safeMinorUnits, type PipelineInput, type PipelinePatch, type StageUsage } from './pipelines';
import { pipelineVelocity, stageHistory } from './velocity';
import type {
  AssociationSummary, AssociationTypeDef, ChangeSource, CrmRecord, FilterNode, HistoryEntry,
  HistoryPage, ObjectTypeDef, PipelineDef, PipelineStageDef, PropertyDef, PropertyValue, SearchQuery,
  SearchResult, StageSpell, TimelineItem, ViewDef, WriteOptions,
} from './types';

/* -------------------------------- service --------------------------------- */

export interface LogActivityInput {
  type: string;
  subject?: string;
  body?: string;
  occurredAt?: number;
  ownerId?: string | null;
  /** Record ids this activity lands on — a contact, its company, a deal. */
  associateTo: string[];
  properties?: Record<string, unknown>;
}

/**
 * Everything the rest of the platform needs from the CRM. Billing resolves a
 * company, support opens a ticket, workflows filter records, agents log notes —
 * all through this one surface, so nobody reaches into `crm_records` directly.
 */
export interface CrmService {
  objectTypes(orgId: string): ObjectTypeDef[];
  objectType(orgId: string, name: string): ObjectTypeDef;
  activityTypes(orgId: string): string[];
  properties(orgId: string, objectType: string): PropertyDef[];
  property(orgId: string, objectType: string, name: string): PropertyDef;
  /** Other modules extend the schema here rather than editing the CRM. */
  defineProperty(orgId: string, objectType: string, def: Partial<PropertyDef> & { name: string; label: string; type: PropertyDef['type'] }): PropertyDef;

  get(orgId: string, objectType: string, id: string): CrmRecord | null;
  require(orgId: string, objectType: string, id: string): CrmRecord;
  /** Follows merge chains, so an id from before a dedupe still resolves. */
  resolve(orgId: string, id: string): CrmRecord | null;
  getMany(orgId: string, ids: string[]): CrmRecord[];
  findBy(orgId: string, objectType: string, property: string, value: string | number): CrmRecord | null;

  create(orgId: string, objectType: string, properties: Record<string, unknown>, opts?: WriteOptions): CrmRecord;
  update(orgId: string, objectType: string, id: string, properties: Record<string, unknown>, opts?: WriteOptions): CrmRecord;
  archive(orgId: string, objectType: string, id: string, opts?: WriteOptions): CrmRecord;

  search(orgId: string, objectType: string, query?: SearchQuery): SearchResult;
  count(orgId: string, objectType: string, filter?: FilterNode, opts?: { includeArchived?: boolean }): number;

  associate(orgId: string, input: { fromId: string; toId: string; associationType?: string; primary?: boolean }, opts?: WriteOptions): AssociationSummary;
  disassociate(orgId: string, filter: { id?: string; fromId?: string; toId?: string; associationType?: string }, opts?: WriteOptions): number;
  associations(orgId: string, recordId: string, opts?: { objectType?: string; associationType?: string; limit?: number }): AssociationSummary[];
  associated(orgId: string, recordId: string, objectType: string, limit?: number): CrmRecord[];
  associationTypes(orgId: string): AssociationTypeDef[];

  logActivity(orgId: string, input: LogActivityInput, opts?: WriteOptions): CrmRecord;
  timeline(orgId: string, objectType: string, id: string, opts?: TimelineOptions): TimelineItem[];
  /** The same merge, paged on a cursor that cannot skip an item. */
  timelinePage(orgId: string, objectType: string, id: string, opts?: TimelineOptions): TimelinePage;
  history(orgId: string, recordId: string, opts?: HistoryQuery): HistoryEntry[];
  /** The same trail, paged on a cursor that cannot skip a row. */
  historyPage(orgId: string, recordId: string, opts?: HistoryQuery): HistoryPage;
  /** Every stage a record has been through, replayed from its history. */
  stageHistory(orgId: string, objectType: string, id: string): StageSpell[];

  merge(orgId: string, objectType: string, winnerId: string, loserId: string, opts?: WriteOptions): MergeResult;
  similar(orgId: string, objectType: string, id: string, limit?: number): SimilarMatch[];

  views(orgId: string, objectType?: string): ViewDef[];

  /** Pipelines and their ordered stages — the source of truth for "is it open?". */
  pipelines(orgId: string, objectType: string): PipelineDef[];
  pipeline(orgId: string, objectType: string, key: string): PipelineDef;
  stageOf(orgId: string, objectType: string, pipeline: string, stage: string): PipelineStageDef | null;
  /** Stage names that do not close the record, across every pipeline. */
  openStages(orgId: string, objectType: string): string[];
  closedStages(orgId: string, objectType: string, opts?: { wonOnly?: boolean }): string[];

  /** Bootstrap the built-in object model into a workspace. */
  installBuiltins(orgId: string): void;
}

declare module '../../kernel/services' {
  interface ServiceRegistry { crm: CrmService }
}

/* --------------------------------- helpers -------------------------------- */

/**
 * One engine per runtime context. `boot`, `routes`, `tools` and `seed` all run
 * against the same schema cache, so defining a property in a route is visible
 * to the very next agent tool call.
 */
const engines = new WeakMap<Ctx, Crm>();
export function crmEngine(ctx: Ctx): Crm {
  let engine = engines.get(ctx);
  if (!engine) { engine = new Crm(ctx); engines.set(ctx, engine); }
  return engine;
}

const writeOptions = (req: Req, source?: ChangeSource): WriteOptions => ({
  actorId: req.auth.userId ?? req.auth.keyId ?? null,
  actorType: req.auth.kind === 'api_key' ? 'api_key' : req.auth.kind === 'system' ? 'system' : 'user',
  source: source ?? (req.auth.kind === 'api_key' ? 'api' : 'user'),
  requestId: req.requestId,
});

/**
 * An instant a caller can actually type. `v.timestamp()` accepts a JSON number
 * or an ISO string, but a query string is always text — so the endpoint that
 * emits `changed_at: 1788130545105` rejected that exact value when it came
 * back as `?before=1788130545105`. Numeric strings coerce here.
 */
const instant = () => v.transform(
  v.union(v.int(), v.timestamp()),
  (value: number) => value,
  { type: 'integer', format: 'unix-ms', fields: undefined, description: 'Unix milliseconds or an ISO-8601 timestamp.' },
);

const splitList = (value: unknown): string[] =>
  typeof value === 'string' && value.trim() ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];

const propertyBody = v.object({
  name: v.string({ min: 1, max: 60 }),
  label: v.string({ min: 1, max: 120 }),
  type: v.enum(['string', 'text', 'number', 'currency', 'date', 'datetime', 'bool', 'enum', 'multi_enum', 'url', 'email', 'phone', 'user', 'reference', 'json', 'computed'] as const),
  description: v.optional(v.string({ max: 500 })),
  group: v.optional(v.string({ max: 60 })),
  options: v.optional(v.array(v.object({
    value: v.string({ min: 1, max: 100 }),
    label: v.string({ min: 1, max: 120 }),
    color: v.optional(v.string({ max: 24 })),
    description: v.optional(v.string({ max: 240 })),
    position: v.optional(v.int()),
  }), { max: 300 })),
  reference_type: v.optional(v.string({ max: 60 })),
  required: v.optional(v.boolean()),
  unique: v.optional(v.boolean()),
  hidden: v.optional(v.boolean()),
  read_only: v.optional(v.boolean()),
  default_value: v.optional(v.any()),
  validation: v.optional(v.object({
    min: v.optional(v.number()), max: v.optional(v.number()),
    min_length: v.optional(v.int({ min: 0 })), max_length: v.optional(v.int({ min: 0 })),
    pattern: v.optional(v.string({ max: 240 })), allow_other: v.optional(v.boolean()),
  })),
  calculated: v.optional(v.string({ max: 1000 })),
  normalize: v.optional(v.enum(['none', 'lower', 'upper', 'domain', 'digits'] as const)),
  currency: v.optional(v.currency()),
  position: v.optional(v.int({ min: 0, max: 10_000 })),
}, { strict: true });

const searchBody = v.object({
  filter: v.optional(v.any()),
  query: v.optional(v.string({ max: 200 })),
  sort: v.optional(v.array(v.object({
    property: v.string({ min: 1, max: 60 }),
    direction: v.optional(v.enum(['asc', 'desc'] as const)),
  }), { max: 4 })),
  properties: v.optional(v.array(v.string({ max: 60 }), { max: 100 })),
  limit: v.optional(v.int({ min: 1, max: 200 })),
  after: v.optional(v.string({ max: 200 })),
  /** Accepted as an alias for `after`, because the response calls it `next_cursor`. */
  cursor: v.optional(v.string({ max: 200 })),
  include_archived: v.optional(v.boolean()),
  associated_to: v.optional(v.string({ max: 80 })),
  expand: v.optional(v.array(v.string({ max: 40 }), { max: 5 })),
  explain: v.optional(v.boolean()),
}, { strict: true });

const listQuery = v.object({
  limit: v.optional(v.int({ min: 1, max: 200 })),
  after: v.optional(v.string({ max: 200 })),
  cursor: v.optional(v.string({ max: 200 })),
  q: v.optional(v.string({ max: 200 })),
  sort: v.optional(v.string({ max: 60 })),
  order: v.optional(v.enum(['asc', 'desc'] as const)),
  owner_id: v.optional(v.string({ max: 80 })),
  view: v.optional(v.string({ max: 80 })),
  associated_to: v.optional(v.string({ max: 80 })),
  include_archived: v.optional(v.boolean()),
  expand: v.optional(v.string({ max: 120 })),
  properties: v.optional(v.string({ max: 600 })),
}, { strict: true });

/* --------------------------------- module --------------------------------- */

export default defineModule({
  name: 'crm',
  title: 'Smart CRM',
  description: 'The object model the whole platform hangs off: typed records with history, first-class pipelines whose stages own the forecast, a real filter engine, associations, activities and saved views.',
  dependsOn: ['core'],
  migrations: CRM_MIGRATIONS,

  boot(ctx) {
    const crm = crmEngine(ctx);

    const service: CrmService = {
      objectTypes: (orgId) => crm.objectTypes(orgId),
      objectType: (orgId, name) => crm.objectType(orgId, name),
      activityTypes: (orgId) => crm.activityTypes(orgId),
      properties: (orgId, objectType) => crm.properties(orgId, objectType),
      property: (orgId, objectType, name) => crm.property(orgId, objectType, name),
      defineProperty: (orgId, objectType, def) => crm.defineProperty(orgId, objectType, def),

      get: (orgId, objectType, id) => crm.get(orgId, objectType, id),
      require: (orgId, objectType, id) => crm.require(orgId, objectType, id),
      resolve: (orgId, id) => crm.resolve(orgId, id),
      getMany: (orgId, ids) => crm.getMany(orgId, ids),
      findBy: (orgId, objectType, property, value) => crm.findBy(orgId, objectType, property, value),

      create: (orgId, objectType, properties, opts) => crm.create(orgId, objectType, properties, opts),
      update: (orgId, objectType, id, properties, opts) => crm.update(orgId, objectType, id, properties, opts),
      archive: (orgId, objectType, id, opts) => crm.archive(orgId, objectType, id, opts),

      search: (orgId, objectType, query) => crm.search(orgId, objectType, query),
      count: (orgId, objectType, filter, opts) => crm.count(orgId, objectType, filter, opts),

      associate: (orgId, input, opts) => crm.associate(orgId, input, opts),
      disassociate: (orgId, filter, opts) => crm.disassociate(orgId, filter, opts),
      associations: (orgId, recordId, opts) => crm.associationsOf(orgId, recordId, opts),
      associated: (orgId, recordId, objectType, limit) => crm.associated(orgId, recordId, objectType, limit),
      associationTypes: (orgId) => crm.associationTypes(orgId),

      logActivity(orgId, input, opts = {}) {
        return ctx.atomic(() => {
          const activity = crm.create(orgId, input.type, {
            ...(input.subject !== undefined ? { subject: input.subject } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
            occurred_at: input.occurredAt ?? ctx.now(),
            ...(input.properties ?? {}),
          }, { ...opts, ownerId: input.ownerId ?? opts.actorId ?? null });
          for (const target of input.associateTo) {
            crm.associate(orgId, { fromId: activity.id, toId: target, associationType: 'activity_to_record' }, opts);
          }
          return activity;
        });
      },

      timeline: (orgId, objectType, id, opts) => buildTimeline(ctx, crm, orgId, crm.require(orgId, objectType, id), opts),
      timelinePage: (orgId, objectType, id, opts) => buildTimelinePage(ctx, crm, orgId, crm.require(orgId, objectType, id), opts),
      history: (orgId, recordId, opts) => crm.history(orgId, recordId, opts),
      historyPage: (orgId, recordId, opts) => crm.historyPage(orgId, recordId, opts),
      stageHistory: (orgId, objectType, id) => stageHistory(ctx, crm, orgId, crm.require(orgId, objectType, id)),

      merge: (orgId, objectType, winnerId, loserId, opts) =>
        ctx.atomic(() => mergeRecords(ctx, crm, orgId, objectType, winnerId, loserId, opts)),
      similar: (orgId, objectType, id, limit) => findSimilar(ctx, crm, orgId, crm.require(orgId, objectType, id), limit),

      views: (orgId, objectType) => crm.views(orgId, objectType),

      pipelines: (orgId, objectType) => crm.pipelines.list(orgId, objectType),
      pipeline: (orgId, objectType, key) => crm.pipelines.get(orgId, objectType, key),
      stageOf: (orgId, objectType, pipeline, stage) => crm.pipelines.stage(orgId, objectType, pipeline, stage),
      openStages: (orgId, objectType) => crm.pipelines.openStages(orgId, objectType),
      closedStages: (orgId, objectType, opts) => crm.pipelines.closedStages(orgId, objectType, opts),

      installBuiltins: (orgId) => ctx.atomic(() => installBuiltins(ctx, crm, orgId)),
    };

    ctx.provide('crm', service);
  },

  seed(ctx, orgId) {
    seedCrm(ctx, crmEngine(ctx), orgId);
  },

  routes(router, ctx) {
    const crm = crmEngine(ctx);
    const svc = () => ctx.svc.crm;

    /* ----------------------------- object types --------------------------- */

    router.get('/v1/objects', (req: Req) => {
      const types = crm.objectTypes(req.auth.orgId);
      return list(types.map((t) => ({
        object: 'object_type' as const,
        ...t,
        record_count: ctx.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = ? AND archived = 0 AND merged_into IS NULL`, req.auth.orgId, t.name),
        property_count: crm.propertyIndex(req.auth.orgId, t.name).size,
      })), { totalCount: types.length });
    }, { summary: 'List every object type in the workspace', tags: ['crm'] });

    router.post('/v1/objects', (req: Req) => {
      const body = req.body as Parameters<Crm['createObjectType']>[1];
      return created({ object: 'object_type', ...ctx.atomic(() => crm.createObjectType(req.auth.orgId, body)) });
    }, {
      summary: 'Create a custom object type', tags: ['crm'], roles: ['admin'],
      body: v.object({
        name: v.string({ min: 2, max: 40, pattern: /^[a-z][a-z0-9_]*$/ }),
        label: v.string({ min: 1, max: 60 }),
        plural_label: v.string({ min: 1, max: 60 }),
        description: v.optional(v.string({ max: 400 })),
        icon: v.optional(v.string({ max: 40 })),
        color: v.optional(v.string({ max: 24 })),
        primary_property: v.optional(v.string({ max: 60 })),
        searchable: v.optional(v.array(v.string({ max: 60 }), { max: 20 })),
        position: v.optional(v.int({ min: 0, max: 10_000 })),
      }, { strict: true }),
    });

    router.get('/v1/objects/:type', (req: Req) => {
      const type = crm.objectType(req.auth.orgId, req.params.type);
      return {
        object: 'object_type', ...type,
        properties: crm.properties(req.auth.orgId, type.name),
        views: crm.views(req.auth.orgId, type.name),
        ...(crm.pipelines.binding(req.auth.orgId, type.name) ? { pipelines: crm.pipelines.list(req.auth.orgId, type.name) } : {}),
        associations: crm.associationTypes(req.auth.orgId).filter((a) => a.from_object === type.name || a.to_object === type.name || a.from_object === '*'),
        record_count: ctx.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = ? AND archived = 0 AND merged_into IS NULL`, req.auth.orgId, type.name),
      };
    }, { summary: 'Retrieve one object type with its schema', tags: ['crm'] });

    router.patch('/v1/objects/:type', (req: Req) =>
      ({ object: 'object_type', ...ctx.atomic(() => crm.updateObjectType(req.auth.orgId, req.params.type, req.body as Partial<ObjectTypeDef>)) }), {
      summary: 'Update an object type', tags: ['crm'], roles: ['admin'],
      body: v.object({
        label: v.optional(v.string({ min: 1, max: 60 })),
        plural_label: v.optional(v.string({ min: 1, max: 60 })),
        description: v.optional(v.string({ max: 400 })),
        icon: v.optional(v.string({ max: 40 })),
        color: v.optional(v.string({ max: 24 })),
        primary_property: v.optional(v.string({ max: 60 })),
        secondary_property: v.optional(v.string({ max: 60 })),
        searchable: v.optional(v.array(v.string({ max: 60 }), { max: 20 })),
        position: v.optional(v.int({ min: 0, max: 10_000 })),
      }, { strict: true }),
    });

    router.del('/v1/objects/:type', (req: Req) => {
      ctx.atomic(() => crm.deleteObjectType(req.auth.orgId, req.params.type));
      return noContent();
    }, { summary: 'Delete a custom object type', tags: ['crm'], roles: ['admin'] });

    /* ------------------------------ properties ---------------------------- */

    router.get('/v1/objects/:type/properties', (req: Req) => {
      const props = crm.properties(req.auth.orgId, req.params.type);
      return {
        ...list(props.map((p) => ({ object: 'property' as const, ...p })), {
          totalCount: props.length,
          url: `/v1/objects/${req.params.type}/properties`,
        }),
        // Groups drive the section order on a record's detail panel.
        groups: [...new Set(props.map((p) => p.group))],
      };
    }, { summary: 'List the properties of an object type, in display order', tags: ['crm'] });

    router.post('/v1/objects/:type/properties', (req: Req) => {
      const body = req.body as Parameters<Crm['defineProperty']>[2];
      return created({ object: 'property', ...ctx.atomic(() => crm.defineProperty(req.auth.orgId, req.params.type, body)) });
    }, { summary: 'Create a property', tags: ['crm'], roles: ['admin'], body: propertyBody });

    router.get('/v1/objects/:type/properties/:name', (req: Req) => {
      const prop = crm.property(req.auth.orgId, req.params.type, req.params.name);
      const usage = ctx.db.count(
        `SELECT COUNT(*) FROM crm_record_values WHERE org_id = ? AND object_type = ? AND property = ?`,
        req.auth.orgId, req.params.type, req.params.name);
      return { object: 'property', ...prop, records_with_value: usage };
    }, { summary: 'Retrieve one property', tags: ['crm'] });

    router.patch('/v1/objects/:type/properties/:name', (req: Req) =>
      ({ object: 'property', ...ctx.atomic(() => crm.updateProperty(req.auth.orgId, req.params.type, req.params.name, req.body as Partial<PropertyDef>)) }), {
      summary: 'Update a property', tags: ['crm'], roles: ['admin'],
      body: v.object({
        label: v.optional(v.string({ min: 1, max: 120 })),
        description: v.optional(v.string({ max: 500 })),
        group: v.optional(v.string({ max: 60 })),
        options: v.optional(v.array(v.object({
          value: v.string({ min: 1, max: 100 }), label: v.string({ min: 1, max: 120 }),
          color: v.optional(v.string({ max: 24 })), description: v.optional(v.string({ max: 240 })),
          position: v.optional(v.int()),
        }), { max: 300 })),
        required: v.optional(v.boolean()),
        unique: v.optional(v.boolean()),
        hidden: v.optional(v.boolean()),
        read_only: v.optional(v.boolean()),
        default_value: v.optional(v.any()),
        validation: v.optional(v.any()),
        calculated: v.optional(v.string({ max: 1000 })),
        position: v.optional(v.int({ min: 0, max: 10_000 })),
      }, { strict: true }),
    });

    router.del('/v1/objects/:type/properties/:name', (req: Req) => {
      ctx.atomic(() => crm.deleteProperty(req.auth.orgId, req.params.type, req.params.name));
      return noContent();
    }, { summary: 'Delete a property and every value stored against it', tags: ['crm'], roles: ['admin'] });

    /* ------------------------------- pipelines ---------------------------- */

    const stageBody = v.object({
      name: v.string({ min: 1, max: 60 }),
      label: v.string({ min: 1, max: 80 }),
      description: v.optional(v.nullable(v.string({ max: 400 }))),
      probability: v.optional(v.number({ min: 0, max: 100 })),
      is_closed: v.optional(v.boolean()),
      is_won: v.optional(v.boolean()),
      forecast_category: v.optional(v.nullable(v.string({ max: 40 }))),
      color: v.optional(v.string({ max: 24 })),
    }, { strict: true });

    /**
     * A pipeline is only useful next to what is actually sitting in it, so
     * every stage comes back with its live record count and value, computed
     * from the value index at request time.
     */
    const summarise = (orgId: string, objectType: string, pipeline: PipelineDef, usage: Map<string, StageUsage>) => {
      const binding = crm.pipelines.requireBinding(orgId, objectType);
      const money = !!binding.amount_property;
      let records = 0;
      let openAmount = 0;
      let weighted = 0;
      let wonAmount = 0;
      const stages = pipeline.stages.map((stage) => {
        const used = usage.get(`${pipeline.name}:${stage.name}`) ?? { records: 0, amount: 0, weighted_amount: 0 };
        records += used.records;
        if (!stage.is_closed) { openAmount += used.amount; weighted += used.weighted_amount; }
        if (stage.is_won) wonAmount += used.amount;
        return {
          ...stage,
          record_count: used.records,
          ...(money ? { amount: used.amount, weighted_amount: used.weighted_amount } : {}),
        };
      });
      return {
        object: 'pipeline' as const,
        id: pipeline.id, object_type: objectType, name: pipeline.name, label: pipeline.label,
        description: pipeline.description, is_default: pipeline.is_default, archived: pipeline.archived,
        position: pipeline.position,
        pipeline_property: binding.pipeline_property,
        stage_property: binding.stage_property,
        record_count: records,
        ...(money ? {
          open_amount: safeMinorUnits(openAmount),
          weighted_amount: safeMinorUnits(weighted),
          won_amount: safeMinorUnits(wonAmount),
        } : {}),
        stages,
        created: pipeline.created, updated: pipeline.updated,
      };
    };

    const pipelinesOf = (orgId: string, objectType: string, includeArchived: boolean) => {
      const usage = crm.pipelines.usage(orgId, objectType);
      return crm.pipelines.list(orgId, objectType, { includeArchived })
        .map((pipeline) => summarise(orgId, objectType, pipeline, usage));
    };

    router.get('/v1/pipelines', (req: Req) => {
      const orgId = req.auth.orgId;
      const data = crm.pipelines.boundTypes(orgId)
        .filter((type) => crm.objectTypeOrNull(orgId, type))
        .flatMap((type) => pipelinesOf(orgId, type, false));
      return list(data, { totalCount: data.length, url: '/v1/pipelines' });
    }, {
      summary: 'Every pipeline in the workspace, across object types', tags: ['crm'],
      description: 'Deals and tickets both move through pipelines. Each stage carries its probability, whether it closes the record, and how many records are sitting in it right now.',
    });

    router.get('/v1/pipelines/:objectType', (req: Req) => {
      const orgId = req.auth.orgId;
      const objectType = req.params.objectType;
      crm.objectType(orgId, objectType);
      crm.pipelines.requireBinding(orgId, objectType);
      const data = pipelinesOf(orgId, objectType, String(req.query.include_archived) === 'true');
      return list(data, { totalCount: data.length, url: `/v1/pipelines/${objectType}` });
    }, {
      summary: 'The pipelines an object type moves through, with ordered stages', tags: ['crm'],
      description: 'The stage list is the contract: `deal_stage` is validated against the stages of the deal’s own pipeline, and probability, forecast category and close date are read from the stage on every write.',
      query: v.object({ include_archived: v.optional(v.boolean()) }, { strict: true }),
    });

    /**
     * A user-defined object earns a pipeline by asking for one. HubSpot makes
     * you add the properties yourself and then wire them up; here the first
     * pipeline on an "Installation" object provisions `pipeline`, `stage`,
     * `stage_entered_at` and the close stamps, and the object behaves exactly
     * like a deal from that moment on.
     */
    const enablePipelines = (orgId: string, objectType: string): string[] => {
      if (crm.pipelines.binding(orgId, objectType)) return [];
      const objectDef = crm.objectType(orgId, objectType);
      if (objectDef.system) crm.pipelines.requireBinding(orgId, objectType);
      const addedProperties: string[] = [];
      for (const prop of CUSTOM_PIPELINE_PROPERTIES) {
        if (crm.propertyOrNull(orgId, objectType, prop.name)) continue;
        crm.defineProperty(orgId, objectType, { ...prop, system: true });
        addedProperties.push(prop.name);
      }
      crm.reloadSchema();
      return addedProperties;
    };

    router.post('/v1/pipelines/:objectType', (req: Req) => {
      const orgId = req.auth.orgId;
      const objectType = req.params.objectType;
      crm.objectType(orgId, objectType);
      let provisioned: string[] = [];
      const pipeline = ctx.atomic(() => {
        provisioned = enablePipelines(orgId, objectType);
        return crm.pipelines.create(orgId, objectType, req.body as PipelineInput);
      });
      return created({
        ...summarise(orgId, objectType, pipeline, crm.pipelines.usage(orgId, objectType)),
        ...(provisioned.length ? { properties_provisioned: provisioned } : {}),
      });
    }, {
      summary: 'Create a pipeline with its ordered stages', tags: ['crm'], roles: ['admin'],
      description: 'Stages are ordered as given. At least one must set `is_closed`, or nothing ever leaves the pipeline. Creating a pipeline regenerates the options of the pipeline and stage properties, so lists and forms pick it up immediately. Pointing this at a custom object type puts that object on pipelines for the first time: `properties_provisioned` names the stage, entered-stage and close properties created for it, and stage moves start restamping them like they do on a deal.',
      body: v.object({
        name: v.string({ min: 2, max: 60, pattern: /^[a-z][a-z0-9_]*$/ }),
        label: v.string({ min: 1, max: 80 }),
        description: v.optional(v.nullable(v.string({ max: 400 }))),
        is_default: v.optional(v.boolean()),
        position: v.optional(v.int({ min: 0, max: 10_000 })),
        stages: v.array(stageBody, { min: 1, max: 40 }),
      }, { strict: true }),
    });

    router.get('/v1/pipelines/:objectType/:id', (req: Req) => {
      const orgId = req.auth.orgId;
      const objectType = req.params.objectType;
      const pipeline = crm.pipelines.get(orgId, objectType, req.params.id);
      return summarise(orgId, objectType, pipeline, crm.pipelines.usage(orgId, objectType));
    }, { summary: 'Retrieve one pipeline by name or id', tags: ['crm'] });

    router.get('/v1/pipelines/:objectType/:id/velocity', (req: Req) =>
      pipelineVelocity(ctx, crm, req.auth.orgId, req.params.objectType, req.params.id), {
      summary: 'Stage velocity: time in stage, advance rate and what has stopped moving', tags: ['crm'],
      description: 'The funnel, replayed from the property history rather than cached in three columns per stage. Each stage reports how many records have ever entered it, the median and mean days they stayed, how long the ones sitting there now have been waiting, and how many are stalled — where stalled means longer than twice this stage’s own median, floored at three days, and `stalled_after_days` says what that worked out to. Everything a record left months ago still counts, which is what a cached per-stage column can never do.',
    });

    /**
     * Editing a stage is editing every record sitting in it. Raising the
     * probability of "Proposal sent" from 60 to 70 has to move the forecast of
     * the twelve deals in that column, with a history row on each — otherwise
     * the pipeline says one thing and the board says another.
     */
    const restampStage = (req: Req, objectType: string, pipeline: string, stages: string[]): number => {
      if (!stages.length) return 0;
      const orgId = req.auth.orgId;
      const binding = crm.pipelines.requireBinding(orgId, objectType);
      const rows = ctx.db.all<{ id: string }>(
        `SELECT r.id FROM crm_records r
           JOIN crm_record_values pv ON pv.record_id = r.id AND pv.property = ?
           JOIN crm_record_values sv ON sv.record_id = r.id AND sv.property = ?
          WHERE r.org_id = ? AND r.object_type = ? AND r.archived = 0 AND r.merged_into IS NULL
            AND pv.value_text = ? AND sv.value_text IN (${stages.map(() => '?').join(',')})`,
        binding.pipeline_property, binding.stage_property, orgId, objectType, pipeline, ...stages,
      );
      let changed = 0;
      for (const row of rows) {
        const before = crm.require(orgId, objectType, row.id);
        const after = crm.update(orgId, objectType, row.id, {}, { ...writeOptions(req, 'system'), actorType: 'system' });
        if (after.updated !== before.updated) changed++;
      }
      return changed;
    };

    router.patch('/v1/pipelines/:objectType/:id', (req: Req) => {
      const orgId = req.auth.orgId;
      const objectType = req.params.objectType;
      const before = crm.pipelines.get(orgId, objectType, req.params.id);
      let restamped = 0;
      const pipeline = ctx.atomic(() => {
        const updated = crm.pipelines.update(orgId, objectType, req.params.id, req.body as PipelinePatch);
        const moved = updated.stages.filter((stage) => {
          const was = before.stages.find((o) => o.name === stage.name);
          return !!was && (was.probability !== stage.probability || was.is_closed !== stage.is_closed
            || was.is_won !== stage.is_won || was.forecast_category !== stage.forecast_category);
        }).map((stage) => stage.name);
        restamped = restampStage(req, objectType, updated.name, moved);
        return updated;
      });
      return {
        ...summarise(orgId, objectType, pipeline, crm.pipelines.usage(orgId, objectType)),
        records_restamped: restamped,
      };
    }, {
      summary: 'Rename a pipeline, reorder its stages, or change a stage probability', tags: ['crm'], roles: ['admin'],
      description: 'Sending `stages` replaces the stage list in the order given. Changing a stage’s probability or its closed flag restamps every record sitting in that stage, each with its own history entry, and `records_restamped` says how many moved. A stage that still holds records cannot be removed — the error says how many are in the way.',
      body: v.object({
        label: v.optional(v.string({ min: 1, max: 80 })),
        description: v.optional(v.nullable(v.string({ max: 400 }))),
        is_default: v.optional(v.boolean()),
        archived: v.optional(v.boolean()),
        position: v.optional(v.int({ min: 0, max: 10_000 })),
        stages: v.optional(v.array(stageBody, { min: 1, max: 40 })),
      }, { strict: true }),
    });

    router.del('/v1/pipelines/:objectType/:id', (req: Req) => {
      ctx.atomic(() => crm.pipelines.remove(req.auth.orgId, req.params.objectType, req.params.id));
      return noContent();
    }, {
      summary: 'Delete a pipeline that no records are using', tags: ['crm'], roles: ['admin'],
    });

    /* -------------------------- the filter grammar ------------------------ */

    router.get('/v1/crm/schema', (req: Req) => ({
      object: 'crm_schema',
      object_types: crm.objectTypes(req.auth.orgId).map((t) => ({
        name: t.name, label: t.label, plural_label: t.plural_label, icon: t.icon, color: t.color,
        category: t.category, primary_property: t.primary_property, secondary_property: t.secondary_property,
      })),
      association_types: crm.associationTypes(req.auth.orgId),
      pipelines: crm.pipelines.boundTypes(req.auth.orgId)
        .filter((type) => crm.objectTypeOrNull(req.auth.orgId, type))
        .flatMap((type) => crm.pipelines.list(req.auth.orgId, type).map((p) => ({
          object_type: type, name: p.name, label: p.label, is_default: p.is_default,
          stage_property: crm.pipelines.requireBinding(req.auth.orgId, type).stage_property,
          stages: p.stages.map((stage) => ({
            name: stage.name, label: stage.label, probability: stage.probability,
            is_closed: stage.is_closed, is_won: stage.is_won,
          })),
        }))),
      operators: FILTER_OPERATORS,
      record_fields: BUILTIN_PROPERTY_NAMES,
      relative_dates: ['now', 'today', 'yesterday', 'tomorrow', 'start_of_week', 'end_of_week', 'start_of_month', 'end_of_month', 'start_of_quarter', 'end_of_quarter', 'start_of_year', 'end_of_year', '-30d', '+2w', '-6mo'],
      expression_functions: EXPRESSION_FUNCTIONS,
    }), { summary: 'Everything needed to build a filter: types, operators, relative dates, formula functions', tags: ['crm'] });

    router.get('/v1/crm/overview', (req: Req) => {
      const orgId = req.auth.orgId;
      const types = crm.objectTypes(orgId);
      const byType = types.map((t) => ({
        name: t.name, label: t.plural_label, icon: t.icon, category: t.category,
        count: ctx.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = ? AND archived = 0 AND merged_into IS NULL`, orgId, t.name),
      }));
      const dealUsage = crm.pipelines.usage(orgId, 'deal');
      const board = crm.pipelines.list(orgId, 'deal').flatMap((pipeline) =>
        pipeline.stages.map((stage) => {
          const used = dealUsage.get(`${pipeline.name}:${stage.name}`) ?? { records: 0, amount: 0, weighted_amount: 0 };
          return {
            pipeline: pipeline.name, pipeline_label: pipeline.label,
            stage: stage.name, label: stage.label, probability: stage.probability,
            is_closed: stage.is_closed, is_won: stage.is_won,
            deals: used.records, amount: used.amount, weighted_amount: used.weighted_amount,
          };
        }));
      const open = board.filter((r) => !r.is_closed);
      const lifecycle = ctx.db.all<{ stage: string; n: number }>(
        `SELECT v.value_text AS stage, COUNT(*) AS n FROM crm_record_values v
          JOIN crm_records r ON r.id = v.record_id
         WHERE v.org_id = ? AND v.object_type = 'company' AND v.property = 'lifecycle_stage' AND r.archived = 0
         GROUP BY v.value_text ORDER BY n DESC`, orgId);
      const since = ctx.now() - 30 * 86_400_000;
      const activityRows = ctx.db.all<{ object_type: string; n: number }>(
        `SELECT r.object_type, COUNT(*) AS n FROM crm_records r
           JOIN crm_record_values v ON v.record_id = r.id AND v.property = 'occurred_at'
          WHERE r.org_id = ? AND v.value_date >= ? AND r.archived = 0
          GROUP BY r.object_type ORDER BY n DESC`, orgId, since);
      return {
        object: 'crm_overview',
        generated_at: ctx.now(),
        records: byType,
        pipeline: board,
        open_pipeline: {
          deals: open.reduce((n, r) => n + r.deals, 0),
          amount: safeMinorUnits(open.reduce((n, r) => n + r.amount, 0)),
          weighted_amount: safeMinorUnits(open.reduce((n, r) => n + r.weighted_amount, 0)),
        },
        lifecycle: lifecycle.map((r) => ({ stage: r.stage, companies: r.n })),
        activity_last_30_days: activityRows.map((r) => ({ type: r.object_type, count: r.n })),
      };
    }, { summary: 'Counts, pipeline by stage and activity volume across the CRM', tags: ['crm'] });

    /* -------------------------------- records ----------------------------- */

    const runSearch = (req: Req, objectType: string, query: SearchQuery, explain = false) => {
      const result = crm.search(req.auth.orgId, objectType, query);
      return {
        ...list(result.records, {
          hasMore: result.has_more,
          nextCursor: result.next_cursor,
          totalCount: result.total,
          url: `/v1/records/${objectType}`,
        }),
        // The cursor comes back named, and as the URL that fetches the next
        // page, so nobody has to guess which request parameter it belongs to.
        next_page: result.next_cursor
          ? `/v1/records/${objectType}?after=${encodeURIComponent(result.next_cursor)}${query.limit ? `&limit=${query.limit}` : ''}`
          : null,
        // Proof, on demand, that the filter compiled to parameterised SQL.
        ...(explain ? { explain: result.explain } : {}),
      };
    };

    router.get('/v1/records/:type', (req: Req) => {
      const q = req.query as Record<string, string | undefined>;
      const objectType = req.params.type;
      let filter: FilterNode | undefined;
      let sort: SearchQuery['sort'];
      let properties: string[] | undefined;

      if (q.view) {
        const view = crm.view(req.auth.orgId, q.view);
        if (view.object_type !== objectType) {
          throw badRequest('view_object_mismatch', `The view "${view.name}" belongs to ${view.object_type}, not ${objectType}.`, 'view');
        }
        filter = view.filter ?? undefined;
        sort = view.sort;
        properties = view.columns.length ? view.columns : undefined;
      }
      if (q.owner_id) {
        const ownerFilter: FilterNode = { property: 'owner_id', operator: 'eq', value: q.owner_id };
        filter = filter ? { op: 'and', filters: [filter, ownerFilter] } : ownerFilter;
      }
      if (q.sort) sort = [{ property: q.sort, direction: q.order === 'asc' ? 'asc' : 'desc' }];
      if (q.properties) properties = splitList(q.properties);

      return runSearch(req, objectType, {
        filter, sort, properties,
        query: q.q,
        limit: q.limit ? Number(q.limit) : 50,
        after: q.after ?? q.cursor,
        include_archived: String(q.include_archived) === 'true',
        associated_to: q.associated_to,
        expand: splitList(q.expand),
      });
    }, {
      summary: 'List records of one object type', tags: ['crm'], query: listQuery,
      description: 'Supports free text (`q`), a saved `view`, a single sort key, cursor pagination and `expand=associations`. For nested filters use POST /v1/records/:type/search.',
    });

    router.post('/v1/records/:type/search', (req: Req) => {
      const body = req.body as SearchQuery & { explain?: boolean; cursor?: string };
      return runSearch(req, req.params.type, { ...body, after: body.after ?? body.cursor }, body.explain === true);
    }, {
      summary: 'Search records with the full filter engine', tags: ['crm'], body: searchBody,
      description: 'Nested and/or/not groups, 19 operators, relative dates and association-aware conditions ("companies whose open deals total more than $75k").',
    });

    router.post('/v1/records/:type/batch', (req: Req) => {
      const body = req.body as {
        operation: 'create' | 'update' | 'upsert';
        id_property?: string;
        records: { id?: string; properties: Record<string, unknown>; owner_id?: string | null }[];
      };
      const orgId = req.auth.orgId;
      const objectType = req.params.type;
      crm.objectType(orgId, objectType);
      const index = crm.propertyIndex(orgId, objectType);
      const opts = writeOptions(req, 'import');

      // The import key is checked once, before a single row is written. An
      // import keyed on a mistyped property used to create every row instead of
      // matching it, which turns a re-import into a bulk-duplicate run.
      if (body.id_property !== undefined) {
        const keyProperty = index.get(body.id_property);
        if (!keyProperty) {
          throw badRequest(
            'property_unknown',
            `"${body.id_property}" is not a property of ${objectType}, so it cannot key this import. ${suggestProperty(body.id_property, index, objectType)}`,
            'id_property',
          );
        }
        if (!keyProperty.unique) {
          const unique = [...index.values()].filter((p) => p.unique).map((p) => p.name);
          throw badRequest(
            'id_property_not_unique',
            `${keyProperty.label} is not a unique property, so one row could match several ${objectType} records. ` +
            (unique.length ? `Key the import on ${unique.join(' or ')}.` : `Mark a property unique first, or import by id.`),
            'id_property',
          );
        }
      }

      const results = body.records.map((item, index_) => {
        const param = (field: string): string => `records[${index_}].${field}`;
        try {
          return ctx.atomic(() => {
            const properties = { ...item.properties };
            if (item.owner_id !== undefined) properties.owner_id = item.owner_id;

            let existing: CrmRecord | null = null;
            if (item.id !== undefined) {
              if (body.operation === 'create') {
                throw badRequest(
                  'record_id_not_assignable',
                  `Ain assigns record ids. Drop \`id\` from this row to create a record, or use operation "upsert" with \`id_property\` to match an existing one.`,
                  param('id'),
                );
              }
              // Resolving across every object type turns "a company id in a
              // contact import" into a sentence instead of a database error.
              const anyType = crm.resolve(orgId, item.id);
              if (!anyType) {
                throw new ApiError('not_found_error', 'resource_missing',
                  `No ${objectType} with id ${item.id}. Ids are assigned by Ain — to match on a business key instead, send \`id_property\`.`,
                  { param: param('id') });
              }
              if (anyType.object_type !== objectType) {
                throw badRequest(
                  'record_type_mismatch',
                  `${item.id} is a ${anyType.object_type} ("${anyType.display_name}"), not a ${objectType}.`,
                  param('id'),
                );
              }
              existing = anyType;
            } else if (body.id_property && properties[body.id_property] !== undefined) {
              existing = crm.findBy(orgId, objectType, body.id_property, properties[body.id_property] as string);
            }

            if (body.operation === 'update') {
              if (!existing) {
                const key = body.id_property ?? 'id';
                throw new ApiError('not_found_error', 'resource_missing',
                  `No ${objectType} matched ${key} = ${JSON.stringify(item.id ?? properties[key] ?? null)}. Use operation "upsert" to create the ones that do not exist yet.`,
                  { param: param(body.id_property ? `properties.${body.id_property}` : 'id') });
              }
              const record = crm.update(orgId, objectType, existing.id, properties, opts);
              return { index: index_, status: 'updated' as const, id: record.id, display_name: record.display_name };
            }
            if (body.operation === 'create' || !existing) {
              const record = crm.create(orgId, objectType, properties, opts);
              return { index: index_, status: 'created' as const, id: record.id, display_name: record.display_name };
            }
            const record = crm.update(orgId, objectType, existing.id, properties, opts);
            return { index: index_, status: 'updated' as const, id: record.id, display_name: record.display_name };
          });
        } catch (e) {
          // A row error is part of the contract, so it has to look like every
          // other Ain error. Anything unrecognised is logged and reported as an
          // internal error rather than leaking a database string.
          if (isApiError(e)) {
            return {
              index: index_, status: 'error' as const,
              error: {
                type: e.type, code: e.code, message: e.message,
                ...(e.param ? { param: e.param } : {}), doc_url: e.docUrl,
              },
            };
          }
          ctx.log.error('crm.batch_row_failed', {
            object_type: objectType, row: index_, request_id: req.requestId,
            error: e instanceof Error ? e.message : String(e),
          });
          return {
            index: index_, status: 'error' as const,
            error: {
              type: 'api_error' as const, code: 'internal_error',
              message: `Row ${index_} could not be written. The request id on this response links to the server log.`,
            },
          };
        }
      });

      const counts = { created: 0, updated: 0, errors: 0 };
      for (const r of results) {
        if (r.status === 'created') counts.created++;
        else if (r.status === 'updated') counts.updated++;
        else counts.errors++;
      }
      return {
        object: 'batch_result',
        operation: body.operation,
        object_type: objectType,
        ...(body.id_property ? { id_property: body.id_property } : {}),
        ...counts,
        has_errors: counts.errors > 0,
        results,
      };
    }, {
      summary: 'Create, update or upsert many records with partial success', tags: ['crm'], roles: ['member'],
      description: 'Each row commits or rolls back on its own, so one bad row never loses the other 499. `id_property` must name a unique property and is validated before the first row runs. Errors come back per row with the offending `param`.',
      body: v.object({
        operation: v.default(v.enum(['create', 'update', 'upsert'] as const), 'upsert'),
        id_property: v.optional(v.string({ max: 60 })),
        records: v.array(v.object({
          id: v.optional(v.string({ max: 80 })),
          properties: v.record(v.any()),
          owner_id: v.optional(v.nullable(v.string({ max: 80 }))),
        }, { strict: true }), { min: 1, max: 500 }),
      }, { strict: true }),
    });

    router.post('/v1/records/:type', (req: Req) => {
      const body = req.body as { properties: Record<string, unknown>; owner_id?: string | null; associate_to?: string[] };
      const orgId = req.auth.orgId;
      const objectType = req.params.type;
      const record = ctx.atomic(() => {
        const properties = { ...body.properties };
        if (body.owner_id !== undefined) properties.owner_id = body.owner_id;
        const made = crm.create(orgId, objectType, properties, writeOptions(req));
        for (const target of body.associate_to ?? []) {
          crm.associate(orgId, { fromId: made.id, toId: target }, writeOptions(req));
        }
        return made;
      });
      ctx.audit({
        orgId, actorId: req.auth.userId, actorType: 'user', action: `${objectType}.created`,
        targetType: objectType, targetId: record.id, summary: `Created ${objectType} “${record.display_name}”`,
        after: record.properties, requestId: req.requestId, ip: req.ip,
      });
      return created(record);
    }, {
      summary: 'Create a record', tags: ['crm'], roles: ['member'],
      body: v.object({
        properties: v.record(v.any()),
        owner_id: v.optional(v.nullable(v.string({ max: 80 }))),
        associate_to: v.optional(v.array(v.string({ max: 80 }), { max: 50 })),
      }, { strict: true }),
    });

    router.get('/v1/records/:type/:id', (req: Req) => {
      const orgId = req.auth.orgId;
      const record = crm.get(orgId, req.params.type, req.params.id);
      // A merged duplicate keeps answering — it redirects to the survivor, so
      // links and integrations saved before a dedupe never break.
      if (!record || record.merged_into) {
        const redirected = crm.resolve(orgId, req.params.id);
        if (redirected && redirected.id !== req.params.id && redirected.object_type === req.params.type) {
          return { ...redirected, merged_from: req.params.id, associations: crm.associationsOf(orgId, redirected.id) };
        }
        if (!record) throw notFound(req.params.type, req.params.id);
      }
      const expand = splitList(req.query.expand);
      return {
        ...record,
        associations: crm.associationsOf(orgId, record.id),
        ...(expand.includes('timeline') ? { timeline: buildTimeline(ctx, crm, orgId, record, { limit: 25 }) } : {}),
        ...(expand.includes('history') ? { history: crm.history(orgId, record.id, { limit: 25 }) } : {}),
        ...(expand.includes('similar') ? { similar: findSimilar(ctx, crm, orgId, record, 3) } : {}),
      };
    }, {
      summary: 'Retrieve one record with its associations', tags: ['crm'],
      query: v.object({ expand: v.optional(v.string({ max: 120 })) }, { strict: true }),
    });

    router.patch('/v1/records/:type/:id', (req: Req) => {
      const body = req.body as { properties?: Record<string, unknown>; owner_id?: string | null };
      const orgId = req.auth.orgId;
      const before = crm.require(orgId, req.params.type, req.params.id);
      const properties = { ...(body.properties ?? {}) };
      if (body.owner_id !== undefined) properties.owner_id = body.owner_id;
      const record = ctx.atomic(() => crm.update(orgId, req.params.type, req.params.id, properties, writeOptions(req)));
      ctx.audit({
        orgId, actorId: req.auth.userId, actorType: 'user', action: `${req.params.type}.updated`,
        targetType: req.params.type, targetId: record.id, summary: `Updated ${record.display_name}`,
        before: before.properties, after: record.properties, requestId: req.requestId, ip: req.ip,
      });
      return record;
    }, {
      summary: 'Update a record', tags: ['crm'], roles: ['member'],
      body: v.object({
        properties: v.optional(v.record(v.any())),
        owner_id: v.optional(v.nullable(v.string({ max: 80 }))),
      }, { strict: true }),
    });

    router.del('/v1/records/:type/:id', (req: Req) => {
      const orgId = req.auth.orgId;
      const permanent = String(req.query.permanent) === 'true';
      const record = crm.require(orgId, req.params.type, req.params.id);
      ctx.atomic(() => {
        if (permanent) crm.destroy(orgId, req.params.type, req.params.id, writeOptions(req));
        else crm.archive(orgId, req.params.type, req.params.id, writeOptions(req));
      });
      ctx.audit({
        orgId, actorId: req.auth.userId, actorType: 'user',
        action: permanent ? `${req.params.type}.deleted` : `${req.params.type}.archived`,
        targetType: req.params.type, targetId: req.params.id,
        summary: `${permanent ? 'Permanently deleted' : 'Archived'} ${record.display_name}`,
        before: record.properties, requestId: req.requestId, ip: req.ip,
      });
      return noContent();
    }, {
      summary: 'Archive a record, or delete it permanently with ?permanent=true', tags: ['crm'], roles: ['member'],
      query: v.object({ permanent: v.optional(v.boolean()) }, { strict: true }),
    });

    router.post('/v1/records/:type/:id/restore', (req: Req) =>
      ctx.atomic(() => crm.restore(req.auth.orgId, req.params.type, req.params.id, writeOptions(req))), {
      summary: 'Restore an archived record', tags: ['crm'], roles: ['member'],
    });

    router.get('/v1/records/:type/:id/timeline', (req: Req) => {
      const orgId = req.auth.orgId;
      const record = crm.require(orgId, req.params.type, req.params.id);
      const q = req.query as Record<string, string | undefined>;
      const limit = q.limit ? Number(q.limit) : 50;
      const kinds = splitList(q.kinds);
      const page = buildTimelinePage(ctx, crm, orgId, record, {
        limit,
        before: q.before ? instant().parse(q.before, 'before') : undefined,
        after: q.after,
        rollUp: q.roll_up === undefined ? undefined : String(q.roll_up) === 'true',
        kinds: kinds as TimelineOptions['kinds'],
      });
      const carry = `${q.roll_up === undefined ? '' : `&roll_up=${String(q.roll_up) === 'true'}`}`
        + `${kinds.length ? `&kinds=${encodeURIComponent(kinds.join(','))}` : ''}`;
      return {
        ...list(page.items, { hasMore: page.has_more, nextCursor: page.next_cursor }),
        next_page: page.next_cursor
          ? `/v1/records/${req.params.type}/${req.params.id}/timeline?after=${encodeURIComponent(page.next_cursor)}&limit=${limit}${carry}`
          : null,
        // An account with more children than one roll-up can anchor says so
        // here, rather than letting `has_more: false` imply the story is over.
        ...(page.roll_up_truncated ? { roll_up_truncated: true, roll_up_anchors: page.roll_up_anchors } : {}),
      };
    }, {
      summary: 'The merged timeline: activities, property changes, events and associations', tags: ['crm'],
      description: 'A company timeline rolls up the activity logged against its contacts, deals and tickets. Pass `roll_up=false` for only what is attached directly. Every item carries the `cursor` that resumes right after it, and paging goes through `after` — never through `at`, because an import that backfills a day of calls stamps them all with one millisecond and a timestamp filter drops every item but the first. `has_more` is measured by reading an item the page does not show — every leg of the merge walks its own cursor until it holds a full page, so a page is never cut short by how many audit rows one save happened to write. An account whose roll-up hits the anchor ceiling reports `roll_up_truncated` with the number of children it read through.',
      query: v.object({
        limit: v.optional(v.int({ min: 1, max: 200 })),
        before: v.optional(instant()),
        after: v.optional(v.string({ max: 200 })),
        roll_up: v.optional(v.boolean()),
        kinds: v.optional(v.string({ max: 120 })),
      }, { strict: true }),
    });

    router.get('/v1/records/:type/:id/history', (req: Req) => {
      const orgId = req.auth.orgId;
      crm.require(orgId, req.params.type, req.params.id);
      const q = req.query as Record<string, string | undefined>;
      const limit = q.limit ? Number(q.limit) : 100;
      const page = crm.historyPage(orgId, req.params.id, {
        limit,
        property: q.property,
        before: q.before ? instant().parse(q.before, 'before') : undefined,
        since: q.since ? instant().parse(q.since, 'since') : undefined,
        after: q.after,
        order: q.order === 'asc' ? 'asc' : 'desc',
      });
      return {
        ...list(page.entries, { hasMore: page.has_more, nextCursor: page.next_cursor }),
        next_page: page.next_cursor
          ? `/v1/records/${req.params.type}/${req.params.id}/history?after=${encodeURIComponent(page.next_cursor)}`
            + `&limit=${limit}${q.property ? `&property=${encodeURIComponent(q.property)}` : ''}`
          : null,
      };
    }, {
      summary: 'Every recorded change to a record, with who changed it and how', tags: ['crm'],
      description: 'Newest first, totally ordered on `(changed_at, seq)` — a monotonic write sequence, because a millisecond clock cannot order an audit trail and paging on one silently drops every row that shares a tick with a page boundary. Page by passing the previous page’s `next_cursor` back as `after`, or follow `next_page`; `has_more` is measured by reading one row past the page, not inferred from its length. `before`/`since` are time filters, not pagers — they accept unix milliseconds or ISO-8601, and walking one forward by the `changed_at` of the last row drops every other row that shares that millisecond. Rows carry `write_id`, so every property one save touched can be pulled out together.',
      query: v.object({
        limit: v.optional(v.int({ min: 1, max: 500 })),
        property: v.optional(v.string({ max: 60 })),
        before: v.optional(instant()),
        since: v.optional(instant()),
        after: v.optional(v.string({ max: 200 })),
        order: v.optional(v.enum(['asc', 'desc'] as const)),
      }, { strict: true }),
    });

    /**
     * "Who moved this deal to Closed won, and how long had it been sitting in
     * Negotiation?" — read off the audit trail rather than stored, so it is
     * right for records that pre-date the stamp and for every stage a record
     * has ever been through, not just the one it is in now.
     */
    router.get('/v1/records/:type/:id/stage-history', (req: Req) => {
      const orgId = req.auth.orgId;
      const record = crm.require(orgId, req.params.type, req.params.id);
      const spells = stageHistory(ctx, crm, orgId, record);
      const current = spells.find((s) => s.is_current) ?? null;
      return {
        ...list(spells, { totalCount: spells.length }),
        record_id: record.id,
        stage_property: crm.pipelines.requireBinding(orgId, record.object_type).stage_property,
        current_stage: current ? current.stage : null,
        days_in_current_stage: current ? current.days_in_stage : null,
        total_days: spells.length ? Math.round((ctx.now() - spells[0].entered_at) / 86_400_000) : 0,
      };
    }, {
      summary: 'Every stage this record has been in, when it arrived, and how long it stayed', tags: ['crm'],
      description: 'Reconstructed from the property history, so it covers stages the record left months ago and names the person who moved it. `duration_ms` on the current stage counts up to now.',
    });

    router.get('/v1/records/:type/:id/associations', (req: Req) => {
      const orgId = req.auth.orgId;
      crm.require(orgId, req.params.type, req.params.id);
      const q = req.query as Record<string, string | undefined>;
      const edges = crm.associationsOf(orgId, req.params.id, {
        objectType: q.object_type, associationType: q.association_type,
        limit: q.limit ? Number(q.limit) : 200,
      });
      return list(edges, { totalCount: edges.length });
    }, {
      summary: 'Associations in both directions, with their labels', tags: ['crm'],
      query: v.object({
        object_type: v.optional(v.string({ max: 60 })),
        association_type: v.optional(v.string({ max: 60 })),
        limit: v.optional(v.int({ min: 1, max: 1000 })),
      }, { strict: true }),
    });

    router.post('/v1/records/:type/:id/activities', (req: Req) => {
      const body = req.body as { type: string; subject?: string; body?: string; occurred_at?: number; properties?: Record<string, unknown>; also_associate_to?: string[] };
      const orgId = req.auth.orgId;
      const subject = crm.require(orgId, req.params.type, req.params.id);
      const activity = svc().logActivity(orgId, {
        type: body.type,
        subject: body.subject,
        body: body.body,
        occurredAt: body.occurred_at ?? ctx.now(),
        ownerId: req.auth.userId ?? null,
        associateTo: [subject.id, ...(body.also_associate_to ?? [])],
        properties: body.properties,
      }, writeOptions(req));
      return created(activity);
    }, {
      summary: 'Log an activity on a record — note, call, meeting, email or task', tags: ['crm'], roles: ['member'],
      body: v.object({
        type: v.enum(['note', 'call', 'meeting', 'email', 'task'] as const),
        subject: v.optional(v.string({ max: 300 })),
        body: v.optional(v.string({ max: 20_000 })),
        occurred_at: v.optional(v.timestamp()),
        properties: v.optional(v.record(v.any())),
        also_associate_to: v.optional(v.array(v.string({ max: 80 }), { max: 20 })),
      }, { strict: true }),
    });

    router.post('/v1/records/:type/:id/merge', (req: Req) => {
      const body = req.body as { from_id: string };
      const orgId = req.auth.orgId;
      const result = ctx.atomic(() => mergeRecords(ctx, crm, orgId, req.params.type, req.params.id, body.from_id, writeOptions(req, 'merge')));
      ctx.audit({
        orgId, actorId: req.auth.userId, actorType: 'user', action: `${req.params.type}.merged`,
        targetType: req.params.type, targetId: req.params.id,
        summary: `Merged ${body.from_id} into ${result.winner.display_name}`,
        after: { properties_filled: result.properties_filled, associations_moved: result.associations_moved },
        requestId: req.requestId, ip: req.ip,
      });
      return result;
    }, {
      summary: 'Merge a duplicate into this record', tags: ['crm'], roles: ['member'],
      description: 'The surviving record keeps its own values, fills blanks from the duplicate, inherits every association and activity, and gains a history entry naming what was merged. The old id keeps resolving.',
      body: v.object({ from_id: v.string({ min: 1, max: 80 }) }, { strict: true }),
    });

    router.get('/v1/records/:type/:id/similar', (req: Req) => {
      const orgId = req.auth.orgId;
      const record = crm.require(orgId, req.params.type, req.params.id);
      const matches = findSimilar(ctx, crm, orgId, record, req.query.limit ? Number(req.query.limit) : 5);
      return list(matches, { totalCount: matches.length });
    }, {
      summary: 'Likely duplicates of this record, scored with reasons', tags: ['crm'],
      query: v.object({ limit: v.optional(v.int({ min: 1, max: 25 })) }, { strict: true }),
    });

    /* ----------------------------- associations --------------------------- */

    router.get('/v1/association-types', (req: Req) =>
      list(crm.associationTypes(req.auth.orgId).map((t) => ({ object: 'association_type', ...t }))), {
      summary: 'List association types and their labels in both directions', tags: ['crm'],
    });

    router.post('/v1/association-types', (req: Req) => {
      const body = req.body as { name: string; from_object: string; to_object: string; label: string; inverse_label: string; cardinality?: string };
      const orgId = req.auth.orgId;
      if (crm.associationTypes(orgId).some((t) => t.name === body.name)) {
        throw badRequest('association_type_exists', `An association type named "${body.name}" already exists.`, 'name');
      }
      for (const side of [body.from_object, body.to_object]) if (side !== '*') crm.objectType(orgId, side);
      const row = {
        org_id: orgId, name: body.name, id: `assoc_${body.name}`, from_object: body.from_object,
        to_object: body.to_object, label: body.label, inverse_label: body.inverse_label,
        cardinality: body.cardinality ?? 'many_to_many', system: 0, created: ctx.now(),
      };
      ctx.atomic(() => { ctx.db.insert('crm_association_types', row); });
      return created({ object: 'association_type', ...row, system: false });
    }, {
      summary: 'Define a new association type', tags: ['crm'], roles: ['admin'],
      body: v.object({
        name: v.string({ min: 2, max: 60, pattern: /^[a-z][a-z0-9_]*$/ }),
        from_object: v.string({ min: 1, max: 60 }),
        to_object: v.string({ min: 1, max: 60 }),
        label: v.string({ min: 1, max: 60 }),
        inverse_label: v.string({ min: 1, max: 60 }),
        cardinality: v.optional(v.enum(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many'] as const)),
      }, { strict: true }),
    });

    router.get('/v1/associations', (req: Req) => {
      const orgId = req.auth.orgId;
      const q = req.query as Record<string, string | undefined>;
      const limit = q.limit ? Number(q.limit) : 200;

      if (q.record_id) {
        crm.require(orgId, '', q.record_id);
        const edges = crm.associationsOf(orgId, q.record_id, {
          objectType: q.object_type, associationType: q.association_type, limit,
        });
        return list(edges, { totalCount: edges.length });
      }

      const clauses = ['a.org_id = ?'];
      const params: unknown[] = [orgId];
      if (q.association_type) { clauses.push('a.association_type = ?'); params.push(q.association_type); }
      if (q.object_type) { clauses.push('(a.from_type = ? OR a.to_type = ?)'); params.push(q.object_type, q.object_type); }
      const rows = ctx.db.all<Record<string, unknown>>(
        `SELECT a.*, f.display_name AS from_name, t.display_name AS to_name
           FROM crm_associations a
           JOIN crm_records f ON f.id = a.from_id
           JOIN crm_records t ON t.id = a.to_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY a.created DESC, a.id DESC LIMIT ?`,
        ...(params as never[]), limit,
      );
      const total = ctx.db.count(`SELECT COUNT(*) FROM crm_associations a WHERE ${clauses.join(' AND ')}`, ...(params as never[]));
      return list(rows.map((r) => ({
        object: 'association' as const,
        id: r.id, association_type: r.association_type, is_primary: !!r.is_primary, created: r.created,
        from: { id: r.from_id, object_type: r.from_type, display_name: r.from_name },
        to: { id: r.to_id, object_type: r.to_type, display_name: r.to_name },
      })), { totalCount: total, hasMore: rows.length === limit });
    }, {
      summary: 'List associations — for one record, or across the workspace', tags: ['crm'],
      description: 'With `record_id` the response is that record’s edges in both directions, already labelled. Without it, the most recent associations in the workspace.',
      query: v.object({
        record_id: v.optional(v.string({ min: 1, max: 80 })),
        object_type: v.optional(v.string({ max: 60 })),
        association_type: v.optional(v.string({ max: 60 })),
        limit: v.optional(v.int({ min: 1, max: 1000 })),
      }, { strict: true }),
    });

    router.post('/v1/associations', (req: Req) => {
      const body = req.body as { from_id: string; to_id: string; association_type?: string; primary?: boolean };
      const edge = ctx.atomic(() => crm.associate(req.auth.orgId, {
        fromId: body.from_id, toId: body.to_id,
        associationType: body.association_type, primary: body.primary,
      }, writeOptions(req)));
      return created({ object: 'association', ...edge });
    }, {
      summary: 'Associate two records', tags: ['crm'], roles: ['member'],
      description: 'The association type is inferred from the two object types when it is not given. One-to-many labels replace the existing edge rather than erroring.',
      body: v.object({
        from_id: v.string({ min: 1, max: 80 }),
        to_id: v.string({ min: 1, max: 80 }),
        association_type: v.optional(v.string({ max: 60 })),
        primary: v.optional(v.boolean()),
      }, { strict: true }),
    });

    router.del('/v1/associations/:id', (req: Req) => {
      const removed = ctx.atomic(() => crm.disassociate(req.auth.orgId, { id: req.params.id }, writeOptions(req)));
      if (!removed) throw notFound('association', req.params.id);
      return noContent();
    }, { summary: 'Remove one association by id', tags: ['crm'], roles: ['member'] });

    router.del('/v1/associations', (req: Req) => {
      const q = req.query as Record<string, string | undefined>;
      if (!q.from_id || !q.to_id) throw badRequest('association_target_required', 'Pass both `from_id` and `to_id`, or delete by id at /v1/associations/:id.', 'from_id');
      const removed = ctx.atomic(() => crm.disassociate(req.auth.orgId, {
        fromId: q.from_id, toId: q.to_id, associationType: q.association_type,
      }, writeOptions(req)));
      if (!removed) throw notFound('association between those records');
      return { object: 'association_delete', deleted: removed };
    }, {
      summary: 'Remove the association between two records', tags: ['crm'], roles: ['member'],
      query: v.object({
        from_id: v.string({ min: 1, max: 80 }),
        to_id: v.string({ min: 1, max: 80 }),
        association_type: v.optional(v.string({ max: 60 })),
      }, { strict: true }),
    });

    /* --------------------------------- views ------------------------------ */

    router.get('/v1/views', (req: Req) => {
      const views = crm.views(req.auth.orgId, req.query.object_type);
      return list(views, { totalCount: views.length });
    }, {
      summary: 'List saved views', tags: ['crm'],
      query: v.object({ object_type: v.optional(v.string({ max: 60 })) }, { strict: true }),
    });

    router.post('/v1/views', (req: Req) =>
      created(ctx.atomic(() => crm.createView(req.auth.orgId, req.body as Parameters<Crm['createView']>[1], writeOptions(req)))), {
      summary: 'Save a view', tags: ['crm'], roles: ['member'],
      body: v.object({
        object_type: v.string({ min: 1, max: 60 }),
        name: v.string({ min: 1, max: 80 }),
        description: v.optional(v.string({ max: 400 })),
        columns: v.optional(v.array(v.string({ max: 60 }), { max: 40 })),
        filter: v.optional(v.any()),
        sort: v.optional(v.array(v.object({
          property: v.string({ min: 1, max: 60 }),
          direction: v.optional(v.enum(['asc', 'desc'] as const)),
        }), { max: 4 })),
        shared: v.optional(v.boolean()),
        is_default: v.optional(v.boolean()),
        position: v.optional(v.int({ min: 0, max: 10_000 })),
      }, { strict: true }),
    });

    router.get('/v1/views/:id', (req: Req) => crm.view(req.auth.orgId, req.params.id),
      { summary: 'Retrieve a saved view', tags: ['crm'] });

    router.patch('/v1/views/:id', (req: Req) =>
      ctx.atomic(() => crm.updateView(req.auth.orgId, req.params.id, req.body as Partial<ViewDef>)), {
      summary: 'Update a saved view', tags: ['crm'], roles: ['member'],
      body: v.object({
        name: v.optional(v.string({ min: 1, max: 80 })),
        description: v.optional(v.string({ max: 400 })),
        columns: v.optional(v.array(v.string({ max: 60 }), { max: 40 })),
        filter: v.optional(v.any()),
        sort: v.optional(v.array(v.object({
          property: v.string({ min: 1, max: 60 }),
          direction: v.optional(v.enum(['asc', 'desc'] as const)),
        }), { max: 4 })),
        shared: v.optional(v.boolean()),
        is_default: v.optional(v.boolean()),
        position: v.optional(v.int({ min: 0, max: 10_000 })),
      }, { strict: true }),
    });

    router.del('/v1/views/:id', (req: Req) => {
      ctx.atomic(() => crm.deleteView(req.auth.orgId, req.params.id));
      return noContent();
    }, { summary: 'Delete a saved view', tags: ['crm'], roles: ['member'] });
  },

  tools(ctx) {
    const crm = crmEngine(ctx);
    const svc = () => ctx.svc.crm;

    return [
      {
        name: 'search_records',
        description: 'Search CRM records of one object type using the platform filter engine. Supports nested and/or groups, 19 operators, relative dates like "-30d" or "start_of_quarter", and association-aware conditions such as counting a company\'s open deals. Returns matching records with their properties.',
        readOnly: true,
        tags: ['crm'],
        input: v.object({
          object_type: v.string({ min: 1, max: 60, description: 'contact, company, deal, ticket, note, call, meeting, email, task, or a custom object.' }),
          query: v.optional(v.string({ max: 200, description: 'Free text across the object\'s searchable properties.' })),
          filter: v.optional(v.any()),
          sort: v.optional(v.array(v.object({ property: v.string({ max: 60 }), direction: v.optional(v.enum(['asc', 'desc'] as const)) }), { max: 3 })),
          limit: v.optional(v.int({ min: 1, max: 100 })),
        }),
        run(args: { object_type: string; query?: string; filter?: FilterNode; sort?: SearchQuery['sort']; limit?: number }, _c, meta) {
          const result = crm.search(meta.orgId, args.object_type, {
            filter: args.filter, query: args.query, sort: args.sort, limit: args.limit ?? 20,
          });
          return {
            total: result.total,
            returned: result.records.length,
            records: result.records.map((r) => ({ id: r.id, display_name: r.display_name, owner_id: r.owner_id, properties: r.properties })),
          };
        },
      },
      {
        name: 'get_record',
        description: 'Fetch one CRM record by id with every property, its associations to other records, and the most recent timeline activity.',
        readOnly: true,
        tags: ['crm'],
        input: v.object({
          object_type: v.string({ min: 1, max: 60 }),
          id: v.string({ min: 1, max: 80 }),
          include_timeline: v.optional(v.boolean()),
        }),
        run(args: { object_type: string; id: string; include_timeline?: boolean }, _c, meta) {
          const record = crm.require(meta.orgId, args.object_type, args.id);
          return {
            ...record,
            associations: crm.associationsOf(meta.orgId, record.id, { limit: 50 }),
            ...(args.include_timeline ? { timeline: buildTimeline(ctx, crm, meta.orgId, record, { limit: 15 }) } : {}),
          };
        },
      },
      {
        name: 'list_properties',
        description: 'List the properties of a CRM object type — names, labels, types and the allowed options for enums. Call this before building a filter or writing values so field names and picklist values are exact.',
        readOnly: true,
        tags: ['crm'],
        input: v.object({ object_type: v.string({ min: 1, max: 60 }) }),
        run(args: { object_type: string }, _c, meta) {
          return crm.properties(meta.orgId, args.object_type).map((p) => ({
            name: p.name, label: p.label, type: p.type, group: p.group, required: p.required,
            read_only: p.read_only, calculated: p.calculated,
            options: p.options.map((o) => ({ value: o.value, label: o.label })),
          }));
        },
      },
      {
        name: 'list_pipelines',
        description: 'List the pipelines an object type moves through and the ordered stages of each, with the probability every stage carries and whether it closes the record. Call this before setting a stage: a stage is only legal inside its own pipeline, and moving a deal restamps its probability, forecast category and close date automatically.',
        readOnly: true,
        tags: ['crm'],
        input: v.object({ object_type: v.string({ min: 1, max: 60, description: 'deal or ticket.' }) }, { strict: true }),
        run(args: { object_type: string }, _c, meta) {
          return crm.pipelines.list(meta.orgId, args.object_type).map((pipeline) => ({
            name: pipeline.name, label: pipeline.label, is_default: pipeline.is_default,
            description: pipeline.description,
            stages: pipeline.stages.map((stage) => ({
              name: stage.name, label: stage.label, probability: stage.probability,
              is_closed: stage.is_closed, is_won: stage.is_won, forecast_category: stage.forecast_category,
            })),
          }));
        },
      },
      {
        name: 'create_record',
        description: 'Create a CRM record — a contact, company, deal, ticket or custom object. Pass properties by their machine name. Optionally associate the new record with existing ones in the same call.',
        readOnly: false,
        requiresApproval: true,
        tags: ['crm'],
        input: v.object({
          object_type: v.string({ min: 1, max: 60 }),
          properties: v.record(v.any()),
          associate_to: v.optional(v.array(v.string({ max: 80 }), { max: 20 })),
        }),
        run(args: { object_type: string; properties: Record<string, unknown>; associate_to?: string[] }, _c, meta) {
          return ctx.atomic(() => {
            const record = crm.create(meta.orgId, args.object_type, args.properties, {
              actorId: meta.actorId ?? null, actorType: 'agent', source: 'agent',
            });
            for (const target of args.associate_to ?? []) {
              crm.associate(meta.orgId, { fromId: record.id, toId: target }, { actorId: meta.actorId ?? null, actorType: 'agent' });
            }
            return record;
          });
        },
      },
      {
        name: 'update_record',
        description: 'Update properties on an existing CRM record. Every change is written to the property history as an agent edit, so a person can see exactly what the agent changed and roll it back.',
        readOnly: false,
        requiresApproval: true,
        tags: ['crm'],
        input: v.object({
          object_type: v.string({ min: 1, max: 60 }),
          id: v.string({ min: 1, max: 80 }),
          properties: v.record(v.any()),
        }),
        run(args: { object_type: string; id: string; properties: Record<string, unknown> }, _c, meta) {
          return ctx.atomic(() => crm.update(meta.orgId, args.object_type, args.id, args.properties, {
            actorId: meta.actorId ?? null, actorType: 'agent', source: 'agent',
          }));
        },
      },
      {
        name: 'associate_records',
        description: 'Link two CRM records — a contact to a company, a deal to its buying committee, a ticket to an account. The association type is inferred from the two object types unless you name one.',
        readOnly: false,
        requiresApproval: true,
        tags: ['crm'],
        input: v.object({
          from_id: v.string({ min: 1, max: 80 }),
          to_id: v.string({ min: 1, max: 80 }),
          association_type: v.optional(v.string({ max: 60 })),
          primary: v.optional(v.boolean()),
        }),
        run(args: { from_id: string; to_id: string; association_type?: string; primary?: boolean }, _c, meta) {
          return ctx.atomic(() => crm.associate(meta.orgId, {
            fromId: args.from_id, toId: args.to_id, associationType: args.association_type, primary: args.primary,
          }, { actorId: meta.actorId ?? null, actorType: 'agent' }));
        },
      },
      {
        name: 'add_note',
        description: 'Write a note onto the timeline of one or more CRM records. Use this to record what happened, what was decided, or what the agent did, so the next person to open the record sees it.',
        readOnly: false,
        tags: ['crm'],
        input: v.object({
          record_ids: v.array(v.string({ max: 80 }), { min: 1, max: 20 }),
          subject: v.optional(v.string({ max: 300 })),
          body: v.string({ min: 1, max: 20_000 }),
        }),
        run(args: { record_ids: string[]; subject?: string; body: string }, _c, meta) {
          return svc().logActivity(meta.orgId, {
            type: 'note',
            subject: args.subject ?? args.body.split('\n')[0].slice(0, 120),
            body: args.body,
            occurredAt: ctx.now(),
            associateTo: args.record_ids,
          }, { actorId: meta.actorId ?? null, actorType: 'agent', source: 'agent' });
        },
      },
    ];
  },
});
