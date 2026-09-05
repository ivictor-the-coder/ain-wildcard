import { chromium } from '@playwright/test';
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1440,height:900}});
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
await p.goto('http://127.0.0.1:8821/design',{waitUntil:'networkidle'});
// the FIRST row-actions button lives in the data table demo
const btn = p.locator('button.ain-table__rowmenu').first();
await btn.scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
console.log('rowmenu buttons:', await p.locator('button.ain-table__rowmenu').count());
await btn.focus(); await p.waitForTimeout(200);
console.log('AE after focus():', await p.evaluate(()=>({tag:document.activeElement?.tagName, cls:document.activeElement?.className, label:document.activeElement?.getAttribute('aria-label')})));
await p.keyboard.press('Enter'); await p.waitForTimeout(300);
console.log('menu open?', await p.evaluate(()=>document.querySelectorAll('.ain-menu').length));

// Now: reach it purely by Tab from the table row, like a keyboard user would
console.log('--- TAB PATH');
await p.keyboard.press('Escape'); await p.waitForTimeout(200);
const firstRow = p.locator('tr[data-index="0"]').first();
await firstRow.scrollIntoViewIfNeeded();
await p.evaluate(()=>{const r=document.querySelector('tr[data-index="0"]'); r?.focus();});
await p.waitForTimeout(150);
console.log('AE=row:', await p.evaluate(()=>({tag:document.activeElement?.tagName, cls:document.activeElement?.className?.slice(0,40)})));
for (let i=0;i<8;i++){
  await p.keyboard.press('Tab'); await p.waitForTimeout(80);
  const ae = await p.evaluate(()=>({tag:document.activeElement?.tagName, cls:(document.activeElement?.className||'').slice(0,46), label:document.activeElement?.getAttribute('aria-label'), txt:document.activeElement?.textContent?.trim().slice(0,20)}));
  console.log('tab',i+1, JSON.stringify(ae));
  if (ae.label==='Row actions'){
    await p.keyboard.press('Enter'); await p.waitForTimeout(300);
    console.log('  -> menus open:', await p.evaluate(()=>document.querySelectorAll('.ain-menu').length));
    console.log('  -> AE:', await p.evaluate(()=>({id:document.activeElement?.id, cls:document.activeElement?.className, t:document.activeElement?.textContent?.trim().slice(0,20)})));
    await p.keyboard.press('ArrowDown'); await p.waitForTimeout(150);
    console.log('  -> after ArrowDown:', await p.evaluate(()=>{const m=document.querySelector('.ain-menu'); if(!m)return null; const it=[...m.querySelectorAll('[role^=menuitem]')]; return {idx:it.findIndex(e=>e.classList.contains('is-active')), lbl:it.find(e=>e.classList.contains('is-active'))?.textContent.trim().slice(0,24)};}));
    await p.screenshot({path:'/tmp/crit/rowmenu_kbd.png'});
    break;
  }
}
await b.close(); console.log('ERRS',errs);
