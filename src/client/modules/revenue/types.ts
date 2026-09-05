/**
 * The shapes the revenue, metering, credits and payments modules answer with.
 *
 * These are hand-written against the live API rather than generated, and they
 * are deliberately narrow: every field below is one this product reads and
 * renders. Anything the server sends that no screen uses is not declared, so a
 * field appearing here is a promise that something on screen depends on it.
 */

/* ------------------------------ arithmetic -------------------------------- */

/**
 * A rate the server divided exactly. `percent` is already formatted; `bps`
 * is the integer the chart scales from, and numerator/denominator are what
 * make the figure checkable rather than believable.
 */
export interface Rate {
  bps: number;
  numerator: number;
  denominator: number;
  percent: string;
  undefined_rate: boolean;
}

/** A scaled quantity — DSO in days, revenue per unit — with its division. */
export interface Ratio {
  scaled: number;
  scale: number;
  display: string;
  numerator: number;
  denominator: number;
  undefined_value: boolean;
}

export interface CurrencyScope {
  mode: 'single' | 'mixed';
  single: string | null;
  reporting: string;
  currencies: string[];
  note: string;
}

export interface Basis {
  summary: string;
  rules: string[];
  currency: CurrencyScope;
}

export interface Reconciliation {
  computed_closing: number | null;
  reported_closing: number | null;
  difference: number | null;
  balanced: boolean;
  note: string | null;
}

/** Every revenue endpoint answers with this envelope around its own payload. */
export interface RevenueEnvelope {
  as_of: number;
  range: { from: number; to: number; months: number };
  currency: string | null;
  basis: Basis;
  sources: Record<string, number>;
  truncated: boolean;
  warnings: string[];
}

/* -------------------------------- revenue --------------------------------- */

export interface MrrPoint {
  month: string;
  at: number;
  complete: boolean;
  mrr: number | null;
  arr: number | null;
  accounts: number;
  average_mrr_per_account: number | null;
}

export interface MrrByCurrency {
  currency: string;
  mrr: number;
  arr: number;
  subscriptions: number;
  accounts: number;
  average_mrr_per_account: number;
}

export interface RevenueMrr extends RevenueEnvelope {
  series: MrrPoint[];
  totals: { mrr: number | null; arr: number | null; accounts: number; subscriptions: number; currency: string | null };
  by_currency: MrrByCurrency[];
  by_cadence: { currency: string; interval: string; interval_count: number; subscriptions: number; mrr: number; share: Rate }[];
  by_status: { currency: string; status: string; subscriptions: number; mrr: number }[];
  not_yet_revenue: {
    trialing_subscriptions: number;
    paused_subscriptions: number;
    trialing_mrr: number | null;
    paused_mrr: number | null;
    note: string;
  };
  usage: { run_rate: number | null; basis: string; mrr_with_usage: number | null; arr_with_usage: number | null };
}

export interface Mover {
  customer: string;
  kind: string;
  amount: number;
  currency: string | null;
  name: string;
  from: number;
  to: number;
}

export interface MovementMonth {
  month: string;
  period: { start: number; end: number };
  complete: boolean;
  currency: string | null;
  opening: number | null;
  new_business: number | null;
  expansion: number | null;
  reactivation: number | null;
  contraction: number | null;
  churn: number | null;
  net: number | null;
  closing: number | null;
  counts: {
    accounts_at_open: number;
    accounts_at_close: number;
    new_accounts: number;
    reactivated_accounts: number;
    expanded_accounts: number;
    contracted_accounts: number;
    churned_accounts: number;
  };
  top_movers: Mover[];
  reconciliation: Reconciliation;
}

export interface MovementTotals {
  opening: number | null;
  new_business: number | null;
  expansion: number | null;
  reactivation: number | null;
  contraction: number | null;
  churn: number | null;
  net: number | null;
  closing: number | null;
}

