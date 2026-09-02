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
import { QualifierLedger, crmVocabulary, stageIn, stageLabels, unitVocabulary, unitsNamed } from '../src/server/ai/qualifiers';
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
    const answer = await ask('Which pipelines do we have?');
    assert.ok(!/could not read anything back from list pipelines/.test(answer.content),
      `every field of that payload is nameable:\n${answer.content}`);
    assert.match(answer.content, /pipelines in this workspace/);
  });

  test('the pipeline catalogue is the answer to a catalogue question and to no other', async () => {
    // The glossary used to be attached to any sentence containing the word.
    // "Break down open pipeline by stage" is a question with a number in it,
    // and three pipeline definitions printed under that number answer "what
    // pipelines do we have" — a question the reader did not ask.
    const asked = await ask('Which pipelines do we have?');
    const pipelines = app.ctx.db.all<{ label: string }>(
      `SELECT label FROM crm_pipelines WHERE org_id = ? AND object_type = 'deal' ORDER BY position`, ORG);
    assert.ok(pipelines.length >= 3, 'the fixture has a pipeline catalogue');
    for (const pipeline of pipelines) {
      assert.ok(asked.content.includes(pipeline.label),
        `"Which pipelines do we have?" must name ${pipeline.label}:\n${asked.content}`);
    }
    assert.ok(!/\$9,010,960/.test(asked.content),
      `a question about the vocabulary is not answered with the workspace total:\n${asked.content}`);

    const scoped = await ask('Break down open pipeline by stage');
    assert.ok(!/pipelines in this workspace/.test(scoped.content),
      `the catalogue is a glossary nobody asked for here:\n${scoped.content}`);
    assert.match(scoped.content, /Breakdown:/);
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

/* ------------------ the qualifier ledger: one invariant ------------------- */

/**
 * The engine used to answer a different question than the one asked, at high
 * confidence, whenever it could not bind a word that narrowed the query: the
 * workspace total for a named pipeline, the open-deal count for a named stage,
 * an unrelated company for a named owner, open pipeline for weighted pipeline.
 * Every one of those was one bug — a qualifier parsed, resolved and then
 * dropped on the way into the query.
 *
 * This suite is the invariant, not a list of the nine questions that exposed
 * it. Every case names a qualifier type, carries an answer computed from the
 * database by a path the engine does not use, and asserts that the engine
 * either returns that answer or refuses. And every case asserts the structural
 * rule underneath: no qualifier reaches an answer still `pending`.
 */
describe('every qualifier the question names is bound, refused or waived', () => {
  const DEAL = `FROM crm_records WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL`;
  const OPEN = `json_extract(properties, '$.deal_status') = 'open'`;

  const dealSum = (where: string, ...params: unknown[]): number => app.ctx.db.count(
    `SELECT COALESCE(SUM(json_extract(properties, '$.amount')), 0) ${DEAL} AND ${where}`, ORG, ...(params as string[]));
  const dealWeighted = (where: string, ...params: unknown[]): number => app.ctx.db.count(
    `SELECT COALESCE(SUM(json_extract(properties, '$.weighted_amount')), 0) ${DEAL} AND ${where}`, ORG, ...(params as string[]));
  const dealCount = (where: string, ...params: unknown[]): number => app.ctx.db.count(
    `SELECT COUNT(*) ${DEAL} AND ${where}`, ORG, ...(params as string[]));
  const dealNames = (where: string, ...params: unknown[]): string[] => app.ctx.db
    .all<{ display_name: string }>(`SELECT display_name ${DEAL} AND ${where}`, ORG, ...(params as string[]))
    .map((row) => row.display_name);

  const personId = (name: string): string => app.ctx.db.pluck<string>(
    `SELECT id FROM users WHERE id IN (SELECT user_id FROM memberships WHERE org_id = ?) AND name = ?`, ORG, name)!;

  const Q2_2026 = { start: Date.UTC(2026, 3, 1), end: Date.UTC(2026, 6, 1), label: 'Q2 2026' };
  const AUGUST_2026 = { start: Date.UTC(2026, 7, 1), end: Date.UTC(2026, 8, 1), label: 'August 2026' };

  interface Expectation {
    /** Strings the answer has to contain when it answers at all. */
    must?: string[];
    /** Strings that would mean the qualifier was dropped and the wider query answered. */
    mustNot?: string[];
    /** True when refusing is the only correct outcome. */
    refuseOnly?: boolean;
    /** A last check with the whole completion in hand. */
    also?: (answer: any) => void;
  }

  interface ScopedCase {
    question: string;
    /** The qualifier types the question names; each must appear in the ledger. */
    names: string[];
    expect: () => Expectation;
  }

  const cases: ScopedCase[] = [
    /* ---- pipeline: six phrasings of one question, all previously unscoped --- */
    ...[
      'What is the Renewal pipeline worth?',
      'How much is in the Renewal pipeline?',
      'What is the value of the Renewal pipeline?',
      'How big is the Renewal pipeline right now?',
      'Give me the Renewal pipeline total.',
      'Renewal pipeline value please.',
    ].map((question): ScopedCase => ({
      question,
      names: ['pipeline'],
      expect: () => ({
        must: [money(dealSum(`${OPEN} AND json_extract(properties, '$.pipeline') = 'renewal'`))],
        // The whole book, which is what every one of these six used to answer.
        mustNot: [money(dealSum(OPEN))],
      }),
    })),

    /* ------------------------- metric: the named one ------------------------ */
    {
      question: 'What is our weighted pipeline?',
      names: ['metric'],
      expect: () => ({
        must: [money(dealWeighted(OPEN))],
        mustNot: [money(dealSum(OPEN))],
      }),
    },
    {
      // A measure the catalogue does not hold is named back, never answered
      // with the nearest neighbour that happens to share a word.
      question: 'What is our pipeline coverage this quarter?',
      names: ['metric'],
      expect: () => ({ refuseOnly: true }),
    },
    {
      question: 'What is our CAC?',
      names: ['metric'],
      expect: () => ({ refuseOnly: true }),
    },

    /* -------------------------------- stage -------------------------------- */
    {
      question: 'How many deals are in Negotiation?',
      names: ['stage'],
      expect: () => ({
        must: [String(dealCount(`json_extract(properties, '$.deal_stage') = 'negotiation'`))],
        mustNot: [`${dealCount(OPEN)} open deals`],
      }),
    },
    {
      question: 'How many deals are in Technical validation?',
      names: ['stage'],
      expect: () => ({
        must: [String(dealCount(`json_extract(properties, '$.deal_stage') = 'technical_validation'`))],
        mustNot: [`${dealCount(OPEN)} open deals`],
      }),
    },
    {
      question: 'Which deals are in Proposal sent?',
      names: ['stage'],
      expect: () => ({
        also: (answer) => {
          const named = dealNames(`json_extract(properties, '$.deal_stage') = 'proposal'`);
          const others = dealNames(`json_extract(properties, '$.deal_stage') <> 'proposal'`);
          assert.ok(named.some((name) => answer.content.includes(name)),
            `no deal at the Proposal sent stage is named:\n${answer.content}`);
          for (const other of others) {
            assert.ok(!answer.content.includes(other),
              `"${other}" is not at the Proposal sent stage:\n${answer.content}`);
          }
        },
      }),
    },
    {
      question: 'How many deals are in the Red lines stage?',
      names: ['stage'],
      expect: () => ({ refuseOnly: true }),
    },
    {
      // A stage that exists, on a measure that cannot take one. The capability
      // says exactly why; the answer used to be "nothing I hold answers that"
      // with that explanation left in the trace.
      question: 'How many tickets are in the Negotiation stage?',
      names: ['stage'],
      expect: () => ({ refuseOnly: true }),
    },

    /* -------------------------------- owner -------------------------------- */
    {
      question: 'How much pipeline does Marcus Ilori own?',
      names: ['owner'],
      expect: () => ({
        must: [money(dealSum(`${OPEN} AND owner_id = ?`, personId('Marcus Ilori')))],
        // The workspace total, and the company a weaker match on his first name
        // used to hand the question to.
        mustNot: [money(dealSum(OPEN)), 'Whitcombe Aerospace'],
      }),
    },
    {
      question: 'How many open deals does Priya Raman have?',
      names: ['owner'],
      expect: () => ({
        must: [String(dealCount(`${OPEN} AND owner_id = ?`, personId('Priya Raman')))],
      }),
    },

    /* -------------------------------- status ------------------------------- */
    {
      question: 'Which deals did we lose in Q2 2026?',
      names: ['status', 'period'],
      expect: () => ({
        also: (answer) => {
          const inWindow = `json_extract(properties, '$.close_date') >= ${Q2_2026.start} AND json_extract(properties, '$.close_date') < ${Q2_2026.end}`;
          const lost = dealNames(`json_extract(properties, '$.deal_stage') = 'closed_lost' AND ${inWindow}`);
          const notLost = dealNames(`json_extract(properties, '$.deal_stage') <> 'closed_lost'`);
          assert.ok(lost.length, 'the fixture has deals lost in Q2 2026');
          for (const name of lost) {
            assert.ok(answer.content.includes(name), `"${name}" was lost in Q2 2026 and is missing:\n${answer.content}`);
          }
          for (const name of notLost) {
            assert.ok(!answer.content.includes(name), `"${name}" was not lost, so it is not an answer:\n${answer.content}`);
          }
          assert.ok(!new RegExp(`${dealCount(OPEN)} open deals`).test(answer.content),
            `the open-deal count is not an answer about losses:\n${answer.content}`);
        },
      }),
    },

    /* -------------------------------- period ------------------------------- */
    {
      question: 'What did we invoice in August 2026?',
      names: ['period'],
      expect: () => ({
        must: ['August 2026'],
        also: (answer) => {
          // Every invoice this answer stands on was issued inside the month the
          // question named. The failure this replaces cited July 2025 and July
          // 2026 under an August heading.
          for (const citation of answer.citations as { id: string }[]) {
            if (!citation.id.startsWith('in_')) continue;
            const issued = app.ctx.db.pluck<number>(
              `SELECT COALESCE(finalized_at, created) FROM billing_invoices WHERE org_id = ? AND id = ?`, ORG, citation.id);
            assert.ok(issued !== undefined && issued >= AUGUST_2026.start && issued < AUGUST_2026.end,
              `cited ${citation.id}, issued ${issued ? new Date(issued).toISOString().slice(0, 10) : 'never'}, under a question about August 2026`);
          }
        },
      }),
    },
    {
      question: 'How much did we book in Q2 2026?',
      names: ['period'],
      expect: () => ({
        must: [money(dealSum(
          `json_extract(properties, '$.deal_stage') = 'closed_won'`
          + ` AND json_extract(properties, '$.close_date') >= ${Q2_2026.start}`
          + ` AND json_extract(properties, '$.close_date') < ${Q2_2026.end}`))],
      }),
    },
    {
      // A period the parser cannot resolve is refused rather than swapped for
      // the default quarter, forwards or backwards.
      question: 'How much did we book in the month before last?',
      names: ['period'],
      expect: () => ({ refuseOnly: true }),
    },

    /* ------------------------ pipeline plus a stage ------------------------- */
    {
      question: 'What is the New business pipeline worth at the Negotiation stage?',
      names: ['pipeline', 'stage'],
      expect: () => ({
        must: [money(dealSum(
          `json_extract(properties, '$.pipeline') = 'new_business' AND json_extract(properties, '$.deal_stage') = 'negotiation'`))],
        mustNot: [money(dealSum(OPEN))],
      }),
    },

    /* -------------------------------- account ------------------------------ */
    {
      question: 'What is Meridian Forge Systems carrying in open pipeline?',
      names: ['account'],
      expect: () => ({
        must: ['Meridian Forge Systems'],
        mustNot: [money(dealSum(OPEN))],
      }),
    },

    /* ------------------------------- currency ------------------------------ */
    {
      // A currency the listing cannot be told about. Nothing in the plan takes
      // one, so the entry never binds — and an unbound qualifier is a refusal,
      // not a list of every deal at that stage under the reader's own "in EUR".
      question: 'Which deals are in Negotiation in EUR?',
      names: ['currency', 'stage'],
      expect: () => ({ refuseOnly: true }),
    },
    {
      question: 'What did we invoice in August 2026 in USD?',
      names: ['currency', 'period'],
      expect: () => ({
        must: ['August 2026'],
        // One book was named, so the other two are not part of the answer.
        mustNot: ['€', '£'],
      }),
    },

    /* -------------------------------- limit -------------------------------- */
    {
      question: 'Who are our top 3 customers by revenue in 2025?',
      names: ['limit', 'period'],
      expect: () => ({
        also: (answer) => {
          const bullets = answer.content.split('\n').filter((line: string) => line.trim().startsWith('•'));
          assert.ok(bullets.length <= 3,
            `the question asked for three and the answer lists ${bullets.length}:\n${answer.content}`);
        },
      }),
    },

    /* --------------------------------- unit -------------------------------- */
    {
      question: 'What credit does Meridian Forge Systems have left?',
      names: ['account'],
      expect: () => ({
        also: (answer) => {
          // A unit grant is a count of meter units. The failure this replaces
          // ran a 6,000,000-event pack through the money formatter and printed
          // "$60,000.00" — and reported a live event pot as "$0.00 available".
          const grants = app.ctx.db.all<{ name: string; amount_micro: number; unit_label: string }>(
            `SELECT g.name, g.amount_micro, g.unit_label FROM credit_grants g
             JOIN billing_customers c ON c.id = g.customer_id AND c.org_id = g.org_id
             WHERE g.org_id = ? AND c.name = 'Meridian Forge Systems' AND g.kind = 'unit'`, ORG);
          assert.ok(grants.length, 'Meridian holds unit-denominated credit in the fixture');
          for (const grant of grants) {
            const asMoney = money(grant.amount_micro / 1_000_000);
            assert.ok(!answer.content.includes(asMoney),
              `${grant.name} is ${grant.unit_label}s, and "${asMoney}" states it as money:\n${answer.content}`);
          }
          assert.ok(!/\$0\.00 available/.test(answer.content),
            `a live unit pot is not $0.00:\n${answer.content}`);
          assert.match(answer.content, /events? available|events? \(/,
            `the pot is stated in its own unit:\n${answer.content}`);
        },
      }),
    },
  ];

  for (const scoped of cases) {
    test(`"${scoped.question}"`, async () => {
      const answer = await ask(scoped.question);
      const ledger = answer.analysis.qualifiers as {
        kind: string; text: string; state: string; detail: string | null;
      }[];

      // 1. The question's qualifiers reached the ledger at all.
      for (const kind of scoped.names) {
        assert.ok(ledger.some((entry) => entry.kind === kind),
          `no ${kind} qualifier was parsed out of "${scoped.question}"; ledger held ${JSON.stringify(ledger)}`);
      }

      // 2. The invariant. There is no fourth state, and `pending` is the
      //    silent drop this whole mechanism exists to make impossible.
      const pending = ledger.filter((entry) => entry.state === 'pending');
      assert.equal(pending.length, 0,
        `${pending.map((entry) => `${entry.kind} "${entry.text}"`).join(', ')} reached the answer unsettled:\n${answer.content}`);
      for (const entry of ledger) {
        assert.ok(['bound', 'refused', 'waived'].includes(entry.state), `unknown qualifier state ${entry.state}`);
        if (entry.state === 'waived') {
          assert.ok(entry.detail, `${entry.kind} "${entry.text}" was waived with no reason given`);
        }
      }

      // 3. Either the answer the database says, or a refusal. Never a third
      //    thing that reads like the first.
      const expectation = scoped.expect();
      const refused = !!answer.analysis.refusal;
      if (expectation.refuseOnly) {
        assert.ok(refused, `"${scoped.question}" has no honest answer and must be refused:\n${answer.content}`);
        assert.ok(ledger.some((entry) => entry.state === 'refused'),
          `the refusal has to come from a qualifier this run could not bind:\n${JSON.stringify(ledger)}`);
        return;
      }
      if (refused) return;

      // 4. A qualifier the answer ignored is named in the answer's own words,
      //    in the first sentence — never in a footnote and never nowhere.
      for (const entry of ledger.filter((row) => row.state === 'waived')) {
        assert.ok(answer.content.includes(entry.text),
          `"${entry.text}" was waived and the answer never says so:\n${answer.content}`);
      }
      for (const fragment of expectation.must ?? []) {
        assert.ok(answer.content.includes(fragment),
          `"${fragment}" is the figure the database holds and the answer does not state it:\n${answer.content}`);
      }
      for (const fragment of expectation.mustNot ?? []) {
        assert.ok(!answer.content.includes(fragment),
          `"${fragment}" is the unscoped answer to a scoped question:\n${answer.content}`);
      }
      expectation.also?.(answer);
    });
  }

  test('a qualifier the plan claims but does not carry is caught, not trusted', () => {
    // The ledger does not take the planner's word for a binding. A branch that
    // says "the owner is on this step" and passes no `owner_id` is the exact
    // failure this replaces, and it has to be loud rather than plausible.
    const ledger = new QualifierLedger([
      {
        kind: 'owner', text: 'Marcus Ilori', state: 'bound', detail: null,
        resolved: { kind: 'owner', value: 'usr_seed02', label: 'Marcus Ilori' },
        binding: { tool: 'record_aggregate', args: { owner_id: 'usr_seed02' } },
      },
    ]);
    const honest = ledger.verify([{ tool: 'record_aggregate', args: { owner_id: 'usr_seed02', object_type: 'deal' } }]);
    assert.equal(honest.length, 0, 'a binding the step really carries is not a violation');

    const lying = ledger.verify([{ tool: 'record_aggregate', args: { object_type: 'deal' } }]);
    assert.deepEqual(lying.map((v) => v.reason), ['argument_missing']);

    const absent = ledger.verify([{ tool: 'business_metric', args: { metric: 'pipeline' } }]);
    assert.deepEqual(absent.map((v) => v.reason), ['step_missing']);
  });

  test('a qualifier of the wrong type never binds a slot', () => {
    // "Marcus Ilori" is an owner. A company that resolved from the same words
    // is not a weaker owner — it is a different question.
    const ledger = new QualifierLedger([
      {
        kind: 'owner', text: 'Marcus Ilori', state: 'bound', detail: null,
        resolved: { kind: 'account', value: 'cmp_nw_09', label: 'Whitcombe Aerospace' },
        binding: { tool: 'account_profile', args: { id: 'cmp_nw_09' } },
      },
    ]);
    const violations = ledger.verify([{ tool: 'account_profile', args: { id: 'cmp_nw_09' } }]);
    assert.deepEqual(violations.map((v) => v.reason), ['type_mismatch']);
  });

  test('an unsettled qualifier is a violation even when everything else went right', () => {
    const ledger = new QualifierLedger([
      {
        kind: 'stage', text: 'Negotiation', state: 'pending', detail: null,
        resolved: { kind: 'stage', value: 'negotiation', label: 'Negotiation', property: 'deal_stage' },
        binding: null,
      },
    ]);
    assert.deepEqual(ledger.verify([{ tool: 'business_metric', args: { metric: 'deal_count' } }]).map((v) => v.reason),
      ['unsettled']);
    ledger.settleAgainst([{ tool: 'business_metric', args: { metric: 'deal_count', stage: 'negotiation' } }]);
    assert.equal(ledger.verify([{ tool: 'business_metric', args: { metric: 'deal_count', stage: 'negotiation' } }]).length, 0);
    assert.equal(ledger.first('stage')!.state, 'bound');
  });
});

/* ---------------- structured extraction binds to one record --------------- */

describe('an extraction is a record that exists, or it is nulls', () => {
  test('an array schema returns the rows the run found, not one all-null object', async () => {
    const answer = await ask('Which deals are in Proposal sent?', {
      response_schema: { type: 'array', items: { type: 'object', fields: { name: { type: 'string' }, amount: { type: 'number' } } } },
    });
    const rows = JSON.parse(answer.content) as { name: string | null; amount: number | null }[];
    assert.ok(rows.length >= 1, `an array schema returned nothing:\n${answer.content}`);
    assert.ok(!(rows.length === 1 && rows[0].name === null && rows[0].amount === null),
      `one all-null row is a shape, not an answer:\n${answer.content}`);
    for (const row of rows) {
      assert.ok(row.name, `every row names its record:\n${answer.content}`);
      const held = app.ctx.db.pluck<number>(
        `SELECT json_extract(properties, '$.amount') FROM crm_records
         WHERE org_id = ? AND object_type = 'deal' AND display_name = ?`, ORG, row.name);
      assert.equal(row.amount, held, `${row.name}'s amount is the row's own`);
    }
  });

  test('every field of one object comes from one row', async () => {
    const answer = await ask('Where does Meridian Forge Systems stand?', {
      response_schema: {
        type: 'object',
        fields: {
          deal_name: { type: 'string' }, amount: { type: 'number' },
          stage: { type: 'string' }, owner: { type: 'string' },
        },
      },
    });
    const extracted = JSON.parse(answer.content) as { deal_name: string | null; amount: number | null; owner: string | null };
    if (!extracted.deal_name) return;
    const row = app.ctx.db.get<{ amount: number; owner_id: string }>(
      `SELECT json_extract(properties, '$.amount') AS amount, owner_id FROM crm_records
       WHERE org_id = ? AND object_type = 'deal' AND display_name = ?`, ORG, extracted.deal_name)!;
    assert.equal(extracted.amount, row.amount, 'the amount belongs to the deal that was named');
    const ownerName = app.ctx.db.pluck<string>(`SELECT name FROM users WHERE id = ?`, row.owner_id);
    assert.equal(extracted.owner, ownerName,
      'the owner is that deal’s owner, not the account’s — one object, one row');
  });

  test('a field named after the metric the run computed is filled with it', async () => {
    for (const [prompt, field] of [['What is our MRR in USD?', 'mrr'], ['What is our open pipeline?', 'open_pipeline']] as const) {
      const answer = await ask(prompt, { response_schema: { type: 'object', fields: { [field]: { type: 'number' } } } });
      const extracted = JSON.parse(answer.content) as Record<string, number | null>;
      assert.ok(extracted[field] !== null && Number.isFinite(extracted[field]),
        `"${prompt}" left \`${field}\` null while the engine held the figure:\n${answer.content}\n${answer.reasoning?.join('\n')}`);
    }
  });

  test('a metric measured in three books fills no single-number field, and says so', async () => {
    // The other half of the same rule: `mrr` is filled when there is one
    // figure, and left null when there are three. Filling it with the largest
    // book under-reported recurring revenue by a third and flagged nothing.
    const answer = await ask('What is our MRR?', {
      response_schema: { type: 'object', fields: { mrr: { type: 'number' } } },
    });
    assert.equal((JSON.parse(answer.content) as { mrr: number | null }).mrr, null);
    assert.ok((answer.reasoning as string[]).some((line) => /left mrr null rather than guessing/.test(line)),
      `the caller is told which field was left null and why:\n${(answer.reasoning as string[]).join('\n')}`);
  });
});

/* -------------- a draft cites a record, or it cites nothing --------------- */

describe('a draft never asserts a record that does not exist', () => {
  /** An account with no unpaid invoice — the case that used to be invented. */
  const accountWithNothingDue = (): string | null => {
    for (const row of app.ctx.db.all<{ id: string; name: string }>(
      `SELECT id, display_name AS name FROM crm_records WHERE org_id = ? AND object_type = 'company' AND archived = 0`, ORG)) {
      const customer = app.ctx.svc.billing.customerByCrmRecord(ORG, row.id);
      if (!customer) return row.id;
      const open = app.ctx.svc.billing.invoices(ORG, { customer: customer.id, status: 'open_like', limit: 5 })
        .filter((invoice) => invoice.amount_due > 0);
      if (!open.length) return row.id;
    }
    return null;
  };

  test('a dunning note for an account with nothing outstanding says so instead of inventing a bill', async () => {
    const id = accountWithNothingDue();
    assert.ok(id, 'the fixture has an account with no unpaid invoice');
    const draft = await expectOk('POST', '/v1/ai/draft', {
      kind: 'dunning', record_id: id, instruction: 'Chase the outstanding invoice',
    });
    assert.ok(!/an invoice on your account is still outstanding/i.test(draft.body),
      `there is no such invoice on this account:\n${draft.body}`);
    assert.match(draft.body, /no invoice|nothing to chase|no unpaid/i);
  });

  test('a dunning note with no account named refuses rather than chasing "your team"', async () => {
    const draft = await expectOk('POST', '/v1/ai/draft', {
      kind: 'dunning', instruction: 'Write a dunning letter about the overdue invoice.',
    });
    assert.ok(!/an invoice on your account is still outstanding/i.test(draft.body),
      `no account was named, so no invoice was read:\n${draft.body}`);
    assert.match(draft.body, /names no account|Name the account/i);
  });

  test('a dunning note that names its account in the instruction reads that account’s ledger', async () => {
    const meridian = app.ctx.svc.billing.customerByCrmRecord(ORG, 'cmp_nw_01')!;
    const open = app.ctx.svc.billing.invoices(ORG, { customer: meridian.id, status: 'open_like', limit: 20 })
      .filter((invoice) => invoice.amount_due > 0);
    assert.ok(open.length, 'Meridian has unpaid invoices in the fixture');
    const draft = await expectOk('POST', '/v1/ai/draft', {
      instruction: 'Write a dunning letter to Meridian Forge Systems about their overdue invoice.',
    });
    assert.ok(open.some((invoice) => draft.body.includes(invoice.number)),
      `the account was named in the instruction and its real invoice is not cited:\n${draft.body}`);
  });
});

/* ----------------- a period in the future is still a period --------------- */

describe('forward-looking periods resolve, like backward ones', () => {
  test('"the next 30 days" is a date range, not an unparseable phrase', () => {
    const now = app.ctx.now();
    const [forward] = resolveWindows('which subscriptions renew in the next 30 days', now, 3);
    assert.ok(forward, '"the next 30 days" resolved to nothing');
    assert.equal(forward.start, now);
    assert.equal(forward.end, now + 30 * 86_400_000);
    assert.equal(unresolvedPeriods('which subscriptions renew in the next 30 days', now).length, 0);
  });

  test('a forward-looking question is answered, not refused for its period', async () => {
    const answer = await ask('Which deals are closing in the next 60 days?');
    assert.notEqual(answer.analysis.refusal?.code, 'period_unresolved',
      `a forward period is as resolvable as a backward one:\n${answer.content}`);
  });
});

/* ==========================================================================
 * The qualifier invariant — one table, every qualifier type
 *
 * Two critics, on different surfaces, found the same defect: the engine parses
 * a qualifier out of the question — a pipeline, a stage, an owner, an account,
 * a period, a status, a measure, a meter, a unit, a ranking cut-off — and, when
 * it cannot bind that qualifier to the query it is about to run, runs the
 * unqualified query anyway and states the result as the answer.
 *
 * Every row below is a scoped question whose correct answer is computed here,
 * from the database, without going near the engine. The engine must return that
 * answer or refuse. Nothing else counts, and "the workspace total under the
 * reader's own scoped sentence" is asserted against by name.
 * ======================================================================== */

interface DealFact {
  id: string; name: string; owner: string | null; created: number;
  pipeline: string; stage: string; amount: number; close: number;
}

const dealFacts = (): DealFact[] => app.ctx.db.all<{
  id: string; display_name: string; owner_id: string | null; created: number; properties: string;
}>(
  `SELECT id, display_name, owner_id, created, properties FROM crm_records
   WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL`, ORG,
).map((row) => {
  const p = JSON.parse(row.properties) as Record<string, unknown>;
  return {
    id: row.id,
    name: row.display_name,
    owner: row.owner_id,
    created: row.created,
    pipeline: String(p.pipeline ?? ''),
    stage: String(p.deal_stage ?? ''),
    amount: Number(p.amount ?? 0),
    close: Number(p.close_date ?? 0),
  };
});

const sumAmount = (rows: DealFact[]): number => rows.reduce((total, row) => total + row.amount, 0);
const openFacts = (): DealFact[] => {
  const open = stageSets(app.ctx, ORG).open;
  return dealFacts().filter((row) => open.includes(row.stage));
};
const personId = (name: string): string =>
  app.ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE name = ?`, name)!.id;

const OPEN_TICKET = ['new', 'waiting_on_us', 'waiting_on_customer', 'escalated'];
const openTicketsOwnedBy = (name: string): number => app.ctx.db.all<{ owner_id: string | null; properties: string }>(
  `SELECT owner_id, properties FROM crm_records WHERE org_id = ? AND object_type = 'ticket' AND archived = 0`, ORG,
).filter((row) => row.owner_id === personId(name)
  && OPEN_TICKET.includes(String((JSON.parse(row.properties) as { status?: unknown }).status ?? ''))).length;

/** The live, unit-denominated credit an account can actually spend, from the grants. */
const unitCreditLeft = (companyId: string): { units: number; unit: string } | null => {
  const customer = app.ctx.svc.billing.customerByCrmRecord(ORG, companyId);
  if (!customer) return null;
  const now = app.ctx.now();
  const grants = app.ctx.db.all<{ id: string; unit_label: string | null; amount_micro: number; effective_at: number; expires_at: number | null }>(
    `SELECT id, unit_label, amount_micro, effective_at, expires_at FROM credit_grants
     WHERE org_id = ? AND customer_id = ? AND kind = 'unit'`, ORG, customer.id);
  let micro = 0;
  let unit = '';
  for (const grant of grants) {
    if (grant.effective_at > now || (grant.expires_at !== null && grant.expires_at <= now)) continue;
    const last = app.ctx.db.get<{ balance_after_micro: number }>(
      `SELECT balance_after_micro FROM credit_ledger WHERE org_id = ? AND grant_id = ? ORDER BY seq DESC LIMIT 1`, ORG, grant.id);
    micro += last ? last.balance_after_micro : grant.amount_micro;
    unit = grant.unit_label ?? unit;
  }
  return { units: micro / 1_000_000, unit };
};

interface QualifierCase {
  /** Which qualifier type this row pins down. */
  kind: string;
  q: string;
  /** Substrings the answer must contain, computed from the database. */
  must?: () => (string | RegExp)[];
  /** The answer to a question nobody asked — must appear nowhere. */
  never?: () => (string | RegExp)[];
  /** Or: the engine must refuse, and the refusal must read like this. */
  refuse?: RegExp;
}

const workspaceOpen = () => money(sumAmount(openFacts()));

const QUALIFIER_CASES: QualifierCase[] = [
  /* --- pipeline ------------------------------------------------------- */
  {
    kind: 'pipeline (bound)',
    q: 'What is the Renewal pipeline worth?',
    must: () => {
      const rows = openFacts().filter((d) => d.pipeline === 'renewal');
      return [money(sumAmount(rows)), String(rows.length)];
    },
    never: () => [workspaceOpen()],
  },
  {
    kind: 'pipeline (named without the word)',
    q: 'How many deals are in Expansion?',
    must: () => [String(openFacts().filter((d) => d.pipeline === 'expansion').length)],
    never: () => [String(openFacts().length)],
  },
  {
    kind: 'pipeline (prepositional)',
    q: 'How much is the pipeline for new business worth?',
    must: () => [money(sumAmount(openFacts().filter((d) => d.pipeline === 'new_business')))],
    never: () => [workspaceOpen()],
  },
  {
    kind: 'pipeline (no such pipeline)',
    q: 'What is the Partner pipeline worth?',
    refuse: /No deal pipeline in this workspace is called "Partner"/,
    never: () => [workspaceOpen()],
  },
  /* --- metric --------------------------------------------------------- */
  {
    kind: 'metric (not a near neighbour)',
    q: 'What is our weighted pipeline?',
    must: () => [/weighted/i],
    never: () => [workspaceOpen()],
  },
  {
    kind: 'metric (not in the catalogue)',
    q: 'What is our pipeline coverage?',
    refuse: /not a measure this platform defines/,
    never: () => [workspaceOpen()],
  },
  {
    kind: 'metric (a pipeline scope does not become the measure)',
    q: 'How much did we book in the New business pipeline in Q2 2026?',
    must: () => {
      const q2 = { start: Date.UTC(2026, 3, 1), end: Date.UTC(2026, 6, 1) };
      const won = stageSets(app.ctx, ORG).won;
      const rows = dealFacts().filter((d) => won.includes(d.stage) && d.pipeline === 'new_business'
        && d.close >= q2.start && d.close < q2.end);
      return [money(sumAmount(rows))];
    },
    never: () => [money(sumAmount(openFacts().filter((d) => d.pipeline === 'new_business'))), workspaceOpen()],
  },
  /* --- stage ---------------------------------------------------------- */
  {
    kind: 'stage (bound)',
    q: 'How many deals are in Negotiation?',
    must: () => [String(openFacts().filter((d) => d.stage === 'negotiation').length)],
    never: () => [String(openFacts().length)],
  },
  {
    kind: 'stage (a real stage is never denied)',
    q: 'Which deals are in the Technical validation stage?',
    must: () => [String(openFacts().filter((d) => d.stage === 'technical_validation').length)],
    never: () => [/do not hold anything called/i, /no deal stage in this workspace is called/i],
  },
  {
    kind: 'stage (a real stage is never denied)',
    q: 'Which deals are in the Proposal sent stage?',
    must: () => [String(openFacts().filter((d) => d.stage === 'proposal').length)],
    never: () => [/no deal stage in this workspace is called/i],
  },
  {
    kind: 'stage (no such stage)',
    q: 'How many deals are in the Contract review stage?',
    refuse: /No deal stage in this workspace is called "Contract review"/,
    never: () => [String(openFacts().length)],
  },
  /* --- owner ---------------------------------------------------------- */
  {
    kind: 'owner (bound)',
    q: 'How much pipeline does Marcus Ilori own?',
    must: () => {
      const rows = openFacts().filter((d) => d.owner === personId('Marcus Ilori'));
      return [money(sumAmount(rows)), String(rows.length)];
    },
    never: () => [workspaceOpen()],
  },
  {
    kind: 'owner (a first name a contact also carries)',
    q: 'How much pipeline does Marcus own?',
    must: () => [money(sumAmount(openFacts().filter((d) => d.owner === personId('Marcus Ilori'))))],
    never: () => [/Whitcombe Aerospace/, workspaceOpen()],
  },
  {
    kind: 'owner (one name, two kinds of record, is a question back)',
    q: 'How many deals does Marcus have?',
    refuse: /Marcus Ilori \(a teammate\) and Marcus Barnes \(an account\)/,
    never: () => [/Whitcombe Aerospace/],
  },
  {
    kind: 'owner (no such teammate)',
    q: 'How much pipeline does Jordan Fairweather own?',
    refuse: /No teammate in this workspace is called "Jordan Fairweather"/,
    never: () => [workspaceOpen()],
  },
  {
    kind: 'owner (no such teammate, list form)',
    q: 'List the open deals owned by Fiona Blackwood',
    refuse: /Fiona Blackwood/,
    never: () => [String(openFacts().length)],
  },
  {
    kind: 'owner (no such teammate, stage-scoped)',
    q: 'How many deals does Fiona Blackwood have in the Negotiation stage?',
    refuse: /Fiona Blackwood/,
    never: () => [String(openFacts().filter((d) => d.stage === 'negotiation').length)],
  },
  {
    kind: 'owner (tickets nobody owns is zero, not a refusal)',
    q: 'How many open tickets does Nina Kowalski have?',
    must: () => [String(openTicketsOwnedBy('Nina Kowalski'))],
    never: () => [/could not/i],
  },
  /* --- account -------------------------------------------------------- */
  {
    kind: 'account (bound)',
    q: 'What is Meridian Forge Systems carrying in open pipeline?',
    must: () => [money(sumAmount(openFacts().filter((d) => d.name.startsWith('Meridian Forge Systems'))))],
    never: () => [workspaceOpen()],
  },
  {
    kind: 'account (a near miss is offered, never substituted)',
    q: 'What is Bayside Logistics carrying in open pipeline?',
    refuse: /Bayside Logistics/,
    never: () => [workspaceOpen()],
  },
  {
    kind: 'account (no such account)',
    q: 'What is Zorblax Industries carrying in open pipeline?',
    refuse: /No company, contact or customer in this workspace is called "Zorblax Industries"/,
    never: () => [workspaceOpen()],
  },
  {
    kind: 'account (no such account, revenue)',
    q: 'How much revenue did Zorblax Industries generate in 2025?',
    refuse: /Zorblax Industries/,
  },
  {
    kind: 'account (a typo-tolerant match names the substitution first)',
    q: 'How many open tickets for nortgate chemical?',
    must: () => [/^You wrote "nortgate chemical"; the closest account this workspace holds is Northgate Chemical Works/],
  },
  /* --- period --------------------------------------------------------- */
  {
    kind: 'period (the column the question named)',
    q: 'Which deals were created last month?',
    must: () => {
      const from = Date.UTC(2026, 7, 1);
      const to = Date.UTC(2026, 8, 1);
      const created = dealFacts().filter((d) => d.created >= from && d.created < to);
      return created.length ? [String(created.length)] : [/^No deals were created in Aug 2026\./m];
    },
    never: () => dealFacts()
      .filter((d) => d.close >= Date.UTC(2026, 7, 1) && d.close < Date.UTC(2026, 8, 1))
      .map((d) => d.name),
  },
  {
    kind: 'period (forward-looking, on a snapshot measure)',
    q: 'How much pipeline is closing in the next 30 days?',
    must: () => {
      const now = app.ctx.now();
      const rows = openFacts().filter((d) => d.close >= now && d.close < now + 30 * 86_400_000);
      return [money(sumAmount(rows)), String(rows.length)];
    },
    never: () => [workspaceOpen(), /cannot be applied to it/i],
  },
  {
    kind: 'period (a month is the month, not a neighbouring year)',
    q: 'What did we invoice in August 2026?',
    must: () => [/August 2026/],
  },
  /* --- status --------------------------------------------------------- */
  {
    kind: 'status (won, scoped to a rep and a period)',
    q: 'How many deals did Dana Whitfield win in Q2 2026?',
    must: () => {
      const won = stageSets(app.ctx, ORG).won;
      const rows = dealFacts().filter((d) => won.includes(d.stage) && d.owner === personId('Dana Whitfield')
        && d.close >= Date.UTC(2026, 3, 1) && d.close < Date.UTC(2026, 6, 1));
      return [String(rows.length)];
    },
    never: () => [/could not apply/i],
  },
  {
    kind: 'status (lost, scoped to a pipeline, matching nothing)',
    q: 'Which deals did we lose in the Expansion pipeline?',
    must: () => [/No closed-lost deals in the Expansion pipeline/],
    never: () => [/A plant Northwind has never instrumented/],
  },
  {
    kind: 'status (lost, over a period)',
    q: 'Which deals did we lose last quarter?',
    must: () => {
      const lost = stageSets(app.ctx, ORG).lost;
      const rows = dealFacts().filter((d) => lost.includes(d.stage)
        && d.close >= Date.UTC(2026, 3, 1) && d.close < Date.UTC(2026, 6, 1));
      return [String(rows.length), ...rows.slice(0, 1).map((d) => d.name)];
    },
    never: () => [`${openFacts().length} open deals`],
  },
  {
    kind: 'status (a win rate scoped to a pipeline with nothing decided in it)',
    q: 'What is our win rate in the Expansion pipeline?',
    must: () => ['no win rate in the Expansion pipeline', /no rate to report/],
    never: () => [/66\.7%/, /the honest answer is zero/],
  },
  /* --- unit and meter -------------------------------------------------- */
  {
    kind: 'unit (a balance question is not a consumption question)',
    q: 'How many telemetry events does Meridian Forge Systems have left?',
    must: () => {
      const left = unitCreditLeft('cmp_nw_01')!;
      return [left.units.toLocaleString('en-US', { maximumFractionDigits: 2 }), /events/];
    },
    never: () => [/metered [\d,]{9,}/, /\$0\.00/],
  },
  {
    kind: 'unit (an empty pot is still denominated in the unit)',
    q: "What is Ironwood Packaging Group's remaining event credit?",
    must: () => [/no spendable credit|nothing left|spent, expired/i],
    never: () => [/Nothing this run measured is denominated in events/],
  },
  {
    kind: 'unit (a unit balance is never rendered as money)',
    q: 'What credit does Meridian Forge Systems have left?',
    must: () => {
      const left = unitCreditLeft('cmp_nw_01')!;
      return [left.units.toLocaleString('en-US', { maximumFractionDigits: 2 }), /events/];
    },
    never: () => [/\$0\.00/],
  },
  {
    kind: 'unit (a unit grant is not a money grant)',
    q: 'What credit grants does Meridian Forge Systems have?',
    must: () => [/6,000,000 events/],
    never: () => [/\$60,000\.00/],
  },
  /* --- meter ------------------------------------------------------------ */
  {
    kind: 'meter (a consumption question stays on the meter it names)',
    q: 'How many telemetry events did Meridian Forge Systems meter in Q3 2026?',
    must: () => {
      const q3 = { start: Date.UTC(2026, 6, 1), end: Date.UTC(2026, 9, 1) };
      const meter = app.ctx.db.get<{ id: string }>(
        `SELECT id FROM meters WHERE org_id = ? AND name = 'Telemetry events'`, ORG)!;
      const customer = app.ctx.svc.billing.customerByCrmRecord(ORG, 'cmp_nw_01')!;
      const HOUR = 3_600_000;
      const total = app.ctx.db.get<{ micro: number }>(
        `SELECT COALESCE(SUM(sum_micro), 0) AS micro FROM meter_event_summaries
         WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND hour_start >= ? AND hour_start < ?`,
        ORG, meter.id, customer.id, Math.floor(q3.start / HOUR) * HOUR, Math.ceil(q3.end / HOUR) * HOUR)!;
      return [Math.round(total.micro / 1_000_000).toLocaleString('en-US'), 'Telemetry events'];
    },
    // The pot is a different quantity from the consumption, and neither may
    // stand in for the other.
    never: () => ['9,131.22'],
  },
  /* --- ranking cut-off -------------------------------------------------- */
  {
    kind: 'limit (written before the noun)',
    q: 'Show me the 3 largest open deals owned by Marcus Ilori',
    must: () => {
      const rows = openFacts().filter((d) => d.owner === personId('Marcus Ilori'))
        .sort((a, b) => b.amount - a.amount).slice(0, 3);
      return rows.map((d) => d.name);
    },
    never: () => openFacts().filter((d) => d.owner === personId('Marcus Ilori'))
      .sort((a, b) => b.amount - a.amount).slice(3).map((d) => d.name),
  },
  /* --- how a bound qualifier reads back --------------------------------- */
  {
    kind: 'stage (read back in the workspace\'s own words)',
    q: 'How many deals does Priya Raman have in the Negotiation stage?',
    must: () => {
      const rows = openFacts().filter((d) => d.owner === personId('Priya Raman') && d.stage === 'negotiation');
      return [String(rows.length), 'at the Negotiation stage'];
    },
    never: () => ['deal stage Negotiation'],
  },
  {
    kind: 'pipeline (read back in the workspace\'s own words)',
    q: 'What is the Renewal pipeline worth for Priya Raman?',
    must: () => {
      const rows = openFacts().filter((d) => d.owner === personId('Priya Raman') && d.pipeline === 'renewal');
      return [money(sumAmount(rows)), 'in the Renewal pipeline'];
    },
    never: () => ['pipeline Renewal', workspaceOpen()],
  },
  /* --- currency --------------------------------------------------------- */
  {
    kind: 'currency (one book, named)',
    q: 'How much revenue did we book in EUR in 2025?',
    must: () => [/€/, /EUR/],
    never: () => [/^\$/m],
  },
  /* --- stage: a name only one pipeline uses ------------------------------ */
  {
    // `discovery` is "Discovery" in New business and "Scoping" in Expansion.
    // Keeping one label per stage value threw the other away, so this question
    // resolved no stage at all and answered with the whole open book — 38
    // deals — with nothing in the run naming the word the reader typed.
    kind: 'stage (a label only one pipeline uses)',
    q: 'How many deals are in Scoping?',
    must: () => [countOf(stageValueOf('Scoping'), pipelineOf('Scoping')), /Scoping/],
    never: () => [new RegExp(`\\b${openFacts().length} (?:open )?deals\\b`), /Discovery/],
  },
  {
    kind: 'stage (a label only one pipeline uses, written with the word)',
    q: 'How many deals are in the Scoping stage?',
    must: () => [countOf(stageValueOf('Scoping'), pipelineOf('Scoping')), /Scoping/],
    never: () => [new RegExp(`\\b${openFacts().length} (?:open )?deals\\b`)],
  },
  {
    // "Churned" is the Renewal pipeline's name for `closed_lost`. Answering it
    // with the stage value alone reports every closed-lost deal in all three
    // pipelines — a bigger number about a wider question.
    kind: 'stage (a pipeline-specific label narrows the pipeline too)',
    q: 'Which deals are in the Churned stage?',
    must: () => [/Renewal/],
    never: () => [String(dealFacts().filter((d) => d.stage === stageValueOf('Churned')).length)],
  },
  {
    // The stored name is every pipeline's, so it narrows nothing — and it is
    // the name the answer must read back. "6 deals at the Expansion identified
    // stage" describes two of the six.
    kind: 'stage (the stored name stays general, and is read back as written)',
    q: 'How many deals are in the Qualification stage?',
    must: () => [countOf('qualification', null), /Qualification stage/],
    never: () => [/Expansion identified/],
  },
  {
    // "Scoping" is Expansion's name for `discovery`; New business calls it
    // "Discovery". Translating the reader's word into the other pipeline's and
    // answering under it reported four deals at a stage that book has not got.
    kind: 'stage (a name the named pipeline does not use is a refusal)',
    q: 'What is the New business pipeline worth at the Scoping stage?',
    refuse: /New business pipeline has no stage called "Scoping"/,
    never: () => [money(sumAmount(openFacts().filter((d) => d.pipeline === 'new_business' && d.stage === 'discovery')))],
  },
  {
    kind: 'stage (a list reads its stage back in the scoped pipeline\'s words)',
    q: 'Which deals are in Scoping in the Expansion pipeline?',
    must: () => [countOf(stageValueOf('Scoping'), 'expansion'), /Scoping stage/],
    never: () => [/at the Discovery stage/],
  },
  /* --- status on a record that is not a deal ----------------------------- */
  {
    // `business_metric` counts the workspace's ticket intake over a window and
    // takes no status. The word the reader wrote reached nothing, and the
    // quarter's intake was stated as the answer.
    kind: 'status (a ticket status the workspace defines)',
    q: 'How many tickets are escalated?',
    must: () => [new RegExp(`\\b${ticketsWithStatus('escalated')} tickets?\\b`), /Escalated/],
    never: () => [new RegExp(`\\b${ticketsRaisedThisPeriod()} tickets\\b`)],
  },
  {
    // A status this workspace spells in three words. Falling through to the
    // general open-ticket set answers a wider question than the one asked.
    kind: 'status (a multi-word ticket status is that status, not "open")',
    q: 'How many tickets are waiting on us?',
    must: () => [new RegExp(`\\b${ticketsWithStatus('waiting_on_us')} ticket\\b`), /Waiting on us/],
    never: () => [new RegExp(`\\b${openTickets()} (?:open )?tickets\\b`)],
  },
  {
    // "are decision" is a 47% trigram on "Ardennes Précision". The words that
    // named a buying role this workspace defines are not the name of a company,
    // and the answer used to be one account's single economic buyer.
    kind: 'status (a role the workspace defines is never an account)',
    q: 'How many contacts are decision makers?',
    must: () => [new RegExp(`\\b${contactsWithRole('economic_buyer')} contacts\\b`), /Economic buyer/],
    never: () => [/Ardennes/, /Précision/],
  },
  /* --- ranking: which end of the book the reader asked for -------------- */
  {
    // "The largest of the 12 deals still open: Pemberton — $582,120" was the
    // answer to this, 15.8x the real one with the adjective inverted.
    kind: 'ranking (smallest, scoped to an owner)',
    q: 'What is the smallest open deal owned by Dana Whitfield?',
    must: () => {
      const mine = byAmount(openFacts().filter((d) => d.owner === personId('Dana Whitfield')));
      return [mine[0].name, money(mine[0].amount)];
    },
    never: () => {
      const mine = byAmount(openFacts().filter((d) => d.owner === personId('Dana Whitfield')));
      return [money(mine[mine.length - 1].amount), /\blargest\b/i];
    },
  },
  {
    kind: 'ranking (a cut-off taken from the bottom)',
    q: 'Show me the 3 smallest open deals',
    must: () => byAmount(openFacts()).slice(0, 3).map((d) => d.name),
    never: () => [byAmount(openFacts()).slice(-1)[0].name, /\blargest\b/i],
  },
  {
    kind: 'ranking ("bottom N" is the same instruction)',
    q: 'Show me the bottom 3 open deals by amount',
    must: () => [/\b3 smallest\b/, ...byAmount(openFacts()).slice(0, 3).map((d) => d.name)],
    never: () => [/8 largest/, byAmount(openFacts()).slice(-1)[0].name],
  },
  {
    // A date order is a different sort key as well as a different direction:
    // this came back as the eight largest deals by amount.
    kind: 'ranking (soonest to close is a date order)',
    q: 'Show me the 3 open deals closing soonest',
    must: () => [...openFacts()].sort((a, b) => a.close - b.close).slice(0, 3).map((d) => d.name),
    never: () => [byAmount(openFacts()).slice(-1)[0].name],
  },
  {
    // Byte-identical to the answer for "who has the most pipeline?" — the same
    // rows, the same order, the same name on top.
    kind: 'ranking (the least of a per-owner measure)',
    q: 'Who has the least pipeline?',
    must: () => {
      const least = ownerPipeline()[0];
      return [new RegExp(`^${least.name} has the least`, 'm'), money(least.total), `1. ${least.name}`];
    },
    never: () => {
      const ranked = ownerPipeline();
      return [`${ranked[ranked.length - 1].name} is the biggest`, `1. ${ranked[ranked.length - 1].name}`];
    },
  },
  {
    kind: 'limit (a bare numeral in front of the noun)',
    q: 'Show me 3 open deals',
    must: () => [/\b3 largest\b/],
    never: () => [/\b8 largest\b/],
  },
  /* --- one scope, every step of the plan -------------------------------- */
  {
    // The metric was scoped and the deal list under it was not: four of the
    // five rows printed beneath this sentence were in other pipelines, and the
    // top one was bigger than anything the named pipeline holds.
    kind: 'pipeline (a summary is scoped in every step)',
    q: 'Summarise the Renewal pipeline',
    must: () => {
      const rows = byAmount(openFacts().filter((d) => d.pipeline === 'renewal'));
      return [money(sumAmount(rows)), String(rows.length), rows[rows.length - 1].name];
    },
    never: () => byAmount(openFacts().filter((d) => d.pipeline !== 'renewal')).slice(-4).map((d) => d.name),
  },
  {
    kind: 'pipeline (an overview is scoped in every step)',
    q: 'Give me an overview of the Renewal pipeline',
    must: () => [money(sumAmount(openFacts().filter((d) => d.pipeline === 'renewal')))],
    never: () => byAmount(openFacts().filter((d) => d.pipeline !== 'renewal')).slice(-4).map((d) => d.name),
  },
  {
    kind: 'stage (a summary is scoped in every step)',
    q: 'Summarise the pipeline at the Negotiation stage',
    must: () => {
      const rows = byAmount(openFacts().filter((d) => d.stage === 'negotiation'));
      return [money(sumAmount(rows)), String(rows.length)];
    },
    never: () => byAmount(openFacts().filter((d) => d.stage !== 'negotiation')).slice(-4).map((d) => d.name),
  },
  {
    kind: 'ranking (a scoped list restates its scope)',
    q: 'Show me the 5 largest open deals in the Renewal pipeline',
    must: () => [/in the Renewal pipeline/, String(openFacts().filter((d) => d.pipeline === 'renewal').length)],
    never: () => [`${openFacts().length} deals still open`, `${openFacts().length} open deals.`],
  },
  {
    // 77 is every deal on the book, 39 of them closed. The sentence over an
    // unfiltered search said "still open".
    kind: 'status (an unfiltered list never claims the rows are open)',
    q: 'What is the biggest deal?',
    must: () => [byAmount(dealFacts()).slice(-1)[0].name],
    never: () => [/deals still open/],
  },
  /* --- two of a kind: bound, or refused by name ------------------------- */
  {
    kind: 'account (a second account is refused, never dropped)',
    q: 'How much did Meridian Forge Systems and Ironwood Packaging Group spend in Q2 2026?',
    refuse: /scope one answer to a single account/,
    // A refusal that quotes a figure is half an answer, and the half it quotes
    // is one of the two accounts — 48% of what was asked for.
    never: () => [/\$[\d,]+/],
  },
  {
    kind: 'stage (a second stage is refused, never dropped)',
    q: 'How many deals are in Negotiation and Proposal sent?',
    refuse: /scope one answer to a single deal stage/,
    never: () => {
      const open = openFacts();
      return [
        `${open.filter((d) => d.stage === 'proposal').length} deals right now`,
        `${open.filter((d) => d.stage === 'negotiation').length} deals right now`,
      ];
    },
  },
  {
    kind: 'pipeline (a second pipeline is refused, never dropped)',
    q: 'What is the Renewal pipeline worth in the Expansion pipeline?',
    refuse: /scope one answer to a single pipeline/,
    never: () => [money(sumAmount(openFacts().filter((d) => d.pipeline === 'expansion')))],
  },
  {
    kind: 'owner (a second owner is refused, never dropped)',
    q: 'How much pipeline does Marcus Ilori own that Priya Raman owns?',
    refuse: /scope one answer to a single (teammate|owner)/,
    never: () => [money(sumAmount(openFacts().filter((d) => d.owner === personId('Marcus Ilori'))))],
  },
  /* --- an owner and an outcome in one list ------------------------------ */
  {
    // The count form of this question answered correctly all along; the list
    // form was refused with 'I could not apply the status "lose"'.
    kind: 'status (a list scoped to an owner and an outcome)',
    q: 'Which deals did Marcus Ilori lose last quarter?',
    must: () => {
      const lost = stageSets(app.ctx, ORG).lost;
      const rows = dealFacts().filter((d) => lost.includes(d.stage) && d.owner === personId('Marcus Ilori')
        && d.close >= Date.UTC(2026, 3, 1) && d.close < Date.UTC(2026, 6, 1));
      return [String(rows.length), ...rows.map((d) => d.name)];
    },
    never: () => [`${openFacts().length} open deals`],
  },
  {
    kind: 'status (the win side of the same list)',
    q: 'Which deals did Marcus Ilori win last quarter?',
    must: () => {
      const won = stageSets(app.ctx, ORG).won;
      const rows = dealFacts().filter((d) => won.includes(d.stage) && d.owner === personId('Marcus Ilori')
        && d.close >= Date.UTC(2026, 3, 1) && d.close < Date.UTC(2026, 6, 1));
      return [String(rows.length), ...rows.map((d) => d.name)];
    },
    never: () => [`${openFacts().length} open deals`],
  },
  /* --- vocabulary this workspace does not have -------------------------- */
  {
    // The meter catalogue was served instead, with the word "widgets" nowhere
    // in the answer and nothing saying it had not been understood.
    kind: 'meter (a quantity nothing here meters)',
    q: 'How many widgets did Meridian Forge Systems meter in August 2026?',
    refuse: /meters widgets/i,
    never: () => [/\d{3},\d{3}/],
  },
  {
    kind: 'meter (the same, workspace-wide)',
    q: 'How many sprockets did we meter in August 2026?',
    refuse: /meters sprockets/i,
    never: () => [/\d{3},\d{3}/],
  },
  {
    // "$0.00 in the JPY book" reads as "we billed nothing in yen" — this
    // workspace has no yen book to bill nothing in.
    kind: 'currency (a book this workspace does not keep)',
    q: 'How much did we invoice in JPY in 2026?',
    refuse: /no JPY book/,
    never: () => [/\$0/, /¥/],
  },
  {
    // Every filter the sentence carries, not just the one the branch was
    // written for: the threshold was dropped whenever a rep was named, and the
    // same question without the name applied it exactly.
    kind: 'threshold (a filter the sentence carries beside an owner)',
    q: 'Show me open deals over $500,000 owned by Priya',
    must: () => {
      const rows = openFacts().filter((d) => d.owner === personId('Priya Raman') && d.amount > 50_000_000);
      return [String(rows.length), /more than \$500,000/, ...rows.map((d) => d.name)];
    },
    never: () => [`${openFacts().filter((d) => d.owner === personId('Priya Raman')).length} open deals owned by Priya Raman.`],
  },
  {
    kind: 'currency (a name that is also a currency word)',
    q: 'How much pipeline does Sterling own?',
    refuse: /No teammate in this workspace is called "Sterling"/,
    never: () => [/GBP/, /£/],
  },
];

/** Deals ordered smallest first — the ordering half the questions here ask for. */
const byAmount = (rows: DealFact[]): DealFact[] => [...rows].sort((a, b) => a.amount - b.amount || a.name.localeCompare(b.name));

/** Open pipeline per teammate, least first — computed from the rows, not the engine. */
function ownerPipeline(): { name: string; total: number }[] {
  const totals = new Map<string, number>();
  for (const deal of openFacts()) {
    if (!deal.owner) continue;
    totals.set(deal.owner, (totals.get(deal.owner) ?? 0) + deal.amount);
  }
  return [...totals]
    .map(([id, total]) => ({ name: app.ctx.db.pluck<string>(`SELECT name FROM users WHERE id = ?`, id) ?? id, total }))
    .sort((a, b) => a.total - b.total);
}

/* --- ground truth for the record filters a question can name -------------- */

/** Every (stage value, label, pipeline) row this workspace actually stores. */
const stageRows = (): { value: string; label: string; pipeline: string }[] =>
  app.ctx.db.all<{ name: string; label: string; pipeline: string }>(
    `SELECT name, label, pipeline FROM crm_pipeline_stages
     WHERE org_id = ? AND object_type = 'deal' ORDER BY pipeline, position`, ORG,
  ).map((row) => ({ value: row.name, label: row.label, pipeline: row.pipeline }));

const stageValueOf = (label: string): string =>
  stageRows().find((row) => row.label.toLowerCase() === label.toLowerCase())!.value;

/** The pipeline that calls a stage by that name, when only one does. */
const pipelineOf = (label: string): string | null => {
  const pipelines = [...new Set(stageRows().filter((row) => row.label.toLowerCase() === label.toLowerCase()).map((r) => r.pipeline))];
  return pipelines.length === 1 ? pipelines[0] : null;
};

/** The count of deals at a stage, in a pipeline or across all of them. */
const countOf = (stage: string, pipeline: string | null): RegExp => {
  const rows = dealFacts().filter((deal) => deal.stage === stage && (!pipeline || deal.pipeline === pipeline));
  return new RegExp(`\\b${rows.length} deals?\\b`);
};

const ticketProperties = (): Record<string, unknown>[] => app.ctx.db.all<{ properties: string }>(
  `SELECT properties FROM crm_records WHERE org_id = ? AND object_type = 'ticket' AND archived = 0`, ORG,
).map((row) => JSON.parse(row.properties) as Record<string, unknown>);

const ticketsWithStatus = (status: string): number =>
  ticketProperties().filter((row) => String(row.status ?? '') === status).length;

const openTickets = (): number =>
  ticketProperties().filter((row) => OPEN_TICKET.includes(String(row.status ?? ''))).length;

/** What `business_metric`'s ticket measure would have said instead. */
const ticketsRaisedThisPeriod = (): number => {
  const start = startOfQuarter(app.ctx.now());
  return app.ctx.db.pluck<number>(
    `SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'ticket' AND archived = 0 AND created >= ?`,
    ORG, start,
  ) ?? 0;
};

const propertyOptions = (objectType: string, property: string): { value: string; label: string }[] =>
  JSON.parse(app.ctx.db.pluck<string>(
    `SELECT options FROM crm_properties WHERE org_id = ? AND object_type = ? AND name = ?`,
    ORG, objectType, property,
  ) ?? '[]') as { value: string; label: string }[];

const contactsWithRole = (role: string): number => app.ctx.db.all<{ properties: string }>(
  `SELECT properties FROM crm_records WHERE org_id = ? AND object_type = 'contact' AND archived = 0`, ORG,
).filter((row) => String((JSON.parse(row.properties) as { buying_role?: unknown }).buying_role ?? '') === role).length;

const contains = (haystack: string, needle: string | RegExp): boolean =>
  typeof needle === 'string' ? haystack.includes(needle) : needle.test(haystack);

/**
 * There is no fourth state.
 *
 * Every qualifier the question named has to be bound, refused or explicitly
 * waived by the time an answer exists, and a `bound` entry has to name a step
 * that actually ran. A `pending` entry in a finished run is the silent drop
 * this whole mechanism exists to make impossible.
 */
function assertLedgerSettled(answer: { content: string; analysis: any }): void {
  const ran = new Set<string>([
    ...(answer.analysis.plan ?? []).map((s: { tool: string }) => s.tool),
    ...(answer.analysis.steps ?? []).map((s: { tool: string }) => s.tool),
  ]);
  for (const entry of answer.analysis.qualifiers ?? []) {
    assert.notEqual(entry.state, 'pending',
      `${entry.kind} "${entry.text}" reached the answer neither bound, refused nor waived:\n${answer.content}`);
    if (entry.state === 'waived') {
      assert.ok(entry.detail, `${entry.kind} "${entry.text}" was waived with no reason given — a silent drop wearing a different word.`);
    }
    if (entry.state === 'bound') {
      assert.ok(entry.bound_to?.tool, `${entry.kind} "${entry.text}" is bound to nothing.`);
      assert.ok(ran.has(entry.bound_to.tool),
        `${entry.kind} "${entry.text}" claims to be bound to ${entry.bound_to.tool}, which never ran.`);
    }
    if (entry.resolved) {
      assert.ok(entry.state !== 'bound' || entry.kind !== 'owner' || String(entry.resolved.value).startsWith('usr_'),
        `an owner slot resolved to ${entry.resolved.value}, which is not a teammate.`);
    }
  }
  assertScopeReachedEveryStep(answer);
}

/** The properties each record-filter qualifier narrows, as the row tools take them. */
const FILTER_PROPERTY: Record<string, string> = { pipeline: 'pipeline', stage: 'deal_stage', status: 'deal_stage' };

/**
 * A binding is a property of the plan, not of one step in it.
 *
 * Every step that returns deal rows has to be narrowed by every deal filter the
 * question bound, or the rows printed under the scoped sentence are a different
 * question's answer. "Summarise the Renewal pipeline" bound the pipeline to the
 * metric and listed the workspace's five biggest open deals underneath it —
 * four of them in other pipelines, the top one bigger than the whole Renewal
 * book's biggest deal, and every qualifier reported bound.
 *
 * This runs on every case in the table above, so a branch that adds an
 * unscoped listing to a scoped plan fails here rather than shipping.
 */
function assertScopeReachedEveryStep(answer: { content: string; analysis: any }): void {
  // The column an entry narrows comes from the entry, not from a map of kinds
  // to columns: one ledger kind covers every record filter — a ticket's
  // status, a deal's competitor, a company's industry — and a checker that
  // knows only `deal_stage` reports a correctly scoped answer as unscoped,
  // which is the same lie in the other direction.
  const columnOf = (entry: any): string | null => entry.resolved?.property ?? FILTER_PROPERTY[entry.kind] ?? null;
  // Only the kinds that narrow *which records* a step reads. A period is a
  // window and a ranking is an order; both carry a column on the entry, and
  // neither is a claim that the rows sit inside a set of values.
  const RECORD_FILTER_KINDS = new Set(['pipeline', 'stage', 'status', 'owner', 'account']);
  const bound = (answer.analysis.qualifiers ?? []).filter((entry: any) => {
    if (entry.state !== 'bound' || !entry.resolved) return false;
    if (!RECORD_FILTER_KINDS.has(entry.kind)) return false;
    // A filter on another table reaches a deal query as a set of ids, and a
    // threshold narrows without naming its members. Neither is a claim that
    // the rows the step reads sit inside a set of values.
    if ((entry.resolved.object_type ?? 'deal') !== 'deal') return false;
    if (entry.resolved.op && entry.resolved.op !== 'eq' && entry.resolved.op !== 'in') return false;
    return !!columnOf(entry);
  });
  if (!bound.length) return;
  for (const step of answer.analysis.plan ?? []) {
    if (step.tool !== 'record_search' && step.tool !== 'record_aggregate') continue;
    if (step.args.object_type !== 'deal') continue;
    const conditions: { property?: string; op?: string; value?: unknown; values?: unknown[] }[] =
      Array.isArray(step.args.conditions) ? step.args.conditions : [];
    for (const entry of bound) {
      const property = columnOf(entry)!;
      // An owner is an argument on the step, not a condition in it. A
      // comparison runs the capability once per rep, so a step narrowed to
      // *another* name the question wrote is answering the same question's
      // other half rather than a wider one.
      if (property === 'owner_id') {
        const held = String(step.args.owner_id ?? '');
        const rivals = bound.filter((other: any) => other !== entry && columnOf(other) === 'owner_id')
          .map((other: any) => String(other.resolved.value));
        if (rivals.includes(held)) continue;
        assert.equal(held, String(entry.resolved.value),
          `${step.tool} reads deal rows for ${step.args.owner_id ?? 'everybody'} under an answer scoped to ${entry.text}:
${answer.content}`);
        continue;
      }
      const held = conditions.find((c) => c.property === property);
      assert.ok(held, `${step.tool} reads deal rows with no ${property} filter, under an answer scoped to ${entry.kind} "${entry.text}":
${answer.content}`);
      const values = (Array.isArray(held.values) ? held.values : held.value === undefined ? [] : [held.value]).map(String);
      // A stage qualifier is one value; an outcome word is the set that word
      // stands for; every other record filter carries its own set. Either way
      // the rows the step reads must sit inside it.
      const allowed = new Set<string>(
        entry.resolved.values?.length ? entry.resolved.values.map(String)
          : property === 'deal_stage' && stageSets(app.ctx, ORG)[String(entry.resolved.value) as 'open' | 'won' | 'lost']
            ? stageSets(app.ctx, ORG)[String(entry.resolved.value) as 'open' | 'won' | 'lost']
            : [String(entry.resolved.value)],
      );
      assert.ok(values.length && values.every((value) => allowed.has(value)),
        `${step.tool} filters ${property} on ${JSON.stringify(values)}, which is wider than ${entry.kind} "${entry.text}":
${answer.content}`);
    }
  }
}

describe('the qualifier invariant: a scoped question is answered in its own scope or refused', () => {
  for (const scenario of QUALIFIER_CASES) {
    test(`${scenario.kind} — "${scenario.q}"`, async () => {
      const answer = await ask(scenario.q);
      assertLedgerSettled(answer);
      if (scenario.refuse) {
        assert.ok(answer.analysis.refusal,
          `"${scenario.q}" names something this workspace does not have, so it must refuse rather than answer:\n${answer.content}`);
        assert.match(answer.content, scenario.refuse);
      } else {
        assert.equal(answer.analysis.refusal, null,
          `"${scenario.q}" is answerable and was refused:\n${answer.content}`);
        for (const want of scenario.must?.() ?? []) {
          assert.ok(contains(answer.content, want),
            `"${scenario.q}" must state ${want} — the figure computed from the database:\n${answer.content}`);
        }
      }
      for (const banned of scenario.never?.() ?? []) {
        assert.ok(!contains(answer.content, banned),
          `"${scenario.q}" answered with ${banned}, which is the answer to a question nobody asked:\n${answer.content}`);
      }
    });
  }

  /**
   * Every name this workspace gives a stage is a name the engine answers to.
   *
   * Read straight off `crm_pipeline_stages`, so renaming a stage keeps this
   * honest without editing the test. One label per stage value was kept and
   * the rest thrown away, which denied "Scoping", "Churned" and "Renewed" —
   * three stages this same engine prints by name in the very sentence that
   * says it has never heard of them.
   */
  test('every stage label this workspace stores resolves to that stage', () => {
    const vocabulary = crmVocabulary(app.ctx, ORG);
    const menu = stageLabels(vocabulary);
    for (const row of stageRows()) {
      const hit = stageIn(`How many deals are in the ${row.label} stage?`, vocabulary);
      assert.ok(hit, `"${row.label}" is this workspace's name for a stage in ${row.pipeline}, and it resolved to nothing.`);
      assert.equal(hit!.term.value, row.value,
        `"${row.label}" is ${row.value} in ${row.pipeline}; it resolved to ${hit!.term.value}.`);
      assert.ok(menu.includes(row.label),
        `a refusal offers the stages this workspace has and omits "${row.label}".`);
    }
  });

  test('a refusal for a stage nobody has denies none of the stages this workspace does have', async () => {
    const answer = await ask('How many deals are in the Contract review stage?');
    assert.ok(answer.analysis.refusal, `"Contract review" is not a stage here, so this must refuse:\n${answer.content}`);
    for (const label of new Set(stageRows().map((row) => row.label))) {
      assert.ok(answer.content.includes(label),
        `the refusal lists the stages ${'Northwind Robotics'} has and leaves out "${label}", which it holds:\n${answer.content}`);
    }
  });

  /**
   * Every status this workspace spells out is a status the engine counts.
   *
   * Read off `crm_properties`, so a workspace that adds a status is covered
   * here without touching this file. Only the multi-word labels are asked
   * about: a one-word status is English before it is a status, and "new",
   * "open" and "closed" are read more widely on purpose.
   */
  test('every multi-word ticket status this workspace defines is counted as itself', async () => {
    const options = propertyOptions('ticket', 'status').filter((option) => option.label.includes(' '));
    assert.ok(options.length, 'the fixture spells at least one ticket status in more than one word');
    for (const option of options) {
      const answer = await ask(`How many tickets are ${option.label.toLowerCase()}?`);
      assertLedgerSettled(answer);
      const truth = ticketsWithStatus(option.value);
      assert.match(answer.content, new RegExp(`\\b${truth} tickets?\\b`),
        `"${option.label}" is a ticket status in this workspace and ${truth} tickets are at it:\n${answer.content}`);
      assert.ok(!new RegExp(`\\b${ticketsRaisedThisPeriod()} tickets\\b`).test(answer.content),
        `"${option.label}" was answered with the quarter's ticket intake, which is a different question:\n${answer.content}`);
    }
  });

  test('a follow-up inside a thread keeps the subject of the turn before it', async () => {
    const opened = await expectOk('POST', '/v1/ai/threads', { message: 'How many open deals does Priya Raman have?' });
    const priya = openFacts().filter((d) => d.owner === personId('Priya Raman'));
    assert.ok(opened.messages.some((m: { role: string; content: string }) =>
      m.role === 'assistant' && m.content.includes(String(priya.length))), JSON.stringify(opened.messages));
    const reply = await expectOk('POST', `/v1/ai/threads/${opened.id}/messages`, { content: 'And how many of those are in Negotiation?' });
    const negotiating = priya.filter((d) => d.stage === 'negotiation');
    assert.ok(reply.message.content.includes(String(negotiating.length)),
      `the follow-up lost the rep, the measure or the stage:\n${reply.message.content}`);
    assert.ok(!/do not hold anything called/i.test(reply.message.content),
      `the reply denies a stage this workspace lists by name:\n${reply.message.content}`);
  });

  test('every company this workspace holds is answerable by its own name', async () => {
    // The refusal that stops "Bayside Logistics" becoming Oranmore Logistics
    // must never fire on a name the workspace does have. Accents, hyphens and
    // a capitalised verb at the head of the sentence all cut the proper-noun
    // span short, and a truncated span is not evidence of anything.
    const companies = app.ctx.db.all<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM crm_records WHERE org_id = ? AND object_type = 'company' AND archived = 0`, ORG);
    assert.ok(companies.length > 20, 'the fixture has a book of business');
    const refused: string[] = [];
    for (const company of companies) {
      const answer = await ask(`What is ${company.display_name} carrying in open pipeline?`);
      const wrongly = (answer.analysis.qualifiers as { kind: string; state: string; text: string }[])
        .find((entry) => entry.kind === 'account' && entry.state === 'refused');
      if (wrongly) refused.push(`${company.display_name} → refused as "${wrongly.text}"`);
    }
    assert.deepEqual(refused, [], `these accounts exist and were refused:\n${refused.join('\n')}`);
  });

  /**
   * A scope is a property of the plan, proved rather than promised.
   *
   * The ledger used to ask whether *some* step of the bound tool carried the
   * qualifier, so a plan whose metric was scoped and whose listing was not
   * passed its own check — and printed workspace-wide rows under a scoped
   * sentence. This is that plan, and it has to come back as a violation.
   */
  test('a plan that leaves one row step unscoped is a violation, not an answer', () => {
    const ledger = new QualifierLedger([{
      kind: 'pipeline',
      text: 'Renewal',
      resolved: { kind: 'pipeline', value: 'renewal', label: 'Renewal', property: 'pipeline' },
      state: 'pending',
      binding: null,
      detail: null,
    }]);
    const steps = [
      { tool: 'business_metric', args: { metric: 'pipeline', pipeline: 'renewal', group_by: 'none' } },
      { tool: 'record_search', args: { object_type: 'deal', order_by: 'amount', conditions: [{ property: 'deal_stage', op: 'in', values: stageSets(app.ctx, ORG).open }] } },
    ];
    ledger.settleAgainst(steps);
    assert.equal(ledger.first('pipeline')?.state, 'bound', 'the metric really does carry the pipeline');
    const violations = ledger.verify(steps);
    assert.ok(violations.some((v) => v.reason === 'unscoped_step'),
      `the deal listing carries no pipeline filter and the ledger passed it: ${JSON.stringify(violations)}`);
    // …and the same plan with the filter on every step is clean.
    const scoped = [steps[0], {
      tool: 'record_search',
      args: { ...steps[1].args, conditions: [...(steps[1].args.conditions as unknown[]), { property: 'pipeline', op: 'eq', value: 'renewal' }] },
    }];
    assert.deepEqual(new QualifierLedger([{
      kind: 'pipeline', text: 'Renewal', state: 'bound', detail: null,
      resolved: { kind: 'pipeline', value: 'renewal', label: 'Renewal', property: 'pipeline' },
      binding: { tool: 'business_metric', args: { pipeline: 'renewal' } },
    }]).verify(scoped), []);
  });

  /**
   * The one entry that settles later says so itself.
   *
   * A unit is a claim about the figure, not about the query, so it is still
   * pending when the plan is checked. That used to be handled by an allowlist
   * in the engine — `pending().filter(q => q.kind !== 'unit')` — which made the
   * file's own headline ("there is no fourth state") true only by exception.
   * The exception now lives on the entry, where `verify` can see it.
   */
  test('a deferred qualifier is marked on the entry, never exempted by its kind', () => {
    const resolved = { kind: 'unit' as const, value: 'event', label: 'event' };
    const deferred = new QualifierLedger([
      { kind: 'unit', text: 'event', resolved, state: 'pending', binding: null, detail: null, settlesAfterRun: true },
    ]);
    assert.deepEqual(deferred.verify([]), [], 'an entry settled against the figure is not unsettled before the run');
    const plain = new QualifierLedger([
      { kind: 'unit', text: 'event', resolved, state: 'pending', binding: null, detail: null },
    ]);
    assert.ok(plain.verify([]).some((violation) => violation.reason === 'unsettled'),
      'an unmarked pending entry is the silent drop this mechanism exists to catch');
  });

  /**
   * Two units in one question, read in the order the reader wrote them.
   *
   * "How many GB of telemetry events did we meter" names a unit this workspace
   * has no figure in and a unit it does. Reading whichever the database
   * returned first answered it with an event count on one run and refused it on
   * the next — the same sentence, two different answers, neither reproducible.
   */
  test('a question naming two units reads both, in its own order rather than the database\'s', async () => {
    const question = 'How many GB of telemetry events did we meter in August 2026?';
    for (const vocabulary of [['event', 'gb'], ['gb', 'event']]) {
      assert.deepEqual(unitsNamed(question, vocabulary), ['gb', 'event'],
        `the units were read in ${JSON.stringify(vocabulary)} order rather than the question's`);
    }
    assert.ok(unitVocabulary(app.ctx, ORG).includes('gb') && unitVocabulary(app.ctx, ORG).includes('event'),
      'this workspace really does denominate things in both');
    const answer = await ask(question);
    assert.deepEqual((answer.analysis.qualifiers ?? []).filter((q: { kind: string }) => q.kind === 'unit').map((q: { text: string }) => q.text),
      ['gb', 'event'],
      `both units the question names have to reach the ledger:\n${JSON.stringify(answer.analysis.qualifiers)}`);
    assert.ok(answer.analysis.refusal,
      `nothing this workspace meters is denominated in GB, so this cannot come back as an event count:\n${answer.content}`);
  });

  /**
   * A currency word that is also a name is not a currency scope.
   *
   * "Sterling" is three accounts in this workspace. The run for "how much
   * pipeline does Sterling own?" traced `currency "gbp"` off the name, and the
   * account question below — which binds — carried a GBP book into the
   * measurement with the ledger reporting it bound, on a question that names no
   * currency at all.
   */
  test('a company name that is also a currency word never becomes a currency scope', async () => {
    for (const question of ['How much pipeline does Sterling own?', 'What is Sterling Heat Treating carrying in open pipeline?']) {
      const answer = await ask(question);
      const money = (answer.analysis.qualifiers ?? []).filter((entry: { kind: string }) => entry.kind === 'currency');
      assert.deepEqual(money, [],
        `"${question}" names no currency, and the run scoped itself to one: ${JSON.stringify(money)}`);
      for (const step of answer.analysis.plan ?? []) {
        assert.equal(step.args.currency, undefined,
          `${step.tool} was handed a currency book nobody asked for: ${JSON.stringify(step.args)}`);
      }
    }
    // The same word written as a currency still is one.
    const real = await ask('How much revenue did we book in GBP in 2025?');
    assert.ok((real.analysis.qualifiers ?? []).some((entry: { kind: string; state: string }) => entry.kind === 'currency' && entry.state === 'bound'),
      `"in GBP" is a currency book and was not bound:\n${real.content}`);
  });

  test('a follow-up inside a thread keeps the scope of the turn before it', async () => {
    const renewal = openFacts().filter((d) => d.pipeline === 'renewal');
    const opened = await expectOk('POST', '/v1/ai/threads', { message: 'What is the Renewal pipeline worth?' });
    assert.ok(opened.messages.some((m: { role: string; content: string }) =>
      m.role === 'assistant' && m.content.includes(money(sumAmount(renewal)))),
      `the first turn did not answer in the pipeline it names:\n${JSON.stringify(opened.messages)}`);
    const reply = await expectOk('POST', `/v1/ai/threads/${opened.id}/messages`, { content: 'And the smallest deal in it?' });
    const smallest = byAmount(renewal)[0];
    assert.ok(reply.message.content.includes(smallest.name),
      `"it" is the Renewal pipeline, whose smallest deal is ${smallest.name}:\n${reply.message.content}`);
    for (const other of byAmount(openFacts().filter((d) => d.pipeline !== 'renewal')).slice(-3)) {
      assert.ok(!reply.message.content.includes(other.name),
        `the follow-up widened back out to the workspace and returned ${other.name}:\n${reply.message.content}`);
    }
    assert.ok(!/\bdeals still open\b/.test(reply.message.content),
      `the reply describes rows it did not filter as "still open":\n${reply.message.content}`);
  });

  test('a scoped summary fills a schema from its own scope', async () => {
    const renewal = openFacts().filter((d) => d.pipeline === 'renewal');
    const answer = await ask('Summarise the Renewal pipeline', {
      response_schema: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          deals: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'number' } } } },
        },
      },
    });
    const row = JSON.parse(answer.content) as { total: number | null; deals: { name: string; amount: number }[] | null };
    assert.equal(row.total, renewal.length,
      `the schema field came back with the workspace figure rather than the scoped one: ${answer.content}`);
    assert.notEqual(row.total, openFacts().length, 'that is the unscoped open-deal count');
    assert.ok(Array.isArray(row.deals) && row.deals.length > 1,
      `an array schema came back with ${JSON.stringify(row.deals)}`);
    for (const deal of row.deals ?? []) {
      assert.ok(renewal.some((d) => d.name === deal.name),
        `${deal.name} is not in the Renewal pipeline: ${answer.content}`);
    }
  });

  test('a summarised scope fills the schema fields the run actually holds', async () => {
    const priya = openFacts().filter((d) => d.owner === personId('Priya Raman'));
    const answer = await ask('Summarise the open pipeline for Priya Raman', {
      response_schema: {
        type: 'object',
        properties: { owner: { type: 'string' }, open_pipeline: { type: 'number' }, deal_count: { type: 'integer' } },
      },
    });
    const row = JSON.parse(answer.content) as { owner: string | null; open_pipeline: number | null; deal_count: number | null };
    assert.equal(row.owner, 'Priya Raman');
    assert.equal(row.open_pipeline, sumAmount(priya));
    assert.equal(row.deal_count, priya.length);
  });
});

