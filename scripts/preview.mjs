#!/usr/bin/env node
/**
 * Build the client into an isolated directory and serve the whole product
 * (API + UI) from one port, so several people can inspect different builds on
 * the same machine without fighting over `dist/` or port 8787.
 *
 *   node scripts/preview.mjs --port 8801 --name billing
 *
 * Prints `READY <url>` on stdout once the app answers, then stays up.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') ? 'true' : all[i + 1]]] : [])),
);
const name = args.name || 'preview';
const port = Number(args.port || 8800);
const outDir = join(process.cwd(), '.artifacts', name, 'client');
const dbPath = args.db === 'memory' ? 'memory' : join(process.cwd(), '.artifacts', name, 'ain.db');

if (args.fresh !== undefined) rmSync(join(process.cwd(), '.artifacts', name), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const gen = spawnSync('node', ['scripts/gen-registry.mjs'], { stdio: 'inherit' });
if (gen.status !== 0) process.exit(gen.status ?? 1);

if (args.skipBuild === undefined) {
  const build = spawnSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], { stdio: 'inherit' });
  if (build.status !== 0) { console.error('client build failed'); process.exit(build.status ?? 1); }
}

const server = spawn('npx', ['tsx', 'src/server/main.ts'], {
  env: { ...process.env, PORT: String(port), AIN_CLIENT_DIR: outDir, AIN_DB: dbPath, AIN_LOG_LEVEL: args.verbose !== undefined ? 'info' : 'warn' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
process.on('SIGINT', () => { server.kill(); process.exit(0); });
process.on('SIGTERM', () => { server.kill(); process.exit(0); });

const url = `http://127.0.0.1:${port}`;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const res = await fetch(`${url}/api/v1/health`);
    if (res.ok) { console.log(`READY ${url}`); break; }
  } catch { /* still starting */ }
  if (i === 119) { console.error('server did not become ready'); server.kill(); process.exit(1); }
}
