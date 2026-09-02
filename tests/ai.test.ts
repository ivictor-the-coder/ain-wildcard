import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { aiRuntime, DEFAULT_BUDGET, type AiCallContext } from '../src/server/ai/runtime';
import { ENGINE_MODEL } from '../src/server/ai/engine';
import { scoreTool } from '../src/server/ai/plan';
import { classifyIntent } from '../src/server/ai/intent';
import { resolveWindow, resolveWindows, reversedRange, startOfQuarter, addQuarters, unresolvedPeriods } from '../src/server/ai/dates';
import { entityIndex, workspaceProfile } from '../src/server/ai/grounding';
import { resolveEntities } from '../src/server/ai/resolve';
import { estimateTokens, accountUsage } from '../src/server/ai/usage';
import { stageSets } from '../src/server/ai/metrics';
import { businessMetric } from '../src/server/ai/functions';
import { anthropicProvider, toWire, toWireTools } from '../src/server/ai/anthropic';
import { formatMoney } from '../src/shared/money';
import v from '../src/shared/validate';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const OTHER_ORG: Auth = { ...DANA, orgId: 'org_other' };

let app: App;

const call = (method: string, path: string, body?: unknown, auth: Auth = DANA) =>
  app.handle({ method, path, body, auth });

async function expectOk(method: string, path: string, body?: unknown, auth: Auth = DANA): Promise<any> {
  const res = await call(method, path, body, auth);
  assert.ok(res.status < 400, `${method} ${path} → ${res.status} ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body;
}

const ask = async (prompt: string, extra: Record<string, unknown> = {}) =>
  expectOk('POST', '/v1/ai/complete', { prompt, ...extra });

const callContext = (over: Partial<AiCallContext> = {}): AiCallContext => ({
  ctx: app.ctx,
  orgId: ORG,
  actorId: 'usr_seed01',
  actorType: 'user',
  feature: 'test',
  runId: `run_test_${Math.random().toString(36).slice(2, 10)}`,
  spans: [],
  pendingApprovals: [],
  startedNs: process.hrtime.bigint(),
  steps: 0,
  ...over,
});

const money = (amount: number) => formatMoney({ amount, currency: 'usd' }, { locale: 'en-US', trimZeroFraction: true });

/**
 * Every account that streamed into a meter over a window — the same enumeration
 * `/v1/meters/:id/customers` publishes, read from the meter's own pre-aggregate
 * rather than from the billing book, which has no row for some of them.
 */
/** Call a registered capability directly, as the ground truth for what it holds. */
const runTool = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const execution = await aiRuntime(app.ctx).execute(name, args, callContext());
  assert.ok(execution.ok, `${name} failed: ${JSON.stringify(execution.error)}`);
  return execution.result;
};

const meterCustomerIds = (meterId: string, start: number, end: number): string[] => {
  const HOUR_MS = 3_600_000;
  return app.ctx.db.all<{ customer_id: string }>(
    `SELECT customer_id FROM meter_event_summaries
     WHERE org_id = ? AND meter_id = ? AND hour_start >= ? AND hour_start < ?
     GROUP BY customer_id`,
    ORG, meterId, Math.floor(start / HOUR_MS) * HOUR_MS, Math.ceil(end / HOUR_MS) * HOUR_MS,
  ).map((r) => r.customer_id);
};

before(async () => {
  app = await createApp({ db: 'memory', config: { env: 'test' } });
  // The runtime holds an org-level bucket; make sure every suite starts fresh.
  aiRuntime(app.ctx);
});

after(() => app.close());

/* ------------------------- grounded question answering -------------------- */

describe('the engine answers questions about the workspace', () => {
  /** A company with closed-won business in a completed quarter, found from the data. */
  async function accountWithClosedWon(): Promise<{ id: string; name: string; quarter: { start: number; end: number; label: string }; total: number }> {
    const won = await expectOk('POST', '/v1/records/deal/search', {
      filter: { property: 'deal_stage', operator: 'in', values: stageSets(app.ctx, ORG).won },
      sort: [{ property: 'amount', direction: 'desc' }],
      limit: 50,
    });
    for (const deal of won.data as { id: string; properties: Record<string, unknown> }[]) {
      const closeDate = Number(deal.properties.close_date ?? 0);
      if (!closeDate || closeDate >= app.ctx.now()) continue;
      const associations = await expectOk('GET', `/v1/records/deal/${deal.id}/associations`);
      const company = (associations.data as { object_type: string; record_id: string; display_name: string }[])
        .find((a) => a.object_type === 'company');
      if (!company) continue;
      const start = startOfQuarter(closeDate);
      const end = addQuarters(start, 1);
      const d = new Date(start);
      const label = `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
      // Independent total: the CRM's own search API, not the AI's aggregation.
      const scoped = await expectOk('POST', '/v1/records/deal/search', {
        associated_to: company.record_id,
        filter: {
          op: 'and',
          filters: [
            { property: 'deal_stage', operator: 'in', values: stageSets(app.ctx, ORG).won },
            { property: 'close_date', operator: 'between', values: [start, end - 1] },
          ],
        },
        limit: 100,
      });
      const total = (scoped.data as { properties: Record<string, unknown> }[])
        .reduce((sum, row) => sum + Number(row.properties.amount ?? 0), 0);
      if (total > 0) return { id: company.record_id, name: company.display_name, quarter: { start, end, label }, total };
    }
    throw new Error('the demo workspace has no closed-won deal in a completed quarter');
  }

  test('"how much did <account> spend in <quarter>" returns the number the records hold', async () => {
    const target = await accountWithClosedWon();
    const answer = await ask(`How much did ${target.name} spend in ${target.quarter.label}?`);

    assert.equal(answer.analysis.intent, 'aggregate', 'a "how much" question is an aggregate');
    assert.equal(answer.analysis.metric.id, 'spend');
    assert.equal(answer.analysis.window.label, target.quarter.label, 'the quarter in the question is the quarter measured');
    assert.equal(answer.analysis.subject.id, target.id, `resolved to ${answer.analysis.subject?.label}, expected ${target.name}`);
    assert.ok(
      answer.content.includes(money(target.total)),
      `expected the answer to state ${money(target.total)}, got:\n${answer.content}`,
    );
    assert.ok(answer.content.includes(target.name));
    assert.ok(answer.citations.some((c: { id: string }) => c.id === target.id), 'the answer cites the account it measured');
  });

  test('open pipeline agrees with the CRM to the cent', async () => {
    // Open stages come from the pipeline definition, so adding a stage to the
    // CRM can never silently drop deals out of either side of this comparison.
    const stages = stageSets(app.ctx, ORG);
    assert.ok(stages.open.length >= 4, 'the workspace defines open stages');
    const open = await expectOk('POST', '/v1/records/deal/search', {
      filter: { property: 'deal_stage', operator: 'in', values: stages.open },
      limit: 200,
    });
    const expected = (open.data as { properties: Record<string, unknown> }[])
      .reduce((sum, row) => sum + Number(row.properties.amount ?? 0), 0);
    assert.ok(expected > 0, 'the demo pipeline should not be empty');

    const answer = await ask('What is our open pipeline by stage?');
    assert.ok(answer.content.includes(money(expected)), `expected ${money(expected)} in:\n${answer.content}`);
    assert.equal(answer.analysis.metric.id, 'pipeline');
    assert.equal(answer.analysis.group_by, 'stage');
  });

  test('a metric with no rows says zero instead of inventing one', async () => {
    const companies = await expectOk('GET', '/v1/records/company?limit=100');
    const prospect = (companies.data as { id: string; display_name: string; properties: Record<string, unknown> }[])
      .find((c) => c.properties.type === 'prospect');
    assert.ok(prospect, 'the seed should contain prospects');
    const answer = await ask(`How much did ${prospect!.display_name} spend in Q1 2019?`);
    assert.match(answer.content, /no customer spend recorded|zero/i);
    assert.doesNotMatch(answer.content.split('\n')[0], /\$[1-9]/, 'the headline must not carry an invented amount');
  });

  test('an account question answers with owner, pipeline and committee from the record', async () => {
    const companies = await expectOk('GET', '/v1/records/company?limit=50');
    const company = (companies.data as { id: string; display_name: string }[])[0];
    const detail = await expectOk('GET', `/v1/records/company/${company.id}`);
    const answer = await ask(`Tell me about ${company.display_name}`);
    assert.ok(answer.content.includes(company.display_name));
    assert.equal(answer.analysis.subject.id, company.id);
    if (detail.properties.employee_count) {
      assert.ok(
        answer.content.includes(Number(detail.properties.employee_count).toLocaleString('en-US')),
        'the headline should quote the real employee count',
      );
    }
  });

  test('every number in an answer is backed by a citation to a record', async () => {
    const answer = await ask('What is our open pipeline?');
    assert.ok(answer.citations.length > 0);
    for (const citation of answer.citations) {
      const row = app.ctx.db.get<{ id: string }>(
        `SELECT id FROM crm_records WHERE org_id = ? AND id = ?`, ORG, citation.id);
      assert.ok(row, `citation ${citation.id} (${citation.label}) does not point at a real record`);
    }
  });
});

/* --------------------------- intent classification ------------------------ */

describe('intent classification', () => {
  const cases: [string, string][] = [
    ['Show me the Halstead Precision record', 'lookup'],
    ['How much did we book last quarter?', 'aggregate'],
    ['Compare Q1 and Q2 bookings', 'compare'],
    ['Why did pipeline fall in July?', 'explain'],
    ['Draft a follow-up email to Priya', 'draft'],
    ['Summarise what happened with Ironwood this month', 'summarise'],
    ['What should we do about the Aldergate renewal?', 'plan'],
    ['Create a task to call the plant manager', 'act'],
    ['The edge agent keeps failing on Line 4', 'troubleshoot'],
  ];

  for (const [message, expected] of cases) {
    test(`"${message}" → ${expected}`, () => {
      const result = classifyIntent(message);
      assert.equal(result.intent, expected, `signals: ${result.signals.map((s) => `${s.id}=${s.applied}`).join(', ')}`);
      assert.ok(result.confidence > 0.3);
      assert.ok(result.signals.length > 0, 'the classifier must report which signals fired');
    });
  }

  test('negation flips a signal instead of firing it', () => {
    const result = classifyIntent("Don't draft an email, just tell me the total spend for Kestrel");
    assert.equal(result.intent, 'aggregate');
    const draftSignal = result.signals.find((s) => s.intent === 'draft');
    assert.ok(draftSignal, 'the drafting words were still detected');
    assert.equal(draftSignal!.negated, true, 'and were recognised as negated');
    assert.ok(draftSignal!.applied < 0, 'a negated signal counts against its intent');
    assert.ok(result.negations.some((n) => n.cue.startsWith("don't")));
  });

  test('"without drafting anything" does not make it a drafting task', () => {
    const result = classifyIntent('Give me the pipeline number without drafting anything');
    assert.notEqual(result.intent, 'draft');
    assert.equal(result.signals.find((s) => s.intent === 'draft')?.negated, true);
  });

  test('a caller hint is evidence, not a command', () => {
    const hinted = classifyIntent('How much did we book last quarter?', 'draft');
    assert.equal(hinted.intent, 'aggregate', 'strong signals outvote a weak hint');
    const weak = classifyIntent('Northwind', 'draft');
    assert.equal(weak.intent, 'draft', 'with no signals the hint decides');
  });

  test('periods resolve against the workspace clock, not the wall clock', () => {
    const now = Date.UTC(2026, 4, 17);
    const lastQuarter = resolveWindow('how did we do last quarter', now);
    assert.ok(lastQuarter);
    assert.equal(lastQuarter!.label, 'Q1 2026');
    assert.equal(lastQuarter!.start, Date.UTC(2026, 0, 1));
    assert.equal(lastQuarter!.end, Date.UTC(2026, 3, 1));

    const thirty = resolveWindow('in the last 30 days', now);
    assert.equal(thirty!.end - thirty!.start, 30 * 24 * 3600 * 1000);

    const named = resolveWindow('bookings in Q3 2025', now);
    assert.equal(named!.start, Date.UTC(2025, 6, 1));
    assert.equal(resolveWindow('what happened today', now)!.grain, 'day');
    assert.equal(resolveWindow('who owns this account', now), null, 'no time words means no window');
  });
});

/* ---------------------------- entity resolution --------------------------- */

describe('entity resolution beats substring matching', () => {
  test('resolves names substring search cannot reach', () => {
    const index = entityIndex(app.ctx, ORG);
    const companies = app.ctx.db.all<{ id: string; display_name: string; properties: string }>(
      `SELECT id, display_name, properties FROM crm_records WHERE org_id = ? AND object_type = 'company'`, ORG);
    const byName = (needle: string) => companies.find((c) => c.display_name.toLowerCase().includes(needle));

    const meridian = byName('meridian');
    const calder = byName('calder');
    const northgate = byName('northgate');
    const pemberton = byName('pemberton');
    const kestrel = byName('kestrel');
    assert.ok(meridian && calder && northgate && pemberton && kestrel, 'seed companies are present');

    const fixtures: { query: string; expect: string; why: string }[] = [
      { query: 'How much did MFS spend last quarter?', expect: meridian!.id, why: 'acronym' },
      { query: 'calder and vance pipeline', expect: calder!.id, why: '"and" for "&"' },
      { query: 'open tickets for nortgate chemical', expect: northgate!.id, why: 'misspelling' },
      { query: `anything new from ${JSON.parse(pemberton!.properties).domain}?`, expect: pemberton!.id, why: 'domain' },
      { query: 'summarise Kestrel before the call', expect: kestrel!.id, why: 'first word of a long legal name' },
      { query: 'MERIDIAN FORGE SYSTEMS renewal', expect: meridian!.id, why: 'case difference' },
      { query: `what is happening with ${meridian!.id}`, expect: meridian!.id, why: 'record id' },
      { query: 'pemberton auto', expect: pemberton!.id, why: 'partial name' },
    ];

    let resolved = 0;
    let substring = 0;
    for (const fixture of fixtures) {
      const hits = resolveEntities(fixture.query, index, { prefer: ['company'], dedupe: true, limit: 3 });
      const top = hits.find((h) => h.entity.type === 'company');
      if (top?.entity.id === fixture.expect) resolved++;
      const haystack = fixture.query.toLowerCase();
      const naive = companies.filter((c) => haystack.includes(c.display_name.toLowerCase()));
      if (naive.length === 1 && naive[0].id === fixture.expect) substring++;
    }

    assert.ok(resolved >= 7, `resolver got ${resolved}/${fixtures.length}`);
    assert.ok(substring <= 3, `substring matching got ${substring}/${fixtures.length}, which would make this test meaningless`);
    assert.ok(resolved > substring + 2, `resolver ${resolved} vs substring ${substring}`);
  });

  test('reports the rule and the mention behind every match', () => {
    const index = entityIndex(app.ctx, ORG);
    const hits = resolveEntities('how is Brightline Foods doing', index, { prefer: ['company'], limit: 2 });
    assert.ok(hits.length);
    assert.ok(hits[0].score > 0.6);
    assert.ok(['name_exact', 'core_exact', 'alias_exact', 'prefix', 'token_subset'].includes(hits[0].rule));
    assert.match(hits[0].explain, /Brightline Foods/);
    assert.ok(hits[0].mention.toLowerCase().includes('brightline'));
  });

  test('business vocabulary is never mistaken for a record', () => {
    const index = entityIndex(app.ctx, ORG);
    for (const query of ['how much revenue did we book last quarter', 'what is the total pipeline this month', 'show me open tickets']) {
      const hits = resolveEntities(query, index, { prefer: ['company'], limit: 3 });
      assert.equal(hits.filter((h) => h.entity.type === 'company').length, 0, `"${query}" resolved to a company`);
    }
  });

  test('an ambiguous mention returns ranked candidates rather than a guess', () => {
    const index = entityIndex(app.ctx, ORG);
    const hits = resolveEntities('precision', index, { prefer: ['company'], limit: 5 });
    if (hits.length > 1) {
      assert.ok(hits[0].score >= hits[1].score, 'candidates come back ranked');
    }
    assert.ok(hits.every((h) => h.score >= 0.46), 'weak matches are dropped, not returned');
  });
});

/* ------------------------------ tool runtime ------------------------------ */

describe('the tool runtime', () => {
  test('exposes a catalogue with schemas', async () => {
    const tools = await expectOk('GET', '/v1/ai/tools');
    assert.ok(tools.data.length >= 8);
    const metric = tools.data.find((t: { name: string }) => t.name === 'business_metric');
    assert.ok(metric, 'the metric tool is registered');
    assert.equal(metric.read_only, true);
    assert.equal(metric.input_schema.type, 'object');
    assert.ok(metric.input_schema.fields.metric);
    const write = tools.data.find((t: { name: string }) => t.name === 'schedule_followup');
    assert.equal(write.read_only, false);
    assert.equal(write.requires_approval, true);
  });

  test('validates arguments and returns a typed, recoverable error', async () => {
    const runtime = aiRuntime(app.ctx);
    const execution = await runtime.execute('business_metric', { metric: 42 }, callContext());
    assert.equal(execution.ok, false);
    assert.equal(execution.error?.code, 'invalid_arguments');
    assert.equal(execution.error?.param, 'metric');
    assert.equal(execution.error?.recoverable, true);
    assert.equal(execution.span.ok, false);
    assert.equal(execution.span.errorCode, 'invalid_arguments');
  });

  test('an unknown tool names the ones that exist', async () => {
    const runtime = aiRuntime(app.ctx);
    const execution = await runtime.execute('teleport', {}, callContext());
    assert.equal(execution.error?.code, 'tool_not_found');
    assert.match(execution.error!.message, /account_profile|business_metric/);
  });

  test('write tools are blocked in a read-only run', async () => {
    const runtime = aiRuntime(app.ctx);
    const execution = await runtime.execute('schedule_followup', {
      record_id: 'cmp_missing', in_days: 3, note: 'check in',
    }, callContext({ allowWrites: false }));
    assert.equal(execution.ok, false);
    assert.equal(execution.error?.code, 'write_not_permitted');
  });

  test('write tools stop at the approval gate and raise an approval request', async () => {
    const runtime = aiRuntime(app.ctx);
    const company = app.ctx.db.get<{ id: string }>(
      `SELECT id FROM crm_records WHERE org_id = ? AND object_type = 'company' LIMIT 1`, ORG)!;
    const runId = `run_gate_${app.ctx.now()}`;
    app.ctx.db.insert('ai_runs', {
      id: runId, org_id: ORG, thread_id: null, feature: 'test', provider: 'builtin', model: 'ain-engine-1',
      actor_id: 'usr_seed01', actor_type: 'user', status: 'running', question: 'gate', answer: '',
      reasoning: '[]', citations: '[]', started: app.ctx.now(),
    });
    const jobsBefore = app.ctx.db.count(`SELECT COUNT(*) FROM jobs WHERE type = 'ai.followup'`);

    const execution = await runtime.execute('schedule_followup', {
      record_id: company.id, in_days: 5, note: 'Confirm the pilot line before the QBR',
    }, callContext({ runId, allowWrites: true }));

    assert.equal(execution.ok, false);
    assert.equal(execution.error?.code, 'approval_required');
    assert.equal(
      app.ctx.db.count(`SELECT COUNT(*) FROM jobs WHERE type = 'ai.followup'`), jobsBefore,
      'nothing was written while the tool waits for approval',
    );

    const pending = await expectOk('GET', '/v1/ai/approvals');
    const approval = pending.data.find((a: { run_id: string }) => a.run_id === runId);
    assert.ok(approval, 'the gate created an approval request');
    assert.equal(approval.tool, 'schedule_followup');
    assert.equal(approval.args.note, 'Confirm the pilot line before the QBR');

    const events = app.ctx.events.list(ORG, { types: ['ai.approval.requested'], limit: 5 });
    assert.ok(events.length > 0, 'ai.approval.requested was emitted');

    const decided = await expectOk('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(decided.status, 'approved');
    assert.equal(decided.executed, true);
    assert.equal(
      app.ctx.db.count(`SELECT COUNT(*) FROM jobs WHERE type = 'ai.followup'`), jobsBefore + 1,
      'approving actually ran the tool',
    );
    assert.ok(app.ctx.events.list(ORG, { types: ['ai.approval.granted'], limit: 3 }).length > 0);

    // The scheduled work is a durable job, so run it and check what it writes.
    const job = app.ctx.db.get<{ id: string; org_id: string; type: string; payload: string; run_at: number; attempts: number; max_attempts: number; status: string; last_error: string | null; idem_key: string | null; created: number; updated: number }>(
      `SELECT * FROM jobs WHERE type = 'ai.followup' AND status = 'pending' ORDER BY created DESC LIMIT 1`)!;
    assert.ok(job.run_at > app.ctx.now(), 'the follow-up is scheduled, not immediate');
    const outcome = await app.ctx.jobs.runOne({ ...job, payload: JSON.parse(job.payload) } as never, app.ctx.now());
    assert.equal(outcome, 'ok');
    assert.ok(app.ctx.events.list(ORG, { types: ['ai.followup.due'], limit: 3 }).length > 0, 'the follow-up raised its event');
    const note = app.ctx.db.get<{ display_name: string }>(
      `SELECT display_name FROM crm_records WHERE org_id = ? AND object_type = 'note' AND display_name LIKE 'Follow-up:%' ORDER BY created DESC LIMIT 1`, ORG);
    assert.ok(note, 'the follow-up wrote a note onto the timeline');
    assert.match(note!.display_name, /Confirm the pilot line/);
  });

  test('a declined approval never runs', async () => {
    const runtime = aiRuntime(app.ctx);
    const company = app.ctx.db.get<{ id: string }>(
      `SELECT id FROM crm_records WHERE org_id = ? AND object_type = 'company' LIMIT 1`, ORG)!;
    const runId = `run_decline_${app.ctx.now()}`;
    app.ctx.db.insert('ai_runs', {
      id: runId, org_id: ORG, thread_id: null, feature: 'test', provider: 'builtin', model: 'ain-engine-1',
      actor_id: 'usr_seed01', actor_type: 'user', status: 'running', question: 'decline', answer: '',
      reasoning: '[]', citations: '[]', started: app.ctx.now(),
    });
    await runtime.execute('schedule_followup', { record_id: company.id, in_days: 9, note: 'Do not do this' },
      callContext({ runId, allowWrites: true }));
    const pending = await expectOk('GET', '/v1/ai/approvals');
    const approval = pending.data.find((a: { run_id: string }) => a.run_id === runId);
    const jobsBefore = app.ctx.db.count(`SELECT COUNT(*) FROM jobs WHERE type = 'ai.followup'`);
    const decided = await expectOk('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'decline', note: 'Not now' });
    assert.equal(decided.status, 'declined');
    assert.equal(app.ctx.db.count(`SELECT COUNT(*) FROM jobs WHERE type = 'ai.followup'`), jobsBefore);
    const again = await call('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(again.status, 400, 'a decided approval cannot be re-decided');
  });

  test('the step budget stops a runaway loop', async () => {
    const runtime = aiRuntime(app.ctx);
    const context = callContext({ budget: { steps: 2 } });
    const first = await runtime.execute('business_metric', { metric: 'pipeline' }, context);
    const second = await runtime.execute('business_metric', { metric: 'pipeline' }, context);
    const third = await runtime.execute('business_metric', { metric: 'pipeline' }, context);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(third.ok, false);
    assert.equal(third.error?.code, 'step_budget_exhausted');
    assert.equal(third.error?.recoverable, false);
  });

  test('the per-org rate limit refuses rather than queues', async () => {
    const runtime = aiRuntime(app.ctx);
    const context = callContext({ orgId: 'org_ratelimit', budget: { steps: 50, callsPerMinute: 3 } });
    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push(await runtime.execute('business_metric', { metric: 'pipeline' }, context));
    }
    assert.ok(outcomes.some((o) => o.error?.code === 'rate_limited'), 'the bucket eventually empties');
  });

  test('spans redact secrets and summarise results', async () => {
    const runtime = aiRuntime(app.ctx);
    const execution = await runtime.execute('workspace_search', { query: 'Brightline', limit: 3 }, callContext());
    assert.equal(execution.ok, true);
    assert.equal(execution.span.kind, 'tool');
    assert.ok(execution.span.durationMs >= 0);
    assert.match(execution.span.summary, /matches|query/);
    const redacted = await runtime.execute('workspace_search', { query: 'x', limit: 1 }, callContext({
      runId: 'run_redaction_probe',
    }));
    assert.ok(redacted.span.args);
  });

  test('the tool loop terminates inside the budget the caller set', async () => {
    const answer = await ask('Summarise the state of the business and tell me what to do next', { max_steps: 3 });
    const run = await expectOk('GET', `/v1/ai/runs/${answer.run_id}`);
    assert.ok(run.steps <= 3, `ran ${run.steps} steps against a budget of 3`);
    assert.equal(run.status, 'succeeded');
    assert.ok(run.duration_ms >= 0);
    assert.ok(answer.content.length > 40);
  });
});

/* ---------------------------- runs, traces, threads ----------------------- */

describe('runs and traces', () => {
  test('a completion is stored with a complete, ordered trace', async () => {
    const answer = await ask('How is the pipeline looking by stage?');
    const run = await expectOk('GET', `/v1/ai/runs/${answer.run_id}`);

    assert.equal(run.status, 'succeeded');
    assert.equal(run.provider, 'builtin');
    assert.equal(run.model, 'ain-engine-1');
    assert.equal(run.intent, 'aggregate');
    assert.ok(run.confidence > 0.3);
    assert.ok(run.reasoning.length >= 5, 'the reasoning trace explains each decision');
    assert.ok(run.trace.length >= 4, 'plan, resolve, tool and synthesis spans are all recorded');

    const kinds = new Set(run.trace.map((s: { kind: string }) => s.kind));
    assert.ok(kinds.has('plan'));
    assert.ok(kinds.has('tool'));
    assert.ok(kinds.has('synthesis'));

    const seqs = run.trace.map((s: { seq: number }) => s.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'spans are ordered');
    for (const span of run.trace) {
      assert.ok(typeof span.duration_ms === 'number');
      assert.ok(span.summary.length > 0, `span ${span.name} has no summary`);
    }
    assert.ok(run.timings.total_ms >= run.timings.tool_ms);
    assert.equal(run.span_count, run.trace.length);
  });

  test('run lifecycle events are emitted', async () => {
    const before = app.ctx.events.list(ORG, { types: ['ai.run.completed'], limit: 1 })[0]?.created ?? 0;
    const answer = await ask('What is our win rate this year?');
    const started = app.ctx.events.list(ORG, { types: ['ai.run.started'], limit: 20 });
    const completed = app.ctx.events.list(ORG, { types: ['ai.run.completed'], limit: 20 });
    assert.ok(started.some((e) => e.object_id === answer.run_id), 'ai.run.started names the run');
    assert.ok(completed.some((e) => e.object_id === answer.run_id), 'ai.run.completed names the run');
    assert.ok((completed[0]?.created ?? 0) >= before);
  });

  test('runs are listed newest first and filterable', async () => {
    const list = await expectOk('GET', '/v1/ai/runs?limit=5');
    assert.ok(list.data.length > 0);
    assert.ok(list.total_count >= list.data.length);
    const timestamps = list.data.map((r: { started: number }) => r.started);
    assert.deepEqual(timestamps, [...timestamps].sort((a, b) => b - a));
    const succeeded = await expectOk('GET', '/v1/ai/runs?status=succeeded&limit=3');
    assert.ok(succeeded.data.every((r: { status: string }) => r.status === 'succeeded'));
  });

  test('another workspace cannot see these runs', async () => {
    const mine = await expectOk('GET', '/v1/ai/runs?limit=1');
    const theirs = await expectOk('GET', '/v1/ai/runs?limit=5', undefined, OTHER_ORG);
    assert.equal(theirs.data.length, 0, 'runs are org scoped');
    const stolen = await call('GET', `/v1/ai/runs/${mine.data[0].id}`, undefined, OTHER_ORG);
    assert.equal(stolen.status, 404);
  });
});

describe('durable conversations', () => {
  test('a thread keeps its history and each turn is answered from data', async () => {
    const thread = await expectOk('POST', '/v1/ai/threads', {
      message: 'What is our open pipeline by stage?',
    });
    assert.equal(thread.object, 'ai_thread');
    assert.equal(thread.messages.length, 2);
    assert.equal(thread.messages[0].role, 'user');
    assert.equal(thread.messages[1].role, 'assistant');
    assert.ok(thread.messages[1].run_id, 'the assistant turn points at its run');
    assert.ok(thread.messages[1].citations.length > 0);

    const reply = await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, {
      content: 'And how many open tickets do we have?',
    });
    assert.equal(reply.object, 'ai_reply');
    assert.ok(reply.message.content.length > 20);

    const loaded = await expectOk('GET', `/v1/ai/threads/${thread.id}`);
    assert.equal(loaded.message_count, 4);
    assert.equal(loaded.messages.length, 4);
    assert.deepEqual(loaded.messages.map((m: { seq: number }) => m.seq), [1, 2, 3, 4]);
    assert.equal(loaded.runs.length, 2, 'both turns produced a run');

    const messages = await expectOk('GET', `/v1/ai/threads/${thread.id}/messages`);
    assert.equal(messages.data.length, 4);

    const threads = await expectOk('GET', '/v1/ai/threads?limit=10');
    assert.ok(threads.data.some((t: { id: string }) => t.id === thread.id));
  });

  test('a follow-up resolves the account named in an earlier turn', async () => {
    const companies = await expectOk('GET', '/v1/records/company?limit=20');
    const company = (companies.data as { id: string; display_name: string }[])[1];
    const thread = await expectOk('POST', '/v1/ai/threads', { message: `Tell me about ${company.display_name}` });
    const reply = await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, {
      content: 'What is the open pipeline there?',
    });
    const run = await expectOk('GET', `/v1/ai/runs/${reply.run_id}`);
    assert.ok(
      run.citations.some((c: { id: string }) => c.id === company.id) || reply.message.content.includes(company.display_name),
      'the second turn still knows which account we are discussing',
    );
  });
});

