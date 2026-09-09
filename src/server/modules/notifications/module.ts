/**
 * The delivery spine.
 *
 * Until this module existed, nothing ever left the building. An invoice's
 * status line said "Finalise it to send it" and finalising sent nothing;
 * Settings › Events offered to show "exactly what a webhook would receive"
 * with no webhook, no endpoint and no delivery behind the offer; dunning
 * retried a card on days 3, 5 and 7 and told the payer nothing.
 *
 * The architecture already had everything this needs. One event log feeds
 * every reader, so a webhook subscription is a filter over it. Deferred work
 * is a row in `jobs` with a `run_at`, so a delivery and its retry ladder
 * replay under `POST /v1/time/advance` exactly as they would in life. What was
 * missing was the seam at the edge — and a record, so that "sent" is a row
 * with a timestamp and a recipient rather than a sentence in a status line.
 *
 * Nothing here reaches the network. The two transports are interfaces; the
 * shipped implementations record what they were handed and answer from a rule
 * set, which is what makes the whole spine drivable in a test and in the demo.
 */
import { defineModule } from '../../kernel/module';
import type { Ctx } from '../../kernel/context';
import type { AinEvent } from '../../kernel/events';
import { created, list, noContent, status as httpStatus, type Req } from '../../kernel/http';
import { notFound } from '../../../shared/errors';
import v from '../../../shared/validate';
import { NOTIFICATIONS_MIGRATIONS } from './schema';
import { seedNotifications } from './seed';
import { RETRY_POLICY, notificationsStore, subscribes, webhookPayload, type WriteMeta } from './store';
import { SIGNATURE_HEADER, signatureRecipe, type SignatureCheck } from './signature';
import type {
  HttpTransport, MessageTransport, RecordedHttpTransport, RecordedMessageTransport,
} from './transport';
import type { DunningFacts } from './compose';
import {
  DELIVERY_STATUSES, ENDPOINT_STATUSES, MESSAGE_CHANNELS, MESSAGE_STATUSES, SUPPRESSION_REASONS,
  type DeliveryListFilter, type DunningNoticeKind, type EndpointInput, type EndpointPatch,
  type MessageChannel, type MessageListFilter,
  type MintedWebhookEndpoint, type NotificationMessage,
  type NotificationSettings, type NotificationsOverview, type SendInput,
  type SuppressedAddress, type SuppressionInput, type SuppressionListFilter,
  type WebhookDelivery, type WebhookEndpoint,
} from './types';

/* --------------------------------- service -------------------------------- */

/**
 * What the rest of the platform needs from the delivery spine.
 *
 * Two methods are the ones other modules should reach for. `sendInvoice` is
 * how a finalised bill actually reaches the person who owes it, and it is
 * idempotent by (invoice, kind) so two callers cannot email one bill twice.
 * `lastSent` is how a status line stops guessing: it returns the delivery
 * record — recipient, instant, transport — or null, which is itself the
 * honest answer that nothing has been sent.
 */
export interface NotificationsService {
  /** The record other modules point at instead of claiming a send. */
  send(orgId: string, input: SendInput, meta?: WriteMeta): NotificationMessage;
  messages(orgId: string, filter?: MessageListFilter): NotificationMessage[];
  message(orgId: string, id: string): NotificationMessage | null;
  /** The most recent notice of a kind about one object, or null. */
  lastSent(orgId: string, relatedId: string, kind?: string): NotificationMessage | null;

  /** Email a finalised invoice to the account that owes it. Idempotent. */
  sendInvoice(orgId: string, invoiceId: string, opts?: { kind?: 'invoice.issued' | 'invoice.receipt'; force?: boolean; to?: string | null }, meta?: WriteMeta): NotificationMessage | null;
  /**
   * Tell the payer what a recovery campaign just decided — a refusal with a
   * retry behind it, a card that has to be replaced, a schedule that ran out,
   * or the money arriving. Called by `payments` from its own job handler, one
   * notice per decision.
   */
  sendDunningNotice(orgId: string, input: {
    invoiceId: string; customerId: string; facts: DunningFacts; kind: DunningNoticeKind;
    deadline?: number | null; collectedAt?: number | null; resolution?: string | null;
    metadata?: Record<string, string>;
  }, meta?: WriteMeta): NotificationMessage | null;

