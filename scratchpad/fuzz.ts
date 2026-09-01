import assert from 'node:assert/strict';
import { createApp, frozenClock } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { DAY } from '../src/shared/time';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const MONDAY = Date.UTC(2026, 5, 1);

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 0x1_0000_0000; };
}

const OPS = [
  'present', 'present_debit', 'present_debit', 'pay_card', 'credit_note',
  'settle', 'settle', 'refund', 'dispute', 'close_dispute',
  'cancel_intent', 'void_invoice', 'mark_uncollectible', 'big_travel', 'detach',
] as const;

async function run(seed: number) {
  const app = await createApp({ db: 'memory', config: { env: 'test' }, clock: frozenClock(MONDAY) });
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, body, auth: DANA });
  const ok = async (m: string, p: string, b?: unknown) => {
    const r = await call(m, p, b);
    if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const log: string[] = [];
  const problems: string[] = [];
  try {
    const random = rng(seed);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length) % xs.length];
    const customer = await ok('POST', '/v1/customers', { name: `Fuzz ${seed}`, email: `f${seed}@x.example`, currency: 'usd' });
    await ok('POST', '/v1/payment_methods', { type: 'card', customer: customer.id, brand: 'visa', exp_month: 4, exp_year: 2031, simulated_behavior: 'insufficient_funds', set_default: true });
    const sub = await ok('POST', '/v1/subscriptions', { customer: customer.id, items: [{ price: 'growth_monthly' }] });
    await app.tick();
    const invoices = (await ok('GET', `/v1/invoices?subscription=${sub.id}&limit=100`)).data;
    const invoice = invoices[0];
    const card = await ok('POST', '/v1/payment_methods', { type: 'card', customer: customer.id, brand: 'visa', exp_month: 4, exp_year: 2031, simulated_behavior: 'succeeds' });
    const flaky = await ok('POST', '/v1/payment_methods', { type: 'card', customer: customer.id, brand: 'visa', exp_month: 4, exp_year: 2031, simulated_behavior: 'insufficient_funds', simulated_decline_count: 2 });
    const debit = await ok('POST', '/v1/payment_methods', { type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank', account_type: 'checking', simulated_behavior: 'succeeds', set_default: true });
    const methods = [card, flaky, debit];

    const attempt = async (m: string, p: string, b?: unknown) => {
      const r = await call(m, p, b);
      if (r.status >= 500) { problems.push(`5xx ${m} ${p} -> ${JSON.stringify(r.body)}`); return null; }
      return r.status < 400 ? r.body : null;
    };

    const check = async (where: string) => {
      const bills = (await ok('GET', `/v1/invoices?customer=${customer.id}&status=all&limit=100`)).data;
      const ledger = (await ok('GET', `/v1/customers/${customer.id}/balance_transactions?limit=200`)).data;
      const overRows = ledger.filter((r: any) => r.type === 'invoice_overpayment');
      for (const b of bills) {
        const view = await ok('GET', `/v1/invoices/${b.id}/payments`);
        const net = view.cash_collected - view.amount_refunded - view.amount_disputed;
        const creditForBill = overRows.filter((r: any) => r.invoice === b.id).reduce((t: number, r: any) => t - r.amount, 0);
        if (view.amount_overpaid !== creditForBill) problems.push(`${where}: ${b.number} overpaid ${view.amount_overpaid} vs ledger ${creditForBill}`);
        if (creditForBill < 0) problems.push(`${where}: ${b.number} negative credit ${creditForBill}`);
        if (net !== view.amount_paid + view.amount_overpaid) problems.push(`${where}: ${b.number} net ${net} != paid ${view.amount_paid} + credit ${view.amount_overpaid}`);
        if (b.amount_due < 0) problems.push(`${where}: ${b.number} amount_due ${b.amount_due} < 0`);
        if (b.amount_paid < 0) problems.push(`${where}: ${b.number} amount_paid ${b.amount_paid} < 0`);
      }
      const camps = (await ok('GET', `/v1/dunning?status=all&customer=${customer.id}`)).data;
      for (const c of camps) {
        const b = bills.find((x: any) => x.id === c.invoice);
        if (!b) continue;
        const view = await ok('GET', `/v1/invoices/${b.id}/payments`);
        if (c.status === 'recovered' && b.status === 'open' && b.amount_due > 0
            && view.amount_refunded === 0 && view.amount_disputed === 0) {
          problems.push(`${where}: campaign on ${b.number} says recovered (${c.recovered_amount}) but the bill is open with ${b.amount_due} owed and nothing went back out`);
        }
        if (c.status === 'recovering' && c.next_attempt_at === null) {
          problems.push(`${where}: campaign on ${b.number} is recovering with no next attempt`);
        }
      }
    };

    for (let step = 0; step < 60; step++) {
      const op = pick(OPS);
      const bill = await ok('GET', `/v1/invoices/${invoice.id}`);
      switch (op) {
        case 'present': log.push(`${step}: retry`); await attempt('POST', `/v1/invoices/${invoice.id}/retry`, {}); break;
        case 'present_debit': {
          if (bill.amount_due <= 0) { log.push(`${step}: debit(nothing)`); break; }
          const amount = Math.max(1, Math.ceil(bill.amount_due * (0.4 + random() * 0.6)));
          log.push(`${step}: debit ${amount}/${bill.amount_due}`);
          await attempt('POST', '/v1/payment_intents', { customer: customer.id, invoice: invoice.id, payment_method: debit.id, amount, confirm: true, off_session: true });
          break;
        }
        case 'pay_card': {
          if (bill.amount_due <= 0) { log.push(`${step}: card(nothing)`); break; }
          const amount = Math.max(1, Math.ceil(bill.amount_due * (0.1 + random() * 0.5)));
          log.push(`${step}: card ${amount}/${bill.amount_due}`);
          await attempt('POST', '/v1/payment_intents', { customer: customer.id, invoice: invoice.id, payment_method: card.id, amount, confirm: true, off_session: true });
          break;
        }
        case 'credit_note': {
          const amount = Math.max(1, Math.ceil(invoice.total * (0.05 + random() * 0.95)));
          log.push(`${step}: credit_note ${amount}`);
          await attempt('POST', '/v1/credit_notes', { invoice: invoice.id, amount, reason: 'order_change' });
          break;
        }
        case 'settle': { log.push(`${step}: travel 4d`); const t = await app.travel(4 * DAY); if (t.failed) problems.push(`jobs failed at step ${step}: ${t.failed}`); break; }
        case 'big_travel': { log.push(`${step}: travel 40d`); const t = await app.travel(40 * DAY); if (t.failed) problems.push(`jobs failed at step ${step}: ${t.failed}`); break; }
        case 'refund': {
          const charges = (await ok('GET', `/v1/charges?customer=${customer.id}&status=succeeded&limit=100`)).data
            .filter((c: any) => c.amount - c.amount_refunded - c.amount_disputed > 0)
            .sort((a: any, b: any) => a.created - b.created || a.amount - b.amount || a.amount_refunded - b.amount_refunded || a.amount_disputed - b.amount_disputed);
          if (!charges.length) { log.push(`${step}: refund(none)`); break; }
          const charge = pick(charges);
          const room = charge.amount - charge.amount_refunded - charge.amount_disputed;
          const amount = 1 + Math.floor(random() * room);
          log.push(`${step}: refund ${amount}/${room}`);
          await attempt('POST', '/v1/refunds', { charge: charge.id, amount, reason: 'requested_by_customer' });
          break;
        }
        case 'dispute': {
          const charges = (await ok('GET', `/v1/charges?customer=${customer.id}&status=succeeded&limit=100`)).data
            .filter((c: any) => c.amount - c.amount_refunded - c.amount_disputed > 0)
            .sort((a: any, b: any) => a.created - b.created || a.amount - b.amount || a.amount_refunded - b.amount_refunded || a.amount_disputed - b.amount_disputed);
          if (!charges.length) { log.push(`${step}: dispute(none)`); break; }
          const charge = pick(charges);
          const room = charge.amount - charge.amount_refunded - charge.amount_disputed;
          const amount = 1 + Math.floor(random() * room);
          log.push(`${step}: dispute ${amount}/${room}`);
          await attempt('POST', '/v1/disputes', { charge: charge.id, amount, reason: 'fraudulent' });
          break;
        }
        case 'close_dispute': {
          const open = (await ok('GET', `/v1/disputes?customer=${customer.id}&status=all&limit=50`)).data
            .filter((d: any) => d.status === 'needs_response' || d.status === 'under_review')
            .sort((a: any, b: any) => a.created - b.created || a.amount - b.amount);
          if (!open.length) { log.push(`${step}: close(none)`); break; }
          const d = pick(open);
          const won = random() < 0.5;
          log.push(`${step}: close ${won ? 'won' : 'lost'} ${d.amount}`);
          await attempt('POST', `/v1/disputes/${d.id}/close`, { status: won ? 'won' : 'lost' });
          break;
        }
        case 'cancel_intent': {
          const intents = (await ok('GET', `/v1/payment_intents?customer=${customer.id}&status=all&limit=100`)).data
            .filter((i: any) => i.status !== 'succeeded' && i.status !== 'canceled')
            .sort((a: any, b: any) => a.created - b.created || a.amount - b.amount);
          if (!intents.length) { log.push(`${step}: cancel(none)`); break; }
          const i = pick(intents);
          log.push(`${step}: cancel ${i.status} ${i.amount}`);
          await attempt('POST', `/v1/payment_intents/${i.id}/cancel`, { cancellation_reason: 'abandoned' });
          break;
        }
        case 'void_invoice': { log.push(`${step}: void`); await attempt('POST', `/v1/invoices/${invoice.id}/void`, {}); break; }
        case 'mark_uncollectible': { log.push(`${step}: uncollectible`); await attempt('POST', `/v1/invoices/${invoice.id}/mark_uncollectible`, {}); break; }
        case 'detach': {
          const m = pick(methods);
          log.push(`${step}: default -> ${m.type}/${m.simulated?.behavior ?? '?'}`);
          await attempt('POST', `/v1/payment_methods/${m.id}/set_default`, {});
          break;
        }
      }
      await check(`seed ${seed.toString(16)} step ${step} (${op})`);
      if (problems.length) break;
    }
    // final settle-out
    const t = await app.travel(500 * DAY);
    if (t.failed) problems.push(`final travel failed jobs: ${t.failed}`);
    await check(`seed ${seed.toString(16)} final`);
    const pending = (await ok('GET', `/v1/charges?customer=${customer.id}&status=pending&limit=100`)).data;
    if (pending.length) problems.push(`final: ${pending.length} charge(s) still pending after 500 days`);
    const camps = (await ok('GET', `/v1/dunning?status=all&customer=${customer.id}`)).data;
    for (const c of camps) {
      if (c.status === 'recovering') problems.push(`final: campaign on ${c.invoice} still recovering after 500 days (next ${c.next_attempt_at})`);
    }
  } catch (e) {
    problems.push(`threw: ${(e as Error).message}`);
  } finally {
    app.close();
  }
  if (problems.length) {
    console.log(`\n=== seed ${seed.toString(16)} ===`);
    console.log(log.join('\n'));
    for (const p of problems) console.log('  !! ' + p);
  }
  return problems.length;
}

const start = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 12);
let bad = 0;
for (let i = 0; i < count; i++) bad += (await run(0x5eed_0000 + start + i)) > 0 ? 1 : 0;
console.log(`\n${bad} of ${count} seeds had problems`);
