/**
 * How the revenue module's three copilot tools read.
 *
 * `revenue_movement`, `revenue_collections` and `revenue_summary` answer in a
 * workspace that bills in several currencies, so every money scalar they hand
 * back is null and the `by_currency` rows are the figures. Every sentence here
 * is built from those rows: one figure per book, the workspace currency first,
 * and nothing added across books — there is no exchange rate to add with.
 */
import { formatMoney } from '../../shared/money';
import type { WorkspaceProfile } from './grounding';
import { listPhrase, plural } from './text';
import type { AgeingBucketId, MovementBucket } from './slots';
import { NO_FACTS, periodPhrase, type Rendered } from './answer';

/* --------------------------------- shapes -------------------------------- */

export interface MovementSlice {
  currency: string;
  opening: number;
  new_business: number;
  expansion: number;
  reactivation: number;
  resumed: number;
  contraction: number;
  churn: number;
  paused: number;
  net: number;
  closing: number;
}

export interface MovementToolResult {
  currency: string | null;
  currency_mode: string;
  balanced: boolean;
  warning: string | null;
  by_currency: { currency: string; opening: string; net: string; closing: string; balanced: boolean }[];
  months: {
    month: string;
    by_currency: MovementSlice[];
    reconciled: boolean;
    /** "Cascade Medical Devices: new $963.00" — the month's largest movers, per currency. */
    movers: string[];
  }[];
}

export interface CollectionsBook {
  currency: string;
  outstanding: number;
  outstanding_display: string;
  past_due: number;
  past_due_display: string;
  dso_days: string;
  failed_payment_exposure: number;
  recovery_rate: string;
  ageing: { bucket: string; invoices: number; amount: number }[];
}

export interface CollectionsToolResult {
  currency: string | null;
  currency_mode: string;
  by_currency: CollectionsBook[];
  note: string | null;
}

export interface SummaryBook {
  currency: string;
  mrr: number;
  arr: number;
  accounts: number;
  mrr_display: string;
  arr_display: string;
  receivables_display: string;
  net_revenue_retention: string;
  gross_revenue_retention: string;
}

export interface SummaryToolResult {
  currency: string | null;
  currency_mode: string;
  by_currency: SummaryBook[];
  balanced: boolean;
  warnings: string[];
}

/* -------------------------------- helpers -------------------------------- */

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-04" → "Apr 2026". */
export const monthName = (key: string): string => {
  const [year, month] = key.split('-').map(Number);
  return `${SHORT_MONTHS[(month || 1) - 1]} ${year}`;
};

/** Formatted the way the revenue tools format their own display strings, so one answer reads in one style. */
const fmt = (amount: number, currency: string, workspace: WorkspaceProfile): string =>
  formatMoney({ amount: Math.round(amount), currency }, { locale: workspace.locale });

const code = (currency: string): string => currency.toUpperCase();

/** The workspace's own book first, then the rest alphabetically — the order every per-currency answer uses. */
export function bookOrder<T extends { currency: string }>(rows: T[], workspace: WorkspaceProfile): T[] {
  return [...rows].sort((a, b) => Number(b.currency === workspace.currency) - Number(a.currency === workspace.currency) || a.currency.localeCompare(b.currency));
}

const BUCKET_LABEL: Record<MovementBucket, string> = {
  new_business: 'New business MRR', expansion: 'Expansion MRR', reactivation: 'Reactivation MRR', resumed: 'Resumed MRR',
  contraction: 'Contraction MRR', churn: 'Churned MRR', paused: 'Paused MRR', net: 'Net new MRR', all: 'MRR movement',
};

const BUCKET_VERB: Record<Exclude<MovementBucket, 'net' | 'all'>, string> = {
  new_business: 'signed', expansion: 'expanded', reactivation: 'reactivated', resumed: 'resumed',
  contraction: 'contracted', churn: 'churned', paused: 'paused',
};

const MOVER_KIND: Record<string, Exclude<MovementBucket, 'net' | 'all'>> = {
  new: 'new_business', expansion: 'expansion', reactivation: 'reactivation', resumed: 'resumed',
  contraction: 'contraction', churn: 'churn', paused: 'paused',
};

