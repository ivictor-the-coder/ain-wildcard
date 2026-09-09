/**
 * The words that actually leave the building.
 *
 * Every notice here is built from the record it is about — the bill's own
 * lines, the campaign's own next attempt — and never from a template variable
 * that could be stale by the time anyone reads it. The composed body is stored
 * on the message row as sent, so the hosted page and the support agent read the
 * same bytes the customer did.
 *
 * The HTML follows the invoice document's rules: one line, single-quoted
 * attributes, no literal double quote or backslash. The platform's HTTP layer
 * serialises every body with `JSON.stringify`, so a document containing a
 * character JSON must escape comes back over the wire with `\n` and `\'`
 * printed into it.
 */
import { formatMoney, money } from '../../../shared/money';
import { formatDate } from '../../../shared/time';
import type { Ctx } from '../../kernel/context';

export interface Issuer {
  legal_name: string;
  email: string | null;
  address: string | null;
}

export interface Composed {
  subject: string;
  text: string;
  html: string;
}

export interface OrgVoice {
  name: string;
  locale: string;
  timeZone: string;
  issuer: Issuer;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const oneLine = (html: string): string =>
  html.replace(/\s*\n\s*/g, ' ').replace(/["\\]/g, (c) => (c === '"' ? '&quot;' : '&#92;'));

/** The workspace as the recipient sees it: its name, its formats, its address. */
export function orgVoice(ctx: Ctx, orgId: string): OrgVoice {
  let name = 'Ain';
  let locale = 'en-US';
  let timeZone = 'UTC';
  let email: string | null = null;
  try {
    const org = ctx.svc.core.org(orgId);
    name = org.name;
    locale = org.locale || 'en-US';
    timeZone = org.timezone || 'UTC';
    email = org.domain ? `billing@${org.domain}` : null;
  } catch { /* the workspace is gone; the notice still has to say who sent it */ }
  // The same setting the printed invoice reads, so the letterhead on the email
  // and the letterhead on the document can never disagree.
  const stored = ctx.svc.core.setting<Record<string, string | null> | null>(orgId, 'billing.issuer', null);
  const address = [stored?.line1, stored?.line2, [stored?.city, stored?.state, stored?.postal_code].filter(Boolean).join(' '), stored?.country]
    .map((part) => (part ?? '').trim()).filter(Boolean).join(', ');
  return {
    name,
    locale,
    timeZone,
    issuer: {
      legal_name: (stored?.legal_name as string | undefined) ?? name,
      email: (stored?.email as string | undefined) ?? email,
      address: address || null,
    },
  };
}

/* -------------------------------- the shell ------------------------------- */

export interface Block {
  /** A heading and its rows, or a plain paragraph. */
  heading?: string;
  paragraphs?: string[];
  rows?: { label: string; value: string; strong?: boolean }[];
  lines?: { description: string; detail: string | null; amount: string }[];
}

export interface Letter {
  preheader: string;
  title: string;
  blocks: Block[];
  action?: { label: string; url: string } | null;
  footer: string[];
}

/**
 * One layout for every notice, so a receipt and a dunning notice are visibly
 * the same company writing. Inline styles only: an email client fetches no
 * stylesheet, and neither does the hosted copy of it.
 */
export function renderLetter(voice: OrgVoice, letter: Letter): string {
  const wrap = (inner: string) => oneLine(`<!doctype html>
<html lang='en'>
<head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>${esc(letter.title)}</title></head>
<body style='margin:0;padding:24px;background:#f4f5f7;font:15px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1d21'>
<span style='display:none;max-height:0;overflow:hidden;opacity:0'>${esc(letter.preheader)}</span>
<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='max-width:620px;margin:0 auto'>
<tr><td style='padding:0 0 16px 0;font-weight:600;letter-spacing:.01em'>${esc(voice.issuer.legal_name)}</td></tr>
<tr><td style='background:#ffffff;border:1px solid #e3e6ea;border-radius:10px;padding:28px'>${inner}</td></tr>
<tr><td style='padding:16px 4px;color:#6b7280;font-size:12px'>${letter.footer.map((f) => esc(f)).join('<br>')}</td></tr>
</table>
</body></html>`);

  const blocks = letter.blocks.map((block) => {
    const parts: string[] = [];
    if (block.heading) parts.push(`<div style='font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin:22px 0 8px'>${esc(block.heading)}</div>`);
    for (const p of block.paragraphs ?? []) parts.push(`<p style='margin:0 0 12px'>${esc(p)}</p>`);
    if (block.rows?.length) {
      parts.push(`<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='font-size:14px'>${block.rows.map((row) => `<tr><td style='padding:5px 0;color:#4b5563'>${esc(row.label)}</td><td style='padding:5px 0;text-align:right${row.strong ? ';font-weight:600' : ''}'>${esc(row.value)}</td></tr>`).join('')}</table>`);
    }
    if (block.lines?.length) {
      parts.push(`<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='font-size:14px;border-top:1px solid #e3e6ea'>${block.lines.map((line) => `<tr><td style='padding:10px 0;border-bottom:1px solid #f0f2f4'>${esc(line.description)}${line.detail ? `<div style='color:#6b7280;font-size:12px;margin-top:2px'>${esc(line.detail)}</div>` : ''}</td><td style='padding:10px 0;border-bottom:1px solid #f0f2f4;text-align:right;white-space:nowrap;vertical-align:top'>${esc(line.amount)}</td></tr>`).join('')}</table>`);
    }
    return parts.join('');
  }).join('');

  const action = letter.action
    ? `<p style='margin:26px 0 6px'><a href='${esc(letter.action.url)}' style='display:inline-block;background:#5B4BE1;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600'>${esc(letter.action.label)}</a></p>`
    : '';

  return wrap(`<h1 style='margin:0 0 14px;font-size:19px;line-height:1.35'>${esc(letter.title)}</h1>${blocks}${action}`);
}

/** The plain-text half. Not a stripped copy of the HTML — the same facts, flat. */
export function renderText(voice: OrgVoice, letter: Letter): string {
  const out: string[] = [letter.title, ''];
  for (const block of letter.blocks) {
    if (block.heading) out.push(block.heading.toUpperCase(), '');
    for (const p of block.paragraphs ?? []) out.push(p, '');
    for (const row of block.rows ?? []) out.push(`  ${row.label}: ${row.value}`);
    for (const line of block.lines ?? []) {
      out.push(`  ${line.description} — ${line.amount}`);
      if (line.detail) out.push(`    ${line.detail}`);
    }
    if (block.rows?.length || block.lines?.length) out.push('');
  }
  if (letter.action) out.push(`${letter.action.label}: ${letter.action.url}`, '');
  out.push(...letter.footer);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------ the notices ------------------------------- */

/** Just enough of an invoice to write about one, without importing billing. */
export interface InvoiceFacts {
  number: string;
  currency: string;
  total: number;
  amount_due: number;
  amount_paid: number;
  due_date: number | null;
  finalized_at: number | null;
  period: { start: number; end: number };
  lines: { description: string; explanation: string; amount: number }[];
  payment_note: string | null;
  footer: string | null;
}

export interface Recipient {
  name: string;
  email: string | null;
}

const show = (amount: number, currency: string, locale: string): string =>
  formatMoney(money(amount, currency), { locale });

const day = (ts: number, voice: OrgVoice): string =>
  formatDate(ts, { locale: voice.locale, timeZone: voice.timeZone, withYear: true });

export function invoiceIssued(voice: OrgVoice, invoice: InvoiceFacts, to: Recipient, hostedUrl: string | null): Composed {
  const amount = show(invoice.amount_due, invoice.currency, voice.locale);
  const due = invoice.due_date
    ? `due ${day(invoice.due_date, voice)}`
    : 'due on receipt';
  const letter: Letter = {
    preheader: `${amount} ${due} — invoice ${invoice.number}.`,
    title: `Invoice ${invoice.number} from ${voice.issuer.legal_name}`,
    blocks: [
      {
        paragraphs: [
          `${to.name}, here is your invoice for ${day(invoice.period.start, voice)} to ${day(invoice.period.end, voice)}.`,
        ],
        rows: [
          { label: 'Invoice', value: invoice.number },
          { label: 'Issued', value: day(invoice.finalized_at ?? invoice.period.start, voice) },
          { label: invoice.due_date ? 'Due' : 'Terms', value: invoice.due_date ? day(invoice.due_date, voice) : 'On receipt' },
          { label: 'Amount due', value: amount, strong: true },
        ],
      },
      {
        heading: 'What this covers',
        lines: invoice.lines.map((line) => ({
          description: line.description,
          detail: line.explanation || null,
          amount: show(line.amount, invoice.currency, voice.locale),
        })),
      },
      {
        rows: [
          ...(invoice.amount_paid ? [{ label: 'Already paid', value: show(invoice.amount_paid, invoice.currency, voice.locale) }] : []),
          { label: 'Total', value: show(invoice.total, invoice.currency, voice.locale) },
          { label: 'Amount due', value: amount, strong: true },
        ],
      },
      ...(invoice.payment_note ? [{ heading: 'How to pay', paragraphs: [invoice.payment_note] }] : []),
    ],
    action: hostedUrl ? { label: 'View invoice', url: hostedUrl } : null,
    footer: footerOf(voice, invoice.footer),
  };
  return {
    subject: `Invoice ${invoice.number} from ${voice.issuer.legal_name} — ${amount} ${due}`,
    text: renderText(voice, letter),
    html: renderLetter(voice, letter),
  };
}

export function invoiceReceipt(voice: OrgVoice, invoice: InvoiceFacts, to: Recipient, paidAt: number, hostedUrl: string | null): Composed {
  const paid = show(invoice.amount_paid, invoice.currency, voice.locale);
  const letter: Letter = {
    preheader: `${paid} received for invoice ${invoice.number}. Thank you.`,
    title: `Payment received — invoice ${invoice.number}`,
    blocks: [
      {
        paragraphs: [`Thank you, ${to.name}. ${paid} was received for invoice ${invoice.number} on ${day(paidAt, voice)}. Nothing further is owed on it.`],
        rows: [
          { label: 'Invoice', value: invoice.number },
          { label: 'Paid', value: day(paidAt, voice) },
          { label: 'Amount', value: paid, strong: true },
        ],
      },
    ],
    action: hostedUrl ? { label: 'View receipt', url: hostedUrl } : null,
    footer: footerOf(voice, null),
  };
  return {
    subject: `Receipt for invoice ${invoice.number} — ${paid}`,
    text: renderText(voice, letter),
    html: renderLetter(voice, letter),
  };
}

export interface DunningFacts {
  invoice_number: string;
  currency: string;
  amount_at_risk: number;
  attempt: number;
  max_attempts: number;
  next_attempt_at: number | null;
  failure_message: string | null;
  card_hint: string | null;
}

export function dunningFailed(voice: OrgVoice, facts: DunningFacts, to: Recipient, hostedUrl: string | null): Composed {
  const amount = show(facts.amount_at_risk, facts.currency, voice.locale);
  // What happens next is the whole point of the message. A notice that says a
  // payment failed and not what the payer must do turns into a support ticket.
  const next = facts.next_attempt_at
    ? `We will try the same card again on ${day(facts.next_attempt_at, voice)}. If you would rather not wait, update the card and we will take it straight away.`
    : `This was attempt ${facts.attempt} of ${facts.max_attempts} and there is no further attempt scheduled, so the card has to be updated for the payment to go through.`;
  const letter: Letter = {
    preheader: `${amount} on invoice ${facts.invoice_number} could not be collected.`,
    title: `We couldn’t take payment for invoice ${facts.invoice_number}`,
    blocks: [
      {
        paragraphs: [
          `${to.name}, the card on file was declined for ${amount} against invoice ${facts.invoice_number}.`,
          ...(facts.failure_message ? [`The bank said: ${facts.failure_message}`] : []),
          next,
        ],
        rows: [
          { label: 'Invoice', value: facts.invoice_number },
          { label: 'Amount', value: amount, strong: true },
          { label: 'Attempt', value: `${facts.attempt} of ${facts.max_attempts}` },
          ...(facts.card_hint ? [{ label: 'Card', value: facts.card_hint }] : []),
          ...(facts.next_attempt_at ? [{ label: 'Next attempt', value: day(facts.next_attempt_at, voice) }] : []),
        ],
      },
    ],
    action: hostedUrl ? { label: 'View invoice', url: hostedUrl } : null,
    footer: footerOf(voice, null),
  };
  return {
    subject: `Payment failed for invoice ${facts.invoice_number} — ${amount}`,
    text: renderText(voice, letter),
    html: renderLetter(voice, letter),
  };
}

export function dunningFinal(voice: OrgVoice, facts: DunningFacts, to: Recipient, resolution: string | null, hostedUrl: string | null): Composed {
  const amount = show(facts.amount_at_risk, facts.currency, voice.locale);
  const letter: Letter = {
    preheader: `Invoice ${facts.invoice_number} is still unpaid after ${facts.attempt} attempts.`,
    title: `Invoice ${facts.invoice_number} is still unpaid`,
    blocks: [
      {
        paragraphs: [
          `${to.name}, we tried the card on file ${facts.attempt} times for ${amount} against invoice ${facts.invoice_number} and it was declined each time. We have stopped retrying.`,
          ...(resolution ? [resolution] : []),
          'Updating the payment method on the account is enough to settle it — nothing else is needed from you.',
        ],
        rows: [
          { label: 'Invoice', value: facts.invoice_number },
          { label: 'Outstanding', value: amount, strong: true },
          { label: 'Attempts made', value: String(facts.attempt) },
        ],
      },
    ],
    action: hostedUrl ? { label: 'View invoice', url: hostedUrl } : null,
    footer: footerOf(voice, null),
  };
  return {
    subject: `Invoice ${facts.invoice_number} is still unpaid — ${amount}`,
    text: renderText(voice, letter),
    html: renderLetter(voice, letter),
  };
}

function footerOf(voice: OrgVoice, invoiceFooter: string | null): string[] {
  return [
    ...(invoiceFooter ? [invoiceFooter] : []),
    [voice.issuer.legal_name, voice.issuer.address].filter(Boolean).join(' · '),
    ...(voice.issuer.email ? [`Questions? Reply to this message or write to ${voice.issuer.email}.`] : []),
  ];
}
