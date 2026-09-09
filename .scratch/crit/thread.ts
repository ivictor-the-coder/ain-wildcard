import { createApp } from '../../src/server/app';
const app = await createApp({ db: 'memory' });
const login = await app.handle({ method: 'POST', path: '/v1/auth/demo' });
const cookie = String(login.headers['set-cookie'] || '').split(';')[0];
const call = (m: string, p: string, b?: unknown) => app.handle({ method: m, path: p, body: b, headers: { cookie } });
const t: any = await call('POST', '/v1/ai/threads', { title: 'crit' });
const id = (t.body as any).id;
const turns = [
  'How much open pipeline does Priya Raman own?',
  'And in the Renewal pipeline?',
  'What about Marcus Ilori?',
  'Show me the three smallest of those.',
];
for (const p of turns) {
  const r: any = await call('POST', '/v1/ai/complete', { thread_id: id, prompt: p });
  console.log('\n>>> ' + p + '\n' + (r.status>=400? JSON.stringify(r.body) : r.body.content));
}
// second thread: account scope carried
const t2: any = await call('POST', '/v1/ai/threads', { title: 'crit2' });
const id2 = (t2.body as any).id;
for (const p of ['Give me an overview of Kestrel Aerospace Components.','How much have they paid us this year?','What is their credit balance?','How many telemetry events did they meter in August 2026?']) {
  const r: any = await call('POST', '/v1/ai/complete', { thread_id: id2, prompt: p });
  console.log('\n### ' + p + '\n' + (r.status>=400? JSON.stringify(r.body) : r.body.content));
}
// schema on scoped run
for (const spec of [
  { prompt: 'Summarise open pipeline for Marcus Ilori in the Renewal pipeline.', response_schema: { type:'object', properties: { owner:{type:'string'}, open_pipeline_cents:{type:'integer'}, deal_count:{type:'integer'} } } },
  { prompt: 'How much open pipeline does Priya Raman own?', response_schema: { type:'object', properties: { amount:{type:'number'}, count:{type:'integer'}, scope:{type:'string'} } } },
]) {
  const r: any = await call('POST', '/v1/ai/complete', spec as any);
  console.log('\n@@@ ' + spec.prompt + '\n' + (r.status>=400? JSON.stringify(r.body) : r.body.content));
}
app.close();
