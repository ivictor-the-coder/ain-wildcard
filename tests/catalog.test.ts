import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import {
  aggregateUsage, applyTransform, computeLineAmount, previewCurve, ratToDecimal, decimalToRat,
} from '../src/server/modules/catalog/engine';
import { describePrice, formatMinor, formatMinorDecimal } from '../src/server/modules/catalog/format';
import type { CurrencyOption, Price, PriceTier, Product } from '../src/server/modules/catalog/types';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };

let app: App;

const call = (method: string, path: string, body?: unknown, auth: Auth = DANA) =>
  app.handle({ method, path, body, auth });

async function expectOk(method: string, path: string, body?: unknown): Promise<any> {
  const res = await call(method, path, body);
  assert.ok(res.status < 400, `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function expectError(method: string, path: string, body: unknown, status: number, code?: string): Promise<any> {
  const res = await call(method, path, body);
  assert.equal(res.status, status, `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  if (code) assert.equal(res.body.error.code, code, JSON.stringify(res.body));
  return res.body.error;
}

before(async () => {
  app = await createApp({ db: 'memory', config: { env: 'test' } });
});

after(() => app.close());

/* ------------------------------ test fixtures ----------------------------- */

const priceOf = (over: Partial<Price>): Price => ({
  object: 'price',
  id: over.id ?? 'price_fixture',
  product: 'prod_fixture',
  nickname: null,
  lookup_key: null,
  active: true,
  type: 'recurring',
  model: 'per_unit',
  currency: 'usd',
  unit_amount: null,
  unit_amount_decimal: null,
  billing_scheme: over.tiers?.length ? 'tiered' : 'per_unit',
  tiers_mode: over.tiers?.length ? 'graduated' : null,
  tiers: null,
  transform_quantity: null,
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', aggregate_usage: null, trial_period_days: null, meter: null },
  currency_options: {},
  custom_unit_amount: null,
  tax_behavior: 'unspecified',
  proration_behavior: 'create_prorations',
  metadata: {},
  created: 0,
  updated: 0,
  livemode: true,
  ...over,
});

const productOf = (unit_label: string, over: Partial<Product> = {}): Product => ({
  object: 'product',
  id: 'prod_fixture',
  name: 'Fixture',
  description: null,
  statement_descriptor: null,
  unit_label,
  active: true,
  images: [],
  features: [],
  metadata: {},
  tax_code: null,
  default_price: null,
  category: 'component',
  tagline: null,
  url: null,
  position: 0,
  created: 0,
  updated: 0,
  livemode: true,
  ...over,
});

/** The ladder used by the tiering tables: 1–10 @ $1 + $5 base, 11–20 @ 50c, 21+ @ 25c. */
const LADDER: PriceTier[] = [
  { up_to: 10, unit_amount: 100, flat_amount: 500 },
  { up_to: 20, unit_amount: 50 },
  { up_to: 'inf', unit_amount: 25 },
];

const graduated = priceOf({ id: 'price_grad', model: 'tiered', tiers: LADDER, tiers_mode: 'graduated', billing_scheme: 'tiered' });
const volume = priceOf({ id: 'price_vol', model: 'tiered', tiers: LADDER, tiers_mode: 'volume', billing_scheme: 'tiered' });

/* ---------------------- an independent exact oracle ----------------------- */
/*
 * Deliberately written a second way: fixed-point BigInt scaled by 10^12 with
 * hand-rolled decimal parsing and its own half-up rounding, sharing no code
 * with src/shared/money.ts. If the engine and this ever disagree by a cent,
 * one of them is wrong.
 */
const SCALE = 10n ** 12n;

function oracleScaled(amount: number | null | undefined, decimal: string | null | undefined): bigint | null {
  if (decimal !== null && decimal !== undefined && decimal !== '') {
    const negative = decimal.startsWith('-');
    const body = negative ? decimal.slice(1) : decimal;
    const [whole = '0', frac = ''] = body.split('.');
    const value = BigInt(`${whole || '0'}${frac.padEnd(12, '0').slice(0, 12)}`);
    return negative ? -value : value;
  }
  if (amount !== null && amount !== undefined) return BigInt(amount) * SCALE;
  return null;
}

function oracleRoundHalfUp(scaled: bigint): bigint {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const rounded = (magnitude * 2n + SCALE) / (SCALE * 2n);
  return negative ? -rounded : rounded;
}

function oracleResolve(price: Price, currency: string): CurrencyOption {
  if (currency === price.currency) {
    return {
      unit_amount: price.unit_amount,
      unit_amount_decimal: price.unit_amount_decimal,
      tiers: price.tiers,
      custom_unit_amount: price.custom_unit_amount,
    };
  }
  const option = price.currency_options[currency];
  assert.ok(option, `oracle: ${price.id} has no ${currency} option`);
  return option;
}

/** The whole engine specification, recomputed from scratch. */
function oracleAmount(price: Price, quantity: number, currency: string): bigint {
  const resolved = oracleResolve(price, currency);
  const unit = oracleScaled(resolved.unit_amount, resolved.unit_amount_decimal);

  if (price.model === 'flat') return oracleRoundHalfUp(unit ?? 0n);

  let billable = quantity;
  const transform = price.transform_quantity;
  if (transform && transform.divide_by > 1) {
    const blocks = quantity / transform.divide_by;
    billable = transform.round === 'down' ? Math.floor(blocks) : Math.ceil(blocks);
  }

  const tiers = resolved.tiers;
  if (price.billing_scheme === 'tiered' && tiers && tiers.length) {
    let total = 0n;
    if (price.tiers_mode === 'volume') {
      let chosen = tiers.length - 1;
      for (let i = 0; i < tiers.length; i++) {
        const cap = tiers[i].up_to === 'inf' ? Number.POSITIVE_INFINITY : (tiers[i].up_to as number);
        if (billable <= cap) { chosen = i; break; }
      }
      const tier = tiers[chosen];
      total += oracleScaled(tier.flat_amount, tier.flat_amount_decimal) ?? 0n;
      total += (oracleScaled(tier.unit_amount, tier.unit_amount_decimal) ?? 0n) * BigInt(billable);
    } else {
      let floorOfTier = 0;
      for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i];
        const cap = tier.up_to === 'inf' ? Number.POSITIVE_INFINITY : (tier.up_to as number);
        const inTier = Math.max(0, Math.min(billable, cap) - floorOfTier);
        if (inTier === 0 && i > 0) break;
        total += oracleScaled(tier.flat_amount, tier.flat_amount_decimal) ?? 0n;
        total += (oracleScaled(tier.unit_amount, tier.unit_amount_decimal) ?? 0n) * BigInt(inTier);
        floorOfTier = cap === Number.POSITIVE_INFINITY ? floorOfTier : cap;
        if (billable <= cap) break;
      }
    }
    return oracleRoundHalfUp(total);
  }

  return oracleRoundHalfUp((unit ?? 0n) * BigInt(billable));
}

/** Deterministic PRNG so a failing quantity can be reproduced exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------- the seed --------------------------------- */

