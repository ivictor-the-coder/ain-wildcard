/**
 * The wire shapes the settings surface reads, transcribed from the routes that
 * serve them. Nothing here is invented: every field below is one the server
 * actually sends, so a screen that renders a property it has not been given is
 * a type error rather than an empty cell.
 */

export type Role = 'owner' | 'admin' | 'member' | 'analyst' | 'readonly';

export interface Member {
  object: 'user';
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  title: string | null;
  created: number;
  last_seen: number | null;
  role: Role;
  teams: string[];
}

export interface ApiKey {
  object: 'api_key';
  id: string;
  name: string;
  prefix: string;
  last4: string;
  scopes: string[];
  livemode: boolean;
  created: number;
  last_used: number | null;
  revoked_at: number | null;
  /** `sk_test_••••••••••••••••••••0001` — the only form the list ever holds. */
  masked: string;
}

/** `POST /v1/api-keys` is the one and only answer that carries the secret. */
export interface MintedApiKey extends ApiKey {
  secret: string;
}

export interface AuditEntry {
  id: string;
  org_id: string;
  actor_id: string | null;
  actor_type: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  request_id: string | null;
  ip: string | null;
  created: number;
}

export interface PlatformEvent {
  id: string;
  type: string;
  org_id: string;
  object_id: string | null;
  object_type: string | null;
  actor_id: string | null;
  actor_type: string;
  request_id: string | null;
  created: number;
  data: unknown;
  previous: unknown;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRow {
  id: string;
  org_id: string;
  type: string;
  payload: Record<string, unknown>;
  run_at: number;
  attempts: number;
  max_attempts: number;
  status: JobStatus;
  last_error: string | null;
  idem_key: string | null;
  created: number;
  updated: number;
}

export interface JobDrainResult {
  object: 'job_drain';
  ran: number;
  failed: number;
  pending: number;
}

export interface ClockResult {
  object: 'clock';
  now: number;
  previous?: number;
  offset_ms: number;
  jobs_run?: number;
  jobs_failed?: number;
}

export interface TaxRate {
  object: 'tax_rate';
  id: string;
  display_name: string;
  description: string | null;
  jurisdiction: string;
  country: string;
  state: string | null;
  tax_type: string | null;
  /** An exact decimal string — never parsed to a float before it is shown. */
  percentage: string;
  reverse_charge: boolean;
  active: boolean;
  metadata: Record<string, string>;
  created: number;
  updated: number;
  percentage_display: string;
  applies_to: string;
  detail: string;
}

export interface AutomaticTaxSettings {
  object: 'automatic_tax_settings';
  enabled: boolean;
  invoices_missing_a_tax_location: number;
  invoices_held_in_draft: number;
  detail: string;
}

export interface TaxIdVerification {
  status: 'pending' | 'verified' | 'unverified' | 'unavailable';
  verified_name: string | null;
  verified_address: string | null;
  checked_at: number | null;
  note: string | null;
}

export interface CustomerTaxId {
  type: string;
  value: string;
  country?: string | null;
  verification?: TaxIdVerification | null;
}

export interface CustomerLite {
  object: 'customer';
  id: string;
  name: string;
  email: string | null;
  currency: string;
  tax_ids: CustomerTaxId[];
  tax_exempt: string;
  address: { country?: string | null; state?: string | null } | null;
}

export type FeatureType = 'boolean' | 'limit' | 'metered';

export interface Feature {
  object: 'feature';
  id: string;
  key: string;
  name: string;
  description: string | null;
  type: FeatureType;
  unit_label: string | null;
  default_value: number | null;
  default_unlimited: boolean;
  meter: string | null;
  usage_window: 'billing_period' | 'calendar_month' | 'day' | 'lifetime';
  allowance_interval: 'day' | 'week' | 'month' | 'year' | null;
  credit_backed: boolean;
  approaching_threshold_percent: number;
  active: boolean;
  position: number;
  metadata: Record<string, string>;
  created: number;
  updated: number;
  livemode: boolean;
  /** Present with `?expand=products`. */
  products?: ProductFeature[];
}

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
  quantity_prices: string[];
  created: number;
  updated: number;
}

export interface EntitlementOverride {
  object: 'entitlement_override';
  id: string;
  customer: string;
  feature: string;
  feature_name: string | null;
  effect: 'grant' | 'suspend';
  value: number | null;
  unlimited: boolean;
  reason: string;
  expires_at: number | null;
  status: 'active' | 'expired' | 'revoked';
  revoked_at: number | null;
  revoked_reason: string | null;
  created_by: string | null;
  metadata: Record<string, string>;
  created: number;
  updated: number;
}

export interface EntitlementUsage {
  meter: string;
  meter_name: string;
  unit_label: string | null;
  used: number;
  credit_units: number;
  included: number | null;
  limit: number | null;
  remaining: number | null;
  percent_used: number | null;
  as_of: number;
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
  value: number | null;
  unlimited: boolean;
  source: {
    type: 'subscription' | 'override' | 'feature_default';
    subscription: string | null;
    subscription_item: string | null;
    product: string | null;
    product_name: string | null;
    price: string | null;
    override: string | null;
    description: string;
    expires_at: number | null;
  };
  period: { start: number; end: number } | null;
  usage: EntitlementUsage | null;
  version: number;
  granted_at: number;
  updated: number;
}

export interface EntitlementSet {
  object: 'entitlement_set';
  customer: string;
  version: number;
  entitlements: ActiveEntitlement[];
}

export interface EntitlementPressure {
  object: 'entitlement_pressure';
  customer: string;
  feature: string;
  value: number | null;
  used: number;
  remaining: number | null;
  percent_used: number | null;
}

export interface EntitlementsOverview {
  object: 'entitlements_overview';
  features: {
    feature: string;
    name: string;
    type: FeatureType;
    unit_label: string | null;
    granted_by: number;
    accounts: number;
    unlimited_accounts: number;
    at_risk: EntitlementPressure[];
  }[];
  overrides_live: number;
  as_of: number;
}

export interface Health {
  object: 'health';
  status: string;
  version: string;
  time: number;
  clock: { kind: string; offset_ms: number };
  modules: number;
  routes: number;
  jobs: { pending: number; running: number; failed: number; done: number; nextRunAt: number | null };
  ai: { provider: string; tools: number };
}
