/**
 * The revenue screens' own arithmetic: what the board draws, what it exports,
 * what the usage table says about a quiet meter, how the recognition screen
 * rolls a balance forward and what a unit pot is worth.
 *
 * Every function here is pure and runs without a browser. Each case hands the
 * code a row exactly as the API returns it and checks the screen's answer
 * against the API's own reconciliation — the calculator check a finance lead
 * does by hand, done by the test instead.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { csvAmount, toCsv } from '../src/client/modules/revenue/csv';
import {
  INFLOW_KINDS, MOVER_TONE, NOTHING_MOVED, OUTFLOW_KINDS, monthMoved, movementCsv, moverDelta, walkedClosing, waterfallOf,
} from '../src/client/modules/revenue/movement';
import type { MovementMonth } from '../src/client/modules/revenue/types';

/* ------------------------------- fixtures --------------------------------- */

/** A month as `GET /v1/revenue/movement` returns it, with every class present. */
const month = (over: Partial<MovementMonth> = {}): MovementMonth => ({
  month: '2026-09',
  period: { start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 9, 1) },
  complete: false,
  currency: 'usd',
  opening: 3_897_266,
  new_business: 0,
  expansion: 0,
  reactivation: 0,
  resumed: 0,
  contraction: 0,
  churn: 0,
  paused: 0,
  net: 0,
  closing: 3_897_266,
  counts: {
    accounts_at_open: 17, accounts_at_close: 17, new_accounts: 0, reactivated_accounts: 0, expanded_accounts: 0,
    contracted_accounts: 0, churned_accounts: 0, paused_accounts: 0, resumed_accounts: 0,
  },
  top_movers: [],
  reconciliation: { computed_closing: 3_897_266, reported_closing: 3_897_266, difference: 0, balanced: true, note: null },
  ...over,
});

/** Sep 2026 on the day the critic read it: one $99.00 pause, nothing else. */
const pausedOnly = month({
  paused: 9_900, net: -9_900, closing: 3_887_366,
  counts: { ...month().counts, paused_accounts: 1 },
  top_movers: [{ customer: 'cus_HN5Zet72cQ387yjT', kind: 'paused', amount: -9_900, currency: 'usd', name: 'Cobalt Line Automation', from: 9_900, to: 0 }],
  reconciliation: { computed_closing: 3_887_366, reported_closing: 3_887_366, difference: 0, balanced: true, note: null },
});

/** Sep 2026 after +45 days: new business, a contraction and the same pause. */
const busy = month({
  new_business: 309_700, contraction: 235_600, paused: 9_900, net: 64_200, closing: 3_961_466,
  reconciliation: { computed_closing: 3_961_466, reported_closing: 3_961_466, difference: 0, balanced: true, note: null },
});

/** Oct 2026 after +45 days: the pause resumed. */
const resumedOnly = month({
  month: '2026-10', opening: 3_961_466, resumed: 9_900, net: 9_900, closing: 3_971_366,
  top_movers: [{ customer: 'cus_HN5Zet72cQ387yjT', kind: 'resumed', amount: 9_900, currency: 'usd', name: 'Cobalt Line Automation', from: 0, to: 9_900 }],
  reconciliation: { computed_closing: 3_971_366, reported_closing: 3_971_366, difference: 0, balanced: true, note: null },
});

/* ------------------------------- waterfall -------------------------------- */

describe('the MRR waterfall', () => {
  it('walks every classified movement, so the steps land on the Closing bar', () => {
    for (const row of [pausedOnly, busy, resumedOnly]) {
      const bars = waterfallOf(row);
      const deltas = bars.filter((bar) => bar.kind !== 'total');
      const walked = (row.opening ?? 0) + deltas.reduce((sum, bar) => sum + bar.value, 0);
      assert.equal(walked, row.closing, `${row.month}: the drawn steps end at ${walked}, the Closing bar is ${row.closing}`);
      assert.equal(walkedClosing(row), row.reconciliation.computed_closing);
    }
  });

  it('draws a pause and a resumption as bars of their own, with the sign of the movement', () => {
    const bars = Object.fromEntries(waterfallOf(busy).map((bar) => [bar.label, bar.value]));
    assert.equal(bars.Paused, -9_900);
    assert.equal(bars.Resumed, 0);
    assert.equal(bars.Contraction, -235_600);
    assert.equal(Object.fromEntries(waterfallOf(resumedOnly).map((bar) => [bar.label, bar.value])).Resumed, 9_900);
    // Every class the API names has a bar, inflows before outflows, totals at both ends.
    const labels = waterfallOf(busy).map((bar) => bar.label);
    assert.deepEqual(labels, ['Opening', 'New', 'Expansion', 'Reactivation', 'Resumed', 'Contraction', 'Churn', 'Paused', 'Closing']);
    assert.equal(INFLOW_KINDS.length + OUTFLOW_KINDS.length, labels.length - 2);
  });

  it('never labels an empty outflow bar "-$0"', () => {
    for (const bar of waterfallOf(month())) assert.ok(!Object.is(bar.value, -0), `${bar.label} is negative zero`);
  });
});

/* ------------------------------ nothing moved ----------------------------- */

describe('the "nothing moved" banner', () => {
  it('is not shown for a month in which an account paused or resumed', () => {
    assert.equal(monthMoved(pausedOnly), true, 'a $99.00 pause is a movement');
    assert.equal(monthMoved(resumedOnly), true, 'a $99.00 resumption is a movement');
    assert.equal(monthMoved(busy), true);
  });

  it('is shown only when every class is zero, and says what it checked', () => {
    assert.equal(monthMoved(month()), false);
    assert.match(NOTHING_MOVED, /paused/);
    assert.match(NOTHING_MOVED, /resumed/);
  });
});

/* -------------------------------- the table ------------------------------- */

describe('the movement export', () => {
  it('carries Paused and Resumed columns, and the classes add up to Net', () => {
    const columns = movementCsv('usd');
    const headers = columns.map((column) => column.header);
    assert.ok(headers.includes('Paused'), `no Paused column in ${headers.join(', ')}`);
    assert.ok(headers.includes('Resumed'), `no Resumed column in ${headers.join(', ')}`);

    const cell = (row: MovementMonth, header: string) => Number(columns[headers.indexOf(header)].value(row));
    for (const row of [pausedOnly, busy, resumedOnly]) {
      const summed = ['New', 'Expansion', 'Reactivation', 'Resumed', 'Contraction', 'Churn', 'Paused']
        .reduce((sum, header) => sum + cell(row, header), 0);
      assert.equal(summed.toFixed(2), cell(row, 'Net').toFixed(2), `${row.month}: the columns sum to ${summed}, Net is ${cell(row, 'Net')}`);
      assert.equal((cell(row, 'Opening') + summed).toFixed(2), cell(row, 'Closing').toFixed(2));
    }
    // Outflows are exported negative, as they are drawn.
    assert.equal(cell(busy, 'Paused'), -99);
    assert.equal(cell(busy, 'Contraction'), -2356);
  });

  it('writes the file with a header row, CRLF line ends and money as a decimal', () => {
    const csv = toCsv([pausedOnly], movementCsv('usd'));
    const [header, row] = csv.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(header.split(',').length, row.split(',').length);
    assert.ok(row.includes(',-99.00,'), row);
    assert.equal(csvAmount(3_887_366, 'usd'), '38873.66');
    assert.equal(csvAmount(null, 'usd'), '');
  });
});

