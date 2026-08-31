import { defineModule } from '../../kernel/module';
import type { Ctx } from '../../kernel/context';
import type { AinEvent } from '../../kernel/events';
import { created, list, noContent, type Req } from '../../kernel/http';
import { notFound } from '../../../shared/errors';
import { DAY } from '../../../shared/time';
import v from '../../../shared/validate';
import { ENTITLEMENTS_MIGRATIONS } from './schema';
import { seedEntitlements } from './seed';
import {
  entitlementsStore, type FeatureListFilter, type OverrideListFilter, type RecomputeOptions, type WriteMeta,
} from './store';
import {
  ALLOWANCE_INTERVALS, FEATURE_TYPES, OVERRIDE_EFFECTS, OVERRIDE_STATUSES, USAGE_WINDOWS,
  type ActiveEntitlement, type CheckInput, type EntitlementCheck, type EntitlementOverride,
  type EntitlementSet, type EntitlementSummary, type EntitlementVersion, type Feature,
  type FeatureInput, type FeaturePatch,
  type LimitPressure, type OverrideInput, type ProductFeature, type ProductFeatureInput,
  type RecomputeResult,
} from './types';

/* -------------------------------- service --------------------------------- */

/**
 * What the rest of the platform needs from entitlements.
 *
 * `check` is the whole point of the module and the only method on a hot path:
 * a product asks it before it lets somebody add a seat, connect a robot or
 * push an event, and it has to answer in the time a database round-trip would
 * otherwise take. Everything else here exists to keep the answer honest.
 */
export interface EntitlementsService {
  features(orgId: string, filter?: FeatureListFilter): Feature[];
  feature(orgId: string, key: string): Feature | null;
  requireFeature(orgId: string, key: string): Feature;
  createFeature(orgId: string, input: FeatureInput, meta?: WriteMeta): Feature;
  updateFeature(orgId: string, key: string, patch: FeaturePatch, meta?: WriteMeta): Feature;

  productFeatures(orgId: string, filter?: { product?: string; feature?: string }): ProductFeature[];
  setProductFeature(orgId: string, input: ProductFeatureInput, meta?: WriteMeta): ProductFeature;
  removeProductFeature(orgId: string, productId: string, featureKey: string, meta?: WriteMeta): void;

  /** The stored set for one customer, with live usage on metered features. */
  entitlements(orgId: string, customerId: string, opts?: { usage?: boolean }): ActiveEntitlement[];
  set(orgId: string, customerId: string, opts?: { usage?: boolean }): EntitlementSet;
  /** One stored entitlement by its own id, as a cached summary refers to it. */
  activeById(orgId: string, id: string, opts?: { usage?: boolean }): ActiveEntitlement | null;
  /** The whole set in one payload — the shape `entitlement_summary.updated` carries. */
  summary(orgId: string, customerId: string): EntitlementSummary;

  /** "Can this customer do this right now, and how much is left?" */
  check(orgId: string, input: CheckInput): EntitlementCheck;
  /** The same question when the caller only needs the gate, not the sentence. */
  allows(orgId: string, customerId: string, feature: string, requested?: number): boolean;

  /** Re-derive one customer's set. Runs inside the caller's transaction. */
  recompute(orgId: string, customerId: string, opts: RecomputeOptions): RecomputeResult;

  overrides(orgId: string, filter?: OverrideListFilter): EntitlementOverride[];
  createOverride(orgId: string, input: OverrideInput, meta?: WriteMeta): EntitlementOverride;
  revokeOverride(orgId: string, id: string, reason: string | null, meta?: WriteMeta): EntitlementOverride;

  versions(orgId: string, customerId: string, limit?: number): EntitlementVersion[];
  /** Accounts at or past a feature's warning threshold — the expansion list. */
  atLimit(orgId: string, feature: string, limit?: number): LimitPressure[];
}

declare module '../../kernel/services' {
  interface ServiceRegistry { entitlements: EntitlementsService }
}

export { entitlementsStore };