export interface RevenueMovement extends RevenueEnvelope {
  series: MovementMonth[];
  totals: MovementTotals;
  by_currency: { currency: string; totals: MovementTotals; reconciliation: Reconciliation; unbalanced_months: string[]; balanced: boolean }[];
  reconciliation: Reconciliation;
  unbalanced_months: string[];
  balanced: boolean;
  warning: string | null;
}

export interface ChurnMonth {
  month: string;
  complete: boolean;
  opening_mrr: number | null;
  closing_mrr: number | null;
  churned_mrr: number | null;
  contraction_mrr: number | null;
  expansion_mrr: number | null;
  reactivation_mrr: number | null;
  accounts_at_open: number;
  churned_accounts: number;
  logo_churn: Rate;
  logo_retention: Rate;
  gross_revenue_churn: Rate | null;
  gross_revenue_retention: Rate | null;
  net_revenue_retention: Rate | null;
}

export interface RevenueChurn extends RevenueEnvelope {
  series: ChurnMonth[];
  totals: {
    churned_accounts: number;
    exposed_accounts: number;
    logo_churn: Rate;
    gross_revenue_churn: Rate | null;
    gross_revenue_retention: Rate | null;
    net_revenue_retention: Rate | null;
    churned_mrr: number | null;
    contraction_mrr: number | null;
    expansion_mrr: number | null;
  };
}

export interface CohortCell {
  offset: number;
  month: string;
  complete: boolean;
  accounts: number;
  mrr: number | null;
  logo_retention: Rate;
  net_revenue_retention: Rate | null;
}

export interface RevenueCohorts extends RevenueEnvelope {
  series: { cohort: string; accounts: number; initial_mrr: number | null; currency: string | null; cells: CohortCell[] }[];
  totals: { cohorts: number; accounts: number; by_offset: { offset: number; accounts: number; retained: number; logo_retention: Rate }[] };
}

export interface AgeingBucket {
  bucket: string;
  label: string;
  invoices: number;
  amount: number | null;
  share: Rate | null;
  oldest_due: number | null;
}

export interface Ageing {
  as_of: number;
  currency: string | null;
  total: number | null;
  invoices: number;
  buckets: AgeingBucket[];
  past_due_total: number | null;
  past_due_share: Rate | null;
  oldest_due: number | null;
}

export interface CollectionsMonth {
  month: string;
  complete: boolean;
  billed: number | null;
  collected: number | null;
  outstanding: number | null;
  past_due: number | null;
  collection_rate: Rate | null;
}

export interface RevenueCollections extends RevenueEnvelope {
  series: CollectionsMonth[];
  totals: {
    billed: number | null;
    collected: number | null;
    credited: number | null;
    written_off: number | null;
    outstanding: number | null;
    past_due: number | null;
    collection_rate: Rate | null;
    dso: Ratio | null;
    dso_basis: string;
    days_in_range: number;
  };
  ageing: Ageing;
  recovery: {
    campaigns_started: number;
    amount_at_risk: number | null;
    amount_recovered: number | null;
    recovery_rate: Rate | null;
    attempt_success_rate: Rate | null;
    give_ups: number;
    top_failure_codes: { code: string; campaigns: number; amount: number }[];
  } | null;
  exposure: { failed_payments: number | null; campaigns: number; over_90_days: number | null; note: string | null };
}

export interface UsageMeterRow {
  meter: string;
  name: string;
  unit_label: string | null;
  currency: string;
  settlements: number;
  quantity_micro: number;
  metered_value: number;
  credit_covered: number;
  charged: number;
  charged_share: Rate;
  revenue_per_unit: Ratio;
}

export interface UsageMonth {
  month: string;
  complete: boolean;
  settlements: number;
  metered_value: number | null;
  credit_covered: number | null;
  charged: number | null;
}

