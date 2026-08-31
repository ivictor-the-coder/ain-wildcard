import { ws } from './lib';
const w = await ws();
const p = await w.ok('GET','/v1/prices?limit=100');
console.log(p.data.map((x:any)=>[x.id,x.currency,x.unit_amount,x.recurring?.interval,x.model??x.billing_scheme].join(' ')).join('\n'));
w.close();
