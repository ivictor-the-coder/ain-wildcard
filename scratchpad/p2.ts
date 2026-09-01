import { createApp, frozenClock } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
const ORG='org_demo';
const DANA: Auth = { kind:'session', orgId:ORG, userId:'usr_seed01', role:'owner', scopes:['*'], livemode:true };
const app = await createApp({ db:'memory', config:{env:'test'}, clock: frozenClock(Date.UTC(2026,5,1)) });
const call=(m:string,p:string,b?:unknown)=>app.handle({method:m,path:p,body:b,auth:DANA});
const ok=async(m:string,p:string,b?:unknown)=>{const r=await call(m,p,b); if(r.status>=400) throw new Error(`${m} ${p} ${r.status} ${JSON.stringify(r.body)}`); return r.body;};

const cus = await ok('POST','/v1/customers',{name:'Abandon Co',email:'a@x.example',currency:'usd'});
const sub = await ok('POST','/v1/subscriptions',{customer:cus.id, items:[{price:'growth_monthly'}]});
await app.tick();
const inv = (await ok('GET',`/v1/invoices?subscription=${sub.id}&limit=10`)).data[0];
console.log('bill', inv.number, inv.status, inv.amount_due);

// a card the issuer wants the cardholder for; customer is at the keyboard
const sca = await ok('POST','/v1/payment_methods',{type:'card',customer:cus.id,brand:'visa',exp_month:4,exp_year:2031,simulated_behavior:'authentication_required'});
const intent = await ok('POST','/v1/payment_intents',{customer:cus.id,invoice:inv.id,payment_method:sca.id,confirm:true,off_session:false});
console.log('intent', intent.status);

// meanwhile the bill is settled on a different card
const good = await ok('POST','/v1/payment_methods',{type:'card',customer:cus.id,brand:'visa',exp_month:4,exp_year:2031,simulated_behavior:'succeeds'});
await ok('POST','/v1/payment_intents',{customer:cus.id,invoice:inv.id,payment_method:good.id,confirm:true,off_session:true});
let bill = await ok('GET',`/v1/invoices/${inv.id}`);
console.log('bill after other card:', bill.status, 'due', bill.amount_due, 'paid', bill.amount_paid);
let s = await ok('GET',`/v1/subscriptions/${sub.id}`);
console.log('subscription:', s.status);

// the customer closes the 3-D Secure tab
const r = await call('POST',`/v1/payment_intents/${intent.id}/authenticate`,{result:'abandon'});
console.log('abandon ->', r.status, r.status>=400 ? JSON.stringify(r.body) : (r.body as any).status);
bill = await ok('GET',`/v1/invoices/${inv.id}`);
console.log('bill now:', bill.status, 'due', bill.amount_due, 'paid', bill.amount_paid);
s = await ok('GET',`/v1/subscriptions/${sub.id}`);
console.log('subscription now:', s.status);
const camps = (await ok('GET',`/v1/dunning?status=all&customer=${cus.id}`)).data;
for (const c of camps) console.log('  campaign', c.status, 'at_risk', c.amount_at_risk, 'attempts', c.attempt_count, 'next', c.next_attempt_at && new Date(c.next_attempt_at).toISOString(), '|', c.recommended_action?.slice(0,120));
app.close();