/* --------------------------------- usage ---------------------------------- */

describe('usage accounting', () => {
  test('token estimation and credit maths are stable and documented', () => {
    assert.equal(estimateTokens(''), 0);
    assert.ok(estimateTokens('hello world') >= 2);
    const long = estimateTokens('a'.repeat(4000));
    assert.ok(long > 400 && long < 1400, `estimate for 4k chars was ${long}`);

    const local = accountUsage('ain-engine-1', 1000, 500);
    assert.equal(local.costMicros, 0, 'the local engine has no marginal cost');
    assert.equal(local.usage.credits, Math.ceil((1000 + 1500) / 1000));

    const hosted = accountUsage('claude-sonnet-4-5', 1_000_000, 100_000);
    assert.equal(hosted.usage.costCents, 300 + 150);
    assert.ok(Number.isInteger(hosted.usage.costCents), 'money stays in integer minor units');
  });

  test('every run adds to the daily usage roll-up', async () => {
    const before = await expectOk('GET', '/v1/ai/usage?days=2');
    await ask('How many meetings did we hold this quarter?');
    const after = await expectOk('GET', '/v1/ai/usage?days=2');
    assert.equal(after.totals.runs, before.totals.runs + 1);
    assert.ok(after.totals.credits > before.totals.credits);
    assert.ok(after.by_day.length > 0);
    assert.ok(after.by_feature.some((f: { key: string }) => f.key === 'copilot'));
    assert.ok(after.by_user.some((u: { key: string; name: string }) => u.key === 'usr_seed01' && u.name === 'Dana Whitfield'));
    assert.ok(after.by_model.some((m: { key: string }) => m.key === 'ain-engine-1'));

    const runs = await expectOk('GET', '/v1/ai/runs?limit=100');
    const credited = runs.data.reduce((sum: number, r: { usage: { credits: number } }) => sum + r.usage.credits, 0);
    assert.ok(credited >= after.totals.credits - 1, 'the roll-up tracks the runs it came from');
  });

  test('status reports the active provider and what it can reach', async () => {
    const status = await expectOk('GET', '/v1/ai/status');
    assert.equal(status.provider.id, 'builtin', 'with no API key the built-in engine answers');
    assert.equal(status.provider.hosted, false);
    assert.ok(status.providers.some((p: { id: string; available: boolean }) => p.id === 'anthropic' && p.available === false));
    assert.ok(status.tools >= 8);
    assert.ok(status.metrics >= 10);
    assert.ok(status.runs_today > 0);
  });
});

/* --------------------------- extraction and drafting ---------------------- */

describe('structured extraction', () => {
  test('fills a schema from the workspace and never invents a field', async () => {
    const companies = await expectOk('GET', '/v1/records/company?limit=5');
    const company = (companies.data as { id: string; display_name: string }[])[0];
    const schema = v.object({
      company: v.string(),
      company_id: v.string(),
      period: v.string(),
      amount: v.int(),
      sentiment: v.enum(['positive', 'neutral', 'negative'] as const),
      next_steps: v.array(v.string()),
    }).describe();

    const answer = await ask(`What is the open pipeline for ${company.display_name}?`, { response_schema: schema });
    const parsed = JSON.parse(answer.content);
    assert.equal(parsed.company, company.display_name);
    assert.equal(parsed.company_id, company.id);
    assert.ok(typeof parsed.amount === 'number' || parsed.amount === null);
    assert.ok(['positive', 'neutral', 'negative'].includes(parsed.sentiment));
    assert.ok(Array.isArray(parsed.next_steps));
    assert.ok(answer.reasoning.some((line: string) => line.includes('schema')));
  });
});

describe('drafting', () => {
  test('writes an email personalised from the account record', async () => {
    const companies = await expectOk('GET', '/v1/records/company?limit=30');
    const company = (companies.data as { id: string; display_name: string; properties: Record<string, unknown> }[])
      .find((c) => c.properties.type === 'customer')!;
    const draft = await expectOk('POST', '/v1/ai/draft', {
      instruction: 'Write a renewal email',
      record_id: company.id,
      tone: 'formal',
    });
    assert.equal(draft.channel, 'email');
    assert.equal(draft.kind, 'renewal');
    assert.ok(draft.subject.includes(company.display_name));
    assert.match(draft.body, /^Dear /m, 'a formal tone opens formally');
    assert.ok(draft.personalisation.length > 0, 'the draft lists the facts it used');
    assert.ok(draft.personalisation.some((p: string) => p.includes(company.display_name)));
  });

  test('a drafting question produces a message, not a report', async () => {
    const companies = await expectOk('GET', '/v1/records/company?limit=30');
    const company = (companies.data as { id: string; display_name: string }[])[2];
    const answer = await ask(`Draft a warm check-in email to ${company.display_name}`);
    assert.equal(answer.analysis.intent, 'draft');
    assert.equal(answer.analysis.draft_kind, 'check_in');
    assert.match(answer.content, /^Subject: /);
    assert.ok(answer.content.includes('Thanks') || answer.content.includes('Best') || answer.content.includes('regards'));
  });

  test('a call summary is built from the timeline, not from thin air', async () => {
    const withActivity = app.ctx.db.get<{ id: string; display_name: string }>(
      `SELECT r.id, r.display_name FROM crm_records r
       JOIN crm_record_values v ON v.record_id = r.id AND v.property = 'activity_count'
       WHERE r.org_id = ? AND r.object_type = 'company' AND v.value_number > 3
       ORDER BY v.value_number DESC LIMIT 1`, ORG)!;
    const draft = await expectOk('POST', '/v1/ai/draft', {
      instruction: 'Give me the call summary',
      record_id: withActivity.id,
    });
    assert.equal(draft.kind, 'call_summary');
    assert.ok(draft.body.length > 40);
  });
});

/* ------------------------------- suggestions ------------------------------ */

describe('the copilot offers grounded starting points', () => {
  test('suggestions name real records and explain themselves', async () => {
    const suggestions = await expectOk('GET', '/v1/ai/suggestions');
    assert.ok(suggestions.data.length >= 3);
    for (const suggestion of suggestions.data) {
      assert.ok(suggestion.question.length > 10);
      assert.ok(suggestion.why.length > 10, 'each suggestion says why it is being offered');
    }
    const answered = await ask(suggestions.data[0].question);
    assert.ok(answered.content.length > 30, 'the copilot can actually answer its own suggestion');
  });

  test('the metric catalogue is published', async () => {
    const metrics = await expectOk('GET', '/v1/ai/metrics');
    const ids = metrics.data.map((m: { id: string }) => m.id);
    for (const expected of ['spend', 'pipeline', 'closed_won', 'win_rate', 'open_tickets', 'mrr']) {
      assert.ok(ids.includes(expected), `${expected} is missing from the catalogue`);
    }
    const pipeline = metrics.data.find((m: { id: string }) => m.id === 'pipeline');
    assert.equal(pipeline.unit, 'money');
    assert.equal(pipeline.snapshot, true);
  });
});

/* --------------------------------- errors --------------------------------- */

describe('the API refuses bad input clearly', () => {
  test('a completion needs a prompt or messages', async () => {
    const res = await call('POST', '/v1/ai/complete', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'missing_prompt');
    assert.equal(res.body.error.param, 'prompt');
  });

  test('an unknown thread is a 404, not a crash', async () => {
    const res = await call('POST', '/v1/ai/threads/thr_nope/messages', { content: 'hello' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.type, 'not_found_error');
  });

  test('an unknown metric answers with the ones that exist', async () => {
    const runtime = aiRuntime(app.ctx);
    const execution = await runtime.execute('business_metric', { metric: 'vibes' }, callContext());
    assert.equal(execution.ok, true, 'the tool ran; the argument was simply not a known metric');
    const result = execution.result as { error?: string; available?: string[] };
    assert.match(String(result.error), /Unknown metric/);
    assert.ok(result.available?.includes('pipeline'));
  });

  test('the workspace profile drives formatting', () => {
    const workspace = workspaceProfile(app.ctx, ORG);
    assert.equal(workspace.currency, 'usd');
    assert.equal(workspace.timezone, 'America/New_York');
    assert.ok(workspace.people.length >= 5);
    assert.equal(workspace.now, app.ctx.now(), 'time comes from the workspace clock');
  });
});

/* ----------------------------- hosted provider ---------------------------- */

describe('the hosted provider', () => {
  test('is unavailable without a key, so the built-in engine answers', () => {
    const provider = app.ctx.ai.providers.find((p) => p.id === 'anthropic')!;
    assert.ok(provider, 'the Anthropic provider is registered');
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(provider.available(), false);
    assert.equal(app.ctx.ai.active().id, 'builtin');
  });

  test('maps conversations, tool calls and tool results onto the wire format', () => {
    const wire = toWire([
      { role: 'assistant', content: 'ignored leading turn' },
      { role: 'system', content: 'be useful' },
      { role: 'user', content: 'what is our pipeline?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tu_1', name: 'business_metric', arguments: { metric: 'pipeline' } }] },
      { role: 'tool', content: '{"value":100}', tool_call_id: 'tu_1' },
    ]);
    assert.equal(wire.system, 'be useful');
    assert.equal(wire.messages[0].role, 'user', 'a leading assistant turn is dropped');
    const toolUse = wire.messages[1].content as { type: string; id?: string; name?: string }[];
    assert.equal(toolUse[0].type, 'tool_use');
    assert.equal(toolUse[0].name, 'business_metric');
    const toolResult = wire.messages[2].content as { type: string; tool_use_id?: string }[];
    assert.equal(toolResult[0].type, 'tool_result');
    assert.equal(toolResult[0].tool_use_id, 'tu_1');

    const schemas = toWireTools(app.ctx.ai.tools({ readOnly: true }).slice(0, 2));
    assert.ok(schemas.length === 2);
    assert.equal(schemas[0].input_schema.type, 'object');
    assert.ok(schemas[0].description.length > 20);
  });

  test('runs the real HTTP tool-use loop, streams, and never leaks the key', async () => {
    const runtime = aiRuntime(app.ctx);
    const received: { path: string; key: string | undefined; body: any; accept: string | undefined }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        received.push({
          path: req.url ?? '', key: req.headers['x-api-key'] as string | undefined,
          body, accept: req.headers.accept as string | undefined,
        });
        const wantsStream = !!body.stream;
        const first = received.length === 1;
        if (first) {
          const payload = {
            id: 'msg_1', model: 'claude-sonnet-4-5',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'business_metric', input: { metric: 'pipeline' } }],
            stop_reason: 'tool_use', usage: { input_tokens: 900, output_tokens: 40 },
          };
          if (!wantsStream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); return; }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end([
            `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: { input_tokens: 900 } } })}`,
            `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'business_metric' } })}`,
            `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"metric":"pipeline"}' } })}`,
            `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
            `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } })}`,
            '',
          ].join('\n\n'));
          return;
        }
        const text = 'Open pipeline is what the tool returned.';
        if (!wantsStream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_2', model: 'claude-sonnet-4-5', content: [{ type: 'text', text }],
            stop_reason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 60 },
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end([
          `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_2', model: 'claude-sonnet-4-5', usage: { input_tokens: 1200 } } })}`,
          `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
          `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
          `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
          `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 60 } })}`,
          '',
        ].join('\n\n'));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const secret = 'sk-ant-test-do-not-log-me';
    process.env.ANTHROPIC_API_KEY = secret;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;

    try {
      const provider = anthropicProvider(app.ctx.config);
      assert.equal(provider.available(), true, 'a key makes the hosted provider available');

      const deltas: string[] = [];
      const context = callContext({ runId: 'run_hosted_probe', budget: { steps: 4 }, onDelta: (text) => deltas.push(text) });
      context.runtime = runtime;
      app.ctx.db.insert('ai_runs', {
        id: 'run_hosted_probe', org_id: ORG, thread_id: null, feature: 'test', provider: 'anthropic',
        model: 'claude-sonnet-4-5', actor_id: 'usr_seed01', actor_type: 'user', status: 'running',
        question: 'pipeline', answer: '', reasoning: '[]', citations: '[]', started: app.ctx.now(),
      });

      const completion = await provider.complete({
        messages: [{ role: 'user', content: 'What is our open pipeline?' }],
        tools: app.ctx.ai.tools({ readOnly: true }),
      }, context);

      assert.equal(received.length, 2, 'the loop ran the tool and came back for the answer');
      assert.equal(received[0].key, secret, 'the key travels in the header');
      assert.ok(received[0].body.tools.some((t: { name: string }) => t.name === 'business_metric'));
      assert.equal(received[0].body.model, 'claude-sonnet-4-5');
      assert.ok(received[1].body.messages.some((m: { content: unknown }) =>
        Array.isArray(m.content) && (m.content as { type: string }[]).some((b) => b.type === 'tool_result')),
        'the tool result was fed back to the model');

      assert.equal(completion.content, 'Open pipeline is what the tool returned.');
      assert.equal(completion.model, 'claude-sonnet-4-5');
      assert.equal(completion.toolCalls[0].name, 'business_metric');
      assert.equal(completion.usage.inputTokens, 2100);
      assert.equal(completion.usage.outputTokens, 100);
      assert.equal(completion.usage.costCents, accountUsage('claude-sonnet-4-5', 2100, 100).usage.costCents);
      assert.ok(deltas.join('').includes('Open pipeline'), 'text arrived as stream deltas');

      const executed = context.spans!.filter((s) => s.kind === 'tool' && s.name === 'business_metric');
      assert.equal(executed.length, 1, 'the hosted provider goes through the same tool runtime');
      assert.equal(executed[0].ok, true);

      const serialised = JSON.stringify({ reasoning: completion.reasoning, spans: context.spans });
      assert.ok(!serialised.includes(secret), 'the key never reaches the trace');

      const stored = app.ctx.db.all<{ args: string; summary: string }>(
        `SELECT args, summary FROM ai_spans WHERE run_id = 'run_hosted_probe'`);
      assert.ok(stored.length > 0, 'spans from a hosted run are persisted like any other');
      assert.ok(!JSON.stringify(stored).includes(secret));
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('a provider error surfaces as an API error with the key scrubbed', async () => {
    const secret = 'sk-ant-another-secret';
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `invalid key ${secret}` } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    process.env.ANTHROPIC_API_KEY = secret;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    try {
      const provider = anthropicProvider(app.ctx.config);
      await assert.rejects(
        () => provider.complete({ messages: [{ role: 'user', content: 'hello' }] }, callContext()),
        (error: Error) => {
          assert.match(error.message, /401/);
          assert.ok(!error.message.includes(secret), 'the key is scrubbed from provider errors');
          return true;
        },
      );
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('the time budget stops a run that has already spent it', async () => {
    const runtime = aiRuntime(app.ctx);
    const context = callContext({ budget: { timeMs: 0 }, startedNs: process.hrtime.bigint() - 5_000_000_000n });
    const execution = await runtime.execute('business_metric', { metric: 'pipeline' }, context);
    assert.equal(execution.ok, false);
    assert.equal(execution.error?.code, 'time_budget_exhausted');
  });
});

/* ------------------- the comparison the question asked for ---------------- */

const quarterLabelOf = (ts: number): string =>
  `Q${Math.floor(new Date(ts).getUTCMonth() / 3) + 1} ${new Date(ts).getUTCFullYear()}`;

/** Closed-won read straight off the records, with none of the engine in the path. */
function closedWonBetween(start: number, end: number): { total: number; count: number } {
  const won = stageSets(app.ctx, ORG).won;
  let total = 0;
  let count = 0;
  for (const row of app.ctx.db.all<{ properties: string }>(
    `SELECT properties FROM crm_records WHERE org_id = ? AND object_type = 'deal'`, ORG)) {
    const properties = JSON.parse(row.properties) as { deal_stage?: string; close_date?: number; amount?: number };
    if (!won.includes(String(properties.deal_stage))) continue;
    const closedAt = Number(properties.close_date ?? 0);
    if (closedAt < start || closedAt >= end) continue;
    total += Number(properties.amount ?? 0);
    count += 1;
  }
  return { total, count };
}

describe('a comparison measures both periods the question names', () => {
  /** The last two finished quarters, so the test follows the workspace clock. */
  const finishedQuarters = () => {
    const current = startOfQuarter(app.ctx.now());
    const first = addQuarters(current, -2);
    const second = addQuarters(current, -1);
    return {
      first: { start: first, end: second, label: quarterLabelOf(first) },
      second: { start: second, end: current, label: quarterLabelOf(second) },
      before: quarterLabelOf(addQuarters(first, -1)),
    };
  };

  test('every period in the question resolves, in the order it was written', () => {
    const now = Date.UTC(2026, 7, 30);
    const windows = resolveWindows('Compare Q1 2026 and Q2 2026 bookings', now);
    assert.deepEqual(windows.map((w) => w.label), ['Q1 2026', 'Q2 2026']);
    assert.equal(windows[0].start, Date.UTC(2026, 0, 1));
    assert.equal(windows[0].end, Date.UTC(2026, 3, 1));
    assert.equal(windows[1].start, Date.UTC(2026, 3, 1));
    assert.equal(windows[1].end, Date.UTC(2026, 6, 1));
    // Stopping at the first rule that matched is what made "Q1 2026 vs Q2 2026"
    // answer with Q1 against Q4 2025.
    assert.ok(!windows.some((w) => w.label === 'Q4 2025'), 'the second period is the one that was named');
    assert.equal(resolveWindow('Compare Q1 2026 and Q2 2026 bookings', now)!.label, 'Q1 2026');
  });

  test('overlapping period phrases are read leftmost-longest, not twice', () => {
    const now = Date.UTC(2026, 7, 30);
    assert.deepEqual(resolveWindows('bookings in March 2025', now).map((w) => w.label), ['March 2025']);
    assert.deepEqual(
      resolveWindows('deals between 2026-01-01 and 2026-03-31 versus Q2 2026', now).map((w) => w.grain),
      ['range', 'quarter'],
    );
  });

  test('two named quarters are both measured, and the delta is between exactly those two', async () => {
    const { first, second, before } = finishedQuarters();
    const expectedFirst = closedWonBetween(first.start, first.end);
    const expectedSecond = closedWonBetween(second.start, second.end);
    assert.ok(expectedFirst.count > 0 && expectedSecond.count > 0,
      `the seed has closed-won business in both ${first.label} and ${second.label}`);

    const answer = await ask(`Compare ${first.label} and ${second.label} bookings`);

    assert.deepEqual(answer.analysis.windows.map((w: { label: string }) => w.label), [first.label, second.label]);
    assert.equal(answer.analysis.comparison.source, 'both_named');
    assert.equal(answer.analysis.comparison.a.start, first.start);
    assert.equal(answer.analysis.comparison.b.start, second.start);

    const measured = answer.analysis.plan.filter((step: { tool: string }) => step.tool === 'business_metric');
    assert.equal(measured.length, 2, 'a two-period comparison plans two measurements');
    assert.deepEqual(measured.map((s: { args: Record<string, unknown> }) => s.args.window_label), [first.label, second.label]);
    assert.deepEqual(measured.map((s: { args: Record<string, unknown> }) => [s.args.start, s.args.end]),
      [[first.start, first.end], [second.start, second.end]]);
    for (const step of measured) {
      assert.equal(step.args.compare, false,
        'each window is measured on its own, so the delta is between the two named periods');
    }

    // Derived from the rows, not from the engine's formula: the period the
    // question named first is the subject, the second is what it is measured
    // against, and a subject that booked less can only be down on it. Computing
    // the expectation the way the code computes it is how a comparison shipped
    // reporting an 81% collapse as 435% growth with a green suite.
    const richer = expectedFirst.total >= expectedSecond.total ? first.label : second.label;
    const direction = expectedFirst.total > expectedSecond.total ? 'up'
      : expectedFirst.total < expectedSecond.total ? 'down' : 'level';
    const delta = expectedFirst.total - expectedSecond.total;
    const percent = Number(((delta / Math.abs(expectedSecond.total)) * 100).toFixed(1));
    const expectedLine =
      `Northwind Robotics booked ${money(expectedFirst.total)} in ${first.label} and ${money(expectedSecond.total)} in ${second.label}`
      + ` — ${first.label} is ${direction} ${money(Math.abs(delta))} (${percent > 0 ? '+' : ''}${percent}%) on ${second.label}.`;
    assert.ok(answer.content.startsWith(expectedLine),
      `expected the answer to open with:\n${expectedLine}\ngot:\n${answer.content.slice(0, 300)}`);
    assert.equal(richer === first.label, direction === 'up',
      'the period that booked more is the one the answer calls the higher of the two');
    assert.ok(!answer.content.includes(`${first.label} is ${direction === 'up' ? 'down' : 'up'}`),
      `the direction is stated once, and it is not the opposite of the rows:\n${answer.content.slice(0, 300)}`);
    assert.match(answer.content, new RegExp(`${first.label}: \\${money(expectedFirst.total)} from ${expectedFirst.count} closed-won`));
    assert.match(answer.content, new RegExp(`${second.label}: \\${money(expectedSecond.total)} from ${expectedSecond.count} closed-won`));
    assert.ok(!answer.content.includes(before),
      `the answer must not quote ${before}, which nobody asked about`);
  });

  test('a third named period is named back, not dropped in silence', async () => {
    const current = startOfQuarter(app.ctx.now());
    const labels = [3, 2, 1].map((back) => quarterLabelOf(addQuarters(current, -back)));
    const answer = await ask(`Compare bookings between ${labels[0]}, ${labels[1]} and ${labels[2]}`);

    assert.deepEqual(answer.analysis.windows.map((w: { label: string }) => w.label), labels,
      'all three periods parse, which is exactly why dropping one silently was the bug');
    assert.ok(answer.content.includes(labels[0]) && answer.content.includes(labels[1]));
    assert.ok(answer.content.includes(labels[2]),
      `${labels[2]} was named by the caller and must appear in the answer, got:\n${answer.content}`);
    assert.match(answer.content, new RegExp(`You named three periods; I compared ${labels[0]} and ${labels[1]} and left ${labels[2]} out`));
    assert.match(answer.content, /Ask again naming two/);
  });

  test('a two-period comparison says nothing about periods it did not drop', async () => {
    const { first, second } = finishedQuarters();
    const answer = await ask(`Compare ${first.label} and ${second.label} bookings`);
    assert.ok(!/You named/.test(answer.content),
      `nothing was dropped, so there is nothing to apologise for:\n${answer.content}`);
  });

  test('"the same period last year" compares a quarter with that quarter, never with a year', async () => {
    const { second } = finishedQuarters();
    const answer = await ask(`How did bookings in ${second.label} compare with the same period last year?`);
    assert.equal(answer.analysis.comparison.source, 'year_over_year');
    assert.equal(answer.analysis.comparison.a.label, second.label);
    const lastYear = `${second.label.split(' ')[0]} ${Number(second.label.split(' ')[1]) - 1}`;
    assert.equal(answer.analysis.comparison.b.label, lastYear);
    const span = (w: { start: number; end: number }) => w.end - w.start;
    assert.ok(Math.abs(span(answer.analysis.comparison.b) - span(answer.analysis.comparison.a)) <= 86_400_000,
      'a quarter is compared with a quarter, not with a whole year');
    assert.match(answer.content, new RegExp(`${second.label}.*${lastYear}`));
  });

  test('one named period still compares against the period before it', async () => {
    const { second } = finishedQuarters();
    const answer = await ask(`Compare ${second.label} bookings`);
    assert.equal(answer.analysis.comparison.source, 'preceding_period');
    assert.equal(answer.analysis.comparison.a.label, second.label);
  });
});

/* --------------------------- the tool allowlist --------------------------- */

describe('the tool allowlist is enforced, not advisory', () => {
  test('a run scoped to one tool reaches no other, and says so instead of answering anyway', async () => {
    const answer = await ask('How did bookings do last quarter?', { tools: ['workspace_search'] });
    assert.deepEqual(answer.analysis.scoped_tools, ['workspace_search']);
    assert.deepEqual(answer.tool_calls, [], 'nothing outside the allowlist ran');
    const ran = answer.trace.filter((s: { kind: string }) => s.kind === 'tool').map((s: { name: string }) => s.name);
    assert.deepEqual(ran.filter((name: string) => name !== 'workspace_search'), [],
      `a scoped run reached ${ran.join(', ')}`);
    assert.ok(!answer.analysis.plan.some((step: { tool: string }) => step.tool !== 'workspace_search'),
      'the allowlist filters the plan, not just the tools the model is offered');
    assert.match(answer.content, /scoped to `workspace_search`/);
    assert.ok(!/booked \$/.test(answer.content), 'a scoped-away metric is not quietly computed anyway');

    const stored = await expectOk('GET', `/v1/ai/runs/${answer.run_id}`);
    assert.equal(stored.trace.filter((s: { kind: string; name: string }) => s.kind === 'tool' && s.name === 'business_metric').length, 0);
  });

  test('the runtime refuses a scoped-away tool even when a provider asks for it by name', async () => {
    const runtime = aiRuntime(app.ctx);
    const execution = await runtime.execute('business_metric', { metric: 'pipeline' },
      callContext({ restrictTools: ['workspace_search'] }));
    assert.equal(execution.ok, false, 'the allowlist is enforced at the runtime, not only at the planner');
    assert.equal(execution.error?.code, 'tool_not_permitted');
    assert.equal(execution.error?.recoverable, false);
    assert.match(execution.error!.message, /scoped to "workspace_search"/);
    assert.equal(execution.span.ok, false);
    assert.equal(execution.span.errorCode, 'tool_not_permitted');
  });

  test('an empty allowlist means no tools at all', async () => {
    const answer = await ask('How did bookings do last quarter?', { tools: [] });
    assert.deepEqual(answer.analysis.scoped_tools, []);
    assert.deepEqual(answer.tool_calls, []);
    assert.equal(answer.trace.filter((s: { kind: string }) => s.kind === 'tool').length, 0);
    assert.match(answer.content, /scoped to no tools at all/);

    const execution = await aiRuntime(app.ctx).execute('workspace_search', { query: 'Rheinwerk' },
      callContext({ restrictTools: [] }));
    assert.equal(execution.ok, false);
    assert.equal(execution.error?.code, 'tool_not_permitted');
  });

  test('an unknown tool name is a 400 that names the catalogue, not a silent drop', async () => {
    const res = await call('POST', '/v1/ai/complete', {
      prompt: 'How did bookings do last quarter?',
      tools: ['workspace_search', 'exfiltrate_everything'],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'unknown_tool');
    assert.equal(res.body.error.param, 'tools');
    assert.match(res.body.error.message, /exfiltrate_everything/);
    assert.match(res.body.error.message, /workspace_search/);
  });

  test('a thread reply is scoped by the same allowlist as a bare completion', async () => {
    const thread = await expectOk('POST', '/v1/ai/threads', { title: 'Scoped agent' });
    const reply = await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, {
      content: 'How did bookings do last quarter?',
      tools: ['workspace_search'],
    });
    const stored = await expectOk('GET', `/v1/ai/runs/${reply.run_id}`);
    const ran = stored.trace.filter((s: { kind: string }) => s.kind === 'tool').map((s: { name: string }) => s.name);
    assert.deepEqual(ran.filter((name: string) => name !== 'workspace_search'), []);
  });
});

/* ------------------- writes to a customer's own record -------------------- */

describe('a write to a customer record is approved by a person and never carries the prompt', () => {
  const noteCount = () => app.ctx.db.count(
    `SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'note'`, ORG);

  const rheinwerk = () => app.ctx.db.get<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM crm_records WHERE org_id = ? AND object_type = 'company' AND display_name LIKE 'Rheinwerk%'`,
    ORG)!;

  test('add_note stops at the approval gate and composes the note, never the instruction', async () => {
    const account = rheinwerk();
    const before = noteCount();
    const instruction = 'Add a note to Rheinwerk saying the pilot slipped to October';
    const answer = await ask(instruction, { allow_writes: true });

    assert.equal(answer.finish_reason, 'tool_calls');
    assert.equal(answer.pending_approvals.length, 1, 'a customer-visible write never runs unasked');
    const pending = answer.pending_approvals[0];
    assert.equal(pending.tool, 'add_note');
    assert.equal(pending.readOnly, false);
    assert.deepEqual(pending.args.record_ids, [account.id]);
    assert.equal(pending.args.body, 'The pilot slipped to October.');
    assert.equal(pending.args.subject, 'Pilot slipped to October');
    assert.ok(!/add a note|saying/i.test(String(pending.args.body)),
      `the instruction wrapper reached the record: ${String(pending.args.body)}`);
    assert.notEqual(String(pending.args.body).trim(), instruction);
    assert.equal(noteCount(), before, 'nothing is written while the approval waits');
    assert.match(answer.content, /needs your approval first\. Nothing has been written\./);

    const queue = await expectOk('GET', '/v1/ai/approvals');
    const approval = queue.data.find((a: { run_id: string }) => a.run_id === answer.run_id);
    assert.ok(approval, 'the gate raised an approval request a person can see');
    assert.deepEqual(approval.args.record_ids, [account.id]);

    const decided = await expectOk('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(decided.status, 'approved');
    assert.equal(decided.executed, true);
    assert.equal(noteCount(), before + 1);
    const note = app.ctx.db.get<{ display_name: string; properties: string }>(
      `SELECT display_name, properties FROM crm_records WHERE org_id = ? AND object_type = 'note' ORDER BY created DESC LIMIT 1`,
      ORG)!;
    const properties = JSON.parse(note.properties) as { body?: string; subject?: string };
    assert.equal(properties.body, 'The pilot slipped to October.');
    assert.ok(!/add a note/i.test(String(properties.body)), 'the timeline reads as a note, not as a prompt');
    assert.ok(!/add a note/i.test(note.display_name));
  });

  test('a note with no content is refused rather than pasted into a customer timeline', async () => {
    const before = noteCount();
    const answer = await ask('Add a note to Rheinwerk', { allow_writes: true });
    assert.deepEqual(answer.pending_approvals, []);
    assert.equal(answer.analysis.write_blocked.wanted, 'add_note');
    assert.match(answer.analysis.write_blocked.reason, /the note has no content/);
    assert.match(answer.content, /I changed nothing/);
    assert.equal(noteCount(), before);
  });

  test('a read-only run prepares no write at all and says how to ask for one', async () => {
    const before = noteCount();
    const answer = await ask('Add a note to Rheinwerk saying the pilot slipped to October');
    assert.deepEqual(answer.pending_approvals, []);
    assert.equal(answer.analysis.write_blocked.wanted, 'add_note');
    assert.match(answer.content, /this run is read-only/);
    assert.equal(noteCount(), before);
  });

  test('a write is never chosen by relevance — only planWrite may propose one', () => {
    const addNote = app.ctx.ai.tools().find((tool) => tool.name === 'add_note')!;
    assert.equal(addNote.readOnly, false);
    assert.equal(
      scoreTool(addNote, { question: 'add a note to Rheinwerk about the delayed pilot', intent: 'act', types: ['company'] }),
      0,
      'a write that sounds relevant is still not planned by the generic matcher',
    );
    const search = app.ctx.ai.tools().find((tool) => tool.name === 'workspace_search')!;
    assert.ok(scoreTool(search, { question: 'search the workspace for Rheinwerk', intent: 'lookup', types: [] }) > 0);
  });
});

