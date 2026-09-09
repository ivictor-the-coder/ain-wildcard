import { chromium } from '@playwright/test';
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1440,height:900}});
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
await p.goto('http://127.0.0.1:8821/design',{waitUntil:'networkidle'});
const btn = p.locator('button[aria-label="Row actions"]').last();
const open = async () => { await btn.scrollIntoViewIfNeeded(); await btn.focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(250); };
const st = async () => p.evaluate(()=>{const m=document.querySelector('.ain-menu'); if(!m) return {open:false, ae:document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName};
  const items=[...m.querySelectorAll('[role^="menuitem"]')]; const i=items.findIndex(e=>e.classList.contains('is-active'));
  return {open:true, idx:i, label:items[i]?.textContent.trim().slice(0,24), ad:m.getAttribute('aria-activedescendant'), n:items.length,
    subOpen: document.querySelectorAll('.ain-menu').length>1, toasts:[...document.querySelectorAll('.ain-toast, [class*=toast]')].map(t=>t.textContent.trim().slice(0,60))};});

console.log('--- TYPEAHEAD "de" (Delete account)');
await open(); console.log('start', JSON.stringify(await st()));
await p.keyboard.type('de',{delay:60}); await p.waitForTimeout(150);
console.log('after "de"', JSON.stringify(await st()));

console.log('--- TYPEAHEAD "ex" (Export statement)');
await p.keyboard.press('Escape'); await p.waitForTimeout(200); await open();
await p.keyboard.type('ex',{delay:60}); await p.waitForTimeout(150);
console.log('after "ex"', JSON.stringify(await st()));

console.log('--- ENTER selects + closes');
await p.keyboard.press('Enter'); await p.waitForTimeout(500);
console.log('after Enter', JSON.stringify(await st()));
console.log('focus restored to trigger?', await p.evaluate(()=>document.activeElement?.getAttribute('aria-label')));
await p.screenshot({path:'/tmp/crit/after_enter.png'});

console.log('--- SUBMENU: typeahead "me" then ArrowRight');
await open(); await p.keyboard.type('me',{delay:60}); await p.waitForTimeout(150);
console.log('on merge?', JSON.stringify(await st()));
await p.keyboard.press('ArrowRight'); await p.waitForTimeout(300);
const sub = await p.evaluate(()=>{const ms=[...document.querySelectorAll('.ain-menu')]; return {count:ms.length,
  sub: ms[1]? [...ms[1].querySelectorAll('[role^=menuitem]')].map(e=>(e.classList.contains('is-active')?'>':' ')+e.textContent.trim().slice(0,20)):null,
  ae: document.activeElement?.textContent?.trim().slice(0,20), aeId: document.activeElement?.id, subAd: ms[1]?.getAttribute('aria-activedescendant')};});
console.log('SUBMENU', JSON.stringify(sub));
await p.keyboard.press('ArrowDown'); await p.waitForTimeout(150);
console.log('sub after ArrowDown', JSON.stringify(await p.evaluate(()=>{const ms=[...document.querySelectorAll('.ain-menu')];return ms[1]?[...ms[1].querySelectorAll('[role^=menuitem]')].map(e=>(e.classList.contains('is-active')?'>':' ')+e.textContent.trim().slice(0,20)):null;})));
await p.screenshot({path:'/tmp/crit/submenu.png'});
await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(250);
console.log('after ArrowLeft (fold back)', JSON.stringify(await st()), 'ae=', await p.evaluate(()=>document.activeElement?.textContent?.trim().slice(0,24)));
await p.keyboard.press('Escape'); await p.waitForTimeout(250);
console.log('after Escape', JSON.stringify(await st()), 'ae=', await p.evaluate(()=>document.activeElement?.getAttribute('aria-label')));
await b.close(); console.log('ERRS',errs);
