import { createHash, timingSafeEqual } from 'node:crypto';
import { Db, openDb, parseJson } from './kernel/db';
import { EventBus, type EmitOptions } from './kernel/events';
import { JobQueue, type EnqueueOptions } from './kernel/jobs';
import { createLogger, type Logger } from './kernel/logger';
import { offsetClock, frozenClock, type Clock } from './kernel/clock';
import { Router, type Auth, type Req, type Role, isRaw, parseQuery, newRequestId, errorToResponse, SYSTEM_AUTH } from './kernel/http';
import type { Ctx, Config, AuditEntry } from './kernel/context';
import { withAuth } from './kernel/context';
import type { ModuleDef } from './kernel/module';
import { CORE_MIGRATIONS } from './kernel/core-schema';
import { createAiRuntime } from './ai/runtime';
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized } from '../shared/errors';
import { newId, randomId } from '../shared/ids';
import { MODULES } from './generated/registry';

export interface AppOptions {
  db?: string;
  clock?: Clock;
  logger?: Logger;
  config?: Partial<Config>;
  modules?: ModuleDef[];
  /** Skip demo seeding (tests build their own fixtures). */
  seed?: boolean;
}

export interface HandleRequest {
  method: string;
  path: string;
  query?: string | Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  ip?: string;
  auth?: Auth;
}

export interface HandleResponse {
  status: number;
  body: any;
  headers: Record<string, string>;
}

export interface App {
  ctx: Ctx;
  db: Db;
  handle(req: HandleRequest): Promise<HandleResponse>;
  /** Advance the virtual clock and run everything that becomes due. */
  travel(ms: number): Promise<{ ran: number; failed: number; now: number }>;
  tick(): Promise<{ ran: number; failed: number }>;
  close(): void;
}

