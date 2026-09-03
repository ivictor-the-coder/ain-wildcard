/**
 * The live paths of the AI surface that the template suite does not hold.
 *
 * tests/ai-templates.test.ts holds the whitelist to its figures. This file
 * holds everything around it that is still live after the free-text engine
 * was retired: entity resolution, the tool runtime and every gate in it, runs
 * and traces, usage accounting, structured extraction, drafting, the hosted
 * provider and the fall-back to the local engine, writes and the approval
 * queue, conversations, the authority a caller carries, and the ledger
 * reconciliations the copilot's figures have to survive.
 *
 * Every expected value is computed here from the database or from a route the
 * engine does not run, never copied from an answer. Every path is reached
 * through a shape `GET /v1/ai/templates` publishes. A `never` clause naming one
 * phrasing is an allowlist, so what an answer may not say is stated as a set of
 * figures, ids and rows rather than as a sentence.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/server/app';
import { frozenClock, type Clock } from '../src/server/kernel/clock';
import type { Auth } from '../src/server/kernel/http';
import { aiRuntime, DEFAULT_BUDGET, type AiCallContext } from '../src/server/ai/runtime';
import { ENGINE_MODEL } from '../src/server/ai/engine';
import { anthropicProvider, toWire, toWireTools } from '../src/server/ai/anthropic';
import { entityIndex, workspaceProfile } from '../src/server/ai/grounding';
import { resolveEntities } from '../src/server/ai/resolve';
import { businessMetric } from '../src/server/ai/functions';
import { accountUsage, estimateTokens } from '../src/server/ai/usage';
import { formatMoney } from '../src/shared/money';
import { DAY, formatDate } from '../src/shared/time';
import v from '../src/shared/validate';

// The template engine is the only answer path this suite admits unless a test
// stands up its own provider; a key in the environment would put the hosted
// model in front of it.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;
// The API's per-principal limit is measured on the wall clock.
process.env.AIN_RATE_LIMIT ||= '1000000';

const ORG = 'org_demo';
const TZ = 'America/New_York';
const T0 = Date.parse('2026-09-03T12:00:00Z');
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
const OTHER_ORG: Auth = { ...DANA, orgId: 'org_other' };
const READONLY: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed06', role: 'readonly', scopes: ['*'], livemode: true };
/** Not a credential: the platform's own inert placeholder shape. */
const FAKE_KEY = 'ain_demo_key_not_a_real_credential';

let app: App;
let clock: Clock;

before(async () => {
  clock = frozenClock(T0);
  app = await createApp({ db: 'memory', config: { env: 'test' }, clock });
});

after(() => app.close());

/** The tool runtime refills its per-minute bucket from the workspace clock, and a frozen clock never refills it. */
const tick = () => clock.advance(10_000);

type Body = Record<string, any>;

const call = (method: string, path: string, body?: unknown, auth: Auth | undefined = DANA, headers?: Record<string, string>) =>
  app.handle({ method, path, body, ...(auth ? { auth } : {}), ...(headers ? { headers } : {}) });

async function expectOk(method: string, path: string, body?: unknown, auth: Auth = DANA): Promise<Body> {
  const res = await call(method, path, body, auth);
  assert.ok(res.status < 400, `${method} ${path} → ${res.status} ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body;
}

async function ask(prompt: string, extra: Record<string, unknown> = {}, auth: Auth = DANA): Promise<Body> {
  tick();
  return expectOk('POST', '/v1/ai/complete', { prompt, ...extra }, auth);
}

let probes = 0;
const callContext = (over: Partial<AiCallContext> = {}): AiCallContext => ({
  ctx: app.ctx, orgId: ORG, actorId: 'usr_seed01', actorType: 'user', feature: 'test',
  runId: `run_live_${(probes += 1)}`, spans: [], pendingApprovals: [], startedNs: process.hrtime.bigint(), steps: 0,
  ...over,
});

const runtime = () => aiRuntime(app.ctx);

/* ----------------------------- the database ------------------------------- */

type Props = Record<string, unknown>;
interface Rec { id: string; name: string; owner: string | null; created: number; p: Props }

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0)) || 0;
const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const money = (minor: number, currency = 'usd'): string =>
  formatMoney({ amount: Math.round(minor), currency }, { locale: 'en-US', trimZeroFraction: true });
const money2 = (minor: number, currency: string): string => formatMoney({ amount: Math.round(minor), currency }, { locale: 'en-US' });
const day = (ts: number, tz = 'UTC'): string => formatDate(ts, { locale: 'en-US', timeZone: tz });

const recs = (type: string): Rec[] =>
  app.db.all<{ id: string; display_name: string; owner_id: string | null; created: number; properties: string }>(
    `SELECT id, display_name, owner_id, created, properties FROM crm_records
     WHERE org_id = ? AND object_type = ? AND archived = 0 AND merged_into IS NULL`, ORG, type,
  ).map((r) => ({ id: r.id, name: r.display_name, owner: r.owner_id, created: r.created, p: JSON.parse(r.properties || '{}') as Props }));

const byName = (type: string, name: string): Rec => {
  const found = recs(type).find((r) => r.name === name);
  assert.ok(found, `fixture: no ${type} named ${name}`);
  return found!;
};

function stageSets(): { open: string[]; won: string[]; lost: string[] } {
  const rows = app.db.all<{ name: string; is_closed: number; is_won: number }>(
    `SELECT DISTINCT name, is_closed, is_won FROM crm_pipeline_stages WHERE org_id = ? AND object_type = 'deal'`, ORG);
  return {
    open: rows.filter((r) => !r.is_closed).map((r) => r.name),
    won: rows.filter((r) => r.is_closed && r.is_won).map((r) => r.name),
    lost: rows.filter((r) => r.is_closed && !r.is_won).map((r) => r.name),
  };
}
const isOpen = (d: Rec) => stageSets().open.includes(str(d.p.deal_stage));
const isWon = (d: Rec) => stageSets().won.includes(str(d.p.deal_stage));
const amount = (d: Rec): number => num(d.p.amount);
const total = (rows: Rec[]): number => rows.reduce((sum, d) => sum + amount(d), 0);

const linkedIds = (id: string): Set<string> => new Set(
  app.db.all<{ from_id: string; to_id: string }>(
    `SELECT from_id, to_id FROM crm_associations WHERE org_id = ? AND (from_id = ? OR to_id = ?)`, ORG, id, id,
  ).flatMap((a) => [a.from_id, a.to_id]).filter((x) => x !== id));
const associated = (id: string, type: string): Rec[] => {
  const ids = linkedIds(id);
  return recs(type).filter((r) => ids.has(r.id));
};

const people = (): Map<string, string> => new Map(app.db.all<{ id: string; name: string }>(
  `SELECT u.id, u.name FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ?`, ORG).map((r) => [r.id, r.name]));
const personId = (name: string): string => {
  const id = [...people().entries()].find(([, held]) => held === name)?.[0];
  assert.ok(id, `fixture: no teammate named ${name}`);
  return id!;
};

const customerIds = (companyId: string): string[] =>
  app.db.all<{ id: string }>(`SELECT id FROM billing_customers WHERE org_id = ? AND crm_record_id = ?`, ORG, companyId).map((r) => r.id);

const noteCount = () => app.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ? AND object_type = 'note'`, ORG);

/** Every figure a piece of text states. A list's ordinals are markers, not figures. */
const numbersIn = (text: unknown): number[] =>
  [...String(text ?? '').replace(/^\s*\d+\.\s+/gm, '').matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '')));
const allow = (...values: unknown[]): Set<number> => new Set(values.flatMap((one) => numbersIn(one)));
function assertOnlyTheseNumbers(content: string, allowed: Set<number>, context: string): void {
  const strays = [...new Set(numbersIn(content).filter((n) => !allowed.has(n)))];
  assert.deepEqual(strays, [], `${context}\nprinted ${strays.join(', ')}, which is not the answer to that question.\n${content}`);
}

/** A primary key standing where a name belongs. */
const RAW_ID = /\b(?:cmp|con|deal|tkt|cus|note|task|act|inv|in|sub|usr|prod|price|mtr|thr|run|appr|agentrun|trc|call)_[A-Za-z0-9][A-Za-z0-9_]{2,}\b/;

interface Published { id: string; kind: string; intent: string; example: string | null; tools: string[]; available: boolean; patterns: string[] }
const published = async (): Promise<Published[]> => (await expectOk('GET', '/v1/ai/templates')).data;

const quarterOf = (ts: number): { start: number; end: number; label: string } => {
  const d = new Date(ts);
  const q = Math.floor(d.getUTCMonth() / 3);
  return { start: Date.UTC(d.getUTCFullYear(), q * 3, 1), end: Date.UTC(d.getUTCFullYear(), q * 3 + 3, 1), label: `Q${q + 1} ${d.getUTCFullYear()}` };
};
const monthBefore = (ts: number): { start: number; end: number } => {
  const d = new Date(ts);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) };
};
const wonBetween = (start: number, end: number): Rec[] =>
  recs('deal').filter((d) => isWon(d) && num(d.p.close_date) >= start && num(d.p.close_date) < end);

/* ================== a period resolves against the workspace clock ================== */

describe('a period resolves against the workspace clock, not the wall clock', () => {
  test('"last quarter" is the quarter before the one the workspace is in, and it moves when the clock does', async () => {
    // Its own workspace, because the clock is moved a season forward here and
    // the shared runtime's rate bucket cannot follow a clock that jumps back.
    const own = frozenClock(T0);
    const isolated = await createApp({ db: 'memory', config: { env: 'test' }, clock: own });
    try {
      const askHere = async () => {
        own.advance(10_000);
        const res = await isolated.handle({ method: 'POST', path: '/v1/ai/complete', body: { prompt: 'How much did we book last quarter?' }, auth: DANA });
        assert.equal(res.status, 200);
        return res.body as Body;
      };
      const won = (start: number, end: number) => isolated.db.all<{ properties: string }>(
        `SELECT properties FROM crm_records WHERE org_id = ? AND object_type = 'deal' AND archived = 0 AND merged_into IS NULL`, ORG)
        .map((r) => JSON.parse(r.properties) as Props)
        .filter((p) => str(p.deal_stage) === 'closed_won' && num(p.close_date) >= start && num(p.close_date) < end)
        .reduce((sum, p) => sum + num(p.amount), 0);

      const first = await askHere();
      const expected = quarterOf(quarterOf(isolated.ctx.now()).start - 1);
      assert.equal(first.analysis.refusal, null, first.content);
      const step = first.analysis.plan[0];
      assert.deepEqual([step.args.start, step.args.end, step.args.window_label], [expected.start, expected.end, expected.label]);
      assert.ok(first.content.includes(money(won(expected.start, expected.end))), first.content);

      own.advance(95 * DAY);
      const later = await askHere();
      const moved = quarterOf(quarterOf(isolated.ctx.now()).start - 1);
      assert.notEqual(moved.label, expected.label, 'the clock moved a season, so the quarter before it is a different quarter');
      assert.equal(later.analysis.plan[0].args.window_label, moved.label,
        'the period was bound against a clock other than the workspace\'s — the one the vocabulary was cached under, or the wall clock');
      assert.ok(later.content.includes(money(won(moved.start, moved.end))), later.content);
    } finally {
      isolated.close();
    }
  });
});

/* ========================== entity resolution ========================== */

