import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, frozenClock, type App } from '../src/server/app';
import revenue from '../src/server/modules/revenue/module';
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

/**
 * The hand calculation behind daily recognition: the straight line, `amount ×
 * elapsed ÷ days`, rounded half-up once in BigInt. Written longhand so it
 * shares no code with the module under test.
 */
function recognisedByHand(amount: number, days: number, elapsed: number): number {
  const numerator = BigInt(amount) * BigInt(elapsed);
  const quotient = numerator / BigInt(days);
  const remainder = numerator % BigInt(days);
  return Number(remainder * 2n >= BigInt(days) ? quotient + 1n : quotient);
}

/** Every movement row must satisfy the identity the endpoint claims to prove. */
function assertRowReconciles(row: any, where: string): void {
  const computed = row.opening + row.new_business + row.expansion + row.reactivation + row.resumed
    - row.contraction - row.churn - row.paused;
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

/**
 * Every money field a response publishes outside its `by_currency` blocks.
 *
 * The rule the whole module turns on is that one of these may only be a number
 * when exactly one currency is in scope, so the check has to be able to find
 * them all rather than trusting a list written by hand.
 */
const MONEY_KEYS = new Set([
  'mrr', 'arr', 'average_mrr_per_account', 'opening', 'closing', 'net', 'new_business', 'expansion',
  'reactivation', 'contraction', 'churn', 'opening_mrr', 'closing_mrr', 'churned_mrr', 'contraction_mrr',
  'expansion_mrr', 'reactivation_mrr', 'exposed_mrr', 'initial_mrr', 'invoiced', 'recognised',
  'invoiced_to_date', 'recognised_to_date', 'deferred_balance', 'unbilled_balance', 'billed', 'collected',
  'collected_on_billings', 'credited', 'written_off', 'outstanding', 'past_due', 'receivables',
  'metered_value', 'credit_covered', 'charged', 'usage_charged', 'run_rate', 'mrr_with_usage',
  'arr_with_usage', 'trialing_mrr', 'paused_mrr', 'net_new_mrr_this_month', 'past_due_total',
  'amount_at_risk', 'amount_recovered', 'failed_payments', 'over_90_days', 'uncollectible_in_range',
  'lifetime_billed', 'purchased', 'burned_against_usage', 'outstanding_monetary', 'credit_purchased',
  'credit_burned', 'metered_share_of_invoiced', 'overage_share_of_invoiced', 'net_revenue_retention',
  'gross_revenue_retention', 'gross_revenue_churn', 'dso', 'collection_rate', 'recovery_rate',
  'paused', 'resumed', 'paused_mrr', 'resumed_mrr', 'paused_share', 'invoiced_gross', 'unbilled',
  'unbilled_usage', 'usage_unbilled', 'settled',
]);

/**
 * Walk a response and collect every money field that carries a value without
 * naming the currency it is in.
 *
 * The rule is encoded rather than listed: any object that carries its own
 * `currency` string has said what its figures mean, so it is skipped along with
 * everything under it — a meter, an invoice line, a `by_currency` row, a cadence
 * line. Anything else that holds a money field must hold `null` when the book
 * spans more than one currency.
 */
function scalarMoney(node: unknown, path = '', found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((item, i) => scalarMoney(item, `${path}[${i}]`, found));
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  const record = node as Record<string, unknown>;
  if (typeof record.currency === 'string') return found;
  for (const [key, value] of Object.entries(record)) {
    const where = path ? `${path}.${key}` : key;
    // A money key holding a number is a stated amount; holding a Ratio or a
    // Decimal2 it is a rate weighted by money, which is the same claim wearing
    // a percent sign. Anything else under that key is a block to walk into.
    const rate = !!value && typeof value === 'object' && ('bps' in value || 'scaled' in value);
    if (MONEY_KEYS.has(key) && (typeof value === 'number' || rate)) { found.push(where); continue; }
    scalarMoney(value, where, found);
  }
  return found;
}

/* ========================================================================== *
 * 1. MRR and ARR
 * ========================================================================== */

describe('MRR and ARR', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 6, 15)); });
  after(() => ws.close());

  test('the headline figure is billing\'s own, to the cent — in each currency it is billed in', async () => {
    const revenue = await ws.ok('GET', '/v1/revenue/mrr');
    const billing = await ws.ok('GET', '/v1/subscriptions/overview');

    // Northwind bills in three currencies, so there is no dollar figure for the
    // book and this module refuses to write one down. Every minor unit billing
    // knows about is still accounted for — one currency at a time.
    assert.equal(revenue.totals.mrr, null, 'a mixed book publishes no scalar MRR');
    assert.equal(revenue.currency, null, 'and labels nothing with a currency it is not in');
    const sum = (rows: any[], key: string) => rows.reduce((total: number, row: any) => total + row[key], 0);
    assert.equal(sum(revenue.by_currency, 'mrr'), billing.mrr, 'nothing is lost: the parts are billing\'s own total');
    assert.equal(sum(revenue.not_yet_revenue.by_currency, 'trialing_mrr'), billing.trial_mrr);

    const usd = await ws.ok('GET', '/v1/revenue/mrr?currency=usd');
    const fromMixed = revenue.by_currency.find((row: any) => row.currency === 'usd');
    assert.equal(usd.totals.mrr, fromMixed.mrr, 'the dollar book is the same figure either way it is asked for');
    assert.equal(usd.totals.arr, usd.totals.mrr * 12, 'ARR is twelve months of MRR, exactly');
    assert.equal(usd.currency, 'usd');
  });

  test('an annual subscription normalises to the month, matching a hand calculation', async () => {
    const before = await ws.ok('GET', '/v1/revenue/mrr?currency=usd');
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

    const after = await ws.ok('GET', '/v1/revenue/mrr?currency=usd');
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

    const report = await ws.ok('GET', '/v1/revenue/mrr?currency=usd');
    assert.ok(report.usage.basis.length > 40, 'the usage run rate states its own basis in the response');
    assert.equal(report.usage.mrr_with_usage, report.totals.mrr + report.usage.run_rate);
  });

  test('the part of MRR that is gross of tax is named, not left to be discovered', async () => {
    const before = await ws.ok('GET', '/v1/revenue/mrr?currency=usd');
    assert.equal(before.tax.inclusive_mrr, 0, 'Northwind\'s list prices are all tax-exclusive');

    const product = await ws.ok('POST', '/v1/products', {
      name: 'Telemetry on inclusive terms',
      description: 'The same plan sold at a tax-inclusive list price.',
    });
    const price = await ws.ok('POST', '/v1/prices', {
      product: product.id,
      currency: 'usd',
      unit_amount: GROWTH_MONTHLY,
      recurring: { interval: 'month' },
      tax_behavior: 'inclusive',
    });
    const customer = await ws.customer('Inclusive Terms Holdings');
    await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: price.id }],
      collection_method: 'send_invoice',
      days_until_due: 30,
    });

    const after = await ws.ok('GET', '/v1/revenue/mrr?currency=usd');
    assert.equal(after.totals.mrr - before.totals.mrr, GROWTH_MONTHLY, 'the contract is worth what it says');
    assert.equal(
      after.tax.inclusive_mrr, GROWTH_MONTHLY,
      'and every cent of it is gross of tax, which is why recognition will book less than this',
    );
    assert.equal(after.tax.inclusive_subscriptions, 1);
    assert.ok(after.tax.inclusive_mrr <= after.totals.mrr, 'the part can never exceed the whole');
    assert.ok(after.tax.note.includes('gross of tax'));

    const account = await ws.ok(`GET`, `/v1/revenue/accounts/${customer.id}`);
    assert.equal(account.subscriptions[0].tax_inclusive_mrr, GROWTH_MONTHLY, 'and it is visible per subscription');
  });

  test('every endpoint carries a basis and the row counts it read', async () => {
    for (const path of ['mrr', 'movement', 'churn', 'cohorts', 'deferred', 'collections', 'usage', 'summary']) {
      const body = await ws.ok('GET', `/v1/revenue/${path}`);
      assert.ok(body.basis, `${path} has no basis`);
      assert.ok(body.basis.summary.length > 20, `${path} basis has no summary`);
      assert.ok(Array.isArray(body.basis.rules) && body.basis.rules.length >= 3, `${path} states fewer than three rules`);
      assert.ok(body.basis.currency.note.length > 20, `${path} does not explain its currency handling`);
      assert.equal(typeof body.basis.currency.single, 'object', `${path} does not say which currency it is in`);
      assert.ok(Array.isArray(body.warnings), `${path} carries no warnings array`);
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
    const summary = await ws.ok('GET', '/v1/revenue/summary?months=12&currency=usd');
    const mrr = await ws.ok('GET', '/v1/revenue/mrr?months=12&currency=usd');
    const movement = await ws.ok('GET', '/v1/revenue/movement?months=12&currency=usd');
    const deferred = await ws.ok('GET', '/v1/revenue/deferred?months=12&currency=usd');
    const collections = await ws.ok('GET', '/v1/revenue/collections?months=12&currency=usd');
    const usage = await ws.ok('GET', '/v1/revenue/usage?months=12&currency=usd');

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
    assert.equal(mixed.basis.currency.single, null);

    const eur = await ws.ok('GET', '/v1/revenue/mrr?currency=eur');
    assert.equal(eur.basis.currency.mode, 'single');
    assert.equal(eur.basis.currency.single, 'eur');
    assert.equal(eur.warnings.length, 0, 'a single-currency answer needs no caveat');
    const fromMixed = mixed.by_currency.find((row: any) => row.currency === 'eur');
    assert.equal(eur.totals.mrr, fromMixed.mrr, 'the euro book is the same either way it is asked for');
    assert.equal(eur.totals.average_mrr_per_account, fromMixed.average_mrr_per_account);
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
    const mixed = await ws.ok('GET', '/v1/revenue/movement?months=24');
    assert.equal(mixed.balanced, true, 'the mixed book reconciles in every one of its currencies');
    for (const part of mixed.by_currency) {
      assert.deepEqual(part.unbalanced_months, [], `${part.currency} does not reconcile`);
      assert.equal(part.totals.opening + part.totals.net, part.totals.closing, `${part.currency} does not close`);
    }
    for (const row of mixed.series) {
      for (const part of row.by_currency) {
        const computed = part.opening + part.new_business + part.expansion + part.reactivation + part.resumed
          - part.contraction - part.churn - part.paused;
        assert.equal(computed, part.closing, `${row.month} ${part.currency}: movements do not close the month`);
      }
    }

    const movement = await ws.ok('GET', '/v1/revenue/movement?months=24&currency=usd');
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
    const movement = await ws.ok('GET', '/v1/revenue/movement?currency=usd');
    const mrr = await ws.ok('GET', '/v1/revenue/mrr?currency=usd');
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
    const movement = await ws.ok('GET', '/v1/revenue/movement?months=12&top_movers=50&currency=usd');
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

    const movement = await ws.ok('GET', '/v1/revenue/movement?months=24&top_movers=50&currency=usd');
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

  test('churn, retention and pauses add up to one, and every rate shows its fraction', async () => {
    const churn = await ws.ok('GET', '/v1/revenue/churn?months=12&currency=usd');
    assert.ok(churn.series.some((row: any) => row.paused_mrr > 0), 'the seeded book pauses an account, which is what makes the third share real');
    for (const row of churn.series) {
      if (row.opening_mrr === 0) continue;
      // Rounding happens once per rate, so three rounded shares can sit a
      // basis point either side of 100%; the exact fractions cannot.
      assert.equal(
        row.gross_revenue_churn.numerator + row.gross_revenue_retention.numerator + row.paused_share.numerator,
        row.opening_mrr,
        `${row.month}: churn ${row.gross_revenue_churn.percent}, retention ${row.gross_revenue_retention.percent} and paused ${row.paused_share.percent} do not partition the opening book`,
      );
      assert.equal(row.gross_revenue_churn.denominator, row.opening_mrr, 'the rate names the base it was divided by');
      assert.equal(row.gross_revenue_churn.numerator, row.churned_mrr + row.contraction_mrr);
      assert.equal(row.paused_share.numerator, row.paused_mrr, 'a pause is neither churn nor retention');
      assert.equal(
        row.net_revenue_retention.numerator,
        row.opening_mrr - row.churned_mrr - row.contraction_mrr - row.paused_mrr
          + row.expansion_mrr + row.reactivation_mrr + row.resumed_mrr,
        'net retention is what the opening accounts close at: retained plus expansion, reactivation and resumed collection',
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

    const movement = await ws.ok('GET', '/v1/revenue/movement?months=12&top_movers=50&currency=usd');
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
    const report = await ws.ok('GET', '/v1/revenue/cohorts?currency=usd');
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
    const report = await ws.ok('GET', '/v1/revenue/cohorts?currency=usd');
    const assigned = report.series.reduce((sum: number, row: any) => sum + row.accounts, 0);
    const mrr = await ws.ok('GET', '/v1/revenue/mrr?currency=usd');
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
    const mixed = await ws.ok('GET', '/v1/revenue/deferred?months=24');
    assert.equal(mixed.reconciliation.balanced, true, mixed.reconciliation.note ?? '');
    for (const part of mixed.by_currency) {
      assert.equal(part.reconciliation.balanced, true, `${part.currency}: ${part.reconciliation.note}`);
      assert.equal(part.totals.invoiced, part.totals.recognised + part.totals.deferred_balance);
    }
    // The identity above cannot fail; these are the checks that can.
    for (const check of mixed.reconciliation.checks) {
      assert.equal(check.ok, true, `${check.name}: expected ${check.expected}, got ${check.actual}`);
      assert.equal(check.difference, check.actual - check.expected);
    }
    assert.ok(
      mixed.reconciliation.checks.some((check: any) => check.name === 'schedule_sums_to_line'),
      'the schedule is re-summed against the line it came from',
    );

    const report = await ws.ok('GET', '/v1/revenue/deferred?months=24&currency=usd');
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
    const report = await ws.ok('GET', '/v1/revenue/collections?currency=usd');
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
    const report = await ws.ok('GET', '/v1/revenue/collections?currency=usd');
    const { dso, outstanding, billed, days_in_range: days } = report.totals;
    assert.equal(dso.denominator, billed);
    assert.equal(dso.numerator, outstanding * days);
    assert.ok(report.totals.dso_basis.includes(String(days)), 'the basis names the window it used');
  });

  test('a bill that is paid leaves the ageing, and a month-end balance is a real balance', async () => {
    const before = await ws.ok('GET', '/v1/revenue/collections?currency=usd');
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

    const withBill = await ws.ok('GET', '/v1/revenue/collections?currency=usd');
    assert.equal(withBill.ageing.total - before.ageing.total, GROWTH_MONTHLY);

    await ws.ok('POST', `/v1/invoices/${open.id}/pay`, { note: 'Bank transfer received.' });
    const settled = await ws.ok('GET', '/v1/revenue/collections?currency=usd');
    assert.equal(settled.ageing.total, before.ageing.total, 'a paid bill is no longer a receivable');
  });

  test('failed payments are reported as exposure with the recovery behind them', async () => {
    const report = await ws.ok('GET', '/v1/revenue/collections?currency=usd');
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

  test('metered value splits into what credit covered and what was charged, and what was charged is billed or unbilled', async () => {
    const report = await ws.ok('GET', '/v1/revenue/usage?months=24');
    for (const meter of report.meters) {
      assert.equal(
        meter.settled.credit_covered + meter.settled.charged, meter.metered_value,
        `${meter.name}: covered plus charged must be the whole metered value, as the settlement priced it`,
      );
      assert.equal(meter.settled.net_charged, meter.settled.charged + meter.settled.true_ups);
      assert.equal(
        meter.settled.invoiced + meter.unbilled, meter.settled.net_charged,
        `${meter.name}: every settled charge is on a finalised invoice or it is unbilled`,
      );
      assert.equal(meter.charged_share.denominator, meter.metered_value);
      assert.equal(meter.charged_share.numerator, meter.settled.net_charged);
    }
    for (const part of report.by_currency) {
      assert.equal(
        part.totals.settled.credit_covered + part.totals.settled.charged, part.totals.metered_value,
        `${part.currency}: and the same holds across every meter in the currency`,
      );
      assert.equal(part.totals.settled.invoiced + part.totals.unbilled, part.totals.settled.net_charged);
    }
    const split = report.reconciliation.checks.find((check: any) => check.name === 'settlement_components_match');
    assert.equal(split.ok, true, 'the settlement columns are checked against each other, not assumed');
    const bridge = report.reconciliation.checks.find((check: any) => check.name === 'invoice_lines_carry_the_settled_amount');
    assert.equal(bridge.ok, true, `${bridge.description}: expected ${bridge.expected}, got ${bridge.actual}`);
  });

  test('the invoiced mix is a partition of everything billed', async () => {
    const report = await ws.ok('GET', '/v1/revenue/usage?months=24&currency=usd');
    const summed = report.invoiced_mix.reduce((sum: number, row: any) => sum + row.amount, 0);
    assert.equal(summed, report.totals.invoiced);
    assert.equal(report.totals.overage_share_of_invoiced.denominator, report.totals.invoiced);
    for (const row of report.invoiced_mix) assert.equal(row.currency, 'usd', 'every mix line names its currency');
  });

  test('credit is reported in the unit it was granted in', async () => {
    const report = await ws.ok('GET', '/v1/revenue/usage?months=24&currency=usd');
    const monetary = report.credit.flows.find((flow: any) => flow.kind === 'monetary');
    const units = report.credit.flows.find((flow: any) => flow.kind === 'unit');
    assert.equal(monetary.micro, false, 'money is minor units');
    assert.equal(units.micro, true, 'a telemetry event is not a cent, and says so');
    assert.equal(report.credit.purchase_to_burn.numerator, report.credit.purchased);
    assert.equal(report.credit.purchase_to_burn.denominator, report.credit.burned_against_usage);
  });

  test('the credit ledger adds up, and every type in it is named', async () => {
    const report = await ws.ok('GET', '/v1/revenue/usage?months=24');
    assert.equal(report.balanced, true, report.reconciliation.note ?? '');

    const flows = report.by_currency.flatMap((part: any) => part.credit.flows);
    assert.ok(flows.length >= 2, 'a monetary and a unit ledger per currency');
    for (const flow of flows) {
      // Signed, as a ledger is: the named components add up to the movement,
      // and `other` catches anything this report does not name so nothing can
      // go missing between the two.
      const components = flow.granted + flow.rolled_in + flow.rolled_out + flow.burned + flow.expired
        + flow.refunded + flow.voided + flow.adjusted + flow.other_total;
      assert.equal(
        components, flow.balance,
        `${flow.currency} ${flow.kind}: components ${components} but the ledger moved ${flow.balance}`,
      );
      assert.equal(flow.reconciliation.balanced, true);
      assert.ok(flow.burned <= 0, 'burning credit takes credit away, so it is reported negative');
      assert.ok(flow.granted >= 0, 'a grant adds credit');
      assert.deepEqual(flow.other, [], `${flow.currency} ${flow.kind}: ${JSON.stringify(flow.other)} is unaccounted for`);
    }
    for (const check of report.reconciliation.checks) {
      assert.equal(check.ok, true, `${check.name}: expected ${check.expected}, got ${check.actual}`);
    }
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
    const before = await ws.ok('GET', '/v1/revenue/movement?months=24&currency=usd');
    for (const row of before.series) assertRowReconciles(row, 'before travelling');

    const travelled = await ws.app.travel(365 * DAY);
    assert.ok(travelled.ran > 0, 'a year of renewals, dunning and credit expiry actually ran');

    const mixed = await ws.ok('GET', '/v1/revenue/movement?months=36');
    assert.equal(mixed.balanced, true, 'every currency reconciles a year later');
    for (const part of mixed.by_currency) assert.deepEqual(part.unbalanced_months, [], part.currency);

    const movement = await ws.ok('GET', '/v1/revenue/movement?months=36&top_movers=50&currency=usd');
    assert.deepEqual(movement.unbalanced_months, [], 'a year of billing left no month unbalanced');
    assert.equal(movement.balanced, true);
    for (const row of movement.series) assertRowReconciles(row, 'after a year');
    assertSeriesChains(movement.series, 'after a year');

    const mrr = await ws.ok('GET', '/v1/revenue/mrr?months=36');
    const billing = await ws.ok('GET', '/v1/subscriptions/overview');
    assert.equal(
      mrr.by_currency.reduce((sum: number, row: any) => sum + row.mrr, 0), billing.mrr,
      'revenue still agrees with billing a year later, currency by currency',
    );
    const usd = await ws.ok('GET', '/v1/revenue/mrr?months=36&currency=usd');
    assert.equal(movement.series[movement.series.length - 1].closing, usd.totals.mrr);

    const deferred = await ws.ok('GET', '/v1/revenue/deferred?months=36&currency=usd');
    assert.equal(deferred.reconciliation.balanced, true, deferred.reconciliation.note ?? '');
    assert.equal(deferred.totals.invoiced, deferred.totals.recognised + deferred.totals.deferred_balance);
    for (const check of deferred.reconciliation.checks) assert.equal(check.ok, true, check.name);

    const churn = await ws.ok('GET', '/v1/revenue/churn?months=36&currency=usd');
    assert.deepEqual(churn.unbalanced_months, []);

    const collections = await ws.ok('GET', '/v1/revenue/collections?months=36&currency=usd');
    assert.equal(
      collections.ageing.buckets.reduce((sum: number, bucket: any) => sum + bucket.amount, 0),
      collections.ageing.total,
    );

    const usage = await ws.ok('GET', '/v1/revenue/usage?months=36');
    assert.equal(usage.balanced, true, usage.reconciliation.note ?? '');

    const summary = await ws.ok('GET', '/v1/revenue/summary?months=36&currency=usd');
    assert.equal(summary.balanced, true);
    assert.deepEqual(summary.warnings, [], 'a single-currency year of billing raises nothing to warn about');
    assert.equal(summary.headline.mrr, usd.totals.mrr, 'the summary never recomputes; it reads the same call');
    assert.equal(summary.headline.arr, usd.totals.arr);
    assert.equal(summary.headline.deferred_balance, deferred.totals.deferred_balance);
    assert.equal(summary.headline.receivables, collections.totals.outstanding);
  });
});

/* ========================================================================== *
 * 9. The rules that make a figure safe to read
 *
 * One test per way this module used to state something untrue: a headline in no
 * currency, a window that quietly answered a different question, a closed month
 * that moved when an unrelated row was written, and a ledger that did not add up.
 * ========================================================================== */

describe('a book in more than one currency', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 6, 15)); });
  after(() => ws.close());

  test('no endpoint states a money figure that is true in no currency', async () => {
    for (const path of ['mrr', 'movement', 'churn', 'cohorts', 'deferred', 'collections', 'usage', 'summary']) {
      const body = await ws.ok('GET', `/v1/revenue/${path}?months=12`);
      assert.equal(body.basis.currency.mode, 'mixed', `${path} should see all three of Northwind's currencies`);
      assert.equal(body.currency, null, `${path} labels a mixed book with a currency it is not in`);
      const stated = scalarMoney(body);
      assert.deepEqual(stated, [], `${path} states ${stated.join(', ')} across three currencies`);
      assert.ok(
        body.warnings.some((warning: string) => warning.includes('no exchange rates')),
        `${path} publishes nulls without saying why`,
      );
    }
  });

  test('the by_currency block is exact, and asking for one currency brings the scalars back', async () => {
    const mixed = await ws.ok('GET', '/v1/revenue/mrr');
    assert.deepEqual(mixed.basis.currency.currencies, ['eur', 'gbp', 'usd']);

    for (const row of mixed.by_currency) {
      const one = await ws.ok('GET', `/v1/revenue/mrr?currency=${row.currency}`);
      assert.equal(one.totals.mrr, row.mrr, `${row.currency} disagrees with itself`);
      assert.equal(one.totals.arr, row.arr);
      assert.equal(one.totals.accounts, row.accounts);
      assert.equal(one.currency, row.currency);
      assert.deepEqual(scalarMoney({ ...one, currency: null }).length > 0, true, 'a single-currency answer has figures in it');
    }
  });

  test('a yen subscription is not a thousand dollars', async () => {
    // 100,000 minor units is ¥100,000, BHD 100.000 and $1,000.00 — three very
    // different amounts of money. Adding them as integers, which is what a
    // mixed total did, valued the yen and the dinar at the dollar figure.
    const product = await ws.ok('POST', '/v1/products', {
      name: 'Telemetry, regional terms',
      description: 'The same telemetry plan sold on local paper in Tokyo and Manama.',
    });
    const openBook = async (currency: string, name: string) => {
      const price = await ws.ok('POST', '/v1/prices', {
        product: product.id, currency, unit_amount: 100_000, recurring: { interval: 'month' },
      });
      const customer = await ws.customer(name, { currency });
      await ws.ok('POST', '/v1/subscriptions', {
        customer: customer.id,
        items: [{ price: price.id }],
        collection_method: 'send_invoice',
        days_until_due: 30,
      });
      return customer;
    };
    const usdBefore = (await ws.ok('GET', '/v1/revenue/mrr?currency=usd')).totals.mrr;
    const yen = await openBook('jpy', 'Kanto Precision Robotics');
    await openBook('bhd', 'Manama Automation Works');

    const mrr = await ws.ok('GET', '/v1/revenue/mrr');
    assert.equal(mrr.totals.mrr, null, 'five currencies, no total');
    const inCurrency = (code: string) => mrr.by_currency.find((row: any) => row.currency === code);
    assert.equal(inCurrency('jpy').mrr, 100_000, '¥100,000 a month, stated in yen');
    assert.equal(inCurrency('bhd').mrr, 100_000, 'BHD 100.000 a month, stated in dinar');
    assert.equal(inCurrency('usd').mrr, usdBefore, 'and the dollar book did not move by a cent');

    const accounts = await ws.ok('GET', '/v1/revenue/accounts?limit=500');
    assert.equal(accounts.currency, null);
    const order: string[] = [];
    for (const row of accounts.data) if (order[order.length - 1] !== row.currency) order.push(row.currency);
    assert.equal(new Set(order).size, order.length, 'the list is grouped by currency, not interleaved by size');
    for (const currency of order) {
      const group = accounts.data.filter((row: any) => row.currency === currency);
      for (let i = 1; i < group.length; i++) {
        assert.ok(group[i - 1].mrr >= group[i].mrr, `${currency} is not ranked inside its own group`);
      }
    }
    const yenGroup = accounts.groups.find((group: any) => group.currency === 'jpy');
    assert.equal(yenGroup.mrr, 100_000);
    assert.equal(yenGroup.accounts, 1);
    assert.ok(
      accounts.warnings.some((warning: string) => warning.includes('grouped by currency')),
      'the list says it is grouped rather than ranked',
    );

    const one = await ws.ok('GET', '/v1/revenue/accounts?currency=jpy');
    assert.equal(one.currency, 'jpy');
    assert.equal(one.data.length, 1);
    assert.equal(one.data[0].customer, yen.id);
  });

  test('the copilot is handed no figure it could state wrongly', async () => {
    const tools = revenue.tools?.(ws.app.ctx) ?? [];
    const meta = { orgId: ORG };
    const run = (name: string, args: Record<string, unknown> = {}) => {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool, `${name} is not registered`);
      return tool.run(args, ws.app.ctx, meta) as Promise<any>;
    };

    const mixed = await run('revenue_summary');
    assert.equal(mixed.mrr, null);
    assert.equal(mixed.currency_mode, 'mixed');
    assert.deepEqual(
      Object.keys(mixed).filter((key) => key.endsWith('_display')), [],
      'a mixed book gets no formatted total to read out',
    );
    const usdRow = mixed.by_currency.find((row: any) => row.currency === 'usd');
    assert.equal(usdRow.mrr_display, '$38,873.66');
    assert.equal(mixed.by_currency.find((row: any) => row.currency === 'eur').mrr_display, '€15,279.17');
    assert.equal(mixed.by_currency.find((row: any) => row.currency === 'gbp').mrr_display, '£2,285.00');
    assert.ok(mixed.currency_note.includes('no exchange-rate table'));

    const single = await run('revenue_summary', { currency: 'usd' });
    assert.equal(single.currency_mode, 'single');
    assert.equal(single.mrr_display, usdRow.mrr_display, 'one currency in scope, one figure to state');
    assert.equal(single.mrr, usdRow.mrr);

    const collections = await run('revenue_collections');
    assert.equal(collections.outstanding, null);
    assert.ok(!('outstanding_display' in collections));
    assert.equal(collections.dso_days, null, 'a DSO across currencies is a ratio of two different things');
    for (const row of collections.by_currency) {
      assert.equal(typeof row.outstanding_display, 'string');
      assert.equal(typeof row.dso_days, 'string');
    }

    const movement = await run('revenue_movement');
    for (const month of movement.months) {
      for (const mover of month.movers) {
        assert.ok(/[$€£¥]|BHD/.test(mover), `a mover is quoted without its currency: ${mover}`);
      }
    }
  });
});