const ROLE_RANK: Record<Role, number> = { system: 100, owner: 90, admin: 80, member: 60, analyst: 40, readonly: 20 };
export const roleAtLeast = (role: Role, min: Role) => ROLE_RANK[role] >= ROLE_RANK[min];

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function createApp(options: AppOptions = {}): Promise<App> {
  const config: Config = {
    env: (process.env.NODE_ENV as Config['env']) || 'development',
    port: Number(process.env.PORT || 8787),
    publicUrl: process.env.AIN_PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 8787}`,
    defaultOrgId: process.env.AIN_ORG_ID || 'org_demo',
    seedOnBoot: options.seed ?? process.env.AIN_SEED !== '0',
    aiProvider: process.env.AIN_AI_PROVIDER || 'auto',
    ...options.config,
  };

  const log = options.logger || createLogger({ level: (process.env.AIN_LOG_LEVEL as any) || (config.env === 'test' ? 'error' : 'info') });
  const db = options.db ? new Db(options.db === 'memory' ? ':memory:' : options.db) : openDb();

  const modules = (options.modules || MODULES).slice();
  const ordered = topoSort(modules);

  // --- clock: persisted per-org offset so the demo "time machine" survives restarts
  let clockOffset = 0;
  const readOffset = () => clockOffset;
  const writeOffset = (ms: number) => {
    clockOffset = ms;
    try { db.run(`UPDATE orgs SET clock_offset = ?, updated = ? WHERE id = ?`, ms, Date.now() + ms, config.defaultOrgId); }
    catch { /* orgs table not migrated yet */ }
  };
  const clock: Clock = options.clock || offsetClock(readOffset, writeOffset);

  const bootLog = log.child({ scope: 'boot' });
  const events = new EventBus(db, (e, evt, sub) => log.error('event.handler_failed', { event: evt.type, subscriber: sub, error: e.message }));
  const jobs = new JobQueue(db, log);
  const router = new Router<Ctx>();

  const migrations = [...CORE_MIGRATIONS, ...ordered.flatMap((m) => m.migrations ?? [])];
  const ran = db.migrate(migrations, Date.now());
  if (ran.length) bootLog.info('migrations.applied', { count: ran.length });

  const persisted = db.get<{ clock_offset: number }>(`SELECT clock_offset FROM orgs WHERE id = ?`, config.defaultOrgId);
  if (persisted && clock.kind === 'virtual' && !options.clock) clockOffset = persisted.clock_offset || 0;

  const svc: any = {};
  const ai = createAiRuntime(config);

  const ctx: Ctx = {
    db, clock, events, jobs, log, config, router, modules: ordered, ai, svc,
    now: () => clock.now(),
    provide(name, impl) { (svc as any)[name] = impl; },
    emit(orgId, type, data, opts: EmitOptions = {}) { events.emit(orgId, type, data, clock.now(), opts); },
    enqueue(orgId, type, payload, opts: EnqueueOptions = {}) { jobs.enqueue(orgId, type, payload, clock.now(), opts); },
    atomic<T>(fn: () => T): T { return db.tx(() => events.transactional(fn)); },
    audit(entry: AuditEntry) {
      db.insert('audit_log', {
        id: newId('audit'), org_id: entry.orgId, actor_id: entry.actorId ?? null,
        actor_type: entry.actorType ?? 'system', action: entry.action,
        target_type: entry.targetType ?? null, target_id: entry.targetId ?? null,
        summary: entry.summary,
        before: entry.before === undefined ? null : (entry.before as any),
        after: entry.after === undefined ? null : (entry.after as any),
        request_id: entry.requestId ?? null, ip: entry.ip ?? null, created: clock.now(),
      });
    },
  };

  for (const m of ordered) {
    m.boot?.(ctx);
    if (m.on) for (const [pattern, handler] of Object.entries(m.on)) events.on(pattern, (evt) => handler(evt, ctx), m.name);
  }
  for (const m of ordered) {
    if (m.routes) { router.scope(m.name); m.routes(router, ctx); }
    for (const tool of m.tools?.(ctx) ?? []) ai.registerTool(tool);
  }
  bootLog.info('modules.ready', { modules: ordered.length, routes: router.routes.length, tools: ai.tools().length });

  if (config.seedOnBoot) {
    const existing = db.get<{ id: string }>(`SELECT id FROM orgs WHERE id = ?`, config.defaultOrgId);
    if (!existing) {
      const { seedDemo } = await import('./seed');
      seedDemo(ctx, config.defaultOrgId);
      bootLog.info('seed.complete', { org: config.defaultOrgId });
    }
  }

  /* ----------------------------- request path ---------------------------- */

  const rateBuckets = new Map<string, { tokens: number; last: number }>();
  const RATE_LIMIT = Number(process.env.AIN_RATE_LIMIT || 600); // requests/minute per key

  function checkRateLimit(key: string, now: number): void {
    const bucket = rateBuckets.get(key) || { tokens: RATE_LIMIT, last: now };
    const refill = ((now - bucket.last) / 60_000) * RATE_LIMIT;
    bucket.tokens = Math.min(RATE_LIMIT, bucket.tokens + refill);
    bucket.last = now;
    if (bucket.tokens < 1) { rateBuckets.set(key, bucket); throw new ApiError('rate_limit_error', 'rate_limit', 'Too many requests. Retry with exponential backoff.'); }
    bucket.tokens -= 1;
    rateBuckets.set(key, bucket);
  }

  function authenticate(headers: Record<string, string>, isPublic: boolean): Auth {
    const header = headers['authorization'] || '';
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const cookieHeader = headers['cookie'] || '';
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
    );
    const sessionToken = cookies['ain_session'] || headers['x-ain-session'] || '';

    if (bearer) {
      const row = db.get<any>(`SELECT * FROM api_keys WHERE token_hash = ? AND revoked_at IS NULL`, hashToken(bearer));
      if (!row) throw unauthorized('Invalid API key provided.');
      db.patch('api_keys', 'id', row.id, { last_used: clock.now() });
      return { kind: 'api_key', orgId: row.org_id, keyId: row.id, role: 'admin', scopes: parseJson<string[]>(row.scopes, ['*']), livemode: !!row.livemode };
    }
    if (sessionToken) {
      const row = db.get<any>(`SELECT * FROM sessions WHERE token_hash = ?`, hashToken(sessionToken));
      if (row && row.expires > clock.now()) {
        const member = db.get<any>(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, row.org_id, row.user_id);
        return { kind: 'session', orgId: row.org_id, userId: row.user_id, role: (member?.role as Role) || 'member', scopes: ['*'], livemode: true };
      }
    }
    if (isPublic) return { kind: 'anonymous', orgId: config.defaultOrgId, role: 'readonly', scopes: [], livemode: true };
    throw unauthorized();
  }

  function idempotencyGuard(req: Req, key: string, hash: string): HandleResponse | null {
    const now = clock.now();
    db.run(`DELETE FROM idempotency_keys WHERE expires < ?`, now);
    const existing = db.get<any>(`SELECT * FROM idempotency_keys WHERE org_id = ? AND key = ?`, req.auth.orgId, key);
    if (existing) {
      if (existing.request_hash !== hash) {
        throw conflict('idempotency_key_in_use', 'This idempotency key was already used with a different request body.');
      }
      if (existing.state === 'in_progress') {
        throw conflict('idempotency_in_progress', 'A request with this idempotency key is still in progress.');
      }
      return { status: existing.status, body: parseJson(existing.response, null), headers: { 'idempotent-replayed': 'true' } };
    }
    db.insert('idempotency_keys', {
      key, org_id: req.auth.orgId, method: req.method, path: req.path, request_hash: hash,
      state: 'in_progress', created: now, expires: now + 24 * 60 * 60 * 1000,
    });
    return null;
  }

  async function handle(input: HandleRequest): Promise<HandleResponse> {
    const requestId = newRequestId();
    const started = Date.now();
    const headers = Object.fromEntries(Object.entries(input.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const [rawPath, search = ''] = input.path.split('?');
    const path = rawPath.replace(/\/+$/, '') || '/';
    const parsedQuery = typeof input.query === 'string'
      ? parseQuery(input.query)
      : input.query
        ? { flat: input.query as Record<string, string>, all: Object.fromEntries(Object.entries(input.query).map(([k, v]) => [k, [String(v)]])) }
        : parseQuery(search);

    let auth: Auth = input.auth || { kind: 'anonymous', orgId: config.defaultOrgId, role: 'readonly', scopes: [], livemode: true };
    let idemKey = '';

    try {
      const matched = router.match(input.method.toUpperCase(), path);
      if (!matched) throw new ApiError('not_found_error', 'unknown_endpoint', `Unrecognised request URL (${input.method.toUpperCase()} ${path}).`);
      const { route, params } = matched;

      if (!input.auth) auth = authenticate(headers, route.meta.auth === 'public');
      checkRateLimit(auth.keyId || auth.userId || input.ip || 'anon', clock.now());

      if (route.meta.roles && !route.meta.roles.some((r) => roleAtLeast(auth.role, r))) {
        throw forbidden(`Your role (${auth.role}) cannot perform this action.`);
      }
      if (route.meta.scopes?.length && !auth.scopes.includes('*') && !route.meta.scopes.every((s) => auth.scopes.includes(s))) {
        throw forbidden(`This API key is missing required scopes: ${route.meta.scopes.join(', ')}.`);
      }

      const req: Req = {
        method: input.method.toUpperCase(), path, params, query: parsedQuery.flat, queryAll: parsedQuery.all,
        body: input.body ?? {}, headers, requestId, auth, ip: input.ip || '127.0.0.1',
      };
      if (route.meta.query) req.query = route.meta.query.parse(parsedQuery.flat) as any;
      if (route.meta.body) req.body = route.meta.body.parse(input.body ?? {});

      idemKey = headers['idempotency-key'] || '';
      if (idemKey && (req.method === 'POST' || req.method === 'DELETE')) {
        const hash = createHash('sha256').update(JSON.stringify({ p: path, b: input.body ?? {} })).digest('hex');
        const replay = idempotencyGuard(req, idemKey, hash);
        if (replay) return { ...replay, headers: { ...replay.headers, 'request-id': requestId } };
      }

      const result = await route.handler(req, withAuth(ctx, auth, requestId));
      const response: HandleResponse = isRaw(result)
        ? { status: result.status, body: result.body, headers: { 'request-id': requestId, ...(result.headers || {}) } }
        : { status: 200, body: result ?? null, headers: { 'request-id': requestId } };

      if (idemKey && (req.method === 'POST' || req.method === 'DELETE')) {
        db.run(`UPDATE idempotency_keys SET state = 'complete', status = ?, response = ? WHERE org_id = ? AND key = ?`,
          response.status, JSON.stringify(response.body ?? null), auth.orgId, idemKey);
      }
      if (config.env !== 'test') {
        log.info('http', { method: req.method, path, status: response.status, ms: Date.now() - started, org: auth.orgId });
      }
      return response;
    } catch (e) {
      if (idemKey) { try { db.run(`DELETE FROM idempotency_keys WHERE org_id = ? AND key = ? AND state = 'in_progress'`, auth.orgId, idemKey); } catch { /* noop */ } }
      const { status, body } = errorToResponse(e, requestId);
      if (status >= 500) log.error('http.error', { method: input.method, path, status, error: (e as Error)?.message, stack: (e as Error)?.stack?.split('\n')[1]?.trim() });
      else if (config.env !== 'test') log.warn('http.client_error', { method: input.method, path, status, code: (e as any)?.code });
      return { status, body, headers: { 'request-id': requestId } };
    }
  }

  const app: App = {
    ctx, db, handle,
    async tick() { return jobs.drain(() => clock.now()); },
    async travel(ms: number) {
      const target = clock.now() + ms;
      // Step through pending work chronologically so renewals and dunning fire in order.
      let ran = 0, failed = 0, guard = 0;
      while (guard++ < 10_000) {
        const next = db.pluck<number>(`SELECT MIN(run_at) FROM jobs WHERE status = 'pending'`);
        if (next === undefined || next === null || next > target) break;
        clock.set(Math.max(next, clock.now()));
        const r = await jobs.drain(() => clock.now());
        ran += r.ran; failed += r.failed;
      }
      clock.set(target);
      const r = await jobs.drain(() => clock.now());
      return { ran: ran + r.ran, failed: failed + r.failed, now: clock.now() };
    },
    close() { db.close(); },
  };
  return app;
}

export function topoSort(modules: ModuleDef[]): ModuleDef[] {
  const byName = new Map(modules.map((m) => [m.name, m]));
  const out: ModuleDef[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (m: ModuleDef, chain: string[]) => {
    const s = state.get(m.name);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`Circular module dependency: ${[...chain, m.name].join(' -> ')}`);
    state.set(m.name, 'visiting');
    for (const dep of m.dependsOn ?? []) {
      const d = byName.get(dep);
      if (!d) throw new Error(`Module "${m.name}" depends on unknown module "${dep}"`);
      visit(d, [...chain, m.name]);
    }
    state.set(m.name, 'done');
    out.push(m);
  };
  for (const m of [...modules].sort((a, b) => a.name.localeCompare(b.name))) visit(m, []);
  return out;
}

export { frozenClock, SYSTEM_AUTH, badRequest, notFound, randomId };
