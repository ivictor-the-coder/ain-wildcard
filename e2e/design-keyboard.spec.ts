/**
 * The design system, driven by the keyboard alone.
 *
 * Everything here was a live defect. The unit suite in `tests/design.test.ts`
 * pins the pure models — `menuKeyAction`, `computePosition` — but every bug in
 * this file was a *wiring* bug: a handler on an element the event never reached,
 * a highlight the scroller never followed, a roving tabindex with no entry
 * point, an offset measured against the wrong box. None of that is visible from
 * a pure function, so it is checked in a real browser.
 *
 *   node scripts/preview.mjs --port 8831 --name designkit
 *   AIN_BASE_URL=http://127.0.0.1:8831 npx playwright test e2e/design-keyboard.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';

const DESIGN = '/design';

const openSection = async (page: Page, id: string) => {
  await page.waitForSelector(`#${id}`);
  await page.locator(`#${id}`).scrollIntoViewIfNeeded();
};

test.beforeEach(async ({ page }) => {
  await page.goto(DESIGN, { waitUntil: 'networkidle' });
  await page.waitForSelector('#overlays');
});

/* ================================== Menu ================================== */

/** What the highlight, the focus and the accessibility tree each believe. */
const menuState = (page: Page) => page.evaluate(() => {
  const pop = document.querySelector('.ain-popover.ain-menu-pop');
  const active = pop?.querySelector('.ain-menu__item.is-active') ?? null;
  return {
    open: !!pop,
    active: active?.textContent?.trim() ?? null,
    // The highlighted row must be the focused row: anything else means the keys
    // are being delivered somewhere that cannot act on them.
    focusIsActiveRow: !!active && document.activeElement === active,
    activeDescendant: pop?.querySelector('[role="menu"]')?.getAttribute('aria-activedescendant') ?? null,
    activeRowId: active?.id ?? null,
  };
});

test('a menu opened from the keyboard moves, filters and fires', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Menu with sections' });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  await page.keyboard.press('Enter');

  // Open: the first row is highlighted *and* focused, and the menu announces it.
  await expect.poll(() => menuState(page)).toMatchObject({ open: true, focusIsActiveRow: true });
  const opened = await menuState(page);
  expect(opened.active).toContain('Rename account');
  expect(opened.activeDescendant).toBe(opened.activeRowId);

  // ArrowDown moves the highlight — the exact sequence that used to do nothing.
  for (const expected of ['Change owner', 'Merge into', 'Auto-charge on renewal']) {
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await menuState(page)).active).toContain(expected);
    expect((await menuState(page)).focusIsActiveRow).toBe(true);
  }

  // A typed prefix jumps to the matching row.
  await page.keyboard.press('e');
  await page.keyboard.press('x');
  await expect.poll(async () => (await menuState(page)).active).toContain('Export statement');

  // Enter fires that row's onSelect — the demo raises a toast naming it — and
  // closes the menu, handing focus back to the trigger.
  await page.keyboard.press('Enter');
  await expect(page.locator('.ain-toast').filter({ hasText: 'Statement queued' }).first()).toBeVisible();
  await expect.poll(async () => (await menuState(page)).open).toBe(false);
  await expect(trigger).toBeFocused();
});

test('a submenu takes the keyboard and hands it back', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Menu with sections' });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  await page.keyboard.press('Enter');
  // The trap hands focus to the menu on the next frame, so arrows fired inside
  // that frame land on the trigger. Wait for the menu to actually hold focus,
  // then step it one row at a time — a burst of arrows proves nothing about the
  // submenu if the highlight was still on the first row when ArrowRight landed.
  await expect.poll(async () => (await menuState(page)).focusIsActiveRow).toBe(true);
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await menuState(page)).active).toContain('Change owner');
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await menuState(page)).active).toContain('Merge into');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.locator('.ain-menu-pop').count()).toBe(2);

  await page.keyboard.press('ArrowDown');
  const inSubmenu = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  expect(inSubmenu.length).toBeGreaterThan(0);

  // Escape peels one layer: the submenu closes, the parent stays open.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.locator('.ain-menu-pop').count()).toBe(1);
  await expect.poll(async () => (await menuState(page)).active).toContain('Merge into');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await menuState(page)).open).toBe(false);
});

