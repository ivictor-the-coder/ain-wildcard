/**
 * The delivery spine, driven end to end.
 *
 * Everything here runs against the real path: a real event, a real endpoint,
 * a real job row with a `run_at`, and the transport seam at the edge. Nothing
 * reaches the network — the shipped transports record what they are handed and
 * answer from a rule set — which is exactly what makes the retry ladder, the
 * automatic disable and the payer's dunning notice observable in a test rather
 * than argued about in prose.
 *
 * Expected values are computed, never pasted: the retry ladder is asserted
 * against `DELIVERY_BACKOFF_MS` itself, the signature against an HMAC this file
 * computes from first principles, and money against `formatMoney` over the
 * invoice's own numbers.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createApp, frozenClock, type App } from '../src/server/app';
import { MODULES } from '../src/server/generated/registry';
import type { Auth } from '../src/server/kernel/http';
import type { ModuleDef } from '../src/server/kernel/module';
import { DAY, MINUTE } from '../src/shared/time';
import { formatMoney, money } from '../src/shared/money';
import notifications from '../src/server/modules/notifications/module';
import {
  DELIVERY_BACKOFF_MS, DISABLE_AFTER_FAILED_DELIVERIES, MAX_DELIVERY_ATTEMPTS, subscribes,
} from '../src/server/modules/notifications/store';
import { SIGNATURE_HEADER, parseSignature, signedPayload } from '../src/server/modules/notifications/signature';
import type { RecordedHttpTransport, RecordedMessageTransport } from '../src/server/modules/notifications/transport';
import type {
  NotificationMessage, WebhookDelivery, WebhookEndpoint, MintedWebhookEndpoint,
} from '../src/server/modules/notifications/types';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const T0 = Date.UTC(2026, 5, 8, 9, 0, 0);

/**
 * The module registry is regenerated centrally, so it may or may not already
 * carry this module. Either way the suite boots exactly one copy of it.
 */
const MODULE_SET: ModuleDef[] = MODULES.some((m) => m.name === 'notifications')
  ? MODULES
  : [...MODULES, notifications];

interface Workspace {
  app: App;
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  ok(method: string, path: string, body?: unknown): Promise<any>;
  fail(method: string, path: string, body: unknown, status: number, code?: string): Promise<any>;
  http: RecordedHttpTransport;
  mail: RecordedMessageTransport;
  now(): number;
  tick(): Promise<void>;
  travel(ms: number): Promise<{ ran: number; failed: number }>;
  endpoint(events: string[], url: string, answer?: { status: number; body?: string }): Promise<MintedWebhookEndpoint>;
  deliveriesFor(endpointId: string): Promise<WebhookDelivery[]>;
  close(): void;
}

let sink = 0;
/** A host of this test's own, so one test's rules never touch another's. */
const nextSink = (): string => `https://sink-${(sink += 1).toString(36)}.invalid/hook`;

async function workspace(at = T0): Promise<Workspace> {
  const app = await createApp({ db: 'memory', config: { env: 'test' }, clock: frozenClock(at), modules: MODULE_SET });
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, body, auth: DANA });
  const svc = app.ctx.svc.notifications;
  const http = svc.recordedHttp();
  const mail = svc.recordedMessages();
  assert.ok(http && mail, 'the shipped transports are the recorded ones — nothing here may reach the network');
  const ws: Workspace = {
    app,
    call,
    http,
    mail,
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
    travel: (ms) => app.travel(ms).then((r) => ({ ran: r.ran, failed: r.failed })),
    async endpoint(events, url, answer) {
      if (answer) http.respond(url, { status: answer.status, body: answer.body ?? '' });
      return ws.ok('POST', '/v1/webhook-endpoints', { url, enabled_events: events });
    },
    async deliveriesFor(endpointId) {
      const page = await ws.ok('GET', `/v1/webhook-deliveries?endpoint=${endpointId}&limit=200`);
      return page.data as WebhookDelivery[];
    },
    close: () => app.close(),
  };
  return ws;
}

/** Anything that makes an event — a real write, not a synthetic emit. */
let names = 0;
const makeCustomer = (ws: Workspace, over: Record<string, unknown> = {}) =>
  ws.ok('POST', '/v1/customers', {
    name: `Halstead Precision ${(names += 1).toString(36)}`,
    email: `ap+wh${names}@halstead.example`,
    currency: 'usd',
    ...over,
  });

/* ========================================================================== *
 * 1. Endpoints, and the secret that signs for them
 * ========================================================================== */

