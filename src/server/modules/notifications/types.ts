/**
 * The wire shapes of the delivery spine.
 *
 * Two things leave this platform, and they are deliberately different objects.
 * A *delivery* is a webhook: one event, one endpoint, retried on a published
 * ladder until a machine acknowledges it. A *notification* is a message to a
 * person: one recipient, one body, sent once, and pointed at by whatever
 * record claims to have sent it. Both are rows, so "sent" is a fact with a
 * timestamp rather than a sentence in a status line.
 */

export const ENDPOINT_STATUSES = ['enabled', 'disabled'] as const;
export type EndpointStatus = typeof ENDPOINT_STATUSES[number];

export const DELIVERY_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type DeliveryStatus = typeof DELIVERY_STATUSES[number];

export const ATTEMPT_STATUSES = ['succeeded', 'failed'] as const;
export type AttemptStatus = typeof ATTEMPT_STATUSES[number];

export const MESSAGE_CHANNELS = ['email', 'sms'] as const;
export type MessageChannel = typeof MESSAGE_CHANNELS[number];

/**
 * `suppressed` is not a failure and must not be filed as one: it is the
 * platform refusing to invent a recipient. A bill for an account with no
 * billing address on file has not been sent, has not bounced, and saying
 * either would be a lie the invoice screen then repeats.
 */
export const MESSAGE_STATUSES = ['sent', 'failed', 'suppressed'] as const;
export type MessageStatus = typeof MESSAGE_STATUSES[number];

/* ------------------------------- endpoints -------------------------------- */

/**
 * Everything a consumer needs to check a signature, published on the endpoint
 * itself rather than in prose somewhere. A subscriber that cannot verify what
 * it receives is a subscriber that has to trust the network.
 */
export interface SignatureRecipe {
  header: string;
  algorithm: 'hmac-sha256';
  /** How the header reads: `t=<unix ms>,v1=<hex>`. */
  format: string;
  /** What is signed, written as the concatenation it is. */
  signed_payload: string;
  /** How far the timestamp may be from your clock before you reject it. */
  tolerance_ms: number;
  instructions: string;
}

export interface WebhookEndpoint {
  object: 'webhook_endpoint';
  id: string;
  url: string;
  description: string | null;
  status: EndpointStatus;
  /** Exact types, `invoice.*` prefixes, or `*` for everything. */
  enabled_events: string[];
  /** The signing secret is returned once, at creation and at each roll. */
  secret_last4: string;
  signature: SignatureRecipe;
  /** The published ladder, in milliseconds between attempts. */
  retry_schedule_ms: number[];
  retry_policy: string;
  max_attempts: number;
  /** Deliveries that have exhausted their attempts back to back. */
  consecutive_failures: number;
  /** How many of those disable the endpoint. */
  disable_after: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  disabled_at: number | null;
  disabled_reason: string | null;
  metadata: Record<string, string>;
  created: number;
  updated: number;
  livemode: boolean;
  /** Delivery counts by status, so a list row can say how it is going. */
  deliveries: { pending: number; succeeded: number; failed: number };
  /** One sentence an operator can act on. */
  detail: string;
}

/** The one answer that carries the secret in full. */
export interface MintedWebhookEndpoint extends WebhookEndpoint {
  secret: string;
}

export interface EndpointInput {
  url: string;
  description?: string | null;
  enabled_events?: string[];
  status?: EndpointStatus;
  metadata?: Record<string, string>;
}

export interface EndpointPatch {
  url?: string;
  description?: string | null;
  enabled_events?: string[];
  status?: EndpointStatus;
  metadata?: Record<string, string>;
}

/* ------------------------------- deliveries ------------------------------- */

/**
 * The envelope a subscriber receives. Stripe's shape, because every integrator
 * in this market has already written the code that reads it.
 */
export interface WebhookPayload {
  id: string;
  object: 'event';
  type: string;
  created: number;
  livemode: boolean;
  org: string;
  request: { id: string | null };
  actor: { id: string | null; type: string };
  data: { object: unknown; previous_attributes: Record<string, unknown> | null };
}

