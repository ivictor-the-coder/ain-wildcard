import { ws } from './lib';
const log = (...a: any[]) => console.log(...a);
const DAY = 86400000;
const w = await ws(Date.UTC(2026, 5, 1));
const cus = await w.ok('POST', '/v1/customers', { name: 'Items', email: 'it@x.example', currency: 'usd' });
await w.ok('POST', '/v1/payment_methods', { type: 'card', customer: cus.id, brand: 'visa', exp_month: 4, exp_year: 2031 });
let sub = await w.ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: 'price_nw_growth_monthly' }] });
await w.app.tick();
log('items before:', JSON.stringify(sub.items.map((i: any) => [i.id, i.price, i.quantity])));
await w.app.travel(15 * DAY);
sub = await w.ok('GET', `/v1/subscriptions/${sub.id}`);
const itemId = sub.items[0].id;
const up = await w.ok('PATCH', `/v1/subscriptions/${sub.id}`, { items: [{ id: itemId, price: 'price_nw_scale_monthly' }], proration_behavior: 'create_prorations' });
log('items after (with id):', JSON.stringify(up.items.map((i: any) => [i.id, i.price, i.quantity])));
const pend = await w.ok('GET', `/v1/customers/${cus.id}/pending_items`);
log('prorations:', JSON.stringify(pend.data?.map((p: any) => [p.amount, p.description])));
const net = (pend.data ?? []).reduce((s: number, p: any) => s + p.amount, 0);
log('net', net, 'expected', Math.round(190000/2) - Math.round(49900/2));
await w.app.travel(20 * DAY);
const list = (await w.ok('GET', `/v1/invoices?subscription=${sub.id}&limit=50`)).data.sort((a: any, b: any) => a.created - b.created);
for (const i of list) {
  log(`${i.number} ${i.status} total=${i.total}`);
  for (const l of i.lines) log('   ', l.amount, '|', l.description);
}
w.close();
