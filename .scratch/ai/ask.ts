import { createApp } from '../../src/server/app';
const ORG = 'org_demo';
const DANA = { kind: 'session' as const, orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const app = await createApp({ db: 'memory', config: { env: 'test' } });
const qs = process.argv.slice(2);
for (const q of qs) {
  const res = await app.handle({ method: 'POST', path: '/v1/ai/complete', body: { prompt: q }, auth: DANA });
  const b: any = res.body;
  console.log('Q:', q);
  console.log('A:', b.content);
  console.log('  refusal:', JSON.stringify(b.analysis?.refusal));
  console.log('  metric:', JSON.stringify(b.analysis?.metric), 'groupBy:', b.analysis?.groupBy, 'types:', JSON.stringify(b.analysis?.types));
  console.log('  quals:', JSON.stringify((b.analysis?.qualifiers ?? []).map((q: any) => [q.kind, q.text, q.state, q.detail])));
  console.log('  plan:', JSON.stringify((b.analysis?.plan ?? []).map((p: any) => [p.tool, p.args])));
  console.log('---');
}
process.exit(0);
