/**
 * The template whitelist, as properties.
 *
 * Every test here states a rule and checks it against the database, never
 * against a phrasing. The rule that matters most: no answer prints a number
 * that is not the answer to the exact question asked. Every expected figure is
 * computed here from the seeded tables — `crm_records`, `billing_invoices`,
 * the subscription ledger, the meter pre-aggregate — by SQL and arithmetic the
 * engine does not run, and every number the answer prints has to be in the set
 * that computation allows.
 *
 * A `never` clause naming one wrong string for one question is an allowlist:
 * the same wrong figure passes under a synonym. So there is no such clause
 * anywhere in this file. What a near-miss must do is refuse, and what an
 * answer must do is state its figure and nothing else.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type App } from '../src/server/app';
import { frozenClock, type Clock } from '../src/server/kernel/clock';
import type { Auth } from '../src/server/kernel/http';
import { formatMoney } from '../src/shared/money';
import { DAY, formatDate, formatRelative } from '../src/shared/time';

// The template engine is the only answer path this suite admits. A key in the
// environment would put the hosted model in front of it.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;
// The API's per-principal limit is measured on the wall clock; this suite asks
// well over six hundred questions inside a minute.
process.env.AIN_RATE_LIMIT ||= '1000000';

const ORG = 'org_demo';
const TZ = 'America/New_York';
const ENGINE_MODEL = 'ain-engine-1';
const T0 = Date.parse('2026-09-03T12:00:00Z');
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };

let app: App;
let clock: Clock;

type Completion = Record<string, any>;
interface Asked { q: string; body: Completion }
/** Every completion this suite received, for the properties that hold across all of them. */
const asked: Asked[] = [];

before(async () => {
  clock = frozenClock(T0);
  app = await createApp({ db: 'memory', config: { env: 'test' }, clock });
});

after(() => app.close());

/**
 * The tool runtime refills its per-minute bucket from the workspace clock, and a
 * frozen clock never refills it. Ten seconds is a hundred tool calls.
 */
const tick = () => clock.advance(10_000);

