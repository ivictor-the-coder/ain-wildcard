/**
 * Who may hold authority, who may hand it out, and what happens when a person
 * leaves.
 *
 * `boundedByAuthor` in `app.ts` states the rule the whole platform is supposed
 * to run on — *a credential may never carry authority its author does not
 * currently hold* — and it was enforced on exactly one of the three ways
 * authority is created:
 *
 *   1. a key minted through a key lost its author, so it outlived the removal
 *      of the human it descended from;
 *   2. the membership table, which the key ceiling only *mirrors*, took any
 *      role from the enum with no comparison to the caller's own rung;
 *   3. removing a teammate suspended their credentials rather than ending
 *      them, so re-inviting the seat brought the old cookie and the old key
 *      back with it.
 *
 * Each of these ends with the same question asked at a different door, and the
 * answers have to agree.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';

const ORG = 'org_demo';
const DANA = 'usr_seed01';   // owner
const MARCUS = 'usr_seed02'; // admin
const PRIYA = 'usr_seed03';  // member

async function boot(): Promise<App> {
  return createApp({ db: 'memory', seed: true, config: { env: 'test' } });
}

async function signIn(app: App, email: string): Promise<Record<string, string>> {
  const login = await app.handle({ method: 'POST', path: '/v1/auth/login', body: { email, password: 'demo1234' } });
  assert.equal(login.status, 200, `precondition: ${email} could not sign in`);
  return { cookie: String(login.headers['set-cookie']).split(';')[0] };
}

const systemAuth = (orgId: string): Auth =>
  ({ kind: 'system', orgId, role: 'system', scopes: ['*'], livemode: true });

async function mint(app: App, headers: Record<string, string>, name: string, scopes = ['*']) {
  const res = await app.handle({ method: 'POST', path: '/v1/api-keys', body: { name, scopes }, headers });
  assert.equal(res.status, 201, `precondition: minting "${name}" answered ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id as string, headers: { authorization: `Bearer ${res.body.secret}` } };
}

/* ------------------- 1. authorship is transitive, or removal is a pause ---- */

