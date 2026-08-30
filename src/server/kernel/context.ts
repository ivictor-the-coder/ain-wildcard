import type { Db } from './db';
import type { Clock } from './clock';
import type { EventBus, EmitOptions } from './events';
import type { JobQueue, EnqueueOptions } from './jobs';
import type { Logger } from './logger';
import type { Router, Auth } from './http';
import type { ModuleDef } from './module';
import type { AiRuntime } from './ai';
import type { ServiceRegistry } from './services';

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

export function withAuth(ctx: Ctx, auth: Auth, requestId: string): RequestCtx {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { auth, requestId });
}
