import { ws } from './lib';
const log = (...a: any[]) => console.log(...a);
const w = await ws();
const cus = await w.ok('POST', '/v1/customers', { name: 'Edge Co', email: 'edge@x.example', currency: 'usd' });
const pm = await w.ok('POST', '/v1/payment_methods', { type: 'card', customer: cus.id, brand: 'visa', exp_month: 4, exp_year: 2031, simulated_behavior: 'succeeds' });
const show = (r: any) => `${r.status} ${r.body.error?.code ?? JSON.stringify({ id: r.body.id, status: r.body.status, amount: r.body.amount })}`;
log('amount 0       ->', show(await w.call('POST', '/v1/payment_intents', { customer: cus.id, amount: 0, currency: 'usd', payment_method: pm.id })));
log('amount -100    ->', show(await w.call('POST', '/v1/payment_intents', { customer: cus.id, amount: -100, currency: 'usd', payment_method: pm.id })));
log('amount 1e9     ->', show(await w.call('POST', '/v1/payment_intents', { customer: cus.id, amount: 1e9, currency: 'usd', payment_method: pm.id })));
log('amount 1e8     ->', show(await w.call('POST', '/v1/payment_intents', { customer: cus.id, amount: 1e8, currency: 'usd', payment_method: pm.id })));
log('amount 1.5     ->', show(await w.call('POST', '/v1/payment_intents', { customer: cus.id, amount: 1.5, currency: 'usd', payment_method: pm.id })));
log('no amount      ->', show(await w.call('POST', '/v1/payment_intents', { customer: cus.id, currency: 'usd', payment_method: pm.id })));
log('currency jpy   ->', show(await w.call('POST', '/v1/payment_intents', { customer: cus.id, amount: 5000, currency: 'jpy', payment_method: pm.id })));
log('currency bhd   ->', show(await w.call('POST', '/v1/payment_intents', { customer: cus.id, amount: 5000, currency: 'bhd', payment_method: pm.id })));

// idempotency key reuse
log('\n-- idempotency --');
const k = { customer: cus.id, amount: 12345, currency: 'usd', payment_method: pm.id, idempotency_key: 'dup-key-1', confirm: true };
const i1 = await w.call('POST', '/v1/payment_intents', k);
const i2 = await w.call('POST', '/v1/payment_intents', k);
log('first ', show(i1)); log('second', show(i2));
log('same intent?', i1.body.id === i2.body.id);
const chs = await w.ok('GET', `/v1/charges?customer=${cus.id}&limit=50`);
log('charges after dup key:', JSON.stringify(chs.data.map((c: any) => [c.status, c.amount])));

// refunds
log('\n-- refunds --');
const paid = i1.body;
log('refund > charge ->', show(await w.call('POST', '/v1/refunds', { charge: paid.latest_charge, amount: 99999 })));
log('refund 0        ->', show(await w.call('POST', '/v1/refunds', { charge: paid.latest_charge, amount: 0 })));
log('refund -1       ->', show(await w.call('POST', '/v1/refunds', { charge: paid.latest_charge, amount: -1 })));
const r1 = await w.call('POST', '/v1/refunds', { charge: paid.latest_charge, amount: 10000 });
log('refund 10000    ->', show(r1));
const r2 = await w.call('POST', '/v1/refunds', { charge: paid.latest_charge, amount: 10000 });
log('refund 10000 x2 ->', show(r2));
const r3 = await w.call('POST', '/v1/refunds', { charge: paid.latest_charge });
log('refund rest     ->', show(r3));
const r4 = await w.call('POST', '/v1/refunds', { charge: paid.latest_charge, amount: 1 });
log('refund 1 more   ->', show(r4));
const ch = await w.ok('GET', `/v1/charges/${paid.latest_charge}`);
log('charge:', ch.amount, 'refunded', ch.amount_refunded, 'status', ch.status, 'refunded_flag', ch.refunded);

// disputes
log('\n-- disputes --');
const i3 = await w.ok('POST', '/v1/payment_intents', { customer: cus.id, amount: 20000, currency: 'usd', payment_method: pm.id, confirm: true });
log('dispute > charge ->', show(await w.call('POST', '/v1/disputes', { charge: i3.latest_charge, amount: 30000, reason: 'fraudulent' })));
log('dispute 0        ->', show(await w.call('POST', '/v1/disputes', { charge: i3.latest_charge, amount: 0, reason: 'fraudulent' })));
const d = await w.call('POST', '/v1/disputes', { charge: i3.latest_charge, amount: 20000, reason: 'fraudulent' });
log('dispute ok       ->', show(d));
log('dispute again    ->', show(await w.call('POST', '/v1/disputes', { charge: i3.latest_charge, amount: 20000, reason: 'fraudulent' })));
const bal = await w.ok('GET', `/v1/customers/${cus.id}`);
log('customer balance', bal.balance);
w.close();
