/**
 * A chase, checked against the ledger it is a claim about.
 *
 * `POST /v1/ai/draft` reads the outstanding invoices of the record it is given
 * — and it can only read them for a *billing* account. Handed a deal id, which
 * is the only kind of id this dialog has ever sent, it finds no customer, finds
 * no invoices, and composes the honest sentence for that state: "the billing
 * ledger shows no invoice with an amount still due on that account — every
 * issued invoice is paid, void or draft."
 *
 * Brightline Foods owes $127,840 on invoice NR-000032, due 56 days ago. Every
 * dunning draft this dialog produced said the opposite, over a real signature,
 * to the customer who owes it.
 *
 * Two things follow, and both live here so they can be tested without a
 * browser. The chase is drafted on the account, because that is the record the
 * ledger hangs off. And the draft is read back against the same ledger this
 * client can see: a chase that names no invoice the ledger holds, that declares
 * an account square while money is due on it, or that puts a figure to the
 * customer which no open invoice carries, is refused rather than shown for
 * logging.
 *
 * "The draft" means the text at the moment it is logged, edits included. The
 * dialog hands the reader an editable body under a banner that says the figures
 * were checked, and a check that only ever ran on the engine's first draft made
 * that banner a lie the instant anybody typed in the box.
 */

import { formatMoney, parseMoney } from '../../../shared/money';

/** One bill still owed, as `GET /v1/invoices` returns it. */
export interface OutstandingBill {
  number: string;
  amountDue: number;
  currency: string;
  dueAt: number | null;
  daysOverdue: number | null;
}

/** What this client can see of the account's ledger, and whether it saw it. */
export interface LedgerRead {
  /** `unread` covers both a failed request and an account with no billing customer. */
  state: 'read' | 'unread';
  bills: OutstandingBill[];
  /** The books the outstanding bills are in — more than one has no single total. */
  currencies: string[];
  /** Why it could not be read, when it could not. */
  why?: string;
}

export const EMPTY_LEDGER: LedgerRead = { state: 'unread', bills: [], currencies: [] };

interface InvoiceRow {
  number?: string | null;
  amount_due?: number | null;
  currency?: string | null;
  due_date?: number | null;
  status?: string | null;
}

/** The bills with money still on them, newest debt last, as the draft cites them. */
export function ledgerFrom(rows: InvoiceRow[], now: number): LedgerRead {
  const bills = rows
    .filter((row) => typeof row.amount_due === 'number' && row.amount_due > 0)
    .map<OutstandingBill>((row) => ({
      number: row.number ?? '',
      amountDue: row.amount_due ?? 0,
      currency: (row.currency ?? 'usd').toLowerCase(),
      dueAt: typeof row.due_date === 'number' ? row.due_date : null,
      daysOverdue: typeof row.due_date === 'number' && row.due_date < now
        ? Math.floor((now - row.due_date) / 86_400_000)
        : null,
    }))
    .sort((a, b) => (b.daysOverdue ?? -1) - (a.daysOverdue ?? -1));
  return { state: 'read', bills, currencies: [...new Set(bills.map((bill) => bill.currency))] };
}

/** The total owed, when every bill is in one book. A mixed ledger has no total. */
export const ledgerTotal = (ledger: LedgerRead): number | null =>
  (ledger.currencies.length === 1 ? ledger.bills.reduce((sum, bill) => sum + bill.amountDue, 0) : null);

/**
 * The sentence the engine writes when it found no unpaid invoice.
 *
 * It is the right sentence for an account that owes nothing and a false one for
 * an account whose ledger the engine could not reach, and only the caller — who
 * has read the ledger itself — can tell those two apart.
 */
const DECLARES_SQUARE = /(no unpaid invoice|no invoice with an amount still due|nothing to chase|every issued invoice is paid)/i;

export type DunningVerdict =
  | { state: 'ok' }
  | { state: 'unresolved'; why: string }
  | { state: 'contradicted'; why: string };