/* ========================================================================== *
 * The qualifier invariant, over every dimension this workspace enumerates.
 *
 * The suite above covers the eleven narrowings someone had written a parser
 * for. This one covers the rest — a lead source, a competitor, a forecast
 * category, a deal type, an industry, a contract term, an age in a stage — and
 * every one of them was, when this was written, silently dropped: the question
 * was answered with the $9,010,960 workspace total or the 38-deal open book,
 * stated at full confidence under the reader's own scoped sentence.
 *
 * Every expectation here is computed from `crm_records` in this file, in
 * JavaScript, without going near the engine. A case passes when the engine
 * either states that figure or refuses; it fails when the engine states the
 * *unqualified* figure, which is the substitution the whole mechanism exists
 * to make impossible.
 * ========================================================================== */

interface FullDeal extends DealFact {
  competitor: string;
  leadSource: string;
  forecast: string;
  dealType: string;
  termMonths: number | null;
  enteredStage: number | null;
}

const fullDeals = (): FullDeal[] => app.ctx.db.all<{
  id: string; display_name: string; owner_id: string | null; created: number; properties: string;
}>(
  `SELECT id, display_name, owner_id, created, properties FROM crm_records
   WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL`, ORG,
).map((row) => {
  const p = JSON.parse(row.properties) as Record<string, unknown>;
  return {
    id: row.id,
    name: row.display_name,
    owner: row.owner_id,
    created: row.created,
    pipeline: String(p.pipeline ?? ''),
    stage: String(p.deal_stage ?? ''),
    amount: Number(p.amount ?? 0),
    close: Number(p.close_date ?? 0),
    competitor: String(p.competitor ?? ''),
    leadSource: String(p.lead_source ?? ''),
    forecast: String(p.forecast_category ?? ''),
    dealType: String(p.deal_type ?? ''),
    termMonths: p.contract_term_months === undefined ? null : Number(p.contract_term_months),
    enteredStage: p.stage_entered_at === undefined ? null : Number(p.stage_entered_at),
  };
});

