import { createApp, frozenClock } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { DAY } from '../src/shared/time';
const ORG='org_demo';
const DANA: Auth = { kind:'session', orgId:ORG, userId:'usr_seed01', role:'owner', scopes:['*'], livemode:true };
const app = await createApp({ db:'memory', config:{env:'test'}, clock: frozenClock(Date.UTC(2026,5,1)) });
const call=(m:string,p:string,b?:unknown)=>app.handle({method:m,path:p,body:b,auth:DANA});
const ok=async(m:string,p:string,b?:unknown)=>{const r=await call(m,p,b); if(r.status>=400) throw new Error(`${m} ${p} ${r.status} ${JSON.stringify(r.body)}`); return r.body;};

const cus = await ok('POST','/v1/customers',{name:'Paused Co',email:'pa@x.example',currency:'usd'});
// declines twice, then works — so a retry after the pause WOULD take the money
await ok('POST','/v1/payment_methods',{type:'card',customer:cus.id,brand:'visa',exp_month:4,exp_year:2031,simulated_behavior:'insufficient_funds',simulated_decline_count:1,set_default:true});
const sub = await ok('POST','/v1/subscriptions',{customer:cus.id, items:[{price:'growth_monthly'}]});
await app.tick();
const inv = (await ok('GET',`/v1/invoices?subscription=${sub.id}&limit=10`)).data[0];
console.log('bill', inv.number, inv.status, inv.amount_due);
let c = (await ok('GET',`/v1/dunning?status=all&customer=${cus.id}`)).data[0];
console.log('campaign', c.status, 'next', new Date(c.next_attempt_at).toISOString());
const paused = await ok('POST',`/v1/subscriptions/${sub.id}/pause`,{behavior:'keep_as_draft'});
console.log('subscription paused ->', paused.status, JSON.stringify(paused.pause_collection ?? null));
const t = await app.travel(20*DAY);
console.log('travel', t);
const bill = await ok('GET',`/v1/invoices/${inv.id}`);
console.log('bill after 20 days paused:', bill.status, 'due', bill.amount_due, 'paid', bill.amount_paid);
const charges = (await ok('GET',`/v1/charges?customer=${cus.id}&status=all&limit=50`)).data;
for (const ch of charges) console.log('  charge', ch.status, ch.amount, new Date(ch.created).toISOString().slice(0,10));
console.log('subscription now', (await ok('GET',`/v1/subscriptions/${sub.id}`)).status);
app.close();
