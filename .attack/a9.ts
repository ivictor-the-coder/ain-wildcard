import { ws } from './lib';
const log = (...a: any[]) => console.log(...a);
const DAY = 86400000;
const w = await ws(Date.UTC(2026, 0, 31));
const cus = await w.ok('POST', '/v1/customers', { name: 'Anchor31', email: 'a31@x.example', currency: 'usd' });
await w.ok('POST', '/v1/payment_methods', { type: 'card', customer: cus.id, brand: 'visa', exp_month: 4, exp_year: 2031 });
const sub = await w.ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: 'growth_monthly' }] });
await w.app.tick();
for (let i = 0; i < 14; i++) await w.app.travel(31 * DAY);
const invs = (await w.ok('GET', `/v1/invoices?subscription=${sub.id}&limit=200`)).data.sort((a: any, b: any) => a.created - b.created);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
let prevEnd: number | null = null; let gaps = 0, overlaps = 0;
for (const i of invs) {
  if (prevEnd !== null) { if (i.period.start > prevEnd) { gaps++; log('GAP', iso(prevEnd), '->', iso(i.period.start)); } if (i.period.start < prevEnd) { overlaps++; log('OVERLAP', iso(prevEnd), '->', iso(i.period.start)); } }
  prevEnd = i.period.end;
  log(i.number, i.status, iso(i.period.start), '->', iso(i.period.end), 'total', i.total, 'paid', i.amount_paid);
}
log('gaps', gaps, 'overlaps', overlaps, 'count', invs.length);
const totals = invs.reduce((s: number, i: any) => s + i.total, 0);
log('sum totals', totals);
w.close();