  /** The addresses this workspace has stopped writing to, and why. */
  suppressions(orgId: string, filter?: SuppressionListFilter): SuppressedAddress[];
  /** Stop writing to an address. Idempotent, and never demotes a manual entry. */
  suppress(orgId: string, input: SuppressionInput, meta?: WriteMeta): SuppressedAddress;
  /** Is this address writable? The answer `send` gives itself before it sends. */
  isSuppressed(orgId: string, address: string, channel?: MessageChannel): SuppressedAddress | null;

  endpoints(orgId: string, filter?: { status?: string }): WebhookEndpoint[];
  endpoint(orgId: string, id: string): WebhookEndpoint | null;
  deliveries(orgId: string, filter?: DeliveryListFilter): WebhookDelivery[];
  delivery(orgId: string, id: string): WebhookDelivery | null;

  settings(orgId: string): NotificationSettings;

  /** The seam. Swap either transport at boot; the recorded ones are the default. */
  useHttpTransport(transport: HttpTransport): void;
  useMessageTransport(transport: MessageTransport): void;
  httpTransport(): HttpTransport;
  messageTransport(): MessageTransport;
  recordedHttp(): RecordedHttpTransport | null;
  recordedMessages(): RecordedMessageTransport | null;

  /** Sign and verify exactly the way a delivery does. */
  signFor(orgId: string, endpointId: string, payload: string, at?: number): { header: string; timestamp: number };
  verifySignature(orgId: string, endpointId: string, payload: string, header: string, toleranceMs?: number): SignatureCheck;
}

declare module '../../kernel/services' {
  interface ServiceRegistry { notifications: NotificationsService }
}

export { notificationsStore };
export type { HttpTransport, MessageTransport } from './transport';

const writeMeta = (req: Req): WriteMeta => ({
  actorId: req.auth.userId ?? req.auth.keyId ?? null,
  actorType: (req.auth.kind === 'api_key' ? 'api_key' : req.auth.kind === 'system' ? 'system' : 'user') as
    'user' | 'api_key' | 'system',
  requestId: req.requestId,
  livemode: req.auth.livemode,
});

/** Re-read an already-validated query string with its own schema's types. */
const queryOf = <T>(req: Req, schema: { parse(value: unknown): T }): T => schema.parse(req.query);

/* ------------------------------- validators ------------------------------- */

const eventSelector = v.string({ min: 1, max: 120, description: 'An exact type, a trailing wildcard like "invoice.*", or "*".' });

const endpointBody = v.object({
  url: v.url(),
  description: v.optional(v.string({ max: 500 })),
  enabled_events: v.optional(v.array(eventSelector, { min: 1, max: 200 })),
  status: v.optional(v.enum(ENDPOINT_STATUSES)),
  metadata: v.metadata(),
});

const endpointPatchBody = v.object({
  url: v.optional(v.url()),
  description: v.optional(v.nullable(v.string({ max: 500 }))),
  enabled_events: v.optional(v.array(eventSelector, { min: 1, max: 200 })),
  status: v.optional(v.enum(ENDPOINT_STATUSES)),
  metadata: v.metadata(),
});

const endpointsQuery = v.object({ status: v.optional(v.enum(ENDPOINT_STATUSES)) });

const deliveriesQuery = v.object({
  endpoint: v.optional(v.id('wh')),
  status: v.optional(v.enum(DELIVERY_STATUSES)),
  event: v.optional(v.id('evt')),
  event_type: v.optional(v.string({ max: 120 })),
  limit: v.default(v.int({ min: 1, max: 500 }), 50),
});

