import { ws } from './lib';
const log = (...a: any[]) => console.log(...a);
const DAY = 86400000;
const w = await ws();
// customer whose card needs SCA
const cus = await w.ok('POST', '/v1/customers', { name: 'SCA Corp', email: 'sca@x.example', currency: 'usd' });
const pm = await w.ok('POST', '/v1/payment_methods', { type: 'card', customer: cus.id, brand: 'visa', exp_month: 4, exp_year: 2031, simulated_behavior: 'authentication_required' });
const sub = await w.ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: 'growth_monthly' }] });
await w.app.tick();
const inv = (await w.ok('GET', `/v1/invoices?subscription=${sub.id}&limit=100`)).data[0];
log('invoice', inv.status, 'due', inv.amount_due);
const d0 = (await w.ok('GET', `/v1/dunning?status=all&customer=${cus.id}`)).data;
log('dunning after first failure:', JSON.stringify(d0.map((c: any) => ({ st: c.status, attempts: c.attempt_count, max: c.max_attempts, next: c.next_attempt_at, code: c.last_failure_code, resolution: c.resolution, action: c.action }))[0], null, 1));
let s = await w.ok('GET', `/v1/subscriptions/${sub.id}`);
log('subscription status now:', s.status);
const t = await w.app.travel(2 * DAY);
log('travel 2d', JSON.stringify(t));
s = await w.ok('GET', `/v1/subscriptions/${sub.id}`);
log('subscription status after jobs:', s.status);
const d1 = (await w.ok('GET', `/v1/dunning?status=all&customer=${cus.id}`)).data[0];
log('campaign:', d1.status, 'attempts', d1.attempt_count, '| resolution:', d1.resolution);
const evs = await w.ok('GET', '/v1/events?limit=200');
log('events of interest:', JSON.stringify(evs.data.filter((e: any) => /payment_action_required|dunning|subscription\.(updated|status)/.test(e.type)).map((e: any) => e.type)));
// can the customer still be recovered? on-session retry
const r = await w.call('POST', `/v1/invoices/${inv.id}/retry`, { off_session: false });
log('on-session retry ->', r.status, JSON.stringify(r.body).slice(0, 900));
const pi = r.body?.payment_intent ?? r.body?.intent;
if (pi?.id) {
  const a = await w.call('POST', `/v1/payment_intents/${pi.id}/authenticate`, { result: 'approve' });
  log('authenticate ->', a.status, a.body.status, a.body.amount, a.body.error?.code);
  const i2 = await w.ok('GET', `/v1/invoices/${inv.id}`);
  log('invoice after auth:', i2.status, 'due', i2.amount_due, 'paid', i2.amount_paid);
  const s2 = await w.ok('GET', `/v1/subscriptions/${sub.id}`);
  log('subscription after payment:', s2.status);
  const d2 = (await w.ok('GET', `/v1/dunning?status=all&customer=${cus.id}`)).data[0];
  log('campaign after payment:', d2.status, d2.resolution?.slice(0,160));
}
w.close();
