import { randomBytes } from 'node:crypto';
import type { Ctx } from '../../kernel/context';
import type { AinEvent } from '../../kernel/events';
import { parseJson } from '../../kernel/db';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { newId, randomId } from '../../../shared/ids';
import { DAY, HOUR, MINUTE, formatDuration } from '../../../shared/time';
import {
  dunningFailed, dunningFinal, dunningGaveUp, dunningRecovered, invoiceIssued, invoiceReceipt, orgVoice,
  type Composed, type DunningFacts, type InvoiceFacts, type OrgVoice, type Recipient,
} from './compose';
import { SIGNATURE_HEADER, signatureHeader, signatureRecipe, verify, type SignatureCheck } from './signature';
import {
  recordedHttpTransport, recordedMessageTransport,
  type BounceKind, type HttpTransport, type MessageTransport, type OutboundRequest, type OutboundResponse,
  type RecordedHttpTransport, type RecordedMessageTransport,
} from './transport';
import type {
  DeliveryListFilter, DunningNoticeKind, EndpointInput, EndpointPatch, MessageChannel, MessageListFilter,
  MessageStatus, MintedWebhookEndpoint, NotificationMessage, NotificationSettings, SendInput, SettingsPatch,
  SuppressedAddress, SuppressionInput, SuppressionListFilter, SuppressionReason,
  WebhookAttempt, WebhookDelivery, WebhookEndpoint, WebhookPayload,
} from './types';

/* ------------------------------- the ladder ------------------------------- */

/**
 * The published retry ladder, in milliseconds *after the previous attempt*.
 *
 * It is a constant and not a setting because a subscriber has to be able to
 * reason about it: "I was down for four hours, did I lose anything" has an
 * answer only if the schedule is knowable. It is also why it is printed onto
 * every endpoint payload rather than described in prose somewhere else.
 */
export const DELIVERY_BACKOFF_MS = [MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR, DAY];

/** The first attempt is immediate, so the ladder has one more rung than steps. */
export const MAX_DELIVERY_ATTEMPTS = DELIVERY_BACKOFF_MS.length + 1;

/** Deliveries that exhaust every attempt, back to back, before the endpoint goes. */
export const DISABLE_AFTER_FAILED_DELIVERIES = 3;

export const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Soft bounces in a row before the address stops being written to.
 *
 * One is an accident — a full mailbox, a greylist, a relay having a bad
 * afternoon — and suppressing on it would cut a paying customer off from their
 * own invoices. Three in a row with nothing getting through in between is no
 * longer an accident, and it is the point at which continuing to write costs
 * the sending domain more than the notice is worth.
 */
export const SUPPRESS_AFTER_SOFT_BOUNCES = 3;

/** How much of a subscriber's response is worth keeping. */
const RESPONSE_BODY_LIMIT = 800;

export const RETRY_POLICY =
  `${MAX_DELIVERY_ATTEMPTS} attempts: the first immediately, then `
  + `${DELIVERY_BACKOFF_MS.map((ms) => formatDuration(ms, 1)).join(', ')} after the one before it. `
  + `${DISABLE_AFTER_FAILED_DELIVERIES} deliveries in a row that use up every attempt disable the endpoint.`;

/**
 * `invoice.finalized`, `invoice.*` and `*`. Deliberately only a trailing
 * wildcard: `*.paid` reads like it should work and would quietly match nothing,
 * so it is refused at the door instead (see `assertEventPatterns`).
 */
export function subscribes(patterns: readonly string[], type: string): boolean {
  return patterns.some((p) => p === '*' || p === type || (p.endsWith('*') && type.startsWith(p.slice(0, -1))));
}

export function assertEventPatterns(patterns: string[]): string[] {
  for (const p of patterns) {
    if (p === '*') continue;
    if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?$/.test(p)) {
      throw badRequest(
        'webhook_event_pattern_invalid',
        `"${p}" is not an event selector. Use an exact type ("invoice.finalized"), a trailing wildcard `
        + '("invoice.*"), or "*" for everything.',
        'enabled_events',
      );
    }
  }
  return patterns;
}

/**
 * The envelope a subscriber receives — Stripe's shape, because every
 * integrator in this market has already written the code that reads it.
 */
export function webhookPayload(event: AinEvent, livemode: boolean): WebhookPayload {
  return {
    id: event.id,
    object: 'event',
    type: event.type,
    created: event.created,
    livemode,
    org: event.org_id,
    request: { id: event.request_id },
    actor: { id: event.actor_id, type: event.actor_type },
    data: { object: event.data, previous_attributes: event.previous },
  };
}

/* --------------------------------- rows ----------------------------------- */

interface EndpointRow {
  id: string; org_id: string; url: string; description: string | null; status: string;
  enabled_events: string; secret: string; consecutive_failures: number;
  last_success_at: number | null; last_failure_at: number | null;
  disabled_at: number | null; disabled_reason: string | null;
  metadata: string; created: number; updated: number; livemode: number;
}

interface DeliveryRow {
  id: string; org_id: string; endpoint_id: string; event_id: string; event_type: string; status: string;
  attempts: number; max_attempts: number; next_attempt_at: number | null; delivered_at: number | null;
  last_status_code: number | null; last_error: string | null; payload: string;
  created: number; updated: number;
}

interface AttemptRow {
  id: string; org_id: string; delivery_id: string; endpoint_id: string; attempt: number; at: number;
  status: string; response_status: number | null; response_body: string | null; error: string | null;
  duration_ms: number; signature: string; next_attempt_at: number | null;
}

interface MessageRow {
  id: string; org_id: string; channel: string; kind: string; status: string;
  to_address: string | null; to_name: string | null; from_address: string; subject: string | null;
  body_text: string; body_html: string | null; customer_id: string | null;
  related_type: string | null; related_id: string | null; sent_at: number | null;
  failed_reason: string | null; transport: string; provider_id: string | null;
  hosted_token: string | null; views: number; first_viewed_at: number | null;
  metadata: string; created: number; updated: number;
}

interface SettingsRow {
  org_id: string; from_name: string; from_email: string; reply_to: string | null;
  enabled_since: number; created: number; updated: number;
}

export interface SuppressionRow {
  id: string; org_id: string; channel: string; address: string; reason: string; detail: string;
  bounces: number; last_message_id: string | null; last_bounce_at: number | null;
  created: number; updated: number;
}

/**
 * One mailbox, one entry. Addresses arrive from customer records typed by
 * people, so `AP@Acme.example` and ` ap@acme.example ` are the same recipient
 * and a list that only knows one of them is not a suppression list.
 */
export const normaliseAddress = (address: string): string => address.trim().toLowerCase();

const DEFAULT_SUPPRESSION_DETAIL: Record<SuppressionReason, string> = {
  bounced: 'Mail to this address came back and nothing further is written to it.',
  complained: 'The recipient reported mail from this workspace as spam.',
  manual: 'Suppressed by hand — someone here decided this address is not to be written to.',
};

export interface WriteMeta {
  actorId?: string | null;
  actorType?: 'user' | 'api_key' | 'system';
  requestId?: string | null;
  livemode?: boolean;
}

/* -------------------------------- the store ------------------------------- */

const stores = new WeakMap<Ctx, Notifications>();

export function notificationsStore(ctx: Ctx): Notifications {
  let found = stores.get(ctx);
  if (!found) { found = new Notifications(ctx); stores.set(ctx, found); }
  return found;
}

export class Notifications {
  private http: HttpTransport = recordedHttpTransport();
  private messages_: MessageTransport = recordedMessageTransport();
  /**
   * Every event in the platform asks this store whether anyone is listening.
   * Seeding a workspace emits thousands, so the answer is memoised and thrown
   * away whenever an endpoint is written — the only thing that can change it.
   */
  private endpointMemo = new Map<string, EndpointRow[]>();

  constructor(private readonly ctx: Ctx) {}

  /* ------------------------------ transports ----------------------------- */

