import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, frozenClock, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { DAY } from '../src/shared/time';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };

const UTC = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min, 0, 0);

/** Northwind's list prices, in minor units — the numbers the seeded catalog holds. */
const GROWTH_MONTHLY = 49_900;
const GROWTH_SEAT_MONTHLY = 2_900;
const GROWTH_ANNUAL = 499_000;
const GROWTH_SEAT_ANNUAL = 29_000;

interface Workspace {
  app: App;
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  ok(method: string, path: string, body?: unknown): Promise<any>;
  now(): number;
  travelTo(ts: number): Promise<unknown>;
  customer(name?: string, over?: Record<string, unknown>): Promise<any>;
  close(): void;
}

async function workspace(at: number): Promise<Workspace> {
  const app = await createApp({ db: 'memory', config: { env: 'test' }, clock: frozenClock(at) });
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, body, auth: DANA });
  let seq = 0;
  const ws: Workspace = {
    app,
    call,
    async ok(method, path, body) {
      const res = await call(method, path, body);
      assert.ok(res.status < 400, `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    },
    now: () => app.ctx.now(),
    travelTo(ts) {
      const delta = ts - app.ctx.now();
      assert.ok(delta >= 0, 'the time machine only runs forwards');
      return app.travel(delta);
    },
    customer(name = 'Revenue Test Account', over = {}) {
      seq += 1;
      return ws.ok('POST', '/v1/customers', {
        name: `${name} ${seq}`,
        email: `ap+rev${seq}@testaccount.example`,
        currency: 'usd',
        ...over,
      });
    },
    close: () => app.close(),
  };
  return ws;
}

/**
 * The hand calculation. Integer division with a half-up tie, in BigInt, written
 * out longhand so it shares no code with the module under test — which is the
 * only way "matches an independent calculation" means anything.
 */
function monthlyByHand(annualMinorUnits: bigint): number {
  const quotient = annualMinorUnits / 12n;
  const remainder = annualMinorUnits % 12n;
  return Number(remainder * 2n >= 12n ? quotient + 1n : quotient);
}

/** Every movement row must satisfy the identity the endpoint claims to prove. */
function assertRowReconciles(row: any, where: string): void {
  const computed = row.opening + row.new_business + row.expansion + row.reactivation - row.contraction - row.churn;
  assert.equal(
    computed, row.closing,
    `${where}: ${row.month} opening ${row.opening} + movements does not close at ${row.closing} (got ${computed})`,
  );
  assert.equal(row.reconciliation.balanced, true, `${where}: ${row.month} reported itself unbalanced`);
  assert.equal(row.reconciliation.difference, 0, `${where}: ${row.month} difference ${row.reconciliation.difference}`);
}

function assertSeriesChains(rows: any[], where: string): void {
  for (let i = 1; i < rows.length; i++) {
    assert.equal(
      rows[i].opening, rows[i - 1].closing,
      `${where}: ${rows[i].month} opens at ${rows[i].opening} but ${rows[i - 1].month} closed at ${rows[i - 1].closing}`,
    );
  }
}

const moversFor = (movement: any, customerId: string): { month: string; kind: string; amount: number }[] =>
  movement.series.flatMap((row: any) =>
    row.top_movers
      .filter((mover: any) => mover.customer === customerId)
      .map((mover: any) => ({ month: row.month, kind: mover.kind, amount: mover.amount })));

/* ========================================================================== *
 * 1. MRR and ARR
 * ========================================================================== */

describe('MRR and ARR', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 6, 15)); });
  after(() => ws.close());

  test('the headline figure is billing\'s own, to the cent', async () => {
    const revenue = await ws.ok('GET', '/v1/revenue/mrr');
    const billing = await ws.ok('GET', '/v1/subscriptions/overview');

    assert.equal(revenue.totals.mrr, billing.mrr, 'revenue and billing must never publish two different MRRs');
    assert.equal(revenue.totals.arr, billing.arr);
    assert.equal(revenue.totals.arr, revenue.totals.mrr * 12, 'ARR is twelve months of MRR, exactly');
    assert.equal(revenue.not_yet_revenue.trialing_mrr, billing.trial_mrr, 'the trial book agrees too');
  });

  test('an annual subscription normalises to the month, matching a hand calculation', async () => {
    const before = await ws.ok('GET', '/v1/revenue/mrr');
    const customer = await ws.customer('Kestrel Annual Terms');
    const sub = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [
        { price: 'growth_annual' },
        { price: 'growth_seat_annual', quantity: 5 },
      ],
      collection_method: 'send_invoice',
      days_until_due: 30,
    });
    assert.equal(sub.interval, 'year');

    // £4,990.00/year is £415.83/month and 5 × £290.00/year is £120.83/month.
    // Each item is normalised and rounded on its own, exactly as billing does
    // it — normalising the sum instead would give 53,667 and be a cent out.
    const plan = monthlyByHand(BigInt(GROWTH_ANNUAL));
    const seats = monthlyByHand(BigInt(GROWTH_SEAT_ANNUAL) * 5n);
    assert.equal(plan, 41_583);
    assert.equal(seats, 12_083);
    const expected = plan + seats;
    assert.equal(expected, 53_666);
    assert.notEqual(expected, monthlyByHand(BigInt(GROWTH_ANNUAL) + BigInt(GROWTH_SEAT_ANNUAL) * 5n));

    const account = await ws.ok('GET', `/v1/revenue/accounts/${customer.id}`);
    assert.equal(account.mrr, expected, 'the account MRR is the two items normalised and rounded once each');
    assert.equal(account.arr, expected * 12);

    const after = await ws.ok('GET', '/v1/revenue/mrr');
    assert.equal(after.totals.mrr - before.totals.mrr, expected, 'the book moved by exactly the new contract');

    const annual = after.by_cadence.find((row: any) => row.interval === 'year');
    assert.ok(annual && annual.mrr > 0, 'annual contracts are reported on their own cadence line');
  });

  test('metered items are outside MRR, and the usage basis says how it was measured', async () => {
    const customer = await ws.customer('Halbrook Telemetry Only');
    await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'starter_monthly' }, { price: 'telemetry_events_monthly' }],
      collection_method: 'send_invoice',
      days_until_due: 30,
    });
    const account = await ws.ok('GET', `/v1/revenue/accounts/${customer.id}`);
    assert.equal(account.mrr, 9_900, 'the metered telemetry line contributes nothing to MRR');

    const report = await ws.ok('GET', '/v1/revenue/mrr');
    assert.ok(report.usage.basis.length > 40, 'the usage run rate states its own basis in the response');
    assert.equal(report.usage.mrr_with_usage, report.totals.mrr + report.usage.run_rate);
  });

  test('every endpoint carries a basis and the row counts it read', async () => {
    for (const path of ['mrr', 'movement', 'churn', 'cohorts', 'deferred', 'collections', 'usage', 'summary']) {
      const body = await ws.ok('GET', `/v1/revenue/${path}`);
      assert.ok(body.basis, `${path} has no basis`);
      assert.ok(body.basis.summary.length > 20, `${path} basis has no summary`);
      assert.ok(Array.isArray(body.basis.rules) && body.basis.rules.length >= 3, `${path} states fewer than three rules`);
      assert.ok(body.basis.currency.note.length > 20, `${path} does not explain its currency handling`);
      assert.ok(body.sources && Object.keys(body.sources).length >= 3, `${path} names no sources`);
      for (const [key, count] of Object.entries(body.sources)) {
        assert.equal(typeof count, 'number', `${path} source ${key} is not a count`);
      }
    }
  });

  test('every endpoint answers with both a series and totals', async () => {
    for (const path of ['mrr', 'movement', 'churn', 'cohorts', 'deferred', 'collections', 'usage', 'summary']) {
      const body = await ws.ok('GET', `/v1/revenue/${path}`);
      assert.ok(Array.isArray(body.series), `${path} returns no series`);
      assert.ok(body.totals && typeof body.totals === 'object', `${path} returns no totals`);
      assert.ok(body.range.months >= 1 && body.range.months <= 60, `${path} has no sensible window`);
      assert.equal(typeof body.as_of, 'number');
    }
  });

  test('the summary reads the other six rather than recomputing them', async () => {
    const summary = await ws.ok('GET', '/v1/revenue/summary?months=12');
    const mrr = await ws.ok('GET', '/v1/revenue/mrr?months=12');
    const movement = await ws.ok('GET', '/v1/revenue/movement?months=12');
    const deferred = await ws.ok('GET', '/v1/revenue/deferred?months=12');
    const collections = await ws.ok('GET', '/v1/revenue/collections?months=12');
    const usage = await ws.ok('GET', '/v1/revenue/usage?months=12');

    assert.equal(summary.series.length, movement.series.length);
    for (let i = 0; i < summary.series.length; i++) {
      const row = summary.series[i];
      assert.equal(row.month, movement.series[i].month);
      assert.equal(row.mrr, movement.series[i].closing);
      assert.equal(row.arr, row.mrr * 12);
      assert.equal(row.accounts, mrr.series[i].accounts);
      assert.equal(row.recognised, deferred.series[i].recognised);
      assert.equal(row.receivables, collections.series[i].outstanding);
      assert.equal(row.metered_value, usage.series[i].metered_value);
    }
    assert.equal(summary.totals.mrr, mrr.totals.mrr);
    assert.equal(summary.totals.closing_mrr, movement.totals.closing);
    assert.equal(summary.totals.opening_mrr + summary.totals.net_movement, summary.totals.closing_mrr);
    assert.equal(summary.totals.invoiced, deferred.totals.invoiced);
    assert.equal(summary.totals.receivables, collections.totals.outstanding);
    assert.equal(summary.totals.usage_charged, usage.totals.charged);
  });

  test('a single-currency request needs no caveat', async () => {
    const mixed = await ws.ok('GET', '/v1/revenue/mrr');
    assert.equal(mixed.basis.currency.mode, 'mixed', 'Northwind bills in three currencies');

    const eur = await ws.ok('GET', '/v1/revenue/mrr?currency=eur');
    assert.equal(eur.basis.currency.mode, 'single');
    const fromMixed = mixed.by_currency.find((row: any) => row.currency === 'eur');
    assert.equal(eur.totals.mrr, fromMixed.mrr, 'the euro book is the same either way it is asked for');
  });
});

/* ========================================================================== *
 * 2. Movement
 * ========================================================================== */

describe('MRR movement', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 6, 15)); });
  after(() => ws.close());

  test('every seeded month reconciles, and each month opens where the last one closed', async () => {
    const movement = await ws.ok('GET', '/v1/revenue/movement?months=24');
    assert.ok(movement.series.length >= 12, 'the seeded workspace has more than a year of history');
    assert.deepEqual(movement.unbalanced_months, []);
    assert.equal(movement.balanced, true);
    assert.equal(movement.warning, null);
    for (const row of movement.series) assertRowReconciles(row, 'seeded book');
    assertSeriesChains(movement.series, 'seeded book');

    assert.equal(movement.reconciliation.balanced, true);
    assert.equal(
      movement.totals.opening + movement.totals.net, movement.totals.closing,
      'the range as a whole reconciles too',
    );
  });

  test('the closing MRR of the last month is the MRR the book reports today', async () => {
    const movement = await ws.ok('GET', '/v1/revenue/movement');
    const mrr = await ws.ok('GET', '/v1/revenue/mrr');
    const last = movement.series[movement.series.length - 1];
    assert.equal(last.closing, mrr.totals.mrr);
  });

  test('an upgrade is expansion in its own month and in no other', async () => {
    const customer = await ws.customer('Marrow Fabrication');
    const sub = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }, { price: 'growth_seat_monthly', quantity: 10 }],
      billing_cycle_anchor: UTC(2026, 6, 15),
      collection_method: 'send_invoice',
      days_until_due: 30,
    });
    const opening = GROWTH_MONTHLY + 10 * GROWTH_SEAT_MONTHLY;
    assert.equal(sub.mrr, opening);

    // Two clean months, then nine more seats on the night shift, mid-cycle.
    await ws.travelTo(UTC(2026, 8, 20));
    const updated = await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ price: 'growth_seat_monthly', quantity: 19 }],
    });
    assert.equal(updated.mrr, opening + 9 * GROWTH_SEAT_MONTHLY);
    assert.equal(updated.proration.mrr_delta, 9 * GROWTH_SEAT_MONTHLY, 'billing prices the same movement this module charts');

    // Two more months, so "nowhere else" has somewhere else to be.
    await ws.travelTo(UTC(2026, 10, 5));
    const movement = await ws.ok('GET', '/v1/revenue/movement?months=12&top_movers=50');
    for (const row of movement.series) assertRowReconciles(row, 'after an upgrade');

    const mine = moversFor(movement, customer.id);
    assert.deepEqual(
      mine,
      [
        { month: '2026-06', kind: 'new', amount: opening },
        { month: '2026-08', kind: 'expansion', amount: 9 * GROWTH_SEAT_MONTHLY },
      ],
      'the account is new in June and expands in August, and appears in no other month',
    );

    const august = movement.series.find((row: any) => row.month === '2026-08');
    assert.ok(august.expansion >= 9 * GROWTH_SEAT_MONTHLY);
    assert.equal(august.counts.expanded_accounts >= 1, true);
  });

  test('a cancellation is churn exactly once', async () => {
    const customer = await ws.customer('Pellworth Castings');
    const sub = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }],
      billing_cycle_anchor: ws.now(),
      collection_method: 'send_invoice',
      days_until_due: 30,
    });

    await ws.travelTo(UTC(2026, 12, 12));
    await ws.ok('POST', `/v1/subscriptions/${sub.id}/cancel`, {
      cancellation_reason: 'too_expensive',
      comment: 'Pilot line did not clear the capex bar.',
    });
    await ws.travelTo(UTC(2027, 2, 3));

    const movement = await ws.ok('GET', '/v1/revenue/movement?months=24&top_movers=50');
    for (const row of movement.series) assertRowReconciles(row, 'after a cancellation');
    assertSeriesChains(movement.series, 'after a cancellation');

    const mine = moversFor(movement, customer.id);
    const churns = mine.filter((mover) => mover.kind === 'churn');
    assert.equal(churns.length, 1, `churn should appear once, got ${JSON.stringify(mine)}`);
    assert.equal(churns[0].month, '2026-12');
    assert.equal(churns[0].amount, -GROWTH_MONTHLY);

    const account = await ws.ok('GET', `/v1/revenue/accounts/${customer.id}`);
    assert.equal(account.mrr, 0, 'a cancelled account carries no MRR');
    const january = account.series.find((row: any) => row.month === '2027-01');
    assert.equal(january.mrr, 0, 'and none in the months after it either');
  });

  test('churn and retention add up to one, and every rate shows its fraction', async () => {
    const churn = await ws.ok('GET', '/v1/revenue/churn?months=12');
    for (const row of churn.series) {
      if (row.opening_mrr === 0) continue;
      assert.equal(
        row.gross_revenue_churn.bps + row.gross_revenue_retention.bps, 10_000,
        `${row.month}: churn ${row.gross_revenue_churn.percent} and retention ${row.gross_revenue_retention.percent} do not add to 100%`,
      );
      assert.equal(row.gross_revenue_churn.denominator, row.opening_mrr, 'the rate names the base it was divided by');
      assert.equal(row.gross_revenue_churn.numerator, row.churned_mrr + row.contraction_mrr);
      assert.equal(
        row.net_revenue_retention.numerator,
        row.opening_mrr - row.churned_mrr - row.contraction_mrr + row.expansion_mrr + row.reactivation_mrr,
        'net retention adds expansion and reactivation to the retained base, and nothing else',
      );
      assert.equal(row.logo_churn.denominator, row.accounts_at_open);
    }
    assert.equal(churn.totals.exposed_mrr, churn.series.reduce((sum: number, row: any) => sum + row.opening_mrr, 0));
  });
});

/* ========================================================================== *
 * 3. Reactivation
 * ========================================================================== */

describe('reactivation', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 4, 10)); });
  after(() => ws.close());

  test('an account that comes back is reactivation, not new business', async () => {
    const customer = await ws.customer('Bellamy Drivetrain');
    const first = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }],
      billing_cycle_anchor: UTC(2026, 4, 10),
      collection_method: 'send_invoice',
      days_until_due: 30,
    });

    await ws.travelTo(UTC(2026, 6, 20));
    await ws.ok('POST', `/v1/subscriptions/${first.id}/cancel`, {
      cancellation_reason: 'missing_features',
      comment: 'Wanted MES write-back before renewing.',
    });

    // Three months away, then back on a smaller plan.
    await ws.travelTo(UTC(2026, 9, 15));
    await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'starter_monthly' }],
      billing_cycle_anchor: UTC(2026, 9, 15),
      collection_method: 'send_invoice',
      days_until_due: 30,
    });
    await ws.travelTo(UTC(2026, 10, 5));

    const movement = await ws.ok('GET', '/v1/revenue/movement?months=12&top_movers=50');
    for (const row of movement.series) assertRowReconciles(row, 'after a return');
    assertSeriesChains(movement.series, 'after a return');

    assert.deepEqual(
      moversFor(movement, customer.id),
      [
        { month: '2026-04', kind: 'new', amount: GROWTH_MONTHLY },
        { month: '2026-06', kind: 'churn', amount: -GROWTH_MONTHLY },
        { month: '2026-09', kind: 'reactivation', amount: 9_900 },
      ],
      'a returning account is reactivation, and it is never counted as a new logo twice',
    );

    const september = movement.series.find((row: any) => row.month === '2026-09');
    assert.equal(september.counts.reactivated_accounts >= 1, true);
    assert.equal(september.counts.new_accounts, september.top_movers.filter((m: any) => m.kind === 'new').length);

    // The cohort still belongs to April: a return does not re-date a signup.
    const account = await ws.ok('GET', `/v1/revenue/accounts/${customer.id}`);
    assert.equal(account.cohort, '2026-04');
    assert.equal(account.mrr, 9_900);
  });
});

/* ========================================================================== *
 * 4. Cohorts
 * ========================================================================== */

describe('cohorts', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 6, 15)); });
  after(() => ws.close());

  test('each cohort is measured against its own first month', async () => {
    const report = await ws.ok('GET', '/v1/revenue/cohorts');
    assert.ok(report.series.length >= 6, 'eighteen months of seeded history gives several cohorts');

    for (const cohort of report.series) {
      assert.equal(cohort.cells[0].offset, 0);
      assert.equal(cohort.cells[0].month, cohort.cohort, 'offset 0 is the signup month itself');
      if (cohort.initial_mrr !== 0) {
        assert.equal(cohort.cells[0].net_revenue_retention.bps, 10_000, `${cohort.cohort} does not start at 100%`);
      }
      for (const cell of cohort.cells) {
        assert.equal(cell.logo_retention.denominator, cohort.accounts);
        assert.ok(cell.accounts <= cohort.accounts, 'a cohort can never retain more logos than it had');
        assert.equal(cell.net_revenue_retention.denominator, cohort.initial_mrr);
      }
    }

    // Every cohort is measured to the same last month: the one running now.
    const current = report.series[0].cells[report.series[0].cells.length - 1].month;
    for (const cohort of report.series) {
      assert.equal(cohort.cells[cohort.cells.length - 1].month, current, 'no cohort is padded past today');
    }

    const totals = report.totals;
    assert.equal(totals.cohorts, report.series.length);
    assert.ok(totals.by_offset[0].logo_retention.bps <= 10_000, 'a cohort cannot retain more than it started with');
    assert.equal(totals.by_offset[0].accounts, totals.accounts, 'every cohort has an offset-0 cell');
    assert.ok(
      report.series.some((row: any) => row.cells[0].logo_retention.bps === 10_000),
      'at least one cohort kept everyone through its first month',
    );
  });

  test('an account with no revenue is counted as unassigned, not dropped', async () => {
    const report = await ws.ok('GET', '/v1/revenue/cohorts');
    const assigned = report.series.reduce((sum: number, row: any) => sum + row.accounts, 0);
    const mrr = await ws.ok('GET', '/v1/revenue/mrr');
    assert.equal(
      assigned + report.totals.unassigned_accounts, mrr.sources.billing_customers,
      'every customer is either in a cohort or explicitly unassigned',
    );
  });
});

/* ========================================================================== *
 * 5. Deferred revenue and recognition
 * ========================================================================== */

describe('deferred revenue', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 2, 10)); });
  after(() => ws.close());

  test('a closed period is fully recognised: deferred plus recognised equals invoiced', async () => {
    const customer = await ws.customer('Ardent Tooling');
    await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }],
      billing_cycle_anchor: UTC(2026, 2, 10),
      collection_method: 'send_invoice',
      days_until_due: 30,
    });

    const periodEnd = UTC(2026, 3, 10);
    const raised = await ws.ok('GET', `/v1/invoices?customer=${customer.id}`);
    const first = raised.data.find((invoice: any) => invoice.period.start === UTC(2026, 2, 10));
    assert.ok(first, 'the first period was billed in advance');
    assert.equal(first.period.end, periodEnd);

    // Live through the period, so its service has genuinely been delivered.
    await ws.travelTo(periodEnd + 6 * 60 * 60 * 1000);

    const closed = await ws.ok('GET', `/v1/revenue/deferred?invoice=${first.id}&as_of=${periodEnd}`);
    assert.equal(closed.totals.invoiced, GROWTH_MONTHLY, 'one month was billed');
    assert.equal(closed.totals.recognised, GROWTH_MONTHLY, 'and by the close of the period all of it is earned');
    assert.equal(closed.totals.deferred_balance, 0, 'so nothing is deferred against a closed period');
    assert.equal(closed.reconciliation.balanced, true);
    assert.equal(closed.reconciliation.difference, 0);

    // Halfway through, the same line is part earned and part deferred, and the
    // two still add back to what was invoiced.
    const midpoint = UTC(2026, 2, 25);
    const mid = await ws.ok('GET', `/v1/revenue/deferred?invoice=${first.id}&as_of=${midpoint}`);
    assert.equal(mid.totals.invoiced, GROWTH_MONTHLY);
    assert.ok(mid.totals.recognised > 0 && mid.totals.recognised < GROWTH_MONTHLY, 'part earned, part not');
    assert.equal(mid.totals.recognised + mid.totals.deferred_balance, mid.totals.invoiced);
    assert.equal(mid.reconciliation.balanced, true);

    const line = mid.lines[0];
    assert.equal(line.days, 28, '10 February to 10 March is twenty-eight days of service');
    assert.equal(
      line.schedule.reduce((sum: number, day: any) => sum + day.amount, 0), line.amount,
      'the daily schedule sums back to the invoice line, to the cent',
    );
    assert.equal(
      line.schedule.filter((day: any) => day.recognised).length, 15,
      '10 February to 25 February is fifteen elapsed days of service',
    );
    assert.equal(
      line.recognised_to_date,
      line.schedule.filter((day: any) => day.recognised).reduce((sum: number, day: any) => sum + day.amount, 0),
    );
    assert.equal(line.deferred, line.amount - line.recognised_to_date);
  });

  test('the whole book reconciles, and every month states its balance', async () => {
    const report = await ws.ok('GET', '/v1/revenue/deferred?months=24');
    assert.equal(report.reconciliation.balanced, true, report.reconciliation.note ?? '');
    assert.equal(report.totals.invoiced, report.totals.recognised + report.totals.deferred_balance);
    for (const row of report.series) {
      assert.equal(
        row.invoiced_to_date, row.recognised_to_date + row.deferred_balance,
        `${row.month}: invoiced to date does not equal recognised plus deferred`,
      );
    }
    assert.ok(report.sources.billing_invoice_lines > 0);
    assert.ok(report.sources.recognition_days > report.sources.billing_invoice_lines, 'every line spans at least a day');
  });

  test('a voided invoice leaves the recognition schedule', async () => {
    const customer = await ws.customer('Verity Machine Works');
    await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'starter_monthly' }],
      collection_method: 'send_invoice',
      days_until_due: 30,
    });
    const before = await ws.ok('GET', `/v1/revenue/deferred?customer=${customer.id}`);
    assert.equal(before.totals.invoiced, 9_900);

    const invoices = await ws.ok('GET', `/v1/invoices?customer=${customer.id}`);
    const open = invoices.data.find((invoice: any) => invoice.status === 'open');
    assert.ok(open, 'the subscription raised a bill');
    await ws.ok('POST', `/v1/invoices/${open.id}/void`, {});

    const after = await ws.ok('GET', `/v1/revenue/deferred?customer=${customer.id}`);
    assert.equal(after.totals.invoiced, 0, 'a withdrawn bill is not revenue and never was');
    assert.equal(after.totals.recognised, 0);
    assert.equal(after.reconciliation.balanced, true);
  });
});

/* ========================================================================== *
 * 6. Collections
 * ========================================================================== */

describe('collections', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 6, 15)); });
  after(() => ws.close());

  test('the ageing buckets add up to the receivable', async () => {
    const report = await ws.ok('GET', '/v1/revenue/collections');
    const summed = report.ageing.buckets.reduce((sum: number, bucket: any) => sum + bucket.amount, 0);
    assert.equal(summed, report.ageing.total, 'the buckets are a partition of the book, not a sample of it');
    const pastDue = report.ageing.buckets
      .filter((bucket: any) => bucket.bucket !== 'not_yet_due')
      .reduce((sum: number, bucket: any) => sum + bucket.amount, 0);
    assert.equal(pastDue, report.ageing.past_due_total);
    assert.equal(report.totals.outstanding, report.ageing.total);
    const counted = report.ageing.buckets.reduce((sum: number, bucket: any) => sum + bucket.invoices, 0);
    assert.equal(counted, report.ageing.invoices);
  });

  test('DSO carries the two figures it was divided from', async () => {
    const report = await ws.ok('GET', '/v1/revenue/collections');
    const { dso, outstanding, billed, days_in_range: days } = report.totals;
    assert.equal(dso.denominator, billed);
    assert.equal(dso.numerator, outstanding * days);
    assert.ok(report.totals.dso_basis.includes(String(days)), 'the basis names the window it used');
  });

  test('a bill that is paid leaves the ageing, and a month-end balance is a real balance', async () => {
    const before = await ws.ok('GET', '/v1/revenue/collections');
    const customer = await ws.customer('Ostwald Presses');
    await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }],
      collection_method: 'send_invoice',
      days_until_due: 30,
    });

    const invoices = await ws.ok('GET', `/v1/invoices?customer=${customer.id}`);
    const open = invoices.data.find((invoice: any) => invoice.status === 'open');
    assert.ok(open, 'the account has an open bill');
    assert.equal(open.amount_due, GROWTH_MONTHLY);

    const withBill = await ws.ok('GET', '/v1/revenue/collections');
    assert.equal(withBill.ageing.total - before.ageing.total, GROWTH_MONTHLY);

    await ws.ok('POST', `/v1/invoices/${open.id}/pay`, { note: 'Bank transfer received.' });
    const settled = await ws.ok('GET', '/v1/revenue/collections');
    assert.equal(settled.ageing.total, before.ageing.total, 'a paid bill is no longer a receivable');
  });

  test('failed payments are reported as exposure with the recovery behind them', async () => {
    const report = await ws.ok('GET', '/v1/revenue/collections');
    assert.equal(typeof report.exposure.failed_payments, 'number');
    assert.equal(report.exposure.campaigns, report.recovery.at_risk_campaigns);
    assert.ok(report.exposure.note.length > 10);
    assert.equal(report.recovery.recovery_rate.denominator, report.recovery.amount_at_risk);
    assert.equal(report.recovery.recovery_rate.numerator, report.recovery.amount_recovered);
    const byStatus = report.recovery.by_status.reduce((sum: number, row: any) => sum + row.campaigns, 0);
    assert.equal(byStatus, report.recovery.campaigns_started);
  });
});

/* ========================================================================== *
 * 7. Usage economics
 * ========================================================================== */

describe('usage economics', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 6, 15)); });
  after(() => ws.close());

  test('metered value splits into what credit covered and what was charged', async () => {
    const report = await ws.ok('GET', '/v1/revenue/usage?months=24');
    for (const meter of report.meters) {
      assert.equal(
        meter.credit_covered + meter.charged, meter.metered_value,
        `${meter.name}: covered plus charged must be the whole metered value`,
      );
      assert.equal(meter.charged_share.denominator, meter.metered_value);
    }
    assert.equal(
      report.totals.credit_covered + report.totals.charged, report.totals.metered_value,
      'and the same holds across every meter',
    );
  });

  test('the invoiced mix is a partition of everything billed', async () => {
    const report = await ws.ok('GET', '/v1/revenue/usage?months=24');
    const summed = report.invoiced_mix.reduce((sum: number, row: any) => sum + row.amount, 0);
    assert.equal(summed, report.totals.invoiced);
    assert.equal(report.totals.overage_share_of_invoiced.denominator, report.totals.invoiced);
  });

  test('credit is reported in the unit it was granted in', async () => {
    const report = await ws.ok('GET', '/v1/revenue/usage?months=24');
    const monetary = report.credit.flows.find((flow: any) => flow.kind === 'monetary');
    const units = report.credit.flows.find((flow: any) => flow.kind === 'unit');
    assert.equal(monetary.micro, false, 'money is minor units');
    assert.equal(units.micro, true, 'a telemetry event is not a cent, and says so');
    assert.equal(report.credit.purchase_to_burn.numerator, report.credit.purchased);
    assert.equal(report.credit.purchase_to_burn.denominator, report.credit.burned);
  });
});

/* ========================================================================== *
 * 8. The time machine
 * ========================================================================== */

describe('a year through the time machine', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 6, 15)); });
  after(() => ws.close());

  test('every series still reconciles after 365 days of billing', async () => {
    const before = await ws.ok('GET', '/v1/revenue/movement?months=24');
    for (const row of before.series) assertRowReconciles(row, 'before travelling');

    const travelled = await ws.app.travel(365 * DAY);
    assert.ok(travelled.ran > 0, 'a year of renewals, dunning and credit expiry actually ran');

    const movement = await ws.ok('GET', '/v1/revenue/movement?months=36&top_movers=50');
    assert.deepEqual(movement.unbalanced_months, [], 'a year of billing left no month unbalanced');
    assert.equal(movement.balanced, true);
    for (const row of movement.series) assertRowReconciles(row, 'after a year');
    assertSeriesChains(movement.series, 'after a year');

    const mrr = await ws.ok('GET', '/v1/revenue/mrr?months=36');
    const billing = await ws.ok('GET', '/v1/subscriptions/overview');
    assert.equal(mrr.totals.mrr, billing.mrr, 'revenue still agrees with billing a year later');
    assert.equal(movement.series[movement.series.length - 1].closing, mrr.totals.mrr);

    const deferred = await ws.ok('GET', '/v1/revenue/deferred?months=36');
    assert.equal(deferred.reconciliation.balanced, true, deferred.reconciliation.note ?? '');
    assert.equal(deferred.totals.invoiced, deferred.totals.recognised + deferred.totals.deferred_balance);

    const churn = await ws.ok('GET', '/v1/revenue/churn?months=36');
    assert.deepEqual(churn.unbalanced_months, []);

    const collections = await ws.ok('GET', '/v1/revenue/collections?months=36');
    assert.equal(
      collections.ageing.buckets.reduce((sum: number, bucket: any) => sum + bucket.amount, 0),
      collections.ageing.total,
    );

    const summary = await ws.ok('GET', '/v1/revenue/summary?months=36');
    assert.equal(summary.balanced, true);
    assert.deepEqual(summary.warnings, []);
    assert.equal(summary.headline.mrr, mrr.totals.mrr, 'the summary never recomputes; it reads the same call');
    assert.equal(summary.headline.arr, mrr.totals.arr);
    assert.equal(summary.headline.deferred_balance, deferred.totals.deferred_balance);
    assert.equal(summary.headline.receivables, collections.totals.outstanding);
  });
});
