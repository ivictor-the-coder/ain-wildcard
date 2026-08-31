/**
 * The shapes billing reads and writes: what a caller may send, what a row
 * becomes, and the filters the list endpoints accept.
 *
 * Hydration lives here rather than beside the SQL because these functions are
 * the only place a database row turns into an API object — get the coercions
 * right once and every route, job and service call agrees on what a
 * subscription looks like.
 */
import { parseJson } from '../../kernel/db';
import type { Price, ProrationBehavior, TaxBehavior } from '../catalog/types';
import { summariseTax, type TaxExemption, type TaxReason, type TaxType } from './tax';
import type {
  BalanceTransaction, BalanceTransactionType, BilledPeriod, CancellationReason, CollectionMethod,
  CreditNote, CreditNoteLine, CreditNoteReason, CreditNoteStatus,
  Customer, Invoice, InvoiceBillingReason, InvoiceLine, InvoiceLineKind, InvoiceLineSource,
  InvoiceStatus, PaymentBehavior, PendingInvoiceItem, PendingItemStatus, PeriodStatus, Subscription,
  SubscriptionItem, SubscriptionStatus, TrialEndBehavior,
} from './types';

/* ---------------------------------- inputs -------------------------------- */

export interface WriteMeta {
  actorId?: string | null;
  actorType?: 'user' | 'api_key' | 'system' | 'agent' | 'workflow';
  requestId?: string | null;
  livemode?: boolean;
}

export interface AddressInput {
  line1?: string | null; line2?: string | null; city?: string | null;
  state?: string | null; postal_code?: string | null; country?: string | null;
}

export interface CustomerInput {
  id?: string;
  name: string;
  email?: string | null;
  description?: string | null;
  phone?: string | null;
  currency?: string;
  address?: AddressInput | null;
  shipping?: { name?: string | null; phone?: string | null; address?: AddressInput | null } | null;
  tax_ids?: { type: string; value: string; country?: string | null }[];
  tax_exempt?: TaxExemption;
  invoice_settings?: {
    default_payment_method?: string | null;
    days_until_due?: number | null;
    custom_fields?: { name: string; value: string }[];
    footer?: string | null;
  };
  preferred_locales?: string[];
  metadata?: Record<string, string>;
  crm_record_id?: string | null;
  balance?: number;
}

export interface SubscriptionItemInput {
  id?: string;
  price?: string;
  quantity?: number;
  /** Required on a negotiated (`custom`) price; rejected on any other. */
  custom_unit_amount?: number | null;
  metadata?: Record<string, string>;
  deleted?: boolean;
}

export interface SubscriptionCreateInput {
  id?: string;
  customer: string;
  items: SubscriptionItemInput[];
  currency?: string;
  billing_cycle_anchor?: number;
  billing_cycle_anchor_day?: number;
  backdate_start_date?: number;
  trial_period_days?: number;
  trial_end?: number;
  trial_from_plan?: boolean;
  trial_settings?: { end_behavior?: { missing_payment_method?: TrialEndBehavior } };
  collection_method?: CollectionMethod;
  days_until_due?: number | null;
  default_payment_method?: string | null;
  proration_behavior?: ProrationBehavior;
  payment_behavior?: PaymentBehavior;
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  description?: string | null;
  metadata?: Record<string, string>;
  /** Set by a subscription schedule that owns this subscription. */
  schedule?: string | null;
}

export interface SubscriptionUpdateInput {
  items?: SubscriptionItemInput[];
  proration_behavior?: ProrationBehavior;
  proration_date?: number;
  billing_cycle_anchor?: 'now' | 'unchanged';
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  collection_method?: CollectionMethod;
  days_until_due?: number | null;
  default_payment_method?: string | null;
  trial_end?: number | 'now';
  description?: string | null;
  metadata?: Record<string, string>;
}

export interface CancelInput {
  at_period_end?: boolean;
  cancel_at?: number | null;
  prorate?: boolean;
  cancellation_reason?: CancellationReason;
  comment?: string | null;
}

export interface CustomerListFilter {
  query?: string;
  email?: string;
  delinquent?: boolean;
  currency?: string;
  crm_record_id?: string;
  has_subscription?: boolean;
  limit?: number;
  cursor?: string | null;
}

