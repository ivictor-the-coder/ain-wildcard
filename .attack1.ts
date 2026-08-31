import { createApp, frozenClock, type App } from './src/server/app';
import type { Auth } from './src/server/kernel/http';
import { DAY } from './src/shared/time';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const T0 = Date.UTC(2026, 5, 2, 9, 17, 34, 512);
const app: App = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } });
const call = (m: string, p: string, b?: unknown) => app.handle({ method: m, path: p, body: b, auth: DANA });
async function ok(m: string, p: string, b?: unknown): Promise<any> {
  const r = await call(m, p, b);
  if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const check = (c: string, f: string, req = 0) => ok('POST', '/v1/entitlements/check', { customer: c, feature: f, requested: req });
let seq = 0;
const nm = (p: string) => `${p} ${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

console.log('=== A. boolean feature with default_value 0 ===');
{
  const key = `atk_bool_${seq++}`;
  await ok('POST', '/v1/features', { key, name: 'Attack bool', type: 'boolean', default_value: 0 });
  const cus = await ok('POST', '/v1/customers', { name: nm('BoolCo'), currency: 'usd' });
  // force a recompute for this customer
  await ok('POST', '/v1/entitlement-overrides', { customer: cus.id, feature: 'sso', effect: 'suspend', reason: 'force a recompute for the fixture' });
  const c = await check(cus.id, key, 1);
  console.log('  default_value:0 boolean -> allowed=', c.allowed, ' value=', c.limit, ' reason=', c.reason);
  const set = await ok('GET', `/v1/customers/${cus.id}/entitlements`);
  const row = set.entitlements.find((e: any) => e.feature === key);
  console.log('  stored row:', row ? { value: row.value, unlimited: row.unlimited, source: row.source.type } : null);
}

console.log('=== B. currency of a customer with no stored row ===');
{
  const jp = await ok('POST', '/v1/customers', { name: nm('Kyoto Kikai'), currency: 'jpy' });
  const c = await check(jp.id, 'robots', 5);
  console.log('  customer.currency=jpy, no subscription -> upgrade currency=', c.upgrade_path?.currency,
    ' amount=', c.upgrade_path?.amount, ' msg=', JSON.stringify(c.upgrade_path?.message));
  const bh = await ok('POST', '/v1/customers', { name: nm('Manama Metals'), currency: 'bhd' });
  const c2 = await check(bh.id, 'robots', 5);
  console.log('  customer.currency=bhd -> upgrade currency=', c2.upgrade_path?.currency, ' msg=', JSON.stringify(c2.upgrade_path?.message));
}

console.log('=== C. what-if check must not disarm limit_exceeded ===');
{
  const cus = await ok('POST', '/v1/customers', { name: nm('WhatIf Works'), currency: 'usd' });
  const price = app.ctx.svc.catalog.priceByLookupKey(ORG, 'growth_monthly');
  const sub = await ok('POST', '/v1/subscriptions', { customer: cus.id, backdate_start_date: app.ctx.now() - DAY, items: [{ price: price.id, quantity: 1 }] });
  const evs = () => app.ctx.db.all<any>(`SELECT type FROM events WHERE org_id = ? AND type = 'entitlement.limit_exceeded' AND object_id = ?`, ORG, cus.id).length;
  const before = evs();
  await check(cus.id, 'events_included', 900_000_000); // huge what-if
  console.log('  after speculative check, exceeded events =', evs() - before, '(expect 0)');
  // now really consume past the 5,000,000 allowance
  await ok('POST', '/v1/meter-events', { event_name: 'telemetry_events', customer: cus.id, value: 6_000_000, identifier: `atk-${seq++}` });
  await check(cus.id, 'events_included', 1);
  console.log('  after real consumption, exceeded events =', evs() - before, '(expect 1)');
  await check(cus.id, 'events_included', 1);
  console.log('  after a second check, exceeded events =', evs() - before, '(expect still 1)');
}

console.log('=== D. annual vs monthly allowance ===');
{
  const mk = async (lookup: string) => {
    const cus = await ok('POST', '/v1/customers', { name: nm('Term Co'), currency: 'usd' });
    const price = app.ctx.svc.catalog.priceByLookupKey(ORG, lookup);
    await ok('POST', '/v1/subscriptions', { customer: cus.id, backdate_start_date: app.ctx.now() - DAY, items: [{ price: price.id, quantity: 1 }] });
    return cus.id;
  };
  const m = await mk('growth_monthly');
  const y = await mk('growth_annual');
  const cm = await check(m, 'events_included', 0);
  const cy = await check(y, 'events_included', 0);
  console.log('  monthly limit=', cm.limit, ' window=', new Date(cm.period.start).toISOString(), '->', new Date(cm.period.end).toISOString());
  console.log('  annual  limit=', cy.limit, ' window=', new Date(cy.period.start).toISOString(), '->', new Date(cy.period.end).toISOString());
  console.log('  equal allowance:', cm.limit === cy.limit, ' equal window length:',
    (cm.period.end - cm.period.start) === (cy.period.end - cy.period.start));
}
app.close();
