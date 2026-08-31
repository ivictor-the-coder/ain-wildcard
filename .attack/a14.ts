import { ws } from './lib';
const log = (...a: any[]) => console.log(...a);
const DAY = 86400000;
const w = await ws(Date.UTC(2026, 5, 1));
const cus = await w.ok('POST', '/v1/customers', { name: 'MidLines', email: 'ml@x.example', currency: 'usd' });
await w.ok('POST', '/v1/payment_methods', { type: 'card', customer: cus.id, brand: 'visa', exp_month: 4, exp_year: 2031 });
const sub = await w.ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: 'price_nw_growth_monthly' }] });
await w.app.tick();
await w.app.travel(15 * DAY);
await w.ok('PATCH', `/v1/subscriptions/${sub.id}`, { items: [{ price: 'price_nw_scale_monthly' }], proration_behavior: 'create_prorations' });
await w.app.travel(20 * DAY);
const list = (await w.ok('GET', `/v1/invoices?subscription=${sub.id}&limit=50`)).data.sort((a: any, b: any) => a.created - b.created);
for (const i of list) {
  log(`\n${i.number} ${i.status} total=${i.total} subtotal=${i.subtotal} paid=${i.amount_paid} period ${new Date(i.period.start).toISOString().slice(0,10)}->${new Date(i.period.end).toISOString().slice(0,10)}`);
  for (const l of i.lines) log('   ', l.amount, '|', l.description, '|', l.explanation?.slice(0, 110));
}
w.close();