describe('entity resolution beats substring matching', () => {
  test('resolves names substring search cannot reach', () => {
    const index = entityIndex(app.ctx, ORG);
    const companies = app.db.all<{ id: string; display_name: string; properties: string }>(
      `SELECT id, display_name, properties FROM crm_records WHERE org_id = ? AND object_type = 'company'`, ORG);
    const named = (needle: string) => companies.find((c) => c.display_name.toLowerCase().includes(needle));
    const meridian = named('meridian');
    const calder = named('calder');
    const northgate = named('northgate');
    const pemberton = named('pemberton');
    const kestrel = named('kestrel');
    assert.ok(meridian && calder && northgate && pemberton && kestrel, 'fixture: the seed companies are present');

    const fixtures: { query: string; expect: string; why: string }[] = [
      { query: 'How much did MFS spend last quarter?', expect: meridian!.id, why: 'acronym' },
      { query: 'calder and vance pipeline', expect: calder!.id, why: '"and" for "&"' },
      { query: 'open tickets for nortgate chemical', expect: northgate!.id, why: 'misspelling' },
      { query: `anything new from ${JSON.parse(pemberton!.properties).domain}?`, expect: pemberton!.id, why: 'domain' },
      { query: 'summarise Kestrel before the call', expect: kestrel!.id, why: 'first word of a long legal name' },
      { query: 'MERIDIAN FORGE SYSTEMS renewal', expect: meridian!.id, why: 'case difference' },
      { query: `what is happening with ${meridian!.id}`, expect: meridian!.id, why: 'record id' },
      { query: 'pemberton auto', expect: pemberton!.id, why: 'partial name' },
    ];
    let resolved = 0;
    let substring = 0;
    for (const fixture of fixtures) {
      const hits = resolveEntities(fixture.query, index, { prefer: ['company'], dedupe: true, limit: 3 });
      const top = hits.find((h) => h.entity.type === 'company');
      if (top?.entity.id === fixture.expect) resolved++;
      const haystack = fixture.query.toLowerCase();
      const naive = companies.filter((c) => haystack.includes(c.display_name.toLowerCase()));
      if (naive.length === 1 && naive[0].id === fixture.expect) substring++;
    }
    assert.ok(resolved >= 7, `the resolver got ${resolved}/${fixtures.length}`);
    assert.ok(substring <= 3, `substring matching got ${substring}/${fixtures.length}, which would make this test meaningless`);
    assert.ok(resolved > substring + 2, `resolver ${resolved} vs substring ${substring}`);
  });

  test('reports the rule and the mention behind every match, and the registered search tool says the same', async () => {
    const index = entityIndex(app.ctx, ORG);
    const brightline = byName('company', 'Brightline Foods');
    const hits = resolveEntities('how is Brightline Foods doing', index, { prefer: ['company'], limit: 2 });
    assert.ok(hits.length);
    assert.ok(hits[0].score > 0.6);
    assert.ok(['name_exact', 'core_exact', 'alias_exact', 'prefix', 'token_subset'].includes(hits[0].rule));
    assert.match(hits[0].explain, /Brightline Foods/);
    assert.ok(hits[0].mention.toLowerCase().includes('brightline'));

    tick();
    const searched = await runtime().execute('workspace_search', { query: 'nortgate chemical', types: ['company'], limit: 3 }, callContext());
    assert.ok(searched.ok, JSON.stringify(searched.error));
    const result = searched.result as { matches: { id: string; why: string }[] };
    assert.equal(result.matches[0]?.id, byName('company', 'Northgate Chemical Works').id, 'the tool resolves the misspelling the resolver resolves');
    assert.ok(result.matches[0].why.length > 10, 'every hit carries the reason it matched');
    assert.equal(searched.result && (searched.result as { query: string }).query, 'nortgate chemical');
    void brightline;
  });

  test('business vocabulary is never mistaken for a record', () => {
    const index = entityIndex(app.ctx, ORG);
    for (const query of ['how much revenue did we book last quarter', 'what is the total pipeline this month', 'show me open tickets']) {
      const hits = resolveEntities(query, index, { prefer: ['company'], limit: 3 });
      assert.equal(hits.filter((h) => h.entity.type === 'company').length, 0, `"${query}" resolved to a company`);
    }
  });

  test('an ambiguous mention returns ranked candidates above the floor rather than a guess', () => {
    const index = entityIndex(app.ctx, ORG);
    const hits = resolveEntities('precision', index, { prefer: ['company'], limit: 5 });
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score, 'candidates come back ranked');
    assert.ok(hits.every((h) => h.score >= 0.46), 'weak matches are dropped, not returned');
  });
});

/* ============================ the tool runtime ============================ */

describe('the read-only, allowlist, budget and approval gates cover every tool, registered or not', () => {
  let ran = 0;
  const privateRead = {
    name: 'private_read', description: 'A tool the caller supplied rather than registered.',
    readOnly: true, input: v.object({ id: v.string(), api_key: v.optional(v.string()) }),
    run: () => { ran += 1; return { ok: true, token: 'never-shown' }; },
  };
  const privateWrite = { ...privateRead, name: 'private_write', readOnly: false };

  test('the catalogue publishes every tool with its schema and its gate', async () => {
    const tools = await expectOk('GET', '/v1/ai/tools');
    assert.ok(tools.data.length >= 8);
    const metric = tools.data.find((t: { name: string }) => t.name === 'business_metric');
    assert.ok(metric, 'the metric tool is registered');
    assert.equal(metric.read_only, true);
    assert.equal(metric.input_schema.type, 'object');
    assert.ok(metric.input_schema.fields.metric);
    const write = tools.data.find((t: { name: string }) => t.name === 'schedule_followup');
    assert.equal(write.read_only, false);
    assert.equal(write.requires_approval, true);
    // Every write tool the workspace registers is gated, and no read template plans one.
    const writes = new Set(tools.data.filter((t: { read_only: boolean }) => !t.read_only).map((t: { name: string }) => t.name));
    for (const template of await published()) {
      const planned = template.tools.filter((tool) => writes.has(tool));
      if (template.kind === 'write') assert.equal(planned.length, 1, `${template.id} is a write shape that plans ${planned.length} write tools`);
      else assert.deepEqual(planned, [], `${template.id} is a ${template.kind} shape and plans a write`);
    }
  });

  test('arguments are validated before any tool sees them, and the error is typed and recoverable', async () => {
    tick();
    const registered = await runtime().execute('business_metric', { metric: 42 }, callContext());
    assert.equal(registered.ok, false);
    assert.equal(registered.error?.code, 'invalid_arguments');
    assert.equal(registered.error?.param, 'metric');
    assert.equal(registered.error?.recoverable, true);
    assert.equal(registered.span.ok, false);
    assert.equal(registered.span.errorCode, 'invalid_arguments');

    ran = 0;
    const supplied = await runtime().execute('private_read', { id: 42 }, callContext(), privateRead);
    assert.equal(supplied.error?.code, 'invalid_arguments');
    assert.equal(ran, 0, 'the gate runs before the tool does');
  });

  test('an unknown tool names the ones that exist, and an unknown metric names the metrics', async () => {
    tick();
    const missing = await runtime().execute('teleport', {}, callContext());
    assert.equal(missing.error?.code, 'tool_not_found');
    assert.match(missing.error!.message, /account_profile|business_metric/);
    const metric = await runtime().execute('business_metric', { metric: 'vibes' }, callContext());
    assert.equal(metric.ok, true, 'the tool ran; the argument was simply not a known metric');
    const result = metric.result as { error?: string; available?: string[] };
    assert.match(String(result.error), /Unknown metric/);
    assert.ok(result.available?.includes('pipeline'));
  });

  test('a write is refused on a read-only run and stopped at the approval gate on a write run', async () => {
    tick();
    const registered = await runtime().execute('schedule_followup', { record_id: 'cmp_missing', in_days: 3, note: 'check in' }, callContext({ allowWrites: false }));
    assert.equal(registered.ok, false);
    assert.equal(registered.error?.code, 'write_not_permitted');

    ran = 0;
    const readOnlyRun = await runtime().execute('private_write', { id: 'x' }, callContext(), privateWrite);
    assert.equal(readOnlyRun.error?.code, 'write_not_permitted');
    assert.equal(ran, 0);

    const context = callContext({ allowWrites: true });
    const unapproved = await runtime().execute('private_write', { id: 'x' }, context, privateWrite);
    assert.equal(unapproved.error?.code, 'approval_required');
    assert.equal(ran, 0, 'nothing is written before a person approves it');
    assert.equal(context.pendingApprovals?.[0].tool, 'private_write');
    assert.equal(app.db.count(`SELECT COUNT(*) FROM ai_approvals WHERE org_id = ? AND run_id = ? AND status = 'pending'`, ORG, context.runId!), 1,
      'the gate raised a card a person can see');

    const approved = await runtime().execute('private_write', { id: 'x' }, callContext({ allowWrites: true, approvals: ['private_write'] }), privateWrite);
    assert.equal(approved.ok, true);
    assert.equal(ran, 1, 'and it runs once the approval is in hand');
  });

  test('the allowlist is enforced at the runtime, for a registered tool and a caller-supplied one', async () => {
    tick();
    const scoped = await runtime().execute('business_metric', { metric: 'pipeline' }, callContext({ restrictTools: ['workspace_search'] }));
    assert.equal(scoped.ok, false);
    assert.equal(scoped.error?.code, 'tool_not_permitted');
    assert.equal(scoped.error?.recoverable, false);
    assert.match(scoped.error!.message, /scoped to "workspace_search"/);
    assert.equal(scoped.span.errorCode, 'tool_not_permitted');

    ran = 0;
    const outside = await runtime().execute('private_read', { id: 'x' }, callContext({ restrictTools: ['workspace_search'] }), privateRead);
    assert.equal(outside.error?.code, 'tool_not_permitted');
    const none = await runtime().execute('private_read', { id: 'x' }, callContext({ restrictTools: [] }), privateRead);
    assert.equal(none.error?.code, 'tool_not_permitted');
    const registeredNone = await runtime().execute('workspace_search', { query: 'Rheinwerk' }, callContext({ restrictTools: [] }));
    assert.equal(registeredNone.error?.code, 'tool_not_permitted');
    assert.equal(ran, 0);
  });

  test('the step and time budgets stop a run, whichever tool it reaches for', async () => {
    tick();
    const steps = callContext({ budget: { steps: 2 } });
    assert.equal((await runtime().execute('business_metric', { metric: 'pipeline' }, steps)).ok, true);
    assert.equal((await runtime().execute('business_metric', { metric: 'pipeline' }, steps)).ok, true);
    const third = await runtime().execute('business_metric', { metric: 'pipeline' }, steps);
    assert.equal(third.error?.code, 'step_budget_exhausted');
    assert.equal(third.error?.recoverable, false);

    ran = 0;
    const one = callContext({ budget: { steps: 1 } });
    assert.equal((await runtime().execute('private_read', { id: 'x' }, one, privateRead)).ok, true);
    assert.equal((await runtime().execute('private_read', { id: 'x' }, one, privateRead)).error?.code, 'step_budget_exhausted');
    assert.equal(ran, 1);

    const spent = callContext({ budget: { timeMs: 0 }, startedNs: process.hrtime.bigint() - 5_000_000_000n });
    const late = await runtime().execute('business_metric', { metric: 'closed_won' }, spent);
    assert.equal(late.error?.code, 'time_budget_exhausted');
    assert.equal(late.error?.recoverable, false);
  });

  test('the per-org rate limit refuses rather than queues', async () => {
    const context = callContext({ orgId: 'org_ratelimit', budget: { steps: 50, callsPerMinute: 3 } });
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(await runtime().execute('business_metric', { metric: 'pipeline' }, context));
    assert.equal(outcomes.filter((o) => o.ok).length, 3, 'three calls a minute means three');
    assert.ok(outcomes.slice(3).every((o) => o.error?.code === 'rate_limited'), 'the bucket empties and refuses');
  });

  test('spans mask anything credential-shaped and summarise results', async () => {
    tick();
    const searched = await runtime().execute('workspace_search', { query: 'Brightline', limit: 3 }, callContext());
    assert.equal(searched.ok, true);
    assert.equal(searched.span.kind, 'tool');
    assert.ok(searched.span.durationMs >= 0);
    assert.match(searched.span.summary, /matches|query/);

    ran = 0;
    const secret = 'super-secret-value';
    const masked = await runtime().execute('private_read', { id: 'x', api_key: secret }, callContext(), privateRead);
    assert.equal(masked.ok, true);
    assert.equal(masked.span.args?.api_key, '[redacted]');
    assert.ok(!JSON.stringify(masked.span).includes(secret), 'the secret never reaches the trace');
    assert.match(masked.span.summary, /token=\[redacted\]/, 'a credential-shaped result field is masked in the summary too');
  });

  test('an API allowlist scopes the plan, the refusal and the tools a thread turn may reach', async () => {
    const shapes = await published();
    const reachable = (tools: string[]) => new Set(shapes.filter((t) => t.tools.every((tool) => tools.includes(tool))).map((t) => t.id));
    const question = shapes.find((t) => t.id === 'invoices-status')!.example!;

    const answered = await ask(question, { tools: ['billing_list_invoices'] });
    assert.deepEqual(answered.analysis.scoped_tools, ['billing_list_invoices']);
    assert.equal(answered.analysis.refusal, null, answered.content);
    assert.deepEqual([...new Set(answered.trace.filter((s: Body) => s.kind === 'tool').map((s: Body) => s.name))], ['billing_list_invoices']);

    const elsewhere = await ask(question, { tools: ['record_search'] });
    assert.deepEqual(elsewhere.analysis.scoped_tools, ['record_search']);
    assert.ok(elsewhere.analysis.refusal, 'a ledger question cannot be answered from the CRM search alone');
    assert.deepEqual(elsewhere.tool_calls, [], 'nothing outside the allowlist ran');
    assert.equal(elsewhere.trace.filter((s: Body) => s.kind === 'tool').length, 0);
    for (const near of elsewhere.analysis.nearest as { id: string }[]) {
      assert.ok(reachable(['record_search']).has(near.id), `${near.id} was offered instead, and it needs a tool this run cannot reach`);
    }

    const nothing = await ask(question, { tools: [] });
    assert.deepEqual(nothing.analysis.scoped_tools, []);
    assert.equal(nothing.analysis.refusal?.code, 'no_tools');
    assert.deepEqual(nothing.tool_calls, []);
    assert.equal(nothing.trace.filter((s: Body) => s.kind === 'tool').length, 0);

    const unknown = await call('POST', '/v1/ai/complete', { prompt: question, tools: ['workspace_search', 'exfiltrate_everything'] });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'unknown_tool');
    assert.equal(unknown.body.error.param, 'tools');
    assert.match(unknown.body.error.message, /exfiltrate_everything/);
    assert.match(unknown.body.error.message, /workspace_search/);

    tick();
    const thread = await expectOk('POST', '/v1/ai/threads', { title: 'Scoped agent' });
    const reply = await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, { content: question, tools: ['workspace_search'] });
    const stored = await expectOk('GET', `/v1/ai/runs/${reply.run_id}`);
    assert.deepEqual(stored.trace.filter((s: Body) => s.kind === 'tool').map((s: Body) => s.name), [], 'a thread turn is scoped by the same allowlist');
  });

  test('a run that blows its step budget says it has no answer rather than a partial one', async () => {
    const two = (await published()).find((t) => t.id === 'owner-win-rate-period')!;
    const answer = await ask(two.example!, { max_steps: 1 });
    assert.equal(answer.finish_reason, 'budget_exhausted');
    assert.equal(answer.analysis.budget_exhausted, true);
    assert.equal(answer.analysis.template?.id, two.id, 'the shape matched; the plan is what ran out');
    assert.ok(answer.trace.filter((s: Body) => s.kind === 'tool' && s.ok).length <= 1, 'no more steps ran than the caller allowed');
    // The only figures a stopped run may print are the budget it ran out of.
    assertOnlyTheseNumbers(answer.content, allow(DEFAULT_BUDGET.timeMs.toLocaleString('en-US'), 1), 'a stopped run');
    const stored = await expectOk('GET', `/v1/ai/runs/${answer.run_id}`);
    assert.ok(stored.steps <= 1 || stored.trace.filter((s: Body) => s.kind === 'tool' && s.ok).length <= 1);
  });
});

