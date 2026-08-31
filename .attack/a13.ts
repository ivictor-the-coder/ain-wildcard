import { ws } from './lib';
const log = (...a: any[]) => console.log(...a);
const DAY = 86400000;
const w = await ws(Date.UTC(2026, 5, 1));
const mk = async (n: string) => {
  const cus = await w.ok('POST', '/v1/customers', { name: n, email: `${n}@x.example`, currency: 'usd' });
  await w.ok('POST', '/v1/payment_methods', { type: 'card', customer: cus.id, brand: 'visa', exp_month: 4, exp_year: 2031 });
  const sub = await w.ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: 'price_nw_growth_monthly' }] });
  await w.app.tick();
  return { cus, sub };
};
// midpoint upgrade
const a = await mk('Midpoint');
await w.app.travel(15 * DAY); // exact midpoint of a 30-day June period
const up = await w.ok('PATCH', `/v1/subscriptions/${a.sub.id}`, { items: [{ price: 'price_nw_scale_monthly' }], proration_behavior: 'create_prorations' });
let invs = (await w.ok('GET', `/v1/invoices?subscription=${a.sub.id}&limit=50`)).data.sort((x: any, y: any) => x.created - y.created);
const pend = await w.ok('GET', `/v1/customers/${a.cus.id}/pending_items`);
log('midpoint prorations:', JSON.stringify(pend.data?.map((p: any) => [p.description, p.amount])));
const net = (pend.data ?? []).reduce((s: number, p: any) => s + p.amount, 0);
log('net proration', net, 'expected ~', Math.round((190000 - 49900) / 2));
// two changes in one cycle
const b = await mk('TwoChanges');
await w.app.travel(10 * DAY);
await w.ok('PATCH', `/v1/subscriptions/${b.sub.id}`, { items: [{ price: 'price_nw_scale_monthly' }], proration_behavior: 'create_prorations' });
await w.app.travel(10 * DAY);
await w.ok('PATCH', `/v1/subscriptions/${b.sub.id}`, { items: [{ price: 'price_nw_growth_monthly' }], proration_behavior: 'create_prorations' });
const pend2 = await w.ok('GET', `/v1/customers/${b.cus.id}/pending_items`);
log('two-change prorations:', JSON.stringify(pend2.data?.map((p: any) => [p.description.slice(0, 40), p.amount])));
log('two-change net', (pend2.data ?? []).reduce((s: number, p: any) => s + p.amount, 0));
await w.app.travel(40 * DAY);
for (const [name, ctx] of [['midpoint', a], ['twochange', b]] as any) {
  const list = (await w.ok('GET', `/v1/invoices?subscription=${ctx.sub.id}&limit=50`)).data;
  let ok = true;
  for (const i of list) {
    const sum = i.lines.reduce((s: number, l: any) => s + l.amount, 0);
    if (sum !== i.subtotal) { ok = false; log('LINES!=SUBTOTAL', i.number, sum, i.subtotal); }
    if (i.status !== 'void' && i.amount_paid + i.pre_payment_credit_notes_amount + i.amount_due !== i.total) { ok = false; log('IDENT', i.number); }
  }
  log(name, 'invoices', list.length, 'all balanced', ok, 'statuses', JSON.stringify(list.map((i: any) => [i.number, i.status, i.total, i.amount_paid])));
}
w.close();
