import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, frozenClock, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { DAY } from '../src/shared/time';
import type { ChangePreview, Invoice, InvoiceLine, ProrationLine, Subscription } from '../src/server/modules/billing/types';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };

const UTC = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min, 0, 0);

/** Northwind's list prices, in minor units — the numbers the seeded catalog holds. */
const STARTER = 9_900;
const GROWTH = 49_900;
const SCALE = 190_000;
const GROWTH_SEAT = 2_900;

interface Workspace {
  app: App;
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  ok(method: string, path: string, body?: unknown): Promise<any>;
  fail(method: string, path: string, body: unknown, status: number, code?: string): Promise<any>;
  now(): number;
  travelTo(ts: number): Promise<{ ran: number; failed: number; now: number }>;
  customer(name?: string, over?: Record<string, unknown>): Promise<any>;
  close(): void;
}

/**
 * A workspace with a frozen clock. Every arithmetic test pins an exact instant
 * so the fractions in the assertions are the fractions the code computed.
 */
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
    async fail(method, path, body, status, code) {
      const res = await call(method, path, body);
      assert.equal(res.status, status, `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      if (code) assert.equal(res.body.error.code, code, JSON.stringify(res.body));
      return res.body.error;
    },
    now: () => app.ctx.now(),
    travelTo(ts) {
      const delta = ts - app.ctx.now();
      assert.ok(delta >= 0, 'the time machine only runs forwards');
      return app.travel(delta);
    },
    customer(name = 'Test Account', over = {}) {
      seq += 1;
      return ws.ok('POST', '/v1/customers', {
        name: `${name} ${seq}`,
        email: `ap+${seq}@testaccount.example`,
        currency: 'usd',
        ...over,
      });
    },
    close: () => app.close(),
  };
  return ws;
}

const lineFor = (preview: ChangePreview, kind: ProrationLine['kind'], price: string): ProrationLine | undefined =>
  preview.lines.find((line) => line.kind === kind && line.price === price);

/** Every invoice in the workspace, newest first, with its lines. */
const allInvoices = async (ws: Workspace, query = ''): Promise<Invoice[]> => {
  const out: Invoice[] = [];
  let cursor: string | null = null;
  do {
    const page = await ws.ok('GET', `/v1/invoices?limit=200${query}${cursor ? `&cursor=${cursor}` : ''}`);
    out.push(...(page.data as Invoice[]));
    cursor = page.has_more ? (page.next_cursor as string) : null;
  } while (cursor);
  return out;
};

const sumLines = (invoice: Invoice): number => invoice.lines.reduce((total, line) => total + line.amount, 0);
const sumTax = (invoice: Invoice): number => invoice.lines.reduce((total, line) => total + line.tax.amount, 0);

/** Exactly halfway through a subscription's current period. */
const midpointOf = (sub: Subscription): number =>
  sub.current_period_start + Math.floor((sub.current_period_end - sub.current_period_start) / 2);
const shapeOf = (line: InvoiceLine) => [line.kind, line.amount, line.description] as const;

const priceIdOf = async (ws: Workspace, lookupKey: string): Promise<string> => {
  const page = await ws.ok('GET', `/v1/prices?lookup_key=${lookupKey}`);
  assert.ok(page.data.length === 1, `expected exactly one price for ${lookupKey}`);
  return page.data[0].id as string;
};

/* ========================================================================== *
 * 1. Billing-cycle anchors
 * ========================================================================== */

describe('the billing cycle anchor', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 1, 31)); });
  after(() => ws.close());

  test('a subscription anchored on the 31st bills the 28th in February and returns to the 31st', async () => {
    const customer = await ws.customer('Halstead Precision');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }],
      billing_cycle_anchor: UTC(2026, 1, 31),
    });

    assert.equal(sub.billing_cycle_anchor_day, 31, 'the anchor day is kept, not the truncated date');
    assert.equal(sub.current_period_start, UTC(2026, 1, 31));
    assert.equal(sub.current_period_end, UTC(2026, 2, 28), 'February is short, so the period ends on the 28th');

    // February → March: the anchor day comes back.
    await ws.travelTo(UTC(2026, 2, 28) + 60_000);
    let now: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(now.current_period_start, UTC(2026, 2, 28));
    assert.equal(now.current_period_end, UTC(2026, 3, 31), 'back to the 31st in March');

    // March → April: April has 30 days, so it clamps again.
    await ws.travelTo(UTC(2026, 3, 31) + 60_000);
    now = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(now.current_period_start, UTC(2026, 3, 31));
    assert.equal(now.current_period_end, UTC(2026, 4, 30));

    // April → May: and back to the 31st again, with no drift.
    await ws.travelTo(UTC(2026, 4, 30) + 60_000);
    now = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(now.current_period_start, UTC(2026, 4, 30));
    assert.equal(now.current_period_end, UTC(2026, 5, 31));

    const periods = await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods`);
    const starts = (periods.data as { period_start: number; amount: number }[])
      .map((p) => p.period_start).sort((a, b) => a - b);
    assert.deepEqual(starts, [UTC(2026, 1, 31), UTC(2026, 2, 28), UTC(2026, 3, 31), UTC(2026, 4, 30)]);
    for (const period of periods.data) assert.equal(period.amount, GROWTH, 'every month bills the same list price');
  });

  test('a leap February takes the 29th', async () => {
    // Its own workspace, because a subscription may only be backdated to a day
    // that has already happened — and the leap day this test is about is 2028's.
    const leap = await workspace(UTC(2028, 1, 31));
    try {
      const customer = await leap.customer('Leap Day Metals');
      const sub: Subscription = await leap.ok('POST', '/v1/subscriptions', {
        customer: customer.id,
        items: [{ price: 'starter_monthly' }],
        billing_cycle_anchor: UTC(2028, 1, 31),
        backdate_start_date: UTC(2028, 1, 31),
      });
      assert.equal(sub.current_period_start, UTC(2028, 1, 31));
      assert.equal(sub.current_period_end, UTC(2028, 2, 29), '2028 is a leap year');
    } finally {
      leap.close();
    }
  });

  test('a subscription that starts mid-cycle pays only for the rest of the month', async () => {
    const customer = await ws.customer('Mid Cycle Machining');
    // Signed on the 8th, but the account bills on the 1st with everything else.
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }],
      backdate_start_date: UTC(2026, 2, 8),
      billing_cycle_anchor: UTC(2026, 3, 1),
    });
    assert.equal(sub.current_period_start, UTC(2026, 2, 8));
    assert.equal(sub.current_period_end, UTC(2026, 3, 1), 'the first period runs to the anchor');

    const periods = await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods`);
    const whole = UTC(2026, 3, 1) - UTC(2026, 2, 1);
    const held = UTC(2026, 3, 1) - UTC(2026, 2, 8);
    assert.equal(periods.data[0].amount, Math.round(GROWTH * held / whole),
      'a part-month is charged as a part-month, against the real length of February');
  });

  test('a renewal job that names a period the subscription has already left does nothing', async () => {
    const customer = await ws.customer('Replayed Renewal');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'starter_monthly' }], billing_cycle_anchor: UTC(2026, 1, 31),
    });
    await ws.travelTo(sub.current_period_end + 60_000);
    const after: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);

    // Re-run the job that already fired: a retry, a duplicate enqueue or a
    // replayed clock must never bill a period twice.
    ws.app.ctx.enqueue(ORG, 'billing.renew', { subscription: sub.id, period_end: sub.current_period_end });
    await ws.app.tick();
    const again: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(again.current_period_start, after.current_period_start);
    assert.equal(again.current_period_end, after.current_period_end);
    const periods = await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods`);
    assert.equal(periods.data.length, 2);
  });
});


/* ========================================================================== *
 * 1b. The anchor day
 * ========================================================================== */

describe('the anchor day', () => {
  const JAN1 = UTC(2026, 1, 1);
  const JAN15 = UTC(2026, 1, 15);
  /** 14 of the 31 days of the interval that ends on 15 January. */
  const FOURTEEN_OF_THIRTY_ONE = Math.round((GROWTH * (JAN15 - JAN1)) / (JAN15 - UTC(2025, 12, 15)));

  test('naming the day and naming the instant are two spellings of one cycle', async () => {
    const ws = await workspace(JAN1);
    try {
      const byDay: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: (await ws.customer('Anchored By Day')).id,
        items: [{ price: 'growth_monthly' }],
        billing_cycle_anchor_day: 15,
      });
      const byInstant: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: (await ws.customer('Anchored By Instant')).id,
        items: [{ price: 'growth_monthly' }],
        billing_cycle_anchor: JAN15,
      });

      assert.equal(byDay.billing_cycle_anchor_day, 15);
      assert.equal(byDay.current_period_start, JAN1);
      assert.equal(byDay.current_period_end, JAN15,
        'the first period runs to the billing day — not a month and a half past it');
      assert.equal(byDay.current_period_end, byInstant.current_period_end,
        'the two spellings describe the same cycle');

      const dayLedger = await ws.ok('GET', `/v1/subscriptions/${byDay.id}/periods`);
      const instantLedger = await ws.ok('GET', `/v1/subscriptions/${byInstant.id}/periods`);
      assert.equal(dayLedger.data[0].amount, FOURTEEN_OF_THIRTY_ONE, 'a fortnight costs a fortnight');
      assert.equal(instantLedger.data[0].amount, dayLedger.data[0].amount,
        'and the two spellings cost the same to the cent');
    } finally { ws.close(); }
  });

  test('no period is ever longer than the interval it is a part of', async () => {
    const ws = await workspace(JAN1);
    try {
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: (await ws.customer('Halfmonth Hydraulics')).id,
        items: [{ price: 'growth_monthly' }],
        billing_cycle_anchor_day: 15,
      });
      await ws.travelTo(UTC(2027, 1, 2));

      const periods = await ws.ok(`GET`, `/v1/subscriptions/${sub.id}/periods?limit=200`);
      const rows = (periods.data as { period_start: number; period_end: number; amount: number }[])
        .slice().sort((a, b) => a.period_start - b.period_start);
      for (const row of rows) {
        assert.ok(row.period_end - row.period_start <= 31 * DAY,
          `${new Date(row.period_start).toISOString()} to ${new Date(row.period_end).toISOString()} is longer than a month`);
      }
      assert.equal(rows[0].period_end, JAN15);
      assert.equal(rows[rows.length - 1].period_end, UTC(2027, 1, 15), 'still landing on the 15th a year later');
      assert.equal(rows.reduce((total, row) => total + row.amount, 0), FOURTEEN_OF_THIRTY_ONE + 12 * GROWTH,
        'the part-month plus twelve whole ones — no free days and no double-charged ones');
    } finally { ws.close(); }
  });

  test('an anchor day that contradicts the anchor instant is refused, not silently picked between', async () => {
    const ws = await workspace(JAN1);
    try {
      const error = await ws.fail('POST', '/v1/subscriptions', {
        customer: (await ws.customer('Two Minds')).id,
        items: [{ price: 'growth_monthly' }],
        billing_cycle_anchor: JAN1,
        billing_cycle_anchor_day: 15,
      }, 400, 'billing_cycle_anchor_conflict');
      assert.match(error.message, /day 1 .*says 15/);
      assert.equal(error.param, 'billing_cycle_anchor_day');

      // Saying the same thing twice is fine: the 31st in a 28-day February is
      // still the 31st.
      const agreeing: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: (await ws.customer('One Mind')).id,
        items: [{ price: 'growth_monthly' }],
        billing_cycle_anchor: UTC(2026, 2, 28),
        billing_cycle_anchor_day: 31,
      });
      assert.equal(agreeing.billing_cycle_anchor_day, 31);
      assert.equal(agreeing.current_period_end, UTC(2026, 1, 31),
        'the cycle is the 31st, so the first boundary is 31 January — 28 February is the same cycle, one month on');
    } finally { ws.close(); }
  });

  test('an anchor day means nothing on a weekly cycle, and says so', async () => {
    const ws = await workspace(JAN1);
    try {
      const product = await ws.ok('POST', '/v1/products', {
        name: 'Line-side shift report',
        default_price_data: {
          currency: 'usd', model: 'flat', type: 'recurring', unit_amount: 4_900,
          nickname: 'Shift report — weekly', recurring: { interval: 'week' },
        },
      });
      const error = await ws.fail('POST', '/v1/subscriptions', {
        customer: (await ws.customer('Weekly Reports')).id,
        items: [{ price: product.default_price }],
        billing_cycle_anchor_day: 15,
      }, 400, 'anchor_day_not_applicable');
      assert.match(error.message, /every week/);
    } finally { ws.close(); }
  });

  test('the first paid period after a trial covers only the days up to the billing day', async () => {
    const ws = await workspace(JAN1);
    try {
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: (await ws.customer('Trial Then First')).id,
        items: [{ price: 'growth_monthly' }],
        trial_period_days: 14,
        billing_cycle_anchor_day: 1,
      });
      assert.equal(sub.status, 'trialing');
      assert.equal(sub.current_period_end, JAN15, 'the trial is the current period');

      await ws.travelTo(JAN15 + 60_000);
      const converted: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
      assert.equal(converted.status, 'active');
      assert.equal(converted.current_period_start, JAN15);
      assert.equal(converted.current_period_end, UTC(2026, 2, 1),
        'the account bills on the 1st, so the stub runs to the 1st');

      const periods = await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods`);
      const rows = (periods.data as { period_start: number; amount: number; status: string }[])
        .slice().sort((a, b) => a.period_start - b.period_start);
      assert.equal(rows[0].amount, 0, 'a trial recognises no revenue');
      const stub = UTC(2026, 2, 1) - JAN15;
      const whole = UTC(2026, 2, 1) - JAN1;
      assert.equal(rows[1].amount, Math.round((GROWTH * stub) / whole),
        'seventeen days of a thirty-one day month, not a whole month');
    } finally { ws.close(); }
  });

  test('a change inside a part-period credits against the interval, never more than was charged', async () => {
    const ws = await workspace(JAN1);
    try {
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: (await ws.customer('Short First Month')).id,
        items: [{ price: 'growth_monthly' }],
        billing_cycle_anchor_day: 15,
      });
      const ledger = await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods`);
      assert.equal(ledger.data[0].amount, FOURTEEN_OF_THIRTY_ONE);

      const at = UTC(2026, 1, 8);
      const preview: ChangePreview = await ws.ok('POST', `/v1/subscriptions/${sub.id}/preview`, {
        items: [{ id: sub.items[0].id, price: 'scale_monthly' }],
        proration_date: at,
      });
      const whole = JAN15 - UTC(2025, 12, 15);
      const left = JAN15 - at;
      assert.deepEqual(preview.lines[0].proration, { numerator: left, denominator: whole },
        'the denominator is the whole interval, not the fortnight the customer holds');
      assert.equal(preview.lines[0].amount, -Math.round((GROWTH * left) / whole));
      assert.equal(preview.lines[1].amount, Math.round((SCALE * left) / whole));
      assert.ok(-preview.lines[0].amount < ledger.data[0].amount,
        'a week of a fortnight cannot be worth more than the fortnight itself');
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 2. Proration
 * ========================================================================== */

