/**
 * The billing object model: who is billed (customers) and what they are
 * billed for over time (subscriptions, items, schedules).
 *
 * Two conventions run through the whole module and are worth stating once:
 *
 *  1. **Money is a signed integer in the currency's minor unit.** A credit is a
 *     negative amount, never a separate "credit" field, so every total in this
 *     module is a plain sum.
 *  2. **`customer.balance` follows Stripe's sign convention** — a *negative*
 *     balance is credit the customer holds, which reduces the next invoice; a
 *     positive balance is money owed that will be added to it.
 */
import type { ProrationBehavior, TaxBehavior } from '../catalog/types';
import type { LineBreakdownRow } from '../catalog/types';
import type { IntervalUnit } from '../../../shared/time';
import type { TaxExemption, TaxIdVerificationStatus, TaxReason, TaxSummaryRow, TaxType } from './tax';

export type { ProrationBehavior };

/**
 * A billing cadence: "every month", "every 3 months", "every year". It travels
 * as its own object because a change to a subscription's items can change it,
 * and a cadence that moves without being noticed is how an annual price ends up
 * billing monthly.
 */
export interface Cadence {
  interval: IntervalUnit;
  interval_count: number;
}

/* ------------------------------- enumerations ----------------------------- */

export const SUBSCRIPTION_STATUSES = [
  'trialing', 'incomplete', 'incomplete_expired', 'active', 'past_due', 'paused', 'canceled', 'unpaid',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const COLLECTION_METHODS = ['charge_automatically', 'send_invoice'] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export const PAUSE_BEHAVIORS = ['keep_as_draft', 'mark_uncollectible', 'void'] as const;
export type PauseBehavior = (typeof PAUSE_BEHAVIORS)[number];

/** What to do when a trial ends and there is still no way to charge. */
export const TRIAL_END_BEHAVIORS = ['create_invoice', 'cancel', 'pause'] as const;
export type TrialEndBehavior = (typeof TRIAL_END_BEHAVIORS)[number];

/**
 * `default_incomplete` holds the subscription until the first invoice is paid;
 * `allow_incomplete` starts it straight away. There is deliberately no
 * "error if the payment fails" option: billing has no card to charge, so it
 * could not honour one, and an option that cannot be honoured is a lie.
 */
export const PAYMENT_BEHAVIORS = ['allow_incomplete', 'default_incomplete'] as const;
export type PaymentBehavior = (typeof PAYMENT_BEHAVIORS)[number];

export const CANCELLATION_REASONS = [
  'cancellation_requested', 'payment_failed', 'payment_disputed', 'trial_ended_without_payment_method',
  'schedule_ended', 'downgraded', 'lost_to_competitor', 'went_out_of_business', 'too_expensive',
  'missing_features', 'switched_to_annual', 'other',
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export const SCHEDULE_STATUSES = ['not_started', 'active', 'completed', 'released', 'canceled'] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const SCHEDULE_END_BEHAVIORS = ['release', 'cancel'] as const;
export type ScheduleEndBehavior = (typeof SCHEDULE_END_BEHAVIORS)[number];

export const BALANCE_TRANSACTION_TYPES = [
  'proration_credit', 'proration_debit', 'adjustment', 'applied_to_invoice', 'invoice_overpayment',
  'cancellation_credit', 'migration', 'credit_note', 'credit_note_voided',
] as const;
export type BalanceTransactionType = (typeof BALANCE_TRANSACTION_TYPES)[number];

export const PENDING_ITEM_KINDS = ['unused_time', 'remaining_time', 'immediate', 'metered'] as const;
export type PendingItemKind = (typeof PENDING_ITEM_KINDS)[number];

/**
 * `pending` is waiting for a bill, `invoiced` has been claimed by one. Nothing
 * written today is `credited`: that was the resting state of a proration set
 * that netted negative, back when such a set was moved to the customer balance
 * instead of being invoiced — which is exactly how the tax on it was lost. The
 * state stays readable so rows written then still hydrate.
 */
export const PENDING_ITEM_STATUSES = ['pending', 'invoiced', 'credited', 'voided'] as const;
export type PendingItemStatus = (typeof PENDING_ITEM_STATUSES)[number];

export const PERIOD_STATUSES = ['trial', 'billed', 'paused', 'canceled'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

/* -------------------------------- customers ------------------------------- */

export interface Address {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}

export interface Shipping {
  name: string | null;
  phone: string | null;
  address: Address | null;
}

/**
 * What checking a registration number found.
 *
 * `pending` is the shape checked and the register not yet asked; `verified` is
 * the register's own answer, and it is the only state that shifts tax onto the
 * customer. Anything else and the supplier charges the tax, because the
 * supplier is the one the tax authority comes to for it.
 */
export interface TaxIdVerification {
  status: TaxIdVerificationStatus;
  /** The name the register holds, when it gave one back. */
  verified_name: string | null;
  verified_address: string | null;
  /** When the register was asked. Null until it has been. */
  checked_at: number | null;
  /** What the status means, in the words the invoice will use. */
  note: string | null;
}

/** A registered tax identifier — VAT, GST, EIN, ABN and friends. */
export interface TaxId {
  type: string;
  value: string;
  country: string | null;
  verification: TaxIdVerification;
}

export interface CustomFieldEntry {
  name: string;
  value: string;
}

export interface InvoiceSettings {
  default_payment_method: string | null;
  /** Net terms for `send_invoice` collection. Null means "due on receipt". */
  days_until_due: number | null;
  custom_fields: CustomFieldEntry[];
  footer: string | null;
}

export interface Customer {
  object: 'customer';
  id: string;
  name: string;
  email: string | null;
  description: string | null;
  phone: string | null;
  /** Fixed once the customer has a subscription or an invoice. */
  currency: string;
  currency_locked: boolean;
  address: Address | null;
  shipping: Shipping | null;
  tax_ids: TaxId[];
  /**
   * Stripe's three states. `exempt` means a certificate is on file; `reverse`
   * means the customer accounts for the tax whatever their registration says.
   * On `none` the registration numbers decide it.
   */
  tax_exempt: TaxExemption;
  invoice_settings: InvoiceSettings;
  /** Negative is credit the customer holds; positive is money carried forward. */
  balance: number;
  delinquent: boolean;
  preferred_locales: string[];
  metadata: Record<string, string>;
  /** The CRM company this customer is the billing face of. */
  crm_record_id: string | null;
  created: number;
  updated: number;
  livemode: boolean;
}

export interface BalanceTransaction {
  object: 'customer_balance_transaction';
  id: string;
  customer: string;
  /** Signed: negative grants credit, positive takes it back. */
  amount: number;
  ending_balance: number;
  currency: string;
  type: BalanceTransactionType;
  description: string;
  subscription: string | null;
  invoice: string | null;
  created: number;
}

/* ------------------------------ subscriptions ----------------------------- */

export interface SubscriptionItem {
  object: 'subscription_item';
  id: string;
  subscription: string;
  price: string;
  /** Metered items carry a quantity of 1; the billed quantity comes from usage. */
  quantity: number;
  metered: boolean;
  /** The agreed amount for a negotiated (`custom`) price, in minor units. */
  custom_unit_amount: number | null;
  metadata: Record<string, string>;
  created: number;
  updated: number;
}

export interface PauseCollection {
  behavior: PauseBehavior;
  resumes_at: number | null;
}

export interface TrialSettings {
  end_behavior: { missing_payment_method: TrialEndBehavior };
}

export interface Subscription {
  object: 'subscription';
  id: string;
  customer: string;
  status: SubscriptionStatus;
  items: SubscriptionItem[];
  currency: string;
  /** Every recurring item on a subscription shares one billing interval. */
  interval: IntervalUnit;
  interval_count: number;
  /** The instant every future period is measured from. */
  billing_cycle_anchor: number;
  /** 1–31. Kept separately so a 31st anchor survives February. */
  billing_cycle_anchor_day: number;
  current_period_start: number;
  current_period_end: number;
  start_date: number;
  ended_at: number | null;
  canceled_at: number | null;
  cancel_at: number | null;
  cancel_at_period_end: boolean;
  cancellation_reason: CancellationReason | null;
  cancellation_comment: string | null;
  trial_start: number | null;
  trial_end: number | null;
  trial_from_plan: boolean;
  trial_settings: TrialSettings;
  collection_method: CollectionMethod;
  days_until_due: number | null;
  default_payment_method: string | null;
  pause_collection: PauseCollection | null;
  /** The default applied to changes that do not name their own behaviour. */
  proration_behavior: ProrationBehavior;
  schedule: string | null;
  description: string | null;
  metadata: Record<string, string>;
  created: number;
  updated: number;
  livemode: boolean;
}

/* -------------------------------- schedules ------------------------------- */

export interface SchedulePhaseItem {
  price: string;
  quantity: number;
  custom_unit_amount: number | null;
  metadata: Record<string, string>;
}

export interface SchedulePhase {
  object: 'subscription_schedule_phase';
  id: string;
  items: SchedulePhaseItem[];
  start_date: number;
  end_date: number;
  /** How many billing intervals this phase runs for, when it was sized that way. */
  iterations: number | null;
  proration_behavior: ProrationBehavior;
  trial_end: number | null;
  collection_method: CollectionMethod | null;
  days_until_due: number | null;
  description: string | null;
  metadata: Record<string, string>;
}

export interface SubscriptionSchedule {
  object: 'subscription_schedule';
  id: string;
  customer: string;
  subscription: string | null;
  status: ScheduleStatus;
  phases: SchedulePhase[];
  current_phase: number | null;
  end_behavior: ScheduleEndBehavior;
  released_at: number | null;
  canceled_at: number | null;
  completed_at: number | null;
  start_date: number;
  metadata: Record<string, string>;
  created: number;
  updated: number;
  livemode: boolean;
}

/* ------------------------------- money movement --------------------------- */

/**
 * One proration line. It carries the period it covers, the exact fraction it
 * was scaled by and the tier-by-tier breakdown behind it, so any number on an
 * invoice can be re-derived and explained years later.
 */
export interface ProrationLine {
  object: 'proration_line';
  kind: PendingItemKind;
  description: string;
  /** Prose that reconstructs the arithmetic: price x fraction = amount. */
  explanation: string;
  subscription: string;
  subscription_item: string | null;
  price: string;
  quantity: number;
  /** Signed minor units — credits are negative. */
  amount: number;
  currency: string;
  period: { start: number; end: number };
  proration: { numerator: number; denominator: number };
  proration_date: number;
  breakdown: LineBreakdownRow[];
}

export interface PendingInvoiceItem extends Omit<ProrationLine, 'object'> {
  object: 'pending_invoice_item';
  id: string;
  customer: string;
  status: PendingItemStatus;
  invoice: string | null;
  created: number;
}

/** A billing period the subscription has actually entered — the revenue ledger. */
export interface BilledPeriod {
  object: 'subscription_period';
  id: string;
  subscription: string;
  customer: string;
  period_start: number;
  period_end: number;
  /** Recurring subtotal recognised for the period, in minor units. */
  amount: number;
  currency: string;
  status: PeriodStatus;
  invoice: string | null;
  created: number;
}

/** A recurring line for a whole period — the shape of the next invoice. */
export interface RecurringLine {
  /** Null in a preview, for an item that does not exist yet. */
  subscription_item: string | null;
  price: string;
  description: string;
  quantity: number;
  /** Null for metered items: the quantity is not known until the period closes. */
  amount: number | null;
  currency: string;
  metered: boolean;
  period: { start: number; end: number };
  breakdown: LineBreakdownRow[];
}

export interface ChangePreview {
  object: 'subscription_change_preview';
  subscription: string;
  customer: string;
  currency: string;
  proration_date: number;
  proration_behavior: ProrationBehavior;
  /** The period the credits are measured against. */
  current_period: { start: number; end: number };
  /** The period the charges cover — different only when the anchor is reset. */
  next_period: { start: number; end: number };
  /** The cadence the subscription bills on today. */
  interval_before: Cadence;
  /**
   * The cadence it bills on after this change. Different from `interval_before`
   * when the items move to prices on another cycle — which always re-anchors
   * the subscription, because an annual price cannot run on a monthly period.
   */
  interval_after: Cadence;
  lines: ProrationLine[];
  credit_total: number;
  charge_total: number;
  net: number;
  /**
   * What would be collected immediately — the `amount_due` of the bill
   * `always_invoice` raises, tax and account balance included, never the
   * pre-tax `net` above. A negative net is never collected and never paid out:
   * its lines go onto a bill, where they are taxed exactly as the charges they
   * reverse were taxed, and whatever that bill cannot absorb is what reaches
   * the customer balance.
   */
  amount_due_now: number;
  /**
   * The tax on that bill, so the gap from the pre-tax `net` is named. Signed
   * the way the lines are: a change that credits more than it charges credits
   * the tax with it, and the figure is negative.
   */
  tax_due_now: number;
  /**
   * Whether the bill `always_invoice` would raise can be sent at all.
   *
   * `amount_due_now` is what that bill is worth; this is whether anyone is
   * about to be asked for it. A change on an account with no resolvable
   * country raises a bill that is held as a draft, and a screen that prints
   * the figure on a "collect now" button without this is promising money that
   * is not going to arrive.
   */
  automatic_tax: AutomaticTax;
  /** What the account holds today — credit is negative, Stripe's convention. */
  customer_balance: number;
  next_invoice: {
    date: number;
    currency: string;
    /**
     * The taxable base of the recurring lines — what the next bill will record
     * as its subtotal, not what the price list says. On a tax-inclusive price
     * the listed amount already contains `tax`, so the two differ; `subtotal +
     * tax` is the listed price either way.
     */
    subtotal: number;
    /** The tax the next bill will charge on those lines. */
    tax: number;
    lines: RecurringLine[];
  };
  items_after: { price: string; quantity: number; metered: boolean; description: string }[];
  mrr_before: number;
  mrr_after: number;
  mrr_delta: number;
  /** Anything a human should know before confirming — never silent. */
  notices: string[];
}

/* --------------------------------- invoices ------------------------------- */

/**
 * `draft` is a bill still being assembled — collection is paused, or a human
 * has not sent it yet. `open` is finalised and owed. The other three are the
 * ways it stops being owed: paid, written off, or withdrawn.
 */
export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'uncollectible', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_BILLING_REASONS = [
  'subscription_create', 'subscription_cycle', 'subscription_update', 'manual',
] as const;
export type InvoiceBillingReason = (typeof INVOICE_BILLING_REASONS)[number];

/**
 * Where a line came from. `recurring` is the subscription's own fee for the
 * period; the three proration kinds come from `billing_pending_items`; four of
 * the rest are what the credits module hands over for usage already consumed;
 * and `included_allowance` is the negative line that takes the plan's own
 * included quantity back off a metered charge, priced on that price's tiers.
 */
export const INVOICE_LINE_KINDS = [
  'recurring', 'unused_time', 'remaining_time', 'immediate',
  'usage', 'credit_covered', 'topup', 'true_up', 'included_allowance', 'invoice_item',
] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

export const INVOICE_LINE_SOURCES = ['subscription_item', 'pending_item', 'billable_item', 'invoice_item'] as const;
export type InvoiceLineSource = (typeof INVOICE_LINE_SOURCES)[number];

/* ------------------------------- invoice items ---------------------------- */

/**
 * `pending` is waiting for the customer's next bill, `invoiced` has been
 * claimed by one, `deleted` was withdrawn before any bill picked it up.
 */
export const INVOICE_ITEM_STATUSES = ['pending', 'invoiced', 'deleted'] as const;
export type InvoiceItemStatus = (typeof INVOICE_ITEM_STATUSES)[number];

/**
 * A hand-written line waiting for an invoice — Stripe's invoice item. A one-off
 * charge, a setup fee, a negotiated credit: no price behind it, so it carries
 * its own amount and tax behaviour, and it lands on the next invoice raised for
 * the customer exactly as a proration does.
 */
export interface InvoiceItem {
  object: 'invoice_item';
  id: string;
  customer: string;
  subscription: string | null;
  description: string;
  quantity: number;
  /** Signed minor units per unit — a negative item is a credit line. */
  unit_amount: number;
  /** `unit_amount * quantity`, signed. */
  amount: number;
  currency: string;
  tax_behavior: TaxBehavior;
  /** The window the line covers; defaults to the day it was written. */
  period: { start: number; end: number };
  status: InvoiceItemStatus;
  /** The bill that claimed it, once one has. */
  invoice: string | null;
  metadata: Record<string, string>;
  created: number;
  updated: number;
  livemode: boolean;
}

export interface InvoiceLine {
  object: 'invoice_line_item';
  id: string;
  invoice: string;
  subscription: string | null;
  subscription_item: string | null;
  /** The row this line was claimed from, so nothing can be claimed twice. */
  source: { type: InvoiceLineSource; id: string | null };
  price: string | null;
  kind: InvoiceLineKind;
  /** Stripe's flag: true for the two halves of a mid-cycle change. */
  proration: boolean;
  description: string;
  /** Prose that reconstructs the number, the same text the proration carried. */
  explanation: string;
  quantity: number;
  /** Signed minor units — a credit line is negative. */
  amount: number;
  currency: string;
  period: { start: number; end: number };
  /** The exact fraction of the interval behind a prorated line. */
  proration_fraction: { numerator: number; denominator: number } | null;
  breakdown: LineBreakdownRow[];
  /**
   * Every jurisdiction's tax on this line's base, one entry per rate.
   *
   * A supply is in as many jurisdictions as have registered a rate over it. In
   * most of the world that is one — a country's VAT — and this list has one
   * entry; in the United States it is the state, the city and whatever transit
   * district the address sits in, and the customer owes their sum. It is a list
   * so that a New York bill can print "NY State 4%, NYC 4.5%, MCTD 0.375%"
   * rather than one number that names only the largest of them.
   */
  taxes: LineTaxAmount[];
  /**
   * `taxes` rolled up: the amount is their sum, and the rate fields name the
   * rate that produced it. Where several jurisdictions taxed the line, `rate`
   * is null because no one rate produced the figure and `percentage` is their
   * combined rate — which is what a US invoice means by "8.875%". Where the
   * jurisdictions were treated differently — one reverse charged, another
   * charged — only the ones charged the way the line was are combined, so the
   * rate stated is always the rate the amount was worked out at.
   */
  tax: InvoiceLineTax;
  /** True once the invoice was voided and the line let go of what it claimed. */
  released: boolean;
}

/**
 * One rate's tax on one line, frozen at the moment the invoice was raised. The
 * rate is copied rather than referenced because a rate can be changed or
 * retired and an invoice raised under the old one still has to add up and
 * explain itself.
 */
export interface LineTaxAmount {
  object: 'invoice_line_tax_amount';
  /** Signed like the line: a credit line credits its tax too. */
  amount: number;
  /** The base this rate was applied to — the line's own amount. */
  taxable_amount: number;
  rate: string | null;
  display_name: string | null;
  jurisdiction: string | null;
  /** An exact decimal string — "19", "8.875". */
  percentage: string | null;
  tax_type: TaxType | null;
  behavior: TaxBehavior | null;
  reason: TaxReason | null;
  explanation: string | null;
}

/**
 * A line's tax as one figure. Kept beside `taxes` because most bills have
 * exactly one rate and every reader of an invoice — the credit note, the
 * totals, the ledger — wants the line's tax, not a list to fold.
 */
export interface InvoiceLineTax {
  /** Signed like the line: a credit line credits its tax too. */
  amount: number;
  rate: string | null;
  display_name: string | null;
  jurisdiction: string | null;
  /**
   * An exact decimal string — "19", "8.875". Where rates stack it is the
   * combined rate of the jurisdictions that were charged the way the line was,
   * so `amount` is always `taxable base x percentage`.
   */
  percentage: string | null;
  tax_type: TaxType | null;
  behavior: TaxBehavior | null;
  reason: TaxReason | null;
  explanation: string | null;
}

/**
 * Whether Ain worked the tax out for this bill, and whether it could.
 *
 * `complete` is a decision: the address was placed against the register, and
 * either a rate applied or none is registered where it lands.
 * `requires_location_inputs` is the absence of one — no address, an address
 * with no country, a country that is not a country, or a country whose tax is
 * registered state by state on an address that names no state — and it is a
 * different thing from a figure. A bill short because Ain never learned where
 * the customer is has not been zero-rated or part-rated; it has been guessed
 * at, and the workspace is the one the authority comes to for the difference.
 */
export const AUTOMATIC_TAX_STATUSES = ['complete', 'requires_location_inputs'] as const;
export type AutomaticTaxStatus = (typeof AUTOMATIC_TAX_STATUSES)[number];

export interface AutomaticTax {
  /**
   * Whether the workspace holds bills back over a location it could not
   * resolve. Off, the status is still computed and still reported — the
   * overview counts it and `GET /v1/invoices?tax=missing` finds it — but a
   * draft is allowed to finalise.
   */
  enabled: boolean;
  status: AutomaticTaxStatus;
  /** What the status means, in the words the screen will use. */
  detail: string;
}

export interface Invoice {
  object: 'invoice';
  id: string;
  /** Human-facing, sequential within the workspace: `NR-000042`. */
  number: string;
  sequence: number;
  customer: string;
  subscription: string | null;
  status: InvoiceStatus;
  billing_reason: InvoiceBillingReason;
  currency: string;
  collection_method: CollectionMethod;
  /** The service window this invoice bills for, in advance. */
  period: { start: number; end: number };
  /** The window whose metered usage it settles, in arrears. */
  arrears_period: { start: number; end: number } | null;
  lines: InvoiceLine[];
  /** Always exactly the sum of `lines[].amount` — the taxable base. */
  subtotal: number;
  /** Always exactly the sum of `lines[].tax.amount`. */
  tax: number;
  /** One row per rate that touched this bill. Stripe's `total_taxes`. */
  total_taxes: TaxSummaryRow[];
  /** Whether the tax on this bill was worked out from a location Ain knows. */
  automatic_tax: AutomaticTax;
  /** Signed. `subtotal + tax + balance_applied === total`, always. */
  balance_applied: number;
  total: number;
  /** `total - tax`. What the service on this bill was worth. */
  total_excluding_tax: number;
  amount_paid: number;
  /**
   * Cash handed back to the customer on this bill. A refund is recorded on the
   * payment and carried here; it never reopens a bill the customer settled —
   * `amount_paid` stays what was collected, `status` stays `paid`, and what
   * happens next is a person's decision.
   */
  amount_refunded: number;
  amount_due: number;
  /** Credited before anything was collected — it came off `amount_due`. */
  pre_payment_credit_notes_amount: number;
  /** Credited after collection — it went onto the customer's balance. */
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
  metadata: Record<string, string>;
  created: number;
  updated: number;
  livemode: boolean;
}


/* ------------------------------- credit notes ----------------------------- */

/**
 * A credit note is the only legal way to reduce a finalised invoice, and it is
 * a document: it names the invoice, the lines it corrects and the reason, so a
 * reduction can be sent to the customer and reconciled years later. What it
 * does with the money depends on whether the money had already been collected —
 * an unpaid bill is reduced, a paid one is refunded onto the account balance —
 * and the note records which of the two happened.
 */
export const CREDIT_NOTE_REASONS = [
  'duplicate', 'fraudulent', 'order_change', 'product_unsatisfactory', 'billing_error', 'service_credit',
] as const;
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number];

export const CREDIT_NOTE_STATUSES = ['issued', 'void'] as const;
export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUSES)[number];

/**
 * One jurisdiction's share of a credited line's tax — the same shape the
 * invoice line's `taxes` carry, because the return for each authority wants
 * the figure credited under its own rate, not the line's combined one.
 */
export interface CreditNoteLineTaxAmount {
  object: 'credit_note_line_tax_amount';
  /** Positive minor units, like the line. */
  amount: number;
  /** The base being credited under this rate — the line's own `amount`. */
  taxable_amount: number;
  rate: string | null;
  display_name: string | null;
  jurisdiction: string | null;
  percentage: string | null;
  tax_type: TaxType | null;
  behavior: TaxBehavior | null;
  reason: TaxReason | null;
}

export interface CreditNoteLine {
  object: 'credit_note_line_item';
  id: string;
  credit_note: string;
  /** The invoice line this reduces. Nothing may be credited that was not billed. */
  invoice_line_item: string;
  description: string;
  /** Prose that reconstructs the number, the same way an invoice line does. */
  explanation: string;
  quantity: number;
  /** Positive minor units — the taxable base being credited. */
  amount: number;
  tax_amount: number;
  /** `tax_amount`, one entry per jurisdiction the invoice line was taxed under. Always sums to `tax_amount`. */
  tax_amounts: CreditNoteLineTaxAmount[];
  /** `amount + tax_amount`: what this line takes off the bill. */
  amount_including_tax: number;
  /** The single rate this line credits under, or null where jurisdictions stack — read `tax_amounts`. */
  tax_rate: string | null;
  tax_percentage: string | null;
  tax_display_name: string | null;
  tax_behavior: TaxBehavior | null;
  tax_reason: TaxReason | null;
  currency: string;
}

export interface CreditNote {
  object: 'credit_note';
  id: string;
  /** Human-facing, sequential within the workspace: `NR-CN-000007`. */
  number: string;
  sequence: number;
  invoice: string;
  customer: string;
  currency: string;
  status: CreditNoteStatus;
  reason: CreditNoteReason;
  memo: string | null;
  lines: CreditNoteLine[];
  /** Always exactly the sum of `lines[].amount`. */
  subtotal: number;
  /** Always exactly the sum of `lines[].tax_amount`. */
  tax: number;
  /** `subtotal + tax`. What the invoice is reduced by. */
  total: number;
  /** Taken off `amount_due`, because that much of the bill was still owed. */
  pre_payment_amount: number;
  /**
   * How much of `pre_payment_amount` the bill could not absorb, because that
   * much had already been collected against it, and which therefore left the
   * bill for the customer's balance.
   *
   * Not a fourth destination beside the three below: those describe a note
   * raised against a bill that was already paid in full. This is the same thing
   * happening to a note raised against one that was *part* paid — the note
   * still reduces what is owed, because that is what withdrawing it has to put
   * back, and this says how much of it could not stay there. Zero on every note
   * against a bill that had collected nothing, which is nearly all of them.
   */
  displaced_to_balance: number;
  /** Put back to the customer because the bill had been paid: the three amounts below add up to it. */
  post_payment_amount: number;
  /** Sent back to the card through the payments module. */
  refund_amount: number;
  /** Put onto the customer's balance, to come off the next bill. */
  credit_amount: number;
  /** Settled outside the platform — a bank transfer, a cheque — and only recorded here. */
  out_of_band_amount: number;
  /** The payments module's refund row, when part of the note went back to the card. */
  refund: string | null;
  /** The balance movement, when the credit went to the account. */
  balance_transaction: string | null;
  /** What the invoice's status was when this note was written. */
  invoice_status_at_issue: InvoiceStatus;
  voided_at: number | null;
  metadata: Record<string, string>;
  created: number;
  updated: number;
  livemode: boolean;
}
