/**
 * The metering object model.
 *
 * A meter is a standing instruction for turning a stream of raw events into one
 * number per customer per period: which event name to listen for, where in the
 * payload the value and the customer live, and how the values collapse.
 */

/**
 * How the events of a period collapse into one number.
 * - `sum`    add every value (telemetry events, GB exported)
 * - `count`  one per event, the value is ignored (alerts raised)
 * - `max`    the peak reading in the period (robots connected at once)
 * - `last`   the most recent reading in the period (stored volume)
 * - `unique` distinct subjects seen in the period (operators who signed in)
 */
export type MeterAggregation = 'sum' | 'count' | 'max' | 'last' | 'unique';

export const METER_AGGREGATIONS = ['sum', 'count', 'max', 'last', 'unique'] as const;
export const METER_STATUSES = ['active', 'inactive', 'archived'] as const;

export type MeterStatus = (typeof METER_STATUSES)[number];

export interface Meter {
  object: 'meter';
  id: string;
  /** Human name shown on invoices and in the usage explorer. */
  name: string;
  /** The `event_name` an ingested event must carry to reach this meter. */
  event_name: string;
  aggregation: MeterAggregation;
  /** Payload key holding the numeric value. Null (and unused) for `count`. */
  value_key: string | null;
  /** Payload key holding the customer this event belongs to. */
  customer_key: string;
  /** Payload key identifying the subject counted by a `unique` meter. */
  unique_key: string | null;
  unit_label: string | null;
  status: MeterStatus;
  /** How far in the past a backdated event may be timestamped. */
  acceptance_window_ms: number;
  /** How far ahead of the workspace clock a timestamp may be. */
  future_tolerance_ms: number;
  description: string | null;
  metadata: Record<string, string>;
  created: number;
  updated: number;
}

export interface MeterEvent {
  object: 'meter_event';
  id: string;
  meter: string;
  event_name: string;
  /** The caller's exactly-once key. */
  identifier: string;
  customer: string;
  /** Exact value, as a decimal string in meter units. */
  value_decimal: string;
  value: number;
  unique_key: string | null;
  timestamp: number;
  /** UTC hour bucket the event was folded into. */
  hour_start: number;
  payload: Record<string, unknown>;
  /** True when the event landed after its period had already been billed. */
  late: boolean;
  closure: string | null;
  received_at: number;
  /** When this event was withdrawn by an adjustment. It no longer counts. */
  cancelled_at: number | null;
  cancelled: boolean;
  /** The adjustment that withdrew it. */
  adjustment: string | null;
}

/**
 * The withdrawal of an event that should never have been recorded.
 *
 * Compensating, never destructive: the original event row survives with its
 * `identifier` still claimed, so exactly-once ingestion keeps holding after a
 * cancellation, and the adjustment is the record of what was taken back out.
 */
export interface MeterEventAdjustment {
  object: 'meter_event_adjustment';
  id: string;
  type: 'cancel';
  meter: string;
  customer: string;
  /** The event that was withdrawn. */
  event: string;
  identifier: string;
  /** How much the meter's live total moved, as a negative decimal. */
  value: number;
  value_decimal: string;
  timestamp: number;
  /** Set when the withdrawn event sat inside an already-billed period. */
  closure: string | null;
  /** The true-up entry filed against that closure, if there was one. */
  late_arrival: string | null;
  reason: string | null;
  created: number;
}

/** What one ingestion attempt did. `duplicate` means the replay was a no-op. */
export type IngestOutcome = 'recorded' | 'duplicate';

export interface IngestResult {
  object: 'meter_event_result';
  outcome: IngestOutcome;
  event: MeterEvent;
  /** Set when the event landed inside an already-billed period. */
  late_arrival: LateArrival | null;
}

export interface BatchItemResult {
  index: number;
  /** The caller's identifier, echoed so a partial batch can be reconciled. */
  identifier: string | null;
  outcome: IngestOutcome | 'error';
  event: MeterEvent | null;
  late_arrival: LateArrival | null;
  error: { type: string; code: string; message: string; param?: string } | null;
}

export interface BatchResult {
  object: 'meter_event_batch';
  recorded: number;
  duplicates: number;
  errors: number;
  late: number;
  results: BatchItemResult[];
}

export interface SummaryBucket {
  object: 'meter_event_summary';
  meter: string;
  customer: string;
  start: number;
  end: number;
  granularity: SummaryGranularity;
  aggregation: MeterAggregation;
  value: number;
  value_decimal: string;
  event_count: number;
}

export const SUMMARY_GRANULARITIES = ['hour', 'day', 'month'] as const;
export type SummaryGranularity = (typeof SUMMARY_GRANULARITIES)[number];

/** How a period total was assembled — the reason the number can be trusted. */
export interface UsageProvenance {
  /** Whole hours read from the pre-aggregate. */
  summarized_hours: number;
  /** Raw events read for the partial hours at the edges of the period. */
  scanned_events: number;
  /** True when the period starts part-way through a UTC hour. */
  partial_leading_hour: boolean;
  /** True when the period ends part-way through a UTC hour. */
  partial_trailing_hour: boolean;
}