const openDeals = (): FullDeal[] => {
  const open = stageSets(app.ctx, ORG).open;
  return fullDeals().filter((row) => open.includes(row.stage));
};

const total = (rows: { amount: number }[]): number => rows.reduce((sum, row) => sum + row.amount, 0);

/** The workspace's own formatter, so an expectation is the string the reader sees. */
const cash = (cents: number): string => {
  const profile = workspaceProfile(app.ctx, ORG);
  return formatMoney({ amount: cents, currency: profile.currency }, { locale: profile.locale, trimZeroFraction: true });
};

/** The two figures every dropped qualifier collapses to on this book. */
const WORKSPACE_PIPELINE = (): string => cash(total(openDeals()));
const WORKSPACE_OPEN_COUNT = (): string => `${openDeals().length} open deals`;

/** Companies of one industry, and the open deals associated with them. */
const companiesInIndustry = (industry: string): string[] => app.ctx.db.all<{ id: string; properties: string }>(
  `SELECT id, properties FROM crm_records WHERE org_id = ? AND object_type = 'company' AND archived = 0 AND merged_into IS NULL`, ORG,
).filter((row) => String((JSON.parse(row.properties) as { industry?: unknown }).industry ?? '') === industry).map((row) => row.id);

const dealCompany = (): Map<string, string> => {
  const out = new Map<string, string>();
  for (const row of app.ctx.db.all<{ from_id: string; to_id: string; from_type: string; to_type: string }>(
    `SELECT from_id, to_id, from_type, to_type FROM crm_associations WHERE org_id = ?`, ORG)) {
    if (row.from_type === 'deal' && row.to_type === 'company') out.set(row.from_id, row.to_id);
    if (row.to_type === 'deal' && row.from_type === 'company') out.set(row.to_id, row.from_id);
  }
  return out;
};

