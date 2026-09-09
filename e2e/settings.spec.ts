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
import { getJson, past429, postJson } from './api';

const signIn = async (page: Page) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const demo = page.getByRole('button', { name: 'Use the demo workspace' });
  if (await demo.count()) await demo.click();
  await page.waitForSelector('.ain-stat');
};

/** A read, retried past the limiter — and a refusal reported where it happened. */
const json = async (page: Page, path: string): Promise<any> => // eslint-disable-line @typescript-eslint/no-explicit-any
  getJson(page.request, `/api${path}`);

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

/**
 * Seat a teammate through the dialog, and clear the one-time link it hands back.
 *
 * The invite used to end on "Add to workspace" and close. Ain sends no email,
 * so it now mints a one-time invitation link and shows it in a second dialog
 * that will not dismiss until the operator says they have copied it — the
 * token is stored only as a hash and no route reads it back, so this is the
 * one moment it exists. Every test that seats somebody walks through both,
 * which is why the walk lives here rather than in four copies.
 */
const inviteTeammate = async (
  page: Page,
  email: string,
  opts: { name?: string; title?: string; role?: string } = {},
) => {
  await page.getByRole('button', { name: 'Invite a teammate' }).click();
  await dialog(page).getByLabel('Work email').fill(email);
  await dialog(page).getByLabel('Full name').fill(opts.name ?? 'E2E Fixture');
  if (opts.title) await dialog(page).getByLabel('Job title').fill(opts.title);
  if (opts.role) await dialog(page).getByRole('radio', { name: new RegExp(`^${opts.role}\\b`) }).check();
  await dialog(page).getByRole('button', { name: 'Invite and show me the link' }).click();

  const link = dialog(page);
  await expect(link).toContainText('invitation is ready', { timeout: 15_000 });
  // The link cannot be dismissed until it has been acknowledged — that is the
  // point of it, so the acknowledgement is part of seating someone.
  await expect(link.getByRole('button', { name: 'Copy it first' })).toBeDisabled();
  await link.getByRole('checkbox', { name: /I have copied the link/ }).check();
  await link.getByRole('button', { name: 'Done' }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 });
};

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

  await inviteTeammate(page, email, { title: 'Commissioning Engineer', role: 'analyst' });

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

  // This seat never opened its link, so taking it away is a cancellation, not
  // a removal: there are no sessions to end and no keys to revoke, and the
  // menu, the dialog and the trail all say the smaller thing. (Typing the
  // address back is what the *destructive* half asks for, and the owner test
  // below holds that.)
  expect(promoted.status, 'the seat is still waiting on its invitation').toBe('invited');
  await rowMenu(page, email);
  await expect(page.getByRole('menuitem', { name: 'Remove from workspace…' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Cancel the invitation…' }).click();
  const cancel = dialog(page);
  await expect(cancel).toContainText('has not accepted yet');
  await expect(cancel).toContainText('no sessions to end and no API keys to revoke');
  await expect(cancel.getByRole('textbox')).toHaveCount(0);
  await cancel.getByRole('button', { name: 'Cancel the invitation' }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 });

  const users = (await json(page, '/v1/users')).data;
  expect(users.some((row: any) => row.email === email)).toBe(false); // eslint-disable-line @typescript-eslint/no-explicit-any

  // And the trail records it as what it was.
  const trail = await json(page, '/v1/audit-log?limit=200');
  const entry = trail.data.find((row: any) => row.target_id === seated.id); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(entry?.action, 'the trail calls a cancelled invitation what it is').toBe('user.invitation_cancelled');
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

  // The row says when it was created and by whom — the minter is read off the
  // audit entry the mint wrote, since the key itself carries no created_by.
  const mintedRow = page.locator('tr').filter({ hasText: name }).first();
  await expect(mintedRow.getByTestId('key-minter')).toContainText('by Dana Whitfield', { timeout: 15_000 });
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
  // `.first()` is the header's button: an empty register draws a second one in
  // its empty state, and whether the register is empty depends on what the
  // tests before this one left behind.
  const register = page.getByRole('button', { name: 'Register a rate' }).first();
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

  const answers: { previous: number; jobs_run: number; jobs_failed: number }[] = [];
  page.on('response', async (res) => {
    if (res.url().includes('/v1/time/advance') && res.request().method() === 'POST') {
      try { answers.push(await res.json()); } catch { /* not JSON */ }
    }
  });

  try {
    await page.getByRole('button', { name: /A billing cycle/ }).click();

    await expect.poll(async () => (await json(page, '/v1/me')).clock.now, { timeout: 60_000 })
      .toBeGreaterThan(before.clock.now + 20 * 24 * 3600 * 1000);
    await expect.poll(() => answers.length).toBe(1);
    const move = answers[0];

    // What the server said it ran is what the screen says it ran. On a fresh
    // workspace a month of billing comes due; on one that has already been
    // jumped through this month, nothing does — and the row must say *that*,
    // not borrow the count of the move that did run it.
    const trail = await json(page, '/v1/audit-log?limit=500');
    const entry = trail.data.find((row: any) => row.action === 'time.advanced' && row.before?.now === move.previous); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(entry, 'the move is on the audit trail with before.now = previous').toBeTruthy();

    await expect(page.getByText('What ran when it moved')).toBeVisible();
    const row = page.locator('.st-row').filter({ hasText: entry.request_id }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText('moved by Dana Whitfield');
    // Grouped, the way every other number on the surface is: a month of a busy
    // workspace runs 1,030 jobs and the badge said so while this line asked for
    // "1030 jobs".
    const grouped = new Intl.NumberFormat(before.org.locale).format(move.jobs_run);
    await expect(row.getByTestId('move-count')).toHaveText(`${grouped} ${move.jobs_run === 1 ? 'job' : 'jobs'}`);

    if (move.jobs_run > 0) {
      // Work actually ran, and it ran *inside the window the jump opened* — not
      // simply "there are completed jobs", which was already true. Counting rows
      // would not have shown it either: `core.cleanup` runs during the jump and
      // deletes completed jobs older than seven workspace days, so the total can
      // come out flat while a month of billing has just been executed.
      const done = (await json(page, '/v1/jobs?status=done&limit=200')).data;
      const ranInWindow = done.filter((job: any) => job.updated > before.clock.now); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(ranInWindow.length, 'jobs completed inside the jump').toBeGreaterThan(0);

      await row.getByRole('button', { name: 'What ran' }).click();
      await expect(row.locator('.st-diffrow').first()).toBeVisible();
    } else {
      // Nothing to open: the button says so by being disabled rather than
      // offering a list it would have to invent.
      await expect(row.getByRole('button', { name: 'What ran' })).toBeDisabled();
    }
  } finally {
    // Returning to now confirms first, and then actually returns — even when an
    // assertion above failed, so a broken run does not leave the clock ahead
    // for every test after it.
    await page.goto('/settings/time', { waitUntil: 'networkidle' });
    const back = page.getByRole('button', { name: 'Return to now' });
    if (await back.isEnabled()) {
      await back.click();
      await page.getByRole('dialog').getByRole('button', { name: 'Return to now' }).click();
      await expect.poll(async () => Math.abs((await json(page, '/v1/me')).clock.offset_ms), { timeout: 60_000 })
        .toBeLessThan(60_000);
    }
  }
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

  // The card says the order the rows are actually in: pending work soonest first.
  await expect(page.getByText('soonest first')).toBeVisible();
  await expect(page.getByText('furthest ahead first')).toHaveCount(0);

  // Every status the route serves is a tab, and each one reads its own page.
  const done = await json(page, '/v1/jobs?status=done&limit=200');
  await page.getByRole('tab', { name: /Done/ }).click();
  // Counting `tbody tr` said 32 against a true 200: the table virtualises above
  // 80 rows, so the DOM holds one screenful and two `aria-hidden` spacers. What
  // the screen believes it is showing is `aria-rowcount` on the table itself,
  // and the drawn rows are a window onto it.
  const grid = page.locator('table[aria-rowcount]').first();
  await expect(grid).toHaveAttribute('aria-rowcount', String(Math.min(done.data.length, 200)), { timeout: 15_000 });
  const drawn = await page.locator('tbody tr[data-index]').count();
  expect(drawn, 'the table drew no rows at all').toBeGreaterThan(0);
  expect(drawn, 'the table drew more rows than it says it has').toBeLessThanOrEqual(Math.min(done.data.length, 200));

  // A completed job carries its payload — the argument the handler was given.
  await page.locator('tbody tr[data-index]').first().click();
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

  // The workspace form is filled in and read-only, and says why. A role that
  // cannot PATCH /v1/org is shown no Save button — not a disabled one.
  await expect(page.getByText('You can read these, not change them')).toBeVisible();
  await expect(page.getByLabel('Workspace name')).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Save|^Saved/ })).toHaveCount(0);

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

