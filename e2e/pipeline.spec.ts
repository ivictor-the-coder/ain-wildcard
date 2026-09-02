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
interface PipelineDef { name: string; label: string; is_default: boolean; open_amount?: number; stages: StageDef[] }

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

/**
 * Read JSON from the API, once the API is willing to answer.
 *
 * Every assertion below checks the server rather than the screen, so a refused
 * read is not a failing product — it is a failing question. The platform's
 * per-principal rate limiter is 600 requests a real minute and a 69-test suite
 * in one worker runs close to it, which used to surface as `undefined.find` and
 * "expected 5, received 0" on whichever test was unlucky. Asking again after a
 * moment is what the retry-after header is for.
 */
const getJson = async <T = unknown>(request: APIRequestContext, url: string): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request.get(url);
    if (response.ok()) return (await response.json()) as T;
    if (attempt >= 3) throw new Error(`${response.status()} ${url}: ${await response.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
  }
};

/** The same, for the writes and searches a test sets itself up with. */
const postJson = async <T = unknown>(
  request: APIRequestContext, url: string, data: unknown,
): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request.post(url, { data });
    if (response.ok()) return (await response.json()) as T;
    // Only a rate limit is worth repeating: a POST that failed for any other
    // reason may well have written something, and asking twice would write it
    // twice.
    if (attempt >= 3 || response.status() !== 429) {
      throw new Error(`${response.status()} ${url}: ${await response.text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
  }
};

/**
 * Open a screen and wait for the thing that proves it rendered.
 *
 * A page whose first reads were refused — the API's own per-principal rate
 * limiter is the usual one, and a suite of 69 tests in one worker runs close to
 * its ceiling — stays broken until something asks again: `useQuery` caches the
 * failure rather than retrying it. That produced a failure roughly once every
 * ten full runs, always on whichever test happened to be holding the page when
 * the bucket emptied, and a gate that cries wolf gets ignored. So a reload is
 * attempted twice, which is what a person would do; a screen that is genuinely
 * broken still fails, three times over.
 */
const visit = async (page: Page, path: string, selector: string) => {
  for (let attempt = 0; ; attempt += 1) {
    await page.goto(path, { waitUntil: 'networkidle' });
    try {
      await page.waitForSelector(selector, { timeout: 12_000 });
      return;
    } catch (e) {
      if (attempt >= 2) throw e;
      await page.waitForTimeout(3_000);
    }
  }
};

const board = async (page: Page, query = '') => visit(page, `/deals${query}`, '.pl-col');

/** The same board, as a table. */
const table = async (page: Page, query = '') =>
  visit(page, `/deals?display=table${query}`, 'tbody tr');

const pipelines = async (request: APIRequestContext): Promise<PipelineDef[]> =>
  (await getJson<{ data: PipelineDef[] }>(request, '/api/v1/pipelines/deal')).data;

const deal = async (request: APIRequestContext, id: string): Promise<DealRecord> =>
  getJson<DealRecord>(request, `/api/v1/records/deal/${id}`);

const findDeal = async (request: APIRequestContext, name: string): Promise<DealRecord | undefined> => {
  const list = await getJson<DealList>(request, `/api/v1/records/deal?q=${encodeURIComponent(name)}&limit=5`);
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
  const summary = (await getJson(request, '/api/v1/pipelines/deal')) as {
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
  const list = (await getJson(request, '/api/v1/records/deal?limit=1&sort=amount&order=desc')) as DealList;
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
  const list = (await getJson(request, '/api/v1/records/deal?limit=1')) as DealList;
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
    const timeline = (await getJson(request, `/api/v1/records/deal/${row.id}/timeline`)) as { data: { title: string }[] };
    return timeline.data.some((item) => item.title.includes(subject));
  }).toBe(true);
});

test('the stage rail moves the deal', async ({ page, request }) => {
  const list = (await getJson(request, '/api/v1/records/deal?limit=1')) as DealList;
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
  await visit(page, '/copilot?new=1', '.cp-suggest__item');

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
  const runs = await getJson<{ data: { id: string; thread_id: string | null }[] }>(
    request, '/api/v1/ai/runs?limit=25');
  let target: { thread_id: string; span: string } | null = null;
  for (const run of runs.data) {
    if (!run.thread_id) continue;
    const detail = await getJson<{ trace: { id: string; kind: string; args: Record<string, unknown> }[] }>(
      request, `/api/v1/ai/runs/${run.id}`);
    const span = detail.trace.find((s) => s.kind === 'tool' && Object.keys(s.args ?? {}).length > 0);
    if (span) { target = { thread_id: run.thread_id, span: span.id }; break; }
  }
  expect(target, 'no run in this workspace called a tool').not.toBeNull();

  // The trace panel fetches the run when it is opened, and a refused fetch
  // leaves it empty for good — so open it again rather than wait out a minute
  // on a panel that has already given up.
  for (let attempt = 0; ; attempt += 1) {
    await visit(page, `/copilot?thread=${target!.thread_id}`, '.cp-answer');
    for (const button of await page.getByRole('button', { name: /Show the .* behind this/ }).all()) {
      await button.click();
    }
    try {
      await page.waitForSelector('.cp-step', { timeout: 12_000 });
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      await page.waitForTimeout(3_000);
    }
  }

  // A tool step opens to the exact arguments the engine passed.
  const step = page.locator(`.cp-step[data-span="${target!.span}"]`);
  await expect(step).toBeVisible();
  await step.click();
  await expect(page.locator('.cp-step__detail .cp-code').first()).toBeVisible();
  await expect(page.locator('.cp-step__detail')).toContainText('Arguments');
});

test('the run log is the workspace’s own runs, and one opens to its full trace', async ({ page, request }) => {
  const runs = (await getJson(request, '/api/v1/ai/runs?limit=100')) as {
    data: { id: string; question: string }[]; total_count: number;
  };
  await visit(page, '/copilot/runs', 'table tbody tr[data-index]');
  expect(await page.locator('table tbody tr[data-index]').count()).toBe(runs.data.length);

  await page.locator('table tbody tr[data-index]').first().click();
  await page.waitForURL(/\/copilot\/runs\/run_/);
  await expect(page.locator('.cp-runfacts')).toContainText('ms');
  await expect(page.locator('.cp-step')).not.toHaveCount(0);
});

test('a write the copilot prepares stops at an approval card, and approving it runs it', async ({ page, request }) => {
  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });

  const company = (await getJson(request, '/api/v1/records/company?limit=1')) as
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
  const before = (await getJson(request, `/api/v1/records/company/${target.id}/timeline`)) as
    { data: { title: string; body: string | null }[] };
  expect(before.data.some((item) => (item.body ?? '').includes(marker))).toBe(false);

  await page.getByRole('button', { name: 'Approve and run' }).first().click();
  await expect.poll(async () => {
    const after = (await getJson(request, `/api/v1/records/company/${target.id}/timeline`)) as
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
  (await getJson<{ data: AssociationRow[] }>(
    request, `/api/v1/records/deal/${dealId}/associations?association_type=${type}`,
  )).data;

/** A deal that already has both an account and a committee, so both cards are live. */
const linkedDeal = async (request: APIRequestContext): Promise<DealRecord> => {
  const list = (await getJson(request, '/api/v1/records/deal?limit=20&expand=associations')) as {
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
  await table(page);

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

  await table(page);
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
  await table(page);
  await page.locator('tbody input[type="checkbox"]').nth(0).check();

  const name = (await page.locator('tbody tr').first().locator('td').nth(1).innerText()).trim();
  const before = await findDeal(request, name);

  const users = (await getJson<{ data: { id: string; name: string }[] }>(request, '/api/v1/users')).data;
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
    (await getJson(request, `/api/v1/records/deal/${target.id}/timeline`)) as never;

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
  // The day it books is stated, and editable, before the write. The picker
  // mounts empty and is filled on the dialog's own effect, so it is read once
  // it holds a date — reading it a frame early got "Pick a date", which
  // `Date.parse` turns into a RangeError three lines down.
  const stampField = dialog.getByRole('button', { name: 'Close date' });
  await expect(stampField).toHaveText(/\w+ \d{1,2}, \d{4}/);
  const stamp = (await stampField.innerText()).trim();
  await dialog.getByLabel('Close reason').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: 'Mark won' }).click();

  await expect.poll(async () => (await deal(request, id)).properties.deal_status, { timeout: 15_000 }).toBe('won');

  // The record the server settled on is what the screen has to read back. The
  // assertion used to race the page's own refresh and caught it mid-flight,
  // reading "Not set" out of a tile the write had not reached yet.
  const stored = Number((await deal(request, id)).properties.close_date);
  expect(new Date(stored).toISOString().slice(0, 10))
    .toBe(new Date(Date.parse(`${stamp} UTC`)).toISOString().slice(0, 10));

  await page.reload({ waitUntil: 'networkidle' });
  const closeFact = page.locator('.pl-fact').filter({ hasText: 'Close date' });
  await expect(closeFact).toContainText(stamp);
  await expect(closeFact).toContainText('today');

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

  // Its own deal, on its own name, rather than whichever card the board happens
  // to draw first: the two menus below are opened a second apart, and a
  // refetch that reorders the column between them used to make the second one
  // a different deal — or a detached element.
  const probe = await postJson<DealRecord>(request, '/api/v1/records/deal', {
    properties: {
      name: `Reason probe ${Date.now()}`,
      amount: 6_200_00,
      pipeline: defaultPipeline.name,
      deal_stage: defaultPipeline.stages.find((s) => !s.is_closed)!.name,
    },
  });

  await board(page);
  const card = page.locator(`.pl-card[data-deal="${probe.id}"]`);
  await card.scrollIntoViewIfNeeded();

  const reasonsFor = async (stage: StageDef): Promise<string[]> => {
    await card.locator('.pl-card__menu').click();
    await page.getByRole('menuitem').filter({ hasText: stage.label }).first().click();
    const picker = page.getByRole('dialog').getByLabel('Close reason');
    await expect(picker).toBeVisible();
    const options = await picker.locator('option').allInnerTexts();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    return options;
  };

  const winReasons = await reasonsFor(won);
  const lossReasons = await reasonsFor(lost);

  // Neither list is the whole enum, and no reason is offered for both outcomes.
  expect(winReasons.length).toBeGreaterThan(1);
  expect(lossReasons.length).toBeGreaterThan(1);
  const overlap = winReasons.filter((r) => r !== '— no close reason —' && lossReasons.includes(r));
  expect(overlap).toEqual([]);
  expect(lossReasons.join(' ')).toContain('Lost to competitor');
  expect(winReasons.join(' ')).not.toContain('Lost to competitor');

  await request.delete(`/api/v1/records/deal/${probe.id}`);
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
  const users = (await getJson<{ data: { id: string; name: string }[] }>(request, '/api/v1/users')).data;
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
  await table(page);
  for (let i = 0; i < 3; i++) await page.locator('tbody input[type="checkbox"]').nth(i).check();
  const stages = await page.locator('tbody tr').evaluateAll((rows) =>
    rows.slice(0, 3).map((row) => (row.querySelector('td:nth-child(4)')?.textContent ?? '').trim()));
  await page.getByRole('button', { name: 'Move stage' }).click();

  // A destination two of the three already sit in offers to move only the third.
  const repeated = stages.find((name) => stages.filter((s) => s === name).length > 1);
  if (repeated) {
    const item = page.getByRole('menuitem').filter({ hasText: repeated }).first();
    const moving = 3 - stages.filter((s) => s === repeated).length;
    // All three can sit in the same column — which sort order and which deals
    // the workspace holds decide that, not this test. A destination with
    // nothing to move says so in words rather than offering "0 deals".
    await expect(item).toContainText(
      moving === 0 ? 'All of them are here already' : moving === 1 ? '1 deal' : `${moving} deals`,
    );
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

/**
 * The rail is where a deal is moved one stage at a time, and the keyboard has
 * to survive the move.
 *
 * A move invalidates `/v1/records/deal`, and the stage the deal lands in used
 * to be drawn as a `disabled` button — so the browser dropped focus the instant
 * the record came back, and the caret fell to `<body>`, 31 Tab stops from this
 * deal. Moving deals one after another is the most repeated action on this
 * screen, so this is not a nicety.
 */
test('the keyboard lands on the destination stage after a move from the record rail', async ({ page, request }) => {
  const list = (await getJson(request, '/api/v1/records/deal?limit=40')) as DealList;
  const all = await pipelines(request);
  const row = list.data.find((deal) => {
    const own = all.find((p) => p.name === deal.properties.pipeline);
    return !!own && own.stages.some((s) => !s.is_closed && s.name !== deal.properties.deal_stage);
  })!;
  const startStage = row.properties.deal_stage as string;
  const own = all.find((p) => p.name === row.properties.pipeline)!;
  const target = own.stages.find((s) => !s.is_closed && s.name !== startStage)!;

  await page.goto(`/deals/${row.id}`, { waitUntil: 'networkidle' });
  const step = page.locator('.pl-rail__step', { hasText: target.label }).first();
  await step.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: `Move to ${target.label}` }).click();

  await expect.poll(async () => (await deal(request, row.id)).properties.deal_stage, { timeout: 10_000 }).toBe(target.name);
  // The stage it landed in is still a Tab stop, and the caret is on it — not on
  // `<body>`, which is where a `disabled` destination used to leave it.
  await expect.poll(async () => page.evaluate((label) => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !active.classList.contains('pl-rail__step')) return active?.tagName ?? 'nothing';
    return (active.textContent ?? '').includes(label) ? 'the destination stage' : 'another stage';
  }, target.label), { timeout: 10_000 }).toBe('the destination stage');

  await request.patch(`/api/v1/records/deal/${row.id}`, { data: { properties: { deal_stage: startStage } } });
});

