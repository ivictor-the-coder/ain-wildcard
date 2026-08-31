/**
 * Rows in, objects out. Nothing in this file decides anything — it exists so
 * that every other file in the module reads a `PaymentIntent` and never a
 * `Record<string, unknown>` with an `is_default` column on it.
 */
import { parseJson } from '../../kernel/db';
import { describeBehavior } from './simulator';
import type {
  BankAccountType, CardBrand, CardFunding, Charge, ChargeOutcome, ChargeStatus, DeclineCode, Dispute,
  DisputeEvidence, DisputeReason, DisputeStatus, Dunning, DunningAttempt, DunningAttemptOutcome,
  DunningEndBehavior, DunningStatus, NetworkStatus, NextAction, OutcomeType, PaymentCancellationReason,
  PaymentIntent, PaymentIntentSource, PaymentIntentStatus, PaymentMethod, PaymentMethodStatus,
  PaymentMethodType, Refund, RefundReason, RefundStatus, RiskLevel, SimulatedBehavior,
} from './types';

export interface Page<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
  totalCount: number;
}

export interface WriteMeta {
  actorId?: string | null;
  actorType?: 'user' | 'api_key' | 'system' | 'agent' | 'workflow';
  requestId?: string | null;
  livemode?: boolean;
}

const bool = (v: unknown): boolean => !!v;
const num = (v: unknown): number => Number(v ?? 0);
const nullableNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function hydrateMethod(row: any): PaymentMethod {
  const type = String(row.type) as PaymentMethodType;
  const behavior = String(row.simulated_behavior) as SimulatedBehavior;
  const declineCount = nullableNum(row.simulated_decline_count);
  return {
    object: 'payment_method',
    id: String(row.id),
    type,
    customer: text(row.customer_id),
    status: String(row.status) as PaymentMethodStatus,
    default_for_customer: bool(row.is_default),
    display_name: String(row.display_name),
    card: type === 'card'
      ? {
        brand: String(row.brand) as CardBrand,
        last4: String(row.last4),
        exp_month: num(row.exp_month),
        exp_year: num(row.exp_year),
        funding: String(row.funding ?? 'unknown') as CardFunding,
        country: text(row.country),
      }
      : null,
    bank_debit: type === 'bank_debit'
      ? {
        bank_name: String(row.bank_name ?? ''),
        last4: String(row.last4),
        account_type: String(row.account_type ?? 'checking') as BankAccountType,
        country: text(row.country),
        mandate_reference: String(row.mandate_reference ?? ''),
      }
      : null,
    billing_details: { name: text(row.billing_name), email: text(row.billing_email) },
    fingerprint: String(row.fingerprint),
    simulated: { behavior, decline_count: declineCount, explanation: describeBehavior(behavior, declineCount) },
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    created: num(row.created),
    updated: num(row.updated),
    detached_at: nullableNum(row.detached_at),
    livemode: bool(row.livemode),
  };
}

export function hydrateIntent(row: any): PaymentIntent {
  const code = text(row.last_error_code) as DeclineCode | null;
  return {
    object: 'payment_intent',
    id: String(row.id),
    customer: String(row.customer_id),
    payment_method: text(row.payment_method_id),
    invoice: text(row.invoice_id),
    subscription: text(row.subscription_id),
    amount: num(row.amount),
    currency: String(row.currency),
    status: String(row.status) as PaymentIntentStatus,
    description: text(row.description),
    statement_descriptor: text(row.statement_descriptor),
    off_session: bool(row.off_session),
    attempt_count: num(row.attempt_count),
    next_action: row.next_action ? parseJson<NextAction | null>(row.next_action, null) : null,
    last_payment_error: code
      ? { code, message: String(row.last_error_message ?? ''), advice: String(row.last_error_advice ?? '') }
      : null,
    latest_charge: text(row.latest_charge_id),
    succeeded_at: nullableNum(row.succeeded_at),
    canceled_at: nullableNum(row.canceled_at),
    cancellation_reason: text(row.cancellation_reason) as PaymentCancellationReason | null,
    idempotency_key: text(row.idempotency_key),
    source: String(row.source) as PaymentIntentSource,
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    created: num(row.created),
    updated: num(row.updated),
    livemode: bool(row.livemode),
  };
}