const writeMeta = (req: Req): WriteMeta => ({
  actorId: req.auth.userId ?? req.auth.keyId ?? null,
  actorType: (req.auth.kind === 'api_key' ? 'api_key' : req.auth.kind === 'system' ? 'system' : 'user') as
    'user' | 'api_key' | 'system',
  requestId: req.requestId,
  livemode: req.auth.livemode,
});

/**
 * The customer a subscription event is about.
 *
 * Read defensively: billing publishes several shapes on this family of events
 * — the whole subscription on some, a `{subscription, customer}` summary on
 * others — and a missing field has to mean "not for us" rather than a handler
 * that throws inside somebody else's transaction.
 */
function customerOf(event: AinEvent<Record<string, unknown>>, ctx: Ctx): string | null {
  const data = (event.data ?? {}) as { customer?: unknown; id?: unknown; subscription?: unknown };
  if (typeof data.customer === 'string') return data.customer;
  const subId = typeof data.subscription === 'string' ? data.subscription
    : typeof data.id === 'string' ? data.id
      : event.object_id;
  if (!subId) return null;
  try { return ctx.svc.billing.subscription(event.org_id, subId)?.customer ?? null; }
  catch { return null; }
}

/** Every subscription event that can move what an account is allowed to do. */
const SUBSCRIPTION_TRIGGERS = [
  'subscription.created', 'subscription.updated', 'subscription.canceled', 'subscription.activated',
  'subscription.paused', 'subscription.resumed', 'subscription.past_due', 'subscription.unpaid',
  'subscription.trial_started', 'subscription.trial_ended', 'subscription.renewed',
  'subscription.cancellation_scheduled', 'subscription.incomplete_expired',
] as const;

/* ------------------------------- validators ------------------------------- */

const featureBody = v.object({
  key: v.string({ min: 2, max: 64, description: 'Stable key your product code checks against.' }),
  name: v.string({ min: 1, max: 120 }),
  description: v.optional(v.string({ max: 1000 })),
  type: v.enum(FEATURE_TYPES),
  unit_label: v.optional(v.string({ max: 24, description: 'Singular noun for one unit — "seat", "robot", "event".' })),
  default_value: v.optional(v.int({ min: 0, max: Number.MAX_SAFE_INTEGER })),
  default_unlimited: v.optional(v.boolean()),
  meter: v.optional(v.string({ max: 80, description: 'Meter id or event name whose events are this feature’s usage.' })),
  usage_window: v.optional(v.enum(USAGE_WINDOWS)),
  allowance_interval: v.optional(v.nullable(v.enum(ALLOWANCE_INTERVALS))),
  credit_backed: v.optional(v.boolean()),
  approaching_threshold_percent: v.optional(v.int({ min: 1, max: 100 })),
  active: v.optional(v.boolean()),
  position: v.optional(v.int({ min: 0, max: 100_000 })),
  metadata: v.metadata(),
});

const featurePatchBody = v.object({
  name: v.optional(v.string({ min: 1, max: 120 })),
  description: v.optional(v.nullable(v.string({ max: 1000 }))),
  unit_label: v.optional(v.nullable(v.string({ max: 24 }))),
  default_value: v.optional(v.nullable(v.int({ min: 0, max: Number.MAX_SAFE_INTEGER }))),
  default_unlimited: v.optional(v.boolean()),
  meter: v.optional(v.nullable(v.string({ max: 80 }))),
  usage_window: v.optional(v.enum(USAGE_WINDOWS)),
  allowance_interval: v.optional(v.nullable(v.enum(ALLOWANCE_INTERVALS))),
  credit_backed: v.optional(v.boolean()),
  approaching_threshold_percent: v.optional(v.int({ min: 1, max: 100 })),
  active: v.optional(v.boolean()),
  position: v.optional(v.int({ min: 0, max: 100_000 })),
  metadata: v.metadata(),
});

const productFeatureBody = v.object({
  product: v.id('prod'),
  feature: v.string({ min: 2, max: 64 }),
  value: v.optional(v.nullable(v.int({ min: 0, max: Number.MAX_SAFE_INTEGER }))),
  unlimited: v.optional(v.boolean()),
  quantity_prices: v.optional(v.array(v.id('price'), { max: 12 })),
});

