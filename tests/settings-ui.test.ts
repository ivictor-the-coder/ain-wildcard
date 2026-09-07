/**
 * The settings screens' own logic, run without a browser.
 *
 * Two things here have to be right or the surface lies: what the time machine
 * says each move ran, and where an object id on the audit trail or the event
 * stream leads. Both are pure, so each case hands the function exactly what the
 * API serves and checks the answer against the API's own numbers.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

import {
  RECORD_LIMIT, RETENTION, attributeJobs, covers, dueBy, readRecordedMoves, recordKey, recordMove, recordedFor, tallyMove,
} from '../src/client/modules/settings/moves';
import { targetLabel, targetRoute } from '../src/client/modules/settings/targets';
import { TILE_DASH, tileOf } from '../src/client/modules/settings/tiles';
import { isHostname, problemWith } from '../src/client/modules/settings/workspace-core';
import { actorLabel, seatsFromTrail, unattributedBecause } from '../src/client/modules/settings/audit-core';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 5, 3, 33, 0);

const job = (id: string, updated: number) => ({ id, updated });

/**
 * The exact shape the critic reproduced: a day-jump that ran 18 jobs, a return
 * to real time, a second day-jump that ran none, and a week-jump that ran 75.
 * Every window opens from (nearly) the same real instant, so all three overlap.
 */
const dayOne = { id: 'aud_1', from: T0, to: T0 + DAY };
const dayTwo = { id: 'aud_2', from: T0 + 7_000, to: T0 + 7_000 + DAY };
const week = { id: 'aud_3', from: T0 + 14_000, to: T0 + 14_000 + 7 * DAY };
const ranInDayOne = Array.from({ length: 18 }, (_, i) => job(`job_d${i}`, T0 + 3_600_000 + i * 60_000));
const ranInWeek = Array.from({ length: 75 }, (_, i) => job(`job_w${i}`, T0 + 2 * DAY + i * 3_600_000));

describe('crediting completed jobs to the move that ran them', () => {
  it('credits a job to exactly one move when only one window holds it', () => {
    const credited = attributeJobs([dayOne, week], ranInWeek);
    assert.equal(credited.get('aud_3')!.own.length, 75);
    assert.equal(credited.get('aud_1')!.own.length, 0, 'the week-jump ran these, not the day-jump');
  });

  it('refuses to count a job twice when two windows hold it', () => {
    // Before this rule the second day-jump read "18 jobs" having run none, and
    // the week-jump read "93" — 18 + 75 — having run 75.
    const credited = attributeJobs([dayOne, dayTwo, week], [...ranInDayOne, ...ranInWeek]);
    // The 18 that ran on the first day fall inside all three windows, so none
    // of the three may claim them as its own — and each is marked as sharing.
    for (const move of [dayOne, dayTwo, week]) {
      const { shared } = credited.get(move.id)!;
      assert.equal(shared.length, 18, `${move.id} holds the 18 jointly`);
    }
    assert.equal(credited.get('aud_1')!.own.length, 0, 'the first day-jump cannot prove the 18 are its own');
    assert.equal(credited.get('aud_2')!.own.length, 0, 'the second day-jump ran nothing and is credited nothing');
    // The 75 that ran from day two onward fall in the week's window alone.
    assert.equal(credited.get('aud_3')!.own.length, 75);
    const total = [...credited.values()].reduce((n, { own }) => n + own.length, 0);
    assert.equal(total, 75, 'no job is credited twice');
  });

  it('keeps the credited lists in the order the jobs ran', () => {
    const shuffled = [...ranInWeek].reverse();
    const { own } = attributeJobs([week], shuffled).get('aud_3')!;
    assert.deepEqual(own.map((j) => j.id), ranInWeek.map((j) => j.id));
  });

  it('leaves a job outside every window uncredited', () => {
    const credited = attributeJobs([dayOne], [job('job_old', T0 - DAY)]);
    assert.equal(credited.get('aud_1')!.own.length, 0);
    assert.equal(credited.get('aud_1')!.shared.length, 0);
  });
});