/* =========================== Anchored placement =========================== */

test('a popover taller than the viewport never covers the chip that opened it', async ({ page }) => {
  for (const height of [400, 460, 480, 520]) {
    await page.setViewportSize({ width: 1280, height });
    await page.goto(DESIGN, { waitUntil: 'networkidle' });
    await openSection(page, 'table');

    await page.locator('#table button:has-text("Filters")').first().click();
    await page.locator('#table button.ain-table__addfilter').first().click();
    await page.locator('.ain-menu__item', { hasText: 'Issued' }).first().click();
    await expect(page.locator('.ain-table__bar--filters .ain-chip__main')).toBeVisible();

    // Park the chip 90px down and let the popover re-place itself: the pass that
    // used to clamp with the box's natural height and slide it to y=8.
    const chip = await page.locator('.ain-table__bar--filters .ain-chip__main').boundingBox();
    await page.evaluate((dy) => window.scrollBy(0, dy), Math.round((chip?.y ?? 0) - 90));

    const measure = () => page.evaluate(() => {
      const anchor = document.querySelector('.ain-table__bar--filters .ain-chip__main')!.getBoundingClientRect();
      const pop = [...document.querySelectorAll<HTMLElement>('.ain-popover')]
        .find((p) => getComputedStyle(p).visibility !== 'hidden')!.getBoundingClientRect();
      return {
        overlaps: pop.top < anchor.bottom && pop.bottom > anchor.top,
        offBottom: pop.bottom > window.innerHeight - 7,
        offTop: pop.top < 7,
      };
    });
    await expect.poll(measure, { message: `1280x${height}` })
      .toEqual({ overlaps: false, offBottom: false, offTop: false });
  }
});

/* ============================== Command list ============================== */

test('the command palette keeps the highlighted row in view', async ({ page }) => {
  const state = () => page.evaluate(() => {
    const list = document.querySelector('.ain-cmd__list')!;
    const row = list.querySelector('[data-active="true"]');
    if (!row) return { title: null, inView: false };
    const l = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return { title: row.querySelector('.ain-cmd__title')?.textContent?.trim() ?? null, inView: r.top >= l.top - 1 && r.bottom <= l.bottom + 1 };
  });

  await page.locator('.ain-cmd__input').scrollIntoViewIfNeeded();
  // On mount the list used to be pinned to its bottom, because `offsetTop`
  // resolved against the page rather than the list.
  await expect.poll(async () => (await state()).inView).toBe(true);

  await page.locator('.ain-cmd__input').focus();
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await state()).inView).toBe(true);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await state()).inView).toBe(true);
});

/* ================================ Combobox ================================ */

test('a combobox scrolls the highlight into view on a short window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 300 });
  await page.goto(DESIGN, { waitUntil: 'networkidle' });
  await openSection(page, 'fields');

  const input = page.locator('input[role="combobox"].ain-combo__input').first();
  await input.scrollIntoViewIfNeeded();
  await input.focus();

  const state = () => page.evaluate(() => {
    const el = document.querySelector('input[role="combobox"].ain-combo__input')!;
    const list = document.getElementById(el.getAttribute('aria-controls')!);
    const row = list?.querySelector('.ain-combo__option.is-active') ?? null;
    const box = list?.closest('.ain-popover__body') ?? null;
    if (!row || !box) return { label: null, inView: false, announced: null };
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return {
      label: row.querySelector('.u-truncate')?.textContent?.trim() ?? null,
      inView: r.top >= b.top - 1 && r.bottom <= b.bottom + 1,
      announced: el.getAttribute('aria-activedescendant'),
    };
  });

  // Six owners in a list clamped to ~120px: the last four are below the fold.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowDown');
    const now = await state();
    expect(now.inView, `after ArrowDown ${i + 1} the highlight (${now.label}) must be on screen`).toBe(true);
    expect(now.announced).not.toBeNull();
  }
  await page.keyboard.press('Home');
  await expect.poll(async () => (await state()).label).toBe('Dana Whitlock');
  await page.keyboard.press('End');
  await expect.poll(async () => (await state()).label).toBe('Nina Kovač');
  expect((await state()).inView).toBe(true);
});

