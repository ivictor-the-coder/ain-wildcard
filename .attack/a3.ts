import { ws } from './lib';
const log = (...a: any[]) => console.log(...a);
const w = await ws();
const DAY = 86400000;
async function openBill(name: string, pmBody: any) {
  const cus = await w.ok('POST', '/v1/customers', { name, email: `${name.replace(/\W/g,'')}@x.example`, currency: 'usd' });
  const sub = await w.ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: 'growth_monthly' }] });
  await w.app.tick();
  const inv = (await w.ok('GET', `/v1/invoices?subscription=${sub.id}&limit=100`)).data[0];
  const pm = await w.ok('POST', '/v1/payment_methods', { customer: cus.id, ...pmBody });
  return { cus, sub, inv, pm };
}
// bank debit in flight, then credit note halves the bill, then it settles: overpayment must be recorded
const b = await openBill('Debit Overpay', { type: 'bank_debit', bank_name: 'First Interstate', account_type: 'checking', simulated_behavior: 'succeeds' });
log('invoice due', b.inv.amount_due);
const I = await w.ok('POST', '/v1/payment_intents', { customer: b.cus.id, invoice: b.inv.id, payment_method: b.pm.id, confirm: true, off_session: true });
log('intent', I.status, I.amount);
const cn = await w.call('POST', '/v1/credit_notes', { invoice: b.inv.id, amount: 30000, reason: 'order_change' });
log('credit note', cn.status, cn.body.total ?? cn.body.error?.code);
const mid = await w.ok('GET', `/v1/invoices/${b.inv.id}`);
log('invoice mid: due', mid.amount_due, 'paid', mid.amount_paid, 'pre_cn', mid.pre_payment_credit_notes_amount);
const t = await w.app.travel(6 * DAY);
log('travel', JSON.stringify(t));
const after = await w.ok('GET', `/v1/invoices/${b.inv.id}`);
log('invoice after: status', after.status, 'due', after.amount_due, 'paid', after.amount_paid, 'total', after.total, 'pre_cn', after.pre_payment_credit_notes_amount);
const pays = await w.ok('GET', `/v1/invoices/${b.inv.id}/payments`);
log('amount_overpaid', pays.amount_overpaid);
const bal = await w.ok('GET', `/v1/customers/${b.cus.id}`);
log('balance', bal.balance);
const bt = await w.ok('GET', `/v1/customers/${b.cus.id}/balance_transactions`);
log('balance txns', JSON.stringify(bt.data.map((t: any) => [t.type, t.amount, t.ending_balance])));
const chs = await w.ok('GET', `/v1/charges?customer=${b.cus.id}&limit=50`);
const charged = chs.data.filter((c: any) => c.status === 'succeeded').reduce((s: number, c: any) => s + c.amount, 0);
log('charged', charged, 'paid', after.amount_paid, 'credit', -bal.balance, 'RECONCILES', charged === after.amount_paid + (-bal.balance));
log('IDENTITY', after.amount_paid + after.pre_payment_credit_notes_amount + after.amount_due, '==', after.total);
const evs = await w.ok('GET', `/v1/events?limit=200`);
log('overpaid events', JSON.stringify(evs.data.filter((e: any) => e.type === 'invoice.overpaid').map((e: any) => [e.type, e.data?.amount_overpaid])));
w.close();
