/**
 * The settings surface, driven in a real browser.
 *
 * Every test below does through the UI what an operator would do — edit the
 * workspace, seat a teammate, mint a key, register a rate, define a feature,
 * move the clock — and then asks the API whether the workspace actually
 * changed. A screen that renders the right numbers but cannot move any of them
 * passes none of these.
 *
 *   node scripts/preview.mjs --port 8883 --name settings --fresh
 *   AIN_BASE_URL=http://127.0.0.1:8883 npx playwright test e2e/settings.spec.ts
 */
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';

const signIn = async (page: Page) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const demo = page.getByRole('button', { name: 'Use the demo workspace' });
  if (await demo.count()) await demo.click();
  await page.waitForSelector('.ain-stat');
};

/**
 * A read, retried past a rate limit. The suite makes a few hundred API reads in
 * one session and the platform's limiter answers 429 to the tail of them; a
 * test that reads `undefined` off one is a flake, not a finding.
 */
const json = async (page: Page, path: string): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let attempt = 0; ; attempt++) {
    const res = await page.request.get(`/api${path}`);
    if (res.ok() || attempt === 3) return res.json();
    await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
  }
};

/** Open a settings screen and wait for its own heading rather than the shell's. */
const openSettings = async (page: Page, path: string, heading: string) => {
  await page.goto(path, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
};

/** The row menu on a DataTable row whose text contains `needle`. */
const rowMenu = async (page: Page, needle: string) => {
  const row = page.locator('tr').filter({ hasText: needle }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Row actions' }).click();
};

const dialog = (page: Page) => page.getByRole('dialog');

/** Unique per run, so a re-run against a warm database never collides. */
const stamp = () => Date.now().toString(36).slice(-6);

/* ============================== the sub-nav =============================== */

test('the settings surface exists and every page in its sub-navigation opens', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings', 'Workspace');

  const rail = page.locator('.st-rail');
  await expect(rail).toBeVisible();

  const pages: [string, string][] = [
    ['Team', 'Team'],
    ['API keys', 'API keys'],
    ['Events', 'Events'],
    ['Jobs', 'Jobs'],
    ['Audit log', 'Audit log'],
    ['Time machine', 'Time machine'],
    ['Tax', 'Tax'],
    ['Features', 'Features & entitlements'],
  ];

  for (const [link, heading] of pages) {
    await rail.getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
    // The rail marks where you are, so a nine-page surface never loses you.
    await expect(rail.locator('a[aria-current="page"]')).toHaveText(new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

/* =============================== workspace =============================== */

test('the workspace timezone is editable and every date in the product follows it', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings', 'Workspace');

  const before = await json(page, '/v1/me');
  const from: string = before.org.timezone;
  const to = from === 'Europe/Berlin' ? 'America/New_York' : 'Europe/Berlin';

  await page.getByLabel('Timezone').selectOption(to);

  // The preview is bound to the draft, not to what is saved — so it has to
  // change before anything is written.
  await expect(page.getByText('What this changes')).toBeVisible();

  await page.getByRole('button', { name: /^Save \d+ change/ }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 15_000 });

  const after = await json(page, '/v1/me');
  expect(after.org.timezone).toBe(to);

  // And the change reaches the rest of the product: the workspace facts panel
  // is rendered from the session the shell re-read.
  await expect(page.locator('.st-body')).toContainText(to.replace(/_/g, ' '));

  // It is audited, with the before and after the trail promises. The entry is
  // found by what it says rather than by being the newest one: `created` is the
  // *workspace* clock, so a run that has used the time machine leaves rows
  // whose timestamps sort ahead of everything written after the clock came back.
  const trail = await json(page, '/v1/audit-log?limit=500');
  const entry = trail.data.find((row: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
    row.action === 'org.updated' && row.after?.timezone === to && row.before?.timezone === from);
  expect(entry, 'the timezone change is on the audit trail with its before and after').toBeTruthy();
  expect(entry.request_id).toBeTruthy();

  // Put it back, through the same control.
  await page.getByLabel('Timezone').selectOption(from);
  await page.getByRole('button', { name: /^Save \d+ change/ }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 15_000 });
  expect((await json(page, '/v1/me')).org.timezone).toBe(from);
});

/* ================================== team ================================= */

test('a teammate can be invited, have their role changed and be removed', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/team', 'Team');

  const email = `e2e.${stamp()}@northwind.io`;

  await page.getByRole('button', { name: 'Invite a teammate' }).click();
  await dialog(page).getByLabel('Work email').fill(email);
  await dialog(page).getByLabel('Full name').fill('E2E Fixture');
  await dialog(page).getByLabel('Job title').fill('Commissioning Engineer');
  await dialog(page).getByRole('radio', { name: /^analyst\b/ }).check();
  await dialog(page).getByRole('button', { name: 'Add to workspace' }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 });

  const seated = (await json(page, '/v1/users')).data.find((row: any) => row.email === email); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(seated, 'the invited teammate is on the workspace').toBeTruthy();
  expect(seated.role).toBe('analyst');

  // The role picker is honest about the rung it grants, and changing it sticks.
  await rowMenu(page, email);
  await page.getByRole('menuitem', { name: 'Change role…' }).click();
  await expect(dialog(page)).toContainText('Read-only, everywhere');
  await dialog(page).getByRole('radio', { name: /^member\b/ }).check();
  await expect(dialog(page)).toContainText('From analyst to member');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 });

  const promoted = (await json(page, '/v1/users')).data.find((row: any) => row.email === email); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(promoted.role).toBe('member');

  // Removal is destructive, so it confirms — and it will not proceed until the
  // address is typed back.
  await rowMenu(page, email);
  await page.getByRole('menuitem', { name: 'Remove from workspace…' }).click();
  const remove = dialog(page).getByRole('button', { name: 'Remove and revoke' });
  await expect(remove).toBeDisabled();
  await dialog(page).getByRole('textbox').fill(email);
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 });

  const users = (await json(page, '/v1/users')).data;
  expect(users.some((row: any) => row.email === email)).toBe(false); // eslint-disable-line @typescript-eslint/no-explicit-any
});