async function ask(q: string, extra: Record<string, unknown> = {}, auth: Auth = DANA): Promise<Completion> {
  const res = await app.handle({ method: 'POST', path: '/v1/ai/complete', body: { prompt: q, ...extra }, auth });
  assert.equal(res.status, 200, `"${q}" → ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  asked.push({ q, body: res.body });
  return res.body;
}

/* ------------------------------- numbers ---------------------------------- */

/** Every number a piece of text states, as the reader would read it. */
/**
 * Every figure a response prints. A list's ordinals are not figures: "1. Rheinwerk
 * Antriebstechnik — $583,200" claims one number, not two, and counting the
 * marker failed every ranking template while the engine was answering them
 * correctly.
 */
const numbersIn = (text: unknown): number[] =>
  [...String(text ?? '').replace(/^\s*\d+\.\s+/gm, '').matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '')));

const allow = (...values: unknown[]): Set<number> => new Set(values.flatMap((v) => numbersIn(v)));

function assertOnlyTheseNumbers(content: string, allowed: Set<number>, context: string): void {
  const strays = [...new Set(numbersIn(content).filter((n) => !allowed.has(n)))];
  assert.deepEqual(strays, [], `${context}\nprinted ${strays.join(', ')}, which is not the answer to that question.\nAllowed: ${[...allowed].join(', ')}\n${content}`);
}

/* ----------------------------- the database ------------------------------- */

type Props = Record<string, unknown>;
interface Rec { id: string; name: string; owner: string | null; created: number; updated: number; p: Props }
interface Window { start: number; end: number; label: string }
interface Book { currency: string; value: number; count: number }

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const n = (v: number): string => v.toLocaleString('en-US');
const money = (minor: number, currency = 'usd'): string =>
  formatMoney({ amount: Math.round(minor), currency }, { locale: 'en-US', trimZeroFraction: true });
const money2 = (minor: number, currency: string): string => formatMoney({ amount: Math.round(minor), currency }, { locale: 'en-US' });
const day = (ts: number, tz = 'UTC'): string => formatDate(ts, { locale: 'en-US', timeZone: tz });
const pct = (v: number): string => `${Number(v.toFixed(1))}%`;
const inWindow = (ts: unknown, w: Window): boolean => ts !== null && ts !== undefined && num(ts) >= w.start && num(ts) < w.end;

const recs = (type: string): Rec[] =>
  app.db.all<{ id: string; display_name: string; owner_id: string | null; created: number; updated: number; properties: string }>(
    `SELECT id, display_name, owner_id, created, updated, properties FROM crm_records
     WHERE org_id = ? AND object_type = ? AND archived = 0 AND merged_into IS NULL`, ORG, type,
  ).map((r) => ({ id: r.id, name: r.display_name, owner: r.owner_id, created: r.created, updated: r.updated, p: JSON.parse(r.properties || '{}') as Props }));

const byName = (type: string, name: string): Rec => {
  const found = recs(type).find((r) => r.name === name);
  assert.ok(found, `fixture: no ${type} named ${name}`);
  return found!;
};

function stageSets(): { open: string[]; won: string[]; lost: string[] } {
  const rows = app.db.all<{ name: string; is_closed: number; is_won: number }>(
    `SELECT DISTINCT name, is_closed, is_won FROM crm_pipeline_stages WHERE org_id = ? AND object_type = 'deal'`, ORG);
  return {
    open: rows.filter((r) => !r.is_closed).map((r) => r.name),
    won: rows.filter((r) => r.is_closed && r.is_won).map((r) => r.name),
    lost: rows.filter((r) => r.is_closed && !r.is_won).map((r) => r.name),
  };
}
const isOpen = (d: Rec) => stageSets().open.includes(str(d.p.deal_stage));
const isWon = (d: Rec) => stageSets().won.includes(str(d.p.deal_stage));
const isLost = (d: Rec) => stageSets().lost.includes(str(d.p.deal_stage));
const amount = (d: Rec): number => num(d.p.amount);
const total = (rows: Rec[]): number => rows.reduce((sum, d) => sum + amount(d), 0);
const closeIn = (d: Rec, w: Window): boolean => inWindow(d.p.close_date, w);

const OPEN_TICKET = new Set(['new', 'waiting_on_us', 'waiting_on_customer', 'escalated']);
const isOpenTicket = (t: Rec) => OPEN_TICKET.has(str(t.p.status));

const people = (): Map<string, string> => new Map(app.db.all<{ id: string; name: string }>(
  `SELECT u.id, u.name FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ?`, ORG).map((r) => [r.id, r.name]));
const personId = (name: string): string => {
  const id = [...people().entries()].find(([, held]) => held === name)?.[0];
  assert.ok(id, `fixture: no teammate named ${name}`);
  return id!;
};
const ownerName = (id: string | null): string => (id && people().get(id)) || 'Unassigned';

const linkedIds = (id: string): Set<string> => new Set(
  app.db.all<{ from_id: string; to_id: string }>(
    `SELECT from_id, to_id FROM crm_associations WHERE org_id = ? AND (from_id = ? OR to_id = ?)`, ORG, id, id,
  ).flatMap((a) => [a.from_id, a.to_id]).filter((x) => x !== id));
const associated = (id: string, type: string): Rec[] => {
  const ids = linkedIds(id);
  return recs(type).filter((r) => ids.has(r.id));
};

const optionLabel = (type: string, property: string, value: unknown): string => {
  const raw = app.db.pluck<string>(`SELECT options FROM crm_properties WHERE org_id = ? AND object_type = ? AND name = ?`, ORG, type, property);
  const options = JSON.parse(raw || '[]') as { value: string; label: string }[];
  return options.find((o) => o.value === str(value))?.label ?? str(value);
};
const optionValue = (type: string, property: string, label: string): string => {
  const raw = app.db.pluck<string>(`SELECT options FROM crm_properties WHERE org_id = ? AND object_type = ? AND name = ?`, ORG, type, property);
  const options = JSON.parse(raw || '[]') as { value: string; label: string }[];
  const found = options.find((o) => o.label.toLowerCase() === label.toLowerCase());
  assert.ok(found, `fixture: ${type}.${property} has no option labelled ${label}`);
  return found!.value;
};
const options = (type: string, property: string): { value: string; label: string }[] =>
  JSON.parse(app.db.pluck<string>(`SELECT options FROM crm_properties WHERE org_id = ? AND object_type = ? AND name = ?`, ORG, type, property) || '[]');

/** The stage a label names, and the one pipeline it is scoped to when the label is that pipeline's own word for it. */
function stageByLabel(label: string): { value: string; pipeline: string | null } {
  const rows = app.db.all<{ name: string; label: string; pipeline: string }>(
    `SELECT name, label, pipeline FROM crm_pipeline_stages WHERE org_id = ? AND object_type = 'deal'`, ORG);
  const hits = rows.filter((r) => r.label.toLowerCase() === label.toLowerCase());
  assert.ok(hits.length, `fixture: no stage labelled ${label}`);
  const value = hits[0].name;
  const general = rows.filter((r) => r.name === value).some((r) => r.label.toLowerCase() === value.replace(/_/g, ' '));
  const generalLabel = general ? value.replace(/_/g, ' ') : null;
  const pipelines = [...new Set(hits.map((r) => r.pipeline))];
  const scoped = generalLabel !== label.toLowerCase() && pipelines.length === 1 ? pipelines[0] : null;
  return { value, pipeline: scoped };
}
const dealsAtStage = (label: string): Rec[] => {
  const stage = stageByLabel(label);
  return recs('deal').filter((d) => str(d.p.deal_stage) === stage.value && (!stage.pipeline || str(d.p.pipeline) === stage.pipeline));
};

/* -------------------------------- ledger ---------------------------------- */

const customerIds = (companyId: string): string[] =>
  app.db.all<{ id: string }>(`SELECT id FROM billing_customers WHERE org_id = ? AND crm_record_id = ?`, ORG, companyId).map((r) => r.id);
const customerName = (id: string): string => app.db.pluck<string>(`SELECT name FROM billing_customers WHERE org_id = ? AND id = ?`, ORG, id) ?? id;

const sortBooks = (books: Book[]): Book[] =>
  books.filter((b) => b.count > 0).sort((a, b) => Number(b.currency === 'usd') - Number(a.currency === 'usd') || a.currency.localeCompare(b.currency));

function invoiceBooks(where: string, params: unknown[], column: 'total' | 'amount_paid', ids?: string[], currency?: string): Book[] {
  if (ids && !ids.length) return [];
  const scoped = `${where}${ids ? ` AND customer_id IN (${ids.map(() => '?').join(', ')})` : ''}${currency ? ' AND currency = ?' : ''}`;
  const rows = app.db.all<{ c: string; v: number | null; nn: number }>(
    `SELECT currency AS c, SUM(${column}) AS v, COUNT(*) AS nn FROM billing_invoices WHERE org_id = ? AND ${scoped} GROUP BY currency`,
    ORG, ...(params as never[]), ...((ids ?? []) as never[]), ...((currency ? [currency] : []) as never[]));
  return sortBooks(rows.map((r) => ({ currency: r.c.toLowerCase(), value: Number(r.v ?? 0), count: r.nn })));
}
const revenueBooks = (w: Window, ids?: string[], currency?: string): Book[] =>
  invoiceBooks(`status = 'paid' AND paid_at >= ? AND paid_at < ?`, [w.start, w.end], 'amount_paid', ids, currency);
const invoicedBooks = (w: Window, ids?: string[], currency?: string): Book[] =>
  invoiceBooks(`status NOT IN ('draft', 'void', 'deleted') AND finalized_at >= ? AND finalized_at < ?`, [w.start, w.end], 'total', ids, currency);
const outstandingBooks = (ids?: string[], currency?: string): Book[] =>
  invoiceBooks(`status IN ('open', 'past_due', 'unpaid', 'uncollectible')`, [], 'total', ids, currency);

/** Recurring revenue from the ledger's own normalisation, one book per currency. */
function recurringBooks(months: 1 | 12, opts: { customerIds?: string[]; currency?: string } = {}): Book[] {
  const billing = app.ctx.svc.billing!;
  const per = new Map<string, Book>();
  for (const sub of billing.subscriptions(ORG, { status: 'all', limit: 500 })) {
    if (opts.customerIds && !opts.customerIds.includes(sub.customer)) continue;
    const monthly = billing.mrr(ORG, sub);
    if (monthly <= 0) continue;
    const currency = (sub.currency || 'usd').toLowerCase();
    if (opts.currency && currency !== opts.currency) continue;
    const book = per.get(currency) ?? { currency, value: 0, count: 0 };
    book.value += monthly * months;
    book.count += 1;
    per.set(currency, book);
  }
  return sortBooks([...per.values()]);
}

/* ------------------------------- windows ---------------------------------- */

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YEAR = (y: number): Window => ({ start: Date.UTC(y, 0, 1), end: Date.UTC(y + 1, 0, 1), label: String(y) });
const QUARTER = (q: number, y: number): Window => ({ start: Date.UTC(y, (q - 1) * 3, 1), end: Date.UTC(y, q * 3, 1), label: `Q${q} ${y}` });
const MONTH = (m: number, y: number): Window => ({ start: Date.UTC(y, m, 1), end: Date.UTC(y, m + 1, 1), label: `${SHORT_MONTHS[m]} ${y}` });
const LAST_DAYS = (now: number, days: number): Window => ({ start: now - days * DAY, end: now, label: `the last ${days} days` });
const NEXT_DAYS = (now: number, days: number): Window => ({ start: now, end: now + days * DAY, label: `the next ${days} days` });
const ALL_TIME = (now: number): Window => ({ start: 0, end: now, label: 'all time' });

/* ----------------------------- expectations ------------------------------- */

interface Expectation {
  /** What the answer has to state. */
  figures: (string | RegExp)[];
  /** Every number the answer is allowed to print. */
  numbers: Set<number>;
  /** The rows the question named; every citation has to be one of them. */
  ids?: Set<string>;
  also?: (body: Completion) => void;
}

const countRe = (value: number): RegExp => new RegExp(`\\b${n(value)}\\b`);
const NONE = /\bno\b/;

const countOf = (value: number, extra: unknown[] = []): Expectation =>
  ({ figures: [value > 0 ? countRe(value) : NONE], numbers: allow(value, ...extra) });

const countRows = (rows: Rec[], extra: unknown[] = []): Expectation =>
  ({ ...countOf(rows.length, extra), ids: new Set(rows.map((r) => r.id)) });

/** The numbers one listed row is allowed to bring with it: its own name and the fields its line shows. */
function lineNumbers(r: Rec, type: string): unknown[] {
  const out: unknown[] = [r.name];
  if (type === 'deal') { out.push(money(amount(r))); if (r.p.close_date) out.push(day(num(r.p.close_date))); }
  else if (type === 'contact') out.push(r.p.job_title, r.p.email);
  else if (type === 'task') { if (r.p.due_at) out.push(day(num(r.p.due_at), TZ)); }
  else if (r.p.occurred_at) out.push(day(num(r.p.occurred_at), TZ));
  return out;
}

function listOf(rows: Rec[], type: string, limit: number, extra: unknown[] = []): Expectation {
  const shown = Math.min(rows.length, limit);
  return {
    figures: [rows.length ? countRe(rows.length) : NONE],
    numbers: allow(rows.length, rows.length - shown, ...rows.flatMap((r) => lineNumbers(r, type)), ...extra),
    ids: new Set(rows.map((r) => r.id)),
    also: (body) => assert.equal(body.citations.length, shown, `cites ${body.citations.length} rows for a list that shows ${shown}`),
  };
}

function moneyOf(books: Book[], extra: unknown[] = []): Expectation {
  if (!books.length) return { figures: [money(0)], numbers: allow(0, ...extra) };
  if (books.length === 1) {
    const [b] = books;
    return { figures: [money(b.value, b.currency)], numbers: allow(money(b.value, b.currency), b.count, ...extra) };
  }
  return {
    figures: books.map((b) => money(b.value, b.currency)),
    numbers: allow(books.length, ...books.flatMap((b) => [money(b.value, b.currency), b.count]), ...extra),
  };
}

/** A sum over deals, stated with the deals behind it. */
const dealMoney = (rows: Rec[], extra: unknown[] = []): Expectation =>
  ({ ...moneyOf(rows.length ? [{ currency: 'usd', value: total(rows), count: rows.length }] : [], extra), ids: new Set(rows.map((r) => r.id)) });

/** A win rate over the decided deals in a window: won of decided. */
function winRate(rows: Rec[], extra: unknown[] = []): Expectation {
  const won = rows.filter(isWon).length;
  const decided = won + rows.filter(isLost).length;
  if (!decided) return { figures: [NONE], numbers: allow(0, ...extra) };
  const rate = (won / decided) * 100;
  return { figures: [pct(rate)], numbers: allow(pct(rate), won, decided, ...extra) };
}

/** A ranking: the leader named first, the top rows' figures and nothing below them. */
function ranked(rows: { label: string; formatted: string }[], limit: number, extra: unknown[] = []): Expectation {
  const top = rows.slice(0, limit);
  return {
    figures: top.length ? [top[0].formatted] : [NONE],
    numbers: allow(...top.map((r) => r.formatted), ...top.map((r) => r.label), ...extra),
    also: (body) => {
      if (top.length < 2) return;
      const first = body.content.indexOf(top[0].label);
      const second = body.content.indexOf(top[1].label);
      assert.ok(first >= 0 && (second < 0 || first < second), `${top[0].label} leads the ranking:\n${body.content}`);
    },
  };
}

/** Top accounts by a per-company figure, ties at the cut-off included so the allowed set is closed under reordering. */
function topCompanies(score: (c: Rec) => number, limit: number): { label: string; formatted: string; value: number }[] {
  const rows = recs('company').map((c) => ({ label: c.name, value: score(c) })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const cut = rows[Math.min(limit, rows.length) - 1]?.value ?? 0;
  return rows.filter((r) => r.value >= cut).map((r) => ({ ...r, formatted: money(r.value) }));
}

/** Paid or issued invoices per billing customer, per currency, the way a ledger ranking reads them. */
function invoiceRanking(w: Window, column: 'amount_paid' | 'total', status: string, limit: number): Expectation {
  const dated = column === 'amount_paid' ? 'paid_at' : 'finalized_at';
  const rows = app.db.all<{ customer_id: string; currency: string; v: number | null; nn: number }>(
    `SELECT customer_id, currency, SUM(${column}) AS v, COUNT(*) AS nn FROM billing_invoices
     WHERE org_id = ? AND ${status} AND ${dated} >= ? AND ${dated} < ? GROUP BY customer_id, currency ORDER BY v DESC LIMIT 40`,
    ORG, w.start, w.end);
  const books = new Map<string, { label: string; formatted: string }[]>();
  for (const r of rows) {
    const book = books.get(r.currency) ?? [];
    book.push({ label: customerName(r.customer_id), formatted: money(Number(r.v ?? 0), r.currency) });
    books.set(r.currency, book);
  }
  const numbers = allow(w.label);
  const figures: (string | RegExp)[] = [];
  for (const book of books.values()) {
    const top = book.slice(0, limit);
    figures.push(top[0].formatted);
    for (const value of allow(...top.map((r) => r.formatted), ...top.map((r) => r.label), book.length - top.length)) numbers.add(value);
  }
  return { figures, numbers };
}

/* ------------------------------- the corpus ------------------------------- */

interface Row { template: string; q: string | (() => string); writes?: boolean; expect: (now: number) => Expectation }

const withOpenTickets = (): Rec => {
  const found = recs('company').find((c) => associated(c.id, 'ticket').some(isOpenTicket));
  assert.ok(found, 'fixture: an account with an open ticket');
  return found!;
};
const withOpenDeals = (): Rec => {
  const found = recs('company').find((c) => associated(c.id, 'deal').filter(isOpen).length >= 2);
  assert.ok(found, 'fixture: an account with two open deals');
  return found!;
};
const meteredAccount = (meterId: string, w: Window): { company: Rec; customer: string } => {
  const streaming = app.db.all<{ customer_id: string }>(
    `SELECT DISTINCT customer_id FROM meter_event_summaries WHERE org_id = ? AND meter_id = ? AND hour_start >= ? AND hour_start < ?`,
    ORG, meterId, w.start, w.end).map((r) => r.customer_id);
  for (const customer of streaming) {
    const record = app.db.pluck<string>(`SELECT crm_record_id FROM billing_customers WHERE org_id = ? AND id = ?`, ORG, customer);
    const company = record ? recs('company').find((c) => c.id === record) : null;
    if (company) return { company, customer };
  }
  assert.fail('fixture: a billed account streaming into the meter');
};

interface MeterRow { customer: string; value: number; event_count: number }
async function meterRows(meterId: string, w: Window): Promise<MeterRow[]> {
  const res = await app.handle({ method: 'GET', path: `/v1/meters/${meterId}/customers`, query: { start: String(w.start), end: String(w.end), limit: '200' }, auth: DANA });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
  return (res.body.data as MeterRow[]).filter((r) => r.event_count > 0);
}
const meterUnit = (meterId: string): { name: string; unit: string | null; aggregation: string } =>
  app.db.get<{ name: string; unit: string | null; aggregation: string }>(`SELECT name, unit_label AS unit, aggregation FROM meters WHERE org_id = ? AND id = ?`, ORG, meterId)!;
/** "1,234.56 GB" — a unit count, never money. */
function units(value: number, unit: string | null): string {
  const number = Number.isInteger(value) ? n(value) : n(Number(value.toFixed(2)));
  if (!unit) return number;
  const symbol = unit === unit.toUpperCase() && /^[A-Z]{1,4}$/.test(unit);
  return `${number} ${value === 1 || symbol || /s$/i.test(unit) ? unit : `${unit}s`}`;
}
function meterTotal(rows: MeterRow[], aggregation: string): number {
  const values = rows.map((r) => r.value);
  return aggregation === 'max' ? Math.max(0, ...values) : values.reduce((a, v) => a + v, 0);
}

/** Every number an account's own records could put into a message written from them. */
function accountUniverse(c: Rec, now: number): unknown[] {
  const out: unknown[] = [c.name];
  const pushProps = (p: Props) => {
    for (const v of Object.values(p)) {
      if (typeof v === 'number') {
        out.push(v, n(v), money(v), day(v), day(v, TZ), Math.floor((now - v) / DAY), Math.round((v - now) / DAY), Math.abs(Math.round((now - v) / DAY)));
      } else if (typeof v === 'string') out.push(v);
    }
  };
  pushProps(c.p);
  for (const type of ['contact', 'deal', 'ticket', 'note', 'call', 'meeting', 'email', 'task']) {
    for (const r of associated(c.id, type)) { out.push(r.name); pushProps(r.p); }
  }
  const ids = customerIds(c.id);
  if (ids.length) {
    for (const inv of app.db.all<{ number: string; total: number; amount_due: number; currency: string; due_date: number | null }>(
      `SELECT number, total, amount_due, currency, due_date FROM billing_invoices WHERE org_id = ? AND customer_id IN (${ids.map(() => '?').join(', ')})`, ORG, ...(ids as never[]))) {
      out.push(inv.number, money(inv.total, inv.currency), money2(inv.total, inv.currency), money2(inv.amount_due, inv.currency));
      if (inv.due_date) out.push(day(inv.due_date), Math.floor((now - inv.due_date) / DAY));
    }
  }
  const open = associated(c.id, 'deal').filter(isOpen);
  const won = associated(c.id, 'deal').filter(isWon);
  out.push(money(total(open)), open.length, money(total(won)), won.length, associated(c.id, 'contact').length, associated(c.id, 'ticket').filter(isOpenTicket).length);
  return out;
}

function profileOf(c: Rec, now: number): Expectation {
  const open = associated(c.id, 'deal').filter(isOpen);
  const won = associated(c.id, 'deal').filter(isWon);
  const contacts = associated(c.id, 'contact');
  const tickets = associated(c.id, 'ticket').filter(isOpenTicket);
  const last = num(c.p.last_activity_at);
  const nextClose = open.map((d) => num(d.p.close_date)).filter((v) => v > 0).sort((a, b) => a - b)[0];
  const figures: (string | RegExp)[] = [c.name, ownerName(c.owner)];
  if (open.length) figures.push(money(total(open)));
  if (won.length) figures.push(money(total(won)));
  return {
    figures,
    numbers: allow(
      c.name, c.p.employee_count ? n(num(c.p.employee_count)) : '', c.p.connected_assets ? n(num(c.p.connected_assets)) : '',
      money(total(open)), open.length, money(total(won)), won.length, contacts.length, tickets.length,
      last ? Math.floor((now - last) / DAY) : '', nextClose ? day(nextClose) : '',
    ),
    ids: new Set([c.id]),
  };
}

function timelineOf(record: Rec, now: number): Expectation {
  const items: { id: string; at: number; title: string }[] = [];
  for (const type of ['note', 'call', 'meeting', 'email', 'task']) {
    for (const a of associated(record.id, type)) items.push({ id: a.id, at: num(a.p.occurred_at) || a.created, title: str(a.p.subject) || a.name });
  }
  for (const change of app.db.all<{ id: string; property: string; to_value: string | null; changed_at: number }>(
    `SELECT id, property, to_value, changed_at FROM crm_property_history WHERE org_id = ? AND record_id = ?`, ORG, record.id)) {
    items.push({ id: change.id, at: change.changed_at, title: `${change.property} changed to ${change.to_value ?? ''}` });
  }
  return {
    figures: [record.name],
    numbers: allow(record.name, ...items.flatMap((i) => [formatRelative(i.at, now), i.title])),
    ids: new Set(items.map((i) => i.id)),
    also: (body) => assert.ok(body.citations.length <= 10 && body.citations.length > 0, `a timeline cites the rows it lists`),
  };
}

/** A pending write: nothing landed, and the card holds exactly the arguments the sentence named. */
const pendingWrite = (tool: string, args: (body: Completion) => void, extra: unknown[] = []): Expectation => ({
  figures: [],
  numbers: allow(...extra),
  also: (body) => {
    assert.equal(body.pending_approvals.length, 1, `one write, prepared not performed:\n${body.content}`);
    assert.equal(body.pending_approvals[0].tool, tool);
    assert.deepEqual(body.tool_calls, [], 'nothing ran before a person approved it');
    args(body);
  },
});

const ACONCAGUA = 'Aconcagua Alimentos';
const KESTREL = 'Kestrel Aerospace Components';
const MERIDIAN = 'Meridian Forge Systems';
const DEAL_A = 'Aconcagua Alimentos — pilot expansion to 3 lines';
const DEAL_B = 'Meridian Forge Systems — predictive maintenance add-on';
const cust = (name: string) => customerIds(byName('company', name).id);

const dealsBy = (name: string) => recs('deal').filter((d) => d.owner === personId(name));
const decidedIn = (w: Window) => recs('deal').filter((d) => (isWon(d) || isLost(d)) && closeIn(d, w));

/** Every group of a breakdown: the rows are the answer, and no total is. */
const breakdownOf = (groups: { label: string; formatted: string; count?: number }[], extra: unknown[] = []): Expectation => ({
  figures: groups.map((g) => g.formatted),
  numbers: allow(...groups.flatMap((g) => [g.formatted, g.count ?? '', g.label]), ...extra),
});
const groupBy = <T>(rows: T[], key: (row: T) => string): Map<string, T[]> => {
  const out = new Map<string, T[]>();
  for (const row of rows) { const k = key(row); out.set(k, [...(out.get(k) ?? []), row]); }
  return out;
};
const ownerGroups = (rows: Rec[]) => [...groupBy(rows, (d) => d.owner ?? 'unassigned').entries()]
  .map(([owner, held]) => ({ label: ownerName(owner === 'unassigned' ? null : owner), value: total(held), count: held.length, formatted: money(total(held)) }))
  .sort((a, b) => b.value - a.value);

function subscriptionsOn(productId: string): { ids: string[]; names: string[]; nicknames: string[] } {
  const rows = app.db.all<{ id: string; nm: string | null }>(
    `SELECT s.id, (SELECT name FROM billing_customers c WHERE c.id = s.customer_id) AS nm FROM billing_subscriptions s
     WHERE s.org_id = ? AND s.status NOT IN ('canceled', 'incomplete_expired')
       AND EXISTS (SELECT 1 FROM billing_subscription_items i JOIN catalog_prices p ON p.id = i.price_id WHERE i.subscription_id = s.id AND p.product_id = ?)`,
    ORG, productId);
  const nicknames = app.db.all<{ nickname: string | null }>(`SELECT nickname FROM catalog_prices WHERE org_id = ? AND product_id = ?`, ORG, productId).map((r) => r.nickname ?? '');
  return { ids: rows.map((r) => r.id), names: rows.map((r) => r.nm ?? r.id), nicknames };
}
function subscriptionsWith(status: string): Expectation {
  const rows = app.db.all<{ id: string; nm: string | null }>(
    `SELECT s.id, (SELECT name FROM billing_customers c WHERE c.id = s.customer_id) AS nm FROM billing_subscriptions s WHERE s.org_id = ? AND s.status = ?`, ORG, status);
  const items = app.db.all<{ quantity: number; nickname: string | null; name: string }>(
    `SELECT i.quantity, p.nickname, pr.name FROM billing_subscription_items i JOIN catalog_prices p ON p.id = i.price_id JOIN catalog_products pr ON pr.id = p.product_id
     JOIN billing_subscriptions s ON s.id = i.subscription_id WHERE s.org_id = ? AND s.status = ?`, ORG, status);
  const shown = Math.min(rows.length, 25);
  return {
    figures: [rows.length ? countRe(rows.length) : NONE],
    numbers: allow(rows.length, rows.length - shown, ...rows.map((r) => r.nm), ...items.flatMap((i) => [i.quantity, i.nickname, i.name])),
    ids: new Set(rows.map((r) => r.id)),
    also: (body) => assert.equal(body.citations.length, shown),
  };
}
function invoicesWith(where: string, params: unknown[]): Expectation {
  const rows = app.db.all<{ id: string; number: string; amount_due: number; currency: string; due_date: number | null; nm: string | null }>(
    `SELECT i.id, i.number, i.amount_due, i.currency, i.due_date, (SELECT name FROM billing_customers c WHERE c.id = i.customer_id) AS nm
     FROM billing_invoices i WHERE i.org_id = ? AND ${where}`, ORG, ...(params as never[]));
  const shown = Math.min(rows.length, 25);
  return {
    figures: [rows.length ? countRe(rows.length) : NONE],
    numbers: allow(rows.length, rows.length - shown, ...rows.flatMap((r) => [r.number, r.nm, money2(r.amount_due, r.currency), r.due_date ? day(r.due_date) : ''])),
    ids: new Set(rows.map((r) => r.id)),
    also: (body) => assert.equal(body.citations.length, shown),
  };
}
function delinquents(now: number): Expectation {
  const customers = app.db.all<{ id: string; name: string }>(`SELECT id, name FROM billing_customers WHERE org_id = ? AND delinquent = 1`, ORG);
  const numbers = allow(customers.length);
  for (const c of customers) {
    const open = app.db.all<{ amount_due: number; currency: string; due_date: number | null }>(
      `SELECT amount_due, currency, due_date FROM billing_invoices WHERE org_id = ? AND customer_id = ? AND status IN ('draft', 'open') AND amount_due > 0`, ORG, c.id);
    const owed = open.reduce((sum, i) => sum + i.amount_due, 0);
    const oldest = open.map((i) => i.due_date).filter((d): d is number => typeof d === 'number').sort((a, b) => a - b)[0];
    for (const value of allow(c.name, money2(owed, open[0]?.currency ?? 'usd'), open.length, oldest && oldest < now ? Math.floor((now - oldest) / DAY) : '')) numbers.add(value);
  }
  return { figures: [customers.length ? countRe(customers.length) : NONE], numbers, ids: new Set(customers.map((c) => c.id)) };
}
/** Every number a product's own price rows carry, in minor and major units. */
function priceUniverse(productId: string): Expectation {
  const rows = app.db.all<{ nickname: string | null; unit_amount: number | null; tiers: string | null; transform_quantity: string | null; recurring: string | null; currency: string; currency_options: string | null }>(
    `SELECT nickname, unit_amount, tiers, transform_quantity, recurring, currency, currency_options FROM catalog_prices WHERE org_id = ? AND product_id = ? AND active = 1`, ORG, productId);
  const priced = rows.filter((r) => r.currency === 'usd' || (r.currency_options ?? '').includes('"usd"'));
  const numbers = allow(priced.length);
  for (const r of priced) {
    for (const value of numbersIn(`${r.nickname ?? ''} ${r.unit_amount ?? ''} ${r.tiers ?? ''} ${r.transform_quantity ?? ''} ${r.recurring ?? ''}`)) {
      numbers.add(value);
      numbers.add(value / 100);
    }
    numbers.add((JSON.parse(r.tiers ?? '[]') as unknown[]).length);
  }
  return { figures: [countRe(priced.length)], numbers };
}
function staleAccounts(now: number, days: number): Expectation {
  const cutoff = now - days * DAY;
  const rows = recs('company').filter((c) => !num(c.p.last_activity_at) || num(c.p.last_activity_at) <= cutoff);
  const shown = Math.min(rows.length, 10);
  return {
    figures: [rows.length ? countRe(rows.length) : NONE],
    numbers: allow(rows.length, rows.length - shown, days, ...rows.flatMap((c) => {
      const open = total(associated(c.id, 'deal').filter(isOpen));
      return [c.name, num(c.p.last_activity_at) ? Math.floor((now - num(c.p.last_activity_at)) / DAY) : '', open ? money(open) : ''];
    })),
    ids: new Set(rows.map((c) => c.id)),
  };
}
async function quoteOf(lookupKey: string, quantity: number): Promise<Expectation> {
  const price = app.db.pluck<string>(`SELECT id FROM catalog_prices WHERE org_id = ? AND lookup_key = ?`, ORG, lookupKey);
  const res = await app.handle({ method: 'POST', path: `/v1/prices/${price}/preview`, body: { quantity }, auth: DANA });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
  return { figures: [res.body.amount_display, n(quantity)], numbers: allow(res.body.amount_display, quantity) };
}

/** Sync-or-async expectation, so the ledger routes can be read where the rows need them. */
type Expect = (now: number) => Expectation | Promise<Expectation>;
interface CorpusRow { template: string; q: string | (() => string); writes?: boolean; expect: Expect }

const CORPUS: CorpusRow[] = [
  /* --------------------------------- counts ---------------------------------- */
  { template: 'count-objects', q: 'How many deals are there?', expect: () => countRows(recs('deal')) },
  { template: 'count-objects', q: 'What is the total number of companies?', expect: () => countRows(recs('company')) },
  { template: 'count-state-objects', q: 'How many deals are closed won?', expect: () => countRows(recs('deal').filter(isWon)) },
  { template: 'count-state-objects', q: 'How many won deals are there in total?', expect: () => countRows(recs('deal').filter(isWon)) },
  { template: 'count-state-objects', q: 'How many deals are closed?', expect: () => countRows(recs('deal').filter((d) => isWon(d) || isLost(d))) },
  { template: 'count-state-objects', q: 'How many escalated tickets do we have?', expect: () => countRows(recs('ticket').filter((t) => str(t.p.status) === 'escalated')) },
  { template: 'count-state-objects', q: 'How many open tickets are there?', expect: () => countRows(recs('ticket').filter(isOpenTicket)) },
  { template: 'list-objects', q: 'List the companies', expect: () => listOf(recs('company'), 'company', 10) },
  { template: 'list-objects', q: 'Show me all the contacts', expect: () => listOf(recs('contact'), 'contact', 10) },
  { template: 'list-state-objects', q: 'Which tickets are escalated?', expect: () => listOf(recs('ticket').filter((t) => str(t.p.status) === 'escalated'), 'ticket', 10) },
  { template: 'list-state-objects', q: 'Show me the open deals', expect: () => listOf(recs('deal').filter(isOpen), 'deal', 10) },
  { template: 'count-owner-objects', q: 'How many open deals does Dana Whitfield own?', expect: () => countRows(dealsBy('Dana Whitfield').filter(isOpen)) },
  { template: 'count-owner-objects', q: 'How many tickets does Sofia have?', expect: () => countRows(recs('ticket').filter((t) => t.owner === personId('Sofia Alvarez'))) },
  { template: 'list-owner-objects', q: 'Which open deals does Dana Whitfield own?', expect: () => listOf(dealsBy('Dana Whitfield').filter(isOpen), 'deal', 10) },
  { template: 'list-owner-objects', q: "Show me Marcus's open deals", expect: () => listOf(dealsBy('Marcus Ilori').filter(isOpen), 'deal', 10) },
  { template: 'count-deals-threshold', q: 'How many open deals are worth more than $500,000?', expect: () => countRows(recs('deal').filter((d) => isOpen(d) && amount(d) > 50_000_000), ['$500,000']) },
  { template: 'count-deals-threshold', q: 'How many deals are worth at least $1m?', expect: () => countRows(recs('deal').filter((d) => amount(d) >= 100_000_000), ['$1,000,000']) },
  { template: 'list-deals-threshold', q: 'Which open deals are worth more than $500,000?', expect: () => listOf(recs('deal').filter((d) => isOpen(d) && amount(d) > 50_000_000), 'deal', 10, ['$500,000']) },
  { template: 'list-deals-threshold', q: 'List the deals worth less than $50,000', expect: () => listOf(recs('deal').filter((d) => amount(d) < 5_000_000), 'deal', 10, ['$50,000']) },

  /* --------------------------------- periods --------------------------------- */
  { template: 'deals-closing-period', q: 'Which deals close in the next 90 days?', expect: (now) => listOf(recs('deal').filter((d) => isOpen(d) && closeIn(d, NEXT_DAYS(now, 90))), 'deal', 10, [90]) },
  { template: 'deals-closing-period', q: 'Show me the open deals closing in Q4 2026', expect: () => listOf(recs('deal').filter((d) => isOpen(d) && closeIn(d, QUARTER(4, 2026))), 'deal', 10, ['Q4 2026']) },
  { template: 'count-deals-closing-period', q: 'How many deals close in the next 90 days?', expect: (now) => countRows(recs('deal').filter((d) => isOpen(d) && closeIn(d, NEXT_DAYS(now, 90))), [90]) },
  { template: 'count-deals-closing-period', q: 'How many open deals have a close date in 2027?', expect: () => countRows(recs('deal').filter((d) => isOpen(d) && closeIn(d, YEAR(2027))), [2027]) },
  { template: 'deals-decided-period', q: 'Which deals did we win in 2025?', expect: () => listOf(recs('deal').filter((d) => isWon(d) && closeIn(d, YEAR(2025))), 'deal', 10, [2025]) },
  { template: 'deals-decided-period', q: 'Which deals were lost in Q2 2026?', expect: () => listOf(recs('deal').filter((d) => isLost(d) && closeIn(d, QUARTER(2, 2026))), 'deal', 10, ['Q2 2026']) },
  { template: 'count-deals-decided-period', q: 'How many deals did we win in 2025?', expect: () => countRows(recs('deal').filter((d) => isWon(d) && closeIn(d, YEAR(2025))), [2025]) },
  { template: 'count-deals-decided-period', q: 'How many deals closed in 2025?', expect: () => countRows(decidedIn(YEAR(2025)), [2025]) },

  /* --------------------------- pipelines and stages -------------------------- */
  { template: 'pipeline-worth', q: 'What is the New business pipeline worth?', expect: () => dealMoney(recs('deal').filter((d) => isOpen(d) && str(d.p.pipeline) === 'new_business')) },
  { template: 'pipeline-worth', q: 'How much is our Renewal pipeline worth?', expect: () => dealMoney(recs('deal').filter((d) => isOpen(d) && str(d.p.pipeline) === 'renewal')) },
  { template: 'count-deals-in-pipeline', q: 'How many open deals are in the New business pipeline?', expect: () => countRows(recs('deal').filter((d) => isOpen(d) && str(d.p.pipeline) === 'new_business')) },
  { template: 'count-deals-in-pipeline', q: 'How many deals are in the Expansion pipeline?', expect: () => countRows(recs('deal').filter((d) => str(d.p.pipeline) === 'expansion')) },
  { template: 'count-deals-at-stage', q: 'How many deals are at the Negotiation stage?', expect: () => countRows(dealsAtStage('Negotiation')) },
  { template: 'count-deals-at-stage', q: 'How many deals are sitting in Scoping?', expect: () => countRows(dealsAtStage('Scoping')) },
  { template: 'list-deals-at-stage', q: 'Which deals are at the Negotiation stage?', expect: () => listOf(dealsAtStage('Negotiation'), 'deal', 10) },
  { template: 'list-deals-at-stage', q: 'List the deals in Proposal sent', expect: () => listOf(dealsAtStage('Proposal sent'), 'deal', 10) },
  { template: 'pipeline-at-stage', q: 'How much pipeline is at the Negotiation stage?', expect: () => dealMoney(dealsAtStage('Negotiation')) },
  { template: 'pipeline-at-stage', q: 'What is our open pipeline at the Commercial terms stage?', expect: () => dealMoney(dealsAtStage('Commercial terms')) },

  /* --------------------------------- metrics --------------------------------- */
  { template: 'metric-snapshot', q: 'What is our ARR?', expect: () => moneyOf(recurringBooks(12)) },
  { template: 'metric-snapshot', q: 'What is our open pipeline?', expect: () => dealMoney(recs('deal').filter(isOpen)) },
  { template: 'metric-snapshot', q: 'What is our weighted pipeline?', expect: () => { const open = recs('deal').filter(isOpen); const weighted = open.reduce((s, d) => s + num(d.p.weighted_amount), 0); return { figures: [money(weighted)], numbers: allow(money(weighted), open.length), ids: new Set(open.map((d) => d.id)) }; } },
  { template: 'metric-snapshot', q: 'How much do we have in outstanding balance?', expect: () => moneyOf(outstandingBooks()) },
  { template: 'metric-snapshot', q: 'What is our forecast right now?', expect: () => { const open = recs('deal').filter(isOpen); const weighted = open.reduce((s, d) => s + num(d.p.weighted_amount), 0); return { figures: [money(weighted)], numbers: allow(money(weighted), open.length) }; } },
  { template: 'count-metric', q: 'How many customers do we have?', expect: () => countRows(recs('company').filter((c) => str(c.p.type) === 'customer')) },
  { template: 'count-metric', q: 'How many connected assets do we have?', expect: () => { const customers = recs('company').filter((c) => str(c.p.type) === 'customer'); const assets = customers.reduce((s, c) => s + num(c.p.connected_assets), 0); return { figures: [countRe(assets)], numbers: allow(assets, customers.length) }; } },
  { template: 'count-metric', q: 'How many open tickets have we got?', expect: () => countRows(recs('ticket').filter(isOpenTicket)) },
  { template: 'metric-period', q: 'What was our revenue in 2025?', expect: () => moneyOf(revenueBooks(YEAR(2025)), [2025]) },
  { template: 'metric-period', q: 'Tell me our win rate in 2025', expect: () => winRate(decidedIn(YEAR(2025)), [2025]) },
  { template: 'metric-period', q: 'What were our billings in Q2 2026?', expect: () => moneyOf(invoicedBooks(QUARTER(2, 2026)), ['Q2 2026']) },
  { template: 'metric-verb-period', q: 'How much did we book in 2025?', expect: () => dealMoney(recs('deal').filter((d) => isWon(d) && closeIn(d, YEAR(2025))), [2025]) },
  { template: 'metric-verb-period', q: 'How much was invoiced in Q2 2026?', expect: () => moneyOf(invoicedBooks(QUARTER(2, 2026)), ['Q2 2026']) },
  { template: 'metric-currency-snapshot', q: 'What is our MRR in EUR?', expect: () => moneyOf(recurringBooks(1, { currency: 'eur' })) },
  { template: 'metric-currency-snapshot', q: 'How much outstanding do we have in GBP?', expect: () => moneyOf(outstandingBooks(undefined, 'gbp')) },
  { template: 'metric-currency-period', q: 'What was our revenue in EUR in 2025?', expect: () => moneyOf(revenueBooks(YEAR(2025), undefined, 'eur'), [2025]) },
  { template: 'metric-currency-period', q: 'How much did we invoice in USD in Q2 2026?', expect: () => moneyOf(invoicedBooks(QUARTER(2, 2026), undefined, 'usd'), ['Q2 2026']) },
  { template: 'breakdown-snapshot', q: 'What is our open pipeline by stage?', expect: () => breakdownOf([...groupBy(recs('deal').filter(isOpen), (d) => str(d.p.deal_stage)).values()].map((held) => ({ label: str(held[0].p.deal_stage), formatted: money(total(held)), count: held.length }))) },
  { template: 'breakdown-snapshot', q: 'Break down our open tickets by priority', expect: () => breakdownOf([...groupBy(recs('ticket').filter(isOpenTicket), (t) => str(t.p.priority)).entries()].map(([label, held]) => ({ label, formatted: n(held.length) }))) },
  { template: 'breakdown-period', q: 'What was our win rate by owner in 2025?', expect: () => breakdownOf([...groupBy(decidedIn(YEAR(2025)), (d) => d.owner ?? 'unassigned').values()].map((held) => ({ label: ownerName(held[0].owner), formatted: pct((held.filter(isWon).length / held.length) * 100) })), [2025]) },
  { template: 'breakdown-period', q: 'Split our closed won bookings by owner in 2025', expect: () => breakdownOf(ownerGroups(recs('deal').filter((d) => isWon(d) && closeIn(d, YEAR(2025)))), [2025]) },

  /* ---------------------------------- owners --------------------------------- */
  { template: 'owner-pipeline', q: 'How much open pipeline does Dana Whitfield own?', expect: () => dealMoney(dealsBy('Dana Whitfield').filter(isOpen)) },
  { template: 'owner-pipeline', q: 'How many deals is Priya carrying?', expect: () => countRows(dealsBy('Priya Raman').filter(isOpen)) },
  // The first person is an owner: asked by Dana, "my" is Dana's book, never the workspace's.
  { template: 'owner-pipeline', q: 'What is my open pipeline?', expect: () => ({ ...dealMoney(dealsBy('Dana Whitfield').filter(isOpen)), figures: [money(total(dealsBy('Dana Whitfield').filter(isOpen))), 'Dana Whitfield'] }) },
  { template: 'owner-bookings-period', q: 'How much did Dana Whitfield book in 2025?', expect: () => dealMoney(dealsBy('Dana Whitfield').filter((d) => isWon(d) && closeIn(d, YEAR(2025))), [2025]) },
  { template: 'owner-bookings-period', q: "What were Marcus's bookings in Q2 2026?", expect: () => dealMoney(dealsBy('Marcus Ilori').filter((d) => isWon(d) && closeIn(d, QUARTER(2, 2026))), ['Q2 2026']) },
  { template: 'owner-deals-decided-period', q: 'How many deals did Dana Whitfield win in 2025?', expect: () => countRows(dealsBy('Dana Whitfield').filter((d) => isWon(d) && closeIn(d, YEAR(2025))), [2025]) },
  { template: 'owner-deals-decided-period', q: 'How many lost deals did Marcus have in 2025?', expect: () => countRows(dealsBy('Marcus Ilori').filter((d) => isLost(d) && closeIn(d, YEAR(2025))), [2025]) },
  { template: 'owner-win-rate-period', q: "What was Dana Whitfield's win rate in 2025?", expect: () => { const rows = dealsBy('Dana Whitfield').filter((d) => closeIn(d, YEAR(2025))); const won = rows.filter(isWon).length; const decided = won + rows.filter(isLost).length; const rate = decided ? Math.round((won / decided) * 1000) / 10 : 0; return decided ? { figures: [`${rate}%`], numbers: allow(rate, won, decided, 2025) } : { figures: [NONE], numbers: allow(2025) }; } },
  { template: 'owner-win-rate-period', q: 'What win rate did Marcus have in 2025?', expect: () => { const rows = dealsBy('Marcus Ilori').filter((d) => closeIn(d, YEAR(2025))); const won = rows.filter(isWon).length; const decided = won + rows.filter(isLost).length; const rate = decided ? Math.round((won / decided) * 1000) / 10 : 0; return decided ? { figures: [`${rate}%`], numbers: allow(rate, won, decided, 2025) } : { figures: [NONE], numbers: allow(2025) }; } },
  { template: 'owner-activities-period', q: 'How many meetings did Dana Whitfield hold in the last 30 days?', expect: (now) => countRows(recs('meeting').filter((m) => m.owner === personId('Dana Whitfield') && inWindow(m.p.occurred_at, LAST_DAYS(now, 30))), [30]) },
  { template: 'owner-activities-period', q: 'How many calls has Priya logged in 2026?', expect: () => countRows(recs('call').filter((c) => c.owner === personId('Priya Raman') && inWindow(c.p.occurred_at, YEAR(2026))), [2026]) },
  { template: 'rep-most-metric', q: 'Who has the most open pipeline?', expect: () => { const groups = ownerGroups(recs('deal').filter(isOpen)); return { ...ranked(groups, groups.length), numbers: allow(...groups.flatMap((g) => [g.formatted, g.count, g.label])) }; } },
  { template: 'rep-most-metric', q: 'Which rep has the least pipeline?', expect: () => { const groups = ownerGroups(recs('deal').filter(isOpen)).reverse(); return { ...ranked(groups, groups.length), numbers: allow(...groups.flatMap((g) => [g.formatted, g.count, g.label])) }; } },
  { template: 'rep-most-bookings-period', q: 'Who booked the most in 2025?', expect: () => { const groups = ownerGroups(recs('deal').filter((d) => isWon(d) && closeIn(d, YEAR(2025)))); return { ...ranked(groups, groups.length), numbers: allow(2025, ...groups.flatMap((g) => [g.formatted, g.count, g.label])) }; } },
  { template: 'rep-most-bookings-period', q: 'Which seller won the least in 2025?', expect: () => { const groups = ownerGroups(recs('deal').filter((d) => isWon(d) && closeIn(d, YEAR(2025)))).reverse(); return { ...ranked(groups, groups.length), numbers: allow(2025, ...groups.flatMap((g) => [g.formatted, g.count, g.label])) }; } },

  /* --------------------------------- rankings -------------------------------- */
  { template: 'rank-accounts', q: 'Who is our biggest customer by closed-won bookings?', expect: (now) => ranked(topCompanies((c) => total(associated(c.id, 'deal').filter((d) => isWon(d) && closeIn(d, ALL_TIME(now)))), 5), 5) },
  { template: 'rank-accounts', q: 'Which accounts have our highest revenue?', expect: (now) => invoiceRanking(ALL_TIME(now), 'amount_paid', `status = 'paid'`, 5) },
  { template: 'rank-accounts-period', q: 'Which accounts booked the most in 2025?', expect: () => ranked(topCompanies((c) => total(associated(c.id, 'deal').filter((d) => isWon(d) && closeIn(d, YEAR(2025)))), 5), 5, [2025]) },
  { template: 'rank-accounts-period', q: 'Who were our biggest customers by spend in 2025?', expect: () => invoiceRanking(YEAR(2025), 'amount_paid', `status = 'paid'`, 5) },
  { template: 'top-n-accounts', q: 'Top 5 customers by revenue', expect: (now) => invoiceRanking(ALL_TIME(now), 'amount_paid', `status = 'paid'`, 5) },
  { template: 'top-n-accounts', q: 'What are our top 3 accounts by open pipeline', expect: () => ranked(topCompanies((c) => total(associated(c.id, 'deal').filter(isOpen)), 3), 3, [3]) },

  /* ---------------------------------- ledger --------------------------------- */
  { template: 'subscriptions-on-plan', q: 'Which subscriptions are on the Telemetry Cloud Scale plan?', expect: () => { const on = subscriptionsOn('prod_nw_scale'); return { figures: [countRe(on.ids.length)], numbers: allow(on.ids.length, ...on.names, ...on.nicknames), ids: new Set(on.ids) }; } },
  { template: 'subscriptions-on-plan', q: 'Who is on Growth?', expect: () => { const on = subscriptionsOn('prod_nw_growth'); return { figures: [countRe(on.ids.length)], numbers: allow(on.ids.length, ...on.names, ...on.nicknames), ids: new Set(on.ids) }; } },
  { template: 'count-subscriptions-on-plan', q: 'How many subscriptions are on the Telemetry Cloud Scale plan?', expect: () => countOf(subscriptionsOn('prod_nw_scale').ids.length) },
  { template: 'count-subscriptions-on-plan', q: 'How many customers are on the Enterprise plan?', expect: () => countOf(subscriptionsOn('prod_nw_enterprise').ids.length) },
  { template: 'subscriptions-status', q: 'Which subscriptions are past due?', expect: () => subscriptionsWith('past_due') },
  { template: 'subscriptions-status', q: 'List the active subscriptions', expect: () => subscriptionsWith('active') },
  { template: 'count-subscriptions-status', q: 'How many subscriptions are active?', expect: () => countOf(app.db.count(`SELECT COUNT(*) FROM billing_subscriptions WHERE org_id = ? AND status = 'active'`, ORG)) },
  { template: 'count-subscriptions-status', q: 'How many trialing subscriptions do we have?', expect: () => countOf(app.db.count(`SELECT COUNT(*) FROM billing_subscriptions WHERE org_id = ? AND status = 'trialing'`, ORG)) },
  { template: 'customers-past-due', q: 'Which customers are past due?', expect: (now) => delinquents(now) },
  { template: 'customers-past-due', q: 'Who owes us money?', expect: (now) => delinquents(now) },
  { template: 'invoices-status', q: 'Which invoices are overdue?', expect: (now) => invoicesWith(`i.status IN ('draft', 'open') AND i.due_date IS NOT NULL AND i.due_date <= ?`, [now]) },
  { template: 'invoices-status', q: 'List the paid invoices', expect: () => invoicesWith(`i.status = 'paid'`, []) },
  { template: 'count-invoices-status', q: 'How many invoices are open?', expect: () => countOf(app.db.count(`SELECT COUNT(*) FROM billing_invoices WHERE org_id = ? AND status = 'open'`, ORG)) },
  { template: 'count-invoices-status', q: 'How many overdue invoices are there?', expect: (now) => countOf(app.db.count(`SELECT COUNT(*) FROM billing_invoices WHERE org_id = ? AND status IN ('draft', 'open') AND due_date IS NOT NULL AND due_date <= ?`, ORG, now)) },
  { template: 'count-invoices-period', q: 'How many invoices did we issue in 2025?', expect: () => countOf(invoicedBooks(YEAR(2025)).reduce((s, b) => s + b.count, 0), [2025]) },
  { template: 'count-invoices-period', q: 'How many invoices were paid in Q2 2026?', expect: () => countOf(revenueBooks(QUARTER(2, 2026)).reduce((s, b) => s + b.count, 0), ['Q2 2026']) },
  { template: 'plan-prices', q: 'What does the Telemetry Cloud Scale plan cost?', expect: () => priceUniverse('prod_nw_scale') },
  { template: 'plan-prices', q: 'How is the Growth plan priced?', expect: () => priceUniverse('prod_nw_growth') },

  /* ------------------------------ quiet accounts ----------------------------- */
  { template: 'stale-accounts', q: 'Which accounts have gone quiet?', expect: (now) => staleAccounts(now, 45) },
  { template: 'stale-accounts', q: 'Who has gone cold?', expect: (now) => staleAccounts(now, 45) },
  { template: 'stale-accounts-days', q: 'Which accounts have had no activity in 60 days?', expect: (now) => staleAccounts(now, 60) },
  { template: 'stale-accounts-days', q: 'Which companies have we not touched for the last 90 days?', expect: (now) => staleAccounts(now, 90) },

  /* --------------------------------- metering -------------------------------- */
  { template: 'metered-usage', q: 'How many stored telemetry did we meter in the last 30 days?', expect: async (now) => { const meter = meterUnit('mtr_nw_storage'); const rows = await meterRows('mtr_nw_storage', LAST_DAYS(now, 30)); const value = meterTotal(rows, meter.aggregation); return { figures: [rows.length ? units(value, meter.unit) : /nothing/], numbers: allow(rows.length ? units(value, meter.unit) : '', rows.length, 30) }; } },
  { template: 'metered-usage', q: 'What was our telemetry events volume in August 2026?', expect: async () => { const meter = meterUnit('mtr_nw_telemetry'); const rows = await meterRows('mtr_nw_telemetry', MONTH(7, 2026)); const value = meterTotal(rows, meter.aggregation); return { figures: [units(value, meter.unit)], numbers: allow(units(value, meter.unit), rows.length, 2026) }; } },
  { template: 'account-metered-usage', q: 'How many stored telemetry did Aconcagua Alimentos use in the last 30 days?', expect: async (now) => { const meter = meterUnit('mtr_nw_storage'); const [customer] = cust(ACONCAGUA); const res = await app.handle({ method: 'GET', path: '/v1/meters/mtr_nw_storage/usage', query: { customer, start: String(now - 30 * DAY), end: String(now) }, auth: DANA }); assert.equal(res.status, 200); const used = res.body.event_count > 0; return { figures: [ACONCAGUA, used ? units(res.body.value, meter.unit) : /nothing/], numbers: allow(30, used ? units(res.body.value, meter.unit) : '') }; } },
  { template: 'account-metered-usage', q: () => `What was ${meteredAccount('mtr_nw_telemetry', MONTH(7, 2026)).company.name}'s telemetry events usage in August 2026?`, expect: async () => { const meter = meterUnit('mtr_nw_telemetry'); const { company, customer } = meteredAccount('mtr_nw_telemetry', MONTH(7, 2026)); const res = await app.handle({ method: 'GET', path: '/v1/meters/mtr_nw_telemetry/usage', query: { customer, start: String(MONTH(7, 2026).start), end: String(MONTH(7, 2026).end) }, auth: DANA }); assert.equal(res.status, 200); return { figures: [company.name, units(res.body.value, meter.unit)], numbers: allow(company.name, units(res.body.value, meter.unit), 2026) }; } },
  { template: 'quote-price', q: 'How much would 50 million telemetry events cost?', expect: () => quoteOf('telemetry_events_monthly', 50_000_000) },
  { template: 'quote-price', q: 'How much does 500 bulk export volume cost?', expect: () => quoteOf('data_export_monthly', 500) },
  { template: 'quote-price', q: 'Quote me 2 million telemetry events', expect: () => quoteOf('telemetry_events_monthly', 2_000_000) },

  /* --------------------------------- accounts -------------------------------- */
  { template: 'account-profile', q: `Where does ${ACONCAGUA} stand?`, expect: (now) => profileOf(byName('company', ACONCAGUA), now) },
  { template: 'account-profile', q: `Tell me about ${KESTREL}`, expect: (now) => profileOf(byName('company', KESTREL), now) },
  { template: 'account-owner', q: `Who owns ${ACONCAGUA}?`, expect: () => ({ figures: [ownerName(byName('company', ACONCAGUA).owner)], numbers: allow(ACONCAGUA) }) },
  { template: 'account-owner', q: `Who looks after ${MERIDIAN}?`, expect: () => ({ figures: [ownerName(byName('company', MERIDIAN).owner)], numbers: allow(MERIDIAN) }) },
  { template: 'account-spend-period', q: `How much did ${ACONCAGUA} spend in 2025?`, expect: () => { const books = revenueBooks(YEAR(2025), cust(ACONCAGUA)); return books.length ? moneyOf(books, [2025]) : { figures: [/nothing/], numbers: allow(0, 2025) }; } },
  { template: 'account-spend-period', q: `How much did ${KESTREL} pay us in 2025?`, expect: () => { const books = revenueBooks(YEAR(2025), cust(KESTREL)); return books.length ? moneyOf(books, [2025]) : { figures: [/nothing/], numbers: allow(0, 2025) }; } },
  { template: 'account-invoiced-period', q: `How much did we invoice ${ACONCAGUA} in 2025?`, expect: () => moneyOf(invoicedBooks(YEAR(2025), cust(ACONCAGUA)), [2025]) },
  { template: 'account-invoiced-period', q: `How much was ${MERIDIAN} billed in Q2 2026?`, expect: () => moneyOf(invoicedBooks(QUARTER(2, 2026), cust(MERIDIAN)), ['Q2 2026']) },
  { template: 'account-snapshot-metric', q: `What is ${ACONCAGUA}'s open pipeline?`, expect: () => dealMoney(associated(byName('company', ACONCAGUA).id, 'deal').filter(isOpen)) },
  { template: 'account-snapshot-metric', q: `What is the MRR of ${MERIDIAN}?`, expect: () => moneyOf(recurringBooks(1, { customerIds: cust(MERIDIAN) })) },
  { template: 'account-period-metric', q: `What was ${ACONCAGUA}'s revenue in 2025?`, expect: () => moneyOf(revenueBooks(YEAR(2025), cust(ACONCAGUA)), [2025]) },
  { template: 'account-period-metric', q: `What was the closed won bookings of ${KESTREL} in 2025?`, expect: () => dealMoney(associated(byName('company', KESTREL).id, 'deal').filter((d) => isWon(d) && closeIn(d, YEAR(2025))), [2025]) },
  { template: 'account-owes', q: `What does ${ACONCAGUA} owe?`, expect: () => { const books = outstandingBooks(cust(ACONCAGUA)); return books.length ? moneyOf(books) : { figures: [/nothing/], numbers: allow() }; } },
  { template: 'account-owes', q: `How much is ${MERIDIAN} outstanding?`, expect: () => { const books = outstandingBooks(cust(MERIDIAN)); return books.length ? moneyOf(books) : { figures: [/nothing/], numbers: allow() }; } },
  { template: 'account-open-tickets-count', q: `How many open tickets does ${ACONCAGUA} have?`, expect: () => countRows(associated(byName('company', ACONCAGUA).id, 'ticket').filter(isOpenTicket)) },
  { template: 'account-open-tickets-count', q: () => `How many tickets are open at ${withOpenTickets().name}?`, expect: () => countRows(associated(withOpenTickets().id, 'ticket').filter(isOpenTicket)) },
  { template: 'account-open-tickets', q: `Which tickets are open at ${ACONCAGUA}?`, expect: () => listOf(associated(byName('company', ACONCAGUA).id, 'ticket').filter(isOpenTicket), 'ticket', 10) },
  { template: 'account-open-tickets', q: () => `List the open tickets for ${withOpenTickets().name}`, expect: () => listOf(associated(withOpenTickets().id, 'ticket').filter(isOpenTicket), 'ticket', 10) },
  { template: 'account-contacts', q: `Who do we know at ${ACONCAGUA}?`, expect: () => listOf(associated(byName('company', ACONCAGUA).id, 'contact'), 'contact', 25) },
  { template: 'account-contacts', q: `List the contacts at ${KESTREL}`, expect: () => listOf(associated(byName('company', KESTREL).id, 'contact'), 'contact', 25) },
  { template: 'account-contacts-count', q: `How many contacts do we have at ${ACONCAGUA}?`, expect: () => countRows(associated(byName('company', ACONCAGUA).id, 'contact')) },
  { template: 'account-contacts-count', q: `How many people do we know at ${KESTREL}?`, expect: () => countRows(associated(byName('company', KESTREL).id, 'contact')) },
  { template: 'account-open-deals', q: `Which deals are open at ${ACONCAGUA}?`, expect: () => listOf(associated(byName('company', ACONCAGUA).id, 'deal').filter(isOpen), 'deal', 10) },
  { template: 'account-open-deals', q: () => `List ${withOpenDeals().name}'s open deals`, expect: () => listOf(associated(withOpenDeals().id, 'deal').filter(isOpen), 'deal', 10) },
  { template: 'record-timeline', q: `What happened recently at ${ACONCAGUA}?`, expect: (now) => timelineOf(byName('company', ACONCAGUA), now) },
  { template: 'record-timeline', q: `Show me the recent history of ${KESTREL}`, expect: (now) => timelineOf(byName('company', KESTREL), now) },

  /* ----------------------------------- deals --------------------------------- */
  { template: 'deal-stage', q: `What stage is ${DEAL_A} at?`, expect: () => { const d = byName('deal', DEAL_A); const label = app.db.pluck<string>(`SELECT label FROM crm_pipeline_stages WHERE org_id = ? AND object_type = 'deal' AND name = ? AND pipeline = ?`, ORG, str(d.p.deal_stage), str(d.p.pipeline)); return { figures: [d.name, label!], numbers: allow(d.name) }; } },
  { template: 'deal-stage', q: `Where is ${DEAL_B} in the pipeline?`, expect: () => { const d = byName('deal', DEAL_B); const label = app.db.pluck<string>(`SELECT label FROM crm_pipeline_stages WHERE org_id = ? AND object_type = 'deal' AND name = ? AND pipeline = ?`, ORG, str(d.p.deal_stage), str(d.p.pipeline)); return { figures: [d.name, label!], numbers: allow(d.name) }; } },
  { template: 'deal-close-date', q: `When does ${DEAL_A} close?`, expect: () => { const d = byName('deal', DEAL_A); return { figures: [day(num(d.p.close_date))], numbers: allow(d.name, day(num(d.p.close_date))) }; } },
  { template: 'deal-close-date', q: `What is the close date of ${DEAL_B}?`, expect: () => { const d = byName('deal', DEAL_B); return { figures: [day(num(d.p.close_date))], numbers: allow(d.name, day(num(d.p.close_date))) }; } },
  { template: 'deal-owner', q: `Who owns ${DEAL_A}?`, expect: () => { const d = byName('deal', DEAL_A); return { figures: [ownerName(d.owner)], numbers: allow(d.name) }; } },
  { template: 'deal-owner', q: `Whose deal is ${DEAL_B}?`, expect: () => { const d = byName('deal', DEAL_B); return { figures: [ownerName(d.owner)], numbers: allow(d.name) }; } },
  { template: 'deal-amount', q: `How much is ${DEAL_A} worth?`, expect: () => { const d = byName('deal', DEAL_A); return { figures: [money(amount(d))], numbers: allow(d.name, money(amount(d))) }; } },
  { template: 'deal-amount', q: `What is the value of ${DEAL_B}?`, expect: () => { const d = byName('deal', DEAL_B); return { figures: [money(amount(d))], numbers: allow(d.name, money(amount(d))) }; } },
  { template: 'largest-deal', q: 'What is our biggest open deal?', expect: () => { const top = [...recs('deal').filter(isOpen)].sort((a, b) => amount(b) - amount(a))[0]; return { figures: [top.name, money(amount(top))], numbers: allow(top.name, money(amount(top))), ids: new Set([top.id]) }; } },
  { template: 'largest-deal', q: 'Which is our smallest deal?', expect: () => { const low = [...recs('deal')].sort((a, b) => amount(a) - amount(b))[0]; return { figures: [low.name, money(amount(low))], numbers: allow(low.name, money(amount(low))), ids: new Set([low.id]) }; } },
  { template: 'top-n-deals', q: 'What are our 5 biggest open deals?', expect: () => { const rows = [...recs('deal').filter(isOpen)].sort((a, b) => amount(b) - amount(a)); const cut = amount(rows[4]); const top = rows.filter((d) => amount(d) >= cut); return { figures: top.slice(0, 5).map((d) => money(amount(d))), numbers: allow(5, ...top.flatMap((d) => [d.name, money(amount(d))])), ids: new Set(top.map((d) => d.id)), also: (body) => assert.equal(body.citations.length, 5) }; } },
  { template: 'top-n-deals', q: 'Top 3 deals', expect: () => { const rows = [...recs('deal')].sort((a, b) => amount(b) - amount(a)); const cut = amount(rows[2]); const top = rows.filter((d) => amount(d) >= cut); return { figures: top.slice(0, 3).map((d) => money(amount(d))), numbers: allow(3, ...top.flatMap((d) => [d.name, money(amount(d))])), ids: new Set(top.map((d) => d.id)), also: (body) => assert.equal(body.citations.length, 3) }; } },
  { template: 'top-n-deals', q: 'List our 4 smallest lost deals', expect: () => { const rows = [...recs('deal').filter(isLost)].sort((a, b) => amount(a) - amount(b)); const cut = amount(rows[3]); const low = rows.filter((d) => amount(d) <= cut); return { figures: low.slice(0, 4).map((d) => money(amount(d))), numbers: allow(4, ...low.flatMap((d) => [d.name, money(amount(d))])), ids: new Set(low.map((d) => d.id)), also: (body) => assert.equal(body.citations.length, 4) }; } },

  /* -------------------------------- comparisons ------------------------------ */
  { template: 'compare-metric', q: 'How did our closed-won bookings in 2025 compare with 2024?', expect: () => {
    const a = recs('deal').filter((d) => isWon(d) && closeIn(d, YEAR(2025)));
    const b = recs('deal').filter((d) => isWon(d) && closeIn(d, YEAR(2024)));
    const delta = total(b) - total(a);
    const change = total(a) === 0 ? null : Math.round((delta / Math.abs(total(a))) * 1000) / 10;
    return { figures: [money(total(a)), money(total(b))], numbers: allow(money(total(a)), a.length, money(total(b)), b.length, money(Math.abs(delta)), change === null ? '' : Math.abs(change), 2025, 2024) };
  } },
  { template: 'compare-metric', q: 'Compare our win rate in Q1 2026 with Q2 2026', expect: () => {
    const rate = (w: Window) => { const rows = decidedIn(w); const won = rows.filter(isWon).length; return { won, decided: rows.length, value: rows.length ? (won / rows.length) * 100 : 0 }; };
    const a = rate(QUARTER(1, 2026));
    const b = rate(QUARTER(2, 2026));
    const delta = b.value - a.value;
    const change = a.value === 0 ? null : Math.round((delta / Math.abs(a.value)) * 1000) / 10;
    return { figures: [pct(a.value), pct(b.value)], numbers: allow(pct(a.value), a.won, a.decided, pct(b.value), b.won, b.decided, Math.abs(Math.round(delta * 10) / 10), change === null ? '' : Math.abs(change), 'Q1 2026', 'Q2 2026') };
  } },

  /* -------------------------------- dimensions ------------------------------- */
  { template: 'count-by-dimension', q: 'How many deals are there by stage?', expect: () => { const groups = [...groupBy(recs('deal'), (d) => str(d.p.deal_stage)).entries()]; return { figures: [countRe(recs('deal').length)], numbers: allow(recs('deal').length, ...groups.flatMap(([value, held]) => [held.length, optionLabel('deal', 'deal_stage', value)])) }; } },
  { template: 'count-by-dimension', q: 'Companies by industry', expect: () => { const groups = [...groupBy(recs('company'), (c) => str(c.p.industry)).entries()]; return { figures: [countRe(recs('company').length)], numbers: allow(recs('company').length, ...groups.flatMap(([value, held]) => [held.length, optionLabel('company', 'industry', value)])) }; } },
  { template: 'companies-in-industry', q: 'Which companies are in the consumer packaged goods industry?', expect: () => listOf(recs('company').filter((c) => str(c.p.industry) === optionValue('company', 'industry', 'Consumer packaged goods')), 'company', 25) },
  { template: 'companies-in-industry', q: 'List the pharma companies', expect: () => listOf(recs('company').filter((c) => str(c.p.industry) === optionValue('company', 'industry', 'Pharmaceuticals')), 'company', 25) },
  { template: 'count-companies-in-industry', q: 'How many companies are in the consumer packaged goods industry?', expect: () => countRows(recs('company').filter((c) => str(c.p.industry) === optionValue('company', 'industry', 'Consumer packaged goods'))) },
  { template: 'count-companies-in-industry', q: 'How many aerospace accounts do we have?', expect: () => countRows(recs('company').filter((c) => str(c.p.industry) === optionValue('company', 'industry', 'Aerospace & defence'))) },
  { template: 'companies-in-region', q: 'Which companies are in APAC?', expect: () => listOf(recs('company').filter((c) => str(c.p.region) === optionValue('company', 'region', 'APAC')), 'company', 25) },
  { template: 'companies-in-region', q: 'List the accounts in the EMEA region', expect: () => listOf(recs('company').filter((c) => str(c.p.region) === optionValue('company', 'region', 'EMEA')), 'company', 25) },
  { template: 'deals-from-source', q: 'Which deals came from webinars?', expect: () => listOf(recs('deal').filter((d) => str(d.p.lead_source) === optionValue('deal', 'lead_source', 'Webinar')), 'deal', 10) },
  { template: 'deals-from-source', q: 'Which won deals come from partner referrals?', expect: () => listOf(recs('deal').filter((d) => isWon(d) && str(d.p.lead_source) === optionValue('deal', 'lead_source', 'Partner referral')), 'deal', 10) },
  { template: 'count-deals-from-source', q: 'How many deals came from webinars?', expect: () => countRows(recs('deal').filter((d) => str(d.p.lead_source) === optionValue('deal', 'lead_source', 'Webinar'))) },
  { template: 'count-deals-from-source', q: 'How many open deals originated from trade shows?', expect: () => countRows(recs('deal').filter((d) => isOpen(d) && str(d.p.lead_source) === optionValue('deal', 'lead_source', 'Trade show'))) },
  { template: 'pipeline-from-source', q: 'How much open pipeline came from webinars?', expect: () => dealMoney(recs('deal').filter((d) => isOpen(d) && str(d.p.lead_source) === optionValue('deal', 'lead_source', 'Webinar'))) },
  { template: 'pipeline-from-source', q: 'What is our pipeline from inbound content?', expect: () => dealMoney(recs('deal').filter((d) => isOpen(d) && str(d.p.lead_source) === optionValue('deal', 'lead_source', 'Inbound content'))) },
  { template: 'deals-lost-to-competitor', q: 'Which deals did we lose to Tulip?', expect: () => listOf(recs('deal').filter((d) => isLost(d) && str(d.p.competitor) === optionValue('deal', 'competitor', 'Tulip')), 'deal', 10) },
  { template: 'deals-lost-to-competitor', q: 'List the deals lost to Cognite', expect: () => listOf(recs('deal').filter((d) => isLost(d) && str(d.p.competitor) === optionValue('deal', 'competitor', 'Cognite')), 'deal', 10) },
  { template: 'count-deals-lost-to-competitor', q: 'How many deals did we lose to Tulip?', expect: () => countRows(recs('deal').filter((d) => isLost(d) && str(d.p.competitor) === optionValue('deal', 'competitor', 'Tulip'))) },
  { template: 'count-deals-lost-to-competitor', q: 'How many deals were lost to Sight Machine?', expect: () => countRows(recs('deal').filter((d) => isLost(d) && str(d.p.competitor) === optionValue('deal', 'competitor', 'Sight Machine'))) },
  { template: 'deals-in-forecast-category', q: 'Which deals are in the Commit forecast category?', expect: () => listOf(recs('deal').filter((d) => isOpen(d) && str(d.p.forecast_category) === optionValue('deal', 'forecast_category', 'Commit')), 'deal', 10) },
  { template: 'deals-in-forecast-category', q: 'Show me the open deals in Best case', expect: () => listOf(recs('deal').filter((d) => isOpen(d) && str(d.p.forecast_category) === optionValue('deal', 'forecast_category', 'Best case')), 'deal', 10) },
  { template: 'pipeline-in-forecast-category', q: 'How much open pipeline is in the Commit forecast category?', expect: () => dealMoney(recs('deal').filter((d) => isOpen(d) && str(d.p.forecast_category) === optionValue('deal', 'forecast_category', 'Commit'))) },
  { template: 'pipeline-in-forecast-category', q: 'What is our pipeline in the Best case category?', expect: () => dealMoney(recs('deal').filter((d) => isOpen(d) && str(d.p.forecast_category) === optionValue('deal', 'forecast_category', 'Best case'))) },
  { template: 'deals-with-term', q: 'How many deals have a 36-month contract term?', expect: () => countRows(recs('deal').filter((d) => num(d.p.contract_term_months) === 36), [36]) },
  { template: 'deals-with-term', q: 'How many deals are on a 12 month contract?', expect: () => countRows(recs('deal').filter((d) => num(d.p.contract_term_months) === 12), [12]) },
  { template: 'objects-missing-property', q: 'Which deals have no next step?', expect: () => listOf(recs('deal').filter((d) => !str(d.p.next_step)), 'deal', 10) },
  { template: 'objects-missing-property', q: 'Which contacts are missing an email?', expect: () => listOf(recs('contact').filter((c) => !str(c.p.email)), 'contact', 10) },
  { template: 'count-objects-missing-property', q: 'How many deals have no next step?', expect: () => countRows(recs('deal').filter((d) => !str(d.p.next_step))) },
  { template: 'count-objects-missing-property', q: 'How many companies lack a domain?', expect: () => countRows(recs('company').filter((c) => !str(c.p.domain))) },
  { template: 'average-property', q: 'What is the average amount of open deals?', expect: () => { const open = recs('deal').filter(isOpen); const avg = total(open) / open.length; return { figures: [money(avg)], numbers: allow(money(avg), open.length) }; } },
  { template: 'average-property', q: 'What is the total amount of won deals?', expect: () => dealMoney(recs('deal').filter(isWon)) },
  { template: 'count-created-period', q: 'How many tickets were raised in the last 30 days?', expect: (now) => countRows(recs('ticket').filter((t) => inWindow(t.created, LAST_DAYS(now, 30))), [30]) },
  { template: 'count-created-period', q: 'How many calls did we log in Q2 2026?', expect: () => countRows(recs('call').filter((c) => inWindow(c.p.occurred_at, QUARTER(2, 2026))), ['Q2 2026']) },
  { template: 'list-created-period', q: 'Which tickets were raised in the last 30 days?', expect: (now) => listOf(recs('ticket').filter((t) => inWindow(t.created, LAST_DAYS(now, 30))), 'ticket', 10, [30]) },
  { template: 'list-created-period', q: 'List the deals created in 2026', expect: () => listOf(recs('deal').filter((d) => inWindow(d.created, YEAR(2026))), 'deal', 10, [2026]) },
  { template: 'count-new-customers-period', q: 'How many new customers did we add in 2025?', expect: () => countRows(recs('company').filter((c) => str(c.p.type) === 'customer' && inWindow(c.p.became_customer_at, YEAR(2025))), [2025]) },
  { template: 'count-new-customers-period', q: 'How many new logos came on in Q2 2026?', expect: () => countRows(recs('company').filter((c) => str(c.p.type) === 'customer' && inWindow(c.p.became_customer_at, QUARTER(2, 2026))), ['Q2 2026']) },

  /* ---------------------------------- drafts --------------------------------- */
  { template: 'draft-message', q: `Draft a check-in email to ${ACONCAGUA}`, expect: (now) => ({ figures: [/^Subject: /, ACONCAGUA], numbers: allow(...accountUniverse(byName('company', ACONCAGUA), now)) }) },
  { template: 'draft-message', q: `Write a formal renewal email to ${KESTREL}`, expect: (now) => ({ figures: [/^Subject: /, KESTREL, /^Dear /m], numbers: allow(...accountUniverse(byName('company', KESTREL), now)) }) },

  /* ---------------------------------- writes --------------------------------- */
  { template: 'write-note', writes: true, q: `Add a note to ${ACONCAGUA} saying "The pilot slipped to October"`, expect: () => pendingWrite('add_note', (body) => {
    assert.deepEqual(body.pending_approvals[0].args.record_ids, [byName('company', ACONCAGUA).id]);
    assert.equal(body.pending_approvals[0].args.body, 'The pilot slipped to October.');
  }) },
  { template: 'write-note', writes: true, q: `Log a note on ${KESTREL}: security review passed`, expect: () => pendingWrite('add_note', (body) => {
    assert.deepEqual(body.pending_approvals[0].args.record_ids, [byName('company', KESTREL).id]);
    assert.equal(body.pending_approvals[0].args.body, 'Security review passed.');
  }) },
  { template: 'write-stage', writes: true, q: `Move ${DEAL_A} to the Negotiation stage`, expect: () => pendingWrite('update_record', (body) => {
    assert.equal(body.pending_approvals[0].args.id, byName('deal', DEAL_A).id);
    assert.deepEqual(body.pending_approvals[0].args.properties, { deal_stage: 'negotiation' });
  }, [DEAL_A]) },
  { template: 'write-stage', writes: true, q: `Mark ${DEAL_B} as Proposal sent`, expect: () => pendingWrite('update_record', (body) => {
    assert.equal(body.pending_approvals[0].args.id, byName('deal', DEAL_B).id);
    assert.deepEqual(body.pending_approvals[0].args.properties, { deal_stage: 'proposal' });
  }, [DEAL_B]) },
  { template: 'write-followup', writes: true, q: `Schedule a follow up on ${ACONCAGUA} in 7 days saying "Chase the signed MSA"`, expect: () => pendingWrite('schedule_followup', (body) => {
    assert.equal(body.pending_approvals[0].args.record_id, byName('company', ACONCAGUA).id);
    assert.equal(body.pending_approvals[0].args.in_days, 7);
    assert.equal(body.pending_approvals[0].args.note, 'Chase the signed MSA.');
  }, [7]) },
  { template: 'write-followup', writes: true, q: `Remind me in 14 days about ${KESTREL} to send the revised quote`, expect: () => pendingWrite('schedule_followup', (body) => {
    assert.equal(body.pending_approvals[0].args.record_id, byName('company', KESTREL).id);
    assert.equal(body.pending_approvals[0].args.in_days, 14);
    assert.equal(body.pending_approvals[0].args.note, 'Send the revised quote.');
  }, [14]) },
];

/* ----------------------------- the corpus test ------------------------------ */

async function runRow(row: CorpusRow): Promise<void> {
  tick();
  const now = app.ctx.now();
  const q = typeof row.q === 'function' ? row.q() : row.q;
  const expected = await row.expect(now);
  const body = await ask(q, row.writes ? { allow_writes: true } : {});
  const analysis = body.analysis;
  assert.equal(analysis.refusal, null, `"${q}" was refused (${analysis.refusal?.code}): ${analysis.refusal?.why}\n${body.content}`);
  assert.equal(analysis.template?.id, row.template, `"${q}" matched ${analysis.template?.id}, not ${row.template}:\n${body.content}`);
  for (const figure of expected.figures) {
    const held = figure instanceof RegExp ? figure.test(body.content) : body.content.includes(figure);
    assert.ok(held, `"${q}" does not state ${figure}:\n${body.content}`);
  }
  assertOnlyTheseNumbers(body.content, expected.numbers, `"${q}" (${row.template})`);
  if (expected.ids) {
    for (const citation of body.citations as { id: string; label: string }[]) {
      assert.ok(expected.ids.has(citation.id), `"${q}" cites ${citation.label} (${citation.id}), which the question did not name`);
    }
  }
  expected.also?.(body);
}

describe('every template answers its published example and a paraphrase inside the slot canon, with the figure the database holds and no other', () => {
  for (const row of CORPUS) {
    test(`${row.template} — "${typeof row.q === 'function' ? row.q.toString().replace(/^\(\) => /, '') : row.q}"`, () => runRow(row));
  }

  test('the corpus covers every template the workspace publishes, twice', async () => {
    const published = await app.handle({ method: 'GET', path: '/v1/ai/templates', auth: DANA });
    assert.equal(published.status, 200);
    const ids = (published.body.data as { id: string; available: boolean }[]).map((t) => t.id);
    const counts = new Map<string, number>();
    for (const row of CORPUS) counts.set(row.template, (counts.get(row.template) ?? 0) + 1);
    for (const id of ids) assert.ok((counts.get(id) ?? 0) >= 2, `${id} has ${counts.get(id) ?? 0} phrasings in the corpus`);
    for (const id of counts.keys()) assert.ok(ids.includes(id), `the corpus names ${id}, which the workspace does not publish`);
    assert.ok(published.body.data.every((t: { available: boolean }) => t.available), 'every template is reachable with the demo tools registered');
  });
});

/* --------------------------- every published example ------------------------ */

describe('every published example is a question the engine answers, on its own template', () => {
  test('the catalogue is self-consistent', async () => {
    const published = await app.handle({ method: 'GET', path: '/v1/ai/templates', auth: DANA });
    const failures: string[] = [];
    for (const t of published.body.data as { id: string; kind: string; example: string | null }[]) {
      assert.ok(t.example, `${t.id} publishes no example for this workspace`);
      tick();
      const body = await ask(t.example!, t.kind === 'write' ? { allow_writes: true } : {});
      if (body.analysis.refusal) failures.push(`${t.id}: "${t.example}" refused — ${body.analysis.refusal.why}`);
      else if (body.analysis.template?.id !== t.id) failures.push(`${t.id}: "${t.example}" matched ${body.analysis.template?.id}`);
      else if (t.kind === 'write' && body.pending_approvals.length !== 1) failures.push(`${t.id}: "${t.example}" prepared ${body.pending_approvals.length} writes`);
    }
    assert.deepEqual(failures, []);
  });
});

/* ----------------------------- every pattern --------------------------------- */

/**
 * A question built from a pattern's own words and one sample per slot has to
 * reach that pattern. A pattern no sentence can match — a colon the tokeniser
 * strips, a slot nested inside an alternation — is a shape the catalogue
 * publishes and never answers.
 */
const SLOT_SAMPLES: Record<string, string> = {
  object: 'deals', 'activity-object': 'meetings', state: 'open', 'deal-state': 'open', 'ticket-state': 'open',
  stage: 'negotiation', pipeline: 'renewal', 'snapshot-metric': 'open pipeline', 'period-metric': 'revenue', 'rank-metric': 'revenue',
  'ownable-metric': 'open pipeline', 'ledger-snapshot-metric': 'mrr', 'ledger-period-metric': 'revenue', period: 'in 2025', currency: 'eur',
  owner: 'dana whitfield', plan: 'growth', 'subscription-status': 'active', 'invoice-status': 'open', money: '$500,000', comparator: 'more than',
  number: '5', account: MERIDIAN, contact: 'Andrés Peralta', deal: DEAL_B, record: MERIDIAN, meter: 'telemetry events', superlative: 'biggest',
  most: 'most', dimension: 'account', industry: 'automotive', 'lead-source': 'webinar', competitor: 'tulip', 'forecast-category': 'commit',
  region: 'apac', property: 'next step', 'numeric-property': 'amount', 'property-dim': 'stage', 'draft-kind': 'check in email', tone: 'warm',
  text: 'the pilot slipped to october', quantity: '2 million', 'book-verb': 'book',
};
/** Where a template's own check needs a different word for a slot. */
const SLOT_OVERRIDES: Record<string, Record<string, string>> = {
  'count-metric': { 'snapshot-metric': 'connected assets' },
  'metric-currency-period': { 'book-verb': 'invoice' },
  'deals-decided-period': { 'book-verb': 'win', 'deal-state': 'won' },
  'count-deals-decided-period': { 'book-verb': 'win', 'deal-state': 'won' },
  'owner-deals-decided-period': { 'book-verb': 'win', 'deal-state': 'won' },
  'deals-with-term': { number: '36' },
  'stale-accounts-days': { number: '60' },
  'write-followup': { number: '7' },
  'compare-metric': { period: 'in 2025' },
};
const NAMED_SAMPLES: Record<string, string> = { b: '2024', note: ': the pilot slipped to october' };

function sentenceFor(templateId: string, pattern: string): string {
  const words: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === ' ') { i++; continue; }
    if (ch === '{') {
      const end = pattern.indexOf('}', i);
      const [name, kind] = pattern.slice(i + 1, end).split(':');
      const slot = kind ?? name;
      words.push(NAMED_SAMPLES[name] ?? SLOT_OVERRIDES[templateId]?.[slot] ?? SLOT_SAMPLES[slot] ?? assert.fail(`no sample for slot ${slot}`));
      i = end + 1;
      continue;
    }
    if (ch === '(') {
      const end = pattern.indexOf(')', i);
      const first = pattern.slice(i + 1, end).split('|')[0].trim();
      if (first) words.push(first);
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < pattern.length && pattern[j] !== ' ') j++;
    words.push(pattern.slice(i, j));
    i = j;
  }
  return words.join(' ').replace(/\s+:/g, ':');
}