describe('the count the server answered, kept by the browser that asked', () => {
  const memory = () => {
    const store = new Map<string, string>();
    return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  };

  it('is found again by the move’s previous instant, which the audit entry keeps as before.now', () => {
    const storage = memory();
    recordMove(storage, 'org_demo', { from: T0, to: T0 + DAY, jobsRun: 18, jobsFailed: 0, recordedAt: 1 });
    recordMove(storage, 'org_demo', { from: T0 + 7_000, to: T0 + 7_000 + DAY, jobsRun: 0, jobsFailed: 0, recordedAt: 2 });
    const records = readRecordedMoves(storage, 'org_demo');
    assert.equal(recordedFor(records, T0)?.jobsRun, 18);
    assert.equal(recordedFor(records, T0 + 7_000)?.jobsRun, 0);
    assert.equal(recordedFor(records, T0 + 1), undefined, 'a near miss is not a match');
  });

  it('is scoped to the workspace', () => {
    const storage = memory();
    recordMove(storage, 'org_a', { from: T0, to: T0 + DAY, jobsRun: 3, jobsFailed: 0, recordedAt: 1 });
    assert.equal(readRecordedMoves(storage, 'org_b').length, 0);
    assert.notEqual(recordKey('org_a'), recordKey('org_b'));
  });

  it('survives a missing, refused or corrupt store without throwing', () => {
    assert.deepEqual(readRecordedMoves(null, 'org_demo'), []);
    assert.deepEqual(readRecordedMoves({ getItem: () => '{not json', setItem: () => {} }, 'org_demo'), []);
    assert.deepEqual(readRecordedMoves({ getItem: () => '[{"from":"x"}]', setItem: () => {} }, 'org_demo'), []);
    const refused = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    assert.doesNotThrow(() => recordMove(refused, 'org_demo', { from: T0, to: T0, jobsRun: 1, jobsFailed: 0, recordedAt: 1 }));
  });

  it('forgets the oldest record first once the limit is reached', () => {
    const storage = memory();
    for (let i = 0; i <= RECORD_LIMIT; i++) {
      recordMove(storage, 'org_demo', { from: T0 + i, to: T0 + i + DAY, jobsRun: i, jobsFailed: 0, recordedAt: i });
    }
    const records = readRecordedMoves(storage, 'org_demo');
    assert.equal(records.length, RECORD_LIMIT);
    assert.equal(recordedFor(records, T0), undefined, 'the first record is gone');
    assert.equal(recordedFor(records, T0 + RECORD_LIMIT)?.jobsRun, RECORD_LIMIT);
  });
});

describe('what the badge on a move may say', () => {
  it('prefers the server’s recorded answer over any reconstruction', () => {
    const tally = tallyMove({
      recorded: { from: T0, to: T0 + DAY, jobsRun: 0, jobsFailed: 0, recordedAt: 1 },
      own: { ran: 18, failed: 0 }, sharesWindow: true, covered: true,
    });
    assert.deepEqual(tally, { kind: 'recorded', ran: 0, failed: 0 });
  });

  it('will not put a number on a move whose window another move shares', () => {
    assert.deepEqual(tallyMove({ recorded: undefined, own: { ran: 0, failed: 0 }, sharesWindow: true, covered: true }), { kind: 'shared' });
  });

  it('will not put a number on a move older than the jobs the read still holds', () => {
    assert.deepEqual(
      tallyMove({ recorded: undefined, own: { ran: 0, failed: 0 }, sharesWindow: false, covered: false }),
      { kind: 'beyond', readable: 0 },
    );
  });

  it('carries how many of an unreadable move’s jobs it can still see, as a floor and never a count', () => {
    // The critic's 302-job billing cycle: cleanup ran during the jump and left
    // 83 of its jobs readable. "83 jobs" was a fabricated count; "at least 83"
    // is what the read can actually stand behind.
    assert.deepEqual(
      tallyMove({ recorded: undefined, own: { ran: 83, failed: 0 }, sharesWindow: false, covered: false }),
      { kind: 'beyond', readable: 83 },
    );
  });

  it('counts from the window only when it is this move’s alone and fully readable', () => {
    assert.deepEqual(
      tallyMove({ recorded: undefined, own: { ran: 75, failed: 2 }, sharesWindow: false, covered: true }),
      { kind: 'matched', ran: 75, failed: 2 },
    );
  });
});

