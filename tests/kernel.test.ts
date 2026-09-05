import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { Db } from '../src/server/kernel/db';
import { JobQueue } from '../src/server/kernel/jobs';
import { createLogger } from '../src/server/kernel/logger';
import { CORE_MIGRATIONS } from '../src/server/kernel/core-schema';
import { runInOrgScope } from '../src/server/kernel/org-scope';
import type { AiToolDef } from '../src/server/kernel/ai';
import { aiRuntime, type AiCallContext } from '../src/server/ai/runtime';
import v from '../src/shared/validate';
import {
  ApiClientError, currentAuthLoss, currentNetworkFailure, currentRateLimit, request,
} from '../src/client/kernel/api';
import { invalidate, peekCache, primeCache } from '../src/client/kernel/api';

function queue() {
  const db = new Db(':memory:');
  db.migrate(CORE_MIGRATIONS, 0);
  return { db, jobs: new JobQueue(db, createLogger({ level: 'error' })) };
}

describe('a job is claimed, not merely observed', () => {
  test('two drains racing the same due batch run the handler exactly once', async () => {
    const { db, jobs } = queue();
    let ran = 0;
    jobs.handle('renew', () => { ran += 1; });
    jobs.enqueue('org_1', 'renew', { subscription: 'sub_1' }, 0);

    // Both callers snapshot the queue before either runs anything — exactly what
    // two concurrent ticks, or two /v1/time/advance calls, do to each other.
    const batchA = jobs.due(0);
    const batchB = jobs.due(0);
    assert.equal(batchA.length, 1);
    assert.equal(batchB.length, 1, 'both callers see the same pending job');

    const outcomeA = await jobs.runOne(batchA[0], 0);
    const outcomeB = await jobs.runOne(batchB[0], 0);

    assert.equal(ran, 1, 'the handler must run once, or the subscription bills twice for one period');
    assert.deepEqual([outcomeA, outcomeB].sort(), ['ok', 'skipped']);
    assert.equal(db.count(`SELECT COUNT(*) FROM jobs WHERE status = 'done'`), 1);
    db.close();
  });

  test('a job already running is never picked up a second time', async () => {
    const { db, jobs } = queue();
    let ran = 0;
    jobs.handle('slow', async () => { ran += 1; });
    jobs.enqueue('org_1', 'slow', {}, 0);
    const [job] = jobs.due(0);

    db.run(`UPDATE jobs SET status = 'running' WHERE id = ?`, job.id);
    assert.equal(await jobs.runOne(job, 0), 'skipped');
    assert.equal(ran, 0, 'a job another worker holds must not be run');
    db.close();
  });

  test('a claimed job still counts its attempt, so retries terminate', async () => {
    const { db, jobs } = queue();
    jobs.handle('flaky', () => { throw new Error('nope'); });
    jobs.enqueue('org_1', 'flaky', {}, 0, { maxAttempts: 2 });

    const [first] = jobs.due(0);
    assert.equal(await jobs.runOne(first, 0), 'retry');
    assert.equal(db.pluck<number>(`SELECT attempts FROM jobs WHERE id = ?`, first.id), 1);

    const [second] = jobs.due(10_000_000);
    assert.equal(await jobs.runOne(second, 10_000_000), 'failed');
    assert.equal(db.pluck<number>(`SELECT attempts FROM jobs WHERE id = ?`, first.id), 2);
    db.close();
  });

  test('an unhandled job type fails the claim it took, and only that claim', async () => {
    const { db, jobs } = queue();
    jobs.enqueue('org_1', 'nobody.handles.this', {}, 0);
    const [job] = jobs.due(0);
    assert.equal(await jobs.runOne(job, 0), 'failed');
    assert.equal(await jobs.runOne(job, 0), 'skipped', 'a failed job is not pending, so it cannot be re-claimed');
    db.close();
  });
});

/* ------------------------- the clock belongs to an org ------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

async function twoWorkspaces() {
  const app = await createApp({ db: 'memory', seed: false, config: { env: 'test' } });
  const at = Date.now();
  for (const id of ['org_a', 'org_b']) {
    app.db.insert('orgs', { id, name: id, slug: id, created: at, updated: at });
  }
  const ran: string[] = [];
  app.ctx.jobs.handle('probe.mark', (_payload, job) => { ran.push(job.org_id); });
  return { app, ran };
}

const adminOf = (orgId: string): Auth =>
  ({ kind: 'session', orgId, userId: `usr_${orgId}`, role: 'admin', scopes: ['*'], livemode: true });

const offsetOf = (app: App, orgId: string) =>
  app.db.pluck<number>(`SELECT clock_offset FROM orgs WHERE id = ?`, orgId) ?? 0;

describe('the time machine moves one workspace, not the process', () => {
  test('a second org advancing a year leaves the first org\'s clock and jobs alone', async () => {
    const { app, ran } = await twoWorkspaces();
    const start = app.ctx.now();
    app.ctx.jobs.enqueue('org_a', 'probe.mark', {}, start, { runAt: start + 10 * DAY_MS });
    app.ctx.jobs.enqueue('org_b', 'probe.mark', {}, start, { runAt: start + 10 * DAY_MS });

    const advanced = await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 365 }, auth: adminOf('org_b') });
    assert.equal(advanced.status, 200, JSON.stringify(advanced.body).slice(0, 300));

    assert.deepEqual(ran, ['org_b'], 'advancing org_b ran org_a\'s work — a year of renewals nobody asked for');
    assert.equal(
      app.db.pluck<string>(`SELECT status FROM jobs WHERE org_id = 'org_a'`), 'pending',
      'org_a\'s job is still in the future, because org_a\'s clock never moved',
    );

    assert.equal(offsetOf(app, 'org_a'), 0, 'org_a\'s persisted offset was written by org_b\'s request');
    assert.ok(offsetOf(app, 'org_b') >= 364 * DAY_MS, `org_b should carry the year: ${offsetOf(app, 'org_b')}`);

    const seenByA = await app.handle({ method: 'GET', path: '/v1/health', auth: adminOf('org_a') });
    assert.equal(seenByA.body.clock.offset_ms, 0);
    assert.ok(Math.abs(seenByA.body.time - Date.now()) < 60_000, 'org_a still reads real time');

    const seenByB = await app.handle({ method: 'GET', path: '/v1/health', auth: adminOf('org_b') });
    assert.ok(seenByB.body.time - seenByA.body.time >= 364 * DAY_MS, 'org_b keeps the year it travelled');
    app.close();
  });

  test('each workspace then advances from its own clock, not from the other\'s', async () => {
    const { app, ran } = await twoWorkspaces();
    const start = app.ctx.now();
    app.ctx.jobs.enqueue('org_a', 'probe.mark', {}, start, { runAt: start + 10 * DAY_MS });
    app.ctx.jobs.enqueue('org_b', 'probe.mark', {}, start, { runAt: start + 10 * DAY_MS });

    await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 365 }, auth: adminOf('org_b') });
    const movedA = await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 20 }, auth: adminOf('org_a') });

    assert.equal(movedA.status, 200);
    assert.ok(movedA.body.offset_ms < 21 * DAY_MS, `org_a advanced 20 days, not ${movedA.body.offset_ms / DAY_MS}`);
    assert.deepEqual(ran, ['org_b', 'org_a'], 'each org ran its own work, when its own clock reached it');
    assert.ok(offsetOf(app, 'org_b') >= 364 * DAY_MS, 'org_a\'s smaller jump rewound org_b');
    app.close();
  });

  test('draining on demand is scoped the same way the clock is', async () => {
    const { app, ran } = await twoWorkspaces();
    const start = app.ctx.now();
    app.ctx.jobs.enqueue('org_a', 'probe.mark', {}, start, { runAt: start - 1 });
    app.ctx.jobs.enqueue('org_b', 'probe.mark', {}, start, { runAt: start - 1 });

    const drained = await app.handle({ method: 'POST', path: '/v1/jobs/drain', auth: adminOf('org_b') });
    assert.equal(drained.status, 200, JSON.stringify(drained.body).slice(0, 200));
    assert.deepEqual(ran, ['org_b'], 'one org\'s drain ran another org\'s jobs');
    assert.equal(drained.body.ran, 1);
    assert.equal(drained.body.pending, 0, 'the count beside the drain is this workspace\'s, not the process\'s');
    app.close();
  });

  test('app.travel still runs the default workspace forward, and only it', async () => {
    const { app, ran } = await twoWorkspaces();
    const at = Date.now();
    app.db.insert('orgs', { id: 'org_demo', name: 'demo', slug: 'demo', created: at, updated: at });
    const start = app.ctx.now();
    app.ctx.jobs.enqueue('org_demo', 'probe.mark', {}, start, { runAt: start + 3 * DAY_MS });
    app.ctx.jobs.enqueue('org_b', 'probe.mark', {}, start, { runAt: start + 3 * DAY_MS });

    const travelled = await app.travel(10 * DAY_MS);
    assert.equal(travelled.ran, 1);
    assert.deepEqual(ran, ['org_demo'], 'the harness clock is the default org\'s, so only its queue is due');
    assert.ok(travelled.now - start >= 10 * DAY_MS - 1000);
    assert.equal(app.db.pluck<string>(`SELECT status FROM jobs WHERE org_id = 'org_b'`), 'pending');
    app.close();
  });
});

/* --------------- a dead connection is an error, not a crash -------------- */

