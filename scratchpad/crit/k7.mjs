import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8861';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}}); const p=await c.newPage();
await p.goto(URL+'/deals',{waitUntil:'networkidle'}); await p.waitForTimeout(1500);
await p.screenshot({path:'/tmp/crit-drive/40-unauth.png'});
console.log('UNAUTH /deals:\n'+(await p.locator('body').innerText()).slice(0,500));
await b.close();
