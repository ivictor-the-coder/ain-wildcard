import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which workspace the code running right now belongs to.
 *
 * The time machine (`POST /v1/time/advance`) is a per-workspace facility, but
 * `ctx.now()` takes no arguments and every module captures the boot context and
 * calls it from deep inside a handler, a job or a service. So the org a request
 * belongs to travels beside the call stack rather than through it: the request
 * path opens a scope, and the clock resolves *that* org's offset for every read
 * until the request — and everything it awaits, including the jobs it drains —
 * is finished.
 *
 * Without it there is one process-wide offset, and a second workspace advancing
 * a year moves the first workspace's clock and runs the first workspace's jobs.
 *
 * The store is mutable on purpose: the scope is opened before the caller has
 * been authenticated, and `orgId` is filled in the moment the credentials name
 * a workspace — which is still before anything reads the clock.
 */
export interface OrgScope {
  orgId: string;
}

const storage = new AsyncLocalStorage<OrgScope>();

/** Run `fn` with every `ctx.now()` inside it bound to one workspace's clock. */
export function runInOrgScope<T>(scope: OrgScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The workspace in scope, or undefined outside any request (boot, tests, CLI). */
export function currentOrgScope(): OrgScope | undefined {
  return storage.getStore();
}