export interface CreditFlow {
  kind: string;
  currency: string | null;
  granted: number;
  rolled_in: number;
  rolled_out: number;
  burned: number;
  expired: number;
  refunded: number;
  voided: number;
  adjusted: number;
  inflows: number;
  outflows: number;
  entries: number;
  balance: number;
  micro: boolean;
  reconciliation: { components: number; balance: number; difference: number; balanced: boolean; note: string | null };
}

export interface RevenueUsage extends RevenueEnvelope {
  series: UsageMonth[];
  totals: {
    metered_value: number | null;
    credit_covered: number | null;
    charged: number | null;
    settlements: number;
    skipped_settlements: number;
    invoiced: number | null;
    metered_share_of_invoiced: Rate | null;
    overage_share_of_invoiced: Rate | null;
  };
  meters: UsageMeterRow[];
  credit: {
    flows: CreditFlow[];
    purchased: number | null;
    purchase_lines: number;
    burned_against_usage: number | null;
    outstanding_monetary: number | null;
    outstanding_unit_micro: number;
    grants: number;
  };
  invoiced_mix: { kind: string; currency: string; lines: number; amount: number; share: Rate }[];
  reconciliation: {
    balanced: boolean;
    checks: { name: string; description: string; expected: number; actual: number; difference: number; unit: string; ok: boolean }[];
    note: string | null;
  };
  balanced: boolean;
}

export interface SummaryByCurrency {
  currency: string;
  mrr: number;
  arr: number;
  accounts: number;
  receivables: number;
  past_due: number;
  net_revenue_retention: Rate;
  gross_revenue_retention: Rate;
}

export interface SummaryMonth {
  month: string;
  complete: boolean;
  mrr: number | null;
  arr: number | null;
  net_movement: number | null;
  accounts: number;
  receivables: number | null;
  deferred_balance: number | null;
  reconciled: boolean;
}

export interface RevenueSummary extends RevenueEnvelope {
  balanced: boolean;
  series: SummaryMonth[];
  headline: {
    mrr: number | null;
    arr: number | null;
    mrr_with_usage: number | null;
    accounts: number;
    net_new_mrr_this_month: number | null;
    net_revenue_retention: Rate | null;
    gross_revenue_retention: Rate | null;
    logo_churn: Rate;
    receivables: number | null;
    past_due: number | null;
    dso: Ratio | null;
    deferred_balance: number | null;
    overage_share: Rate | null;
  };
  by_currency: SummaryByCurrency[];
}

export interface RevenueAccountRow {
  customer: string;
  name: string;
  currency: string;
  mrr: number;
  arr: number;
  previous_month_mrr: number;
  change: number;
  subscriptions: number;
  first_revenue_at: number | null;
}

/* -------------------------------- metering -------------------------------- */

export interface Meter {
  id: string;
  name: string;
  event_name: string;
  aggregation: 'sum' | 'count' | 'max' | 'last' | 'unique';
  value_key: string | null;
  customer_key: string;
  unique_key: string | null;
  unit_label: string | null;
  status: 'active' | 'inactive' | 'archived';
  acceptance_window_ms: number;
  future_tolerance_ms: number;
  description: string | null;
  metadata: Record<string, string>;
  created: number;
  updated: number;
}

export interface MeterDetail extends Meter {
  ingestion: {
    event_count: number;
    customer_count: number;
    first_event_at: number | null;
    last_event_at: number | null;
    accepts_events_from: number;
    accepts_events_until: number;
  };
}

export interface MeteringOverview {
  as_of: number;
  defaults: { acceptance_window_ms: number; future_tolerance_ms: number; max_batch: number };
  meters: {
    id: string;
    name: string;
    event_name: string;
    aggregation: string;
    unit_label: string | null;
    status: string;
    events_30d: number;
    customers_30d: number;
    last_hour_with_events: number | null;
  }[];
  open_late_arrivals: number;
  closed_periods: number;
  withdrawn_events: number;
  true_ups_settled: { n: number; credited: number; rebilled: number };
  periods_awaiting_settlement: number;
  skipped_settlements: number;
  settlement_jobs_failed: number;
}

