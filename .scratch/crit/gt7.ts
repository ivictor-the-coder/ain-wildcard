import { createApp } from '../../src/server/app';
const app = await createApp({ db: 'memory' });
const db: any = (app.ctx as any).db;
const deals = db.all(`select properties from crm_records where object_type='deal'`).map((r:any)=>JSON.parse(r.properties));
const st:any={}; for(const d of deals) st[d.deal_stage]=(st[d.deal_stage]||0)+1;
console.log('deal stages:', JSON.stringify(st));
console.log('closed_won total:', deals.filter((d:any)=>d.deal_stage==='closed_won').length);
console.log('by pipeline closed_won:', JSON.stringify(deals.filter((d:any)=>d.deal_stage==='closed_won').reduce((a:any,d:any)=>{a[d.pipeline]=(a[d.pipeline]||0)+1;return a},{})));
app.close();
