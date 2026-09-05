import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app';

const app = await createApp({ db: 'memory' });
const login = await app.handle({ method: 'POST', path: '/v1/auth/demo' });
const cookie = String(login.headers['set-cookie'] || '').split(';')[0];
const call = (method: string, path: string, body?: unknown) =>
  app.handle({ method, path, body, headers: { cookie } });

/* ---- 1. write lifecycle: prepare → approve → verify the record ---- */
const note = await call('POST', '/v1/ai/complete', {
  prompt: 'Add a note to Rheinwerk Antriebstechnik saying the pilot is delayed until October because of the PLC firmware issue',
  allow_writes: true,
});
console.log('note run:', (note.body as any).pending_approvals.map((p: any) => p.tool));
const pending = ((await call('GET', '/v1/ai/approvals')).body as any).data;
for (const approval of pending) {
  const decided = await call('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' });
  console.log(`approve ${approval.tool}: status=${decided.status} executed=${(decided.body as any).executed} err=${JSON.stringify((decided.body as any).error ?? null)}`);
}
const timeline = await call('GET', '/v1/records/company/cmp_nw_21/timeline');
const newest = ((timeline.body as any).data ?? [])[0];
console.log('newest timeline item:', JSON.stringify({ title: newest?.title, body: newest?.body, subject: newest?.properties?.subject }, null, 1));

/* ---- 2. approval whose arguments no longer validate ---- */
const runId = 'run_badargs_probe';
app.ctx.db.insert('ai_runs', {
  id: runId, org_id: 'org_demo', thread_id: null, feature: 'test', provider: 'builtin', model: 'ain-engine-1',
  actor_id: 'usr_seed01', actor_type: 'user', status: 'needs_approval', question: 'x', answer: '',
  reasoning: '[]', citations: '[]', started: app.ctx.now(),
});
app.ctx.db.insert('ai_approvals', {
  id: 'appr_badargs', org_id: 'org_demo', run_id: runId, thread_id: null, tool: 'schedule_followup',
  args: JSON.stringify({ record_id: 'cmp_nw_08', in_days: 5, note: 'x', assignee_id: 'cmp_nw_08' }),
  reason: 'probe', status: 'pending', outcome: null, requested_by: null, decided_by: null,
  decided_at: null, created: app.ctx.now(),
});
const bad = await call('POST', '/v1/ai/approvals/appr_badargs', { decision: 'approve' });
console.log('bad-arg approval:', bad.status, JSON.stringify((bad.body as any).error ?? bad.body).slice(0, 300));
console.log('after decision:', JSON.stringify(((await call('GET', '/v1/ai/approvals?status=declined')).body as any).data.map((a: any) => [a.id, a.status, a.outcome])));

/* ---- 3. long prompt latency ---- */
for (const size of [500, 2000, 8000, 16000, 19999]) {
  const prompt = `How much did we book in Q2 2026? ${'The controls retrofit covers line 4 and line 7. '.repeat(500)}`.slice(0, size);
  const started = Date.now();
  const res = await call('POST', '/v1/ai/complete', { prompt });
  console.log(`${size} chars -> ${Date.now() - started}ms finish=${(res.body as any).finish_reason} content=${JSON.stringify(String((res.body as any).content).slice(0, 70))}`);
}

/* ---- 4. a broken provider key must degrade, not 401 ---- */
const server = createServer((_req, res) => {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'API key is invalid.' } }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.ANTHROPIC_API_KEY = 'ain_demo_key_not_a_real_credential';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
try {
  const res = await call('POST', '/v1/ai/complete', { prompt: 'What is our open pipeline by stage?' });
  const body = res.body as any;
  console.log('with a bad key:', res.status, 'provider=', body.provider, 'degraded=', JSON.stringify(body.degraded));
  console.log('content:', String(body.content).slice(0, 120));
} finally {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

app.close();