export interface MeterEvent {
  id: string;
  meter: string;
  event_name: string;
  identifier: string;
  customer: string;
  value: number;
  value_decimal: string;
  unique_key: string | null;
  timestamp: number;
  payload: Record<string, unknown>;
  late: boolean;
  closure: string | null;
  received_at: number;
  cancelled_at: number | null;
  cancelled: boolean;
  adjustment: string | null;
}

export interface MeterEventResult {
  outcome: 'recorded' | 'duplicate';
  event: MeterEvent;
}

export interface MeterEventAdjustment {
  id: string;
  type: string;
  meter: string;
  customer: string;
  event: string;
  identifier: string;
  value: number;
  timestamp: number;
  closure: string | null;
  late_arrival: string | null;
  reason: string | null;
  created: number;
}

export interface MeterLateArrival {
  id: string;
  meter: string;
  customer: string;
  event: string;
  closure: string;
  value: number;
  timestamp: number;
  period_start: number;
  period_end: number;
  resolution: 'open' | 'credited' | 'ignored' | 'rebilled' | 'withdrawn';
  resolved_at: number | null;
  amount: number | null;
  currency: string | null;
  billable_item: string | null;
  credit_restored: number | null;
  note: string | null;
  created: number;
}

export interface MeterPeriodClosure {
  id: string;
  meter: string;
  customer: string;
  period_start: number;
  period_end: number;
  aggregation: string;
  total: number;
  event_count: number;
  adjustment: number;
  late_event_count: number;
  price: string | null;
  currency: string | null;
  closed_at: number;
}

export interface SummaryBucket {
  meter: string;
  customer: string;
  start: number;
  end: number;
  granularity: 'hour' | 'day' | 'month';
  aggregation: string;
  value: number;
  event_count: number;
}

export interface MeterUsage {
  meter: string;
  meter_name: string;
  event_name: string;
  aggregation: string;
  unit_label: string | null;
  customer: string;
  period_start: number;
  period_end: number;
  value: number;
  billable_quantity: number;
  event_count: number;
  pending: boolean;
  as_of: number;
}

/* --------------------------------- credits -------------------------------- */

export interface Applicability {
  scope: 'all' | 'targeted';
  prices: string[];
  meters: string[];
  products: string[];
}

export interface CreditGrant {
  id: string;
  customer: string;
  name: string;
  category: 'paid' | 'promotional';
  kind: 'monetary' | 'unit';
  currency: string;
  meter: string | null;
  unit_label: string | null;
  amount: number;
  balance: number;
  applicability: Applicability;
  applies_to: string;
  effective_at: number;
  expires_at: number | null;
  priority: number;
  rollover: 'none' | 'capped' | 'full';
  rollover_cap: number | null;
  status: 'scheduled' | 'active' | 'exhausted' | 'expired' | 'voided';
  awaiting_payment: boolean;
  source: string;
  source_ref: string | null;
  metadata: Record<string, string>;
  created: number;
  updated: number;
}

export interface CreditLedgerEntry {
  id: string;
  grant: string;
  customer: string;
  seq: number;
  type: 'grant' | 'burn' | 'expiry' | 'void' | 'refund' | 'rollover_in' | 'rollover_out' | 'adjustment';
  delta: number;
  balance_after: number;
  currency: string;
  kind: 'monetary' | 'unit';
  reason: string;
  ref_type: string | null;
  ref_id: string | null;
  period_start: number | null;
  period_end: number | null;
  created: number;
}

export interface CreditLedgerResponse {
  grant: CreditGrant;
  reconciled: boolean;
  opening: number;
  closing: number;
  entries: CreditLedgerEntry[];
}