interface Mover { name: string; kind: Exclude<MovementBucket, 'net' | 'all'>; amount: string; month: string }

/** The movers the tool named, read back out of its "Name: kind amount" lines. */
export function moversOf(months: MovementToolResult['months']): Mover[] {
  const out: Mover[] = [];
  for (const row of months) {
    for (const line of row.movers) {
      const m = line.match(/^(.+): (new|expansion|reactivation|resumed|contraction|churn|paused) (.+)$/);
      if (!m) continue;
      out.push({ name: m[1], kind: MOVER_KIND[m[2]], amount: m[3].replace(/^-/, ''), month: row.month });
    }
  }
  return out;
}

/* ------------------------------- movement -------------------------------- */

export interface MovementWindow { start: number; end: number; label: string }

/** The month rows inside the window: "2026-04" ≥ the window's first month and < the month its end falls in. */
export function monthsIn(result: MovementToolResult, window: MovementWindow): MovementToolResult['months'] {
  const first = new Date(window.start).toISOString().slice(0, 7);
  const last = new Date(window.end).toISOString().slice(0, 7);
  return result.months.filter((row) => row.month >= first && row.month < last);
}

interface BookMovement extends MovementSlice { months: number }

/** One slice per currency across the rows: buckets summed, opening from the first month, closing from the last. */
export function movementBooks(rows: MovementToolResult['months'], workspace: WorkspaceProfile): BookMovement[] {
  const books = new Map<string, BookMovement>();
  for (const row of rows) {
    for (const slice of row.by_currency) {
      const held = books.get(slice.currency);
      if (!held) { books.set(slice.currency, { ...slice, months: 1 }); continue; }
      held.new_business += slice.new_business;
      held.expansion += slice.expansion;
      held.reactivation += slice.reactivation;
      held.resumed += slice.resumed;
      held.contraction += slice.contraction;
      held.churn += slice.churn;
      held.paused += slice.paused;
      held.net += slice.net;
      held.closing = slice.closing;
      held.months += 1;
    }
  }
  return bookOrder([...books.values()], workspace);
}

const signed = (amount: number, currency: string, workspace: WorkspaceProfile): string =>
  `${amount > 0 ? '+' : amount < 0 ? '−' : ''}${fmt(Math.abs(amount), currency, workspace)}`;

const moverLine = (mover: Mover, monthed: boolean): string =>
  `${mover.name} — ${mover.amount}${monthed ? ` in ${monthName(mover.month)}` : ''}`;

/**
 * One bucket of the MRR bridge over a period, the net of it, or the whole
 * bridge; led by the accounts when the question asked "who".
 */
