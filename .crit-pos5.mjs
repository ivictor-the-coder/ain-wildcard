import { chromium } from '@playwright/test';
const b=await chromium.launch();
const run = async (w,h)=>{
  const p=await b.newPage({viewport:{width:w,height:h}});
  await p.goto('http://127.0.0.1:8821/design',{waitUntil:'networkidle'});
  const toggle = p.locator('button[aria-label="Filters"]').first();
  await toggle.scrollIntoViewIfNeeded(); await p.waitForTimeout(250); await toggle.click(); await p.waitForTimeout(300);
  const addf = p.locator('button.ain-btn--ghost').filter({hasText:/^Filter$/}).first();
  await addf.scrollIntoViewIfNeeded(); await p.waitForTimeout(200);
  let bb=await addf.boundingBox(); await p.mouse.wheel(0, bb.y-(h-50)); await p.waitForTimeout(350);
  const a=await addf.boundingBox();
  await addf.click(); await p.waitForTimeout(400);
  const dump=async(tag)=>{const d=await p.evaluate(()=>[...document.querySelectorAll('.ain-popover')].map(el=>{const r=el.getBoundingClientRect();return{y:Math.round(r.y),h:Math.round(r.height),bottom:Math.round(r.bottom),maxH:el.style.maxHeight,scroll:el.scrollHeight>el.clientHeight+1};}));
  const bad=d.filter(q=>!(q.bottom<=a.y+1||q.y>=a.y+a.height-1)); const off=d.filter(q=>q.bottom>h+1||q.y<-1);
  console.log(`vp=${w}x${h} ${tag} anchorY=${Math.round(a.y)} ${JSON.stringify(d)} ${bad.length?'*** OVERLAPS ANCHOR ***':''} ${off.length?'*** OFFSCREEN ***':''}`);};
  await dump('column-menu');
  const opt=p.locator('.ain-menu [role^="menuitem"]').filter({hasText:/Issued/}).first();
  if(await opt.count()){ await opt.click(); await p.waitForTimeout(600); await dump('date-editor');
    const between=p.locator("XX-none").first();
    if(await between.count()){await between.click();await p.waitForTimeout(700);await dump('between-grown');}
    else { const sel=p.locator('.ain-popover select').first(); if(await sel.count()){ await sel.selectOption({label:'is between'}).catch(()=>{}); await p.waitForTimeout(700); await dump('between-grown'); } }
  }
  await p.screenshot({path:`/tmp/crit/dateedit_${w}x${h}.png`});
  await p.close();
};
for(const [w,h] of [[1100,800],[1280,620],[1280,460],[1280,340]]) await run(w,h);
await b.close();
