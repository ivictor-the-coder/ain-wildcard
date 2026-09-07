import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { defineModule } from '../../kernel/module';
import type { Ctx } from '../../kernel/context';
import { buildOpenApi, created, list, noContent, roleAtLeast, status as httpStatus, type Req, type Role } from '../../kernel/http';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../../shared/errors';
import { newId, randomId } from '../../../shared/ids';
import { parseJson } from '../../kernel/db';
import type { AinEvent } from '../../kernel/events';
import { currentOrgScope } from '../../kernel/org-scope';
import v from '../../../shared/validate';
import { DAY, formatDateTime } from '../../../shared/time';

/* ------------------------------ passwords -------------------------------- */

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, 32).toString('hex');
  return `scrypt$${salt}$${key}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(key, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/* ------------------------ who is behind a credential ---------------------- */

/**
 * The human this call is being made by, whichever door it came through.
 *
 * A session carries its user. An API key does not — and treating "no user id"
 * as "no person" is what made a key an immortal credential: minting a key
 * through a key dropped the author, and `authenticate` has nobody to ask about
 * a key with no author, so the child outlived the removal of the human who
 * created its parent. A key's principal is its author, transitively, because
 * that is who is acting.
 */
function principalOf(c: Ctx, auth: Req['auth']): string | null {
  if (auth.userId) return auth.userId;
  if (!auth.keyId) return null;
  return c.db.pluck<string>(`SELECT created_by FROM api_keys WHERE id = ? AND org_id = ?`, auth.keyId, auth.orgId) ?? null;
}

type ActorType = 'user' | 'api_key' | 'system';

/**
 * The same principal, written the way an event or an audit row wants it.
 *
 * Every route in the platform stamps its events with the request's actor;
 * the teammate routes did not, so `user.invited`, `user.role_changed` and
 * `user.removed` reached webhooks and the timeline as `system` with no request
 * behind them, although a signed-in owner had just pressed the button. One
 * helper feeds both the event and the audit row so the two can never disagree
 * about who acted.
 */
function actorOf(c: Ctx, auth: Req['auth']): { actorId: string | null; actorType: ActorType } {
  const person = principalOf(c, auth);
  if (person) return { actorId: person, actorType: 'user' };
  if (auth.keyId) return { actorId: auth.keyId, actorType: 'api_key' };
  return { actorId: null, actorType: 'system' };
}

/* ------------------------------ workspace domain -------------------------- */

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * A workspace domain is a bare hostname — RFC 1123 labels, at least one dot,
 * an alphabetic top-level domain — because it is what sign-in, email matching
 * and the invoice header hang off. `https://northwind.io/`, `northwind`,
 * `north wind.io` and `northwind.io:8080` are all things a person types by
 * accident, and all of them used to be stored verbatim.
 */
