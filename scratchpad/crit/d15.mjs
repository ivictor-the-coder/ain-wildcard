import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8854';
const b=await chromium.launch();
for (const [w,h] of [[1100,800],[1280,460]]) {
  const c=await b.newContext({viewport:{width:w,height:h},deviceScaleFactor:2});
  const p=await c.newPage();
  await p.goto(URL,{waitUntil:'domcontentloaded'});
  await p.request.post(URL+'/api/v1/auth/demo');
  for (const route of ['/deals','/copilot']){
    await p.goto(URL+route,{waitUntil:'networkidle'}); await p.waitForTimeout(900);
    const name=`/tmp/crit-drive/r-${w}x${h}${route.replace(/\//g,'_')}.png`;
    await p.screenshot({path:name});
    const ov=await p.evaluate(()=>({bodyScrollW:document.body.scrollWidth,clientW:document.documentElement.clientWidth,docScrollW:document.documentElement.scrollWidth}));
    console.log(w+'x'+h,route,JSON.stringify(ov),'HORIZ-OVERFLOW:',ov.docScrollW>ov.clientW+1);
  }
  await c.close();
}
await b.close();