  httpTransport(): HttpTransport { return this.http; }
  messageTransport(): MessageTransport { return this.messages_; }
  useHttpTransport(transport: HttpTransport): void { this.http = transport; }
  useMessageTransport(transport: MessageTransport): void { this.messages_ = transport; }

  /** The recorded transports, for a test or the demo that needs to steer them. */
  recordedHttp(): RecordedHttpTransport | null {
    return 'calls' in this.http ? (this.http as RecordedHttpTransport) : null;
  }
  recordedMessages(): RecordedMessageTransport | null {
    return 'outbox' in this.messages_ ? (this.messages_ as RecordedMessageTransport) : null;
  }

  /* ------------------------------- settings ------------------------------ */

  settingsRow(orgId: string): SettingsRow | undefined {
    return this.ctx.db.get<SettingsRow>(`SELECT * FROM notification_settings WHERE org_id = ?`, orgId);
  }

  /**
   * Provision the workspace's sender identity, once.
   *
   * `enabled_since` is the line between history and activity. A workspace is
   * seeded with years of finalised invoices, and every one of them emits
   * `invoice.finalized` as it is written; without this instant the module
   * would have emailed all 350 of them the first time it booted.
   */
  ensureSettings(orgId: string): SettingsRow {
    const existing = this.settingsRow(orgId);
    if (existing) return existing;
    const now = this.ctx.now();
    let name = 'Ain';
    let domain = 'ain.dev';
    try {
      const org = this.ctx.svc.core.org(orgId);
      name = org.name;
      domain = org.domain || domain;
    } catch { /* a workspace with no org row still needs a from-address */ }
    const row: SettingsRow = {
      org_id: orgId, from_name: name, from_email: `billing@${domain}`, reply_to: null,
      enabled_since: now, created: now, updated: now,
    };
    this.ctx.db.insert('notification_settings', { ...row });
    return row;
  }

  settings(orgId: string): NotificationSettings {
    const row = this.ensureSettings(orgId);
    return {
      object: 'notification_settings',
      from_name: row.from_name,
      from_email: row.from_email,
      reply_to: row.reply_to,
      enabled_since: row.enabled_since,
      detail:
        `Notices go out as "${row.from_name} <${row.from_email}>" through the ${this.messages_.name} transport. `
        + 'Anything that happened before this workspace switched notifications on is history and is never notified '
        + 'retroactively.',
    };
  }