/* -------------------------------- who moved ------------------------------- */

describe('who moved', () => {
  it('signs a pause as an outflow and a resumption as an inflow, whatever sign the API used', () => {
    assert.equal(moverDelta({ kind: 'paused', amount: -9_900 }), -9_900);
    assert.equal(moverDelta({ kind: 'paused', amount: 9_900 }), -9_900);
    assert.equal(moverDelta({ kind: 'resumed', amount: 9_900 }), 9_900);
    assert.equal(moverDelta({ kind: 'contraction', amount: 235_600 }), -235_600);
    assert.equal(moverDelta({ kind: 'churn', amount: -4_900 }), -4_900);
    assert.equal(moverDelta({ kind: 'new', amount: 309_700 }), 309_700);
  });

  it('gives every class a badge tone — a pause is a warning, not a loss', () => {
    for (const kind of [...INFLOW_KINDS, ...OUTFLOW_KINDS]) assert.ok(MOVER_TONE[kind], `${kind} has no tone`);
    assert.equal(MOVER_TONE.paused, 'warning');
    assert.equal(MOVER_TONE.churn, 'danger');
    assert.equal(MOVER_TONE.resumed, 'success');
  });
});

/* ------------------------------ quiet meters ------------------------------ */

import { NEVER_COPY, QUIET_COPY, lastSeen, lastSeenAt } from '../src/client/modules/revenue/meter-copy';

describe('when a meter last saw an event', () => {
  const now = Date.UTC(2026, 9, 19);
  const fiveWeeksAgo = Date.UTC(2026, 8, 4, 14, 1);

  it('never says "Never" about a meter that has streamed — outside the window it says so and names the last event', () => {
    // The overview's 30-day window is empty; the meter's own record is not.
    const seen = lastSeen(null, fiveWeeksAgo, now);
    assert.equal(seen.state, 'quiet');
    assert.equal(lastSeenAt(seen), fiveWeeksAgo);
    assert.match(QUIET_COPY, /30 days/);
    assert.doesNotMatch(QUIET_COPY, /Never/);
  });

  it('says "Never" only when the meter itself has no last event', () => {
    assert.deepEqual(lastSeen(null, null, now), { state: 'never' });
    assert.match(NEVER_COPY, /^Never/);
  });

  it('holds its answer while the meter record is still being read', () => {
    assert.deepEqual(lastSeen(null, undefined, now), { state: 'pending' });
    assert.equal(lastSeenAt(lastSeen(null, undefined, now)), null);
  });

  it('prefers the window when it has an answer, and flags a stall after two silent days', () => {
    const yesterday = now - 86_400_000;
    assert.deepEqual(lastSeen(yesterday, fiveWeeksAgo, now), { state: 'recent', at: yesterday, stalled: false });
    assert.deepEqual(lastSeen(now - 3 * 86_400_000, undefined, now), { state: 'recent', at: now - 3 * 86_400_000, stalled: true });
  });
});

/* ------------------------------ recognition ------------------------------- */

import { CHECK_LABEL, rollForward, scheduleByMonth, scheduleReconciles } from '../src/client/modules/revenue/recognition-math';
import type { DeferredMonth, RecognitionDay } from '../src/client/modules/revenue/types';

/** Two months as `GET /v1/revenue/deferred?currency=usd` returned them on Sep 5, 2026. */
const deferredMonth = (over: Partial<DeferredMonth>): DeferredMonth => ({
  month: '2025-10', period: { start: 0, end: 1 }, complete: true, read_at: 1, in_scope: true, currency: 'usd',
  invoiced: 0, credited: 0, recognised: 0, invoiced_to_date: 0, recognised_to_date: 0, deferred_balance: 0, unbilled_balance: 0,
  ...over,
});
const october = deferredMonth({
  month: '2025-10', invoiced: 1_884_773, credited: 0, recognised: 2_941_246,
  invoiced_to_date: 21_565_260, recognised_to_date: 12_920_848, deferred_balance: 8_644_412,
});
const september = deferredMonth({
  month: '2026-09', complete: false, invoiced: 1_682_100, credited: 0, recognised: 634_106,
  invoiced_to_date: 62_584_460, recognised_to_date: 50_284_614, deferred_balance: 12_299_846, unbilled_balance: 792_278,
});

describe('the deferred balance roll-forward', () => {
  it('re-derives every closing balance from opening + billed − credited − recognised and says when it holds', () => {
    const rows = rollForward([october, september]);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.opening + row.billed - row.credited - row.recognised, row.closing, `${row.month} does not roll forward`);
      assert.equal(row.balanced, true);
      assert.equal(row.difference, 0);
    }
    // The first month of a window has an opening balance too: the cumulative position before it.
    assert.equal(rows[0].opening, 9_700_885);
    assert.equal(rows[1].unbilled, 792_278);
  });

  it('marks a month whose closing is not what the movements give, and by how much', () => {
    const off = deferredMonth({ ...september, deferred_balance: 12_299_846 + 5_000 });
    const [row] = rollForward([off]);
    assert.equal(row.balanced, false);
    assert.equal(row.difference, 5_000);
    assert.equal(row.computed, 12_299_846);
  });

  it('states credit notes as their own leg — billed is gross, and the balance still rolls', () => {
    // A month that billed 10,000 gross, credited 1,000 back and earned 4,000, from an opening of 0.
    const credited = deferredMonth({
      month: '2026-03', invoiced: 9_000, credited: 1_000, recognised: 4_000,
      invoiced_to_date: 9_000, recognised_to_date: 4_000, deferred_balance: 5_000,
    });
    const [row] = rollForward([credited]);
    assert.equal(row.billed, 10_000);
    assert.equal(row.credited, 1_000);
    assert.equal(row.balanced, true);
  });

  it('drops months the report never reached and months with no money to roll', () => {
    assert.equal(rollForward([deferredMonth({ in_scope: false }), deferredMonth({ deferred_balance: null })]).length, 0);
  });

  it('names every check the API publishes', () => {
    for (const name of ['schedule_sums_to_line', 'cursor_matches_filter', 'credits_within_the_lines_they_reduce', 'series_ends_at_totals']) {
      assert.ok(CHECK_LABEL[name], `${name} has no label`);
    }
  });
});