describe('every pattern of every template is reachable by a sentence built from its own words', () => {
  test('no published shape is dead', async () => {
    const published = await app.handle({ method: 'GET', path: '/v1/ai/templates', auth: DANA });
    const failures: string[] = [];
    for (const t of published.body.data as { id: string; kind: string; patterns: string[] }[]) {
      for (const pattern of t.patterns) {
        const q = sentenceFor(t.id, pattern);
        tick();
        const body = await ask(q, t.kind === 'write' ? { allow_writes: true } : {});
        if (body.analysis.refusal) failures.push(`${t.id} «${pattern}» → "${q}" refused: ${body.analysis.refusal.why}`);
        else if (body.analysis.template?.id !== t.id) failures.push(`${t.id} «${pattern}» → "${q}" matched ${body.analysis.template?.id}`);
      }
    }
    assert.deepEqual(failures, []);
  });
});

/* -------------------------- every value of a dimension ---------------------- */

describe('every value this workspace enumerates is answered as itself', () => {
  test('every company is answerable by its own name', async () => {
    for (const c of recs('company')) {
      tick();
      const body = await ask(`Who owns ${c.name}?`);
      assert.equal(body.analysis.template?.id, 'account-owner', `"${c.name}": ${body.analysis.refusal?.why ?? body.content}`);
      assert.ok(body.content.includes(c.owner ? ownerName(c.owner) : 'no owner'), `${c.name}:\n${body.content}`);
      assertOnlyTheseNumbers(body.content, allow(c.name), c.name);
    }
  });

  test('every stage label this workspace stores counts the deals at that stage', async () => {
    const labels = [...new Set(app.db.all<{ label: string }>(`SELECT label FROM crm_pipeline_stages WHERE org_id = ? AND object_type = 'deal'`, ORG).map((r) => r.label))];
    for (const label of labels) {
      tick();
      const expected = countRows(dealsAtStage(label));
      const body = await ask(`How many deals are at the ${label} stage?`);
      assert.equal(body.analysis.template?.id, 'count-deals-at-stage', `"${label}": ${body.analysis.refusal?.why ?? body.content}`);
      for (const figure of expected.figures) assert.ok(figure instanceof RegExp && figure.test(body.content), `${label}:\n${body.content}`);
      assertOnlyTheseNumbers(body.content, expected.numbers, label);
    }
  });

  test('every ticket status is counted as itself', async () => {
    for (const option of options('ticket', 'status')) {
      tick();
      const rows = recs('ticket').filter((t) => str(t.p.status) === option.value);
      const body = await ask(`How many tickets are ${option.label.toLowerCase()}?`);
      assert.equal(body.analysis.template?.id, 'count-state-objects', `"${option.label}": ${body.analysis.refusal?.why ?? body.content}`);
      assert.ok(countOf(rows.length).figures[0] instanceof RegExp && (countOf(rows.length).figures[0] as RegExp).test(body.content), `${option.label}:\n${body.content}`);
      assertOnlyTheseNumbers(body.content, allow(rows.length), option.label);
    }
  });

  test('every industry, region, lead source, competitor and forecast category is answered in its own scope', async () => {
    for (const option of options('company', 'industry')) {
      tick();
      const rows = recs('company').filter((c) => str(c.p.industry) === option.value);
      const body = await ask(`How many companies are in the ${option.label.toLowerCase()} industry?`);
      assert.equal(body.analysis.template?.id, 'count-companies-in-industry', `${option.label}: ${body.analysis.refusal?.why ?? body.content}`);
      assertOnlyTheseNumbers(body.content, allow(rows.length), option.label);
      assert.ok((rows.length ? countRe(rows.length) : NONE).test(body.content), `${option.label}:\n${body.content}`);
    }
    for (const option of options('company', 'region')) {
      tick();
      const rows = recs('company').filter((c) => str(c.p.region) === option.value);
      const body = await ask(`Which companies are in ${option.label}?`);
      assert.equal(body.analysis.template?.id, 'companies-in-region', `${option.label}: ${body.analysis.refusal?.why ?? body.content}`);
      const expected = listOf(rows, 'company', 25);
      assertOnlyTheseNumbers(body.content, expected.numbers, option.label);
      expected.also?.(body);
    }
    for (const option of options('deal', 'lead_source')) {
      tick();
      const rows = recs('deal').filter((d) => str(d.p.lead_source) === option.value);
      const body = await ask(`How many deals came from ${option.label.toLowerCase()}?`);
      assert.equal(body.analysis.template?.id, 'count-deals-from-source', `${option.label}: ${body.analysis.refusal?.why ?? body.content}`);
      assertOnlyTheseNumbers(body.content, allow(rows.length), option.label);
      assert.ok((rows.length ? countRe(rows.length) : NONE).test(body.content), `${option.label}:\n${body.content}`);
    }
    for (const option of options('deal', 'competitor').filter((o) => o.value !== 'none')) {
      tick();
      const rows = recs('deal').filter((d) => isLost(d) && str(d.p.competitor) === option.value);
      const body = await ask(`How many deals did we lose to ${option.label}?`);
      assert.equal(body.analysis.template?.id, 'count-deals-lost-to-competitor', `${option.label}: ${body.analysis.refusal?.why ?? body.content}`);
      assertOnlyTheseNumbers(body.content, allow(rows.length), option.label);
      assert.ok((rows.length ? countRe(rows.length) : NONE).test(body.content), `${option.label}:\n${body.content}`);
    }
    for (const option of options('deal', 'forecast_category')) {
      tick();
      const rows = recs('deal').filter((d) => isOpen(d) && str(d.p.forecast_category) === option.value);
      const body = await ask(`How much open pipeline is in the ${option.label} forecast category?`);
      assert.equal(body.analysis.template?.id, 'pipeline-in-forecast-category', `${option.label}: ${body.analysis.refusal?.why ?? body.content}`);
      assertOnlyTheseNumbers(body.content, allow(money(total(rows)), rows.length), option.label);
      assert.ok(body.content.includes(money(total(rows))), `${option.label}:\n${body.content}`);
    }
  });

  test('every teammate, plan and meter is answered as itself', async () => {
    for (const [id, name] of people()) {
      tick();
      const rows = recs('deal').filter((d) => d.owner === id && isOpen(d));
      const body = await ask(`How many open deals does ${name} own?`);
      assert.equal(body.analysis.template?.id, 'count-owner-objects', `${name}: ${body.analysis.refusal?.why ?? body.content}`);
      assertOnlyTheseNumbers(body.content, allow(rows.length), name);
      assert.ok((rows.length ? countRe(rows.length) : NONE).test(body.content), `${name}:\n${body.content}`);
    }
    for (const product of app.db.all<{ id: string; name: string }>(`SELECT id, name FROM catalog_products WHERE org_id = ?`, ORG)) {
      tick();
      const on = subscriptionsOn(product.id);
      const body = await ask(`How many subscriptions are on the ${product.name} plan?`);
      assert.equal(body.analysis.template?.id, 'count-subscriptions-on-plan', `${product.name}: ${body.analysis.refusal?.why ?? body.content}`);
      assertOnlyTheseNumbers(body.content, allow(on.ids.length, product.name), product.name);
      assert.ok((on.ids.length ? countRe(on.ids.length) : NONE).test(body.content), `${product.name}:\n${body.content}`);
    }
    for (const meter of app.db.all<{ id: string; name: string; aggregation: string; unit_label: string | null }>(`SELECT id, name, aggregation, unit_label FROM meters WHERE org_id = ?`, ORG)) {
      tick();
      const now = app.ctx.now();
      const rows = await meterRows(meter.id, LAST_DAYS(now, 30));
      const value = meterTotal(rows, meter.aggregation);
      const body = await ask(`How much ${meter.name.toLowerCase()} did we meter in the last 30 days?`);
      assert.equal(body.analysis.template?.id, 'metered-usage', `${meter.name}: ${body.analysis.refusal?.why ?? body.content}`);
      assertOnlyTheseNumbers(body.content, allow(30, rows.length, rows.length ? units(value, meter.unit_label) : ''), meter.name);
      if (rows.length) assert.ok(body.content.includes(units(value, meter.unit_label)), `${meter.name}:\n${body.content}`);
    }
  });
});