/* ================================ DataTable =============================== */

test('the data table can be entered with Tab and driven with the arrows', async ({ page }) => {
  await openSection(page, 'table');

  // The invoices demo; the section also holds an empty and an error state.
  const grid = page.locator('#table .ain-table-wrap').first();

  // Exactly one row answers Tab. With none, the grid was unreachable — fatally
  // so on a table with no checkboxes and no row actions.
  const tabbable = () => grid.locator('tbody tr[tabindex="0"]').count();
  expect(await tabbable()).toBe(1);

  await page.evaluate(() => {
    const wrap = document.querySelector('#table .ain-table-wrap')!;
    [...wrap.querySelectorAll<HTMLElement>('.ain-table__sortbtn')].pop()!.focus();
  });
  await page.keyboard.press('Tab');
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TR');

  const at = () => page.evaluate(() => document.activeElement?.getAttribute('data-index'));
  await page.keyboard.press('ArrowDown');
  await expect.poll(at).toBe('1');
  await page.keyboard.press('ArrowDown');
  await expect.poll(at).toBe('2');
  await page.keyboard.press('ArrowUp');
  await expect.poll(at).toBe('1');
  await page.keyboard.press('End');
  await expect.poll(async () => Number(await at())).toBeGreaterThan(20);
  await page.keyboard.press('Home');
  await expect.poll(at).toBe('0');

  // Tabbing on from the row reaches the controls inside it rather than being
  // yanked back onto the row.
  await page.keyboard.press('Tab');
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Select row 1');

  // A search empties the grid's focus, and the entry point has to come back.
  await grid.locator('input[aria-label="Search table rows"]').fill('nordhavn');
  await expect.poll(tabbable).toBe(1);
});

/* ============================ Tabs & segments ============================= */

test('Home and End carry focus with the selection', async ({ page }) => {
  await openSection(page, 'navigation');
  const tabs = page.locator('[role="tablist"]').first();
  await tabs.locator('[role="tab"]').first().focus();

  const state = () => page.evaluate(() => {
    const list = document.querySelector('[role="tablist"]')!;
    const selected = list.querySelector('[aria-selected="true"]');
    return { agree: selected === document.activeElement, selected: selected?.textContent?.trim() ?? null };
  });

  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await state()).agree).toBe(true);
  await page.keyboard.press('End');
  await expect.poll(async () => (await state()).agree).toBe(true);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await state()).agree).toBe(true);

  // The panel's label has to resolve to the tab that owns it.
  expect(await page.evaluate(() => {
    const panel = document.querySelector('[role="tabpanel"]');
    const id = panel?.getAttribute('aria-labelledby');
    return !!(id && document.getElementById(id));
  })).toBe(true);
});

test('a segmented control keeps focus on the checked segment', async ({ page }) => {
  await page.evaluate(() => document.querySelector<HTMLElement>('.ain-segmented [aria-checked="true"]')!.focus());
  const agree = () => page.evaluate(() => {
    const group = document.activeElement?.closest('.ain-segmented');
    return group?.querySelector('[aria-checked="true"]') === document.activeElement;
  });
  for (const key of ['ArrowRight', 'Home', 'End', 'ArrowLeft']) {
    await page.keyboard.press(key);
    await expect.poll(agree, { message: `after ${key}` }).toBe(true);
  }
});

/* =============================== DatePicker =============================== */

test('a date picker opens onto the day the arrows move', async ({ page }) => {
  await openSection(page, 'pickers');
  const trigger = page.locator('#pickers button[aria-haspopup="dialog"]').first();
  await trigger.focus();
  await page.keyboard.press('Enter');

  // Focus lands in the grid, not on "Previous month" two Tabs away from it.
  await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? '')).toContain('ain-cal__day');
  const day = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  const first = await day();
  await page.keyboard.press('ArrowDown');
  await expect.poll(day).not.toBe(first);
  // Compare against the day *this* key started from. Polling against `first`
  // again is already satisfied by the ArrowDown, so the read below could land
  // before ArrowRight had moved — the picker then committed the day after the
  // one the test had recorded, about once in five runs.
  const afterDown = await day();
  await page.keyboard.press('ArrowRight');
  await expect.poll(day).not.toBe(afterDown);

  // Enter picks the focused day and closes the picker.
  const picked = await day();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ain-cal__grid')).toHaveCount(1); // only the inline demo calendar remains
  await expect(trigger).toContainText(String(picked).replace(/,? \d{4}$/, ''));
});