/* =================== the time machine's history, honestly ================== */

/**
 * The shape that produced the fabricated counts: a day-jump, a return to real
 * time, a second day-jump over the same span. The second move ran a different
 * number of jobs from the first — usually none, since the first already ran
 * everything due — and its row has to say what the server said, not what the
 * first move did.
 */
test('each move in the time machine history reads the count the server answered for it', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/time', 'Time machine');
  const before = await json(page, '/v1/me');
  test.skip(before.clock.kind !== 'virtual', 'this build runs on the real clock');

  const answers: { previous: number; jobs_run: number }[] = [];
  page.on('response', async (res) => {
    if (res.url().includes('/v1/time/advance') && res.request().method() === 'POST') {
      try { answers.push(await res.json()); } catch { /* not JSON */ }
    }
  });

  const jumpADay = async () => {
    const seen = answers.length;
    await page.getByRole('button', { name: /^A day/ }).click();
    await expect.poll(() => answers.length, { timeout: 60_000 }).toBe(seen + 1);
    await expect(page.getByText(/Workspace time is now/).first()).toBeVisible({ timeout: 20_000 });
  };
  const returnToNow = async () => {
    await page.getByRole('button', { name: 'Return to now' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Return to now' }).click();
    await expect.poll(async () => Math.abs((await json(page, '/v1/me')).clock.offset_ms), { timeout: 60_000 }).toBeLessThan(60_000);
  };

  await jumpADay();
  await returnToNow();
  await jumpADay();
  const [first, second] = answers.slice(-2);

  // Every row in the history that describes one of these two moves carries
  // exactly the count the server answered for it — the second is not credited
  // with what the first ran, and neither is credited with the sum.
  await page.getByRole('button', { name: 'Refresh' }).click();
  const rows = page.locator('.ain-card').filter({ hasText: 'What ran when it moved' }).locator('.st-row');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });

  const trail = await json(page, '/v1/audit-log?limit=500');
  const rowFor = (answer: { previous: number }) => {
    const entry = trail.data.find((row: any) => row.action === 'time.advanced' && row.before?.now === answer.previous); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(entry, 'the move is on the audit trail with before.now = previous').toBeTruthy();
    return rows.filter({ hasText: entry.request_id });
  };
  // The count badge is the one whose text ends in "job" or "jobs" — the same
  // element before and after this fix, so the comparison is against the number.
  const badge = (answer: { previous: number }) => rowFor(answer).locator('.ain-badge').filter({ hasText: /\bjobs?$/ });
  // Grouped through the workspace's locale, like every other number here: a
  // four-figure move reads "1,030 jobs" on the badge.
  const locale = (await json(page, '/v1/me')).org.locale as string;
  const said = (answer: { jobs_run: number }) =>
    `${new Intl.NumberFormat(locale).format(answer.jobs_run)} ${answer.jobs_run === 1 ? 'job' : 'jobs'}`;
  await expect(badge(second)).toHaveText(said(second));
  await expect(badge(first)).toHaveText(said(first));
  await expect(rowFor(second)).toHaveAttribute('data-tally', 'recorded');

  // The presets say what they will run before they are pressed, from the queue.
  const pending = (await json(page, '/v1/jobs?status=pending&limit=200')).data;
  const now = (await json(page, '/v1/me')).clock.now;
  const dueInADay = pending.filter((job: any) => job.run_at <= now + 24 * 3600 * 1000).length; // eslint-disable-line @typescript-eslint/no-explicit-any
  // A floor, not a promise: the replay drains the queue, asks it again, and
  // runs whatever the last batch queued — so a day-jump that this line called
  // "18 jobs run on the way" recorded 42 in the history three lines below.
  await expect(page.getByTestId('due-day')).toHaveText(dueInADay === 0
    ? 'Nothing is due — the clock moves, no job runs'
    : new RegExp(`^At least ${dueInADay} jobs? runs? on the way$`));

  await returnToNow();
});

