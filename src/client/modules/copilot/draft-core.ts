/**
 * A chase, checked against the ledger it is a claim about.
 *
 * `POST /v1/ai/draft` reads the outstanding invoices of the record it is given
 * — and it can only read them for a *billing* account. Handed a deal id, it
 * finds no customer, finds no invoices, and composes the honest sentence for
 * that state: "the billing ledger shows no invoice with an amount still due on
 * that account". Brightline Foods owes $127,840 on NR-000032, 56 days late,
 * and that letter was offered for logging over a real signature.
 *
 * So the chase is composed from the account, and the letter is read back
 * against the same ledger this client can see. The check runs on the text as
 * it stands when it is logged — edits included — and it is mechanical, so the
 * dialog can print exactly what it does and nothing more:
 *
 *   - every invoice number in the text, whatever its case, must be one the
 *     ledger holds;
 *   - every figure with a currency sign or code, and every number written with
 *     decimals, must be an open invoice's balance or their total;
 *   - a chase on an account with money due must name at least one of its
 *     invoices, and a chase on an account with nothing due may name no figure.
 *
 * What it does not do is read the sentence around a figure. A letter that
 * quotes the right invoice at the right amount and then says it is settled is
 * a letter only a person can catch, and the banner says so rather than
 * claiming a four-phrase word list is a guarantee. Never a promise the code
 * does not keep.
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

/** The bills with money still on them, oldest debt first, as the draft cites them. */
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

export type DunningVerdict =
  | { state: 'ok' }
  | { state: 'unresolved'; why: string }
  | { state: 'contradicted'; why: string };

/** A money figure exactly as a draft writes it. */
export interface DraftFigure {
  /** Verbatim, so the reader is shown the words they typed — "$127,480.00". */
  text: string;
  /** The digits alone — "127,480.00". */
  digits: string;
  /**
   * The book the figure named, or null for a bare decimal, which is in
   * whichever book the ledger keeps.
   */
  currency: string | null;
}

/** The books a bare glyph can only mean one of. */
const SYMBOL_BOOK: Record<string, string> = { $: 'usd', '€': 'eur', '£': 'gbp', '¥': 'jpy' };

const NUMBER = '\\d[\\d,]*(?:\\.\\d+)?';
const GLYPH_FIGURE = new RegExp(`([$€£¥])\\s?(${NUMBER})`, 'g');
const CODE_BEFORE = new RegExp(`(?<![A-Za-z])([A-Za-z]{3})\\s?(${NUMBER})(?![\\d.%A-Za-z])`, 'g');
const CODE_AFTER = new RegExp(`(${NUMBER})\\s?([A-Za-z]{3})(?![A-Za-z])`, 'g');
/**
 * A number with a decimal fraction and no book beside it — "127,480.00".
 *
 * Not preceded by a sign, a code, a letter or another digit; not followed by
 * a percent sign, more of a dotted date, or a letter. "6,400 employees" and
 * "56 days" are whole numbers and are not read as money, and the banner says
 * so in as many words.
 */
const BARE_DECIMAL = /(?<![\d.,$€£¥A-Za-z])(\d[\d,]*\.\d{1,2})(?![\d.%A-Za-z])/g;

/** The currency codes a letter may write a figure in and have it read as one. */
export const booksReadable = (currencies: readonly string[]): Set<string> =>
  new Set([...Object.values(SYMBOL_BOOK), ...currencies.map((code) => code.toLowerCase())]);

/**
 * Every money figure in a piece of writing.
 *
 * A glyph names its book. A three-letter code before or after the number
 * names its book when it is one of the books this ledger, or a glyph, can be
 * written in — so "Jul 8" and "56 days" are not money and "USD 127,480.00" and
 * "127,480.00 usd" are, whatever their case. A number written with decimals
 * and nothing beside it is money too.
 */
export function figuresIn(text: string, currencies: readonly string[]): DraftFigure[] {
  const books = booksReadable(currencies);
  const out: DraftFigure[] = [];
  const spans: [number, number][] = [];
  const claim = (start: number, raw: string, digits: string, currency: string | null) => {
    const end = start + raw.length;
    if (spans.some(([s, e]) => start < e && end > s)) return;
    spans.push([start, end]);
    out.push({ text: raw, digits, currency });
  };
  for (const match of text.matchAll(GLYPH_FIGURE)) claim(match.index ?? 0, match[0], match[2], SYMBOL_BOOK[match[1]]);
  for (const match of text.matchAll(CODE_BEFORE)) {
    const code = match[1].toLowerCase();
    if (books.has(code)) claim(match.index ?? 0, match[0], match[2], code);
  }
  for (const match of text.matchAll(CODE_AFTER)) {
    const code = match[2].toLowerCase();
    if (books.has(code)) claim(match.index ?? 0, match[0], match[1], code);
  }
  for (const match of text.matchAll(BARE_DECIMAL)) claim(match.index ?? 0, match[0], match[1], null);
  return out.sort((a, b) => text.indexOf(a.text) - text.indexOf(b.text));
}

/** What a figure is worth in a given book, in minor units — or null when it does not parse. */
export function amountIn(figure: Pick<DraftFigure, 'digits'>, currency: string): number | null {
  try { return parseMoney(figure.digits, currency).amount; } catch { return null; }
}

