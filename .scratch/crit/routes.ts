import { createApp } from '../../src/server/app';
const app = await createApp({ db: 'memory' });
const login = await app.handle({ method: 'POST', path: '/v1/auth/demo' });
const cookie = String(login.headers['set-cookie'] || '').split(';')[0];
const call = (m: string, p: string, b?: unknown) => app.handle({ method: m, path: p, body: b, headers: { cookie } });
for (const p of ['/v1/ai/tools','/v1/ai/metrics','/v1/ai/suggestions','/v1/ai/runs','/v1/ai/approvals','/v1/ai/usage','/v1/ai/status','/v1/ai/threads']) {
  const r: any = await call('GET', p);
  console.log(p, r.status, JSON.stringify(r.body).slice(0,180));
}
const d: any = await call('POST','/v1/ai/draft',{kind:'email', prompt:'Follow up with Meridian Forge Systems about the renewal'});
console.log('draft', d.status, JSON.stringify(d.body).slice(0,400));
// write attempt
const w: any = await call('POST','/v1/ai/complete',{prompt:'Create a task to call Rachel Boone at Meridian Forge Systems tomorrow', allow_writes:true});
console.log('write', w.status, JSON.stringify(w.body?.content).slice(0,400), 'pending', JSON.stringify(w.body?.pending_approvals)?.slice(0,300));
app.close();