/* --------------------- approvals re-check before running ------------------ */

describe('an approval re-validates its arguments before it executes', () => {
  const noteCount = () => app.ctx.db.count(
    `SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'note'`, ORG);

  const approvalRow = (id: string) => app.ctx.db.get<{ status: string; outcome: string | null }>(
    `SELECT status, outcome FROM ai_approvals WHERE org_id = ? AND id = ?`, ORG, id)!;

  test('arguments that went stale between proposal and approval are declined, not run', async () => {
    const before = noteCount();
    const answer = await ask('Add a note to Rheinwerk saying the shipment cleared customs', { allow_writes: true });
    const queue = await expectOk('GET', '/v1/ai/approvals');
    const approval = queue.data.find((a: { run_id: string }) => a.run_id === answer.run_id);
    assert.ok(approval);

    // The arguments a person is about to approve no longer satisfy the tool's
    // own schema, whatever changed underneath them to make that true.
    app.ctx.db.run(`UPDATE ai_approvals SET args = ? WHERE org_id = ? AND id = ?`,
      JSON.stringify({ record_ids: [], subject: 'Shipment cleared customs', body: 'The shipment cleared customs.' }),
      ORG, approval.id);

    const res = await call('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(res.status, 400, 'a malformed write is refused at execution time, not only at proposal time');
    assert.equal(res.body.error.code, 'approval_arguments_invalid');
    assert.equal(res.body.error.param, 'args');
    assert.equal(noteCount(), before, 'nothing was written with the bad arguments');
    const row = approvalRow(approval.id);
    assert.equal(row.status, 'declined');
    assert.match(String(row.outcome), /^Blocked: /);
    assert.ok(app.ctx.events.list(ORG, { types: ['ai.approval.declined'], limit: 5 })
      .some((e) => (e.data as { id?: string }).id === approval.id), 'the refusal is on the event log');
  });

  test('the record the note names is deleted while the approval waits, and the write does not land', async () => {
    // A company created for this test so the deletion cannot disturb the seed
    // every other suite reads.
    const company = await expectOk('POST', '/v1/records/company', {
      properties: { name: 'Tolvaneer Kraftwerk', domain: 'tolvaneer.de', type: 'customer' },
    });
    const before = noteCount();
    const answer = await ask(`Add a note to Tolvaneer Kraftwerk saying "The shipment cleared customs."`, { allow_writes: true });
    const queue = await expectOk('GET', '/v1/ai/approvals');
    const approval = queue.data.find((a: { run_id: string }) => a.run_id === answer.run_id);
    assert.ok(approval, 'the write was queued rather than executed');
    assert.deepEqual(approval.args.record_ids, [company.id]);
    assert.ok(approval.preview.some((line: string) => line.includes('Tolvaneer Kraftwerk')),
      `the approval card names the record, got ${JSON.stringify(approval.preview)}`);
    assert.ok(!approval.preview.some((line: string) => RAW_ID_IN_PROSE.test(line)),
      `the approval card must not show a raw id: ${JSON.stringify(approval.preview)}`);
    assert.equal(noteCount(), before, 'nothing is written while the approval is pending');

    // The record moves under the approval — exactly the scenario the queue
    // exists to survive.
    const deleted = await call('DELETE', `/v1/records/company/${company.id}`);
    assert.equal(deleted.status, 204);

    const res = await call('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(res.status, 400, 'approving a write onto a record that is gone must fail');
    assert.equal(res.body.error.code, 'approval_target_changed');
    assert.match(res.body.error.message, /Tolvaneer Kraftwerk has been archived/);
    assert.equal(noteCount(), before, 'the note count is unchanged: nothing was written');
    assert.equal(app.ctx.db.count(
      `SELECT COUNT(*) FROM crm_associations WHERE org_id = ? AND (from_id = ? OR to_id = ?)`,
      ORG, company.id, company.id), 0, 'no association was written to the deleted record');
    assert.equal(approvalRow(approval.id).status, 'declined');
    assert.match(String(approvalRow(approval.id).outcome), /Blocked: Tolvaneer Kraftwerk has been archived/);
    assert.ok(app.ctx.events.list(ORG, { types: ['ai.approval.declined'], limit: 5 })
      .some((e) => (e.data as { reason?: string }).reason === 'target_changed'),
      'the refusal names why on the event log');
  });

  test('an approval whose target is still there executes and writes exactly one note', async () => {
    const before = noteCount();
    const answer = await ask('Add a note to Brightline Foods saying "The acceptance run finished clean."', { allow_writes: true });
    const queue = await expectOk('GET', '/v1/ai/approvals');
    const approval = queue.data.find((a: { run_id: string }) => a.run_id === answer.run_id);
    assert.ok(approval);
    const res = await expectOk('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(res.executed, true, 'a live target is not blocked by the freshness check');
    assert.equal(noteCount(), before + 1);
  });

  test('an approval whose tool is no longer registered is declined rather than executed', async () => {
    const runId = `run_retired_${app.ctx.now()}`;
    app.ctx.db.insert('ai_runs', {
      id: runId, org_id: ORG, thread_id: null, feature: 'test', provider: 'builtin', model: ENGINE_MODEL,
      actor_id: 'usr_seed01', actor_type: 'user', status: 'needs_approval', question: 'retired tool', answer: '',
      reasoning: '[]', citations: '[]', started: app.ctx.now(),
    });
    const id = `appr_retired_${app.ctx.now()}`;
    app.ctx.db.insert('ai_approvals', {
      id, org_id: ORG, run_id: runId, thread_id: null, tool: 'retired_integration_write',
      args: JSON.stringify({ record_ids: ['cmp_nw_21'], body: 'anything' }),
      reason: 'left over from a plugin that has been uninstalled', status: 'pending',
      outcome: null, requested_by: 'usr_seed01', decided_by: null, decided_at: null, created: app.ctx.now(),
    });

    const res = await call('POST', `/v1/ai/approvals/${id}`, { decision: 'approve' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'tool_unavailable');
    assert.equal(approvalRow(id).status, 'declined');
    assert.match(String(approvalRow(id).outcome), /no tool named "retired_integration_write"/);
  });

  test('a declined approval cannot be revived by approving it again', async () => {
    const answer = await ask('Add a note to Rheinwerk saying the acceptance test passed', { allow_writes: true });
    const queue = await expectOk('GET', '/v1/ai/approvals');
    const approval = queue.data.find((a: { run_id: string }) => a.run_id === answer.run_id);
    await expectOk('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'decline', note: 'Not this quarter' });
    const again = await call('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'approval_decided');
  });
});

/* ------------------------- providers degrade, never die ------------------- */

describe('a failing provider degrades to the local engine instead of taking the product down', () => {
  /** Not a credential: the platform's own inert placeholder shape. */
  const FAKE_KEY = 'ain_demo_key_not_a_real_credential';

  type Handler = (req: IncomingMessage, res: ServerResponse) => void;

  async function withProvider(handler: Handler | null, run: () => Promise<void>) {
    const server = handler ? createServer(handler) : null;
    if (server) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server ? (server.address() as AddressInfo).port : 1;
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    try { await run(); }
    finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test('a 401 from the hosted provider still answers, and the record names who answered', async () => {
    await withProvider((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } }));
    }, async () => {
      assert.equal(app.ctx.ai.active().id, 'anthropic', 'the hosted provider is preferred while a key is set');

      const answer = await ask('How did bookings do last quarter?');
      assert.equal(answer.provider, 'builtin', 'a bad key degrades the answer instead of 401ing the surface');
      assert.equal(answer.model, ENGINE_MODEL);
      assert.equal(answer.degraded.provider, 'anthropic');
      assert.equal(answer.degraded.answeredBy, 'builtin');
      assert.match(answer.degraded.message, /401/);
      assert.ok(!answer.degraded.message.includes(FAKE_KEY), 'the key never reaches the degradation notice');
      assert.match(answer.content, /booked \$/, 'the local engine answered the question for real');
      assert.match(answer.reasoning[0], /Answered by builtin instead — this answer is degraded/);

      const providerSpan = answer.trace.find((s: { kind: string }) => s.kind === 'provider');
      assert.ok(providerSpan, 'the failed provider is on the trace');
      assert.equal(providerSpan.ok, false);
      assert.equal(providerSpan.name, 'anthropic');

      const stored = await expectOk('GET', `/v1/ai/runs/${answer.run_id}`);
      assert.equal(stored.status, 'succeeded');
      assert.equal(stored.provider, 'builtin');
      assert.equal(stored.model, ENGINE_MODEL);
      assert.equal(stored.usage.cost_micros, 0, 'a local answer is never billed at hosted rates');
      assert.ok(!JSON.stringify(stored).includes(FAKE_KEY));
    });
  });

  test('an unreachable provider degrades the same way', async () => {
    await withProvider(null, async () => {
      const answer = await ask('What is our open pipeline?');
      assert.equal(answer.provider, 'builtin');
      assert.equal(answer.degraded.provider, 'anthropic');
      assert.match(answer.degraded.code, /ai_provider_(unreachable|error)/);
      assert.ok(answer.content.length > 40);
    });
  });

  test('the AI surface stays up while the hosted provider is down', async () => {
    await withProvider((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'overloaded' } }));
    }, async () => {
      for (const path of ['/v1/ai/status', '/v1/ai/tools', '/v1/ai/suggestions', '/v1/ai/metrics']) {
        const res = await call('GET', path);
        assert.equal(res.status, 200, `${path} went down with the provider`);
      }
      const status = await expectOk('GET', '/v1/ai/status');
      assert.ok(status.providers.some((p: { id: string; available: boolean }) => p.id === 'builtin' && p.available));
      const answer = await ask('Which support tickets need attention today?');
      assert.equal(answer.provider, 'builtin');
      assert.equal(answer.degraded.answeredBy, 'builtin');
    });
  });
});

/* ------------------------- refusing beats inventing ----------------------- */

describe('the engine says what it did not do', () => {
  test('an act request that resolves to no write reports that, instead of reporting success', async () => {
    const answer = await ask('Add a note', { allow_writes: true });
    assert.ok(!/^Done/.test(answer.content), `an empty act reported success: ${answer.content.slice(0, 120)}`);
    assert.match(answer.content, /^I changed nothing\./);
    assert.equal(answer.analysis.write_blocked.wanted, 'add_note');
    assert.match(answer.analysis.write_blocked.reason, /needs a record to write to/);
    assert.deepEqual(answer.tool_calls, []);
    assert.deepEqual(answer.pending_approvals, []);
  });

  test('a write that cannot name the property to set says which one it needed', async () => {
    const answer = await ask('Update the Rheinwerk deal', { allow_writes: true });
    assert.ok(!/^Done/.test(answer.content));
    assert.match(answer.content, /I changed nothing/);
    assert.equal(answer.analysis.write_blocked.wanted, 'update_record');
    assert.match(answer.analysis.write_blocked.reason, /could not tell which property to set/);
  });

  test('a write that ran and failed says so, and names the failure', async () => {
    // A caller's own write tool, offered to this run only. It goes through the
    // same gates as a registered one — and when it throws, the answer must
    // report the failure rather than the intention.
    const failing = {
      name: 'add_note',
      description: 'Write a note onto the timeline of a CRM record.',
      readOnly: false,
      input: v.object({
        record_ids: v.array(v.string({ max: 80 }), { min: 1, max: 20 }),
        subject: v.optional(v.string({ max: 300 })),
        body: v.string({ min: 1, max: 20_000 }),
      }),
      run: () => { throw new Error('the timeline is read-only during the migration'); },
    };
    const completion = await app.ctx.svc.ai.complete(ORG, {
      messages: [{ role: 'user', content: 'Add a note to Rheinwerk saying the migration window opens on Monday' }],
      tools: [failing],
    }, { allowWrites: true, approvals: ['add_note'], actorId: 'usr_seed01' });

    assert.ok(!/^Done/.test(completion.content), `a failed write reported success: ${completion.content.slice(0, 120)}`);
    assert.match(completion.content, /^I changed nothing: add_note failed \(tool_failed\)/);
    assert.match(completion.content, /the timeline is read-only during the migration/);
    assert.equal(
      app.ctx.db.count(
        `SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'note' AND display_name LIKE '%migration window%'`,
        ORG),
      0,
    );
  });

  test('a write that did land says "Done" and names exactly what it wrote', async () => {
    const answer = await ask('Add a note to Rheinwerk saying the acceptance run finished clean', {
      allow_writes: true, approvals: ['add_note'],
    });
    assert.match(answer.content, /^Done — note on rheinwerk/i);
    assert.deepEqual(answer.tool_calls.map((c: { name: string }) => c.name), ['add_note']);
  });
});

/**
 * A primary key standing where a name belongs. Nothing an answer says out loud
 * may match this — the ids live in `analysis`, `citations` and the approval
 * arguments, where a machine reads them.
 */
const RAW_ID_IN_PROSE = /\b(?:cmp|con|deal|tkt|cus|note|task|act|inv|sub|usr|prod)_[A-Za-z0-9][A-Za-z0-9_]{1,}\b/;

/* -------------- a ranking question gets a ranking, with money ------------- */

describe('the question a revenue leader actually asks is answered with a ranking', () => {
  const RANKING: string[] = [
    'Which accounts booked the most in 2025?',
    'Top 5 customers by revenue in 2025',
    'Who is my biggest customer?',
    'Which companies booked the most in 2026?',
  ];

  for (const prompt of RANKING) {
    test(`"${prompt}" returns a ranked answer with money in it`, async () => {
      const answer = await ask(prompt);
      assert.equal(answer.analysis.refusal, null, `"${prompt}" was refused: ${answer.content.slice(0, 200)}`);
      assert.ok(CURRENCY.test(answer.content),
        `a ranking question must come back with money, got:\n${answer.content}`);
      assert.match(answer.content, /^\s*\S.*\bis the biggest by\b/m,
        `the answer must lead with who is biggest, got:\n${answer.content}`);
      assert.match(answer.content, /^1\. /m, 'the ranking is numbered');
      assert.ok(!/The most recent:/.test(answer.content),
        'a ranking question must never fall through to a listing ordered by recency');
      assert.ok(!RAW_ID_IN_PROSE.test(answer.content),
        `no raw id belongs in a ranked answer, got:\n${answer.content}`);
    });
  }

  test('the ranking is the workspace\'s own closed-won order, computed from the records', async () => {
    const answer = await ask('Which accounts booked the most in 2025?');
    const start = Date.UTC(2025, 0, 1);
    const end = Date.UTC(2026, 0, 1);
    const won = stageSets(app.ctx, ORG).won;
    const byCompany = new Map<string, { name: string; total: number }>();
    for (const deal of app.ctx.db.all<{ id: string; properties: string }>(
      `SELECT id, properties FROM crm_records WHERE org_id = ? AND object_type = 'deal' AND archived = 0`, ORG)) {
      const properties = JSON.parse(deal.properties) as { deal_stage?: string; close_date?: number; amount?: number };
      if (!won.includes(String(properties.deal_stage))) continue;
      const closedAt = Number(properties.close_date ?? 0);
      if (closedAt < start || closedAt >= end) continue;
      const company = app.ctx.db.get<{ to_id: string; display_name: string }>(
        `SELECT a.to_id, r.display_name FROM crm_associations a JOIN crm_records r ON r.id = a.to_id
         WHERE a.org_id = ? AND a.from_id = ? AND a.to_type = 'company' LIMIT 1`, ORG, deal.id);
      if (!company) continue;
      const held = byCompany.get(company.to_id) ?? { name: company.display_name, total: 0 };
      held.total += Number(properties.amount ?? 0);
      byCompany.set(company.to_id, held);
    }
    const ranked = [...byCompany.values()].sort((a, b) => b.total - a.total);
    assert.ok(ranked.length >= 3, 'the seed has at least three accounts with 2025 bookings');
    assert.ok(answer.content.startsWith(`${ranked[0].name} is the biggest`),
      `expected ${ranked[0].name} at the top, got:\n${answer.content.slice(0, 200)}`);
    for (const row of ranked.slice(0, 3)) {
      assert.ok(answer.content.includes(`${row.name} — ${money(row.total)}`),
        `expected "${row.name} — ${money(row.total)}" in:\n${answer.content}`);
    }
    const positions = ranked.slice(0, 3).map((row) => answer.content.indexOf(row.name));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'the rows are in descending order');
  });

  test('"top 5" shows five per book, and says how many it left out', async () => {
    const answer = await ask('Top 5 customers by revenue in 2025');
    // Northwind bills in three currencies and holds no exchange rates, so the
    // ranking is one book per currency. "Top 5" is five inside each book: a
    // sixth row would only be there because a euro number happened to be
    // larger than a dollar one.
    const sections = answer.content.split(/\n(?=[A-Z]{3} — )/).slice(1);
    assert.ok(sections.length >= 2, `expected one section per currency, got:\n${answer.content}`);
    for (const section of sections) {
      const rows = section.split('\n').filter((line: string) => /^\d+\. /.test(line));
      assert.ok(rows.length <= 5, `asked for five, got ${rows.length} in one book:\n${section}`);
      assert.ok(rows.length >= 1, `a book with a total must name at least one account:\n${section}`);
    }
    assert.match(answer.content, /other accounts? had revenue in 2025 in [A-Z]{3}/);
    // Every book is stated; none is quietly folded into another.
    for (const currency of ['USD', 'EUR', 'GBP']) {
      assert.ok(answer.content.includes(`${currency} — `), `the ${currency} book is missing:\n${answer.content}`);
    }
  });
});

/* ------------- no answer ever prints a database id as a name -------------- */

describe('an answer never prints a database id where a name belongs', () => {
  const PROMPTS = [
    'Compare Pemberton Auto Systems and Rheinwerk Antriebstechnik bookings in 2026',
    'Compare Rheinwerk Antriebstechnik and Brightline Foods bookings in 2025',
    'Top 5 customers by revenue in 2025',
    'Which accounts booked the most in 2025?',
    'Break down bookings by account for 2025',
    'Break down revenue by account for 2025',
    'Where does Rheinwerk Antriebstechnik stand?',
    'How much did Rheinwerk Antriebstechnik spend in 2025?',
    'Who is my biggest customer?',
    'How are we doing this quarter?',
  ];

  for (const prompt of PROMPTS) {
    test(`"${prompt}" states names, not ids`, async () => {
      const answer = await ask(prompt);
      const hit = answer.content.match(RAW_ID_IN_PROSE);
      assert.equal(hit, null, `"${hit?.[0]}" is a primary key in a sentence:\n${answer.content}`);
    });
  }

  test('a two-entity comparison names both accounts and measures two different ones', async () => {
    const answer = await ask('Compare Pemberton Auto Systems and Rheinwerk Antriebstechnik bookings in 2025');
    assert.ok(answer.content.includes('Rheinwerk Antriebstechnik'));
    assert.ok(answer.content.includes('Pemberton Auto Systems'),
      `the second account the question named must appear, got:\n${answer.content}`);
    const measured = answer.analysis.plan
      .filter((step: { tool: string }) => step.tool === 'business_metric')
      .map((step: { args: Record<string, unknown> }) => step.args.subject_id);
    assert.equal(measured.length, 2);
    assert.equal(new Set(measured).size, 2, 'two sides, two different records');
    // The company and its billing twin carry the same name; pairing them
    // compared an account with itself and dropped the other one.
    const labels = answer.analysis.entities
      .filter((e: { id: string }) => measured.includes(e.id))
      .map((e: { label: string }) => e.label);
    assert.equal(new Set(labels).size, 2, `both sides must be different accounts, got ${JSON.stringify(labels)}`);
  });

  test('a flat comparison reads "unchanged", not "up on $0"', async () => {
    const answer = await ask('Compare Pemberton Auto Systems and Rheinwerk Antriebstechnik bookings in 2026');
    if (/the period before/.test(answer.content)) {
      assert.ok(!/\bup on \$0\b/.test(answer.content),
        `a zero delta is not "up", got:\n${answer.content}`);
    }
  });

  test('an executed write reports the record by name, in its own capitalisation', async () => {
    const answer = await ask('Add a note to Rheinwerk Antriebstechnik saying "The acceptance run finished clean."', {
      allow_writes: true, approvals: ['add_note'],
    });
    assert.match(answer.content, /^Done — note on Rheinwerk Antriebstechnik/);
    assert.equal(answer.content.match(RAW_ID_IN_PROSE), null, answer.content);
  });
});

