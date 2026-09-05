import type { Migration } from '../../kernel/db';

/**
 * Products and prices are the one place in the platform where the *shape* of
 * money is defined. Prices are append-only in practice: once a subscription or
 * an invoice references one, its amounts are frozen so that any historical line
 * can be recomputed and re-explained exactly.
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
];