describe('Northwind’s price book', () => {
  test('seeds a coherent ladder with components, an add-on, a service and credits', async () => {
    const products = await expectOk('GET', '/v1/products?limit=100');
    assert.equal(products.total_count, 9);
    const byCategory = new Map<string, number>();
    for (const p of products.data) byCategory.set(p.category, (byCategory.get(p.category) ?? 0) + 1);
    assert.equal(byCategory.get('plan'), 4);
    assert.equal(byCategory.get('component'), 2);
    assert.equal(byCategory.get('add_on'), 1);
    assert.equal(byCategory.get('service'), 1);
    assert.equal(byCategory.get('credit_pack'), 1);

    for (const product of products.data) {
      assert.ok(product.description.length > 60, `${product.name} has no real description`);
      assert.ok(product.tagline, `${product.name} has no tagline`);
      assert.ok(product.default_price, `${product.name} has no default price`);
      assert.ok(product.statement_descriptor.length <= 22);
      assert.doesNotMatch(product.description, /lorem|TODO|coming soon|placeholder/i);
    }
  });

  test('every seeded price is priceable in all three currencies', async () => {
    const prices = await expectOk('GET', '/v1/prices?limit=100');
    assert.equal(prices.total_count, 17);
    for (const price of prices.data) {
      assert.deepEqual([...price.currencies].sort(), ['eur', 'gbp', 'usd']);
      for (const currency of price.currencies) {
        const body = price.model === 'custom' ? { quantity: 1, currency, custom_unit_amount: 12_000_000 } : { quantity: 7, currency };
        const preview = await expectOk('POST', `/v1/prices/${price.id}/preview`, body);
        assert.equal(preview.currency, currency);
        assert.ok(Number.isInteger(preview.amount) && preview.amount >= 0);
      }
    }
  });

  test('the annual option really is two months free', async () => {
    const catalog = await expectOk('GET', '/v1/catalog');
    const growth = catalog.plans.find((p: any) => p.product.id === 'prod_nw_growth');
    assert.equal(growth.base.month.unit_amount * 10, growth.base.year.unit_amount);
    assert.equal(growth.annual_discount_percent, 17);
  });
});

/* ------------------------- graduated vs volume ---------------------------- */

describe('tiering at the boundaries', () => {
  const cases: { quantity: number; graduated: number; volume: number; why: string }[] = [
    { quantity: 0, graduated: 500, volume: 500, why: 'the first tier’s base charge applies even at zero' },
    { quantity: 1, graduated: 600, volume: 600, why: 'one unit inside tier one' },
    { quantity: 9, graduated: 1400, volume: 1400, why: 'just below the first boundary' },
    { quantity: 10, graduated: 1500, volume: 1500, why: 'exactly on the first boundary' },
    { quantity: 11, graduated: 1550, volume: 550, why: 'volume reprices every unit at the new rate' },
    { quantity: 19, graduated: 1950, volume: 950, why: 'inside tier two' },
    { quantity: 20, graduated: 2000, volume: 1000, why: 'exactly on the second boundary' },
    { quantity: 21, graduated: 2025, volume: 525, why: 'first unit of the open-ended tier' },
    { quantity: 100, graduated: 4000, volume: 2500, why: 'well into the open-ended tier' },
    { quantity: 1_000_000, graduated: 25_001_500, volume: 25_000_000, why: 'large quantities stay exact' },
  ];

  for (const c of cases) {
    test(`graduated: ${c.quantity} units → ${c.graduated} (${c.why})`, () => {
      const line = computeLineAmount(graduated, c.quantity);
      assert.equal(line.amount, c.graduated);
      assert.equal(line.breakdown.reduce((sum, row) => sum + row.amount, 0), c.graduated);
      assert.equal(Number(oracleAmount(graduated, c.quantity, 'usd')), c.graduated);
    });

    test(`volume: ${c.quantity} units → ${c.volume} (${c.why})`, () => {
      const line = computeLineAmount(volume, c.quantity);
      assert.equal(line.amount, c.volume);
      assert.equal(line.breakdown.reduce((sum, row) => sum + row.amount, 0), c.volume);
      assert.equal(Number(oracleAmount(volume, c.quantity, 'usd')), c.volume);
    });
  }

  test('graduated never charges less as quantity grows; volume may', () => {
    let previous = -1;
    for (let q = 0; q <= 200; q++) {
      const amount = computeLineAmount(graduated, q).amount;
      assert.ok(amount >= previous, `graduated fell at ${q}`);
      previous = amount;
    }
    assert.ok(computeLineAmount(volume, 11).amount < computeLineAmount(volume, 10).amount);
  });

  test('graduated tiers are explained tier by tier', () => {
    const line = computeLineAmount(graduated, 25, 'usd', { unitLabel: 'seat' });
    assert.deepEqual(line.breakdown.map((r) => [r.kind, r.tier, r.quantity, r.amount]), [
      ['tier_flat', 1, 0, 500],
      ['tier', 1, 10, 1000],
      ['tier', 2, 10, 500],
      ['tier', 3, 5, 125],
    ]);
    assert.match(line.breakdown[1].label, /10 seats at tier 1 \(1–10\)/);
  });

  test('volume picks exactly one tier and says which', () => {
    const line = computeLineAmount(volume, 60, 'usd', { unitLabel: 'seat' });
    assert.equal(line.breakdown.length, 1);
    assert.equal(line.breakdown[0].tier, 3);
    assert.equal(line.breakdown[0].quantity, 60);
    assert.equal(line.amount, 1500);
  });

  test('a free first tier reads as "included", not as a zero charge', () => {
    const metered = priceOf({
      model: 'usage', billing_scheme: 'tiered', tiers_mode: 'graduated',
      tiers: [{ up_to: 1000, unit_amount_decimal: '0' }, { up_to: 'inf', unit_amount_decimal: '0.5' }],
    });
    const line = computeLineAmount(metered, 3000, 'usd', { unitLabel: 'event' });
    assert.equal(line.breakdown[0].kind, 'included');
    assert.equal(line.breakdown[0].amount, 0);
    assert.equal(line.amount, 1000); // 2,000 events at half a cent
  });
});

/* ---------------------------- package rounding ---------------------------- */

describe('package pricing', () => {
  const upward = priceOf({ model: 'package', unit_amount: 900, transform_quantity: { divide_by: 10, round: 'up' } });
  const downward = priceOf({ model: 'package', unit_amount: 900, transform_quantity: { divide_by: 10, round: 'down' } });

  const cases: { quantity: number; up: number; down: number }[] = [
    { quantity: 0, up: 0, down: 0 },
    { quantity: 1, up: 900, down: 0 },
    { quantity: 9, up: 900, down: 0 },
    { quantity: 10, up: 900, down: 900 },
    { quantity: 11, up: 1800, down: 900 },
    { quantity: 19, up: 1800, down: 900 },
    { quantity: 20, up: 1800, down: 1800 },
    { quantity: 99, up: 9000, down: 8100 },
    { quantity: 100, up: 9000, down: 9000 },
    { quantity: 12_345, up: 1_111_500, down: 1_110_600 },
  ];

  for (const c of cases) {
    test(`${c.quantity} GB → ${c.up} rounding up, ${c.down} rounding down`, () => {
      const rounded = computeLineAmount(upward, c.quantity, 'usd', { unitLabel: 'GB' });
      const truncated = computeLineAmount(downward, c.quantity, 'usd', { unitLabel: 'GB' });
      assert.equal(rounded.amount, c.up);
      assert.equal(truncated.amount, c.down);
      assert.equal(rounded.billable_quantity, Math.ceil(c.quantity / 10));
      assert.equal(truncated.billable_quantity, Math.floor(c.quantity / 10));
      assert.equal(Number(oracleAmount(upward, c.quantity, 'usd')), c.up);
      assert.equal(Number(oracleAmount(downward, c.quantity, 'usd')), c.down);
    });
  }

  test('the quantity is bucketed before tiering, not after', () => {
    const tieredPackage = priceOf({
      model: 'package', billing_scheme: 'tiered', tiers_mode: 'graduated',
      transform_quantity: { divide_by: 100, round: 'up' },
      tiers: [{ up_to: 2, unit_amount: 1000 }, { up_to: 'inf', unit_amount: 500 }],
    });
    // 350 units → 4 packages → 2 at $10 plus 2 at $5.
    const line = computeLineAmount(tieredPackage, 350);
    assert.equal(line.billable_quantity, 4);
    assert.equal(line.amount, 3000);
  });

  test('the package label spells the arithmetic out', () => {
    const line = computeLineAmount(upward, 23, 'usd', { unitLabel: 'GB' });
    assert.equal(line.breakdown[0].label, '3 packages of 10 GB (part packages round up)');
  });

  test('applyTransform is exact on awkward divisors', () => {
    assert.equal(applyTransform(0, { divide_by: 7, round: 'up' }), 0);
    assert.equal(applyTransform(1, { divide_by: 7, round: 'up' }), 1);
    assert.equal(applyTransform(7, { divide_by: 7, round: 'up' }), 1);
    assert.equal(applyTransform(8, { divide_by: 7, round: 'up' }), 2);
    assert.equal(applyTransform(999_999_999, { divide_by: 3, round: 'down' }), 333_333_333);
  });
});