describe('proration', () => {
  let ws: Workspace;
  /** 1 March 2026. A 31-day period, so the halfway point is exact. */
  const PERIOD_START = UTC(2026, 3, 1);
  const PERIOD_END = UTC(2026, 4, 1);
  const PERIOD_MS = PERIOD_END - PERIOD_START;
  const HALFWAY = PERIOD_START + PERIOD_MS / 2;

  before(async () => { ws = await workspace(PERIOD_START); });
  after(() => ws.close());

  async function subscribe(items: unknown[], over: Record<string, unknown> = {}): Promise<Subscription> {
    const customer = await ws.customer('Proration Works', over.customer as Record<string, unknown> | undefined);
    return ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items,
      billing_cycle_anchor: PERIOD_START,
      ...over,
      customer_over: undefined,
    });
  }

  test('an upgrade at exactly half a period credits and charges symmetrically', async () => {
    const sub = await subscribe([{ price: 'growth_monthly' }]);
    assert.equal(sub.current_period_end - sub.current_period_start, PERIOD_MS);

    const preview: ChangePreview = await ws.ok('POST', `/v1/subscriptions/${sub.id}/preview`, {
      items: [{ id: sub.items[0].id, price: 'scale_monthly' }],
      proration_date: HALFWAY,
    });

    assert.equal(preview.lines.length, 2, 'one credit, one charge');
    const credit = preview.lines[0];
    const charge = preview.lines[1];

    assert.equal(credit.kind, 'unused_time');
    assert.equal(charge.kind, 'remaining_time');
    assert.deepEqual(credit.proration, { numerator: PERIOD_MS / 2, denominator: PERIOD_MS });
    assert.deepEqual(charge.proration, credit.proration, 'both sides use the same fraction of the same period');

    assert.equal(credit.amount, -GROWTH / 2, 'half of Growth given back');
    assert.equal(charge.amount, SCALE / 2, 'half of Scale charged');
    assert.equal(credit.amount * -2, GROWTH);
    assert.equal(charge.amount * 2, SCALE);
    assert.equal(preview.net, SCALE / 2 - GROWTH / 2);

    // The lines say which period they cover, in words a customer can check.
    assert.match(credit.description, /^Unused time on Telemetry Cloud Growth after Mar 16/);
    assert.match(charge.description, /^Remaining time on Telemetry Cloud Scale after Mar 16/);
    assert.equal(credit.period.start, HALFWAY);
    assert.equal(credit.period.end, PERIOD_END);
    assert.match(credit.explanation, /1339200000\/2678400000 ms/);

    // Every breakdown row sums back to the line it explains.
    for (const line of preview.lines) {
      const rows = line.breakdown.reduce((total, row) => total + row.amount, 0);
      assert.equal(rows, line.amount, `${line.description} breakdown does not add up`);
    }
  });

  test('a quantity change prorates only the difference in seats it is charged for', async () => {
    const sub = await subscribe([{ price: 'growth_monthly' }, { price: 'growth_seat_monthly', quantity: 4 }]);
    const seatItem = sub.items[1];
    const preview: ChangePreview = await ws.ok('POST', `/v1/subscriptions/${sub.id}/preview`, {
      items: [{ id: seatItem.id, quantity: 10 }],
      proration_date: HALFWAY,
    });
    assert.equal(preview.lines.length, 2, 'the untouched platform fee produces no lines');
    assert.equal(preview.lines[0].amount, -(4 * GROWTH_SEAT) / 2);
    assert.equal(preview.lines[1].amount, (10 * GROWTH_SEAT) / 2);
    assert.equal(preview.net, (6 * GROWTH_SEAT) / 2, 'the customer pays for six more seats for half a month');
  });

  test('two changes in one cycle compose — the second prorates against the first', async () => {
    const sub = await subscribe([{ price: 'growth_monthly' }]);
    const growthId = sub.items[0].id;
    const scalePrice = await priceIdOf(ws, 'scale_monthly');
    const growthPrice = await priceIdOf(ws, 'growth_monthly');
    const starterPrice = await priceIdOf(ws, 'starter_monthly');

    const t1 = PERIOD_START + 10 * DAY;
    const t2 = PERIOD_START + 20 * DAY;
    const remaining1 = PERIOD_END - t1;
    const remaining2 = PERIOD_END - t2;

    const first = await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: growthId, price: 'scale_monthly' }],
      proration_date: t1,
    });
    const firstProration = first.proration as ChangePreview;
    assert.equal(lineFor(firstProration, 'unused_time', growthPrice)?.amount, -Math.round(GROWTH * remaining1 / PERIOD_MS));
    assert.equal(lineFor(firstProration, 'remaining_time', scalePrice)?.amount, Math.round(SCALE * remaining1 / PERIOD_MS));

    const second = await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: first.items[0].id, price: 'starter_monthly' }],
      proration_date: t2,
    });
    const secondProration = second.proration as ChangePreview;

    const secondCredit = lineFor(secondProration, 'unused_time', scalePrice);
    assert.ok(secondCredit, 'the second change credits Scale, not the Growth plan the cycle started on');
    assert.equal(secondCredit.amount, -Math.round(SCALE * remaining2 / PERIOD_MS));
    assert.equal(
      lineFor(secondProration, 'remaining_time', starterPrice)?.amount,
      Math.round(STARTER * remaining2 / PERIOD_MS),
    );
    assert.equal(lineFor(secondProration, 'unused_time', growthPrice), undefined,
      'Growth was already credited in full at the first change; crediting it twice would be a refund');

    // Both prorations use the whole period as the denominator, so the Scale
    // charge and the Scale credit meet exactly at t2: the customer is billed
    // for the ten days they actually held Scale.
    const scaleCharged = (lineFor(firstProration, 'remaining_time', scalePrice)?.amount ?? 0) + secondCredit.amount;
    const scaleExact = SCALE * (t2 - t1) / PERIOD_MS;
    assert.ok(Math.abs(scaleCharged - scaleExact) <= 1,
      `Scale should cost ${scaleExact} for the ten days held, got ${scaleCharged}`);

    // And the whole cycle nets out to the three stretches actually held. Both
    // changes wait as invoice items — the second netted negative, and a credit
    // is a line on a bill, not a number moved to the balance where the tax on
    // it would be left behind.
    const pending = await ws.ok('GET', `/v1/customers/${sub.customer}/pending_items`);
    const prorations = (pending.data as { amount: number }[]).reduce((total, item) => total + item.amount, 0);
    const account = await ws.ok('GET', `/v1/customers/${sub.customer}`);
    assert.equal(account.balance, 0, 'nothing was routed around the invoice');
    assert.equal(pending.data.length, 4, 'both halves of both changes are waiting to be billed');
    const wholeCycle = GROWTH + prorations;
    const exact = GROWTH * (t1 - PERIOD_START) / PERIOD_MS
      + SCALE * (t2 - t1) / PERIOD_MS
      + STARTER * (PERIOD_END - t2) / PERIOD_MS;
    assert.ok(Math.abs(wholeCycle - exact) <= 2, `cycle total ${wholeCycle} vs exact ${exact}`);
  });

  test('the preview is the charge, line for line and to the cent', async () => {
    const sub = await subscribe([{ price: 'growth_monthly' }, { price: 'growth_seat_monthly', quantity: 7 }]);
    const change = {
      items: [
        { id: sub.items[0].id, price: 'scale_monthly' },
        { id: sub.items[1].id, price: 'scale_seat_monthly', quantity: 30 },
        { price: 'telemetry_events_monthly' },
      ],
    };

    const preview: ChangePreview = await ws.ok('POST', `/v1/subscriptions/${sub.id}/preview`, change);
    const applied = await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, change);
    const settled = applied.proration as ChangePreview;

    assert.ok(preview.lines.length > 0);
    assert.equal(settled.lines.length, preview.lines.length);
    for (let i = 0; i < preview.lines.length; i++) {
      assert.equal(settled.lines[i].amount, preview.lines[i].amount);
      assert.equal(settled.lines[i].description, preview.lines[i].description);
      assert.equal(settled.lines[i].explanation, preview.lines[i].explanation);
      assert.deepEqual(settled.lines[i].proration, preview.lines[i].proration);
    }
    assert.equal(settled.net, preview.net);
    assert.equal(settled.next_invoice.subtotal, preview.next_invoice.subtotal);

    // And the same numbers are what actually landed on the account.
    const pending = await ws.ok('GET', `/v1/customers/${sub.customer}/pending_items`);
    assert.equal(pending.data.length, preview.lines.length);
    const stored = (pending.data as { amount: number; description: string }[])
      .map((item) => [item.description, item.amount]);
    assert.deepEqual(stored, preview.lines.map((line) => [line.description, line.amount]));
  });

  test('a downgrade is invoiced as a credit line, never collected and never routed around the bill', async () => {
    const sub = await subscribe([{ price: 'scale_monthly' }]);
    const before = await ws.ok('GET', `/v1/customers/${sub.customer}`);
    assert.equal(before.balance, 0);

    const preview: ChangePreview = await ws.ok('POST', `/v1/subscriptions/${sub.id}/preview`, {
      items: [{ id: sub.items[0].id, price: 'starter_monthly' }],
      proration_date: HALFWAY,
      proration_behavior: 'always_invoice',
    });
    assert.equal(preview.net, STARTER / 2 - SCALE / 2);
    assert.ok(preview.net < 0);
    assert.equal(preview.amount_due_now, 0, 'a credit is never collected');
    assert.equal(preview.customer_balance, 0, 'and the change itself moves nothing on the balance');
    assert.match(preview.notices.join(' '), /Credits are never paid out/);
    assert.match(preview.notices.join(' '), /taxes them exactly as it taxed the charge/);

    await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: sub.items[0].id, price: 'starter_monthly' }],
      proration_date: HALFWAY,
      proration_behavior: 'always_invoice',
    });

    // always_invoice means what it says whichever way the set nets: the credit
    // is a document, with both halves of the change on it as lines.
    const credit = (await allInvoices(ws, `&subscription=${sub.id}`))
      .find((invoice) => invoice.billing_reason === 'subscription_update');
    assert.ok(credit, 'the change was invoiced');
    assert.equal(credit.subtotal, preview.net);
    assert.deepEqual(credit.lines.map((line) => line.kind).sort(), ['remaining_time', 'unused_time']);
    assert.equal(credit.total, 0, 'a bill is never negative');
    assert.equal(credit.balance_applied, -preview.net, 'what it cannot carry is what reaches the account');

    const after = await ws.ok('GET', `/v1/customers/${sub.customer}`);
    assert.equal(after.balance, preview.net, 'and the customer holds the credit');

    const ledger = await ws.ok('GET', `/v1/customers/${sub.customer}/balance_transactions`);
    assert.equal(ledger.data.length, 1);
    assert.equal(ledger.data[0].amount, preview.net);
    assert.equal(ledger.data[0].type, 'applied_to_invoice');
    assert.equal(ledger.data[0].invoice, credit.id);
    assert.equal(ledger.data[0].ending_balance, preview.net);

    const stillPending = await ws.ok('GET', `/v1/customers/${sub.customer}/pending_items`);
    assert.equal(stillPending.data.length, 0, 'the invoice claimed both lines');

    const summary = await ws.ok('GET', `/v1/customers/${sub.customer}/summary`);
    assert.equal(summary.balance.credit, true);
    assert.match(summary.balance.description, /off the next invoice/);
  });

  test('proration never applies to a metered item', async () => {
    const sub = await subscribe([
      { price: 'growth_monthly' },
      { price: 'growth_seat_monthly', quantity: 5 },
      { price: 'telemetry_events_monthly' },
    ]);
    const metered = sub.items[2];
    assert.equal(metered.metered, true);

    const preview: ChangePreview = await ws.ok('POST', `/v1/subscriptions/${sub.id}/preview`, {
      items: [
        { id: sub.items[0].id, price: 'scale_monthly' },
        { id: sub.items[1].id, price: 'scale_seat_monthly', quantity: 26 },
      ],
      proration_date: HALFWAY,
    });
    assert.ok(preview.lines.length > 0);
    for (const line of preview.lines) {
      assert.notEqual(line.price, metered.price, 'metered usage must never be prorated');
    }

    // Even removing the metered item outright produces no proration for it.
    const removal: ChangePreview = await ws.ok('POST', `/v1/subscriptions/${sub.id}/preview`, {
      items: [{ id: metered.id, deleted: true }],
      proration_date: HALFWAY,
    });
    assert.equal(removal.lines.length, 0);
    assert.match(removal.notices.join(' '), /Metered usage is never prorated/);

    // Its quantity is fixed at one: usage decides what is billed.
    await ws.fail('PATCH', `/v1/subscriptions/${sub.id}`,
      { items: [{ id: metered.id, quantity: 4 }] }, 400, 'metered_item_quantity');
  });

  test('changes during a trial are free, and moving the anchor charges a whole new period', async () => {
    const trial = await subscribe([{ price: 'growth_monthly' }], { trial_period_days: 14 });
    assert.equal(trial.status, 'trialing');
    const free: ChangePreview = await ws.ok('POST', `/v1/subscriptions/${trial.id}/preview`, {
      items: [{ id: trial.items[0].id, price: 'scale_monthly' }],
    });
    assert.equal(free.lines.length, 0);
    assert.match(free.notices.join(' '), /Trial time is free/);

    const sub = await subscribe([{ price: 'growth_monthly' }]);
    const reset: ChangePreview = await ws.ok('POST', `/v1/subscriptions/${sub.id}/preview`, {
      billing_cycle_anchor: 'now',
      proration_date: HALFWAY,
    });
    assert.equal(reset.next_period.start, HALFWAY);
    assert.equal(lineFor(reset, 'unused_time', await priceIdOf(ws, 'growth_monthly'))?.amount, -GROWTH / 2);
    assert.equal(lineFor(reset, 'remaining_time', await priceIdOf(ws, 'growth_monthly'))?.amount, GROWTH,
      'the new period is charged in full because it starts here');
  });

  test('proration_behavior=none moves the items and charges nothing', async () => {
    const sub = await subscribe([{ price: 'growth_monthly' }]);
    const result = await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: sub.items[0].id, price: 'scale_monthly' }],
      proration_behavior: 'none',
      proration_date: HALFWAY,
    });
    assert.equal(result.items[0].price, await priceIdOf(ws, 'scale_monthly'));
    assert.equal((result.proration as ChangePreview).lines.length, 0);
    const pending = await ws.ok('GET', `/v1/customers/${sub.customer}/pending_items`);
    assert.equal(pending.data.length, 0);
    const customer = await ws.ok('GET', `/v1/customers/${sub.customer}`);
    assert.equal(customer.balance, 0);
  });
});


/* ========================================================================== *
 * 2b. Changing the billing cadence
 * ========================================================================== */

