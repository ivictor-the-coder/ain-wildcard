import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, frozenClock, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { DAY } from '../src/shared/time';
import type { Subscription } from '../src/server/modules/billing/types';
import type {
  ActiveEntitlement, EntitlementCheck, EntitlementOverride, EntitlementSet, EntitlementVersion, Feature,
} from '../src/server/modules/entitlements/types';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const T0 = Date.UTC(2026, 5, 2, 9, 17, 34, 512);

let app: App;

const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, body, auth: DANA });

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
  app = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } });
});
after(() => app.close());

/* --------------------------------- fixtures -------------------------------- */

let seq = 0;
const nextName = (prefix: string) => `${prefix} ${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const priceOf = (lookupKey: string): string => {
  const price = app.ctx.svc.catalog.priceByLookupKey(ORG, lookupKey);
  assert.ok(price, `seeded catalog is missing price "${lookupKey}"`);
  return price.id;
};

/**
 * A brand-new account on Telemetry Cloud Growth with `seats` operator seats.
 *
 * Backdated a day, so the current billing period has already started and usage
 * timestamped moments ago falls inside it — the position every real account is
 * in, and the only one in which "ingested a second ago" means anything.
 */
async function growthAccount(seats: number): Promise<{ customer: string; subscription: Subscription }> {
  const customer = await expectOk('POST', '/v1/customers', { name: nextName('Fixture Works'), currency: 'usd' });
  const subscription = await expectOk('POST', '/v1/subscriptions', {
    customer: customer.id,
    backdate_start_date: app.ctx.now() - DAY,
    items: [
      { price: priceOf('growth_monthly'), quantity: 1 },
      { price: priceOf('growth_seat_monthly'), quantity: seats },
      { price: priceOf('telemetry_events_monthly'), quantity: 1 },
    ],
  });
  return { customer: customer.id, subscription };
}

const check = (customer: string, feature: string, requested = 0): Promise<EntitlementCheck> =>
  expectOk('POST', '/v1/entitlements/check', { customer, feature, requested });

const setOf = (customer: string): Promise<EntitlementSet> =>
  expectOk('GET', `/v1/customers/${customer}/entitlements`);

const valueOf = async (customer: string, feature: string): Promise<number | null | 'unlimited' | 'absent'> => {
  const set = await setOf(customer);
  const row = set.entitlements.find((e) => e.feature === feature);
  if (!row) return 'absent';
  return row.unlimited ? 'unlimited' : row.value;
};

/**
 * Watch one customer's events from here on. The workspace clock is frozen, so
 * "since this timestamp" would catch everything; identity is what separates
 * what happened before the call under test from what it caused.
 */
function watch(customer: string, types: string[]): () => { type: string; data: any }[] {
  const read = () => app.ctx.events.list(ORG, { types, objectId: customer, limit: 500 });
  const before = new Set(read().map((e) => e.id));
  return () => read().filter((e) => !before.has(e.id)).reverse().map((e) => ({ type: e.type, data: e.data as any }));
}

/* -------------------------- the workspace as seeded ------------------------ */

// First, before any test moves the clock: the demo workspace ships with two
// live support grants, and they have to be real overrides on real accounts.
describe('the demo workspace arrives with its history intact', () => {
  test('support has two temporary raises running, each with a reason and an expiry', async () => {
    const live: { data: EntitlementOverride[] } = await expectOk('GET', '/v1/entitlement-overrides');
    assert.equal(live.data.length, 2, 'two seeded grants, no more');
    for (const override of live.data) {
      assert.equal(override.status, 'active');
      assert.equal(override.effect, 'grant');
      assert.ok(override.expires_at && override.expires_at > app.ctx.now(), 'a temporary raise has an end date');
      assert.ok(override.reason.length > 30, `an override says why: "${override.reason}"`);
      assert.ok(app.ctx.svc.billing.customer(ORG, override.customer), 'on a real billing account');
      const held = await check(override.customer, override.feature);
      assert.equal(held.source?.type, 'override');
      assert.equal(held.limit, override.value, 'the raise is what the product would be told');
    }
  });
});

/* --------------------------- the derived active set ------------------------ */

describe('the set is derived from the subscription, not from a copy of it', () => {
  test('a plan change grants and revokes inside the transaction that changed the plan', async () => {
    const { customer, subscription } = await growthAccount(12);

    // Growth: 10 seats included, 12 bought — the entitlement is what was bought.
    assert.equal(await valueOf(customer, 'seats'), 12);
    assert.equal(await valueOf(customer, 'robots'), 75);
    assert.equal(await valueOf(customer, 'retention'), 365);
    assert.equal(await valueOf(customer, 'sso'), 1);
    assert.equal(await valueOf(customer, 'benchmarking'), 'absent');
    assert.equal(await valueOf(customer, 'predictive'), 'absent');

    const before = await setOf(customer);
    const since = watch(customer, ['entitlement.*']);

    const updated = await expectOk('PATCH', `/v1/subscriptions/${subscription.id}`, {
      items: [
        { id: subscription.items[0].id, price: priceOf('scale_monthly') },
        { id: subscription.items[1].id, price: priceOf('scale_seat_monthly'), quantity: 12 },
        { id: subscription.items[2].id, price: priceOf('telemetry_events_monthly'), quantity: 1 },
      ],
    });
    assert.equal(updated.subscription?.status ?? updated.status, 'active');

    // Scale includes 25 seats, which is more than the 12 on the bill.
    assert.equal(await valueOf(customer, 'seats'), 25);
    assert.equal(await valueOf(customer, 'robots'), 400);
    assert.equal(await valueOf(customer, 'retention'), 1095);
    assert.equal(await valueOf(customer, 'benchmarking'), 1, 'Scale grants benchmarking');
    assert.equal(await valueOf(customer, 'predictive'), 1, 'Scale grants predictive maintenance');

    const after = await setOf(customer);
    assert.ok(after.version > before.version, 'the change is a new entitlement version');

    const emitted = since();
    const granted = emitted.filter((e) => e.type === 'entitlement.granted').map((e) => e.data.feature);
    const changed = emitted.filter((e) => e.type === 'entitlement.changed').map((e) => e.data.feature);
    assert.deepEqual(granted.sort(), ['benchmarking', 'predictive']);
    assert.ok(changed.includes('robots'), `robots should have changed, got ${changed.join(', ')}`);
    assert.ok(changed.includes('seats'));

    const versions: { data: EntitlementVersion[] } = await expectOk('GET', `/v1/customers/${customer}/entitlement-versions`);
    const latest = versions.data[0];
    assert.equal(latest.version, after.version);
    assert.equal(latest.trigger, 'subscription.updated');
    const robots = latest.changes.find((c) => c.feature === 'robots');
    assert.equal(robots?.summary, 'Connected robots raised from 75 robots to 400 robots by Telemetry Cloud Scale.');
  });

  test('a failed transaction takes the entitlements down with the subscription', async () => {
    const { customer, subscription } = await growthAccount(11);
    assert.equal(await valueOf(customer, 'seats'), 11);
    assert.equal(await valueOf(customer, 'benchmarking'), 'absent');

    // Exactly the write the previous test made, abandoned halfway. Entitlements
    // are recomputed by the subscription's own event, inside this transaction,
    // so the rollback has to take both back together.
    assert.throws(() => app.ctx.atomic(() => {
      app.ctx.svc.billing.updateSubscription(ORG, subscription.id, {
        items: [
          { id: subscription.items[0].id, price: priceOf('scale_monthly') },
          { id: subscription.items[1].id, price: priceOf('scale_seat_monthly'), quantity: 11 },
          { id: subscription.items[2].id, price: priceOf('telemetry_events_monthly'), quantity: 1 },
        ],
      });
      throw new Error('the invoice run fell over here');
    }), /the invoice run fell over here/);

    const sub = app.ctx.svc.billing.requireSubscription(ORG, subscription.id);
    assert.equal(sub.items.find((i) => i.id === subscription.items[0].id)?.price, priceOf('growth_monthly'),
      'the subscription rolled back');
    assert.equal(await valueOf(customer, 'seats'), 11, 'and so did the entitlements');
    assert.equal(await valueOf(customer, 'robots'), 75);
    assert.equal(await valueOf(customer, 'benchmarking'), 'absent',
      'nothing Scale would have granted survived the rollback');
  });

  test('every entitlement names the product and price that granted it', async () => {
    const { customer, subscription } = await growthAccount(4);
    const set = await setOf(customer);
    const seats = set.entitlements.find((e) => e.feature === 'seats')!;
    assert.equal(seats.source.type, 'subscription');
    assert.equal(seats.source.subscription, subscription.id);
    assert.equal(seats.source.product, 'prod_nw_growth');
    assert.equal(seats.source.product_name, 'Telemetry Cloud Growth');
    assert.equal(seats.source.description, 'Included in Telemetry Cloud Growth');
    assert.ok(app.ctx.svc.catalog.price(ORG, seats.source.price!), 'the price is a real one');
    assert.equal(seats.value, 10, 'four seats bought is under the ten Growth includes');
  });

  test('cancelling ends the grant; the entitlements go with it', async () => {
    const { customer, subscription } = await growthAccount(6);
    assert.equal(await valueOf(customer, 'robots'), 75);
    await expectOk('POST', `/v1/subscriptions/${subscription.id}/cancel`, {});
    const set = await setOf(customer);
    assert.deepEqual(set.entitlements, [], 'a cancelled subscription grants nothing');
    assert.deepEqual(set.sources, []);
  });
});

/* ----------------------------- cancel_at_period_end ------------------------ */

describe('cancel_at_period_end keeps its entitlements until the period ends', () => {
  test('scheduled cancellation changes when access ends, not whether it exists', async () => {
    const { customer, subscription } = await growthAccount(9);
    const before = await check(customer, 'robots');
    assert.equal(before.limit, 75);
    assert.equal(before.source?.expires_at, null, 'nothing has been scheduled yet');

    const scheduled: Subscription = await expectOk('POST', `/v1/subscriptions/${subscription.id}/cancel`, { at_period_end: true });
    assert.equal(scheduled.cancel_at_period_end, true);
    assert.equal(scheduled.status, 'active');

    const during = await check(customer, 'robots', 20);
    assert.equal(during.allowed, true, 'still entitled the day the cancellation is booked');
    assert.equal(during.limit, 75);
    assert.equal(during.source?.expires_at, scheduled.current_period_end,
      'the set now says exactly when the grant runs out');

    // A day before the period ends, nothing has changed.
    const almost = scheduled.current_period_end - app.ctx.now() - DAY;
    await app.travel(almost);
    assert.equal(await valueOf(customer, 'robots'), 75, 'entitled right up to the end of the period');
    assert.equal((await check(customer, 'seats', 1)).allowed, true);

    // Past the boundary the renewal job cancels it, and only then do the
    // entitlements go.
    await app.travel(2 * DAY);
    const ended = app.ctx.svc.billing.requireSubscription(ORG, subscription.id);
    assert.equal(ended.status, 'canceled');
    assert.equal(await valueOf(customer, 'robots'), 'absent');
    const denied = await check(customer, 'robots', 1);
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'Connected robots is not included on this account.');
  });
});

/* --------------------------------- overrides ------------------------------- */

describe('overrides: a temporary raise that takes itself away', () => {
  test('a grant lifts the ceiling above the plan and names itself as the source', async () => {
    const { customer } = await growthAccount(10);
    assert.equal(await valueOf(customer, 'robots'), 75);

    const override: EntitlementOverride = await expectOk('POST', '/v1/entitlement-overrides', {
      customer, feature: 'robots', value: 260,
      reason: 'Commissioning week at Leeds — second line runs alongside the old one.',
      expires_at: app.ctx.now() + 3 * DAY,
    });
    assert.equal(override.status, 'active');
    assert.equal(override.effect, 'grant');

    const raised = await check(customer, 'robots', 100);
    assert.equal(raised.limit, 260);
    assert.equal(raised.allowed, true);
    assert.equal(raised.source?.type, 'override');
    assert.equal(raised.source?.override, override.id);
    assert.equal(raised.source?.expires_at, override.expires_at);
  });

  test('an override with an expiry ends itself under the time machine', async () => {
    const { customer } = await growthAccount(10);
    const override: EntitlementOverride = await expectOk('POST', '/v1/entitlement-overrides', {
      customer, feature: 'seats', value: 240,
      reason: 'Night-shift trial — extra seats agreed with support for a fortnight.',
      expires_at: app.ctx.now() + 4 * DAY,
    });
    assert.equal(await valueOf(customer, 'seats'), 240);
    const versionWhileRaised = (await setOf(customer)).version;

    await app.travel(3 * DAY);
    assert.equal(await valueOf(customer, 'seats'), 240, 'still raised the day before it lapses');

    await app.travel(2 * DAY);
    const expired: EntitlementOverride = await expectOk('GET', `/v1/entitlement-overrides/${override.id}`);
    assert.equal(expired.status, 'expired');
    assert.equal(await valueOf(customer, 'seats'), 10, 'back to what Growth includes');

    const set = await setOf(customer);
    assert.ok(set.version > versionWhileRaised, 'the lapse is its own auditable version');
    assert.equal(set.entitlements.find((e) => e.feature === 'seats')!.source.type, 'subscription');

    const versions: { data: EntitlementVersion[] } = await expectOk('GET', `/v1/customers/${customer}/entitlement-versions`);
    const lapse = versions.data.find((v) => v.trigger === 'override.expired');
    assert.ok(lapse, 'the expiry is on the audit trail');
    assert.equal(lapse!.reason, 'The temporary grant "Night-shift trial — extra seats agreed with support for a fortnight." expired.');
    assert.equal(lapse!.changes[0].summary, 'Operator seats lowered from 240 seats to 10 seats by Telemetry Cloud Growth.');
  });

  test('a suspension removes the entitlement whatever the plan says, and revoking restores it', async () => {
    const { customer } = await growthAccount(10);
    assert.equal(await valueOf(customer, 'sso'), 1);

    const suspension: EntitlementOverride = await expectOk('POST', '/v1/entitlement-overrides', {
      customer, feature: 'sso', effect: 'suspend',
      reason: 'Identity provider misconfigured after their AD migration — off until they re-verify the metadata.',
    });
    assert.equal(await valueOf(customer, 'sso'), 'absent');
    const blocked = await check(customer, 'sso');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'SAML single sign-on is not included in Telemetry Cloud Growth.');

    await expectOk('DELETE', `/v1/entitlement-overrides/${suspension.id}?reason=Metadata%20re-verified`);
    assert.equal(await valueOf(customer, 'sso'), 1, 'the plan grants it again');
    assert.equal((await expectOk('GET', `/v1/entitlement-overrides/${suspension.id}`)).status, 'revoked');
  });

  test('an override that grants less than the plan does not become the source', async () => {
    const { customer } = await growthAccount(10);
    await expectOk('POST', '/v1/entitlement-overrides', {
      customer, feature: 'robots', value: 40,
      reason: 'Recorded against the account for the audit; the plan already gives more.',
    });
    const set = await setOf(customer);
    const robots = set.entitlements.find((e) => e.feature === 'robots')!;
    assert.equal(robots.value, 75, 'the plan still wins');
    assert.equal(robots.source.type, 'subscription');
  });

  test('an override without a reason is refused', async () => {
    const { customer } = await growthAccount(3);
    await expectError('POST', '/v1/entitlement-overrides', { customer, feature: 'robots', value: 10, reason: '' }, 400, 'parameter_invalid');
    await expectError('POST', '/v1/entitlement-overrides', {
      customer, feature: 'robots', value: 10, reason: 'Backdated by mistake.', expires_at: app.ctx.now() - DAY,
    }, 400, 'override_expiry_in_past');
  });
});

/* ------------------------------ live metered usage ------------------------- */

describe('metered limits are answered from the events, not from a counter', () => {
  const ingest = (customer: string, events: number, at: number) =>
    expectOk('POST', '/v1/meter-events', {
      event_name: 'telemetry_events',
      timestamp: at,
      payload: { customer_id: customer, events },
    });

  test('a check reflects events ingested a second earlier', async () => {
    const { customer, subscription } = await growthAccount(8);
    const fresh = await check(customer, 'events_included');
    assert.equal(fresh.limit, 5_000_000);
    assert.equal(fresh.used, 0);
    assert.equal(fresh.remaining, 5_000_000);

    await ingest(customer, 4_100_000, app.ctx.now() - 1_000);
    const afterFirst = await check(customer, 'events_included');
    assert.equal(afterFirst.used, 4_100_000, 'the event that landed a second ago is already counted');
    assert.equal(afterFirst.remaining, 900_000);
    assert.equal(afterFirst.allowed, true);
    assert.equal(afterFirst.approaching, true, '82% of the allowance is past the 80% threshold');

    await ingest(customer, 400_000, app.ctx.now() - 1_000);
    const afterSecond = await check(customer, 'events_included');
    assert.equal(afterSecond.used, 4_500_000, 'and so is the next one');
    assert.equal(afterSecond.remaining, 500_000);

    const denied = await check(customer, 'events_included', 900_000);
    assert.equal(denied.allowed, false);
    assert.equal(denied.period?.end, subscription.current_period_end,
      'the allowance is measured over the subscription’s own cycle');
    assert.match(
      denied.reason,
      /^Adding 900,000 events would take you to 5,400,000, past the 5,000,000 events included in Telemetry Cloud Growth\. The allowance resets on \w+ \d{1,2}, \d{4}\.$/,
    );
  });

  test('prepaid credit in the meter’s own units raises the allowance', async () => {
    const { customer } = await growthAccount(8);
    await ingest(customer, 4_900_000, app.ctx.now() - 1_000);
    const beforeCredit = await check(customer, 'events_included', 500_000);
    assert.equal(beforeCredit.allowed, false);
    assert.equal(beforeCredit.limit, 5_000_000);

    await expectOk('POST', '/v1/credit-grants', {
      customer, kind: 'unit', meter: 'telemetry_events', unit_label: 'event',
      amount: 2_000_000, category: 'promotional',
      name: 'Burst-month cover',
      reason: 'Agreed with the account team while the third line is commissioned.',
    });

    const withCredit = await check(customer, 'events_included', 500_000);
    assert.equal(withCredit.credit_units, 2_000_000);
    assert.equal(withCredit.included_limit, 5_000_000, 'the plan’s own allowance is unchanged');
    assert.equal(withCredit.limit, 7_000_000);
    assert.equal(withCredit.allowed, true);
    assert.match(withCredit.reason, /That includes 2,000,000 events of prepaid credit\./);
  });

  /**
   * The alarm is a statement about what happened, not about what was asked.
   *
   * `check` is the call a pricing page makes to ask what a bigger plan would
   * cost, and the call the product makes before it does the thing. Only the
   * meter can tell those apart, so only the meter arms the alarm — otherwise
   * the first speculative question of the period silently spends the one mark
   * the real breach was going to need.
   */
  test('the warnings fire once per period, on consumption and never on a question', async () => {
    const { customer } = await growthAccount(8);
    const warnings = watch(customer, ['entitlement.limit_approaching']);
    const refusals = watch(customer, ['entitlement.limit_exceeded']);

    // The pricing-page question, asked against an account that has used nothing.
    const hypothetical = await check(customer, 'events_included', 1_000_000_000);
    assert.equal(hypothetical.allowed, false, 'a billion events does not fit');
    assert.equal(hypothetical.used, 0);
    assert.equal(hypothetical.remaining, 5_000_000);
    assert.deepEqual(refusals(), [], 'nothing was consumed, so nothing was exceeded');

    await ingest(customer, 4_600_000, app.ctx.now() - 1_000);
    for (let i = 0; i < 25; i++) await check(customer, 'events_included');
    const approaching = warnings();
    assert.equal(approaching.length, 1, 'twenty-five checks, one warning');
    assert.equal(approaching[0].data.used, 4_600_000);
    assert.equal(approaching[0].data.limit, 5_000_000);

    // Fifty refusals at 92% used. Every one of them is still only a question.
    for (let i = 0; i < 50; i++) await check(customer, 'events_included', 1_000_000);
    assert.deepEqual(refusals(), [], 'a request that was refused was never consumed');

    // And now they really do go over.
    await ingest(customer, 600_000, app.ctx.now() - 1_000);
    for (let i = 0; i < 25; i++) await check(customer, 'events_included', 1);
    const exceeded = refusals();
    assert.equal(exceeded.length, 1, 'one breach, announced once');
    assert.equal(exceeded[0].data.used, 5_200_000);
    assert.equal(exceeded[0].data.limit, 5_000_000);
    assert.equal(exceeded[0].data.remaining, 0, 'an event titled limit_exceeded reports no allowance left');
    assert.equal(warnings().length, 1, 'and the earlier warning is not repeated');
  });

  test('a limit with no meter is a ceiling on a value, not a running total', async () => {
    const { customer } = await growthAccount(8);
    const resting = await check(customer, 'retention');
    assert.equal(resting.used, 0);
    assert.equal(resting.reason, 'Event retention is 365 days on Telemetry Cloud Growth.');

    const within = await check(customer, 'retention', 90);
    assert.equal(within.allowed, true);
    assert.equal(within.reason, 'Event retention can be set to 90 days — up to 365 days is included in Telemetry Cloud Growth.');

    const beyond = await check(customer, 'retention', 900);
    assert.equal(beyond.allowed, false);
    assert.equal(beyond.reason, 'Event retention cannot be set to 900 days — only 365 days is included in Telemetry Cloud Growth.');
  });
});

/* ------------------------- monthly and annual terms ------------------------ */

/**
 * A plan's allowance is quoted per month, and the customer who pays for the
 * year up front must not receive one twelfth of it. The cycle is the container;
 * the allowance interval is what refills inside it.
 */
describe('a plan includes the same allowance each month on either term', () => {
  const ingest = (customer: string, events: number, at: number) =>
    expectOk('POST', '/v1/meter-events', {
      event_name: 'telemetry_events', timestamp: at,
      payload: { customer_id: customer, events },
    });

  /** The same Telemetry Cloud Growth, bought for a year instead of a month. */
  async function growthAnnualAccount(seats: number, startedDaysAgo = 1): Promise<{ customer: string; subscription: Subscription }> {
    const customer = await expectOk('POST', '/v1/customers', { name: nextName('Annual Works'), currency: 'usd' });
    const subscription = await expectOk('POST', '/v1/subscriptions', {
      customer: customer.id,
      backdate_start_date: app.ctx.now() - startedDaysAgo * DAY,
      items: [
        { price: priceOf('growth_annual'), quantity: 1 },
        { price: priceOf('growth_seat_annual'), quantity: seats },
      ],
    });
    return { customer: customer.id, subscription };
  }

  test('the annual term refills monthly, on the same day and by the same amount', async () => {
    const monthly = await growthAccount(6);
    const annual = await growthAnnualAccount(6);

    // Ten months' money for the year, so the year had better not include less.
    assert.equal(app.ctx.svc.catalog.priceByLookupKey(ORG, 'growth_annual')!.unit_amount, 499000);
    assert.equal(app.ctx.svc.catalog.priceByLookupKey(ORG, 'growth_monthly')!.unit_amount, 49900);
    assert.ok(
      annual.subscription.current_period_end - annual.subscription.current_period_start
      > 300 * DAY, 'the annual subscription really does bill once a year',
    );

    for (const account of [monthly, annual]) await ingest(account.customer, 4_900_000, app.ctx.now() - 1_000);

    const onMonthly = await check(monthly.customer, 'events_included', 200_000);
    const onAnnual = await check(annual.customer, 'events_included', 200_000);

    assert.equal(onAnnual.limit, onMonthly.limit, 'the same plan includes the same allowance');
    assert.equal(onAnnual.used, 4_900_000);
    assert.equal(onAnnual.remaining, onMonthly.remaining);
    assert.deepEqual(onAnnual.period, onMonthly.period, 'and measures it over the same window');
    assert.equal(onAnnual.reason, onMonthly.reason, 'down to the date it says the allowance resets');
    assert.match(onAnnual.reason, /The allowance resets on \w+ \d{1,2}, \d{4}\.$/);
    assert.equal(onAnnual.period!.end, monthly.subscription.current_period_end,
      'the annual account refills on the day the monthly one is invoiced');

    // The window is the allowance's, not the subscription's: the annual term
    // still renews a year out, and the entitlement still knows that.
    const set = await setOf(annual.customer);
    assert.equal(set.sources[0].period_end, annual.subscription.current_period_end);
    assert.ok(onAnnual.period!.end < annual.subscription.current_period_end,
      'the allowance refills eleven times before the invoice comes round again');
  });

  test('mid-term, the year is twelve consecutive windows anchored on the billing day', async () => {
    // Seven months into an annual term: neither the first window nor the last.
    const { customer, subscription } = await growthAnnualAccount(4, 200);
    const answer = await check(customer, 'events_included');
    const window = answer.period!;
    const cycle = { start: subscription.current_period_start, end: subscription.current_period_end };

    assert.ok(window.start > cycle.start && window.end < cycle.end, 'a slice of the term, not the term');
    assert.ok(window.end - window.start >= 28 * DAY && window.end - window.start <= 31 * DAY,
      `one month long, not ${(window.end - window.start) / DAY} days`);
    assert.equal(new Date(window.start).getUTCDate(), new Date(cycle.start).getUTCDate(),
      'anchored on the day the subscription bills, not on the 1st');
    assert.equal(answer.limit, 5_000_000, 'and it is the whole monthly allowance, every month');

    // Events from an earlier month of the same term belong to that month.
    await ingest(customer, 3_000_000, window.start - 5 * DAY);
    const stillClean = await check(customer, 'events_included');
    assert.equal(stillClean.used, 0, 'last month’s traffic is not charged against this month’s allowance');

    await ingest(customer, 1_250_000, window.start + 1_000);
    const thisMonth = await check(customer, 'events_included');
    assert.equal(thisMonth.used, 1_250_000);
    assert.equal(thisMonth.remaining, 3_750_000);
  });

  test('no live account in the workspace is measured over a window longer than its allowance', async () => {
    const rows = app.ctx.db.all<{ customer_id: string; feature_key: string }>(
      `SELECT customer_id, feature_key FROM entitlement_active
       WHERE org_id = ? AND feature_key = 'events_included' AND unlimited = 0
         AND period_end - period_start > ?`, ORG, 40 * DAY,
    );
    assert.ok(rows.length > 0, 'the demo workspace ships annual terms with a capped allowance');
    for (const row of rows) {
      const answer = await check(row.customer_id, row.feature_key);
      const length = answer.period!.end - answer.period!.start;
      assert.ok(length <= 31 * DAY,
        `${row.customer_id} is measured over ${Math.round(length / DAY)} days of a ${answer.limit} event allowance`);
    }
  });
});

/* -------------------------------- upgrade paths ---------------------------- */

describe('every refusal names the plan that would let them through', () => {
  test('check returns a usable upgrade path for every capped feature in the seeded catalog', async () => {
    const features: { data: Feature[] } = await expectOk('GET', '/v1/features');
    const capped = features.data.filter((f) => f.type === 'limit' || f.type === 'metered');
    assert.ok(capped.length >= 4, 'the seeded catalog has capped features to check');

    const starter = app.ctx.db.get<{ customer_id: string }>(
      `SELECT customer_id FROM entitlement_active WHERE org_id = ? AND source_product = 'prod_nw_starter' LIMIT 1`, ORG,
    );
    assert.ok(starter, 'the demo workspace has a Starter account');

    for (const feature of capped) {
      const result = await check(starter!.customer_id, feature.key, 1_000_000_000);
      assert.equal(result.allowed, false, `${feature.key} should refuse a billion`);
      const path = result.upgrade_path;
      assert.ok(path, `${feature.key} must name a way through — got none`);

      const product = app.ctx.svc.catalog.product(ORG, path!.product);
      const price = app.ctx.svc.catalog.price(ORG, path!.price);
      assert.ok(product, `${feature.key}: upgrade path names a real product`);
      assert.ok(price, `${feature.key}: upgrade path names a real price`);
      assert.equal(price!.product, product!.id, `${feature.key}: the price belongs to the product`);
      assert.equal(path!.product_name, product!.name);
      assert.ok(path!.unlimited || (path!.value ?? 0) > (result.limit ?? 0),
        `${feature.key}: an upgrade has to actually raise the ceiling`);
      assert.match(path!.message, new RegExp(`^${product!.name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}|^Add `),
        `${feature.key}: the message leads with the product`);
      assert.ok(path!.message.endsWith('.'), `${feature.key}: the message is a sentence`);
      assert.ok(path!.amount === null || path!.amount > 0, `${feature.key}: a real price or an honest null`);
    }
  });

  test('the smallest sufficient rung wins, and the top of the ladder has none', async () => {
    const { customer } = await growthAccount(10);
    const modest = await check(customer, 'robots', 200);
    assert.equal(modest.upgrade_path?.product, 'prod_nw_scale', 'Scale covers 200 robots; Enterprise is not needed');
    assert.equal(
      modest.upgrade_path?.message,
      'Telemetry Cloud Scale raises connected robots to 400 robots: $1,900.00 per month.',
    );

    const enormous = await check(customer, 'robots', 4_000);
    assert.equal(enormous.upgrade_path?.product, 'prod_nw_enterprise', 'nothing else reaches that far');

    const enterprise = app.ctx.db.get<{ customer_id: string }>(
      `SELECT customer_id FROM entitlement_active WHERE org_id = ? AND source_product = 'prod_nw_enterprise' LIMIT 1`, ORG,
    );
    if (enterprise) {
      const top = await check(enterprise.customer_id, 'robots', 10_000);
      assert.equal(top.allowed, true);
      assert.equal(top.unlimited, true);
      assert.equal(top.upgrade_path, null, 'there is nowhere further up to send them');
    }
  });

  /**
   * Opening a region is a morning's work for a pricing team, and the gate is
   * the last thing in the building that may notice. A plan the customer cannot
   * be sold in their own money is not on their upgrade path — `null` is the
   * honest answer, and `check` answers.
   */
  test('a plan listed in a second currency does not take the gate down for the first', async () => {
    const holders = app.ctx.db.all<{ customer_id: string }>(
      `SELECT DISTINCT customer_id FROM entitlement_active WHERE org_id = ? AND feature_key = 'robots'`, ORG,
    ).map((r) => r.customer_id);
    assert.ok(holders.length >= 10, 'the workspace has a book of accounts holding a robot ceiling');
    const before = new Map<string, number | null>();
    for (const customer of holders) before.set(customer, (await check(customer, 'robots', 1)).limit);

    // A Japanese plan, listed and told what it includes. Nothing else changes.
    const product = await expectOk('POST', '/v1/products', {
      name: nextName('Telemetry Cloud Japan'),
      description: 'The Growth fleet plan sold from the Osaka entity, priced and invoiced in yen.',
    });
    const price = await expectOk('POST', '/v1/prices', {
      product: product.id, currency: 'jpy', unit_amount: 250_000, recurring: { interval: 'month' },
    });
    await expectOk('POST', '/v1/product-features', { product: product.id, feature: 'robots', value: 150 });

    for (const customer of holders) {
      const answer = await check(customer, 'robots', 1);
      assert.equal(answer.limit, before.get(customer), `${customer} is entitled to exactly what it was`);
      assert.notEqual(answer.upgrade_path?.product, product.id,
        'a plan they cannot be quoted is not the way through');
      // The call every other module and every hot path actually makes.
      assert.equal(typeof app.ctx.svc.entitlements.allows(ORG, customer, 'robots', 1), 'boolean');
    }

    // And the account that can be sold it sees it, priced in its own money.
    const osaka = await expectOk('POST', '/v1/customers', { name: nextName('Sanyo Seiki'), currency: 'jpy' });
    await expectOk('POST', '/v1/subscriptions', { customer: osaka.id, items: [{ price: price.id, quantity: 1 }] });
    const inYen = await check(osaka.id, 'robots', 1);
    assert.equal(inYen.limit, 150);
    assert.equal(inYen.source?.product, product.id);
    assert.equal(inYen.upgrade_path, null, 'nothing in the price book sells a bigger fleet in yen');

    // A dollar account still climbs the dollar ladder, unchanged.
    const { customer } = await growthAccount(9);
    const modest = await check(customer, 'robots', 200);
    assert.equal(modest.upgrade_path?.product, 'prod_nw_scale');
    assert.equal(modest.upgrade_path?.currency, 'usd');
  });
});

/* ------------------------------ the feature model -------------------------- */

describe('features, and what each product includes of them', () => {
  test('a feature key is immutable, checked, and never reused', async () => {
    const key = `fx_${(seq++).toString(36)}_gate`;
    const feature: Feature = await expectOk('POST', '/v1/features', {
      key, name: 'Fixture gate', type: 'boolean', description: 'A boolean the fixtures switch on.',
    });
    assert.equal(feature.key, key);
    await expectError('POST', '/v1/features', { key, name: 'Another', type: 'boolean' }, 409, 'feature_key_taken');
    await expectError('POST', '/v1/features', { key: 'Not A Key', name: 'x', type: 'boolean' }, 400, 'feature_key_invalid');
    await expectError('POST', '/v1/features', { key: `${key}_m`, name: 'x', type: 'metered' }, 400, 'feature_meter_required');
    await expectError('POST', '/v1/features', { key: `${key}_n`, name: 'x', type: 'limit', meter: 'no_such_meter' }, 400, 'meter_missing');
    await expectError('POST', '/v1/entitlements/check', { customer: 'cus_missing', feature: 'no_such_feature' }, 404, 'resource_missing');
    // A mistyped customer id must not read as a silent downgrade.
    const missing = await expectError('POST', '/v1/entitlements/check', { customer: 'cus_missing', feature: 'robots' }, 404, 'resource_missing');
    assert.match(missing.message, /No such customer: cus_missing/);
  });

  test('a product declares how much of a feature it includes, and the value follows the seat count', async () => {
    const key = `fx_${(seq++).toString(36)}_lanes`;
    await expectOk('POST', '/v1/features', { key, name: 'Fixture lanes', type: 'limit', unit_label: 'lane' });
    await expectOk('POST', '/v1/product-features', { product: 'prod_nw_growth', feature: key, value: 25 });
    await expectOk('POST', '/v1/product-features', { product: 'prod_nw_scale', feature: key, value: 250 });

    const { customer } = await growthAccount(5);
    assert.equal(await valueOf(customer, key), 25, 'Growth grants 25 where Scale grants 250');

    const declared = await expectOk('GET', `/v1/product-features?feature=${key}`);
    assert.equal(declared.data.length, 2);
    assert.equal(declared.data.find((d: any) => d.product === 'prod_nw_scale').value, 250);

    const result = await check(customer, key, 40);
    assert.equal(result.allowed, false);
    assert.equal(result.upgrade_path?.product, 'prod_nw_scale');
    assert.equal(result.upgrade_path?.value, 250);
  });

  test('a feature default reaches accounts no product grants it to', async () => {
    const key = `fx_${(seq++).toString(36)}_free`;
    const { customer } = await growthAccount(5);
    await expectOk('POST', '/v1/features', {
      key, name: 'Fixture sandbox projects', type: 'limit', unit_label: 'project', default_value: 3,
    });
    app.ctx.svc.entitlements.recompute(ORG, customer, { trigger: 'test', reason: 'A new default was published.' });
    const set = await setOf(customer);
    const row = set.entitlements.find((e) => e.feature === key)!;
    assert.equal(row.value, 3);
    assert.equal(row.source.type, 'feature_default');
    assert.equal(row.source.description, 'Included for every account');
  });

  test('deactivating a feature revokes it from everyone holding it', async () => {
    const key = `fx_${(seq++).toString(36)}_beta`;
    await expectOk('POST', '/v1/features', { key, name: 'Fixture beta console', type: 'boolean' });
    await expectOk('POST', '/v1/product-features', { product: 'prod_nw_growth', feature: key });
    const { customer } = await growthAccount(5);
    assert.equal(await valueOf(customer, key), 1);

    await expectOk('PATCH', `/v1/features/${key}`, { active: false });
    assert.equal(await valueOf(customer, key), 'absent', 'a withdrawn feature is withdrawn everywhere');
  });
});

/* ---------------------------------- the API -------------------------------- */

describe('the surface a product actually integrates against', () => {
  test('a customer’s entitlements come back with sources, usage and the overrides shaping them', async () => {
    const { customer, subscription } = await growthAccount(7);
    const set = await setOf(customer);
    assert.equal(set.object, 'entitlement_set');
    assert.equal(set.customer, customer);
    assert.deepEqual(set.sources.map((s) => s.subscription), [subscription.id]);
    const metered = set.entitlements.find((e) => e.feature === 'events_included')!;
    assert.equal(metered.usage?.meter_name, 'Telemetry events');
    assert.equal(metered.usage?.limit, 5_000_000);
    assert.equal(metered.usage?.percent_used, 0);
    for (const row of set.entitlements as ActiveEntitlement[]) {
      assert.equal(row.object, 'active_entitlement');
      assert.ok(row.feature_name.length > 0);
      assert.ok(row.source.description.length > 0);
    }

    const withoutUsage: EntitlementSet = await expectOk('GET', `/v1/customers/${customer}/entitlements?usage=false`);
    assert.equal(withoutUsage.entitlements.find((e) => e.feature === 'events_included')!.usage, null);
  });

  test('the overview lists adoption and the accounts pressing against a ceiling', async () => {
    const overview = await expectOk('GET', '/v1/entitlements/overview');
    const robots = overview.features.find((f: any) => f.feature === 'robots');
    assert.ok(robots.accounts > 0, 'the demo workspace grants robots to somebody');
    assert.ok(robots.granted_by >= 4, 'four plans declare a robot ceiling');
    const sso = overview.features.find((f: any) => f.feature === 'sso');
    assert.deepEqual(sso.at_risk, [], 'a boolean has nothing to run out of');
  });

  /**
   * The shape an edge cache holds, and the one event that replaces it. Stripe
   * documents its equivalent as eventually consistent and tells you to trust
   * the webhook over a read; this one is published inside the transaction that
   * moved the set, so the two can never disagree.
   */
  test('one payload carries the whole set, delivered the moment it moves and readable on demand', async () => {
    const { customer, subscription } = await growthAccount(11);
    const summaries = watch(customer, ['entitlement_summary.updated']);

    const onCreate = await expectOk('GET', `/v1/customers/${customer}/entitlement-summary`);
    assert.equal(onCreate.object, 'entitlement_summary');
    assert.equal(onCreate.customer, customer);
    const seats = onCreate.entitlements.find((e: any) => e.feature === 'seats');
    assert.equal(seats.value, 11, 'eleven seats bought beats the ten Growth includes');
    assert.equal(seats.source, 'subscription');
    assert.equal(seats.period_end, subscription.current_period_end);
    assert.equal(onCreate.entitlements.find((e: any) => e.feature === 'benchmarking'), undefined);

    // Every row in the summary is retrievable on its own id, the way a cache
    // that holds the summary would go back for the detail behind one line.
    const one: ActiveEntitlement = await expectOk('GET', `/v1/active-entitlements/${seats.id}`);
    assert.equal(one.object, 'active_entitlement');
    assert.equal(one.feature, 'seats');
    assert.equal(one.customer, customer);
    assert.equal(one.source.subscription, subscription.id);
    await expectError('GET', '/v1/active-entitlements/ent_nothing', undefined, 404, 'resource_missing');

    // An abandoned plan change publishes no summary, because it never happened.
    assert.throws(() => app.ctx.atomic(() => {
      app.ctx.svc.billing.updateSubscription(ORG, subscription.id, {
        items: [{ id: subscription.items[0].id, price: priceOf('scale_monthly') }],
      });
      throw new Error('the invoice run fell over here');
    }), /the invoice run fell over here/);
    assert.deepEqual(summaries(), [], 'a rolled-back set was never summarised');

    // A real one publishes exactly one, and it agrees with the read.
    await expectOk('PATCH', `/v1/subscriptions/${subscription.id}`, {
      items: [
        { id: subscription.items[0].id, price: priceOf('scale_monthly') },
        { id: subscription.items[1].id, price: priceOf('scale_seat_monthly'), quantity: 11 },
        { id: subscription.items[2].id, price: priceOf('telemetry_events_monthly'), quantity: 1 },
      ],
    });
    const delivered = summaries();
    assert.equal(delivered.length, 1, 'one plan change, one summary');
    const afterwards = await expectOk('GET', `/v1/customers/${customer}/entitlement-summary`);
    assert.equal(delivered[0].data.version, afterwards.version, 'the delivered version is the one on file');
    assert.deepEqual(
      delivered[0].data.entitlements.map((e: any) => `${e.feature}=${e.unlimited ? 'unlimited' : e.value}`).sort(),
      afterwards.entitlements.map((e: any) => `${e.feature}=${e.unlimited ? 'unlimited' : e.value}`).sort(),
      'and the payload is the read, byte for byte',
    );
    assert.ok(afterwards.entitlements.some((e: any) => e.feature === 'benchmarking'), 'Scale brought benchmarking with it');
  });

  test('the copilot can ask the same questions the API answers', async () => {
    const { customer } = await growthAccount(6);
    const tool = app.ctx.ai.tools().find((t) => t.name === 'entitlements.check');
    assert.ok(tool, 'the entitlements tool is registered');
    const answer = await tool!.run({ customer, feature: 'robots', requested: 5 }, app.ctx, { orgId: ORG }) as EntitlementCheck;
    assert.equal(answer.allowed, true);
    assert.equal(answer.limit, 75);
  });
});

/* -------------------------------- the hot path ----------------------------- */

describe('fast enough to sit in front of the product', () => {
  test('a check on the seeded workspace answers in well under a millisecond', async () => {
    const customers = app.ctx.db
      .all<{ customer_id: string }>(`SELECT DISTINCT customer_id FROM entitlement_active WHERE org_id = ?`, ORG)
      .map((r) => r.customer_id);
    const features = app.ctx.svc.entitlements.features(ORG, { active: true }).map((f) => f.key);
    assert.ok(customers.length >= 10 && features.length >= 8, 'there is a real workspace to measure against');

    const time = (customer: string, feature: string): number => {
      const started = process.hrtime.bigint();
      app.ctx.svc.entitlements.check(ORG, { customer, feature, requested: 1 });
      return Number(process.hrtime.bigint() - started) / 1000;
    };

    // Cold: nothing memoised, every ladder built from the catalog on demand.
    const cold: number[] = [];
    for (const customer of customers) for (const feature of features) cold.push(time(customer, feature));

    // Warm: the steady state a running process is actually in.
    const warm: number[] = [];
    for (let pass = 0; pass < 5; pass++) {
      for (const customer of customers) for (const feature of features) warm.push(time(customer, feature));
    }

    const stats = (samples: number[]) => {
      const sorted = samples.slice().sort((a, b) => a - b);
      const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      return {
        n: sorted.length,
        mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1],
      };
    };
    const w = stats(warm);
    const c = stats(cold);
    const line = (label: string, s: ReturnType<typeof stats>) =>
      `  ${label.padEnd(6)} n=${String(s.n).padStart(5)}  mean=${s.mean.toFixed(1).padStart(7)}us  p50=${s.p50.toFixed(1).padStart(7)}us  p95=${s.p95.toFixed(1).padStart(7)}us  p99=${s.p99.toFixed(1).padStart(7)}us  max=${s.max.toFixed(1).padStart(8)}us`;
    console.log(`\nentitlements.check over ${customers.length} seeded customers x ${features.length} features`);
    console.log(line('cold', c));
    console.log(line('warm', w));

    assert.ok(w.p50 < 1000, `warm p50 ${w.p50.toFixed(1)}us must be under a millisecond`);
    assert.ok(w.p95 < 1000, `warm p95 ${w.p95.toFixed(1)}us must be under a millisecond`);
    assert.ok(c.p50 < 1000, `cold p50 ${c.p50.toFixed(1)}us must be under a millisecond`);
  });
});

/* ------------------------------ the demo workspace ------------------------- */

describe('the seeded workspace tells one story', () => {
  test('every plan in the price book declares what it includes', async () => {
    for (const product of ['prod_nw_starter', 'prod_nw_growth', 'prod_nw_scale', 'prod_nw_enterprise']) {
      const declared = await expectOk('GET', `/v1/product-features?product=${product}`);
      const keys = declared.data.map((d: any) => d.feature).sort();
      for (const required of ['events_included', 'retention', 'robots', 'seats']) {
        assert.ok(keys.includes(required), `${product} must say what it includes of ${required}`);
      }
    }
    const starterRobots = (await expectOk('GET', '/v1/product-features?product=prod_nw_starter&feature=robots')).data[0];
    const growthRobots = (await expectOk('GET', '/v1/product-features?product=prod_nw_growth&feature=robots')).data[0];
    const scaleRobots = (await expectOk('GET', '/v1/product-features?product=prod_nw_scale&feature=robots')).data[0];
    assert.equal(starterRobots.value, 10);
    assert.equal(growthRobots.value, 75);
    assert.equal(scaleRobots.value, 400);
    assert.equal((await expectOk('GET', '/v1/product-features?product=prod_nw_enterprise&feature=robots')).data[0].unlimited, true);
  });

  test('every account with a live subscription has a derived, versioned set', async () => {
    const subscribed = app.ctx.db.all<{ customer_id: string }>(
      `SELECT DISTINCT customer_id FROM billing_subscriptions
       WHERE org_id = ? AND status IN ('trialing','active','past_due','unpaid','paused')`, ORG,
    ).map((r) => r.customer_id);
    assert.ok(subscribed.length >= 15, 'the demo workspace has a book of business');
    for (const customer of subscribed) {
      const set = await setOf(customer);
      assert.ok(set.entitlements.length > 0, `${customer} has entitlements`);
      assert.ok(set.version > 0, `${customer} has a version history`);
      for (const row of set.entitlements) {
        assert.ok(row.unlimited || typeof row.value === 'number', `${customer}/${row.feature} has a value`);
      }
    }
  });
});

/* ------------------------- a year through the machine ---------------------- */

// Last, because it moves the workspace clock a long way forward.
describe('replaying the billing year leaves nothing out of step', () => {
  test('after 180 days of renewals, cancellations and expiries every row still agrees with its source', async () => {
    const outcome = await app.travel(180 * DAY);
    assert.equal(outcome.failed, 0, 'no job failed on the way through');

    // The period a metered allowance is measured over is copied onto the row
    // when the subscription moves. If a renewal ever failed to bring it along,
    // an account would be charged against a window that had already closed.
    const drift = app.ctx.db.all<{ feature_key: string; customer_id: string }>(
      `SELECT e.customer_id, e.feature_key FROM entitlement_active e
       JOIN billing_subscriptions s ON s.id = e.source_subscription
       WHERE e.org_id = ? AND e.period_end IS NOT NULL AND e.period_end <> s.current_period_end`, ORG,
    );
    assert.deepEqual(drift, [], 'every stored period is the one its subscription is actually in');

    const orphans = app.ctx.db.all<{ id: string }>(
      `SELECT e.id FROM entitlement_active e
       LEFT JOIN billing_subscriptions s ON s.id = e.source_subscription
       WHERE e.org_id = ? AND e.source_type = 'subscription'
         AND (s.id IS NULL OR s.status IN ('canceled','incomplete_expired'))`, ORG,
    );
    assert.deepEqual(orphans, [], 'nothing is still granted by a subscription that ended');

    const stale = app.ctx.db.all<{ feature_key: string }>(
      `SELECT DISTINCT e.feature_key FROM entitlement_active e
       LEFT JOIN entitlement_features f ON f.org_id = e.org_id AND f.key = e.feature_key
       WHERE e.org_id = ? AND (f.key IS NULL OR f.active = 0)`, ORG,
    );
    assert.deepEqual(stale, [], 'nothing is granted for a feature that no longer exists');

    const lapsed = app.ctx.db.count(
      `SELECT COUNT(*) FROM entitlement_overrides WHERE org_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
      ORG, app.ctx.now(),
    );
    assert.equal(lapsed, 0, 'every override past its expiry has taken itself away');

    // And the answers still come out: a spot check across whatever survived.
    const survivors = app.ctx.db.all<{ customer_id: string }>(
      `SELECT DISTINCT customer_id FROM entitlement_active WHERE org_id = ? LIMIT 5`, ORG,
    );
    assert.ok(survivors.length > 0, 'the workspace still has entitled accounts a year on');
    for (const row of survivors) {
      const answer = await check(row.customer_id, 'robots', 1);
      assert.ok(answer.reason.endsWith('.'), 'the reason is still a sentence');
      assert.equal(typeof answer.allowed, 'boolean');
    }
  });
});
