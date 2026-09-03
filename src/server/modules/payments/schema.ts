import type { Migration } from '../../kernel/db';

/**
 * Payments' tables.
 *
 * Six of them, and the split is the same one a real processor makes:
 *
 *  - `payments_methods` is what a customer can be charged with. It holds a
 *    brand, an expiry and four digits — never anything resembling a card
 *    number — plus the one column that makes this platform testable end to
 *    end: `simulated_behavior`, the declared outcome the simulated processor
 *    will produce for it. A partial unique index makes "one default method per
 *    customer" the database's rule rather than a convention.
 *  - `payments_intents` is the state machine. A charge attempt is not a boolean;
 *    it moves through `requires_confirmation`, `requires_action`, `processing`
 *    and only then to `succeeded`, and a failure sends it back to
 *    `requires_payment_method` exactly as the real one does.
 *  - `payments_charges` is the money movement and, just as importantly, the
 *    `outcome_*` columns: why the issuer decided what it decided, in words a
 *    support agent can paste into a reply.
 *  - `payments_refunds` and `payments_disputes` are the two ways money goes
 *    back, one voluntary and one not.
 *  - `payments_dunning` / `payments_dunning_attempts` are the recovery story.
 *    Every attempt — including the ones that were never made, because the
 *    decline said not to bother — is a row, so "why did we stop chasing this
 *    invoice?" is answered from the table instead of from a log file.
 */
