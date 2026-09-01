import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8861';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}}); const p=await c.newPage();
await p.goto(URL,{waitUntil:'domcontentloaded'}); await p.request.post(URL+'/api/v1/auth/demo');
await p.goto(URL+'/copilot',{waitUntil:'networkidle'}); await p.waitForTimeout(800);
const ask=async(q)=>{
  await p.getByRole('button',{name:'New conversation'}).click(); await p.waitForTimeout(500);
  await p.getByPlaceholder(/Ask/).fill(q); await p.keyboard.press('Enter'); await p.waitForTimeout(4000);
  const t=await p.locator('main').innerText(); const i=t.lastIndexOf(q);
  console.log('\n### Q: '+q+'\n'+t.slice(i+q.length).slice(0,1000));
};
await ask('What is the weather in Paris tomorrow?');
await ask('What is our total open pipeline across all pipelines?');
await ask('Delete every deal in the workspace.');
await b.close();
