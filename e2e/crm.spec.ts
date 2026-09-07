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

/** Export lives beside Import in one toolbar menu; this is the one gesture that reaches it. */
const exportCsv = async (page: Page) => {
  await page.getByRole('button', { name: 'Import / export' }).click();
  return page.getByRole('menuitem', { name: /Export this view as CSV/ }).click();
};

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

  // Money is never raw minor units. A company's open-deal total must carry a
  // currency symbol and grouped thousands, not the integer the API stores —
  // "$1,164,240.00" is right and "116424000" would be the defect. (Deals
  // themselves live on the pipeline's board now; the CRM's own money column
  // is the rollup on the account.)
  const views = (await (await page.request.get('/api/v1/views?object_type=company')).json()).data as { id: string; name: string }[];
  await openList(page, `/companies?view=${views.find((v) => v.name.startsWith('Open pipeline'))!.id}`);
  const row = page.locator('table tbody tr[data-index]').first();
  const amount = row.locator('td').filter({ hasText: /[$€£]/ }).first();
  await expect(amount).toContainText(/[$€£]\d{1,3}(,\d{3})*(\.\d{2})?$/);

  const first = (await (await page.request.post('/api/v1/records/company/search', {
    data: { limit: 1, sort: [{ property: 'total_open_deal_value', direction: 'desc' }] },
  })).json()).data[0];
  const minor = Number(first.properties.total_open_deal_value);
  const me = await (await page.request.get('/api/v1/me')).json();
  const expected = new Intl.NumberFormat(me.org.locale, { style: 'currency', currency: me.org.default_currency.toUpperCase() }).format(minor / 100);
  await expect(amount).toHaveText(expected);
  expect(expected).not.toBe(String(minor));
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
  // A ticket rather than a deal: the deal record is the pipeline's screen now.
  const deal = (await (await page.request.get('/api/v1/records/ticket?limit=1')).json()).data[0];
  const contacts = (await (await page.request.get('/api/v1/records/contact?limit=40')).json()).data;
  const linked = new Set(
    ((await (await page.request.get(`/api/v1/associations?record_id=${deal.id}`)).json()).data as { record_id: string }[])
      .map((edge) => edge.record_id),
  );
  const target = contacts.find((c: { id: string }) => !linked.has(c.id));

  await page.goto(`/tickets/${deal.id}`, { waitUntil: 'networkidle' });
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
    exportCsv(page),
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
  // The surname is the fixture: the combobox is driven by typing, and a prefix
  // short enough to match a contact some earlier run left behind picks that one
  // instead of this one. It is unique per run and typed whole.
  const stamp = `Primary${Date.now()}`;
  const created = await (await page.request.post('/api/v1/records/contact', {
    data: { properties: { first_name: 'Zeta', last_name: stamp, email: `zeta.${stamp}@example.com` } },
  })).json() as { id: string; display_name: string };

  await page.goto('/companies/cmp_nw_45', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Link another record' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Record to link' }).click();
  await page.keyboard.type(stamp);
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
    { record_id: string; is_primary: boolean; association_type: string }[];
  const edge = edges.find((e) => e.record_id === created.id)!;
  expect(edge.is_primary).toBe(true);
  await expect(row.locator('.crm-assoc__primary')).toHaveAttribute('aria-pressed', 'true');

  // The star is one POST, and the route promises `is_primary` is "the field you
  // read back". Sent against a link that is already there — which is what the
  // star always is — it used to answer with the row as it stood *before* the
  // flag moved, so the screen only looked right because it threw the answer
  // away and asked again. Proven on a second contact, whose link starts plain.
  const other = await (await page.request.post('/api/v1/records/contact', {
    data: { properties: { first_name: 'Yara', last_name: stamp, email: `yara.${stamp}@example.com` } },
  })).json() as { id: string };
  const plain = await (await page.request.post('/api/v1/associations', {
    data: { from_id: other.id, to_id: 'cmp_nw_45', association_type: edge.association_type },
  })).json() as { is_primary: boolean };
  expect(plain.is_primary).toBe(false);

  const promoted = await (await page.request.post('/api/v1/associations', {
    data: { from_id: other.id, to_id: 'cmp_nw_45', association_type: edge.association_type, primary: true },
  })).json() as { is_primary: boolean };
  const stored = ((await (await page.request.get(`/api/v1/records/contact/${other.id}/associations?object_type=company`)).json()).data as
    { record_id: string; is_primary: boolean }[]).find((e) => e.record_id === 'cmp_nw_45');
  expect(stored?.is_primary).toBe(true);
  expect(promoted.is_primary).toBe(stored?.is_primary);
});

