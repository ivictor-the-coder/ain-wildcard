/**
 * The billing API as this module reads it.
 *
 * Every field below exists on a real response — the shapes were taken from
 * `src/server/modules/billing/types.ts` and the payload builders in that
 * module's `module.ts`, which add the `*_display`, `status_detail` and
 * `customer_name` fields the raw records do not carry. Nothing here is
 * optimistic: a field this file declares is a field the server sends.
 */

export type SubscriptionStatus =
  | 'trialing' | 'incomplete' | 'incomplete_expired' | 'active' | 'past_due' | 'paused' | 'canceled' | 'unpaid';
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
export type CollectionMethod = 'charge_automatically' | 'send_invoice';
export type ProrationBehavior = 'create_prorations' | 'none' | 'always_invoice';
export type PauseBehavior = 'keep_as_draft' | 'mark_uncollectible' | 'void';
export type TaxExemption = 'none' | 'exempt' | 'reverse';

export interface Address {
  line1: string | null; line2: string | null; city: string | null;
  state: string | null; postal_code: string | null; country: string | null;
}

export interface TaxId {
  type: string; value: string; country: string | null;
  verification: { status: string; verified_name: string | null; checked_at: number | null; note: string | null };
}

export interface Customer {
  object: 'customer';
  id: string;
  name: string;
  email: string | null;
  description: string | null;
  phone: string | null;
  currency: string;
  currency_locked: boolean;
  address: Address | null;
  tax_ids: TaxId[];
  tax_exempt: TaxExemption;
  invoice_settings: {
    default_payment_method: string | null;
    days_until_due: number | null;
    custom_fields: { name: string; value: string }[];
    footer: string | null;
  };
  /** Negative is credit the customer holds; positive is carried forward. */
  balance: number;
  delinquent: boolean;
  preferred_locales: string[];
  metadata: Record<string, string>;
  crm_record_id: string | null;
  created: number;
  updated: number;
}

export interface BalanceTransaction {
  object: 'customer_balance_transaction';
  id: string; customer: string; amount: number; ending_balance: number; currency: string;
  type: string; description: string; subscription: string | null; invoice: string | null; created: number;
}

export interface BreakdownRow {
  kind: string;
  label: string;
  tier: number | null;
  up_to: number | string | null;
  quantity: number;
  unit_amount_decimal: string | null;
  amount: number;
  amount_decimal: string | null;
}

export interface SubscriptionItem {
  object: 'subscription_item';
  id: string; subscription: string; price: string; quantity: number; metered: boolean;
  custom_unit_amount: number | null;
  /** Added by the route payload — the priced description and its amount. */
  description: string;
  amount: number | null;
}

export interface Subscription {
  object: 'subscription';
  id: string;
  customer: string;
  status: SubscriptionStatus;
  items: SubscriptionItem[];
  currency: string;
  interval: string;
  interval_count: number;
  billing_cycle_anchor: number;
  billing_cycle_anchor_day: number;
  current_period_start: number;
  current_period_end: number;
  start_date: number;
  ended_at: number | null;
  canceled_at: number | null;
  cancel_at: number | null;
  cancel_at_period_end: boolean;
  cancellation_reason: string | null;
  cancellation_comment: string | null;
  trial_start: number | null;
  trial_end: number | null;
  collection_method: CollectionMethod;
  days_until_due: number | null;
  default_payment_method: string | null;
  pause_collection: { behavior: PauseBehavior; resumes_at: number | null } | null;
  proration_behavior: ProrationBehavior;
  schedule: string | null;
  description: string | null;
  metadata: Record<string, string>;
  created: number;
  /* payload additions */
  recurring_subtotal: number;
  mrr: number;
  status_detail: string;
  next_status_options: SubscriptionStatus[];
  interval_display: string;
  /**
   * The newest bill on this subscription, as `latestFor` writes it: only the
   * fields a summary needs. Anything else about the bill — what paid it, how
   * it is collected — is read from `GET /v1/invoices/:id`.
   */
  latest_invoice: LatestInvoice | null;
  customer_detail?: Customer;
}

