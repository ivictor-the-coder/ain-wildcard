import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950},deviceScaleFactor:1});
const p=await c.newPage();
const errs=[];
p.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text())});
p.on('pageerror',e=>errs.push('pageerror: '+e.message));
p.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=400)errs.push(r.status()+' '+r.request().method()+' '+r.url().replace(URL,''))});
await p.goto(URL,{waitUntil:'domcontentloaded'});
await p.request.post(URL+'/api/v1/auth/demo');
await p.goto(URL+'/deals',{waitUntil:'networkidle'});

// TASK 1: create a deal
await p.getByRole('button',{name:'New deal'}).first().click();
await p.waitForTimeout(600);
await p.screenshot({path:'/tmp/crit-drive/01-newdeal.png'});
// dump the dialog fields
const dlg = p.locator('[role=dialog]');
console.log('DIALOG TEXT:\n'+(await dlg.innerText()).slice(0,2000));
console.log('---- controls ----');
for (const el of await dlg.locator('input,select,textarea,button').all()){
  const tag=await el.evaluate(e=>e.tagName);
  const name=await el.getAttribute('name')||await el.getAttribute('aria-label')||await el.getAttribute('placeholder')||(await el.innerText().catch(()=>''));
  const t=await el.getAttribute('type')||'';
  console.log(tag,JSON.stringify(name),t);
}
console.log('ERRS',errs);
await b.close();
