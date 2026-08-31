import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import {
  aggregateUsage, applyTransform, computeLineAmount, previewCurve, ratToDecimal, decimalToRat,
} from '../src/server/modules/catalog/engine';
import { describePrice, formatMinor, formatMinorDecimal } from '../src/server/modules/catalog/format';
import type { CurrencyOption, Price, PriceTier, Product, TransformQuantity } from '../src/server/modules/catalog/types';

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

/* ------------------- the price you asked for, exactly --------------------- */

describe('a price is the shape the payload asked for', () => {
  let relayId = '';

  /** One product to hang the shape tests off, created on first use. */
  const relay = async (): Promise<string> => {
    if (!relayId) {
      const product = await expectOk('POST', '/v1/products', {
        name: 'Relay operator seat', category: 'add_on', unit_label: 'seat',
        description: 'A seat on the fleet relay console, sold alongside any plan.',
      });
      relayId = product.id;
    }
    return relayId;
  };

  test('the payload every Stripe integration sends is a per-unit price', async () => {
    const product = await relay();
    // No `model` anywhere: product + currency + unit_amount + recurring.
    const price = await expectOk('POST', '/v1/prices', {
      product, currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' },
    });
    assert.equal(price.model, 'per_unit', 'an unqualified unit_amount is a per-unit price, as it is in Stripe');
    assert.equal(price.billing_scheme, 'per_unit');
    assert.equal(price.type, 'recurring');

    const preview = await expectOk('POST', `/v1/prices/${price.id}/preview`, { quantity: 100 });
    assert.equal(preview.amount, 100_000, '100 seats at $10.00 is $1,000.00');
    assert.equal(preview.billable_quantity, 100);
    assert.equal(preview.amount_display, '$1,000.00');
    assert.equal(preview.warning, null);

    const estimate = await expectOk('POST', '/v1/catalog/estimate', { lines: [{ price: price.id, quantity: 10 }] });
    assert.equal(estimate.due_today_display, '$100.00', 'the calculator quotes ten seats, not one');
    assert.deepEqual(estimate.warnings, []);

    const curve = await expectOk('GET', `/v1/prices/${price.id}/curve?from=0&to=20&points=3`);
    assert.deepEqual(curve.points.map((p: any) => [p.quantity, p.amount]), [[0, 0], [10, 10_000], [20, 20_000]]);

    // Saying out loud what the payload already implied changes nothing.
    const spelled = await expectOk('POST', '/v1/prices', {
      product, currency: 'usd', model: 'per_unit', unit_amount: 1000, recurring: { interval: 'month' },
    });
    const same = await expectOk('POST', `/v1/prices/${spelled.id}/preview`, { quantity: 100 });
    assert.equal(same.amount, preview.amount, 'the model field restates the payload, it never reprices it');

    await expectOk('DELETE', `/v1/prices/${price.id}`);
    await expectOk('DELETE', `/v1/prices/${spelled.id}`);
  });

  test('every model but "flat" follows from the fields, and "flat" has to be asked for', async () => {
    const product = await relay();
    const cases: [string, Record<string, unknown>][] = [
      ['per_unit', { unit_amount: 1000, recurring: { interval: 'month' } }],
      ['per_unit', { unit_amount: 1000 }],
      ['tiered', { tiers: [{ up_to: 10, unit_amount: 900 }, { up_to: 'inf', unit_amount: 500 }], recurring: { interval: 'month' } }],
      ['usage', { unit_amount_decimal: '0.04', recurring: { interval: 'month', usage_type: 'metered' } }],
      ['package', { unit_amount: 900, transform_quantity: { divide_by: 10, round: 'up' }, recurring: { interval: 'month' } }],
      ['custom', { custom_unit_amount: { enabled: true, minimum: 100_000 }, recurring: { interval: 'year' } }],
      ['flat', { model: 'flat', unit_amount: 49_900, recurring: { interval: 'month' } }],
    ];
    for (const [expected, body] of cases) {
      const price = await expectOk('POST', '/v1/prices', { product, currency: 'usd', ...body });
      assert.equal(price.model, expected, `${JSON.stringify(body)} is a ${expected} price`);
      await expectOk('DELETE', `/v1/prices/${price.id}`);
    }
  });

  test('a flat fee quoted at a quantity says what it just billed', async () => {
    const product = await relay();
    const flat = await expectOk('POST', '/v1/prices', {
      product, currency: 'usd', model: 'flat', unit_amount: 49_900,
      recurring: { interval: 'month' }, nickname: 'Relay platform fee',
    });
    const many = await expectOk('POST', `/v1/prices/${flat.id}/preview`, { quantity: 10 });
    assert.equal(many.amount, 49_900, 'a flat fee is one charge whatever the quantity');
    assert.equal(many.billable_quantity, 1);
    assert.equal(many.warning.code, 'flat_price_quantity');
    assert.match(many.warning.message, /one charge of \$499\.00, not 10 of them/);
    assert.match(many.breakdown[0].label, /10 seats asked for, 1 billed/);

    const one = await expectOk('POST', `/v1/prices/${flat.id}/preview`, { quantity: 1 });
    assert.equal(one.warning, null);
    assert.equal(one.breakdown[0].label, 'Relay platform fee');

    const estimate = await expectOk('POST', '/v1/catalog/estimate', { lines: [{ price: flat.id, quantity: 10 }] });
    assert.equal(estimate.due_today, 49_900);
    assert.equal(estimate.warnings[0].code, 'flat_price_quantity');
    assert.equal(estimate.warnings[0].price, flat.id);

    const tool = app.ctx.ai.tool('catalog_quote_price');
    const quoted = await tool!.run({ price: flat.id, quantity: 10 }, app.ctx, { orgId: ORG }) as any;
    assert.match(quoted.warning, /not 10 of them/, 'the copilot never quotes a flat fee as if it scaled');

    await expectOk('DELETE', `/v1/prices/${flat.id}`);
  });

  test('a mistyped parameter is refused, never dropped', async () => {
    const product = await relay();
    const tiers = [{ up_to: 10, unit_amount: 1000 }, { up_to: 'inf', unit_amount: 500 }];
    const mistyped = await expectError('POST', '/v1/prices', {
      product, currency: 'usd', tiersMode: 'volume', tiers, recurring: { interval: 'month' },
    }, 400, 'parameter_invalid');
    assert.equal(mistyped.param, 'tiersMode');
    assert.match(mistyped.message, /unknown parameter: tiersMode/);

    const nested = await expectError('POST', '/v1/prices', {
      product, currency: 'usd', unit_amount: 900, recurring: { interval: 'month', intervalCount: 3 },
    }, 400, 'parameter_invalid');
    assert.equal(nested.param, 'recurring.intervalCount');

    const inTier = await expectError('POST', '/v1/prices', {
      product, currency: 'usd', tiers: [{ up_to: 'inf', unitAmount: 500 }], recurring: { interval: 'month' },
    }, 400, 'parameter_invalid');
    assert.equal(inTier.param, 'tiers[0].unitAmount');

    assert.equal((await expectError('POST', '/v1/products', { name: 'Hijack', id: 'prod_nw_starter' }, 400)).param, 'id');
    assert.equal((await expectError('PATCH', '/v1/products/prod_nw_starter', { taxCode: 'txcd_10000000' }, 400)).param, 'taxCode');
    assert.equal((await expectError('PATCH', '/v1/prices/price_nw_starter_monthly', { nickName: 'x' }, 400)).param, 'nickName');
    assert.equal((await expectError('POST', '/v1/prices/price_nw_starter_monthly/preview', { Quantity: 5 }, 400)).param, 'Quantity');
    assert.equal((await expectError('POST', '/v1/catalog/estimate', { lines: [{ price: 'growth_monthly', qty: 2 }] }, 400)).param, 'lines[0].qty');

    // Spelled correctly, the operator gets the volume price they were writing —
    // which bills $100.00 at twenty, where the graduated one bills $150.00.
    const volume = await expectOk('POST', '/v1/prices', {
      product, currency: 'usd', tiers_mode: 'volume', tiers, recurring: { interval: 'month' },
    });
    assert.equal(volume.tiers_mode, 'volume');
    assert.equal((await expectOk('POST', `/v1/prices/${volume.id}/preview`, { quantity: 20 })).amount, 10_000);
    await expectOk('DELETE', `/v1/prices/${volume.id}`);
  });

  test('a statement descriptor is checked on the way in and on every edit after', async () => {
    const product = await expectOk('POST', '/v1/products', { name: 'Descriptor probe', category: 'service' });
    await expectError('POST', '/v1/products', { name: 'Probe', statement_descriptor: 'BAD<script>' }, 400, 'parameter_invalid');

    const patched = await expectError(
      'PATCH', `/v1/products/${product.id}`, { statement_descriptor: 'BAD<script>"*' }, 400, 'parameter_invalid',
    );
    assert.equal(patched.param, 'statement_descriptor');
    assert.match(patched.message, /cannot contain/);
    await expectError('PATCH', `/v1/products/${product.id}`, { statement_descriptor: 'NORTHWIND ROBOTICS TELE' }, 400);

    const set = await expectOk('PATCH', `/v1/products/${product.id}`, { statement_descriptor: 'NORTHWIND TELEMETRY' });
    assert.equal(set.statement_descriptor, 'NORTHWIND TELEMETRY');
    const cleared = await expectOk('PATCH', `/v1/products/${product.id}`, { statement_descriptor: null });
    assert.equal(cleared.statement_descriptor, null, 'a descriptor can be taken back off');
    await expectOk('DELETE', `/v1/products/${product.id}`);
  });

  test('usage counts objects, not rows', async () => {
    const priceId = 'price_nw_starter_monthly';
    const subscriptions = app.ctx.db.count(
      `SELECT COUNT(DISTINCT subscription_id) FROM billing_subscription_items WHERE org_id = ? AND price_id = ?`,
      ORG, priceId,
    );
    const invoices = app.ctx.db.count(
      `SELECT COUNT(DISTINCT invoice_id) FROM billing_invoice_lines WHERE org_id = ? AND price_id = ?`,
      ORG, priceId,
    );
    assert.ok(subscriptions > 0 && invoices > 0, 'the seed really does bill Starter monthly');

    const price = await expectOk('GET', `/v1/prices/${priceId}`);
    assert.equal(price.usage.count, subscriptions + invoices, 'each subscription and each invoice counted once');
    assert.deepEqual(
      price.usage.by_type,
      [{ type: 'invoice', count: invoices }, { type: 'subscription', count: subscriptions }],
    );
    assert.equal(price.usage.summary, `${invoices.toLocaleString('en-US')} invoices and ${subscriptions.toLocaleString('en-US')} subscriptions`);

    // A subscription registered by billing and holding a row in
    // billing_subscription_items is one object, never two.
    const ids = price.usage.references.map((r: any) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'no object is listed twice under two names');

    const refused = await expectError('DELETE', `/v1/prices/${priceId}`, undefined, 409, 'price_in_use');
    assert.equal((refused.detail as any).count, subscriptions + invoices);
    assert.match(refused.message, new RegExp(`${invoices} invoices and ${subscriptions} subscriptions`));
  });
});