export type LatestInvoice = Pick<Invoice, 'id' | 'number' | 'status' | 'total' | 'amount_due' | 'due_date' | 'created'>;

export interface ProrationLine {
  object: 'proration_line';
  kind: 'unused_time' | 'remaining_time' | 'immediate' | 'metered';
  description: string;
  explanation: string;
  subscription: string;
  subscription_item: string | null;
  price: string;
  quantity: number;
  amount: number;
  currency: string;
  period: { start: number; end: number };
  proration: { numerator: number; denominator: number };
  proration_date: number;
  breakdown: BreakdownRow[];
}

export interface RecurringLine {
  subscription_item: string | null;
  price: string;
  description: string;
  quantity: number;
  amount: number | null;
  currency: string;
  metered: boolean;
  period: { start: number; end: number };
  breakdown: BreakdownRow[];
}

/** `POST /v1/subscriptions/:id/preview` — the same function that bills. */
export interface ChangePreview {
  object: 'subscription_change_preview';
  subscription: string;
  customer: string;
  currency: string;
  proration_date: number;
  proration_behavior: ProrationBehavior;
  current_period: { start: number; end: number };
  next_period: { start: number; end: number };
  interval_before: { interval: string; interval_count: number };
  interval_after: { interval: string; interval_count: number };
  lines: ProrationLine[];
  credit_total: number;
  charge_total: number;
  net: number;
  amount_due_now: number;
  customer_balance: number;
  next_invoice: { date: number; currency: string; subtotal: number; lines: RecurringLine[] };
  items_after: { price: string; quantity: number; metered: boolean; description: string }[];
  mrr_before: number;
  mrr_after: number;
  mrr_delta: number;
  notices: string[];
}

export interface InvoiceLineTax {
  amount: number;
  rate: string | null;
  display_name: string | null;
  jurisdiction: string | null;
  percentage: string | null;
  tax_type: string | null;
  behavior: string | null;
  reason: string | null;
  explanation: string | null;
  amount_display: string;
}

export interface InvoiceLine {
  object: 'invoice_line_item';
  id: string;
  invoice: string;
  subscription: string | null;
  subscription_item: string | null;
  price: string | null;
  kind: string;
  proration: boolean;
  description: string;
  explanation: string;
  quantity: number;
  amount: number;
  currency: string;
  period: { start: number; end: number };
  proration_fraction: { numerator: number; denominator: number } | null;
  breakdown: BreakdownRow[];
  /** One entry per jurisdiction that taxed this line; `tax` is their rollup. */
  taxes: (InvoiceLineTax & { taxable_amount: number })[];
  tax: InvoiceLineTax;
  released: boolean;
  amount_display: string;
  amount_including_tax: number;
}

export interface TaxSummaryRow {
  object: 'invoice_tax_amount';
  tax_rate: string | null;
  display_name: string;
  jurisdiction: string | null;
  percentage: string;
  tax_type: string | null;
  reason: string | null;
  inclusive: boolean;
  taxable_amount: number;
  amount: number;
  currency: string;
  explanation: string;
  amount_display: string;
}

export interface Invoice {
  object: 'invoice';
  id: string;
  number: string;
  sequence: number;
  customer: string;
  subscription: string | null;
  status: InvoiceStatus;
  billing_reason: string;
  currency: string;
  collection_method: CollectionMethod;
  period: { start: number; end: number };
  arrears_period: { start: number; end: number } | null;
  lines: InvoiceLine[];
  subtotal: number;
  tax: number;
  total_taxes: TaxSummaryRow[];
  balance_applied: number;
  total: number;
  total_excluding_tax: number;
  amount_paid: number;
  amount_due: number;
  /**
   * Cash sent back against this bill's payments. It is recorded here and
   * nowhere else on the invoice: a refund leaves `total`, `amount_paid`,
   * `amount_due` and `status` standing, because a bill the customer settled is
   * settled. Only a chargeback reopens one.
   */
  amount_refunded: number;
  pre_payment_credit_notes_amount: number;
  post_payment_credit_notes_amount: number;
  starting_balance: number;
  ending_balance: number;
  due_date: number | null;
  finalized_at: number | null;
  paid_at: number | null;
  voided_at: number | null;
  marked_uncollectible_at: number | null;
  payment_note: string | null;
  footer: string | null;
  description: string | null;
  created: number;
  /* payload additions */
  customer_name: string | null;
  subtotal_display: string;
  tax_display: string;
  total_display: string;
  amount_due_display: string;
  balance_applied_display: string;
  period_display: string;
  status_detail: string;
  document_url: string;
  reconciles: boolean;
}