export interface InvoiceListFilter {
  customer?: string;
  subscription?: string;
  status?: InvoiceStatus | 'open_like' | 'all';
  billing_reason?: InvoiceBillingReason;
  collection_method?: CollectionMethod;
  query?: string;
  created_after?: number;
  created_before?: number;
  due_before?: number;
  limit?: number;
  cursor?: string | null;
}

export interface SubscriptionListFilter {
  customer?: string;
  status?: SubscriptionStatus | 'active_like' | 'all';
  price?: string;
  collection_method?: CollectionMethod;
  schedule?: string;
  query?: string;
  created_after?: number;
  created_before?: number;
  limit?: number;
  cursor?: string | null;
}

/** An item resolved against the catalog, ready to be written or priced. */
export interface ResolvedItem {
  id: string | null;
  price: Price;
  quantity: number;
  customUnitAmount: number | null;
  metadata: Record<string, string>;
  from: SubscriptionItem | null;
}

export interface Page<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
  totalCount: number;
}

/* -------------------------------- hydration ------------------------------- */

const asBool = (v: unknown): boolean => !!v;

export function hydrateCustomer(row: any): Customer {
  const settings = parseJson<Partial<Customer['invoice_settings']>>(row.invoice_settings, {});
  return {
    object: 'customer',
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    description: row.description ?? null,
    phone: row.phone ?? null,
    currency: row.currency,
    currency_locked: asBool(row.currency_locked),
    address: parseJson<Customer['address']>(row.address, null),
    shipping: parseJson<Customer['shipping']>(row.shipping, null),
    tax_ids: parseJson<Customer['tax_ids']>(row.tax_ids, []),
    tax_exempt: (row.tax_exempt ?? 'none') as TaxExemption,
    invoice_settings: {
      default_payment_method: settings.default_payment_method ?? null,
      days_until_due: settings.days_until_due ?? null,
      custom_fields: settings.custom_fields ?? [],
      footer: settings.footer ?? null,
    },
    balance: Number(row.balance ?? 0),
    delinquent: asBool(row.delinquent),
    preferred_locales: parseJson<string[]>(row.preferred_locales, []),
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    crm_record_id: row.crm_record_id ?? null,
    created: Number(row.created),
    updated: Number(row.updated),
    livemode: asBool(row.livemode),
  };
}

export function hydrateItem(row: any): SubscriptionItem {
  return {
    object: 'subscription_item',
    id: row.id,
    subscription: row.subscription_id,
    price: row.price_id,
    quantity: Number(row.quantity),
    metered: asBool(row.metered),
    custom_unit_amount: row.custom_unit_amount === null || row.custom_unit_amount === undefined ? null : Number(row.custom_unit_amount),
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    created: Number(row.created),
    updated: Number(row.updated),
  };
}

export function hydrateSubscription(row: any, items: SubscriptionItem[]): Subscription {
  const trial = parseJson<{ end_behavior?: { missing_payment_method?: TrialEndBehavior } }>(row.trial_settings, {});
  return {
    object: 'subscription',
    id: row.id,
    customer: row.customer_id,
    status: row.status as SubscriptionStatus,
    items,
    currency: row.currency,
    interval: row.interval,
    interval_count: Number(row.interval_count),
    billing_cycle_anchor: Number(row.billing_cycle_anchor),
    billing_cycle_anchor_day: Number(row.billing_cycle_anchor_day),
    current_period_start: Number(row.current_period_start),
    current_period_end: Number(row.current_period_end),
    start_date: Number(row.start_date),
    ended_at: row.ended_at === null ? null : Number(row.ended_at),
    canceled_at: row.canceled_at === null ? null : Number(row.canceled_at),
    cancel_at: row.cancel_at === null ? null : Number(row.cancel_at),
    cancel_at_period_end: asBool(row.cancel_at_period_end),
    cancellation_reason: (row.cancellation_reason as CancellationReason) ?? null,
    cancellation_comment: row.cancellation_comment ?? null,
    trial_start: row.trial_start === null ? null : Number(row.trial_start),
    trial_end: row.trial_end === null ? null : Number(row.trial_end),
    trial_from_plan: asBool(row.trial_from_plan),
    trial_settings: { end_behavior: { missing_payment_method: trial.end_behavior?.missing_payment_method ?? 'create_invoice' } },
    collection_method: row.collection_method as CollectionMethod,
    days_until_due: row.days_until_due === null ? null : Number(row.days_until_due),
    default_payment_method: row.default_payment_method ?? null,
    pause_collection: parseJson<Subscription['pause_collection']>(row.pause_collection, null),
    proration_behavior: row.proration_behavior as ProrationBehavior,
    schedule: row.schedule_id ?? null,
    description: row.description ?? null,
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    created: Number(row.created),
    updated: Number(row.updated),
    livemode: asBool(row.livemode),
  };
}

