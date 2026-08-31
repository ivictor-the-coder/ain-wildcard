/**
 * The entitlement object model.
 *
 * An entitlement answers one question — *can this customer do this right now,
 * and how much is left?* — and it has to answer it on a product's hot path,
 * thousands of times a minute, without ever disagreeing with the subscription
 * that grants it. Two rules follow from that and run through this whole module:
 *
 *  1. **Derived, then stored.** The active set is recomputed inside the same
 *     transaction as the subscription change that moved it, never lazily on
 *     read. A read is one indexed row lookup.
 *  2. **Counted, never accumulated.** A limit's *value* is stored; the *usage*
 *     against it never is. Consumption is read live from the meter and the
 *     credit ledger, because a counter maintained beside the events it counts
 *     is a counter that will eventually disagree with them.
 */
import type { IntervalUnit } from '../../../shared/time';

/**
 * - `boolean` the customer either has it or does not (SSO, benchmarking)
 * - `limit`   a ceiling on a standing quantity (seats, connected robots)
 * - `metered` a per-period allowance drawn down by real events (API calls)
 */
export const FEATURE_TYPES = ['boolean', 'limit', 'metered'] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];

/**
 * The window a metered allowance is measured over.
 *
 * `billing_period` follows the granting subscription's own cycle, sliced into
 * `allowance_interval` lengths from the cycle's own start — which is what makes
 * "5,000,000 events included each month" mean the same thing on an annual term
 * as on a monthly one, without misaligning a cycle that starts on the 17th the
 * way `calendar_month` would.
 */
export const USAGE_WINDOWS = ['billing_period', 'calendar_month', 'day', 'lifetime'] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

/** How often a `billing_period` allowance refills inside the cycle granting it. */
export const ALLOWANCE_INTERVALS = ['day', 'week', 'month', 'year'] as const;
export type AllowanceInterval = (typeof ALLOWANCE_INTERVALS)[number];

export const OVERRIDE_EFFECTS = ['grant', 'suspend'] as const;
export type OverrideEffect = (typeof OVERRIDE_EFFECTS)[number];

export const OVERRIDE_STATUSES = ['active', 'expired', 'revoked'] as const;
export type OverrideStatus = (typeof OVERRIDE_STATUSES)[number];

/** Where an active entitlement's value came from. */
export const ENTITLEMENT_SOURCES = ['subscription', 'override', 'feature_default'] as const;
export type EntitlementSourceType = (typeof ENTITLEMENT_SOURCES)[number];

/* --------------------------------- features -------------------------------- */

export interface Feature {
  object: 'feature';
  id: string;
  /** Stable key the product's code checks against. Immutable once created. */
  key: string;
  name: string;
  description: string | null;
  type: FeatureType;
  /** Singular noun for one unit — "seat", "robot", "event". */
  unit_label: string | null;
  /** What every customer gets with no product granting it. Null grants nothing. */
  default_value: number | null;
  default_unlimited: boolean;
  /**
   * Meter whose events are this feature's consumption, by meter id or by the
   * event name it listens for. Required for `metered`, optional for `limit` —
   * a limit with a meter reports live usage, one without reports only its cap.
   */
  meter: string | null;
  usage_window: UsageWindow;
  /**
   * How often the allowance refills inside the cycle that grants it. A plan
   * that says "5,000,000 events each month" includes five million a month
   * whether it is billed monthly or annually, so the annual term is measured
   * over twelve consecutive monthly windows rather than one yearly one. `null`
   * means the whole billing period is one window — the reading for an
   * allowance genuinely sold by the term. Refines `billing_period` only; the
   * other windows are already a fixed length.
   */
  allowance_interval: AllowanceInterval | null;
  /** Prepaid credit denominated in the meter's units raises the allowance. */
  credit_backed: boolean;
  /** Percent of the limit at which `entitlement.limit_approaching` fires. */
  approaching_threshold_percent: number;
  active: boolean;
  /** Ordering on the pricing page and in the customer's entitlement list. */
  position: number;
  metadata: Record<string, string>;
  created: number;
  updated: number;
  livemode: boolean;
}

export interface FeatureInput {
  id?: string;
  key: string;
  name: string;
  description?: string | null;
  type: FeatureType;
  unit_label?: string | null;
  default_value?: number | null;
  default_unlimited?: boolean;
  meter?: string | null;
  usage_window?: UsageWindow;
  allowance_interval?: AllowanceInterval | null;
  credit_backed?: boolean;
  approaching_threshold_percent?: number;
  active?: boolean;
  position?: number;
  metadata?: Record<string, string>;
}