/* ------------------------------ multi-currency ---------------------------- */

describe('multi-currency', () => {
  test('each currency uses its own amounts, not a conversion', async () => {
    const usd = await expectOk('POST', '/v1/prices/price_nw_growth_seat_monthly/preview', { quantity: 12, currency: 'usd' });
    const eur = await expectOk('POST', '/v1/prices/price_nw_growth_seat_monthly/preview', { quantity: 12, currency: 'eur' });
    const gbp = await expectOk('POST', '/v1/prices/price_nw_growth_seat_monthly/preview', { quantity: 12, currency: 'gbp' });
    assert.equal(usd.amount, 12 * 2900);
    assert.equal(eur.amount, 12 * 2700);
    assert.equal(gbp.amount, 12 * 2400);
  });

  test('currency options carry their own tiers', async () => {
    const usd = await expectOk('POST', '/v1/prices/price_nw_scale_seat_monthly/preview', { quantity: 40, currency: 'usd' });
    const gbp = await expectOk('POST', '/v1/prices/price_nw_scale_seat_monthly/preview', { quantity: 40, currency: 'gbp' });
    assert.equal(usd.amount, 40 * 1900);
    assert.equal(gbp.amount, 40 * 1500);
    assert.equal(usd.breakdown[0].tier, 2);
    assert.equal(gbp.breakdown[0].tier, 2);
  });

  test('sub-cent metered rates differ per currency and stay exact', async () => {
    const usd = await expectOk('POST', '/v1/prices/price_nw_telemetry_events/preview', { quantity: 7_500_000, currency: 'usd' });
    const eur = await expectOk('POST', '/v1/prices/price_nw_telemetry_events/preview', { quantity: 7_500_000, currency: 'eur' });
    // usd: 4.5M at 0.04c + 2.5M at 0.028c = 180000 + 70000 minor units
    assert.equal(usd.amount, 250_000);
    assert.equal(eur.amount, 4_500_000 * 0.037 + 2_500_000 * 0.026);
    assert.equal(usd.amount_display, '$2,500.00');
    assert.equal(eur.amount_display, '€2,315.00');
  });

  test('an unsupported currency is refused by name, not silently converted', async () => {
    const error = await expectError('POST', '/v1/prices/price_nw_growth_monthly/preview', { quantity: 1, currency: 'jpy' }, 400, 'currency_not_supported');
    assert.equal(error.param, 'currency');
    assert.match(error.message, /EUR|GBP|USD/);
  });

  test('zero-decimal currencies format without a fraction', () => {
    assert.equal(formatMinor(250_000, 'jpy'), '¥250,000');
    assert.equal(formatMinor(250_000, 'usd'), '$2,500.00');
    assert.equal(formatMinorDecimal('0.04', 'usd'), '$0.0004');
    assert.equal(formatMinorDecimal('0.019', 'gbp'), '£0.00019');
  });

  test('the catalog can be re-priced into another currency wholesale', async () => {
    const eur = await expectOk('GET', '/v1/catalog?currency=eur');
    assert.equal(eur.currency, 'eur');
    const growth = eur.plans.find((p: any) => p.product.id === 'prod_nw_growth');
    assert.equal(growth.base.month.display.summary, '€459.00 per month');
    assert.equal(growth.seat.month.display.summary, '€27.00 per seat per month');
  });
});

/* --------------------------- exactness under fuzz ------------------------- */

describe('the engine never drifts by a cent', () => {
  test('10,000 randomised quantities match an independent exact computation', () => {
    const nasty = priceOf({
      id: 'price_nasty', model: 'usage', billing_scheme: 'tiered', tiers_mode: 'graduated',
      tiers: [
        { up_to: 1_000, unit_amount_decimal: '0' },
        { up_to: 50_000, unit_amount_decimal: '0.033333', flat_amount_decimal: '1250.5' },
        { up_to: 250_000, unit_amount_decimal: '0.0071', flat_amount: 999 },
        { up_to: 'inf', unit_amount_decimal: '0.000777' },
      ],
      currency_options: {
        eur: {
          tiers: [
            { up_to: 1_000, unit_amount_decimal: '0' },
            { up_to: 50_000, unit_amount_decimal: '0.029999', flat_amount_decimal: '1100.25' },
            { up_to: 250_000, unit_amount_decimal: '0.0064', flat_amount: 899 },
            { up_to: 'inf', unit_amount_decimal: '0.000699' },
          ],
        },
      },
    });
    const volumeNasty = priceOf({
      id: 'price_vol_nasty', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'volume',
      tiers: [
        { up_to: 25, unit_amount: 2400, flat_amount: 12_345 },
        { up_to: 100, unit_amount_decimal: '1899.5' },
        { up_to: 'inf', unit_amount_decimal: '1499.333333' },
      ],
      currency_options: {
        eur: {
          tiers: [
            { up_to: 25, unit_amount: 2200, flat_amount: 11_111 },
            { up_to: 100, unit_amount_decimal: '1750.25' },
            { up_to: 'inf', unit_amount_decimal: '1399.666667' },
          ],
        },
      },
    });
    const packaged = priceOf({
      id: 'price_pack_nasty', model: 'package', unit_amount_decimal: '899.99',
      transform_quantity: { divide_by: 7, round: 'up' },
      currency_options: { eur: { unit_amount_decimal: '849.51' } },
    });
    const perUnit = priceOf({
      id: 'price_unit_nasty', model: 'per_unit', unit_amount_decimal: '0.5',
      currency_options: { eur: { unit_amount_decimal: '0.45' } },
    });
    const fixtures = [nasty, volumeNasty, packaged, perUnit, graduated, volume];

    const random = mulberry32(0x5eed_1234);
    let checked = 0;
    let breakdownRows = 0;

    for (let i = 0; i < 10_000; i++) {
      const price = fixtures[Math.floor(random() * fixtures.length)];
      const currencies = ['usd', ...Object.keys(price.currency_options)];
      const currency = currencies[Math.floor(random() * currencies.length)];
      // Log-uniform so boundaries, tiny quantities and millions all get hit.
      const magnitude = random() * 7;
      const quantity = Math.floor(random() * 10 ** magnitude);

      const line = computeLineAmount(price, quantity, currency);
      const expected = Number(oracleAmount(price, quantity, currency));
      assert.equal(
        line.amount, expected,
        `drift on ${price.id} at quantity ${quantity} in ${currency}: engine ${line.amount} vs oracle ${expected}`,
      );
      const summed = line.breakdown.reduce((sum, row) => sum + row.amount, 0);
      assert.equal(summed, line.amount, `breakdown for ${price.id} at ${quantity} sums to ${summed}, not ${line.amount}`);
      breakdownRows += line.breakdown.length;
      checked++;
    }
    assert.equal(checked, 10_000);
    assert.ok(breakdownRows > 10_000, 'expected multi-row breakdowns in the sample');
  });

  test('exact tier boundaries are swept, not sampled', () => {
    const boundaries = [1_000, 50_000, 250_000];
    for (const boundary of boundaries) {
      for (const quantity of [boundary - 1, boundary, boundary + 1]) {
        const price = priceOf({
          model: 'usage', billing_scheme: 'tiered', tiers_mode: 'graduated',
          tiers: [
            { up_to: 1_000, unit_amount_decimal: '0' },
            { up_to: 50_000, unit_amount_decimal: '0.033333', flat_amount_decimal: '1250.5' },
            { up_to: 250_000, unit_amount_decimal: '0.0071', flat_amount: 999 },
            { up_to: 'inf', unit_amount_decimal: '0.000777' },
          ],
        });
        assert.equal(computeLineAmount(price, quantity).amount, Number(oracleAmount(price, quantity, 'usd')));
      }
    }
  });

  test('rounding happens once, at the end — not per unit', () => {
    const halfCent = priceOf({ model: 'per_unit', unit_amount_decimal: '0.5' });
    assert.equal(computeLineAmount(halfCent, 1).amount, 1); // 0.5 rounds half-up
    assert.equal(computeLineAmount(halfCent, 2).amount, 1); // 1.0 exactly
    assert.equal(computeLineAmount(halfCent, 3).amount, 2); // 1.5 rounds half-up
    // Three separate lines would cost 3 cents; one line of three costs 2.
    assert.equal(computeLineAmount(halfCent, 1).amount * 3, 3);
  });

  test('proration multiplies the exact total, then rounds once', () => {
    const flat = priceOf({ model: 'flat', unit_amount: 99_900 });
    const line = computeLineAmount(flat, 1, 'usd', { proration: { numerator: 17, denominator: 31 } });
    assert.equal(line.amount, 54_784); // 1,698,300 / 31 = 54,783.87…
    assert.match(line.amount_decimal, /^54783\.87096774/);
    assert.deepEqual(line.proration, { numerator: 17, denominator: 31 });
  });

  test('decimal parsing and rendering round-trip exactly', () => {
    for (const value of ['0', '0.04', '0.000777', '1250.5', '99900', '0.000000000001']) {
      assert.equal(ratToDecimal(decimalToRat(value)), value);
    }
    assert.equal(ratToDecimal(decimalToRat('0.0400')), '0.04');
    assert.throws(() => decimalToRat('1e6'), /not a decimal amount/);
    assert.throws(() => decimalToRat('0.0000000000001'), /12 decimal places/);
  });
});