/* =========================== copilot aftermath ============================ */

/**
 * The conversation is the thing a person re-reads a week later. It has to say
 * what happened, not what was planned.
 */
test('the conversation records what became of an approved write', async ({ page, request }) => {
  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  const company = (await getJson<{ data: { id: string; display_name: string }[] }>(
    request, '/api/v1/records/company?limit=1')).data[0];
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
  const company = (await getJson<{ data: { id: string; display_name: string }[] }>(
    request, '/api/v1/records/company?limit=1')).data[0];

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
  const runs = (await getJson<{ data: { id: string }[] }>(request, '/api/v1/ai/runs?limit=50')).data;
  const detailed = await Promise.all(runs.slice(0, 12).map((row) =>
    getJson<{ id: string; trace: { started: number }[] }>(request, `/api/v1/ai/runs/${row.id}`)));
  const target = detailed.find((row) => row.trace.length > 2) ?? detailed[0];

  await visit(page, `/copilot/runs/${target.id}`, '.cp-step');
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

  // Polled rather than slept on: the header's own height settles when the
  // status line arrives, and a fixed wait is a coin toss about whether it has.
  const ask = page.getByRole('button', { name: 'Ask', exact: true });
  await expect(ask).toBeVisible();
  await expect.poll(async () => {
    const box = await ask.boundingBox();
    return box ? Math.round(box.y + box.height) : Number.MAX_SAFE_INTEGER;
  }, { timeout: 10_000 }).toBeLessThanOrEqual(460);

  await expect.poll(
    async () => page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight),
    { timeout: 10_000 },
  ).toBeLessThanOrEqual(1);
});

/**
 * A deal opened on the wrong motion is a real thing that happens, and until now
 * only the API could fix it: the stage rail walks one pipeline and the edit form
 * leaves both fields alone because changing one without the other is refused.
 */