describe('whether the completed-jobs read can still hold what a move ran', () => {
  const now = T0 + 30 * DAY;

  it('is lost to core.cleanup a week after the move', () => {
    assert.equal(covers({ id: 'a', from: now - RETENTION - 1, to: now }, { now, capped: false, floor: null }), false);
    assert.equal(covers({ id: 'a', from: now - RETENTION + 1, to: now }, { now, capped: false, floor: null }), true);
  });

  it('is lost when the page is capped and the move starts before its floor', () => {
    const recent = { id: 'a', from: now - DAY, to: now };
    assert.equal(covers(recent, { now, capped: true, floor: now - 3_600_000 }), false);
    assert.equal(covers(recent, { now, capped: true, floor: now - 2 * DAY }), true);
    assert.equal(covers(recent, { now, capped: false, floor: null }), true);
  });

  it('is lost by a jump longer than the retention, even once the clock is back beside its start', () => {
    // Cleanup runs on the workspace clock, which the jump steps through day by
    // day — a thirty-day jump prunes its own first three weeks before it ends.
    // Returning to real time puts `now` back beside `from`, which is exactly
    // how a 302-job move read "83 jobs" to the next person who opened the screen.
    const realNow = T0;
    const billingCycle = { id: 'a', from: realNow, to: realNow + 30 * DAY };
    assert.equal(covers(billingCycle, { now: realNow, capped: false, floor: null }), false);
    // A jump shorter than the retention loses nothing to cleanup on the way.
    assert.equal(covers({ id: 'b', from: realNow, to: realNow + 3 * DAY }, { now: realNow, capped: false, floor: null }), true);
  });
});

/* ------------------------------ the tiles --------------------------------- */

describe('what a summary tile may say before its read has answered', () => {
  const ready = () => ({ value: '17', caption: 'Across 9 countries' });

  it('renders the number only once every read it depends on has data', () => {
    assert.deepEqual(tileOf([{ error: null, loading: false }], 'GET /v1/tax_rates', ready), { value: '17', caption: 'Across 9 countries', state: 'ready' });
  });

  it('shows a dash and names the route when the read failed — never a zero', () => {
    // The critic forced GET /v1/tax_rates to 500 and read "Active registrations
    // 0 · Across 0 countries" above a table that was honestly showing the error.
    const tile = tileOf([{ error: { status: 500 }, loading: false }], 'GET /v1/tax_rates', () => { throw new Error('must not be computed'); });
    assert.equal(tile.state, 'unread');
    assert.equal(tile.value, TILE_DASH);
    assert.match(tile.caption, /GET \/v1\/tax_rates/);
    assert.match(tile.caption, /not a count of zero/);
  });

  it('shows a dash while the read is still in flight', () => {
    const tile = tileOf([{ error: null, loading: true }], 'GET /v1/jobs?status=pending', () => { throw new Error('must not be computed'); });
    assert.equal(tile.state, 'reading');
    assert.equal(tile.value, TILE_DASH);
  });

  it('is unread when any one of several reads failed', () => {
    const tile = tileOf([{ error: null, loading: false }, { error: { status: 429 }, loading: false }], 'GET /v1/customers', ready);
    assert.equal(tile.state, 'unread');
  });
});

/* ----------------------------- the workspace ------------------------------ */

describe('what the workspace form refuses before the server sees it', () => {
  it('accepts a hostname and refuses anything that is not one', () => {
    for (const ok of ['northwind.io', 'billing.northwind.co.uk', 'NORTHWIND.IO', ' northwind.io ', 'a-b.example.com']) {
      assert.equal(isHostname(ok), true, `${ok} is a hostname`);
    }
    for (const bad of ['not a domain!!', 'https://northwind.io', 'northwind.io/billing', 'northwind', 'localhost', '-bad.io', 'bad-.io', 'northwind.io:8080', 'northwind.123', 'a b.io']) {
      assert.equal(isHostname(bad), false, `${bad} is not a hostname`);
    }
  });

  it('pins the refusal to the domain field and leaves an empty domain to the dropped-value hint', () => {
    // PATCH /v1/org stored "not a domain!!" and the shell header read it back
    // under the workspace name on every screen.
    assert.match(problemWith('domain', 'not a domain!!') ?? '', /hostname/i);
    assert.equal(problemWith('domain', 'northwind.io'), undefined);
    // An empty value is not refused here — the API drops it, and the field's
    // own hint already says so. Refusing it too would say two different things.
    assert.equal(problemWith('domain', ''), undefined);
    assert.equal(problemWith('name', ''), 'A workspace must have a name.');
    assert.equal(problemWith('brand_color', '#12345'), 'Six hex digits after a #, e.g. #5B4BE1.');
  });
});