describe('changing the billing cadence', () => {
  const START = UTC(2026, 1, 1);
  const YEAR_END = UTC(2027, 1, 1);
  const GROWTH_ANNUAL = 499_000;
  const SCALE_ANNUAL = 1_900_000;

  test('"switch me to annual" moves the whole subscription onto the year', async () => {
    const ws = await workspace(START);
    try {
      const customer = await ws.customer('Vantage Fabrication');
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: customer.id, items: [{ price: 'growth_monthly' }],
      });
      assert.equal(sub.interval, 'month');
      assert.equal(sub.current_period_end, UTC(2026, 2, 1));

      const preview: ChangePreview = await ws.ok('POST', `/v1/subscriptions/${sub.id}/preview`, {
        items: [{ id: sub.items[0].id, price: 'growth_annual' }],
      });
      assert.deepEqual(preview.interval_before, { interval: 'month', interval_count: 1 });
      assert.deepEqual(preview.interval_after, { interval: 'year', interval_count: 1 },
        'the cadence comes from the prices, not from the row');
      assert.equal(preview.next_period.end, YEAR_END, 'a year, charged once');
      assert.equal(preview.next_invoice.date, YEAR_END, 'and nothing due again until then');
      assert.equal(preview.next_invoice.subtotal, GROWTH_ANNUAL);
      assert.equal(preview.mrr_after, Math.round(GROWTH_ANNUAL / 12),
        'an annual commitment is a twelfth of itself per month, not the whole thing');
      assert.match(preview.notices.join(' '), /bill every year, but this subscription bills every month/);

      // The unused month goes back and the year is charged from here.
      assert.equal(preview.lines.length, 2);
      assert.equal(preview.lines[0].amount, -GROWTH);
      assert.equal(preview.lines[1].amount, GROWTH_ANNUAL);

      const changed = await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
        items: [{ id: sub.items[0].id, price: 'growth_annual' }],
      });
      assert.equal(changed.interval, 'year');
      assert.equal(changed.interval_count, 1);
      assert.equal(changed.current_period_start, START);
      assert.equal(changed.current_period_end, YEAR_END);
      assert.equal(changed.items[0].amount, GROWTH_ANNUAL);
      assert.equal(changed.mrr, Math.round(GROWTH_ANNUAL / 12));
      assert.deepEqual(changed.proration.lines.map((line: ProrationLine) => line.amount), [-GROWTH, GROWTH_ANNUAL],
        'the preview is what was settled');

      // A year of the time machine: the annual price is charged once, not twelve times.
      await ws.travelTo(UTC(2026, 12, 31));
      const periods = await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods?limit=200`);
      const rows = (periods.data as { period_start: number; period_end: number; amount: number }[])
        .slice().sort((a, b) => a.period_start - b.period_start);
      assert.deepEqual(rows.map((row) => [row.period_start, row.period_end, row.amount]),
        [[START, YEAR_END, GROWTH_ANNUAL]],
        'one period, one year, one annual price — the ledger and the subscription agree');

      const due = ws.app.ctx.events.list(ORG, { types: ['subscription.invoice_due'], objectId: sub.id, limit: 50 });
      assert.equal(due.length, 1, 'the only invoice raised was the first monthly one, before the switch');
      const summary = await ws.ok('GET', `/v1/customers/${customer.id}/summary`);
      assert.equal(summary.mrr, Math.round(GROWTH_ANNUAL / 12));
    } finally { ws.close(); }
  });

  test('a cadence change while the cycle is pinned is a contradiction, and names both cadences', async () => {
    const ws = await workspace(START);
    try {
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: (await ws.customer('Pinned Cycle')).id,
        items: [{ price: 'growth_monthly' }],
      });
      const error = await ws.fail('PATCH', `/v1/subscriptions/${sub.id}`, {
        items: [{ id: sub.items[0].id, price: 'growth_annual' }],
        billing_cycle_anchor: 'unchanged',
      }, 400, 'subscription_interval_change');
      assert.match(error.message, /bills every month but the requested items bill every year/);
      assert.equal(error.param, 'billing_cycle_anchor');

      const untouched: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
      assert.equal(untouched.interval, 'month');
      assert.equal(untouched.items[0].price, await priceIdOf(ws, 'growth_monthly'));
    } finally { ws.close(); }
  });

  test('switching cadence inside a trial moves the cycle, not the free time', async () => {
    const ws = await workspace(START);
    try {
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: (await ws.customer('Trialling Annual')).id,
        items: [{ price: 'growth_monthly' }],
        trial_period_days: 14,
        default_payment_method: 'pm_card_trialling',
      });
      const trialEnd = UTC(2026, 1, 15);
      assert.equal(sub.trial_end, trialEnd);

      const preview: ChangePreview = await ws.ok('POST', `/v1/subscriptions/${sub.id}/preview`, {
        items: [{ id: sub.items[0].id, price: 'growth_annual' }],
      });
      assert.equal(preview.lines.length, 0, 'trial time is free, so nothing is credited or charged');
      assert.equal(preview.next_invoice.date, trialEnd, 'the promised free days are not cut short');
      assert.equal(preview.next_invoice.subtotal, GROWTH_ANNUAL);

      const changed = await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
        items: [{ id: sub.items[0].id, price: 'growth_annual' }],
      });
      assert.equal(changed.interval, 'year');
      assert.equal(changed.status, 'trialing');
      assert.equal(changed.current_period_end, trialEnd, 'the trial still ends when it always did');

      await ws.travelTo(trialEnd + 60_000);
      const converted: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
      assert.equal(converted.status, 'active');
      assert.equal(converted.current_period_start, trialEnd);
      assert.equal(converted.current_period_end, UTC(2027, 1, 15), 'and the first paid period is a whole year');
      const periods = await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods`);
      const rows = (periods.data as { amount: number; status: string }[])
        .slice().sort((a, b) => a.amount - b.amount);
      assert.deepEqual(rows.map((row) => [row.status, row.amount]), [['trial', 0], ['billed', GROWTH_ANNUAL]]);
    } finally { ws.close(); }
  });

  test('a schedule phase on another cadence takes the subscription onto it', async () => {
    const ws = await workspace(START);
    try {
      const customer = await ws.customer('Ramped To Annual');
      const schedule = await ws.ok('POST', '/v1/subscription-schedules', {
        customer: customer.id,
        start_date: START,
        end_behavior: 'release',
        phases: [
          { items: [{ price: 'growth_monthly' }], iterations: 2 },
          { items: [{ price: 'scale_monthly' }], iterations: 2 },
          { items: [{ price: 'scale_annual' }], iterations: 1 },
        ],
      });
      assert.deepEqual(schedule.phases.map((p: { end_date: number }) => p.end_date),
        [UTC(2026, 3, 1), UTC(2026, 5, 1), UTC(2027, 5, 1)]);

      await ws.travelTo(UTC(2026, 6, 1));
      const sub: Subscription = await ws.ok('GET', `/v1/subscriptions/${schedule.subscription}`);
      assert.equal(sub.interval, 'year', 'the final phase bills annually, so the subscription does too');
      assert.equal(sub.current_period_start, UTC(2026, 5, 1));
      assert.equal(sub.current_period_end, UTC(2027, 5, 1));

      const periods = await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods?limit=200`);
      const rows = (periods.data as { period_start: number; period_end: number; amount: number }[])
        .slice().sort((a, b) => a.period_start - b.period_start);
      assert.deepEqual(rows.map((row) => row.amount), [GROWTH, GROWTH, SCALE, SCALE, SCALE_ANNUAL],
        'two months of Growth, two of Scale, then Scale for a year — charged once, not month after month');
      let cursor = START;
      for (const row of rows) {
        assert.equal(row.period_start, cursor, 'no gap between periods');
        cursor = row.period_end;
      }
      assert.equal(cursor, UTC(2027, 5, 1));
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 3. The lifecycle under the time machine
 * ========================================================================== */

describe('the subscription lifecycle', () => {
  let ws: Workspace;
  const START = UTC(2026, 6, 1);
  before(async () => { ws = await workspace(START); });
  after(() => ws.close());

  test('cancel at period end fires exactly once, and nothing bills afterwards', async () => {
    const customer = await ws.customer('Cobaltline Robotics');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }], billing_cycle_anchor: START,
    });
    const endsAt = sub.current_period_end;

    const scheduled = await ws.ok('POST', `/v1/subscriptions/${sub.id}/cancel`, {
      at_period_end: true, cancellation_reason: 'too_expensive', comment: 'Budget freeze until Q1.',
    });
    assert.equal(scheduled.status, 'active', 'it keeps running until the period it has paid for is over');
    assert.equal(scheduled.cancel_at_period_end, true);

    await ws.travelTo(START + 365 * DAY);

    const final: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(final.status, 'canceled');
    assert.equal(final.ended_at, endsAt, 'it ended the instant the paid period ran out');
    assert.equal(final.cancellation_reason, 'too_expensive');

    const canceled = ws.app.ctx.events.list(ORG, { types: ['subscription.canceled'], objectId: sub.id, limit: 100 });
    assert.equal(canceled.length, 1, 'a year of renewals must not cancel it a second time');
    const renewals = ws.app.ctx.events.list(ORG, { types: ['subscription.renewed'], objectId: sub.id, limit: 100 });
    assert.equal(renewals.length, 0, 'it never renewed');

    const pendingJobs = ws.app.db.count(
      `SELECT COUNT(*) FROM jobs WHERE status = 'pending' AND idem_key = ?`, `billing.renew:${sub.id}`,
    );
    assert.equal(pendingJobs, 0, 'no renewal is left waiting');

    const periods = await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods`);
    assert.equal(periods.data.length, 1, 'only the period it actually held was ever recognised');
  });

  test('a trial converts on its end date and starts the first paid period there', async () => {
    const customer = await ws.customer('Sableworks');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'starter_monthly' }],
      trial_period_days: 14,
      default_payment_method: 'pm_card_sableworks',
    });
    assert.equal(sub.status, 'trialing');
    assert.equal(sub.trial_end, ws.now() + 14 * DAY);
    assert.equal(sub.current_period_end, sub.trial_end, 'the trial is the current period');
    assert.equal(sub.billing_cycle_anchor, sub.trial_end, 'the cycle is anchored to the day the trial ends');

    const trialPeriod = await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods`);
    assert.equal(trialPeriod.data[0].status, 'trial');
    assert.equal(trialPeriod.data[0].amount, 0, 'a trial recognises no revenue');

    await ws.travelTo((sub.trial_end as number) + 60_000);
    const converted: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(converted.status, 'active');
    assert.equal(converted.current_period_start, sub.trial_end);

    const ended = ws.app.ctx.events.list(ORG, { types: ['subscription.trial_ended'], objectId: sub.id, limit: 10 });
    assert.equal(ended.length, 1);
    const billed = (await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods`)).data
      .find((p: { status: string }) => p.status === 'billed');
    assert.equal(billed.amount, STARTER);
  });

  test('a trial with nothing to charge follows its end_behavior', async () => {
    const customer = await ws.customer('No Card Fabrication');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'starter_monthly' }],
      trial_period_days: 7,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    });
    await ws.travelTo((sub.trial_end as number) + 60_000);
    const done: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(done.status, 'canceled');
    assert.equal(done.cancellation_reason, 'trial_ended_without_payment_method');
  });

  test('pausing keeps the cycle running, and a resume date brings it back on its own', async () => {
    const customer = await ws.customer('Vandoorn Assembly');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    const resumesAt = ws.now() + 40 * DAY;
    const paused = await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, {
      behavior: 'mark_uncollectible', resumes_at: resumesAt,
    });
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pause_collection.behavior, 'mark_uncollectible');

    await ws.travelTo(sub.current_period_end + 60_000);
    const cycling: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(cycling.status, 'paused', 'pausing collection does not pause the calendar');
    assert.ok(cycling.current_period_start >= sub.current_period_end);
    const pausedPeriod = (await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods`)).data
      .find((p: { period_start: number }) => p.period_start === cycling.current_period_start);
    assert.equal(pausedPeriod.status, 'paused', 'the ledger records that nothing was collected');

    await ws.travelTo(resumesAt + 60_000);
    const resumed: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.pause_collection, null);
  });

  test('an immediate cancellation can hand back the unused remainder as credit', async () => {
    const customer = await ws.customer('Helvetia Fine Mechanics');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'scale_monthly' }],
    });
    const period = sub.current_period_end - sub.current_period_start;
    const at = ws.now();
    const canceled = await ws.ok('POST', `/v1/subscriptions/${sub.id}/cancel`, {
      prorate: true, cancellation_reason: 'went_out_of_business',
    });
    assert.equal(canceled.status, 'canceled');
    const unused = -Math.round(SCALE * (sub.current_period_end - at) / period);

    // The remainder goes back through a bill, not around one: a final invoice
    // carrying the credit line, which is what lets a taxed account get the tax
    // back with it. The bill itself can never go below zero, so what it is
    // worth lands on the balance.
    const final = (await allInvoices(ws, `&subscription=${sub.id}`))
      .find((invoice) => invoice.billing_reason === 'subscription_update');
    assert.ok(final, 'cancelling with prorate raises the final bill');
    assert.equal(final.subtotal, unused);
    assert.equal(final.lines.length, 1);
    assert.equal(final.lines[0].kind, 'unused_time');
    assert.equal(final.total, 0, 'an invoice is never negative');
    assert.equal(final.balance_applied, -unused);

    const account = await ws.ok('GET', `/v1/customers/${customer.id}`);
    assert.equal(account.balance, unused);
    const ledger = await ws.ok('GET', `/v1/customers/${customer.id}/balance_transactions`);
    assert.equal(ledger.data[0].type, 'applied_to_invoice');
    assert.equal(ledger.data[0].invoice, final.id);
    assert.match(ledger.data[0].description, /placed on the account/);
  });

  test('an incomplete subscription expires if the first payment never arrives', async () => {
    const customer = await ws.customer('Never Paid Industries');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'starter_monthly' }], payment_behavior: 'default_incomplete',
    });
    assert.equal(sub.status, 'incomplete');
    await ws.travelTo(ws.now() + 2 * DAY);
    const expired: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(expired.status, 'incomplete_expired');
    await ws.fail('PATCH', `/v1/subscriptions/${sub.id}`, { metadata: { note: 'too late' } }, 409, 'subscription_ended');
  });

  test('every renewal hands invoicing a complete brief', async () => {
    const customer = await ws.customer('Handoff Heavy Industries');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }, { price: 'telemetry_events_monthly' }],
      collection_method: 'send_invoice',
      days_until_due: 45,
    });
    await ws.travelTo(sub.current_period_end + 60_000);

    const requests = ws.app.ctx.events.list(ORG, { types: ['subscription.invoice_due'], objectId: sub.id, limit: 10 });
    assert.equal(requests.length, 2, 'one for the first period, one for the renewal');
    const renewal = requests[0].data as {
      reason: string; period: { start: number; end: number }; arrears_period: { start: number; end: number };
      lines: { metered: boolean; amount: number | null }[]; subtotal: number; days_until_due: number;
      collection_method: string; customer_balance: number;
    };
    assert.equal(renewal.reason, 'subscription_cycle');
    assert.equal(renewal.period.start, sub.current_period_end, 'the period being billed in advance');
    assert.deepEqual(renewal.arrears_period, { start: sub.current_period_start, end: sub.current_period_end },
      'and the period that just closed, for metered usage billed in arrears');
    assert.equal(renewal.subtotal, GROWTH);
    assert.equal(renewal.lines.length, 2);
    assert.equal(renewal.lines.find((line) => line.metered)?.amount, null,
      'a metered line has no amount until the usage is known');
    assert.equal(renewal.collection_method, 'send_invoice');
    assert.equal(renewal.days_until_due, 45);
    assert.equal(renewal.customer_balance, 0);
  });

  test('over a year, what the ledger recognises is exactly what invoicing was asked for', async () => {
    // The one invariant that catches every way a cycle can go wrong: a period
    // charged twice, a period never charged, a stub charged as a whole month,
    // an annual price billed monthly. Three shapes of cycle, four hundred days.
    const shapes: { label: string; at: number; body: Record<string, unknown> }[] = [
      { label: 'anchored on the 31st', at: UTC(2026, 1, 31), body: { items: [{ price: 'growth_monthly' }] } },
      { label: 'billing on the 15th from the 1st', at: UTC(2026, 1, 1), body: { items: [{ price: 'growth_monthly' }], billing_cycle_anchor_day: 15 } },
      {
        label: 'a trial that ends off the billing day',
        at: UTC(2026, 1, 1),
        body: {
          items: [{ price: 'growth_monthly' }], trial_period_days: 14,
          billing_cycle_anchor_day: 1, default_payment_method: 'pm_card_reconciled',
        },
      },
    ];

    for (const shape of shapes) {
      const own = await workspace(shape.at);
      try {
        const sub: Subscription = await own.ok('POST', '/v1/subscriptions', {
          customer: (await own.customer('Reconciled')).id, ...shape.body,
        });
        const travelled = await own.travelTo(shape.at + 400 * DAY);
        assert.equal(travelled.failed, 0, `${shape.label}: every job ran`);

        const periods = await own.ok('GET', `/v1/subscriptions/${sub.id}/periods?limit=500`);
        const rows = (periods.data as { period_start: number; period_end: number; amount: number }[])
          .slice().sort((a, b) => a.period_start - b.period_start);
        let cursor = rows[0].period_start;
        for (const row of rows) {
          assert.equal(row.period_start, cursor, `${shape.label}: no gap and no overlap between periods`);
          cursor = row.period_end;
        }

        const due = own.app.ctx.events.list(ORG, { types: ['subscription.invoice_due'], objectId: sub.id, limit: 500 });
        const keys = due.map((event) => {
          const data = event.data as { reason: string; period: { start: number } };
          return `${data.reason}|${data.period.start}`;
        });
        assert.equal(new Set(keys).size, keys.length, `${shape.label}: nothing was invoiced twice`);

        const invoiced = due.reduce((total, event) => total + (event.data as { subtotal: number }).subtotal, 0);
        const recognised = rows.reduce((total, row) => total + row.amount, 0);
        assert.equal(invoiced, recognised,
          `${shape.label}: the periods on the books are the periods invoicing was handed`);
      } finally { own.close(); }
    }
  });

  test('resuming can restart the cycle from today instead of picking up the old one', async () => {
    const customer = await ws.customer('Fresh Start Fabrication');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, { behavior: 'void' });
    const resumed = await ws.ok('POST', `/v1/subscriptions/${sub.id}/resume`, { billing_cycle_anchor: 'now' });
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.current_period_start, ws.now());
    assert.equal(resumed.billing_cycle_anchor, ws.now());
  });

  test('the status machine refuses moves that make no sense, and says what it would accept', async () => {
    const customer = await ws.customer('Status Machine Ltd');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'starter_monthly' }],
    });
    await ws.fail('POST', `/v1/subscriptions/${sub.id}/resume`, {}, 409, 'subscription_not_paused');
    await ws.ok('DELETE', `/v1/subscriptions/${sub.id}`);
    const error = await ws.fail('POST', `/v1/subscriptions/${sub.id}/cancel`, {}, 409, 'subscription_ended');
    assert.match(error.message, /already canceled/);
    await ws.fail('DELETE', `/v1/customers/${customer.id}`, {}, 200);
  });
});

/* ========================================================================== *
 * 4. Subscription schedules
 * ========================================================================== */

describe('subscription schedules', () => {
  let ws: Workspace;
  const START = UTC(2026, 1, 1);
  before(async () => { ws = await workspace(START); });
  after(() => ws.close());

  test('a three-phase ramp advances in order across a year of the time machine', async () => {
    // "Three months at half price, then list, then list plus the seats they
    // committed to" — expressed as three phases on real prices.
    const growth = await ws.ok('GET', '/v1/prices?lookup_key=growth_monthly');
    const intro = await ws.ok('POST', '/v1/prices', {
      product: growth.data[0].product,
      currency: 'usd',
      model: 'flat',
      unit_amount: GROWTH / 2,
      nickname: 'Growth — 3-month introductory rate',
      lookup_key: 'growth_intro_3mo',
      recurring: { interval: 'month' },
    });

    const customer = await ws.customer('Ramp Deal Robotics');
    const schedule = await ws.ok('POST', '/v1/subscription-schedules', {
      customer: customer.id,
      start_date: START,
      end_behavior: 'release',
      phases: [
        { items: [{ price: intro.id }], iterations: 3, proration_behavior: 'none', description: 'Introductory rate' },
        { items: [{ price: 'growth_monthly' }], iterations: 6, description: 'List price' },
        { items: [{ price: 'growth_monthly' }, { price: 'growth_seat_monthly', quantity: 12 }], iterations: 3, description: 'Committed seats' },
      ],
    });

    assert.equal(schedule.status, 'active');
    assert.equal(schedule.current_phase, 0);
    assert.equal(schedule.phases[0].start_date, START);
    assert.equal(schedule.phases[0].end_date, UTC(2026, 4, 1), 'three monthly intervals');
    assert.equal(schedule.phases[1].start_date, UTC(2026, 4, 1));
    assert.equal(schedule.phases[1].end_date, UTC(2026, 10, 1));
    assert.equal(schedule.phases[2].end_date, UTC(2027, 1, 1));
    assert.ok(schedule.subscription, 'a schedule that starts today has a live subscription');

    const subId = schedule.subscription as string;

    await ws.travelTo(UTC(2026, 4, 1) + 60_000);
    let now = await ws.ok('GET', `/v1/subscription-schedules/${schedule.id}`);
    assert.equal(now.current_phase, 1);
    let sub: Subscription = await ws.ok('GET', `/v1/subscriptions/${subId}`);
    assert.equal(sub.items.length, 1);
    assert.equal(sub.items[0].price, growth.data[0].id, 'phase two moved it onto the list price');

    await ws.travelTo(UTC(2026, 10, 1) + 60_000);
    now = await ws.ok('GET', `/v1/subscription-schedules/${schedule.id}`);
    assert.equal(now.current_phase, 2);
    sub = await ws.ok('GET', `/v1/subscriptions/${subId}`);
    assert.equal(sub.items.length, 2);
    assert.equal(sub.items[1].quantity, 12);

    await ws.travelTo(UTC(2027, 1, 1) + 60_000);
    now = await ws.ok('GET', `/v1/subscription-schedules/${schedule.id}`);
    assert.equal(now.status, 'completed');
    sub = await ws.ok('GET', `/v1/subscriptions/${subId}`);
    assert.equal(sub.status, 'active', 'end_behavior=release leaves the subscription running');
    assert.equal(sub.schedule, null);

    const phases = ws.app.ctx.events.list(ORG, { types: ['subscription_schedule.phase_started'], objectId: schedule.id, limit: 20 });
    assert.deepEqual(phases.map((e) => (e.data as { phase: number }).phase).reverse(), [0, 1, 2],
      'every phase started, in order, exactly once');

    // Twelve months, each priced by the phase that covered it.
    const periods = (await ws.ok('GET', `/v1/subscriptions/${subId}/periods`)).data as { period_start: number; amount: number }[];
    const byStart = new Map(periods.map((p) => [p.period_start, p.amount]));
    assert.equal(byStart.get(UTC(2026, 1, 1)), GROWTH / 2, 'the introductory rate');
    assert.equal(byStart.get(UTC(2026, 3, 1)), GROWTH / 2);
    assert.equal(byStart.get(UTC(2026, 4, 1)), GROWTH, 'list price the month phase two begins');
    assert.equal(byStart.get(UTC(2026, 9, 1)), GROWTH);
    assert.equal(byStart.get(UTC(2026, 10, 1)), GROWTH + 12 * GROWTH_SEAT, 'phase three adds the seats');
    assert.equal(byStart.get(UTC(2026, 12, 1)), GROWTH + 12 * GROWTH_SEAT);
    assert.equal(periods.filter((p) => p.period_start < UTC(2027, 1, 1)).length, 12, 'twelve months under the schedule');
    assert.equal(byStart.get(UTC(2027, 1, 1)), GROWTH + 12 * GROWTH_SEAT,
      'released, it carries straight on at the price the last phase left it on');

    // A phase change that lands on a period boundary is a clean swap: there is
    // no part-period to credit, so there are no proration lines at all.
    const pending = await ws.ok('GET', `/v1/customers/${customer.id}/pending_items`);
    assert.equal(pending.data.length, 0);
  });

  test('a schedule that cancels at the end takes the subscription with it', async () => {
    const customer = await ws.customer('Fixed Term Foundry');
    const schedule = await ws.ok('POST', '/v1/subscription-schedules', {
      customer: customer.id,
      start_date: ws.now(),
      end_behavior: 'cancel',
      phases: [{ items: [{ price: 'starter_monthly' }], iterations: 2 }],
    });
    const subId = schedule.subscription as string;
    await ws.travelTo(schedule.phases[0].end_date + 60_000);
    const done = await ws.ok('GET', `/v1/subscription-schedules/${schedule.id}`);
    assert.equal(done.status, 'canceled');
    const sub: Subscription = await ws.ok('GET', `/v1/subscriptions/${subId}`);
    assert.equal(sub.status, 'canceled');
    assert.equal(sub.cancellation_reason, 'schedule_ended');
  });

  test('releasing a schedule leaves the subscription exactly as it is', async () => {
    const customer = await ws.customer('Released Metals');
    const schedule = await ws.ok('POST', '/v1/subscription-schedules', {
      customer: customer.id,
      start_date: ws.now(),
      phases: [
        { items: [{ price: 'starter_monthly' }], iterations: 1 },
        { items: [{ price: 'growth_monthly' }], iterations: 1 },
      ],
    });
    const released = await ws.ok('POST', `/v1/subscription-schedules/${schedule.id}/release`);
    assert.equal(released.status, 'released');
    await ws.travelTo(schedule.phases[0].end_date + 60_000);
    const sub: Subscription = await ws.ok('GET', `/v1/subscriptions/${schedule.subscription}`);
    assert.equal(sub.status, 'active');
    assert.equal(sub.schedule, null);
    assert.equal(sub.items[0].price, await priceIdOf(ws, 'starter_monthly'), 'phase two never ran');
  });

  test('a phase that cannot say how long it lasts is rejected before anything is written', async () => {
    const customer = await ws.customer('Vague Terms');
    await ws.fail('POST', '/v1/subscription-schedules', {
      customer: customer.id,
      phases: [{ items: [{ price: 'starter_monthly' }] }, { items: [{ price: 'growth_monthly' }] }],
    }, 400, 'phase_length_required');
  });
});

/* ========================================================================== *
 * 5. Customers
 * ========================================================================== */

describe('customers', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 5, 12)); });
  after(() => ws.close());

  test('currency is fixed once the account has been billed', async () => {
    const customer = await ws.customer('Rheinwerk Antriebstechnik', { currency: 'eur' });
    const moved = await ws.ok('PATCH', `/v1/customers/${customer.id}`, { currency: 'gbp' });
    assert.equal(moved.currency, 'gbp', 'before anything is billed the currency is still a choice');

    await ws.ok('POST', '/v1/subscriptions', { customer: customer.id, items: [{ price: 'growth_monthly' }] });
    const error = await ws.fail('PATCH', `/v1/customers/${customer.id}`, { currency: 'usd' }, 409, 'customer_currency_locked');
    assert.match(error.message, /GBP/);

    await ws.fail('POST', '/v1/subscriptions',
      { customer: customer.id, items: [{ price: 'growth_monthly' }], currency: 'usd' }, 400, 'currency_mismatch');
  });

  test('one CRM company has exactly one billing customer', async () => {
    const first = await ws.customer('Meridian Forge Billing', { crm_record_id: 'cmp_test_01' });
    const error = await ws.fail('POST', '/v1/customers',
      { name: 'Meridian Forge Billing (duplicate)', crm_record_id: 'cmp_test_01' }, 409, 'crm_record_already_billed');
    assert.match(error.message, new RegExp(first.id));
  });

  test('the summary is one screen with everything a support agent needs', async () => {
    const customer = await ws.customer('Summary Systems');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }, { price: 'growth_seat_monthly', quantity: 6 }, { price: 'telemetry_events_monthly' }],
      collection_method: 'send_invoice',
      days_until_due: 30,
    });
    await ws.ok('POST', `/v1/customers/${customer.id}/balance_transactions`, {
      amount: -5_000, description: 'Goodwill credit for the 4 May ingestion delay.',
    });

    const summary = await ws.ok('GET', `/v1/customers/${customer.id}/summary`);
    assert.equal(summary.object, 'customer_summary');
    assert.equal(summary.subscriptions.live, 1);
    assert.equal(summary.mrr, GROWTH + 6 * GROWTH_SEAT);
    assert.equal(summary.arr, summary.mrr * 12);
    assert.equal(summary.balance.amount, -5_000);
    assert.equal(summary.balance.credit, true);
    assert.equal(summary.balance.transactions.length, 1);
    assert.equal(summary.lifetime_value.amount, GROWTH + 6 * GROWTH_SEAT, 'the first period is already invoiced');
    assert.equal(summary.lifetime_value.source, 'invoicing', 'lifetime value comes off real invoices');
    assert.equal(summary.open_invoices.source, 'invoicing');
    assert.equal(summary.open_invoices.data.length, 1, 'the first period was billed the day it started');
    assert.equal(summary.open_invoices.total, GROWTH + 6 * GROWTH_SEAT);
    assert.equal(summary.open_invoices.data[0].due_date, sub.current_period_start + 30 * DAY, 'net 30, as the account asked for');
    assert.equal(summary.next_invoice.subscription, sub.id);
    assert.equal(summary.next_invoice.date, sub.current_period_end);
    assert.equal(summary.next_invoice.subtotal, GROWTH + 6 * GROWTH_SEAT);
    assert.equal(summary.next_invoice.balance_applied, -5_000);
    assert.equal(summary.next_invoice.estimated_total, GROWTH + 6 * GROWTH_SEAT - 5_000);
    assert.match(summary.next_invoice.note, /metered usage/i);
    assert.match(summary.headline, /1 live subscription/);
  });

  test('a customer with live subscriptions cannot be deleted out from under them', async () => {
    const customer = await ws.customer('Still Subscribed');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'starter_monthly' }],
    });
    await ws.fail('DELETE', `/v1/customers/${customer.id}`, {}, 409, 'customer_has_active_subscriptions');
    await ws.ok('DELETE', `/v1/subscriptions/${sub.id}`);
    const deleted = await ws.ok('DELETE', `/v1/customers/${customer.id}`);
    assert.equal(deleted.deleted, true);
  });

  test('search finds accounts by name, email and whether they still buy anything', async () => {
    const customer = await ws.customer('Findable Fabrication', { email: 'ap@findable.example' });
    await ws.ok('POST', '/v1/subscriptions', { customer: customer.id, items: [{ price: 'starter_monthly' }] });

    const byName = await ws.ok('GET', '/v1/customers?query=Findable');
    assert.ok(byName.data.some((c: { id: string }) => c.id === customer.id));
    const byEmail = await ws.ok('GET', '/v1/customers?email=ap@findable.example');
    assert.equal(byEmail.data.length, 1);
    const live = await ws.ok('GET', '/v1/customers?has_subscription=true&limit=200');
    assert.ok(live.data.some((c: { id: string }) => c.id === customer.id));
  });
});

/* ========================================================================== *
 * 6. Validation
 * ========================================================================== */

describe('what billing refuses to do', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 8, 4)); });
  after(() => ws.close());

  test('every item on a subscription must share one billing interval', async () => {
    const customer = await ws.customer('Mixed Intervals');
    const error = await ws.fail('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_annual' }, { price: 'growth_seat_monthly', quantity: 3 }],
    }, 400, 'subscription_interval_mismatch');
    assert.match(error.message, /every year|every month/);

    // And the rule holds on the way through, not only at the door: a change
    // that would leave one subscription straddling two cadences is refused,
    // and a change that moves every item onto one new cadence moves the
    // subscription with it rather than running an annual price monthly.
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    await ws.fail('PATCH', `/v1/subscriptions/${sub.id}`,
      { items: [{ price: 'growth_seat_annual', quantity: 3 }] }, 400, 'subscription_interval_mismatch');

    const moved = await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: sub.items[0].id, price: 'growth_annual' }],
    });
    assert.equal(moved.interval, 'year', 'the subscription bills on the cadence its items bill on');
    assert.equal(moved.current_period_end, moved.current_period_start + 365 * DAY);
  });


  test('a flat plan fee has no quantity — the engine bills it the same at any number', async () => {
    const customer = await ws.customer('Five Growths');
    // Carrying a quantity would let the two halves of a change disagree —
    // proration crediting a whole plan back while the recurring line goes on
    // charging it — so billing refuses one rather than discarding it.
    await ws.fail('POST', '/v1/subscriptions',
      { customer: customer.id, items: [{ price: 'growth_monthly', quantity: 5 }] }, 400, 'flat_price_quantity');

    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    // The bill is the proof: one flat fee, at the price, with no quantity in it.
    const first = (await allInvoices(ws, `&subscription=${sub.id}`))[0];
    assert.equal(first.subtotal, GROWTH);
    assert.equal(first.lines[0].quantity, 1);
    const error = await ws.fail('PATCH', `/v1/subscriptions/${sub.id}`,
      { items: [{ id: sub.items[0].id, quantity: 0 }], proration_behavior: 'always_invoice' },
      400, 'flat_price_quantity');
    assert.match(error.message, /always 1/);

    // Nothing was credited for the change that was refused.
    const account = await ws.ok('GET', `/v1/customers/${customer.id}`);
    assert.equal(account.balance, 0);
    const still: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(still.items[0].quantity, 1);

    await ws.fail('POST', '/v1/subscription-schedules', {
      customer: customer.id,
      phases: [{ items: [{ price: 'growth_monthly', quantity: 2 }], iterations: 1 }],
    }, 400, 'flat_price_quantity');
  });

  test('dropping a per-unit line to zero credits exactly what it stops charging', async () => {
    const customer = await ws.customer('Seats Returned');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }, { price: 'growth_seat_monthly', quantity: 4 }],
      billing_cycle_anchor: UTC(2026, 8, 1),
    });
    const half = UTC(2026, 8, 16, 12);
    const preview: ChangePreview = await ws.ok('POST', `/v1/subscriptions/${sub.id}/preview`, {
      items: [{ id: sub.items[1].id, quantity: 0 }],
      proration_date: half,
    });
    assert.equal(preview.lines.length, 1, 'a line worth nothing is not a line');
    assert.equal(preview.lines[0].amount, -(4 * GROWTH_SEAT) / 2, 'half of four seats back');
    assert.equal(preview.next_invoice.subtotal, GROWTH, 'and the next invoice is the plan fee alone');
    assert.equal(preview.mrr_after, GROWTH, 'the seats leave MRR with the charge');

    await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: sub.items[1].id, quantity: 0 }], proration_date: half,
    });
    const after: Subscription & { recurring_subtotal: number; items: { amount: number }[] } =
      await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(after.items[1].amount, 0, 'the credit and the charge tell the same story');
    assert.equal(after.recurring_subtotal, GROWTH);
    const account = await ws.ok('GET', `/v1/customers/${customer.id}`);
    assert.equal(account.balance, 0, 'the credit is a line waiting for a bill, not a balance movement');
    const waiting = await ws.ok('GET', `/v1/customers/${customer.id}/pending_items`);
    assert.equal(waiting.data.length, 1);
    assert.equal(waiting.data[0].amount, -(4 * GROWTH_SEAT) / 2);
  });

  test('a one-time price belongs on an invoice, not a subscription', async () => {
    const customer = await ws.customer('One Time Only');
    await ws.fail('POST', '/v1/subscriptions',
      { customer: customer.id, items: [{ price: 'onboarding_fee' }] }, 400, 'one_time_price_on_subscription');
  });

  test('the same price cannot appear twice', async () => {
    const customer = await ws.customer('Double Booked');
    await ws.fail('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }, { price: 'growth_monthly' }],
    }, 400, 'duplicate_subscription_item');
  });

  test('a negotiated price has to arrive with its negotiated number', async () => {
    const customer = await ws.customer('Enterprise Deal');
    await ws.fail('POST', '/v1/subscriptions',
      { customer: customer.id, items: [{ price: 'enterprise_annual' }] }, 400, 'custom_amount_required');

    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'enterprise_annual', custom_unit_amount: 14_400_000 }],
    });
    assert.equal(sub.items[0].custom_unit_amount, 14_400_000);
    const periods = await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods`);
    assert.equal(periods.data[0].amount, 14_400_000, 'the agreed amount is what is recognised');
    const detail = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(detail.mrr, 1_200_000, 'an annual commitment normalises to a twelfth per month');

    await ws.fail('POST', '/v1/subscriptions', {
      customer: (await ws.customer('Published Price')).id,
      items: [{ price: 'growth_monthly', custom_unit_amount: 100 }],
    }, 400, 'custom_amount_not_allowed');
  });

  test('a subscription cannot be emptied — that is a cancellation', async () => {
    const customer = await ws.customer('Empty Set');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'starter_monthly' }],
    });
    await ws.fail('PATCH', `/v1/subscriptions/${sub.id}`,
      { items: [{ id: sub.items[0].id, deleted: true }] }, 400, 'subscription_requires_items');
  });

  test('naming a price already on the subscription updates it instead of adding a second line', async () => {
    const customer = await ws.customer('No Accidental Duplicates');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }, { price: 'growth_seat_monthly', quantity: 4 }],
    });
    const updated = await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ price: 'growth_seat_monthly', quantity: 9 }],
    });
    assert.equal(updated.items.length, 2);
    assert.equal(updated.items[1].id, sub.items[1].id);
    assert.equal(updated.items[1].quantity, 9);
  });

  test('a proration date outside the period is refused, not quietly clamped', async () => {
    const customer = await ws.customer('Time Traveller');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    const error = await ws.fail('POST', `/v1/subscriptions/${sub.id}/preview`, {
      items: [{ id: sub.items[0].id, price: 'scale_monthly' }],
      proration_date: sub.current_period_end + 10 * DAY,
    }, 400, 'proration_date_out_of_range');
    assert.match(error.message, /current period/);
  });

  test('a trial cannot be bolted onto a subscription that is already running', async () => {
    const customer = await ws.customer('Retroactive Trial');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    await ws.fail('PATCH', `/v1/subscriptions/${sub.id}`,
      { trial_end: ws.now() + 30 * DAY }, 409, 'subscription_not_trialing');
  });

  test('a subscription cannot be backdated to a day that has not happened yet', async () => {
    const customer = await ws.customer('Forward Dated');
    const error = await ws.fail('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'predictive_monthly', quantity: 10 }],
      backdate_start_date: UTC(2027, 1, 1),
    }, 400, 'backdate_start_date_in_future');
    assert.equal(error.param, 'backdate_start_date');
    assert.match(error.message, /subscription schedule/, 'and it says what to use instead');

    // Nothing was created, so nothing counts in MRR and nothing was billed for
    // a period the customer has not entered.
    assert.equal((await ws.ok('GET', `/v1/subscriptions?customer=${customer.id}&status=all`)).data.length, 0);
    assert.equal((await ws.ok('GET', `/v1/invoices?customer=${customer.id}`)).data.length, 0);

    // Backdating to a day that *has* happened is untouched, and — the reason
    // the guard matters — now falls inside the period, so a change today is
    // priced against the time actually left rather than a whole future month.
    const started = UTC(2026, 7, 20);
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'predictive_monthly', quantity: 10 }],
      backdate_start_date: started,
      billing_cycle_anchor: started,
    });
    assert.equal(sub.start_date, started);
    assert.ok(sub.current_period_start <= ws.now() && ws.now() < sub.current_period_end,
      'today is inside the period the subscription is billing for');

    const preview: ChangePreview = await ws.ok('POST', `/v1/subscriptions/${sub.id}/preview`, {
      items: [{ id: sub.items[0].id, quantity: 20 }],
    });
    const whole = sub.current_period_end - sub.current_period_start;
    const left = sub.current_period_end - ws.now();
    const credit = lineFor(preview, 'unused_time', sub.items[0].price);
    assert.ok(credit, 'the days already used are not credited back');
    assert.equal(credit.proration.numerator, left);
    assert.equal(credit.proration.denominator, whole);
    assert.ok(-credit.amount < preview.next_invoice.subtotal, 'only part of the period comes back');
  });

  test('a cancellation cannot be scheduled for a date that has already passed', async () => {
    const customer = await ws.customer('Backwards Cancellation');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });

    const patched = await ws.fail('PATCH', `/v1/subscriptions/${sub.id}`,
      { cancel_at: UTC(2020, 1, 1) }, 400, 'cancel_at_in_past');
    assert.equal(patched.param, 'cancel_at');
    assert.match(patched.message, /DELETE \/v1\/subscriptions/, 'and it names the way to end it now');
    await ws.fail('POST', `/v1/subscriptions/${sub.id}/cancel`,
      { cancel_at: UTC(2020, 1, 1) }, 400, 'cancel_at_in_past');

    const untouched: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(untouched.cancel_at, null, 'nothing was stored');
    assert.equal(untouched.status, 'active');
    assert.equal(untouched.ended_at, null);

    // A future date is what the field is for, and it is accepted.
    const scheduled = await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, { cancel_at: ws.now() + 45 * DAY });
    assert.equal(scheduled.cancel_at, ws.now() + 45 * DAY);
  });

  test('an unknown price is a 404 that names what was asked for', async () => {
    const customer = await ws.customer('Typo Ltd');
    const error = await ws.fail('POST', '/v1/subscriptions',
      { customer: customer.id, items: [{ price: 'growth_montly' }] }, 404, 'resource_missing');
    assert.match(error.message, /growth_montly/);
  });
});

