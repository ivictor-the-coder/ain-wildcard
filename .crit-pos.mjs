import { chromium } from '@playwright/test';
const b=await chromium.launch();
const report = async (w,h) => {
  const p=await b.newPage({viewport:{width:w,height:h}});
  await p.goto('http://127.0.0.1:8821/design',{waitUntil:'networkidle'});
  // scroll so a rowmenu trigger sits near the very bottom edge
  const btns = p.locator('button.ain-table__rowmenu');
  const n = await btns.count();
  let worst=null;
  for (let i=0;i<Math.min(n,6);i++){
    const btn = btns.nth(i);
    await btn.scrollIntoViewIfNeeded();
    // nudge page so trigger is near bottom
    await p.evaluate(()=>window.scrollBy(0,0));
    const box = await btn.boundingBox(); if(!box) continue;
    await p.mouse.wheel(0, box.y - (h - 60)); await p.waitForTimeout(250);
    const bb = await btn.boundingBox(); if(!bb) continue;
    if (bb.y < h-140 || bb.y > h-10) continue;
    await btn.click(); await p.waitForTimeout(350);
    const m = await p.evaluate(()=>{const el=document.querySelector('.ain-menu-pop'); if(!el)return null; const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom,maxH:el.style.maxHeight, scrollable: el.scrollHeight>el.clientHeight+1};});
    const a = await btn.boundingBox();
    const overlaps = m && !(m.bottom <= a.y+1 || m.y >= a.y+a.height-1);
    worst = {viewport:`${w}x${h}`, anchor:{y:Math.round(a.y),h:Math.round(a.height)}, pop:m && {y:Math.round(m.y),h:Math.round(m.h),bottom:Math.round(m.bottom),maxH:m.maxH,scrollable:m.scrollable}, overlapsAnchor:overlaps, offBottom: m? Math.round(m.bottom - h):null};
    await p.screenshot({path:`/tmp/crit/bottomedge_${w}x${h}.png`});
    break;
  }
  console.log(JSON.stringify(worst));
  await p.close();
};
for (const [w,h] of [[1100,800],[1280,700],[1280,520],[1280,400],[1280,320]]) await report(w,h);
await b.close();