export interface CreditNoteLine {
  object: 'credit_note_line_item';
  id: string;
  invoice_line_item: string;
  description: string;
  explanation: string;
  quantity: number;
  amount: number;
  tax_amount: number;
  amount_including_tax: number;
  tax_display_name: string | null;
  tax_percentage: string | null;
  currency: string;
  amount_including_tax_display: string;
}

export interface CreditNote {
  object: 'credit_note';
  id: string;
  number: string;
  invoice: string;
  customer: string;
  currency: string;
  status: 'issued' | 'void';
  reason: string;
  memo: string | null;
  lines: CreditNoteLine[];
  subtotal: number;
  tax: number;
  total: number;
  /** Taken off `amount_due`, because that much of the bill was still owed. */
  pre_payment_amount: number;
  /**
   * How much of `pre_payment_amount` the bill could not absorb because it had
   * already been collected, and which therefore went to the account balance.
   * Zero on a note that fits inside what the bill still owed — including one
   * raised against a bill that has been *part* collected, which is why it is
   * not on its own enough to tell whether anything was collected.
   */
  displaced_to_balance: number;
  /** Handed back because the bill was paid: the three below add up to it. */
  post_payment_amount: number;
  refund_amount: number;
  credit_amount: number;
  out_of_band_amount: number;
  invoice_status_at_issue: InvoiceStatus;
  voided_at: number | null;
  created: number;
  customer_name: string | null;
  invoice_number: string | null;
  subtotal_display: string;
  tax_display: string;
  total_display: string;
  refund_amount_display: string;
  credit_amount_display: string;
  out_of_band_amount_display: string;
  remaining_creditable: number;
  routing_detail: string;
}

/**
 * A line written by hand for a customer's next bill — a commissioning day, an
 * amount agreed on the phone, a goodwill credit. It waits until a bill is
 * raised for that customer and lands on it, taxed at their own rate.
 *
 * `GET /v1/customers/:id/pending_items` does *not* carry these: it reports what
 * a subscription has priced and nothing else. So a screen that shows what the
 * next invoice will hold has to read both lists.
 */
export interface InvoiceItem {
  object: 'invoice_item';
  id: string;
  customer: string;
  subscription: string | null;
  description: string;
  quantity: number;
  unit_amount: number;
  amount: number;
  currency: string;
  tax_behavior: string;
  period: { start: number; end: number };
  status: 'pending' | 'invoiced' | 'withdrawn';
  invoice: string | null;
  created: number;
  updated: number;
  customer_name: string | null;
  invoice_number: string | null;
  amount_display: string;
  unit_amount_display: string;
  status_detail: string;
}

export interface PendingItem {
  object: 'pending_invoice_item';
  id: string;
  customer: string;
  kind: string;
  description: string;
  explanation: string;
  subscription: string;
  price: string;
  quantity: number;
  amount: number;
  currency: string;
  period: { start: number; end: number };
  /** The exact fraction of the period this line covers, as the engine holds it. */
  proration: { numerator: number; denominator: number };
  proration_date: number;
  status: string;
  invoice: string | null;
  created: number;
  breakdown: BreakdownRow[];
}

export interface BilledPeriod {
  object: 'subscription_period';
  id: string;
  subscription: string;
  customer: string;
  period_start: number;
  period_end: number;
  amount: number;
  currency: string;
  status: string;
  invoice: string | null;
}