/* --------------------------- metered aggregation -------------------------- */

describe('metered usage aggregation', () => {
  const records = [
    { quantity: 10, timestamp: 300, key: 'robot_a' },
    { quantity: 40, timestamp: 100, key: 'robot_b' },
    { quantity: 25, timestamp: 200, key: 'robot_a' },
  ];

  test('sum adds every reported quantity', () => assert.equal(aggregateUsage(records, 'sum'), 75));
  test('max takes the peak', () => assert.equal(aggregateUsage(records, 'max'), 40));
  test('last_during_period takes the latest report', () => assert.equal(aggregateUsage(records, 'last_during_period'), 10));
  test('last_ever takes the latest report of all time', () => assert.equal(aggregateUsage(records, 'last_ever'), 10));
  test('unique counts distinct subjects', () => assert.equal(aggregateUsage(records, 'unique'), 2));
  test('an empty period bills nothing', () => assert.equal(aggregateUsage([], 'sum'), 0));

  test('a preview can aggregate raw records the way the price will', async () => {
    const preview = await expectOk('POST', '/v1/prices/price_nw_telemetry_events/preview', {
      usage_records: [
        { quantity: 400_000, timestamp: 1 },
        { quantity: 400_000, timestamp: 2 },
        { quantity: 200_000, timestamp: 3 },
      ],
    });
    assert.equal(preview.quantity, 1_000_000);
    assert.deepEqual(preview.aggregated_from, { records: 3, aggregation: 'sum' });
    assert.equal(preview.amount, 500_000 * 0.04); // only the events past the included 500k
  });
});

/* ------------------------------ custom prices ----------------------------- */

describe('custom "contact us" prices', () => {
  test('refuse to invent a number', async () => {
    const error = await expectError('POST', '/v1/prices/price_nw_enterprise_annual/preview', { quantity: 1 }, 400, 'price_requires_custom_amount');
    assert.equal(error.param, 'custom_unit_amount');
  });

  test('enforce the negotiated floor and ceiling', async () => {
    await expectError('POST', '/v1/prices/price_nw_enterprise_annual/preview', { quantity: 1, custom_unit_amount: 1000 }, 400, 'amount_too_small');
    await expectError('POST', '/v1/prices/price_nw_enterprise_annual/preview', { quantity: 1, custom_unit_amount: 900_000_000 }, 400, 'amount_too_large');
  });

  test('price the agreed amount once it is supplied', async () => {
    const preview = await expectOk('POST', '/v1/prices/price_nw_enterprise_annual/preview', { quantity: 1, custom_unit_amount: 18_000_000 });
    assert.equal(preview.amount, 18_000_000);
    assert.equal(preview.amount_display, '$180,000.00');
    assert.equal(preview.breakdown[0].kind, 'custom');
  });

  test('carry their own floor in every currency', async () => {
    await expectError('POST', '/v1/prices/price_nw_enterprise_annual/preview', { quantity: 1, currency: 'gbp', custom_unit_amount: 4_000_000 }, 400, 'amount_too_small');
    const ok = await expectOk('POST', '/v1/prices/price_nw_enterprise_annual/preview', { quantity: 1, currency: 'gbp', custom_unit_amount: 9_600_000 });
    assert.equal(ok.amount_display, '£96,000.00');
  });
});

/* ------------------------------- cost curve ------------------------------- */

describe('price previews for the pricing page', () => {
  test('answers "what would 25,000 events cost?"', async () => {
    const curve = await expectOk('GET', '/v1/prices/price_nw_telemetry_events/curve?from=0&to=25000&points=6');
    const at25k = curve.points.find((p: any) => p.quantity === 25_000);
    assert.ok(at25k, 'the requested top of the range is priced');
    assert.equal(at25k.amount, 0); // inside the included tier
    assert.equal(at25k.amount_display, '$0.00');
  });

  test('samples every tier boundary so the steps land exactly', async () => {
    const curve = await expectOk('GET', '/v1/prices/price_nw_telemetry_events/curve?from=0&to=30000000&points=10');
    assert.deepEqual(curve.boundaries, [500_000, 5_000_000, 25_000_000]);
    for (const boundary of curve.boundaries) {
      assert.ok(curve.points.some((p: any) => p.quantity === boundary), `missing boundary ${boundary}`);
      assert.ok(curve.points.some((p: any) => p.quantity === boundary + 1), `missing boundary ${boundary} + 1`);
    }
    const marked = curve.points.filter((p: any) => p.boundary).map((p: any) => p.quantity);
    assert.deepEqual(marked, curve.boundaries);
  });

  test('the marginal rate steps down exactly at each boundary', () => {
    const price = priceOf({
      model: 'usage', billing_scheme: 'tiered', tiers_mode: 'graduated',
      tiers: [
        { up_to: 500_000, unit_amount_decimal: '0' },
        { up_to: 5_000_000, unit_amount_decimal: '0.04' },
        { up_to: 'inf', unit_amount_decimal: '0.019' },
      ],
    });
    assert.equal(computeLineAmount(price, 500_000).marginal_unit_amount_decimal, '0.04');
    assert.equal(computeLineAmount(price, 5_000_000).marginal_unit_amount_decimal, '0.019');
    assert.equal(computeLineAmount(price, 499_999).marginal_unit_amount_decimal, '0');
  });

  test('the effective unit cost of a graduated price only ever falls', () => {
    const curve = previewCurve(graduated, 'usd', { from: 1, to: 5_000, points: 60 });
    let previous = Number.POSITIVE_INFINITY;
    for (const point of curve.points) {
      const effective = Number(point.effective_unit_amount_decimal);
      assert.ok(effective <= previous + 1e-9, `effective unit cost rose at ${point.quantity}`);
      previous = effective;
    }
    assert.equal(curve.points[0].quantity, 1);
  });

  test('explicit quantities can be requested for a comparison table', async () => {
    const curve = await expectOk('GET', '/v1/prices/price_nw_scale_seat_monthly/curve?quantities=1,25,26,100,101,500');
    assert.deepEqual(curve.points.map((p: any) => p.quantity), [1, 25, 26, 100, 101, 500]);
    assert.deepEqual(curve.points.map((p: any) => p.amount), [2400, 60_000, 49_400, 190_000, 151_500, 750_000]);
  });
});