/* ========================================================================== *
 * 6b. Invoices — where every number in this module ends up
 * ========================================================================== */

describe('invoices', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 9, 1)); });
  after(() => ws.close());

  test('an invoice is raised for the period a subscription enters, and its lines add up', async () => {
    const customer = await ws.customer('Ashcroft Pressings');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }, { price: 'growth_seat_monthly', quantity: 4 }, { price: 'telemetry_events_monthly' }],
      collection_method: 'send_invoice',
      days_until_due: 30,
    });

    const invoices = await allInvoices(ws, `&subscription=${sub.id}`);
    assert.equal(invoices.length, 1, 'entering a period raises exactly one invoice for it');
    const invoice = invoices[0];
    assert.equal(invoice.status, 'open');
    assert.equal(invoice.billing_reason, 'subscription_create');
    assert.deepEqual(invoice.period, { start: sub.current_period_start, end: sub.current_period_end });
    assert.equal(invoice.due_date, sub.current_period_start + 30 * DAY, 'net 30 runs from the billing date');
    assert.match(invoice.number, /^NR-\d{6}$/, 'a human-readable, gapless workspace sequence');

    // The identity this whole module exists to hold.
    assert.equal(sumLines(invoice), invoice.subtotal);
    assert.equal(invoice.subtotal + invoice.balance_applied, invoice.total);
    assert.equal(invoice.total, GROWTH + 4 * GROWTH_SEAT, 'the plan fee and the seats, and nothing else');
    assert.equal(invoice.amount_due, invoice.total);

    // A metered item is not a line: its quantity is not known until the period
    // closes, so it bills in arrears and never in advance.
    assert.equal(invoice.lines.length, 2);
    assert.ok(invoice.lines.every((line) => line.kind === 'recurring'));
    for (const line of invoice.lines) {
      assert.equal(line.breakdown.reduce((total, row) => total + row.amount, 0), line.amount,
        'the breakdown rows still add up to the line');
      assert.match(line.explanation, /billed in advance/);
    }

    // And the period ledger and the invoice point at each other.
    const periods = await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods`);
    assert.equal(periods.data[0].invoice, invoice.id);
    assert.equal(periods.data[0].amount, invoice.subtotal);
  });

  test('the previewed invoice is the invoice, line for line', async () => {
    const customer = await ws.customer('Preview Equals Charge');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }, { price: 'growth_seat_monthly', quantity: 4 }],
    });
    // A mid-cycle expansion, so the next invoice has to carry prorations too.
    await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: sub.items[1].id, quantity: 9 }], proration_date: midpointOf(sub),
    });

    const preview: Invoice = await ws.ok('POST', '/v1/invoices/create_preview', { subscription: sub.id });
    assert.equal(sumLines(preview), preview.subtotal);
    assert.equal(preview.subtotal + preview.balance_applied, preview.total);
    assert.equal(preview.period.start, sub.current_period_end, 'the next bill covers the period after this one');

    await ws.travelTo(sub.current_period_end + 60_000);
    const issued = (await allInvoices(ws, `&subscription=${sub.id}`))
      .find((invoice) => invoice.billing_reason === 'subscription_cycle');
    assert.ok(issued, 'the renewal raised the invoice the preview described');
    assert.equal(issued.subtotal, preview.subtotal);
    assert.equal(issued.total, preview.total);
    assert.equal(issued.balance_applied, preview.balance_applied);
    assert.deepEqual(issued.period, preview.period);
    assert.deepEqual(issued.lines.map(shapeOf), preview.lines.map(shapeOf));

    // Nothing is left waiting: the prorations the preview showed were claimed
    // by exactly this invoice, and cannot be claimed again.
    const waiting = await ws.ok('GET', `/v1/customers/${customer.id}/pending_items`);
    assert.equal(waiting.data.length, 0);
    const claimed = issued.lines.filter((line) => line.proration);
    assert.equal(claimed.length, 2, 'the unused half and the remaining half');
    assert.ok(claimed.every((line) => line.source.type === 'pending_item' && line.source.id));
  });

  test('the stub period after a trial is previewed, and billed, as a stub', async () => {
    // Its own workspace pinned to midnight, so the fraction in the assertion is
    // whole days and a reader can check the number by hand.
    const fixed = await workspace(UTC(2026, 9, 1));
    try {
      const customer = await fixed.customer('Trial To Billing Day');
      const sub: Subscription = await fixed.ok('POST', '/v1/subscriptions', {
        customer: customer.id,
        items: [{ price: 'growth_monthly' }],
        trial_period_days: 14,
        billing_cycle_anchor_day: 20,
      });
      assert.equal(sub.status, 'trialing');
      assert.equal(sub.trial_end, UTC(2026, 9, 15));
      assert.equal(sub.current_period_end, sub.trial_end, 'the trial runs to the day it was promised');
      assert.equal(sub.billing_cycle_anchor, UTC(2026, 9, 20));

      // The free time ends before the account's billing day, so the first paid
      // period is the five days in between — priced as five days of the month
      // that ends on the billing day, which is 20 Aug to 20 Sep: 31 of them.
      const preview: Invoice = await fixed.ok('POST', '/v1/invoices/create_preview', { subscription: sub.id });
      assert.deepEqual(preview.period, { start: UTC(2026, 9, 15), end: UTC(2026, 9, 20) });
      assert.equal(preview.subtotal, Math.round((GROWTH * 5) / 31), 'five thirty-firsts of the plan fee');
      assert.equal(sumLines(preview), preview.subtotal);

      await fixed.travelTo(UTC(2026, 9, 15) + 60_000);
      const first = (await allInvoices(fixed, `&subscription=${sub.id}`))[0];
      assert.equal(first.subtotal, preview.subtotal, 'previewed to the cent');
      assert.deepEqual(first.period, preview.period);
      assert.match(first.lines[0].description, /partial period/);

      // And the period after it is a whole month at the whole price.
      const next: Invoice = await fixed.ok('POST', '/v1/invoices/create_preview', { subscription: sub.id });
      assert.deepEqual(next.period, { start: UTC(2026, 9, 20), end: UTC(2026, 10, 20) });
      assert.equal(next.subtotal, GROWTH);
    } finally {
      fixed.close();
    }
  });

  test('a downgrade rides the next invoice as a credit line, and nets against the new plan', async () => {
    const customer = await ws.customer('Downgrade Credit');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'scale_monthly' }],
    });
    // Three quarters of the way in, so the quarter-period credit for Scale is
    // smaller than the month of Growth the renewal charges and the two meet on
    // one bill rather than one of them spilling onto the account.
    const period = sub.current_period_end - sub.current_period_start;
    const at = sub.current_period_start + Math.floor((period * 3) / 4);
    const remaining = sub.current_period_end - at;
    await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: sub.items[0].id, price: 'growth_monthly' }], proration_date: at,
    });
    const net = Math.round(GROWTH * remaining / period) - Math.round(SCALE * remaining / period);
    assert.ok(net < 0 && GROWTH + net > 0);
    const credited = await ws.ok('GET', `/v1/customers/${customer.id}`);
    assert.equal(credited.balance, 0, 'a negative proration waits on a bill, it does not move the balance');

    await ws.travelTo(sub.current_period_end + 60_000);
    const renewal = (await allInvoices(ws, `&subscription=${sub.id}`))
      .find((invoice) => invoice.billing_reason === 'subscription_cycle');
    assert.ok(renewal);
    // The renewal carries the new plan and both halves of the change, so the
    // credit is a line the tax engine has been through rather than a number
    // subtracted after tax.
    assert.equal(renewal.subtotal, GROWTH + net);
    assert.equal(sumLines(renewal), renewal.subtotal);
    assert.equal(renewal.lines.filter((line) => line.proration).length, 2);
    assert.equal(renewal.starting_balance, 0);
    assert.equal(renewal.balance_applied, 0);
    assert.equal(renewal.total, GROWTH + net);

    const after = await ws.ok('GET', `/v1/customers/${customer.id}`);
    assert.equal(after.balance, 0, 'nothing was left floating on the account');
  });

  test('an invoice a credit balance covers in full is settled at zero, not paid out', async () => {
    const customer = await ws.customer('Prepaid In Full');
    await ws.ok('POST', `/v1/customers/${customer.id}/balance_transactions`, {
      amount: -500_000, description: 'Prepayment against the 2026 order, agreed with finance.',
    });
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    const invoice = (await allInvoices(ws, `&subscription=${sub.id}`))[0];
    assert.equal(invoice.subtotal, GROWTH);
    assert.equal(invoice.balance_applied, -GROWTH);
    assert.equal(invoice.total, 0);
    assert.equal(invoice.status, 'paid', 'nothing to collect, so nothing is left open');
    assert.equal(invoice.amount_due, 0);
    const account = await ws.ok('GET', `/v1/customers/${customer.id}`);
    assert.equal(account.balance, -500_000 + GROWTH, 'only what the bill needed was spent');
  });

  test('pausing collection decides what happens to the bills raised while it is paused', async () => {
    const expected = { keep_as_draft: 'draft', mark_uncollectible: 'uncollectible', void: 'void' } as const;
    for (const behavior of ['keep_as_draft', 'mark_uncollectible', 'void'] as const) {
      const customer = await ws.customer(`Paused ${behavior}`);
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: customer.id, items: [{ price: 'starter_monthly' }],
      });
      await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, { behavior });
      await ws.travelTo(sub.current_period_end + 60_000);

      const invoices = await allInvoices(ws, `&subscription=${sub.id}`);
      const renewal = invoices.find((invoice) => invoice.billing_reason === 'subscription_cycle');
      assert.ok(renewal, `${behavior}: the cycle still turned over`);
      assert.equal(renewal.status, expected[behavior], `${behavior} is what happens to the bill`);
      assert.equal(sumLines(renewal), renewal.subtotal);

      const still: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
      assert.equal(still.status, 'paused', 'a deliberate pause is not a delinquency');
    }
  });

  test('voiding an invoice puts back everything it claimed', async () => {
    const customer = await ws.customer('Withdrawn Bill');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }, { price: 'growth_seat_monthly', quantity: 4 }],
    });
    await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: sub.items[1].id, quantity: 9 }], proration_date: midpointOf(sub),
    });
    await ws.travelTo(sub.current_period_end + 60_000);
    const renewal = (await allInvoices(ws, `&subscription=${sub.id}`))
      .find((invoice) => invoice.billing_reason === 'subscription_cycle');
    assert.ok(renewal);

    const voided: Invoice = await ws.ok('POST', `/v1/invoices/${renewal.id}/void`);
    assert.equal(voided.status, 'void');
    assert.equal(voided.amount_due, 0);
    assert.equal(sumLines(voided), voided.subtotal, 'a withdrawn bill is still a document that adds up');
    assert.ok(voided.lines.every((line) => line.released), 'but every line has let go of what it claimed');

    const waiting = await ws.ok('GET', `/v1/customers/${customer.id}/pending_items`);
    assert.equal(waiting.data.length, 2, 'the prorations are waiting for a bill again');

    const replacement: Invoice = await ws.ok('POST', '/v1/invoices', { customer: customer.id, subscription: sub.id });
    assert.equal(sumLines(replacement), replacement.subtotal);
    assert.equal(replacement.subtotal, waiting.data.reduce((total: number, item: { amount: number }) => total + item.amount, 0));
    assert.equal(replacement.billing_reason, 'manual');
    assert.ok(replacement.lines.every((line) => line.proration), 'and it re-bills only what was owed, not the period again');
  });

  test('a paid invoice does not clear an account that still owes an older one', async () => {
    const customer = await ws.customer('Two Bills Outstanding');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    await ws.travelTo(sub.current_period_end + 60_000);
    const invoices = await allInvoices(ws, `&subscription=${sub.id}`);
    assert.equal(invoices.length, 2);

    // Dunning put it in arrears; only clearing the account brings it back.
    ws.app.ctx.emit(ORG, 'invoice.payment_failed', { subscription: sub.id, invoice: invoices[0].id });
    assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'past_due');

    await ws.ok('POST', `/v1/invoices/${invoices[1].id}/pay`, { note: 'Bank transfer for September.' });
    assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'past_due',
      'October is still open, so the account is still in arrears');

    await ws.ok('POST', `/v1/invoices/${invoices[0].id}/pay`, { note: 'Bank transfer for October.' });
    assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active');
    const account = await ws.ok('GET', `/v1/customers/${customer.id}`);
    assert.equal(account.delinquent, false);
  });

  test('a metered-only cycle raises no invoice, because nothing is billable in advance', async () => {
    const customer = await ws.customer('Usage Only');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'telemetry_events_monthly' }],
    });
    assert.equal((await allInvoices(ws, `&subscription=${sub.id}`)).length, 0);
    const error = await ws.fail('POST', '/v1/invoices', { customer: customer.id, subscription: sub.id }, 409, 'nothing_to_invoice');
    assert.match(error.message, /nothing waiting/);

    // The cycle still turns over and still asks for the usage to be settled.
    await ws.travelTo(sub.current_period_end + 60_000);
    const due = ws.app.ctx.events.list(ORG, { types: ['subscription.invoice_due'], objectId: sub.id, limit: 10 });
    assert.ok(due.length >= 1, 'the event that settles metered usage is raised whether or not a bill is');
  });

  test('every invoice in the workspace reconciles, after a year of the time machine', async () => {
    const travelled = await ws.app.travel(400 * DAY);
    assert.equal(travelled.failed, 0);

    const invoices = await allInvoices(ws);
    assert.ok(invoices.length > 300, `expected a real invoice book, got ${invoices.length}`);

    const numbers = new Set<string>();
    for (const invoice of invoices) {
      assert.equal(sumLines(invoice), invoice.subtotal, `${invoice.number}: lines do not add up to the subtotal`);
      assert.equal(sumTax(invoice), invoice.tax, `${invoice.number}: the lines' tax does not add up to the tax total`);
      assert.equal(invoice.subtotal + invoice.tax + invoice.balance_applied, invoice.total, `${invoice.number}: does not reconcile`);
      assert.equal(invoice.total_excluding_tax, invoice.total - invoice.tax, `${invoice.number}: total excluding tax`);
      assert.equal(
        invoice.total_taxes.reduce((sum, row) => sum + row.amount, 0), invoice.tax,
        `${invoice.number}: the tax summary does not add up to the tax charged`,
      );
      assert.ok(
        ws.app.ctx.db.count(
          `SELECT COALESCE(SUM(total), 0) FROM billing_credit_notes WHERE org_id = ? AND invoice_id = ? AND status = 'issued'`,
          ORG, invoice.id,
        ) <= invoice.total,
        `${invoice.number}: credited for more than it was billed`,
      );
      assert.ok(invoice.total >= 0, `${invoice.number}: an invoice can never be negative`);
      // Cash and credit together account for the whole bill, so no invoice can
      // ever report collecting more than it was possible to collect.
      if (invoice.status !== 'void') {
        assert.equal(
          invoice.amount_paid + invoice.pre_payment_credit_notes_amount + invoice.amount_due, invoice.total,
          `${invoice.number}: collected + credited + still due is not what it was billed`,
        );
      }
      assert.ok(invoice.amount_paid <= invoice.total, `${invoice.number}: collected more than it billed`);
      assert.equal(invoice.ending_balance, invoice.starting_balance - invoice.balance_applied, `${invoice.number}: balance`);
      assert.ok(!numbers.has(invoice.number), `${invoice.number} was issued twice`);
      numbers.add(invoice.number);
      for (const line of invoice.lines) {
        if (!line.breakdown.length) continue;
        assert.equal(line.breakdown.reduce((total, row) => total + row.amount, 0), line.amount,
          `${invoice.number}: a line's breakdown does not add up to it`);
      }
    }

    // Nothing was claimed twice: every proration on an invoice appears once.
    const claims = invoices.flatMap((invoice) => invoice.lines
      .filter((line) => line.source.id && !line.released)
      .map((line) => `${line.source.type}:${line.source.id}`));
    assert.equal(new Set(claims).size, claims.length, 'a claimed line reached exactly one live invoice');
  });

  test('what a subscription was invoiced for its periods is what its ledger recognised', async () => {
    const subs = await ws.ok('GET', '/v1/subscriptions?status=all&limit=200');
    let checked = 0;
    for (const sub of subs.data as Subscription[]) {
      // A re-anchored cycle deliberately moves money between the two: the
      // period it left is reduced by the credit it handed back, and the period
      // it entered is paid for by a full-interval proration rather than by a
      // recurring line. Its signature is exactly that full-interval charge, and
      // the cadence-change suite above is what covers it.
      const reanchored = ws.app.ctx.db.count(
        `SELECT COUNT(*) FROM billing_pending_items
          WHERE org_id = ? AND subscription_id = ? AND kind = 'remaining_time'
            AND proration_numerator = proration_denominator`, ORG, sub.id,
      );
      if (reanchored > 0) continue;
      // A withdrawn bill is the other honest gap: the period was served and the
      // ledger still says so, but the invoice for it no longer exists until a
      // replacement is raised.
      const withdrawn = ws.app.ctx.db.count(
        `SELECT COUNT(*) FROM billing_invoices WHERE org_id = ? AND subscription_id = ? AND status = 'void'`, ORG, sub.id,
      );
      if (withdrawn > 0) continue;

      // Everywhere else the identity is exact: the recurring lines billed for a
      // subscription are the amounts its period ledger recognised, to the cent.
      const invoiced = ws.app.ctx.db.count(
        `SELECT COALESCE(SUM(l.amount), 0) FROM billing_invoice_lines l
           JOIN billing_invoices i ON i.id = l.invoice_id
          WHERE l.org_id = ? AND l.subscription_id = ? AND l.kind = 'recurring' AND i.status != 'void'`,
        ORG, sub.id,
      );
      const recognised = ws.app.ctx.db.count(
        `SELECT COALESCE(SUM(amount), 0) FROM billing_subscription_periods WHERE org_id = ? AND subscription_id = ? AND status != 'trial'`,
        ORG, sub.id,
      );
      assert.equal(invoiced, recognised, `${sub.id}: billed ${invoiced} but recognised ${recognised}`);
      checked += 1;
    }
    assert.ok(checked > 30, `expected the whole book to be reconcilable, checked ${checked}`);
  });

  test('what every account was asked to pay is what it was billed, less what it was credited', async () => {
    const customers = await ws.ok('GET', '/v1/customers?limit=200');
    for (const customer of customers.data as { id: string; name: string; balance: number }[]) {
      const billed = ws.app.ctx.db.count(
        `SELECT COALESCE(SUM(subtotal), 0) FROM billing_invoices
          WHERE org_id = ? AND customer_id = ? AND status IN ('open','paid','uncollectible')`, ORG, customer.id,
      );
      const taxed = ws.app.ctx.db.count(
        `SELECT COALESCE(SUM(tax), 0) FROM billing_invoices
          WHERE org_id = ? AND customer_id = ? AND status IN ('open','paid','uncollectible')`, ORG, customer.id,
      );
      const asked = ws.app.ctx.db.count(
        `SELECT COALESCE(SUM(total), 0) FROM billing_invoices
          WHERE org_id = ? AND customer_id = ? AND status IN ('open','paid','uncollectible')`, ORG, customer.id,
      );
      const granted = ws.app.ctx.db.count(
        `SELECT COALESCE(SUM(amount), 0) FROM billing_balance_transactions
          WHERE org_id = ? AND customer_id = ? AND type != 'applied_to_invoice'`, ORG, customer.id,
      );
      // Everything that moved has exactly one home: the bill, the tax on it,
      // the credit that reduced it, or the balance still on the account.
      assert.equal(asked + customer.balance, billed + taxed + granted, `${customer.name} does not reconcile`);
    }
  });
});