describe('a reporting window longer than the report draws', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 6, 15)); });
  after(() => ws.close());

  test('the months that survive are the recent ones, and the ones that went are named', async () => {
    const wide = await ws.ok('GET', '/v1/revenue/summary?from=1990-01-01');
    const now = await ws.ok('GET', '/v1/revenue/summary?months=12');

    assert.equal(wide.series.length, 120, 'the cap is 120 months');
    assert.equal(
      wide.series[wide.series.length - 1].month, now.series[now.series.length - 1].month,
      'a request that includes today is answered with today, not with the 1990s',
    );
    assert.ok(wide.window_clipped, 'the clip is reported');
    assert.equal(wide.window_clipped.requested_months, 438);
    assert.equal(wide.window_clipped.months_drawn, 120);
    assert.equal(wide.window_clipped.dropped_months, 318);
    assert.equal(wide.window_clipped.dropped_from, '1990-01');
    assert.equal(wide.window_clipped.dropped_to, '2016-06');
    assert.equal(wide.series[0].month, '2016-07');
    assert.ok(
      wide.warnings.some((warning: string) => warning.includes('1990-01') && warning.includes('2016-06')),
      'and named in the warnings, not only in a field nobody reads',
    );
    assert.equal(now.window_clipped, null, 'a window that fits is not reported as clipped');

    // The clip is independent of the subscription cap, which is not tripped here.
    assert.equal(wide.truncated, false);
  });

  test('a decade-wide request still finds its cohorts and its retention', async () => {
    const cohorts = await ws.ok('GET', '/v1/revenue/cohorts?from=1990-01-01&currency=usd');
    const twoYears = await ws.ok('GET', '/v1/revenue/cohorts?months=24&currency=usd');
    assert.ok(cohorts.totals.cohorts > 0, 'a wide window used to report zero cohorts');
    assert.equal(cohorts.totals.cohorts, twoYears.totals.cohorts, 'and the same ones a narrow window finds');
    assert.equal(cohorts.totals.unassigned_accounts, twoYears.totals.unassigned_accounts);

    const churn = await ws.ok('GET', '/v1/revenue/churn?from=1990-01-01&currency=usd');
    assert.ok(churn.totals.exposed_mrr > 0, 'retention over a wide window is a real rate, not n/a');
    assert.notEqual(churn.totals.net_revenue_retention.percent, 'n/a');
  });
});

