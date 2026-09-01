import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}});
const p=await c.newPage();
const errs=[]; p.on('pageerror',e=>errs.push('pageerror: '+e.message));
await p.goto(URL,{waitUntil:'domcontentloaded'}); await p.request.post(URL+'/api/v1/auth/demo');

// 1) bad deal id
await p.goto(URL+'/deals/deal_DOESNOTEXIST',{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
await p.screenshot({path:'/tmp/crit-drive/35-404.png'});
console.log('=== BAD DEAL ID ===\n'+(await p.locator('main').innerText()).slice(0,600));

// 2) drag and drop on the board (HTML5 DnD)
await p.goto(URL+'/deals',{waitUntil:'networkidle'}); await p.waitForTimeout(1000);
const src=p.locator('.pl-card').first();
const name=await src.locator('.pl-card__name').innerText();
const target=p.locator('.pl-col').nth(1);
const sb=await src.boundingBox(), tb=await target.boundingBox();
await p.mouse.move(sb.x+sb.width/2, sb.y+20);
await p.mouse.down();
await p.mouse.move(tb.x+tb.width/2, tb.y+200,{steps:20});
await p.mouse.move(tb.x+tb.width/2, tb.y+220,{steps:5});
await p.mouse.up();
await p.waitForTimeout(2000);
const t=await p.locator('body').innerText();
console.log('\n=== DRAG (native mouse) of',JSON.stringify(name),'===');
console.log('toast?',(t.match(/Moved to[\s\S]{0,120}/)||['NONE'])[0].replace(/\n/g,' | '));
await p.screenshot({path:'/tmp/crit-drive/36-drag.png'});

// 3) Log activity on a record
await p.goto(URL+'/deals/deal_bCBbAn9Cdg2y5A',{waitUntil:'networkidle'}); await p.waitForTimeout(900);
await p.getByRole('button',{name:'Log activity'}).first().click(); await p.waitForTimeout(700);
await p.screenshot({path:'/tmp/crit-drive/37-logactivity.png'});
const dlg=p.locator('[role=dialog]');
console.log('\n=== LOG ACTIVITY DIALOG ===\n'+(await dlg.innerText()).slice(0,900));
console.log('ERRS',errs);
await b.close();
