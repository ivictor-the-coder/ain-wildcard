import { chromium } from '@playwright/test';
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1100,height:800}});
await p.goto('http://127.0.0.1:8821/design',{waitUntil:'networkidle'});
const add = p.locator('button[aria-label="Filters"]').first();
await add.scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
await add.click(); await p.waitForTimeout(400);
console.log(JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('button,[role=button]')].map(b=>({t:(b.textContent||'').trim().slice(0,26),c:b.className.slice(0,40)})).filter(x=>/filter|chip|Issued|Status|add/i.test(x.t+x.c)))));
await p.screenshot({path:'/tmp/crit/filters_bar.png'});
await b.close();
