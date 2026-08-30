import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createApp } from './app';
import { readBody, sendJson } from './kernel/http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
};

const app = await createApp();
const clientDir = join(process.cwd(), 'dist/client');
const hasClient = existsSync(join(clientDir, 'index.html'));

const server = createServer(async (req, res) => {
  const url = req.url || '/';
  const origin = req.headers.origin;
  const cors: Record<string, string> = origin
    ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true',
        'access-control-allow-headers': 'content-type,authorization,idempotency-key,x-ain-session',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' }
    : {};
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  if (url.startsWith('/api/')) {
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const result = await app.handle({
        method: req.method || 'GET',
        path: url.slice(4),
        body,
        headers: req.headers as Record<string, string>,
        ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '',
      });
      sendJson(res, result.status, result.body, { ...cors, ...result.headers });
    } catch (e) {
      sendJson(res, 500, { error: { type: 'api_error', code: 'internal_error', message: (e as Error).message } }, cors);
    }
    return;
  }

  if (!hasClient) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Ain API</title><body style="font:14px system-ui;padding:40px"><h1>Ain API is running</h1><p>The web client is not built. Run <code>npm run build</code>, or use <code>npm run dev</code> for the Vite dev server on :5173.</p><p><a href="/api/v1/health">/api/v1/health</a> · <a href="/api/openapi.json">/api/openapi.json</a></p>');
    return;
  }

  const clean = normalize(decodeURIComponent(url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(clientDir, clean);
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    filePath = join(clientDir, 'index.html');
  }
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    const immutable = filePath.includes('/assets/');
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

const port = app.ctx.config.port;
server.listen(port, '0.0.0.0', () => {
  app.ctx.log.info('server.listening', { url: `http://127.0.0.1:${port}`, client: hasClient ? 'dist/client' : 'none' });
});

// Durable work runs on a simple ticker; every unit of work is a row in `jobs`.
const tickMs = Number(process.env.AIN_TICK_MS || 1000);
let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try { await app.tick(); } catch (e) { app.ctx.log.error('tick.failed', { error: (e as Error).message }); }
  finally { ticking = false; }
}, tickMs).unref?.();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { server.close(); app.close(); process.exit(0); });
}
