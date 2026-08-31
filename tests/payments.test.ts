import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, frozenClock, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { DAY, dayKey } from '../src/shared/time';
import type { Invoice, Subscription } from '../src/server/modules/billing/types';
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

  test('expired_card gives up immediately instead of burning the remaining retries', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Talbot Metalworks');
      await ws.card(customer.id, 'expired_card');
      const { sub, invoice } = await ws.subscribe(customer.id);
      assert.equal(invoice.status, 'open');

      const [campaign] = await ws.dunning(customer.id);
      assert.equal(campaign.status, 'exhausted', 'waiting cannot un-expire a card');
      assert.equal(campaign.attempt_count, 1);
      assert.equal(campaign.attempts_remaining, 3, 'three scheduled retries were dropped, not spent');
      assert.equal(campaign.next_attempt_at, null);
      assert.equal(campaign.needs_human, true);
      assert.match(campaign.recommended_action, /new (card|details)/i);
      assert.match(campaign.attempts[0].decision, /dropped/);

      // The end behaviour applied, and it went through billing's own machine.
      assert.equal((await ws.ok('GET', `/v1/subscriptions/${sub.id}`)).status, 'unpaid');

      const events = await ws.ok('GET', `/v1/events?types=dunning.exhausted&limit=10`);
      const exhausted = (events.data as any[]).find((e) => e.data?.invoice === invoice.id);
      assert.ok(exhausted, 'dunning.exhausted is emitted');
      assert.equal(exhausted.data.reason, 'decline_is_final');
      assert.equal(exhausted.data.failure_code, 'expired_card');

      // Nothing further is scheduled: the schedule was abandoned, not paused.
      const pending = ws.app.ctx.db.count(
        `SELECT COUNT(*) FROM jobs WHERE type = 'payments.dunning_retry' AND status = 'pending' AND idem_key = ?`,
        `payments.dunning_retry:${campaign.id}`,
      );
      assert.equal(pending, 0);

      const travelled = await ws.travel(30 * DAY);
      assert.equal(travelled.failed, 0);
      const stillOne = await ws.dunning(customer.id);
      assert.equal(stillOne[0].attempt_count, 1, 'no further attempts were made against a dead card');
    } finally { ws.close(); }
  });

  test('a decline the schedule cannot answer ends it on attempt one and names who can', async () => {
    const ws = await workspace(MONDAY);
    try {
      const customer = await ws.customer('Ashcombe Automation');
      await ws.card(customer.id, 'authentication_required');
      const { invoice } = await ws.subscribe(customer.id);

      const [campaign] = await ws.dunning(customer.id);
      assert.equal(campaign.status, 'exhausted', 'an off-session retry can never satisfy an issuer asking for the cardholder');
      assert.equal(campaign.attempt_count, 1);
      assert.equal(campaign.attempts_remaining, 3, 'three retries were dropped rather than spent on an impossible outcome');
      assert.equal(campaign.next_attempt_at, null);
      assert.equal(campaign.last_failure_code, 'authentication_required');
      assert.equal(campaign.needs_human, true);
      assert.match(campaign.recommended_action, /off_session=false/, 'the advice names a call that exists');
      assert.match(campaign.recommended_action, /card that works/, 'and does not tell anyone to chase new details');

      const action = await ws.ok('GET', '/v1/events?type=invoice.payment_action_required&limit=20');
      const notice = (action.data as any[]).find((e) => e.data?.invoice === invoice.id);
      assert.ok(notice, 'the bank wanting the cardholder is its own event, not just another failure');
      assert.equal(notice.data.reason, 'authentication_required');
      assert.match(notice.data.resolution, new RegExp(`/v1/invoices/${invoice.id}/retry`));

      // Nothing further is queued: this schedule was abandoned, not paused.
      assert.equal(
        ws.app.ctx.db.count(
          `SELECT COUNT(*) FROM jobs WHERE type = 'payments.dunning_retry' AND status = 'pending' AND idem_key = ?`,
          `payments.dunning_retry:${campaign.id}`,
        ),
        0,
      );
      assert.equal((await ws.travel(60 * DAY)).failed, 0);
      assert.equal((await ws.dunning(customer.id))[0].attempt_count, 1, 'sixty days later it still has not been retried');
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
      assert.equal(campaign.status, 'exhausted');
      assert.equal(campaign.attempt_count, 1);
      assert.match(campaign.attempts[0].decision, /dropped/);
      assert.match(campaign.recommended_action, /re-enter the card/i);

      const settings = await ws.ok('GET', '/v1/payments/settings');
      const rows = settings.decline_codes as { code: string; retried: boolean }[];
      assert.equal(rows.find((row) => row.code === 'incorrect_cvc')?.retried, false);
      assert.equal(rows.find((row) => row.code === 'authentication_required')?.retried, false);
      assert.equal(rows.find((row) => row.code === 'insufficient_funds')?.retried, true, 'the declines worth retrying still are');
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

  test('a refund never re-opens the retry schedule', async () => {
    const customer = await ws.customer('Ashgrove Instruments');
    await ws.card(customer.id, 'succeeds');
    const { invoice } = await ws.subscribe(customer.id);
    await ws.ok('POST', '/v1/refunds', { invoice: invoice.id, reason: 'duplicate' });
    assert.equal((await ws.dunning(customer.id)).length, 0, 'giving money back is not a failed collection');
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
