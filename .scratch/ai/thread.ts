import { createApp } from '../../src/server/app';
const ORG = 'org_demo';
const DANA = { kind: 'session' as const, orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const app = await createApp({ db: 'memory', config: { env: 'test' } });
const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, body, auth: DANA });

// Scenario A: turn 1 via /v1/ai/complete with thread_id, turn 2 via threads route
let t: any = (await call('POST', '/v1/ai/threads', {})).body;
console.log('thread', t.id);
let r: any = (await call('POST', '/v1/ai/complete', { prompt: 'How many open deals does Priya Raman have?', thread_id: t.id })).body;
console.log('A turn1:', r.content, '| carried:', JSON.stringify(r.analysis?.carried_subject ?? r.analysis?.carriedSubject));
let r2: any = (await call('POST', `/v1/ai/threads/${t.id}/messages`, { content: 'And how many of those are in Negotiation?' })).body;
console.log('A turn2:', r2.message?.content ?? JSON.stringify(r2).slice(0,300));
console.log('msgs:', JSON.stringify((await call('GET', `/v1/ai/threads/${t.id}`)).body.messages?.map((m:any)=>[m.role,m.content.slice(0,60)])));

// Scenario B: both via /v1/ai/complete
let t2: any = (await call('POST', '/v1/ai/threads', {})).body;
let b1: any = (await call('POST', '/v1/ai/complete', { prompt: 'How many open deals does Priya Raman have?', thread_id: t2.id })).body;
console.log('B turn1:', b1.content);
let b2: any = (await call('POST', '/v1/ai/complete', { prompt: 'And how many of those are in Negotiation?', thread_id: t2.id })).body;
console.log('B turn2:', b2.content);

// Scenario C: all via threads route (works today)
let t3: any = (await call('POST', '/v1/ai/threads', { message: 'How many open deals does Priya Raman have?' })).body;
console.log('C turn1:', t3.messages?.map((m:any)=>m.content).join(' || '));
let c2: any = (await call('POST', `/v1/ai/threads/${t3.id}/messages`, { content: 'And how many of those are in Negotiation?' })).body;
console.log('C turn2:', c2.message?.content);
process.exit(0);
