import { chromium } from '@playwright/test';
const b=await chromium.launch();
const run = async (w,h) => {
  const p=await b.newPage({viewport:{width:w,height:h}});
  await p.goto('http://127.0.0.1:8821/design',{waitUntil:'networkidle'});
  const add = p.locator('button[aria-label="Filters"]').first();
  await add.scrollIntoViewIfNeeded(); await p.waitForTimeout(200);
  let bb = await add.boundingBox();
  await p.mouse.wheel(0, bb.y - (h-56)); await p.waitForTimeout(350);
  const a = await add.boundingBox();
  await add.click(); await p.waitForTimeout(400);
  const dump = async (tag)=>{const d=await p.evaluate(()=>[...document.querySelectorAll('.ain-popover')].map(el=>{const r=el.getBoundingClientRect();return {y:Math.round(r.y),h:Math.round(r.height),bottom:Math.round(r.bottom),maxH:el.style.maxHeight,scroll:el.scrollHeight>el.clientHeight+1};}));
    const bad=d.filter(q=>!(q.bottom<=a.y+1||q.y>=a.y+a.height-1)); const off=d.filter(q=>q.bottom>h+1||q.y<0);
    console.log(`vp=${w}x${h} ${tag} anchor.y=${Math.round(a.y)}`,JSON.stringify(d), bad.length?'OVERLAPS_ANCHOR':'', off.length?'OFFSCREEN':''); return d;};
  await dump('filters-menu');
  const opt = p.locator('.ain-menu [role^="menuitem"]').filter({hasText:/Issued/}).first();
  if (await opt.count()) { await opt.click(); await p.waitForTimeout(500); await dump('date-editor'); 
    const bt = p.locator('.ain-popover button, .ain-popover [role=option]').filter({hasText:/between/i}).first();
    if (await bt.count()){ await bt.click(); await p.waitForTimeout(600); await dump('between-grown'); }
  }
  await p.screenshot({path:`/tmp/crit/filter_${w}x${h}.png`});
  await p.close();
};
for (const [w,h] of [[1100,800],[1280,560],[1280,400],[1280,300]]) await run(w,h);
await b.close();
