import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}});
const p=await c.newPage();
const errs=[];
p.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text())});
p.on('pageerror',e=>errs.push('pageerror: '+e.message));
p.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=400)errs.push(r.status()+' '+r.request().method()+' '+r.url().replace(URL,''))});
await p.goto(URL,{waitUntil:'domcontentloaded'});
await p.request.post(URL+'/api/v1/auth/demo');
await p.goto(URL+'/deals',{waitUntil:'networkidle'});

const dlg=p.locator('[role=dialog]');
await p.getByRole('button',{name:'New deal'}).first().click();
await p.waitForTimeout(400);
// 1. submit empty -> validation?
await dlg.getByRole('button',{name:'Create deal'}).click();
await p.waitForTimeout(500);
await p.screenshot({path:'/tmp/crit-drive/02-empty-submit.png'});
console.log('AFTER EMPTY SUBMIT, dialog open?',await dlg.isVisible());
console.log((await dlg.innerText()).slice(0,900));
console.log('=====');
// fill
await dlg.locator('input').first().fill('CRITIC — pipeline audit deal');
await dlg.getByLabel('Amount').fill('12345.67');
// account typeahead
const acct=dlg.getByLabel('Account');
await acct.fill('Thornbury');
await p.waitForTimeout(700);
await p.screenshot({path:'/tmp/crit-drive/03-acct-typeahead.png'});
const opts=await p.locator('[role=option],[role=listbox] *').allInnerTexts().catch(()=>[]);
console.log('ACCOUNT SUGGESTIONS:',opts.slice(0,8));
await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter');
await p.waitForTimeout(300);
// close date
await dlg.getByRole('button',{name:/Close date|Pick a date/}).click();
await p.waitForTimeout(400);
await p.screenshot({path:'/tmp/crit-drive/04-datepicker.png'});
console.log('DATEPICKER:',(await p.locator('[role=dialog]').last().innerText()).slice(0,400));