/* ------------------------------- near-misses -------------------------------- */

/**
 * Each of these is one word away from a shape the engine answers, and each
 * must be refused: a slot word that binds nothing, a period a shape needs and
 * the sentence omits, a synonym outside the canon, a bare number, a snapshot
 * asked "in total", a competitor on no deal, a company where an owner belongs,
 * a measure that does not exist, a future period on a measure of the past.
 */
const NEAR_MISSES: string[] = [
  // a slot word that should not bind
  'Which subscriptions are on the Platinum plan?',
  'How many deals are at the Handshake stage?',
  'What is the Partnerships pipeline worth?',
  'Who owns Acme Corp?',
  'How many deals did Bob Smith win in 2025?',
  'What is our MRR in CHF?',
  'Which companies are in the retail industry?',
  'Which deals came from billboards?',
  'How many carrier pigeons did we meter in 2025?',
  'Which companies are in Antarctica?',
  'Which deals are in the Maybe forecast category?',
  'How many deals are in the Renewal stage?',
  'What is the Negotiation pipeline worth?',
  'What is the pipeline worth?',
  'Move Aconcagua Alimentos to the Negotiation stage',
  'Draft a check-in email to Aconcagua Alimentos — pilot expansion to 3 lines',
  'How much would 50 million anomaly alerts raised cost?',
  // a period omitted from a template that needs one
  'What was our revenue?',
  'How much did we book?',
  'How many deals did we win?',
  'How much did Dana Whitfield book?',
  'Which deals did we win?',
  'How many stored telemetry did we meter?',
  'How much did Aconcagua Alimentos spend?',
  'Who booked the most?',
  "What was Dana Whitfield's win rate?",
  'How many invoices did we issue?',
  'How many new customers did we add?',
  'What was our win rate by owner?',
  'How many deals closed the week before last?',
  'Which deals close between 2026-12-31 and 2026-01-01?',
  // a synonym outside the canon
  'How many deals are in the Negotiation phase?',
  'What is our open pipeline by team?',
  'How many opportunities are pending?',
  'Which tickets are broken?',
  'How much did we earn in 2025?',
  'What was our turnover in 2025?',
  'What were our sales in 2025?',
  'Which deals are stalled?',
  'How many deals are unresolved?',
  'Which accounts have had no activity in 60 weeks?',
  'How many telemetry did we meter in 2025?',
  // a bare number with no comparator
  'How many deals are worth $500,000?',
  'Which open deals are $1m?',
  'How many deals are worth 500000?',
  'Which deals are worth more than?',
  // "our customers"
  'Who are our customers?',
  'List our customers',
  'Show me our customers',
  // "in total" on a snapshot
  'What is our ARR in total?',
  'What is our open pipeline in total?',
  'How much MRR do we have in total?',
  // a competitor that appears on no deal
  'Which deals did we lose to Rockwell?',
  'How many deals did we lose to Siemens?',
  // a company name, or a contact, where an owner belongs
  'How much open pipeline does Calder & Vance Manufacturing own?',
  'How many deals did Ferrante Meccanica win in 2025?',
  'How many open deals does Carmen Escamilla own?',
  'How much pipeline do Dana and Marcus own?',
  // a metric that does not exist
  'What is our burn rate?',
  'What was our EBITDA in 2025?',
  'What is our NPS?',
  'What was our gross margin in 2025?',
  'What is our CAC right now?',
  'What is our win rate by account in 2025?',
  "What is Aconcagua Alimentos's win rate?",
  // a forward period on a backward-only metric
  'What was our revenue in the next 30 days?',
  'How much did we book in the next 90 days?',
  'How many invoices did we issue next quarter?',
  'Who booked the most next year?',
  'How much did Aconcagua Alimentos spend in the next 30 days?',
  'How many tickets were raised in 2027?',
  // the first person on a measure nobody owns, and a measure word that is also an object
  'What is my ARR?',
  'Who is my biggest customer?',
  'How many deals have we got?',
];