describe('a collection pause', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 2, 15)); });
  after(() => ws.close());

  test('is dated where it happened, and stays there when the row is written again', async () => {
    const customer = await ws.customer('Pause Repro Fabrication');
    const sub = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }],
      billing_cycle_anchor: UTC(2026, 2, 15),
      collection_method: 'send_invoice',
      days_until_due: 30,
    });
    assert.equal(sub.mrr, GROWTH_MONTHLY);

    await ws.travelTo(UTC(2026, 3, 15));
    const paused = await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, { behavior: 'keep_as_draft' });
    assert.equal(paused.status, 'paused');

    const atThePause = await ws.ok('GET', `/v1/revenue/accounts/${customer.id}?months=6`);
    const monthOf = (report: any, month: string) => report.series.find((row: any) => row.month === month).mrr;
    assert.equal(monthOf(atThePause, '2026-02'), GROWTH_MONTHLY, 'February was collected');
    assert.equal(monthOf(atThePause, '2026-03'), 0, 'March was not');

    // Three months of keep_as_draft renewals, each of which writes the
    // subscription row — and used to move the pause with it.
    await ws.travelTo(UTC(2026, 6, 10));
    const later = await ws.ok('GET', `/v1/revenue/accounts/${customer.id}?months=6`);
    assert.equal(monthOf(later, '2026-02'), GROWTH_MONTHLY);
    assert.equal(monthOf(later, '2026-03'), 0, 'March is still zero three months later');
    assert.equal(monthOf(later, '2026-04'), 0, 'and April was never collected either');
    assert.equal(monthOf(later, '2026-05'), 0);

    const movement = await ws.ok('GET', '/v1/revenue/movement?months=6&top_movers=50&currency=usd');
    assert.deepEqual(
      moversFor(movement, customer.id),
      [
        { month: '2026-02', kind: 'new', amount: GROWTH_MONTHLY },
        { month: '2026-03', kind: 'paused', amount: -GROWTH_MONTHLY },
      ],
      'the pause is booked in the month collection stopped, not the month of the last renewal — and as a pause, not churn',
    );
    for (const row of movement.series) assertRowReconciles(row, 'across a pause');

    const timeline = later.subscriptions.find((line: any) => line.subscription === sub.id);
    assert.equal(timeline.ended_because, 'collection_paused');
    assert.equal(timeline.pauses.length, 1);
    assert.equal(timeline.pauses[0].from, UTC(2026, 3, 15), 'the pause is dated from the event, to the millisecond');
    assert.equal(timeline.pauses[0].inferred, false, 'and it was read, not guessed');
  });

  test('that is lifted is a hole in the history, not the end of it', async () => {
    const customer = await ws.customer('Ridgeway Interlock');
    const sub = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }],
      billing_cycle_anchor: ws.now(),
      collection_method: 'send_invoice',
      days_until_due: 30,
    });

    await ws.travelTo(UTC(2026, 8, 5));
    await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, { behavior: 'keep_as_draft' });
    await ws.travelTo(UTC(2026, 10, 6));
    const resumed = await ws.ok('POST', `/v1/subscriptions/${sub.id}/resume`, {});
    assert.equal(resumed.status, 'active');
    await ws.travelTo(UTC(2026, 11, 20));

    const account = await ws.ok('GET', `/v1/revenue/accounts/${customer.id}?months=12`);
    const monthOf = (month: string) => account.series.find((row: any) => row.month === month).mrr;
    assert.equal(monthOf('2026-07'), GROWTH_MONTHLY, 'collected before the pause');
    assert.equal(monthOf('2026-08'), 0, 'nothing while it was paused');
    assert.equal(monthOf('2026-09'), 0);
    assert.equal(monthOf('2026-10'), GROWTH_MONTHLY, 'and back the month collection resumed');
    assert.equal(monthOf('2026-11'), GROWTH_MONTHLY);

    const timeline = account.subscriptions.find((line: any) => line.subscription === sub.id);
    assert.equal(timeline.ended_because, null, 'the subscription never ended');
    assert.equal(timeline.pauses.length, 1);
    assert.equal(timeline.pauses[0].from, UTC(2026, 8, 5));
    assert.equal(timeline.pauses[0].to, UTC(2026, 10, 6));

    const movement = await ws.ok('GET', '/v1/revenue/movement?months=12&top_movers=50&currency=usd');
    const mine = moversFor(movement, customer.id);
    const signedUp = new Date(sub.start_date).toISOString().slice(0, 7);
    assert.deepEqual(
      mine.map((mover) => `${mover.month} ${mover.kind}`),
      [`${signedUp} new`, '2026-08 paused', '2026-10 resumed'],
      'a pause reads as paused and its lifting as resumed, both on their own dates, and neither is churn',
    );
    for (const row of movement.series) assertRowReconciles(row, 'across a pause and a resume');
  });

  test('is not churn: the logo stays in the book, the revenue is a third share, and cancelling while paused is what churns it', async () => {
    await ws.travelTo(UTC(2026, 12, 1));
    const customer = await ws.customer('Selkirk Gantry Systems');
    const sub = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }],
      billing_cycle_anchor: ws.now(),
      collection_method: 'send_invoice',
      days_until_due: 30,
    });
    await ws.travelTo(UTC(2027, 1, 12));
    const before = await ws.ok('GET', '/v1/revenue/churn?months=3&currency=usd');
    const januaryBefore = before.series.find((row: any) => row.month === '2027-01');

    await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, { behavior: 'keep_as_draft' });
    const paused = await ws.ok('GET', '/v1/revenue/churn?months=3&currency=usd');
    const january = paused.series.find((row: any) => row.month === '2027-01');
    assert.equal(january.churned_accounts, januaryBefore.churned_accounts, 'a pause does not churn the logo');
    assert.equal(january.churned_mrr, januaryBefore.churned_mrr, 'nor its revenue');
    assert.equal(january.paused_accounts, januaryBefore.paused_accounts + 1, 'it is counted as paused');
    assert.equal(january.paused_mrr, januaryBefore.paused_mrr + GROWTH_MONTHLY);
    assert.equal(january.accounts_at_open, januaryBefore.accounts_at_open, 'the denominator does not move: the account is still a contract');
    assert.equal(
      january.gross_revenue_churn.numerator + january.gross_revenue_retention.numerator + january.paused_share.numerator,
      january.opening_mrr,
      'churn, retention and paused partition the opening book',
    );
    assert.equal(
      january.gross_revenue_retention.numerator, januaryBefore.gross_revenue_retention.numerator - GROWTH_MONTHLY,
      'paused revenue is not being collected, so it is not retained either',
    );

    // Cancelling the paused account is a real churn: one logo, no bar, because
    // its recognised MRR was already zero.
    await ws.travelTo(UTC(2027, 2, 8));
    const open = await ws.ok('GET', '/v1/revenue/churn?months=3&currency=usd');
    const februaryBefore = open.series.find((row: any) => row.month === '2027-02');
    await ws.ok('POST', `/v1/subscriptions/${sub.id}/cancel`, { cancellation_reason: 'went_out_of_business' });
    const after = await ws.ok('GET', '/v1/revenue/churn?months=3&currency=usd');
    const february = after.series.find((row: any) => row.month === '2027-02');
    assert.equal(february.churned_accounts, februaryBefore.churned_accounts + 1, 'the contract ended, so the logo churned');
    assert.equal(february.churned_mrr, februaryBefore.churned_mrr, 'and no recognised revenue moved, because none was being recognised');
    assert.equal(february.accounts_at_open, februaryBefore.accounts_at_open, 'a paused contract is in the denominator it churns out of');

    const movement = await ws.ok('GET', '/v1/revenue/movement?months=4&top_movers=50&currency=usd');
    for (const row of movement.series) assertRowReconciles(row, 'across a pause and a cancellation');
    const signedUp = new Date(sub.start_date).toISOString().slice(0, 7);
    assert.deepEqual(
      moversFor(movement, customer.id).map((mover) => `${mover.month} ${mover.kind} ${mover.amount}`),
      [`${signedUp} new ${GROWTH_MONTHLY}`, `2027-01 paused ${-GROWTH_MONTHLY}`],
      'signing up and pausing are the only bars this account draws; cancelling from paused moves no recognised MRR',
    );
  });
});

