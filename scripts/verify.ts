/**
 * Boot the whole platform in-process and exercise it without binding a port.
 * This is the fastest honest check that a module works: real migrations, real
 * seed data, real routes, real jobs.
 *
 *   npx tsx scripts/verify.ts                     # smoke the whole platform
 *   npx tsx scripts/verify.ts GET /v1/subscriptions
 *   npx tsx scripts/verify.ts POST /v1/time/advance '{"days":35}'
 */
import { createApp } from '../src/server/app';

const [, , methodArg, pathArg, bodyArg] = process.argv;

const app = await createApp({ db: 'memory' });
const login = await app.handle({ method: 'POST', path: '/v1/auth/demo' });
const cookie = String(login.headers['set-cookie'] || '').split(';')[0];
const call = (method: string, path: string, body?: unknown) =>
  app.handle({ method, path, body, headers: { cookie } });

if (methodArg && pathArg) {
  const res = await call(methodArg.toUpperCase(), pathArg, bodyArg ? JSON.parse(bodyArg) : undefined);
  console.log(res.status);
  console.log(JSON.stringify(res.body, null, 2));
  app.close();
  process.exit(res.status < 400 ? 0 : 1);
}

const health = await call('GET', '/v1/health');
const map = await call('GET', '/v1/system/map');
const routes = app.ctx.router.routes;
console.log(`modules   ${app.ctx.modules.map((m) => m.name).join(', ')}`);
console.log(`routes    ${routes.length}`);
console.log(`ai tools  ${app.ctx.ai.tools().length}`);
console.log(`jobs      ${JSON.stringify((health.body as any).jobs)}`);

const failures: string[] = [];
for (const route of routes) {
  if (route.method !== 'GET' || route.path.includes(':') || route.path.includes('*')) continue;
  const res = await call('GET', route.path);
  if (res.status >= 400) failures.push(`${route.method} ${route.path} → ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
}
console.log(`GET routes checked: ${routes.filter((r) => r.method === 'GET' && !r.path.includes(':')).length}, failures: ${failures.length}`);
for (const f of failures) console.log('  ✗ ' + f);

const before = app.ctx.now();
const travelled = await app.travel(90 * 24 * 3600 * 1000);
console.log(`time machine: +90d ran ${travelled.ran} jobs, ${travelled.failed} failed (${new Date(before).toISOString().slice(0, 10)} → ${new Date(travelled.now).toISOString().slice(0, 10)})`);
void map;

app.close();
process.exit(failures.length || travelled.failed ? 1 : 0);
