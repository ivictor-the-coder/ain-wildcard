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

/* Credential-shaped literals get the whole branch rejected by GitHub push
   protection, so catch them here rather than at push time. */
const SECRET_PATTERNS: [string, RegExp][] = [
  ['Stripe-style secret key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/],
  ['Stripe publishable key', /\bpk_live_[A-Za-z0-9]{20,}/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /\bsk-proj-[A-Za-z0-9_-]{20,}/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
const scanned: string[] = [];
{
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === '.artifacts' || entry === 'data') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|js|jsx|mjs|css|json|md|html)$/.test(entry)) continue;
      const text = readFileSync(full, 'utf8');
      for (const [label, re] of SECRET_PATTERNS) {
        const hit = text.match(re);
        if (hit) scanned.push(`${full}: ${label} — "${hit[0].slice(0, 24)}…"`);
      }
    }
  };
  for (const dir of ['src', 'scripts', 'tests', 'e2e', 'docs']) { try { walk(dir); } catch { /* absent */ } }
}
if (scanned.length) {
  console.log(`\ncredential-shaped literals (these get the branch rejected on push): ${scanned.length}`);
  for (const s of scanned) console.log('  \u2717 ' + s);
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
process.exit(failures.length || travelled.failed || scanned.length ? 1 : 0);
