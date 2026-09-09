/**
 * What the screen says after a write — worded from the record as it stands
 * once the write has landed, never from the request that was sent.
 *
 * Every sentence here used to be chosen before the server answered: "The first
 * period is open and billed" was printed over a subscription whose first charge
 * the issuer had just refused, and "The proration is waiting on the next
 * invoice" over an invoice that had already been raised and settled from the
 * account balance. Stripe never tells you a card was charged until the charge
 * object says so. These functions are pure so that rule can be tested without a
 * browser: hand them the subscription or invoice the API returned and they say
 * only what that record supports.
 */
import type { ChangePreview, Invoice, InvoicePayments, ProrationBehavior, Subscription } from './types';

/** The two formatters a sentence about money needs, decoupled from React. */
export interface CopyFormat {
  money: (amount: number, currency: string) => string;
  /** A billing boundary — a due date, a period end — on the document's calendar. */
  day: (ts: number) => string;
}

export interface WriteCopy {
  tone: 'success' | 'warning' | 'info';
  title: string;
  description: string;
}

/* ----------------------------- a new subscription ------------------------- */

/**
 * Whether the first invoice has been answered yet.
 *
 * `POST /v1/subscriptions` returns before the collector runs: the invoice is
 * `open`, the subscription `active`, and a second later the job presents the
 * card and the record becomes `past_due` or the invoice `paid`. Until one of
 * those has happened, nothing can honestly be said about the money, so the
 * caller keeps reading until this answers true or its patience runs out.
 */
export function firstInvoiceSettled(sub: Subscription): boolean {
  if (sub.status !== 'active') return true;
  const invoice = sub.latest_invoice;
  if (!invoice) return true;
  if (invoice.status !== 'open') return true;
  if (sub.collection_method !== 'charge_automatically') return true;
  return invoice.amount_due <= 0;
}

/**
 * The toast for a subscription that has just been created, from the record as
 * it stands after the first collection has been attempted.
 */
export function describeCreatedSubscription(
  sub: Subscription,
  f: CopyFormat,
  /** The first bill in full, when it could be read; the subscription's own brief record otherwise. */
  bill: Invoice | null = null,
  payments: Pick<InvoicePayments, 'summary' | 'collectable_note'> | null = null,
): WriteCopy {
  const invoice = bill ?? sub.latest_invoice;
  const mrr = `${f.money(sub.mrr, sub.currency)} a month of recurring revenue.`;

  if (sub.status === 'trialing') {
    return {
      tone: 'success',
      title: 'Subscription created',
      description: sub.trial_end
        ? `The trial runs until ${f.day(sub.trial_end)}; nothing has been billed yet.`
        : 'It is trialing; nothing has been billed yet.',
    };
  }

  if (!invoice) {
    return {
      tone: 'success',
      title: 'Subscription created',
      description: `Nothing has been billed yet — the first invoice is raised when the first period opens. ${mrr}`,
    };
  }

  const owed = f.money(invoice.amount_due, sub.currency);
  const declined = payments?.summary ?? 'The card on file refused it.';

  if (sub.status === 'past_due' || sub.status === 'unpaid') {
    return {
      tone: 'warning',
      title: 'Subscription created — the first charge was declined',
      description: `${invoice.number} for ${owed} is still owed. ${declined} Fix the card on the account, then present the invoice again.`,
    };
  }

  if (invoice.status === 'paid') {
    // Only the full record says what paid it; the brief one says only that it was.
    const how = !bill
      ? 'settled'
      : bill.amount_paid > 0
        ? 'collected from the method on file'
        : bill.balance_applied !== 0
          ? 'settled from the account balance'
          : 'settled';
    return {
      tone: 'success',
      title: 'Subscription created',
      description: `${invoice.number} for ${f.money(bill ? bill.subtotal + bill.tax : invoice.total, sub.currency)} was raised and ${how}. ${mrr}`,
    };
  }

  if (invoice.status === 'open' && sub.collection_method === 'send_invoice') {
    const due = invoice.due_date ? `due ${f.day(invoice.due_date)}` : 'payable on receipt';
    return {
      tone: 'success',
      title: 'Subscription created',
      description: `${invoice.number} for ${owed} was raised to be paid by transfer — ${due}. ${mrr}`,
    };
  }

  if (invoice.status === 'open') {
    // Charged automatically, still open, and the subscription is not past due:
    // nothing has been presented yet. The server's own sentence says why.
    return {
      tone: 'info',
      title: 'Subscription created — nothing collected yet',
      description: `${invoice.number} for ${owed} is open. ${payments?.collectable_note ?? payments?.summary ?? 'It is presented to the method on file as soon as the collector runs.'}`,
    };
  }

  return { tone: 'success', title: 'Subscription created', description: mrr };
}