/* ====================== DataTable — the long sweep ======================== */

/**
 * The job this grid exists for: an operator walking 1,240 invoices by keyboard.
 * Everything below was measured broken on the live page — the focused row sat
 * at y 907–949 against a viewport ending at 913, six pixels of a 42px row, for
 * every row from ~20 on, because the virtualiser placed rows at
 * `index * rowHeight` while the sticky `<thead>` owned the first 36px of the
 * scroll content.
 */
const focusedRowGeometry = (page: Page) => page.evaluate(() => {
  const scroller = document.querySelector('#table .ain-table__scroll')!.getBoundingClientRect();
  const head = document.querySelector('#table thead')!.getBoundingClientRect();
  const footEl = document.querySelector('#table tfoot');
  const foot = footEl?.getBoundingClientRect() ?? null;
  const el = document.activeElement as HTMLElement;
  const row = el.closest('tr');
  if (!row) return { focused: false };
  const r = row.getBoundingClientRect();
  return {
    focused: true,
    index: row.getAttribute('data-index'),
    insideScroller: r.top >= scroller.top - 0.5 && r.bottom <= scroller.bottom + 0.5,
    // Inside the box is not enough: the header and the totals row are painted
    // over its ends, and a row behind them is a row you are not driving.
    clearOfHeader: r.top >= head.bottom - 0.5,
    clearOfFooter: foot ? r.bottom <= foot.top + 0.5 : true,
    rect: [Math.round(r.top), Math.round(r.bottom)],
    scroller: [Math.round(scroller.top), Math.round(scroller.bottom)],
  };
});

const enterGrid = async (page: Page) => {
  await openSection(page, 'table');
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector<HTMLElement>('#table tbody tr[tabindex="0"]')!.focus());
};

test('arrowing down the grid keeps the focused row wholly on screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(DESIGN, { waitUntil: 'networkidle' });
  await enterGrid(page);

  for (let i = 1; i <= 25; i++) {
    await page.keyboard.press('ArrowDown');
    const seen = await focusedRowGeometry(page);
    expect(seen, `after ArrowDown ${i}`).toMatchObject({
      focused: true, insideScroller: true, clearOfHeader: true, clearOfFooter: true,
    });
    expect(seen.index, `after ArrowDown ${i}`).toBe(String(i));
  }

  // Deep into the list, and back up again: the upward branch used to look right
  // only because the same 36px error cancelled.
  for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowDown');
  expect(await focusedRowGeometry(page)).toMatchObject({ insideScroller: true, clearOfHeader: true, clearOfFooter: true });
  for (let i = 0; i < 70; i++) await page.keyboard.press('ArrowUp');
  expect(await focusedRowGeometry(page)).toMatchObject({ insideScroller: true, clearOfHeader: true, clearOfFooter: true });

  await page.keyboard.press('End');
  await expect.poll(async () => (await focusedRowGeometry(page)).clearOfFooter).toBe(true);
  expect(await focusedRowGeometry(page)).toMatchObject({ index: '1239', insideScroller: true, clearOfHeader: true });
});