/* =============================== API keys ================================ */

test('an API key is minted, its secret shown exactly once, and revoked', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/api-keys', 'API keys');

  const name = `E2E ingest ${stamp()}`;

  await page.getByRole('button', { name: 'Create a key' }).click();
  await dialog(page).getByLabel('What is this key for').fill(name);
  await dialog(page).getByRole('radio', { name: /^Read only\b/ }).check();
  await expect(dialog(page)).toContainText('This key will authenticate as readonly');
  await dialog(page).getByRole('button', { name: 'Create key' }).click();

  // The one moment the secret exists.
  const secretPanel = dialog(page).locator('.st-secret');
  await expect(secretPanel).toBeVisible({ timeout: 15_000 });
  await expect(secretPanel).toContainText('Copy this now');
  await expect(secretPanel.getByRole('button', { name: /Copy the secret/ })).toBeVisible();

  // Masked until revealed — a secret on screen by default is a secret on a
  // screen share.
  const shown = await secretPanel.locator('.ain-copyfield__value').innerText();
  expect(shown).toContain('•');
  await secretPanel.getByRole('button', { name: 'Reveal value' }).click();
  const revealed = await secretPanel.locator('.ain-copyfield__value').innerText();
  expect(revealed).toMatch(/^sk_test_/);

  // The dialog refuses to close until the operator says they have it.
  const done = dialog(page).getByRole('button', { name: 'Copy it first' });
  await expect(done).toBeDisabled();
  await dialog(page).getByRole('checkbox').check();
  await dialog(page).getByRole('button', { name: 'Done' }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 });

  const keys = (await json(page, '/v1/api-keys')).data;
  const minted = keys.find((row: any) => row.name === name); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(minted, 'the key exists on the workspace').toBeTruthy();
  expect(minted.scopes).toEqual(['read']);
  expect(minted.revoked_at).toBeNull();
  // The list never carries the secret again — only a mask.
  expect(JSON.stringify(minted)).not.toContain(revealed);
  expect(minted.masked).toContain('•');

  await rowMenu(page, name);
  await page.getByRole('menuitem', { name: 'Revoke this key…' }).click();
  await dialog(page).getByRole('button', { name: 'Revoke it' }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 });

  const revoked = (await json(page, '/v1/api-keys')).data.find((row: any) => row.name === name); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(revoked.revoked_at).not.toBeNull();
});

