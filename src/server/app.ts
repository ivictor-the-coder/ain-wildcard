import { createHash, timingSafeEqual } from 'node:crypto';
import { Db, openDb, parseJson } from './kernel/db';
import { EventBus, type EmitOptions } from './kernel/events';
import { JobQueue, type EnqueueOptions } from './kernel/jobs';
import { createLogger, type Logger } from './kernel/logger';
import { offsetClock, frozenClock, type Clock } from './kernel/clock';
import { Router, type Auth, type Req, type Role, isRaw, parseQuery, newRequestId, errorToResponse, roleAtLeast, SYSTEM_AUTH } from './kernel/http';
import { runInOrgScope, currentOrgScope, type OrgScope } from './kernel/org-scope';
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

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** A scope that asks to change something: `crm:write`, `billing:*`, `write`. */
const WRITE_SCOPE = /(^|:)(write|admin|\*)$/;

/**
 * How much of the role ladder an API key's own scopes justify.
 *
 * `route.meta.scopes` is the only thing that ever reads `auth.scopes`, and no
 * route in the platform declares it, so the scopes a customer chooses are
 * enforced nowhere else — the ladder is what has to carry them. Both ends of
 * that have been wrong in turn, and the failure is symmetric:
 *
 * - Every key authenticating as `admin` meant a key minted `["crm:read"]`
 *   could move the workspace clock, revoke the workspace's other credentials
 *   and hand an agent `allow_writes`.
 * - Every restricted key then authenticating as `readonly` meant a key minted
 *   `["metering:write"]` — the telemetry ingest path this whole product is
 *   priced on — got `403 Your role (readonly) cannot perform this action` on
 *   `POST /v1/meter-events`, and `["crm:write"]` the same on every record it
 *   was issued to create. The integration surface was closed instead of the
 *   escalation.
 *
 * So the role is read off what the key asked for: everything (`*`) stays
 * `admin`; anything that names a write is a `member`, which is exactly the
 * rung every mutating route in the platform is gated at; anything else is
 * `readonly`. Nothing but `*` reaches `admin`, so a restricted credential can
 * still never travel time, revoke keys or delete an object type.
 *
 * What this deliberately does not claim is per-domain enforcement: until
 * routes declare `meta.scopes`, a `["crm:write"]` key is a member everywhere,
 * not only in CRM. That is a narrowing the platform still owes its customers,
 * and it belongs on the routes rather than in a guess made here.
 */