/* =========================== runs, traces, usage =========================== */

describe('runs, traces and the usage roll-up', () => {
  test('a completion is stored with a complete, ordered trace that names the shape it matched', async () => {
    const shape = (await published()).find((t) => t.id === 'metric-snapshot')!;
    const answer = await ask(shape.example!);
    const run = await expectOk('GET', `/v1/ai/runs/${answer.run_id}`);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.provider, 'builtin');
    assert.equal(run.model, ENGINE_MODEL);
    assert.equal(run.intent, shape.intent, 'the run carries the intent of the shape it matched');
    assert.equal(run.confidence, 1, 'a template match is exact');
    assert.equal(run.answer, answer.content);
    assert.ok(run.reasoning.some((line: string) => line.includes(`Matched "${shape.id}"`)));
    const kinds = new Set(run.trace.map((s: Body) => s.kind));
    for (const kind of ['provider', 'plan', 'tool', 'synthesis']) assert.ok(kinds.has(kind), `no ${kind} span on the trace`);
    const seqs = run.trace.map((s: Body) => s.seq);
    assert.deepEqual(seqs, seqs.map((_: number, i: number) => i + 1), 'spans are ordered');
    for (const span of run.trace) {
      assert.equal(typeof span.duration_ms, 'number');
      assert.ok(span.summary.length > 0, `span ${span.name} has no summary`);
    }
    assert.ok(run.timings.total_ms >= run.timings.tool_ms);
    assert.equal(run.span_count, run.trace.length);
    assert.equal(run.steps, run.trace.filter((s: Body) => s.kind === 'tool').length);
  });

  test('a refusal is stored as a run with no intent and no confidence, and no tool span', async () => {
    const answer = await ask('Which deals are in the Maybe forecast category?');
    assert.ok(answer.analysis.refusal);
    const run = await expectOk('GET', `/v1/ai/runs/${answer.run_id}`);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.intent, null);
    assert.equal(run.confidence, 0);
    assert.equal(run.trace.filter((s: Body) => s.kind === 'tool').length, 0);
  });

  test('run lifecycle events name the run, and runs are listed newest first, filterable and org-scoped', async () => {
    const answer = await ask((await published()).find((t) => t.id === 'count-objects')!.example!);
    const started = app.ctx.events.list(ORG, { types: ['ai.run.started'], limit: 20 });
    const completed = app.ctx.events.list(ORG, { types: ['ai.run.completed'], limit: 20 });
    assert.ok(started.some((e) => e.object_id === answer.run_id), 'ai.run.started names the run');
    assert.ok(completed.some((e) => e.object_id === answer.run_id), 'ai.run.completed names the run');

    const list = await expectOk('GET', '/v1/ai/runs?limit=5');
    assert.ok(list.data.length > 0);
    assert.ok(list.total_count >= list.data.length);
    const timestamps = list.data.map((r: Body) => r.started);
    assert.deepEqual(timestamps, [...timestamps].sort((a, b) => b - a));
    const succeeded = await expectOk('GET', '/v1/ai/runs?status=succeeded&limit=3');
    assert.ok(succeeded.data.every((r: Body) => r.status === 'succeeded'));

    const theirs = await expectOk('GET', '/v1/ai/runs?limit=5', undefined, OTHER_ORG);
    assert.equal(theirs.data.length, 0, 'runs are org scoped');
    const stolen = await call('GET', `/v1/ai/runs/${answer.run_id}`, undefined, OTHER_ORG);
    assert.equal(stolen.status, 404);
  });

  test('token estimation and credit maths are stable and documented', () => {
    assert.equal(estimateTokens(''), 0);
    assert.ok(estimateTokens('hello world') >= 2);
    const long = estimateTokens('a'.repeat(4000));
    assert.ok(long > 400 && long < 1400, `estimate for 4k chars was ${long}`);
    const local = accountUsage(ENGINE_MODEL, 1000, 500);
    assert.equal(local.costMicros, 0, 'the local engine has no marginal cost');
    assert.equal(local.usage.credits, Math.ceil((1000 + 3 * 500) / 1000));
    const hosted = accountUsage('claude-sonnet-4-5', 1_000_000, 100_000);
    assert.equal(hosted.usage.costCents, 300 + 150);
    assert.ok(Number.isInteger(hosted.usage.costCents), 'money stays in integer minor units');
  });

  test('every run adds to the daily usage roll-up, and the roll-up tracks the runs it came from', async () => {
    const before = await expectOk('GET', '/v1/ai/usage?days=2');
    const answer = await ask((await published()).find((t) => t.id === 'count-objects')!.example!);
    const after = await expectOk('GET', '/v1/ai/usage?days=2');
    assert.equal(after.totals.runs, before.totals.runs + 1);
    assert.equal(after.totals.credits, before.totals.credits + answer.usage.credits);
    assert.equal(after.totals.cost_micros, before.totals.cost_micros, 'a local run costs nothing');
    assert.ok(after.by_day.length > 0);
    assert.ok(after.by_feature.some((f: Body) => f.key === 'copilot'));
    assert.ok(after.by_user.some((u: Body) => u.key === 'usr_seed01' && u.name === 'Dana Whitfield'));
    assert.ok(after.by_model.some((m: Body) => m.key === ENGINE_MODEL));
    const runs = await expectOk('GET', '/v1/ai/runs?limit=100');
    const credited = runs.data.reduce((sum: number, r: Body) => sum + r.usage.credits, 0);
    assert.ok(credited >= after.totals.credits - 1, 'the roll-up tracks the runs it came from');
  });

  test('status reports the active provider and what it can reach', async () => {
    const status = await expectOk('GET', '/v1/ai/status');
    assert.equal(status.provider.id, 'builtin', 'with no API key the built-in engine answers');
    assert.equal(status.provider.hosted, false);
    assert.equal(status.engine, 'template');
    assert.ok(status.providers.some((p: Body) => p.id === 'anthropic' && p.available === false));
    assert.equal(status.tools, (await expectOk('GET', '/v1/ai/tools')).total_count);
    assert.equal(status.metrics, (await expectOk('GET', '/v1/ai/metrics')).data.length);
    assert.equal(status.templates, (await published()).length);
    assert.ok(status.runs_today > 0);
  });
});

/* ========================== structured extraction ========================== */

