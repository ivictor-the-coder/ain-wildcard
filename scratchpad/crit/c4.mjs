import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}});
const p=await c.newPage();
await p.goto(URL,{waitUntil:'domcontentloaded'});
await p.request.post(URL+'/api/v1/auth/demo');
await p.goto(URL+'/copilot',{waitUntil:'networkidle'}); await p.waitForTimeout(800);
await p.getByRole('button',{name:'New conversation'}).click(); await p.waitForTimeout(600);
await p.getByText('Let it prepare writes').click(); await p.waitForTimeout(300);
await p.getByPlaceholder(/Ask/).fill('Add a note to Pemberton Auto Systems saying CRITIC TOAST PROBE 77.');
await p.keyboard.press('Enter'); await p.waitForTimeout(4000);
await p.getByRole('button',{name:'Approve and run'}).click();
for (const ms of [200,600,1200,2500]) {
  await p.waitForTimeout(ms);
  const toasts=await p.locator('[role=status],[role=alert],.ain-toast,[class*=toast]').allInnerTexts().catch(()=>[]);
  console.log('t+'+ms,'toasts:',JSON.stringify(toasts));
}
await p.screenshot({path:'/tmp/crit-drive/25-after-approve.png',fullPage:true});
const t=await p.locator('main').innerText();
console.log('\nMESSAGE STILL SAYS "Nothing has been written"?', t.includes('Nothing has been written'));
console.log('MESSAGE mentions approvals queue?', t.includes('approvals queue'));
console.log('Any word like written/done/created/applied?', /\b(has been written|was written|Written|Done|Created the note|applied)\b/.test(t));
// reload — does the server-side message correct itself?
await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(1500);
const t2=await p.locator('main').innerText();
console.log('\nAFTER RELOAD still says "Nothing has been written"?', t2.includes('Nothing has been written'));
console.log('AFTER RELOAD approval card present?', t2.includes('Approve and run'));
console.log('\n--- reloaded thread tail ---\n'+t2.slice(t2.indexOf('CRITIC TOAST PROBE')).slice(0,900));
await b.close();