export interface FeaturePatch {
  name?: string;
  description?: string | null;
  unit_label?: string | null;
  default_value?: number | null;
  default_unlimited?: boolean;
  meter?: string | null;
  usage_window?: UsageWindow;
  allowance_interval?: AllowanceInterval | null;
  credit_backed?: boolean;
  approaching_threshold_percent?: number;
  active?: boolean;
  position?: number;
  metadata?: Record<string, string>;
}

/* ----------------------------- product features ---------------------------- */

/**
 * What one product includes of one feature. This is the row that lets Growth
 * grant 25 seats where Scale grants 250 without either plan knowing about the
 * other, and it is keyed on the product rather than the price so an annual
 * term and a monthly term of the same plan can never drift apart.
 */
export interface ProductFeature {
  object: 'product_feature';
  id: string;
  product: string;
  product_name: string | null;
  feature: string;
  feature_name: string | null;
  type: FeatureType | null;
  unit_label: string | null;
  value: number | null;
  unlimited: boolean;
  /**
   * Prices whose subscription-item quantity *is* the entitled amount — the
   * per-seat component of a plan. The granted value is the plan's included
   * figure or the quantity actually bought, whichever is larger, so a Growth
   * account with 34 seats on the bill is entitled to 34 and not to 10.
   */
  quantity_prices: string[];
  created: number;
  updated: number;
}

export interface ProductFeatureInput {
  product: string;
  feature: string;
  value?: number | null;
  unlimited?: boolean;
  quantity_prices?: string[];
}

/* -------------------------------- overrides -------------------------------- */

/**
 * A per-customer grant or suspension with an expiry and a reason, so support
 * can hand out a temporary raise without touching the plan — and so the raise
 * takes itself away again when it is supposed to.
 */
export interface EntitlementOverride {
  object: 'entitlement_override';
  id: string;
  customer: string;
  feature: string;
  feature_name: string | null;
  effect: OverrideEffect;
  value: number | null;
  unlimited: boolean;
  /** Never optional. An override with no reason is an unexplained bill later. */
  reason: string;
  expires_at: number | null;
  status: OverrideStatus;
  revoked_at: number | null;
  revoked_reason: string | null;
  created_by: string | null;
  metadata: Record<string, string>;
  created: number;
  updated: number;
}

export interface OverrideInput {
  customer: string;
  feature: string;
  effect?: OverrideEffect;
  value?: number | null;
  unlimited?: boolean;
  reason: string;
  expires_at?: number | null;
  metadata?: Record<string, string>;
}

/* ---------------------------- active entitlements -------------------------- */

export interface EntitlementSource {
  type: EntitlementSourceType;
  subscription: string | null;
  subscription_item: string | null;
  product: string | null;
  product_name: string | null;
  price: string | null;
  override: string | null;
  /** One sentence naming what granted this, for the timeline and the UI. */
  description: string;
  /** When this source stops granting, if it is known to be temporary. */
  expires_at: number | null;
}

export interface ActiveEntitlement {
  object: 'active_entitlement';
  id: string;
  customer: string;
  feature: string;
  feature_name: string;
  description: string | null;
  type: FeatureType;
  unit_label: string | null;
  /** The ceiling, in the feature's units. Null when `unlimited`. */
  value: number | null;
  unlimited: boolean;
  source: EntitlementSource;
  /** The period a metered allowance is measured over right now. */
  period: { start: number; end: number } | null;
  /** Live consumption, present when the feature names a meter. */
  usage: EntitlementUsage | null;
  /** The version at which this row last changed. */
  version: number;
  granted_at: number;
  updated: number;
}

export interface EntitlementUsage {
  meter: string;
  meter_name: string;
  unit_label: string | null;
  used: number;
  /** Prepaid credit, in the same units, currently extending the allowance. */
  credit_units: number;
  /** The plan's own allowance, before credit. Null when unlimited. */
  included: number | null;
  /** `included` + `credit_units`. Null when unlimited. */
  limit: number | null;
  remaining: number | null;
  /** Whole percent of the limit consumed. Null when unlimited. */
  percent_used: number | null;
  as_of: number;
}

/* --------------------------------- checking -------------------------------- */

