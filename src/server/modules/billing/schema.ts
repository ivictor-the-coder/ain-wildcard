import type { Migration } from '../../kernel/db';

/**
 * Billing's tables.
 *
 * Six groups, and all but the first exist so that the money in this platform
 * can always explain itself without asking another module:
 *
 *  - `billing_invoices` / `billing_invoice_lines` are the bill itself. Every
 *    line carries the period it covers and the explanation behind its number,
 *    and the invariant the whole module is built to hold is written into the
 *    row: `sum(lines.amount) = subtotal` and `subtotal + balance_applied =
 *    total`.
 *  - `billing_pending_items` holds proration lines between the moment they are
 *    computed and the moment an invoice sweeps them up. It is the handoff
 *    contract with the invoicing module: read rows with `status = 'pending'`
 *    for a customer, stamp `invoice_id` and `status = 'invoiced'` on them.
 *  - `billing_balance_transactions` makes `customers.balance` a ledger rather
 *    than a number — every credit and debit says where it came from.
 *  - `billing_subscription_periods` records every period a subscription has
 *    actually entered, with the recurring amount recognised for it, so revenue
 *    reporting has real movement to chart even before an invoice exists.
 *  - `billing_tax_rates` is the registry an address is matched against, and the
 *    rate that matched is snapshotted onto every line it touched so an old
 *    invoice still explains itself after the rate is retired.
 *  - `billing_credit_notes` / `billing_credit_note_lines` are the only legal
 *    way to reduce a finalised invoice. A note names the invoice and the lines
 *    it corrects, which is what makes a reduction a document rather than an
 *    unexplained movement on somebody's balance.
 */
