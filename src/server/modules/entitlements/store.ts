import type { Ctx } from '../../kernel/context';
import { parseJson, type Bindable } from '../../kernel/db';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { newId, randomId } from '../../../shared/ids';
import { rat, ratCmp, ratMul, ratRound } from '../../../shared/money';
import type { Subscription } from '../billing/types';
import { changeSummary, reasonFor, type SourceWords } from './format';
import { UsageReader, type Window } from './usage';
import { bestUpgrade, buildLadder, toUpgradePath, type LadderEntry } from './upgrades';
import {
  type ActiveEntitlement, type AllowanceInterval, type ChangeKind, type CheckInput, type EntitlementChange,
  type EntitlementCheck, type EntitlementOverride, type EntitlementSet, type EntitlementSource,
  type EntitlementSourceType, type EntitlementSummary, type EntitlementSummaryRow,
  type EntitlementUsage, type EntitlementVersion, type Feature,
  type FeatureInput, type FeaturePatch, type FeatureType, type LimitPressure, type OverrideInput,
  type ProductFeature, type ProductFeatureInput, type RecomputeResult, type UsageWindow,
  type VersionSnapshotRow,
} from './types';

export interface WriteMeta {
  actorId?: string | null;
  actorType?: 'user' | 'api_key' | 'system' | 'agent' | 'workflow';
  requestId?: string | null;
  livemode?: boolean;
}

export interface FeatureListFilter {
  type?: FeatureType;
  active?: boolean;
  meter?: string;
  query?: string;
}

export interface OverrideListFilter {
  customer?: string;
  feature?: string;
  status?: EntitlementOverride['status'] | 'all';
  limit?: number;
}

/** Why a recompute happened, carried onto the version row and its events. */
export interface RecomputeOptions {
  trigger: string;
  reason: string;
  meta?: WriteMeta;
}

/* -------------------------------- row shapes ------------------------------- */

interface FeatureRow {
  id: string; org_id: string; key: string; name: string; description: string | null; type: FeatureType;
  unit_label: string | null; default_value: number | null; default_unlimited: number; meter_key: string | null;
  usage_window: UsageWindow; allowance_interval: AllowanceInterval | null;
  credit_backed: number; approaching_threshold_percent: number; active: number;
  position: number; metadata: string; created: number; updated: number; livemode: number;
}

interface ProductFeatureRow {
  id: string; org_id: string; product_id: string; feature_key: string; value: number | null;
  unlimited: number; quantity_prices: string; created: number; updated: number;
}

interface OverrideRow {
  id: string; org_id: string; customer_id: string; feature_key: string; effect: 'grant' | 'suspend';
  value: number | null; unlimited: number; reason: string; expires_at: number | null;
  status: EntitlementOverride['status']; revoked_at: number | null; revoked_reason: string | null;
  created_by: string | null; metadata: string; created: number; updated: number;
}

interface ActiveRow {
  id: string; org_id: string; customer_id: string; feature_key: string; type: FeatureType;
  value: number | null; unlimited: number; source_type: EntitlementSourceType;
  source_subscription: string | null; source_subscription_item: string | null; source_product: string | null;
  source_price: string | null; source_override: string | null; source_expires_at: number | null;
  currency: string; period_start: number | null; period_end: number | null;
  version: number; granted_at: number; updated: number;
  approaching_notified_at: number | null; exceeded_notified_at: number | null;
}

interface VersionRow {
  id: string; org_id: string; customer_id: string; version: number; trigger: string; reason: string;
  changes: string; snapshot: string; actor_id: string | null; actor_type: string; created: number;
}

/* ------------------------------- candidates -------------------------------- */

interface Candidate {
  value: number | null;
  unlimited: boolean;
  type: EntitlementSourceType;
  subscription: string | null;
  subscriptionItem: string | null;
  product: string | null;
  price: string | null;
  override: string | null;
  expiresAt: number | null;
  currency: string;
  period: Window | null;
}

/** On an equal value the *plan* is the honest source, not a redundant override. */
const SOURCE_RANK: Record<EntitlementSourceType, number> = { subscription: 2, override: 1, feature_default: 0 };

const reachOf = (c: { value: number | null; unlimited: boolean }): number =>
  c.unlimited ? Number.POSITIVE_INFINITY : c.value ?? 0;

/**
 * The entitlements engine.
 *
 * Two paths run through this class and they have opposite priorities. The write
 * path (`recompute`) is allowed to be thorough: it reads every active
 * subscription, every product's declared features and every live override, and
 * it runs inside the caller's transaction so a plan change and the entitlements
 * it grants commit or roll back together. The read path (`check`) is allowed to
 * be nothing but fast: one index seek for the stored answer, a memoised meter
 * total, and a cached upgrade ladder.
 */
/**
 * Cache generations live at module scope rather than on the instance.
 *
 * A process holds one store per `Ctx`, but a seed, a test harness or a second
 * app in the same process can hold another — and a write through one of them
 * has to invalidate the memos in all of them. Sharing the counter can only ever
 * cause an extra cache miss; keeping them separate could serve a stale answer,
 * and this module exists to not do that.
 */
let CONFIG_EPOCH = 0;
let CATALOG_EPOCH = 0;

export class Entitlements {
  readonly usage: UsageReader;
  private readonly featureCache = new Map<string, { epoch: number; byKey: Map<string, Feature>; list: Feature[] }>();
  private readonly productFeatureCache = new Map<string, { epoch: number; byProduct: Map<string, ProductFeature[]>; byFeature: Map<string, ProductFeature[]> }>();
  private readonly ladderCache = new Map<string, { epoch: number; entries: LadderEntry[] }>();
  private readonly productNameCache = new Map<string, { epoch: number; name: string | null }>();
  private readonly orgCache = new Map<string, { locale: string; timeZone: string; currency: string }>();

  constructor(private readonly ctx: Ctx) {
    this.usage = new UsageReader(ctx);
  }

  invalidateCatalog(): void { CATALOG_EPOCH++; this.ladderCache.clear(); this.productNameCache.clear(); }
  invalidateConfig(): void { CONFIG_EPOCH++; this.featureCache.clear(); this.productFeatureCache.clear(); this.ladderCache.clear(); }
  invalidateOrg(): void { this.orgCache.clear(); }

  /* ------------------------------- workspace ------------------------------ */

  private org(orgId: string): { locale: string; timeZone: string; currency: string } {
    let hit = this.orgCache.get(orgId);
    if (!hit) {
      try {
        const org = this.ctx.svc.core.org(orgId);
        hit = { locale: org.locale || 'en-US', timeZone: org.timezone || 'UTC', currency: (org.default_currency || 'usd').toLowerCase() };
      } catch { hit = { locale: 'en-US', timeZone: 'UTC', currency: 'usd' }; }
      this.orgCache.set(orgId, hit);
    }
    return hit;
  }

  /* -------------------------------- features ------------------------------ */

  private featureIndex(orgId: string): { byKey: Map<string, Feature>; list: Feature[] } {
    const hit = this.featureCache.get(orgId);
    if (hit && hit.epoch === CONFIG_EPOCH) return hit;
    const list = this.ctx.db
      .all<FeatureRow>(`SELECT * FROM entitlement_features WHERE org_id = ? ORDER BY position ASC, key ASC`, orgId)
      .map(hydrateFeature);
    const entry = { epoch: CONFIG_EPOCH, byKey: new Map(list.map((f) => [f.key, f])), list };
    this.featureCache.set(orgId, entry);
    return entry;
  }