test('a deal can be moved onto another pipeline, stage and all', async ({ page, request }) => {
  const all = await pipelines(request);
  if (all.length < 2) test.skip();
  const list = (await getJson(request, '/api/v1/records/deal?limit=20')) as DealList;
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

  const list = (await getJson(request, '/api/v1/records/deal?limit=200&expand=associations')) as {
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
    (await getJson(request, `/api/v1/ai/threads/${created.id}`)) as { title: string; status: string };

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
    ((await getJson(request, '/api/v1/ai/threads?limit=100')) as { data: unknown[] }).data.length;
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
/**
 * The filter and the tiles read one set.
 *
 * This used to filter on whatever account the first row of the default board
 * happened to show, which made it a test of what the tests before it had left
 * behind: it starved when earlier tests churned the deals out from under it,
 * and it could pick a term that matched every row. It brings its own rows now,
 * and takes them away again.
 */
test('the table’s own filter moves the stat cards with it', async ({ page, request }) => {
  const defaultPipeline = (await pipelines(request)).find((p) => p.is_default)!;
  const marker = `Filter probe ${Date.now()}`;
  const made: string[] = [];
  for (const suffix of ['A', 'B']) {
    const row = await postJson<DealRecord>(request, '/api/v1/records/deal', {
      properties: {
        name: `${marker} ${suffix}`,
        amount: 111_000_00,
        pipeline: defaultPipeline.name,
        deal_stage: defaultPipeline.stages[0].name,
      },
    });
    made.push(row.id);
  }

  try {
    await table(page);
    await expect.poll(async () => page.locator('tbody tr').count(), { timeout: 20_000 }).toBeGreaterThan(2);
    const total = await page.locator('tbody tr').count();

    await page.getByRole('searchbox', { name: 'Search table rows' }).fill(marker);
    await expect.poll(async () => page.locator('tbody tr').count(), { timeout: 10_000 }).toBe(2);
    expect(total).toBeGreaterThan(2);

    const summary = page.locator('.pl-summary');
    await expect(summary).toContainText('filtered');
    const open = (await summary.locator('.ain-stat__value').first().innerText()).trim();
    const subtitle = await page.locator('.ain-page__subtitle').first().innerText();
    expect(subtitle).toContain(`${open} open`);
    expect(subtitle).toContain('2 deals');
  } finally {
    for (const id of made) await request.delete(`/api/v1/records/deal/${id}`);
  }
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
  const users = (await getJson<{ data: { id: string; name: string }[] }>(request, '/api/v1/users')).data;
  const owner = users[0];
  const views = async (): Promise<ViewRow[]> =>
    ((await getJson(request, '/api/v1/views?object_type=deal')) as { data: ViewRow[] }).data;
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
  const company = (await getJson<{ data: { id: string; display_name: string }[] }>(
    request, '/api/v1/records/company?limit=1')).data[0];
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
  const detail = (await getJson(request, `/api/v1/ai/runs/${runId}`)) as { trace: unknown[] };
  expect(detail.trace.length).toBeGreaterThan(0);

  await visit(page, '/copilot/runs', 'tbody tr');
  const headers = await page.locator('thead th').allInnerTexts();
  const stepsColumn = headers.findIndex((header) => header.trim().startsWith('Steps'));
  expect(stepsColumn).toBeGreaterThanOrEqual(0);
  const row = page.locator(`tbody tr:has-text("${marker}")`).first();
  await expect(row.locator('td').nth(stepsColumn)).toHaveText(String(detail.trace.length));

  await page.goto(`/copilot/runs/${runId}`, { waitUntil: 'networkidle' });
  await expect(page.locator('.ain-page__subtitle').first())
    .toContainText(`${detail.trace.length} step`);
});

/* ========================= what the board measures ========================= */

interface Velocity {
  stalled_records: number;
  stages: { stage: string; is_closed: boolean; stalled_records: number; stalled_after_days: number | null; current_records: number }[];
}

/**
 * Give a closed stage a stall threshold, which a fresh workspace does not have.
 *
 * `stalled_after_days` is twice the stage's own *median completed spell*, and a
 * spell in Closed won is only completed when a deal leaves it — which nothing
 * in the seed ever does. So on a freshly seeded workspace every closed stage
 * reports `stalled_after_days: null` and `stalled_records: 0`, and a test that
 * asserts a closed stage has stalled deals is asserting something only a
 * previously-mutated database happens to satisfy. That is worse than no test:
 * it passed here for weeks and could not be run from `--fresh`.
 *
 * So the condition is seeded rather than assumed. One deal already sitting in a
 * closed stage is bounced through the pipeline's other closed stage and back,
 * which leaves it exactly where it started and gives both closed stages a
 * completed spell — and therefore a threshold that the deals parked in them
 * have long since passed. Nothing else about the workspace changes: no deal is
 * created, no deal ends anywhere new, and no open stage gains a resident.
 */
const seedClosedStall = async (request: APIRequestContext, def: PipelineDef): Promise<Velocity> => {
  const closed = def.stages.filter((s) => s.is_closed);
  expect(closed.length, `${def.label} needs two closed stages to bounce a deal between`).toBeGreaterThan(1);

  const already = (await getJson<Velocity>(request, `/api/v1/pipelines/deal/${def.name}/velocity`))
    .stages.filter((s) => s.is_closed).reduce((n, s) => n + s.stalled_records, 0);
  if (already > 0) return getJson<Velocity>(request, `/api/v1/pipelines/deal/${def.name}/velocity`);

  const deals = await getJson<DealList>(request, `/api/v1/records/deal?limit=200`);
  const home = closed.find((stage) => deals.data.some(
    (row) => row.properties.pipeline === def.name && row.properties.deal_stage === stage.name));
  expect(home, `no deal sits in a closed stage of ${def.label}`).toBeTruthy();
  const victim = deals.data.find((row) => row.properties.pipeline === def.name && row.properties.deal_stage === home!.name)!;
  const away = closed.find((stage) => stage.name !== home!.name)!;

  const move = async (to: string) => {
    const response = await request.patch(`/api/v1/records/deal/${victim.id}`, { data: { properties: { deal_stage: to } } });
    expect(response.ok(), `${response.status()} moving ${victim.id} to ${to}`).toBe(true);
  };
  await move(away.name);
  await move(home!.name);

  const after = await getJson<Velocity>(request, `/api/v1/pipelines/deal/${def.name}/velocity`);
  const stage = after.stages.find((s) => s.stage === away.name);
  expect(stage?.stalled_after_days, `${away.label} still has no stall threshold after the bounce`).toBeGreaterThan(0);
  return after;
};

/**
 * A deal parked in Closed won has not stalled — it has finished.
 *
 * `/v1/pipelines/deal/:id/velocity` counts every record sitting in its stage
 * for longer than that stage's own threshold, and a closed stage has one like
 * any other. The tile quoted that number whole, so the board reported more
 * stalled deals than it had open deals, and the moment any filter was applied
 * it dropped to the open-stage figure — the same tile answering two questions.
 *
 * The cards had the same bug and kept it after the tile was fixed: every card
 * in Closed won read "72 days in stage · stalls after 3" under a column header
 * that reported no stalled deals at all.
 */
test('the stalled tile and cards count only the deals that can still stall', async ({ page, request }) => {
  const defs = await pipelines(request);
  const def = defs.find((p) => p.is_default) ?? defs[0];
  const velocity = await seedClosedStall(request, def);

  const openStalled = velocity.stages.filter((s) => !s.is_closed).reduce((n, s) => n + s.stalled_records, 0);
  const closedStalled = velocity.stages.filter((s) => s.is_closed).reduce((n, s) => n + s.stalled_records, 0);
  // The gap between the two is what this test exists to catch, and it is now
  // seeded rather than hoped for.
  expect(closedStalled).toBeGreaterThan(0);

  await board(page, `?pipeline=${def.name}`);
  const tile = page.locator('.pl-summary .ain-stat').nth(3);
  await expect(tile).toContainText('Stalled');
  // A stat reading "—" has measured nothing: the velocity read behind it was
  // refused, and no amount of waiting turns that into a number — only asking
  // again does. A wrong number still fails, which is the point of the test.
  await expect.poll(async () => {
    const shown = (await tile.locator('.ain-stat__value').innerText()).trim();
    if (shown === '—') await board(page, `?pipeline=${def.name}`);
    return shown;
  }, { timeout: 30_000 }).toBe(String(openStalled));

  // And the closed columns never claim a stalled deal of their own — neither in
  // the header nor on any card standing in them.
  await board(page, `?pipeline=${def.name}&closed=1`);
  for (const stage of def.stages.filter((s) => s.is_closed)) {
    const column = page.locator(`.pl-col[data-stage="${stage.name}"]`);
    await expect(column).not.toContainText('stalled');
    await expect(column).not.toContainText('stalls after');
  }

  // The open columns still badge theirs, so this is not passing by showing
  // nothing anywhere.
  const stalledStage = velocity.stages.find((s) => !s.is_closed && s.stalled_records > 0);
  if (stalledStage) {
    await expect(page.locator(`.pl-col[data-stage="${stalledStage.stage}"]`)).toContainText('stalls after');
  }
});

/**
 * "Closing within 30 days" has to mean the next 30 days.
 *
 * Both close-date windows were open at the bottom, so a deal whose close date
 * passed months ago counted as closing within 30 days, as closing this quarter,
 * and as past its close date, all at once — and none of that agreed with what
 * saving the board as a view actually stored (`close_date between today and
 * +30d`), so a view read back showed a different set than the board it came from.
 */
test('a close date that has already passed is not "closing within 30 days"', async ({ page, request }) => {
  const defs = await pipelines(request);
  const def = defs.find((p) => p.is_default) ?? defs[0];
  const stage = def.stages.find((s) => !s.is_closed)!;
  const created = (await (await request.post('/api/v1/records/deal', {
    data: {
      properties: {
        name: `Horizon check — long overdue ${Date.now()}`,
        amount: 4_100_00,
        pipeline: def.name,
        deal_stage: stage.name,
        close_date: Date.now() - 200 * 86_400_000,
      },
    },
  })).json()) as DealRecord;

  const card = (query: string) =>
    page.locator(`.pl-card[data-deal="${created.id}"]`).describe(query);

  // The board has finished when it has drawn either its columns or the empty
  // state; asserting a card is absent before that would pass without looking.
  const settled = async (horizon: string) => {
    await page.goto(`/deals?pipeline=${def.name}${horizon}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.pl-board, .ain-empty');
  };

  await settled('');
  await expect(card('any close date')).toHaveCount(1);

  await settled('&horizon=overdue');
  await expect(card('past its close date')).toHaveCount(1);

  await settled('&horizon=30');
  await expect(card('closing within 30 days')).toHaveCount(0);

  await settled('&horizon=quarter');
  await expect(card('closing this quarter')).toHaveCount(0);

  // It is taken away again. Left on the board it is a deal with a close date
  // 200 days behind us and a name saying so, sitting in an open stage where
  // any later test that closes a card off the board restamps it to today —
  // which puts "long overdue" inside the six-week window and fails the card
  // test 700 lines below for a product behaviour that is correct.
  await request.delete(`/api/v1/records/deal/${created.id}`);
});

/* ================================== undo ================================== */

/**
 * A drop commits the moment the pointer is released, so the way back travels
 * with the notification. Undo is not a local rewind: it PATCHes the deal back
 * to the stage it came from, and the server is asked whether it landed.
 */
test('a stage move can be undone from the notification it lands with', async ({ page, request }) => {
  const defs = await pipelines(request);
  const def = defs.find((p) => p.is_default) ?? defs[0];
  const open = def.stages.filter((s) => !s.is_closed);
  await board(page, `?pipeline=${def.name}`);

  const from = await stageWithACard(page, open);
  const id = (await cardsIn(page, from.name).first().getAttribute('data-deal'))!;
  const to = open.find((s) => s.name !== from.name)!;

  await dragCardTo(page, id, to.name);
  await expect.poll(async () => (await deal(request, id)).properties.deal_stage, { timeout: 10_000 })
    .toBe(to.name);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await deal(request, id)).properties.deal_stage, { timeout: 10_000 })
    .toBe(from.name);
  const back = await deal(request, id);
  expect(back.properties.probability).toBe(from.probability);
});

/**
 * Closing a deal writes more than a stage — a close date, an outcome reason —
 * and undo has to put all of it back, not just the column the card sits in.
 */
test('undoing a close puts the close date and the reason back too', async ({ page, request }) => {
  const defs = await pipelines(request);
  const def = defs.find((p) => p.is_default) ?? defs[0];
  const won = def.stages.find((s) => s.is_won)!;
  const open = def.stages.filter((s) => !s.is_closed);
  await board(page, `?pipeline=${def.name}&closed=1`);

  const from = await stageWithACard(page, open);
  const id = (await cardsIn(page, from.name).first().getAttribute('data-deal'))!;
  const before = await deal(request, id);

  await dragCardTo(page, id, won.name);
  await expect(page.getByRole('dialog')).toBeVisible();
  const reason = page.getByRole('dialog').getByLabel('Close reason');
  await reason.selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Mark won' }).click();

  await expect.poll(async () => (await deal(request, id)).properties.deal_status, { timeout: 10_000 })
    .toBe('won');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await deal(request, id)).properties.deal_stage, { timeout: 10_000 })
    .toBe(from.name);
  const after = await deal(request, id);
  expect(after.properties.deal_status).toBe('open');
  expect(after.properties.close_reason ?? null).toBe(before.properties.close_reason ?? null);
  expect(after.properties.close_date ?? null).toBe(before.properties.close_date ?? null);
  expect(after.properties.closed_at ?? null).toBe(null);
});

/* ======================== editing where you read =========================== */

/**
 * Correcting one field should cost one click, not a modal holding eleven.
 */
test('a deal property is corrected where it is read, and the server keeps it', async ({ page, request }) => {
  await board(page);
  const card = page.locator('.pl-card').first();
  const id = (await card.getAttribute('data-deal'))!;
  await card.locator('.pl-card__name').click();
  await page.waitForSelector('.pl-proplist');

  const row = page.getByRole('button', { name: /^Edit Next step/ });
  await row.scrollIntoViewIfNeeded();
  await row.click();

  const wanted = `Send the security questionnaire ${Date.now()}`;
  const input = page.getByLabel('Next step', { exact: true });
  await input.fill(wanted);
  await input.press('Enter');

  await expect.poll(async () => (await deal(request, id)).properties.next_step, { timeout: 10_000 })
    .toBe(wanted);
  await expect(page.getByRole('button', { name: /^Edit Next step/ })).toBeVisible();
});

/** Every type gets the control it asks for, not a text box for all of them. */
test('an inline editor is the one the property type asks for', async ({ page }) => {
  await board(page);
  await page.locator('.pl-card__name').first().click();
  await page.waitForSelector('.pl-proplist');

  await page.getByRole('button', { name: /^Edit Amount/ }).click();
  // A currency is money in the workspace's own currency, never raw minor units.
  await expect(page.getByLabel('Amount', { exact: true })).toHaveAttribute('inputmode', /decimal|numeric/);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /^Edit Deal type/ }).click();
  await expect(page.getByLabel('Deal type', { exact: true })).toHaveRole('combobox');
  await page.keyboard.press('Escape');

  // The two properties a stage move owns are not edited in place: writing them
  // restamps the probability and the forecast category, so they keep their
  // confirmation and this row points at it.
  await expect(page.getByRole('button', { name: /^Edit Stage/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move to another stage' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move to another pipeline' })).toBeVisible();
});

/**
 * A refusal from the server lands under the field that caused it, and the
 * value on the record does not move.
 */
test('an inline edit the server refuses says so under the field', async ({ page, request }) => {
  await board(page);
  const card = page.locator('.pl-card').first();
  const id = (await card.getAttribute('data-deal'))!;
  const before = await deal(request, id);
  await card.locator('.pl-card__name').click();
  await page.waitForSelector('.pl-proplist');

  await page.getByRole('button', { name: /^Edit Deal name/ }).click();
  const input = page.getByLabel('Deal name', { exact: true });
  await input.fill('');
  await input.press('Enter');

  await expect(page.locator('.pl-inline__error')).toBeVisible();
  expect((await deal(request, id)).properties.name).toBe(before.properties.name);
});

/* ==================== the run log's own filters ============================ */

/**
 * The feature menu was built from the rows the server had already filtered by
 * feature, so choosing one deleted every other option from the menu that chose
 * it. The catalogue comes from `/v1/ai/usage`, which counts runs by feature
 * whatever the list is showing.
 */
test('the run log keeps every feature in the menu that filters by it', async ({ page, request }) => {
  await request.post('/api/v1/ai/complete', {
    data: { prompt: 'What is our open pipeline?', feature: 'agent' },
  });
  const usage = (await getJson(request, '/api/v1/ai/usage?days=365')) as {
    by_feature: { key: string }[];
  };
  const features = usage.by_feature.map((row) => row.key);
  expect(features.length).toBeGreaterThan(1);

  await visit(page, '/copilot/runs?feature=agent', 'tbody tr');
  const menu = page.getByLabel('Feature', { exact: true });
  const offered = await menu.locator('option').allInnerTexts();
  // The menu writes a key as the label a person reads — `record_summary` is
  // offered as "Record summary" — so the two are compared in one shape rather
  // than raw, which passed only for as long as every feature key was one word.
  const readable = (key: string) => key.replace(/[_-]+/g, ' ').trim().toLowerCase();
  const offeredNames = offered.map(readable);
  for (const name of features) {
    expect(offeredNames, `the menu should offer ${name}`).toContain(readable(name));
  }

  // And it is still a working control: switching back is one choice, not a
  // round trip through "every feature".
  await menu.selectOption('copilot');
  await expect.poll(async () => new URL(page.url()).searchParams.get('feature')).toBe('copilot');
});

/**
 * A trace answers "why did it say that"; the next question is always "does it
 * still say that". Asking again starts a new run against today's data — it is
 * not a replay, and the button does not pretend to be one.
 */
test('a run can be put to the engine again from its own trace', async ({ page, request }) => {
  const log = (await getJson(request, '/api/v1/ai/runs?limit=20')) as {
    data: { id: string; question: string }[];
  };
  const run = log.data.find((row) => row.question.trim().length > 0)!;

  await page.goto(`/copilot/runs/${run.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Ask it again' }).click();

  await page.waitForURL(/\/copilot/, { timeout: 10_000 });
  await expect(page.getByRole('textbox', { name: 'Ask the copilot' })).toHaveValue(run.question);
  // A fresh conversation, not an edit of the one the run came from.
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeEnabled();
});

/* ================= what the numbers on screen are counting ================= */

/** The workspace runs in en-US/USD; the screen formats through the same rules. */
const money = (minor: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);

const searchDeals = async (request: APIRequestContext, filter: unknown): Promise<DealList> =>
  postJson<DealList>(request, '/api/v1/records/deal/search', {
    filter, sort: [{ property: 'close_date', direction: 'asc' }], limit: 200,
  });

const sumAmounts = (rows: DealRecord[]): number =>
  rows.reduce((total, row) => total + Number(row.properties.amount ?? 0), 0);

/** Open, closing inside six weeks — the set the dashboard card claims to quote. */
const OPEN_IN_SIX_WEEKS = {
  op: 'and',
  filters: [
    { property: 'deal_status', operator: 'eq', value: 'open' },
    { property: 'close_date', operator: 'between', values: ['today', '+42d'] },
  ],
};

/** Open, and the close date has already gone by. Not commit, whatever it says. */
const OPEN_OVERDUE = {
  op: 'and',
  filters: [
    { property: 'deal_status', operator: 'eq', value: 'open' },
    { property: 'close_date', operator: 'before', value: 'today' },
  ],
};

const closingSoonCard = (page: Page) =>
  page.locator('.ain-card').filter({ hasText: 'Closing in the next six weeks' }).first();

/**
 * The dashboard, with the six-week card actually holding numbers.
 *
 * The card retries a refused read itself and then renders its own error state
 * with a retry button rather than a blank space — so when the suite has drained
 * the API's request budget, press the button the product offers instead of
 * reporting a defect it does not have.
 */
const dashboard = async (page: Page) => {
  await visit(page, '/', '.ain-card');
  const card = closingSoonCard(page);
  const caption = card.locator('.ain-card__desc').first();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await expect(caption).toContainText('across', { timeout: 15_000 });
      return card;
    } catch (e) {
      const retry = card.getByRole('button', { name: 'Try again' });
      if (attempt === 3 || !(await retry.count())) throw e;
      await retry.click();
    }
  }
  return card;
};

/**
 * The card totalled the six rows it had room to draw and captioned the result
 * as the six-week number — $1.87M where the window really held $4.84M. The
 * money and the count belong to the matching set; the cap belongs in the words.
 */
test('the six-week commit card totals the window, not the rows it draws', async ({ page, request }) => {
  const matching = await searchDeals(request, OPEN_IN_SIX_WEEKS);
  expect(matching.data.length, 'the window has to overflow the card for this to mean anything')
    .toBeGreaterThan(6);

  const card = await dashboard(page);
  const caption = card.locator('.ain-card__desc').first();
  await expect(caption).toContainText(`across ${matching.data.length} deals`);
  await expect(caption).toContainText(money(sumAmounts(matching.data)));

  // …and it says how much of that it is showing, rather than implying it is all.
  await expect(card.locator('.pl-widgetrow')).toHaveCount(6);
  await expect(caption).toContainText('showing 6');
});

/**
 * "Next six weeks" has a floor. Four of the six rows the card used to draw were
 * badged overdue, and $1.08M of the figure it quoted was already past due.
 */
test('deals past their close date are counted apart from six-week commit', async ({ page, request }) => {
  const overdue = await searchDeals(request, OPEN_OVERDUE);
  expect(overdue.data.length, 'this workspace has no overdue deals to separate').toBeGreaterThan(0);

  const card = await dashboard(page);

  // Nothing under a "next six weeks" heading has a close date behind us. Asked
  // of the two sets the server itself returns, not of the rows' rendered text:
  // matching the word "overdue" anywhere in a row failed on any deal whose
  // *name* contained it, and this suite creates one.
  const drawn = (await card.locator('.pl-widgetrow__title').allInnerTexts()).map((t) => t.trim());
  expect(drawn.length).toBeGreaterThan(0);
  const pastDue = new Set(overdue.data.map((row) => row.display_name));
  expect(drawn.filter((name) => pastDue.has(name))).toEqual([]);

  // They are still counted — on their own line, in their own words.
  const line = card.locator('.pl-widgetmore--warn');
  await expect(line).toContainText(`${overdue.data.length} open deals`);
  await expect(line).toContainText(money(sumAmounts(overdue.data)));
});

/** The card's button has to land on the window the card counted, not another one. */
test('the card opens the board on the same six-week window it quoted', async ({ page }) => {
  const card = await dashboard(page);
  await card.getByRole('button', { name: 'Open the board' }).click();

  await page.waitForSelector('.pl-col');
  await expect(page.getByLabel('Close date')).toHaveValue('42');
  await expect(page.locator('.pl-summary')).toContainText('filtered');
});

/* ===================== keyboard saves on inline editors ==================== */

/**
 * The hint under an inline editor reads "Enter saves". For every numeric type
 * it did not: the editor closed, no PATCH left the page, and the typed amount
 * was gone. Only free text committed.
 */
test('Enter saves an inline money edit, which is what the hint promises', async ({ page, request }) => {
  await board(page);
  const card = page.locator('.pl-card').first();
  const id = (await card.getAttribute('data-deal'))!;
  await card.locator('.pl-card__name').click();
  await page.waitForSelector('.pl-proplist');

  const before = Number((await deal(request, id)).properties.amount ?? 0);
  const wanted = before + 123_400;

  await page.getByRole('button', { name: /^Edit Amount/ }).click();
  await expect(page.locator('.pl-inline__hint')).toContainText('Enter saves');
  const input = page.getByLabel('Amount', { exact: true });
  await input.fill(String(wanted / 100));
  await input.press('Enter');

  await expect.poll(async () => Number((await deal(request, id)).properties.amount), { timeout: 10_000 })
    .toBe(wanted);

  await request.patch(`/api/v1/records/deal/${id}`, { data: { properties: { amount: before } } });
});

/** The same keystroke, on a plain number rather than money. */
test('Enter saves an inline number edit too', async ({ page, request }) => {
  await board(page);
  const card = page.locator('.pl-card').first();
  const id = (await card.getAttribute('data-deal'))!;
  const before = (await deal(request, id)).properties.contract_term_months ?? null;
  await card.locator('.pl-card__name').click();
  await page.waitForSelector('.pl-proplist');

  const row = page.getByRole('button', { name: /^Edit Term \(months\)/ });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  const input = page.getByLabel('Term (months)', { exact: true });
  await input.fill('37');
  await input.press('Enter');

  await expect.poll(async () => (await deal(request, id)).properties.contract_term_months, { timeout: 10_000 })
    .toBe(37);

  await request.patch(`/api/v1/records/deal/${id}`, { data: { properties: { contract_term_months: before } } });
});

/* ========================= where the caret lands ========================== */

/**
 * A dialog whose first focusable node is its own close button eats the first
 * Space of whatever you type into it — and takes the dialog with it.
 */
test('the save-view dialog opens with the caret in the name field', async ({ page }) => {
  await board(page);
  await page.getByRole('button', { name: 'Views' }).click();
  await page.getByRole('menuitem', { name: 'Save this board as a view…' }).click();

  const field = page.getByLabel('View name');
  await expect(field).toBeFocused();

  // Typing straight away has to reach the field. A Space landing on Close
  // dismissed the dialog and lost everything typed before it.
  await page.keyboard.type('Monday forecast call');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(field).toHaveValue('Monday forecast call');
  await page.keyboard.press('Escape');
});

test('the draft dialog opens with the caret in its first field', async ({ page }) => {
  await page.goto('/copilot?draft=1', { waitUntil: 'networkidle' });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'About which deal' })).toBeFocused();
  await page.keyboard.press('Escape');
});

/**
 * The form the draft replaces is unmounted when it lands, so the caret fell to
 * `<body>` with an editable subject, an editable body and two actions on screen.
 */
test('the caret follows the draft onto its subject line', async ({ page, request }) => {
  const target = await linkedDeal(request);
  await page.goto(`/deals/${target.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Move stage' }).click();
  await page.getByRole('menuitem', { name: 'Draft a follow-up' }).click();
  await page.getByRole('button', { name: 'Write the draft' }).click();

  const subject = page.getByRole('textbox', { name: 'Subject' });
  await expect(subject).toBeVisible({ timeout: 30_000 });
  await expect(subject).toBeFocused();
  await page.keyboard.press('Escape');
});

/**
 * A close through the confirmation usually ends with the card nowhere on the
 * board, so the refocus that follows a card had nothing to land on and the
 * keyboard fell to `<body>` — 25 Tab stops from anything on the page.
 */
test('the keyboard lands somewhere after a close through the dialog', async ({ page, request }) => {
  const defaultPipeline = (await pipelines(request)).find((p) => p.is_default)!;
  const lost = defaultPipeline.stages.find((s) => s.is_closed && !s.is_won)!;
  const created = await postJson<DealRecord>(request, '/api/v1/records/deal', {
    properties: {
      name: `Focus probe ${Date.now()}`,
      amount: 4_500_00,
      pipeline: defaultPipeline.name,
      deal_stage: defaultPipeline.stages[0].name,
    },
  });

  await board(page);
  const card = page.locator(`.pl-card[data-deal="${created.id}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('.pl-card__menu').click();
  await page.getByRole('menuitem').filter({ hasText: lost.label }).first().click();

  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Close reason').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: /^Mark closed$/ }).click();

  await expect.poll(async () => (await deal(request, created.id)).properties.deal_status, { timeout: 15_000 })
    .toBe('lost');

  await expect.poll(async () => page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return 'body';
    return active.closest('.pl-col')?.getAttribute('data-stage')
      ?? active.getAttribute('data-stage')
      ?? active.tagName.toLowerCase();
  }), { timeout: 10_000 }).not.toBe('body');

  await request.delete(`/api/v1/records/deal/${created.id}`);
});

/* ============================ undo, everywhere ============================ */

/**
 * Every stage move on this board offers a way back. A bulk reassignment wrote
 * the same number of records and offered none, so three deals handed to the
 * wrong rep meant finding and fixing three records one at a time.
 */
test('a bulk reassignment can be undone from the notification it lands with', async ({ page, request }) => {
  await table(page);
  const boxes = page.locator('tbody input[type="checkbox"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();

  const names: string[] = [];
  for (const row of await page.locator('tbody tr').all()) {
    const box = row.locator('input[type="checkbox"]');
    if (await box.count() && await box.isChecked()) names.push((await row.locator('td').nth(1).innerText()).trim());
  }
  expect(names.length).toBe(2);
  const before = await Promise.all(names.map((name) => findDeal(request, name)));

  const users = (await getJson<{ data: { id: string; name: string }[] }>(request, '/api/v1/users')).data;
  const next = users.find((user) => before.every((row) => row?.owner_id !== user.id))!;

  await page.getByRole('button', { name: 'Reassign' }).click();
  await page.getByLabel('New owner').selectOption(next.id);
  await page.getByRole('button', { name: 'Reassign', exact: true }).last().click();

  await expect.poll(async () => {
    const rows = await Promise.all(names.map((name) => findDeal(request, name)));
    return rows.every((row) => row?.owner_id === next.id);
  }, { timeout: 15_000 }).toBe(true);

  await page.getByRole('button', { name: 'Undo' }).click();

  await expect.poll(async () => {
    const rows = await Promise.all(names.map((name) => findDeal(request, name)));
    return names.every((name, i) => rows[i]?.owner_id === (before[i]?.owner_id ?? null));
  }, { timeout: 15_000 }).toBe(true);
});

/* ====================== picking the right person ========================= */

/**
 * The picker searched the whole workspace with no bias toward the deal's own
 * account, so on the screen whose job is naming the people who have to say yes,
 * one ArrowDown and Enter linked a stranger from another company.
 */
test('the buying-committee picker offers the deal’s own account first', async ({ page, request }) => {
  const target = await linkedDeal(request);
  const account = (await associations(request, target.id, 'deal_to_company'))[0];
  const onAccount = (await getJson<{ data: { id: string; display_name: string }[] }>(
    request, `/api/v1/records/contact?associated_to=${account.record_id}&limit=20`,
  )).data;
  const linked = new Set((await associations(request, target.id, 'deal_to_contact')).map((row) => row.record_id));
  const offerable = onAccount.filter((row) => !linked.has(row.id));
  expect(offerable.length, 'this account has no unlinked contacts to rank').toBeGreaterThan(0);

  await page.goto(`/deals/${target.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('combobox', { name: 'Contacts' }).click();
  await expect(page.getByRole('option').first()).toBeVisible({ timeout: 15_000 });

  // The list leads with the account, under a heading that says so…
  await expect(page.getByText(`On ${account.display_name}`)).toBeVisible();
  // …and the row one ArrowDown reaches is one of that account's own people.
  const first = (await page.getByRole('option').first().innerText()).trim();
  expect(offerable.some((row) => first.startsWith(row.display_name))).toBe(true);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});

/* ==================== the answer, and only the answer ==================== */

/**
 * The engine may append the raw result of any tool it did not fully spend.
 * Printed as prose under a finished answer — one display label and two internal
 * names in the same bullet list — that reads like a debug console nobody
 * deleted, so the screen splits it off. What the tools returned stays reachable,
 * named for what it is; the prose stays prose. (The shape of the split itself is
 * pinned by the unit tests in `tests/pipeline.test.ts`.)
 */
test('an answer reads as an answer, not as a console dump under one', async ({ page }) => {
  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  const composer = page.getByRole('textbox', { name: 'Ask the copilot' });
  await composer.fill('What is our open pipeline by stage?');
  await composer.press('Enter');

  const answer = page.locator('.cp-answer').last();
  await expect(answer).toContainText('open pipeline', { timeout: 30_000 });
  // The by-stage figures no longer stand in the prose at all: they are lifted
  // out and checked against the board's own columns, so what is on screen is
  // either a reconciled list or the disagreement. Either way the answer has
  // more than a single sentence in it.
  await expect(
    answer.locator('.cp-breakdown__list, .ain-banner--warning').first(),
  ).toBeVisible({ timeout: 30_000 });
  // The answer is typed out; nothing about the prose can be judged until the
  // caret that marks the reveal in progress is gone.
  await expect(answer.locator('.cp-answer__caret')).toHaveCount(0, { timeout: 30_000 });

  const body = answer.locator('.cp-answer__body');
  await expect(body).not.toContainText('also returned');

  // Nor the other shape the same leak takes: a closing paragraph telling a
  // sales manager that a named internal capability "carries no field I can name
  // to you", that printing it "would put primary keys and column names in front
  // of you", and to go and read a trace — on a run whose own trace records that
  // same capability returning three rows. Whatever ran without contributing is
  // recorded beside the answer, not asserted inside it.
  await expect(body).not.toContainText('could not read anything back');
  await expect(body).not.toContainText('primary keys');
  await expect(body).not.toContainText('run’s trace');
  await expect(body).not.toContainText("run's trace");

  const echo = answer.locator('.cp-echo');
  if (await echo.count()) {
    await expect(echo).toContainText('not used in the answer');
    await echo.locator('summary').click();
    await expect(echo.locator('.cp-echo__body')).not.toHaveText('');
  }
});

/* ===================== every pipeline on one board ======================== */

/**
 * The dashboard counts across pipelines; the board could only ever draw one.
 *
 * So the six-week card read "$3,636,580.00 across 14 deals" and its own link
 * opened a board headed "7 deals on New business" — the number was right and
 * the only screen offered to explain it showed half of it.
 */
test('the six-week card opens a board holding every deal it counted', async ({ page, request }) => {
  const matching = await searchDeals(request, OPEN_IN_SIX_WEEKS);
  const card = await dashboard(page);
  await expect(card.locator('.ain-card__desc').first()).toContainText(`across ${matching.data.length} deals`);

  await card.getByRole('button', { name: 'Open the board' }).click();
  await page.waitForSelector('.pl-col');

  await expect(page.getByLabel('Pipeline')).toHaveValue('all');
  await expect(page.getByLabel('Close date')).toHaveValue('42');
  // The board's own header counts the same deals the card counted.
  await expect(page.locator('.ain-page__subtitle, header p').first())
    .toContainText(`${matching.data.length} deals`);
  await expect(page.locator('.pl-summary')).toContainText(money(sumAmounts(matching.data)));
});

test('the board can hold every pipeline at once, each with its own stages', async ({ page, request }) => {
  const defs = await pipelines(request);
  expect(defs.length, 'this workspace has only one pipeline, so there is nothing to hold at once')
    .toBeGreaterThan(1);

  await board(page, '?pipeline=all');
  // One strip per pipeline, named as the workspace names it.
  const strips = page.locator('.pl-strip__name');
  await expect(strips).toHaveCount(defs.length);
  for (const def of defs) await expect(strips.filter({ hasText: def.label })).toHaveCount(1);

  // …and a stage two pipelines both call `qualification` internally is drawn
  // once per pipeline, under each pipeline's own label for it.
  const keys = await page.$$eval('.pl-col', (els) => els.map((e) => `${e.getAttribute('data-pipeline')}/${e.getAttribute('data-stage')}`));
  expect(new Set(keys).size).toBe(keys.length);
  const open = defs.reduce((n, def) => n + def.stages.filter((s) => !s.is_closed).length, 0);
  expect(keys.length).toBe(open);

  // Narrowing back to one pipeline is one click from the strip that names it.
  await page.getByRole('button', { name: `Only ${defs[1].label}` }).click();
  await expect.poll(async () => new URL(page.url()).searchParams.get('pipeline')).toBe(defs[1].name);
  await expect(page.locator('.pl-strip')).toHaveCount(1);
});

/* ========================= where the caret lands ========================== */

/**
 * Three dialogs opened with the caret on their own × Close button, so the first
 * keystroke dismissed them. The close-won one is the worst of the three: it
 * gathers a *required* close reason, and Space or Enter on landing threw the
 * dialog away instead of answering it.
 */
test('a closing dialog opens on the field it needs, not on its dismiss button', async ({ page, request }) => {
  const defaultPipeline = (await pipelines(request)).find((p) => p.is_default)!;
  const won = defaultPipeline.stages.find((s) => s.is_won)!;
  const created = await postJson<DealRecord>(request, '/api/v1/records/deal', {
    properties: {
      name: `Caret probe ${Date.now()}`,
      amount: 7_300_00,
      pipeline: defaultPipeline.name,
      deal_stage: defaultPipeline.stages[0].name,
    },
  });

  await board(page);
  const card = page.locator(`.pl-card[data-deal="${created.id}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('.pl-card__menu').click();
  await page.getByRole('menuitem').filter({ hasText: won.label }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Close reason')).toBeFocused();

  await page.keyboard.press('Escape');
  await request.delete(`/api/v1/records/deal/${created.id}`);
});

test('the bulk reassign dialog opens on the owner picker and hands the keyboard back', async ({ page }) => {
  await table(page);
  const boxes = page.locator('tbody input[type="checkbox"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();

  await page.getByRole('button', { name: 'Reassign' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('New owner')).toBeFocused();

  const owners = await dialog.getByLabel('New owner').locator('option').evaluateAll(
    (options) => options.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
  );
  await dialog.getByLabel('New owner').selectOption(owners[0]);
  await dialog.getByRole('button', { name: 'Reassign', exact: true }).click();

  // The bar that held the trigger is gone with the selection it described, so
  // restoring focus to it lands on `<body>` — 49 Tab presses from anything.
  await expect.poll(async () => page.evaluate(() => (
    !document.activeElement || document.activeElement === document.body ? 'body' : 'somewhere'
  )), { timeout: 10_000 }).toBe('somewhere');
});

test('the copilot puts the caret where you type, on arrival and after an answer', async ({ page }) => {
  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  const composer = page.getByRole('textbox', { name: 'Ask the copilot' });
  await expect(composer).toBeFocused();

  await composer.fill('How many open deals do we have?');
  await composer.press('Enter');
  await expect(page.locator('.cp-answer').last()).toContainText('deal', { timeout: 30_000 });

  // The composer is cleared and re-rendered as the turn lands, which used to
  // drop the caret onto the document.
  await expect.poll(async () => page.evaluate(() => (
    !document.activeElement || document.activeElement === document.body ? 'body' : 'somewhere'
  )), { timeout: 15_000 }).toBe('somewhere');
});

/* ===================== the scope an answer was measured at ================= */

/** Ask the copilot one question in a fresh thread and wait for the answer. */
/** Ask, and return as soon as there is prose — before the scope row settles. */
const askCopilotUnchecked = async (page: Page, question: string) => {
  // Not `networkidle`: this one exists to watch the gap between the answer and
  // the reads it is captioned with, and waiting for the network to go quiet
  // waits out the very gap under test.
  await page.goto('/copilot?new=1', { waitUntil: 'domcontentloaded' });
  const composer = page.getByRole('textbox', { name: 'Ask the copilot' });
  await composer.fill(question);
  await composer.press('Enter');
  const answer = page.locator('.cp-answer').last();
  await expect(answer.locator('.cp-answer__body')).not.toBeEmpty({ timeout: 40_000 });
  return answer;
};

/**
 * Whether the workspace vocabulary behind the scope row actually loaded.
 *
 * Every claim the scope row makes is read through the pipelines, teammates and
 * metric catalogue. When those reads fail — the platform's rate limiter fires
 * on a long suite — the card says so in its own words and checks nothing, and a
 * test that then asserts a scope claim is asserting against a surface that has
 * correctly declined to make one.
 */
const scopeIsChecked = async (answer: ReturnType<Page['locator']>): Promise<boolean> =>
  (await answer.locator('.cp-scope__chip', { hasText: 'could not be read' }).count()) === 0
  && (await answer.locator('.ain-banner', { hasText: 'The scope of this answer was not checked' }).count()) === 0;

/**
 * The same, having given the failed reads another go first.
 *
 * The platform's rate limiter is 600 requests a real minute and this suite runs
 * close to it in one worker, so the four vocabulary reads behind the scope row
 * are the ones that get refused. Reloading the thread asks again — the same
 * thing the API helpers above do with `getJson` — and only a workspace that
 * will not answer at all is a reason to skip.
 */
const scopeWasChecked = async (page: Page, answer: ReturnType<Page['locator']>): Promise<boolean> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await scopeIsChecked(answer)) return true;
    await page.waitForTimeout(3_000 * (attempt + 1));
    await page.reload({ waitUntil: 'networkidle' });
    await expect(answer.locator('.cp-answer__body')).not.toBeEmpty({ timeout: 40_000 });
    await expect(answer.locator('.cp-scope__chip', { hasText: 'reading this workspace' }))
      .toHaveCount(0, { timeout: 20_000 });
  }
  return scopeIsChecked(answer);
};

const askCopilot = async (page: Page, question: string) => {
  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  const composer = page.getByRole('textbox', { name: 'Ask the copilot' });
  await composer.fill(question);
  await composer.press('Enter');
  const answer = page.locator('.cp-answer').last();
  await expect(answer.locator('.cp-answer__body')).not.toBeEmpty({ timeout: 40_000 });
  // The scope row names nothing until the pipelines, teammates and metric
  // catalogue have been read — an owner id is `usr_seed01` until then — so a
  // test that samples the chips once has to wait for that read to land.
  await expect(answer.locator('.cp-scope__chip', { hasText: 'reading this workspace' })).toHaveCount(0, { timeout: 20_000 });
  return answer;
};

/**
 * A pipeline question is either answered for that pipeline or labelled as not.
 *
 * The engine has answered "What is the Renewal pipeline worth?" with the
 * $9,010,960 workspace total — six times the $1,463,440 that pipeline is worth
 * — in a confident sentence with no qualification anywhere on it, because
 * `business_metric` has no pipeline argument and the question's qualifier was
 * dropped on the way in. Whether the engine binds it or not, the surface may
 * never present the wider figure as the narrower one: either the scope says
 * Renewal, or the answer says out loud that it does not.
 */
test('a pipeline question answered over every pipeline says so above the figure', async ({ page, request }) => {
  const defs = await pipelines(request);
  const renewal = defs.find((p) => /renew/i.test(p.name)) ?? defs.find((p) => !p.is_default) ?? defs[0];
  const answer = await askCopilot(page, `What is the ${renewal.label} pipeline worth?`);

  // The engine writes whole-dollar figures for these, so the grouped integer is
  // what to look for: "1,463,440" against "9,010,960".
  const grouped = (minor: number) => Math.round(minor / 100).toLocaleString('en-US');
  const total = defs.reduce((sum, def) => sum + (def.open_amount ?? 0), 0);
  const scopedChip = answer.locator('.cp-scope__chip', { hasText: renewal.label });
  if (await scopedChip.count() > 0) {
    // Scoped means scoped: the workspace figure must not be the one on screen.
    await expect(answer.locator('.cp-answer__body')).toContainText(grouped(renewal.open_amount ?? 0));
    await expect(answer.locator('.cp-answer__body')).not.toContainText(grouped(total));
  } else {
    const warning = answer.locator('.ain-banner--danger').first();
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(renewal.label);
    // Above the number, not under it: a reader who has already taken
    // "$9,010,960 in open pipeline" as the answer has already been misled.
    const order = await answer.evaluate((node) => {
      const banner = node.querySelector('.ain-banner--danger');
      const body = node.querySelector('.cp-answer__body');
      if (!banner || !body) return 'missing';
      return banner.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING ? 'before' : 'after';
    });
    expect(order).toBe('before');
    // And the widened dimension is on the scope row as well as in the banner.
    await expect(answer.locator('.cp-scope__chip.is-wide')).toContainText('every pipeline');
  }
});

/**
 * The scope row is read through this workspace's vocabulary, so it says nothing
 * until that vocabulary is in.
 *
 * `/v1/users`, `/v1/pipelines/deal` and `/v1/ai/metrics` are three separate
 * reads, and the answer arrives before them. Rendered against a half-read
 * vocabulary the row states `OWNER usr_seed01` — a database id shown to a
 * person — and lists the eight open stage names as eight stage chips, when
 * together they are exactly "open deals" and narrow to nothing.
 */
test('the scope row never names a record by its database id', async ({ page }) => {
  for (const read of ['**/api/v1/users**', '**/api/v1/pipelines/deal**', '**/api/v1/ai/metrics**']) {
    await page.route(read, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await route.continue();
    });
  }
  const answer = await askCopilotUnchecked(page, 'How much pipeline does Dana Whitfield own?');

  // Sampled across the whole gap, not once after it: the id was on screen for
  // as long as the slowest of the three reads took.
  const seen: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    seen.push(...await answer.locator('.cp-scope__chip').allInnerTexts());
    await page.waitForTimeout(150);
  }
  // Every prefix, not the three that were leaking when this was written: the
  // list itself was the defect the next time round, when `credits.balance` put
  // `ACCOUNT cus_dgqX6o9tM1BGxIWi` on a credit answer and this test watched it
  // happen without a word.
  expect(seen.filter((chip) => /\b[a-z]{2,6}_[A-Za-z0-9]{4,}/.test(chip)), 'the scope row showed a record id')
    .toEqual([]);

  // And once the vocabulary is in, the owner is named.
  await expect(answer.locator('.cp-scope__chip', { hasText: 'Dana Whitfield' })).toBeVisible({ timeout: 20_000 });
});

/**
 * An owner question answered about a company is a substitution, not a widening.
 *
 * "How much pipeline does Marcus Ilori own?" has come back "Whitcombe Aerospace
 * is carrying $315,900 in open pipeline" — a real figure, for the wrong subject,
 * with the teammate's name nowhere in it.
 */
test('an owner question answered for some other record names the record it used', async ({ page, request }) => {
  const users = await getJson<{ data: { id: string; name: string }[] }>(request, '/api/v1/users?limit=20');
  const owner = users.data.find((u) => u.name.split(' ').length > 1) ?? users.data[0];
  const answer = await askCopilot(page, `How much pipeline does ${owner.name} own?`);

  const ownerChip = answer.locator('.cp-scope__chip', { hasText: owner.name });
  if (await ownerChip.count() === 0) {
    const warning = answer.locator('.ain-banner--danger').first();
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(owner.name);
  }
});

/**
 * A by-stage breakdown either agrees with the board's columns or is withheld.
 *
 * The board draws thirteen open columns across three pipelines; the engine
 * groups on the bare stage name and returns eight buckets, four of them sums
 * across pipelines under a caption that belongs to one of them ("Qualification"
 * over New business *and* Expansion's "Expansion identified") or to none
 * ("Usage review" for a column called "Usage & value review"). Every figure
 * adds up and every caption is wrong, which is the worst way to be wrong.
 */
test('a by-stage breakdown that does not match the board is shown as a disagreement', async ({ page, request }) => {
  const answer = await askCopilot(page, 'Break the open pipeline down by stage');
  const runs = await getJson<{ data: { answer: string | null }[] }>(request, '/api/v1/ai/runs?limit=1');
  const prose = runs.data[0]?.answer ?? '';
  test.skip(!/Breakdown:/.test(prose), 'the engine returned no by-stage breakdown for this question');

  // Whatever happens, the merged figures never stand as prose in the answer.
  await expect(answer.locator('.cp-answer__body')).not.toContainText('Breakdown:');

  const reconciled = await answer.locator('.cp-breakdown__list').count();
  if (reconciled === 0) {
    const warning = answer.locator('.ain-banner--warning', { hasText: 'does not line up with the board' });
    await expect(warning).toBeVisible();
    const defs = await pipelines(request);
    const columns = defs.flatMap((p) => p.stages.filter((s) => !s.is_closed)).length;
    await expect(warning).toContainText(String(columns));
  }
});

/* ============================ keyboard and focus =========================== */

const focusedTag = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return 'body';
  return `${el.tagName.toLowerCase()}.${el.className}`;
});