export function hydratePendingItem(row: any): PendingInvoiceItem {
  return {
    object: 'pending_invoice_item',
    id: row.id,
    kind: row.kind,
    customer: row.customer_id,
    subscription: row.subscription_id,
    subscription_item: row.subscription_item_id ?? null,
    price: row.price_id,
    quantity: Number(row.quantity),
    amount: Number(row.amount),
    currency: row.currency,
    description: row.description,
    explanation: row.explanation,
    period: { start: Number(row.period_start), end: Number(row.period_end) },
    proration: { numerator: Number(row.proration_numerator), denominator: Number(row.proration_denominator) },
    proration_date: Number(row.proration_date),
    breakdown: parseJson<PendingInvoiceItem['breakdown']>(row.breakdown, []),
    status: row.status as PendingItemStatus,
    invoice: row.invoice_id ?? null,
    created: Number(row.created),
  };
}

export function hydrateBalanceTransaction(row: any): BalanceTransaction {
  return {
    object: 'customer_balance_transaction',
    id: row.id,
    customer: row.customer_id,
    amount: Number(row.amount),
    ending_balance: Number(row.ending_balance),
    currency: row.currency,
    type: row.type as BalanceTransactionType,
    description: row.description,
    subscription: row.subscription_id ?? null,
    invoice: row.invoice_id ?? null,
    created: Number(row.created),
  };
}

export function hydratePeriod(row: any): BilledPeriod {
  return {
    object: 'subscription_period',
    id: row.id,
    subscription: row.subscription_id,
    customer: row.customer_id,
    period_start: Number(row.period_start),
    period_end: Number(row.period_end),
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status as PeriodStatus,
    invoice: row.invoice_id ?? null,
    created: Number(row.created),
  };
}

export function hydrateInvoiceLine(row: any): InvoiceLine {
  const numerator = row.proration_numerator;
  const denominator = row.proration_denominator;
  return {
    object: 'invoice_line_item',
    id: row.id,
    invoice: row.invoice_id,
    subscription: row.subscription_id ?? null,
    subscription_item: row.subscription_item_id ?? null,
    source: { type: row.source_type as InvoiceLineSource, id: row.source_id ?? null },
    price: row.price_id ?? null,
    kind: row.kind as InvoiceLineKind,
    proration: asBool(row.proration),
    description: row.description,
    explanation: row.explanation,
    quantity: Number(row.quantity),
    amount: Number(row.amount),
    currency: row.currency,
    period: { start: Number(row.period_start), end: Number(row.period_end) },
    proration_fraction: numerator === null || numerator === undefined || denominator === null || denominator === undefined
      ? null
      : { numerator: Number(numerator), denominator: Number(denominator) },
    breakdown: parseJson<InvoiceLine['breakdown']>(row.breakdown, []),
    tax: {
      amount: Number(row.tax_amount ?? 0),
      rate: row.tax_rate ?? null,
      display_name: row.tax_display_name ?? null,
      jurisdiction: row.tax_jurisdiction ?? null,
      percentage: row.tax_percentage ?? null,
      tax_type: (row.tax_type as TaxType | null) ?? null,
      behavior: (row.tax_behavior as TaxBehavior | null) ?? null,
      reason: (row.tax_reason as TaxReason | null) ?? null,
      explanation: row.tax_explanation ?? null,
    },
    released: asBool(row.released),
  };
}

export function hydrateCreditNoteLine(row: any): CreditNoteLine {
  const amount = Number(row.amount);
  const taxAmount = Number(row.tax_amount ?? 0);
  return {
    object: 'credit_note_line_item',
    id: row.id,
    credit_note: row.credit_note_id,
    invoice_line_item: row.invoice_line_id,
    description: row.description,
    explanation: row.explanation,
    quantity: Number(row.quantity),
    amount,
    tax_amount: taxAmount,
    amount_including_tax: amount + taxAmount,
    tax_rate: row.tax_rate ?? null,
    tax_percentage: row.tax_percentage ?? null,
    tax_display_name: row.tax_display_name ?? null,
    tax_behavior: (row.tax_behavior as TaxBehavior | null) ?? null,
    tax_reason: (row.tax_reason as TaxReason | null) ?? null,
    currency: row.currency,
  };
}