/* ========================================================================== *
 * 7. The demo book of business
 * ========================================================================== */

describe("Northwind's book of business", () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 8, 15)); });
  after(() => ws.close());

  test('seeds a real subscription book across the whole ladder', async () => {
    const overview = await ws.ok('GET', '/v1/subscriptions/overview');
    assert.ok(overview.subscriptions >= 35, `expected ~40 subscriptions, got ${overview.subscriptions}`);
    assert.ok(overview.customers >= 20, `expected the customer accounts, got ${overview.customers}`);
    assert.equal(overview.by_status.past_due, 2, 'two accounts in arrears');
    assert.equal(overview.by_status.paused, 1, 'one paused');
    assert.ok(overview.by_status.trialing >= 1, 'at least one live trial');
    assert.ok(overview.by_status.canceled >= 3, 'churn to report on');
    assert.ok(overview.mrr > 1_000_000, `MRR should be a real number, got ${overview.mrr}`);
    assert.equal(overview.delinquent_customers, 2);
    assert.ok(overview.scheduled_to_cancel >= 1);

    const ladder = new Set<string>();
    const subs = await ws.ok('GET', '/v1/subscriptions?status=all&limit=200');
    for (const sub of subs.data) for (const item of sub.items) ladder.add(item.price);
    for (const key of ['starter_monthly', 'growth_monthly', 'scale_monthly', 'enterprise_annual', 'telemetry_events_monthly']) {
      const id = await priceIdOf(ws, key);
      assert.ok(ladder.has(id), `nothing is subscribed to ${key}`);
    }
  });

  test('every billing customer is one of the CRM companies', async () => {
    const customers = await ws.ok('GET', '/v1/customers?limit=200');
    assert.ok(customers.data.length >= 20);
    for (const customer of customers.data) {
      assert.ok(customer.crm_record_id, `${customer.name} is not linked to the CRM`);
      const record = await ws.ok('GET', `/v1/records/company/${customer.crm_record_id}`);
      assert.equal(record.display_name, customer.name);
      assert.ok(customer.description.length > 20, `${customer.name} has no story`);
      assert.ok(['usd', 'eur', 'gbp'].includes(customer.currency));
    }
  });

  test('eighteen months of recognised revenue are on the books', async () => {
    const subs = await ws.ok('GET', '/v1/subscriptions?status=all&limit=200');
    const oldest = Math.min(...subs.data.map((s: { start_date: number }) => s.start_date));
    assert.ok(ws.now() - oldest > 400 * DAY, 'the book should reach back well over a year');

    let periods = 0;
    let recognised = 0;
    for (const sub of subs.data) {
      const page = await ws.ok('GET', `/v1/subscriptions/${sub.id}/periods`);
      periods += page.data.length;
      for (const period of page.data) {
        assert.ok(period.period_end > period.period_start);
        recognised += period.status === 'billed' ? period.amount : 0;
      }
    }
    assert.ok(periods > 250, `expected hundreds of billed periods to chart, got ${periods}`);
    assert.ok(recognised > 20_000_000, `expected real cumulative revenue, got ${recognised}`);
  });

  test('two upgrades are already in the history, priced by the same proration function', async () => {
    const events = ws.app.ctx.events.list(ORG, { types: ['subscription.prorated'], limit: 50 });
    assert.ok(events.length >= 2, `expected mid-cycle upgrades in the history, got ${events.length}`);
    for (const event of events) {
      const data = event.data as { lines: ProrationLine[]; credit_total: number; charge_total: number; net: number };
      assert.ok(data.lines.length >= 2);
      assert.equal(data.credit_total + data.charge_total, data.net);
      for (const line of data.lines) {
        assert.match(line.explanation, /ms =/);
        assert.equal(line.breakdown.reduce((total, row) => total + row.amount, 0), line.amount);
      }
    }
  });

  test('one schedule is mid-phase and survives a year of the time machine', async () => {
    const schedules = await ws.ok('GET', '/v1/subscription-schedules');
    assert.ok(schedules.data.length >= 1);
    const schedule = schedules.data[0];
    assert.equal(schedule.status, 'active');
    assert.equal(schedule.current_phase, 0);
    assert.equal(schedule.phases[0].state, 'current');
    assert.equal(schedule.phases[1].state, 'upcoming');

    const travelled = await ws.app.travel(370 * DAY);
    assert.equal(travelled.failed, 0, 'a year of renewals across the whole book must not throw');

    const after = await ws.ok('GET', `/v1/subscription-schedules/${schedule.id}`);
    assert.equal(after.current_phase, 1, 'the ramp moved on to its second phase');
    const sub: Subscription = await ws.ok('GET', `/v1/subscriptions/${after.subscription}`);
    assert.equal(sub.items.length, 3, 'phase two adds the seats and keeps metering');
  });

  test('no subscription in the book ever ended before it began', async () => {
    const subs = await ws.ok('GET', '/v1/subscriptions?status=all&limit=200');
    let terminal = 0;
    for (const sub of subs.data as Subscription[]) {
      if (sub.ended_at === null) continue;
      terminal += 1;
      assert.ok(sub.ended_at >= sub.start_date,
        `${sub.id} ended ${new Date(sub.ended_at).toISOString()} but started ${new Date(sub.start_date).toISOString()}`);
      assert.ok(sub.canceled_at === null || sub.canceled_at >= sub.start_date, `${sub.id}: canceled before it existed`);
      assert.ok(sub.ended_at <= ws.now(), `${sub.id}: ended in the future`);
    }
    assert.ok(terminal >= 3, `expected the churned accounts to be terminal, found ${terminal}`);
  });

  test('the copilot can find an account, price a change and never guess', async () => {
    const tools = ws.app.ctx.ai;
    const found = await tools.tool('billing_find_customer')!.run({ query: 'Robotics', limit: 5 }, ws.app.ctx, { orgId: ORG });
    assert.ok(Array.isArray(found) && found.length > 0);

    // Quantity only means something on a line that is priced per unit, so the
    // seat line is the one to move — a plan fee bills the same at any quantity.
    const prices = await ws.ok('GET', '/v1/prices?limit=200');
    const modelOf = new Map<string, string>(
      (prices.data as { id: string; model: string }[]).map((price) => [price.id, price.model]),
    );
    const subs = await ws.ok('GET', '/v1/subscriptions?status=active&limit=50');
    const scalable = (subs.data as { id: string; items: { id: string; price: string; quantity: number; metered: boolean }[] }[])
      .flatMap((s) => s.items.map((item) => ({ sub: s, item })))
      .find(({ item }) => !item.metered && modelOf.get(item.price) === 'per_unit');
    assert.ok(scalable, "Northwind's book has at least one per-seat line to move");
    const { sub, item: upgradeable } = scalable;
    const preview = await tools.tool('billing_preview_subscription_change')!.run({
      subscription: sub.id,
      items: [{ id: upgradeable.id, quantity: upgradeable.quantity + 1 }],
    }, ws.app.ctx, { orgId: ORG }) as ChangePreview & { net_display: string };
    assert.equal(typeof preview.net_display, 'string');
    assert.equal(preview.credit_total + preview.charge_total, preview.net);

    assert.equal(tools.tool('billing_preview_subscription_change')!.readOnly, true);
    assert.equal(tools.tool('billing_update_subscription')!.readOnly, false);
    assert.equal(tools.tool('billing_update_subscription')!.requiresApproval, true);
  });
});