const checkBody = v.object({
  customer: v.id('cus'),
  feature: v.string({ min: 1, max: 64 }),
  requested: v.optional(v.int({ min: 0, max: Number.MAX_SAFE_INTEGER, description: 'How much the caller is about to consume. Zero asks only what is left.' })),
});

const featuresQuery = v.object({
  type: v.optional(v.enum(FEATURE_TYPES)),
  active: v.optional(v.boolean()),
  meter: v.optional(v.string({ max: 80 })),
  query: v.optional(v.string({ max: 120 })),
  expand: v.optional(v.enum(['products'])),
});

const productFeaturesQuery = v.object({
  product: v.optional(v.id('prod')),
  feature: v.optional(v.string({ max: 64 })),
});

const setQuery = v.object({ usage: v.default(v.boolean(), true) });

const versionsQuery = v.object({ limit: v.default(v.int({ min: 1, max: 200 }), 20) });

const overridesQuery = v.object({
  customer: v.optional(v.id('cus')),
  feature: v.optional(v.string({ max: 64 })),
  status: v.default(v.enum([...OVERRIDE_STATUSES, 'all']), 'active'),
  limit: v.default(v.int({ min: 1, max: 500 }), 100),
});

const revokeQuery = v.object({ reason: v.optional(v.string({ max: 500 })) });

/**
 * Re-read an already-validated query string with its own schema's types.
 * The kernel parses `req.query` in place, so this is a cast that cannot lie.
 */
const queryOf = <T>(req: Req, schema: { parse(value: unknown): T }): T => schema.parse(req.query);

const overrideBody = v.object({
  customer: v.id('cus'),
  feature: v.string({ min: 1, max: 64 }),
  effect: v.default(v.enum(OVERRIDE_EFFECTS), 'grant'),
  value: v.optional(v.nullable(v.int({ min: 0, max: Number.MAX_SAFE_INTEGER }))),
  unlimited: v.optional(v.boolean()),
  reason: v.string({ min: 3, max: 500, description: 'Why support did this. It is what an auditor reads later.' }),
  expires_at: v.optional(v.nullable(v.timestamp())),
  metadata: v.metadata(),
});

/* --------------------------------- module --------------------------------- */

