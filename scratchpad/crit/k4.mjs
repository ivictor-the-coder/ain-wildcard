import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}}); const p=await c.newPage();
await p.goto(URL,{waitUntil:'domcontentloaded'}); await p.request.post(URL+'/api/v1/auth/demo');
await p.goto(URL+'/deals/deal_bCBbAn9Cdg2y5A',{waitUntil:'networkidle'}); await p.waitForTimeout(900);
const dlg=p.locator('[role=dialog]');
await p.getByRole('button',{name:'Log activity'}).first().click(); await p.waitForTimeout(600);
console.log('kind controls:');
for(const el of await dlg.locator('button').all()){const x=(await el.innerText()).trim();if(x)console.log('  BTN',JSON.stringify(x),'pressed=',await el.getAttribute('aria-pressed'),'checked=',await el.getAttribute('aria-checked'),'class=',(await el.getAttribute('class')||'').slice(0,50));}
await dlg.getByRole('button',{name:'Meeting',exact:true}).click(); await p.waitForTimeout(400);
console.log('after clicking Meeting, submit label:',await dlg.getByRole('button',{name:/^Log /}).innerText());
await dlg.locator('input').first().fill('CRITIC meeting probe');
await dlg.getByRole('button',{name:/^Log /}).click(); await p.waitForTimeout(1600);
await b.close();