type FetchFn = typeof globalThis.fetch;
const realFetch = globalThis.fetch;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_stub' } });

async function withFetch<T>(stub: FetchFn, fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

describe('the API client turns a dead connection into an error a panel can render', () => {
  test('an offline fetch surfaces an ApiClientError, not the raw TypeError that blanks the app', async () => {
    const failed = await withFetch(
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => request('/v1/invoices').then(() => null, (e: unknown) => e),
    );

    // Every panel reads `.body.message` off what useQuery hands it. A TypeError
    // has no `.body`, which is what replaced the whole screen with the error
    // boundary instead of one panel with a retry.
    assert.ok(failed instanceof ApiClientError, `network failure escaped as ${(failed as Error)?.name}`);
    assert.equal((failed as ApiClientError).status, 0);
    assert.equal(typeof (failed as ApiClientError).body.message, 'string');
    assert.ok((failed as ApiClientError).body.message.length > 20, 'the message has to say what happened');
    assert.equal((failed as ApiClientError).code, 'network_error');
    assert.equal(currentNetworkFailure()?.path, '/v1/invoices');
  });

  test('a connection that dies while the body is read fails the same way', async () => {
    const truncated = new Response(null, { status: 200 });
    Object.defineProperty(truncated, 'text', { value: () => Promise.reject(new TypeError('network error')) });
    const failed = await withFetch(
      () => Promise.resolve(truncated),
      () => request('/v1/invoices').then(() => null, (e: unknown) => e),
    );
    assert.ok(failed instanceof ApiClientError, 'a half-delivered response is the same class of failure');
    assert.equal((failed as ApiClientError).status, 0);
  });

  test('a body that cannot be serialised is our bug, not an outage', async () => {
    // Clear whatever an earlier failure left behind: this asserts that the
    // serialisation error raises no outage of its own.
    await withFetch(() => Promise.resolve(jsonResponse({ object: 'health' })), () => request('/v1/health'));
    assert.equal(currentNetworkFailure(), null);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const failed = await withFetch(
      () => Promise.resolve(jsonResponse({ ok: true })),
      () => request('/v1/records/company', { method: 'POST', body: circular }).then(() => null, (e: unknown) => e),
    );
    assert.ok(failed instanceof ApiClientError, 'the one error shape holds for every rejection but an abort');
    assert.equal((failed as ApiClientError).code, 'unexpected_error');
    assert.equal(currentNetworkFailure(), null, 'telling the operator they are offline would send them chasing the network');
  });

  test('a cancelled request stays a cancel — it is not a failure to report', async () => {
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    const failed = await withFetch(
      () => Promise.reject(abort),
      () => request('/v1/invoices').then(() => null, (e: unknown) => e),
    );
    assert.equal(failed, abort, 'converting an abort would make every keystroke in search look like an outage');
    assert.equal(failed instanceof ApiClientError, false);
  });

  test('a server that answers at all clears the offline state, even with a 500', async () => {
    await withFetch(
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => request('/v1/invoices').catch(() => null),
    );
    assert.ok(currentNetworkFailure(), 'precondition: the client believes it is offline');

    const failed = await withFetch(
      () => Promise.resolve(jsonResponse({ error: { type: 'api_error', code: 'internal_error', message: 'Boom.' } }, 500)),
      () => request('/v1/invoices').then(() => null, (e: unknown) => e),
    );
    assert.ok(failed instanceof ApiClientError);
    assert.equal((failed as ApiClientError).status, 500, 'a real HTTP error must keep its status and body');
    assert.equal((failed as ApiClientError).body.message, 'Boom.');
    assert.equal(currentNetworkFailure(), null, 'a 500 proves the server is reachable');
  });

  test('the 401 and 429 paths beside it still do their own work', async () => {
    const lost = await withFetch(
      () => Promise.resolve(jsonResponse({ error: { type: 'authentication_error', code: 'unauthorized', message: 'This session is no longer valid.' } }, 401)),
      () => request('/v1/invoices').then(() => null, (e: unknown) => e),
    );
    assert.equal((lost as ApiClientError).status, 401);
    assert.equal(currentAuthLoss()?.path, '/v1/invoices');
    assert.equal(currentNetworkFailure(), null, 'a 401 is an answer, not an outage');

    const refused = await withFetch(
      () => Promise.resolve(new Response(JSON.stringify({ error: { type: 'rate_limit_error', code: 'rate_limit', message: 'Too many requests.' } }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' },
      })),
      () => request('/v1/health').then(() => null, (e: unknown) => e),
    );
    assert.equal((refused as ApiClientError).status, 429);
    assert.equal(currentRateLimit()?.retryAfter, 30);

    await withFetch(() => Promise.resolve(jsonResponse({ object: 'health' })), () => request('/v1/invoices'));
    assert.equal(currentAuthLoss(), null, 'one call getting through is what clears it');
  });
});

/* ------- what one workspace's clock may reach outside that workspace ------ */

/**
 * The clock became per workspace. Everything the request path measures with it
 * therefore has to be asked again: a per-tenant clock is a number a tenant sets,
 * and any process-wide structure keyed off it is now a lever one tenant holds
 * over another. These are the three that were.
 */
describe('a tenant-settable clock reaches no further than that tenant', () => {
  test('one workspace advancing does not delete another workspace\'s idempotency keys', async () => {
    const { app } = await twoWorkspaces();

    // org_a makes a charge-shaped POST under an idempotency key. Everything it
    // guarantees rests on that row still being there when the client retries.
    const first = await app.handle({
      method: 'POST', path: '/v1/jobs/drain', body: {},
      headers: { 'idempotency-key': 'key_a_1' }, auth: adminOf('org_a'),
    });
    assert.equal(first.status, 200);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM idempotency_keys WHERE org_id = 'org_a'`), 1);

    // org_b runs its own time machine and then makes any request at all.
    await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 2 }, auth: adminOf('org_b') });
    await app.handle({
      method: 'POST', path: '/v1/jobs/drain', body: {},
      headers: { 'idempotency-key': 'key_b_1' }, auth: adminOf('org_b'),
    });

    assert.equal(
      app.db.count(`SELECT COUNT(*) FROM idempotency_keys WHERE org_id = 'org_a'`), 1,
      'org_b\'s clock swept org_a\'s live keys, so org_a\'s next retry re-runs the charge',
    );

    const replay = await app.handle({
      method: 'POST', path: '/v1/jobs/drain', body: {},
      headers: { 'idempotency-key': 'key_a_1' }, auth: adminOf('org_a'),
    });
    assert.equal(replay.headers['idempotent-replayed'], 'true', 'the retry executed again instead of replaying');
    app.close();
  });

  test('a workspace that travels does not spend another workspace\'s rate budget', async () => {
    const { app } = await twoWorkspaces();
    // One person, two workspaces — the buckets are keyed by who is calling.
    const consultant = (orgId: string): Auth =>
      ({ kind: 'session', orgId, userId: 'usr_consultant', role: 'admin', scopes: ['*'], livemode: true });

    assert.equal((await app.handle({ method: 'GET', path: '/v1/health', auth: consultant('org_a') })).status, 200);
    await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 365 }, auth: consultant('org_b') });
    assert.equal((await app.handle({ method: 'GET', path: '/v1/health', auth: consultant('org_b') })).status, 200);

    // Back in org_a, whose clock never moved. Nothing about this is a flood.
    for (let i = 0; i < 3; i++) {
      const res = await app.handle({ method: 'GET', path: '/v1/health', auth: consultant('org_a') });
      assert.equal(res.status, 200, `org_b's year drained org_a's budget: request ${i} answered ${res.status}`);
    }
    app.close();
  });

  test('returning a workspace clock to real time does not lock its operator out', async () => {
    const { app } = await twoWorkspaces();
    assert.equal((await app.handle({ method: 'GET', path: '/v1/health', auth: adminOf('org_a') })).status, 200);
    await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 30 }, auth: adminOf('org_a') });
    assert.equal((await app.handle({ method: 'POST', path: '/v1/time/reset', auth: adminOf('org_a') })).status, 200);

    // The clock went backwards, which a token bucket cannot survive unless the
    // budget is measured on time no route can move.
    for (let i = 0; i < 3; i++) {
      const res = await app.handle({ method: 'GET', path: '/v1/health', auth: adminOf('org_a') });
      assert.equal(res.status, 200, `the time machine's own reset button refused request ${i} with ${res.status}`);
    }
    app.close();
  });
});