describe('structured extraction fills a schema from the run\'s facts and never invents a field', () => {
  const withOpenDeals = (): Rec => {
    const found = recs('company').find((c) => associated(c.id, 'deal').filter(isOpen).length >= 2);
    assert.ok(found, 'fixture: an account with two open deals');
    return found!;
  };

  test('an account snapshot fills the subject, its id, the figure and the count, and leaves what it does not hold null', async () => {
    const account = withOpenDeals();
    const open = associated(account.id, 'deal').filter(isOpen);
    const schema = v.object({
      company: v.string(), company_id: v.string(), period: v.string(), amount: v.int(), currency: v.string(),
      deal_count: v.int(), sentiment: v.enum(['positive', 'neutral', 'negative'] as const), next_steps: v.array(v.string()),
    }).describe();
    const answer = await ask(`What is ${account.name}'s open pipeline?`, { response_schema: schema });
    assert.equal(answer.analysis.refusal, null, answer.content);
    const parsed = JSON.parse(answer.content);
    assert.equal(parsed.company, account.name);
    assert.equal(parsed.company_id, account.id);
    assert.equal(parsed.amount, total(open), 'the figure is the account\'s own open pipeline, from its deals');
    assert.equal(parsed.currency, 'usd');
    assert.equal(parsed.deal_count, open.length);
    assert.equal(parsed.period, null, 'a snapshot has no period, so none is invented');
    assert.equal(parsed.sentiment, null, 'nothing in the workspace scores sentiment');
    assert.deepEqual(parsed.next_steps, []);
    assert.ok(answer.reasoning.some((line: string) => /period/.test(line) && /null/.test(line)), 'the caller is told which fields were left null');
  });

  test('a JSON-Schema `properties` spelling is accepted, and an object schema naming no members is a 400', async () => {
    const answer = await ask('What is our open pipeline?', {
      response_schema: { type: 'object', properties: { risk: { type: 'string' }, score: { type: 'number' }, reason: { type: 'string' } } },
    });
    const value = JSON.parse(answer.content) as Record<string, unknown>;
    assert.deepEqual(Object.keys(value).sort(), ['reason', 'risk', 'score']);
    const res = await call('POST', '/v1/ai/complete', { prompt: 'What is our MRR?', response_schema: { type: 'object' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'response_schema_invalid');
    assert.match(res.body.error.message, /properties/);
  });

  test('a refused run fills nothing: every field is null or empty, and no figure is smuggled in', async () => {
    const answer = await ask('Score Meridian Forge Systems for expansion risk', {
      response_schema: { type: 'object', fields: { risk: { type: 'string' }, score: { type: 'number' }, reason: { type: 'string' }, deals: { type: 'array', of: { type: 'string' } } } },
    });
    assert.ok(answer.analysis.refusal, 'nothing in the workspace scores expansion risk');
    assert.deepEqual(JSON.parse(answer.content), { risk: null, score: null, reason: null, deals: [] });
  });

  test('a metric measured in three books fills no single-number field, and says so', async () => {
    const books = new Set(app.db.all<{ currency: string }>(`SELECT DISTINCT currency FROM billing_subscriptions WHERE org_id = ?`, ORG).map((r) => r.currency));
    assert.ok(books.size > 1, 'fixture: the workspace bills in more than one currency');
    const answer = await ask('What is our MRR?', {
      response_schema: { type: 'object', fields: { mrr: { type: 'number' }, currency: { type: 'string' }, summary: { type: 'string' } } },
    });
    const value = JSON.parse(answer.content) as { mrr: number | null; currency: string | null; summary: string | null };
    assert.equal(value.mrr, null, 'there is no single MRR figure, so there is no number to give');
    assert.equal(value.currency, null);
    assert.ok(answer.reasoning.some((line: string) => /left .*mrr.* null/.test(line)), `the omission is reported: ${answer.reasoning.join(' | ')}`);
  });

  test('a field named for the measure is filled with the run\'s one figure, whatever the caller calls it', async () => {
    const usd = app.ctx.svc.billing!.subscriptions(ORG, { status: 'all', limit: 500 })
      .filter((s) => s.currency === 'usd')
      .reduce((sum, s) => sum + app.ctx.svc.billing!.mrr(ORG, s), 0);
    assert.ok(usd > 0, 'fixture: a USD book');
    const one = await ask('What is our MRR in USD?', { response_schema: { type: 'object', fields: { mrr: { type: 'number' } } } });
    assert.equal(JSON.parse(one.content).mrr, usd);

    const owner = 'Marcus Ilori';
    const owned = recs('deal').filter((d) => d.owner === personId(owner) && isOpen(d));
    const answer = await ask(`How much open pipeline does ${owner} own?`, {
      response_schema: { type: 'object', properties: { owner: { type: 'string' }, open_pipeline_cents: { type: 'number' }, deal_count: { type: 'integer' } } },
    });
    const row = JSON.parse(answer.content) as { owner: string | null; open_pipeline_cents: number | null; deal_count: number | null };
    assert.equal(row.owner, owner);
    assert.equal(row.open_pipeline_cents, total(owned), 'the unit in the field name is not part of the measure');
    assert.equal(row.deal_count, owned.length);
  });

  test('one run, one figure: every name the reader has for the rows takes the count the prose states', async () => {
    const expected = recs('contact').filter((c) => str(c.p.buying_role) === 'economic_buyer').length;
    assert.ok(expected > 0, 'fixture: economic buyers exist');
    const prose = await ask('How many contacts are economic buyers?');
    assert.equal(prose.analysis.refusal, null, prose.content);
    assert.match(prose.content, new RegExp(`\\b${expected}\\b`));
    const answer = await ask('How many contacts are economic buyers?', {
      response_schema: { type: 'object', properties: { count: { type: 'number' }, contact_count: { type: 'number' }, economic_buyer_count: { type: 'number' }, buyers: { type: 'number' }, total: { type: 'number' } } },
    });
    for (const [field, held] of Object.entries(JSON.parse(answer.content) as Record<string, number | null>)) {
      assert.equal(held, expected, `\`${field}\` came back ${JSON.stringify(held)} out of a run whose prose says ${expected}`);
    }
    const booked = wonBetween(quarterOf(quarterOf(app.ctx.now()).start - 1).start, quarterOf(app.ctx.now()).start);
    const bookings = await ask('How much did we book last quarter?', {
      response_schema: { type: 'object', properties: { bookings: { type: 'number' }, amount: { type: 'number' } } },
    });
    const value = JSON.parse(bookings.content) as { bookings: number | null; amount: number | null };
    assert.equal(value.bookings, total(booked));
    assert.equal(value.amount, total(booked));
  });

  test('a deal\'s amount is that deal\'s amount, never the pipeline it sits in', async () => {
    const deal = [...recs('deal').filter(isOpen)].sort((a, b) => amount(b) - amount(a))[0];
    const answer = await ask(`How much is ${deal.name} worth?`, {
      response_schema: { type: 'object', fields: { deal_name: { type: 'string' }, amount: { type: 'number' } } },
    });
    assert.equal(answer.analysis.refusal, null, answer.content);
    const value = JSON.parse(answer.content) as { deal_name: string | null; amount: number | null };
    assert.equal(value.amount, amount(deal));
    assert.notEqual(value.amount, total(recs('deal').filter(isOpen)));
    assert.equal(value.deal_name, deal.name);
  });

  test('an array schema returns the rows the run listed, each a record that exists', async () => {
    const label = app.db.pluck<string>(`SELECT label FROM crm_pipeline_stages WHERE org_id = ? AND object_type = 'deal' AND name = 'negotiation' LIMIT 1`, ORG)!;
    const answer = await ask(`Which deals are at the ${label} stage?`, {
      response_schema: { type: 'array', items: { type: 'object', fields: { name: { type: 'string' } } } },
    });
    assert.equal(answer.analysis.refusal, null, answer.content);
    const rows = JSON.parse(answer.content) as { id: string; name: string }[];
    const atStage = new Set(recs('deal').filter((d) => str(d.p.deal_stage) === 'negotiation').map((d) => d.id));
    assert.ok(atStage.size > 0, 'fixture: deals at the stage');
    assert.equal(rows.length, answer.citations.length, 'the array is the rows the answer cites');
    assert.ok(rows.length > 0 && !(rows.length === 1 && rows[0].name === null), 'one all-null row is a shape, not an answer');
    for (const row of rows) {
      assert.ok(atStage.has(row.id), `${row.name} (${row.id}) is not at that stage`);
      assert.equal(row.name, recs('deal').find((d) => d.id === row.id)?.name);
    }
  });
});

/* ================================= drafting ================================ */

describe('drafting writes from the record, or says it has nothing to write from', () => {
  /** Every number an account's own records could put into a message written from them. */
  function accountUniverse(c: Rec, now: number): unknown[] {
    const out: unknown[] = [c.name];
    const push = (p: Props) => {
      for (const value of Object.values(p)) {
        if (typeof value === 'number') {
          out.push(value, value.toLocaleString('en-US'), money(value), day(value), day(value, TZ),
            Math.floor((now - value) / DAY), Math.round((value - now) / DAY), Math.abs(Math.round((now - value) / DAY)));
        } else if (typeof value === 'string') out.push(value);
      }
    };
    push(c.p);
    for (const type of ['contact', 'deal', 'ticket', 'note', 'call', 'meeting', 'email', 'task']) {
      for (const r of associated(c.id, type)) { out.push(r.name); push(r.p); }
    }
    const ids = customerIds(c.id);
    if (ids.length) {
      for (const inv of app.db.all<{ number: string; total: number; amount_due: number; currency: string; due_date: number | null }>(
        `SELECT number, total, amount_due, currency, due_date FROM billing_invoices WHERE org_id = ? AND customer_id IN (${ids.map(() => '?').join(', ')})`, ORG, ...(ids as never[]))) {
        out.push(inv.number, money(inv.total, inv.currency), money2(inv.total, inv.currency), money2(inv.amount_due, inv.currency));
        if (inv.due_date) out.push(day(inv.due_date), Math.floor((now - inv.due_date) / DAY));
      }
    }
    const open = associated(c.id, 'deal').filter(isOpen);
    const won = associated(c.id, 'deal').filter(isWon);
    out.push(money(total(open)), open.length, money(total(won)), won.length, associated(c.id, 'contact').length);
    return out;
  }

  const customer = (): Rec => {
    const found = recs('company').find((c) => str(c.p.type) === 'customer' && customerIds(c.id).length);
    assert.ok(found, 'fixture: a customer with a billing account');
    return found!;
  };

  test('a renewal email is personalised from the account record, and every number in it is the record\'s own', async () => {
    const account = customer();
    const draft = await expectOk('POST', '/v1/ai/draft', { instruction: 'Write a renewal email', record_id: account.id, tone: 'formal' });
    assert.equal(draft.channel, 'email');
    assert.equal(draft.kind, 'renewal');
    assert.ok(draft.subject.includes(account.name));
    assert.match(draft.body, /^Dear /m, 'a formal tone opens formally');
    assert.ok(draft.personalisation.length > 0, 'the draft lists the facts it used');
    assert.ok(draft.personalisation.some((p: string) => p.includes(account.name)));
    assertOnlyTheseNumbers(draft.body, allow(...accountUniverse(account, app.ctx.now())), 'a renewal email');
    assert.doesNotMatch(draft.body, RAW_ID);
  });

  test('a drafting question through the engine produces a message, not a report, from the same records', async () => {
    const account = customer();
    const answer = await ask(`Draft a warm check-in email to ${account.name}`);
    assert.equal(answer.analysis.refusal, null, answer.content);
    assert.equal(answer.analysis.template?.kind, 'draft');
    assert.match(answer.content, /^Subject: /);
    assert.deepEqual(answer.tool_calls.map((c: Body) => c.name), ['compose_message']);
    assert.equal(answer.tool_calls[0].arguments.kind, 'check_in');
    assert.equal(answer.tool_calls[0].arguments.tone, 'warm');
    assert.equal(answer.tool_calls[0].arguments.record_id, account.id);
    assertOnlyTheseNumbers(answer.content, allow(...accountUniverse(account, app.ctx.now())), 'a check-in email');
  });

  test('a call summary is built from the calls on the timeline, newest first', async () => {
    const calls = recs('call').map((c) => ({ call: c, company: recs('company').find((k) => linkedIds(c.id).has(k.id)) })).filter((x) => x.company);
    assert.ok(calls.length, 'fixture: a company with a logged call');
    const byCompany = new Map<string, Rec[]>();
    for (const { call: c, company } of calls) byCompany.set(company!.id, [...(byCompany.get(company!.id) ?? []), c]);
    const [companyId, logged] = [...byCompany.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const newest = [...logged].sort((a, b) => (num(b.p.occurred_at) || b.created) - (num(a.p.occurred_at) || a.created))[0];
    const draft = await expectOk('POST', '/v1/ai/draft', { instruction: 'Give me the call summary', record_id: companyId });
    assert.equal(draft.kind, 'call_summary');
    assert.equal(draft.channel, 'note');
    assert.ok(draft.body.includes(str(newest.p.subject) || newest.name), `the newest call on the record is in the summary:\n${draft.body}`);
  });

  test('an urgent draft with no contact still opens with a greeting', async () => {
    const draft = await expectOk('POST', '/v1/ai/draft', { instruction: 'Draft an urgent email about the outage', tone: 'urgent' });
    assert.equal(draft.recipient, null);
    assert.ok(!/^there,/m.test(draft.body), `a message that opens "there," is not a greeting:\n${draft.body}`);
    assert.match(draft.body, /^(Hi|Dear|Hello)\b/m);
  });

  test('a dunning note names the invoices, the amounts and the dates the recipient needs to act', async () => {
    const billing = app.ctx.svc.billing!;
    const withDue = recs('company').map((c) => ({
      company: c,
      open: customerIds(c.id).flatMap((id) => billing.invoices(ORG, { customer: id, status: 'open_like', limit: 20 })).filter((i) => i.amount_due > 0),
    })).find((x) => x.open.length);
    assert.ok(withDue, 'fixture: an account with an unpaid invoice');
    const draft = await expectOk('POST', '/v1/ai/draft', { kind: 'dunning', record_id: withDue!.company.id, instruction: 'Chase the outstanding invoice' });
    assert.equal(draft.kind, 'dunning');
    for (const invoice of withDue!.open) {
      assert.ok(draft.body.includes(invoice.number), `${invoice.number} is not in the note:\n${draft.body}`);
      assert.ok(draft.body.includes(money2(invoice.amount_due, invoice.currency)), `${money2(invoice.amount_due, invoice.currency)} is not in the note:\n${draft.body}`);
      if (invoice.due_date) assert.ok(draft.body.includes(day(invoice.due_date)), `the due date is not in the note:\n${draft.body}`);
    }
    // Every invoice number the note names is one of that account's unpaid bills.
    const numbers = draft.body.match(/\bNR-\d+\b/g) ?? [];
    assert.deepEqual([...new Set(numbers)].sort(), withDue!.open.map((i) => i.number).sort());
  });

  test('a dunning note never asserts an invoice that does not exist', async () => {
    const billing = app.ctx.svc.billing!;
    const nothingDue = recs('company').find((c) => {
      const ids = customerIds(c.id);
      return !ids.length || ids.every((id) => !billing.invoices(ORG, { customer: id, status: 'open_like', limit: 5 }).some((i) => i.amount_due > 0));
    });
    assert.ok(nothingDue, 'fixture: an account with no unpaid invoice');
    const settled = await expectOk('POST', '/v1/ai/draft', { kind: 'dunning', record_id: nothingDue!.id, instruction: 'Chase the outstanding invoice' });
    assert.equal(settled.kind, 'dunning');
    assert.deepEqual(settled.body.match(/\bNR-\d+\b/g) ?? [], [], 'there is no such invoice on this account, so none is named');
    assert.deepEqual(settled.personalisation, []);
    assert.ok(settled.body.includes(nothingDue!.name));

    const nobody = await expectOk('POST', '/v1/ai/draft', { kind: 'dunning', instruction: 'Write a dunning letter about the overdue invoice.' });
    assert.deepEqual(nobody.body.match(/\bNR-\d+\b/g) ?? [], [], 'no account was named, so no invoice was read');
    assert.equal(nobody.recipient, null);
    assertOnlyTheseNumbers(nobody.body, allow(), 'a chase with no account');

    // Naming the account in the instruction is enough to read its ledger.
    const withDue = recs('company').map((c) => ({
      company: c,
      open: customerIds(c.id).flatMap((id) => billing.invoices(ORG, { customer: id, status: 'open_like', limit: 20 })).filter((i) => i.amount_due > 0),
    })).find((x) => x.open.length)!;
    const named = await expectOk('POST', '/v1/ai/draft', { instruction: `Write a dunning letter to ${withDue.company.name} about their overdue invoice.` });
    assert.equal(named.kind, 'dunning');
    assert.ok(withDue.open.some((i) => named.body.includes(i.number)), `the account's real invoice is cited:\n${named.body}`);
  });

  test('an escalation update has content where its heading promises content', async () => {
    const withTicket = recs('company').find((c) => associated(c.id, 'ticket').some((t) => ['new', 'waiting_on_us', 'waiting_on_customer', 'escalated'].includes(str(t.p.status))));
    assert.ok(withTicket, 'fixture: an account with an open ticket');
    const draft = await expectOk('POST', '/v1/ai/draft', { kind: 'escalation_update', record_id: withTicket!.id, instruction: 'Update them on the escalation' });
    const standing = draft.body.split('\n').find((line: string) => line.startsWith('Where it stands: '));
    assert.ok(standing, `the update says where it stands:\n${draft.body}`);
    assert.ok(standing!.length > 'Where it stands: '.length + 20, 'and the sentence after the heading is a sentence');
  });
});

/* ============================ the hosted provider ============================ */

describe('the hosted provider', () => {
  test('is unavailable without a key, so the built-in engine answers', () => {
    const provider = app.ctx.ai.providers.find((p) => p.id === 'anthropic')!;
    assert.ok(provider, 'the Anthropic provider is registered');
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(provider.available(), false);
    assert.equal(app.ctx.ai.active().id, 'builtin');
  });

  test('maps conversations, tool calls and tool results onto the wire format', () => {
    const wire = toWire([
      { role: 'assistant', content: 'ignored leading turn' },
      { role: 'system', content: 'be useful' },
      { role: 'user', content: 'what is our pipeline?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tu_1', name: 'business_metric', arguments: { metric: 'pipeline' } }] },
      { role: 'tool', content: '{"value":100}', tool_call_id: 'tu_1' },
    ]);
    assert.equal(wire.system, 'be useful');
    assert.equal(wire.messages[0].role, 'user', 'a leading assistant turn is dropped');
    const toolUse = wire.messages[1].content as { type: string; name?: string }[];
    assert.equal(toolUse[0].type, 'tool_use');
    assert.equal(toolUse[0].name, 'business_metric');
    const toolResult = wire.messages[2].content as { type: string; tool_use_id?: string }[];
    assert.equal(toolResult[0].type, 'tool_result');
    assert.equal(toolResult[0].tool_use_id, 'tu_1');
    const schemas = toWireTools(app.ctx.ai.tools({ readOnly: true }).slice(0, 2));
    assert.equal(schemas.length, 2);
    assert.equal(schemas[0].input_schema.type, 'object');
    assert.ok(schemas[0].description.length > 20);
  });

  test('runs the real HTTP tool-use loop, streams, goes through the same tool runtime, and never leaks the key', async () => {
    const received: { key: string | undefined; body: Body }[] = [];
    const text = 'Open pipeline is what the tool returned.';
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        received.push({ key: req.headers['x-api-key'] as string | undefined, body });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = received.length === 1
          ? [
              { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: { input_tokens: 900 } } },
              { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'business_metric' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"metric":"pipeline"}' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
            ]
          : [
              { type: 'message_start', message: { id: 'msg_2', model: 'claude-sonnet-4-5', usage: { input_tokens: 1200 } } },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 60 } },
            ];
        res.end(events.map((event) => `data: ${JSON.stringify(event)}`).concat('').join('\n\n'));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    try {
      const provider = anthropicProvider(app.ctx.config);
      assert.equal(provider.available(), true, 'a key makes the hosted provider available');
      const deltas: string[] = [];
      tick();
      const context = callContext({ runId: 'run_hosted_probe', budget: { steps: 4 }, onDelta: (chunk) => deltas.push(chunk) });
      context.runtime = runtime();
      app.db.insert('ai_runs', {
        id: 'run_hosted_probe', org_id: ORG, thread_id: null, feature: 'test', provider: 'anthropic',
        model: 'claude-sonnet-4-5', actor_id: 'usr_seed01', actor_type: 'user', status: 'running',
        question: 'pipeline', answer: '', reasoning: '[]', citations: '[]', started: app.ctx.now(),
      });

      const completion = await provider.complete({
        messages: [{ role: 'user', content: 'What is our open pipeline?' }],
        tools: app.ctx.ai.tools({ readOnly: true }),
      }, context);

      assert.equal(received.length, 2, 'the loop ran the tool and came back for the answer');
      assert.equal(received[0].key, FAKE_KEY, 'the key travels in the header');
      assert.ok(received[0].body.stream, 'a caller that wants deltas gets a stream');
      assert.ok(received[0].body.tools.some((t: Body) => t.name === 'business_metric'));
      assert.equal(received[0].body.model, 'claude-sonnet-4-5');
      assert.ok(received[1].body.messages.some((m: Body) => Array.isArray(m.content) && m.content.some((b: Body) => b.type === 'tool_result')),
        'the tool result was fed back to the model');

      assert.equal(completion.content, text);
      assert.equal(completion.model, 'claude-sonnet-4-5');
      assert.equal(completion.toolCalls[0].name, 'business_metric');
      assert.equal(completion.usage.inputTokens, 2100);
      assert.equal(completion.usage.outputTokens, 100);
      assert.equal(completion.usage.costCents, accountUsage('claude-sonnet-4-5', 2100, 100).usage.costCents);
      assert.ok(deltas.join('').includes('Open pipeline'), 'text arrived as stream deltas');

      const executed = context.spans!.filter((s) => s.kind === 'tool' && s.name === 'business_metric');
      assert.equal(executed.length, 1, 'the hosted provider goes through the same tool runtime');
      assert.equal(executed[0].ok, true);
      assert.ok(!JSON.stringify({ reasoning: completion.reasoning, spans: context.spans }).includes(FAKE_KEY), 'the key never reaches the trace');
      const stored = app.db.all<{ args: string; summary: string }>(`SELECT args, summary FROM ai_spans WHERE run_id = 'run_hosted_probe'`);
      assert.ok(stored.length > 0, 'spans from a hosted run are persisted like any other');
      assert.ok(!JSON.stringify(stored).includes(FAKE_KEY));
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('a provider error surfaces as an API error with the key scrubbed', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `invalid key ${FAKE_KEY}` } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const provider = anthropicProvider(app.ctx.config);
      await assert.rejects(
        () => provider.complete({ messages: [{ role: 'user', content: 'hello' }] }, callContext()),
        (error: Error) => {
          assert.match(error.message, /401/);
          assert.ok(!error.message.includes(FAKE_KEY), 'the key is scrubbed from provider errors');
          return true;
        },
      );
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/* ====================== the provider degrades, never dies ====================== */

describe('a failing provider degrades to the local engine instead of taking the product down', () => {
  type Handler = (req: IncomingMessage, res: ServerResponse) => void;

  async function withProvider(handler: Handler | null, run: () => Promise<void>) {
    const server = handler ? createServer(handler) : null;
    if (server) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server ? (server.address() as AddressInfo).port : 1;
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    try { await run(); }
    finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test('a 401 from the hosted provider still answers, from the workspace, and the record names who answered', async () => {
    await withProvider((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } }));
    }, async () => {
      assert.equal(app.ctx.ai.active().id, 'anthropic', 'the hosted provider is preferred while a key is set');
      const answer = await ask('How much did we book last quarter?');
      const window = quarterOf(quarterOf(app.ctx.now()).start - 1);
      assert.equal(answer.provider, 'builtin', 'a bad key degrades the answer instead of 401ing the surface');
      assert.equal(answer.model, ENGINE_MODEL);
      assert.equal(answer.degraded.provider, 'anthropic');
      assert.equal(answer.degraded.answeredBy, 'builtin');
      assert.match(answer.degraded.message, /401/);
      assert.ok(!answer.degraded.message.includes(FAKE_KEY), 'the key never reaches the degradation notice');
      assert.equal(answer.analysis.refusal, null, answer.content);
      assert.ok(answer.content.includes(money(total(wonBetween(window.start, window.end)))), 'the local engine answered the question for real');
      assert.match(answer.reasoning[0], /Answered by builtin instead — this answer is degraded/);
      const failedSpan = answer.trace.find((s: Body) => s.kind === 'provider' && s.name === 'anthropic' && !s.ok);
      assert.ok(failedSpan, 'the failed provider is on the trace');
      assert.match(String(failedSpan.error?.message), /401/);
      assert.ok(!JSON.stringify(failedSpan).includes(FAKE_KEY));
      const stored = await expectOk('GET', `/v1/ai/runs/${answer.run_id}`);
      assert.equal(stored.status, 'succeeded');
      assert.equal(stored.provider, 'builtin');
      assert.equal(stored.model, ENGINE_MODEL);
      assert.equal(stored.usage.cost_micros, 0, 'a local answer is never billed at hosted rates');
      assert.ok(!JSON.stringify(stored).includes(FAKE_KEY));
    });
  });

  test('an unreachable provider degrades the same way', async () => {
    await withProvider(null, async () => {
      const answer = await ask('What is our open pipeline?');
      assert.equal(answer.provider, 'builtin');
      assert.equal(answer.degraded.provider, 'anthropic');
      assert.match(answer.degraded.code, /ai_provider_(unreachable|error)/);
      assert.equal(answer.analysis.refusal, null, answer.content);
      assert.ok(answer.content.includes(money(total(recs('deal').filter(isOpen)))));
    });
  });

  test('the AI surface stays up while the hosted provider is down', async () => {
    await withProvider((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'overloaded' } }));
    }, async () => {
      for (const path of ['/v1/ai/status', '/v1/ai/tools', '/v1/ai/suggestions', '/v1/ai/metrics', '/v1/ai/templates']) {
        const res = await call('GET', path);
        assert.equal(res.status, 200, `${path} went down with the provider`);
      }
      const status = await expectOk('GET', '/v1/ai/status');
      assert.ok(status.providers.some((p: Body) => p.id === 'builtin' && p.available));
      const answer = await ask('Which customers are past due?');
      assert.equal(answer.provider, 'builtin');
      assert.equal(answer.degraded.answeredBy, 'builtin');
      assert.equal(answer.analysis.refusal, null, answer.content);
    });
  });
});

