/**
 * The copilot, driven in a real browser.
 *
 * Every test here is an operability claim a critic found broken on screen: a
 * Sources chip under a revenue answer opens the record it names; a refusal
 * offers the three shapes the engine itself named; the deal screen's entry
 * lands on the deal's own questions rather than a refusal; the queue answers
 * at its own address; usage and the tool catalogue have a screen; the message
 * box stays on screen at 1024 wide; the writes switch remembers itself. Each
 * one checks the server's answer against what the screen shows.
 *
 *   node scripts/preview.mjs --port 8944 --name copilot --fresh
 *   AIN_BASE_URL=http://127.0.0.1:8944 npx playwright test e2e/copilot.spec.ts
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

interface Completion {
  run_id: string;
  content: string;
  citations: { id: string; label: string; type: string }[];
  analysis?: { nearest?: { id: string; example: string }[] } | null;
}
interface Thread { id: string }
interface UsageReport { totals: { runs: number; credits: number; input_tokens: number; output_tokens: number } }
interface ToolList { total_count: number; data: { name: string }[] }
interface DealRecord { id: string; display_name: string; properties: Record<string, unknown> }

const signIn = async (page: Page, request: APIRequestContext) => {
  await request.post('/api/v1/auth/demo');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.request.post('/api/v1/auth/demo');
};

const getJson = async <T = unknown>(request: APIRequestContext, url: string): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request.get(url);
    if (response.ok()) return (await response.json()) as T;
    if (attempt >= 3) throw new Error(`${response.status()} ${url}: ${await response.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
  }
};

const postJson = async <T = unknown>(request: APIRequestContext, url: string, data: unknown): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request.post(url, { data });
    if (response.ok()) return (await response.json()) as T;
    if (attempt >= 3 || response.status() !== 429) throw new Error(`${response.status()} ${url}: ${await response.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
  }
};

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

/** A thread with these questions already asked through the same route the page uses. */
const threadWith = async (request: APIRequestContext, questions: string[], allowWrites = false) => {
  const thread = await postJson<Thread>(request, '/api/v1/ai/threads', { title: questions[0].slice(0, 120) });
  const answers: Completion[] = [];
  for (const prompt of questions) {
    answers.push(await postJson<Completion>(request, '/api/v1/ai/complete', {
      thread_id: thread.id, prompt, feature: 'copilot', ...(allowWrites ? { allow_writes: true } : {}),
    }));
  }
  return { thread, answers };
};

const NOT_FOUND = 'Nothing is registered at this address';

test.describe('grounding: a Sources chip opens the record it names', () => {
  test('invoice, subscription and customer chips land on billing’s screens, not the 404', async ({ page, request }) => {
    await signIn(page, request);
    // The questions are chosen from the ledger rather than written down: this
    // file used to ask "Which invoices are overdue?" and "Which customers are
    // past due?", and billing's own suite — which runs first in a whole-suite
    // run — settles the overdue book, so the engine answered "none" and cited
    // nothing. A status the workspace actually holds is a question with an
    // answer whatever ran before it.
    interface Row { status: string }
    const statusIn = async <T extends Row>(path: string, wanted: string[]): Promise<string> => {
      const rows = await getJson<{ data: T[] }>(request, path);
      const held = wanted.find((status) => rows.data.some((row) => row.status === status));
      expect(held, `this workspace holds no ${path} in any of ${wanted.join(', ')}`).toBeTruthy();
      return held!;
    };
    const invoiceStatus = await statusIn('/api/v1/invoices?status=all&limit=200', ['overdue', 'open', 'paid', 'draft']);
    const subscriptionStatus = await statusIn(
      '/api/v1/subscriptions?status=all&limit=200', ['active', 'past_due', 'trialing', 'paused', 'canceled'],
    );

    const { thread, answers } = await threadWith(request, [
      `Which invoices are ${invoiceStatus}?`,
      `Which subscriptions are ${subscriptionStatus.replace('_', ' ')}?`,
      'Top 3 customers by revenue',
    ]);
    const cited = new Map(answers.flatMap((a) => a.citations).map((c) => [c.type, c]));
    for (const type of ['invoice', 'subscription', 'customer']) {
      expect(cited.has(type), `the engine cited a ${type}`).toBe(true);
    }

    for (const type of ['invoice', 'subscription', 'customer']) {
      const citation = cited.get(type)!;
      await visit(page, `/copilot?thread=${thread.id}`, '.cp-answer');
      const chip = page.locator(`a.cp-chip[href*="${citation.id}"]`).first();
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute('href', new RegExp(`^/billing/(invoices|subscriptions|customers)/${citation.id}$`));
      await chip.click();
      await page.waitForURL((url) => url.pathname.startsWith('/billing/'), { timeout: 10_000 });
      await expect(page.locator('h1')).not.toContainText(NOT_FOUND);
      await expect(page.locator('body')).not.toContainText(NOT_FOUND);
    }
  });
});

