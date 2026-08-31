import { chromium } from '@playwright/test';
const b=await chromium.launch();
const run = async (w,h) => {
  const p=await b.newPage({viewport:{width:w,height:h}});
  await p.goto('http://127.0.0.1:8821/design',{waitUntil:'networkidle'});
  const add = p.locator('button', { hasText: /Add filter|Filter/ }).first();
  if (!await add.count()) { console.log('no filter button'); await p.close(); return; }
  await add.scrollIntoViewIfNeeded(); await p.waitForTimeout(200);
  const bb0 = await add.boundingBox();
  await p.mouse.wheel(0, bb0.y - (h-60)); await p.waitForTimeout(300);
  const a0 = await add.boundingBox();
  await add.click(); await p.waitForTimeout(350);
  const dump = async (tag)=> { const d = await p.evaluate(()=>[...document.querySelectorAll('.ain-popover')].map(el=>{const r=el.getBoundingClientRect();return {cls:el.className.slice(0,40),y:Math.round(r.y),h:Math.round(r.height),bottom:Math.round(r.bottom),maxH:el.style.maxHeight,scroll:el.scrollHeight>el.clientHeight+1};})); console.log(tag,`vp=${w}x${h}`,'anchor.y=',Math.round(a0.y),JSON.stringify(d)); return d; };
  await dump('menu');
  // choose a date column to grow the editor
  const dateOpt = p.locator('.ain-menu [role^="menuitem"]', { hasText: /Issued|Date|Due/ }).first();
  if (await dateOpt.count()) { await dateOpt.click(); await p.waitForTimeout(450); await dump('date-editor'); }
  const pops = await p.evaluate(()=>[...document.querySelectorAll('.ain-popover')].map(el=>{const r=el.getBoundingClientRect();return {y:r.y,bottom:r.bottom};}));
  const a = await add.boundingBox();
  for (const q of pops){ const ov = !(q.bottom<=a.y+1 || q.y>=a.y+a.height-1); if(ov) console.log('  !! OVERLAPS ANCHOR', JSON.stringify(q), 'anchor', JSON.stringify(a)); }
  await p.screenshot({path:`/tmp/crit/filter_${w}x${h}.png`});
  await p.close();
};
for (const [w,h] of [[1100,800],[1280,560],[1280,380],[1280,260]]) await run(w,h);
await b.close();