describe('a line’s day-by-day schedule', () => {
  const day = (iso: string, amount: number, recognised: boolean): RecognitionDay => ({
    day: iso, start: Date.parse(iso), end: Date.parse(iso) + 86_400_000, booked_at: Date.parse(iso) + 86_400_000, amount, recognised,
  });
  const days = [
    day('2026-08-30', 100, true), day('2026-08-31', 100, true),
    day('2026-09-01', 100, true), day('2026-09-02', 100, false),
    day('2026-10-01', 100, false),
  ];

  it('folds into months in calendar order, each knowing how much of it has elapsed', () => {
    const months = scheduleByMonth(days);
    assert.deepEqual(months.map((m) => [m.month, m.days, m.recognisedDays, m.amount, m.state]), [
      ['2026-08', 2, 2, 200, 'earned'],
      ['2026-09', 2, 1, 200, 'running'],
      ['2026-10', 1, 0, 100, 'ahead'],
    ]);
  });

  it('adds the days back to the line and the elapsed days back to recognised-to-date', () => {
    const ok = scheduleReconciles(days, { amount: 500, recognised_to_date: 300 });
    assert.deepEqual(ok, { total: 500, recognised: 300, sumsToLine: true, matchesRecognised: true });
    const off = scheduleReconciles(days, { amount: 499, recognised_to_date: 300 });
    assert.equal(off.sumsToLine, false);
  });
});

/* -------------------------------- unit pots ------------------------------- */

import { unitPotValue } from '../src/client/modules/revenue/credit-value';
import type { CreditBillableItem, CreditGrant } from '../src/client/modules/revenue/types';

/** Northwind's grants and top-up lines as the API lists them. */
const grant = (over: Partial<CreditGrant> & { id: string }): CreditGrant => ({
  customer: 'cus_meridian', name: 'Telemetry pack', category: 'paid', kind: 'unit', currency: 'usd', meter: 'mtr_nw_telemetry',
  unit_label: 'event', amount: 5_000_000, balance: 46_031.7056, applicability: { scope: 'all', prices: [], meters: [], products: [] },
  applies_to: 'telemetry', effective_at: 0, expires_at: null, priority: 0, rollover: 'none', rollover_cap: null, status: 'active',
  awaiting_payment: false, source: 'topup', source_ref: 'il_pack', metadata: {}, created: 0, updated: 0, ...over,
});
const purchase = (over: Partial<CreditBillableItem> & { id: string }): CreditBillableItem => ({
  customer: 'cus_meridian', settlement: null, grant: 'credgr_pack', kind: 'topup', description: 'Telemetry pack × 5', currency: 'usd',
  amount: 230_000, billed_amount: 230_000, credit_applied: 0, quantity: 5, unit_label: 'pack', price: 'price_pack', meter: null,
  period_start: null, period_end: null, status: 'invoiced', invoice: 'in_1', created: 0, ...over,
});

describe('what a unit pot is worth', () => {
  it('prices the unused balance of a sold pack at what it was bought for — the refund dialog’s own figure', () => {
    const value = unitPotValue([grant({ id: 'credgr_pack' })], [purchase({ id: 'il_pack' })], 'usd');
    // $2,300.00 for 5,000,000 events, 46,031.7056 left → $21.17.
    assert.deepEqual(value, { pots: 1, priced: 1, unpriced: 0, value: 2_117 });
  });

  it('counts an unsold pot but does not invent a price for it', () => {
    const promo = grant({ id: 'credgr_promo', category: 'promotional', source: 'manual', source_ref: null, amount: 1_000_000, balance: 1_000_000 });
    const value = unitPotValue([grant({ id: 'credgr_pack' }), promo], [purchase({ id: 'il_pack' })], 'usd');
    assert.deepEqual(value, { pots: 2, priced: 1, unpriced: 1, value: 2_117 });
  });

  it('keeps to the book it was asked about: other currencies, monetary grants and spent pots are not counted', () => {
    const gbp = grant({ id: 'credgr_gbp', currency: 'gbp', amount: 4_000_000, balance: 4_000_000, source_ref: 'il_gbp' });
    const monetary = grant({ id: 'credgr_money', kind: 'monetary', source: 'manual', source_ref: null });
    const spent = grant({ id: 'credgr_spent', status: 'expired', balance: 0 });
    const lines = [purchase({ id: 'il_pack' }), purchase({ id: 'il_gbp', currency: 'gbp', amount: 156_000, quantity: 4 })];
    assert.deepEqual(unitPotValue([grant({ id: 'credgr_pack' }), gbp, monetary, spent], lines, 'usd'), { pots: 1, priced: 1, unpriced: 0, value: 2_117 });
    assert.deepEqual(unitPotValue([grant({ id: 'credgr_pack' }), gbp, monetary, spent], lines, 'gbp'), { pots: 1, priced: 1, unpriced: 0, value: 156_000 });
  });
});

/* ------------------------ the drawer offers the write-off ----------------- */

import { readFileSync } from 'node:fs';