test.describe('a refusal offers the engine’s own nearest shapes', () => {
  test('the chips are the three the engine named, in its order, once — and no raw code', async ({ page, request }) => {
    await signIn(page, request);
    const { thread, answers } = await threadWith(request, ['What is the weather in Lisbon today?']);
    const nearest = answers[0].analysis?.nearest ?? [];
    expect(nearest.length).toBe(3);

    await visit(page, `/copilot?thread=${thread.id}`, '.cp-help');
    const chips = page.locator('.cp-help__chip span:not(:has(svg))');
    await expect(chips).toHaveCount(3);
    await expect(chips).toHaveText(nearest.map((row) => row.example));
    await expect(page.locator('.cp-help__label')).toHaveText('Closest questions it can answer');

    const card = page.locator('.cp-answer.is-refused').first();
    await expect(card).not.toContainText('Try one of these');
    await expect(card).not.toContainText('(no_template)');
    await expect(card).not.toContainText('(slot_unbound)');
    // The same three on the run's own page, read back from the run alone.
    await visit(page, `/copilot/runs/${answers[0].run_id}`, '.cp-help');
    await expect(page.locator('.cp-help__chip span:not(:has(svg))')).toHaveText(nearest.map((row) => row.example));
    await expect(page.locator('.cp-help').first()).not.toContainText('(slot_unbound)');

    // Pressing one asks it, and that one is answered.
    await visit(page, `/copilot?thread=${thread.id}`, '.cp-help');
    await page.locator('.cp-help__chip').first().click();
    await expect(page.locator('.cp-answer').last()).not.toHaveClass(/is-refused/, { timeout: 20_000 });
    await expect(page.locator('.cp-answer').last().locator('.cp-chips').first()).toContainText(/Sources|Show the steps/);
  });
});

test.describe('the entry from a deal', () => {
  test('“Where does <deal> stand right now?” opens the deal’s own questions, and the first is answered', async ({ page, request }) => {
    await signIn(page, request);
    const deal = await getJson<DealRecord>(request, '/api/v1/records/deal/deal_nw_71');
    await visit(page, `/copilot?new=1&ask=${encodeURIComponent(`Where does ${deal.display_name} stand right now?`)}`, '.cp-about');
    await expect(page.locator('.cp-about__name')).toHaveText(deal.display_name);
    const questions = page.locator('[data-about-questions] .cp-suggest__item');
    await expect(questions).toHaveCount(4);
    await expect(questions.first()).toContainText(deal.display_name);
    await expect(page.locator('textarea[aria-label="Ask the copilot"]')).toHaveValue('');

    await questions.first().click();
    const answer = page.locator('.cp-answer').last();
    await expect(answer).toBeVisible({ timeout: 20_000 });
    await expect(answer).not.toHaveClass(/is-refused/);
    await expect(answer.locator('.cp-answer__body')).toContainText(deal.display_name);
    const stage = String(deal.properties.deal_stage ?? '').replace(/_/g, ' ');
    await expect(answer.locator('.cp-answer__body')).toContainText(new RegExp(stage, 'i'));
  });

  test('?about=<deal> is the copilot’s own record entry', async ({ page, request }) => {
    await signIn(page, request);
    await visit(page, '/copilot?new=1&about=deal_nw_71', '.cp-about');
    await expect(page.locator('[data-about-questions] .cp-suggest__item')).toHaveCount(4);
    await expect(page.locator('textarea[aria-label="Ask the copilot"]')).toHaveAttribute('placeholder', /^Ask about /);
  });
});