/* ----------------------------- a changed subscription --------------------- */

/**
 * The toast after `PATCH /v1/subscriptions/:id`, worded from the proration
 * behaviour that was sent and the invoice the server actually raised.
 *
 * `raised` is the subscription's latest invoice as it stands once any
 * collection against it has been answered — the caller waits for that the same
 * way it waits on a new subscription's first bill.
 */
export function describeAppliedChange(
  preview: ChangePreview,
  behavior: ProrationBehavior,
  raised: Invoice | null,
  f: CopyFormat,
): WriteCopy {
  const currency = preview.currency;
  const title = 'Subscription changed';

  if (behavior === 'none') {
    return {
      tone: 'success',
      title,
      description: `Nothing was prorated — the new price starts at the next renewal on ${f.day(preview.current_period.end)}.`,
    };
  }

  if (preview.lines.length === 0) {
    return { tone: 'success', title, description: 'The change moves no money inside this period.' };
  }

  if (behavior === 'create_prorations') {
    const net = preview.net;
    const what = net < 0
      ? `${f.money(-net, currency)} of credit`
      : `${f.money(net, currency)} of proration`;
    return {
      tone: 'success',
      title,
      description: `${what} is priced and waits for the next invoice on ${f.day(preview.next_invoice.date)}.`,
    };
  }

  // always_invoice: the only honest source is the invoice that came back.
  if (!raised || raised.billing_reason !== 'subscription_update') {
    return {
      tone: 'info',
      title,
      description: 'The change was applied. No invoice for it has been raised yet — check the invoices on this subscription.',
    };
  }
  const billed = f.money(raised.subtotal + raised.tax, raised.currency);
  if (raised.status === 'paid') {
    if (raised.amount_paid === 0 && raised.balance_applied !== 0) {
      const before = f.money(Math.abs(raised.starting_balance), raised.currency);
      const after = f.money(Math.abs(raised.ending_balance), raised.currency);
      const left = raised.ending_balance < 0 ? `leaving ${after} of credit` : raised.ending_balance === 0 ? 'using it up' : `leaving ${after} carried forward`;
      return {
        tone: 'success',
        title,
        description: `${raised.number} for ${billed} was raised now and paid from the ${before} account balance, ${left}.`,
      };
    }
    return {
      tone: 'success',
      title,
      description: `${raised.number} for ${billed} was raised now and ${f.money(raised.amount_paid, raised.currency)} was collected from the method on file.`,
    };
  }
  if (raised.status === 'open') {
    if (raised.collection_method === 'send_invoice') {
      return {
        tone: 'success',
        title,
        description: `${raised.number} for ${f.money(raised.amount_due, raised.currency)} was raised now, to be paid by transfer${raised.due_date ? ` by ${f.day(raised.due_date)}` : ''}.`,
      };
    }
    return {
      tone: 'warning',
      title: 'Subscription changed — the charge was declined',
      description: `${raised.number} for ${f.money(raised.amount_due, raised.currency)} was raised now and is still owed. The method on file refused it; it is in the recovery queue.`,
    };
  }
  return {
    tone: 'info',
    title,
    description: `${raised.number} was raised now and is ${raised.status_detail.replace(/\.$/, '').toLowerCase()}.`,
  };
}

/** True once an invoice charged automatically has been answered by the issuer. */
export function collectionSettled(invoice: Invoice): boolean {
  if (invoice.status !== 'open') return true;
  if (invoice.collection_method !== 'charge_automatically') return true;
  return invoice.amount_due <= 0;
}