/* ------------------------------- the trail -------------------------------- */

describe('what the trail can say about the teammates it names', () => {
  const entries = [
    { action: 'user.invited', target_type: 'user', target_id: 'usr_gone', summary: 'Invited critic@northwind.io as readonly' },
    { action: 'user.role_changed', target_type: 'user', target_id: 'usr_gone', summary: 'Role changed from readonly to member' },
    { action: 'user.removed', target_type: 'user', target_id: 'usr_gone', summary: 'Removed from workspace — 1 session ended, 0 API keys revoked' },
    { action: 'user.role_changed', target_type: 'user', target_id: 'usr_seed06', summary: 'Role changed from analyst to readonly' },
    { action: 'api_key.created', target_type: 'api_key', target_id: 'ak_1', summary: 'Created API key "CI"' },
  ];

  it('names a removed teammate off the invitation the trail recorded, and marks the seat removed', () => {
    const seats = seatsFromTrail(entries);
    assert.deepEqual(seats.get('usr_gone'), { email: 'critic@northwind.io', removed: true });
  });

  it('knows a seat it never saw invited, and does not call it removed', () => {
    const seats = seatsFromTrail(entries);
    assert.deepEqual(seats.get('usr_seed06'), { email: null, removed: false });
    assert.equal(seats.has('ak_1'), false, 'only teammates');
  });
});

describe('what an entry or an event calls its actor', () => {
  const names = new Map([['usr_seed01', 'Dana Whitfield']]);
  const name = (id: string) => names.get(id);

  it('names a teammate the session knows and falls back to the id for one it does not', () => {
    assert.equal(actorLabel('usr_seed01', 'user', name), 'Dana Whitfield');
    assert.equal(actorLabel('usr_other', 'user', name), 'usr_other');
  });

  it('never credits "the platform" with a change the record does not attribute', () => {
    // user.invited, user.role_changed and user.removed are emitted with
    // actor_type system and no actor — three things only a signed-in admin can
    // do. Saying "The platform" did them was a claim the record cannot support.
    assert.equal(actorLabel(null, 'system', name), 'Unattributed');
    assert.equal(actorLabel(null, 'user', name), 'Unattributed');
    assert.notEqual(actorLabel(null, 'system', name), 'The platform');
  });

  it('explains an unattributed system event without deciding who did it', () => {
    assert.match(unattributedBecause(null, 'system', null) ?? '', /cannot be read as either/);
    assert.equal(unattributedBecause('usr_seed01', 'user', 'req_1'), null);
  });
});

describe('what a preset will run, before it is pressed', () => {
  const pending = [{ run_at: T0 + 2 * DAY }, { run_at: T0 + 5 * DAY }, { run_at: T0 + 40 * DAY }];

  it('counts the pending jobs a jump would reach', () => {
    assert.deepEqual(dueBy(pending, T0 + DAY, false), { count: 0, atLeast: false });
    assert.deepEqual(dueBy(pending, T0 + 7 * DAY, false), { count: 2, atLeast: false });
    assert.deepEqual(dueBy(pending, T0 + 90 * DAY, false), { count: 3, atLeast: false });
  });

  it('calls the count a floor when the read was capped, because the cap drops the soonest rows', () => {
    assert.deepEqual(dueBy(pending, T0 + 7 * DAY, true), { count: 2, atLeast: true });
  });
});