/* --------------------------------- the API -------------------------------- */

/* ------------------------- the floor under an amount ---------------------- */

/*
 * The catalog is the one place in the platform where the shape of money is
 * defined, so a floor that holds for `unit_amount` and not for
 * `unit_amount_decimal` is not a floor. `decimalToRat` accepts a leading minus
 * on purpose — a proration credit is a genuinely negative rational — and the
 * price-creation path used to call it only to check the *format*, so
 * `unit_amount_decimal: "-4"` became a live price of -$0.04 per unit whose own
 * generated headline read "-$0.04 per unit". Everything downstream then billed
 * it faithfully: the preview quoted -$40.00, the pricing-page calculator quoted
 * a negative total with no warning, and a renewal produced a paid invoice
 * carrying a negative line — a refund nobody authorised, issued by a typo.
 * Every decimal field that can carry a rate is checked here, on both the create
 * and the update path, against the integer field that sits next to it.
 */
describe('no price can be minted that bills negative money', () => {
  const NEGATIVE = /^Must be greater than or equal to 0\./;
  const line = (over: Record<string, unknown>) => ({
    product: 'prod_nw_growth', currency: 'usd', recurring: { interval: 'month' }, ...over,
  });

  test('the integer amount and the decimal amount refuse the same payload', async () => {
    const integer = await expectError('POST', '/v1/prices', line({ unit_amount: -500 }), 400, 'parameter_invalid');
    assert.equal(integer.param, 'unit_amount');
    assert.match(integer.message, NEGATIVE);

    const decimal = await expectError('POST', '/v1/prices', line({ unit_amount_decimal: '-4' }), 400, 'parameter_invalid');
    assert.equal(decimal.param, 'unit_amount_decimal');
    assert.match(decimal.message, NEGATIVE);
    assert.match(decimal.message, /coupon|credit note/);
  });

  test('a tier rate cannot be negative, in either of its two decimal fields', async () => {
    const control = await expectError('POST', '/v1/prices', line({
      tiers: [{ up_to: 10, flat_amount: -99_999 }, { up_to: 'inf', unit_amount: 5 }],
    }), 400, 'parameter_invalid');
    assert.equal(control.param, 'tiers[0].flat_amount');

    const unit = await expectError('POST', '/v1/prices', line({
      tiers: [{ up_to: 10, unit_amount_decimal: '-100' }, { up_to: 'inf', unit_amount: 5 }],
    }), 400, 'parameter_invalid');
    assert.equal(unit.param, 'tiers[0].unit_amount_decimal');
    assert.match(unit.message, NEGATIVE);

    const flat = await expectError('POST', '/v1/prices', line({
      tiers: [{ up_to: 10, unit_amount: 5, flat_amount_decimal: '-100' }, { up_to: 'inf', unit_amount: 5 }],
    }), 400, 'parameter_invalid');
    assert.equal(flat.param, 'tiers[0].flat_amount_decimal');
    assert.match(flat.message, NEGATIVE);
  });

  test('a second currency cannot smuggle one in, flat or tiered', async () => {
    const control = await expectError('POST', '/v1/prices', line({
      unit_amount: 500, currency_options: { eur: { unit_amount: -90 } },
    }), 400, 'parameter_invalid');
    assert.equal(control.param, 'currency_options.eur.unit_amount');

    const flat = await expectError('POST', '/v1/prices', line({
      unit_amount: 500, currency_options: { eur: { unit_amount_decimal: '-90' } },
    }), 400, 'parameter_invalid');
    assert.equal(flat.param, 'currency_options.eur.unit_amount_decimal');
    assert.match(flat.message, NEGATIVE);

    const tiered = await expectError('POST', '/v1/prices', line({
      tiers: [{ up_to: 'inf', unit_amount: 5 }],
      currency_options: { eur: { tiers: [{ up_to: 'inf', unit_amount_decimal: '-5' }] } },
    }), 400, 'parameter_invalid');
    assert.equal(tiered.param, 'currency_options.eur.tiers[0].unit_amount_decimal');
    assert.match(tiered.message, NEGATIVE);
  });

  test('an edit cannot turn a good price bad, and leaves it as it was', async () => {
    const price = await expectOk('POST', '/v1/prices', line({ unit_amount: 500, nickname: 'Sign-floor probe' }));
    const error = await expectError('PATCH', `/v1/prices/${price.id}`, { unit_amount_decimal: '-3' }, 400, 'parameter_invalid');
    assert.equal(error.param, 'unit_amount_decimal');
    assert.match(error.message, NEGATIVE);

    const unchanged = await expectOk('GET', `/v1/prices/${price.id}`);
    assert.equal(unchanged.unit_amount, 500);
    assert.equal(unchanged.unit_amount_decimal, null);
    assert.equal(unchanged.display.headline, '$5.00 per seat');
    await expectOk('DELETE', `/v1/prices/${price.id}`);
  });

  test('a product created around a negative price is not created at all', async () => {
    const before = await expectOk('GET', '/v1/products?limit=200');
    const error = await expectError('POST', '/v1/products', {
      name: 'Fleet Insights — negative rate',
      default_price_data: { currency: 'usd', unit_amount_decimal: '-7', recurring: { interval: 'month' } },
    }, 400, 'parameter_invalid');
    assert.match(error.message, NEGATIVE);

    const after = await expectOk('GET', '/v1/products?limit=200');
    assert.equal(after.total_count, before.total_count, 'the whole call rolls back, product included');
    assert.ok(!after.data.some((p: any) => p.name === 'Fleet Insights — negative rate'));
  });

  test('the floor is a floor, not a wall: zero and sub-cent rates still price', async () => {
    const free = await expectOk('POST', '/v1/prices', line({ unit_amount_decimal: '0' }));
    assert.equal(free.display.headline, '$0.00 per seat');
    assert.equal((await expectOk('POST', `/v1/prices/${free.id}/preview`, { quantity: 40 })).amount, 0);
    const metered = await expectOk('POST', '/v1/prices', line({
      unit_amount_decimal: '0.04', recurring: { interval: 'month', usage_type: 'metered' },
    }));
    const priced = await expectOk('POST', `/v1/prices/${metered.id}/preview`, { quantity: 12_345 });
    assert.equal(priced.amount, 494);
    await expectOk('DELETE', `/v1/prices/${free.id}`);
    await expectOk('DELETE', `/v1/prices/${metered.id}`);
  });

  test('the ceiling matches the integer field too', async () => {
    const integer = await expectError('POST', '/v1/prices', line({ unit_amount: 1e18 }), 400, 'parameter_invalid');
    assert.equal(integer.param, 'unit_amount');
    const decimal = await expectError('POST', '/v1/prices', line({ unit_amount_decimal: '9999999999999.5' }), 400, 'parameter_invalid');
    assert.equal(decimal.param, 'unit_amount_decimal');
    assert.match(decimal.message, /implausibly large/);
  });

  test('the parser itself stays sign-capable, because prorations need it', () => {
    const credit = decimalToRat('-2.5');
    assert.equal(credit.n < 0n, true);
    assert.equal(ratToDecimal(credit), '-2.5');
  });

  test('nothing in the whole price book prices below zero, at any quantity', () => {
    const svc = app.ctx.svc.catalog;
    const prices = svc.prices(ORG, { limit: 200 });
    assert.ok(prices.length >= 14, 'expected the seeded price book');
    let checked = 0;
    for (const price of prices) {
      for (const currency of svc.currencies(price)) {
        for (const quantity of [0, 1, 9, 500_000, 500_001, 5_000_001, 25_000_001]) {
          let priced;
          try { priced = svc.compute(price, quantity, currency); }
          catch { continue; } // custom prices and unpriced currencies say so themselves
          checked++;
          assert.ok(priced.amount >= 0, `${price.id} (${currency}) bills ${priced.amount} at quantity ${quantity}`);
          for (const row of priced.breakdown) {
            assert.ok(row.amount >= 0, `${price.id} (${currency}): breakdown row "${row.label}" is ${row.amount}`);
          }
        }
      }
    }
    assert.ok(checked >= 200, `expected a real sweep of the book, checked ${checked}`);
  });
});

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

  /*
   * The 409 on create used to name transfer_lookup_key and then refuse it as an
   * unknown parameter, leaving the operator to clear the key with a PATCH first
   * — two calls, between which the key belonged to nobody and every integration
   * resolving prices by key got a 404. The remedy the API prints now works on
   * the route that prints it.
   */
  test('the cut-over the refusal names is one atomic call on create', async () => {
    const held = await expectOk('GET', '/v1/prices/price_nw_growth_monthly');
    assert.equal(held.lookup_key, 'growth_monthly');
    assert.equal(held.usage.in_use, true, 'the key points at the price customers are actually billed on');

    const refusal = await expectError('POST', '/v1/prices', {
      product: 'prod_nw_growth', currency: 'usd', unit_amount: 100, lookup_key: 'growth_monthly',
      recurring: { interval: 'month' },
    }, 409, 'lookup_key_in_use');
    assert.match(refusal.message, /transfer_lookup_key: true/);
    assert.equal((refusal.detail as any).price, 'price_nw_growth_monthly');

    const replacement = await expectOk('POST', '/v1/prices', {
      product: 'prod_nw_growth', currency: 'usd', model: 'flat', unit_amount: 54_900,
      recurring: { interval: 'month' }, nickname: 'Growth platform fee — 2028 list',
      lookup_key: 'growth_monthly', transfer_lookup_key: true,
      currency_options: { eur: { unit_amount: 49_900 }, gbp: { unit_amount: 43_900 } },
    });
    assert.equal(replacement.lookup_key, 'growth_monthly');

    const donor = await expectOk('GET', '/v1/prices/price_nw_growth_monthly');
    assert.equal(donor.lookup_key, null, 'the key moved rather than being duplicated');
    const byKey = await expectOk('GET', '/v1/prices?lookup_key=growth_monthly');
    assert.deepEqual(byKey.data.map((p: any) => p.id), [replacement.id]);

    // The price that lost the key changed, so the event stream has to say so.
    const donorEvents = await expectOk('GET', '/v1/events?object_id=price_nw_growth_monthly&limit=5');
    assert.ok(donorEvents.data.some((e: any) => e.type === 'price.updated' && e.data.lookup_key === null),
      'the displaced price emits price.updated');

    await expectOk('PATCH', '/v1/prices/price_nw_growth_monthly', { lookup_key: 'growth_monthly', transfer_lookup_key: true });
    await expectOk('DELETE', `/v1/prices/${replacement.id}`);
    const restored = await expectOk('GET', '/v1/prices/price_nw_growth_monthly');
    assert.equal(restored.lookup_key, 'growth_monthly');
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
      '$10.00 per month + $0.50 per event, falling to $5.00 base + $0.25 per event beyond 10 events');
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
    // The rate the second tier steps down to is per package, and says so: the
    // engine bills $5.00 for a hundred events, not $5.00 for one.
    assert.equal(display.summary, '$10.00 per 100 events per month, falling to $5.00 per 100 events beyond 500 events');
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

  /*
   * The shape every usage-priced vendor ships and the one the summary used to
   * lie about: a volume discount that reverses into an overage rate. Quoting
   * only the cheapest band told a customer at 50,000 events to expect $25,000
   * on a price that bills $100,000, so the line has to walk the whole ladder.
   */
  test('a ladder that dips and then climbs quotes the band it ends on, not the cheapest one', () => {
    const overage: PriceTier[] = [
      { up_to: 1_000, unit_amount: 100 }, { up_to: 10_000, unit_amount: 50 }, { up_to: 'inf', unit_amount: 200 },
    ];
    const byVolume = priceOf({ id: 'price_dip_volume', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'volume', tiers: overage });
    const volumeCopy = describePrice(byVolume, 'usd', 'en-US', events);
    assert.equal(volumeCopy.summary,
      '$1.00 per event per month, falling to $0.50 for every event once you pass 1,000, rising to $2.00 for every event once you pass 10,000');
    assert.equal(computeLineAmount(byVolume, 10_000, 'usd', { unitLabel: 'event' }).amount, 500_000);
    assert.equal(computeLineAmount(byVolume, 10_001, 'usd', { unitLabel: 'event' }).amount, 2_000_200);
    // The rate the line ends on is the whole bill above 10,000, to the cent.
    assert.equal(computeLineAmount(byVolume, 50_000, 'usd', { unitLabel: 'event' }).amount, 200 * 50_000);

    const byTier = priceOf({ id: 'price_dip_graduated', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'graduated', tiers: overage });
    const graduatedCopy = describePrice(byTier, 'usd', 'en-US', events);
    assert.equal(graduatedCopy.summary,
      '$1.00 per event per month, falling to $0.50 per event beyond 1,000 events, rising to $2.00 per event beyond 10,000 events');
    const at10k = computeLineAmount(byTier, 10_000, 'usd', { unitLabel: 'event' }).amount;
    assert.equal(at10k, 100 * 1_000 + 50 * 9_000);
    assert.equal(computeLineAmount(byTier, 50_000, 'usd', { unitLabel: 'event' }).amount - at10k, 200 * 40_000);
  });

  test('a rising ladder says how far it climbs, and stops on the rate that keeps applying', () => {
    const climbing = priceOf({
      id: 'price_climbing', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'volume',
      tiers: [{ up_to: 10, unit_amount: 10 }, { up_to: 20, unit_amount: 100 }, { up_to: 'inf', unit_amount: 1000 }],
    });
    const display = describePrice(climbing, 'usd', 'en-US', events);
    assert.equal(display.summary, '$0.10 per event per month, rising through 3 tiers to $10.00 for every event once you pass 20');
    assert.equal(computeLineAmount(climbing, 10, 'usd', { unitLabel: 'event' }).amount, 100);
    assert.equal(computeLineAmount(climbing, 21, 'usd', { unitLabel: 'event' }).amount, 21_000);
    assert.equal(computeLineAmount(climbing, 100, 'usd', { unitLabel: 'event' }).amount, 100_000);
  });

  test('a ladder that keeps turning counts the changes in the middle and spells out the last', () => {
    const zigzag: PriceTier[] = [
      { up_to: 10, unit_amount: 100 }, { up_to: 20, unit_amount: 50 }, { up_to: 30, unit_amount: 200 },
      { up_to: 40, unit_amount: 25 }, { up_to: 50, unit_amount: 300 }, { up_to: 60, unit_amount: 10 },
      { up_to: 'inf', unit_amount: 400 },
    ];
    const byVolume = priceOf({ id: 'price_zigzag_volume', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'volume', tiers: zigzag });
    const display = describePrice(byVolume, 'usd', 'en-US', events);
    assert.equal(display.summary,
      '$1.00 per event per month, falling to $0.50 for every event once you pass 10, 4 more price changes, then rising to $4.00 for every event once you pass 60');
    // Every band is still spelled out where a reader can see it.
    assert.equal(display.tiers?.length, 7);
    assert.equal(computeLineAmount(byVolume, 120, 'usd', { unitLabel: 'event' }).amount, 400 * 120);

    const byTier = priceOf({ id: 'price_zigzag_graduated', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'graduated', tiers: zigzag });
    const graduatedCopy = describePrice(byTier, 'usd', 'en-US', events);
    assert.equal(graduatedCopy.summary,
      '$1.00 per event per month, falling to $0.50 per event beyond 10 events, 4 more price changes, then rising to $4.00 per event beyond 60 events');
    const at60 = computeLineAmount(byTier, 60, 'usd', { unitLabel: 'event' }).amount;
    assert.equal(computeLineAmount(byTier, 120, 'usd', { unitLabel: 'event' }).amount - at60, 400 * 60);
  });

  test('a band that drops the rate but adds a base charge quotes the base too', () => {
    // The rate falls 200x at 74 events and the bill still goes up by $500.
    const withBase = priceOf({
      id: 'price_base_on_step', model: 'tiered', billing_scheme: 'tiered', tiers_mode: 'graduated',
      tiers: [
        { up_to: 38, unit_amount: 1000, flat_amount: 50_000 }, { up_to: 74, unit_amount: 0 },
        { up_to: 76, unit_amount: 5, flat_amount: 50_000 }, { up_to: 'inf', unit_amount: 0 },
      ],
    });
    const display = describePrice(withBase, 'usd', 'en-US', events);
    assert.equal(display.summary,
      '$500.00 per month + $10.00 per event, falling to no charge at all beyond 38 events, '
      + 'rising to $500.00 base + $0.05 per event beyond 74 events, falling to no charge at all beyond 76 events');
    const at76 = computeLineAmount(withBase, 76, 'usd', { unitLabel: 'event' }).amount;
    assert.equal(at76, 50_000 + 1000 * 38 + 50_000 + 5 * 2);
    // "no charge at all beyond 76" is a claim about every quantity above it.
    assert.equal(computeLineAmount(withBase, 152, 'usd', { unitLabel: 'event' }).amount, at76);
    assert.equal(computeLineAmount(withBase, 100_000, 'usd', { unitLabel: 'event' }).amount, at76);
  });

  test('the seeded metered price names its allowance, its rate and where it steps down', () => {
    const price = app.ctx.svc.catalog.requirePrice(ORG, 'price_nw_telemetry_events');
    const product = app.ctx.svc.catalog.product(ORG, price.product);
    const display = app.ctx.svc.catalog.describe(price, 'usd', 'en-US', product);
    // Three paid bands, so the line says how far the rate walks down and where
    // it stops: $0.00019 is the rate the customer is still paying at 50m events.
    assert.equal(display.summary,
      'First 500,000 events included, then $0.0004 per event, falling through 3 tiers to $0.00019 per event beyond 25,000,000 events — billed monthly');
    // The rate the line ends on is the one the engine keeps charging above it:
    // 25m more events past 25m at $0.00019 is exactly what the invoice adds.
    const at25m = computeLineAmount(price, 25_000_000, 'usd', { unitLabel: 'event' }).amount;
    const at50m = computeLineAmount(price, 50_000_000, 'usd', { unitLabel: 'event' }).amount;
    assert.equal(at25m, 740_000);
    assert.equal(at50m - at25m, 475_000);
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

/* -------------- the summary, read back as claims about the engine --------- */

/*
 * The one line a pricing page prints verbatim is generated from the price, so
 * the way to trust it is to feed it ladders nobody wrote by hand and read the
 * prose back as a set of claims: every figure it quotes, every threshold it
 * names and the direction word it chooses are re-derived from
 * computeLineAmount. Three shapes this caught: a volume tier that halves the
 * rate and adds a base charge was advertised as "falling to" while the engine
 * billed 33x more at the boundary; a volume ladder that re-prices every unit
 * 10x higher was summarised with no step clause at all; and a ladder that fell
 * and then rose again was summarised at its cheapest band, quoting a rate the
 * price had already abandoned — a third of every generated step clause ended
 * on a rate the engine no longer charged, understating the bill by up to
 * 1000x. That last one is what the closing check below exists to prevent.
 */
describe('a generated summary agrees with the engine on every number it prints', () => {
  const events = productOf('event');
  const MONEY = String.raw`\$[\d,]+(?:\.\d+)?`;

  /** Every amount in a generated ladder is a whole number of minor units. */
  const minor = (text: string) => Math.round(Number(text.replace(/[^0-9.]/g, '')) * 100);
  const count = (text: string) => Number(text.replace(/,/g, ''));

  const qty = (n: number) => n.toLocaleString('en-US');

  /** The rate phrase the line opens with, before any step clause moves it. */
  const lastOpeningClause = (summary: string): string => {
    const head = summary.replace(/ — billed \w+$/, '').split(/, (?:falling|rising) (?:to|through) |, plus a /)[0];
    return head.includes(', then ') ? head.slice(head.lastIndexOf(', then ') + 7) : head;
  };

  /** The allowance the opening names, which is where its rate starts applying. */
  const allowanceOf = (summary: string): number | null => {
    const found = /\b(?:up to|the first) ([\d,]+)/.exec(summary);
    return found ? count(found[1]) : null;
  };

  /** The per-unit rate the line opens with, before any step clause moves it. */
  const openingRateOf = (summary: string): number | null => {
    const rates = [...lastOpeningClause(summary).matchAll(new RegExp(`(${MONEY}) (?:per|for every) `, 'g'))];
    return rates.length ? minor(rates[rates.length - 1][1]) : null;
  };

  /** mulberry32: a seeded PRNG, so a failing ladder is reproducible by seed. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const UNIT_AMOUNTS = [undefined, 0, 0, 1, 5, 25, 50, 100, 250, 500, 1000];
  const FLAT_AMOUNTS = [undefined, undefined, undefined, 0, 500, 1000, 5000, 50_000];
  const TRANSFORMS: (TransformQuantity | null)[] = [
    null, null, null, null, { divide_by: 10, round: 'up' }, { divide_by: 20, round: 'down' },
  ];

  function ladder(next: () => number): Price {
    const pick = <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)];
    const tierCount = 1 + Math.floor(next() * 4);
    const tiers: PriceTier[] = [];
    let cap = 0;
    for (let i = 0; i < tierCount; i++) {
      cap += 1 + Math.floor(next() * 40);
      const last = i === tierCount - 1;
      let unit_amount = pick(UNIT_AMOUNTS);
      const flat_amount = pick(FLAT_AMOUNTS);
      // validateTiers: a tier priced at nothing at all is not a tier.
      if (unit_amount === undefined && flat_amount === undefined) unit_amount = 100;
      tiers.push({
        up_to: last ? 'inf' : cap,
        ...(unit_amount === undefined ? {} : { unit_amount }),
        ...(flat_amount === undefined ? {} : { flat_amount }),
      } as PriceTier);
    }
    return priceOf({
      id: 'price_generated', model: 'tiered', billing_scheme: 'tiered',
      tiers, tiers_mode: next() < 0.5 ? 'volume' : 'graduated',
      transform_quantity: pick(TRANSFORMS),
      recurring: next() < 0.3
        ? { interval: 'month', interval_count: 1, usage_type: 'metered', aggregate_usage: 'sum', trial_period_days: null, meter: 'generated' }
        : { interval: 'month', interval_count: 1, usage_type: 'licensed', aggregate_usage: null, trial_period_days: null, meter: null },
    });
  }

  test('every threshold, figure and direction word survives being checked', () => {
    const next = rng(20260831);
    let withStepClause = 0;
    let withFallingClause = 0;
    let withRisingClause = 0;
    let withEntryCharge = 0;
    let withLadderClause = 0;

    for (let sample = 0; sample < 2500; sample++) {
      const price = ladder(next);
      const label = `${price.tiers_mode} ${JSON.stringify(price.tiers)}${price.transform_quantity ? ` /${price.transform_quantity.divide_by}` : ''}`;
      const stride = price.transform_quantity && price.transform_quantity.divide_by > 1 ? price.transform_quantity.divide_by : 1;
      const caps = price.tiers!.filter((t) => t.up_to !== 'inf').map((t) => Number(t.up_to));
      const top = ((caps[caps.length - 1] ?? 10) + 5) * stride * 2;

      const billed = new Map<number, number>();
      const bill = (q: number): number => {
        let amount = billed.get(q);
        if (amount === undefined) {
          amount = computeLineAmount(price, q, 'usd', { unitLabel: 'event' }).amount;
          billed.set(q, amount);
        }
        return amount;
      };
      const packages = (q: number) => applyTransform(q, price.transform_quantity);

      const display = describePrice(price, 'usd', 'en-US', events);
      const summary = display.summary;

      /* The floor a card prints as "from" is the line the engine really bills. */
      assert.equal(display.from_amount, bill(1), `${label}: from_amount`);
      assert.ok(minor(display.from!) >= bill(1), `${label}: "${display.from}" undersells ${bill(1)}`);

      /* Nothing is called included unless it is free at every quantity. */
      if (/^Included —/.test(summary)) {
        for (const q of [1, 3, stride * 3, top]) {
          assert.equal(bill(q), 0, `${label}: "${summary}" but ${q} costs ${bill(q)}`);
        }
      }

      /* An allowance is only an allowance if it is genuinely not charged for. */
      const free = new RegExp(`^(?:First ([\\d,]+) [^,]+ included|Free up to ([\\d,]+) [^,]+), then`).exec(summary);
      if (free) {
        const upTo = count(free[1] ?? free[2]);
        assert.equal(bill(upTo), 0, `${label}: "${summary}" but ${upTo} events cost ${bill(upTo)}`);
      }

      /* A base charge that "buys" an allowance is what the engine bills there. */
      const included = new RegExp(`^(${MONEY})(?: per \\w+)? (?:up to|including the first) ([\\d,]+)`).exec(summary);
      if (included) {
        const upTo = count(included[2]);
        assert.equal(bill(upTo), minor(included[1]),
          `${label}: "${summary}" quotes ${included[1]} for ${upTo} events, engine bills ${bill(upTo)}`);
      }

      /* A ladder of base charges quotes the next band's total, not its rate. */
      const thenTotal = new RegExp(`up to ([\\d,]+) [^,]+, then (${MONEY})(?: per (?:day|week|month|year))?(?: — billed \\w+)?$`).exec(summary);
      if (thenTotal) {
        const from = count(thenTotal[1]);
        assert.equal(bill(from + 1), minor(thenTotal[2]),
          `${label}: "${summary}" quotes ${thenTotal[2]} past ${from}, engine bills ${bill(from + 1)}`);
      }

      /*
       * Every rate the prose quotes is checked where the prose says it applies:
       * volume re-prices the whole quantity, so the quoted base and rate are
       * the entire bill past the threshold; graduated leaves earlier units
       * alone, so crossing buys one rate-unit at the new rate plus the band's
       * base, once.
       */
      const predicts = (phrase: string, from: number) => {
        const flatMatch = new RegExp(`^(${MONEY}) base`).exec(phrase);
        const unitMatch = new RegExp(`(?:^|\\+ )(${MONEY}) (?:for every|per) `).exec(phrase);
        const flat = flatMatch ? minor(flatMatch[1]) : 0;
        const unit = unitMatch ? minor(unitMatch[1]) : 0;
        const claimed = price.tiers_mode === 'volume'
          ? flat + unit * packages(from + 1)
          : flat + unit * (packages(from + 1) - packages(from));
        const charged = price.tiers_mode === 'volume' ? bill(from + 1) : bill(from + 1) - bill(from);
        assert.equal(charged, claimed,
          `${label}: "${summary}" predicts ${claimed} past ${from}, engine charges ${charged}`);
        return unit;
      };

      /* The rate an allowance gives way to, checked at the first unit it bills. */
      const then = new RegExp(`(?:up to|the first) ([\\d,]+)[^,]*, then (.+?)(?:, (?:falling|rising) (?:to|through) |, plus a |$)`).exec(summary);
      // A flat ladder's "then" is a total, checked above; only a rate phrase —
      // one that names a base or a unit — is a claim about what a unit costs.
      const isRate = then && (/ base\b/.test(then[2]) || / for every /.test(then[2])
        || new RegExp(` per (?!day|week|month|year)`).test(then[2]));
      if (isRate) predicts(then[2], count(then[1]));

      /*
       * Every step clause in the line, not just the first: its amounts, its
       * threshold and its direction word, each checked where that clause says
       * it applies and against the rate the clause before it left the reader
       * holding.
       */
      const stepsInProse = [...summary.matchAll(
        new RegExp(`(falling|rising)(?: through (\\d+) tiers)? to (.+?) (?:once you pass|beyond) ([\\d,]+)`, 'g'))];
      if (stepsInProse.length > 1 || stepsInProse.some((s) => s[2])) withLadderClause++;
      let quoted = openingRateOf(summary);
      for (const step of stepsInProse) {
        withStepClause++;
        if (step[1] === 'falling') withFallingClause++; else withRisingClause++;
        // A run of bands that all move the same way covers itself plus the one
        // it stepped away from, so it can never claim fewer than two tiers.
        if (step[2]) assert.ok(Number(step[2]) >= 2, `${label}: "${summary}" claims a run of ${step[2]} tiers`);
        const from = count(step[4]);
        const unit = predicts(step[3], from);

        if (price.tiers_mode === 'volume') {
          // "falling" has to mean the cost per unit actually fell — at the
          // step, or one unit later when the step itself is a wash.
          const cheaper = (a: number, aq: number, b: number, bq: number) => a * bq < b * aq;
          const expected = bill(from + 1) * from === bill(from) * (from + 1)
            ? (cheaper(bill(from + 2), from + 2, bill(from + 1), from + 1) ? 'falling' : 'rising')
            : (cheaper(bill(from + 1), from + 1, bill(from), from) ? 'falling' : 'rising');
          assert.equal(step[1], expected,
            `${label}: "${summary}" — ${from} events cost ${bill(from)}, ${from + 1} cost ${bill(from + 1)}, ${from + 2} cost ${bill(from + 2)}`);
        } else if (quoted !== null) {
          // Graduated quotes rates the customer pays per unit, so "falling"
          // has to mean cheaper than the rate the same line last quoted.
          assert.equal(step[1], unit < quoted ? 'falling' : 'rising',
            `${label}: "${summary}" — the line quotes ${quoted} before ${from} and ${unit} after`);
        }
        quoted = unit;
      }

      /* Every band that keeps the rate but charges to enter says so, and by how much. */
      for (const oneOff of summary.matchAll(new RegExp(`plus a (${MONEY}) base once you pass ([\\d,]+)`, 'g'))) {
        withEntryCharge++;
        const from = count(oneOff[2]);
        const sameBandBefore = from - 2 * stride >= 1
          && bill(from) - bill(from - stride) === bill(from - stride) - bill(from - 2 * stride);
        if (sameBandBefore) {
          const rate = bill(from) - bill(from - stride);
          assert.equal(bill(from + 1) - bill(from), minor(oneOff[1]) + rate,
            `${label}: "${summary}" — crossing ${from} costs ${bill(from + 1) - bill(from)}, not ${oneOff[1]} over a rate of ${rate}`);
        }
      }

      /*
       * Every quantity the prose names is a boundary the customer can feel —
       * re-derived from the tiers here rather than taken from the formatter —
       * and a ladder that changes shape somewhere never gets to stay silent.
       */
      const named = [...summary.matchAll(/\b(?:up to|first|beyond|once you pass|above) ([\d,]+)/gi)]
        .map((m) => count(m[1]));
      const slack = price.transform_quantity?.round === 'down' ? stride - 1 : 0;
      const boundaries = new Set(caps.map((cap) => cap * stride + slack));
      for (const quantity of named) {
        assert.ok(boundaries.has(quantity),
          `${label}: "${summary}" names ${quantity}, which is not a tier boundary (${[...boundaries]})`);
      }
      /*
       * The closing promise, and the assertion that shuts this whole class:
       * whatever the line says along the way, the last rate it quotes is the
       * one a reader carries past the last threshold it names, so extrapolating
       * that rate out to twice that threshold must never come in under the
       * invoice. The summary that stopped at the cheapest band failed exactly
       * here — it quoted $0.50 an event for a ladder billing $2.00 above
       * 10,000, and a customer reading the plan card budgeted a quarter of
       * what the renewal charged.
       */
      if (named.length) {
        const anchor = Math.max(...named);
        const far = anchor * 2;
        const monies = [...summary.matchAll(new RegExp(MONEY, 'g'))].map((m) => minor(m[0]));
        if (display.cheapest_unit === null) {
          // A ladder of base charges quotes totals, not rates: the total it
          // ends on is a fixed charge that holds at every quantity above.
          assert.ok(monies[monies.length - 1] >= bill(far),
            `${label}: "${summary}" ends on ${monies[monies.length - 1]}, but ${far} events cost ${bill(far)}`);
        } else {
          const closing = stepsInProse.length
            ? stepsInProse[stepsInProse.length - 1][3]
            : lastOpeningClause(summary);
          const appliesFrom = stepsInProse.length
            ? count(stepsInProse[stepsInProse.length - 1][4])
            : (allowanceOf(summary) ?? anchor);
          const rateMatch = new RegExp(`(?:^|\\+ )(${MONEY}) (?:for every|per) (?!day|week|month|year)`).exec(closing);
          const rate = rateMatch ? minor(rateMatch[1]) : 0;
          const baseMatch = new RegExp(`^(${MONEY}) base`).exec(closing);
          const base = baseMatch ? minor(baseMatch[1]) : 0;
          // A base named at the very threshold we extrapolate from has not been
          // billed yet, so the reader adds it; anything earlier is in bill(anchor).
          const entering = new RegExp(`plus a (${MONEY}) base once you pass ${qty(anchor)}\\b`).exec(summary);
          const stillToCome = (anchor === appliesFrom ? base : 0) + (entering ? minor(entering[1]) : 0);
          const reads = price.tiers_mode === 'volume'
            ? base + rate * packages(far)
            : bill(anchor) + stillToCome + rate * (packages(far) - packages(anchor));
          assert.ok(reads >= bill(far),
            `${label}: "${summary}" reads as ${reads} at ${far} events, engine bills ${bill(far)}`);
        }
      }

      /*
       * A line with no threshold in it is a promise about every quantity, so
       * it has to survive being extrapolated: multiply the rate it quotes by
       * what the customer buys at the top of the range and the engine has to
       * agree. This is the check the 10x volume step failed — it quoted
       * $0.50 an event on a price that bills $5.00 an event past ten.
       */
      if (named.length === 0) {
        const claim = summary.replace(/ — billed \w+$/, '');
        const interval = String.raw`(?: per (?:day|week|month|year))?`;
        const flatOnly = new RegExp(`^(${MONEY})${interval}$`).exec(claim);
        const baseAndRate = new RegExp(`^(${MONEY})${interval} \\+ (${MONEY}) per [^,+]+$`).exec(claim);
        const perUnit = new RegExp(`^(${MONEY}) per [^,+]+?${interval}$`).exec(claim);
        if (flatOnly) {
          assert.equal(bill(top), minor(flatOnly[1]),
            `${label}: "${summary}" is the whole price, but ${top} events cost ${bill(top)}`);
        } else if (baseAndRate || perUnit) {
          const rate = minor((baseAndRate ?? perUnit)![baseAndRate ? 2 : 1]);
          const claimed = (baseAndRate ? minor(baseAndRate[1]) : 0) + rate * packages(top);
          assert.ok(Math.abs(bill(top) - claimed) <= claimed * 0.02 + rate,
            `${label}: "${summary}" extrapolates to ${claimed} at ${top} events, engine bills ${bill(top)}`);
        }
      }
    }

    // The corpus has to exercise both directions, or it proves nothing.
    assert.ok(withFallingClause >= 250, `expected falling ladders in the corpus, got ${withFallingClause}`);
    assert.ok(withRisingClause >= 250, `expected rising ladders in the corpus, got ${withRisingClause}`);
    assert.ok(withStepClause >= 500, `expected step clauses to be common, got ${withStepClause}`);
    assert.ok(withEntryCharge >= 20, `expected bands that charge to enter, got ${withEntryCharge}`);
    // And the corpus has to contain ladders that keep moving after the first
    // step, or the sequence the summary now renders is never exercised.
    assert.ok(withLadderClause >= 250, `expected multi-band ladders in the corpus, got ${withLadderClause}`);
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
