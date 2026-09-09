import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8821';
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1440,height:900}});
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
await p.goto(URL+'/design',{waitUntil:'networkidle'});
const btn = p.locator('button[aria-label="Row actions"]').last();
await btn.scrollIntoViewIfNeeded(); await p.waitForTimeout(200);
await btn.focus(); await p.waitForTimeout(100);
console.log('ACTIVE AFTER FOCUS:', await p.evaluate(()=>document.activeElement?.outerHTML.slice(0,90)));
await p.keyboard.press('Enter'); await p.waitForTimeout(300);

const snap = async (tag) => {
  const s = await p.evaluate(() => {
    const menu=document.querySelector('.ain-menu'); if(!menu) return {open:false};
    const items=[...menu.querySelectorAll('[role^="menuitem"]')].map(el=>({id:el.id,t:el.textContent.trim().slice(0,24),act:el.classList.contains('is-active'),ti:el.getAttribute('tabindex')}));
    const ae=document.activeElement;
    return {open:true, ad:menu.getAttribute('aria-activedescendant'), activeIdx:items.findIndex(i=>i.act),
      items:items.map(i=>(i.act?'>':' ')+i.t),
      aeId:ae?.id, aeCls:ae?.className?.slice?.(0,40), aeText:ae?.textContent?.trim().slice(0,24),
      focusEqHighlight: !!ae?.id && ae.id===menu.getAttribute('aria-activedescendant')};
  });
  console.log(tag, JSON.stringify(s)); return s;
};
await snap('OPENED');
for (const k of ['ArrowDown','ArrowDown','ArrowUp','End','Home']) { await p.keyboard.press(k); await p.waitForTimeout(120); await snap(k); }
await p.screenshot({path:'/tmp/crit/menu_open_kbd.png'});
// typeahead
const labels = await p.evaluate(()=>[...document.querySelectorAll('.ain-menu [role^="menuitem"]')].map(e=>e.textContent.trim()));
console.log('LABELS:', JSON.stringify(labels));
await b.close(); console.log('ERRS',errs);