/**
 * A dialog that opens on its own dismiss button is a dialog the first keystroke
 * throws away.
 *
 * `Modal` focuses the first focusable node it contains, and that node is the ×
 * in the header. Three dialogs never named a control of their own, so Enter —
 * the most likely first key on a dialog you just opened — closed them.
 */
test('every deal dialog opens on something Enter will not destroy', async ({ page, request }) => {
  const defs = await pipelines(request);
  const def = defs.find((p) => p.is_default) ?? defs[0];
  await board(page, `?pipeline=${def.name}`);
  const open = await stageWithACard(page, def.stages.filter((s) => !s.is_closed));
  const id = await cardsIn(page, open.name).first().getAttribute('data-deal');

  for (const trigger of ['Move to another pipeline', 'Edit deal information']) {
    await visit(page, `/deals/${id}`, '.ain-page__title');
    await page.getByRole('button', { name: trigger }).click();
    const dialog = page.locator('[role=dialog]');
    await expect(dialog).toBeVisible();
    expect(await focusedTag(page), `${trigger} opened on its own close button`).not.toContain('ain-modal__close');
    await page.keyboard.press('Enter');
    await expect(dialog, `${trigger} was dismissed by its first keystroke`).toBeVisible();
    // Not Escape: Enter on a native <select> opens its dropdown, and Escape
    // would then close that rather than the dialog.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  }

  // And the bulk move, which has no field of its own to land on at all.
  await table(page, `&pipeline=${def.name}`);
  await page.locator('tbody tr td input[type=checkbox]').first().check();
  await page.getByRole('button', { name: 'Move stage' }).click();
  await page.locator('[role=menuitem]').first().click();
  const bulk = page.locator('[role=dialog]');
  await expect(bulk).toBeVisible();
  expect(await focusedTag(page), 'the bulk move dialog opened on its own close button').not.toContain('ain-modal__close');
  await page.keyboard.press('Enter');
  await expect(bulk, 'the bulk move dialog was dismissed by its first keystroke').toBeVisible();
  await bulk.getByRole('button', { name: 'Cancel' }).click();
  await expect(bulk).toHaveCount(0);
});

/**
 * Approving a write destroys the button that approved it.
 *
 * Focus went to `<body>` — the top of the shell, 49 Tab presses from the answer
 * — with nothing announcing that anything had been written.
 */
test('the keyboard lands on the outcome after a copilot write is approved', async ({ page, request }) => {
  const company = (await getJson<{ data: { display_name: string }[] }>(
    request, '/api/v1/records/company?limit=1')).data[0];
  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  await page.getByRole('switch', { name: 'Let it prepare writes' }).click();
  await page.getByLabel('Ask the copilot').fill(`Log a note on ${company.display_name} saying Keyboard probe`);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText('Waiting for your approval').first()).toBeVisible({ timeout: 40_000 });
  await page.getByRole('button', { name: 'Approve and run' }).first().click();
  await expect(page.locator('.cp-answer').last().locator('.cp-resolution'))
    .toContainText('Approved and written', { timeout: 20_000 });

  await expect.poll(() => focusedTag(page), { timeout: 10_000 }).not.toBe('body');
});