/* ================================== tax ================================== */

test('a tax rate is registered from the UI and retired again', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/tax', 'Tax');

  const jurisdiction = `E2E County ${stamp()}`;

  await page.getByRole('button', { name: 'Register a rate' }).click();
  await dialog(page).getByLabel('Jurisdiction').fill(jurisdiction);
  await dialog(page).getByLabel('What appears on the invoice').fill('E2E county tax');
  await dialog(page).getByLabel('Country').fill('US');
  await dialog(page).getByLabel('State or province').fill('Ohio');
  await dialog(page).getByLabel('Kind of tax').selectOption('sales_tax');
  await dialog(page).getByLabel('Percentage').fill('8.875');
  await dialog(page).getByRole('button', { name: 'Register it' }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 });

  const rates = (await json(page, '/v1/tax_rates?limit=500')).data;
  const created = rates.find((row: any) => row.jurisdiction === jurisdiction); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(created, 'the rate is registered').toBeTruthy();
  // The exact decimal survives the round trip — no float ever touches it.
  expect(created.percentage).toBe('8.875');
  expect(created.active).toBe(true);

  // Find it in the grid through the search the toolbar offers, then retire it.
  await page.getByPlaceholder('Search by jurisdiction, country or name').fill(jurisdiction);
  await rowMenu(page, jurisdiction);
  await page.getByRole('menuitem', { name: 'Retire this rate…' }).click();
  await dialog(page).getByRole('button', { name: 'Retire it' }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 });

  const retired = (await json(page, '/v1/tax_rates?limit=500')).data
    .find((row: any) => row.jurisdiction === jurisdiction); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(retired.active).toBe(false);
});

test('a refused registration is explained under the field the server named', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/tax', 'Tax');
  await page.getByRole('button', { name: 'Register a rate' }).click();
  await dialog(page).getByLabel('What appears on the invoice').fill('VAT');
  await dialog(page).getByLabel('Jurisdiction').fill('Germany');
  // Germany already carries an active rate, and one address may never match two.
  await dialog(page).getByLabel('Country', { exact: true }).fill('DE');
  await dialog(page).getByLabel('Percentage').fill('19');
  await dialog(page).getByRole('button', { name: 'Register it' }).click();

  await expect(dialog(page).getByText(/already/i).first()).toBeVisible();
  await expect(dialog(page)).toBeVisible();
});

test('the hold on bills with no tax location can be turned on and off', async ({ page }) => {
  await signIn(page);
  const before = await json(page, '/v1/billing/automatic_tax');
  await openSettings(page, '/settings/tax', 'Tax');

  const toggle = page.getByRole('switch', { name: /Hold an invoice as a draft/ });
  await expect(toggle).toHaveAttribute('aria-checked', String(before.enabled));
  await toggle.click();
  await expect.poll(async () => (await json(page, '/v1/billing/automatic_tax')).enabled).toBe(!before.enabled);

  await toggle.click();
  await expect.poll(async () => (await json(page, '/v1/billing/automatic_tax')).enabled).toBe(before.enabled);
});

test('the tax screen is operable from the keyboard alone', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/tax', 'Tax');

  // Tab to the primary action rather than clicking it, and open it with Enter.
  const register = page.getByRole('button', { name: 'Register a rate' });
  await register.focus();
  await expect(register).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(dialog(page)).toBeVisible();
  // Focus is inside the dialog, not left behind on the page under it.
  await expect(dialog(page).locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(register).toBeFocused();

  // The search is a plain text box, so it narrows the grid from the keyboard.
  const search = page.getByPlaceholder('Search by jurisdiction, country or name');
  await search.focus();
  await page.keyboard.type('DE');
  await expect.poll(async () => page.locator('tbody tr').count()).toBeGreaterThan(0);

  // And the hold is a real switch: focusable, and toggled with the space bar.
  const toggle = page.getByRole('switch', { name: /Hold an invoice as a draft/ });
  const before = await toggle.getAttribute('aria-checked');
  await toggle.focus();
  await page.keyboard.press(' ');
  await expect.poll(async () => toggle.getAttribute('aria-checked')).not.toBe(before);
  await page.keyboard.press(' ');
  await expect.poll(async () => toggle.getAttribute('aria-checked')).toBe(before);
});

