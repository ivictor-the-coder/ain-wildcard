/**
 * The invoice as a document.
 *
 * Everything else in this module answers 'what is owed?' in JSON. This file
 * answers the other half of the question — the thing a finance team actually
 * sends, and the thing a customer's accounts-payable clerk has to be able to
 * key into their own system without phoning anyone.
 *
 * It is deliberately one self-contained HTML file: no stylesheet to fetch, no
 * script to run, no font to load. That is what makes it printable, attachable
 * to an email and readable in ten years. Every number on it is read from the
 * invoice row and its lines — nothing is recomputed here, because a document
 * that disagrees with the ledger it prints is worse than no document.
 */
import type { Ctx } from '../../kernel/context';
import { formatMoney, money } from '../../../shared/money';
import { longDate } from './cycle';
import { combinePercentages, formatPercentage } from './tax';
import type { Billing } from './store';
import type { CreditNote, Customer, Invoice, InvoiceLine } from './types';

/** Who the bill comes from. Stored as a workspace setting, not a constant. */
export interface Issuer {
  legal_name: string;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  tax_id: string | null;
  email: string | null;
  phone: string | null;
  remittance: string | null;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/**
 * Escape text a person typed. Apostrophes become entities because every
 * attribute in this document is single-quoted — see `oneLine` for why.
 */
const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * Fold the document onto one line and leave no character in it that JSON would
 * have to escape.
 *
 * The platform's HTTP layer serialises every response body with
 * `JSON.stringify`, and it has no opinion about content types. A document full
 * of newlines and double-quoted attributes comes out of that with `\n` printed
 * between its blocks and `class=\'…` where its classes used to be — a page that
 * renders as unstyled rubble. A document that contains no character JSON has to
 * escape survives the trip byte for byte inside its wrapping quotes, so the
 * same bytes are a valid page whether they are read in process — where they are
 * the document exactly — or fetched over the wire.
 *
 * The two rules that keeps: single-quoted attributes, and no literal double
 * quote or backslash reaches the output. Both are enforced here rather than
 * trusted to every author of a section below.
 */
const oneLine = (html: string): string =>
  html.replace(/\s*\n\s*/g, ' ').replace(/["\\]/g, (c) => (c === '"' ? '&quot;' : '&#92;'));

/** The issuer as the workspace has recorded it, falling back to the org row. */
export function issuerOf(ctx: Ctx, orgId: string): Issuer {
  let name = 'Invoice';
  let email: string | null = null;
  try {
    const org = ctx.svc.core.org(orgId);
    name = org.name;
    email = org.domain ? `billing@${org.domain}` : null;
  } catch { /* the org is gone; the document still has to render */ }
  const stored = ctx.svc.core.setting<Partial<Issuer> | null>(orgId, 'billing.issuer', null);
  return {
    legal_name: stored?.legal_name ?? name,
    line1: stored?.line1 ?? null,
    line2: stored?.line2 ?? null,
    city: stored?.city ?? null,
    state: stored?.state ?? null,
    postal_code: stored?.postal_code ?? null,
    country: stored?.country ?? null,
    tax_id: stored?.tax_id ?? null,
    email: stored?.email ?? email,
    phone: stored?.phone ?? null,
    remittance: stored?.remittance ?? null,
  };
}

/* --------------------------------- pieces --------------------------------- */

const STATUS_LABEL: Record<Invoice['status'], string> = {
  draft: 'Draft — not yet sent',
  open: 'Due',
  paid: 'Paid',
  uncollectible: 'Written off',
  void: 'Void',
};

const REASON_LABEL: Record<Invoice['billing_reason'], string> = {
  subscription_create: 'First invoice for a new subscription',
  subscription_cycle: 'Scheduled renewal',
  subscription_update: 'Mid-cycle change',
  manual: 'Raised on request',
};

const KIND_LABEL: Record<InvoiceLine['kind'], string> = {
  recurring: 'Subscription',
  unused_time: 'Credit for unused time',
  remaining_time: 'Charge for the rest of the period',
  immediate: 'One-off charge',
  usage: 'Metered usage',
  credit_covered: 'Covered by prepaid credit',
  topup: 'Prepaid credit purchase',
  true_up: 'Usage true-up',
};

/** 'Grand Rapids, Michigan 49504' — how a postal address is actually written. */
const cityLine = (city: string | null, state: string | null, postalCode: string | null): string =>
  [[city, state].map((p) => (p ?? '').trim()).filter(Boolean).join(', '), (postalCode ?? '').trim()]
    .filter(Boolean).join(' ');

const addressLines = (a: Customer['address']): string[] =>
  !a ? [] : [a.line1, a.line2, cityLine(a.city, a.state, a.postal_code), a.country]
    .map((part) => (part ?? '').trim())
    .filter(Boolean);

const issuerLines = (issuer: Issuer): string[] =>
  [issuer.line1, issuer.line2, cityLine(issuer.city, issuer.state, issuer.postal_code), issuer.country]
    .map((part) => (part ?? '').trim())
    .filter(Boolean);

/* -------------------------------- the document ---------------------------- */

export function renderInvoice(ctx: Ctx, orgId: string, billing: Billing, invoice: Invoice): string {
  const customer = billing.customer(orgId, invoice.customer);
  const locale = billing.locale(orgId);
  const issuer = issuerOf(ctx, orgId);
  const notes = billing.creditNotes.list(orgId, { invoice: invoice.id, limit: 50 }).data;

  const show = (amount: number) => formatMoney(money(amount, invoice.currency), { locale });
  // UTC, because every period boundary in this module is a UTC instant. Printing
  // a bill in a local zone would show a period starting the day before the one
  // the line's own explanation names.
  const day = (ts: number) => longDate(ts, locale);
  const window = (period: { start: number; end: number }) => `${day(period.start)} — ${day(period.end)}`;

  const inclusive = invoice.total_taxes.some((row) => row.inclusive);
  const charged = invoice.total_taxes.filter((row) => row.amount !== 0);
  const zeroRated = invoice.total_taxes.filter((row) => row.amount === 0);

  return oneLine([
    '<!doctype html>',
    `<html lang='en'>`,
    '<head>',
    `<meta charset='utf-8'>`,
    `<meta name='viewport' content='width=device-width, initial-scale=1'>`,
    `<title>${esc(invoice.number)} · ${esc(issuer.legal_name)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<main class='sheet'>`,
    header(invoice, issuer, show, day),
    parties(customer, issuer),
    summaryStrip(invoice, show, day, window),
    lineTable(invoice, show, window, inclusive),
    taxSummary(charged, zeroRated, show),
    totals(invoice, show),
    creditNoteBlock(notes, show, day),
    payment(invoice, issuer, show, day),
    footer(invoice, issuer),
    '</main>',
    '</body>',
    '</html>',
  ].join('\n'));
}

/* --------------------------------- sections ------------------------------- */

function header(invoice: Invoice, issuer: Issuer, show: (n: number) => string, day: (ts: number) => string): string {
  const stamp = invoice.finalized_at ?? invoice.created;
  return `
<header class='masthead'>
  <div>
    <p class='issuer'>${esc(issuer.legal_name)}</p>
    <h1>Invoice ${esc(invoice.number)}</h1>
    <p class='muted'>${esc(REASON_LABEL[invoice.billing_reason])} · issued ${esc(day(stamp))}</p>
  </div>
  <div class='stamp'>
    <span class='pill pill-${invoice.status}'>${esc(STATUS_LABEL[invoice.status])}</span>
    <p class='headline'>${esc(show(invoice.amount_due))}</p>
    <p class='muted'>${invoice.amount_due === 0 ? 'Nothing outstanding' : invoice.due_date ? `Due ${esc(day(invoice.due_date))}` : 'Payable on receipt'}</p>
  </div>
</header>`;
}

function parties(customer: Customer | null, issuer: Issuer): string {
  const from = [
    `<p class='name'>${esc(issuer.legal_name)}</p>`,
    ...issuerLines(issuer).map((l) => `<p>${esc(l)}</p>`),
    issuer.tax_id ? `<p class='muted'>${esc(issuer.tax_id)}</p>` : '',
    issuer.email ? `<p class='muted'>${esc(issuer.email)}</p>` : '',
    issuer.phone ? `<p class='muted'>${esc(issuer.phone)}</p>` : '',
  ].filter(Boolean).join('');

  const to = customer
    ? [
      `<p class='name'>${esc(customer.name)}</p>`,
      ...addressLines(customer.address).map((l) => `<p>${esc(l)}</p>`),
      customer.email ? `<p class='muted'>${esc(customer.email)}</p>` : '',
      // A registration is only worth printing beside a zero if the document
      // also says whether it was checked — that is the difference between a
      // reverse charge a tax authority accepts and one it queries.
      ...customer.tax_ids.map((taxId) => `<p class='muted'>${esc(taxId.type.replace(/_/g, ' ').toUpperCase())} ${esc(taxId.value)}${
        taxId.verification.status === 'verified' ? ' (verified)' : ` (${esc(taxId.verification.status)})`
      }</p>`),
      customer.tax_exempt === 'exempt' ? `<p class='muted'>Registered as tax exempt</p>` : '',
      customer.tax_exempt === 'reverse' ? `<p class='muted'>Reverse charge — customer accounts for the tax</p>` : '',
      ...customer.invoice_settings.custom_fields.map(
        (field) => `<p class='muted'>${esc(field.name)}: ${esc(field.value)}</p>`,
      ),
    ].filter(Boolean).join('')
    : `<p class='muted'>This account has been deleted.</p>`;

  return `
<section class='parties'>
  <div><h2>From</h2>${from}</div>
  <div><h2>Bill to</h2>${to}</div>
</section>`;
}

function summaryStrip(
  invoice: Invoice, show: (n: number) => string, day: (ts: number) => string,
  window: (p: { start: number; end: number }) => string,
): string {
  const facts: [string, string][] = [
    ['Invoice number', invoice.number],
    ['Service period', window(invoice.period)],
    ...(invoice.arrears_period ? [['Usage settled for', window(invoice.arrears_period)] as [string, string]] : []),
    ['Currency', invoice.currency.toUpperCase()],
    ['Collection', invoice.collection_method === 'charge_automatically' ? 'Charged automatically' : 'Invoiced — payable by transfer'],
    ...(invoice.due_date ? [['Due date', day(invoice.due_date)] as [string, string]] : []),
    ...(invoice.paid_at ? [['Paid', day(invoice.paid_at)] as [string, string]] : []),
    ...(invoice.voided_at ? [['Voided', day(invoice.voided_at)] as [string, string]] : []),
    ['Total', show(invoice.total)],
  ];
  return `
<section class='facts'>
  ${facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}
</section>`;
}

function lineTable(
  invoice: Invoice, show: (n: number) => string,
  window: (p: { start: number; end: number }) => string, inclusive: boolean,
): string {
  const rows = invoice.lines.map((line) => {
    const fraction = line.proration_fraction && line.proration_fraction.numerator !== line.proration_fraction.denominator
      ? `<span class='tag'>${line.proration_fraction.numerator} / ${line.proration_fraction.denominator} of the period</span>`
      : '';
    const breakdown = line.breakdown.length > 1 || (line.breakdown.length === 1 && line.breakdown[0].kind !== 'flat')
      ? `<table class='tiers'>
           <tbody>
             ${line.breakdown.map((row) => `
             <tr>
               <td>${esc(row.label)}${row.tier !== null && !/tier/i.test(row.label) ? ` <span class='muted'>(tier ${row.tier}${row.up_to === 'inf' ? ' and above' : row.up_to !== null ? `, up to ${row.up_to.toLocaleString('en-US')}` : ''})</span>` : ''}</td>
               <td class='num'>${row.quantity.toLocaleString('en-US')}</td>
               <td class='num'>${row.unit_amount_decimal ? `${esc(row.unit_amount_decimal)}¢ each` : '—'}</td>
               <td class='num'>${esc(show(row.amount))}</td>
             </tr>`).join('')}
           </tbody>
         </table>`
      : '';
    // Every jurisdiction that taxed the line, named. One rate reads exactly as
    // it always did; three read as the three a US customer expects to see.
    const jurisdictions = line.taxes.filter((entry): entry is typeof entry & { percentage: string } => !!entry.percentage);
    const taxCell = jurisdictions.length
      ? `${esc(show(line.tax.amount))}<br>${jurisdictions.map((entry) =>
        `<span class='muted'>${esc(entry.display_name ?? 'Tax')} ${esc(formatPercentage(entry.percentage))}%${entry.reason && entry.reason !== 'taxable' ? ` · ${esc(entry.reason.replace(/_/g, ' '))}` : ''}</span>`).join('<br>')}`
      : `<span class='muted'>—</span>`;
    return `
    <tr>
      <td>
        <p class='line-title'>${esc(line.description)}</p>
        <p class='muted'>${esc(KIND_LABEL[line.kind])} · ${esc(window(line.period))} ${fraction}</p>
        <p class='explain'>${esc(line.explanation)}</p>
        ${line.tax.explanation ? `<p class='explain'>${esc(line.tax.explanation)}</p>` : ''}
        ${breakdown}
      </td>
      <td class='num'>${line.quantity.toLocaleString('en-US')}</td>
      <td class='num'>${esc(show(line.amount))}</td>
      <td class='num'>${taxCell}</td>
      <td class='num strong'>${esc(show(line.amount + line.tax.amount))}</td>
    </tr>`;
  }).join('');

  return `
<section>
  <h2>What this covers</h2>
  <table class='lines'>
    <thead>
      <tr>
        <th>Description</th>
        <th class='num'>Qty</th>
        <th class='num'>${inclusive ? 'Net' : 'Amount'}</th>
        <th class='num'>Tax</th>
        <th class='num'>Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function taxSummary(
  charged: Invoice['total_taxes'], zeroRated: Invoice['total_taxes'], show: (n: number) => string,
): string {
  if (!charged.length && !zeroRated.length) {
    return `
<section>
  <h2>Tax</h2>
  <p class='muted'>No tax rate is registered for this address, so nothing has been charged.</p>
</section>`;
  }
  const row = (entry: Invoice['total_taxes'][number]) => `
    <tr>
      <td>${esc(entry.display_name)} ${esc(formatPercentage(entry.percentage))}%${entry.inclusive ? ` <span class='tag'>included in the prices shown</span>` : ''}</td>
      <td>${esc(entry.jurisdiction)}</td>
      <td class='num'>${esc(show(entry.taxable_amount))}</td>
      <td class='num strong'>${esc(show(entry.amount))}</td>
    </tr>
    <tr class='note'><td colspan='4'>${esc(entry.explanation)}</td></tr>`;
  // Where several jurisdictions taxed the same supply, the bill also states
  // what they come to together. "8.875%" is the number a New York customer
  // checks the total against; the rows above are what it is made of.
  //
  // A row is not a jurisdiction. The summary keys on how a rate was charged as
  // well as on the rate, so one 19% VAT reaches this table twice the moment a
  // bill carries an inclusive price beside an exclusive one — and adding those
  // two rows up prints "Combined 38%", a rate no authority has ever charged, on
  // a document the customer checks against their own return. So the combined
  // line is built from the *distinct* rates, and only appears when there is
  // more than one of them.
  const identityOf = (entry: Invoice['total_taxes'][number]): string =>
    entry.tax_rate ?? `${entry.display_name}@${entry.percentage}@${entry.jurisdiction}`;
  const distinct = new Map<string, Invoice['total_taxes'][number]>();
  for (const entry of charged) if (!distinct.has(identityOf(entry))) distinct.set(identityOf(entry), entry);
  const rates = [...distinct.values()];
  const combined = rates.length > 1
    ? `
    <tr>
      <td class='strong'>Combined ${esc(combinePercentages(rates.map((entry) => entry.percentage)))}%</td>
      <td>${esc([...new Set(rates.map((entry) => entry.jurisdiction))].join(', '))}</td>
      <td class='num'></td>
      <td class='num strong'>${esc(show(charged.reduce((total, entry) => total + entry.amount, 0)))}</td>
    </tr>`
    : '';
  return `
<section>
  <h2>Tax summary</h2>
  <table class='lines'>
    <thead>
      <tr><th>Rate</th><th>Jurisdiction</th><th class='num'>Taxable amount</th><th class='num'>Tax</th></tr>
    </thead>
    <tbody>${[...charged, ...zeroRated].map(row).join('')}${combined}</tbody>
  </table>
</section>`;
}

/**
 * The two kinds of credit note land in different places, and the document has
 * to say which happened. One raised before the money came in reduces what is
 * owed and belongs in the running total; one raised afterwards has nothing left
 * to reduce, so it goes onto the account balance and is stated after the total
 * rather than subtracted from it.
 */
function totals(invoice: Invoice, show: (n: number) => string): string {
  const rows: [string, string, boolean][] = [
    ['Subtotal, excluding tax', show(invoice.subtotal), false],
    ['Tax', show(invoice.tax), false],
    ['Total', show(invoice.total), true],
  ];
  if (invoice.balance_applied !== 0) {
    // A bill whose lines are worth less than nothing — a mid-cycle downgrade,
    // a cancellation — is money going the other way. It is not "carried
    // forward", and a document that said so about a credit would be wrong in
    // the one place a customer looks first.
    rows.splice(2, 0, [
      invoice.balance_applied < 0
        ? 'Account credit applied'
        : invoice.subtotal + invoice.tax < 0
          ? 'Placed on the account balance, where it comes off the next bill'
          : 'Balance carried forward onto this invoice',
      show(invoice.balance_applied),
      false,
    ]);
  }
  if (invoice.pre_payment_credit_notes_amount !== 0) {
    rows.push(['Credited before payment', `-${show(invoice.pre_payment_credit_notes_amount)}`, false]);
  }
  if (invoice.amount_paid !== 0) rows.push(['Paid', `-${show(invoice.amount_paid)}`, false]);
  rows.push(['Amount due', show(invoice.amount_due), true]);

  return `
<section class='totals'>
  <table>
    <tbody>
      ${rows.map(([label, value, strong]) => `
      <tr${strong ? ` class='strong'` : ''}><th>${esc(label)}</th><td class='num'>${esc(value)}</td></tr>`).join('')}
      ${invoice.post_payment_credit_notes_amount !== 0 ? `
      <tr class='note'><td colspan='2'>${esc(show(invoice.post_payment_credit_notes_amount))} was credited after this invoice was paid and placed on the account balance, where it comes off the next one.</td></tr>` : ''}
    </tbody>
  </table>
</section>`;
}

function creditNoteBlock(notes: CreditNote[], show: (n: number) => string, day: (ts: number) => string): string {
  if (!notes.length) return '';
  return `
<section>
  <h2>Credit notes against this invoice</h2>
  <table class='lines'>
    <thead>
      <tr><th>Note</th><th>Reason</th><th>Issued</th><th class='num'>Amount</th></tr>
    </thead>
    <tbody>
      ${notes.map((note) => `
      <tr${note.status === 'void' ? ` class='voided'` : ''}>
        <td>${esc(note.number)}${note.memo ? `<p class='muted'>${esc(note.memo)}</p>` : ''}</td>
        <td>${esc(note.reason.replace(/_/g, ' '))}${note.status === 'void' ? ` <span class='tag'>withdrawn</span>` : ''}</td>
        <td>${esc(day(note.created))}</td>
        <td class='num'>${esc(show(note.total))}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</section>`;
}

function payment(invoice: Invoice, issuer: Issuer, show: (n: number) => string, day: (ts: number) => string): string {
  const how = invoice.status === 'paid'
    ? `<p>Settled in full${invoice.paid_at ? ` on ${esc(day(invoice.paid_at))}` : ''}. ${esc(invoice.payment_note ?? 'Thank you.')}</p>`
    : invoice.status === 'void'
      ? '<p>This invoice has been withdrawn. Nothing is owed against it; anything it billed for will appear on a replacement.</p>'
      : invoice.status === 'uncollectible'
        ? '<p>This invoice has been written off. It is no longer being collected.</p>'
        : invoice.status === 'draft'
          ? '<p>This is a draft. It has not been sent and nothing is owed against it yet.</p>'
          : invoice.collection_method === 'charge_automatically'
            ? `<p>${esc(show(invoice.amount_due))} will be charged automatically to the payment method on file${invoice.due_date ? ` on ${esc(day(invoice.due_date))}` : ''}. No action is needed.</p>`
            : `<p>Please pay ${esc(show(invoice.amount_due))}${invoice.due_date ? ` by ${esc(day(invoice.due_date))}` : ' on receipt'}.</p>`;
  return `
<section class='payment'>
  <h2>Payment</h2>
  ${how}
  ${issuer.remittance ? `<p>${esc(issuer.remittance)}</p>` : ''}
  ${issuer.email ? `<p class='muted'>Billing queries: ${esc(issuer.email)}${issuer.phone ? ` · ${esc(issuer.phone)}` : ''}</p>` : ''}
</section>`;
}

function footer(invoice: Invoice, issuer: Issuer): string {
  return `
<footer>
  ${invoice.footer ? `<p>${esc(invoice.footer)}</p>` : ''}
  ${invoice.description ? `<p class='muted'>${esc(invoice.description)}</p>` : ''}
  <p class='muted'>${esc(issuer.legal_name)} · invoice ${esc(invoice.number)} · ${esc(invoice.currency.toUpperCase())}${invoice.livemode ? '' : ' · test mode'}</p>
</footer>`;
}

/* ---------------------------------- style --------------------------------- */

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; background: #eef0f4; color: #16181d;
  font: 13px/1.55 ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.sheet { max-width: 860px; margin: 32px auto; padding: 44px 48px 36px; background: #fff; box-shadow: 0 1px 3px rgba(16,18,29,.14); }
h1 { font-size: 25px; margin: 2px 0 4px; letter-spacing: -.01em; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .09em; color: #6b7280; margin: 26px 0 8px; font-weight: 600; }
p { margin: 0 0 2px; }
.muted { color: #6b7280; }
.explain { color: #4b5563; margin-top: 3px; max-width: 62ch; }
.name { font-weight: 600; }
.strong, .strong td, .strong th { font-weight: 700; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }

.masthead { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; border-bottom: 2px solid #16181d; padding-bottom: 16px; }
.issuer { font-weight: 700; letter-spacing: .02em; text-transform: uppercase; font-size: 11px; color: #4338ca; }
.stamp { text-align: right; }
.headline { font-size: 25px; font-weight: 700; letter-spacing: -.01em; margin: 6px 0 2px; }
.pill { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; border: 1px solid currentColor; }
.pill-paid { color: #15803d; }
.pill-open { color: #b45309; }
.pill-draft { color: #6b7280; }
.pill-void { color: #6b7280; text-decoration: line-through; }
.pill-uncollectible { color: #b91c1c; }

.parties { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 22px; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px 20px; margin: 22px 0 4px; padding: 14px 16px; background: #f6f7f9; border: 1px solid #e3e6eb; }
.facts dt { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: #6b7280; }
.facts dd { margin: 2px 0 0; font-weight: 600; }

table { width: 100%; border-collapse: collapse; }
.lines th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: #6b7280; border-bottom: 1px solid #16181d; padding: 6px 8px; }
.lines td { border-bottom: 1px solid #e3e6eb; padding: 10px 8px; vertical-align: top; }
.lines tr.note td { border-bottom: 1px solid #e3e6eb; padding-top: 0; color: #6b7280; font-size: 12px; }
.lines tr.voided td { color: #9ca3af; text-decoration: line-through; }
.line-title { font-weight: 600; }
.tag { display: inline-block; padding: 1px 6px; border: 1px solid #c8cdd6; border-radius: 3px; font-size: 11px; color: #4b5563; }
.tiers { margin-top: 8px; border: 1px solid #e3e6eb; background: #fafbfc; }
.tiers td { border: 0; border-bottom: 1px solid #eef0f4; padding: 4px 8px; font-size: 12px; }
.tiers tr:last-child td { border-bottom: 0; }

.totals { display: flex; justify-content: flex-end; margin-top: 18px; }
.totals table { width: 340px; }
.totals th { text-align: left; font-weight: 400; color: #4b5563; padding: 5px 8px; }
.totals td { padding: 5px 8px; }
.totals tr.strong th, .totals tr.strong td { border-top: 1px solid #16181d; color: #16181d; }
.totals tr.note td { padding: 8px; color: #6b7280; font-size: 12px; }

.payment p { margin-bottom: 5px; max-width: 72ch; }
footer { margin-top: 30px; padding-top: 14px; border-top: 1px solid #e3e6eb; }

@media print {
  body { background: #fff; }
  .sheet { margin: 0; box-shadow: none; padding: 0; max-width: none; }
  section, tr { break-inside: avoid; }
}
@media (max-width: 640px) {
  .sheet { padding: 24px 18px; margin: 0; }
  .masthead, .parties { grid-template-columns: 1fr; flex-direction: column; }
  .totals table { width: 100%; }
}
`;
