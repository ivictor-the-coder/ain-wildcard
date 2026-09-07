/**
 * The revenue analytics surface, driven in a real browser.
 *
 * These are operability tests. Every one does through the UI what a finance
 * lead or a billing operator would do — read the board, create the meter, send
 * the event, issue the credit, retry the charge, change the retry policy — and
 * then asks the API whether the workspace actually changed. A screen that
 * renders the right numbers but cannot move any of them passes none of them.
 *
 *   node scripts/preview.mjs --port 8862 --name revenue-ui --fresh
 *   AIN_BASE_URL=http://127.0.0.1:8862 npx playwright test e2e/revenue.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';

const signIn = async (page: Page) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const demo = page.getByRole('button', { name: 'Use the demo workspace' });
  if (await demo.count()) await demo.click();
  await page.waitForSelector('.ain-stat');
};

/**
 * A read, retried once past a rate limit. The suite makes a few hundred API
 * reads in one session; a 429 is the right answer, and a test that reads
 * `undefined.data` off one is a flake rather than a finding.
 */
const json = async (page: Page, path: string): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let attempt = 0; ; attempt++) {
    const res = await page.request.get(`/api${path}`);
    if (res.ok() || attempt === 3) return res.json();
    await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
  }
};

/** The value of the stat tile whose label is exactly this. */
const tile = (page: Page, label: string) => page
  .locator('.ain-stat')
  .filter({ has: page.locator('.ain-stat__label', { hasText: new RegExp(`^${label}$`) }) })
  .locator('.ain-stat__value')
  .first();

test.beforeEach(async ({ page }) => { await signIn(page); });

/* ============================== the board ================================= */

test('the revenue board states the API’s own MRR, in the currency it was asked for', async ({ page }) => {
  const usd = await json(page, '/v1/revenue/summary?months=12&currency=usd');
  await page.goto('/revenue', { waitUntil: 'networkidle' });

  const money = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  await expect(tile(page, 'Monthly recurring revenue')).toHaveText(money(usd.headline.mrr));
  await expect(tile(page, 'Net revenue retention')).toHaveText(usd.headline.net_revenue_retention.percent);
  await expect(tile(page, 'Receivables')).toHaveText(money(usd.headline.receivables));

  // Raw minor units on screen would be the defect.
  await expect(page.locator('.rv-tiles').first()).not.toContainText(String(usd.headline.mrr));

  // The mixed book is stated rather than averaged away.
  const mixed = await json(page, '/v1/revenue/mrr?months=12');
  if (mixed.basis.currency.mode === 'mixed') {
    await expect(page.locator('.ain-banner').first()).toContainText('nothing is converted');
    for (const book of mixed.by_currency) {
      await expect(page.locator('.rv-book', { hasText: `${book.currency.toUpperCase()} BOOK` })).toBeVisible();
    }
  }
});

test('switching the book re-reads every figure in that currency', async ({ page }) => {
  const mixed = await json(page, '/v1/revenue/mrr?months=12');
  test.skip(mixed.basis.currency.mode !== 'mixed', 'this workspace bills in one currency');
  const other = mixed.by_currency.find((row: { currency: string }) => row.currency !== 'usd');

  await page.goto('/revenue', { waitUntil: 'networkidle' });
  await page.locator('.rv-book', { hasText: `${other.currency.toUpperCase()} BOOK` }).click();
  await expect(page).toHaveURL(new RegExp(`currency=${other.currency}`));

  const scoped = await json(page, `/v1/revenue/summary?months=12&currency=${other.currency}`);
  const symbol = other.currency === 'eur' ? '€' : other.currency === 'gbp' ? '£' : '$';
  await expect(tile(page, 'Monthly recurring revenue'))
    .toHaveText(`${symbol}${(scoped.headline.mrr / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
});

test('a month that reconciles draws its waterfall; the table says so for every month', async ({ page }) => {
  const movement = await json(page, '/v1/revenue/movement?months=12&currency=usd&top_movers=6');
  await page.goto('/revenue', { waitUntil: 'networkidle' });

  // The reconciliation is a claim the screen makes out loud, not a silent check.
  const balanced = movement.series.every((row: { reconciliation: { balanced: boolean } }) => row.reconciliation.balanced);
  await expect(page.locator('.ain-badge', { hasText: balanced ? 'Reconciled' : 'Does not reconcile' }).first()).toBeVisible();

  // Every month in the range is on the table with its closing balance.
  const rows = page.locator('table tbody tr');
  await expect.poll(async () => rows.count()).toBeGreaterThanOrEqual(movement.series.length);

  // Picking a month redraws the waterfall for it.
  const target = movement.series[movement.series.length - 3];
  const label = new Date(Date.UTC(Number(target.month.slice(0, 4)), Number(target.month.slice(5)) - 1, 1))
    .toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const chooser = page.getByRole('radiogroup', { name: 'Month to break down' });
  if (await chooser.getByRole('radio', { name: label }).count()) {
    await chooser.getByRole('radio', { name: label }).click();
    await expect(page.locator('.ain-card__title', { hasText: label })).toBeVisible();
  }
});

test('the cohort matrix and ageing buckets carry the counts the API reports', async ({ page }) => {
  const cohorts = await json(page, '/v1/revenue/cohorts?months=12&currency=usd');
  const collections = await json(page, '/v1/revenue/collections?months=12&currency=usd');
  await page.goto('/revenue', { waitUntil: 'networkidle' });

  await expect(page.locator('.rv-cohort__legend')).toContainText(`${cohorts.totals.cohorts} cohorts`);
  for (const bucket of collections.ageing.buckets) {
    const row = page.locator('.rv-row', { hasText: bucket.label }).first();
    await expect(row).toContainText(`${bucket.invoices} invoice`);
  }
});

/* ============================ the credit outbox ========================== */

/**
 * The outbox is read and flushed before anything below mutates it: these two
 * run early on purpose, so the happy path is exercised against the seeded
 * workspace rather than against whatever the rest of the suite left behind.
 */

/** The outbox table, which shares the page with the grants table above it. */
const outbox = (page: Page) => page.locator('.ain-section', { hasText: 'The record' });

/**
 * A pending line on an account a bill can actually be raised for.
 *
 * Raising one drains the account's whole outbox, and invoicing refuses the
 * entire bill if any line in it is in another currency — so "this line matches
 * its account" is not enough; every line the account is holding has to.
 */
const claimableLine = async (page: Page) => {
  const pending = await json(page, '/v1/credit-billable-items?status=pending&limit=200');
  for (const line of pending.data) {
    const account = await json(page, `/v1/customers/${line.customer}`);
    const held = pending.data.filter((row: { customer: string }) => row.customer === account.id);
    if (held.every((row: { currency: string }) => row.currency === account.currency)) return { line, account };
  }
  return null;
};

/**
 * Put a line in the outbox rather than depending on what is already in it: the
 * seeded ones are swept onto a bill by the first billing job that runs, and a
 * top-up is charged and claimed on the spot whenever the account can be billed
 * at once. A settled usage window is what reliably lands there — so this walks
 * the metered prices, finds an account that streams into one of them and bills
 * in the same currency, and settles a window nothing has settled yet.
 */
const seedOutboxLine = async (page: Page) => {
  const now = Date.now();
  const prices = (await json(page, '/v1/prices?limit=100')).data
    .filter((p: { recurring: { meter: string } | null }) => p.recurring?.meter);
  const meters = (await json(page, '/v1/meters')).data;
  for (const price of prices) {
    const meter = meters.find((m: { id: string; event_name: string }) =>
      m.id === price.recurring.meter || m.event_name === price.recurring.meter);
    if (!meter) continue;
    const users = await json(page, `/v1/meters/${meter.id}/customers?start=${now - 3 * 86_400_000}&end=${now}&limit=25`);
    for (const row of users.data.filter((r: { value: number }) => r.value > 0)) {
      const account = await json(page, `/v1/customers/${row.customer}`);
      if (account.currency !== price.currency) continue;
      const res = await page.request.post('/api/v1/credit-settlements', {
        data: { customer: row.customer, price: price.id, period_start: now - 3 * 86_400_000, period_end: now },
      });
      if (!res.ok()) continue;
      const settled = await res.json();
      if ((settled.lines ?? []).some((line: { status: string }) => line.status === 'pending')) return account;
    }
  }
  return null;
};

test('pending credit lines can be invoiced from the credits screen', async ({ page }) => {
  await seedOutboxLine(page);

  const target = await claimableLine(page);
  test.skip(!target, 'nothing is waiting that a bill for its own account could claim');
  const { account } = target as { account: { id: string; name: string; currency: string } };
  const before = await json(page, '/v1/credit-billable-items?status=pending&limit=200');
  const mine = before.data.filter((row: { customer: string; currency: string }) =>
    row.customer === account.id && row.currency === account.currency);

  await page.goto('/revenue/credits', { waitUntil: 'networkidle' });
  await page.getByRole('radio', { name: 'Lines waiting to be invoiced' }).click();

  // The outbox is flushed from the row that shows the line.
  const row = outbox(page).locator('tbody tr', { hasText: account.name }).first();
  await row.getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^Invoice ${account.name}`) }).click();

  const dialog = page.getByRole('dialog');
  // It states what will be billed before it bills it.
  await expect(dialog).toContainText('Invoice 1 account');
  const commit = dialog.getByRole('button', { name: /^Raise/ });
  await expect(commit).toBeEnabled();
  await expect(commit).toContainText(account.currency === 'usd' ? '$' : account.currency === 'eur' ? '€' : '£');
  await commit.click();

  await expect(dialog.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText(`${mine.length} line`);

  // Every line for that account in its own currency is now on a bill.
  const after = await json(page, '/v1/credit-billable-items?status=pending&limit=200');
  const left = after.data.filter((r: { customer: string; currency: string }) =>
    r.customer === account.id && r.currency === account.currency);
  expect(left).toHaveLength(0);
});