/* =========================== features & entitlements ===================== */

test('a feature is defined, granted to one account as an override, and revoked', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/features', 'Features & entitlements');

  const key = `e2e_${stamp()}`;

  await page.getByRole('button', { name: 'Define a feature' }).first().click();
  await dialog(page).getByLabel('Feature key').fill(key);
  await dialog(page).getByLabel('Kind of feature').selectOption('limit');
  await dialog(page).getByLabel('Feature name').fill('E2E commissioning bays');
  await dialog(page).getByLabel('Unit label').fill('bay');
  await dialog(page).getByRole('button', { name: 'Define it' }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 });

  const features = (await json(page, '/v1/features')).data;
  const defined = features.find((row: any) => row.key === key); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(defined, 'the feature is in the catalogue').toBeTruthy();
  expect(defined.type).toBe('limit');
  expect(defined.unit_label).toBe('bay');

  // Now hand one account more of it than any plan grants.
  const customer = (await json(page, '/v1/customers?limit=1')).data[0];

  await page.getByRole('tab', { name: /What an account holds/ }).click();
  const combo = page.getByRole('combobox', { name: 'Choose an account' });
  await combo.click();
  await combo.fill(customer.name);
  await combo.press('Enter');

  await expect(page.getByRole('button', { name: 'Open the account' })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Grant or suspend' }).click();
  await dialog(page).getByLabel('Feature').selectOption(key);
  await dialog(page).getByLabel('Override value').fill('12');
  await dialog(page).getByLabel('Why').fill('E2E fixture — commissioning bays raised for the cutover.');
  await dialog(page).getByRole('button', { name: 'Grant it' }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 });

  const overrides = (await json(page, `/v1/entitlement-overrides?customer=${customer.id}&status=all&limit=200`)).data;
  const granted = overrides.find((row: any) => row.feature === key); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(granted, 'the override is written').toBeTruthy();
  expect(granted.value).toBe(12);
  expect(granted.status).toBe('active');

  // And the account now holds it, with the reason attached — the "why".
  const set = await json(page, `/v1/customers/${customer.id}/entitlements`);
  const held = set.entitlements.find((row: any) => row.feature === key); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(held, 'the entitlement set was recomputed').toBeTruthy();
  expect(held.value).toBe(12);
  await expect(page.locator('.st-ent__why').filter({ hasText: 'commissioning bays' }).first()).toBeVisible();

  await rowMenu(page, 'E2E fixture — commissioning bays');
  await page.getByRole('menuitem', { name: 'Revoke now…' }).click();
  await dialog(page).getByRole('button', { name: 'Revoke it' }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 });

  const after = (await json(page, `/v1/entitlement-overrides?customer=${customer.id}&status=all&limit=200`)).data
    .find((row: any) => row.feature === key); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(after.status).toBe('revoked');
});

/* ================================= events ================================ */

test('the event stream filters by type on the server and shows the whole payload', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/events', 'Events');

  const stream = page.locator('.st-stream');
  await expect(stream.locator('.st-event').first()).toBeVisible({ timeout: 15_000 });

  // Pick the type of the first event and filter to it.
  const type = (await stream.locator('.st-event__type').first().innerText()).trim();
  await page.getByRole('group', { name: 'Filter by event type' }).getByRole('button', { name: new RegExp(`^${type}`) }).click();

  await expect.poll(async () => {
    const types = await stream.locator('.st-event__type').allInnerTexts();
    return types.length > 0 && types.every((row) => row.trim() === type);
  }, { timeout: 15_000 }).toBe(true);

  // The detail is read back from GET /v1/events/:id and printed whole.
  await stream.locator('.st-event').first().click();
  const payload = page.locator('.st-json__code').first();
  await expect(payload).toBeVisible({ timeout: 15_000 });

  const shownId = (await page.locator('.st-body .st-mono').filter({ hasText: /^evt_/ }).first().innerText()).trim();
  const event = await json(page, `/v1/events/${shownId}`);
  expect(event.type).toBe(type);
  // What is on screen is what the API sent, not a summary of it.
  const printed = JSON.parse(await payload.innerText());
  expect(printed).toEqual(event.data);
});