test.describe('the screens the surface advertises', () => {
  test('/copilot/approvals is the queue, not a breadcrumb over a 404', async ({ page, request }) => {
    await signIn(page, request);
    await visit(page, '/copilot/approvals', '.ain-page');
    await expect(page.locator('body')).not.toContainText(NOT_FOUND);
    await expect(page.locator('h1')).toContainText('Approvals');
    await expect(page.getByText('Writes waiting on a person')).toBeVisible();
  });

  test('the Usage tab shows the whole log’s totals, as /v1/ai/usage reports them', async ({ page, request }) => {
    await signIn(page, request);
    const report = await getJson<UsageReport>(request, '/api/v1/ai/usage?days=30');
    await visit(page, '/copilot/runs?tab=usage', '[data-usage-totals]');
    const tiles = page.locator('[data-usage-totals] .ain-stat__value');
    await expect(tiles.first()).toBeVisible();
    const values = await tiles.allTextContents();
    const digits = (text: string) => Number.parseInt(text.replace(/[^0-9]/g, ''), 10);
    expect(digits(values[0])).toBe(report.totals.runs);
    expect(digits(values[1])).toBe(report.totals.credits);
    for (const title of ['By teammate', 'By model', 'By feature', 'Credits by day']) {
      await expect(page.locator('.ain-card__title', { hasText: title })).toBeVisible();
    }
    await expect(page.locator('table[aria-label="By teammate"], table:has(caption:text("By teammate"))').first()).toContainText('Dana Whitfield');
  });

  test('the Tools tab lists every tool the subtitle counts, with what each reads or writes', async ({ page, request }) => {
    await signIn(page, request);
    const tools = await getJson<ToolList>(request, '/api/v1/ai/tools');
    await visit(page, '/copilot/runs?tab=tools', '.cp-tool');
    await expect(page.locator('.cp-tool')).toHaveCount(tools.total_count);
    await expect(page.locator('.cp-tool[data-tool="add_note"]')).toContainText('Writes · needs approval');
    await expect(page.locator('.cp-tool[data-tool="account_profile"]')).toContainText('Reads');
    await page.getByLabel('Filter the tools').fill('invoice');
    const shown = await page.locator('.cp-tool').count();
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(tools.total_count);

    // The subtitle's count is the way in.
    await visit(page, '/copilot?new=1', '.cp-composer');
    await page.locator('.ain-page__subtitle button', { hasText: /tools$/ }).click();
    await page.waitForURL(/tab=tools/);
    // The catalogue is read on arrival and `useQuery` keeps a refused read
    // rather than retrying it, so a screen that landed while the API was
    // saying 429 draws nothing for good. Ask the screen again rather than wait
    // out a minute on a list that has already given up.
    if (await page.locator('.cp-tool').count() === 0) await visit(page, '/copilot/runs?tab=tools', '.cp-tool');
    await expect(page.locator('.cp-tool')).toHaveCount(tools.total_count);
  });
});

test.describe('the page at 1024 wide', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('the message box is on screen, and the conversation list opens on demand', async ({ page, request }) => {
    await signIn(page, request);
    await threadWith(request, ['What is our ARR?']);
    await visit(page, '/copilot', '.cp-composer');
    const box = await page.locator('.cp-composer').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(768);
    await expect(page.locator('.cp-rail__list')).toBeHidden();
    await page.locator('.cp-rail__toggle').click();
    await expect(page.locator('.cp-rail__list')).toBeVisible();
    await expect(page.locator('.cp-thread').first()).toBeVisible();
  });
});

