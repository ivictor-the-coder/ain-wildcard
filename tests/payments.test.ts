import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, frozenClock, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { DAY, dayKey } from '../src/shared/time';
import type { CreditNote, Invoice, Subscription } from '../src/server/modules/billing/types';
import type {
  Charge, Dispute, DunningAttempt, DunningView, PaymentIntent, PaymentMethod, Refund, SimulatedBehavior,
} from '../src/server/modules/payments/types';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };

const UTC = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h, 0, 0, 0);

/** Monday. Every retry-schedule assertion in this file is anchored to it. */
const MONDAY = UTC(2026, 6, 1);

interface Workspace {
  app: App;
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  ok(method: string, path: string, body?: unknown): Promise<any>;
  fail(method: string, path: string, body: unknown, status: number, code?: string): Promise<any>;
  now(): number;
  tick(): Promise<void>;
  travel(ms: number): Promise<{ ran: number; failed: number; now: number }>;
  customer(name?: string): Promise<any>;
  card(customerId: string, behavior?: SimulatedBehavior, over?: Record<string, unknown>): Promise<PaymentMethod>;
  /** A subscription whose first invoice has already been through collection. */
  subscribe(customerId: string, price?: string): Promise<{ sub: Subscription; invoice: Invoice }>;
  /** A finalised bill nothing has been presented against: no card was on file. */
  bill(customerId: string): Promise<{ sub: Subscription; invoice: Invoice }>;
  invoice(id: string): Promise<Invoice>;
  invoicesFor(subscriptionId: string): Promise<Invoice[]>;
  dunning(customerId: string): Promise<DunningView[]>;
  close(): void;
}

async function workspace(at = MONDAY): Promise<Workspace> {
  const app = await createApp({ db: 'memory', config: { env: 'test' }, clock: frozenClock(at) });
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, body, auth: DANA });
  let seq = 0;
  const ws: Workspace = {
    app,
    call,
    async ok(method, path, body) {
      const res = await call(method, path, body);
      assert.ok(res.status < 400, `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    },
    async fail(method, path, body, status, code) {
      const res = await call(method, path, body);
      assert.equal(res.status, status, `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      if (code) assert.equal(res.body.error.code, code, JSON.stringify(res.body));
      return res.body.error;
    },
    now: () => app.ctx.now(),
    async tick() { const r = await app.tick(); assert.equal(r.failed, 0, 'a job failed'); },
    travel: (ms) => app.travel(ms),
    customer(name = 'Halstead Precision') {
      seq += 1;
      return ws.ok('POST', '/v1/customers', {
        name: `${name} ${seq}`, email: `ap+pay${seq}@halstead.example`, currency: 'usd',
      });
    },
    card(customerId, behavior = 'succeeds', over = {}) {
      return ws.ok('POST', '/v1/payment_methods', {
        type: 'card', customer: customerId, brand: 'visa', exp_month: 4, exp_year: 2031,
        simulated_behavior: behavior, ...over,
      });
    },
    async subscribe(customerId, price = 'growth_monthly') {
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: customerId, items: [{ price }],
      });
      await ws.tick();
      const invoices = await ws.invoicesFor(sub.id);
      assert.ok(invoices.length === 1, `expected one invoice for ${sub.id}, got ${invoices.length}`);
      return { sub: await ws.ok('GET', `/v1/subscriptions/${sub.id}`), invoice: invoices[0] };
    },
    async bill(customerId) {
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: customerId, items: [{ price: 'growth_monthly' }],
      });
      await ws.tick();
      const invoices = await ws.invoicesFor(sub.id);
      assert.equal(invoices.length, 1, `expected one invoice for ${sub.id}, got ${invoices.length}`);
      assert.equal(invoices[0].status, 'open', 'no method was on file, so nothing was presented');
      return { sub, invoice: invoices[0] };
    },
    invoice: (id) => ws.ok('GET', `/v1/invoices/${id}`),
    async invoicesFor(subscriptionId) {
      const page = await ws.ok('GET', `/v1/invoices?subscription=${subscriptionId}&limit=100`);
      return (page.data as Invoice[]).slice().sort((a, b) => a.created - b.created);
    },
    async dunning(customerId) {
      const page = await ws.ok('GET', `/v1/dunning?status=all&customer=${customerId}`);
      return page.data as DunningView[];
    },
    close: () => app.close(),
  };
  return ws;
}

const attemptDays = (attempts: DunningAttempt[]): string[] => attempts.map((a) => dayKey(a.attempted_at));

/* ========================================================================== *
 * 1. The simulated processor
 * ========================================================================== */

describe('the simulated processor', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(); });
  after(() => ws.close());

  const CARD_DECLINES: SimulatedBehavior[] = [
    'insufficient_funds', 'card_declined', 'expired_card', 'incorrect_cvc', 'processing_error',
  ];

  for (const behavior of CARD_DECLINES) {
    test(`a card declared "${behavior}" declines with exactly that code, every time`, async () => {
      const customer = await ws.customer();
      const method = await ws.card(customer.id, behavior);
      for (const attempt of [1, 2]) {
        const intent: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
          customer: customer.id, amount: 12_500, currency: 'usd', payment_method: method.id,
          confirm: true, off_session: true,
        });
        assert.equal(intent.status, 'requires_payment_method', `attempt ${attempt}: a declined intent goes back to needing a method`);
        assert.equal(intent.last_payment_error?.code, behavior);
        assert.ok(intent.last_payment_error?.advice.length ?? 0 > 20, 'the error carries advice, not just a code');

        const charge: Charge = await ws.ok('GET', `/v1/charges/${intent.latest_charge}`);
        assert.equal(charge.status, 'failed');
        assert.equal(charge.failure_code, behavior);
        assert.equal(charge.outcome.reason, behavior);
        assert.ok(charge.outcome.seller_message.length > 30, 'the outcome explains the decision in words');
        assert.ok(['issuer_declined', 'invalid', 'blocked'].includes(charge.outcome.type));
      }
    });
  }

  test('a card that is declared to succeed is authorised, with an authorisation code', async () => {
    const customer = await ws.customer();
    const method = await ws.card(customer.id, 'succeeds');
    const intent: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
      customer: customer.id, amount: 9_900, currency: 'usd', payment_method: method.id, confirm: true,
    });
    assert.equal(intent.status, 'succeeded');
    assert.equal(intent.last_payment_error, null);
    const charge: Charge = await ws.ok('GET', `/v1/charges/${intent.latest_charge}`);
    assert.equal(charge.status, 'succeeded');
    assert.equal(charge.paid, true);
    assert.equal(charge.outcome.type, 'authorized');
    assert.match(charge.authorization_code ?? '', /^\d{6}$/);
  });

  test('simulated_decline_count declines exactly that many attempts and then stops', async () => {
    const customer = await ws.customer();
    const method = await ws.card(customer.id, 'insufficient_funds', { simulated_decline_count: 2 });
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const intent: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, amount: 5_000, currency: 'usd', payment_method: method.id,
        confirm: true, off_session: true,
      });
      outcomes.push(intent.status);
    }
    assert.deepEqual(outcomes, [
      'requires_payment_method', 'requires_payment_method', 'succeeded', 'succeeded',
    ]);
  });

  test('authentication_required declines off-session and asks for the cardholder on-session', async () => {
    const customer = await ws.customer();
    const method = await ws.card(customer.id, 'authentication_required');

    const offSession: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
      customer: customer.id, amount: 4_200, currency: 'usd', payment_method: method.id,
      confirm: true, off_session: true,
    });
    assert.equal(offSession.status, 'requires_payment_method', 'nobody is there to authenticate, so the bank refuses');
    assert.equal(offSession.last_payment_error?.code, 'authentication_required');

    const onSession: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
      customer: customer.id, amount: 4_200, currency: 'usd', payment_method: method.id, confirm: true,
    });
    assert.equal(onSession.status, 'requires_action');
    assert.equal(onSession.next_action?.type, 'authenticate');
    assert.equal(onSession.next_action?.authenticate_url, `/v1/payment_intents/${onSession.id}/authenticate`);

    const abandoned: PaymentIntent = await ws.ok('POST', `/v1/payment_intents/${onSession.id}/authenticate`, { result: 'abandon' });
    assert.equal(abandoned.status, 'requires_payment_method');
    assert.equal(abandoned.last_payment_error?.code, 'authentication_required');

    const second: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
      customer: customer.id, amount: 4_200, currency: 'usd', payment_method: method.id, confirm: true,
    });
    const approved: PaymentIntent = await ws.ok('POST', `/v1/payment_intents/${second.id}/authenticate`, { result: 'approve' });
    assert.equal(approved.status, 'succeeded');
  });

  test('a direct debit is presented, not authorised — it settles days later', async () => {
    const customer = await ws.customer();
    const method: PaymentMethod = await ws.ok('POST', '/v1/payment_methods', {
      type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank', account_type: 'checking',
      simulated_behavior: 'succeeds',
    });
    assert.ok(method.bank_debit?.mandate_reference, 'a debit without a mandate is not collectable');

    const intent: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
      customer: customer.id, amount: 30_000, currency: 'usd', payment_method: method.id, confirm: true,
    });
    assert.equal(intent.status, 'processing');
    const pending: Charge = await ws.ok('GET', `/v1/charges/${intent.latest_charge}`);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.outcome.network_status, 'pending_settlement');

    await ws.travel(4 * DAY);
    const settled: PaymentIntent = await ws.ok('GET', `/v1/payment_intents/${intent.id}`);
    assert.equal(settled.status, 'succeeded');
  });

  test('a direct debit that comes back unpaid reports the bank’s reason, days after the fact', async () => {
    const customer = await ws.customer();
    const method: PaymentMethod = await ws.ok('POST', '/v1/payment_methods', {
      type: 'bank_debit', customer: customer.id, simulated_behavior: 'account_closed',
    });
    const intent: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
      customer: customer.id, amount: 30_000, currency: 'usd', payment_method: method.id, confirm: true,
    });
    assert.equal(intent.status, 'processing', 'the instruction is accepted before it is refused');
    await ws.travel(4 * DAY);
    const returned: PaymentIntent = await ws.ok('GET', `/v1/payment_intents/${intent.id}`);
    assert.equal(returned.status, 'requires_payment_method');
    assert.equal(returned.last_payment_error?.code, 'account_closed');
  });

  test('a card cannot be given a failure mode that belongs to a bank account', async () => {
    const customer = await ws.customer();
    await ws.fail('POST', '/v1/payment_methods', {
      type: 'card', customer: customer.id, simulated_behavior: 'account_closed',
    }, 400, 'simulated_behavior_unsupported');
  });

  test('a card number is refused outright — this platform never stores one', async () => {
    const customer = await ws.customer();
    await ws.fail('POST', '/v1/payment_methods', {
      type: 'card', customer: customer.id, billing_name: '4242 4242 4242 4242',
    }, 400, 'card_number_refused');
  });

  test('an expired card declines whatever its declared behaviour says', async () => {
    const customer = await ws.customer();
    const method = await ws.card(customer.id, 'succeeds', { exp_month: 1, exp_year: 2026 });
    const intent: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
      customer: customer.id, amount: 1_000, currency: 'usd', payment_method: method.id, confirm: true, off_session: true,
    });
    assert.equal(intent.last_payment_error?.code, 'expired_card');
  });

  test('an idempotency key makes a replayed create return the first intent, not a second charge', async () => {
    const customer = await ws.customer();
    const method = await ws.card(customer.id, 'succeeds');
    const body = {
      customer: customer.id, amount: 7_700, currency: 'usd', payment_method: method.id,
      confirm: true, idempotency_key: 'test-collect-once',
    };
    const first: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', body);
    const replay: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', body);
    assert.equal(replay.id, first.id);
    const charges = await ws.ok('GET', `/v1/charges?payment_intent=${first.id}`);
    assert.equal(charges.data.length, 1, 'the customer is charged once, not twice');
  });
});

/* ========================================================================== *
 * 2. Automatic collection
 * ========================================================================== */

describe('collecting an invoice', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(); });
  after(() => ws.close());

  test('a finalised invoice is charged to the card on file', async () => {
    const customer = await ws.customer();
    await ws.card(customer.id, 'succeeds');
    const { sub, invoice } = await ws.subscribe(customer.id);

    assert.equal(invoice.status, 'paid');
    assert.equal(invoice.amount_due, 0);
    assert.equal(invoice.amount_paid, invoice.total);
    assert.equal(sub.status, 'active');

    const charges = await ws.ok('GET', `/v1/charges?invoice=${invoice.id}`);
    assert.equal(charges.data.length, 1);
    assert.equal((charges.data[0] as Charge).amount, invoice.total);
  });

  test('an account with no payment method is left alone, not marked delinquent', async () => {
    const customer = await ws.customer();
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }],
    });
    await ws.tick();
    const [invoice] = await ws.invoicesFor(sub.id);
    assert.equal(invoice.status, 'open', 'there is nothing to charge, so nothing was charged');
    assert.equal((await ws.dunning(customer.id)).length, 0, 'a bill nobody tried to collect is not in recovery');
    assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active');
  });

  test('a bill on invoice terms is never presented to a card', async () => {
    const customer = await ws.customer();
    await ws.card(customer.id, 'succeeds');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'growth_monthly' }], collection_method: 'send_invoice', days_until_due: 30,
    });
    await ws.tick();
    const [invoice] = await ws.invoicesFor(sub.id);
    assert.equal(invoice.status, 'open');
    const error = await ws.fail('POST', `/v1/invoices/${invoice.id}/retry`, {}, 409, 'invoice_not_collectable');
    assert.match(error.message, /bank transfer/);
  });
});

/* ========================================================================== *
 * 2b. Cash taken and cash recorded are the same number
 *
 * A payments system is judged on its worst outcome. The worst one available to
 * this module is taking a card twice for one bill and accounting for it once,
 * so every path that could do it is nailed down here — at the confirm, where
 * it is refused, and at the ledger, where anything that arrives anyway becomes
 * credit on the customer's account instead of a rounding artefact.
 * ========================================================================== */

describe('a bill is never collected twice in silence', () => {
  /** Every unit that left the customer's account, against the bill it hit. */
  const cashTaken = async (ws: Workspace, invoiceId: string): Promise<number> => {
    const page = await ws.ok('GET', `/v1/charges?invoice=${invoiceId}&status=all&limit=100`);
    return (page.data as Charge[]).filter((c) => c.status === 'succeeded').reduce((total, c) => total + c.amount, 0);
  };

  /** What the platform says it did with that cash: on the bill, or on the account. */
  const accountedFor = async (ws: Workspace, invoiceId: string, customerId: string): Promise<number> => {
    const invoice = await ws.invoice(invoiceId);
    const ledger = await ws.ok('GET', `/v1/customers/${customerId}/balance_transactions?limit=200`);
    const credited = (ledger.data as { type: string; amount: number; invoice: string | null }[])
      .filter((row) => row.type === 'invoice_overpayment' && row.invoice === invoiceId)
      .reduce((total, row) => total - row.amount, 0);
    return invoice.amount_paid + credited;
  };

  test('a second intent on a settled bill is refused before the card is touched', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Loxley Handling');
      const { invoice } = await ws.bill(customer.id);
      const method = await ws.card(customer.id, 'succeeds');

      // Two intents, both quoting the full bill — a pay page opened in two tabs.
      const first: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: method.id,
      });
      const second: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: method.id,
      });
      assert.equal(first.amount, invoice.total);
      assert.equal(second.amount, invoice.total);

      const paid: PaymentIntent = await ws.ok('POST', `/v1/payment_intents/${first.id}/confirm`, {});
      assert.equal(paid.status, 'succeeded');

      const error = await ws.fail('POST', `/v1/payment_intents/${second.id}/confirm`, {}, 409, 'invoice_already_paid');
      assert.match(error.message, /nothing left to collect/);

      const untouched: PaymentIntent = await ws.ok('GET', `/v1/payment_intents/${second.id}`);
      assert.equal(untouched.status, 'requires_confirmation', 'a refused confirm does not report the money as collected');
      assert.equal(untouched.latest_charge, null);
      assert.equal(untouched.succeeded_at, null);
      assert.equal(untouched.attempt_count, 0, 'the card was never presented, so nothing was attempted');

      assert.equal(await cashTaken(ws, invoice.id), invoice.total, 'the customer was charged once');
      assert.equal(await accountedFor(ws, invoice.id, customer.id), invoice.total);
      assert.equal((await ws.ok('GET', `/v1/refunds?invoice=${invoice.id}`)).data.length, 0, 'nothing had to be given back');
    } finally { ws.close(); }
  });

  test('a credit note between the quote and the charge takes the intent down with the bill', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Brackley Hydraulics');
      const { invoice } = await ws.bill(customer.id);
      const method = await ws.card(customer.id, 'succeeds');

      const quoted: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: method.id,
      });
      assert.equal(quoted.amount, invoice.total, 'the intent freezes what was owed when it was made');

      const half = invoice.total / 2;
      await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: half, reason: 'order_change' });
      const credited = await ws.invoice(invoice.id);
      assert.equal(credited.pre_payment_credit_notes_amount, half);
      assert.equal(credited.amount_due, half);

      const confirmed: PaymentIntent = await ws.ok('POST', `/v1/payment_intents/${quoted.id}/confirm`, {});
      assert.equal(confirmed.status, 'succeeded');
      assert.equal(confirmed.amount, half, 'the charge follows the bill down instead of collecting the difference');

      const charge: Charge = await ws.ok('GET', `/v1/charges/${confirmed.latest_charge}`);
      assert.equal(charge.amount, half);

      const settled = await ws.invoice(invoice.id);
      assert.equal(settled.status, 'paid');
      assert.equal(settled.amount_paid, half);
      assert.equal(await cashTaken(ws, invoice.id), half);
      assert.equal(await accountedFor(ws, invoice.id, customer.id), half);

      const events = await ws.ok('GET', `/v1/events?type=payment_intent.amount_updated&limit=20`);
      const repriced = (events.data as any[]).find((e) => e.data?.payment_intent === quoted.id);
      assert.ok(repriced, 'the re-pricing is on the event stream, not silent');
      assert.equal(repriced.data.previous_amount, invoice.total);
      assert.equal(repriced.data.amount, half);
    } finally { ws.close(); }
  });

  test('a part payment stays the part payment that was authorised', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Ilkeston Gears');
      const { invoice } = await ws.bill(customer.id);
      const method = await ws.card(customer.id, 'succeeds');

      const deposit: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: method.id, amount: 10_000, confirm: true,
      });
      assert.equal(deposit.status, 'succeeded');
      assert.equal(deposit.amount, 10_000, 'an amount smaller than the bill is never raised to meet it');

      const partly = await ws.invoice(invoice.id);
      assert.equal(partly.status, 'open');
      assert.equal(partly.amount_paid, 10_000);
      assert.equal(partly.amount_due, invoice.total - 10_000);

      const rest: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: method.id, confirm: true,
      });
      assert.equal(rest.amount, invoice.total - 10_000, 'the second intent quotes what is left, not the whole bill');
      const settled = await ws.invoice(invoice.id);
      assert.equal(settled.status, 'paid');
      assert.equal(await cashTaken(ws, invoice.id), invoice.total);
      assert.equal(await accountedFor(ws, invoice.id, customer.id), invoice.total);
    } finally { ws.close(); }
  });

  test('a withdrawn bill cannot be charged by an intent that was made before it was withdrawn', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Merton Castings');
      const { invoice } = await ws.bill(customer.id);
      const method = await ws.card(customer.id, 'succeeds');
      const intent: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: method.id,
      });

      await ws.ok('POST', `/v1/invoices/${invoice.id}/void`, {});
      const error = await ws.fail('POST', `/v1/payment_intents/${intent.id}/confirm`, {}, 409, 'invoice_void');
      assert.match(error.message, /no longer exists/);
      assert.equal(await cashTaken(ws, invoice.id), 0);
    } finally { ws.close(); }
  });

  test('a debit that settles after the bill shrank credits the difference to the customer', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Sandwell Conveyors');
      const { invoice } = await ws.bill(customer.id);
      const method: PaymentMethod = await ws.ok('POST', '/v1/payment_methods', {
        type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank',
        account_type: 'checking', simulated_behavior: 'succeeds',
      });

      // The instruction is with the bank: this money is already committed and
      // no confirm-time check can call it back.
      const presented: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: method.id, confirm: true, off_session: true,
      });
      assert.equal(presented.status, 'processing');
      assert.equal(presented.amount, invoice.total);

      const half = invoice.total / 2;
      await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: half, reason: 'order_change' });

      const travelled = await ws.travel(5 * DAY);
      assert.equal(travelled.failed, 0);

      const settled = await ws.invoice(invoice.id);
      assert.equal(settled.status, 'paid');
      assert.equal(settled.amount_paid, half, 'the bill records only what the bill was owed');
      assert.equal(await cashTaken(ws, invoice.id), invoice.total, 'the bank took the whole instruction');
      assert.equal(
        await accountedFor(ws, invoice.id, customer.id), invoice.total,
        'every unit the bank took is either on the bill or on the account',
      );

      const ledger = await ws.ok('GET', `/v1/customers/${customer.id}/balance_transactions`);
      const overpayment = (ledger.data as any[]).find((row) => row.type === 'invoice_overpayment');
      assert.ok(overpayment, 'the difference is a ledger row, not a rounding artefact');
      assert.equal(overpayment.amount, -half, 'a credit is negative, the Stripe convention');
      assert.equal(overpayment.invoice, invoice.id);
      assert.ok(overpayment.description.includes(settled.number), 'the row says which bill it came off');
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, -half);

      const events = await ws.ok('GET', '/v1/events?type=invoice.overpaid&limit=20');
      const overpaid = (events.data as any[]).find((e) => e.data?.invoice === invoice.id);
      assert.ok(overpaid, 'invoice.overpaid is emitted, so a webhook sees it too');
      assert.equal(overpaid.data.amount_overpaid, half);
      assert.equal(overpaid.data.customer_balance, -half);
    } finally { ws.close(); }
  });

  test('a dispute won on a bill that has since been credited puts the money on the account', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Ravensworth Tooling');
      await ws.card(customer.id, 'succeeds');
      const { invoice } = await ws.subscribe(customer.id);
      assert.equal(invoice.status, 'paid');

      const charges = await ws.ok('GET', `/v1/charges?invoice=${invoice.id}`);
      const dispute: Dispute = await ws.ok('POST', '/v1/disputes', {
        charge: (charges.data[0] as Charge).id, reason: 'fraudulent',
      });
      const withdrawn = await ws.invoice(invoice.id);
      assert.equal(withdrawn.status, 'open', 'the network took the money the day it was disputed');
      assert.equal(withdrawn.amount_due, invoice.total);

      const held = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(held.cash_collected, invoice.total);
      assert.equal(held.amount_disputed, invoice.total, 'the network is holding it while the case is open');
      assert.equal(held.amount_paid, 0);

      // Support credits the bill in full while the case is open.
      await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: withdrawn.amount_due, reason: 'order_change' });
      const credited = await ws.invoice(invoice.id);
      assert.equal(credited.amount_due, 0);

      await ws.ok('POST', `/v1/disputes/${dispute.id}/evidence`, {
        product_description: 'Fleet telemetry seats, delivered and in use since 1 June.',
      });
      await ws.ok('POST', `/v1/disputes/${dispute.id}/close`, { status: 'won' });

      const after = await ws.invoice(invoice.id);
      assert.equal(after.amount_paid, 0, 'the bill was credited to nothing, so it takes none of it back');
      const ledger = await ws.ok('GET', `/v1/customers/${customer.id}/balance_transactions`);
      const overpayment = (ledger.data as any[]).find((row) => row.type === 'invoice_overpayment');
      assert.ok(overpayment, 'the returned money is the customer’s, and it is on their account');
      assert.equal(overpayment.amount, -invoice.total);
      assert.equal(await accountedFor(ws, invoice.id, customer.id), invoice.total);
    } finally { ws.close(); }
  });

  test('one bill’s money reads back as one story, cash in and cash accounted for', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Hetherington Drives');
      const { invoice } = await ws.bill(customer.id);
      const method: PaymentMethod = await ws.ok('POST', '/v1/payment_methods', {
        type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank',
        account_type: 'checking', simulated_behavior: 'succeeds',
      });

      const before = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(before.cash_collected, 0);
      assert.equal(before.amount_overpaid, 0);
      assert.equal(before.collectable, true);
      assert.match(before.summary, /Nothing has been collected/);

      await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: method.id, confirm: true, off_session: true,
      });
      const half = invoice.total / 2;
      await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: half, reason: 'order_change' });
      assert.equal((await ws.travel(5 * DAY)).failed, 0);

      const after = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(after.cash_collected, invoice.total, 'what the bank took');
      assert.equal(after.amount_paid, half, 'what the bill absorbed');
      assert.equal(after.amount_overpaid, half, 'and what went past it, on the account rather than nowhere');
      assert.equal(after.amount_paid + after.amount_overpaid, after.cash_collected);
      assert.equal(after.amount_refunded, 0);
      assert.equal(after.collectable, false);
      assert.equal(after.charges.length, 1);
      assert.equal(after.payment_intents.length, 1);
      assert.match(after.summary, /went past it/);

      const blocked = await ws.fail('POST', `/v1/invoices/${invoice.id}/retry`, {}, 409, 'invoice_not_collectable');
      assert.match(blocked.message, /already paid/, 'a settled bill is not presented again');
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 2c. Money going back out is the mirror of money coming in
 *
 * `applyCollection` fills the bill first and puts only the excess on the
 * customer's account. Reversal has to run that backwards — empty the account
 * first, then reach into the bill — or the two halves disagree and a refund
 * pays a customer twice: the cash goes back, the credit that same cash created
 * stays, and the bill it never owed reopens for the difference.
 *
 * The identity underneath every test here, and the one the property test at
 * the end holds over random sequences:
 *
 *     net cash in === invoice amount_paid + overpayment credit on the account
 *
 * where net cash in is every succeeded charge, less what has been refunded,
 * less what the network is holding over an open or lost dispute.
 * ========================================================================== */

