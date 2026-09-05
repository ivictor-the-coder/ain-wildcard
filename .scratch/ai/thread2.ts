import { createApp } from '../../src/server/app';
const ORG = 'org_demo';
const DANA = { kind: 'session' as const, orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const app = await createApp({ db: 'memory', config: { env: 'test' } });
const call = (m: string, p: string, b?: unknown) => app.handle({ method: m, path: p, body: b, auth: DANA });
const turns = process.argv.slice(2);
const t: any = (await call('POST', '/v1/ai/threads', { message: turns[0] })).body;
console.log('T1:', t.messages?.[1]?.content?.slice(0, 400));
for (const q of turns.slice(1)) {
  const r: any = (await call('POST', `/v1/ai/threads/${t.id}/messages`, { content: q })).body;
  console.log(`T "${q}":`, (r.message?.content ?? JSON.stringify(r)).slice(0, 500));
}
process.exit(0);
