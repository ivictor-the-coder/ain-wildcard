import { createApp } from '../../src/server/app';
import { readFileSync } from 'node:fs';
const app = await createApp({ db: 'memory' });
const login = await app.handle({ method: 'POST', path: '/v1/auth/demo' });
const cookie = String(login.headers['set-cookie'] || '').split(';')[0];
const call = (method: string, path: string, body?: unknown) =>
  app.handle({ method, path, body, headers: { cookie } });
console.error('NOW', new Date((app.ctx as any).now()).toISOString());
const file = process.argv[2];
const specs = JSON.parse(readFileSync(file,'utf8')) as any[];
for (const s of specs) {
  const body: any = typeof s === 'string' ? { prompt: s } : s;
  const res: any = await call('POST', '/v1/ai/complete', body);
  console.log('\n\n=== Q: ' + (body.prompt ?? JSON.stringify(body.messages)) + (body.thread_id?` [thread ${body.thread_id}]`:'') + (body.response_schema?' [schema]':''));
  if (res.status >= 400) { console.log('STATUS ' + res.status + ' ' + JSON.stringify(res.body)); continue; }
  const b = res.body;
  console.log('--- content:\n' + b.content);
  if (process.env.TRACE) console.log('--- trace: ' + JSON.stringify(b.trace?.map((t:any)=>({k:t.kind,n:t.name,a:t.args,s:t.summary})), null, 1));
  if (process.env.ANALYSIS) console.log('--- analysis: ' + JSON.stringify(b.analysis));
}
app.close();