/* ---------- a period the engine cannot parse is never substituted --------- */

/**
 * Any money figure at all. The whole point of the `period_unresolved` refusal is
 * that the caller gets no number rather than a number about a period they did
 * not name, so the gate is "no currency anywhere in the answer".
 */
const CURRENCY = /[$€£¥]\s?[0-9]/;

describe('a period the engine cannot parse is refused, never swapped for a default', () => {
  /**
   * Every one of these named a period the parser cannot turn into a range, and
   * every one of them used to come back with a confident figure about the
   * current quarter — or about the whole year — with `refusal: null`.
   */
  const UNPARSEABLE: { prompt: string; phrase: string }[] = [
    { prompt: 'How much did we book in H1 2026?', phrase: 'H1 2026' },
    { prompt: 'Compare bookings in H1 2026', phrase: 'H1 2026' },
    { prompt: 'What did we book between 2026-12-31 and 2020-01-01?', phrase: '2026-12-31' },
    { prompt: 'How much did we book in 2026-02-30 to 2026-02-31?', phrase: '2026-02-30' },
    { prompt: 'What did we book in fiscal week 33?', phrase: 'week 33' },
    { prompt: 'How much did we book last fortnight?', phrase: 'last fortnight' },
    { prompt: 'How much did we book in the second half of 2026?', phrase: 'second half of 2026' },
  ];

  for (const { prompt, phrase } of UNPARSEABLE) {
    test(`"${prompt}" is refused with period_unresolved and states no figure`, async () => {
      const answer = await ask(prompt);
      assert.ok(answer.analysis.refusal,
        `expected a refusal, got an answer:\n${answer.content.slice(0, 400)}`);
      assert.equal(answer.analysis.refusal.code, 'period_unresolved',
        `expected period_unresolved, got ${answer.analysis.refusal.code}: ${answer.content.slice(0, 200)}`);
      assert.ok(!CURRENCY.test(answer.content),
        `a refused period must carry no money figure, got:\n${answer.content}`);
      assert.ok(answer.content.includes(phrase),
        `the refusal must name the phrase that did not parse ("${phrase}"), got:\n${answer.content}`);
      assert.equal(answer.analysis.window.from_question, false,
        'a refused period is never reported as the period the question named');
      assert.deepEqual(answer.analysis.plan, [], 'nothing is planned once the period is refused');
      assert.deepEqual(answer.tool_calls, [], 'nothing is measured once the period is refused');
    });
  }

  test('a reversed explicit range is refused, and the refusal says which way round it is', async () => {
    const answer = await ask('What did we book between 2026-12-31 and 2020-01-01?');
    assert.equal(answer.analysis.refusal.code, 'period_unresolved');
    assert.match(answer.content, /runs backwards/);
    assert.match(answer.content, /2026-12-31/);
    assert.match(answer.content, /2020-01-01/);
  });

  test('"the second quarter of 2026" resolves to Q2 2026 — it never answers on 2026', async () => {
    const answer = await ask('How much did we book in the second quarter of 2026?');
    const q2 = closedWonBetween(Date.UTC(2026, 3, 1), Date.UTC(2026, 6, 1));
    const wholeYear = closedWonBetween(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1));
    assert.notEqual(q2.total, wholeYear.total, 'the probe only means anything if the two differ');

    if (answer.analysis.refusal) {
      assert.equal(answer.analysis.refusal.code, 'period_unresolved');
      assert.ok(!CURRENCY.test(answer.content));
      return;
    }
    assert.equal(answer.analysis.window.label, 'Q2 2026');
    assert.equal(answer.analysis.window.start, Date.UTC(2026, 3, 1));
    assert.equal(answer.analysis.window.end, Date.UTC(2026, 6, 1));
    assert.equal(answer.analysis.window.from_question, true);
    assert.ok(answer.content.includes(money(q2.total)),
      `expected ${money(q2.total)} for Q2 2026, got:\n${answer.content}`);
    assert.ok(!answer.content.includes(money(wholeYear.total)),
      'answering on the whole of 2026 is the substitution this test exists to catch');
  });

  test('a period the engine does understand is still answered — the guard is not a blanket refusal', async () => {
    for (const prompt of [
      'How much did we book in Q2 2026?',
      'How much did we book in 2025?',
      'How much did we book last quarter?',
      'How much did we book in March 2026?',
      'How much did we book in the last 30 days?',
      'How much did we book between 2026-01-01 and 2026-03-31?',
      'How are we doing this quarter?',
      'How much did we book year to date?',
    ]) {
      const answer = await ask(prompt);
      assert.equal(answer.analysis.refusal, null,
        `"${prompt}" must still be answered, got ${JSON.stringify(answer.analysis.refusal)}`);
    }
  });

  test('the unresolved-period check is span-based, not a count', () => {
    const now = Date.UTC(2026, 7, 30);
    // One mention, one window, and still a substitution: the window came from
    // the year inside the phrase, not from the phrase.
    assert.deepEqual(unresolvedPeriods('bookings in H1 2026', now).map((m) => m.text), ['H1 2026']);
    assert.deepEqual(unresolvedPeriods('bookings in Q2 2026', now), []);
    assert.deepEqual(unresolvedPeriods('bookings in the second quarter of 2026', now), []);
    assert.deepEqual(unresolvedPeriods('compare Q1 2026 and H2 bookings', now).map((m) => m.text), ['H2']);
    assert.deepEqual(unresolvedPeriods('bookings between 2026-12-31 and 2020-01-01', now).map((m) => m.text),
      ['2026-12-31', '2020-01-01']);
    assert.deepEqual(resolveWindows('bookings in the second quarter of 2026', now).map((w) => w.label), ['Q2 2026']);
    assert.deepEqual(resolveWindows('bookings in 2026-02-30', now), [], 'half of a date is not a year');
    assert.deepEqual(reversedRange('between 2026-12-31 and 2020-01-01'), { from: '2026-12-31', to: '2020-01-01' });
    assert.equal(reversedRange('between 2026-01-01 and 2026-03-31'), null);
  });
});

describe('a question the engine cannot read is refused, not answered with a briefing', () => {
  /** The default bookings briefing — the answer a refusal must never be. */
  const BRIEFING = /booked \$/;

  test('two named periods where only one parses is refused as a comparison', async () => {
    const answer = await ask('Compare Q1 2026 and H2 bookings');
    assert.ok(answer.analysis.refusal,
      `expected a refusal, got an answer:\n${answer.content.slice(0, 300)}`);
    assert.equal(answer.analysis.refusal.code, 'period_unresolved');
    assert.match(answer.analysis.refusal.why, /named 2 periods/);
    assert.match(answer.content, /could only resolve "Q1 2026" to a date range/);
    assert.match(answer.content, /I will not answer on one period and present it as a comparison/);
    assert.ok(!BRIEFING.test(answer.content), 'a half-parsed comparison must not fall back to the briefing');
    assert.deepEqual(answer.tool_calls, [], 'nothing was measured');
    assert.deepEqual(answer.analysis.plan, []);
  });

  test('a question at the confidence floor with nothing to anchor on is refused', async () => {
    const answer = await ask('tell me');
    assert.ok(answer.analysis.confidence <= 0.31,
      `expected the classifier floor, got ${answer.analysis.confidence}`);
    assert.ok(answer.analysis.refusal,
      `expected a refusal at the confidence floor, got an answer:\n${answer.content.slice(0, 300)}`);
    assert.equal(answer.analysis.refusal.code, 'unknown_terms');
    assert.match(answer.content, /I could not tell what you are asking about Northwind Robotics/);
    assert.ok(!BRIEFING.test(answer.content), 'a floor-confidence question must not get a confident briefing');
    assert.deepEqual(answer.tool_calls, []);
  });

  test('words the workspace has never heard of are refused with the vocabulary it does hold', async () => {
    const answer = await ask('blorptastic frobnitz quux');
    assert.ok(answer.analysis.refusal, `expected a refusal, got:\n${answer.content.slice(0, 300)}`);
    assert.equal(answer.analysis.refusal.code, 'unreadable');
    assert.match(answer.content, /"blorptastic"/);
    assert.match(answer.content, /I can compute/);
    assert.ok(!BRIEFING.test(answer.content));
  });

  test('an injection payload is refused without running anything', async () => {
    const answer = await ask("How many deals'; DROP TABLE crm_records; --");
    assert.ok(answer.analysis.refusal, `expected a refusal, got:\n${answer.content.slice(0, 300)}`);
    assert.equal(answer.analysis.refusal.code, 'injection');
    assert.deepEqual(answer.tool_calls, []);
    assert.ok(app.ctx.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ?`, ORG) > 0);
  });

  test('a broad but genuine question about the business still gets the briefing', async () => {
    const answer = await ask('How are we doing this quarter?');
    assert.equal(answer.analysis.refusal, null);
    assert.match(answer.content, BRIEFING);
    assert.ok(answer.citations.length > 0);
  });
});

/* --------------- the documented limits and the run budget agree ----------- */

describe('the documented prompt limit and the run budget agree', () => {
  const PROMPT_LIMIT = 20_000;

  test('a prompt at the documented ceiling is answered well inside the run budget', async () => {
    // A prompt this long is a pasted document with a question on top of it, so
    // the filler is telemetry rows: it names no record and asks nothing.
    const filler = ' telemetry row: asset 44192, rpm 1180, temp 62.4, vibration 0.31;';
    const prompt = `How did bookings do last quarter?${filler.repeat(400)}`.slice(0, PROMPT_LIMIT);
    assert.equal(prompt.length, PROMPT_LIMIT, 'the probe sits exactly on the documented limit');

    const answer = await ask(prompt);
    assert.equal(answer.finish_reason, 'stop');
    assert.equal(answer.analysis.budget_exhausted, false);
    assert.match(answer.content, /booked \$/);
    assert.ok(answer.reasoning.some((line: string) => /resolution reads the leading 800/.test(line)),
      'a long paste is focused rather than scored in full');

    const stored = await expectOk('GET', `/v1/ai/runs/${answer.run_id}`);
    assert.equal(stored.status, 'succeeded');
    assert.ok(stored.duration_ms < DEFAULT_BUDGET.timeMs,
      `a prompt at the documented ${PROMPT_LIMIT}-character limit spent ${stored.duration_ms}ms of the ${DEFAULT_BUDGET.timeMs}ms budget`);
    assert.ok(stored.steps <= DEFAULT_BUDGET.steps);
  });

  test('one character past the documented ceiling is a clear error, not a slow run', async () => {
    const res = await call('POST', '/v1/ai/complete', { prompt: 'y'.repeat(PROMPT_LIMIT + 1) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'parameter_invalid');
    assert.equal(res.body.error.param, 'prompt');
    assert.match(res.body.error.message, new RegExp(`at most ${PROMPT_LIMIT} characters`));
  });

  test('a conversation at the documented ceiling is answered inside the budget too', async () => {
    const turn = ' telemetry row: asset 44192, rpm 1180, temp 62.4, vibration 0.31;'.repeat(320).slice(0, PROMPT_LIMIT);
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: i === 38 ? `How did bookings do last quarter? ${turn}`.slice(0, PROMPT_LIMIT) : turn,
    }));
    const answer = await expectOk('POST', '/v1/ai/complete', { messages });
    assert.equal(answer.analysis.budget_exhausted, false);
    assert.equal(answer.finish_reason, 'stop');
    const stored = await expectOk('GET', `/v1/ai/runs/${answer.run_id}`);
    assert.ok(stored.duration_ms < DEFAULT_BUDGET.timeMs,
      `40 messages at the documented limit spent ${stored.duration_ms}ms of the ${DEFAULT_BUDGET.timeMs}ms budget`);
  });

  test('a run that does blow its budget says it has no answer rather than a partial one', async () => {
    const runtime = aiRuntime(app.ctx);
    const context = callContext({ budget: { timeMs: 0 }, startedNs: process.hrtime.bigint() - 5_000_000_000n });
    const execution = await runtime.execute('business_metric', { metric: 'closed_won' }, context);
    assert.equal(execution.error?.code, 'time_budget_exhausted');
    assert.equal(execution.error?.recoverable, false);
  });
});

/* --------------------- the revenue half of the workspace ------------------ */

describe('the ledger answers, instead of being found and thrown away', () => {
  const runtime = () => aiRuntime(app.ctx);
  const overview = () => expectOk('GET', '/v1/subscriptions/overview');

  test('"list our subscriptions" returns the subscriptions, not an emptiness message', async () => {
    const live = await expectOk('GET', '/v1/subscriptions?status=active_like&limit=100');
    assert.ok(live.total_count > 0, 'the demo workspace has a subscription book');

    const answer = await ask('List our subscriptions');
    const ledger = answer.trace.find((s: { name: string }) => s.name === 'billing_list_subscriptions');
    assert.ok(ledger?.ok, 'the ledger tool ran and succeeded');
    assert.ok(!/No subscription records match that/.test(answer.content),
      `the ledger returned rows in this same run; the answer must not claim otherwise:\n${answer.content}`);
    assert.ok(answer.content.includes(`${live.total_count} subscriptions`),
      `expected the answer to state ${live.total_count} subscriptions, got:\n${answer.content.slice(0, 400)}`);
    const first = live.data[0];
    const named = await expectOk('GET', `/v1/customers/${first.customer}`);
    assert.ok(answer.content.includes(named.name) || answer.content.split('•').length > 3,
      'the answer lists the subscriptions by account, not just a count');
    assert.ok(answer.citations.length > 0, 'the rows the answer read are cited');
  });

  test('MRR and ARR agree with /v1/subscriptions/overview, one book per currency', async () => {
    const book = await overview();
    assert.ok(book.mrr > 0, 'the demo workspace bills recurring revenue');
    // `overview.mrr` is every currency's minor units added together — the
    // overview says so itself in `mrr_note` and returns `mrr_display: null`.
    // The copilot must never quote that scalar: it reconciles against
    // `by_currency`, which is the figure that is in a currency.
    assert.equal(book.mixed_currency, true, 'the demo workspace bills in more than one currency');
    const byCurrency = new Map<string, { mrr: number; arr: number }>(
      (book.by_currency as { currency: string; mrr: number; arr: number }[]).map((row) => [row.currency, row]),
    );

    const mrr = (await runtime().execute('business_metric', { metric: 'mrr' }, callContext())).result as
      { value: number; mixedCurrency: boolean; books: { currency: string; value: number; formatted: string }[] };
    assert.equal(mrr.mixedCurrency, true, 'a book in three currencies is reported as three books');
    assert.notEqual(mrr.value, book.mrr, 'the copilot never reports the cross-currency sum as a figure');
    for (const row of mrr.books) {
      assert.equal(row.value, byCurrency.get(row.currency)?.mrr,
        `${row.currency.toUpperCase()} MRR disagrees with the subscriptions overview`);
    }
    assert.equal(mrr.books.length, byCurrency.size, 'every currency the ledger bills in has its own book');

    const arr = (await runtime().execute('business_metric', { metric: 'arr' }, callContext())).result as
      { books: { currency: string; value: number }[] };
    for (const row of arr.books) assert.equal(row.value, byCurrency.get(row.currency)?.arr);

    // The answer trims a zero fraction the way every sentence in this engine
    // does, so the amount is re-formatted here rather than compared against the
    // ledger's own two-decimal display string.
    const spoken = (amount: number, currency: string) =>
      formatMoney({ amount, currency }, { locale: 'en-US', trimZeroFraction: true });
    const answer = await ask('What is our MRR?');
    assert.equal(answer.analysis.metric.id, 'mrr');
    for (const row of book.by_currency as { currency: string; mrr: number }[]) {
      assert.ok(answer.content.includes(spoken(row.mrr, row.currency)),
        `expected ${spoken(row.mrr, row.currency)} in:\n${answer.content}`);
    }
    assert.ok(!answer.content.includes(money(book.mrr)),
      `the cross-currency sum ${money(book.mrr)} must never be printed as a dollar figure:\n${answer.content}`);
    assert.ok(!/not installed here/.test(answer.content),
      'the subscription ledger is installed, so the answer may never say it is not');
    assert.ok(!/no monthly recurring revenue/i.test(answer.content));

    const annual = await ask('What is our ARR?');
    assert.equal(annual.analysis.metric.id, 'arr', 'ARR is its own metric, not MRR under another label');
    for (const row of book.by_currency as { currency: string; arr: number }[]) {
      assert.ok(annual.content.includes(spoken(row.arr, row.currency)),
        `expected ${spoken(row.arr, row.currency)} in:\n${annual.content}`);
    }
    assert.ok(!annual.content.includes(money(book.arr)), 'the cross-currency ARR sum is never printed either');
  });

  test('"which invoices are overdue" lists the overdue ones, not the whole book', async () => {
    const everything = await runtime().execute('billing_list_invoices', { status: 'all', limit: 50 }, callContext());
    const overdue = await runtime().execute('billing_list_invoices',
      { status: 'open_like', due_before: app.ctx.now(), limit: 50 }, callContext());
    const total = (overdue.result as { total: number }).total;
    assert.ok(total < (everything.result as { total: number }).total,
      'the seed has invoices that are not overdue, so filtering has to change the answer');

    const answer = await ask('Which invoices are overdue?');
    const step = answer.trace.find((s: { name: string }) => s.name === 'billing_list_invoices');
    assert.ok(step?.ok);
    assert.equal(step.args.status, 'open_like', '"overdue" has to reach the status filter');
    assert.ok(Number(step.args.due_before) <= app.ctx.now(), '"overdue" means due before now');
    assert.ok(!/No invoice records match that/.test(answer.content), answer.content);
    assert.ok(answer.content.includes(`${total} invoice`),
      `expected ${total} overdue invoices in:\n${answer.content.slice(0, 400)}`);
  });

  test('a run scoped to a ledger tool answers from it', async () => {
    const answer = await ask('list invoices', { tools: ['billing_list_invoices'] });
    assert.deepEqual(answer.analysis.scoped_tools, ['billing_list_invoices']);
    assert.ok(!/none of those can answer that/.test(answer.content),
      `the scoped tool ran and returned rows:\n${answer.content.slice(0, 300)}`);
    const step = answer.trace.find((s: { name: string }) => s.name === 'billing_list_invoices');
    assert.ok(answer.content.includes(`${(step.summary.match(/total=(\d+)/) ?? [])[1]} invoices`));
  });

  test('an invoice named by id is explained, and the id reaches the tool', async () => {
    const invoices = await expectOk('GET', '/v1/invoices?limit=1');
    const invoice = invoices.data[0];
    const answer = await ask(`Explain invoice ${invoice.id}`);
    const step = answer.trace.find((s: { name: string }) => s.name === 'billing_explain_invoice');
    assert.ok(step, 'the invoice tool was planned');
    assert.equal(step.args.invoice, invoice.id, 'the id in the question is the id the tool receives');
    assert.equal(step.ok, true);
    assert.ok(answer.content.startsWith(`Invoice ${invoice.number}`),
      `the answer is about the invoice that was named:\n${answer.content.slice(0, 300)}`);
    assert.ok(!/closed-won|pipeline/i.test(answer.content),
      'a question about one bill is not answered with the quarter\'s bookings');
  });

  test('when every list-returning tool really is empty, the answer still says so', async () => {
    const answer = await ask('List our subscriptions', { tools: ['record_search'] });
    const ran = answer.trace.filter((s: { kind: string }) => s.kind === 'tool');
    assert.deepEqual(ran.map((s: { name: string }) => s.name), ['record_search']);
    assert.equal((ran[0].summary.match(/total=(\d+)/) ?? [])[1], '0', 'the CRM holds no subscription records');
    assert.match(answer.content, /No subscription records match that/,
      'the emptiness message is gated on the run, not deleted');
  });
});

/* ------------- a conversation keeps hold of what it is about -------------- */

describe('a follow-up is answered about the account the conversation is on', () => {
  const rheinwerk = () => app.ctx.db.get<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM crm_records WHERE org_id = ? AND object_type = 'company' AND display_name LIKE 'Rheinwerk%'`,
    ORG)!;

  const openTicketsOn = (recordId: string) => app.ctx.db.count(
    `SELECT COUNT(*) FROM crm_associations a JOIN crm_records r ON r.id = a.from_id
     WHERE a.org_id = ? AND a.to_id = ? AND r.object_type = 'ticket'
       AND json_extract(r.properties, '$.status') IN ('new','waiting_on_us','waiting_on_customer','escalated')`,
    ORG, recordId);

  test('a thread pinned to an account answers "how much have they spent" about that account', async () => {
    const account = rheinwerk();
    const thread = await expectOk('POST', '/v1/ai/threads', {
      subject_id: account.id, subject_type: 'company', message: 'Where does this account stand?',
    });
    assert.ok(thread.messages[1].content.includes(account.display_name),
      `the first turn of a pinned thread is about the account it is pinned to:\n${thread.messages[1].content.slice(0, 200)}`);

    const reply = await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, { content: 'How much have they spent?' });
    const analysed = await ask('How much have they spent?', { thread_id: thread.id });
    assert.equal(analysed.analysis.subject.id, account.id,
      `"they" resolved to ${analysed.analysis.subject?.label ?? 'the whole workspace'}`);
    assert.equal(analysed.analysis.carried_subject.id, account.id);
    assert.ok(reply.message.content.includes(account.display_name));
    assert.ok(!/^Northwind Robotics (spent|collected)/.test(reply.message.content),
      `a pinned thread must not widen to the workspace:\n${reply.message.content.slice(0, 200)}`);
    assert.match(reply.message.content, /Scoped to Rheinwerk/);
  });

  test('"what are their open tickets" lists that account\'s tickets, not the workspace\'s', async () => {
    const account = rheinwerk();
    const mine = openTicketsOn(account.id);
    const everyone = app.ctx.db.count(
      `SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'ticket'
         AND json_extract(properties, '$.status') IN ('new','waiting_on_us','waiting_on_customer','escalated')`, ORG);
    assert.ok(mine > 0 && mine < everyone, 'the account has some, but not all, of the open tickets');

    const thread = await expectOk('POST', '/v1/ai/threads', {
      subject_id: account.id, subject_type: 'company', message: 'Where does this account stand?',
    });
    const reply = await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, { content: 'What are their open tickets?' });
    const run = await expectOk('GET', `/v1/ai/runs/${reply.run_id}`);
    const search = run.trace.find((s: { name: string }) => s.name === 'record_search');
    assert.ok(search, `no record_search in ${run.trace.map((s: { name: string }) => s.name).join(', ')}`);
    assert.equal(search.args.associated_to, account.id, 'the ticket search is scoped to the account');
    assert.ok(reply.message.content.includes(`${mine} ticket`),
      `expected ${mine} tickets on ${account.display_name}, got:\n${reply.message.content.slice(0, 400)}`);
    assert.ok(!reply.message.content.includes(`${everyone} tickets`), 'the workspace backlog is a different question');
  });

  test('an unpinned thread carries the account the previous turn established', async () => {
    const account = rheinwerk();
    const thread = await expectOk('POST', '/v1/ai/threads', { message: `Where does ${account.display_name} stand?` });
    const reply = await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, { content: 'Who owns it?' });
    const analysed = await ask('Who owns it?', { thread_id: thread.id });
    assert.equal(analysed.analysis.subject.id, account.id,
      `"it" resolved to ${analysed.analysis.subject?.label ?? 'nothing'}`);
    assert.ok(reply.message.content.includes(account.display_name));

    const brief = await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, { content: 'Summarise that in one line' });
    assert.ok(brief.message.content.includes(account.display_name),
      `a summary of this conversation is about this account:\n${brief.message.content}`);
    assert.equal(brief.message.content.split('\n\n').length, 1,
      `"in one line" is an instruction:\n${brief.message.content}`);
  });

  test('a pronoun with nothing behind it is refused, never widened to the workspace', async () => {
    const answer = await ask('How much have they spent?');
    assert.equal(answer.analysis.refusal.code, 'unresolved_reference');
    assert.equal(answer.trace.filter((s: { kind: string }) => s.kind === 'tool').length, 0, 'nothing was measured');
    assert.match(answer.content, /I do not know what "they" refers to/);
    assert.ok(!/\$/.test(answer.content), `no number is invented for an unresolved subject:\n${answer.content}`);

    const thread = await expectOk('POST', '/v1/ai/threads', { message: 'How much have they spent?' });
    assert.match(thread.messages[1].content, /I do not know what "they" refers to/,
      'an unpinned thread with no history cannot answer a pronoun either');
  });
});

/* ------------- arguments are extracted, never the whole sentence ---------- */

describe('a tool is never called with the question in its arguments', () => {
  /** Parameters whose value genuinely is the sentence the person typed. */
  const FREE_TEXT = new Set(['query', 'q', 'search', 'text', 'term', 'question', 'prompt', 'message', 'body', 'content', 'input', 'instruction']);

  const prompts = [
    'What is our MRR?',
    'Show me the upcoming invoice for Sakamoto Seiki',
    'How many customers are on the Scale plan?',
    'Which invoices are overdue?',
  ];

  for (const prompt of prompts) {
    test(`"${prompt}" arms every tool it runs`, async () => {
      const answer = await ask(prompt);
      for (const span of answer.trace.filter((s: { kind: string }) => s.kind === 'tool')) {
        for (const [key, value] of Object.entries(span.args ?? {})) {
          if (FREE_TEXT.has(key) || typeof value !== 'string') continue;
          assert.notEqual(value, prompt,
            `${span.name} was called with the whole question as \`${key}\``);
        }
        assert.ok(span.ok || span.error?.code !== 'invalid_arguments',
          `${span.name} failed argument validation: ${span.error?.message}`);
      }
    });
  }

  test('a tool needing an id the question does not carry is not called with the sentence', async () => {
    const answer = await ask('Show me the upcoming invoice');
    const skipped = answer.analysis.skipped.find((s: { tool: string }) => s.tool === 'billing_upcoming_invoice');
    assert.ok(skipped, `expected billing_upcoming_invoice to be reported as skipped, got ${JSON.stringify(answer.analysis.skipped)}`);
    assert.deepEqual(skipped.missing, ['subscription']);
    assert.ok(!answer.trace.some((s: { kind: string; name: string }) => s.kind === 'tool' && s.name === 'billing_upcoming_invoice'),
      'with dozens of subscriptions and no account named, there is no one subscription it could mean');
    assert.match(answer.content, /I did not run `billing_upcoming_invoice`/);
  });

  test('naming the account arms the tool from the ledger, with a real id', async () => {
    const answer = await ask('Show me the upcoming invoice for Sakamoto Seiki');
    const preview = answer.trace.find((s: { name: string }) => s.name === 'billing_upcoming_invoice');
    assert.ok(preview, 'listing the account\'s subscriptions gives the second pass the id it needed');
    assert.equal(preview.ok, true);
    assert.match(String(preview.args.subscription), /^sub_/);
    const subscription = await expectOk('GET', `/v1/subscriptions/${preview.args.subscription}`);
    const customer = await expectOk('GET', `/v1/customers/${subscription.customer}`);
    assert.match(customer.name, /Sakamoto/,
      'the subscription it previewed belongs to the account in the question');
    assert.match(answer.content, /The next invoice is dated/);
  });
});