/* ------------- a credential that asked for less than everything ---------- */

describe('a restricted API key is restricted', () => {
  test('a key minted with narrow scopes cannot use the authority its scopes exclude', async () => {
    const app = await createApp({ db: 'memory', seed: true, config: { env: 'test' } });
    const orgId = app.ctx.config.defaultOrgId;
    const owner: Auth = { kind: 'session', orgId, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };

    const minted = await app.handle({
      method: 'POST', path: '/v1/api-keys',
      body: { name: 'Read-only reporting key', livemode: false, scopes: ['crm:read', 'billing:read'] },
      auth: owner,
    });
    assert.equal(minted.status, 201);
    const headers = { authorization: `Bearer ${minted.body.secret}` };

    // Reading is what the key was made for and must keep working.
    const read = await app.handle({ method: 'GET', path: '/v1/records/company', headers });
    assert.equal(read.status, 200, 'a restricted key still has the read surface it was issued for');

    // `route.meta.scopes` is the only reader of `auth.scopes`, and nothing
    // declares it — so the ladder is what has to hold the line.
    const me = await app.handle({ method: 'GET', path: '/v1/me', headers });
    assert.equal(me.body.role, 'readonly', 'a key that asked for two read scopes authenticated as a full admin');

    const travelled = await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 1 }, headers });
    assert.equal(travelled.status, 403, 'a reporting key moved the whole workspace\'s clock');

    const revoked = await app.handle({ method: 'DELETE', path: '/v1/api-keys/ak_seed_demo', headers });
    assert.equal(revoked.status, 403, 'a reporting key revoked the workspace\'s other credentials');

    const company = app.db.get<{ display_name: string }>(
      `SELECT display_name FROM crm_records WHERE org_id = ? AND object_type = 'company' LIMIT 1`, orgId)!;
    const wrote = await app.handle({
      method: 'POST', path: '/v1/ai/complete',
      body: { prompt: `Add a note to ${company.display_name} saying the shipment cleared customs`, allow_writes: true, approvals: ['add_note'] },
      headers,
    });
    assert.equal(wrote.status, 403, 'the agent write gate reads the role, and every key was handed `admin`');
    app.close();
  });
});

/* --------- an answer that is not the API's is an error, not a crash ------- */

describe('the client refuses a 200 that did not come from the API', () => {
  test('an HTML page served with status 200 is an ApiClientError, not a string handed to a panel', async () => {
    const page = '<!doctype html><title>Sign in to the corporate proxy</title>';
    const failed = await withFetch(
      () => Promise.resolve(new Response(page, { status: 200, headers: { 'content-type': 'text/html' } })),
      () => request('/v1/invoices').then((data) => data, (e: unknown) => e),
    );

    // Handing the string through is the same blank screen as the raw TypeError:
    // every list panel does `data.data.map(…)` on what it gets back.
    assert.ok(failed instanceof ApiClientError, `an unparseable 200 resolved as ${typeof failed}`);
    assert.equal((failed as ApiClientError).status, 200);
    assert.equal((failed as ApiClientError).code, 'invalid_response');
    assert.equal(currentNetworkFailure(), null, 'the server answered, so this is not an outage');
  });

  test('the answers that legitimately are not objects still get through', async () => {
    // `GET /v1/invoices/:id/render` answers with the page as a JSON string.
    const rendered = await withFetch(
      () => Promise.resolve(jsonResponse('<html>an invoice</html>')),
      () => request<string>('/v1/invoices/in_1/render'),
    );
    assert.equal(rendered, '<html>an invoice</html>');

    const empty = await withFetch(
      () => Promise.resolve(new Response(null, { status: 204 })),
      () => request('/v1/records/cmp_1'),
    );
    assert.equal(empty, null, 'a 204 has no body and must not be read as a broken answer');
  });

  test('an error body that is not JSON still reports the server\'s own text', async () => {
    const failed = await withFetch(
      () => Promise.resolve(new Response('502 Bad Gateway', { status: 502 })),
      () => request('/v1/invoices').then(() => null, (e: unknown) => e),
    );
    assert.equal((failed as ApiClientError).status, 502);
    assert.equal((failed as ApiClientError).body.message, '502 Bad Gateway');
  });
});

/* ------------- the ticker that is the only thing running in prod --------- */