/* ===================== ids that open the record they name ================= */

test('an audit entry links its target to the screen that shows it, and the screen answers with that record', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/audit', 'Audit log');

  const trail = await json(page, '/v1/audit-log?limit=500');
  const roleChange = trail.data.find((row: any) => row.action === 'user.role_changed'); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(roleChange, 'a role change is on the trail from the team test').toBeTruthy();
  const revoked = trail.data.find((row: any) => row.action === 'api_key.revoked'); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(revoked, 'a key revocation is on the trail from the keys test').toBeTruthy();
  const key = (await json(page, '/v1/api-keys')).data.find((row: any) => row.id === revoked.target_id); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(key, 'the revoked key is still listed').toBeTruthy();

  const search = page.getByPlaceholder('Search summaries, targets and request ids');

  // The search reaches the request id even though its column is hidden, so
  // the one row left is the entry. The teammate target is a link to the
  // roster, labelled in English.
  const body = page.locator('tbody tr');
  await search.fill(roleChange.request_id);
  await expect(body).toHaveCount(1, { timeout: 15_000 });
  const roleRow = body.first();
  await expect(roleRow.getByRole('link')).toHaveAttribute('href', `/settings/team?member=${roleChange.target_id}`);
  await expect(roleRow).toContainText('Teammate');

  // The key target is named after the key, not its id — and never "Api key".
  await search.fill(revoked.request_id);
  await expect(body).toHaveCount(1, { timeout: 15_000 });
  const keyRow = body.first();
  const link = keyRow.getByRole('link', { name: key.name });
  await expect(link).toHaveAttribute('href', `/settings/api-keys?key=${key.id}`);
  await expect(keyRow).toContainText('API key');
  await expect(keyRow).not.toContainText('Api key');

  // The drawer links it too.
  await keyRow.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('link', { name: key.name })).toHaveAttribute('href', `/settings/api-keys?key=${key.id}`);
  await page.keyboard.press('Escape');

  // A clock move's summary is a workspace date, not an ISO string.
  await search.fill('time.advanced');
  const move = page.locator('tr').filter({ hasText: 'time.advanced' }).first();
  await expect(move).toBeVisible({ timeout: 15_000 });
  await expect(move).not.toContainText(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  await expect(move).toContainText('Advanced the workspace clock to');

  // Following the key link lands on the keys screen with that key on top —
  // revoked keys shown, because this one is.
  await search.fill(revoked.request_id);
  await link.click();
  await expect(page).toHaveURL(/\/settings\/api-keys$/);
  await expect(page.locator('tbody tr')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('tbody')).toContainText(key.name);
  await expect(page.locator('tbody')).toContainText('Revoked');

  // And the roster answers a teammate deep link with that one seat.
  await page.goto('/settings/team?member=usr_seed06', { waitUntil: 'networkidle' });
  await expect(page.locator('tbody tr')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('tbody')).toContainText('nina@northwind.io');
  await expect(page).toHaveURL(/\/settings\/team$/);
});

