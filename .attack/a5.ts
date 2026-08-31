import { ws } from './lib';
const log = (...a: any[]) => console.log(...a);
const DAY = 86400000;
for (const behavior of ['expired_card', 'incorrect_cvc', 'card_declined', 'insufficient_funds']) {
  const w = await ws();
  const cus = await w.ok('POST', '/v1/customers', { name: `X ${behavior}`, email: `${behavior}@x.example`, currency: 'usd' });
  await w.ok('POST', '/v1/payment_methods', { type: 'card', customer: cus.id, brand: 'visa', exp_month: 4, exp_year: 2031, simulated_behavior: behavior });
  const sub = await w.ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: 'growth_monthly' }] });
  await w.app.tick();
  const s0 = await w.ok('GET', `/v1/subscriptions/${sub.id}`);
  const d0 = (await w.ok('GET', `/v1/dunning?status=all&customer=${cus.id}`)).data[0];
  log(`${behavior}: day0 sub=${s0.status} campaign=${d0.status} attempts=${d0.attempt_count}/${d0.max_attempts} next=${d0.next_attempt_at ? new Date(d0.next_attempt_at).toISOString().slice(0,10) : null}`);
  await w.app.travel(45 * DAY);
  const s1 = await w.ok('GET', `/v1/subscriptions/${sub.id}`);
  const d1 = (await w.ok('GET', `/v1/dunning?status=all&customer=${cus.id}`)).data[0];
  const atts = (await w.ok('GET', `/v1/dunning/${d1.id}`)).attempts ?? [];
  log(`  after 45d sub=${s1.status} campaign=${d1.status} attempts=${d1.attempt_count} days=${JSON.stringify(atts.map((a: any) => new Date(a.attempted_at).toISOString().slice(0,10)))}`);
  w.close();
}