/* ------------------------- the balance in a preview ----------------------- */

/**
 * How much of a change billed now is paid from the credit the account holds.
 *
 * The preview reports `net` (what the change costs) and `amount_due_now` (what
 * a card would be asked for). The difference is the balance the invoice will
 * draw — both figures are the server's, so the line is arithmetic on its
 * answer rather than a second pricing. Only an immediate bill draws the
 * balance; prorations that wait for the next invoice draw it then.
 */
export function balanceDrawn(preview: Pick<ChangePreview, 'net' | 'amount_due_now' | 'customer_balance' | 'proration_behavior'>): {
  drawn: number; after: number;
} | null {
  if (preview.proration_behavior !== 'always_invoice') return null;
  if (preview.net <= 0 || preview.customer_balance >= 0) return null;
  const drawn = preview.net - preview.amount_due_now;
  if (drawn <= 0) return null;
  return { drawn, after: preview.customer_balance + drawn };
}

/* ----------------------------- one-off invoices --------------------------- */

const ONE_DAY = 86_400_000;

/**
 * A bill raised by hand covers no service period — the engine stamps it on the
 * day it was raised, and printing "Sep 5, 2026 to Sep 5, 2026" (or "to Sep 6")
 * reads as a one-day subscription that never existed. Any bill whose two ends
 * coincide says the same; a manual sweep whose window is a day or less does too.
 */
export function coversNoPeriod(invoice: Pick<Invoice, 'period' | 'billing_reason'>): boolean {
  const span = invoice.period.end - invoice.period.start;
  if (span <= 0) return true;
  return invoice.billing_reason === 'manual' && span <= ONE_DAY;
}

/**
 * The same rule one level down. A hand-written line carries the day it was
 * raised as its period, so the document's header read "One-off — no service
 * period" while the line under it printed "Sep 7 – Sep 8, 2026": the header
 * and the line disagreeing about the same fact, on the same screen.
 */
export function lineCoversNoPeriod(line: { kind: string; period: { start: number; end: number } }): boolean {
  if (line.kind !== 'invoice_item') return false;
  return line.period.end - line.period.start <= ONE_DAY;
}

/* ----------------------------- deleting an account ------------------------ */

export interface DeleteFacts {
  live: number;
  balance: number;
  currency: string;
  openInvoices: number;
}

/**
 * What deleting an account destroys, and whether the server will allow it.
 *
 * The server refuses while a live subscription exists; saying so in the dialog
 * is the difference between a closed door with a reason on it and a click that
 * bounces off a 409.
 */
export function describeDelete(name: string, facts: DeleteFacts, f: CopyFormat): { blocked: string | null; body: string } {
  const parts: string[] = [];
  if (facts.live > 0) {
    parts.push(`${name} still has ${facts.live === 1 ? 'a live subscription' : `${facts.live} live subscriptions`}, so the platform refuses to delete it — cancel them first.`);
  } else {
    parts.push(`${name} has no live subscription.`);
  }
  if (facts.balance < 0) parts.push(`It holds ${f.money(-facts.balance, facts.currency)} of credit, which is lost with the record.`);
  else if (facts.balance > 0) parts.push(`${f.money(facts.balance, facts.currency)} is carried on its balance and would never be billed.`);
  if (facts.openInvoices > 0) {
    parts.push(facts.openInvoices === 1 ? 'One open invoice still names it.' : `${facts.openInvoices} open invoices still name it.`);
  }
  parts.push('The record is removed from this workspace. There is no route that restores a deleted customer.');
  return {
    blocked: facts.live > 0 ? 'Cancel its subscriptions before deleting the customer.' : null,
    body: parts.join(' '),
  };
}

/* ------------------------------- server notes ----------------------------- */

const ISO_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

/**
 * A sentence the server wrote for any client, made readable on this one.
 *
 * The gateway notes "Collected by ch_eE240tnjW6N0N0XC on 2026-09-05": an id
 * and an ISO date in a banner an operator reads aloud to a customer. The id
 * becomes the thing it names, and the date is formatted on the invoice's own
 * calendar — the same UTC day the ISO string states.
 */