export default defineModule({
  name: 'entitlements',
  title: 'Features & entitlements',
  description: 'What each plan lets an account do, derived from its live subscriptions, checked in under a millisecond and never out of step with the bill.',
  dependsOn: ['core', 'catalog', 'billing', 'metering', 'credits'],
  migrations: ENTITLEMENTS_MIGRATIONS,

  boot(ctx) {
    const store = entitlementsStore(ctx);

    const service: EntitlementsService = {
      features: (orgId, filter) => store.features(orgId, filter),
      feature: (orgId, key) => store.feature(orgId, key),
      requireFeature: (orgId, key) => store.requireFeature(orgId, key),
      createFeature: (orgId, input, meta) => store.createFeature(orgId, input, meta),
      updateFeature: (orgId, key, patch, meta) => store.updateFeature(orgId, key, patch, meta),
      productFeatures: (orgId, filter) => store.productFeatures(orgId, filter),
      setProductFeature: (orgId, input, meta) => store.setProductFeature(orgId, input, meta),
      removeProductFeature: (orgId, productId, featureKey, meta) => store.removeProductFeature(orgId, productId, featureKey, meta),
      entitlements: (orgId, customerId, opts) => store.active(orgId, customerId, opts),
      set: (orgId, customerId, opts) => store.set(orgId, customerId, opts),
      activeById: (orgId, id, opts) => store.activeById(orgId, id, opts),
      summary: (orgId, customerId) => store.summary(orgId, customerId),
      check: (orgId, input) => store.check(orgId, input),
      allows: (orgId, customerId, feature, requested) =>
        store.check(orgId, { customer: customerId, feature, requested }, { emit: false }).allowed,
      recompute: (orgId, customerId, opts) => store.recompute(orgId, customerId, opts),
      overrides: (orgId, filter) => store.overrides(orgId, filter),
      createOverride: (orgId, input, meta) => store.createOverride(orgId, input, meta),
      revokeOverride: (orgId, id, reason, meta) => store.revokeOverride(orgId, id, reason, meta),
      versions: (orgId, customerId, limit) => store.versions(orgId, customerId, limit),
      atLimit: (orgId, feature, limit) => store.atLimit(orgId, feature, limit),
    };
    ctx.provide('entitlements', service);

    /* ------------------------------- the jobs ----------------------------- */

    ctx.jobs.handle('entitlements.override_expire', (payload: { override?: string }, job) => {
      if (payload?.override) store.expireOverride(job.org_id, payload.override);
    });

    /**
     * The safety net, not the mechanism. Every override with an expiry already
     * has its own job; this daily sweep exists so an override whose job was
     * lost — a restore from backup, a queue drained by hand — still expires.
     */
    ctx.jobs.handle('entitlements.sweep_overrides', (_payload: unknown, job) => {
      store.expireDue(job.org_id);
      ctx.enqueue(job.org_id, 'entitlements.sweep_overrides', {}, {
        runAt: ctx.now() + DAY, idemKey: 'entitlements.sweep_overrides',
      });
    });

    /* --------------------------- staying in step -------------------------- */

    // Derived on write, never on read: these handlers run inside the very
    // transaction that moved the subscription, so a plan change and the
    // entitlements it grants commit together or not at all.
    for (const type of SUBSCRIPTION_TRIGGERS) {
      ctx.events.on(type, (event) => {
        const customer = customerOf(event, ctx);
        if (!customer) return;
        store.recompute(event.org_id, customer, {
          trigger: type,
          reason: reasonForTrigger(type),
          meta: { actorId: event.actor_id, actorType: event.actor_type, requestId: event.request_id },
        });
      }, 'entitlements');
    }

    ctx.events.on('customer.deleted', (event) => {
      const customerId = (event.data as { id?: string })?.id ?? event.object_id;
      if (!customerId) return;
      ctx.db.run(`DELETE FROM entitlement_active WHERE org_id = ? AND customer_id = ?`, event.org_id, customerId);
    }, 'entitlements');

    // Memo invalidation. Usage and credit totals are never stored, so the only
    // thing that has to be exact here is that anything which could move a total
    // clears the memo of it — in the same transaction that wrote the change.
    ctx.events.on('meter.*', () => store.usage.invalidateUsage(), 'entitlements');
    ctx.events.on('meter.created', () => store.usage.invalidateMeters(), 'entitlements');
    ctx.events.on('meter.updated', () => store.usage.invalidateMeters(), 'entitlements');
    ctx.events.on('credit.*', () => store.usage.invalidateCredit(), 'entitlements');
    ctx.events.on('credit_grant.*', () => store.usage.invalidateCredit(), 'entitlements');
    ctx.events.on('product.*', () => store.invalidateCatalog(), 'entitlements');
    ctx.events.on('price.*', () => store.invalidateCatalog(), 'entitlements');
    ctx.events.on('org.updated', () => store.invalidateOrg(), 'entitlements');
  },

  seed(ctx, orgId) {
    seedEntitlements(ctx, orgId);
    ctx.jobs.enqueue(orgId, 'entitlements.sweep_overrides', {}, ctx.now(), {
      runAt: ctx.now() + DAY, idemKey: 'entitlements.sweep_overrides',
    });
  },

  routes(r, ctx) {
    const store = entitlementsStore(ctx);

    /* -------------------------------- features ---------------------------- */

    r.get('/v1/features', (req: Req) => {
      const q = queryOf(req, featuresQuery);
      const features = store.features(req.auth.orgId, { type: q.type, active: q.active, meter: q.meter, query: q.query });
      const withGrants = q.expand === 'products'
        ? features.map((feature) => ({ ...feature, products: store.productFeatures(req.auth.orgId, { feature: feature.key }) }))
        : features;
      return list(withGrants, { totalCount: withGrants.length });
    }, {
      summary: 'List the features an account can be entitled to',
      description: 'The catalogue of things a plan can grant: booleans, standing limits and per-period metered allowances. `?expand=products` adds what each product includes of each one.',
      tags: ['entitlements'],
      query: featuresQuery,
    });

    r.post('/v1/features', (req: Req) =>
      created(store.createFeature(req.auth.orgId, req.body as FeatureInput, writeMeta(req))), {
      summary: 'Define a feature',
      description: 'A feature key is what product code checks against, so it is immutable once created and never reused. A metered feature must name the meter its usage is read from. `allowance_interval` is how often the allowance refills inside the cycle that grants it — "5,000,000 events each month" includes five million a month on an annual term too, measured over twelve consecutive windows anchored on the subscription’s own billing day. Pass `null` for an allowance genuinely sold by the term.',
      tags: ['entitlements'],
      body: featureBody,
      roles: ['admin'],
    });

    r.get('/v1/features/:key', (req: Req) => {
      const feature = store.requireFeature(req.auth.orgId, req.params.key);
      return { ...feature, products: store.productFeatures(req.auth.orgId, { feature: feature.key }) };
    }, {
      summary: 'Retrieve a feature and the products that grant it',
      tags: ['entitlements'],
    });

    r.patch('/v1/features/:key', (req: Req) =>
      store.updateFeature(req.auth.orgId, req.params.key, req.body as FeaturePatch, writeMeta(req)), {
      summary: 'Update a feature',
      description: 'Changing a default, or deactivating a feature, immediately recomputes every account holding it — nothing is left to drift until its next subscription event.',
      tags: ['entitlements'],
      body: featurePatchBody,
      roles: ['admin'],
    });

    /* ---------------------------- product features ------------------------ */

    r.get('/v1/product-features', (req: Req) =>
      list(store.productFeatures(req.auth.orgId, queryOf(req, productFeaturesQuery))), {
      summary: 'List what products include of which features',
      description: 'The per-product values that let one plan grant 25 seats where another grants 250.',
      tags: ['entitlements'],
      query: productFeaturesQuery,
    });

    r.post('/v1/product-features', (req: Req) =>
      created(store.setProductFeature(req.auth.orgId, req.body as ProductFeatureInput, writeMeta(req))), {
      summary: 'Declare what a product includes of a feature',
      description: 'Idempotent on (product, feature). `quantity_prices` names the per-seat prices whose subscription quantity *is* the entitled amount, so an account with 34 seats on the bill is entitled to 34 and not to the plan’s included 10.',
      tags: ['entitlements'],
      body: productFeatureBody,
      roles: ['admin'],
    });

    r.del('/v1/product-features/:id', (req: Req) => {
      const row = ctx.db.get<{ product_id: string; feature_key: string }>(
        `SELECT product_id, feature_key FROM entitlement_product_features WHERE org_id = ? AND id = ?`,
        req.auth.orgId, req.params.id,
      );
      if (!row) throw notFound('product feature', req.params.id);
      store.removeProductFeature(req.auth.orgId, row.product_id, row.feature_key, writeMeta(req));
      return noContent();
    }, {
      summary: 'Stop a product granting a feature',
      tags: ['entitlements'],
      roles: ['admin'],
    });

    /* ------------------------------ a customer ---------------------------- */

    r.get('/v1/customers/:id/entitlements', (req: Req) =>
      store.set(req.auth.orgId, req.params.id, { usage: queryOf(req, setQuery).usage }), {
      summary: 'Everything a customer is entitled to, and what granted each',
      description: 'The stored set, derived from the account’s live subscriptions and any support overrides. Metered features carry live usage read from the meter and the credit ledger; pass `?usage=false` to skip those reads.',
      tags: ['entitlements'],
      query: setQuery,
    });

    r.get('/v1/customers/:id/entitlement-summary', (req: Req) =>
      store.summary(req.auth.orgId, req.params.id), {
      summary: 'The whole entitlement set for one customer, in one cacheable payload',
      description: 'Exactly what `entitlement_summary.updated` delivers, so an edge cache can key on `version` and re-fetch what it lost without reassembling the per-feature events. Values only — call the check endpoint, or the full entitlements route, for live usage against them.',
      tags: ['entitlements'],
    });

    r.get('/v1/active-entitlements/:id', (req: Req) => {
      const found = store.activeById(req.auth.orgId, req.params.id, { usage: queryOf(req, setQuery).usage });
      if (!found) throw notFound('active entitlement', req.params.id);
      return found;
    }, {
      summary: 'Retrieve one active entitlement',
      description: 'The single row a summary refers to by id, with what granted it, the window its allowance is measured over and live usage against it.',
      tags: ['entitlements'],
      query: setQuery,
    });

    r.get('/v1/customers/:id/entitlement-versions', (req: Req) =>
      list(store.versions(req.auth.orgId, req.params.id, queryOf(req, versionsQuery).limit)), {
      summary: 'The audit trail of a customer’s entitlements',
      description: 'One row per change, with the diff that explains it and the full set as it stood afterwards.',
      tags: ['entitlements'],
      query: versionsQuery,
    });

    /* -------------------------------- checking ---------------------------- */

    r.post('/v1/entitlements/check', (req: Req) =>
      store.check(req.auth.orgId, req.body as CheckInput), {
      summary: 'Can this customer do this right now, and how much is left?',
      description: 'One index seek for the stored entitlement, a live meter read for what has been consumed and a cached ladder for what the next plan up would grant. `reason` is a sentence you can show a user unedited; `upgrade_path` names the real product and price that would let them through, or `null` when nothing in the price book both raises the ceiling and can be sold in this account’s currency. Safe to call speculatively: a `requested` that would not fit is answered, never reported — `entitlement.limit_exceeded` is raised by consumption passing the ceiling, not by a question about it.',
      tags: ['entitlements'],
      body: checkBody,
      example: {
        object: 'entitlement_check',
        feature: 'robots',
        allowed: false,
        limit: 75,
        used: 68,
        remaining: 7,
        reason: 'Adding 12 robots would take you to 80, past the 75 robots included in Telemetry Cloud Growth.',
        upgrade_path: { product: 'prod_nw_scale', product_name: 'Telemetry Cloud Scale', price: 'price_nw_scale_monthly', value: 400, message: 'Telemetry Cloud Scale raises connected robots to 400 robots: $1,900.00 per month.' },
      },
    });

    /* ------------------------------- overrides ---------------------------- */

    r.get('/v1/entitlement-overrides', (req: Req) =>
      list(store.overrides(req.auth.orgId, queryOf(req, overridesQuery))), {
      summary: 'List per-customer grants and suspensions',
      tags: ['entitlements'],
      query: overridesQuery,
    });

    r.post('/v1/entitlement-overrides', (req: Req) =>
      created(store.createOverride(req.auth.orgId, req.body as OverrideInput, writeMeta(req))), {
      summary: 'Grant or suspend a feature for one customer',
      description: 'A temporary raise support can hand out without touching the plan. Give it an `expires_at` and it takes itself away again — the expiry is a queued job with a `run_at`, so the time machine replays it exactly.',
      tags: ['entitlements'],
      body: overrideBody,
      roles: ['member'],
    });

    r.get('/v1/entitlement-overrides/:id', (req: Req) =>
      store.requireOverride(req.auth.orgId, req.params.id), {
      summary: 'Retrieve an override',
      tags: ['entitlements'],
    });

    r.del('/v1/entitlement-overrides/:id', (req: Req) =>
      store.revokeOverride(req.auth.orgId, req.params.id, queryOf(req, revokeQuery).reason ?? null, writeMeta(req)), {
      summary: 'Revoke an override now',
      description: 'Ends the grant or suspension immediately and recomputes the set it was shaping.',
      tags: ['entitlements'],
      query: revokeQuery,
      roles: ['member'],
    });

    /* -------------------------------- overview ---------------------------- */

    r.get('/v1/entitlements/overview', (req: Req) => {
      const orgId = req.auth.orgId;
      const features = store.features(orgId, { active: true });
      return {
        object: 'entitlements_overview',
        features: features.map((feature) => {
          const holders = ctx.db.count(
            `SELECT COUNT(DISTINCT customer_id) FROM entitlement_active WHERE org_id = ? AND feature_key = ?`,
            orgId, feature.key,
          );
          const unlimited = ctx.db.count(
            `SELECT COUNT(*) FROM entitlement_active WHERE org_id = ? AND feature_key = ? AND unlimited = 1`,
            orgId, feature.key,
          );
          return {
            feature: feature.key,
            name: feature.name,
            type: feature.type,
            unit_label: feature.unit_label,
            granted_by: store.productFeatures(orgId, { feature: feature.key }).length,
            accounts: holders,
            unlimited_accounts: unlimited,
            at_risk: feature.type === 'boolean' ? [] : store.atLimit(orgId, feature.key, 5),
          };
        }),
        overrides_live: store.overrides(orgId, { status: 'active', limit: 500 }).length,
        as_of: ctx.now(),
      };
    }, {
      summary: 'Feature adoption and the accounts pressing against their limits',
      description: 'Which features each plan grants, how many accounts hold them, and — for anything with a ceiling — who is at or past the warning threshold right now. This is the expansion list.',
      tags: ['entitlements'],
    });
  },

  tools(ctx) {
    return [
      {
        name: 'entitlements.check',
        description: 'Answer whether a customer may do something right now and how much of the allowance is left, with the sentence to show them and the plan that would raise the ceiling.',
        readOnly: true,
        tags: ['billing', 'entitlements'],
        input: v.object({
          customer: v.string({ min: 1, max: 120 }),
          feature: v.string({ min: 1, max: 64 }),
          requested: v.optional(v.int({ min: 0, max: Number.MAX_SAFE_INTEGER })),
        }),
        run: (args: CheckInput, c: Ctx, meta) => c.svc.entitlements.check(meta.orgId, args),
      },
      {
        name: 'entitlements.for_customer',
        description: 'Everything one customer is entitled to, what granted each entitlement, and live usage against the metered ones.',
        readOnly: true,
        tags: ['billing', 'entitlements'],
        input: v.object({ customer: v.string({ min: 1, max: 120 }) }),
        run: (args: { customer: string }, c: Ctx, meta): EntitlementSet => c.svc.entitlements.set(meta.orgId, args.customer),
      },
      {
        name: 'entitlements.at_limit',
        description: 'Accounts at or past a feature’s warning threshold — who to talk to about an upgrade, newest usage first.',
        readOnly: true,
        tags: ['billing', 'entitlements'],
        input: v.object({
          feature: v.string({ min: 1, max: 64 }),
          limit: v.optional(v.int({ min: 1, max: 50 })),
        }),
        run: (args: { feature: string; limit?: number }, c: Ctx, meta) => c.svc.entitlements.atLimit(meta.orgId, args.feature, args.limit),
      },
    ];
  },
});

/** Why the set is being re-derived, in words the version history can carry. */
function reasonForTrigger(type: string): string {
  switch (type) {
    case 'subscription.created': return 'A new subscription started granting features.';
    case 'subscription.updated': return 'The subscription’s plan or quantities changed.';
    case 'subscription.canceled': return 'The subscription ended, so what it granted ended with it.';
    case 'subscription.activated': return 'The subscription became active.';
    case 'subscription.paused': return 'Collection was paused; the plan keeps granting until it ends.';
    case 'subscription.resumed': return 'The subscription resumed.';
    case 'subscription.past_due': return 'The latest invoice failed; access continues while dunning runs.';
    case 'subscription.unpaid': return 'Dunning gave up on this subscription.';
    case 'subscription.trial_started': return 'A trial started, granting the plan’s features in full.';
    case 'subscription.trial_ended': return 'The trial ended.';
    case 'subscription.renewed': return 'The cycle turned over, so the metered allowances reset.';
    case 'subscription.cancellation_scheduled': return 'Cancellation was scheduled; entitlements hold until the period ends.';
    case 'subscription.incomplete_expired': return 'The first payment never arrived, so the subscription never granted anything.';
    default: return 'The account’s subscriptions changed.';
  }
}