describe('the background ticker serves every workspace, each on its own clock', () => {
  test('a deployed server runs every tenant\'s due work, not just the default one\'s', async () => {
    const { app, ran } = await twoWorkspaces();
    const at = Date.now();
    app.db.insert('orgs', { id: 'org_demo', name: 'demo', slug: 'demo', created: at, updated: at });
    const start = app.ctx.now();
    for (const org of ['org_demo', 'org_a', 'org_b']) {
      app.ctx.jobs.enqueue(org, 'probe.mark', {}, start, { runAt: start - 1 });
    }

    // `main.ts` calls exactly this, once a second, and nothing else drains.
    const ticked = await app.tick();

    assert.deepEqual(
      [...ran].sort(), ['org_a', 'org_b', 'org_demo'],
      'the only thing that runs durable work served one workspace: every other tenant\'s renewals, dunning and credit expiry never fire',
    );
    assert.equal(ticked.ran, 3);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM jobs WHERE status = 'pending'`), 0);
    app.close();
  });

  test('and still refuses to run a workspace\'s future work early', async () => {
    const { app, ran } = await twoWorkspaces();
    const start = app.ctx.now();
    // Both workspaces have work ten days out. Only org_b travels a year.
    app.ctx.jobs.enqueue('org_a', 'probe.mark', {}, start, { runAt: start + 10 * DAY_MS });
    app.ctx.jobs.enqueue('org_b', 'probe.mark', {}, start, { runAt: start + 10 * DAY_MS });
    await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 365 }, auth: adminOf('org_b') });
    ran.length = 0; // org_b's own advance already ran its job; the ticker is what is under test

    app.ctx.jobs.enqueue('org_b', 'probe.mark', {}, start, { runAt: start + 200 * DAY_MS });
    await app.tick();

    assert.deepEqual(ran, ['org_b'], 'the ticker ran a workspace\'s work against another workspace\'s clock');
    assert.equal(
      app.db.pluck<string>(`SELECT status FROM jobs WHERE org_id = 'org_a'`), 'pending',
      'org_a\'s clock never moved, so org_a has nothing due',
    );
    app.close();
  });
});

/* ------------ the housekeeping job that runs on a tenant's clock --------- */

/**
 * `core.cleanup` is the sibling of the idempotency sweep above, one layer down:
 * the same three-way delete, driven by the same per-workspace clock, but reached
 * from a job rather than from the request path. Fixing the sweep in `app.ts` and
 * leaving this one is exactly the shape of miss this wave exists for — and the
 * ticker now runs every tenant's jobs, so this handler reaches production on
 * every workspace rather than only on the default one.
 */
describe('housekeeping cleans up after its own workspace and no other', () => {
  async function withCleanup() {
    const { app } = await twoWorkspaces();
    const at = Date.now();
    app.db.insert('orgs', { id: 'org_demo', name: 'demo', slug: 'demo', created: at, updated: at });
    app.db.insert('users', { id: 'usr_a', email: 'a@northwind.io', name: 'A', created: at, updated: at });
    return { app, at };
  }

  test('one workspace\'s cleanup does not delete another workspace\'s sessions, keys or history', async () => {
    const { app } = await withCleanup();
    const now = app.ctx.now();

    // Everything org_a owns is live: a sign-in with weeks left, a completed
    // idempotency key its client may still retry against, and its job history.
    app.db.insert('sessions', {
      id: 'session_a', org_id: 'org_a', user_id: 'usr_a', token_hash: 'hash_a',
      expires: Date.now() + 30 * DAY_MS, created: Date.now(),
    });
    app.db.insert('idempotency_keys', {
      key: 'k_a', org_id: 'org_a', method: 'POST', path: '/v1/invoices/in_1/pay', request_hash: 'h',
      state: 'complete', status: 200, response: '{}', created: now, expires: now + 30 * DAY_MS,
    });
    app.db.insert('jobs', {
      id: 'job_a_done', org_id: 'org_a', type: 'probe.mark', payload: '{}', run_at: now, attempts: 1,
      max_attempts: 8, status: 'done', last_error: null, idem_key: null, created: now, updated: now,
    });

    // org_b runs its own housekeeping, sixty days into its own future.
    app.ctx.jobs.enqueue('org_b', 'core.cleanup', {}, now, { runAt: now });
    const advanced = await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 60 }, auth: adminOf('org_b') });
    assert.equal(advanced.status, 200, JSON.stringify(advanced.body).slice(0, 200));
    // `core.cleanup` re-books itself a day out, and the advance replays the
    // queue chronologically, so sixty days of business time is sixty runs — one
    // per day org_b actually lived through, every one of them on org_b's clock.
    assert.ok(advanced.body.jobs_run >= 1, 'precondition: org_b\'s cleanup actually ran');

    assert.equal(
      app.db.count(`SELECT COUNT(*) FROM sessions WHERE org_id = 'org_a'`), 1,
      'org_b\'s clock signed org_a\'s people out of their workspace',
    );
    assert.equal(
      app.db.count(`SELECT COUNT(*) FROM idempotency_keys WHERE org_id = 'org_a'`), 1,
      'org_b\'s clock swept org_a\'s live keys, so org_a\'s next retry re-runs the charge it already made',
    );
    assert.equal(
      app.db.count(`SELECT COUNT(*) FROM jobs WHERE org_id = 'org_a' AND status = 'done'`), 1,
      'org_b\'s clock deleted org_a\'s job history',
    );
    app.close();
  });

  test('and the recurring job stays in the workspace it was running for', async () => {
    const { app } = await withCleanup();
    const now = app.ctx.now();
    app.ctx.jobs.enqueue('org_b', 'core.cleanup', {}, now, { runAt: now });
    await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 60 }, auth: adminOf('org_b') });

    const pending = app.db.all<{ org_id: string }>(
      `SELECT org_id FROM jobs WHERE type = 'core.cleanup' AND status = 'pending'`);
    assert.deepEqual(
      pending.map((r) => r.org_id), ['org_b'],
      'the recurring cleanup emigrated to the default workspace: org_b never cleans up again, '
      + 'and the default org\'s next run was scheduled on a clock that is not its own',
    );
    app.close();
  });

  test('it still does the job it is for, on its own workspace', async () => {
    const { app } = await withCleanup();
    const now = app.ctx.now();
    app.db.insert('sessions', {
      id: 'session_b_dead', org_id: 'org_b', user_id: 'usr_a', token_hash: 'hash_dead',
      expires: Date.now() - 1, created: Date.now() - 31 * DAY_MS,
    });
    app.db.insert('sessions', {
      id: 'session_b_live', org_id: 'org_b', user_id: 'usr_a', token_hash: 'hash_live',
      expires: Date.now() + DAY_MS, created: Date.now(),
    });
    app.db.insert('idempotency_keys', {
      key: 'k_b_old', org_id: 'org_b', method: 'POST', path: '/x', request_hash: 'h',
      state: 'complete', created: now - 2 * DAY_MS, expires: now - DAY_MS,
    });
    app.db.insert('jobs', {
      id: 'job_b_old', org_id: 'org_b', type: 'probe.mark', payload: '{}', run_at: now, attempts: 1,
      max_attempts: 8, status: 'done', last_error: null, idem_key: null, created: now, updated: now,
    });

    app.ctx.jobs.enqueue('org_b', 'core.cleanup', {}, now, { runAt: now });
    await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 60 }, auth: adminOf('org_b') });

    assert.deepEqual(
      app.db.all<{ id: string }>(`SELECT id FROM sessions WHERE org_id = 'org_b'`).map((r) => r.id),
      ['session_b_live'],
      'scoping the sweep must not stop it sweeping: the expired session is still collected, the live one kept',
    );
    assert.equal(app.db.count(`SELECT COUNT(*) FROM idempotency_keys WHERE org_id = 'org_b' AND key = 'k_b_old'`), 0);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM jobs WHERE id = 'job_b_old'`), 0);
    app.close();
  });
});

/* ------------- the clock the operator moves cannot sign them out --------- */

/**
 * The sign-flipped case of the rate limiter: another process-wide budget read
 * off a number the tenant sets. A session is a credential with a real-world
 * lifetime — thirty days of someone being away from their desk — and the cookie
 * the browser holds has always been given a real-seconds `Max-Age`. Reading its
 * expiry off business time meant the platform's headline feature ejected the
 * operator who used it, which the client had already been forced to build an
 * `aftermath` report around instead of the server refusing to do it.
 */
