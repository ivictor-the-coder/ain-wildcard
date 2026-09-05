/**
 * Two writes an operator approved are two writes.
 *
 * Both halves of the approval path had collapsed distinct writes into one, in
 * mirror-image ways:
 *
 *  - `schedule_followup` keyed its job on the *slot* it lands in
 *    (`record + due time`) rather than on what it writes, and `JobQueue.enqueue`
 *    patches the payload of a row it already holds — so the second of two
 *    approved follow-ups overwrote the first instead of being skipped, and both
 *    calls answered `{ scheduled: true }`.
 *  - `requestApproval` keyed its card on the *redacted* arguments, which cap a
 *    string at 400 characters, so two long notes agreeing in their first 400
 *    characters became one card. The stored payload is also what the decide
 *    route re-runs, so a long note was approved in full and written truncated.
 *
 * The invariant under both: what is stored is what will run, and what will run
 * identifies the write.
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

async function boot(): Promise<App> {
  return createApp({ db: 'memory', seed: true, config: { env: 'test' }, clock: frozenClock(T0) });
}

const company = (app: App): string =>
  app.db.pluck<string>(`SELECT id FROM crm_records WHERE org_id = ? AND object_type = 'company' LIMIT 1`, ORG)!;

const call = (app: App, over: Partial<AiCallContext> = {}): AiCallContext => ({
  ctx: app.ctx, orgId: ORG, actorId: DANA, actorType: 'user', feature: 'test',
  runId: 'run_probe', spans: [], pendingApprovals: [], startedNs: process.hrtime.bigint(),
  steps: 0, allowWrites: true, approvals: [], ...over,
});

async function signIn(app: App): Promise<Record<string, string>> {
  const login = await app.handle({ method: 'POST', path: '/v1/auth/login', body: { email: 'dana@northwind.io', password: 'demo1234' } });
  assert.equal(login.status, 200, 'precondition: Dana could not sign in');
  return { cookie: String(login.headers['set-cookie']).split(';')[0] };
}

const followups = (app: App) =>
  app.db.all<{ payload: string; idem_key: string }>(
    `SELECT payload, idem_key FROM jobs WHERE org_id = ? AND type = 'ai.followup' AND status = 'pending'`, ORG)
    .map((row) => ({ ...row, note: JSON.parse(String(row.payload)).note as string }));

/* ------------------------------ follow-ups -------------------------------- */

describe('a scheduled follow-up is keyed on what it writes', () => {
  test('two follow-ups due the same day on the same account are two jobs', async () => {
    const app = await boot();
    const runtime = aiRuntime(app.ctx);
    const tool = runtime.tool('schedule_followup')!;
    const record = company(app);
    const granted = call(app, { approvals: ['schedule_followup'] });

    const first = await runtime.execute('schedule_followup', { record_id: record, in_days: 7, note: 'Send the renewal quote' }, granted, tool);
    const second = await runtime.execute('schedule_followup', { record_id: record, in_days: 7, note: 'Chase the signed security questionnaire' }, granted, tool);
    assert.ok(first.ok && second.ok, 'both tool calls reported success');

    const rows = followups(app);
    assert.equal(rows.length, 2, `two approved follow-ups left ${rows.length} job(s) in the queue`);
    assert.deepEqual(
      rows.map((r) => r.note).sort(),
      ['Chase the signed security questionnaire', 'Send the renewal quote'],
      'a follow-up an operator approved was overwritten by the next one',
    );

    // …and an identical repeat — a retried tool call — is still one job.
    await runtime.execute('schedule_followup', { record_id: record, in_days: 7, note: 'Send the renewal quote' }, granted, tool);
    assert.equal(followups(app).length, 2, 'an identical repeat raised a duplicate job');
    app.close();
  });

  test('a different assignee is a different follow-up, even word for word', async () => {
    const app = await boot();
    const runtime = aiRuntime(app.ctx);
    const tool = runtime.tool('schedule_followup')!;
    const record = company(app);
    const granted = call(app, { approvals: ['schedule_followup'] });
    const note = 'Confirm the shipping window with the plant';

    await runtime.execute('schedule_followup', { record_id: record, in_days: 3, note, assignee_id: DANA }, granted, tool);
    await runtime.execute('schedule_followup', { record_id: record, in_days: 3, note, assignee_id: 'usr_seed03' }, granted, tool);
    assert.equal(followups(app).length, 2, 'the same task assigned to two people collapsed into one job');
    app.close();
  });

  test('both follow-ups reach the record when the clock catches up', async () => {
    const app = await boot();
    const runtime = aiRuntime(app.ctx);
    const tool = runtime.tool('schedule_followup')!;
    const record = company(app);
    const headers = await signIn(app);

    // Through the real surface: the tool asks, a person approves, the platform
    // schedules. This is the path the fuzz run lost writes on.
    for (const note of ['Send the renewal quote', 'Chase the signed security questionnaire']) {
      const asked = await runtime.execute('schedule_followup', { record_id: record, in_days: 7, note }, call(app), tool);
      assert.equal(asked.error?.code, 'approval_required');
    }
    const pending = app.db.all<{ id: string }>(`SELECT id FROM ai_approvals WHERE org_id = ? AND status = 'pending'`, ORG);
    assert.equal(pending.length, 2, `two different follow-ups raised ${pending.length} approval card(s)`);
    for (const card of pending) {
      const decided = await app.handle({ method: 'POST', path: `/v1/ai/approvals/${card.id}`, body: { decision: 'approve' }, headers });
      assert.equal(decided.status, 200, JSON.stringify(decided.body));
      assert.equal(decided.body.executed, true);
    }

    await app.travel(8 * DAY);
    const due = app.ctx.events.list(ORG, { types: ['ai.followup.due'], limit: 50 });
    assert.equal(due.length, 2, `${due.length} of 2 approved follow-ups came due`);
    const notes = app.db.all<{ value_text: string }>(
      `SELECT value_text FROM crm_record_values WHERE org_id = ? AND property = 'subject' AND value_text LIKE 'Follow-up:%'`, ORG);
    assert.deepEqual(
      notes.map((n) => n.value_text).sort(),
      ['Follow-up: Chase the signed security questionnaire', 'Follow-up: Send the renewal quote'],
      'an approved follow-up never reached the timeline, and nothing said so',
    );
    app.close();
  });
});