/* ========================================================================== *
 * 10. History that never moves
 *
 * A closed month is a fact. Every dated change in a subscription's life has to
 * step its history on the day it happened — including the ones that wrote no
 * proration line — or the walk back from today's contract re-prices the past.
 * ========================================================================== */

describe('a contract change without a proration line', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 3, 10)); });
  after(() => ws.close());

  const seriesOf = (account: any): Record<string, number> =>
    Object.fromEntries(account.series.map((row: any) => [row.month, row.mrr]));

  test('a schedule phase moves MRR on the phase date and leaves every closed month where it was', async () => {
    const customer = await ws.customer('Halstead Precision Works');
    const sub = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'starter_monthly' }],
      billing_cycle_anchor: UTC(2026, 3, 10),
      collection_method: 'send_invoice',
      days_until_due: 30,
    });
    assert.equal(sub.mrr, 9_900);
    // Three months on Starter while the pilot line proves out, then Growth
    // with twelve seats — the seeded ramp, with proration_behavior none on the
    // first phase so the transition writes no proration line at all.
    const schedule = await ws.ok('POST', '/v1/subscription-schedules', {
      from_subscription: sub.id,
      start_date: sub.current_period_start,
      phases: [
        { items: [{ price: 'starter_monthly', quantity: 1 }], iterations: 3, proration_behavior: 'none' },
        {
          items: [{ price: 'growth_monthly', quantity: 1 }, { price: 'growth_seat_monthly', quantity: 12 }],
          iterations: 9,
          proration_behavior: 'create_prorations',
        },
      ],
    });
    assert.equal(schedule.phases.length, 2);
    const ramped = GROWTH_MONTHLY + 12 * GROWTH_SEAT_MONTHLY;
    assert.equal(ramped, 84_700);

    await ws.travelTo(UTC(2026, 6, 1));
    const before = seriesOf(await ws.ok('GET', `/v1/revenue/accounts/${customer.id}?months=6`));
    assert.deepEqual(
      [before['2026-03'], before['2026-04'], before['2026-05']], [9_900, 9_900, 9_900],
      'three months on Starter',
    );

    // Past the phase boundary on 10 June: the renewal applies the new phase.
    await ws.travelTo(UTC(2026, 7, 5));
    const detail = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(detail.mrr, ramped, 'billing moved the contract to Growth');
    const pending = ws.app.ctx.db.count(
      `SELECT COUNT(*) FROM billing_pending_items WHERE org_id = ? AND subscription_id = ?`, ORG, sub.id,
    );
    assert.equal(pending, 0, 'and wrote no proration line doing it — which is exactly the case that used to rewrite history');

    const after = seriesOf(await ws.ok('GET', `/v1/revenue/accounts/${customer.id}?months=6`));
    assert.deepEqual(
      [after['2026-03'], after['2026-04'], after['2026-05']], [before['2026-03'], before['2026-04'], before['2026-05']],
      'the three closed months read exactly what they read before the phase changed',
    );
    assert.equal(after['2026-06'], ramped, 'June closes on Growth');

    const movement = await ws.ok('GET', '/v1/revenue/movement?months=6&top_movers=50&currency=usd');
    for (const row of movement.series) assertRowReconciles(row, 'across a schedule phase');
    assert.deepEqual(
      moversFor(movement, customer.id),
      [
        { month: '2026-03', kind: 'new', amount: 9_900 },
        { month: '2026-06', kind: 'expansion', amount: ramped - 9_900 },
      ],
      'the ramp is expansion in June, the month the phase started, and nowhere else',
    );

    const cohorts = await ws.ok('GET', '/v1/revenue/cohorts?currency=usd');
    const march = cohorts.series.find((row: any) => row.cohort === '2026-03');
    assert.ok(march.initial_mrr >= 9_900 && march.initial_mrr < march.initial_mrr + ramped, 'the March cohort was signed at Starter');

    const mrr = await ws.ok('GET', '/v1/revenue/mrr?currency=usd');
    assert.ok(mrr.sources.contract_changes_dated_from_the_event_log >= 1, 'the phase is a dated change in the event log');
    assert.equal(mrr.sources.contract_changes_the_walk_back_disagrees_with, 0, 'and the walk back from today lands on what the log says');
    assert.equal(mrr.sources.contract_changes_unpriced, 0);
  });

  test('an update with proration_behavior none steps on its own date, up and back down', async () => {
    const customer = await ws.customer('Corvid Line Automation');
    const sub = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }, { price: 'growth_seat_monthly', quantity: 5 }],
      billing_cycle_anchor: ws.now(),
      collection_method: 'send_invoice',
      days_until_due: 30,
    });
    const opening = GROWTH_MONTHLY + 5 * GROWTH_SEAT_MONTHLY;
    assert.equal(sub.mrr, opening);
    const signedUp = new Date(sub.start_date).toISOString().slice(0, 7);

    // Five more seats, mid-cycle, with no proration: the customer pays the
    // new figure from the next renewal but holds the seats from today.
    await ws.travelTo(UTC(2026, 9, 20));
    const up = await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ price: 'growth_seat_monthly', quantity: 10 }],
      proration_behavior: 'none',
    });
    assert.equal(up.mrr, opening + 5 * GROWTH_SEAT_MONTHLY);
    assert.equal(up.proration.lines.length, 0, 'nothing was prorated');

    // Then seven seats come off the same way, two months later.
    await ws.travelTo(UTC(2026, 11, 20));
    const down = await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ price: 'growth_seat_monthly', quantity: 3 }],
      proration_behavior: 'none',
    });
    assert.equal(down.mrr, GROWTH_MONTHLY + 3 * GROWTH_SEAT_MONTHLY);
    await ws.travelTo(UTC(2027, 1, 4));

    const series = seriesOf(await ws.ok('GET', `/v1/revenue/accounts/${customer.id}?months=12`));
    assert.equal(series['2026-08'], opening, 'August is the contract as signed');
    assert.equal(series['2026-09'], opening + 5 * GROWTH_SEAT_MONTHLY, 'September closes with ten seats');
    assert.equal(series['2026-10'], opening + 5 * GROWTH_SEAT_MONTHLY);
    assert.equal(series['2026-11'], GROWTH_MONTHLY + 3 * GROWTH_SEAT_MONTHLY, 'November closes with three');
    assert.equal(series['2026-12'], GROWTH_MONTHLY + 3 * GROWTH_SEAT_MONTHLY);

    const movement = await ws.ok('GET', '/v1/revenue/movement?months=12&top_movers=50&currency=usd');
    for (const row of movement.series) assertRowReconciles(row, 'across two unprorated changes');
    assert.deepEqual(
      moversFor(movement, customer.id),
      [
        { month: signedUp, kind: 'new', amount: opening },
        { month: '2026-09', kind: 'expansion', amount: 5 * GROWTH_SEAT_MONTHLY },
        { month: '2026-11', kind: 'contraction', amount: -7 * GROWTH_SEAT_MONTHLY },
      ],
      'the upgrade and the downgrade each land once, in their own month, at their own size',
    );
  });

  test('a prorated change is in both ledgers and counted once', async () => {
    const customer = await ws.customer('Both Ledgers Foundry');
    const sub = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }],
      billing_cycle_anchor: ws.now(),
      collection_method: 'send_invoice',
      days_until_due: 30,
    });
    await ws.app.travel(10 * DAY);
    const at = ws.now();
    await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ price: 'growth_seat_monthly', quantity: 4 }],
      proration_behavior: 'always_invoice',
    });
    const lines = ws.app.ctx.db.count(
      `SELECT COUNT(*) FROM billing_pending_items WHERE org_id = ? AND subscription_id = ? AND kind IN ('unused_time', 'remaining_time')`,
      ORG, sub.id,
    );
    assert.ok(lines > 0, 'the proration ledger holds the change');
    const logged = ws.app.ctx.db.count(
      `SELECT COUNT(*) FROM events WHERE org_id = ? AND object_id = ? AND type = 'subscription.updated' AND json_type(previous, '$.items') = 'array'`,
      ORG, sub.id,
    );
    assert.ok(logged > 0, 'and so does the event log');

    const account = await ws.ok('GET', `/v1/revenue/accounts/${customer.id}?months=3`);
    const timeline = account.subscriptions.find((line: any) => line.subscription === sub.id);
    assert.equal(timeline.changes.length, 1, 'one change, not two');
    assert.equal(timeline.changes[0].at, at);
    assert.equal(timeline.changes[0].delta, 4 * GROWTH_SEAT_MONTHLY);
    assert.equal(timeline.changes[0].source, 'event_log');
    assert.equal(timeline.changes[0].confirmed, true, 'the proration ledger agrees with the log');
    assert.equal(timeline.history_disagreements, 0);
    assert.equal(account.mrr, GROWTH_MONTHLY + 4 * GROWTH_SEAT_MONTHLY);
  });
});

