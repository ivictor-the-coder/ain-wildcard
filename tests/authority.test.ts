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
import { createHash } from 'node:crypto';
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

/* ------------------ 4. an invitation is not a membership yet --------------- */

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const SOFIA = 'usr_seed04'; // member

async function invite(app: App, headers: Record<string, string>, email: string, name: string, role = 'member') {
  const res = await app.handle({ method: 'POST', path: '/v1/users', body: { email, name, role }, headers });
  assert.equal(res.status, 201, `precondition: inviting ${email} answered ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

const auditRows = (app: App, action: string) =>
  app.db.all<{ actor_id: string | null; actor_type: string; target_id: string | null; request_id: string | null; summary: string; before: string | null; after: string | null }>(
    `SELECT actor_id, actor_type, target_id, request_id, summary, before, after FROM audit_log WHERE org_id = ? AND action = ? ORDER BY created DESC, rowid DESC`, ORG, action);

describe('an invited teammate cannot sign in until they accept', () => {
  test('inviting returns the token once; accepting sets the password and activates the seat', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');

    const invited = await invite(app, dana, 'zoe@northwind.io', 'Zoe Brandt');
    assert.equal(invited.body.status, 'invited', 'a freshly invited seat is not active');
    const token = invited.body.invitation?.token as string | undefined;
    assert.ok(token && token.startsWith('ain_invite_'), `the invitation came back without its one-time token: ${JSON.stringify(invited.body)}`);
    const zoe = invited.body.id as string;

    // Hashed at rest, like an API key secret — the secret itself is nowhere in the database.
    const stored = app.db.get<{ token_hash: string; accepted_at: number | null; expires: number }>(
      `SELECT token_hash, accepted_at, expires FROM invitations WHERE org_id = ? AND user_id = ?`, ORG, zoe)!;
    assert.equal(stored.token_hash, sha256(token));
    assert.equal(stored.accepted_at, null);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM invitations WHERE token_hash = ?`, token), 0);
    assert.equal(app.db.pluck(`SELECT password_hash FROM users WHERE id = ?`, zoe), null);
    assert.equal(app.db.pluck(`SELECT status FROM memberships WHERE org_id = ? AND user_id = ?`, ORG, zoe), 'invited');

    // The roster shows the pending seat, and never the token again.
    const roster = await app.handle({ method: 'GET', path: '/v1/users', headers: dana });
    const seat = roster.body.data.find((u: { id: string }) => u.id === zoe);
    assert.equal(seat.status, 'invited');
    assert.equal(seat.invitation.id, invited.body.invitation.id);
    assert.equal(seat.invitation.token, undefined, 'the token was shown a second time');

    // Nothing lets the seat in before it is accepted.
    assert.equal((await app.handle({ method: 'POST', path: '/v1/auth/login', body: { email: 'zoe@northwind.io', password: 'orchid-9-lantern' } })).status, 401);

    const preview = await app.handle({ method: 'GET', path: `/v1/auth/invitations/${token}` });
    assert.equal(preview.status, 200, `the accept screen could not read the invitation: ${JSON.stringify(preview.body)}`);
    assert.equal(preview.body.org.name, 'Northwind Robotics');
    assert.equal(preview.body.email, 'zoe@northwind.io');
    assert.equal(preview.body.invited_by.id, DANA);

    const accepted = await app.handle({ method: 'POST', path: '/v1/auth/accept', body: { token, password: 'orchid-9-lantern' } });
    assert.equal(accepted.status, 200, `accepting answered ${accepted.status} ${JSON.stringify(accepted.body)}`);
    assert.equal(accepted.body.user.status, 'active');
    assert.match(String(accepted.headers['set-cookie']), /^ain_session=/, 'accepting should sign the person straight in');
    const cookie = { cookie: String(accepted.headers['set-cookie']).split(';')[0] };
    const me = await app.handle({ method: 'GET', path: '/v1/me', headers: cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.role, 'member');

    assert.equal(app.db.pluck(`SELECT status FROM memberships WHERE org_id = ? AND user_id = ?`, ORG, zoe), 'active');
    assert.ok(app.db.pluck(`SELECT accepted_at FROM invitations WHERE org_id = ? AND user_id = ?`, ORG, zoe));
    assert.equal((await app.handle({ method: 'POST', path: '/v1/auth/login', body: { email: 'zoe@northwind.io', password: 'orchid-9-lantern' } })).status, 200,
      'the password set on acceptance does not sign in');

    // One-time means one time.
    const again = await app.handle({ method: 'POST', path: '/v1/auth/accept', body: { token, password: 'a-different-one-8' } });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'invitation_invalid');
    assert.equal((await app.handle({ method: 'GET', path: `/v1/auth/invitations/${token}` })).status, 400);

    const [invitedRow] = auditRows(app, 'user.invited');
    assert.equal(invitedRow?.target_id, zoe);
    assert.equal(invitedRow?.actor_id, DANA);
    const [acceptedRow] = auditRows(app, 'user.invitation_accepted');
    assert.equal(acceptedRow?.actor_id, zoe, 'accepting is the invitee\'s own act');
    app.close();
  });

  test('re-inviting mints a fresh link and voids the old; cancelling voids it and drops the seat', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    const first = await invite(app, dana, 'zoe@northwind.io', 'Zoe Brandt');
    const zoe = first.body.id as string;
    const token1 = first.body.invitation.token as string;

    // Inviting the same address twice is a mistake, not a second seat.
    const twice = await app.handle({ method: 'POST', path: '/v1/users', body: { email: 'zoe@northwind.io', name: 'Zoe Brandt', role: 'member' }, headers: dana });
    assert.equal(twice.status, 400);
    assert.equal(twice.body.error.code, 'member_exists');

    const resent = await app.handle({ method: 'POST', path: `/v1/users/${zoe}/reinvite`, headers: dana });
    assert.equal(resent.status, 201, `re-inviting answered ${resent.status} ${JSON.stringify(resent.body)}`);
    const token2 = resent.body.invitation.token as string;
    assert.notEqual(token2, token1);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM invitations WHERE org_id = ? AND user_id = ?`, ORG, zoe), 2);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM invitations WHERE org_id = ? AND user_id = ? AND voided_at IS NOT NULL`, ORG, zoe), 1);
    assert.equal(app.db.pluck(`SELECT voided_at FROM invitations WHERE token_hash = ?`, sha256(token1)) !== null, true, 'the old link survived the re-invite');

    const stale = await app.handle({ method: 'POST', path: '/v1/auth/accept', body: { token: token1, password: 'orchid-9-lantern' } });
    assert.equal(stale.status, 400, 'a voided link still accepted');
    assert.equal(stale.body.error.code, 'invitation_invalid');

    // A seat that has accepted has nothing to resend.
    const active = await app.handle({ method: 'POST', path: `/v1/users/${PRIYA}/reinvite`, headers: dana });
    assert.equal(active.status, 409);
    assert.equal(active.body.error.code, 'seat_active');

    // Cancelling.
    assert.equal((await app.handle({ method: 'DELETE', path: `/v1/users/${zoe}`, headers: dana })).status, 204);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM memberships WHERE org_id = ? AND user_id = ?`, ORG, zoe), 0);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM invitations WHERE org_id = ? AND user_id = ? AND voided_at IS NULL`, ORG, zoe), 0,
      'cancelling left a live invitation behind');
    assert.equal((await app.handle({ method: 'POST', path: '/v1/auth/accept', body: { token: token2, password: 'orchid-9-lantern' } })).status, 400);

    assert.equal(auditRows(app, 'user.reinvited').length, 1);
    assert.equal(auditRows(app, 'user.invitation_cancelled').length, 1);
    assert.equal(auditRows(app, 'user.removed').length, 0, 'cancelling an invitation is not removing a member');
    app.close();
  });

  test('an invitation expires after seven days on the workspace clock', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    const invited = await invite(app, dana, 'zoe@northwind.io', 'Zoe Brandt');
    const expires = app.db.pluck<number>(`SELECT expires FROM invitations WHERE org_id = ? AND user_id = ?`, ORG, invited.body.id)!;
    assert.equal(expires, invited.body.invitation.expires);
    assert.equal(expires - app.db.pluck<number>(`SELECT created FROM invitations WHERE org_id = ? AND user_id = ?`, ORG, invited.body.id)!, 7 * 24 * 60 * 60 * 1000);

    assert.equal((await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 8 }, headers: dana })).status, 200);
    const late = await app.handle({ method: 'POST', path: '/v1/auth/accept', body: { token: invited.body.invitation.token, password: 'orchid-9-lantern' } });
    assert.equal(late.status, 400, `an expired invitation was accepted (${late.status})`);
    assert.equal(late.body.error.code, 'invitation_invalid');
    assert.equal(app.db.pluck(`SELECT status FROM memberships WHERE org_id = ? AND user_id = ?`, ORG, invited.body.id), 'invited');

    // A re-invite is the way back: a fresh link, a fresh seven days.
    const resent = await app.handle({ method: 'POST', path: `/v1/users/${invited.body.id}/reinvite`, headers: dana });
    assert.equal(resent.status, 201);
    assert.ok(resent.body.invitation.expires > app.ctx.now());
    assert.equal((await app.handle({ method: 'POST', path: '/v1/auth/accept', body: { token: resent.body.invitation.token, password: 'orchid-9-lantern' } })).status, 200);
    app.close();
  });

  test('an invited admin holds no authority yet, and an old password does not skip the acceptance', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    assert.equal((await app.handle({ method: 'PATCH', path: `/v1/users/${MARCUS}`, body: { role: 'member' }, headers: dana })).status, 200);
    await invite(app, dana, 'zed@northwind.io', 'Zed Okafor', 'admin');

    // Dana is still the only admin who can actually sign in.
    const selfDemote = await app.handle({ method: 'PATCH', path: `/v1/users/${DANA}`, body: { role: 'readonly' }, headers: dana });
    assert.equal(selfDemote.status, 403, 'an invited admin was counted as a live one, and the last owner demoted herself');
    assert.match(String(selfDemote.body.error.message), /last owner/);

    // Marcus leaves and is invited back. He still knows the demo password —
    // that must not walk him into the seat before he accepts.
    assert.equal((await app.handle({ method: 'DELETE', path: `/v1/users/${MARCUS}`, headers: dana })).status, 204);
    const back = await invite(app, dana, 'marcus@northwind.io', 'Marcus Ilori', 'member');
    assert.equal(back.body.status, 'invited');
    const login = await app.handle({ method: 'POST', path: '/v1/auth/login', body: { email: 'marcus@northwind.io', password: 'demo1234' } });
    assert.equal(login.status, 403, `a merely invited seat signed in (${login.status})`);
    assert.match(String(login.body.error.message), /invitation to Northwind Robotics has not been accepted/);

    // Accepting resets the password to the one he chooses now.
    const accepted = await app.handle({ method: 'POST', path: '/v1/auth/accept', body: { token: back.body.invitation.token, password: 'welcome-back-2026' } });
    assert.equal(accepted.status, 200);
    assert.equal((await app.handle({ method: 'POST', path: '/v1/auth/login', body: { email: 'marcus@northwind.io', password: 'demo1234' } })).status, 401);
    assert.equal((await app.handle({ method: 'POST', path: '/v1/auth/login', body: { email: 'marcus@northwind.io', password: 'welcome-back-2026' } })).status, 200);
    app.close();
  });
});