describe('where an object id leads', () => {
  it('names an API key as one, not as an "Api key"', () => {
    assert.equal(targetLabel('api_key'), 'API key');
    assert.equal(targetLabel('user'), 'Teammate');
    assert.equal(targetLabel('org'), 'Workspace');
    assert.equal(targetLabel('subscription_schedule'), 'Subscription schedule');
    assert.equal(targetLabel('something_new'), 'Something new');
    assert.equal(targetLabel(null), 'Object');
  });

  it('resolves every target type the audit trail writes to a screen that shows it', () => {
    assert.equal(targetRoute('user', 'usr_seed06'), '/settings/team?member=usr_seed06');
    assert.equal(targetRoute('api_key', 'ak_1'), '/settings/api-keys?key=ak_1');
    assert.equal(targetRoute('org', 'org_demo'), '/settings');
  });

  it('resolves the objects the event stream names to their record screens', () => {
    assert.equal(targetRoute('subscription', 'sub_1'), '/billing/subscriptions/sub_1');
    assert.equal(targetRoute('invoice', 'in_1'), '/billing/invoices/in_1');
    assert.equal(targetRoute('customer', 'cus_1'), '/billing/customers/cus_1');
    assert.equal(targetRoute('meter', 'mtr_1'), '/revenue/usage/mtr_1');
    assert.equal(targetRoute('deal', 'deal_1'), '/deals/deal_1');
    assert.equal(targetRoute('ai_run', 'run_1'), '/copilot/runs/run_1');
    assert.equal(targetRoute('tax_rate', 'txr_1'), '/settings/tax?rate=txr_1');
  });

  it('offers no link for a type the platform has no record screen for, rather than a search to finish', () => {
    assert.equal(targetRoute('payment_intent', 'pi_1'), null);
    assert.equal(targetRoute('credit_grant', 'credgr_1'), null);
    assert.equal(targetRoute('user', null), null);
    assert.equal(targetRoute(null, 'x'), null);
  });

  it('escapes an id before it becomes part of an address', () => {
    assert.equal(targetRoute('customer', 'cus/../x'), '/billing/customers/cus%2F..%2Fx');
  });

  it('only ever links to a route the client registers', () => {
    // The module registry is generated; the literal `path:` strings live in
    // each module's own routes file, which is what `tests/kernel.test.ts` scans too.
    const registered = readdirSync('src/client/modules')
      .map((dir) => readFileSync(`src/client/modules/${dir}/routes.tsx`, 'utf8'))
      .join('\n');
    for (const [type, id, expected] of [
      ['customer', 'cus_1', '/billing/customers/:id'], ['invoice', 'in_1', '/billing/invoices/:id'],
      ['subscription', 'sub_1', '/billing/subscriptions/:id'], ['meter', 'mtr_1', '/revenue/usage/:id'],
      ['contact', 'con_1', '/contacts/:id'], ['company', 'cmp_1', '/companies/:id'], ['deal', 'deal_1', '/deals/:id'],
      ['ticket', 'tkt_1', '/tickets/:id'], ['ai_run', 'run_1', '/copilot/runs/:id'],
    ] as const) {
      assert.ok(targetRoute(type, id), `${type} resolves`);
      assert.ok(registered.includes(`path: '${expected}'`), `${expected} is a registered route`);
    }
  });
});

/**
 * The screen itself: the history may only render what `tallyMove` allows, and
 * never the raw window match it used to invent its counts from.
 */
describe('the time machine screen renders counts only through the tally', () => {
  const source = readFileSync('src/client/modules/settings/clock.tsx', 'utf8');

  it('reads each move’s count off tallyMove and records the server’s answer', () => {
    assert.ok(source.includes('tallyMove('), 'the badge is decided by tallyMove');
    assert.ok(source.includes('recordMove('), 'the answer to POST /v1/time/advance is kept');
    assert.ok(source.includes('attributeJobs('), 'jobs are credited exclusively');
  });

  it('no longer counts every completed job whose instant falls in the window as the move’s own', () => {
    assert.ok(!/ran:\s*ran\.filter\(inWindow\)/.test(source), 'the old inclusive window match is gone');
  });
});

/**
 * Sentences the screens must and must not say. Each of these was read on
 * screen by someone judging the surface, and each is checked at the source so
 * it cannot quietly come back.
 */