describe('registering an endpoint', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(); });
  after(() => ws.close());

  test('mints a signing secret, shows it once, and never again', async () => {
    const endpoint = await ws.endpoint(['customer.*'], nextSink());
    assert.match(endpoint.secret, /^whsec_/, 'the secret is minted at runtime with our own prefix');
    assert.ok(endpoint.secret.length > 20);
    assert.equal(endpoint.secret_last4, endpoint.secret.slice(-4));

    const read = await ws.ok('GET', `/v1/webhook-endpoints/${endpoint.id}`);
    assert.equal((read as Record<string, unknown>).secret, undefined, 'a later read never carries the secret');
    assert.equal(read.secret_last4, endpoint.secret_last4);

    const list = await ws.ok('GET', '/v1/webhook-endpoints');
    for (const row of list.data as Record<string, unknown>[]) {
      assert.equal(row.secret, undefined, 'nor does the list');
    }
  });

  test('publishes the retry ladder and the signature recipe on the endpoint itself', async () => {
    const endpoint = await ws.endpoint(['customer.*'], nextSink());
    assert.deepEqual(endpoint.retry_schedule_ms, DELIVERY_BACKOFF_MS);
    assert.equal(endpoint.max_attempts, MAX_DELIVERY_ATTEMPTS);
    assert.equal(endpoint.disable_after, DISABLE_AFTER_FAILED_DELIVERIES);
    assert.equal(endpoint.signature.header, SIGNATURE_HEADER);
    assert.equal(endpoint.signature.algorithm, 'hmac-sha256');
  });

  test('rolling the secret hands back a different one', async () => {
    const endpoint = await ws.endpoint(['customer.*'], nextSink());
    const rolled: MintedWebhookEndpoint = await ws.ok('POST', `/v1/webhook-endpoints/${endpoint.id}/roll-secret`);
    assert.notEqual(rolled.secret, endpoint.secret);
    assert.equal(rolled.secret_last4, rolled.secret.slice(-4));
  });

  test('refuses a selector that would silently match nothing', async () => {
    await ws.fail('POST', '/v1/webhook-endpoints', {
      url: nextSink(), enabled_events: ['*.paid'],
    }, 400, 'webhook_event_pattern_invalid');
  });
});

/* ========================================================================== *
 * 2. The fan-out: who gets what
 * ========================================================================== */

describe('the fan-out over the one event log', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(); });
  after(() => ws.close());

  test('delivers an event to every endpoint that selected its type, and to no other', async () => {
    const wanted = await ws.endpoint(['customer.*'], nextSink());
    const other = await ws.endpoint(['invoice.*'], nextSink());
    const customer = await makeCustomer(ws);

    const mine = await ws.deliveriesFor(wanted.id);
    const theirs = await ws.deliveriesFor(other.id);
    const forCustomer = mine.filter((d) => d.payload.data.object && (d.payload.data.object as { id?: string }).id === customer.id);
    assert.equal(forCustomer.length, 1, 'exactly one delivery, for the endpoint that asked for customer.*');
    assert.equal(forCustomer[0].event_type, 'customer.created');
    assert.equal(theirs.filter((d) => d.event_type === 'customer.created').length, 0, 'invoice.* wanted none of it');
  });

  test('an endpoint receives nothing that happened before it was registered', async () => {
    const customer = await makeCustomer(ws);
    const events = await ws.ok('GET', `/v1/events?object_id=${customer.id}&limit=10`);
    const created = (events.data as { id: string; type: string }[]).find((e) => e.type === 'customer.created');
    assert.ok(created, 'the write emitted the event this test is about');

    const late = await ws.endpoint(['customer.*'], nextSink());
    const deliveries = await ws.deliveriesFor(late.id);
    assert.equal(deliveries.length, 0, 'registering a URL does not replay the workspace history at it');
    // Nothing anywhere reads the log backwards for a new endpoint, which is
    // the whole mechanism — this fails the moment a backfill is added.
    assert.equal(
      ws.app.ctx.db.count(`SELECT COUNT(*) FROM notification_deliveries WHERE org_id = ? AND endpoint_id = ?`,
        ORG, late.id),
      0,
    );

    // And it does receive what happens next, so the rule is about history and
    // not about the endpoint being broken.
    await makeCustomer(ws);
    assert.equal((await ws.deliveriesFor(late.id)).length, 1);
  });

  test('the selector matcher takes exact types, trailing wildcards and everything', () => {
    assert.equal(subscribes(['invoice.*'], 'invoice.finalized'), true);
    assert.equal(subscribes(['invoice.*'], 'invoice_item.created'), false, 'the dot is part of the prefix');
    assert.equal(subscribes(['*'], 'anything.at.all'), true);
    assert.equal(subscribes(['invoice.paid'], 'invoice.finalized'), false);
  });
});

/* ========================================================================== *
 * 3. The signature — the half a consumer has to be able to check
 * ========================================================================== */