/* ------------------------------- approvals -------------------------------- */

describe('an approval stores the write it will run, not the copy it shows', () => {
  const PREFACE = 'Renewal call summary. '.repeat(21); // 462 characters, shared verbatim
  const SIGNING = `${PREFACE} DECISION: they will sign the 3-year deal at 12% uplift.`;
  const CHURNING = `${PREFACE} DECISION: they are churning; do not renew, start the wind-down.`;

  test('two long notes agreeing in their first 400 characters are two cards', async () => {
    const app = await boot();
    const runtime = aiRuntime(app.ctx);
    const tool = runtime.tool('add_note')!;
    const record = company(app);
    const context = call(app);

    for (const body of [SIGNING, CHURNING]) {
      const asked = await runtime.execute('add_note', { record_ids: [record], subject: 'Renewal call', body }, context, tool);
      assert.equal(asked.error?.code, 'approval_required');
    }

    const cards = app.db.all<{ args: string }>(`SELECT args FROM ai_approvals WHERE org_id = ? AND run_id = 'run_probe'`, ORG);
    assert.equal(cards.length, 2, `two opposite decisions queued ${cards.length} approval card(s)`);
    const bodies = cards.map((c) => JSON.parse(c.args).body as string);
    assert.ok(bodies.some((b) => b.includes('sign the 3-year deal')), 'the renewal decision was lost');
    assert.ok(
      bodies.some((b) => b.includes('do not renew, start the wind-down')),
      'the churn decision was stored truncated, so approving it would write a note that never says what was decided',
    );

    // An identical repeat is still one card: the dedupe still dedupes.
    await runtime.execute('add_note', { record_ids: [record], subject: 'Renewal call', body: SIGNING }, context, tool);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM ai_approvals WHERE org_id = ? AND run_id = 'run_probe'`, ORG), 2,
      'the same write asked for twice raised two cards');
    app.close();
  });

  test('what is approved is what lands, to the last sentence', async () => {
    const app = await boot();
    const runtime = aiRuntime(app.ctx);
    const tool = runtime.tool('add_note')!;
    const record = company(app);
    const headers = await signIn(app);
    const body = `${'Context from the QBR. '.repeat(40)}ACTION: send the amended MSA by Friday or we lose the renewal.`;
    assert.ok(body.length > 800, 'precondition: the note is longer than the trace\'s 400-character cap');

    const asked = await runtime.execute('add_note', { record_ids: [record], subject: 'QBR', body }, call(app), tool);
    assert.equal(asked.error?.code, 'approval_required');
    const card = app.db.get<{ id: string }>(`SELECT id FROM ai_approvals WHERE org_id = ? AND status = 'pending'`, ORG)!;

    // The person deciding reads the whole note — approving text you cannot see
    // is the same defect as executing text that was never shown.
    const shown = await app.handle({ method: 'GET', path: '/v1/ai/approvals', headers });
    assert.equal((shown.body.data[0].args.body as string), body, 'the card showed the operator a truncated note');

    const decided = await app.handle({ method: 'POST', path: `/v1/ai/approvals/${card.id}`, body: { decision: 'approve' }, headers });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.executed, true);

    const landed = app.db.all<{ value_text: string }>(
      `SELECT value_text FROM crm_record_values WHERE org_id = ? AND property = 'body' AND value_text LIKE '%amended MSA%'`, ORG);
    assert.equal(landed.length, 1,
      'the approval reported success and wrote a different note from the one it was given');
    assert.equal(landed[0].value_text, body);
    app.close();
  });
});