export function hydrateCharge(row: any): Charge {
  const outcome: ChargeOutcome = {
    type: String(row.outcome_type) as OutcomeType,
    network_status: String(row.outcome_network_status) as NetworkStatus,
    reason: text(row.outcome_reason) as DeclineCode | null,
    risk_level: String(row.outcome_risk_level) as RiskLevel,
    risk_score: num(row.outcome_risk_score),
    seller_message: String(row.outcome_seller_message),
    explanation: String(row.outcome_explanation),
  };
  return {
    object: 'charge',
    id: String(row.id),
    payment_intent: String(row.payment_intent_id),
    customer: String(row.customer_id),
    payment_method: text(row.payment_method_id),
    invoice: text(row.invoice_id),
    subscription: text(row.subscription_id),
    amount: num(row.amount),
    amount_refunded: num(row.amount_refunded),
    amount_disputed: num(row.amount_disputed),
    currency: String(row.currency),
    status: String(row.status) as ChargeStatus,
    paid: bool(row.paid),
    captured: bool(row.captured),
    refunded: bool(row.refunded),
    disputed: bool(row.disputed),
    failure_code: text(row.failure_code) as DeclineCode | null,
    failure_message: text(row.failure_message),
    authorization_code: text(row.authorization_code),
    outcome,
    created: num(row.created),
    livemode: bool(row.livemode),
  };
}

export function hydrateRefund(row: any): Refund {
  return {
    object: 'refund',
    id: String(row.id),
    charge: String(row.charge_id),
    payment_intent: String(row.payment_intent_id),
    customer: String(row.customer_id),
    invoice: text(row.invoice_id),
    amount: num(row.amount),
    currency: String(row.currency),
    reason: String(row.reason) as RefundReason,
    status: String(row.status) as RefundStatus,
    description: text(row.description),
    invoice_effect: text(row.invoice_effect),
    created: num(row.created),
  };
}

export function hydrateDispute(row: any): Dispute {
  return {
    object: 'dispute',
    id: String(row.id),
    charge: String(row.charge_id),
    payment_intent: String(row.payment_intent_id),
    customer: String(row.customer_id),
    invoice: text(row.invoice_id),
    subscription: text(row.subscription_id),
    amount: num(row.amount),
    currency: String(row.currency),
    reason: String(row.reason) as DisputeReason,
    status: String(row.status) as DisputeStatus,
    evidence: parseJson<DisputeEvidence>(row.evidence, {
      product_description: null, customer_communication: null,
      service_documentation: null, cancellation_policy: null, uncategorized_text: null,
    }),
    evidence_due_by: num(row.evidence_due_by),
    submitted_at: nullableNum(row.submitted_at),
    closed_at: nullableNum(row.closed_at),
    outcome_note: text(row.outcome_note),
    is_charge_refundable: bool(row.is_charge_refundable),
    created: num(row.created),
    updated: num(row.updated),
  };
}

export function hydrateDunning(row: any): Dunning {
  return {
    object: 'dunning',
    id: String(row.id),
    invoice: String(row.invoice_id),
    customer: String(row.customer_id),
    subscription: text(row.subscription_id),
    currency: String(row.currency),
    amount_at_risk: num(row.amount_at_risk),
    recovered_amount: num(row.recovered_amount),
    status: String(row.status) as DunningStatus,
    attempt_count: num(row.attempt_count),
    max_attempts: num(row.max_attempts),
    retry_days: parseJson<number[]>(row.retry_days, []),
    end_behavior: String(row.end_behavior) as DunningEndBehavior,
    next_attempt_at: nullableNum(row.next_attempt_at),
    last_attempt_at: nullableNum(row.last_attempt_at),
    last_failure_code: text(row.last_failure_code) as DeclineCode | null,
    last_failure_message: text(row.last_failure_message),
    started_at: num(row.started_at),
    resolved_at: nullableNum(row.resolved_at),
    resolution: text(row.resolution),
    end_behavior_applied: text(row.end_behavior_applied),
    created: num(row.created),
    updated: num(row.updated),
  };
}

export function hydrateAttempt(row: any): DunningAttempt {
  return {
    object: 'dunning_attempt',
    id: String(row.id),
    dunning: String(row.dunning_id),
    invoice: String(row.invoice_id),
    customer: String(row.customer_id),
    subscription: text(row.subscription_id),
    attempt_number: num(row.attempt_number),
    scheduled_for: num(row.scheduled_for),
    attempted_at: num(row.attempted_at),
    payment_method: text(row.payment_method_id),
    payment_intent: text(row.payment_intent_id),
    charge: text(row.charge_id),
    amount: num(row.amount),
    currency: String(row.currency),
    outcome: String(row.outcome) as DunningAttemptOutcome,
    failure_code: text(row.failure_code) as DeclineCode | null,
    failure_message: text(row.failure_message),
    decision: String(row.decision),
    next_attempt_at: nullableNum(row.next_attempt_at),
    created: num(row.created),
  };
}

export const like = (value: string) => `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