export interface WebhookAttempt {
  object: 'webhook_attempt';
  id: string;
  delivery: string;
  endpoint: string;
  /** 1-based; the first attempt is 1. */
  attempt: number;
  at: number;
  status: AttemptStatus;
  response_status: number | null;
  /** Truncated to what an operator can read; the transport keeps no more. */
  response_body: string | null;
  error: string | null;
  duration_ms: number;
  /** Exactly the signature header that went out, so it can be re-verified. */
  signature: string;
  /** When the next attempt was scheduled for, or null when this was the last. */
  next_attempt_at: number | null;
  summary: string;
}

export interface WebhookDelivery {
  object: 'webhook_delivery';
  id: string;
  endpoint: string;
  endpoint_url: string;
  event: string;
  event_type: string;
  status: DeliveryStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: number | null;
  delivered_at: number | null;
  last_status_code: number | null;
  last_error: string | null;
  created: number;
  updated: number;
  /** The exact bytes that were signed and sent, parsed back for reading. */
  payload: WebhookPayload;
  detail: string;
  /** Present when one delivery is retrieved, absent from list rows. */
  attempts?: WebhookAttempt[];
}

export interface DeliveryListFilter {
  endpoint?: string;
  status?: DeliveryStatus;
  event?: string;
  event_type?: string;
  limit?: number;
}

/* ------------------------------ notifications ----------------------------- */

export interface NotificationMessage {
  object: 'notification';
  id: string;
  channel: MessageChannel;
  kind: string;
  status: MessageStatus;
  /** The address it went to, or null when there was none to send to. */
  to: string | null;
  to_name: string | null;
  from: string;
  subject: string | null;
  /** The first line, for a list row. */
  preview: string;
  customer: string | null;
  related: { type: string; id: string } | null;
  sent_at: number | null;
  failed_reason: string | null;
  transport: string;
  provider_id: string | null;
  /** Where the recipient can read it without an Ain session. */
  hosted_url: string | null;
  views: number;
  first_viewed_at: number | null;
  created: number;
  updated: number;
  detail: string;
  /** Present when one message is retrieved. */
  body_text?: string;
  body_html?: string | null;
}

export interface SendInput {
  channel: MessageChannel;
  kind: string;
  to: string | null;
  to_name?: string | null;
  subject: string | null;
  text: string;
  html?: string | null;
  customer?: string | null;
  related?: { type: string; id: string } | null;
  /** Why there is nobody to send to, when `to` is null. */
  suppressed_reason?: string | null;
  /**
   * The token the body's own hosted link was built from.
   *
   * A composer has to know the link before it can put it in the letter, so the
   * token is minted there and handed down. Letting `send` mint a second one
   * stored a token nobody was sent and sent a token nobody stored — the "View
   * invoice" button in every email led to a 404.
   */
  hosted_token?: string | null;
  metadata?: Record<string, string>;
}

export interface MessageListFilter {
  channel?: MessageChannel;
  status?: MessageStatus;
  kind?: string;
  customer?: string;
  related?: string;
  limit?: number;
}

export interface NotificationSettings {
  object: 'notification_settings';
  from_name: string;
  from_email: string;
  reply_to: string | null;
  /**
   * Nothing that happened before this instant is notified. Seeding a workspace
   * writes years of finalised invoices; without this line every one of them
   * would be emailed the moment the module booted.
   */
  enabled_since: number;
  detail: string;
}

export interface SettingsPatch {
  from_name?: string;
  from_email?: string;
  reply_to?: string | null;
}

/* -------------------------------- overview -------------------------------- */

export interface NotificationsOverview {
  object: 'notifications_overview';
  endpoints: { total: number; enabled: number; disabled: number };
  deliveries: { pending: number; succeeded: number; failed: number; success_rate: number | null };
  messages: { sent: number; failed: number; suppressed: number };
  /** The transports the platform is wired to right now. */
  transports: { http: string; message: string };
  settings: NotificationSettings;
  as_of: number;
}