export interface PeriodUsage {
  object: 'meter_usage';
  meter: string;
  meter_name: string;
  event_name: string;
  aggregation: MeterAggregation;
  unit_label: string | null;
  customer: string;
  period_start: number;
  period_end: number;
  /** The aggregated value, exact. */
  value: number;
  value_decimal: string;
  /** The whole-unit quantity the price book bills, rounded half-up once. */
  billable_quantity: number;
  event_count: number;
  /** True while the period is still open, so the total can still move. */
  pending: boolean;
  provenance: UsageProvenance;
  closed: PeriodClosure | null;
  /** Value that arrived after the period was billed, awaiting a true-up. */
  late_adjustment: { value: number; value_decimal: string; event_count: number } | null;
  as_of: number;
}

export interface PeriodClosure {
  object: 'meter_period_closure';
  id: string;
  meter: string;
  customer: string;
  period_start: number;
  period_end: number;
  aggregation: MeterAggregation;
  /** The total as it stood when the period was billed. */
  total: number;
  total_decimal: string;
  event_count: number;
  /** Value that has moved since, not reflected in the billed total. */
  adjustment: number;
  adjustment_decimal: string;
  /** How much of that movement has already been turned into a true-up line. */
  settled_adjustment: number;
  settled_adjustment_decimal: string;
  /** Entries in this closure's true-up queue — late arrivals and withdrawals. */
  late_event_count: number;
  /** The price this period was billed on, so drift can be re-priced exactly. */
  price: string | null;
  currency: string | null;
  /**
   * Units of the same billing period already priced under an earlier window,
   * so a true-up climbs the price's tiers from where the invoice left off
   * rather than starting the ladder again.
   */
  prior_quantity: number;
  prior_quantity_decimal: string;
  ref_type: string | null;
  ref_id: string | null;
  closed_at: number;
}

/**
 * A closure read on its own, with the one number a list cannot afford: what the
 * period is worth now against what it has been billed, re-aggregated live.
 */
export interface ClosureDetail extends PeriodClosure {
  /** The period's total as the meter reads it today. */
  live_total: number;
  live_total_decimal: string;
  /** Signed money the invoice must still move by. Null without a price. */
  outstanding_amount: number | null;
  /** Signed quantity behind that money. */
  outstanding_quantity: number;
  outstanding_quantity_decimal: string;
  open_entries: LateArrival[];
}

export const LATE_RESOLUTIONS = ['open', 'credited', 'ignored', 'rebilled', 'withdrawn'] as const;
export type LateResolution = (typeof LATE_RESOLUTIONS)[number];

export interface LateArrival {
  object: 'meter_late_arrival';
  id: string;
  meter: string;
  customer: string;
  event: string;
  closure: string;
  /** Negative when a withdrawal took value back out of a billed period. */
  value: number;
  value_decimal: string;
  timestamp: number;
  period_start: number;
  period_end: number;
  resolution: LateResolution;
  resolved_at: number | null;
  /** The object the resolution produced — a billable line, or an adjustment. */
  resolution_ref: string | null;
  /** Signed minor units this resolution moved the period's bill by. */
  amount: number | null;
  currency: string | null;
  /** The invoice line the true-up became, once a billing module made one. */
  billable_item: string | null;
  /** Credit handed back to the grants that paid for the withdrawn usage. */
  credit_restored: number | null;
  /** A human note, for a resolution that deliberately moves no money. */
  note: string | null;
  created: number;
}

/**
 * What metering hands a billing module when a true-up has been priced.
 *
 * Metering can say exactly how much a billed period's drift is worth — it has
 * the meter, the closure's price and the catalog. It cannot put that on an
 * invoice or give credit back, because it knows nothing about either. So it
 * computes the money and hands it to whoever registered `onTrueUp`.
 */
export interface TrueUpRequest {
  late_arrival: string;
  closure: string;
  meter: string;
  meter_name: string;
  customer: string;
  price: string;
  currency: string;
  period_start: number;
  period_end: number;
  resolution: 'credited' | 'rebilled';
  /** Signed minor units the period's bill moves by. Never zero. */
  amount: number;
  /** Whole units billed before this true-up, and after it. */
  billed_quantity: number;
  new_quantity: number;
  /**
   * Units of the billing period priced under earlier windows. Both quantities
   * above sit on top of it, so the tiers a true-up is charged at are the ones
   * the period had actually reached.
   */
  prior_quantity: number;
  /** The exact signed quantity movement, in micro-units, as a decimal string. */
  quantity_decimal: string;
  unit_label: string | null;
  /** What the closure was written against, when it came from a settlement. */
  settlement_ref: { type: string; id: string } | null;
  description: string;
}

export interface TrueUpResult {
  /** The invoice line the true-up became. */
  item: string;
  /** What the customer's bill actually moves by, after credit. */
  billed_amount: number;
  /** Credit returned to (or drawn from) grants, in minor units. */
  credit_amount: number;
}

/** Registered by whichever module turns a priced true-up into money. */
export type TrueUpSink = (orgId: string, request: TrueUpRequest) => TrueUpResult;

export interface MeterInput {
  id?: string;
  name: string;
  event_name: string;
  aggregation?: MeterAggregation;
  value_key?: string | null;
  customer_key?: string;
  unique_key?: string | null;
  unit_label?: string | null;
  status?: MeterStatus;
  acceptance_window_ms?: number;
  future_tolerance_ms?: number;
  description?: string | null;
  metadata?: Record<string, string>;
}

export interface MeterEventInput {
  event_name?: string;
  meter?: string;
  identifier?: string;
  customer?: string;
  timestamp?: number;
  value?: number | string;
  payload?: Record<string, unknown>;
}
