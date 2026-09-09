import type { Migration } from '../../kernel/db';

/**
 * Products and prices are the one place in the platform where the *shape* of
 * money is defined. Prices are append-only in practice: once a subscription or
 * an invoice references one, its amounts are frozen so that any historical line
 * can be recomputed and re-explained exactly. Coupons are the same rule
 * pointed the other way: the price book's only subtraction, frozen the first
 * time it comes off a bill.
 */
export const CATALOG_MIGRATIONS: Migration[] = [
  {
    id: 'catalog.0001_products_and_prices',
    sql: `
CREATE TABLE catalog_products (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  statement_descriptor TEXT,
  unit_label TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  images TEXT NOT NULL DEFAULT '[]',
  features TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  tax_code TEXT,
  default_price_id TEXT,
  category TEXT NOT NULL DEFAULT 'plan',
  tagline TEXT,
  url TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_catalog_products_org ON catalog_products(org_id, position, created);
CREATE INDEX idx_catalog_products_category ON catalog_products(org_id, category, active);

CREATE TABLE catalog_prices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  nickname TEXT,
  lookup_key TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL DEFAULT 'recurring',
  model TEXT NOT NULL DEFAULT 'flat',
  currency TEXT NOT NULL,
  unit_amount INTEGER,
  unit_amount_decimal TEXT,
  billing_scheme TEXT NOT NULL DEFAULT 'per_unit',
  tiers_mode TEXT,
  tiers TEXT,
  transform_quantity TEXT,
  recurring TEXT,
  currency_options TEXT NOT NULL DEFAULT '{}',
  custom_unit_amount TEXT,
  tax_behavior TEXT NOT NULL DEFAULT 'unspecified',
  proration_behavior TEXT NOT NULL DEFAULT 'create_prorations',
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_catalog_prices_org ON catalog_prices(org_id, active, created DESC);
CREATE INDEX idx_catalog_prices_product ON catalog_prices(product_id, active);
CREATE UNIQUE INDEX idx_catalog_prices_lookup ON catalog_prices(org_id, lookup_key) WHERE lookup_key IS NOT NULL;

-- Modules that bill against a price register the reference here, which is what
-- makes "this price is in use, create a new one instead" an honest answer.
CREATE TABLE catalog_price_usage (
  org_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (org_id, price_id, ref_type, ref_id)
);
CREATE INDEX idx_catalog_price_usage_price ON catalog_price_usage(price_id);
`,
  },
  {
    id: 'catalog.0002_coupons_and_promotion_codes',
    sql: `
-- A coupon is the price book's only subtraction. Its economics are frozen once
-- it has been redeemed for the same reason a billed price is: an invoice from
-- last quarter has to keep explaining itself.
CREATE TABLE catalog_coupons (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT,
  -- Hundredths of a percent, so 20% is 2000 and 33.33% is 3333. An integer,
  -- because a percentage stored as a float rounds differently on two machines.
  percent_off_bps INTEGER,
  amount_off INTEGER,
  currency TEXT,
  duration TEXT NOT NULL DEFAULT 'once',
  duration_in_periods INTEGER,
  max_redemptions INTEGER,
  redeem_by INTEGER,
  applies_to_products TEXT NOT NULL DEFAULT '[]',
  applies_to_prices TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1,
  CHECK ((percent_off_bps IS NULL) <> (amount_off IS NULL))
);
CREATE INDEX idx_catalog_coupons_org ON catalog_coupons(org_id, active, created DESC);

CREATE TABLE catalog_promotion_codes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  coupon_id TEXT NOT NULL REFERENCES catalog_coupons(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  max_redemptions INTEGER,
  max_redemptions_per_customer INTEGER,
  minimum_amount INTEGER,
  minimum_amount_currency TEXT,
  first_time_transaction INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1
);
-- Codes are upper-cased on the way in, so this index is the whole uniqueness
-- rule: "spring20" and "SPRING20" are one code, not two that print the same.
CREATE UNIQUE INDEX idx_catalog_promotion_codes_code ON catalog_promotion_codes(org_id, code);
CREATE INDEX idx_catalog_promotion_codes_coupon ON catalog_promotion_codes(coupon_id, active);

-- One row per take-up. \`times_redeemed\` is counted from here rather than kept
-- in a column, so releasing a redemption when a subscription is undone gives
-- the count back instead of leaving a coupon exhausted by an order that never
-- happened. The id carries the reserved \`di_\` discount prefix: from the
-- catalogue's side this row is the discount.
CREATE TABLE catalog_coupon_redemptions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  coupon_id TEXT NOT NULL REFERENCES catalog_coupons(id) ON DELETE CASCADE,
  promotion_code_id TEXT,
  customer_id TEXT,
  ref_type TEXT,
  ref_id TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX idx_catalog_coupon_redemptions_coupon ON catalog_coupon_redemptions(org_id, coupon_id, created DESC);
CREATE INDEX idx_catalog_coupon_redemptions_code ON catalog_coupon_redemptions(org_id, promotion_code_id, customer_id);
-- A retried "attach this coupon to this subscription" must not spend a second
-- redemption, so the thing holding the discount can only hold it once.
CREATE UNIQUE INDEX idx_catalog_coupon_redemptions_ref
  ON catalog_coupon_redemptions(org_id, coupon_id, ref_type, ref_id) WHERE ref_type IS NOT NULL;
`,
  },
];
