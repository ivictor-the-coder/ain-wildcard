import type { Db } from './db';
import type { Clock } from './clock';
import type { EventBus, EmitOptions } from './events';
import type { JobQueue, EnqueueOptions } from './jobs';
import type { Logger } from './logger';
import type { Router, Auth } from './http';
import type { ModuleDef } from './module';
import type { AiRuntime } from './ai';
import type { ServiceRegistry } from './services';
import { currentOrgScope } from './org-scope';

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  publicUrl: string;
  /** Default organisation used by the single-tenant demo shell. */
  defaultOrgId: string;
  seedOnBoot: boolean;
  aiProvider: string;
}

export interface Ctx {
  db: Db;
  clock: Clock;
  events: EventBus;
  jobs: JobQueue;
  log: Logger;
  config: Config;
  router: Router<Ctx>;
  modules: ModuleDef[];
  ai: AiRuntime;
  svc: ServiceRegistry;

  now(): number;
  provide<K extends keyof ServiceRegistry>(name: K, impl: ServiceRegistry[K]): void;

  /** Emit a domain event bound to the current org/actor. */
  emit<T>(orgId: string, type: string, data: T, opts?: EmitOptions): void;
  /** Enqueue a durable job. */
  enqueue(orgId: string, type: string, payload: unknown, opts?: EnqueueOptions): void;
  /** Run `fn` in a DB transaction whose events publish only on commit. */
  atomic<T>(fn: () => T): T;
  /** Write an audit entry. */
  audit(entry: AuditEntry): void;
}

export interface AuditEntry {
  orgId: string;
  actorId?: string | null;
  actorType?: 'user' | 'api_key' | 'system' | 'agent' | 'workflow';
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  ip?: string | null;
}

/** Per-request slice of the context — carries auth without mutating globals. */
export interface RequestCtx extends Ctx {
  auth: Auth;
  requestId: string;
}

/**
 * The per-request context also narrows the job queue to the caller's workspace.
 * The clock is resolved per org, so draining has to be too: a handler reached
 * through `c.jobs` — `POST /v1/time/advance`, `POST /v1/jobs/drain` — must not
 * be able to run another tenant's renewals under this tenant's clock.
 *
 * It also names the actor to the workspace scope. Modules emit most of their
 * events from the boot context, where there is no request to read, so an
 * event handler that wants to say *who* changed a property or a tax setting
 * has only the scope to ask. The stamp happens here because this is the one
 * place every authenticated request passes through.
 */
export function withAuth(ctx: Ctx, auth: Auth, requestId: string): RequestCtx {
  const scope = currentOrgScope();
  if (scope) {
    scope.requestId = requestId;
    scope.actorId = auth.userId ?? auth.keyId ?? null;
    scope.actorType = auth.kind === 'api_key' ? 'api_key' : auth.kind === 'session' ? 'user' : 'system';
  }
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, {
    auth, requestId, jobs: ctx.jobs.forOrg(auth.orgId),
  });
}