const workspaceDomain = () => v.transform(
  v.refine(v.string({ min: 1, max: 253 }), (value) => {
    if (/[\s/:@?#]/.test(value)) {
      return `"${value}" is not a hostname — enter the domain on its own, like northwind.io, with no scheme, path, port or spaces.`;
    }
    const labels = value.split('.');
    if (labels.length < 2) return `"${value}" needs at least one dot — a workspace domain looks like northwind.io.`;
    if (!labels.every((label) => HOSTNAME_LABEL.test(label))) {
      return `"${value}" is not a valid hostname — each dot-separated part is letters, digits and hyphens, and cannot start or end with a hyphen.`;
    }
    if (!/^[a-z]{2,63}$/i.test(labels[labels.length - 1])) {
      return `"${value}" needs an alphabetic top-level domain like .io or .com.`;
    }
    return true;
  }),
  (value) => value.toLowerCase(),
  { format: 'hostname' },
);

/* -------------------------------- invitations ----------------------------- */

export type SeatStatus = 'invited' | 'active';

const INVITATION_TTL = 7 * DAY;

interface InvitationRow {
  id: string; org_id: string; user_id: string; token_hash: string; invited_by: string | null;
  created: number; expires: number; accepted_at: number | null; voided_at: number | null;
}

/**
 * Mint the one-time token for a seat, voiding whatever was pending before.
 *
 * Only the hash is stored — the same "shown once" rule as an API key secret —
 * so a leaked database cannot be turned into a sign-in, and a re-invite is
 * the only way to get a fresh link. Returns the secret exactly once.
 */
function mintInvitation(c: Ctx, orgId: string, userId: string, invitedBy: string | null, now: number): { row: InvitationRow; token: string } {
  c.db.run(`UPDATE invitations SET voided_at = ? WHERE org_id = ? AND user_id = ? AND accepted_at IS NULL AND voided_at IS NULL`, now, orgId, userId);
  const token = `ain_invite_${randomBytes(24).toString('base64url')}`;
  const row: InvitationRow = {
    id: randomId('inv'), org_id: orgId, user_id: userId, token_hash: sha(token), invited_by: invitedBy,
    created: now, expires: now + INVITATION_TTL, accepted_at: null, voided_at: null,
  };
  c.db.insert('invitations', { ...row });
  return { row, token };
}

const pendingInvitation = (c: Ctx, orgId: string, userId: string): InvitationRow | undefined =>
  c.db.get<InvitationRow>(
    `SELECT * FROM invitations WHERE org_id = ? AND user_id = ? AND accepted_at IS NULL AND voided_at IS NULL ORDER BY created DESC LIMIT 1`,
    orgId, userId,
  );

const publicInvitation = (row: InvitationRow) => ({
  object: 'invitation' as const, id: row.id, expires: row.expires, created: row.created, invited_by: row.invited_by,
});

/* ------------------------ settings-class audit bridge --------------------- */

/**
 * Which event families the kernel mirrors into the audit trail.
 *
 * The contract says every meaningful change is an event and the audit log
 * reads from that one stream — but only the modules that wrote their own
 * `c.audit(...)` calls ever reached it, and none of the settings-class writes
 * did: a tax rate registered, a feature defined, an override granted, a
 * property added to the schema. The rule is by *family* (the part of the type
 * before the dot), not by exact type, so a module that later emits
 * `feature.archived` is audited the day it ships with no edit here. Families
 * are configuration objects — what an admin defines for everyone — never
 * business records, which the CRM audits itself, and never the high-volume
 * business events (`invoice.*`, `meter.events_ingested`) that would drown the
 * trail. The few record-family events that are compliance writes are named
 * exactly.
 */
const AUDITED_FAMILIES = new Set([
  'setting', 'tax_rate', 'feature', 'product_feature', 'entitlement_override',
  'property', 'object_type', 'association_type', 'pipeline', 'product', 'price',
]);
const AUDITED_TYPES = new Set(['customer.tax_id_verified', 'meter.created', 'meter.updated']);
/** Consequences of an audited write, not writes of their own. */
const UNAUDITED_TYPES = new Set(['property.recalculated']);

export const isSettingsEvent = (type: string): boolean =>
  !UNAUDITED_TYPES.has(type) && (AUDITED_TYPES.has(type) || AUDITED_FAMILIES.has(type.split('.')[0]));

const VERBS: Record<string, string> = {
  created: 'Created', updated: 'Updated', deleted: 'Deleted', revoked: 'Revoked', expired: 'Expired',
  deactivated: 'Retired', activated: 'Reinstated', tax_id_verified: 'Verified a tax registration on',
};

const humanise = (s: string) => s.replace(/[_.]+/g, ' ');

/** The one line an operator reads on the audit screen for a mirrored event. */
function describeSettingsEvent(event: AinEvent): string {
  const [family, verb] = event.type.split('.');
  const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<string, unknown>;
  const label = VERBS[verb] ?? humanise(verb).replace(/^./, (ch) => ch.toUpperCase());
  const noun = family === 'setting' ? 'setting' : humanise(family);
  const nameOf = (keys: string[]) => keys.map((k) => data[k]).find((val): val is string => typeof val === 'string' && val.length > 0);
  const name = family === 'setting'
    ? (typeof data.key === 'string' ? humanise(data.key) : undefined)
    : nameOf(['display_name', 'name', 'label', 'jurisdiction', 'key', 'reason', 'id']);
  const on = family === 'property' && typeof data.object_type === 'string' ? ` on ${data.object_type}` : '';
  return name ? `${label} ${noun} “${name}”${on}` : `${label} ${noun}${on}`;
}

/**
 * Mirror one settings-class event into the audit trail.
 *
 * Attribution comes from the event when the emitter named an actor, and from
 * the request scope otherwise — the CRM store emits `property.created` from
 * the boot context, which knows nothing about the admin who pressed the
 * button, but `withAuth` stamped that admin onto the scope. A job runs in a
 * scope of its own with no actor, so an override that expires under
 * `POST /v1/time/advance` is the system's doing and not the operator's.
 *
 * Outside any scope there is nobody to attribute to: that is the seed, whose
 * catalog, features and tax registrations are the workspace's starting state
 * rather than anyone's change.
 */
function auditSettingsEvent(ctx: Ctx, event: AinEvent): void {
  if (!isSettingsEvent(event.type)) return;
  const scope = currentOrgScope();
  if (!scope) return;
  const fromEvent = event.actor_id !== null;
  ctx.audit({
    orgId: event.org_id,
    actorId: fromEvent ? event.actor_id : scope.actorId ?? null,
    actorType: fromEvent ? event.actor_type : scope.actorType ?? 'system',
    action: event.type,
    targetType: event.object_type,
    targetId: event.object_id,
    summary: describeSettingsEvent(event),
    before: event.previous ?? undefined,
    after: event.data,
    requestId: event.request_id ?? scope.requestId ?? null,
  });
}

/* --------------------------- the authority ladder ------------------------- */

/**
 * Nobody hands out authority they do not hold.
 *
 * `boundedByAuthor` in `app.ts` states this for API keys — "a credential may
 * never carry authority its author does not currently hold" — and the
 * membership table is the *primary* grant path that mirror was written
 * against. Only the mirror was guarded: `roles: ['admin']` let any admin PATCH
 * themselves to `owner` and the owner down to `readonly`, in two calls, with
 * no way back. A key minted by that admin is capped at `admin` by the bound;
 * the seat the key hangs off was not capped at all.
 */
function assertMayGrant(req: Req, role: Role): void {
  if (roleAtLeast(req.auth.role, role)) return;
  throw forbidden(
    `Your role (${req.auth.role}) cannot grant the ${role} role — nobody may hand out more authority than they hold. `
    + `Ask ${role === 'owner' ? 'an owner' : 'someone with the ' + role + ' role or higher'} to make this change.`,
  );
}

/**
 * Memberships at `admin` or above that would survive this seat changing. An
 * invited seat does not count: until the invitation is accepted there is no
 * password behind it, so it cannot sign in to administer anything.
 */
function adminsBesides(c: Ctx, orgId: string, userId: string): number {
  return c.db.count(
    `SELECT COUNT(*) FROM memberships WHERE org_id = ? AND user_id <> ? AND role IN ('owner', 'admin') AND status = 'active'`,
    orgId, userId,
  );
}

/**
 * The floor under the ceiling: a workspace always keeps someone who can
 * administer it.
 *
 * Now that every credential is resolved against a live membership, the last
 * admin demoting or removing themselves is not a recoverable mistake — the
 * session does not survive as `member`, the key they hold is bounded by the
 * role they no longer have, and there is nobody left who can undo either.
 */
function assertKeepsAnAdmin(c: Ctx, orgId: string, userId: string, nextRole: Role | null): void {
  const current = c.db.pluck<Role>(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, orgId, userId);
  if (!current || !roleAtLeast(current, 'admin')) return;
  if (nextRole && roleAtLeast(nextRole, 'admin')) return;
  if (adminsBesides(c, orgId, userId)) return;
  throw forbidden(
    nextRole
      ? `This is the workspace's last ${current}, so the role cannot be lowered to ${nextRole}. Promote another teammate to admin first, then come back.`
      : `This is the workspace's last ${current}, so they cannot be removed. Promote another teammate to admin first, then come back.`,
  );
}

/* -------------------------------- service -------------------------------- */

export interface OrgRow {
  id: string; name: string; slug: string; domain: string | null; logo_url: string | null;
  brand_color: string; default_currency: string; timezone: string; locale: string;
  clock_offset: number; settings: string; created: number; updated: number;
}
export interface UserRow {
  id: string; email: string; name: string; avatar_url: string | null; title: string | null;
  password_hash: string | null; created: number; updated: number; last_seen: number | null;
}

export interface Seat extends UserRow { role: Role; teams: string[]; status: SeatStatus }

export interface CoreService {
  org(orgId: string): OrgRow;
  user(userId: string): UserRow | undefined;
  users(orgId: string): Seat[];
  setting<T>(orgId: string, key: string, fallback: T): T;
  setSetting(orgId: string, key: string, value: unknown): void;
  createSession(orgId: string, userId: string, meta?: { ip?: string; userAgent?: string }): { token: string; expires: number };
  currency(orgId: string): string;
}

declare module '../../kernel/services' {
  interface ServiceRegistry { core: CoreService }
}

/* --------------------------------- module -------------------------------- */

export default defineModule({
  name: 'core',
  title: 'Platform core',
  description: 'Organisations, people, authentication, API keys, the event log, the job queue, the audit trail and the workspace time machine.',

  /**
   * A seat has a status because an invitation is not a membership yet. The
   * old `POST /v1/users` stored a person with no password and no way to set
   * one — the headline action on the Settings screen produced someone who
   * could never sign in. The invitation row holds only the hash of the link.
   */
  migrations: [{
    id: 'core.0002_seats',
    sql: `
ALTER TABLE memberships ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  accepted_at INTEGER,
  voided_at INTEGER
);
CREATE INDEX idx_invitations_seat ON invitations(org_id, user_id);
`,
  }],

  boot(ctx) {
    const service: CoreService = {
      org(orgId) {
        const row = ctx.db.get<OrgRow>(`SELECT * FROM orgs WHERE id = ?`, orgId);
        if (!row) throw notFound('organization', orgId);
        return row;
      },
      user(userId) { return ctx.db.get<UserRow>(`SELECT * FROM users WHERE id = ?`, userId); },
      users(orgId) {
        return ctx.db.all<any>(
          `SELECT u.*, m.role, m.teams, m.status FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ? ORDER BY u.name`,
          orgId,
        ).map((r) => ({ ...r, teams: parseJson<string[]>(r.teams, []) }));
      },
      setting(orgId, key, fallback) {
        const row = ctx.db.get<{ value: string }>(`SELECT value FROM settings WHERE org_id = ? AND key = ?`, orgId, key);
        return row ? parseJson(row.value, fallback) : fallback;
      },
      /**
       * A setting is configuration, so changing one is an event like any
       * other configuration change — `POST /v1/billing/automatic_tax` and
       * the dunning policy both land here, and neither left a trace before.
       * Writing the same value again is not a change and emits nothing.
       */
      setSetting(orgId, key, value) {
        const previous = ctx.db.get<{ value: string }>(`SELECT value FROM settings WHERE org_id = ? AND key = ?`, orgId, key);
        const next = JSON.stringify(value);
        if (previous && previous.value === next) return;
        ctx.db.upsert('settings', { org_id: orgId, key, value: next, updated: ctx.now() }, ['org_id', 'key']);
        const scope = currentOrgScope();
        ctx.emit(orgId, 'setting.updated', { key, value }, {
          objectId: key, objectType: 'setting',
          previous: previous ? { value: parseJson<unknown>(previous.value, null) } : null,
          actorId: scope?.actorId ?? null, actorType: scope?.actorType ?? 'system', requestId: scope?.requestId ?? null,
        });
      },
      /**
       * A sign-in is good for 30 *real* days — the one thing in the platform
       * measured on the wall clock rather than `ctx.now()`.
       *
       * `ctx.now()` is the workspace's business time, which any admin moves a
       * year with `POST /v1/time/advance`. Minting against it made the session
       * cookie's own `Max-Age` (already real seconds) disagree with the row,
       * and expiring against it meant the platform's headline feature signed
       * out the operator who pressed it: advance 35 days and every following
       * call is a 401. A credential's lifetime is a fact about the person who
       * walked away from their desk, not about the ledger they were replaying.
       */
      createSession(orgId, userId, meta = {}) {
        const token = randomId('sess', 32);
        const at = Date.now();
        const expires = at + 30 * DAY;
        ctx.db.insert('sessions', {
          id: newId('session'), org_id: orgId, user_id: userId, token_hash: sha(token),
          expires, created: at, ip: meta.ip ?? null, user_agent: meta.userAgent ?? null,
        });
        return { token, expires };
      },
      currency(orgId) {
        return ctx.db.pluck<string>(`SELECT default_currency FROM orgs WHERE id = ?`, orgId) || 'usd';
      },
    };
    ctx.provide('core', service);

    ctx.events.on('*', (event) => auditSettingsEvent(ctx, event), 'core.audit');

    /**
     * Housekeeping for one workspace, on that workspace's clock.
     *
     * `ctx.now()` is per workspace and an operator moves it years at a time, so
     * an unscoped sweep is a lever every tenant holds over every other: org_b
     * advancing 60 days deleted org_a's live sessions, org_a's idempotency keys
     * — so org_a's next retry of a charge executed a second time instead of
     * replaying — and org_a's job history. The recurring job also re-enqueued
     * itself against the *default* org rather than its own, so after one run by
     * any other tenant the job emigrated: that tenant never cleaned up again,
     * and the default workspace's next run was scheduled on a clock that was
     * not its own.
     *
     * Sessions are the exception to `ctx.now()`: a sign-in is good for 30 real
     * days (see `createSession`), so business time must not decide when one
     * dies — otherwise the time machine's own advance button logs the operator
     * who pressed it out of the workspace.
     */
    ctx.jobs.handle('core.cleanup', (_payload, job) => {
      const now = ctx.now();
      const orgId = job.org_id;
      ctx.db.run(`DELETE FROM sessions WHERE org_id = ? AND expires < ?`, orgId, Date.now());
      ctx.db.run(`DELETE FROM idempotency_keys WHERE org_id = ? AND expires < ?`, orgId, now);
      ctx.db.run(`DELETE FROM jobs WHERE org_id = ? AND status IN ('done','cancelled') AND updated < ?`, orgId, now - 7 * DAY);
      ctx.enqueue(orgId, 'core.cleanup', {}, { runAt: now + DAY, idemKey: 'core.cleanup' });
    });
  },

  seed(ctx, orgId) {
    const now = ctx.now();
    ctx.db.insert('orgs', {
      id: orgId, name: 'Northwind Robotics', slug: 'northwind', domain: 'northwind.io',
      logo_url: null, brand_color: '#5B4BE1', default_currency: 'usd',
      timezone: 'America/New_York', locale: 'en-US', clock_offset: 0,
      settings: JSON.stringify({ industry: 'Industrial automation', fiscal_year_start: 1 }),
      created: now - 420 * DAY, updated: now,
    });

    const team: [string, string, string, Role, string][] = [
      ['Dana Whitfield', 'dana@northwind.io', 'VP of Revenue Operations', 'owner', '#5B4BE1'],
      ['Marcus Ilori', 'marcus@northwind.io', 'Head of Sales', 'admin', '#12A0A0'],
      ['Priya Raman', 'priya@northwind.io', 'Account Executive', 'member', '#E08C00'],
      ['Sofia Alvarez', 'sofia@northwind.io', 'Customer Success Lead', 'member', '#D63F8F'],
      ['Tom Becker', 'tom@northwind.io', 'Support Engineer', 'member', '#2A7AE4'],
      ['Nina Kowalski', 'nina@northwind.io', 'Finance Analyst', 'analyst', '#17A862'],
    ];
    const password = hashPassword('demo1234');
    team.forEach(([name, email, title, role, color], i) => {
      const id = `usr_seed${String(i + 1).padStart(2, '0')}`;
      ctx.db.insert('users', {
        id, email, name, title, password_hash: password,
        avatar_url: `color:${color}`, created: now - (400 - i * 20) * DAY, updated: now,
        last_seen: now - i * 3_600_000,
      });
      ctx.db.insert('memberships', { id: `mem_seed${i}`, org_id: orgId, user_id: id, role, status: 'active', teams: JSON.stringify(role === 'analyst' ? ['Finance'] : i < 3 ? ['Sales'] : ['Customer Success']), created: now - 400 * DAY });
    });

    const secret = 'sk_test_ain_demo_workspace_key_0001';
    ctx.db.insert('api_keys', {
      id: 'ak_seed_demo', org_id: orgId, name: 'Demo integration key', prefix: 'sk_test',
      token_hash: sha(secret), last4: secret.slice(-4), scopes: JSON.stringify(['*']),
      livemode: 0, created_by: 'usr_seed01', created: now - 300 * DAY, last_used: now - 2 * 3_600_000, revoked_at: null,
    });

    ctx.jobs.enqueue(orgId, 'core.cleanup', {}, now, { runAt: now + DAY, idemKey: 'core.cleanup' });
  },

  routes(router, ctx) {
    /* ------------------------------- system ------------------------------ */
    router.get('/v1/health', () => ({
      object: 'health',
      status: 'ok',
      version: '1.0.0',
      time: ctx.now(),
      clock: { kind: ctx.clock.kind, offset_ms: ctx.clock.offset },
      modules: ctx.modules.length,
      routes: ctx.router.routes.length,
      jobs: ctx.jobs.stats(),
      ai: { provider: ctx.ai.active().id, tools: ctx.ai.tools().length },
    }), { auth: 'public', summary: 'Service health and runtime facts', tags: ['system'] });

    router.get('/openapi.json', () => buildOpenApi(ctx.router, {
      title: 'Ain API',
      version: '1.0.0',
      description: 'One API for the whole business: CRM records, conversations, automation, AI agents, subscriptions, usage, credits and invoices.',
    }), { auth: 'public', summary: 'OpenAPI 3.1 description of this API', tags: ['system'] });

    router.get('/v1/system/map', () => ({
      object: 'system_map',
      modules: ctx.modules.map((m) => ({
        name: m.name, title: m.title ?? m.name, description: m.description ?? null,
        depends_on: m.dependsOn ?? [],
        routes: ctx.router.routes.filter((r) => r.module === m.name).map((r) => `${r.method} ${r.path}`),
        tables: ctx.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).map((t) => t.name).filter(() => true).slice(0, 0),
      })),
      events: ctx.events.listSubscriptions(),
      jobs: ctx.jobs.registeredTypes(),
      tools: ctx.ai.tools().map((t) => ({ name: t.name, description: t.description, read_only: t.readOnly, tags: t.tags ?? [] })),
    }), { summary: 'How the platform is wired together', tags: ['system'] });

    /* -------------------------------- auth ------------------------------- */
    router.post('/v1/auth/login', (req: Req, c: Ctx) => {
      const { email, password } = req.body as { email: string; password: string };
      const user = c.db.get<UserRow>(`SELECT * FROM users WHERE email = ?`, email.toLowerCase());
      if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
        throw unauthorized('That email and password combination is not correct.');
      }
      // An invited seat is not a membership yet: the password behind it was
      // set by accepting the invitation, and only that acceptance activates
      // it. A person who holds a password from an earlier seat cannot walk
      // into a workspace that has merely invited them.
      const membership = c.db.get<{ org_id: string }>(`SELECT org_id FROM memberships WHERE user_id = ? AND status = 'active' LIMIT 1`, user.id);
      if (!membership) {
        const invited = c.db.get<{ name: string }>(
          `SELECT o.name FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? AND m.status = 'invited' LIMIT 1`, user.id);
        throw forbidden(invited
          ? `Your invitation to ${invited.name} has not been accepted yet — open the invitation link to set your password and join.`
          : 'This account is not a member of any workspace.');
      }
      const session = c.svc.core.createSession(membership.org_id, user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
      c.db.patch('users', 'id', user.id, { last_seen: c.now() });
      c.audit({ orgId: membership.org_id, actorId: user.id, actorType: 'user', action: 'auth.login', summary: `${user.name} signed in`, requestId: req.requestId, ip: req.ip });
      return httpStatus(200, { object: 'session', user: publicUser(user), org_id: membership.org_id, expires: session.expires }, sessionCookie(session.token, session.expires));
    }, {
      auth: 'public', summary: 'Sign in with email and password', tags: ['auth'],
      body: v.object({ email: v.email(), password: v.string({ min: 1, max: 200 }) }),
    });

    router.post('/v1/auth/demo', (req: Req, c: Ctx) => {
      const orgId = c.config.defaultOrgId;
      const seat = c.db.get<any>(
        `SELECT u.*, m.org_id FROM users u JOIN memberships m ON m.user_id = u.id
         WHERE m.org_id = ? AND m.status = 'active' ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END LIMIT 1`, orgId);
      if (!seat) throw notFound('demo workspace', orgId);
      const session = c.svc.core.createSession(orgId, seat.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
      return httpStatus(200, { object: 'session', user: publicUser(seat), org_id: orgId, expires: session.expires }, sessionCookie(session.token, session.expires));
    }, { auth: 'public', summary: 'Start a session in the demo workspace', tags: ['auth'] });

    /**
     * The invitation link, redeemed. This is the only route that turns an
     * invited seat into an active one: it proves possession of the email the
     * link was sent to, sets the password, and signs the person straight in
     * so the first thing they see is the workspace rather than a login form.
     * Every reason the link can be dead answers the same way, so a token
     * cannot be used to learn whether a seat exists.
     */
    router.post('/v1/auth/accept', (req: Req, c: Ctx) => {
      const { token, password } = req.body as { token: string; password: string };
      const invitation = c.db.get<InvitationRow>(`SELECT * FROM invitations WHERE token_hash = ?`, sha(token));
      const scope = currentOrgScope();
      if (invitation && scope) scope.orgId = invitation.org_id;
      const now = c.now();
      const seat = invitation
        ? c.db.get<{ id: string; role: Role; status: SeatStatus }>(`SELECT id, role, status FROM memberships WHERE org_id = ? AND user_id = ?`, invitation.org_id, invitation.user_id)
        : undefined;
      if (!invitation || !seat || invitation.accepted_at || invitation.voided_at || invitation.expires <= now) {
        throw badRequest('invitation_invalid', 'This invitation link is no longer valid — it may have been used already, replaced by a newer one, cancelled, or expired. Ask an admin of the workspace to send a fresh one.', 'token');
      }
      const user = c.svc.core.user(invitation.user_id);
      if (!user) throw badRequest('invitation_invalid', 'This invitation link is no longer valid.', 'token');
      c.atomic(() => {
        c.db.patch('users', 'id', user.id, { password_hash: hashPassword(password), updated: now, last_seen: now });
        c.db.patch('memberships', 'id', seat.id, { status: 'active' });
        c.db.patch('invitations', 'id', invitation.id, { accepted_at: now });
        c.audit({
          orgId: invitation.org_id, actorId: user.id, actorType: 'user', action: 'user.invitation_accepted',
          targetType: 'user', targetId: user.id, summary: `${user.name} accepted their invitation and set a password`,
          before: { status: seat.status }, after: { status: 'active', role: seat.role }, requestId: req.requestId, ip: req.ip,
        });
        c.emit(invitation.org_id, 'user.activated', { id: user.id, email: user.email, role: seat.role, status: 'active' },
          { objectId: user.id, objectType: 'user', previous: { status: seat.status }, actorId: user.id, actorType: 'user', requestId: req.requestId });
      });
      const session = c.svc.core.createSession(invitation.org_id, user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
      return httpStatus(200, {
        object: 'session', user: { ...publicUser({ ...user, last_seen: now }), role: seat.role, status: 'active' },
        org_id: invitation.org_id, expires: session.expires,
      }, sessionCookie(session.token, session.expires));
    }, {
      auth: 'public', summary: 'Accept an invitation: set a password and sign in', tags: ['auth'],
      description: 'The token comes from the invitation link an admin was shown once when they invited the teammate (or re-sent the invitation). Accepting activates the seat, sets the password and starts a session. A used, replaced, cancelled or expired link is refused with `invitation_invalid`.',
      body: v.object({ token: v.string({ min: 10, max: 200 }), password: v.string({ min: 8, max: 200 }) }, { strict: true }),
    });

    router.get('/v1/auth/invitations/:token', (req: Req, c: Ctx) => {
      const invitation = c.db.get<InvitationRow>(`SELECT * FROM invitations WHERE token_hash = ?`, sha(req.params.token));
      const scope = currentOrgScope();
      if (invitation && scope) scope.orgId = invitation.org_id;
      const seat = invitation
        ? c.db.get<{ role: Role; status: SeatStatus }>(`SELECT role, status FROM memberships WHERE org_id = ? AND user_id = ?`, invitation.org_id, invitation.user_id)
        : undefined;
      if (!invitation || !seat || invitation.accepted_at || invitation.voided_at || invitation.expires <= c.now()) {
        throw badRequest('invitation_invalid', 'This invitation link is no longer valid — it may have been used already, replaced by a newer one, cancelled, or expired. Ask an admin of the workspace to send a fresh one.', 'token');
      }
      const user = c.svc.core.user(invitation.user_id);
      const org = c.svc.core.org(invitation.org_id);
      const inviter = invitation.invited_by ? c.svc.core.user(invitation.invited_by) : undefined;
      return {
        ...publicInvitation(invitation),
        email: user?.email ?? null, name: user?.name ?? null, role: seat.role,
        org: { id: org.id, name: org.name, logo_url: org.logo_url, brand_color: org.brand_color },
        invited_by: inviter ? { id: inviter.id, name: inviter.name } : null,
      };
    }, {
      auth: 'public', summary: 'What an invitation link is for, before it is accepted', tags: ['auth'],
      description: 'Lets the accept screen say who invited whom to which workspace. Answers `invitation_invalid` for a link that can no longer be accepted.',
    });

    router.post('/v1/auth/logout', (req: Req, c: Ctx) => {
      const cookie = (req.headers['cookie'] || '').split(';').map((s) => s.trim().split('=')).find(([k]) => k === 'ain_session');
      if (cookie?.[1]) c.db.run(`DELETE FROM sessions WHERE token_hash = ?`, sha(decodeURIComponent(cookie[1])));
      return httpStatus(200, { object: 'session', deleted: true }, { 'set-cookie': 'ain_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    }, { auth: 'public', summary: 'End the current session', tags: ['auth'] });

    router.get('/v1/me', (req: Req, c: Ctx) => {
      const org = c.svc.core.org(req.auth.orgId);
      const user = req.auth.userId ? c.svc.core.user(req.auth.userId) : undefined;
      return {
        object: 'me',
        user: user ? publicUser(user) : null,
        role: req.auth.role,
        auth_kind: req.auth.kind,
        org: publicOrg(org),
        clock: { kind: c.clock.kind, offset_ms: c.clock.offset, now: c.now() },
        teammates: c.svc.core.users(org.id).map((u) => ({ id: u.id, name: u.name, email: u.email, avatar_url: u.avatar_url, title: u.title, role: u.role, status: u.status })),
      };
    }, { summary: 'The signed-in user, their role and their workspace', tags: ['auth'] });

    /* --------------------------- org and people -------------------------- */
    router.patch('/v1/org', (req: Req, c: Ctx) => {
      const before = c.svc.core.org(req.auth.orgId);
      const patch = req.body as Record<string, unknown>;
      const changes: Record<string, any> = { updated: c.now() };
      for (const key of ['name', 'domain', 'logo_url', 'brand_color', 'default_currency', 'timezone', 'locale'] as const) {
        if (patch[key] !== undefined) changes[key] = patch[key];
      }
      if (patch.settings !== undefined) changes.settings = JSON.stringify({ ...parseJson<Record<string, unknown>>(before.settings, {}), ...(patch.settings as object) });
      const actor = actorOf(c, req.auth);
      const previous = Object.fromEntries(Object.keys(changes).filter((k) => k !== 'updated').map((k) => [k, before[k as keyof OrgRow]]));
      c.atomic(() => {
        c.db.patch('orgs', 'id', before.id, changes);
        c.audit({ orgId: before.id, ...actor, action: 'org.updated', targetType: 'org', targetId: before.id, summary: 'Workspace settings updated', before: previous, after: changes, requestId: req.requestId });
        c.emit(before.id, 'org.updated', publicOrg(c.svc.core.org(before.id)), { objectId: before.id, objectType: 'org', previous, ...actor, requestId: req.requestId });
      });
      return publicOrg(c.svc.core.org(before.id));
    }, {
      summary: 'Update workspace settings', tags: ['settings'], roles: ['admin'],
      body: v.object({
        name: v.optional(v.string({ min: 1, max: 120 })),
        domain: v.optional(v.nullable(workspaceDomain())),
        logo_url: v.optional(v.string({ max: 500 })),
        brand_color: v.optional(v.string({ pattern: /^#[0-9a-fA-F]{6}$/ })),
        default_currency: v.optional(v.currency()),
        timezone: v.optional(v.string({ max: 60 })),
        locale: v.optional(v.string({ max: 20 })),
        settings: v.optional(v.record(v.any())),
      }),
    });

    router.get('/v1/users', (req: Req, c: Ctx) =>
      list(c.svc.core.users(req.auth.orgId).map((u) => {
        const pending = u.status === 'invited' ? pendingInvitation(c, req.auth.orgId, u.id) : undefined;
        return { ...publicUser(u), role: u.role, teams: u.teams, status: u.status, invitation: pending ? publicInvitation(pending) : null };
      })),
      {
        summary: 'List workspace members', tags: ['settings'],
        description: 'Every seat, with its `status`: `invited` until the person accepts the invitation and sets a password, `active` after. An invited seat carries its pending `invitation` (never the token — that was shown once, when it was minted).',
      });

    /**
     * Inviting a teammate creates the seat as `invited` and answers with the
     * invitation token exactly once — the same rule as an API key secret.
     * Nothing about the seat lets anyone sign in until `POST /v1/auth/accept`
     * redeems that token: a person who already holds a password from an
     * earlier seat is invited afresh, not let straight back in.
     */
    router.post('/v1/users', (req: Req, c: Ctx) => {
      const body = req.body as { email: string; name: string; role: Role; title?: string };
      assertMayGrant(req, body.role);
      const actor = actorOf(c, req.auth);
      const now = c.now();
      const outcome = c.atomic(() => {
        const existing = c.db.get<UserRow>(`SELECT * FROM users WHERE email = ?`, body.email);
        const userId = existing?.id ?? newId('user');
        if (!existing) {
          c.db.insert('users', { id: userId, email: body.email, name: body.name, title: body.title ?? null, avatar_url: null, password_hash: null, created: now, updated: now, last_seen: null });
        }
        const member = c.db.get<{ status: SeatStatus }>(`SELECT status FROM memberships WHERE org_id = ? AND user_id = ?`, req.auth.orgId, userId);
        if (member) {
          throw badRequest('member_exists', member.status === 'invited'
            ? `${body.email} already has a pending invitation to this workspace. Resend it rather than inviting them again.`
            : `${body.email} is already a member of this workspace.`, 'email');
        }
        c.db.insert('memberships', { id: newId('user'), org_id: req.auth.orgId, user_id: userId, role: body.role, status: 'invited', teams: '[]', created: now });
        const invitation = mintInvitation(c, req.auth.orgId, userId, actor.actorType === 'user' ? actor.actorId : null, now);
        c.audit({
          orgId: req.auth.orgId, ...actor, action: 'user.invited', targetType: 'user', targetId: userId,
          summary: `Invited ${body.email} as ${body.role}`, after: { role: body.role, status: 'invited', invitation_expires: invitation.row.expires },
          requestId: req.requestId, ip: req.ip,
        });
        c.emit(req.auth.orgId, 'user.invited', { id: userId, email: body.email, role: body.role, status: 'invited', invitation: publicInvitation(invitation.row) },
          { objectId: userId, objectType: 'user', ...actor, requestId: req.requestId });
        return { userId, invitation };
      });
      return created({
        ...publicUser(c.svc.core.user(outcome.userId)!), role: body.role, teams: [] as string[], status: 'invited' as const,
        invitation: { ...publicInvitation(outcome.invitation.row), token: outcome.invitation.token },
      });
    }, {
      summary: 'Invite a teammate (the invitation token is returned exactly once)', tags: ['settings'], roles: ['admin'],
      description: 'Creates the seat with status `invited` and returns `invitation.token`, the one-time secret behind the invitation link. It is stored hashed and never shown again; `POST /v1/users/:id/reinvite` mints a fresh one and voids this one. The seat becomes `active` when the person redeems the token with `POST /v1/auth/accept`.',
      body: v.object({
        email: v.email(), name: v.string({ min: 1, max: 120 }),
        role: v.default(v.enum(['owner', 'admin', 'member', 'analyst', 'readonly'] as const), 'member'),
        title: v.optional(v.string({ max: 120 })),
      }),
    });

    router.post('/v1/users/:id/reinvite', (req: Req, c: Ctx) => {
      const member = c.db.get<{ id: string; role: Role; status: SeatStatus }>(`SELECT id, role, status FROM memberships WHERE org_id = ? AND user_id = ?`, req.auth.orgId, req.params.id);
      if (!member) throw notFound('user', req.params.id);
      const user = c.svc.core.user(req.params.id)!;
      // A fresh link is a fresh grant of the seat's role, so the same ceiling
      // applies as when the seat was first offered.
      assertMayGrant(req, member.role);
      if (member.status !== 'invited') {
        throw conflict('seat_active', `${user.name} has already accepted their invitation and can sign in — there is nothing to resend.`, { status: member.status });
      }
      const actor = actorOf(c, req.auth);
      const now = c.now();
      const invitation = c.atomic(() => {
        const minted = mintInvitation(c, req.auth.orgId, user.id, actor.actorType === 'user' ? actor.actorId : null, now);
        c.audit({
          orgId: req.auth.orgId, ...actor, action: 'user.reinvited', targetType: 'user', targetId: user.id,
          summary: `Re-sent the invitation to ${user.email} — the previous link no longer works`,
          after: { role: member.role, status: 'invited', invitation_expires: minted.row.expires }, requestId: req.requestId, ip: req.ip,
        });
        c.emit(req.auth.orgId, 'user.reinvited', { id: user.id, email: user.email, role: member.role, status: 'invited', invitation: publicInvitation(minted.row) },
          { objectId: user.id, objectType: 'user', ...actor, requestId: req.requestId });
        return minted;
      });
      return created({
        ...publicUser(user), role: member.role, teams: [] as string[], status: 'invited' as const,
        invitation: { ...publicInvitation(invitation.row), token: invitation.token },
      });
    }, {
      summary: 'Re-send an invitation: a fresh token, the old one voided', tags: ['settings'], roles: ['admin'],
      description: 'Only an `invited` seat can be re-invited; an active one answers `seat_active`. The new token is returned exactly once, as on the original invitation.',
    });

    router.patch('/v1/users/:id', (req: Req, c: Ctx) => {
      const body = req.body as { role?: Role; name?: string; title?: string; teams?: string[] };
      const member = c.db.get<any>(`SELECT * FROM memberships WHERE org_id = ? AND user_id = ?`, req.auth.orgId, req.params.id);
      if (!member) throw notFound('user', req.params.id);
      if (body.role) {
        // The ceiling: an admin may not seat an owner, including themselves.
        assertMayGrant(req, body.role);
        // …and may not take a role away from someone above them either, which
        // is the same rule read from the other end. Without it an admin could
        // not promote themselves to owner but could still demote the owner to
        // readonly and be the highest rung left.
        assertMayGrant(req, member.role as Role);
        assertKeepsAnAdmin(c, req.auth.orgId, req.params.id, body.role);
      }
      if (body.role || body.teams) {
        c.db.patch('memberships', 'id', member.id, {
          ...(body.role ? { role: body.role } : {}),
          ...(body.teams ? { teams: JSON.stringify(body.teams) } : {}),
        });
      }
      if (body.name || body.title) c.db.patch('users', 'id', req.params.id, { ...(body.name ? { name: body.name } : {}), ...(body.title ? { title: body.title } : {}), updated: c.now() });
      if (body.role && body.role !== member.role) {
        const actor = actorOf(c, req.auth);
        c.audit({
          orgId: req.auth.orgId, ...actor, action: 'user.role_changed',
          targetType: 'user', targetId: req.params.id, summary: `Role changed from ${member.role} to ${body.role}`,
          before: { role: member.role }, after: { role: body.role }, requestId: req.requestId, ip: req.ip,
        });
        c.emit(req.auth.orgId, 'user.role_changed', { id: req.params.id, role: body.role, previous: member.role },
          { objectId: req.params.id, objectType: 'user', previous: { role: member.role }, ...actor, requestId: req.requestId });
      }
      return { ...publicUser(c.svc.core.user(req.params.id)!), role: body.role ?? member.role, status: member.status as SeatStatus };
    }, {
      summary: 'Update a teammate', tags: ['settings'], roles: ['admin'],
      body: v.object({
        role: v.optional(v.enum(['owner', 'admin', 'member', 'analyst', 'readonly'] as const)),
        name: v.optional(v.string({ min: 1, max: 120 })),
        title: v.optional(v.string({ max: 120 })),
        teams: v.optional(v.array(v.string({ max: 60 }))),
      }),
    });

    /**
     * Removing a teammate ends every credential they hold. It is not a hold.
     *
     * The live-membership check in `authenticate` refuses both doors the
     * moment the membership row goes, which reads exactly like revocation —
     * until the seat comes back. A different admin re-inviting the same
     * address as `readonly`, believing they are creating a fresh minimal seat,
     * revived the departed employee's laptop cookie and their never-revoked
     * `['*']` CI key against it, and promoting that seat later handed the key
     * `admin` again with `revoked_at` still NULL. So the sessions are deleted
     * and the keys are revoked here, and the door check goes back to being
     * defence in depth rather than the only defence.
     */
    router.del('/v1/users/:id', (req: Req, c: Ctx) => {
      const member = c.db.get<{ role: Role; status: SeatStatus }>(`SELECT role, status FROM memberships WHERE org_id = ? AND user_id = ?`, req.auth.orgId, req.params.id);
      if (!member) throw notFound('user', req.params.id);
      // Removing yourself is instantly unrecoverable now that a session is only
      // as live as its membership — and through a key it is not even obvious
      // that is what you are doing, so the principal is resolved either way.
      if (req.params.id === principalOf(c, req.auth)) {
        throw forbidden('You cannot remove your own membership — you would be signed out of this workspace with no way back in. Ask another admin to remove you.');
      }
      assertMayGrant(req, member.role);
      assertKeepsAnAdmin(c, req.auth.orgId, req.params.id, null);

      const actor = actorOf(c, req.auth);
      const user = c.svc.core.user(req.params.id);
      c.atomic(() => {
        const now = c.now();
        c.db.run(`DELETE FROM memberships WHERE org_id = ? AND user_id = ?`, req.auth.orgId, req.params.id);
        const invitations = c.db.run(
          `UPDATE invitations SET voided_at = ? WHERE org_id = ? AND user_id = ? AND accepted_at IS NULL AND voided_at IS NULL`,
          now, req.auth.orgId, req.params.id,
        ).changes;
        const sessions = c.db.run(`DELETE FROM sessions WHERE org_id = ? AND user_id = ?`, req.auth.orgId, req.params.id).changes;
        const keys = c.db.run(
          `UPDATE api_keys SET revoked_at = ? WHERE org_id = ? AND created_by = ? AND revoked_at IS NULL`,
          now, req.auth.orgId, req.params.id,
        ).changes;
        // Cancelling an invitation and removing a member are different things
        // to read back: one never had access, the other had it taken away.
        const cancelled = member.status === 'invited';
        c.audit({
          orgId: req.auth.orgId, ...actor, action: cancelled ? 'user.invitation_cancelled' : 'user.removed',
          targetType: 'user', targetId: req.params.id,
          summary: cancelled
            ? `Cancelled the invitation to ${user?.email ?? req.params.id} — the link no longer works`
            : `Removed from workspace — ${sessions} ${sessions === 1 ? 'session' : 'sessions'} ended, ${keys} API ${keys === 1 ? 'key' : 'keys'} revoked`,
          before: { role: member.role, status: member.status },
          after: { status: 'removed', sessions_ended: sessions, api_keys_revoked: keys, invitations_voided: invitations },
          requestId: req.requestId, ip: req.ip,
        });
        c.emit(req.auth.orgId, cancelled ? 'user.invitation_cancelled' : 'user.removed', {
          id: req.params.id, role: member.role, status: 'removed', sessions_ended: sessions, api_keys_revoked: keys, invitations_voided: invitations,
        }, { objectId: req.params.id, objectType: 'user', previous: { status: member.status }, ...actor, requestId: req.requestId });
      });
      return noContent();
    }, {
      summary: 'Remove a teammate, ending their sessions and revoking their API keys', tags: ['settings'], roles: ['admin'],
      description: 'On an `invited` seat this cancels the invitation and voids its link. On an `active` seat it removes the membership, ends every session and revokes every API key the person created.',
    });

    /* ------------------------------ API keys ----------------------------- */
    router.get('/v1/api-keys', (req: Req, c: Ctx) =>
      list(c.db.all<any>(`SELECT * FROM api_keys WHERE org_id = ? ORDER BY created DESC`, req.auth.orgId).map(publicKey)),
      { summary: 'List API keys', tags: ['developers'], roles: ['admin'] });

    /**
     * A key inherits the principal and the reach of whatever minted it.
     *
     * `created_by` used to be `auth.userId`, which an API key has not got, so
     * one ordinary call — mint a key, then mint a key *with* it — produced an
     * unattributed credential, and `authenticate` has no membership to ask
     * about a key with no author. `DELETE /v1/users/:id` was one API call away
     * from meaning nothing: the departing admin's grandchild key kept
     * answering `role: admin`, moved the workspace clock and seated a new
     * owner. Authorship is transitive because authority is: every key
     * descended from a human dies with that human's membership, and only a key
     * with genuinely no person behind it — one a migration or a fixture puts
     * there — stays a workspace credential whose kill switch is `revoked_at`.
     *
     * The scopes are bounded the same way. `keyRole` reads the ladder off what
     * a key asked for, so a key that could mint a wider child than itself
     * would be a promotion by another name.
     */
    router.post('/v1/api-keys', (req: Req, c: Ctx) => {
      const body = req.body as { name: string; livemode: boolean; scopes: string[] };
      const minter = req.auth.keyId
        ? parseJson<string[]>(c.db.pluck<string>(`SELECT scopes FROM api_keys WHERE id = ? AND org_id = ?`, req.auth.keyId, req.auth.orgId) ?? '["*"]', ['*'])
        : null;
      if (minter && !minter.includes('*')) {
        const wider = body.scopes.filter((scope) => !minter.includes(scope));
        if (wider.length) {
          throw forbidden(`This API key holds ${minter.join(', ')}, so it cannot mint a key with ${wider.join(', ')}. A key may never issue more reach than it has.`);
        }
      }
      const prefix = body.livemode ? 'sk_live' : 'sk_test';
      const secret = `${prefix}_${randomBytes(24).toString('base64url')}`;
      const row = {
        id: newId('apikey'), org_id: req.auth.orgId, name: body.name, prefix,
        token_hash: sha(secret), last4: secret.slice(-4), scopes: JSON.stringify(body.scopes),
        livemode: body.livemode ? 1 : 0, created_by: principalOf(c, req.auth), created: c.now(), last_used: null, revoked_at: null,
      };
      c.db.insert('api_keys', row);
      c.audit({ orgId: req.auth.orgId, ...actorOf(c, req.auth), action: 'api_key.created', targetType: 'api_key', targetId: row.id, summary: `Created API key "${body.name}"`, requestId: req.requestId, ip: req.ip });
      return created({ ...publicKey(row), secret });
    }, {
      summary: 'Create an API key (the secret is returned exactly once)', tags: ['developers'], roles: ['admin'],
      body: v.object({
        name: v.string({ min: 1, max: 80 }),
        livemode: v.default(v.boolean(), false),
        scopes: v.default(v.array(v.string({ max: 60 })), ['*']),
      }),
    });

    router.del('/v1/api-keys/:id', (req: Req, c: Ctx) => {
      const changed = c.db.run(`UPDATE api_keys SET revoked_at = ? WHERE org_id = ? AND id = ? AND revoked_at IS NULL`, c.now(), req.auth.orgId, req.params.id).changes;
      if (!changed) throw notFound('api key', req.params.id);
      c.audit({ orgId: req.auth.orgId, ...actorOf(c, req.auth), action: 'api_key.revoked', targetType: 'api_key', targetId: req.params.id, summary: 'Revoked API key', requestId: req.requestId, ip: req.ip });
      return noContent();
    }, { summary: 'Revoke an API key', tags: ['developers'], roles: ['admin'] });

    /* ------------------------- events, jobs, audit ----------------------- */
    router.get('/v1/events', (req: Req, c: Ctx) => {
      const q = req.query as any;
      const events = c.events.list(req.auth.orgId, {
        types: q.type ? String(q.type).split(',') : undefined,
        objectId: q.object_id, limit: Number(q.limit || 50),
      });
      return list(events, { hasMore: events.length === Number(q.limit || 50) });
    }, {
      summary: 'List platform events', tags: ['developers'],
      query: v.object({ type: v.optional(v.string({ max: 200 })), object_id: v.optional(v.string({ max: 80 })), limit: v.optional(v.int({ min: 1, max: 200 })) }),
    });

    router.get('/v1/events/:id', (req: Req, c: Ctx) => {
      const evt = c.events.find(req.auth.orgId, req.params.id);
      if (!evt) throw notFound('event', req.params.id);
      return evt;
    }, { summary: 'Retrieve one event', tags: ['developers'] });

    router.get('/v1/jobs', (req: Req, c: Ctx) => {
      const q = req.query as { status?: string; limit?: number };
      const where = `org_id = ? ${q.status ? 'AND status = ?' : ''}`;
      const params = [req.auth.orgId, ...(q.status ? [q.status] : [])];
      const limit = Number(q.limit || 50);
      const rows = c.db.all<any>(`SELECT * FROM jobs WHERE ${where} ORDER BY run_at DESC LIMIT ?`, ...params, limit)
        .map((r) => ({ object: 'job', ...r, payload: parseJson(r.payload, {}) }));
      // The count answers the same question as the page: `?status=failed`
      // used to report the pending total against a list of failures.
      const totalCount = c.db.count(`SELECT COUNT(*) FROM jobs WHERE ${where}`, ...params);
      return list(rows, { totalCount, hasMore: rows.length < totalCount });
    }, {
      summary: 'Inspect the durable job queue', tags: ['developers'],
      query: v.object({ status: v.optional(v.enum(['pending', 'running', 'done', 'failed', 'cancelled'] as const)), limit: v.optional(v.int({ min: 1, max: 200 })) }),
    });

    router.post('/v1/jobs/:id/retry', (req: Req, c: Ctx) => {
      const job = c.db.get<{ id: string; type: string; status: string; attempts: number; last_error: string | null }>(
        `SELECT id, type, status, attempts, last_error FROM jobs WHERE org_id = ? AND id = ?`, req.auth.orgId, req.params.id);
      if (!job) throw notFound('job', req.params.id);
      if (job.status !== 'failed') {
        throw conflict('job_not_failed', `Only a failed job can be retried — this one is ${job.status}.`, { status: job.status });
      }
      const actor = actorOf(c, req.auth);
      const requeued = c.atomic(() => {
        const row = c.jobs.retry(req.auth.orgId, job.id, c.now());
        if (!row) throw conflict('job_not_failed', 'This job is no longer failed.', { status: job.status });
        c.audit({
          orgId: req.auth.orgId, ...actor, action: 'job.retried', targetType: 'job', targetId: job.id,
          summary: `Retried the ${humanise(job.type)} job after ${job.attempts} failed ${job.attempts === 1 ? 'attempt' : 'attempts'}`,
          before: { status: 'failed', attempts: job.attempts, last_error: job.last_error }, after: { status: row.status, run_at: row.run_at },
          requestId: req.requestId, ip: req.ip,
        });
        c.emit(req.auth.orgId, 'job.retried', { id: job.id, type: job.type, attempts: job.attempts, last_error: job.last_error, run_at: row.run_at },
          { objectId: job.id, objectType: 'job', previous: { status: 'failed' }, ...actor, requestId: req.requestId });
        return row;
      });
      return { object: 'job', ...requeued };
    }, {
      summary: 'Put a failed job back on the queue, due now', tags: ['developers'], roles: ['admin'],
      description: 'The attempt count is kept, so the retry is one more try rather than a fresh ladder of backoffs: if it fails again the job goes straight back to `failed`. Anything not currently failed answers `job_not_failed`.',
    });

    router.get('/v1/audit-log', (req: Req, c: Ctx) => {
      const q = req.query as any;
      const rows = c.db.all<any>(
        `SELECT * FROM audit_log WHERE org_id = ? ${q.target_id ? 'AND target_id = ?' : ''} ORDER BY created DESC LIMIT ?`,
        req.auth.orgId, ...(q.target_id ? [q.target_id] : []), Number(q.limit || 100),
      ).map((r) => ({ ...r, before: parseJson(r.before, null), after: parseJson(r.after, null) }));
      return list(rows);
    }, {
      summary: 'Read the audit trail', tags: ['settings'], roles: ['admin'],
      query: v.object({ target_id: v.optional(v.string({ max: 80 })), limit: v.optional(v.int({ min: 1, max: 500 })) }),
    });

    /* ---------------------------- time machine --------------------------- */
    router.post('/v1/time/advance', async (req: Req, c: Ctx) => {
      if (c.clock.kind !== 'virtual') throw badRequest('clock_not_virtual', 'This workspace runs on the real clock.');
      const body = req.body as { days?: number; hours?: number; to?: number };
      const before = c.now();
      // The clock is moved *by* the replay, not before it. Jumping straight to
      // the target and draining once ran every job that had been waiting with
      // `ctx.now()` reading the far end of the jump — see `drainUntil`.
      const target = body.to ? body.to : before + (body.days ?? 0) * DAY + (body.hours ?? 0) * 3_600_000;
      const worked = await drainUntil(c, target);
      const org = c.svc.core.org(req.auth.orgId);
      // Where the clock landed is read once. The offset is fixed but the wall
      // clock under it is not, so asking three times — for the sentence, for
      // the audit row and for the answer — reports three instants that differ
      // by whatever the drain's last milliseconds cost, and the trail then
      // disagrees with the receipt the operator was handed.
      const now = c.now();
      const landed = formatDateTime(now, { locale: org.locale, timeZone: org.timezone });
      c.audit({
        orgId: req.auth.orgId, ...actorOf(c, req.auth), action: 'time.advanced',
        summary: `Advanced the workspace clock to ${landed} — ${worked.ran} ${worked.ran === 1 ? 'job' : 'jobs'} run, ${worked.failed} failed`,
        before: { now: before }, after: { now, jobs_run: worked.ran, jobs_failed: worked.failed },
        requestId: req.requestId, ip: req.ip,
      });
      return { object: 'clock', now, previous: before, offset_ms: c.clock.offset, jobs_run: worked.ran, jobs_failed: worked.failed };
    }, {
      summary: 'Move the workspace clock forward and run everything that becomes due', tags: ['system'], roles: ['admin'],
      description: 'The time machine replays renewals, dunning, credit expiry, workflow delays and scheduled agent runs exactly as they would happen.',
      body: v.object({ days: v.optional(v.int({ min: 0, max: 3650 })), hours: v.optional(v.int({ min: 0, max: 100000 })), to: v.optional(v.timestamp()) }),
    });

    router.post('/v1/time/reset', (req: Req, c: Ctx) => {
      if (c.clock.kind !== 'virtual') throw badRequest('clock_not_virtual', 'This workspace runs on the real clock.');
      c.clock.set(Date.now());
      return { object: 'clock', now: c.now(), offset_ms: c.clock.offset };
    }, { summary: 'Return the workspace clock to real time', tags: ['system'], roles: ['admin'] });

    router.post('/v1/jobs/drain', async (_req, c: Ctx) => {
      const r = await c.jobs.drain(() => c.now());
      return { object: 'job_drain', ...r, pending: c.jobs.pendingCount() };
    }, { summary: 'Run every due job now', tags: ['developers'], roles: ['admin'] });
  },
});

/**
 * Replay one workspace's queue up to `target`, the way it would have happened.
 *
 * Two things have to hold, and this is the only place the *product's* time
 * machine can hold them — `app.travel` is the harness the tests drive, not the
 * button an operator presses.
 *
 * 1. Every job runs at its own `run_at`, so the clock is stepped forward to
 *    each due batch before that batch is drained. Setting the clock to the
 *    target first and draining once made `ctx.now()` read the far end of the
 *    jump for work that came due on day 1: a year of renewals, credit
 *    settlements and usage rollups were priced and dated a year late, and every
 *    job that books its own next attempt relative to `now` — a dunning retry, a
 *    grant expiry — landed *past* the target and was left pending, so the
 *    advance under-ran the work it reported having run.
 * 2. The question "what is due next" is asked of the caller's own workspace.
 *    `ctx.jobs` is already narrowed by `withAuth`; asking the whole `jobs`
 *    table instead let another tenant's pending row decide where this
 *    workspace's clock stopped next.
 *
 * A target in the past is still honoured — `to` may point backwards — but no
 * step ever moves the clock backwards to get there: the loop only walks
 * forward, and the final `set` lands exactly on the target.
 */
async function drainUntil(ctx: Ctx, target: number): Promise<{ ran: number; failed: number }> {
  let ran = 0, failed = 0, guard = 0;
  while (guard++ < 5000) {
    const next = ctx.jobs.nextRunAt();
    if (next === null || next > target) break;
    // One read of the clock decides both the step and whether there was one:
    // `ctx.now()` tracks wall time under the offset, so asking twice can answer
    // twice and turn "no step" into a step of a millisecond.
    const now = ctx.now();
    const at = Math.max(next, now);
    if (at > target) break;
    const stepped = at > now;
    if (stepped) ctx.clock.set(at);
    const r = await ctx.jobs.drain(() => ctx.now());
    ran += r.ran; failed += r.failed;
    // Nothing ran and the clock did not move: the queue cannot make progress
    // toward the target, so stop rather than spin to the guard.
    if (!stepped && r.ran === 0 && r.failed === 0) break;
  }
  ctx.clock.set(target);
  const r = await ctx.jobs.drain(() => ctx.now());
  return { ran: ran + r.ran, failed: failed + r.failed };
}

const sessionCookie = (token: string, expires: number): Record<string, string> => ({
  'set-cookie': `ain_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expires - Date.now()) / 1000)}`,
});

export const publicUser = (u: UserRow) => ({
  object: 'user' as const, id: u.id, email: u.email, name: u.name,
  avatar_url: u.avatar_url, title: u.title, created: u.created, last_seen: u.last_seen,
});

export const publicOrg = (o: OrgRow) => ({
  object: 'organization' as const, id: o.id, name: o.name, slug: o.slug, domain: o.domain,
  logo_url: o.logo_url, brand_color: o.brand_color, default_currency: o.default_currency,
  timezone: o.timezone, locale: o.locale, settings: parseJson<Record<string, unknown>>(o.settings, {}),
  created: o.created,
});

const publicKey = (k: any) => ({
  object: 'api_key' as const, id: k.id, name: k.name, prefix: k.prefix, last4: k.last4,
  scopes: parseJson<string[]>(k.scopes, ['*']), livemode: !!k.livemode,
  created: k.created, last_used: k.last_used, revoked_at: k.revoked_at,
  masked: `${k.prefix}_${'•'.repeat(20)}${k.last4}`,
});