describe('signing a delivery the way Stripe signs one', () => {
  let ws: Workspace;
  let endpoint: MintedWebhookEndpoint;
  let body: string;
  let header: string;

  before(async () => {
    ws = await workspace();
    const url = nextSink();
    endpoint = await ws.endpoint(['customer.*'], url);
    await makeCustomer(ws);
    await ws.tick();
    const calls = ws.http.callsTo(url);
    assert.equal(calls.length, 1, 'one attempt, one request — through the seam and nowhere else');
    body = calls[0].request.body;
    header = calls[0].request.headers[SIGNATURE_HEADER];
  });
  after(() => ws.close());

  test('the header is an HMAC-SHA256 over "<t>.<raw body>" under the endpoint secret', () => {
    const parsed = parseSignature(header);
    assert.ok(parsed.timestamp, 'the header carries the instant it was signed');
    // Spelled out here rather than through the module's own helper: the point
    // of this assertion is the format a subscriber has to reproduce, and a
    // test that asks the code what it signed cannot notice the format changing.
    const expected = createHmac('sha256', endpoint.secret)
      .update(`${parsed.timestamp}.${body}`)
      .digest('hex');
    assert.deepEqual(parsed.signatures, [expected]);
    assert.equal(signedPayload(parsed.timestamp!, body), `${parsed.timestamp}.${body}`);
  });

  test('binds the instant, so one captured delivery cannot be replayed for ever', () => {
    const svc = ws.app.ctx.svc.notifications;
    const early = svc.signFor(ORG, endpoint.id, body, ws.now() - MINUTE);
    const later = svc.signFor(ORG, endpoint.id, body, ws.now());
    assert.notEqual(early.header, later.header, 'the same body signed a minute apart is a different signature');
    const check = svc.verifySignature(ORG, endpoint.id, body, early.header, MINUTE / 2);
    assert.equal(check.valid, false);
    assert.match(check.reason, /replay/);
  });

  test('the body signed is the body stored, byte for byte', async () => {
    const deliveries = await ws.deliveriesFor(endpoint.id);
    assert.equal(deliveries.length, 1);
    assert.deepEqual(JSON.parse(body), deliveries[0].payload, 'what was signed is what the record shows');
    assert.equal(deliveries[0].payload.object, 'event');
    assert.equal(deliveries[0].payload.type, 'customer.created');
  });

  test('the workspace can check a signature the way a subscriber must', async () => {
    const good = await ws.ok('POST', '/v1/webhook-signatures/verify', {
      endpoint: endpoint.id, payload: body, signature: header,
    });
    assert.equal(good.valid, true, good.reason);

    const tampered = await ws.ok('POST', '/v1/webhook-signatures/verify', {
      endpoint: endpoint.id, payload: `${body} `, signature: header,
    });
    assert.equal(tampered.valid, false);
    assert.match(tampered.reason, /No signature in the header matches/);

    // A genuine signature that is simply too old is a replay, and must not be
    // reported as a forgery — the two send an integrator to different places.
    const old = ws.app.ctx.svc.notifications.signFor(ORG, endpoint.id, body, ws.now() - 10 * MINUTE);
    const stale = await ws.ok('POST', '/v1/webhook-signatures/verify', {
      endpoint: endpoint.id, payload: body, signature: old.header,
    });
    assert.equal(stale.valid, false);
    assert.match(stale.reason, /replay/);
    assert.notEqual(stale.expected, null, 'and it says what the signature should have been');
  });

  test('a signature from another endpoint’s secret does not verify', async () => {
    const stranger = await ws.endpoint(['customer.*'], nextSink());
    const check = await ws.ok('POST', '/v1/webhook-signatures/verify', {
      endpoint: stranger.id, payload: body, signature: header,
    });
    assert.equal(check.valid, false);
  });
});

/* ========================================================================== *
 * 4. The retry ladder, replayed by the workspace clock
 * ========================================================================== */