describe('a near-miss is refused with three questions that can be answered', () => {
  test('there are at least sixty of them', () => assert.ok(NEAR_MISSES.length >= 60, `${NEAR_MISSES.length} near-misses`));

  for (const q of NEAR_MISSES) {
    test(`refuses "${q}"`, async () => {
      tick();
      const body = await ask(q, { allow_writes: true });
      const analysis = body.analysis;
      assert.equal(analysis.engine, 'template');
      assert.ok(analysis.refusal, `"${q}" was answered as ${analysis.template?.id}:\n${body.content}`);
      assert.equal(analysis.template, null);
      assert.deepEqual(body.tool_calls, [], 'a refusal runs no tool');
      assert.deepEqual(body.pending_approvals, [], 'a refusal prepares no write');
      assert.equal(analysis.nearest.length, 3, `${analysis.nearest.length} nearest shapes offered`);
      // The only numbers a refusal may print are the reader's own, those in the
      // questions it offers instead, and those in its reason — "Q4 2026 has not
      // started yet" names the period it is refusing, and that is not a claim.
      assertOnlyTheseNumbers(body.content, allow(q, analysis.refusal?.why ?? '', ...analysis.nearest.map((t: { example: string }) => t.example)), `refusing "${q}"`);
      for (const near of analysis.nearest) assert.ok(body.content.includes(near.example), `the refusal offers ${near.example}`);

      let answered: string | null = null;
      for (const near of analysis.nearest as { id: string; example: string }[]) {
        tick();
        const offered = await ask(near.example, { allow_writes: true });
        const write = offered.analysis.template?.kind === 'write';
        if (!offered.analysis.refusal && offered.analysis.template?.id === near.id && (!write || offered.pending_approvals.length === 1)) { answered = near.example; break; }
      }
      assert.ok(answered, `none of the three questions offered instead of "${q}" can be answered: ${analysis.nearest.map((t: { example: string }) => t.example).join(' | ')}`);
    });
  }
});

