import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}});
const p=await c.newPage();
const errs=[];
p.on('pageerror',e=>errs.push('pageerror: '+e.message));
await p.goto(URL,{waitUntil:'domcontentloaded'});
await p.request.post(URL+'/api/v1/auth/demo');
await p.goto(URL+'/deals',{waitUntil:'networkidle'}); await p.waitForTimeout(900);
const desc=async()=>p.evaluate(()=>{const a=document.activeElement;if(!a)return'none';
 return a.tagName+' '+(a.getAttribute('aria-label')||a.className||'')+' :: '+(a.innerText||a.value||'').slice(0,45).replace(/\n/g,'/');});
await p.locator('body').click({position:{x:5,y:5}});
console.log('--- tabbing from top ---');
for(let i=0;i<34;i++){ await p.keyboard.press('Tab'); const d=await desc(); console.log(i,d.slice(0,110)); if(/pl-card__name|pl-card__menu/.test(d)) break; }
console.log('\n--- first card reached, now try keyboard stage move ---');
// tab to the card menu
let guard=0;
while(!/pl-card__menu|Actions for/.test(await desc()) && guard++<6) await p.keyboard.press('Tab');
console.log('focused:',(await desc()).slice(0,110));
await p.keyboard.press('Enter'); await p.waitForTimeout(500);
await p.screenshot({path:'/tmp/crit-drive/15-kbd-menu.png'});
const menu=p.locator('[role=menu]');
console.log('menu open?',await menu.count(), await menu.first().innerText().catch(()=>'').then(t=>t.replace(/\n/g,' | ').slice(0,300)));
for(let i=0;i<4;i++){await p.keyboard.press('ArrowDown'); }
console.log('menu focus:',(await desc()).slice(0,110));
await p.keyboard.press('Enter'); await p.waitForTimeout(1600);
await p.screenshot({path:'/tmp/crit-drive/16-kbd-moved.png'});
const t=await p.locator('body').innerText();
console.log('toast?',(t.match(/Moved to[\s\S]{0,140}/)||[''])[0].replace(/\n/g,' | '));
console.log('ERRS',errs);
await b.close();