/* ---------------- the gates hold for a tool nobody registered ------------- */

describe('the read-only, allowlist and approval gates cover every tool, registered or not', () => {
  let ran = 0;
  const privateRead = {
    name: 'private_read', description: 'A tool the caller supplied rather than registered.',
    readOnly: true, input: v.object({ id: v.string() }),
    run: () => { ran += 1; return { ok: true }; },
  };
  const privateWrite = { ...privateRead, name: 'private_write', readOnly: false };

  test('a caller-supplied tool outside the allowlist never runs', async () => {
    ran = 0;
    const execution = await aiRuntime(app.ctx).execute('private_read', { id: 'x' },
      callContext({ restrictTools: ['workspace_search'] }), privateRead);
    assert.equal(execution.ok, false);
    assert.equal(execution.error?.code, 'tool_not_permitted');
    assert.equal(ran, 0, 'the gate runs before the tool does');
  });

  test('an empty allowlist stops a caller-supplied tool as well as a registered one', async () => {
    ran = 0;
    const execution = await aiRuntime(app.ctx).execute('private_read', { id: 'x' },
      callContext({ restrictTools: [] }), privateRead);
    assert.equal(execution.error?.code, 'tool_not_permitted');
    assert.equal(ran, 0);
  });

  test('a write is refused on a read-only run and stopped at the approval gate on a write run', async () => {
    ran = 0;
    const readOnlyRun = await aiRuntime(app.ctx).execute('private_write', { id: 'x' }, callContext(), privateWrite);
    assert.equal(readOnlyRun.error?.code, 'write_not_permitted');
    assert.equal(ran, 0);

    const context = callContext({ allowWrites: true });
    const unapproved = await aiRuntime(app.ctx).execute('private_write', { id: 'x' }, context, privateWrite);
    assert.equal(unapproved.error?.code, 'approval_required');
    assert.equal(ran, 0, 'nothing is written before a person approves it');
    assert.equal(context.pendingApprovals?.[0].tool, 'private_write');

    const approved = await aiRuntime(app.ctx).execute('private_write', { id: 'x' },
      callContext({ allowWrites: true, approvals: ['private_write'] }), privateWrite);
    assert.equal(approved.ok, true);
    assert.equal(ran, 1, 'and it runs once the approval is in hand');
  });

  test('the step budget applies to a caller-supplied tool too', async () => {
    ran = 0;
    const context = callContext({ budget: { steps: 1 } });
    assert.equal((await aiRuntime(app.ctx).execute('private_read', { id: 'x' }, context, privateRead)).ok, true);
    const second = await aiRuntime(app.ctx).execute('private_read', { id: 'x' }, context, privateRead);
    assert.equal(second.error?.code, 'step_budget_exhausted');
    assert.equal(ran, 1);
  });

  test('arguments are validated before a caller-supplied tool sees them', async () => {
    ran = 0;
    const execution = await aiRuntime(app.ctx).execute('private_read', { id: 42 }, callContext(), privateRead);
    assert.equal(execution.error?.code, 'invalid_arguments');
    assert.equal(ran, 0);
  });
});

/* --------------- what the business is owed, and when it is owed ----------- */

describe('the receivables question is answered with the receivables number', () => {
  const overview = () => expectOk('GET', '/v1/subscriptions/overview');

  /**
   * Every open invoice in the ledger, straight from SQL, as the arbiter — one
   * row per currency, because euros and dollars in one `SUM` is a number in no
   * currency and there is no exchange-rate table anywhere in this platform.
   */
  const openInvoices = () => app.ctx.db.all<{ currency: string; n: number; total: number }>(
    `SELECT currency, COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM billing_invoices
     WHERE org_id = ? AND status IN ('open', 'past_due', 'unpaid', 'uncollectible')
     GROUP BY currency ORDER BY currency`, ORG);

  test('the outstanding metric equals the ledger, one book per currency', async () => {
    const rows = openInvoices();
    assert.ok(rows.length > 1, 'the demo workspace carries an unpaid book in more than one currency');
    const sql = new Map(rows.map((r) => [r.currency, r]));

    const metric = businessMetric(app.ctx, ORG, {
      metric: 'outstanding', start: 0, end: app.ctx.now(), window_label: 'all time',
    });
    assert.ok(!('error' in metric));
    assert.equal(metric.mixedCurrency, true, 'a book in three currencies is reported as three books');
    assert.equal(metric.books.length, rows.length, 'every currency owed has its own book');
    for (const book of metric.books) {
      assert.equal(book.value, sql.get(book.currency)?.total,
        `${book.currency.toUpperCase()} outstanding disagrees with the ledger`);
      assert.equal(book.count, sql.get(book.currency)?.n);
    }
    assert.equal(metric.count, rows.reduce((a, r) => a + r.n, 0), 'the row count still covers every open invoice');
    const crossCurrencySum = rows.reduce((a, r) => a + r.total, 0);
    assert.notEqual(metric.value, crossCurrencySum,
      'the copilot never reports minor units added across currencies as a figure');
    assert.equal(metric.value, sql.get('usd')?.total, 'the scalar, where one is read at all, is the home book');
  });

  test('every open invoice is unpaid, so a payment-dated window would match none of them', () => {
    const dated = app.ctx.db.count(
      `SELECT COUNT(*) FROM billing_invoices WHERE org_id = ? AND status = 'open' AND paid_at IS NOT NULL`, ORG);
    assert.equal(dated, 0,
      'this is the shape of the bug: filtering the outstanding book on paid_at can only ever return zero');
  });

  test('"what are we owed" answers the real number, in words, in every currency', async () => {
    const rows = openInvoices();
    const answer = await ask('What is our outstanding balance all time?');
    for (const row of rows) {
      const shown = formatMoney({ amount: row.total, currency: row.currency }, { locale: 'en-US', trimZeroFraction: true });
      assert.ok(answer.content.includes(shown), `expected ${shown} in:\n${answer.content.slice(0, 400)}`);
    }
    const crossCurrencySum = rows.reduce((a, r) => a + r.total, 0);
    assert.ok(!answer.content.includes(money(crossCurrencySum)),
      `the cross-currency sum ${money(crossCurrencySum)} must never appear as a dollar figure:\n${answer.content}`);
    assert.ok(!/no outstanding balance/i.test(answer.content),
      `the answer must not report zero against a book that is not zero:\n${answer.content.slice(0, 300)}`);
  });

  test('outstanding is a snapshot: the period in the question does not move it', async () => {
    const allTime = await ask('What is our outstanding balance all time?');
    const quarter = await ask('What is our outstanding balance this quarter?');
    const rows = openInvoices();
    for (const answer of [allTime, quarter]) {
      for (const row of rows) {
        const shown = formatMoney({ amount: row.total, currency: row.currency }, { locale: 'en-US', trimZeroFraction: true });
        assert.ok(answer.content.includes(shown), `both windows report the same book:\n${answer.content.slice(0, 300)}`);
      }
    }
    assert.equal(quarter.analysis.metric.id, 'outstanding');
    assert.match(quarter.content, /ignores the reporting period/,
      'and the answer says why the period was not applied');
  });

  test('an account with a past-due invoice is told what it owes', async () => {
    const row = app.ctx.db.get<{ name: string; total: number }>(
      `SELECT c.name AS name, SUM(i.total) AS total FROM billing_invoices i
       JOIN billing_customers c ON c.id = i.customer_id AND c.org_id = i.org_id
       WHERE i.org_id = ? AND i.status = 'open' GROUP BY c.id ORDER BY total DESC LIMIT 1`, ORG)!;
    const answer = await ask(`How much does ${row.name} owe us?`);
    assert.ok(answer.content.includes(money(row.total)),
      `expected ${row.name} to owe ${money(row.total)}:\n${answer.content.slice(0, 300)}`);
  });

  test('cash collected is still dated by when it was paid, not by when it was raised', async () => {
    const start = Date.UTC(2026, 0, 1);
    const end = Date.UTC(2026, 3, 1);
    const paid = app.ctx.db.all<{ currency: string; n: number; total: number }>(
      `SELECT currency, COUNT(*) AS n, COALESCE(SUM(amount_paid), 0) AS total FROM billing_invoices
       WHERE org_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at < ?
       GROUP BY currency ORDER BY currency`, ORG, start, end);
    assert.ok(paid.length && paid.every((r) => r.n > 0), 'the workspace collected money in Q1 2026');
    const metric = businessMetric(app.ctx, ORG, { metric: 'revenue', start, end, window_label: 'Q1 2026' });
    assert.ok(!('error' in metric));
    const sql = new Map(paid.map((r) => [r.currency, r]));
    for (const book of metric.books) {
      assert.equal(book.value, sql.get(book.currency)?.total,
        `${book.currency.toUpperCase()} revenue is what landed in the window, on the payment date`);
      assert.equal(book.count, sql.get(book.currency)?.n);
    }
    assert.equal(metric.books.length, paid.length);
    assert.equal(metric.count, paid.reduce((a, r) => a + r.n, 0));
  });
});

/* ------------------- one answer says each thing exactly once -------------- */

describe('an answer never states the same finding twice', () => {
  test('a metric lookup prints its headline paragraph once', async () => {
    for (const question of ['closed won in 2026', 'outstanding balance', 'What is our outstanding balance all time?']) {
      const answer = await ask(question);
      const paragraphs = answer.content.split('\n\n').map((p: string) => p.trim());
      const counts = new Map<string, number>();
      for (const paragraph of paragraphs) counts.set(paragraph, (counts.get(paragraph) ?? 0) + 1);
      const repeated = [...counts.entries()].filter(([, n]) => n > 1);
      assert.equal(repeated.length, 0,
        `"${question}" repeated ${repeated.map(([p]) => `"${p.slice(0, 70)}…"`).join(', ')}`);
    }
  });
});

/* --------------------- periods and units read as written ------------------ */

describe('a period label and a delta carry their own units, once', () => {
  test('a month window is labelled once, not with the year twice', () => {
    const now = Date.UTC(2026, 7, 31);
    const last = resolveWindow('bookings last month', now)!;
    assert.equal(last.label, 'Jul 2026');
    assert.equal(resolveWindow('bookings this month', now)!.label, 'Aug 2026 to date');
    assert.equal(resolveWindow('bookings in March 2025', now)!.label, 'March 2025');
  });

  test('no answer prints a year twice in a row', async () => {
    for (const question of ['bookings last month', 'bookings this month vs last month', 'bookings in July 2026']) {
      const answer = await ask(question);
      assert.ok(!/\b(19|20)\d{2}\s+(19|20)\d{2}\b/.test(answer.content),
        `"${question}" doubled a year:\n${answer.content.slice(0, 200)}`);
    }
  });

  test('a percentage metric reports its movement in points, never as a bare decimal', async () => {
    const answer = await ask('win rate in Q2 2026');
    assert.match(answer.content, /\d+(\.\d)? points? \([-+]/,
      `a percentage delta needs a unit:\n${answer.content}`);
    assert.ok(!/\b\d+\.\d{3}\b/.test(answer.content),
      `no three-decimal number belongs in an answer:\n${answer.content}`);
  });
});

/* ------------ a period the lexer can read but not resolve is refused ------- */

describe('every period-shaped phrase is either measured or refused', () => {
  const now = Date.UTC(2026, 7, 31);

  test('the lexer sees the phrases the parser cannot resolve', () => {
    for (const phrase of ['bookings in the month before last', 'bookings 3 months ago', 'bookings in early 2027', 'bookings the first week of 2026']) {
      assert.ok(unresolvedPeriods(phrase, now).length > 0, `"${phrase}" must not pass as no period at all`);
    }
  });

  test('a phrase the parser cannot resolve is refused, not swapped for the default', async () => {
    for (const question of ['bookings in the month before last', 'bookings between 9999-12-31 and 0001-01-01']) {
      const answer = await ask(question);
      assert.equal(answer.analysis.refusal.code, 'period_unresolved', `"${question}" was answered anyway`);
      assert.equal(answer.trace.filter((s: { kind: string }) => s.kind === 'tool').length, 0,
        `"${question}" measured something`);
      assert.ok(!/\$[\d,]/.test(answer.content), `"${question}" produced a number:\n${answer.content.slice(0, 200)}`);
    }
  });

  test('the periods the parser does resolve are still answered', async () => {
    for (const question of ['bookings last month', 'bookings in Q2 2026', 'bookings in 2026', 'bookings in the last 30 days']) {
      const answer = await ask(question);
      assert.equal(answer.analysis.refusal, null, `"${question}" should resolve:\n${answer.content.slice(0, 200)}`);
    }
  });
});

/* ------------- the revenue half is reachable from plain English ----------- */

describe('a question about the ledger reaches the ledger, for one account', () => {
  const brightline = () => app.ctx.db.get<{ id: string; name: string }>(
    `SELECT id, name FROM billing_customers WHERE org_id = ? AND name LIKE 'Brightline%'`, ORG)!;

  test('"show me <account> invoices" returns that account\'s invoices', async () => {
    const customer = brightline();
    const rows = app.ctx.db.count(`SELECT COUNT(*) FROM billing_invoices WHERE org_id = ? AND customer_id = ?`, ORG, customer.id);
    assert.ok(rows > 0, 'the account has invoices to find');
    const answer = await ask(`Show me ${customer.name} invoices`);
    const step = answer.trace.find((s: { name: string }) => s.name === 'billing_list_invoices');
    assert.ok(step, `the invoice tool never ran; plan was ${answer.trace.map((s: { name: string }) => s.name).join(', ')}`);
    assert.equal(step.args.customer, customer.id, 'and it was scoped to the billing customer, not the CRM company');
    assert.match(answer.content, /NR-\d+/, `the answer names invoices:\n${answer.content.slice(0, 400)}`);
  });

  test('"what is <account> subscribed to" reads the subscription ledger', async () => {
    const customer = brightline();
    const answer = await ask(`What is ${customer.name} subscribed to?`);
    const step = answer.trace.find((s: { name: string }) => s.name === 'billing_list_subscriptions');
    assert.ok(step, `plan was ${answer.trace.map((s: { name: string }) => s.name).join(', ')}`);
    assert.equal(step.args.customer, customer.id);
    assert.match(answer.content, /a month/, `the answer names what they are on:\n${answer.content.slice(0, 300)}`);
  });

  test('"what meters do we have" lists the meters, by name', async () => {
    const meters = app.ctx.db.all<{ name: string }>(`SELECT name FROM meters WHERE org_id = ? AND status = 'active'`, ORG);
    assert.ok(meters.length > 0);
    const answer = await ask('What meters do we have?');
    assert.ok(answer.trace.some((s: { name: string }) => s.name === 'metering.list_meters'),
      `plan was ${answer.trace.map((s: { name: string }) => s.name).join(', ')}`);
    for (const meter of meters) {
      assert.ok(answer.content.includes(meter.name), `"${meter.name}" is missing from:\n${answer.content.slice(0, 500)}`);
    }
    assert.ok(!/`metering\.list_meters` returned/.test(answer.content), 'the tool name is not part of the answer');
  });

  test('an entitlement question reads the entitlement set, not the company card', async () => {
    const customer = app.ctx.db.get<{ id: string; name: string }>(
      `SELECT c.id, c.name FROM billing_customers c
       JOIN entitlement_active e ON e.customer_id = c.id AND e.org_id = c.org_id
       WHERE c.org_id = ? LIMIT 1`, ORG)!;
    const answer = await ask(`Is ${customer.name} at its seat limit?`);
    assert.ok(answer.trace.some((s: { name: string }) => s.name === 'entitlements.for_customer'),
      `plan was ${answer.trace.map((s: { name: string }) => s.name).join(', ')}`);
    assert.match(answer.content, /entitlements? on /, `the answer states the allowance:\n${answer.content.slice(0, 400)}`);
  });

  test('an invoice named by its number is explained, like one named by its id', async () => {
    const invoice = app.ctx.db.get<{ number: string }>(
      `SELECT number FROM billing_invoices WHERE org_id = ? AND number IS NOT NULL AND status = 'open' LIMIT 1`, ORG)!;
    const answer = await ask(`Explain invoice ${invoice.number}`);
    assert.ok(answer.trace.some((s: { name: string }) => s.name === 'billing_explain_invoice'),
      `plan was ${answer.trace.map((s: { name: string }) => s.name).join(', ')}`);
    assert.ok(answer.content.startsWith(`Invoice ${invoice.number}`),
      `the answer is about the invoice that was named:\n${answer.content.slice(0, 200)}`);
  });
});

/* ------------- a usage question is a usage question, or a refusal --------- */

describe('a question about usage is never answered with a sales number', () => {
  test('metered usage is read from the meter, for the account and the period', async () => {
    const customer = app.ctx.db.get<{ id: string; name: string; crm: string | null }>(
      `SELECT c.id, c.name, c.crm_record_id AS crm FROM billing_customers c
       WHERE c.org_id = ? AND EXISTS (
         SELECT 1 FROM meter_events e WHERE e.org_id = c.org_id AND e.customer_id = c.id) LIMIT 1`, ORG)!;
    const answer = await ask(`How many telemetry events did ${customer.name} use last month?`);
    // Either usage capability answers this — what matters is that the meter and
    // the account reached it, not which of the two the planner picked.
    const step = answer.trace.find((s: { name: string }) => s.name === 'metering.usage_for_period' || s.name === 'metered_usage');
    assert.ok(step, `plan was ${answer.trace.map((s: { name: string }) => s.name).join(', ')}`);
    assert.equal(step.args.customer, customer.id);
    assert.ok(!/closed-won|bookings/i.test(answer.content),
      `a usage question must not be answered with bookings:\n${answer.content.slice(0, 300)}`);
    assert.match(answer.content, /Telemetry events/);
  });

  test('a number question that names no measure is refused, even when it names an account', async () => {
    const answer = await ask('How much is Brightline Foods worth?');
    assert.equal(answer.analysis.refusal.code, 'no_measure');
    assert.equal(answer.trace.filter((s: { kind: string }) => s.kind === 'tool').length, 0);
    assert.match(answer.content, /an account tells me who to measure, not what/);
  });

  test('a number question that does name a measure is still answered', async () => {
    for (const question of ['How many deals are open?', 'How much did we book in Q2 2026?', 'How many open tickets are there?']) {
      const answer = await ask(question);
      assert.equal(answer.analysis.refusal, null, `"${question}" was refused:\n${answer.content.slice(0, 200)}`);
    }
  });
});

/* --------- no answer prints a tool name, a field name or a raw id --------- */

describe('a tool result reaches the reader as prose, never as its payload', () => {
  const PROBES = [
    'Quote the price for 5 million telemetry events',
    'What meters do we have?',
    'Show me Brightline Foods invoices',
    'What is Brightline Foods subscribed to?',
    'How much credit does Brightline Foods have?',
    'What is our outstanding balance all time?',
  ];

  test('no answer contains a tool name in backticks or a bare primary key', async () => {
    for (const question of PROBES) {
      const answer = await ask(question);
      assert.ok(!/`[a-z_]+[._][a-z_]+` returned/.test(answer.content),
        `"${question}" printed a tool payload:\n${answer.content.slice(0, 300)}`);
      const ids = answer.content.match(/\b(?:prod|cus|sub|in|mtr|price|usr|rec)_[A-Za-z0-9]{6,}\b/g) ?? [];
      assert.deepEqual(ids, [], `"${question}" printed database ids ${ids.join(', ')}`);
      assert.ok(!/• Id /.test(answer.content), `"${question}" printed schema field labels:\n${answer.content.slice(0, 300)}`);
    }
  });
});

/* ------- a conversation still knows what it is about on the fifth turn ---- */

describe('a thread keeps hold of its account past the third turn', () => {
  const account = () => app.ctx.db.get<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM crm_records WHERE org_id = ? AND object_type = 'company' AND display_name LIKE 'Rheinwerk%'`,
    ORG)!;

  test('turns four and five still answer about the account turn one named', async () => {
    const target = account();
    const thread = await expectOk('POST', '/v1/ai/threads', { message: `Where does ${target.display_name} stand?` });
    const asked = [
      'How much have they spent?',
      'What are their open tickets?',
      'And their invoices?',
      'How much do they owe us?',
    ];
    for (const [index, question] of asked.entries()) {
      const reply = await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, { content: question });
      assert.ok(!/I do not know what "the(?:y|ir)" refers to/.test(reply.message.content),
        `turn ${index + 2} lost the account:\n${reply.message.content.slice(0, 300)}`);
      assert.ok(reply.message.content.includes(target.display_name),
        `turn ${index + 2} did not name ${target.display_name}:\n${reply.message.content.slice(0, 300)}`);
    }
  });

  test('the question is stored once, not twice, in the transcript the engine reads', async () => {
    const thread = await expectOk('POST', '/v1/ai/threads', { message: 'Where does Rheinwerk Antriebstechnik stand?' });
    await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, { content: 'How much have they spent?' });
    const messages = await expectOk('GET', `/v1/ai/threads/${thread.id}/messages`);
    const userTurns = messages.data.filter((m: { role: string }) => m.role === 'user').map((m: { content: string }) => m.content);
    assert.deepEqual(userTurns, ['Where does Rheinwerk Antriebstechnik stand?', 'How much have they spent?']);
  });

  test('a later turn that names a different account moves to it', async () => {
    const first = account();
    const second = app.ctx.db.get<{ display_name: string }>(
      `SELECT display_name FROM crm_records WHERE org_id = ? AND object_type = 'company' AND display_name LIKE 'Brightline%'`,
      ORG)!;
    const thread = await expectOk('POST', '/v1/ai/threads', { message: `Where does ${first.display_name} stand?` });
    await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, { content: `And where does ${second.display_name} stand?` });
    const reply = await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, { content: 'Who owns it?' });
    assert.ok(reply.message.content.includes(second.display_name),
      `"it" means the account the last naming turn established:\n${reply.message.content.slice(0, 300)}`);
  });
});

/* ---------- the gates still hold over the ledger the planner reaches ------ */

describe('the ledger steps obey the same gates as everything else', () => {
  test('a run scoped to no tools plans nothing, ledger question or not', async () => {
    const answer = await ask('Show me Brightline Foods invoices', { tools: [] });
    assert.deepEqual(answer.analysis.scoped_tools, []);
    assert.equal(answer.trace.filter((s: { kind: string }) => s.kind === 'tool').length, 0);
    assert.match(answer.content, /scoped to no tools/);
  });

  test('a run scoped to one ledger tool runs only that one', async () => {
    const answer = await ask('Show me Brightline Foods invoices', { tools: ['billing_list_invoices'] });
    const ran = answer.trace.filter((s: { kind: string }) => s.kind === 'tool').map((s: { name: string }) => s.name);
    assert.deepEqual([...new Set(ran)], ['billing_list_invoices']);
  });

  test('no ledger step is ever a write', async () => {
    for (const question of ['Show me Brightline Foods invoices', 'What meters do we have?', 'How much credit does Brightline Foods have?']) {
      const answer = await ask(question);
      for (const step of answer.trace.filter((s: { kind: string }) => s.kind === 'tool')) {
        const tool = aiRuntime(app.ctx).tool(step.name);
        assert.equal(tool?.readOnly ?? true, true, `"${question}" planned a write: ${step.name}`);
      }
    }
  });
});

/* ---------------- the AI surface is not a way around a role --------------- */

describe('the copilot carries no more authority than its caller', () => {
  const READONLY: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed06', role: 'readonly', scopes: ['*'], livemode: true };
  const ANALYST: Auth = { ...READONLY, role: 'analyst' };

  const company = () => app.ctx.db.get<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM crm_records WHERE org_id = ? AND object_type = 'company' AND display_name LIKE 'Rheinwerk%'`,
    ORG)!;
  const noteCount = () => app.ctx.db.count(
    `SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'note'`, ORG);

  test('a role refused the write route cannot make the identical write through the copilot', async () => {
    const target = company();
    const direct = await call('POST', `/v1/records/company/${target.id}/activities`, {
      type: 'note', subject: 'Escalation probe', body: 'Written straight at the CRM.',
    }, READONLY);
    assert.equal(direct.status, 403, 'the CRM route is the baseline: readonly cannot log an activity');

    const before = noteCount();
    const through = await call('POST', '/v1/ai/complete', {
      prompt: `Add a note to ${target.display_name} saying "Written through the copilot."`,
      allow_writes: true,
      approvals: ['add_note'],
    }, READONLY);

    assert.equal(through.status, 403, `the copilot let a readonly session write: ${JSON.stringify(through.body).slice(0, 300)}`);
    assert.equal(through.body.error.type, 'permission_error');
    assert.equal(noteCount(), before, 'a note reached the CRM through the copilot');
  });

  test('the same two fields are gated on a thread turn, not only on /complete', async () => {
    const thread = await expectOk('POST', '/v1/ai/threads', { title: 'Escalation probe' });
    const before = noteCount();
    const turn = await call('POST', `/v1/ai/threads/${thread.id}/messages`, {
      content: `Add a note to ${company().display_name} saying "Written through a thread."`,
      allow_writes: true,
      approvals: ['add_note'],
    }, READONLY);
    assert.equal(turn.status, 403, `a thread turn let a readonly session write: ${JSON.stringify(turn.body).slice(0, 300)}`);
    assert.equal(noteCount(), before);
  });

  test('an analyst is under the member bar too — the ladder, not one role', async () => {
    const refused = await call('POST', '/v1/ai/complete', {
      prompt: 'Add a note anywhere', allow_writes: true,
    }, ANALYST);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error.message, /analyst/);
  });

  test('reading through the copilot stays open to every role', async () => {
    const answer = await expectOk('POST', '/v1/ai/complete', { prompt: 'What is our open pipeline by stage?' }, READONLY);
    assert.equal(answer.object, 'ai_completion');
    assert.ok(answer.content.length > 0, 'an analyst asking a question is the whole point of the surface');
    const listed = await expectOk('GET', '/v1/ai/runs?limit=1', undefined, READONLY);
    assert.equal(listed.object, 'list');
  });

  test('a member may still authorise a write, exactly as they may approve one', async () => {
    const target = company();
    const before = noteCount();
    const answer = await expectOk('POST', '/v1/ai/complete', {
      prompt: `Add a note to ${target.display_name} saying "A member asked for this."`,
      allow_writes: true,
      approvals: ['add_note'],
    }, { ...READONLY, role: 'member' });
    assert.equal(answer.trace.filter((s: { kind: string; name: string }) => s.kind === 'tool' && s.name === 'add_note').length, 1);
    assert.equal(noteCount(), before + 1);
  });
});

/* ------------- the agent surface works for the integration path ----------- */

