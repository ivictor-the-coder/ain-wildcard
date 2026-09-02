import { createApp } from '../../src/server/app';

export async function boot() {
  const app = await createApp({ db: 'memory' });
  const login = await app.handle({ method: 'POST', path: '/v1/auth/demo' });
  const cookie = String(login.headers['set-cookie'] || '').split(';')[0];
  const call = (method: string, path: string, body?: unknown) =>
    app.handle({ method, path, body, headers: { cookie } });
  const orgId = (await call('GET', '/v1/health')).body as any;
  return { app, call, cookie };
}