/* =============================== audit log =============================== */

test('the audit trail names the actor, the target, the diff and the request id', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/audit', 'Audit log');

  // The earlier tests in this file wrote these entries through the UI.
  const trail = await json(page, '/v1/audit-log?limit=500');
  expect(trail.data.length, 'the trail has entries the earlier tests wrote').toBeGreaterThan(0);

  const roleChange = trail.data.find((row: any) => row.action === 'user.role_changed'); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(roleChange, 'the role change is on the trail').toBeTruthy();

  await page.getByPlaceholder('Search summaries, targets and request ids').fill('user.role_changed');
  const row = page.locator('tr').filter({ hasText: 'user.role_changed' }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();

  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Request id');
  await expect(drawer).toContainText(roleChange.request_id);
  await expect(drawer).toContainText('Dana Whitfield');
  // The diff is a field-level before-and-after, not two blobs to eyeball.
  await expect(drawer.locator('.st-diffrow__key').filter({ hasText: 'role' }).first()).toBeVisible();
  await expect(drawer.locator('.st-diffrow__now').first()).toContainText('member');
});

/* ============================== time machine ============================= */

test('the time machine moves the clock, runs the queue and logs what it ran', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/time', 'Time machine');

  const before = await json(page, '/v1/me');
  test.skip(before.clock.kind !== 'virtual', 'this build runs on the real clock');

  await page.getByRole('button', { name: /A billing cycle/ }).click();

  await expect.poll(async () => (await json(page, '/v1/me')).clock.now, { timeout: 60_000 })
    .toBeGreaterThan(before.clock.now + 20 * 24 * 3600 * 1000);

  // Work actually ran, and it ran *inside the window the jump opened* — not
  // simply "there are completed jobs", which was already true. Counting rows
  // would not have shown it either: `core.cleanup` runs during the jump and
  // deletes completed jobs older than seven workspace days, so the total can
  // come out flat while a month of billing has just been executed.
  const done = (await json(page, '/v1/jobs?status=done&limit=200')).data;
  const ranInWindow = done.filter((job: any) => job.updated > before.clock.now); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(ranInWindow.length, 'jobs completed inside the jump').toBeGreaterThan(0);

  // And the move is on the screen's own log, with what ran inside its window.
  await expect(page.getByText('What ran when it moved')).toBeVisible();
  const move = page.locator('.st-row').filter({ hasText: 'moved by Dana Whitfield' }).first();
  await expect(move).toBeVisible({ timeout: 20_000 });
  await move.getByRole('button', { name: 'What ran' }).click();
  await expect(move.locator('.st-diffrow').first()).toBeVisible();

  // Returning to now confirms first, and then actually returns.
  await page.getByRole('button', { name: 'Return to now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Return to now' }).click();

  await expect.poll(async () => Math.abs((await json(page, '/v1/me')).clock.offset_ms), { timeout: 60_000 })
    .toBeLessThan(60_000);
});

/* ================================== jobs ================================= */

test('the job queue screen reports exactly what the queue holds', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/jobs', 'Jobs');

  const pending = await json(page, '/v1/jobs?status=pending&limit=200');
  const waiting = page.locator('.ain-stat')
    .filter({ has: page.locator('.ain-stat__label', { hasText: /^Waiting$/ }) })
    .locator('.ain-stat__value');
  await expect(waiting).toHaveText(new Intl.NumberFormat('en-US').format(pending.total_count), { timeout: 15_000 });

  // Every status the route serves is a tab, and each one reads its own page.
  const done = await json(page, '/v1/jobs?status=done&limit=200');
  await page.getByRole('tab', { name: /Done/ }).click();
  await expect(page.locator('tbody tr')).toHaveCount(Math.min(done.data.length, 200), { timeout: 15_000 });

  // A completed job carries its payload — the argument the handler was given.
  await page.locator('tbody tr').first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('payload — what the handler is given');
  await expect(drawer.locator('.st-json__code')).toBeVisible();
});


