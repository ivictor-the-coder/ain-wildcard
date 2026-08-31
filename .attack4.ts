import { createApp, frozenClock, type App } from './src/server/app';
import type { Auth } from './src/server/kernel/http';
import { DAY } from './src/shared/time';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const app: App = await createApp({ db: 'memory', clock: frozenClock(Date.UTC(2026, 5, 2, 9, 17, 34, 512)), config: { env: 'test' } });
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
const iso = (t: number) => new Date(t).toISOString().slice(0, 19);

console.log('=== J. credit grant expiring exactly on the period boundary ===');
{
  const cus = await ok('POST', '/v1/customers', { name: nm('Boundary Works'), currency: 'usd' });
  await ok('POST', '/v1/subscriptions', { customer: cus.id, backdate_start_date: app.ctx.now() - DAY, items: [{ price: pid('growth_monthly'), quantity: 1 }] });
  const c0 = await check(cus.id, 'events_included');
  const boundary = c0.period.end;
  const meter = app.ctx.svc.metering.meter(ORG, 'telemetry_events')!.id;
  const g = await call('POST', '/v1/credit-grants', {
    customer: cus.id, name: 'Burst pack', category: 'promotional',
    kind: 'unit', meter, amount: 2_000_000, expires_at: boundary,
  });
  console.log('  grant status=', g.status, g.status >= 400 ? JSON.stringify(g.body.error) : '');
  const c1 = await check(cus.id, 'events_included');
  console.log('  before boundary: included=', c1.included_limit, ' credit=', c1.credit_units, ' limit=', c1.limit);
  await app.travel(boundary - app.ctx.now());
  const c2 = await check(cus.id, 'events_included');
  console.log('  at boundary exactly: period=', iso(c2.period.start), iso(c2.period.end), ' credit=', c2.credit_units, ' limit=', c2.limit);
  await app.travel(1);
  const c3 = await check(cus.id, 'events_included');
  console.log('  one ms past: credit=', c3.credit_units, ' limit=', c3.limit, ' (expect credit 0)');
}

console.log('=== K. two plan changes in one cycle; upgrade at the exact midpoint ===');
{
  const cus = await ok('POST', '/v1/customers', { name: nm('Midpoint Works'), currency: 'usd' });
  const sub = await ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: pid('growth_monthly'), quantity: 1 }] });
  const start = sub.current_period_start, end = sub.current_period_end;
  console.log('  period', iso(start), '->', iso(end));
  await app.travel(Math.floor((end - start) / 2));
  console.log('  at midpoint', iso(app.ctx.now()), ' robots=', (await check(cus.id, 'robots')).limit);
  await ok('PATCH', `/v1/subscriptions/${sub.id}`, { items: [{ price: pid('scale_monthly'), quantity: 1 }], proration_behavior: 'create_prorations' });
  const up = await check(cus.id, 'robots');
  console.log('  after upgrade to Scale: robots=', up.limit, ' source=', up.source.product_name, ' version=', up.version);
  await app.travel(DAY);
  await ok('PATCH', `/v1/subscriptions/${sub.id}`, { items: [{ price: pid('starter_monthly'), quantity: 1 }], proration_behavior: 'create_prorations' });
  const down = await check(cus.id, 'robots');
  console.log('  after downgrade to Starter: robots=', down.limit, ' source=', down.source.product_name, ' version=', down.version);
  const vers = await ok('GET', `/v1/customers/${cus.id}/entitlement-versions`);
  console.log('  versions recorded:', vers.data.length, vers.data.map((v: any) => `${v.version}:${v.trigger}`).join(' '));
  // sum of the invoice lines must equal the subtotal on every invoice
  const invs = app.ctx.db.all<any>(`SELECT id, number, subtotal, total, balance_applied FROM billing_invoices WHERE org_id=? AND customer_id=?`, ORG, cus.id);
  for (const inv of invs) {
    const lines = app.ctx.db.all<any>(`SELECT amount FROM billing_invoice_lines WHERE invoice_id=? AND released=0`, inv.id);
    const sum = lines.reduce((a: number, l: any) => a + l.amount, 0);
    console.log(`   ${inv.number}: lines=${sum} subtotal=${inv.subtotal} total=${inv.total} bal=${inv.balance_applied}`,
      sum === inv.subtotal ? 'OK' : 'MISMATCH', inv.subtotal + inv.balance_applied === inv.total ? '' : 'TOTAL MISMATCH');
  }
}

console.log('=== L. 400-day replay, whole workspace reconciliation ===');
{
  let ran = 0, failed = 0;
  for (let i = 0; i < 8; i++) { const r = await app.travel(50 * DAY); ran += r.ran; failed += r.failed; }
  const now = app.ctx.now();
  const invs = app.ctx.db.all<any>(`SELECT * FROM billing_invoices WHERE org_id=?`, ORG);
  let lineBad = 0, totalBad = 0;
  for (const inv of invs) {
    const lines = app.ctx.db.all<any>(`SELECT amount FROM billing_invoice_lines WHERE invoice_id=? AND released=0`, inv.id);
    const sum = lines.reduce((a: number, l: any) => a + l.amount, 0);
    if (sum !== inv.subtotal) { if (lineBad < 4) console.log('   line mismatch', inv.number, sum, inv.subtotal); lineBad++; }
    if (inv.subtotal + inv.balance_applied !== inv.total) { if (totalBad < 4) console.log('   total mismatch', inv.number); totalBad++; }
  }
  console.log('  jobs ran=', ran, 'failed=', failed, ' invoices=', invs.length, ' line-sum bad=', lineBad, ' total bad=', totalBad);
  // no two finalised subscription-cycle invoices covering the same period for the same sub
  const dupes = app.ctx.db.all<any>(
    `SELECT subscription_id, period_start, period_end, COUNT(*) n FROM billing_invoices
     WHERE org_id=? AND subscription_id IS NOT NULL AND status NOT IN ('void','draft') AND billing_reason IN ('subscription_cycle','subscription_create')
     GROUP BY subscription_id, period_start, period_end HAVING n > 1`, ORG);
  console.log('  duplicate cycle invoices for the same (sub, period):', dupes.length);
  const rows = app.ctx.db.all<any>(`SELECT * FROM entitlement_active WHERE org_id=?`, ORG);
  const stale = rows.filter((r: any) => r.period_start !== null && !(r.period_start <= now && now < r.period_end));
  console.log('  entitlement rows=', rows.length, ' stale windows=', stale.length);
  // every stored row still agrees with a live recompute
  const custs = [...new Set(rows.map((r: any) => r.customer_id))];
  let drift = 0;
  for (const c of custs) {
    const before = app.ctx.svc.entitlements.entitlements(ORG, c as string, { usage: false }).map((e: any) => `${e.feature}=${e.unlimited ? 'inf' : e.value}`).sort().join(',');
    app.ctx.svc.entitlements.recompute(ORG, c as string, { trigger: 'audit', reason: 'critic reconciliation' });
    const after = app.ctx.svc.entitlements.entitlements(ORG, c as string, { usage: false }).map((e: any) => `${e.feature}=${e.unlimited ? 'inf' : e.value}`).sort().join(',');
    if (before !== after) { if (drift < 5) console.log('   DRIFT', c, '\n     stored:', before, '\n     fresh :', after); drift++; }
  }
  console.log('  customers checked=', custs.length, ' stored-vs-recomputed drift=', drift);
}
app.close();