/* ========================================================================== *
 * 8. Tax
 * ========================================================================== */

describe('tax', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 9, 1)); });
  after(() => ws.close());

  /** Two prices identical but for the one field the whole engine turns on. */
  const benchPrice = async (behavior: 'inclusive' | 'exclusive'): Promise<string> => {
    const growth = await ws.ok('GET', '/v1/prices?lookup_key=growth_monthly');
    const price = await ws.ok('POST', '/v1/prices', {
      product: growth.data[0].product,
      currency: 'usd',
      model: 'flat',
      unit_amount: 10_000,
      nickname: `Line-check plan — tax ${behavior}`,
      lookup_key: `line_check_${behavior}`,
      recurring: { interval: 'month' },
      tax_behavior: behavior,
    });
    return price.id as string;
  };

  const AUSTRALIA = {
    address: { line1: '4 Dock Road', city: 'Melbourne', state: 'Victoria', postal_code: '3000', country: 'Australia' },
  };

  /** 10% GST, a jurisdiction the seeded book is deliberately not registered in. */
  const registerGst = () => ws.ok('POST', '/v1/tax_rates', {
    display_name: 'GST', jurisdiction: 'Australia', country: 'AU', tax_type: 'gst', percentage: '10',
  });

  const billFor = async (customerId: string, priceId: string): Promise<Invoice> => {
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customerId, items: [{ price: priceId }],
    });
    const invoices = await allInvoices(ws, `&subscription=${sub.id}`);
    assert.equal(invoices.length, 1);
    return invoices[0];
  };

  test('the seeded workspace collects where it is registered, and nowhere else', async () => {
    const rates = await ws.ok('GET', '/v1/tax_rates');
    assert.ok(rates.data.length >= 15, `expected a real registration footprint, got ${rates.data.length}`);
    const germany = (rates.data as { country: string; percentage: string; reverse_charge: boolean }[])
      .find((rate) => rate.country === 'DE');
    assert.ok(germany, 'Northwind is VAT-registered in Germany');
    assert.equal(germany.percentage, '19');
    assert.equal(germany.reverse_charge, true);
    // One active rate per jurisdiction, so an address can never match two.
    await ws.fail('POST', '/v1/tax_rates', {
      display_name: 'VAT', jurisdiction: 'Germany', country: 'DE', percentage: '19',
    }, 409, 'tax_rate_exists');
  });

  test('an exclusive price adds tax on top; an inclusive one has it taken out', async () => {
    await registerGst();
    const exclusivePrice = await benchPrice('exclusive');
    const inclusivePrice = await benchPrice('inclusive');

    const first = await ws.customer('Barwon Automation', AUSTRALIA);
    const second = await ws.customer('Yarra Controls', AUSTRALIA);
    const exclusive = await billFor(first.id, exclusivePrice);
    const inclusive = await billFor(second.id, inclusivePrice);

    // The critic's exact case: same unit_amount, one field apart, and the two
    // invoices must not be the same invoice.
    assert.notDeepEqual(
      [exclusive.subtotal, exclusive.tax, exclusive.total],
      [inclusive.subtotal, inclusive.tax, inclusive.total],
    );
    for (const invoice of [exclusive, inclusive]) {
      assert.ok(Object.keys(invoice).some((key) => /tax/i.test(key)), 'an invoice has to say something about tax');
    }

    // Exclusive: the listed price is the base and 10% is added to it.
    assert.equal(exclusive.subtotal, 10_000);
    assert.equal(exclusive.tax, 1_000);
    assert.equal(exclusive.total, 11_000);
    assert.equal(exclusive.total_excluding_tax, 10_000);
    assert.equal(exclusive.lines[0].amount, 10_000);
    assert.equal(exclusive.lines[0].tax.amount, 1_000);
    assert.equal(exclusive.lines[0].tax.behavior, 'exclusive');
    assert.match(exclusive.lines[0].tax.explanation ?? '', /added on top/);

    // Inclusive: the customer pays the listed price and the tax comes out of it.
    // 10,000 x 100/110 = 9,090.909… → 9,091, and the rest is the tax.
    assert.equal(inclusive.subtotal, 9_091);
    assert.equal(inclusive.tax, 909);
    assert.equal(inclusive.total, 10_000, 'an inclusive price never changes what is charged');
    assert.equal(inclusive.lines[0].amount + inclusive.lines[0].tax.amount, 10_000, 'base plus tax is the listed price, to the cent');
    assert.equal(inclusive.lines[0].tax.behavior, 'inclusive');
    assert.match(inclusive.lines[0].tax.explanation ?? '', /included in the price/);

    // Both bills carry the snapshot that explains them, grouped by rate.
    for (const invoice of [exclusive, inclusive]) {
      assert.equal(invoice.total_taxes.length, 1);
      const [summary] = invoice.total_taxes;
      assert.equal(summary.display_name, 'GST');
      assert.equal(summary.percentage, '10');
      assert.equal(summary.jurisdiction, 'Australia');
      assert.equal(summary.amount, invoice.tax);
      assert.equal(summary.taxable_amount, invoice.subtotal);
      assert.equal(summary.inclusive, invoice.lines[0].tax.behavior === 'inclusive');
      assert.equal(invoice.subtotal + invoice.tax + invoice.balance_applied, invoice.total);
    }
  });

  test('the previewed invoice matches the issued one to the cent, tax included', async () => {
    const customer = await ws.customer('Otway Pressing', AUSTRALIA);
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'scale_monthly' }, { price: 'scale_seat_monthly', quantity: 7 }],
    });
    // A mid-cycle expansion, so the next bill carries taxed prorations too.
    await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: sub.items[1].id, quantity: 13 }], proration_date: midpointOf(sub),
    });

    const preview: Invoice = await ws.ok('POST', '/v1/invoices/create_preview', { subscription: sub.id });
    assert.ok(preview.tax > 0, 'a preview for a taxed account has to show the tax');
    assert.equal(sumTax(preview), preview.tax);
    assert.equal(preview.subtotal + preview.tax + preview.balance_applied, preview.total);

    await ws.travelTo(sub.current_period_end + 60_000);
    const issued = (await allInvoices(ws, `&subscription=${sub.id}`))
      .find((invoice) => invoice.billing_reason === 'subscription_cycle');
    assert.ok(issued, 'the renewal raised the invoice the preview described');
    assert.equal(issued.subtotal, preview.subtotal);
    assert.equal(issued.tax, preview.tax, 'the preview and the bill are taxed by one function');
    assert.equal(issued.total, preview.total);
    assert.equal(issued.total_excluding_tax, preview.total_excluding_tax);
    assert.equal(issued.balance_applied, preview.balance_applied);
    assert.deepEqual(
      issued.lines.map((line) => [...shapeOf(line), line.tax.amount, line.tax.percentage, line.tax.reason]),
      preview.lines.map((line) => [...shapeOf(line), line.tax.amount, line.tax.percentage, line.tax.reason]),
    );
    assert.deepEqual(
      issued.total_taxes.map((row) => [row.percentage, row.taxable_amount, row.amount]),
      preview.total_taxes.map((row) => [row.percentage, row.taxable_amount, row.amount]),
    );
  });

  test('an EU business with a verified VAT number is reverse charged, and the invoice says so', async () => {
    const customer = await ws.customer('Rheintal Steuerung', {
      currency: 'eur',
      address: { line1: 'Industriestraße 8', city: 'Stuttgart', state: 'Baden-Württemberg', postal_code: '70565', country: 'Germany' },
      tax_ids: [{ type: 'eu_vat', value: 'DE811907980', country: 'Germany' }],
    });
    // A number that is on file but has not been checked does not move the tax:
    // the register is what makes it a registration, and until it answers, the
    // supplier is the one the authority collects from.
    assert.equal(customer.tax_ids[0].verification.status, 'pending');
    const unchecked: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'starter_monthly' }],
    });
    const charged = (await allInvoices(ws, `&subscription=${unchecked.id}`))[0];
    assert.equal(charged.tax, Math.round(charged.subtotal * 0.19), 'unverified, so 19% is charged');
    assert.ok(charged.tax > 0);
    assert.equal(charged.lines[0].tax.reason, 'taxable');
    assert.match(charged.lines[0].tax.explanation ?? '', /has not been confirmed against the register/);

    const verified = await ws.ok('POST', `/v1/customers/${customer.id}/tax_ids/verify`, {
      value: 'DE811907980', status: 'verified', verified_name: 'Rheintal Steuerung GmbH',
    });
    assert.equal(verified.tax_ids[0].verification.status, 'verified');
    assert.equal(verified.tax_ids[0].verification.verified_name, 'Rheintal Steuerung GmbH');
    assert.equal(verified.tax_ids[0].verification.checked_at, ws.now());

    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    const invoice = (await allInvoices(ws, `&subscription=${sub.id}`))[0];

    assert.equal(invoice.tax, 0, 'the customer accounts for the tax, so nothing is charged');
    assert.equal(invoice.total, invoice.subtotal);
    const [line] = invoice.lines;
    assert.equal(line.tax.reason, 'reverse_charge');
    assert.equal(line.tax.percentage, '19', 'the rate that would have applied is still named');
    assert.equal(line.tax.display_name, 'VAT');
    assert.match(line.tax.explanation ?? '', /reverse charged/);
    // A zero that is still a row, because a silent bill cannot be sent to the EU.
    assert.equal(invoice.total_taxes.length, 1);
    assert.equal(invoice.total_taxes[0].reason, 'reverse_charge');
    assert.equal(invoice.total_taxes[0].amount, 0);
    assert.match(invoice.total_taxes[0].explanation, /customer accounts for it/);
  });

  test('an exempt account names the rate it would have paid and is charged nothing', async () => {
    await registerGst().catch(() => undefined);
    const customer = await ws.customer('Bellarine Foods', { ...AUSTRALIA, tax_exempt: 'exempt' });
    assert.equal(customer.tax_exempt, 'exempt');
    const invoice = await billFor(customer.id, await priceIdOf(ws, 'growth_monthly'));

    assert.equal(invoice.tax, 0);
    assert.equal(invoice.total, invoice.subtotal);
    assert.equal(invoice.lines[0].tax.reason, 'exempt');
    assert.equal(invoice.lines[0].tax.percentage, '10');
    assert.match(invoice.lines[0].tax.explanation ?? '', /registered as exempt/);
  });

  test('an address with no registered rate is charged nothing, and the line says why', async () => {
    const customer = await ws.customer('Aotearoa Robotics', {
      address: { line1: '12 Quay Street', city: 'Auckland', country: 'NZ' },
    });
    const invoice = await billFor(customer.id, await priceIdOf(ws, 'growth_monthly'));
    assert.equal(invoice.tax, 0);
    assert.equal(invoice.total_taxes.length, 0, 'nothing to summarise where there is no rate');
    assert.equal(invoice.lines[0].tax.reason, 'no_rate');
    assert.match(invoice.lines[0].tax.explanation ?? '', /No tax rate is registered for NZ/);
  });

  test('an invoice keeps the rate it was raised under after that rate is retired', async () => {
    const rate = await ws.ok('POST', '/v1/tax_rates', {
      display_name: 'IVA', jurisdiction: 'Colombia', country: 'CO', tax_type: 'vat', percentage: '19',
    });
    const customer = await ws.customer('Andes Manufactura', {
      address: { line1: 'Calle 26 #92', city: 'Bogotá', country: 'Colombia' },
    });
    const invoice = await billFor(customer.id, await priceIdOf(ws, 'starter_monthly'));
    assert.equal(invoice.tax, Math.round(STARTER * 0.19));
    assert.equal(invoice.lines[0].tax.rate, rate.id);

    await ws.ok('POST', `/v1/tax_rates/${rate.id}/deactivate`);
    const rates = await ws.ok('GET', '/v1/tax_rates?country=CO&active=true');
    assert.equal(rates.data.length, 0, 'the rate no longer matches a new bill');

    const after: Invoice = await ws.ok('GET', `/v1/invoices/${invoice.id}`);
    assert.equal(after.tax, invoice.tax, 'a historical document does not change when a rate does');
    assert.equal(after.lines[0].tax.percentage, '19');
    assert.equal(after.lines[0].tax.display_name, 'IVA');
  });

  test('a mid-cycle downgrade credits the tax it charged, and the sign of the net changes nothing', async () => {
    // Two identical German accounts at 19%, one month, one changed at the exact
    // midpoint. The supply is 5000 + 2500 + 5000 = 12500 for the downgrade and
    // 10000 + 10000 + 30000 = 50000 for the upgrade; the VAT on each is 19% of
    // what was supplied, not of what was invoiced before a credit came off.
    const germany = {
      currency: 'eur',
      address: { line1: 'Ostendstraße 25', city: 'Berlin', postal_code: '12459', country: 'Germany' },
    };
    const product = (await ws.ok('GET', '/v1/prices?lookup_key=growth_monthly')).data[0].product;
    const priceOf = async (amount: number, key: string) => (await ws.ok('POST', '/v1/prices', {
      product, currency: 'eur', model: 'flat', unit_amount: amount,
      nickname: `Tax bench ${key}`, lookup_key: `tax_bench_${key}`, recurring: { interval: 'month' },
    })).id as string;
    const hundred = await priceOf(10_000, 'de_100');
    const fifty = await priceOf(5_000, 'de_50');
    const threeHundred = await priceOf(30_000, 'de_300');

    const run = async (name: string, to: string) => {
      const customer = await ws.customer(name, germany);
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: customer.id, items: [{ price: hundred }],
      });
      await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
        items: [{ id: sub.items[0].id, price: to }], proration_date: midpointOf(sub),
      });
      await ws.travelTo(sub.current_period_end + 60_000);
      const bills = await allInvoices(ws, `&subscription=${sub.id}`);
      return {
        base: bills.reduce((total, invoice) => total + invoice.subtotal, 0),
        tax: bills.reduce((total, invoice) => total + invoice.tax, 0),
        charged: bills.reduce((total, invoice) => total + invoice.total, 0),
        balance: (await ws.ok('GET', `/v1/customers/${customer.id}`)).balance as number,
        bills,
      };
    };

    const down = await run('Spreewerk Antriebe', fifty);
    assert.equal(down.base, 12_500, 'the taxable supply is what was supplied');
    assert.equal(down.tax, 2_375, '19% of 12,500 — not 19% of 15,000');
    assert.equal(down.charged, 14_875);
    assert.equal(down.balance, 0, 'nothing was routed around the invoice');
    const credit = down.bills.find((invoice) => invoice.lines.some((line) => line.kind === 'unused_time'));
    assert.ok(credit, 'the credit is a line on a bill');
    const unused = credit.lines.find((line) => line.kind === 'unused_time');
    assert.ok(unused);
    assert.equal(unused.amount, -5_000);
    assert.equal(unused.tax.amount, -950, 'a negative line carries negative tax');
    assert.equal(unused.tax.reason, 'taxable');

    const up = await run('Uckermark Fertigung', threeHundred);
    assert.equal(up.base, 50_000, 'the mirror-image upgrade, on the same instant');
    assert.equal(up.tax, 9_500);
    assert.equal(up.charged, 59_500);

    // And a full credit note against the downgraded bill reverses exactly the
    // tax it charged, because the total and the lines' gross now agree.
    const second = down.bills.find((invoice) => invoice.subtotal === 2_500);
    assert.ok(second);
    const note = await ws.ok('POST', '/v1/credit_notes', { invoice: second.id, amount: second.total });
    assert.equal(note.total, second.total);
    assert.equal(note.tax, second.tax, 'a full credit reverses the whole of the tax and no more');
    assert.equal(note.subtotal, second.subtotal);
  });

  test('a registration number that is not one is refused before it can zero-rate anything', async () => {
    const berlin = {
      currency: 'eur',
      address: { line1: 'Chausseestraße 1', city: 'Berlin', postal_code: '10115', country: 'Germany' },
    };
    const account = await ws.customer('Format Check Antriebe', berlin);

    for (const value of ['DE', 'DEnot-a-number-at-all', 'DE81190798', 'FR811907980', 'ZZ811907980']) {
      const error = await ws.fail('PATCH', `/v1/customers/${account.id}`,
        { tax_ids: [{ type: 'eu_vat', value }] }, 400, 'tax_id_invalid');
      assert.equal(error.param, 'tax_ids');
      assert.ok(error.message.length > 40, 'the refusal says what the right shape is');
    }
    // The shapes each member state actually issues are different lengths, and
    // the check knows the difference rather than counting characters.
    await ws.ok('PATCH', `/v1/customers/${account.id}`, {
      tax_ids: [{ type: 'eu_vat', value: 'NL123456789B01' }],
    });
    await ws.fail('PATCH', `/v1/customers/${account.id}`,
      { tax_ids: [{ type: 'eu_vat', value: 'NL123456789' }] }, 400, 'tax_id_invalid');
    // And spaces are how a human writes one, not how a register holds one.
    const tidied = await ws.ok('PATCH', `/v1/customers/${account.id}`, {
      tax_ids: [{ type: 'eu_vat', value: 'de 811 907 980' }],
    });
    assert.equal(tidied.tax_ids[0].value, 'DE811907980');
    assert.equal(tidied.tax_ids[0].verification.status, 'pending', 'a new number is never born verified');
    await ws.fail('PATCH', `/v1/customers/${account.id}`, {
      tax_ids: [{ type: 'eu_vat', value: 'DE811907980' }, { type: 'eu_vat', value: 'DE 811907980' }],
    }, 400, 'tax_id_duplicated');
  });

  test('reverse charge needs a verified number and a border to cross', async () => {
    const berlin = {
      currency: 'eur',
      address: { line1: 'Hafenstraße 3', city: 'Hamburg', postal_code: '20457', country: 'Germany' },
      tax_ids: [{ type: 'eu_vat', value: 'DE811907980', country: 'Germany' }],
    };
    const account = await ws.customer('Nordbau Steuerung', berlin);
    const bill = async (): Promise<Invoice> => {
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: account.id, items: [{ price: 'starter_monthly' }],
      });
      return (await allInvoices(ws, `&subscription=${sub.id}`))[0];
    };

    const unchecked = await bill();
    assert.equal(unchecked.lines[0].tax.reason, 'taxable', 'unverified is not verified');
    assert.ok(unchecked.tax > 0);
    assert.match(unchecked.lines[0].tax.explanation ?? '', /not been confirmed against the register/);
    assert.match(unchecked.lines[0].tax.explanation ?? '', /tax_ids\/verify/, 'and it says how to fix it');

    await ws.fail('POST', `/v1/customers/${account.id}/tax_ids/verify`,
      { value: 'DE999999999', status: 'verified' }, 400, 'tax_id_not_on_customer');

    await ws.ok('POST', `/v1/customers/${account.id}/tax_ids/verify`, {
      value: 'DE811907980', status: 'verified', verified_name: 'Nordbau Steuerung GmbH',
    });
    assert.equal((await bill()).lines[0].tax.reason, 'reverse_charge');

    // The register can also say no, and then the supplier charges the tax again.
    await ws.ok('POST', `/v1/customers/${account.id}/tax_ids/verify`, {
      value: 'DE811907980', status: 'unverified',
    });
    const rejected = await bill();
    assert.equal(rejected.lines[0].tax.reason, 'taxable');
    assert.match(rejected.lines[0].tax.explanation ?? '', /register did not recognise it/);

    // Finally, the rule is cross-border. A supplier established in Germany
    // charges German VAT on a German supply however good the number is.
    await ws.ok('POST', `/v1/customers/${account.id}/tax_ids/verify`, {
      value: 'DE811907980', status: 'verified',
    });
    assert.equal((await bill()).lines[0].tax.reason, 'reverse_charge');
    ws.app.ctx.svc.core.setSetting(ORG, 'billing.issuer', {
      legal_name: 'Northwind Robotics GmbH', city: 'Berlin', country: 'Germany',
    });
    const domestic = await bill();
    assert.equal(domestic.lines[0].tax.reason, 'taxable', 'a domestic B2B supply is taxed, not zero-rated');
    assert.ok(domestic.tax > 0);
    assert.match(domestic.lines[0].tax.explanation ?? '', /domestic supply/);
    ws.app.ctx.svc.core.setSetting(ORG, 'billing.issuer', {
      legal_name: 'Northwind Robotics, Inc.', city: 'Cleveland', country: 'United States',
    });
  });

  test('a credit is taxed the way the charge it reverses was, whatever the currency does', async () => {
    // Three decimals, and a rate that does not divide evenly into anything.
    await ws.ok('POST', '/v1/tax_rates', {
      display_name: 'VAT', jurisdiction: 'Bahrain', country: 'BH', tax_type: 'vat', percentage: '19',
    });
    const product = (await ws.ok('GET', '/v1/prices?lookup_key=growth_monthly')).data[0].product;
    const make = async (amount: number, key: string, behavior?: 'inclusive') => (await ws.ok('POST', '/v1/prices', {
      product, currency: 'bhd', model: 'flat', unit_amount: amount, nickname: `Bahrain ${key}`,
      lookup_key: `bhd_${key}`, recurring: { interval: 'month' }, ...(behavior ? { tax_behavior: behavior } : {}),
    })).id as string;
    const customer = await ws.customer('Manama Automation', {
      currency: 'bhd', address: { line1: '1 Bab Al Bahrain', city: 'Manama', country: 'BH' },
    });
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: await make(12_345, 'high') }],
    });
    const change = await ws.ok('PATCH', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: sub.items[0].id, price: await make(6_000, 'low') }],
      proration_date: midpointOf(sub), proration_behavior: 'always_invoice',
    });
    const credit = (await allInvoices(ws, `&subscription=${sub.id}`))
      .find((invoice) => invoice.billing_reason === 'subscription_update');
    assert.ok(credit);
    assert.equal(credit.subtotal, (change.proration as ChangePreview).net);
    assert.ok(credit.subtotal < 0);
    assert.equal(credit.tax, Math.round(credit.subtotal * 0.19), 'exact at three decimals, rounded once');
    assert.equal(credit.total, 0, 'a bill is never negative');
    const account = await ws.ok('GET', `/v1/customers/${customer.id}`);
    assert.equal(account.balance, credit.subtotal + credit.tax, 'the credit that reaches the account includes its tax');
  });

  test('a percentage has to be an exact decimal, and a country has to be one we can match', async () => {
    await ws.fail('POST', '/v1/tax_rates', {
      display_name: 'Sales tax', jurisdiction: 'Nowhere', country: 'Freedonia', percentage: '5',
    }, 400, 'tax_country_unknown');
    await ws.fail('POST', '/v1/tax_rates', {
      display_name: 'Sales tax', jurisdiction: 'Kentucky', country: 'US', state: 'Kentucky', percentage: '6.0000001',
    }, 400, 'tax_percentage_invalid');
  });
});