const openDealsInIndustry = (industry: string): FullDeal[] => {
  const companies = new Set(companiesInIndustry(industry));
  const link = dealCompany();
  return openDeals().filter((deal) => companies.has(link.get(deal.id) ?? ''));
};

/** Open tickets, by the properties the workspace stores on them. */
const openTicketRows = (): Record<string, unknown>[] =>
  ticketProperties().filter((row) => OPEN_TICKET.includes(String(row.status ?? '')));

interface DimensionCase {
  /** The dimension the question narrows on — for the test name. */
  kind: string;
  q: string;
  /** Strings the answer has to contain when it answers. */
  must?: () => (string | RegExp)[];
  /** True when a refusal is the only honest outcome, with the sentence it must carry. */
  refuse?: RegExp;
  /** Strings whose presence means the qualifier was dropped and a wider set answered. */
  never?: () => (string | RegExp)[];
}

const DIMENSION_CASES: DimensionCase[] = [
  /* --- an enumerated property of a deal ---------------------------------- */
  {
    // $690,260 across 3 open deals, answered with $9,010,960 across 38.
    kind: 'lead source',
    q: 'How much open pipeline came from partner referrals?',
    must: () => {
      const rows = openDeals().filter((d) => d.leadSource === 'partner_referral');
      return [cash(total(rows)), new RegExp(`\\b${rows.length}\\b`), /Partner referral/i];
    },
    never: () => [WORKSPACE_PIPELINE(), WORKSPACE_OPEN_COUNT()],
  },
  {
    kind: 'lead source (a second value of the same dimension)',
    q: 'How much open pipeline came from trade shows?',
    must: () => {
      const rows = openDeals().filter((d) => d.leadSource === 'trade_show');
      return [cash(total(rows)), new RegExp(`\\b${rows.length}\\b`), /Trade show/i];
    },
    never: () => [WORKSPACE_PIPELINE(), WORKSPACE_OPEN_COUNT()],
  },
  {
    // "Commit" is also a verb and "Pipeline" is also a forecast category, so
    // the value only counts beside the dimension's own name — and the longest
    // match in the sentence used to win, which read "open pipeline" as the
    // category and answered for a different 14 deals.
    kind: 'forecast category',
    q: 'How much open pipeline is in the Commit forecast category?',
    must: () => {
      const rows = openDeals().filter((d) => d.forecast === 'commit');
      return [cash(total(rows)), new RegExp(`\\b${rows.length}\\b`), /Commit/];
    },
    never: () => [WORKSPACE_PIPELINE(), cash(total(openDeals().filter((d) => d.forecast === 'pipeline')))],
  },
  {
    kind: 'forecast category (a two-word value)',
    q: 'How much open pipeline is in the Best case forecast category?',
    must: () => {
      const rows = openDeals().filter((d) => d.forecast === 'best_case');
      return [cash(total(rows)), /Best case/];
    },
    never: () => [WORKSPACE_PIPELINE()],
  },
  {
    kind: 'contract term (a number with a unit in its own column name)',
    q: 'How many deals have a 36-month contract term?',
    must: () => [new RegExp(`\\b${openDeals().filter((d) => d.termMonths === 36).length}\\b`), /36-month/],
    never: () => [WORKSPACE_OPEN_COUNT(), `${openDeals().length} open deals right now`],
  },
  /* --- a competitor, including one this workspace has never faced -------- */
  {
    kind: 'competitor',
    q: 'How many deals did we lose to Cognite?',
    must: () => {
      const lost = stageSets(app.ctx, ORG).lost;
      const rows = fullDeals().filter((d) => lost.includes(d.stage) && d.competitor === 'cognite');
      return [new RegExp(`\\b${rows.length}\\b`), /Cognite/];
    },
    never: () => {
      const lost = stageSets(app.ctx, ORG).lost;
      return [`${fullDeals().filter((d) => lost.includes(d.stage)).length} closed-lost deals`];
    },
  },
  {
    // Siemens appears on zero deals in this workspace. The answer was "14
    // closed-lost deals" — every deal Northwind has ever lost, for a
    // competitor it has never met.
    kind: 'competitor (one this workspace has never faced)',
    q: 'How many open deals are we losing to Siemens?',
    refuse: /no competitor called "Siemens"/i,
    never: () => {
      const lost = stageSets(app.ctx, ORG).lost;
      return [`${fullDeals().filter((d) => lost.includes(d.stage)).length} closed-lost deals`, WORKSPACE_OPEN_COUNT()];
    },
  },
  /* --- an industry, which narrows a table the answer does not measure ---- */
  {
    // Three pharmaceutical accounts carry $849,660 across 5 open deals. The
    // answer named one of them — the only company whose name contains the word
    // — and stated $308,880 as the figure.
    kind: 'industry (a filter on companies, measured over deals)',
    q: 'How much open pipeline is with pharmaceutical companies?',
    must: () => {
      const rows = openDealsInIndustry('pharma');
      return [cash(total(rows)), new RegExp(`\\b${rows.length}\\b`), /Pharmaceuticals/i];
    },
    never: () => [WORKSPACE_PIPELINE(), 'Wexler Pharmaceutical is carrying'],
  },
  {
    kind: 'industry (an ampersand label written out in full)',
    q: 'How much open pipeline is with metals and mining accounts?',
    must: () => [cash(total(openDealsInIndustry('metals')))],
    never: () => [WORKSPACE_PIPELINE()],
  },
  {
    kind: 'industry (a list, not a figure)',
    q: 'Which open deals are with aerospace companies?',
    must: () => {
      const rows = openDealsInIndustry('aerospace');
      return [new RegExp(`\\b${rows.length}\\b`), ...rows.map((row) => row.name)];
    },
    never: () => [WORKSPACE_OPEN_COUNT()],
  },
  {
    // The question names no company noun at all, so the account's own
    // dimensions were never read and the answer was the workspace's 38.
    kind: 'sales region (an account property, on a question about deals)',
    q: 'How many open deals are in the EMEA region?',
    must: () => {
      const region = new Set(app.ctx.db.all<{ id: string; properties: string }>(
        `SELECT id, properties FROM crm_records WHERE org_id = ? AND object_type = 'company' AND archived = 0`, ORG,
      ).filter((row) => String((JSON.parse(row.properties) as { region?: unknown }).region ?? '') === 'emea').map((row) => row.id));
      const link = dealCompany();
      const rows = openDeals().filter((deal) => region.has(link.get(deal.id) ?? ''));
      return [new RegExp(`\\b${rows.length} open deals\\b`), /EMEA/];
    },
    never: () => [`${openDeals().length} open deals right now`],
  },
  {
    kind: 'relationship (prospects, on a question about deals)',
    q: 'How much open pipeline is with prospects?',
    must: () => {
      const prospects = new Set(app.ctx.db.all<{ id: string; properties: string }>(
        `SELECT id, properties FROM crm_records WHERE org_id = ? AND object_type = 'company' AND archived = 0`, ORG,
      ).filter((row) => String((JSON.parse(row.properties) as { type?: unknown }).type ?? '') === 'prospect').map((row) => row.id));
      const link = dealCompany();
      const rows = openDeals().filter((deal) => prospects.has(link.get(deal.id) ?? ''));
      return [cash(total(rows)), /Prospect/];
    },
    never: () => [WORKSPACE_PIPELINE()],
  },
  /* --- an age in a state, which is a threshold on a date column ---------- */
  {
    // The eight Negotiation deals are 18–39 days old. The answer listed all
    // eight under a headline naming the stage; the true answer is no rows.
    kind: 'age in stage (a threshold nothing matches)',
    q: 'Which deals are stuck in Negotiation for more than 60 days?',
    must: () => [/^No deals/],
    never: () => fullDeals().filter((d) => d.stage === 'negotiation').map((d) => d.name),
  },
  {
    kind: 'age in stage (a threshold that does match)',
    q: 'Which deals have been in Negotiation for more than 20 days?',
    must: () => {
      const now = app.ctx.now();
      const rows = fullDeals().filter((d) => d.stage === 'negotiation'
        && d.enteredStage !== null && now - d.enteredStage > 20 * 24 * 3600 * 1000);
      return [new RegExp(`\\b${rows.length} deals\\b`), /in that stage for more than 20 days/];
    },
    never: () => [/worth less than 1,7\d\d,\d{3},\d{3},\d{3}/],
  },
  /* --- a ticket's status and priority ------------------------------------ */
  {
    // One article between two words of the stored label broke the match, and
    // all seven open tickets were counted instead of the two in that column.
    kind: 'ticket status (with an article inside the stored label)',
    q: 'How many open tickets are waiting on the customer?',
    must: () => [new RegExp(`\\b${ticketsWithStatus('waiting_on_customer')}\\b`), /Waiting on customer/i],
    never: () => [`${openTickets()} open tickets`],
  },
  {
    // "urgent" and "high priority" returned the identical sentence — three
    // tickets, the union of two bands — for two different questions.
    kind: 'ticket priority (a named band, not the union of two)',
    q: 'How many open tickets are urgent?',
    must: () => [new RegExp(`\\b${openTicketRows().filter((t) => t.priority === 'urgent').length}\\b`), /Urgent/],
    never: () => [/Urgent and High/],
  },
  {
    kind: 'ticket priority (the other band, which must differ)',
    q: 'How many open tickets are high priority?',
    must: () => [new RegExp(`\\b${openTicketRows().filter((t) => t.priority === 'high').length}\\b`), /High/],
    never: () => [/Urgent and High/],
  },
];