/**
 * A cited record you cannot Tab to is a citation only a mouse can follow.
 *
 * Chips whose record had no screen were `disabled` buttons — out of the tab
 * order, unannounced, with the reason in a hover tooltip. Most of them had a
 * screen all along: the engine cites logged calls, notes, emails and tasks, and
 * `/records/:type/:id` renders every one.
 */
test('every citation chip is reachable and activatable from the keyboard', async ({ page, request }) => {
  const company = (await getJson<{ data: { display_name: string }[] }>(
    request, '/api/v1/records/company?limit=1')).data[0];
  const answer = await askCopilot(page, `Summarise the activity on ${company.display_name}`);
  await expect(answer.locator('.cp-chip').first()).toBeVisible({ timeout: 20_000 });

  const chips = await answer.locator('.cp-chip').evaluateAll((nodes) => nodes.map((node) => ({
    text: (node as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
    reachable: (node as HTMLElement).tabIndex >= 0 && !(node as HTMLButtonElement).disabled,
    href: node.getAttribute('href'),
  })));
  expect(chips.length).toBeGreaterThan(0);
  for (const chip of chips) {
    expect(chip.reachable, `“${chip.text}” cannot be reached with Tab`).toBe(true);
  }

  // And one that links actually opens its record on Enter.
  const link = answer.locator('a.cp-chip').first();
  expect(await link.count()).toBeGreaterThan(0);
  const target = await link.getAttribute('href');
  await link.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe(target);
});

/**
 * A qualifier the engine says it dropped is on the screen, whatever its kind.
 *
 * "What is our top 2 pipeline by value?" is settled by the engine as `limit "2"
 * waived` — its own words for a qualifier it read and did not use — and the
 * client's own list of kinds did not have `limit` on it. So the $9,010,960
 * workspace total arrived under a scope row with nothing red in it anywhere,
 * with the engine's admission demoted to a line of prose above the figure. That
 * is the same defect as the pipeline one, one kind to the left, which is why
 * the list is now checked against the engine's own union at compile time.
 */
test('a row cut-off the engine waived is stated as loudly as any other qualifier', async ({ page }) => {
  const answer = await askCopilot(page, 'What is our top 2 pipeline by value?');
  const warning = answer.locator('.ain-banner--danger').first();
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('top 2');

  // Above the figure, not under it.
  const order = await answer.evaluate((node) => {
    const banner = node.querySelector('.ain-banner--danger');
    const body = node.querySelector('.cp-answer__body');
    if (!banner || !body) return 'missing';
    return banner.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING ? 'before' : 'after';
  });
  expect(order).toBe('before');

  // And on the scope row, in red: `limit: 2` really is in the arguments of the
  // call that ran, so a chip read straight off the arguments would have said
  // "Top 2" in the calm voice over a figure that was cut to nothing.
  await expect(answer.locator('.cp-scope__chip.is-wide', { hasText: 'uncut' })).toBeVisible();
  const cutChips = await answer.locator('.cp-scope__chip').allInnerTexts();
  expect(cutChips.filter((chip) => /top\s*2\b/i.test(chip)), 'the inert cut-off was stated as a binding').toEqual([]);
});

/**
 * A balance held in events is read back in events, or the difference is shouted.
 *
 * The billing screens rendered a 6,000,000-event grant as "$60,000.00" and a
 * unit-credit balance with 9,131 events live as "$0.00 available". The copilot
 * can be told the same lie: the engine settles these runs with `unit "event"
 * pending` — the one kind its own refusal exempts — and the client dropped
 * every ledger state that was not `waived` or `refused`, so nothing on screen
 * would have contradicted a money figure. The check is the denomination the
 * answer itself prints.
 */
test('a credit balance asked for in events states the unit it was answered in', async ({ page, request }) => {
  interface Grant { id: string; customer: string; kind: string; meter: string | null }
  interface Balance { balances: { kind: string; unit_label: string | null; available: number }[] }

  // This test used to scan every unit grant in the workspace for one with a
  // live balance and ask about whichever customer it landed on. Earlier tests
  // in this same file spend that balance, so a first run passed, a second run
  // against the same server failed on a customer whose events were gone, and
  // running it alone passed in three seconds. A test that only passes on a
  // database in one particular state is worse than no test, so it makes the
  // state it needs: its own unit grant, on a named customer, with an expiry far
  // enough out that nothing in the suite can lapse it.
  const grants = await getJson<{ data: Grant[] }>(request, '/api/v1/credit-grants?limit=50');
  const meter = grants.data.find((row) => row.kind === 'unit' && row.meter)?.meter ?? null;
  test.skip(!meter, 'this workspace meters nothing, so no unit grant can be issued');
  const customers = await getJson<{ data: { id: string; name: string }[] }>(request, '/api/v1/customers?limit=1');
  const customer = customers.data[0];
  expect(customer, 'the workspace has no billing customers').toBeTruthy();
  const grant = await postJson<Grant>(request, '/api/v1/credit-grants', {
    customer: customer.id,
    name: 'Keyboard test — event credit',
    kind: 'unit',
    meter,
    unit_label: 'event',
    amount: 250_000,
    category: 'promotional',
  });
  const balance = await getJson<Balance>(request, `/api/v1/customers/${customer.id}/credit-balance`);
  expect(
    balance.balances.some((row) => row.kind === 'unit' && row.available > 0),
    `grant ${grant.id} left no live unit balance on ${customer.name}`,
  ).toBe(true);

  const answer = await askCopilot(page, `How many events of credit does ${customer.name} have left?`);
  const body = answer.locator('.cp-answer__body');

  if (await answer.locator('.ain-banner--danger').count() === 0) {
    // No warning means the answer claims to be in events, so it has to be.
    await expect(body).toContainText('events');
  } else {
    await expect(answer.locator('.ain-banner--danger').first()).toContainText('events');
  }

  // Either way the scope row names the account the balance was read for, and
  // never by the billing customer id the tool was actually called with — the
  // one chip on this answer read `ACCOUNT cus_dgqX6o9tM1BGxIWi` before.
  const chips = await answer.locator('.cp-scope__chip').allInnerTexts();
  expect(chips.filter((chip) => /\b[a-z]{2,6}_[A-Za-z0-9]{4,}/.test(chip)), 'the scope row showed a record id')
    .toEqual([]);
  await expect(answer.locator('.cp-scope__chip', { hasText: customer.name })).toBeVisible();
});

/**
 * A ranking is not an accusation that the answer measured the wrong thing.
 *
 * "What are our top 3 accounts by spend?" was answered correctly — Customer
 * spend, grouped by account, cut to three — and topped with a red banner
 * saying the figure was Customer spend "which is a different measure", because
 * the word "accounts" was still free for the metric catalogue to claim as the
 * `customers` metric. A banner that cries wolf on a correct answer is how the
 * banner over an incorrect one stops being read.
 */
test('a top-N ranking is not accused of measuring the dimension it ranked', async ({ page }) => {
  const answer = await askCopilot(page, 'What are our top 3 accounts by spend?');
  await expect(answer.locator('.ain-banner--danger')).toHaveCount(0);
  const chips = await answer.locator('.cp-scope__chip').allInnerTexts();
  expect(chips.some((chip) => /top\s*3/i.test(chip)), `no cut-off chip in ${JSON.stringify(chips)}`).toBe(true);
  expect(chips.some((chip) => /Account/i.test(chip)), `no grouping chip in ${JSON.stringify(chips)}`).toBe(true);
});

/**
 * A write is prepared against the record the question named, or it is stopped.
 *
 * "Move the Sakamoto Seiki — packaging line uplift deal to Negotiation" was
 * prepared against *Sakamoto Seiki — multi-site rollout* — a closed-won deal —
 * and the approval card showed the user's sentence and the wrong record's name
 * three lines apart, with none of the reconciliation apparatus a read answer
 * gets. Approving it moved $321,840 out of closed-won. The engine may resolve
 * the mention correctly, in which case the card is a plain approval; what it
 * may never do is present a sibling as the record that was named.
 */
test('a write prepared against a sibling of the deal that was named is stopped', async ({ page, request }) => {
  // This test used to phrase the question with the deal's full em-dash display
  // name — "Move the Pemberton Auto Systems — pilot expansion to 3 lines deal
  // to Negotiation" — which is the one phrasing that resolves correctly, so it
  // passed over a defect that was live the whole time. People write the name
  // without the dash, and that is the phrasing swept here: on this workspace
  // seven of the fourteen questions below land on a sibling, one of them on a
  // *closed-lost* deal whose approval would have moved $223,440 back into open
  // pipeline. Every account with two or more open deals is asked about, so the
  // test cannot pass by picking a lucky one.
  const all = await getJson<DealList>(request, '/api/v1/records/deal?limit=200');
  const byAccount = new Map<string, DealRecord[]>();
  for (const row of all.data) {
    if (!row.display_name.includes('—')) continue;
    const account = row.display_name.split('—')[0].trim();
    byAccount.set(account, [...(byAccount.get(account) ?? []), row]);
  }
  const accounts = [...byAccount.entries()]
    .filter(([, rows]) => rows.filter((r) => r.properties.deal_status === 'open').length > 1);
  test.skip(accounts.length === 0, 'no account in this workspace carries two open deals');

  let misTargeted = 0;
  for (const [account, rows] of accounts) {
    for (const named of rows.filter((r) => r.properties.deal_status === 'open')) {
      const suffix = named.display_name.split('—').slice(1).join('—').trim();
      const question = `Move the ${account} ${suffix} deal to Proposal`;

      await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
      await page.getByRole('switch', { name: 'Let it prepare writes' }).click();
      await page.getByRole('textbox', { name: 'Ask the copilot' }).fill(question);
      await page.getByRole('button', { name: 'Ask', exact: true }).click();
      await expect(page.getByText('Waiting for your approval').first()).toBeVisible({ timeout: 40_000 });

      const card = page.locator('.ain-card', { hasText: 'Waiting for your approval' }).first();
      const preview = (await card.locator('.cp-approval__preview').innerText()).trim();
      const warned = await card.locator('.ain-banner--danger').count() > 0;

      if (preview.includes(named.display_name)) {
        // Resolved correctly: no warning about the target.
        expect(warned, `the right deal was targeted and the card cried wolf:\n${question}\n${preview}`).toBe(false);
        // And one click away — unless the card has a consequence of its own to
        // put in front of the operator first, which is the other reason a write
        // waits: a stage change that reopens or closes the deal, or one whose
        // deal this card could not read. Then the acknowledgement is what
        // enables it, and that is the point of it.
        const straightThrough = card.getByRole('button', { name: 'Approve and run' });
        if (await straightThrough.count()) await expect(straightThrough).toBeEnabled();
        else {
          const gated = card.getByRole('button', { name: 'Approve anyway' });
          await expect(gated).toBeDisabled();
          await card.locator('.ain-check__input').check();
          await expect(gated).toBeEnabled();
          await card.getByRole('button', { name: 'Decline' }).click();
        }
      } else {
        misTargeted += 1;
        // Resolved to something else: the card has to say so, above the
        // preview, and approving has to take a deliberate second act.
        expect(warned, `the card targeted "${preview}" for "${question}" and said nothing`).toBe(true);
        await expect(card.locator('.ain-banner--danger').first()).toContainText(suffix.split(' ')[0]);
        const approve = card.getByRole('button', { name: 'Approve anyway' });
        await expect(approve).toBeDisabled();
        await card.locator('.ain-check__input').check();
        await expect(approve).toBeEnabled();
        // Nothing was written: the run is left where it was found.
        await card.getByRole('button', { name: 'Decline' }).click();
      }
    }
  }
  // Whether the engine still mis-resolves any of these is the engine's
  // business and it changes underneath this file, so the count is recorded
  // rather than required: what this test holds is the invariant either way —
  // a mis-targeted write is gated and a correct one is not. The guard itself is
  // held to the recorded sweep in `tests/copilot.test.ts`, where the fourteen
  // questions and the record each one actually resolved to are frozen.
  test.info().annotations.push({
    type: 'sweep',
    description: `${accounts.length} accounts, ${misTargeted} write(s) prepared against a sibling`,
  });
});

/**
 * "How many deals did we close in Q2 2026?" is answered with open deals.
 *
 * 0 against a true 8 worth $613,760, captioned "STATUS open only" — the status
 * inverted to its exact opposite and asserted as the scope, at 88% confidence,
 * logged as a success. The client cannot make the engine read the word; it can
 * refuse to let "open only" stand as the scope of a question that said "close".
 */
test('a question about deals we closed is never captioned "open only" in silence', async ({ page, request }) => {
  const deals = await getJson<DealList>(request, '/api/v1/records/deal?limit=200');
  const start = Date.UTC(2026, 3, 1);
  const end = Date.UTC(2026, 6, 1);
  const closed = deals.data.filter((row) => {
    const at = Number(row.properties.close_date ?? 0);
    return ['won', 'lost'].includes(String(row.properties.deal_status)) && at >= start && at < end;
  });
  test.skip(closed.length === 0, 'nothing closed in Q2 2026 on this workspace');

  const answer = await askCopilot(page, 'How many deals did we close in Q2 2026?');
  await expect(answer.locator('.cp-answer__caret')).toHaveCount(0, { timeout: 20_000 });
  test.skip(!await scopeWasChecked(page, answer), 'the workspace vocabulary did not load, so nothing was checked');
  const body = (await answer.locator('.cp-answer__body').innerText()).trim();
  const status = answer.locator('.cp-scope__chip', { hasText: 'Status' });

  // Either the answer really is about closed deals, or the card says out loud
  // that it measured something else.
  const openOnly = (await status.count()) > 0 && /open/.test(await status.first().innerText());
  if (openOnly || new RegExp(`\\b0 open deals\\b`).test(body)) {
    const banner = answer.locator('.ain-banner--danger');
    await expect(banner.first()).toBeVisible();
    await expect(banner.first()).toContainText('closed deals');
    await expect(banner.first()).toContainText('open deals');
  }
});

/**
 * A record property the question named, dropped without a chip or a banner.
 *
 * "How many open deals came from a trade show?" is answered "38 open deals" —
 * every open deal in the workspace — against a true 7 worth $2,634,940, with
 * the words "trade show" appearing nowhere on the card. The qualifier
 * vocabulary knew thirteen dimensions and record properties were not among
 * them, so the question could name one and the ledger had no slot to refuse it.
 */
test('a lead source the question named is either filtered on or refused out loud', async ({ page, request }) => {
  interface PropertyDef { name: string; label: string; type: string; options: { value: string; label: string }[] | null }
  const props = await getJson<{ data: PropertyDef[] }>(request, '/api/v1/objects/deal/properties');
  const source = props.data.find((row) => row.name === 'lead_source');
  test.skip(!source?.options?.length, 'this workspace has no enumerated lead source');
  const option = source!.options!.find((row) => row.label.toLowerCase().includes('trade')) ?? source!.options![0];

  const deals = await getJson<DealList>(request, '/api/v1/records/deal?limit=200');
  const truth = deals.data.filter((row) =>
    row.properties.deal_status === 'open' && row.properties.lead_source === option.value).length;
  const open = deals.data.filter((row) => row.properties.deal_status === 'open').length;
  test.skip(truth === open, 'every open deal carries this source, so there is nothing to drop');

  const answer = await askCopilot(page, `How many open deals came from a ${option.label.toLowerCase()}?`);
  await expect(answer.locator('.cp-answer__caret')).toHaveCount(0, { timeout: 20_000 });
  test.skip(!await scopeWasChecked(page, answer), 'the workspace vocabulary did not load, so nothing was checked');
  const body = (await answer.locator('.cp-answer__body').innerText()).trim();

  // The unqualified count is the substitution. If the answer is that number,
  // the card has to name the dimension it dropped — in the banner and on the
  // scope row — rather than presenting it as the answer.
  if (new RegExp(`\\b${open}\\b`).test(body) && !new RegExp(`\\b${truth}\\b`).test(body)) {
    const banner = answer.locator('.ain-banner--danger');
    await expect(banner.first()).toContainText(option.label);
    await expect(banner.first()).toContainText(source!.label);
    await expect(answer.locator('.cp-scope__chip.is-wide', { hasText: source!.label })).toHaveCount(1);
  }
});

/**
 * A pipeline this workspace has, reported not to exist.
 *
 * "How many tickets are in the Support pipeline?" answered "No deal pipeline in
 * this workspace is called 'Support'. … The pipelines Northwind Robotics has
 * are 'New business', 'Expansion' and 'Renewal'." `crm_pipelines` holds a
 * `support` pipeline of tickets. A correcting banner above the paragraph was
 * an improvement and still left the falsehood rendered verbatim underneath it.
 */
test('a ticket pipeline is not denied in the answer under a banner saying it exists', async ({ page, request }) => {
  const tickets = await getJson<{ data: PipelineDef[] }>(request, '/api/v1/pipelines/ticket');
  test.skip(tickets.data.length === 0, 'this workspace has no ticket pipeline');
  const support = tickets.data[0];

  const answer = await askCopilot(page, `How many tickets are in the ${support.label} pipeline?`);
  await expect(answer.locator('.cp-answer__caret')).toHaveCount(0, { timeout: 20_000 });
  test.skip(!await scopeWasChecked(page, answer), 'the workspace vocabulary did not load, so nothing was checked');
  const body = (await answer.locator('.cp-answer__body').innerText()).trim();
  expect(body, 'the answer still denies a pipeline this workspace has').not.toMatch(/No deal pipeline in this workspace is called/i);
  expect(body, 'the answer still lists the pipelines and leaves this one out').not.toMatch(/The pipelines .* has are/i);
  // What is left says the true thing, and the banner above it still points at
  // the screen where the tickets are.
  expect(body).toContain(support.label);
  await expect(answer.getByRole('link', { name: /Open the ticket/i })).toBeVisible();
});

/**
 * A write the tool refused is not a write that landed.
 *
 * The first wrong-target attempt in the critic's run came back `Failed:
 * "commercial_terms" belongs to the Renewal pipeline` and the card carried a
 * green "Approved and written" badge and a "WRITTEN TO deal_nw_15" link,
 * directly above the sentence saying nothing had been written.
 */
test('a write the tool refused is reported as a failure, not as written', async ({ page, request }) => {
  const defs = await pipelines(request);
  const home = defs.find((p) => p.is_default) ?? defs[0];
  // A stage that belongs to some other pipeline, so the write is guaranteed to
  // be refused by the CRM rather than by anything on this screen.
  const foreign = defs
    .filter((p) => p.name !== home.name)
    .flatMap((p) => p.stages.filter((s) => !s.is_closed))
    .find((s) => !home.stages.some((own) => own.name === s.name));
  test.skip(!foreign, 'every stage in this workspace is legal on every pipeline');

  const deals = await getJson<DealList>(request, '/api/v1/records/deal?limit=200');
  const victim = deals.data.find((row) =>
    row.properties.pipeline === home.name && row.properties.deal_status === 'open');
  test.skip(!victim, 'no open deal on the default pipeline');

  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  await page.getByRole('switch', { name: 'Let it prepare writes' }).click();
  await page.getByRole('textbox', { name: 'Ask the copilot' })
    .fill(`Move the ${victim!.display_name} deal to ${foreign!.label}`);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText('Waiting for your approval').first()).toBeVisible({ timeout: 40_000 });

  const card = page.locator('.ain-card', { hasText: 'Waiting for your approval' }).first();
  if (await card.locator('.ain-check__input').count()) await card.locator('.ain-check__input').check();
  await card.getByRole('button', { name: /^Approve/ }).click();

  const resolution = page.locator('.cp-resolution').last();
  await expect(resolution).toBeVisible({ timeout: 30_000 });
  const outcome = await resolution.getAttribute('data-outcome');
  if (outcome === 'failed') {
    await expect(resolution).toContainText('the write failed');
    await expect(resolution).not.toContainText('Approved and written');
    // …and it does not link to a record it never wrote to.
    await expect(resolution.locator('.cp-chips', { hasText: 'Written to' })).toHaveCount(0);
    // The deal is where it was.
    const after = await deal(request, victim!.id);
    expect(after.properties.deal_stage).toBe(victim!.properties.deal_stage);
  }
});