/* ---------------------- the properties over everything --------------------- */

const RAW_ID = /\b(?:cmp|con|deal|tkt|cus|note|task|act|inv|in|sub|usr|prod|price|mtr|thr|run|appr|agentrun|trc|call)_[A-Za-z0-9][A-Za-z0-9_]{2,}\b/;
const TOOL_NAME = /\b(?:record_aggregate|record_search|business_metric|account_profile|metered_usage|delinquent_customers|subscriptions_on_plan|stale_accounts|record_timeline|compose_message|add_note|update_record|schedule_followup|get_record|catalog_list_products|catalog_quote_price|billing_list_subscriptions|billing_list_invoices|workspace_search)\b/;

describe('the property that matters, over both corpora', () => {
  test('the corpus was asked', () => assert.ok(asked.length > CORPUS.length + NEAR_MISSES.length, `${asked.length} completions collected`));

  test('no answer prints a database id, a tool name, a placeholder, a year twice, or the same sentence twice', () => {
    for (const { q, body } of asked) {
      const content = String(body.content);
      assert.doesNotMatch(content, RAW_ID, `"${q}" prints a primary key:\n${content}`);
      assert.doesNotMatch(content, TOOL_NAME, `"${q}" prints a tool name:\n${content}`);
      assert.doesNotMatch(content, /\[object Object\]|\bundefined\b|\bNaN\b|\bnull\b/, `"${q}" prints a placeholder:\n${content}`);
      assert.doesNotMatch(content, /\b(20\d\d) \1\b/, `"${q}" prints a year twice:\n${content}`);
      const prose = content.split('\n').map((line) => line.trim()).filter((line) => line && !/^(•|\d+\.)/.test(line));
      assert.equal(new Set(prose).size, prose.length, `"${q}" states the same thing twice:\n${content}`);
      for (const citation of body.citations as { id: string; label: string }[]) {
        assert.notEqual(citation.label, citation.id, `"${q}" cites ${citation.id} by its id`);
        assert.doesNotMatch(citation.label, RAW_ID, `"${q}" cites a primary key as a label`);
      }
    }
  });

  test('no tool is ever called with the question in its arguments', () => {
    for (const { q, body } of asked) {
      for (const span of body.trace as { kind: string; name: string; args: unknown }[]) {
        if (span.kind !== 'tool') continue;
        assert.ok(!JSON.stringify(span.args ?? {}).toLowerCase().includes(q.toLowerCase()), `"${q}" reached ${span.name} as an argument`);
      }
    }
  });

  test('every run is stored with an ordered trace that agrees with the answer', async () => {
    for (const { q, body } of asked.slice(-40)) {
      const run = await app.handle({ method: 'GET', path: `/v1/ai/runs/${body.run_id}`, auth: DANA });
      assert.equal(run.status, 200, `"${q}": run ${body.run_id} is not stored`);
      const seqs = run.body.trace.map((s: { seq: number }) => s.seq);
      assert.deepEqual(seqs, seqs.map((_: number, i: number) => i + 1), `"${q}": spans are not in order`);
      assert.equal(run.body.answer, body.content, `"${q}": the stored answer differs from the one returned`);
      assert.equal(run.body.provider, 'builtin');
      assert.equal(run.body.model, ENGINE_MODEL);
    }
  });
});