export function renderMovement(
  result: MovementToolResult, window: MovementWindow, bucket: MovementBucket, lead: 'amount' | 'accounts', workspace: WorkspaceProfile,
): Rendered {
  const rows = monthsIn(result, window);
  const when = periodPhrase(window.label);
  const label = BUCKET_LABEL[bucket];
  if (!rows.length) {
    return { content: `The MRR bridge has no month ${when}: nothing was billed on a subscription then.`, citations: [], facts: { ...NO_FACTS, unit: 'money', count: 0, label, period: window.label, mixed: true } };
  }
  const books = movementBooks(rows, workspace);
  const currencies = books.map((b) => code(b.currency));
  const monthed = rows.length > 1;
  const movers = moversOf(rows);
  const facts = { ...NO_FACTS, unit: 'money' as const, label, period: window.label, mixed: books.length > 1, count: movers.length, rows: movers.map((m) => ({ id: m.name, label: m.name })) };
  const lines: string[] = [];

  if (bucket === 'all') {
    for (const book of books) {
      const parts: string[] = [];
      for (const key of ['new_business', 'expansion', 'reactivation', 'resumed', 'contraction', 'churn', 'paused'] as const) {
        if (book[key] !== 0) parts.push(`${BUCKET_LABEL[key].replace(' MRR', '').toLowerCase()} ${fmt(book[key], book.currency, workspace)}`);
      }
      lines.push(parts.length
        ? `• ${code(book.currency)}: opened at ${fmt(book.opening, book.currency, workspace)}, ${listPhrase(parts)}, closed at ${fmt(book.closing, book.currency, workspace)} (net ${signed(book.net, book.currency, workspace)}).`
        : `• ${code(book.currency)}: no movement — ${fmt(book.opening, book.currency, workspace)} at open and close.`);
    }
    const head = `MRR movement ${when}, one book per currency (${listPhrase(currencies)}) and the books are not added together:`;
    const tail = movers.length ? `Largest movers: ${movers.map((m) => `${m.name} ${BUCKET_VERB[m.kind]} ${m.amount}${monthed ? ` in ${monthName(m.month)}` : ''}`).join('; ')}.` : '';
    return { content: [head, lines.join('\n'), tail].filter(Boolean).join('\n\n'), citations: [], facts: { ...facts, value: books.length === 1 ? books[0].net : null, currency: books.length === 1 ? books[0].currency : null } };
  }

  if (bucket === 'net') {
    const parts = books.map((book) => `${signed(book.net, book.currency, workspace)} in ${code(book.currency)} (${fmt(book.opening, book.currency, workspace)} at open, ${fmt(book.closing, book.currency, workspace)} at close)`);
    const head = `Net new MRR ${when}: ${listPhrase(parts)}.${books.length > 1 ? ' One figure per currency; they are not added together.' : ''}`;
    const tail = movers.length ? `Largest movers: ${movers.map((m) => `${m.name} ${BUCKET_VERB[m.kind]} ${m.amount}${monthed ? ` in ${monthName(m.month)}` : ''}`).join('; ')}.` : '';
    return { content: [head, tail].filter(Boolean).join('\n\n'), citations: [], facts: { ...facts, value: books.length === 1 ? books[0].net : null, formatted: books.length === 1 ? signed(books[0].net, books[0].currency, workspace) : null, currency: books.length === 1 ? books[0].currency : null } };
  }

  const moved = books.filter((book) => book[bucket] !== 0);
  const still = books.filter((book) => book[bucket] === 0).map((book) => code(book.currency));
  const ofKind = movers.filter((m) => m.kind === bucket);
  const verb = BUCKET_VERB[bucket];
  const amounts = moved.length
    ? `${label} ${when}: ${listPhrase(moved.map((book) => `${fmt(book[bucket], book.currency, workspace)} in ${code(book.currency)}`))}${still.length ? `; nothing ${verb} in ${listPhrase(still, 'or')}` : ''}.`
    : `No MRR ${verb} ${when}, in ${listPhrase(currencies, 'or')}.`;
  const names = ofKind.length
    ? `${lead === 'accounts' ? `Accounts that ${verb} ${when}` : `The largest accounts that ${verb}`}: ${ofKind.map((m) => moverLine(m, monthed)).join('; ')}.`
    : '';
  const content = lead === 'accounts' ? [names, amounts].filter(Boolean).join('\n\n') : [amounts, names].filter(Boolean).join('\n\n');
  return {
    content,
    citations: [],
    facts: {
      ...facts,
      count: ofKind.length,
      rows: ofKind.map((m) => ({ id: m.name, label: m.name })),
      value: moved.length === 1 && books.length === 1 ? moved[0][bucket] : null,
      formatted: moved.length === 1 && books.length === 1 ? fmt(moved[0][bucket], moved[0].currency, workspace) : null,
      currency: moved.length === 1 && books.length === 1 ? moved[0].currency : null,
    },
  };
}

/* ------------------------------ collections ------------------------------ */

const bookNoun = (n: number): string => plural(n, 'invoice');