const messagesQuery = v.object({
  channel: v.optional(v.enum(MESSAGE_CHANNELS)),
  status: v.optional(v.enum(MESSAGE_STATUSES)),
  kind: v.optional(v.string({ max: 80 })),
  customer: v.optional(v.id('cus')),
  related: v.optional(v.string({ max: 120 })),
  limit: v.default(v.int({ min: 1, max: 500 }), 50),
});

const settingsPatchBody = v.object({
  from_name: v.optional(v.string({ min: 1, max: 120 })),
  from_email: v.optional(v.email()),
  reply_to: v.optional(v.nullable(v.email())),
});

const resendBody = v.object({ to: v.optional(v.nullable(v.email())) });

const verifyBody = v.object({
  endpoint: v.id('wh'),
  payload: v.string({ min: 1, max: 200_000, trim: false, description: 'The raw request body, byte for byte.' }),
  signature: v.string({ min: 1, max: 500, description: `The ${SIGNATURE_HEADER} header as it arrived.` }),
  tolerance_ms: v.optional(v.int({ min: 0, max: 86_400_000 })),
});

const suppressionsQuery = v.object({
  channel: v.optional(v.enum(MESSAGE_CHANNELS)),
  reason: v.optional(v.enum(SUPPRESSION_REASONS)),
  address: v.optional(v.string({ max: 320 })),
  limit: v.default(v.int({ min: 1, max: 500 }), 50),
});

// No `channel`: every notice this platform composes is email, and offering to
// suppress an "sms" channel that nothing writes to would be an API promising a
// feature. The column exists for when one does.
const suppressionBody = v.object({
  address: v.email(),
  reason: v.optional(v.enum(SUPPRESSION_REASONS)),
  detail: v.optional(v.string({ min: 1, max: 500 })),
});

const sendInvoiceBody = v.object({
  invoice: v.id('in'),
  kind: v.default(v.enum(['invoice.issued', 'invoice.receipt'] as const), 'invoice.issued'),
  to: v.optional(v.nullable(v.email())),
  force: v.optional(v.boolean()),
});

/* --------------------------------- module --------------------------------- */

