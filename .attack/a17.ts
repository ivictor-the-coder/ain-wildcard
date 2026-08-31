import { ws } from './lib';
const log = (...a: any[]) => console.log(...a);
const DAY = 86400000;
async function run(splits: number) {
  const w = await ws(Date.UTC(2026, 5, 1));
  const ms = (await w.ok('GET', '/v1/meters?limit=20')).data;
  const meter = ms.find((m: any) => /event/i.test(m.event_name)) ?? ms[0];
  const cus = await w.ok('POST', '/v1/customers', { name: `W${splits}`, email: `w${splits}@x.example`, currency: 'usd' });
  await w.ok('POST', '/v1/payment_methods', { type: 'card', customer: cus.id, brand: 'visa', exp_month: 4, exp_year: 2031 });
  const sub = await w.ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: 'price_nw_growth_monthly' }, { price: 'price_nw_telemetry_events' }] });
  await w.app.tick();
  const boundaries = new Set<number>();
  for (let i = 1; i < splits; i++) boundaries.add(Math.round(i * 30 / splits));
  let dupResult = '';
  for (let d = 0; d < 30; d++) {
    await w.ok('POST', '/v1/meter-events', { event_name: meter.event_name, customer: cus.id, value: 10000, identifier: `ev-${splits}-${d}` });
    if (d === 0) {
      const dup = await w.call('POST', '/v1/meter-events', { event_name: meter.event_name, customer: cus.id, value: 10000, identifier: `ev-${splits}-0` });
      dupResult = `${dup.status} ${dup.body.error?.code ?? 'accepted'}`;
    }
    await w.app.travel(DAY);  // this runs any settlement jobs due
  }
  await w.app.travel(4 * DAY);
  const invs = (await w.ok('GET', `/v1/invoices?subscription=${sub.id}&limit=50`)).data.sort((a: any, b: any) => a.created - b.created);
  const total = invs.reduce((s: number, i: any) => s + i.total, 0);
  const usage = invs.flatMap((i: any) => i.lines.filter((l: any) => l.kind === 'usage' || /usage|event/i.test(l.description)));
  log(`splits=${splits} dup=${dupResult} invoices=${invs.length} sum=${total} usage=${JSON.stringify(usage.map((l: any) => [l.quantity, l.amount]))}`);
  const bal = await w.ok('GET', `/v1/customers/${cus.id}`);
  w.close();
  return total;
}
const a = await run(1);
const b = await run(6);
log('EQUAL', a, b, a === b);
