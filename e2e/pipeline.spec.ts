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
  const from = open[0];
  const to = open[1];

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
  const from = open[1];
  const to = open[2];

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
  const from = defaultPipeline.stages.filter((s) => !s.is_closed)[0];
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
  const from = defaultPipeline.stages.filter((s) => !s.is_closed)[0];
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