describe('the qualifier invariant, over every dimension this workspace enumerates', () => {
  for (const scenario of DIMENSION_CASES) {
    test(`${scenario.kind} — "${scenario.q}"`, async () => {
      const answer = await ask(scenario.q);
      assertLedgerSettled(answer);
      if (scenario.refuse) {
        assert.ok(answer.analysis.refusal,
          `"${scenario.q}" names a value this workspace does not hold, so it must refuse rather than answer:\n${answer.content}`);
        assert.match(answer.content, scenario.refuse);
      } else {
        assert.equal(answer.analysis.refusal, null,
          `"${scenario.q}" is answerable from the rows in this database and was refused:\n${answer.content}`);
        for (const want of scenario.must?.() ?? []) {
          assert.ok(contains(answer.content, want),
            `"${scenario.q}" must state ${want} — computed from crm_records, not from the engine:\n${answer.content}`);
        }
      }
      for (const banned of scenario.never?.() ?? []) {
        assert.ok(!contains(answer.content, banned),
          `"${scenario.q}" answered with ${banned}, which is a wider set than the one the question named:\n${answer.content}`);
      }
    });
  }

  /**
   * Every value of every enumerated dimension, asked about by name.
   *
   * Read from `crm_properties`, so a workspace that adds a picklist is covered
   * here without touching this file. The assertion is the weakest one that
   * still catches the defect: whatever the engine says, it may not be the
   * workspace's own open-deal count — because that is the number every dropped
   * qualifier collapses to.
   */
  test('no value of a deal dimension is answered with the unqualified open book', async () => {
    const workspace = WORKSPACE_OPEN_COUNT();
    for (const property of ['lead_source', 'forecast_category', 'competitor']) {
      for (const option of propertyOptions('deal', property)) {
        if (option.value === 'none') continue;
        const rows = openDeals().filter((deal) => String(
          property === 'lead_source' ? deal.leadSource : property === 'forecast_category' ? deal.forecast : deal.competitor,
        ) === option.value);
        // A value with no open deals behind it has no figure to check; the
        // point is only that the workspace total is never the answer.
        const answer = await ask(`How many open deals have the ${option.label} ${property.replace(/_/g, ' ')}?`);
        assertLedgerSettled(answer);
        assert.ok(!answer.content.includes(workspace),
          `"${option.label}" (${property}) was answered with the workspace's open book:\n${answer.content}`);
        if (!answer.analysis.refusal && rows.length) {
          assert.match(answer.content, new RegExp(`\\b${rows.length}\\b`),
            `"${option.label}" (${property}) covers ${rows.length} open deals:\n${answer.content}`);
        }
      }
    }
  });
});