describe('an API key is a first-class caller of the agent surface', () => {
  /* The demo workspace's own key, minted in the core module's seed. */
  const KEY = `sk_test_${'ain_demo_workspace_key_0001'}`;
  const withKey = (method: string, path: string, body?: unknown) =>
    app.handle({ method, path, body, headers: { authorization: `Bearer ${KEY}` } });

  test('a write tool called with an API key lands, attributed to whoever made the key', async () => {
    const target = app.ctx.db.get<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM crm_records WHERE org_id = ? AND object_type = 'company' AND display_name LIKE 'Rheinwerk%'`,
      ORG)!;
    const before = app.ctx.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'note'`, ORG);

    const res = await withKey('POST', '/v1/ai/complete', {
      prompt: `Add a note to ${target.display_name} saying "Filed by the integration."`,
      allow_writes: true,
      approvals: ['add_note'],
    });
    assert.ok(res.status < 400, `${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);

    const step = res.body.trace.find((s: { kind: string; name: string }) => s.kind === 'tool' && s.name === 'add_note');
    assert.ok(step, `the plan never reached add_note: ${JSON.stringify(res.body.trace).slice(0, 400)}`);
    assert.equal(step.ok, true, `the write failed for an API key: ${step.error?.message}`);
    assert.equal(
      app.ctx.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'note'`, ORG),
      before + 1,
      'the note never reached the CRM',
    );

    // `ak_seed_demo` was created by Dana, and an API key acts as the person who
    // made it — an owner_id has to be a member of the workspace.
    const note = app.ctx.db.get<{ display_name: string; owner_id: string | null; created_by: string | null }>(
      `SELECT display_name, owner_id, created_by FROM crm_records WHERE org_id = ? AND object_type = 'note' ORDER BY created DESC LIMIT 1`, ORG)!;
    assert.match(note.display_name, /Filed by the integration/);
    assert.equal(note.owner_id, 'usr_seed01');
    assert.equal(note.created_by, 'usr_seed01');
  });

  test('a follow-up whose assignee is no longer a member still lands, unassigned', async () => {
    const runtime = aiRuntime(app.ctx);
    // A *live* account: this test is about the assignee having left, and a
    // follow-up onto an archived or merged-away record is refused when it comes
    // due for its own reasons. Earlier tests in this file archive companies, and
    // an unordered `LIMIT 1` was free to hand this one of them.
    const company = app.ctx.db.get<{ id: string }>(
      `SELECT id FROM crm_records WHERE org_id = ? AND object_type = 'company'
         AND archived = 0 AND merged_into IS NULL LIMIT 1`, ORG)!;
    const runId = `run_departed_${app.ctx.now()}`;
    app.ctx.db.insert('ai_runs', {
      id: runId, org_id: ORG, thread_id: null, feature: 'test', provider: 'builtin', model: ENGINE_MODEL,
      actor_id: 'usr_seed01', actor_type: 'user', status: 'running', question: 'departed', answer: '',
      reasoning: '[]', citations: '[]', started: app.ctx.now(),
    });

    // The approval was prepared months ago for someone who has since left, so
    // the id is well formed and simply is not a member of this workspace.
    const execution = await runtime.execute('schedule_followup', {
      record_id: company.id, in_days: 30, note: 'Reconfirm the acceptance window', assignee_id: 'usr_departed01',
    }, callContext({ runId, allowWrites: true, approvals: ['schedule_followup'] }));
    assert.equal(execution.ok, true, `scheduling failed: ${execution.error?.message}`);

    const job = app.ctx.db.get<{ id: string; org_id: string; type: string; payload: string; run_at: number; attempts: number; max_attempts: number; status: string; last_error: string | null; idem_key: string | null; created: number; updated: number }>(
      `SELECT * FROM jobs WHERE type = 'ai.followup' AND status = 'pending' ORDER BY created DESC LIMIT 1`)!;
    assert.equal(JSON.parse(job.payload).assigneeId, 'usr_departed01');

    const outcome = await app.ctx.jobs.runOne({ ...job, payload: JSON.parse(job.payload) } as never, app.ctx.now());
    assert.equal(outcome, 'ok', `the follow-up failed instead of landing: ${app.ctx.db.pluck<string>(`SELECT last_error FROM jobs WHERE id = ?`, job.id)}`);

    const note = app.ctx.db.get<{ owner_id: string | null }>(
      `SELECT owner_id FROM crm_records WHERE org_id = ? AND object_type = 'note' AND display_name LIKE 'Follow-up: Reconfirm the acceptance window%' ORDER BY created DESC LIMIT 1`,
      ORG);
    assert.ok(note, 'the note the operator approved never reached the timeline');
    assert.equal(note!.owner_id, null, 'an owner who is not a member is no owner at all');
  });

  test('no run started by a key is ever attributed to the key id', async () => {
    await withKey('POST', '/v1/ai/complete', { prompt: 'What is our open pipeline by stage?' });
    const keyed = app.ctx.db.count(
      `SELECT COUNT(*) FROM ai_runs WHERE org_id = ? AND actor_id LIKE 'ak_%'`, ORG);
    assert.equal(keyed, 0, 'an API key id is not a person and must never be stored as an actor');
  });

  test('a key-created thread and its draft resolve the same actor', async () => {
    const thread = await withKey('POST', '/v1/ai/threads', { title: 'Integration thread' });
    assert.ok(thread.status < 400, JSON.stringify(thread.body).slice(0, 200));
    assert.equal(
      app.ctx.db.pluck<string>(`SELECT created_by FROM ai_threads WHERE id = ?`, thread.body.id),
      'usr_seed01',
    );
    const draft = await withKey('POST', '/v1/ai/draft', { instruction: 'Write a short check-in email' });
    assert.ok(draft.status < 400, JSON.stringify(draft.body).slice(0, 200));
  });
});

/* ---------- one approval is one write, however many people press it ------- */

/**
 * `JobQueue.runOne` claims a job row before running it, because "`due()` and
 * this call are not one transaction" and two drains racing one row means two
 * invoices for one period. `POST /v1/ai/approvals/:id` is that shape one module
 * over — read the row, find it pending, then execute across an `await` — on the
 * path where running the row twice writes twice to a customer's timeline. It
 * had no claim, so two people pressing Approve both executed and the approval
 * record still said the write happened once.
 */
describe('an approval executes once, whoever presses it and however often', () => {
  const target = () => app.ctx.db.get<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM crm_records WHERE org_id = ? AND object_type = 'company' AND display_name LIKE 'Rheinwerk%'`,
    ORG)!;
  const notes = () => app.ctx.db.count(
    `SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'note'`, ORG);

  /** Queue a real write and return the approval this run is waiting on. */
  async function queued(phrase: string): Promise<string> {
    const answer = await expectOk('POST', '/v1/ai/complete', {
      prompt: `Add a note to ${target().display_name} saying "${phrase}"`, allow_writes: true,
    });
    const row = app.ctx.db.get<{ id: string }>(
      `SELECT id FROM ai_approvals WHERE org_id = ? AND run_id = ? AND status = 'pending'`, ORG, answer.run_id);
    assert.ok(row, `precondition: the write did not stop at the approval gate (${answer.content?.slice(0, 120)})`);
    return row!.id;
  }

  const decide = (id: string, decision: 'approve' | 'decline') =>
    call('POST', `/v1/ai/approvals/${id}`, { decision });

  test('two people pressing Approve at once write to the customer once, not twice', async () => {
    const id = await queued('The shipment cleared customs on Tuesday');
    const before = notes();

    const [a, b] = await Promise.all([decide(id, 'approve'), decide(id, 'approve')]);
    const answers = [a.status, b.status].sort();

    assert.equal(
      notes() - before, 1,
      `one approval put ${notes() - before} notes on the customer's timeline, and the approval record says it happened once`,
    );
    assert.deepEqual(answers, [200, 400], `exactly one caller may execute the write: got ${answers.join()}`);
    assert.equal(
      app.ctx.db.count(`SELECT COUNT(*) FROM events WHERE org_id = ? AND type = 'ai.approval.granted' AND object_id = ?`, ORG, id), 1,
      'the event log announced one approval as granted twice',
    );
    assert.equal(
      app.ctx.db.count(`SELECT COUNT(*) FROM audit_log WHERE org_id = ? AND target_id = ?`, ORG, id), 1,
      'the audit trail recorded one approval as granted twice',
    );
    assert.equal(app.ctx.db.pluck<string>(`SELECT status FROM ai_approvals WHERE id = ?`, id), 'approved');
  });

  test('approve racing decline resolves one way, and the write matches the answer', async () => {
    const id = await queued('Heike confirmed the site survey date');
    const before = notes();
    const [x, y] = await Promise.all([decide(id, 'approve'), decide(id, 'decline')]);

    assert.deepEqual([x.status, y.status].sort(), [200, 400], 'both decisions were accepted for one request');
    const status = app.ctx.db.pluck<string>(`SELECT status FROM ai_approvals WHERE id = ?`, id);
    assert.equal(
      notes() - before, status === 'approved' ? 1 : 0,
      `the approval record says "${status}" and the customer's timeline disagrees`,
    );
  });

  test('two declines land one decline, not two', async () => {
    const id = await queued('Spare parts stock was replenished on Friday');
    const before = notes();
    const [p, q] = await Promise.all([decide(id, 'decline'), decide(id, 'decline')]);

    assert.deepEqual([p.status, q.status].sort(), [200, 400]);
    assert.equal(
      app.ctx.db.count(`SELECT COUNT(*) FROM events WHERE org_id = ? AND type = 'ai.approval.declined' AND object_id = ?`, ORG, id), 1,
      'one decline was announced twice',
    );
    assert.equal(app.ctx.db.pluck<string>(`SELECT status FROM ai_approvals WHERE id = ?`, id), 'declined');
    assert.equal(notes() - before, 0, 'a declined approval wrote anyway');
  });

  test('and the ordinary single decision still runs, and is still final', async () => {
    const id = await queued('The acceptance test is booked for the 14th');
    const before = notes();
    const approved = await expectOk('POST', `/v1/ai/approvals/${id}`, { decision: 'approve' });

    assert.equal(approved.executed, true, 'claiming the row stopped the very caller who claimed it');
    assert.equal(approved.status, 'approved');
    assert.equal(notes() - before, 1, 'the note the operator approved never reached the timeline');

    const again = await decide(id, 'approve');
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'approval_decided');
    assert.equal(notes() - before, 1, 'pressing Approve a second time wrote a second time');
  });

  test('a blocked approval is declined and finished, never stranded mid-claim', async () => {
    const id = await queued('The commissioning window moved to March');
    const gone = target();
    app.ctx.db.run(`DELETE FROM crm_records WHERE org_id = ? AND id = ?`, ORG, gone.id);

    const blocked = await decide(id, 'approve');
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error.code, 'approval_target_changed');
    // A claim that ends in a decline is a finished decision, not a held lock:
    // the row is terminal, so nobody is left holding a write nobody made.
    assert.equal(app.ctx.db.pluck<string>(`SELECT status FROM ai_approvals WHERE id = ?`, id), 'declined');

    app.ctx.db.insert('crm_records', {
      id: gone.id, org_id: ORG, object_type: 'company', display_name: gone.display_name,
      owner_id: null, created_by: null, archived: 0, merged_into: null,
      created: app.ctx.now(), updated: app.ctx.now(),
    });
  });
});

/* ------------------ two writes are two approvals, not one ----------------- */

describe('one approval is one write, at the end the queue is filled from', () => {
  const notes = () =>
    app.ctx.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'note'`, ORG);

  const companies = () =>
    app.ctx.db.all<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM crm_records WHERE org_id = ? AND object_type = 'company' AND archived = 0
       ORDER BY display_name LIMIT 2`, ORG);

  test('a run that plans two different writes with one tool queues two cards, not one', async () => {
    // Straight at the gate `execute()` enforces, which is what the planner
    // reaches when a request names two accounts: same run, same tool, two
    // genuinely different writes.
    const runtime = aiRuntime(app.ctx);
    const [first, second] = companies();
    assert.ok(first && second, 'precondition: the workspace has two companies');

    const context = callContext({ allowWrites: true, approvals: [] });
    const a = await runtime.execute('add_note', { record_ids: [first.id], body: 'The pilot line passed acceptance.' }, context);
    const b = await runtime.execute('add_note', { record_ids: [second.id], body: 'The commissioning date moved to March.' }, context);

    assert.equal(a.ok, false);
    assert.equal(a.error?.code, 'approval_required');
    assert.equal(b.ok, false);
    assert.equal(b.error?.code, 'approval_required');
    assert.equal(context.pendingApprovals?.length, 2, 'the run reported two writes waiting');

    const rows = app.ctx.db.all<{ id: string; args: string }>(
      `SELECT id, args FROM ai_approvals WHERE org_id = ? AND run_id = ? AND status = 'pending' ORDER BY created ASC`,
      ORG, context.runId!);
    assert.equal(
      rows.length, 2,
      `the run answered with ${context.pendingApprovals?.length} writes waiting but the queue holds ${rows.length}`,
    );
    // Both cards are stamped in the same millisecond, so compare them as the
    // set of writes the queue is holding rather than as an order.
    const targets = rows.map((r) => (JSON.parse(r.args) as { record_ids: string[] }).record_ids[0]).sort();
    assert.deepEqual(targets, [first.id, second.id].sort(), 'the second write was collapsed onto the first one\'s card');

    // And each card, approved, writes its own note onto its own record.
    const before = notes();
    for (const row of rows) {
      const decided = await expectOk('POST', `/v1/ai/approvals/${row.id}`, { decision: 'approve' });
      assert.equal(decided.executed, true);
    }
    assert.equal(notes() - before, 2, 'two approved writes did not produce two notes');
    const written = app.ctx.db.all<{ properties: string }>(
      `SELECT properties FROM crm_records WHERE org_id = ? AND object_type = 'note' ORDER BY created DESC LIMIT 2`, ORG)
      .map((r) => (JSON.parse(r.properties) as { body?: string }).body);
    assert.ok(written.includes('The pilot line passed acceptance.'));
    assert.ok(written.includes('The commissioning date moved to March.'));
  });

  test('but the same write reaching the gate twice is still one card', async () => {
    const runtime = aiRuntime(app.ctx);
    const [first] = companies();
    const context = callContext({ allowWrites: true, approvals: [] });
    const args = { record_ids: [first.id], body: 'The retrofit quote is with procurement.' };

    await runtime.execute('add_note', args, context);
    await runtime.execute('add_note', { ...args }, context);

    assert.equal(
      app.ctx.db.count(`SELECT COUNT(*) FROM ai_approvals WHERE org_id = ? AND run_id = ?`, ORG, context.runId!), 1,
      'one write asked for twice must not ask a person twice',
    );
  });
});

/* ------ a metered workspace answers usage questions from its meters ------- */

describe('a question about metered usage reaches the meter, or says why it did not', () => {
  /** The account with the most events on a meter — a real fixture, not a name. */
  const busiestOn = (meterId: string): { id: string; name: string } => {
    const top = app.ctx.db.get<{ customer: string }>(
      `SELECT customer_id AS customer FROM meter_events WHERE org_id = ? AND meter_id = ?
       GROUP BY customer_id ORDER BY COUNT(*) DESC LIMIT 1`, ORG, meterId)!;
    return app.ctx.db.get<{ id: string; name: string }>(
      `SELECT id, name FROM billing_customers WHERE org_id = ? AND id = ?`, ORG, top.customer)!;
  };

  test('a meter named in the question is measured, and the number is the meter’s own', async () => {
    const customer = busiestOn('mtr_nw_alerts');
    const answer = await ask(`How many anomaly alerts did ${customer.name} raise last month?`);
    const step = answer.analysis.plan.find((s: { tool: string }) => s.tool === 'metering.usage_for_period' || s.tool === 'metered_usage');
    assert.ok(step, `no usage step; the plan was ${answer.analysis.plan.map((s: { tool: string }) => s.tool).join(', ') || 'empty'}`);
    assert.equal(step.args.meter, 'mtr_nw_alerts', 'the meter the question named is the meter the tool received');
    assert.equal(step.args.customer, customer.id);

    const expected = app.ctx.svc.metering.usageForPeriod(ORG, 'mtr_nw_alerts', customer.id, step.args.start, step.args.end);
    assert.ok(expected.value > 0, 'the fixture has alerts in the window the engine chose');
    assert.ok(answer.content.includes(expected.value.toLocaleString('en-US')),
      `the answer states the metered total ${expected.value}:\n${answer.content.slice(0, 400)}`);
    assert.match(answer.content, /Anomaly alerts raised/);
    assert.ok(!/closed-won|booked|bookings/i.test(answer.content),
      `a usage question must never be answered with a sales number:\n${answer.content.slice(0, 400)}`);
  });

  test('the meter is matched on its event name as well as its display name', async () => {
    const customer = busiestOn('mtr_nw_telemetry');
    const answer = await ask(`How many telemetry_events did ${customer.name} send last month?`);
    const step = answer.analysis.plan.find((s: { tool: string }) => s.tool === 'metering.usage_for_period' || s.tool === 'metered_usage');
    assert.ok(step, `no usage step; the plan was ${answer.analysis.plan.map((s: { tool: string }) => s.tool).join(', ') || 'empty'}`);
    assert.equal(step.args.meter, 'mtr_nw_telemetry');
    const expected = app.ctx.svc.metering.usageForPeriod(ORG, 'mtr_nw_telemetry', customer.id, step.args.start, step.args.end);
    assert.ok(answer.content.includes(expected.value.toLocaleString('en-US')),
      `the answer states the metered total ${expected.value}:\n${answer.content.slice(0, 400)}`);
  });

  test('a word that fits two meters measures both and says so, guessing at neither', async () => {
    const customer = busiestOn('mtr_nw_telemetry');
    const answer = await ask(`How much telemetry did ${customer.name} send last month?`);
    // Guessing which meter was meant is wrong half the time and the catalogue
    // is not an answer, so both readings are measured and the ambiguity is
    // stated before either number arrives.
    const steps = answer.analysis.plan.filter((s: { tool: string }) => /usage/.test(s.tool));
    assert.equal(steps.length, 2, `both meters are measured; the plan was ${answer.analysis.plan.map((s: { tool: string }) => s.tool).join(', ') || 'empty'}`);
    assert.deepEqual(
      [...new Set(steps.map((s: { args: Record<string, unknown> }) => String(s.args.meter)))].sort(),
      ['mtr_nw_storage', 'mtr_nw_telemetry'],
      'the two meters the word fits are the two that are measured',
    );
    for (const step of steps) assert.equal(step.args.customer, customer.id, 'both are scoped to the account named');
    assert.match(answer.content, /matches Stored telemetry and Telemetry events equally well/);
    assert.match(answer.content, /Telemetry events/);
    assert.match(answer.content, /Stored telemetry/);
    const expected = app.ctx.svc.metering.usageForPeriod(
      ORG, 'mtr_nw_telemetry', customer.id, Number(steps[0].args.start), Number(steps[0].args.end));
    assert.ok(answer.content.includes(expected.value.toLocaleString('en-US')),
      `the meter's own total is in the answer:\n${answer.content.slice(0, 500)}`);
    assert.ok(!/closed-won|booked|bookings/i.test(answer.content),
      `an ambiguous meter is never a sales number:\n${answer.content.slice(0, 400)}`);
  });
});

/* ---- a ledger question is refused out loud, never quietly substituted ---- */

describe('a ledger question the engine cannot arm is refused, and the refusal leads', () => {
  test('a usage question with no meter names the missing argument first', async () => {
    const answer = await ask('How much usage did Sableworks Robotics have last month?');
    assert.deepEqual(answer.analysis.plan, [], 'no CRM fallback is planned underneath the refusal');
    const blocked = answer.analysis.blocked[0];
    assert.equal(blocked.object_type, 'usage');
    assert.equal(blocked.reason, 'missing_arguments');
    assert.deepEqual(blocked.missing, ['meter']);

    const first = answer.content.split('\n\n')[0];
    assert.match(first, /^I have not answered that from metered usage/,
      `the refusal is the first thing said, not a footnote:\n${answer.content.slice(0, 400)}`);
    assert.match(first, /`meter`/, 'the first sentence names the argument that was missing');
    // Every meter in the workspace, so the next question can succeed.
    assert.match(answer.content, /Telemetry events/);
    // Bookings may only appear in the sentence that refuses them.
    const claims = answer.content.split('\n\n').filter((block: string) => !/^I have not/.test(block));
    assert.ok(!claims.some((block: string) => /closed-won|booked|bookings|open pipeline/i.test(block)),
      `nothing may stand in for the answer:\n${answer.content.slice(0, 400)}`);
  });

  test('a ledger read that only works per account says so, and searches no CRM', async () => {
    const answer = await ask('What credits are left across the workspace?');
    assert.deepEqual(answer.analysis.plan, []);
    const blocked = answer.analysis.blocked[0];
    assert.equal(blocked.object_type, 'credit');
    assert.equal(blocked.reason, 'no_capability');
    assert.equal(blocked.other_scope.tool, 'credits.balance');
    assert.ok(!/No credit records match/.test(answer.content),
      `the CRM has never held a credit row; searching it is not an answer:\n${answer.content.slice(0, 300)}`);
    assert.match(answer.content, /one account at a time/);
  });

  test('the same question with an account named is answered from the ledger', async () => {
    const answer = await ask('How much credit does Kestrel Aerospace Components have left?');
    assert.deepEqual(answer.analysis.blocked, [], 'nothing is refused when the ledger can be armed');
    const step = answer.analysis.plan.find((s: { tool: string }) => s.tool === 'credits.balance');
    assert.ok(step, `the credit balance was read; the plan was ${answer.analysis.plan.map((s: { tool: string }) => s.tool).join(', ')}`);
    const balance = app.ctx.svc.credits.balance(ORG, step.args.customer);
    for (const pot of balance.totals_by_currency.filter((t: { monetary_available: number }) => t.monetary_available > 0)) {
      assert.ok(answer.content.includes(formatMoney({ amount: pot.monetary_available, currency: pot.currency }, { locale: 'en-US' })),
        `the answer states the ${pot.currency} balance:\n${answer.content.slice(0, 300)}`);
    }
  });
});

/* ------- a result that came back is read out, or named as discarded ------- */

describe('a tool result is rendered, empty, or named with the reason it was dropped', () => {
  const runTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = aiRuntime(app.ctx).tool(name)!;
    assert.ok(tool, `${name} is registered`);
    return await tool.run(tool.input.parse(args), app.ctx, { orgId: ORG }) as any;
  };

  test('the revenue summary reaches the reader, one book per currency', async () => {
    const report = await runTool('revenue_summary');
    const answer = await ask('How is the business doing this quarter?');
    assert.ok(answer.trace.some((s: { name: string }) => s.name === 'revenue_summary'), 'the revenue report ran');
    for (const row of report.by_currency) {
      assert.ok(answer.content.includes(row.mrr_display),
        `${row.currency.toUpperCase()} MRR ${row.mrr_display} never reached the answer:\n${answer.content.slice(-600)}`);
    }
    assert.equal(answer.analysis.results.find((r: { tool: string }) => r.tool === 'revenue_summary').outcome, 'rendered');
  });

  test('collections answers with the ageing and the DSO, not with a warning about currencies', async () => {
    const report = await runTool('revenue_collections');
    const answer = await ask('What is our DSO and how old are our receivables?');
    assert.ok(answer.trace.some((s: { name: string }) => s.name === 'revenue_collections'));
    for (const row of report.by_currency) {
      assert.ok(answer.content.includes(row.outstanding_display),
        `${row.currency.toUpperCase()} outstanding ${row.outstanding_display} is missing:\n${answer.content.slice(0, 600)}`);
      assert.ok(answer.content.includes(row.dso_days), `${row.currency.toUpperCase()} DSO ${row.dso_days} is missing`);
    }
    const buckets = report.ageing.filter((b: { invoices: number }) => b.invoices > 0);
    assert.ok(buckets.length, 'the fixture has receivables to age');
    for (const bucket of buckets) assert.ok(answer.content.includes(bucket.bucket), `ageing bucket "${bucket.bucket}" is missing`);
  });

  test('every result a plan produces is accounted for, and every discard is said out loud', async () => {
    const QUESTIONS = [
      'How is the business doing this quarter?',
      'What is our DSO and how old are our receivables?',
      'How many telemetry events did Kestrel Aerospace Components use last month?',
      'What entitlements does Ironwood Packaging Group have?',
      'Where does Rheinwerk Antriebstechnik stand?',
      'What is the credit burn order?',
      'Which customers are past due?',
      'Why did bookings drop last quarter?',
    ];
    for (const question of QUESTIONS) {
      const answer = await ask(question);
      const succeeded = answer.analysis.steps.filter((s: { ok: boolean }) => s.ok).map((s: { tool: string }) => s.tool);
      const accounted = answer.analysis.results.map((r: { tool: string }) => r.tool);
      assert.deepEqual(accounted, succeeded, `"${question}" left a successful step out of the account`);
      for (const result of answer.analysis.results) {
        assert.ok(['rendered', 'empty', 'discarded'].includes(result.outcome), `"${question}" invented an outcome`);
        if (result.outcome !== 'discarded') continue;
        assert.ok(result.why, `"${question}" discarded ${result.tool} without a reason`);
        assert.ok(answer.content.includes(result.tool),
          `"${question}" dropped ${result.tool} from the answer without telling anyone:\n${answer.content.slice(-400)}`);
      }
    }
  });
});

/* -------- a grouping that cannot be applied is announced, not dropped ----- */

