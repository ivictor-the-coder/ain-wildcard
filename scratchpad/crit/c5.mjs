import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}});
const p=await c.newPage();
const errs=[];
p.on('pageerror',e=>errs.push('pageerror: '+e.message));
p.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=400&&!r.url().includes('/v1/me'))errs.push(r.status()+' '+r.request().method()+' '+r.url().replace(URL,''))});
await p.goto(URL,{waitUntil:'domcontentloaded'});
await p.request.post(URL+'/api/v1/auth/demo');
// runs & traces
await p.goto(URL+'/copilot/runs',{waitUntil:'networkidle'}).catch(()=>{});
await p.waitForTimeout(1200);
console.log('URL:',p.url());
await p.screenshot({path:'/tmp/crit-drive/26-runs.png',fullPage:true});
console.log('RUNS PAGE:\n'+(await p.locator('main').innerText()).slice(0,2200));
console.log('ERRS',errs);
await b.close();
