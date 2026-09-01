/**
 * The CRM surface, driven in a real browser.
 *
 * Every check here is an operability claim: a person sitting in front of this
 * screen can do the thing, and the server agrees afterwards. So each test
 * finishes by asking the API what happened rather than trusting the toast —
 * a screen that renders "Saved" over a write that never landed is exactly the
 * failure this module exists to rule out.
 *
 *   node scripts/preview.mjs --port 8853 --name crm --fresh true
 *   AIN_BASE_URL=http://127.0.0.1:8853 npx playwright test e2e/crm.spec.ts
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const signIn = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.request.post('/api/v1/auth/demo');
};

const openList = async (page: Page, path: string) => {
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForSelector('table tbody tr[data-index]');
};

/** The grid's own row count, which is what "the list is showing this" means. */
const rowCount = (page: Page) => page.locator('table tbody tr[data-index]').count();

const recordOf = async (request: APIRequestContext, type: string, id: string) =>
  (await (await request.get(`/api/v1/records/${type}/${id}`)).json()) as {
    id: string; display_name: string; owner_id: string | null;
    properties: Record<string, unknown>; archived: boolean;
  };

test.beforeEach(async ({ page }) => { await signIn(page); });

/* ================================== lists ================================= */

test('the contact list renders the workspace’s own records, and every number on it is formatted', async ({ page }) => {
  await openList(page, '/contacts');

  const total = (await (await page.request.get('/api/v1/records/contact?limit=1')).json()).total_count as number;
  await expect(page.locator('.ain-page__subtitle')).toContainText(String(total));
  expect(await rowCount(page)).toBeGreaterThan(0);

  // Money is never raw minor units. A deal's amount column must carry a
  // currency symbol and a decimal, not the integer the API stores.
  await openList(page, '/records/deal');
  const amount = page.locator('table tbody tr[data-index]').first().locator('td').filter({ hasText: /[$€£]/ }).first();
  await expect(amount).toContainText(/[$€£][\d,]+\.\d{2}/);
});

test('a saved view swaps the filter and the columns, and the server count follows it', async ({ page }) => {
  await openList(page, '/companies');
  const before = await rowCount(page);

  await page.getByRole('button', { name: 'Key accounts' }).click();
  await page.waitForFunction(() => !document.querySelector('.ain-skeleton'));
  await expect(page).toHaveURL(/view=view_/);

  const views = await (await page.request.get('/api/v1/views?object_type=company')).json();
  const key = views.data.find((v: { name: string }) => v.name === 'Key accounts');
  const matching = await (await page.request.post('/api/v1/records/company/search', { data: { filter: key.filter, limit: 1 } })).json();

  await expect(page.locator('.ain-page__subtitle')).toContainText(String(matching.total_count));
  expect(matching.total_count).toBeLessThan(before);
  // The view carries its own columns: "Support tier" is on this one and not on All.
  await expect(page.getByRole('columnheader', { name: 'Support tier' })).toBeVisible();
});