/* ============================ roles, honestly ============================ */

/**
 * What the server actually answers this session for a route. Every refusal on
 * this surface names a route; these tests ask the API what that route really
 * does rather than taking the screen's word for it, because the previous
 * version of this test believed a sentence that was false.
 */
const status = async (page: Page, path: string): Promise<number> => (await page.request.get(`/api${path}`)).status();

const signInAs = async (page: Page, email: string) => {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('demo1234');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
};

test('an analyst sees the surface, is told what is locked, and every refusal it prints is true', async ({ page }) => {
  // Every seeded teammate shares the demo password; Nina is the workspace's
  // analyst, which is the rung below every write in the platform.
  await signInAs(page, 'nina@northwind.io');

  await openSettings(page, '/settings', 'Workspace');
  expect((await json(page, '/v1/me')).role).toBe('analyst');

  // The rail locks the two screens whose *read* the server genuinely refuses,
  // and nothing else. A lock on a screen that would have rendered is how the
  // roster went missing for a role the API serves it to.
  expect(await status(page, '/v1/api-keys')).toBe(403);
  expect(await status(page, '/v1/audit-log')).toBe(403);
  expect(await status(page, '/v1/users')).toBe(200);
  expect(await status(page, '/v1/jobs')).toBe(200);
  expect(await status(page, '/v1/events')).toBe(200);

  const locked = page.locator('.st-rail__item.is-locked');
  await expect(locked).toHaveCount(2);
  await expect(locked.first()).toHaveAttribute('title', /needs the admin role/);

  // The workspace form is filled in and read-only, and says why.
  await expect(page.getByText('You can read these, not change them')).toBeVisible();
  await expect(page.getByLabel('Workspace name')).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Save|^Saved/ })).toBeDisabled();

  // An admin-only read is refused by the server, so the screen says so instead
  // of rendering an empty table that looks like an empty workspace.
  await openSettings(page, '/settings/api-keys', 'API keys');
  await expect(page.getByText('Reading API keys needs the admin role')).toBeVisible();
  await expect(page.locator('table')).toHaveCount(0);

  await openSettings(page, '/settings/audit', 'Audit log');
  await expect(page.getByText('The audit trail needs the admin role')).toBeVisible();

  // The clock is a write that is gated, not a read: the screen shows what the
  // queue holds and refuses only the jumps.
  await openSettings(page, '/settings/time', 'Time machine');
  await expect(page.getByText('Moving the workspace clock needs the admin role')).toBeVisible();
  await expect(page.locator('.st-clock__value')).toBeVisible();
  await expect(page.getByRole('button', { name: /A billing cycle/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Run .* of work$/ })).toBeDisabled();
  // …and the count it cannot read is not reported as a zero.
  await expect(page.locator('.ain-stat').filter({ hasText: 'Moves recorded' }))
    .toContainText('not a count of zero');

  // And the screens an analyst may read still work, in full.
  await openSettings(page, '/settings/events', 'Events');
  await expect(page.locator('.st-event').first()).toBeVisible({ timeout: 15_000 });

  await openSettings(page, '/settings/jobs', 'Jobs');
  await expect(page.getByRole('button', { name: /Nothing is due|^Run / })).toBeDisabled();
});

test('an analyst reads the team roster the server serves them, and can change nothing on it', async ({ page }) => {
  await signInAs(page, 'nina@northwind.io');
  await openSettings(page, '/settings/team', 'Team');

  const roster = (await json(page, '/v1/users')).data;
  expect(roster.length, 'the server serves the whole roster to an analyst').toBeGreaterThanOrEqual(6);

  // The roster is on screen — one row per teammate the API returned.
  await expect(page.locator('tbody tr')).toHaveCount(roster.length, { timeout: 15_000 });
  await expect(page.locator('tbody')).toContainText('dana@northwind.io');
  await expect(page.locator('tbody')).toContainText('nina@northwind.io');

  // …and it is not hidden behind a refusal the server would not have made.
  await expect(page.getByText('needs the admin role')).toHaveCount(0);

  // Every write is gated at admin, so none of them is offered.
  await expect(page.getByRole('button', { name: 'Invite a teammate' })).toHaveCount(0);
  await expect(page.locator('tbody').getByRole('button', { name: 'Row actions' })).toHaveCount(0);
  await expect(page.getByText('You can read the team, not change it')).toBeVisible();
});