export interface SchedulePhase {
  object: 'subscription_schedule_phase';
  id: string;
  items: { price: string; quantity: number; custom_unit_amount: number | null }[];
  start_date: number;
  end_date: number;
  iterations: number | null;
  proration_behavior: ProrationBehavior;
  trial_end: number | null;
  description: string | null;
  index: number;
  state: 'complete' | 'current' | 'upcoming';
  summary: string;
  window: string;
}

export interface SubscriptionSchedule {
  object: 'subscription_schedule';
  id: string;
  customer: string;
  subscription: string | null;
  status: ScheduleStatus;
  phases: SchedulePhase[];
  current_phase: number | null;
  end_behavior: 'release' | 'cancel';
  start_date: number;
  current_phase_ends: number | null;
  starts_in_days: number;
  released_at: number | null;
  canceled_at: number | null;
  completed_at: number | null;
  created: number;
  updated: number;
}

export type ScheduleStatus = 'not_started' | 'active' | 'completed' | 'released' | 'canceled';

/** Where this workspace is registered to collect, and at what rate. */
export interface TaxRate {
  object: 'tax_rate';
  id: string;
  display_name: string;
  description: string | null;
  jurisdiction: string;
  country: string;
  state: string | null;
  tax_type: string;
  /** An exact decimal string — never a float. "19", "8.875". */
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

/**
 * Whether the bill a figure predicts can be sent at all. A prediction of
 * "€100.00, no tax" for an account Ain cannot place is a prediction of a bill
 * that will be held as a draft, and a screen that quotes the first without the
 * second is reading out a number nobody will be asked to pay.
 */
export interface AutomaticTax {
  enabled: boolean;
  status: 'complete' | 'requires_location_inputs';
  detail: string;
}

/**
 * The next bill, priced by the same call `issue()` makes.
 *
 * Every one of these figures moves the estimate, which is the whole reason
 * they are listed separately: `subtotal + uninvoiced_total +
 * settled_usage_total - discount_total + tax + balance_applied` is
 * `estimated_total`, exactly. A panel that renders only some of them prints
 * rows that do not add up to the total above them.
 */
export interface NextInvoiceEstimate {
  subscription: string;
  date: number;
  currency: string;
  lines: RecurringLine[];
  /** The taxable base of the recurring lines — not what the price list says. */
  subtotal: number;
  /** Proration already priced and waiting for a bill, on the same basis. */
  uninvoiced_total: number;
  /**
   * Metered usage priced when its window closed, net of the plan's allowance
   * and of prepaid credit, waiting for a bill to claim it. On a usage-priced
   * account this is routinely larger than the plan fee itself.
   */
  settled_usage_total: number;
  /** The discount that will govern this bill, or null when none will. */
  discount: string | null;
  /** Positive minor units that discount takes off the taxable base. */
  discount_total: number;
  tax: number;
  automatic_tax: AutomaticTax;
  balance_applied: number;
  estimated_total: number;
  note: string;
}

export interface CustomerSummary {
  object: 'customer_summary';
  as_of: number;
  customer: Customer;
  headline: string;
  subscriptions: {
    total: number;
    live: number;
    by_status: Partial<Record<SubscriptionStatus, number>>;
    data: {
      id: string;
      status: SubscriptionStatus;
      status_detail: string;
      description: string | null;
      items: { price: string; description: string; quantity: number; metered: boolean; amount: number | null }[];
      currency: string;
      interval: string;
      mrr: number;
      current_period_start: number;
      current_period_end: number;
      renews_in: string;
      cancel_at_period_end: boolean;
      cancel_at: number | null;
      trial_end: number | null;
      collection_method: string;
      /** The schedule managing it, when one is — the summary sends this. */
      schedule: string | null;
    }[];
  };
  mrr: number;
  arr: number;
  balance: { amount: number; currency: string; credit: boolean; description: string; transactions: BalanceTransaction[] };
  lifetime_value: {
    /** Cash collected, net of refunds and credit notes — never an unpaid bill. */
    amount: number;
    currency: string;
    /** What `amount` is, in the words the screen should use beside it. */
    label: string;
    /** How `amount` was arrived at, figure by figure. */
    basis: string;
    collected: number;
    overpaid: number;
    credit_held: number;
    periods_billed: number;
    customer_since: number | null;
    source: string;
  };
  next_invoice: NextInvoiceEstimate | null;
  open_invoices: {
    data: { id: string; number: string | null; status: string; currency: string; total: number; amount_due: number; due_date: number | null; created: number }[];
    total: number;
    oldest_due: number | null;
  };
  uninvoiced_items: { data: PendingItem[]; total: number };
  attention: string[];
}

export interface CurrencyBook {
  currency: string;
  subscriptions: number;
  live: number;
  mrr: number;
  arr: number;
  trial_mrr: number;
  renewing_next_30_days: number;
  scheduled_to_cancel: number;
  average_revenue_per_account: number;
  mrr_display: string;
  arr_display: string;
  trial_mrr_display: string;
}

export interface BillingOverview {
  object: 'billing_overview';
  as_of: number;
  currency: string;
  currencies: string[];
  /** True when the book bills in more than one currency. */
  mixed_currency: boolean;
  subscriptions: number;
  live: number;
  by_status: Record<string, number>;
  /** Minor units summed across every currency — null display when mixed. */
  mrr: number;
  mrr_display: string | null;
  mrr_note: string | null;
  by_currency: CurrencyBook[];
  arr: number;
  trial_mrr: number;
  average_revenue_per_account: number;
  customers: number;
  delinquent_customers: number;
  renewing_next_30_days: number;
  scheduled_to_cancel: number;
  uninvoiced_prorations: number;
  invoices: Record<string, number>;
}

export interface RevenueAccount {
  object: 'revenue_account_row';
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

/** The bounds a negotiated price is sold within, in minor units. */
export interface CustomUnitAmount {
  enabled: boolean;
  minimum: number | null;
  maximum: number | null;
  preset: number | null;
}

/** One band of a tiered price, as the catalog stores it. */
export interface PriceTier {
  up_to: number | null;
  unit_amount: number | null;
  unit_amount_decimal: string | null;
  flat_amount: number | null;
  flat_amount_decimal: string | null;
}

export interface Price {
  object: 'price';
  id: string;
  product: string;
  nickname: string | null;
  lookup_key: string | null;
  active: boolean;
  type: 'recurring' | 'one_time';
  model: string;
  currency: string;
  unit_amount: number | null;
  unit_amount_decimal: string | null;
  billing_scheme: string;
  tiers_mode: string | null;
  tiers: PriceTier[] | null;
  transform_quantity: { divide_by: number; round: string } | null;
  recurring: {
    interval: string; interval_count: number; usage_type: string; meter: string | null;
    aggregate_usage?: string | null; trial_period_days?: number | null;
  } | null;
  tax_behavior: string;
  proration_behavior: ProrationBehavior;
  metadata: Record<string, string>;
  created: number;
  updated: number;
  currencies: string[];
  display: PriceDisplay | null;
  product_name: string;
  unit_label: string | null;
  /** Present on `model: 'custom'` prices — the negotiated amount's bounds. */
  custom_unit_amount: CustomUnitAmount | null;
  /** Per-currency overrides, including that currency's own negotiated bounds. */
  currency_options: Record<string, {
    unit_amount?: number | null;
    unit_amount_decimal?: string | null;
    tiers?: PriceTier[] | null;
    custom_unit_amount?: CustomUnitAmount | null;
  }> | null;
}

/** The price book's own copy, written once on the server so every screen agrees. */
export interface PriceDisplay {
  amount: string | null;
  amount_detail: string | null;
  headline: string | null;
  cadence: string;
  unit: string | null;
  interval: string | null;
  summary: string;
  tiers: string[] | null;
  from: string | null;
  from_amount: number | null;
  cheapest_unit: string | null;
}

/** `GET /v1/prices/:id` — the price plus what has already billed against it. */
export interface PriceDetail extends Price {
  usage: {
    count: number;
    by_type: { type: string; count: number }[];
    summary: string;
    references: { type: string; id: string }[];
    in_use: boolean;
  };
  /** False once anything has billed: amounts and cadence are frozen from then on. */
  editable: boolean;
  boundaries: number[];
}

/** A feature a plan includes, and the key entitlements are granted against. */
export interface ProductFeature {
  name: string;
  lookup_key: string;
  description: string | null;
}

/**
 * A thing this workspace sells. Prices hang off it: the plan is the product,
 * the monthly and annual fees for it are two prices, and the seats and add-ons
 * billed alongside it are more.
 */
export interface Product {
  object: 'product';
  id: string;
  name: string;
  description: string | null;
  statement_descriptor: string | null;
  unit_label: string | null;
  active: boolean;
  images: string[];
  features: ProductFeature[];
  metadata: Record<string, string>;
  tax_code: string | null;
  default_price: string | null;
  category: string;
  tagline: string | null;
  url: string | null;
  position: number;
  created: number;
  updated: number;
  /** Only when the read asked for `expand=prices`. */
  prices?: Price[];
}

/**
 * `POST /v1/catalog/estimate` — a whole basket priced in one currency by the
 * same `computeLineAmount` the invoice engine bills with.
 *
 * This is how a subscription is priced *before* it exists: `create_preview`
 * needs a subscription id, and there is no subscription yet.
 */
export interface EstimateLine {
  object: 'line_amount';
  price: string;
  currency: string;
  quantity: number;
  billable_quantity: number;
  amount: number;
  amount_decimal: string;
  effective_unit_amount_decimal: string;
  marginal_unit_amount_decimal: string;
  breakdown: BreakdownRow[];
  nickname: string | null;
  product: { id: string; name: string; unit_label: string | null } | null;
  interval: { unit: string; count: number } | null;
  amount_display: string;
  warning: { code: string; param: string; message: string } | null;
}

export interface CatalogEstimate {
  object: 'catalog_estimate';
  currency: string;
  lines: EstimateLine[];
  warnings: { price: string; code: string; param: string; message: string }[];
  recurring: {
    day: number; week: number; month: number; year: number;
    monthly_equivalent: number;
    monthly_equivalent_display: string;
  };
  one_time: number;
  one_time_display: string;
  due_today: number;
  due_today_display: string;
}

export interface PaymentMethod {
  object: 'payment_method';
  id: string;
  type: string;
  customer: string | null;
  status: string;
  default_for_customer: boolean;
  display_name: string;
  card: { brand: string; last4: string; exp_month: number; exp_year: number; funding: string } | null;
  bank_debit: { bank_name: string; last4: string; account_type: string; mandate_reference: string | null } | null;
  simulated: { behavior: string; explanation: string } | null;
  created: number;
}

export interface CreditGrant {
  object: 'credit_grant';
  id: string;
  customer: string;
  name: string;
  category: string;
  kind: 'monetary' | 'unit';
  currency: string;
  unit_label: string | null;
  amount: number;
  balance: number;
  applies_to: string;
  effective_at: number;
  expires_at: number | null;
  status: string;
  source: string;
}

export interface CreditBalance {
  object: 'credit_balance';
  customer: string;
  as_of: number;
  balances: {
    key: string;
    currency: string;
    kind: 'monetary' | 'unit';
    unit_label: string | null;
    applies_to: string;
    available: number;
    by_category: { paid: number; promotional: number };
    next_expiry: { at: number; amount: number; grant_name: string } | null;
  }[];
  totals_by_currency: { currency: string; monetary_available: number; unit_pots: number; next_expiry: number | null }[];
  scheduled: CreditGrant[];
  burn_order: string[];
}

/* --------------------- what was collected against a bill ------------------ */

export interface ChargeOutcome {
  type: string;
  network_status: string | null;
  reason: string | null;
  risk_level: string | null;
  risk_score: number | null;
  seller_message: string | null;
  explanation: string | null;
}

export interface Charge {
  object: 'charge';
  id: string;
  payment_intent: string | null;
  customer: string;
  payment_method: string | null;
  invoice: string | null;
  subscription: string | null;
  amount: number;
  amount_refunded: number;
  amount_disputed: number;
  currency: string;
  status: string;
  paid: boolean;
  refunded: boolean;
  disputed: boolean;
  failure_code: string | null;
  failure_message: string | null;
  authorization_code: string | null;
  outcome: ChargeOutcome | null;
  created: number;
}

export interface Refund {
  object: 'refund';
  id: string;
  charge: string | null;
  payment_intent: string | null;
  customer: string;
  invoice: string | null;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  description: string | null;
  /** What the refund did to the bill, in the gateway's own words. */
  invoice_effect: string | null;
  created: number;
}

export interface Dispute {
  object: 'dispute';
  id: string;
  charge: string | null;
  amount: number;
  currency: string;
  reason: string;
  status: string;
  evidence_due_by: number | null;
  submitted_at: number | null;
  closed_at: number | null;
  outcome_note: string | null;
  created: number;
}

/** One presentation the schedule made — or deliberately did not make. */
export interface DunningAttempt {
  object: 'dunning_attempt';
  id: string;
  dunning: string;
  invoice: string;
  attempt_number: number;
  scheduled_for: number;
  attempted_at: number;
  payment_method: string | null;
  charge: string | null;
  amount: number;
  currency: string;
  outcome: string;
  failure_code: string | null;
  failure_message: string | null;
  /** What this attempt decided to do next, and why. */
  decision: string;
  next_attempt_at: number | null;
}

/**
 * `GET /v1/dunning/:id`, and the `dunning` block on `GET /v1/invoices/:id/
 * payments` — the whole recovery campaign against one bill.
 */
export interface InvoiceDunning {
  object: 'dunning';
  id: string;
  invoice: string;
  customer: string;
  subscription: string | null;
  currency: string;
  amount_at_risk: number;
  recovered_amount: number;
  status: string;
  attempt_count: number;
  max_attempts: number;
  /** The gaps between attempts, in days — not offsets from the first failure. */
  retry_days: number[];
  end_behavior: string;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  last_failure_code: string | null;
  last_failure_message: string | null;
  started_at: number;
  resolved_at: number | null;
  resolution: string | null;
  end_behavior_applied: string | null;
  customer_name: string;
  invoice_number: string;
  subscription_status: string | null;
  attempts_remaining: number;
  payment_method: PaymentMethod | null;
  attempts: DunningAttempt[];
  /** What a human should do about this account today. */
  recommended_action: string;
  needs_human: boolean;
}

/** The workspace's retry policy — `GET`/`PATCH /v1/payments/settings`. */
export interface DunningPolicy {
  retry_days: number[];
  max_attempts: number;
  end_behavior: string;
  skip_weekends: boolean;
  hard_decline_multiplier: number;
  collection_hour: number;
  jitter_hours: number;
  give_up_codes: string[];
}

export interface PaymentSettings {
  object: 'payment_settings';
  dunning: DunningPolicy;
  defaults: DunningPolicy;
  /** The schedule as a paragraph, written by the engine that runs it. */
  schedule_explained: string;
}

/**
 * One presentation of money against a bill, in the state machine's own words.
 *
 * `processing` and `requires_action` are the two states a payments UI usually
 * hides, and hiding them is how an operator is told a direct debit failed while
 * the bank has simply not answered yet.
 */
export interface PaymentIntent {
  object: 'payment_intent';
  id: string;
  customer: string;
  payment_method: string | null;
  invoice: string | null;
  amount: number;
  currency: string;
  status: string;
  description: string | null;
  attempt_count: number;
  next_action: { type: string; description?: string; authenticate_at?: string } | null;
  last_payment_error: { code: string; message: string; advice: string | null } | null;
  latest_charge: string | null;
  succeeded_at: number | null;
  canceled_at: number | null;
  /** Who raised it: the API, the collector, a retry, or a person. */
  source: 'api' | 'invoice_collection' | 'dunning_retry' | 'manual_retry';
  created: number;
}

/** `GET /v1/invoices/:id/payments` — every attempt made against one bill. */
export interface InvoicePayments {
  object: 'invoice_payments';
  invoice: string;
  number: string;
  customer: string;
  currency: string;
  total: number;
  amount_paid: number;
  amount_due: number;
  amount_overpaid: number;
  amount_refunded: number;
  amount_disputed: number;
  cash_collected: number;
  collectable: boolean;
  collectable_note: string | null;
  payment_intents: PaymentIntent[];
  charges: Charge[];
  refunds: Refund[];
  disputes: Dispute[];
  dunning: InvoiceDunning | null;
  summary: string;
}

/** `GET /v1/catalog/currencies` — a currency this price book already quotes in. */
export interface CatalogCurrency {
  object: 'catalog_currency';
  code: string;
  name: string;
  symbol: string;
  /** How many prices carry an amount in it. */
  prices: number;
  default: boolean;
}

/** `POST /v1/prices/:id/preview` — one quantity, priced with the arithmetic shown. */
export interface PricePreview {
  object: 'price_preview';
  price: string;
  currency: string;
  quantity: number;
  billable_quantity: number;
  amount: number;
  amount_display: string;
  effective_unit_display: string;
  marginal_unit_display: string;
  product: { id: string; name: string; unit_label: string | null } | null;
  warning: { code: string; param: string; message: string } | null;
  breakdown: (BreakdownRow & { amount_display: string; unit_display: string | null })[];
}

/* ------------------------- coupons and promotion codes -------------------- */

export type CouponDuration = 'once' | 'repeating' | 'forever';

/** What a coupon may touch. Both lists empty means the whole bill. */
export interface CouponAppliesTo {
  products: string[];
  prices: string[];
}

/** `GET /v1/coupons` — the stored terms, plus what the catalogue says they mean. */
export interface Coupon {
  object: 'coupon';
  id: string;
  /** The internal label — "Q1 land-and-expand", not the code a customer types. */
  name: string | null;
  percent_off: number | null;
  /** Hundredths of a percent: 2000 is 20%. The figure the arithmetic reads. */
  percent_off_basis_points: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: CouponDuration;
  duration_in_periods: number | null;
  max_redemptions: number | null;
  /** Counted from the redemption rows, never from a column that can drift. */
  times_redeemed: number;
  redeem_by: number | null;
  applies_to: CouponAppliesTo;
  /** False once archived: unredeemable, but still explaining the bills it cut. */
  active: boolean;
  /** Active, in date and not exhausted — the one field a checkout reads. */
  valid: boolean;
  metadata: Record<string, string>;
  created: number;
  updated: number;
  livemode: boolean;
  summary: string;
  percent_off_display: string | null;
  amount_off_display: string | null;
  redemptions_remaining: number | null;
  invalid_reason: 'inactive' | 'expired' | 'exhausted' | null;
  invalid_message: string | null;
}

/** `GET /v1/coupons/:id` — with the codes that hand it out. */
export interface CouponDetail extends Coupon {
  promotion_codes: PromotionCode[];
  /** Its terms freeze on first redemption, exactly as a price freezes. */
  editable: boolean;
}

export interface PromotionCodeRestrictions {
  minimum_amount: number | null;
  minimum_amount_currency: string | null;
  first_time_transaction: boolean;
}

/** `GET /v1/promotion_codes` — one way of handing a coupon out. */
export interface PromotionCode {
  object: 'promotion_code';
  id: string;
  code: string;
  coupon: string;
  active: boolean;
  expires_at: number | null;
  max_redemptions: number | null;
  max_redemptions_per_customer: number | null;
  times_redeemed: number;
  restrictions: PromotionCodeRestrictions;
  valid: boolean;
  metadata: Record<string, string>;
  created: number;
  updated: number;
  livemode: boolean;
  redemptions_remaining: number | null;
  minimum_amount_display: string | null;
}

/** `GET /v1/coupons/:id/redemptions` — one take-up, and what holds it. */
export interface CouponRedemption {
  object: 'coupon_redemption';
  id: string;
  coupon: string;
  promotion_code: string | null;
  customer: string | null;
  ref: { type: string; id: string } | null;
  created: number;
}
