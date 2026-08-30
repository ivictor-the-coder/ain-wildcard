import type { Migration } from '../../kernel/db';

/**
 * Durable memory for the intelligence layer: conversations, every run the
 * platform has ever executed, the trace spans underneath each run, the approval
 * queue for writes an agent wanted to make, and a daily usage roll-up that the
 * billing side can charge against. All of it is `org_id` scoped and indexed for
 * the two queries the UI actually makes — newest first, and by run.
 */
export const AI_MIGRATIONS: Migration[] = [
  {
    id: 'ai.0001_init',
    sql: `
CREATE TABLE ai_threads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL,
  feature TEXT NOT NULL DEFAULT 'copilot',
  status TEXT NOT NULL DEFAULT 'open',
  subject_type TEXT,
  subject_id TEXT,
  created_by TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_ai_threads_org ON ai_threads(org_id, status, updated DESC);
CREATE INDEX idx_ai_threads_subject ON ai_threads(org_id, subject_id);

CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  citations TEXT,
  run_id TEXT,
  actor_id TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX idx_ai_messages_thread ON ai_messages(org_id, thread_id, seq);

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  thread_id TEXT,
  feature TEXT NOT NULL DEFAULT 'copilot',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  actor_id TEXT,
  actor_type TEXT NOT NULL DEFAULT 'system',
  status TEXT NOT NULL DEFAULT 'running',
  question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  intent TEXT,
  confidence REAL,
  reasoning TEXT NOT NULL DEFAULT '[]',
  citations TEXT NOT NULL DEFAULT '[]',
  steps INTEGER NOT NULL DEFAULT 0,
  span_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started INTEGER NOT NULL,
  finished INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ai_runs_org ON ai_runs(org_id, started DESC);
CREATE INDEX idx_ai_runs_thread ON ai_runs(org_id, thread_id, started DESC);
CREATE INDEX idx_ai_runs_status ON ai_runs(org_id, status, started DESC);

CREATE TABLE ai_spans (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  args TEXT,
  summary TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  error_message TEXT,
  started INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ai_spans_run ON ai_spans(org_id, run_id, seq);

CREATE TABLE ai_approvals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  thread_id TEXT,
  tool TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  outcome TEXT,
  requested_by TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  created INTEGER NOT NULL
);
CREATE INDEX idx_ai_approvals_org ON ai_approvals(org_id, status, created DESC);

CREATE TABLE ai_usage_daily (
  org_id TEXT NOT NULL,
  day TEXT NOT NULL,
  feature TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  runs INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL,
  PRIMARY KEY (org_id, day, feature, user_id, model)
);
CREATE INDEX idx_ai_usage_day ON ai_usage_daily(org_id, day);
`,
  },
];
