import type { Migration } from '../../kernel/db';

/**
 * Five tables, and only one of them is on the hot path.
 *
 * `entitlement_active` is the answer, precomputed: one row per customer per
 * feature, reachable by a unique index in a single lookup. Everything else —
 * the catalogue of features, what each product includes, the support overrides
 * and the version history — is input to the recompute that writes it, and is
 * never read while a product waits on a `check`.
 *
 * There is deliberately no usage column anywhere in this schema. Consumption is
 * read from the meter and the credit ledger at check time; a copy of it here
 * would be a number that can drift from the events that justify it.
 */
export const ENTITLEMENTS_MIGRATIONS: Migration[] = [
  {
    id: 'entitlements.0001_init',
    sql: `
CREATE TABLE entitlement_features (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  unit_label TEXT,
  default_value INTEGER,
  default_unlimited INTEGER NOT NULL DEFAULT 0,
  meter_key TEXT,
  usage_window TEXT NOT NULL DEFAULT 'billing_period',
  credit_backed INTEGER NOT NULL DEFAULT 0,
  approaching_threshold_percent INTEGER NOT NULL DEFAULT 80,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_entitlement_features_key ON entitlement_features(org_id, key);
CREATE INDEX idx_entitlement_features_meter ON entitlement_features(org_id, meter_key);

-- What one product includes of one feature. Keyed on the product, so the
-- monthly and annual prices of a plan can never grant different things.
CREATE TABLE entitlement_product_features (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  value INTEGER,
  unlimited INTEGER NOT NULL DEFAULT 0,
  quantity_prices TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_entitlement_product_features ON entitlement_product_features(org_id, product_id, feature_key);
CREATE INDEX idx_entitlement_product_features_feature ON entitlement_product_features(org_id, feature_key);

CREATE TABLE entitlement_overrides (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  effect TEXT NOT NULL,
  value INTEGER,
  unlimited INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  revoked_at INTEGER,
  revoked_reason TEXT,
  created_by TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_entitlement_overrides_customer ON entitlement_overrides(org_id, customer_id, status);
CREATE INDEX idx_entitlement_overrides_expiry ON entitlement_overrides(org_id, status, expires_at);
CREATE INDEX idx_entitlement_overrides_feature ON entitlement_overrides(org_id, feature_key, status);

-- The hot path. One row per (customer, feature); a check is one index seek.
CREATE TABLE entitlement_active (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  type TEXT NOT NULL,
  value INTEGER,
  unlimited INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL,
  source_subscription TEXT,
  source_subscription_item TEXT,
  source_product TEXT,
  source_price TEXT,
  source_override TEXT,
  source_expires_at INTEGER,
  -- The granting subscription's currency, so pricing an upgrade path never
  -- costs a second lookup on the hot path.
  currency TEXT NOT NULL DEFAULT 'usd',
  -- The granting subscription's current cycle, copied here so a metered check
  -- never has to ask billing which period it is in.
  period_start INTEGER,
  period_end INTEGER,
  version INTEGER NOT NULL,
  granted_at INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  -- The period start each warning was last raised for, so the automation layer
  -- hears about a breach once per period instead of on every single check.
  approaching_notified_at INTEGER,
  exceeded_notified_at INTEGER
);
CREATE UNIQUE INDEX idx_entitlement_active_key ON entitlement_active(org_id, customer_id, feature_key);
CREATE INDEX idx_entitlement_active_feature ON entitlement_active(org_id, feature_key);
CREATE INDEX idx_entitlement_active_subscription ON entitlement_active(org_id, source_subscription);

-- Every recompute that changed something, with the diff that explains it.
CREATE TABLE entitlement_versions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  reason TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '[]',
  snapshot TEXT NOT NULL DEFAULT '[]',
  actor_id TEXT,
  actor_type TEXT NOT NULL DEFAULT 'system',
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_entitlement_versions_seq ON entitlement_versions(org_id, customer_id, version);
CREATE INDEX idx_entitlement_versions_customer ON entitlement_versions(org_id, customer_id, created DESC);
`,
  },
  {
    /**
     * How often a `billing_period` allowance refills inside the cycle granting
     * it. Without it the cycle *is* the window, so the annual term of a plan
     * advertising "5,000,000 events included each month" delivered five million
     * for the year — a twelfth of what was sold, to the customers who paid up
     * front. Every feature already in the book means "each month", which is
     * what the backfill says; `NULL` is left to mean "once per term", the
     * reading an allowance genuinely sold by the term needs.
     */
    id: 'entitlements.0002_allowance_interval',
    sql: `
ALTER TABLE entitlement_features ADD COLUMN allowance_interval TEXT;
UPDATE entitlement_features SET allowance_interval = 'month';
`,
  },
];