  updateSettings(orgId: string, patch: SettingsPatch, meta: WriteMeta = {}): NotificationSettings {
    const row = this.ensureSettings(orgId);
    const now = this.ctx.now();
    const changes: Record<string, string | null | number> = { updated: now };
    if (patch.from_name !== undefined) changes.from_name = patch.from_name;
    if (patch.from_email !== undefined) changes.from_email = patch.from_email;
    if (patch.reply_to !== undefined) changes.reply_to = patch.reply_to;
    return this.ctx.atomic(() => {
      this.ctx.db.patch('notification_settings', 'org_id', orgId, changes);
      const after = this.settings(orgId);
      this.ctx.emit(orgId, 'notification_settings.updated', after, {
        objectId: orgId, objectType: 'notification_settings',
        previous: { from_name: row.from_name, from_email: row.from_email, reply_to: row.reply_to },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return after;
    });
  }

  /* ------------------------------- endpoints ----------------------------- */

  private endpointRow(orgId: string, id: string): EndpointRow | undefined {
    return this.ctx.db.get<EndpointRow>(`SELECT * FROM notification_endpoints WHERE org_id = ? AND id = ?`, orgId, id);
  }

  private requireRow(orgId: string, id: string): EndpointRow {
    const row = this.endpointRow(orgId, id);
    if (!row) throw notFound('webhook endpoint', id);
    return row;
  }

  private forgetEndpoints(): void { this.endpointMemo.clear(); }

  private listening(orgId: string): EndpointRow[] {
    const cached = this.endpointMemo.get(orgId);
    if (cached) return cached;
    const rows = this.ctx.db.all<EndpointRow>(
      `SELECT * FROM notification_endpoints WHERE org_id = ? AND status = 'enabled' ORDER BY created ASC`, orgId);
    this.endpointMemo.set(orgId, rows);
    return rows;
  }

  endpoints(orgId: string, filter: { status?: string } = {}): WebhookEndpoint[] {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
    return this.ctx.db
      .all<EndpointRow>(`SELECT * FROM notification_endpoints WHERE ${clauses.join(' AND ')} ORDER BY created DESC`, ...(params as any[]))
      .map((row) => this.endpointPayload(row));
  }

  endpoint(orgId: string, id: string): WebhookEndpoint | null {
    const row = this.endpointRow(orgId, id);
    return row ? this.endpointPayload(row) : null;
  }

  createEndpoint(orgId: string, input: EndpointInput, meta: WriteMeta = {}): MintedWebhookEndpoint {
    const now = this.ctx.now();
    const events = assertEventPatterns(input.enabled_events?.length ? input.enabled_events : ['*']);
    const secret = mintSecret();
    const row: EndpointRow = {
      id: newId('endpoint'), org_id: orgId, url: input.url, description: input.description ?? null,
      status: input.status ?? 'enabled', enabled_events: JSON.stringify(events), secret,
      consecutive_failures: 0, last_success_at: null, last_failure_at: null,
      disabled_at: input.status === 'disabled' ? now : null,
      disabled_reason: input.status === 'disabled' ? 'Created disabled — it receives nothing until it is enabled.' : null,
      metadata: JSON.stringify(input.metadata ?? {}), created: now, updated: now,
      livemode: meta.livemode === false ? 0 : 1,
    };
    return this.ctx.atomic(() => {
      this.ctx.db.insert('notification_endpoints', { ...row });
      this.forgetEndpoints();
      const payload = this.endpointPayload(row);
      this.ctx.emit(orgId, 'webhook_endpoint.created', payload, {
        objectId: row.id, objectType: 'webhook_endpoint',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      // The one moment the secret is legible. It is not on the event, not in
      // the audit trail and not on any later read: an integrator who loses it
      // rolls it rather than being handed it again.
      return { ...payload, secret };
    });
  }

  updateEndpoint(orgId: string, id: string, patch: EndpointPatch, meta: WriteMeta = {}): WebhookEndpoint {
    const row = this.requireRow(orgId, id);
    const now = this.ctx.now();
    const changes: Record<string, unknown> = { updated: now };
    if (patch.url !== undefined) changes.url = patch.url;
    if (patch.description !== undefined) changes.description = patch.description;
    if (patch.enabled_events !== undefined) changes.enabled_events = JSON.stringify(assertEventPatterns(patch.enabled_events));
    if (patch.metadata !== undefined) changes.metadata = JSON.stringify(patch.metadata);
    if (patch.status !== undefined && patch.status !== row.status) {
      changes.status = patch.status;
      if (patch.status === 'enabled') {
        // Re-enabling clears the count as well as the reason. Leaving it at 3
        // meant the next single failure disabled the endpoint again, so an
        // operator who had fixed the subscriber saw it die on the first blip.
        changes.consecutive_failures = 0;
        changes.disabled_at = null;
        changes.disabled_reason = null;
      } else {
        changes.disabled_at = now;
        changes.disabled_reason = 'Disabled by hand.';
      }
    }
    return this.ctx.atomic(() => {
      this.ctx.db.patch('notification_endpoints', 'id', id, changes as any);
      this.forgetEndpoints();
      const after = this.requireRow(orgId, id);
      if (patch.status === 'disabled' && row.status !== 'disabled') this.standDownDeliveries(orgId, after, 'Disabled by hand.');
      const payload = this.endpointPayload(after);
      this.ctx.emit(orgId, 'webhook_endpoint.updated', payload, {
        objectId: id, objectType: 'webhook_endpoint',
        previous: { url: row.url, status: row.status, enabled_events: parseJson<string[]>(row.enabled_events, []) },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return payload;
    });
  }

  deleteEndpoint(orgId: string, id: string, meta: WriteMeta = {}): void {
    const row = this.requireRow(orgId, id);
    this.ctx.atomic(() => {
      // Cancel the queued work first: a delivery job whose endpoint has gone
      // would wake up, find nothing, and file a failure against a row that no
      // longer exists.
      for (const pending of this.ctx.db.all<{ id: string }>(
        `SELECT id FROM notification_deliveries WHERE org_id = ? AND endpoint_id = ? AND status = 'pending'`, orgId, id)) {
        this.ctx.jobs.cancel(orgId, { idemKey: deliveryJobKey(pending.id) }, this.ctx.now());
      }
      this.ctx.db.run(`DELETE FROM notification_attempts WHERE org_id = ? AND endpoint_id = ?`, orgId, id);
      this.ctx.db.run(`DELETE FROM notification_deliveries WHERE org_id = ? AND endpoint_id = ?`, orgId, id);
      this.ctx.db.run(`DELETE FROM notification_endpoints WHERE org_id = ? AND id = ?`, orgId, id);
      this.forgetEndpoints();
      this.ctx.emit(orgId, 'webhook_endpoint.deleted', { id, url: row.url }, {
        objectId: id, objectType: 'webhook_endpoint',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
    });
  }

  rollSecret(orgId: string, id: string, meta: WriteMeta = {}): MintedWebhookEndpoint {
    this.requireRow(orgId, id);
    const secret = mintSecret();
    return this.ctx.atomic(() => {
      this.ctx.db.patch('notification_endpoints', 'id', id, { secret, updated: this.ctx.now() });
      this.forgetEndpoints();
      const payload = this.endpointPayload(this.requireRow(orgId, id));
      this.ctx.emit(orgId, 'webhook_endpoint.secret_rolled', payload, {
        objectId: id, objectType: 'webhook_endpoint',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return { ...payload, secret };
    });
  }

  /**
   * Take an endpoint out of service and say why, in a sentence an operator can
   * act on. Everything still queued for it is stood down in the same
   * transaction — a disabled endpoint that goes on being retried for a day and
   * a half is not disabled.
   */
  disableEndpoint(orgId: string, id: string, reason: string, meta: WriteMeta = {}): WebhookEndpoint {
    const row = this.requireRow(orgId, id);
    const now = this.ctx.now();
    return this.ctx.atomic(() => {
      this.ctx.db.patch('notification_endpoints', 'id', id, {
        status: 'disabled', disabled_at: now, disabled_reason: reason, updated: now,
      });
      this.forgetEndpoints();
      const after = this.requireRow(orgId, id);
      this.standDownDeliveries(orgId, after, reason);
      const payload = this.endpointPayload(after);
      this.ctx.emit(orgId, 'webhook_endpoint.disabled', { ...payload, reason }, {
        objectId: id, objectType: 'webhook_endpoint', previous: { status: row.status },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return payload;
    });
  }

  private standDownDeliveries(orgId: string, endpoint: EndpointRow, reason: string): void {
    const now = this.ctx.now();
    const pending = this.ctx.db.all<DeliveryRow>(
      `SELECT * FROM notification_deliveries WHERE org_id = ? AND endpoint_id = ? AND status = 'pending'`,
      orgId, endpoint.id);
    for (const delivery of pending) {
      this.ctx.jobs.cancel(orgId, { idemKey: deliveryJobKey(delivery.id) }, now);
      this.ctx.db.patch('notification_deliveries', 'id', delivery.id, {
        status: 'failed', next_attempt_at: null, updated: now,
        last_error: `The endpoint was disabled before this delivery could be retried: ${reason}`,
      });
    }
  }

  endpointPayload(row: EndpointRow): WebhookEndpoint {
    const counts = { pending: 0, succeeded: 0, failed: 0 };
    for (const r of this.ctx.db.all<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM notification_deliveries WHERE org_id = ? AND endpoint_id = ? GROUP BY status`,
      row.org_id, row.id)) {
      if (r.status in counts) counts[r.status as keyof typeof counts] = r.n;
    }
    const events = parseJson<string[]>(row.enabled_events, ['*']);
    return {
      object: 'webhook_endpoint',
      id: row.id,
      url: row.url,
      description: row.description,
      status: row.status === 'disabled' ? 'disabled' : 'enabled',
      enabled_events: events,
      secret_last4: row.secret.slice(-4),
      signature: signatureRecipe(),
      retry_schedule_ms: [...DELIVERY_BACKOFF_MS],
      retry_policy: RETRY_POLICY,
      max_attempts: MAX_DELIVERY_ATTEMPTS,
      consecutive_failures: row.consecutive_failures,
      disable_after: DISABLE_AFTER_FAILED_DELIVERIES,
      last_success_at: row.last_success_at,
      last_failure_at: row.last_failure_at,
      disabled_at: row.disabled_at,
      disabled_reason: row.disabled_reason,
      metadata: parseJson<Record<string, string>>(row.metadata, {}),
      created: row.created,
      updated: row.updated,
      livemode: !!row.livemode,
      deliveries: counts,
      detail: describeEndpoint(row, events, counts),
    };
  }

  /* ------------------------------ the fan-out ---------------------------- */

  /**
   * Every event the platform emits passes through here.
   *
   * An endpoint receives only what happens after it is registered, and the
   * mechanism is this method and nothing else: the fan-out runs at dispatch,
   * over the event being published, and nothing anywhere reads the log
   * backwards for an endpoint that has just appeared. Registering a URL
   * against a workspace with a decade of history therefore delivers none of
   * it. (A timestamp comparison would be the wrong way to say the same thing:
   * an endpoint registered in the same millisecond as an event — every
   * millisecond, under a frozen workspace clock — is not distinguishable that
   * way, so the check would read as a rule while enforcing nothing.)
   *
   * This module also emits nothing per delivery and nothing per attempt. An
   * event about a delivery would create deliveries of deliveries, and the
   * queue would never empty.
   */
  fanOut(event: AinEvent): void {
    const listening = this.listening(event.org_id);
    if (!listening.length) return;
    for (const endpoint of listening) {
      if (!subscribes(parseJson<string[]>(endpoint.enabled_events, ['*']), event.type)) continue;
      this.queueDelivery(endpoint, event);
    }
  }

  /** Queue one event at one endpoint. Idempotent on the pair. */
  queueDelivery(endpoint: EndpointRow, event: AinEvent): DeliveryRow | null {
    const orgId = event.org_id;
    const existing = this.ctx.db.get<DeliveryRow>(
      `SELECT * FROM notification_deliveries WHERE org_id = ? AND endpoint_id = ? AND event_id = ?`,
      orgId, endpoint.id, event.id);
    if (existing) return existing;
    const now = this.ctx.now();
    const row: DeliveryRow = {
      id: newId('delivery'), org_id: orgId, endpoint_id: endpoint.id, event_id: event.id,
      event_type: event.type, status: 'pending', attempts: 0, max_attempts: MAX_DELIVERY_ATTEMPTS,
      next_attempt_at: now, delivered_at: null, last_status_code: null, last_error: null,
      payload: JSON.stringify(webhookPayload(event, !!endpoint.livemode)),
      created: now, updated: now,
    };
    this.ctx.db.insert('notification_deliveries', { ...row });
    this.ctx.enqueue(orgId, 'notifications.deliver', { delivery: row.id }, {
      runAt: now, idemKey: deliveryJobKey(row.id),
    });
    return row;
  }

  /** Queue one event at one endpoint by id — what the demo replay needs. */
  queueDeliveryById(orgId: string, endpointId: string, event: AinEvent): void {
    const endpoint = this.endpointRow(orgId, endpointId);
    if (endpoint) this.queueDelivery(endpoint, event);
  }

  /**
   * One attempt at one delivery.
   *
   * The retry is scheduled here rather than left to the queue's own backoff so
   * that the ladder the endpoint publishes is the ladder that runs, and so the
   * delivery row can say when the next attempt is due. The job row is still
   * the only thing holding the future — nothing sleeps on a timer, which is
   * what lets `POST /v1/time/advance` replay a failing subscriber's whole day
   * and a half of retries in one call.
   */
  async attemptDelivery(orgId: string, deliveryId: string): Promise<WebhookDelivery | null> {
    const delivery = this.ctx.db.get<DeliveryRow>(
      `SELECT * FROM notification_deliveries WHERE org_id = ? AND id = ?`, orgId, deliveryId);
    if (!delivery || delivery.status !== 'pending') return null;
    const endpoint = this.endpointRow(orgId, delivery.endpoint_id);
    if (!endpoint) {
      this.finishDelivery(delivery, 'The endpoint was deleted before this delivery could be attempted.');
      return this.delivery(orgId, deliveryId);
    }
    if (endpoint.status !== 'enabled') {
      this.finishDelivery(delivery, `The endpoint is disabled: ${endpoint.disabled_reason ?? 'no reason recorded'}`);
      return this.delivery(orgId, deliveryId);
    }

    const attempt = delivery.attempts + 1;
    const now = this.ctx.now();
    const signature = signatureHeader(endpoint.secret, now, delivery.payload);
    const request: OutboundRequest = {
      url: endpoint.url,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Ain-Webhooks/1',
        [SIGNATURE_HEADER]: signature,
        'ain-event-id': delivery.event_id,
        'ain-event-type': delivery.event_type,
        'ain-delivery-id': delivery.id,
        'ain-delivery-attempt': String(attempt),
      },
      body: delivery.payload,
      timeout_ms: DELIVERY_TIMEOUT_MS,
    };

    const startedAt = Date.now();
    let response: OutboundResponse | null = null;
    let error: string | null = null;
    try {
      response = await this.http.send(request);
    } catch (e) {
      // A transport that throws is a connection that never happened. It is
      // recorded as an attempt with no status, because "no answer" and "answered
      // 500" send an operator to two different places.
      error = e instanceof Error ? e.message : String(e);
    }
    const duration = Math.max(response?.duration_ms ?? 0, Date.now() - startedAt);
    const succeeded = !!response && response.status >= 200 && response.status < 300;

    this.ctx.atomic(() => {
      if (succeeded) {
        this.ctx.db.patch('notification_deliveries', 'id', delivery.id, {
          status: 'succeeded', attempts: attempt, delivered_at: now, next_attempt_at: null,
          last_status_code: response!.status, last_error: null, updated: now,
        });
        this.ctx.db.patch('notification_endpoints', 'id', endpoint.id, {
          consecutive_failures: 0, last_success_at: now, updated: now,
        });
        this.forgetEndpoints();
        this.writeAttempt(delivery, endpoint, {
          attempt, at: now, status: 'succeeded', response, error: null, duration, signature, nextAt: null,
        });
        return;
      }

      const nextAt = attempt < delivery.max_attempts ? now + DELIVERY_BACKOFF_MS[attempt - 1] : null;
      const failure = error
        ? `The connection failed: ${error}`
        : `The endpoint answered ${response!.status}.`;
      this.ctx.db.patch('notification_deliveries', 'id', delivery.id, {
        status: nextAt === null ? 'failed' : 'pending',
        attempts: attempt,
        next_attempt_at: nextAt,
        last_status_code: response?.status ?? null,
        last_error: failure,
        updated: now,
      });
      this.writeAttempt(delivery, endpoint, {
        attempt, at: now, status: 'failed', response, error, duration, signature, nextAt,
      });
      if (nextAt !== null) {
        this.ctx.enqueue(orgId, 'notifications.deliver', { delivery: delivery.id }, {
          runAt: nextAt, idemKey: deliveryJobKey(delivery.id),
        });
        return;
      }
      // The delivery is out of attempts. The endpoint's own count is what
      // decides whether it survives, so a subscriber that is merely flaky is
      // not disabled by one bad afternoon.
      const failures = endpoint.consecutive_failures + 1;
      this.ctx.db.patch('notification_endpoints', 'id', endpoint.id, {
        consecutive_failures: failures, last_failure_at: now, updated: now,
      });
      this.forgetEndpoints();
      if (failures >= DISABLE_AFTER_FAILED_DELIVERIES) {
        this.disableEndpoint(orgId, endpoint.id,
          `Disabled automatically after ${failures} deliveries in a row used up all ${MAX_DELIVERY_ATTEMPTS} attempts. `
          + `The last one ${error ? `could not connect: ${error}` : `was answered ${response!.status}`}. `
          + 'Fix the subscriber, then enable the endpoint again.');
      }
    });
    return this.delivery(orgId, deliveryId);
  }

  private finishDelivery(delivery: DeliveryRow, reason: string): void {
    const now = this.ctx.now();
    this.ctx.db.patch('notification_deliveries', 'id', delivery.id, {
      status: 'failed', next_attempt_at: null, last_error: reason, updated: now,
    });
  }

  private writeAttempt(
    delivery: DeliveryRow, endpoint: EndpointRow,
    input: {
      attempt: number; at: number; status: 'succeeded' | 'failed';
      response: OutboundResponse | null; error: string | null; duration: number;
      signature: string; nextAt: number | null;
    },
  ): void {
    const row: AttemptRow = {
      id: randomId('whda'), org_id: delivery.org_id, delivery_id: delivery.id, endpoint_id: endpoint.id,
      attempt: input.attempt, at: input.at, status: input.status,
      response_status: input.response?.status ?? null,
      response_body: input.response ? input.response.body.slice(0, RESPONSE_BODY_LIMIT) : null,
      error: input.error, duration_ms: input.duration, signature: input.signature,
      next_attempt_at: input.nextAt,
    };
    this.ctx.db.insert('notification_attempts', { ...row });
  }

  /**
   * One more attempt at a delivery that ran out of them.
   *
   * The attempts already made stay on the row, so the history reads true, and
   * exactly one is added — the same reading the job queue's own `retry` takes:
   * an operator saying "the cause is fixed, try once more", not a reset.
   */
  retryDelivery(orgId: string, id: string, meta: WriteMeta = {}): WebhookDelivery {
    const row = this.ctx.db.get<DeliveryRow>(
      `SELECT * FROM notification_deliveries WHERE org_id = ? AND id = ?`, orgId, id);
    if (!row) throw notFound('webhook delivery', id);
    if (row.status === 'succeeded') {
      throw conflict('webhook_delivery_succeeded', 'This delivery was already acknowledged; there is nothing to retry.');
    }
    if (row.status === 'pending') {
      throw conflict('webhook_delivery_pending', `This delivery is still on the ladder — attempt ${row.attempts + 1} is already queued.`);
    }
    const endpoint = this.requireRow(orgId, row.endpoint_id);
    if (endpoint.status !== 'enabled') {
      throw conflict('webhook_endpoint_disabled', 'Enable the endpoint before retrying deliveries to it.');
    }
    const now = this.ctx.now();
    return this.ctx.atomic(() => {
      this.ctx.db.patch('notification_deliveries', 'id', id, {
        status: 'pending', max_attempts: row.attempts + 1, next_attempt_at: now, last_error: null, updated: now,
      });
      this.ctx.enqueue(orgId, 'notifications.deliver', { delivery: id }, { runAt: now, idemKey: deliveryJobKey(id) });
      const after = this.delivery(orgId, id)!;
      this.ctx.emit(orgId, 'webhook_delivery.retried', { id, endpoint: row.endpoint_id, attempt: row.attempts + 1 }, {
        objectId: id, objectType: 'webhook_delivery',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return after;
    });
  }

  /**
   * A test delivery, addressed to one endpoint.
   *
   * It emits a real event — the ping is in the log like everything else — and
   * then queues it at this endpoint whatever its selectors say, because a test
   * is addressed to the endpoint rather than filtered by it. The delivery then
   * runs on the queue like every other one, so what a test exercises is the
   * real path and not a shortcut around it.
   */
  ping(orgId: string, endpointId: string, meta: WriteMeta = {}): WebhookDelivery {
    const endpoint = this.requireRow(orgId, endpointId);
    if (endpoint.status !== 'enabled') {
      throw conflict('webhook_endpoint_disabled', 'Enable the endpoint before sending a test delivery to it.');
    }
    return this.ctx.atomic(() => {
      const event = this.ctx.events.emit(orgId, 'webhook_endpoint.pinged', {
        endpoint: endpoint.id,
        url: endpoint.url,
        message: 'A test delivery from Ain. Nothing in this workspace changed.',
      }, this.ctx.now(), {
        objectId: endpoint.id, objectType: 'webhook_endpoint',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      const row = this.queueDelivery(endpoint, event);
      return this.deliveryPayload(row!);
    });
  }

  deliveries(orgId: string, filter: DeliveryListFilter = {}): WebhookDelivery[] {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.endpoint) { clauses.push('endpoint_id = ?'); params.push(filter.endpoint); }
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
    if (filter.event) { clauses.push('event_id = ?'); params.push(filter.event); }
    if (filter.event_type) { clauses.push('event_type = ?'); params.push(filter.event_type); }
    return this.ctx.db
      .all<DeliveryRow>(
        `SELECT * FROM notification_deliveries WHERE ${clauses.join(' AND ')} ORDER BY created DESC, rowid DESC LIMIT ?`,
        ...(params as any[]), Math.min(filter.limit ?? 50, 500))
      .map((row) => this.deliveryPayload(row));
  }

  delivery(orgId: string, id: string): WebhookDelivery | null {
    const row = this.ctx.db.get<DeliveryRow>(
      `SELECT * FROM notification_deliveries WHERE org_id = ? AND id = ?`, orgId, id);
    if (!row) return null;
    return { ...this.deliveryPayload(row), attempts: this.attempts(orgId, id) };
  }

  attempts(orgId: string, deliveryId: string): WebhookAttempt[] {
    return this.ctx.db
      .all<AttemptRow>(
        `SELECT * FROM notification_attempts WHERE org_id = ? AND delivery_id = ? ORDER BY attempt ASC`,
        orgId, deliveryId)
      .map((row) => ({
        object: 'webhook_attempt',
        id: row.id,
        delivery: row.delivery_id,
        endpoint: row.endpoint_id,
        attempt: row.attempt,
        at: row.at,
        status: row.status === 'succeeded' ? 'succeeded' : 'failed',
        response_status: row.response_status,
        response_body: row.response_body,
        error: row.error,
        duration_ms: row.duration_ms,
        signature: row.signature,
        next_attempt_at: row.next_attempt_at,
        summary: describeAttempt(row),
      }));
  }

  private deliveryPayload(row: DeliveryRow): WebhookDelivery {
    const endpoint = this.endpointRow(row.org_id, row.endpoint_id);
    return {
      object: 'webhook_delivery',
      id: row.id,
      endpoint: row.endpoint_id,
      endpoint_url: endpoint?.url ?? '(deleted endpoint)',
      event: row.event_id,
      event_type: row.event_type,
      status: row.status === 'succeeded' ? 'succeeded' : row.status === 'failed' ? 'failed' : 'pending',
      attempt_count: row.attempts,
      max_attempts: row.max_attempts,
      next_attempt_at: row.next_attempt_at,
      delivered_at: row.delivered_at,
      last_status_code: row.last_status_code,
      last_error: row.last_error,
      created: row.created,
      updated: row.updated,
      payload: parseJson<WebhookPayload>(row.payload, {} as WebhookPayload),
      detail: describeDelivery(row),
    };
  }

  /* -------------------------------- messages ----------------------------- */

  send(orgId: string, input: SendInput, meta: WriteMeta = {}): NotificationMessage {
    const settings = this.ensureSettings(orgId);
    const now = this.ctx.now();
    const from = `${settings.from_name} <${settings.from_email}>`;
    // The composer's token when it built the body's own link from one, so the
    // link that was sent and the link that is stored are the same string.
    const token = input.hosted_token ?? (input.html ? randomId('nhl', 32) : null);

    let status: MessageStatus;
    let failedReason: string | null = null;
    let providerId: string | null = null;
    let bounce: BounceKind | null = null;
    const transportName = this.messages_.name;
    // Asked before anything is handed to a transport, and asked of the
    // normalised address, so a mailbox that is gone is gone whichever way the
    // record that holds it happens to be capitalised.
    const blocked = input.to ? this.suppressionRow(orgId, input.channel, input.to) : undefined;

    if (!input.to) {
      // Nothing was sent, and the record says so rather than claiming a send
      // to an address that does not exist. This is the fact a bill's status
      // line has to read instead of "sent".
      status = 'suppressed';
      failedReason = input.suppressed_reason
        ?? 'There is no address on file for this recipient, so nothing was sent.';
    } else if (blocked) {
      // The address exists and this workspace has stopped writing to it. The
      // record keeps the address rather than blanking it: "we did not write to
      // ap@… because it bounced on the 3rd" is an answer somebody can act on,
      // and "there was nobody to write to" is not the same fact at all.
      status = 'suppressed';
      failedReason = describeSuppression(blocked);
    } else {
      let receipt;
      try {
        receipt = this.messages_.deliver({
          channel: input.channel, to: input.to, to_name: input.to_name ?? null, from,
          subject: input.subject, text: input.text, html: input.html ?? null,
        });
      } catch (e) {
        receipt = { accepted: false, provider_id: '', detail: e instanceof Error ? e.message : String(e) };
      }
      if (receipt instanceof Promise) {
        // A message transport may be async; `send` is not, because every caller
        // is inside a synchronous event handler or a transaction. An async
        // transport belongs behind a job, and this says so rather than filing
        // an unresolved promise as a successful send. The promise is settled
        // first, so refusing it does not also take the process down with an
        // unhandled rejection.
        receipt.catch(() => { /* the caller is being told to wrap this in a job */ });
        throw badRequest('notification_transport_async',
          'The installed message transport returned a promise. Wrap it in a job handler — send() is called from inside transactions and cannot await.');
      }
      status = receipt.accepted ? 'sent' : 'failed';
      failedReason = receipt.accepted ? null : receipt.detail;
      providerId = receipt.accepted ? receipt.provider_id : null;
      // A refusal the relay could not classify is soft. Guessing "permanent"
      // costs a customer every invoice they were ever going to be sent.
      if (!receipt.accepted) bounce = receipt.bounce ?? 'soft';
    }

    const row: MessageRow = {
      id: newId('notification'), org_id: orgId, channel: input.channel, kind: input.kind, status,
      to_address: input.to, to_name: input.to_name ?? null, from_address: from, subject: input.subject,
      body_text: input.text, body_html: input.html ?? null, customer_id: input.customer ?? null,
      related_type: input.related?.type ?? null, related_id: input.related?.id ?? null,
      sent_at: status === 'sent' ? now : null, failed_reason: failedReason, transport: transportName,
      provider_id: providerId, hosted_token: status === 'sent' ? token : null, views: 0, first_viewed_at: null,
      metadata: JSON.stringify(input.metadata ?? {}), created: now, updated: now,
    };

    return this.ctx.atomic(() => {
      this.ctx.db.insert('notification_messages', { ...row });
      const payload = this.messagePayload(row);
      this.ctx.emit(orgId, `notification.${status}`, payload, {
        objectId: row.id, objectType: 'notification',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      // Inside the same transaction as the message it came back from: a bounce
      // recorded without the message that bounced, or a message recorded
      // without the bounce that answered it, is half a story either way.
      if (bounce && input.to) this.noteBounce(orgId, input.channel, input.to, bounce, row, meta);
      return payload;
    });
  }

  /* ------------------------------ suppressions --------------------------- */

  /**
   * A bounce came back. Decide whether the address stays writable.
   *
   * A hard bounce and a spam complaint stop the address on the first one —
   * there is nothing to wait for, and continuing to write to a complainant is
   * how a sending domain gets blocked for every other customer too. A soft
   * bounce is an accident until it stops looking like one: it takes
   * `SUPPRESS_AFTER_SOFT_BOUNCES` back to back, counted from the last message
   * that actually got through, so a mailbox that was full in March and has
   * been fine since starts again from zero.
   */
  private noteBounce(
    orgId: string, channel: MessageChannel, address: string, kind: BounceKind,
    message: MessageRow, meta: WriteMeta,
  ): void {
    const consecutive = this.consecutiveBounces(orgId, channel, address);
    this.ctx.emit(orgId, 'notification.bounced', {
      object: 'notification_bounce',
      notification: message.id,
      channel,
      to: message.to_address,
      kind,
      detail: message.failed_reason,
      consecutive,
      suppresses: kind !== 'soft' || consecutive >= SUPPRESS_AFTER_SOFT_BOUNCES,
    }, {
      objectId: message.id, objectType: 'notification',
      actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
    });
    if (kind === 'soft' && consecutive < SUPPRESS_AFTER_SOFT_BOUNCES) return;
    this.suppress(orgId, {
      address,
      channel,
      reason: kind === 'complaint' ? 'complained' : 'bounced',
      detail: kind === 'complaint'
        ? `The recipient reported this mail as spam${message.failed_reason ? ` (${sentence(message.failed_reason)})` : ''}, so nothing further is written to this address.`
        : kind === 'hard'
          ? `The receiving server refused this address permanently: ${sentence(message.failed_reason ?? 'no reason given')}`
          : `${consecutive} messages in a row came back and none got through. The last said: ${sentence(message.failed_reason ?? 'no reason given')}`,
    }, meta, { bounces: consecutive, messageId: message.id });
  }

  /**
   * Messages to this address that came back since the last one that did not.
   *
   * Counted from the log rather than kept in a counter, because the counter
   * and the log would be two answers to one question and the log is the one
   * with the evidence under it. The just-written row is included — it is in
   * the same transaction — so this is the run *including* the bounce being
   * judged.
   *
   * "In a row" is insertion order, not `created`. The workspace clock does not
   * move inside a request and barely moves inside a tick, so several messages
   * routinely share an instant; counting by timestamp made a delivery that
   * came *after* two bounces fail to break the run, and suppressed an address
   * that had just been written to successfully.
   */
  private consecutiveBounces(orgId: string, channel: MessageChannel, address: string): number {
    const lastSuccess = this.ctx.db.pluck<number>(
      `SELECT MAX(rowid) FROM notification_messages
        WHERE org_id = ? AND channel = ? AND LOWER(TRIM(to_address)) = ? AND status = 'sent'`,
      orgId, channel, normaliseAddress(address),
    ) ?? 0;
    return this.ctx.db.count(
      `SELECT COUNT(*) FROM notification_messages
        WHERE org_id = ? AND channel = ? AND LOWER(TRIM(to_address)) = ? AND status = 'failed' AND rowid > ?`,
      orgId, channel, normaliseAddress(address), lastSuccess,
    );
  }

  suppressionRow(orgId: string, channel: MessageChannel, address: string): SuppressionRow | undefined {
    return this.ctx.db.get<SuppressionRow>(
      `SELECT * FROM notification_suppressions WHERE org_id = ? AND channel = ? AND address = ?`,
      orgId, channel, normaliseAddress(address),
    );
  }

  suppressions(orgId: string, filter: SuppressionListFilter = {}): SuppressedAddress[] {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.channel) { clauses.push('channel = ?'); params.push(filter.channel); }
    if (filter.reason) { clauses.push('reason = ?'); params.push(filter.reason); }
    if (filter.address) { clauses.push('address = ?'); params.push(normaliseAddress(filter.address)); }
    return this.ctx.db
      .all<SuppressionRow>(
        `SELECT * FROM notification_suppressions WHERE ${clauses.join(' AND ')} ORDER BY created DESC, rowid DESC LIMIT ?`,
        ...(params as any[]), Math.min(filter.limit ?? 50, 500))
      .map(suppressionPayload);
  }

  /**
   * Put an address on the list, or update the entry already there.
   *
   * An operator's `manual` entry is never overwritten by a machine: a person
   * saying "stop writing to this account" outranks the relay's opinion, and a
   * later soft bounce quietly rewriting the reason would lose why it is there.
   */
  suppress(
    orgId: string, input: SuppressionInput, meta: WriteMeta = {},
    from: { bounces?: number; messageId?: string | null } = {},
  ): SuppressedAddress {
    const address = normaliseAddress(input.address);
    if (!address) throw badRequest('notification_address_missing', 'An address is needed to suppress one.', 'address');
    const channel: MessageChannel = input.channel ?? 'email';
    const reason: SuppressionReason = input.reason ?? 'manual';
    const now = this.ctx.now();
    const existing = this.suppressionRow(orgId, channel, address);
    return this.ctx.atomic(() => {
      if (existing) {
        const keepManual = existing.reason === 'manual' && reason !== 'manual';
        this.ctx.db.patch('notification_suppressions', 'id', existing.id, {
          reason: keepManual ? existing.reason : reason,
          detail: keepManual ? existing.detail : (input.detail ?? existing.detail),
          bounces: Math.max(existing.bounces, from.bounces ?? 0),
          last_message_id: from.messageId ?? existing.last_message_id,
          last_bounce_at: from.messageId ? now : existing.last_bounce_at,
          updated: now,
        });
        return suppressionPayload(this.requireSuppression(orgId, existing.id));
      }
      const row: SuppressionRow = {
        id: randomId('nsup'), org_id: orgId, channel, address, reason,
        detail: input.detail ?? DEFAULT_SUPPRESSION_DETAIL[reason],
        bounces: from.bounces ?? 0, last_message_id: from.messageId ?? null,
        last_bounce_at: from.messageId ? now : null, created: now, updated: now,
      };
      this.ctx.db.insert('notification_suppressions', { ...row });
      const payload = suppressionPayload(row);
      this.ctx.emit(orgId, 'notification.address_suppressed', payload, {
        objectId: row.id, objectType: 'notification_suppression',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return payload;
    });
  }

  /**
   * Take an address off the list.
   *
   * The mirror of `suppress`, and the module is a trap without it: a mailbox
   * that was full in March, or an address suppressed by a typo in a bounce
   * rule, would otherwise never receive another invoice and no screen would
   * offer a way back. Releasing does not resend anything — the messages
   * suppressed while it was listed are records of what did not happen, and a
   * resend is a deliberate act with its own route.
   */
  release(orgId: string, id: string, meta: WriteMeta = {}): SuppressedAddress {
    const row = this.requireSuppression(orgId, id);
    return this.ctx.atomic(() => {
      this.ctx.db.run(`DELETE FROM notification_suppressions WHERE org_id = ? AND id = ?`, orgId, id);
      const payload = suppressionPayload(row);
      this.ctx.emit(orgId, 'notification.address_released', payload, {
        objectId: row.id, objectType: 'notification_suppression',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return payload;
    });
  }

  suppression(orgId: string, id: string): SuppressedAddress | null {
    const row = this.ctx.db.get<SuppressionRow>(
      `SELECT * FROM notification_suppressions WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? suppressionPayload(row) : null;
  }

  private requireSuppression(orgId: string, id: string): SuppressionRow {
    const row = this.ctx.db.get<SuppressionRow>(
      `SELECT * FROM notification_suppressions WHERE org_id = ? AND id = ?`, orgId, id);
    if (!row) throw notFound('notification suppression', id);
    return row;
  }

  messages(orgId: string, filter: MessageListFilter = {}): NotificationMessage[] {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.channel) { clauses.push('channel = ?'); params.push(filter.channel); }
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
    if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind); }
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.related) { clauses.push('related_id = ?'); params.push(filter.related); }
    return this.ctx.db
      .all<MessageRow>(
        `SELECT * FROM notification_messages WHERE ${clauses.join(' AND ')} ORDER BY created DESC, rowid DESC LIMIT ?`,
        ...(params as any[]), Math.min(filter.limit ?? 50, 500))
      .map((row) => this.messagePayload(row));
  }

  message(orgId: string, id: string): NotificationMessage | null {
    const row = this.ctx.db.get<MessageRow>(`SELECT * FROM notification_messages WHERE org_id = ? AND id = ?`, orgId, id);
    if (!row) return null;
    return { ...this.messagePayload(row), body_text: row.body_text, body_html: row.body_html };
  }

  /** The last notice of a kind about an object — what a status line points at. */
  lastSent(orgId: string, relatedId: string, kind?: string): NotificationMessage | null {
    const row = kind
      ? this.ctx.db.get<MessageRow>(
        `SELECT * FROM notification_messages WHERE org_id = ? AND related_id = ? AND kind = ? ORDER BY created DESC LIMIT 1`,
        orgId, relatedId, kind)
      : this.ctx.db.get<MessageRow>(
        `SELECT * FROM notification_messages WHERE org_id = ? AND related_id = ? ORDER BY created DESC LIMIT 1`,
        orgId, relatedId);
    return row ? this.messagePayload(row) : null;
  }

  resend(orgId: string, id: string, to: string | null, meta: WriteMeta = {}): NotificationMessage {
    const row = this.ctx.db.get<MessageRow>(`SELECT * FROM notification_messages WHERE org_id = ? AND id = ?`, orgId, id);
    if (!row) throw notFound('notification', id);
    const address = to ?? row.to_address;
    if (!address) {
      throw badRequest('notification_recipient_missing',
        'This notice was suppressed because there was no address for it. Give one to send it now.', 'to');
    }
    // A person clicking "send it again" is owed an answer, not a second
    // suppressed row that looks like the first. Releasing the address is a
    // deliberate act and this says which entry to release.
    const blocked = this.suppressionRow(orgId, row.channel === 'sms' ? 'sms' : 'email', address);
    if (blocked) {
      throw conflict('notification_address_suppressed',
        `${blocked.address} is on this workspace’s suppression list, so nothing is written to it. ${blocked.detail} `
        + `Take it off the list with DELETE /v1/notification-suppressions/${blocked.id} to send to it again.`,
        { suppression: blocked.id, address: blocked.address, reason: blocked.reason });
    }
    // A resend is a new send, not an edit of the old one: two rows, two
    // timestamps, and the first one keeps saying what happened to it.
    return this.send(orgId, {
      channel: row.channel as MessageChannel,
      kind: row.kind,
      to: address,
      to_name: row.to_name,
      subject: row.subject,
      text: row.body_text,
      html: row.body_html,
      customer: row.customer_id,
      related: row.related_type && row.related_id ? { type: row.related_type, id: row.related_id } : null,
      metadata: { resend_of: row.id },
    }, meta);
  }

  /** The recipient opening their copy. Returns the body, and records the read. */
  openHosted(token: string): { html: string; message: NotificationMessage } | null {
    // Looked up by the token alone, across workspaces, exactly as the session
    // and API-key tables are: the token *is* the credential, and the reader
    // has no workspace to be scoped to.
    const row = this.ctx.db.get<MessageRow>(`SELECT * FROM notification_messages WHERE hosted_token = ?`, token);
    if (!row || !row.body_html) return null;
    const now = this.ctx.now();
    this.ctx.db.patch('notification_messages', 'id', row.id, {
      views: row.views + 1, first_viewed_at: row.first_viewed_at ?? now, updated: now,
    });
    const after = { ...row, views: row.views + 1, first_viewed_at: row.first_viewed_at ?? now };
    return { html: row.body_html, message: this.messagePayload(after) };
  }

  messagePayload(row: MessageRow): NotificationMessage {
    return {
      object: 'notification',
      id: row.id,
      channel: row.channel === 'sms' ? 'sms' : 'email',
      kind: row.kind,
      status: row.status === 'sent' ? 'sent' : row.status === 'failed' ? 'failed' : 'suppressed',
      to: row.to_address,
      to_name: row.to_name,
      from: row.from_address,
      subject: row.subject,
      preview: row.body_text.split('\n').map((l) => l.trim()).filter(Boolean)[1] ?? row.body_text.slice(0, 160),
      customer: row.customer_id,
      related: row.related_type && row.related_id ? { type: row.related_type, id: row.related_id } : null,
      sent_at: row.sent_at,
      failed_reason: row.failed_reason,
      transport: row.transport,
      provider_id: row.provider_id,
      hosted_url: row.hosted_token ? this.hostedUrl(row.hosted_token) : null,
      views: row.views,
      first_viewed_at: row.first_viewed_at,
      created: row.created,
      updated: row.updated,
      detail: describeMessage(row),
    };
  }

  hostedUrl(token: string): string {
    return `${this.ctx.config.publicUrl}/api/v1/notifications/hosted/${token}`;
  }

  /* ---------------------------- the domain notices ----------------------- */

  private voice(orgId: string): OrgVoice { return orgVoice(this.ctx, orgId); }

  private invoiceFacts(orgId: string, invoiceId: string): { facts: InvoiceFacts; to: Recipient; customer: string } | null {
    const invoice = this.ctx.svc.billing?.invoice(orgId, invoiceId);
    if (!invoice) return null;
    const customer = this.ctx.svc.billing.customer(orgId, invoice.customer);
    return {
      customer: invoice.customer,
      to: { name: customer?.name ?? 'there', email: customer?.email ?? null },
      facts: {
        number: invoice.number,
        currency: invoice.currency,
        total: invoice.total,
        amount_due: invoice.amount_due,
        amount_paid: invoice.amount_paid,
        due_date: invoice.due_date,
        finalized_at: invoice.finalized_at,
        period: invoice.period,
        lines: invoice.lines.map((line) => ({
          description: line.description, explanation: line.explanation, amount: line.amount,
        })),
        payment_note: invoice.payment_note,
        footer: invoice.footer,
      },
    };
  }

  /**
   * Send a finalised invoice to the account that owes it.
   *
   * Idempotent by (invoice, kind): a bill is not emailed twice because two
   * callers both thought they were the one sending it. `force` is the resend,
   * and it is a deliberate act with its own route.
   */
  sendInvoice(orgId: string, invoiceId: string, opts: { kind?: 'invoice.issued' | 'invoice.receipt'; force?: boolean; to?: string | null } = {}, meta: WriteMeta = {}): NotificationMessage | null {
    const kind = opts.kind ?? 'invoice.issued';
    if (!opts.force) {
      const already = this.lastSent(orgId, invoiceId, kind);
      if (already) return already;
    }
    const read = this.invoiceFacts(orgId, invoiceId);
    if (!read) return null;
    const voice = this.voice(orgId);
    const to = opts.to ?? read.to.email;
    // The hosted link is minted before the body, because the body carries it.
    const token = randomId('nhl', 32);
    const hosted = to ? this.hostedUrl(token) : null;
    const composed: Composed = kind === 'invoice.receipt'
      ? invoiceReceipt(voice, read.facts, read.to, this.ctx.now(), hosted)
      : invoiceIssued(voice, read.facts, read.to, hosted);
    const message = this.sendComposed(orgId, {
      kind, to, to_name: read.to.name, customer: read.customer,
      related: { type: 'invoice', id: invoiceId }, composed, token,
      suppressed: `${read.to.name} has no billing email on file, so invoice ${read.facts.number} has not been sent to anyone.`,
    }, meta);
    return message;
  }

  /**
   * Tell the payer what the campaign just did.
   *
   * Four kinds, because a campaign makes four different decisions and each one
   * leaves the payer with a different thing to do — or nothing to do. They are
   * mutually exclusive by construction: the caller sends one notice per
   * decision, so the last refused attempt no longer produces both a "we will
   * stop trying" letter and a "we have stopped trying" letter in the same
   * millisecond.
   */
  sendDunningNotice(
    orgId: string,
    input: {
      invoiceId: string; customerId: string; facts: DunningFacts; kind: DunningNoticeKind;
      /** When the hold on a `card_needs_person` campaign runs out. */
      deadline?: number | null;
      /** When the money arrived, for a `recovered` campaign. */
      collectedAt?: number | null;
      resolution?: string | null;
      metadata?: Record<string, string>;
    },
    meta: WriteMeta = {},
  ): NotificationMessage | null {
    const customer = this.ctx.svc.billing?.customer(orgId, input.customerId);
    if (!customer) return null;
    const voice = this.voice(orgId);
    const to: Recipient = { name: customer.name, email: customer.email };
    const token = randomId('nhl', 32);
    const hosted = to.email ? this.hostedUrl(token) : null;
    const composed = input.kind === 'dunning.final_notice'
      ? dunningFinal(voice, input.facts, to, input.resolution ?? null, hosted)
      : input.kind === 'dunning.card_needs_person'
        ? dunningGaveUp(voice, input.facts, to, input.deadline ?? null, hosted)
        : input.kind === 'dunning.recovered'
          ? dunningRecovered(voice, input.facts, to, input.collectedAt ?? this.ctx.now(), hosted)
          : dunningFailed(voice, input.facts, to, hosted);
    return this.sendComposed(orgId, {
      kind: input.kind, to: to.email, to_name: to.name, customer: input.customerId,
      related: { type: 'invoice', id: input.invoiceId }, composed, token,
      metadata: input.metadata,
      suppressed: input.kind === 'dunning.recovered'
        ? `${to.name} has no billing email on file, so nobody was told the payment went through.`
        : `${to.name} has no billing email on file, so nobody was told the card was declined.`,
    }, meta);
  }

  private sendComposed(
    orgId: string,
    input: {
      kind: string; to: string | null; to_name: string; customer: string | null;
      related: { type: string; id: string }; composed: Composed; token: string; suppressed: string;
      metadata?: Record<string, string>;
    },
    meta: WriteMeta,
  ): NotificationMessage {
    return this.send(orgId, {
      channel: 'email',
      kind: input.kind,
      to: input.to,
      to_name: input.to_name,
      subject: input.composed.subject,
      text: input.composed.text,
      html: input.composed.html,
      customer: input.customer,
      related: input.related,
      suppressed_reason: input.suppressed,
      hosted_token: input.token,
      metadata: input.metadata,
    }, meta);
  }

  /* ------------------------------- signatures ---------------------------- */

  verifySignature(orgId: string, endpointId: string, payload: string, header: string, toleranceMs?: number): SignatureCheck {
    const endpoint = this.requireRow(orgId, endpointId);
    return verify({ payload, header, secret: endpoint.secret, now: this.ctx.now(), toleranceMs });
  }

  /** Sign a body the way a delivery to this endpoint would be signed. */
  signFor(orgId: string, endpointId: string, payload: string, at?: number): { header: string; timestamp: number } {
    const endpoint = this.requireRow(orgId, endpointId);
    const timestamp = at ?? this.ctx.now();
    return { header: signatureHeader(endpoint.secret, timestamp, payload), timestamp };
  }
}

/* -------------------------------- sentences ------------------------------- */

function describeEndpoint(row: EndpointRow, events: string[], counts: { pending: number; succeeded: number; failed: number }): string {
  const scope = events.includes('*')
    ? 'every event this workspace emits'
    : `${events.length} event ${events.length === 1 ? 'selector' : 'selectors'} (${events.join(', ')})`;
  if (row.status !== 'enabled') {
    return `Disabled${row.disabled_reason ? `: ${row.disabled_reason}` : '.'} It was subscribed to ${scope}.`;
  }
  if (counts.pending) {
    return `Subscribed to ${scope}. ${counts.pending} ${counts.pending === 1 ? 'delivery is' : 'deliveries are'} still on the retry ladder.`;
  }
  if (!counts.succeeded && !counts.failed) {
    return `Subscribed to ${scope}. Nothing has happened yet that it wanted.`;
  }
  return `Subscribed to ${scope}. ${counts.succeeded} acknowledged, ${counts.failed} gave up after ${MAX_DELIVERY_ATTEMPTS} attempts.`;
}

function describeDelivery(row: DeliveryRow): string {
  if (row.status === 'succeeded') {
    return `Acknowledged ${row.last_status_code} on attempt ${row.attempts}.`;
  }
  if (row.status === 'failed') {
    // A delivery stood down when its endpoint was disabled did not "give up" —
    // it was stopped, with attempts still on the ladder, and the difference is
    // the difference between a broken subscriber and an operator's decision.
    return row.attempts >= row.max_attempts
      ? `Gave up after all ${row.attempts} attempts. ${row.last_error ?? ''}`.trim()
      : `Stopped after ${row.attempts} of ${row.max_attempts} attempts. ${row.last_error ?? ''}`.trim();
  }
  if (row.attempts === 0) return 'Queued — the first attempt has not run yet.';
  return `${row.last_error ?? 'The last attempt failed.'} Attempt ${row.attempts + 1} of ${row.max_attempts} is queued.`;
}

function describeAttempt(row: AttemptRow): string {
  const took = `${row.duration_ms}ms`;
  if (row.status === 'succeeded') return `Answered ${row.response_status} in ${took}.`;
  const what = row.error ? `could not connect (${row.error})` : `answered ${row.response_status}`;
  return row.next_attempt_at
    ? `Attempt ${row.attempt} ${what} in ${took}; the next is ${formatDuration(row.next_attempt_at - row.at, 1)} later.`
    : `Attempt ${row.attempt} ${what} in ${took}, and it was the last one.`;
}

function suppressionPayload(row: SuppressionRow): SuppressedAddress {
  return {
    object: 'notification_suppression',
    id: row.id,
    channel: row.channel === 'sms' ? 'sms' : 'email',
    address: row.address,
    reason: row.reason === 'complained' ? 'complained' : row.reason === 'manual' ? 'manual' : 'bounced',
    detail: row.detail,
    bounces: row.bounces,
    last_message: row.last_message_id,
    last_bounce_at: row.last_bounce_at,
    created: row.created,
    updated: row.updated,
  };
}

/**
 * End a sentence exactly once. A relay's own reason may or may not be
 * punctuated, and quoting one inside ours produced "…no mailbox by that name.."
 * on the first address the demo ever suppressed.
 */
const sentence = (text: string): string => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** What a message blocked by the list says about itself, in the message's voice. */
function describeSuppression(row: SuppressionRow): string {
  return `${row.address} is on this workspace’s suppression list, so nothing was sent to it. ${row.detail}`;
}

function describeMessage(row: MessageRow): string {
  if (row.status === 'suppressed') return row.failed_reason ?? 'Nothing was sent — there was no address to send it to.';
  if (row.status === 'failed') return `The ${row.transport} transport refused it: ${row.failed_reason ?? 'no reason given'}.`;
  const seen = row.views
    ? ` Opened ${row.views === 1 ? 'once' : `${row.views} times`}.`
    : ' Not opened yet.';
  return `Handed to the ${row.transport} transport for ${row.to_address}.${seen}`;
}

/**
 * A signing secret. Minted from `randomBytes` at runtime — the prefix is ours,
 * so nothing here can ever be mistaken for another provider's key by a
 * push-protection scanner reading the source.
 */
function mintSecret(): string { return `whsec_${randomBytes(24).toString('base64url')}`; }

const deliveryJobKey = (deliveryId: string): string => `notifications.deliver:${deliveryId}`;

