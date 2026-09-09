import { createApp } from '../../src/server/app';
const app = await createApp({ db: 'memory' });
const db: any = (app.ctx as any).db;
const sql = process.argv.slice(2).join(' ');
try {
  const rows = db.all ? db.all(sql) : db.prepare(sql).all();
  console.log(JSON.stringify(rows, null, 1));
} catch (e:any) { console.error('ERR', e.message); }
app.close();