test.describe('the writes switch and the refusal chips, in a live thread', () => {
  test('a refusal’s chips are scrolled into view once they land', async ({ page, request }) => {
    await signIn(page, request);
    const { thread } = await threadWith(request, ['What is our ARR?', 'How many deals are there?', 'What is our open pipeline?']);
    await visit(page, `/copilot?thread=${thread.id}`, '.cp-answer');
    await page.getByLabel('Ask the copilot').fill('Tell me a joke about robots');
    await page.keyboard.press('Enter');
    const chips = page.locator('.cp-help__chip');
    await expect(chips.first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(400);
    const stream = await page.locator('.cp-stream').boundingBox();
    const last = await chips.last().boundingBox();
    expect(stream && last).toBeTruthy();
    expect(last!.y + last!.height).toBeLessThanOrEqual(stream!.y + stream!.height + 1);
  });

  test('“Let it prepare writes” remembers itself per conversation, and a read-only write offers the switch', async ({ page, request }) => {
    await signIn(page, request);
    const { thread } = await threadWith(request, ['Move Aconcagua Alimentos — pilot expansion to 3 lines to the Negotiation stage']);
    await visit(page, `/copilot?thread=${thread.id}`, '.cp-answer');
    // Answered with the switch off: the card says so and offers the switch, not a request-body flag.
    const card = page.locator('.cp-answer').last();
    await expect(card).toContainText('Asked with “Let it prepare writes” off');
    await expect(card).not.toContainText('allow_writes');
    await expect(card.getByRole('button', { name: 'Turn it on and ask again' })).toBeVisible();

    const toggle = page.getByRole('switch', { name: 'Let it prepare writes' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await visit(page, '/copilot/runs', '.ain-page');
    await visit(page, `/copilot?thread=${thread.id}`, '.cp-composer');
    await expect(page.getByRole('switch', { name: 'Let it prepare writes' })).toHaveAttribute('aria-checked', 'true');
  });
});

test.describe('the approval card, in a person’s words', () => {
  test('names the tool as a person does, and links the record the write landed on by name', async ({ page, request }) => {
    await signIn(page, request);
    const { thread } = await threadWith(request, ['Add a note on Aconcagua Alimentos: the revised SOW went out today.'], true);
    await visit(page, `/copilot?thread=${thread.id}`, '.cp-approval__actions');
    const card = page.locator('.cp-approval__actions').first().locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ain-card ")][1]');
    await expect(card).toContainText('Add note changes workspace data');
    await expect(card).not.toContainText('add_note changes workspace data');
    await expect(card.locator('.cp-approval__actions .ain-badge').first()).toHaveText('Add note');
    await page.getByRole('button', { name: 'Approve and run' }).click();
    const written = page.locator('.cp-resolution').first();
    await expect(written).toBeVisible({ timeout: 15_000 });
    await expect(written).toContainText('Approved and written');
    const chip = written.locator('a.cp-chip').first();
    await expect(chip).toContainText('Aconcagua Alimentos');
    await expect(chip).not.toContainText('cmp_nw');
  });
});

test.describe('the draft picker', () => {
  test('describes a deal by its stage and amount, never its id', async ({ page, request }) => {
    await signIn(page, request);
    await visit(page, '/copilot?new=1&draft=1', '[role="dialog"]');
    await page.getByLabel('About which deal').fill('Aconcagua');
    const option = page.locator('[role="option"]').first();
    await expect(option).toBeVisible({ timeout: 10_000 });
    const text = await option.textContent();
    expect(text).not.toMatch(/deal_nw_/);
    expect(text).toMatch(/\$|€|£/);
  });
});

/* ------------------------------------------------------------------------- */
/* The second critic's findings, each held to the screen.                     */
/* ------------------------------------------------------------------------- */

interface ApprovalRow { id: string; tool: string; status: string; outcome: string | null; run_id: string }

/** Nothing left pending, so the queue's empty state is what a visit shows. */
const declineEveryPending = async (request: APIRequestContext) => {
  const pending = await getJson<{ data: ApprovalRow[] }>(request, '/api/v1/ai/approvals?status=pending&limit=200');
  for (const row of pending.data) await request.post(`/api/v1/ai/approvals/${row.id}`, { data: { decision: 'decline' } });
};

test.describe('a write that is booked, not written', () => {
  test('an approved follow-up says scheduled, names the day, and does not claim the record changed', async ({ page, request }) => {
    await signIn(page, request);
    const { thread, answers } = await threadWith(request, ['Schedule a follow up on Aconcagua Alimentos in 7 days saying "Spec: chase the signed MSA"'], true);
    await visit(page, `/copilot?thread=${thread.id}`, '.cp-approval__actions');
    await expect(page.locator('.cp-approval__preview').first()).toContainText('Follow-up on Aconcagua Alimentos');
    await page.getByRole('button', { name: 'Approve and run' }).click();

    const resolution = page.locator('.cp-resolution').first();
    await expect(resolution).toBeVisible({ timeout: 15_000 });
    await expect(resolution).toContainText('Approved and scheduled');
    await expect(resolution).not.toContainText('Approved and written');
    await expect(resolution).toContainText('is booked for');
    await expect(resolution).toContainText('assigned to you');
    // The card used to say "Nothing is on Aconcagua Alimentos’s timeline yet",
    // which is true and tells the reader nothing about what will be. It now
    // separates the two: the task exists now, the note lands when it comes due.
    await expect(resolution).toContainText('The task is on Aconcagua Alimentos now');
    await expect(resolution).toContainText('written onto its timeline when it comes due');
    // Whatever the wording, it never reports the note as already written.
    await expect(resolution).not.toContainText('was written onto');
    await expect(resolution.locator('.cp-chips__label')).toHaveText('Scheduled on');
    await expect(resolution.locator('a.cp-chip').first()).toContainText('Aconcagua Alimentos');
    await expect(page.locator('.cp-answer').last().locator('.cp-answer__head')).toContainText('decided — scheduled');

    // The booking the screen describes is the one the API made.
    const approved = await getJson<{ data: ApprovalRow[] }>(request, '/api/v1/ai/approvals?status=approved&limit=200');
    const booked = approved.data.find((row) => row.run_id === answers[0].run_id);
    expect(booked?.tool).toBe('schedule_followup');
    expect(booked?.outcome).toMatch(/^scheduled=true /);

    // The run log agrees, and does not count it as a write that landed.
    await visit(page, `/copilot/runs/${answers[0].run_id}`, '.cp-runfacts');
    await expect(page.locator('.ain-page__title, h1').first()).toBeVisible();
    await expect(page.locator('.cp-runfacts')).toContainText('Approved and scheduled');
    await expect(page.locator('.cp-runfacts')).not.toContainText('Approved and written');
  });
});

test.describe('a Sources chip whose record billing never created', () => {
  test('is flat with the reason in its name, while its siblings still open their accounts', async ({ page, request }) => {
    await signIn(page, request);
    const { thread, answers } = await threadWith(request, ['How many telemetry events did we meter in the last 30 days?']);
    const customers = answers[0].citations.filter((c) => c.type === 'customer');
    expect(customers.length, 'the metering answer cites the accounts it summed').toBeGreaterThan(0);
    await visit(page, `/copilot?thread=${thread.id}`, '.cp-answer');
    let dead = 0;
    for (const citation of customers) {
      const probe = await request.get(`/api/v1/customers/${citation.id}`);
      const chip = page.locator(`.cp-chip[data-citation="${citation.id}"]`);
      await expect(chip).toBeVisible();
      if (probe.status() === 404) {
        dead += 1;
        await expect(chip).toHaveClass(/cp-chip--flat/, { timeout: 10_000 });
        await expect(chip).toHaveAttribute('aria-label', /billing has no customer/);
        expect(await chip.evaluate((el) => el.tagName)).toBe('SPAN');
      } else {
        await expect(chip).toHaveAttribute('href', `/billing/customers/${citation.id}`);
      }
    }
    // The seed meters two accounts billing never created; if that is ever
    // fixed server-side this still passes, and every link still opens.
    expect(dead).toBeLessThan(customers.length);
  });
});

test.describe('the approval card, after the decision', () => {
  test('a declined write says who declined it, and a stage write names the stage as the board does', async ({ page, request }) => {
    await signIn(page, request);
    const { thread } = await threadWith(request, ['Move Aconcagua Alimentos — pilot expansion to 3 lines to the Negotiation stage'], true);
    await visit(page, `/copilot?thread=${thread.id}`, '.cp-approval__actions');
    const preview = page.locator('.cp-approval__preview').first();
    await expect(preview).toContainText('Deal stage → Negotiation');
    await expect(preview).not.toContainText('→ negotiation');

    await page.getByRole('button', { name: 'Decline' }).first().click();
    const resolution = page.locator('.cp-resolution').first();
    await expect(resolution).toBeVisible({ timeout: 15_000 });
    await expect(resolution).toContainText('Declined by you');
    await expect(resolution).not.toContainText('an operator');
    const deal = await getJson<DealRecord>(request, '/api/v1/records/deal/deal_nw_71');
    expect(deal.properties.deal_stage).toBe('closed_won');
  });
});

test.describe('the developer footnote', () => {
  test('is not on every answer card', async ({ page, request }) => {
    await signIn(page, request);
    const { thread } = await threadWith(request, ['What is our ARR?']);
    await visit(page, `/copilot?thread=${thread.id}`, '.cp-answer');
    const head = page.locator('.cp-answer__head').first();
    await expect(head).toContainText('answered from a template');
    await expect(head).not.toContainText('ANTHROPIC_API_KEY');
    await expect(head).not.toContainText('free text needs a hosted model');
    // The tooltip keeps it for whoever wants to know.
    await expect(head.locator('.cp-engine')).toHaveAttribute('title', /ANTHROPIC_API_KEY/);
  });
});

test.describe('the empty and broken states', () => {
  test('an unknown thread says so in the screen’s words and offers a way out', async ({ page, request }) => {
    await signIn(page, request);
    await visit(page, '/copilot?thread=thr_doesnotexist', '.cp-stream');
    const stream = page.locator('.cp-stream');
    await expect(stream).toContainText('This conversation no longer exists', { timeout: 10_000 });
    await expect(stream).not.toContainText('No such ai thread');
    await stream.getByRole('button', { name: 'Start a new conversation' }).click();
    await page.waitForURL(/new=1/);
    await expect(page.locator('.cp-suggest__item')).toHaveCount(5);
  });

  test('the approvals queue with nothing pending offers to fill itself, with the writes switch on', async ({ page, request }) => {
    await signIn(page, request);
    await declineEveryPending(request);
    await visit(page, '/copilot/approvals', '.ain-page');
    await expect(page.getByText('Nothing is waiting on you')).toBeVisible();
    await page.getByRole('button', { name: 'Show decided writes' }).click();
    await page.waitForURL(/approvals=approved/);
    await expect(page.locator('.cp-approval__preview').first()).toBeVisible();
    await visit(page, '/copilot/approvals', '.ain-page');
    await page.getByRole('button', { name: 'Ask the copilot to write something' }).click();
    await page.waitForURL((url) => url.pathname === '/copilot' && url.searchParams.get('new') === '1');
    await expect(page.getByRole('switch', { name: 'Let it prepare writes' })).toHaveAttribute('aria-checked', 'true');
  });

  test('the draft dialog asks for a deal before it judges the deal’s contacts', async ({ page, request }) => {
    await signIn(page, request);
    await visit(page, '/copilot?new=1&draft=1', '[role="dialog"]');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toContainText('The contacts come from the deal you pick.');
    await expect(dialog).not.toContainText('This record has no contacts linked');
    await page.getByLabel('About which deal').fill('Aconcagua');
    await page.locator('[role="option"]').first().click();
    await expect(dialog).toContainText('Leave it on the primary contact', { timeout: 10_000 });
  });
});

test.describe('the run log and the tools tab', () => {
  // The width the critic judged at. The project's device profile is 1280 wide,
  // where the table scrolls inside its card with the question pinned — by
  // design — so the no-overflow claim is made at the width it is about.
  test.use({ viewport: { width: 1512, height: 950 } });

  test('no header is clipped at the default width, Confidence is off by default, and a tool reads as a sentence', async ({ page, request }) => {
    await signIn(page, request);
    await threadWith(request, ['What is our ARR?']);
    await visit(page, '/copilot/runs', 'table');
    const headers = await page.locator('thead th').evaluateAll((cells) => cells.map((cell) => ({
      text: cell.textContent?.trim() ?? '',
      clipped: [cell, ...cell.querySelectorAll('*')].some((el) => el.scrollWidth > el.clientWidth + 1),
    })));
    expect(headers.map((h) => h.text)).not.toContain('Confidence');
    expect(headers.filter((h) => h.clipped).map((h) => h.text)).toEqual([]);
    // Nor is the table itself wider than its card: fixed widths that summed past
    // the card pushed "Credits" off the right edge instead of truncating it.
    const overflow = await page.locator('.ain-table__scroll').first().evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await visit(page, '/copilot/runs?tab=tools', '.cp-tool');
    const profile = page.locator('.cp-tool[data-tool="account_profile"]');
    await expect(profile.locator('.cp-tool__desc')).not.toContainText('Pass a company id');
    await expect(profile.locator('.cp-tool__guidance summary')).toHaveText('How the engine is told to use it');
    await expect(page.getByLabel('Filter the tools')).toHaveAttribute('placeholder', 'Filter the tools');
  });
});