export function hydrateCreditNote(row: any, lines: CreditNoteLine[]): CreditNote {
  return {
    object: 'credit_note',
    id: row.id,
    number: row.number,
    sequence: Number(row.sequence),
    invoice: row.invoice_id,
    customer: row.customer_id,
    currency: row.currency,
    status: row.status as CreditNoteStatus,
    reason: row.reason as CreditNoteReason,
    memo: row.memo ?? null,
    lines,
    subtotal: Number(row.subtotal),
    tax: Number(row.tax ?? 0),
    total: Number(row.total),
    pre_payment_amount: Number(row.pre_payment_amount ?? 0),
    post_payment_amount: Number(row.post_payment_amount ?? 0),
    balance_transaction: row.balance_transaction_id ?? null,
    invoice_status_at_issue: row.invoice_status_at_issue as InvoiceStatus,
    voided_at: row.voided_at === null || row.voided_at === undefined ? null : Number(row.voided_at),
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    created: Number(row.created),
    updated: Number(row.updated),
    livemode: asBool(row.livemode),
  };
}

export function hydrateInvoice(row: any, lines: InvoiceLine[]): Invoice {
  return {
    object: 'invoice',
    id: row.id,
    number: row.number,
    sequence: Number(row.sequence),
    customer: row.customer_id,
    subscription: row.subscription_id ?? null,
    status: row.status as InvoiceStatus,
    billing_reason: row.billing_reason as InvoiceBillingReason,
    currency: row.currency,
    collection_method: row.collection_method as CollectionMethod,
    period: { start: Number(row.period_start), end: Number(row.period_end) },
    arrears_period: row.arrears_period_start === null || row.arrears_period_start === undefined
      ? null
      : { start: Number(row.arrears_period_start), end: Number(row.arrears_period_end) },
    lines,
    subtotal: Number(row.subtotal),
    tax: Number(row.tax ?? 0),
    total_taxes: summariseTax(lines.map((line) => ({
      tax_rate: line.tax.rate,
      tax_display_name: line.tax.display_name,
      tax_jurisdiction: line.tax.jurisdiction,
      tax_percentage: line.tax.percentage,
      tax_type: line.tax.tax_type,
      tax_reason: line.tax.reason,
      tax_behavior: line.tax.behavior,
      amount: line.amount,
      tax_amount: line.tax.amount,
      currency: line.currency,
    }))),
    balance_applied: Number(row.balance_applied),
    total: Number(row.total),
    total_excluding_tax: Number(row.total) - Number(row.tax ?? 0),
    amount_paid: Number(row.amount_paid),
    amount_due: Number(row.amount_due),
    pre_payment_credit_notes_amount: Number(row.pre_payment_credit_notes_amount ?? 0),
    post_payment_credit_notes_amount: Number(row.post_payment_credit_notes_amount ?? 0),
    starting_balance: Number(row.starting_balance),
    ending_balance: Number(row.ending_balance),
    due_date: row.due_date === null || row.due_date === undefined ? null : Number(row.due_date),
    finalized_at: row.finalized_at === null || row.finalized_at === undefined ? null : Number(row.finalized_at),
    paid_at: row.paid_at === null || row.paid_at === undefined ? null : Number(row.paid_at),
    voided_at: row.voided_at === null || row.voided_at === undefined ? null : Number(row.voided_at),
    marked_uncollectible_at: row.marked_uncollectible_at === null || row.marked_uncollectible_at === undefined
      ? null : Number(row.marked_uncollectible_at),
    payment_note: row.payment_note ?? null,
    footer: row.footer ?? null,
    description: row.description ?? null,
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    created: Number(row.created),
    updated: Number(row.updated),
    livemode: asBool(row.livemode),
  };
}

/** Escape a user's search text for a SQLite LIKE with an explicit ESCAPE clause. */
export const like = (value: string) => `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** Fill in every field of an address so a partial update never loses one. */
export function normaliseAddress(input: AddressInput) {
  return {
    line1: input.line1 ?? null, line2: input.line2 ?? null, city: input.city ?? null,
    state: input.state ?? null, postal_code: input.postal_code ?? null, country: input.country ?? null,
  };
}
