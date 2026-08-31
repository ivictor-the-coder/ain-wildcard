/**
 * The payments object model.
 *
 * Two things are worth stating once, because everything else in the module
 * follows from them.
 *
 *  1. **There is no acquirer behind this platform, and it never pretends
 *     otherwise.** Every payment method carries the outcome it will produce —
 *     `simulated_behavior` — and every charge says so in its outcome. A
 *     simulated processor that cannot be told what to do is a fake; one whose
 *     every decline can be triggered on purpose is a test harness, and that is
 *     what this is.
 *  2. **A charge attempt is a state machine, not a boolean.** The statuses here
 *     are the real ones, including the two that are usually skipped —
 *     `requires_action` for a bank that wants the cardholder present, and
 *     `processing` for a debit that settles days later. Skipping them is how a
 *     billing system ends up telling a customer their payment failed when the
 *     bank simply had not answered yet.
 */

/* ------------------------------ payment methods --------------------------- */

export const PAYMENT_METHOD_TYPES = ['card', 'bank_debit'] as const;
export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number];

export const PAYMENT_METHOD_STATUSES = ['attached', 'detached'] as const;
export type PaymentMethodStatus = (typeof PAYMENT_METHOD_STATUSES)[number];

export const CARD_FUNDING = ['credit', 'debit', 'prepaid', 'unknown'] as const;
export type CardFunding = (typeof CARD_FUNDING)[number];

export const CARD_BRANDS = ['visa', 'mastercard', 'amex', 'discover', 'jcb', 'diners', 'unionpay', 'unknown'] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

export const BANK_ACCOUNT_TYPES = ['checking', 'savings'] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

/**
 * What the simulated processor will do with this method.
 *
 * The first seven are card outcomes, the last three belong to bank debits —
 * a direct debit cannot have the wrong CVC, and a card cannot be presented to
 * an account that was closed six weeks ago.
 */
export const SIMULATED_BEHAVIORS = [
  'succeeds',
  'insufficient_funds',
  'card_declined',
  'expired_card',
  'incorrect_cvc',
  'processing_error',
  'authentication_required',
  'account_closed',
  'no_account',
  'debit_not_authorized',
] as const;
export type SimulatedBehavior = (typeof SIMULATED_BEHAVIORS)[number];

export const CARD_BEHAVIORS: readonly SimulatedBehavior[] = [
  'succeeds', 'insufficient_funds', 'card_declined', 'expired_card',
  'incorrect_cvc', 'processing_error', 'authentication_required',
];

export const BANK_DEBIT_BEHAVIORS: readonly SimulatedBehavior[] = [
  'succeeds', 'insufficient_funds', 'account_closed', 'no_account',
  'debit_not_authorized', 'processing_error',
];

/** Every behaviour except `succeeds` is a decline code a charge can carry. */
export type DeclineCode = Exclude<SimulatedBehavior, 'succeeds'>;

/**
 * How stubborn a decline is.
 *
 * `soft` will plausibly clear on its own — payday arrives, the issuer's
 * gateway comes back. `hard` is the issuer refusing this card for this
 * merchant; retrying works occasionally but deserves a longer gap. `final`
 * cannot be fixed by waiting, only by a new payment method, and retrying it
 * burns goodwill and a retry fee for nothing.
 */
export const DECLINE_SEVERITIES = ['soft', 'hard', 'final'] as const;
export type DeclineSeverity = (typeof DECLINE_SEVERITIES)[number];

export interface PaymentMethodCard {
  brand: CardBrand;
  last4: string;
  exp_month: number;
  exp_year: number;
  funding: CardFunding;
  country: string | null;
}

export interface PaymentMethodBankDebit {
  bank_name: string;
  last4: string;
  account_type: BankAccountType;
  country: string | null;
  /** The mandate the customer signed. A debit without one is not collectable. */
  mandate_reference: string;
}

export interface PaymentMethod {
  object: 'payment_method';
  id: string;
  type: PaymentMethodType;
  customer: string | null;
  status: PaymentMethodStatus;
  default_for_customer: boolean;
  /** "Visa ending 4242, expires 04/2029" — the string every surface shows. */
  display_name: string;
  card: PaymentMethodCard | null;
  bank_debit: PaymentMethodBankDebit | null;
  billing_details: { name: string | null; email: string | null };
  /** Same card at two customers gets the same fingerprint, as it should. */
  fingerprint: string;
  simulated: {
    behavior: SimulatedBehavior;
    /**
     * Declines this many attempts and then starts succeeding; null declines
     * every attempt. The count runs from the last time the method was written,
     * so setting it on a card with a year of history means the *next* n.
     */
    decline_count: number | null;
    /** What this method will do next time it is charged, in words. */
    explanation: string;
  };
  metadata: Record<string, string>;
  created: number;
  updated: number;
  detached_at: number | null;
  livemode: boolean;
}

