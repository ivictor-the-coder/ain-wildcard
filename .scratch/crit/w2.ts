import { createApp } from '../../src/server/app';
const app = await createApp({ db: 'memory' });
const login = await app.handle({ method: 'POST', path: '/v1/auth/demo' });
const cookie = String(login.headers['set-cookie'] || '').split(';')[0];
const call = (m: string, p: string, b?: unknown) => app.handle({ method: m, path: p, body: b, headers: { cookie } });
for (const p of [
 'Move the deal "Meridian Forge Systems — predictive maintenance add-on" to Proposal sent.',
 'Set the close date on the Calder & Vance Manufacturing connected asset expansion deal to 2026-12-01.',
]) {
  const w: any = await call('POST','/v1/ai/complete',{prompt:p, allow_writes:true});
  console.log('\n>>',p,'\n', String(w.body?.content).slice(0,400), '\npending:', JSON.stringify(w.body?.pending_approvals).slice(0,400));
}
// approve the first one for real
const w: any = await call('POST','/v1/ai/complete',{prompt:'Move the Meridian Forge Systems predictive maintenance add-on deal to Proposal sent.', allow_writes:true});
const ap: any = await call('GET','/v1/ai/approvals');
const id = (ap.body as any).data?.[0]?.id;
console.log('\napproval id', id);
const r: any = await call('POST', `/v1/ai/approvals/${id}`, { decision: 'approve' });
console.log('approve ->', r.status, JSON.stringify(r.body).slice(0,300));
const db:any=(app.ctx as any).db;
console.log('deal_nw_01 now:', JSON.stringify(db.all("select display_name,properties from crm_records where id='deal_nw_01'")).slice(0,300));
app.close();
