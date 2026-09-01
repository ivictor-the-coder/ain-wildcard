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
await p.goto(URL+'/copilot',{waitUntil:'networkidle'}); await p.waitForTimeout(900);

// New conversation -> empty state
await p.getByRole('button',{name:'New conversation'}).click(); await p.waitForTimeout(900);
await p.screenshot({path:'/tmp/crit-drive/20-newconv.png'});
console.log('EMPTY STATE:\n'+(await p.locator('main').innerText()).slice(0,1600));
console.log('ERRS',errs);
await b.close();
