import { createApp } from '../../src/server/app';
const ORG = 'org_demo';
const DANA = { kind: 'session' as const, orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const app = await createApp({ db: 'memory', config: { env: 'test' } });
const cases: [string, unknown][] = [
  ['What is our win rate in the Expansion pipeline?', { type: 'object', properties: { pipeline: { type: 'string' }, win_rate: { type: 'number' }, decided: { type: 'integer' } } }],
  ['How much open pipeline is in Expansion?', { type: 'object', properties: { pipeline_name: { type: 'string' }, open_pipeline: { type: 'number' } } }],
  ['How much open pipeline is in the Expansion pipeline?', { type: 'object', properties: { pipeline: { type: 'string' }, amount: { type: 'number' } } }],
  ['List the 5 biggest open deals', { type: 'object', properties: { deals: { type: 'array', items: { type: 'string' } } } }],
];
for (const [prompt, response_schema] of cases) {
  const res: any = (await app.handle({ method: 'POST', path: '/v1/ai/complete', body: { prompt, response_schema }, auth: DANA })).body;
  console.log('Q:', prompt);
  console.log('   ->', res.content);
  console.log('   refusal:', JSON.stringify(res.analysis?.refusal), 'quals:', JSON.stringify((res.analysis?.qualifiers??[]).map((q:any)=>[q.kind,q.text,q.state])));
}
process.exit(0);