export default defineModule({
  name: 'notifications',
  title: 'Webhooks & notifications',
  description: 'The delivery spine: signed webhook endpoints with a published retry ladder, and a delivery record for every notice sent to a customer — so "sent" is a row with a timestamp, not a claim in a status line.',
  /**
   * `payments` is here for the seed order, not for a service call. Seeding
   * writes Northwind's dunning history, and this module's own seed is what
   * switches notices on — so payments has to have finished writing those
   * campaigns before that line is drawn, or the demo workspace would open with
   * a decline notice for a card that was refused eighteen months ago.
   */
  dependsOn: ['core', 'billing', 'payments'],
  migrations: NOTIFICATIONS_MIGRATIONS,

  boot(ctx) {
    const store = notificationsStore(ctx);

    const service: NotificationsService = {
      send: (orgId, input, meta) => store.send(orgId, input, meta),
      messages: (orgId, filter) => store.messages(orgId, filter),
      message: (orgId, id) => store.message(orgId, id),
      lastSent: (orgId, relatedId, kind) => store.lastSent(orgId, relatedId, kind),
      sendInvoice: (orgId, invoiceId, opts, meta) => store.sendInvoice(orgId, invoiceId, opts, meta),
      sendDunningNotice: (orgId, input, meta) => store.sendDunningNotice(orgId, input, meta),
      suppressions: (orgId, filter) => store.suppressions(orgId, filter),
      suppress: (orgId, input, meta) => store.suppress(orgId, input, meta),
      isSuppressed: (orgId, address, channel) => {
        const row = store.suppressionRow(orgId, channel ?? 'email', address);
        return row ? store.suppression(orgId, row.id) : null;
      },
      endpoints: (orgId, filter) => store.endpoints(orgId, filter),
      endpoint: (orgId, id) => store.endpoint(orgId, id),
      deliveries: (orgId, filter) => store.deliveries(orgId, filter),
      delivery: (orgId, id) => store.delivery(orgId, id),
      settings: (orgId) => store.settings(orgId),
      useHttpTransport: (transport) => store.useHttpTransport(transport),
      useMessageTransport: (transport) => store.useMessageTransport(transport),
      httpTransport: () => store.httpTransport(),
      messageTransport: () => store.messageTransport(),
      recordedHttp: () => store.recordedHttp(),
      recordedMessages: () => store.recordedMessages(),
      signFor: (orgId, endpointId, payload, at) => store.signFor(orgId, endpointId, payload, at),
      verifySignature: (orgId, endpointId, payload, header, tolerance) =>
        store.verifySignature(orgId, endpointId, payload, header, tolerance),
    };
    ctx.provide('notifications', service);

    /* --------------------------------- jobs ------------------------------- */

    // One attempt per job. The next attempt is a new job with its own `run_at`,
    // so the ladder is visible in the queue rather than hidden in a retry
    // counter — and the time machine replays it exactly.
    ctx.jobs.handle('notifications.deliver', async (payload: { delivery?: string }, job) => {
      if (payload?.delivery) await store.attemptDelivery(job.org_id, payload.delivery);
    });

    /* ------------------------------ the fan-out --------------------------- */

    ctx.events.on('*', (event) => store.fanOut(event), 'notifications');

    /* ------------------------------ the notices --------------------------- */

    /**
     * A workspace is seeded with years of finalised invoices, and each one
     * emits `invoice.finalized` as it is written. `enabled_since` is the line
     * between that history and what is happening now: without it the module
     * would have emailed all 350 of them the first time it booted.
     */
    const isLive = (event: AinEvent): boolean => {
      const settings = store.settingsRow(event.org_id);
      return !!settings && event.created >= settings.enabled_since;
    };

    ctx.events.on('invoice.finalized', (event) => {
      if (!isLive(event)) return;
      const invoiceId = (event.data as { id?: string })?.id ?? event.object_id;
      if (invoiceId) store.sendInvoice(event.org_id, invoiceId, { kind: 'invoice.issued' });
    }, 'notifications');

    ctx.events.on('invoice.paid', (event) => {
      if (!isLive(event)) return;
      const invoiceId = (event.data as { id?: string })?.id ?? event.object_id;
      if (invoiceId) store.sendInvoice(event.org_id, invoiceId, { kind: 'invoice.receipt' });
    }, 'notifications');

    /**
     * Dunning is deliberately not listened for here.
     *
     * A campaign's notices are queued by `payments` itself, as
     * `payments.dunning_notice` job rows beside the retry rows the same
     * decision writes — see `Dunning.notify`. Eavesdropping on
     * `dunning.attempt_failed` and `dunning.exhausted` from this side produced
     * two letters in the same millisecond on the last refused attempt (the
     * failure and the exhaustion are two events about one decision), and it
     * put the send inside `EventBus.dispatch`, which swallows a throw: a
     * notice that failed to compose disappeared with no row, no error and
     * nothing to retry. Payments knows which decision it made and which card
     * was refused; it is the right caller.
     */
  },

  seed(ctx, orgId) {
    seedNotifications(ctx, orgId);
  },

  routes(r, ctx) {
    const store = notificationsStore(ctx);

    /* ------------------------------- endpoints ---------------------------- */

    r.get('/v1/webhook-endpoints', (req: Req) =>
      list(store.endpoints(req.auth.orgId, queryOf(req, endpointsQuery))), {
      summary: 'List the endpoints subscribed to this workspace’s events',
      description: 'Each endpoint carries the selectors it subscribes to, the last four characters of its signing secret, the retry ladder its deliveries run on, and how those deliveries have been going.',
      tags: ['notifications'],
      query: endpointsQuery,
    });

    r.post('/v1/webhook-endpoints', (req: Req) => {
      const endpoint: MintedWebhookEndpoint = store.createEndpoint(req.auth.orgId, req.body as EndpointInput, writeMeta(req));
      return created(endpoint);
    }, {
      summary: 'Register an endpoint',
      description: 'Returns the signing secret once, and never again — roll it if it is lost. An endpoint receives only what happens after it is registered, so pointing a URL at a busy workspace does not replay its history at you. `enabled_events` takes exact types, trailing wildcards (`invoice.*`) or `*`.',
      tags: ['notifications'],
      body: endpointBody,
      roles: ['admin'],
      idempotent: true,
    });

    r.get('/v1/webhook-endpoints/:id', (req: Req) => {
      const endpoint = store.endpoint(req.auth.orgId, req.params.id);
      if (!endpoint) throw notFound('webhook endpoint', req.params.id);
      return endpoint;
    }, { summary: 'Retrieve an endpoint', tags: ['notifications'] });

    r.patch('/v1/webhook-endpoints/:id', (req: Req) =>
      store.updateEndpoint(req.auth.orgId, req.params.id, req.body as EndpointPatch, writeMeta(req)), {
      summary: 'Update an endpoint',
      description: 'Enabling one that was disabled clears its consecutive-failure count as well as the reason — otherwise the next single failure would take it straight back out of service.',
      tags: ['notifications'],
      body: endpointPatchBody,
      roles: ['admin'],
    });

    r.del('/v1/webhook-endpoints/:id', (req: Req) => {
      store.deleteEndpoint(req.auth.orgId, req.params.id, writeMeta(req));
      return noContent();
    }, {
      summary: 'Delete an endpoint',
      description: 'Its deliveries and their attempts go with it, and anything still queued for it is cancelled. Disable it instead to keep the history.',
      tags: ['notifications'],
      roles: ['admin'],
    });

    r.post('/v1/webhook-endpoints/:id/roll-secret', (req: Req) =>
      store.rollSecret(req.auth.orgId, req.params.id, writeMeta(req)), {
      summary: 'Mint a new signing secret',
      description: 'The old secret stops signing on the next attempt, so deploy the new one at the subscriber before rolling. The answer carries the secret in full; nothing later will.',
      tags: ['notifications'],
      roles: ['admin'],
    });

    r.post('/v1/webhook-endpoints/:id/test', (req: Req) => {
      const orgId = req.auth.orgId;
      const endpoint = store.endpoint(orgId, req.params.id);
      if (!endpoint) throw notFound('webhook endpoint', req.params.id);
      return created(store.ping(orgId, req.params.id, writeMeta(req)));
    }, {
      summary: 'Send a test delivery to this endpoint',
      description: 'Emits a real `webhook_endpoint.pinged` event and queues it at this endpoint whatever its selectors say — a test is addressed to the endpoint, not filtered by it. The delivery runs on the next drain of the queue, like every other one.',
      tags: ['notifications'],
      roles: ['admin'],
    });

    /* ------------------------------ deliveries ---------------------------- */

    r.get('/v1/webhook-deliveries', (req: Req) => {
      const q = queryOf(req, deliveriesQuery);
      return list(store.deliveries(req.auth.orgId, q));
    }, {
      summary: 'List deliveries, newest first',
      description: 'One row per event per endpoint, with the payload that was signed and the state of its retry ladder. Filter by endpoint, by status, by event id or by event type.',
      tags: ['notifications'],
      query: deliveriesQuery,
    });

    r.get('/v1/webhook-deliveries/:id', (req: Req) => {
      const delivery = store.delivery(req.auth.orgId, req.params.id);
      if (!delivery) throw notFound('webhook delivery', req.params.id);
      return delivery;
    }, {
      summary: 'Retrieve a delivery with every attempt it made',
      description: 'Each attempt carries what the subscriber answered, how long it took, the exact signature header that went out, and when the next attempt was scheduled for.',
      tags: ['notifications'],
    });

    r.post('/v1/webhook-deliveries/:id/retry', (req: Req) =>
      store.retryDelivery(req.auth.orgId, req.params.id, writeMeta(req)), {
      summary: 'Try a failed delivery once more',
      description: 'The attempts already made stay on the record and exactly one more is allowed, so the history reads true and a still-broken subscriber does not start a fresh day-and-a-half ladder.',
      tags: ['notifications'],
      roles: ['member'],
    });

    /* ------------------------------ signatures ---------------------------- */

    r.post('/v1/webhook-signatures/verify', (req: Req) => {
      const body = req.body as { endpoint: string; payload: string; signature: string; tolerance_ms?: number };
      return store.verifySignature(req.auth.orgId, body.endpoint, body.payload, body.signature, body.tolerance_ms);
    }, {
      summary: 'Check a signature the way a subscriber should',
      description: 'The same computation the subscriber has to perform, run against the endpoint’s own secret — so an integrator can find out whether their verification is wrong or their body is. `expected` is the signature this payload should have carried.',
      tags: ['notifications'],
      body: verifyBody,
      roles: ['admin'],
    });

    /* ------------------------- what a webhook receives -------------------- */

    r.get('/v1/events/:id/webhook-payload', (req: Req, c: Ctx) => {
      const orgId = req.auth.orgId;
      const event = c.events.find(orgId, req.params.id);
      if (!event) throw notFound('event', req.params.id);
      const endpoints = store.endpoints(orgId);
      const wanted = endpoints.filter((e) => subscribes(e.enabled_events, event.type));
      // With every attempt, not just the counts: the screen that offers to
      // show what a subscriber receives has to be able to show what one
      // actually answered, and there are at most a handful per event.
      const deliveries = store.deliveries(orgId, { event: event.id, limit: 100 })
        .map((d) => store.delivery(orgId, d.id) ?? d);
      return {
        object: 'webhook_payload_preview',
        event: event.id,
        type: event.type,
        payload: webhookPayload(event, true),
        signature: signatureRecipe(),
        retry_policy: RETRY_POLICY,
        subscribed_endpoints: wanted.map((e) => ({ id: e.id, url: e.url, status: e.status })),
        deliveries,
        detail: deliveries.length
          ? `${deliveries.length} ${deliveries.length === 1 ? 'delivery was' : 'deliveries were'} created for this event.`
          : wanted.length
            ? 'No delivery was created: every subscribed endpoint was registered after this event happened.'
            : 'Nothing is subscribed to this type, so no delivery was created. This is the envelope one would receive.',
      };
    }, {
      summary: 'The exact envelope a subscriber receives for one event',
      description: 'The Stripe-shaped envelope this event is delivered inside, the endpoints subscribed to its type, and every delivery actually created for it. This is what the Events screen shows when it offers to show what a webhook would receive.',
      tags: ['notifications'],
    });

    /* ------------------------------- notices ------------------------------ */

    // Registered before /v1/notifications/:id so "overview" is never read as an id.
    r.get('/v1/notifications/overview', (req: Req) => {
      const orgId = req.auth.orgId;
      const endpoints = store.endpoints(orgId);
      const count = (sql: string, ...params: unknown[]) => ctx.db.count(sql, ...(params as any[]));
      const succeeded = count(`SELECT COUNT(*) FROM notification_deliveries WHERE org_id = ? AND status = 'succeeded'`, orgId);
      const failed = count(`SELECT COUNT(*) FROM notification_deliveries WHERE org_id = ? AND status = 'failed'`, orgId);
      const pending = count(`SELECT COUNT(*) FROM notification_deliveries WHERE org_id = ? AND status = 'pending'`, orgId);
      const settled = succeeded + failed;
      const overview: NotificationsOverview = {
        object: 'notifications_overview',
        endpoints: {
          total: endpoints.length,
          enabled: endpoints.filter((e) => e.status === 'enabled').length,
          disabled: endpoints.filter((e) => e.status === 'disabled').length,
        },
        deliveries: {
          pending, succeeded, failed,
          // Undefined, not zero: a workspace that has never delivered anything
          // has no success rate, and 0% reads as "everything is broken".
          success_rate: settled ? Math.round((succeeded / settled) * 1000) / 10 : null,
        },
        messages: {
          sent: count(`SELECT COUNT(*) FROM notification_messages WHERE org_id = ? AND status = 'sent'`, orgId),
          failed: count(`SELECT COUNT(*) FROM notification_messages WHERE org_id = ? AND status = 'failed'`, orgId),
          suppressed: count(`SELECT COUNT(*) FROM notification_messages WHERE org_id = ? AND status = 'suppressed'`, orgId),
        },
        suppressions: {
          total: count(`SELECT COUNT(*) FROM notification_suppressions WHERE org_id = ?`, orgId),
          bounced: count(`SELECT COUNT(*) FROM notification_suppressions WHERE org_id = ? AND reason = 'bounced'`, orgId),
          complained: count(`SELECT COUNT(*) FROM notification_suppressions WHERE org_id = ? AND reason = 'complained'`, orgId),
          manual: count(`SELECT COUNT(*) FROM notification_suppressions WHERE org_id = ? AND reason = 'manual'`, orgId),
        },
        transports: { http: store.httpTransport().name, message: store.messageTransport().name },
        settings: store.settings(orgId),
        as_of: ctx.now(),
      };
      return overview;
    }, {
      summary: 'What is leaving this workspace, and what it is leaving through',
      description: 'Endpoint health, delivery outcomes, notices sent — and the transports the platform is actually wired to. The shipped ones record what they are handed rather than sending it, which is why nothing here reaches the internet.',
      tags: ['notifications'],
    });

    r.get('/v1/notifications', (req: Req) =>
      list(store.messages(req.auth.orgId, queryOf(req, messagesQuery))), {
      summary: 'Every notice this workspace has sent',
      description: 'The delivery record. Each row says who it went to, what it was about, which transport carried it and when — or, for a suppressed one, why there was nobody to send it to.',
      tags: ['notifications'],
      query: messagesQuery,
    });

    r.get('/v1/notifications/hosted/:token', (req: Req) => {
      const opened = store.openHosted(req.params.token);
      if (!opened) throw notFound('hosted notification');
      return httpStatus(200, opened.html, { 'content-type': 'text/html; charset=utf-8' });
    }, {
      summary: 'The recipient’s own copy of a notice',
      description: 'The exact bytes that were sent, served to whoever holds the link and nobody else — no Ain session, no cookie. The token is minted per message from `randomBytes`, and opening it is recorded on the message.',
      tags: ['notifications'],
      auth: 'public',
    });

    r.get('/v1/notifications/:id', (req: Req) => {
      const message = store.message(req.auth.orgId, req.params.id);
      if (!message) throw notFound('notification', req.params.id);
      return message;
    }, {
      summary: 'Retrieve one notice, with the body exactly as it was sent',
      description: 'The stored body, not a re-render: a record that cannot produce the words it claims to have sent is not evidence of anything.',
      tags: ['notifications'],
    });

    r.post('/v1/notifications/:id/resend', (req: Req) => {
      const body = req.body as { to?: string | null };
      return created(store.resend(req.auth.orgId, req.params.id, body.to ?? null, writeMeta(req)));
    }, {
      summary: 'Send a notice again',
      description: 'A new record with its own timestamp — the first one keeps saying what happened to it. Give a `to` to send a suppressed notice once an address exists.',
      tags: ['notifications'],
      body: resendBody,
      roles: ['member'],
    });

    r.post('/v1/notifications/invoice', (req: Req) => {
      const body = req.body as { invoice: string; kind: 'invoice.issued' | 'invoice.receipt'; to?: string | null; force?: boolean };
      const message = store.sendInvoice(req.auth.orgId, body.invoice, {
        kind: body.kind, to: body.to ?? null, force: body.force,
      }, writeMeta(req));
      if (!message) throw notFound('invoice', body.invoice);
      return created(message);
    }, {
      summary: 'Send an invoice to the account that owes it',
      description: 'Idempotent by (invoice, kind): calling it twice returns the record of the first send rather than emailing the bill again. Pass `force` to send it anyway. An account with no billing email produces a `suppressed` record naming the account — which is the fact a status line should show instead of "sent".',
      tags: ['notifications'],
      body: sendInvoiceBody,
      roles: ['member'],
      idempotent: true,
    });

    /* ----------------------------- suppressions --------------------------- */

    r.get('/v1/notification-suppressions', (req: Req) =>
      list(store.suppressions(req.auth.orgId, queryOf(req, suppressionsQuery))), {
      summary: 'Addresses this workspace has stopped writing to',
      description: 'A hard bounce or a spam complaint lands an address here on the first one; a soft bounce takes three in a row with nothing getting through in between. Every notice addressed to a listed address is recorded `suppressed`, naming the entry, rather than handed to a transport.',
      tags: ['notifications'],
      query: suppressionsQuery,
    });

    r.post('/v1/notification-suppressions', (req: Req) =>
      created(store.suppress(req.auth.orgId, req.body as SuppressionInput, writeMeta(req))), {
      summary: 'Stop writing to an address',
      description: 'Idempotent by address: suppressing one already listed updates the entry rather than adding a second. A `manual` entry is never demoted by a later bounce — a person saying "do not write to this account" outranks the relay’s opinion.',
      tags: ['notifications'],
      body: suppressionBody,
      roles: ['member'],
      idempotent: true,
    });

    r.del('/v1/notification-suppressions/:id', (req: Req) => {
      store.release(req.auth.orgId, req.params.id, writeMeta(req));
      return noContent();
    }, {
      summary: 'Write to this address again',
      description: 'A mailbox that was full in March is not a mailbox that is gone, so the list has a way off it. Releasing sends nothing: the notices suppressed while it was listed are records of what did not happen, and each can be sent with POST /v1/notifications/:id/resend.',
      tags: ['notifications'],
      roles: ['member'],
    });

    /* ------------------------------- settings ----------------------------- */

    r.get('/v1/notification-settings', (req: Req) => store.settings(req.auth.orgId), {
      summary: 'Who notices come from, and since when',
      tags: ['notifications'],
    });

    r.patch('/v1/notification-settings', (req: Req) =>
      store.updateSettings(req.auth.orgId, req.body as { from_name?: string; from_email?: string; reply_to?: string | null }, writeMeta(req)), {
      summary: 'Change the sender identity',
      tags: ['notifications'],
      body: settingsPatchBody,
      roles: ['admin'],
    });
  },

  tools(ctx) {
    return [
      {
        name: 'notifications.for_object',
        description: 'Every notice this workspace has sent about one object — an invoice, say — with who it went to, when, and whether it was suppressed for want of an address.',
        readOnly: true,
        tags: ['billing', 'notifications'],
        input: v.object({ id: v.string({ min: 1, max: 120 }) }),
        run: (args: { id: string }, c: Ctx, meta) =>
          notificationsStore(c).messages(meta.orgId, { related: args.id, limit: 20 }),
      },
      {
        name: 'notifications.suppressed_addresses',
        description: 'The addresses this workspace has stopped writing to and why — the answer to "why has this customer not had their invoices". A hard bounce or a spam complaint lands here on the first one; a soft bounce takes three in a row.',
        readOnly: true,
        tags: ['notifications'],
        input: v.object({ address: v.optional(v.string({ max: 320 })) }),
        run: (args: { address?: string }, c: Ctx, meta) =>
          notificationsStore(c).suppressions(meta.orgId, { address: args.address, limit: 100 }),
      },
      {
        name: 'notifications.webhook_health',
        description: 'How the workspace’s webhook endpoints are doing: what each subscribes to, how its deliveries have gone, and why any of them were disabled.',
        readOnly: true,
        tags: ['notifications'],
        input: v.object({}),
        run: (_args: unknown, c: Ctx, meta) => notificationsStore(c).endpoints(meta.orgId),
      },
    ];
  },
});