describe('what the settings screens say', () => {
  const read = (file: string) => readFileSync(`src/client/modules/settings/${file}`, 'utf8');

  it('the invitation is an invitation: a one-time link, shown once, with a screen that redeems it', () => {
    // The screen used to say the platform had "no invitation link, no password
    // route and no accept step". All three exist; leaving that sentence up was
    // the loudest false thing in Settings.
    const team = read('team.tsx');
    assert.ok(!team.includes('join this workspace immediately'), 'the old false promise is gone');
    assert.ok(!/cannot sign in/.test(team), 'and so is the newer one');
    assert.ok(!/no invitation link, no password route/.test(team));
    assert.ok(/invitationUrl/.test(team) && /\/accept\?token=/.test(team), 'the dialog builds the real link');
    assert.ok(/CopyField/.test(team) && /secret/.test(team), 'shown the way a secret is shown');
    assert.ok(/acknowledged/.test(team), 'and acknowledged before the dialog will close');
    assert.ok(/reinvite/.test(team), 'a fresh link can be minted');
    const accept = readFileSync('src/client/kernel/accept.tsx', 'utf8');
    assert.ok(/\/v1\/auth\/accept/.test(accept) && /v1\/auth\/invitations/.test(accept));
    const routes = readFileSync('src/client/kernel/routes.tsx', 'utf8');
    assert.ok(/path: '\/accept'[\s\S]*?layout: 'bare'/.test(routes), 'and it is public — the invitee has no session');
  });

  it('the roster shows the invited state everywhere it lists people', () => {
    const team = read('team.tsx');
    assert.ok(/id: 'status'/.test(team) && /<StatusPill\s+status=\{row\.status\}/.test(team), 'the seat column');
    assert.ok(/Invitation lapsed|Link expires/.test(team), '“Never signed in” is not what an invited seat reads');
    for (const [file, needle] of [
      ['../crm/values.tsx', /status === 'invited'/],
      ['../crm/record.tsx', /status === 'invited'/],
      ['../pipeline/deals.tsx', /status === 'invited'/],
      ['../home/routes.tsx', /status !== 'invited'/],
    ] as const) {
      assert.match(read(file), needle, `${file} knows an invited seat is not a colleague yet`);
    }
  });

  it('the roster sorts the role column by rank, not by the alphabet', () => {
    const team = read('team.tsx');
    assert.ok(/accessor:\s*\(row\)\s*=>\s*ROLE_ORDER\.indexOf\(row\.role\)/.test(team), 'the role accessor is the rung index');
  });

  it('the queue’s description agrees with its sort', () => {
    const jobs = read('jobs.tsx');
    assert.ok(!jobs.includes('furthest ahead first'), 'the wrong direction is gone');
    assert.ok(jobs.includes('soonest first'), 'pending work is described soonest first');
  });

  it('every tile on the tax, jobs, features, clock and widget screens is computed through tileOf', () => {
    for (const file of ['tax.tsx', 'jobs.tsx', 'features.tsx', 'clock.tsx', 'routes.tsx']) {
      assert.ok(read(file).includes("from './tiles'"), `${file} reads its tiles through tileOf`);
    }
    // And no tile value is a count that falls through to zero on a failed read.
    for (const file of ['tax.tsx', 'jobs.tsx', 'features.tsx']) {
      assert.ok(!/value=\{f\.number\(/.test(read(file)), `${file} passes no raw count straight to a Stat`);
    }
  });

  it('leaves Enter on a row menu to the grid, which now answers it correctly itself', () => {
    // The frame used to stop that keystroke in the capture phase because
    // `DataTable` answered Enter for every keydown that bubbled to its body,
    // including the one aimed at the row's "…" button. The grid reads
    // `keyBelongsToControl` now, so a second guard over it is one more thing
    // that can disagree.
    const common = read('common.tsx');
    assert.ok(!common.includes('shieldsRowMenuEnter'), 'the workaround is gone');
    assert.ok(!/onKeyDownCapture/.test(common), 'and the frame captures nothing');
    const table = readFileSync(new URL('../src/client/design/table-core.ts', import.meta.url), 'utf8');
    assert.match(table, /export function keyBelongsToControl/, 'the kit owns the rule');
    const grid = readFileSync(new URL('../src/client/design/table.tsx', import.meta.url), 'utf8');
    assert.match(grid, /if \(keyBelongsToControl\(e\.key, e\.target as Element \| null\)\) return;/);
  });

  it('every dialog with fields submits on Enter through DialogForm', () => {
    for (const file of ['team.tsx', 'keys.tsx', 'tax.tsx', 'features.tsx']) {
      assert.ok(read(file).includes('<DialogForm onSubmit='), `${file} wraps its dialog fields in a form`);
    }
    assert.ok(!/onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter'/.test(read('team.tsx')), 'no per-field Enter handler is left to disagree with the form');
  });

  it('the workspace shows Save only to a role that can save', () => {
    const workspace = read('workspace.tsx');
    assert.ok(/actions=\{admin\s*\?/.test(workspace), 'the Save action is offered to admins alone');
    assert.ok(!workspace.includes("'Virtual'"), 'the clock fact reads what the clock says, not what kind it is');
  });
});