describe('a key minted by a key still belongs to a person', () => {
  test('the grandchild key dies with the human its parent descended from', async () => {
    const app = await boot();
    const marcus = await signIn(app, 'marcus@northwind.io');

    const k1 = await mint(app, marcus, 'marcus ci');
    // The step the old code dropped on the floor: `created_by` came from
    // `auth.userId`, which an API key has not got.
    const k2 = await mint(app, k1.headers, 'ci child');
    assert.equal(
      app.db.pluck<string>(`SELECT created_by FROM api_keys WHERE id = ?`, k2.id), MARCUS,
      'a key minted through a key kept no record of the person behind it',
    );

    // Both keys work while Marcus is a member — the fix must not shut the
    // integration path, only tie it to a living person.
    for (const key of [k1, k2]) {
      assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers: key.headers })).status, 200);
    }

    const removed = await app.handle({ method: 'DELETE', path: `/v1/users/${MARCUS}`, headers: await signIn(app, 'dana@northwind.io') });
    assert.equal(removed.status, 204);

    const me = await app.handle({ method: 'GET', path: '/v1/me', headers: k2.headers });
    assert.equal(me.status, 401, `a key minted by a removed admin's key still answered ${JSON.stringify(me.body?.role)}`);

    // And it cannot do the two things it was demonstrated doing.
    assert.equal((await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 1 }, headers: k2.headers })).status, 401);
    assert.equal((await app.handle({
      method: 'POST', path: '/v1/users', body: { email: 'ghost@northwind.io', name: 'Ghost', role: 'owner' }, headers: k2.headers,
    })).status, 401);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM memberships WHERE org_id = ? AND role = 'owner'`, ORG), 1);
    app.close();
  });

  test('a key may not mint a child with more reach than it holds', async () => {
    // Today `POST /v1/api-keys` is gated at `admin`, which only a `['*']` key
    // reaches, so this bound is the floor under a future narrowing rather than
    // a hole anyone can walk through now. It is asserted because the moment a
    // narrower key may mint, "issue yourself a wider one" is the escalation.
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    const reporting = await mint(app, dana, 'Reporting key', ['crm:read']);

    const wider = await app.handle({
      method: 'POST', path: '/v1/api-keys', body: { name: 'Wider child', scopes: ['crm:write'] },
      auth: { kind: 'api_key', orgId: ORG, keyId: reporting.id, role: 'admin', scopes: ['crm:read'], livemode: false },
    });
    assert.equal(wider.status, 403, `a ["crm:read"] key minted a ["crm:write"] child (${wider.status})`);
    assert.match(String(wider.body.error.message), /never issue more reach/);

    const same = await app.handle({
      method: 'POST', path: '/v1/api-keys', body: { name: 'Narrower child', scopes: ['crm:read'] },
      auth: { kind: 'api_key', orgId: ORG, keyId: reporting.id, role: 'admin', scopes: ['crm:read'], livemode: false },
    });
    assert.equal(same.status, 201, 'the bound refused a child no wider than its parent');
    app.close();
  });
});

/* --------------- 2. the ceiling and the floor on the membership ----------- */

describe('nobody hands out authority they do not hold', () => {
  test('an admin cannot seat themselves as owner, or demote the owner', async () => {
    const app = await boot();
    const marcus = await signIn(app, 'marcus@northwind.io');

    const promote = await app.handle({ method: 'PATCH', path: `/v1/users/${MARCUS}`, body: { role: 'owner' }, headers: marcus });
    assert.equal(promote.status, 403, `an admin seated himself as owner (${promote.status})`);
    assert.match(String(promote.body.error.message), /cannot grant the owner role/);

    const demote = await app.handle({ method: 'PATCH', path: `/v1/users/${DANA}`, body: { role: 'readonly' }, headers: marcus });
    assert.equal(demote.status, 403, `an admin demoted the owner (${demote.status})`);

    const invite = await app.handle({
      method: 'POST', path: '/v1/users', body: { email: 'zoe@northwind.io', name: 'Zoe', role: 'owner' }, headers: marcus,
    });
    assert.equal(invite.status, 403, `an admin invited a second owner (${invite.status})`);

    const kill = await app.handle({ method: 'DELETE', path: `/v1/users/${DANA}`, headers: marcus });
    assert.equal(kill.status, 403, `an admin removed the owner (${kill.status})`);

    assert.equal(app.db.pluck<string>(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, ORG, MARCUS), 'admin');
    assert.equal(app.db.pluck<string>(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, ORG, DANA), 'owner');
    app.close();
  });

  test('the ceiling is a ceiling, not a wall: an admin still runs the workspace', async () => {
    const app = await boot();
    const marcus = await signIn(app, 'marcus@northwind.io');

    assert.equal((await app.handle({
      method: 'POST', path: '/v1/users', body: { email: 'zoe@northwind.io', name: 'Zoe Brandt', role: 'member' }, headers: marcus,
    })).status, 201, 'an admin could no longer invite a teammate at their own rung or below');
    assert.equal((await app.handle({
      method: 'PATCH', path: `/v1/users/${PRIYA}`, body: { role: 'analyst' }, headers: marcus,
    })).status, 200, 'an admin could no longer change a member\'s role');
    // The owner is above everything, so nothing is closed to them.
    const dana = await signIn(app, 'dana@northwind.io');
    assert.equal((await app.handle({
      method: 'PATCH', path: `/v1/users/${MARCUS}`, body: { role: 'owner' }, headers: dana,
    })).status, 200, 'the owner could not promote an admin to owner');
    app.close();
  });

  test('a workspace always keeps someone who can administer it', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    assert.equal((await app.handle({ method: 'PATCH', path: `/v1/users/${MARCUS}`, body: { role: 'member' }, headers: dana })).status, 200);

    // Dana is now the only membership at admin or above.
    const selfDemote = await app.handle({ method: 'PATCH', path: `/v1/users/${DANA}`, body: { role: 'readonly' }, headers: dana });
    assert.equal(selfDemote.status, 403, `the last owner demoted herself out of her own workspace (${selfDemote.status})`);
    assert.match(String(selfDemote.body.error.message), /last owner/);

    const selfRemove = await app.handle({ method: 'DELETE', path: `/v1/users/${DANA}`, headers: dana });
    assert.equal(selfRemove.status, 403, `the last owner removed herself (${selfRemove.status})`);
    assert.match(String(selfRemove.body.error.message), /cannot remove your own membership/);

    // The same floor holds for an automated caller, which has no "self" to
    // stop at: a system principal is the one way the last admin's row can be
    // reached by somebody who is not that admin.
    const swept = await app.handle({ method: 'DELETE', path: `/v1/users/${DANA}`, auth: systemAuth(ORG) });
    assert.equal(swept.status, 403, `an automated caller emptied the workspace of admins (${swept.status})`);

    assert.equal(app.db.count(`SELECT COUNT(*) FROM memberships WHERE org_id = ? AND role IN ('owner','admin')`, ORG), 1);

    // With a second admin in place the same two calls are allowed again — the
    // floor stops the last one out, not every departure.
    assert.equal((await app.handle({ method: 'PATCH', path: `/v1/users/${MARCUS}`, body: { role: 'admin' }, headers: dana })).status, 200);
    assert.equal((await app.handle({ method: 'PATCH', path: `/v1/users/${DANA}`, body: { role: 'readonly' }, headers: dana })).status, 200);
    app.close();
  });

  test('a self-removal through a key is still a self-removal', async () => {
    // The sign-flip: `auth.userId` is empty for a key, so the guard has to ask
    // who is *behind* the credential, not which door it came through.
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    const key = await mint(app, dana, 'Dana automation');

    const res = await app.handle({ method: 'DELETE', path: `/v1/users/${DANA}`, headers: key.headers });
    assert.equal(res.status, 403, `an owner removed herself through her own API key (${res.status})`);
    assert.match(String(res.body.error.message), /your own membership/);
    app.close();
  });
});

/* -------------------- 3. removal is terminal, not a hold ------------------ */

describe('removing a teammate ends the credentials they hold', () => {
  test('a re-invite does not resurrect the departed employee\'s cookie and CI key', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    const marcusCookie = await signIn(app, 'marcus@northwind.io');
    const key = await mint(app, marcusCookie, 'Marcus CI');

    assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers: key.headers })).body.role, 'admin');

    assert.equal((await app.handle({ method: 'DELETE', path: `/v1/users/${MARCUS}`, headers: dana })).status, 204);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM sessions WHERE org_id = ? AND user_id = ?`, ORG, MARCUS), 0,
      'removal left the laptop cookie alive');
    assert.ok(app.db.pluck<number>(`SELECT revoked_at FROM api_keys WHERE id = ?`, key.id),
      'removal left the CI key unrevoked, with only the membership check between it and the workspace');

    // A different admin re-invites the same address, believing they are
    // creating a fresh, minimal seat.
    const reinvite = await app.handle({
      method: 'POST', path: '/v1/users', body: { email: 'marcus@northwind.io', name: 'Marcus Ilori', role: 'readonly' }, headers: dana,
    });
    assert.equal(reinvite.status, 201);

    for (const [label, headers] of [['the CI key', key.headers], ['the pre-removal cookie', marcusCookie]] as const) {
      const res = await app.handle({ method: 'GET', path: '/v1/me', headers });
      assert.equal(res.status, 401, `${label} came back with the seat, as ${JSON.stringify(res.body?.role)}`);
    }

    // And promoting the new seat must not hand the old key `admin` again.
    assert.equal((await app.handle({ method: 'PATCH', path: `/v1/users/${MARCUS}`, body: { role: 'admin' }, headers: dana })).status, 200);
    assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers: key.headers })).status, 401,
      'a promotion revived a credential that was never re-issued');
    app.close();
  });

  test('the operator is told what was revoked, and only what belonged to that person', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    const danaKey = await mint(app, dana, 'Dana key');
    const marcusCookie = await signIn(app, 'marcus@northwind.io');
    await mint(app, marcusCookie, 'Marcus key one');
    await mint(app, marcusCookie, 'Marcus key two');

    assert.equal((await app.handle({ method: 'DELETE', path: `/v1/users/${MARCUS}`, headers: dana })).status, 204);

    const entry = app.db.get<{ summary: string; after: string }>(
      `SELECT summary, after FROM audit_log WHERE org_id = ? AND action = 'user.removed' ORDER BY created DESC LIMIT 1`, ORG)!;
    assert.match(entry.summary, /1 session ended, 2 API keys revoked/,
      `the audit trail said "${entry.summary}" about a removal that killed two credentials`);

    const events = await app.handle({ method: 'GET', path: '/v1/events', query: { type: 'user.removed' }, headers: dana });
    assert.equal(events.body.data[0].data.api_keys_revoked, 2);

    // Nobody else's credentials moved.
    assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers: danaKey.headers })).status, 200,
      'removing one teammate revoked another teammate\'s key');
    assert.equal((await app.handle({ method: 'GET', path: '/v1/me', headers: dana })).status, 200);
    app.close();
  });
});
