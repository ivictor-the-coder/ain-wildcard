import { createApp } from '../../src/server/app';
const app = await createApp({ db: 'memory' });
const db: any = (app.ctx as any).db;
const q=(s:string)=>db.all(s);
const now=(app.ctx as any).now();
console.log('NOW', new Date(now).toISOString());
const deals = q(`select r.id,r.display_name,r.owner_id,r.properties from crm_records r where r.object_type='deal'`).map((r:any)=>({...r,p:JSON.parse(r.properties)}));
const ls:any={}; for(const d of deals){ ls[d.p.lead_source||'-']=(ls[d.p.lead_source||'-']||0)+1 }
console.log('lead sources:', JSON.stringify(ls));
const comp:any={}; for(const d of deals){ if(d.p.competitor) comp[d.p.competitor]=(comp[d.p.competitor]||0)+1 }
console.log('competitors:', JSON.stringify(comp));
const fc:any={}; for(const d of deals){ fc[d.p.forecast_category||'-']=(fc[d.p.forecast_category||'-']||0)+1 }
console.log('forecast:', JSON.stringify(fc));
const openD = deals.filter((d:any)=>d.p.deal_status==='open');
const pr = openD.filter((d:any)=>/partner/i.test(d.p.lead_source||''));
console.log('open partner-referral deals:', pr.length, pr.reduce((a:any,b:any)=>a+b.p.amount,0));
const sie = deals.filter((d:any)=>/siemens/i.test(d.p.competitor||''));
console.log('siemens deals:', sie.length, 'open:', sie.filter((d:any)=>d.p.deal_status==='open').length);
// industries
const cos = q(`select display_name, properties from crm_records where object_type='company'`).map((r:any)=>({n:r.display_name,p:JSON.parse(r.properties)}));
const ind:any={}; for(const c of cos){ ind[c.p.industry||'-']=(ind[c.p.industry||'-']||0)+1 }
console.log('industries:', JSON.stringify(ind));
console.log('pharma cos:', JSON.stringify(cos.filter((c:any)=>/pharma/i.test(c.p.industry||'')).map((c:any)=>c.n)));
// next 30 days
const in30 = openD.filter((d:any)=>d.p.close_date>=now && d.p.close_date<=now+30*86400000);
console.log('closing next 30 days:', in30.length, in30.reduce((a:any,b:any)=>a+b.p.amount,0));
// owner of demo user
console.log('users:', JSON.stringify(q("select id,name,email from users")));
const dana = q("select id from users where email='dana@northwind.io'")[0];
const mine = deals.filter((d:any)=>d.owner_id===dana.id).sort((a:any,b:any)=>b.p.amount-a.p.amount).slice(0,3);
console.log('DANA top3 deals:', JSON.stringify(mine.map((d:any)=>d.display_name+' '+d.p.amount)));
app.close();