/* ------------------ 5. teammate events name who did them ------------------ */

describe('teammate changes are attributed to the person who made them', () => {
  const lastEvent = async (app: App, headers: Record<string, string>, type: string) =>
    (await app.handle({ method: 'GET', path: '/v1/events', query: { type }, headers })).body.data[0];

  test('user.invited, user.role_changed and user.removed carry the owner, not "system"', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');

    const invited = await invite(app, dana, 'zoe@northwind.io', 'Zoe Brandt');
    const evt = await lastEvent(app, dana, 'user.invited');
    assert.equal(evt.actor_type, 'user', `user.invited was attributed to ${evt.actor_type}`);
    assert.equal(evt.actor_id, DANA);
    assert.equal(evt.request_id, invited.headers['request-id']);

    const changed = await app.handle({ method: 'PATCH', path: `/v1/users/${PRIYA}`, body: { role: 'analyst' }, headers: dana });
    const role = await lastEvent(app, dana, 'user.role_changed');
    assert.equal(role.actor_id, DANA);
    assert.equal(role.actor_type, 'user');
    assert.equal(role.request_id, changed.headers['request-id']);
    assert.deepEqual(role.previous, { role: 'member' });

    const removed = await app.handle({ method: 'DELETE', path: `/v1/users/${SOFIA}`, headers: dana });
    const gone = await lastEvent(app, dana, 'user.removed');
    assert.equal(gone.actor_id, DANA);
    assert.equal(gone.actor_type, 'user');
    assert.equal(gone.request_id, removed.headers['request-id']);
    assert.equal(gone.data.status, 'removed');

    // Through a key the person behind the key is still the actor.
    const key = await mint(app, dana, 'Dana automation');
    await app.handle({ method: 'PATCH', path: `/v1/users/${PRIYA}`, body: { role: 'member' }, headers: key.headers });
    const viaKey = await lastEvent(app, dana, 'user.role_changed');
    assert.equal(viaKey.actor_id, DANA, 'a role change through Dana\'s key was not attributed to Dana');
    assert.equal(viaKey.actor_type, 'user');
    app.close();
  });
});

