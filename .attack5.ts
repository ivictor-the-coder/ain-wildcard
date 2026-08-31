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

const cus = await ok('POST', '/v1/customers', { name: nm('Downgrade Works'), currency: 'usd' });
const sub = await ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: pid('growth_monthly'), quantity: 1 }] });
console.log('items after create:', sub.items.map((i: any) => i.price));
await app.travel(5 * DAY);
const up = await ok('PATCH', `/v1/subscriptions/${sub.id}`, { items: [{ price: pid('scale_monthly'), quantity: 1 }], proration_behavior: 'create_prorations' });
console.log('items after upgrade :', up.items.map((i: any) => `${i.price} x${i.quantity}`), 'robots=', (await check(cus.id, 'robots')).limit);
await app.travel(DAY);
const down = await ok('PATCH', `/v1/subscriptions/${sub.id}`, { items: [{ price: pid('starter_monthly'), quantity: 1 }], proration_behavior: 'create_prorations' });
console.log('items after downgrade:', down.items.map((i: any) => `${i.price} x${i.quantity}`));
const c = await check(cus.id, 'robots');
console.log('robots after downgrade =', c.limit, ' source product=', c.source.product, c.source.product_name);
console.log('live subscription items:', app.ctx.svc.billing.subscription(ORG, sub.id)!.items.map((i: any) => i.price));
const set = await ok('GET', `/v1/customers/${cus.id}/entitlements`);
console.log('entitlement set:', set.entitlements.map((e: any) => `${e.feature}=${e.unlimited ? 'inf' : e.value}(${e.source.product_name ?? e.source.type})`).join(' '));

// what does a fresh recompute say?
app.ctx.svc.entitlements.recompute(ORG, cus.id, { trigger: 'audit', reason: 'critic' });
const set2 = await ok('GET', `/v1/customers/${cus.id}/entitlements`);
console.log('after forced recompute:', set2.entitlements.map((e: any) => `${e.feature}=${e.unlimited ? 'inf' : e.value}(${e.source.product_name ?? e.source.type})`).join(' '));

// invoice total formula on the seeded book
const cols = app.ctx.db.all<any>(`PRAGMA table_info(billing_invoices)`).map((r: any) => r.name);
console.log('invoice columns:', cols.join(','));
const inv = app.ctx.db.get<any>(`SELECT * FROM billing_invoices WHERE org_id=? AND total <> subtotal + balance_applied LIMIT 1`, ORG);
if (inv) console.log('example non-matching invoice:', JSON.stringify({ number: inv.number, subtotal: inv.subtotal, tax: inv.tax, balance_applied: inv.balance_applied, total: inv.total }));
app.close();