describe('with no ANTHROPIC_API_KEY there is one answer path', () => {
  test('the workspace reports the template engine', async () => {
    const status = await app.handle({ method: 'GET', path: '/v1/ai/status', auth: DANA });
    assert.equal(status.status, 200);
    assert.equal(status.body.engine, 'template');
    assert.equal(status.body.provider.id, 'builtin');
    assert.equal(status.body.provider.hosted, false);
    assert.equal(status.body.templates, (await app.handle({ method: 'GET', path: '/v1/ai/templates', auth: DANA })).body.data.length);
  });

  test('every non-refusal names its template in its analysis and on its trace, and nothing else answered', () => {
    for (const { q, body } of asked) {
      assert.equal(body.provider, 'builtin', `"${q}" was answered by ${body.provider}`);
      assert.equal(body.model, ENGINE_MODEL, `"${q}" was answered by ${body.model}`);
      assert.equal(body.degraded, null, `"${q}" was degraded`);
      assert.equal(body.analysis.engine, 'template', `"${q}" has no template analysis`);
      if (body.analysis.refusal) { assert.equal(body.analysis.template, null, `"${q}" was refused with a template`); continue; }
      const id = body.analysis.template?.id;
      assert.ok(id, `"${q}" was answered without a template`);
      const planned = (body.trace as { kind: string; name: string; summary: string }[]).find((s) => s.kind === 'plan' && s.name === 'match_template');
      assert.ok(planned && planned.summary.startsWith(`${id} —`), `"${q}" has no template match on its trace: ${JSON.stringify(planned)}`);
      assert.ok((body.reasoning as string[]).some((line) => line.includes(`Matched "${id}"`)), `"${q}" does not say which shape it matched`);
    }
  });
});