/* -------------------- 6. the workspace domain is a hostname --------------- */

describe('PATCH /v1/org validates the domain', () => {
  test('anything that is not a bare hostname is refused on the domain parameter', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    const seeded = app.db.pluck<string>(`SELECT domain FROM orgs WHERE id = ?`, ORG);

    for (const bad of ['not a domain!!', 'northwind', 'https://northwind.io', 'northwind.io/billing', 'northwind.io:8080', 'north wind.io', '-northwind.io', 'northwind.i0', 'northwind.']) {
      const res = await app.handle({ method: 'PATCH', path: '/v1/org', body: { domain: bad }, headers: dana });
      assert.equal(res.status, 400, `"${bad}" was accepted as a workspace domain (${res.status})`);
      assert.equal(res.body.error.code, 'parameter_invalid');
      assert.equal(res.body.error.param, 'domain');
    }
    assert.equal(app.db.pluck(`SELECT domain FROM orgs WHERE id = ?`, ORG), seeded, 'a refused domain was stored anyway');

    const ok = await app.handle({ method: 'PATCH', path: '/v1/org', body: { domain: 'Robotics.Northwind.IO' }, headers: dana });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.domain, 'robotics.northwind.io', 'a hostname is case-insensitive and stored in one form');
    const cleared = await app.handle({ method: 'PATCH', path: '/v1/org', body: { domain: null }, headers: dana });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.domain, null);
    app.close();
  });
});