/** Every unit the customer's account is out of pocket for this bill, right now. */
const netCashIn = (view: any): number => view.cash_collected - view.amount_refunded - view.amount_disputed;

/**
 * The identity, asserted from two independent places: the payments view, and
 * the customer's own balance ledger. Reading the credit back out of the ledger
 * is what catches an overpayment row filed against the wrong bill — the view
 * would agree with itself either way.
 *
 * The identity on its own is necessary and not sufficient, which is the whole
 * reason `assertCashHeld` exists in the gateway and the reason the second loop
 * below does: a bill that ends up holding more of a customer's cash than it
 * could ever be owed satisfies `net cash in === amount_paid + credit` exactly,
 * because the cash *is* on the bill — sitting against a negative `amount_due`
 * that nobody can act on and no ledger records. So what the bill can hold is
 * asserted here too, against what was written rather than what was computed.
 */
async function assertReconciled(ws: Workspace, customerId: string, where: string): Promise<number> {
  const invoices = (await ws.ok('GET', `/v1/invoices?customer=${customerId}&status=all&limit=100`)).data as Invoice[];
  const ledger = (await ws.ok('GET', `/v1/customers/${customerId}/balance_transactions?limit=200`)).data as
    { type: string; amount: number; invoice: string | null }[];
  const overpaymentRows = ledger.filter((row) => row.type === 'invoice_overpayment');

  let cash = 0;
  let accounted = 0;
  for (const invoice of invoices) {
    const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
    const creditForBill = overpaymentRows
      .filter((row) => row.invoice === invoice.id)
      .reduce((total, row) => total - row.amount, 0);
    assert.equal(
      view.amount_overpaid, creditForBill,
      `${where}: ${invoice.number} reports ${view.amount_overpaid} of overpayment but the ledger holds ${creditForBill} against it`,
    );
    assert.ok(creditForBill >= 0, `${where}: ${invoice.number} holds negative overpayment credit (${creditForBill})`);
    assert.equal(
      netCashIn(view), view.amount_paid + view.amount_overpaid,
      `${where}: ${invoice.number} took ${netCashIn(view)} net and accounts for ${view.amount_paid} on the bill + ${view.amount_overpaid} on the account`,
    );
    // A struck-out bill is the one document allowed to record cash it is not
    // owed: voiding leaves whatever was collected in `amount_paid` so a refund
    // can still reach it. Every other bill has to be able to hold what it says
    // it holds.
    if (invoice.status !== 'void') {
      const collectable = invoice.total - invoice.pre_payment_credit_notes_amount;
      assert.ok(
        invoice.amount_paid >= 0 && invoice.amount_paid <= collectable,
        `${where}: ${invoice.number} records ${invoice.amount_paid} collected but can only ever be owed ${collectable}, so ${invoice.amount_paid - collectable} of the customer's money is on a bill that cannot hold it and on nobody's account`,
      );
      assert.ok(
        invoice.amount_due >= 0,
        `${where}: ${invoice.number} is owed ${invoice.amount_due}, which is not a bill anybody can act on`,
      );
      // The half the identity is blindest to, because it balances perfectly
      // while it is false: a bill that can still absorb money holding the
      // customer's cash as credit against *itself*. `applyCollection` only
      // lands the excess once the room is gone, so the two are never both
      // positive — and the next presentation against a bill in that state
      // collects money the customer has already paid on it.
      assert.ok(
        creditForBill === 0 || invoice.amount_paid >= collectable,
        `${where}: ${invoice.number} can still absorb ${collectable - invoice.amount_paid} and is at the same time holding ${creditForBill} of the customer's cash as credit against itself, so presenting it again would collect money they have already paid on it`,
      );
    }
    cash += netCashIn(view);
    accounted += view.amount_paid;
  }
  const credit = overpaymentRows.reduce((total, row) => total - row.amount, 0);
  assert.equal(
    cash, accounted + credit,
    `${where}: ${cash} net cash in across the account, but ${accounted} recorded on bills + ${credit} of overpayment credit`,
  );
  return credit;
}

/** A $499.00 bill, a bank debit already with the bank, and $300.00 credited while it flew. */
async function overpaidByCreditNote(ws: Workspace, name: string): Promise<{
  customer: any; invoice: Invoice; method: PaymentMethod; charge: Charge;
}> {
  const customer = await ws.customer(name);
  const { invoice } = await ws.bill(customer.id);
  assert.equal(invoice.total, 49_900, 'the growth plan is $499.00 a month');
  const method: PaymentMethod = await ws.ok('POST', '/v1/payment_methods', {
    type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank',
    account_type: 'checking', simulated_behavior: 'succeeds',
  });
  const presented: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
    customer: customer.id, invoice: invoice.id, payment_method: method.id, confirm: true, off_session: true,
  });
  assert.equal(presented.status, 'processing', 'the instruction is with the bank and cannot be called back');
  await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 30_000, reason: 'order_change' });
  assert.equal((await ws.travel(5 * DAY)).failed, 0);

  const settled = await ws.invoice(invoice.id);
  assert.equal(settled.status, 'paid');
  assert.equal(settled.amount_paid, 19_900, 'the bill absorbed only the $199.00 it was still owed');
  const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
  assert.equal(view.cash_collected, 49_900, 'the bank took the whole instruction');
  assert.equal(view.amount_overpaid, 30_000, 'and $300.00 of it became credit on the account');
  assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, -30_000);
  await assertReconciled(ws, customer.id, 'after the debit settled');

  const charge = (view.charges as Charge[]).find((c) => c.status === 'succeeded') as Charge;
  return { customer, invoice: settled, method, charge };
}