export function humaniseNote(note: string, f: CopyFormat, names: { charge?: string; method?: string } = {}): string {
  return note
    .replace(/\bch_[A-Za-z0-9]+\b/g, names.method ?? names.charge ?? 'the method on file')
    .replace(ISO_DAY, (_match, y: string, m: string, d: string) => f.day(Date.UTC(Number(y), Number(m) - 1, Number(d))));
}

/**
 * "1 subscription(s) are not being collected" — the summary's attention lines
 * pluralise with brackets. The number is in the sentence, so the bracket can be
 * resolved here rather than shown.
 */
export function pluraliseBrackets(line: string): string {
  return line.replace(/(\d+)\s+([a-z]+)\(s\)\s+(are|is|have|has)\b/gi, (_m, n: string, noun: string, verb: string) => {
    const one = Number(n) === 1;
    const singularVerb: Record<string, string> = { are: 'is', is: 'is', have: 'has', has: 'has' };
    const pluralVerb: Record<string, string> = { are: 'are', is: 'are', have: 'have', has: 'have' };
    return `${n} ${noun}${one ? '' : 's'} ${one ? singularVerb[verb.toLowerCase()] : pluralVerb[verb.toLowerCase()]}`;
  }).replace(/(\d+)\s+([a-z]+)\(s\)/gi, (_m, n: string, noun: string) => `${n} ${noun}${Number(n) === 1 ? '' : 's'}`);
}

/* ------------------------------ what a bill says -------------------------- */

/**
 * What the customer was billed: the lines plus the tax on them.
 *
 * The API's `total` is that figure *after* the account balance was drawn, so
 * a $106.53 bill settled entirely from credit reported `total: 0` — and the
 * screen printed "Total $0.00" over a $106.53 invoice. Stripe keeps Total
 * pre-balance and shows the balance as its own line above Amount due; so does
 * every screen here now, by computing it from the two figures that never move.
 */
export function billedTotal(invoice: Pick<Invoice, 'subtotal' | 'tax'>): number {
  return invoice.subtotal + invoice.tax;
}

/* -------------------------- what an invoice can do ------------------------ */

export type InvoiceAction = 'finalize' | 'pay' | 'refund' | 'credit' | 'void' | 'uncollectible';

/**
 * The actions an invoice's state actually allows, in the order a menu lists
 * them. The menu used to carry all of them on every bill and grey the ones
 * that did not apply — "Finalise this draft" on a paid invoice, "Void" on a
 * voided one — with no word about why. A menu built from this list offers only
 * what the server would accept.
 */
export function invoiceActions(invoice: Pick<Invoice, 'status' | 'amount_due' | 'amount_paid'>): InvoiceAction[] {
  const out: InvoiceAction[] = [];
  switch (invoice.status) {
    case 'draft':
      out.push('finalize', 'void');
      break;
    case 'open':
      if (invoice.amount_due > 0) out.push('pay');
      if (invoice.amount_paid > 0) out.push('refund');
      out.push('credit', 'void', 'uncollectible');
      break;
    case 'paid':
      if (invoice.amount_paid > 0) out.push('refund');
      out.push('credit');
      break;
    case 'uncollectible':
      if (invoice.amount_paid > 0) out.push('refund');
      out.push('credit', 'void');
      break;
    case 'void':
      break;
  }
  return out;
}

export type BulkInvoiceKind = 'void' | 'pay' | 'finalize';

/**
 * Why a bulk action would leave one selected invoice alone — or null when it
 * would act on it. Stated per row before anything runs, so "Void 3" never
 * comes back as "Voided 1 of 3".
 */
export function bulkSkipReason(kind: BulkInvoiceKind, invoice: Pick<Invoice, 'status' | 'amount_due' | 'amount_paid'>): string | null {
  switch (kind) {
    case 'void':
      if (invoice.status === 'paid') return 'Paid — a settled bill cannot be voided; credit it instead';
      if (invoice.status === 'void') return 'Already voided';
      return null;
    case 'pay':
      if (invoice.status === 'draft') return 'A draft is not owed yet — finalise it first';
      if (invoice.status !== 'open') return 'Not open — there is nothing to record against it';
      if (invoice.amount_due <= 0) return 'Nothing is owed on it';
      return null;
    case 'finalize':
      return invoice.status === 'draft' ? null : 'Not a draft — it is already finalised';
  }
}

