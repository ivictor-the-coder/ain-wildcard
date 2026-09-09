import { createApp } from '../../src/server/app';
const app = await createApp({ db: 'memory' });
const db: any = (app.ctx as any).db;
const q=(s:string)=>db.all(s);
const now=(app.ctx as any).now();
const deals = q(`select r.id,r.display_name,r.owner_id,r.properties from crm_records r where r.object_type='deal'`).map((r:any)=>({...r,p:JSON.parse(r.properties)}));
const cos = q(`select id,display_name,properties from crm_records where object_type='company'`).map((r:any)=>({id:r.id,n:r.display_name,p:JSON.parse(r.properties)}));
const assoc = q(`select * from crm_associations`);
const openD = deals.filter((d:any)=>d.p.deal_status==='open');
const S=(a:any[])=>a.reduce((x,y)=>x+y.p.amount,0);
const money=(n:number)=>'$'+(n/100).toLocaleString('en-US');
for (const src of ['trade_show','partner_referral']) { const s=openD.filter((d:any)=>d.p.lead_source===src); console.log(src, s.length, money(S(s))); }
const commit=openD.filter((d:any)=>d.p.forecast_category==='commit'); console.log('commit', commit.length, money(S(commit)));
for (const c of ['tulip','cognite']) { const s=deals.filter((d:any)=>d.p.competitor===c); console.log(c,'total',s.length,'open',s.filter((d:any)=>d.p.deal_status==='open').length,'lost',s.filter((d:any)=>d.p.deal_status==='lost').length); }
// deals by industry via association company->deal
const dealCo:any={};
for (const a of assoc as any[]) { const co=cos.find((c:any)=>c.id===a.from_id||c.id===a.to_id); if(!co) continue; const other = a.from_id===co.id?a.to_id:a.from_id; const d=deals.find((x:any)=>x.id===other); if(d) dealCo[d.id]=co; }
for (const ind of ['aerospace','metals','pharma']) {
  const s=openD.filter((d:any)=>dealCo[d.id]?.p.industry===ind);
  console.log('industry '+ind, s.length, money(S(s)), JSON.stringify([...new Set(s.map((d:any)=>dealCo[d.id].n))]));
}
const dana='usr_seed01';
const mo=openD.filter((d:any)=>d.owner_id===dana); console.log('DANA open', mo.length, money(S(mo)));
const monthEnd=Date.UTC(2026,9,1); const monthStart=Date.UTC(2026,8,1);
const dm=deals.filter((d:any)=>d.owner_id===dana&&d.p.close_date>=monthStart&&d.p.close_date<monthEnd); console.log('DANA closing Sep', dm.length, JSON.stringify(dm.map((d:any)=>d.display_name)));
app.close();