/* ================================= writes ================================== */

describe('a write to a customer record is approved by a person and never carries the prompt', () => {
  const rheinwerk = () => byName('company', 'Rheinwerk Antriebstechnik');

  test('add_note stops at the approval gate and composes the note, never the instruction; approving lands exactly that note', async () => {
    const account = rheinwerk();
    const before = noteCount();
    const instruction = `Add a note to ${account.name} saying the pilot slipped to October`;
    const answer = await ask(instruction, { allow_writes: true });
    assert.equal(answer.finish_reason, 'tool_calls');
    assert.equal(answer.pending_approvals.length, 1, 'a customer-visible write never runs unasked');
    const pending = answer.pending_approvals[0];
    assert.equal(pending.tool, 'add_note');
    assert.equal(pending.readOnly, false);
    assert.deepEqual(pending.args.record_ids, [account.id]);
    assert.equal(pending.args.body, 'The pilot slipped to October.');
    assert.equal(pending.args.subject, 'Pilot slipped to October');
    assert.notEqual(String(pending.args.body).trim(), instruction);
    assert.equal(noteCount(), before, 'nothing is written while the approval waits');
    assert.deepEqual(answer.tool_calls, []);
    assert.ok(!/^Done/.test(answer.content));

    const queue = await expectOk('GET', '/v1/ai/approvals');
    const approval = queue.data.find((a: Body) => a.run_id === answer.run_id);
    assert.ok(approval, 'the gate raised an approval request a person can see');
    assert.deepEqual(approval.args.record_ids, [account.id]);
    assert.ok(approval.preview.some((line: string) => line.includes(account.name)), 'the card names the record');
    assert.ok(!approval.preview.some((line: string) => RAW_ID.test(line)), 'the card shows no raw id');
    assert.ok(app.ctx.events.list(ORG, { types: ['ai.approval.requested'], limit: 10 }).some((e) => e.object_id === approval.id));

    const decided = await expectOk('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(decided.status, 'approved');
    assert.equal(decided.executed, true);
    assert.equal(noteCount(), before + 1);
    const note = app.db.get<{ display_name: string; properties: string }>(
      `SELECT display_name, properties FROM crm_records WHERE org_id = ? AND object_type = 'note' ORDER BY created DESC, rowid DESC LIMIT 1`, ORG)!;
    assert.equal((JSON.parse(note.properties) as { body?: string }).body, 'The pilot slipped to October.');
    assert.ok(app.ctx.events.list(ORG, { types: ['ai.approval.granted'], limit: 10 }).some((e) => e.object_id === approval.id));
    const run = await expectOk('GET', `/v1/ai/runs/${answer.run_id}`);
    assert.equal(run.status, 'succeeded', 'the run finishes once its only write has landed');
    assert.equal(run.span_count, run.trace.length);
  });

  test('a read-only run prepares no write at all and says how to ask for one', async () => {
    const before = noteCount();
    const answer = await ask(`Add a note to ${rheinwerk().name} saying the pilot slipped to October`);
    assert.deepEqual(answer.pending_approvals, []);
    assert.deepEqual(answer.tool_calls, []);
    assert.equal(answer.analysis.write_blocked?.wanted, 'add_note');
    assert.match(answer.content, /allow_writes/);
    assert.ok(!/^Done/.test(answer.content));
    assert.equal(noteCount(), before);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM ai_approvals WHERE org_id = ? AND run_id = ?`, ORG, answer.run_id), 0);
  });

  test('an instruction with no note in it is refused, never reported as done and never queued', async () => {
    const before = noteCount();
    for (const instruction of [`Add a note to ${rheinwerk().name}`, 'Add a note', 'Update the Rheinwerk deal']) {
      const answer = await ask(instruction, { allow_writes: true });
      assert.ok(answer.analysis.refusal, `"${instruction}" was answered: ${answer.content}`);
      assert.deepEqual(answer.pending_approvals, []);
      assert.deepEqual(answer.tool_calls, []);
      assert.ok(!/^Done/.test(answer.content));
    }
    assert.equal(noteCount(), before);
  });

  test('a write that ran and failed says so and names the failure; one that landed says Done and names the record', async () => {
    const account = rheinwerk();
    const failing = {
      name: 'add_note',
      description: 'Write a note onto the timeline of a CRM record.',
      readOnly: false,
      input: v.object({ record_ids: v.array(v.string({ max: 80 }), { min: 1, max: 20 }), subject: v.optional(v.string({ max: 300 })), body: v.string({ min: 1, max: 20_000 }) }),
      run: () => { throw new Error('the timeline is read-only during the migration'); },
    };
    tick();
    const before = noteCount();
    const failed = await app.ctx.svc.ai!.complete(ORG, {
      messages: [{ role: 'user', content: `Add a note to ${account.name} saying the migration window opens on Monday` }],
      tools: [failing],
    }, { allowWrites: true, approvals: ['add_note'], actorId: 'usr_seed01' });
    assert.ok(!/^Done/.test(failed.content), `a failed write reported success: ${failed.content}`);
    assert.match(failed.content, /the timeline is read-only during the migration/);
    assert.equal(failed.analysis?.writeBlocked?.wanted, 'add_note');
    assert.deepEqual(failed.toolCalls, []);
    assert.equal(noteCount(), before);

    const landed = await ask(`Add a note to ${account.name} saying "The acceptance run finished clean."`, { allow_writes: true, approvals: ['add_note'] });
    assert.ok(landed.content.startsWith(`Done — note on ${account.name}`), landed.content);
    assert.deepEqual(landed.tool_calls.map((c: Body) => c.name), ['add_note']);
    assert.equal(noteCount(), before + 1);
    assert.doesNotMatch(landed.content, RAW_ID);
  });
});

describe('an approval re-validates its arguments and its target before it executes', () => {
  const approvalRow = (id: string) => app.db.get<{ status: string; outcome: string | null }>(
    `SELECT status, outcome FROM ai_approvals WHERE org_id = ? AND id = ?`, ORG, id)!;

  async function queued(account: string, phrase: string): Promise<Body> {
    const answer = await ask(`Add a note to ${account} saying "${phrase}"`, { allow_writes: true });
    const queue = await expectOk('GET', '/v1/ai/approvals');
    const approval = queue.data.find((a: Body) => a.run_id === answer.run_id);
    assert.ok(approval, `precondition: the write did not stop at the approval gate (${answer.content})`);
    return approval;
  }

  test('arguments that went stale between proposal and approval are declined, not run', async () => {
    const before = noteCount();
    const approval = await queued('Rheinwerk Antriebstechnik', 'The shipment cleared customs.');
    app.db.run(`UPDATE ai_approvals SET args = ? WHERE org_id = ? AND id = ?`,
      JSON.stringify({ record_ids: [], subject: 'Shipment cleared customs', body: 'The shipment cleared customs.' }), ORG, approval.id);
    const res = await call('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(res.status, 400, 'a malformed write is refused at execution time, not only at proposal time');
    assert.equal(res.body.error.code, 'approval_arguments_invalid');
    assert.equal(res.body.error.param, 'args');
    assert.equal(noteCount(), before);
    assert.equal(approvalRow(approval.id).status, 'declined');
    assert.match(String(approvalRow(approval.id).outcome), /^Blocked: /);
    assert.ok(app.ctx.events.list(ORG, { types: ['ai.approval.declined'], limit: 5 }).some((e) => (e.data as { id?: string }).id === approval.id));
  });

  test('a record deleted while the approval waits is not written to, and the approval is finished rather than stranded', async () => {
    const company = await expectOk('POST', '/v1/records/company', { properties: { name: 'Tolvaneer Kraftwerk', domain: 'tolvaneer.de', type: 'customer' } });
    const before = noteCount();
    const approval = await queued('Tolvaneer Kraftwerk', 'The shipment cleared customs.');
    assert.deepEqual(approval.args.record_ids, [company.id]);
    assert.ok(approval.preview.some((line: string) => line.includes('Tolvaneer Kraftwerk')));
    assert.equal((await call('DELETE', `/v1/records/company/${company.id}`)).status, 204);

    const res = await call('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(res.status, 400, 'approving a write onto a record that is gone must fail');
    assert.equal(res.body.error.code, 'approval_target_changed');
    assert.match(res.body.error.message, /Tolvaneer Kraftwerk/);
    assert.equal(noteCount(), before, 'nothing was written');
    assert.equal(app.db.count(`SELECT COUNT(*) FROM crm_associations WHERE org_id = ? AND (from_id = ? OR to_id = ?)`, ORG, company.id, company.id), 0);
    assert.equal(approvalRow(approval.id).status, 'declined', 'a claim that ends in a decline is a finished decision, not a held lock');
    assert.ok(app.ctx.events.list(ORG, { types: ['ai.approval.declined'], limit: 5 }).some((e) => (e.data as { reason?: string }).reason === 'target_changed'));
    assert.equal((await call('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' })).body.error.code, 'approval_decided');
  });

  test('an approval whose target is still there executes and writes exactly one note', async () => {
    const before = noteCount();
    const approval = await queued('Brightline Foods', 'The acceptance run finished clean.');
    const res = await expectOk('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(res.executed, true, 'a live target is not blocked by the freshness check');
    assert.equal(noteCount(), before + 1);
  });

  test('an approval whose tool is no longer registered is declined rather than executed', async () => {
    const runId = `run_retired_${app.ctx.now()}`;
    app.db.insert('ai_runs', {
      id: runId, org_id: ORG, thread_id: null, feature: 'test', provider: 'builtin', model: ENGINE_MODEL,
      actor_id: 'usr_seed01', actor_type: 'user', status: 'needs_approval', question: 'retired tool', answer: '',
      reasoning: '[]', citations: '[]', started: app.ctx.now(),
    });
    const id = `appr_retired_${app.ctx.now()}`;
    app.db.insert('ai_approvals', {
      id, org_id: ORG, run_id: runId, thread_id: null, tool: 'retired_integration_write',
      args: JSON.stringify({ record_ids: [byName('company', 'Brightline Foods').id], body: 'anything' }),
      reason: 'left over from a plugin that has been uninstalled', status: 'pending',
      outcome: null, requested_by: 'usr_seed01', decided_by: null, decided_at: null, created: app.ctx.now(),
    });
    const res = await call('POST', `/v1/ai/approvals/${id}`, { decision: 'approve' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'tool_unavailable');
    assert.equal(approvalRow(id).status, 'declined');
    assert.match(String(approvalRow(id).outcome), /no tool named "retired_integration_write"/);
  });

  test('a declined approval cannot be revived by approving it again', async () => {
    const before = noteCount();
    const approval = await queued('Rheinwerk Antriebstechnik', 'The acceptance test passed.');
    const declined = await expectOk('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'decline', note: 'Not this quarter' });
    assert.equal(declined.status, 'declined');
    const again = await call('POST', `/v1/ai/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'approval_decided');
    assert.equal(noteCount(), before);
  });
});