export interface UpgradePath {
  object: 'entitlement_upgrade';
  product: string;
  product_name: string;
  price: string;
  price_nickname: string | null;
  /** What that product grants of this feature. Null when it grants unlimited. */
  value: number | null;
  unlimited: boolean;
  /** The list amount for one of that price, in minor units of `currency`. */
  amount: number | null;
  currency: string;
  amount_formatted: string | null;
  interval: IntervalUnit | null;
  interval_count: number;
  /** A sentence naming the plan, the new ceiling and the price. */
  message: string;
}

export interface EntitlementCheck {
  object: 'entitlement_check';
  customer: string;
  feature: string;
  feature_name: string;
  type: FeatureType;
  unit_label: string | null;
  requested: number;
  allowed: boolean;
  /** The ceiling including prepaid credit. Null means unlimited. */
  limit: number | null;
  unlimited: boolean;
  /** The plan's own allowance, before credit. Null means unlimited. */
  included_limit: number | null;
  credit_units: number;
  used: number;
  remaining: number | null;
  /** True once consumption has passed the feature's warning threshold. */
  approaching: boolean;
  threshold_percent: number;
  /** A sentence a product can put in front of a user unedited. */
  reason: string;
  upgrade_path: UpgradePath | null;
  source: EntitlementSource | null;
  period: { start: number; end: number } | null;
  version: number;
  as_of: number;
  /** How long this answer took to compute, in microseconds. */
  latency_us: number;
}

export interface CheckInput {
  customer: string;
  feature: string;
  requested?: number;
}

/* ------------------------------- versioning -------------------------------- */

export const CHANGE_KINDS = ['granted', 'revoked', 'changed'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface EntitlementChange {
  kind: ChangeKind;
  feature: string;
  feature_name: string;
  type: FeatureType;
  unit_label: string | null;
  from: { value: number | null; unlimited: boolean; source: EntitlementSourceType } | null;
  to: { value: number | null; unlimited: boolean; source: EntitlementSourceType } | null;
  /** Plain English: "Connected robots raised from 75 to 400 by Telemetry Cloud Scale." */
  summary: string;
}

export interface EntitlementVersion {
  object: 'entitlement_version';
  id: string;
  customer: string;
  version: number;
  /** What moved: `subscription.updated`, `override.created`, `manual`… */
  trigger: string;
  reason: string;
  changes: EntitlementChange[];
  /** The full set as it stood at this version. */
  snapshot: VersionSnapshotRow[];
  actor_id: string | null;
  actor_type: string;
  created: number;
}

export interface VersionSnapshotRow {
  feature: string;
  value: number | null;
  unlimited: boolean;
  source: EntitlementSourceType;
  source_id: string | null;
}

/** One account pressing against a ceiling — a row of the expansion list. */
export interface LimitPressure {
  object: 'entitlement_pressure';
  customer: string;
  feature: string;
  value: number | null;
  used: number;
  remaining: number | null;
  percent_used: number | null;
}

export interface RecomputeResult {
  customer: string;
  version: number;
  changed: boolean;
  changes: EntitlementChange[];
  entitlements: ActiveEntitlement[];
}

/**
 * The whole answer for one customer in one payload.
 *
 * Delivered on `entitlement_summary.updated` every time the set moves, and
 * readable at any moment from the customer's own summary route — the same
 * shape both ways, so an edge cache can key on the version it was handed and
 * re-fetch exactly what it lost. It is emitted inside the transaction that
 * moved the set, so a summary that arrives is a summary that committed.
 */
export interface EntitlementSummary {
  object: 'entitlement_summary';
  customer: string;
  version: number;
  entitlements: EntitlementSummaryRow[];
  as_of: number;
}

export interface EntitlementSummaryRow {
  id: string;
  feature: string;
  feature_name: string;
  type: FeatureType;
  unit_label: string | null;
  value: number | null;
  unlimited: boolean;
  source: EntitlementSourceType;
  /** When this row stops granting, when that is already known. */
  expires_at: number | null;
  /** The cycle the value is granted over, when a subscription grants it. */
  period_end: number | null;
}

/** The whole answer for one customer, as the API returns it. */
export interface EntitlementSet {
  object: 'entitlement_set';
  customer: string;
  version: number;
  entitlements: ActiveEntitlement[];
  /** Overrides currently shaping the set, newest first. */
  overrides: EntitlementOverride[];
  /** Subscriptions the set was derived from. */
  sources: { subscription: string; status: string; products: string[]; period_end: number }[];
  as_of: number;
}