/**
 * The board is one key from the top of the page, like the copilot.
 *
 * Keyboard-only from a fresh /deals load, the first deal card was 36 Tab
 * presses away: 16 through the sidebar, 9 through the top bar, 10 more through
 * the view toggle, the filters and the search box.
 */
test('the deal board is reachable without tabbing through the whole toolbar', async ({ page }) => {
  await board(page);
  await page.evaluate(() => (document.querySelector('.shell-skip') as HTMLElement | null)?.focus());
  await page.keyboard.press('Enter');

  let presses = 0;
  for (; presses < 40; presses += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.classList.contains('pl-skip'))) break;
  }
  expect(presses, 'the skip link to the board was not near the top of the page').toBeLessThan(8);
  // Invisible until it has the keyboard, and it lands on the card the arrow
  // keys start from — not on a container that announces nothing.
  await page.keyboard.press('Enter');
  await expect(page.locator('.pl-card__name[tabindex="0"]')).toBeFocused();
  // And the grid takes over from there.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.pl-card__name[tabindex="0"]')).toHaveCount(1);
});

/**
 * A question that counts records is answered with a count, or it says otherwise.
 *
 * "How many contacts are in the Expansion pipeline?" was answered "$3,162,060
 * in open pipeline … from 10 open deals" — a dollar figure for a question about
 * people — with no banner and no chip anywhere naming what had been counted.
 */