describe('an approval executes once, whoever presses it and however often', () => {
  const target = () => byName('company', 'Rheinwerk Antriebstechnik');

  async function queued(phrase: string): Promise<string> {
    const answer = await ask(`Add a note to ${target().name} saying "${phrase}"`, { allow_writes: true });
    const row = app.db.get<{ id: string }>(`SELECT id FROM ai_approvals WHERE org_id = ? AND run_id = ? AND status = 'pending'`, ORG, answer.run_id);
    assert.ok(row, `precondition: the write did not stop at the approval gate (${answer.content})`);
    return row!.id;
  }
  const decide = (id: string, decision: 'approve' | 'decline') => call('POST', `/v1/ai/approvals/${id}`, { decision });

  test('two people pressing Approve at once write to the customer once, not twice', async () => {
    const id = await queued('The shipment cleared customs on Tuesday');
    const before = noteCount();
    const [a, b] = await Promise.all([decide(id, 'approve'), decide(id, 'approve')]);
    assert.equal(noteCount() - before, 1, `one approval put ${noteCount() - before} notes on the timeline`);
    assert.deepEqual([a.status, b.status].sort(), [200, 400], 'exactly one caller may execute the write');
    assert.equal(app.db.count(`SELECT COUNT(*) FROM events WHERE org_id = ? AND type = 'ai.approval.granted' AND object_id = ?`, ORG, id), 1);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM audit_log WHERE org_id = ? AND target_id = ?`, ORG, id), 1);
    assert.equal(app.db.pluck<string>(`SELECT status FROM ai_approvals WHERE id = ?`, id), 'approved');
  });

  test('approve racing decline resolves one way, and the write matches the answer', async () => {
    const id = await queued('Heike confirmed the site survey date');
    const before = noteCount();
    const [x, y] = await Promise.all([decide(id, 'approve'), decide(id, 'decline')]);
    assert.deepEqual([x.status, y.status].sort(), [200, 400]);
    const status = app.db.pluck<string>(`SELECT status FROM ai_approvals WHERE id = ?`, id);
    assert.equal(noteCount() - before, status === 'approved' ? 1 : 0, `the record says "${status}" and the timeline disagrees`);
  });

  test('two declines land one decline, and a single decision is final', async () => {
    const id = await queued('Spare parts stock was replenished on Friday');
    const before = noteCount();
    const [p, q] = await Promise.all([decide(id, 'decline'), decide(id, 'decline')]);
    assert.deepEqual([p.status, q.status].sort(), [200, 400]);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM events WHERE org_id = ? AND type = 'ai.approval.declined' AND object_id = ?`, ORG, id), 1);
    assert.equal(noteCount() - before, 0);

    const single = await queued('The acceptance test is booked for the 14th');
    const approved = await expectOk('POST', `/v1/ai/approvals/${single}`, { decision: 'approve' });
    assert.equal(approved.executed, true, 'claiming the row stopped the very caller who claimed it');
    assert.equal(noteCount() - before, 1);
    const again = await decide(single, 'approve');
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'approval_decided');
    assert.equal(noteCount() - before, 1, 'pressing Approve a second time wrote a second time');
  });

  test('two different writes in one run are two cards, and the same write twice is one', async () => {
    const [first, second] = recs('company').sort((a, b) => a.name.localeCompare(b.name)).slice(0, 2);
    tick();
    const context = callContext({ allowWrites: true, approvals: [] });
    const a = await runtime().execute('add_note', { record_ids: [first.id], body: 'The pilot line passed acceptance.' }, context);
    const b = await runtime().execute('add_note', { record_ids: [second.id], body: 'The commissioning date moved to March.' }, context);
    await runtime().execute('add_note', { record_ids: [first.id], body: 'The pilot line passed acceptance.' }, context);
    assert.equal(a.error?.code, 'approval_required');
    assert.equal(b.error?.code, 'approval_required');
    const rows = app.db.all<{ id: string; args: string }>(`SELECT id, args FROM ai_approvals WHERE org_id = ? AND run_id = ? AND status = 'pending'`, ORG, context.runId!);
    assert.equal(rows.length, 2, 'two writes are two cards; the repeat is not a third');
    assert.deepEqual(rows.map((r) => (JSON.parse(r.args) as { record_ids: string[] }).record_ids[0]).sort(), [first.id, second.id].sort());
    const before = noteCount();
    for (const row of rows) assert.equal((await expectOk('POST', `/v1/ai/approvals/${row.id}`, { decision: 'approve' })).executed, true);
    assert.equal(noteCount() - before, 2, 'two approved writes did not produce two notes');
  });
});