describe('a metric says what it cannot break down', () => {
  test('win rate by owner is recomputed inside each owner, and says the rows do not sum', async () => {
    const answer = await ask('What is our win rate by owner this year?');
    const step = answer.analysis.plan.find((s: { tool: string }) => s.tool === 'business_metric');
    assert.equal(step.args.group_by, 'owner');

    const stages = stageSets(app.ctx, ORG);
    const decided = await expectOk('POST', '/v1/records/deal/search', {
      filter: { property: 'deal_stage', operator: 'in', values: [...stages.won, ...stages.lost] },
      limit: 200,
    });
    assert.equal(decided.has_more, false, 'every decided deal fits in one page');
    const window = answer.analysis.window;
    const tally = new Map<string, { won: number; decided: number }>();
    for (const deal of decided.data as { owner_id: string | null; properties: Record<string, unknown> }[]) {
      const close = Number(deal.properties.close_date ?? 0);
      if (!close || close < window.start || close >= window.end) continue;
      const key = deal.owner_id ?? 'unassigned';
      const row = tally.get(key) ?? { won: 0, decided: 0 };
      row.decided += 1;
      if (stages.won.includes(String(deal.properties.deal_stage ?? ''))) row.won += 1;
      tally.set(key, row);
    }
    const people = workspaceProfile(app.ctx, ORG).people;
    const rows = [...tally.entries()]
      .map(([id, row]) => ({
        name: people.find((p) => p.id === id)?.name ?? 'Unassigned',
        rate: Number(((row.won / row.decided) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.rate - a.rate);
    assert.ok(rows.length >= 2, 'the fixture has decided deals under more than one owner');
    for (const row of rows.slice(0, 3)) {
      assert.ok(answer.content.includes(`${row.name} ${row.rate}%`),
        `"${row.name} ${row.rate}%" is missing from the breakdown:\n${answer.content.slice(0, 600)}`);
    }
    assert.match(answer.content, /rows do not sum/, 'a ratio that is grouped says the rows are not summable');
  });

  test('a grouping a ratio cannot take is refused in the answer, not dropped in silence', async () => {
    const answer = await ask('What is our win rate by industry this year?');
    assert.match(answer.content, /cannot be broken down by industry/);
    assert.match(answer.content, /property of the company/);
    assert.match(answer.content, /\d+(\.\d+)?% of the deals it decided/, 'the workspace figure is still given');
  });

  test('any metric that ignores a grouping says so, whichever metric it is', async () => {
    const answer = await ask('What is our average deal size by owner this year?');
    assert.equal(answer.analysis.group_by, 'owner');
    assert.match(answer.content, /does not break down by owner/);
  });
});

/* ================================================================================
   The question that was asked is the question that gets answered.

   Every test below reproduces a defect an external critic found by using the
   copilot as a person does, and every one of them fails on the code as it stood
   before the fix beside it.
   ============================================================================= */

describe('money keeps its currency, and three books are never added together', () => {
  const subscriptionBooks = () => app.ctx.db.all<{ currency: string; n: number }>(
    `SELECT currency, COUNT(*) AS n FROM billing_subscriptions WHERE org_id = ? GROUP BY currency ORDER BY currency`, ORG);

  const spoken = (amount: number, currency: string) =>
    formatMoney({ amount, currency }, { locale: 'en-US', trimZeroFraction: true });

  test('a money metric returns one book per currency and refuses to sum them', () => {
    assert.ok(subscriptionBooks().length > 1, 'the demo workspace bills in more than one currency');
    for (const id of ['mrr', 'arr', 'invoiced', 'revenue', 'outstanding'] as const) {
      const metric = businessMetric(app.ctx, ORG, { metric: id, start: 0, end: app.ctx.now(), window_label: 'all time' });
      assert.ok(!('error' in metric), `${id} errored`);
      assert.ok(metric.books.length > 0, `${id} came back with no books at all`);
      const sum = metric.books.reduce((a, b) => a + b.value, 0);
      if (metric.books.length > 1) {
        assert.equal(metric.mixedCurrency, true, `${id} holds ${metric.books.length} books and did not say so`);
        assert.notEqual(metric.value, sum, `${id} reported the cross-currency sum as its figure`);
        assert.equal(metric.currency, null, `${id} stamped one currency on a figure that is in several`);
        // Every book, and nothing but the books, in the sentence the answer uses.
        for (const book of metric.books) {
          assert.ok(metric.formatted.includes(book.formatted),
            `${id} did not state its ${book.currency.toUpperCase()} book: ${metric.formatted}`);
        }
        assert.ok(!metric.formatted.includes(spoken(sum, 'usd')), `${id} printed the sum with a dollar sign`);
      }
    }
  });

  test('MRR in the answer equals the ledger, per currency, and never the sum', async () => {
    const answer = await ask('What is our MRR?');
    const live = app.ctx.svc.billing.subscriptions(ORG, { status: 'all', limit: 500 });
    const books = new Map<string, number>();
    for (const sub of live) {
      const monthly = app.ctx.svc.billing.mrr(ORG, sub);
      if (monthly <= 0) continue;
      books.set(sub.currency, (books.get(sub.currency) ?? 0) + monthly);
    }
    assert.ok(books.size > 1, 'the fixture has more than one book');
    for (const [currency, amount] of books) {
      assert.ok(answer.content.includes(spoken(amount, currency)),
        `the ${currency.toUpperCase()} book ${spoken(amount, currency)} is missing:\n${answer.content}`);
    }
    const sum = [...books.values()].reduce((a, b) => a + b, 0);
    assert.ok(!answer.content.includes(spoken(sum, 'usd')),
      `${spoken(sum, 'usd')} is EUR + GBP + USD wearing a dollar sign:\n${answer.content}`);
    assert.match(answer.content, /no exchange rates/, 'and the answer says why there is no single figure');
  });

  test('a euro account is never ranked or printed in dollars', async () => {
    const answer = await ask('Who is our biggest customer by revenue?');
    const paid = app.ctx.db.all<{ name: string; currency: string; total: number }>(
      `SELECT c.name AS name, i.currency AS currency, SUM(i.amount_paid) AS total
       FROM billing_invoices i JOIN billing_customers c ON c.id = i.customer_id AND c.org_id = i.org_id
       WHERE i.org_id = ? AND i.status = 'paid' GROUP BY c.id, i.currency ORDER BY total DESC`, ORG);
    const byCurrency = new Map<string, { name: string; total: number }>();
    for (const row of paid) if (!byCurrency.has(row.currency)) byCurrency.set(row.currency, row);
    assert.ok(byCurrency.size > 1, 'the fixture has paying accounts in more than one currency');
    for (const [currency, leader] of byCurrency) {
      assert.ok(answer.content.includes(`${leader.name} — ${spoken(leader.total, currency)}`),
        `${currency.toUpperCase()}'s biggest account is ${leader.name} at ${spoken(leader.total, currency)}:\n${answer.content}`);
      // The same amount with the workspace's symbol on it is the defect.
      if (currency !== 'usd') {
        assert.ok(!answer.content.includes(`${leader.name} — ${spoken(leader.total, 'usd')}`),
          `${leader.name} bills in ${currency.toUpperCase()} and was printed in dollars`);
      }
    }
    assert.match(answer.content, /no exchange rates/, 'one ranking across three currencies is refused out loud');
  });

  test('a question that names one currency gets one figure, in that currency', async () => {
    const usd = app.ctx.svc.billing.subscriptions(ORG, { status: 'all', limit: 500 })
      .filter((s) => s.currency === 'usd')
      .reduce((sum, s) => sum + app.ctx.svc.billing.mrr(ORG, s), 0);
    assert.ok(usd > 0, 'the fixture has a USD book');
    const answer = await ask('What is our MRR in USD only?');
    assert.ok(answer.content.includes(spoken(usd, 'usd')), `expected ${spoken(usd, 'usd')} in:\n${answer.content}`);
    assert.ok(!/€|£/.test(answer.content), `a question scoped to USD came back with other books:\n${answer.content}`);
  });
});

describe('a snapshot is never compared against itself and called unchanged', () => {
  for (const question of [
    'How did MRR change compared to last quarter?',
    'Compare MRR in Q1 2026 to MRR in Q3 2026',
  ]) {
    test(`"${question}" answers from the movement report, not from the snapshot`, async () => {
      const answer = await ask(question);
      assert.ok(!/held the same/i.test(answer.content),
        `a snapshot compared with itself is not "no change":\n${answer.content}`);
      assert.ok(!/\bin both periods\b/i.test(answer.content),
        `nothing was measured "in both periods":\n${answer.content}`);
      assert.match(answer.content, /Recurring revenue moved/,
        `the movement report holds this history and must answer it:\n${answer.content}`);
      assert.ok(!/no .*history is kept/i.test(answer.content),
        `the workspace does keep this history — saying otherwise is a false claim about the database:\n${answer.content}`);
    });
  }

  test('a windowed metric still compares two periods normally', async () => {
    const answer = await ask('Compare closed-won bookings in Q1 2026 and Q2 2026');
    assert.ok(!/point-in-time/.test(answer.content), 'bookings are a period figure, not a snapshot');
    assert.match(answer.content, /Q1 2026/);
    assert.match(answer.content, /Q2 2026/);
  });

  test('a growth question about a snapshot is answered from the movement it does hold', async () => {
    const answer = await ask('Did MRR grow this year?');
    assert.match(answer.content, /Recurring revenue moved/);
    assert.ok(!/keeps no history/i.test(answer.content),
      `the movement report is in the catalogue, so "keeps no history" is false:\n${answer.content}`);
  });
});

describe('a question is not a command', () => {
  const septemberDeals = () => {
    const start = Date.UTC(2026, 8, 1);
    const end = Date.UTC(2026, 9, 1);
    return app.ctx.db.all<{ properties: string }>(
      `SELECT properties FROM crm_records
       WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL`, ORG)
      .map((row) => JSON.parse(row.properties) as { deal_stage?: string; close_date?: number; amount?: number })
      .filter((p) => Number(p.close_date ?? 0) >= start && Number(p.close_date ?? 0) < end);
  };

  for (const question of ['Which deals close this month?', 'Which deals are closing this month?']) {
    test(`"${question}" is answered with the deals, not with "I changed nothing"`, async () => {
      const answer = await ask(question);
      assert.notEqual(answer.analysis.intent.intent, 'act', `"${question}" was classified as a write`);
      assert.ok(!/I changed nothing/.test(answer.content), `refused as a write:\n${answer.content}`);
      const expected = septemberDeals();
      assert.ok(expected.length >= 3, 'the fixture has deals closing in September 2026');
      assert.ok(answer.content.includes(`${expected.length} deals close in Sep 2026`),
        `the count sentence must carry the filter that produced it:\n${answer.content.slice(0, 300)}`);
    });
  }

  test('an actual instruction is still a write', () => {
    for (const instruction of ['Create a task to call the plant manager', 'Move the Rheinwerk OEE deal to Negotiation']) {
      assert.equal(classifyIntent(instruction).intent, 'act', `"${instruction}" stopped being a write`);
    }
  });

  test('a polite command inside a question is still a write', () => {
    assert.equal(classifyIntent('Can you move the Rheinwerk OEE deal to Negotiation?').intent, 'act');
  });
});

describe('a period the question named is the period that gets measured', () => {
  test('"what did we invoice in August 2026" measures August, not the whole book', async () => {
    const start = Date.UTC(2026, 7, 1);
    const end = Date.UTC(2026, 8, 1);
    const books = app.ctx.db.all<{ currency: string; total: number; n: number }>(
      `SELECT currency, SUM(total) AS total, COUNT(*) AS n FROM billing_invoices
       WHERE org_id = ? AND status NOT IN ('draft', 'void', 'deleted') AND finalized_at >= ? AND finalized_at < ?
       GROUP BY currency ORDER BY currency`, ORG, start, end);
    assert.ok(books.length > 0, 'the fixture invoiced something in August 2026');
    const answer = await ask('What did we invoice in August 2026?');
    for (const book of books) {
      const shown = formatMoney({ amount: book.total, currency: book.currency }, { locale: 'en-US', trimZeroFraction: true });
      assert.ok(answer.content.includes(shown), `expected ${book.currency.toUpperCase()} ${shown} in:\n${answer.content}`);
    }
    const whole = app.ctx.db.count(`SELECT COUNT(*) FROM billing_invoices WHERE org_id = ?`, ORG);
    assert.ok(!answer.content.includes(`${whole} invoices`),
      `the named month was dropped and the whole ${whole}-invoice book was answered over:\n${answer.content}`);
    // Nothing in the plan may read the ledger without the period it was told about.
    for (const step of answer.analysis.plan as { tool: string; args: Record<string, unknown> }[]) {
      if (step.tool !== 'billing_list_invoices') continue;
      assert.fail(`billing_list_invoices takes no period and was planned anyway: ${JSON.stringify(step.args)}`);
    }
  });

  test('an invoice list says how many of the rows it totalled are actually open', async () => {
    const answer = await ask('Which invoices are overdue?');
    const open = app.ctx.db.all<{ number: string; total: number; currency: string }>(
      `SELECT number, total, currency FROM billing_invoices
       WHERE org_id = ? AND status IN ('open', 'past_due') AND due_date IS NOT NULL AND due_date < ?`, ORG, app.ctx.now());
    assert.ok(open.length > 0, 'the fixture carries an overdue invoice');
    for (const row of open) assert.ok(answer.content.includes(row.number), `${row.number} is missing`);
    assert.ok(!/\d+ of them carry/.test(answer.content),
      `the subtotal must cover the open rows, and say so:\n${answer.content}`);
  });
});

describe('a value question is answered with a value', () => {
  const openPipeline = () => {
    const stages = stageSets(app.ctx, ORG);
    return app.ctx.db.all<{ properties: string }>(
      `SELECT properties FROM crm_records WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL`, ORG)
      .map((r) => JSON.parse(r.properties) as { deal_stage?: string; amount?: number })
      .filter((p) => stages.open.includes(String(p.deal_stage)))
      .reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
  };

  test('"what are our open deals worth" states the total', async () => {
    const total = openPipeline();
    assert.ok(total > 0);
    const answer = await ask('What are our open deals worth?');
    assert.ok(answer.content.includes(money(total)),
      `the total ${money(total)} is the answer, and it was missing:\n${answer.content.slice(0, 400)}`);
  });

  test('a pronoun bound inside the sentence is not an unresolved reference', async () => {
    const answer = await ask('How many open deals do we have and what are they worth?');
    assert.equal(answer.analysis.refusal, null, `refused as a dangling pronoun:\n${answer.content}`);
    assert.ok(!/I do not know what "they" refers to/.test(answer.content));
    const stages = stageSets(app.ctx, ORG);
    const open = app.ctx.db.all<{ properties: string }>(
      `SELECT properties FROM crm_records WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL`, ORG)
      .map((r) => JSON.parse(r.properties) as { deal_stage?: string })
      .filter((p) => stages.open.includes(String(p.deal_stage))).length;
    assert.ok(answer.content.includes(`${open} open deals`), `the count is missing:\n${answer.content}`);
    assert.ok(answer.content.includes(money(openPipeline())), `the value is missing:\n${answer.content}`);
  });

  test('a pronoun with nothing behind it is still refused', async () => {
    const answer = await ask('How much have they spent?');
    assert.equal(answer.analysis.refusal.code, 'unresolved_reference');
  });
});

describe('a colloquial name for a metric reaches the metric', () => {
  test('"how much did <account> pay us" is customer spend', async () => {
    const account = app.ctx.db.get<{ name: string }>(
      `SELECT display_name AS name FROM crm_records WHERE org_id = ? AND object_type = 'company' AND display_name = 'Meridian Forge Systems'`, ORG)!;
    const answer = await ask(`How much did ${account.name} pay us last year?`);
    assert.equal(answer.analysis.refusal, null, `refused a phrase the refusal itself offers:\n${answer.content}`);
    assert.equal(answer.analysis.metric.id, 'spend');
    assert.equal(answer.analysis.subject.label, account.name);
  });
});

describe('a follow-up in a thread answers the follow-up', () => {
  const thread = async (opening: string, ...rest: string[]) => {
    const start = await expectOk('POST', '/v1/ai/threads', { message: opening });
    const answers = [start.messages[start.messages.length - 1].content as string];
    for (const text of rest) {
      // Both routes take the same field, either spelling.
      const reply = await expectOk('POST', `/v1/ai/threads/${start.id}/messages`, { message: text });
      answers.push(reply.message.content as string);
    }
    return answers;
  };

  test('a field question is answered with the field, not with the account card again', async () => {
    const account = 'Meridian Forge Systems';
    const [profile, deals, cfo] = await thread(
      `Tell me about ${account}`, 'What deals are open there?', 'Who is the CFO?');
    assert.notEqual(deals, profile, 'the second turn replayed the first turn byte for byte');
    assert.notEqual(cfo, profile, 'the third turn replayed the first turn byte for byte');

    const company = app.ctx.db.get<{ id: string }>(
      `SELECT id FROM crm_records WHERE org_id = ? AND object_type = 'company' AND display_name = ?`, ORG, account)!;
    const finance = app.ctx.db.all<{ name: string; properties: string }>(
      `SELECT DISTINCT r.display_name AS name, r.properties FROM crm_records r
       JOIN crm_associations a ON a.org_id = r.org_id AND (a.from_id = r.id OR a.to_id = r.id)
       WHERE r.org_id = ? AND (a.to_id = ? OR a.from_id = ?) AND r.object_type = 'contact'`, ORG, company.id, company.id)
      .map((row) => ({ name: row.name, title: String((JSON.parse(row.properties) as { job_title?: string }).job_title ?? '') }))
      .filter((row) => /chief financial officer/i.test(row.title));
    assert.equal(finance.length, 1, 'the fixture has exactly one CFO on this account');
    assert.ok(cfo.startsWith(finance[0].name),
      `the answer must lead with the CFO's name, not bury it in a committee list:\n${cfo.slice(0, 200)}`);
  });

  test('"who owns this account" leads with the owner', async () => {
    // Read the account out of the workspace rather than naming one: earlier
    // suites in this file write to records, and a fixture pinned by name is a
    // test that fails for a reason that has nothing to do with the answer.
    const row = app.ctx.db.get<{ name: string; owner: string }>(
      `SELECT r.display_name AS name, u.name AS owner FROM crm_records r JOIN users u ON u.id = r.owner_id
       WHERE r.org_id = ? AND r.object_type = 'company' AND r.archived = 0 AND r.merged_into IS NULL
       ORDER BY r.display_name LIMIT 1`, ORG)!;
    assert.ok(row?.owner, 'the fixture has an owned account');
    const [, owner] = await thread(`Tell me about ${row.name}`, 'Who owns the account?');
    assert.ok(owner.startsWith(`${row.name} is owned by ${row.owner}`),
      `the answer leads with the owner:\n${owner.slice(0, 200)}`);
  });

  test('both thread routes accept both field names', async () => {
    const start = await expectOk('POST', '/v1/ai/threads', { content: 'What is our open pipeline?' });
    assert.equal(start.messages.length, 2, '`content` starts the conversation the same way `message` does');
    const viaContent = await call('POST', `/v1/ai/threads/${start.id}/messages`, { content: 'And how many open deals?' });
    assert.equal(viaContent.status, 201);
    const viaMessage = await call('POST', `/v1/ai/threads/${start.id}/messages`, { message: 'And how many open tickets?' });
    assert.equal(viaMessage.status, 201, 'the reply route takes `message` as well');
    const neither = await call('POST', `/v1/ai/threads/${start.id}/messages`, {});
    assert.equal(neither.status, 400);
    assert.match(String(neither.body.error.message), /`content`.*`message`/);
  });
});

describe('no answer prints an internal tool name or a raw payload at the reader', () => {
  const QUESTIONS = [
    'How did MRR change compared to last quarter?',
    'Which deals close this month?',
    'List deals with a close date in September 2026',
    'What did we invoice in August 2026?',
    'What is our open pipeline?',
    'Which accounts have gone quiet?',
  ];
  for (const question of QUESTIONS) {
    test(`"${question}" leaks no tool name`, async () => {
      const answer = await ask(question);
      assert.ok(!/also returned:/.test(answer.content), `an unrendered payload was dumped:\n${answer.content}`);
      for (const step of answer.analysis.steps as { tool: string }[]) {
        assert.ok(!answer.content.includes(`\`${step.tool}\``),
          `\`${step.tool}\` is an internal name and it reached the reader:\n${answer.content}`);
      }
      // Every result is still accounted for on the run record, with a reason.
      for (const result of answer.analysis.results as { tool: string; outcome: string; why: string | null }[]) {
        assert.ok(['rendered', 'empty', 'discarded'].includes(result.outcome));
        if (result.outcome === 'discarded') assert.ok(result.why, `${result.tool} was discarded with no reason recorded`);
      }
    });
  }
});

describe('a count sentence carries the filter that produced it', () => {
  test('a filtered deal list does not claim to be the whole workspace', async () => {
    const answer = await ask('List deals with a close date in September 2026');
    const all = app.ctx.db.count(
      `SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL`, ORG);
    assert.ok(!answer.content.includes(`${all} deal records in the workspace`),
      `the September subset was described as the whole book of ${all} deals:\n${answer.content.slice(0, 200)}`);
    assert.match(answer.content, /deals? close in Sep(?:tember)? 2026/);
  });

  test('a record count is a sentence, not a measure id and an object type', async () => {
    const contacts = app.ctx.db.count(
      `SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'contact' AND archived = 0 AND merged_into IS NULL`, ORG);
    const answer = await ask('How many contacts do we have?');
    assert.ok(!/count of records/.test(answer.content), `machine-generated non-English:\n${answer.content}`);
    assert.ok(answer.content.startsWith(`Northwind Robotics has ${contacts} contacts`),
      `expected a real sentence with ${contacts} in it:\n${answer.content}`);
  });
});

describe('accounts that have gone quiet are found by how quiet they are', () => {
  test('"which accounts have gone quiet" is ordered by last touch, not by recency of creation', async () => {
    const answer = await ask('Which accounts have gone quiet?');
    const cutoff = app.ctx.now() - 45 * 86_400_000;
    const quiet = app.ctx.db.all<{ name: string; last: number | null }>(
      `SELECT r.display_name AS name, (
         SELECT v.value_date FROM crm_record_values v
         WHERE v.org_id = r.org_id AND v.record_id = r.id AND v.property = 'last_activity_at') AS last
       FROM crm_records r
       WHERE r.org_id = ? AND r.object_type = 'company' AND r.archived = 0 AND r.merged_into IS NULL`, ORG)
      .filter((row) => !row.last || row.last <= cutoff)
      .sort((a, b) => (a.last ?? 0) - (b.last ?? 0));
    assert.ok(quiet.length >= 3, 'the fixture has accounts nobody has touched in 45 days');
    assert.ok(answer.content.includes(`${quiet.length} accounts`),
      `expected ${quiet.length} quiet accounts:\n${answer.content.slice(0, 300)}`);
    assert.ok(answer.content.includes(quiet[0].name),
      `the quietest account ${quiet[0].name} must be named:\n${answer.content.slice(0, 300)}`);
    assert.match(answer.content, /days since the last activity/);
    // The defect was the exact opposite ordering: newest records first.
    const newest = app.ctx.db.get<{ name: string }>(
      `SELECT display_name AS name FROM crm_records WHERE org_id = ? AND object_type = 'company' AND archived = 0
       ORDER BY created DESC LIMIT 1`, ORG)!;
    if (!quiet.some((row) => row.name === newest.name)) {
      assert.ok(!answer.content.includes(newest.name),
        `${newest.name} is the most recently created account and is not quiet, so it does not belong in this answer`);
    }
  });

  test('a threshold written into the question is the threshold used', async () => {
    const answer = await ask('Which accounts have we not touched in 120 days?');
    assert.match(answer.content, /more than 120 days/);
  });
});

describe('a metered workspace answers a volume question with a volume', () => {
  test('"how many telemetry events did we meter last month" states the metered total', async () => {
    const answer = await ask('How many telemetry events did we meter last month?');
    const step = (answer.analysis.plan as { tool: string; args: Record<string, unknown> }[])
      .find((s) => s.tool === 'metered_usage');
    assert.ok(step, `the plan was ${(answer.analysis.plan as { tool: string }[]).map((s) => s.tool).join(', ') || 'empty'}`);
    assert.equal(step.args.meter, 'mtr_nw_telemetry');

    // Ground truth is every account that streamed into the meter, which is what
    // the metering module's own /v1/meters/:id/customers enumerates — not the
    // billing book, which holds no row for two of the three biggest consumers.
    const expected = meterCustomerIds('mtr_nw_telemetry', Number(step.args.start), Number(step.args.end))
      .map((id) => app.ctx.svc.metering.usageForPeriod(ORG, 'mtr_nw_telemetry', id, Number(step.args.start), Number(step.args.end)))
      .filter((usage) => usage.event_count > 0)
      .reduce((sum, usage) => sum + usage.value, 0);
    assert.ok(expected > 0, 'the fixture metered telemetry last month');
    assert.ok(answer.content.includes(expected.toLocaleString('en-US')),
      `expected the metered total ${expected.toLocaleString('en-US')} in:\n${answer.content}`);
    // The catalogue is not an answer to a question that named a meter.
    assert.ok(!/Stored telemetry —/.test(answer.content),
      `the meter catalogue was returned instead of a number:\n${answer.content}`);
  });

  test('a meter question with no meter named still gets the catalogue', async () => {
    const answer = await ask('What do we meter?');
    assert.match(answer.content, /meters in Northwind Robotics/);
  });
});

describe('churn and retention are measures this workspace can name', () => {
  test('"what is our churn rate" answers with the revenue ledger\'s own logo churn', async () => {
    const answer = await ask('What is our churn rate?');
    assert.equal(answer.analysis.refusal, null, `refused as ambiguous:\n${answer.content}`);
    assert.equal(answer.analysis.metric.id, 'churn');
    const report = app.ctx.svc.revenue.churn(ORG, {
      from: answer.analysis.window.start, to: answer.analysis.window.end,
    });
    const rate = Number((report.totals.logo_churn.bps / 100).toFixed(1));
    assert.ok(answer.content.includes(`${rate}%`), `expected ${rate}% in:\n${answer.content.slice(0, 300)}`);
  });

  test('net revenue retention is reported per currency, never averaged into one', async () => {
    const answer = await ask('What is our net revenue retention this year?');
    const report = app.ctx.svc.revenue.churn(ORG, {
      from: answer.analysis.window.start, to: answer.analysis.window.end,
    });
    const perCurrency = report.by_currency
      .map((row: { currency: string; totals: { net_revenue_retention: { percent: string; undefined_rate: boolean } } }) => row)
      .filter((row) => !row.totals.net_revenue_retention.undefined_rate);
    assert.ok(perCurrency.length > 1, 'the fixture retains revenue in more than one currency');
    for (const row of perCurrency) {
      assert.ok(answer.content.includes(row.totals.net_revenue_retention.percent),
        `${row.currency.toUpperCase()} NRR ${row.totals.net_revenue_retention.percent} is missing:\n${answer.content}`);
    }
    assert.ok(!/\b0% net revenue retention\b/.test(answer.content),
      `an undefined workspace-wide rate must never be printed as 0%:\n${answer.content}`);
  });
});

describe('a citation names the row it cites', () => {
  test('subscription evidence is cited by account, not by primary key', async () => {
    const answer = await ask('What is our MRR?');
    assert.ok(answer.citations.length > 0, 'the rows behind the number are cited');
    for (const citation of answer.citations as { id: string; label: string }[]) {
      assert.notEqual(citation.label, citation.id, `${citation.id} is its own label, which identifies nothing`);
      assert.ok(!/^(sub|cus|in)_/.test(citation.label), `a raw id reached a citation label: ${citation.label}`);
      const sub = app.ctx.svc.billing.subscription(ORG, citation.id);
      if (!sub) continue;
      const name = app.ctx.svc.billing.customer(ORG, sub.customer)?.name;
      assert.ok(name && citation.label.startsWith(name), `${citation.id} should be cited as ${name}`);
    }
  });

  test('an aggregate cites the records it counted, by name', async () => {
    const answer = await ask('How many contacts do we have?');
    assert.ok(answer.citations.length > 0);
    for (const citation of answer.citations as { id: string; label: string }[]) {
      assert.notEqual(citation.label, 'matched record', 'a citation a reader cannot identify is not a citation');
      const record = app.ctx.db.get<{ name: string }>(
        `SELECT display_name AS name FROM crm_records WHERE org_id = ? AND id = ?`, ORG, citation.id);
      if (record) assert.equal(citation.label, record.name);
    }
  });
});

describe('a structured extraction never fills a business field with router confidence', () => {
  test('an expansion-risk score comes back null rather than as the intent confidence', async () => {
    const answer = await ask('Score Meridian Forge Systems for expansion risk', {
      response_schema: { type: 'object', fields: { risk: { type: 'string' }, score: { type: 'number' }, reason: { type: 'string' } } },
    });
    const value = JSON.parse(answer.content) as { risk: string | null; score: number | null; reason: string | null };
    assert.equal(value.score, null, 'nothing in the workspace scores expansion risk, so the field stays null');
    assert.ok(!answer.analysis.plan.some((s: { tool: string }) => s.tool === 'nonexistent'));
  });

  test('a field the schema documents as engine confidence is still filled', async () => {
    const answer = await ask('What is our open pipeline?', {
      response_schema: {
        type: 'object',
        fields: {
          total: { type: 'number' },
          confidence: { type: 'number', description: 'How sure the engine is about the intent it classified.' },
        },
      },
    });
    const value = JSON.parse(answer.content) as { total: number | null; confidence: number | null };
    assert.ok(typeof value.confidence === 'number' && value.confidence > 0, 'the documented field is filled');
  });
});

describe('copy a person reads', () => {
  test('an urgent draft with no contact still opens with a greeting', async () => {
    const answer = await ask('Draft an urgent email about the outage');
    assert.ok(!/^there,/m.test(answer.content), `a message that opens "there," is not a greeting:\n${answer.content}`);
  });

  test('a workspace with no name of its own is still a sentence subject', async () => {
    const answer = await expectOk('POST', '/v1/ai/complete', { prompt: 'How is the business doing?' }, OTHER_ORG);
    assert.ok(!/\[object Object\]/.test(answer.content), `an object was interpolated into the answer:\n${answer.content}`);
    assert.ok(!/(^|\n)this workspace /.test(answer.content),
      `a sentence opens with a lowercase workspace name:\n${answer.content}`);
  });
});

/* ==========================================================================
 * The answer is about the question that was asked
 *
 * Every test below was written against a defect a reader hit in the product,
 * and every one of them fails on the code that shipped it. The common shape is
 * always the same: a confident, well-written paragraph about a different
 * question, in the same register as the answers that are exactly right.
 * ======================================================================== */

describe('a metered volume counts every account that meters, not every account that is invoiced', () => {
  /** The meter's own customer list, exactly as `/v1/meters/:id/customers` builds it. */
  const meterTotal = (meterId: string, start: number, end: number) =>
    meterCustomerIds(meterId, start, end)
      .map((id) => app.ctx.svc.metering.usageForPeriod(ORG, meterId, id, start, end))
      .reduce((sum, usage) => sum + usage.value, 0);

  test('the workspace total is the meter’s total, not the billing book’s share of it', async () => {
    const answer = await ask('How many telemetry events did we meter last month?');
    const step = (answer.analysis.plan as { tool: string; args: Record<string, unknown> }[])
      .find((s) => s.tool === 'metered_usage')!;
    assert.ok(step, 'the usage capability answers a usage question');
    const start = Number(step.args.start);
    const end = Number(step.args.end);

    const billingOnly = app.ctx.svc.billing.customers(ORG, { limit: 500 })
      .map((c) => app.ctx.svc.metering.usageForPeriod(ORG, 'mtr_nw_telemetry', c.id, start, end))
      .reduce((sum, usage) => sum + usage.value, 0);
    const everyone = meterTotal('mtr_nw_telemetry', start, end);
    assert.ok(everyone > billingOnly,
      'the fixture meters accounts that have no billing customer row — otherwise this proves nothing');

    assert.ok(answer.content.includes(everyone.toLocaleString('en-US')),
      `the answer states the meter's own total ${everyone.toLocaleString('en-US')}:\n${answer.content}`);
    assert.ok(!answer.content.includes(billingOnly.toLocaleString('en-US')),
      `the billing book's share is not the workspace total:\n${answer.content}`);
  });

  test('an account that meters without an invoicing record is named among the biggest consumers', async () => {
    const answer = await ask('How many telemetry events did we meter last month?');
    const step = (answer.analysis.plan as { tool: string; args: Record<string, unknown> }[])
      .find((s) => s.tool === 'metered_usage')!;
    const unbilled = meterCustomerIds('mtr_nw_telemetry', Number(step.args.start), Number(step.args.end))
      .filter((id) => !app.ctx.svc.billing.customer(ORG, id));
    assert.ok(unbilled.length, 'the fixture has metering-only accounts');
    for (const id of unbilled) {
      const usage = app.ctx.svc.metering.usageForPeriod(ORG, 'mtr_nw_telemetry', id, Number(step.args.start), Number(step.args.end));
      assert.ok(answer.content.includes(usage.value.toLocaleString('en-US')),
        `${id} metered ${usage.value} and is missing from the answer:\n${answer.content}`);
    }
    // And named as a company, not as a primary key.
    assert.ok(!/cus_nw_/.test(answer.content), `a customer id leaked into the prose:\n${answer.content}`);
  });

  test('a metered volume for one account is that account’s number, not the meter catalogue', async () => {
    const answer = await ask('How much telemetry did Pemberton Auto Systems meter in August 2026?');
    const start = Date.UTC(2026, 7, 1);
    const end = Date.UTC(2026, 8, 1);
    const usage = app.ctx.svc.metering.usageForPeriod(ORG, 'mtr_nw_telemetry', 'cus_nw_pemberton', start, end);
    assert.ok(usage.value > 0, 'Pemberton metered telemetry in August 2026');
    assert.ok(answer.content.includes(usage.value.toLocaleString('en-US')),
      `the account's own metered total is the answer:\n${answer.content}`);
    assert.ok(!/Anomaly alerts raised — count/.test(answer.content),
      `the six-meter catalogue is not an answer to a question with a number in it:\n${answer.content}`);
  });
});

describe('recurring revenue movement is answered from the movement the workspace keeps', () => {
  for (const question of [
    'Show me MRR movement over the last six months',
    'How much new MRR did we add last quarter?',
    'Did MRR grow this year?',
  ]) {
    test(`"${question}" reads the movement report rather than denying it exists`, async () => {
      const answer = await ask(question);
      assert.ok(!/keeps no history|no .*history is kept/i.test(answer.content),
        `the movement report is in the live catalogue, so this is a false claim about the database:\n${answer.content}`);
      assert.match(answer.content, /Recurring revenue moved/);
      assert.match(answer.content, /new business|expansion|contraction|churn|flat at/);
      const plan = answer.analysis.plan as { tool: string }[];
      assert.ok(plan.some((s) => s.tool === 'revenue_movement'), `the plan was ${plan.map((s) => s.tool).join(', ') || 'empty'}`);
    });
  }

  test('the figures are the movement report’s own, per currency, and reconcile', async () => {
    const answer = await ask('Show me MRR movement over the last six months');
    const report = await runTool('revenue_movement', { months: 6 });
    const usd = (report.by_currency as { currency: string; opening: string; closing: string }[])
      .find((row) => row.currency === 'usd')!;
    assert.ok(answer.content.includes(usd.opening), `the USD opening ${usd.opening} is in the answer:\n${answer.content}`);
    assert.ok(answer.content.includes(usd.closing), `the USD closing ${usd.closing} is in the answer:\n${answer.content}`);
    assert.match(answer.content, /reconcile to the subscription ledger/);
  });

  test('a movement answer scoped to a named quarter shows that quarter, not the default span', async () => {
    const answer = await ask('How much new MRR did we add last quarter?');
    assert.match(answer.content, /Q2 2026/);
    assert.ok(!/Sep 2026 —/.test(answer.content),
      `a quarter that ended in June does not contain September:\n${answer.content}`);
  });
});

describe('one metric gets one source, and no answer states two figures for it', () => {
  test('net revenue retention is stated once per currency, from the windowed measure', async () => {
    const answer = await ask('What is our net revenue retention?');
    const summary = await runTool('revenue_summary');
    const gbp = (summary.by_currency as { currency: string; net_revenue_retention: string | null }[])
      .find((row) => row.currency === 'gbp');
    assert.ok(gbp?.net_revenue_retention, 'the trailing report also has a GBP retention figure');
    assert.ok(!answer.content.includes(gbp!.net_revenue_retention!),
      `the trailing figure ${gbp!.net_revenue_retention} is a second, unlabelled answer to the same question:\n${answer.content}`);
    // Exactly one retention figure per currency in the whole answer.
    const percents = answer.content.match(/\d+\.\d\d%/g) ?? [];
    assert.ok(percents.length > 0 && percents.length <= 6,
      `one figure per currency, not two sets of them: ${percents.join(', ')}\n${answer.content}`);
    assert.ok(!/safe to quote/.test(answer.content),
      `a blanket endorsement over two contradictory figures is the worst half of the defect:\n${answer.content}`);
  });
});

describe('a filter the question names is a filter the search runs', () => {
  const sql = (where: string, ...params: unknown[]) => app.ctx.db.count(
    `SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL AND ${where}`,
    ORG, ...params as string[]);

  test('a money threshold in the question becomes a condition on amount', async () => {
    const answer = await ask('Which open deals are worth more than $500,000?');
    const step = (answer.analysis.plan as { tool: string; args: Record<string, unknown> }[])
      .find((s) => s.tool === 'record_search')!;
    assert.ok(step, 'a list question runs a search');
    const conditions = step.args.conditions as { property: string; op: string; value?: number }[];
    const threshold = conditions.find((c) => c.property === 'amount');
    assert.ok(threshold, `the threshold reached the search: ${JSON.stringify(conditions)}`);
    assert.equal(threshold!.op, 'gt');
    assert.equal(threshold!.value, 50_000_000);

    const expected = sql(`json_extract(properties, '$.amount') > 50000000 AND json_extract(properties, '$.deal_status') = 'open'`);
    assert.ok(expected > 0 && expected < 8, 'the fixture has a handful of deals above the threshold');
    assert.match(answer.content, new RegExp(`${expected} open deals worth more than \\$500,000`));
    // Not one row below the number the reader typed.
    for (const [, amount] of answer.content.matchAll(/—\s\$([\d,]+)\s·/g)) {
      assert.ok(Number(amount.replace(/,/g, '')) > 500_000, `${amount} is below the stated threshold:\n${answer.content}`);
    }
  });

  test('a rep named in the question scopes the count to that rep', async () => {
    const priya = app.ctx.db.get<{ id: string }>(
      `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ? AND u.name = 'Priya Raman'`, ORG)!;
    const expected = app.ctx.db.count(
      `SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL
         AND owner_id = ? AND json_extract(properties, '$.deal_status') = 'open'`, ORG, priya.id);
    const workspace = app.ctx.db.count(
      `SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL
         AND json_extract(properties, '$.deal_status') = 'open'`, ORG);
    assert.ok(expected > 0 && expected < workspace, 'Priya owns some but not all of the open deals');

    const answer = await ask('How many open deals does Priya Raman have?');
    assert.match(answer.content, new RegExp(`Priya Raman has ${expected} open deals`));
    assert.ok(!answer.content.includes(`${workspace} open deals`),
      `the workspace figure answers a different question:\n${answer.content}`);
  });

  test('"which rep has the most pipeline" is answered per rep, not with a list of deals', async () => {
    const answer = await ask('Which rep has the most pipeline?');
    const owners = app.ctx.db.all<{ owner: string; total: number }>(
      `SELECT owner_id AS owner, SUM(json_extract(properties, '$.amount')) AS total FROM crm_records
       WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL
         AND json_extract(properties, '$.deal_status') = 'open'
       GROUP BY owner_id ORDER BY total DESC`, ORG);
    const top = app.ctx.db.get<{ name: string }>(`SELECT name FROM users WHERE id = ?`, owners[0].owner)!;
    assert.match(answer.content, new RegExp(`${top.name} is the biggest`));
    assert.ok(answer.content.includes(money(owners[0].total)),
      `that rep's own pipeline total is the answer:\n${answer.content}`);
  });

  test('a headline describes the filters that ran, never the whole population', async () => {
    const total = sql('1 = 1');
    for (const question of ['Show me deals over $500,000', 'Which deals have no next step?']) {
      const answer = await ask(question);
      assert.ok(!answer.content.includes(`${total} deal records in the workspace`),
        `"${question}" was answered under a headline naming all ${total} deals:\n${answer.content.slice(0, 200)}`);
    }
  });

  test('"the deals we lost this year" says they closed, not that they close', async () => {
    const answer = await ask('List the deals we lost this year');
    assert.match(answer.content, /closed-lost deals closed in 2026/);
  });
});

describe('a price question is answered with a price', () => {
  test('"how much would 50 million telemetry events cost" quotes the meter’s own price', async () => {
    const answer = await ask('How much would 50 million telemetry events cost?');
    const plan = answer.analysis.plan as { tool: string; args: Record<string, unknown> }[];
    const step = plan.find((s) => s.tool === 'catalog_quote_price');
    assert.ok(step, `a price question runs the price book; the plan was ${plan.map((s) => s.tool).join(', ') || 'empty'}`);
    assert.equal(step!.args.quantity, 50_000_000);
    assert.match(answer.content, /costs \$/);
    assert.match(answer.content, /a unit/);
    assert.ok(!/metered .* events on Telemetry events/.test(answer.content),
      `a usage volume is not a price:\n${answer.content}`);
  });
});

describe('a structured response is machine-safe or explicitly empty', () => {
  test('a JSON-Schema `properties` object is accepted, not answered with null', async () => {
    const answer = await ask('Is Meridian Forge Systems a churn risk?', {
      response_schema: { type: 'object', properties: { risk: { type: 'string' }, score: { type: 'number' }, reason: { type: 'string' } } },
    });
    assert.notEqual(answer.content.trim(), 'null', `a silent null is indistinguishable from "nothing extracted":\n${answer.content}`);
    const value = JSON.parse(answer.content) as Record<string, unknown>;
    assert.deepEqual(Object.keys(value).sort(), ['reason', 'risk', 'score']);
  });

  test('an object schema naming no members is rejected with the shape spelled out', async () => {
    const res = await call('POST', '/v1/ai/complete', { prompt: 'What is our MRR?', response_schema: { type: 'object' } });
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: { code: string } }).error.code, 'response_schema_invalid');
    assert.match((res.body as { error: { message: string } }).error.message, /properties/);
  });

  test('a deal’s `amount` is that deal’s amount, never the whole pipeline', async () => {
    const answer = await ask('Summarise the largest open deal', {
      response_schema: {
        type: 'object',
        fields: { deal_name: { type: 'string' }, amount: { type: 'number' }, stage: { type: 'string' }, owner: { type: 'string' } },
      },
    });
    const value = JSON.parse(answer.content) as { deal_name: string | null; amount: number | null };
    const biggest = app.ctx.db.get<{ name: string; amount: number }>(
      `SELECT display_name AS name, json_extract(properties, '$.amount') AS amount FROM crm_records
       WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL
         AND json_extract(properties, '$.deal_status') = 'open'
       ORDER BY amount DESC LIMIT 1`, ORG)!;
    const pipeline = app.ctx.db.count(
      `SELECT COALESCE(SUM(json_extract(properties, '$.amount')), 0) FROM crm_records
       WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL
         AND json_extract(properties, '$.deal_status') = 'open'`, ORG);
    assert.notEqual(value.amount, pipeline, `the workspace pipeline was written into one deal's amount:\n${answer.content}`);
    assert.equal(value.amount, biggest.amount);
    assert.equal(value.deal_name, biggest.name);
  });

  test('a multi-currency metric leaves a single `amount` null rather than picking a book', async () => {
    const answer = await ask('What is our MRR?', {
      response_schema: { type: 'object', fields: { amount: { type: 'number' }, currency: { type: 'string' }, summary: { type: 'string' } } },
    });
    const value = JSON.parse(answer.content) as { amount: number | null; currency: string | null; summary: string | null };
    const books = (await runTool('revenue_summary')).by_currency as { currency: string }[];
    assert.ok(books.length > 1, 'the demo workspace bills in more than one currency');
    assert.equal(value.amount, null, `there is no single MRR figure, so there is no number to give:\n${answer.content}`);
    assert.equal(value.currency, null);
    assert.ok((answer.reasoning as string[]).some((line) => /left .*amount.* null/.test(line)),
      `the omission is reported, not silent: ${(answer.reasoning as string[]).join(' | ')}`);
  });
});

describe('a capability the workspace publishes is reachable by its own name', () => {
  test('"show me the recovery queue" reads the recovery queue', async () => {
    const answer = await ask('Show me the recovery queue');
    assert.ok(!/match no record, metric, property or period/.test(answer.content),
      `the capability is in the live catalogue, so this refusal is false:\n${answer.content}`);
    const queue = await runTool('payments.recovery_queue');
    const first = (queue.campaigns as { customer: string; at_risk: string }[])[0];
    assert.ok(first, 'the fixture has an account in recovery');
    assert.ok(answer.content.includes(first.customer), `the account in recovery is named:\n${answer.content}`);
    assert.ok(answer.content.includes(first.at_risk), `the amount at risk is stated:\n${answer.content}`);
  });

  test('"what is our forecast" is the weighted pipeline, not a refusal that offers it by name', async () => {
    const answer = await ask('What is our forecast for this quarter?');
    assert.equal(answer.analysis.refusal, null, `refused while naming the measure it could have used:\n${answer.content}`);
    const weighted = app.ctx.db.count(
      `SELECT COALESCE(SUM(json_extract(properties, '$.weighted_amount')), 0) FROM crm_records
       WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL
         AND json_extract(properties, '$.deal_status') = 'open'`, ORG);
    assert.ok(answer.content.includes(money(weighted)), `the weighted pipeline is the answer:\n${answer.content}`);
  });

  test('"what are the properties on a deal" lists the properties, not the deals', async () => {
    const answer = await ask('What are the properties on a deal?');
    const rows = await runTool('list_properties', { object_type: 'deal' }) as { label: string; name: string }[];
    assert.match(answer.content, new RegExp(`${rows.length} properties on a deal`));
    assert.ok(answer.content.includes('`amount`'), `the machine names are usable:\n${answer.content}`);
    assert.ok(!/closes Sep|Qualification ·/.test(answer.content), `deal records are not properties:\n${answer.content}`);
  });

  test('the suggested pipeline question ends without a false apology about a tool', async () => {
    const answer = await ask('What is our open pipeline by stage?');
    assert.ok(!/could not read anything back from list pipelines/.test(answer.content),
      `every field of that payload is nameable:\n${answer.content}`);
    assert.match(answer.content, /pipelines in this workspace/);
  });
});

describe('the ledger answers first, and it answers about the account named', () => {
  test('a credit question about a metering-only account reaches the credit ledger', async () => {
    const answer = await ask('What credit does Aldergate Semiconductor have left?');
    assert.ok(!/`credits\.balance`/.test(answer.content), `an internal tool id was printed to the reader:\n${answer.content}`);
    const balance = await runTool('credits.balance', { customer: 'cus_nw_aldergate' });
    const grant = (balance.scheduled as { balance: number; currency: string; name: string }[])[0];
    assert.ok(grant, 'Aldergate holds a scheduled grant in the fixture');
    const shown = formatMoney({ amount: grant.balance, currency: grant.currency }, { locale: 'en-US' });
    assert.ok(answer.content.includes(shown), `the grant of ${shown} is in the answer:\n${answer.content}`);
    assert.ok(answer.content.indexOf('credit') < answer.content.indexOf('Buying committee'),
      `the credit answer leads; the account card is context under it:\n${answer.content}`);
  });

  test('"which customers are past due" answers from the customer ledger', async () => {
    const answer = await ask('Which customers are past due?');
    const plan = answer.analysis.plan as { tool: string }[];
    assert.ok(plan.some((s) => s.tool === 'delinquent_customers'),
      `subscription status is a different table about a different thing; the plan was ${plan.map((s) => s.tool).join(', ')}`);
    assert.match(answer.content, /past due on the customer ledger/);
    const delinquent = app.ctx.svc.billing.customers(ORG, { delinquent: true, limit: 50 });
    assert.ok(delinquent.length, 'the fixture has delinquent customers');
    for (const customer of delinquent) {
      assert.ok(answer.content.includes(customer.name), `${customer.name} owes and is missing:\n${answer.content}`);
    }
  });

  test('"what happened on an account" is that account’s history, not the workspace’s losses', async () => {
    const answer = await ask('What happened on the Meridian Forge Systems account recently?');
    assert.ok(!/Losses in the period group by/.test(answer.content),
      `a workspace-wide loss breakdown under an account-scoped sentence reads as that account's:\n${answer.content}`);
    const plan = answer.analysis.plan as { tool: string }[];
    assert.ok(plan.some((s) => s.tool === 'record_timeline'), `the timeline is the obvious tool; the plan was ${plan.map((s) => s.tool).join(', ')}`);
    const others = ['Puebla Autopartes', 'Redstone Energy Services', 'Kilbride Dairy Systems'];
    for (const name of others) {
      assert.ok(!answer.content.includes(name), `${name} is a different company:\n${answer.content}`);
    }
  });
});

describe('a question with no capability behind it is refused, not filled with a record dump', () => {
  for (const question of ['Who should I call today?', 'Which accounts are at risk of churning?']) {
    test(`"${question}" says so rather than listing the most recent records`, async () => {
      const answer = await ask(question);
      assert.ok(!/records in the workspace\. The \d+ most recent/.test(answer.content),
        `a recency-ordered dump reads as an answer to the question asked:\n${answer.content}`);
      assert.match(answer.content, /Nothing I hold answers that/);
      assert.match(answer.content, /which accounts have gone quiet/);
    });
  }

  test('a record that is not an account can still be the subject of a summary', async () => {
    const ticket = app.ctx.db.get<{ id: string; name: string }>(
      `SELECT id, display_name AS name FROM crm_records
       WHERE org_id = ? AND object_type = 'ticket' AND archived = 0 AND merged_into IS NULL
       ORDER BY updated DESC LIMIT 1`, ORG)!;
    const answer = await ask(`Summarise the ${ticket.name} ticket`);
    assert.ok(!/booked \$|Biggest open deals/.test(answer.content),
      `the workspace's quarter is not a summary of one ticket:\n${answer.content}`);
    assert.match(answer.content, new RegExp(`Ticket "${ticket.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    // Two tickets can carry the same subject; what matters is that the record
    // read is the one the question named, by name.
    const plan = answer.analysis.plan as { tool: string; args: Record<string, unknown> }[];
    const read = plan.map((step) => String(step.args.id ?? step.args.record_id ?? ''))
      .filter(Boolean)
      .map((id) => app.ctx.db.get<{ name: string }>(`SELECT display_name AS name FROM crm_records WHERE org_id = ? AND id = ?`, ORG, id)?.name);
    assert.ok(read.length && read.every((name) => name === ticket.name),
      `the ticket the question named is the record that was read: ${JSON.stringify(plan)}`);
  });

  test('a question that really does ask for a listing still gets one', async () => {
    const answer = await ask('List our deals');
    assert.match(answer.content, /deal/);
    assert.ok((answer.analysis.plan as { tool: string }[]).some((s) => s.tool === 'record_search'));
  });

  test('a question that asks for the state of the business still gets the overview', async () => {
    const answer = await ask('How are we doing?');
    assert.ok((answer.analysis.plan as { tool: string }[]).length >= 2, 'the overview is several readings');
    assert.match(answer.content, /open tickets|open pipeline|booked/);
  });
});

describe('the answer says only what it can stand behind', () => {
  test('an enumeration names every row it counted', async () => {
    const answer = await ask('Which accounts have gone quiet?');
    const claim = answer.content.match(/(\d+) of those carr(?:y|ies) open pipeline — ([^\n]+?) — which/);
    assert.ok(claim, `the exposure sentence is there:\n${answer.content}`);
    const named = claim![2].split(/,\s|\sand\s/).filter(Boolean).length;
    assert.equal(named, Number(claim![1]), `${claim![1]} claimed, ${named} named:\n${claim![0]}`);
  });

  test('a contact list renders a job title and an email, not our own rep', async () => {
    const answer = await ask('Give me a list of contacts at Rheinwerk Antriebstechnik');
    const line = answer.content.split('\n').find((l: string) => l.startsWith('• Katrin Pfeiffer'));
    assert.ok(line, `the contact is listed:\n${answer.content}`);
    assert.match(line!, /Chief Financial Officer/);
    assert.match(line!, /@rheinwerk\.de/);
    const reps = app.ctx.db.all<{ name: string }>(
      `SELECT u.name FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ?`, ORG);
    for (const rep of reps) {
      assert.ok(!line!.includes(rep.name), `"${rep.name}" is our rep, and reads as this contact's title:\n${line}`);
    }
  });

  test('two periods with the same figure are described in English', async () => {
    const answer = await ask('Compare invoiced in USD in July 2026 and August 2026');
    assert.ok(!/the same invoiced in both periods/.test(answer.content),
      `the metric label was substituted where the noun belongs:\n${answer.content}`);
    assert.match(answer.content, /was unchanged across the two/);
  });

  test('a deal-type split is a sentence', async () => {
    const answer = await ask('What did we close last quarter and why?');
    assert.ok(!/What did close splits by/.test(answer.content), `that sentence has no verb:\n${answer.content}`);
    assert.match(answer.content, /What closed, by deal type/);
  });
});

describe('a thread does not repeat itself, and an unknown thread is an error', () => {
  test('an unknown thread_id is a 404, matching every other thread route', async () => {
    const res = await call('POST', '/v1/ai/complete', { prompt: 'What is our MRR?', thread_id: 'thr_does_not_exist' });
    assert.equal(res.status, 404, 'a reply attached to no thread is not a success');
  });

  test('the account profile is given once in a thread, not on every turn', async () => {
    const thread = await expectOk('POST', '/v1/ai/threads', { title: 'Meridian' });
    const turn = async (message: string) =>
      (await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, { message })).message.content as string;

    const first = await turn('Tell me about Meridian Forge Systems');
    assert.match(first, /Buying committee/, 'turn one gives the profile');
    const second = await turn('How much have they spent?');
    const third = await turn('What are their open tickets?');
    for (const [n, content] of [[2, second], [3, third]] as [number, string][]) {
      assert.ok(!/Buying committee/.test(content), `turn ${n} reprints the profile from turn one:\n${content}`);
    }
    assert.match(second, /spent/);
    assert.match(third, /ticket/);
  });
});

describe('a draft carries the numbers the recipient needs to act', () => {
  test('a dunning note names the invoices, the amounts and the dates', async () => {
    const meridian = app.ctx.svc.billing.customerByCrmRecord(ORG, 'cmp_nw_01')!;
    const open = app.ctx.svc.billing.invoices(ORG, { customer: meridian.id, status: 'open_like', limit: 20 })
      .filter((invoice) => invoice.amount_due > 0);
    assert.ok(open.length, 'Meridian has unpaid invoices in the fixture');

    const draft = await expectOk('POST', '/v1/ai/draft', {
      kind: 'dunning', record_id: 'cmp_nw_01', instruction: 'Chase the outstanding invoice',
    });
    for (const invoice of open) {
      assert.ok(draft.body.includes(invoice.number), `${invoice.number} is not in the note:\n${draft.body}`);
      const shown = formatMoney({ amount: invoice.amount_due, currency: invoice.currency }, { locale: 'en-US' });
      assert.ok(draft.body.includes(shown), `${shown} is not in the note:\n${draft.body}`);
    }
  });

  test('an escalation update has content where its heading promises content', async () => {
    const draft = await expectOk('POST', '/v1/ai/draft', {
      kind: 'escalation_update', record_id: 'cmp_nw_01', instruction: 'Update them on the escalation',
    });
    assert.ok(!/Here is where it stands and what happens next\./.test(draft.body),
      `a heading for a paragraph that was never written:\n${draft.body}`);
    assert.match(draft.body, /Where it stands: /);
  });
});
