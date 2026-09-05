/**
 * The credits object model.
 *
 * A grant is a promise: this customer may draw this much, against these
 * charges, between these two instants. The ledger is the record of that promise
 * being kept — every grant, burn, expiry, void, refund and rollover, each
 * carrying the balance as it stood immediately afterwards.
 */

export const CREDIT_CATEGORIES = ['paid', 'promotional'] as const;
export const CREDIT_KINDS = ['monetary', 'unit'] as const;
export const ROLLOVER_POLICIES = ['none', 'capped', 'full'] as const;
export const GRANT_STATUSES = ['scheduled', 'active', 'exhausted', 'expired', 'voided'] as const;
export const LEDGER_ENTRY_TYPES = [
  'grant', 'burn', 'expiry', 'void', 'refund', 'rollover_in', 'rollover_out', 'adjustment',
] as const;
export const GRANT_SOURCES = ['manual', 'topup', 'rollover', 'plan', 'trial'] as const;
export const BILLABLE_ITEM_KINDS = ['topup', 'credit_covered', 'charged', 'true_up'] as const;
export const BILLABLE_ITEM_STATUSES = ['pending', 'invoiced', 'void'] as const;

export type CreditCategory = (typeof CREDIT_CATEGORIES)[number];
export type CreditKind = (typeof CREDIT_KINDS)[number];
export type RolloverPolicy = (typeof ROLLOVER_POLICIES)[number];
export type GrantStatus = (typeof GRANT_STATUSES)[number];
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];
export type GrantSource = (typeof GRANT_SOURCES)[number];
export type BillableItemKind = (typeof BILLABLE_ITEM_KINDS)[number];
export type BillableItemStatus = (typeof BILLABLE_ITEM_STATUSES)[number];

/**
 * What a grant may pay for. `all` covers every charge in its currency;
 * `targeted` matches a charge whose price, meter or product is listed.
 */
export interface Applicability {
  scope: 'all' | 'targeted';
  prices: string[];
  meters: string[];
  products: string[];
}

export const ALL_CHARGES: Applicability = { scope: 'all', prices: [], meters: [], products: [] };

/** The charge a burn is being tested against. */
export interface ChargeTarget {
  currency: string;
  price?: string | null;
  meter?: string | null;
  product?: string | null;
}

export interface CreditGrant {
  object: 'credit_grant';
  id: string;
  customer: string;
  name: string;
  category: CreditCategory;
  kind: CreditKind;
  currency: string;
  /** Unit grants are denominated in one meter's units and only pay for it. */
  meter: string | null;
  unit_label: string | null;
  /** Granted amount: minor units when monetary, meter units when unit-denominated. */
  amount: number;
  amount_decimal: string;
  /** Sum of the ledger. Never stored, always derived. */
  balance: number;
  balance_decimal: string;
  applicability: Applicability;
  /** A human sentence describing what this grant may be spent on. */
  applies_to: string;
  effective_at: number;
  expires_at: number | null;
  priority: number;
  rollover: RolloverPolicy;
  rollover_cap: number | null;
  status: GrantStatus;
  /**
   * True while the purchase that bought this credit is still an unbilled line.
   * The grant exists and its ledger is open, but nothing may be drawn from it:
   * a customer never holds spendable credit nobody has been charged for.
   */
  awaiting_payment: boolean;
  /** The purchase line that has to reach an invoice before this is spendable. */
  pending_purchase: string | null;
  source: GrantSource;
  source_ref: string | null;
  metadata: Record<string, string>;
  created: number;
  updated: number;
}

export interface LedgerEntry {
  object: 'credit_ledger_entry';
  id: string;
  grant: string;
  customer: string;
  /** Position in this grant's ledger, starting at 1. */
  seq: number;
  type: LedgerEntryType;
  delta: number;
  delta_decimal: string;
  /** The grant's balance immediately after this entry. */
  balance_after: number;
  balance_after_decimal: string;
  currency: string;
  kind: CreditKind;
  reason: string;
  ref_type: string | null;
  ref_id: string | null;
  period_start: number | null;
  period_end: number | null;
  metadata: Record<string, string>;
  created: number;
}

/** One grant's contribution to one charge. */
export interface CreditApplication {
  grant: string;
  grant_name: string;
  category: CreditCategory;
  kind: CreditKind;
  expires_at: number | null;
  priority: number;
  /** Units drawn for a unit grant, minor units for a monetary grant. */
  drawn: number;
  drawn_decimal: string;
  /** Money this application took off the charge, in minor units. */
  amount: number;
  balance_after: number;
  balance_after_decimal: string;
  ledger_entry: string;
}

