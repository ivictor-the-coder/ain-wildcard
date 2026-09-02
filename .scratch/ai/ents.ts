import { createApp } from '../../src/server/app';
import { entityIndex } from '../../src/server/ai/grounding';
import { resolveEntities } from '../../src/server/ai/resolve';
const app = await createApp({ db: 'memory', config: { env: 'test' } });
const idx = entityIndex(app.ctx, 'org_demo');
for (const q of process.argv.slice(2)) {
  console.log(q, JSON.stringify(resolveEntities(q, idx, { limit: 6, dedupe: true }).map(e=>[e.entity.label,e.entity.type,e.score,e.rule,e.mention])));
}
process.exit(0);
