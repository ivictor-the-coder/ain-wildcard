import type { Migration } from '../../kernel/db';

/**
 * Credits are a ledger, not a balance.
 *
 * There is deliberately no balance column anywhere in this schema. A grant's
 * balance is the sum of its ledger entries and nothing else, so it cannot drift
 * out of step with the entries that explain it. Every entry also carries the
 * running balance as it stood after that entry, which is what turns the ledger
 * into something a finance team can read down a column and check.
 *
 * Amounts are integer micro-units of the grant's denomination: micro-minor-units
 * for a monetary grant (1 cent = 1,000,000) and micro-units for a unit grant
 * (1 telemetry event = 1,000,000), so one arithmetic path serves both.
 */
export const CREDITS_MIGRATIONS: Migration[] = [
  {
    id: 'credits.0001_grants_and_ledger',
    sql: `
CREATE TABLE credit_grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'paid',
  kind TEXT NOT NULL DEFAULT 'monetary',
  currency TEXT NOT NULL,
  meter_id TEXT,
  unit_label TEXT,
  amount_micro INTEGER NOT NULL,
  applicability TEXT NOT NULL DEFAULT '{"scope":"all","prices":[],"meters":[],"products":[]}',
  effective_at INTEGER NOT NULL,
  expires_at INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  rollover TEXT NOT NULL DEFAULT 'none',
  rollover_cap_micro INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_credit_grants_customer ON credit_grants(org_id, customer_id, expires_at);
CREATE INDEX idx_credit_grants_expiry ON credit_grants(org_id, expires_at);
CREATE INDEX idx_credit_grants_source ON credit_grants(org_id, source, source_ref);

-- Append-only. Nothing in this table is ever updated or deleted; a mistake is
-- corrected by writing the entry that reverses it.
CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES credit_grants(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  delta_micro INTEGER NOT NULL,
  balance_after_micro INTEGER NOT NULL,
  currency TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  period_start INTEGER,
  period_end INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_credit_ledger_seq ON credit_ledger(org_id, grant_id, seq);
CREATE INDEX idx_credit_ledger_grant ON credit_ledger(org_id, grant_id, seq);
CREATE INDEX idx_credit_ledger_customer ON credit_ledger(org_id, customer_id, created DESC);
CREATE INDEX idx_credit_ledger_ref ON credit_ledger(org_id, ref_type, ref_id);

-- One period of one metered price, priced once and settled once. The unique
-- key is what stops a retried close from burning a customer's credits twice.
CREATE TABLE credit_settlements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  meter_id TEXT,
  price_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  quantity_micro INTEGER NOT NULL,
  billed_quantity INTEGER NOT NULL,
  covered_quantity_micro INTEGER NOT NULL,
  charged_quantity INTEGER NOT NULL,
  full_amount INTEGER NOT NULL,
  covered_amount INTEGER NOT NULL,
  charged_amount INTEGER NOT NULL,
  unit_credit_amount INTEGER NOT NULL DEFAULT 0,
  monetary_credit_amount INTEGER NOT NULL DEFAULT 0,
  idem_key TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_credit_settlements_key ON credit_settlements(org_id, idem_key);
CREATE INDEX idx_credit_settlements_customer ON credit_settlements(org_id, customer_id, period_end DESC);

-- Everything credits contribute to an invoice: the purchase line for a top-up,
-- and the credit-covered and charged halves of a settled usage period. Billing
-- drains this outbox onto invoices; until it does, the rows read as pending, so
-- a grant and the line that paid for it are never out of step.
CREATE TABLE credit_billable_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  settlement_id TEXT,
  grant_id TEXT,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL,
  billed_amount INTEGER NOT NULL,
  credit_applied INTEGER NOT NULL DEFAULT 0,
  quantity_micro INTEGER NOT NULL DEFAULT 0,
  unit_label TEXT,
  price_id TEXT,
  meter_id TEXT,
  period_start INTEGER,
  period_end INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  invoice_id TEXT,
  invoice_item_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_credit_billable_pending ON credit_billable_items(org_id, status, created);
CREATE INDEX idx_credit_billable_customer ON credit_billable_items(org_id, customer_id, created DESC);
CREATE INDEX idx_credit_billable_settlement ON credit_billable_items(org_id, settlement_id);
`,
  },
  {
    /**
     * The period is the identity, not the caller's string.
     *
     * `idem_key` was the only thing standing between a retried settlement and a
     * second draw on the customer's balance — which meant a boundary that moved
     * by a millisecond, or a retry that generated a fresh key, spent the money
     * twice for the same usage. The database now refuses that outright: one
     * settlement per customer, price and window, enforced where it cannot be
     * argued with. `idem_key` stays as the caller-facing guard it always was.
     */
    id: 'credits.0002_settlement_period_identity',
    sql: `
CREATE UNIQUE INDEX idx_credit_settlements_period
  ON credit_settlements(org_id, customer_id, price_id, period_start, period_end);
CREATE INDEX idx_credit_settlements_overlap
  ON credit_settlements(org_id, customer_id, price_id, period_start);
`,
  },
  {
    /**
     * A refusal is an answer, and an answer belongs in a table.
     *
     * When two subscription items on one customer bill the same meter on
     * offset anchors, the second window overlaps the first and settling it
     * would draw credit twice for usage already billed. Refusing that is
     * correct. Refusing it into the event log and marking the job `done` is
     * not: the period disappears, no route lists it, and no count moves.
     *
     * So a refusal is now a settlement row of its own, carrying zero money,
     * the settlement that superseded it, and how much of the window that
     * settlement actually covers — which is the difference between "billed
     * elsewhere, nothing lost" and "$5,017,494 of telemetry nobody invoiced".
     */
    id: 'credits.0003_settlement_outcome',
    sql: `
ALTER TABLE credit_settlements ADD COLUMN status TEXT NOT NULL DEFAULT 'settled';
ALTER TABLE credit_settlements ADD COLUMN superseded_by TEXT;
ALTER TABLE credit_settlements ADD COLUMN skip_reason TEXT;
ALTER TABLE credit_settlements ADD COLUMN skip_detail TEXT;
ALTER TABLE credit_settlements ADD COLUMN subscription_id TEXT;
ALTER TABLE credit_settlements ADD COLUMN subscription_item_id TEXT;
CREATE INDEX idx_credit_settlements_status ON credit_settlements(org_id, status, created DESC);
`,
  },
  {
    /**
     * The tier ladder belongs to the billing period, not to the window.
     *
     * A graduated price gives the first N units away once per billing period.
     * Pricing each settlement window from zero handed that allowance out again
     * every time a period was billed in more than one piece — a plan change
     * mid-cycle, a cancel and restart, or the platform's own remedy for an
     * unbilled gap — so 1,800 units cost 8,000 as one window and nothing at all
     * as two. A window is now priced marginally: the units earlier windows of
     * the same cycle already consumed are the rung it starts from.
     *
     * These columns are that rung, kept with the settlement rather than
     * recomputed on read, because the settlements around it can change and the
     * money on the invoice cannot.
     */
    id: 'credits.0004_marginal_tier_basis',
    sql: `
ALTER TABLE credit_settlements ADD COLUMN prior_quantity_micro INTEGER NOT NULL DEFAULT 0;
ALTER TABLE credit_settlements ADD COLUMN prior_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE credit_settlements ADD COLUMN cycle_start INTEGER;
ALTER TABLE credit_settlements ADD COLUMN cycle_end INTEGER;
ALTER TABLE credit_settlements ADD COLUMN cycle_source TEXT;
ALTER TABLE credit_settlements ADD COLUMN basis_settlements TEXT;
CREATE INDEX idx_credit_settlements_cycle
  ON credit_settlements(org_id, customer_id, price_id, status, period_start, period_end);
`,
  },
];
