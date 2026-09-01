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
import { describeInterval, intervalOf, isMetered, longDate, recurringLines, subscriptionMrr } from './cycle';
import { countsAsRevenue, describeStatus, isTerminal } from './status';
import { PENDING_ITEMS_PER_INVOICE, type Billing } from './store';
import type {
  AutomaticTax, BalanceTransaction, Customer, PendingInvoiceItem, RecurringLine, Subscription, SubscriptionStatus,
} from './types';

/**
 * How many subscription rows this screen paints. The counts and the MRR beside
 * them are the whole account either way — this is the length of the list, not
 * the depth the numbers are read to.
 */
const SUBSCRIPTION_ROWS = 100;

/** How many per-subscription warnings are spelled out before they are counted. */
const ATTENTION_NOTES = 20;

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
  /** The price list's own view: what each item costs, tax included or not. */
  lines: RecurringLine[];
  /**
   * The taxable base of the recurring lines — what the bill will record as its
   * subtotal, not what the price list says. On a tax-inclusive price the two
   * differ by exactly the tax below, and adding the list price to that tax
   * would charge it twice over.
   */
  subtotal: number;
  /** The waiting prorations, on the same basis. */
  uninvoiced_total: number;
  /**
   * The tax the bill this predicts will actually charge, worked out by the same
   * call `issue()` makes. A next-invoice figure with the tax left out is short
   * by exactly the tax — 19% on a German account — and it is the number a
   * support agent reads out to the customer.
   */
  tax: number;
  /**
   * Whether the bill this predicts can be sent at all.
   *
   * A prediction of "€100.00, no tax" for an account Ain cannot place
   * is not a prediction of the bill that goes out — that bill is held as a
   * draft — and a panel that says the first without the second is telling a
   * support agent a number nobody will ever be asked to pay. The upcoming
   * invoice already carries this; so does the bill itself; this is the third
   * reader of the same question.
   */
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
    /** Every subscription on the account, however many rows `data` carries. */
    total: number;
    live: number;
    by_status: Partial<Record<SubscriptionStatus, number>>;
    /** A screenful of them, newest first. */
    data: SubscriptionSummaryRow[];
    /** True when `data` is shorter than `total`. */
    has_more: boolean;
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
    /**
     * The waiting proration lines the next bill will claim, read to the depth
     * that bill claims to. Anything beyond it rides the invoice after, which is
     * why this list and `next_invoice.uninvoiced_total` are read once and
     * shared rather than being two readings of the same ledger.
     */
    data: PendingInvoiceItem[];
    /** What those lines are worth on the ledger, before tax is taken out. */
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
  // Every subscription this account holds, not the first page of them.
  //
  // The overview learned this the expensive way — a book of 251 reported the
  // MRR of 200 — and this screen was reading one page deeper into the same
  // table. A holding company with 101 sites was told it had 100 subscriptions
  // and $49,900.00 of MRR against a real $50,399.00, `by_status` counted a
  // hundred of them, and `next_invoice` predicted the earliest renewal *of the
  // page* rather than of the account, which is a different bill on a different
  // date. There is no cap that makes those sentences true, so there is no cap.
  const subs: Subscription[] = [];
  let cursor: string | null = null;
  do {
    const page = billing.listSubscriptions(orgId, { customer: customerId, status: 'all', limit: 200, cursor });
    subs.push(...page.data);
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);

  const byStatus: Partial<Record<SubscriptionStatus, number>> = {};
  let mrr = 0;
  for (const sub of subs) {
    byStatus[sub.status] = (byStatus[sub.status] ?? 0) + 1;
    if (countsAsRevenue(sub.status)) mrr += subscriptionMrr(sub, book);
  }
  const live = subs.filter((s) => !isTerminal(s.status));

  // The counts and the money above are the whole account; the rows below are a
  // screenful of it. Reading the book in full and then publishing every row of
  // it would trade one unbounded answer for another, so what is capped is the
  // list a human scrolls, and `has_more` says so rather than letting a short
  // list read as the whole story.
  const rows: SubscriptionSummaryRow[] = subs.slice(0, SUBSCRIPTION_ROWS).map((sub) => {
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

  // Read to exactly the depth the invoice claims to. This is the set the next
  // bill sweeps up, so anything shallower describes a bill nobody will receive:
  // at 200 of 210 waiting lines the panel said $14.50 was outstanding while the
  // bill went out carrying $43.50 of it, and `create_preview` — which reads the
  // ledger at the invoice's own depth — disagreed with the panel beside it.
  const uninvoiced = billing.pendingItems(orgId, {
    customer: customerId, status: 'pending', limit: PENDING_ITEMS_PER_INVOICE,
  });
  const uninvoicedTotal = uninvoiced.reduce((total, item) => total + item.amount, 0);

  // Asked once for the account, because both the prediction and the attention
  // list below are about the same fact: whether a bill for this customer can be
  // placed at all.
  const automaticTax: AutomaticTax = billing.automaticTaxFor(orgId, customer);

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
    // The same rate engine the bill itself runs, on the same lines: a screen
    // that predicts a total the invoice will not charge is not a prediction.
    //
    // Every money figure below comes back out of *this* call, including the two
    // that look like they could be read straight off the price list. On a
    // tax-inclusive price the listed 100.00 already contains the tax, so the
    // bill's own subtotal is 91.86 and its tax is 8.14; publishing the list
    // price as `subtotal` beside that `tax` made the panel add up to 108.14 for
    // a bill that will say 100.00, and overstated it by exactly the tax the
    // customer was already paying. The rule is the one `issue()` follows: a
    // line's `amount` is the base, its tax is beside it, and the two are never
    // read off different paths.
    const recurring = billing.invoices.recurringDrafts(orgId, upcoming.id, lines);
    const prorated = billing.invoices.prorationDrafts(uninvoiced);
    const taxed = billing.invoices.taxDrafts(orgId, customer, [...recurring, ...prorated]);
    const subtotal = taxed.slice(0, recurring.length).reduce((total, line) => total + line.amount, 0);
    // What the waiting items will be worth *on the bill*. `uninvoiced_items`
    // below still reports what the ledger holds; this is the same money after
    // an inclusive price has had its tax taken out of it.
    const uninvoicedOnBill = taxed.slice(recurring.length).reduce((total, line) => total + line.amount, 0);
    const tax = taxed.reduce((total, line) => total + line.tax.amount, 0);
    // What the lines are worth with their tax on them. For an exclusive price
    // that is the amount plus the tax; for an inclusive one the tax came out of
    // the amount, so the two halves add back up to the listed price either way.
    const gross = subtotal + uninvoicedOnBill + tax;
    // `Invoices.issue()`'s own formula, not a second one that agrees on the
    // easy cases. Both invariants fall out of it: the bill never goes below
    // zero, and whatever the lines and the balance cannot settle between them
    // stays on the account.
    //
    // The formula it replaced clamped the draw against `max(0, gross)` and
    // handed a debit balance straight through, which is right for every bill
    // worth more than nothing and wrong the moment one is not. A next bill made
    // of credit lines — a mid-cycle downgrade waiting to be swept up — puts its
    // whole value onto the account, and this panel reported `balance_applied:
    // 0` for an $863.78 movement the bill itself records and `ending_balance`
    // states. The total was right in both readings, which is exactly why the
    // disagreement went unseen.
    const estimatedTotal = Math.max(0, gross + customer.balance);
    const balanceApplied = estimatedTotal - gross;
    const metered = upcoming.items.filter((item) => isMetered(book.price(item.price)));
    nextInvoice = {
      subscription: upcoming.id,
      date: upcoming.current_period_end,
      currency: upcoming.currency,
      lines,
      subtotal,
      uninvoiced_total: uninvoicedOnBill,
      tax,
      automatic_tax: automaticTax,
      balance_applied: balanceApplied,
      estimated_total: estimatedTotal,
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
  // The one thing on this screen that stops a bill going out, so it is said
  // before the things that only slow one down.
  if (automaticTax.status === 'requires_location_inputs') {
    attention.push(
      automaticTax.enabled
        ? `Ain could not place ${customer.name}’s address — it needs a country, and a state in a country whose tax is registered state by state — so the tax on their bills cannot be worked out and they are being held as drafts. Complete the address and finalise them.`
        : `Ain could not place ${customer.name}’s address — it needs a country, and a state in a country whose tax is registered state by state — so their bills go out with no tax on them and nobody can tell whether that is right. Complete the address.`,
    );
  }
  // One sentence per subscription is a readable list for the accounts almost
  // everybody has and a wall of text for a holding company with a thousand
  // sites, now that the book above is read in full. So the sentences are
  // written for a screenful and the rest are counted, which is the same bargain
  // `subscriptions.data` and `has_more` strike one field over.
  const perSubscription: string[] = [];
  for (const sub of live) {
    if (sub.status === 'trialing' && sub.trial_end !== null && sub.trial_end - now <= 7 * DAY) {
      perSubscription.push(`Trial on ${sub.id} ends ${formatRelative(sub.trial_end, now, locale)}; there is ${sub.default_payment_method ?? customer.invoice_settings.default_payment_method ? 'a payment method on file' : 'no payment method on file'}.`);
    }
    if (sub.cancel_at_period_end) {
      perSubscription.push(`${sub.id} is set to cancel on ${longDate(sub.current_period_end, locale)}.`);
    }
    if (sub.pause_collection) {
      perSubscription.push(`Collection on ${sub.id} is paused (${sub.pause_collection.behavior})${sub.pause_collection.resumes_at ? `, resuming ${formatRelative(sub.pause_collection.resumes_at, now, locale)}` : ''}.`);
    }
  }
  attention.push(...perSubscription.slice(0, ATTENTION_NOTES));
  if (perSubscription.length > ATTENTION_NOTES) {
    attention.push(`And ${perSubscription.length - ATTENTION_NOTES} more subscriptions on this account need attention — open the subscription list to work through them.`);
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
    subscriptions: {
      total: subs.length, live: live.length, by_status: byStatus, data: rows, has_more: rows.length < subs.length,
    },
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
