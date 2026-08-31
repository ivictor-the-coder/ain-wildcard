import { ws } from './lib';
const log = (...a: any[]) => console.log(...a);
const w = await ws();
async function openBill(name: string) {
  const cus = await w.ok('POST', '/v1/customers', { name, email: `${name.replace(/\W/g,'')}@x.example`, currency: 'usd' });
  const sub = await w.ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: 'growth_monthly' }] });
  await w.app.tick();
  const inv = (await w.ok('GET', `/v1/invoices?subscription=${sub.id}&limit=100`)).data[0];
  const pm = await w.ok('POST', '/v1/payment_methods', { type: 'card', customer: cus.id, brand: 'visa', exp_month: 4, exp_year: 2031, simulated_behavior: 'succeeds' });
  return { cus, sub, inv, pm };
}
// --- credit note shrinks the bill under a live intent
const b = await openBill('CN Race');
const C = await w.ok('POST', '/v1/payment_intents', { customer: b.cus.id, invoice: b.inv.id, payment_method: b.pm.id });
log('intent amount', C.amount, 'invoice due', b.inv.amount_due);
const cn = await w.call('POST', '/v1/credit_notes', { invoice: b.inv.id, amount: 20000, reason: 'order_change' });
log('credit note ->', cn.status, cn.body.error?.code ?? `total ${cn.body.total}`);
const inv2 = await w.ok('GET', `/v1/invoices/${b.inv.id}`);
log('invoice now due', inv2.amount_due, 'total', inv2.total, 'pre_payment_cn', inv2.pre_payment_credit_notes_amount);
const cC = await w.call('POST', `/v1/payment_intents/${C.id}/confirm`, {});
log('confirm ->', cC.status, JSON.stringify({ status: cC.body.status, amount: cC.body.amount, err: cC.body.error?.code }));
const inv3 = await w.ok('GET', `/v1/invoices/${b.inv.id}`);
log('after:', inv3.status, 'due', inv3.amount_due, 'paid', inv3.amount_paid, 'total', inv3.total);
const bal = await w.ok('GET', `/v1/customers/${b.cus.id}`);
log('balance', bal.balance, 'overpaid', (await w.ok('GET', `/v1/invoices/${b.inv.id}/payments`)).amount_overpaid);
const chs = await w.ok('GET', `/v1/charges?customer=${b.cus.id}&limit=50`);
log('charges', JSON.stringify(chs.data.map((c: any) => [c.status, c.amount])));
log('IDENTITY paid+pre_cn+due==total:', inv3.amount_paid + inv3.pre_payment_credit_notes_amount + inv3.amount_due, '==', inv3.total);

// --- credit note for MORE than the invoice
log('\n--- over-credit ---');
const b2 = await openBill('Over Credit');
const over = await w.call('POST', '/v1/credit_notes', { invoice: b2.inv.id, amount: b2.inv.total + 1 });
log('over-credit ->', over.status, over.body.error?.code, over.body.error?.message?.slice(0,120));

// --- void the invoice under a live intent
log('\n--- void race ---');
const b3 = await openBill('Void Race');
const D = await w.ok('POST', '/v1/payment_intents', { customer: b3.cus.id, invoice: b3.inv.id, payment_method: b3.pm.id });
await w.ok('POST', `/v1/invoices/${b3.inv.id}/void`, {});
const cD = await w.call('POST', `/v1/payment_intents/${D.id}/confirm`, {});
log('confirm on voided ->', cD.status, cD.body.error?.code);

// --- mark uncollectible under a live intent
log('\n--- uncollectible race ---');
const b4 = await openBill('Uncoll Race');
const E = await w.ok('POST', '/v1/payment_intents', { customer: b4.cus.id, invoice: b4.inv.id, payment_method: b4.pm.id });
await w.ok('POST', `/v1/invoices/${b4.inv.id}/mark_uncollectible`, {});
const cE = await w.call('POST', `/v1/payment_intents/${E.id}/confirm`, {});
log('confirm on uncollectible ->', cE.status, cE.body.error?.code);

// --- intent amount NOT bound to invoice, arbitrary amount, invoice bound though
log('\n--- part payment then full ---');
const b5 = await openBill('Part Pay');
// build a manual small intent bound to the invoice
const P = await w.ok('POST', '/v1/payment_intents', { customer: b5.cus.id, invoice: b5.inv.id, payment_method: b5.pm.id, amount: 10000 });
log('part intent amount', P.amount);
const cP = await w.call('POST', `/v1/payment_intents/${P.id}/confirm`, {});
log('part confirm', cP.status, cP.body.status, cP.body.amount);
const i5 = await w.ok('GET', `/v1/invoices/${b5.inv.id}`);
log('invoice', i5.status, 'due', i5.amount_due, 'paid', i5.amount_paid, 'ident', i5.amount_paid + i5.pre_payment_credit_notes_amount + i5.amount_due === i5.total);
const R = await w.ok('POST', '/v1/payment_intents', { customer: b5.cus.id, invoice: b5.inv.id, payment_method: b5.pm.id });
log('rest intent amount', R.amount);
const cR = await w.call('POST', `/v1/payment_intents/${R.id}/confirm`, {});
log('rest confirm', cR.status, cR.body.status, cR.body.amount);
const i5b = await w.ok('GET', `/v1/invoices/${b5.inv.id}`);
log('invoice', i5b.status, 'due', i5b.amount_due, 'paid', i5b.amount_paid, 'total', i5b.total);
const bal5 = await w.ok('GET', `/v1/customers/${b5.cus.id}`);
log('balance', bal5.balance);
w.close();
