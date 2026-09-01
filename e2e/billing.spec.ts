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

const signIn = async (page: Page) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const demo = page.getByRole('button', { name: 'Use the demo workspace' });
  if (await demo.count()) await demo.click();
  await page.waitForSelector('.ain-stat');
};

/**
 * A read, retried once past a rate limit.
 *
 * The suite makes a few hundred API reads in one session and the platform's
 * limiter answers 429 to the tail of them. A 429 is the right answer; a test
 * that reads `undefined.data` off one is a flake, not a finding.
 */
const json = async (page: Page, path: string): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let attempt = 0; ; attempt++) {
    const res = await page.request.get(`/api${path}`);
    if (res.ok() || attempt === 3) return res.json();
    await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
  }
};

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
  await expect(page.locator('[role=option]').first()).toBeVisible();
  await page.keyboard.press('Enter');
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
  const invoices = await json(page, '/v1/invoices?status=all&limit=20');
  const target = invoices.data[0];
  await page.goto('/billing/invoices', { waitUntil: 'networkidle' });

  await page.locator('.bl-acctfilter input.ain-combo__input').click();
  await page.locator('.bl-acctfilter input.ain-combo__input').fill(target.customer_name);
  await page.locator('.ain-combo__option', { hasText: target.customer_name }).first().click();

  await expect(page).toHaveURL(new RegExp(`customer=${target.customer}`));
  const rows = page.locator('tbody tr');
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
  const invoice = open.data.find((row: { due_date: number | null }) => row.due_date) ?? open.data[0];
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
  const queue = await json(page, '/v1/dunning?status=all&limit=10');
  test.skip(!queue.data.length, 'no recovery campaign exists');

  await page.goto(`/billing/invoices/${queue.data[0].invoice}?tab=collection`, { waitUntil: 'networkidle' });
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
  // row says it in the server's own words while the note stands.
  await expect(row).toContainText(note.routing_detail.slice(0, 30));

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
  await expect(page.locator('.bl-phase__summary', { hasText: schedule.phases[1].summary })).toBeVisible();
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
    await expect(page.locator('.ain-banner__body')).toContainText(upcoming.summary);
  }

  // The phases carry the server's own windows, not dates this screen computed.
  await page.getByRole('tab', { name: 'Schedule' }).click();
  for (const phase of schedule.phases) {
    await expect(page.locator('.bl-phase__desc', { hasText: phase.window })).toBeVisible();
  }
});

/* ================================== tax =================================== */