/* ========================================================================== *
 * 9. Credit notes
 * ========================================================================== */

describe('credit notes', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 9, 1)); });
  after(() => ws.close());

  const TEXAS = {
    address: { line1: '901 Congress Avenue', city: 'Austin', state: 'Texas', postal_code: '78701', country: 'United States' },
  };

  /** A finalised, taxed invoice to correct. Texas is 6.25% in the seeded book. */
  const taxedInvoice = async (name: string, collection: 'send_invoice' | 'charge_automatically' = 'send_invoice') => {
    const customer = await ws.customer(name, TEXAS);
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }, { price: 'growth_seat_monthly', quantity: 5 }],
      collection_method: collection,
      days_until_due: 30,
    });
    const invoice = (await allInvoices(ws, `&subscription=${sub.id}`))[0];
    assert.ok(invoice.tax > 0, 'the fixture has to actually carry tax');
    return { customer, sub, invoice };
  };

  test('an open invoice is reduced, and the note carries the tax it reversed', async () => {
    const { customer, invoice } = await taxedInvoice('Guadalupe Instruments');
    assert.equal(invoice.status, 'open');
    const seats = invoice.lines.find((line) => line.description.includes('seat'));
    assert.ok(seats);

    const preview = await ws.ok('POST', '/v1/credit_notes/preview', {
      invoice: invoice.id,
      lines: [{ invoice_line_item: seats.id, quantity: 2 }],
      reason: 'order_change',
    });
    const note = await ws.ok('POST', '/v1/credit_notes', {
      invoice: invoice.id,
      lines: [{ invoice_line_item: seats.id, quantity: 2 }],
      reason: 'order_change',
      memo: 'Two seats were never provisioned.',
    });

    // The preview and the note are one function, so they cannot disagree.
    assert.equal(note.subtotal, preview.subtotal);
    assert.equal(note.tax, preview.tax);
    assert.equal(note.total, preview.total);

    // Two of five seats, gross, with the tax reversed in the same proportion.
    const seatGross = seats.amount + seats.tax.amount;
    assert.equal(note.total, Math.round((seatGross * 2) / 5));
    assert.equal(note.subtotal + note.tax, note.total);
    assert.equal(note.tax, Math.round((note.total * seats.tax.amount) / seatGross));
    assert.ok(note.tax > 0, 'a partial credit of a taxed line credits tax with it');
    assert.equal(note.lines[0].tax_percentage, seats.tax.percentage);
    assert.match(note.lines[0].explanation, /credited back/);
    assert.match(note.number, /^NR-CN-\d{6}$/);

    // Nothing was collected, so it comes off what is owed.
    assert.equal(note.pre_payment_amount, note.total);
    assert.equal(note.post_payment_amount, 0);
    const after: Invoice = await ws.ok('GET', `/v1/invoices/${invoice.id}`);
    assert.equal(after.pre_payment_credit_notes_amount, note.total);
    assert.equal(after.amount_due, invoice.total - note.total);
    assert.equal(after.total, invoice.total, 'the bill itself is never rewritten');
    assert.equal(after.status, 'open');

    // The balance was not touched: a pre-payment credit reduces, it does not grant.
    const account = await ws.ok('GET', `/v1/customers/${customer.id}`);
    assert.equal(account.balance, 0);
  });

  test('a paid invoice is credited onto the account balance instead', async () => {
    const { customer, invoice } = await taxedInvoice('Llano Valve Works', 'charge_automatically');
    await ws.ok('POST', `/v1/invoices/${invoice.id}/pay`, { note: 'Card on file.' });

    const note = await ws.ok('POST', '/v1/credit_notes', {
      invoice: invoice.id, amount: 20_000, reason: 'product_unsatisfactory',
    });
    assert.equal(note.post_payment_amount, 20_000);
    assert.equal(note.pre_payment_amount, 0);
    assert.ok(note.balance_transaction, 'the movement is a row in the balance ledger, not a silent change');

    const account = await ws.ok('GET', `/v1/customers/${customer.id}`);
    assert.equal(account.balance, -20_000, 'credit the customer holds is negative, Stripe-style');
    const after: Invoice = await ws.ok('GET', `/v1/invoices/${invoice.id}`);
    assert.equal(after.post_payment_credit_notes_amount, 20_000);
    assert.equal(after.amount_paid, invoice.total, 'the money really was collected, and still was');
    assert.equal(after.amount_due, 0);

    // And the credit lands on the next bill rather than being paid out.
    const ledger = await ws.ok('GET', `/v1/customers/${customer.id}/balance_transactions`);
    assert.equal(ledger.data[0].type, 'credit_note');
    assert.equal(ledger.data[0].amount, -20_000);
  });

  test('paying a bill a credit note already reduced collects the reduced amount, never the face value', async () => {
    const { customer, invoice } = await taxedInvoice('Frio River Controls');
    assert.equal(invoice.amount_paid, 0);
    assert.equal(invoice.amount_due, invoice.total);

    const note = await ws.ok('POST', '/v1/credit_notes', {
      invoice: invoice.id, amount: 3_000, reason: 'order_change',
    });
    const credited: Invoice = await ws.ok('GET', `/v1/invoices/${invoice.id}`);
    assert.equal(credited.amount_due, invoice.total - 3_000);

    const before = (await ws.ok('GET', '/v1/subscriptions/overview')).invoices.collected;
    const paid: Invoice = await ws.ok('POST', `/v1/invoices/${invoice.id}/pay`, { note: 'Bank transfer.' });
    const after = (await ws.ok('GET', '/v1/subscriptions/overview')).invoices.collected;

    // Only what was collectable was ever going to arrive, so only that is cash.
    assert.equal(paid.amount_paid, invoice.total - 3_000);
    assert.equal(paid.amount_due, 0);
    assert.equal(paid.status, 'paid');
    assert.equal(after - before, invoice.total - 3_000, 'the workspace collected figure moves by the cash');
    assert.equal(paid.amount_paid + paid.pre_payment_credit_notes_amount + paid.amount_due, paid.total);
    assert.equal((paid as unknown as { reconciles: boolean }).reconciles, true);

    // Withdrawing the note makes the difference owed again: it cannot simply
    // disappear, with no line, no balance entry and no re-bill.
    await ws.ok('POST', `/v1/credit_notes/${note.id}/void`);
    const reopened: Invoice = await ws.ok('GET', `/v1/invoices/${invoice.id}`);
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.amount_due, 3_000);
    assert.equal(reopened.amount_paid, invoice.total - 3_000, 'what was collected stays collected');
    assert.equal(reopened.pre_payment_credit_notes_amount, 0);
    assert.equal(reopened.amount_paid + reopened.amount_due, reopened.total);
    const account = await ws.ok('GET', `/v1/customers/${customer.id}`);
    assert.equal(account.balance, 0, 'nothing was quietly parked on the balance');
  });

  test('a credit note is refused, never clamped, when it exceeds what is left', async () => {
    const { invoice } = await taxedInvoice('Pedernales Assembly');
    const tooMuch = await ws.fail('POST', '/v1/credit_notes',
      { invoice: invoice.id, amount: invoice.total + 1 }, 400, 'credit_note_amount_too_large');
    assert.match(tooMuch.message, /more than/);
    assert.equal(
      (await ws.ok('GET', '/v1/credit_notes?invoice=' + invoice.id)).data.length, 0,
      'a refusal writes nothing',
    );

    // Credit most of it, then ask for the rest plus a cent.
    await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: invoice.total - 500 });
    const second = await ws.fail('POST', '/v1/credit_notes',
      { invoice: invoice.id, amount: 501 }, 400, 'credit_note_amount_too_large');
    assert.equal(second.param, 'amount');
    // The last 500 is still creditable, exactly.
    const rest = await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 500 });
    assert.equal(rest.total, 500);
    await ws.fail('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 1 }, 400, 'credit_note_nothing_creditable');

    const after: Invoice = await ws.ok('GET', `/v1/invoices/${invoice.id}`);
    assert.equal(after.pre_payment_credit_notes_amount, invoice.total);
    assert.equal(after.amount_due, 0);
    assert.equal(after.status, 'paid', 'a bill credited to nothing is not owed any more');
    assert.equal(after.amount_paid, 0, 'and nothing was collected — that is the difference');
  });

  test('a line can only be credited for what it was billed, and only on its own invoice', async () => {
    const { invoice } = await taxedInvoice('Blanco Toolworks');
    const other = await taxedInvoice('Comal Fabrication');
    const [plan] = invoice.lines;

    await ws.fail('POST', '/v1/credit_notes', {
      invoice: invoice.id,
      lines: [{ invoice_line_item: other.invoice.lines[0].id }],
    }, 400, 'credit_note_line_not_on_invoice');

    await ws.fail('POST', '/v1/credit_notes', {
      invoice: invoice.id,
      lines: [{ invoice_line_item: plan.id, amount: plan.amount + plan.tax.amount + 1 }],
    }, 400, 'credit_note_line_amount_too_large');

    await ws.fail('POST', '/v1/credit_notes', {
      invoice: invoice.id,
      lines: [{ invoice_line_item: plan.id }, { invoice_line_item: plan.id }],
    }, 400, 'credit_note_line_duplicated');

    await ws.fail('POST', '/v1/credit_notes', { invoice: invoice.id }, 400, 'credit_note_amount_or_lines');
    await ws.fail('POST', '/v1/credit_notes',
      { invoice: invoice.id, amount: 100, lines: [{ invoice_line_item: plan.id }] }, 400, 'credit_note_amount_or_lines');
  });

  test('voiding a note puts back exactly what it took', async () => {
    const { customer, invoice } = await taxedInvoice('Nueces Drive Systems');
    const note = await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: invoice.total });
    const settled: Invoice = await ws.ok('GET', `/v1/invoices/${invoice.id}`);
    assert.equal(settled.status, 'paid');
    assert.equal(settled.amount_due, 0);

    const voided = await ws.ok('POST', `/v1/credit_notes/${note.id}/void`);
    assert.equal(voided.status, 'void');
    assert.ok(voided.voided_at);

    const reopened: Invoice = await ws.ok('GET', `/v1/invoices/${invoice.id}`);
    assert.equal(reopened.status, 'open', 'withdrawing the note makes the bill owed again');
    assert.equal(reopened.amount_due, invoice.total);
    assert.equal(reopened.pre_payment_credit_notes_amount, 0);
    const account = await ws.ok('GET', `/v1/customers/${customer.id}`);
    assert.equal(account.balance, 0);

    // And the full amount is creditable again, because nothing stands against it.
    const again = await ws.ok('POST', '/v1/credit_notes/preview', { invoice: invoice.id, amount: invoice.total });
    assert.equal(again.total, invoice.total);
  });

  test('a draft or voided invoice cannot be credited at all', async () => {
    const { invoice } = await taxedInvoice('Frio River Controls');
    await ws.ok('POST', `/v1/invoices/${invoice.id}/void`);
    await ws.fail('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 100 }, 400, 'credit_note_invoice_void');
  });

  test('every credit note is listed, retrievable and attached to its invoice', async () => {
    const { customer, invoice } = await taxedInvoice('Sabinal Gearworks');
    const note = await ws.ok('POST', '/v1/credit_notes', {
      invoice: invoice.id, amount: 1_000, reason: 'duplicate', memo: 'Billed twice for March.',
    });
    const fetched = await ws.ok('GET', `/v1/credit_notes/${note.id}`);
    assert.equal(fetched.id, note.id);
    assert.equal(fetched.invoice_number, invoice.number);
    assert.equal(fetched.customer_name, customer.name);
    assert.equal(fetched.remaining_creditable, invoice.total - 1_000);

    const byInvoice = await ws.ok('GET', `/v1/credit_notes?invoice=${invoice.id}`);
    assert.equal(byInvoice.data.length, 1);
    const byCustomer = await ws.ok('GET', `/v1/credit_notes?customer=${customer.id}`);
    assert.equal(byCustomer.data.length, 1);
    assert.equal(byCustomer.data[0].memo, 'Billed twice for March.');
  });
});