test('the outbox refuses to promise a bill it cannot raise', async ({ page }) => {
  // A period priced in one currency, settled for an account that bills in
  // another, leaves a line no bill for that account can carry. The screen says
  // so rather than offering a button that would fail.
  const grants = await json(page, '/v1/credit-grants?status=active&limit=100');
  const unit = grants.data.find((g: { kind: string; meter: string | null }) => g.kind === 'unit' && g.meter);
  test.skip(!unit, 'no unit grant is active');
  const account = await json(page, `/v1/customers/${unit.customer}`);
  const prices = await json(page, '/v1/prices?limit=100');
  const meters = await json(page, '/v1/meters');
  const meter = meters.data.find((m: { id: string }) => m.id === unit.meter);
  const metered = prices.data.find((p: { recurring: { meter: string } | null; currency: string }) =>
    (p.recurring?.meter === unit.meter || p.recurring?.meter === meter?.event_name) && p.currency !== account.currency);
  test.skip(!metered, 'every metered price is in this account’s own currency');

  await page.request.post('/api/v1/credit-settlements', {
    data: {
      customer: unit.customer, price: metered.id,
      period_start: Date.now() - 20 * 86_400_000, period_end: Date.now(),
    },
  });
  const pending = await json(page, '/v1/credit-billable-items?status=pending&limit=200');
  const stranded = pending.data.filter((row: { customer: string; currency: string }) =>
    row.customer === unit.customer && row.currency !== account.currency);
  test.skip(!stranded.length, 'the settlement produced nothing in a foreign currency');

  await page.goto('/revenue/credits', { waitUntil: 'networkidle' });
  await page.getByRole('radio', { name: 'Lines waiting to be invoiced' }).click();
  const row = outbox(page).locator('tbody tr', { hasText: account.name }).first();
  await row.getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^Invoice ${account.name}`) }).click();

  const dialog = page.getByRole('dialog');
  // Invoicing drains the whole outbox and refuses the entire bill over one
  // foreign line, so the account is left out of the run and told why.
  await expect(dialog).toContainText('cannot be billed at all');
  await expect(dialog).toContainText(`bills in ${account.currency.toUpperCase()}`);
  await expect(dialog.getByRole('button', { name: 'Nothing can be billed' })).toBeDisabled();
});

/* ================================ usage =================================== */

test('a meter can be created, edited and paused through the UI', async ({ page }) => {
  // Both the display name and the event name carry the run's stamp, so a second
  // run against the same workspace edits its own meter rather than the last
  // run's — the table is addressed by the event name, which is unique by
  // construction.
  const stamp = Date.now();
  const eventName = `pw_widgets_${stamp}`;
  const meterName = `Playwright widgets ${stamp}`;
  await page.goto('/revenue/usage', { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'New meter' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(meterName);
  await dialog.getByLabel('Event name').fill(eventName);
  await dialog.getByLabel('Value key').fill('widgets');
  await dialog.getByLabel('Unit label').fill('widget');
  await dialog.getByRole('button', { name: 'Create meter' }).click();
  await expect(dialog).toBeHidden();

  // It exists on the server, with the shape the form promised.
  const created = await expect.poll(async () => {
    const meters = await json(page, '/v1/meters');
    return meters.data.find((m: { event_name: string }) => m.event_name === eventName) ?? null;
  }).not.toBeNull().then(async () => {
    const meters = await json(page, '/v1/meters');
    return meters.data.find((m: { event_name: string }) => m.event_name === eventName);
  });
  expect(created.aggregation).toBe('sum');
  expect(created.value_key).toBe('widgets');
  expect(created.unit_label).toBe('widget');

  // Editing writes through: pause it and the table says so.
  const row = page.locator('tbody tr', { hasText: eventName }).first();
  await expect(row).toContainText(meterName);
  await row.getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit meter' }).click();
  const edit = page.getByRole('dialog');
  await edit.getByLabel('Status').selectOption('inactive');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(async () => (await json(page, `/v1/meters/${created.id}`)).status).toBe('inactive');
  await expect(page.locator('tbody tr', { hasText: eventName }).first()).toContainText('Inactive');
});

test('an event can be recorded by hand, and a replay of it writes nothing', async ({ page }) => {
  const identifier = `pw-ingest-${Date.now()}`;
  const meters = await json(page, '/v1/meters?status=active');
  const meter = meters.data.find((m: { aggregation: string }) => m.aggregation === 'sum');
  const customers = await json(page, '/v1/customers?limit=5');
  const customer = customers.data[0];

  await page.goto('/revenue/usage', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Record an event' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Meter').selectOption(meter.id);
  await dialog.getByLabel('Customer').selectOption(customer.id);
  await dialog.getByLabel('Identifier').fill(identifier);
  await dialog.getByLabel(/^Value/).fill('4200');
  await dialog.getByRole('button', { name: 'Send event' }).click();

  await expect(dialog.locator('.ain-banner', { hasText: 'Recorded' })).toBeVisible();
  const recorded = await json(page, `/v1/meter-events/${identifier}`);
  expect(recorded.identifier).toBe(identifier);
  expect(Number(recorded.value)).toBe(4200);

  // The same identifier again: the screen says duplicate, and the server still
  // holds exactly one event.
  await dialog.getByRole('button', { name: 'Send event' }).click();
  await expect(dialog.locator('.ain-banner', { hasText: 'Duplicate' })).toBeVisible();
  const after = await json(page, `/v1/meter-events?meter=${meter.id}&limit=200`);
  const matches = after.data.filter((e: { identifier: string }) => e.identifier === identifier);
  expect(matches).toHaveLength(1);
});

test('an event that should never have been recorded can be withdrawn from the inspector', async ({ page }) => {
  const identifier = `pw-withdraw-${Date.now()}`;
  const meters = await json(page, '/v1/meters?status=active');
  const meter = meters.data.find((m: { aggregation: string }) => m.aggregation === 'sum');
  const customers = await json(page, '/v1/customers?limit=5');
  await page.request.post('/api/v1/meter-events', {
    data: { event_name: meter.event_name, customer: customers.data[0].id, identifier, value: 17, payload: {} },
  });

  await page.goto('/revenue/usage', { waitUntil: 'networkidle' });
  await page.getByPlaceholder('Search identifiers and customers…').fill(identifier);
  const row = page.locator('tbody tr', { hasText: identifier }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: 'Withdraw this event' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Recorded twice by the e2e gateway');
  await dialog.getByRole('button', { name: 'Withdraw event' }).click();

  await expect.poll(async () => {
    const adjustments = await json(page, '/v1/meter-event-adjustments?limit=200');
    return adjustments.data.some((a: { identifier: string }) => a.identifier === identifier);
  }).toBe(true);
  const event = await json(page, `/v1/meter-events/${identifier}`);
  expect(event.cancelled).toBe(true);
});

test('a meter’s own page charts its volume at the granularity you choose', async ({ page }) => {
  const meters = await json(page, '/v1/meters?status=active');
  const meter = meters.data.find((m: { aggregation: string }) => m.aggregation === 'sum');
  await page.goto(`/revenue/usage/${meter.id}`, { waitUntil: 'networkidle' });

  await expect(page.getByRole('heading', { name: meter.name })).toBeVisible();
  const detail = await json(page, `/v1/meters/${meter.id}`);
  await expect(tile(page, 'Events recorded')).toHaveText(detail.ingestion.event_count.toLocaleString('en-US'));

  // The granularity control drives the series that is drawn.
  await page.getByRole('radiogroup', { name: 'Granularity' }).getByRole('radio', { name: 'Monthly' }).click();
  await expect(page.locator('.ain-chart').first()).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Window' }).getByRole('radio', { name: '90d' }).click();
  await expect(page.locator('.ain-chart').first()).toBeVisible();
});

/* =============================== credits ================================== */

test('credit can be issued to an account and shows up in that grant’s ledger', async ({ page }) => {
  const customers = await json(page, '/v1/customers?limit=50&currency=usd');
  const account = customers.data[0];
  const name = `Playwright goodwill ${Date.now()}`;

  await page.goto('/revenue/credits', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Issue credit' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Customer').selectOption(account.id);
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await dialog.getByLabel(/^Amount/).fill('250.00');
  await dialog.getByLabel('Reason').fill('Goodwill after the e2e outage');
  await dialog.getByRole('button', { name: 'Issue credit' }).click();
  await expect(dialog).toBeHidden();

  const grants = await json(page, '/v1/credit-grants?limit=500');
  const grant = grants.data.find((g: { name: string }) => g.name === name);
  expect(grant).toBeTruthy();
  expect(grant.amount).toBe(25000);
  expect(grant.balance).toBe(25000);

  // The row is on screen in money, not in minor units.
  const row = page.locator('tbody tr', { hasText: name }).first();
  await expect(row).toContainText('$250.00');
  await expect(row).not.toContainText('25000');

  // Its ledger opens and reconciles.
  await row.click();
  const drawer = page.getByRole('dialog').last();
  await expect(drawer.locator('.ain-banner', { hasText: 'The ledger reconciles' })).toBeVisible();
  await expect(drawer.locator('tbody tr', { hasText: 'Goodwill after the e2e outage' })).toBeVisible();
});

/**
 * What the grant's own book says it is worth, and whether that book adds up.
 * `balance` on the grant is a summary; the ledger is the thing it summarises,
 * and a void that leaves the two disagreeing is credit that exists in one place
 * and not the other. `reconciled` is the module's own lie detector: it re-adds
 * every delta on read and checks it against the running total each entry
 * carries.
 */
const ledgerOf = async (page: Page, grantId: string): Promise<{ balance: number; reconciled: boolean; entries: { type: string; delta: number }[] }> => {
  const read = await json(page, `/v1/credit-grants/${grantId}/ledger`);
  const entries = read.entries as { type: string; delta: number }[];
  return { balance: entries.reduce((total, entry) => total + entry.delta, 0), reconciled: read.reconciled, entries };
};

test('a grant can be edited and its unused balance voided', async ({ page }) => {
  const customers = await json(page, '/v1/customers?limit=50&currency=usd');
  const AMOUNT = 5000;
  const created = await page.request.post('/api/v1/credit-grants', {
    data: {
      customer: customers.data[0].id, name: `Playwright voidable ${Date.now()}`, category: 'promotional',
      kind: 'monetary', currency: 'usd', amount: AMOUNT, applicability: { scope: 'all' },
    },
  });
  const grant = await created.json();

  const before = await ledgerOf(page, grant.id);
  expect(before.reconciled).toBe(true);
  expect(before.balance).toBe(AMOUNT);
  expect(grant.balance).toBe(before.balance);

  await page.goto('/revenue/credits', { waitUntil: 'networkidle' });
  await page.getByPlaceholder('Search grants and accounts…').fill(grant.name);
  const row = page.locator('tbody tr', { hasText: grant.name }).first();

  await row.getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: /Edit name/ }).click();
  const edit = page.getByRole('dialog');
  await edit.getByLabel('Priority').fill('50');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(async () => (await json(page, `/v1/credit-grants/${grant.id}`)).priority).toBe(50);

  await row.getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: /Void the remaining balance/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Pilot ended without conversion');
  await dialog.getByRole('button', { name: 'Void balance' }).click();

  await expect.poll(async () => (await json(page, `/v1/credit-grants/${grant.id}`)).status).toBe('voided');
  await expect.poll(async () => (await json(page, `/v1/credit-grants/${grant.id}`)).balance).toBe(0);

  // The money has to be gone from the book, not only from the summary: one
  // `void` entry for exactly what was unspent, the deltas still adding to the
  // running totals, and nothing left to draw.
  const after = await ledgerOf(page, grant.id);
  expect(after.reconciled).toBe(true);
  expect(after.balance).toBe(0);
  const voided = after.entries.filter((entry) => entry.type === 'void');
  expect(voided.map((entry) => entry.delta)).toEqual([-before.balance]);
  expect((await json(page, `/v1/credit-grants/${grant.id}`)).balance).toBe(after.balance);

  // And nothing that adds credit up for this account still counts it.
  const balances = await json(page, `/v1/customers/${grant.customer}/credit-balance`);
  expect(JSON.stringify(balances)).not.toContain(grant.id);
});

test('a usage period can be settled from the credits screen, drawing the grants that apply', async ({ page }) => {
  const prices = await json(page, '/v1/prices?limit=100');
  const metered = prices.data.find((p: { recurring: { meter: string } | null }) => p.recurring?.meter);
  test.skip(!metered, 'no metered price exists');
  const grants = await json(page, '/v1/credit-grants?status=active&limit=100');
  const grant = grants.data.find((g: { kind: string; meter: string | null }) => g.kind === 'unit' && g.meter);
  test.skip(!grant, 'no unit grant is active');

  const before = await json(page, '/v1/credit-settlements?status=all&limit=200');
  await page.goto('/revenue/credits', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Settle a period' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Customer').selectOption(grant.customer);
  await dialog.getByLabel('Metered price').selectOption(metered.id);
  // The confirm carries the figure it is about to bill as soon as the window
  // has been priced, so it is matched on any of the three states it can be in.
  const settle = dialog.getByRole('button', { name: /Settle period|Bill about|Pricing/ });
  await expect(settle).toBeEnabled();
  await settle.click();

  // Two honest outcomes, and the dialog states whichever one the server gave.
  // A window that is already settled must not be settled again — drawing credit
  // twice for usage that has been billed once is the failure this refusal
  // exists to prevent — so the run is asserted against what actually happened
  // rather than against the answer that is convenient.
  const banner = dialog.locator('.ain-banner').first();
  await expect(banner).toBeVisible();
  const said = (await banner.textContent()) ?? '';
  const after = await json(page, '/v1/credit-settlements?status=all&limit=200');
  if (/already settled/.test(said)) {
    // The refusal is the screen's own sentence, not the API's. This used to
    // look for "Settlement <id> already covers …", which is what
    // `/v1/credit-settlements` answers a developer with — asserting it meant
    // asserting that an operator was shown a raw settlement id and two ISO
    // stamps. The dialog names the window, the price and the money instead, so
    // that is what is checked, ids and stamps included out.
    expect(said).toMatch(/is already settled on .+would draw credit twice/s);
    expect(said, 'a refusal an operator reads must not carry a raw id').not.toMatch(/\b[a-z]{2,}_[A-Za-z0-9]{8,}\b/);
    expect(said, 'nor an ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(after.data.length).toBe(before.data.length);
  } else {
    expect(said).toContain('priced at');
    expect(after.data.length).toBeGreaterThan(before.data.length);
  }
});

/* =============================== recovery ================================= */

test('a refused bill can be retried, read attempt by attempt, and stood down', async ({ page }) => {
  // Whether a seeded campaign is still being chased depends on where the
  // workspace clock landed, so the read path is asserted against whatever the
  // queue holds and the write path runs on a campaign that can still take it.
  const all = await json(page, '/v1/dunning?status=all&limit=50');
  test.skip(!all.data.length, 'this workspace has never chased a bill');
  const chaseable = all.data.find((row: { status: string }) => row.status === 'recovering' || row.status === 'open');
  const campaign = chaseable ?? all.data[0];

  await page.goto('/revenue/dunning?status=all', { waitUntil: 'networkidle' });
  // Located by invoice number: one account can be in recovery on several bills.
  const row = page.locator('tbody tr', { hasText: campaign.invoice_number }).first();
  await expect(row).toContainText(`${campaign.attempt_count} / ${campaign.max_attempts}`);
  // The amount at risk is money on screen, never the minor units behind it.
  await expect(row).not.toContainText(String(campaign.amount_at_risk));
  // A campaign nobody is chasing any more does not keep quoting the figure in
  // a column headed "At risk" — the tiles above it count zero for that row.
  if (campaign.status === 'recovered' || campaign.status === 'canceled') {
    await expect(row).toContainText(campaign.status === 'recovered' ? 'recovered' : 'no longer chased');
  }

  /* ---- retry the charge from the row's own menu, which asks first ---- */
  if (chaseable) {
    await row.getByRole('button', { name: 'Row actions' }).click();
    await page.getByRole('menuitem', { name: 'Retry the charge now' }).click();
    // Presenting a card is money moving on somebody else's account: it names
    // the amount, the card and the attempt it is about to spend, and nothing
    // has been charged while the question is on screen.
    const ask = page.getByRole('dialog').last();
    await expect(ask).toContainText(`attempt ${campaign.attempt_count + 1} of ${campaign.max_attempts}`);
    expect((await json(page, `/v1/dunning/${campaign.id}`)).attempt_count).toBe(campaign.attempt_count);
    await ask.getByRole('button', { name: /^Present/ }).click();
    await expect(page.locator('.ain-toast').first()).toBeVisible();
    await expect.poll(async () => (await json(page, `/v1/dunning/${campaign.id}`)).attempt_count)
      .toBeGreaterThan(campaign.attempt_count);
  }

  /* ---- every attempt is on the record, in the drawer ---- */
  const after = await json(page, `/v1/dunning/${campaign.id}`);
  await page.locator('tbody tr', { hasText: campaign.invoice_number }).first().click();
  const drawer = page.getByRole('dialog').last();
  await expect(drawer.locator('.ain-timeline__item')).toHaveCount(after.attempts.length);
  await expect(drawer.locator('.ain-banner', { hasText: 'What to do' }))
    .toContainText(after.recommended_action.slice(0, 40));

  /* ---- and the chase can be stood down without touching the bill ---- */
  const stillOpen = after.status === 'recovering' || after.status === 'open';
  if (!stillOpen) {
    await expect(drawer.getByRole('button', { name: 'Stop chasing this bill' })).toHaveCount(0);
    return;
  }
  const owedBefore = (await json(page, `/v1/invoices/${campaign.invoice}`)).amount_due;
  await drawer.getByRole('button', { name: 'Stop chasing this bill' }).click();
  const dialog = page.getByRole('dialog').last();
  await dialog.getByLabel('Reason').fill('Collections took this account over by phone');
  await dialog.getByRole('button', { name: 'Stop chasing' }).click();

  await expect.poll(async () => (await json(page, `/v1/dunning/${campaign.id}`)).status).toBe('canceled');
  // Standing the chase down does not touch what is owed.
  expect((await json(page, `/v1/invoices/${campaign.invoice}`)).amount_due).toBe(owedBefore);
});

test('the retry policy can be changed, and the schedule explains itself afterwards', async ({ page }) => {
  const before = await json(page, '/v1/payments/settings');
  const target = before.dunning.max_attempts === 5 ? 6 : 5;

  await page.goto('/revenue/dunning', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Retry policy' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Maximum attempts').fill(String(target));
  await dialog.getByLabel('Skip weekends').click();
  await dialog.getByRole('button', { name: 'Save policy' }).click();

  await expect.poll(async () => (await json(page, '/v1/payments/settings')).dunning.max_attempts).toBe(target);
  await expect.poll(async () => (await json(page, '/v1/payments/settings')).dunning.skip_weekends)
    .toBe(!before.dunning.skip_weekends);

  // The card re-reads the policy it just wrote.
  await expect(page.locator('.rv-fieldrow, .ain-dl__row').filter({ hasText: 'Maximum attempts' }).first())
    .toContainText(String(target));
});

/* ========================= periods and boundaries ========================= */

/**
 * A calendar boundary is not an instant. The workspace runs on America/New_York
 * and every month key, grant expiry and period edge the API returns is midnight
 * UTC — so rendering them in the workspace timezone files each one a day, and a
 * month, early. This is the test that a September movement is not labelled
 * August on the first of September.
 */
test('every month and calendar date is labelled the way the API means it', async ({ page }) => {
  const movement = await json(page, '/v1/revenue/movement?months=6&currency=usd&top_movers=6');
  const latest = movement.series[movement.series.length - 1];
  const label = (month: string, withYear: boolean) => new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1),
  ).toLocaleString('en-US', { month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });

  await page.goto('/revenue?months=6', { waitUntil: 'networkidle' });

  // The waterfall names the month the API put the movement in.
  await expect(page.locator('.ain-card__title', { hasText: `${label(latest.month, true)} movement` })).toBeVisible();
  // The chip row ends on that same month.
  const chips = page.getByRole('radiogroup', { name: 'Month to break down' });
  await expect(chips.getByRole('radio').last()).toHaveText(label(latest.month, false));
  // And picking a chip writes the month key it is named after.
  const earlier = movement.series[movement.series.length - 3];
  await chips.getByRole('radio', { name: label(earlier.month, false) }).click();
  await expect(page).toHaveURL(new RegExp(`month=${earlier.month}`));

  // The cohort matrix labels its rows the same way.
  const cohorts = await json(page, '/v1/revenue/cohorts?months=6&currency=usd');
  if (cohorts.series.length) {
    await expect(page.locator('.rv-cohort th[scope="row"]').first())
      .toHaveText(label(cohorts.series[0].cohort, true));
  }
});

test('a grant expiry reads the same in the table as in the dialog that edits it', async ({ page }) => {
  const grants = await json(page, '/v1/credit-grants?limit=500');
  const dated = grants.data.find((g: { expires_at: number | null }) => g.expires_at !== null);
  test.skip(!dated, 'no grant in this workspace expires');
  const expected = new Date(dated.expires_at).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });

  await page.goto('/revenue/credits', { waitUntil: 'networkidle' });
  await page.getByPlaceholder('Search grants and accounts…').fill(dated.name);
  const row = page.locator('tbody tr', { hasText: dated.name }).first();
  await expect(row).toContainText(expected);

  await row.getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: /Edit name/ }).click();
  // The DatePicker reads UTC dates; the table must agree with it.
  await expect(page.getByRole('dialog').getByLabel('Expires')).toContainText(expected);
});

/* ======================= money is stated before it moves ================== */

test('selling a credit pack states the tiered total before it raises the charge', async ({ page }) => {
  const prices = await json(page, '/v1/prices?limit=100');
  const tiered = prices.data.find((p: { billing_scheme: string; tiers_mode: string | null }) =>
    p.billing_scheme === 'tiered' && p.tiers_mode === 'volume');
  test.skip(!tiered, 'no volume-tiered price exists');
  const customers = await json(page, `/v1/customers?limit=50&currency=${tiered.currency}`);
  const account = customers.data[0];

  // What the catalogue says six of them cost.
  const quote = await (await page.request.post(`/api/v1/prices/${tiered.id}/preview`, { data: { quantity: 6 } })).json();
  const money = (minor: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(minor / 100);

  await page.goto('/revenue/credits', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sell a pack' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Customer').selectOption(account.id);
  await dialog.getByLabel('Price').selectOption(tiered.id);
  await dialog.getByLabel('Packs').fill('6');
  await dialog.getByLabel('Packs').blur();

  // A ladder is never quoted at the first rung as if it were flat.
  await expect(dialog.locator('select').nth(1)).toContainText('from');
  // The total is on screen, and the button says what pressing it will charge.
  await expect(dialog.locator('.rv-preview__amount')).toHaveText(money(quote.amount, quote.currency));
  const commit = dialog.getByRole('button', { name: new RegExp(`Charge`) });
  await expect(commit).toContainText(money(quote.amount, quote.currency));

  const before = await json(page, '/v1/credit-billable-items?limit=200');
  await commit.click();
  await expect(dialog).toBeHidden();

  // And the charge that was raised is the amount the dialog stated — whether
  // it is still in the outbox or already claimed onto a bill.
  const after = await json(page, '/v1/credit-billable-items?limit=200');
  const seen = new Set(before.data.map((row: { id: string }) => row.id));
  const raised = after.data.filter((row: { id: string; kind: string }) => !seen.has(row.id) && row.kind === 'topup');
  expect(raised).toHaveLength(1);
  expect(raised[0].amount).toBe(quote.amount);
});

test('settling a period states what the window is worth before it bills it', async ({ page }) => {
  const prices = await json(page, '/v1/prices?limit=100');
  const meters = await json(page, '/v1/meters');
  const grants = await json(page, '/v1/credit-grants?status=active&limit=100');
  const grant = grants.data.find((g: { kind: string; meter: string | null }) => g.kind === 'unit' && g.meter);
  test.skip(!grant, 'no unit grant is active');
  // The grant only pays for its own meter, so the price has to bill from it —
  // a price naming any other meter would correctly report no eligible credit.
  const meter = meters.data.find((m: { id: string }) => m.id === grant.meter);
  const metered = prices.data.find((p: { recurring: { meter: string } | null }) =>
    p.recurring?.meter === grant.meter || p.recurring?.meter === meter?.event_name);
  test.skip(!metered, 'no price bills from the meter this grant pays for');

  await page.goto('/revenue/credits?new=settle', { waitUntil: 'networkidle' });
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Customer').selectOption(grant.customer);
  await dialog.getByLabel('Metered price').selectOption(metered.id);

  // The preview states the quantity, the tier arithmetic and the credit that
  // will be drawn against it — before the button that bills it is enabled.
  await expect(dialog.locator('.rv-preview__label')).toHaveText('This period is worth');
  await expect(dialog.locator('.rv-preview__amount')).not.toHaveText('—');
  await expect(dialog.locator('.rv-preview')).toContainText('Credit available');
  await expect(dialog.getByRole('button', { name: /^Bill about/ })).toBeEnabled();
});

/* ============================ the outbox flushes ========================== */

/* ============================== meter lifecycle ========================== */

test('a meter can be archived, which frees its event name for a new one', async ({ page }) => {
  const stamp = Date.now();
  const eventName = `pw_archive_${stamp}`;
  await page.goto('/revenue/usage?new=meter', { waitUntil: 'networkidle' });

  let dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`Archivable ${stamp}`);
  await dialog.getByLabel('Event name').fill(eventName);
  await dialog.getByRole('button', { name: 'Create meter' }).click();
  await expect(dialog).toBeHidden();

  const meters = await json(page, '/v1/meters');
  const created = meters.data.find((m: { event_name: string }) => m.event_name === eventName);
  expect(created).toBeTruthy();

  // The same event name is refused, and the refusal offers the archive it names.
  await page.getByRole('button', { name: 'New meter' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`Clash ${stamp}`);
  await dialog.getByLabel('Event name').fill(eventName);
  await dialog.getByRole('button', { name: 'Create meter' }).click();
  await expect(dialog.locator('.ain-banner')).toContainText('already route to meter');
  await dialog.getByRole('button', { name: 'Archive that meter' }).click();

  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('becomes available to a new meter');
  await confirm.getByRole('button', { name: 'Archive the meter' }).click();

  await expect.poll(async () => (await json(page, `/v1/meters/${created.id}`)).status).toBe('archived');

  // And the name really is free — the advice the API gives is now advice that works.
  await page.getByRole('button', { name: 'New meter' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`Reclaimed ${stamp}`);
  await dialog.getByLabel('Event name').fill(eventName);
  await dialog.getByRole('button', { name: 'Create meter' }).click();
  await expect(dialog).toBeHidden();
  const reclaimed = (await json(page, '/v1/meters')).data.find((m: { event_name: string }) => m.event_name === eventName);
  expect(reclaimed.name).toBe(`Reclaimed ${stamp}`);
});

test('a meter is never created with an acceptance window the form is not showing', async ({ page }) => {
  const stamp = Date.now();
  await page.goto('/revenue/usage?new=meter', { waitUntil: 'networkidle' });
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`Window ${stamp}`);
  await dialog.getByLabel('Event name').fill(`pw_window_${stamp}`);

  // Text that is not a number of days is refused rather than clamped silently.
  await dialog.getByLabel('Acceptance window').fill('flush');
  await expect(dialog.getByRole('button', { name: 'Create meter' })).toBeDisabled();
  await expect(dialog).toContainText('is not a number of days');

  await dialog.getByLabel('Acceptance window').fill('35');
  await dialog.getByRole('button', { name: 'Create meter' }).click();
  await expect(dialog).toBeHidden();

  const made = (await json(page, '/v1/meters')).data.find((m: { event_name: string }) => m.event_name === `pw_window_${stamp}`);
  expect(made.acceptance_window_ms).toBe(35 * 86_400_000);
});

/* ============================== the board acts =========================== */

test('an ageing bucket opens the invoices that are actually in it', async ({ page }) => {
  const collections = await json(page, '/v1/revenue/collections?months=12&currency=usd');
  const bucket = collections.ageing.buckets.find((b: { invoices: number }) => b.invoices > 0);
  test.skip(!bucket, 'nothing is outstanding in the USD book');

  await page.goto('/revenue', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: new RegExp(`^${bucket.label}`) }).click();

  const drawer = page.getByRole('dialog').last();
  await expect(drawer.getByRole('heading', { name: bucket.label })).toBeVisible();
  // Exactly the invoices the tile counted, not every open bill.
  await expect(drawer.locator('.rv-row')).toHaveCount(bucket.invoices);
  await expect(drawer).toContainText('exactly what the bucket reported');
});

test('the accounts filter reads dollars, and the narrowed table survives a reload', async ({ page }) => {
  const accounts = await json(page, '/v1/revenue/accounts?months=12&currency=usd&limit=200');
  const over = accounts.data.filter((row: { mrr: number }) => row.mrr >= 150_000).length;
  test.skip(over === 0 || over === accounts.data.length, 'the filter would not narrow anything');

  await page.goto('/revenue', { waitUntil: 'networkidle' });
  const section = page.locator('.ain-section', { hasText: 'Accounts by size' });
  await expect(section.locator('tbody tr')).toHaveCount(accounts.data.length);

  await section.getByRole('button', { name: /Filters/ }).click();
  await section.getByRole('button', { name: /^Filter$/ }).click();
  // The column names its currency, because the number typed into it is money.
  await page.getByRole('menuitem', { name: /MRR in USD/ }).click();
  const editor = page.locator('.ain-filtered').first();
  await editor.getByRole('combobox').first().selectOption('gte');
  await editor.locator('input').first().fill('1500');
  await page.keyboard.press('Enter');

  // 1500 means $1,500 — not fifteen dollars.
  await expect(section.locator('tbody tr')).toHaveCount(over);
  await expect(page).toHaveURL(/afilter=/);

  await page.reload({ waitUntil: 'networkidle' });
  await expect(section.locator('tbody tr')).toHaveCount(over);
  await expect(section.locator('.ain-chip')).toContainText('is at least');
});

/* ============================ recovery, precisely ======================== */

test('bulk retry counts only the campaigns it can actually present again', async ({ page }) => {
  const all = await json(page, '/v1/dunning?status=all&limit=50');
  // A settled or stood-down campaign cannot be presented again; an exhausted
  // one can, by hand, which is exactly what its own advice tells an operator
  // to do once there is a card worth charging.
  const retryable = all.data.filter((row: { status: string }) => row.status !== 'recovered' && row.status !== 'canceled');
  test.skip(all.data.length < 2 || retryable.length === all.data.length, 'every campaign here is retryable');

  await page.goto('/revenue/dunning?status=all', { waitUntil: 'networkidle' });
  await page.locator('thead input[type=checkbox]').first().click();

  if (retryable.length === 0) {
    // Nothing in the selection can be presented again, and the button says so
    // rather than offering to retry rows it will skip.
    await expect(page.getByRole('button', { name: 'Nothing to retry' })).toBeDisabled();
    return;
  }

  const button = page.getByRole('button', { name: new RegExp(`Retry ${retryable.length} of ${all.data.length} selected`) });
  await expect(button).toBeVisible();

  // And it confirms, naming the amount at risk, before spending an attempt.
  await button.click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('spends an attempt');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
});

test('the retry policy accepts every option its own dropdown offers', async ({ page }) => {
  const before = await json(page, '/v1/payments/settings');
  await page.goto('/revenue/dunning?policy=1', { waitUntil: 'networkidle' });
  const dialog = page.getByRole('dialog');

  // The option that used to fail every save, chosen alongside another edit —
  // a rejected request would take the second change down with it.
  await dialog.getByLabel('When the schedule runs out').selectOption({ label: 'Leave the bill open and stop trying' });
  await dialog.getByLabel('Skip weekends').click();
  await dialog.getByRole('button', { name: 'Save policy' }).click();

  await expect(page.locator('.ain-toast')).toContainText('Retry policy saved');
  await expect.poll(async () => (await json(page, '/v1/payments/settings')).dunning.end_behavior).toBe('leave_past_due');
  expect((await json(page, '/v1/payments/settings')).dunning.skip_weekends).toBe(!before.dunning.skip_weekends);
  await expect(page.locator('.ain-dl__row, .rv-fieldrow').filter({ hasText: 'When the schedule runs out' }).first())
    .toContainText('Leave the bill open');

  // Put the workspace back the way it was found.
  await page.request.patch('/api/v1/payments/settings', {
    data: { dunning: { end_behavior: before.dunning.end_behavior, skip_weekends: before.dunning.skip_weekends } },
  });
});

/* ===================== what the button says is what it does ============== */

/**
 * The mouse path: type a quantity and press the button, with no Tab in
 * between.
 *
 * This is how anyone actually sells a pack, and it used to charge the previous
 * quantity's price — the field lifted its value on blur, so the quote, and the
 * money printed on the control, belonged to the number that was there before.
 * The test drives it the way the trap needs: the value is set and the button
 * pressed inside one tick, with nothing awaited between them.
 */
test('a pack sale can never charge an amount the button was not showing', async ({ page }) => {
  const prices = await json(page, '/v1/prices?limit=100');
  const tiered = prices.data.find((p: { billing_scheme: string; tiers_mode: string | null }) =>
    p.billing_scheme === 'tiered' && p.tiers_mode === 'volume');
  test.skip(!tiered, 'no volume-tiered price exists');
  const customers = await json(page, `/v1/customers?limit=50&currency=${tiered.currency}`);
  const account = customers.data[0];

  const charges: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/v1/credit-topups')) charges.push(req.postData() ?? '');
  });

  await page.goto('/revenue/credits?new=topup', { waitUntil: 'networkidle' });
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Customer').selectOption(account.id);
  await dialog.getByLabel('Price').selectOption(tiered.id);
  await expect(dialog.getByRole('button', { name: /^Charge/ })).toBeEnabled();

  // One tick: the field changes and the button is pressed, with no blur.
  const sameTick = await page.evaluate(() => {
    const field = [...document.querySelectorAll('.ain-field')].find((f) => f.textContent?.startsWith('Packs'));
    const input = field?.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '6');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = [...document.querySelectorAll('button')]
      .find((b) => /Charge|Pricing|Sell pack/.test(b.textContent ?? '')) as HTMLButtonElement;
    const seen = { field: input.value, label: button.textContent ?? '', disabled: button.disabled };
    button.click();
    return seen;
  });

  // The field is showing six, and the control refuses to carry a price that
  // belongs to a different quantity.
  expect(sameTick.field).toBe('6');
  expect(sameTick.disabled).toBe(true);
  expect(sameTick.label).toContain('Pricing');
  expect(charges).toHaveLength(0);

  // Once the quote for six lands, the button prices it — and charges that.
  const quote = await (await page.request.post(`/api/v1/prices/${tiered.id}/preview`, { data: { quantity: 6 } })).json();
  const money = (minor: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(minor / 100);
  const commit = dialog.getByRole('button', { name: /^Charge/ });
  await expect(commit).toContainText(money(quote.amount, quote.currency));

  const before = await json(page, '/v1/credit-billable-items?limit=200');
  await commit.click();
  await expect(dialog).toBeHidden();
  expect(charges).toHaveLength(1);
  expect(JSON.parse(charges[0]).quantity).toBe(6);

  const after = await json(page, '/v1/credit-billable-items?limit=200');
  const seen = new Set(before.data.map((row: { id: string }) => row.id));
  const raised = after.data.filter((row: { id: string; kind: string }) => !seen.has(row.id) && row.kind === 'topup');
  expect(raised).toHaveLength(1);
  expect(raised[0].amount).toBe(quote.amount);
  await expect(page.locator('.ain-toast').first()).toContainText(money(quote.amount, quote.currency));
});

test('refunding unused credit states the money before and after it moves', async ({ page }) => {
  const grants = await json(page, '/v1/credit-grants?limit=200');
  // Selling packs is how the rest of this suite exercises the catalogue, so
  // several grants can carry the same name; the row is found by that name, so
  // the one under test has to be the only one wearing it.
  const named = new Map<string, number>();
  for (const g of grants.data) named.set(g.name, (named.get(g.name) ?? 0) + 1);
  const sold = grants.data.find((g: { name: string; category: string; balance: number; source: string; source_ref: string | null }) =>
    g.category === 'paid' && g.balance > 0 && g.source === 'topup' && !!g.source_ref && named.get(g.name) === 1);
  test.skip(!sold, 'nothing paid-for is left to refund');
  const purchase = (await json(page, `/v1/credit-billable-items?customer=${sold.customer}&kind=topup&limit=200`))
    .data.find((row: { id: string }) => row.id === sold.source_ref);
  test.skip(!purchase, 'the purchase line behind this grant is gone');

  await page.goto('/revenue/credits', { waitUntil: 'networkidle' });
  await page.getByPlaceholder('Search grants and accounts…').fill(sold.name);
  const row = page.locator('tbody tr', { hasText: sold.name }).first();
  await row.getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: 'Refund unused credit' }).click();

  const dialog = page.getByRole('dialog');
  const money = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: purchase.currency.toUpperCase() }).format(minor / 100);
  // What the pack cost is on screen, and so is what goes back.
  await expect(dialog).toContainText(money(purchase.amount));
  const back = Math.round((purchase.amount * sold.balance) / sold.amount);
  await expect(dialog.locator('.rv-preview__amount')).toHaveText(money(back));
  // The button carries the figure it will refund — never a bare "Refund".
  await expect(dialog.getByRole('button', { name: /^Refund/ })).toContainText(money(back));

  await dialog.getByRole('button', { name: /^Refund/ }).click();
  await expect(page.locator('.ain-toast').first()).toContainText(money(back));
  await expect.poll(async () => (await json(page, `/v1/credit-grants/${sold.id}`)).balance).toBe(0);
});

test('the decline-code card reads the give-up list that was actually saved', async ({ page }) => {
  const before = await json(page, '/v1/payments/settings');
  const removable = before.decline_codes
    .find((c: { code: string; severity: string }) => c.severity !== 'final' && before.dunning.give_up_codes.includes(c.code))
    ?? before.decline_codes.find((c: { code: string; severity: string }) => c.severity !== 'final');
  const label = removable.code.replace(/_/g, ' ').replace(/^./, (ch: string) => ch.toUpperCase());

  await page.goto('/revenue/dunning?policy=1', { waitUntil: 'networkidle' });
  const dialog = page.getByRole('dialog');
  const box = dialog.locator('.ain-check', { hasText: label }).first().locator('input');
  const wasGivenUp = await box.isChecked();
  await (wasGivenUp ? box.uncheck() : box.check());
  await dialog.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.locator('.ain-toast')).toContainText('Retry policy saved');

  await expect.poll(async () => (await json(page, '/v1/payments/settings')).dunning.give_up_codes.includes(removable.code))
    .toBe(!wasGivenUp);

  // The badge is the policy, not a static table: a code taken off the list is
  // retried again, and one that is final says so instead of pretending the
  // list decided it.
  const card = page.locator('.ain-card', { hasText: 'Decline codes' });
  const line = card.locator('.rv-row', { hasText: label }).first();
  await expect(line).toContainText(wasGivenUp ? 'Retried' : 'Given up');
  for (const code of before.decline_codes.filter((c: { severity: string }) => c.severity === 'final')) {
    const finalLine = card.locator('.rv-row', { hasText: code.code.replace(/_/g, ' ').replace(/^./, (ch: string) => ch.toUpperCase()) }).first();
    const onList = (await json(page, '/v1/payments/settings')).dunning.give_up_codes.includes(code.code);
    await expect(finalLine).toContainText(onList ? 'Given up' : 'Always given up');
  }

  await page.request.patch('/api/v1/payments/settings', { data: { dunning: { give_up_codes: before.dunning.give_up_codes } } });
});

test('a section tab is in the URL, and the export carries the rows on screen', async ({ page }) => {
  await page.goto('/revenue/credits', { waitUntil: 'networkidle' });
  await page.getByRole('radio', { name: 'Lines waiting to be invoiced' }).click();
  await expect(page).toHaveURL(/record=pending/);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('radio', { name: 'Lines waiting to be invoiced' })).toBeChecked();

  await page.goto('/revenue/usage', { waitUntil: 'networkidle' });
  await page.getByRole('radio', { name: 'Late arrivals' }).click();
  await expect(page).toHaveURL(/inspect=late/);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('radio', { name: 'Late arrivals' })).toBeChecked();

  // The book, narrowed, exported: the file holds the rows the grid is showing
  // and no others, with money as a decimal a spreadsheet can add up.
  const accounts = await json(page, '/v1/revenue/accounts?months=12&currency=usd&limit=200');
  const over = accounts.data.filter((row: { mrr: number }) => row.mrr >= 300_000);
  test.skip(over.length === 0 || over.length === accounts.data.length, 'no filter would narrow this book');
  await page.goto('/revenue?afilter=mrr~number~gte~3000', { waitUntil: 'networkidle' });
  const label = page.locator('.rv-sub', { hasText: 'accounts in the USD book' }).first();
  await expect(label).toHaveText(`${over.length} of ${accounts.data.length} accounts in the USD book`);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    label.locator('..').getByRole('button', { name: 'Export' }).click(),
  ]);
  const stream = await download.createReadStream();
  const csv = await new Promise<string>((resolve, reject) => {
    let out = '';
    stream.on('data', (chunk) => { out += chunk; });
    stream.on('end', () => resolve(out));
    stream.on('error', reject);
  });
  const lines = csv.trim().split('\r\n');
  expect(lines).toHaveLength(over.length + 1);
  expect(lines[0]).toContain('MRR');
  expect(lines[1]).toContain((over[0].mrr / 100).toFixed(2));
});

/* ===================== a pause is a movement, not nothing ================ */

const monthName = (month: string, withYear: boolean) => new Date(
  Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1),
).toLocaleString('en-US', { month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });

const usd = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', signDisplay: 'exceptZero' }).format(minor / 100);

test('a paused or resumed subscription is drawn, tabled, exported and named as a movement', async ({ page }) => {
  const movement = await json(page, '/v1/revenue/movement?months=12&currency=usd&top_movers=6');
  const month = [...movement.series].reverse()
    .find((m: { paused: number | null; resumed: number | null }) => (m.paused ?? 0) > 0 || (m.resumed ?? 0) > 0);
  test.skip(!month, 'no month in this book paused or resumed a subscription');
  const label = monthName(month.month, true);

  await page.goto(`/revenue?months=12&currency=usd&month=${month.month}`, { waitUntil: 'networkidle' });
  const section = page.locator('.ain-section', { hasText: 'MRR movement' });
  const card = section.locator('.ain-card', { hasText: `${label} movement` }).first();

  // The waterfall walks every class the API names — the hidden data table
  // behind the SVG lists one row per bar.
  const bars = card.locator('table.u-visually-hidden tbody th[scope="row"]');
  await expect(bars).toHaveText(['Opening', 'New', 'Expansion', 'Reactivation', 'Resumed', 'Contraction', 'Churn', 'Paused', 'Closing']);
  // A month that paused is not a month in which "nothing moved".
  await expect(page.locator('.ain-banner', { hasText: 'Nothing moved' })).toHaveCount(0);
  // The account that paused is named, with the class on its badge.
  const movers = section.locator('.ain-card', { hasText: 'Who moved' });
  await expect(movers.locator('.ain-badge', { hasText: month.paused ? 'Paused' : 'Resumed' }).first()).toBeVisible();

  // The table has the columns, and the row's cells carry the figures.
  await expect(section.locator('thead th', { hasText: /^Paused/ })).toHaveCount(1);
  await expect(section.locator('thead th', { hasText: /^Resumed/ })).toHaveCount(1);
  const row = section.locator('tbody tr', { hasText: label }).first();
  if (month.paused) await expect(row).toContainText(usd(-month.paused));
  if (month.resumed) await expect(row).toContainText(usd(month.resumed));

  // And the export carries both columns, signed the way they are drawn.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    section.getByRole('button', { name: 'Export' }).first().click(),
  ]);
  const stream = await download.createReadStream();
  const csv = await new Promise<string>((resolve, reject) => {
    let out = '';
    stream.on('data', (chunk) => { out += chunk; });
    stream.on('end', () => resolve(out));
    stream.on('error', reject);
  });
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  const headers = lines[0].split(',');
  expect(headers).toContain('Paused');
  expect(headers).toContain('Resumed');
  const exported = lines.slice(1).map((line) => line.split(',')).find((cells) => cells[0] === month.month)!;
  expect(exported).toBeTruthy();
  const cell = (header: string) => Number(exported[headers.indexOf(header)]);
  const summed = ['New', 'Expansion', 'Reactivation', 'Resumed', 'Contraction', 'Churn', 'Paused'].reduce((sum, h) => sum + cell(h), 0);
  expect(summed.toFixed(2)).toBe(cell('Net').toFixed(2));
  expect((cell('Opening') + summed).toFixed(2)).toBe(cell('Closing').toFixed(2));
});

test('the movement table keeps its columns legible at 1024 wide by scrolling in its card', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto('/revenue?months=12&currency=usd', { waitUntil: 'networkidle' });

  // The toolbar has dropped under the title instead of squeezing the subtitle.
  const subtitle = await page.locator('.ain-page__subtitle').first().boundingBox();
  const actions = await page.locator('.ain-page__actions').first().boundingBox();
  expect(subtitle && actions).toBeTruthy();
  expect(actions!.y).toBeGreaterThanOrEqual(subtitle!.y + subtitle!.height - 1);
  expect(subtitle!.height).toBeLessThan(60);

  // Every money column is wide enough to print its heading and a five-figure amount.
  const section = page.locator('.ain-section', { hasText: 'MRR movement' });
  for (const heading of ['Opening', 'Contraction', 'Closing']) {
    const box = await section.locator('thead th', { hasText: new RegExp(`^${heading}`) }).first().boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(100);
  }
  // The page itself does not scroll sideways; the table does, behind its pinned month.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  const scroller = section.locator('.ain-table__scroll').first();
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test('the Custom range chip is present only while two dates are in force', async ({ page }) => {
  await page.goto('/revenue?months=12&currency=usd', { waitUntil: 'networkidle' });
  const windows = page.getByRole('radiogroup', { name: 'Reporting window' });
  await expect(windows.getByRole('radio', { name: '12m' })).toBeChecked();
  await expect(windows.getByRole('radio', { name: 'Custom' })).toHaveCount(0);

  const health = await json(page, '/v1/health');
  const to = health.time as number;
  await page.goto(`/revenue?currency=usd&from=${to - 45 * 86_400_000}&to=${to}`, { waitUntil: 'networkidle' });
  await expect(windows.getByRole('radio', { name: 'Custom' })).toBeChecked();
});

/* ============================ quiet meters ================================ */

test('a meter the 30-day window has gone quiet on names its last event instead of "Never"', async ({ page }) => {
  const stamp = Date.now();
  const eventName = `pw_quiet_${stamp}`;
  const health = await json(page, '/v1/health');
  const now = health.time as number;
  const customers = await json(page, '/v1/customers?limit=5');
  const meter = await (await page.request.post('/api/v1/meters', {
    data: {
      name: `Quiet meter ${stamp}`, event_name: eventName, aggregation: 'sum', value_key: 'value',
      customer_key: 'customer_id', unit_label: 'probe', acceptance_window_ms: 60 * 86_400_000,
    },
  })).json();
  // One reading, dated 45 days ago: inside the meter's window, outside the overview's.
  const sent = await page.request.post('/api/v1/meter-events', {
    data: {
      event_name: eventName, customer: customers.data[0].id, identifier: `${eventName}-1`, value: 12,
      timestamp: now - 45 * 86_400_000, payload: { customer_id: customers.data[0].id, value: 12 },
    },
  });
  expect(sent.ok()).toBe(true);
  const overview = await json(page, '/v1/metering/overview');
  const windowed = overview.meters.find((m: { id: string }) => m.id === meter.id);
  expect(windowed.last_hour_with_events).toBeNull();
  const detail = await json(page, `/v1/meters/${meter.id}`);
  expect(detail.ingestion.last_event_at).toBeTruthy();

  await page.goto('/revenue/usage', { waitUntil: 'networkidle' });
  const row = page.locator('tbody tr', { hasText: eventName }).first();
  await expect(row).toContainText('Nothing in the last 30 days');
  await expect(row).toContainText('Last event');
  await expect(row).not.toContainText('Never');
  // The tiles say which window they are counting.
  await expect(page.locator('.ain-stat').filter({ hasText: 'Customers streaming' })).toContainText('last 30 days');
});

/**
 * The record behind a quiet meter is read one row at a time, and the burst of
 * those reads is exactly what the rate limiter answers 429 to. Whatever the
 * reason a read is refused, the cell may not settle on its loading marker for
 * the life of the page: the operator is left looking at "…" with nothing to
 * click and no way to know it has stopped trying.
 */
test('a meter record the API refused is asked for again, not left on its loading marker', async ({ page }) => {
  const stamp = Date.now();
  const eventName = `pw_refused_${stamp}`;
  const health = await json(page, '/v1/health');
  const customers = await json(page, '/v1/customers?limit=5');
  await page.request.post('/api/v1/meters', {
    data: {
      name: `Refused meter ${stamp}`, event_name: eventName, aggregation: 'sum', value_key: 'value',
      customer_key: 'customer_id', unit_label: 'probe', acceptance_window_ms: 60 * 86_400_000,
    },
  });
  // Old enough that the overview's window cannot answer for it, so the row has
  // to go and read the meter's own record.
  const sent = await page.request.post('/api/v1/meter-events', {
    data: {
      event_name: eventName, customer: customers.data[0].id, identifier: `${eventName}-1`, value: 7,
      timestamp: (health.time as number) - 45 * 86_400_000, payload: { customer_id: customers.data[0].id, value: 7 },
    },
  });
  expect(sent.ok()).toBe(true);

  // Every record read is refused for the first two seconds, which is the shape
  // of a limiter answering a burst — never a permanent outage.
  let refused = 0;
  const openedAt = Date.now();
  await page.route('**/api/v1/meters/mtr_*', async (route) => {
    if (Date.now() - openedAt < 2_000) {
      refused += 1;
      return route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: { type: 'rate_limit_error', code: 'rate_limit', message: 'Too many requests.', request_id: 'req_probe' } }),
      });
    }
    return route.continue();
  });

  await page.goto('/revenue/usage', { waitUntil: 'networkidle' });
  const row = page.locator('tbody tr', { hasText: eventName }).first();
  await expect(row).toContainText('Nothing in the last 30 days', { timeout: 20_000 });
  await expect(row).toContainText('Last event');
  expect(refused, 'the refusal never happened, so nothing was proven').toBeGreaterThan(0);
  await page.unroute('**/api/v1/meters/mtr_*');
});

/* ======================== who needs a person ============================= */

test('the recovery queue’s "Needs a person" chip shows exactly the rows that wear the badge, and the tile counts them', async ({ page }) => {
  const all = await json(page, '/v1/dunning?status=all&limit=200');
  const needing = all.data.filter((row: { needs_human: boolean }) => row.needs_human);

  await page.goto('/revenue/dunning?status=needs_human', { waitUntil: 'networkidle' });
  await expect(page.getByRole('radiogroup', { name: 'Campaign status' }).getByRole('radio', { name: 'Needs a person' })).toBeChecked();
  const caption = page.locator('.ain-stat').filter({ hasText: 'In recovery' }).locator('.ain-stat__caption');
  await expect(caption).toHaveText(`${needing.length} need a person`);

  if (needing.length === 0) {
    await expect(page.getByText('Nobody needs a person right now')).toBeVisible();
  } else {
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(needing.length);
    await expect(page.locator('tbody .ain-badge', { hasText: 'Needs a person' })).toHaveCount(needing.length);
    for (const campaign of needing) await expect(page.locator('tbody tr', { hasText: campaign.invoice_number })).toHaveCount(1);
  }

  // The palette command lands on that filter, not on the whole queue.
  await page.goto('/revenue', { waitUntil: 'networkidle' });
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('combobox', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.fill('need a person');
  await page.locator('.pal__item').filter({ hasText: 'Payments that need a person' }).first().click();
  await expect(page).toHaveURL(/\/revenue\/dunning\?status=needs_human/);
});

/* =========================== revenue recognition ========================== */

test('the recognition screen states the API’s totals, rolls every month forward and opens a line’s own schedule', async ({ page }) => {
  const report = await json(page, '/v1/revenue/deferred?months=12&currency=usd&limit=500');
  const money = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);

  // Reached from the board's tile.
  await page.goto('/revenue?months=12&currency=usd', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'open the schedule' }).click();
  await expect(page).toHaveURL(/\/revenue\/deferred/);

  await expect(tile(page, 'Deferred balance')).toHaveText(money(report.totals.deferred_balance));
  await expect(tile(page, 'Recognised to date')).toHaveText(money(report.totals.recognised));
  await expect(tile(page, 'Invoiced')).toHaveText(money(report.totals.invoiced));
  await expect(tile(page, 'Earned, not yet billed')).toHaveText(money(report.totals.unbilled_balance));
  await expect(page.locator('.ain-badge', { hasText: report.balanced ? 'Every check passes' : 'A check fails' }).first()).toBeVisible();
  // Every published check is on screen with its verdict.
  const checks = page.locator('.ain-card', { hasText: 'The checks' });
  await expect(checks.locator('.rv-row')).toHaveCount(report.reconciliation.checks.length);
  await expect(checks.locator('.ain-badge', { hasText: 'Passes' })).toHaveCount(report.reconciliation.checks.filter((c: { ok: boolean }) => c.ok).length);

  // The roll-forward has a row per month in scope, and each one balances.
  const inScope = report.series.filter((row: { in_scope: boolean }) => row.in_scope);
  const rolled = page.locator('.ain-section', { hasText: 'rolled forward' });
  await expect(rolled.locator('tbody tr')).toHaveCount(inScope.length);
  await expect(rolled.locator('tbody .ain-badge', { hasText: 'Balances' })).toHaveCount(inScope.length);
  const latest = inScope[inScope.length - 1];
  await expect(rolled.locator('tbody tr', { hasText: monthName(latest.month, true) })).toContainText(money(latest.deferred_balance));

  // The lines table counts what the API named, and a line opens to its schedule.
  const lines = page.locator('.ain-section', { hasText: 'Lines still carrying a balance' });
  await expect(lines.locator('.rv-sub', { hasText: 'in the USD book' })).toHaveText(`${report.lines.length} lines in the USD book`);
  test.skip(report.lines.length === 0, 'nothing is deferred in the USD book');
  const first = report.lines[0];
  await lines.locator('tbody tr', { hasText: first.invoice_number }).first().click();
  const drawer = page.getByRole('dialog').last();
  await expect(drawer).toContainText(first.description);
  await expect(drawer.locator('.ain-banner', { hasText: 'The days add back to the line' })).toBeVisible();
  await expect(drawer).toContainText(money(first.amount));
  await expect(drawer.locator('.rv-row')).toHaveCount(new Set(
    (await json(page, `/v1/revenue/deferred?months=12&currency=usd&invoice=${first.invoice}`)).lines
      .find((row: { line: string }) => row.line === first.line).schedule
      .map((day: { day: string }) => day.day.slice(0, 7)),
  ).size);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

/* ======================= the burn-down card and the policy form ======================= */

const moneyText = (minor: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(minor / 100);

/** The Burn-down section's summary card. */
const burnDown = (page: Page) => page.locator('.ain-card', { has: page.locator('.ain-card__title', { hasText: /^Over the window$/ }) });

test('the burn-down card states the settled split and what is still awaiting an invoice', async ({ page }) => {
  const usage = await json(page, '/v1/revenue/usage?months=12&currency=usd');
  test.skip(usage.totals.settlements === 0, 'nothing has been settled in the USD book');

  await page.goto('/revenue/credits', { waitUntil: 'networkidle' });
  const card = burnDown(page);
  await expect(card).toBeVisible();

  // The split is what the settlement ledger priced — not the subset that has
  // reached a finalised invoice, which was $0.00 / $0.00 on a fresh workspace
  // beside a meter line reading "88.56% charged".
  await expect(card.locator('.ain-stat').filter({ has: page.locator('.ain-stat__label', { hasText: /^Covered by credit$/ }) }).locator('.ain-stat__value'))
    .toHaveText(moneyText(usage.totals.settled.credit_covered, 'usd'));
  await expect(card.locator('.ain-stat').filter({ has: page.locator('.ain-stat__label', { hasText: /^Charged$/ }) }).locator('.ain-stat__value'))
    .toHaveText(moneyText(usage.totals.settled.charged, 'usd'));
  await expect(card.locator('.ain-stat').filter({ has: page.locator('.ain-stat__label', { hasText: /^Awaiting an invoice$/ }) }).locator('.ain-stat__value'))
    .toHaveText(moneyText(usage.totals.unbilled, 'usd'));
  // Covered plus charged is the metered value, and the card says so in those figures.
  expect(usage.totals.settled.credit_covered + usage.totals.settled.charged).toBe(usage.totals.metered_value);
  await expect(card).not.toContainText('never reached an invoice');
});

test('selling a pack updates the burn-down’s "Credit bought" without a reload', async ({ page }) => {
  const prices = await json(page, '/v1/prices?limit=100');
  const pack = prices.data.find((p: { recurring: unknown; currency: string; billing_scheme: string }) =>
    !p.recurring && p.currency === 'usd' && p.billing_scheme === 'per_unit');
  test.skip(!pack, 'no one-off USD price to sell a pack on');
  const customers = await json(page, '/v1/customers?limit=50&currency=usd');
  const account = customers.data[0];

  await page.goto('/revenue/credits', { waitUntil: 'networkidle' });
  const card = burnDown(page);
  const bought = card.locator('.ain-stat').filter({ has: page.locator('.ain-stat__label', { hasText: /^Credit bought$/ }) });
  const before = await json(page, '/v1/revenue/usage?months=12&currency=usd');
  await expect(bought.locator('.ain-stat__value')).toHaveText(moneyText(before.credit.purchased, 'usd'));

  await page.getByRole('button', { name: 'Sell a pack' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Customer').selectOption(account.id);
  await dialog.getByLabel('Price').selectOption(pack.id);
  await dialog.getByLabel('Packs').fill('1');
  await dialog.getByRole('button', { name: /^Charge / }).click();
  await expect(dialog).toBeHidden();

  // The API moved; the card on the same screen has to move with it.
  const after = await json(page, '/v1/revenue/usage?months=12&currency=usd');
  expect(after.credit.purchase_lines).toBe(before.credit.purchase_lines + 1);
  await expect(bought.locator('.ain-stat__value')).toHaveText(moneyText(after.credit.purchased, 'usd'));
  await expect(bought.locator('.ain-stat__caption')).toContainText(`${after.credit.purchase_lines} purchase lines`);
});

test('the retry policy refuses zero attempts out loud instead of saving one', async ({ page }) => {
  const before = await json(page, '/v1/payments/settings');

  await page.goto('/revenue/dunning', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Retry policy' }).click();
  const dialog = page.getByRole('dialog');
  const field = dialog.getByLabel('Maximum attempts');
  await field.fill('0');
  await field.press('Tab');

  // What was typed stays on screen, the field says why it cannot be saved,
  // and Save is not offered — rather than a silent rewrite to 1 and a toast.
  await expect(field).toHaveValue('0');
  await expect(dialog).toContainText(/at least 1 attempt/i);
  await expect(dialog.getByRole('button', { name: 'Save policy' })).toBeDisabled();
  expect((await json(page, '/v1/payments/settings')).dunning.max_attempts).toBe(before.dunning.max_attempts);

  // The same guard, from above: 13 is refused too, and 12 is not.
  await field.fill('13');
  await expect(dialog).toContainText(/no more than 12/i);
  await expect(dialog.getByRole('button', { name: 'Save policy' })).toBeDisabled();
  await field.fill('12');
  await expect(dialog.getByRole('button', { name: 'Save policy' })).toBeEnabled();
});

test('a billed period opens to what it was frozen at against what the meter reads today', async ({ page }) => {
  const closures = await json(page, '/v1/meter-period-closures?limit=5');
  test.skip(!closures.data.length, 'no period has been frozen yet');
  const target = closures.data[0];
  const detail = await json(page, `/v1/meter-period-closures/${target.id}`);
  const meter = await json(page, `/v1/meters/${target.meter}`);
  // A unit symbol (GB, kWh) never inflects; a word does.
  const label: string = meter.unit_label ?? 'unit';
  const symbol = label.length <= 4 && /[A-Z]/.test(label);
  const noun = (n: number) => `${n.toLocaleString('en-US')} ${label}${n === 1 || symbol ? '' : 's'}`;

  await page.goto('/revenue/usage?inspect=closures', { waitUntil: 'networkidle' });
  const table = page.locator('table').filter({ has: page.locator('caption', { hasText: 'Billed periods' }) });
  await table.locator('tbody tr').first().click();

  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.ain-stat').filter({ has: page.locator('.ain-stat__label', { hasText: /^Frozen total$/ }) }).locator('.ain-stat__value'))
    .toHaveText(noun(target.total));
  await expect(drawer.locator('.ain-stat').filter({ has: page.locator('.ain-stat__label', { hasText: /^Reads today$/ }) }).locator('.ain-stat__value'))
    .toHaveText(noun(detail.live_total));
  // The drawer never names the period, settlement or customer by id.
  await expect(drawer).not.toContainText(/\b(mbe|cus|mtr)_[A-Za-z0-9]{6,}/);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('a meter that does not exist says so, with the way back, and no raw request line', async ({ page }) => {
  await page.goto('/revenue/usage/mtr_nope', { waitUntil: 'networkidle' });
  await expect(page.getByText('This meter does not exist or was deleted')).toBeVisible();
  const main = page.locator('main');
  await expect(main).not.toContainText('404 GET');
  await expect(main).not.toContainText(/req_[A-Za-z0-9]{6,}/);
  // The request id is a click away for whoever has to grep the server for it.
  await page.getByRole('button', { name: 'Request details' }).click();
  await expect(main).toContainText(/req_[A-Za-z0-9]{6,}/);
  await page.getByRole('button', { name: 'All meters' }).first().click();
  await expect(page).toHaveURL(/\/revenue\/usage$/);
});

test('the campaign drawer names the subscription’s plan, never its id', async ({ page }) => {
  const all = await json(page, '/v1/dunning?status=all&limit=50');
  // A campaign outlives the subscription it chased, and the workspace is full
  // of subscriptions other specs have cancelled and deleted by the time this
  // one runs. Take the first campaign whose subscription can still be read,
  // rather than the first that merely names one.
  let withSub: { subscription: string; invoice_number: string } | null = null;
  let sub: { items?: { metered: boolean; description: string }[]; description?: string } | null = null;
  for (const row of all.data as { subscription: string | null; invoice_number: string }[]) {
    if (!row.subscription) continue;
    const read = await page.request.get(`/api/v1/subscriptions/${row.subscription}`);
    if (!read.ok()) continue;
    withSub = { subscription: row.subscription, invoice_number: row.invoice_number };
    sub = await read.json();
    break;
  }
  test.skip(!withSub || !sub?.items?.length, 'no campaign here belongs to a subscription that still exists');
  const items = sub!.items!;
  const plan = items.find((item) => !item.metered)?.description ?? items[0]?.description ?? sub!.description!;

  await page.goto('/revenue/dunning?status=all', { waitUntil: 'networkidle' });
  await page.locator('table tbody tr', { hasText: withSub!.invoice_number }).first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText(plan);
  await expect(drawer).not.toContainText(withSub!.subscription);
});

test('the recovery tiles never print a 0.00% rate over a book with no finished campaign', async ({ page }) => {
  const summary = await json(page, '/v1/dunning/summary');
  await page.goto('/revenue/dunning', { waitUntil: 'networkidle' });
  for (const total of summary.totals) {
    const stat = tile(page, `At risk · ${total.currency.toUpperCase()}`).locator('..').locator('..');
    if (total.recovered_amount + total.lost_amount === 0) {
      await expect(stat).toContainText('no finished campaign yet');
      await expect(stat).not.toContainText('0.00% rate');
    } else {
      await expect(stat).toContainText(`${(total.recovery_rate_bps / 100).toFixed(2)}% rate`);
    }
  }
});

test('the credit ledger reads its dates as the workspace writes them, not as ISO strings', async ({ page }) => {
  const ledger = await json(page, '/v1/credit-ledger?limit=500');
  const dated = ledger.data.find((row: { reason: string }) => /\d{4}-\d{2}-\d{2}/.test(row.reason));
  test.skip(!dated, 'no ledger reason names a calendar day');

  await page.goto('/revenue/credits?record=ledger', { waitUntil: 'networkidle' });
  const table = page.locator('table').filter({ has: page.locator('caption', { hasText: 'Every credit movement' }) });
  await expect(table.locator('tbody tr').first()).toBeVisible();
  await expect(table).not.toContainText(/\d{4}-\d{2}-\d{2}/);
  // A true-up that hands units back to a grant is not a refund of money.
  const trueUp = ledger.data.find((row: { type: string; ref_type: string | null }) => row.type === 'refund' && row.ref_type === 'credit_true_up');
  if (trueUp) await expect(table.locator('.ain-badge', { hasText: 'True-up return' }).first()).toBeVisible();
});

test('/revenue/movement and /revenue/collections land on the board’s own sections', async ({ page }) => {
  await page.goto('/revenue/movement', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/revenue#movement$/);
  await expect(page.locator('#movement')).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Nothing is registered at this address');
  await page.goto('/revenue/collections', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/revenue#collections$/);
  await expect(page.locator('#collections')).toBeVisible();
});
