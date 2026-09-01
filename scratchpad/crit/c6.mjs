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
await p.goto(URL+'/copilot/runs',{waitUntil:'networkidle'}); await p.waitForTimeout(1000);
// Approvals tab
await p.getByRole('tab',{name:'Approvals'}).click().catch(async()=>{await p.getByText('Approvals',{exact:true}).click()});
await p.waitForTimeout(1200);
await p.screenshot({path:'/tmp/crit-drive/27-approvals.png',fullPage:true});
console.log('APPROVALS TAB:\n'+(await p.locator('main').innerText()).slice(0,1400));
// open a trace: back to Runs, click a row
await p.getByText('Runs',{exact:true}).first().click(); await p.waitForTimeout(900);
await p.locator('table tbody tr').first().click(); await p.waitForTimeout(1400);
await p.screenshot({path:'/tmp/crit-drive/28-trace.png',fullPage:true});
const t=await p.locator('body').innerText();
console.log('\n=== TRACE VIEW ===\n'+t.slice(Math.max(0,t.indexOf('Trace')-100)).slice(0,2200));
console.log('ERRS',errs);
await b.close();
