import { createApp, frozenClock, type App } from './src/server/app';
import type { Auth } from './src/server/kernel/http';
import { DAY } from './src/shared/time';
const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const app: App = await createApp({ db: 'memory', clock: frozenClock(Date.UTC(2026, 5, 2, 9, 17, 34, 512)), config: { env: 'test' } });
const call = (m: string, p: string, b?: unknown) => app.handle({ method: m, path: p, body: b, auth: DANA });
async function ok(m: string, p: string, b?: unknown): Promise<any> {
  const r = await call(m, p, b); if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body;
}
const check = (c: string, f: string, req = 0) => ok('POST', '/v1/entitlements/check', { customer: c, feature: f, requested: req });
const pid = (k: string) => app.ctx.svc.catalog.priceByLookupKey(ORG, k)!.id;
let seq = 0; const nm = (p: string) => `${p} ${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

console.log('=== M. a real mid-cycle upgrade then downgrade ===');
const cus = await ok('POST', '/v1/customers', { name: nm('Swap Works'), currency: 'usd' });
const sub = await ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: pid('growth_monthly'), quantity: 1 }] });
const mid = Math.floor((sub.current_period_end - sub.current_period_start) / 2);
await app.travel(mid);
const up = await ok('PATCH', `/v1/subscriptions/${sub.id}`, {
  items: [{ id: sub.items[0].id, deleted: true }, { price: pid('scale_monthly'), quantity: 1 }], proration_behavior: 'create_prorations',
});
const cUp = await check(cus.id, 'robots');
console.log('  after upgrade at the exact midpoint: items=', up.items.map((i: any) => i.price).join(','), ' robots=', cUp.limit, ' events=', (await check(cus.id, 'events_included')).limit);
await app.travel(DAY);
const down = await ok('PATCH', `/v1/subscriptions/${sub.id}`, {
  items: [{ id: up.items.find((i: any) => i.price === pid('scale_monthly')).id, deleted: true }, { price: pid('starter_monthly'), quantity: 1 }], proration_behavior: 'create_prorations',
});
const cDown = await check(cus.id, 'robots');
console.log('  after downgrade: items=', down.items.map((i: any) => i.price).join(','), ' robots=', cDown.limit, ' source=', cDown.source.product_name);
const set = await ok('GET', `/v1/customers/${cus.id}/entitlements`);
console.log('  full set:', set.entitlements.map((e: any) => `${e.feature}=${e.unlimited ? 'inf' : e.value}`).join(' '));
const vers = await ok('GET', `/v1/customers/${cus.id}/entitlement-versions`);
console.log('  versions:', vers.data.map((v: any) => `${v.version}:${v.trigger}`).join(' '));
const invs = app.ctx.db.all<any>(`SELECT * FROM billing_invoices WHERE org_id=? AND customer_id=?`, ORG, cus.id);
for (const inv of invs) {
  const lines = app.ctx.db.all<any>(`SELECT amount, description FROM billing_invoice_lines WHERE invoice_id=? AND released=0`, inv.id);
  const sum = lines.reduce((a: number, l: any) => a + l.amount, 0);
  console.log(`   ${inv.number} ${inv.status}: lines=${sum} subtotal=${inv.subtotal} tax=${inv.tax} total=${inv.total}`,
    sum === inv.subtotal && inv.subtotal + inv.tax + inv.balance_applied === inv.total ? 'OK' : 'MISMATCH');
}

console.log('=== N. does a downgrade lower the metered allowance mid-window? ===');
{
  const c2 = await check(cus.id, 'events_included');
  console.log('  events allowance now =', c2.included_limit, ' (Starter includes 500,000)  window=', new Date(c2.period.start).toISOString(), '->', new Date(c2.period.end).toISOString());
}

console.log('=== O. seat-quantity entitlement follows the bill ===');
{
  const c3 = await ok('POST', '/v1/customers', { name: nm('Seat Works'), currency: 'usd' });
  const s3 = await ok('POST', '/v1/subscriptions', { customer: c3.id, items: [{ price: pid('growth_monthly'), quantity: 1 }, { price: pid('growth_seat_monthly'), quantity: 34 }] });
  console.log('  34 seats bought -> seats limit =', (await check(c3.id, 'seats')).limit, '(expect 34)');
  const seatItem = s3.items.find((i: any) => i.price === pid('growth_seat_monthly'));
  await ok('PATCH', `/v1/subscriptions/${s3.id}`, { items: [{ id: seatItem.id, quantity: 0 }], proration_behavior: 'create_prorations' });
  console.log('  quantity dropped to 0 -> seats limit =', (await check(c3.id, 'seats')).limit, '(Growth includes 10)');
  await ok('PATCH', `/v1/subscriptions/${s3.id}`, { items: [{ id: seatItem.id, quantity: 1_000_000_000 }], proration_behavior: 'none' });
  const big = await check(c3.id, 'seats', 1);
  console.log('  quantity 1e9 -> seats limit =', big.limit, ' allowed=', big.allowed, ' upgrade=', big.upgrade_path?.product_name ?? null);
}
app.close();