describe('the time machine cannot sign out the operator who runs it', () => {
  test('a year of replay leaves the session that authorised it working', async () => {
    const app = await createApp({ db: 'memory', seed: true, config: { env: 'test' } });
    const login = await app.handle({
      method: 'POST', path: '/v1/auth/login', body: { email: 'dana@northwind.io', password: 'demo1234' },
    });
    assert.equal(login.status, 200);
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers })).status, 200);

    const advanced = await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 365 }, headers });
    assert.equal(advanced.status, 200, JSON.stringify(advanced.body).slice(0, 200));
    assert.ok(advanced.body.jobs_run > 0, 'precondition: a year of the business actually replayed');

    const after = await app.handle({ method: 'GET', path: '/v1/me', headers });
    assert.equal(
      after.status, 200,
      'advancing the workspace clock past the session\'s own expiry logged the operator out of the workspace',
    );
    assert.equal(after.body.user.email, 'dana@northwind.io');
    app.close();
  });

  test('a session that really has run out is still refused', async () => {
    const app = await createApp({ db: 'memory', seed: true, config: { env: 'test' } });
    const login = await app.handle({ method: 'POST', path: '/v1/auth/demo' });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers })).status, 200);

    // Thirty real days later, with the workspace clock never having moved.
    app.db.run(`UPDATE sessions SET expires = ?`, Date.now() - 1);
    const after = await app.handle({ method: 'GET', path: '/v1/me', headers });
    assert.equal(after.status, 401, 'an expired session must still be an expired session');
    app.close();
  });

  test('and a session minted mid-replay lasts thirty real days, not thirty business ones', async () => {
    const app = await createApp({ db: 'memory', seed: true, config: { env: 'test' } });
    const first = await app.handle({ method: 'POST', path: '/v1/auth/demo' });
    const headers = { cookie: String(first.headers['set-cookie']).split(';')[0] };
    await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 365 }, headers });

    const minted = await app.handle({ method: 'POST', path: '/v1/auth/demo' });
    assert.equal(minted.status, 200);
    const life = minted.body.expires - Date.now();
    assert.ok(
      life > 29 * DAY_MS && life < 31 * DAY_MS,
      `a sign-in during a replay is good for ${Math.round(life / DAY_MS)} real days, not 30 — `
      + 'the credential outlives its budget by however far the workspace happened to have travelled',
    );
    app.close();
  });
});

/* --------- the same bucket, one layer in: the AI tool rate limiter ------- */

/**
 * `app.ts` measures its request budget on real minutes because a workspace
 * clock is a number a route can set. The AI runtime holds the identical
 * structure for tool calls, keyed by org and fed by `call.ctx.now()` — the same
 * settable clock — so returning a workspace to real time emptied it by the
 * whole distance travelled and every tool call in that workspace answered
 * `rate_limited` from then on. The copilot reports that as "I could not match
 * anything in Northwind Robotics to that question", which reads as the engine
 * being unable to see the workspace's data at all.
 */
describe('a workspace\'s tool budget is refilled by time, never emptied by it', () => {
  const probeTool: AiToolDef = {
    name: 'probe_read', description: 'A read-only probe.', input: v.object({}), readOnly: true,
    run: () => ({ ok: true }),
  };

  async function runtimeApp() {
    const app = await createApp({ db: 'memory', seed: false, config: { env: 'test' } });
    const at = Date.now();
    for (const id of ['org_demo', 'org_a']) {
      app.db.insert('orgs', { id, name: id, slug: id, created: at, updated: at });
    }
    const call = (budget?: { callsPerMinute?: number; steps?: number }) => {
      const context: AiCallContext = {
        ctx: app.ctx, orgId: 'org_a', feature: 'copilot', actorType: 'user', ...(budget ? { budget } : {}),
      };
      return runInOrgScope({ orgId: 'org_a' }, () => aiRuntime(app.ctx).execute('probe_read', {}, context, probeTool));
    };
    return { app, call };
  }

  test('a workspace that returns its clock to real time can still use its own tools', async () => {
    const { app, call } = await runtimeApp();
    assert.equal((await call()).ok, true, 'precondition: the tool runs at all');

    await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 30 }, auth: adminOf('org_a') });
    assert.equal((await call()).ok, true, 'a month of replay is not a flood of tool calls');

    await app.handle({ method: 'POST', path: '/v1/time/reset', auth: adminOf('org_a') });
    for (let i = 0; i < 3; i++) {
      const execution = await call();
      assert.equal(
        execution.ok, true,
        `after the time machine's own reset button, tool call ${i} came back ${execution.error?.code}: `
        + 'every agent and every copilot answer in this workspace is refused from here on',
      );
    }
    app.close();
  });

  test('and a workspace that really does flood its tools is still refused', async () => {
    const { app, call } = await runtimeApp();
    const budget = { callsPerMinute: 2, steps: 50 };
    assert.equal((await call(budget)).ok, true);
    assert.equal((await call(budget)).ok, true);
    const third = await call(budget);
    assert.equal(third.ok, false, 'clamping the refill must not disarm the limiter');
    assert.equal(third.error?.code, 'rate_limited');
    app.close();
  });
});

/* ------- the other end of the ladder a restricted key authenticates on --- */

/**
 * The mirror image of the escalation fixed above. Handing every API key `admin`
 * let a key minted `["crm:read"]` move the workspace clock; handing every
 * restricted key `readonly` then closed the door the other way, on the surface
 * customers actually integrate against — every mutating route in the platform
 * is gated at `member`, so a key minted `["metering:write"]` was refused the
 * telemetry ingest this product is priced on. A credential must get what it
 * asked for: no more, and no less either.
 */
describe('a write-scoped API key can write, and only that', () => {
  async function keyed(scopes: string[]) {
    const app = await createApp({ db: 'memory', seed: true, config: { env: 'test' } });
    const orgId = app.ctx.config.defaultOrgId;
    const owner: Auth = { kind: 'session', orgId, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
    const minted = await app.handle({
      method: 'POST', path: '/v1/api-keys', body: { name: `Key ${scopes.join()}`, livemode: false, scopes }, auth: owner,
    });
    assert.equal(minted.status, 201);
    return { app, headers: { authorization: `Bearer ${minted.body.secret}` } };
  }

  test('a key minted to write records writes records', async () => {
    const { app, headers } = await keyed(['crm:write']);
    const wrote = await app.handle({
      method: 'POST', path: '/v1/records/company',
      body: { properties: { name: 'Halden Steelworks' } }, headers,
    });
    assert.equal(
      wrote.status, 201,
      `an integration key issued for CRM writes was refused with ${JSON.stringify(wrote.body?.error?.message)}`,
    );
    app.close();
  });

  test('a key minted to record usage reaches the meter, which is what it is priced on', async () => {
    const { app, headers } = await keyed(['metering:write']);
    const posted = await app.handle({
      method: 'POST', path: '/v1/meter-events',
      body: { event_name: 'telemetry_events', payload: { customer_id: 'cus_missing', value: 1 } }, headers,
    });
    // Whatever the meter makes of the payload, the answer must come from the
    // meter and not from the role ladder in front of it.
    assert.notEqual(posted.status, 403, 'the telemetry ingest path was closed to the keys that use it');
    assert.notEqual(posted.status, 401);
    app.close();
  });

  test('but it still cannot do the things no scope it holds names', async () => {
    const { app, headers } = await keyed(['crm:write']);
    assert.equal(
      (await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 1 }, headers })).status, 403,
      'a CRM integration key moved the whole workspace\'s clock',
    );
    assert.equal(
      (await app.handle({ method: 'DELETE', path: '/v1/api-keys/ak_seed_demo', headers })).status, 403,
      'a CRM integration key revoked the workspace\'s other credentials',
    );
    app.close();
  });

  test('and a read-only key is still read-only', async () => {
    const { app, headers } = await keyed(['crm:read', 'billing:read']);
    assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers })).body.role, 'readonly');
    assert.equal((await app.handle({
      method: 'POST', path: '/v1/records/company', body: { properties: { name: 'Nope Ltd' } }, headers,
    })).status, 403, 'a key that asked only to read wrote a record');
    app.close();
  });
});

/* ------- the time machine replays; it does not fast-forward past ---------- */

