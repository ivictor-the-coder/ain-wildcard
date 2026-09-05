/**
 * The same mistakes, one door further along.
 *
 * Each case here is the sibling of a defect that was already closed somewhere
 * else in the platform, still open on the path nobody looked at:
 *
 *  1. `requestApproval` and `schedule_followup` were re-keyed on the *whole*
 *     write rather than on the slot it lands in. The HTTP idempotency guard
 *     keys on part of the request too — it hashes the path and the body and
 *     drops the method and the query string — so `DELETE /v1/records/:t/:id`
 *     and `DELETE /v1/records/:t/:id?permanent=true` are one request to it.
 *  2. `publicApproval` stopped capping the arguments at 400 characters,
 *     because an operator cannot consent to a note whose last sentence is an
 *     ellipsis. `publicPending` — the copy returned by the very call that asks
 *     for the approval — still caps them.
 *  3. One approval is one write, and a queue that silently shows 50 of 62 is
 *     the same loss read from the list: the run detail and the approval queue
 *     both truncate against a workspace-wide limit and then say `has_more:
 *     false`.
 *  4. The decide route refuses to execute onto a record that was archived or
 *     deleted while the approval waited. `schedule_followup` defers its write
 *     by up to a year and asks nothing at all when it finally runs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type App } from '../src/server/app';
import { frozenClock } from '../src/server/kernel/clock';
import { aiRuntime, type AiCallContext } from '../src/server/ai/runtime';
import { DAY } from '../src/shared/time';

const ORG = 'org_demo';
const DANA = 'usr_seed01';
const T0 = Date.parse('2026-03-01T00:00:00Z');

async function boot(frozen = true): Promise<App> {
  return createApp({
    db: 'memory', seed: true, config: { env: 'test' },
    ...(frozen ? { clock: frozenClock(T0) } : {}),
  });
}

async function signIn(app: App): Promise<Record<string, string>> {
  const login = await app.handle({ method: 'POST', path: '/v1/auth/login', body: { email: 'dana@northwind.io', password: 'demo1234' } });
  assert.equal(login.status, 200, 'precondition: Dana could not sign in');
  return { cookie: String(login.headers['set-cookie']).split(';')[0] };
}

const company = (app: App): string =>
  app.db.pluck<string>(
    `SELECT id FROM crm_records WHERE org_id = ? AND object_type = 'company' AND archived = 0 AND merged_into IS NULL LIMIT 1`,
    ORG)!;

const call = (app: App, over: Partial<AiCallContext> = {}): AiCallContext => ({
  ctx: app.ctx, orgId: ORG, actorId: DANA, actorType: 'user', feature: 'test',
  runId: 'run_probe', spans: [], pendingApprovals: [], startedNs: process.hrtime.bigint(),
  steps: 0, allowWrites: true, approvals: [], ...over,
});

/* ------------- 1. an idempotency key identifies a whole request ----------- */

describe('an idempotency key is the whole request, not the half of it that was hashed', () => {
  test('archiving a record does not answer for permanently deleting it', async () => {
    const app = await boot();
    const headers = await signIn(app);
    const record = company(app);

    const archive = await app.handle({
      method: 'DELETE', path: `/v1/records/company/${record}`,
      headers: { ...headers, 'idempotency-key': 'delete-the-duplicate' },
    });
    assert.equal(archive.status, 204);
    assert.equal(app.db.pluck<number>(`SELECT archived FROM crm_records WHERE id = ?`, record), 1);

    // Same key, same body (there is none), different request: `?permanent=true`
    // is the difference between "hide it" and "it is gone for good".
    const permanent = await app.handle({
      method: 'DELETE', path: `/v1/records/company/${record}?permanent=true`,
      headers: { ...headers, 'idempotency-key': 'delete-the-duplicate' },
    });
    assert.notEqual(
      permanent.headers['idempotent-replayed'], 'true',
      'a permanent delete was answered with the archive\'s reply, so the operator was told a record was destroyed that is still there',
    );
    assert.equal(permanent.status, 409, `expected idempotency_key_in_use, got ${permanent.status}`);
    assert.equal(permanent.body?.error?.code, 'idempotency_key_in_use');
    app.close();
  });

  test('the same request under the same key still replays', async () => {
    const app = await boot();
    const headers = await signIn(app);

    const first = await app.handle({
      method: 'POST', path: '/v1/records/company', body: { properties: { name: 'Alpha Fertigung' } },
      headers: { ...headers, 'idempotency-key': 'create-alpha' },
    });
    assert.equal(first.status, 201);
    const again = await app.handle({
      method: 'POST', path: '/v1/records/company', body: { properties: { name: 'Alpha Fertigung' } },
      headers: { ...headers, 'idempotency-key': 'create-alpha' },
    });
    assert.equal(again.headers['idempotent-replayed'], 'true', 'a genuine retry stopped replaying');
    assert.equal(again.body.id, first.body.id);
    assert.equal(app.db.count(
      `SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND display_name = 'Alpha Fertigung'`, ORG), 1);
    app.close();
  });
});