/** A money figure exactly as a draft writes it, and what it is worth. */
export interface DraftFigure {
  /** Verbatim, so the reader is shown the words they typed — "$127,480.00". */
  text: string;
  /** Integer minor units. */
  minor: number;
  currency: string;
}

/** The books a bare glyph can only mean one of. */
const SYMBOL_BOOK: Record<string, string> = { $: 'usd', '€': 'eur', '£': 'gbp', '¥': 'jpy' };

const GLYPH_FIGURE = /([$€£¥])\s?(\d[\d,]*(?:\.\d+)?)/g;
const CODED_FIGURE = /(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z]{3})(?![A-Za-z])/g;

/**
 * Every money figure in a piece of writing, in minor units.
 *
 * A glyph names its book on its own. A trailing code is only read as one when
 * the ledger itself is kept in that book — otherwise "3,100 employees" and
 * "56 days" become currency, and a guard that reads noise as money is a guard
 * nobody can leave switched on.
 */
export function figuresIn(text: string, currencies: readonly string[]): DraftFigure[] {
  const out: DraftFigure[] = [];
  const push = (raw: string, digits: string, currency: string) => {
    try {
      out.push({ text: raw, minor: parseMoney(digits, currency).amount, currency });
    } catch { /* not a number this product can hold */ }
  };
  for (const match of text.matchAll(GLYPH_FIGURE)) {
    push(match[0], match[2], SYMBOL_BOOK[match[1]] ?? 'usd');
  }
  const books = new Set(currencies.map((code) => code.toLowerCase()));
  for (const match of text.matchAll(CODED_FIGURE)) {
    const code = match[2].toLowerCase();
    if (books.has(code)) push(match[0], match[1], code);
  }
  return out;
}

/**
 * Every invoice number in a piece of writing, in this workspace's own format.
 *
 * The shape is taken from the ledger rather than typed here: Northwind's
 * invoices read `NR-000032`, so the prefix is whatever sits before the digits
 * on the bills this account actually holds. A workspace numbering its invoices
 * some other way gets its own pattern for free, and one numbering them with
 * bare digits gets none — which is the honest outcome, because a bare number in
 * a letter is as likely to be a date as a bill.
 */
