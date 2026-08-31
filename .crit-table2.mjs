import { chromium } from '@playwright/test';
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1440,height:900}});
await p.goto('http://127.0.0.1:8821/design',{waitUntil:'networkidle'});
const row=p.locator('tr[data-index="0"]').first();
await row.scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
const state=()=>p.evaluate(()=>({menus:document.querySelectorAll('.ain-menu').length, checked:[...document.querySelectorAll('.ain-check__input')].filter(c=>c.checked).length, focusedRow:document.querySelector('tr.is-focused')?.getAttribute('data-index'), ae:document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName}));
const goToRowMenu=async()=>{ await p.evaluate(()=>document.querySelector('tr[data-index="0"]')?.focus()); await p.keyboard.press('Tab'); await p.keyboard.press('Tab'); await p.waitForTimeout(120); };
for (const key of ['Enter',' ','ArrowDown']) {
  await goToRowMenu();
  const before=await state();
  await p.keyboard.press(key); await p.waitForTimeout(350);
  const after=await state();
  console.log(`key=${JSON.stringify(key)} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);
}
await b.close();