/* --------------------------- the annual figure --------------------------- */

/**
 * How many times a year a cadence bills. The summary writes the cadence as
 * `describeInterval` does — "month", "year", "3 months" — so both spellings
 * are read. Null for a unit this platform does not bill on.
 */
export function periodsPerYear(interval: string): number | null {
  const match = /^(?:(\d+)\s+)?(day|week|month|year)s?$/.exec(interval.trim());
  if (!match) return null;
  const count = match[1] ? Number(match[1]) : 1;
  if (!Number.isFinite(count) || count <= 0) return null;
  const perYear = { day: 365, week: 52, month: 12, year: 1 }[match[2] as 'day' | 'week' | 'month' | 'year'];
  return perYear / count;
}

/**
 * Annual recurring revenue from the recurring amounts and their cadences.
 *
 * The API's `arr` is `mrr × 12`, and MRR on a $127,840.00 yearly plan is
 * $10,653.33 — so the tile said "$127,839.96 a year" for a plan whose price
 * is a round number. Adding each live agreement's period fee, scaled by how
 * many periods a year it bills, gives the figure the contract says. Metered
 * items carry no amount and add nothing; a paused agreement is outside MRR
 * and outside this. Null when a cadence cannot be read, so the caller can
 * fall back to the API's figure rather than print a partial one.
 */
export function annualRecurring(
  subs: { mrr: number; interval: string; items: { amount: number | null }[] }[],
): number | null {
  let total = 0;
  for (const sub of subs) {
    if (sub.mrr <= 0) continue;
    const perYear = periodsPerYear(sub.interval);
    if (perYear === null) return null;
    const perPeriod = sub.items.reduce((sum, item) => sum + (item.amount ?? 0), 0);
    total += perPeriod * perYear;
  }
  return Math.round(total);
}

/* ---------------------------- schedule phases ----------------------------- */

/**
 * One item of a schedule phase, priced in the currency that will bill it.
 *
 * `subscription_schedule.phases[].summary` is written on the server by
 * `schedulePayload`, which prices every item with `book.compute(price,
 * quantity, price.currency)` — the *price's* home currency, never the
 * subscription's. Every price in the demo book is priced in dollars first and
 * carries `currency_options` for the rest, so a EUR account with a change
 * booked onto Scale reads "$1,900.00" for a phase that will bill €1,750.00:
 * the wrong symbol, and — because a currency option is a separate amount, not
 * a conversion — the wrong number beside it.
 *
 * The client cannot rewrite that field. What it can do is what the create
 * dialog already does: price the phase through `POST /v1/catalog/estimate` in
 * the subscription's own currency, which is the same `computeLineAmount` the
 * renewal will run.
 */
export interface PhaseLine {
  price: string;
  quantity: number;
  /** The name a human uses for the line — product, then nickname. */
  label: string;
  /** Priced in the subscription's currency; null while nothing has priced it. */
  amountDisplay: string | null;
  /** A metered line has no amount until the period closes, and says so. */
  metered: boolean;
}

export interface PhaseItem {
  price: string;
  quantity: number;
  custom_unit_amount: number | null;
}

/** What the price book knows about one price, as a phase line needs it. */
export interface PhasePrice {
  product_name: string;
  nickname: string | null;
  /** True when this price is its product's default, and so speaks for it. */
  is_default: boolean;
  metered: boolean;
}

/**
 * The name a human uses for a line, the way `Pricebook.label` on the server
 * picks it: the product's own name is right for the plan it sells, and wrong
 * for the seats and add-ons that hang off the same product — which is exactly
 * what a nickname is for. Keeping the same rule is what stops a phase summary
 * naming a line differently from the invoice that bills it.
 */
export function priceLabel(price: PhasePrice): string {
  if (price.is_default && price.product_name) return price.product_name;
  return price.nickname || price.product_name;
}

