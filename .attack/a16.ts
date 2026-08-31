import { ws } from './lib';
const log = (...a: any[]) => console.log(...a);
const DAY = 86400000;
async function run(splits: number) {
  const w = await ws(Date.UTC(2026, 5, 1));
  const cus = await w.ok('POST', '/v1/customers', { name: `Win${splits}`, email: `w${splits}@x.example`, currency: 'usd' });
  await w.ok('POST', '/v1/payment_methods', { type: 'card', customer: cus.id, brand: 'visa', exp_month: 4, exp_year: 2031 });
  const sub = await w.ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: 'price_nw_telemetry_events' }] });
  await w.app.tick();
  const meters = (await w.ok('GET', '/v1/meters?limit=20')).data;
  const meter = meters.find((m: any) => /telemetry|event/i.test(m.name ?? m.event_name ?? '')) ?? meters[0];
  // 300k events spread across the period
  for (let d = 0; d < 30; d++) {
    const r = await w.call('POST', '/v1/meter-events', { event_name: meter.event_name, customer: cus.id, value: 10000, identifier: `ev-${splits}-${d}`, timestamp: w.now() + d * DAY });
    if (r.status >= 400) { log('meter event failed', r.status, JSON.stringify(r.body.error)); break; }
  }
  // duplicate identifier
  const dup = await w.call('POST', '/v1/meter-events', { event_name: meter.event_name, customer: cus.id, value: 10000, identifier: `ev-${splits}-0`, timestamp: w.now() });
  log(`  dup identifier -> ${dup.status} ${dup.body.error?.code ?? 'accepted'}`);
  const step = Math.round(31 * DAY / splits);
  for (let i = 0; i < splits; i++) await w.app.travel(step);
  await w.app.travel(3 * DAY);
  const invs = (await w.ok('GET', `/v1/invoices?subscription=${sub.id}&limit=50`)).data.sort((a: any, b: any) => a.created - b.created);
  const usage = invs.flatMap((i: any) => i.lines.filter((l: any) => /telemetry|usage|event/i.test(l.description)));
  const total = invs.reduce((s: number, i: any) => s + i.total, 0);
  log(`splits=${splits}: invoices=${invs.length} sumTotals=${total} usageLines=${JSON.stringify(usage.map((l: any) => [l.quantity, l.amount]))}`);
  w.close();
  return total;
}
const one = await run(1);
const many = await run(6);
log('one-window total', one, 'six-window total', many, 'EQUAL', one === many);