/* ========================================================================== *
 * The other half of the invariant: the qualifier that is not a scope.
 *
 * A ranking cut-off, a direction, a thread's standing scope, the record a
 * write lands on, the denomination of a figure. Each of these was dropped in
 * exactly the same way — silently, with a confident sentence over the wider
 * answer — and each is checked here against a figure computed from the rows.
 * ========================================================================== */

/** A multi-turn conversation, so a scope set two turns ago can be checked. */
async function thread(questions: string[]): Promise<any[]> {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  const answers: any[] = [];
  for (const question of questions) {
    messages.push({ role: 'user', content: question });
    const answer = await expectOk('POST', '/v1/ai/complete', { messages: [...messages] });
    answers.push(answer);
    messages.push({ role: 'assistant', content: answer.content });
  }
  return answers;
}

describe('a ranking is a qualifier: the cut-off, the direction and the rows', () => {
  test('a cardinal in front of the ranking word cuts the list to that many', async () => {
    const answer = await ask('Give me the 4 largest accounts by revenue.');
    assertLedgerSettled(answer);
    // Ranked per currency book, so the check is per book: a fifth row in any
    // of them is the reader's own number dropped.
    for (const book of answer.content.split(/\n(?=[A-Z]{3} —)/)) {
      const rows = book.match(/^\d+\. /gm) ?? [];
      assert.ok(rows.length <= 4, `a book came back with ${rows.length} rows for a question that asked for 4:\n${answer.content}`);
    }
    assert.match(answer.content, /^1\. /m);
  });

  test('a hyphenated direction is the same instruction as the spaced one', async () => {
    const answer = await ask('List the lowest-value deals in the Expansion pipeline.');
    assertLedgerSettled(answer);
    assert.equal(answer.analysis.refusal, null, `a phrasing this engine answers when spelt with a space:\n${answer.content}`);
    const expansion = openDeals().filter((d) => d.pipeline === 'expansion').sort((a, b) => a.amount - b.amount);
    assert.ok(answer.content.includes(expansion[0].name),
      `the smallest deal in the Expansion pipeline is ${expansion[0].name}:\n${answer.content}`);
    const largest = [...expansion].sort((a, b) => b.amount - a.amount)[0];
    assert.ok(!answer.content.startsWith(`• ${largest.name}`), 'the list opened with the largest under a question asking for the lowest');
  });

  test('an adjectival direction is not read as a measure this workspace lacks', async () => {
    const answer = await ask('What is the least valuable open deal?');
    assertLedgerSettled(answer);
    assert.equal(answer.analysis.refusal, null, `"valuable" is half a ranking, not a measure:\n${answer.content}`);
    const smallest = [...openDeals()].sort((a, b) => a.amount - b.amount)[0];
    const largest = [...openDeals()].sort((a, b) => b.amount - a.amount)[0];
    assert.ok(answer.content.includes(smallest.name), `the smallest open deal is ${smallest.name}:\n${answer.content}`);
    assert.ok(!answer.content.includes(largest.name), `the largest open deal was listed under "least valuable":\n${answer.content}`);
  });

  test('"what are the biggest…" is a list, not a count', async () => {
    const answer = await ask('What are the biggest deals owned by Marcus Ilori?');
    assertLedgerSettled(answer);
    const owned = fullDeals().filter((d) => d.owner === personId('Marcus Ilori')).sort((a, b) => b.amount - a.amount);
    assert.ok(answer.content.includes(owned[0].name),
      `a superlative list has rows in it; ${owned[0].name} is the largest deal Marcus Ilori owns:\n${answer.content}`);
  });

  test('"what are the largest…" in a stage and a pipeline lists the rows in it', async () => {
    const answer = await ask('What are the largest deals in the Negotiation stage of the Renewal pipeline?');
    assertLedgerSettled(answer);
    const rows = fullDeals().filter((d) => d.stage === 'negotiation' && d.pipeline === 'renewal');
    for (const row of rows) {
      assert.ok(answer.content.includes(row.name), `${row.name} is in that stage and that pipeline:\n${answer.content}`);
    }
  });
});