/* ---------- 2. the write is shown whole wherever it is shown at all ------- */

describe('the call that asks for an approval shows the write it will run', () => {
  test('pending_approvals is not capped where the approval queue is not', async () => {
    const app = await boot();
    const headers = await signIn(app);
    const name = app.db.pluck<string>(
      `SELECT display_name FROM crm_records WHERE org_id = ? AND id = ?`, ORG, company(app))!;
    const note = `${'Context from the QBR. '.repeat(40)}ACTION: send the amended MSA by Friday or we lose the renewal.`;
    assert.ok(note.length > 400, 'precondition: the note is longer than the trace\'s cap');

    const answer = await app.handle({
      method: 'POST', path: '/v1/ai/complete',
      body: { prompt: `Add a note to ${name} saying "${note}"`, allow_writes: true },
      headers,
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body).slice(0, 300));
    assert.equal(answer.body.pending_approvals.length, 1, 'the run did not queue the write');
    const shown = String(answer.body.pending_approvals[0].args.body);

    const queued = await app.handle({ method: 'GET', path: '/v1/ai/approvals', headers });
    const stored = String(queued.body.data[0].args.body);

    assert.ok(!shown.endsWith('…'), 'the reply that asked for approval ended the note in an ellipsis');
    assert.ok(shown.length > 400, 'the reply that asked for approval showed only the trace\'s 400-character window');
    assert.equal(
      shown, stored,
      'the write shown by the call that asked for it is not the write the queue holds, so the operator was asked to approve a different note from the one that will run',
    );
    app.close();
  });
});

/* ------------- 3. a queue that drops work does not say so ---------------- */