test('a tax rate can be registered and retired, and the invoice it taxed is untouched', async ({ page }) => {
  const jurisdiction = `Playwright County ${Date.now()}`;
  await page.goto('/billing/taxes', { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'Register a rate' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('What appears on the invoice').fill('PW sales tax');
  await dialog.getByLabel('Jurisdiction').fill(jurisdiction);
  await dialog.getByLabel('Country', { exact: true }).fill('US');
  await dialog.getByLabel('State or region').fill(jurisdiction);
  await dialog.getByLabel('Kind').selectOption('sales_tax');
  await dialog.getByLabel('Percentage').fill('7.125');
  await dialog.getByRole('button', { name: 'Register it' }).click();
  await expect(page.getByText('PW sales tax registered')).toBeVisible();

  const rates = await json(page, '/v1/tax_rates?limit=500');
  const rate = rates.data.find((row: { jurisdiction: string }) => row.jurisdiction === jurisdiction);
  expect(rate, 'the rate reached the server').toBeTruthy();
  // The percentage is stored exactly as typed — a float would have rounded it.
  expect(rate.percentage).toBe('7.125');
  expect(rate.active).toBe(true);

  const row = page.locator('tbody tr', { hasText: jurisdiction }).first();
  await expect(row).toContainText('7.125%');
  await row.getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: /Retire this rate/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Retire it' }).click();

  await expect(page.getByText('PW sales tax retired')).toBeVisible();
  await expect.poll(async () => (await json(page, `/v1/tax_rates/${rate.id}`)).active).toBe(false);
});

test('a refused registration is explained under the field the server named', async ({ page }) => {
  await page.goto('/billing/taxes', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Register a rate' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('What appears on the invoice').fill('VAT');
  await dialog.getByLabel('Jurisdiction').fill('Germany');
  // Germany already carries an active rate, and one address may never match two.
  await dialog.getByLabel('Country', { exact: true }).fill('DE');
  await dialog.getByLabel('Percentage').fill('19');
  await dialog.getByRole('button', { name: 'Register it' }).click();

  await expect(dialog.getByText(/already/i).first()).toBeVisible();
  await expect(dialog).toBeVisible();
});

test('the hold on bills with no tax location can be turned on and off', async ({ page }) => {
  const before = await json(page, '/v1/billing/automatic_tax');
  await page.goto('/billing/taxes', { waitUntil: 'networkidle' });

  const toggle = page.getByRole('switch', { name: /Hold them as drafts|Hold bills with no tax location/ });
  await expect(toggle).toHaveAttribute('aria-checked', String(before.enabled));
  await toggle.click();
  await expect.poll(async () => (await json(page, '/v1/billing/automatic_tax')).enabled).toBe(!before.enabled);

  await toggle.click();
  await expect.poll(async () => (await json(page, '/v1/billing/automatic_tax')).enabled).toBe(before.enabled);
});

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

test('the new screens are operable from the keyboard alone', async ({ page }) => {
  await page.goto('/billing/taxes', { waitUntil: 'networkidle' });

  // Tab to the primary action rather than clicking it, and open it with Enter.
  const register = page.getByRole('button', { name: 'Register a rate' });
  await register.focus();
  await expect(register).toBeFocused();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Focus is inside the dialog, not left behind on the page under it.
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(register).toBeFocused();

  // The status filter is a native select, so it is a keyboard control for free.
  const filter = page.getByLabel('Which registrations');
  await filter.focus();
  await filter.selectOption('all');
  await expect.poll(async () => page.locator('tbody tr[data-index]').count()).toBeGreaterThan(0);

  // And the hold is a real switch: focusable, and toggled with the space bar.
  const toggle = page.getByRole('switch', { name: /Hold them as drafts|Hold bills with no tax location/ });
  const before = await toggle.getAttribute('aria-checked');
  await toggle.focus();
  await page.keyboard.press(' ');
  await expect.poll(async () => toggle.getAttribute('aria-checked')).not.toBe(before);
  await page.keyboard.press(' ');
  await expect.poll(async () => toggle.getAttribute('aria-checked')).toBe(before);
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
  await page.getByRole('button', { name: 'New customer' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Create customer' })).toBeDisabled();

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();       // it neither submitted nor closed
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
test('a one-off amount can be charged to an account from the invoice screen', async ({ page }) => {
  const customers = await json(page, '/v1/customers?limit=25');
  const account = customers.data.find((row: { balance: number }) => row.balance === 0) ?? customers.data[0];
  const before = account.balance;

  await page.goto('/billing/invoices', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Bill an account' }).click();
  const dialog = page.getByRole('dialog');
  await pickCustomer(page, dialog, account.name);

  await dialog.getByRole('button', { name: /one-off amount/ }).click();
  const charge = page.getByRole('dialog', { name: 'Charge a one-off amount' });
  await expect(charge).toBeVisible();
  await expect(charge).toContainText('next invoice');

  await charge.getByLabel('Amount').fill('250');
  await charge.getByLabel('Why').fill('Onboarding and commissioning, 2 days on site');
  await charge.getByRole('button', { name: /^Charge / }).click();

  await expect.poll(async () => (await json(page, `/v1/customers/${account.id}`)).balance)
    .toBe(before + 25_000);

  // It is on the account's ledger, in the words the balance tile uses.
  await page.goto(`/billing/customers/${account.id}?tab=ledger`, { waitUntil: 'networkidle' });
  const row = page.locator('tbody tr', { hasText: 'Onboarding and commissioning' });
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
    await route.continue();
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
  const open = await json(page, '/v1/invoices?status=open&limit=20');
  const candidates = (await notBeingChased(page, open.data)).filter((row) => row.amount_due >= 200);
  const invoice = candidates[0];
  test.skip(!invoice, 'nothing large enough is owed in this workspace');

  // A presentation needs something to present against. Attaching one is a
  // first-class flow on this dialog, so the test drives it the same way.
  await page.goto(`/billing/invoices/${invoice.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Take a payment' }).click();
  const dialog = page.getByRole('dialog', { name: /Take a payment on/ });
  await expect(dialog).toBeVisible();

  if (await dialog.getByLabel('How it was taken').locator('option').count() <= 1) {
    await dialog.getByRole('button', { name: /Attach a card or bank account/ }).click();
    const attach = page.getByRole('dialog', { name: /payment method/i });
    await attach.getByRole('button', { name: /^Attach/ }).click();
    await expect(attach).toBeHidden();
  }

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

  // And the screen says so rather than calling a part payment a settlement.
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.bl-headline', { hasText: 'Collected' })).toContainText('Part paid');
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