describe('the exhausted-campaign drawer', () => {
  const source = readFileSync(new URL('../src/client/modules/revenue/dunning.tsx', import.meta.url), 'utf8');

  it('offers the write-off the advice names, on the bill it names, behind a confirm', () => {
    // The API's advice on an exhausted campaign ends "…or write it off". The
    // instrument for that is the invoice's mark-uncollectible action, which
    // used to live two hops away on another screen's overflow menu.
    assert.match(source, /\/v1\/invoices\/\$\{row\.invoice\}\/mark_uncollectible/);
    assert.match(source, /Write off \$\{moneyIn\(/, 'the button carries the amount it writes off');
    assert.match(source, /title=\{`Write \$\{invoice\.data\.number\} off\?`\}/, 'it asks before it writes anything off');
    // And only while the bill is still open — a paid or written-off bill has nothing to write off.
    assert.match(source, /invoice\.data\?\.status === 'open' && invoice\.data\.amount_due > 0/);
  });

  it('routes the palette’s “needs a person” command at the filter of the same name', () => {
    const routes = readFileSync(new URL('../src/client/modules/revenue/routes.tsx', import.meta.url), 'utf8');
    assert.match(routes, /id: 'revenue\.dunning\.needs_human'[\s\S]*?nav\('\/revenue\/dunning\?status=needs_human'\)/);
    assert.match(source, /'needs_human'/, 'the queue knows the filter the palette sends people to');
  });
});

/* ------------------------------ the burn-down card ------------------------ */

import {
  CHECK_LABEL as USAGE_CHECK_LABEL, CREDIT_WRITE_INVALIDATES, burnDownChart, burnDownFigures, checkPhrases,
  formatReasonDates, movementLabel, shareText, splitReconciles,
} from '../src/client/modules/revenue/credits-math';
import type { RevenueUsage } from '../src/client/modules/revenue/types';

/**
 * `GET /v1/revenue/usage?months=12&currency=usd` on the fresh demo workspace,
 * Sep 5 2026 — the answer the critic read the $0.00 / $0.00 card against.
 * One settlement priced $8,946.35; $950.00 of it drawn from credit; a $73.57
 * withdrawal since; and none of the $7,922.78 owed on a finalised invoice.
 */
const freshUsage = (over: Partial<RevenueUsage['totals']> = {}): RevenueUsage => ({
  as_of: Date.UTC(2026, 8, 5),
  range: { from: Date.UTC(2025, 8, 1), to: Date.UTC(2026, 8, 5), months: 12 },
  currency: 'usd',
  truncated: false,
  warnings: [],
  basis: { currency: { mode: 'single', currencies: ['usd'], note: '' } } as never,
  sources: {} as never,
  series: [{
    month: '2026-09', complete: false, settlements: 1, metered_value: 894_635, credit_covered: 0, charged: 0, unbilled_balance: 792_278,
  }],
  totals: {
    metered_value: 894_635,
    credit_covered: 0,
    charged: 0,
    unbilled: 792_278,
    unbilled_balance: 792_278,
    settled: { credit_covered: 95_000, charged: 799_635, true_ups: -7_357, net_charged: 792_278, invoiced: 0 },
    settlements: 1,
    skipped_settlements: 0,
    invoiced: 42_903_973,
    metered_share_of_invoiced: { bps: 0, numerator: 0, denominator: 42_903_973, percent: '0.00%', undefined_rate: false },
    overage_share_of_invoiced: { bps: 0, numerator: 0, denominator: 42_903_973, percent: '0.00%', undefined_rate: false },
    ...over,
  },
  meters: [],
  credit: {
    flows: [], purchased: 556_000, purchase_lines: 3, burned_against_usage: 0, outstanding_monetary: 280_000, outstanding_unit_micro: 0, grants: 13,
  },
  invoiced_mix: [],
  reconciliation: {
    balanced: true,
    note: null,
    checks: [
      'settlement_components_match', 'invoice_lines_carry_the_settled_amount', 'every_metered_line_has_a_settlement',
      'credit_flow_components_sum_to_movement', 'ledger_agrees_with_its_grants', 'every_grant_kind_is_reported',
    ].map((name) => ({ name, description: '', expected: 0, actual: 0, difference: 0, unit: 'minor', ok: true })),
  },
  balanced: true,
});

describe('the burn-down card', () => {
  it('states the settled split — never the invoiced subset — and what is still awaiting an invoice', () => {
    const figures = burnDownFigures(freshUsage());
    assert.equal(figures.covered, 95_000, 'covered is what credit absorbed when the window was priced, not $0.00');
    assert.equal(figures.charged, 799_635, 'charged is what the settlement priced, not $0.00');
    assert.equal(figures.trueUps, -7_357);
    assert.equal(figures.owed, 792_278);
    assert.equal(figures.invoiced, 0);
    assert.equal(figures.unbilled, 792_278, 'the $7,922.78 recognition calls "earned, not yet billed" is stated here too');
    assert.equal(figures.purchased, 556_000);
    assert.equal(figures.purchaseLines, 3);
  });

  it('checks covered + charged = metered on the figures it prints, and says when that fails', () => {
    assert.equal(splitReconciles(burnDownFigures(freshUsage())), true);
    const broken = freshUsage({ settled: { credit_covered: 95_000, charged: 700_000, true_ups: 0, net_charged: 700_000, invoiced: 0 } });
    assert.equal(splitReconciles(burnDownFigures(broken)), false);
  });

  it('prints a share to two places, as the API prints its own rates, and nothing over a zero', () => {
    assert.equal(shareText(799_635, 894_635), '89.38%');
    assert.equal(shareText(792_278, 894_635), '88.56%', 'the same figure the meter line reads as "charged"');
    assert.equal(shareText(0, 0), null);
  });

  it('refuses to draw an all-zero chart, and says what is awaiting a bill instead', () => {
    // Fresh workspace: a settled month whose invoice has not been finalised.
    assert.deepEqual(burnDownChart(freshUsage()), { state: 'nothing_invoiced', unbilled: 792_278 });
    // Nothing settled at all.
    const quiet = freshUsage();
    quiet.series = [{ month: '2026-09', complete: false, settlements: 0, metered_value: 0, credit_covered: 0, charged: 0, unbilled_balance: 0 }];
    assert.deepEqual(burnDownChart(quiet), { state: 'nothing_metered' });
    // Once a bill is finalised the split is drawable — the quiet month beside it included.
    const billed = freshUsage();
    billed.series = [
      { month: '2026-08', complete: true, settlements: 1, metered_value: 100_000, credit_covered: 0, charged: 0, unbilled_balance: 100_000 },
      { month: '2026-09', complete: false, settlements: 1, metered_value: 894_635, credit_covered: 95_000, charged: 792_278, unbilled_balance: 0 },
    ];
    const chart = burnDownChart(billed);
    assert.equal(chart.state, 'draw');
    assert.equal(chart.state === 'draw' && chart.months.length, 2);
  });

  it('names what each reconciliation checked rather than repeating one sentence for six', () => {
    const { passed, failed } = checkPhrases(freshUsage().reconciliation.checks);
    assert.equal(passed.length, 6);
    assert.equal(failed.length, 0);
    assert.equal(new Set(passed).size, 6, 'six checks, six different statements');
    assert.ok(passed.includes(USAGE_CHECK_LABEL.settlement_components_match));
    assert.match(USAGE_CHECK_LABEL.invoice_lines_carry_the_settled_amount, /finalised invoice/);
    // A check this file has never heard of is still said, in words.
    assert.deepEqual(checkPhrases([{ name: 'a_new_check', ok: false }]).failed, ['a new check']);
  });

  it('formats the ISO days a ledger reason carries as calendar boundaries', () => {
    const day = (utc: number) => new Date(utc).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    assert.equal(formatReasonDates('Expired unused on 2026-08-31', day), 'Expired unused on Aug 31, 2026');
    assert.equal(
      formatReasonDates('Returned after Telemetry events usage was withdrawn from the period ending 2026-09-04', day),
      'Returned after Telemetry events usage was withdrawn from the period ending Sep 4, 2026',
    );
    assert.equal(formatReasonDates('covers 2026-08-05T00:00:00.000Z to 2026-09-04T00:00:00.000Z', day), 'covers Aug 5, 2026 to Sep 4, 2026');
    assert.equal(formatReasonDates('Purchased 1 × Telemetry credit pack', day), 'Purchased 1 × Telemetry credit pack');
  });

  it('calls a true-up’s return of units what it is, and a refund a refund', () => {
    assert.equal(movementLabel({ type: 'refund', ref_type: 'credit_true_up' }), 'True-up return');
    assert.equal(movementLabel({ type: 'refund', ref_type: 'credit_refund' }), 'Refund');
    assert.equal(movementLabel({ type: 'rollover_in', ref_type: null }), 'Rollover in');
  });
});

describe('what a credit write invalidates', () => {
  const credits = readFileSync(new URL('../src/client/modules/revenue/credits.tsx', import.meta.url), 'utf8');

  it('includes the burn-down and the overview, which went stale after a pack sale', () => {
    assert.ok(CREDIT_WRITE_INVALIDATES.includes('/v1/revenue/usage'));
    assert.ok(CREDIT_WRITE_INVALIDATES.includes('/v1/credits/overview'));
    assert.ok(CREDIT_WRITE_INVALIDATES.includes('/v1/credit-grants'));
    assert.ok(CREDIT_WRITE_INVALIDATES.includes('/v1/credit-ledger'));
    assert.ok(CREDIT_WRITE_INVALIDATES.includes('/v1/credit-billable-items'));
  });

  it('is the list every credit mutation on the screen uses — none carries a hand-written subset', () => {
    // Issue, sell a pack, settle, edit, void, refund and invoice-the-outbox: seven writes.
    const uses = credits.match(/invalidates: \[\.\.\.CREDIT_WRITE_INVALIDATES/g) ?? [];
    assert.ok(uses.length >= 7, `${uses.length} mutations share the list; expected every one of the seven`);
    assert.doesNotMatch(credits, /invalidates: \['\/v1\/credit/, 'a credit write still names its own list, so something it changes is not re-read');
  });

  it('never captions the covered figure as one that "never reached an invoice"', () => {
    assert.doesNotMatch(credits, /never reached an invoice/);
    assert.match(credits, /label="Awaiting an invoice"/);
  });
});

/* ------------------------------- the retry policy ------------------------- */

import { MAX_ATTEMPTS, MIN_ATTEMPTS, attemptsError, canPresent, cannotPresentReason, collectionHourError, policySavedLine, recoveryRateText } from '../src/client/modules/revenue/dunning-policy';

describe('the retry policy form', () => {
  it('refuses 0 and 13 attempts in words, and accepts the server’s 1–12', () => {
    assert.match(attemptsError(0) ?? '', /at least 1 attempt/i);
    assert.match(attemptsError(13) ?? '', /no more than 12/i);
    assert.match(attemptsError(null) ?? '', /how many/i);
    assert.match(attemptsError(2.5) ?? '', /whole/i);
    for (let n = MIN_ATTEMPTS; n <= MAX_ATTEMPTS; n++) assert.equal(attemptsError(n), null, `${n} attempts is a valid schedule`);
  });

  it('holds the collection hour to a clock', () => {
    assert.equal(collectionHourError(0), null);
    assert.equal(collectionHourError(23), null);
    assert.match(collectionHourError(24) ?? '', /0 to 23/);
    assert.match(collectionHourError(-1) ?? '', /0 to 23/);
  });

  it('puts the saved schedule on one line for the toast', () => {
    const list = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0]);
    assert.equal(policySavedLine({ max_attempts: 4, retry_days: [3, 5, 7] }, list), '4 attempts over 3, 5 and 7 days');
    assert.equal(policySavedLine({ max_attempts: 2, retry_days: [3] }, list), '2 attempts over 3 days');
    assert.equal(policySavedLine({ max_attempts: 1, retry_days: [3, 5, 7] }, list), 'One attempt and no retries');
  });

  it('does not print a 0.00% rate over a book with no finished campaign', () => {
    // The EUR book on the fresh workspace: one campaign, still being chased.
    assert.equal(recoveryRateText({ recovered_amount: 0, lost_amount: 0, recovery_rate_bps: 0 }), 'no finished campaign yet');
    assert.equal(recoveryRateText({ recovered_amount: 8_978, lost_amount: 0, recovery_rate_bps: 10_000 }), '100.00% rate');
    assert.equal(recoveryRateText({ recovered_amount: 100, lost_amount: 300, recovery_rate_bps: 2_500 }), '25.00% rate');
  });

  it('keeps what was typed on screen and withholds Save, rather than rewriting the field', () => {
    const source = readFileSync(new URL('../src/client/modules/revenue/dunning.tsx', import.meta.url), 'utf8');
    const modal = source.slice(source.indexOf('function PolicyModal'));
    assert.match(modal, /label="Maximum attempts"[\s\S]*?rewriteOutOfRange=\{false\}/, 'the attempts field lifts 0 as 0');
    assert.match(modal, /label="Collection hour"[\s\S]*?rewriteOutOfRange=\{false\}/, 'the sibling field does not clamp 24 → 23 either');
    assert.match(modal, /disabled=\{invalid\}/, 'Save is withheld while a field is out of range');
    assert.match(modal, /attemptsError\(maxAttempts\)/);
    assert.match(modal, /collectionHourError\(collectionHour\)/);
    // The toast no longer carries the eight-line narrative.
    assert.doesNotMatch(source, /toast\.success\('Retry policy saved', schedule\)/);
    assert.match(source, /policySavedLine\(policy, f\.list\)/);
  });
});

/* -------------------------------- a quiet meter's age --------------------- */

import { isUnitAbbreviation } from '../src/client/modules/revenue/meter-copy';
import { formatRelative } from '../src/client/design/format';

describe('a unit’s own noun', () => {
  it('leaves a symbol uninflected — "43.68 GB", never "GBs" — and still pluralises a word', () => {
    for (const symbol of ['GB', 'MB', 'TB', 'kWh', 'API']) assert.equal(isUnitAbbreviation(symbol), true, symbol);
    for (const word of ['event', 'seat', 'robot', 'alert', 'unit', 'query']) assert.equal(isUnitAbbreviation(word), false, word);
  });
});

describe('how long ago a quiet meter last streamed', () => {
  const now = Date.UTC(2026, 9, 20);
  it('counts days between a week and a quarter — the kit\u2019s own relative form, not a second one', () => {
    // The module used to carry `daysAgoCopy` because `formatRelative` rounded
    // to months from a week out and read "2 months ago" for both of these.
    assert.equal(formatRelative(now - 46 * 86_400_000, now), '46 days ago');
    assert.equal(formatRelative(now - 75 * 86_400_000, now), '75 days ago');
  });
  it('leaves the coarse form under a week and past a quarter', () => {
    assert.equal(formatRelative(now - 3 * 86_400_000, now), '3 days ago');
    assert.equal(formatRelative(now - 120 * 86_400_000, now), '4 months ago');
  });
  it('leaves no second copy of the rule in the module', () => {
    const copy = readFileSync(new URL('../src/client/modules/revenue/meter-copy.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(copy, /daysAgoCopy/);
    const usage = readFileSync(new URL('../src/client/modules/revenue/usage.tsx', import.meta.url), 'utf8');
    assert.doesNotMatch(usage, /daysAgoCopy/);
  });
});

/* ------------------------------- addresses -------------------------------- */

describe('addresses the brief names', () => {
  it('registers /revenue/movement and /revenue/collections as anchors onto the board', () => {
    const routes = readFileSync(new URL('../src/client/modules/revenue/routes.tsx', import.meta.url), 'utf8');
    const board = readFileSync(new URL('../src/client/modules/revenue/board.tsx', import.meta.url), 'utf8');
    assert.match(routes, /path: '\/revenue\/movement'/);
    assert.match(routes, /path: '\/revenue\/collections'/);
    assert.match(board, /id="movement"/, 'the board has a section to land on');
    assert.match(board, /id="collections"/);
    assert.match(board, /useScrollToHash\(\)/);
  });
});

/* ------------------------------ the pack picker --------------------------- */

import {
  PACK_ANY_CHARGE, packGrantLine, packGrantPlan, packMeterHint, packRedemptionError, packSize, packTopUpBody,
} from '../src/client/modules/revenue/credit-pack';
import type { PackPrice, PackProduct } from '../src/client/modules/revenue/credit-pack';

/** `price_nw_credit_pack` and `prod_nw_credits`, exactly as the catalogue returns them. */
const PACK_PRICE: PackPrice = {
  id: 'price_nw_credit_pack',
  product: 'prod_nw_credits',
  recurring: null,
  metadata: { component: 'credits', events_per_pack: '1000000' },
};
const PACK_PRODUCT: PackProduct = {
  id: 'prod_nw_credits',
  unit_label: 'pack',
  metadata: { events_per_pack: '1000000', drawdown_order: 'before_overage' },
};
const SEAT_PRICE: PackPrice = {
  id: 'price_nw_scale_seat_monthly',
  product: 'prod_nw_scale',
  recurring: { meter: null },
  metadata: { component: 'seat', term: 'monthly', included_with_plan: '25' },
};

describe('what the pack picker sells', () => {
  it('reads the pack size off the price, and off its product when the price is silent', () => {
    assert.equal(packSize(PACK_PRICE, PACK_PRODUCT), 1_000_000);
    // The price wins, so a repriced pack can change size without editing the
    // product every other price hangs off.
    assert.equal(packSize({ ...PACK_PRICE, metadata: { units_per_pack: '250000' } }, PACK_PRODUCT), 250_000);
    assert.equal(packSize({ ...PACK_PRICE, metadata: { component: 'credits' } }, PACK_PRODUCT), 1_000_000);
    assert.equal(packSize(SEAT_PRICE, { id: 'prod_nw_scale', unit_label: 'seat', metadata: { rung: '3' } }), 0);
  });

  it('sells the metered pack as prepaid units, naming the meter and the size', () => {
    const plan = packGrantPlan('mtr_nw_telemetry', packSize(PACK_PRICE, PACK_PRODUCT), 5);
    assert.deepEqual(plan, { kind: 'unit', meter: 'mtr_nw_telemetry', unitsPerPack: 1_000_000, units: 5_000_000 });
    // Both halves are sent: the catalogue never links `prod_nw_credits` to a
    // meter, so a request that leaves the denomination to be inferred is the
    // request that made five packs of events into $2,300 of spendable money.
    assert.deepEqual(packTopUpBody(plan), {
      kind: 'unit',
      applicability: { scope: 'targeted', meters: ['mtr_nw_telemetry'] },
    });
  });

  it('still sells unrestricted money when that is what was asked for', () => {
    const plan = packGrantPlan(PACK_ANY_CHARGE, 1_000_000, 5);
    assert.deepEqual(plan, { kind: 'monetary', meter: null });
    assert.deepEqual(packTopUpBody(plan), { kind: 'monetary', applicability: { scope: 'all' } });
  });

  it('a pack whose price states no size, pointed at a meter, is money for that meter alone', () => {
    const plan = packGrantPlan('mtr_nw_export', 0, 2);
    assert.deepEqual(plan, { kind: 'monetary', meter: 'mtr_nw_export' });
    assert.deepEqual(packTopUpBody(plan), {
      kind: 'monetary',
      applicability: { scope: 'targeted', meters: ['mtr_nw_export'] },
    });
  });

  it('withholds the sale of a unit pack until it names a meter, and says why', () => {
    const refused = packRedemptionError('', packSize(PACK_PRICE, PACK_PRODUCT), '1,000,000 events');
    assert.match(String(refused), /1,000,000 events a pack/);
    assert.match(String(refused), /cannot pay for exported gigabytes/);
    assert.equal(packRedemptionError('mtr_nw_telemetry', 1_000_000, '1,000,000 events'), null);
    assert.equal(packRedemptionError(PACK_ANY_CHARGE, 1_000_000, '1,000,000 events'), null);
  });

  it('states what the customer receives in the denomination they receive it in', () => {
    const opts = {
      quantity: 5,
      packLabel: 'pack',
      meterName: 'Telemetry events',
      units: (n: number) => `${n.toLocaleString('en-US')} events`,
      money: (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      amount: 230_000,
      plural: (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`,
    };
    const unit = packGrantLine(packGrantPlan('mtr_nw_telemetry', 1_000_000, 5), opts);
    assert.match(unit, /5,000,000 events/, 'the total units the packs grant');
    assert.match(unit, /Telemetry events/);
    // A unit pack grants events, not the money it cost — printing the charge
    // here is the confusion the dialog exists to remove.
    assert.doesNotMatch(unit, /\$2,300/);

    const money = packGrantLine(packGrantPlan(PACK_ANY_CHARGE, 1_000_000, 5), opts);
    assert.match(money, /\$2,300\.00/);
    assert.match(money, /any charge in this currency/);
  });

  it('defaults from the meter the catalogue names, and to nothing when it names none', () => {
    assert.equal(packMeterHint(PACK_PRICE, PACK_PRODUCT), null, 'the seeded pack names no meter, so the dialog must ask');
    assert.equal(packMeterHint({ ...PACK_PRICE, metadata: { ...PACK_PRICE.metadata, meter: 'telemetry_events' } }, PACK_PRODUCT), 'telemetry_events');
    assert.equal(packMeterHint({ ...PACK_PRICE, recurring: { meter: 'telemetry_events' } }, PACK_PRODUCT), 'telemetry_events');
    assert.equal(packMeterHint(PACK_PRICE, { ...PACK_PRODUCT, metadata: { meter: 'mtr_nw_telemetry' } }), 'mtr_nw_telemetry');
  });

  it('the dialog sends the denomination rather than letting it be inferred', () => {
    const credits = readFileSync(new URL('../src/client/modules/revenue/credits.tsx', import.meta.url), 'utf8');
    assert.match(credits, /\.\.\.packTopUpBody\(plan\)/);
    assert.match(credits, /label="Redeemable against"/);
  });
});

/* --------------------------- settling a true-up --------------------------- */

import {
  RESOLUTION_COPY, allowedResolutions, defaultResolution, resolutionBlockedBecause, trueUpDirection,
  trueUpRefusalText, trueUpWorthText,
} from '../src/client/modules/revenue/true-up';
import type { TrueUpBasis } from '../src/client/modules/revenue/true-up';

const usd = (minor: number) => `$${(Math.abs(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const events = (count: number) => `${count.toLocaleString('en-US')} events`;

/**
 * `GET /v1/meter-period-closures/:id` for Meridian Forge's Aug 9 – Sep 8
 * window: billed at 31,845,798 events, reads 32,022,241 today, and the
 * 250,000 that arrived late are worth $47.50 on the price it was billed on.
 */
const UNDER_BILLED: TrueUpBasis = {
  outstanding_amount: 4_750, outstanding_quantity: 250_000, price: 'price_nw_telemetry_events', currency: 'usd',
};
const OVER_BILLED: TrueUpBasis = {
  outstanding_amount: -1_397, outstanding_quantity: -73_557, price: 'price_nw_telemetry_events', currency: 'usd',
};
const FREE_DRIFT: TrueUpBasis = {
  outstanding_amount: 0, outstanding_quantity: 4_000, price: 'price_nw_telemetry_events', currency: 'usd',
};
const NO_PRICE: TrueUpBasis = { outstanding_amount: null, outstanding_quantity: 9_000, price: null, currency: 'usd' };
const AGREES: TrueUpBasis = {
  outstanding_amount: 0, outstanding_quantity: 0, price: 'price_nw_telemetry_events', currency: 'usd',
};

describe('what a true-up is worth before it is settled', () => {
  it('reads the direction off the re-priced closure, so the money is known before anything is chosen', () => {
    assert.equal(trueUpDirection(UNDER_BILLED), 'under_billed');
    assert.equal(trueUpDirection(OVER_BILLED), 'over_billed');
    assert.equal(trueUpDirection(FREE_DRIFT), 'free');
    assert.equal(trueUpDirection(NO_PRICE), 'unpriced');
    assert.equal(trueUpDirection(AGREES), 'agrees');
    assert.equal(trueUpDirection(null), null, 'nothing is claimed until the window has been read');
  });

  it('offers only the resolution the drift allows, and opens on it', () => {
    assert.deepEqual(allowedResolutions('under_billed'), ['rebilled', 'ignored']);
    assert.deepEqual(allowedResolutions('over_billed'), ['credited', 'ignored']);
    assert.deepEqual(allowedResolutions('agrees'), ['ignored']);
    assert.deepEqual(allowedResolutions('unpriced'), ['ignored']);
    // Usage that arrives late is owed, which is the commonest drift there is —
    // and the dialog used to open on `credited`, the one answer the server
    // refuses for it.
    assert.equal(defaultResolution(trueUpDirection(UNDER_BILLED)), 'rebilled');
    assert.equal(defaultResolution(trueUpDirection(OVER_BILLED)), 'credited');
    assert.equal(defaultResolution(trueUpDirection(NO_PRICE)), 'ignored');
  });

  it('states the worth and which way it points, in money rather than minor units', () => {
    const owed = trueUpWorthText('under_billed', { money: usd, units: events, basis: UNDER_BILLED, loading: false });
    assert.match(owed, /\$47\.50/);
    assert.match(owed, /250,000 events/);
    assert.match(owed, /still owes/);
    assert.doesNotMatch(owed, /4750|4,750/, 'the raw minor units never reach a screen');
    assert.doesNotMatch(owed, /Not priced/, 'the closure names a price, so it is priced');

    const back = trueUpWorthText('over_billed', { money: usd, units: events, basis: OVER_BILLED, loading: false });
    assert.match(back, /\$13\.97/);
    assert.match(back, /owed back to the customer/);

    // The one case where "not priced" is true is the one that says it.
    const none = trueUpWorthText('unpriced', { money: usd, units: events, basis: NO_PRICE, loading: false });
    assert.match(none, /Not priced/);
  });

  it('explains a refusal in the workspace’s money and the radio’s own label', () => {
    const raw = {
      code: 'parameter_invalid',
      param: 'resolution',
      message: 'This period is under-billed by 4750 minor units, not over-billed. Resolve it as `rebilled`.',
    };
    const said = trueUpRefusalText(raw, 'under_billed', usd(4_750));
    assert.match(said, /\$47\.50/);
    assert.match(said, new RegExp(RESOLUTION_COPY.rebilled));
    assert.doesNotMatch(said, /minor units/);
    assert.doesNotMatch(said, /`/, 'no wire enum in backticks');

    const other = trueUpRefusalText({ ...raw, message: 'This period is over-billed by 1397 minor units, not under-billed. Resolve it as `credited`.' }, 'over_billed', usd(1_397));
    assert.match(other, new RegExp(RESOLUTION_COPY.credited));
    assert.doesNotMatch(other, /minor units/);

    // Anything the dialog cannot say better is the server's to explain.
    assert.equal(trueUpRefusalText({ code: 'rate_limited', param: null, message: 'Slow down.' }, 'under_billed', '$47.50'), 'Slow down.');
  });

  it('says on the option itself why the other direction is not on offer', () => {
    assert.equal(resolutionBlockedBecause('rebilled', 'under_billed', usd(4_750)), null);
    assert.match(String(resolutionBlockedBecause('credited', 'under_billed', usd(4_750))), /nothing to credit/);
    assert.match(String(resolutionBlockedBecause('rebilled', 'over_billed', usd(1_397))), /nothing more to bill/);
    assert.equal(resolutionBlockedBecause('ignored', 'agrees', '—'), null);
  });

  it('the dialog reads the closure rather than the entry’s empty amount', () => {
    const usage = readFileSync(new URL('../src/client/modules/revenue/usage.tsx', import.meta.url), 'utf8');
    assert.match(usage, /\/v1\/meter-period-closures\/\$\{entry\.closure\}/);
    assert.match(usage, /trueUpRefusalText/);
    // The sentence an open entry's null `amount` used to produce.
    assert.doesNotMatch(usage, /the period was billed without naming a price/);
  });
});

/* --------------------- what the schedule decided next --------------------- */

import { nextAttemptFact, nextAttemptLine } from '../src/client/modules/revenue/dunning-policy';

/**
 * Van Doorn Verpakking's campaign as `GET /v1/dunning/:id` returns it: two
 * refusals three days apart, and a queue holding Sep 11 — eleven days after
 * the second, because the five-day slot had already gone past.
 */
const ATTEMPT_2 = {
  attempt_number: 2,
  scheduled_for: Date.UTC(2026, 7, 31, 6, 25),
  attempted_at: Date.UTC(2026, 7, 31, 6, 25),
  next_attempt_at: Date.UTC(2026, 8, 11, 9, 52),
  outcome: 'failed',
  decision: 'Attempt 2 was refused with insufficient_funds again. Attempt 3 of 4 is scheduled five days out — €89.00 is still at risk.',
};
const VAN_DOORN = { max_attempts: 4, next_attempt_at: Date.UTC(2026, 8, 11, 9, 52) };
const asDate = (at: number) => new Date(at).toISOString().slice(0, 10);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

describe('what the recovery timeline says the schedule decided', () => {
  it('reads the instant off the attempt, so the timeline and the Next attempt tile cannot disagree', () => {
    const fact = nextAttemptFact(ATTEMPT_2, VAN_DOORN, true);
    assert.ok(fact);
    assert.equal(fact.at, VAN_DOORN.next_attempt_at, 'the same field the tile above reads');
    assert.equal(fact.attempt, 3);
    assert.equal(fact.of, 4);
    assert.equal(fact.gapDays, 11);
    assert.equal(fact.movedTo, null);
  });

  it('states the date, and a gap that agrees with it', () => {
    const fact = nextAttemptFact(ATTEMPT_2, VAN_DOORN, true);
    assert.ok(fact);
    const line = nextAttemptLine(fact, asDate, plural);
    assert.match(line, /2026-09-11/);
    assert.match(line, /11 days after this one/);
    // The claim the recorded prose made, and the tile contradicted.
    assert.doesNotMatch(line, /five days/);
    assert.doesNotMatch(line, /5 days/);
  });

  it('says so when the campaign has moved the slot since the attempt recorded one', () => {
    const moved = nextAttemptFact(ATTEMPT_2, { ...VAN_DOORN, next_attempt_at: Date.UTC(2026, 8, 14, 9, 52) }, true);
    assert.ok(moved);
    assert.equal(moved.movedTo, Date.UTC(2026, 8, 14, 9, 52));
    assert.match(nextAttemptLine(moved, asDate, plural), /moved it since, to 2026-09-14/);
    // Only the newest attempt is compared: an older one recorded a slot the
    // campaign has legitimately left behind.
    assert.equal(nextAttemptFact(ATTEMPT_2, { ...VAN_DOORN, next_attempt_at: Date.UTC(2026, 8, 14) }, false)?.movedTo, null);
  });

  it('leaves the server’s explanation in place where there is no next attempt', () => {
    assert.equal(nextAttemptFact({ ...ATTEMPT_2, next_attempt_at: null }, VAN_DOORN, true), null);
    assert.equal(nextAttemptFact({ ...ATTEMPT_2, outcome: 'succeeded', next_attempt_at: null }, VAN_DOORN, true), null);
  });

  it('the drawer draws the timeline from the instant, not from the prose', () => {
    const source = readFileSync(new URL('../src/client/modules/revenue/dunning.tsx', import.meta.url), 'utf8');
    assert.match(source, /nextAttemptFact\(attempt, row/);
    assert.match(source, /nextAttemptLine\(next/);
  });
});

/* ----------------------------- a spent grant ------------------------------ */

import { grantStatusWord } from '../src/client/modules/revenue/credits-math';
import { statusLabel, statusTone } from '../src/client/design/status-core';

describe('a credit grant drawn down to nothing', () => {
  it('is not called what dunning calls a bill it stopped chasing', () => {
    // The kit's lifecycle word for `exhausted`, which is right for a campaign.
    assert.equal(statusLabel('exhausted'), 'Given up');
    assert.equal(statusLabel(grantStatusWord('exhausted')), 'Spent');
    // And finished, not failed: a customer who used their prepaid events did
    // nothing wrong, so the pill is not painted as a problem.
    assert.equal(statusTone('exhausted'), 'danger');
    assert.equal(statusTone(grantStatusWord('exhausted')), 'neutral');
  });

  it('leaves every other grant state to the kit', () => {
    for (const state of ['active', 'scheduled', 'expired', 'voided']) {
      assert.equal(grantStatusWord(state), state, state);
      assert.equal(statusLabel(grantStatusWord(state)), statusLabel(state));
    }
  });

  it('the pill, the filter, the tile caption and the drawer ask about the same word', () => {
    const credits = readFileSync(new URL('../src/client/modules/revenue/credits.tsx', import.meta.url), 'utf8');
    assert.match(credits, /<StatusPill status=\{grantStatusWord\(row\.status\)\} \/>/);
    assert.match(credits, /accessor: \(row\) => grantStatusWord\(row\.status\)/);
    assert.match(credits, /statusLabel\(grantStatusWord\(state\)\)\.toLowerCase\(\)/);
    // A third word for the same state: the drawer's stat read "Exhausted".
    assert.doesNotMatch(credits, /humanize\(grant\.status\)/);
  });
});

/* --------------- an action the server cannot perform is not offered -------- */

/**
 * A campaign with no usable method on file has nothing to present.
 *
 * The row offered "Retry the charge now…" regardless, the dialog named the
 * attempt it was about to spend, and presenting recorded no attempt at all:
 * a success toast over a campaign that had not moved. It surfaced as a browser
 * test whose retry never incremented the count, which is the only way anyone
 * was ever going to notice — the screen looked like it had worked.
 */
describe('the retry that has nothing to present', () => {
  const campaign = (status: string, method: unknown) => ({ status, payment_method: method });
  const CARD = { id: 'pm_1', display_name: 'Visa 4242', type: 'card' };

  it('is not offered when no card is on file, and says why', () => {
    assert.equal(canPresent(campaign('recovering', null)), false);
    assert.equal(cannotPresentReason(campaign('recovering', null)), 'No usable card on file — attach one first');
  });

  it('is offered while the campaign is being chased and a card is on file', () => {
    assert.equal(canPresent(campaign('recovering', CARD)), true);
    assert.equal(cannotPresentReason(campaign('recovering', CARD)), undefined);
    assert.equal(canPresent(campaign('open', CARD)), true);
  });

  it('is not offered on a campaign that is already settled — and does not blame a missing card for it', () => {
    for (const status of ['recovered', 'canceled']) {
      assert.equal(canPresent(campaign(status, CARD)), false, status);
      // The row is disabled because the chase is over, not because of the card.
      assert.equal(cannotPresentReason(campaign(status, null)), undefined, status);
    }
  });
});