describe('a subscriber that is refusing', () => {
  test('retries on exactly the ladder the endpoint publishes, and then gives up', async () => {
    const ws = await workspace();
    try {
      const url = nextSink();
      const endpoint = await ws.endpoint(['customer.*'], url, { status: 500, body: 'upstream is down' });
      await makeCustomer(ws);
      await ws.tick();

      let [delivery] = await ws.deliveriesFor(endpoint.id);
      assert.equal(delivery.status, 'pending', 'one failure is not a lost event');
      assert.equal(delivery.attempt_count, 1);
      assert.equal(delivery.next_attempt_at, ws.now() + DELIVERY_BACKOFF_MS[0]);

      // Walk the whole ladder. Every wait is a job row with a run_at, so this
      // is the day and a half a real subscriber would have had.
      await ws.travel(DELIVERY_BACKOFF_MS.reduce((a, b) => a + b, 0) + MINUTE);

      const detail: WebhookDelivery = await ws.ok('GET', `/v1/webhook-deliveries/${delivery.id}`);
      assert.equal(detail.status, 'failed');
      assert.equal(detail.attempt_count, MAX_DELIVERY_ATTEMPTS);
      assert.equal(detail.attempts!.length, MAX_DELIVERY_ATTEMPTS);

      // The gap between consecutive attempts is the published schedule.
      const gaps = detail.attempts!.slice(1).map((a, i) => a.at - detail.attempts![i].at);
      assert.deepEqual(gaps, DELIVERY_BACKOFF_MS, 'the ladder that ran is the ladder that was published');
      for (const attempt of detail.attempts!) {
        assert.equal(attempt.status, 'failed');
        assert.equal(attempt.response_status, 500);
        assert.equal(attempt.response_body, 'upstream is down', 'what the subscriber said is kept, per attempt');
        assert.ok(attempt.signature.startsWith('t='), 'each attempt records the signature it went out under');
      }
      assert.equal(detail.attempts![MAX_DELIVERY_ATTEMPTS - 1].next_attempt_at, null, 'the last rung schedules nothing');
      // Counted by delivery id, because a day and a half of workspace clock
      // moves other business too, and this endpoint asked for all of it.
      const mine = ws.http.callsTo(url).filter((c) => c.request.headers['ain-delivery-id'] === delivery.id);
      assert.equal(mine.length, MAX_DELIVERY_ATTEMPTS, 'every attempt crossed the seam exactly once');
    } finally { ws.close(); }
  });

  test('an operator retry adds exactly one attempt, and keeps the history', async () => {
    const ws = await workspace();
    try {
      const url = nextSink();
      const endpoint = await ws.endpoint(['customer.*'], url, { status: 503 });
      await makeCustomer(ws);
      // Held from before the travel: the clock moves the rest of the business
      // too, and this endpoint subscribes to all of it.
      const [queued] = await ws.deliveriesFor(endpoint.id);
      await ws.travel(DELIVERY_BACKOFF_MS.reduce((a, b) => a + b, 0) + MINUTE);
      const failed: WebhookDelivery = await ws.ok('GET', `/v1/webhook-deliveries/${queued.id}`);
      assert.equal(failed.status, 'failed');

      ws.http.respond(url, { status: 200, body: '{"ok":true}' });
      await ws.ok('POST', `/v1/webhook-deliveries/${failed.id}/retry`);
      await ws.tick();

      const after: WebhookDelivery = await ws.ok('GET', `/v1/webhook-deliveries/${failed.id}`);
      assert.equal(after.status, 'succeeded');
      assert.equal(after.attempt_count, MAX_DELIVERY_ATTEMPTS + 1, 'the attempts already made stay on the record');
      assert.equal(after.attempts!.length, MAX_DELIVERY_ATTEMPTS + 1);
      await ws.fail('POST', `/v1/webhook-deliveries/${failed.id}/retry`, {}, 409, 'webhook_delivery_succeeded');
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 5. A dead endpoint takes itself out of service
 * ========================================================================== */

describe('an endpoint that has gone', () => {
  test('is disabled with a reason once enough deliveries have used up every attempt', async () => {
    const ws = await workspace();
    try {
      const url = nextSink();
      const endpoint = await ws.endpoint(['customer.*'], url, { status: 410, body: 'gone' });
      for (let i = 0; i < DISABLE_AFTER_FAILED_DELIVERIES; i++) await makeCustomer(ws);
      assert.equal((await ws.deliveriesFor(endpoint.id)).length, DISABLE_AFTER_FAILED_DELIVERIES);

      const ladder = DELIVERY_BACKOFF_MS.reduce((a, b) => a + b, 0);
      await ws.travel(ladder + MINUTE);

      const after: WebhookEndpoint = await ws.ok('GET', `/v1/webhook-endpoints/${endpoint.id}`);
      assert.equal(after.status, 'disabled');
      assert.equal(after.consecutive_failures, DISABLE_AFTER_FAILED_DELIVERIES);
      assert.ok(after.disabled_reason, 'a disabled endpoint says why');
      assert.match(after.disabled_reason!, new RegExp(`${DISABLE_AFTER_FAILED_DELIVERIES} deliveries in a row`));
      assert.match(after.disabled_reason!, /410/, 'and names what the subscriber last said');

      // Nothing more is presented to it: the count of requests stops dead.
      const before = ws.http.callsTo(url).length;
      await makeCustomer(ws);
      await ws.travel(2 * DAY);
      assert.equal(ws.http.callsTo(url).length, before, 'a disabled endpoint is not retried, and receives nothing new');
      assert.equal(
        ws.app.ctx.db.count(
          `SELECT COUNT(*) FROM jobs WHERE org_id = ? AND type = 'notifications.deliver' AND status = 'pending'`, ORG),
        0,
        'and its queued work was cancelled rather than left to churn',
      );
    } finally { ws.close(); }
  });

  test('enabling it again clears the count, so one blip does not kill it a second time', async () => {
    const ws = await workspace();
    try {
      const url = nextSink();
      const endpoint = await ws.endpoint(['customer.*'], url, { status: 500 });
      for (let i = 0; i < DISABLE_AFTER_FAILED_DELIVERIES; i++) await makeCustomer(ws);
      await ws.travel(DELIVERY_BACKOFF_MS.reduce((a, b) => a + b, 0) + MINUTE);
      assert.equal((await ws.ok('GET', `/v1/webhook-endpoints/${endpoint.id}`)).status, 'disabled');

      ws.http.respond(url, { status: 200 });
      const revived: WebhookEndpoint = await ws.ok('PATCH', `/v1/webhook-endpoints/${endpoint.id}`, { status: 'enabled' });
      assert.equal(revived.status, 'enabled');
      assert.equal(revived.consecutive_failures, 0);
      assert.equal(revived.disabled_reason, null);

      await makeCustomer(ws);
      await ws.tick();
      const succeeded = (await ws.deliveriesFor(endpoint.id)).filter((d) => d.status === 'succeeded');
      assert.equal(succeeded.length, 1, 'and it is delivering again');
    } finally { ws.close(); }
  });

  test('a success clears the failure count before the endpoint reaches the limit', async () => {
    const ws = await workspace();
    try {
      const url = nextSink();
      const endpoint = await ws.endpoint(['customer.*'], url, { status: 500 });
      await makeCustomer(ws);
      await ws.travel(DELIVERY_BACKOFF_MS.reduce((a, b) => a + b, 0) + MINUTE);
      assert.equal((await ws.ok('GET', `/v1/webhook-endpoints/${endpoint.id}`)).consecutive_failures, 1);

      ws.http.respond(url, { status: 204 });
      await makeCustomer(ws);
      await ws.tick();
      const after: WebhookEndpoint = await ws.ok('GET', `/v1/webhook-endpoints/${endpoint.id}`);
      assert.equal(after.consecutive_failures, 0, 'a flaky subscriber is not a dead one');
      assert.equal(after.status, 'enabled');
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 6. "Sent" becomes a fact — the shipped copy was a claim
 * ========================================================================== */

describe('finalising an invoice sends it', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(); });
  after(() => ws.close());

  test('produces a delivery record with a recipient, an instant and the body as sent', async () => {
    const customer = await makeCustomer(ws);
    const invoice = await ws.ok('POST', '/v1/invoices', {
      customer: customer.id,
      items: [{ description: 'Onboarding', amount: 250_00, currency: 'usd' }],
      auto_advance: true,
    });
    assert.equal(invoice.status, 'open', 'the bill was finalised');

    const page = await ws.ok('GET', `/v1/notifications?related=${invoice.id}`);
    const notices = page.data as NotificationMessage[];
    assert.equal(notices.length, 1, 'finalising sent exactly one notice');
    const notice = notices[0];
    assert.equal(notice.kind, 'invoice.issued');
    assert.equal(notice.status, 'sent');
    assert.equal(notice.to, customer.email);
    assert.equal(notice.customer, customer.id);
    assert.deepEqual(notice.related, { type: 'invoice', id: invoice.id });
    assert.ok(notice.sent_at, 'a send has an instant');

    // The message really went through the transport seam.
    const outbox = ws.mail.to(customer.email);
    assert.equal(outbox.length, 1);
    assert.match(outbox[0].message.subject!, new RegExp(invoice.number));
    const amount = formatMoney(money(invoice.amount_due, invoice.currency), { locale: 'en-US' });
    assert.match(outbox[0].message.text, new RegExp(amount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the body quotes the amount the bill itself asks for');

    // And the body is kept as sent, not re-rendered later from a template.
    const full = await ws.ok('GET', `/v1/notifications/${notice.id}`);
    assert.equal(full.body_text, outbox[0].message.text);
    assert.equal(full.body_html, outbox[0].message.html);
  });

  test('does not send the same bill twice, and says so by handing back the first record', async () => {
    const customer = await makeCustomer(ws);
    const invoice = await ws.ok('POST', '/v1/invoices', {
      customer: customer.id, items: [{ description: 'Retainer', amount: 100_00, currency: 'usd' }], auto_advance: true,
    });
    const first = (await ws.ok('GET', `/v1/notifications?related=${invoice.id}`)).data[0];
    const again: NotificationMessage = await ws.ok('POST', '/v1/notifications/invoice', { invoice: invoice.id });
    assert.equal(again.id, first.id, 'the second caller gets the record of the first send');
    assert.equal((await ws.ok('GET', `/v1/notifications?related=${invoice.id}`)).data.length, 1);

    const forced: NotificationMessage = await ws.ok('POST', '/v1/notifications/invoice', { invoice: invoice.id, force: true });
    assert.notEqual(forced.id, first.id, 'a resend is deliberate, and is its own record');
    assert.equal((await ws.ok('GET', `/v1/notifications?related=${invoice.id}`)).data.length, 2);
  });

  test('an account with no billing address produces a suppressed record naming it, never a claimed send', async () => {
    const customer = await makeCustomer(ws, { email: undefined });
    assert.equal(customer.email, null, 'this account has nowhere to send to');
    const invoice = await ws.ok('POST', '/v1/invoices', {
      customer: customer.id, items: [{ description: 'Site survey', amount: 400_00, currency: 'usd' }], auto_advance: true,
    });

    const notices = (await ws.ok('GET', `/v1/notifications?related=${invoice.id}`)).data as NotificationMessage[];
    assert.equal(notices.length, 1);
    assert.equal(notices[0].status, 'suppressed');
    assert.equal(notices[0].to, null);
    assert.match(notices[0].failed_reason!, new RegExp(customer.name));
    assert.match(notices[0].detail, /has not been sent to anyone/);
    assert.equal(ws.mail.to(customer.name).length, 0, 'nothing was handed to the transport');

    // With an address, the same notice can be sent — and it is a new record.
    const sent: NotificationMessage = await ws.ok('POST', `/v1/notifications/${notices[0].id}/resend`, {
      to: 'ap@brookes-metal.example',
    });
    assert.equal(sent.status, 'sent');
    assert.notEqual(sent.id, notices[0].id);
  });

  test('paying the bill sends a receipt, addressed to the same account', async () => {
    const customer = await makeCustomer(ws);
    await ws.ok('POST', '/v1/payment_methods', {
      type: 'card', customer: customer.id, brand: 'visa', exp_month: 4, exp_year: 2031, simulated_behavior: 'succeeds',
    });
    const invoice = await ws.ok('POST', '/v1/invoices', {
      customer: customer.id, items: [{ description: 'Spares', amount: 90_00, currency: 'usd' }], auto_advance: true,
    });
    await ws.ok('POST', `/v1/invoices/${invoice.id}/pay`, {});
    const kinds = ((await ws.ok('GET', `/v1/notifications?related=${invoice.id}`)).data as NotificationMessage[])
      .map((n) => n.kind).sort();
    assert.deepEqual(kinds, ['invoice.issued', 'invoice.receipt']);
  });
});

/* ========================================================================== *
 * 7. Dunning tells the payer
 * ========================================================================== */

describe('dunning', () => {
  test('tells the payer every time the card is refused, and what happens next', async () => {
    const ws = await workspace();
    try {
      const customer = await makeCustomer(ws);
      await ws.ok('POST', '/v1/payment_methods', {
        type: 'card', customer: customer.id, brand: 'visa', exp_month: 4, exp_year: 2031,
        simulated_behavior: 'insufficient_funds',
      });
      const sub = await ws.ok('POST', '/v1/subscriptions', { customer: customer.id, items: [{ price: 'growth_monthly' }] });
      await ws.tick();

      const campaigns = (await ws.ok('GET', `/v1/dunning?status=all&customer=${customer.id}`)).data as any[];
      assert.equal(campaigns.length, 1, 'the first presentation was refused, so a campaign opened');
      const campaign = campaigns[0];

      const first = ((await ws.ok('GET', `/v1/notifications?kind=dunning.payment_failed&customer=${customer.id}`))
        .data as NotificationMessage[]);
      assert.equal(first.length, 1, 'the payer was told on the first refusal');
      assert.equal(first[0].to, customer.email);
      assert.equal(first[0].status, 'sent');
      const body = (await ws.ok('GET', `/v1/notifications/${first[0].id}`)).body_text as string;
      assert.match(body, /try the same card again/, 'and told when the next attempt is');

      // Walk the whole schedule. Every retry the campaign records must have a
      // notice against it: this is the defect — three retries, no word to the payer.
      await ws.travel(30 * DAY);
      const settled = (await ws.ok('GET', `/v1/dunning/${campaign.id}`));
      const notices = ((await ws.ok('GET', `/v1/notifications?kind=dunning.payment_failed&customer=${customer.id}&limit=100`))
        .data as NotificationMessage[]);
      assert.equal(notices.length, settled.attempt_count,
        'one notice per refused attempt — the retry ladder is not silent');

      const finals = ((await ws.ok('GET', `/v1/notifications?kind=dunning.final_notice&customer=${customer.id}`))
        .data as NotificationMessage[]);
      assert.equal(settled.status, 'exhausted', 'the schedule ran out');
      assert.equal(finals.length, 1, 'and the payer was told it had');
      assert.match((await ws.ok('GET', `/v1/notifications/${finals[0].id}`)).body_text, /still unpaid/);
      assert.ok(sub.id);
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 8. The recipient's own copy — the one page that needs no session
 * ========================================================================== */

describe('the hosted copy of a notice', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(); });
  after(() => ws.close());

  test('serves the exact bytes that were sent, to whoever holds the link', async () => {
    const customer = await makeCustomer(ws);
    const invoice = await ws.ok('POST', '/v1/invoices', {
      customer: customer.id, items: [{ description: 'Calibration', amount: 320_00, currency: 'usd' }], auto_advance: true,
    });
    const notice = (await ws.ok('GET', `/v1/notifications?related=${invoice.id}`)).data[0] as NotificationMessage;
    assert.ok(notice.hosted_url, 'a sent email carries a link its recipient can open');

    // The link the customer actually clicks is the one in the letter, and it
    // has to be the token that was stored: minting a second one inside `send`
    // put a dead 404 behind the "View invoice" button of every email.
    const full = await ws.ok('GET', `/v1/notifications/${notice.id}`);
    assert.ok((full.body_html as string).includes(notice.hosted_url!),
      'the link in the body is the link on the record');
    assert.ok((full.body_text as string).includes(notice.hosted_url!));

    const path = notice.hosted_url!.slice(notice.hosted_url!.indexOf('/v1/'));
    // No session, no key, no auth argument at all — this is the reader's view.
    const res = await ws.app.handle({ method: 'GET', path });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body as string, new RegExp(invoice.number));
    assert.equal(res.body, (await ws.ok('GET', `/v1/notifications/${notice.id}`)).body_html);

    const seen = await ws.ok('GET', `/v1/notifications/${notice.id}`);
    assert.equal(seen.views, 1, 'and the read is recorded on the message');
    assert.ok(seen.first_viewed_at);
    await ws.app.handle({ method: 'GET', path });
    assert.equal((await ws.ok('GET', `/v1/notifications/${notice.id}`)).views, 2);
  });

  test('a token nobody minted is not a page', async () => {
    const res = await ws.app.handle({ method: 'GET', path: '/v1/notifications/hosted/nhl_nothing_here' });
    assert.equal(res.status, 404);
  });
});

/* ========================================================================== *
 * 9. What Settings › Events offers to show
 * ========================================================================== */

describe('the envelope Settings › Events promises', () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(); });
  after(() => ws.close());

  test('is the Stripe-shaped envelope, with the real deliveries of that event under it', async () => {
    const url = nextSink();
    const endpoint = await ws.endpoint(['customer.*'], url);
    const customer = await makeCustomer(ws);
    await ws.tick();

    const events = await ws.ok('GET', `/v1/events?object_id=${customer.id}&limit=10`);
    const event = (events.data as any[]).find((e) => e.type === 'customer.created');
    const preview = await ws.ok('GET', `/v1/events/${event.id}/webhook-payload`);

    assert.equal(preview.payload.id, event.id);
    assert.equal(preview.payload.object, 'event');
    assert.equal(preview.payload.type, 'customer.created');
    assert.deepEqual(preview.payload.data.object, event.data, 'the object is under data.object, where Stripe puts it');
    assert.equal(preview.payload.data.previous_attributes, event.previous);
    assert.equal(preview.signature.header, SIGNATURE_HEADER);

    const mine = (preview.deliveries as WebhookDelivery[]).filter((d) => d.endpoint === endpoint.id);
    assert.equal(mine.length, 1, 'the screen shows a real delivery, not a description of one');
    assert.equal(mine[0].status, 'succeeded');
    assert.ok(mine[0].attempts?.length, 'with the attempts under it');
    assert.equal(mine[0].attempts![0].response_status, 200);
    assert.ok(preview.subscribed_endpoints.some((e: { id: string }) => e.id === endpoint.id));
  });

  test('says which of the two reasons there is no delivery, rather than implying one', async () => {
    const events = await ws.ok('GET', '/v1/events?type=entitlements.recomputed&limit=1');
    const event = (events.data as any[])[0];
    assert.ok(event, 'the seeded workspace emits this type');
    const preview = await ws.ok('GET', `/v1/events/${event.id}/webhook-payload`);
    assert.equal(preview.deliveries.length, 0);
    assert.match(preview.detail, /Nothing is subscribed to this type|registered after this event/);
  });

  test('the screen reads that route, and shows the endpoints and their deliveries', () => {
    const file = readFileSync('src/client/modules/settings/events.tsx', 'utf8');
    // The comments quote the defect, so the scan below reads the code alone.
    const screen = file.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.match(screen, /\/webhook-payload/, 'the payload card asks the server for the envelope');
    assert.match(screen, /'\/v1\/webhook-endpoints'/, 'and the screen lists the real subscribers');
    assert.match(screen, /preview\.deliveries\.map/, 'each delivery of the selected event is rendered');
    assert.match(screen, /attempt\.summary/, 'with what happened on each attempt');
    // The promise this screen used to make over `event.data` alone.
    assert.ok(
      !/exactly what a webhook would receive/.test(screen),
      'the old offer is gone, because the screen now shows the envelope itself',
    );
    // And the actor rules it already kept must survive the rewrite.
    assert.match(screen, /seatsFromStream\(/);
    assert.match(screen, /useActorName\(\{ seats \}\)/);
    assert.match(screen, /actor\.isId/);
  });
});

/* ========================================================================== *
 * 10. The seam itself
 * ========================================================================== */

describe('the transport seam', () => {
  test('is the only way out, and the shipped implementations never leave the process', () => {
    const dir = 'src/server/modules/notifications';
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/\bfetch\s*\(/.test(source), `${file} must not call fetch — the transport is the seam`);
      assert.ok(!/require\(['"]node:https?['"]\)|from ['"]node:https?['"]/.test(source),
        `${file} must not open a socket of its own`);
    }
  });

  test('accounts for every attempt ever made, so a test can assert on what left', async () => {
    const ws = await workspace();
    try {
      const url = nextSink();
      const endpoint = await ws.endpoint(['customer.*'], url);
      await makeCustomer(ws);
      await makeCustomer(ws);
      await ws.tick();
      const deliveries = await ws.deliveriesFor(endpoint.id);
      const attempts = deliveries.reduce((n, d) => n + d.attempt_count, 0);
      assert.equal(ws.http.callsTo(url).length, attempts);
      assert.equal(ws.app.ctx.svc.notifications.httpTransport().name, 'recorded');
      assert.equal(ws.app.ctx.svc.notifications.messageTransport().name, 'recorded');
    } finally { ws.close(); }
  });

  test('can be replaced, and then everything goes through the replacement', async () => {
    const ws = await workspace();
    try {
      const seen: string[] = [];
      ws.app.ctx.svc.notifications.useHttpTransport({
        name: 'test-double',
        send: (request) => {
          seen.push(request.url);
          return { status: 202, body: '', headers: {}, duration_ms: 3 };
        },
      });
      const url = nextSink();
      const endpoint = await ws.endpoint(['customer.*'], url);
      await makeCustomer(ws);
      await ws.tick();
      assert.equal(seen.filter((u) => u === url).length, 1, 'the installed transport received the delivery');
      const [delivery] = await ws.deliveriesFor(endpoint.id);
      assert.equal(delivery.status, 'succeeded');
      assert.equal(delivery.last_status_code, 202);
      assert.equal(ws.http.callsTo(url).length, 0, 'and the recorded one saw nothing');
    } finally { ws.close(); }
  });

  test('records a refused connection as an attempt with no status, not as an answer', async () => {
    const ws = await workspace();
    try {
      const url = nextSink();
      ws.http.refuse(url, 'ECONNREFUSED 10.0.0.4:443');
      const endpoint = await ws.endpoint(['customer.*'], url);
      await makeCustomer(ws);
      await ws.tick();
      const [delivery] = await ws.deliveriesFor(endpoint.id);
      const full: WebhookDelivery = await ws.ok('GET', `/v1/webhook-deliveries/${delivery.id}`);
      assert.equal(full.last_status_code, null, '"no answer" is not "answered 0"');
      assert.match(full.attempts![0].error!, /ECONNREFUSED/);
      assert.equal(full.status, 'pending', 'and it is still on the ladder');
    } finally { ws.close(); }
  });
});

/* ========================================================================== *
 * 11. History is not activity
 * ========================================================================== */

describe('switching notifications on', () => {
  test('never notifies retroactively — the seeded years of invoices are not emailed', async () => {
    const ws = await workspace();
    try {
      const settings = await ws.ok('GET', '/v1/notification-settings');
      const finalised = ws.app.ctx.db.count(
        `SELECT COUNT(*) FROM events WHERE org_id = ? AND type = 'invoice.finalized' AND created < ?`,
        ORG, settings.enabled_since);
      assert.ok(finalised > 100, 'the demo workspace really does seed hundreds of finalised bills');

      const sent = ws.app.ctx.db.count(
        `SELECT COUNT(*) FROM notification_messages WHERE org_id = ? AND kind = 'invoice.issued'`, ORG);
      const open = ws.app.ctx.db.count(
        `SELECT COUNT(*) FROM billing_invoices WHERE org_id = ? AND status = 'open'`, ORG);
      assert.equal(sent, open,
        'only the bills still owed were sent — a bill nobody is chasing is history, not an email');
    } finally { ws.close(); }
  });

  test('the overview counts what left and names the transports it left through', async () => {
    const ws = await workspace();
    try {
      await ws.tick();
      const overview = await ws.ok('GET', '/v1/notifications/overview');
      assert.equal(overview.transports.http, 'recorded');
      assert.equal(overview.transports.message, 'recorded');
      assert.ok(overview.endpoints.total >= 2, 'the demo workspace ships with subscribers');
      const settled = overview.deliveries.succeeded + overview.deliveries.failed;
      assert.equal(
        overview.deliveries.success_rate,
        settled ? Math.round((overview.deliveries.succeeded / settled) * 1000) / 10 : null,
      );
      assert.equal(
        overview.messages.sent,
        ws.app.ctx.db.count(`SELECT COUNT(*) FROM notification_messages WHERE org_id = ? AND status = 'sent'`, ORG),
      );
    } finally { ws.close(); }
  });
});
