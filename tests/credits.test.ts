import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, frozenClock, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { DAY, startOfDay } from '../src/shared/time';
import { BURN_ORDER, orderCandidates } from '../src/server/modules/credits/burn';
import type { BillableItem, CreditGrant, LedgerEntry, Settlement } from '../src/server/modules/credits/types';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const T0 = Date.UTC(2026, 5, 2, 9, 17, 34, 512);

let app: App;
const call = (method: string, path: string, body?: unknown, target: App = app) =>
  target.handle({ method, path, body, auth: DANA });

async function expectOk(method: string, path: string, body?: unknown, target: App = app): Promise<any> {
  const res = await call(method, path, body, target);
  assert.ok(res.status < 400, `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function expectError(method: string, path: string, body: unknown, status: number, code?: string, target: App = app): Promise<any> {
  const res = await call(method, path, body, target);
  assert.equal(res.status, status, `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  if (code) assert.equal(res.body.error.code, code, JSON.stringify(res.body));
  return res.body.error;
}

before(async () => {
  app = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } });
});
after(() => app.close());

let seq = 0;
const nextName = (prefix: string) => `${prefix}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/**
 * A meter, a graduated usage price and a credit pack that fills it — the
 * smallest complete fixture that can produce an overage.
 *
 * The price gives away the first 1,000 units and charges 10 minor units for
 * every unit after that, so every expected number below is arithmetic a reader
 * can check in their head.
 */
async function fixture(target: App = app) {
  const eventName = nextName('fx');
  const meter = await expectOk('POST', '/v1/meters', {
    name: 'Fixture meter', event_name: eventName, aggregation: 'sum', value_key: 'units', unit_label: 'unit',
  }, target);
  const product = await expectOk('POST', '/v1/products', {
    name: 'Fixture telemetry', unit_label: 'unit', category: 'component',
  }, target);
  const usagePrice = await expectOk('POST', '/v1/prices', {
    product: product.id, currency: 'usd', model: 'usage', type: 'recurring', tiers_mode: 'graduated',
    nickname: 'Fixture usage',
    tiers: [{ up_to: 1000, unit_amount_decimal: '0' }, { up_to: 'inf', unit_amount_decimal: '10' }],
    recurring: { interval: 'month', usage_type: 'metered', aggregate_usage: 'sum', meter: eventName },
  }, target);
  const packProduct = await expectOk('POST', '/v1/products', {
    name: 'Fixture credit pack', unit_label: 'pack', category: 'credit_pack',
  }, target);
  const packPrice = await expectOk('POST', '/v1/prices', {
    product: packProduct.id, currency: 'usd', model: 'per_unit', type: 'one_time', unit_amount: 50_000,
    nickname: 'Fixture pack', metadata: { units_per_pack: '1000', meter: eventName },
  }, target);
  return { meter, product, usagePrice, packPrice, eventName };
}

const period = { start: Date.UTC(2026, 4, 1), end: Date.UTC(2026, 5, 1) };

/**
 * An account invoicing can actually charge.
 *
 * A credit purchase now raises its own charge, and the grant it buys stays
 * unspendable until that charge lands — so a test that wants spendable
 * prepaid credit has to buy it for somebody who can be billed, exactly as a
 * customer would have to.
 */
const billableCustomer = async (name: string, target: App = app): Promise<string> =>
  (await expectOk('POST', '/v1/customers', { name, currency: 'usd' }, target)).id;

/** Every ledger entry for a grant, oldest first. */
const entriesOf = async (grantId: string, target: App = app): Promise<LedgerEntry[]> =>
  (await expectOk('GET', `/v1/credit-grants/${grantId}/ledger`, undefined, target)).entries;

/* ------------------------------- the ledger ------------------------------- */

describe('the ledger is the balance', () => {
  test('every entry carries the running total of the entries before it', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    const grant = await expectOk('POST', '/v1/credit-grants', {
      customer, kind: 'monetary', currency: 'usd', amount: 50_000, category: 'paid', name: 'Ledger probe',
    });

    await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 2000, period_start: period.start, period_end: period.end,
    });
    await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 1500,
      period_start: period.end, period_end: Date.UTC(2026, 6, 1),
    });
    await expectOk('POST', `/v1/credit-grants/${grant.id}/void`, { reason: 'Test wind-down' });

    const ledger = await expectOk('GET', `/v1/credit-grants/${grant.id}/ledger`);
    assert.equal(ledger.reconciled, true);
    assert.deepEqual(ledger.entries.map((e: LedgerEntry) => e.type), ['grant', 'burn', 'burn', 'void']);

    let running = 0;
    ledger.entries.forEach((entry: LedgerEntry, i: number) => {
      running += entry.delta;
      assert.equal(entry.balance_after, running, `entry ${i} (${entry.type}) disagrees with the sum before it`);
      assert.equal(entry.seq, i + 1);
    });
    assert.equal(ledger.entries[ledger.entries.length - 1].balance_after, 0);

    // And the same number the database itself would produce.
    const summed = app.ctx.db.pluck<number>(
      `SELECT COALESCE(SUM(delta_micro), 0) FROM credit_ledger WHERE org_id = ? AND grant_id = ?`, ORG, grant.id);
    assert.equal(summed, 0);
    const reread: CreditGrant = await expectOk('GET', `/v1/credit-grants/${grant.id}`);
    assert.equal(reread.balance, 0);
    assert.equal(reread.status, 'voided');
  });

  test('there is no balance column anywhere in the schema', () => {
    const columns = app.ctx.db.all<{ name: string }>(`PRAGMA table_info(credit_grants)`).map((c) => c.name);
    assert.ok(!columns.includes('balance'), 'a stored balance is a balance that can drift');
    assert.ok(columns.includes('amount_micro'), 'only the granted amount is stored');
  });

  test('credit cannot be drawn below zero', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    await expectOk('POST', '/v1/credit-grants', { customer, amount: 5_000, currency: 'usd', category: 'paid' });

    // 2,000 units costs $100.00; there is only $50.00 of credit.
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 2000, period_start: period.start, period_end: period.end,
    });
    assert.equal(settlement.full_amount, 10_000);
    assert.equal(settlement.covered_amount, 5_000);
    assert.equal(settlement.charged_amount, 5_000);

    const balance = await expectOk('GET', `/v1/customers/${customer}/credit-balance`);
    assert.equal(balance.totals_by_currency[0].monetary_available, 0, 'exactly empty, never negative');
  });
});

/* ----------------------------- burn-down order ---------------------------- */

describe('burn-down order', () => {
  test('the soonest-expiring grant drains first', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    const later = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 30_000, currency: 'usd', category: 'paid', name: 'Expires in 90 days',
      expires_at: T0 + 90 * DAY,
    });
    const sooner = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 20_000, currency: 'usd', category: 'paid', name: 'Expires in 10 days',
      expires_at: T0 + 10 * DAY,
    });
    const never = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 40_000, currency: 'usd', category: 'paid', name: 'Never expires',
    });

    // 4,000 units → 3,000 chargeable → $300.00, more than the first two grants.
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 4000, period_start: period.start, period_end: period.end,
    });
    assert.equal(settlement.full_amount, 30_000);
    assert.deepEqual(settlement.applications.map((a) => a.grant), [sooner.id, later.id]);
    assert.deepEqual(settlement.applications.map((a) => a.amount), [20_000, 10_000]);
    assert.equal(settlement.applications[0].balance_after, 0);
    assert.equal(settlement.applications[1].balance_after, 20_000);
    assert.equal(settlement.charged_amount, 0);
    assert.ok(settlement.burn_order[1].includes('Soonest expiry first'));

    const untouched: CreditGrant = await expectOk('GET', `/v1/credit-grants/${never.id}`);
    assert.equal(untouched.balance, 40_000, 'the open-ended grant is spent last');
  });

  test('promotional credit is spent before paid credit of the same age', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    const expires = T0 + 30 * DAY;
    const paid = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 10_000, currency: 'usd', category: 'paid', name: 'Paid', expires_at: expires,
    });
    const promo = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 10_000, currency: 'usd', category: 'promotional', name: 'Promotional', expires_at: expires,
    });
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 2500, period_start: period.start, period_end: period.end,
    });
    assert.deepEqual(settlement.applications.map((a) => a.grant), [promo.id, paid.id]);
    assert.deepEqual(settlement.applications.map((a) => a.amount), [10_000, 5_000]);
  });

  test('explicit priority outranks the category', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    const expires = T0 + 30 * DAY;
    const first = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 4_000, currency: 'usd', category: 'paid', priority: -10, name: 'Spend me first', expires_at: expires,
    });
    const second = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 4_000, currency: 'usd', category: 'promotional', priority: 0, name: 'Ordinary', expires_at: expires,
    });
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 1600, period_start: period.start, period_end: period.end,
    });
    assert.deepEqual(settlement.applications.map((a) => a.grant), [first.id, second.id]);
  });

  test('a grant that does not apply to the charge is not touched', async () => {
    const a = await fixture();
    const b = await fixture();
    const customer = nextName('cus');
    const wrongMeter = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 100_000, currency: 'usd', category: 'paid', name: 'Only pays for the other meter',
      applicability: { scope: 'targeted', meters: [b.eventName] }, expires_at: T0 + 5 * DAY,
    });
    const rightMeter = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 100_000, currency: 'usd', category: 'paid', name: 'Pays for this meter',
      applicability: { scope: 'targeted', meters: [a.eventName] }, expires_at: T0 + 50 * DAY,
    });
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: a.usagePrice.id, quantity: 3000, period_start: period.start, period_end: period.end,
    });
    assert.deepEqual(settlement.applications.map((a2) => a2.grant), [rightMeter.id],
      'applicability wins over the expiry ordering, because the other grant is not eligible at all');
    const untouched: CreditGrant = await expectOk('GET', `/v1/credit-grants/${wrongMeter.id}`);
    assert.equal(untouched.balance, 100_000);
  });

  test('a grant in another currency is never eligible', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    await expectOk('POST', '/v1/credit-grants', { customer, amount: 90_000, currency: 'eur', category: 'paid' });
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 2000, period_start: period.start, period_end: period.end,
    });
    assert.equal(settlement.applications.length, 0);
    assert.equal(settlement.charged_amount, 10_000);
  });

  test('the settlement returns the order it used, and the draw follows every rung of it', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    const soon = T0 + 10 * DAY;
    const later = T0 + 30 * DAY;
    const pot = (over: Record<string, unknown>) =>
      expectOk('POST', '/v1/credit-grants', { customer, amount: 1_000, currency: 'usd', ...over });

    // Each of these differs from the next by exactly one rung of the published
    // order, so the sequence the settlement draws in can only come out right if
    // every rung is applied, in the order the API says it is.
    const expiringSoon = await pot({ category: 'paid', expires_at: soon, name: 'Lapses in ten days' });
    const prioritised = await pot({ category: 'paid', expires_at: later, priority: -5, name: 'Spend me early' });
    const promotional = await pot({ category: 'promotional', expires_at: later, name: 'Onboarding credit' });
    const paid = await pot({ category: 'paid', expires_at: later, name: 'Prepaid balance' });
    const openEnded = await pot({ category: 'paid', name: 'Never lapses' });
    const wrongCharge = await pot({
      category: 'promotional', expires_at: T0 + DAY, name: 'Only pays for support hours',
      applicability: { scope: 'targeted', products: ['prod_support_hours'] },
    });

    // 2,000 units: 1,000 free, 1,000 at 10 minor units = $100.00, against $50.00
    // of eligible credit spread over five grants.
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 2000, period_start: period.start, period_end: period.end,
    });

    assert.deepEqual(settlement.burn_order, BURN_ORDER, 'the response documents the order it used');
    assert.deepEqual(
      settlement.applications.map((a) => a.grant),
      [expiringSoon.id, prioritised.id, promotional.id, paid.id, openEnded.id],
      'expiry, then priority, then promotional before paid, then the open-ended grant last',
    );
    assert.deepEqual(settlement.applications.map((a) => a.balance_after), [0, 0, 0, 0, 0]);
    assert.equal(settlement.covered_amount, 5_000);
    assert.equal(settlement.charged_amount, 5_000);
    assert.equal(settlement.full_amount, 10_000);
    assert.equal(settlement.lines.reduce((acc, line) => acc + line.amount, 0), settlement.full_amount);

    const untouched: CreditGrant = await expectOk('GET', `/v1/credit-grants/${wrongCharge.id}`);
    assert.equal(untouched.balance, 1_000, 'a grant that does not apply is skipped however soon it lapses');

    // And the balance a customer reads quotes the same order as the settlement.
    const balance = await expectOk('GET', `/v1/customers/${customer}/credit-balance`);
    assert.deepEqual(balance.burn_order, BURN_ORDER);
  });

  test('the ordering is a pure, testable function', () => {
    const grant = (over: Partial<CreditGrant>): CreditGrant => ({
      object: 'credit_grant', id: 'credgr_x', customer: 'cus_x', name: 'g', category: 'paid', kind: 'monetary',
      currency: 'usd', meter: null, unit_label: null, amount: 100, amount_decimal: '100', balance: 100,
      balance_decimal: '100', applicability: { scope: 'all', prices: [], meters: [], products: [] },
      applies_to: 'any charge in this currency', effective_at: 0, expires_at: null, priority: 0,
      rollover: 'none', rollover_cap: null, status: 'active', awaiting_payment: false,
      pending_purchase: null, source: 'manual', source_ref: null,
      metadata: {}, created: 0, updated: 0, ...over,
    });
    const ordered = orderCandidates([
      { grant: grant({ id: 'g_none' }), balanceMicro: 1n },
      { grant: grant({ id: 'g_late', expires_at: 200 }), balanceMicro: 1n },
      { grant: grant({ id: 'g_early', expires_at: 100 }), balanceMicro: 1n },
      { grant: grant({ id: 'g_early_promo', expires_at: 100, category: 'promotional' }), balanceMicro: 1n },
      { grant: grant({ id: 'g_early_priority', expires_at: 100, priority: -1 }), balanceMicro: 1n },
    ]);
    assert.deepEqual(ordered.map((c) => c.grant.id), ['g_early_priority', 'g_early_promo', 'g_early', 'g_late', 'g_none']);
  });
});

/* ------------------------------ overage lines ----------------------------- */

describe('running out of credit mid-period', () => {
  test('the covered and charged lines together equal the full usage', async () => {
    const { usagePrice, meter } = await fixture();
    const customer = nextName('cus');
    // 4,000 prepaid units against 10,000 units of usage.
    await expectOk('POST', '/v1/credit-grants', {
      customer, kind: 'unit', amount: 4000, currency: 'usd', category: 'paid',
      name: 'Prepaid units', meter: meter.id, expires_at: T0 + 60 * DAY,
    });
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 10_000, period_start: period.start, period_end: period.end,
    });

    // 9,000 chargeable units at 10 minor units each.
    assert.equal(settlement.full_amount, 90_000);
    assert.equal(settlement.covered_quantity, 4_000);
    assert.equal(settlement.charged_quantity, 6_000);
    assert.equal(settlement.charged_amount, 50_000);
    assert.equal(settlement.covered_amount, 40_000);
    assert.equal(settlement.covered_amount + settlement.charged_amount, settlement.full_amount);

    const covered = settlement.lines.find((l) => l.kind === 'credit_covered');
    const charged = settlement.lines.find((l) => l.kind === 'charged');
    assert.ok(covered && charged, 'both halves are on the invoice, labelled');
    assert.equal(covered.amount + charged.amount, settlement.full_amount);
    assert.equal(covered.billed_amount, 0, 'the covered half costs nothing');
    assert.equal(covered.credit_applied, 40_000);
    assert.equal(charged.billed_amount, 50_000);
    assert.equal(covered.quantity + charged.quantity, 10_000, 'and the quantities add up too');
    assert.match(covered.description, /4,000 units covered by prepaid credit/);
    assert.match(charged.description, /6,000 units charged/);

    const balance = await expectOk('GET', `/v1/customers/${customer}/credit-balance`);
    assert.equal(balance.balances[0].available, 0);
  });

  test('credit is never spent on units the price gives away', async () => {
    const { usagePrice, meter } = await fixture();
    const customer = nextName('cus');
    await expectOk('POST', '/v1/credit-grants', {
      customer, kind: 'unit', amount: 5000, currency: 'usd', category: 'paid', meter: meter.id,
    });
    // 1,400 units: 1,000 are free, so only 400 are worth covering.
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 1400, period_start: period.start, period_end: period.end,
    });
    assert.equal(settlement.full_amount, 4_000);
    assert.equal(settlement.covered_quantity, 400, 'the 1,000 free units are not paid for with credit');
    assert.equal(settlement.charged_amount, 0);
    const grant: CreditGrant = (await expectOk('GET', `/v1/credit-grants?customer=${customer}`)).data[0];
    assert.equal(grant.balance, 4_600);
  });

  test('unit credit and monetary credit stack, and still add up', async () => {
    const { usagePrice, meter } = await fixture();
    const customer = nextName('cus');
    await expectOk('POST', '/v1/credit-grants', {
      customer, kind: 'unit', amount: 2000, currency: 'usd', category: 'paid', meter: meter.id,
      name: 'Prepaid units', expires_at: T0 + 20 * DAY,
    });
    await expectOk('POST', '/v1/credit-grants', {
      customer, kind: 'monetary', amount: 15_000, currency: 'usd', category: 'promotional', name: 'Goodwill',
    });
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 6000, period_start: period.start, period_end: period.end,
    });
    assert.equal(settlement.full_amount, 50_000);          // 5,000 chargeable units
    assert.equal(settlement.unit_credit_amount, 20_000);   // 2,000 units off the top
    assert.equal(settlement.monetary_credit_amount, 15_000);
    assert.equal(settlement.charged_amount, 15_000);
    assert.equal(settlement.covered_amount + settlement.charged_amount, settlement.full_amount);
    assert.equal(settlement.lines.reduce((acc, l) => acc + l.amount, 0), settlement.full_amount);
    assert.equal(settlement.lines.reduce((acc, l) => acc + l.billed_amount, 0), settlement.charged_amount);
    assert.deepEqual(settlement.applications.map((a) => a.kind), ['unit', 'monetary']);
  });

  test('when several grants pay for one period, their shares still sum to the credit applied', async () => {
    const { meter, product } = await fixture();
    // A rate with a fraction of a minor unit, so the split has a remainder to
    // hand out and cannot come out even by luck.
    const price = await expectOk('POST', '/v1/prices', {
      product: product.id, currency: 'usd', model: 'usage', type: 'recurring', tiers_mode: 'graduated',
      nickname: 'Fractional usage', tiers: [{ up_to: 'inf', unit_amount_decimal: '3.7' }],
      recurring: { interval: 'month', usage_type: 'metered', aggregate_usage: 'sum', meter: meter.event_name },
    });
    const customer = nextName('cus');
    await expectOk('POST', '/v1/credit-grants', {
      customer, kind: 'unit', amount: 3333, currency: 'usd', category: 'paid', meter: meter.id,
      name: 'First pack', expires_at: T0 + 10 * DAY,
    });
    await expectOk('POST', '/v1/credit-grants', {
      customer, kind: 'unit', amount: 1667, currency: 'usd', category: 'paid', meter: meter.id,
      name: 'Second pack', expires_at: T0 + 20 * DAY,
    });

    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: price.id, quantity: 10_000, period_start: period.start, period_end: period.end,
    });
    assert.equal(settlement.full_amount, 37_000);
    assert.equal(settlement.covered_quantity, 5_000);
    assert.equal(settlement.charged_amount, 18_500);
    assert.equal(settlement.covered_amount, 18_500);
    assert.deepEqual(settlement.applications.map((a) => a.drawn), [3333, 1667], 'soonest expiry first');
    assert.equal(
      settlement.applications.reduce((acc, a) => acc + a.amount, 0),
      settlement.covered_amount,
      'the per-grant shares add up to the credit applied, to the cent',
    );
    // Reading it back re-derives the same split rather than storing it twice.
    const reread: Settlement = await expectOk('GET', `/v1/credit-settlements/${settlement.id}`);
    assert.deepEqual(reread.applications.map((a) => a.amount), settlement.applications.map((a) => a.amount));
  });

  test('no credit at all still produces a charged line', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 3000, period_start: period.start, period_end: period.end,
    });
    assert.equal(settlement.lines.length, 1);
    assert.equal(settlement.lines[0].kind, 'charged');
    assert.equal(settlement.lines[0].amount, 20_000);
  });

  test('settling the same period twice does not burn the balance twice', async () => {
    const { usagePrice, meter } = await fixture();
    const customer = nextName('cus');
    await expectOk('POST', '/v1/credit-grants', {
      customer, kind: 'unit', amount: 5000, currency: 'usd', category: 'paid', meter: meter.id,
    });
    const body = { customer, price: usagePrice.id, quantity: 4000, period_start: period.start, period_end: period.end };
    const first: Settlement = await expectOk('POST', '/v1/credit-settlements', body);
    const second: Settlement = await expectOk('POST', '/v1/credit-settlements', body);
    assert.equal(second.id, first.id);
    assert.equal(second.lines.length, first.lines.length);
    const grant: CreditGrant = (await expectOk('GET', `/v1/credit-grants?customer=${customer}`)).data[0];
    assert.equal(grant.balance, 2_000, 'drawn once, not twice');
  });

  test('a retry whose period boundary moved by a millisecond is refused, not charged again', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    await expectOk('POST', '/v1/credit-grants', { customer, amount: 500_000, currency: 'usd', category: 'paid' });
    const balance = async () => (await expectOk('GET', `/v1/credit-grants?customer=${customer}`)).data[0].balance;

    const first: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 4000, period_start: period.start, period_end: period.end,
    });
    assert.equal(first.covered_amount, 30_000);
    assert.equal(await balance(), 470_000);

    // The bug this exists to stop: a retry with a boundary one millisecond
    // later used to price the same usage again and take another $300.
    const error = await expectError('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 4000, period_start: period.start, period_end: period.end + 1,
    }, 409, 'usage_period_already_settled');
    assert.match(error.message, new RegExp(first.id));
    assert.equal(error.detail.settlement, first.id);
    assert.equal(await balance(), 470_000, 'the balance did not move');

    // Nor does a fresh idempotency key on the identical period.
    const rekeyed: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 4000, period_start: period.start, period_end: period.end,
      idem_key: 'a-completely-different-run',
    });
    assert.equal(rekeyed.id, first.id, 'the period is the identity, not the caller’s string');
    assert.equal(await balance(), 470_000);

    const settlements = await expectOk('GET', `/v1/credit-settlements?customer=${customer}`);
    assert.equal(settlements.data.length, 1);
  });

  test('the period that follows the settled one is not an overlap', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 2000, period_start: period.start, period_end: period.end,
    });
    const next: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 2000, period_start: period.end, period_end: Date.UTC(2026, 6, 1),
    });
    assert.equal(next.charged_amount, 10_000, 'half-open periods that share an instant are adjacent, not overlapping');
  });

  test('the metered path and the supplied-quantity path agree', async () => {
    const { usagePrice, eventName, meter } = await fixture();
    const customer = nextName('cus');
    await expectOk('POST', '/v1/meter-events/batch', {
      events: [1, 2, 3].map((i) => ({
        event_name: eventName, identifier: `metered_${customer}_${i}`,
        timestamp: period.start + i * DAY, payload: { customer_id: customer, units: 1200 },
      })),
    });
    const usage = await expectOk('GET',
      `/v1/meters/${meter.id}/usage?customer=${customer}&start=${period.start}&end=${period.end}`);
    assert.equal(usage.value, 3600);

    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, period_start: period.start, period_end: period.end, close_period: true,
    });
    assert.equal(settlement.billed_quantity, 3600);
    assert.equal(settlement.full_amount, 26_000); // 2,600 chargeable units

    const closed = await expectOk('GET',
      `/v1/meters/${meter.id}/usage?customer=${customer}&start=${period.start}&end=${period.end}`);
    assert.equal(closed.closed?.total, 3600, 'settling froze the meter period');
    assert.equal(closed.closed?.ref_id, settlement.id);
  });
});

/* --------------------------------- top-ups -------------------------------- */

describe('top-ups', () => {
  test('the invoice line and the grant are created together', async () => {
    const { packPrice, meter } = await fixture();
    const customer = nextName('cus');
    const topup = await expectOk('POST', '/v1/credit-topups', {
      customer, price: packPrice.id, quantity: 3, expires_at: T0 + 90 * DAY,
    });
    assert.equal(topup.amount, 150_000, 'three packs at $500');
    assert.equal(topup.grant.kind, 'unit');
    assert.equal(topup.grant.meter, meter.id);
    assert.equal(topup.grant.amount, 3000, 'three packs of 1,000 units');
    assert.equal(topup.grant.source, 'topup');
    assert.equal(topup.grant.source_ref, topup.line.id, 'the grant points at the line');
    assert.equal(topup.line.grant, topup.grant.id, 'and the line points back at the grant');
    assert.equal(topup.line.kind, 'topup');
    assert.equal(topup.line.billed_amount, 150_000);
    assert.equal(topup.line.status, 'pending');

    const entries = await entriesOf(topup.grant.id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'grant');
    assert.equal(entries[0].balance_after, 3000);
    assert.equal(entries[0].ref_id, topup.line.id, 'the ledger records what was bought');
  });

  test('a top-up against an unknown price writes neither half', async () => {
    const customer = nextName('cus');
    const before = app.ctx.db.count(`SELECT COUNT(*) FROM credit_billable_items WHERE org_id = ?`, ORG);
    await expectError('POST', '/v1/credit-topups', { customer, price: 'price_does_not_exist' }, 404);
    assert.equal(app.ctx.db.count(`SELECT COUNT(*) FROM credit_grants WHERE org_id = ? AND customer_id = ?`, ORG, customer), 0);
    assert.equal(app.ctx.db.count(`SELECT COUNT(*) FROM credit_billable_items WHERE org_id = ?`, ORG), before);
  });

  test('a pack whose size is unstated is refused rather than guessed', async () => {
    const product = await expectOk('POST', '/v1/products', { name: 'Mystery pack', category: 'credit_pack' });
    const eventName = nextName('mystery');
    await expectOk('POST', '/v1/meters', { name: 'Mystery meter', event_name: eventName, value_key: 'units' });
    const price = await expectOk('POST', '/v1/prices', {
      product: product.id, currency: 'usd', model: 'per_unit', type: 'one_time', unit_amount: 1000,
      metadata: { meter: eventName },
    });
    const error = await expectError('POST', '/v1/credit-topups', {
      customer: nextName('cus'), price: price.id, kind: 'unit',
    }, 400, 'credit_pack_size_unknown');
    assert.match(error.message, /units_per_pack/);
  });

  test('unused paid credit can be refunded pro rata, with a matching line', async () => {
    const { packPrice, usagePrice } = await fixture();
    const customer = await billableCustomer('Hallwood Presswork');
    const topup = await expectOk('POST', '/v1/credit-topups', { customer, price: packPrice.id, quantity: 4 });
    assert.equal(topup.amount, 200_000);
    assert.equal(topup.grant.status, 'active', 'the charge was raised, so the packs are spendable');

    // Spend a quarter of it, then hand the rest back.
    await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 2000, period_start: period.start, period_end: period.end,
    });
    const refund = await expectOk('POST', `/v1/credit-grants/${topup.grant.id}/refund`, { reason: 'Downgraded to monthly' });
    assert.equal(refund.refunded, 3000, 'the three unspent packs');
    assert.equal(refund.line.amount, -150_000, 'refunded pro rata to what was bought');
    assert.equal(refund.grant.balance, 0);

    const entries = await entriesOf(topup.grant.id);
    assert.deepEqual(entries.map((e) => e.type), ['grant', 'burn', 'refund']);
    assert.equal(entries[2].balance_after, 0);

    const error = await expectError('POST', `/v1/credit-grants/${topup.grant.id}/refund`, { amount: 1 }, 400);
    assert.match(error.message, /left/);
  });

  test('promotional credit is voided, not refunded', async () => {
    const customer = nextName('cus');
    const grant = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 10_000, currency: 'usd', category: 'promotional',
    });
    await expectError('POST', `/v1/credit-grants/${grant.id}/refund`, {}, 400, 'credit_grant_not_refundable');
  });
});

/* -------------------------------- balances -------------------------------- */

describe('the balance a customer sees', () => {
  test('is grouped per currency and per what it may be spent on', async () => {
    const { meter, eventName } = await fixture();
    const customer = nextName('cus');
    await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 30_000, currency: 'usd', category: 'paid', name: 'Anything, USD',
    });
    await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 12_000, currency: 'usd', category: 'promotional', name: 'Telemetry only',
      applicability: { scope: 'targeted', meters: [eventName] }, expires_at: T0 + 14 * DAY,
    });
    await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 9_000, currency: 'eur', category: 'paid', name: 'Anything, EUR',
    });
    await expectOk('POST', '/v1/credit-grants', {
      customer, kind: 'unit', amount: 2500, currency: 'usd', category: 'paid', meter: meter.id, name: 'Prepaid units',
      expires_at: T0 + 3 * DAY,
    });
    await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 5_000, currency: 'usd', category: 'promotional', name: 'Starts next month',
      effective_at: T0 + 30 * DAY, expires_at: T0 + 90 * DAY,
    });

    const balance = await expectOk('GET', `/v1/customers/${customer}/credit-balance`);
    assert.equal(balance.balances.length, 4, 'four distinct pots of credit');

    const anythingUsd = balance.balances.find((b: any) => b.currency === 'usd' && b.kind === 'monetary' && b.applicability.scope === 'all');
    assert.equal(anythingUsd.available, 30_000);
    assert.equal(anythingUsd.applies_to, 'any charge in this currency');
    assert.equal(anythingUsd.next_expiry, null);

    const targeted = balance.balances.find((b: any) => b.kind === 'monetary' && b.applicability.scope === 'targeted');
    assert.equal(targeted.available, 12_000);
    assert.equal(targeted.applies_to, 'usage on Fixture meter', 'the pot says what it pays for, by name');
    assert.equal(targeted.next_expiry.at, T0 + 14 * DAY);
    assert.equal(targeted.by_category.promotional, 12_000);
    assert.equal(targeted.by_category.paid, 0);

    const units = balance.balances.find((b: any) => b.kind === 'unit');
    assert.equal(units.available, 2500);
    assert.equal(units.unit_label, 'unit');
    assert.equal(units.next_expiry.at, T0 + 3 * DAY);

    const usd = balance.totals_by_currency.find((t: any) => t.currency === 'usd');
    assert.equal(usd.monetary_available, 42_000);
    assert.equal(usd.unit_pots, 1);
    assert.equal(usd.next_expiry, T0 + 3 * DAY, 'the soonest expiry across every USD pot');
    assert.equal(balance.totals_by_currency.find((t: any) => t.currency === 'eur').monetary_available, 9_000);

    assert.equal(balance.scheduled.length, 1, 'credit that has not started yet is listed apart, not counted');
    assert.equal(balance.scheduled[0].name, 'Starts next month');
    assert.ok(balance.burn_order.length >= 4, 'the balance explains the order it will be spent in');
  });

  test('a targeted grant with no targets is refused', async () => {
    const error = await expectError('POST', '/v1/credit-grants', {
      customer: nextName('cus'), amount: 1000, currency: 'usd',
      applicability: { scope: 'targeted', meters: [], prices: [], products: [] },
    }, 400);
    assert.match(error.message, /at least one price, meter or product/);
  });

  test('a unit grant must name the meter whose units it holds', async () => {
    const error = await expectError('POST', '/v1/credit-grants', {
      customer: nextName('cus'), kind: 'unit', amount: 1000, currency: 'usd',
    }, 400, 'parameter_missing');
    assert.match(error.message, /cannot pay for exported gigabytes/);
  });
});

/* --------------------------- expiry and rollover -------------------------- */

describe('expiry runs as a job on the day it is due', () => {
  let clock: App;
  before(async () => { clock = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } }); });
  after(() => clock.close());

  test('a grant expiring mid-period expires exactly once', async () => {
    const customer = nextName('cus');
    const grant = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 40_000, currency: 'usd', category: 'promotional', name: 'Lapses in ten days',
      expires_at: startOfDay(T0) + 10 * DAY,
    }, clock);
    assert.equal(grant.status, 'active');

    // Nine days on, nothing has happened yet.
    await clock.travel(9 * DAY);
    const before: CreditGrant = await expectOk('GET', `/v1/credit-grants/${grant.id}`, undefined, clock);
    assert.equal(before.balance, 40_000);
    assert.equal(before.status, 'active');

    // The tenth day: the job fires and writes one expiry entry.
    await clock.travel(2 * DAY);
    const after: CreditGrant = await expectOk('GET', `/v1/credit-grants/${grant.id}`, undefined, clock);
    assert.equal(after.status, 'expired');
    assert.equal(after.balance, 0);

    const entries = await entriesOf(grant.id, clock);
    assert.deepEqual(entries.map((e) => e.type), ['grant', 'expiry']);
    assert.equal(entries[1].delta, -40_000);
    assert.equal(entries[1].balance_after, 0);
    assert.match(entries[1].reason, /Expired unused on 2026-06-12/);

    // Replaying the clock, and the job, changes nothing.
    await clock.travel(30 * DAY);
    await clock.tick();
    const replayed = await entriesOf(grant.id, clock);
    assert.equal(replayed.length, 2, 'expiry happens exactly once, however often the queue runs');

    const events = clock.ctx.events.list(ORG, { types: ['credit_grant.expired'], objectId: grant.id });
    assert.equal(events.length, 1, 'and it is announced exactly once');
    assert.equal((events[0].data as { expired: number }).expired, 40_000);
  });

  test('an expiry that has already been spent down writes nothing', async () => {
    const fx = await fixture(clock);
    const customer = nextName('cus');
    const grant = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 10_000, currency: 'usd', category: 'paid', expires_at: clock.ctx.now() + 5 * DAY,
    }, clock);
    await expectOk('POST', '/v1/credit-settlements', {
      customer, price: fx.usagePrice.id, quantity: 2000, period_start: period.start, period_end: period.end,
    }, clock);
    await clock.travel(6 * DAY);
    const entries = await entriesOf(grant.id, clock);
    assert.deepEqual(entries.map((e) => e.type), ['grant', 'burn'], 'nothing to expire, so no entry');
    const after: CreditGrant = await expectOk('GET', `/v1/credit-grants/${grant.id}`, undefined, clock);
    assert.equal(after.status, 'expired');
    assert.equal(after.balance, 0);
  });

  test('rescheduling the expiry moves the job with it', async () => {
    const customer = nextName('cus');
    const grant = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 7_000, currency: 'usd', category: 'promotional', expires_at: clock.ctx.now() + 2 * DAY,
    }, clock);
    await expectOk('PATCH', `/v1/credit-grants/${grant.id}`, { expires_at: clock.ctx.now() + 40 * DAY }, clock);
    await clock.travel(5 * DAY);
    const stillHere: CreditGrant = await expectOk('GET', `/v1/credit-grants/${grant.id}`, undefined, clock);
    assert.equal(stillHere.balance, 7_000, 'the original expiry job no longer fires');
    assert.equal(stillHere.status, 'active');
    await clock.travel(40 * DAY);
    const gone: CreditGrant = await expectOk('GET', `/v1/credit-grants/${grant.id}`, undefined, clock);
    assert.equal(gone.balance, 0);
    assert.equal(gone.status, 'expired');
  });
});

describe('rollover at period end', () => {
  let clock: App;
  before(async () => { clock = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } }); });
  after(() => clock.close());

  test('none: the unused balance simply lapses', async () => {
    const grant = await expectOk('POST', '/v1/credit-grants', {
      customer: nextName('cus'), amount: 20_000, currency: 'usd', category: 'promotional',
      rollover: 'none', expires_at: clock.ctx.now() + 3 * DAY,
    }, clock);
    await clock.travel(4 * DAY);
    const entries = await entriesOf(grant.id, clock);
    assert.deepEqual(entries.map((e) => e.type), ['grant', 'expiry']);
    assert.equal(entries[1].delta, -20_000);
  });

  test('capped: the cap rolls into a successor and the rest lapses', async () => {
    const customer = nextName('cus');
    const grant = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 100_000, currency: 'usd', category: 'paid', name: 'Quarterly allowance',
      rollover: 'capped', rollover_cap: 25_000, effective_at: clock.ctx.now(), expires_at: clock.ctx.now() + 3 * DAY,
    }, clock);
    await clock.travel(4 * DAY);

    const entries = await entriesOf(grant.id, clock);
    assert.deepEqual(entries.map((e) => e.type), ['grant', 'rollover_out', 'expiry']);
    assert.equal(entries[1].delta, -25_000);
    assert.equal(entries[2].delta, -75_000);
    assert.equal(entries[2].balance_after, 0);

    const successors: CreditGrant[] = (await expectOk('GET', `/v1/credit-grants?customer=${customer}`, undefined, clock)).data
      .filter((g: CreditGrant) => g.source === 'rollover');
    assert.equal(successors.length, 1);
    assert.equal(successors[0].balance, 25_000);
    assert.equal(successors[0].name, 'Quarterly allowance (rolled over)');
    assert.equal(successors[0].source_ref, grant.id);
    assert.equal(successors[0].rollover, 'capped', 'the policy carries into the next period');
    const successorEntries = await entriesOf(successors[0].id, clock);
    assert.deepEqual(successorEntries.map((e) => e.type), ['rollover_in']);
    assert.equal(successorEntries[0].balance_after, 25_000);
  });

  test('full: everything moves and nothing is written off', async () => {
    const customer = nextName('cus');
    const grant = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 60_000, currency: 'usd', category: 'paid',
      rollover: 'full', expires_at: clock.ctx.now() + 2 * DAY,
    }, clock);
    await clock.travel(3 * DAY);
    const entries = await entriesOf(grant.id, clock);
    assert.deepEqual(entries.map((e) => e.type), ['grant', 'rollover_out']);
    assert.equal(entries[1].balance_after, 0);
    const successor: CreditGrant = (await expectOk('GET', `/v1/credit-grants?customer=${customer}`, undefined, clock)).data
      .find((g: CreditGrant) => g.source === 'rollover');
    assert.equal(successor.balance, 60_000);
    assert.ok(successor.expires_at !== null && successor.expires_at > grant.expires_at, 'the successor covers the next window');
  });

  test('a rollover policy without an expiry is refused', async () => {
    const error = await expectError('POST', '/v1/credit-grants', {
      customer: nextName('cus'), amount: 1000, currency: 'usd', rollover: 'full',
    }, 400);
    assert.match(error.message, /Rollover happens at expiry/);
  });
});

/* ------------------------------ billable outbox --------------------------- */

describe('the invoice lines credits produce', () => {
  test('are pending until billing claims them onto an invoice', async () => {
    const { packPrice } = await fixture();
    const customer = nextName('cus');
    const topup = await expectOk('POST', '/v1/credit-topups', { customer, price: packPrice.id, quantity: 2 });

    const pending = await expectOk('GET', `/v1/credit-billable-items?customer=${customer}&status=pending`);
    assert.equal(pending.data.length, 1);
    assert.equal(pending.data[0].id, topup.line.id);

    const claimed = await expectOk('POST', '/v1/credit-billable-items/invoice', {
      items: [topup.line.id], invoice: 'in_test_1', invoice_items: { [topup.line.id]: 'il_test_1' },
    });
    assert.equal(claimed[0].status, 'invoiced');
    assert.equal(claimed[0].invoice, 'in_test_1');
    assert.equal(claimed[0].invoice_item, 'il_test_1');

    const stillPending = await expectOk('GET', `/v1/credit-billable-items?customer=${customer}&status=pending`);
    assert.equal(stillPending.data.length, 0);

    const error = await expectError('POST', '/v1/credit-billable-items/invoice', {
      items: [topup.line.id], invoice: 'in_test_2',
    }, 409, 'billable_item_already_invoiced');
    assert.match(error.message, /already on invoice in_test_1/);
  });
});

/* ---------------------- the automatic billing lifecycle ------------------- */

describe('a metered period bills itself when the cycle turns over', () => {
  let clock: App;
  before(async () => { clock = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } }); });
  after(() => clock.close());

  test('a month of usage becomes a settlement, a closed period and two invoice lines, unasked', async () => {
    const fx = await fixture(clock);
    const customer = await expectOk('POST', '/v1/customers', { name: 'Halden Robotics', currency: 'usd' }, clock);
    const sub = await expectOk('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: fx.usagePrice.id }],
    }, clock);
    const cycle = { start: sub.current_period_start, end: sub.current_period_end };
    assert.ok(cycle.end > cycle.start);

    // A prepaid pack for a thousand of the meter's own units.
    const grant: CreditGrant = await expectOk('POST', '/v1/credit-grants', {
      customer: customer.id, kind: 'unit', amount: 1000, currency: 'usd', category: 'paid', meter: fx.meter.id,
    }, clock);

    // Three weeks in, the fleet has streamed 4,000 units.
    await clock.travel(20 * DAY);
    await expectOk('POST', '/v1/meter-events/batch', {
      events: [1, 2, 3, 4].map((i) => ({
        event_name: fx.eventName, identifier: `lifecycle_${i}`,
        timestamp: cycle.start + i * 2 * DAY, payload: { customer_id: customer.id, units: 1000 },
      })),
    }, clock);

    assert.equal(
      (await expectOk('GET', `/v1/credit-settlements?customer=${customer.id}`, undefined, clock)).data.length,
      0,
      'nothing is settled while the period is still open',
    );

    // The cycle turns over. Nobody calls anything.
    await clock.travel(20 * DAY);

    const settlements = await expectOk('GET', `/v1/credit-settlements?customer=${customer.id}`, undefined, clock);
    assert.equal(settlements.data.length, 1, 'the period settled itself');
    const settlement: Settlement = settlements.data[0];
    assert.equal(settlement.period_start, cycle.start);
    assert.equal(settlement.period_end, cycle.end);
    assert.equal(settlement.billed_quantity, 4000);

    // 1,000 free units, then 10 minor units each: 4,000 units is $300, of which
    // the 1,000-unit pack takes off $100.
    assert.equal(settlement.full_amount, 30_000);
    assert.equal(settlement.covered_amount, 10_000);
    assert.equal(settlement.charged_amount, 20_000);
    assert.equal(settlement.covered_amount + settlement.charged_amount, settlement.full_amount);
    assert.equal(settlement.lines.reduce((acc, l) => acc + l.amount, 0), settlement.full_amount);
    assert.deepEqual(settlement.lines.map((l) => l.kind).sort(), ['charged', 'credit_covered']);

    const spent: CreditGrant = await expectOk('GET', `/v1/credit-grants/${grant.id}`, undefined, clock);
    assert.equal(spent.balance, 0, 'the pack was actually spent');
    assert.equal(spent.status, 'exhausted');

    // And the meter period is frozen, so anything landing in it now is a true-up.
    const usage = await expectOk('GET',
      `/v1/meters/${fx.meter.id}/usage?customer=${customer.id}&start=${cycle.start}&end=${cycle.end}`, undefined, clock);
    assert.equal(usage.closed?.total, 4000);
    assert.equal(usage.closed?.ref_id, settlement.id);
    assert.equal(usage.closed?.ref_type, 'credit_settlement');

    const announced = clock.ctx.events.list(ORG, { types: ['credit.period_settled_automatically'], limit: 50 })
      .filter((e) => (e.data as { customer: string }).customer === customer.id);
    assert.equal(announced.length, 1);
    assert.equal((announced[0].data as { subscription: string }).subscription, sub.id);
  });

  test('a period with no usage is settled and closed, but puts nothing on the invoice', async () => {
    const fx = await fixture(clock);
    const customer = await expectOk('POST', '/v1/customers', { name: 'Quiet Plant Ltd', currency: 'usd' }, clock);
    const sub = await expectOk('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: fx.usagePrice.id }],
    }, clock);
    await clock.travel(40 * DAY);

    const settlements = await expectOk('GET', `/v1/credit-settlements?customer=${customer.id}`, undefined, clock);
    assert.equal(settlements.data.length, 1, 'a quiet month is still priced and recorded');
    assert.equal(settlements.data[0].billed_quantity, 0);
    assert.equal(settlements.data[0].full_amount, 0);
    assert.deepEqual(settlements.data[0].lines, [], 'an empty month is not an invoice line');

    const usage = await expectOk('GET',
      `/v1/meters/${fx.meter.id}/usage?customer=${customer.id}&start=${sub.current_period_start}&end=${sub.current_period_end}`,
      undefined, clock);
    assert.ok(usage.closed, 'and the period is still frozen, so late usage is a true-up rather than a surprise');
  });

  test('a settlement whose usage is already billed under another window is reported, not retried forever', async () => {
    const fx = await fixture(clock);
    const customer = await expectOk('POST', '/v1/customers', { name: 'Twice Billed Metals', currency: 'usd' }, clock);
    const sub = await expectOk('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: fx.usagePrice.id }],
    }, clock);
    // A human settles a window by hand that overlaps the one the cycle will ask for.
    await expectOk('POST', '/v1/credit-settlements', {
      customer: customer.id, price: fx.usagePrice.id, quantity: 100,
      period_start: sub.current_period_start - DAY, period_end: sub.current_period_end - DAY,
    }, clock);

    const before = clock.ctx.jobs.stats().failed;
    await clock.travel(40 * DAY);
    assert.equal(clock.ctx.jobs.stats().failed, before, 'a business fact is not a transient fault');

    const skipped = clock.ctx.events.list(ORG, { types: ['credit.settlement_skipped'], limit: 50 })
      .filter((e) => (e.data as { customer: string }).customer === customer.id);
    assert.equal(skipped.length, 1);
    assert.equal((skipped[0].data as { reason: string }).reason, 'usage_period_already_settled');

    const overview = await expectOk('GET', '/v1/credits/overview', undefined, clock);
    assert.ok(
      overview.settlements_skipped.some((row: { customer: string }) => row.customer === customer.id),
      'and it is on the overview, not buried in the log',
    );
  });
});

describe('the outbox drains when an invoice is drawn', () => {
  test('credit lines land on the invoice without anybody claiming them', async () => {
    const { packPrice } = await fixture();
    const customer = nextName('cus');
    const topup = await expectOk('POST', '/v1/credit-topups', { customer, price: packPrice.id, quantity: 3 });
    assert.equal(topup.line.status, 'pending');

    // This is the event an invoicing run raises; credits does not wait to be asked.
    app.ctx.emit(ORG, 'invoice.created', { id: 'in_drain_probe', customer, currency: 'usd' }, {
      objectId: 'in_drain_probe', objectType: 'invoice',
    });

    const claimed = await expectOk('GET', `/v1/credit-billable-items?customer=${customer}`);
    assert.equal(claimed.data.length, 1);
    assert.equal(claimed.data[0].status, 'invoiced');
    assert.equal(claimed.data[0].invoice, 'in_drain_probe');
    assert.equal(
      (await expectOk('GET', `/v1/credit-billable-items?customer=${customer}&status=pending`)).data.length, 0,
    );
  });

  test('an invoice for somebody else leaves the lines where they are', async () => {
    const { packPrice } = await fixture();
    const customer = nextName('cus');
    await expectOk('POST', '/v1/credit-topups', { customer, price: packPrice.id });
    app.ctx.emit(ORG, 'invoice.created', { id: 'in_other_probe', customer: nextName('cus') }, {
      objectId: 'in_other_probe', objectType: 'invoice',
    });
    const pending = await expectOk('GET', `/v1/credit-billable-items?customer=${customer}&status=pending`);
    assert.equal(pending.data.length, 1);
  });
});

/* ------------------- the settled period reaches an invoice ---------------- */

describe('a settled period becomes something billable, on the event that fires', () => {
  let clock: App;
  before(async () => { clock = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } }); });
  after(() => clock.close());

  test('credits announce what they are holding when a cycle turns over', async () => {
    const fx = await fixture(clock);
    const customer = await expectOk('POST', '/v1/customers', { name: 'Fell Foundry', currency: 'usd' }, clock);
    const sub = await expectOk('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: fx.usagePrice.id }],
    }, clock);
    const cycle = { start: sub.current_period_start, end: sub.current_period_end };
    await clock.travel(20 * DAY);
    await expectOk('POST', '/v1/meter-events/batch', {
      events: [1, 2].map((i) => ({
        event_name: fx.eventName, identifier: `ready_${i}`,
        timestamp: cycle.start + i * 2 * DAY, payload: { customer_id: customer.id, units: 1500 },
      })),
    }, clock);
    await clock.travel(20 * DAY);

    const announced = clock.ctx.events.list(ORG, { types: ['credit.items_ready'], limit: 50 })
      .filter((e) => (e.data as { customer: string }).customer === customer.id);
    assert.equal(announced.length, 1, 'the settled period is announced, not left waiting for an invoicing module');
    const data = announced[0].data as {
      subscription: string; credit_items: BillableItem[]; credit_item_ids: string[];
      lines: unknown[]; pending_item_ids: string[];
      totals: { currency: string; amount: number; billed_total: number; credit_applied_total: number }[];
    };
    assert.equal(data.subscription, sub.id);
    assert.ok(Array.isArray(data.lines), 'billing’s own lines travel in the same payload');

    // 3,000 units: 1,000 free, then 2,000 at 10 = $200.00, all of it charged.
    const charged = data.credit_items.find((i) => i.kind === 'charged');
    assert.ok(charged, 'the metered line the cycle just produced is in the payload');
    assert.equal(charged.amount, 20_000);
    assert.equal(data.totals[0].currency, 'usd');
    assert.equal(
      data.totals[0].billed_total,
      data.credit_items.reduce((acc, i) => acc + i.billed_amount, 0),
      'the totals are the lines, added up',
    );
    assert.deepEqual(data.credit_item_ids.sort(), data.credit_items.map((i) => i.id).sort());

    // The announcement does not claim anything: that is still the invoice’s job.
    for (const item of data.credit_items) assert.equal(item.status, 'pending');
  });

  test('claiming is idempotent — a second invoice for the same customer takes nothing twice', async () => {
    const { packPrice } = await fixture();
    const customer = nextName('cus');
    await expectOk('POST', '/v1/credit-topups', { customer, price: packPrice.id });
    app.ctx.emit(ORG, 'invoice.created', { id: 'in_idem_a', customer }, { objectId: 'in_idem_a', objectType: 'invoice' });
    const first = await expectOk('GET', `/v1/credit-billable-items?customer=${customer}`);
    assert.equal(first.data[0].invoice, 'in_idem_a');

    // A retried invoicing run, and a different invoice drawn later.
    app.ctx.emit(ORG, 'invoice.created', { id: 'in_idem_a', customer }, { objectId: 'in_idem_a', objectType: 'invoice' });
    app.ctx.emit(ORG, 'invoice.created', { id: 'in_idem_b', customer }, { objectId: 'in_idem_b', objectType: 'invoice' });
    const after = await expectOk('GET', `/v1/credit-billable-items?customer=${customer}`);
    assert.equal(after.data.length, 1, 'no line was duplicated');
    assert.equal(after.data[0].invoice, 'in_idem_a', 'and the line stays on the invoice that claimed it');
  });
});

/* -------------------- periods the run refused to settle ------------------- */

describe('a refused period is a row, not a line in the log', () => {
  let clock: App;
  before(async () => { clock = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } }); });
  after(() => clock.close());

  test('the refusal names what superseded it and how much of the window that covers', async () => {
    const fx = await fixture(clock);
    const customer = await expectOk('POST', '/v1/customers', { name: 'Anchor Drift Ltd', currency: 'usd' }, clock);
    const sub = await expectOk('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: fx.usagePrice.id }],
    }, clock);
    // A window settled by hand that overlaps the one the cycle is about to ask
    // for — the shape two subscription items on offset anchors produce.
    const covering: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer: customer.id, price: fx.usagePrice.id, quantity: 100,
      period_start: sub.current_period_start - DAY, period_end: sub.current_period_end - DAY,
    }, clock);

    const failedBefore = clock.ctx.jobs.stats().failed;
    await clock.travel(40 * DAY);
    assert.equal(clock.ctx.jobs.stats().failed, failedBefore, 'a business fact is not a transient fault');

    const skipped = await expectOk(
      `GET`, `/v1/credit-settlements?customer=${customer.id}&status=skipped`, undefined, clock);
    assert.equal(skipped.data.length, 1, 'the refused period is listable');
    const row: Settlement = skipped.data[0];
    assert.equal(row.status, 'skipped');
    assert.equal(row.full_amount, 0, 'a refusal carries no money');
    assert.equal(row.period_start, sub.current_period_start);
    assert.equal(row.subscription, sub.id);
    assert.equal(row.skip?.reason, 'usage_period_already_settled');
    assert.equal(row.skip?.superseded_by, covering.id);
    assert.deepEqual(row.skip?.covered_by, [covering.id]);
    // A day of the refused window sticks out past the settled one.
    assert.ok(row.skip && row.skip.coverage_percent > 90 && row.skip.coverage_percent < 100);
    assert.equal(row.skip?.gaps.length, 1);
    assert.equal(row.skip?.gaps[0].start, sub.current_period_end - DAY);
    assert.match(row.skip?.summary ?? '', /billed elsewhere/);

    const overview = await expectOk('GET', '/v1/credits/overview', undefined, clock);
    assert.ok(overview.skipped_settlements.count >= 1);
    const contention = overview.skipped_settlements.contended_meters
      .find((row: { customer: string }) => row.customer === customer.id);
    assert.ok(contention, 'the overview names the customer whose meter two items are competing for');
    assert.equal(contention.periods_refused, 1);
    assert.equal(contention.price, fx.usagePrice.id);
    const metering = await expectOk('GET', '/v1/metering/overview', undefined, clock);
    assert.equal(metering.skipped_settlements, overview.skipped_settlements.count,
      'and the two health pages agree on the count');
    assert.equal(metering.settlement_jobs_failed, 0);

    // Settling it by hand tells the operator the same thing the row does.
    const error = await expectError('POST', '/v1/credit-settlements', {
      customer: customer.id, price: fx.usagePrice.id, quantity: 10,
      period_start: sub.current_period_start, period_end: sub.current_period_end,
    }, 409, 'usage_period_already_settled', clock);
    assert.match(error.message, new RegExp(row.id));

    // A refusal must never be the reason a later period cannot be billed.
    const later: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer: customer.id, price: fx.usagePrice.id, quantity: 10,
      period_start: sub.current_period_end, period_end: sub.current_period_end + 30 * DAY,
    }, clock);
    assert.equal(later.status, 'settled');
  });

  test('a hole that outlives a billing cycle is billed, not just named', async () => {
    const fx = await fixture(clock);
    const customer = nextName('cus');
    // A month that has only just ended, so nothing is overdue yet.
    const end = clock.ctx.now();
    const start = end - 31 * DAY;
    const mid = end - 12 * DAY;
    // 800 units of it are billed under the window that superseded the refusal.
    const covering: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: fx.usagePrice.id, quantity: 800, period_start: mid, period_end: end,
    }, clock);
    // And 400 units sit in the 19 days nothing settled at all.
    for (const [i, units] of [250, 150].entries()) {
      await expectOk('POST', '/v1/meter-events', {
        event_name: fx.eventName, customer, identifier: `${customer}_hole_${i}`,
        timestamp: start + (i + 1) * DAY, payload: { units },
      }, clock);
    }
    const skip: Settlement = clock.ctx.svc.credits.recordSkippedSettlement(ORG, {
      customer, price: fx.usagePrice.id, period_start: start, period_end: end,
      reason: 'usage_period_already_settled', message: 'overlaps a settled window',
      billing_period: { start, end },
    });
    assert.equal(skip.skip?.gaps.length, 1);
    assert.equal(skip.skip?.gaps[0].overdue, false, 'not yet — the next cycle may still fill it');
    assert.deepEqual(skip.skip?.billing_period, { start, end }, 'the cycle it belonged to is kept');

    await clock.travel(70 * DAY);

    const raised = clock.ctx.events.list(ORG, { types: ['credit.settlement_gap'], objectId: skip.id, limit: 5 });
    assert.equal(raised.length, 1, 'raised once per episode, not once a morning');
    const alert = raised[0].data as { uncovered_ms: number; filling: { start: number; end: number }[] };
    assert.equal(alert.uncovered_ms, mid - start);
    assert.deepEqual(alert.filling, [{ start, end: mid }], 'and it names the settlement it scheduled');

    // The watch did not stop at the alert: the uncovered hours are a settlement.
    const settled = await expectOk(
      'GET', `/v1/credit-settlements?customer=${customer}&status=settled`, undefined, clock);
    const fills: Settlement[] = settled.data.filter((s: Settlement) => s.period_start === start && s.period_end === mid);
    assert.equal(fills.length, 1, 'the hole is billed exactly once');
    assert.equal(fills[0].quantity, 400, 'for exactly the usage in it');
    // Priced from where the cycle had already climbed: the covering window
    // spent 800 of the 1,000 free units, so these 400 pay for 200 of them.
    assert.equal(fills[0].tier_basis.prior_quantity, 800);
    assert.deepEqual(fills[0].tier_basis.settlements, [covering.id]);
    assert.equal(fills[0].full_amount, 2_000);
    assert.equal(fills[0].charged_amount, 2_000, 'and it is money somebody can be invoiced for');
    const line = (await expectOk(
      'GET', `/v1/credit-billable-items?customer=${customer}&settlement=${fills[0].id}`, undefined, clock)).data[0];
    assert.equal(line.billed_amount, 2_000);
    assert.equal(line.status, 'pending', 'waiting for the next invoice like any other line');

    // And the alert is taken back the moment the money exists, not a day later.
    const closed = clock.ctx.events.list(ORG, { types: ['credit.settlement_gap_closed'], objectId: skip.id, limit: 5 });
    assert.equal(closed.length, 1);
    assert.equal((closed[0].data as { coverage_percent: number }).coverage_percent, 100);
    const filled: Settlement = await expectOk('GET', `/v1/credit-settlements/${skip.id}`, undefined, clock);
    assert.deepEqual(filled.skip?.gaps, []);
    assert.equal(filled.skip?.coverage_percent, 100);
    const overview = await expectOk('GET', '/v1/credits/overview', undefined, clock);
    assert.equal(
      overview.skipped_settlements.unbilled_windows.filter((w: { settlement: string }) => w.settlement === skip.id).length,
      0, 'and the front page stops asking a human to do it');

    // Asked once and no more: a week of further watches bills nothing again.
    await clock.travel(7 * DAY);
    const again = await expectOk(
      'GET', `/v1/credit-settlements?customer=${customer}&status=settled`, undefined, clock);
    assert.equal(again.data.filter((s: Settlement) => s.period_start === start).length, 1);
    assert.equal(
      clock.ctx.events.list(ORG, { types: ['credit.settlement_gap_closed'], objectId: skip.id, limit: 5 }).length, 1);
  });
});

/* ---------------- settling a metered period is billing it ----------------- */

describe('settling a metered period through the API freezes it', () => {
  const MAY = Date.UTC(2026, 4, 1);
  const JUNE = Date.UTC(2026, 5, 1);

  /** A meter and a flat 10-minor-unit price, so every figure is arithmetic. */
  async function metered() {
    const eventName = nextName('fz');
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Freeze meter', event_name: eventName, aggregation: 'sum', value_key: 'units',
      unit_label: 'unit', acceptance_window_ms: 90 * DAY,
    });
    const product = await expectOk('POST', '/v1/products', {
      name: 'Freeze telemetry', unit_label: 'unit', category: 'component',
    });
    const price = await expectOk('POST', '/v1/prices', {
      product: product.id, currency: 'usd', model: 'usage', type: 'recurring', unit_amount: 10,
      nickname: 'Freeze usage',
      recurring: { interval: 'month', usage_type: 'metered', aggregate_usage: 'sum', meter: eventName },
    });
    return { meter, price, eventName, customer: nextName('cus') };
  }

  const record = (fx: { eventName: string; customer: string }, id: string, units: number, at: number) =>
    call('POST', '/v1/meter-events', {
      event_name: fx.eventName, customer: fx.customer, identifier: `${fx.customer}_${id}`,
      timestamp: at, payload: { units },
    });

  const usageOf = (fx: { meter: { id: string }; customer: string }) =>
    expectOk('GET', `/v1/meters/${fx.meter.id}/usage?customer=${fx.customer}&start=${MAY}&end=${JUNE}`);

  test('usage that lands after the period is billed is a true-up, not a silent number', async () => {
    const fx = await metered();
    await record(fx, 'first', 100, MAY + DAY);
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE,
    });
    assert.equal(settlement.quantity, 100);
    assert.equal(settlement.full_amount, 1_000, '100 units at 10');

    // Nobody asked for the freeze, because billing a metered period is what
    // asks for it: the window is closed on the price it was billed against.
    const closures = await expectOk('GET', `/v1/meter-period-closures?customer=${fx.customer}`);
    assert.equal(closures.data.length, 1);
    assert.equal(closures.data[0].total, 100);
    assert.equal(closures.data[0].price, fx.price.id);
    assert.equal(closures.data[0].ref_id, settlement.id);

    // 500 units for May turn up after the invoice went out.
    const late = await record(fx, 'late', 500, MAY + 20 * DAY);
    assert.equal(late.status, 201);
    assert.equal(late.body.event.late, true, 'the event is accepted and flagged');
    assert.equal(late.body.late_arrival.value, 500);
    assert.equal(late.body.late_arrival.resolution, 'open');

    const usage = await usageOf(fx);
    assert.equal(usage.value, 600, 'the meter moves');
    assert.equal(usage.closed.total, 100, 'the invoiced total does not');
    assert.equal(usage.late_adjustment.value, 500, 'and the difference is stated, not lost');
    const health = await expectOk('GET', '/v1/metering/overview');
    assert.ok(health.open_late_arrivals >= 1, 'the health page counts it');

    // The 500 units are recoverable to the cent, on the price the period was
    // billed on — which is the whole difference the freeze makes.
    const resolved = await expectOk('POST', `/v1/meter-late-arrivals/${late.body.late_arrival.id}/resolve`, {
      resolution: 'rebilled',
    });
    assert.equal(resolved.amount, 5_000);
    const after: Settlement = await expectOk('GET', `/v1/credit-settlements/${settlement.id}`);
    assert.equal(after.true_ups.length, 1);
    assert.equal(after.net_amount, 6_000, 'the period is now worth what the meter reads');
    assert.equal(after.net_charged_amount, 6_000);
  });

  test('`close_period: false` prices a window without claiming it was billed', async () => {
    const fx = await metered();
    await record(fx, 'first', 100, MAY + DAY);
    const quoted: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE, close_period: false,
    });
    assert.equal(quoted.full_amount, 1_000);
    const closures = await expectOk('GET', `/v1/meter-period-closures?customer=${fx.customer}`);
    assert.equal(closures.data.length, 0, 'nothing claims this window has been billed');

    const late = await record(fx, 'late', 500, MAY + 20 * DAY);
    assert.equal(late.body.event.late, false, 'with no closure there is nothing to be late for');
    assert.equal(late.body.late_arrival, null);
    assert.equal((await usageOf(fx)).value, 600);

    // The escape hatch is honest about what it costs: re-settling says the
    // period has moved and that nothing was filed to catch it.
    const replay = await call('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE, close_period: false,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.drift.live_quantity, 600);
    assert.equal(replay.body.drift.closure, null);
    assert.deepEqual(replay.body.drift.open_late_arrivals, []);
    assert.match(replay.body.drift.message, /close_period: false/);
  });

  test('re-settling a period whose meter has moved is a 200 that names the drift', async () => {
    const fx = await metered();
    const grant: CreditGrant = await expectOk('POST', '/v1/credit-grants', {
      customer: fx.customer, amount: 10_000, currency: 'usd', category: 'paid', name: 'Drift probe',
    });
    await record(fx, 'first', 100, MAY + DAY);
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE,
    });
    assert.equal(settlement.covered_amount, 1_000);
    assert.equal((await expectOk('GET', `/v1/credit-grants/${grant.id}`)).balance, 9_000);
    await record(fx, 'late', 500, MAY + 20 * DAY);

    const again = await call('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE,
    });
    assert.equal(again.status, 200, 'nothing was created, so it does not say 201');
    assert.equal(again.body.id, settlement.id);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.quantity, 100, 'the settlement still says what it billed');
    assert.equal(again.body.drift.settled_quantity, 100);
    assert.equal(again.body.drift.live_quantity, 600, 'and the drift says what the meter says');
    assert.equal(again.body.drift.delta, 500);
    assert.equal(again.body.drift.outstanding_amount, 5_000);
    assert.equal(again.body.drift.open_late_arrivals.length, 1);
    assert.match(again.body.drift.message, /Resolve it through POST/);
    assert.equal((await expectOk('GET', `/v1/credit-grants/${grant.id}`)).balance, 9_000,
      'and the balance was not drawn a second time');
    const rows = await expectOk('GET', `/v1/credit-settlements?customer=${fx.customer}&status=all`);
    assert.equal(rows.data.length, 1, 'one window, one settlement');

    // Settling just the sliver the late event sits in is still refused — it
    // would draw credit twice — but the refusal now points at the recovery.
    const sliver = await expectError('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id,
      period_start: MAY + 19 * DAY, period_end: MAY + 21 * DAY,
    }, 409, 'usage_period_already_settled');
    assert.equal(sliver.detail.drift.live_quantity, 600);
    assert.equal(sliver.detail.drift.open_late_arrivals.length, 1);
    assert.match(sliver.message, /filed as late arrival/);
  });

  test('usage withdrawn from a billed period reads as money owed back', async () => {
    const fx = await metered();
    await record(fx, 'only', 300, MAY + DAY);
    await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE,
    });
    await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: `${fx.customer}_only` } });

    const again = await call('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE,
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.drift.live_quantity, 0);
    assert.equal(again.body.drift.delta, -300);
    assert.equal(again.body.drift.outstanding_amount, -3_000, 'the customer was billed for usage that was unsaid');
    assert.match(again.body.drift.message, /back to the customer/);
  });

  test('two prices on one meter share the window they both bill, and cannot half-share it', async () => {
    const fx = await metered();
    // A surcharge billed off the same meter, monthly like the first.
    const surcharge = await expectOk('POST', '/v1/prices', {
      product: fx.price.product, currency: 'usd', model: 'usage', type: 'recurring', unit_amount: 2,
      nickname: 'Freeze surcharge',
      recurring: { interval: 'month', usage_type: 'metered', aggregate_usage: 'sum', meter: fx.eventName },
    });
    await record(fx, 'first', 100, MAY + DAY);
    const base: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE,
    });
    const extra: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: surcharge.id, period_start: MAY, period_end: JUNE,
    });
    assert.equal(base.full_amount, 1_000);
    assert.equal(extra.full_amount, 200, 'both prices bill the same 100 units, each on its own rate');
    const closures = await expectOk('GET', `/v1/meter-period-closures?customer=${fx.customer}`);
    assert.equal(closures.data.length, 1, 'one window, one freeze — the second settlement joined it');

    // Half-overlapping windows are the case that cannot be shared: a late
    // event would be priced against whichever closure happened to catch it.
    // A third price on the same meter, billed fortnightly, is how that shape
    // turns up — nothing about its own windows is wrong, so the settlement
    // guard lets it through and the freeze is what refuses.
    const fortnightly = await expectOk('POST', '/v1/prices', {
      product: fx.price.product, currency: 'usd', model: 'usage', type: 'recurring', unit_amount: 1,
      nickname: 'Freeze fortnightly',
      recurring: { interval: 'week', interval_count: 2, usage_type: 'metered', aggregate_usage: 'sum', meter: fx.eventName },
    });
    const clash = await expectError('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fortnightly.id,
      period_start: MAY + 15 * DAY, period_end: MAY + 29 * DAY,
    }, 409, 'meter_period_overlaps_closure');
    assert.match(clash.message, /close_period: false/);
    assert.equal(
      (await expectOk('GET', `/v1/credit-settlements?customer=${fx.customer}&status=all`)).data.length, 2,
      'and the refusal wrote nothing',
    );
    // Which is exactly what the escape hatch is for.
    const priced: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fortnightly.id, close_period: false,
      period_start: MAY + 15 * DAY, period_end: MAY + 29 * DAY,
    });
    assert.equal(priced.status, 'settled');
    assert.equal((await expectOk('GET', `/v1/meter-period-closures?customer=${fx.customer}`)).data.length, 1,
      'the price that owns the freeze still owns it');
  });

  test('a price with no meter behind it settles on the quantity given, and closes nothing', async () => {
    const product = await expectOk('POST', '/v1/products', {
      name: 'Manual telemetry', unit_label: 'unit', category: 'component',
    });
    const price = await expectOk('POST', '/v1/prices', {
      product: product.id, currency: 'usd', model: 'usage', type: 'recurring', unit_amount: 10,
      nickname: 'Manual usage', recurring: { interval: 'month', usage_type: 'metered', aggregate_usage: 'sum' },
    });
    const customer = nextName('cus');
    const settled: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: price.id, quantity: 250, period_start: MAY, period_end: JUNE,
    });
    assert.equal(settled.meter, null);
    assert.equal(settled.full_amount, 2_500);
    assert.equal((await expectOk('GET', `/v1/meter-period-closures?customer=${customer}`)).data.length, 0);
    // ...and with no meter there is nothing to aggregate, so the quantity is
    // required rather than assumed.
    const error = await expectError('POST', '/v1/credit-settlements', {
      customer, price: price.id, period_start: JUNE, period_end: Date.UTC(2026, 6, 1),
    }, 400, 'meter_required');
    assert.match(error.message, /names no meter/);
  });
});

/* ------------------ credit that paid for withdrawn usage ------------------ */

describe('a true-up gives back the credit that paid for it', () => {
  const MAY = Date.UTC(2026, 4, 1);
  const JUNE = Date.UTC(2026, 5, 1);

  // Its own clock, because one of these tests has to watch a grant lapse.
  let clock: App;
  before(async () => { clock = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } }); });
  after(() => clock.close());

  /** A metered price at $1.00 a unit, so every number below is readable. */
  async function flatFixture() {
    const eventName = nextName('rs');
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Restore meter', event_name: eventName, aggregation: 'sum', value_key: 'units',
      unit_label: 'unit', acceptance_window_ms: 120 * DAY,
    }, clock);
    const product = await expectOk('POST', '/v1/products', { name: 'Restore telemetry', unit_label: 'unit', category: 'component' }, clock);
    const price = await expectOk('POST', '/v1/prices', {
      product: product.id, currency: 'usd', model: 'usage', type: 'recurring', unit_amount: 100,
      nickname: 'Restore usage',
      recurring: { interval: 'month', usage_type: 'metered', aggregate_usage: 'sum', meter: eventName },
    }, clock);
    return { meter, price, eventName, customer: nextName('cus') };
  }

  const record = (fx: { eventName: string; customer: string }, identifier: string, units: number) =>
    expectOk('POST', '/v1/meter-events', {
      event_name: fx.eventName, identifier: `${fx.customer}_${identifier}`,
      timestamp: MAY + DAY, payload: { customer_id: fx.customer, units },
    }, clock);

  test('withdrawn usage returns credit pro rata, and never more than was drawn', async () => {
    const fx = await flatFixture();
    const grant: CreditGrant = await expectOk('POST', '/v1/credit-grants', {
      customer: fx.customer, amount: 4_000, currency: 'usd', category: 'paid',
    }, clock);
    await record(fx, 'x', 60);
    await record(fx, 'y', 40);
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE, close_period: true,
    }, clock);
    assert.equal(settlement.full_amount, 10_000);
    assert.equal(settlement.covered_amount, 4_000);
    assert.equal((await expectOk('GET', `/v1/credit-grants/${grant.id}`, undefined, clock)).balance, 0);

    // $40.00 of the $100.00 comes off. Credit paid for 40% of the period, so
    // 40% of the withdrawal goes back to the grant and the rest comes off cash.
    const adjustment = await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: `${fx.customer}_y` } }, clock);
    const resolved = await expectOk('POST', `/v1/meter-late-arrivals/${adjustment.late_arrival}/resolve`, { resolution: 'credited' }, clock);
    assert.equal(resolved.amount, -4_000);
    assert.equal(resolved.credit_restored, 1_600);

    const restored: CreditGrant = await expectOk('GET', `/v1/credit-grants/${grant.id}`, undefined, clock);
    assert.equal(restored.balance, 1_600);
    const ledger = await expectOk('GET', `/v1/credit-grants/${grant.id}/ledger`, undefined, clock);
    assert.equal(ledger.reconciled, true);
    assert.deepEqual(ledger.entries.map((e: LedgerEntry) => e.type), ['grant', 'burn', 'refund']);
    assert.equal(ledger.entries[2].ref_type, 'credit_true_up');

    const items: BillableItem[] = (await expectOk('GET', `/v1/credit-billable-items?customer=${fx.customer}`, undefined, clock)).data;
    assert.equal(items.reduce((acc, i) => acc + i.amount, 0), 6_000, 'the lines are worth what the meter now reads');
    assert.equal(items.reduce((acc, i) => acc + i.billed_amount, 0), 3_600, 'and the cash half is the rest');
    assert.equal(
      items.reduce((acc, i) => acc + i.credit_applied, 0), grant.amount - restored.balance,
      'credit applied across the lines equals credit actually spent from the grant',
    );

    // Withdrawing the rest can never hand back more than the grant ever gave.
    const rest = await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: `${fx.customer}_x` } }, clock);
    const second = await expectOk('POST', `/v1/meter-late-arrivals/${rest.late_arrival}/resolve`, { resolution: 'credited' }, clock);
    assert.equal(second.credit_restored, 2_400);
    const whole: CreditGrant = await expectOk('GET', `/v1/credit-grants/${grant.id}`, undefined, clock);
    assert.equal(whole.balance, 4_000, 'every cent back, and not one more');
    assert.equal((await expectOk('GET', `/v1/credit-grants/${grant.id}/ledger`, undefined, clock)).reconciled, true);
    const cleared: BillableItem[] = (await expectOk('GET', `/v1/credit-billable-items?customer=${fx.customer}`, undefined, clock)).data;
    assert.equal(cleared.reduce((acc, i) => acc + i.billed_amount, 0), 0);
  });

  test('a grant that has expired since cannot take it back, so the customer gets cash instead', async () => {
    const fx = await flatFixture();
    const expires = T0 + 10 * DAY;
    await expectOk('POST', '/v1/credit-grants', {
      customer: fx.customer, amount: 5_000, currency: 'usd', category: 'promotional', expires_at: expires,
    }, clock);
    await record(fx, 'a', 100);
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE, close_period: true,
    }, clock);
    assert.equal(settlement.covered_amount, 5_000);

    // Long after the grant lapsed, the usage turns out never to have run.
    await clock.travel(11 * DAY);
    const adjustment = await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: `${fx.customer}_a` } }, clock);
    const resolved = await expectOk('POST', `/v1/meter-late-arrivals/${adjustment.late_arrival}/resolve`, { resolution: 'credited' }, clock);
    assert.equal(resolved.amount, -10_000);
    assert.equal(resolved.credit_restored, 0, 'credit the customer could never spend is not a refund');
    const items: BillableItem[] = (await expectOk('GET', `/v1/credit-billable-items?customer=${fx.customer}`, undefined, clock)).data;
    assert.equal(items.reduce((acc, i) => acc + i.billed_amount, 0), -5_000, 'so it comes off the bill as cash');
  });

  test('a period paid for in units gives the units back, not cash it never took', async () => {
    const eventName = nextName('ru');
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Unit restore meter', event_name: eventName, aggregation: 'sum', value_key: 'units',
      unit_label: 'unit', acceptance_window_ms: 120 * DAY,
    }, clock);
    const product = await expectOk('POST', '/v1/products', { name: 'Unit restore telemetry', unit_label: 'unit', category: 'component' }, clock);
    const price = await expectOk('POST', '/v1/prices', {
      product: product.id, currency: 'usd', model: 'usage', type: 'recurring', unit_amount: 100,
      nickname: 'Unit restore usage',
      recurring: { interval: 'month', usage_type: 'metered', aggregate_usage: 'sum', meter: eventName },
    }, clock);
    const customer = nextName('cus');
    const pack: CreditGrant = await expectOk('POST', '/v1/credit-grants', {
      customer, kind: 'unit', amount: 40, currency: 'usd', category: 'paid', meter: meter.id,
    }, clock);
    for (const [id, units] of [['a', 60], ['b', 40]] as [string, number][]) {
      await expectOk('POST', '/v1/meter-events', {
        event_name: eventName, identifier: `${customer}_${id}`,
        timestamp: MAY + DAY, payload: { customer_id: customer, units },
      }, clock);
    }
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: price.id, period_start: MAY, period_end: JUNE, close_period: true,
    }, clock);
    assert.equal(settlement.full_amount, 10_000);
    assert.equal(settlement.covered_quantity, 40, 'the pack took 40 units off the bill');
    assert.equal(settlement.covered_amount, 4_000);
    assert.equal((await expectOk('GET', `/v1/credit-grants/${pack.id}`, undefined, clock)).balance, 0);

    const adjustment = await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: `${customer}_b` } }, clock);
    const resolved = await expectOk('POST', `/v1/meter-late-arrivals/${adjustment.late_arrival}/resolve`, { resolution: 'credited' }, clock);
    assert.equal(resolved.amount, -4_000);
    assert.equal(resolved.credit_restored, 1_600, '40% of the withdrawal, because units paid for 40% of it');

    const restored: CreditGrant = await expectOk('GET', `/v1/credit-grants/${pack.id}`, undefined, clock);
    assert.equal(restored.balance, 16, 'and it comes back as units, in the denomination the grant is held in');
    assert.equal((await expectOk('GET', `/v1/credit-grants/${pack.id}/ledger`, undefined, clock)).reconciled, true);

    const reread: Settlement = await expectOk('GET', `/v1/credit-settlements/${settlement.id}`, undefined, clock);
    assert.equal(reread.lines.reduce((acc, l) => acc + l.amount, 0), reread.full_amount,
      'the invoice’s own lines still sum to what the invoice said');
    assert.equal(reread.true_ups.length, 1);
    assert.equal(reread.net_amount, 6_000, 'and the period is worth 60 units today');
  });

  test('late usage meets the burn order like any other charge', async () => {
    const fx = await flatFixture();
    await record(fx, 'base', 20);
    await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE, close_period: true,
    }, clock);
    // The customer buys credit after the invoice, then late usage lands.
    const grant: CreditGrant = await expectOk('POST', '/v1/credit-grants', {
      customer: fx.customer, amount: 1_000, currency: 'usd', category: 'paid',
    }, clock);
    const late = await expectOk('POST', '/v1/meter-events', {
      event_name: fx.eventName, identifier: `${fx.customer}_late`,
      timestamp: MAY + 2 * DAY, payload: { customer_id: fx.customer, units: 15 },
    }, clock);
    const resolved = await expectOk('POST', `/v1/meter-late-arrivals/${late.late_arrival.id}/resolve`, { resolution: 'rebilled' }, clock);
    assert.equal(resolved.amount, 1_500, '15 units at $1.00');
    assert.equal(resolved.credit_restored, -1_000, 'the balance is spent on it, not billed around it');
    assert.equal((await expectOk('GET', `/v1/credit-grants/${grant.id}`, undefined, clock)).balance, 0);
    const trueUp: BillableItem = (await expectOk('GET', `/v1/credit-billable-items?customer=${fx.customer}&kind=true_up`, undefined, clock)).data[0];
    assert.equal(trueUp.amount, 1_500);
    assert.equal(trueUp.billed_amount, 500);
    assert.equal(trueUp.credit_applied, 1_000);
  });
});

/* ----------------------- amounts wider than a double ---------------------- */

describe('a balance that passes 2^53 micro-units', () => {
  test('a $90m prepaid pool is granted, read back and spent', async () => {
    const customer = nextName('cus');
    // 9,007,199,255 minor units is one past 2^53 once scaled to micro-units,
    // which used to make every read of the grant a permanent 500.
    const grant: CreditGrant = await expectOk('POST', '/v1/credit-grants', {
      customer, amount: 9_007_199_255, currency: 'usd', category: 'paid',
    });
    assert.equal(grant.balance, 9_007_199_255);
    assert.equal(grant.amount_decimal, '9007199255');

    const listed = await expectOk('GET', `/v1/credit-grants?customer=${customer}`);
    assert.equal(listed.data[0].balance, 9_007_199_255);
    const ledger = await expectOk('GET', `/v1/credit-grants/${grant.id}/ledger`);
    assert.equal(ledger.reconciled, true);
    assert.equal(ledger.entries[0].balance_after_decimal, '9007199255');

    const balance = await expectOk('GET', `/v1/customers/${customer}/credit-balance`);
    assert.equal(balance.totals_by_currency[0].monetary_available, 9_007_199_255);
  });

  test('an amount that could not be read back is a 400 naming the ceiling', async () => {
    const error = await expectError('POST', '/v1/credit-grants', {
      customer: nextName('cus'), amount: 1e14, currency: 'usd', category: 'paid',
    }, 400, 'amount_out_of_range');
    assert.match(error.message, /largest value this platform stores exactly/);
    assert.equal(error.param, 'amount');
  });
});

/* ---------------------------- the demo workspace -------------------------- */

describe('the Northwind workspace', () => {
  test('the seeded settlement adds up and reads like an invoice', async () => {
    const settlements = await expectOk('GET', '/v1/credit-settlements?limit=200');
    const settlement: Settlement | undefined = settlements.data
      .find((s: Settlement) => s.price === 'price_nw_telemetry_events');
    assert.ok(settlement, 'the demo has a settled telemetry period');
    assert.equal(settlement.covered_amount + settlement.charged_amount, settlement.full_amount);
    assert.equal(settlement.lines.reduce((acc, l) => acc + l.amount, 0), settlement.full_amount);
    assert.deepEqual(settlement.lines.map((l) => l.kind).sort(), ['charged', 'credit_covered']);
    assert.ok(settlement.applications.length >= 1);
    assert.ok(settlement.applications[0].drawn > 0);
  });

  test('every seeded grant reconciles against its own ledger', async () => {
    const grants = await expectOk('GET', '/v1/credit-grants?limit=500');
    assert.ok(grants.data.length >= 5);
    for (const grant of grants.data as CreditGrant[]) {
      const ledger = await expectOk('GET', `/v1/credit-grants/${grant.id}/ledger`);
      assert.equal(ledger.reconciled, true, `${grant.name} does not reconcile`);
      const summed = ledger.entries.reduce((acc: number, e: LedgerEntry) => acc + e.delta, 0);
      assert.equal(summed, grant.balance, `${grant.name}: the ledger and the balance disagree`);
    }
  });

  test('the seeded workspace shows an invoice being corrected after it was sent', async () => {
    const entries = await expectOk('GET', '/v1/meter-late-arrivals?limit=50');
    const credited = entries.data.find((e: { resolution: string }) => e.resolution === 'credited');
    assert.ok(credited, 'Meridian’s gateway replayed a shift, and the demo shows what happened next');
    assert.ok(credited.amount < 0, 'the correction is money, not a label');
    assert.equal(credited.currency, 'usd');
    assert.ok(credited.billable_item, 'and it points at the line it became');

    const line = (await expectOk(`GET`, `/v1/credit-billable-items?kind=true_up&limit=50`)).data
      .find((i: { id: string }) => i.id === credited.billable_item);
    assert.ok(line);
    assert.equal(line.amount, credited.amount);
    assert.equal(line.billed_amount + line.credit_applied, line.amount, 'the halves of a true-up add up too');

    const settlement: Settlement | undefined = (await expectOk('GET', '/v1/credit-settlements?limit=200')).data
      .find((s: Settlement) => s.true_ups.some((l) => l.id === credited.billable_item));
    assert.ok(settlement, 'the settlement carries the correction beside the original lines');
    assert.equal(settlement.lines.reduce((acc, l) => acc + l.amount, 0), settlement.full_amount);
    assert.equal(settlement.net_amount, settlement.full_amount + settlement.true_ups.reduce((acc, l) => acc + l.amount, 0));
    assert.ok(settlement.net_amount < settlement.full_amount, 'the customer is billed less than they were');

    // The credit that paid for the withdrawn shift went back to the pack.
    const returned = (await expectOk('GET', `/v1/credit-ledger?customer=${settlement.customer}&limit=200`)).data
      .filter((e: LedgerEntry) => e.type === 'refund' && e.ref_type === 'credit_true_up');
    assert.equal(returned.length, 1);
    assert.ok(returned[0].delta > 0);
    const grantLedger = await expectOk('GET', `/v1/credit-grants/${returned[0].grant}/ledger`);
    assert.equal(grantLedger.reconciled, true);
  });

  test('the overview names what is about to expire', async () => {
    const overview = await expectOk('GET', '/v1/credits/overview');
    assert.ok(overview.grants.total >= 5);
    assert.ok(overview.burn_order.length >= 4);
    assert.ok(overview.outstanding.length >= 1);
    assert.ok(overview.expiring_within_7_days.length >= 1, 'a Northwind account has credit lapsing this week');
    assert.ok(overview.pending_invoice_lines.count >= 1);
  });

  test('a customer with no credit gets an empty, well-formed balance', async () => {
    const balance = await expectOk('GET', '/v1/customers/cus_nobody/credit-balance');
    assert.deepEqual(balance.balances, []);
    assert.deepEqual(balance.totals_by_currency, []);
    assert.deepEqual(balance.scheduled, []);
    assert.ok(balance.burn_order.length >= 4, 'even an empty balance explains the rules');
  });
});

/* ------------- the tier ladder belongs to the billing period -------------- */

/**
 * A graduated price gives its first 1,000 units away *once a month*, not once
 * per settlement. Everything below is the same 4,321 units of May, cut up in
 * different ways, and the money has to come out the same every time — because a
 * plan change mid-cycle, a cancel and restart, and the platform's own remedy
 * for an unbilled gap all cut a period into more than one window.
 */
describe('the tier ladder belongs to the billing period, not to the window', () => {
  const MAY = { start: Date.UTC(2026, 4, 1), end: Date.UTC(2026, 5, 1) };
  const SPAN = MAY.end - MAY.start;
  /** 4,321 units: 1,000 free, 3,321 at 10 minor units each. */
  const TOTAL_UNITS = 4321;
  const WHOLE_PERIOD_AMOUNT = 33_210;

  /** Cut May into `parts` windows and settle `quantities[i]` into each. */
  async function settlePartition(
    priceId: string, quantities: number[], opts: { reverse?: boolean } = {},
  ): Promise<Settlement[]> {
    const customer = nextName('cus');
    const edges = quantities.map((_, i) => MAY.start + Math.round((i * SPAN) / quantities.length));
    edges.push(MAY.end);
    const order = quantities.map((_, i) => i);
    if (opts.reverse) order.reverse();
    const out: Settlement[] = [];
    for (const i of order) {
      out.push(await expectOk('POST', '/v1/credit-settlements', {
        customer, price: priceId, quantity: quantities[i],
        period_start: edges[i], period_end: edges[i + 1],
      }));
    }
    return out;
  }

  test('a month settled in two halves costs exactly what the month costs', async () => {
    const { usagePrice } = await fixture();
    const whole = await settlePartition(usagePrice.id, [TOTAL_UNITS]);
    assert.equal(whole[0].full_amount, WHOLE_PERIOD_AMOUNT);

    const halves = await settlePartition(usagePrice.id, [2000, 2321]);
    // 2,000 units alone are 1,000 free + 1,000 charged = $100.00; the second
    // window starts at unit 2,001 and pays for every one of its 2,321.
    assert.equal(halves[0].full_amount, 10_000);
    assert.equal(halves[1].full_amount, 23_210);
    assert.equal(
      halves[0].full_amount + halves[1].full_amount, whole[0].full_amount,
      'the halves add up to the whole — the free tier is given away once',
    );
    assert.equal(halves[1].tier_basis.prior_quantity, 2000);
    assert.equal(halves[1].tier_basis.prior_amount, 10_000);
    assert.equal(halves[1].tier_basis.cumulative_quantity, TOTAL_UNITS);
    assert.equal(halves[1].tier_basis.cumulative_amount, WHOLE_PERIOD_AMOUNT);
    assert.deepEqual(halves[1].tier_basis.settlements, [halves[0].id]);
  });

  test('every partition of a period sums to the single-window total', async () => {
    const { usagePrice } = await fixture();
    const partitions: number[][] = [
      [TOTAL_UNITS],
      [900, 3421],
      [1, TOTAL_UNITS - 1],
      [1000, 1000, 2321],
      [0, TOTAL_UNITS, 0],
      [700, 800, 900, 1000, 921],
      [4000, 100, 100, 100, 21],
    ];
    for (const quantities of partitions) {
      const settled = await settlePartition(usagePrice.id, quantities);
      const total = settled.reduce((acc, s) => acc + s.full_amount, 0);
      assert.equal(
        total, WHOLE_PERIOD_AMOUNT,
        `partition ${JSON.stringify(quantities)} billed ${total}, not ${WHOLE_PERIOD_AMOUNT}`,
      );
      // And the units add up too: no window bills a unit twice or drops one.
      assert.equal(settled.reduce((acc, s) => acc + s.billed_quantity, 0), TOTAL_UNITS);
    }
  });

  test('windows settled out of order still sum to the whole', async () => {
    const { usagePrice } = await fixture();
    const settled = await settlePartition(usagePrice.id, [700, 800, 900, 1000, 921], { reverse: true });
    assert.equal(settled.reduce((acc, s) => acc + s.full_amount, 0), WHOLE_PERIOD_AMOUNT);
    // The last window settled is the one that sees every other, whichever end
    // of the month it sits at.
    const last = settled[settled.length - 1];
    assert.equal(last.tier_basis.prior_quantity, TOTAL_UNITS - last.billed_quantity);
    assert.equal(last.tier_basis.settlements.length, 4);
  });

  test('the next billing period starts the ladder again', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    const may: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: TOTAL_UNITS,
      period_start: MAY.start, period_end: MAY.end,
    });
    const june: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 900,
      period_start: MAY.end, period_end: Date.UTC(2026, 6, 1),
    });
    assert.equal(may.full_amount, WHOLE_PERIOD_AMOUNT);
    assert.equal(june.tier_basis.prior_quantity, 0, 'June is a new month, so June gets its own free tier');
    assert.equal(june.full_amount, 0);
    assert.deepEqual(june.tier_basis.settlements, []);
    assert.equal(june.tier_basis.period_start, MAY.end);
  });

  test('the settlement explains the rung it was priced from', async () => {
    const { usagePrice } = await fixture();
    const [first, second] = await settlePartition(usagePrice.id, [2000, 2321]);
    assert.equal(first.tier_basis.source, 'derived');
    assert.match(first.tier_basis.explanation, /tier ladder starts at zero/);
    assert.match(second.tier_basis.explanation, /2000 of the billing period/);
    assert.match(second.tier_basis.explanation, /rather than starting the tier ladder again/);

    const reread: Settlement = await expectOk('GET', `/v1/credit-settlements/${second.id}`);
    assert.equal(reread.tier_basis.prior_quantity, 2000);
    assert.equal(reread.tier_basis.prior_amount, 10_000);
  });

  test('a caller can state the billing period, and a window outside it is refused', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    const stub: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 2000,
      period_start: MAY.start, period_end: Date.UTC(2026, 4, 12),
      billing_period_start: MAY.start, billing_period_end: MAY.end,
    });
    assert.equal(stub.tier_basis.source, 'stated');
    assert.equal(stub.tier_basis.period_end, MAY.end);

    const rest: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 2321,
      period_start: Date.UTC(2026, 4, 12), period_end: MAY.end,
      billing_period_start: MAY.start, billing_period_end: MAY.end,
    });
    assert.equal(stub.full_amount + rest.full_amount, WHOLE_PERIOD_AMOUNT);

    const error = await expectError('POST', '/v1/credit-settlements', {
      customer: nextName('cus'), price: usagePrice.id, quantity: 10,
      period_start: MAY.start, period_end: MAY.end,
      billing_period_start: Date.UTC(2026, 4, 10), billing_period_end: MAY.end,
    }, 400, 'parameter_invalid');
    assert.match(error.message, /is not inside the billing period/);
    assert.equal(error.param, 'billing_period_start');

    const half = await expectError('POST', '/v1/credit-settlements', {
      customer: nextName('cus'), price: usagePrice.id, quantity: 10,
      period_start: MAY.start, period_end: MAY.end, billing_period_start: MAY.start,
    }, 400, 'parameter_missing');
    assert.equal(half.param, 'billing_period_end');
  });

  test('the gap left by a refused settlement collects the money it is worth', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    // The bulk of May is billed under one window; four days at the end are not.
    const covered: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 4000,
      period_start: MAY.start, period_end: Date.UTC(2026, 4, 28),
    });
    assert.equal(covered.full_amount, 30_000);

    // This is the documented remedy for `credit.settlement_gap`: settle exactly
    // the window nothing has billed. It used to come back at zero because 321
    // units sit inside the price's free tier; it is now worth what those units
    // are actually worth at the tier May had reached.
    const gap: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 321,
      period_start: Date.UTC(2026, 4, 28), period_end: MAY.end,
    });
    assert.equal(gap.tier_basis.prior_quantity, 4000);
    assert.equal(gap.full_amount, 3_210, '321 units at the marginal rate, not 321 free units');
    assert.equal(covered.full_amount + gap.full_amount, WHOLE_PERIOD_AMOUNT);
    assert.equal(gap.charged_amount, 3_210);
  });

  test('a window billed across the cycle boundary is still the rung the next one starts from', async () => {
    const { usagePrice } = await fixture();
    const customer = nextName('cus');
    // This is the seeded workspace's own shape: a month billed 31 July to 30
    // August, against a subscription whose cycle runs 3 August to 3 September.
    // The four days left over belong to a cycle that has already been billed
    // 4,000 units, so they are worth the marginal rate — not a second free tier.
    const straddling: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 4000,
      period_start: Date.UTC(2026, 6, 31), period_end: Date.UTC(2026, 7, 30),
    });
    assert.equal(straddling.full_amount, 30_000);

    const leftover: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 321,
      period_start: Date.UTC(2026, 7, 30), period_end: Date.UTC(2026, 8, 3),
    });
    assert.equal(leftover.tier_basis.prior_quantity, 4000);
    assert.equal(leftover.tier_basis.prior_amount, 30_000);
    assert.deepEqual(leftover.tier_basis.settlements, [straddling.id]);
    assert.equal(leftover.full_amount, 3_210, '321 units at the marginal rate');
    // The reported period holds the window it was priced from, rather than
    // naming a cycle the settlement it cites does not sit inside.
    assert.equal(leftover.tier_basis.period_start, Date.UTC(2026, 6, 31));
    assert.equal(leftover.tier_basis.period_end, Date.UTC(2026, 8, 3));

    // And the cycle after it starts clean: a window that only abuts is not a
    // window that overlaps.
    const next: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 900,
      period_start: Date.UTC(2026, 8, 3), period_end: Date.UTC(2026, 9, 3),
    });
    assert.equal(next.tier_basis.prior_quantity, 0);
    assert.equal(next.full_amount, 0);
  });

  test('credit still covers the marginal window, and the two lines sum to it', async () => {
    const { usagePrice, meter } = await fixture();
    const customer = nextName('cus');
    await expectOk('POST', '/v1/credit-grants', {
      customer, kind: 'unit', meter: meter.id, currency: 'usd', amount: 500,
      category: 'paid', name: 'Half a pack',
    });
    const [first, second] = await settlePartition(usagePrice.id, [900, 900]);
    void first;
    // The partition helper uses its own customer, so redo the second window on
    // the customer holding the credit.
    const mid = MAY.start + Math.round(SPAN / 2);
    await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 900, period_start: MAY.start, period_end: mid,
    });
    const priced: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 900, period_start: mid, period_end: MAY.end,
    });
    assert.equal(second.full_amount, 8_000, 'the window is worth $80 before any credit');
    assert.equal(priced.full_amount, 8_000);
    assert.equal(priced.covered_quantity, 500);
    assert.equal(priced.covered_amount, 5_000);
    assert.equal(priced.charged_amount, 3_000);
    assert.equal(
      priced.lines.reduce((acc, line) => acc + line.amount, 0), priced.full_amount,
      'the credit-covered and charged lines still sum to what the window costs',
    );
  });

  /**
   * The property, not an example of it.
   *
   * Two hundred generated cases, each with its own graduated ladder and its own
   * month of usage, settled four ways: as one window, as two, as five, and one
   * window per day. All four have to come to the same money, to the cent, or a
   * customer's bill depends on how many pieces their billing system happened to
   * cut the month into. The pieces after the first are settled in a shuffled
   * order too, because a period billed back to front is still that period.
   *
   * Seeded from a constant, so a failure is reproducible: the case number in
   * the assertion message is the one to re-run.
   */
  test('any ladder, any total: one window, two, five and one a day agree to the cent', async () => {
    // Its own workspace, and its own rate limit: eight thousand settlements is
    // far more than one key may make in a minute, and the point here is the
    // arithmetic rather than the throttle in front of it.
    const limitBefore = process.env.AIN_RATE_LIMIT;
    process.env.AIN_RATE_LIMIT = '200000';
    let bench: App;
    try {
      bench = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } });
    } finally {
      if (limitBefore === undefined) delete process.env.AIN_RATE_LIMIT;
      else process.env.AIN_RATE_LIMIT = limitBefore;
    }
    try {
      const eventName = nextName('prop');
      await expectOk('POST', '/v1/meters', {
        name: 'Property meter', event_name: eventName, aggregation: 'sum', value_key: 'units', unit_label: 'unit',
      }, bench);
      const product = await expectOk('POST', '/v1/products', {
        name: 'Property telemetry', unit_label: 'unit', category: 'component',
      }, bench);

      let seed = 0x5eed1e;
      const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const pick = (n: number) => Math.floor(rand() * n);
      /** Minor units per unit: often free, otherwise anything up to $5 a unit. */
      const rate = () => (rand() < 0.3 ? '0' : (pick(50_000) / 100).toFixed(2));

      const CASES = 200;
      /** May has 31 days, so the daily partition lands on real day boundaries. */
      const DAILY = 31;
      assert.equal(SPAN, DAILY * DAY);

      for (let index = 0; index < CASES; index++) {
        // A ladder of two to five rungs with strictly rising bounds. The rates
        // do not have to rise: a volume discount that gets cheaper further up
        // is exactly the shape a marginal ladder is easiest to get wrong on.
        const rungs = 2 + pick(4);
        const tiers: { up_to: number | 'inf'; unit_amount_decimal: string }[] = [];
        let bound = 0;
        for (let i = 0; i < rungs - 1; i++) {
          bound += 1 + pick(4000);
          tiers.push({ up_to: bound, unit_amount_decimal: rate() });
        }
        tiers.push({ up_to: 'inf', unit_amount_decimal: rate() });

        const price = await expectOk('POST', '/v1/prices', {
          product: product.id, currency: 'usd', model: 'usage', type: 'recurring', tiers_mode: 'graduated',
          nickname: `Ladder ${index}`, tiers,
          recurring: { interval: 'month', usage_type: 'metered', aggregate_usage: 'sum', meter: eventName },
        }, bench);
        const total = pick(20_000);

        /** Cut `total` into `parts` non-negative windows and settle them shuffled. */
        const settle = async (parts: number): Promise<number> => {
          const quantities: number[] = [];
          let left = total;
          for (let i = 0; i < parts - 1; i++) {
            const q = pick(left + 1);
            quantities.push(q);
            left -= q;
          }
          quantities.push(left);
          const edges = quantities.map((_, i) => MAY.start + Math.round((i * SPAN) / parts));
          edges.push(MAY.end);

          const order = quantities.map((_, i) => i);
          for (let i = order.length - 1; i > 0; i--) {
            const j = pick(i + 1);
            [order[i], order[j]] = [order[j], order[i]];
          }

          const customer = `cus_${index}_${parts}`;
          let money = 0;
          let units = 0;
          for (const i of order) {
            const piece: Settlement = await expectOk('POST', '/v1/credit-settlements', {
              customer, price: price.id, quantity: quantities[i],
              period_start: edges[i], period_end: edges[i + 1],
            }, bench);
            money += piece.full_amount;
            units += piece.billed_quantity;
          }
          assert.equal(units, total, `case ${index} in ${parts}: the windows bill ${units} units, not ${total}`);
          return money;
        };

        const whole = await settle(1);
        for (const parts of [2, 5, DAILY]) {
          assert.equal(
            await settle(parts), whole,
            `case ${index}: ${total} units on ${JSON.stringify(tiers)} cost ${whole} as one window, but a different amount in ${parts}`,
          );
        }
      }
    } finally {
      bench.close();
    }
  });

  test('a late event on a split period trues up from the rung the invoice reached', async () => {
    const { usagePrice, eventName, meter } = await fixture();
    const customer = nextName('cus');
    const mid = MAY.start + Math.round(SPAN / 2);
    const send = (identifier: string, timestamp: number, units: number) =>
      expectOk('POST', '/v1/meter-events', {
        event_name: eventName, identifier, timestamp, payload: { customer_id: customer, units },
      });

    await send(`${customer}_a`, MAY.start + DAY, 900);
    await send(`${customer}_b`, mid + DAY, 900);
    const firstHalf: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, meter: meter.id,
      period_start: MAY.start, period_end: mid, close_period: true,
    });
    const secondHalf: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, meter: meter.id,
      period_start: mid, period_end: MAY.end, close_period: true,
    });
    assert.equal(firstHalf.full_amount, 0);
    assert.equal(secondHalf.full_amount, 8_000);

    // 100 units arrive for the closed second half. On the whole month the
    // period moves from 1,800 to 1,900 units, all of them past the free tier,
    // so the true-up is worth $10.00 — not the $0.00 a window-local ladder
    // would have said.
    await send(`${customer}_late`, mid + 2 * DAY, 100);
    const open = await expectOk('GET', `/v1/meter-late-arrivals?customer=${customer}&resolution=open`);
    assert.equal(open.data.length, 1);
    const resolved = await expectOk('POST', `/v1/meter-late-arrivals/${open.data[0].id}/resolve`, {
      resolution: 'rebilled',
    });
    assert.equal(resolved.amount, 1_000);

    const line = await expectOk('GET', `/v1/credit-billable-items?customer=${customer}&kind=true_up`);
    assert.equal(line.data.length, 1);
    assert.equal(line.data[0].amount, 1_000);
    assert.equal(line.data[0].billed_amount, 1_000);

    const closure = await expectOk('GET', `/v1/meter-period-closures/${
      (await expectOk('GET', `/v1/meter-period-closures?customer=${customer}`)).data
        .find((c: { period_start: number }) => c.period_start === mid).id}`);
    assert.equal(closure.prior_quantity, 900, 'the closure remembers the rung it was billed from');
    assert.equal(closure.outstanding_amount, 0, 'and the invoice and the meter agree again');
  });
});

/* ------------- one cycle, one free tier, whatever happens in it ----------- */

/**
 * The two ways a real subscription splits a billing cycle without anybody
 * asking for a split: it is cancelled and taken out again on the anchor it
 * already had, or a plan change moves the anchor and walks away from the rest
 * of the cycle. Both used to hand the graduated price's free tier out twice —
 * and the second one used to throw the abandoned window's usage away entirely.
 */
describe('a subscription that restarts mid-cycle is still one billing period', () => {
  let clock: App;
  before(async () => { clock = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } }); });
  after(() => clock.close());

  /** 2,400 units on the fixture price: 1,000 free, 1,400 at 10 minor units. */
  const CYCLE_AMOUNT = 14_000;

  const send = (eventName: string, customer: string, identifier: string, timestamp: number, units: number) =>
    expectOk('POST', '/v1/meter-events', {
      event_name: eventName, identifier, timestamp, payload: { customer_id: customer, units },
    }, clock);

  test('cancelled and taken out again on the same anchor, the free tier is given once', async () => {
    const fx = await fixture(clock);
    const customer = await expectOk('POST', '/v1/customers', { name: 'Kestrel Foundry', currency: 'usd' }, clock);
    const first = await expectOk('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: fx.usagePrice.id }],
    }, clock);
    const cycle = { start: first.current_period_start, end: first.current_period_end };

    await clock.travel(3 * DAY);
    await send(fx.eventName, customer.id, 'kestrel_before', cycle.start + 2 * DAY, 1200);
    await clock.travel(7 * DAY);
    await expectOk('POST', `/v1/subscriptions/${first.id}/cancel`, {}, clock);

    // Taken out again the same week, on the billing day they already had.
    const again = await expectOk('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: fx.usagePrice.id }], billing_cycle_anchor: cycle.end,
    }, clock);
    assert.equal(again.current_period_end, cycle.end, 'the restart lands back on the original billing day');
    await clock.travel(2 * DAY);
    await send(fx.eventName, customer.id, 'kestrel_after', again.current_period_start + DAY, 1200);
    await clock.travel(40 * DAY);

    const settled: Settlement[] = (await expectOk('GET', `/v1/credit-settlements?customer=${customer.id}`, undefined, clock))
      .data.filter((s: Settlement) => s.status === 'settled');
    assert.equal(settled.length, 2, 'the stub and the restart are two windows of one cycle');
    assert.equal(settled.reduce((acc, s) => acc + s.billed_quantity, 0), 2400);
    assert.equal(
      settled.reduce((acc, s) => acc + s.full_amount, 0), CYCLE_AMOUNT,
      'cancelling and coming back does not buy a second 1,000 free units',
    );

    const stub = settled.find((s) => s.period_start === cycle.start);
    const restart = settled.find((s) => s.period_start === again.current_period_start);
    assert.ok(stub && restart, 'both windows are on record');
    assert.equal(stub.tier_basis.prior_quantity, 0);
    assert.equal(stub.full_amount, 2_000, '1,200 units into a fresh ladder is 200 chargeable');
    assert.equal(restart.tier_basis.prior_quantity, 1200);
    assert.equal(restart.tier_basis.prior_amount, 2_000);
    assert.equal(restart.full_amount, 12_000, 'and the restart pays the marginal rate on all 1,200 of its own');
    assert.deepEqual(restart.tier_basis.settlements, [stub.id]);
    assert.equal(restart.tier_basis.period_start, cycle.start, 'both windows name the cycle they share');
    assert.equal(restart.tier_basis.period_end, cycle.end);
  });

  test('a plan change that moves the anchor still bills the cycle it walked away from', async () => {
    const fx = await fixture(clock);
    const flat = await expectOk('POST', '/v1/prices', {
      product: fx.product.id, currency: 'usd', model: 'per_unit', type: 'recurring', unit_amount: 50_000,
      nickname: 'Standard platform', recurring: { interval: 'month' },
    }, clock);
    const upgrade = await expectOk('POST', '/v1/prices', {
      product: fx.product.id, currency: 'usd', model: 'per_unit', type: 'recurring', unit_amount: 90_000,
      nickname: 'Enterprise platform', recurring: { interval: 'month' },
    }, clock);

    const customer = await expectOk('POST', '/v1/customers', { name: 'Braithwaite Conveyors', currency: 'usd' }, clock);
    const sub = await expectOk('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: fx.usagePrice.id }, { price: flat.id }],
    }, clock);
    const cycle = { start: sub.current_period_start, end: sub.current_period_end };

    await clock.travel(3 * DAY);
    await send(fx.eventName, customer.id, 'braithwaite_before', cycle.start + 2 * DAY, 1200);
    await clock.travel(7 * DAY);

    // Upgrading and re-anchoring on the same day: the cycle they were ten days
    // into stops here and a new one starts.
    const flatItem = sub.items.find((item: { price: string }) => item.price === flat.id);
    await expectOk('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: flatItem.id, price: upgrade.id }],
      billing_cycle_anchor: 'now', proration_behavior: 'always_invoice',
    }, clock);
    const after = await expectOk('GET', `/v1/subscriptions/${sub.id}`, undefined, clock);
    assert.ok(after.current_period_start > cycle.start, 'the anchor moved');

    await clock.travel(3 * DAY);
    await send(fx.eventName, customer.id, 'braithwaite_after', after.current_period_start + 2 * DAY, 1200);
    await clock.travel(40 * DAY);

    const settled: Settlement[] = (await expectOk('GET', `/v1/credit-settlements?customer=${customer.id}`, undefined, clock))
      .data.filter((s: Settlement) => s.status === 'settled');
    const abandoned = settled.find((s) => s.period_start === cycle.start);
    assert.ok(abandoned, 'the ten days the upgrade walked away from are billed, not dropped');
    assert.equal(abandoned.period_end, after.current_period_start);
    assert.equal(abandoned.billed_quantity, 1200);
    assert.equal(abandoned.tier_basis.period_end, cycle.end, 'and priced against the cycle they belonged to');

    assert.equal(
      settled.reduce((acc, s) => acc + s.billed_quantity, 0), 2400,
      'every metered unit the fleet sent is on exactly one settlement',
    );
    // Two genuine cycles, so two ladders: 1,200 units each is $20 each.
    assert.equal(settled.reduce((acc, s) => acc + s.full_amount, 0), 4_000);

    // And the meter agrees: both windows are frozen, so anything later is a
    // true-up rather than a number that disagrees with an invoice.
    const closures = await expectOk('GET', `/v1/meter-period-closures?customer=${customer.id}`, undefined, clock);
    assert.equal(closures.data.length, settled.length);
  });
});

/* ---------------- credit nobody was billed for is not credit -------------- */

describe('a top-up charges first and grants second', () => {
  test('the charge is raised in the same call, and the grant is live once it lands', async () => {
    const { packPrice } = await fixture();
    const customer = await billableCustomer('Ravensmoor Tooling');
    const topup = await expectOk('POST', '/v1/credit-topups', { customer, price: packPrice.id, quantity: 2 });

    assert.ok(topup.invoice, 'the purchase raised its own invoice');
    assert.equal(topup.charge_deferred, null);
    assert.equal(topup.line.status, 'invoiced');
    assert.equal(topup.line.invoice, topup.invoice);
    assert.equal(topup.grant.status, 'active');
    assert.equal(topup.grant.awaiting_payment, false);
    assert.equal(topup.grant.pending_purchase, null);

    const invoice = await expectOk('GET', `/v1/invoices/${topup.invoice}`);
    assert.equal(invoice.customer, customer);
    assert.equal(invoice.subtotal, 100_000, 'two packs at $500, on a real invoice');

    const balance = await expectOk('GET', `/v1/customers/${customer}/credit-balance`);
    assert.equal(balance.balances[0].available, 2000, 'and the credit is spendable');
  });

  test('a purchase invoicing cannot take leaves unspendable credit and says why', async () => {
    const { packPrice, usagePrice } = await fixture();
    // No billing customer of this id exists, so nothing can charge for the pack.
    const customer = nextName('cus');
    const topup = await expectOk('POST', '/v1/credit-topups', { customer, price: packPrice.id, quantity: 2 });

    assert.equal(topup.invoice, null);
    assert.equal(topup.charge_deferred?.code, 'resource_missing');
    assert.match(topup.charge_deferred.message, /Invoicing has no customer record/);
    assert.equal(topup.line.status, 'pending');
    assert.equal(topup.grant.status, 'scheduled');
    assert.equal(topup.grant.awaiting_payment, true);
    assert.equal(topup.grant.pending_purchase, topup.line.id);
    assert.equal(topup.grant.balance, 2000, 'the promise is on the books');

    const balance = await expectOk('GET', `/v1/customers/${customer}/credit-balance`);
    assert.deepEqual(balance.balances, [], 'but none of it is available');
    assert.deepEqual(balance.totals_by_currency, []);
    assert.equal(balance.scheduled.length, 1);
    assert.equal(balance.scheduled[0].id, topup.grant.id);

    // And it cannot be drawn on: the usage is charged in full.
    const settlement: Settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer, price: usagePrice.id, quantity: 2000,
      period_start: Date.UTC(2026, 4, 1), period_end: Date.UTC(2026, 5, 1),
    });
    assert.equal(settlement.applications.length, 0, 'unpaid credit never enters the burn order');
    assert.equal(settlement.covered_amount, 0);
    assert.equal(settlement.charged_amount, 10_000);
  });

  test('the overview ages the unbilled purchase so it can be alerted on', async () => {
    const isolated = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } });
    try {
      const { packPrice } = await fixture(isolated);
      const customer = nextName('cus');
      const topup = await expectOk('POST', '/v1/credit-topups', { customer, price: packPrice.id, quantity: 2 }, isolated);

      await isolated.travel(3 * DAY);
      const overview = await expectOk('GET', '/v1/credits/overview', undefined, isolated);
      assert.equal(overview.unbilled_purchases.count, 1);
      assert.equal(overview.unbilled_purchases.amount_total, 100_000);
      assert.equal(overview.unbilled_purchases.held_grants, 1);
      assert.ok(overview.unbilled_purchases.oldest_age_ms >= 3 * DAY);
      assert.equal(overview.unbilled_purchases.lines[0].line, topup.line.id);
      assert.equal(overview.unbilled_purchases.lines[0].reason, 'resource_missing');

      const alerts = isolated.ctx.events.list(ORG, { types: ['credit.purchase_unbilled'], objectId: topup.line.id, limit: 10 });
      assert.ok(alerts.length >= 1, 'the daily watch announced it');
      assert.ok(alerts.length <= 3, 'once a day, not once a pass');
    } finally {
      isolated.close();
    }
  });

  test('the daily watch bills the purchase as soon as the account can be invoiced', async () => {
    const isolated = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } });
    try {
      const { packPrice } = await fixture(isolated);
      // Bought against an id invoicing does not know yet, then the account is
      // opened — a self-serve purchase landing before the billing record does.
      const created = await expectOk('POST', '/v1/customers', { name: 'Latchford Composites', currency: 'usd' }, isolated);
      const topup = await expectOk('POST', '/v1/credit-topups', {
        customer: created.id, price: packPrice.id, quantity: 1,
      }, isolated);
      assert.ok(topup.invoice, 'this one bills straight away');

      // Now the harder case: an account billed in euros buying a pack priced in
      // dollars. Nothing can put that line on their invoice, so the purchase is
      // held with the reason on it — and when the account is put right, the
      // daily watch charges for it without anybody asking.
      const european = await expectOk('POST', '/v1/customers', { name: 'Ardennes Werkzeug', currency: 'eur' }, isolated);
      const held = await expectOk('POST', '/v1/credit-topups', {
        customer: european.id, price: packPrice.id, quantity: 1,
      }, isolated);
      assert.equal(held.charge_deferred?.code, 'currency_mismatch');
      assert.match(held.charge_deferred.message, /billed in EUR/);
      assert.equal(held.grant.status, 'scheduled');
      assert.equal(held.grant.awaiting_payment, true);

      await expectOk('PATCH', `/v1/customers/${european.id}`, { currency: 'usd' }, isolated);
      await isolated.travel(DAY + 60_000);

      const line = await expectOk('GET', `/v1/credit-billable-items?customer=${european.id}`, undefined, isolated);
      assert.equal(line.data[0].status, 'invoiced', 'the watch charged for it');
      assert.ok(line.data[0].invoice, 'against a real invoice');
      const grant = await expectOk('GET', `/v1/credit-grants/${held.grant.id}`, undefined, isolated);
      assert.equal(grant.status, 'active', 'and the credit became spendable the moment it was charged for');
      assert.equal(grant.awaiting_payment, false);

      const activated = isolated.ctx.events.list(ORG, {
        types: ['credit_grant.activated'], objectId: held.grant.id, limit: 5,
      });
      assert.equal(activated.length, 1, 'and said so, because a balance that changes is news');
      assert.equal((activated[0].data as { invoice: string }).invoice, line.data[0].invoice);

      const overview = await expectOk('GET', '/v1/credits/overview', undefined, isolated);
      assert.equal(overview.unbilled_purchases.count, 0);
    } finally {
      isolated.close();
    }
  });
});
