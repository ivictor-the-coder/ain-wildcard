/**
 * The shell, driven in a real browser.
 *
 * Two things here were live defects. The dashboard's "Prepaid credit
 * outstanding" tile read the first row of a per-currency answer and so reported
 * £0.00 to a workspace holding $1,250.00, beside five other tiles in USD. And
 * the top-bar search had no answer of its own: it swallowed the query until you
 * landed on another page. Neither is visible from a pure function — one is a
 * choice made against live API data, the other is wiring between a caret, a
 * listbox and a router — so both are checked against a running server.
 *
 *   node scripts/preview.mjs --port 8832 --name shell
 *   AIN_BASE_URL=http://127.0.0.1:8832 npx playwright test e2e/shell.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';

const signIn = async (page: Page) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const demo = page.getByRole('button', { name: 'Use the demo workspace' });
  if (await demo.count()) await demo.click();
  await page.waitForSelector('.ain-stat');
};

/** The symbol a formatted amount carries — "$1,250.00" → "$". */
const symbolOf = (money: string): string => money.replace(/[\d.,\s ]/g, '');

test.beforeEach(async ({ page }) => { await signIn(page); });

/* ============================== the dashboard ============================= */

test('prepaid credit is reported in the workspace currency, not the first pot the API listed', async ({ page }) => {
  const me = await (await page.request.get('/api/v1/me')).json();
  const overview = await (await page.request.get('/api/v1/credits/overview')).json();
  const currency: string = me.org.default_currency;
  const pot = overview.outstanding.find((row: { currency: string }) => row.currency === currency);
  test.skip(!pot || pot.monetary_outstanding === 0, 'this workspace holds no prepaid credit in its own currency');

  const value = page.locator('.ain-stat', { hasText: 'Prepaid credit outstanding' }).locator('.ain-stat__value');
  await expect(value).toHaveText(pot.monetary_outstanding_display);

  // Every other money tile on this screen is in the workspace currency; a
  // credit figure in a different symbol is the reading that lost the trust.
  const mrr = await page.locator('.ain-stat', { hasText: 'Monthly recurring revenue' }).locator('.ain-stat__value').innerText();
  expect(symbolOf(await value.innerText())).toBe(symbolOf(mrr));

  // And an empty pot in another currency is never what the tile shows.
  for (const row of overview.outstanding) {
    if (row.currency === currency || row.monetary_outstanding > 0) continue;
    await expect(value).not.toHaveText(row.monetary_outstanding_display);
  }
});

/* ============================== the typeahead ============================= */

const panel = (page: Page) => page.locator('.shell-search__panel');

const openTypeahead = async (page: Page, query: string) => {
  await page.keyboard.press('/');
  await page.keyboard.type(query, { delay: 30 });
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('.shell-search__row').last()).toBeVisible();
};

test('typing answers under the field, grouped by object type', async ({ page }) => {
  await openTypeahead(page, 'north');
  await expect.poll(() => page.locator('.shell-search__group').count()).toBeGreaterThan(1);

  // Every group is a real source, named, with its own count.
  const groups = await page.locator('.shell-search__group').evaluateAll((els) => els.map((el) => ({
    label: el.getAttribute('aria-label'),
    head: el.querySelector('.shell-search__grouphead')?.textContent?.trim(),
    rows: el.querySelectorAll('.shell-search__row').length,
  })));
  for (const group of groups) {
    expect(group.label).toBeTruthy();
    expect(group.head?.toLowerCase()).toContain(group.label!.toLowerCase());
    expect(group.rows).toBeGreaterThan(0);
  }

  // The field is a combobox pointing at the row it has highlighted.
  const input = page.locator('.shell-search__input');
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  const activeId = await input.getAttribute('aria-activedescendant');
  expect(activeId).toBeTruthy();
  await expect(page.locator(`[id="${activeId}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('↑↓ moves the highlight and ↵ opens what is highlighted', async ({ page }) => {
  await openTypeahead(page, 'north');
  const input = page.locator('.shell-search__input');
  const first = await input.getAttribute('aria-activedescendant');

  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await page.locator('[aria-selected="true"]').count()) === 1).toBe(true);
  const moved = await input.getAttribute('aria-activedescendant');
  expect(moved).toBeTruthy();
  // With one navigable row the highlight wraps back onto itself; with more it moves.
  const navigable = await page.locator('.shell-search__row:not([aria-disabled="true"])').count();
  if (navigable > 1) expect(moved).not.toBe(first);

  const highlighted = page.locator(`[id="${moved}"]`);
  const label = (await highlighted.locator('.shell-search__title').innerText()).trim();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toHaveCount(0);
  // The highlighted row is what opened: either its record screen, or — for the
  // pinned last row — the full results page for exactly what was typed.
  if (label.startsWith('See every match') || label.startsWith('Search everything')) {
    await expect(page).toHaveURL(/\/search\?q=north$/);
  } else {
    await expect(page).not.toHaveURL(/\/$/);
  }
});

test('Esc closes the panel before it clears the field', async ({ page }) => {
  await openTypeahead(page, 'north');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('.shell-search__input')).toHaveValue('north');

  await page.keyboard.press('Escape');
  await expect(page.locator('.shell-search__input')).toHaveValue('');
  expect(await page.evaluate(() => document.activeElement?.className)).not.toContain('shell-search__input');
});

test('a record no installed module can open is shown, but never takes the highlight', async ({ page }) => {
  await openTypeahead(page, 'north');
  const unopenable = page.locator('.shell-search__row[aria-disabled="true"]');
  const count = await unopenable.count();
  test.skip(count === 0, 'every source in this build registers a screen');

  // Shown — and said once, above the list, rather than on every row.
  await expect(unopenable.first()).toBeVisible();
  for (let i = 0; i < count; i++) await expect(unopenable.nth(i)).toHaveAttribute('aria-selected', 'false');

  // ↓ through the whole list never lands on one.
  const navigable = await page.locator('.shell-search__row:not([aria-disabled="true"])').count();
  for (let i = 0; i < navigable + 1; i++) {
    await page.keyboard.press('ArrowDown');
    const id = await page.locator('.shell-search__input').getAttribute('aria-activedescendant');
    await expect(page.locator(`[id="${id}"]`)).not.toHaveAttribute('aria-disabled', 'true');
  }
});

test('the pinned last row always reaches the full results page', async ({ page }) => {
  await openTypeahead(page, 'north');
  const all = page.locator('.shell-search__row--all');
  await expect(all).toBeVisible();
  // Pinned: visible without scrolling the list, whatever the list is doing.
  const inside = await all.evaluate((row) => {
    const p = row.closest('.shell-search__panel')!.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return r.top >= p.top - 1 && r.bottom <= p.bottom + 1;
  });
  expect(inside).toBe(true);

  await all.click();
  await expect(page).toHaveURL(/\/search\?q=north$/);
  await expect(page.locator('main')).toContainText('Everything');
});