/* ========================================================================== *
 * 11. Credit notes reach recognition
 * ========================================================================== */

describe('a credit note against a finalised invoice', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 1, 10)); });
  after(() => ws.close());

  test('reduces invoiced and the deferred balance from the day it was issued, and a closed month never moves', async () => {
    const customer = await ws.customer('Annual Prepay Foundry');
    await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_annual' }],
      billing_cycle_anchor: UTC(2026, 1, 10),
      collection_method: 'send_invoice',
      days_until_due: 30,
    });
    const invoices = await ws.ok('GET', `/v1/invoices?customer=${customer.id}`);
    const invoice = invoices.data.find((row: any) => row.status === 'open');
    assert.ok(invoice, 'the year was billed up front');
    assert.equal(invoice.total, GROWTH_ANNUAL);
    const days = 365;

    // Ninety days in. 499,000 over 365 days is 1,367 a day with 45 left over.
    await ws.travelTo(UTC(2026, 4, 10));
    const elapsed = 90;
    const before = await ws.ok('GET', `/v1/revenue/deferred?invoice=${invoice.id}`);
    assert.equal(before.totals.invoiced, GROWTH_ANNUAL);
    assert.equal(before.totals.recognised, recognisedByHand(GROWTH_ANNUAL, days, elapsed));
    assert.equal(before.totals.recognised, 123_041, '499,000 × 90 ÷ 365 is 123,041.09: the straight line, not a front-loaded remainder');
    const schedule = before.lines[0].schedule;
    for (let day = 1; day <= schedule.length; day++) {
      const toDate = schedule.slice(0, day).reduce((sum: number, entry: any) => sum + entry.amount, 0);
      assert.ok(
        Math.abs(toDate - recognisedByHand(GROWTH_ANNUAL, days, day)) <= 1,
        `day ${day}: cumulative ${toDate} strays from the straight line ${recognisedByHand(GROWTH_ANNUAL, days, day)}`,
      );
    }
    assert.equal(before.totals.deferred_balance, GROWTH_ANNUAL - before.totals.recognised);
    const bookBefore = await ws.ok('GET', `/v1/revenue/deferred?customer=${customer.id}&months=4`);
    const monthOf = (report: any, month: string) => report.series.find((row: any) => row.month === month);

    const credit = 9_900;
    const note = await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: credit, reason: 'service_credit' });
    assert.equal(note.status, 'issued');
    assert.equal(note.total, credit);
    const credited = await ws.ok('GET', `/v1/invoices/${invoice.id}`);
    assert.equal(credited.amount_due, GROWTH_ANNUAL - credit, 'billing took it off what is owed');

    const after = await ws.ok('GET', `/v1/revenue/deferred?invoice=${invoice.id}`);
    const creditElapsed = recognisedByHand(credit, days, elapsed);
    assert.equal(after.totals.invoiced, GROWTH_ANNUAL - credit, 'invoiced is net of the note');
    assert.equal(after.totals.invoiced_gross, GROWTH_ANNUAL);
    assert.equal(after.totals.credited, credit);
    assert.equal(
      after.totals.recognised, before.totals.recognised - creditElapsed,
      'the ninety days already delivered are reversed at their share of the credit',
    );
    assert.equal(
      after.totals.deferred_balance, before.totals.deferred_balance - (credit - creditElapsed),
      'and the days still ahead come off the deferred balance',
    );
    assert.equal(after.totals.invoiced, after.totals.recognised + after.totals.deferred_balance);
    assert.equal(after.reconciliation.balanced, true, after.reconciliation.note ?? '');
    assert.equal(after.totals.credit_note_lines, 1);
    const creditLine = after.lines.find((line: any) => line.kind === 'credit_note');
    assert.ok(creditLine, 'the credit is a line of the schedule');
    assert.equal(creditLine.amount, -credit);
    assert.equal(creditLine.credit_note, note.id);
    assert.equal(creditLine.reduces_line, credited.lines[0].id);
    assert.equal(creditLine.recognised_to_date, -creditElapsed);

    // The months that closed before the note read exactly what they read
    // before it; the note's own month carries the whole reversal.
    const bookAfter = await ws.ok('GET', `/v1/revenue/deferred?customer=${customer.id}&months=4`);
    for (const month of ['2026-01', '2026-02', '2026-03']) {
      assert.equal(monthOf(bookAfter, month).recognised, monthOf(bookBefore, month).recognised, `${month} moved`);
      assert.equal(monthOf(bookAfter, month).invoiced, monthOf(bookBefore, month).invoiced, `${month} invoiced moved`);
      assert.equal(monthOf(bookAfter, month).credited, 0);
    }
    assert.equal(monthOf(bookAfter, '2026-04').credited, credit, 'the note is booked in April');
    assert.equal(monthOf(bookAfter, '2026-04').invoiced, monthOf(bookBefore, '2026-04').invoiced - credit);
    assert.equal(
      monthOf(bookAfter, '2026-04').recognised, monthOf(bookBefore, '2026-04').recognised - creditElapsed,
      'the contra revenue for January to March lands in April, where the note was written',
    );

    const summary = await ws.ok('GET', `/v1/revenue/summary?currency=usd`);
    assert.equal(summary.totals.invoiced, (await ws.ok('GET', '/v1/revenue/deferred?currency=usd')).totals.invoiced);

    // Ten days on, withdrawn: the note gives everything back and the schedule
    // reads as if it had never been written. The undo path is exact.
    await ws.travelTo(UTC(2026, 4, 20));
    await ws.ok('POST', `/v1/credit_notes/${note.id}/void`, {});
    const restored = await ws.ok('GET', `/v1/revenue/deferred?invoice=${invoice.id}`);
    assert.equal(restored.totals.invoiced, GROWTH_ANNUAL);
    assert.equal(restored.totals.credited, 0);
    assert.equal(restored.totals.recognised, recognisedByHand(GROWTH_ANNUAL, days, 100));
    assert.equal(restored.totals.deferred_balance, GROWTH_ANNUAL - restored.totals.recognised);
    assert.equal(restored.totals.credit_note_lines, 0);

    // And a note that was in force at an earlier as_of is still read there,
    // because the balance at that instant is a fact about that instant.
    const then = await ws.ok('GET', `/v1/revenue/deferred?invoice=${invoice.id}&as_of=${UTC(2026, 4, 15)}`);
    assert.equal(then.totals.credited, credit, 'voided later, in force then');
    assert.equal(then.totals.recognised, recognisedByHand(GROWTH_ANNUAL, days, 95) - recognisedByHand(credit, days, 95));
    const earlier = await ws.ok('GET', `/v1/revenue/deferred?invoice=${invoice.id}&as_of=${UTC(2026, 4, 9)}`);
    assert.equal(earlier.totals.credited, 0, 'and not before it was issued');
  });
});

