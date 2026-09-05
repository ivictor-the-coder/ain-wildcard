import { createApp } from '../../src/server/app';
const app = await createApp({ db: 'memory', config: { env: 'test' } });
const sql = process.argv.slice(2).join(' ');
console.log(JSON.stringify(app.ctx.db.all(sql), null, 1));
process.exit(0);
