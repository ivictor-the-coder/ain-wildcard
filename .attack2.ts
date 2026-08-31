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
const pid = (k: string) => app.ctx.svc.catalog.priceByLookupKey(ORG, k)!.id;

console.log('=== E. jpy customer, jpy plan in the book, entitlement from a support override ===');
{
  const prod = await ok('POST', '/v1/products', { name: nm('Telemetry Cloud Osaka') });
  const jpPrice = await ok('POST', '/v1/prices', { product: prod.id, currency: 'jpy', unit_amount: 250000, recurring: { interval: 'month' } });
  await ok('POST', '/v1/product-features', { product: prod.id, feature: 'robots', value: 150 });
  const jp = await ok('POST', '/v1/customers', { name: nm('Kyoto Kikai'), currency: 'jpy' });
  await ok('POST', '/v1/entitlement-overrides', { customer: jp.id, feature: 'robots', value: 20, reason: 'Pilot fleet agreed with the Osaka team.' });
  const c = await check(jp.id, 'robots', 60);
  console.log('  jpy customer, override-granted row -> row currency=',
    app.ctx.db.get<any>(`SELECT currency FROM entitlement_active WHERE org_id=? AND customer_id=? AND feature_key='robots'`, ORG, jp.id)?.currency);
  console.log('  upgrade currency=', c.upgrade_path?.currency, ' amount=', c.upgrade_path?.amount, ' msg=', JSON.stringify(c.upgrade_path?.message));
  console.log('  (the jpy plan granting 150 robots is', c.upgrade_path?.product === prod.id ? 'chosen' : 'NOT chosen', ')');
}

console.log('=== F. duplicate meter identifier / quantity edges ===');
{
  const cus = await ok('POST', '/v1/customers', { name: nm('Dupe Works'), currency: 'usd' });
  await ok('POST', '/v1/subscriptions', { customer: cus.id, backdate_start_date: app.ctx.now() - DAY, items: [{ price: pid('growth_monthly'), quantity: 1 }] });
  const id = `dupe-${seq++}`;
  await ok('POST', '/v1/meter-events', { event_name: 'telemetry_events', customer: cus.id, value: 1_000_000, identifier: id });
  const a = await check(cus.id, 'events_included');
  const r2 = await call('POST', '/v1/meter-events', { event_name: 'telemetry_events', customer: cus.id, value: 1_000_000, identifier: id });
  const b = await check(cus.id, 'events_included');
  console.log('  used after 1st=', a.used, ' dup status=', r2.status, ' used after dup=', b.used, b.used === a.used ? 'OK' : 'DOUBLE COUNTED');
  const q0 = await check(cus.id, 'events_included', 0);
  const qbig = await check(cus.id, 'events_included', 1_000_000_000);
  console.log('  requested=0 allowed=', q0.allowed, ' requested=1e9 allowed=', qbig.allowed, ' remaining=', qbig.remaining);
  const neg = await call('POST', '/v1/entitlements/check', { customer: cus.id, feature: 'events_included', requested: -5 });
  console.log('  requested=-5 status=', neg.status, neg.status >= 400 ? neg.body.error.code : `allowed=${neg.body.allowed}`);
  const max = await check(cus.id, 'events_included', Number.MAX_SAFE_INTEGER);
  console.log('  requested=MAX_SAFE allowed=', max.allowed);
}

console.log('=== G. one window vs several: usage additivity behind the gate ===');
{
  const cus = await ok('POST', '/v1/customers', { name: nm('Split Works'), currency: 'usd' });
  await ok('POST', '/v1/subscriptions', { customer: cus.id, backdate_start_date: app.ctx.now() - DAY, items: [{ price: pid('growth_monthly'), quantity: 1 }] });
  for (let i = 0; i < 5; i++) {
    await ok('POST', '/v1/meter-events', { event_name: 'telemetry_events', customer: cus.id, value: 700_000, identifier: `split-${seq}-${i}`, timestamp: app.ctx.now() - 3600_000 * (i + 1) });
  }
  const c = await check(cus.id, 'events_included');
  const p = c.period;
  const whole = app.ctx.svc.metering.usageForPeriod(ORG, app.ctx.svc.metering.meter(ORG, 'telemetry_events')!.id, cus.id, p.start, p.end).billable_quantity;
  const mid = p.start + Math.floor((p.end - p.start) / 2);
  const m = app.ctx.svc.metering.meter(ORG, 'telemetry_events')!.id;
  const s1 = app.ctx.svc.metering.usageForPeriod(ORG, m, cus.id, p.start, mid).billable_quantity;
  const s2 = app.ctx.svc.metering.usageForPeriod(ORG, m, cus.id, mid, p.end).billable_quantity;
  console.log('  gate used=', c.used, ' whole-window=', whole, ' split halves=', s1, '+', s2, '=', s1 + s2, (s1 + s2) === whole ? 'OK' : 'MISMATCH');
}

console.log('=== H. 400-day replay: every stored period must contain now ===');
{
  // Give a couple of accounts real usage so metered gates matter.
  const target = app.ctx.db.all<any>(`SELECT DISTINCT customer_id FROM entitlement_active WHERE org_id=? AND feature_key='events_included'`, ORG).map((r: any) => r.customer_id);
  console.log('  metered holders at t0:', target.length);
  let ran = 0, failed = 0;
  for (let i = 0; i < 8; i++) { const r = await app.travel(50 * DAY); ran += r.ran; failed += r.failed; }
  const now = app.ctx.now();
  console.log('  travelled 400d, jobs ran=', ran, ' failed=', failed, ' now=', new Date(now).toISOString());

  const rows = app.ctx.db.all<any>(`SELECT * FROM entitlement_active WHERE org_id=?`, ORG);
  const stale = rows.filter((r: any) => r.period_start !== null && !(r.period_start <= now && now < r.period_end));
  console.log('  active rows=', rows.length, ' rows whose stored period does NOT contain now =', stale.length);
  for (const s of stale.slice(0, 6)) {
    const sub = s.source_subscription ? app.ctx.svc.billing.subscription(ORG, s.source_subscription) : null;
    console.log(`    ${s.customer_id}/${s.feature_key} src=${s.source_type} sub=${s.source_subscription} subStatus=${sub?.status}`,
      `stored=[${new Date(s.period_start).toISOString()},${new Date(s.period_end).toISOString()})`,
      sub ? `live=[${new Date(sub.current_period_start).toISOString()},${new Date(sub.current_period_end).toISOString()})` : '');
  }

  // invoice integrity
  const invs = app.ctx.db.all<any>(`SELECT id, total, subtotal, tax, org_id FROM invoices WHERE org_id=?`, ORG);
  let bad = 0;
  for (const inv of invs) {
    const lines = app.ctx.db.all<any>(`SELECT amount FROM invoice_lines WHERE invoice_id=?`, inv.id);
    const sum = lines.reduce((a: number, l: any) => a + l.amount, 0);
    if (sum !== inv.subtotal) { if (bad < 5) console.log('    line-sum mismatch', inv.id, 'lines=', sum, 'subtotal=', inv.subtotal); bad++; }
  }
  console.log('  invoices=', invs.length, ' subtotal != sum(lines):', bad);
}
app.close();
