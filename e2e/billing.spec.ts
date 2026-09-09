/**
 * The revenue surface, driven in a real browser.
 *
 * These are operability tests: every one of them does through the UI what an
 * operator would do — create the customer, edit the field, change the plan,
 * credit the invoice — and then asks the API whether the workspace actually
 * changed. A screen that renders the right numbers but cannot move any of them
 * passes none of these.
 *
 *   node scripts/preview.mjs --port 8851 --name billing-ui --fresh
 *   AIN_BASE_URL=http://127.0.0.1:8851 npx playwright test e2e/billing.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { getJson, postJson } from './api';

const signIn = async (page: Page) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const demo = page.getByRole('button', { name: 'Use the demo workspace' });
  if (await demo.count()) await demo.click();
  await page.waitForSelector('.ain-stat');
};

/** A read, retried past the limiter — and a refusal reported where it happened. */
const json = async (page: Page, path: string): Promise<any> => // eslint-disable-line @typescript-eslint/no-explicit-any
  getJson(page.request, `/api${path}`);

/**
 * A fixture written through the API, past the same limiter.
 *
 * A refused *read* costs a flake; a refused *write* costs the fixture, and the
 * test then drives the UI at `/billing/customers/undefined` and fails a minute
 * later on a locator that was never going to appear. Writes that build a
 * fixture are retried the way reads are, and a write that is still refused
 * says so here rather than a screen away.
 */
const post = async (page: Page, path: string, data: unknown): Promise<any> => // eslint-disable-line @typescript-eslint/no-explicit-any
  postJson(page.request, `/api${path}`, data);

/** The "nothing was presented" option in the payment dialog, worded once. */
const BY_HAND_LABEL = 'Recorded by hand — nothing is presented';

/** The value of the stat tile whose label is exactly this — captions mention
 *  the same words, so a substring match picks up three tiles instead of one. */
const tile = (page: Page, label: string) => page
  .locator('.ain-stat')
  .filter({ has: page.locator('.ain-stat__label', { hasText: new RegExp(`^${label}$`) }) })
  .locator('.ain-stat__value');

interface InvoiceRow {
  id: string; number: string; status: string; currency: string;
  total_display: string; amount_due_display: string; amount_due: number; amount_paid: number;
  customer: string;
  customer_name: string; due_date: number | null; created: number;
}

/**
 * Invoices a recovery campaign is still chasing. Paying, voiding or writing one
 * off stands its campaign down — which is exactly the fixture the recovery
 * tests need, so the tests that destroy an invoice leave those alone.
 */
async function notBeingChased(page: Page, rows: InvoiceRow[]): Promise<InvoiceRow[]> {
  const queue = await json(page, '/v1/dunning?status=recovering&limit=50');
  const chased = new Set(queue.data.map((row: { invoice: string }) => row.invoice));
  return rows.filter((row) => !chased.has(row.id));
}

/**
 * The account field is a searching combobox, not a select: it asks the API
 * rather than holding the whole book, so it is driven the way an operator
 * drives it — type the name, take the first match.
 */
async function pickCustomer(page: Page, scope: ReturnType<Page['getByRole']>, name: string) {
  const box = scope.getByRole('combobox').first();
  await box.click();
  await page.keyboard.type(name.slice(0, 18));
  // The unsearched list is on screen before the search answers, so "the first
  // option" was a race that the newest account won. The match is waited for by
  // name and chosen by name.
  const match = page.locator('[role=option]', { hasText: name }).first();
  await expect(match).toBeVisible();
  await match.click();
}

test.beforeEach(async ({ page }) => { await signIn(page); });

/* ================================ overview ================================ */

test('the billing overview reports the API’s own MRR and open receivables', async ({ page }) => {
  const overview = await json(page, '/v1/subscriptions/overview');
  await page.goto('/billing', { waitUntil: 'networkidle' });

  // A mixed book has no single MRR figure — the API says so by sending
  // `mrr_display: null` — so the screen shows one tile per currency instead of
  // adding euros to dollars.
  if (overview.mixed_currency) {
    for (const book of overview.by_currency) {
      await expect(tile(page, `MRR · ${book.currency.toUpperCase()}`)).toHaveText(book.mrr_display);
    }
    await expect(page.locator('.ain-banner', { hasText: 'Three books, three currencies' })).toContainText('nothing is converted');
  } else {
    await expect(tile(page, 'Monthly recurring revenue')).toHaveText(overview.mrr_display);
  }
  await expect(tile(page, 'Live subscriptions')).toHaveText(String(overview.live));
  await expect(tile(page, 'Customers')).toHaveText(String(overview.customers));

  // Each status chip carries the count the API reports for that status.
  const label: Record<string, string> = {
    trialing: 'Trialing', active: 'Active', past_due: 'Past due', paused: 'Paused',
    canceled: 'Canceled', unpaid: 'Unpaid', incomplete: 'Incomplete', incomplete_expired: 'Expired',
  };
  for (const [status, count] of Object.entries(overview.by_status as Record<string, number>)) {
    const chip = page.locator('.bl-statuschip', { hasText: label[status] ?? status });
    await expect(chip.locator('.bl-statuschip__n'), `the ${status} chip`).toHaveText(String(count));
  }

  // A chip is a filter, not a decoration.
  await page.locator('.bl-statuschip').first().click();
  await expect(page).toHaveURL(/\/billing\/subscriptions\?status=/);
});

/* ================================ customers =============================== */

test('a customer can be created, edited inline and credited, end to end', async ({ page }) => {
  const name = `Playwright Metalworks ${Date.now()}`;
  await page.goto('/billing/customers', { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'New customer' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Billing email').fill('ap@playwright-metalworks.test');
  await dialog.getByRole('button', { name: 'Create customer' }).click();

  // It lands on the new account's own screen.
  await expect(page).toHaveURL(/\/billing\/customers\/cus_/);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const id = page.url().split('/').pop() as string;

  // The record really exists on the server.
  const created = await json(page, `/v1/customers/${id}`);
  expect(created.name).toBe(name);

  /* ---- inline editing writes through ---- */
  await page.getByRole('tab', { name: 'Details' }).click();
  await page.getByRole('button', { name: 'Edit Phone' }).click();
  await page.getByLabel('Phone', { exact: true }).fill('+1 (555) 010-4477');
  await page.getByLabel('Phone', { exact: true }).press('Enter');
  await expect(page.getByText('Saved')).toBeVisible();
  await expect.poll(async () => (await json(page, `/v1/customers/${id}`)).phone).toBe('+1 (555) 010-4477');

  /* ---- granting credit moves the balance and lands on the ledger ---- */
  await page.getByRole('button', { name: 'More account actions' }).click();
  await page.getByRole('menuitem', { name: /Adjust the balance/ }).click();
  const credit = page.getByRole('dialog');
  await credit.getByLabel('Amount').fill('125.00');
  await credit.getByLabel('Why').fill('Goodwill credit for the ingestion outage, agreed in the e2e run.');
  // The button carries the amount it is about to move, so the last thing read
  // before committing is the figure itself.
  const commit = credit.getByRole('button', { name: /^Credit / });
  await expect(commit).toHaveText('Credit $125.00');
  await commit.click();

  await expect.poll(async () => (await json(page, `/v1/customers/${id}`)).balance).toBe(-12500);
  await page.getByRole('tab', { name: /Balance ledger/ }).click();
  const entry = page.locator('tbody tr', { hasText: 'Goodwill credit for the ingestion outage' });
  await expect(entry).toBeVisible();
  // The ledger speaks the balance tile's language rather than printing a bare
  // minus sign the tile then calls credit.
  await expect(entry).toContainText('$125.00 credit');
});

test('the customer list joins MRR from the revenue book and filters delinquents', async ({ page }) => {
  const accounts = await json(page, '/v1/revenue/accounts?limit=500');
  const biggest = accounts.data[0];
  await page.goto('/billing/customers', { waitUntil: 'networkidle' });

  await page.getByPlaceholder('Search name, email or id…').fill(biggest.name);
  const row = page.locator('tbody tr', { hasText: biggest.name }).first();
  await expect(row).toContainText(biggest.currency.toUpperCase());

  // Raw minor units on screen would be the defect; the row carries a formatted
  // amount in the account's own currency.
  await expect(row).not.toContainText(String(biggest.mrr));
});

/* ============================== subscriptions ============================= */

test('the proration preview shows the exact lines the change will bill, and applying it charges them', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=50&expand=customer');
  const sub = subs.data.find((row: { items: { metered: boolean; quantity: number }[] }) =>
    row.items.some((item) => !item.metered && item.quantity > 1));
  test.skip(!sub, 'no active subscription carries a per-seat item');

  const seat = sub.items.find((item: { metered: boolean; quantity: number }) => !item.metered && item.quantity > 1);
  const target = seat.quantity + 9;

  await page.goto(`/billing/subscriptions/${sub.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Change plan or quantity' }).click();
  const dialog = page.getByRole('dialog');

  const index = sub.items.indexOf(seat) + 1;
  // The steppers beside the field carry labels that contain the field's own,
  // so the field is addressed by its role rather than by a substring.
  const quantity = dialog.getByRole('spinbutton', { name: `Quantity for item ${index}` });
  await quantity.fill(String(target));
  await quantity.press('Enter');

  // What the server says this change costs, asked independently of the screen.
  const expected = await (await page.request.post(`/api/v1/subscriptions/${sub.id}/preview`, {
    data: { items: [{ id: seat.id, price: seat.price, quantity: target }], proration_behavior: sub.proration_behavior, billing_cycle_anchor: 'unchanged' },
  })).json();
  expect(expected.lines.length).toBeGreaterThan(0);

  // Every line the API priced is on screen, with the sentence behind it.
  await expect(dialog.locator('.bl-prorow')).toHaveCount(expected.lines.length);
  for (const line of expected.lines) {
    await expect(dialog.locator('.bl-prorow', { hasText: line.description })).toBeVisible();
  }
  await expect(dialog.locator('.bl-prorow').first()).toContainText('=');
  // The exact rational is an auditor's number, not a reader's: the sentence
  // stays clean and the fraction lives behind the line's own disclosure.
  await expect(dialog.locator('.bl-fraction')).toHaveCount(0);
  await expect(dialog.locator('.bl-prorow').first()).not.toContainText(' ms =');
  await dialog.locator('.bl-prorow').first().getByRole('button', { name: 'Show the arithmetic' }).click();
  await expect(dialog.locator('.bl-fraction').first()).toContainText('ms');

  // And the MRR the change moves to.
  await expect(dialog.locator('.bl-mrrmove')).toContainText('+');

  await dialog.getByRole('button', { name: /^Apply/ }).click();
  await expect(page.getByText('Subscription changed')).toBeVisible();

  // The subscription really carries the new quantity.
  await expect.poll(async () => {
    const after = await json(page, `/v1/subscriptions/${sub.id}`);
    return after.items.find((item: { id: string }) => item.id === seat.id).quantity;
  }).toBe(target);

  // And the proration was written, not merely drawn.
  const pending = await json(page, `/v1/customers/${sub.customer}/pending_items`);
  expect(pending.data.length).toBeGreaterThan(0);
});

test('a subscription can be paused and resumed from its own screen', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=10');
  const sub = subs.data[subs.data.length - 1];
  await page.goto(`/billing/subscriptions/${sub.id}`, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Pause collection' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Pause collection' }).click();
  await expect(page.getByText('Collection paused')).toBeVisible();
  await expect.poll(async () => (await json(page, `/v1/subscriptions/${sub.id}`)).status).toBe('paused');

  await page.getByRole('button', { name: 'Resume now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(async () => (await json(page, `/v1/subscriptions/${sub.id}`)).status).not.toBe('paused');
});

/* ================================ invoices ================================ */

test('an open invoice can be paid from its own screen, and the document renders', async ({ page }) => {
  const open = await json(page, '/v1/invoices?status=open&limit=10');
  const invoice = (await notBeingChased(page, open.data))[0];
  test.skip(!invoice, 'nothing is owed in this workspace');

  await page.goto(`/billing/invoices/${invoice.id}`, { waitUntil: 'networkidle' });
  await expect(page.locator('.bl-headline', { hasText: 'Amount due' })).toContainText(invoice.amount_due_display);

  // The printable document is the server's own render, in a real frame.
  await page.getByRole('tab', { name: 'Document' }).click();
  const frame = page.frameLocator(`iframe[title="Invoice ${invoice.number}"]`);
  await expect(frame.locator('body')).toContainText(invoice.number);

  await page.getByRole('tab', { name: 'Lines and totals' }).click();
  await page.getByRole('button', { name: 'Take a payment' }).click();
  const dialog = page.getByRole('dialog');
  // The amount defaults to the whole balance, and the primary action carries it.
  await expect(dialog.getByRole('button', { name: new RegExp(`settles ${invoice.number}`) })).toBeEnabled();
  await dialog.getByLabel('How it was taken').selectOption(BY_HAND_LABEL);
  await dialog.getByLabel('How it was collected').fill('Bank transfer, reference E2E-1');
  await dialog.getByRole('button', { name: /^Record / }).click();

  await expect.poll(async () => (await json(page, `/v1/invoices/${invoice.id}`)).status).toBe('paid');
  await expect(page.locator('.ain-page__title')).toContainText(invoice.number);
});

test('a credit note is priced before it is issued, and an over-credit is refused on screen', async ({ page }) => {
  const paid = await json(page, '/v1/invoices?status=paid&limit=10');
  test.skip(!paid.data.length, 'nothing has been paid in this workspace');
  const invoice = paid.data.find((row: { total: number }) => row.total > 1000) ?? paid.data[0];

  await page.goto(`/billing/invoices/${invoice.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'More invoice actions' }).click();
  await page.getByRole('menuitem', { name: /Issue a credit note/ }).click();
  const dialog = page.getByRole('dialog');

  // More than the invoice has left is refused here, before anything is written.
  await dialog.getByLabel('Amount to credit').fill(String((invoice.total / 100) * 5));
  await expect(dialog.getByText('This credit note would be refused')).toBeVisible();

  // A credit it can honour is priced line by line, with where the money goes.
  await dialog.getByLabel('Amount to credit').fill('10.00');
  await expect(dialog.getByRole('button', { name: /^Issue / })).toBeEnabled();
  const lines = dialog.locator('.bl-lines tbody tr');
  expect(await lines.count()).toBeGreaterThan(0);

  await dialog.getByRole('button', { name: /^Issue / }).click();
  await expect(page.getByText('Credit note issued')).toBeVisible();

  const notes = await json(page, `/v1/credit_notes?invoice=${invoice.id}`);
  expect(notes.data.length).toBeGreaterThan(0);
  expect(notes.data[0].total).toBe(1000);
});

test('an invoice line explains its own arithmetic', async ({ page }) => {
  const invoices = await json(page, '/v1/invoices?status=all&limit=50');
  const invoice = invoices.data.find((row: { lines: { breakdown: unknown[] }[] }) =>
    row.lines.some((line) => line.breakdown.length > 0));
  test.skip(!invoice, 'no invoice carries a priced breakdown');

  await page.goto(`/billing/invoices/${invoice.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Show the arithmetic' }).first().click();
  await expect(page.locator('.bl-tiers').first()).toBeVisible();
});

/* ========================= payment methods & credit ======================== */

/**
 * "This account's card is failing, fix it" is the single most common billing
 * task there is, and it has to be doable on the screen that shows it failing.
 */
test('a payment method can be attached, made default and detached from the customer', async ({ page }) => {
  const customers = await json(page, '/v1/customers?limit=1');
  const customer = customers.data[0];
  await page.goto(`/billing/customers/${customer.id}?tab=payments`, { waitUntil: 'networkidle' });

  const before = await json(page, `/v1/customers/${customer.id}/payment_methods`);
  const attach = page.getByRole('button', { name: /^Attach( a payment method)?$/ }).first();
  await attach.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Last four digits').fill('4455');
  await dialog.getByRole('button', { name: 'Attach it' }).click();
  await expect(page.getByText('Payment method attached')).toBeVisible();

  // The workspace really carries it, and it really is the default.
  const added = await expect.poll(async () => {
    const now = await json(page, `/v1/customers/${customer.id}/payment_methods`);
    return now.data.length;
  }).toBe(before.data.length + 1);
  const withNew = await json(page, `/v1/customers/${customer.id}/payment_methods`);
  const mine = withNew.data.find((row: { card: { last4: string } | null }) => row.card?.last4 === '4455');
  expect(mine.default_for_customer).toBe(true);
  expect(added).toBeUndefined();

  // Hand the default back to another method, from that method's own row menu.
  const other = withNew.data.find((row: { id: string }) => row.id !== mine.id);
  if (other) {
    const row = page.locator('.bl-row', { hasText: other.display_name }).first();
    await row.getByRole('button', { name: `Actions for ${other.display_name}` }).click();
    await page.getByRole('menuitem', { name: 'Make it the default' }).click();
    await expect.poll(async () => {
      const now = await json(page, `/v1/customers/${customer.id}/payment_methods`);
      return now.data.find((r: { id: string }) => r.id === other.id).default_for_customer;
    }).toBe(true);
  }

  // And detaching takes it out of what can be charged.
  const mineRow = page.locator('.bl-row', { hasText: mine.display_name }).first();
  await mineRow.getByRole('button', { name: `Actions for ${mine.display_name}` }).click();
  await page.getByRole('menuitem', { name: 'Detach it' }).click();
  await expect.poll(async () => {
    const now = await json(page, `/v1/customers/${customer.id}/payment_methods`);
    return now.data.some((r: { id: string }) => r.id === mine.id);
  }).toBe(false);
});

test('prepaid credit can be granted and voided from the account', async ({ page }) => {
  const customers = await json(page, '/v1/customers?limit=2');
  const customer = customers.data[1] ?? customers.data[0];
  await page.goto(`/billing/customers/${customer.id}?tab=payments`, { waitUntil: 'networkidle' });

  const name = `E2E telemetry prepay ${Date.now()}`;
  await page.getByRole('button', { name: 'Grant credit' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Amount', { exact: true }).fill('75.00');
  await dialog.getByRole('button', { name: 'Grant it' }).click();
  await expect(page.getByText('Credit granted')).toBeVisible();

  const grants = await json(page, `/v1/credit-grants?customer=${customer.id}&limit=50`);
  const grant = grants.data.find((row: { name: string }) => row.name === name);
  expect(grant.balance).toBe(7500);
  expect(grant.status).toBe('active');

  const row = page.locator('.bl-row', { hasText: name }).first();
  await row.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Void this grant' }).click();
  await expect.poll(async () => {
    const after = await json(page, `/v1/credit-grants/${grant.id}`);
    return after.status;
  }).toBe('voided');
});

test('a tax registration can be added, verified and removed', async ({ page }) => {
  const name = `Playwright Tax ${Date.now()}`;
  const created = await (await page.request.post('/api/v1/customers', {
    data: { name, currency: 'eur', address: { country: 'Germany', city: 'Aachen' } },
  })).json();

  await page.goto(`/billing/customers/${created.id}?tab=details`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add a registration' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Kind').selectOption('eu_vat');
  await dialog.getByLabel('Registration number').fill('DE811907980');
  await dialog.getByLabel('Has the register confirmed it?').selectOption('verified');
  await dialog.getByRole('button', { name: 'Add it' }).click();

  // Recorded on the record, and recorded as confirmed — which is the only state
  // that moves the tax onto the customer.
  await expect.poll(async () => {
    const after = await json(page, `/v1/customers/${created.id}`);
    return after.tax_ids[0]?.verification?.status;
  }).toBe('verified');
  await expect(page.locator('.bl-row', { hasText: 'DE811907980' })).toBeVisible();

  await page.locator('.bl-row', { hasText: 'DE811907980' }).getByRole('button', { name: /Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Remove this registration' }).click();
  await expect.poll(async () => (await json(page, `/v1/customers/${created.id}`)).tax_ids.length).toBe(0);
});

/* ============================ honest presentation ========================= */

test('the upcoming invoice never claims a pause that is not there', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=5&expand=customer');
  const sub = subs.data.find((row: { pause_collection: unknown }) => !row.pause_collection);
  test.skip(!sub, 'every subscription is paused');

  await page.goto(`/billing/subscriptions/${sub.id}?tab=upcoming`, { waitUntil: 'networkidle' });
  const card = page.locator('.ain-card', { hasText: 'Upcoming invoice' }).first();
  await expect(card).toContainText('Nothing has been sent');
  await expect(card).not.toContainText('collection is paused');
  await expect(page.locator('main')).not.toContainText('Collection is paused');
});

test('the period ledger names invoices the way every other screen does', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=10');
  let target = null;
  for (const sub of subs.data) {
    const periods = await json(page, `/v1/subscriptions/${sub.id}/periods`);
    if (periods.data.some((row: { invoice: string | null }) => row.invoice)) { target = sub; break; }
  }
  test.skip(!target, 'no subscription has a billed period');

  await page.goto(`/billing/subscriptions/${target.id}?tab=periods`, { waitUntil: 'networkidle' });
  const table = page.locator('.bl-lines').first();
  await expect(table).toContainText(/NR-\d{6}/);
  await expect(table).not.toContainText(/in_[A-Za-z0-9]{10}/);
});

test('money is ranked inside its own currency, and totalled one currency at a time', async ({ page }) => {
  const accounts = await json(page, '/v1/revenue/accounts?limit=500');
  const currencies = new Set(accounts.data.map((row: { currency: string }) => row.currency));
  test.skip(currencies.size < 2, 'this workspace bills in one currency');

  // The overview ranks each book on its own, so the largest account in every
  // currency is on screen — not the first eight rows of a list ordered by
  // currency, which used to hide sixteen of seventeen dollar accounts.
  await page.goto('/billing', { waitUntil: 'networkidle' });
  const card = page.locator('.ain-card', { hasText: 'Largest accounts' });
  for (const currency of currencies) {
    const biggest = accounts.data.filter((row: { currency: string }) => row.currency === currency)
      .sort((a: { mrr: number }, b: { mrr: number }) => b.mrr - a.mrr)[0];
    await expect(card, `the largest ${currency} account`).toContainText(biggest.name);
  }

  // And the invoice grid states a receivables figure per currency rather than
  // refusing with "mixed currencies".
  await page.goto('/billing/invoices?status=open_like', { waitUntil: 'networkidle' });
  const open = await json(page, '/v1/invoices?status=open_like&limit=100');
  const byCurrency = new Map<string, number>();
  for (const row of open.data) byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.amount_due);
  if (byCurrency.size > 1) {
    await expect(page.locator('.bl-ccytotals').first()).toBeVisible();
    await expect(page.locator('tfoot')).not.toContainText('mixed currencies');
  }
});

test('the invoice grid narrows to one account without a lucky text search', async ({ page }) => {
  // The account with the most invoices in the seeded book, not whoever happens
  // to own the newest one. `data[0]` is the last invoice raised, which in a
  // whole-suite run belongs to a throwaway account another test in this file
  // created and then deleted underneath this one — so the grid held rows the
  // filtered count no longer had, and the poll read "two rows too many" out of
  // a grid that was filtering correctly.
  const invoices = await json(page, '/v1/invoices?status=all&limit=200');
  const byCustomer = new Map<string, { customer: string; customer_name: string; n: number }>();
  for (const row of invoices.data as { customer: string; customer_name: string }[]) {
    const seen = byCustomer.get(row.customer);
    byCustomer.set(row.customer, { customer: row.customer, customer_name: row.customer_name, n: (seen?.n ?? 0) + 1 });
  }
  const target = [...byCustomer.values()].sort((a, b) => b.n - a.n)[0];
  expect(target?.n, 'no account in this book has more than one invoice to narrow to').toBeGreaterThan(1);
  await page.goto('/billing/invoices', { waitUntil: 'networkidle' });

  await page.locator('.bl-acctfilter input.ain-combo__input').click();
  await page.locator('.bl-acctfilter input.ain-combo__input').fill(target.customer_name);
  await page.locator('.ain-combo__option', { hasText: target.customer_name }).first().click();

  await expect(page).toHaveURL(new RegExp(`customer=${target.customer}`));
  // `[data-index]`, not every `tr`: a virtualised table pads the window with an
  // `aria-hidden` spacer row above and below the rows it drew, and a bare `tr`
  // counts those as records.
  const rows = page.locator('tbody tr[data-index]');
  await expect(rows.first()).toBeVisible();
  // The book is re-read on every poll: other tests in this file raise invoices
  // while this one runs, and a count taken once before the sweep settles is a
  // race rather than an assertion about the grid.
  await expect.poll(async () => {
    const server = await json(page, `/v1/invoices?customer=${target.customer}&status=all&limit=1`);
    return await rows.count() - Math.min(server.total_count, 200);
  }, { timeout: 20_000 }).toBe(0);
});

/* ============================== record tabs =============================== */

test('a record tab is in the address bar, so it survives a reload and can be sent', async ({ page }) => {
  const invoices = await json(page, '/v1/invoices?status=all&limit=1');
  const invoice = invoices.data[0];

  await page.goto(`/billing/invoices/${invoice.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Credit notes/ }).click();
  await expect(page).toHaveURL(/tab=credits/);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('tab', { name: /Credit notes/ })).toHaveAttribute('aria-selected', 'true');

  // And a link straight to a tab opens on it.
  await page.goto(`/billing/invoices/${invoice.id}?tab=document`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('tab', { name: 'Document' })).toHaveAttribute('aria-selected', 'true');
});