/** What a phase's items are worth, as a sentence: the one the phase card prints. */
export function phaseSummary(lines: PhaseLine[]): string {
  return lines
    .map((line) => {
      const count = line.quantity > 1 ? `${line.quantity} × ` : '';
      if (line.metered) return `${count}${line.label} (metered)`;
      return line.amountDisplay ? `${count}${line.label} — ${line.amountDisplay}` : `${count}${line.label}`;
    })
    .join(', ');
}

/**
 * Join a phase's items to the price book and to the engine's answer.
 *
 * The estimate returns one line per line sent, in order, so items are paired
 * by position — a phase may legitimately carry the same price twice, and
 * pairing by id would then read one of them twice. Anything the book has not
 * answered for yet falls back to the estimate's own product name, and then to
 * the price id, so a row is never blank while a read is in flight.
 */
export function phaseLines(
  items: PhaseItem[],
  priced: { price: string; quantity: number; amount_display: string; product: { name: string } | null; nickname: string | null }[] | null,
  priceOf: (id: string) => PhasePrice | null,
): PhaseLine[] {
  return items.map((item, index) => {
    const price = priceOf(item.price);
    const line = priced?.[index] ?? null;
    const fallback = line?.nickname || line?.product?.name || item.price;
    return {
      price: item.price,
      quantity: item.quantity,
      label: price ? priceLabel(price) : fallback,
      amountDisplay: line ? line.amount_display : null,
      metered: price?.metered ?? false,
    };
  });
}

/* ------------------------ the next invoice, as booked --------------------- */

export interface PhaseWindow {
  id: string;
  state: 'complete' | 'current' | 'upcoming';
  start_date: number;
  end_date: number;
  items: PhaseItem[];
  description: string | null;
}

/**
 * The phase that governs the period beginning `periodStart`, when it is not
 * the one already running.
 *
 * A released, canceled or completed schedule governs nothing — the
 * subscription has been handed back to whatever it holds today.
 */
export function phaseGoverning(
  schedule: { status: string; phases: PhaseWindow[] } | null,
  periodStart: number,
): PhaseWindow | null {
  if (!schedule || (schedule.status !== 'active' && schedule.status !== 'not_started')) return null;
  const phase = schedule.phases.find((p) => p.start_date <= periodStart && p.end_date > periodStart) ?? null;
  return phase && phase.state === 'upcoming' ? phase : null;
}

/** An item as `POST /v1/invoices/create_preview` takes it. */
export interface PreviewItem {
  id?: string;
  price?: string;
  quantity?: number;
  custom_unit_amount?: number;
  deleted?: boolean;
}

/**
 * The phase, written as the change the engine will actually make.
 *
 * `items` on the preview is a patch, not a replacement: sending only the new
 * plan's prices leaves the old ones standing and quotes both — a EUR account
 * moving from Growth to Scale priced at €3,091.00, which is the two plans
 * added together. So this mirrors `Billing.applyPhase` exactly: an item whose
 * price the phase also carries keeps its identity, and only what the phase
 * drops is removed.
 */
export function phasePreviewItems(
  current: { id: string; price: string }[],
  phase: Pick<PhaseWindow, 'items'>,
): PreviewItem[] {
  const carried = new Set(phase.items.map((item) => item.price));
  return [
    ...current.filter((item) => !carried.has(item.price)).map((item) => ({ id: item.id, deleted: true })),
    ...phase.items.map((item) => ({
      price: item.price,
      quantity: item.quantity,
      ...(item.custom_unit_amount !== null ? { custom_unit_amount: item.custom_unit_amount } : {}),
    })),
  ];
}

export interface ScheduledUpcoming {
  /** The phase that takes over at the boundary this bill covers, if any. */
  phase: PhaseWindow | null;
  /** The item patch to price the bill with, or null when it must not be re-priced. */
  items: PreviewItem[] | null;
  /** Why the booked change could not be priced here, in the words to show. */
  caveat: string | null;
}