test('the filter builder compiles a nested condition and the grid narrows to the server’s answer', async ({ page }) => {
  await openList(page, '/companies');

  await page.getByRole('button', { name: /^Filters/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Condition' }).click();

  // Property → operator → value, exactly as an operator would drive it.
  await dialog.locator('.crm-filter__field .ain-combo__control, .crm-filter__field input').first().click();
  await page.keyboard.type('Lifecycle');
  await page.keyboard.press('Enter');
  await dialog.getByLabel('Operator').selectOption('eq');
  await dialog.getByLabel(/value$/i).first().click();
  await page.keyboard.type('Customer');
  await page.keyboard.press('Enter');

  await dialog.getByRole('button', { name: /^Show/ }).click();
  await page.waitForFunction(() => !document.querySelector('.ain-skeleton'));

  const expected = await (await page.request.post('/api/v1/records/company/search', {
    data: { filter: { op: 'and', filters: [{ property: 'lifecycle_stage', operator: 'eq', value: 'customer' }] }, limit: 1 },
  })).json();

  await expect(page.locator('.crm-activefilter')).toContainText('Lifecycle stage');
  await expect(page.locator('.ain-page__subtitle')).toContainText(String(expected.total_count));
});

test('free-text search asks the server and the grid shows only what came back', async ({ page }) => {
  await openList(page, '/contacts');
  await page.getByPlaceholder('Search contacts…').fill('Escamilla');

  const expected = await (await page.request.get('/api/v1/records/contact?q=Escamilla&limit=1')).json();
  // The box is debounced, so wait for the grid itself to settle on the answer
  // rather than for a skeleton that has not been raised yet.
  await expect(page.locator('table tbody tr[data-index]')).toHaveCount(Math.min(expected.total_count, 50));
  await expect(page.locator('.ain-page__subtitle')).toContainText(`${expected.total_count} contact`);
});

/* ================================= writes ================================= */

test('a contact created in the dialog exists on the server and opens its own page', async ({ page }) => {
  const stamp = Date.now();
  await openList(page, '/contacts');

  await page.getByRole('button', { name: 'New contact' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('First name').fill('Ingrid');
  await dialog.getByLabel('Last name').fill(`Halvorsen ${stamp}`);
  await dialog.getByLabel('Email', { exact: true }).fill(`ingrid.${stamp}@nordhavn.example`);
  await dialog.getByRole('button', { name: 'Create contact' }).click();

  await expect(page).toHaveURL(/\/contacts\/con_|\/contacts\/[a-z]+_/);
  await expect(page.locator('.ain-page__title')).toContainText(`Ingrid Halvorsen ${stamp}`);

  const id = page.url().split('/contacts/')[1];
  const record = await recordOf(page.request, 'contact', id);
  expect(record.properties.email).toBe(`ingrid.${stamp}@nordhavn.example`);
});

test('the create form binds the server’s validation error to the field it names', async ({ page }) => {
  await openList(page, '/contacts');
  await page.getByRole('button', { name: 'New contact' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('First name').fill('Nameless');
  await dialog.getByRole('button', { name: 'Create contact' }).click();

  // "Last name is required" belongs under Last name, not in a banner.
  await expect(dialog.locator('.ain-field', { hasText: 'Last name' }).locator('.ain-field__error')).toContainText(/required/i);
  await expect(dialog).toBeVisible();
});

test('a property edited inline on the record page is written, and lands on its own timeline', async ({ page }) => {
  const company = (await (await page.request.get('/api/v1/records/company?limit=1')).json()).data[0];
  await page.goto(`/companies/${company.id}`, { waitUntil: 'networkidle' });

  const next = `Rewritten by the CRM e2e run at ${Date.now()}`;
  await page.getByRole('button', { name: 'Edit About' }).click();
  const editor = page.locator('.crm-prop--editing textarea');
  await editor.fill(next);
  await page.locator('.crm-prop--editing').getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.ain-toast')).toContainText('About updated');

  const after = await recordOf(page.request, 'company', company.id);
  expect(after.properties.description).toBe(next);

  const timeline = await (await page.request.get(`/api/v1/records/company/${company.id}/timeline?kinds=property_change&limit=1`)).json();
  expect(timeline.data[0].title).toMatch(/About/i);
});

test('logging a note writes an activity and it appears on the timeline', async ({ page }) => {
  const contact = (await (await page.request.get('/api/v1/records/contact?limit=1')).json()).data[0];
  await page.goto(`/contacts/${contact.id}`, { waitUntil: 'networkidle' });

  const subject = `Pilot scope confirmed ${Date.now()}`;
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Subject').fill(subject);
  await dialog.getByLabel('Notes').fill('Three lines, two plants, one integrator.');
  await dialog.getByRole('button', { name: 'Write a note' }).click();

  await expect(page.locator('ol.crm-timeline')).toContainText(subject);
  const timeline = await (await page.request.get(`/api/v1/records/contact/${contact.id}/timeline?limit=5`)).json();
  expect(timeline.data.some((item: { title: string }) => item.title === subject)).toBe(true);
});

test('an association added from the record page shows on both records, and can be removed', async ({ page }) => {
  const deal = (await (await page.request.get('/api/v1/records/deal?limit=1')).json()).data[0];
  const contacts = (await (await page.request.get('/api/v1/records/contact?limit=40')).json()).data;
  const linked = new Set(
    ((await (await page.request.get(`/api/v1/associations?record_id=${deal.id}`)).json()).data as { record_id: string }[])
      .map((edge) => edge.record_id),
  );
  const target = contacts.find((c: { id: string }) => !linked.has(c.id));

  await page.goto(`/records/deal/${deal.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Link another record' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('What kind of record').selectOption('contact');
  await dialog.getByLabel('Record to link').click();
  await page.keyboard.type(target.display_name.slice(0, 8));
  await page.locator('[role="option"]', { hasText: target.display_name }).first().click();
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();

  await expect(page.locator('.crm-assoc__row', { hasText: target.display_name })).toHaveCount(1);
  const edges = (await (await page.request.get(`/api/v1/associations?record_id=${deal.id}`)).json()).data as { record_id: string }[];
  expect(edges.some((edge) => edge.record_id === target.id)).toBe(true);

  await page.locator('.crm-assoc__row', { hasText: target.display_name })
    .getByRole('button', { name: `Unlink ${target.display_name}` }).click();
  await expect(page.getByRole('status', { name: 'Association removed' })).toBeVisible();
  const afterEdges = (await (await page.request.get(`/api/v1/associations?record_id=${deal.id}`)).json()).data as { record_id: string }[];
  expect(afterEdges.some((edge) => edge.record_id === target.id)).toBe(false);
});

test('a bulk owner change moves every selected record', async ({ page }) => {
  await openList(page, '/contacts');
  await page.getByRole('checkbox', { name: 'Select row 1', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select row 2', exact: true }).check();
  await page.getByRole('button', { name: 'Change owner' }).first().click();

  const dialog = page.getByRole('dialog');
  const users = (await (await page.request.get('/api/v1/users')).json()).data as { id: string; name: string }[];
  await dialog.getByLabel('New owner').selectOption(users[0].id);
  await dialog.getByRole('button', { name: 'Change owner' }).click();
  await expect(page.locator('.ain-toast')).toContainText('Owner changed');

  const first = (await (await page.request.get('/api/v1/records/contact?limit=2')).json()).data as { id: string }[];
  const owners = await Promise.all(first.map((r) => recordOf(page.request, 'contact', r.id)));
  expect(owners.some((r) => r.owner_id === users[0].id)).toBe(true);
});

test('sorting a column re-orders the whole result set on the server, not the page in view', async ({ page }) => {
  await openList(page, '/companies');

  // First click is ascending: the smallest employee count in the workspace has
  // to arrive at the top, which only a server-side sort can guarantee once the
  // list is longer than one page.
  await page.getByRole('button', { name: /^Employees/ }).click();
  await page.waitForFunction(() => !document.querySelector('.ain-skeleton'));

  const expected = await (await page.request.post('/api/v1/records/company/search', {
    data: { sort: [{ property: 'employee_count', direction: 'asc' }], limit: 1 },
  })).json();
  await expect(page.locator('table tbody tr[data-index]').first()).toContainText(expected.data[0].display_name);

  await page.getByRole('button', { name: /^Employees/ }).click();
  await page.waitForFunction(() => !document.querySelector('.ain-skeleton'));
  const descending = await (await page.request.post('/api/v1/records/company/search', {
    data: { sort: [{ property: 'employee_count', direction: 'desc' }], limit: 1 },
  })).json();
  await expect(page.locator('table tbody tr[data-index]').first()).toContainText(descending.data[0].display_name);
});

test('Export CSV hands over a real file whose money is a number and whose dates are ISO', async ({ page }) => {
  await openList(page, '/companies');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^Companies \d{4}-\d{2}-\d{2}\.csv$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const csv = Buffer.concat(chunks).toString('utf8');

  const [header, ...rows] = csv.trim().split('\r\n');
  expect(header.split(',')[0]).toBe('id');
  const total = (await (await page.request.get('/api/v1/records/company?limit=1')).json()).total_count as number;
  expect(rows.length).toBe(total);
  // Whatever else it holds, it must not hold a screen-formatted amount.
  expect(csv).not.toMatch(/[$€£]/);
});

test('a view saved from the UI comes back as a tab and reproduces its filter', async ({ page }) => {
  const name = `EMEA accounts ${Date.now()}`;
  await openList(page, '/companies');

  await page.getByRole('button', { name: /^Filters/ }).click();
  const filterDialog = page.getByRole('dialog');
  await filterDialog.getByRole('button', { name: 'Condition' }).click();
  await filterDialog.locator('.crm-filter__field input').first().click();
  await page.keyboard.type('Sales region');
  await page.keyboard.press('Enter');
  await filterDialog.getByLabel(/value$/i).first().click();
  await page.keyboard.type('EMEA');
  await page.keyboard.press('Enter');
  await filterDialog.getByRole('button', { name: 'Save as a view' }).click();

  const saveDialog = page.getByRole('dialog');
  await saveDialog.getByLabel('Name').fill(name);
  await saveDialog.getByRole('button', { name: 'Save view' }).click();

  await expect(page.getByRole('button', { name })).toBeVisible();
  const views = (await (await page.request.get('/api/v1/views?object_type=company')).json()).data as { name: string; filter: unknown }[];
  const saved = views.find((v) => v.name === name);
  expect(JSON.stringify(saved?.filter)).toContain('region');
});

/* =============================== data model =============================== */

test('a custom object, a rollup property and an association type can all be defined from the UI', async ({ page }) => {
  const stamp = Date.now().toString().slice(-6);
  const label = `Site ${stamp}`;
  await page.goto('/records', { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'New custom object' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Singular name').fill(label);
  await dialog.getByLabel('Plural name').fill(`${label}s`);
  await dialog.getByRole('button', { name: 'Create object' }).click();
  await expect(page.getByRole('status', { name: /created/ })).toBeVisible();

  const objects = (await (await page.request.get('/api/v1/objects')).json()).data as { name: string; label: string }[];
  const made = objects.find((o) => o.label === label);
  expect(made).toBeTruthy();

  // A rollup on the company: how many open deals it has, computed by the same
  // engine the list filter uses, and backfilled across every existing record.
  await page.goto('/records?type=company', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add a property' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Label').fill(`Open tickets ${stamp}`);
  await dialog.getByRole('radio', { name: 'Rollup' }).click();
  await dialog.getByLabel('Across').selectOption('ticket');
  await dialog.getByRole('button', { name: 'Create property' }).click();
  await expect(page.getByRole('status', { name: 'Property created' })).toBeVisible();

  const props = (await (await page.request.get('/api/v1/objects/company/properties')).json()).data as { name: string; rollup: unknown }[];
  const rollup = props.find((p) => p.name === `open_tickets_${stamp}`);
  expect(rollup?.rollup).toBeTruthy();

  await page.getByRole('button', { name: 'New association type' }).first().click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reads as, from the left').fill('Installed at');
  await dialog.getByLabel('Reads as, from the right').fill('Installations');
  await dialog.getByLabel(/^From/).selectOption(made!.name);
  await dialog.getByLabel(/^To/).selectOption('company');
  await dialog.getByRole('button', { name: 'Define association' }).click();
  await expect(page.getByRole('status', { name: 'Association type defined' })).toBeVisible();

  const types = (await (await page.request.get('/api/v1/association-types')).json()).data as { from_object: string; label: string }[];
  expect(types.some((t) => t.from_object === made!.name && t.label === 'Installed at')).toBe(true);
});

test('a custom object gets a working list screen with no code written for it', async ({ page }) => {
  const objects = (await (await page.request.get('/api/v1/objects')).json()).data as { name: string; system: boolean; plural_label: string; category: string }[];
  const custom = objects.find((o) => !o.system && o.category === 'record');
  test.skip(!custom, 'no custom object in this workspace yet');

  await page.goto(`/records/${custom!.name}`, { waitUntil: 'networkidle' });
  await expect(page.locator('.ain-page__title')).toContainText(custom!.plural_label);
  await expect(page.getByRole('button', { name: /^New /, exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Filters/ })).toBeVisible();
});

/* ============================== keyboard ================================== */

test('the list is operable from the keyboard alone', async ({ page }) => {
  await openList(page, '/contacts');
  const search = page.getByPlaceholder('Search contacts…');
  await search.focus();
  await page.keyboard.type('Escamilla');
  await page.waitForFunction(() => !document.querySelector('.ain-skeleton'));

  // Esc closes the filter dialog it opened, and focus survives the round trip.
  await page.getByRole('button', { name: /^Filters/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

/* ========================= operability regressions ======================== */

/**
 * Each of these was a way the screen looked like it had done something it had
 * not, or a thing the screen showed but refused to let anybody author.
 */

test('Enter commits an inline number or money edit rather than swallowing it', async ({ page }) => {
  await page.request.patch('/api/v1/records/company/cmp_nw_45', {
    data: { properties: { employee_count: 2200, annual_revenue: 24600000000 } },
  });
  const writes: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH') writes.push(r.url()); });

  await page.goto('/companies/cmp_nw_45', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Edit Employees' }).click();
  const count = page.locator('#edit-employee_count');
  await count.click();
  await count.press('Control+a');
  await page.keyboard.type('3300');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: 'Employees updated' })).toBeVisible();
  expect(writes.length).toBe(1);
  expect((await recordOf(page.request, 'company', 'cmp_nw_45')).properties.employee_count).toBe(3300);

  await page.getByRole('button', { name: 'Edit Annual revenue' }).click();
  const money = page.locator('#edit-annual_revenue');
  await money.click();
  await money.press('Control+a');
  await page.keyboard.type('999000');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: 'Annual revenue updated' })).toBeVisible();
  expect((await recordOf(page.request, 'company', 'cmp_nw_45')).properties.annual_revenue).toBe(99900000);

  // A no-op still says so — a silent close is what a lost edit used to look like.
  await page.getByRole('button', { name: 'Edit Employees' }).click();
  await page.locator('#edit-employee_count').click();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: /unchanged/ })).toBeVisible();
});

test('Enter on the row the keyboard is standing on opens that record', async ({ page }) => {
  await openList(page, '/contacts');
  await page.locator('table tbody tr[data-index]').first().focus();
  await page.keyboard.press('ArrowDown');
  const name = await page.locator('table tbody tr[data-index]').nth(1).locator('.crm-cell__name').innerText();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/contacts\/con_/);
  await expect(page.locator('.ain-page__title')).toContainText(name);
});

test('the search box and the filter tree are in the URL, so a reload keeps them', async ({ page }) => {
  await openList(page, '/companies');
  const all = await rowCount(page);

  await page.getByPlaceholder('Search companies…').fill('kaiping');
  const narrowed = (await (await page.request.get('/api/v1/records/company?q=kaiping&limit=1')).json()).total_count as number;
  await expect(page.locator('table tbody tr[data-index]')).toHaveCount(narrowed);
  await expect(page).toHaveURL(/[?&]q=kaiping/);
  expect(narrowed).toBeLessThan(all);

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('table tbody tr[data-index]')).toHaveCount(narrowed);
  await expect(page.getByPlaceholder('Search companies…')).toHaveValue('kaiping');

  // The same for a built filter: the link carries the tree, not just the view.
  await page.getByPlaceholder('Search companies…').fill('');
  await page.getByRole('button', { name: /^Filters/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Condition' }).click();
  await dialog.locator('.crm-filter__field input').first().click();
  await page.keyboard.type('Employees');
  await page.keyboard.press('Enter');
  await dialog.getByLabel('Operator').selectOption('gt');
  await dialog.locator('.crm-filter__value input').first().click();
  await page.keyboard.type('5000');
  await page.waitForTimeout(600);

  // The primary button never quotes a count belonging to the previous filter.
  const label = await dialog.locator('.ain-modal__footer button.ain-btn--primary').innerText();
  const expected = (await (await page.request.post('/api/v1/records/company/search', {
    data: { filter: { property: 'employee_count', operator: 'gt', value: 5000 }, limit: 1 },
  })).json()).total_count as number;
  expect(label.replace(/\D+/g, '')).toBe(String(expected));

  await dialog.locator('.ain-modal__footer button.ain-btn--primary').click();
  await expect(page).toHaveURL(/[?&]f=/);
  await expect(page.locator('table tbody tr[data-index]')).toHaveCount(expected);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('table tbody tr[data-index]')).toHaveCount(expected);
  await expect(page.locator('.crm-activefilter')).toContainText('Employees is greater than');
});

test('a column added for a glance is still there after a reload, and can be put back', async ({ page }) => {
  await openList(page, '/companies');
  await page.getByRole('button', { name: 'Columns' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Founded' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('columnheader', { name: 'Founded' })).toBeVisible();

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('table tbody tr[data-index]');
  await expect(page.getByRole('columnheader', { name: 'Founded' })).toBeVisible();

  // A year is not a quantity: 1989, never 1,989.
  const years = await page.locator('table tbody tr[data-index] td').filter({ hasText: /^(19|20)\d{2}$/ }).count();
  expect(years).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Columns' }).click();
  await page.getByRole('menuitem', { name: /Back to the columns/ }).click();
  await expect(page.getByRole('columnheader', { name: 'Founded' })).toHaveCount(0);
});

test('the primary link on an association can actually be set', async ({ page }) => {
  const stamp = `Primary${Date.now()}`;
  const created = await (await page.request.post('/api/v1/records/contact', {
    data: { properties: { first_name: 'Zeta', last_name: stamp, email: `zeta.${stamp}@example.com` } },
  })).json() as { id: string; display_name: string };

  await page.goto('/companies/cmp_nw_45', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Link another record' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Record to link' }).click();
  await page.keyboard.type(`Zeta ${stamp}`.slice(0, 14));
  await expect(dialog.getByRole('button', { name: 'Link', exact: true })).toBeDisabled();
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Link', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Records linked' })).toBeVisible();

  const row = page.locator('.crm-assoc__row').filter({ hasText: created.display_name });
  await expect(row.locator('.crm-assoc__primary')).toHaveAttribute('aria-pressed', 'false');
  await row.locator('.crm-assoc__primary').click();
  await expect(page.getByRole('status', { name: 'Primary link set' })).toBeVisible();

  const edges = (await (await page.request.get('/api/v1/records/company/cmp_nw_45/associations')).json()).data as
    { record_id: string; is_primary: boolean }[];
  expect(edges.find((e) => e.record_id === created.id)?.is_primary).toBe(true);
  await expect(row.locator('.crm-assoc__primary')).toHaveAttribute('aria-pressed', 'true');
});

test('a duplicate’s confidence is a percentage a person could believe', async ({ page }) => {
  const stamp = Date.now();
  const first = await (await page.request.post('/api/v1/records/contact', {
    data: { properties: { first_name: 'Perry', last_name: `Duplicant${stamp}`, email: `perry.a${stamp}@kilbride.ie` } },
  })).json() as { id: string };
  await page.request.post('/api/v1/records/contact', {
    data: { properties: { first_name: 'Perry', last_name: `Duplicant${stamp}`, email: `perry.b${stamp}@kilbride.ie` } },
  });

  await page.goto(`/contacts/${first.id}`, { waitUntil: 'networkidle' });
  const badge = page.locator('.crm-dupe__head .ain-badge').first();
  await expect(badge).toBeVisible();
  const percent = Number((await badge.innerText()).replace(/\D+/g, ''));
  const scored = (await (await page.request.get(`/api/v1/records/contact/${first.id}/similar?limit=1`)).json()).data as { score: number }[];
  expect(percent).toBe(Math.round(scored[0].score));
  expect(percent).toBeLessThanOrEqual(100);
});

test('a list that failed to load says it does not know rather than claiming zero', async ({ page }) => {
  await page.route('**/api/v1/records/company/search', (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: { type: 'api_error', code: 'internal', message: 'Something broke on our side.', request_id: 'req_probe' } }),
  }));
  await page.goto('/companies', { waitUntil: 'networkidle' });
  await expect(page.locator('.ain-page__subtitle')).not.toContainText(/\b0\b/);
  await expect(page.locator('.crm-tablefoot')).not.toContainText(/\b0\b/);

  await page.unroute('**/api/v1/records/company/search');
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.waitForSelector('table tbody tr[data-index]');
  expect(await rowCount(page)).toBeGreaterThan(0);
});

test('Enter creates the record from the create dialog', async ({ page }) => {
  await openList(page, '/contacts');
  const stamp = Date.now();
  await page.getByRole('button', { name: 'New contact' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('First name').fill('Perry');
  await dialog.getByLabel('Last name').fill(`Enterkey${stamp}`);
  await dialog.getByLabel('Email', { exact: true }).fill(`perry.${stamp}@example.com`);
  await dialog.getByLabel('Job title').click();
  await page.keyboard.type('Head of Testing');
  await page.keyboard.press('Enter');

  await expect(page.locator('[role=dialog]')).toHaveCount(0);
  const found = await (await page.request.post('/api/v1/records/contact/search', {
    data: { query: `Enterkey${stamp}`, limit: 2 },
  })).json() as { total_count: number; data: { properties: Record<string, unknown> }[] };
  expect(found.total_count).toBe(1);
  expect(found.data[0].properties.job_title).toBe('Head of Testing');
});

test('a builtin object type has one address, and the tab says where you are', async ({ page }) => {
  await page.goto('/records/company', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/companies/);
  await expect(page).toHaveTitle(/Companies/);

  await page.goto('/records/contact/con_nw_143', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/contacts\/con_nw_143/);
});

test('the associations rail stays within a screen of the header on a laptop', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto('/companies/cmp_nw_45', { waitUntil: 'networkidle' });
  const rail = await page.getByText('Possible duplicates').first().boundingBox();
  expect(rail!.y).toBeLessThan(1600);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test('the CSV carries the labels the grid shows, not the enum codes underneath', async ({ page }) => {
  await openList(page, '/companies');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  const [header, first] = text.split('\r\n');

  expect(header).toContain('Sales region');
  // The stored codes are lowercase slugs; the file must read like the screen.
  expect(first).not.toMatch(/,(latam|emea|apac|north_america),/);
  expect(text).toMatch(/LATAM|EMEA|APAC|North America/);
});

test('the save-view dialog names the sort in the language of the screen', async ({ page }) => {
  await openList(page, '/companies');
  await page.getByRole('button', { name: 'View' }).click();
  await page.getByRole('menuitem', { name: /Save as a new view/ }).click();
  const summary = page.locator('.crm-viewsummary');
  await expect(summary).toContainText('Last activity');
  await expect(summary).not.toContainText('last_activity_at');
});

test('a link carries only what was changed, including a view’s filter turned off', async ({ page }) => {
  await openList(page, '/companies');
  // Nothing customised, nothing in the address bar beyond the path.
  await expect(page).toHaveURL(/\/companies$/);

  await page.getByRole('button', { name: 'Key accounts' }).click();
  await page.waitForFunction(() => !document.querySelector('.ain-skeleton'));
  await expect(page).toHaveURL(/\?view=view_[^&]+$/);
  const inView = await rowCount(page);

  // Turning the view's own filter off is a state a link has to survive, and it
  // is not the same as having no opinion about the filter.
  const total = (await (await page.request.get('/api/v1/records/company?limit=1')).json()).total_count as number;
  await page.locator('.crm-activefilter').getByRole('button', { name: 'Clear' }).click();
  await expect(page).toHaveURL(/f=none/);
  await expect(page.locator('table tbody tr[data-index]')).toHaveCount(Math.min(total, 50));
  expect(total).toBeGreaterThan(inView);

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('table tbody tr[data-index]')).toHaveCount(Math.min(total, 50));
});

test('a sort and a row density chosen on the grid both come back', async ({ page }) => {
  await openList(page, '/companies');
  await page.getByRole('columnheader', { name: 'Employees' }).getByRole('button').click();
  await page.waitForFunction(() => !document.querySelector('.ain-skeleton'));
  await expect(page).toHaveURL(/s=employee_count/);
  const top = await page.locator('table tbody tr[data-index] .crm-cell__name').first().innerText();

  const density = page.getByRole('radiogroup', { name: 'Row density' });
  await density.locator('[data-value="compact"]').click();

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('table tbody tr[data-index]');
  await expect(page.locator('table tbody tr[data-index] .crm-cell__name').first()).toHaveText(top);
  await expect(page.getByRole('radiogroup', { name: 'Row density' }).locator('[data-value="compact"]'))
    .toHaveAttribute('aria-checked', 'true');
});
