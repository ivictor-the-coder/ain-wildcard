import { createApp, frozenClock } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { DAY } from '../src/shared/time';
const ORG='org_demo';
const DANA: Auth = { kind:'session', orgId:ORG, userId:'usr_seed01', role:'owner', scopes:['*'], livemode:true };
const app = await createApp({ db:'memory', config:{env:'test'}, clock: frozenClock(Date.UTC(2026,5,1)) });
const call=(m:string,p:string,b?:unknown)=>app.handle({method:m,path:p,body:b,auth:DANA});
const ok=async(m:string,p:string,b?:unknown)=>{const r=await call(m,p,b); if(r.status>=400) throw new Error(`${m} ${p} ${r.status} ${JSON.stringify(r.body)}`); return r.body;};

const cus = await ok('POST','/v1/customers',{name:'Partial Co',email:'p@x.example',currency:'usd'});
// a card that always declines, so the first automatic collection opens a dunning campaign
const bad = await ok('POST','/v1/payment_methods',{type:'card',customer:cus.id,brand:'visa',exp_month:4,exp_year:2031,simulated_behavior:'insufficient_funds'});
const sub = await ok('POST','/v1/subscriptions',{customer:cus.id, items:[{price:'growth_monthly'}]});
await app.tick();
const inv = (await ok('GET',`/v1/invoices?subscription=${sub.id}&limit=10`)).data[0];
console.log('invoice', inv.number, inv.status, 'due', inv.amount_due);
let camp = (await ok('GET',`/v1/dunning?status=all&customer=${cus.id}`)).data[0];
console.log('campaign', camp.status, 'attempt', camp.attempt_count, 'next', camp.next_attempt_at && new Date(camp.next_attempt_at).toISOString(), 'at_risk', camp.amount_at_risk);

// the customer rings up and pays $200 of the $499 on a different card
const good = await ok('POST','/v1/payment_methods',{type:'card',customer:cus.id,brand:'visa',exp_month:4,exp_year:2031,simulated_behavior:'succeeds'});
await ok('POST','/v1/payment_intents',{customer:cus.id,invoice:inv.id,payment_method:good.id,amount:20000,confirm:true,off_session:false});

const after = await ok('GET',`/v1/invoices/${inv.id}`);
console.log('invoice after part payment:', after.status, 'paid', after.amount_paid, 'due', after.amount_due);
camp = (await ok('GET',`/v1/dunning?status=all&customer=${cus.id}`)).data[0];
console.log('campaign now:', camp.status, 'recovered_amount', camp.recovered_amount, 'next', camp.next_attempt_at, 'resolution:', camp.resolution);
const t = await app.travel(400*DAY);
console.log('travel 400d ->', t);
const bill = await ok('GET',`/v1/invoices/${inv.id}`);
console.log('after a year:', bill.status, 'due', bill.amount_due, 'paid', bill.amount_paid);
const camps = (await ok('GET',`/v1/dunning?status=all&customer=${cus.id}`)).data;
for (const c of camps) console.log('  campaign', c.invoice, c.status, 'attempts', c.attempt_count, 'next', c.next_attempt_at);
const s = await ok('GET',`/v1/subscriptions/${sub.id}`);
console.log('subscription', s.status);
app.close();