describe('every write waiting for a person is reachable', () => {
  async function queue(app: App, count: number, runFor: (i: number) => string): Promise<void> {
    const runtime = aiRuntime(app.ctx);
    const tool = runtime.tool('add_note')!;
    const record = company(app);
    for (let i = 0; i < count; i++) {
      const runId = runFor(i);
      if (!app.db.get(`SELECT id FROM ai_runs WHERE id = ?`, runId)) {
        app.db.insert('ai_runs', {
          id: runId, org_id: ORG, thread_id: null, feature: 'test', provider: 'builtin', model: 'ain-engine-1',
          actor_id: DANA, actor_type: 'user', status: 'needs_approval', question: 'q', answer: '',
          intent: null, confidence: null, reasoning: '[]', citations: '[]', steps: 0, span_count: 0,
          input_tokens: 0, output_tokens: 0, credits: 0, cost_micros: 0, error: null,
          started: app.ctx.now(), finished: null, duration_ms: 0,
        });
      }
      await runtime.execute('add_note',
        { record_ids: [record], subject: `S${i}`, body: `Body ${i}` }, call(app, { runId }), tool);
    }
    // A frozen clock stamps every card with the same instant; give them the
    // ordering a real one would so "the newest 50" means something.
    let t = app.ctx.now();
    for (const row of app.db.all<{ id: string }>(`SELECT id FROM ai_approvals WHERE org_id = ? ORDER BY rowid ASC`, ORG)) {
      app.db.run(`UPDATE ai_approvals SET created = ? WHERE id = ?`, t++, row.id);
    }
  }

  test('the approval queue counts what it is holding back', async () => {
    const app = await boot();
    const headers = await signIn(app);
    await queue(app, 62, (i) => `run_q_${i}`);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM ai_approvals WHERE org_id = ? AND status = 'pending'`, ORG), 62);

    const list = await app.handle({ method: 'GET', path: '/v1/ai/approvals', headers });
    assert.equal(list.status, 200);
    assert.equal(
      list.body.total_count, 62,
      `the queue answered ${list.body.data.length} card(s) and did not say how many are waiting`,
    );
    assert.equal(list.body.has_more, true, 'the queue dropped 12 writes and reported has_more: false');
    app.close();
  });

  test('a run shows its own approvals however many newer ones there are', async () => {
    const app = await boot();
    const headers = await signIn(app);
    await queue(app, 2, () => 'run_early');
    await queue(app, 60, (i) => `run_later_${i}`);

    const run = await app.handle({ method: 'GET', path: '/v1/ai/runs/run_early', headers });
    assert.equal(run.status, 200);
    assert.equal(
      run.body.approvals.length, 2,
      'the run detail read the newest 50 approvals in the workspace and then filtered, so an older run audits as having asked for nothing',
    );
    app.close();
  });
});

/* ---- 4. a deferred write is re-checked against the record it lands on ---- */

describe('an approved follow-up is checked against the record when it fires', () => {
  async function approveFollowup(app: App, record: string): Promise<void> {
    const runtime = aiRuntime(app.ctx);
    const tool = runtime.tool('schedule_followup')!;
    const headers = await signIn(app);
    const asked = await runtime.execute('schedule_followup',
      { record_id: record, in_days: 30, note: 'Chase the signed MSA before the renewal' }, call(app), tool);
    assert.equal(asked.error?.code, 'approval_required');
    const card = app.db.get<{ id: string }>(`SELECT id FROM ai_approvals WHERE org_id = ? AND status = 'pending'`, ORG)!;
    const decided = await app.handle({ method: 'POST', path: `/v1/ai/approvals/${card.id}`, body: { decision: 'approve' }, headers });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.executed, true);
  }

  test('a record archived while the follow-up waited is not written to', async () => {
    const app = await boot();
    const record = company(app);
    await approveFollowup(app, record);

    // The decide route refuses this exact target — "a note written onto a
    // record that is gone is a write nobody asked for landing where nobody
    // will read it". Thirty days later the job asks nobody.
    app.ctx.svc.crm.archive(ORG, 'company', record, { actorId: DANA });
    await app.travel(40 * DAY);

    const notes = app.db.count(
      `SELECT COUNT(*) FROM crm_record_values WHERE org_id = ? AND property = 'subject' AND value_text LIKE 'Follow-up:%'`, ORG);
    assert.equal(notes, 0, 'the follow-up wrote onto an archived record\'s timeline');
    const skipped = app.ctx.events.list(ORG, { types: ['ai.followup.skipped'], limit: 5 });
    assert.equal(skipped.length, 1, 'nothing told the operator their approved follow-up did not land');
    assert.equal((skipped[0].data as { reason: string }).reason, 'archived');
    app.close();
  });

  test('a record deleted while the follow-up waited fails loudly, not silently', async () => {
    const app = await boot();
    const record = company(app);
    await approveFollowup(app, record);

    app.db.run(`DELETE FROM crm_records WHERE org_id = ? AND id = ?`, ORG, record);
    const travelled = await app.travel(40 * DAY);

    assert.equal(travelled.failed, 0,
      'the approved follow-up burned its eight retries and ended as a dead job row nobody reads');
    const skipped = app.ctx.events.list(ORG, { types: ['ai.followup.skipped'], limit: 5 });
    assert.equal(skipped.length, 1, 'an approved write vanished with nothing anywhere saying so');
    assert.equal((skipped[0].data as { reason: string }).reason, 'missing');
    app.close();
  });

  test('a live record still gets its note, and a merged one follows the merge', async () => {
    const app = await boot();
    const record = company(app);
    await approveFollowup(app, record);
    await app.travel(40 * DAY);

    const due = app.ctx.events.list(ORG, { types: ['ai.followup.due'], limit: 5 });
    assert.equal(due.length, 1, 'the ordinary follow-up stopped happening');
    assert.equal(app.db.count(
      `SELECT COUNT(*) FROM crm_record_values WHERE org_id = ? AND property = 'subject' AND value_text LIKE 'Follow-up:%'`, ORG), 1);

    // The merge case is deliberately *not* blocked: the surviving record is
    // where the account's timeline now lives, so the note follows it there.
    const app2 = await boot();
    const loser = company(app2);
    const winner = app2.db.pluck<string>(
      `SELECT id FROM crm_records WHERE org_id = ? AND object_type = 'company' AND id <> ? AND archived = 0 AND merged_into IS NULL LIMIT 1`,
      ORG, loser)!;
    await approveFollowup(app2, loser);
    app2.ctx.svc.crm.merge(ORG, 'company', winner, loser, { actorId: DANA });
    await app2.travel(40 * DAY);
    assert.equal(app2.ctx.events.list(ORG, { types: ['ai.followup.due'], limit: 5 }).length, 1,
      'a follow-up on a record that was merged away never reached the surviving account');
    app.close();
    app2.close();
  });
});
