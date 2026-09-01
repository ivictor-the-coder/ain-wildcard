import { createApp, frozenClock } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { DAY } from '../src/shared/time';
const ORG='org_demo';
const DANA: Auth = { kind:'session', orgId:ORG, userId:'usr_seed01', role:'owner', scopes:['*'], livemode:true };
const app = await createApp({ db:'memory', config:{env:'test'}, clock: frozenClock(Date.UTC(2026,5,1)) });
const call=(m:string,p:string,b?:unknown)=>app.handle({method:m,path:p,body:b,auth:DANA});
const ok=async(m:string,p:string,b?:unknown)=>{const r=await call(m,p,b); if(r.status>=400) throw new Error(`${m} ${p} ${r.status} ${JSON.stringify(r.body)}`); return r.body;};

const cus = await ok('POST','/v1/customers',{name:'Returned Co',email:'r@x.example',currency:'usd'});
const sub = await ok('POST','/v1/subscriptions',{customer:cus.id, items:[{price:'growth_monthly'}]});
await app.tick();
const inv = (await ok('GET',`/v1/invoices?subscription=${sub.id}&limit=10`)).data[0];
// a debit that will come back unpaid
const debit = await ok('POST','/v1/payment_methods',{type:'bank_debit',customer:cus.id,bank_name:'Midland Union Bank',account_type:'checking',simulated_behavior:'no_account'});
const pi = await ok('POST','/v1/payment_intents',{customer:cus.id,invoice:inv.id,payment_method:debit.id,confirm:true,off_session:true});
console.log('intent', pi.status);
// the whole bill is credited away while the debit is with the bank
await ok('POST','/v1/credit_notes',{invoice:inv.id, amount: inv.total, reason:'order_change'});
let bill = await ok('GET',`/v1/invoices/${inv.id}`);
console.log('bill after credit note:', bill.status, 'due', bill.amount_due, 'paid', bill.amount_paid);
console.log('subscription before settle:', (await ok('GET',`/v1/subscriptions/${sub.id}`)).status);
const t = await app.travel(5*DAY);
console.log('travel', t);
bill = await ok('GET',`/v1/invoices/${inv.id}`);
console.log('bill after the debit came back unpaid:', bill.status, 'due', bill.amount_due, 'paid', bill.amount_paid);
console.log('subscription now:', (await ok('GET',`/v1/subscriptions/${sub.id}`)).status);
for (const c of (await ok('GET',`/v1/dunning?status=all&customer=${cus.id}`)).data)
  console.log('  campaign', c.invoice, c.status, 'at_risk', c.amount_at_risk, 'attempts', c.attempt_count, '|', (c.resolution??'').slice(0,110));
app.close();