test('a question about how many records is never quietly answered in money', async ({ page, request }) => {
  const defs = await pipelines(request);
  const named = defs.find((p) => !p.is_default) ?? defs[0];
  const answer = await askCopilot(page, `How many contacts are in the ${named.label} pipeline?`);
  // The answer types itself in. Reading it while the caret is still moving
  // reads a prefix — and a prefix of "$3,162,060 in open pipeline" has no
  // money glyph in it yet, which is a test that passes by being early.
  await expect(answer.locator('.cp-answer__caret')).toHaveCount(0, { timeout: 20_000 });
  const body = (await answer.locator('.cp-answer__body').innerText()).trim();
  const banners = await answer.locator('.ain-banner--danger').count();
  // A money glyph in the answer to a counting question is either flagged or
  // the answer is wrong and silent.
  if (/[$€£]/.test(body)) {
    expect(banners, `answered in money with nothing said:\n${body}`).toBeGreaterThan(0);
    await expect(answer.locator('.ain-banner--danger').first()).toContainText('contacts');
  }
});

/**
 * The run log can count the questions the engine did not answer.
 *
 * Refusals were logged as "Succeeded" — 93 runs, a Failed tile reading 0, and
 * no way to filter for or count the single most important operational signal
 * this engine has.
 */
test('a refused run is counted as refused in the run log', async ({ page }) => {
  // A period nothing can resolve: the engine refuses this one by design.
  await askCopilotUnchecked(page, 'How did we do tomorrow?');
  await visit(page, '/copilot/runs', '.ain-table');
  const tile = page.locator('.ain-stat', { hasText: 'Refused' }).first();
  await expect(tile).toBeVisible();
  await expect(tile.locator('.ain-stat__value')).not.toHaveText('0');
  // …and the filter that finds them exists, and finds them.
  await page.getByLabel('Run status').selectOption('refused');
  await expect(page.locator('tbody tr').first()).toBeVisible();
  const outcomes = await page.locator('tbody tr td:nth-child(4)').allInnerTexts();
  expect(outcomes.length).toBeGreaterThan(0);
  expect(outcomes.every((text) => text.includes('Refused')), `outcomes were ${JSON.stringify(outcomes)}`).toBe(true);
});

