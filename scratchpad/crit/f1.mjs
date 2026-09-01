import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();

// A) hard failure on the deals list
{
  const c=await b.newContext({viewport:{width:1512,height:950}}); const p=await c.newPage();
  await p.goto(URL,{waitUntil:'domcontentloaded'}); await p.request.post(URL+'/api/v1/auth/demo');
  await p.route('**/api/v1/records/deal*',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{type:'api_error',code:'service_unavailable',message:'The deal store is unavailable.',request_id:'req_TEST123'}})}));
  await p.goto(URL+'/deals',{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
  await p.screenshot({path:'/tmp/crit-drive/31-deals-503.png'});
  const t=await p.locator('main').innerText();
  console.log('=== /deals with 503 on records ===\n'+t.slice(0,1200));
  await c.close();
}
// B) slow deals list (5s)
{
  const c=await b.newContext({viewport:{width:1512,height:950}}); const p=await c.newPage();
  await p.goto(URL,{waitUntil:'domcontentloaded'}); await p.request.post(URL+'/api/v1/auth/demo');
  await p.route('**/api/v1/records/deal*',async r=>{await new Promise(s=>setTimeout(s,5000)); r.continue();});
  p.goto(URL+'/deals').catch(()=>{});
  await p.waitForTimeout(1500);
  await p.screenshot({path:'/tmp/crit-drive/32-deals-slow.png'});
  const t=await p.locator('main').innerText();
  console.log('\n=== /deals at 1.5s of a 5s load ===\n'+t.slice(0,700));
  await c.close();
}
// C) copilot ask fails
{
  const c=await b.newContext({viewport:{width:1512,height:950}}); const p=await c.newPage();
  await p.goto(URL,{waitUntil:'domcontentloaded'}); await p.request.post(URL+'/api/v1/auth/demo');
  await p.goto(URL+'/copilot',{waitUntil:'networkidle'}); await p.waitForTimeout(700);
  await p.getByRole('button',{name:'New conversation'}).click(); await p.waitForTimeout(500);
  await p.route('**/api/v1/ai/threads**',r=>{ if(r.request().method()==='POST') return r.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{type:'api_error',code:'engine_error',message:'The reasoning engine did not answer.',request_id:'req_ENGINE9'}})}); r.continue();});
  await p.getByPlaceholder(/Ask/).fill('What is our open pipeline by stage?');
  await p.keyboard.press('Enter'); await p.waitForTimeout(2500);
  await p.screenshot({path:'/tmp/crit-drive/33-copilot-500.png',fullPage:true});
  const t=await p.locator('body').innerText();
  console.log('\n=== copilot ask -> 500 ===\n'+t.slice(t.indexOf('Ask about this workspace')>=0?t.indexOf('Ask about this workspace'):0).slice(0,1200));
  console.log('question text still in composer?',await p.getByPlaceholder(/Ask/).inputValue());
  await c.close();
}
await b.close();