/* ------------------------------ payment intents --------------------------- */

/**
 * The real machine. A failure does not invent a `failed` state: it returns the
 * intent to `requires_payment_method`, which is precisely what it means — the
 * money did not move and this intent needs a different card to move it.
 */
export const PAYMENT_INTENT_STATUSES = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'succeeded',
  'canceled',
] as const;
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

export const PAYMENT_INTENT_SOURCES = [
  'api', 'invoice_collection', 'dunning_retry', 'manual_retry',
] as const;
export type PaymentIntentSource = (typeof PAYMENT_INTENT_SOURCES)[number];

export const CANCELLATION_REASONS = [
  'duplicate', 'fraudulent', 'requested_by_customer', 'abandoned', 'superseded',
] as const;
export type PaymentCancellationReason = (typeof CANCELLATION_REASONS)[number];

/** What the customer has to do before this intent can move any further. */
export interface NextAction {
  type: 'authenticate';
  /** The endpoint that stands in for the issuer's 3-D Secure page. */
  authenticate_url: string;
  description: string;
}

export interface PaymentError {
  code: DeclineCode;
  message: string;
  /** What to do about it, aimed at whoever is trying to get paid. */
  advice: string;
}

export interface PaymentIntent {
  object: 'payment_intent';
  id: string;
  customer: string;
  payment_method: string | null;
  invoice: string | null;
  subscription: string | null;
  amount: number;
  currency: string;
  status: PaymentIntentStatus;
  description: string | null;
  statement_descriptor: string | null;
  off_session: boolean;
  attempt_count: number;
  next_action: NextAction | null;
  last_payment_error: PaymentError | null;
  latest_charge: string | null;
  succeeded_at: number | null;
  canceled_at: number | null;
  cancellation_reason: PaymentCancellationReason | null;
  idempotency_key: string | null;
  source: PaymentIntentSource;
  metadata: Record<string, string>;
  created: number;
  updated: number;
  livemode: boolean;
}

/* ---------------------------------- charges ------------------------------- */

export const CHARGE_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

export const OUTCOME_TYPES = ['authorized', 'issuer_declined', 'invalid', 'blocked'] as const;
export type OutcomeType = (typeof OUTCOME_TYPES)[number];

export const NETWORK_STATUSES = [
  'approved_by_network', 'declined_by_network', 'not_sent_to_network', 'pending_settlement',
] as const;
export type NetworkStatus = (typeof NETWORK_STATUSES)[number];