/* ============================ authority and actors ============================ */

describe('the copilot carries no more authority than its caller, and a key acts as its author', () => {
  const company = () => byName('company', 'Rheinwerk Antriebstechnik');
  const KEY = `sk_test_${'ain_demo_workspace_key_0001'}`;
  const withKey = (method: string, path: string, body?: unknown) =>
    app.handle({ method, path, body, headers: { authorization: `Bearer ${KEY}` } });

  test('a role refused the write route cannot make the identical write through the copilot, on either route', async () => {
    const target = company();
    const direct = await call('POST', `/v1/records/company/${target.id}/activities`, { type: 'note', subject: 'Escalation probe', body: 'Written straight at the CRM.' }, READONLY);
    assert.equal(direct.status, 403, 'the CRM route is the baseline: readonly cannot log an activity');
    const before = noteCount();
    tick();
    const through = await call('POST', '/v1/ai/complete', { prompt: `Add a note to ${target.name} saying "Written through the copilot."`, allow_writes: true, approvals: ['add_note'] }, READONLY);
    assert.equal(through.status, 403, `the copilot let a readonly session write: ${JSON.stringify(through.body).slice(0, 300)}`);
    assert.equal(through.body.error.type, 'permission_error');
    const thread = await expectOk('POST', '/v1/ai/threads', { title: 'Escalation probe' });
    const turn = await call('POST', `/v1/ai/threads/${thread.id}/messages`, { content: `Add a note to ${target.name} saying "Written through a thread."`, allow_writes: true, approvals: ['add_note'] }, READONLY);
    assert.equal(turn.status, 403);
    assert.equal(noteCount(), before);
  });

  test('reading through the copilot stays open to every role, and a member may still authorise a write', async () => {
    const answer = await ask('What is our open pipeline?', {}, READONLY);
    assert.equal(answer.object, 'ai_completion');
    assert.equal(answer.analysis.refusal, null, answer.content);
    assert.equal((await expectOk('GET', '/v1/ai/runs?limit=1', undefined, READONLY)).object, 'list');
    const before = noteCount();
    const written = await ask(`Add a note to ${company().name} saying "A member asked for this."`, { allow_writes: true, approvals: ['add_note'] }, { ...READONLY, role: 'member' });
    assert.equal(written.trace.filter((s: Body) => s.kind === 'tool' && s.name === 'add_note' && s.ok).length, 1);
    assert.equal(noteCount(), before + 1);
  });

  test('a key acts as the teammate who created it, and no run is ever attributed to the key id', async () => {
    tick();
    const before = noteCount();
    const res = await withKey('POST', '/v1/ai/complete', { prompt: `Add a note to ${company().name} saying "Filed by the integration."`, allow_writes: true, approvals: ['add_note'] });
    assert.ok(res.status < 400, `${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    assert.equal(noteCount(), before + 1);
    const note = app.db.get<{ owner_id: string | null; created_by: string | null }>(
      `SELECT owner_id, created_by FROM crm_records WHERE org_id = ? AND object_type = 'note' ORDER BY created DESC, rowid DESC LIMIT 1`, ORG)!;
    assert.equal(note.owner_id, 'usr_seed01');
    assert.equal(note.created_by, 'usr_seed01');
    const run = await expectOk('GET', `/v1/ai/runs/${res.body.run_id}`);
    assert.equal(run.actor_id, 'usr_seed01');
    assert.equal(run.actor_type, 'api_key');
    assert.equal(app.db.count(`SELECT COUNT(*) FROM ai_runs WHERE org_id = ? AND actor_id LIKE 'ak_%'`, ORG), 0);
    const thread = await withKey('POST', '/v1/ai/threads', { title: 'Integration thread' });
    assert.ok(thread.status < 400);
    assert.equal(app.db.pluck<string>(`SELECT created_by FROM ai_threads WHERE id = ?`, thread.body.id), 'usr_seed01');
    assert.ok((await withKey('POST', '/v1/ai/draft', { instruction: 'Write a short check-in email' })).status < 400);
  });

  test('a follow-up whose assignee is no longer a member still lands, unassigned', async () => {
    tick();
    const record = recs('company').sort((a, b) => a.name.localeCompare(b.name))[3];
    const execution = await runtime().execute('schedule_followup',
      { record_id: record.id, in_days: 30, note: 'Reconfirm the acceptance window', assignee_id: 'usr_departed01' },
      callContext({ allowWrites: true, approvals: ['schedule_followup'] }));
    assert.equal(execution.ok, true, `scheduling failed: ${execution.error?.message}`);
    const job = app.db.get<{ id: string; org_id: string; type: string; payload: string; run_at: number; attempts: number; max_attempts: number; status: string; last_error: string | null; idem_key: string | null; created: number; updated: number }>(
      `SELECT * FROM jobs WHERE type = 'ai.followup' AND status = 'pending' AND payload LIKE '%Reconfirm the acceptance window%' ORDER BY created DESC LIMIT 1`)!;
    assert.ok(job, 'the follow-up is a durable job');
    assert.ok(job.run_at > app.ctx.now(), 'scheduled, not immediate');
    const outcome = await app.ctx.jobs.runOne({ ...job, payload: JSON.parse(job.payload) } as never, app.ctx.now());
    assert.equal(outcome, 'ok');
    assert.ok(app.ctx.events.list(ORG, { types: ['ai.followup.due'], limit: 3 }).length > 0, 'the follow-up raised its event');
    const note = app.db.get<{ owner_id: string | null; display_name: string }>(
      `SELECT owner_id, display_name FROM crm_records WHERE org_id = ? AND object_type = 'note' AND display_name LIKE 'Follow-up: Reconfirm the acceptance window%' ORDER BY created DESC LIMIT 1`, ORG);
    assert.ok(note, 'the note the operator approved reached the timeline');
    assert.equal(note!.owner_id, null, 'an owner who is not a member is no owner at all');
  });
});

/* ============================ usage and the meter ============================ */

describe('a question about usage is answered from the meter, never with a sales number', () => {
  const METER = 'mtr_nw_telemetry';

  /** A billed account streaming into the meter last month, and its ground truth from the metering module. */
  function metered(): { company: Rec; customer: string; window: { start: number; end: number } } {
    const window = monthBefore(app.ctx.now());
    const streaming = app.db.all<{ customer_id: string }>(
      `SELECT DISTINCT customer_id FROM meter_event_summaries WHERE org_id = ? AND meter_id = ? AND hour_start >= ? AND hour_start < ?`,
      ORG, METER, window.start, window.end).map((r) => r.customer_id);
    for (const customer of streaming) {
      const record = app.db.pluck<string>(`SELECT crm_record_id FROM billing_customers WHERE org_id = ? AND id = ?`, ORG, customer);
      const company = record ? recs('company').find((c) => c.id === record) : null;
      if (company && app.ctx.svc.metering!.usageForPeriod(ORG, METER, customer, window.start, window.end).value > 0) return { company, customer, window };
    }
    assert.fail('fixture: a billed account streaming into the meter last month');
  }

  test('metered usage is read from the meter, for the account and the period, and states the meter\'s own figure', async () => {
    const { company, customer, window } = metered();
    const usage = app.ctx.svc.metering!.usageForPeriod(ORG, METER, customer, window.start, window.end);
    const answer = await ask(`How many telemetry events did ${company.name} use last month?`);
    assert.equal(answer.analysis.refusal, null, answer.content);
    const step = answer.trace.find((s: Body) => s.kind === 'tool' && s.name === 'metered_usage');
    assert.ok(step, `plan was ${answer.trace.map((s: Body) => s.name).join(', ')}`);
    assert.equal(step.args.customer, customer);
    assert.equal(step.args.meter, METER);
    assert.deepEqual([step.args.start, step.args.end], [window.start, window.end]);
    const figure = usage.value.toLocaleString('en-US');
    assert.ok(answer.content.includes(figure), `the meter's own total ${figure} is the answer:\n${answer.content}`);
    // Every figure in the answer is the meter's, or the period it was read over; none is the account's sales.
    assertOnlyTheseNumbers(answer.content, allow(figure, company.name, new Date(window.start).getUTCFullYear()), 'a usage answer');
    const sales = [total(associated(company.id, 'deal').filter(isWon)), total(associated(company.id, 'deal').filter(isOpen))].map((minor) => minor / 100);
    for (const figure of sales) if (figure !== usage.value) assert.ok(!numbersIn(answer.content).includes(figure), `${figure} is a sales number`);

    const spelled = await ask(`How many telemetry_events did ${company.name} use last month?`);
    assert.equal(spelled.analysis.refusal, null, 'the meter is matched on its event name as well as its display name');
    assert.equal(spelled.trace.find((s: Body) => s.kind === 'tool')?.args.meter, METER);
    assert.ok(spelled.content.includes(figure));
  });

  test('a number question that names no measure is refused without measuring anything, even when it names an account', async () => {
    const answer = await ask('How much is Brightline Foods worth?');
    assert.ok(answer.analysis.refusal, answer.content);
    assert.equal(answer.trace.filter((s: Body) => s.kind === 'tool').length, 0);
    assertOnlyTheseNumbers(answer.content, allow(...answer.analysis.nearest.map((n: Body) => n.example)), 'a refusal');
  });

  test('a number question that does name a measure is still answered', async () => {
    const open = recs('ticket').filter((t) => ['new', 'waiting_on_us', 'waiting_on_customer', 'escalated'].includes(str(t.p.status)));
    const answer = await ask('How many open tickets are there?');
    assert.equal(answer.analysis.refusal, null, answer.content);
    assert.match(answer.content, new RegExp(`\\b${open.length}\\b`));
  });
});

/* ================================ threads ================================= */

describe('a conversation keeps its transcript honest past the third turn', () => {
  test('six turns in, each user turn is stored once, every reply is a run on the thread, and the turn just asked is the one answered', async () => {
    const [a, b] = recs('company').filter((c) => c.owner).sort((x, y) => x.name.localeCompare(y.name)).slice(0, 2);
    const ownerOf = (c: Rec) => people().get(c.owner!)!;
    const turns = [
      `Where does ${a.name} stand?`,
      `Who owns ${a.name}?`,
      `How many open tickets does ${a.name} have?`,
      `How many contacts do we have at ${a.name}?`,
      `Who owns ${b.name}?`,
      `Who owns ${a.name}?`,
    ];
    tick();
    const thread = await expectOk('POST', '/v1/ai/threads', { message: turns[0] });
    assert.equal(thread.object, 'ai_thread');
    assert.equal(thread.messages.length, 2);
    assert.equal(thread.messages[1].role, 'assistant');
    assert.ok(thread.messages[1].run_id, 'the assistant turn points at its run');
    assert.ok(thread.messages[1].citations.length > 0);
    const replies: Body[] = [];
    for (const text of turns.slice(1)) {
      tick();
      const reply = await expectOk('POST', `/v1/ai/threads/${thread.id}/messages`, { content: text });
      assert.equal(reply.object, 'ai_reply');
      replies.push(reply);
    }
    const fifth = replies[3];
    assert.ok(fifth.message.content.includes(ownerOf(b)) && fifth.message.content.includes(b.name), `turn five names ${b.name}:\n${fifth.message.content}`);
    assert.ok(!fifth.message.content.includes(a.name), 'turn five is not about the account the earlier turns named');
    const sixth = replies[4];
    assert.ok(sixth.message.content.includes(ownerOf(a)) && sixth.message.content.includes(a.name), `turn six is back on ${a.name}:\n${sixth.message.content}`);

    const loaded = await expectOk('GET', `/v1/ai/threads/${thread.id}`);
    assert.equal(loaded.message_count, turns.length * 2);
    assert.deepEqual(loaded.messages.map((m: Body) => m.seq), loaded.messages.map((_: Body, i: number) => i + 1));
    assert.deepEqual(loaded.messages.filter((m: Body) => m.role === 'user').map((m: Body) => m.content), turns, 'each question is stored once, in order');
    assert.equal(loaded.runs.length, turns.length, 'every turn produced a run');
    for (const message of loaded.messages.filter((m: Body) => m.role === 'assistant')) {
      const run = await expectOk('GET', `/v1/ai/runs/${message.run_id}`);
      assert.equal(run.thread_id, thread.id);
      assert.equal(run.question, turns[(message.seq - 2) / 2], 'the engine read the turn just asked as the question');
      assert.equal(run.answer, message.content);
      assert.equal(run.confidence, 1, 'every turn matched a shape');
    }
    assert.equal((await expectOk('GET', `/v1/ai/threads/${thread.id}/messages`)).data.length, turns.length * 2);
    assert.ok((await expectOk('GET', '/v1/ai/threads?limit=10')).data.some((t: Body) => t.id === thread.id));
  });

  test('both thread routes accept both field names, and a completion attached to a thread is written into it', async () => {
    tick();
    const start = await expectOk('POST', '/v1/ai/threads', { content: 'What is our open pipeline?' });
    assert.equal(start.messages.length, 2, '`content` starts the conversation the same way `message` does');
    tick();
    assert.equal((await call('POST', `/v1/ai/threads/${start.id}/messages`, { content: 'How many deals are there?' })).status, 201);
    tick();
    assert.equal((await call('POST', `/v1/ai/threads/${start.id}/messages`, { message: 'How many open tickets are there?' })).status, 201);
    const neither = await call('POST', `/v1/ai/threads/${start.id}/messages`, {});
    assert.equal(neither.status, 400);
    assert.match(String(neither.body.error.message), /`content`.*`message`/);
    const before = (await expectOk('GET', `/v1/ai/threads/${start.id}`)).message_count;
    const attached = await ask('How many companies are there?', { thread_id: start.id });
    assert.equal(attached.analysis.refusal, null);
    const after = await expectOk('GET', `/v1/ai/threads/${start.id}`);
    assert.equal(after.message_count, before + 2, 'a completion on a thread is a turn of that conversation');
    assert.equal(after.messages[after.messages.length - 1].run_id, attached.run_id);
  });

  test('an unknown thread is a 404 on every route that takes one', async () => {
    const reply = await call('POST', '/v1/ai/threads/thr_nope/messages', { content: 'hello' });
    assert.equal(reply.status, 404);
    assert.equal(reply.body.error.type, 'not_found_error');
    assert.equal((await call('POST', '/v1/ai/complete', { prompt: 'What is our MRR?', thread_id: 'thr_does_not_exist' })).status, 404);
    assert.equal((await call('GET', '/v1/ai/threads/thr_nope')).status, 404);
  });
});

/* =========================== bad input, refused clearly =========================== */

describe('the API refuses bad input clearly, and refuses what it cannot read without running anything', () => {
  test('a completion needs a prompt or messages', async () => {
    const res = await call('POST', '/v1/ai/complete', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'missing_prompt');
    assert.equal(res.body.error.param, 'prompt');
  });

  test('the workspace profile drives formatting, and time comes from the workspace clock', () => {
    const workspace = workspaceProfile(app.ctx, ORG);
    assert.equal(workspace.currency, 'usd');
    assert.equal(workspace.timezone, TZ);
    assert.ok(workspace.people.length >= 5);
    assert.equal(workspace.now, app.ctx.now());
  });

  test('an injection payload is refused without running anything, and the table is still there', async () => {
    const rows = app.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ?`, ORG);
    const answer = await ask("How many deals'; DROP TABLE crm_records; --");
    assert.ok(answer.analysis.refusal, answer.content);
    assert.deepEqual(answer.tool_calls, []);
    assert.equal(answer.trace.filter((s: Body) => s.kind === 'tool').length, 0);
    assert.equal(app.db.count(`SELECT COUNT(*) FROM crm_records WHERE org_id = ?`, ORG), rows);
  });

  test('a prompt at the documented ceiling is refused well inside the run budget; one character past it is a clear error', async () => {
    const LIMIT = 20_000;
    const filler = ' telemetry row: asset 44192, rpm 1180, temp 62.4, vibration 0.31;';
    const prompt = `How much did we book last quarter?${filler.repeat(400)}`.slice(0, LIMIT);
    assert.equal(prompt.length, LIMIT);
    const answer = await ask(prompt);
    assert.equal(answer.finish_reason, 'stop');
    assert.equal(answer.analysis.budget_exhausted, false);
    assert.ok(answer.analysis.refusal, 'a pasted document is not a question shape');
    assert.deepEqual(answer.tool_calls, []);
    const stored = await expectOk('GET', `/v1/ai/runs/${answer.run_id}`);
    assert.equal(stored.status, 'succeeded');
    assert.ok(stored.duration_ms < DEFAULT_BUDGET.timeMs / 2, `a prompt at the ${LIMIT}-character limit spent ${stored.duration_ms}ms of the ${DEFAULT_BUDGET.timeMs}ms budget`);
    const over = await call('POST', '/v1/ai/complete', { prompt: 'y'.repeat(LIMIT + 1) });
    assert.equal(over.status, 400);
    assert.equal(over.body.error.code, 'parameter_invalid');
    assert.equal(over.body.error.param, 'prompt');
    assert.match(over.body.error.message, new RegExp(`at most ${LIMIT} characters`));
  });

  test('a workspace with nothing of its own still answers with a sentence, not a placeholder', async () => {
    const answer = await ask('How is the business doing?', {}, OTHER_ORG);
    assert.equal(answer.provider, 'builtin');
    assert.doesNotMatch(answer.content, /\[object Object\]|\bundefined\b|\bNaN\b|\bnull\b/);
    assert.ok(answer.content.length > 20);
  });
});

/* =========================== the ledger reconciles =========================== */

describe('money keeps its currency: the copilot\'s ledger figures reconcile with the ledger, one book per currency', () => {
  const spoken = (minor: number, currency: string) => formatMoney({ amount: minor, currency }, { locale: 'en-US', trimZeroFraction: true });

  test('MRR and ARR agree with /v1/subscriptions/overview per currency, and the cross-currency sum is never printed', async () => {
    const book = await expectOk('GET', '/v1/subscriptions/overview');
    assert.equal(book.mixed_currency, true, 'fixture: the workspace bills in more than one currency');
    const byCurrency = new Map<string, { mrr: number; arr: number }>((book.by_currency as { currency: string; mrr: number; arr: number }[]).map((row) => [row.currency, row]));
    tick();
    const mrr = (await runtime().execute('business_metric', { metric: 'mrr' }, callContext())).result as
      { value: number; currency: string | null; mixedCurrency: boolean; formatted: string; books: { currency: string; value: number; formatted: string }[] };
    assert.equal(mrr.mixedCurrency, true);
    assert.equal(mrr.currency, null, 'no one currency is stamped on a figure that is in several');
    assert.equal(mrr.books.length, byCurrency.size, 'every currency the ledger bills in has its own book');
    for (const row of mrr.books) assert.equal(row.value, byCurrency.get(row.currency)?.mrr, `${row.currency.toUpperCase()} MRR disagrees with the overview`);
    assert.notEqual(mrr.value, book.mrr, 'the cross-currency sum is never the figure');
    for (const row of mrr.books) assert.ok(mrr.formatted.includes(row.formatted));
    const arr = (await runtime().execute('business_metric', { metric: 'arr' }, callContext())).result as { books: { currency: string; value: number }[] };
    for (const row of arr.books) assert.equal(row.value, byCurrency.get(row.currency)?.arr);

    // The subscriptions behind each book, counted from the ledger: the only
    // other figures a per-book sentence may carry.
    const billing = app.ctx.svc.billing!;
    const recurring = billing.subscriptions(ORG, { status: 'all', limit: 500 }).filter((s) => billing.mrr(ORG, s) > 0);
    const perBook = [...byCurrency.keys()].map((currency) => recurring.filter((s) => (s.currency || 'usd').toLowerCase() === currency).length);
    for (const [question, key] of [['What is our MRR?', 'mrr'], ['What is our ARR?', 'arr']] as const) {
      const answer = await ask(question);
      assert.equal(answer.analysis.refusal, null, answer.content);
      const books = [...byCurrency.entries()].map(([currency, row]) => spoken(row[key], currency));
      for (const figure of books) assert.ok(answer.content.includes(figure), `${figure} is missing from:\n${answer.content}`);
      assertOnlyTheseNumbers(answer.content, allow(...books, byCurrency.size, ...perBook), question);
      assert.ok(!answer.content.includes(money(book[key])), `the cross-currency sum ${money(book[key])} must never be printed`);
    }
  });

  test('every money metric held in several books refuses to sum them', () => {
    for (const id of ['mrr', 'arr', 'invoiced', 'revenue', 'outstanding'] as const) {
      const metric = businessMetric(app.ctx, ORG, { metric: id, start: 0, end: app.ctx.now(), window_label: 'all time' });
      assert.ok(!('error' in metric), `${id} errored`);
      assert.ok(metric.books.length > 0, `${id} came back with no books`);
      const sum = metric.books.reduce((a, b) => a + b.value, 0);
      if (metric.books.length > 1) {
        assert.equal(metric.mixedCurrency, true, `${id} holds ${metric.books.length} books and did not say so`);
        assert.notEqual(metric.value, sum, `${id} reported the cross-currency sum as its figure`);
        assert.equal(metric.currency, null);
        for (const held of metric.books) assert.ok(metric.formatted.includes(held.formatted), `${id} did not state its ${held.currency.toUpperCase()} book`);
        assert.ok(!metric.formatted.includes(spoken(sum, 'usd')), `${id} printed the sum with a dollar sign`);
      }
    }
  });

  test('net revenue retention is reported per currency from the revenue ledger, never averaged into one rate', async () => {
    const year = new Date(app.ctx.now()).getUTCFullYear() - 1;
    const report = app.ctx.svc.revenue!.churn(ORG, { from: Date.UTC(year, 0, 1), to: Date.UTC(year + 1, 0, 1) }) as Body;
    const perCurrency = (report.by_currency as Body[]).filter((row) => !row.totals.net_revenue_retention.undefined_rate);
    assert.ok(perCurrency.length > 1, 'fixture: revenue retained in more than one currency');
    const answer = await ask(`What was our net revenue retention in ${year}?`);
    assert.equal(answer.analysis.refusal, null, answer.content);
    for (const row of perCurrency) {
      assert.ok(answer.content.includes(row.totals.net_revenue_retention.percent), `${row.currency.toUpperCase()} NRR ${row.totals.net_revenue_retention.percent} is missing:\n${answer.content}`);
    }
    assertOnlyTheseNumbers(answer.content, allow(year, ...perCurrency.map((row) => row.totals.net_revenue_retention.percent), report.totals?.months ?? '', ...numbersIn(answer.analysis.facts?.count)), 'a retention answer');
  });
});

/* ======================= grounded starting points ======================= */

describe('the copilot offers grounded starting points, and the catalogues it publishes are real', () => {
  test('every suggestion names real records, explains itself, and is a question the engine answers on its own shape', async () => {
    const suggestions = await expectOk('GET', '/v1/ai/suggestions');
    assert.ok(suggestions.data.length >= 3);
    const shapes = await published();
    for (const suggestion of suggestions.data) {
      assert.ok(suggestion.question.length > 10);
      assert.ok(suggestion.why.length > 10, 'each suggestion says why it is being offered');
      const answered = await ask(suggestion.question);
      assert.equal(answered.analysis.refusal, null, `"${suggestion.question}" was refused: ${answered.content}`);
      const shape = shapes.find((t) => t.id === answered.analysis.template.id)!;
      assert.equal(shape.intent, suggestion.intent);
    }
  });

  test('the metric catalogue is published and agrees with the tool', async () => {
    const metrics = await expectOk('GET', '/v1/ai/metrics');
    const ids = metrics.data.map((m: { id: string }) => m.id);
    for (const expected of ['spend', 'pipeline', 'closed_won', 'win_rate', 'open_tickets', 'mrr']) assert.ok(ids.includes(expected), `${expected} is missing`);
    const pipeline = metrics.data.find((m: { id: string }) => m.id === 'pipeline');
    assert.equal(pipeline.unit, 'money');
    assert.equal(pipeline.snapshot, true);
    tick();
    const unknown = (await runtime().execute('business_metric', { metric: 'vibes' }, callContext())).result as { available: string[] };
    assert.deepEqual([...unknown.available].sort(), [...ids].sort(), 'the tool names exactly the metrics the catalogue publishes');
  });
});