describe('POST /v1/time/advance replays the queue chronologically', () => {
  /**
   * `app.travel` — the harness every other suite drives — steps the clock to
   * each job's own `run_at` before draining it. The route an operator actually
   * presses used to jump the clock to the target first and drain once, so the
   * two entry points to the same operation disagreed about a year of business.
   */
  async function oneWorkspace() {
    const app = await createApp({ db: 'memory', seed: false, config: { env: 'test' } });
    const at = Date.now();
    app.db.insert('orgs', { id: 'org_a', name: 'a', slug: 'a', created: at, updated: at });
    return app;
  }

  test('a job that books its own next attempt is replayed to the end, not parked past the target', async () => {
    const app = await oneWorkspace();
    const ranAt: number[] = [];
    // Exactly the shape of `payments.dunning_retry`: it runs, then schedules
    // the next attempt a few days out, measured from `ctx.now()`.
    app.ctx.jobs.handle('probe.retry', (payload: { left: number }, job) => {
      ranAt.push(app.ctx.now());
      if (payload.left > 1) {
        app.ctx.enqueue(job.org_id, 'probe.retry', { left: payload.left - 1 }, { runAt: app.ctx.now() + 3 * DAY_MS });
      }
    });
    const start = app.ctx.now();
    app.ctx.jobs.enqueue('org_a', 'probe.retry', { left: 4 }, start, { runAt: start + DAY_MS });

    const advanced = await app.handle({
      method: 'POST', path: '/v1/time/advance', body: { days: 365 }, auth: adminOf('org_a'),
    });
    assert.equal(advanced.status, 200, JSON.stringify(advanced.body).slice(0, 300));

    assert.equal(ranAt.length, 4, `a 365-day advance ran ${ranAt.length} of 4 attempts and parked the rest in the future`);
    assert.equal(advanced.body.jobs_run, 4, 'the advance reported work it had not actually run');
    assert.equal(
      app.db.count(`SELECT COUNT(*) FROM jobs WHERE org_id = 'org_a' AND status = 'pending'`), 0,
      'a retry chain that fits inside the jump was left pending on the other side of it',
    );
    app.close();
  });

  test('each job runs at its own due time, not at the far end of the jump', async () => {
    const app = await oneWorkspace();
    const seen: { due: number; at: number }[] = [];
    app.ctx.jobs.handle('probe.when', (payload: { due: number }) => {
      seen.push({ due: payload.due, at: app.ctx.now() });
    });
    const start = app.ctx.now();
    for (const day of [1, 30, 200]) {
      const due = start + day * DAY_MS;
      app.ctx.jobs.enqueue('org_a', 'probe.when', { due }, start, { runAt: due });
    }

    assert.equal((await app.handle({
      method: 'POST', path: '/v1/time/advance', body: { days: 365 }, auth: adminOf('org_a'),
    })).status, 200);

    assert.equal(seen.length, 3);
    for (const { due, at } of seen) {
      assert.ok(
        Math.abs(at - due) < DAY_MS,
        `a job due on day ${Math.round((due - start) / DAY_MS)} read the clock as day ${Math.round((at - start) / DAY_MS)}`,
      );
    }
    // The clock still lands where the caller asked — read off org_a's own
    // offset, because outside a request `ctx.now()` answers for the default
    // workspace, not for the one that travelled.
    assert.ok(offsetOf(app, 'org_a') >= 364 * DAY_MS, `the advance finished at ${offsetOf(app, 'org_a') / DAY_MS} days, not 365`);
    app.close();
  });

  test('what is due next is asked of the caller\'s workspace alone', async () => {
    const app = await oneWorkspace();
    const at = Date.now();
    app.db.insert('orgs', { id: 'org_b', name: 'b', slug: 'b', created: at, updated: at });
    const ran: string[] = [];
    app.ctx.jobs.handle('probe.mark', (_p, job) => { ran.push(job.org_id); });
    const start = app.ctx.now();
    // org_b's work sits inside org_a's jump. It must neither run nor steer
    // where org_a's clock stops on the way.
    app.ctx.jobs.enqueue('org_b', 'probe.mark', {}, start, { runAt: start + 5 * DAY_MS });
    app.ctx.jobs.enqueue('org_a', 'probe.mark', {}, start, { runAt: start + 40 * DAY_MS });

    assert.equal((await app.handle({
      method: 'POST', path: '/v1/time/advance', body: { days: 90 }, auth: adminOf('org_a'),
    })).status, 200);

    assert.deepEqual(ran, ['org_a'], 'org_a\'s advance ran org_b\'s work');
    assert.equal(app.db.pluck<string>(`SELECT status FROM jobs WHERE org_id = 'org_b'`), 'pending');
    assert.equal(offsetOf(app, 'org_b'), 0, 'org_a\'s replay wrote org_b\'s clock');
    app.close();
  });
});

/* --------- the membership is the identity, and the role is the authority --- */

/**
 * The other half of the question the AI surface already answers.
 *
 * `actorFor` resolves a caller who is no longer a member of the workspace to
 * `null` — "not a live member", so nothing they write can be attributed to
 * them. `authenticate` was answering the same question with `(member?.role) ||
 * 'member'`, so a removed teammate's still-live cookie came back as a *member*
 * of the workspace they had just been removed from. That is not a stale
 * session, it is a promotion: `member` is exactly the rung
 * `POST /v1/ai/approvals/:id` is gated at and the rung the copilot's
 * `allow_writes` gate reads, so an analyst refused a write one minute was
 * granted it the minute they were removed.
 *
 * `POST /v1/auth/login` already refuses an account that belongs to no
 * workspace. The check existed where the credential is minted and was missing
 * where it is used.
 */
