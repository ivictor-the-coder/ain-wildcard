import type { Migration } from './db';

/** Kernel tables every module can rely on. */
export const CORE_MIGRATIONS: Migration[] = [
  {
    id: 'core.0001_foundation',
    sql: `
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  domain TEXT,
  logo_url TEXT,
  brand_color TEXT NOT NULL DEFAULT '#5B4BE1',
  default_currency TEXT NOT NULL DEFAULT 'usd',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  locale TEXT NOT NULL DEFAULT 'en-US',
  clock_offset INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  title TEXT,
  password_hash TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  last_seen INTEGER
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  teams TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL,
  UNIQUE (org_id, user_id)
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  last4 TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["*"]',
  livemode INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created INTEGER NOT NULL,
  last_used INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_api_keys_org ON api_keys(org_id);
CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys(token_hash);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires INTEGER NOT NULL,
  created INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  org_id TEXT NOT NULL,
  object_id TEXT,
  object_type TEXT,
  actor_id TEXT,
  actor_type TEXT NOT NULL DEFAULT 'system',
  request_id TEXT,
  created INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  previous TEXT
);
CREATE INDEX idx_events_org_created ON events(org_id, created DESC);
CREATE INDEX idx_events_object ON events(object_id, created DESC);
CREATE INDEX idx_events_type ON events(org_id, type, created DESC);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  idem_key TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_jobs_due ON jobs(status, run_at);
CREATE INDEX idx_jobs_org_type ON jobs(org_id, type, status);

CREATE TABLE idempotency_keys (
  key TEXT NOT NULL,
  org_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER,
  response TEXT,
  state TEXT NOT NULL DEFAULT 'in_progress',
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  PRIMARY KEY (org_id, key)
);
CREATE INDEX idx_idem_expiry ON idempotency_keys(expires);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT,
  actor_type TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  summary TEXT NOT NULL,
  before TEXT,
  after TEXT,
  request_id TEXT,
  ip TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX idx_audit_org_created ON audit_log(org_id, created DESC);
CREATE INDEX idx_audit_target ON audit_log(target_id, created DESC);

CREATE TABLE settings (
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (org_id, key)
);
`,
  },
];