export const RISK_LEVELS = ['normal', 'elevated', 'highest'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * Why the charge went the way it did.
 *
 * `seller_message` is written to be forwarded to a customer without editing;
 * `explanation` is written for whoever has to decide what to do next.
 */
export interface ChargeOutcome {
  type: OutcomeType;
  network_status: NetworkStatus;
  reason: DeclineCode | null;
  risk_level: RiskLevel;
  risk_score: number;
  seller_message: string;
  explanation: string;
}

export interface Charge {
  object: 'charge';
  id: string;
  payment_intent: string;
  customer: string;
  payment_method: string | null;
  invoice: string | null;
  subscription: string | null;
  amount: number;
  amount_refunded: number;
  amount_disputed: number;
  currency: string;
  status: ChargeStatus;
  paid: boolean;
  captured: boolean;
  refunded: boolean;
  disputed: boolean;
  failure_code: DeclineCode | null;
  failure_message: string | null;
  authorization_code: string | null;
  outcome: ChargeOutcome;
  created: number;
  livemode: boolean;
}

/* ---------------------------------- refunds ------------------------------- */

export const REFUND_REASONS = [
  'requested_by_customer', 'duplicate', 'fraudulent', 'service_not_delivered', 'goodwill',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const REFUND_STATUSES = ['succeeded', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export interface Refund {
  object: 'refund';
  id: string;
  charge: string;
  payment_intent: string;
  customer: string;
  invoice: string | null;
  amount: number;
  currency: string;
  reason: RefundReason;
  status: RefundStatus;
  description: string | null;
  /** What it did to the bill — a refund moves cash, it does not rewrite lines. */
  invoice_effect: string | null;
  created: number;
}

/* --------------------------------- disputes ------------------------------- */

export const DISPUTE_REASONS = [
  'fraudulent', 'product_not_received', 'product_unacceptable', 'duplicate',
  'subscription_canceled', 'unrecognized', 'credit_not_processed',
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

/**
 * A dispute opens with the money already gone — the network pulls it on the
 * day the cardholder complains, not on the day it is resolved. That is why
 * opening one moves the invoice, and why winning one moves it back.
 */
export const DISPUTE_STATUSES = ['needs_response', 'under_review', 'won', 'lost'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export interface DisputeEvidence {
  product_description: string | null;
  customer_communication: string | null;
  service_documentation: string | null;
  cancellation_policy: string | null;
  uncategorized_text: string | null;
}

export interface Dispute {
  object: 'dispute';
  id: string;
  charge: string;
  payment_intent: string;
  customer: string;
  invoice: string | null;
  subscription: string | null;
  amount: number;
  currency: string;
  reason: DisputeReason;
  status: DisputeStatus;
  evidence: DisputeEvidence;
  evidence_due_by: number;
  submitted_at: number | null;
  closed_at: number | null;
  outcome_note: string | null;
  is_charge_refundable: boolean;
  created: number;
  updated: number;
}

/* --------------------------------- dunning -------------------------------- */

/**
 * What happens when the retries run out.
 *
 * `leave_past_due` keeps chasing by hand — the right answer for enterprise
 * accounts where a failed card means an expense-report problem, not churn.
 * `mark_unpaid` stops collection but keeps the subscription and its history.
 * `cancel` ends it. The default is `mark_unpaid`, because cancelling a paying
 * customer over an expired card is the most expensive mistake in this module.
 */
export const DUNNING_END_BEHAVIORS = ['leave_past_due', 'mark_unpaid', 'cancel'] as const;
export type DunningEndBehavior = (typeof DUNNING_END_BEHAVIORS)[number];

export const DUNNING_STATUSES = ['recovering', 'recovered', 'exhausted', 'canceled'] as const;
export type DunningStatus = (typeof DUNNING_STATUSES)[number];

export const DUNNING_ATTEMPT_OUTCOMES = ['succeeded', 'failed', 'skipped'] as const;
export type DunningAttemptOutcome = (typeof DUNNING_ATTEMPT_OUTCOMES)[number];

/**
 * The retry policy, per workspace.
 *
 * `retry_days` are the gaps *between* attempts, not offsets from the first one:
 * `[3, 5, 7]` means the second attempt is three days after the first, the third
 * five days after that, the fourth seven days after that. Widening gaps are
 * what recovers money — an issuer that said no this morning will say no again
 * this afternoon.
 */
export interface DunningPolicy {
  retry_days: number[];
  /** Counts the first, failed collection. `[3,5,7]` plus one is four. */
  max_attempts: number;
  end_behavior: DunningEndBehavior;
  /** Nobody's payroll clears on a Sunday, and no one is in to fix a decline. */
  skip_weekends: boolean;
  /** A hard decline waits this many times longer before the next attempt. */
  hard_decline_multiplier: number;
  /** UTC hour the daily retry batch runs. */
  collection_hour: number;
  /** Retries spread deterministically across this many hours of that window. */
  jitter_hours: number;
  /** Declines not worth another attempt — ask for a new method instead. */
  give_up_codes: DeclineCode[];
}

export interface DunningAttempt {
  object: 'dunning_attempt';
  id: string;
  dunning: string;
  invoice: string;
  customer: string;
  subscription: string | null;
  attempt_number: number;
  scheduled_for: number;
  attempted_at: number;
  payment_method: string | null;
  payment_intent: string | null;
  charge: string | null;
  amount: number;
  currency: string;
  outcome: DunningAttemptOutcome;
  failure_code: DeclineCode | null;
  failure_message: string | null;
  /** What this attempt decided to do next, and why it decided it. */
  decision: string;
  next_attempt_at: number | null;
  created: number;
}

export interface Dunning {
  object: 'dunning';
  id: string;
  invoice: string;
  customer: string;
  subscription: string | null;
  currency: string;
  amount_at_risk: number;
  recovered_amount: number;
  status: DunningStatus;
  attempt_count: number;
  max_attempts: number;
  retry_days: number[];
  end_behavior: DunningEndBehavior;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  last_failure_code: DeclineCode | null;
  last_failure_message: string | null;
  started_at: number;
  resolved_at: number | null;
  /** One sentence saying how this ended, or how it is going. */
  resolution: string | null;
  /** What giving up did to the subscription. Null until the schedule runs out. */
  end_behavior_applied: string | null;
  created: number;
  updated: number;
}

/** A campaign as the recovery queue shows it: with the human decision attached. */
export interface DunningView extends Dunning {
  customer_name: string;
  invoice_number: string;
  subscription_status: string | null;
  attempts_remaining: number;
  payment_method: PaymentMethod | null;
  attempts: DunningAttempt[];
  /** What a human should do about this account today. */
  recommended_action: string;
  /** Whether that action needs a person, or whether the schedule has it. */
  needs_human: boolean;
}