describe('a session is only a session while the membership behind it exists', () => {
  async function signedIn(email: string) {
    const app = await createApp({ db: 'memory', seed: true, config: { env: 'test' } });
    const login = await app.handle({ method: 'POST', path: '/v1/auth/login', body: { email, password: 'demo1234' } });
    assert.equal(login.status, 200, `precondition: ${email} could not sign in`);
    return { app, headers: { cookie: String(login.headers['set-cookie']).split(';')[0] } };
  }

  const ownerOf = (orgId: string): Auth =>
    ({ kind: 'session', orgId, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true });

  const notes = (app: App, orgId: string) =>
    app.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'note'`, orgId);

  test('a removed teammate is not promoted to member by their own removal', async () => {
    // Nina is an analyst: under the member bar, and refused a copilot write.
    const { app, headers } = await signedIn('nina@northwind.io');
    const orgId = app.ctx.config.defaultOrgId;
    assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers })).body.role, 'analyst');

    const company = app.db.get<{ display_name: string }>(
      `SELECT display_name FROM crm_records WHERE org_id = ? AND object_type = 'company' LIMIT 1`, orgId)!;
    const write = () => app.handle({
      method: 'POST', path: '/v1/ai/complete',
      body: {
        prompt: `Add a note to ${company.display_name} saying "Written by someone who was removed."`,
        allow_writes: true, approvals: ['add_note'],
      },
      headers,
    });
    assert.equal((await write()).status, 403, 'precondition: an analyst may not authorise an agent write');

    // The membership goes and the session stays. `DELETE /v1/users/:id` no
    // longer leaves this behind — it ends the sessions it removes — so the
    // shape is made by hand: it is what any *other* path that drops a
    // membership leaves, and what a request already in flight sees. The door
    // check is defence in depth now rather than the only defence, and defence
    // in depth still has to hold.
    app.db.run(`DELETE FROM memberships WHERE org_id = ? AND user_id = 'usr_seed06'`, orgId);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM memberships WHERE org_id = ? AND user_id = 'usr_seed06'`, orgId), 0);
    assert.equal(
      app.db.count(`SELECT COUNT(*) FROM sessions WHERE org_id = ? AND user_id = 'usr_seed06'`, orgId), 1,
      'precondition: the session outlives the membership, which is the whole point of this test',
    );

    const before = notes(app, orgId);
    const after = await write();
    assert.equal(
      after.status, 401,
      `a teammate removed from the workspace still reached it, as ${JSON.stringify((await app.handle({ method: 'GET', path: '/v1/me', headers })).body?.role)}`,
    );
    assert.equal(notes(app, orgId), before, 'a removed teammate wrote to a customer record through the copilot');

    const me = await app.handle({ method: 'GET', path: '/v1/me', headers });
    assert.equal(me.status, 401, 'the workspace still answered "who am I" for someone who is not in it');
    assert.match(me.body.error.message, /no longer a member/);
    app.close();
  });

  test('every other authority a removed teammate held goes with the membership', async () => {
    const { app, headers } = await signedIn('marcus@northwind.io');
    const orgId = app.ctx.config.defaultOrgId;
    assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers })).body.role, 'admin');
    assert.equal((await app.handle({ method: 'GET', path: '/v1/api-keys', headers })).status, 200);

    await app.handle({ method: 'DELETE', path: '/v1/users/usr_seed02', auth: ownerOf(orgId) });

    for (const probe of [
      { method: 'GET', path: '/v1/api-keys' },
      { method: 'GET', path: '/v1/audit-log' },
      { method: 'POST', path: '/v1/time/advance', body: { days: 1 } },
      { method: 'DELETE', path: '/v1/api-keys/ak_seed_demo' },
      { method: 'GET', path: '/v1/records/company' },
    ]) {
      const res = await app.handle({ ...probe, headers });
      assert.equal(res.status, 401, `${probe.method} ${probe.path} still answered a removed admin with ${res.status}`);
    }
    app.close();
  });

  test('but a teammate who is still a member keeps exactly the role they hold', async () => {
    const { app, headers } = await signedIn('dana@northwind.io');
    const me = await app.handle({ method: 'GET', path: '/v1/me', headers });
    assert.equal(me.status, 200);
    assert.equal(me.body.role, 'owner', 'refusing the removed must not re-grade the present');
    assert.equal((await app.handle({ method: 'GET', path: '/v1/audit-log', headers })).status, 200);

    // The role still comes from the membership row, not from a default.
    app.db.run(`UPDATE memberships SET role = 'readonly' WHERE org_id = ? AND user_id = 'usr_seed01'`, app.ctx.config.defaultOrgId);
    const demoted = await app.handle({ method: 'GET', path: '/v1/me', headers });
    assert.equal(demoted.body.role, 'readonly');
    assert.equal((await app.handle({ method: 'GET', path: '/v1/audit-log', headers })).status, 403, 'a demotion is a demotion');
    app.close();
  });

  test('the public surface still answers, so the dead cookie can be put down', async () => {
    const { app, headers } = await signedIn('nina@northwind.io');
    const orgId = app.ctx.config.defaultOrgId;
    app.db.run(`DELETE FROM memberships WHERE org_id = ? AND user_id = 'usr_seed06'`, orgId);

    const health = await app.handle({ method: 'GET', path: '/v1/health', headers });
    assert.equal(health.status, 200, 'a removed teammate\'s browser could not even ask whether the API was up');

    const out = await app.handle({ method: 'POST', path: '/v1/auth/logout', headers });
    assert.equal(out.status, 200, 'a removed teammate could not sign out, so the cookie stayed in the browser');
    assert.equal(app.db.count(`SELECT COUNT(*) FROM sessions WHERE user_id = 'usr_seed06'`), 0);
    app.close();
  });

  test('and the key that teammate minted goes with them, or removal removes nobody', async () => {
    // The cookie was refused above. This is the other door into the same
    // workspace, and it was answering `role: admin` in the same breath.
    const { app, headers: cookie } = await signedIn('marcus@northwind.io');
    const orgId = app.ctx.config.defaultOrgId;
    const minted = await app.handle({
      method: 'POST', path: '/v1/api-keys', body: { name: 'Marcus back door', scopes: ['*'] }, headers: cookie,
    });
    assert.equal(minted.status, 201);
    const headers = { authorization: `Bearer ${minted.body.secret}` };
    assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers })).body.role, 'admin');

    await app.handle({ method: 'DELETE', path: '/v1/users/usr_seed02', auth: ownerOf(orgId) });

    for (const probe of [
      { method: 'GET', path: '/v1/me' },
      { method: 'GET', path: '/v1/api-keys' },
      { method: 'GET', path: '/v1/audit-log' },
      { method: 'POST', path: '/v1/time/advance', body: { days: 1 } },
      { method: 'DELETE', path: '/v1/api-keys/ak_seed_demo' },
      { method: 'POST', path: '/v1/api-keys', body: { name: 'Replacement', scopes: ['*'] } },
      { method: 'POST', path: '/v1/users', body: { email: 'ghost@northwind.io', name: 'Ghost', role: 'owner' } },
      { method: 'GET', path: '/v1/records/company' },
    ]) {
      const res = await app.handle({ ...probe, headers });
      assert.equal(res.status, 401,
        `${probe.method} ${probe.path} answered a removed admin's key with ${res.status}`);
    }
    assert.equal(app.db.count(`SELECT COUNT(*) FROM memberships WHERE org_id = ? AND role = 'owner'`, orgId), 1,
      'a removed admin seated a second owner through his key');
    app.close();
  });

  test('the seeded integration key dies with Dana, and says why', async () => {
    const app = await createApp({ db: 'memory', seed: true, config: { env: 'test' } });
    const orgId = app.ctx.config.defaultOrgId;
    const headers = { authorization: `Bearer sk_test_${'ain_demo_workspace_key_0001'}` };
    assert.equal((await app.handle({ method: 'GET', path: '/v1/records/company', headers })).status, 200);
    const lastUsed = app.db.pluck<number>(`SELECT last_used FROM api_keys WHERE id = 'ak_seed_demo'`);

    app.db.run(`DELETE FROM memberships WHERE org_id = ? AND user_id = 'usr_seed01'`, orgId);
    const refused = await app.handle({ method: 'GET', path: '/v1/records/company', headers });
    assert.equal(refused.status, 401, 'ak_seed_demo was created by Dana and outlived her membership');
    assert.match(refused.body.error.message, /no longer a member of this workspace/);
    assert.equal(app.db.pluck<number>(`SELECT last_used FROM api_keys WHERE id = 'ak_seed_demo'`), lastUsed,
      'a refused credential kept reporting itself as just used');
    app.close();
  });

  test('a demotion is a demotion at both doors, not only at the cookie', async () => {
    // The sign-flip of removal, and the likelier administrative action: an
    // owner who catches a rogue admin drops their role. The session below
    // already obeys that; the key must not be the way back up.
    const { app, headers: cookie } = await signedIn('marcus@northwind.io');
    const orgId = app.ctx.config.defaultOrgId;
    const minted = await app.handle({
      method: 'POST', path: '/v1/api-keys', body: { name: 'Marcus key', scopes: ['*'] }, headers: cookie,
    });
    const headers = { authorization: `Bearer ${minted.body.secret}` };
    assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers })).body.role, 'admin');

    await app.handle({ method: 'PATCH', path: '/v1/users/usr_seed02', body: { role: 'readonly' }, auth: ownerOf(orgId) });

    assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers })).body.role, 'readonly');
    assert.equal((await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 1 }, headers })).status, 403,
      'a demoted admin moved the workspace clock through the key he still held');
    assert.equal((await app.handle({ method: 'DELETE', path: '/v1/api-keys/ak_seed_demo', headers })).status, 403,
      'a demoted admin revoked the workspace\'s other credentials');
    assert.equal((await app.handle({ method: 'GET', path: '/v1/records/company', headers })).status, 200,
      'the demotion took the escalation, not the read surface');
    app.close();
  });

  test('the bound only ever lowers a key — it is not a promotion to its author', async () => {
    const app = await createApp({ db: 'memory', seed: true, config: { env: 'test' } });
    const orgId = app.ctx.config.defaultOrgId;
    const minted = await app.handle({
      method: 'POST', path: '/v1/api-keys', body: { name: 'Reporting key', scopes: ['crm:read'] }, auth: ownerOf(orgId),
    });
    const headers = { authorization: `Bearer ${minted.body.secret}` };
    assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers })).body.role, 'readonly',
      'a read key minted by the owner inherited the owner');
    assert.equal((await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 1 }, headers })).status, 403);

    // And every rung a live author can issue still authenticates as itself.
    for (const [scopes, role] of [[['*'], 'admin'], [['crm:write'], 'member'], [['metering:write'], 'member']] as const) {
      const key = await app.handle({
        method: 'POST', path: '/v1/api-keys', body: { name: `k ${scopes.join()}`, scopes: [...scopes] }, auth: ownerOf(orgId),
      });
      const me = await app.handle({ method: 'GET', path: '/v1/me', headers: { authorization: `Bearer ${key.body.secret}` } });
      assert.equal(me.status, 200, `a live author's ${scopes.join()} key was refused`);
      assert.equal(me.body.role, role, `${scopes.join()} authenticated as ${me.body.role}`);
    }
    app.close();
  });

  test('a key with no author is a workspace credential, and revoke is its kill switch', async () => {
    // `created_by` is null, which since minting became transitive only a
    // migration or a fixture can produce: there is no membership to ask
    // about, and closing this would shut every such integration the moment
    // anyone left.
    const app = await createApp({ db: 'memory', seed: true, config: { env: 'test' } });
    const orgId = app.ctx.config.defaultOrgId;
    const minted = await app.handle({
      method: 'POST', path: '/v1/api-keys', body: { name: 'Machine credential', scopes: ['*'] }, auth: ownerOf(orgId),
    });
    app.db.run(`UPDATE api_keys SET created_by = NULL WHERE id = ?`, minted.body.id);
    const headers = { authorization: `Bearer ${minted.body.secret}` };

    app.db.run(`DELETE FROM memberships WHERE org_id = ?`, orgId);
    assert.equal((await app.handle({ method: 'GET', path: '/v1/records/company', headers })).status, 200);

    app.db.run(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`, app.ctx.now(), minted.body.id);
    assert.equal((await app.handle({ method: 'GET', path: '/v1/records/company', headers })).status, 401);
    app.close();
  });

  test('both halves of the question now give one answer', async () => {
    // `actorFor` resolved this caller to "nobody" while `authenticate` called
    // them an admin. Whichever way the workspace changes, the two must agree.
    const { app, headers: cookie } = await signedIn('marcus@northwind.io');
    const orgId = app.ctx.config.defaultOrgId;
    const minted = await app.handle({
      method: 'POST', path: '/v1/api-keys', body: { name: 'Marcus key', scopes: ['*'] }, headers: cookie,
    });
    const headers = { authorization: `Bearer ${minted.body.secret}` };
    const company = app.db.get<{ display_name: string }>(
      `SELECT display_name FROM crm_records WHERE org_id = ? AND object_type = 'company' LIMIT 1`, orgId)!;
    const write = () => app.handle({
      method: 'POST', path: '/v1/ai/complete',
      body: {
        prompt: `Add a note to ${company.display_name} saying "Filed through the key."`,
        allow_writes: true, approvals: ['add_note'],
      },
      headers,
    });

    const before = notes(app, orgId);
    assert.ok((await write()).status < 400, 'a live admin\'s key must still drive the agent surface');
    assert.equal(notes(app, orgId), before + 1);
    assert.equal(app.db.pluck<string>(
      `SELECT owner_id FROM crm_records WHERE org_id = ? AND object_type = 'note' ORDER BY created DESC LIMIT 1`, orgId),
      'usr_seed02', 'the write was attributed to somebody other than the key\'s author');

    await app.handle({ method: 'DELETE', path: '/v1/users/usr_seed02', auth: ownerOf(orgId) });
    const after = await write();
    assert.equal(after.status, 401, `a removed admin wrote through his key (${after.status})`);
    assert.equal(notes(app, orgId), before + 1);
    app.close();
  });
});

describe('the navigation registry cannot advertise a dead end', () => {
  /**
   * Read the client modules as source rather than importing them: the registry
   * pulls in .css, which node cannot load, and this is a build-time property of
   * the files anyway.
   */
  const readModules = () => {
    const dir = join(process.cwd(), 'src/client/modules');
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name, 'routes.tsx'))
      .filter((f) => existsSync(f))
      .map((f) => readFileSync(f, 'utf8'));
  };

  const routes = () => readModules().flatMap((src) =>
    [...src.matchAll(/\{[^{}]*?path:\s*'([^']+)'[^{}]*?\}/g)].map((m) => ({
      path: m[1].replace(/\/+$/, '') || '/',
      bare: /layout:\s*'bare'/.test(m[0]),
    })));

  const navTargets = () => readModules().flatMap((src) => {
    const block = src.match(/export const nav[^=]*=\s*\[([\s\S]*?)\n\];/);
    if (!block) return [];
    return [...block[1].matchAll(/to:\s*'([^']+)'/g)].map((m) => m[1].split('?')[0].replace(/\/+$/, '') || '/');
  });

  test('no nav entry points at a route that drops the shell', () => {
    const bare = new Set(routes().filter((r) => r.bare).map((r) => r.path));
    const deadEnds = navTargets().filter((to) => bare.has(to));

    // A `bare` route renders with no sidebar, no breadcrumbs, no command
    // palette and no global key handler. That is right for sign-in and the
    // customer portal, and wrong for anywhere the product's own navigation
    // sends you — there is no way back out.
    assert.deepEqual(deadEnds, [], `nav sends people to shell-less routes: ${deadEnds.join(', ')}`);
  });

  test('every nav destination resolves to a registered route', () => {
    const known = routes().map((r) => r.path);
    const prefixes = known.filter((p) => p.includes(':')).map((p) => p.split('/:')[0]);
    const broken = navTargets().filter((to) =>
      !known.includes(to) && !prefixes.some((prefix) => to.startsWith(prefix)));

    assert.deepEqual(broken, [], `nav points at routes nothing registers: ${broken.join(', ')}`);
  });
});

/**
 * An invalidation asks again; it does not forget. Dropping the cached answer
 * blanked every screen for the round trip after its own mutation: numbers went
 * to zero, and a control whose `disabled` follows the data went disabled under
 * the keyboard and dropped focus — the tax hold switch could be toggled once
 * by space bar and never again.
 */
describe('the client cache revalidates behind what is on screen', () => {
  test('an invalidated answer stays readable, marked stale, until the reload lands', () => {
    primeCache('/api/v1/billing/automatic_tax', { enabled: false });
    primeCache('/api/v1/invoices?limit=50', { object: 'list', data: [] });
    primeCache('/api/v1/me', { id: 'usr_1' });

    invalidate('/v1/billing/automatic_tax', '/v1/invoices');

    assert.deepEqual(peekCache('/api/v1/billing/automatic_tax'), { data: { enabled: false }, stale: true },
      'the answer a screen is showing survives its own invalidation');
    assert.deepEqual(peekCache('/api/v1/invoices?limit=50'), { data: { object: 'list', data: [] }, stale: true });
    assert.deepEqual(peekCache('/api/v1/me'), { data: { id: 'usr_1' }, stale: false },
      'a key outside the prefixes is untouched');

    invalidate();
    assert.equal(peekCache('/api/v1/me')?.stale, true, 'an invalidation with no prefix marks everything, and forgets nothing');
  });
});
