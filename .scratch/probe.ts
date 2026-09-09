import { createApp } from '../src/server/app';

const app = await createApp({ db: 'memory' });
const login = await app.handle({ method: 'POST', path: '/v1/auth/demo' });
const cookie = String(login.headers['set-cookie'] || '').split(';')[0];
const call = (method: string, path: string, body?: unknown) =>
  app.handle({ method, path, body, headers: { cookie } });

const probes: { label: string; body: Record<string, unknown> }[] = [
  { label: 'compare two quarters', body: { prompt: 'Compare Q1 2026 and Q2 2026 bookings' } },
  { label: 'compare bare quarters', body: { prompt: 'Compare Q1 and Q2 bookings' } },
  { label: 'compare unsupported period', body: { prompt: 'Compare Q1 2026 and H2 2026 bookings' } },
  { label: 'compare yoy', body: { prompt: 'How did bookings this quarter compare with the same period last year?' } },
  { label: 'q2 alone', body: { prompt: 'How much did we book in Q2 2026?' } },
  { label: 'tools allowlist', body: { prompt: 'What is our open pipeline by stage?', tools: ['record_timeline'] } },
  { label: 'tools empty', body: { prompt: 'What is our open pipeline by stage?', tools: [] } },
  { label: 'tools unknown', body: { prompt: 'What is our open pipeline?', tools: ['nope'] } },
  { label: 'bad model', body: { prompt: 'What is our open pipeline?', model: 'gpt-9-turbo' } },
  { label: 'act: create task', body: { prompt: 'Create a task to call the plant manager at Rheinwerk Antriebstechnik next Tuesday', allow_writes: true } },
  { label: 'act: move deal', body: { prompt: 'Move the Rheinwerk OEE programme phase 2 deal to Negotiation', allow_writes: true } },
  { label: 'act: add note', body: { prompt: 'Add a note to Rheinwerk Antriebstechnik saying the pilot is delayed until October because of the PLC firmware issue', allow_writes: true } },
  { label: 'act: followup', body: { prompt: 'Schedule a follow-up with Aldergate Semiconductor in 5 days', allow_writes: true } },
  { label: 'act: no writes allowed', body: { prompt: 'Add a note to Rheinwerk Antriebstechnik saying the pilot slipped' } },
  { label: 'gibberish', body: { prompt: 'asdkjhasd qwe zzz' } },
  { label: 'the', body: { prompt: 'the' } },
  { label: 'purple monkey', body: { prompt: 'purple monkey dishwasher' } },
  { label: 'qmarks', body: { prompt: '????' } },
  { label: 'sql', body: { prompt: "'; DROP TABLE companies; --" } },
  { label: 'flurb', body: { prompt: 'What is our flurb rate this quarter?' } },
  { label: 'slipping deals', body: { prompt: 'Which deals are at risk of slipping this quarter?' } },
  { label: 'business health', body: { prompt: 'How are we doing?' } },
  { label: 'state of business', body: { prompt: 'Summarise the state of the business and tell me what to do next' } },
  { label: 'halstead', body: { prompt: 'Tell me about Halstead Precision' } },
  { label: 'pipeline by stage', body: { prompt: 'What is our open pipeline by stage?' } },
];

for (const probe of probes) {
  const res = await call('POST', '/v1/ai/complete', probe.body);
  const body = res.body as any;
  console.log(`\n\x1b[1m=== ${probe.label} — ${JSON.stringify(probe.body).slice(0, 110)}\x1b[0m`);
  console.log(`status ${res.status}`);
  if (res.status >= 400) { console.log(JSON.stringify(body.error)); continue; }
  const a = body.analysis;
  console.log(`intent=${a?.intent} conf=${a?.confidence} refusal=${JSON.stringify(a?.refusal)} finish=${body.finish_reason}`);
  console.log(`windows=${JSON.stringify((a?.windows ?? []).map((w: any) => w.label))} comparison=${a?.comparison ? `${a.comparison.a.label} vs ${a.comparison.b.label} (${a.comparison.source})` : 'null'}`);
  console.log(`tools=${JSON.stringify(body.tool_calls.map((t: any) => t.name))} approvals=${body.pending_approvals.length} citations=${JSON.stringify(body.citations.map((c: any) => c.label).slice(0, 6))}`);
  console.log(`--- content ---\n${body.content}`);
}

const approvals = await call('GET', '/v1/ai/approvals');
console.log('\n\x1b[1m=== pending approvals\x1b[0m');
for (const row of (approvals.body as any).data) {
  console.log(JSON.stringify({ id: row.id, tool: row.tool, args: row.args, preview: row.preview }, null, 1));
}

app.close();
