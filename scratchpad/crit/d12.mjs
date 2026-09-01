import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}});
const p=await c.newPage();
await p.goto(URL,{waitUntil:'domcontentloaded'});
await p.request.post(URL+'/api/v1/auth/demo');
await p.goto(URL+'/deals?display=table',{waitUntil:'networkidle'}); await p.waitForTimeout(900);
const th=p.locator('table thead th');
console.log('th count',await th.count());
for(let i=0;i<await th.count();i++){
  const h=th.nth(i);
  const btn=h.locator('button');
  console.log(i,JSON.stringify((await h.innerText()).trim().slice(0,20)),'buttons:',await btn.count(), 'aria-sort:',await h.getAttribute('aria-sort'));
}
const amtBtn=th.nth(3).locator('button').first();
console.log('clicking amount sort button:',JSON.stringify(await amtBtn.innerText()));
await amtBtn.click(); await p.waitForTimeout(600);
console.log('aria-sort now',await th.nth(3).getAttribute('aria-sort'));
console.log('row1:',(await p.locator('table tbody tr').first().innerText()).replace(/\t/g,' | '));
await amtBtn.click(); await p.waitForTimeout(600);
console.log('aria-sort now',await th.nth(3).getAttribute('aria-sort'));
console.log('row1:',(await p.locator('table tbody tr').first().innerText()).replace(/\t/g,' | '));
await b.close();
