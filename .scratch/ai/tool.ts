import { createApp } from '../../src/server/app';
import { aiRuntime } from '../../src/server/ai/runtime';
const app = await createApp({ db: 'memory', config: { env: 'test' } });
const [name, ...rest] = process.argv.slice(2);
const args = JSON.parse(rest.join(' ') || '{}');
const r = await aiRuntime(app.ctx).execute(name, args, {
  ctx: app.ctx, orgId: 'org_demo', actorId: 'usr_seed01', actorType: 'user', feature: 'test',
  runId: 'run_x', spans: [], pendingApprovals: [], startedNs: process.hrtime.bigint(), steps: 0,
} as any);
console.log(JSON.stringify(r, null, 1).slice(0, 2500));
process.exit(0);