describe('money going back out is the mirror of money coming in', () => {
  test('refunding an overpayment gives back the credit it made, and leaves the bill paid', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice, charge } = await overpaidByCreditNote(ws, 'Kettering Valves');

      // The module's own documented remedy for an overpayment: refund the
      // excess against the charge that collected it.
      const refund: Refund = await ws.ok('POST', '/v1/refunds', {
        charge: charge.id, amount: 30_000, reason: 'requested_by_customer',
      });
      assert.equal(refund.amount, 30_000);

      const after = await ws.invoice(invoice.id);
      assert.equal(after.status, 'paid', 'the bill was settled and stays settled — none of its own money went back');
      assert.equal(after.amount_paid, 19_900);
      assert.equal(after.amount_due, 0, 'a customer who paid their bill is not shown owing it again');

      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.amount_refunded, 30_000);
      assert.equal(view.amount_overpaid, 0, 'the credit went back with the cash that made it');
      assert.equal(netCashIn(view), 19_900, '$499.00 taken, $300.00 returned, $199.00 kept');
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, 0, 'the customer is not paid twice');
      await assertReconciled(ws, customer.id, 'after refunding the overpayment');

      const events = await ws.ok('GET', '/v1/events?type=invoice.overpayment_reversed&limit=20');
      const reversed = (events.data as any[]).find((e) => e.data?.invoice === invoice.id);
      assert.ok(reversed, 'the credit coming back off the account is on the event stream, not silent');
      assert.equal(reversed.data.amount, 30_000);
      assert.equal(reversed.data.amount_overpaid, 0, 'and it says what is left, which is nothing');
      assert.equal(reversed.data.customer_balance, 0);

      const ledger = (await ws.ok('GET', `/v1/customers/${customer.id}/balance_transactions?limit=50`)).data as any[];
      const takenBack = ledger.find((row) => row.type === 'invoice_overpayment' && row.amount > 0);
      assert.ok(takenBack, 'the reversal is a ledger row of its own, so the account reads as one story');
      assert.equal(takenBack.amount, 30_000);
      assert.equal(takenBack.ending_balance, 0);
    } finally { ws.close(); }
  });

  test('a refund bigger than the credit takes the credit first and only then the bill', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice, charge } = await overpaidByCreditNote(ws, 'Alderley Pumps');

      await ws.ok('POST', '/v1/refunds', { charge: charge.id, amount: 40_000, reason: 'requested_by_customer' });

      const after = await ws.invoice(invoice.id);
      assert.equal(after.amount_paid, 9_900, '$300.00 came off the account and only the last $100.00 off the bill');
      assert.equal(after.amount_due, 10_000, 'and the bill is owed exactly what was taken back out of it');
      assert.equal(after.status, 'open');
      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.amount_overpaid, 0);
      assert.equal(netCashIn(view), 9_900);
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, 0);
      await assertReconciled(ws, customer.id, 'after a refund that outran the credit');
    } finally { ws.close(); }
  });

  test('a chargeback over a bill holding credit takes the credit first, and a win puts it all back', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice, charge } = await overpaidByCreditNote(ws, 'Wrekin Pneumatics');

      const dispute: Dispute = await ws.ok('POST', '/v1/disputes', { charge: charge.id, reason: 'fraudulent' });
      assert.equal(dispute.amount, 49_900, 'the network pulls the whole charge');

      const withdrawn = await ws.invoice(invoice.id);
      assert.equal(withdrawn.status, 'open', 'the money went the day the cardholder complained');
      assert.equal(withdrawn.amount_paid, 0);
      assert.equal(withdrawn.amount_due, 19_900, 'what is owed again is the bill, not the bill plus the credit');
      const held = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(held.amount_overpaid, 0, 'the credit went with the money the network took');
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, 0);
      assert.equal(netCashIn(held), 0);
      await assertReconciled(ws, customer.id, 'while the chargeback is open');

      await ws.ok('POST', `/v1/disputes/${dispute.id}/evidence`, {
        product_description: 'Fleet telemetry seats, delivered and in use for the whole billed period.',
      });
      await ws.ok('POST', `/v1/disputes/${dispute.id}/close`, { status: 'won' });

      const returned = await ws.invoice(invoice.id);
      assert.equal(returned.status, 'paid', 'the money came back, so the bill is settled again');
      assert.equal(returned.amount_paid, 19_900);
      const back = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(back.amount_overpaid, 30_000, 'and the credit is back on the account, to the penny');
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, -30_000);
      assert.equal(netCashIn(back), 49_900);
      await assertReconciled(ws, customer.id, 'after the chargeback was won');
    } finally { ws.close(); }
  });

  test('a debit that settles onto a withdrawn bill is all credit, and all of it can be refunded', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Tamworth Linkages');
      const { invoice } = await ws.bill(customer.id);
      const method: PaymentMethod = await ws.ok('POST', '/v1/payment_methods', {
        type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank',
        account_type: 'checking', simulated_behavior: 'succeeds',
      });
      await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: method.id, confirm: true, off_session: true,
      });
      await ws.ok('POST', `/v1/invoices/${invoice.id}/void`, {});
      assert.equal((await ws.travel(5 * DAY)).failed, 0);

      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.cash_collected, invoice.total, 'the bank took the instruction anyway');
      assert.equal(view.amount_paid, 0, 'a withdrawn bill absorbs nothing');
      assert.equal(view.amount_overpaid, invoice.total, 'so all of it is the customer’s, on their account');
      await assertReconciled(ws, customer.id, 'after settling onto a withdrawn bill');

      const charge = (view.charges as Charge[]).find((c) => c.status === 'succeeded') as Charge;
      await ws.ok('POST', '/v1/refunds', { charge: charge.id, reason: 'requested_by_customer' });

      const after = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(after.amount_overpaid, 0, 'the customer asked for the money instead of the credit, and got it once');
      assert.equal(after.amount_paid, 0, 'the withdrawn bill is still untouched');
      assert.equal(netCashIn(after), 0);
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, 0);
      await assertReconciled(ws, customer.id, 'after refunding a withdrawn bill’s credit');
    } finally { ws.close(); }
  });

  test('a direct debit with the bank is presented once, however many times collection is asked for', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Corby Bearings');
      const { invoice } = await ws.bill(customer.id);
      await ws.ok('POST', '/v1/payment_methods', {
        type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank',
        account_type: 'checking', simulated_behavior: 'succeeds',
      });

      const first = await ws.ok('POST', `/v1/invoices/${invoice.id}/retry`, {});
      assert.equal(first.payment_intent.status, 'processing');

      for (const attempt of [2, 3]) {
        const refused = await ws.fail('POST', `/v1/invoices/${invoice.id}/retry`, {}, 409, 'invoice_not_collectable');
        assert.match(refused.message, /already with the bank/, `attempt ${attempt} says why it did not present`);
        assert.match(refused.message, /twice/);
      }

      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.charges.length, 1, 'one bill, one instruction');
      assert.equal(view.payment_intents.length, 1);
      assert.equal(view.collectable, false, 'and the bill says so before anyone clicks again');

      assert.equal((await ws.travel(5 * DAY)).failed, 0);
      const settled = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(settled.cash_collected, invoice.total, 'the bank was asked for $499.00 once, not three times');
      assert.equal(settled.amount_paid, invoice.total);
      assert.equal(settled.amount_overpaid, 0, 'nothing had to be handed back as credit the customer never owed');
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, 0);
      await assertReconciled(ws, customer.id, 'after one debit settled');
    } finally { ws.close(); }
  });

  test('a card cannot be run against a bill whose debit is still with the bank', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Rugeley Actuators');
      const { invoice } = await ws.bill(customer.id);
      const debit: PaymentMethod = await ws.ok('POST', '/v1/payment_methods', {
        type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank',
        account_type: 'checking', simulated_behavior: 'succeeds',
      });
      const card = await ws.card(customer.id, 'succeeds');
      await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: debit.id, confirm: true, off_session: true,
      });

      const quoted: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: card.id,
      });
      const error = await ws.fail('POST', `/v1/payment_intents/${quoted.id}/confirm`, {}, 409, 'invoice_payment_in_flight');
      // The advice has to name something that can actually be done. A debit
      // that has been presented cannot be recalled — cancelling the intent only
      // rewrites a column here and strands the charge as in flight for ever —
      // so what is left is to wait for the bank and refund what arrives.
      assert.match(error.message, /Wait for the bank/);
      assert.match(error.message, /cannot be recalled/);

      const untouched: PaymentIntent = await ws.ok('GET', `/v1/payment_intents/${quoted.id}`);
      assert.equal(untouched.attempt_count, 0, 'the card was never presented');
      assert.equal(untouched.latest_charge, null);

      assert.equal((await ws.travel(5 * DAY)).failed, 0);
      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.cash_collected, invoice.total, 'the bill was collected once, by the bank');
      assert.equal(view.amount_overpaid, 0);
      await assertReconciled(ws, customer.id, 'after refusing a card over an in-flight debit');
    } finally { ws.close(); }
  });

  test('a debit covering only part of a bill still leaves the rest collectable', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Stourbridge Rollers');
      const { invoice } = await ws.bill(customer.id);
      const debit: PaymentMethod = await ws.ok('POST', '/v1/payment_methods', {
        type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank',
        account_type: 'checking', simulated_behavior: 'succeeds',
      });
      const deposit: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: debit.id,
        amount: 10_000, confirm: true, off_session: true,
      });
      assert.equal(deposit.status, 'processing');

      const rest = await ws.ok('POST', `/v1/invoices/${invoice.id}/retry`, {});
      assert.equal(
        rest.payment_intent.amount, invoice.total - 10_000,
        'the second instruction is for what is not already with the bank, not for the whole bill again',
      );

      assert.equal((await ws.travel(5 * DAY)).failed, 0);
      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.cash_collected, invoice.total, 'the two instructions add up to the bill exactly');
      assert.equal(view.amount_paid, invoice.total);
      assert.equal(view.amount_overpaid, 0);
      await assertReconciled(ws, customer.id, 'after two part debits settled');
    } finally { ws.close(); }
  });

  test('an idempotency key never answers with another customer’s payment', async () => {
    const ws = await workspace();
    try {
      const first = await ws.customer('Newark Spindles');
      const second = await ws.customer('Oakham Couplings');
      const firstCard = await ws.card(first.id, 'succeeds');
      const secondCard = await ws.card(second.id, 'succeeds');

      const paid: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: first.id, amount: 12_500, currency: 'usd', payment_method: firstCard.id,
        confirm: true, off_session: true, idempotency_key: 'nightly-sweep-0007',
      });
      assert.equal(paid.status, 'succeeded');

      const clash = await ws.fail('POST', '/v1/payment_intents', {
        customer: second.id, amount: 99_900, currency: 'usd', payment_method: secondCard.id,
        confirm: true, off_session: true, idempotency_key: 'nightly-sweep-0007',
      }, 409, 'idempotency_key_in_use');
      assert.match(clash.message, /already used for a different payment/);

      assert.equal(
        (await ws.ok('GET', `/v1/charges?customer=${second.id}&status=all`)).data.length, 0,
        'the second customer was charged nothing, and was not told otherwise',
      );
      assert.equal(
        (await ws.ok('GET', `/v1/payment_intents?customer=${second.id}&status=all`)).data.length, 0,
        'and no intent of theirs was invented to hold the answer',
      );

      // The same request under the same key is still one payment, not two.
      const replay: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: first.id, amount: 12_500, currency: 'usd', payment_method: firstCard.id,
        confirm: true, off_session: true, idempotency_key: 'nightly-sweep-0007',
      });
      assert.equal(replay.id, paid.id, 'a genuine replay still returns the first intent');
      assert.equal(
        (await ws.ok('GET', `/v1/charges?customer=${first.id}&status=all`)).data.length, 1,
        'and the customer sees one line on their statement',
      );
      await assertReconciled(ws, first.id, 'after a replayed create');
    } finally { ws.close(); }
  });

  test('the same key for the same customer but a different amount is refused, not silently repriced', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Wigston Hydraulics');
      const card = await ws.card(customer.id, 'succeeds');
      const small: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, amount: 5_000, currency: 'usd', payment_method: card.id,
        confirm: true, off_session: true, idempotency_key: 'deposit-2026-06',
      });
      assert.equal(small.amount, 5_000);

      const clash = await ws.fail('POST', '/v1/payment_intents', {
        customer: customer.id, amount: 250_000, currency: 'usd', payment_method: card.id,
        confirm: true, off_session: true, idempotency_key: 'deposit-2026-06',
      }, 409, 'idempotency_key_in_use');
      assert.equal(clash.detail.payment_intent, small.id);

      const charges = (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all`)).data as Charge[];
      assert.equal(charges.length, 1);
      assert.equal(charges[0].amount, 5_000, '$2,500.00 was never reported as collected');
    } finally { ws.close(); }
  });
});


/* ========================================================================== *
 * 2c-ii. The bill can shrink under the money as well as after it
 *
 * `applyCollection` handles one order: a debit settles days after a credit note
 * landed, the room in the bill has gone, and the difference goes to the
 * customer's account. This section is the other order, which is the same event
 * and the same shortfall: the cash is already on the bill when the credit note
 * arrives.
 *
 * Billing routes a note to the customer's balance only when the invoice is
 * `paid` — reading "has the money arrived" as "has *all* of it arrived" — so a
 * part-paid bill takes the whole note off what it was billed. Left alone that
 * leaves `amount_paid` bigger than the bill can ever be owed and `amount_due`
 * *negative*: the customer's cash on a document that is no longer owed it, and
 * on nobody's account.
 *
 * The identity these tests do not rely on alone is the reason this section
 * exists: net cash in still equals `amount_paid` + credit in that state,
 * because the cash really is on the bill. What it is not is money anyone can
 * reach.
 * ========================================================================== */

describe('a bill that shrinks under money already on it', () => {
  /** $400.00 of a $499.00 bill collected by card, nothing credited yet. */
  async function partPaid(ws: Workspace, name: string): Promise<{ customer: any; invoice: Invoice; charge: Charge }> {
    const customer = await ws.customer(name);
    const { invoice } = await ws.bill(customer.id);
    assert.equal(invoice.total, 49_900, 'the growth plan is $499.00 a month');
    const card = await ws.card(customer.id, 'succeeds');
    const paid: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
      customer: customer.id, invoice: invoice.id, payment_method: card.id,
      amount: 40_000, confirm: true, off_session: true,
    });
    assert.equal(paid.status, 'succeeded');
    const part = await ws.invoice(invoice.id);
    assert.equal(part.status, 'open');
    assert.equal(part.amount_paid, 40_000);
    assert.equal(part.amount_due, 9_900, '$99.00 of the bill is still owed');
    await assertReconciled(ws, customer.id, 'after a part payment');
    return { customer, invoice: part, charge: await ws.ok('GET', `/v1/charges/${paid.latest_charge}`) };
  }

  test('crediting the whole of a part-paid bill hands the cash back as credit, not as a negative balance', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice } = await partPaid(ws, 'Bewdley Castings');

      // The whole bill is credited — an order cancelled after a deposit was
      // taken. $400.00 of it is money that has already arrived.
      await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 49_900, reason: 'order_change' });

      const after = await ws.invoice(invoice.id);
      assert.equal(after.pre_payment_credit_notes_amount, 49_900);
      assert.equal(
        after.amount_due, 0,
        'a bill credited to nothing is owed nothing — never minus the deposit that was taken against it',
      );
      assert.equal(after.amount_paid, 0, 'the bill charges nothing now, so it holds none of the cash');
      assert.equal(after.status, 'paid', 'and it is settled: there is nothing left on it to collect');

      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.cash_collected, 40_000, 'the card was still charged $400.00');
      assert.equal(view.amount_overpaid, 40_000, 'and all of it is the customer’s, on their account');
      assert.equal(netCashIn(view), 40_000);
      assert.equal(
        (await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, -40_000,
        'the customer holds the deposit they paid on an order that was cancelled',
      );
      await assertReconciled(ws, customer.id, 'after crediting a part-paid bill in full');

      const ledger = (await ws.ok('GET', `/v1/customers/${customer.id}/balance_transactions?limit=50`)).data as any[];
      const row = ledger.find((entry) => entry.type === 'invoice_overpayment');
      assert.ok(row, 'the credit is a ledger row of its own, so the account reads as one story');
      assert.equal(row.amount, -40_000);
      assert.equal(row.invoice, invoice.id);
      assert.match(row.description, /credited/);

      const events = await ws.ok('GET', '/v1/events?type=invoice.overpaid&limit=20');
      const overpaid = (events.data as any[]).find((e) => e.data?.invoice === invoice.id);
      assert.ok(overpaid, 'money moving onto the account is on the event stream, not silent');
      assert.equal(overpaid.data.amount_overpaid, 40_000);
    } finally { ws.close(); }
  });

  test('crediting past the balance but not the whole bill moves only what the bill can no longer hold', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice } = await partPaid(ws, 'Ludlow Gearing');

      // $200.00 credited against a bill that is owed $99.00: $99.00 of it comes
      // off what is still due and the remaining $101.00 is cash already taken.
      await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 20_000, reason: 'order_change' });

      const after = await ws.invoice(invoice.id);
      assert.equal(after.amount_paid, 29_900, 'the bill charges $299.00 now, and holds exactly that');
      assert.equal(after.amount_due, 0);
      assert.equal(after.status, 'paid');
      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.amount_overpaid, 10_100, 'and $101.00 — no more — went to the account');
      assert.equal(netCashIn(view), 40_000);
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, -10_100);
      await assertReconciled(ws, customer.id, 'after crediting past the balance of a part-paid bill');
    } finally { ws.close(); }
  });

  test('a credit note that only reaches the balance leaves the cash where it is', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice } = await partPaid(ws, 'Kidderminster Weave');

      // Exactly the $99.00 still owed. Nothing has been collected past the new
      // balance, so nothing moves to the account.
      await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 9_900, reason: 'order_change' });

      const after = await ws.invoice(invoice.id);
      assert.equal(after.amount_paid, 40_000, 'the bill still holds the $400.00 it was paid');
      assert.equal(after.amount_due, 0);
      assert.equal(after.status, 'paid');
      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.amount_overpaid, 0, 'and the account is handed nothing it is not owed');
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, 0);
      await assertReconciled(ws, customer.id, 'after crediting exactly the balance');
    } finally { ws.close(); }
  });

  test('the cash and the credit note arriving in either order leave the same account', async () => {
    // The whole point: these are one event in two orders, and a customer's
    // position cannot depend on which of them the clock happened to put first.
    const cashFirst = await workspace();
    const creditFirst = await workspace();
    try {
      const { customer: a, invoice: firstBill } = await partPaid(cashFirst, 'Order Alpha');
      await cashFirst.ok('POST', '/v1/credit_notes', { invoice: firstBill.id, amount: 20_000, reason: 'order_change' });

      // The mirror: the note lands while the debit is still with the bank, so
      // the money arrives against a bill that has already shrunk.
      const b = await creditFirst.customer('Order Beta');
      const { invoice: secondBill } = await creditFirst.bill(b.id);
      const debit: PaymentMethod = await creditFirst.ok('POST', '/v1/payment_methods', {
        type: 'bank_debit', customer: b.id, bank_name: 'Midland Union Bank',
        account_type: 'checking', simulated_behavior: 'succeeds',
      });
      await creditFirst.ok('POST', '/v1/payment_intents', {
        customer: b.id, invoice: secondBill.id, payment_method: debit.id,
        amount: 40_000, confirm: true, off_session: true,
      });
      await creditFirst.ok('POST', '/v1/credit_notes', { invoice: secondBill.id, amount: 20_000, reason: 'order_change' });
      assert.equal((await creditFirst.travel(5 * DAY)).failed, 0);

      const shape = async (ws: Workspace, customerId: string, invoiceId: string) => {
        const invoice = await ws.invoice(invoiceId);
        const view = await ws.ok('GET', `/v1/invoices/${invoiceId}/payments`);
        return {
          status: invoice.status,
          amount_paid: invoice.amount_paid,
          amount_due: invoice.amount_due,
          amount_overpaid: view.amount_overpaid,
          cash_collected: view.cash_collected,
          balance: (await ws.ok('GET', `/v1/customers/${customerId}`)).balance,
        };
      };
      const before = await shape(cashFirst, a.id, firstBill.id);
      const later = await shape(creditFirst, b.id, secondBill.id);
      assert.deepEqual(
        before, later,
        'a $200.00 credit note against a $499.00 bill with $400.00 collected leaves one position, whichever arrived first',
      );
      assert.deepEqual(before, {
        status: 'paid', amount_paid: 29_900, amount_due: 0,
        amount_overpaid: 10_100, cash_collected: 40_000, balance: -10_100,
      });
      await assertReconciled(cashFirst, a.id, 'cash before the credit note');
      await assertReconciled(creditFirst, b.id, 'credit note before the cash');
    } finally { cashFirst.close(); creditFirst.close(); }
  });

  test('the cash a credit note displaced can be refunded once, and the bill is not billed again', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice, charge } = await partPaid(ws, 'Wolverley Tooling');
      await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 49_900, reason: 'order_change' });

      // The customer wants the deposit back rather than the credit — the
      // module's documented remedy, run against the charge that took it.
      const refund: Refund = await ws.ok('POST', '/v1/refunds', {
        charge: charge.id, amount: 40_000, reason: 'requested_by_customer',
      });
      assert.equal(refund.amount, 40_000);

      const after = await ws.invoice(invoice.id);
      assert.equal(after.status, 'paid', 'a bill credited to nothing is not owed again by the refund of a deposit');
      assert.equal(after.amount_due, 0, 'the customer is not shown owing a bill that charges nothing');
      assert.equal(after.amount_paid, 0);
      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.amount_refunded, 40_000);
      assert.equal(view.amount_overpaid, 0, 'the credit went back with the cash that made it');
      assert.equal(netCashIn(view), 0, '$400.00 taken, $400.00 returned');
      assert.equal(
        (await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, 0,
        'the customer was paid back once — not paid back and left holding the credit as well',
      );
      await assertReconciled(ws, customer.id, 'after refunding cash a credit note displaced');

      await ws.fail('POST', '/v1/refunds', { charge: charge.id, amount: 1 }, 400, 'refund_exceeds_charge');
    } finally { ws.close(); }
  });

  test('a chargeback over cash a credit note displaced takes the credit, not the settled bill', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice, charge } = await partPaid(ws, 'Stourport Anodising');
      await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 49_900, reason: 'order_change' });

      const dispute: Dispute = await ws.ok('POST', '/v1/disputes', { charge: charge.id, reason: 'fraudulent' });
      assert.equal(dispute.amount, 40_000);

      const held = await ws.invoice(invoice.id);
      assert.equal(held.status, 'paid', 'the bill charges nothing and stays settled — the network took the credit');
      assert.equal(held.amount_due, 0);
      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.amount_overpaid, 0);
      assert.equal(netCashIn(view), 0);
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, 0);
      await assertReconciled(ws, customer.id, 'while a chargeback over displaced cash is open');

      await ws.ok('POST', `/v1/disputes/${dispute.id}/evidence`, {
        product_description: 'Deposit taken against a telemetry rollout the customer cancelled; credited in full the same week.',
      });
      await ws.ok('POST', `/v1/disputes/${dispute.id}/close`, { status: 'won' });

      const back = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(back.amount_overpaid, 40_000, 'winning it puts the credit back on the account, to the penny');
      assert.equal((await ws.invoice(invoice.id)).amount_paid, 0, 'and never onto a bill that charges nothing');
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, -40_000);
      await assertReconciled(ws, customer.id, 'after winning a chargeback over displaced cash');
    } finally { ws.close(); }
  });

  test('a bill withdrawn after a credit note keeps the cash reachable rather than moving it twice', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice, charge } = await partPaid(ws, 'Cleobury Bearings');
      await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 20_000, reason: 'order_change' });
      const credited = await ws.invoice(invoice.id);
      assert.equal(credited.amount_paid, 29_900);
      assert.equal(credited.status, 'paid');

      // A settled bill cannot be withdrawn, so the money stays reachable
      // through the charge that took it. That is the point: the fix must not
      // strand the cash somewhere neither a refund nor a chargeback can go.
      await ws.fail('POST', `/v1/invoices/${invoice.id}/void`, {}, 409, 'invoice_paid');

      await ws.ok('POST', '/v1/refunds', { charge: charge.id, reason: 'requested_by_customer' });
      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.amount_refunded, 40_000, 'every unit that was taken can still be given back');
      assert.equal(netCashIn(view), 0);
      assert.equal(view.amount_overpaid, 0);
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, 0);
      const after = await ws.invoice(invoice.id);
      assert.equal(after.amount_paid, 0);
      assert.equal(after.amount_due, 29_900, 'and what the bill still charges is owed again');
      assert.equal(after.status, 'open');
      await assertReconciled(ws, customer.id, 'after refunding everything off a credited part-paid bill');
    } finally { ws.close(); }
  });

  /* ------------------------------------------------------------------ *
   * And the undo. A credit note can be withdrawn, and billing puts it back
   * as the note *recorded* itself — the whole amount onto `amount_due`,
   * because a note raised against a part-paid bill records the whole of
   * itself as pre-payment. The slice payments had carried onto the account
   * is not billing's to put back, so if nothing here does it the bill is
   * owed the full amount again with nothing recorded as collected, and the
   * customer's own money sits as credit against that same invoice for the
   * next presentation to take a second time.
   * ------------------------------------------------------------------ */

  test('withdrawing the note that displaced the cash puts it back on the bill, not onto a second charge', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice } = await partPaid(ws, 'Highley Castings');
      const note = await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 49_900, reason: 'order_change' });
      assert.equal((await ws.invoice(invoice.id)).amount_paid, 0, 'the deposit moved to the account');
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, -40_000);

      // The note should not have been written — the order was not cancelled.
      await ws.ok('POST', `/v1/credit_notes/${note.id}/void`, {});

      const back = await ws.invoice(invoice.id);
      assert.equal(back.status, 'open', 'the bill is owed again');
      assert.equal(
        back.amount_paid, 40_000,
        'and it records the $400.00 that was collected against it — the deposit did not stop being a deposit when the note was withdrawn',
      );
      assert.equal(back.amount_due, 9_900, 'so what is owed is the $99.00 that was owed before the note, not the whole $499.00');
      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.amount_overpaid, 0, 'nothing is left filed as credit against a bill that can hold it');
      assert.equal(netCashIn(view), 40_000);
      assert.equal(
        (await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, 0,
        'the account holds nothing: the cash is on the bill it was paid against',
      );
      await assertReconciled(ws, customer.id, 'after withdrawing a note that had displaced a part payment');

      // The whole point, in the only terms that matter: what the next
      // presentation takes off the customer's card.
      await ws.ok('POST', `/v1/invoices/${invoice.id}/retry`, {});
      const settled = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(
        settled.cash_collected, 49_900,
        '$499.00 in total was ever taken from the card — not $899.00, which is what presenting the whole bill again over a $400.00 credit would have collected',
      );
      assert.equal((await ws.invoice(invoice.id)).status, 'paid');
      assert.equal(settled.amount_overpaid, 0);
      await assertReconciled(ws, customer.id, 'after settling the balance a withdrawn note left');
    } finally { ws.close(); }
  });

  test('withdrawing a note that reached only part-way into the cash puts back exactly that part', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice } = await partPaid(ws, 'Alveley Pressings');
      // $200.00 against a bill owed $99.00: $101.00 of it displaced cash.
      const note = await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 20_000, reason: 'order_change' });
      assert.equal((await ws.invoice(invoice.id)).amount_paid, 29_900);
      assert.equal((await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`)).amount_overpaid, 10_100);

      await ws.ok('POST', `/v1/credit_notes/${note.id}/void`, {});

      const back = await ws.invoice(invoice.id);
      assert.deepEqual(
        { status: back.status, amount_paid: back.amount_paid, amount_due: back.amount_due, pre: back.pre_payment_credit_notes_amount },
        { status: 'open', amount_paid: 40_000, amount_due: 9_900, pre: 0 },
        'the withdrawal leaves exactly the position the note found — no more and no less',
      );
      assert.equal((await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`)).amount_overpaid, 0);
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, 0);
      await assertReconciled(ws, customer.id, 'after withdrawing a note that reached part-way into the cash');
    } finally { ws.close(); }
  });

  test('credit the bill genuinely cannot absorb survives the withdrawal of a later note', async () => {
    const ws = await workspace();
    try {
      // $499.00 taken by a debit against a bill credited to $199.00 while it
      // flew: $300.00 of it is credit the bill can never hold, because it can
      // never be owed more than the $199.00 it now charges.
      const { customer, invoice } = await overpaidByCreditNote(ws, 'Quatt Hydraulics');
      assert.equal((await ws.invoice(invoice.id)).amount_paid, 19_900);
      assert.equal((await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`)).amount_overpaid, 30_000);

      // A second note, on a bill that is now paid: it goes to the balance and
      // takes nothing off `amount_paid`, so withdrawing it must put nothing
      // back onto it — and must leave the $300.00 that was already there.
      const later = await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 10_000, reason: 'order_change' });
      assert.equal(later.post_payment_amount, 10_000, 'a paid bill takes a note on the balance');
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, -40_000);

      await ws.ok('POST', `/v1/credit_notes/${later.id}/void`, {});

      const back = await ws.invoice(invoice.id);
      assert.equal(back.amount_paid, 19_900, 'the bill still holds exactly what it could be owed');
      assert.equal(back.status, 'paid');
      assert.equal(back.amount_due, 0);
      assert.equal(
        (await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`)).amount_overpaid, 30_000,
        'and the $300.00 the bill can never absorb is still the customer’s, untouched by a withdrawal that never displaced it',
      );
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, -30_000);
      await assertReconciled(ws, customer.id, 'after withdrawing a note off a bill holding credit it cannot absorb');
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 2c-ii. A bill somebody gave up on
 *
 * `pay()` is billing's word for "settled", and this module says it through
 * `applyCollection`. A written-off bill is a decision a person made, so what
 * that word may be said over is not a detail: `settleCreditedExcess` states the
 * rule on the way out — "a bill written off stays written off" — and the two
 * paths that put money *back* on a bill have to keep it, because neither of
 * them is a collection. A chargeback we win back and the cash a withdrawn
 * credit note puts back were both sitting on that bill before anyone gave up on
 * it; returning them cannot be what collects it.
 *
 * The identity cannot see any of this — every figure below balances either way,
 * because the cash never moves off the account. What moves is the bill's
 * status, `invoice.paid` goes out over a bad debt, and billing turns that into
 * a subscription put back into service on money nobody paid.
 *
 * And the mirror-image mistake this must not become is the last test: money
 * that genuinely *arrives* on a written-off bill — a debit already with the
 * bank when finance gave up — was collected after all, and still settles it.
 * ========================================================================== */

describe('a bill somebody gave up on', () => {
  /**
   * $400.00 collected, the $99.00 balance written off, and then credited away
   * so the write-off is tidy: `uncollectible`, nothing owed, $400.00 on it.
   */
  async function writtenOff(ws: Workspace, name: string): Promise<{ customer: any; invoice: Invoice; charge: Charge }> {
    const customer = await ws.customer(name);
    const { invoice } = await ws.bill(customer.id);
    const card = await ws.card(customer.id, 'succeeds');
    const paid: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
      customer: customer.id, invoice: invoice.id, payment_method: card.id,
      amount: 40_000, confirm: true, off_session: true,
    });
    await ws.ok('POST', `/v1/invoices/${invoice.id}/mark_uncollectible`, {});
    await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 9_900, reason: 'order_change' });
    const off = await ws.invoice(invoice.id);
    assert.deepEqual(
      { status: off.status, amount_paid: off.amount_paid, amount_due: off.amount_due },
      { status: 'uncollectible', amount_paid: 40_000, amount_due: 0 },
      'the deposit stays on the bill, the $99.00 nobody is going to pay is credited away, and the bill is written off',
    );
    await assertReconciled(ws, customer.id, 'after writing off the balance of a part-paid bill');
    return { customer, invoice: off, charge: await ws.ok('GET', `/v1/charges/${paid.latest_charge}`) };
  }

  test('withdrawing a note off a written-off bill leaves the write-off where it found it', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice } = await writtenOff(ws, 'Wroxeter Tooling');

      // A second note, raised against the wrong bill: $200.00 of the deposit is
      // more than what is left owed, so payments carries it onto the account.
      const wrong = await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 20_000, reason: 'order_change' });
      assert.equal((await ws.invoice(invoice.id)).amount_paid, 20_000);
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, -20_000);
      assert.equal((await ws.invoice(invoice.id)).status, 'uncollectible', 'crediting a written-off bill does not un-write it off');

      await ws.ok('POST', `/v1/credit_notes/${wrong.id}/void`, {});

      const back = await ws.invoice(invoice.id);
      assert.deepEqual(
        {
          status: back.status, amount_paid: back.amount_paid, amount_due: back.amount_due,
          pre: back.pre_payment_credit_notes_amount,
        },
        { status: 'uncollectible', amount_paid: 40_000, amount_due: 0, pre: 9_900 },
        'exactly the position the note found — including the write-off, which withdrawing a note nobody paid cannot undo',
      );
      assert.equal((await ws.ok('GET', `/v1/customers/${customer.id}`)).balance, 0);
      await assertReconciled(ws, customer.id, 'after withdrawing a note off a written-off bill');
    } finally { ws.close(); }
  });

  test('a written-off bill does not settle itself and put the subscription back into service', async () => {
    const ws = await workspace();
    try {
      // The card on file is refused, so the bill goes past due and the recovery
      // schedule runs out: billing marks the subscription unpaid.
      const customer = await ws.customer('Ludlow Conveyors');
      await ws.card(customer.id, 'card_declined');
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: customer.id, items: [{ price: 'growth_monthly' }],
      });
      await ws.tick();
      const invoice = (await ws.invoicesFor(sub.id))[0];
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'past_due');

      // $400.00 arrives on a card that works, and finance writes the rest off.
      const good = await ws.card(customer.id, 'succeeds', { brand: 'mastercard' });
      await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: good.id,
        amount: 40_000, confirm: true, off_session: true,
      });
      await ws.ok('POST', `/v1/invoices/${invoice.id}/mark_uncollectible`, {});
      assert.equal(
        (await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'unpaid',
        'writing the bill off stops the account being collected',
      );
      await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 9_900, reason: 'order_change' });

      const wrong = await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: 20_000, reason: 'order_change' });
      await ws.ok('POST', `/v1/credit_notes/${wrong.id}/void`, {});

      assert.equal(
        (await ws.invoice(invoice.id)).status, 'uncollectible',
        'the bad debt is still a bad debt: nothing was collected, a note was withdrawn',
      );
      assert.equal(
        (await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'unpaid',
        'so the account stays out of service — an invoice.paid over a written-off bill revives it on money nobody paid',
      );
      await assertReconciled(ws, customer.id, 'after withdrawing a note off a written-off bill of an unpaid account');
    } finally { ws.close(); }
  });

  test('a chargeback won back onto a written-off bill does not settle it either', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice, charge } = await writtenOff(ws, 'Kinlet Gearing');

      // The network takes the deposit while the case is argued. The bill is
      // written off and owed $400.00 again — and it stays written off.
      const dispute: Dispute = await ws.ok('POST', '/v1/disputes', { charge: charge.id, reason: 'fraudulent' });
      const held = await ws.invoice(invoice.id);
      assert.deepEqual(
        { status: held.status, amount_paid: held.amount_paid, amount_due: held.amount_due },
        { status: 'uncollectible', amount_paid: 0, amount_due: 40_000 },
      );
      await assertReconciled(ws, customer.id, 'while the network holds the deposit');

      await ws.ok('POST', `/v1/disputes/${dispute.id}/close`, { status: 'won' });

      const won = await ws.invoice(invoice.id);
      assert.deepEqual(
        { status: won.status, amount_paid: won.amount_paid, amount_due: won.amount_due },
        { status: 'uncollectible', amount_paid: 40_000, amount_due: 0 },
        'the money that came back is the money the bill was already holding when it was written off, so winning it back is not collecting it',
      );
      await assertReconciled(ws, customer.id, 'after winning back a chargeback on a written-off bill');
    } finally { ws.close(); }
  });

  test('a debit that clears after the write-off did collect the bill, and settles it', async () => {
    const ws = await workspace();
    try {
      // The mirror-image mistake this must not become. Everything above is
      // about money going back where it already was; this is money genuinely
      // arriving on a bill finance had given up on, and it was collected after
      // all. Refusing to settle here would leave a bill the bank has paid in
      // full sitting for ever as a bad debt.
      const customer = await ws.customer('Bewdley Drives');
      const { invoice } = await ws.bill(customer.id);
      const debit: PaymentMethod = await ws.ok('POST', '/v1/payment_methods', {
        type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank',
        account_type: 'checking', simulated_behavior: 'succeeds',
      });
      const presented: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: debit.id, confirm: true, off_session: true,
      });
      assert.equal(presented.status, 'processing');
      await ws.ok('POST', `/v1/invoices/${invoice.id}/mark_uncollectible`, {});

      assert.equal((await ws.travel(5 * DAY)).failed, 0);

      const settled = await ws.invoice(invoice.id);
      assert.deepEqual(
        { status: settled.status, amount_paid: settled.amount_paid, amount_due: settled.amount_due },
        { status: 'paid', amount_paid: 49_900, amount_due: 0 },
        'the bank paid it in full after the write-off, so it is paid — a write-off is not a state money cannot reach',
      );
      await assertReconciled(ws, customer.id, 'after a debit cleared onto a written-off bill');
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 2d. The identity, over sequences nobody wrote down
 *
 * The tests above each pin one path. This one generates them: random walks
 * through collect, overpay, refund, dispute and settlement, asserting after
 * every single step that the cash the customer's account is out of pocket for
 * equals what the bills say they collected plus what the account holds as
 * credit. The walk is seeded, so a failure names the exact sequence to replay.
 * ========================================================================== */

/** Deterministic 32-bit LCG. A property test that cannot be replayed is a flake. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('the reconciliation identity holds over random sequences', () => {
  // `present_debit` is weighted, and it is the reason this walk is worth
  // running: only a debit sitting with the bank lets a credit note land between
  // the presentation and the settlement, which is the one way a bill ends up
  // holding cash it was never owed. Every interesting reversal starts there.
  const OPERATIONS = [
    'present', 'present_debit', 'present_debit', 'pay_card', 'credit_note',
    'settle', 'settle', 'refund', 'dispute', 'close_dispute',
    // The half the shipped walk never reached. A note can be withdrawn, and
    // withdrawing one that displaced cash is the one move that grows a bill
    // back over money this module had already carried onto the account — the
    // state in which presenting the bill again collects it a second time.
    'withdraw_note',
  ] as const;

  // Seeds chosen because each walk reaches every state that matters — a bill
  // holding overpayment credit, money leaving it that is larger than the bill
  // itself recorded collecting, a credit note reaching past the balance into
  // cash that had already arrived, and the note that did it being withdrawn
  // again afterwards. The five assertions at the end of the walk enforce that,
  // so a seed that stops covering a case fails loudly instead of passing
  // quietly — which is exactly what two of them did when the stop on this
  // account was added below, and why they were re-picked rather than the
  // assertions relaxed.
  for (const seed of [0x5eed_007f, 0x5eed_00b1, 0x5eed_00f7, 0x5eed_0115, 0x5eed_011a, 0x5eed_0132]) {
    test(`seed ${seed.toString(16)}: collect / overpay / refund / dispute in any order still reconciles`, async () => {
      const ws = await workspace();
      const log: string[] = [];
      try {
        const random = rng(seed);
        const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length) % items.length];

        const customer = await ws.customer('Property Machining');
        const { sub, invoice } = await ws.bill(customer.id);
        // Automatic collection is stopped on this account, so the only thing
        // that moves money here is the walk itself. Without it the bill is
        // presented the moment a method is attached — which is correct, and is
        // the whole point of the handler above — and every walk then starts
        // from a bill that is already settled, which is the one state none of
        // the cases below can be reached from. A human retry overrides the
        // stop, so `present` still exercises the collection path.
        await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, { behavior: 'keep_as_draft' });
        const card = await ws.card(customer.id, 'succeeds');
        const debit: PaymentMethod = await ws.ok('POST', '/v1/payment_methods', {
          type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank',
          account_type: 'checking', simulated_behavior: 'succeeds', set_default: true,
        });
        await assertReconciled(ws, customer.id, `seed ${seed}: before anything happened`);

        // A walk that never reaches a bill holding credit, and never takes money
        // back out of one, would pass this test without touching the code it
        // exists to hold. Both are asserted at the end.
        let sawCredit = false;
        let sawReversalAgainstCredit = false;
        let sawReversalBeyondBill = false;
        let sawCreditPastTheCash = false;
        let sawNoteWithdrawn = false;
        const creditOnBill = async (): Promise<number> =>
          (await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`)).amount_overpaid as number;

        /** Attempt an operation; a 4xx is a legitimate refusal and proves nothing moved. */
        const attempt = async (method: string, path: string, body?: unknown): Promise<any | null> => {
          const res = await ws.call(method, path, body);
          if (res.status >= 500) assert.fail(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
          return res.status < 400 ? res.body : null;
        };
        // Ordered by what the rows *are*, never by the order they came back in:
        // ids are random, several charges share a frozen `created`, and a walk
        // that picks by list position would take a different path on every run.
        // Two charges alike on all four fields are interchangeable to this walk.
        const byContent = (a: Charge, b: Charge): number =>
          a.created - b.created || a.amount - b.amount || a.amount_refunded - b.amount_refunded
          || a.amount_disputed - b.amount_disputed;
        const succeededCharges = async (): Promise<Charge[]> => {
          const page = await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=succeeded&limit=100`);
          return (page.data as Charge[])
            .filter((c) => c.amount - c.amount_refunded - c.amount_disputed > 0)
            .sort(byContent);
        };

        for (let step = 0; step < 48; step++) {
          const op = pick(OPERATIONS);
          const bill = await ws.invoice(invoice.id);
          switch (op) {
            case 'present': {
              log.push(`${step}: retry ${invoice.id}`);
              await attempt('POST', `/v1/invoices/${invoice.id}/retry`, {});
              break;
            }
            case 'present_debit': {
              if (bill.amount_due <= 0) { log.push(`${step}: debit (nothing owed)`); break; }
              const amount = Math.max(1, Math.ceil(bill.amount_due * (0.4 + random() * 0.6)));
              log.push(`${step}: debit ${amount} of ${bill.amount_due}`);
              await attempt('POST', '/v1/payment_intents', {
                customer: customer.id, invoice: invoice.id, payment_method: debit.id,
                amount, confirm: true, off_session: true,
              });
              break;
            }
            case 'pay_card': {
              if (bill.amount_due <= 0) { log.push(`${step}: card (nothing owed)`); break; }
              const amount = Math.max(1, Math.ceil(bill.amount_due * (0.1 + random() * 0.5)));
              log.push(`${step}: card ${amount} of ${bill.amount_due}`);
              await attempt('POST', '/v1/payment_intents', {
                customer: customer.id, invoice: invoice.id, payment_method: card.id,
                amount, confirm: true, off_session: true,
              });
              break;
            }
            case 'credit_note': {
              const amount = Math.max(1, Math.ceil(invoice.total * (0.05 + random() * 0.5)));
              log.push(`${step}: credit_note ${amount} (${bill.amount_paid} on the bill, ${bill.amount_due} owed)`);
              const written = await attempt('POST', '/v1/credit_notes', { invoice: invoice.id, amount, reason: 'order_change' });
              // The bill shrinking under money already on it: the note reaches
              // past what is still owed and into cash that has already arrived.
              if (written && bill.status !== 'paid' && bill.amount_paid > 0 && amount > bill.amount_due) sawCreditPastTheCash = true;
              break;
            }
            case 'withdraw_note': {
              // Ordered by what the notes *are*, for the same reason the charges
              // are: ids are random and several notes share a frozen `created`.
              const issued = ((await ws.ok('GET', `/v1/credit_notes?invoice=${invoice.id}&status=issued&limit=50`))
                .data as CreditNote[])
                .slice()
                .sort((a, b) => a.created - b.created || a.total - b.total || a.pre_payment_amount - b.pre_payment_amount);
              if (!issued.length) { log.push(`${step}: withdraw (no note to withdraw)`); break; }
              const note = pick(issued);
              const credit = await creditOnBill();
              log.push(`${step}: withdraw ${note.number} ${note.total} (pre ${note.pre_payment_amount}, ${credit} credit, ${bill.amount_paid} on the bill)`);
              const done = await attempt('POST', `/v1/credit_notes/${note.id}/void`, {});
              // Only a pre-payment note over a bill that is holding a customer's
              // cash as credit grows the bill back over that cash. Anything else
              // is a withdrawal this half was never in danger of getting wrong.
              if (done && credit > 0 && note.pre_payment_amount > 0) sawNoteWithdrawn = true;
              break;
            }
            case 'settle': {
              log.push(`${step}: travel 4d`);
              const travelled = await ws.travel(4 * DAY);
              assert.equal(travelled.failed, 0, `seed ${seed}: a queued job failed\n${log.join('\n')}`);
              break;
            }
            case 'refund': {
              const charges = await succeededCharges();
              if (!charges.length) { log.push(`${step}: refund (nothing to refund)`); break; }
              const charge = pick(charges);
              const room = charge.amount - charge.amount_refunded - charge.amount_disputed;
              const amount = 1 + Math.floor(random() * room);
              const credit = await creditOnBill();
              log.push(`${step}: refund ${charge.id} ${amount} of ${room} (${credit} credit, ${bill.amount_paid} on the bill)`);
              const done = await attempt('POST', '/v1/refunds', { charge: charge.id, amount, reason: 'requested_by_customer' });
              if (done && credit > 0) sawReversalAgainstCredit = true;
              if (done && credit > 0 && amount > bill.amount_paid) sawReversalBeyondBill = true;
              break;
            }
            case 'dispute': {
              const charges = await succeededCharges();
              if (!charges.length) { log.push(`${step}: dispute (nothing to dispute)`); break; }
              const charge = pick(charges);
              const room = charge.amount - charge.amount_refunded - charge.amount_disputed;
              const amount = 1 + Math.floor(random() * room);
              const credit = await creditOnBill();
              log.push(`${step}: dispute ${charge.id} ${amount} of ${room} (${credit} credit, ${bill.amount_paid} on the bill)`);
              const done = await attempt('POST', '/v1/disputes', { charge: charge.id, amount, reason: 'fraudulent' });
              if (done && credit > 0) sawReversalAgainstCredit = true;
              if (done && credit > 0 && amount > bill.amount_paid) sawReversalBeyondBill = true;
              break;
            }
            case 'close_dispute': {
              const page = await ws.ok('GET', `/v1/disputes?customer=${customer.id}&status=all&limit=50`);
              const open = (page.data as Dispute[])
                .filter((d) => d.status === 'needs_response' || d.status === 'under_review')
                .sort((a, b) => a.created - b.created || a.amount - b.amount);
              if (!open.length) { log.push(`${step}: close (nothing open)`); break; }
              const dispute = pick(open);
              const won = random() < 0.5;
              log.push(`${step}: close ${dispute.id} ${won ? 'won' : 'lost'}`);
              await attempt('POST', `/v1/disputes/${dispute.id}/close`, { status: won ? 'won' : 'lost' });
              break;
            }
          }
          const held = await assertReconciled(ws, customer.id, `seed ${seed}, step ${step} (${op})\n${log.join('\n')}`);
          if (held > 0) sawCredit = true;
        }

        assert.ok(
          (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length > 0,
          `seed ${seed}: the walk never presented anything, so it proved nothing\n${log.join('\n')}`,
        );
        assert.ok(sawCredit, `seed ${seed}: the walk never overpaid a bill, so it never tested the case\n${log.join('\n')}`);
        assert.ok(
          sawReversalAgainstCredit,
          `seed ${seed}: the walk never took money back off a bill holding credit, which is the case that pays a customer twice\n${log.join('\n')}`,
        );
        // The boundary this whole section exists for: money leaving that is
        // larger than the bill itself ever recorded collecting. Everything
        // smaller comes off `amount_paid` and reconciles whether or not the
        // credit is settled first, so a walk that never crosses the boundary
        // would hold the identity without ever testing it.
        assert.ok(
          sawReversalBeyondBill,
          `seed ${seed}: the walk never reversed more than the bill recorded as collected, so the split between bill and credit was never load-bearing\n${log.join('\n')}`,
        );
        // The other order, and the one the identity alone cannot see: a credit
        // note reaching past the balance into cash that has already arrived. It
        // leaves `net cash in === amount_paid + credit` true and the bill
        // holding money it can never be owed, so a walk that never gets there
        // never tests the half of `assertReconciled` that checks what the bill
        // can hold.
        assert.ok(
          sawCreditPastTheCash,
          `seed ${seed}: the walk never credited a bill past the cash already on it, so the bill never shrank under money it was holding\n${log.join('\n')}`,
        );
        // And the undo of that: a note withdrawn off a bill whose cash it had
        // displaced. The bill is owed the whole amount again while the account
        // still holds the money, which every figure in the identity survives —
        // it is the clause about what a bill can hold that does not, and the
        // next presentation that collects the customer's money twice.
        assert.ok(
          sawNoteWithdrawn,
          `seed ${seed}: the walk never withdrew a note that had displaced cash, so the half that puts it back was never exercised\n${log.join('\n')}`,
        );
      } finally { ws.close(); }
    });
  }
});

/* ========================================================================== *
 * 2d. The states a reversal leaves behind
 *
 * Every test above asks whether the money added up. These ask what the rest of
 * the platform can still do afterwards, which is where the same mistake hides
 * one call further on: a bill that is settled because the withdrawal came off
 * the account cannot also be written off; a bill that was struck out while
 * holding cash still has to be able to give that cash back; and a debit that
 * is with the bank cannot be recalled by writing a column, because the charge
 * it left behind is counted as in flight for ever.
 * ========================================================================== */

describe('what a reversal leaves the platform able to do', () => {
  test('a chargeback taken out of the account’s credit can still be closed as lost', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice, charge } = await overpaidByCreditNote(ws, 'Ashby Forge');

      // $300.00 of the $499.00 that arrived is credit on the account, so a
      // $300.00 chargeback never touches the bill: it empties the credit and
      // leaves the invoice paid, exactly as the mirror rule requires.
      const dispute: Dispute = await ws.ok('POST', '/v1/disputes', {
        charge: charge.id, amount: 30_000, reason: 'fraudulent',
      });
      const held = await ws.invoice(invoice.id);
      assert.equal(held.status, 'paid', 'the bill was never owed this money, so it is still settled');
      assert.equal(held.amount_paid, 19_900);
      assert.equal((await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`)).amount_overpaid, 0);
      await assertReconciled(ws, customer.id, 'while the chargeback over the credit is open');

      // Losing it must still be possible. There is nothing to write off — the
      // loss landed on the account, not on the bill — and refusing the close
      // strands the case for ever, along with the deadline job behind it.
      const lost: Dispute = await ws.ok('POST', `/v1/disputes/${dispute.id}/close`, { status: 'lost' });
      assert.equal(lost.status, 'lost');
      const after = await ws.invoice(invoice.id);
      assert.equal(after.status, 'paid', 'a settled bill is not written off because credit went back');
      await assertReconciled(ws, customer.id, 'after the chargeback over the credit was lost');
    } finally { ws.close(); }
  });

  test('a chargeback on a bill collected again while it was open closes without a 409', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Wrexham Castings');
      const { invoice } = await ws.bill(customer.id);
      const card = await ws.card(customer.id, 'succeeds');
      await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: card.id, confirm: true, off_session: true,
      });
      const charge = ((await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`)).charges as Charge[])
        .find((c) => c.status === 'succeeded') as Charge;

      // The network pulls the money, the bill reopens, and the customer pays it
      // again while the case is still being argued.
      await ws.ok('POST', '/v1/disputes', { charge: charge.id, reason: 'fraudulent' });
      assert.equal((await ws.invoice(invoice.id)).status, 'open');
      await ws.ok('POST', `/v1/invoices/${invoice.id}/retry`, {});
      assert.equal((await ws.invoice(invoice.id)).status, 'paid', 'the second charge settled the bill');

      const open = ((await ws.ok('GET', `/v1/disputes?customer=${customer.id}&status=all&limit=10`)).data as Dispute[])[0];
      const lost: Dispute = await ws.ok('POST', `/v1/disputes/${open.id}/close`, { status: 'lost' });
      assert.equal(lost.status, 'lost');
      assert.equal((await ws.invoice(invoice.id)).status, 'paid', 'a bill that has since been paid is not uncollectible');
      await assertReconciled(ws, customer.id, 'after losing a dispute over a bill since re-collected');
    } finally { ws.close(); }
  });

  test('a deadline that passes on such a dispute does not leave a job failing for ever', async () => {
    const ws = await workspace();
    try {
      const { customer, invoice, charge } = await overpaidByCreditNote(ws, 'Corby Toolworks');
      await ws.ok('POST', '/v1/disputes', { charge: charge.id, amount: 30_000, reason: 'fraudulent' });

      // Nobody answers. The deadline job closes the case as lost on its own,
      // and it has to survive doing so — a throw here retries until the job
      // gives up and the dispute is stuck at `needs_response` for ever.
      const travelled = await ws.travel(40 * DAY);
      assert.equal(travelled.failed, 0, 'the dispute deadline job must not fail');
      const disputes = (await ws.ok('GET', `/v1/disputes?customer=${customer.id}&status=all&limit=10`)).data as Dispute[];
      assert.equal(disputes[0].status, 'lost', 'the unanswered case closed itself');
      await assertReconciled(ws, customer.id, 'after the deadline passed');
      assert.equal((await ws.invoice(invoice.id)).status, 'paid');
    } finally { ws.close(); }
  });

  test('money left on a withdrawn bill can still be given back', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Selby Hydraulics');
      const { invoice } = await ws.bill(customer.id);
      const card = await ws.card(customer.id, 'succeeds');
      await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: card.id, confirm: true, off_session: true,
      });
      const charge = ((await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`)).charges as Charge[])
        .find((c) => c.status === 'succeeded') as Charge;

      // Half the money is charged back, so the bill is open with $249.50 on it,
      // and finance withdraws the bill rather than chasing the rest.
      await ws.ok('POST', '/v1/disputes', { charge: charge.id, amount: 24_950, reason: 'fraudulent' });
      const reopened = await ws.invoice(invoice.id);
      assert.equal(reopened.status, 'open');
      assert.equal(reopened.amount_paid, 24_950);
      await ws.ok('POST', `/v1/invoices/${invoice.id}/void`, {});
      const voided = await ws.invoice(invoice.id);
      assert.equal(voided.status, 'void');
      assert.equal(voided.amount_paid, 24_950, 'voiding a bill does not un-collect what it collected');

      // That $249.50 is the customer's money sitting on a struck-out document.
      // Refusing to refund it because the bill is void leaves them out of pocket
      // with no route back.
      const refund: Refund = await ws.ok('POST', '/v1/refunds', {
        charge: charge.id, amount: 24_950, reason: 'requested_by_customer',
      });
      assert.equal(refund.amount, 24_950);
      const after = await ws.invoice(invoice.id);
      assert.equal(after.status, 'void', 'a withdrawn bill stays withdrawn');
      assert.equal(after.amount_paid, 0, 'and no longer records money it does not hold');
      assert.equal(after.amount_due, 0, 'a struck-out bill is never owed again');
      await assertReconciled(ws, customer.id, 'after refunding what a withdrawn bill held');
    } finally { ws.close(); }
  });

  test('a debit with the bank cannot be cancelled out from under the bill it is against', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Padgate Bearings');
      const { invoice } = await ws.bill(customer.id);
      const debit: PaymentMethod = await ws.ok('POST', '/v1/payment_methods', {
        type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank',
        account_type: 'checking', simulated_behavior: 'succeeds',
      });
      const presented: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: debit.id, confirm: true, off_session: true,
      });
      assert.equal(presented.status, 'processing');

      // Cancelling would only rewrite a column here: the instruction is with
      // the bank, and the charge it left behind is what every future
      // presentation is priced against. Letting it be cancelled leaves that
      // charge pending for ever, and the bill can never be presented again.
      const refused = await ws.fail(
        'POST', `/v1/payment_intents/${presented.id}/cancel`, { cancellation_reason: 'abandoned' },
        409, 'payment_intent_processing',
      );
      assert.match(refused.message, /cannot be recalled/);
      assert.equal((await ws.ok('GET', `/v1/payment_intents/${presented.id}`)).status, 'processing');

      // And the bank's answer still lands, which is the whole reason not to
      // cancel: the bill is collected, not stuck.
      assert.equal((await ws.travel(5 * DAY)).failed, 0);
      const settled = await ws.invoice(invoice.id);
      assert.equal(settled.status, 'paid', 'the debit settled and paid the bill');
      assert.equal(settled.amount_paid, invoice.total);
      await assertReconciled(ws, customer.id, 'after a cancel that was refused settled anyway');
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 3. Smart dunning — the recovery schedule
 * ========================================================================== */

