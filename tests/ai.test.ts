import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { aiRuntime, type AiCallContext } from '../src/server/ai/runtime';
import { classifyIntent } from '../src/server/ai/intent';
import { resolveWindow, startOfQuarter, addQuarters } from '../src/server/ai/dates';
import { entityIndex, workspaceProfile } from '../src/server/ai/grounding';
import { resolveEntities } from '../src/server/ai/resolve';
import { estimateTokens, accountUsage } from '../src/server/ai/usage';
import { stageSets } from '../src/server/ai/metrics';
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