export const PAYMENTS_MIGRATIONS: Migration[] = [
  {
    id: 'payments.0001_methods_intents_and_dunning',
    sql: `
CREATE TABLE payments_methods (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  -- Null once detached: the method stays for the charges that point at it.
  customer_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'attached',
  is_default INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL,
  brand TEXT,
  last4 TEXT NOT NULL,
  exp_month INTEGER,
  exp_year INTEGER,
  funding TEXT,
  country TEXT,
  bank_name TEXT,
  account_type TEXT,
  mandate_reference TEXT,
  -- The declared outcome of the simulated processor. This platform has no
  -- acquirer behind it and does not pretend to: the behaviour is stated on the
  -- method so any decline can be reproduced deliberately.
  simulated_behavior TEXT NOT NULL DEFAULT 'succeeds',
  -- How many attempts decline before the behaviour gives way to a success.
  -- Null means "every attempt", which is what a dead card really does.
  simulated_decline_count INTEGER,
  billing_name TEXT,
  billing_email TEXT,
  fingerprint TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  detached_at INTEGER,
  livemode INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_payments_methods_customer ON payments_methods(org_id, customer_id, status);
CREATE INDEX idx_payments_methods_org ON payments_methods(org_id, created DESC);
-- One default per customer, enforced where it cannot drift: in the schema.
CREATE UNIQUE INDEX idx_payments_methods_default ON payments_methods(org_id, customer_id)
  WHERE is_default = 1 AND status = 'attached';

CREATE TABLE payments_intents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  payment_method_id TEXT,
  invoice_id TEXT,
  subscription_id TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT,
  statement_descriptor TEXT,
  -- True when nobody is at the keyboard. It is the difference between an
  -- authentication prompt and an outright decline, so it is stored.
  off_session INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_action TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  last_error_advice TEXT,
  latest_charge_id TEXT,
  succeeded_at INTEGER,
  canceled_at INTEGER,
  cancellation_reason TEXT,
  idempotency_key TEXT,
  source TEXT NOT NULL DEFAULT 'api',
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_payments_intents_org ON payments_intents(org_id, created DESC);
CREATE INDEX idx_payments_intents_customer ON payments_intents(org_id, customer_id, created DESC);
CREATE INDEX idx_payments_intents_invoice ON payments_intents(org_id, invoice_id, created DESC);
-- Replaying a create with the same key returns the first intent rather than
-- charging a second time. The index is what makes that a guarantee.
CREATE UNIQUE INDEX idx_payments_intents_idem ON payments_intents(org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE payments_charges (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  payment_method_id TEXT,
  invoice_id TEXT,
  subscription_id TEXT,
  amount INTEGER NOT NULL,
  amount_refunded INTEGER NOT NULL DEFAULT 0,
  amount_disputed INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  captured INTEGER NOT NULL DEFAULT 0,
  refunded INTEGER NOT NULL DEFAULT 0,
  disputed INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT,
  failure_message TEXT,
  authorization_code TEXT,
  -- The decision, and the reasoning behind it. outcome_seller_message is the
  -- sentence a support agent can send to the customer without rewriting it.
  outcome_type TEXT NOT NULL,
  outcome_network_status TEXT NOT NULL,
  outcome_reason TEXT,
  outcome_risk_level TEXT NOT NULL,
  outcome_risk_score INTEGER NOT NULL,
  outcome_seller_message TEXT NOT NULL,
  outcome_explanation TEXT NOT NULL,
  created INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_payments_charges_org ON payments_charges(org_id, created DESC);
CREATE INDEX idx_payments_charges_intent ON payments_charges(org_id, payment_intent_id);
CREATE INDEX idx_payments_charges_invoice ON payments_charges(org_id, invoice_id, created DESC);
CREATE INDEX idx_payments_charges_method ON payments_charges(org_id, payment_method_id, created);

CREATE TABLE payments_refunds (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  invoice_id TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT,
  -- What this refund did to the bill, in the words the invoice will echo.
  invoice_effect TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX idx_payments_refunds_org ON payments_refunds(org_id, created DESC);
CREATE INDEX idx_payments_refunds_charge ON payments_refunds(org_id, charge_id, created);
CREATE INDEX idx_payments_refunds_invoice ON payments_refunds(org_id, invoice_id, created);

CREATE TABLE payments_disputes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  invoice_id TEXT,
  subscription_id TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  evidence_due_by INTEGER NOT NULL,
  submitted_at INTEGER,
  closed_at INTEGER,
  outcome_note TEXT,
  is_charge_refundable INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_payments_disputes_org ON payments_disputes(org_id, created DESC);
CREATE INDEX idx_payments_disputes_charge ON payments_disputes(org_id, charge_id);
CREATE INDEX idx_payments_disputes_invoice ON payments_disputes(org_id, invoice_id);

-- One recovery campaign per invoice. It is reopened rather than duplicated if
-- the same bill fails again, so the attempt history of a bill is one story.
CREATE TABLE payments_dunning (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  subscription_id TEXT,
  currency TEXT NOT NULL,
  amount_at_risk INTEGER NOT NULL,
  recovered_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  retry_days TEXT NOT NULL,
  end_behavior TEXT NOT NULL,
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  last_failure_code TEXT,
  last_failure_message TEXT,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_payments_dunning_invoice ON payments_dunning(org_id, invoice_id);
CREATE INDEX idx_payments_dunning_open ON payments_dunning(org_id, status, next_attempt_at);
CREATE INDEX idx_payments_dunning_customer ON payments_dunning(org_id, customer_id, started_at DESC);

CREATE TABLE payments_dunning_attempts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  dunning_id TEXT NOT NULL REFERENCES payments_dunning(id) ON DELETE CASCADE,
  invoice_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  subscription_id TEXT,
  attempt_number INTEGER NOT NULL,
  scheduled_for INTEGER NOT NULL,
  attempted_at INTEGER NOT NULL,
  payment_method_id TEXT,
  payment_intent_id TEXT,
  charge_id TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  outcome TEXT NOT NULL,
  failure_code TEXT,
  failure_message TEXT,
  -- What this attempt decided to do next, and why. The recovery story is
  -- readable straight down this column.
  decision TEXT NOT NULL,
  next_attempt_at INTEGER,
  created INTEGER NOT NULL
);
CREATE INDEX idx_payments_attempts_dunning ON payments_dunning_attempts(dunning_id, attempt_number);
CREATE INDEX idx_payments_attempts_org ON payments_dunning_attempts(org_id, attempted_at DESC);
CREATE INDEX idx_payments_attempts_invoice ON payments_dunning_attempts(org_id, invoice_id, attempt_number);
`,
  },
  {
    id: 'payments.0002_end_behavior_applied',
    sql: `
-- What giving up actually did to the subscription, written once the decision
-- has been carried out. It is a column rather than a line in the resolution
-- prose because it is also the latch: the end behaviour rides on an event, and
-- an event that arrives twice must not cancel a subscription twice.
ALTER TABLE payments_dunning ADD COLUMN end_behavior_applied TEXT;
`,
  },
  {
    id: 'payments.0003_intent_idempotency_fingerprint',
    sql: `
-- The request an idempotency key was first used with. A key on its own only
-- proves someone sent this string before; it does not prove they were asking
-- for the same money, and returning the first intent to a second caller
-- reports a payment that customer never made. The fingerprint is recorded from
-- the request rather than derived from the intent, because an invoice-bound
-- intent is re-priced after it is created and the request is what a replay has
-- to match. Null on rows written before this column existed: those replay as
-- they always did rather than being refused retroactively.
ALTER TABLE payments_intents ADD COLUMN idempotency_fingerprint TEXT;
`,
  },
  {
    id: 'payments.0004_dunning_holds',
    sql: `
-- A campaign that is still recovering but presenting nothing: the last decline
-- was one no retry can answer, or a refund reopened the bill and a person has
-- to decide what happens to it. hold_reason says which, hold_until says when
-- the schedule's window runs out and the end behaviour applies (null when only
-- a person ends it), and hold_note is the sentence the queue shows. All three
-- are null while the schedule is presenting, and null once the campaign is over.
ALTER TABLE payments_dunning ADD COLUMN hold_reason TEXT;
ALTER TABLE payments_dunning ADD COLUMN hold_until INTEGER;
ALTER TABLE payments_dunning ADD COLUMN hold_note TEXT;
`,
  },
];
