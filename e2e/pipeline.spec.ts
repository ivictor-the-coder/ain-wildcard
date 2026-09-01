/**
 * The deal board and the copilot, driven in a real browser.
 *
 * Every test here is an operability claim: a person sitting in front of the
 * screen can do the thing with the mouse and the keyboard, and the server
 * agrees afterwards. So each one that writes finishes by asking the API what
 * happened — a board that animates a card into a new column over a PATCH that
 * never landed is exactly the failure this file exists to rule out.
 *
 *   node scripts/preview.mjs --port 8854 --name pipeline --fresh
 *   AIN_BASE_URL=http://127.0.0.1:8854 npx playwright test e2e/pipeline.spec.ts
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

interface DealRecord {
  id: string;
  display_name: string;
  owner_id: string | null;
  properties: Record<string, unknown>;
}
interface DealList { data: DealRecord[]; total_count: number }
interface StageDef { name: string; label: string; probability: number; is_closed: boolean; is_won: boolean }
interface PipelineDef { name: string; label: string; is_default: boolean; stages: StageDef[] }

/**
 * Both jars have to hold a session: the browser context drives the screens, and
 * the `request` fixture is a separate context that every assertion below asks
 * the server with.
 */
const signIn = async (page: Page, request: APIRequestContext) => {
  await request.post('/api/v1/auth/demo');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.request.post('/api/v1/auth/demo');
};