/* ------------------------- 7. the job queue, inspected -------------------- */

describe('the job queue answers the question it was asked', () => {
  test('GET /v1/jobs?status= counts what the filter matches', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    const byStatus = Object.fromEntries(
      app.db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM jobs WHERE org_id = ? GROUP BY status`, ORG).map((r) => [r.status, r.n]));
    assert.ok(Object.keys(byStatus).length >= 2, `the seed should leave more than one job status behind, got ${JSON.stringify(byStatus)}`);

    for (const status of ['pending', 'running', 'done', 'failed', 'cancelled']) {
      const expected = byStatus[status] ?? 0;
      const res = await app.handle({ method: 'GET', path: '/v1/jobs', query: { status }, headers: dana });
      assert.equal(res.status, 200);
      assert.equal(res.body.total_count, expected, `?status=${status} reported ${res.body.total_count} against ${expected} such jobs`);
      assert.equal(res.body.data.length, Math.min(expected, 50));
      assert.ok(res.body.data.every((j: { status: string }) => j.status === status));
      assert.equal(res.body.has_more, expected > res.body.data.length);
    }
    const all = await app.handle({ method: 'GET', path: '/v1/jobs', headers: dana });
    assert.equal(all.body.total_count, app.db.count(`SELECT COUNT(*) FROM jobs WHERE org_id = ?`, ORG));
    app.close();
  });

  test('a failed job can be retried once more — only a failed one, only by an admin', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    const priya = await signIn(app, 'priya@northwind.io');
    let broken = true;
    app.ctx.jobs.handle('authority.test.flaky', () => { if (broken) throw new Error('upstream refused the connection'); });
    app.ctx.enqueue(ORG, 'authority.test.flaky', { attempt: 'first' }, { maxAttempts: 1 });
    const id = app.db.pluck<string>(`SELECT id FROM jobs WHERE org_id = ? AND type = 'authority.test.flaky'`, ORG)!;

    assert.equal((await app.handle({ method: 'POST', path: '/v1/jobs/drain', headers: dana })).status, 200);
    assert.equal(app.db.pluck(`SELECT status FROM jobs WHERE id = ?`, id), 'failed', 'precondition: the job should have failed for good');
    assert.equal(app.db.pluck(`SELECT attempts FROM jobs WHERE id = ?`, id), 1);

    assert.equal((await app.handle({ method: 'POST', path: `/v1/jobs/${id}/retry`, headers: priya })).status, 403, 'a member re-queued a job');

    const before = app.ctx.now();
    const retried = await app.handle({ method: 'POST', path: `/v1/jobs/${id}/retry`, headers: dana });
    assert.equal(retried.status, 200, `retry answered ${retried.status} ${JSON.stringify(retried.body)}`);
    assert.equal(retried.body.status, 'pending');
    assert.equal(retried.body.attempts, 1, 'the attempt count was reset');
    assert.ok(retried.body.run_at >= before && retried.body.run_at <= app.ctx.now(), 'a retried job is due now');
    assert.equal(retried.body.last_error, 'upstream refused the connection', 'the history of why it failed is kept');

    const evt = (await app.handle({ method: 'GET', path: '/v1/events', query: { type: 'job.retried' }, headers: dana })).body.data[0];
    assert.equal(evt?.object_id, id, 'no job.retried event was emitted');
    assert.equal(evt.actor_id, DANA);
    assert.equal(evt.request_id, retried.headers['request-id']);
    const [row] = auditRows(app, 'job.retried');
    assert.equal(row?.target_id, id);
    assert.equal(row.actor_id, DANA);

    // Pending is not failed.
    const again = await app.handle({ method: 'POST', path: `/v1/jobs/${id}/retry`, headers: dana });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'job_not_failed');

    // The cause is fixed: the retry runs and the job completes.
    broken = false;
    await app.handle({ method: 'POST', path: '/v1/jobs/drain', headers: dana });
    assert.equal(app.db.pluck(`SELECT status FROM jobs WHERE id = ?`, id), 'done');
    assert.equal(app.db.pluck(`SELECT attempts FROM jobs WHERE id = ?`, id), 2);
    assert.equal((await app.handle({ method: 'POST', path: `/v1/jobs/${id}/retry`, headers: dana })).status, 409, 'a done job was re-queued');
    assert.equal((await app.handle({ method: 'POST', path: '/v1/jobs/job_does_not_exist/retry', headers: dana })).status, 404);
    app.close();
  });

  test('the time machine\'s audit entry records what it ran', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    const res = await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 3 }, headers: dana });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.jobs_run, 'number');

    const [row] = auditRows(app, 'time.advanced');
    assert.ok(row, 'no time.advanced audit row');
    const after = JSON.parse(row.after!);
    const before = JSON.parse(row.before!);
    assert.equal(after.jobs_run, res.body.jobs_run, `the audit entry does not say how many jobs ran: ${row.after}`);
    assert.equal(after.jobs_failed, res.body.jobs_failed);
    assert.equal(after.now, res.body.now);
    assert.equal(before.now, res.body.previous);
    assert.equal(row.actor_id, DANA);
    assert.equal(row.request_id, res.headers['request-id']);
    assert.doesNotMatch(row.summary, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, `an ISO timestamp in operator-facing prose: "${row.summary}"`);
    assert.match(row.summary, new RegExp(`${res.body.jobs_run} jobs? run, ${res.body.jobs_failed} failed`));
    app.close();
  });
});

/* ---------------- 8. settings-class writes reach the audit trail ---------- */

describe('every settings-class write reaches the audit trail', () => {
  const rowFor = (app: App, requestId: string, action: string) =>
    app.db.get<{ actor_id: string | null; actor_type: string; target_id: string | null; summary: string; before: string | null; after: string | null }>(
      `SELECT actor_id, actor_type, target_id, summary, before, after FROM audit_log WHERE org_id = ? AND request_id = ? AND action = ?`, ORG, requestId, action);

  test('a feature, a property, a tax setting, a tax-id verification and an override each leave a row naming the admin', async () => {
    const app = await boot();
    assert.equal(app.db.count(`SELECT COUNT(*) FROM audit_log WHERE org_id = ?`, ORG), 0,
      'the seed is the workspace\'s starting state, not anyone\'s change — it must not fill the trail');
    const dana = await signIn(app, 'dana@northwind.io');

    const feature = await app.handle({ method: 'POST', path: '/v1/features', body: { key: 'sandbox_seats', name: 'Sandbox seats', type: 'limit', default_value: 5 }, headers: dana });
    assert.equal(feature.status, 201, JSON.stringify(feature.body));
    const featureRow = rowFor(app, feature.headers['request-id'], 'feature.created');
    assert.ok(featureRow, 'POST /v1/features left no audit row');
    assert.equal(featureRow.actor_id, DANA);
    assert.equal(featureRow.actor_type, 'user');
    assert.equal(featureRow.target_id, feature.body.id);
    assert.match(featureRow.summary, /Created feature “Sandbox seats”/);

    const patched = await app.handle({ method: 'PATCH', path: '/v1/features/sandbox_seats', body: { default_value: 8 }, headers: dana });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const patchRow = rowFor(app, patched.headers['request-id'], 'feature.updated');
    assert.ok(patchRow, 'PATCH /v1/features/:key left no audit row');
    assert.equal(JSON.parse(patchRow.before!).default_value, 5, 'the row does not carry what the value was');

    // The CRM store emits from the boot context and names no actor: the row
    // is still Dana's, read off the request scope.
    const property = await app.handle({ method: 'POST', path: '/v1/objects/company/properties', body: { name: 'audit_probe_count', label: 'Audit probe count', type: 'number' }, headers: dana });
    assert.equal(property.status, 201, JSON.stringify(property.body));
    const propertyRow = rowFor(app, property.headers['request-id'], 'property.created');
    assert.ok(propertyRow, 'POST /v1/objects/:type/properties left no audit row');
    assert.equal(propertyRow.actor_id, DANA, `the property row is attributed to ${propertyRow.actor_type}`);
    assert.match(propertyRow.summary, /Created property “audit_probe_count” on company/);
    const dropped = await app.handle({ method: 'DELETE', path: '/v1/objects/company/properties/audit_probe_count', headers: dana });
    assert.equal(dropped.status, 204);
    assert.ok(rowFor(app, dropped.headers['request-id'], 'property.deleted'), 'DELETE /v1/objects/:type/properties/:name left no audit row');

    const wasEnabled = app.db.pluck<string>(`SELECT value FROM settings WHERE org_id = ? AND key = 'billing.automatic_tax'`, ORG);
    const enabled = JSON.parse(wasEnabled ?? '{"enabled":false}').enabled as boolean;
    const tax = await app.handle({ method: 'POST', path: '/v1/billing/automatic_tax', body: { enabled: !enabled }, headers: dana });
    assert.equal(tax.status, 200, JSON.stringify(tax.body));
    const taxRow = rowFor(app, tax.headers['request-id'], 'setting.updated');
    assert.ok(taxRow, 'POST /v1/billing/automatic_tax left no audit row');
    assert.equal(taxRow.target_id, 'billing.automatic_tax');
    assert.equal(JSON.parse(taxRow.before!).value.enabled, enabled);
    assert.equal(JSON.parse(taxRow.after!).value.enabled, !enabled);
    assert.equal(taxRow.actor_id, DANA);
    // Writing the same value again is not a change.
    const same = await app.handle({ method: 'POST', path: '/v1/billing/automatic_tax', body: { enabled: !enabled }, headers: dana });
    assert.equal(rowFor(app, same.headers['request-id'], 'setting.updated'), undefined, 'an unchanged setting was audited as a change');

    const customer = app.db.get<{ id: string; tax_ids: string }>(`SELECT id, tax_ids FROM billing_customers WHERE org_id = ? AND tax_ids <> '[]' LIMIT 1`, ORG)!;
    const [taxId] = JSON.parse(customer.tax_ids) as { value: string }[];
    const verified = await app.handle({ method: 'POST', path: `/v1/customers/${customer.id}/tax_ids/verify`, body: { value: taxId.value, status: 'unverified' }, headers: dana });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const verifyRow = rowFor(app, verified.headers['request-id'], 'customer.tax_id_verified');
    assert.ok(verifyRow, 'POST /v1/customers/:id/tax_ids/verify left no audit row');
    assert.equal(verifyRow.target_id, customer.id);
    assert.equal(verifyRow.actor_id, DANA);

    const override = await app.handle({ method: 'POST', path: '/v1/entitlement-overrides', body: { customer: customer.id, feature: 'seats', value: 50, reason: 'Pilot extension agreed with their COO' }, headers: dana });
    assert.equal(override.status, 201, JSON.stringify(override.body));
    assert.ok(rowFor(app, override.headers['request-id'], 'entitlement_override.created'), 'POST /v1/entitlement-overrides left no audit row');
    const revoked = await app.handle({ method: 'DELETE', path: `/v1/entitlement-overrides/${override.body.id}`, headers: dana });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const revokeRow = rowFor(app, revoked.headers['request-id'], 'entitlement_override.revoked');
    assert.ok(revokeRow, 'DELETE /v1/entitlement-overrides/:id left no audit row');
    assert.equal(revokeRow.actor_id, DANA);
    app.close();
  });

  test('a write the module already audits is not written twice, and a business record is not mirrored', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    const countFor = (requestId: string) => app.db.count(`SELECT COUNT(*) FROM audit_log WHERE org_id = ? AND request_id = ?`, ORG, requestId);

    const org = await app.handle({ method: 'PATCH', path: '/v1/org', body: { name: 'Northwind Robotics' }, headers: dana });
    assert.equal(org.status, 200);
    assert.equal(countFor(org.headers['request-id']), 1, 'PATCH /v1/org wrote more than its own audit row');

    const invited = await invite(app, dana, 'zoe@northwind.io', 'Zoe Brandt');
    assert.equal(countFor(invited.headers['request-id']), 1);

    const company = await app.handle({ method: 'POST', path: '/v1/records/company', body: { properties: { name: 'Audit Probe Industries', domain: 'audit-probe.test' } }, headers: dana });
    assert.equal(company.status, 201, JSON.stringify(company.body));
    assert.equal(countFor(company.headers['request-id']), 1, 'the CRM\'s own row for a record was doubled by the bridge');
    assert.equal(app.db.pluck(`SELECT action FROM audit_log WHERE org_id = ? AND request_id = ?`, ORG, company.headers['request-id']), 'company.created');
    app.close();
  });

  test('a job that changes configuration is the system\'s act, not the operator\'s who moved the clock', async () => {
    const app = await boot();
    const dana = await signIn(app, 'dana@northwind.io');
    const customer = app.db.pluck<string>(`SELECT id FROM billing_customers WHERE org_id = ? LIMIT 1`, ORG)!;
    const expires = app.ctx.now() + 2 * 24 * 60 * 60 * 1000;
    const override = await app.handle({
      method: 'POST', path: '/v1/entitlement-overrides',
      body: { customer, feature: 'seats', value: 50, reason: 'Two-day pilot extension', expires_at: expires }, headers: dana,
    });
    assert.equal(override.status, 201, JSON.stringify(override.body));

    const advanced = await app.handle({ method: 'POST', path: '/v1/time/advance', body: { days: 3 }, headers: dana });
    assert.equal(advanced.status, 200);
    const expired = app.db.get<{ actor_id: string | null; actor_type: string; request_id: string | null }>(
      `SELECT actor_id, actor_type, request_id FROM audit_log WHERE org_id = ? AND action = 'entitlement_override.expired'`, ORG);
    assert.ok(expired, 'the override expiring under the time machine left no audit row');
    assert.equal(expired.actor_type, 'system', `an expiry run by a job was attributed to ${expired.actor_type} ${expired.actor_id}`);
    assert.equal(expired.actor_id, null);
    app.close();
  });
});