/**
 * Every invoice number in a piece of writing, in this workspace's own format.
 *
 * The shape is taken from the ledger rather than typed here: Northwind's
 * invoices read `NR-000032`, so the prefix is whatever sits before the digits
 * on the bills this account actually holds, matched whatever its case and
 * returned upper-cased so `nr-000099` and `NR-000099` are one number.
 */
export function invoiceNumbersIn(text: string, bills: readonly OutstandingBill[]): string[] {
  const prefixes = new Set(
    bills.map((bill) => (/^([^0-9]{2,})/.exec(bill.number)?.[1] ?? '').toUpperCase()).filter(Boolean),
  );
  const out: string[] = [];
  for (const prefix of prefixes) {
    const pattern = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+`, 'gi');
    for (const match of text.matchAll(pattern)) {
      const number = match[0].toUpperCase();
      if (!out.includes(number)) out.push(number);
    }
  }
  return out;
}

/** The figures this ledger will stand behind: each open balance, and their total in one book. */
const figuresHeld = (ledger: LedgerRead): Set<string> => {
  const held = new Set(ledger.bills.map((bill) => `${bill.currency}:${bill.amountDue}`));
  const total = ledgerTotal(ledger);
  if (total !== null) held.add(`${ledger.currencies[0]}:${total}`);
  return held;
};

const isHeld = (figure: DraftFigure, ledger: LedgerRead, held: Set<string>): boolean => {
  const books = figure.currency ? [figure.currency] : ledger.currencies;
  return books.some((book) => {
    const minor = amountIn(figure, book);
    return minor !== null && held.has(`${book}:${minor}`);
  });
};

const invoiceWord = (n: number): string => (n === 1 ? 'the invoice' : `${n} invoices`);

/**
 * Whether a chase may be logged, decided on the text that will be logged.
 *
 * A dunning letter is a claim about money made to a customer, so the bar is
 * not "probably right": either this client has read the ledger and every
 * number in the letter agrees with it, or there is no letter. Each rule names
 * the mismatch in the reader's own words and what the ledger holds against it,
 * which is the difference between "blocked" and something a person can fix.
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
  const figures = figuresIn(text, ledger.currencies);
  if (!ledger.bills.length) {
    // Nothing is owed, so a letter that puts a figure to the customer is
    // chasing money the ledger does not hold — the same defect the other way.
    const stray = figures[0];
    return stray
      ? { state: 'contradicted', why: `This draft puts ${stray.text} to the customer. The ledger holds no invoice with an amount still due on this account.` }
      : { state: 'ok' };
  }
  const numbers = new Set(ledger.bills.map((bill) => bill.number.toUpperCase()));
  const written = invoiceNumbersIn(text, ledger.bills);
  const strayNumber = written.find((number) => !numbers.has(number));
  if (strayNumber) {
    return {
      state: 'contradicted',
      why: `This draft chases ${strayNumber}. There is no invoice by that number outstanding here: the ledger holds `
        + `${[...ledger.bills.map((bill) => bill.number)].join(', ')}.`,
    };
  }
  if (!written.length) {
    return {
      state: 'contradicted',
      why: `This draft names none of ${invoiceWord(ledger.bills.length)} still due on this account`
        + ` — ${ledger.bills.map((bill) => bill.number).join(', ')}.`,
    };
  }
  const held = figuresHeld(ledger);
  const stray = figures.find((figure) => !isHeld(figure, ledger, held));
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
 * `outgoing` is the same value the Log button posts. `drafted` is only the
 * engine's answer having arrived: there is nothing to check before it does,
 * and the signature keeps the two apart so a test can hold this to checking
 * the edited text rather than the delivered one.
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
 * Whether the Log button may post, and why not when it may not.
 *
 * The one gate both the button's disabled state and the mutation itself read,
 * so a stale render cannot log a letter the check has already refused.
 */
export function canLog(
  kind: string,
  drafted: { subject: string; body: string } | null,
  outgoing: { subject: string; body: string },
  ledger: LedgerRead,
  money?: (minor: number, currency: string) => string,
): { ok: true } | { ok: false; why: string } {
  if (!outgoing.body.trim()) return { ok: false, why: 'There is nothing to log: the body is empty.' };
  const verdict = chaseVerdict(kind, drafted, outgoing, ledger, money);
  if (!verdict || verdict.state === 'ok') return { ok: true };
  return { ok: false, why: verdict.why };
}

/**
 * Which record a draft of this kind has to be composed from.
 *
 * Everything else is written from the deal — its next step, its amount, its
 * contact. A chase is written from the ledger, which hangs off the account, and
 * a deal id resolves to no billing customer at all.
 */
export const draftsFromAccount = (kind: string): boolean => kind === 'dunning';

/**
 * The one sentence the dialog prints about what it checks — kept beside the
 * check so the two cannot drift apart. Every clause of `checks` is a rule in
 * `checkDunning`; `limit` is what no rule here does.
 */
export const LEDGER_PROMISE = {
  checks: [
    'every invoice number, whatever its case, must be one of these',
    'every figure with a currency sign or code, and every number written with decimals, must be one of these amounts or their total',
  ],
  limit: 'A whole number with no sign and no decimals is not read as money, and the words around a figure are not read at all — whether the letter says the money is owed or settled is yours to check.',
} as const;

export const ledgerPromise = (): string =>
  `Read from the billing ledger just now. Before this draft can be logged — edits included — ${LEDGER_PROMISE.checks.join('; ')}. ${LEDGER_PROMISE.limit}`;
