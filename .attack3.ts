import { createApp, frozenClock, type App } from './src/server/app';
import type { Auth } from './src/server/kernel/http';
import { DAY } from './src/shared/time';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const app: App = await createApp({ db: 'memory', clock: frozenClock(Date.UTC(2026, 0, 31, 10, 0, 0)), config: { env: 'test' } });
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

console.log('=== I. annual term anchored 31 Jan: the twelve monthly allowance windows ===');
{
  const cus = await ok('POST', '/v1/customers', { name: nm('Anchor Works'), currency: 'usd' });
  await ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: pid('growth_annual'), quantity: 1 }] });
  const seen: string[] = []; const keys: string[] = [];
  let lastEnd = -1, gaps = 0, overlaps = 0, short = 0;
  for (let d = 0; d < 380; d += 1) {
    const c = await check(cus.id, 'events_included');
    const key = `${iso(c.period.start)}..${iso(c.period.end)}`;
    if (keys[keys.length-1] !== key) {
      keys.push(key);
      if (lastEnd > 0) {
        if (c.period.start > lastEnd) gaps++;
        if (c.period.start < lastEnd) overlaps++;
      }
      const days = (c.period.end - c.period.start) / DAY;
      if (days < 27) short++;
      seen.push(`${key} (${days.toFixed(2)}d, limit ${c.limit})`);
      lastEnd = c.period.end;
    }
    await app.travel(DAY);
  }
  for (const s of seen) console.log('   ', s);
  console.log('  distinct windows in 380d =', seen.length, ' gaps=', gaps, ' overlaps=', overlaps, ' short(<27d)=', short);
}
app.close();