  features(orgId: string, filter: FeatureListFilter = {}): Feature[] {
    let list = this.featureIndex(orgId).list;
    if (filter.type) list = list.filter((f) => f.type === filter.type);
    if (filter.active !== undefined) list = list.filter((f) => f.active === filter.active);
    if (filter.meter) list = list.filter((f) => f.meter === filter.meter);
    if (filter.query) {
      const q = filter.query.toLowerCase();
      list = list.filter((f) => f.key.toLowerCase().includes(q) || f.name.toLowerCase().includes(q));
    }
    return list;
  }

  feature(orgId: string, key: string): Feature | null {
    return this.featureIndex(orgId).byKey.get(key) ?? null;
  }

  requireFeature(orgId: string, key: string): Feature {
    const found = this.feature(orgId, key);
    if (!found) throw notFound('feature', key);
    return found;
  }

  createFeature(orgId: string, input: FeatureInput, meta: WriteMeta = {}): Feature {
    return this.ctx.atomic(() => {
      const key = input.key.trim();
      if (!/^[a-z][a-z0-9_]{1,63}$/.test(key)) {
        throw badRequest('feature_key_invalid', 'A feature key is lower-case letters, digits and underscores, 2–64 characters, starting with a letter.', 'key');
      }
      if (this.feature(orgId, key)) {
        throw conflict('feature_key_taken', `Feature "${key}" already exists. A key is what product code checks against, so it is never reused.`);
      }
      if (input.type === 'metered' && !input.meter) {
        throw badRequest('feature_meter_required', 'A metered feature is answered from real events, so it must name the meter that records them.', 'meter');
      }
      if (input.meter && !this.ctx.svc.metering.meter(orgId, input.meter)) {
        throw badRequest('meter_missing', `No meter matches "${input.meter}". Create the meter first, or use its event name.`, 'meter');
      }
      if (input.credit_backed && !input.meter) {
        throw badRequest('feature_meter_required', 'Prepaid credit tops up a metered allowance, so a credit-backed feature must name its meter.', 'meter');
      }
      const now = this.ctx.now();
      const id = input.id ?? newId('feature');
      this.ctx.db.insert('entitlement_features', {
        id, org_id: orgId, key, name: input.name, description: input.description ?? null,
        type: input.type, unit_label: input.unit_label ?? null,
        default_value: input.default_value ?? null,
        default_unlimited: input.default_unlimited ? 1 : 0,
        meter_key: input.meter ?? null,
        usage_window: input.usage_window ?? 'billing_period',
        // A plan's numbers are quoted per month unless it says otherwise, so
        // that is what a feature means until somebody says otherwise too.
        allowance_interval: input.allowance_interval === undefined ? 'month' : input.allowance_interval,
        credit_backed: input.credit_backed ? 1 : 0,
        approaching_threshold_percent: input.approaching_threshold_percent ?? 80,
        active: input.active === false ? 0 : 1,
        position: input.position ?? 0,
        metadata: input.metadata ?? {},
        created: now, updated: now,
        livemode: meta.livemode === false ? 0 : 1,
      });
      this.invalidateConfig();
      const feature = this.requireFeature(orgId, key);
      this.ctx.emit(orgId, 'feature.created', feature, {
        objectId: feature.id, objectType: 'feature',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return feature;
    });
  }

  updateFeature(orgId: string, key: string, patch: FeaturePatch, meta: WriteMeta = {}): Feature {
    return this.ctx.atomic(() => {
      const before = this.requireFeature(orgId, key);
      if (patch.meter !== undefined && patch.meter !== null && !this.ctx.svc.metering.meter(orgId, patch.meter)) {
        throw badRequest('meter_missing', `No meter matches "${patch.meter}". Create the meter first, or use its event name.`, 'meter');
      }
      if (before.type === 'metered' && patch.meter === null) {
        throw badRequest('feature_meter_required', 'A metered feature cannot drop its meter — nothing would be left to count.', 'meter');
      }
      const changes: Record<string, Bindable> = { updated: this.ctx.now() };
      if (patch.name !== undefined) changes.name = patch.name;
      if (patch.description !== undefined) changes.description = patch.description;
      if (patch.unit_label !== undefined) changes.unit_label = patch.unit_label;
      if (patch.default_value !== undefined) changes.default_value = patch.default_value;
      if (patch.default_unlimited !== undefined) changes.default_unlimited = patch.default_unlimited ? 1 : 0;
      if (patch.meter !== undefined) changes.meter_key = patch.meter;
      if (patch.usage_window !== undefined) changes.usage_window = patch.usage_window;
      if (patch.allowance_interval !== undefined) changes.allowance_interval = patch.allowance_interval;
      if (patch.credit_backed !== undefined) changes.credit_backed = patch.credit_backed ? 1 : 0;
      if (patch.approaching_threshold_percent !== undefined) changes.approaching_threshold_percent = patch.approaching_threshold_percent;
      if (patch.active !== undefined) changes.active = patch.active ? 1 : 0;
      if (patch.position !== undefined) changes.position = patch.position;
      if (patch.metadata !== undefined) changes.metadata = { ...before.metadata, ...patch.metadata };
      this.ctx.db.patch('entitlement_features', 'id', before.id, changes);
      this.invalidateConfig();
      const after = this.requireFeature(orgId, key);
      this.ctx.emit(orgId, 'feature.updated', after, {
        objectId: after.id, objectType: 'feature', previous: { ...before },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      // Deactivating a feature revokes it everywhere; a value change can move
      // what a plan grants, so every holder is recomputed rather than left to
      // drift until their next subscription event.
      if (patch.active !== undefined || patch.default_value !== undefined || patch.default_unlimited !== undefined) {
        for (const customerId of this.holdersOf(orgId, key)) {
          this.recompute(orgId, customerId, { trigger: 'feature.updated', reason: `Feature "${key}" was updated.`, meta });
        }
      }
      return after;
    });
  }

  /** Customers whose set could move when this feature changes. */
  private holdersOf(orgId: string, featureKey: string): string[] {
    const holders = this.ctx.db.all<{ customer_id: string }>(
      `SELECT DISTINCT customer_id FROM entitlement_active WHERE org_id = ? AND feature_key = ?`, orgId, featureKey,
    ).map((r) => r.customer_id);
    const seen = new Set(holders);
    for (const row of this.ctx.db.all<{ customer_id: string }>(
      `SELECT DISTINCT customer_id FROM entitlement_overrides WHERE org_id = ? AND feature_key = ? AND status = 'active'`, orgId, featureKey,
    )) if (!seen.has(row.customer_id)) { seen.add(row.customer_id); holders.push(row.customer_id); }
    return holders;
  }

  /* ---------------------------- product features -------------------------- */

  private productFeatureIndex(orgId: string): { byProduct: Map<string, ProductFeature[]>; byFeature: Map<string, ProductFeature[]> } {
    const hit = this.productFeatureCache.get(orgId);
    if (hit && hit.epoch === CONFIG_EPOCH) return hit;
    const rows = this.ctx.db.all<ProductFeatureRow>(
      `SELECT * FROM entitlement_product_features WHERE org_id = ? ORDER BY feature_key ASC, product_id ASC`, orgId,
    );
    const byProduct = new Map<string, ProductFeature[]>();
    const byFeature = new Map<string, ProductFeature[]>();
    const features = this.featureIndex(orgId).byKey;
    const push = (map: Map<string, ProductFeature[]>, key: string, value: ProductFeature) => {
      const bucket = map.get(key);
      if (bucket) bucket.push(value); else map.set(key, [value]);
    };
    for (const row of rows) {
      const pf = hydrateProductFeature(row, features.get(row.feature_key) ?? null);
      push(byProduct, row.product_id, pf);
      push(byFeature, row.feature_key, pf);
    }
    const entry = { epoch: CONFIG_EPOCH, byProduct, byFeature };
    this.productFeatureCache.set(orgId, entry);
    return entry;
  }

  productFeatures(orgId: string, filter: { product?: string; feature?: string } = {}): ProductFeature[] {
    const index = this.productFeatureIndex(orgId);
    let rows: ProductFeature[] = filter.product
      ? index.byProduct.get(filter.product) ?? []
      : filter.feature
        ? index.byFeature.get(filter.feature) ?? []
        : [...index.byProduct.values()].flat();
    if (filter.product && filter.feature) rows = rows.filter((r) => r.feature === filter.feature);
    return rows.map((row) => ({ ...row, product_name: this.productName(orgId, row.product) }));
  }

  setProductFeature(orgId: string, input: ProductFeatureInput, meta: WriteMeta = {}): ProductFeature {
    return this.ctx.atomic(() => {
      const feature = this.requireFeature(orgId, input.feature);
      const product = this.ctx.svc.catalog.requireProduct(orgId, input.product);
      const unlimited = input.unlimited === true;
      let value = unlimited ? null : input.value ?? null;
      if (feature.type === 'boolean') {
        if (unlimited) throw badRequest('feature_value_invalid', `"${feature.key}" is a boolean feature — a product either includes it or does not, so it cannot be unlimited.`, 'unlimited');
        value = 1;
      } else if (!unlimited) {
        if (value === null) {
          throw badRequest('feature_value_required', `"${feature.key}" is a ${feature.type} feature, so ${product.name} has to say how much of it is included.`, 'value');
        }
        if (!Number.isInteger(value) || value < 0) {
          throw badRequest('feature_value_invalid', 'A feature value is a whole number of units, zero or more.', 'value');
        }
      }
      for (const priceId of input.quantity_prices ?? []) {
        const price = this.ctx.svc.catalog.requirePrice(orgId, priceId);
        if (price.product !== product.id) {
          throw badRequest('quantity_price_mismatch', `Price ${priceId} belongs to a different product, so its quantity cannot set ${product.name}'s ${feature.name.toLowerCase()}.`, 'quantity_prices');
        }
      }
      const now = this.ctx.now();
      const existing = this.ctx.db.get<ProductFeatureRow>(
        `SELECT * FROM entitlement_product_features WHERE org_id = ? AND product_id = ? AND feature_key = ?`,
        orgId, product.id, feature.key,
      );
      const id = existing?.id ?? randomId('pfeat');
      this.ctx.db.upsert('entitlement_product_features', {
        id, org_id: orgId, product_id: product.id, feature_key: feature.key,
        value, unlimited: unlimited ? 1 : 0,
        quantity_prices: input.quantity_prices ?? [],
        created: existing?.created ?? now, updated: now,
      }, ['org_id', 'product_id', 'feature_key']);
      this.invalidateConfig();
      const row = this.ctx.db.get<ProductFeatureRow>(
        `SELECT * FROM entitlement_product_features WHERE org_id = ? AND product_id = ? AND feature_key = ?`,
        orgId, product.id, feature.key,
      )!;
      const hydrated = { ...hydrateProductFeature(row, feature), product_name: product.name };
      this.ctx.emit(orgId, existing ? 'product_feature.updated' : 'product_feature.created', hydrated, {
        objectId: product.id, objectType: 'product',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      this.recomputeProductHolders(orgId, product.id, `${product.name} changed what it includes of ${feature.name}.`, meta);
      return hydrated;
    });
  }

  removeProductFeature(orgId: string, productId: string, featureKey: string, meta: WriteMeta = {}): void {
    this.ctx.atomic(() => {
      const row = this.ctx.db.get<ProductFeatureRow>(
        `SELECT * FROM entitlement_product_features WHERE org_id = ? AND product_id = ? AND feature_key = ?`,
        orgId, productId, featureKey,
      );
      if (!row) throw notFound('product feature', `${productId}/${featureKey}`);
      this.ctx.db.run(`DELETE FROM entitlement_product_features WHERE id = ? AND org_id = ?`, row.id, orgId);
      this.invalidateConfig();
      this.ctx.emit(orgId, 'product_feature.deleted', { product: productId, feature: featureKey }, {
        objectId: productId, objectType: 'product',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      const product = this.ctx.svc.catalog.product(orgId, productId);
      this.recomputeProductHolders(orgId, productId, `${product?.name ?? productId} no longer includes ${featureKey}.`, meta);
    });
  }

  /** Everyone whose entitlements are sourced from this product, recomputed. */
  private recomputeProductHolders(orgId: string, productId: string, reason: string, meta: WriteMeta): void {
    const holders = this.ctx.db.all<{ customer_id: string }>(
      `SELECT DISTINCT customer_id FROM entitlement_active WHERE org_id = ? AND source_product = ?`, orgId, productId,
    ).map((r) => r.customer_id);
    const seen = new Set(holders);
    for (const price of this.ctx.svc.catalog.pricesFor(orgId, productId)) {
      for (const sub of this.ctx.svc.billing.subscriptions(orgId, { price: price.id, status: 'active_like', limit: 500 })) {
        if (!seen.has(sub.customer)) { seen.add(sub.customer); holders.push(sub.customer); }
      }
    }
    for (const customerId of holders) {
      this.recompute(orgId, customerId, { trigger: 'product_feature.changed', reason, meta });
    }
  }

  /* -------------------------------- overrides ------------------------------ */

  overrides(orgId: string, filter: OverrideListFilter = {}): EntitlementOverride[] {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.feature) { clauses.push('feature_key = ?'); params.push(filter.feature); }
    if (filter.status && filter.status !== 'all') { clauses.push('status = ?'); params.push(filter.status); }
    const features = this.featureIndex(orgId).byKey;
    return this.ctx.db.all<OverrideRow>(
      `SELECT * FROM entitlement_overrides WHERE ${clauses.join(' AND ')} ORDER BY created DESC, id DESC LIMIT ?`,
      ...(params as string[]), Math.min(filter.limit ?? 100, 500),
    ).map((row) => hydrateOverride(row, features.get(row.feature_key) ?? null));
  }

  override(orgId: string, id: string): EntitlementOverride | null {
    const row = this.ctx.db.get<OverrideRow>(`SELECT * FROM entitlement_overrides WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydrateOverride(row, this.feature(orgId, row.feature_key)) : null;
  }

  requireOverride(orgId: string, id: string): EntitlementOverride {
    const found = this.override(orgId, id);
    if (!found) throw notFound('entitlement override', id);
    return found;
  }

  createOverride(orgId: string, input: OverrideInput, meta: WriteMeta = {}): EntitlementOverride {
    return this.ctx.atomic(() => {
      const feature = this.requireFeature(orgId, input.feature);
      const customer = this.ctx.svc.billing.requireCustomer(orgId, input.customer);
      const now = this.ctx.now();
      const effect = input.effect ?? 'grant';
      const reason = input.reason.trim();
      if (!reason) throw badRequest('override_reason_required', 'An override needs a reason — it is what an auditor reads when the bill is questioned.', 'reason');
      if (input.expires_at !== undefined && input.expires_at !== null && input.expires_at <= now) {
        throw badRequest('override_expiry_in_past', 'An override expires in the future. To end one now, revoke it.', 'expires_at');
      }
      const unlimited = effect === 'grant' && input.unlimited === true;
      let value: number | null = null;
      if (effect === 'grant' && !unlimited) {
        value = feature.type === 'boolean' ? 1 : input.value ?? null;
        if (value === null) {
          throw badRequest('override_value_required', `"${feature.key}" is a ${feature.type} feature, so the grant has to say how much.`, 'value');
        }
        if (!Number.isInteger(value) || value < 0) {
          throw badRequest('override_value_invalid', 'An override value is a whole number of units, zero or more.', 'value');
        }
      }
      const id = randomId('ent_ovr');
      this.ctx.db.insert('entitlement_overrides', {
        id, org_id: orgId, customer_id: customer.id, feature_key: feature.key, effect,
        value, unlimited: unlimited ? 1 : 0, reason, expires_at: input.expires_at ?? null,
        status: 'active', revoked_at: null, revoked_reason: null,
        created_by: meta.actorId ?? null, metadata: input.metadata ?? {},
        created: now, updated: now,
      });
      const override = this.requireOverride(orgId, id);
      this.ctx.emit(orgId, 'entitlement_override.created', override, {
        objectId: customer.id, objectType: 'customer',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      // The expiry is a row with a `run_at`, never a timer — which is what lets
      // the time machine watch a temporary raise take itself away again.
      if (input.expires_at) {
        this.ctx.enqueue(orgId, 'entitlements.override_expire', { override: id, customer: customer.id, feature: feature.key }, {
          runAt: input.expires_at, idemKey: `entitlements.override_expire:${id}`,
        });
      }
      this.recompute(orgId, customer.id, {
        trigger: 'override.created',
        reason: effect === 'grant'
          ? `Support granted ${feature.name.toLowerCase()}: ${reason}`
          : `Support suspended ${feature.name.toLowerCase()}: ${reason}`,
        meta,
      });
      return this.requireOverride(orgId, id);
    });
  }

  revokeOverride(orgId: string, id: string, revokedReason: string | null, meta: WriteMeta = {}): EntitlementOverride {
    return this.ctx.atomic(() => {
      const before = this.requireOverride(orgId, id);
      if (before.status !== 'active') {
        throw conflict('override_not_active', `That override is already ${before.status}.`, { status: before.status });
      }
      const now = this.ctx.now();
      this.ctx.db.patch('entitlement_overrides', 'id', id, {
        status: 'revoked', revoked_at: now, revoked_reason: revokedReason, updated: now,
      });
      this.ctx.jobs.cancel(orgId, { idemKey: `entitlements.override_expire:${id}` }, now);
      const after = this.requireOverride(orgId, id);
      this.ctx.emit(orgId, 'entitlement_override.revoked', after, {
        objectId: after.customer, objectType: 'customer', previous: { status: before.status },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      this.recompute(orgId, after.customer, {
        trigger: 'override.revoked',
        reason: revokedReason ? `Override revoked: ${revokedReason}` : 'Override revoked.',
        meta,
      });
      return after;
    });
  }

  /** The job's side of an expiry: mark it, then recompute what it was holding up. */
  expireOverride(orgId: string, id: string): EntitlementOverride | null {
    return this.ctx.atomic(() => {
      const row = this.ctx.db.get<OverrideRow>(`SELECT * FROM entitlement_overrides WHERE org_id = ? AND id = ?`, orgId, id);
      if (!row || row.status !== 'active') return null;
      const now = this.ctx.now();
      if (row.expires_at === null || row.expires_at > now) return null;
      this.ctx.db.patch('entitlement_overrides', 'id', id, { status: 'expired', updated: now });
      const after = this.requireOverride(orgId, id);
      this.ctx.emit(orgId, 'entitlement_override.expired', after, {
        objectId: after.customer, objectType: 'customer', previous: { status: 'active' },
      });
      this.recompute(orgId, after.customer, {
        trigger: 'override.expired',
        reason: `The temporary grant "${after.reason}" expired.`,
      });
      return after;
    });
  }

  /** Every override that has run out but not yet been swept — the safety net. */
  expireDue(orgId: string): EntitlementOverride[] {
    const now = this.ctx.now();
    const due = this.ctx.db.all<{ id: string }>(
      `SELECT id FROM entitlement_overrides WHERE org_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
      orgId, now,
    );
    const out: EntitlementOverride[] = [];
    for (const row of due) {
      const expired = this.expireOverride(orgId, row.id);
      if (expired) out.push(expired);
    }
    return out;
  }

  /* -------------------------------- recompute ------------------------------ */

  /**
   * Derive the whole set for one customer and store the difference.
   *
   * Called from the subscription events themselves, so this runs inside the
   * transaction that moved the subscription: the plan change and the
   * entitlements it grants either both commit or neither does. There is no
   * window in which a customer is on Scale and still capped at Growth's seats.
   */
  recompute(orgId: string, customerId: string, opts: RecomputeOptions): RecomputeResult {
    return this.ctx.atomic(() => {
      const now = this.ctx.now();
      const { locale } = this.org(orgId);
      const features = this.featureIndex(orgId).byKey;
      const existing = new Map(
        this.ctx.db.all<ActiveRow>(`SELECT * FROM entitlement_active WHERE org_id = ? AND customer_id = ?`, orgId, customerId)
          .map((row) => [row.feature_key, row]),
      );
      const candidates = new Map<string, Candidate>();

      let anyFeatures = false;
      for (const feature of features.values()) if (feature.active) { anyFeatures = true; break; }
      if (anyFeatures) {
        const orgCurrency = this.org(orgId).currency;
        for (const feature of features.values()) {
          if (!feature.active) continue;
          if (feature.default_value === null && !feature.default_unlimited) continue;
          candidates.set(feature.key, {
            value: feature.default_unlimited ? null : feature.default_value,
            unlimited: feature.default_unlimited,
            type: 'feature_default', subscription: null, subscriptionItem: null, product: null,
            price: null, override: null, expiresAt: null, currency: orgCurrency, period: null,
          });
        }

        const subs = this.ctx.svc.billing.subscriptions(orgId, { customer: customerId, status: 'active_like', limit: 200 });
        for (const sub of subs) {
          for (const [productId, item] of this.productsOf(orgId, sub)) {
            for (const pf of this.productFeatureIndex(orgId).byProduct.get(productId) ?? []) {
              const feature = features.get(pf.feature);
              if (!feature || !feature.active) continue;
              let value = pf.unlimited ? null : pf.value;
              if (!pf.unlimited && pf.quantity_prices.length) {
                const bought = sub.items
                  .filter((i) => pf.quantity_prices.includes(i.price))
                  .reduce((acc, i) => acc + i.quantity, 0);
                if (bought > 0) value = Math.max(value ?? 0, bought);
              }
              offer(candidates, pf.feature, {
                value, unlimited: pf.unlimited, type: 'subscription',
                subscription: sub.id, subscriptionItem: item.id, product: productId, price: item.price,
                override: null, expiresAt: endOfAccess(sub),
                currency: sub.currency,
                period: { start: sub.current_period_start, end: sub.current_period_end },
              });
            }
          }
        }
      }

      const live = this.ctx.db.all<OverrideRow>(
        `SELECT * FROM entitlement_overrides WHERE org_id = ? AND customer_id = ? AND status = 'active' ORDER BY created ASC`,
        orgId, customerId,
      ).filter((row) => row.expires_at === null || row.expires_at > now);

      for (const row of live) {
        if (row.effect !== 'grant') continue;
        const feature = features.get(row.feature_key);
        if (!feature || !feature.active) continue;
        offer(candidates, row.feature_key, {
          value: row.unlimited ? null : row.value,
          unlimited: !!row.unlimited,
          type: 'override', subscription: null, subscriptionItem: null, product: null, price: null,
          override: row.id, expiresAt: row.expires_at,
          currency: candidates.get(row.feature_key)?.currency ?? this.org(orgId).currency,
          period: candidates.get(row.feature_key)?.period ?? null,
        });
      }
      // A suspension is absolute: it removes the entitlement whatever granted it.
      for (const row of live) {
        if (row.effect === 'suspend') candidates.delete(row.feature_key);
      }

      /* ------------------------------- the diff ----------------------------- */

      const changes: EntitlementChange[] = [];
      const nextVersion = this.currentVersion(orgId, customerId) + 1;
      const touched: { key: string; candidate: Candidate; row: ActiveRow | undefined; moved: boolean; valueChanged: boolean }[] = [];

      for (const [key, candidate] of candidates) {
        const feature = features.get(key)!;
        const row = existing.get(key);
        // What the customer may do, and who says so. A period roll or a
        // currency correction moves neither, and must not mint a version.
        const valueChanged = !row
          || row.value !== (candidate.unlimited ? null : candidate.value)
          || !!row.unlimited !== candidate.unlimited;
        const moved = valueChanged
          || row!.source_type !== candidate.type
          || (row!.source_subscription ?? null) !== candidate.subscription
          || (row!.source_override ?? null) !== candidate.override
          || (row!.source_product ?? null) !== candidate.product;
        if (moved) {
          const kind: ChangeKind = row ? 'changed' : 'granted';
          changes.push({
            kind,
            feature: key,
            feature_name: feature.name,
            type: feature.type,
            unit_label: feature.unit_label,
            from: row ? { value: row.value, unlimited: !!row.unlimited, source: row.source_type } : null,
            to: { value: candidate.unlimited ? null : candidate.value, unlimited: candidate.unlimited, source: candidate.type },
            summary: changeSummary(
              kind, feature,
              row ? { value: row.value, unlimited: !!row.unlimited } : null,
              { value: candidate.unlimited ? null : candidate.value, unlimited: candidate.unlimited },
              this.sourceName(orgId, candidate), locale,
            ),
          });
        }
        touched.push({ key, candidate, row, moved, valueChanged });
      }

      for (const [key, row] of existing) {
        if (candidates.has(key)) continue;
        const feature = features.get(key);
        changes.push({
          kind: 'revoked',
          feature: key,
          feature_name: feature?.name ?? key,
          type: row.type,
          unit_label: feature?.unit_label ?? null,
          from: { value: row.value, unlimited: !!row.unlimited, source: row.source_type },
          to: null,
          summary: feature
            ? changeSummary('revoked', feature, { value: row.value, unlimited: !!row.unlimited }, null, null, locale)
            : `${key} revoked.`,
        });
        this.ctx.db.run(`DELETE FROM entitlement_active WHERE id = ? AND org_id = ?`, row.id, orgId);
      }

      const version = changes.length ? nextVersion : this.currentVersion(orgId, customerId);

      for (const { key, candidate, row, moved, valueChanged } of touched) {
        const columns = {
          type: features.get(key)!.type,
          value: candidate.unlimited ? null : candidate.value,
          unlimited: candidate.unlimited ? 1 : 0,
          source_type: candidate.type,
          source_subscription: candidate.subscription,
          source_subscription_item: candidate.subscriptionItem,
          source_product: candidate.product,
          source_price: candidate.price,
          source_override: candidate.override,
          source_expires_at: candidate.expiresAt,
          currency: candidate.currency,
          period_start: candidate.period?.start ?? null,
          period_end: candidate.period?.end ?? null,
          updated: now,
        };
        if (!row) {
          this.ctx.db.insert('entitlement_active', {
            id: newId('entitlement'), org_id: orgId, customer_id: customerId, feature_key: key,
            ...columns, version, granted_at: now,
            approaching_notified_at: null, exceeded_notified_at: null,
          });
        } else {
          const periodMoved = (row.period_start ?? null) !== columns.period_start;
          this.ctx.db.patch('entitlement_active', 'id', row.id, {
            ...columns,
            ...(moved ? { version } : {}),
            // A fresh period is a fresh allowance, so the warnings it already
            // raised must not silence the ones the new period will need.
            ...(periodMoved || valueChanged ? { approaching_notified_at: null, exceeded_notified_at: null } : {}),
          });
        }
      }

      if (changes.length) {
        const snapshot: VersionSnapshotRow[] = [...candidates.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([key, c]) => ({
            feature: key,
            value: c.unlimited ? null : c.value,
            unlimited: c.unlimited,
            source: c.type,
            source_id: c.override ?? c.subscription ?? null,
          }));
        this.ctx.db.insert('entitlement_versions', {
          id: randomId('ent_ver'), org_id: orgId, customer_id: customerId, version,
          trigger: opts.trigger, reason: opts.reason,
          changes, snapshot,
          actor_id: opts.meta?.actorId ?? null, actor_type: opts.meta?.actorType ?? 'system',
          created: now,
        });
        for (const change of changes) {
          const type = change.kind === 'granted' ? 'entitlement.granted'
            : change.kind === 'revoked' ? 'entitlement.revoked'
              : 'entitlement.changed';
          this.ctx.emit(orgId, type, {
            customer: customerId, feature: change.feature, feature_name: change.feature_name,
            type: change.type, unit_label: change.unit_label,
            value: change.to?.value ?? null, unlimited: change.to?.unlimited ?? false,
            previous_value: change.from?.value ?? null, previous_unlimited: change.from?.unlimited ?? false,
            source: change.to?.source ?? null, version, summary: change.summary,
            trigger: opts.trigger, reason: opts.reason,
          }, {
            objectId: customerId, objectType: 'customer',
            actorId: opts.meta?.actorId, actorType: opts.meta?.actorType, requestId: opts.meta?.requestId,
          });
        }
        this.ctx.emit(orgId, 'entitlements.recomputed', {
          customer: customerId, version, trigger: opts.trigger, reason: opts.reason,
          granted: changes.filter((c) => c.kind === 'granted').length,
          revoked: changes.filter((c) => c.kind === 'revoked').length,
          changed: changes.filter((c) => c.kind === 'changed').length,
        }, { objectId: customerId, objectType: 'customer', actorId: opts.meta?.actorId, actorType: opts.meta?.actorType });
      }

      const entitlements = this.active(orgId, customerId, { usage: false });

      // The whole set in one payload, for the cache at the edge that would
      // otherwise have to reassemble it from the per-feature events. It is
      // published inside this transaction, so it can never describe a set that
      // was rolled back — which is the guarantee an eventually-consistent
      // summary cannot make.
      if (changes.length) {
        this.ctx.emit(orgId, 'entitlement_summary.updated', summaryOf(customerId, version, entitlements, now), {
          objectId: customerId, objectType: 'customer',
          actorId: opts.meta?.actorId, actorType: opts.meta?.actorType, requestId: opts.meta?.requestId,
        });
      }

      return { customer: customerId, version, changed: changes.length > 0, changes, entitlements };
    });
  }

  /** The cached shape, read on demand: the same payload the webhook delivers. */
  summary(orgId: string, customerId: string): EntitlementSummary {
    this.ctx.svc.billing.requireCustomer(orgId, customerId);
    return summaryOf(
      customerId, this.currentVersion(orgId, customerId),
      this.active(orgId, customerId, { usage: false }), this.ctx.now(),
    );
  }

  /** Distinct products on a subscription, each with the item that introduced it. */
  private productsOf(orgId: string, sub: Subscription): Map<string, Subscription['items'][number]> {
    const out = new Map<string, Subscription['items'][number]>();
    for (const item of sub.items) {
      const price = this.ctx.svc.catalog.price(orgId, item.price);
      if (!price) continue;
      if (!out.has(price.product)) out.set(price.product, item);
    }
    return out;
  }

  currentVersion(orgId: string, customerId: string): number {
    return Number(this.ctx.db.pluck<number>(
      `SELECT MAX(version) FROM entitlement_versions WHERE org_id = ? AND customer_id = ?`, orgId, customerId,
    ) ?? 0);
  }

  versions(orgId: string, customerId: string, limit = 20): EntitlementVersion[] {
    return this.ctx.db.all<VersionRow>(
      `SELECT * FROM entitlement_versions WHERE org_id = ? AND customer_id = ? ORDER BY version DESC LIMIT ?`,
      orgId, customerId, Math.min(limit, 200),
    ).map(hydrateVersion);
  }

  /* --------------------------------- reading ------------------------------- */

  private productName(orgId: string, productId: string | null): string | null {
    if (!productId) return null;
    const key = `${orgId}:${productId}`;
    const hit = this.productNameCache.get(key);
    if (hit && hit.epoch === CATALOG_EPOCH) return hit.name;
    const name = this.ctx.svc.catalog.product(orgId, productId)?.name ?? null;
    this.productNameCache.set(key, { epoch: CATALOG_EPOCH, name });
    return name;
  }

  private sourceName(orgId: string, candidate: Candidate): string | null {
    if (candidate.type === 'subscription') return this.productName(orgId, candidate.product);
    if (candidate.type === 'override') return 'a support grant';
    return null;
  }

  private sourceOf(orgId: string, row: ActiveRow): EntitlementSource {
    const productName = this.productName(orgId, row.source_product);
    const description = row.source_type === 'subscription'
      ? `Included in ${productName ?? row.source_product ?? 'the subscribed plan'}`
      : row.source_type === 'override'
        ? 'Granted by a support override'
        : 'Included for every account';
    return {
      type: row.source_type,
      subscription: row.source_subscription,
      subscription_item: row.source_subscription_item,
      product: row.source_product,
      product_name: productName,
      price: row.source_price,
      override: row.source_override,
      description,
      expires_at: row.source_expires_at,
    };
  }

  private activeRow(orgId: string, customerId: string, featureKey: string): ActiveRow | undefined {
    return this.ctx.db.get<ActiveRow>(
      `SELECT * FROM entitlement_active WHERE org_id = ? AND customer_id = ? AND feature_key = ?`,
      orgId, customerId, featureKey,
    );
  }

  active(orgId: string, customerId: string, opts: { usage?: boolean } = {}): ActiveEntitlement[] {
    const features = this.featureIndex(orgId).byKey;
    const rows = this.ctx.db.all<ActiveRow>(
      `SELECT * FROM entitlement_active WHERE org_id = ? AND customer_id = ?`, orgId, customerId,
    );
    const now = this.ctx.now();
    const ordered = rows
      .slice()
      .sort((a, b) => (features.get(a.feature_key)?.position ?? 0) - (features.get(b.feature_key)?.position ?? 0)
        || a.feature_key.localeCompare(b.feature_key));
    return ordered.map((row) => this.toActive(orgId, row, features.get(row.feature_key) ?? null, now, opts.usage !== false));
  }

  /** One stored entitlement by its own id, the way a cached summary refers to it. */
  activeById(orgId: string, id: string, opts: { usage?: boolean } = {}): ActiveEntitlement | null {
    const row = this.ctx.db.get<ActiveRow>(`SELECT * FROM entitlement_active WHERE org_id = ? AND id = ?`, orgId, id);
    if (!row) return null;
    const feature = this.featureIndex(orgId).byKey.get(row.feature_key) ?? null;
    return this.toActive(orgId, row, feature, this.ctx.now(), opts.usage !== false);
  }

  private toActive(orgId: string, row: ActiveRow, feature: Feature | null, now: number, withUsage: boolean): ActiveEntitlement {
    const period = row.period_start !== null && row.period_end !== null
      ? { start: row.period_start, end: row.period_end }
      : null;
    return {
      object: 'active_entitlement',
      id: row.id,
      customer: row.customer_id,
      feature: row.feature_key,
      feature_name: feature?.name ?? row.feature_key,
      description: feature?.description ?? null,
      type: row.type,
      unit_label: feature?.unit_label ?? null,
      value: row.value,
      unlimited: !!row.unlimited,
      source: this.sourceOf(orgId, row),
      period,
      usage: withUsage && feature ? this.usageFor(orgId, feature, row.customer_id, row, now) : null,
      version: row.version,
      granted_at: row.granted_at,
      updated: row.updated,
    };
  }

  private usageFor(orgId: string, feature: Feature, customerId: string, row: ActiveRow, now: number): EntitlementUsage | null {
    if (!feature.meter) return null;
    const period = row.period_start !== null && row.period_end !== null
      ? { start: row.period_start, end: row.period_end }
      : null;
    const win = this.usage.windowFor(feature, period, now);
    const live = this.usage.read(orgId, feature, customerId, win);
    if (!live) return null;
    const included = row.unlimited ? null : row.value ?? 0;
    const limit = included === null ? null : included + live.credit_units;
    return {
      meter: live.meter,
      meter_name: live.meter_name,
      unit_label: live.unit_label,
      used: live.used,
      credit_units: live.credit_units,
      included,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - live.used),
      // Exact, then rounded once: a whole percent for display, never a float.
      percent_used: limit === null || limit === 0
        ? null
        : Math.min(100, Number(ratRound(ratMul(rat(live.used, limit), rat(100)), 'down'))),
      as_of: now,
    };
  }

  set(orgId: string, customerId: string, opts: { usage?: boolean } = {}): EntitlementSet {
    this.ctx.svc.billing.requireCustomer(orgId, customerId);
    const subs = this.ctx.svc.billing.subscriptions(orgId, { customer: customerId, status: 'active_like', limit: 200 });
    return {
      object: 'entitlement_set',
      customer: customerId,
      version: this.currentVersion(orgId, customerId),
      entitlements: this.active(orgId, customerId, opts),
      overrides: this.overrides(orgId, { customer: customerId, status: 'active' }),
      sources: subs.map((sub) => ({
        subscription: sub.id,
        status: sub.status,
        products: [...this.productsOf(orgId, sub).keys()],
        period_end: sub.current_period_end,
      })),
      as_of: this.ctx.now(),
    };
  }

  /* --------------------------------- checking ------------------------------ */

  private ladderFor(orgId: string, featureKey: string, currency: string): LadderEntry[] {
    const key = `${orgId}:${featureKey}:${currency}`;
    const hit = this.ladderCache.get(key);
    if (hit && hit.epoch === CONFIG_EPOCH + CATALOG_EPOCH) return hit.entries;
    const rows = this.productFeatureIndex(orgId).byFeature.get(featureKey) ?? [];
    const entries = buildLadder({ ctx: this.ctx, locale: this.org(orgId).locale }, orgId, rows, currency);
    this.ladderCache.set(key, { epoch: CONFIG_EPOCH + CATALOG_EPOCH, entries });
    return entries;
  }

  /**
   * "Can this customer do this right now, and how much is left?"
   *
   * One index seek for the stored entitlement, a memoised meter read for what
   * has been consumed, and a cached ladder for what the next plan up would
   * give them. Nothing here recomputes the entitlement itself — that already
   * happened, inside the transaction that changed the subscription.
   */
  check(orgId: string, input: CheckInput, opts: { emit?: boolean } = {}): EntitlementCheck {
    const started = process.hrtime.bigint();
    const now = this.ctx.now();
    const requested = Math.max(0, Math.trunc(input.requested ?? 0));
    const feature = this.requireFeature(orgId, input.feature);
    const { locale, timeZone, currency: orgCurrency } = this.org(orgId);
    const row = this.activeRow(orgId, input.customer, feature.key);

    const currency = row?.currency ?? orgCurrency;
    const period = row && row.period_start !== null && row.period_end !== null
      ? { start: row.period_start, end: row.period_end }
      : null;

    const finish = (check: Omit<EntitlementCheck, 'latency_us'>): EntitlementCheck => ({
      ...check,
      latency_us: Number((process.hrtime.bigint() - started) / 1000n),
    });

    if (!row) {
      // Nothing is stored for this pair. Before answering "not entitled" — the
      // safe answer, and the one a hot path wants — confirm the account exists,
      // so a mistyped customer id is a 404 rather than a silent refusal that
      // looks exactly like a downgrade. This costs one indexed read, and only
      // on the path that was already going to say no.
      this.ctx.svc.billing.requireCustomer(orgId, input.customer);
      const currentPlan = this.currentPlanName(orgId, input.customer);
      const upgrade = bestUpgrade(this.ladderFor(orgId, feature.key, currency), { value: 0, unlimited: false, product: null }, Math.max(requested, 1));
      return finish({
        object: 'entitlement_check',
        customer: input.customer, feature: feature.key, feature_name: feature.name,
        type: feature.type, unit_label: feature.unit_label, requested,
        allowed: false, limit: 0, unlimited: false, included_limit: 0, credit_units: 0,
        used: 0, remaining: 0, approaching: false,
        threshold_percent: feature.approaching_threshold_percent,
        reason: reasonFor({
          feature, locale, timeZone, entitled: false, unlimited: false, limit: 0, includedLimit: 0,
          creditUnits: 0, used: 0, requested, remaining: 0, allowed: false,
          metered: feature.type === 'metered', counted: feature.meter !== null,
          resetsAt: null, source: null, currentPlan,
        }),
        upgrade_path: upgrade ? toUpgradePath(upgrade, feature, locale) : null,
        source: null, period: null,
        version: this.currentVersion(orgId, input.customer),
        as_of: now,
      });
    }

    const source = this.sourceOf(orgId, row);
    const sourceWords: SourceWords = source.type === 'subscription'
      ? { name: source.product_name ?? 'your plan', isPlan: true }
      : source.type === 'override'
        ? { name: 'a support grant', isPlan: false }
        : { name: 'this account', isPlan: true };

    const unlimited = !!row.unlimited;
    const win = feature.meter ? this.usage.windowFor(feature, period, now) : null;
    const live = win ? this.usage.read(orgId, feature, input.customer, win) : null;
    const used = live?.used ?? 0;
    const creditUnits = live?.credit_units ?? 0;
    const includedLimit = unlimited ? null : row.value ?? 0;
    const limit = includedLimit === null ? null : includedLimit + creditUnits;

    const isBoolean = feature.type === 'boolean';
    const allowed = isBoolean || limit === null || used + requested <= limit;
    const remaining = limit === null ? null : Math.max(0, limit - used);

    // Exact integer comparison — `used / limit >= pct / 100` with no division.
    const approaching = limit !== null && limit > 0
      && ratCmp(rat(used, 1), ratMul(rat(limit, 1), rat(feature.approaching_threshold_percent, 100))) >= 0;

    if (opts.emit !== false && !isBoolean && limit !== null) {
      this.announce(orgId, row, feature, {
        approaching, used, limit, requested, remaining: remaining ?? 0, periodKey: win?.start ?? 0,
      });
    }

    const upgrade = bestUpgrade(
      this.ladderFor(orgId, feature.key, currency),
      { value: row.value, unlimited, product: row.source_product },
      isBoolean ? 1 : used + Math.max(requested, 1),
    );

    return finish({
      object: 'entitlement_check',
      customer: input.customer, feature: feature.key, feature_name: feature.name,
      type: feature.type, unit_label: feature.unit_label, requested,
      allowed,
      limit: isBoolean ? null : limit,
      unlimited,
      included_limit: isBoolean ? null : includedLimit,
      credit_units: creditUnits,
      used,
      remaining: isBoolean ? null : remaining,
      approaching,
      threshold_percent: feature.approaching_threshold_percent,
      reason: reasonFor({
        feature, locale, timeZone, entitled: true, unlimited,
        limit: isBoolean ? null : limit, includedLimit, creditUnits, used, requested,
        remaining, allowed, metered: feature.type === 'metered',
        counted: feature.meter !== null,
        resetsAt: feature.type === 'metered' ? win?.end ?? null : null,
        source: sourceWords, currentPlan: sourceWords.isPlan ? sourceWords.name : null,
      }),
      upgrade_path: upgrade ? toUpgradePath(upgrade, feature, locale) : null,
      source, period: win,
      version: row.version,
      as_of: now,
    });
  }

  /**
   * Tell the automation layer once, not on every call — and only about what has
   * actually happened.
   *
   * An event is a statement of fact, so these two are raised by *consumption*
   * and by nothing else. A check carrying a `requested` is a question — "may I
   * push nine hundred thousand events?", "what would a billion cost me?" — and
   * a question that is answered no is not a breach: it never touches the meter,
   * so it can neither raise the alarm nor use up the period's one mark and
   * leave the real breach that follows it silent. `check` is safe to call from
   * a pricing page for exactly that reason.
   *
   * Once it is a fact, a product on a hot path will restate it thousands of
   * times a minute, and a workflow that emails on each of those is a workflow
   * nobody keeps switched on. So each state is announced once per allowance
   * window, and a fresh window clears the marks.
   */
  private announce(
    orgId: string, row: ActiveRow, feature: Feature,
    state: { approaching: boolean; used: number; limit: number; requested: number; remaining: number; periodKey: number },
  ): void {
    // A zero allowance is passed by using any of it at all; every other ceiling
    // is passed by reaching it.
    const exceeded = state.used > 0 && state.used >= state.limit;
    if (!exceeded && !state.approaching) return;
    const payload = {
      customer: row.customer_id, feature: feature.key, feature_name: feature.name,
      unit_label: feature.unit_label, used: state.used, limit: state.limit,
      remaining: state.remaining, requested: state.requested,
      threshold_percent: feature.approaching_threshold_percent,
      source: row.source_type, product: row.source_product,
      period_start: row.period_start, period_end: row.period_end,
    };
    if (exceeded) {
      if (row.exceeded_notified_at === state.periodKey) return;
      this.ctx.atomic(() => {
        this.ctx.db.patch('entitlement_active', 'id', row.id, { exceeded_notified_at: state.periodKey });
        this.ctx.emit(orgId, 'entitlement.limit_exceeded', payload, { objectId: row.customer_id, objectType: 'customer' });
      });
      return;
    }
    if (row.approaching_notified_at !== state.periodKey) {
      this.ctx.atomic(() => {
        this.ctx.db.patch('entitlement_active', 'id', row.id, { approaching_notified_at: state.periodKey });
        this.ctx.emit(orgId, 'entitlement.limit_approaching', payload, { objectId: row.customer_id, objectType: 'customer' });
      });
    }
  }

  /** The plan a customer is on, read from the entitlements it already granted. */
  private currentPlanName(orgId: string, customerId: string): string | null {
    const row = this.ctx.db.get<{ source_product: string }>(
      `SELECT source_product, COUNT(*) AS n FROM entitlement_active
       WHERE org_id = ? AND customer_id = ? AND source_type = 'subscription' AND source_product IS NOT NULL
       GROUP BY source_product ORDER BY n DESC, source_product ASC LIMIT 1`,
      orgId, customerId,
    );
    return row ? this.productName(orgId, row.source_product) : null;
  }

  /* --------------------------------- reports ------------------------------- */

  /** Everyone at or over a feature's ceiling right now — the expansion list. */
  atLimit(orgId: string, featureKey: string, limit = 50): LimitPressure[] {
    const feature = this.requireFeature(orgId, featureKey);
    const now = this.ctx.now();
    const rows = this.ctx.db.all<ActiveRow>(
      `SELECT * FROM entitlement_active WHERE org_id = ? AND feature_key = ? AND unlimited = 0`, orgId, featureKey,
    );
    const out: LimitPressure[] = [];
    for (const row of rows) {
      const usage = this.usageFor(orgId, feature, row.customer_id, row, now);
      if (!usage || usage.limit === null) continue;
      if (usage.percent_used === null || usage.percent_used < feature.approaching_threshold_percent) continue;
      out.push({
        object: 'entitlement_pressure',
        customer: row.customer_id, feature: featureKey, value: row.value,
        used: usage.used, remaining: usage.remaining, percent_used: usage.percent_used,
      });
    }
    return out.sort((a, b) => (b.percent_used ?? 0) - (a.percent_used ?? 0)).slice(0, limit);
  }
}

/* -------------------------------- helpers ---------------------------------- */

function summaryOf(customerId: string, version: number, rows: ActiveEntitlement[], now: number): EntitlementSummary {
  const entitlements: EntitlementSummaryRow[] = rows.map((row) => ({
    id: row.id,
    feature: row.feature,
    feature_name: row.feature_name,
    type: row.type,
    unit_label: row.unit_label,
    value: row.value,
    unlimited: row.unlimited,
    source: row.source.type,
    expires_at: row.source.expires_at,
    period_end: row.period?.end ?? null,
  }));
  return { object: 'entitlement_summary', customer: customerId, version, entitlements, as_of: now };
}

/** Keep the better of two claims on the same feature. */
function offer(map: Map<string, Candidate>, key: string, candidate: Candidate): void {
  const existing = map.get(key);
  if (!existing) { map.set(key, candidate); return; }
  const reach = reachOf(candidate);
  const held = reachOf(existing);
  if (reach > held) { map.set(key, candidate); return; }
  if (reach === held && SOURCE_RANK[candidate.type] > SOURCE_RANK[existing.type]) map.set(key, candidate);
}

/**
 * When a subscription stops granting access.
 *
 * A subscription set to cancel at period end is still active today, and its
 * entitlements stay exactly as they are until the period actually ends — which
 * is the whole point of `cancel_at_period_end`. What changes is that we can now
 * say when they go.
 */
function endOfAccess(sub: Subscription): number | null {
  if (sub.cancel_at) return sub.cancel_at;
  if (sub.cancel_at_period_end) return sub.current_period_end;
  return null;
}

function hydrateFeature(row: FeatureRow): Feature {
  return {
    object: 'feature',
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    type: row.type,
    unit_label: row.unit_label,
    default_value: row.default_value,
    default_unlimited: !!row.default_unlimited,
    meter: row.meter_key,
    usage_window: row.usage_window,
    allowance_interval: row.allowance_interval,
    credit_backed: !!row.credit_backed,
    approaching_threshold_percent: row.approaching_threshold_percent,
    active: !!row.active,
    position: row.position,
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    created: row.created,
    updated: row.updated,
    livemode: !!row.livemode,
  };
}

function hydrateProductFeature(row: ProductFeatureRow, feature: Feature | null): ProductFeature {
  return {
    object: 'product_feature',
    id: row.id,
    product: row.product_id,
    product_name: null,
    feature: row.feature_key,
    feature_name: feature?.name ?? null,
    type: feature?.type ?? null,
    unit_label: feature?.unit_label ?? null,
    value: row.value,
    unlimited: !!row.unlimited,
    quantity_prices: parseJson<string[]>(row.quantity_prices, []),
    created: row.created,
    updated: row.updated,
  };
}

function hydrateOverride(row: OverrideRow, feature: Feature | null): EntitlementOverride {
  return {
    object: 'entitlement_override',
    id: row.id,
    customer: row.customer_id,
    feature: row.feature_key,
    feature_name: feature?.name ?? null,
    effect: row.effect,
    value: row.value,
    unlimited: !!row.unlimited,
    reason: row.reason,
    expires_at: row.expires_at,
    status: row.status,
    revoked_at: row.revoked_at,
    revoked_reason: row.revoked_reason,
    created_by: row.created_by,
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    created: row.created,
    updated: row.updated,
  };
}

function hydrateVersion(row: VersionRow): EntitlementVersion {
  return {
    object: 'entitlement_version',
    id: row.id,
    customer: row.customer_id,
    version: row.version,
    trigger: row.trigger,
    reason: row.reason,
    changes: parseJson<EntitlementChange[]>(row.changes, []),
    snapshot: parseJson<VersionSnapshotRow[]>(row.snapshot, []),
    actor_id: row.actor_id,
    actor_type: row.actor_type,
    created: row.created,
  };
}

/**
 * One store per `Ctx`. Every caller — the routes, the event handlers, the seed
 * — reaches the same instance, so the memos in it see every write.
 */
const stores = new WeakMap<Ctx, Entitlements>();
export function entitlementsStore(ctx: Ctx): Entitlements {
  let store = stores.get(ctx);
  if (!store) { store = new Entitlements(ctx); stores.set(ctx, store); }
  return store;
}