export function invoiceNumbersIn(text: string, bills: readonly OutstandingBill[]): string[] {
  const prefixes = new Set(
    bills.map((bill) => /^([^0-9]{2,})/.exec(bill.number)?.[1] ?? '').filter(Boolean),
  );
  const out: string[] = [];
  for (const prefix of prefixes) {
    const pattern = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+`, 'g');
    for (const match of text.matchAll(pattern)) if (!out.includes(match[0])) out.push(match[0]);
  }
  return out;
}

/**
 * The figures this account's ledger will stand behind.
 *
 * Each open invoice's own balance, and — where every bill is in one book — the
 * total, because "you owe us $5,060.00 across two invoices" is a true sentence
 * a person is entitled to write.
 */
const figuresHeld = (ledger: LedgerRead): Set<string> => {
  const held = new Set(ledger.bills.map((bill) => `${bill.currency}:${bill.amountDue}`));
  const total = ledgerTotal(ledger);
  if (total !== null) held.add(`${ledger.currencies[0]}:${total}`);
  return held;
};

/**
 * Whether a chase may be shown to a person to send.
 *
 * A dunning letter is a claim about money made to a customer, so the bar is not
 * "probably right": either this client has read the ledger and the draft agrees
 * with it, or there is no letter.
 *
 * Every rule here runs on the text as it stands *now*, not on the text the
 * engine composed. The dialog prints "the draft is checked against these
 * figures before it can be logged" over an editable body, and that sentence was
 * true of the engine's draft and false of every edit made to it: the invoice
 * number could be changed to one the ledger does not hold, the $127,840.00
 * could be retyped as $127,480.00, and the letter went onto the timeline under
 * a banner promising it had been checked. A guarantee about money either holds
 * for the text that is logged or it is not a guarantee.
 */
export function checkDunning(
  draft: { subject: string; body: string },
  ledger: LedgerRead,
  money: (minor: number, currency: string) => string = (minor, currency) => formatMoney({ amount: minor, currency }),
): DunningVerdict {
  if (ledger.state === 'unread') {
    return { state: 'unresolved', why: ledger.why ?? 'This account’s billing ledger could not be read.' };
  }
  const text = `${draft.subject}\n${draft.body}`;
  const held = figuresHeld(ledger);
  const stray = figuresIn(text, ledger.currencies).find((figure) => !held.has(`${figure.currency}:${figure.minor}`));
  if (!ledger.bills.length) {
    // Nothing is owed, so the engine's "nothing to chase" is the truth. A draft
    // that chases anyway would be the same defect pointing the other way.
    if (stray) {
      return {
        state: 'contradicted',
        why: `This draft puts ${stray.text} to the customer. The ledger holds no invoice with an amount still due on this account.`,
      };
    }
    return DECLARES_SQUARE.test(text)
      ? { state: 'ok' }
      : { state: 'contradicted', why: 'The ledger shows nothing due on this account, and this draft chases a payment.' };
  }
  if (DECLARES_SQUARE.test(text)) {
    return {
      state: 'contradicted',
      why: `This draft tells the customer nothing is owed. The ledger has ${ledger.bills.length === 1 ? 'an invoice' : `${ledger.bills.length} invoices`} still due.`,
    };
  }
  const cited = ledger.bills.filter((bill) => bill.number && text.includes(bill.number));
  if (!cited.length) {
    return {
      state: 'contradicted',
      why: `This draft names none of the ${ledger.bills.length === 1 ? 'invoice' : `${ledger.bills.length} invoices`} still due on this account.`,
    };
  }
  // One held number is not enough once the text can be edited: the subject can
  // keep NR-000032 while the paragraph the customer reads chases NR-000099.
  const numbers = new Set(ledger.bills.map((bill) => bill.number));
  const strayNumber = invoiceNumbersIn(text, ledger.bills).find((number) => !numbers.has(number));
  if (strayNumber) {
    return {
      state: 'contradicted',
      why: `This draft chases ${strayNumber}. There is no invoice by that number outstanding here: the ledger holds `
        + `${[...numbers].join(', ')}.`,
    };
  }
  // The amounts last, because a draft that cites the right invoice and the
  // wrong figure is the one a customer argues with. Naming both halves — the
  // figure as it is written and what the ledger holds against it — is the
  // difference between "this is blocked" and a reader who can fix it.
  if (stray) {
    return {
      state: 'contradicted',
      why: `This draft says ${stray.text}. No invoice on this account carries that amount: the ledger holds `
        + `${ledger.bills.map((bill) => `${bill.number} at ${money(bill.amountDue, bill.currency)}`).join(', ')}.`,
    };
  }
  return { state: 'ok' };
}

/**
 * The verdict the dialog acts on, computed from the text that will be sent.
 *
 * The dialog holds two versions of the same letter: the one the engine
 * composed, and the one in the two editable boxes under it. It checked the
 * first and logged the second, under a banner reading "the draft is checked
 * against these figures before it can be logged" — so the guarantee held for
 * exactly as long as nobody typed. `outgoing` is the same value the Log button
 * posts, which is what makes that sentence true.
 *
 * `drafted` is only the engine's answer having arrived: there is nothing to
 * check before it does. It is taken rather than a flag because the shape of the
 * defect was reading it here instead of `outgoing`, and a signature that can
 * still express the mistake is one a test can hold this to.
 */
export function chaseVerdict(
  kind: string,
  drafted: { subject: string; body: string } | null,
  outgoing: { subject: string; body: string },
  ledger: LedgerRead,
  money?: (minor: number, currency: string) => string,
): DunningVerdict | null {
  if (!draftsFromAccount(kind) || !drafted) return null;
  return checkDunning(outgoing, ledger, money);
}

/**
 * Which record a draft of this kind has to be composed from.
 *
 * Everything else is written from the deal — its next step, its amount, its
 * contact. A chase is written from the ledger, which hangs off the account, and
 * a deal id resolves to no billing customer at all.
 */
export const draftsFromAccount = (kind: string): boolean => kind === 'dunning';