/** Days sales outstanding, per currency, on the months the tool was asked for. */
export function renderDso(result: CollectionsToolResult, months: number, workspace: WorkspaceProfile): Rendered {
  const books = bookOrder(result.by_currency, workspace);
  if (!books.length) return { content: 'There is no DSO to report: nothing has been billed.', citations: [], facts: { ...NO_FACTS, unit: 'days', count: 0, label: 'DSO' } };
  const parts = books.map((book) => (book.dso_days === 'n/a'
    ? `none in ${code(book.currency)} (nothing billed)`
    : `${book.dso_days} days in ${code(book.currency)}`));
  const content = `DSO is ${listPhrase(parts)}, on the last ${months} months of billings${books.length > 1 ? ' — one figure per currency, since a day count across currencies is a ratio of two numbers that were never in the same unit' : ''}.`;
  const single = books.length === 1 && books[0].dso_days !== 'n/a' ? books[0] : null;
  return { content, citations: [], facts: { ...NO_FACTS, unit: 'days', label: 'DSO', mixed: books.length > 1, value: single ? Number(single.dso_days) : null, formatted: single ? `${single.dso_days} days` : null, currency: single?.currency ?? null } };
}

const pastDueBuckets = (book: CollectionsBook) => book.ageing.filter((b) => b.bucket !== 'Not yet due' && b.amount !== 0);

/** What is past due and how long it has been, per currency. */
export function renderOverdueAge(result: CollectionsToolResult, workspace: WorkspaceProfile): Rendered {
  const books = bookOrder(result.by_currency, workspace);
  if (!books.length) return { content: 'Nothing is outstanding, so nothing is past due.', citations: [], facts: { ...NO_FACTS, unit: 'money', count: 0, label: 'Past due' } };
  const lines = books.map((book) => {
    if (book.past_due === 0) {
      return book.outstanding === 0
        ? `• ${code(book.currency)}: nothing outstanding.`
        : `• ${code(book.currency)}: nothing past due; ${book.outstanding_display} is outstanding and not yet due.`;
    }
    const age = pastDueBuckets(book).map((b) => `${fmt(b.amount, book.currency, workspace)} across ${b.invoices} ${bookNoun(b.invoices)} is ${b.bucket.toLowerCase()}`);
    const whole = book.past_due === book.outstanding ? 'all of what is outstanding' : `of ${book.outstanding_display} outstanding`;
    return `• ${code(book.currency)}: ${book.past_due_display} is past due, ${whole} — ${listPhrase(age)}.`;
  });
  const single = books.length === 1 ? books[0] : null;
  return {
    content: [`Past due${books.length > 1 ? ', one book per currency' : ''}:`, lines.join('\n')].join('\n\n'),
    citations: [],
    facts: { ...NO_FACTS, unit: 'money', label: 'Past due', mixed: books.length > 1, value: single?.past_due ?? null, formatted: single?.past_due_display ?? null, currency: single?.currency ?? null, count: books.reduce((sum, b) => sum + pastDueBuckets(b).reduce((s, x) => s + x.invoices, 0), 0) },
  };
}

const BUCKET_NAMES: Record<AgeingBucketId, string> = {
  not_yet_due: 'Not yet due', d1_30: '1–30 days past due', d31_60: '31–60 days past due', d61_90: '61–90 days past due', d90_plus: 'Over 90 days past due',
};

/** One ageing bucket, per currency. */
export function renderAgeingBucket(result: CollectionsToolResult, bucket: AgeingBucketId, workspace: WorkspaceProfile): Rendered {
  const name = BUCKET_NAMES[bucket];
  const books = bookOrder(result.by_currency, workspace);
  const held = books.map((book) => ({ book, cell: book.ageing.find((b) => b.bucket === name) })).filter((x) => x.cell && x.cell.amount !== 0);
  const empty = books.filter((book) => !held.some((x) => x.book === book)).map((book) => code(book.currency));
  const label = `${name} bucket`;
  if (!held.length) {
    return { content: `Nothing is in the ${name.toLowerCase()} bucket${empty.length ? `, in ${listPhrase(empty, 'or')}` : ''}.`, citations: [], facts: { ...NO_FACTS, unit: 'money', count: 0, label } };
  }
  const parts = held.map(({ book, cell }) => `${fmt(cell!.amount, book.currency, workspace)} across ${cell!.invoices} ${bookNoun(cell!.invoices)} in ${code(book.currency)}`);
  const content = `In the ${name.toLowerCase()} bucket: ${listPhrase(parts)}${empty.length ? `; nothing in ${listPhrase(empty, 'or')}` : ''}.`;
  const single = held.length === 1 && books.length === 1 ? held[0] : null;
  return {
    content,
    citations: [],
    facts: { ...NO_FACTS, unit: 'money', label, mixed: books.length > 1, count: held.reduce((sum, x) => sum + x.cell!.invoices, 0), value: single ? single.cell!.amount : null, formatted: single ? fmt(single.cell!.amount, single.book.currency, workspace) : null, currency: single?.book.currency ?? null },
  };
}