/* ========================================================================== *
 * 12. Usage revenue is invoice money
 * ========================================================================== */

describe('usage revenue', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 6, 15)); });
  after(() => ws.close());

  const FINALISED = `('open', 'paid', 'uncollectible')`;
  const invoicedUsage = (from: number, to: number): number => ws.app.ctx.db.count(
    `SELECT COALESCE(SUM(l.amount), 0) FROM billing_invoice_lines l
       JOIN billing_invoices i ON i.id = l.invoice_id AND i.org_id = l.org_id
      WHERE l.org_id = ? AND i.currency = 'usd' AND l.released = 0 AND i.status IN ${FINALISED}
        AND i.finalized_at >= ? AND i.finalized_at < ? AND l.kind IN ('usage', 'true_up')`,
    ORG, from, to,
  );
  const unbilledUsage = (at: number): number => ws.app.ctx.db.count(
    `SELECT COALESCE(SUM(b.billed_amount), 0) FROM credit_billable_items b
       LEFT JOIN billing_invoice_lines l
         ON l.org_id = b.org_id AND l.source_type = 'billable_item' AND l.source_id = b.id AND l.released = 0
       LEFT JOIN billing_invoices i
         ON i.org_id = l.org_id AND i.id = l.invoice_id AND i.status IN ${FINALISED} AND i.finalized_at <= ?
      WHERE b.org_id = ? AND b.currency = 'usd' AND b.kind IN ('charged', 'true_up') AND b.status <> 'void'
        AND b.period_end <= ? AND i.id IS NULL`,
    at, ORG, at,
  );
  const settledValue = (from: number, to: number): number => ws.app.ctx.db.count(
    `SELECT COALESCE(SUM(full_amount), 0) FROM credit_settlements
      WHERE org_id = ? AND currency = 'usd' AND status = 'settled' AND period_end > ? AND period_end <= ?`,
    ORG, from, to,
  );

  const check = async (where: string) => {
    const usage = await ws.ok('GET', '/v1/revenue/usage?months=12&currency=usd');
    const { from, to } = usage.range;
    assert.equal(usage.totals.charged, invoicedUsage(from, to), `${where}: charged is what the usage and true-up lines on finalised invoices carry`);
    assert.equal(usage.totals.overage_share_of_invoiced.numerator, usage.totals.charged, `${where}: the overage share is that same figure`);
    assert.equal(usage.totals.unbilled_balance, unbilledUsage(to), `${where}: unbilled is every settled charge with no finalised invoice`);
    assert.equal(usage.totals.metered_value, settledValue(from, to), `${where}: metered value is what the settlements priced`);
    assert.equal(usage.meters.reduce((sum: number, meter: any) => sum + meter.charged, 0), usage.totals.charged, `${where}: the meters add up to the total`);
    assert.equal(usage.totals.settled.invoiced + usage.totals.unbilled, usage.totals.settled.net_charged, `${where}: settled is billed or unbilled`);
    assert.equal(usage.series.reduce((sum: number, row: any) => sum + row.charged, 0), usage.totals.charged, `${where}: so do the months`);
    assert.equal(usage.series[usage.series.length - 1].unbilled_balance, usage.totals.unbilled_balance);
    assert.equal(usage.balanced, true, usage.reconciliation.note ?? '');
    const bridge = usage.reconciliation.checks.find((c: any) => c.name === 'invoice_lines_carry_the_settled_amount');
    assert.equal(bridge.ok, true);
    const deferred = await ws.ok('GET', '/v1/revenue/deferred?months=12&currency=usd');
    assert.equal(deferred.totals.unbilled_usage, usage.totals.unbilled_balance, `${where}: recognition reads the same arrears`);
    assert.ok(deferred.totals.unbilled_balance >= deferred.totals.unbilled_usage);
    const summary = await ws.ok('GET', '/v1/revenue/summary?months=12&currency=usd');
    assert.equal(summary.totals.usage_charged, usage.totals.charged);
    assert.equal(summary.totals.usage_unbilled, usage.totals.unbilled_balance);
    return usage;
  };

  test('charged is what reached an invoice; settled usage waiting for its bill is unbilled', async () => {
    // Northwind opens with a settled window that no invoice has drawn yet.
    const settled = ws.app.ctx.db.count(
      `SELECT COALESCE(SUM(billed_amount), 0) FROM credit_billable_items WHERE org_id = ? AND currency = 'usd' AND kind IN ('charged', 'true_up') AND status = 'pending'`,
      ORG,
    );
    assert.ok(settled > 0, 'the seeded book has settled usage waiting for its invoice');
    const opening = await check('at seed');
    assert.equal(opening.totals.charged, 0, 'nothing metered has reached an invoice yet');
    assert.equal(opening.totals.unbilled_balance, settled, 'so all of it is unbilled');
    assert.ok(opening.totals.metered_value > 0, 'though the window has been priced');

    // A quarter of renewals draws the invoices that carry it.
    await ws.app.travel(90 * DAY);
    const later = await check('after ninety days');
    assert.ok(later.totals.charged > 0, 'the usage was billed');
    assert.ok(later.totals.charged !== later.totals.settled.charged || later.totals.settled.true_ups === 0,
      'a true-up on the invoice is in charged at what the invoice carries');
  });
});

