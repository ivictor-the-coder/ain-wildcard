import type { Migration } from '../../kernel/db';

/**
 * Five tables, and the shape of them is the whole argument.
 *
 * A delivery is not an attempt. Collapsing the two — one row per endpoint per
 * event, overwritten on every retry — is what makes a webhook log useless the
 * moment it matters: the third attempt overwrites the 500 the first one came
 * back with, and nobody can say what the subscriber actually answered. So the
 * delivery carries the payload and the outcome, and every single attempt keeps
 * its own row with its own response and the signature it went out under.
 *
 * `notification_messages` holds the body as it was sent, not a template id and
 * a bag of variables. A record that says "invoice emailed" and cannot produce
 * the words is not evidence of anything, and re-rendering it later from a
 * template that has since changed produces a document nobody received.
 */
export const NOTIFICATIONS_MIGRATIONS: Migration[] = [
  {
    id: 'notifications.0001_init',
    sql: `
CREATE TABLE notification_endpoints (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'enabled',
  enabled_events TEXT NOT NULL DEFAULT '["*"]',
  secret TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  disabled_at INTEGER,
  disabled_reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_notification_endpoints_org ON notification_endpoints(org_id, status);

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  next_attempt_at INTEGER,
  delivered_at INTEGER,
  last_status_code INTEGER,
  last_error TEXT,
  -- The exact bytes that were signed. Rebuilding the envelope at read time
  -- would show a payload nobody was ever sent.
  payload TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_notification_deliveries_endpoint ON notification_deliveries(org_id, endpoint_id, created DESC);
CREATE INDEX idx_notification_deliveries_event ON notification_deliveries(org_id, event_id);
CREATE INDEX idx_notification_deliveries_status ON notification_deliveries(org_id, status, created DESC);
-- One delivery per (endpoint, event). A replayed dispatch must not queue the
-- same event twice at the same endpoint.
CREATE UNIQUE INDEX idx_notification_deliveries_pair ON notification_deliveries(org_id, endpoint_id, event_id);

CREATE TABLE notification_attempts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  signature TEXT NOT NULL,
  next_attempt_at INTEGER
);
CREATE INDEX idx_notification_attempts_delivery ON notification_attempts(org_id, delivery_id, attempt);

CREATE TABLE notification_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  to_address TEXT,
  to_name TEXT,
  from_address TEXT NOT NULL,
  subject TEXT,
  body_text TEXT NOT NULL,
  body_html TEXT,
  customer_id TEXT,
  related_type TEXT,
  related_id TEXT,
  sent_at INTEGER,
  failed_reason TEXT,
  transport TEXT NOT NULL,
  provider_id TEXT,
  -- The unguessable half of the hosted link. Held here rather than derived
  -- from the id so a message id quoted in a support thread is not a key.
  hosted_token TEXT UNIQUE,
  views INTEGER NOT NULL DEFAULT 0,
  first_viewed_at INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_notification_messages_org ON notification_messages(org_id, created DESC);
CREATE INDEX idx_notification_messages_related ON notification_messages(org_id, related_id, kind);
CREATE INDEX idx_notification_messages_customer ON notification_messages(org_id, customer_id, created DESC);

CREATE TABLE notification_settings (
  org_id TEXT PRIMARY KEY,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  reply_to TEXT,
  enabled_since INTEGER NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
`,
  },
];