/* ---------------------------- the basket estimate ------------------------- */

describe('the pricing calculator', () => {
  test('prices a whole basket and rolls it up per interval', async () => {
    const estimate = await expectOk('POST', '/v1/catalog/estimate', {
      currency: 'usd',
      lines: [
        { price: 'growth_monthly', quantity: 1 },
        { price: 'growth_seat_monthly', quantity: 18 },
        { price: 'telemetry_events_monthly', quantity: 6_200_000 },
        { price: 'onboarding_fee', quantity: 1 },
      ],
    });
    assert.equal(estimate.recurring.month, 49_900 + 18 * 2900 + (4_500_000 * 0.04 + 1_200_000 * 0.028));
    assert.equal(estimate.one_time, 250_000);
    assert.equal(estimate.due_today, estimate.recurring.month + 250_000);
    assert.equal(estimate.lines.length, 4);
    assert.equal(estimate.lines[0].product.name, 'Telemetry Cloud Growth');
  });

  test('mixes intervals into one comparable monthly figure', async () => {
    const estimate = await expectOk('POST', '/v1/catalog/estimate', {
      lines: [{ price: 'scale_annual', quantity: 1 }, { price: 'predictive_monthly', quantity: 30 }],
    });
    assert.equal(estimate.recurring.year, 1_900_000);
    assert.equal(estimate.recurring.month, 36_000);
    assert.equal(estimate.recurring.monthly_equivalent, Math.round(1_900_000 / 12) + 36_000);
    assert.equal(estimate.recurring.monthly_equivalent_display, '$1,943.33');
  });

  test('an unknown price is named, not swallowed', async () => {
    await expectError('POST', '/v1/catalog/estimate', { lines: [{ price: 'price_does_not_exist' }] }, 404, 'resource_missing');
  });
});

/* -------------------------- immutability of prices ------------------------ */

describe('prices are immutable once they have billed', () => {
  let productId = '';
  let priceId = '';

  test('a brand new price can still be corrected', async () => {
    const product = await expectOk('POST', '/v1/products', {
      name: 'Fleet Insights Beta', category: 'add_on', unit_label: 'robot',
      description: 'A beta programme for the fleet benchmarking pack, priced while we learn what it is worth.',
      default_price_data: { currency: 'usd', model: 'per_unit', unit_amount: 500, recurring: { interval: 'month' } },
    });
    productId = product.id;
    priceId = product.default_price;
    assert.ok(priceId, 'default_price_data created and attached a price');

    const corrected = await expectOk('PATCH', `/v1/prices/${priceId}`, { unit_amount: 750 });
    assert.equal(corrected.unit_amount, 750);
  });

  test('once something bills against it, amounts freeze', async () => {
    app.ctx.svc.catalog.registerUsage(ORG, priceId, { type: 'subscription_item', id: 'si_beta_001' });
    const error = await expectError('PATCH', `/v1/prices/${priceId}`, { unit_amount: 900 }, 409, 'price_immutable');
    assert.match(error.message, /Create a new price/);
    assert.equal((error.detail as any).field, 'unit_amount');

    const stillThere = await expectOk('GET', `/v1/prices/${priceId}`);
    assert.equal(stillThere.unit_amount, 750);
    assert.equal(stillThere.editable, false);
    assert.equal(stillThere.usage.count, 1);
  });

  test('labels stay editable forever', async () => {
    const renamed = await expectOk('PATCH', `/v1/prices/${priceId}`, {
      nickname: 'Fleet Insights — per robot, monthly', metadata: { owner: 'nina' },
    });
    assert.equal(renamed.nickname, 'Fleet Insights — per robot, monthly');
    assert.equal(renamed.metadata.owner, 'nina');
  });

  test('a used price cannot be deleted, only deactivated', async () => {
    const error = await expectError('DELETE', `/v1/prices/${priceId}`, undefined, 409, 'price_in_use');
    assert.match(error.message, /active: false/);
    const archived = await expectOk('PATCH', `/v1/prices/${priceId}`, { active: false });
    assert.equal(archived.active, false);
    const product = await expectOk('GET', `/v1/products/${productId}`);
    assert.equal(product.default_price, null, 'a deactivated price stops being the default');
  });

  test('the replacement is a new price, and the old one still explains old invoices', async () => {
    const replacement = await expectOk('POST', '/v1/prices', {
      product: productId, currency: 'usd', model: 'per_unit', unit_amount: 900, recurring: { interval: 'month' },
      nickname: 'Fleet Insights — per robot, monthly (2026)',
    });
    assert.notEqual(replacement.id, priceId);
    const old = await expectOk('POST', `/v1/prices/${priceId}/preview`, { quantity: 4 });
    assert.equal(old.amount, 3000, 'the retired price still prices exactly as it did');
    const now = await expectOk('POST', `/v1/prices/${replacement.id}/preview`, { quantity: 4 });
    assert.equal(now.amount, 3600);
  });

  test('a product with prices cannot be deleted either', async () => {
    const error = await expectError('DELETE', `/v1/products/${productId}`, undefined, 409, 'product_has_prices');
    assert.match(error.message, /Deactivate it instead/);
  });
});

/* --------------------------------- the API -------------------------------- */