export interface CreditBillableItem {
  id: string;
  customer: string;
  settlement: string | null;
  grant: string | null;
  kind: 'topup' | 'credit_covered' | 'charged' | 'true_up';
  description: string;
  currency: string;
  amount: number;
  billed_amount: number;
  credit_applied: number;
  quantity: number;
  unit_label: string | null;
  price: string | null;
  meter: string | null;
  period_start: number | null;
  period_end: number | null;
  status: 'pending' | 'invoiced' | 'void';
  invoice: string | null;
  created: number;
}

export interface CreditApplication {
  grant: string;
  grant_name: string;
  category: string;
  kind: string;
  expires_at: number | null;
  priority: number;
  drawn: number;
  amount: number;
  balance_after: number;
  ledger_entry: string;
}

export interface CreditSettlement {
  id: string;
  status: 'settled' | 'skipped';
  skip: { reason: string; explanation: string } | null;
  subscription: string | null;
  customer: string;
  meter: string | null;
  price: string;
  currency: string;
  period_start: number;
  period_end: number;
  quantity: number;
  billed_quantity: number;
  covered_quantity: number;
  charged_quantity: number;
  full_amount: number;
  covered_amount: number;
  charged_amount: number;
  applications: CreditApplication[];
  lines: CreditBillableItem[];
  true_ups: CreditBillableItem[];
  net_amount: number;
  net_charged_amount: number;
  burn_order: string[];
  created: number;
}

/** What `POST /v1/credit-topups` answers with: the charge and the credit it bought. */
export interface CreditTopUp {
  grant: CreditGrant;
  line: CreditBillableItem;
  /** What the customer is billed, in minor units — the figure the button promised. */
  amount: number;
  currency: string;
  quantity: number;
  invoice: string | null;
  charge_deferred: { code: string; message: string } | null;
  created: number;
}

/** `POST /v1/credit-grants/:id/refund`: the credit taken back, and the money returned. */
export interface CreditRefund {
  grant: CreditGrant;
  /** The negative purchase line — absent when the grant was never sold. */
  line: CreditBillableItem | null;
  /** Units or minor units of credit withdrawn, in the grant's own denomination. */
  refunded: number;
}

export interface CreditsOverview {
  as_of: number;
  burn_order: string[];
  grants: { total: number; active: number; scheduled: number; expired: number };
  outstanding: { currency: string; monetary_outstanding: number; unit_pots: number; monetary_outstanding_display: string }[];
  expiring_within_7_days: { id: string; customer: string; name: string; balance: number; expires_at: number | null }[];
  pending_invoice_lines: { count: number; billed_total: number; credit_applied_total: number; oldest_at: number | null; oldest_age_ms: number };
  unbilled_purchases: { count: number; amount_total: number; oldest_at: number | null; held_grants: number };
}

/* -------------------------------- payments -------------------------------- */

export interface DunningAttempt {
  id: string;
  dunning: string;
  attempt_number: number;
  scheduled_for: number;
  attempted_at: number | null;
  payment_method: string | null;
  amount: number;
  currency: string;
  outcome: 'succeeded' | 'failed' | 'skipped';
  failure_code: string | null;
  failure_message: string | null;
  decision: string;
  next_attempt_at: number | null;
  created: number;
}

export interface DunningCampaign {
  id: string;
  invoice: string;
  customer: string;
  subscription: string | null;
  currency: string;
  amount_at_risk: number;
  recovered_amount: number;
  status: 'open' | 'recovering' | 'recovered' | 'exhausted' | 'canceled';
  attempt_count: number;
  max_attempts: number;
  retry_days: number[];
  end_behavior: string;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  last_failure_code: string | null;
  last_failure_message: string | null;
  started_at: number;
  resolved_at: number | null;
  resolution: string | null;
  customer_name: string;
  invoice_number: string;
  subscription_status: string | null;
  attempts_remaining: number;
  payment_method: { id: string; display_name: string; type: string } | null;
  attempts: DunningAttempt[];
  recommended_action: string;
  needs_human: boolean;
}

