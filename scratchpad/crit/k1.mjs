import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}});
const p=await c.newPage();
const errs=[]; p.on('pageerror',e=>errs.push('pageerror: '+e.message));
await p.goto(URL,{waitUntil:'domcontentloaded'}); await p.request.post(URL+'/api/v1/auth/demo');

// 1. Did the earlier keyboard stage move persist?
const r=await p.request.get(URL+'/api/v1/records/deal?q=Aldergate%20Semiconductor%20%E2%80%94%20enterprise&limit=3');
const j=await r.json();
console.log('PERSISTED STAGE:',j.data.map(d=>d.display_name+' => '+d.properties.deal_stage+' @'+d.properties.probability+'%').join(' | '));

// 2. Copilot keyboard-only: ask a question with no mouse
await p.goto(URL+'/copilot',{waitUntil:'networkidle'}); await p.waitForTimeout(900);
await p.locator('body').click({position:{x:3,y:3}});
const desc=async()=>p.evaluate(()=>{const a=document.activeElement;return a?a.tagName+' '+(a.getAttribute('aria-label')||a.getAttribute('placeholder')||a.className||''):'none'});
let hit=null;
for(let i=0;i<45;i++){await p.keyboard.press('Tab');const d=await desc();if(/TEXTAREA|Ask anything/i.test(d)){hit=i;break;}}
console.log('tabs to reach composer:',hit,'focused:',await desc());
await p.keyboard.type('What is our open pipeline by stage?');
await p.keyboard.press('Enter'); await p.waitForTimeout(4500);
await p.screenshot({path:'/tmp/crit-drive/34-kbd-copilot.png',fullPage:true});
const t=await p.locator('main').innerText();
const i=t.indexOf('What is our open pipeline by stage?');
console.log('\n=== KEYBOARD-ONLY COPILOT ANSWER ===\n'+t.slice(i).slice(0,1800));
console.log('ERRS',errs);
await b.close();
