import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { defineModule } from '../../kernel/module';
import type { Ctx } from '../../kernel/context';
import { buildOpenApi, created, list, noContent, status as httpStatus, type Req, type Role } from '../../kernel/http';
import { badRequest, forbidden, notFound, unauthorized } from '../../../shared/errors';
import { newId, randomId } from '../../../shared/ids';
import { parseJson } from '../../kernel/db';
import v from '../../../shared/validate';
import { DAY } from '../../../shared/time';

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

export interface CoreService {
  org(orgId: string): OrgRow;
  user(userId: string): UserRow | undefined;
  users(orgId: string): (UserRow & { role: Role; teams: string[] })[];
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
          `SELECT u.*, m.role, m.teams FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ? ORDER BY u.name`,
          orgId,
        ).map((r) => ({ ...r, teams: parseJson<string[]>(r.teams, []) }));
      },
      setting(orgId, key, fallback) {
        const row = ctx.db.get<{ value: string }>(`SELECT value FROM settings WHERE org_id = ? AND key = ?`, orgId, key);
        return row ? parseJson(row.value, fallback) : fallback;
      },
      setSetting(orgId, key, value) {
        ctx.db.upsert('settings', { org_id: orgId, key, value: JSON.stringify(value), updated: ctx.now() }, ['org_id', 'key']);
      },
      createSession(orgId, userId, meta = {}) {
        const token = randomId('sess', 32);
        const expires = ctx.now() + 30 * DAY;
        ctx.db.insert('sessions', {
          id: newId('session'), org_id: orgId, user_id: userId, token_hash: sha(token),
          expires, created: ctx.now(), ip: meta.ip ?? null, user_agent: meta.userAgent ?? null,
        });
        return { token, expires };
      },
      currency(orgId) {
        return ctx.db.pluck<string>(`SELECT default_currency FROM orgs WHERE id = ?`, orgId) || 'usd';
      },
    };
    ctx.provide('core', service);

    ctx.jobs.handle('core.cleanup', () => {
      const now = ctx.now();
      ctx.db.run(`DELETE FROM sessions WHERE expires < ?`, now);
      ctx.db.run(`DELETE FROM idempotency_keys WHERE expires < ?`, now);
      ctx.db.run(`DELETE FROM jobs WHERE status IN ('done','cancelled') AND updated < ?`, now - 7 * DAY);
      ctx.enqueue(ctx.config.defaultOrgId, 'core.cleanup', {}, { runAt: now + DAY, idemKey: 'core.cleanup' });
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
      ctx.db.insert('memberships', { id: `mem_seed${i}`, org_id: orgId, user_id: id, role, teams: JSON.stringify(role === 'analyst' ? ['Finance'] : i < 3 ? ['Sales'] : ['Customer Success']), created: now - 400 * DAY });
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
      const membership = c.db.get<{ org_id: string }>(`SELECT org_id FROM memberships WHERE user_id = ? LIMIT 1`, user.id);
      if (!membership) throw forbidden('This account is not a member of any workspace.');
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
         WHERE m.org_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END LIMIT 1`, orgId);
      if (!seat) throw notFound('demo workspace', orgId);
      const session = c.svc.core.createSession(orgId, seat.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
      return httpStatus(200, { object: 'session', user: publicUser(seat), org_id: orgId, expires: session.expires }, sessionCookie(session.token, session.expires));
    }, { auth: 'public', summary: 'Start a session in the demo workspace', tags: ['auth'] });

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
        teammates: c.svc.core.users(org.id).map((u) => ({ id: u.id, name: u.name, email: u.email, avatar_url: u.avatar_url, title: u.title, role: u.role })),
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
      c.db.patch('orgs', 'id', before.id, changes);
      c.audit({ orgId: before.id, actorId: req.auth.userId, actorType: 'user', action: 'org.updated', targetType: 'org', targetId: before.id, summary: 'Workspace settings updated', before, after: changes, requestId: req.requestId });
      return publicOrg(c.svc.core.org(before.id));
    }, {
      summary: 'Update workspace settings', tags: ['settings'], roles: ['admin'],
      body: v.object({
        name: v.optional(v.string({ min: 1, max: 120 })),
        domain: v.optional(v.string({ max: 200 })),
        logo_url: v.optional(v.string({ max: 500 })),
        brand_color: v.optional(v.string({ pattern: /^#[0-9a-fA-F]{6}$/ })),
        default_currency: v.optional(v.currency()),
        timezone: v.optional(v.string({ max: 60 })),
        locale: v.optional(v.string({ max: 20 })),
        settings: v.optional(v.record(v.any())),
      }),
    });

    router.get('/v1/users', (req: Req, c: Ctx) =>
      list(c.svc.core.users(req.auth.orgId).map((u) => ({ ...publicUser(u), role: u.role, teams: u.teams }))),
      { summary: 'List workspace members', tags: ['settings'] });

    router.post('/v1/users', (req: Req, c: Ctx) => {
      const body = req.body as { email: string; name: string; role: Role; title?: string };
      const existing = c.db.get<UserRow>(`SELECT * FROM users WHERE email = ?`, body.email);
      const now = c.now();
      const userId = existing?.id ?? newId('user');
      if (!existing) {
        c.db.insert('users', { id: userId, email: body.email, name: body.name, title: body.title ?? null, avatar_url: null, password_hash: null, created: now, updated: now, last_seen: null });
      }
      const member = c.db.get<any>(`SELECT id FROM memberships WHERE org_id = ? AND user_id = ?`, req.auth.orgId, userId);
      if (member) throw badRequest('member_exists', `${body.email} is already a member of this workspace.`, 'email');
      c.db.insert('memberships', { id: newId('user'), org_id: req.auth.orgId, user_id: userId, role: body.role, teams: '[]', created: now });
      c.audit({ orgId: req.auth.orgId, actorId: req.auth.userId, actorType: 'user', action: 'user.invited', targetType: 'user', targetId: userId, summary: `Invited ${body.email} as ${body.role}`, requestId: req.requestId });
      c.emit(req.auth.orgId, 'user.invited', { id: userId, email: body.email, role: body.role }, { objectId: userId, objectType: 'user' });
      return created({ ...publicUser(c.svc.core.user(userId)!), role: body.role });
    }, {
      summary: 'Invite a teammate', tags: ['settings'], roles: ['admin'],
      body: v.object({
        email: v.email(), name: v.string({ min: 1, max: 120 }),
        role: v.default(v.enum(['owner', 'admin', 'member', 'analyst', 'readonly'] as const), 'member'),
        title: v.optional(v.string({ max: 120 })),
      }),
    });

    router.patch('/v1/users/:id', (req: Req, c: Ctx) => {
      const body = req.body as { role?: Role; name?: string; title?: string; teams?: string[] };
      const member = c.db.get<any>(`SELECT * FROM memberships WHERE org_id = ? AND user_id = ?`, req.auth.orgId, req.params.id);
      if (!member) throw notFound('user', req.params.id);
      if (body.role || body.teams) {
        c.db.patch('memberships', 'id', member.id, {
          ...(body.role ? { role: body.role } : {}),
          ...(body.teams ? { teams: JSON.stringify(body.teams) } : {}),
        });
      }
      if (body.name || body.title) c.db.patch('users', 'id', req.params.id, { ...(body.name ? { name: body.name } : {}), ...(body.title ? { title: body.title } : {}), updated: c.now() });
      return { ...publicUser(c.svc.core.user(req.params.id)!), role: body.role ?? member.role };
    }, {
      summary: 'Update a teammate', tags: ['settings'], roles: ['admin'],
      body: v.object({
        role: v.optional(v.enum(['owner', 'admin', 'member', 'analyst', 'readonly'] as const)),
        name: v.optional(v.string({ min: 1, max: 120 })),
        title: v.optional(v.string({ max: 120 })),
        teams: v.optional(v.array(v.string({ max: 60 }))),
      }),
    });

    router.del('/v1/users/:id', (req: Req, c: Ctx) => {
      const changed = c.db.run(`DELETE FROM memberships WHERE org_id = ? AND user_id = ?`, req.auth.orgId, req.params.id).changes;
      if (!changed) throw notFound('user', req.params.id);
      c.audit({ orgId: req.auth.orgId, actorId: req.auth.userId, actorType: 'user', action: 'user.removed', targetType: 'user', targetId: req.params.id, summary: 'Removed from workspace', requestId: req.requestId });
      return noContent();
    }, { summary: 'Remove a teammate', tags: ['settings'], roles: ['admin'] });

    /* ------------------------------ API keys ----------------------------- */
    router.get('/v1/api-keys', (req: Req, c: Ctx) =>
      list(c.db.all<any>(`SELECT * FROM api_keys WHERE org_id = ? ORDER BY created DESC`, req.auth.orgId).map(publicKey)),
      { summary: 'List API keys', tags: ['developers'], roles: ['admin'] });

    router.post('/v1/api-keys', (req: Req, c: Ctx) => {
      const body = req.body as { name: string; livemode: boolean; scopes: string[] };
      const prefix = body.livemode ? 'sk_live' : 'sk_test';
      const secret = `${prefix}_${randomBytes(24).toString('base64url')}`;
      const row = {
        id: newId('apikey'), org_id: req.auth.orgId, name: body.name, prefix,
        token_hash: sha(secret), last4: secret.slice(-4), scopes: JSON.stringify(body.scopes),
        livemode: body.livemode ? 1 : 0, created_by: req.auth.userId ?? null, created: c.now(), last_used: null, revoked_at: null,
      };
      c.db.insert('api_keys', row);
      c.audit({ orgId: req.auth.orgId, actorId: req.auth.userId, actorType: 'user', action: 'api_key.created', targetType: 'api_key', targetId: row.id, summary: `Created API key "${body.name}"`, requestId: req.requestId });
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
      c.audit({ orgId: req.auth.orgId, actorId: req.auth.userId, actorType: 'user', action: 'api_key.revoked', targetType: 'api_key', targetId: req.params.id, summary: 'Revoked API key', requestId: req.requestId });
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
      const q = req.query as any;
      const rows = c.db.all<any>(
        `SELECT * FROM jobs WHERE org_id = ? ${q.status ? 'AND status = ?' : ''} ORDER BY run_at DESC LIMIT ?`,
        req.auth.orgId, ...(q.status ? [q.status] : []), Number(q.limit || 50),
      ).map((r) => ({ ...r, payload: parseJson(r.payload, {}) }));
      return list(rows, { totalCount: c.jobs.stats().pending });
    }, {
      summary: 'Inspect the durable job queue', tags: ['developers'],
      query: v.object({ status: v.optional(v.enum(['pending', 'running', 'done', 'failed', 'cancelled'] as const)), limit: v.optional(v.int({ min: 1, max: 200 })) }),
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
      if (body.to) c.clock.set(body.to);
      else c.clock.advance((body.days ?? 0) * DAY + (body.hours ?? 0) * 3_600_000);
      const worked = await drainUntil(c, c.now());
      c.audit({ orgId: req.auth.orgId, actorId: req.auth.userId, actorType: 'user', action: 'time.advanced', summary: `Advanced the workspace clock to ${new Date(c.now()).toISOString()}`, before: { now: before }, after: { now: c.now() }, requestId: req.requestId });
      return { object: 'clock', now: c.now(), previous: before, offset_ms: c.clock.offset, jobs_run: worked.ran, jobs_failed: worked.failed };
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

async function drainUntil(ctx: Ctx, target: number): Promise<{ ran: number; failed: number }> {
  let ran = 0, failed = 0, guard = 0;
  while (guard++ < 5000) {
    const next = ctx.db.pluck<number>(`SELECT MIN(run_at) FROM jobs WHERE status = 'pending'`);
    if (next === undefined || next === null || next > target) break;
    const r = await ctx.jobs.drain(() => ctx.now());
    ran += r.ran; failed += r.failed;
    if (r.ran === 0 && r.failed === 0) break;
  }
  return { ran, failed };
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
