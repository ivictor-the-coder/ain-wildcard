import type { Migration } from '../../kernel/db';

/**
 * Metering is the only high-volume write path in the platform, so its schema is
 * shaped by three facts:
 *
 *  1. Ingestion must be exactly-once. `identifier` is unique per workspace, so
 *     a client that retries a batch after a socket error writes nothing twice.
 *  2. A period total must be a bounded read. Every event maintains an hourly
 *     pre-aggregate as it lands, so billing a month reads ~744 summary rows
 *     instead of scanning millions of events.
 *  3. Values are exact. Quantities are stored as integer micro-units
 *     (1 unit = 1,000,000 micro) so SUM() is integer arithmetic and no float
 *     ever touches a number that becomes money.
 */
export const METERING_MIGRATIONS: Migration[] = [
  {
    id: 'metering.0001_meters_and_events',
    sql: `
CREATE TABLE meters (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  event_name TEXT NOT NULL,
  aggregation TEXT NOT NULL,
  value_key TEXT,
  customer_key TEXT NOT NULL DEFAULT 'customer_id',
  unique_key TEXT,
  unit_label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  acceptance_window_ms INTEGER NOT NULL,
  future_tolerance_ms INTEGER NOT NULL,
  description TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
-- An event name may only route to one live meter, or ingestion is ambiguous.
CREATE UNIQUE INDEX idx_meters_event_name ON meters(org_id, event_name) WHERE status <> 'archived';
CREATE INDEX idx_meters_org ON meters(org_id, status, created DESC);

CREATE TABLE meter_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  meter_id TEXT NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  identifier TEXT NOT NULL,
  event_name TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  value_micro INTEGER NOT NULL,
  unique_key TEXT,
  timestamp INTEGER NOT NULL,
  hour_start INTEGER NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  late INTEGER NOT NULL DEFAULT 0,
  closure_id TEXT,
  received_at INTEGER NOT NULL
);
-- The exactly-once guarantee. Scoped to the workspace, like Stripe's.
CREATE UNIQUE INDEX idx_meter_events_identifier ON meter_events(org_id, identifier);
CREATE INDEX idx_meter_events_window ON meter_events(org_id, meter_id, customer_id, timestamp);
CREATE INDEX idx_meter_events_hour ON meter_events(org_id, meter_id, customer_id, hour_start);
CREATE INDEX idx_meter_events_recent ON meter_events(org_id, meter_id, received_at DESC);

-- Maintained incrementally on every accepted event. last_rowid breaks ties
-- between two events carrying the same timestamp, so "last" is deterministic.
CREATE TABLE meter_event_summaries (
  org_id TEXT NOT NULL,
  meter_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  hour_start INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  sum_micro INTEGER NOT NULL DEFAULT 0,
  max_micro INTEGER,
  last_micro INTEGER,
  last_at INTEGER,
  last_rowid INTEGER,
  unique_count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (org_id, meter_id, customer_id, hour_start)
);
CREATE INDEX idx_meter_summaries_meter_hour ON meter_event_summaries(org_id, meter_id, hour_start);

-- A distinct-subject index for unique meters. Counting distinct keys over a
-- range is COUNT(DISTINCT ...) here rather than a scan of the event table.
CREATE TABLE meter_event_uniques (
  org_id TEXT NOT NULL,
  meter_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  hour_start INTEGER NOT NULL,
  unique_key TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, meter_id, customer_id, hour_start, unique_key)
);
CREATE INDEX idx_meter_uniques_range ON meter_event_uniques(org_id, meter_id, customer_id, hour_start);

-- A period is closed when it has been billed. Events that arrive afterwards are
-- still accepted and still stored — they are reported here instead of silently
-- changing a number that is already on an invoice.
CREATE TABLE meter_period_closures (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  meter_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  aggregation TEXT NOT NULL,
  total_micro INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  adjustment_micro INTEGER NOT NULL DEFAULT 0,
  late_event_count INTEGER NOT NULL DEFAULT 0,
  ref_type TEXT,
  ref_id TEXT,
  closed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_meter_closures_period ON meter_period_closures(org_id, meter_id, customer_id, period_start, period_end);
CREATE INDEX idx_meter_closures_customer ON meter_period_closures(org_id, customer_id, period_end DESC);

CREATE TABLE meter_late_arrivals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  meter_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  closure_id TEXT NOT NULL,
  value_micro INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'open',
  resolved_at INTEGER,
  resolution_ref TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX idx_meter_late_open ON meter_late_arrivals(org_id, resolution, created DESC);
CREATE INDEX idx_meter_late_closure ON meter_late_arrivals(org_id, closure_id);
`,
  },
  {
    /**
     * Unsaying an event.
     *
     * A fat-fingered reading is in the customer's total forever unless there is
     * a supported way to withdraw it, and a delete would break the append-only
     * property the rest of this schema depends on. So a cancellation is its own
     * row: the original event stays, keeping its `identifier` claimed so a
     * replay cannot resurrect it, and is marked `cancelled_at`. The hourly
     * pre-aggregate is unfolded in the same transaction.
     */
    id: 'metering.0002_event_adjustments',
    sql: `
ALTER TABLE meter_events ADD COLUMN cancelled_at INTEGER;
ALTER TABLE meter_events ADD COLUMN adjustment_id TEXT;
CREATE INDEX idx_meter_events_live ON meter_events(org_id, meter_id, customer_id, hour_start, cancelled_at);

CREATE TABLE meter_event_adjustments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  meter_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'cancel',
  value_micro INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  closure_id TEXT,
  late_arrival_id TEXT,
  reason TEXT,
  created INTEGER NOT NULL
);
-- One event can only be unsaid once; a retried cancel returns the first one.
CREATE UNIQUE INDEX idx_meter_adjustments_event ON meter_event_adjustments(org_id, event_id);
CREATE INDEX idx_meter_adjustments_meter ON meter_event_adjustments(org_id, meter_id, created DESC);
`,
  },
  {
    /**
     * A true-up has to be able to become money.
     *
     * A closure knew what a period measured but not what it was worth, so the
     * only thing a resolved late arrival could record was a word. These columns
     * are what a period needs to be re-priced: the price it was billed on, the
     * currency it was billed in, and how much of the drift since has already
     * been turned into an invoice line. `settled_adjustment_micro` is the part
     * that makes repeated true-ups exact — each one prices the movement from
     * where the last one left off, so two true-ups on a graduated price sum to
     * the same money as one true-up of both.
     */
    id: 'metering.0003_true_up_pricing',
    sql: `
ALTER TABLE meter_period_closures ADD COLUMN price_id TEXT;
ALTER TABLE meter_period_closures ADD COLUMN currency TEXT;
ALTER TABLE meter_period_closures ADD COLUMN settled_adjustment_micro INTEGER NOT NULL DEFAULT 0;

ALTER TABLE meter_late_arrivals ADD COLUMN amount INTEGER;
ALTER TABLE meter_late_arrivals ADD COLUMN currency TEXT;
ALTER TABLE meter_late_arrivals ADD COLUMN billable_item_id TEXT;
ALTER TABLE meter_late_arrivals ADD COLUMN credit_amount INTEGER;
ALTER TABLE meter_late_arrivals ADD COLUMN note TEXT;
CREATE INDEX idx_meter_late_customer ON meter_late_arrivals(org_id, customer_id, created DESC);
`,
  },
  {
    /**
     * Where on the price's ladder this period was billed from.
     *
     * A graduated price is a function of the whole billing period, not of the
     * window somebody happened to settle. When a period is billed in more than
     * one piece — a plan change mid-cycle, a gap settled on its own — each
     * piece is priced marginally, from the units the earlier pieces already
     * consumed. `prior_quantity_micro` is that starting position, frozen with
     * the closure so a true-up months later re-prices the drift from exactly
     * the same rung the invoice was drawn on rather than from zero.
     */
    id: 'metering.0004_period_tier_basis',
    sql: `
ALTER TABLE meter_period_closures ADD COLUMN prior_quantity_micro INTEGER NOT NULL DEFAULT 0;
`,
  },
];
