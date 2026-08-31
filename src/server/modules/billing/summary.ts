/**
 * `GET /v1/customers/:id/summary` — everything a support agent needs about an
 * account on one screen, with no follow-up requests: what they are on, what
 * they owe, what they have paid to date, what happens next and why.
 *
 * Where the invoices come from is a seam rather than an assumption. Billing
 * draws its own and registers itself as the reader at boot, so this screen
 * shows real bills out of the box; a dedicated invoicing module can take the
 * seam over with `ctx.svc.billing.useInvoiceReader()` and every number here
 * follows it without this file changing.
 */
import { formatMoney, money } from '../../../shared/money';
import { DAY, addInterval, formatRelative } from '../../../shared/time';
import { describeInterval, intervalOf, isMetered, longDate, recurringLines, recurringSubtotal, subscriptionMrr } from './cycle';
import { countsAsRevenue, describeStatus, isTerminal } from './status';
import type { Billing } from './store';
import type {
  BalanceTransaction, Customer, PendingInvoiceItem, RecurringLine, Subscription, SubscriptionStatus,
} from './types';

/** One open invoice, as reported by whichever module owns invoicing. */
export interface OpenInvoice {
  id: string;
  number: string | null;
  status: string;
  currency: string;
  total: number;
  amount_due: number;
  due_date: number | null;
  created: number;
}

/**
 * The extension point. It is deliberately tiny: this screen only ever asks
 * "what is still open for this customer, and how much have they been billed in
 * total?". A reader that cannot answer the second question falls back to the
 * period ledger, which is why `lifetimeBilled` is optional.
 */
export interface InvoiceReader {
  openInvoices(orgId: string, customerId: string): OpenInvoice[];
  lifetimeBilled?(orgId: string, customerId: string): number;
}

export interface SubscriptionSummaryRow {
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
  pause_collection: Subscription['pause_collection'];
  schedule: string | null;
}

export interface NextInvoicePreview {
  subscription: string;
  date: number;
  currency: string;
  lines: RecurringLine[];
  subtotal: number;
  uninvoiced_total: number;
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
    data: SubscriptionSummaryRow[];
  };
  mrr: number;
  arr: number;
  balance: {
    amount: number;
    currency: string;
    /** True when the amount is credit the customer holds. */
    credit: boolean;
    description: string;
    transactions: BalanceTransaction[];
  };
  lifetime_value: {
    amount: number;
    currency: string;
    periods_billed: number;
    customer_since: number | null;
    source: 'invoicing' | 'subscription_ledger';
  };
  next_invoice: NextInvoicePreview | null;
  open_invoices: {
    data: OpenInvoice[];
    total: number;
    oldest_due: number | null;
    source: 'invoicing';
  };
  uninvoiced_items: {
    data: PendingInvoiceItem[];
    total: number;
  };
  attention: string[];
}