/* ========================= the workspace, honestly ======================== */

test('an empty workspace name is refused on the screen instead of reported as saved', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings', 'Workspace');

  const before = await json(page, '/v1/me');
  const trailBefore = (await json(page, '/v1/audit-log?limit=500')).data
    .filter((row: any) => row.action === 'org.updated').length; // eslint-disable-line @typescript-eslint/no-explicit-any

  await page.getByLabel('Workspace name').fill('');

  // The field says what is wrong, and the save is refused here rather than by
  // a server that answers 200 and changes nothing.
  await expect(page.getByText('A workspace must have a name.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Save \d+ change/ })).toBeDisabled();

  // Nothing was written: not the org, not the audit trail.
  expect((await json(page, '/v1/me')).org.name).toBe(before.org.name);
  const trailAfter = (await json(page, '/v1/audit-log?limit=500')).data
    .filter((row: any) => row.action === 'org.updated').length; // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(trailAfter).toBe(trailBefore);

  // And the header still names the workspace it still is.
  await expect(page.locator('.st-body')).toContainText(before.org.name);
});

test('a save the API silently dropped is reported as a change that did not happen', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings', 'Workspace');

  const before = await json(page, '/v1/me');
  test.skip(!before.org.domain, 'this workspace has no domain to try to clear');

  await page.getByLabel('Primary domain').fill('');

  // Said before the request is made…
  await expect(page.getByText(/An empty value is dropped by the API/)).toBeVisible();

  await page.getByRole('button', { name: /^Save \d+ change/ }).click();

  // …and again from the answer the server actually gave.
  await expect(page.locator('.ain-toast').filter({ hasText: 'Nothing changed' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.ain-toast').filter({ hasText: 'Workspace updated' })).toHaveCount(0);

  expect((await json(page, '/v1/me')).org.domain).toBe(before.org.domain);
});

/* ====================== the last owner, and the seat ===================== */

test('the last owner is told the seat cannot be restored, and must type to give it up', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/team', 'Team');

  const me = await json(page, '/v1/me');
  expect(me.role).toBe('owner');
  const owners = (await json(page, '/v1/users')).data.filter((row: any) => row.role === 'owner'); // eslint-disable-line @typescript-eslint/no-explicit-any
  test.skip(owners.length !== 1, 'this workspace has more than one owner');

  await rowMenu(page, me.user.email);
  await page.getByRole('menuitem', { name: 'Change role…' }).click();
  await dialog(page).getByRole('radio', { name: /^analyst\b/ }).check();

  // The irreversible half, said out loud: an admin cannot grant the owner role,
  // so once this seat goes down nobody left can put it back.
  await expect(dialog(page)).toContainText(/nobody left in this workspace could restore it/i);

  // And it is confirmed the way removal is — by typing the address.
  const save = dialog(page).getByRole('button', { name: 'Lower my own role' });
  await expect(save).toBeDisabled();
  await dialog(page).getByLabel(`Type ${me.user.email} to confirm`).fill(me.user.email);
  await expect(save).toBeEnabled();

  // Nothing is saved here: the workspace keeps its owner.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  expect((await json(page, '/v1/me')).role).toBe('owner');
});

test('an admin is told why the owner rung is closed to them, in the dialog', async ({ page }) => {
  await signInAs(page, 'marcus@northwind.io');
  await openSettings(page, '/settings/team', 'Team');
  expect((await json(page, '/v1/me')).role).toBe('admin');

  await rowMenu(page, 'marcus@northwind.io');
  await page.getByRole('menuitem', { name: 'Change role…' }).click();

  const owner = dialog(page).getByRole('radio', { name: /^owner\b/ });
  await expect(owner).toBeDisabled();
  await expect(dialog(page)).toContainText(/nobody may grant a role above their own/i);
});

/* ======================== the clock, from the keyboard =================== */

test('the time machine date picker is fully operable from the keyboard', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/time', 'Time machine');

  const trigger = page.getByRole('button', { name: 'Jump the workspace clock to a date' });
  await trigger.focus();
  await page.keyboard.press('Enter');

  const calendar = page.getByRole('dialog', { name: 'Choose a date' });
  await expect(calendar).toBeVisible();

  // Focus lands inside the grid rather than being left on the trigger.
  await expect.poll(async () => page.evaluate(() => document.activeElement?.getAttribute('role')))
    .toBe('gridcell');
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  const first = await focused();

  // …and the arrow keys move it. The grid moves its roving tabindex first and
  // follows with focus on the next frame, so this waits for the frame rather
  // than reading between the two.
  await page.keyboard.press('ArrowRight');
  await expect.poll(focused).not.toBe(first);
  const second = await focused();
  await page.keyboard.press('ArrowDown');
  await expect.poll(focused).not.toBe(second);
  const third = await focused();

  // Enter picks the focused day, and the choice reaches the action.
  await page.keyboard.press('Enter');
  await expect(calendar).toBeHidden();
  await expect(trigger).toHaveText(new RegExp(third!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const run = page.getByRole('button', { name: /^Run .* of work$/ });
  await expect(run).toBeEnabled();

  // Escape closes the calendar and hands focus back to the control that opened it.
  await page.keyboard.press('Enter');
  await expect(calendar).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(calendar).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
    .toBe('Jump the workspace clock to a date');
});

/* ======================= the audit trail, as evidence ==================== */

test('the audit trail wraps its empty state, filters by date and leaves as a file', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/audit', 'Audit log');
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 15_000 });

  // A state rendered inside a table cell inherits the cell's nowrap, which used
  // to cut the sentence off at the card edge with 72% of it unreachable.
  await page.getByPlaceholder('Search summaries, targets and request ids').fill('zzz-no-such-entry');
  const body = page.locator('.ain-table__state .ain-empty__body').first();
  await expect(body).toBeVisible();
  const wrap = await body.evaluate((el) => ({
    whiteSpace: getComputedStyle(el).whiteSpace,
    overflow: el.scrollWidth - el.clientWidth,
  }));
  expect(wrap.whiteSpace).toBe('normal');
  expect(wrap.overflow).toBeLessThanOrEqual(1);
  await page.getByPlaceholder('Search summaries, targets and request ids').fill('');

  // A window nothing was written in empties the grid and says so — and says it
  // differently from "nothing has ever been audited", which is the sentence a
  // date filter must never borrow.
  const rows = await page.locator('tbody tr').count();
  expect(rows).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Bound the trail by date' }).click();
  await page.getByRole('button', { name: 'Last month', exact: true }).click();
  await expect(page.getByText('No change was recorded in that window')).toBeVisible();
  await page.getByRole('button', { name: 'Clear the dates' }).click();
  await expect.poll(async () => page.locator('tbody tr').count()).toBe(rows);

  // What is exported is what the filters left on screen, not the whole read.
  await page.getByPlaceholder('Search summaries, targets and request ids').fill('org.updated');
  const visible = await page.locator('tbody tr').count();
  expect(visible).toBeGreaterThan(0);
  expect(visible).toBeLessThan(rows);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export' }).click(),
  ]);
  const file = await download.path();
  const text = await readFile(file!, 'utf8');
  const lines = text.trim().split('\n');
  expect(lines[0]).toContain('request_id');
  expect(lines.length - 1).toBe(visible);
});

/* ========================== the command palette ========================== */

test('the palette lists each settings destination once, and Create opens the dialog', async ({ page }) => {
  await signIn(page);

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('combobox', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.fill('api key');

  // One way to the screen, one way to the thing the screen makes.
  await expect(page.locator('.pal__item').filter({ hasText: 'API keys' })).toHaveCount(1);
  const create = page.locator('.pal__item').filter({ hasText: 'Create an API key' });
  await expect(create).toHaveCount(1);

  // And the most specific-looking result is the most useful one: it opens the
  // dialog rather than dropping the operator on the list.
  await create.click();
  await expect(page).toHaveURL(/\/settings\/api-keys/);
  await expect(dialog(page).getByLabel('What is this key for')).toBeVisible({ timeout: 15_000 });
});
