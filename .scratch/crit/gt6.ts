import { createApp } from '../../src/server/app';
const app = await createApp({ db: 'memory' });
const db: any = (app.ctx as any).db;
const q=(s:string)=>db.all(s);
const t = q(`select display_name, owner_id, properties from crm_records where object_type='ticket'`).map((r:any)=>({n:r.display_name,p:JSON.parse(r.properties)}));
const st:any={},pr:any={};
for(const x of t){ st[x.p.ticket_status||x.p.status||'-']=(st[x.p.ticket_status||x.p.status||'-']||0)+1; pr[x.p.priority||'-']=(pr[x.p.priority||'-']||0)+1 }
console.log('ticket statuses:', JSON.stringify(st));
console.log('ticket priorities:', JSON.stringify(pr));
console.log('sample ticket props:', JSON.stringify(t[0].p));
const openT = t.filter((x:any)=>!['closed','resolved'].includes(String(x.p.ticket_status||'').toLowerCase()));
console.log('open tickets:', openT.length, JSON.stringify(openT.map((x:any)=>x.p.ticket_status+'/'+x.p.priority)));
const deals = q(`select owner_id, properties from crm_records where object_type='deal'`).map((r:any)=>({o:r.owner_id,p:JSON.parse(r.properties)}));
const byo:any={}; for(const d of deals) byo[d.o]=(byo[d.o]||0)+1;
console.log('deals per owner:', JSON.stringify(byo));
const cw = deals.filter((d:any)=>d.p.deal_stage==='closed_won'&&d.p.pipeline==='expansion');
console.log('expansion closed_won:', cw.length, JSON.stringify(cw.map((d:any)=>new Date(d.p.close_date).toISOString().slice(0,10))));
app.close();