test('the printable document renders without the JSON encoding around it', async ({ page }) => {
  const invoices = await json(page, '/v1/invoices?status=paid&limit=1');
  test.skip(!invoices.data.length, 'nothing has been paid');
  const invoice = invoices.data[0];

  await page.goto(`/billing/invoices/${invoice.id}?tab=document`, { waitUntil: 'networkidle' });
  const frame = page.frameLocator('iframe.bl-doc');
  await expect(frame.locator('body')).toContainText(invoice.number);
  const text = (await frame.locator('body').innerText()).trim();
  expect(text.startsWith('"')).toBe(false);
});

/* ============================== more actions ============================== */

test('a credit note can be voided from the invoice that issued it', async ({ page }) => {
  const paid = await json(page, '/v1/invoices?status=paid&limit=10');
  const invoice = paid.data.find((row: { total: number }) => row.total > 5000) ?? paid.data[0];
  test.skip(!invoice, 'nothing has been paid');

  await page.goto(`/billing/invoices/${invoice.id}?tab=credits`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Issue a credit note/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Amount to credit').fill('5.00');
  await expect(dialog.getByRole('button', { name: /^Issue \W?5/ })).toBeEnabled();
  await dialog.getByRole('button', { name: /^Issue / }).click();
  await expect(page.getByText('Credit note issued')).toBeVisible();

  const notes = await json(page, `/v1/credit_notes?invoice=${invoice.id}&status=all&limit=10`);
  const note = notes.data.find((row: { total: number; status: string }) => row.total === 500 && row.status === 'issued');
  expect(note).toBeTruthy();

  await page.getByRole('button', { name: `Void ${note.number}` }).click();
  await page.getByRole('button', { name: 'Void the credit note' }).click();
  await expect.poll(async () => (await json(page, `/v1/credit_notes/${note.id}`)).status).toBe('void');
});

test('billing an account shows what it would bill before it bills it', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=50');
  const sub = subs.data.find((row: { items: { metered: boolean; quantity: number }[] }) =>
    row.items.some((item) => !item.metered && item.quantity > 1));
  test.skip(!sub, 'no active subscription carries a per-seat item');
  const seat = sub.items.find((item: { metered: boolean; quantity: number }) => !item.metered && item.quantity > 1);

  // Put something in the way of the next invoice, through the API, so the
  // dialog has real lines to draw.
  await page.request.patch(`/api/v1/subscriptions/${sub.id}`, {
    data: { items: [{ id: seat.id, price: seat.price, quantity: seat.quantity + 3 }], proration_behavior: 'create_prorations' },
  });
  const pending = await json(page, `/v1/customers/${sub.customer}/pending_items`);
  expect(pending.data.length).toBeGreaterThan(0);

  const account = await json(page, `/v1/customers/${sub.customer}`);
  await page.goto('/billing/invoices', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Bill an account' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input.ain-combo__input').click();
  await dialog.locator('input.ain-combo__input').fill(account.name);
  await page.locator('.ain-combo__option', { hasText: account.name }).first().click();

  // Every line the API says is waiting is on screen, and the button carries the
  // figure — so pressing it is a confirmation rather than a coin flip.
  for (const item of pending.data) {
    await expect(dialog.locator('.bl-lines', { hasText: item.description })).toBeVisible();
  }
  await expect(dialog.getByRole('button', { name: /^Raise the invoice ·/ })).toBeEnabled();
  await dialog.getByRole('button', { name: /^Raise the invoice/ }).click();

  // And it lands on the invoice it just raised.
  await expect(page).toHaveURL(/\/billing\/invoices\/in_/);
});