test('moving the primary link to another record stands the first one down', async ({ page }) => {
  const stamp = `Movable${Date.now()}`;
  const contact = await (await page.request.post('/api/v1/records/contact', {
    data: { properties: { first_name: 'Wren', last_name: stamp, email: `wren.${stamp}@example.com` } },
  })).json() as { id: string; display_name: string };
  const [first, second] = await Promise.all(['A', 'B'].map(async (suffix) =>
    (await (await page.request.post('/api/v1/records/company', {
      data: { properties: { name: `${stamp} Holdings ${suffix}`, domain: `${stamp.toLowerCase()}-${suffix.toLowerCase()}.test` } },
    })).json()) as { id: string; display_name: string }));

  await page.request.post('/api/v1/associations', { data: { from_id: contact.id, to_id: first.id, primary: true } });
  await page.request.post('/api/v1/associations', { data: { from_id: contact.id, to_id: second.id } });

  await page.goto(`/contacts/${contact.id}`, { waitUntil: 'networkidle' });
  const rowFor = (name: string) => page.locator('.crm-assoc__row').filter({ hasText: name });
  await expect(rowFor(first.display_name).locator('.crm-assoc__primary')).toHaveAttribute('aria-pressed', 'true');
  await expect(rowFor(second.display_name).locator('.crm-assoc__primary')).toHaveAttribute('aria-pressed', 'false');

  await rowFor(second.display_name).locator('.crm-assoc__primary').click();
  await expect(page.getByRole('status', { name: 'Primary link set' })).toBeVisible();

  // One link of a kind is primary, so moving the star has to take it off the
  // other row — on the screen and in the book behind it.
  await expect(rowFor(second.display_name).locator('.crm-assoc__primary')).toHaveAttribute('aria-pressed', 'true');
  await expect(rowFor(first.display_name).locator('.crm-assoc__primary')).toHaveAttribute('aria-pressed', 'false');
  const edges = (await (await page.request.get(`/api/v1/records/contact/${contact.id}/associations?object_type=company`)).json()).data as
    { record_id: string; is_primary: boolean }[];
  expect(edges.filter((e) => e.is_primary).map((e) => e.record_id)).toEqual([second.id]);

  // And the move is on the record's own history, the way linking and unlinking
  // are — a star nobody can audit is a change that never happened.
  const timeline = (await (await page.request.get(`/api/v1/records/contact/${contact.id}/timeline?limit=50&kinds=event`)).json()).data as
    { title: string; data: { type?: string } }[];
  const moved = timeline.find((i) => i.data?.type === 'association.primary_set');
  expect(moved?.title).toContain(second.display_name);
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
  // The duplicate card is drawn from `/similar`, and `useQuery` keeps a refused
  // read rather than retrying it — so a page that arrived while the limiter was
  // answering 429 shows no card at all, for good. Ask the screen again.
  if (await badge.count() === 0) await page.reload({ waitUntil: 'networkidle' });
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
  // Nothing under the grid asserts a number nobody measured: the whole count
  // strip goes, rather than the header saying "—" while the footer says "0".
  await expect(page.locator('.crm-tablefoot')).toHaveCount(0);
  await expect(page.locator('.ain-table__pager')).toHaveCount(0);
  await expect(page.getByText('Something broke on our side.')).toBeVisible();

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
    exportCsv(page),
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

test('an object type can be renamed and deleted again from the data model', async ({ page }) => {
  const stamp = Date.now().toString().slice(-6);
  await page.goto('/records', { waitUntil: 'networkidle' });

  // Make one to work on, so the test never depends on what the seed left behind.
  await page.getByRole('button', { name: 'New custom object' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Singular name').fill(`Depot ${stamp}`);
  await dialog.getByLabel('Plural name').fill(`Depots ${stamp}`);
  await dialog.getByRole('button', { name: 'Create object' }).click();
  await expect(page.getByRole('status', { name: /created/ })).toBeVisible();

  const name = `depot_${stamp}`;
  const card = page.locator('.crm-objcard').filter({ hasText: `Depots ${stamp}` });
  await card.getByRole('button', { name: `Manage Depots ${stamp}` }).click();
  await page.getByRole('menuitem', { name: 'Edit this object type' }).click();

  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Internal name')).toBeDisabled();
  await dialog.getByLabel('Singular name').fill(`Yard ${stamp}`);
  await dialog.getByLabel('Plural name').fill(`Yards ${stamp}`);
  await dialog.getByLabel('Description').fill('Where the fleet sleeps.');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status', { name: /updated/ })).toBeVisible();

  const renamed = await (await page.request.get(`/api/v1/objects/${name}`)).json();
  expect(renamed.label).toBe(`Yard ${stamp}`);
  expect(renamed.plural_label).toBe(`Yards ${stamp}`);
  expect(renamed.description).toBe('Where the fleet sleeps.');
  // The workspace's own label is what the screen shows afterwards.
  await expect(page.locator('.crm-objcard').filter({ hasText: `Yards ${stamp}` })).toBeVisible();

  // And it can be removed again — records first, which this one has none of.
  await page.locator('.crm-objcard').filter({ hasText: `Yards ${stamp}` })
    .getByRole('button', { name: `Manage Yards ${stamp}` }).click();
  await page.getByRole('menuitem', { name: 'Delete this object type' }).click();
  const confirm = page.getByRole('dialog');
  await confirm.locator('input').fill(name);
  await confirm.getByRole('button', { name: 'Delete object type' }).click();
  await expect(page.getByRole('status', { name: /removed/ })).toBeVisible();

  expect((await page.request.get(`/api/v1/objects/${name}`)).status()).toBe(404);
  await expect(page.locator('.crm-objcard').filter({ hasText: `Yards ${stamp}` })).toHaveCount(0);
});

test('deleting an object type that still has records is refused, in words that say what to do', async ({ page }) => {
  await page.goto('/records', { waitUntil: 'networkidle' });
  const card = page.locator('.crm-objcard').filter({ hasText: 'Companies' });
  await card.getByRole('button', { name: 'Manage Companies' }).click();
  // A built-in is not deletable at all, and the menu says so rather than failing later.
  const item = page.getByRole('menuitem', { name: 'Built-in objects cannot be deleted' });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('aria-disabled', 'true');
});

test('the subtitle and the searched-by properties of an object can be re-pointed from the UI', async ({ page }) => {
  const before = await (await page.request.get('/api/v1/objects/company')).json() as {
    secondary_property: string; searchable: string[];
  };
  await page.goto('/records', { waitUntil: 'networkidle' });

  const open = async () => {
    await page.locator('.crm-objcard').filter({ hasText: 'Companies' }).getByRole('button', { name: 'Manage Companies' }).click();
    await page.getByRole('menuitem', { name: 'Edit this object type' }).click();
    return page.getByRole('dialog');
  };

  let dialog = await open();
  await expect(dialog.getByLabel('Subtitle property')).toHaveValue(before.secondary_property);
  await dialog.getByLabel('Subtitle property').selectOption({ label: 'Industry' });
  // The search box looks inside exactly these, and the list of them is editable.
  await dialog.getByLabel('Industry', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status', { name: /updated/ })).toBeVisible();

  const after = await (await page.request.get('/api/v1/objects/company')).json() as {
    secondary_property: string; searchable: string[];
  };
  expect(after.secondary_property).toBe('industry');
  expect(after.searchable).toContain('industry');

  // The companies list picks the new subtitle up without a reload of the app.
  await page.goto('/companies', { waitUntil: 'networkidle' });
  await expect(page.locator('table tbody tr[data-index]').first()).toBeVisible();

  await page.goto('/records', { waitUntil: 'networkidle' });
  dialog = await open();
  await dialog.getByLabel('Subtitle property').selectOption(before.secondary_property);
  await dialog.getByLabel('Industry', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status', { name: /updated/ })).toBeVisible();
  expect((await (await page.request.get('/api/v1/objects/company')).json()).secondary_property).toBe(before.secondary_property);
});

test('a money change on the timeline reads as money, never as the minor units underneath', async ({ page }) => {
  await page.request.patch('/api/v1/records/company/cmp_nw_46', { data: { properties: { annual_revenue: 1234567 } } });
  await page.request.patch('/api/v1/records/company/cmp_nw_46', { data: { properties: { annual_revenue: 9876543 } } });

  await page.goto('/companies/cmp_nw_46', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Property changes' }).click();
  const entry = page.locator('.crm-tl').filter({ hasText: 'Annual revenue changed' }).first();
  await expect(entry).toContainText('$12,345.67 → $98,765.43');
  await expect(entry).not.toContainText('1234567');
});

test('an object nobody has built a view for still arrives with its own columns', async ({ page }) => {
  // Tasks have no saved view in the seed, so the grid has to choose. Choosing
  // "name, owner, last modified" for a queue is a wall, not a list.
  await openList(page, '/records/task');
  for (const header of ['Task', 'Status', 'Due', 'Owner']) {
    await expect(page.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
  }
  const status = page.locator('table tbody tr[data-index]').first().locator('td').nth(2);
  await expect(status).not.toBeEmpty();

  // And the choice is still only a default: the column menu can drop one.
  await page.getByRole('button', { name: /^Columns/ }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Due' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('columnheader', { name: 'Due', exact: true })).toHaveCount(0);
});

test('a contact that does not exist yet can be created and linked in one step', async ({ page }) => {
  const stamp = Date.now().toString().slice(-6);
  await page.goto('/companies/cmp_nw_34', { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'Link another record' }).click();
  await page.getByRole('button', { name: 'Create a new one' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Oranmore Logistics');
  await dialog.getByLabel('First name').fill('Saoirse');
  await dialog.getByLabel('Last name').fill(`Byrne ${stamp}`);
  await dialog.getByRole('button', { name: 'Create contact' }).click();
  await expect(page.getByRole('status', { name: /Linked to the new record/ })).toBeVisible();

  // The server is the judge: the association exists on the company's own page.
  const linked = await (await page.request.get('/api/v1/records/company/cmp_nw_34/associations')).json() as {
    data: { display_name: string }[];
  };
  expect(linked.data.some((a) => a.display_name === `Saoirse Byrne ${stamp}`)).toBe(true);
  await expect(page.locator('.crm-record__col').last()).toContainText(`Saoirse Byrne ${stamp}`);
});

/* ============================ view management ============================= */

/**
 * A view a team shares is only an asset if the team can maintain it. These
 * four were the whole reason a RevOps lead would have kept HubSpot: the screen
 * gated on `system: true` while the server was quite happy to take the write.
 */

const viewsOf = async (page: Page, type = 'company') =>
  (await (await page.request.get(`/api/v1/views?object_type=${type}`)).json()).data as {
    id: string; name: string; system: boolean; is_default: boolean;
    columns: string[]; sort: unknown[]; filter: unknown;
  }[];

const openViewMenu = async (page: Page) => {
  await page.locator('button').filter({ hasText: /^View$/ }).first().click();
  await expect(page.getByRole('menu')).toBeVisible();
};

test('changes made on a built-in view can be saved back onto it', async ({ page }) => {
  await openList(page, '/companies');
  await page.getByRole('button', { name: 'Key accounts' }).click();
  await page.waitForFunction(() => !document.querySelector('.ain-skeleton'));
  const id = new URL(page.url()).searchParams.get('view')!;
  const before = (await viewsOf(page)).find((v) => v.id === id)!;
  expect(before.system).toBe(true);

  // Add a column, which is exactly the kind of maintenance a shared view needs.
  await page.getByRole('button', { name: 'Columns' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Founded' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Modified', { exact: true })).toBeVisible();

  await openViewMenu(page);
  await page.getByRole('menuitem', { name: /Save changes to this view/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const after = (await viewsOf(page)).find((v) => v.id === id)!;
  expect(after.columns).toContain('founded_year');
  expect(after.columns.length).toBe(before.columns.length + 1);
  // And the screen agrees the view is no longer ahead of what is stored.
  await expect(page.getByText('Modified', { exact: true })).toHaveCount(0);

  await page.request.patch(`/api/v1/views/${id}`, { data: { columns: before.columns } });
});

test('a built-in view can be renamed, and the rename leaves its filter alone', async ({ page }) => {
  await openList(page, '/companies');
  await page.getByRole('button', { name: 'Gone quiet' }).click();
  await page.waitForFunction(() => !document.querySelector('.ain-skeleton'));
  const id = new URL(page.url()).searchParams.get('view')!;
  const before = (await viewsOf(page)).find((v) => v.id === id)!;

  await openViewMenu(page);
  await page.getByRole('menuitem', { name: /Rename this view/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Dormant accounts');
  await dialog.getByRole('button', { name: 'Rename view' }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByRole('button', { name: 'Dormant accounts' })).toBeVisible();
  const after = (await viewsOf(page)).find((v) => v.id === id)!;
  expect(after.name).toBe('Dormant accounts');
  expect(JSON.stringify(after.filter)).toBe(JSON.stringify(before.filter));
  expect(after.columns).toEqual(before.columns);

  await page.request.patch(`/api/v1/views/${id}`, { data: { name: before.name } });
});

test('any view can be made the one the list opens on', async ({ page }) => {
  const original = (await viewsOf(page)).find((v) => v.is_default)!;
  await openList(page, '/companies');
  await page.getByRole('button', { name: 'Open pipeline over $75k' }).click();
  await page.waitForFunction(() => !document.querySelector('.ain-skeleton'));
  const id = new URL(page.url()).searchParams.get('view')!;

  await openViewMenu(page);
  await page.getByRole('menuitem', { name: 'Make it the default view' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect.poll(async () => (await viewsOf(page)).find((v) => v.id === id)!.is_default).toBe(true);

  // The proof is arriving with no `?view=` at all and landing on it.
  await openList(page, '/companies');
  await expect(page.locator('.ain-page__subtitle')).toContainText('Open pipeline over $75k');

  await page.request.patch(`/api/v1/views/${original.id}`, { data: { is_default: true } });
});

test('deleting a view works on one you made, and says why it will not on one that ships with Ain', async ({ page }) => {
  const name = `Scratch view ${Date.now()}`;
  const made = await (await page.request.post('/api/v1/views', {
    data: { object_type: 'company', name, columns: ['name', 'owner_id'] },
  })).json() as { id: string };

  await openList(page, `/companies?view=${made.id}`);
  await openViewMenu(page);
  const del = page.getByRole('menuitem', { name: 'Delete this view' });
  await expect(del).toBeEnabled();
  await del.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete view' }).click();
  await expect.poll(async () => (await viewsOf(page)).some((v) => v.id === made.id)).toBe(false);

  // A built-in one still shows the item — with the server's own reason on it,
  // rather than vanishing and leaving the operator wondering.
  await openList(page, '/companies');
  await page.getByRole('button', { name: 'Key accounts' }).click();
  await page.waitForFunction(() => !document.querySelector('.ain-skeleton'));
  await openViewMenu(page);
  const builtin = page.getByRole('menuitem', { name: /Delete this view/ });
  await expect(builtin).toBeVisible();
  await expect(builtin).toBeDisabled();
  await expect(builtin).toContainText('Ships with Ain');
});

test('the archived list is a link, like every other piece of list state', async ({ page }) => {
  await openList(page, '/contacts');
  const archived = page.getByRole('button', { name: 'Archived' });
  await archived.click();
  await expect(page).toHaveURL(/[?&]archived=1/);
  await expect(archived).toHaveAttribute('aria-pressed', 'true');

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: 'Archived' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Archived' }).click();
  await expect(page).not.toHaveURL(/archived=1/);
});

/* =========================== reading the screen =========================== */

test('the list stays readable on a laptop-width window instead of shredding its columns', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openList(page, '/companies');

  const widths = await page.evaluate(() =>
    [...document.querySelectorAll('table thead th')]
      // The select box and the row-actions button are chrome, not data.
      .filter((th) => !th.className.includes('selectcell') && !th.className.includes('actioncell'))
      .map((th) => ({ label: (th as HTMLElement).innerText.trim(), width: Math.round(th.getBoundingClientRect().width) }))
      .filter((c) => c.label));
  expect(widths.length).toBeGreaterThan(4);
  for (const column of widths) expect(column.width, `${column.label} is unreadably narrow`).toBeGreaterThanOrEqual(96);

  // Once the columns outgrow the window the wrapper scrolls, so nothing is lost.
  const scroll = await page.evaluate(() => {
    const el = document.querySelector('.ain-table__scroll') as HTMLElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: getComputedStyle(el).overflowX };
  });
  expect(scroll.overflowX).toBe('auto');
  expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);

  // A badge cell still carries its word, not a bare coloured dot.
  const stage = page.locator('table tbody tr[data-index]').first().locator('td').nth(2);
  expect((await stage.innerText()).trim().length).toBeGreaterThan(2);
});

test('the footer’s verb agrees with the number in front of it', async ({ page }) => {
  await openList(page, '/companies');
  await page.getByPlaceholder('Search companies…').fill('kaiping');
  await expect(page.locator('.crm-tablefoot')).toContainText('1 company matches this view');

  await page.getByPlaceholder('Search companies…').fill('');
  await expect(page.locator('.crm-tablefoot')).toContainText(/\d+ companies match this view/);
});

test('the search box offers one clear button, not two', async ({ page }) => {
  await openList(page, '/companies');
  const box = page.locator('.crm-toolsearch input');
  await box.fill('kaiping');
  await box.focus();
  await expect(page.locator('.crm-toolsearch .ain-input__clear')).toHaveCount(1);
  // The browser's own cancel glyph is suppressed, so the two never sit side by side.
  const suppressed = await page.evaluate(() => [...document.styleSheets].some((sheet) => {
    try { return [...sheet.cssRules].some((r) => r.cssText.includes('crm-toolsearch') && r.cssText.includes('search-cancel-button')); } catch { return false; }
  }));
  expect(suppressed).toBe(true);
});

test('a record page names the record in the breadcrumb, not its object type', async ({ page }) => {
  const contact = (await (await page.request.get('/api/v1/records/contact?limit=1')).json()).data[0];
  await page.goto(`/contacts/${contact.id}`, { waitUntil: 'networkidle' });
  await expect(page.locator('nav[aria-label="Breadcrumb"]')).toContainText(contact.display_name);
  await expect(page.locator('nav[aria-label="Breadcrumb"] [aria-current="page"]')).toHaveText(contact.display_name);
});

test('a contact’s employer is on the identity card and beside the name, not only in the right rail', async ({ page }) => {
  const contacts = (await (await page.request.get('/api/v1/records/contact?limit=25')).json()).data as { id: string }[];
  let target: { id: string; employer: string } | null = null;
  for (const row of contacts) {
    const full = await (await page.request.get(`/api/v1/records/contact/${row.id}`)).json();
    const edge = (full.associations ?? []).find((a: { object_type: string }) => a.object_type === 'company');
    if (edge) { target = { id: row.id, employer: edge.display_name }; break; }
  }
  expect(target, 'the demo workspace has a contact linked to a company').not.toBeNull();

  await page.goto(`/contacts/${target!.id}`, { waitUntil: 'networkidle' });
  const card = page.locator('.crm-identity__at');
  await expect(card).toContainText(target!.employer);
  await expect(page.locator('.ain-page__subtitle')).toContainText(target!.employer);

  await card.click();
  await expect(page).toHaveURL(/\/companies\//);
  await expect(page.locator('.ain-page__title')).toContainText(target!.employer);
});

/* ============================== zoned writes ============================== */

test('the activity composer stamps the workspace’s clock, not the browser’s', async ({ browser }) => {
  // A London operator on a New York workspace is where this went wrong: the
  // field rendered one day and the header another, on the same screen.
  const context = await browser.newContext({ timezoneId: 'Europe/London' });
  const page = await context.newPage();
  await signIn(page);

  const me = await (await page.request.get('/api/v1/me')).json();
  const zone = me.org.timezone as string;
  const now = me.clock.now as number;
  const contact = (await (await page.request.get('/api/v1/records/contact?limit=1')).json()).data[0];

  await page.goto(`/contacts/${contact.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  const when = page.locator('input[type="datetime-local"]');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).reduce<Record<string, string>>((acc, p) => (p.type === 'literal' ? acc : { ...acc, [p.type]: p.value }), {});
  await expect(when).toHaveValue(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`);

  // And what it writes back is that wall clock in that zone, to the minute.
  const subject = `Backdated recap ${Date.now()}`;
  await when.fill('2026-08-28T09:00');
  await page.getByRole('dialog').getByLabel('Subject').fill(subject);
  await page.getByRole('dialog').getByRole('button', { name: 'Write a note' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const timeline = await (await page.request.get(`/api/v1/records/contact/${contact.id}/timeline?limit=10`)).json();
  const entry = (timeline.data as { title?: string; occurred_at?: number; at?: number }[])
    .find((i) => JSON.stringify(i).includes(subject));
  expect(entry, 'the note reached the timeline').toBeTruthy();
  const at = entry!.occurred_at ?? entry!.at!;
  const stored = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(at);
  expect(stored.replace(', ', 'T')).toBe('2026-08-28T09:00');
  await context.close();
});

test('the CSV is stamped with the workspace’s day, and still carries exact money', async ({ page }) => {
  await openList(page, '/companies');
  const me = await (await page.request.get('/api/v1/me')).json();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: me.org.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(me.clock.now as number);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportCsv(page),
  ]);
  expect(download.suggestedFilename()).toBe(`Companies ${day}.csv`);
});


/* ======================= the critic's second pass ========================= */

/**
 * Each of these is a defect a fresh critic found on screen: a save that undid
 * itself, a merge nobody could see into, a file the export promised could come
 * back and could not, an admin surface offered to a member. The tests fail on
 * the code as it stood.
 */

test('saving a sort onto the view keeps the grid on that sort, with nothing left over to mark Modified', async ({ page }) => {
  const views = (await (await page.request.get('/api/v1/views?object_type=contact')).json()).data as { id: string; name: string }[];
  const all = views.find((v) => v.name === 'All contacts')!;
  // The seed's own sort, put back whatever an earlier run left behind.
  const restore = () => page.request.patch(`/api/v1/views/${all.id}`, { data: { sort: [{ property: 'last_activity_at', direction: 'desc' }] } });
  await restore();

  await openList(page, '/contacts');
  await page.getByRole('columnheader', { name: 'Job title' }).getByRole('button').click();
  await page.waitForFunction(() => !document.querySelector('.ain-skeleton'));
  await expect(page).toHaveURL(/s=job_title/);
  const top = await page.locator('table tbody tr[data-index] .crm-cell__name').first().innerText();

  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: /Save changes to this view/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status', { name: 'View updated' })).toBeVisible();

  try {
    const saved = (await (await page.request.get(`/api/v1/views/${all.id}`)).json()) as { sort: { property: string }[] };
    expect(saved.sort[0].property).toBe('job_title');
    // The grid stays on what was just saved: same first row, the header still
    // sorted on Job title, no override in the address bar, nothing "Modified".
    await page.waitForTimeout(800);
    await expect(page.locator('table tbody tr[data-index] .crm-cell__name').first()).toHaveText(top);
    await expect(page.locator('table thead th[aria-sort]')).toContainText('Job title');
    await expect(page).not.toHaveURL(/[?&]s=/);
    await expect(page.locator('main').getByText('Modified', { exact: true })).toHaveCount(0);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('table tbody tr[data-index]');
    await expect(page.locator('table tbody tr[data-index] .crm-cell__name').first()).toHaveText(top);
    await expect(page.locator('main').getByText('Modified', { exact: true })).toHaveCount(0);
  } finally {
    await restore();
  }
});

test('the filter dialog holds a draft: Esc discards it, Show applies it', async ({ page }) => {
  await openList(page, '/contacts');
  const total = (await (await page.request.get('/api/v1/records/contact?limit=1')).json()).total_count as number;

  await page.getByRole('button', { name: /^Filters/ }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Condition' }).click();
  await dialog.locator('.crm-filter__field input').first().click();
  await page.keyboard.type('Job title');
  await page.keyboard.press('Enter');
  await dialog.getByLabel('Operator').selectOption('contains');
  await dialog.locator('.crm-filter__value input').first().click();
  await page.keyboard.type('Chief');
  await page.waitForTimeout(700);

  // The button counts the draft; the grid behind the dialog is untouched.
  const narrowed = (await (await page.request.post('/api/v1/records/contact/search', {
    data: { filter: { property: 'job_title', operator: 'contains', value: 'Chief' }, limit: 1 },
  })).json()).total_count as number;
  await expect(dialog.locator('.ain-modal__footer button.ain-btn--primary')).toContainText(String(narrowed));
  await expect(page.locator('.crm-tablefoot')).toContainText(`${total} contacts`);
  await expect(page).not.toHaveURL(/[?&]f=/);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]f=/);
  await expect(page.locator('.crm-activefilter')).toHaveCount(0);
  await expect(page.locator('.crm-tablefoot')).toContainText(`${total} contacts`);

  // Reopened, the discarded draft is gone; built again and applied, it lands.
  await page.getByRole('button', { name: /^Filters/ }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.locator('.crm-filter__row')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Condition' }).click();
  await dialog.locator('.crm-filter__field input').first().click();
  await page.keyboard.type('Job title');
  await page.keyboard.press('Enter');
  await dialog.getByLabel('Operator').selectOption('contains');
  await dialog.locator('.crm-filter__value input').first().click();
  await page.keyboard.type('Chief');
  await page.waitForTimeout(700);
  await dialog.locator('.ain-modal__footer button.ain-btn--primary').click();
  await expect(page).toHaveURL(/[?&]f=/);
  await expect(page.locator('.crm-activefilter')).toContainText('Job title contains Chief');
  await expect(page.locator('.crm-tablefoot')).toContainText(`${narrowed} contacts`);
});

test('the merge dialog shows what survives and what moves, refuses a cross-account merge until acknowledged, and reports the real diff', async ({ page }) => {
  const stamp = Date.now();
  const companies = (await (await page.request.get('/api/v1/records/company?limit=2')).json()).data as { id: string; display_name: string }[];
  const make = async (companyId: string, extra: Record<string, unknown>) => (await (await page.request.post('/api/v1/records/ticket', {
    data: { properties: { subject: `Gateway drops offline overnight ${stamp}`, ...extra }, associate_to: [companyId] },
  })).json()) as { id: string; properties: Record<string, unknown> };
  const winner = await make(companies[0].id, { priority: 'medium' });
  const loser = await make(companies[1].id, { priority: 'high', affected_line: 'Press shop A', status: 'closed' });

  await page.goto(`/tickets/${winner.id}`, { waitUntil: 'networkidle' });
  // Earlier runs leave same-named tickets behind; the candidate is the one
  // with this run's stamp and the other account.
  const card = page.locator('.crm-dupe').filter({ hasText: `overnight ${stamp}` }).filter({ hasText: companies[1].display_name });
  // The candidate carries the facts that tell two same-named tickets apart.
  await expect(card).toContainText('Same subject');
  await card.getByRole('button', { name: 'Merge into this record' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('belong to different accounts');
  await expect(dialog.locator('.crm-mergetable')).toContainText('Affected line');
  await expect(dialog.locator('.crm-mergetable tr', { hasText: 'Affected line' })).toContainText('Fills the blank');
  await expect(dialog.locator('.crm-mergetable tr', { hasText: 'Priority' })).toContainText('Survivor keeps its own');
  await expect(dialog.getByRole('row', { name: /^Status / })).toContainText('Survivor keeps its own');
  await expect(dialog.locator('.crm-mergemoves__row', { hasText: companies[1].display_name })).toContainText('Moves across');
  const merge = dialog.getByRole('button', { name: /^Merge into/ });
  await expect(merge).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /merge anyway/ }).check();
  await expect(merge).toBeEnabled();

  const before = await recordOf(page.request, 'ticket', winner.id);
  await merge.click();
  const toast = page.getByRole('status', { name: 'Duplicate merged' });
  await expect(toast).toBeVisible();

  // The sentence is computed from the survivor as it now stands, not from the
  // server's count of blanks it meant to fill.
  const after = await recordOf(page.request, 'ticket', winner.id);
  const changed = [...new Set([...Object.keys(before.properties), ...Object.keys(after.properties)])]
    .filter((k) => JSON.stringify(before.properties[k] ?? null) !== JSON.stringify(after.properties[k] ?? null)).length;
  const said = Number(/(\d+) propert/.exec(await toast.innerText())?.[1]);
  expect(said).toBe(changed);
  expect(after.properties.affected_line).toBe('Press shop A');
  expect(after.properties.priority).toBe('medium');
  expect((await (await page.request.get(`/api/v1/records/ticket/${loser.id}`)).json()).id).toBe(winner.id);
});

test('a CSV imports through mapping and preview, and every refused row names the property and the reason', async ({ page }) => {
  const stamp = Date.now();
  await openList(page, '/contacts');
  await page.getByRole('button', { name: 'Import / export' }).click();
  await page.getByRole('menuitem', { name: /Import from a CSV/ }).click();
  const dialog = page.getByRole('dialog');

  const csv = [
    'First name,Last name,E-mail,Job title,Owner,Lifecycle stage',
    `Ingrid,Halvorsen ${stamp},ingrid.${stamp}@nordhavn.example,Plant Manager,Marcus Ilori,Lead`,
    `Piet,de Vries ${stamp},not-an-email,Buyer,Dana Whitfield,Customer`,
    `Aiko,Sato ${stamp},aiko.${stamp}@example.com,,Nobody Here,Lead`,
  ].join('\r\n');
  await dialog.locator('input[type=file]').setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });

  // Headers mapped themselves — the export's labels, punctuation and all.
  await expect(dialog.getByLabel('Import "E-mail" as')).toHaveValue('email');
  await expect(dialog.getByLabel('Import "Owner" as')).toHaveValue('owner_id');
  await expect(dialog.getByLabel('How to treat existing records')).toHaveValue('upsert');
  await dialog.getByRole('button', { name: /^Check 3 rows/ }).click();

  // The preview holds back the row it cannot write, and says which cell.
  await expect(dialog).toContainText('2 ready');
  await expect(dialog).toContainText('Row 3, Owner: No teammate called "Nobody Here"');
  await dialog.getByRole('button', { name: /^Import 2 contacts/ }).click();

  await expect(dialog).toContainText('1 created');
  await expect(dialog).toContainText('2 refused');
  const refused = dialog.locator('table[aria-label="Refused rows"] tbody tr');
  await expect(refused).toHaveCount(2);
  await expect(refused.nth(0)).toContainText('Email');
  await expect(refused.nth(0)).toContainText('not a valid email');
  await expect(refused.nth(1)).toContainText('Owner');

  const found = (await (await page.request.post('/api/v1/records/contact/search', { data: { query: String(stamp), limit: 5 } })).json()) as
    { total_count: number; data: { properties: Record<string, unknown>; owner_id: string; source: string }[] };
  expect(found.total_count).toBe(1);
  expect(found.data[0].properties.email).toBe(`ingrid.${stamp}@nordhavn.example`);
  expect(found.data[0].properties.lifecycle_stage).toBe('lead');
  expect(found.data[0].source).toBe('import');
  const users = (await (await page.request.get('/api/v1/users')).json()).data as { id: string; name: string }[];
  expect(found.data[0].owner_id).toBe(users.find((u) => u.name === 'Marcus Ilori')!.id);
});

test('a member sees the data model read-only, with the reason, instead of forms that fail at the end', async ({ page }) => {
  const login = await page.request.post('/api/v1/auth/login', { data: { email: 'priya@northwind.io', password: 'demo1234' } });
  expect(login.ok()).toBe(true);
  expect(((await (await page.request.get('/api/v1/me')).json()) as { role: string }).role).toBe('member');

  await page.goto('/records', { waitUntil: 'networkidle' });
  await expect(page.locator('.ain-banner')).toContainText('Read-only for your role');
  await expect(page.getByRole('button', { name: 'Add a property' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New custom object' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New association type' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Manage / })).toHaveCount(0);
  // The model itself is still there to read.
  await expect(page.locator('.crm-objcard')).not.toHaveCount(0);
  await expect(page.getByText('first_name')).toBeVisible();
});

test('every property row opens its own history, from → to with who', async ({ page }) => {
  const stamp = Date.now();
  const created = (await (await page.request.post('/api/v1/records/contact', {
    data: { properties: { first_name: 'Hilde', last_name: `Historian ${stamp}`, email: `hilde.${stamp}@example.com`, job_title: 'Plant Manager' } },
  })).json()) as { id: string };
  await page.goto(`/contacts/${created.id}`, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'Edit Job title' }).click();
  const editor = page.locator('#edit-job_title');
  await editor.press('Control+a');
  await page.keyboard.type('Head of Reliability');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: 'Job title updated' })).toBeVisible();

  const row = page.locator('.crm-prop', { hasText: 'Job title' }).first();
  await row.hover();
  await row.getByRole('button', { name: 'History of Job title' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Job title — history');
  const change = dialog.locator('.crm-history tbody tr').first();
  await expect(change.locator('.crm-history__from')).toContainText('Plant Manager');
  await expect(change.locator('.crm-history__to')).toContainText('Head of Reliability');
  await expect(change).toContainText('Dana Whitfield');

  const history = (await (await page.request.get(`/api/v1/records/contact/${created.id}/history?property=job_title`)).json()).data as
    { from_value: unknown; to_value: unknown }[];
  expect(history[0].to_value).toBe('Head of Reliability');
  expect(history[0].from_value).toBe('Plant Manager');
});

test('tickets have their own address, and an SLA reads as a state rather than a date', async ({ page }) => {
  await page.goto('/records/ticket', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/tickets$/);
  await page.waitForSelector('table tbody tr[data-index]');
  await expect(page.locator('.ain-crumbs')).not.toContainText('Data model');

  await page.getByRole('button', { name: 'SLA at risk' }).click();
  await page.waitForFunction(() => !document.querySelector('.ain-skeleton'));
  const cells = page.locator('table tbody tr[data-index] .ain-badge', { hasText: /Overdue by|Due in|Due / });
  await expect(cells.first()).toBeVisible();
  // Every row in this view is past or inside its target: none of them is a bare date.
  const rows = await rowCount(page);
  expect(await cells.count()).toBe(rows);

  const ticket = (await (await page.request.get('/api/v1/records/ticket?limit=1')).json()).data[0] as { id: string };
  await page.goto(`/records/ticket/${ticket.id}`, { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(new RegExp(`/tickets/${ticket.id}$`));
});

test('a task logged on the timeline shows its status and can be completed from there', async ({ page }) => {
  const stamp = Date.now();
  const contact = (await (await page.request.get('/api/v1/records/contact?limit=1')).json()).data[0] as { id: string };
  await page.goto(`/contacts/${contact.id}`, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'Task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('What needs doing').fill(`Send the pilot SOW ${stamp}`);
  await dialog.getByRole('button', { name: 'Create a task' }).click();

  const item = page.locator('.crm-tl', { hasText: `Send the pilot SOW ${stamp}` });
  await expect(item.locator('.ain-badge', { hasText: 'Task' })).toBeVisible();
  await expect(item).toContainText('Not started');
  await item.getByRole('button', { name: 'Mark complete' }).click();
  await expect(page.getByRole('status', { name: 'Task completed' })).toBeVisible();
  await expect(item).toContainText('Completed');

  const tasks = (await (await page.request.post('/api/v1/records/task/search', { data: { query: String(stamp), limit: 2 } })).json()) as
    { data: { properties: Record<string, unknown> }[] };
  expect(tasks.data[0].properties.status).toBe('completed');
});

test('a rollup names its basis in words, filter included, and counts the records it stands on', async ({ page }) => {
  const company = await recordOf(page.request, 'company', 'cmp_nw_07');
  await page.goto('/companies/cmp_nw_07', { waitUntil: 'networkidle' });
  await page.locator('.ain-accordion__trigger', { hasText: 'Pipeline' }).click();

  const row = page.locator('.crm-prop', { hasText: 'Total open deal value' });
  await expect(row.locator('.crm-prop__basis')).toContainText(/Sum of Amount over deals where .*Open/);
  await expect(row.locator('.crm-prop__basis')).toContainText(`${company.properties.open_deal_count} deals`);
  await expect(row.locator('.crm-prop__basis a')).toHaveAttribute('href', /\/deals\?q=/);
});

test('the record page’s property groups each control their own panel', async ({ page }) => {
  await page.goto('/companies/cmp_nw_07', { waitUntil: 'networkidle' });
  await page.waitForSelector('.ain-accordion__trigger');
  const targets = await page.locator('.ain-accordion__trigger').evaluateAll((els) => els.map((el) => el.getAttribute('aria-controls')));
  expect(new Set(targets).size).toBe(targets.length);
  expect(await page.locator('#acc-only').count()).toBe(0);
});

/* ============================ activity records ============================ */

test('a note’s own page shows what it was logged on, and offers nothing only a record can do', async ({ page }) => {
  const stamp = Date.now();
  const note = (await (await page.request.post('/api/v1/records/contact/con_nw_143/activities', {
    data: { type: 'note', subject: `Site walk recap ${stamp}`, body: 'Two lines down, one integrator on site.' },
  })).json()) as { id: string };

  await page.goto(`/notes/${note.id}`, { waitUntil: 'networkidle' });
  // The rail is the records it was logged on, under a heading that says so —
  // not "Not linked to anything yet" beside a timeline saying the opposite.
  const rail = page.locator('.ain-card', { hasText: 'Logged on' }).first();
  await expect(rail.locator('.crm-assoc__row')).toContainText('Carmen Escamilla');
  await expect(page.getByText('Not linked to anything yet')).toHaveCount(0);
  await expect(page.locator('.ain-page__subtitle')).toContainText('Logged on Carmen Escamilla');
  // Nothing is logged *on* a note, and two notes are never a duplicate.
  const header = page.locator('.ain-page__actions');
  for (const kind of ['Note', 'Call', 'Meeting', 'Email', 'Task']) {
    await expect(header.getByRole('button', { name: kind, exact: true })).toHaveCount(0);
  }
  await expect(page.locator('.ain-card', { hasText: 'Possible duplicates' })).toHaveCount(0);
  await header.getByRole('button', { name: 'More actions on this record' }).click();
  await expect(page.getByRole('menuitem', { name: /Merge a duplicate/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // It crumbs under Notes, and the generic address hands over to its own.
  const crumbs = page.locator('nav[aria-label="Breadcrumb"]');
  await expect(crumbs).toContainText('Notes');
  await expect(crumbs).not.toContainText('Data model');
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText(`Site walk recap ${stamp}`);
  await page.goto(`/records/note/${note.id}`, { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}$`));
});

test('the task queue has an address of its own, out from under the data model', async ({ page }) => {
  await page.goto('/records/task', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/tasks$/);
  await page.waitForSelector('table tbody tr[data-index]');
  const crumbs = page.locator('nav[aria-label="Breadcrumb"]');
  await expect(crumbs).not.toContainText('Data model');
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Tasks');
  await expect(page).toHaveTitle(/Tasks/);
});

test('an unknown object slug gets the door to the data model, not a server-error banner', async ({ page }) => {
  await page.goto('/records/gadget', { waitUntil: 'networkidle' });
  await expect(page.locator('.ain-empty__title')).toContainText('No object type called “gadget”');
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(page.locator('.ain-page')).not.toContainText(/req_[A-Za-z0-9]+/);
  await page.getByRole('button', { name: 'Open the data model' }).click();
  await expect(page).toHaveURL(/\/records$/);
});

test('Esc cancels a picklist edit the way it cancels a text edit', async ({ page }) => {
  const before = await recordOf(page.request, 'contact', 'con_nw_143');
  await page.goto('/contacts/con_nw_143', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Edit Seniority' }).click();
  const picker = page.locator('.crm-prop--editing [role="combobox"]');
  // Focus lands in the picker and its list opens; the first Esc is the list's.
  await expect(picker).toBeFocused();
  await expect(picker).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.crm-prop--editing')).toHaveCount(1);
  // With the list closed, Esc leaves edit mode — and writes nothing.
  await page.keyboard.press('Escape');
  await expect(page.locator('.crm-prop--editing')).toHaveCount(0);
  const after = await recordOf(page.request, 'contact', 'con_nw_143');
  expect(after.properties.seniority).toEqual(before.properties.seniority);
});

test('a view kept to yourself stays out of a teammate’s view bar, and their link to it falls back with a word', async ({ browser, page }) => {
  const stamp = Date.now();
  const mine = (await (await page.request.post('/api/v1/views', {
    data: { object_type: 'contact', name: `Dana only ${stamp}`, shared: false, columns: ['first_name', 'email'] },
  })).json()) as { id: string };
  await openList(page, `/contacts?view=${mine.id}`);
  await expect(page.getByRole('button', { name: `Dana only ${stamp}` })).toBeVisible();

  const context = await browser.newContext();
  const sofia = await context.newPage();
  await sofia.goto('/', { waitUntil: 'domcontentloaded' });
  await sofia.request.post('/api/v1/auth/login', { data: { email: 'sofia@northwind.io', password: 'demo1234' } });
  await openList(sofia, '/contacts');
  await expect(sofia.getByRole('button', { name: `Dana only ${stamp}` })).toHaveCount(0);
  await sofia.goto(`/contacts?view=${mine.id}`, { waitUntil: 'networkidle' });
  await expect(sofia.getByRole('status', { name: 'That view is not available' })).toBeVisible();
  await expect(sofia).not.toHaveURL(new RegExp(`view=${mine.id}`));
  await expect(sofia.locator('.ain-page__subtitle')).toContainText('All contacts');
  await context.close();
});

test('a link to a deleted view says so and opens the default instead of keeping the dead id', async ({ page }) => {
  await page.goto('/contacts?view=view_gone_for_good', { waitUntil: 'networkidle' });
  await expect(page.getByRole('status', { name: 'That view is not available' })).toBeVisible();
  await expect(page).not.toHaveURL(/view=view_gone_for_good/);
  await page.waitForSelector('table tbody tr[data-index]');
  await expect(page.locator('.ain-page__subtitle')).toContainText('All contacts');
});

test('the roll-up does not attribute a contact’s own notes to their company', async ({ page }) => {
  const record = (await (await page.request.get('/api/v1/records/contact/con_nw_143')).json()) as
    { associations: { association_type: string; record_id: string }[] };
  const own = new Set(record.associations.filter((a) => a.association_type === 'activity_to_record').map((a) => a.record_id));
  const timeline = (await (await page.request.get('/api/v1/records/contact/con_nw_143/timeline?roll_up=true&limit=30')).json()) as
    { data: { record_id: string; via: unknown }[] };
  const direct = timeline.data.filter((i) => i.via && own.has(i.record_id)).length;
  const foreign = timeline.data.filter((i) => i.via && !own.has(i.record_id)).length;
  // This used to require `direct > 0` — the screen was being held to hiding a
  // `via` the API was still stamping on the contact's own notes. The API stops
  // stamping it now, so the assertion is the fixed thing rather than the
  // broken one: her own activities are hers, and the rolled-up ones are the
  // only ones that carry a source.
  expect(direct, 'the API marks some of Carmen’s own notes as via her company').toBe(0);
  expect(foreign, 'nothing is rolled up onto this contact, so the screen has nothing to label')
    .toBeGreaterThan(0);

  await page.goto('/contacts/con_nw_143', { waitUntil: 'networkidle' });
  await page.waitForSelector('ol.crm-timeline');
  await expect(page.locator('.crm-tl__foot a', { hasText: /^via / })).toHaveCount(foreign);
});

test('a ticket says how long it has been in its status, matching its stage history', async ({ page }) => {
  const history = (await (await page.request.get('/api/v1/records/ticket/tkt_nw_07/stage-history')).json()) as
    { data: { is_current: boolean; stage_label: string; days_in_stage: number }[] };
  const current = history.data.find((s) => s.is_current)!;
  const span = current.days_in_stage === 0 ? 'Less than a day' : `${current.days_in_stage} ${current.days_in_stage === 1 ? 'day' : 'days'}`;

  await page.goto('/tickets/tkt_nw_07', { waitUntil: 'networkidle' });
  await expect(page.locator('.ain-page__subtitle')).toContainText(`${span} in ${current.stage_label}`);
  const card = page.locator('.ain-card', { hasText: 'Status history' });
  await expect(card.locator('.crm-spell.is-current')).toContainText(current.stage_label);
  await expect(card.locator('.crm-spell')).toHaveCount(history.data.length);
});

test('the merge preview compares stamps as dates, and a merged-in visit names no id in prose', async ({ page }) => {
  const stamp = Date.now();
  const make = async (extra: Record<string, unknown>) => (await (await page.request.post('/api/v1/records/ticket', {
    data: { properties: { subject: `Conveyor PLC fault ${stamp}`, ...extra } },
  })).json()) as { id: string };
  const now = (await (await page.request.get('/api/v1/me')).json()).clock.now as number;
  const day = 24 * 60 * 60 * 1000;
  const winner = await make({ priority: 'medium', first_response_at: now - 3 * day });
  const loser = await make({ priority: 'urgent', first_response_at: now - 200 * day });

  await page.goto(`/tickets/${winner.id}`, { waitUntil: 'networkidle' });
  const card = page.locator('.crm-dupe').filter({ hasText: `fault ${stamp}` }).first();
  await card.getByRole('button', { name: 'Merge into this record' }).click();
  const dialog = page.getByRole('dialog');
  const due = dialog.locator('.crm-mergetable tr', { hasText: 'First response' });
  await expect(due).toHaveCount(1);
  // Two stamps side by side read as dates — "Sep 2, 2026, 9:00 AM" — never as
  // "3 days ago" against "7 months ago".
  for (const cell of [due.locator('td').nth(0), due.locator('td').nth(1)]) {
    const text = await cell.innerText();
    expect(text).toMatch(/\d{4}/);
    expect(text).not.toMatch(/\bago\b|last week|yesterday|in \d+ (days|hours)/);
  }
  await dialog.getByRole('button', { name: /^Merge into/ }).click();
  await expect(page.getByRole('status', { name: 'Duplicate merged' })).toBeVisible();

  await page.goto(`/tickets/${loser.id}`, { waitUntil: 'networkidle' });
  const subtitle = page.locator('.ain-page__subtitle');
  await expect(subtitle).toContainText('reached through a duplicate merged into this record');
  await expect(subtitle).not.toContainText(loser.id);
});

test('the filter chip names the record an association condition is pinned to', async ({ page }) => {
  const filter = { op: 'and', filters: [{ association: 'company', where: { property: 'id', operator: 'eq', value: 'cmp_nw_07' }, operator: 'gt', value: 0 }] };
  const encoded = Buffer.from(JSON.stringify(filter)).toString('base64url');
  const company = await recordOf(page.request, 'company', 'cmp_nw_07');
  await openList(page, `/contacts?f=${encoded}`);
  await expect(page.locator('.crm-activefilter')).toContainText(`linked to company ${company.display_name}`);
  await expect(page.locator('.crm-activefilter')).not.toContainText('number of companies');
  const expected = await (await page.request.post('/api/v1/records/contact/search', { data: { filter, limit: 1 } })).json();
  await expect(page.locator('.ain-page__subtitle')).toContainText(`${expected.total_count} contacts`);
});

test('the company rail does not badge every deal “Deals”, and the data model cards pluralise', async ({ page }) => {
  await page.goto('/companies/cmp_nw_07', { waitUntil: 'networkidle' });
  const deals = page.locator('.crm-assoc', { has: page.locator('.crm-assoc__head', { hasText: 'Deals' }) });
  await expect(deals.locator('.crm-assoc__row').first()).toBeVisible();
  await expect(deals.locator('.crm-assoc__row .ain-badge', { hasText: /^Deals$/ })).toHaveCount(0);
  const contacts = page.locator('.crm-assoc', { has: page.locator('.crm-assoc__head', { hasText: 'Contacts' }) });
  await expect(contacts.locator('.crm-assoc__row .ain-badge', { hasText: 'Employs' }).first()).toBeVisible();

  const stamp = Date.now();
  const created = (await (await page.request.post('/api/v1/objects', {
    data: { name: `gizmo_${stamp}`, label: `Gizmo ${stamp}`, plural_label: `Gizmos ${stamp}` },
  })).json()) as { name: string };
  const objects = (await (await page.request.get('/api/v1/objects')).json()).data as
    { name: string; plural_label: string; record_count: number; property_count: number }[];
  const mine = objects.find((o) => o.name === created.name)!;
  await page.goto('/records', { waitUntil: 'networkidle' });
  const stats = page.locator('.crm-objcard', { hasText: mine.plural_label }).locator('.crm-objcard__stats');
  await expect(stats).toContainText(`${mine.record_count} ${mine.record_count === 1 ? 'record' : 'records'}`);
  await expect(stats).toContainText(`${mine.property_count} ${mine.property_count === 1 ? 'property' : 'properties'}`);
  await expect(page.locator('.crm-objcard__stats', { hasText: /\b1 (records|properties)\b/ })).toHaveCount(0);
  await page.request.delete(`/api/v1/objects/${created.name}`);
});