/**
 * How the upcoming-invoice preview must be asked for on a subscription that
 * has a change already booked.
 *
 * `POST /v1/invoices/create_preview` prices the next period from the items the
 * subscription holds *today*, and the customer summary's `next_invoice` does
 * the same. Neither reads the schedule, so on the one period a phase replaces
 * they quote the plan being left — directly under a banner that says the
 * account moves. Re-pricing through the phase's own items is what makes the
 * two agree.
 *
 * A phase that bills on a different cadence is the one case the client leaves
 * alone: changing cadence re-anchors the cycle, so the preview would come back
 * describing a period starting today rather than the one on screen. That is
 * said in words instead of quoted wrongly.
 */
export function scheduledUpcoming(
  sub: { current_period_end: number; interval: string; interval_count: number; items: { id: string; price: string }[] },
  schedule: { status: string; phases: PhaseWindow[] } | null,
  f: CopyFormat,
  cadenceOf: (priceId: string) => { interval: string; interval_count: number } | null,
): ScheduledUpcoming {
  const phase = phaseGoverning(schedule, sub.current_period_end);
  if (!phase) return { phase: null, items: null, caveat: null };

  const cadences = phase.items.map((item) => cadenceOf(item.price));
  const unknown = cadences.some((cadence) => cadence === null);
  if (unknown) {
    return {
      phase,
      items: null,
      caveat: 'The prices this change moves on to could not be read, so the bill below is still priced on the plan running today.',
    };
  }
  const moves = cadences.some((cadence) => cadence && (cadence.interval !== sub.interval || cadence.interval_count !== sub.interval_count));
  if (moves) {
    return {
      phase,
      items: null,
      caveat:
        `The change booked for ${f.day(phase.start_date)} also moves the billing cadence, which restarts the cycle — `
        + 'so the period below is not the one it will bill. Open the schedule for what the new plan costs.',
    };
  }
  return { phase, items: phasePreviewItems(sub.items, phase), caveat: null };
}

/* ------------------------------ credit notes ------------------------------ */

/**
 * Where a credit note's money went, said from the note and the bill together.
 *
 * The server writes this sentence too, and its last branch is false on a bill
 * that was part collected. Routing is chosen as `invoice.status === 'paid' ?
 * post_payment : pre_payment`, and `displaced_to_balance` only becomes
 * non-zero once a note outruns what the bill is *still owed* — so a $500.00
 * invoice with $166.66 collected, credited $83.33, takes the last branch and
 * reads "nothing had been collected yet" beside an `amount_paid` of $166.66.
 * The screen has the invoice in hand, so it says what the invoice says.
 */
export function creditNoteRouting(
  note: {
    total: number; currency: string;
    pre_payment_amount: number; post_payment_amount: number; displaced_to_balance: number;
    refund_amount: number; credit_amount: number; out_of_band_amount: number;
  },
  invoice: { number: string | null; amount_paid: number },
  f: CopyFormat,
): string {
  const money = (amount: number) => f.money(amount, note.currency);
  const bill = invoice.number ?? 'the invoice';

  if (note.post_payment_amount > 0) {
    const parts: string[] = [];
    if (note.refund_amount > 0) parts.push(`${money(note.refund_amount)} went back to the customer’s card through the payments module`);
    if (note.credit_amount > 0) parts.push(`${money(note.credit_amount)} was put onto the customer’s balance and comes off the next invoice`);
    if (note.out_of_band_amount > 0) parts.push(`${money(note.out_of_band_amount)} was returned outside the platform and is only recorded here`);
    return `${bill} had already been paid, so the credit was handed back: ${parts.join('; ')}.`;
  }

  if (note.displaced_to_balance > 0) {
    const absorbed = note.pre_payment_amount - note.displaced_to_balance;
    return `${money(absorbed)} came off what ${bill} asks for, which is all it was still owed; `
      + `the remaining ${money(note.displaced_to_balance)} had already been collected, so it went onto the customer’s `
      + 'balance and comes off the next invoice.';
  }

  if (invoice.amount_paid > 0) {
    return `${money(note.pre_payment_amount)} came off what ${bill} asks for. `
      + `The ${money(invoice.amount_paid)} already collected against it stays collected — this note reduces the balance still owed, not the money in.`;
  }

  return `${money(note.pre_payment_amount)} came off what ${bill} asks for; nothing had been collected yet.`;
}
