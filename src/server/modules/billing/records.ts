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
import {
  combinePercentages, defaultVerificationNote, pendingVerification, summariseTax, TAX_TYPE_LABELS,
  type TaxExemption, type TaxReason, type TaxSummaryRow, type TaxType,
} from './tax';
import type {
  AutomaticTax, AutomaticTaxStatus, BalanceTransaction, BalanceTransactionType, BilledPeriod,
  CancellationReason, CollectionMethod,
  CreditNote, CreditNoteLine, CreditNoteReason, CreditNoteStatus,
  Customer, Invoice, InvoiceBillingReason, InvoiceLine, InvoiceLineKind, InvoiceLineSource,
  InvoiceLineTax, InvoiceStatus, LineTaxAmount, PaymentBehavior, PendingInvoiceItem, PendingItemStatus,
  PeriodStatus, Subscription, SubscriptionItem, SubscriptionStatus, TaxId, TaxIdVerification, TrialEndBehavior,
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

/**
 * How an invoice's tax reads, as something to filter a list by.
 *
 * `missing` is the one that matters: it is not "no tax was charged" but "no
 * country could be resolved, so nothing could be worked out" — the backlog a
 * finance team has to clear before those bills can be sent.
 */
export const INVOICE_TAX_FILTERS = ['missing', 'zero', 'charged'] as const;
export type InvoiceTaxFilter = (typeof INVOICE_TAX_FILTERS)[number];

export interface InvoiceListFilter {
  customer?: string;
  subscription?: string;
  status?: InvoiceStatus | 'open_like' | 'all';
  billing_reason?: InvoiceBillingReason;
  collection_method?: CollectionMethod;
  tax?: InvoiceTaxFilter;
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

/** A tax id as it may sit in the column, including rows written before it carried a verification. */
type StoredTaxId = { type?: string; value?: string; country?: string | null; verification?: Partial<TaxIdVerification> };

/**
 * A registration number always answers "has this been checked?", whatever the
 * row holds. A stored number with no verification on it has not been checked —
 * that is the safe reading and the true one — so it hydrates as pending rather
 * than as a field the tax engine has to test for.
 */
function hydrateTaxId(stored: StoredTaxId): TaxId {
  const type = String(stored.type ?? 'unknown');
  const held = stored.verification;
  return {
    type,
    value: String(stored.value ?? ''),
    country: stored.country ?? null,
    verification: held?.status
      ? {
        status: held.status,
        verified_name: held.verified_name ?? null,
        verified_address: held.verified_address ?? null,
        checked_at: held.checked_at ?? null,
        note: held.note ?? defaultVerificationNote(held.status, String(stored.value ?? '')),
      }
      : pendingVerification(type),
  };
}

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
    tax_ids: parseJson<StoredTaxId[]>(row.tax_ids, []).map(hydrateTaxId),
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

/** A line tax entry as it may sit in the column, from any version of the writer. */
type StoredLineTax = Partial<Omit<LineTaxAmount, 'object'>>;

/**
 * Every rate that touched a line, however the row was written.
 *
 * Rows raised before tax stacked carry one rate in their own columns and no
 * list; that rate *is* the list, so an old invoice hydrates into the new shape
 * and still says exactly what it always said. A row with no tax information at
 * all — nothing was ever resolved for it — has no entries rather than one empty
 * one, so nothing summarises a rate that never existed.
 */
function hydrateLineTaxes(row: any, amount: number): LineTaxAmount[] {
  const stored = parseJson<StoredLineTax[]>(row.taxes, []);
  if (stored.length) {
    return stored.map((entry) => ({
      object: 'invoice_line_tax_amount',
      amount: Number(entry.amount ?? 0),
      taxable_amount: Number(entry.taxable_amount ?? amount),
      rate: entry.rate ?? null,
      display_name: entry.display_name ?? null,
      jurisdiction: entry.jurisdiction ?? null,
      percentage: entry.percentage ?? null,
      tax_type: (entry.tax_type as TaxType | null) ?? null,
      behavior: (entry.behavior as TaxBehavior | null) ?? null,
      reason: (entry.reason as TaxReason | null) ?? null,
      explanation: entry.explanation ?? null,
    }));
  }
  const legacy = row.tax_reason ?? row.tax_rate ?? row.tax_percentage ?? row.tax_explanation;
  if (legacy === null || legacy === undefined) return [];
  return [{
    object: 'invoice_line_tax_amount',
    amount: Number(row.tax_amount ?? 0),
    taxable_amount: amount,
    rate: row.tax_rate ?? null,
    display_name: row.tax_display_name ?? null,
    jurisdiction: row.tax_jurisdiction ?? null,
    percentage: row.tax_percentage ?? null,
    tax_type: (row.tax_type as TaxType | null) ?? null,
    behavior: (row.tax_behavior as TaxBehavior | null) ?? null,
    reason: (row.tax_reason as TaxReason | null) ?? null,
    explanation: row.tax_explanation ?? null,
  }];
}

/**
 * The line's tax as one figure, derived from the entries rather than stored
 * beside them — two places holding the same number is how they come to disagree.
 *
 * One rate is reported exactly as it was resolved. Several are reported as what
 * they are together: their amounts summed and their percentages combined into
 * the one rate a US customer recognises ("8.875%").
 *
 * The rate quoted here has to be the rate that produced the amount beside it.
 * Where the jurisdictions were treated alike — three US rates all charged, an
 * EU VAT wholly reverse charged — that is every one of them, and the combined
 * figure is the one the customer checks their own return against. Where they
 * were not, it is only the ones that were treated the way the line was:
 * combining a reverse-charged 19% VAT with a 2% city levy that *was* charged
 * printed "21%" against €2.00 of tax, a rate no authority has ever charged, on
 * the document a customer files against. `render.ts` already builds the bill's
 * own combined line from the rates that charged; this is the same rule, on the
 * figure every other reader of a line — the credit note, the ledger, the API —
 * takes the line's tax from.
 */
export function rollUpLineTax(taxes: LineTaxAmount[]): InvoiceLineTax {
  const amount = taxes.reduce((total, entry) => total + entry.amount, 0);
  if (taxes.length <= 1) {
    const only = taxes[0];
    return {
      amount,
      rate: only?.rate ?? null,
      display_name: only?.display_name ?? null,
      jurisdiction: only?.jurisdiction ?? null,
      percentage: only?.percentage ?? null,
      tax_type: only?.tax_type ?? null,
      behavior: only?.behavior ?? null,
      reason: only?.reason ?? null,
      explanation: only?.explanation ?? null,
    };
  }
  const one = <T>(values: (T | null)[]): T | null =>
    values.every((value) => value === values[0]) ? values[0] : null;
  // A line where one jurisdiction reverse charged and another did not was
  // still taxed; the entries carry which was which.
  const reason = one(taxes.map((entry) => entry.reason)) ?? 'taxable';
  // Reasons can only disagree by one jurisdiction shifting while another
  // charges, so the entries that share the line's own reason are exactly the
  // ones the amount came from. The fallback is defensive: a set that somehow
  // matches none of them is still described by all of them rather than by
  // nothing at all.
  const charged = taxes.filter((entry) => entry.reason === reason);
  const named = charged.length ? charged : taxes;
  const type = one(named.map((entry) => entry.tax_type));
  const percentages = named.map((entry) => entry.percentage).filter((pct): pct is string => !!pct);
  return {
    amount,
    // No single rate produced a figure several of them made, and naming one of
    // the three would be the lie the list exists to stop telling. Where only
    // one of the jurisdictions charged, that one *is* the rate behind the
    // figure, and it is named.
    rate: named.length === 1 ? named[0].rate : null,
    display_name: named.length === 1
      ? named[0].display_name
      : type ? TAX_TYPE_LABELS[type] : 'Tax',
    jurisdiction: [...new Set(named.map((entry) => entry.jurisdiction).filter(Boolean))].join(' + ') || null,
    percentage: percentages.length ? combinePercentages(percentages) : null,
    tax_type: type,
    reason,
    behavior: named[0].behavior,
    // Every jurisdiction's sentence, charged or not: the line still has to
    // explain the zero it did not charge as well as the figure it did.
    explanation: taxes.map((entry) => entry.explanation).filter(Boolean).join(' ') || null,
  };
}

export function hydrateInvoiceLine(row: any): InvoiceLine {
  const numerator = row.proration_numerator;
  const denominator = row.proration_denominator;
  const amount = Number(row.amount);
  const taxes = hydrateLineTaxes(row, amount);
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
    amount,
    currency: row.currency,
    period: { start: Number(row.period_start), end: Number(row.period_end) },
    proration_fraction: numerator === null || numerator === undefined || denominator === null || denominator === undefined
      ? null
      : { numerator: Number(numerator), denominator: Number(denominator) },
    breakdown: parseJson<InvoiceLine['breakdown']>(row.breakdown, []),
    taxes,
    tax: rollUpLineTax(taxes),
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

/**
 * One row per rate that touched a set of lines. Shared by the stored invoice and
 * by the upcoming-invoice preview, so a preview can never summarise its tax
 * differently from the bill it is predicting.
 */
export function taxSummaryOf(lines: InvoiceLine[]): TaxSummaryRow[] {
  return summariseTax(lines.flatMap((line) => line.taxes.map((entry) => ({
    tax_rate: entry.rate,
    tax_display_name: entry.display_name,
    tax_jurisdiction: entry.jurisdiction,
    tax_percentage: entry.percentage,
    tax_type: entry.tax_type,
    tax_reason: entry.reason,
    tax_behavior: entry.behavior,
    taxable_amount: entry.taxable_amount,
    tax_amount: entry.amount,
    currency: line.currency,
  }))));
}

/**
 * What the automatic-tax status means, in the words a screen will use.
 *
 * The sentence changes with the switch because the consequence does: with the
 * hold on, a bill Ain could not place is a bill that cannot be sent; with it
 * off, it is a bill that went out with no tax on it and no way to know whether
 * that was right.
 */
export function describeAutomaticTax(status: AutomaticTaxStatus, enabled: boolean): string {
  if (status === 'complete') {
    return 'The tax on this bill was worked out from the country on the customer’s record.';
  }
  // Two ways an address fails to place, and the sentence has to cover both: no
  // country on the record, or a country whose tax is registered state by state
  // and no state with it. Naming only the first sent a finance team looking for
  // a country that was already there.
  return enabled
    ? 'This customer’s address could not be placed — it needs a country, and a state in a country whose tax is registered state by state — so no tax could be worked out. Complete the address and this bill will finalise.'
    : 'This customer’s address could not be placed — it needs a country, and a state in a country whose tax is registered state by state — so no tax was worked out. Automatic tax is turned off for this workspace, so the bill was finalised anyway.';
}

export function hydrateInvoice(row: any, lines: InvoiceLine[], automaticTaxEnabled = true): Invoice {
  const taxStatus = (row.automatic_tax_status as AutomaticTaxStatus | null) ?? 'complete';
  const automaticTax: AutomaticTax = {
    enabled: automaticTaxEnabled,
    status: taxStatus,
    detail: describeAutomaticTax(taxStatus, automaticTaxEnabled),
  };
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
    total_taxes: taxSummaryOf(lines),
    automatic_tax: automaticTax,
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