function keyRole(scopes: string[]): Role {
  if (scopes.includes('*')) return 'admin';
  return scopes.some((s) => WRITE_SCOPE.test(s.trim().toLowerCase())) ? 'member' : 'readonly';
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

  /* --- clock ------------------------------------------------------------
   * The offset belongs to a workspace, not to the process. It is read and
   * written against whichever org is in scope for the call being served, and
   * persisted on that org's row, so a second workspace advancing a year cannot
   * move the first one's clock — or, through `withAuth`'s scoped queue, run the
   * first one's renewals, dunning and credit expiry a year early.
   */
  const offsets = new Map<string, number>();
  const readOffset = (orgId: string): number => {
    const cached = offsets.get(orgId);
    if (cached !== undefined) return cached;
    try {
      const row = db.get<{ clock_offset: number }>(`SELECT clock_offset FROM orgs WHERE id = ?`, orgId);
      // An org that does not exist yet gets no cache entry: the offset it is
      // seeded or migrated with must still be picked up on the next read.
      if (!row) return 0;
      offsets.set(orgId, row.clock_offset || 0);
      return row.clock_offset || 0;
    } catch { return 0; /* orgs table not migrated yet */ }
  };
  const writeOffset = (orgId: string, ms: number): void => {
    offsets.set(orgId, ms);
    try { db.run(`UPDATE orgs SET clock_offset = ?, updated = ? WHERE id = ?`, ms, Date.now() + ms, orgId); }
    catch { /* orgs table not migrated yet */ }
  };
  const scopedOrgId = (): string => currentOrgScope()?.orgId ?? config.defaultOrgId;
  const clock: Clock = options.clock
    || offsetClock(() => readOffset(scopedOrgId()), (ms) => writeOffset(scopedOrgId(), ms));

  const bootLog = log.child({ scope: 'boot' });
  const events = new EventBus(db, (e, evt, sub) => log.error('event.handler_failed', { event: evt.type, subscriber: sub, error: e.message }));
  const jobs = new JobQueue(db, log);
  const router = new Router<Ctx>();

  const migrations = [...CORE_MIGRATIONS, ...ordered.flatMap((m) => m.migrations ?? [])];
  const ran = db.migrate(migrations, Date.now());
  if (ran.length) bootLog.info('migrations.applied', { count: ran.length });

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

  /**
   * The budget is "requests per real minute", so it is measured on real
   * minutes. `clock.now()` is a workspace's *business* time: an operator moves
   * it a year with `POST /v1/time/advance` and back again with
   * `POST /v1/time/reset`, and the buckets are keyed by principal, not by
   * workspace — so a person who belongs to two workspaces shares one bucket
   * between two clocks that disagree by a year.
   *
   * A token bucket cannot survive time going backwards. `refill` goes negative
   * by `elapsed × RATE_LIMIT`, the bucket drops to some hugely negative number,
   * and every later request is refused until real time makes that back — a year
   * of business time drains a year of real budget. Raising `AIN_RATE_LIMIT`
   * does not help, because the deficit scales with it.
   *
   * So the limiter reads the wall clock, which no route can move, and clamps
   * `elapsed` at zero besides: whatever the source, a bucket may only ever be
   * refilled by time passing, never emptied by it.
   */
  function checkRateLimit(key: string, now: number): void {
    const bucket = rateBuckets.get(key) || { tokens: RATE_LIMIT, last: now };
    const refill = (Math.max(0, now - bucket.last) / 60_000) * RATE_LIMIT;
    bucket.tokens = Math.min(RATE_LIMIT, bucket.tokens + refill);
    bucket.last = now;
    if (bucket.tokens < 1) { rateBuckets.set(key, bucket); throw new ApiError('rate_limit_error', 'rate_limit', 'Too many requests. Retry with exponential backoff.'); }
    bucket.tokens -= 1;
    rateBuckets.set(key, bucket);
  }

  function authenticate(headers: Record<string, string>, isPublic: boolean, scope: OrgScope): Auth {
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
      // The clock is per workspace and `last_used` is stamped from it, so the
      // scope is set the moment the credential names an org — before the first
      // clock read, not after.
      scope.orgId = row.org_id;
      db.patch('api_keys', 'id', row.id, { last_used: clock.now() });
      const scopes = parseJson<string[]>(row.scopes, ['*']);
      const role: Role = keyRole(scopes);
      return { kind: 'api_key', orgId: row.org_id, keyId: row.id, role, scopes, livemode: !!row.livemode };
    }
    if (sessionToken) {
      const row = db.get<any>(`SELECT * FROM sessions WHERE token_hash = ?`, hashToken(sessionToken));
      if (row) scope.orgId = row.org_id;
      // A session lasts 30 real days, so it is judged on real time — the same
      // reasoning as the rate limiter above, one trust boundary further in.
      // `clock.now()` is a number this workspace's own admin sets: reading the
      // expiry off it meant `POST /v1/time/advance { days: 365 }` walked past
      // the expiry of the very session that authorised it, and every following
      // call from that operator was a 401. The time machine is the product's
      // headline feature; it must not be able to sign anyone out. `expires` is
      // minted on the wall clock (`core.createSession`), so the two agree.
      if (row && row.expires > Date.now()) {
        const member = db.get<any>(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`, row.org_id, row.user_id);
        return { kind: 'session', orgId: row.org_id, userId: row.user_id, role: (member?.role as Role) || 'member', scopes: ['*'], livemode: true };
      }
    }
    if (isPublic) return { kind: 'anonymous', orgId: config.defaultOrgId, role: 'readonly', scopes: [], livemode: true };
    throw unauthorized();
  }

  function idempotencyGuard(req: Req, key: string, hash: string): HandleResponse | null {
    const now = clock.now();
    // The sweep runs on the caller's clock, so it may only reach the caller's
    // own workspace. Unscoped, one workspace advancing a day deleted every
    // other workspace's live keys, and the next retry of a charge that had
    // already been made ran a second time instead of replaying the first.
    db.run(`DELETE FROM idempotency_keys WHERE org_id = ? AND expires < ?`, req.auth.orgId, now);
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
    // Everything this request touches — its clock reads, the jobs it drains,
    // the jobs those jobs enqueue — runs inside one workspace's scope.
    const scope: OrgScope = { orgId: input.auth?.orgId ?? config.defaultOrgId };
    return runInOrgScope(scope, () => serve(input, scope));
  }

  async function serve(input: HandleRequest, scope: OrgScope): Promise<HandleResponse> {
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

      if (!input.auth) auth = authenticate(headers, route.meta.auth === 'public', scope);
      scope.orgId = auth.orgId;
      checkRateLimit(auth.keyId || auth.userId || input.ip || 'anon', Date.now());

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

  /**
   * The queue `travel` steps through. `travel` *moves* a clock, and outside a
   * request there is no caller to say whose — so it moves the default
   * workspace's and steps only that workspace's queue. An explicit
   * `options.clock` is one clock for the whole process, so there every org's
   * time moved and every org's queue is due.
   */
  const harnessQueue = options.clock ? jobs : jobs.forOrg(config.defaultOrgId);

  const app: App = {
    ctx, db, handle,
    /**
     * `tick` is the opposite case, and must not share `travel`'s answer.
     * `main.ts` calls it on a one-second timer and it is the only thing that
     * runs durable work in a deployed server: renewals, dunning retries, credit
     * expiry, invoice collection, scheduled agent runs. It moves no clock — it
     * only runs what has already come due — so scoping it to the default
     * workspace does not protect anyone, it just stops every other workspace's
     * business dead, with the work piling up `pending` forever.
     *
     * Whether a job is due is still a question about its own workspace's clock,
     * so the ticker asks it once per workspace, inside that workspace's scope.
     */
    async tick() {
      if (options.clock) return jobs.drain(() => clock.now());
      let ran = 0, failed = 0;
      for (const orgId of jobs.pendingOrgIds()) {
        const r = await runInOrgScope({ orgId }, () => jobs.forOrg(orgId).drain(() => clock.now()));
        ran += r.ran; failed += r.failed;
      }
      return { ran, failed };
    },
    async travel(ms: number) {
      const target = clock.now() + ms;
      // Step through pending work chronologically so renewals and dunning fire in order.
      let ran = 0, failed = 0, guard = 0;
      while (guard++ < 10_000) {
        const next = harnessQueue.nextRunAt();
        if (next === null || next > target) break;
        clock.set(Math.max(next, clock.now()));
        const r = await harnessQueue.drain(() => clock.now());
        ran += r.ran; failed += r.failed;
      }
      clock.set(target);
      const r = await harnessQueue.drain(() => clock.now());
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

export { frozenClock, SYSTEM_AUTH, roleAtLeast, badRequest, notFound, randomId };