describe('the catalog API', () => {
  test('rejects tiers that do not ascend, naming the offending tier', async () => {
    const error = await expectError('POST', '/v1/prices', {
      product: 'prod_nw_growth', currency: 'usd', model: 'tiered', tiers_mode: 'graduated',
      tiers: [{ up_to: 10, unit_amount: 100 }, { up_to: 5, unit_amount: 50 }, { up_to: 'inf', unit_amount: 25 }],
    }, 400, 'parameter_invalid');
    assert.equal(error.param, 'tiers[1].up_to');
  });

  test('insists the last tier is open-ended so every quantity is priced', async () => {
    const error = await expectError('POST', '/v1/prices', {
      product: 'prod_nw_growth', currency: 'usd', model: 'tiered', tiers_mode: 'volume',
      tiers: [{ up_to: 10, unit_amount: 100 }, { up_to: 20, unit_amount: 50 }],
    }, 400, 'parameter_invalid');
    assert.equal(error.param, 'tiers[1].up_to');
    assert.match(error.message, /open-ended/);
  });

  test('refuses a tiered price that also carries a unit amount', async () => {
    const error = await expectError('POST', '/v1/prices', {
      product: 'prod_nw_growth', currency: 'usd', model: 'tiered', tiers_mode: 'graduated',
      unit_amount: 100, tiers: [{ up_to: 'inf', unit_amount: 25 }],
    }, 400, 'parameter_invalid');
    assert.equal(error.param, 'unit_amount');
  });

  test('requires every extra currency to be fully priced', async () => {
    const error = await expectError('POST', '/v1/prices', {
      product: 'prod_nw_growth', currency: 'usd', model: 'tiered', tiers_mode: 'graduated',
      tiers: [{ up_to: 'inf', unit_amount: 25 }],
      currency_options: { eur: { unit_amount: 20 } },
    }, 400, 'parameter_missing');
    assert.equal(error.param, 'currency_options.eur.tiers');
  });

  test('will not let a one-time price recur', async () => {
    const error = await expectError('POST', '/v1/prices', {
      product: 'prod_nw_growth', currency: 'usd', type: 'one_time', unit_amount: 100, recurring: { interval: 'month' },
    }, 400, 'parameter_invalid');
    assert.equal(error.param, 'recurring');
  });

  test('lookup keys are unique, and can be transferred deliberately', async () => {
    await expectError('POST', '/v1/prices', {
      product: 'prod_nw_growth', currency: 'usd', unit_amount: 100, lookup_key: 'growth_monthly',
      recurring: { interval: 'month' },
    }, 409, 'lookup_key_in_use');

    const replacement = await expectOk('POST', '/v1/prices', {
      product: 'prod_nw_growth', currency: 'usd', model: 'flat', unit_amount: 52_900,
      recurring: { interval: 'month' }, nickname: 'Growth platform fee — 2027 list',
      currency_options: { eur: { unit_amount: 48_900 }, gbp: { unit_amount: 42_900 } },
    });
    const moved = await expectOk('PATCH', `/v1/prices/${replacement.id}`, { lookup_key: 'growth_monthly', transfer_lookup_key: true });
    assert.equal(moved.lookup_key, 'growth_monthly');
    const previous = await expectOk('GET', '/v1/prices/price_nw_growth_monthly');
    assert.equal(previous.lookup_key, null);
    // Put the price book back the way the rest of the suite expects it.
    await expectOk('PATCH', '/v1/prices/price_nw_growth_monthly', { lookup_key: 'growth_monthly', transfer_lookup_key: true });
    await expectOk('DELETE', `/v1/prices/${replacement.id}`);
  });

  test('metadata merges rather than replacing wholesale', async () => {
    const before = await expectOk('GET', '/v1/products/prod_nw_scale');
    const after = await expectOk('PATCH', '/v1/products/prod_nw_scale', { metadata: { renewal_owner: 'sofia' } });
    assert.equal(after.metadata.renewal_owner, 'sofia');
    assert.equal(after.metadata.rung, before.metadata.rung);
  });

  test('statement descriptors are held to what a card statement can show', async () => {
    const error = await expectError('POST', '/v1/products', {
      name: 'Overlong descriptor', statement_descriptor: 'NORTHWIND ROBOTICS TELEMETRY CLOUD',
    }, 400, 'parameter_invalid');
    assert.equal(error.param, 'statement_descriptor');
  });

  test('the default product list reads like the pricing page: plans, components, then the rest', async () => {
    const all = await expectOk('GET', '/v1/products?limit=100');
    const rank = ['plan', 'component', 'add_on', 'credit_pack', 'service'];
    const ranks = all.data.map((p: any) => rank.indexOf(p.category));
    assert.deepEqual(ranks, [...ranks].sort((a: number, b: number) => a - b), 'categories are banded');
    assert.deepEqual(all.data.slice(0, 4).map((p: any) => p.name), [
      'Telemetry Cloud Starter', 'Telemetry Cloud Growth', 'Telemetry Cloud Scale', 'Telemetry Cloud Enterprise',
    ]);
    const positions = all.data.map((p: any) => p.position);
    assert.deepEqual(positions, [...positions].sort((a: number, b: number) => a - b));
    assert.equal(new Set(positions).size, positions.length, 'positions are unique so the cursor never stalls');
  });

  test('product paging never repeats or drops a row', async () => {
    const total = (await expectOk('GET', '/v1/products?limit=1')).total_count as number;
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const body: any = await expectOk('GET', `/v1/products?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...body.data.map((p: any) => p.id));
      cursor = body.next_cursor;
      if (!body.has_more) break;
    }
    assert.equal(seen.length, new Set(seen).size, 'a product appeared on two pages');
    assert.equal(seen.length, total);
  });

  test('lists filter, paginate and expand', async () => {
    const plans = await expectOk('GET', '/v1/products?category=plan&expand=prices');
    assert.equal(plans.data.length, 4);
    assert.ok(plans.data[0].prices.length > 0);
    assert.equal(plans.data[0].name, 'Telemetry Cloud Starter', 'plans come back in ladder order');

    const firstPage = await expectOk('GET', '/v1/prices?limit=5');
    assert.equal(firstPage.data.length, 5);
    assert.ok(firstPage.has_more);
    const secondPage = await expectOk(`GET`, `/v1/prices?limit=5&cursor=${encodeURIComponent(firstPage.next_cursor)}`);
    const overlap = secondPage.data.filter((p: any) => firstPage.data.some((q: any) => q.id === p.id));
    assert.equal(overlap.length, 0, 'pages do not overlap');

    const metered = await expectOk('GET', '/v1/prices?model=usage');
    assert.equal(metered.data.length, 1);
    assert.equal(metered.data[0].id, 'price_nw_telemetry_events');
  });

  test('a broken cursor is refused rather than silently ignored', async () => {
    const res = await call('GET', '/v1/prices?cursor=not-a-cursor');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'cursor_invalid');
  });

  test('every mutation lands on the event stream', async () => {
    const product = await expectOk('POST', '/v1/products', {
      name: 'Retired trial pack', category: 'credit_pack',
      description: 'A short-lived credit bundle we used during the 2025 pilot, kept here to prove deletion works.',
    });
    await expectOk('DELETE', `/v1/products/${product.id}`);
    const events = await expectOk(`GET`, `/v1/events?object_id=${product.id}`);
    assert.deepEqual(events.data.map((e: any) => e.type).sort(), ['product.created', 'product.deleted']);
  });

  test('a price cannot be read across workspace boundaries', async () => {
    const other: Auth = { ...DANA, orgId: 'org_other' };
    const res = await app.handle({ method: 'GET', path: '/v1/prices/price_nw_growth_monthly', auth: other });
    assert.equal(res.status, 404);
  });
});

/* ------------------------------ the AI surface ---------------------------- */

describe('what the copilot can do with the catalog', () => {
  test('quotes a tiered price with the arithmetic it used', async () => {
    const tool = app.ctx.ai.tool('catalog_quote_price');
    assert.ok(tool);
    const result = await tool!.run({ price: 'telemetry_events_monthly', quantity: 12_400_000 }, app.ctx, { orgId: ORG }) as any;
    assert.equal(result.amount, 4_500_000 * 0.04 + 7_400_000 * 0.028);
    assert.equal(result.amount_display, '$3,872.00');
    assert.equal(result.breakdown.length, 3);
    assert.match(result.breakdown[1], /4,500,000 events at tier 2/);
  });

  test('lists the ladder with prices a human would recognise', async () => {
    const tool = app.ctx.ai.tool('catalog_list_products');
    const result = await tool!.run({ category: 'plan' }, app.ctx, { orgId: ORG }) as any[];
    assert.deepEqual(result.map((p) => p.name), [
      'Telemetry Cloud Starter', 'Telemetry Cloud Growth', 'Telemetry Cloud Scale', 'Telemetry Cloud Enterprise',
    ]);
    assert.equal(result[1].prices[0].summary, '$499.00 per month');
  });

  test('shows where a metered rate steps down', async () => {
    const tool = app.ctx.ai.tool('catalog_cost_curve');
    const result = await tool!.run({ price: 'telemetry_events_monthly', from: 0, to: 30_000_000 }, app.ctx, { orgId: ORG }) as any;
    assert.deepEqual(result.boundaries, [500_000, 5_000_000, 25_000_000]);
    assert.ok(result.points.length >= 12);
  });
});

/* ------------------------ the copy on the pricing page -------------------- */

/*
 * `display` is the only part of a price a customer ever reads, and it is
 * generated, not typed by a marketer — so every string here is checked against
 * what computeLineAmount actually bills for the same price. A headline that
 * disagrees with the invoice is the one defect a price book cannot ship.
 */
describe('the pricing copy says what the engine bills', () => {
  const events = productOf('event');
  const seats = productOf('seat');
  /** "$10.50" → 1050 minor units. Every currency used here has two decimals. */
  const minorOf = (formatted: string) => Math.round(Number(formatted.replace(/[^0-9.]/g, '')) * 100);

  const platformVolume = priceOf({
    id: 'price_platform_volume', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'volume',
    tiers: [{ up_to: 10, flat_amount: 5000 }, { up_to: 'inf', flat_amount: 20000 }],
  });
  const platformGraduated = priceOf({
    id: 'price_platform_graduated', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'graduated',
    tiers: [{ up_to: 10, flat_amount: 5000 }, { up_to: 'inf', flat_amount: 20000 }],
  });
  const baseAndRate = priceOf({
    id: 'price_base_and_rate', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'graduated',
    tiers: [{ up_to: 10, flat_amount: 1000, unit_amount: 50 }, { up_to: 'inf', flat_amount: 500, unit_amount: 25 }],
  });
  const packagedTiers = priceOf({
    id: 'price_packaged_tiers', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'graduated',
    transform_quantity: { divide_by: 100, round: 'up' },
    tiers: [{ up_to: 5, unit_amount: 1000 }, { up_to: 'inf', unit_amount: 500 }],
  });

  test('a volume ladder of base charges is priced, never advertised as free', () => {
    // The engine bills this price $50 at five events and $200 at eleven.
    assert.equal(computeLineAmount(platformVolume, 5, 'usd').amount, 5000);
    assert.equal(computeLineAmount(platformVolume, 11, 'usd').amount, 20000);

    const display = describePrice(platformVolume, 'usd', 'en-US', events);
    assert.doesNotMatch(display.summary, /Included/);
    assert.equal(display.summary, '$50.00 per month up to 10 events, then $200.00 per month');
    assert.equal(display.amount, '$50.00');
    assert.equal(display.headline, '$50.00');
    assert.equal(display.from, '$50.00');
    assert.equal(display.from_amount, 5000);
    assert.equal(display.unit, null, 'a base charge is not a per-event rate');
    assert.deepEqual(display.tiers, ['first 10 events: $50.00 base', '11 and above: $200.00 base']);
  });

  test('a graduated ladder of base charges quotes what each band really costs', () => {
    // Graduated enters both tiers, so above ten events the charge is $50 + $200.
    assert.equal(computeLineAmount(platformGraduated, 11, 'usd').amount, 25000);

    const display = describePrice(platformGraduated, 'usd', 'en-US', events);
    assert.equal(display.summary, '$50.00 per month up to 10 events, then $250.00 per month');
    assert.equal(display.from_amount, computeLineAmount(platformGraduated, 1, 'usd').amount);
  });

  test('an entry-tier base charge is folded into the headline and into "from"', () => {
    const display = describePrice(baseAndRate, 'usd', 'en-US', events);
    assert.equal(display.amount, '$10.00');
    assert.equal(display.amount_detail, '+ $0.50 per event');
    assert.equal(display.headline, '$10.00 base + $0.50 per event');
    // The old copy said "from $0.25" for a price whose smallest line is $10.50.
    assert.equal(display.from, '$10.50');
    assert.equal(display.from_amount, 1050);
    assert.equal(display.from_amount, computeLineAmount(baseAndRate, 1, 'usd').amount);
    assert.equal(computeLineAmount(baseAndRate, 10, 'usd').amount, 1500);
    assert.equal(display.summary,
      '$10.00 per month + $0.50 per event, falling to $5.00 base + $0.25 per event for events beyond 10');
    assert.deepEqual(display.tiers, [
      'first 10 events: $10.00 base + $0.50 per event',
      '11 and above: $5.00 base + $0.25 per event',
    ]);
  });

  test('"from" is never cheaper than the cheapest line the engine will bill', () => {
    const shapes: [string, Price, Product][] = [
      ['volume base ladder', platformVolume, events],
      ['graduated base ladder', platformGraduated, events],
      ['base plus rate', baseAndRate, events],
      ['packaged tiers', packagedTiers, events],
      ['graduated ladder', graduated, seats],
      ['volume ladder', volume, seats],
      ['flat fee', priceOf({ model: 'flat', unit_amount: 49900 }), seats],
      ['per seat', priceOf({ model: 'per_unit', unit_amount: 2900 }), seats],
      ['package', priceOf({ model: 'package', unit_amount: 900, transform_quantity: { divide_by: 10, round: 'up' } }), productOf('GB')],
      ['sub-cent metered', priceOf({ model: 'usage', unit_amount_decimal: '0.04' }), events],
    ];
    for (const [name, price, product] of shapes) {
      const display = describePrice(price, 'usd', 'en-US', product);
      const one = computeLineAmount(price, 1, 'usd', { unitLabel: product.unit_label });
      assert.equal(display.from_amount, one.amount, `${name}: from_amount`);
      assert.ok(minorOf(display.from!) >= one.amount, `${name}: "${display.from}" undersells ${one.amount}`);
    }
  });

  test('a packaged tiered price quotes its rate and its boundaries per package', () => {
    // 750 events → 8 packages of 100: 5 at $10.00 then 3 at $5.00.
    const line = computeLineAmount(packagedTiers, 750, 'usd', { unitLabel: 'event' });
    assert.equal(line.billable_quantity, 8);
    assert.equal(line.amount, 6500);

    const display = describePrice(packagedTiers, 'usd', 'en-US', events);
    assert.equal(display.unit, 'per 100 events');
    assert.equal(display.headline, '$10.00 per 100 events');
    assert.equal(display.summary, '$10.00 per 100 events per month, falling to $5.00 for events beyond 500');
    assert.doesNotMatch(display.summary, /\$10\.00 per event\b/);
    // Tier 1 ends at package 5 — that is event 500, not event 5.
    assert.deepEqual(display.tiers, [
      'first 500 events: $10.00 per 100 events',
      '501 and above: $5.00 per 100 events',
    ]);
    assert.equal(computeLineAmount(packagedTiers, 500, 'usd').amount, 5000);
    assert.equal(computeLineAmount(packagedTiers, 501, 'usd').amount, 5500);
  });

  test('rounding part packages down moves the boundary to the last unit that still fits', () => {
    const roundedDown = priceOf({
      id: 'price_packaged_down', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'graduated',
      transform_quantity: { divide_by: 100, round: 'down' },
      tiers: [{ up_to: 5, unit_amount: 1000 }, { up_to: 'inf', unit_amount: 500 }],
    });
    // 599 events is still five whole packages; the sixth starts at 600.
    assert.equal(computeLineAmount(roundedDown, 599, 'usd').amount, 5000);
    assert.equal(computeLineAmount(roundedDown, 600, 'usd').amount, 5500);
    const display = describePrice(roundedDown, 'usd', 'en-US', events);
    assert.deepEqual(display.tiers, [
      'first 599 events: $10.00 per 100 events',
      '600 and above: $5.00 per 100 events',
    ]);
  });

  test('only a price that charges nothing is called "included"', () => {
    const free = priceOf({
      id: 'price_free', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'graduated',
      tiers: [{ up_to: 'inf', unit_amount: 0 }],
    });
    const display = describePrice(free, 'usd', 'en-US', events);
    assert.equal(display.summary, 'Included — no per-event charge');
    for (const q of [1, 10, 10_000]) assert.equal(computeLineAmount(free, q, 'usd').amount, 0);
    assert.equal(display.from_amount, 0);
  });

  test('an included allowance is named before the rate that follows it', () => {
    const allowance = priceOf({
      id: 'price_allowance', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'graduated',
      recurring: { interval: 'month', interval_count: 1, usage_type: 'metered', aggregate_usage: 'sum', trial_period_days: null, meter: 'events' },
      tiers: [{ up_to: 10_000, flat_amount: 9900, unit_amount: 0 }, { up_to: 'inf', unit_amount: 1 }],
    });
    const display = describePrice(allowance, 'usd', 'en-US', events);
    assert.equal(display.summary, '$99.00 including the first 10,000 events, then $0.01 per event — billed monthly');
    assert.equal(display.amount, '$99.00');
    assert.equal(display.from_amount, 9900);
    assert.equal(computeLineAmount(allowance, 10_000, 'usd').amount, 9900);
    assert.equal(computeLineAmount(allowance, 10_100, 'usd').amount, 10_000);
    assert.equal(display.tiers![0], 'first 10,000 events: $99.00 base, no per-event charge');
  });

  test('the seeded metered price names its allowance, its rate and where it steps down', () => {
    const price = app.ctx.svc.catalog.requirePrice(ORG, 'price_nw_telemetry_events');
    const product = app.ctx.svc.catalog.product(ORG, price.product);
    const display = app.ctx.svc.catalog.describe(price, 'usd', 'en-US', product);
    assert.equal(display.summary,
      'First 500,000 events included, then $0.0004 per event, falling to $0.00019 for events beyond 25,000,000 — billed monthly');
    assert.equal(display.cheapest_unit, '$0.00019');
    assert.deepEqual(display.tiers, [
      'first 500,000 events: included',
      '500,001–5,000,000: $0.0004 per event',
      '5,000,001–25,000,000: $0.00028 per event',
      '25,000,001 and above: $0.00019 per event',
    ]);
  });

  test('every price in the workspace agrees with the engine, in every currency it sells in', () => {
    const svc = app.ctx.svc.catalog;
    const prices = svc.prices(ORG, { limit: 200 });
    assert.ok(prices.length >= 14, 'expected the seeded price book');
    let checked = 0;
    for (const price of prices) {
      const product = svc.product(ORG, price.product);
      for (const currency of svc.currencies(price)) {
        const display = svc.describe(price, currency, 'en-US', product);
        if (price.model === 'custom') {
          assert.ok(display.summary.length > 0, `${price.id}: custom prices still need copy`);
          continue;
        }
        let one;
        try { one = svc.compute(price, 1, currency, { unitLabel: product?.unit_label ?? null }); }
        catch { continue; } // not priceable in that currency — resolveForCurrency already says so
        checked++;
        assert.equal(display.from_amount, one.amount, `${price.id} (${currency}): from_amount vs engine`);
        assert.ok(minorOf(display.from!) >= one.amount, `${price.id} (${currency}): "${display.from}" undersells`);
        if (/Included —/.test(display.summary)) {
          for (const q of [1, 10, 1_000, 1_000_000]) {
            assert.equal(svc.compute(price, q, currency).amount, 0,
              `${price.id} (${currency}) claims to be included but bills at ${q}`);
          }
        }
        if (display.tiers) {
          const tiers = currency === price.currency ? price.tiers : price.currency_options[currency]?.tiers;
          assert.equal(display.tiers.length, tiers?.length ?? 0, `${price.id} (${currency}): a line per tier`);
        }
      }
    }
    assert.ok(checked >= 30, `expected to check every currency of every price, checked ${checked}`);
  });
});

/* ------------------- the pricing page and the invoice agree --------------- */

describe('what GET /v1/catalog serves a pricing page', () => {
  test('a tiered platform fee reaches the pricing page priced, and matches its own preview', async () => {
    const product = await expectOk('POST', '/v1/products', {
      name: 'Fleet gateway fee', unit_label: 'event', category: 'component',
    });
    const price = await expectOk('POST', '/v1/prices', {
      product: product.id, currency: 'usd', model: 'tiered', tiers_mode: 'volume',
      recurring: { interval: 'month', interval_count: 1 },
      tiers: [{ up_to: 10, flat_amount: 5000 }, { up_to: 'inf', flat_amount: 20000 }],
    });
    assert.equal(price.display.summary, '$50.00 per month up to 10 events, then $200.00 per month');

    const small = await expectOk('POST', `/v1/prices/${price.id}/preview`, { quantity: 5 });
    const large = await expectOk('POST', `/v1/prices/${price.id}/preview`, { quantity: 11 });
    assert.equal(small.amount_display, '$50.00');
    assert.equal(large.amount_display, '$200.00');

    const catalog = await expectOk('GET', '/v1/catalog');
    const entry = catalog.components.find((c: any) => c.product.id === product.id);
    assert.ok(entry, 'the new component should appear in the catalog');
    const listed = entry.prices[0].display;
    assert.equal(listed.summary, price.display.summary);
    assert.doesNotMatch(listed.summary, /Included/);
    assert.equal(listed.from, '$50.00');
    assert.ok(listed.summary.includes(small.amount_display) && listed.summary.includes(large.amount_display),
      'the pricing page quotes the two numbers the preview returns');
  });
});

/* ---------------------------- currency hygiene ---------------------------- */

describe('a currency has to be a currency', () => {
  test('a made-up code is refused on the price itself', async () => {
    const error = await expectError('POST', '/v1/prices', {
      product: 'prod_nw_events', currency: 'zzz', unit_amount: 500, recurring: { interval: 'month' },
    }, 400, 'parameter_invalid');
    assert.match(error.message, /Invalid currency: zzz/);
    assert.equal(error.param, 'currency');
  });

  test('and inside currency_options, where it would end up on a pricing page', async () => {
    const error = await expectError('POST', '/v1/prices', {
      product: 'prod_nw_events', currency: 'usd', unit_amount: 500, recurring: { interval: 'month' },
      currency_options: { zzz: { unit_amount: 400 } },
    }, 400, 'parameter_invalid');
    assert.match(error.message, /Invalid currency: zzz/);
    assert.equal(error.param, 'currency_options.zzz');
  });

  test('and when a whole price book is asked for in one', async () => {
    const error = await expectError('GET', '/v1/catalog?currency=zzz', undefined, 400, 'parameter_invalid');
    assert.match(error.message, /Invalid currency: zzz/);
  });

  test('a real but unusual ISO-4217 code is accepted', async () => {
    const price = await expectOk('POST', '/v1/prices', {
      product: 'prod_nw_predictive', currency: 'usd', model: 'per_unit', unit_amount: 1200,
      recurring: { interval: 'month' }, currency_options: { sek: { unit_amount: 13_000 } },
    });
    const preview = await expectOk('POST', `/v1/prices/${price.id}/preview`, { quantity: 3, currency: 'sek' });
    assert.equal(preview.amount, 39_000);
    assert.match(preview.amount_display, /^SEK\s390\.00$/); // en-US sets a non-breaking space after the code
  });

  test('the currency picker lists what the price book actually sells in', async () => {
    const page = await expectOk('GET', '/v1/catalog/currencies');
    const byCode = new Map<string, any>(page.data.map((c: any) => [c.code, c]));
    assert.ok(byCode.has('usd') && byCode.has('eur') && byCode.has('gbp'));
    assert.equal(byCode.get('usd').name, 'US dollar');
    assert.equal(byCode.get('usd').symbol, '$');
    assert.equal(byCode.get('gbp').name, 'British pound');
    assert.equal(byCode.get('gbp').symbol, '£');
    assert.ok(byCode.get('usd').prices >= 14, 'every price is quoted in the home currency');
    assert.equal(page.data.filter((c: any) => c.default).length, 1);
    for (const entry of page.data) assert.ok(entry.prices >= 1, `${entry.code} is listed but priced on nothing`);
  });
});