export interface DunningSummary {
  open_campaigns: number;
  needs_human: number;
  recovered_campaigns: number;
  exhausted_campaigns: number;
  totals: { currency: string; amount_at_risk: number; recovered_amount: number; lost_amount: number; recovery_rate_bps: number }[];
  attempts: { total: number; succeeded: number; failed: number; skipped: number };
  by_decline: { code: string; severity: string; attempts: number }[];
  next_attempt_at: number | null;
}

export interface DunningPolicy {
  retry_days: number[];
  max_attempts: number;
  end_behavior: 'mark_unpaid' | 'cancel' | 'leave_past_due';
  skip_weekends: boolean;
  hard_decline_multiplier: number;
  collection_hour: number;
  jitter_hours: number;
  give_up_codes: string[];
}

export interface PaymentSettings {
  dunning: DunningPolicy;
  defaults: DunningPolicy;
  decline_codes: { code: string; severity: string; message: string; advice: string; retried: boolean }[];
  schedule_explained: string;
}

export interface CollectionAttempt {
  collected: boolean;
  invoice: { id: string; number: string; currency: string; amount_due: number; status: string };
  failure: { code: string; message: string; advice: string } | null;
  next_action: { type: string; at: number | null } | null;
  skipped: { reason: string } | null;
  dunning: DunningCampaign | null;
  summary: string;
}

/* --------------------------------- shared --------------------------------- */

export interface CustomerLite {
  id: string;
  name: string;
  email: string | null;
  currency: string;
}

export interface PriceLite {
  id: string;
  nickname: string | null;
  currency: string;
  unit_label: string | null;
  product_name: string | null;
  billing_scheme: 'per_unit' | 'tiered';
  tiers_mode: 'graduated' | 'volume' | null;
  currencies: string[];
  recurring: { meter: string | null } | null;
  display: {
    headline: string;
    /** Present on a tiered price: the cheapest rung, and the ladder in words. */
    from: string | null;
    tiers: string[] | null;
    summary: string;
  } | null;
}

/**
 * `POST /v1/prices/:id/preview` — the amount a quantity actually costs, with
 * the arithmetic that produced it. Nothing on these screens computes a charge
 * itself; the catalogue is asked, and its answer is what the dialog states
 * before the button that raises it is pressed.
 */
export interface PricePreview {
  price: string;
  currency: string;
  quantity: number;
  billable_quantity: number;
  amount: number;
  amount_display: string;
  effective_unit_amount_decimal: string | null;
  effective_unit_display: string | null;
  marginal_unit_display: string | null;
  warning: string | null;
  product: { id: string; name: string; unit_label: string | null } | null;
  breakdown: {
    kind: string;
    label: string;
    tier: number | null;
    quantity: number;
    amount: number;
    amount_display: string;
    unit_display: string | null;
  }[];
}

/**
 * The fields of an invoice this module ages and links to. Billing owns the
 * screen; this is only enough to answer "which invoice is the $127,840?".
 */
export interface OpenInvoice {
  id: string;
  number: string;
  customer: string;
  customer_name: string;
  currency: string;
  status: string;
  total: number;
  amount_due: number;
  amount_paid: number;
  amount_due_display: string;
  due_date: number | null;
  finalized_at: number | null;
  paid_at: number | null;
  voided_at: number | null;
  marked_uncollectible_at: number | null;
  status_detail: string;
  created: number;
}

/**
 * A customer's prepaid credit, grouped by what it may be spent on — because
 * $500 that only pays for telemetry is not the same asset as $500 that pays
 * for anything.
 */
export interface CreditBalance {
  customer: string;
  as_of: number;
  balances: {
    key: string;
    kind: 'monetary' | 'unit';
    currency: string;
    applies_to: string;
    meter: string | null;
    unit_label: string | null;
    available: number;
    available_decimal: string;
    next_expiry: { at: number; grant: string; grant_name: string; amount: number } | null;
  }[];
}