describe('the credit ledger behind usage', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 6, 15)); });
  after(() => ws.close());

  test('a rollover is not a grant, and a refund keeps the sign the ledger gave it', async () => {
    // A month of the time machine is what makes grants expire and roll over.
    await ws.app.travel(40 * DAY);
    const report = await ws.ok('GET', '/v1/revenue/usage?months=6');
    assert.equal(report.balanced, true, report.reconciliation.note ?? '');

    const flows = report.by_currency.flatMap((part: any) => part.credit.flows);
    const rolled = flows.filter((flow: any) => flow.rolled_in !== 0 || flow.rolled_out !== 0);
    assert.ok(rolled.length > 0, 'the seeded book rolls credit over, which is what exposed this');
    for (const flow of rolled) {
      assert.ok(flow.rolled_in > 0, 'credit that arrived from another grant is an inflow');
      assert.ok(flow.rolled_out < 0, 'credit that left one is an outflow, and it is named rather than dropped');
      assert.equal(
        flow.granted + flow.rolled_in + flow.rolled_out + flow.burned + flow.expired
        + flow.refunded + flow.voided + flow.adjusted + flow.other_total,
        flow.balance,
        `${flow.currency} ${flow.kind}: the named components do not sum to the movement`,
      );
    }

    // A grant is what was sold. Rolling credit forward is not a sale, and
    // folding it in overstated what customers had bought.
    const granted = ws.app.ctx.db.count(
      `SELECT COALESCE(SUM(l.delta_micro), 0) FROM credit_ledger l
         JOIN credit_grants g ON g.id = l.grant_id AND g.org_id = l.org_id
        WHERE l.org_id = ? AND l.type = 'grant' AND g.kind = 'unit'
          AND l.created >= ? AND l.created < ?`,
      ORG, report.range.from, report.range.to,
    );
    const reported = flows
      .filter((flow: any) => flow.kind === 'unit')
      .reduce((sum: number, flow: any) => sum + flow.granted, 0);
    assert.equal(reported, granted, 'granted is grants, and nothing else');

    for (const flow of flows) {
      const refunds = ws.app.ctx.db.count(
        `SELECT COALESCE(SUM(l.delta_micro), 0) FROM credit_ledger l
           JOIN credit_grants g ON g.id = l.grant_id AND g.org_id = l.org_id
          WHERE l.org_id = ? AND l.type = 'refund' AND g.kind = ? AND g.currency = ?
            AND l.created >= ? AND l.created < ?`,
        ORG, flow.kind, flow.currency, report.range.from, report.range.to,
      );
      const expected = flow.micro ? refunds : Math.trunc(refunds / 1_000_000);
      assert.equal(flow.refunded, expected, `${flow.currency} ${flow.kind}: refunded flipped a sign the ledger did not`);
    }
  });

  test('every check the endpoint publishes actually passes', async () => {
    const report = await ws.ok('GET', '/v1/revenue/usage?months=24');
    assert.ok(report.reconciliation.checks.length >= 4, 'four independent checks, not one identity');
    for (const check of report.reconciliation.checks) {
      assert.equal(check.ok, true, `${check.name}: expected ${check.expected}, got ${check.actual}`);
      assert.ok(check.description.length > 40, `${check.name} does not say what it checks`);
    }
    assert.equal(report.reconciliation.note, null);
  });
});