export const BILLING_MIGRATIONS: Migration[] = [
  {
    id: 'billing.0001_customers_and_subscriptions',
    sql: `
CREATE TABLE billing_customers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  description TEXT,
  phone TEXT,
  currency TEXT NOT NULL,
  currency_locked INTEGER NOT NULL DEFAULT 0,
  address TEXT,
  shipping TEXT,
  tax_ids TEXT NOT NULL DEFAULT '[]',
  invoice_settings TEXT NOT NULL DEFAULT '{}',
  balance INTEGER NOT NULL DEFAULT 0,
  delinquent INTEGER NOT NULL DEFAULT 0,
  preferred_locales TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  crm_record_id TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_billing_customers_org ON billing_customers(org_id, created DESC);
CREATE INDEX idx_billing_customers_email ON billing_customers(org_id, email);
CREATE INDEX idx_billing_customers_crm ON billing_customers(org_id, crm_record_id);

CREATE TABLE billing_subscriptions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES billing_customers(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  interval TEXT NOT NULL,
  interval_count INTEGER NOT NULL DEFAULT 1,
  billing_cycle_anchor INTEGER NOT NULL,
  billing_cycle_anchor_day INTEGER NOT NULL,
  current_period_start INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  start_date INTEGER NOT NULL,
  ended_at INTEGER,
  canceled_at INTEGER,
  cancel_at INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  cancellation_reason TEXT,
  cancellation_comment TEXT,
  trial_start INTEGER,
  trial_end INTEGER,
  trial_from_plan INTEGER NOT NULL DEFAULT 0,
  trial_settings TEXT NOT NULL DEFAULT '{}',
  collection_method TEXT NOT NULL DEFAULT 'charge_automatically',
  days_until_due INTEGER,
  default_payment_method TEXT,
  pause_collection TEXT,
  proration_behavior TEXT NOT NULL DEFAULT 'create_prorations',
  schedule_id TEXT,
  description TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_billing_subs_org ON billing_subscriptions(org_id, created DESC);
CREATE INDEX idx_billing_subs_customer ON billing_subscriptions(org_id, customer_id, status);
CREATE INDEX idx_billing_subs_status ON billing_subscriptions(org_id, status, current_period_end);

CREATE TABLE billing_subscription_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES billing_subscriptions(id) ON DELETE CASCADE,
  price_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  metered INTEGER NOT NULL DEFAULT 0,
  -- The negotiated amount for a custom-model price, in minor units. An
  -- enterprise contract is a real price with an agreed number, not a special case.
  custom_unit_amount INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_billing_items_sub ON billing_subscription_items(subscription_id, position);
CREATE INDEX idx_billing_items_price ON billing_subscription_items(org_id, price_id);

CREATE TABLE billing_subscription_schedules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES billing_customers(id) ON DELETE CASCADE,
  subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'not_started',
  phases TEXT NOT NULL DEFAULT '[]',
  current_phase INTEGER,
  end_behavior TEXT NOT NULL DEFAULT 'release',
  released_at INTEGER,
  canceled_at INTEGER,
  completed_at INTEGER,
  start_date INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_billing_schedules_org ON billing_subscription_schedules(org_id, status, start_date);
CREATE INDEX idx_billing_schedules_sub ON billing_subscription_schedules(org_id, subscription_id);

-- Proration lines waiting for an invoice. The invoicing module drains these.
CREATE TABLE billing_pending_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  subscription_id TEXT,
  subscription_item_id TEXT,
  price_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  description TEXT NOT NULL,
  explanation TEXT NOT NULL,
  kind TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  proration_numerator INTEGER NOT NULL,
  proration_denominator INTEGER NOT NULL,
  proration_date INTEGER NOT NULL,
  breakdown TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  invoice_id TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX idx_billing_pending_customer ON billing_pending_items(org_id, customer_id, status);
CREATE INDEX idx_billing_pending_sub ON billing_pending_items(org_id, subscription_id, created);

CREATE TABLE billing_balance_transactions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES billing_customers(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  ending_balance INTEGER NOT NULL,
  currency TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  subscription_id TEXT,
  invoice_id TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX idx_billing_balance_customer ON billing_balance_transactions(org_id, customer_id, created DESC);

CREATE TABLE billing_subscription_periods (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'billed',
  invoice_id TEXT,
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_billing_periods_unique ON billing_subscription_periods(subscription_id, period_start);
CREATE INDEX idx_billing_periods_org ON billing_subscription_periods(org_id, period_start);
CREATE INDEX idx_billing_periods_customer ON billing_subscription_periods(org_id, customer_id, period_start);
`,
  },
  {
    id: 'billing.0002_invoices',
    sql: `
CREATE TABLE billing_invoices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  number TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES billing_customers(id) ON DELETE CASCADE,
  subscription_id TEXT,
  status TEXT NOT NULL,
  billing_reason TEXT NOT NULL,
  currency TEXT NOT NULL,
  collection_method TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  -- The window whose metered usage this invoice settles, when there is one.
  arrears_period_start INTEGER,
  arrears_period_end INTEGER,
  subtotal INTEGER NOT NULL,
  -- Signed: negative is credit drawn down, positive is a debit carried onto
  -- this invoice. subtotal + balance_applied = total, always.
  balance_applied INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  amount_due INTEGER NOT NULL,
  starting_balance INTEGER NOT NULL DEFAULT 0,
  ending_balance INTEGER NOT NULL DEFAULT 0,
  due_date INTEGER,
  finalized_at INTEGER,
  paid_at INTEGER,
  voided_at INTEGER,
  marked_uncollectible_at INTEGER,
  payment_note TEXT,
  footer TEXT,
  description TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_billing_invoices_number ON billing_invoices(org_id, number);
CREATE INDEX idx_billing_invoices_org ON billing_invoices(org_id, created DESC);
CREATE INDEX idx_billing_invoices_customer ON billing_invoices(org_id, customer_id, created DESC);
CREATE INDEX idx_billing_invoices_sub ON billing_invoices(org_id, subscription_id, period_start);
CREATE INDEX idx_billing_invoices_status ON billing_invoices(org_id, status, due_date);

CREATE TABLE billing_invoice_lines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
  subscription_id TEXT,
  subscription_item_id TEXT,
  -- Where the line came from, so a claimed line can never be claimed twice.
  source_type TEXT NOT NULL,
  source_id TEXT,
  price_id TEXT,
  kind TEXT NOT NULL,
  proration INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  explanation TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  proration_numerator INTEGER,
  proration_denominator INTEGER,
  breakdown TEXT NOT NULL DEFAULT '[]',
  -- Set when the invoice is voided: the line stays on the document as the
  -- record of what was withdrawn, but its hold on the source row is let go so
  -- a replacement invoice can claim it properly.
  released INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE INDEX idx_billing_invoice_lines_invoice ON billing_invoice_lines(invoice_id, position);
CREATE INDEX idx_billing_invoice_lines_sub ON billing_invoice_lines(org_id, subscription_id, period_start);
-- One live line per claimed row: the database, not a convention, is what stops
-- the same proration or usage line being billed on two invoices.
CREATE UNIQUE INDEX idx_billing_invoice_lines_source ON billing_invoice_lines(org_id, source_type, source_id)
  WHERE source_id IS NOT NULL AND released = 0;
`,
  },
  {
    id: 'billing.0003_tax',
    sql: `
CREATE TABLE billing_tax_rates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  jurisdiction TEXT NOT NULL,
  -- ISO-3166-1 alpha-2, uppercase. An address is matched on this, never on the
  -- free text a customer typed into their country field.
  country TEXT NOT NULL,
  state TEXT,
  tax_type TEXT NOT NULL DEFAULT 'vat',
  -- An exact decimal string: "19", "8.875". Never a float, and never a number
  -- that has been through one.
  percentage TEXT NOT NULL,
  -- True when a registered business in this jurisdiction accounts for the tax
  -- itself, so the supply is charged at zero and says so on the bill.
  reverse_charge INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_billing_tax_rates_org ON billing_tax_rates(org_id, country, active);

-- Stripe's three states: none, exempt (a certificate is on file), reverse (the
-- customer accounts for the tax whatever their registration says).
ALTER TABLE billing_customers ADD COLUMN tax_exempt TEXT NOT NULL DEFAULT 'none';

ALTER TABLE billing_invoices ADD COLUMN tax INTEGER NOT NULL DEFAULT 0;

-- The rate is snapshotted onto the line, not referenced by it. An invoice is a
-- historical document: the rate it was raised under may since have changed or
-- been retired, and the line still has to explain its own number years later.
ALTER TABLE billing_invoice_lines ADD COLUMN tax_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_invoice_lines ADD COLUMN tax_rate TEXT;
ALTER TABLE billing_invoice_lines ADD COLUMN tax_percentage TEXT;
ALTER TABLE billing_invoice_lines ADD COLUMN tax_display_name TEXT;
ALTER TABLE billing_invoice_lines ADD COLUMN tax_jurisdiction TEXT;
ALTER TABLE billing_invoice_lines ADD COLUMN tax_type TEXT;
ALTER TABLE billing_invoice_lines ADD COLUMN tax_behavior TEXT;
ALTER TABLE billing_invoice_lines ADD COLUMN tax_reason TEXT;
ALTER TABLE billing_invoice_lines ADD COLUMN tax_explanation TEXT;
`,
  },
  {
    id: 'billing.0004_credit_notes',
    sql: `
-- The only legal way to reduce a finalised invoice. A credit note names the
-- invoice it corrects and the lines it corrects, so a reduction is a document
-- with an audit trail rather than an untraceable adjustment to a balance.
CREATE TABLE billing_credit_notes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  number TEXT NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES billing_customers(id) ON DELETE CASCADE,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  memo TEXT,
  subtotal INTEGER NOT NULL,
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  -- Exactly one of these carries the total, and which one is decided by whether
  -- the money had already been collected: an unpaid bill is reduced, a paid one
  -- is refunded onto the account balance.
  pre_payment_amount INTEGER NOT NULL DEFAULT 0,
  post_payment_amount INTEGER NOT NULL DEFAULT 0,
  balance_transaction_id TEXT,
  invoice_status_at_issue TEXT NOT NULL,
  voided_at INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_billing_credit_notes_number ON billing_credit_notes(org_id, number);
CREATE INDEX idx_billing_credit_notes_invoice ON billing_credit_notes(org_id, invoice_id, created);
CREATE INDEX idx_billing_credit_notes_customer ON billing_credit_notes(org_id, customer_id, created DESC);

CREATE TABLE billing_credit_note_lines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  credit_note_id TEXT NOT NULL REFERENCES billing_credit_notes(id) ON DELETE CASCADE,
  -- Every credit line points at the invoice line it reduces. Nothing may be
  -- credited that was not billed.
  invoice_line_id TEXT NOT NULL,
  description TEXT NOT NULL,
  explanation TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  amount INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  tax_rate TEXT,
  tax_percentage TEXT,
  tax_display_name TEXT,
  tax_behavior TEXT,
  tax_reason TEXT,
  currency TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE INDEX idx_billing_credit_note_lines_note ON billing_credit_note_lines(credit_note_id, position);
CREATE INDEX idx_billing_credit_note_lines_source ON billing_credit_note_lines(org_id, invoice_line_id);

ALTER TABLE billing_invoices ADD COLUMN pre_payment_credit_notes_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_invoices ADD COLUMN post_payment_credit_notes_amount INTEGER NOT NULL DEFAULT 0;
`,
  },
];