describe('a thread carries its scope forward, and a follow-up cannot widen it', () => {
  test('a pronoun keeps the account when the follow-up names a meter', async () => {
    const [, usage] = await thread([
      'Give me an overview of Kestrel Aerospace Components.',
      'How many telemetry events did they meter in August 2026?',
    ]);
    assertLedgerSettled(usage);
    assert.match(usage.content, /Kestrel Aerospace Components metered/,
      `"they" named Kestrel one turn earlier:\n${usage.content}`);
    // The workspace-wide figure for the same meter and month, which is what
    // the answer used to be — 18.6x the account's own.
    const step = (usage.analysis.plan ?? []).find((s: any) => s.tool === 'metered_usage');
    assert.ok(step?.args.customer, `metered_usage ran with no customer, so the thread's account was dropped:\n${JSON.stringify(step)}`);
  });

  test('an anaphoric ranking inherits every scope the chain established', async () => {
    const answers = await thread([
      'How much open pipeline does Priya Raman own?',
      'And in the Renewal pipeline?',
      'What about Marcus Ilori?',
      'Show me the three smallest of those.',
    ]);
    const last = answers[3];
    assertLedgerSettled(last);
    const marcusRenewal = openDeals().filter((d) => d.owner === personId('Marcus Ilori') && d.pipeline === 'renewal');
    for (const deal of marcusRenewal) {
      assert.ok(last.content.includes(deal.name), `${deal.name} is in the set "those" names:\n${last.content}`);
    }
    for (const deal of openDeals().filter((d) => d.owner === personId('Marcus Ilori') && d.pipeline !== 'renewal')) {
      assert.ok(!last.content.includes(deal.name),
        `${deal.name} is in the ${deal.pipeline} pipeline, and the chain was scoped to Renewal two turns earlier:\n${last.content}`);
    }
  });
});