test('an event links the object it is about, and a feature deep link opens the account it names', async ({ page }) => {
  await signIn(page);

  const events = (await json(page, '/v1/events?type=subscription.created&limit=5')).data;
  const event = events.find((row: any) => row.object_id); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(event, 'the seed emitted a subscription event').toBeTruthy();

  await openSettings(page, '/settings/events', 'Events');
  await page.getByLabel('Every event about one object — paste an id').fill(event.object_id);
  const item = page.locator('.st-event').filter({ hasText: 'subscription.created' }).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  const payload = page.locator('.ain-card').filter({ hasText: 'Event id' });
  const link = payload.getByRole('link', { name: event.object_id });
  await expect(link).toHaveAttribute('href', `/billing/subscriptions/${event.object_id}`);
  await expect(payload).toContainText('Subscription ·');

  // The URL the features screen writes for an account is honoured on load.
  const customer = (await json(page, '/v1/customers?limit=1')).data[0];
  await page.goto(`/settings/features?customer=${customer.id}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('tab', { name: 'What an account holds' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.st-body')).toContainText(customer.name, { timeout: 15_000 });
  // …and leaving the tab drops the parameter, so the address names the screen.
  await page.getByRole('tab', { name: 'The catalogue' }).click();
  await expect(page).toHaveURL(/\/settings\/features$/);
});

test('a readonly teammate who runs a Create command is told why nothing opens', async ({ page }) => {
  await signInAs(page, 'nina@northwind.io');
  await page.waitForSelector('.ain-stat');
  await page.goto('/settings/api-keys?new=1', { waitUntil: 'networkidle' });
  await expect(page.getByText('Creating an API key needs the admin role').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings\/api-keys$/);

  await page.goto('/settings/team?invite=1', { waitUntil: 'networkidle' });
  await expect(page.getByText('Inviting a teammate needs the admin role').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

/* ==================== what the critic found, fixed and held =============== */

test('Enter on a row’s “Row actions” opens its menu, and only its menu', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/team', 'Team');

  // The grid's own Enter handler used to fire the row action — the first
  // teammate's change-role dialog — and swallow the button's click, so the menu
  // never appeared. Enter and Space must do the same thing here.
  const first = page.locator('tbody tr').first().getByRole('button', { name: 'Row actions' });
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Change role…' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // The sibling screen with a row menu behaves the same way.
  await openSettings(page, '/settings/tax', 'Tax');
  const rate = page.locator('tbody tr').first().getByRole('button', { name: 'Row actions' });
  await rate.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('the invitation says what the seat can and cannot do, and Enter in any field submits it', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/team', 'Team');

  const email = `e2e.enter.${stamp()}@northwind.io`;
  await page.getByRole('button', { name: 'Invite a teammate' }).click();

  // There *is* an invitation link now — `POST /v1/users` mints a one-time
  // token — so the dialog no longer says "no invitation link, no password
  // route". What it still may not do is promise an email nobody sends, or a
  // seat that works before the link is opened.
  await expect(dialog(page)).toContainText('a one-time invitation link is minted');
  await expect(dialog(page)).toContainText('Ain does not send email');
  await expect(dialog(page)).toContainText('until they open it and set a password');
  await expect(dialog(page)).not.toContainText('immediately');

  // Enter in the second field — not only the first — submits the form.
  await dialog(page).getByLabel('Work email').fill(email);
  await page.keyboard.press('Tab');
  await page.keyboard.type('E2E Enter Fixture');
  await page.keyboard.press('Enter');

  // Submitting hands over the link, once, behind an acknowledgement.
  const link = dialog(page);
  await expect(link).toContainText('invitation is ready', { timeout: 15_000 });
  await expect(link).toContainText('This is the only time this link exists outside your clipboard.');
  await link.getByRole('checkbox', { name: /I have copied the link/ }).check();
  await link.getByRole('button', { name: 'Done' }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 });

  const seated = (await json(page, '/v1/users')).data.find((row: any) => row.email === email); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(seated, 'Enter submitted the invitation').toBeTruthy();
  expect(seated.status, 'the seat waits for the link to be opened').toBe('invited');

  await page.request.delete(`/api/v1/users/${seated.id}`);
});

test('a list read that fails renders its tiles as a dash, never as a zero', async ({ page }) => {
  await signIn(page);
  const refuse = (message: string) => (route: import('@playwright/test').Route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: { type: 'api_error', code: 'internal', message, request_id: 'req_e2e_forced' } }),
  });
  const tile = (label: string) => page.locator('.ain-stat').filter({ has: page.locator('.ain-stat__label', { hasText: new RegExp(`^${label}$`) }) });

  // Tax: the register did not answer, so the register's tiles say so — while
  // the tile whose read did answer still counts.
  await page.route('**/api/v1/tax_rates*', refuse('The register could not be read.'));
  await openSettings(page, '/settings/tax', 'Tax');
  await expect(tile('Active registrations').locator('.ain-stat__value')).toHaveText('—');
  await expect(tile('Active registrations')).toContainText('not a count of zero');
  await expect(tile('Active registrations')).toContainText('GET /v1/tax_rates');
  await expect(tile('Reverse charged').locator('.ain-stat__value')).toHaveText('—');
  await expect(tile('Customer registrations').locator('.ain-stat__value')).not.toHaveText('—');
  await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
  await page.unroute('**/api/v1/tax_rates*');

  // Jobs: every tile reads its own status page, and none of them is a zero.
  await page.route('**/api/v1/jobs*', refuse('The queue could not be read.'));
  await openSettings(page, '/settings/jobs', 'Jobs');
  for (const label of ['Waiting', 'Due right now', 'Failed', 'Completed']) {
    await expect(tile(label).locator('.ain-stat__value')).toHaveText('—');
    await expect(tile(label)).toContainText('not a count of zero');
  }
  await page.unroute('**/api/v1/jobs*');

  // Features: the catalogue did not answer; the overview did.
  await page.route('**/api/v1/features*', refuse('Features could not be read.'));
  await openSettings(page, '/settings/features', 'Features & entitlements');
  await expect(tile('Features defined').locator('.ain-stat__value')).toHaveText('—');
  await expect(tile('Features defined')).toContainText('GET /v1/features');
  await expect(tile('Live overrides').locator('.ain-stat__value')).not.toHaveText('—');
  await page.unroute('**/api/v1/features*');
});

test('the roster lists the owner first and the readers last', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings/team', 'Team');

  const roster = (await json(page, '/v1/users')).data;
  await expect(page.locator('tbody tr')).toHaveCount(roster.length, { timeout: 15_000 });

  // Sorted on the role's name the owner came last — admin, analyst, member,
  // member, member, owner. The default order is the ladder.
  //
  // Read by the column's header rather than by its position: the roster grew a
  // "Seat" column between the teammate and the job title, and the third cell —
  // which used to be the role — became "VP of Revenue Operations".
  const headers = (await page.locator('thead th').allInnerTexts()).map((text) => text.trim());
  const roleColumn = headers.indexOf('Role') + 1;
  expect(roleColumn, `the roster has no Role column: ${JSON.stringify(headers)}`).toBeGreaterThan(0);
  const rank: Record<string, number> = { owner: 0, admin: 1, member: 2, analyst: 3, readonly: 4 };
  const roles = await page.locator(`tbody tr td:nth-child(${roleColumn})`).allInnerTexts();
  expect(roles[0].trim()).toBe('owner');
  for (let i = 1; i < roles.length; i++) {
    expect(rank[roles[i].trim()], `${roles[i]} follows ${roles[i - 1]}`).toBeGreaterThanOrEqual(rank[roles[i - 1].trim()]);
  }
});

test('a domain that is not a hostname is refused under the field, and nothing is written', async ({ page }) => {
  await signIn(page);
  await openSettings(page, '/settings', 'Workspace');
  const before = await json(page, '/v1/me');

  // PATCH /v1/org would store this and the shell header would read it back.
  await page.getByLabel('Primary domain').fill('not a domain!!');
  await expect(page.getByText(/^A hostname, e\.g\. northwind\.io/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Save \d+ change/ })).toBeDisabled();
  expect((await json(page, '/v1/me')).org.domain).toBe(before.org.domain);

  // A real hostname lifts the refusal.
  await page.getByLabel('Primary domain').fill('billing.northwind.io');
  await expect(page.getByText(/^A hostname, e\.g\. northwind\.io/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Save \d+ change/ })).toBeEnabled();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
});

test('the trail names a removed teammate, and their link lands on a roster that says they are gone', async ({ page, request }) => {
  await signIn(page);

  // Seat, accept and remove a teammate through the API, so the trail holds the
  // trio. The acceptance is what makes this a *removal*: deleting a seat that
  // never opened its invitation is a cancellation, logged as
  // `user.invitation_cancelled` with "Cancelled the invitation to …", and this
  // test is about the other one. The link is redeemed on the `request` context
  // rather than the page's, because `POST /v1/auth/accept` answers with a
  // session cookie and that would sign the browser in as the new teammate.
  const email = `e2e.gone.${stamp()}@northwind.io`;
  const created: any = await postJson(page.request, '/api/v1/users', { email, name: 'E2E Departed', role: 'admin' }); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(created.id, 'the seat was created').toBeTruthy();
  expect(created.invitation?.token, 'the seat came with a one-time invitation token').toBeTruthy();
  expect((await past429(() => request.post('/api/v1/auth/accept', {
    data: { token: created.invitation.token, password: 'demo1234' },
  }))).status()).toBe(200);
  // Something audited, done by them, before they go: this is the row an
  // auditor comes back to after the seat is gone.
  const keyName = `E2E departed key ${stamp()}`;
  const theirKey: any = await postJson(request, '/api/v1/api-keys', { name: keyName }); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(theirKey.id, 'they minted a key while they were here').toBeTruthy();
  expect((await past429(() => page.request.delete(`/api/v1/users/${created.id}`))).status()).toBe(204);

  // The width the critic read "Workspace setti…" at.
  await page.setViewportSize({ width: 1440, height: 960 });
  await openSettings(page, '/settings/audit', 'Audit log');
  await page.getByPlaceholder('Search summaries, targets and request ids').fill(created.id);
  const removed = page.locator('tbody tr').filter({ hasText: 'user.removed' }).first();
  await expect(removed).toBeVisible({ timeout: 15_000 });

  // Named off the invitation the trail itself recorded, and marked as removed —
  // not a bare usr_… with a link to a roster search that finds nobody.
  await expect(removed).toContainText(email);
  await expect(removed).toContainText('removed');

  // The summary is why the row exists: it gets the flexible width, so it is the
  // widest cell in the row and reads in full at this width.
  const summary = removed.getByTestId('audit-summary');
  await expect(summary).toContainText('Removed from workspace');
  const widths = await removed.locator('td').evaluateAll((cells) => cells.map((cell) => cell.clientWidth));
  const summaryWidth = await summary.evaluate((el) => el.closest('td')!.clientWidth);
  expect(summaryWidth, `the summary cell (${summaryWidth}px) is the widest of ${widths.join(', ')}`).toBe(Math.max(...widths));
  expect(await summary.evaluate((el) => el.scrollWidth > el.clientWidth + 1), 'the summary is not truncated').toBe(false);

  // And the change *they* made still says who made it. The roster no longer
  // holds them, so this row read `usr_…` — on the screen whose whole purpose is
  // saying who did what, for exactly the person an auditor is asking about.
  await page.getByPlaceholder('Search summaries, targets and request ids').fill(keyName);
  const minted = page.locator('tbody tr').filter({ hasText: 'api_key.created' }).first();
  await expect(minted).toBeVisible({ timeout: 15_000 });
  await expect(minted).toContainText(email);
  await expect(minted).not.toContainText(created.id);

  await page.getByPlaceholder('Search summaries, targets and request ids').fill(created.id);
  await expect(removed).toBeVisible({ timeout: 15_000 });
  await removed.getByRole('link', { name: email }).click();
  await expect(page).toHaveURL(/\/settings\/team$/);
  await expect(page.getByText('That teammate is no longer on the roster')).toBeVisible({ timeout: 15_000 });
  // The roster is still the whole roster, not an empty search.
  await expect(page.locator('tbody tr')).toHaveCount((await json(page, '/v1/users')).data.length);

  // And the way back lands on the trail with that id already searched.
  await page.getByRole('button', { name: 'What the trail says' }).click();
  await expect(page).toHaveURL(/\/settings\/audit$/);
  await expect(page.getByPlaceholder('Search summaries, targets and request ids')).toHaveValue(created.id);
  await expect(page.locator('tbody tr').first()).toContainText(email, { timeout: 15_000 });
});

test('the workspace facts read the clock as it stands, and the stream does not credit the platform with a person’s change', async ({ page }) => {
  await signIn(page);
  const me = await json(page, '/v1/me');
  await openSettings(page, '/settings', 'Workspace');

  // "Virtual" said what kind of clock it was; the fact now says what it reads.
  const clock = page.locator('.ain-kv').filter({ hasText: 'Clock' });
  await expect(clock).not.toContainText('Virtual');
  if (Math.abs(me.clock.offset_ms) <= 60_000) await expect(clock).toContainText('In step with real time');
  else await expect(clock).toContainText(/Simulated.*(ahead of|behind) real time/);

  // `user.invited` used to be emitted with `actor_type: system`, no actor and
  // no request id, for a change only a signed-in admin can make; the stream
  // drew that as "Unattributed" because "The platform did it" was a lie it
  // could not support. The teammate routes carry the actor now, so the honest
  // reading is the person's name — and never the platform's.
  const email = `e2e.actor.${stamp()}@northwind.io`;
  const seat = await (await page.request.post('/api/v1/users', { data: { email, name: 'E2E Actor Fixture', role: 'analyst' } })).json();
  expect(seat.id, 'the seat was created').toBeTruthy();
  await page.request.delete(`/api/v1/users/${seat.id}`);

  await openSettings(page, '/settings/events', 'Events');
  await page.getByLabel('Every event about one object — paste an id').fill(seat.id);
  const item = page.locator('.st-event').filter({ hasText: 'user.invited' }).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await expect(item).not.toContainText('The platform');
  await expect(item).toContainText(me.user.name);
  await item.click();
  const detail = page.locator('.ain-card').filter({ hasText: 'Event id' });
  await expect(detail).toContainText(me.user.name);
  await expect(detail).not.toContainText('The platform');
});