test('Page Down moves a screenful without dropping focus to the document', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(DESIGN, { waitUntil: 'networkidle' });
  await enterGrid(page);

  const inGrid = () => page.evaluate(() => !!document.activeElement?.closest('#table'));
  let previous = 0;
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('PageDown');
    // Left to the browser this scrolled the box, the window unmounted the row
    // and activeElement became BODY on two attempts in five.
    expect(await inGrid(), `after PageDown ${i + 1}`).toBe(true);
    const seen = await focusedRowGeometry(page);
    expect(seen, `after PageDown ${i + 1}`).toMatchObject({ insideScroller: true, clearOfHeader: true, clearOfFooter: true });
    const index = Number(seen.index);
    expect(index, 'a page is more than a row and less than the whole list').toBeGreaterThan(previous + 1);
    previous = index;
  }
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('PageUp');
    expect(await inGrid(), `after PageUp ${i + 1}`).toBe(true);
    expect(await focusedRowGeometry(page)).toMatchObject({ insideScroller: true, clearOfHeader: true, clearOfFooter: true });
  }
  expect((await focusedRowGeometry(page)).index).toBe('0');
});

test('tabbing a filter editor never parks a value under its Done bar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 460 });
  await page.goto(DESIGN, { waitUntil: 'networkidle' });
  await openSection(page, 'table');
  await page.locator('#table button:has-text("Filters")').first().click();
  await page.locator('#table button.ain-table__addfilter').first().click();
  await page.locator('.ain-menu__item', { hasText: 'Account' }).first().click();
  await expect(page.locator('.ain-filtered__opt').first()).toBeVisible();

  for (let i = 0; i < 24; i++) {
    await page.keyboard.press('Tab');
    const seen = await page.evaluate(() => {
      const pop = [...document.querySelectorAll<HTMLElement>('.ain-popover')].find((x) => getComputedStyle(x).visibility !== 'hidden');
      const el = document.activeElement as HTMLElement;
      const row = el.closest('.ain-filtered__opt');
      if (!pop || !row) return null;
      const list = pop.querySelector('.ain-filtered__list')!.getBoundingClientRect();
      const foot = pop.querySelector('.ain-filtered__foot')!.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      return { label: row.textContent?.trim(), underFoot: r.bottom > foot.top + 0.5, clipped: r.top < list.top - 0.5 || r.bottom > list.bottom + 0.5 };
    });
    if (!seen) continue;
    expect(seen, `Tab ${i + 1} — ${seen.label}`).toMatchObject({ underFoot: false, clipped: false });
  }
});

/* ================================= Toasts ================================= */

/**
 * A toast lives about four seconds and its action button is 59 Tab stops away.
 * Without a hotkey the Undo the whole pattern exists for is decoration, so the
 * hotkey is the feature — and it has to be in the region's name to be findable.
 */
test('the toast stack takes the keyboard, holds still for it, and fires', async ({ page }) => {
  await openSection(page, 'overlays');
  const trigger = page.getByRole('button', { name: 'Toast with action' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ain-toast')).toHaveCount(1);

  // One queue, one viewport: the shell mounts a Toaster and this page wraps
  // itself in ToastProvider, which used to render every toast twice.
  expect(await page.locator('.ain-toaster').count()).toBe(1);
  await expect(page.locator('.ain-toaster')).toHaveAttribute('aria-label', 'Notifications (F6)');

  await page.keyboard.press('F6');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.ain-toast'))).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Download');

  // Nominal life is 12s for an action toast and the timer is frozen while focus
  // is inside, so it is still there long after an info toast's 5s.
  await page.waitForTimeout(6000);
  await expect(page.locator('.ain-toast')).toHaveCount(1);
  expect(await page.evaluate(() => !!document.activeElement?.closest('.ain-toast'))).toBe(true);

  // Enter fires the action — the demo really writes the CSV — and focus comes
  // back to where it was rather than falling onto <body>.
  const download = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  expect((await download).suggestedFilename()).toBe('northwind-invoices.csv');
  await expect(page.locator('.ain-toast').filter({ hasText: 'northwind-invoices.csv' })).toBeVisible();
  await expect(trigger).toBeFocused();
});

test('Escape hands focus back from the toast stack, and the timer restarts', async ({ page }) => {
  await openSection(page, 'overlays');
  const trigger = page.getByRole('button', { name: 'Success toast' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ain-toast')).toHaveCount(1);

  await page.keyboard.press('F6');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.ain-toast'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  // Released, the 4s success toast goes away on its own.
  await expect(page.locator('.ain-toast')).toHaveCount(0, { timeout: 9000 });
});