/**
 * The board is one tab stop, and the arrow keys cross it.
 *
 * 36 Tab presses reached the first card, and then one press per card to leave
 * the column you were in: on a 22-card board the keyboard could not cross the
 * board in any reasonable number of keystrokes.
 */
test('the deal board is a grid the keyboard can cross', async ({ page }) => {
  await board(page);
  const cards = await page.locator('.pl-card').count();
  expect(cards, 'no cards on the board to move between').toBeGreaterThan(2);
  // Exactly one card is in the tab order, however many are drawn.
  await expect(page.locator('.pl-card__name[tabindex="0"]')).toHaveCount(1);

  const at = () => page.evaluate(() => document.activeElement?.closest?.('.pl-card')?.getAttribute('data-deal') ?? null);
  await page.locator('.pl-card__name[tabindex="0"]').focus();
  const first = await at();
  expect(first).toBeTruthy();

  await page.keyboard.press('ArrowDown');
  const down = await at();
  await page.keyboard.press('ArrowUp');
  expect(await at(), 'ArrowUp did not undo ArrowDown').toBe(first);

  // Right lands on a card in another column, and the tab stop moves with it.
  await page.keyboard.press('ArrowRight');
  const across = await at();
  expect(across, 'ArrowRight moved nowhere').not.toBe(first);
  const column = await page.evaluate((id) =>
    document.querySelector(`.pl-card[data-deal="${id}"]`)?.closest('.pl-col')?.getAttribute('data-stage') ?? null, across);
  const from = await page.evaluate((id) =>
    document.querySelector(`.pl-card[data-deal="${id}"]`)?.closest('.pl-col')?.getAttribute('data-stage') ?? null, first);
  expect(column, 'ArrowRight stayed inside the same column').not.toBe(from);
  await expect(page.locator(`.pl-card[data-deal="${across}"] .pl-card__name[tabindex="0"]`)).toHaveCount(1);
  await expect(page.locator('.pl-card__name[tabindex="0"]')).toHaveCount(1);
  if (down && down !== first) expect(down).not.toBe(across);

  // And Tab leaves the board rather than walking every card in the column.
  let presses = 0;
  for (; presses < 6; presses += 1) {
    await page.keyboard.press('Tab');
    if (!await page.evaluate(() => !!document.activeElement?.closest?.('.pl-board'))) break;
  }
  // Two: the focused card's own menu, then out. Not one per card, and not one
  // per column either — a roving tabindex makes Chromium treat every column as
  // a focusable scroll container unless it is told otherwise.
  expect(presses, 'Tab walked the cards instead of leaving the board').toBeLessThan(3);
});

/**
 * The composer is one key away, not thirty.
 *
 * Tabbing from the top of /copilot passed every nav item, the toolbar, the
 * status select, the filter box and then two focusable controls per
 * conversation before reaching the box you type in — a tunnel that grew without
 * bound as threads accumulated.
 */
test('the copilot composer is reachable without tabbing through every conversation', async ({ page }) => {
  await visit(page, '/copilot', '.cp-composer');
  await page.evaluate(() => (document.querySelector('.shell-skip') as HTMLElement | null)?.focus());
  await page.keyboard.press('Enter');

  let presses = 0;
  for (; presses < 40; presses += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.classList.contains('cp-skip'))) break;
  }
  expect(presses, 'the skip link to the message box was not near the top of the page').toBeLessThan(8);
  // It is invisible until it has the keyboard, and it lands in the box.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Ask the copilot' })).toBeFocused();

  // And the documented shortcut does the same from anywhere on the screen.
  await page.locator('.cp-thread').first().focus();
  await page.keyboard.press('c');
  await expect(page.getByRole('textbox', { name: 'Ask the copilot' })).toBeFocused();
  // Typing a C into the box still types a C.
  await page.keyboard.type('cost');
  await expect(page.getByRole('textbox', { name: 'Ask the copilot' })).toHaveValue('cost');
});

/**
 * A one-line stage change that puts a closed-lost deal back in the forecast.
 *
 * "Move the … first pilot attempt deal to Negotiation" is prepared as
 * `update_record` with a two-line preview — the deal's name, and `Deal stage →
 * negotiation`. Approving it moved five things: the stage, the status from lost
 * to open, the forecast category from closed to commit, the probability from 0%
 * to 80%, and $223,440 of business written off in March back into open pipeline
 * and into the forecast. The operator approved "change the stage".
 */
test('a stage change that reopens a closed deal states it, and waits to be acknowledged', async ({ page, request }) => {
  const pipelines = await getJson<{ data: PipelineDef[] }>(request, '/api/v1/pipelines/deal');
  const deals = await getJson<DealList>(request, '/api/v1/records/deal?limit=200');
  const lost = deals.data.find((row) => row.properties.deal_status === 'lost');
  test.skip(!lost, 'nothing is closed lost on this workspace');
  const home = pipelines.data.find((p) => p.name === lost!.properties.pipeline);
  const reopenTo = home?.stages.find((s) => !s.is_closed && s.probability > 0);
  test.skip(!reopenTo, 'that pipeline has no open stage to reopen into');

  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  await page.getByRole('switch', { name: 'Let it prepare writes' }).click();
  await page.getByRole('textbox', { name: 'Ask the copilot' })
    .fill(`Move the ${lost!.display_name} deal to ${reopenTo!.label}`);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText('Waiting for your approval').first()).toBeVisible({ timeout: 40_000 });

  const card = page.locator('.ain-card', { hasText: 'Waiting for your approval' }).first();
  // Only when the engine actually prepared the write on the deal that was named.
  const preview = await card.locator('.cp-approval__preview').innerText();
  test.skip(!preview.includes(lost!.display_name), 'the engine prepared this against a different record');

  // Every consequence, in the card, in those words.
  const banner = card.locator('.ain-banner--danger').first();
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('closed state');
  await expect(banner).toContainText('reopens it');
  await expect(banner).toContainText('Open pipeline gains');
  await expect(banner).toContainText('forecast');

  // And it is not one click away.
  const approve = card.getByRole('button', { name: /^Approve/ });
  await expect(approve).toBeDisabled();
  await card.locator('.ain-check__input').check();
  await expect(approve).toBeEnabled();

  // Nothing was written, and the deal is where it was.
  await card.getByRole('button', { name: 'Decline' }).click();
  await expect(page.locator('.cp-resolution').last()).toBeVisible({ timeout: 30_000 });
  const after = await deal(request, lost!.id);
  expect(after.properties.deal_stage).toBe(lost!.properties.deal_stage);
  expect(after.properties.deal_status).toBe('lost');
});

/**
 * A thread that narrows every later question to an earlier question's subject.
 *
 * Ask about a teammate's pipeline, ask something unrelated, then ask "What is
 * our open pipeline?" and the answer is one carried-over record's — $315,900
 * against a workspace total of $9,010,960, with nothing on the card but a calm
 * grey chip. The scope has to be visible and it has to come off.
 */
test('a scope carried between questions is shown, and can be taken off', async ({ page }) => {
  await page.goto('/copilot?new=1', { waitUntil: 'networkidle' });
  const composer = page.getByRole('textbox', { name: 'Ask the copilot' });
  for (const question of ['How much open pipeline does Marcus Ilori own?', 'How many tickets are escalated?', 'What is our open pipeline?']) {
    await composer.fill(question);
    await composer.press('Enter');
    await expect(page.locator('.cp-answer').last().locator('.cp-answer__body')).not.toBeEmpty({ timeout: 40_000 });
    // The newest answer is typed out a character at a time, so its text is
    // empty for the first second and a half. The caret is what says it is done.
    await expect(page.locator('.cp-answer').last().locator('.cp-answer__caret')).toHaveCount(0, { timeout: 20_000 });
  }

  const carried = page.locator('.cp-carried').last();
  test.skip(await carried.count() === 0, 'this engine carried nothing between the turns');
  // The composer says what the conversation will put on the next question.
  await expect(carried).toContainText('This conversation is scoped to');

  // And the answer itself says the figure is not the workspace's.
  const answer = page.locator('.cp-answer').last();
  await expect(answer.locator('.cp-carried').first()).toBeVisible();
  await expect(answer.locator('.ain-banner--danger').first()).toContainText('scoped to a record you did not name');

  // Taking it off re-asks the same question with nothing to inherit, and the
  // figure changes to the workspace's own.
  const before = (await answer.locator('.cp-answer__body').innerText()).trim();
  expect(before, 'the carried answer never finished rendering').not.toBe('');
  await answer.getByRole('button', { name: /Ask it without/ }).click();
  const fresh = page.locator('.cp-answer').last();
  await expect(fresh.locator('.cp-answer__body')).not.toBeEmpty({ timeout: 40_000 });
  await expect(fresh.locator('.cp-answer__caret')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.cp-carried')).toHaveCount(0);
  expect((await fresh.locator('.cp-answer__body').innerText()).trim()).not.toBe(before);
});

/**
 * A filter the plan invented, ANDed in, and reported as the answer.
 *
 * "How many deals did we close in Q2 2026?" is planned over the eight *open*
 * stages and answers "0". No word of that sentence says "open". The banner
 * beside it was right and not enough: a reader who has read the 0 has taken it.
 */
test('an answer measured with a filter nobody asked for is not shown as an answer', async ({ page, request }) => {
  const deals = await getJson<DealList>(request, '/api/v1/records/deal?limit=200');
  const closed = deals.data.filter((row) => {
    const at = Number(row.properties.close_date ?? 0);
    return ['won', 'lost'].includes(String(row.properties.deal_status))
      && at >= Date.UTC(2026, 3, 1) && at < Date.UTC(2026, 6, 1);
  });
  test.skip(closed.length === 0, 'nothing closed in Q2 2026 on this workspace');

  const answer = await askCopilot(page, 'How many deals did we close in Q2 2026?');
  test.skip(!await scopeWasChecked(page, answer), 'the workspace vocabulary did not load, so nothing was checked');
  const quarantine = answer.locator('.cp-quarantine');
  test.skip(await quarantine.count() === 0, 'this engine no longer invents the filter');

  await expect(answer.locator('.ain-banner--danger').first())
    .toContainText('not an answer to the question you asked');
  // The figure is kept and it is not in the answer slot: a closed disclosure.
  await expect(quarantine).not.toHaveAttribute('open', '');
  await expect(answer.locator('.cp-answer__caret')).toHaveCount(0);
});
