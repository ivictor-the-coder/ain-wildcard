import { createApp } from '../../src/server/app';
const app = await createApp({ db: 'memory' });
const login = await app.handle({ method: 'POST', path: '/v1/auth/demo' });
const cookie = String(login.headers['set-cookie'] || '').split(';')[0];
const call = (m: string, p: string, b?: unknown) => app.handle({ method: m, path: p, body: b, headers: { cookie } });
const d: any = await call('POST','/v1/ai/draft',{kind:'email', instruction:'Follow up with Meridian Forge Systems about the renewal'});
console.log('draft', d.status, JSON.stringify(d.body).slice(0,600));
for (const p of ['Log a note on Meridian Forge Systems saying we agreed pricing.','Move the Meridian Forge Systems predictive maintenance add-on deal to Proposal sent.']) {
  const w: any = await call('POST','/v1/ai/complete',{prompt:p, allow_writes:true});
  console.log('\n>>',p,'\n', String(w.body?.content).slice(0,500), '\npending:', JSON.stringify(w.body?.pending_approvals).slice(0,300));
}
app.close();