/* ========================================================================== *
 * 10. A cancellation date that has already passed
 * ========================================================================== */

describe('cancel_at in the past', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 9, 1)); });
  after(() => ws.close());

  const THREE_YEARS_AGO = () => UTC(2026, 9, 1) - 3 * 365 * DAY;

  test('creating a subscription with a cancel_at that has passed is refused', async () => {
    const customer = await ws.customer('Backdated Cancellation');
    const error = await ws.fail('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'growth_monthly' }],
      cancel_at: THREE_YEARS_AGO(),
    }, 400, 'cancel_at_in_past');
    assert.equal(error.param, 'cancel_at');
    assert.match(error.message, /already passed/);

    // And nothing was written: no subscription, no invoice, no counted cancellation.
    const subs = await ws.ok('GET', `/v1/subscriptions?customer=${customer.id}&status=all`);
    assert.equal(subs.data.length, 0, 'a refused create leaves no subscription behind');
    assert.equal((await allInvoices(ws, `&customer=${customer.id}`)).length, 0);
  });

  test('patching a subscription onto a past cancel_at is refused', async () => {
    const customer = await ws.customer('Patch Cancellation');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    await ws.fail('PATCH', `/v1/subscriptions/${sub.id}`, { cancel_at: THREE_YEARS_AGO() }, 400, 'cancel_at_in_past');
    const after: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(after.cancel_at, null);
    assert.equal(after.status, 'active');
  });

  test('scheduling a cancellation in the past through /cancel is refused', async () => {
    const customer = await ws.customer('Schedule Cancellation');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    await ws.fail('POST', `/v1/subscriptions/${sub.id}/cancel`, { cancel_at: THREE_YEARS_AGO() }, 400, 'cancel_at_in_past');
    const after: Subscription = await ws.ok('GET', `/v1/subscriptions/${sub.id}`);
    assert.equal(after.cancel_at, null);
    assert.equal(after.status, 'active');

    // A future date is still accepted, so the guard refuses the contradiction
    // and nothing else.
    const scheduled = await ws.ok('POST', `/v1/subscriptions/${sub.id}/cancel`, { cancel_at: ws.now() + 45 * DAY });
    assert.equal(scheduled.cancel_at, ws.now() + 45 * DAY);
  });

  test('no cancellation in the whole seeded book predates the subscription it ends', async () => {
    const overview = await ws.ok('GET', '/v1/subscriptions/overview');
    assert.ok(overview.scheduled_to_cancel >= 0);
    const subs = await ws.ok('GET', '/v1/subscriptions?status=all&limit=200');
    for (const sub of subs.data as Subscription[]) {
      if (sub.cancel_at === null) continue;
      assert.ok(sub.cancel_at > sub.created, `${sub.id} is set to cancel before it was created`);
    }
  });
});

/* ========================================================================== *
 * 11. The invoice document
 * ========================================================================== */

describe('the invoice document', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(UTC(2026, 9, 1)); });
  after(() => ws.close());

  const render = async (id: string): Promise<{ status: number; html: string; type: string }> => {
    const res = await ws.call('GET', `/v1/invoices/${id}/render`);
    return { status: res.status, html: String(res.body), type: String((res as { headers?: Record<string, string> }).headers?.['content-type'] ?? '') };
  };

  test('renders a complete printable bill with the tax on it', async () => {
    const customer = await ws.customer('Housatonic Machine', {
      address: { line1: '55 Water Street', city: 'New York', state: 'New York', postal_code: '10041', country: 'United States' },
    });
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: [{ price: 'scale_monthly' }, { price: 'scale_seat_monthly', quantity: 12 }],
      collection_method: 'send_invoice',
      days_until_due: 45,
    });
    const invoice = (await allInvoices(ws, `&subscription=${sub.id}`))[0];
    assert.ok(invoice.tax > 0, 'New York is a registered jurisdiction, so this bill carries tax');

    const { status, html, type } = await render(invoice.id);
    assert.equal(status, 200);
    assert.match(type, /text\/html/);

    // A whole document, not a fragment.
    assert.ok(html.startsWith('<!doctype html>'), 'it has to be a document a browser can open');
    assert.match(html, /<html lang='en'>/);
    assert.ok(html.trimEnd().endsWith('</html>'));
    assert.match(html, /<style>/, 'self-contained: no stylesheet to fetch');
    assert.ok(!/<script/i.test(html), 'nothing to run — this is a document, not an app');
    assert.ok(!/https?:\/\//.test(html), 'nothing to fetch from anywhere else');
    assert.match(html, /@media print/);

    // The platform's HTTP layer serialises every response body with
    // JSON.stringify, so the document is built to contain nothing JSON has to
    // escape: the same bytes are a valid page in process and over the wire.
    assert.equal(JSON.stringify(html), `"${html}"`, 'the document must survive JSON encoding unchanged');
    assert.ok(!html.includes('"') && !html.includes('\\'), 'single-quoted attributes, no backslashes');

    // Issuer, bill-to and the invoice's own identity.
    assert.ok(html.includes('Northwind Robotics, Inc.'));
    assert.ok(html.includes('1200 Superior Avenue East'));
    assert.ok(html.includes('Housatonic Machine'));
    assert.ok(html.includes('55 Water Street'));
    assert.ok(html.includes('New York, New York 10041'));
    assert.ok(html.includes(invoice.number));

    // Every line, with its window, its per-tier breakdown and its tax.
    for (const line of invoice.lines) {
      assert.ok(html.includes(line.description.replace(/&/g, '&amp;')), `the document is missing "${line.description}"`);
    }
    assert.ok(html.includes('at the tier 1 rate'), 'the seat line shows the tier it was priced on');
    assert.match(html, /Service period/);
    assert.match(html, /Tax summary/);
    assert.ok(html.includes('NY sales tax'));
    assert.ok(html.includes('4%'));

    // The totals a finance team reconciles against.
    const show = (amount: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount / 100);
    assert.ok(html.includes(show(invoice.subtotal)), 'the subtotal is on the page');
    assert.ok(html.includes(show(invoice.tax)), 'so is the tax');
    assert.ok(html.includes(show(invoice.total)), 'and the total');
    assert.match(html, /Amount due/);
    assert.match(html, /Payment/);
    assert.match(html, /Please pay/);
    assert.match(html, /Due/);
  });

  test('the document shows a credit note raised against the bill, and escapes what a customer typed', async () => {
    const customer = await ws.customer('Ampersand & <Sons> Robotics', {
      address: { line1: '2 Mill Street', city: 'Austin', state: 'Texas', postal_code: '78701', country: 'United States' },
    });
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }], collection_method: 'send_invoice',
    });
    const invoice = (await allInvoices(ws, `&subscription=${sub.id}`))[0];
    const note = await ws.ok('POST', '/v1/credit_notes', {
      invoice: invoice.id, amount: 2_500, reason: 'product_unsatisfactory', memo: 'Agreed with <Priya> & the account team.',
    });

    const { html } = await render(invoice.id);
    assert.ok(html.includes('Ampersand &amp; &lt;Sons&gt; Robotics'), 'a customer name is escaped, never injected');
    assert.ok(!html.includes('<Sons>'));
    assert.ok(html.includes('Agreed with &lt;Priya&gt; &amp; the account team.'));
    assert.ok(html.includes(note.number));
    assert.match(html, /Credit notes against this invoice/);
    assert.match(html, /Credited before payment/);
  });

  test('a reverse-charged bill explains its zero on the page', async () => {
    const customer = await ws.customer('Bruges Aandrijving', {
      currency: 'eur',
      address: { line1: 'Havenlaan 3', city: 'Eindhoven', postal_code: '5503 LN', country: 'Netherlands' },
      tax_ids: [{ type: 'eu_vat', value: 'NL004495445B01', country: 'Netherlands' }],
    });
    await ws.ok('POST', `/v1/customers/${customer.id}/tax_ids/verify`, {
      value: 'NL004495445B01', status: 'verified', verified_name: 'Bruges Aandrijving BV',
    });
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    const invoice = (await allInvoices(ws, `&subscription=${sub.id}`))[0];
    assert.equal(invoice.tax, 0);

    const { html } = await render(invoice.id);
    assert.ok(html.includes('BTW'), 'the Dutch rate is named even though nothing is charged');
    assert.ok(html.includes('21%'));
    assert.match(html, /reverse charged/);
    assert.match(html, /EU VAT NL004495445B01/, 'the registration number that shifted the tax is printed');
  });

  test('a bill that is worth money back says so, and says where the money went', async () => {
    const customer = await ws.customer('Abgang Antriebe', {
      currency: 'eur',
      address: { line1: 'Ostendstraße 25', city: 'Berlin', postal_code: '12459', country: 'Germany' },
    });
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    await ws.travelTo(ws.now() + 5 * DAY);
    await ws.ok('POST', `/v1/subscriptions/${sub.id}/cancel`, { prorate: true, cancellation_reason: 'downgraded' });
    const final = (await allInvoices(ws, `&subscription=${sub.id}`))
      .find((invoice) => invoice.billing_reason === 'subscription_update');
    assert.ok(final);
    assert.ok(final.subtotal < 0 && final.tax < 0, 'the credit line carries the tax it reverses');
    assert.equal(final.total, 0);

    const { html } = await render(final.id);
    assert.ok(html.includes('Credit for unused time'), 'the credit is a line on the document');
    assert.ok(html.includes('Placed on the account balance'), 'and the document says where its value went');
    assert.ok(!html.includes('carried forward'), 'which is the opposite of carrying a debt forward');
    const account = await ws.ok('GET', `/v1/customers/${customer.id}`);
    assert.equal(account.balance, final.subtotal + final.tax, 'base and tax both came back');
  });

  test('an invoice that does not exist is a 404, not an empty page', async () => {
    const res = await ws.call('GET', '/v1/invoices/in_doesnotexist000000/render');
    assert.equal(res.status, 404);
  });
});
