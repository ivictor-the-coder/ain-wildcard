import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}});
const p=await c.newPage();
const errs=[];
p.on('pageerror',e=>errs.push('pageerror: '+e.message));
p.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=400&&!r.url().includes('/v1/me'))errs.push(r.status()+' '+r.request().method()+' '+r.url().replace(URL,''))});
await p.goto(URL,{waitUntil:'domcontentloaded'});
await p.request.post(URL+'/api/v1/auth/demo');
const ID='deal_bCBbAn9Cdg2y5A';
await p.goto(URL+'/deals/'+ID,{waitUntil:'networkidle'}); await p.waitForTimeout(700);
const dlg=p.locator('[role=dialog]');

// TASK: edit deal information
await p.getByRole('button',{name:'Edit deal information'}).click(); await p.waitForTimeout(500);
await p.screenshot({path:'/tmp/crit-drive/08-edit.png'});
console.log('EDIT DIALOG:\n'+(await dlg.innerText()).slice(0,900));
const amt=dlg.getByLabel('Amount');
await amt.click(); await amt.fill(''); await amt.pressSequentially('99000',{delay:30}); await amt.press('Tab');
await p.waitForTimeout(300);
const save=dlg.getByRole('button',{name:/Save/i});
console.log('save label:',await save.innerText().catch(()=>'none'));
await save.click(); await p.waitForTimeout(1500);
await p.screenshot({path:'/tmp/crit-drive/09-after-edit.png'});
const main=await p.locator('main').innerText();
console.log('shows 99,000?',main.includes('$99,000.00'),'| weighted 9,900?',main.includes('$9,900.00'));
// reload
await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(800);
const main2=await p.locator('main').innerText();
console.log('AFTER RELOAD shows 99,000?',main2.includes('$99,000.00'));

// TASK: move to Closed won via stage rail
await p.getByRole('button',{name:/Closed won/}).first().click(); await p.waitForTimeout(700);
await p.screenshot({path:'/tmp/crit-drive/10-closedwon.png'});
console.log('\nSTAGE MOVE DIALOG:\n'+(await dlg.innerText()).slice(0,1400));
console.log('ERRS',errs);
await b.close();
