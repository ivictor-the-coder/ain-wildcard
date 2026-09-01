import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}});
const p=await c.newPage();
const errs=[]; const posts=[];
p.on('pageerror',e=>errs.push('pageerror: '+e.message));
p.on('response',r=>{if(r.url().includes('/api/')){if(r.status()>=400&&!r.url().includes('/v1/me'))errs.push(r.status()+' '+r.request().method()+' '+r.url().replace(URL,'')); if(r.request().method()!=='GET')posts.push(r.request().method()+' '+r.url().replace(URL,'')+' -> '+r.status());}});
await p.goto(URL,{waitUntil:'domcontentloaded'});
await p.request.post(URL+'/api/v1/auth/demo');
await p.goto(URL+'/copilot',{waitUntil:'networkidle'}); await p.waitForTimeout(800);
await p.getByRole('button',{name:'New conversation'}).click(); await p.waitForTimeout(700);

// turn on writes
const sw=p.getByText('Let it prepare writes');
await sw.click(); await p.waitForTimeout(400);
await p.screenshot({path:'/tmp/crit-drive/21-writeson.png'});
console.log('after toggle, footer:',(await p.locator('main').innerText()).slice(-400));

const ta=p.getByPlaceholder(/Ask/);
await ta.fill('Add a note to Rheinwerk Antriebstechnik saying we agreed pricing on the OEE programme.');
await p.keyboard.press('Enter');
await p.waitForTimeout(4000);
await p.screenshot({path:'/tmp/crit-drive/22-writeproposal.png',fullPage:true});
const t=await p.locator('main').innerText();
console.log('\n=== THREAD AFTER ASK ===\n'+t.slice(t.indexOf('Add a note to Rheinwerk')).slice(0,2500));
console.log('\n--- buttons in thread ---');
for(const el of await p.locator('main button').all()){const x=((await el.innerText()).trim()||await el.getAttribute('aria-label')||'').replace(/\n/g,'/');if(x)console.log('BTN',JSON.stringify(x.slice(0,70)));}
console.log('\nNON-GET CALLS:',posts);
console.log('ERRS',errs);
await b.close();