/** The whole ageing, per currency: what is outstanding and how old each part is. */
export function renderAgeing(result: CollectionsToolResult, workspace: WorkspaceProfile): Rendered {
  const books = bookOrder(result.by_currency, workspace);
  if (!books.length) return { content: 'Nothing is outstanding: there are no receivables to age.', citations: [], facts: { ...NO_FACTS, unit: 'money', count: 0, label: 'Receivables ageing' } };
  const lines = books.map((book) => {
    const cells = book.ageing.filter((b) => b.amount !== 0);
    const invoices = cells.reduce((sum, b) => sum + b.invoices, 0);
    if (!cells.length) return `• ${code(book.currency)}: nothing outstanding.`;
    return `• ${code(book.currency)} — ${book.outstanding_display} outstanding across ${invoices} ${bookNoun(invoices)}: ${listPhrase(cells.map((b) => `${b.bucket.toLowerCase()} ${fmt(b.amount, book.currency, workspace)} (${b.invoices} ${bookNoun(b.invoices)})`))}.`;
  });
  const single = books.length === 1 ? books[0] : null;
  return {
    content: [`Receivables ageing${books.length > 1 ? ', one book per currency — the books are not added together' : ''}:`, lines.join('\n')].join('\n\n'),
    citations: [],
    facts: { ...NO_FACTS, unit: 'money', label: 'Receivables ageing', mixed: books.length > 1, value: single?.outstanding ?? null, formatted: single?.outstanding_display ?? null, currency: single?.currency ?? null, count: books.reduce((sum, b) => sum + b.ageing.reduce((s, x) => s + x.invoices, 0), 0) },
  };
}

/* -------------------------------- summary -------------------------------- */

/** The revenue half of the business, per currency, over the months the tool was asked for. */
export function renderRevenueSummary(result: SummaryToolResult, months: number, workspace: WorkspaceProfile): Rendered {
  const books = bookOrder(result.by_currency, workspace);
  if (!books.length) return { content: 'There is no recurring revenue to summarise: no subscription carries MRR.', citations: [], facts: { ...NO_FACTS, unit: 'money', count: 0, label: 'Revenue summary' } };
  const lines = books.map((book) =>
    `• ${code(book.currency)} — MRR ${book.mrr_display} across ${book.accounts} ${plural(book.accounts, 'account')} (ARR ${book.arr_display}); net revenue retention ${book.net_revenue_retention}, gross ${book.gross_revenue_retention}; receivables ${book.receivables_display}.`);
  const head = books.length > 1
    ? `Recurring revenue is held in ${books.length} currencies, and this platform keeps no exchange rates, so there is one set of figures per book and they are not added together:`
    : 'Where the revenue half of the business stands:';
  const basis = `Retention is measured over the last ${months} months.`;
  const caveat = result.balanced ? '' : 'One of the reconciliations behind these figures did not balance, so read them with the revenue report open.';
  const single = books.length === 1 ? books[0] : null;
  return {
    content: [head, lines.join('\n'), [basis, caveat].filter(Boolean).join(' ')].filter(Boolean).join('\n\n'),
    citations: [],
    facts: { ...NO_FACTS, unit: 'money', label: 'MRR', mixed: books.length > 1, value: single?.mrr ?? null, formatted: single?.mrr_display ?? null, currency: single?.currency ?? null, count: books.reduce((sum, b) => sum + b.accounts, 0) },
  };
}
