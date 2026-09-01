import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}});
const p=await c.newPage();
const errs=[];
p.on('pageerror',e=>errs.push('pageerror: '+e.message));
await p.goto(URL,{waitUntil:'domcontentloaded'});
await p.request.post(URL+'/api/v1/auth/demo');
await p.goto(URL+'/copilot',{waitUntil:'networkidle'}); await p.waitForTimeout(800);
// DECLINE path
await p.getByRole('button',{name:'New conversation'}).click(); await p.waitForTimeout(600);
await p.getByText('Let it prepare writes').click(); await p.waitForTimeout(300);
await p.getByPlaceholder(/Ask/).fill('Add a note to Ferro Norte Siderurgia saying CRITIC DECLINE PROBE.');
await p.keyboard.press('Enter'); await p.waitForTimeout(4000);
await p.getByRole('button',{name:'Decline',exact:true}).click(); await p.waitForTimeout(2500);
await p.screenshot({path:'/tmp/crit-drive/29-declined.png',fullPage:true});
const t=await p.locator('main').innerText();
console.log('AFTER DECLINE — card gone?',!t.includes('Approve and run'));
console.log('any "declined" marker in thread?',/declin/i.test(t.slice(t.indexOf('CRITIC DECLINE PROBE'))));
console.log('thread tail:\n'+t.slice(t.indexOf('CRITIC DECLINE PROBE')).slice(0,700));
// archived filter
await p.locator('select').first().selectOption({label:'Archived'}).catch(e=>console.log('no archived select'));
await p.waitForTimeout(1200);
await p.screenshot({path:'/tmp/crit-drive/30-archived.png'});
const t2=await p.locator('main').innerText();
console.log('\nARCHIVED VIEW list area:',t2.slice(t2.indexOf('Conversations')).slice(0,400));
console.log('ERRS',errs);
await b.close();
