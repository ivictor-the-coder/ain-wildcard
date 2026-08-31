import { createApp, frozenClock, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';

export const ORG = 'org_demo';
export const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
export const UTC = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h, 0, 0, 0);

export async function ws(at = UTC(2026, 6, 1)) {
  const app: App = await createApp({ db: 'memory', config: { env: 'test' }, clock: frozenClock(at) });
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, body, auth: DANA });
  const ok = async (m: string, p: string, b?: unknown) => {
    const r = await call(m, p, b);
    if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as any;
  };
  return { app, call, ok, now: () => app.ctx.now(), close: () => app.close() };
}
export type WS = Awaited<ReturnType<typeof ws>>;