describe('smart dunning', () => {
  test('a card that declines three times and then clears recovers the invoice and the subscription', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Ferrous Dynamics');
      await ws.card(customer.id, 'insufficient_funds', { simulated_decline_count: 3 });
      const { sub, invoice } = await ws.subscribe(customer.id);

      assert.equal(invoice.status, 'open', 'the first presentation was refused');
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'past_due');

      const [opened] = await ws.dunning(customer.id);
      assert.equal(opened.status, 'recovering');
      assert.equal(opened.attempt_count, 1);
      assert.equal(opened.max_attempts, 4);
      assert.deepEqual(opened.retry_days, [3, 5, 7]);
      assert.equal(opened.amount_at_risk, invoice.total);
      assert.equal(opened.last_failure_code, 'insufficient_funds');
      assert.equal(opened.needs_human, false, 'a soft decline on attempt one does not need a person');

      const travelled = await ws.travel(30 * DAY);
      assert.equal(travelled.failed, 0);

      const settled = await ws.invoice(invoice.id);
      assert.equal(settled.status, 'paid');
      assert.equal(settled.amount_paid, settled.total);
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active');

      const [campaign] = await ws.dunning(customer.id);
      assert.equal(campaign.status, 'recovered');
      assert.equal(campaign.attempt_count, 4);
      assert.equal(campaign.recovered_amount, settled.total);
      assert.equal(campaign.next_attempt_at, null);

      const outcomes = campaign.attempts.map((a) => a.outcome);
      assert.deepEqual(outcomes, ['failed', 'failed', 'failed', 'succeeded']);

      // 3 days, then 5, then 7 — gaps between attempts, each landing in the
      // 09:00 UTC collection window on a weekday.
      assert.deepEqual(attemptDays(campaign.attempts), ['2026-06-01', '2026-06-04', '2026-06-09', '2026-06-16']);
      for (const attempt of campaign.attempts.slice(1)) {
        const hour = new Date(attempt.attempted_at).getUTCHours();
        assert.ok(hour >= 9 && hour < 13, `a retry lands in the collection window, not at ${hour}:00`);
      }
      assert.ok(
        campaign.attempts[0].decision.includes('Attempt 2 of 4'),
        `the first attempt says what happens next: ${campaign.attempts[0].decision}`,
      );
    } finally { ws.close(); }
  });

  /**
   * The day a four-attempt schedule would make its last presentation, for a
   * first failure on MONDAY 1 June 2026, from the policy alone: gaps of 3, 5
   * and 7 days, snapped to weekdays. 1 June + 3 = Thursday 4 June; + 5 =
   * Tuesday 9 June; + 7 = Tuesday 16 June. The soft-decline test above walks
   * the same dates as real attempts, so the hold ends exactly where a card
   * that kept being refused would have been given up on.
   */
  const WINDOW_ENDS = '2026-06-16';

  const inCollectionWindow = (ts: number) => {
    const hour = new Date(ts).getUTCHours();
    return hour >= 9 && hour < 13;
  };

  const pendingDeadline = (ws: Workspace, campaignId: string) => ws.app.ctx.db.get<{ run_at: number }>(
    `SELECT run_at FROM jobs WHERE type = 'payments.dunning_retry' AND status = 'pending' AND idem_key = ?`,
    `payments.dunning_retry:${campaignId}`,
  );

  test('expired_card drops the retries but holds the account until the schedule would have run out', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Talbot Metalworks');
      await ws.card(customer.id, 'expired_card');
      const before = (await ws.ok('GET', '/v1/dunning/summary')).totals.find((t: any) => t.currency === 'usd')
        ?? { amount_at_risk: 0, lost_amount: 0 };
      const { sub, invoice } = await ws.subscribe(customer.id);
      assert.equal(invoice.status, 'open');

      const [campaign] = await ws.dunning(customer.id);
      assert.equal(campaign.status, 'recovering', 'the card is dead; the account is not written off in the same second');
      assert.equal(campaign.attempt_count, 1);
      assert.equal(campaign.attempts_remaining, 3, 'three scheduled retries were dropped, not spent');
      assert.equal(campaign.next_attempt_at, null, 'and none of them is presented: waiting cannot un-expire a card');
      assert.match(campaign.attempts[0].decision, /dropped/);
      assert.match(campaign.attempts[0].decision, /held for a person/);

      // Held, with the deadline the schedule itself would have had.
      assert.ok(campaign.hold, 'the campaign says why nothing is scheduled');
      assert.equal(campaign.hold.reason, 'card_needs_person');
      assert.equal(dayKey(campaign.hold.until as number), WINDOW_ENDS, 'the hold ends the day the fourth attempt would have landed');
      assert.ok(inCollectionWindow(campaign.hold.until as number), 'and in the collection window, like an attempt');
      assert.equal(campaign.needs_human, true);
      assert.match(campaign.recommended_action, /new card/i);
      assert.match(campaign.recommended_action, /Jun 16, 2026/, 'the queue names the day the hold runs out');
      assert.match(campaign.recommended_action, /marked unpaid/, 'and what happens then');

      // The subscription is in arrears, not stopped — the state Stripe leaves
      // it in for the whole retry window, whatever the decline code.
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'past_due');

      const held = (await ws.ok('GET', `/v1/events?type=dunning.held&object_id=${campaign.id}`)).data as any[];
      const notice = held.find((e) => e.data?.invoice === invoice.id);
      assert.ok(notice, 'dunning.held is emitted');
      assert.equal(notice.data.reason, 'card_needs_person');
      assert.equal(notice.data.until, campaign.hold.until);
      assert.equal(notice.data.failure_code, 'expired_card');
      assert.equal(
        (await ws.ok('GET', `/v1/events?type=dunning.exhausted&object_id=${campaign.id}`)).data
          .some((e: any) => e.type === 'dunning.exhausted' && e.data?.invoice === invoice.id),
        false, 'nothing has been given up on',
      );

      // The deadline is a job, so the time machine can reach it.
      const deadline = pendingDeadline(ws, campaign.id);
      assert.ok(deadline, 'the hold has a deadline on the queue');
      assert.equal(deadline.run_at, campaign.hold.until);

      // The money is at risk, and it is not lost.
      const after = (await ws.ok('GET', '/v1/dunning/summary')).totals.find((t: any) => t.currency === 'usd');
      assert.equal(after.amount_at_risk, before.amount_at_risk + invoice.total, 'a held bill is still at risk');
      assert.equal(after.lost_amount, before.lost_amount, 'and a card that needs replacing is not money that is gone');

      // Ten days in: still held, and the dead card has not been presented again.
      assert.equal((await ws.travel(10 * DAY)).failed, 0);
      const midway = (await ws.dunning(customer.id))[0];
      assert.equal(midway.status, 'recovering');
      assert.equal(midway.attempt_count, 1, 'no further attempts were made against a dead card');
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'past_due');

      // The window closes with the bill still owed: now, and only now, the
      // workspace's end behaviour applies — through billing's own machine.
      assert.equal((await ws.travel(20 * DAY)).failed, 0);
      const ended = (await ws.dunning(customer.id))[0];
      assert.equal(ended.status, 'exhausted');
      assert.equal(ended.attempt_count, 1, 'the deadline is a decision, not a presentation');
      assert.equal(ended.hold, null);
      assert.equal(ended.resolved_at, campaign.hold.until, 'given up on at the deadline, not a moment before');
      assert.match(ended.resolution ?? '', /hold ran out/);
      assert.match(ended.resolution ?? '', /marked unpaid/);
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'unpaid');

      const exhausted = ((await ws.ok('GET', `/v1/events?type=dunning.exhausted&object_id=${campaign.id}`)).data as any[])
        .find((e) => e.data?.invoice === invoice.id);
      assert.ok(exhausted, 'dunning.exhausted is emitted when the hold runs out');
      assert.equal(exhausted.data.reason, 'hold_expired');
      assert.equal(exhausted.data.failure_code, 'expired_card');
      assert.equal(pendingDeadline(ws, campaign.id), undefined, 'and nothing is left on the queue');
    } finally { ws.close(); }
  });

  test('a decline the schedule cannot answer drops the retries on attempt one and names who can', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Ashcombe Automation');
      await ws.card(customer.id, 'authentication_required');
      const { sub, invoice } = await ws.subscribe(customer.id);

      const [campaign] = await ws.dunning(customer.id);
      assert.equal(campaign.status, 'recovering', 'a card that merely wants the cardholder is not an account to write off');
      assert.equal(campaign.attempt_count, 1);
      assert.equal(campaign.attempts_remaining, 3, 'three retries were dropped rather than spent on an impossible outcome');
      assert.equal(campaign.next_attempt_at, null, 'an off-session retry can never satisfy an issuer asking for the cardholder');
      assert.equal(campaign.last_failure_code, 'authentication_required');
      assert.equal(campaign.hold?.reason, 'card_needs_person');
      assert.equal(dayKey(campaign.hold?.until as number), WINDOW_ENDS);
      assert.equal(campaign.needs_human, true);
      assert.match(campaign.recommended_action, /off_session=false/, 'the advice names a call that exists');
      assert.doesNotMatch(campaign.recommended_action, /new card/i, 'and does not tell anyone to chase new details');
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'past_due', 'in arrears, not unpaid');

      const action = await ws.ok('GET', '/v1/events?type=invoice.payment_action_required&limit=20');
      const notice = (action.data as any[]).find((e) => e.data?.invoice === invoice.id);
      assert.ok(notice, 'the bank wanting the cardholder is its own event, not just another failure');
      assert.equal(notice.data.reason, 'authentication_required');
      assert.match(notice.data.resolution, new RegExp(`/v1/invoices/${invoice.id}/retry`));

      // The only thing on the queue is the deadline, and it presents nothing.
      assert.equal(pendingDeadline(ws, campaign.id)?.run_at, campaign.hold?.until);
      const presented = (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length;
      assert.equal((await ws.travel(60 * DAY)).failed, 0);
      const ended = (await ws.dunning(customer.id))[0];
      assert.equal(ended.attempt_count, 1, 'sixty days later it still has not been retried');
      assert.equal(
        (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length, presented,
        'the card was never presented off-session again',
      );
      assert.equal(ended.status, 'exhausted', 'nobody confirmed the card inside the window, so the account was given up on');
      assert.equal(dayKey(ended.resolved_at as number), WINDOW_ENDS);
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'unpaid');
    } finally { ws.close(); }
  });

  test('a card attached during a hold is presented at once, and it is the new card that is charged', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Hollins Gear');
      const dead = await ws.card(customer.id, 'expired_card');
      const { sub, invoice } = await ws.subscribe(customer.id);
      const [held] = await ws.dunning(customer.id);
      assert.equal(held.hold?.reason, 'card_needs_person');
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'past_due');

      // A week in, the customer adds a working card — without making it the
      // default, which is how a card lands from a portal form. The hold was
      // waiting for exactly this, so the bill is presented to that card now.
      await ws.travel(7 * DAY);
      const replacement = await ws.card(customer.id, 'succeeds', { set_default: false });
      await ws.tick();

      const settled = await ws.invoice(invoice.id);
      assert.equal(settled.status, 'paid', 'the bill was presented to the card that arrived, not left for someone to remember');
      assert.equal(settled.amount_paid, invoice.total);
      const charges = (await ws.ok('GET', `/v1/charges?invoice=${invoice.id}&status=all&limit=10`)).data as Charge[];
      const authorised = charges.find((c) => c.status === 'succeeded');
      assert.equal(authorised?.payment_method, replacement.id, 'charged to the new card');
      assert.notEqual(authorised?.payment_method, dead.id);

      const [campaign] = await ws.dunning(customer.id);
      assert.equal(campaign.status, 'recovered');
      assert.equal(campaign.attempt_count, 2, 'the presentation spent a window like any other');
      assert.equal(campaign.hold, null);
      assert.equal(campaign.recovered_amount, invoice.total);
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active');
      assert.equal(pendingDeadline(ws, campaign.id), undefined, 'the deadline went with the hold');
      assert.equal((await ws.travel(30 * DAY)).failed, 0);
      const later = (await ws.dunning(customer.id)).find((row) => row.id === campaign.id);
      assert.equal(later?.status, 'recovered', 'and it never fires');
      assert.equal(later?.attempt_count, 2);
      await assertReconciled(ws, customer.id, 'after a replacement card collected a held bill');
    } finally { ws.close(); }
  });

  test('the cardholder confirming part of a held bill keeps the hold on the rest', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Bramhall Optics');
      const card = await ws.card(customer.id, 'authentication_required');
      const { invoice } = await ws.subscribe(customer.id);
      const [held] = await ws.dunning(customer.id);
      assert.equal(held.hold?.reason, 'card_needs_person');
      const deadline = held.hold?.until as number;

      // Over the phone, the customer confirms a quarter of the bill. Money
      // arriving is not a card that can be presented again: the hold stays,
      // with less behind it.
      const part = Math.round(invoice.total / 4);
      const intent: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: card.id, amount: part, confirm: true, off_session: false,
      });
      assert.equal(intent.status, 'requires_action');
      const paid: PaymentIntent = await ws.ok('POST', `/v1/payment_intents/${intent.id}/authenticate`, { result: 'approve' });
      assert.equal(paid.status, 'succeeded');

      const [campaign] = await ws.dunning(customer.id);
      assert.equal(campaign.status, 'recovering');
      assert.equal(campaign.amount_at_risk, invoice.total - part, 'what is at risk is what is still owed');
      assert.equal(campaign.next_attempt_at, null, 'nothing was scheduled against a card that needs the cardholder');
      assert.equal(campaign.hold?.reason, 'card_needs_person');
      assert.equal(campaign.hold?.until, deadline, 'and the deadline did not move');
      assert.equal(pendingDeadline(ws, campaign.id)?.run_at, deadline);
      await assertReconciled(ws, customer.id, 'after a part payment on a held bill');
    } finally { ws.close(); }
  });

  test('a final decline on the last window has no window left to hold, and ends the campaign there', async () => {
    const ws = await workspace(MONDAY);
    try {
      await ws.ok('PATCH', '/v1/payments/settings', { dunning: { max_attempts: 1 } });
      const customer = await ws.customer('Crowle Systems');
      await ws.card(customer.id, 'expired_card');
      const { sub } = await ws.subscribe(customer.id);
      const [campaign] = await ws.dunning(customer.id);
      assert.equal(campaign.status, 'exhausted');
      assert.equal(campaign.hold, null);
      assert.match(campaign.resolution ?? '', /last window/);
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'unpaid');
    } finally { ws.close(); }
  });

  test('an on-session retry gets the cardholder to confirm and collects the bill', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Ashcombe Automation');
      await ws.card(customer.id, 'authentication_required');
      const { sub, invoice } = await ws.subscribe(customer.id);
      assert.equal(invoice.status, 'open');

      // The operator has the customer on the phone, so the issuer has someone
      // to ask. This is the call the recommended action names.
      const attempt = await ws.ok('POST', `/v1/invoices/${invoice.id}/retry`, { off_session: false });
      assert.equal(attempt.collected, false, 'nothing is charged until the cardholder says yes');
      assert.equal(attempt.payment_intent.status, 'requires_action');
      assert.equal(attempt.next_action.type, 'authenticate');
      assert.match(attempt.summary, /Nothing has been charged yet/);
      assert.equal(attempt.charge, null);

      const approved: PaymentIntent = await ws.ok('POST', attempt.next_action.authenticate_url, { result: 'approve' });
      assert.equal(approved.status, 'succeeded');

      const settled = await ws.invoice(invoice.id);
      assert.equal(settled.status, 'paid');
      assert.equal(settled.amount_paid, settled.total);
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active', 'the customer was never lost');

      const money = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(money.cash_collected, settled.total);
      assert.equal(money.amount_overpaid, 0);
    } finally { ws.close(); }
  });

  test('a wrong security code is not retried — the second attempt sends the same wrong code', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Norbury Fabrication');
      await ws.card(customer.id, 'incorrect_cvc');
      await ws.subscribe(customer.id);

      const [campaign] = await ws.dunning(customer.id);
      assert.equal(campaign.status, 'recovering');
      assert.equal(campaign.next_attempt_at, null, 'not presented again');
      assert.equal(campaign.hold?.reason, 'card_needs_person');
      assert.equal(campaign.attempt_count, 1);
      assert.match(campaign.attempts[0].decision, /dropped/);
      assert.match(campaign.recommended_action, /re-enter the card/i);

      const settings = await ws.ok('GET', '/v1/payments/settings');
      const rows = settings.decline_codes as { code: string; retried: boolean }[];
      assert.equal(rows.find((row) => row.code === 'incorrect_cvc')?.retried, false);
      assert.equal(rows.find((row) => row.code === 'authentication_required')?.retried, false);
      assert.equal(rows.find((row) => row.code === 'insufficient_funds')?.retried, true, 'the declines worth retrying still are');
      assert.match(settings.schedule_explained, /held past due/);
    } finally { ws.close(); }
  });

  test('the network’s do-not-retry family exists, is never presented again, and holds the account', async () => {
    const ws = await workspace(MONDAY);
    try {
      const family = ['stolen_card', 'lost_card', 'pickup_card', 'fraudulent', 'restricted_card'] as const;
      const settings = await ws.ok('GET', '/v1/payments/settings');
      const rows = settings.decline_codes as { code: string; severity: string; retried: boolean }[];
      for (const code of family) {
        const row = rows.find((r) => r.code === code);
        assert.ok(row, `${code} is in the decline catalogue`);
        assert.equal(row.severity, 'final', `${code} is final`);
        assert.equal(row.retried, false, `${code} is never retried`);
        assert.ok((settings.dunning.give_up_codes as string[]).includes(code), `${code} is in give_up_codes by default`);
      }
      // Response code 05 reads like a refusal for ever and is the issuer's
      // generic "not right now": it is retried with the hard-decline gap.
      const dnh = rows.find((r) => r.code === 'do_not_honor');
      assert.equal(dnh?.severity, 'hard');
      assert.equal(dnh?.retried, true);

      const customer = await ws.customer('Marchbank Presses');
      const stolen = await ws.card(customer.id, 'stolen_card');
      assert.equal(stolen.simulated.behavior, 'stolen_card');
      const { sub, invoice } = await ws.subscribe(customer.id);
      assert.equal(invoice.status, 'open');
      const charge = (await ws.ok('GET', `/v1/charges?invoice=${invoice.id}&status=all`)).data[0] as Charge;
      assert.equal(charge.failure_code, 'stolen_card');
      assert.equal(charge.outcome.network_status, 'declined_by_network');

      const [campaign] = await ws.dunning(customer.id);
      assert.equal(campaign.status, 'recovering');
      assert.equal(campaign.attempt_count, 1);
      assert.equal(campaign.next_attempt_at, null, 'a stolen card is never presented again');
      assert.equal(campaign.hold?.reason, 'card_needs_person');
      assert.equal(dayKey(campaign.hold?.until as number), WINDOW_ENDS);
      assert.match(campaign.recommended_action, /never present this card again/i);
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'past_due');

      assert.equal((await ws.travel(60 * DAY)).failed, 0);
      const ended = (await ws.dunning(customer.id))[0];
      assert.equal(ended.attempt_count, 1, 'the card was never re-presented across the whole window');
      assert.equal(ended.status, 'exhausted');
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'unpaid');

      // The generic code is still the generic code: presented again, later.
      const other = await ws.customer('Marchbank Presses');
      await ws.card(other.id, 'do_not_honor');
      await ws.subscribe(other.id);
      const [retried] = await ws.dunning(other.id);
      assert.equal(retried.hold, null);
      assert.ok(retried.next_attempt_at, 'do_not_honor is retried');
      assert.match(retried.attempts[0].decision, /hard decline/);
    } finally { ws.close(); }
  });

  test('a hard decline waits longer than a soft one before the next attempt', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Kestrel Robotics');
      await ws.card(customer.id, 'card_declined');
      const { invoice } = await ws.subscribe(customer.id);
      const [campaign] = await ws.dunning(customer.id);

      // A soft decline would put attempt two on Thursday the 4th. card_declined
      // is hard, so the gap doubles to six days — which lands on Sunday the
      // 7th, and the weekend rule pushes it to Monday the 8th.
      assert.equal(dayKey(campaign.next_attempt_at as number), '2026-06-08');
      assert.match(campaign.attempts[0].decision, /hard decline/);
      assert.equal(campaign.amount_at_risk, invoice.total);
    } finally { ws.close(); }
  });

  test('a retry that would land on a weekend moves to the Monday', async () => {
    const ws = await workspace(UTC(2026, 6, 5)); // a Friday
    try {
      await ws.ok('PATCH', '/v1/payments/settings', { dunning: { retry_days: [1], max_attempts: 3 } });
      const customer = await ws.customer('Wetherby Castings');
      await ws.card(customer.id, 'insufficient_funds');
      await ws.subscribe(customer.id);

      const [campaign] = await ws.dunning(customer.id);
      assert.equal(dayKey(campaign.attempts[0].attempted_at), '2026-06-05');
      assert.equal(dayKey(campaign.next_attempt_at as number), '2026-06-08', 'Saturday is skipped for the Monday');
    } finally { ws.close(); }
  });

  test('a manual retry is recorded against the same campaign and can recover it', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Pellworth Foundry');
      const method = await ws.card(customer.id, 'insufficient_funds');
      const { sub, invoice } = await ws.subscribe(customer.id);

      const refused = await ws.ok('POST', `/v1/invoices/${invoice.id}/retry`, {});
      assert.equal(refused.collected, false);
      assert.equal(refused.failure.code, 'insufficient_funds');
      assert.equal(refused.dunning.attempt_count, 2, 'a human retry costs an attempt like any other');

      // The account rings in with a working card.
      await ws.ok('PATCH', `/v1/payment_methods/${method.id}`, { simulated_behavior: 'succeeds' });
      const collected = await ws.ok('POST', `/v1/invoices/${invoice.id}/retry`, {});
      assert.equal(collected.collected, true);
      assert.match(collected.summary, /collected against/);

      assert.equal((await ws.invoice(invoice.id)).status, 'paid');
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active');
      const [campaign] = await ws.dunning(customer.id);
      assert.equal(campaign.status, 'recovered');
      assert.equal(campaign.attempt_count, 3);

      await ws.fail('POST', `/v1/invoices/${invoice.id}/retry`, {}, 409, 'invoice_not_collectable');
    } finally { ws.close(); }
  });

  test('a direct debit in recovery is not counted as refused while the bank still has it', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Trenholm Fabrication');
      await ws.ok('POST', '/v1/payment_methods', {
        type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank',
        simulated_behavior: 'insufficient_funds', simulated_decline_count: 1,
      });
      const { sub, invoice } = await ws.subscribe(customer.id);
      assert.equal(invoice.status, 'open', 'a debit is presented, not authorised, so nothing is settled yet');
      assert.equal((await ws.dunning(customer.id)).length, 0, 'nothing has been refused yet, so nothing is in recovery');

      // Three working days later the bank returns it unpaid, and only then
      // does recovery start.
      await ws.travel(4 * DAY);
      const [opened] = await ws.dunning(customer.id);
      assert.equal(opened.status, 'recovering');
      assert.equal(opened.attempt_count, 1);
      assert.equal(opened.last_failure_code, 'insufficient_funds');
      assert.equal(dayKey(opened.attempts[0].attempted_at), '2026-06-04');

      // The retry presents a second debit. The bank has not answered, so the
      // campaign must not record a refusal — it waits for the settlement.
      await ws.travel(5 * DAY);
      const [inFlight] = await ws.dunning(customer.id);
      assert.equal(inFlight.attempt_count, 1, 'a debit that is still with the bank has not failed');
      assert.equal(inFlight.status, 'recovering');

      await ws.travel(5 * DAY);
      const [settled] = await ws.dunning(customer.id);
      assert.equal(settled.status, 'recovered');
      assert.equal(settled.attempt_count, 2);
      assert.equal((await ws.invoice(invoice.id)).status, 'paid');
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active');
    } finally { ws.close(); }
  });

  test('the recovery queue names the amount at risk, the next attempt and what to do', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Marley Composites');
      await ws.card(customer.id, 'insufficient_funds');
      const { sub, invoice } = await ws.subscribe(customer.id);

      const queue = (await ws.ok('GET', '/v1/dunning')).data as DunningView[];
      const mine = queue.find((row) => row.invoice === invoice.id);
      assert.ok(mine, 'the invoice being chased is in the queue');
      assert.equal(mine.customer_name, `Marley Composites ${1}`.replace('1', mine.customer_name.split(' ').pop() as string));
      assert.equal(mine.invoice_number, invoice.number);
      assert.equal(mine.subscription_status, 'past_due');
      assert.equal(mine.subscription, sub.id);
      assert.equal(mine.attempts_remaining, 3);
      assert.ok(mine.payment_method, 'the queue shows which method is failing');
      assert.match(mine.recommended_action, /Retrying/);
      assert.ok(mine.next_attempt_at && mine.next_attempt_at > ws.now());

      const summary = await ws.ok('GET', '/v1/dunning/summary');
      assert.ok(summary.open_campaigns >= 1);
      assert.ok(summary.by_decline.some((row: any) => row.code === 'insufficient_funds' && row.severity === 'soft'));
      const usd = summary.totals.find((row: any) => row.currency === 'usd');
      assert.ok(usd.amount_at_risk >= invoice.total, 'the amount at risk is reported per currency, never summed across them');
      assert.ok(usd.recovery_rate_bps >= 0 && usd.recovery_rate_bps <= 10_000);
      assert.ok(
        summary.totals.every((row: any) => /^[a-z]{3}$/.test(row.currency)),
        'a workspace billing in two currencies gets two answers, not one meaningless total',
      );
    } finally { ws.close(); }
  });

  test('stopping a campaign by hand stands the schedule down and leaves the bill alone', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Ardley Tooling');
      await ws.card(customer.id, 'insufficient_funds');
      const { invoice } = await ws.subscribe(customer.id);
      const [campaign] = await ws.dunning(customer.id);

      await ws.ok('POST', `/v1/dunning/${campaign.id}/cancel`, { reason: 'Finance is collecting this one by bank transfer.' });
      const [stopped] = await ws.dunning(customer.id);
      assert.equal(stopped.status, 'canceled');
      assert.equal(stopped.resolution, 'Finance is collecting this one by bank transfer.');
      assert.equal((await ws.invoice(invoice.id)).status, 'open', 'the bill is still owed');

      const travelled = await ws.travel(20 * DAY);
      assert.equal(travelled.failed, 0);
      assert.equal((await ws.dunning(customer.id))[0].attempt_count, 1, 'nothing else was presented');
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 4. What happens when recovery runs out
 * ========================================================================== */

describe('the end of a recovery', () => {
  const exhaust = async (endBehavior: 'cancel' | 'mark_unpaid' | 'leave_past_due') => {
    const ws = await workspace(MONDAY);
    await ws.ok('PATCH', '/v1/payments/settings', {
      dunning: { retry_days: [2], max_attempts: 2, end_behavior: endBehavior, hard_decline_multiplier: 1 },
    });
    const customer = await ws.customer('Corbin Hydraulics');
    await ws.card(customer.id, 'insufficient_funds');
    const { sub, invoice } = await ws.subscribe(customer.id);
    const travelled = await ws.travel(10 * DAY);
    assert.equal(travelled.failed, 0);
    const [campaign] = await ws.dunning(customer.id);
    return { ws, sub: await ws.ok('GET', `/v1/subscriptions/${sub.id}`), invoice: await ws.invoice(invoice.id), campaign };
  };

  test('“cancel” ends the subscription and says why', async () => {
    const { ws, sub, campaign } = await exhaust('cancel');
    try {
      assert.equal(campaign.status, 'exhausted');
      assert.equal(campaign.attempt_count, 2);
      assert.equal(sub.status, 'canceled');
      assert.equal(sub.cancellation_reason, 'payment_failed');
      assert.match(campaign.resolution ?? '', /All 2 attempts were refused/);
      assert.match(campaign.resolution ?? '', /cancelled/);
    } finally { ws.close(); }
  });

  test('“mark unpaid” stops collection but keeps the subscription', async () => {
    const { ws, sub, invoice, campaign } = await exhaust('mark_unpaid');
    try {
      assert.equal(sub.status, 'unpaid');
      assert.equal(invoice.status, 'open', 'the money is still owed; it has just stopped being chased');
      assert.match(campaign.resolution ?? '', /marked unpaid/);
    } finally { ws.close(); }
  });

  test('“leave past due” hands the account to a human without changing anything', async () => {
    const { ws, sub, campaign } = await exhaust('leave_past_due');
    try {
      assert.equal(sub.status, 'past_due');
      assert.equal(campaign.status, 'exhausted');
      assert.equal(campaign.needs_human, true);
      assert.match(campaign.recommended_action, /still owed/);
    } finally { ws.close(); }
  });

  test('the retry policy is validated, explained, and snapshotted onto running campaigns', async () => {
    const ws = await workspace(MONDAY);
    try {
      await ws.fail('PATCH', '/v1/payments/settings', { dunning: { max_attempts: 40 } }, 400);
      await ws.fail('PATCH', '/v1/payments/settings', { dunning: { retry_days: [0] } }, 400);

      const customer = await ws.customer('Vandenberg Plastics');
      await ws.card(customer.id, 'insufficient_funds');
      await ws.subscribe(customer.id);
      const [before] = await ws.dunning(customer.id);
      assert.deepEqual(before.retry_days, [3, 5, 7]);

      await ws.ok('PATCH', '/v1/payments/settings', { dunning: { retry_days: [1, 1], max_attempts: 3 } });
      const [after] = await ws.dunning(customer.id);
      assert.deepEqual(after.retry_days, [3, 5, 7], 'a campaign keeps the policy it started under');
      assert.equal(after.max_attempts, 4);

      const settings = await ws.ok('GET', '/v1/payments/settings');
      assert.deepEqual(settings.dunning.retry_days, [1, 1]);
      assert.match(settings.schedule_explained, /never on a weekend/);
      const expired = settings.decline_codes.find((row: any) => row.code === 'expired_card');
      assert.equal(expired.retried, false, 'the settings screen says which declines are not retried');
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 4b. An answer that arrives after the bill has moved
 *
 * Every presentation in this module is priced against the bill as it stands at
 * the moment of the charge — `confirmIntent` re-reads the invoice, and refuses
 * outright once there is nothing left to collect. Nothing re-read it on the way
 * back out. A direct debit is answered three days later, a cardholder closes the
 * authentication page after a colleague has taken the money over the phone, a
 * customer pays half the bill while a schedule is chasing all of it — and in
 * every one of those the answer lands on a bill that has moved since. These
 * tests hold what follows: a part payment is not a recovery and does not end the
 * campaign chasing the difference, whatever settles that difference does end it,
 * a decline against a settled bill is not a failed bill, and a subscription whose
 * collection has been stood down is not charged by the one engine whose whole job
 * is to keep presenting.
 * ========================================================================== */

describe('an answer that arrives after the bill has moved', () => {
  test('a part payment does not close the campaign chasing the rest of the bill', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Wexford Bearings');
      const method = await ws.card(customer.id, 'insufficient_funds', { simulated_decline_count: 1 });
      const { sub, invoice } = await ws.subscribe(customer.id);
      assert.equal(invoice.status, 'open', 'the first presentation was refused');

      const [opened] = await ws.dunning(customer.id);
      assert.equal(opened.status, 'recovering');
      assert.equal(opened.amount_at_risk, invoice.total);
      assert.ok(opened.next_attempt_at, 'a window is scheduled');

      // The customer rings in and pays $200.00 of the $499.00 on the card that
      // has since come good. Money arrived; the bill is not recovered.
      const part = 20_000;
      await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: method.id,
        amount: part, confirm: true, off_session: false,
      });

      const partly = await ws.invoice(invoice.id);
      assert.equal(partly.status, 'open');
      assert.equal(partly.amount_paid, part);
      assert.equal(partly.amount_due, invoice.total - part);

      const [still] = await ws.dunning(customer.id);
      assert.equal(still.status, 'recovering', 'a part payment is not a recovery');
      assert.equal(still.amount_at_risk, invoice.total - part, 'only the balance is at risk now');
      assert.equal(still.attempt_count, opened.attempt_count, 'and paying does not spend one of the retries');
      assert.ok(still.next_attempt_at, 'the schedule still has a window to present the difference in');

      // The proof that the window is real: the schedule runs and collects it.
      assert.equal((await ws.travel(30 * DAY)).failed, 0);
      const settled = await ws.invoice(invoice.id);
      assert.equal(settled.status, 'paid', 'the difference was presented and taken');
      assert.equal(settled.amount_paid, settled.total);
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active');

      const [done] = await ws.dunning(customer.id);
      assert.equal(done.status, 'recovered');
      assert.equal(done.recovered_amount, invoice.total - part, 'the schedule is credited with what its own retry brought in');
      await assertReconciled(ws, customer.id, 'after a part payment and the retry that finished the bill');
    } finally { ws.close(); }
  });

  test('a debit returned unpaid after the bill was credited away leaves the subscription alone', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Selby Castings');
      const { sub, invoice } = await ws.bill(customer.id);
      const method: PaymentMethod = await ws.ok('POST', '/v1/payment_methods', {
        type: 'bank_debit', customer: customer.id, bank_name: 'Midland Union Bank',
        account_type: 'checking', simulated_behavior: 'no_account',
      });
      const presented: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: method.id, confirm: true, off_session: true,
      });
      assert.equal(presented.status, 'processing');

      // The whole bill is credited away while the instruction is with the bank.
      await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: invoice.total, reason: 'order_change' });
      const credited = await ws.invoice(invoice.id);
      assert.equal(credited.status, 'paid');
      assert.equal(credited.amount_due, 0);
      assert.equal(credited.amount_paid, 0, 'nothing was collected — it was credited');
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active');

      assert.equal((await ws.travel(5 * DAY)).failed, 0);

      // The bank's answer is still recorded in full: the debit was refused.
      const charge: Charge = await ws.ok('GET', `/v1/charges/${(await ws.ok('GET', `/v1/payment_intents/${presented.id}`)).latest_charge}`);
      assert.equal(charge.status, 'failed');
      assert.equal(charge.failure_code, 'no_account');

      // What it is not is a bill that failed. There is no bill.
      assert.equal((await ws.invoice(invoice.id)).status, 'paid');
      assert.equal(
        (await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active',
        'a return unpaid on an invoice that owes nothing must not withdraw the service',
      );
      assert.deepEqual(
        (await ws.dunning(customer.id)).map((c) => c.status), [],
        'and it opens no campaign to chase a bill with nothing in it',
      );
      await assertReconciled(ws, customer.id, 'after a debit was returned unpaid on a credited bill');
    } finally { ws.close(); }
  });

  test('a cardholder who abandons authentication after the bill was settled keeps their subscription', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Ockley Tooling');
      const { sub, invoice } = await ws.bill(customer.id);
      const sca = await ws.card(customer.id, 'authentication_required');
      const waiting: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: sca.id, confirm: true, off_session: false,
      });
      assert.equal(waiting.status, 'requires_action', 'the issuer wants the cardholder');

      // A colleague takes the money on another card while the customer is still
      // looking at their bank's page.
      const other = await ws.card(customer.id, 'succeeds');
      await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: other.id, confirm: true, off_session: true,
      });
      assert.equal((await ws.invoice(invoice.id)).status, 'paid');
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active');

      const abandoned: PaymentIntent = await ws.ok('POST', `/v1/payment_intents/${waiting.id}/authenticate`, { result: 'abandon' });
      assert.equal(abandoned.status, 'requires_payment_method', 'the intent still records that nobody confirmed');
      assert.equal(abandoned.last_payment_error?.code, 'authentication_required');

      assert.equal((await ws.invoice(invoice.id)).status, 'paid');
      assert.equal(
        (await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active',
        'closing a 3-D Secure tab on a bill somebody else already paid is not a payment failure',
      );
      assert.deepEqual((await ws.dunning(customer.id)).map((c) => c.status), []);
      await assertReconciled(ws, customer.id, 'after an abandoned authentication on a settled bill');
    } finally { ws.close(); }
  });

  test('a credit note that clears the balance of a part-paid bill ends the campaign chasing it', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Draycott Hydraulics');
      const method = await ws.card(customer.id, 'insufficient_funds', { simulated_decline_count: 1 });
      const { invoice } = await ws.subscribe(customer.id);
      const [opened] = await ws.dunning(customer.id);
      assert.equal(opened.status, 'recovering');

      const part = 20_000;
      await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: method.id,
        amount: part, confirm: true, off_session: false,
      });
      const [still] = await ws.dunning(customer.id);
      assert.equal(still.status, 'recovering', 'the difference is still being chased');

      // The rest of the bill is credited away rather than collected. A campaign
      // that stays open across a part payment can only be ended by whatever
      // settles the remainder, and here that is not a charge.
      await ws.ok('POST', '/v1/credit_notes', { invoice: invoice.id, amount: invoice.total - part, reason: 'order_change' });
      const settled = await ws.invoice(invoice.id);
      assert.equal(settled.status, 'paid');
      assert.equal(settled.amount_due, 0);

      const [campaign] = await ws.dunning(customer.id);
      assert.equal(campaign.status, 'canceled', 'nothing is owed, so nothing is left chasing it');
      assert.equal(campaign.next_attempt_at, null);
      assert.equal((await ws.travel(30 * DAY)).failed, 0);
      assert.equal(
        ((await ws.ok('GET', `/v1/charges?invoice=${invoice.id}&status=succeeded&limit=50`)).data as Charge[]).length, 1,
        'and the card is never presented again for a bill that was credited, not collected',
      );
      await assertReconciled(ws, customer.id, 'after a credit note cleared the balance of a part-paid bill');
    } finally { ws.close(); }
  });

  /**
   * The mirror of the test above, and the half of the undo that is not money.
   *
   * A credit note that clears a balance settles the bill, and `invoice.paid`
   * cancels the campaign chasing it and the retry job with it. Withdrawing the
   * note puts the money back on the bill — and has to put the chase back too,
   * or the bill sits open, owed, with a working card on file, and no automatic
   * path ever presents it again. `invoice.finalized` fires once per bill and
   * fired long ago; a cancelled campaign stays cancelled.
   */
  test('withdrawing the credit note that settled a bill puts the chase back, not just the debt', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Melverley Castings');
      const method = await ws.card(customer.id, 'insufficient_funds');
      const { invoice } = await ws.subscribe(customer.id);
      const [opened] = await ws.dunning(customer.id);
      assert.equal(opened.status, 'recovering');

      const note: CreditNote = await ws.ok('POST', '/v1/credit_notes', {
        invoice: invoice.id, amount: invoice.total, reason: 'order_change',
      });
      assert.equal((await ws.invoice(invoice.id)).status, 'paid', 'the note covered the whole bill');
      assert.equal((await ws.dunning(customer.id))[0].status, 'canceled', 'so nothing is chasing it');

      // The note should never have been written. Billing puts the debt back.
      await ws.ok('POST', `/v1/credit_notes/${note.id}/void`, {});
      const owed = await ws.invoice(invoice.id);
      assert.equal(owed.status, 'open');
      assert.equal(owed.amount_due, invoice.total, 'the whole bill is owed again');

      // The card is good now, and a year is long enough for any schedule.
      await ws.ok('PATCH', `/v1/payment_methods/${method.id}`, { simulated_behavior: 'succeeds' });
      assert.equal((await ws.travel(400 * DAY)).failed, 0);

      const settled = await ws.invoice(invoice.id);
      assert.equal(
        settled.status, 'paid',
        'a bill whose credit note was withdrawn is presented again like any other owed bill',
      );
      assert.equal(settled.amount_paid, invoice.total);
      const view = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
      assert.equal(view.cash_collected, invoice.total, 'and the money actually arrived');
      await assertReconciled(ws, customer.id, 'after the credit note that settled a bill was withdrawn');
    } finally { ws.close(); }
  });

  /**
   * The same undo with a card that still declines: the campaign the settlement
   * closed is the one that takes the bill back, rather than a second campaign
   * starting the schedule over from attempt one.
   */
  test('a bill revived by withdrawing its credit note goes back to the campaign that was chasing it', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Alderbury Tooling');
      await ws.card(customer.id, 'insufficient_funds');
      const { invoice } = await ws.subscribe(customer.id);
      const first = (await ws.dunning(customer.id))[0];
      assert.equal(first.status, 'recovering');
      assert.equal(first.attempt_count, 1);

      const note: CreditNote = await ws.ok('POST', '/v1/credit_notes', {
        invoice: invoice.id, amount: invoice.total, reason: 'order_change',
      });
      assert.equal((await ws.dunning(customer.id))[0].status, 'canceled');

      await ws.ok('POST', `/v1/credit_notes/${note.id}/void`, {});
      assert.equal((await ws.travel(2 * DAY)).failed, 0);

      const campaigns = await ws.dunning(customer.id);
      assert.equal(campaigns.length, 1, 'the same campaign, not a second one over the same bill');
      assert.equal(campaigns[0].status, 'recovering', 'the debt is being chased again');
      assert.ok(
        campaigns[0].attempt_count > first.attempt_count,
        `the card was presented again — attempts went ${first.attempt_count} → ${campaigns[0].attempt_count}`,
      );
      await assertReconciled(ws, customer.id, 'after a declined bill was revived by withdrawing its credit note');
    } finally { ws.close(); }
  });

  test('pausing collection stands down the retry that was already scheduled', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Halstow Foundry');
      await ws.card(customer.id, 'insufficient_funds', { simulated_decline_count: 1 });
      const { sub, invoice } = await ws.subscribe(customer.id);
      assert.equal(invoice.status, 'open');

      const [opened] = await ws.dunning(customer.id);
      assert.equal(opened.status, 'recovering');
      assert.ok(opened.next_attempt_at, 'a retry is on the queue, and the card would clear on it');

      const paused = await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, { behavior: 'keep_as_draft' });
      assert.equal(paused.status, 'paused');

      assert.equal((await ws.travel(20 * DAY)).failed, 0);

      const bill = await ws.invoice(invoice.id);
      assert.equal(bill.amount_paid, 0, 'the card was not presented after collection was paused');
      assert.equal(bill.status, 'open', 'the money is still owed — a pause does not collect it, and does not forgive it');
      const charges = (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=50`)).data as Charge[];
      assert.equal(charges.length, 1, 'only the presentation that was refused before the pause');

      const [campaign] = await ws.dunning(customer.id);
      assert.equal(campaign.status, 'canceled');
      assert.match(campaign.resolution ?? '', /paused/);
      assert.match(campaign.recommended_action, /paused/);
      await assertReconciled(ws, customer.id, 'after collection was paused mid-campaign');
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 5. Money going back out
 * ========================================================================== */

describe('refunds', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(); });
  after(() => ws.close());

  test('a refund on a paid invoice moves amount_paid and leaves the bill owed again', async () => {
    const customer = await ws.customer('Larkfield Systems');
    await ws.card(customer.id, 'succeeds');
    const { invoice } = await ws.subscribe(customer.id);
    assert.equal(invoice.amount_paid, invoice.total);

    const part = Math.round(invoice.total / 4);
    const first: Refund = await ws.ok('POST', '/v1/refunds', {
      invoice: invoice.id, amount: part, reason: 'goodwill', description: 'Two days of ingestion downtime.',
    });
    assert.equal(first.amount, part);
    assert.equal(first.status, 'succeeded');

    const afterPartial = await ws.invoice(invoice.id);
    assert.equal(afterPartial.amount_paid, invoice.total - part);
    assert.equal(afterPartial.amount_due, part);
    assert.equal(afterPartial.status, 'open');
    assert.equal(
      afterPartial.amount_paid + afterPartial.pre_payment_credit_notes_amount + afterPartial.amount_due,
      afterPartial.total,
      'the bill still accounts for itself',
    );

    const rest: Refund = await ws.ok('POST', '/v1/refunds', { invoice: invoice.id, reason: 'requested_by_customer' });
    assert.equal(rest.amount, invoice.total - part, 'the default refund is whatever is left on the charge');

    const afterFull = await ws.invoice(invoice.id);
    assert.equal(afterFull.amount_paid, 0);
    assert.equal(afterFull.amount_due, afterFull.total);
    assert.equal(afterFull.paid_at, null);

    const charge = (await ws.ok('GET', `/v1/charges?invoice=${invoice.id}`)).data[0] as Charge;
    assert.equal(charge.amount_refunded, invoice.total);
    assert.equal(charge.refunded, true);

    // Cash in, cash back out, and nothing left unexplained on the bill.
    const money = await ws.ok('GET', `/v1/invoices/${invoice.id}/payments`);
    assert.equal(money.cash_collected, invoice.total);
    assert.equal(money.amount_refunded, invoice.total);
    assert.equal(money.amount_overpaid, 0);
    assert.equal(money.amount_paid, 0);
    assert.equal(money.refunds.length, 2);
    assert.match(money.summary, /gone back to the customer/);

    await ws.fail('POST', '/v1/refunds', { invoice: invoice.id, amount: 100 }, 400, 'refund_exceeds_charge');
  });

  test('a refund never re-opens the retry schedule, but the reopened bill is owed by somebody', async () => {
    const customer = await ws.customer('Ashgrove Instruments');
    await ws.card(customer.id, 'succeeds');
    const { sub, invoice } = await ws.subscribe(customer.id);
    const presented = (await ws.ok('GET', `/v1/payment_intents?invoice=${invoice.id}&status=all`)).data.length;
    const refund: Refund = await ws.ok('POST', '/v1/refunds', { invoice: invoice.id, reason: 'duplicate' });
    assert.match(refund.invoice_effect ?? '', /recovery queue/);

    const reopened = await ws.invoice(invoice.id);
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.amount_due, invoice.total);

    // Giving money back is not a failed collection: no schedule, no
    // presentation, no arrears. But the bill is open and owed, and a bill
    // nothing owns is a bill nobody collects.
    const [campaign] = await ws.dunning(customer.id);
    assert.ok(campaign, 'the reopened bill is in the recovery queue');
    assert.equal(campaign.status, 'recovering');
    assert.equal(campaign.attempt_count, 0, 'nothing was refused');
    assert.equal(campaign.next_attempt_at, null, 'and nothing is scheduled');
    assert.equal(campaign.hold?.reason, 'reopened_by_refund');
    assert.equal(campaign.hold?.until, null, 'nothing ends this but a person');
    assert.equal(campaign.amount_at_risk, invoice.total);
    assert.equal(campaign.needs_human, true);
    assert.match(campaign.recommended_action, /credit note/);
    assert.match(campaign.recommended_action, new RegExp(`/v1/invoices/${invoice.id}/retry`));
    assert.match(campaign.recommended_action, /duplicate/, 'the queue says why the money went back');
    assert.equal(
      ws.app.ctx.db.count(
        `SELECT COUNT(*) FROM jobs WHERE type = 'payments.dunning_retry' AND status = 'pending' AND idem_key = ?`,
        `payments.dunning_retry:${campaign.id}`,
      ),
      0, 'no retry job',
    );
    assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active', 'a refund is not a decline');
    const summary = await ws.ok('GET', '/v1/dunning/summary');
    assert.ok(summary.held_campaigns >= 1);

    // Six weeks pass and nothing charges the card on the heels of a refund.
    assert.equal((await ws.travel(45 * DAY)).failed, 0);
    assert.equal((await ws.ok('GET', `/v1/payment_intents?invoice=${invoice.id}&status=all`)).data.length, presented, 'never presented');
    assert.equal((await ws.dunning(customer.id))[0].hold?.reason, 'reopened_by_refund');
    assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active');

    // A person presents it once the customer expects the charge, and the
    // campaign that held it records the recovery.
    const collected = await ws.ok('POST', `/v1/invoices/${invoice.id}/retry`, {});
    assert.equal(collected.collected, true);
    assert.equal((await ws.invoice(invoice.id)).status, 'paid');
    const [done] = await ws.dunning(customer.id);
    assert.equal(done.status, 'recovered');
    assert.equal(done.hold, null);
    assert.equal(done.attempt_count, 1);
    assert.equal(done.recovered_amount, invoice.total);
  });

  test('a refund of a bill a schedule recovered reopens that campaign, and a credit note ends it', async () => {
    const customer = await ws.customer('Fallowfield Drives');
    const card = await ws.card(customer.id, 'insufficient_funds', { simulated_decline_count: 1 });
    const { invoice } = await ws.subscribe(customer.id);
    assert.equal((await ws.travel(5 * DAY)).failed, 0);
    const [recovered] = await ws.dunning(customer.id);
    assert.equal(recovered.status, 'recovered');
    assert.equal(recovered.recovered_amount, invoice.total);
    const usdBefore = (await ws.ok('GET', '/v1/dunning/summary')).totals.find((t: any) => t.currency === 'usd');

    const part = 5000;
    await ws.ok('POST', '/v1/refunds', { invoice: invoice.id, amount: part, reason: 'goodwill' });
    const [reopened] = await ws.dunning(customer.id);
    assert.equal(reopened.id, recovered.id, 'one campaign per bill: the history is one story');
    assert.equal(reopened.status, 'recovering');
    assert.equal(reopened.hold?.reason, 'reopened_by_refund');
    assert.equal(reopened.amount_at_risk, part);
    assert.equal(reopened.recovered_amount, 0, 'what it had recovered is no longer counted as recovered');
    assert.equal(reopened.attempt_count, recovered.attempt_count, 'the attempts it made are still its attempts');
    const usdAfter = (await ws.ok('GET', '/v1/dunning/summary')).totals.find((t: any) => t.currency === 'usd');
    assert.equal(usdAfter.recovered_amount, usdBefore.recovered_amount - invoice.total);
    assert.equal(usdAfter.amount_at_risk, usdBefore.amount_at_risk + part);

    // The goodwill was the point: the bill should have been smaller.
    const note: CreditNote = await ws.ok('POST', '/v1/credit_notes', {
      invoice: invoice.id, amount: part, reason: 'order_change', memo: 'Two days of ingestion downtime.',
    });
    assert.ok(note.id);
    assert.equal((await ws.invoice(invoice.id)).status, 'paid');
    const [ended] = await ws.dunning(customer.id);
    assert.equal(ended.status, 'canceled');
    assert.equal(ended.hold, null);
    assert.match(ended.resolution ?? '', /settled/);
    assert.equal(card.customer, customer.id);
    await assertReconciled(ws, customer.id, 'after a refund and the credit note that answered it');
  });

  test('a refund of a part payment on a bill a schedule is chasing only tells the schedule the new balance', async () => {
    const customer = await ws.customer('Ingleby Robotics');
    const card = await ws.card(customer.id, 'insufficient_funds');
    const { invoice } = await ws.subscribe(customer.id);
    const [opened] = await ws.dunning(customer.id);
    const window = opened.next_attempt_at as number;

    await ws.ok('PATCH', `/v1/payment_methods/${card.id}`, { simulated_behavior: 'succeeds' });
    const part = Math.round(invoice.total / 4);
    await ws.ok('POST', '/v1/payment_intents', {
      customer: customer.id, invoice: invoice.id, payment_method: card.id, amount: part, confirm: true, off_session: true,
    });
    const [partPaid] = await ws.dunning(customer.id);
    assert.equal(partPaid.amount_at_risk, invoice.total - part);
    assert.equal(partPaid.hold, null);

    await ws.ok('POST', '/v1/refunds', { invoice: invoice.id, amount: part, reason: 'requested_by_customer' });
    const [after] = await ws.dunning(customer.id);
    assert.equal(after.status, 'recovering');
    assert.equal(after.amount_at_risk, invoice.total, 'the schedule is told the balance it will present');
    assert.equal(after.hold, null, 'a live schedule owns this bill, so nothing is put on hold');
    assert.ok(after.next_attempt_at, 'and it keeps its window');
    assert.equal(dayKey(after.next_attempt_at as number), dayKey(partPaid.next_attempt_at as number));
    assert.equal(window > 0, true);
  });
});

describe('disputes', () => {
  test('a lost dispute takes the money and marks the invoice uncollectible', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Brantley Aerospace');
      await ws.card(customer.id, 'succeeds');
      const { sub, invoice } = await ws.subscribe(customer.id);
      const charge = (await ws.ok('GET', `/v1/charges?invoice=${invoice.id}`)).data[0] as Charge;

      const dispute: Dispute = await ws.ok('POST', '/v1/disputes', {
        charge: charge.id, reason: 'product_not_received',
      });
      assert.equal(dispute.status, 'needs_response');
      assert.equal(dispute.amount, charge.amount);
      assert.ok(dispute.evidence_due_by > ws.now());

      // The network pulls the funds the day the cardholder complains.
      const withdrawn = await ws.invoice(invoice.id);
      assert.equal(withdrawn.amount_paid, 0);
      assert.equal(withdrawn.amount_due, withdrawn.total);
      assert.equal(withdrawn.status, 'open');

      const argued: Dispute = await ws.ok('POST', `/v1/disputes/${dispute.id}/evidence`, {
        product_description: 'Telemetry ingestion for the billed month, with the alert digests delivered weekly.',
      });
      assert.equal(argued.status, 'under_review');

      const lost: Dispute = await ws.ok('POST', `/v1/disputes/${dispute.id}/close`, { status: 'lost' });
      assert.equal(lost.status, 'lost');

      const written = await ws.invoice(invoice.id);
      assert.equal(written.status, 'uncollectible');
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'unpaid');
    } finally { ws.close(); }
  });

  test('a dispute that is won gives the money back to the invoice', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Halloway Motors');
      await ws.card(customer.id, 'succeeds');
      const { sub, invoice } = await ws.subscribe(customer.id);
      const charge = (await ws.ok('GET', `/v1/charges?invoice=${invoice.id}`)).data[0] as Charge;

      const dispute: Dispute = await ws.ok('POST', '/v1/disputes', { charge: charge.id, reason: 'unrecognized' });
      await ws.ok('POST', `/v1/disputes/${dispute.id}/evidence`, {
        customer_communication: 'The subscription confirmation and every monthly receipt, sent to the billing contact.',
      });
      const won: Dispute = await ws.ok('POST', `/v1/disputes/${dispute.id}/close`, { status: 'won' });
      assert.equal(won.status, 'won');
      assert.ok((won.outcome_note ?? '').length > 20);

      const restored = await ws.invoice(invoice.id);
      assert.equal(restored.status, 'paid');
      assert.equal(restored.amount_paid, restored.total);
      assert.equal(restored.amount_due, 0);
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'active');
    } finally { ws.close(); }
  });

  test('a dispute nobody answers is lost when the deadline passes', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Grantham Castings');
      await ws.card(customer.id, 'succeeds');
      const { invoice } = await ws.subscribe(customer.id);
      const charge = (await ws.ok('GET', `/v1/charges?invoice=${invoice.id}`)).data[0] as Charge;
      const dispute: Dispute = await ws.ok('POST', '/v1/disputes', {
        charge: charge.id, reason: 'fraudulent', evidence_due_days: 10,
      });

      const travelled = await ws.travel(12 * DAY);
      assert.equal(travelled.failed, 0);
      const closed: Dispute = await ws.ok('GET', `/v1/disputes/${dispute.id}`);
      assert.equal(closed.status, 'lost');
      assert.match(closed.outcome_note ?? '', /No evidence was submitted/);
      assert.equal((await ws.invoice(invoice.id)).status, 'uncollectible');
    } finally { ws.close(); }
  });

  test('two disputes cannot be opened over the same charge', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Ilkley Precision');
      await ws.card(customer.id, 'succeeds');
      const { invoice } = await ws.subscribe(customer.id);
      const charge = (await ws.ok('GET', `/v1/charges?invoice=${invoice.id}`)).data[0] as Charge;
      await ws.ok('POST', '/v1/disputes', { charge: charge.id, reason: 'duplicate' });
      await ws.fail('POST', '/v1/disputes', { charge: charge.id, reason: 'duplicate' }, 409, 'dispute_already_open');
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 6. Payment methods on an account
 * ========================================================================== */

describe('payment methods', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(); });
  after(() => ws.close());

  test('the first method attached becomes the default, and the default can be moved', async () => {
    const customer = await ws.customer();
    const first = await ws.card(customer.id, 'succeeds');
    assert.equal(first.default_for_customer, true);
    const second = await ws.card(customer.id, 'succeeds', { brand: 'amex' });
    assert.equal(second.default_for_customer, false);

    const promoted: PaymentMethod = await ws.ok('POST', `/v1/payment_methods/${second.id}/set_default`, {});
    assert.equal(promoted.default_for_customer, true);
    const demoted: PaymentMethod = await ws.ok('GET', `/v1/payment_methods/${first.id}`);
    assert.equal(demoted.default_for_customer, false);

    const listed = await ws.ok('GET', `/v1/customers/${customer.id}/payment_methods`);
    assert.equal(listed.data.length, 2);
    assert.equal((listed.data[0] as PaymentMethod).id, second.id, 'the default sorts first');
  });

  test('detaching the default hands the account to the next method on file', async () => {
    const customer = await ws.customer();
    const first = await ws.card(customer.id, 'succeeds');
    const second = await ws.card(customer.id, 'succeeds', { brand: 'mastercard' });

    const detached: PaymentMethod = await ws.ok('POST', `/v1/payment_methods/${first.id}/detach`, {});
    assert.equal(detached.status, 'detached');
    assert.equal(detached.customer, null);
    const promoted: PaymentMethod = await ws.ok('GET', `/v1/payment_methods/${second.id}`);
    assert.equal(promoted.default_for_customer, true);

    const { invoice } = await ws.subscribe(customer.id);
    assert.equal(invoice.status, 'paid', 'the surviving card collected the bill');
    const charge = (await ws.ok('GET', `/v1/charges?invoice=${invoice.id}`)).data[0] as Charge;
    assert.equal(charge.payment_method, second.id);
  });

  test('a subscription’s own default is charged ahead of the account default', async () => {
    const customer = await ws.customer();
    const account = await ws.card(customer.id, 'succeeds');
    const forThisSubscription = await ws.card(customer.id, 'succeeds', { brand: 'amex' });
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'starter_monthly' }],
      default_payment_method: forThisSubscription.id,
    });
    await ws.tick();
    const [invoice] = await ws.invoicesFor(sub.id);
    const charge = (await ws.ok('GET', `/v1/charges?invoice=${invoice.id}`)).data[0] as Charge;
    assert.equal(charge.payment_method, forThisSubscription.id);
    assert.notEqual(charge.payment_method, account.id);
  });

  test('a method named by a subscription but since deleted falls back rather than failing', async () => {
    const customer = await ws.customer();
    const good = await ws.card(customer.id, 'succeeds');
    const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
      customer: customer.id, items: [{ price: 'starter_monthly' }],
      default_payment_method: 'pm_card_that_never_existed',
    });
    await ws.tick();
    const [invoice] = await ws.invoicesFor(sub.id);
    assert.equal(invoice.status, 'paid');
    const charge = (await ws.ok('GET', `/v1/charges?invoice=${invoice.id}`)).data[0] as Charge;
    assert.equal(charge.payment_method, good.id);
  });
});

/* ========================================================================== *
 * 7. The demo workspace
 * ========================================================================== */

describe('the seeded workspace', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(); });
  after(() => ws.close());

  test('Northwind opens with a real recovery queue and a charge behind its paid bills', async () => {
    const queue = (await ws.ok('GET', '/v1/dunning?status=all&limit=100')).data as DunningView[];
    assert.ok(queue.length >= 2, 'the demo has recovery history to look at');
    assert.ok(queue.some((row) => row.status === 'recovered'), 'including one that worked');
    assert.ok(queue.every((row) => row.recommended_action.length > 30));

    const charges = await ws.ok('GET', '/v1/charges?limit=200');
    assert.ok(charges.total_count > 50, `expected a charge history, got ${charges.total_count}`);

    const methods = await ws.ok('GET', '/v1/payment_methods?limit=200');
    assert.ok(methods.total_count > 5);
    assert.ok(
      (methods.data as PaymentMethod[]).every((m) => /^\d{4}$/.test(m.card?.last4 ?? m.bank_debit?.last4 ?? '')),
      'four digits and no more is all that is ever stored',
    );

    const disputes = await ws.ok('GET', '/v1/disputes');
    assert.ok(disputes.total_count >= 1, 'there is a chargeback to argue');
  });

  test('every seeded invoice still accounts for itself after the payments module has touched it', async () => {
    const travelled = await ws.travel(120 * DAY);
    assert.equal(travelled.failed, 0);

    const rows = ws.app.ctx.db.all<{ number: string; amount_paid: number; amount_due: number; total: number; pre: number; status: string }>(
      `SELECT number, amount_paid, amount_due, total, pre_payment_credit_notes_amount AS pre, status
         FROM billing_invoices WHERE org_id = ?`, ORG,
    );
    for (const row of rows) {
      if (row.status === 'void') continue;
      assert.equal(
        Number(row.amount_paid) + Number(row.pre) + Number(row.amount_due), Number(row.total),
        `${row.number}: collected + credited + due does not add up to the bill`,
      );
    }
    // The identity above is satisfied by an invoice that took more than it was
    // owed and threw the difference away, so it cannot be the only sweep. This
    // one compares what left the customer's account with what the platform
    // says it did with it, and there is nowhere for a unit to hide between them.
    const taken = ws.app.ctx.db.all<{ invoice_id: string; cash: number }>(
      `SELECT invoice_id, SUM(amount) AS cash FROM payments_charges
        WHERE org_id = ? AND status = 'succeeded' AND invoice_id IS NOT NULL
        GROUP BY invoice_id`, ORG,
    );
    assert.ok(taken.length > 50, `expected a body of collected invoices to sweep, got ${taken.length}`);
    let swept = 0;
    for (const row of taken) {
      // Refunds and disputes move money back out; those are their own tests.
      const reversed = ws.app.ctx.db.count(
        `SELECT (SELECT COUNT(*) FROM payments_refunds WHERE org_id = ? AND invoice_id = ?)
              + (SELECT COUNT(*) FROM payments_disputes WHERE org_id = ? AND invoice_id = ?)`,
        ORG, row.invoice_id, ORG, row.invoice_id,
      );
      if (reversed > 0) continue;
      const bill = ws.app.ctx.db.get<{ number: string; amount_paid: number }>(
        `SELECT number, amount_paid FROM billing_invoices WHERE org_id = ? AND id = ?`, ORG, row.invoice_id,
      );
      const credited = ws.app.ctx.db.count(
        `SELECT COALESCE(-SUM(amount), 0) FROM billing_balance_transactions
          WHERE org_id = ? AND invoice_id = ? AND type = 'invoice_overpayment'`, ORG, row.invoice_id,
      );
      assert.equal(
        Number(row.cash), Number(bill?.amount_paid ?? 0) + credited,
        `${bill?.number}: ${row.cash} was taken from the customer, but the platform accounts for ${bill?.amount_paid} on the bill and ${credited} on the account`,
      );
      swept += 1;
    }
    assert.ok(swept > 50, `expected the sweep to cover the workspace, it covered ${swept}`);

    const summary = await ws.ok('GET', '/v1/dunning/summary');
    assert.ok(summary.attempts.total > 0);
    assert.equal(summary.attempts.total, summary.attempts.succeeded + summary.attempts.failed + summary.attempts.skipped);
  });
});

/* ========================================================================== *
 * 14. The decision to stop charging, and the decision that a bill is recovered
 *
 * Both of these are questions with an answer that goes stale. A pause is read
 * when the collection is queued and read again when it runs, because a person
 * makes it in between; recovery is read off the bill rather than off the
 * authorisation, because a presentation priced around a debit already with the
 * bank can be authorised in full and still leave the bill owed.
 * ========================================================================== */

describe('a decision made after the work was queued', () => {
  /** A second bill for the same subscription, finalised by hand rather than by a renewal. */
  async function billAgain(ws: Workspace, customerId: string, subId: string): Promise<Invoice> {
    await ws.ok('PATCH', `/v1/subscriptions/${subId}`, {
      items: [{ price: 'price_nw_predictive_monthly' }], proration_behavior: 'create_prorations',
    });
    return ws.ok('POST', '/v1/invoices', { customer: customerId, subscription: subId });
  }

  test('collection paused between finalising a bill and running the job does not present the card', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Weatherley Tooling');
      await ws.card(customer.id, 'succeeds');
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: customer.id, items: [{ price: 'growth_monthly' }],
      });
      await ws.tick();
      await ws.travel(5 * DAY);

      const before = (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length;
      const bill = await billAgain(ws, customer.id, sub.id);
      assert.equal(bill.status, 'open', 'the second bill was finalised');
      assert.ok(bill.amount_due > 0, 'and it is owed');
      const queued = ws.app.ctx.db.count(
        `SELECT COUNT(*) FROM jobs WHERE org_id = ? AND idem_key = ? AND status = 'pending'`,
        ORG, `payments.collect_invoice:${bill.id}`,
      );
      assert.equal(queued, 1, 'the collection is queued and has not run yet');

      // The decision lands in the window the queue leaves open.
      const paused = await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, { behavior: 'keep_as_draft' });
      assert.equal(paused.status, 'paused');

      await ws.tick();

      const after = await ws.invoice(bill.id);
      const charges = (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data as Charge[];
      assert.equal(
        charges.length, before,
        'no card may be presented for an account whose collection was paused before the job ran',
      );
      assert.equal(after.amount_paid, 0, `${after.number} was charged after collection was paused`);
      assert.equal(after.status, 'open', 'the bill stays owed — a pause does not settle it');
    } finally { ws.close(); }
  });

  test('a subscription marked unpaid in the same window is not charged either', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Dunmore Fabrication');
      await ws.card(customer.id, 'succeeds');
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: customer.id, items: [{ price: 'growth_monthly' }],
      });
      await ws.tick();
      await ws.travel(5 * DAY);

      const before = (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length;
      const bill = await billAgain(ws, customer.id, sub.id);
      await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, { behavior: 'mark_uncollectible' });
      await ws.tick();

      const charges = (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data as Charge[];
      assert.equal(charges.length, before, `${bill.number} was presented after collection was stopped`);
    } finally { ws.close(); }
  });

  test('a scheduled retry that takes only part of the bill keeps chasing the rest', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Ravenhill Castings');
      const card = await ws.card(customer.id, 'insufficient_funds');
      const { sub, invoice } = await ws.subscribe(customer.id);
      const opened = (await ws.dunning(customer.id))[0];
      assert.equal(opened.status, 'recovering', 'the decline opened a campaign');
      assert.ok(opened.next_attempt_at, 'with a window booked');

      // A debit for part of the bill, presented a day before that window and
      // answered by the bank two days after it.
      await ws.travel((opened.next_attempt_at as number) - ws.now() - DAY);
      const debit: PaymentMethod = await ws.ok('POST', '/v1/payment_methods', {
        type: 'bank_debit', customer: customer.id, bank_name: 'Ravenhill Savings',
        account_type: 'checking', simulated_behavior: 'succeeds',
      });
      const part = 14_970;
      const inFlight: PaymentIntent = await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, amount: part, currency: 'usd',
        payment_method: debit.id, confirm: true, off_session: true,
      });
      assert.equal(inFlight.status, 'processing', 'the debit is with the bank');

      // The card is fixed, so the scheduled window authorises what is left.
      await ws.ok('PATCH', `/v1/payment_methods/${card.id}`, { simulated_behavior: 'succeeds' });
      await ws.travel(1.2 * DAY);

      const bill = await ws.invoice(invoice.id);
      assert.equal(bill.status, 'open', 'the debit has not been answered, so the bill is not settled');
      assert.equal(bill.amount_due, part, 'and what it still owes is exactly the debit in flight');

      const campaign = (await ws.dunning(customer.id))[0];
      assert.equal(
        campaign.status, 'recovering',
        `the campaign reported "${campaign.status}" over a bill that still owes ${bill.amount_due}`,
      );
      assert.equal(campaign.amount_at_risk, part, 'what is at risk followed the balance down');
      assert.ok(campaign.next_attempt_at, 'and a window is still booked to present the rest');
      assert.equal(
        ws.app.ctx.db.count(
          `SELECT COUNT(*) FROM jobs WHERE org_id = ? AND idem_key = ? AND status = 'pending'`,
          ORG, `payments.dunning_retry:${campaign.id}`,
        ),
        1,
        'with a job behind it',
      );
      assert.equal(
        ws.app.ctx.db.count(
          `SELECT COUNT(*) FROM events WHERE org_id = ? AND type = 'dunning.recovered' AND object_id = ?`,
          ORG, campaign.id,
        ),
        0,
        'nothing announced a recovery over an open bill',
      );

      // The debit settles and the bill is genuinely done; only then is it recovered.
      await ws.travel(3 * DAY);
      const settled = await ws.invoice(invoice.id);
      assert.equal(settled.status, 'paid');
      assert.equal((await ws.dunning(customer.id))[0].status, 'recovered');
      assert.equal(sub.id, sub.id);
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 15. Stopping collection means "not now", never "not ever"
 *
 * Every automatic door asks whether this account is being collected at the
 * moment it would charge, and stands down when the answer is no. That is only
 * half a rule. Standing down *spends* the work: the queued collection job runs
 * and returns, `invoice.finalized` never fires twice, and a recovery campaign
 * cancelled by the stop stays cancelled. So without the other half — putting
 * the work back when the account is collected again — a pause is a silent
 * write-off: resumed account, bill still owed, and nothing left that will ever
 * present it.
 * ========================================================================== */

describe('the bills a stop held back are presented when it is lifted', () => {
  /** A second bill for the same subscription, finalised by hand rather than by a renewal. */
  async function billAgain(ws: Workspace, customerId: string, subId: string): Promise<Invoice> {
    await ws.ok('PATCH', `/v1/subscriptions/${subId}`, {
      items: [{ price: 'price_nw_predictive_monthly' }], proration_behavior: 'create_prorations',
    });
    return ws.ok('POST', '/v1/invoices', { customer: customerId, subscription: subId });
  }

  test('a bill the pause stood the collection job down for is collected once the account resumes', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Ashcombe Bearings');
      await ws.card(customer.id, 'succeeds');
      const sub: Subscription = await ws.ok('POST', '/v1/subscriptions', {
        customer: customer.id, items: [{ price: 'growth_monthly' }],
      });
      await ws.tick();
      await ws.travel(5 * DAY);

      const before = (await ws.ok(`GET`, `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length;
      const bill = await billAgain(ws, customer.id, sub.id);
      assert.ok(bill.amount_due > 0, 'the second bill is owed');

      // The stop lands in the window the queue leaves open, and is honoured.
      await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, { behavior: 'keep_as_draft' });
      await ws.tick();
      const held = await ws.invoice(bill.id);
      assert.equal(held.amount_paid, 0, 'nothing was presented while collection was stopped');
      assert.equal(held.status, 'open', 'and the money is still owed');
      assert.equal(
        ws.app.ctx.db.count(
          `SELECT COUNT(*) FROM jobs WHERE org_id = ? AND idem_key = ? AND status = 'pending'`,
          ORG, `payments.collect_invoice:${bill.id}`,
        ),
        0,
        'the queued collection was spent by the run that stood down — nothing is left holding this bill',
      );

      // The account is collected again. The bill the stop held back has to come
      // with it, or the pause quietly forgave a debt nobody agreed to forgive.
      const resumed = await ws.ok('POST', `/v1/subscriptions/${sub.id}/resume`, {});
      assert.equal(resumed.status, 'active');
      assert.equal((await ws.travel(2 * DAY)).failed, 0);

      const after = await ws.invoice(bill.id);
      assert.equal(
        after.status, 'paid',
        `${after.number} was held back by the pause and never presented again after it was lifted — ${after.amount_due} is owed by an account that is being collected`,
      );
      assert.equal(after.amount_paid, bill.amount_due, 'and it collected exactly what it was owed');
      const charges = (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data as Charge[];
      assert.equal(charges.length, before + 1, 'presented once on the way back, not once per bill on the account');
      await assertReconciled(ws, customer.id, 'after a paused account was resumed');
    } finally { ws.close(); }
  });

  test('a recovery the pause cancelled is picked up again when the account resumes', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Marchmont Hydraulics');
      await ws.card(customer.id, 'insufficient_funds', { simulated_decline_count: 1 });
      const { sub, invoice } = await ws.subscribe(customer.id);
      assert.equal(invoice.status, 'open', 'the first presentation was refused');
      assert.equal((await ws.dunning(customer.id))[0].status, 'recovering');

      await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, { behavior: 'keep_as_draft' });
      assert.equal((await ws.travel(20 * DAY)).failed, 0);
      assert.equal((await ws.dunning(customer.id))[0].status, 'canceled', 'the schedule was stood down by the pause');
      assert.equal((await ws.invoice(invoice.id)).status, 'open', 'and the bill is still owed');

      await ws.ok('POST', `/v1/subscriptions/${sub.id}/resume`, {});
      assert.equal((await ws.travel(2 * DAY)).failed, 0);

      const after = await ws.invoice(invoice.id);
      assert.equal(
        after.status, 'paid',
        `${after.number} was left owed forever: the pause cancelled the campaign chasing it and resuming put nothing back`,
      );
      assert.equal(after.amount_paid, invoice.amount_due);
      await assertReconciled(ws, customer.id, 'after a stood-down recovery was resumed');
    } finally { ws.close(); }
  });

  test('resuming does not spend a window a live recovery still owns', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Pentridge Gearworks');
      const card = await ws.card(customer.id, 'insufficient_funds');
      const { sub, invoice } = await ws.subscribe(customer.id);
      const [opened] = await ws.dunning(customer.id);
      assert.equal(opened.status, 'recovering');
      const window = opened.next_attempt_at as number;
      assert.ok(window > ws.now(), 'the next window is still ahead');

      // Paused and resumed inside one window, so the campaign never runs an
      // attempt in between and is still the thing chasing this bill.
      await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, { behavior: 'keep_as_draft' });
      const presented = (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length;
      await ws.ok('POST', `/v1/subscriptions/${sub.id}/resume`, {});
      await ws.tick();

      const campaign = (await ws.dunning(customer.id))[0];
      assert.equal(campaign.status, 'recovering', 'the campaign was never stood down');
      assert.equal(campaign.attempt_count, opened.attempt_count, 'and resuming did not spend one of its attempts');
      assert.equal(campaign.next_attempt_at, window, 'its window is where it was');
      assert.equal(
        (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length, presented,
        'resuming presented nothing: the schedule already owns this bill and its window has not come round',
      );

      // The card is fixed, and the window the campaign kept is what collects it.
      await ws.ok('PATCH', `/v1/payment_methods/${card.id}`, { simulated_behavior: 'succeeds' });
      assert.equal((await ws.travel(window - ws.now() + DAY)).failed, 0);
      const after = await ws.invoice(invoice.id);
      assert.equal(after.status, 'paid', 'the window the campaign kept did the collecting');
      await assertReconciled(ws, customer.id, 'after a pause and resume inside one recovery window');
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 8. The other two ways a bill stops being asked for
 *
 * The section above holds one half of a rule. These hold the rest of it, and
 * both are the same mistake one condition along: `invoice.finalized` asks five
 * questions before it queues the one automatic charge a bill is entitled to,
 * and every "no" is a decision that can stop being true. A pause being lifted
 * is answered above. Nothing answered the other one that lifts — an account
 * with no method on file — so a bill raised the day before the card arrived is
 * asked for once, at the one moment nobody could pay it, and never again.
 *
 * And the mirror of it at the far end of the schedule: a campaign that ran out
 * of windows is the one status the recovery summary reads as money gone. A
 * bill collected after that — by exactly the hand retry the queue tells an
 * operator to make — left the campaign disagreeing with the bill it was
 * chasing: cash in, reported as lost, under an action line still asking for it.
 * ========================================================================== */

describe('a card that arrives after the bill', () => {
  test('a bill raised before there was a card on file is presented when one arrives', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Redgate Castings');
      const { invoice } = await ws.bill(customer.id);
      assert.equal(
        ws.app.ctx.db.count(
          `SELECT COUNT(*) FROM jobs WHERE org_id = ? AND idem_key = ?`,
          ORG, `payments.collect_invoice:${invoice.id}`,
        ),
        0,
        'nothing was queued, and rightly: an account with no method on file has nothing to present',
      );
      assert.equal((await ws.dunning(customer.id)).length, 0, 'and nothing was refused, so nothing is chasing it');

      // The finance team finds the corporate card the next day. That is the
      // answer to the only question that stopped this bill being charged.
      await ws.travel(DAY);
      await ws.card(customer.id, 'succeeds');
      assert.equal((await ws.travel(2 * DAY)).failed, 0);

      const after = await ws.invoice(invoice.id);
      assert.equal(
        after.status, 'paid',
        `${after.number} is still owed ${after.amount_due} by an account with a working card on it: the one presentation the bill was entitled to was skipped because there was nothing to charge, and nothing ever queued another`,
      );
      assert.equal(after.amount_paid, invoice.amount_due, 'and it collected exactly what it was owed');
      const charges = (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data as Charge[];
      assert.equal(charges.length, 1, 'presented once, not once per method on the account');
      await assertReconciled(ws, customer.id, 'after a card arrived for a bill that had none');
    } finally { ws.close(); }
  });

  test('a stop lifted while there was nothing to charge is not the end of the bill either', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Fenwick Castings');
      const { sub, invoice } = await ws.bill(customer.id);

      // Both stops are on at once, and both come off — the pause first, while
      // the account still has nothing on it to charge. Resuming reads the same
      // "no method" answer `invoice.finalized` read and stands down on it, so
      // the half above cannot be what puts this bill back.
      await ws.ok('POST', `/v1/subscriptions/${sub.id}/pause`, { behavior: 'keep_as_draft' });
      await ws.tick();
      const resumed = await ws.ok('POST', `/v1/subscriptions/${sub.id}/resume`, {});
      assert.equal(resumed.status, 'active');
      assert.equal((await ws.travel(2 * DAY)).failed, 0);
      assert.equal((await ws.invoice(invoice.id)).amount_paid, 0, 'there was still nothing to present');

      await ws.card(customer.id, 'succeeds');
      assert.equal((await ws.travel(2 * DAY)).failed, 0);
      const after = await ws.invoice(invoice.id);
      assert.equal(
        after.status, 'paid',
        `${after.number} was held back by a pause and then by an empty wallet, and neither stop ever ended: ${after.amount_due} is owed by an active account with a working card`,
      );
      await assertReconciled(ws, customer.id, 'after both stops came off');
    } finally { ws.close(); }
  });

  test('a card put on an account already being chased leaves that schedule where it is', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Pentridge Fabrication');
      await ws.card(customer.id, 'insufficient_funds');
      const { invoice } = await ws.subscribe(customer.id);
      const [opened] = await ws.dunning(customer.id);
      assert.equal(opened.status, 'recovering', 'the first presentation was refused');
      const window = opened.next_attempt_at as number;
      const presented = (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length;

      // A second card lands on an account whose bill is already owned by a
      // schedule. Presenting here would spend a window the campaign is holding
      // and put a second instruction on money it is already chasing.
      await ws.card(customer.id, 'succeeds', { set_default: true });
      await ws.tick();
      const campaign = (await ws.dunning(customer.id))[0];
      assert.equal(campaign.status, 'recovering');
      assert.equal(campaign.attempt_count, opened.attempt_count, 'attaching a card did not spend one of its attempts');
      assert.equal(campaign.next_attempt_at, window, 'and its window is where it was');
      assert.equal(
        (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length, presented,
        'nothing was presented: the schedule owns this bill until its window comes round',
      );

      // And the window it kept is what collects it, on the card that works.
      assert.equal((await ws.travel(window - ws.now() + DAY)).failed, 0);
      assert.equal((await ws.invoice(invoice.id)).status, 'paid', 'the window the campaign kept did the collecting');
      await assertReconciled(ws, customer.id, 'after a second card on an account in recovery');
    } finally { ws.close(); }
  });

  test('a queued presentation stands down if a schedule takes the bill before it runs', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Selby Toolmakers');
      const { invoice } = await ws.bill(customer.id);
      await ws.card(customer.id, 'insufficient_funds');
      assert.equal(
        ws.app.ctx.db.count(
          `SELECT COUNT(*) FROM jobs WHERE org_id = ? AND idem_key = ? AND status = 'pending'`,
          ORG, `payments.collect_invoice:${invoice.id}`,
        ),
        1,
        'the card queued the presentation this bill never had',
      );

      // A human gets there first, and the refusal opens the schedule that now
      // owns this bill — in the window between the job being queued and run.
      const refused = await ws.ok('POST', `/v1/invoices/${invoice.id}/retry`, {});
      assert.equal(refused.collected, false);
      const [opened] = await ws.dunning(customer.id);
      assert.equal(opened.status, 'recovering');
      assert.equal(opened.attempt_count, 1);
      const window = opened.next_attempt_at as number;
      const presented = (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length;

      await ws.tick();

      const after = (await ws.dunning(customer.id))[0];
      assert.equal(
        after.attempt_count, 1,
        'the queued job spent a window the campaign now owns — the answer it was queued on went stale and nothing read it again',
      );
      assert.equal(after.next_attempt_at, window, 'and the schedule is where it was');
      assert.equal(
        (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length, presented,
        'the card was presented twice in the same instant',
      );
      await assertReconciled(ws, customer.id, 'after a schedule took a bill a queued job was holding');
    } finally { ws.close(); }
  });

  test('a card attached while a chargeback has reopened the bill presents nothing', async () => {
    const ws = await workspace();
    try {
      const customer = await ws.customer('Ardleigh Pressings');
      await ws.card(customer.id, 'succeeds');
      const { invoice } = await ws.subscribe(customer.id);
      assert.equal(invoice.status, 'paid', 'the first presentation collected it');
      const charge = (await ws.ok('GET', `/v1/charges?invoice=${invoice.id}`)).data[0] as Charge;
      await ws.ok('POST', '/v1/disputes', { charge: charge.id, reason: 'fraudulent' });

      const reopened = await ws.invoice(invoice.id);
      assert.equal(reopened.status, 'open', 'the network took the money, so the bill is owed again');
      assert.ok(reopened.amount_due > 0);
      assert.equal((await ws.dunning(customer.id)).length, 0, 'and nothing is chasing it — a chargeback is not a decline');
      const presented = (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length;

      // An open bill with no campaign against it is exactly the shape the
      // handler above collects — and this one is open because the cardholder
      // is disputing it. Presenting a second card for money that is with the
      // network is the mirror image of the bill that never got asked for.
      await ws.card(customer.id, 'succeeds', { set_default: true });
      assert.equal((await ws.travel(2 * DAY)).failed, 0);

      assert.equal(
        (await ws.ok('GET', `/v1/charges?customer=${customer.id}&status=all&limit=100`)).data.length, presented,
        'a bill that has been presented before is open for a reason a new card does not answer',
      );
      assert.equal((await ws.invoice(invoice.id)).status, 'open');
      await assertReconciled(ws, customer.id, 'after a card arrived on an account with a live chargeback');
    } finally { ws.close(); }
  });
});

