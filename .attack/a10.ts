import { ws } from './lib';
const log = (...a: any[]) => console.log(...a);
const DAY = 86400000;
const w = await ws();
async function run(cur: string, unit: number, creditAmt: number) {
  const prod = await w.ok('POST', '/v1/products', { name: `Telemetry ${cur}`, default_price_data: { currency: cur, unit_amount: unit, recurring: { interval: 'month' }, model: 'flat' } });
  const price = (await w.ok('GET', `/v1/prices?product=${prod.id}&limit=10`)).data[0];
  const cus = await w.ok('POST', '/v1/customers', { name: `Cur ${cur}`, email: `cur${cur}@x.example`, currency: cur });
  const pm = await w.ok('POST', '/v1/payment_methods', { type: 'bank_debit', customer: cus.id, bank_name: 'B', account_type: 'checking', simulated_behavior: 'succeeds' });
  const sub = await w.ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: price.id }] });
  await w.app.tick();
  const inv = (await w.ok('GET', `/v1/invoices?subscription=${sub.id}&limit=10`)).data[0];
  log(`${cur}: invoice total=${inv.total} due=${inv.amount_due} amount_display=${inv.total_display ?? ''}`);
  // debit is in flight; credit note shrinks the bill; settlement overpays
  const cn = await w.call('POST', '/v1/credit_notes', { invoice: inv.id, amount: creditAmt, reason: 'order_change' });
  log(`  credit note ${cn.status} ${cn.body.total ?? cn.body.error?.code}`);
  await w.app.travel(6 * DAY);
  const after = await w.ok('GET', `/v1/invoices/${inv.id}`);
  const pays = await w.ok('GET', `/v1/invoices/${inv.id}/payments`);
  const c2 = await w.ok('GET', `/v1/customers/${cus.id}`);
  const bts = (await w.ok('GET', `/v1/customers/${cus.id}/balance_transactions`)).data;
  log(`  after: status=${after.status} paid=${after.amount_paid} due=${after.amount_due} pre_cn=${after.pre_payment_credit_notes_amount} overpaid=${pays.amount_overpaid} balance=${c2.balance}`);
  log(`  identity ${after.amount_paid + after.pre_payment_credit_notes_amount + after.amount_due === after.total}`);
  log(`  txn desc: ${bts[0]?.description}`);
  const ints = (await w.ok('GET', `/v1/dunning?status=all&customer=${cus.id}`)).data;
  return after;
}
await run('jpy', 5000, 3000);
await run('bhd', 5000, 3000);
w.close();