export function buildCustomerSummary(
  billing: Billing, orgId: string, customerId: string, reader: InvoiceReader, now: number,
): CustomerSummary {
  const customer = billing.requireCustomer(orgId, customerId);
  const locale = billing.locale(orgId);
  const book = billing.book(orgId);
  const subs = billing.listSubscriptions(orgId, { customer: customerId, status: 'all', limit: 100 }).data;

  const byStatus: Partial<Record<SubscriptionStatus, number>> = {};
  for (const sub of subs) byStatus[sub.status] = (byStatus[sub.status] ?? 0) + 1;

  const rows: SubscriptionSummaryRow[] = subs.map((sub) => {
    const lines = recurringLines(sub.items, { start: sub.current_period_start, end: sub.current_period_end }, { book, currency: sub.currency, locale });
    return {
      id: sub.id,
      status: sub.status,
      status_detail: describeStatus(sub.status),
      description: sub.description,
      items: lines.map((line) => ({
        price: line.price, description: line.description, quantity: line.quantity,
        metered: line.metered, amount: line.amount,
      })),
      currency: sub.currency,
      interval: describeInterval(sub.interval_count, sub.interval),
      mrr: countsAsRevenue(sub.status) ? subscriptionMrr(sub, book) : 0,
      current_period_start: sub.current_period_start,
      current_period_end: sub.current_period_end,
      renews_in: isTerminal(sub.status)
        ? `ended ${formatRelative(sub.ended_at ?? sub.updated, now, locale)}`
        : `${sub.cancel_at_period_end ? 'ends' : 'renews'} ${formatRelative(sub.current_period_end, now, locale)}`,
      cancel_at_period_end: sub.cancel_at_period_end,
      cancel_at: sub.cancel_at,
      trial_end: sub.trial_end,
      collection_method: sub.collection_method,
      pause_collection: sub.pause_collection,
      schedule: sub.schedule,
    };
  });

  const live = subs.filter((s) => !isTerminal(s.status));
  const mrr = rows.reduce((total, row) => total + row.mrr, 0);

  /* ------------------------------ lifetime value --------------------------- */

  const periods = billing.periods(orgId, { customer: customerId, to: now, limit: 2000 })
    .filter((p) => p.status === 'billed');
  const ledgerValue = periods.reduce((total, p) => total + p.amount, 0)
    + billing.pendingItems(orgId, { customer: customerId, status: 'invoiced', limit: 500 })
      .reduce((total, item) => total + item.amount, 0);
  const invoiced = reader.lifetimeBilled ? reader.lifetimeBilled(orgId, customerId) : null;
  const customerSince = subs.length ? Math.min(...subs.map((s) => s.start_date)) : null;

  /* ------------------------------- next invoice ---------------------------- */

  const upcoming = live
    .filter((s) => s.status !== 'incomplete')
    .sort((a, b) => a.current_period_end - b.current_period_end)[0] ?? null;

  const uninvoiced = billing.pendingItems(orgId, { customer: customerId, status: 'pending', limit: 200 });
  const uninvoicedTotal = uninvoiced.reduce((total, item) => total + item.amount, 0);

  let nextInvoice: NextInvoicePreview | null = null;
  if (upcoming) {
    // Recurring charges are billed in advance, so the next invoice covers the
    // period that begins where the current one ends — including the first paid
    // period after a trial.
    const iv = intervalOf(upcoming);
    const period = {
      start: upcoming.current_period_end,
      end: addInterval(upcoming.current_period_end, iv, upcoming.billing_cycle_anchor_day),
    };
    const lines = upcoming.cancel_at_period_end
      ? []
      : recurringLines(upcoming.items, period, { book, currency: upcoming.currency, locale });
    const subtotal = recurringSubtotal(lines);
    // A credit balance is drawn down by the invoice; it can never take a total
    // below zero, so what is left stays on the account for next time.
    const balanceApplied = customer.balance < 0 ? Math.max(customer.balance, -(subtotal + uninvoicedTotal)) : customer.balance;
    const metered = upcoming.items.filter((item) => isMetered(book.price(item.price)));
    nextInvoice = {
      subscription: upcoming.id,
      date: upcoming.current_period_end,
      currency: upcoming.currency,
      lines,
      subtotal,
      uninvoiced_total: uninvoicedTotal,
      balance_applied: balanceApplied,
      estimated_total: Math.max(0, subtotal + uninvoicedTotal + balanceApplied),
      note: upcoming.cancel_at_period_end
        ? `This subscription ends on ${longDate(upcoming.current_period_end, locale)}, so there is no renewal charge — only anything still outstanding.`
        : metered.length
          ? `Plus metered usage for ${longDate(upcoming.current_period_start, locale)} to ${longDate(upcoming.current_period_end, locale)}, which is not known until the period closes.`
          : `Covers ${longDate(period.start, locale)} to ${longDate(period.end, locale)}.`,
    };
  }

  /* ------------------------------ open invoices ---------------------------- */

  const openInvoices = reader.openInvoices(orgId, customerId);
  const openTotal = openInvoices.reduce((total, invoice) => total + invoice.amount_due, 0);
  const oldestDue = openInvoices
    .map((invoice) => invoice.due_date)
    .filter((due): due is number => due !== null)
    .sort((a, b) => a - b)[0] ?? null;

  /* -------------------------------- attention ------------------------------ */

  const attention: string[] = [];
  if (customer.delinquent) {
    attention.push(`${customer.name} is delinquent — ${(byStatus.past_due ?? 0) + (byStatus.unpaid ?? 0)} subscription(s) are not being collected.`);
  }
  for (const sub of live) {
    if (sub.status === 'trialing' && sub.trial_end !== null && sub.trial_end - now <= 7 * DAY) {
      attention.push(`Trial on ${sub.id} ends ${formatRelative(sub.trial_end, now, locale)}; there is ${sub.default_payment_method ?? customer.invoice_settings.default_payment_method ? 'a payment method on file' : 'no payment method on file'}.`);
    }
    if (sub.cancel_at_period_end) {
      attention.push(`${sub.id} is set to cancel on ${longDate(sub.current_period_end, locale)}.`);
    }
    if (sub.pause_collection) {
      attention.push(`Collection on ${sub.id} is paused (${sub.pause_collection.behavior})${sub.pause_collection.resumes_at ? `, resuming ${formatRelative(sub.pause_collection.resumes_at, now, locale)}` : ''}.`);
    }
  }
  if (openInvoices.length) {
    const oldest = openInvoices[0];
    attention.push(
      `${formatMoney(money(openTotal, customer.currency), { locale })} is outstanding across ` +
      `${openInvoices.length} invoice${openInvoices.length === 1 ? '' : 's'}; the oldest is ` +
      `${oldest.number ?? oldest.id}, raised ${longDate(oldest.created, locale)}.`,
    );
  }
  if (oldestDue !== null && oldestDue < now) {
    attention.push(`An invoice has been overdue since ${longDate(oldestDue, locale)}.`);
  }

  const balanceAmount = customer.balance;
  const headline = live.length === 0
    ? `${customer.name} has no live subscriptions.`
    : `${customer.name} — ${live.length} live subscription${live.length === 1 ? '' : 's'}, ${formatMoney(money(mrr, customer.currency), { locale })} MRR.`;

  return {
    object: 'customer_summary',
    as_of: now,
    customer,
    headline,
    subscriptions: { total: subs.length, live: live.length, by_status: byStatus, data: rows },
    mrr,
    arr: mrr * 12,
    balance: {
      amount: balanceAmount,
      currency: customer.currency,
      credit: balanceAmount < 0,
      description: balanceAmount === 0
        ? 'No balance carried forward.'
        : balanceAmount < 0
          ? `${formatMoney(money(-balanceAmount, customer.currency), { locale })} of credit, which comes off the next invoice.`
          : `${formatMoney(money(balanceAmount, customer.currency), { locale })} carried forward and added to the next invoice.`,
      transactions: billing.balanceTransactions(orgId, customerId, 10),
    },
    lifetime_value: {
      amount: invoiced ?? ledgerValue,
      currency: customer.currency,
      periods_billed: periods.length,
      customer_since: customerSince,
      source: invoiced === null ? 'subscription_ledger' : 'invoicing',
    },
    next_invoice: nextInvoice,
    open_invoices: {
      data: openInvoices,
      total: openTotal,
      oldest_due: oldestDue,
      source: 'invoicing',
    },
    uninvoiced_items: { data: uninvoiced, total: uninvoicedTotal },
    attention,
  };
}