describe('a bill collected after the schedule ran out', () => {
  /** A campaign that has spent every window, with the bill left open and owed. */
  async function exhausted(ws: Workspace): Promise<{ customer: any; card: PaymentMethod; invoice: Invoice }> {
    await ws.ok('PATCH', '/v1/payments/settings', {
      dunning: { end_behavior: 'leave_past_due', max_attempts: 2, retry_days: [3] },
    });
    const customer = await ws.customer('Talbot Instruments');
    const card = await ws.card(customer.id, 'insufficient_funds');
    const { invoice } = await ws.subscribe(customer.id);
    assert.equal((await ws.travel(20 * DAY)).failed, 0);
    assert.equal((await ws.dunning(customer.id))[0].status, 'exhausted', 'the schedule ran out');
    return { customer, card, invoice };
  }

  test('a bill collected by hand after the last window is not still reported as lost', async () => {
    const ws = await workspace(MONDAY);
    try {
      const { customer, card, invoice } = await exhausted(ws);
      const before = await ws.ok('GET', '/v1/dunning/summary');
      const usdBefore = (before.totals as any[]).find((t) => t.currency === 'usd');
      assert.equal(usdBefore.lost_amount >= invoice.total, true, 'the bill is counted as lost while it is owed');

      // The account rings in with a working card and someone presents the bill
      // — which is precisely what the queue's own advice tells them to do.
      await ws.ok('PATCH', `/v1/payment_methods/${card.id}`, { simulated_behavior: 'succeeds' });
      const collected = await ws.ok('POST', `/v1/invoices/${invoice.id}/retry`, {});
      assert.equal(collected.collected, true);
      assert.equal((await ws.invoice(invoice.id)).status, 'paid');

      const campaign = (await ws.dunning(customer.id))[0];
      assert.equal(
        campaign.status, 'recovered',
        `the bill was collected in full and the campaign chasing it still reads ${campaign.status}`,
      );
      assert.equal(campaign.recovered_amount, invoice.total, 'and it records what came in');
      assert.doesNotMatch(
        campaign.recommended_action, /still owed/,
        'the queue is telling an operator to chase or credit a bill that has been paid',
      );

      const after = await ws.ok('GET', '/v1/dunning/summary');
      const usdAfter = (after.totals as any[]).find((t) => t.currency === 'usd');
      assert.equal(
        usdAfter.lost_amount, usdBefore.lost_amount - invoice.total,
        `${invoice.total} came in and this workspace still reports it as revenue it lost`,
      );
      assert.equal(usdAfter.recovered_amount, usdBefore.recovered_amount + invoice.total);
      assert.ok(usdAfter.recovery_rate_bps > usdBefore.recovery_rate_bps, 'and the recovery rate moved with it');
      await assertReconciled(ws, customer.id, 'after a bill was collected past the end of its schedule');
    } finally { ws.close(); }
  });

  test('a part payment after the last window is not a recovery', async () => {
    const ws = await workspace(MONDAY);
    try {
      const { customer, card, invoice } = await exhausted(ws);
      const before = await ws.ok('GET', '/v1/dunning/summary');
      const usdBefore = (before.totals as any[]).find((t) => t.currency === 'usd');

      // Money arriving is not the same thing as the bill being recovered — the
      // rule the live schedule already keeps, and the mirror image this fix
      // would be if it closed a campaign the moment any cash showed up.
      await ws.ok('PATCH', `/v1/payment_methods/${card.id}`, { simulated_behavior: 'succeeds' });
      await ws.ok('POST', '/v1/payment_intents', {
        customer: customer.id, invoice: invoice.id, payment_method: card.id,
        amount: Math.round(invoice.total / 4), confirm: true, off_session: true,
      });
      const part = await ws.invoice(invoice.id);
      assert.equal(part.status, 'open');
      assert.ok(part.amount_due > 0, 'the bill is still owed');

      const campaign = (await ws.dunning(customer.id))[0];
      assert.equal(campaign.status, 'exhausted', 'a quarter of the bill is not a recovered campaign');
      const after = await ws.ok('GET', '/v1/dunning/summary');
      const usdAfter = (after.totals as any[]).find((t) => t.currency === 'usd');
      assert.equal(usdAfter.lost_amount, usdBefore.lost_amount, 'and nothing moved off the lost column');
      await assertReconciled(ws, customer.id, 'after a part payment past the end of a schedule');
    } finally { ws.close(); }
  });
});

