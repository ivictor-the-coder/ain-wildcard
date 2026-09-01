import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}});
const p=await c.newPage();
const errs=[];
p.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text())});
p.on('pageerror',e=>errs.push('pageerror: '+e.message));
p.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=400)errs.push(r.status()+' '+r.request().method()+' '+r.url().replace(URL,''))});
await p.goto(URL,{waitUntil:'domcontentloaded'});
await p.request.post(URL+'/api/v1/auth/demo');
await p.goto(URL+'/deals/deal_bCBbAn9Cdg2y5A',{waitUntil:'networkidle'});
await p.waitForTimeout(900);
await p.screenshot({path:'/tmp/crit-drive/07-record.png',fullPage:true});
console.log('RECORD TEXT:\n'+(await p.locator('main').innerText()).slice(0,3000));
console.log('\n---- buttons ----');
for(const el of await p.locator('main button').all()){
  const t=(await el.innerText()).trim()||await el.getAttribute('aria-label')||'';
  if(t) console.log('BTN',JSON.stringify(t.slice(0,60)));
}
console.log('ERRS',errs);
await b.close();
