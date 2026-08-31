import { chromium } from '@playwright/test';
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1440,height:900}});
await p.goto('http://127.0.0.1:8821/design',{waitUntil:'networkidle'});
console.log(JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('button')].map(b=>({t:(b.textContent||'').trim().slice(0,24),l:b.getAttribute('aria-label'),c:b.className.slice(0,44)})).filter(x=>/filter|chip|column|sort|view/i.test(x.t+' '+x.l+' '+x.c))),null,0));
await b.close();