const board = async (page: Page, query = '') => {
  await page.goto(`/deals${query}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.pl-col');
};

const pipelines = async (request: APIRequestContext): Promise<PipelineDef[]> =>
  ((await (await request.get('/api/v1/pipelines/deal')).json()) as { data: PipelineDef[] }).data;

const deal = async (request: APIRequestContext, id: string): Promise<DealRecord> =>
  (await (await request.get(`/api/v1/records/deal/${id}`)).json()) as DealRecord;

const findDeal = async (request: APIRequestContext, name: string): Promise<DealRecord | undefined> => {
  const list = (await (await request.get(`/api/v1/records/deal?q=${encodeURIComponent(name)}&limit=5`)).json()) as DealList;
  return list.data.find((row) => row.display_name === name);
};

/** A card sitting in a named column of the board. */
const cardsIn = (page: Page, stage: string) => page.locator(`.pl-col[data-stage="${stage}"] .pl-card`);

/**
 * An open stage that has a card on the board right now.
 *
 * Which column the seed fills is not this suite's business, and it is not
 * fixed: the demo data is laid out relative to the workspace's clock, so the
 * first stage holds two deals one hour and one the next. A test that moves a
 * deal needs a deal to move, wherever it happens to be sitting.
 */
const stageWithACard = async (page: Page, stages: StageDef[]): Promise<StageDef> => {
  for (const stage of stages) {
    if (await cardsIn(page, stage.name).count() > 0) return stage;
  }
  throw new Error(`no open stage has a card (looked at ${stages.map((s) => s.name).join(', ')})`);
};

/**
 * A real HTML5 drag, dispatched in the page.
 *
 * Playwright's mouse API cannot start a native drag — Chromium only begins one
 * for trusted input — so the browser's own DragEvent and DataTransfer are used
 * instead. The handlers under test are exactly the ones a person's mouse hits.
 */
const dragCardTo = async (page: Page, dealId: string, stage: string) => {
  await page.evaluate(({ dealId: id, stage: target }) => {
    const card = document.querySelector(`.pl-card[data-deal="${id}"]`);
    const column = document.querySelector(`.pl-col[data-stage="${target}"] .pl-col__body`);
    if (!card || !column) throw new Error(`no card ${id} or column ${target}`);
    const dataTransfer = new DataTransfer();
    const fire = (node: Element, type: string) =>
      node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    fire(card, 'dragstart');
    fire(column, 'dragover');
    fire(column, 'drop');
    fire(card, 'dragend');
  }, { dealId, stage });
};

test.beforeEach(async ({ page, request }) => { await signIn(page, request); });

/* ================================= board ================================== */

test('the board is built from the workspace’s own pipeline, and every figure is formatted', async ({ page, request }) => {
  await board(page);
  const [defaultPipeline] = (await pipelines(request)).filter((p) => p.is_default);

  // One column per open stage, labelled and ordered by the pipeline itself.
  for (const stage of defaultPipeline.stages.filter((s) => !s.is_closed)) {
    const column = page.locator(`.pl-col[data-stage="${stage.name}"]`);
    await expect(column).toBeVisible();
    await expect(column.locator('.pl-col__name')).toHaveText(stage.label);
    await expect(column.getByText(`${stage.probability}%`, { exact: true })).toBeVisible();
  }

  // Money is never raw minor units: a $729,000 deal must not read 72900000.
  const amount = page.locator('.pl-col__amount').first();
  await expect(amount).toHaveText(/^[$€£][\d,]+\.\d{2}$/);
  await expect(page.locator('.pl-card__amount').first()).toHaveText(/^[$€£][\d,]+\.\d{2}$/);

  // The weighted forecast the server computed is what the header quotes.
  await expect(page.locator('.pl-col__weighted').first()).toContainText('weighted');
});

test('the stat row quotes the pipeline totals the server computed', async ({ page, request }) => {
  await board(page);
  const [defaultPipeline] = (await pipelines(request)).filter((p) => p.is_default);
  const summary = (await (await request.get('/api/v1/pipelines/deal')).json()) as {
    data: (PipelineDef & { open_amount: number; weighted_amount: number })[];
  };
  const row = summary.data.find((p) => p.name === defaultPipeline.name)!;
  const money = (minor: number) => (minor / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  await expect(page.locator('.pl-summary')).toContainText(money(row.open_amount));
  await expect(page.locator('.pl-summary')).toContainText(money(row.weighted_amount));
});

test('switching to the table view keeps the same deals and totals them', async ({ page }) => {
  await board(page);
  await page.getByRole('radio', { name: 'Table' }).click();
  await page.waitForSelector('table tbody tr[data-index]');
  await expect(page).toHaveURL(/display=table/);
  const rows = await page.locator('table tbody tr[data-index]').count();
  expect(rows).toBeGreaterThan(0);
  // The amount column is money, and the sticky footer sums it.
  await expect(page.locator('table tbody tr[data-index]').first()).toContainText(/[$€£][\d,]+\.\d{2}/);
});

test('the pipeline selector swaps the whole board', async ({ page, request }) => {
  await board(page);
  const other = (await pipelines(request)).find((p) => !p.is_default)!;
  await page.getByLabel('Pipeline').selectOption(other.name);
  await page.waitForFunction(
    (label: string) => !!document.querySelector(`.pl-col .pl-col__name`)
      && [...document.querySelectorAll('.pl-col__name')].some((node) => node.textContent === label),
    other.stages[0].label,
  );
  await expect(page).toHaveURL(new RegExp(`pipeline=${other.name}`));
  await expect(page.locator('.ain-page__subtitle')).toContainText(other.label);
});

test('a filter that matches nothing says so and offers a way back', async ({ page }) => {
  await page.goto('/deals?q=zzzzz-no-such-deal', { waitUntil: 'networkidle' });
  await expect(page.getByText('No deal matches these filters')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.waitForSelector('.pl-card');
  expect(await page.locator('.pl-card').count()).toBeGreaterThan(0);
});

/* ================================= writes ================================= */

test('creating a deal from the board writes it, on the pipeline and stage chosen', async ({ page, request }) => {
  await board(page);
  const name = `Playwright pilot — ${Date.now()}`;

  await page.getByRole('button', { name: 'New deal' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Deal name').fill(name);
  await dialog.getByLabel('Amount', { exact: true }).fill('124500');
  await dialog.getByLabel('Amount', { exact: true }).press('Tab');
  await dialog.getByLabel('Stage').selectOption({ index: 1 });
  const stage = await dialog.getByLabel('Stage').inputValue();
  await dialog.getByRole('button', { name: 'Create deal' }).click();

  // The UI navigates to the record it just made; the server has to agree it exists.
  await page.waitForURL(/\/deals\/deal_/);
  const created = await findDeal(request, name);
  expect(created).toBeTruthy();
  expect(created!.properties.deal_stage).toBe(stage);
  expect(created!.properties.amount).toBe(12450000);
  // The stage's probability is stamped by the server, not typed by the operator.
  expect(typeof created!.properties.probability).toBe('number');
  expect(created!.properties.weighted_amount).toBe(
    Math.round((12450000 * (created!.properties.probability as number)) / 100),
  );

  await request.delete(`/api/v1/records/deal/${created!.id}?permanent=true`);
});

test('a create the server refuses shows its message under the field the server named', async ({ page }) => {
  await board(page);
  await page.getByRole('button', { name: 'New deal' }).click();
  const dialog = page.getByRole('dialog');

  // `name` is capped at 500 characters by the property definition, so this is
  // refused with `param: properties.name` — the path that has to put the
  // server's sentence under the Deal name field rather than swallow it.
  await dialog.getByLabel('Deal name').fill('x'.repeat(600));
  await dialog.getByLabel('Amount', { exact: true }).fill('1000');
  await dialog.getByLabel('Amount', { exact: true }).press('Tab');
  await dialog.getByRole('button', { name: 'Create deal' }).click();

  const error = dialog.locator('.ain-field__error');
  await expect(error).toBeVisible({ timeout: 10_000 });
  await expect(error).toContainText('at most 500 characters');
  // The dialog stays open with the values intact, so the mistake can be fixed.
  await expect(dialog).toBeVisible();
});

test('moving a deal between open stages writes the move and restamps the forecast', async ({ page, request }) => {
  await board(page);
  const [defaultPipeline] = (await pipelines(request)).filter((p) => p.is_default);
  const open = defaultPipeline.stages.filter((s) => !s.is_closed);
  const from = await stageWithACard(page, open);
  const to = open.find((s) => s.name !== from.name && s.probability !== from.probability)!;

  const card = cardsIn(page, from.name).first();
  await expect(card).toBeVisible();
  const id = await card.getAttribute('data-deal');
  const before = await deal(request, id!);

  await card.getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem').filter({ hasText: to.label }).first().click();

  // The card lands in the destination column…
  await expect(page.locator(`.pl-col[data-stage="${to.name}"] .pl-card[data-deal="${id}"]`)).toBeVisible();
  // …and the server agrees, with the destination's probability stamped on it.
  await expect.poll(async () => (await deal(request, id!)).properties.deal_stage).toBe(to.name);
  const after = await deal(request, id!);
  expect(after.properties.probability).toBe(to.probability);
  expect(after.properties.probability).not.toBe(before.properties.probability);
  expect(after.properties.weighted_amount).toBe(
    Math.round(((after.properties.amount as number) * to.probability) / 100),
  );

  // Put it back so the board is where the next test expects it.
  await request.patch(`/api/v1/records/deal/${id}`, { data: { properties: { deal_stage: from.name } } });
});

test('dragging a card into another column moves the deal', async ({ page, request }) => {
  await board(page);
  const [defaultPipeline] = (await pipelines(request)).filter((p) => p.is_default);
  const open = defaultPipeline.stages.filter((s) => !s.is_closed);
  const from = await stageWithACard(page, open);
  const to = open.find((s) => s.name !== from.name)!;

  const card = cardsIn(page, from.name).first();
  await expect(card).toBeVisible();
  const id = await card.getAttribute('data-deal');

  await dragCardTo(page, id!, to.name);

  await expect(page.locator(`.pl-col[data-stage="${to.name}"] .pl-card[data-deal="${id}"]`)).toBeVisible();
  await expect.poll(async () => (await deal(request, id!)).properties.deal_stage).toBe(to.name);

  await request.patch(`/api/v1/records/deal/${id}`, { data: { properties: { deal_stage: from.name } } });
});

test('closing a deal stops at a confirmation that states the forecast change and demands a reason', async ({ page, request }) => {
  await board(page);
  const [defaultPipeline] = (await pipelines(request)).filter((p) => p.is_default);
  const from = await stageWithACard(page, defaultPipeline.stages.filter((s) => !s.is_closed));
  const won = defaultPipeline.stages.find((s) => s.is_won)!;

  const card = cardsIn(page, from.name).first();
  const id = await card.getAttribute('data-deal');
  await card.getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem').filter({ hasText: won.label }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // It says what the move does before it does it.
  await expect(dialog).toContainText(`${from.probability}%`);
  await expect(dialog).toContainText(`${won.probability}%`);
  // And it will not go through until the outcome is recorded.
  const confirm = dialog.getByRole('button', { name: /Mark won|Mark closed/ });
  await expect(confirm).toBeDisabled();

  await dialog.getByLabel('Close reason').selectOption({ index: 1 });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect.poll(async () => (await deal(request, id!)).properties.deal_stage).toBe(won.name);
  const after = await deal(request, id!);
  expect(after.properties.close_reason).toBeTruthy();
  expect(after.properties.deal_status).toBe('won');

  await request.patch(`/api/v1/records/deal/${id}`, {
    data: { properties: { deal_stage: from.name, close_reason: null } },
  });
});

test('Escape closes the stage confirmation without writing anything', async ({ page, request }) => {
  await board(page);
  const [defaultPipeline] = (await pipelines(request)).filter((p) => p.is_default);
  const from = await stageWithACard(page, defaultPipeline.stages.filter((s) => !s.is_closed));
  const lost = defaultPipeline.stages.find((s) => s.is_closed && !s.is_won)!;

  const card = cardsIn(page, from.name).first();
  const id = await card.getAttribute('data-deal');
  await card.getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem').filter({ hasText: lost.label }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  expect((await deal(request, id!)).properties.deal_stage).toBe(from.name);
});

/* ============================== deal record =============================== */

test('the deal record shows the forecast the stage produced and its own history', async ({ page, request }) => {
  const list = (await (await request.get('/api/v1/records/deal?limit=1&sort=amount&order=desc')).json()) as DealList;
  const row = list.data[0];
  await page.goto(`/deals/${row.id}`, { waitUntil: 'networkidle' });

  await expect(page.getByRole('heading', { name: row.display_name })).toBeVisible();
  const money = ((row.properties.amount as number) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  await expect(page.locator('.pl-facts')).toContainText(money);
  await expect(page.locator('.pl-facts')).toContainText(`${row.properties.probability as number}%`);
  // The stage rail is the primary control and marks where the deal is now.
  await expect(page.locator('.pl-rail__step.is-current')).toHaveCount(1);
});

test('logging an activity from the deal record lands on the record’s timeline', async ({ page, request }) => {
  const list = (await (await request.get('/api/v1/records/deal?limit=1')).json()) as DealList;
  const row = list.data[0];
  await page.goto(`/deals/${row.id}`, { waitUntil: 'networkidle' });

  const subject = `Playwright check ${Date.now()}`;
  await page.getByRole('button', { name: 'Log activity' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Subject').fill(subject);
  await dialog.getByLabel('Detail').fill('Written by the deal record page.');
  await dialog.getByRole('button', { name: /^Log / }).click();

  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const timeline = (await (await request.get(`/api/v1/records/deal/${row.id}/timeline`)).json()) as { data: { title: string }[] };
    return timeline.data.some((item) => item.title.includes(subject));
  }).toBe(true);
});

test('the stage rail moves the deal', async ({ page, request }) => {
  const list = (await (await request.get('/api/v1/records/deal?limit=1')).json()) as DealList;
  const row = list.data[0];
  const startStage = row.properties.deal_stage as string;
  const all = await pipelines(request);
  const own = all.find((p) => p.name === row.properties.pipeline)!;
  const target = own.stages.find((s) => !s.is_closed && s.name !== startStage)!;

  await page.goto(`/deals/${row.id}`, { waitUntil: 'networkidle' });
  await page.locator('.pl-rail__step', { hasText: target.label }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: `Move to ${target.label}` }).click();

  await expect.poll(async () => (await deal(request, row.id)).properties.deal_stage).toBe(target.name);
  await request.patch(`/api/v1/records/deal/${row.id}`, { data: { properties: { deal_stage: startStage } } });
});

/* ================================ copilot ================================= */

test('a suggested question is answered from this workspace, with citations that navigate', async ({ page }) => {
  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  await page.waitForSelector('.cp-suggest__item');

  await page.locator('.cp-suggest__item').first().click();
  await expect(page.locator('.cp-answer').last()).toBeVisible({ timeout: 30_000 });

  // A grounded answer carries the records it was read from, and each chip is a
  // real destination rather than a decoration.
  const chip = page.locator('.cp-chip:not([disabled])').first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  await expect(page).toHaveURL(/\/(deals|companies|contacts|records|customers|invoices)\//);
});

test('every answer can be opened down to the tool call and its arguments', async ({ page, request }) => {
  // Pick a run the engine really did call a tool in, so the assertion is about
  // the UI rather than about which question happened to be asked last.
  const runs = (await (await request.get('/api/v1/ai/runs?limit=25')).json()) as
    { data: { id: string; thread_id: string | null }[] };
  let target: { thread_id: string; span: string } | null = null;
  for (const run of runs.data) {
    if (!run.thread_id) continue;
    const detail = (await (await request.get(`/api/v1/ai/runs/${run.id}`)).json()) as
      { trace: { id: string; kind: string; args: Record<string, unknown> }[] };
    const span = detail.trace.find((s) => s.kind === 'tool' && Object.keys(s.args ?? {}).length > 0);
    if (span) { target = { thread_id: run.thread_id, span: span.id }; break; }
  }
  expect(target, 'no run in this workspace called a tool').not.toBeNull();

  await page.goto(`/copilot?thread=${target!.thread_id}`, { waitUntil: 'networkidle' });
  for (const button of await page.getByRole('button', { name: /Show the .* behind this/ }).all()) {
    await button.click();
  }
  await page.waitForSelector('.cp-step');

  // A tool step opens to the exact arguments the engine passed.
  const step = page.locator(`.cp-step[data-span="${target!.span}"]`);
  await expect(step).toBeVisible();
  await step.click();
  await expect(page.locator('.cp-step__detail .cp-code').first()).toBeVisible();
  await expect(page.locator('.cp-step__detail')).toContainText('Arguments');
});

test('the run log is the workspace’s own runs, and one opens to its full trace', async ({ page, request }) => {
  const runs = (await (await request.get('/api/v1/ai/runs?limit=100')).json()) as {
    data: { id: string; question: string }[]; total_count: number;
  };
  await page.goto('/copilot/runs', { waitUntil: 'networkidle' });
  await page.waitForSelector('table tbody tr[data-index]');
  expect(await page.locator('table tbody tr[data-index]').count()).toBe(runs.data.length);

  await page.locator('table tbody tr[data-index]').first().click();
  await page.waitForURL(/\/copilot\/runs\/run_/);
  await expect(page.locator('.cp-runfacts')).toContainText('ms');
  await expect(page.locator('.cp-step')).not.toHaveCount(0);
});

test('a write the copilot prepares stops at an approval card, and approving it runs it', async ({ page, request }) => {
  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });

  const company = (await (await request.get('/api/v1/records/company?limit=1')).json()) as
    { data: { id: string; display_name: string }[] };
  const target = company.data[0];
  const marker = `Playwright approval ${Date.now()}`;

  await page.getByRole('switch', { name: 'Let it prepare writes' }).click();
  await page.getByLabel('Ask the copilot').fill(`Log a note on ${target.display_name} saying ${marker}`);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();

  const card = page.getByText('Waiting for your approval').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  // The card shows the write itself, not a paraphrase of it.
  await page.getByRole('button', { name: 'Show the exact arguments' }).first().click();
  await expect(page.locator('.cp-code').filter({ hasText: 'record_ids' }).first()).toBeVisible();

  // Nothing has been written yet.
  const before = (await (await request.get(`/api/v1/records/company/${target.id}/timeline`)).json()) as
    { data: { title: string; body: string | null }[] };
  expect(before.data.some((item) => (item.body ?? '').includes(marker))).toBe(false);

  await page.getByRole('button', { name: 'Approve and run' }).first().click();
  await expect.poll(async () => {
    const after = (await (await request.get(`/api/v1/records/company/${target.id}/timeline`)).json()) as
      { data: { title: string; body: string | null }[] };
    return after.data.some((item) => `${item.title} ${item.body ?? ''}`.includes(marker));
  }, { timeout: 20_000 }).toBe(true);
});

test('a refusal is rendered as a refusal, not as an answer', async ({ page }) => {
  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  await page.getByLabel('Ask the copilot').fill('How did we do tomorrow?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.cp-answer').last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('The engine refused to answer this one')).toBeVisible({ timeout: 30_000 });
});

/* =============================== keyboard ================================= */

test('the board is operable from the keyboard alone', async ({ page }) => {
  await board(page);
  const card = page.locator('.pl-card').first();
  const title = card.locator('.pl-card__name');
  await title.focus();
  await expect(title).toBeFocused();
  // Tab reaches the card's action menu, and Enter opens it.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
});

/* ============================== associations ============================== */

interface AssociationRow {
  id: string;
  association_type: string;
  record_id: string;
  display_name: string;
}

const associations = async (
  request: APIRequestContext, dealId: string, type: string,
): Promise<AssociationRow[]> =>
  ((await (await request.get(
    `/api/v1/records/deal/${dealId}/associations?association_type=${type}`,
  )).json()) as { data: AssociationRow[] }).data;

/** A deal that already has both an account and a committee, so both cards are live. */
const linkedDeal = async (request: APIRequestContext): Promise<DealRecord> => {
  const list = (await (await request.get('/api/v1/records/deal?limit=20&expand=associations')).json()) as {
    data: (DealRecord & { associations?: AssociationRow[] })[];
  };
  const found = list.data.find((row) =>
    (row.associations ?? []).some((a) => a.association_type === 'deal_to_company')
    && (row.associations ?? []).some((a) => a.association_type === 'deal_to_contact'));
  if (!found) throw new Error('no seeded deal carries both an account and a committee');
  return found;
};

/** The async Combobox fetches on a debounce; arrowing before it answers picks nothing. */
const pickFirstOption = async (page: Page) => {
  await expect(page.getByRole('option').first()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
};

test('a contact can be added to the buying committee and taken off again', async ({ page, request }) => {
  const target = await linkedDeal(request);
  const before = await associations(request, target.id, 'deal_to_contact');

  await page.goto(`/deals/${target.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('combobox', { name: 'Contacts' }).click();
  await pickFirstOption(page);
  await page.getByRole('button', { name: 'Link contact' }).click();

  await expect.poll(async () => (await associations(request, target.id, 'deal_to_contact')).length)
    .toBe(before.length + 1);

  // The dialog stays open so a second person can be added; Done closes it.
  await expect(page.getByText(/^Added /)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  const after = await associations(request, target.id, 'deal_to_contact');
  const added = after.find((row) => !before.some((b) => b.id === row.id))!;
  await expect(page.locator(`[data-association="${added.id}"]`)).toBeVisible();

  // …and off again, through the control on the row itself.
  const removeControl = page.locator(`[data-association="${added.id}"] button[aria-label^="Remove"]`);
  await removeControl.hover();
  await removeControl.click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();

  await expect.poll(async () => (await associations(request, target.id, 'deal_to_contact')).length)
    .toBe(before.length);
});

test('changing the account replaces the link rather than adding a second one', async ({ page, request }) => {
  const target = await linkedDeal(request);
  const before = (await associations(request, target.id, 'deal_to_company'))[0];

  await page.goto(`/deals/${target.id}`, { waitUntil: 'networkidle' });
  await page.locator('button[aria-label^="Account actions"]').click();
  await page.getByRole('menuitem', { name: 'Change account' }).click();
  await page.getByRole('combobox', { name: 'Company' }).click();
  await pickFirstOption(page);
  await page.getByRole('button', { name: 'Link company' }).click();

  await expect.poll(async () => (await associations(request, target.id, 'deal_to_company'))[0]?.record_id)
    .not.toBe(before.record_id);
  // A deal belongs to exactly one account: the old edge is gone, not orphaned.
  expect((await associations(request, target.id, 'deal_to_company')).length).toBe(1);

  await request.post('/api/v1/associations', {
    data: { from_id: target.id, to_id: before.record_id, association_type: 'deal_to_company' },
  });
});

test('an unlinked deal offers a way to link one, and the empty state is honest', async ({ page, request }) => {
  const target = await linkedDeal(request);
  const account = (await associations(request, target.id, 'deal_to_company'))[0];
  await request.delete(`/api/v1/associations/${account.id}`);

  await page.goto(`/deals/${target.id}`, { waitUntil: 'networkidle' });
  await expect(page.getByText('No account linked', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Link a company' }).click();
  await expect(page.getByRole('combobox', { name: 'Company' })).toBeVisible();
  await page.keyboard.press('Escape');

  await request.post('/api/v1/associations', {
    data: { from_id: target.id, to_id: account.record_id, association_type: 'deal_to_company' },
  });
});

/* ================================= bulk =================================== */

test('the table moves several deals at once, and states the forecast change first', async ({ page, request }) => {
  await page.goto('/deals?display=table', { waitUntil: 'networkidle' });
  await page.waitForSelector('tbody tr');

  const boxes = page.locator('tbody input[type="checkbox"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await expect(page.getByRole('region', { name: 'Bulk actions' })).toBeVisible();

  const names: string[] = [];
  for (const row of await page.locator('tbody tr').all()) {
    const box = row.locator('input[type="checkbox"]');
    if (await box.count() && await box.isChecked()) {
      names.push((await row.locator('td').nth(1).innerText()).trim());
    }
  }
  expect(names.length).toBe(2);

  const stages = (await pipelines(request)).find((p) => p.is_default)!.stages;
  const sitting = new Set(await Promise.all(names.map(async (name) => (await findDeal(request, name))?.properties.deal_stage)));
  const destination = stages.find((s) => !s.is_closed && !sitting.has(s.name))!;
  expect(destination).toBeTruthy();

  await page.getByRole('button', { name: 'Move stage' }).click();
  await page.getByRole('menuitem', { name: new RegExp(destination.label) }).click();

  // The dialog has to say what it is about to do to the forecast before it does it.
  await expect(page.getByText('Weighted after')).toBeVisible();
  await expect(page.getByText('Amount moving')).toBeVisible();
  await page.getByRole('button', { name: /^Move \d+ deals?$/ }).click();

  await expect.poll(async () => {
    const rows = await Promise.all(names.map((name) => findDeal(request, name)));
    return rows.every((row) => row?.properties.deal_stage === destination.name);
  }, { timeout: 15_000 }).toBe(true);

  // The probability travelled with the stage — that is what makes it a forecast.
  for (const name of names) {
    const row = await findDeal(request, name);
    expect(row?.properties.probability).toBe(destination.probability);
  }
});

test('a bulk move to a closing stage demands the reason a single move demands', async ({ page, request }) => {
  const stages = (await pipelines(request)).find((p) => p.is_default)!.stages;
  const lost = stages.find((s) => s.is_closed && !s.is_won);
  test.skip(!lost, 'this pipeline has no losing stage');

  await page.goto('/deals?display=table', { waitUntil: 'networkidle' });
  await page.waitForSelector('tbody tr');
  await page.locator('tbody input[type="checkbox"]').nth(0).check();
  await page.getByRole('button', { name: 'Move stage' }).click();
  await page.getByRole('menuitem', { name: new RegExp(lost!.label) }).click();

  // The confirm button stays disabled until the outcome the workspace requires
  // is filled in — a bulk close with no recorded reason is the thing this stops.
  const confirm = page.getByRole('button', { name: /^Move \d+ deals?$/ });
  await expect(confirm).toBeDisabled();
  await page.keyboard.press('Escape');
});

test('the bulk bar reassigns a set of deals to one teammate', async ({ page, request }) => {
  await page.goto('/deals?display=table', { waitUntil: 'networkidle' });
  await page.waitForSelector('tbody tr');
  await page.locator('tbody input[type="checkbox"]').nth(0).check();

  const name = (await page.locator('tbody tr').first().locator('td').nth(1).innerText()).trim();
  const before = await findDeal(request, name);

  const users = ((await (await request.get('/api/v1/users')).json()) as { data: { id: string; name: string }[] }).data;
  const next = users.find((user) => user.id !== before?.owner_id)!;

  await page.getByRole('button', { name: 'Reassign' }).click();
  await page.getByLabel('New owner').selectOption(next.id);
  await page.getByRole('button', { name: 'Reassign', exact: true }).last().click();

  await expect.poll(async () => (await findDeal(request, name))?.owner_id, { timeout: 15_000 }).toBe(next.id);
});

/* ================================ drafting ================================ */

test('the copilot drafts from a deal’s own facts, and the draft can be edited before it is logged', async ({ page, request }) => {
  const target = await linkedDeal(request);
  const timeline = async (): Promise<{ data: { title: string; body: string | null }[] }> =>
    (await (await request.get(`/api/v1/records/deal/${target.id}/timeline`)).json()) as never;

  await page.goto(`/deals/${target.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Move stage' }).click();
  await page.getByRole('menuitem', { name: 'Draft a follow-up' }).click();

  const own = `Sorry again about the outage — ${Date.now()}`;
  await page.getByRole('textbox', { name: 'A line of your own' }).fill(own);
  await page.getByRole('button', { name: 'Write the draft' }).click();

  const body = page.getByRole('textbox', { name: 'Body' });
  await expect(body).toBeVisible({ timeout: 30_000 });

  // Grounded, not generic: the engine says which of this workspace's facts it used.
  await expect(page.getByText('Grounded in')).toBeVisible();
  const drafted = await body.inputValue();
  expect(drafted.length).toBeGreaterThan(40);
  // The sentence the person wrote is in the draft, not silently discarded.
  expect(drafted).toContain(own);

  // A draft nobody can change before it lands is a demo, so the edit has to survive.
  const marker = `Confirmed by a person ${Date.now()}`;
  await body.fill(`${drafted}\n\n${marker}`);
  await page.getByRole('button', { name: /^Log on / }).click();

  // The timeline is a capped page, so a new entry does not change its length —
  // what has to be true is that the newest thing on it is the draft as edited.
  await expect.poll(async () => (await timeline()).data[0]?.body ?? '', { timeout: 15_000 })
    .toContain(marker);
});

test('the draft dialog opens from the copilot and asks which deal it is about', async ({ page }) => {
  await page.goto('/copilot', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Draft', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'About which deal' })).toBeVisible();
  // Nothing can be written until a record is named — the draft is grounded or it is nothing.
  await expect(page.getByRole('button', { name: 'Write the draft' })).toBeDisabled();
  await page.keyboard.press('Escape');
});

/**
 * The controls that steer the draft actually steer it.
 *
 * The dialog used to demand a sentence describing the message and then compose
 * from a template regardless, so two opposite instructions produced byte-
 * identical emails. Kind is the control now, and it has to change the words.
 */
test('the kind chosen changes the message the engine writes', async ({ page, request }) => {
  const target = await linkedDeal(request);
  const draft = async (kind: string): Promise<string> => {
    await page.goto(`/deals/${target.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Move stage' }).click();
    await page.getByRole('menuitem', { name: 'Draft a follow-up' }).click();
    await page.getByLabel('Kind').selectOption(kind);
    await page.getByRole('button', { name: 'Write the draft' }).click();
    const body = page.getByRole('textbox', { name: 'Body' });
    await expect(body).toBeVisible({ timeout: 30_000 });
    const text = await body.inputValue();
    await page.keyboard.press('Escape');
    return text;
  };

  const followUp = await draft('follow_up');
  const renewal = await draft('renewal');
  expect(renewal).not.toBe(followUp);
  expect(renewal.toLowerCase()).toContain('renew');
});


/* ============================ calendar dates ============================== */

/**
 * A close date is a day, not an instant.
 *
 * The workspace runs in America/New_York and the CRM stores a date-only
 * property at midnight UTC, so formatting one in the workspace's zone used to
 * land it on the previous evening: the picker wrote Sep 23 and every read-only
 * surface said Sep 22. The picker, the record tile, the properties list, the
 * board card and the editor all have to agree on one day.
 */
test('the close date you pick is the close date every screen reads back', async ({ page, request }) => {
  await page.goto('/deals?new=1', { waitUntil: 'networkidle' });
  const name = `Calendar probe ${Date.now()}`;
  await page.getByLabel('Deal name').fill(name);
  await page.getByLabel('Amount', { exact: true }).fill('80000');
  await page.getByLabel('Amount', { exact: true }).press('Tab');

  await page.getByRole('button', { name: 'Close date' }).click();
  const day = page.getByRole('gridcell', { name: /^\w+ \d+, \d{4}$/ }).nth(20);
  const picked = (await day.getAttribute('aria-label'))!;
  await day.click();
  await expect(page.getByRole('button', { name: 'Close date' })).toContainText(picked);

  await page.getByRole('button', { name: 'Create deal' }).click();
  await page.waitForURL(/\/deals\/deal_/, { timeout: 20_000 });
  const id = page.url().split('/').pop()!;

  // The record page, in all three places it shows the same field.
  await expect(page.locator('.pl-fact').filter({ hasText: 'Close date' })).toContainText(picked);
  await expect(page.locator('.pl-proplist')).toContainText(picked);

  // And the editor, re-opened, still reads the day that was chosen.
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Close date' })).toContainText(picked);
  await page.keyboard.press('Escape');

  // The stored value is that day at midnight UTC — a calendar date, not an instant.
  const stored = (await deal(request, id)).properties.close_date as number;
  expect(new Date(stored).toISOString()).toMatch(/T00:00:00\.000Z$/);
  expect(new Date(stored).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }))
    .toBe(picked);

  await request.delete(`/api/v1/records/deal/${id}`);
});

/**
 * Closing a deal books it on the day the workspace is on.
 *
 * Left to the server the close stamp is a UTC midnight, which for a workspace
 * behind Greenwich reads as the previous day — a deal closed on the 1st showing
 * as closed on the 31st is the wrong side of every month-end cutoff.
 */
test('a deal closed today books today, not yesterday', async ({ page, request }) => {
  await page.goto('/deals?new=1', { waitUntil: 'networkidle' });
  const name = `Close stamp probe ${Date.now()}`;
  await page.getByLabel('Deal name').fill(name);
  await page.getByLabel('Amount', { exact: true }).fill('50000');
  await page.getByLabel('Amount', { exact: true }).press('Tab');
  await page.getByRole('button', { name: 'Create deal' }).click();
  await page.waitForURL(/\/deals\/deal_/, { timeout: 20_000 });
  const id = page.url().split('/').pop()!;

  const [defaultPipeline] = (await pipelines(request)).filter((p) => p.is_default);
  const won = defaultPipeline.stages.find((s) => s.is_won)!;

  await page.getByRole('button', { name: 'Move stage' }).click();
  await page.getByRole('menuitem').filter({ hasText: won.label }).first().click();
  const dialog = page.getByRole('dialog');
  // The day it books is stated, and editable, before the write.
  const stamp = (await dialog.getByRole('button', { name: 'Close date' }).innerText()).trim();
  await dialog.getByLabel('Close reason').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: 'Mark won' }).click();

  await expect.poll(async () => (await deal(request, id)).properties.deal_status, { timeout: 15_000 }).toBe('won');
  await expect(page.locator('.pl-fact').filter({ hasText: 'Close date' })).toContainText(stamp);
  await expect(page.locator('.pl-fact').filter({ hasText: 'Close date' })).toContainText('today');

  await request.delete(`/api/v1/records/deal/${id}`);
});

/**
 * "Closed won · Lost to competitor" must be unrepresentable.
 *
 * One picklist serves both outcomes, so the dialog has to offer the half that
 * belongs to the stage it is closing into.
 */
test('a win can only be closed for a reason a win can carry', async ({ page, request }) => {
  const [defaultPipeline] = (await pipelines(request)).filter((p) => p.is_default);
  const won = defaultPipeline.stages.find((s) => s.is_won)!;
  const lost = defaultPipeline.stages.find((s) => s.is_closed && !s.is_won)!;

  await board(page);
  const from = await stageWithACard(page, defaultPipeline.stages.filter((s) => !s.is_closed));
  const card = cardsIn(page, from.name).first();
  await card.getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem').filter({ hasText: won.label }).first().click();
  const winReasons = await page.getByRole('dialog').getByLabel('Close reason').locator('option').allInnerTexts();
  await page.keyboard.press('Escape');

  await card.getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem').filter({ hasText: lost.label }).first().click();
  const lossReasons = await page.getByRole('dialog').getByLabel('Close reason').locator('option').allInnerTexts();
  await page.keyboard.press('Escape');

  // Neither list is the whole enum, and no reason is offered for both outcomes.
  expect(winReasons.length).toBeGreaterThan(1);
  expect(lossReasons.length).toBeGreaterThan(1);
  const overlap = winReasons.filter((r) => r !== '— no close reason —' && lossReasons.includes(r));
  expect(overlap).toEqual([]);
  expect(lossReasons.join(' ')).toContain('Lost to competitor');
  expect(winReasons.join(' ')).not.toContain('Lost to competitor');
});

/* ============================== honest states ============================= */

test('the board header does not quote a total it has not measured', async ({ page }) => {
  await page.route('**/api/v1/records/deal?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });
  const nav = page.goto('/deals');
  await page.waitForTimeout(1200);
  const subtitle = await page.locator('.ain-page__subtitle').first().innerText();
  expect(subtitle).not.toContain('$0.00 open');
  await nav.catch(() => undefined);
});

test('filtering the board moves the stat cards with it', async ({ page, request }) => {
  const users = ((await (await request.get('/api/v1/users')).json()) as { data: { id: string; name: string }[] }).data;
  await page.goto(`/deals?owner=${users[0].id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const summary = page.locator('.pl-summary');
  await expect(summary).toContainText('filtered');
  const open = (await summary.locator('.ain-stat__value').first().innerText()).trim();
  const subtitle = await page.locator('.ain-page__subtitle').first().innerText();
  // Whatever the tile says is the number the subtitle says, not the whole pipeline.
  expect(subtitle).toContain(`${open} open`);
});

test('the bulk stage menu quotes only the deals that would move', async ({ page }) => {
  await page.goto('/deals?display=table', { waitUntil: 'networkidle' });
  await page.waitForSelector('tbody tr');
  for (let i = 0; i < 3; i++) await page.locator('tbody input[type="checkbox"]').nth(i).check();
  const stages = await page.locator('tbody tr').evaluateAll((rows) =>
    rows.slice(0, 3).map((row) => (row.querySelector('td:nth-child(4)')?.textContent ?? '').trim()));
  await page.getByRole('button', { name: 'Move stage' }).click();

  // A destination two of the three already sit in offers to move only the third.
  const repeated = stages.find((name) => stages.filter((s) => s === name).length > 1);
  if (repeated) {
    const item = page.getByRole('menuitem').filter({ hasText: repeated }).first();
    const moving = 3 - stages.filter((s) => s === repeated).length;
    await expect(item).toContainText(moving === 1 ? '1 deal' : `${moving} deals`);
  }
  const other = page.getByRole('menuitem').filter({ hasText: /Closed won/ }).first();
  await expect(other).toContainText('3 deals');
  await page.keyboard.press('Escape');
});

test('the keyboard keeps its place after a stage move from a card menu', async ({ page }) => {
  await board(page);
  const card = page.locator('.pl-card').first();
  const id = await card.getAttribute('data-deal');
  await card.locator('.pl-card__name').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await expect.poll(async () => page.evaluate((dealId) => {
    const active = document.activeElement;
    return active?.closest('.pl-card')?.getAttribute('data-deal') === dealId;
  }, id), { timeout: 10_000 }).toBe(true);
});

/* =========================== copilot aftermath ============================ */

/**
 * The conversation is the thing a person re-reads a week later. It has to say
 * what happened, not what was planned.
 */
test('the conversation records what became of an approved write', async ({ page, request }) => {
  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  const company = ((await (await request.get('/api/v1/records/company?limit=1')).json()) as
    { data: { id: string; display_name: string }[] }).data[0];
  const marker = `Aftermath ${Date.now()}`;

  await page.getByRole('switch', { name: 'Let it prepare writes' }).click();
  await page.getByLabel('Ask the copilot').fill(`Log a note on ${company.display_name} saying ${marker}`);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText('Waiting for your approval').first()).toBeVisible({ timeout: 40_000 });
  await page.getByRole('button', { name: 'Approve and run' }).first().click();

  const answer = page.locator('.cp-answer').last();
  await expect(answer.locator('.cp-resolution')).toContainText('Approved and written', { timeout: 20_000 });
  await expect(answer.locator('.cp-resolution')).toContainText(company.display_name);
  // The stale "nothing has been written" is marked as superseded rather than left standing.
  await expect(answer.locator('.cp-superseded')).toBeVisible();

  // And it survives a reload — the record, not a toast that disappears.
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.cp-answer').last().locator('.cp-resolution'))
    .toContainText('Approved and written', { timeout: 20_000 });
});

test('a declined write leaves the needs-approval queue', async ({ page, request }) => {
  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  const company = ((await (await request.get('/api/v1/records/company?limit=1')).json()) as
    { data: { id: string; display_name: string }[] }).data[0];

  await page.getByRole('switch', { name: 'Let it prepare writes' }).click();
  await page.getByLabel('Ask the copilot').fill(`Log a note on ${company.display_name} saying Declined ${Date.now()}`);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText('Waiting for your approval').first()).toBeVisible({ timeout: 40_000 });

  const before = await page.evaluate(async () =>
    ((await (await fetch('/api/v1/ai/runs?limit=1')).json()) as { data: { id: string }[] }).data[0].id);

  await page.getByRole('button', { name: 'Decline', exact: true }).first().click();
  await expect(page.locator('.cp-answer').last().locator('.cp-resolution'))
    .toContainText('Declined', { timeout: 20_000 });

  await page.goto('/copilot/runs?status=needs_approval', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await expect(page.locator(`tbody tr:has-text("${before}")`)).toHaveCount(0);
  await page.goto('/copilot/runs?status=declined', { waitUntil: 'networkidle' });
  await expect(page.locator('tbody tr').first()).toContainText('Declined', { timeout: 15_000 });
});

test('a run trace counts and orders the steps the same way twice', async ({ page, request }) => {
  const runs = ((await (await request.get('/api/v1/ai/runs?limit=50')).json()) as { data: { id: string }[] }).data;
  const detailed = await Promise.all(runs.slice(0, 12).map(async (row) =>
    (await (await request.get(`/api/v1/ai/runs/${row.id}`)).json()) as
      { id: string; trace: { started: number }[] }));
  const target = detailed.find((row) => row.trace.length > 2) ?? detailed[0];

  await page.goto(`/copilot/runs/${target.id}`, { waitUntil: 'networkidle' });
  const rendered = await page.locator('.cp-step').count();
  expect(rendered).toBe(target.trace.length);
  const head = await page.locator('.ain-page__subtitle').first().innerText();
  expect(head).toContain(`${target.trace.length} step`);

  // Chronology is the only reason the panel exists.
  const starts = [...target.trace].sort((a, b) => a.started - b.started).map((span) => span.started);
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
});

test('a copilot request that fails keeps the question you typed', async ({ page }) => {
  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  await page.route('**/api/v1/ai/threads', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { type: 'api_error', code: 'engine_offline', message: 'The reasoning engine is offline.' } }),
  }));
  const question = 'What is open on the New business pipeline?';
  await page.getByLabel('Ask the copilot').fill(question);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByLabel('Ask the copilot')).toHaveValue(question, { timeout: 15_000 });
});

test('the copilot composer is reachable on a short window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 460 });
  await page.goto('/copilot', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const box = (await page.getByRole('button', { name: 'Ask', exact: true }).boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(460);
  const [scrollHeight, clientHeight] = await page.evaluate(() =>
    [document.documentElement.scrollHeight, document.documentElement.clientHeight]);
  expect(scrollHeight).toBeLessThanOrEqual(clientHeight + 1);
});

/**
 * A deal opened on the wrong motion is a real thing that happens, and until now
 * only the API could fix it: the stage rail walks one pipeline and the edit form
 * leaves both fields alone because changing one without the other is refused.
 */
test('a deal can be moved onto another pipeline, stage and all', async ({ page, request }) => {
  const all = await pipelines(request);
  if (all.length < 2) test.skip();
  const list = (await (await request.get('/api/v1/records/deal?limit=20')).json()) as DealList;
  const target = list.data.find((row) => row.properties.pipeline === all.find((p) => p.is_default)!.name)!;
  const before = { pipeline: target.properties.pipeline, stage: target.properties.deal_stage };

  await page.goto(`/deals/${target.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Move stage' }).click();
  await page.getByRole('menuitem', { name: 'Move to another pipeline' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const destination = await dialog.getByLabel('Pipeline').inputValue();
  expect(destination).not.toBe(before.pipeline);
  const stage = await dialog.getByLabel('Stage').inputValue();
  await dialog.getByRole('button', { name: /^Move to / }).click();

  await expect.poll(async () => (await deal(request, target.id)).properties.pipeline, { timeout: 15_000 })
    .toBe(destination);
  const after = await deal(request, target.id);
  expect(after.properties.deal_stage).toBe(stage);
  // The probability follows the destination stage, not the one it left.
  const stageDef = all.find((p) => p.name === destination)!.stages.find((s) => s.name === stage)!;
  expect(after.properties.probability).toBe(stageDef.probability);

  await request.patch(`/api/v1/records/deal/${target.id}`, {
    data: { properties: { pipeline: before.pipeline, deal_stage: before.stage } },
  });
});

/* ====================== the two halves agree on a day ===================== */

/**
 * The board and the copilot have to name the same day.
 *
 * A close date is a calendar day stored at midnight UTC. The board reads it
 * back in UTC; the answer engine used to format it in the workspace's own zone,
 * which for America/New_York is five hours behind — so a deal the board said
 * closed today was reported by the copilot as having closed yesterday. Two
 * screens in one product disagreeing about a close date is worse than either of
 * them being wrong on its own, because there is no way to tell which to trust.
 */
test('the copilot quotes a close date as the day it is stored, not the evening before', async ({ page, request }) => {
  const utcDay = (ts: number): string =>
    new Date(ts).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

  const list = (await (await request.get('/api/v1/records/deal?limit=200&expand=associations')).json()) as {
    data: (DealRecord & { associations?: AssociationRow[] })[];
  };
  const byCompany = new Map<string, { name: string; deals: { id: string; day: string }[] }>();
  for (const row of list.data) {
    const close = Number(row.properties.close_date ?? 0);
    const link = (row.associations ?? []).find((a) => a.association_type === 'deal_to_company');
    if (!close || !link) continue;
    const entry = byCompany.get(link.record_id) ?? { name: link.display_name, deals: [] };
    entry.deals.push({ id: row.id, day: utcDay(close) });
    byCompany.set(link.record_id, entry);
  }
  const account = [...byCompany.values()].sort((a, b) => b.deals.length - a.deals.length)[0];
  expect(account, 'no seeded deal carries both an account and a close date').toBeTruthy();
  const days = new Set(account.deals.map((row) => row.day));

  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  await page.getByLabel('Ask the copilot').fill(`Where does ${account.name} stand?`);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const answer = page.locator('.cp-answer').last();
  await expect(answer).toBeVisible({ timeout: 40_000 });
  // The newest answer types itself in; reading it mid-reveal reads half a word.
  await expect(answer.locator('.cp-answer__caret')).toHaveCount(0, { timeout: 30_000 });
  const text = await answer.innerText();

  const quoted = [
    ...text.matchAll(/clos(?:es|ing)\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/g),
    ...text.matchAll(/\b([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s+close date/g),
  ].map((match) => match[1]);
  expect(quoted.length, `the answer quoted no close date at all:\n${text}`).toBeGreaterThan(0);
  for (const day of quoted) {
    expect([...days], `the copilot said ${day}; ${account.name} has no deal closing then`).toContain(day);
  }

  // And the deal screens, on the same records, print the same day.
  for (const row of account.deals.slice(0, 2)) {
    await page.goto(`/deals/${row.id}`, { waitUntil: 'networkidle' });
    await expect(page.locator('.pl-fact').filter({ hasText: 'Close date' })).toContainText(row.day);
  }
});

/* =========================== conversation upkeep ========================== */

/**
 * A rail you cannot tidy fills up and stays full.
 *
 * The list has always offered an Archived view; nothing in the product could
 * put a thread into it. Rename, archive, reopen and delete are the four things
 * a person does to a conversation, and each has to reach the server.
 */
test('a conversation can be renamed, archived, brought back and deleted', async ({ page, request }) => {
  const title = `Housekeeping probe ${Date.now()}`;
  const created = (await (await request.post('/api/v1/ai/threads', { data: { title } })).json()) as { id: string };
  const stateOf = async (): Promise<{ title: string; status: string }> =>
    (await (await request.get(`/api/v1/ai/threads/${created.id}`)).json()) as { title: string; status: string };

  const menuFor = async (name: string) => {
    const row = page.locator('.cp-threadrow').filter({ hasText: name });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await row.getByRole('button', { name: /^Rename, archive or delete/ }).click();
  };

  await page.goto('/copilot', { waitUntil: 'networkidle' });

  const renamed = `${title} — renamed`;
  await menuFor(title);
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByLabel('Conversation title').fill(renamed);
  await page.getByRole('dialog').getByRole('button', { name: 'Rename', exact: true }).click();
  await expect.poll(async () => (await stateOf()).title, { timeout: 15_000 }).toBe(renamed);

  await menuFor(renamed);
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect.poll(async () => (await stateOf()).status, { timeout: 15_000 }).toBe('archived');
  // It leaves the open list, and the Archived view it advertises now holds it.
  await expect(page.locator('.cp-threadrow').filter({ hasText: renamed })).toHaveCount(0);
  await page.getByLabel('Conversation status').selectOption('archived');
  await expect(page.locator('.cp-threadrow').filter({ hasText: renamed })).toHaveCount(1, { timeout: 15_000 });

  await menuFor(renamed);
  await page.getByRole('menuitem', { name: 'Move back to Open' }).click();
  await expect.poll(async () => (await stateOf()).status, { timeout: 15_000 }).toBe('open');

  await page.getByLabel('Conversation status').selectOption('open');
  await menuFor(renamed);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete the conversation' }).click();
  await expect.poll(async () => (await request.get(`/api/v1/ai/threads/${created.id}`)).status(), { timeout: 15_000 })
    .toBe(404);
});

/**
 * A send that fails must not leave a husk behind.
 *
 * The first question of a conversation opens the thread and then posts into it.
 * When the second call failed the first one stayed, so every retry added an
 * empty untitled-looking row to the rail that nothing could remove.
 */
test('a first question that fails leaves no empty conversation behind', async ({ page, request }) => {
  const count = async (): Promise<number> =>
    ((await (await request.get('/api/v1/ai/threads?limit=100')).json()) as { data: unknown[] }).data.length;
  const before = await count();

  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  await page.route('**/api/v1/ai/threads/*/messages', (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: { type: 'api_error', code: 'engine_exploded', message: 'The reasoning engine fell over.' } }),
  }));

  const question = `Ghost probe ${Date.now()}: what is our open pipeline by stage?`;
  await page.getByLabel('Ask the copilot').fill(question);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  // The sentence comes back to the box, and the workspace is exactly as it was.
  await expect(page.getByLabel('Ask the copilot')).toHaveValue(question, { timeout: 20_000 });
  await expect.poll(count, { timeout: 15_000 }).toBe(before);
});

/**
 * The table has two search boxes on one screen. They cannot behave differently.
 *
 * The toolbar's filters re-total the stat row and badge it "filtered"; the
 * grid's own filter used to narrow the rows and leave the four tiles and the
 * subtitle quoting the whole pipeline above them.
 */
test('the table’s own filter moves the stat cards with it', async ({ page }) => {
  await page.goto('/deals?display=table', { waitUntil: 'networkidle' });
  await page.waitForSelector('tbody tr');
  const total = await page.locator('tbody tr').count();
  const account = (await page.locator('tbody tr').first().locator('td').nth(2).innerText()).trim();
  expect(account.length).toBeGreaterThan(0);

  await page.getByRole('searchbox', { name: 'Search table rows' }).fill(account);
  await expect.poll(async () => page.locator('tbody tr').count(), { timeout: 10_000 }).toBeLessThan(total);

  const summary = page.locator('.pl-summary');
  await expect(summary).toContainText('filtered');
  const open = (await summary.locator('.ain-stat__value').first().innerText()).trim();
  const subtitle = await page.locator('.ain-page__subtitle').first().innerText();
  expect(subtitle).toContain(`${open} open`);
  expect(subtitle).toContain(`${await page.locator('tbody tr').count()} deal`);
});

/* ================================= views ================================= */

interface ViewRow {
  id: string;
  name: string;
  shared: boolean;
  filter: { op: string; filters: { property: string; operator: string; value?: unknown; values?: unknown[] }[] } | null;
}

/**
 * The three filters a VP runs every Monday, with a name on them.
 *
 * The board's state has always been in the URL, which makes it linkable and
 * nothing else. A view is the same set of filters stored in `/v1/views` — the
 * platform's own saved-view table, holding the same filter tree the record
 * search compiles — so what is saved here is legible to the rest of the
 * product, and what someone saved elsewhere shows up on this menu.
 */
test('a filtered board can be saved as a named view, re-applied, updated and deleted', async ({ page, request }) => {
  const users = ((await (await request.get('/api/v1/users')).json()) as { data: { id: string; name: string }[] }).data;
  const owner = users[0];
  const views = async (): Promise<ViewRow[]> =>
    ((await (await request.get('/api/v1/views?object_type=deal')).json()) as { data: ViewRow[] }).data;
  const name = `Probe view ${Date.now()}`;
  const conditions = (row: ViewRow | undefined) =>
    (row?.filter?.filters ?? []).map((c) => `${c.property}:${c.operator}:${JSON.stringify(c.value ?? c.values)}`);

  await page.goto(`/deals?owner=${owner.id}&horizon=quarter`, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'Views' }).click();
  await page.getByRole('menuitem', { name: 'Save this board as a view…' }).click();
  await page.getByLabel('View name').fill(name);
  await page.getByRole('button', { name: 'Save the view' }).click();

  // The stored view is the board it was saved from, condition for condition.
  await expect.poll(async () => (await views()).some((row) => row.name === name), { timeout: 15_000 }).toBe(true);
  const saved = (await views()).find((row) => row.name === name)!;
  expect(conditions(saved)).toContain(`owner_id:eq:"${owner.id}"`);
  expect(conditions(saved)).toContain('close_date:between:["start_of_quarter","end_of_quarter"]');
  await expect(page.getByRole('button', { name })).toBeVisible();

  // A cold board, then the view applied by name: the controls come back set.
  await page.goto('/deals', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Views' }).click();
  // Each saved view is a togglable choice, so it carries the checkbox role.
  await page.getByRole('menuitemcheckbox', { name }).click();
  await expect.poll(() => page.url(), { timeout: 10_000 }).toContain(`owner=${owner.id}`);
  expect(page.url()).toContain('horizon=quarter');
  await expect(page.locator('.pl-summary')).toContainText('filtered');

  // Move the board off the view and it says so, then takes the change.
  await page.getByLabel('Owner').selectOption('');
  await expect(page.getByText('modified')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name }).click();
  await page.getByRole('menuitem', { name: /^Update / }).click();
  await expect.poll(async () => conditions((await views()).find((row) => row.id === saved.id)).join(','), { timeout: 15_000 })
    .not.toContain('owner_id');

  // And it can be taken off the menu again.
  await page.getByRole('button', { name }).click();
  await page.getByRole('menuitem', { name: /^Delete / }).click();
  await page.getByRole('button', { name: 'Delete the view' }).click();
  await expect.poll(async () => (await views()).some((row) => row.id === saved.id), { timeout: 15_000 }).toBe(false);
});

/**
 * The run list and the run's own trace count the same steps.
 *
 * `span_count` is stamped when a run finishes. A write that stopped for a
 * person and executed later appends a span after that, so the list said five
 * steps where the trace listed six — the same run, disagreeing with itself
 * across two screens.
 */
test('the run list counts the same steps the run’s own trace lists', async ({ page, request }) => {
  const company = ((await (await request.get('/api/v1/records/company?limit=1')).json()) as
    { data: { id: string; display_name: string }[] }).data[0];
  const marker = `Steps probe ${Date.now()}`;

  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  await page.getByRole('switch', { name: 'Let it prepare writes' }).click();
  await page.getByLabel('Ask the copilot').fill(`Log a note on ${company.display_name} saying ${marker}`);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText('Waiting for your approval').first()).toBeVisible({ timeout: 40_000 });
  await page.getByRole('button', { name: 'Approve and run' }).first().click();
  await expect(page.locator('.cp-answer').last().locator('.cp-resolution'))
    .toContainText('Approved and written', { timeout: 20_000 });

  const runId = await page.evaluate(async () =>
    ((await (await fetch('/api/v1/ai/runs?limit=1')).json()) as { data: { id: string }[] }).data[0].id);
  const detail = (await (await request.get(`/api/v1/ai/runs/${runId}`)).json()) as { trace: unknown[] };
  expect(detail.trace.length).toBeGreaterThan(0);

  await page.goto('/copilot/runs', { waitUntil: 'networkidle' });
  await page.waitForSelector('tbody tr');
  const headers = await page.locator('thead th').allInnerTexts();
  const stepsColumn = headers.findIndex((header) => header.trim().startsWith('Steps'));
  expect(stepsColumn).toBeGreaterThanOrEqual(0);
  const row = page.locator(`tbody tr:has-text("${marker}")`).first();
  await expect(row.locator('td').nth(stepsColumn)).toHaveText(String(detail.trace.length));

  await page.goto(`/copilot/runs/${runId}`, { waitUntil: 'networkidle' });
  await expect(page.locator('.ain-page__subtitle').first())
    .toContainText(`${detail.trace.length} step`);
});
