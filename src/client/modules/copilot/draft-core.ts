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
 * client can see: a chase that names no invoice the ledger holds, or that
 * declares an account square while money is due on it, is refused rather than
 * shown for logging.
 */

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

/**
 * Whether a chase may be shown to a person to send.
 *
 * A dunning letter is a claim about money made to a customer, so the bar is not
 * "probably right": either this client has read the ledger and the draft agrees
 * with it, or there is no letter.
 */
export function checkDunning(draft: { subject: string; body: string }, ledger: LedgerRead): DunningVerdict {
  if (ledger.state === 'unread') {
    return { state: 'unresolved', why: ledger.why ?? 'This account’s billing ledger could not be read.' };
  }
  const text = `${draft.subject}\n${draft.body}`;
  if (!ledger.bills.length) {
    // Nothing is owed, so the engine's "nothing to chase" is the truth. A draft
    // that chases anyway would be the same defect pointing the other way.
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
  return { state: 'ok' };
}

/**
 * Which record a draft of this kind has to be composed from.
 *
 * Everything else is written from the deal — its next step, its amount, its
 * contact. A chase is written from the ledger, which hangs off the account, and
 * a deal id resolves to no billing customer at all.
 */
export const draftsFromAccount = (kind: string): boolean => kind === 'dunning';