describe('a write lands on the record the instruction named, or on none', () => {
  test('a descriptive fragment binds the write to the deal it describes', async () => {
    const answer = await ask('Move the Meridian Forge Systems predictive maintenance add-on deal to Proposal sent.', { allow_writes: true });
    const approvals: any[] = answer.pending_approvals ?? [];
    assert.equal(approvals.length, 1, `one write, prepared not performed:\n${answer.content}`);
    const target = String(approvals[0].args.id);
    const named = app.ctx.db.get<{ display_name: string }>(
      `SELECT display_name FROM crm_records WHERE org_id = ? AND id = ?`, ORG, target)!;
    assert.match(named.display_name, /predictive maintenance add-on/,
      `the write was prepared against "${named.display_name}", which is not the deal the sentence named.`);
    // The deal it used to land on is closed-won and worth $330,480; reopening
    // it reclassifies that as pipeline.
    assert.doesNotMatch(named.display_name, /OEE programme phase 2/);
  });

  test('two deals at one account described equally well is a refusal, not a ranking', async () => {
    const answer = await ask('Move the Meridian Forge Systems deal to Proposal sent.', { allow_writes: true });
    assert.equal((answer.pending_approvals ?? []).length, 0,
      `two deals match that sentence equally well; picking one is a coin toss with the reader's data:\n${answer.content}`);
    assert.match(answer.content, /names 2 deals equally well/);
    for (const deal of fullDeals().filter((d) => d.name.startsWith('Meridian Forge Systems'))) {
      assert.ok(answer.content.includes(deal.name), `the refusal lists both candidates; ${deal.name} is missing:\n${answer.content}`);
    }
  });

  test('a date in an instruction is a value, not a reporting period', async () => {
    const answer = await ask(
      'Set the close date on the Calder & Vance Manufacturing connected asset expansion deal to 2026-12-01.',
      { allow_writes: true },
    );
    const approvals: any[] = answer.pending_approvals ?? [];
    assert.equal(approvals.length, 1, `a date-valued write was refused as an unparsed reporting period:\n${answer.content}`);
    assert.equal(approvals[0].args.properties.close_date, Date.UTC(2026, 11, 1, 9));
    const named = app.ctx.db.get<{ display_name: string }>(
      `SELECT display_name FROM crm_records WHERE org_id = ? AND id = ?`, ORG, String(approvals[0].args.id))!;
    assert.match(named.display_name, /connected asset expansion/);
  });
});

describe('the figure a schema field takes is the one the run computed', () => {
  test('a field named for the measure is filled whatever unit the caller wrote into its name', async () => {
    const renewal = openDeals().filter((d) => d.owner === personId('Marcus Ilori') && d.pipeline === 'renewal');
    const answer = await ask('How much open pipeline does Marcus Ilori own in the Renewal pipeline?', {
      response_schema: {
        type: 'object',
        properties: { owner: { type: 'string' }, open_pipeline_cents: { type: 'number' }, deal_count: { type: 'integer' } },
      },
    });
    const row = JSON.parse(answer.content) as { owner: string | null; open_pipeline_cents: number | null; deal_count: number | null };
    assert.equal(row.owner, 'Marcus Ilori');
    assert.equal(row.open_pipeline_cents, total(renewal),
      `the run holds this figure and filled the identical field called "amount"; the unit in the name is not part of the measure.`);
    assert.equal(row.deal_count, renewal.length);
  });

  test('a count field named for the rows a catalogue measure counted is filled from them', async () => {
    const answer = await ask('What did we invoice in GBP in Q2 2026?', {
      response_schema: {
        type: 'object',
        properties: { amount: { type: 'number' }, currency: { type: 'string' }, invoice_count: { type: 'integer' } },
      },
    });
    const row = JSON.parse(answer.content) as { amount: number | null; invoice_count: number | null };
    assert.ok(typeof row.amount === 'number', `the prose states an amount: ${answer.content}`);
    assert.ok(typeof row.invoice_count === 'number' && row.invoice_count > 0,
      `the prose names the invoices behind the figure and the schema field came back null: ${answer.content}`);
  });
});

describe('a zero says what it is a zero of', () => {
  test('a currency-scoped zero names the book in the same sentence', async () => {
    const answer = await ask("What is Brightline Foods' outstanding balance in EUR?");
    assertLedgerSettled(answer);
    const zero = answer.content.split('\n')[0];
    assert.match(zero, /EUR/, `the unqualified sentence is false — this account is 56 days past due in USD:\n${zero}`);
  });

  test('a period that has not started is not a period with nothing in it', async () => {
    const answer = await ask('How much will we invoice next quarter?');
    assertLedgerSettled(answer);
    assert.match(answer.content, /has not started/,
      `a forward window on a historical measure is refused by name, not answered with a historical zero:\n${answer.content}`);
  });

  test('an empty meter reads as English', async () => {
    const answer = await ask('How many telemetry events did Meridian Forge Systems meter in July 2026?');
    assert.doesNotMatch(answer.content, /events was metered/, `subject and verb disagree:\n${answer.content}`);
  });

  test('a closed-won total is not labelled open pipeline', async () => {
    const answer = await ask('What is the total value of deals we won in the Renewal pipeline last year?');
    assertLedgerSettled(answer);
    assert.ok(!/open pipeline/i.test(answer.content) || !/closed-won/i.test(answer.content),
      `the metric noun and the set contradict each other in one clause:\n${answer.content}`);
  });
});

describe('the first person is an owner', () => {
  for (const question of ['How much pipeline do I own?', 'What is my open pipeline?', 'Which deals are assigned to me?']) {
    test(`"${question}" is scoped to the person asking`, async () => {
      const answer = await ask(question);
      assertLedgerSettled(answer);
      const mine = openDeals().filter((d) => d.owner === 'usr_seed01');
      assert.ok(answer.content.includes('Dana Whitfield'),
        `the session belongs to Dana Whitfield, and the answer names nobody:\n${answer.content}`);
      assert.ok(!answer.content.includes(cash(total(openDeals()))),
        `answered with the workspace's whole open book:\n${answer.content}`);
      assert.ok(answer.content.includes(cash(total(mine))) || answer.content.includes(`${mine.length}`),
        `Dana Whitfield owns ${mine.length} open deals worth ${cash(total(mine))}:\n${answer.content}`);
    });
  }
});

describe('the measure lexicon runs before the status lexicon', () => {
  test('"open pipeline" is a measure, not the status "open"', async () => {
    const answer = await ask('Summarise Kestrel Aerospace Components and tell me their open pipeline.');
    assertLedgerSettled(answer);
    assert.equal(answer.analysis.refusal, null,
      `"open pipeline" was shredded into the status "open" and the whole question refused:\n${answer.content}`);
    assert.doesNotMatch(answer.content, /the status "open/,
      `the measure's own name was read back as a status:\n${answer.content}`);
    assert.match(answer.content, /Kestrel Aerospace Components/);
  });
});

describe('two teammates in one question is a comparison, not a refusal', () => {
  test('both reps are measured, each over the rows they own', async () => {
    const answer = await ask('Compare open pipeline for Dana Whitfield and Priya Raman.');
    assertLedgerSettled(answer);
    assert.equal(answer.analysis.refusal, null, `both names resolve to teammates this workspace has:\n${answer.content}`);
    for (const name of ['Dana Whitfield', 'Priya Raman']) {
      const owned = openDeals().filter((d) => d.owner === personId(name));
      assert.ok(answer.content.includes(cash(total(owned))),
        `${name} owns ${cash(total(owned))} of open pipeline and the answer does not state it:\n${answer.content}`);
    }
  });
});

/**
 * The nine questions two critics found, verbatim.
 *
 * Every one of them was answered with a confident, precise figure about a
 * different question. They are here as written so a regression cannot hide
 * behind a rephrasing.
 */
describe('the substitutions this engine exists to refuse, in the words they were found in', () => {
  const workspaceTotal = () => cash(total(openDeals()));

  test('"What is the Renewal pipeline worth?"', async () => {
    const answer = await ask('What is the Renewal pipeline worth?');
    assertLedgerSettled(answer);
    const renewal = openDeals().filter((d) => d.pipeline === 'renewal');
    assert.ok(answer.content.includes(cash(total(renewal))), `the Renewal book is ${cash(total(renewal))}:\n${answer.content}`);
    assert.ok(!answer.content.includes(workspaceTotal()), `answered with the workspace total:\n${answer.content}`);
  });

  test('"What is our weighted pipeline?"', async () => {
    const answer = await ask('What is our weighted pipeline?');
    assertLedgerSettled(answer);
    const weighted = app.ctx.db.all<{ properties: string }>(
      `SELECT properties FROM crm_records WHERE org_id = ? AND object_type = 'deal' AND archived = 0`, ORG,
    ).map((row) => JSON.parse(row.properties) as Record<string, unknown>)
      .filter((p) => stageSets(app.ctx, ORG).open.includes(String(p.deal_stage ?? '')))
      .reduce((sum, p) => sum + Number(p.weighted_amount ?? 0), 0);
    assert.ok(answer.content.includes(cash(weighted)), `weighted pipeline is ${cash(weighted)}:\n${answer.content}`);
    assert.ok(!answer.content.includes(workspaceTotal()), `answered with open pipeline, which is a different measure:\n${answer.content}`);
  });

  test('"How many deals are in Negotiation?"', async () => {
    const answer = await ask('How many deals are in Negotiation?');
    assertLedgerSettled(answer);
    const rows = fullDeals().filter((d) => d.stage === 'negotiation');
    assert.match(answer.content, new RegExp(`\\b${rows.length}\\b`));
    assert.ok(!answer.content.includes(`${openDeals().length} open deals right now`),
      `answered with the whole open book:\n${answer.content}`);
  });

  test('"How much pipeline does Marcus Ilori own?"', async () => {
    const answer = await ask('How much pipeline does Marcus Ilori own?');
    assertLedgerSettled(answer);
    const owned = openDeals().filter((d) => d.owner === personId('Marcus Ilori'));
    assert.ok(answer.content.includes(cash(total(owned))), `Marcus owns ${cash(total(owned))}:\n${answer.content}`);
    assert.ok(!/Whitcombe/.test(answer.content), `a contact's employer is not an owner:\n${answer.content}`);
  });

  test('"Which deals did we lose in Q2 2026?"', async () => {
    const answer = await ask('Which deals did we lose in Q2 2026?');
    assertLedgerSettled(answer);
    const lost = stageSets(app.ctx, ORG).lost;
    const rows = fullDeals().filter((d) => lost.includes(d.stage)
      && d.close >= Date.UTC(2026, 3, 1) && d.close < Date.UTC(2026, 6, 1));
    assert.match(answer.content, new RegExp(`\\b${rows.length} closed-lost deals?\\b`));
    assert.ok(!answer.content.includes(WORKSPACE_OPEN_COUNT()), `answered with the open book:\n${answer.content}`);
    for (const won of fullDeals().filter((d) => d.stage === 'closed_won'
      && d.close >= Date.UTC(2026, 3, 1) && d.close < Date.UTC(2026, 6, 1))) {
      assert.ok(!answer.content.includes(won.name), `${won.name} was won, not lost:\n${answer.content}`);
    }
  });

  test('"What did we invoice in August 2026?"', async () => {
    const answer = await ask('What did we invoice in August 2026?');
    assertLedgerSettled(answer);
    assert.match(answer.content, /August 2026/);
    assert.doesNotMatch(answer.content, /July 2025|July 2026/, `invoices from another month:\n${answer.content}`);
  });

  for (const stage of ['Technical validation', 'Proposal sent']) {
    test(`"${stage}" is a stage this workspace has, and is answered as one`, async () => {
      const answer = await ask(`How many deals are in ${stage}?`);
      assertLedgerSettled(answer);
      assert.equal(answer.analysis.refusal, null,
        `${stage} is a stage this workspace stores, and the refusal printed it by name:\n${answer.content}`);
      const value = stageValueOf(stage);
      assert.match(answer.content, new RegExp(`\\b${fullDeals().filter((d) => d.stage === value).length}\\b`));
    });
  }
});
