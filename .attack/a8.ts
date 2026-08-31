import { ws } from './lib';
const log = (...a: any[]) => console.log(...a);
const DAY = 86400000;
const w = await ws(Date.UTC(2026, 0, 31)); // anchored on the 31st
const behaviors = ['succeeds', 'succeeds', 'insufficient_funds', 'card_declined', 'authentication_required', 'expired_card'];
const made: any[] = [];
for (const [i, b] of behaviors.entries()) {
  const cus = await w.ok('POST', '/v1/customers', { name: `Long ${i} ${b}`, email: `long${i}@x.example`, currency: 'usd' });
  await w.ok('POST', '/v1/payment_methods', { type: 'card', customer: cus.id, brand: 'visa', exp_month: 4, exp_year: 2031, simulated_behavior: b, simulated_decline_count: b === 'insufficient_funds' ? 2 : undefined });
  const sub = await w.ok('POST', '/v1/subscriptions', { customer: cus.id, items: [{ price: 'growth_monthly' }] });
  made.push({ cus, sub, b });
}
await w.app.tick();
let total = { ran: 0, failed: 0 };
for (let d = 0; d < 400; d += 20) {
  const r = await w.app.travel(20 * DAY);
  total.ran += r.ran; total.failed += r.failed;
}
log('travelled 400d jobs ran', total.ran, 'failed', total.failed, 'now', new Date(w.now()).toISOString().slice(0,10));

// global invoice reconciliation
const invs: any[] = [];
let cursor: string | null = null;
do {
  const page: any = await w.ok('GET', `/v1/invoices?limit=200${cursor ? `&cursor=${cursor}` : ''}`);
  invs.push(...page.data); cursor = page.next_cursor ?? null;
} while (cursor);
log('invoices total', invs.length);
let bad = 0, lineBad = 0;
const dupPeriods = new Map<string, number>();
for (const i of invs) {
  const ident = i.amount_paid + i.pre_payment_credit_notes_amount + i.amount_due;
  if (i.status !== 'void' && ident !== i.total) { bad++; if (bad < 6) log('IDENTITY BROKEN', i.id, i.number, i.status, { paid: i.amount_paid, cn: i.pre_payment_credit_notes_amount, due: i.amount_due, total: i.total }); }
  const sum = (i.lines ?? []).reduce((s: number, l: any) => s + l.amount, 0);
  const expect = i.subtotal ?? null;
  if (expect !== null && sum !== expect) { lineBad++; if (lineBad < 6) log('LINES != SUBTOTAL', i.id, sum, expect); }
  if (i.subscription && i.period) {
    const k = `${i.subscription}|${i.period.start}|${i.period.end}|${i.billing_reason}`;
    dupPeriods.set(k, (dupPeriods.get(k) ?? 0) + 1);
  }
}
log('identity broken:', bad, 'lines!=subtotal:', lineBad);
const dups = [...dupPeriods.entries()].filter(([, n]) => n > 1);
log('duplicate (sub,period,reason) invoices:', dups.length, JSON.stringify(dups.slice(0, 5)));

// per-customer cash reconciliation
for (const m of made) {
  const chs = (await w.ok('GET', `/v1/charges?customer=${m.cus.id}&limit=200`)).data;
  const charged = chs.filter((c: any) => c.status === 'succeeded').reduce((s: number, c: any) => s + c.amount - c.amount_refunded, 0);
  const myInv = invs.filter((i) => i.customer === m.cus.id);
  const paid = myInv.reduce((s: number, i: any) => s + i.amount_paid, 0);
  const cusNow = await w.ok('GET', `/v1/customers/${m.cus.id}`);
  const bts = (await w.ok('GET', `/v1/customers/${m.cus.id}/balance_transactions`)).data;
  const overpay = bts.filter((t: any) => t.type === 'invoice_overpayment').reduce((s: number, t: any) => s + -t.amount, 0);
  const sub = await w.ok('GET', `/v1/subscriptions/${m.sub.id}`);
  log(`${m.b}: sub=${sub.status} invoices=${myInv.length} netCharged=${charged} invoicePaid=${paid} overpaidCredit=${overpay} balance=${cusNow.balance} MATCH=${charged === paid + overpay}`);
}
w.close();