test('a flat fee is not given a quantity spinner it has no use for', async ({ page }) => {
  // A flat price sells one of itself however many seats the plan is counted in.
  // The engine refuses any other quantity, so the screen refuses to offer one:
  // the control is locked at 1 and says why, rather than inviting an edit that
  // can only come back as an error.
  const prices = await json(page, '/v1/prices?active=true&limit=200');
  const flatIds = new Set(prices.data
    .filter((row: { model: string }) => row.model === 'flat')
    .map((row: { id: string }) => row.id));
  const subs = await json(page, '/v1/subscriptions?status=active&limit=50');
  const sub = subs.data.find((row: { items: { price: string }[] }) =>
    row.items.some((item) => flatIds.has(item.price)));
  test.skip(!sub, 'no active subscription carries a flat fee');
  const flat = sub.items.find((item: { price: string }) => flatIds.has(item.price));

  await page.goto(`/billing/subscriptions/${sub.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Change plan or quantity' }).click();
  const dialog = page.getByRole('dialog');
  const index = sub.items.indexOf(flat) + 1;

  await expect(dialog.getByRole('spinbutton', { name: `Quantity for item ${index}` })).toHaveCount(0);
  const locked = dialog.locator('.bl-fixedqty').nth(index - 1);
  await expect(locked).toBeVisible();
  await expect(locked).toHaveText('1');
  await expect(locked).toHaveAttribute('title', /flat fee/);
});

test('the subscription terms are editable where the API accepts a change', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=10');
  const sub = subs.data[0];
  await page.goto(`/billing/subscriptions/${sub.id}`, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'Edit Note' }).click();
  await page.getByLabel('Note', { exact: true }).fill('Renewal agreed with the plant engineering lead.');
  await page.getByLabel('Note', { exact: true }).press('Enter');
  await expect.poll(async () => (await json(page, `/v1/subscriptions/${sub.id}`)).description)
    .toBe('Renewal agreed with the plant engineering lead.');
});

/* ============================== registration ============================== */

test('billing registers navigation, palette commands and a home widget', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('.ain-card', { hasText: 'Renewing next' }).first()).toBeVisible();
  await expect(page.locator('.ain-card', { hasText: 'Owed right now' }).first()).toBeVisible();

  for (const label of ['Billing', 'Customers', 'Subscriptions', 'Invoices']) {
    await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible();
  }

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search|command/i).first().fill('new subscription');
  await expect(page.getByText('New subscription').first()).toBeVisible();
  await page.keyboard.press('Escape');

  // The + menu offers what this module can create, and its destination opens
  // the create dialog rather than dropping the operator on a list.
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('menuitem', { name: /New customer/i })).toBeVisible();
  await page.getByRole('menuitem', { name: /New customer/i }).click();
  await expect(page.getByRole('dialog').getByText('New customer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/billing\/customers$/);
});

/* ========================== dates that bill ============================== */

/**
 * A billing boundary is a calendar date the engine computes at 00:00 UTC. In a
 * workspace on America/New_York, rendering it in the workspace zone prints it a
 * day early — and the API also ships pre-formatted UTC strings, so the two
 * conventions collided inside a single card. Every boundary on this screen is
 * now the same day the server says it is.
 */
test('every billing boundary on an invoice agrees with the API’s own words', async ({ page }) => {
  const open = await json(page, '/v1/invoices?status=open&limit=100');
  // A bill raised by hand covers no period and says so instead of printing
  // one; the boundaries under test belong to a bill that has them.
  const periodic = open.data.filter((row: { billing_reason: string }) => row.billing_reason !== 'manual');
  const invoice = periodic.find((row: { due_date: number | null }) => row.due_date) ?? periodic[0];
  test.skip(!invoice, 'nothing is owed in this workspace');

  const utc = (ts: number) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  }).format(ts);

  await page.goto(`/billing/invoices/${invoice.id}`, { waitUntil: 'networkidle' });

  // The header sentence is the server's; the tile beside it must say the same day.
  await expect(page.locator('.ain-page__subtitle, .ain-page__sub').first()).toContainText(invoice.status_detail);
  const due = page.locator('.bl-headline__item', { hasText: 'Amount due' });
  if (invoice.due_date) await expect(due).toContainText(utc(invoice.due_date));

  // The period is printed once, by the server, and the line beneath it agrees.
  await expect(page.locator('.bl-headline__item', { hasText: 'Total' })).toContainText(invoice.period_display);
  const line = invoice.lines[0];
  if (line) {
    // The range drops the repeated year on its left half, so the start is
    // matched without one and the end — which always carries it — with.
    const short = (ts: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(ts);
    await expect(page.locator('.bl-lines tbody tr').first()).toContainText(short(line.period.start));
    await expect(page.locator('.bl-lines tbody tr').first()).toContainText(utc(line.period.end));
  }

  // And the grid's Due column is the same date as the record's due_date.
  await page.goto('/billing/invoices?status=open', { waitUntil: 'networkidle' });
  if (invoice.due_date) {
    await expect(page.locator('tbody tr', { hasText: invoice.number }).first()).toContainText(utc(invoice.due_date));
  }
});

test('a subscription’s period, anchor and start date tell one story', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=5&expand=customer');
  const sub = subs.data[0];
  const utc = (ts: number, withYear = true) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}),
  }).format(ts);

  await page.goto(`/billing/subscriptions/${sub.id}`, { waitUntil: 'networkidle' });
  const period = page.locator('.bl-headline__item', { hasText: 'Current period' });
  await expect(period).toContainText(utc(sub.current_period_end));

  // The billing day is a number on the record; the period end has to land on it.
  const anchorDay = new Date(sub.current_period_end).getUTCDate();
  expect(anchorDay).toBe(sub.billing_cycle_anchor_day);
  await expect(page.locator('.bl-fieldrow', { hasText: 'Billing day' })).toContainText(String(sub.billing_cycle_anchor_day));
  await expect(page.locator('.bl-fieldrow', { hasText: 'Started' })).toContainText(utc(sub.start_date));
});

/* ============================== recovery ================================= */

/**
 * A campaign to look at. If nothing is being chased, one is started the way the
 * platform starts them: by presenting an open bill and having the issuer refuse
 * it. The simulated processor makes that deterministic.
 */
const recoveringCampaign = async (page: Page) => {
  const live = await json(page, '/v1/dunning?status=recovering&limit=10');
  if (live.data.length) return live.data[0];
  const open = await json(page, '/v1/invoices?status=open&limit=20');
  for (const invoice of open.data as InvoiceRow[]) {
    await page.request.post(`/api/v1/invoices/${invoice.id}/retry`, { data: {} });
    const now = await json(page, '/v1/dunning?status=recovering&limit=10');
    if (now.data.length) return now.data[0];
  }
  return null;
};

test('the retry schedule is visible and an operator can stand it down', async ({ page }) => {
  const campaign = await recoveringCampaign(page);
  test.skip(!campaign, 'no bill can be put into recovery in this workspace');

  await page.goto(`/billing/invoices/${campaign.invoice}?tab=collection`, { waitUntil: 'networkidle' });
  const card = page.locator('.ain-card')
    .filter({ has: page.locator('.ain-card__title', { hasText: /^Recovery$/ }) });

  // "Dunning is retrying it" is not something an AR clerk can act on. When the
  // next attempt lands, and what it will present, are.
  await expect(card).toContainText(campaign.recommended_action.slice(0, 40));
  await expect(card.locator('.bl-dunnext__when')).not.toHaveText('—');
  await expect(card).toContainText(`${campaign.attempt_count} of ${campaign.max_attempts} used`);
  await expect(card.locator('.bl-dunpip')).toHaveCount(campaign.max_attempts);

  // Every attempt it has already made, with what each one decided.
  if (campaign.attempts.length) {
    await card.getByRole('button', { name: /Show all \d+ attempts/ }).click();
    await expect(card.locator('.bl-lines tbody tr')).toHaveCount(campaign.attempts.length);
    await expect(card.locator('.bl-lines tbody')).toContainText(campaign.attempts[0].decision.slice(0, 30));
  }

  // And it can be stopped — without touching the bill.
  await card.getByRole('button', { name: 'Stop chasing' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Why').fill('Finance is collecting this one by bank transfer.');
  await dialog.getByRole('button', { name: 'Stop the schedule' }).click();

  await expect.poll(async () => (await json(page, `/v1/dunning/${campaign.id}`)).status).toBe('canceled');
  // The invoice is untouched: still open, still owed.
  const after = await json(page, `/v1/invoices/${campaign.invoice}`);
  expect(after.status).toBe('open');
  expect(after.amount_due).toBeGreaterThan(0);
});

test('the workspace retry schedule can be changed where an operator meets it', async ({ page }) => {
  // A campaign still running always has its bill; a finished one may belong
  // to an account since removed, whose bill went with it.
  const live = await json(page, '/v1/dunning?status=recovering&limit=10');
  const queue = live.data.length ? live : await json(page, '/v1/dunning?status=all&limit=50');
  // The API prints the bill's number on a campaign; when the bill is gone it
  // falls back to the id, which is the tell.
  const campaign = queue.data.find((row: { invoice: string; invoice_number: string }) => row.invoice_number !== row.invoice);
  test.skip(!campaign, 'no recovery campaign with a bill still on the books');

  await page.goto(`/billing/invoices/${campaign.invoice}?tab=collection`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Change the retry schedule…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('workspace');
  await dialog.getByLabel('Gaps between attempts').fill('2, 4, 8');
  await dialog.getByLabel('Attempts in total').selectOption('5');
  await dialog.getByRole('button', { name: 'Save the schedule' }).click();

  await expect.poll(async () => {
    const settings = await json(page, '/v1/payments/settings');
    return `${settings.dunning.retry_days.join(',')}|${settings.dunning.max_attempts}`;
  }).toBe('2,4,8|5');
});

/* ======================= destruction needs a confirm ===================== */

test('voiding an invoice is confirmed, named and reversible up to the last click', async ({ page }) => {
  const open = await json(page, '/v1/invoices?status=open&limit=50');
  const invoice = (await notBeingChased(page, open.data))[0];
  test.skip(!invoice, 'nothing is open');

  await page.goto(`/billing/invoices/${invoice.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'More invoice actions' }).click();

  // The item the menu lands on is a safe one — there is no un-void route, so a
  // single Enter must not be able to destroy a receivable.
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
  expect(focused).not.toMatch(/Void|Write it off/);

  await page.getByRole('menuitem', { name: /Void this invoice/ }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText(invoice.number);
  await expect(confirm).toContainText(invoice.total_display);
  await expect(confirm).toContainText(invoice.customer_name);
  await expect(confirm).toContainText('no route that un-voids');

  // Backing out writes nothing.
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect((await json(page, `/v1/invoices/${invoice.id}`)).status).toBe('open');

  // Going through with it does.
  await page.getByRole('button', { name: 'More invoice actions' }).click();
  await page.getByRole('menuitem', { name: /Void this invoice/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Void this invoice' }).click();
  await expect.poll(async () => (await json(page, `/v1/invoices/${invoice.id}`)).status).toBe('void');
});

test('writing an invoice off is confirmed, and the badge uses the operator’s own word', async ({ page }) => {
  const open = await json(page, '/v1/invoices?status=open&limit=50');
  const candidates = await notBeingChased(page, open.data);
  const invoice = candidates[candidates.length - 1];
  test.skip(!invoice, 'nothing is open');

  await page.goto(`/billing/invoices/${invoice.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'More invoice actions' }).click();
  await page.getByRole('menuitem', { name: /Write it off/ }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText(invoice.number);
  await expect(confirm).toContainText('un-writes it off');
  await confirm.getByRole('button', { name: 'Write it off' }).click();

  await expect.poll(async () => (await json(page, `/v1/invoices/${invoice.id}`)).status).toBe('uncollectible');
  // The action said "write it off"; the record says the same thing back.
  await expect(page.locator('.ain-badge').first()).toContainText('Written off');
});

test('a bulk void says how many it will destroy, and confirms first', async ({ page }) => {
  await page.goto('/billing/invoices?status=open_like', { waitUntil: 'networkidle' });
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  test.skip(await rows.count() < 2, 'fewer than two invoices are owed');

  await rows.nth(0).locator('input[type=checkbox]').check();
  await rows.nth(1).locator('input[type=checkbox]').check();

  // "Void" told an operator nothing about the size of what it was about to do,
  // while its neighbour already said "Finalise 2".
  await expect(page.getByRole('button', { name: 'Void 2' })).toBeVisible();
  await page.getByRole('button', { name: 'Void 2' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('Void 2 invoices?');
  await expect(confirm).toContainText('un-voids');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
});

/* ============================ what to chase first ======================== */

test('“Owed right now” leads with what is latest, not with what is newest', async ({ page }) => {
  const open = await json(page, '/v1/invoices?status=open_like&limit=200');
  test.skip(open.data.length < 1, 'nothing is owed');
  const dueAt = (row: { due_date: number | null; created: number }) => row.due_date ?? row.created;
  const oldest = [...open.data].sort((a, b) => dueAt(a) - dueAt(b))[0];

  await page.goto('/billing', { waitUntil: 'networkidle' });
  const card = page.locator('.ain-card', { hasText: 'Owed right now' }).first();
  await expect(card.locator('.bl-row').first()).toContainText(oldest.number);

  // An invoice past its date is marked as such, not given the same neutral
  // badge as one raised this morning.
  if (oldest.due_date && oldest.due_date < Date.now()) {
    await expect(card.locator('.bl-row').first()).toContainText('overdue');
  }
});

/* =========================== priced before sold ========================== */

test('a new subscription is priced, in the account’s own currency, before it is created', async ({ page }) => {
  const customers = await json(page, '/v1/customers?limit=200');
  const account = customers.data.find((row: { currency: string }) => row.currency !== 'usd') ?? customers.data[0];

  await page.goto(`/billing/customers/${account.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New subscription' }).click();
  const dialog = page.getByRole('dialog');

  // The field that decides whose money this binds shows the account, not its id.
  await expect(dialog.locator('.bl-lockedfield')).toContainText(account.name);

  // Every option carries what it costs, in this account's currency.
  const symbol = { usd: '$', eur: '€', gbp: '£' }[account.currency as string] ?? '';
  await expect(dialog.locator('select').first().locator('option').first()).toContainText(' · ');
  const options = await dialog.locator('select').first().locator('option').allInnerTexts();
  const priced = options.filter((o) => o.includes(symbol) || /metered|negotiated/.test(o));
  expect(priced.length, `every option priced: ${JSON.stringify(options.slice(0, 4))}`).toBe(options.length);

  // And the panel prices the basket — the recurring fee, the MRR it adds and
  // what is invoiced the moment Create is pressed.
  const panel = dialog.locator('.bl-preview');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Monthly recurring revenue');
  await expect(panel).toContainText('Invoiced today');
  await expect(panel).toContainText(symbol);

  // The button states the commitment rather than hiding it.
  await expect(dialog.getByRole('button', { name: /^Create · / })).toBeEnabled();

  // Nothing on this screen prints raw minor units.
  await expect(panel).not.toContainText('minor units');

  await dialog.getByRole('button', { name: /^Create · / }).click();
  await expect(page).toHaveURL(/\/billing\/subscriptions\/sub_/);

  const id = page.url().split('/').pop() as string;
  const created = await json(page, `/v1/subscriptions/${id}`);
  expect(created.customer).toBe(account.id);
  // A record created here is named the way the seeded ones are, not after its
  // own primary key.
  await expect(page.locator('.ain-page__subtitle, .ain-page__sub').first()).not.toContainText(id);
  await expect(page.locator('.ain-page__subtitle, .ain-page__sub').first()).toContainText(account.name);
});

test('a negotiated price can actually be sold, because the dialog asks for the amount', async ({ page }) => {
  const prices = await json(page, '/v1/prices?active=true&limit=200');
  const custom = prices.data.find((row: { model: string; type: string }) => row.model === 'custom' && row.type === 'recurring');
  test.skip(!custom, 'no negotiated price in the catalogue');

  const customers = await json(page, '/v1/customers?limit=5');
  const account = customers.data[0];
  await page.goto(`/billing/customers/${account.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New subscription' }).click();
  const dialog = page.getByRole('dialog');

  await dialog.locator('select').first().selectOption(custom.id);
  const field = dialog.getByLabel(`Negotiated amount for ${custom.product_name}`);
  await expect(field).toBeVisible();

  // Priced with the amount, and the panel names it.
  const bounds = custom.currency_options?.[account.currency]?.custom_unit_amount ?? custom.custom_unit_amount;
  await expect(dialog.locator('.bl-preview')).toContainText(custom.product_name);
  await expect(dialog.getByRole('button', { name: /^Create · / })).toBeEnabled();
  expect(bounds.preset).toBeGreaterThan(0);
});

/* ============================ honest labelling =========================== */

test('a voided credit note stops claiming the money came off the invoice', async ({ page }) => {
  const paid = await json(page, '/v1/invoices?status=paid&limit=10');
  const invoice = paid.data.find((row: { total: number }) => row.total > 5000) ?? paid.data[0];
  test.skip(!invoice, 'nothing has been paid');

  await page.goto(`/billing/invoices/${invoice.id}?tab=credits`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Issue a credit note/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Amount to credit').fill('7.00');
  await dialog.getByRole('button', { name: /^Issue / }).click();
  await expect(page.getByText('Credit note issued')).toBeVisible();

  const notes = await json(page, `/v1/credit_notes?invoice=${invoice.id}&status=all&limit=10`);
  const note = notes.data.find((row: { total: number; status: string }) => row.total === 700 && row.status === 'issued');
  const row = page.locator('.bl-row', { hasText: note.number });
  // Whatever the note did — came off the bill, or went onto the balance — the
  // row says so while the note stands, from the note's own amounts. Not from
  // `routing_detail`: the server picks its wording from whether the bill is
  // paid *in full*, so on a part-collected bill its last branch says nothing
  // had been collected beside an `amount_paid` that says otherwise.
  const destination = note.post_payment_amount > 0
    ? [note.refund_amount_display, note.credit_amount_display, note.out_of_band_amount_display]
      .filter((_, i) => [note.refund_amount, note.credit_amount, note.out_of_band_amount][i] > 0)
    : [note.total_display];
  for (const amount of destination) await expect(row).toContainText(amount);
  await expect(row).toContainText(invoice.number);

  await page.getByRole('button', { name: `Void ${note.number}` }).click();
  await page.getByRole('button', { name: 'Void the credit note' }).click();
  await expect.poll(async () => (await json(page, `/v1/credit_notes/${note.id}`)).status).toBe('void');

  // The row above has just put the money back. Its own sentence has to agree.
  await expect(row).not.toContainText('came off');
  await expect(row).toContainText('went back onto');
  // And the badge is cased like every other status in the module.
  await expect(row.locator('.ain-badge')).toContainText('Voided');
});

test('a tax registration records the register that issued it, not the address it bills to', async ({ page }) => {
  const name = `Playwright Issuer ${Date.now()}`;
  const created = await (await page.request.post('/api/v1/customers', {
    data: { name, currency: 'usd', address: { country: 'United States', city: 'Des Moines', state: 'IA' } },
  })).json();

  await page.goto(`/billing/customers/${created.id}?tab=details`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add a registration' }).click();
  const dialog = page.getByRole('dialog');

  // A Des Moines business is offered the kind a Des Moines business holds.
  await expect(dialog.getByLabel('Kind')).toHaveValue('us_ein');

  // Choosing a UK registration moves the issuing country with it — the field is
  // explicitly the "differs from the billing address" override, so prefilling it
  // from the billing address is what filed a GB number as issued in the USA.
  await dialog.getByLabel('Kind').selectOption('gb_vat');
  await expect(dialog.getByLabel('Issued in')).toHaveValue('United Kingdom');
  await dialog.getByLabel('Registration number').fill('GB123456789');
  await dialog.getByRole('button', { name: 'Add it' }).click();

  await expect.poll(async () => {
    const after = await json(page, `/v1/customers/${created.id}`);
    return after.tax_ids[0]?.country;
  }).toBe('United Kingdom');
});

test('a refused registration is explained once, under the field that is wrong', async ({ page }) => {
  const name = `Playwright Refusal ${Date.now()}`;
  const created = await (await page.request.post('/api/v1/customers', {
    data: { name, currency: 'eur', address: { country: 'Germany' } },
  })).json();

  await page.goto(`/billing/customers/${created.id}?tab=details`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add a registration' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Registration number').fill('NOT-A-VAT');
  await dialog.getByRole('button', { name: 'Add it' }).click();

  // Once. Not under the select that is not wrong, and not again in a toast over
  // the input that would fix it.
  await expect(dialog.locator('.ain-field__error')).toHaveCount(1);
  await expect(dialog.locator('.ain-field__error')).toContainText('EU VAT');
  await expect(page.locator('.ain-toast')).toHaveCount(0);
});

/* ============================== addressable ============================== */

test('a search box can be addressed by the words printed in it', async ({ page }) => {
  for (const [route, label] of [
    ['/billing/invoices', 'Search number, account or id'],
    ['/billing/subscriptions', 'Search account, plan or id'],
    ['/billing/customers', 'Search name, email or id'],
  ] as const) {
    await page.goto(route, { waitUntil: 'networkidle' });
    const box = page.getByLabel(label);
    await expect(box, `${route} search`).toBeVisible();
    await expect(box).toHaveAttribute('placeholder', `${label}…`);
  }
});

test('the customers grid ships one MRR column, not the same money twice', async ({ page }) => {
  await page.goto('/billing/customers', { waitUntil: 'networkidle' });
  await expect(page.locator('thead th', { hasText: /^MRR$/ })).toHaveCount(1);
  await expect(page.locator('thead th', { hasText: 'MRR amount' })).toHaveCount(0);
  const headers = await page.locator('thead th').allInnerTexts();
  const money = headers.filter((h) => /MRR/.test(h));
  expect(money.length, JSON.stringify(headers)).toBe(1);
});

test('a failed list says so above the grid, and does not report zero rows', async ({ page }) => {
  await page.route('**/api/v1/invoices?**', (route) => route.abort());
  await page.goto('/billing/invoices', { waitUntil: 'domcontentloaded' });

  // The reason wraps where it can be read, outside the grid's sideways scroll.
  const failure = page.locator('.bl-listfail');
  await expect(failure).toBeVisible();
  const box = await failure.boundingBox();
  const main = await page.locator('main').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(main!.x + main!.width + 1);

  // And the footer does not assert a count the request never established.
  await expect(page.locator('.bl-listfoot__count')).toContainText('could not be loaded');
  await expect(page.locator('.bl-listfoot__count')).not.toContainText('No invoices on this page');
});

/**
 * The prices a schedule phase names, so a spec can tell a metered line from a
 * billed one. A metered line has no amount until the period closes — the screen
 * says "(metered)" where a licensed line carries a figure — and a package price
 * on a meter quotes one block at quantity 1, which is not what it will bill.
 */
const meteredPrices = async (page: Page): Promise<Set<string>> => {
  const prices = await json(page, '/v1/prices?limit=200');
  return new Set((prices.data as { id: string; recurring: { usage_type: string } | null }[])
    .filter((price) => price.recurring?.usage_type === 'metered')
    .map((price) => price.id));
};

/* =============================== schedules ================================ */

test('a plan change can be booked for a future renewal, and released before it happens', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=50');
  // A per-seat line, because that is the one a phase can carry more of — a flat
  // fee sells exactly one of itself and the engine refuses any other quantity.
  const sub = subs.data.find((row: { schedule: string | null; items: { metered: boolean; quantity: number }[] }) =>
    !row.schedule && row.items.some((item) => !item.metered && item.quantity > 1));
  test.skip(!sub, 'no unscheduled subscription carries a per-seat item');
  const seat = sub.items.find((item: { metered: boolean; quantity: number }) => !item.metered && item.quantity > 1);

  await page.goto(`/billing/subscriptions/${sub.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Schedule a change/ }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('What this phase is for').fill('Booked by the e2e run.');

  // The future phase has to differ from the present one, which is the point of
  // booking it: ten more seats from the renewal onwards.
  const quantity = dialog.getByLabel(`Quantity for phase item ${sub.items.indexOf(seat) + 1}`);
  await quantity.fill(String(seat.quantity + 10));
  await quantity.press('Enter');

  // The phase is priced before it is booked, by the same engine that bills it —
  // and in the account's own currency, never in raw minor units.
  const priced = dialog.locator('.bl-phasepreview__total');
  await expect(priced).toBeVisible();
  await expect(priced).not.toHaveText(/^\d+$/);

  // The button names the boundary the server already published on the record.
  await dialog.getByRole('button', { name: /^Schedule it for / }).click();
  await expect(page.getByText('Change scheduled')).toBeVisible();

  await expect.poll(async () => (await json(page, `/v1/subscriptions/${sub.id}`)).schedule).not.toBeNull();
  const scheduleId = (await json(page, `/v1/subscriptions/${sub.id}`)).schedule as string;
  const schedule = await json(page, `/v1/subscription-schedules/${scheduleId}`);
  expect(schedule.phases.length).toBe(2);
  // Phase one is the subscription as it stands; it hands over at the renewal
  // the dialog quoted, not at a date this screen worked out for itself.
  expect(schedule.phases[0].end_date).toBe(sub.current_period_end);
  expect(schedule.phases[1].start_date).toBe(sub.current_period_end);
  expect(schedule.phases[1].description).toBe('Booked by the e2e run.');
  expect(schedule.phases[1].summary).not.toBe(schedule.phases[0].summary);

  /* ---- and it can be undone from the tab that shows it ---- */
  await page.getByRole('tab', { name: 'Schedule' }).click();
  // The phase is priced in the account's own currency by the engine that will
  // bill it, so the row is checked against that answer rather than against
  // `phases[].summary`, which the server writes in each price's home currency.
  const phasePrice = await post(page, '/v1/catalog/estimate', {
    currency: sub.currency,
    lines: schedule.phases[1].items.map((item: { price: string; quantity: number }) => ({ price: item.price, quantity: item.quantity })),
  });
  const upcomingRow = page.locator('.bl-phase', { hasText: 'Upcoming' }).locator('.bl-phase__summary');
  await expect(upcomingRow).toBeVisible();
  const metered = await meteredPrices(page);
  for (const line of phasePrice.lines) {
    if (metered.has(line.price)) continue;
    await expect(upcomingRow).toContainText(line.amount_display);
  }
  await page.getByRole('button', { name: 'Release the subscription' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Release it' }).click();

  await expect(page.getByText('Released from the schedule')).toBeVisible();
  await expect.poll(async () => (await json(page, `/v1/subscriptions/${sub.id}`)).schedule).toBeNull();
  await expect.poll(async () => (await json(page, `/v1/subscription-schedules/${scheduleId}`)).status).toBe('released');
});

test('a subscription already under a schedule says so before anyone changes it', async ({ page }) => {
  const schedules = await json(page, '/v1/subscription-schedules?status=active&limit=10');
  const schedule = schedules.data.find((row: { subscription: string | null }) => row.subscription);
  test.skip(!schedule, 'no subscription in this workspace is under a schedule');

  await page.goto(`/billing/subscriptions/${schedule.subscription}`, { waitUntil: 'networkidle' });
  const upcoming = schedule.phases.find((phase: { state: string }) => phase.state === 'upcoming');
  if (upcoming) {
    await expect(page.getByText(`A change is already booked for`)).toBeVisible();
    // Priced here, in the subscription's currency — see the schedule tab test.
    const sub = await json(page, `/v1/subscriptions/${schedule.subscription}`);
    const priced = await post(page, '/v1/catalog/estimate', {
      currency: sub.currency,
      lines: upcoming.items.map((item: { price: string; quantity: number }) => ({ price: item.price, quantity: item.quantity })),
    });
    const metered = await meteredPrices(page);
    for (const line of priced.lines) {
      if (metered.has(line.price)) continue;
      await expect(page.locator('.ain-banner__body').first()).toContainText(line.amount_display);
    }
  }

  // The phases carry the server's own windows, not dates this screen computed.
  await page.getByRole('tab', { name: 'Schedule' }).click();
  for (const phase of schedule.phases) {
    await expect(page.locator('.bl-phase__desc', { hasText: phase.window })).toBeVisible();
  }
});

/* =============================== tax queue ================================ */




test('the invoice grid has a queue for bills nothing could place', async ({ page }) => {
  const missing = await json(page, '/v1/invoices?tax=missing&limit=100');
  await page.goto('/billing/invoices', { waitUntil: 'networkidle' });
  await page.getByLabel('Tax', { exact: true }).selectOption('missing');
  await expect(page).toHaveURL(/tax=missing/);

  // The grid answers with exactly the queue the API defines — including when
  // that queue is empty, which is a state and not a failure.
  await expect.poll(async () => page.locator('tbody tr[data-index]').count()).toBe(missing.data.length);
  if (missing.data.length === 0) {
    await expect(page.getByText('No invoice matches this filter')).toBeVisible();
  } else {
    await expect(page.locator('tbody')).toContainText(missing.data[0].number);
  }
});

/* ========================= the customer's own copy ======================== */

test('a reference typed on the account is printed on the document the customer gets', async ({ page }) => {
  const invoices = await json(page, '/v1/invoices?status=open&limit=20');
  const invoice = invoices.data[0];
  test.skip(!invoice, 'no invoice exists to print');
  const reference = `PO-${Date.now()}`;

  await page.goto(`/billing/customers/${invoice.customer}?tab=details`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add a reference' }).click();
  // Both halves before anything is written — a half-made reference would print
  // on the customer's document the moment it existed.
  await page.getByLabel('Reference name').fill('E2E purchase order');
  await page.getByLabel('Reference value').fill(reference);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  await expect.poll(async () => {
    const customer = await json(page, `/v1/customers/${invoice.customer}`);
    return customer.invoice_settings.custom_fields.some((field: { value: string }) => field.value === reference);
  }).toBe(true);

  // The server renders it into the bill-to block of the printable page.
  await page.goto(`/billing/invoices/${invoice.id}?tab=document`, { waitUntil: 'networkidle' });
  const frame = page.frameLocator(`iframe[title="Invoice ${invoice.number}"]`);
  await expect(frame.locator('body')).toContainText(reference);

  // And it can be taken off again.
  await page.goto(`/billing/customers/${invoice.customer}?tab=details`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /^Remove the reference / }).first().click();
  await expect.poll(async () => {
    const customer = await json(page, `/v1/customers/${invoice.customer}`);
    return customer.invoice_settings.custom_fields.length;
  }).toBe(0);
});

test('metadata can be added, re-valued and emptied on an account', async ({ page }) => {
  const customers = await json(page, '/v1/customers?limit=5');
  const customer = customers.data[0];
  const value = `NW-${Date.now()}`;

  await page.goto(`/billing/customers/${customer.id}?tab=details`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add a key' }).click();
  await page.getByLabel('Metadata key').fill('e2e_contract_id');
  await page.getByLabel('Metadata value').fill(value);
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect.poll(async () => (await json(page, `/v1/customers/${customer.id}`)).metadata.e2e_contract_id).toBe(value);

  await page.getByRole('button', { name: 'Edit Value of e2e_contract_id' }).click();
  const field = page.getByRole('textbox', { name: 'Value of e2e_contract_id' });
  await field.fill(`${value}-B`);
  await field.press('Enter');
  await expect.poll(async () => (await json(page, `/v1/customers/${customer.id}`)).metadata.e2e_contract_id).toBe(`${value}-B`);

  // The API merges metadata and has no deletion, so the control empties the key
  // rather than claiming to remove it — and the screen says exactly that.
  await page.getByRole('button', { name: 'Clear the value of e2e_contract_id' }).click();
  await expect.poll(async () => (await json(page, `/v1/customers/${customer.id}`)).metadata.e2e_contract_id).toBe('');
});


/* ============================ the whole book ============================== */

/**
 * The single most important property of a receivables screen: the count under
 * the grid is the count of the set the filter produced, and the totals beside
 * it cover that same set. The old grid filtered the hundred rows it had
 * fetched and printed the server's total over them, so "every invoice over
 * $1,000" answered 44 of 172 and then said there were 344.
 */
test('an amount filter answers about the whole book, and the footer counts what it matched', async ({ page }) => {
  const all: { currency: string; total: number; amount_due: number }[] = [];
  for (let cursor: string | null = null; ;) {
    const query = new URLSearchParams({ status: 'all', limit: '200' });
    if (cursor) query.set('cursor', cursor);
    const answer = await json(page, `/v1/invoices?${query}`);
    all.push(...answer.data);
    if (!answer.has_more || !answer.next_cursor) break;
    cursor = answer.next_cursor as string;
  }
  expect(all.length).toBeGreaterThan(200); // more than one page, or this proves nothing

  const me = await json(page, '/v1/me');
  const currency: string = me.org.default_currency;
  const floor = 100_000; // $1,000.00 in minor units
  const matching = all.filter((row) => row.currency === currency && row.total >= floor);
  test.skip(matching.length === 0, 'this book holds nothing over the threshold in its own currency');

  await page.goto('/billing/invoices', { waitUntil: 'networkidle' });
  // Unfiltered, the grid holds the book: its own row count is the book's size
  // and the line beside it says the totals cover all of it.
  await expect.poll(async () => page.locator('.ain-table__count').innerText())
    .toContain(`${all.length} row`);
  await expect(page.locator('.bl-listfoot__count')).toContainText('The whole book');

  await page.getByRole('button', { name: /^Amount$/ }).click();
  await page.getByLabel('Smallest amount').fill('1000');
  await page.getByRole('button', { name: 'Apply' }).click();

  // The chip names the figure, the amount and the currency it pinned.
  await expect(page.getByRole('button', { name: /^Total ≥/ }))
    .toContainText(currency.toUpperCase());

  // The count is the count of the filtered set, over the whole book — and the
  // line beside it says so, rather than quoting a server total over a page.
  await expect.poll(async () => page.locator('.ain-table__count').innerText())
    .toContain(`${matching.length} row`);
  await expect(page.locator('.bl-listfoot__count'))
    .toContainText(`${matching.length} of the ${all.length}`);

  // And the totals row sums that same set — one figure, in one currency.
  const owed = matching.reduce((sum, row) => sum + row.total, 0);
  const expected = new Intl.NumberFormat(me.org.locale ?? 'en-US', { style: 'currency', currency: currency.toUpperCase() }).format(owed / 100);
  await expect(page.locator('tfoot')).toContainText(expected);

  // The filter is in the address bar, so the answer is a link someone can send.
  expect(page.url()).toContain('amount=total');
});

test('the columns menu names columns, not the sentences they are explained with', async ({ page }) => {
  await page.goto('/billing/invoices', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Columns' }).click();

  const labels = await page.locator('.ain-table__colmenu .ain-check__label').allInnerTexts();
  expect(labels).toContain('Total');
  expect(labels).toContain('Amount due');
  // No prose, and no permanently greyed filter-only rows pretending to be columns.
  for (const label of labels) {
    expect(label.length, label).toBeLessThan(24);
    expect(label, label).not.toContain('.');
  }
  await expect(page.locator('.ain-table__colmenu input[disabled]')).toHaveCount(1); // the pinned first column
});

/* ========================= dialogs from the keyboard ====================== */

test('a dialog opens on its first field and Enter creates the record', async ({ page }) => {
  await page.goto('/billing/customers', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New customer' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Focus is on the field, not on the Close button that would throw the work away.
  const name = dialog.getByLabel('Name');
  await expect(name).toBeFocused();

  const label = `Keyboard Only Robotics ${Date.now().toString().slice(-6)}`;
  await page.keyboard.type(label);
  await expect(name).toHaveValue(label);

  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/billing\/customers\/cus_/);

  const created = await json(page, `/v1/customers?query=${encodeURIComponent(label)}`);
  expect(created.data).toHaveLength(1);
  expect(created.data[0].name).toBe(label);

  // A brand-new account has settled nothing, and does not claim it has.
  await expect(page.getByText('No bill has been raised yet')).toBeVisible();

  await page.request.delete(`/api/v1/customers/${created.data[0].id}`);
});

test('Enter does not submit a dialog whose primary action is disabled', async ({ page }) => {
  const before = await json(page, '/v1/customers?limit=1');
  await page.goto('/billing/customers', { waitUntil: 'networkidle' });

  /**
   * "Enter does nothing here" is two rules, and only one of them is about the
   * handler. The other is about where the focus is when the key is pressed: a
   * modal traps focus on its first focusable child, which is Close, and the
   * dialog moves it onto the first field afterwards. For as long as that hand-
   * over takes, Enter is a click on Close and the dialog the operator just
   * opened is gone — no submit, but the work thrown away all the same.
   *
   * The hand-over is one animation frame wide, so on an idle machine it is
   * invisible and on a loaded one — a whole suite in one worker — it is not.
   * The browser is slowed so a frame is long enough to watch, and what is
   * watched is the invariant: from the moment the dialog takes focus, focus
   * never rests on a control that would discard the dialog.
   */
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
  await page.evaluate(() => {
    const w = window as unknown as { __focusTrail?: string[]; __focusTimer?: number };
    w.__focusTrail = [];
    w.__focusTimer = window.setInterval(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.closest('[role="dialog"]')) return;
      const label = `${el.tagName}:${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20)}`;
      const trail = w.__focusTrail as string[];
      if (trail[trail.length - 1] !== label) trail.push(label);
    }, 2);
  });

  await page.getByRole('button', { name: 'New customer' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Create customer' })).toBeDisabled({ timeout: 30_000 });

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible({ timeout: 30_000 });       // it neither submitted nor closed

  const trail = await page.evaluate(() => {
    const w = window as unknown as { __focusTrail: string[]; __focusTimer: number };
    window.clearInterval(w.__focusTimer);
    return w.__focusTrail;
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  // A probe that saw nothing proves nothing.
  expect(trail.length).toBeGreaterThan(0);
  expect(trail[0]).toMatch(/^INPUT/);
  expect(trail.join(' → ')).not.toMatch(/Close|Cancel/);

  const after = await json(page, '/v1/customers?limit=1');
  expect(after.total_count).toBe(before.total_count);
});

/* ============================== quantities =============================== */

test('a typed quantity reaches the price and the stepper before anything is blurred', async ({ page }) => {
  await page.goto('/billing/subscriptions', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New subscription' }).click();
  const dialog = page.getByRole('dialog');

  const customers = await json(page, '/v1/customers?limit=1');
  await pickCustomer(page, dialog, customers.data[0].name);

  const prices = await json(page, '/v1/prices?active=true&limit=200');
  const seat = prices.data.find((row: { model: string; type: string; recurring: { usage_type: string } | null }) =>
    row.type === 'recurring' && row.model === 'per_unit' && row.recurring?.usage_type !== 'metered');
  test.skip(!seat, 'the catalogue has no per-unit recurring price');
  await dialog.getByLabel('Price 1').selectOption(seat.id);

  const quantity = dialog.getByRole('spinbutton', { name: 'Quantity 1' });
  await quantity.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('7');

  // No blur, no Tab, no click elsewhere: the price follows the field.
  await expect(quantity).toHaveValue('7');
  await expect.poll(async () => dialog.locator('.bl-lines').first().innerText(), { timeout: 6000 })
    .toContain('7');

  // And the stepper steps from what the field reads, not from the last value
  // it happened to commit — typing 7 and pressing ArrowUp gives 8, never 2.
  await quantity.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('7');
  await page.keyboard.press('ArrowUp');
  await expect(quantity).toHaveValue('8');
});

/* ============================ dates and clocks =========================== */

test('one invoice is dated on one calendar — the one the customer’s copy carries', async ({ page }) => {
  const invoices = await json(page, '/v1/invoices?status=paid&limit=1');
  const invoice = invoices.data[0];
  test.skip(!invoice?.paid_at, 'no paid invoice to read');

  const me = await json(page, '/v1/me');
  const locale = me.org.locale ?? 'en-US';
  // The document stamps itself on a UTC calendar. Every date on this screen
  // that *names the invoice* has to be that one, or an AR agent quotes a day
  // the customer cannot find on the bill in their hand.
  const onDocument = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  });
  const paidOn = onDocument.format(invoice.paid_at);
  const issuedOn = onDocument.format(invoice.created);

  await page.goto(`/billing/invoices/${invoice.id}`, { waitUntil: 'networkidle' });

  await expect(page.locator('.ain-page__subtitle')).toContainText(paidOn);
  await expect(page.locator('.bl-headline__caption', { hasText: 'Settled' })).toHaveText(`Settled ${paidOn}`);

  const issued = page.locator('.bl-fieldrow', { hasText: 'Issued' }).first();
  // The row's own value, without the hint nested under it.
  const issuedValue = await issued.locator('.bl-fieldrow__value').evaluate(
    (node) => Array.from(node.childNodes)
      .filter((child) => !(child instanceof HTMLElement && child.classList.contains('bl-fieldrow__hint')))
      .map((child) => child.textContent ?? '')
      .join('')
      .trim(),
  );
  expect(issuedValue).toBe(issuedOn);

  // The operator's own clock is not lost — it moves to the hint, named as
  // their time rather than presented as the invoice's date.
  await expect(issued.locator('.bl-fieldrow__hint')).toContainText('Recorded');
  await expect(issued.locator('.bl-fieldrow__hint')).toContainText(me.org.timezone.replace(/_/g, ' '));

  // And the document itself agrees with all of it.
  await page.getByRole('tab', { name: 'Document' }).click();
  const frame = page.frameLocator(`iframe[title="Invoice ${invoice.number}"]`);
  await expect(frame.locator('body')).toContainText(issuedOn);
});

/* ============================= missing records =========================== */

test('a record that does not exist offers the way back, not a doomed retry', async ({ page }) => {
  await page.goto('/billing/invoices/in_doesnotexist000000', { waitUntil: 'networkidle' });
  await expect(page.getByText('No such invoice', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to invoices' }).click();
  await expect(page).toHaveURL(/\/billing\/invoices$/);
});

/* ============================ one-off charges ============================ */

/**
 * This platform has no invoice-item route: a hand-written charge is carried on
 * the account balance and drawn down by the next bill. What the screen owes an
 * operator is a way to do it and an honest sentence about what it does — not a
 * dead end that says "nothing is waiting on this account" and stops.
 */
test('a one-off amount can be carried on an account’s balance from the invoice screen', async ({ page }) => {
  const customers = await json(page, '/v1/customers?limit=200');
  // The account is picked by typing the start of its name, so it must be the
  // only account that starts that way — earlier runs of this file leave
  // "Playwright …" accounts behind that share a prefix.
  const prefix = (name: string) => name.slice(0, 18);
  const prefixes = new Map<string, number>();
  for (const row of customers.data) prefixes.set(prefix(row.name), (prefixes.get(prefix(row.name)) ?? 0) + 1);
  const unique = customers.data.filter((row: { name: string }) => prefixes.get(prefix(row.name)) === 1);
  const account = unique.find((row: { balance: number }) => row.balance === 0) ?? unique[0];
  const before = account.balance;

  await page.goto('/billing/invoices', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Bill an account' }).click();
  const dialog = page.getByRole('dialog');
  await pickCustomer(page, dialog, account.name);

  // The path is named for what it does — a balance adjustment the next invoice
  // draws down — not "Charge", which it never was.
  // "Adjust the balance…" became "Adjust the account balance instead…" when
  // the dialog grew a second act beside it: "Add a one-off line…" really does
  // write a line on a document now. The two are named for what each does.
  await dialog.getByRole('button', { name: /Adjust the account balance instead/ }).click();
  const charge = page.getByRole('dialog', { name: 'Adjust the account balance' });
  await expect(charge).toBeVisible();
  await expect(charge).toContainText('next invoice');

  await charge.getByLabel('Amount').fill('250');
  await charge.getByLabel('Why').fill('Onboarding and commissioning, 2 days on site');
  await charge.getByRole('button', { name: /^Charge / }).click();

  await expect.poll(async () => (await json(page, `/v1/customers/${account.id}`)).balance)
    .toBe(before + 25_000);

  // It is on the account's ledger, in the words the balance tile uses. The
  // newest entry is the one this run wrote; an earlier run of this file on the
  // same workspace leaves its own behind.
  await page.goto(`/billing/customers/${account.id}?tab=ledger`, { waitUntil: 'networkidle' });
  const row = page.locator('tbody tr', { hasText: 'Onboarding and commissioning' }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('owed');

  await page.request.post(`/api/v1/customers/${account.id}/balance_transactions`, {
    data: { amount: -25_000, description: 'Reversing the test charge', type: 'adjustment' },
  });
});

test('a grid still loading does not report zero rows underneath its skeletons', async ({ page }) => {
  // The critic's repro: a slow API left "0 rows / No invoices on this page"
  // printed under eight skeleton rows — a count asserted about a read that had
  // not answered.
  await page.route('**/api/v1/invoices?**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    // The route is removed below while this is still sleeping, and a handler
    // unrouted mid-flight cannot hand its own request on any more: continuing
    // it then throws "Route is already handled" and fails a test that was
    // about the skeleton, not about the interception. The request is served
    // either way — the poll below is what proves it — so only the throw is
    // swallowed.
    await route.continue().catch(() => { /* unrouted while this slept */ });
  });
  await page.goto('/billing/invoices', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('.bl-listfoot__count')).toContainText('Reading the invoices');
  // The grid's own count is suppressed rather than left asserting zero.
  await expect(page.locator('.ain-table__count')).toBeHidden();

  await page.unroute('**/api/v1/invoices?**');
  await expect.poll(async () => page.locator('.bl-listfoot__count').innerText(), { timeout: 20_000 })
    .toContain('whole book');
});

/* ========================= partial payments ============================== */

/**
 * The defect this exists to keep fixed: an AR clerk received $40,000 against a
 * $127,840 invoice, typed it into the only field the dialog had, and the bill
 * was marked settled in full with the number sitting in a note.
 *
 * A part payment is a real thing here — the gateway takes an amount as a
 * ceiling and never re-prices it upwards — so the screen has to be able to
 * write one down, leave the bill open for the rest, and say what is still owed.
 */
test('a part payment is recorded for what actually arrived, and the bill stays open for the rest', async ({ page }) => {
  /**
   * Its own account and its own bill.
   *
   * The flow this exists for is the one where the account has nothing on file
   * and the operator attaches the instrument the money came from — and whether
   * the book's first open invoice happens to be such an account is decided by
   * whatever ran before this. Picked from the book, this test drove the attach
   * flow on some runs and skipped it on others, and passed either way while the
   * attach was quietly settling the bill in full.
   */
  const account = await post(page, '/v1/customers', {
    name: `Part Payment Co ${Date.now().toString().slice(-6)}`, currency: 'usd',
  });
  const sub = await post(page, '/v1/subscriptions', {
    customer: account.id,
    items: [{ price: 'price_nw_starter_monthly', quantity: 1 }],
    collection_method: 'charge_automatically',
  });
  const invoice: InvoiceRow = await json(page, `/v1/invoices/${sub.latest_invoice.id}`);
  expect(invoice.status).toBe('open');
  expect(invoice.amount_paid).toBe(0);
  // Two whole major units at least, so half of it is still a real part payment.
  expect(invoice.amount_due).toBeGreaterThanOrEqual(200);

  // A presentation needs something to present against. Attaching one is a
  // first-class flow on this dialog, so the test drives it the same way.
  await page.goto(`/billing/invoices/${invoice.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Take a payment' }).click();
  const dialog = page.getByRole('dialog', { name: /Take a payment on/ });
  await expect(dialog).toBeVisible();

  expect(await dialog.getByLabel('How it was taken').locator('option').count()).toBe(1);
  await dialog.getByRole('button', { name: /Attach a card or bank account/ }).click();
  const attach = page.getByRole('dialog', { name: /payment method/i });
  await attach.getByRole('button', { name: /^Attach/ }).click();
  await expect(attach).toBeHidden();

  // Attaching something to present against presents nothing. The account had
  // no method, so this bill is one the automatic charge could never reach —
  // and the platform hands such a bill to the first method that arrives, which
  // here would collect the whole balance a moment before the operator says how
  // much of it actually turned up.
  // A wait, because what is being asserted is that nothing happened: the
  // presentation this used to trigger is a job, and a job runs on a tick.
  await page.waitForTimeout(3000);
  const untouched = await json(page, `/v1/invoices/${invoice.id}`);
  expect(untouched.amount_paid).toBe(0);
  expect(untouched.amount_due).toBe(invoice.amount_due);
  expect(untouched.status).toBe('open');

  // Half of what is still owed, rounded to whole major units so the arithmetic
  // is readable in the assertion.
  const half = Math.floor(invoice.amount_due / 200) * 100;
  const amountField = dialog.getByLabel('Amount received');
  await amountField.fill(String(half / 100));
  await expect(dialog.getByRole('button', { name: /still owed/ })).toBeVisible();

  await dialog.getByRole('button', { name: /^Record / }).click();
  await expect(dialog).toBeHidden();

  await expect.poll(async () => (await json(page, `/v1/invoices/${invoice.id}`)).amount_due).toBeLessThan(invoice.amount_due);
  const after = await json(page, `/v1/invoices/${invoice.id}`);
  // Exactly what was typed came off the bill, and the rest is still owed.
  expect(after.amount_paid - invoice.amount_paid).toBe(half);
  expect(after.amount_due).toBe(invoice.amount_due - half);
  expect(after.status).toBe('open');

  // And the bill's own figures are the money the ledger holds, not a second
  // opinion about it: what the charges took, less what went back.
  const book = await json(page, `/v1/invoices/${invoice.id}/payments`);
  const collected = (book.charges as { status: string; amount: number; amount_refunded: number }[])
    .filter((row) => row.status === 'succeeded')
    .reduce((sum, row) => sum + row.amount - row.amount_refunded, 0);
  expect(collected).toBe(half);
  expect(book.amount_paid).toBe(collected);
  expect(book.amount_due).toBe(book.total - collected);

  // And the screen says so rather than calling a part payment a settlement.
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.bl-headline', { hasText: 'Collected' })).toContainText('Part paid');

  await removeAccount(page, account.id);
});

/**
 * The route that settles by hand takes no amount. Rather than let that be
 * discovered after a bill is wrongly marked paid, the dialog refuses the
 * combination and says which two things cannot both be true.
 */
test('settling by hand refuses a part amount instead of silently rounding it up', async ({ page }) => {
  const open = await json(page, '/v1/invoices?status=open&limit=20');
  const invoice = (await notBeingChased(page, open.data)).filter((row) => row.amount_due >= 200)[0];
  test.skip(!invoice, 'nothing large enough is owed in this workspace');

  await page.goto(`/billing/invoices/${invoice.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Take a payment' }).click();
  const dialog = page.getByRole('dialog', { name: /Take a payment on/ });

  await dialog.getByLabel('How it was taken').selectOption(BY_HAND_LABEL);
  await dialog.getByLabel('Amount received').fill(String(Math.floor(invoice.amount_due / 200)));

  await expect(dialog.getByText('A part payment has to be presented')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Record / })).toBeDisabled();

  // Nothing was written.
  const after = await json(page, `/v1/invoices/${invoice.id}`);
  expect(after.status).toBe('open');
  expect(after.amount_paid).toBe(invoice.amount_paid ?? 0);
});

test('a settled invoice says why its money button is closed rather than greying out in silence', async ({ page }) => {
  const paid = await json(page, '/v1/invoices?status=paid&limit=1');
  const invoice = paid.data[0];
  test.skip(!invoice, 'nothing is settled in this workspace');

  await page.goto(`/billing/invoices/${invoice.id}`, { waitUntil: 'networkidle' });
  const button = page.getByRole('button', { name: 'Take a payment' });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', /Nothing left to collect/);
});

/* ============================== export ================================== */

/**
 * Closing a month means handing finance the aged book. Without this the only
 * route out of the product is retyping it.
 */
test('every book exports the rows on screen, formatted the way the screen formats them', async ({ page }) => {
  for (const [route, name, header] of [
    ['/billing/invoices', 'invoices', 'Number'],
    ['/billing/subscriptions', 'subscriptions', 'Account'],
    ['/billing/customers', 'customers', 'Account'],
  ] as const) {
    await page.goto(route, { waitUntil: 'networkidle' });
    const button = page.getByRole('button', { name: 'Export' });
    await expect(button).toBeEnabled({ timeout: 20_000 });
    const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
    expect(download.suggestedFilename()).toMatch(new RegExp(`^ain-${name}-\\d{4}-\\d{2}-\\d{2}\\.csv$`));

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const csv = Buffer.concat(chunks).toString('utf8');
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toContain(header);
    // One line per row on screen, plus the header.
    const rows = Number((await page.locator('.ain-table__count').innerText()).replace(/\D+/g, ''));
    expect(lines.length - 1).toBe(rows);
    // Money is a decimal in the major unit, never the minor-unit integer.
    expect(csv).not.toMatch(/,\d{7,},/);
  }
});

/**
 * The filtered export is the filtered file. A file that quietly holds more rows
 * than the screen did is how a reconciliation goes wrong twice.
 */
test('the export follows the filter', async ({ page }) => {
  await page.goto('/billing/invoices?status=open', { waitUntil: 'networkidle' });
  const button = page.getByRole('button', { name: 'Export' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const lines = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '').trim().split('\r\n');

  const open = await json(page, '/v1/invoices?status=open&limit=1');
  expect(lines.length - 1).toBe(open.total_count);
  for (const line of lines.slice(1)) expect(line).toContain('Open');
});

/* ========================= the caption tells the truth ==================== */

/**
 * The P0 from the last round: every server-narrowed list described itself as
 * the whole book, directly under money totals that only covered the filtered
 * part of it — including the subscriptions list's own default view.
 */
test('a narrowed list never calls itself the whole book', async ({ page }) => {
  const whole = await json(page, '/v1/invoices?status=all&limit=1');
  const openOnly = await json(page, '/v1/invoices?status=open&limit=1');
  test.skip(openOnly.total_count === whole.total_count, 'every invoice in this workspace is open');

  await page.goto('/billing/invoices?status=open', { waitUntil: 'networkidle' });
  const caption = page.locator('.bl-listfoot__count');
  await expect(caption).toContainText(`of the ${whole.total_count.toLocaleString('en-US')} invoices in the book match`);
  await expect(caption).not.toContainText('The whole book');

  // The default subscriptions view is already narrowed — "Everything live" is
  // a filter — so it must not claim the book either.
  const live = await json(page, '/v1/subscriptions?status=active_like&limit=1');
  const all = await json(page, '/v1/subscriptions?status=all&limit=1');
  if (live.total_count !== all.total_count) {
    await page.goto('/billing/subscriptions', { waitUntil: 'networkidle' });
    await expect(page.locator('.bl-listfoot__count')).toContainText(`of the ${all.total_count.toLocaleString('en-US')} subscriptions in the book match`);
  }

  // A filter that matches nothing says nothing matched, not "the whole book".
  await page.goto('/billing/customers?standing=delinquent', { waitUntil: 'networkidle' });
  const customers = await json(page, '/v1/customers?limit=1');
  await expect(page.locator('.bl-listfoot__count'))
    .toContainText(`of the ${customers.total_count.toLocaleString('en-US')} customers in the book`);
});

/* ====================== reconciling counts and money ===================== */

test('a paused agreement never prints a bare $0.00 MRR beside its own fee', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=paused&limit=1');
  const sub = subs.data[0];
  test.skip(!sub, 'nothing is paused in this workspace');

  await page.goto(`/billing/subscriptions/${sub.id}`, { waitUntil: 'networkidle' });
  const tile = page.locator('.bl-headline', { hasText: 'MRR' }).first();
  if (sub.mrr === 0 && sub.recurring_subtotal > 0) {
    await expect(tile).toContainText('Excluded while collection is paused');
  }
});

test('an account’s headline counts subscriptions the way the MRR beside it counts them', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=paused&limit=1');
  const sub = subs.data[0];
  test.skip(!sub, 'nothing is paused in this workspace');

  await page.goto(`/billing/customers/${sub.customer}`, { waitUntil: 'networkidle' });
  const subtitle = page.locator('.ain-page__subtitle');
  await expect(subtitle).toContainText('paused');
  await expect(subtitle).toContainText('excluded from MRR');
});

test('the receivables card does not count a draft nobody has sent as money owed', async ({ page }) => {
  const drafts = await json(page, '/v1/invoices?status=draft&limit=50');
  await page.goto('/billing', { waitUntil: 'networkidle' });
  const card = page.locator('.ain-card', { hasText: 'Owed right now' });
  await expect(card).toBeVisible();
  for (const draft of drafts.data) await expect(card.getByText(draft.number, { exact: true })).toHaveCount(0);
  if (drafts.data.length) await expect(card.getByText('Not counted above')).toBeVisible();
});

/* ============================ locked fields ============================== */

test('billing a known account names it rather than printing its id', async ({ page }) => {
  const customers = await json(page, '/v1/customers?limit=5');
  const account = customers.data?.[0];
  test.skip(!account, 'no account to bill');

  await page.goto(`/billing/customers/${account.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Bill now' }).click();
  const dialog = page.getByRole('dialog', { name: /Bill what this account owes/ });
  await expect(dialog.getByText(account.name, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Customer' })).toHaveCount(0);
});

test('a 404 on a customer does not blame a void that cannot happen to one', async ({ page }) => {
  await page.goto('/billing/customers/cus_doesnotexist00000', { waitUntil: 'networkidle' });
  await expect(page.getByText('No such account', { exact: true })).toBeVisible();
  await expect(page.getByText(/voided and removed/)).toHaveCount(0);
  await expect(page.getByText(/may have been deleted/)).toBeVisible();
});

test('the amount filter’s fields can be reached by the words printed on them', async ({ page }) => {
  await page.goto('/billing/invoices', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Amount', exact: true }).click();
  await expect(page.getByLabel('From (smallest amount)')).toBeVisible();
  await expect(page.getByLabel('To (largest amount)')).toBeVisible();
});

/**
 * The upcoming invoice is the one surface that shows a line the customer will
 * actually receive, and it was the one printing the raw ten-digit rational
 * inline. The sentence stays; the fraction goes behind the disclosure every
 * other surface already uses.
 */
test('an upcoming invoice line explains itself in words, with the arithmetic behind a disclosure', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=20');
  let disclosed = false;
  for (const sub of subs.data.slice(0, 8)) {
    await page.goto(`/billing/subscriptions/${sub.id}?tab=upcoming`, { waitUntil: 'networkidle' });
    await expect(page.locator('.bl-lines').first()).toBeVisible();
    // The invariant, on every one of them: no unreduced rational printed as
    // invoice-line copy.
    await expect(page.locator('.bl-lines__why', { hasText: /\d{6,}\s*\/\s*\d{6,}\s*ms/ })).toHaveCount(0);
    const toggle = page.locator('.bl-lines .bl-lines__toggle').first();
    if (!disclosed && await toggle.count()) {
      disclosed = true;
      await toggle.click();
      await expect(page.locator('.bl-fraction').first()).toBeVisible();
    }
  }
});

test('the payment dialog is operable from the keyboard alone', async ({ page }) => {
  const open = await json(page, '/v1/invoices?status=open&limit=20');
  const invoice = (await notBeingChased(page, open.data))[0];
  test.skip(!invoice, 'nothing is owed in this workspace');

  await page.goto(`/billing/invoices/${invoice.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Take a payment' }).click();
  const dialog = page.getByRole('dialog', { name: /Take a payment on/ });

  // It opens on the field that decides the money.
  await expect(dialog.getByLabel('Amount received')).toBeFocused();
  // Escape closes it without writing anything.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect((await json(page, `/v1/invoices/${invoice.id}`)).status).toBe('open');
});

/* ======================= what the screen says after a write ======================= */

/**
 * A customer with a card the simulated issuer will refuse, made through the
 * API so the test is about the screen that reports the decline and not about
 * the one that attaches the card.
 */
async function customerWithDecliningCard(page: Page, name: string): Promise<{ id: string; name: string }> {
  const customer = await post(page, '/v1/customers', { name, currency: 'usd', invoice_settings: { days_until_due: 0 } });
  await post(page, '/v1/payment_methods', {
    customer: customer.id, type: 'card', brand: 'visa', last4: '0002',
    exp_month: 12, exp_year: 2030, simulated_behavior: 'card_declined', set_default: true,
  });
  return { id: customer.id, name: customer.name };
}

/** Leave the workspace as it was found: stop the subscriptions, remove the account. */
async function removeAccount(page: Page, customerId: string): Promise<void> {
  const subs = await json(page, `/v1/subscriptions?customer=${customerId}&status=all&limit=20`);
  for (const sub of subs.data ?? []) {
    if (sub.status !== 'canceled') await page.request.post(`/api/v1/subscriptions/${sub.id}/cancel`, { data: {} });
  }
  // An open bill on a deleted account is a receivable nobody can settle, and
  // the next test to pick "an open invoice" would pick it.
  const open = await json(page, `/v1/invoices?customer=${customerId}&status=open_like&limit=20`);
  for (const invoice of open.data ?? []) {
    await page.request.post(`/api/v1/invoices/${invoice.id}/void`, { data: {} });
  }
  await page.request.delete(`/api/v1/customers/${customerId}`);
}

test('a subscription whose first charge is declined is reported as declined, not as billed', async ({ page }) => {
  const account = await customerWithDecliningCard(page, `Declining Card Co ${Date.now().toString().slice(-6)}`);
  await page.goto(`/billing/customers/${account.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New subscription' }).click();
  const dialog = page.getByRole('dialog', { name: 'New subscription' });
  await dialog.getByLabel('Price 1').selectOption('price_nw_starter_monthly');
  // The basket is priced by the API before the button carries a figure; under
  // a full suite's load that can take longer than the default expect window.
  await expect(dialog.getByRole('button', { name: /^Create · / })).toBeEnabled({ timeout: 20_000 });
  await dialog.getByRole('button', { name: /^Create · / }).click();

  // The toast is worded from the record after the collector has answered.
  const toast = page.locator('.ain-toast', { hasText: 'Subscription created' }).first();
  await expect(toast).toBeVisible({ timeout: 25_000 });
  await expect(toast).toContainText('declined');
  await expect(toast).not.toContainText('open and billed');

  // And the screen it lands on agrees with the API without a reload.
  await expect(page).toHaveURL(/\/billing\/subscriptions\/sub_/);
  const id = page.url().split('/').pop() as string;
  await expect.poll(async () => (await json(page, `/v1/subscriptions/${id}`)).status).toBe('past_due');
  await expect(page.locator('.ain-page__title')).toContainText('Past due');
  await expect(page.locator('.ain-page__title')).not.toContainText(/\bActive\b/);
  await removeAccount(page, account.id);
});

/**
 * The same screen, with the one answer a busy minute really gives.
 *
 * `POST /v1/subscriptions` returns before the collector has run, so the dialog
 * reads the record back until the issuer has answered and words the toast — and
 * primes the detail page — from that reading. The read-back goes through the
 * same rate limiter as everything else, and 429 is a legitimate answer to it.
 * One refusal used to end the wait outright: the sentence was written from the
 * POST's own response, which knows nothing about the money and carries no
 * expanded customer, so the toast said nothing was collected over a declined
 * card and the page opened on a raw cus_… id under the word "Active".
 *
 * The refusal is injected rather than waited for, because a limiter that only
 * refuses under load is a defect you can only reproduce by accident.
 */
test('one refused read-back does not turn a declined charge into "nothing collected yet"', async ({ page }) => {
  const account = await customerWithDecliningCard(page, `Refused Read Co ${Date.now().toString().slice(-6)}`);

  let refusals = 0;
  await page.route('**/api/v1/subscriptions/sub_*', async (route) => {
    if (route.request().method() === 'GET' && refusals === 0) {
      refusals += 1;
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: { type: 'rate_limit_error', code: 'rate_limit', message: 'Too many requests. Retry with exponential backoff.' } }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/billing/customers/${account.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New subscription' }).click();
  const dialog = page.getByRole('dialog', { name: 'New subscription' });
  await dialog.getByLabel('Price 1').selectOption('price_nw_starter_monthly');
  await expect(dialog.getByRole('button', { name: /^Create · / })).toBeEnabled({ timeout: 20_000 });
  await dialog.getByRole('button', { name: /^Create · / }).click();

  const toast = page.locator('.ain-toast', { hasText: 'Subscription created' }).first();
  await expect(toast).toBeVisible({ timeout: 25_000 });
  expect(refusals).toBe(1);                       // the refusal really happened
  await expect(toast).toContainText('declined');
  await expect(toast).not.toContainText('nothing collected yet');

  // And the screen it lands on names the account rather than its key, and says
  // what happened — from the first frame, not once a refresh tick has been
  // round to correct it. Sampled rather than awaited: `expect` retries, so an
  // assertion that only has to become true a second and a half later is one
  // the stale record passes too.
  await expect(page).toHaveURL(/\/billing\/subscriptions\/sub_/);
  const title = page.locator('.ain-page__title');
  const samples: string[] = [];
  for (let i = 0; i < 30; i++) {
    samples.push(await title.innerText().catch(() => ''));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(samples.join(' | ')).not.toMatch(/cus_[A-Za-z0-9]/);
  expect(samples.join(' | ')).not.toMatch(/\bActive\b/);
  await expect(title).toContainText(account.name);
  await expect(title).toContainText('Past due');

  await page.unroute('**/api/v1/subscriptions/sub_*');
  await removeAccount(page, account.id);
});

/**
 * And when every read-back is refused, so there is no reading at all.
 *
 * The dialog primes the detail page's cache so the next screen opens on the
 * record the money has already moved on. What it must never prime it with is
 * the POST's own answer: that came back from a different address, one that was
 * asked for no `expand=customer`, so the account on the headline rendered as
 * its raw cus_… key — under a status read before the collector ran. Nothing
 * read means nothing primed, and the screen asks for itself.
 */
test('a read-back that never answers leaves the next screen to read for itself', async ({ page }) => {
  const account = await customerWithDecliningCard(page, `Silent Read Co ${Date.now().toString().slice(-6)}`);

  // Long enough to outlast the dialog's patience, then out of the way so the
  // page that opens can read the record it needs.
  let refusals = 0;
  await page.route('**/api/v1/subscriptions/sub_*', async (route) => {
    if (route.request().method() === 'GET' && refusals < 12) {
      refusals += 1;
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: { type: 'rate_limit_error', code: 'rate_limit', message: 'Too many requests. Retry with exponential backoff.' } }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/billing/customers/${account.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New subscription' }).click();
  const dialog = page.getByRole('dialog', { name: 'New subscription' });
  await dialog.getByLabel('Price 1').selectOption('price_nw_starter_monthly');
  await expect(dialog.getByRole('button', { name: /^Create · / })).toBeEnabled({ timeout: 20_000 });
  await dialog.getByRole('button', { name: /^Create · / }).click();

  const toast = page.locator('.ain-toast', { hasText: 'Subscription created' }).first();
  await expect(toast).toBeVisible({ timeout: 40_000 });
  expect(refusals).toBe(12);                      // every attempt was refused
  // Nothing was read, so nothing is claimed about the money either way.
  await expect(toast).not.toContainText('was raised and');

  await expect(page).toHaveURL(/\/billing\/subscriptions\/sub_/);
  const title = page.locator('.ain-page__title');
  const samples: string[] = [];
  for (let i = 0; i < 30; i++) {
    samples.push(await title.innerText().catch(() => ''));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(samples.join(' | ')).not.toMatch(/cus_[A-Za-z0-9]/);
  await expect(title).toContainText(account.name);

  await page.unroute('**/api/v1/subscriptions/sub_*');
  await removeAccount(page, account.id);
});

test('deleting a customer is confirmed with what it holds, and refused while it is subscribed', async ({ page }) => {
  const account = await customerWithDecliningCard(page, `Delete Me Co ${Date.now().toString().slice(-6)}`);
  await page.goto(`/billing/customers/${account.id}`, { waitUntil: 'networkidle' });

  // One click on the menu item opens a dialog; it does not delete.
  await page.getByRole('button', { name: 'More account actions' }).click();
  await page.getByRole('menuitem', { name: /Delete this customer/ }).click();
  const dialog = page.getByRole('dialog', { name: `Delete ${account.name}?` });
  await expect(dialog).toBeVisible();
  expect((await page.request.get(`/api/v1/customers/${account.id}`)).status()).toBe(200);
  await expect(dialog).toContainText('no live subscription');
  await expect(dialog).toContainText('no route that restores');

  // Walk away: nothing happened.
  await dialog.getByRole('button', { name: 'Keep the account' }).click();
  await expect(dialog).toBeHidden();
  expect((await page.request.get(`/api/v1/customers/${account.id}`)).status()).toBe(200);

  // With a live subscription the door is closed, and says why, before the 409.
  await page.request.post('/api/v1/subscriptions', {
    data: { customer: account.id, items: [{ price: 'price_nw_starter_monthly', quantity: 1 }], collection_method: 'send_invoice' },
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'More account actions' }).click();
  await page.getByRole('menuitem', { name: /Delete this customer/ }).click();
  const blocked = page.getByRole('dialog', { name: `Delete ${account.name}?` });
  await expect(blocked).toContainText('refuses to delete it');
  await expect(blocked.getByRole('button', { name: `Delete ${account.name}` })).toBeDisabled();
  await page.keyboard.press('Escape');

  // The list's row menu goes through the same dialog, and the confirm deletes.
  const sub = (await json(page, `/v1/subscriptions?customer=${account.id}&status=all`)).data[0];
  await page.request.post(`/api/v1/subscriptions/${sub.id}/cancel`, { data: {} });
  await page.goto(`/billing/customers?q=${encodeURIComponent(account.name)}`, { waitUntil: 'networkidle' });
  const row = page.locator('tbody tr', { hasText: account.name }).first();
  await row.hover();
  await row.getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: /Delete this customer/ }).click();
  const confirm = page.getByRole('dialog', { name: `Delete ${account.name}?` });
  await expect(confirm.getByRole('button', { name: `Delete ${account.name}` })).toBeEnabled();
  await confirm.getByRole('button', { name: `Delete ${account.name}` }).click();
  await expect.poll(async () => (await page.request.get(`/api/v1/customers/${account.id}`)).status()).toBe(404);
});

test('a list row’s actions menu opens from the keyboard, and Enter does not leave the page', async ({ page }) => {
  await page.goto('/billing/customers', { waitUntil: 'networkidle' });
  const button = page.locator('tbody tr').first().getByRole('button', { name: 'Row actions' });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: 'Row actions' })).toBeVisible();
  await expect(page).toHaveURL(/\/billing\/customers$/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Row actions' })).toBeHidden();

  // Space opens it too, rather than ticking the row's checkbox.
  await button.focus();
  await page.keyboard.press(' ');
  await expect(page.getByRole('menu', { name: 'Row actions' })).toBeVisible();
  await expect(page.locator('tbody tr').first().getByRole('checkbox')).not.toBeChecked();
  await page.keyboard.press('Escape');

  // The same guard holds on the other two books.
  for (const route of ['/billing/subscriptions', '/billing/invoices']) {
    await page.goto(route, { waitUntil: 'networkidle' });
    const rowMenu = page.locator('tbody tr').first().getByRole('button', { name: 'Row actions' });
    await rowMenu.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu', { name: 'Row actions' }), route).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${route}$`));
    await page.keyboard.press('Escape');
  }
});

test('a scheduled cancellation can be withdrawn from the screen that shows it', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=50');
  const sub = subs.data.find((row: { cancel_at_period_end: boolean; schedule: string | null }) => !row.cancel_at_period_end && !row.schedule);
  test.skip(!sub, 'no active subscription to cancel');

  await page.goto(`/billing/subscriptions/${sub.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Cancel…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel at period end' }).click();
  await expect.poll(async () => (await json(page, `/v1/subscriptions/${sub.id}`)).cancel_at_period_end).toBe(true);

  // The banner offers the way back, and the menu does too.
  const banner = page.locator('.ain-banner', { hasText: 'Scheduled to cancel' });
  await expect(banner).toBeVisible();
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: /Don’t cancel/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await banner.getByRole('button', { name: 'Keep it running' }).click();
  await expect(page.getByText('Cancellation withdrawn')).toBeVisible();
  await expect.poll(async () => (await json(page, `/v1/subscriptions/${sub.id}`)).cancel_at_period_end).toBe(false);
  await expect(banner).toBeHidden();
});

test('a canceled subscription offers nothing to change and no next invoice', async ({ page }) => {
  const account = await customerWithDecliningCard(page, `Ended Co ${Date.now().toString().slice(-6)}`);
  const sub = await (await page.request.post('/api/v1/subscriptions', {
    data: { customer: account.id, items: [{ price: 'price_nw_starter_monthly', quantity: 1 }], collection_method: 'send_invoice' },
  })).json();
  await page.request.post(`/api/v1/subscriptions/${sub.id}/cancel`, { data: {} });
  expect((await json(page, `/v1/subscriptions/${sub.id}`)).status).toBe('canceled');

  await page.goto(`/billing/subscriptions/${sub.id}`, { waitUntil: 'networkidle' });
  await expect(page.locator('.ain-page__title')).toContainText('Canceled');
  await expect(page.getByRole('button', { name: 'Change plan or quantity' })).toHaveCount(0);
  await expect(page.locator('.bl-headline__label', { hasText: /^Ended$/ })).toBeVisible();
  await expect(page.locator('.bl-headline__label', { hasText: 'Next invoice' })).toHaveCount(0);
  // The terms are a record, not settings.
  await expect(page.getByLabel('Collection', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Net terms', { exact: true })).toHaveCount(0);
  await removeAccount(page, account.id);
});

test('an immediate change says which invoice it raised and what paid it', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=50&expand=customer');
  const sub = subs.data.find((row: { items: { metered: boolean; quantity: number }[]; cancel_at_period_end: boolean; schedule: string | null }) =>
    !row.cancel_at_period_end && !row.schedule && row.items.some((item) => !item.metered && item.quantity > 1));
  test.skip(!sub, 'no active subscription carries a per-seat item');
  const seat = sub.items.find((item: { metered: boolean; quantity: number }) => !item.metered && item.quantity > 1);

  // Enough credit on the account that the immediate bill is paid from it.
  await page.request.post(`/api/v1/customers/${sub.customer}/balance_transactions`, {
    data: { amount: -500_000, description: 'Credit for the always-invoice test', type: 'adjustment' },
  });

  await page.goto(`/billing/subscriptions/${sub.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Change plan or quantity' }).click();
  const dialog = page.getByRole('dialog');
  const index = sub.items.indexOf(seat) + 1;
  const quantity = dialog.getByRole('spinbutton', { name: `Quantity for item ${index}` });
  await quantity.fill(String(seat.quantity + 2));
  await quantity.press('Tab');
  await dialog.getByLabel('Proration').selectOption('always_invoice');

  // The preview says the balance will be drawn before the bill exists.
  await expect(dialog.getByTestId('bl-balance-drawn')).toBeVisible();
  await expect(dialog).toContainText('Paid from the balance now');

  await dialog.getByRole('button', { name: /^Apply/ }).click();
  const toast = page.locator('.ain-toast', { hasText: 'Subscription changed' }).first();
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast).not.toContainText('waiting on the next invoice');

  // The sentence names the invoice the API actually raised, and the balance that paid it.
  const raised = (await json(page, `/v1/invoices?subscription=${sub.id}&limit=1`)).data[0];
  expect(raised.billing_reason).toBe('subscription_update');
  await expect(toast).toContainText(raised.number);
  await expect(toast).toContainText('account balance');
});

/**
 * A refund is a fact about the payment, not about the bill. The gateway records
 * what went back and leaves what was billed, what was collected, what is owed
 * and the status all standing — reopening a settled bill would chase the
 * customer for money somebody here chose to return. Only a chargeback, where
 * the network takes the cash, genuinely makes a bill owed again.
 */
test('a payment can be refunded from the invoice that collected it, and the settled bill stays settled', async ({ page }) => {
  const account = await (await page.request.post('/api/v1/customers', {
    data: { name: `Refund Me Co ${Date.now().toString().slice(-6)}`, currency: 'usd', invoice_settings: { days_until_due: 0 } },
  })).json();
  await page.request.post('/api/v1/payment_methods', {
    data: { customer: account.id, type: 'card', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, simulated_behavior: 'succeeds', set_default: true },
  });
  const sub = await (await page.request.post('/api/v1/subscriptions', {
    data: { customer: account.id, items: [{ price: 'price_nw_starter_monthly', quantity: 1 }], collection_method: 'charge_automatically' },
  })).json();
  const invoiceId = sub.latest_invoice.id;
  await expect.poll(async () => (await json(page, `/v1/invoices/${invoiceId}`)).status, { timeout: 15_000 }).toBe('paid');

  await page.goto(`/billing/invoices/${invoiceId}?tab=collection`, { waitUntil: 'networkidle' });
  // The method is named, not its id.
  await expect(page.locator('.bl-row', { hasText: 'Authorised' }).first()).toContainText('Visa ending 4242');
  await expect(page.locator('main')).not.toContainText(/\bpm_[A-Za-z0-9]+/);

  await page.locator('.bl-row', { hasText: 'Authorised' }).first().getByRole('button', { name: /^Refund the/ }).click();
  const dialog = page.getByRole('dialog', { name: /Refund a payment on/ });
  await expect(dialog).toBeVisible();
  // The dialog promises the operator an outcome before they act, so it has to
  // be the outcome they get: the bill stays paid and nobody is chased for it.
  await expect(dialog).toContainText('stays paid');
  await expect(dialog).not.toContainText('owed again');
  await expect(dialog).toContainText(/Nobody is chased for it/);
  await dialog.getByLabel('Amount to refund').fill('40');
  await dialog.getByRole('button', { name: /^Refund \$40\.00/ }).click();

  // The toast carries the gateway's own account of what the refund did.
  const toast = page.locator('.ain-toast', { hasText: 'refunded' }).first();
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(sub.latest_invoice.number);

  const refunds = await json(page, `/v1/refunds?invoice=${invoiceId}`);
  expect(refunds.data).toHaveLength(1);
  expect(refunds.data[0].amount).toBe(4000);
  await expect.poll(async () => (await json(page, `/v1/invoices/${invoiceId}`)).amount_refunded).toBe(4000);
  const settled = await json(page, `/v1/invoices/${invoiceId}`);
  expect(settled.status, 'a settled bill stays settled after a refund').toBe('paid');
  expect(settled.amount_due, 'and nothing is owed on it again').toBe(0);
  expect(settled.amount_paid, 'what was collected still stands').toBe(9900);
  await expect(page.locator('.ain-page__title')).toContainText('Paid');

  // Nobody is sent after the money the workspace chose to give back.
  const chased = await json(page, `/v1/dunning?invoice=${invoiceId}`);
  expect((chased.data ?? []).filter((row: { status: string }) => row.status === 'recovering'))
    .toHaveLength(0);

  // The register on the Payments screen lists both the charge and the refund.
  await page.goto(`/billing/payments?customer=${account.id}`, { waitUntil: 'networkidle' });
  await expect(page.locator('tbody tr', { hasText: account.name }).first()).toContainText('$99.00');
  await page.getByRole('tab', { name: 'Refunds' }).click();
  await expect(page.locator('tbody tr', { hasText: account.name }).first()).toContainText('$40.00');
  await removeAccount(page, account.id);
});

test('the Payments register lists every presentation with the issuer’s answer', async ({ page }) => {
  const intents = await json(page, '/v1/payment_intents?status=all&limit=1');
  await page.goto('/billing/payments', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible();
  await expect(page.locator('.ain-table__count')).toContainText(String(intents.total_count));

  // The declined filter is in the address bar, like every other list filter.
  await page.getByLabel('Status').selectOption('requires_payment_method');
  await expect(page).toHaveURL(/status=requires_payment_method/);
  const declined = await json(page, '/v1/payment_intents?status=requires_payment_method&limit=200');
  if (declined.data.length) {
    await expect(page.locator('tbody tr[data-index]')).toHaveCount(declined.data.length);
    await expect(page.locator('tbody tr').first()).toContainText('Declined');
    await expect(page.locator('tbody tr').first()).toContainText(declined.data[0].last_payment_error.message);
  } else {
    // An empty register says so — a real empty state, not a bare grid.
    await expect(page.getByText('No payment matches this filter')).toBeVisible();
  }
});

test('a draft invoice’s money button is closed, and says to finalise first', async ({ page }) => {
  const drafts = await json(page, '/v1/invoices?status=draft&limit=1');
  test.skip(!drafts.data.length, 'no draft is held in this workspace');
  await page.goto(`/billing/invoices/${drafts.data[0].id}`, { waitUntil: 'networkidle' });
  const pay = page.getByRole('button', { name: 'Take a payment' });
  await expect(pay).toBeDisabled();
  await expect(pay).toHaveAttribute('title', /Finalise it first/);
});

test('a bill raised by hand does not print a one-day service period', async ({ page }) => {
  // A bill swept up by hand carries no service window: the engine stamps both
  // ends on the day it was raised. The book usually holds one; when it does
  // not, there is nothing on screen to check.
  const book = await json(page, '/v1/invoices?status=all&limit=200');
  const raised = book.data.find((row: { billing_reason: string; period: { start: number; end: number } }) =>
    row.billing_reason === 'manual' && row.period.end - row.period.start <= 86_400_000);
  test.skip(!raised, 'no hand-raised invoice in this workspace');

  await page.goto(`/billing/invoices?customer=${raised.customer}`, { waitUntil: 'networkidle' });
  const row = page.locator('tbody tr', { hasText: raised.number });
  await expect(row).toContainText('One-off');
  await expect(row).not.toContainText(raised.period_display);

  await page.goto(`/billing/invoices/${raised.id}`, { waitUntil: 'networkidle' });
  await expect(page.locator('.bl-headline', { hasText: 'Total' })).toContainText('One-off');
});

/* ============================ guarded writes ============================== */

/**
 * A financial write from a list menu confirms before it runs.
 *
 * The record pages already price and confirm every cancellation and every bill
 * raised by hand. The list row menus and bulk bars used to skip that — one
 * click on "Cancel at period end" set the flag, one click on "Bill what is owed
 * now" raised an invoice — so the same action was safe on one screen and not
 * on the next. Each test below fires the list entry point and asks the API
 * whether anything moved before the dialog was confirmed.
 */

interface SubRow {
  id: string; customer: string; cancel_at_period_end: boolean; schedule: string | null; status: string;
  current_period_end: number; recurring_subtotal: number; interval: string; interval_count: number;
  customer_detail?: { name: string };
}

const searchList = async (page: Page, label: string, text: string) => {
  const box = page.getByLabel(label);
  await box.fill(text);
};

test('cancelling from the subscriptions list confirms first, and changes nothing until it is confirmed', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=100&expand=customer');
  const perAccount = new Map<string, number>();
  for (const row of subs.data as SubRow[]) perAccount.set(row.customer, (perAccount.get(row.customer) ?? 0) + 1);
  // An account with exactly one active subscription, so the row is unambiguous.
  const found = (subs.data as SubRow[]).find((row) => !row.cancel_at_period_end && !row.schedule && perAccount.get(row.customer) === 1);
  test.skip(!found, 'no active subscription to cancel');
  const sub = found as SubRow;
  const name = sub.customer_detail?.name ?? sub.customer;

  await page.goto('/billing/subscriptions?status=active', { waitUntil: 'networkidle' });
  // The search goes to the server, debounced; the grid is filtered in the
  // browser meanwhile, so the row count settles before the answer does. The
  // menu is opened only once the server's answer has re-rendered the grid,
  // or it is remounted under the click.
  const answered = page.waitForResponse((res) => res.url().includes('/v1/subscriptions') && res.url().includes('query='));
  await searchList(page, 'Search account, plan or id', name);
  await answered;
  await expect(page.locator('tbody tr[data-index]')).toHaveCount(1);
  await page.waitForLoadState('networkidle');
  const row = page.locator('tbody tr', { hasText: name }).first();
  await expect(row).toBeVisible();
  const openMenu = async () => {
    await row.hover();
    await row.getByRole('button', { name: 'Row actions' }).click();
    await expect(page.getByRole('menu', { name: 'Row actions' })).toBeVisible();
    await page.waitForTimeout(350);
  };
  await openMenu();
  await page.getByRole('menuitem', { name: /Cancel at period end/ }).click();

  // The dialog is the record page's own: it names when, asks why, and nothing
  // has moved yet.
  const dialog = page.getByRole('dialog', { name: /Cancel this subscription/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('When')).toBeVisible();
  expect((await json(page, `/v1/subscriptions/${sub.id}`)).cancel_at_period_end).toBe(false);
  await dialog.getByRole('button', { name: 'Keep it running' }).click();
  await expect(dialog).toBeHidden();
  expect((await json(page, `/v1/subscriptions/${sub.id}`)).cancel_at_period_end).toBe(false);

  // Confirmed, it does what the menu said.
  await openMenu();
  await page.getByRole('menuitem', { name: /Cancel at period end/ }).click();
  await dialog.getByRole('button', { name: 'Cancel at period end' }).click();
  await expect.poll(async () => (await json(page, `/v1/subscriptions/${sub.id}`)).cancel_at_period_end).toBe(true);
  await page.request.patch(`/api/v1/subscriptions/${sub.id}`, { data: { cancel_at_period_end: false } });
});

test('bulk cancel from the subscriptions list names each subscription and waits to be confirmed', async ({ page }) => {
  await page.goto('/billing/subscriptions?status=active', { waitUntil: 'networkidle' });
  const rows = page.locator('tbody tr[data-index]');
  await expect(rows.first()).toBeVisible();
  // Two rows that are not already set to end, so the count the dialog quotes
  // is the count the write would change.
  const picked: string[] = [];
  const count = await rows.count();
  for (let i = 0; i < count && picked.length < 2; i++) {
    const text = await rows.nth(i).innerText();
    if (/\bEnds\b/.test(text)) continue;
    await rows.nth(i).locator('input[type=checkbox]').check();
    picked.push(await rows.nth(i).locator('.bl-link').first().innerText());
  }
  test.skip(picked.length < 2, 'fewer than two subscriptions to cancel');
  const before = (await json(page, '/v1/subscriptions?status=active&limit=100')).data
    .filter((row: SubRow) => row.cancel_at_period_end).map((row: SubRow) => row.id) as string[];

  await page.getByRole('button', { name: /Cancel .*at period end/ }).click();
  const dialog = page.getByRole('dialog', { name: /Cancel 2 subscriptions/ });
  await expect(dialog).toBeVisible();
  for (const name of picked) await expect(dialog).toContainText(name);
  await expect(dialog.getByLabel('Reason')).toBeVisible();
  const during = (await json(page, '/v1/subscriptions?status=active&limit=100')).data.filter((row: SubRow) => row.cancel_at_period_end);
  expect(during.length).toBe(before.length);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const afterEscape = (await json(page, '/v1/subscriptions?status=active&limit=100')).data.filter((row: SubRow) => row.cancel_at_period_end);
  expect(afterEscape.length).toBe(before.length);

  // Confirmed, both are scheduled — and nothing else is.
  await page.getByRole('button', { name: /Cancel .*at period end/ }).click();
  await dialog.getByRole('button', { name: /^Cancel 2 at period end$/ }).click();
  await expect.poll(async () => (await json(page, '/v1/subscriptions?status=active&limit=100')).data
    .filter((row: SubRow) => row.cancel_at_period_end).length).toBe(before.length + 2);
  const scheduled = (await json(page, '/v1/subscriptions?status=active&limit=100')).data
    .filter((row: SubRow) => row.cancel_at_period_end && !before.includes(row.id));
  for (const row of scheduled) await page.request.patch(`/api/v1/subscriptions/${row.id}`, { data: { cancel_at_period_end: false } });
});

test('"Bill what is owed now" on a subscription shows what would be billed before raising anything', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=50');
  test.skip(!subs.data[0], 'no active subscription');
  const sub = subs.data[0] as SubRow;
  const before = (await json(page, `/v1/invoices?customer=${sub.customer}&status=all&limit=1`)).total_count;

  await page.goto(`/billing/subscriptions/${sub.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Bill what is owed now/ }).click();
  const dialog = page.getByRole('dialog', { name: /Bill what this account owes/ });
  await expect(dialog).toBeVisible();
  // Priced, or told there is nothing to price — never raised on the click.
  await expect(dialog.getByText(/Nothing is waiting on this account|before tax/)).toBeVisible();
  expect((await json(page, `/v1/invoices?customer=${sub.customer}&status=all&limit=1`)).total_count).toBe(before);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('billing an account from the customers list goes through the same priced dialog', async ({ page }) => {
  await page.goto('/billing/customers', { waitUntil: 'networkidle' });
  const row = page.locator('tbody tr[data-index]').first();
  await expect(row).toBeVisible();
  const name = await row.locator('.bl-link').first().innerText();
  const account = (await json(page, `/v1/customers?query=${encodeURIComponent(name)}&limit=1`)).data[0];
  const before = (await json(page, `/v1/invoices?customer=${account.id}&status=all&limit=1`)).total_count;

  await row.hover();
  await row.getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: /Bill what is owed now/ }).click();
  const dialog = page.getByRole('dialog', { name: /Bill what this account owes/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(name, { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Nothing is waiting on this account|before tax/)).toBeVisible();
  expect((await json(page, `/v1/invoices?customer=${account.id}&status=all&limit=1`)).total_count).toBe(before);
  await page.keyboard.press('Escape');
});

test('"Bill N accounts" previews every account before anything is raised', async ({ page }) => {
  await page.goto('/billing/customers', { waitUntil: 'networkidle' });
  const rows = page.locator('tbody tr[data-index]');
  await expect(rows.first()).toBeVisible();
  test.skip((await rows.count()) < 2, 'fewer than two accounts');
  const names = [await rows.nth(0).locator('.bl-link').first().innerText(), await rows.nth(1).locator('.bl-link').first().innerText()];
  await rows.nth(0).locator('input[type=checkbox]').check();
  await rows.nth(1).locator('input[type=checkbox]').check();
  const before = (await json(page, '/v1/invoices?status=all&limit=1')).total_count;

  await page.getByRole('button', { name: /^Bill 2 accounts/ }).click();
  const dialog = page.getByRole('dialog', { name: /Bill 2 accounts/ });
  await expect(dialog).toBeVisible();
  for (const name of names) {
    // Each account gets its own verdict: the lines it would be billed, or the
    // fact that nothing is waiting and it will be left alone.
    const line = dialog.locator('tr', { hasText: name });
    await expect(line).toBeVisible();
    await expect(line).toContainText(/Nothing waiting|line/);
  }
  expect((await json(page, '/v1/invoices?status=all&limit=1')).total_count).toBe(before);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('the one-off path under "Bill an account" says it adjusts the balance rather than claiming to charge', async ({ page }) => {
  const customers = await json(page, '/v1/customers?limit=12');
  let quiet: { id: string; name: string } | null = null;
  for (const row of customers.data) {
    const pending = await json(page, `/v1/customers/${row.id}/pending_items`);
    if (pending.data.length === 0) { quiet = row; break; }
  }
  test.skip(!quiet, 'every account has something waiting');

  await page.goto('/billing/invoices', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Bill an account' }).first().click();
  const dialog = page.getByRole('dialog', { name: /Bill what this account owes/ });
  await pickCustomer(page, dialog, quiet!.name);
  await expect(dialog.getByText('Nothing is waiting on this account')).toBeVisible();
  // A hand-written line has a route of its own now (`POST /v1/invoice_items`),
  // so the dialog offers both — what it may never do is call a balance debit a
  // charge.
  await expect(dialog).toContainText(/balance/);
  await expect(dialog.getByRole('button', { name: /Charge a one-off amount/ })).toHaveCount(0);
  // Both acts are on the dialog, each named for what it does: a line goes on a
  // document today, a balance adjustment raises none and is drawn down by the
  // next bill. Neither is called a charge.
  await expect(dialog.getByRole('button', { name: /Add a one-off line/ })).toBeVisible();
  await dialog.getByRole('button', { name: /Adjust the account balance instead/ }).click();
  const adjust = page.getByRole('dialog', { name: /Adjust the account balance/ });
  await expect(adjust).toBeVisible();
  await expect(adjust).not.toContainText(/Charge a one-off/);
});

/* ============================ what the figures say ========================= */

test('an invoice’s Total is what was billed, with the balance drawn shown as its own line', async ({ page }) => {
  const name = `Balance Draw Co ${Date.now().toString().slice(-6)}`;
  const account = await (await page.request.post('/api/v1/customers', {
    data: { name, currency: 'usd', invoice_settings: { days_until_due: 30 } },
  })).json();
  await page.request.post(`/api/v1/customers/${account.id}/balance_transactions`, {
    data: { amount: -5000, description: 'Goodwill credit before the first bill', type: 'adjustment' },
  });
  const sub = await (await page.request.post('/api/v1/subscriptions', {
    data: { customer: account.id, items: [{ price: 'price_nw_starter_monthly', quantity: 1 }], collection_method: 'send_invoice' },
  })).json();
  const invoiceId = sub.latest_invoice?.id;
  test.skip(!invoiceId, 'the first invoice was not raised');
  const invoice = await json(page, `/v1/invoices/${invoiceId}`);
  test.skip(invoice.balance_applied >= 0, 'the balance was not drawn on this bill');
  const billed = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((invoice.subtotal + invoice.tax) / 100);
  expect(billed).not.toBe(invoice.total_display);

  await page.goto(`/billing/invoices/${invoiceId}`, { waitUntil: 'networkidle' });
  const totalTile = page.locator('.bl-headline__item', { has: page.locator('.bl-headline__label', { hasText: /^Total$/ }) });
  await expect(totalTile.locator('.bl-headline__value')).toHaveText(billed);
  const totals = page.locator('.ain-card', { hasText: 'Account balance applied' });
  await expect(totals.locator('.bl-total', { hasText: /^Total/ }).locator('.bl-total__value')).toHaveText(billed);
  await expect(totals.locator('.bl-total', { hasText: 'Account balance applied' })).toContainText(invoice.balance_applied_display);
  await expect(totals.locator('.bl-total', { hasText: 'Amount due' })).toContainText(invoice.amount_due_display);

  await page.goto(`/billing/invoices?customer=${account.id}`, { waitUntil: 'networkidle' });
  await expect(page.locator('tbody tr', { hasText: invoice.number })).toContainText(billed);
  await removeAccount(page, account.id);
});

test('the bulk void dialog pairs every invoice with its own amount', async ({ page }) => {
  const open = await json(page, '/v1/invoices?status=open&limit=50');
  const rows = (await notBeingChased(page, open.data)).filter((row) => row.amount_due > 0);
  const first = rows[0];
  const second = rows.find((row) => row.amount_due_display !== rows[0]?.amount_due_display);
  test.skip(!first || !second, 'no two open invoices with different amounts');
  const pair = [first, second] as InvoiceRow[];

  await page.goto('/billing/invoices?status=open', { waitUntil: 'networkidle' });
  for (const invoice of pair) {
    await searchList(page, 'Search number, account or id', invoice.number);
    await page.locator('tbody tr', { hasText: invoice.number }).locator('input[type=checkbox]').check();
  }
  await searchList(page, 'Search number, account or id', '');
  await page.getByRole('button', { name: /^Void 2/ }).click();
  const dialog = page.getByRole('dialog', { name: /Void 2 invoices/ });
  await expect(dialog).toBeVisible();
  for (const invoice of pair) {
    const line = dialog.locator('tr', { hasText: invoice.number });
    await expect(line).toContainText(invoice.amount_due_display);
    await expect(line).toContainText(invoice.customer_name);
  }
  const before = (await json(page, `/v1/invoices/${pair[0].id}`)).status;
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect((await json(page, `/v1/invoices/${pair[0].id}`)).status).toBe(before);
});

test('an invoice’s menu offers only the actions its state allows', async ({ page }) => {
  const paid = (await json(page, '/v1/invoices?status=paid&limit=1')).data[0];
  test.skip(!paid, 'no paid invoice');
  await page.goto(`/billing/invoices/${paid.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'More invoice actions' }).click();
  await expect(page.getByRole('menuitem', { name: /Issue a credit note/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Finalise this draft/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /Void this invoice/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /Write it off/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const voided = (await json(page, '/v1/invoices?status=void&limit=1')).data[0];
  if (voided) {
    await page.goto(`/billing/invoices/${voided.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'More invoice actions' }).click();
    await expect(page.getByRole('menuitem', { name: /Open the printable document/ })).toBeVisible();
    for (const gone of [/Finalise this draft/, /Void this invoice/, /Write it off/, /Issue a credit note/, /Refund a payment/]) {
      await expect(page.getByRole('menuitem', { name: gone })).toHaveCount(0);
    }
    await page.keyboard.press('Escape');
  }

  // The list row menu keeps the same discipline: an open bill is not a draft.
  await page.goto('/billing/invoices?status=open', { waitUntil: 'networkidle' });
  const row = page.locator('tbody tr[data-index]').first();
  await row.hover();
  await row.getByRole('button', { name: 'Row actions' }).click();
  await expect(page.getByRole('menuitem', { name: /Void/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Finalise this draft/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('a yearly plan’s annual figure is the fee, not twelve rounded twelfths of it', async ({ page }) => {
  const subs = await json(page, '/v1/subscriptions?status=active_like&limit=100');
  const found = (subs.data as SubRow[]).find((row) => row.interval === 'year' && row.interval_count === 1 && row.recurring_subtotal % 12 !== 0 && row.status !== 'paused');
  test.skip(!found, 'no yearly subscription whose fee does not divide by twelve');
  const yearly = found as SubRow;
  const summary = await json(page, `/v1/customers/${yearly.customer}/summary`);
  test.skip(summary.subscriptions.live !== 1, 'the account has more than one live subscription');
  const annual = new Intl.NumberFormat('en-US', { style: 'currency', currency: summary.customer.currency.toUpperCase() }).format(yearly.recurring_subtotal / 100);

  await page.goto(`/billing/customers/${yearly.customer}`, { waitUntil: 'networkidle' });
  const tile = page.locator('.bl-headline__item', { has: page.locator('.bl-headline__label', { hasText: /^MRR$/ }) });
  await expect(tile.locator('.bl-headline__caption')).toContainText(`${annual} a year`);
});

test('lifetime value is captioned as what it is — collected — with the open bill as its own sentence', async ({ page }) => {
  // The seeded book has such an account within its first dozen names; reading
  // fifty summaries here is what tips a full run of this file into the rate
  // limiter, so the search stops at twelve.
  const customers = await json(page, '/v1/customers?limit=12');
  let target: { id: string } | null = null;
  for (const row of customers.data) {
    const summary = await json(page, `/v1/customers/${row.id}/summary`);
    if (summary.open_invoices.total > 0 && summary.lifetime_value.amount > 0) { target = row; break; }
  }
  test.skip(!target, 'no account with both collected money and an open bill');

  await page.goto(`/billing/customers/${target!.id}`, { waitUntil: 'networkidle' });
  const tile = page.locator('.bl-headline__item', { has: page.locator('.bl-headline__label', { hasText: /^Lifetime value$/ }) });
  const caption = tile.locator('.bl-headline__caption');
  await expect(caption).toContainText(/Collected/);
  await expect(caption).toContainText(/still owed/);
  await expect(caption).not.toContainText(/of it is still open/);
});

test('the payments register shows the whole method without truncating it', async ({ page }) => {
  const intents = await json(page, '/v1/payment_intents?limit=50');
  const withMethod = intents.data.find((row: { payment_method: string | null }) => row.payment_method);
  test.skip(!withMethod, 'no payment carries a method');

  await page.goto('/billing/payments', { waitUntil: 'networkidle' });
  const header = page.locator('thead th', { hasText: /^Method/ });
  await expect(header).toBeVisible();
  const index = await header.evaluate((th) => Array.from(th.parentElement!.children).indexOf(th));
  const cells = page.locator('tbody tr[data-index] td').filter({ hasText: /ending|No method|since removed/ });
  await expect(cells.first()).toBeVisible();
  const truncated = await page.locator('tbody tr[data-index]').evaluateAll((rows, i) => rows
    .map((row) => row.children[i] as HTMLElement)
    .filter((td) => td && td.scrollWidth > td.clientWidth + 1).length, index);
  expect(truncated).toBe(0);
});

test('bulk pause from the subscriptions list asks what happens to the invoices before it holds any', async ({ page }) => {
  await page.goto('/billing/subscriptions?status=active', { waitUntil: 'networkidle' });
  const rows = page.locator('tbody tr[data-index]');
  await expect(rows.first()).toBeVisible();
  test.skip((await rows.count()) < 2, 'fewer than two subscriptions');
  const names = [await rows.nth(0).locator('.bl-link').first().innerText(), await rows.nth(1).locator('.bl-link').first().innerText()];
  await rows.nth(0).locator('input[type=checkbox]').check();
  await rows.nth(1).locator('input[type=checkbox]').check();
  const paused = (await json(page, '/v1/subscriptions?status=paused&limit=100')).total_count;

  await page.getByRole('button', { name: /^Pause 2/ }).click();
  const dialog = page.getByRole('dialog', { name: /Pause collection on 2 subscriptions/ });
  await expect(dialog).toBeVisible();
  for (const name of names) await expect(dialog).toContainText(name);
  await expect(dialog.getByLabel('What happens to invoices raised while paused')).toBeVisible();
  expect((await json(page, '/v1/subscriptions?status=paused&limit=100')).total_count).toBe(paused);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect((await json(page, '/v1/subscriptions?status=paused&limit=100')).total_count).toBe(paused);
});

/* ===================== a change that is already booked ==================== */

interface PhaseFixture {
  subscription: string;
  customer: string;
  currency: string;
  periodEnd: number;
  /** What the new plan bills for one period, in the account's own currency. */
  perPeriod: string;
  /** Every line of the new plan, priced by the engine in that currency. */
  lines: { price: string; amount_display: string }[];
  /** The old plan's lines, which the booked period must no longer quote. */
  leaving: string[];
}

const SCALE = [
  { price: 'price_nw_scale_monthly', quantity: 1 },
  { price: 'price_nw_scale_seat_monthly', quantity: 12 },
  { price: 'price_nw_telemetry_events', quantity: 1 },
];

/**
 * A subscription that does not bill in dollars, with a plan change booked for
 * its very next renewal.
 *
 * Both defects this fixture exists for only show on an account whose currency
 * is not the price's own: the phase summary the server writes prices every
 * item in `price.currency`, and `currency_options` holds a different amount per
 * currency rather than a conversion of one.
 */
const bookedChange = async (page: Page): Promise<PhaseFixture | null> => {
  const subs = await json(page, '/v1/subscriptions?status=active&limit=200');
  const rows = subs.data as (SubRow & { currency: string; items: { price: string; description: string }[] })[];
  const monthly = rows.filter((row) => row.currency !== 'usd' && row.interval === 'month' && row.interval_count === 1);

  // One already booked, if a previous test in this file left one: the fixture
  // is a subscription whose *very next* period is governed by a phase, and
  // making a second one is only worth the write when none exists.
  for (const row of monthly.filter((candidate) => candidate.schedule)) {
    const schedule = await json(page, `/v1/subscription-schedules/${row.schedule}`);
    if (schedule.status !== 'active' && schedule.status !== 'not_started') continue;
    const phase = schedule.phases.find((entry: { state: string; start_date: number }) =>
      entry.state === 'upcoming' && entry.start_date === row.current_period_end);
    if (!phase) continue;
    const carried = new Set(phase.items.map((item: { price: string }) => item.price));
    const dropped = row.items.filter((item) => !carried.has(item.price));
    if (!dropped.length) continue;
    return {
      subscription: row.id,
      customer: row.customer,
      currency: row.currency,
      periodEnd: row.current_period_end,
      ...(await pricePhase(page, row.currency, phase.items)),
      leaving: dropped.map((item) => item.description),
    };
  }

  // Not one already on Scale — the phase has to name a different plan from the
  // one the period is leaving. The metered line is shared by both plans and is
  // not what makes them different, so it is not part of this test.
  const target = monthly.find((row) => !row.schedule && !row.items.some((item) => item.price === SCALE[0].price));
  if (!target) return null;

  const sub = await json(page, `/v1/subscriptions/${target.id}`);
  await post(page, '/v1/subscription-schedules', {
    from_subscription: sub.id,
    end_behavior: 'release',
    phases: [
      {
        items: sub.items.map((item: { price: string; quantity: number; metered: boolean }) => ({
          price: item.price, quantity: item.metered ? 1 : item.quantity,
        })),
        end_date: sub.current_period_end,
        proration_behavior: 'none',
        description: 'Stays on the current plan for the period now running.',
      },
      { items: SCALE, proration_behavior: 'create_prorations', description: 'Plant-wide rollout on Scale.' },
    ],
  });
  const carried = new Set(SCALE.map((line) => line.price));
  return {
    subscription: sub.id,
    customer: sub.customer,
    currency: sub.currency,
    periodEnd: sub.current_period_end,
    ...(await pricePhase(page, sub.currency, SCALE)),
    leaving: sub.items
      .filter((item: { price: string }) => !carried.has(item.price))
      .map((item: { description: string }) => item.description),
  };
};

/** What a phase's items come to, priced by the engine in the account's currency. */
const pricePhase = async (page: Page, currency: string, items: { price: string; quantity: number }[]) => {
  const priced = await post(page, '/v1/catalog/estimate', {
    currency,
    lines: items.map((item) => ({ price: item.price, quantity: item.quantity })),
  });
  return {
    perPeriod: priced.recurring.monthly_equivalent_display as string,
    lines: priced.lines as { price: string; amount_display: string }[],
  };
};

test('a booked change is quoted in the currency the subscription bills in', async ({ page }) => {
  await signIn(page);
  const fixture = await bookedChange(page);
  test.skip(!fixture, 'no non-dollar monthly subscription free to put under a schedule');
  const booked = fixture!;

  await page.goto(`/billing/subscriptions/${booked.subscription}`, { waitUntil: 'networkidle' });
  const banner = page.locator('.ain-banner', { hasText: 'A change is already booked' });
  await expect(banner).toBeVisible();
  // Every figure in the banner is the engine's answer for this account's
  // currency. The server's own phase summary prices each item in the price's
  // home currency, so it says $1,900.00 where the renewal charges €1,750.00.
  const metered = await meteredPrices(page);
  for (const line of booked.lines) {
    if (metered.has(line.price)) continue;
    await expect(banner).toContainText(line.amount_display);
  }
  await expect(banner.locator('.ain-banner__body')).not.toContainText('$');

  await page.goto(`/billing/subscriptions/${booked.subscription}?tab=schedule`, { waitUntil: 'networkidle' });
  const upcoming = page.locator('.bl-phase', { hasText: 'Upcoming' });
  await expect(upcoming).toBeVisible();
  await expect(upcoming.locator('.bl-phase__summary')).not.toContainText('$');
  for (const line of booked.lines) {
    if (metered.has(line.price)) continue;
    await expect(upcoming.locator('.bl-phase__summary')).toContainText(line.amount_display);
  }
});

test('the upcoming invoice quotes the plan the schedule books, not the one it replaces', async ({ page }) => {
  await signIn(page);
  const fixture = await bookedChange(page);
  test.skip(!fixture, 'no non-dollar monthly subscription free to put under a schedule');
  const booked = fixture!;

  await page.goto(`/billing/subscriptions/${booked.subscription}?tab=upcoming`, { waitUntil: 'networkidle' });
  const card = page.locator('.ain-card', { hasText: 'Upcoming invoice' });
  await expect(card).toBeVisible();
  // The period this preview covers is the first the booked phase governs, so
  // the plan being left must not be quoted for it.
  await expect(card.locator('.ain-banner', { hasText: 'Priced on the change booked' })).toBeVisible();
  const metered = await meteredPrices(page);
  for (const line of booked.lines) {
    if (metered.has(line.price)) continue;
    await expect(card.locator('table')).toContainText(line.amount_display);
  }
  await expect(card.locator('table')).not.toContainText(booked.leaving[0]);

  // The endpoint itself now knows about the schedule, so asking it plainly —
  // the way the copilot's billing_upcoming_invoice tool and any other consumer
  // does — answers about the phase that will bill rather than the plan being
  // left. This assertion used to read `not.toHaveText`, because the screen was
  // compensating for a server that quoted the wrong plan; the two agreeing is
  // the fix, and the screen having to differ from the API was the defect.
  const preview = await post(page, '/v1/invoices/create_preview', { subscription: booked.subscription });
  const total = card.locator('.bl-total--grand').last().locator('.bl-total__value');
  await expect(total).toHaveText(preview.amount_due_display);
  const quoted = (await total.innerText()).trim();
  // And it is genuinely the booked plan being quoted, not the one it replaces.
  expect(preview.lines.some((line: { description: string }) => booked.leaving.includes(line.description))).toBe(false);

  // And the account header, which reads the same bill through the customer
  // summary — a figure the summary builds from today's items. The two screens
  // now agree, because both are priced on the phase that will bill.
  await page.goto(`/billing/customers/${booked.customer}`, { waitUntil: 'networkidle' });
  const tile = page.locator('.bl-headline__item', { has: page.locator('.bl-headline__label', { hasText: /^Next invoice$/ }) });
  await expect(tile.locator('.bl-headline__caption')).toContainText(quoted);
});

/* ===================== what a credit note says it did ===================== */

test('a credit note does not claim nothing was collected on a bill that was part collected', async ({ page }) => {
  await signIn(page);
  const invoices = await json(page, '/v1/invoices?status=open&limit=200');
  const open = (invoices.data as InvoiceRow[]).filter((row) => row.amount_due > 4_000);
  // A bill that has taken money and is still owed the rest — the one state the
  // server's routing sentence gets wrong, because it only asks whether the
  // bill is paid in full.
  let bill = open.find((row) => row.amount_paid > 0) ?? null;
  for (const candidate of open) {
    if (bill) break;
    const methods = await json(page, `/v1/payment_methods?customer=${candidate.customer}&limit=10`);
    if (!methods.data.length) continue;
    // This workspace seeds cards that refuse, because the recovery story needs
    // them. A refused charge collects nothing, so the fixture is only built
    // once the money has actually moved — asserting on an unbuilt fixture
    // reports the product broken for the test's own failure to set up.
    const intent = await post(page, '/v1/payment_intents', {
      customer: candidate.customer,
      invoice: candidate.id,
      amount: Math.floor(candidate.amount_due / 3),
      payment_method: methods.data[0].id,
      confirm: true,
      off_session: false,
    });
    if (intent.status !== 'succeeded') continue;
    bill = candidate;
  }
  test.skip(!bill, 'no open invoice could be part collected');
  const after = await json(page, `/v1/invoices/${bill!.id}`);
  expect(after.amount_paid).toBeGreaterThan(0);
  expect(after.status).toBe('open');

  await page.goto(`/billing/invoices/${bill!.id}?tab=credits`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Issue a credit note' }).first().click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`Credit ${after.number}`) });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Amount to credit').fill(String(Math.floor(after.amount_due / 400)));

  const routing = dialog.locator('.ain-banner').last();
  await expect(routing).toBeVisible();
  // The money is on the record beside this sentence; the sentence may not deny it.
  await expect(routing).not.toContainText('nothing had been collected');
  await expect(routing).toContainText(after.amount_paid_display ?? String(after.amount_paid));
  await page.keyboard.press('Escape');
});

/* ============================== the price book ============================ */

test('the price book is a screen, and it prices in every currency it sells in', async ({ page }) => {
  await signIn(page);
  const products = await json(page, '/v1/products?limit=200&active=true');
  expect(products.data.length).toBeGreaterThan(0);

  await page.goto('/catalog/products', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Price book' })).toBeVisible();
  const rows = page.locator('tbody tr[data-index]');
  await expect(rows.first()).toBeVisible();

  // A product with more than one price, so the record has something to show.
  const withPrices = await json(page, '/v1/products?limit=200&expand=prices&active=true');
  const product = withPrices.data.find((row: { prices: unknown[] }) => row.prices.length > 1) ?? withPrices.data[0];
  await page.goto(`/catalog/products/${product.id}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: product.name })).toBeVisible();
  const priced = product.prices[0];
  await expect(page.locator('.bl-row', { hasText: priced.display.headline }).first()).toBeVisible();

  // The calculator is the invoice engine, asked again per currency — never a
  // conversion of the home amount.
  await page.getByRole('button', { name: 'What would a quantity cost?' }).first().click();
  const other = priced.currencies.find((code: string) => code !== priced.currency);
  test.skip(!other, 'this price is sold in one currency only');
  await page.getByLabel(`Currency for ${priced.nickname ?? priced.product_name}`).selectOption(other);
  const answer = await post(page, `/v1/prices/${priced.id}/preview`, { quantity: 1, currency: other });
  await expect(page.locator('.bl-phasepreview__total').first()).toHaveText(answer.amount_display);
});

test('a price-book hit in global search opens the product', async ({ page }) => {
  await signIn(page);
  const products = await json(page, '/v1/products?limit=5&active=true');
  const product = products.data[0];
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.keyboard.press('/');
  const search = page.getByRole('combobox', { name: /Search/ }).or(page.locator('input[type=search]')).first();
  await search.fill(product.name.split(' ').slice(-1)[0]);
  const hit = page.getByRole('option', { name: new RegExp(product.name, 'i') }).first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/catalog/products/${product.id}$`));
});

test('a product and its first price can be written from the price book, in every currency the book sells in', async ({ page }) => {
  await signIn(page);
  const currencies = await json(page, '/v1/catalog/currencies');
  const home = (currencies.data as { code: string; default: boolean }[]).find((row) => row.default)!;
  const other = (currencies.data as { code: string; default: boolean }[]).find((row) => !row.default);
  const name = `Line Health Monitor ${Date.now()}`;

  await page.goto('/catalog/products', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New product' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New product' });
  await dialog.getByLabel('Product name').fill(name);
  await dialog.getByLabel('Unit').fill('line');
  await dialog.getByLabel(`Amount in ${home.code.toUpperCase()}`).fill('45.00');
  if (other) await dialog.getByLabel(`Amount in ${other.code.toUpperCase()}`).fill('40.00');
  await dialog.getByRole('button', { name: /Create the product/ }).click();

  // The screen lands on the record it just wrote, and the workspace agrees.
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const written = (await json(page, `/v1/products?query=${encodeURIComponent(name)}&limit=5&expand=prices`)).data[0];
  expect(written.name).toBe(name);
  expect(written.unit_label).toBe('line');
  const price = written.prices[0];
  expect(price.unit_amount).toBe(4500);
  expect(written.default_price).toBe(price.id);
  // A per-currency amount is its own figure on the price, not a conversion —
  // and without one the price cannot go on an account that bills in it.
  if (other) expect(price.currency_options[other.code].unit_amount).toBe(4000);

  // Archiving is how a product is withdrawn: the prices it has already billed
  // still have to explain themselves.
  await page.getByRole('button', { name: 'More product actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive it' }).click();
  await expect.poll(async () => (await json(page, `/v1/products/${written.id}`)).active).toBe(false);
  await expect(page.getByText('This product is archived')).toBeVisible();
});

/* ============================ discounts on screen ========================= */

test('the discounts screen shows every coupon, what it takes off, and who redeemed it', async ({ page }) => {
  await signIn(page);
  // What is redeemable today, which is what the screen opens on — an archived
  // campaign is behind the standing filter.
  const coupons = await json(page, '/v1/coupons?limit=200&active=true');
  expect(coupons.data.length).toBeGreaterThan(0);

  await page.goto('/catalog/coupons', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Discounts' })).toBeVisible();
  const rows = page.locator('tbody tr[data-index]');
  await expect(rows.first()).toBeVisible();
  // The catalogue writes what a coupon is worth, in the workspace's locale.
  // The screen prints that sentence rather than arriving at one of its own.
  const first = coupons.data[0];
  await expect(page.locator('tbody').getByText(first.summary, { exact: true }).first()).toBeVisible();

  // A coupon somebody has actually taken up, so the redemptions have rows.
  const redeemed = coupons.data.find((row: { times_redeemed: number }) => row.times_redeemed > 0);
  test.skip(!redeemed, 'no coupon in this workspace has been redeemed');
  const takeUp = await json(page, `/v1/coupons/${redeemed.id}/redemptions?limit=50`);
  const withCustomer = takeUp.data.find((row: { customer: string | null }) => row.customer);
  const customer = withCustomer ? await json(page, `/v1/customers/${withCustomer.customer}`) : null;

  await page.goto(`/catalog/coupons/${redeemed.id}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: redeemed.name })).toBeVisible();
  // "By whom" means the account's name, not the id every other screen resolves.
  if (customer) await expect(page.locator('.bl-row').getByText(customer.name, { exact: true }).first()).toBeVisible();
  // Terms freeze on first redemption, and the screen says so rather than
  // offering an edit the catalogue will refuse.
  await expect(page.getByText('Its terms are frozen')).toBeVisible();

  const codes = await json(page, `/v1/promotion_codes?coupon=${redeemed.id}&limit=50`);
  for (const code of codes.data) {
    await expect(page.getByText(code.code, { exact: true }).first()).toBeVisible();
  }
});

test('a coupon can be created and archived from the discounts screen', async ({ page }) => {
  await signIn(page);
  const name = `Trade show — 15% off ${Date.now()}`;

  await page.goto('/catalog/coupons', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New coupon' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New coupon' });
  await dialog.getByLabel('Coupon name').fill(name);
  await dialog.getByLabel('Percentage off').fill('15');
  await dialog.getByLabel('For how long').selectOption('repeating');
  await dialog.getByLabel('Billing periods').fill('6');
  await dialog.getByLabel('Redemption ceiling').fill('25');
  await dialog.getByRole('button', { name: 'Create the coupon' }).click();

  // It lands on the record it wrote, and the workspace agrees with every term.
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const written = (await json(page, `/v1/coupons?query=${encodeURIComponent('15%')}&limit=50`))
    .data.find((row: { name: string }) => row.name === name);
  expect(written).toBeTruthy();
  // 15% is 1500 hundredths of a percent — the figure the arithmetic reads,
  // never a float the catalogue would have to round.
  expect(written.percent_off_basis_points).toBe(1500);
  expect(written.amount_off).toBe(null);
  expect(written.currency).toBe(null);
  expect(written.duration).toBe('repeating');
  expect(written.duration_in_periods).toBe(6);
  expect(written.max_redemptions).toBe(25);
  expect(written.active).toBe(true);
  await expect(page.getByText('25 of 25 left')).toBeVisible();

  // A code is the customer-facing half, and it carries its own restrictions.
  await page.getByRole('button', { name: 'Add a code' }).first().click();
  const codeDialog = page.getByRole('dialog', { name: new RegExp('Add a code to') });
  const code = `SHOW${Date.now()}`.slice(0, 20);
  await codeDialog.getByLabel('Code', { exact: true }).fill(code);
  await codeDialog.getByLabel('Per account').fill('1');
  await codeDialog.getByRole('button', { name: 'Create the code' }).click();
  await expect(page.getByText(code, { exact: true }).first()).toBeVisible();
  const codes = await json(page, `/v1/promotion_codes?coupon=${written.id}&limit=10`);
  expect(codes.data[0].code).toBe(code.toUpperCase());
  expect(codes.data[0].max_redemptions_per_customer).toBe(1);

  // Archiving is how a campaign is withdrawn: the invoices it cut have to keep
  // explaining themselves, so nothing is deleted.
  await page.getByRole('button', { name: 'More coupon actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive it' }).click();
  await expect.poll(async () => (await json(page, `/v1/coupons/${written.id}`)).active).toBe(false);
  await expect(page.getByText('This coupon cannot be redeemed')).toBeVisible();
});

/* ========================= the next-invoice estimate ====================== */

/**
 * The panel prints an estimate the summary computes from six figures. It used
 * to render three of them, so on a usage-priced account the rows above the
 * total came to a fraction of it and nothing on screen said why.
 */
test('the next-invoice panel’s rows add up to the estimate it prints', async ({ page }) => {
  await signIn(page);
  const customers = await json(page, '/v1/customers?limit=60');
  let account: { id: string; name: string } | null = null;
  let next: Record<string, number> | null = null;
  for (const row of customers.data as { id: string; name: string }[]) {
    const summary = await json(page, `/v1/customers/${row.id}/summary`);
    const estimate = summary.next_invoice;
    if (!estimate) continue;
    if (estimate.settled_usage_total === 0 && estimate.discount_total === 0 && estimate.tax === 0) continue;
    // A booked schedule phase is quoted from the corrected preview instead, in
    // a different card; this is about the summary's own panel.
    if (summary.subscriptions.data.some((sub: { id: string; schedule: string | null }) =>
      sub.id === estimate.subscription && sub.schedule)) continue;
    account = row;
    next = estimate;
    break;
  }
  test.skip(!account || !next, 'no account carries usage, a discount or tax on its next bill');

  await page.goto(`/billing/customers/${account!.id}`, { waitUntil: 'networkidle' });
  const card = page.locator('.ain-card').filter({ hasText: 'Estimated total' }).first();
  await expect(card).toBeVisible();

  const money = (text: string): number => Math.round(Number(text.replace(/[^0-9.-]/g, '')) * 100);
  const values = await card.locator('.bl-total:not(.bl-total--grand) .bl-total__value').allTextContents();
  const grand = await card.locator('.bl-total--grand .bl-total__value').innerText();
  expect(values.length).toBeGreaterThan(0);
  // Every term on screen, summed the way the server sums them to reach the
  // figure printed under them.
  expect(values.reduce((total, text) => total + money(text), 0)).toBe(money(grand));
  expect(money(grand)).toBe(next!.estimated_total);

  if (next!.settled_usage_total !== 0) {
    const usage = card.locator('.bl-total', { hasText: 'Metered usage already settled' });
    await expect(usage).toBeVisible();
    expect(money(await usage.locator('.bl-total__value').innerText())).toBe(next!.settled_usage_total);
  }
  // And the note under it says what the figure was priced on.
  await expect(card.locator('.bl-total__note')).toContainText('Priced on');
});

/* ========================= accepting an invitation ======================== */

test('an invitation is accepted by typing the Ain password once', async ({ page }) => {
  await signIn(page);
  const email = `joiner.${Date.now()}@northwind.io`;
  const seat = await post(page, '/v1/users', { email, name: 'Wave Three Joiner', role: 'member' });
  expect(seat.status).toBe('invited');

  await page.goto(`/accept?token=${seat.invitation.token}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();

  // Acceptance verifies an existing Ain credential and only enrols a new one,
  // so the field asks for the password the person has rather than one chosen
  // here — and typing it a second time is offered, never demanded. The field
  // is reached by its type rather than its label, so the gate below is tested
  // as behaviour rather than as wording.
  await page.locator('input[type=password]').first().fill('joins-once-1234');
  const join = page.getByRole('button', { name: /Join / });
  await expect(join).toBeEnabled();
  await expect(page.getByText('Your Ain password', { exact: true })).toBeVisible();
  await join.click();

  // The route hands back a live session, so the person lands inside.
  await page.waitForSelector('.ain-stat');
  await expect.poll(async () => {
    const users = await json(page, '/v1/users');
    return users.data.find((row: { email: string }) => row.email === email)?.status;
  }).toBe('active');
});
