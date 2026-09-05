import { chromium } from '@playwright/test';
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1440,height:900}});
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
await p.goto('http://127.0.0.1:8821/design',{waitUntil:'networkidle'});
const row = p.locator('tr[data-index="0"]').first();
await row.scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
await p.evaluate(()=>document.querySelector('tr[data-index="0"]')?.focus());
const ae=()=>p.evaluate(()=>({tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label'),cls:(document.activeElement?.className||'').slice(0,40)}));
const drawers=()=>p.evaluate(()=>({menus:document.querySelectorAll('.ain-menu').length, drawer:document.querySelectorAll('.ain-drawer,[role=dialog]').length, checked:[...document.querySelectorAll('.ain-check__input')].filter(c=>c.checked).length}));

console.log('start', JSON.stringify(await drawers()));
await p.keyboard.press('Tab'); console.log('tab1', JSON.stringify(await ae()));
console.log('  before Space:', JSON.stringify(await drawers()));
await p.keyboard.press(' '); await p.waitForTimeout(250);
console.log('  after Space on row checkbox:', JSON.stringify(await drawers()), 'checkbox checked?', await p.evaluate(()=>document.activeElement?.checked));
await p.keyboard.press('Tab'); console.log('tab2', JSON.stringify(await ae()));
console.log('  before Enter:', JSON.stringify(await drawers()));
await p.keyboard.press('Enter'); await p.waitForTimeout(400);
console.log('  after Enter on Row actions:', JSON.stringify(await drawers()));
await p.screenshot({path:'/tmp/crit/rowmenu_enter.png'});
// does a MOUSE click work?
await p.keyboard.press('Escape'); await p.waitForTimeout(200);
await p.locator('button.ain-table__rowmenu').first().click(); await p.waitForTimeout(300);
console.log('  after MOUSE click on Row actions:', JSON.stringify(await drawers()));
await b.close(); console.log('ERRS',errs);