export interface BillableItem {
  object: 'credit_billable_item';
  id: string;
  customer: string;
  settlement: string | null;
  grant: string | null;
  kind: BillableItemKind;
  description: string;
  currency: string;
  /** The value of this portion of the charge, in minor units. */
  amount: number;
  /** What the customer actually pays for it — zero on a credit-covered line. */
  billed_amount: number;
  credit_applied: number;
  quantity: number;
  quantity_decimal: string;
  unit_label: string | null;
  price: string | null;
  meter: string | null;
  period_start: number | null;
  period_end: number | null;
  status: BillableItemStatus;
  invoice: string | null;
  invoice_item: string | null;
  metadata: Record<string, string>;
  created: number;
  updated: number;
}

export const SETTLEMENT_STATUSES = ['settled', 'skipped'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/**
 * Why a period was not settled, and whether that cost anybody money.
 *
 * `coverage_percent` is the honest half: a window refused because a settled
 * window already covers all of it lost nothing, and one refused with a gap in
 * the middle is unbilled usage a human has to look at.
 */
export interface SettlementSkip {
  reason: string;
  message: string;
  superseded_by: string | null;
  subscription: string | null;
  subscription_item: string | null;
  /** Settlements whose windows overlap the one that was refused. */
  covered_by: string[];
  window_ms: number;
  covered_ms: number;
  coverage_percent: number;
  /**
   * Sub-windows of the refused period no settlement covers. `overdue` means the
   * hole has outlived a whole billing cycle, so nothing is coming to fill it.
   */
  gaps: { start: number; end: number; overdue: boolean }[];
  /**
   * The billing cycle the refused window belonged to, as the run stated it.
   * A gap filled later is priced against this rather than from the bottom of
   * the tier ladder, so filling a hole costs what the hole costs.
   */
  billing_period: { start: number; end: number } | null;
  summary: string;
}

/**
 * Where on the price's tiers this window was priced from.
 *
 * A graduated price gives its first units away once per billing period, not
 * once per settlement. When a period is billed in more than one window — a plan
 * change mid-cycle, a cancel and restart, a gap settled on its own — every
 * window after the first is priced marginally, from the units the earlier ones
 * already consumed. That is what makes any partition of a period cost exactly
 * what the whole period costs.
 */
export interface TierBasis {
  /** The billing period the ladder belongs to. */
  period_start: number;
  period_end: number;
  /**
   * `stated` when the caller named the billing period, `derived` when it was
   * counted back one cadence from a boundary this window shares, and `window`
   * when the price has no cadence to derive a cycle from. The period reported
   * above is widened where it has to be to hold every settlement it counted.
   */
  source: 'stated' | 'derived' | 'window';
  /** Units of this billing period already settled under earlier windows. */
  prior_quantity: number;
  prior_quantity_decimal: string;
  /** What those units alone cost on this price — the rung this window starts on. */
  prior_amount: number;
  /** Prior plus this window, which is what the price was actually evaluated at. */
  cumulative_quantity: number;
  cumulative_quantity_decimal: string;
  cumulative_amount: number;
  /** The settlements the prior quantity came from. */
  settlements: string[];
  /** The whole thing in one sentence, for the invoice's "why is this line here". */
  explanation: string;
}

export interface Settlement {
  object: 'credit_settlement';
  id: string;
  /** `skipped` rows carry no money — they are a refusal, kept where it shows. */
  status: SettlementStatus;
  skip: SettlementSkip | null;
  subscription: string | null;
  subscription_item: string | null;
  customer: string;
  meter: string | null;
  price: string;
  currency: string;
  period_start: number;
  period_end: number;
  /** Exact metered usage for the period. */
  quantity: number;
  quantity_decimal: string;
  /** Whole units the price book billed, rounded half-up exactly once. */
  billed_quantity: number;
  /** The tier position this window was priced from, and why. */
  tier_basis: TierBasis;
  /** Units removed from the bill by unit-denominated credits. */
  covered_quantity: number;
  charged_quantity: number;
  /** What the period would have cost with no credits at all. */
  full_amount: number;
  covered_amount: number;
  charged_amount: number;
  unit_credit_amount: number;
  monetary_credit_amount: number;
  applications: CreditApplication[];
  /** The two halves of the bill, which always sum to `full_amount`. */
  lines: BillableItem[];
  /** What has moved since, each one a signed line of its own. */
  true_ups: BillableItem[];
  /** `full_amount` after every true-up — what the period is worth today. */
  net_amount: number;
  net_charged_amount: number;
  /** The order the grants were drawn in, in words. */
  burn_order: string[];
  created: number;
}

export interface BalanceBucket {
  /** Stable key for this (currency, denomination, applicability) pot. */
  key: string;
  currency: string;
  kind: CreditKind;
  meter: string | null;
  unit_label: string | null;
  applicability: Applicability;
  applies_to: string;
  available: number;
  available_decimal: string;
  by_category: { paid: number; promotional: number };
  next_expiry: { at: number; amount: number; amount_decimal: string; grant: string; grant_name: string } | null;
  grants: CreditGrant[];
}

export interface CreditBalance {
  object: 'credit_balance';
  customer: string;
  as_of: number;
  /** Per currency, per denomination, per applicability. */
  balances: BalanceBucket[];
  totals_by_currency: {
    currency: string;
    monetary_available: number;
    unit_pots: number;
    next_expiry: number | null;
  }[];
  scheduled: CreditGrant[];
  burn_order: string[];
}

export interface GrantInput {
  id?: string;
  customer: string;
  name?: string;
  category?: CreditCategory;
  kind?: CreditKind;
  currency?: string;
  meter?: string | null;
  unit_label?: string | null;
  /** Minor units for a monetary grant, meter units for a unit grant. */
  amount: number | string;
  applicability?: Partial<Applicability>;
  effective_at?: number;
  expires_at?: number | null;
  priority?: number;
  rollover?: RolloverPolicy;
  rollover_cap?: number | string | null;
  source?: GrantSource;
  source_ref?: string | null;
  metadata?: Record<string, string>;
  reason?: string;
}

export interface TopUpInput {
  customer: string;
  /** The credit-pack price the customer is buying. */
  price: string;
  quantity?: number;
  currency?: string;
  /** Overrides the granted amount, for "pay for 10, get 11" packs. */
  grant_amount?: number | string;
  kind?: CreditKind;
  category?: CreditCategory;
  name?: string;
  effective_at?: number;
  expires_at?: number | null;
  priority?: number;
  rollover?: RolloverPolicy;
  rollover_cap?: number | string | null;
  applicability?: Partial<Applicability>;
  metadata?: Record<string, string>;
}

export interface TopUpResult {
  object: 'credit_topup';
  grant: CreditGrant;
  line: BillableItem;
  /** What the customer pays for the pack, in minor units. */
  amount: number;
  currency: string;
  quantity: number;
  /** The invoice the purchase was charged on, raised as part of this call. */
  invoice: string | null;
  /**
   * Why the charge could not be raised here, when it could not. The grant is
   * held unspendable until it is, and the daily purchase watch keeps trying.
   */
  charge_deferred: { code: string; message: string } | null;
  created: number;
}

export interface SettleUsageInput {
  customer: string;
  price: string;
  meter?: string | null;
  period_start: number;
  period_end: number;
  /** Overrides the metered total, for a price with no meter behind it. */
  quantity?: number;
  currency?: string;
  idem_key?: string;
  /**
   * Freeze the meter period as billed at the same time.
   *
   * Defaults to true whenever the settlement resolved a meter, because that is
   * the instant the meter's total goes onto an invoice: from here on, usage
   * that lands inside the window is a late arrival and a priced true-up rather
   * than a number that quietly disagrees with a bill already sent. Pass `false`
   * to price a window without claiming it has been billed — a quote, a
   * what-if, or a quantity supplied by hand for a price whose meter is not
   * what the invoice is drawn on.
   */
  close_period?: boolean;
  /**
   * The billing period this window belongs to, when it is only part of one.
   * The price's tiers are evaluated across the whole of it, so two halves of a
   * month cost exactly what the month costs. Left out, it is derived from the
   * price's own cadence, ending where this window ends.
   */
  billing_period_start?: number;
  billing_period_end?: number;
  /** Carried onto the settlement so a refusal can name who lost the period. */
  subscription?: string | null;
  subscription_item?: string | null;
}

/** A period the automatic settlement run refused, recorded as a row. */
export interface SkipSettlementInput {
  customer: string;
  price: string;
  currency?: string | null;
  period_start: number;
  period_end: number;
  subscription?: string | null;
  subscription_item?: string | null;
  reason: string;
  message: string;
  superseded_by?: string | null;
  /**
   * The cycle the refused window belonged to. Kept because the window itself
   * is not always the cycle — a stub period after a cancel is part of a longer
   * one — and a settlement that fills this window's gap later has to climb the
   * same tier ladder the run would have climbed.
   */
  billing_period?: { start: number; end: number } | null;
}

/**
 * What a settlement request did.
 *
 * A window that has already been settled is never settled again: the first
 * settlement is handed back exactly as it stands, which is a read and not a
 * write. The difference matters to the caller — re-settling a period whose
 * meter has moved since it was billed has to show the movement rather than
 * look like a fresh success.
 */
export interface SettlementResult {
  settlement: Settlement;
  /** False when this request found the settlement already there. */
  created: boolean;
  /** What the meter says about the window now, when it no longer agrees. */
  drift: SettlementDrift | null;
}

/** How far a settled window's meter has moved since it was billed. */
export interface SettlementDrift {
  /** The total the settlement was drawn on. */
  settled_quantity: number;
  settled_quantity_decimal: string;
  /** What the same window aggregates to right now. */
  live_quantity: number;
  live_quantity_decimal: string;
  delta: number;
  delta_decimal: string;
  /** The closure that froze the window, when it was closed. */
  closure: string | null;
  /** Late arrivals filed against that closure and still waiting for a true-up. */
  open_late_arrivals: string[];
  /** What the movement is worth on the price the period was billed against. */
  outstanding_amount: number | null;
  currency: string;
  /** The whole thing in one sentence, including what to do about it. */
  message: string;
}
