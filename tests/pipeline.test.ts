import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { describe, it } from 'node:test';

import {
  ALL_PIPELINES, BOARD_KEYS, CUSTOM_SORT, DAY_MS, FORECAST_PERIODS, HORIZON_LABEL, HORIZONS, PERIOD_LABEL,
  SIX_WEEK_DAYS, SORTS, TABLE_SORT,
  boardHeadline, boardMove, boardTabStop, closedVerb, columnsFor, commitFilter, conditionsOf, dateExample,
  dateOrderOf, describeBoardState,
  describeTableSort, isBoardKey, matchesHorizon, moneyLine, needsYear, horizonWindow, outcomeWord, overdueFilter,
  parseTypedDate,
  quarterEnd, quarterName, quarterStart, reverseClearedSort, sameBoardState, sortKeyOf, stageKey, stateToView,
  viewToState, civilDay,
  type BoardState, type FilterCondition, type FilterNode,
} from '../src/client/modules/pipeline/board-core';
import { resolveDate } from '../src/server/modules/crm/values';
import {
  FORECAST_BUCKETS, UNASSIGNED, bucketOf, byOwner, byPipeline, composition, rollupForecast,
  type ForecastDeal,
} from '../src/client/modules/pipeline/forecast-core';
import { dealCsv, dealExportColumns, isoDay } from '../src/client/modules/pipeline/export-core';
import { matchRoute } from '../src/client/kernel/router';
import type { TableState } from '../src/client/design/table-core';
import { splitToolEcho, parseBlocks, confidenceBand, refusalOf } from '../src/client/modules/copilot/answer-core';
import {
  boundScopeOf, isWiderName, lastInstantOf, looksLikeRecordId, recordPhraseMismatch, windowText, type VocabStage, type Vocabulary,
} from '../src/client/modules/copilot/scope-core';
import { formatDate, formatDateRange } from '../src/client/design/format';
import { citationHref, writeTargetLabel } from '../src/client/modules/copilot/citations';
import {
  OUTCOME_LABEL, OUTCOME_TONE, runOutcome, type AiApproval,
} from '../src/client/modules/copilot/api';
import { canWrite } from '../src/client/kernel/shell-core';

// The design system's index pulls its stylesheets in and node has no idea what
// a `.css` import is, so they are short-circuited before anything that reaches
// one is loaded — which is why the pipeline's api module is imported here
// rather than at the top with the rest.
register(
  'data:text/javascript,export async function load(url, context, next) { if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true }; return next(url, context); }',
  import.meta.url,
);
const { readOnlyReason } = await import('../src/client/modules/pipeline/api');

const TODAY = Date.UTC(2026, 8, 2);

const board = (over: Partial<BoardState> = {}): BoardState =>
  ({ pipeline: ALL_PIPELINES, owner: '', forecast: '', horizon: 'all', sort: 'amount', closed: true, ...over });

/* ---------------------------- close-date windows -------------------------- */

describe('the six-week commit window', () => {
  it('is a real horizon the board can be filtered to', () => {
    assert.equal(HORIZON_LABEL['42'], 'Closing within six weeks');
    assert.deepEqual(HORIZONS, ['all', 'overdue', '30', '42', 'quarter', 'next_quarter', 'last_quarter', 'year']);
    // Every horizon is offered, and the control does not open on the third one
    // because two keys happen to look like integers to the runtime.
    assert.deepEqual([...HORIZONS].sort(), Object.keys(HORIZON_LABEL).sort());
    assert.equal(HORIZONS[0], 'all');
    assert.deepEqual(horizonWindow('42', TODAY), { from: TODAY, to: TODAY + 42 * DAY_MS });
    assert.equal(SIX_WEEK_DAYS, 42);
  });

  it('has a floor, so a deal that slipped in March is not future commit', () => {
    const slipped = TODAY - 120 * DAY_MS;
    assert.equal(matchesHorizon(slipped, '42', TODAY), false);
    assert.equal(matchesHorizon(slipped, 'overdue', TODAY), true);
  });

  it('takes today and the last day of the window, and nothing past it', () => {
    assert.equal(matchesHorizon(TODAY, '42', TODAY), true);
    assert.equal(matchesHorizon(TODAY + 42 * DAY_MS, '42', TODAY), true);
    assert.equal(matchesHorizon(TODAY + 43 * DAY_MS, '42', TODAY), false);
  });

  it('sits between the 30-day window and the quarter, and contains the shorter one', () => {
    const inThirty = TODAY + 20 * DAY_MS;
    assert.equal(matchesHorizon(inThirty, '30', TODAY), true);
    assert.equal(matchesHorizon(inThirty, '42', TODAY), true);
    const past30 = TODAY + 35 * DAY_MS;
    assert.equal(matchesHorizon(past30, '30', TODAY), false);
    assert.equal(matchesHorizon(past30, '42', TODAY), true);
  });

  it('never matches a deal with no close date at all', () => {
    assert.equal(matchesHorizon(null, '42', TODAY), false);
    assert.equal(matchesHorizon(null, 'all', TODAY), true);
  });

  it('leaves the windows that were already there alone', () => {
    assert.deepEqual(horizonWindow('30', TODAY), { from: TODAY, to: TODAY + 30 * DAY_MS });
    assert.deepEqual(horizonWindow('overdue', TODAY), { from: null, to: TODAY - DAY_MS });
    assert.deepEqual(horizonWindow('quarter', TODAY), { from: quarterStart(TODAY), to: quarterEnd(TODAY) });
    assert.equal(horizonWindow('all', TODAY), null);
  });
});

/* ------------- the card and the board, over one workspace day -------------- */

/**
 * The dashboard card counts a set the server picks and links to a board that
 * picks its own, and the two only agree while they mean the same day by
 * "today". They did not. The card sent the relative token, which the server
 * resolves to midnight in Greenwich; the board reads close dates against the
 * workspace's civil day, which for New York is the day before from eight in
 * the evening. For those four hours a deal closing today sat on the board the
 * card's own link opened and was missing from the count above it — the whole
 * suite caught it once, at 03:08 UTC, as "the board drew 15 cards for a card
 * that counted 14".
 *
 * Both windows are now built from the same civil day, so this pins the two
 * against each other at the instant they used to disagree.
 */
describe('the six-week card counts the window its board draws', () => {
  // 23:08 on the 6th in New York; Greenwich has already turned over to the 7th.
  const EVENING = Date.parse('2026-09-07T03:08:00Z');
  const ZONE = 'America/New_York';
  const today = civilDay(EVENING, ZONE);

  /** The close-date condition the card sends, as the server will read it. */
  const asked = (filter: FilterNode): FilterCondition => {
    const found = conditionsOf(filter).find((c) => c.property === 'close_date');
    assert.ok(found, 'the card asked for no close-date window at all');
    return found!;
  };
  const readBack = (value: unknown): number => {
    const resolved = resolveDate(value, EVENING);
    assert.ok(resolved !== null, `the server cannot read ${JSON.stringify(value)} as a date`);
    return resolved!;
  };

  it('is asked at an instant where the two calendars really do differ', () => {
    assert.equal(new Date(today).toISOString().slice(0, 10), '2026-09-06');
    assert.equal(new Date(resolveDate('today', EVENING)!).toISOString().slice(0, 10), '2026-09-07');
  });

  it('asks the server for the days the board keeps, and no others', () => {
    const window = horizonWindow('42', today)!;
    const bounds = (asked(commitFilter(today)).values ?? []).map(readBack);
    assert.deepEqual(bounds, [window.from, window.to]);
  });

  it('holds every deal the board draws, at both ends of the window', () => {
    const [from, to] = (asked(commitFilter(today)).values ?? []).map(readBack);
    for (const close of [today, today + DAY_MS, today + SIX_WEEK_DAYS * DAY_MS]) {
      assert.equal(matchesHorizon(close, '42', today), true, `the board drops ${new Date(close).toISOString()}`);
      assert.ok(from <= close && close <= to,
        `the card leaves out ${new Date(close).toISOString()}, which the board draws`);
    }
    for (const close of [today - DAY_MS, today + (SIX_WEEK_DAYS + 1) * DAY_MS]) {
      assert.equal(matchesHorizon(close, '42', today), false);
      assert.equal(from <= close && close <= to, false,
        `the card counts ${new Date(close).toISOString()}, which the board does not draw`);
    }
  });

  it('calls the same deals overdue as the board does', () => {
    const before = readBack(asked(overdueFilter(today)).value);
    // A deal closing on the workspace's own today is late on neither surface.
    assert.equal(matchesHorizon(today, 'overdue', today), false);
    assert.equal(today < before, false, 'the card called a deal closing today overdue');
    // Yesterday is late on both.
    assert.equal(matchesHorizon(today - DAY_MS, 'overdue', today), true);
    assert.equal(today - DAY_MS < before, true);
  });
});

/* -------------------------- saving it as a view --------------------------- */

describe('the six-week window as a saved view', () => {
  const conditions = (filter: ReturnType<typeof stateToView>['filter']): string[] =>
    (filter && 'filters' in filter ? filter.filters as FilterCondition[] : [])
      .map((c) => `${c.property}:${c.operator}:${JSON.stringify(c.value ?? c.values)}`);

  it('stores a filter the record search can actually run', () => {
    const stored = stateToView(board({ horizon: '42' }));
    assert.deepEqual(conditions(stored.filter), ['close_date:between:["today","+42d"]']);
  });

  it('reads back as the control that wrote it', () => {
    const stored = stateToView(board({ horizon: '42', owner: 'usr_seed01' }));
    const { state, readable } = viewToState({ filter: stored.filter, sort: stored.sort });
    assert.equal(readable, true);
    assert.equal(state.horizon, '42');
    assert.equal(state.owner, 'usr_seed01');
  });

  it('round-trips every horizon the board offers', () => {
    // Read and written against the same civil day: the two quarter windows the
    // filter engine has no token for are stored as dates, and dates are only
    // a horizon relative to a clock.
    for (const horizon of HORIZONS) {
      const stored = stateToView(board({ horizon }), TODAY);
      const { state, readable } = viewToState({ filter: stored.filter, sort: stored.sort }, TODAY);
      assert.equal(readable, true, `${horizon} did not read back`);
      assert.equal(state.horizon, horizon, `${horizon} read back as ${state.horizon}`);
      assert.equal(sameBoardState(state, board({ horizon })), true);
    }
  });

  it('does not confuse the six-week window with the thirty-day one', () => {
    const six = viewToState({
      filter: { op: 'and', filters: [{ property: 'close_date', operator: 'between', values: ['today', '+42d'] }] },
      sort: [{ property: 'amount', direction: 'desc' }],
    });
    assert.equal(six.state.horizon, '42');
    const thirty = viewToState({
      filter: { op: 'and', filters: [{ property: 'close_date', operator: 'between', values: ['today', '+30d'] }] },
      sort: [{ property: 'amount', direction: 'desc' }],
    });
    assert.equal(thirty.state.horizon, '30');
  });

  it('says so when a view was built somewhere these controls cannot express', () => {
    const { readable } = viewToState({
      filter: { op: 'and', filters: [{ property: 'close_date', operator: 'between', values: ['today', '+7d'] }] },
      sort: [{ property: 'amount', direction: 'desc' }],
    });
    assert.equal(readable, false);
  });
});

/* ------------------------ an answer, and only the answer ------------------ */

describe('splitting a tool echo off an answer', () => {
  const ANSWER = [
    'Northwind Robotics is carrying $8,796,980 in open pipeline, from 45 open deals.',
    'Breakdown: Discovery $2,428,800 · Proposal $1,512,060.',
    '`list_pipelines` also returned:',
    '• New business\n• expansion\n• renewal',
  ].join('\n\n');

  it('leaves the prose as prose and takes the console dump out of it', () => {
    const { prose } = splitToolEcho(ANSWER);
    assert.equal(prose.includes('also returned'), false);
    assert.equal(prose.includes('New business'), false);
    assert.equal(prose.startsWith('Northwind Robotics is carrying'), true);
    assert.equal(prose.includes('Breakdown:'), true);
  });

  it('keeps every item the tool reported, under the tool that reported it', () => {
    const { echoes } = splitToolEcho(ANSWER);
    assert.equal(echoes.length, 1);
    assert.equal(echoes[0].tool, 'list_pipelines');
    assert.deepEqual(echoes[0].items, ['New business', 'expansion', 'renewal']);
  });

  it('handles several echoes in one answer', () => {
    const two = `${ANSWER}\n\n\`business_metric\` also returned:\n\n- Closed-won bookings — 6\n- Aldergate Semiconductor`;
    const { echoes, prose } = splitToolEcho(two);
    assert.deepEqual(echoes.map((e) => e.tool), ['list_pipelines', 'business_metric']);
    assert.equal(echoes[1].items.length, 2);
    assert.equal(prose.includes('business_metric'), false);
  });

  it('leaves an answer with no echo in it exactly as it arrived', () => {
    const plain = 'Northwind Robotics is carrying $8,796,980 in open pipeline.\n\nOpen pipeline is a snapshot.';
    const { prose, echoes } = splitToolEcho(plain);
    assert.equal(prose, plain);
    assert.deepEqual(echoes, []);
  });

  it('does not eat a heading that has no list under it', () => {
    const dangling = 'The pipeline is $8m.\n\n`list_pipelines` also returned:\n\nNothing useful.';
    const { prose, echoes } = splitToolEcho(dangling);
    assert.deepEqual(echoes, []);
    assert.equal(prose, dangling);
  });

  it('does not mistake a bullet list that is part of the answer for an echo', () => {
    const bulleted = 'Three deals stalled:\n\n• Aldergate\n• Pemberton\n• Thornbury';
    const { prose, echoes } = splitToolEcho(bulleted);
    assert.deepEqual(echoes, []);
    assert.equal(parseBlocks(prose).filter((b) => b.kind === 'list').length, 1);
  });
});

describe('how sure the engine says it is', () => {
  it('bands a confidence the way the badge reads it', () => {
    assert.equal(confidenceBand(0.96), 'high');
    assert.equal(confidenceBand(0.6), 'medium');
    assert.equal(confidenceBand(0.2), 'low');
    assert.equal(confidenceBand(null), 'low');
  });
});

/* ------------------------- every pipeline at once ------------------------- */

describe('the board that holds every pipeline', () => {
  it('stores an all-pipelines board as a filter that names no pipeline', () => {
    const stored = stateToView(board({ pipeline: ALL_PIPELINES, horizon: '42' }));
    const conditions = (stored.filter && 'filters' in stored.filter ? stored.filter.filters as FilterCondition[] : []);
    assert.equal(conditions.some((c) => c.property === 'pipeline'), false);
    // …and one that does name a pipeline still stores the condition.
    const one = stateToView(board({ pipeline: 'new_business' }));
    const named = (one.filter && 'filters' in one.filter ? one.filter.filters as FilterCondition[] : []);
    assert.deepEqual(named, [{ property: 'pipeline', operator: 'eq', value: 'new_business' }]);
  });

  it('reads a filter with no pipeline condition back as every pipeline, not the default one', () => {
    // The six-week widget counts with exactly this filter — open deals closing
    // inside the window, no pipeline named — so the board it links to has to
    // hold the same set. Reading it back as "" sent it to one pipeline, which
    // is where "14 deals" opened a board headed "7 deals on New business".
    const { state, readable } = viewToState({
      filter: {
        op: 'and',
        filters: [
          { property: 'deal_status', operator: 'eq', value: 'open' },
          { property: 'close_date', operator: 'between', values: ['today', '+42d'] },
        ],
      },
      sort: [{ property: 'close_date', direction: 'asc' }],
    });
    assert.equal(readable, true);
    assert.equal(state.pipeline, ALL_PIPELINES);
    assert.equal(state.horizon, '42');
  });

  it('round-trips both kinds of pipeline scope', () => {
    for (const pipeline of [ALL_PIPELINES, 'renewal']) {
      const start = board({ pipeline, horizon: 'quarter' });
      const { state, readable } = viewToState(stateToView(start));
      assert.equal(readable, true, `${pipeline} did not read back`);
      assert.equal(sameBoardState(state, start), true, `${pipeline} read back as ${state.pipeline}`);
    }
  });

  it('says which pipelines it is showing, in the words the control uses', () => {
    const labels = { pipelineLabel: (n: string) => (n === 'renewal' ? 'Renewal' : n), ownerName: (id: string) => id, forecastLabel: (v: string) => v };
    assert.match(describeBoardState(board({ pipeline: ALL_PIPELINES }), labels), /every pipeline/);
    assert.match(describeBoardState(board({ pipeline: 'renewal' }), labels), /Renewal/);
  });

  it('keeps two pipelines’ same-named stages apart', () => {
    // All three of this workspace's pipelines have a stage called
    // `qualification`; New business labels it "Qualification" and Expansion
    // labels it "Expansion identified". Anything keyed on the bare name merges
    // their money and their stall thresholds.
    assert.notEqual(stageKey('new_business', 'qualification'), stageKey('expansion', 'qualification'));
    assert.equal(stageKey('renewal', 'proposal'), stageKey('renewal', 'proposal'));
  });
});

/* ------------------- a step that ran and said nothing --------------------- */

describe('a step the answer did not spend', () => {
  const APOLOGY = [
    'Northwind Robotics is carrying $9,010,960 in open pipeline, from 38 open deals.',
    'Breakdown: Proposal $2,094,180 · Qualification $2,073,500.',
    "I could not read anything back from list pipelines: it carries no field I can name to you,"
    + " and printing the raw payload would put primary keys and column names in front of you."
    + " It is on this run's trace.",
  ].join('\n\n');

  it('does not leave "I could not read anything back" as the last word of an answer', () => {
    // The same run's trace reads `list_pipelines — 3 items` and "2/2 tools
    // succeeded", so the sentence is false as well as being plumbing narrated
    // at a sales manager.
    const { prose } = splitToolEcho(APOLOGY);
    assert.equal(prose.includes('could not read anything back'), false);
    assert.equal(prose.includes('primary keys'), false);
    assert.equal(prose.includes("run's trace"), false);
    assert.equal(prose.startsWith('Northwind Robotics is carrying'), true);
    assert.equal(prose.includes('Breakdown:'), true);
  });

  it('keeps the fact underneath it — that a step ran and the answer did not use it', () => {
    const { notes } = splitToolEcho(APOLOGY);
    assert.deepEqual(notes, [{ step: 'list pipelines' }]);
  });

  it('leaves an answer that never apologised exactly as it arrived', () => {
    const plain = 'Northwind Robotics is carrying $8,796,980 in open pipeline.\n\nOpen pipeline is a snapshot.';
    const { prose, notes } = splitToolEcho(plain);
    assert.equal(prose, plain);
    assert.deepEqual(notes, []);
  });

  it('does not eat a sentence that merely mentions reading something back', () => {
    const real = 'I could not read anything back from the meter, so nothing is billed yet.';
    const { prose, notes } = splitToolEcho(real);
    assert.equal(prose, real);
    assert.deepEqual(notes, []);
  });
});

/* ==================== the scope an answer was measured at ================== */

/**
 * The vocabulary of the demo workspace, as `/v1/pipelines/deal`, `/v1/users`
 * and `/v1/ai/metrics` answer it. Three deal pipelines, thirteen open stages
 * between them, and four stage machine names shared across pipelines under
 * different labels — which is the whole reason a by-stage breakdown keyed on
 * the bare name cannot be trusted.
 */
const stagesOf = (pipeline: string, pipelineLabel: string, rows: [string, string, boolean, boolean?][]): VocabStage[] =>
  rows.map(([name, label, isClosed, isWon]) => ({ pipeline, pipelineLabel, name, label, isClosed, isWon: !!isWon }));

const VOCAB: Vocabulary = {
  pipelines: [
    {
      name: 'new_business',
      label: 'New business',
      stages: stagesOf('new_business', 'New business', [
        ['qualification', 'Qualification', false],
        ['discovery', 'Discovery', false],
        ['technical_validation', 'Technical validation', false],
        ['proposal', 'Proposal sent', false],
        ['negotiation', 'Negotiation', false],
        ['closed_won', 'Closed won', true, true],
        ['closed_lost', 'Closed lost', true],
      ]),
    },
    {
      name: 'expansion',
      label: 'Expansion',
      stages: stagesOf('expansion', 'Expansion', [
        ['qualification', 'Expansion identified', false],
        ['discovery', 'Scoping', false],
        ['proposal', 'Proposal sent', false],
        ['negotiation', 'Negotiation', false],
        ['closed_won', 'Closed won', true, true],
        ['closed_lost', 'Closed lost', true],
      ]),
    },
    {
      name: 'renewal',
      label: 'Renewal',
      stages: stagesOf('renewal', 'Renewal', [
        ['renewal_outreach', 'Renewal outreach', false],
        ['usage_review', 'Usage & value review', false],
        ['commercial_terms', 'Commercial terms', false],
        ['negotiation', 'Negotiation', false],
        ['closed_won', 'Renewed', true, true],
        ['closed_lost', 'Churned', true],
      ]),
    },
  ],
  people: [
    { id: 'usr_seed01', name: 'Dana Whitfield' },
    { id: 'usr_seed02', name: 'Marcus Ilori' },
    { id: 'usr_seed03', name: 'Priya Raman' },
  ],
  metrics: [
    { id: 'pipeline', label: 'Open pipeline', unit: 'money', keywords: ['pipeline', 'open deals', 'worth'], snapshot: true },
    { id: 'weighted_pipeline', label: 'Weighted pipeline', unit: 'money', keywords: ['weighted', 'forecast'], snapshot: true },
    { id: 'deal_count', label: 'Deals', unit: 'count', keywords: ['deals'], snapshot: true },
    { id: 'closed_lost', label: 'Closed-lost value', unit: 'money', keywords: ['lost'], snapshot: false },
    { id: 'invoiced', label: 'Invoiced', unit: 'money', keywords: ['invoiced', 'invoices'], snapshot: false },
  ],
};

/** The window the engine passes for "Q3 2026 to date" on every unscoped metric. */
const Q3 = { start: 1782864000000, end: 1790812800000, window_label: 'Q3 2026 to date' };

describe('the scope a copilot answer was measured at', () => {

  it('reads a stage list covering every open stage as a status, not as stages', () => {
    const openStages = VOCAB.pipelines.flatMap((p) => p.stages.filter((s) => !s.isClosed).map((s) => s.name));
    const scope = boundScopeOf({
      name: 'record_aggregate',
      arguments: {
        object_type: 'deal',
        conditions: [{ property: 'deal_stage', op: 'in', values: [...new Set(openStages)] }],
        owner_id: 'usr_seed02',
      },
    }, VOCAB);
    assert.deepEqual(scope.stages, []);
    assert.equal(scope.status, 'open');
    assert.equal(scope.ownerId, 'usr_seed02');
  });

});

describe('where a cited record opens', () => {
  it('sends a logged activity to the record screen that renders it', () => {
    // These were drawn as `disabled` buttons — out of the tab order, with the
    // reason in a hover tooltip — over screens that existed all along.
    assert.equal(citationHref({ id: 'call_nw_0442', label: 'Escalation call', type: 'call' }), '/records/call/call_nw_0442');
    assert.equal(citationHref({ id: 'note_x1', label: 'A note', type: 'note' }), '/records/note/note_x1');
    assert.equal(citationHref({ id: 'email_x1', label: 'A thread', type: 'email' }), '/records/email/email_x1');
    assert.equal(citationHref({ id: 'task_x1', label: 'A task', type: 'task' }), '/records/task/task_x1');
    assert.equal(citationHref({ id: 'meeting_x1', label: 'A meeting', type: 'meeting' }), '/records/meeting/meeting_x1');
    assert.equal(citationHref({ id: 'mtr_x1', label: 'Telemetry events', type: 'meter' }), '/revenue/usage/mtr_x1');
  });

  it('leaves the screens that were already right alone', () => {
    assert.equal(citationHref({ id: 'deal_1', label: 'A deal', type: 'deal' }), '/deals/deal_1');
    assert.equal(citationHref({ id: 'cmp_1', label: 'A company', type: 'company' }), '/companies/cmp_1');
    // The invoice screen moved under /billing in the coherence pass; the
    // citation follows it there rather than to the address that no longer exists.
    assert.equal(citationHref({ id: 'in_1', label: 'An invoice', type: 'invoice' }), '/billing/invoices/in_1');
    assert.equal(citationHref({ id: 'prc_1', label: 'A price', type: 'price' }), null);
  });
});

/* ================== a count of things answered in money =================== */

describe('the scope row and database ids', () => {
  it('knows one when it sees one', () => {
    assert.equal(looksLikeRecordId('cus_dgqX6o9tM1BGxIWi'), true);
    assert.equal(looksLikeRecordId('cmp_nw_01'), true);
    assert.equal(looksLikeRecordId('usr_seed01'), true);
    assert.equal(looksLikeRecordId('Meridian Forge Systems'), false);
    assert.equal(looksLikeRecordId('Whitcombe Aerospace'), false);
  });

});

/* ============ a question that names one record, answered for another ======= */

describe('a question that names one deal, answered for the account above it', () => {
  it('reads the disambiguator a resolved record does not carry', () => {
    assert.deepEqual(
      recordPhraseMismatch(
        'Move the Sakamoto Seiki — packaging line uplift deal to Negotiation.',
        'Sakamoto Seiki — multi-site rollout',
      ),
      { asked: 'Sakamoto Seiki — packaging line uplift', used: 'Sakamoto Seiki — multi-site rollout' },
    );
    // The same sentence about the deal it actually names contradicts nothing.
    assert.equal(
      recordPhraseMismatch(
        'Move the Sakamoto Seiki — packaging line uplift deal to Negotiation.',
        'Sakamoto Seiki — packaging line uplift',
      ),
      null,
    );
  });

  it('says nothing about a partial mention, an exact one, or an unrelated record', () => {
    // A question that names a prefix and stops has not contradicted anything.
    assert.equal(recordPhraseMismatch('Move the Sakamoto deal to Negotiation.', 'Sakamoto Seiki — multi-site rollout'), null);
    assert.equal(recordPhraseMismatch('Add a note to Meridian Forge Systems.', 'Meridian Forge Systems'), null);
    assert.equal(recordPhraseMismatch('What is the CSAT for Meridian Forge Systems?', 'Meridian Forge Systems'), null);
    assert.equal(recordPhraseMismatch('How much pipeline does Marcus Ilori own?', 'Whitcombe Aerospace'), null);
    // A word the record already carries elsewhere in its own name is not a
    // disambiguator it lacks.
    assert.equal(recordPhraseMismatch('Update the Northwind renewal deal', 'Northwind Robotics — renewal 2027'), null);
  });

  it('knows which of two names is the wider one', () => {
    assert.equal(isWiderName('Sakamoto Seiki — packaging line uplift', 'Sakamoto Seiki'), true);
    assert.equal(isWiderName('Sakamoto Seiki', 'Sakamoto Seiki — packaging line uplift'), false);
    assert.equal(isWiderName('Sakamoto Seiki', 'Sakamoto Seiki'), false);
  });

});

/* ================== a counting question answered in money ================= */

/* ============ a measure the answering step could not have computed ========= */

/* ==================== the period the query actually ran ==================== */

describe('the period chip and the window the query ran', () => {
  const Q4 = { start: Date.UTC(2026, 9, 1), end: Date.UTC(2027, 0, 1), label: null };

  it('states the last instant the window contains, not the first it excludes', () => {
    const seen: number[] = [];
    const text = windowText(Q4, {
      dateRange: (start, end) => { seen.push(start, end); return 'range'; },
      date: () => 'day',
    });
    assert.equal(text, 'range');
    assert.deepEqual(seen, [Date.UTC(2026, 9, 1), Date.UTC(2026, 11, 31, 23, 59, 59, 999)]);
    assert.equal(lastInstantOf(Date.UTC(2027, 0, 1)), Date.UTC(2026, 11, 31, 23, 59, 59, 999));
  });

  it('reads back as the quarter that was asked for, in the engine’s own calendar', () => {
    // "How many deals will close in Q4 2026?" ran start=2026-10-01T00:00Z,
    // end=2027-01-01T00:00Z and the chip read "Sep 30, 2026 – Dec 31, 2026".
    const stated = windowText(Q4, {
      dateRange: (start, end) => formatDateRange(start, end, { locale: 'en-US', timeZone: 'UTC' }),
      date: (ts) => formatDate(ts, { locale: 'en-US', timeZone: 'UTC' }),
    });
    assert.match(stated, /^Oct 1/);
    assert.match(stated, /Dec 31, 2026$/);
    assert.equal(stated.includes('Sep'), false);
  });

  it('leaves the engine’s own label alone when it wrote one', () => {
    assert.equal(
      windowText({ start: 1, end: 2, label: 'Q3 2026 to date' }, { dateRange: () => 'range', date: () => 'day' }),
      'Q3 2026 to date',
    );
  });
});

/* ================= the write that landed on the wrong record =============== */

describe('the record a queued write would land on', () => {
  it('is read off the card a person actually approves', () => {
    assert.equal(
      writeTargetLabel('update_record', { object_type: 'deal', id: 'deal_nw_59' },
        ['Deal Sakamoto Seiki — multi-site rollout', 'Deal stage → negotiation']),
      'Sakamoto Seiki — multi-site rollout',
    );
    assert.equal(
      writeTargetLabel('add_note', { record_ids: ['cmp_nw_21'] }, ['Note on Ferro Norte Siderurgia', 'Subject: Outage']),
      'Ferro Norte Siderurgia',
    );
    assert.equal(
      writeTargetLabel('schedule_followup', { record_id: 'cmp_nw_02' }, ['Follow-up on Aldergate Logistics', 'Due in 3 days']),
      'Aldergate Logistics',
    );
    // A target the engine could not name has already said the loudest true
    // thing about itself, and a name read out of that sentence would be false.
    assert.equal(
      writeTargetLabel('update_record', { object_type: 'deal', id: 'deal_x' }, ['Deal a record I can no longer name']),
      null,
    );
    assert.equal(writeTargetLabel('create_record', { object_type: 'deal' }, ['New deal', 'Amount: 1000']), null);
  });

  it('catches the write prepared against a sibling of the deal that was named', () => {
    // The critic's run: the question named the packaging line uplift deal
    // (deal_nw_60, $402,300, at Proposal) and the approval card was prepared
    // against deal_nw_59 — Sakamoto Seiki — multi-site rollout, closed won at
    // $321,840. Approving it moved $321,840 out of closed-won.
    const question = 'Move the Sakamoto Seiki — packaging line uplift deal to Negotiation.';
    const target = writeTargetLabel(
      'update_record',
      { object_type: 'deal', id: 'deal_nw_59', properties: { deal_stage: 'negotiation' } },
      ['Deal Sakamoto Seiki — multi-site rollout', 'Deal stage → negotiation'],
    );
    assert.equal(target, 'Sakamoto Seiki — multi-site rollout');
    const mismatch = recordPhraseMismatch(question, target!);
    assert.ok(mismatch, 'a write against the wrong deal read as a write against the right one');
    assert.equal(mismatch.asked, 'Sakamoto Seiki — packaging line uplift');
    assert.equal(mismatch.used, 'Sakamoto Seiki — multi-site rollout');
  });

  it('says nothing about the same write prepared against the deal that was named', () => {
    const target = writeTargetLabel(
      'update_record',
      { object_type: 'deal', id: 'deal_nw_60' },
      ['Deal Sakamoto Seiki — packaging line uplift', 'Deal stage → negotiation'],
    );
    assert.equal(
      recordPhraseMismatch('Move the Sakamoto Seiki — packaging line uplift deal to Negotiation.', target!),
      null,
    );
  });
});

/* ===================== a refusal is not a success ========================== */

describe('what the run log calls a run that refused to answer', () => {
  const refused = {
    status: 'succeeded',
    reasoning: [
      'Qualifier ledger settled: metric "arr" refused; pipeline "Renewal" refused.',
      'Refused after the run (qualifier_unbound): You asked about the Renewal pipeline, and I could not apply it to ARR.',
    ],
  };

  it('is not "Succeeded"', () => {
    // 93 runs, a Failed tile reading 0, and two refusals in the table at 75%
    // and 77% confidence both labelled Succeeded — with no filter that could
    // find them and no tile that counted them.
    assert.equal(runOutcome(refused, []), 'refused');
    assert.equal(OUTCOME_LABEL.refused, 'Refused');
    assert.equal(OUTCOME_TONE.refused, 'warning');
  });

  it('leaves every other outcome exactly where it was', () => {
    assert.equal(runOutcome({ status: 'succeeded', reasoning: ['Ran business_metric in 2ms → $9,010,960.'] }, []), 'succeeded');
    assert.equal(runOutcome({ status: 'failed', reasoning: [] }, []), 'failed');
    assert.equal(runOutcome({ status: 'running', reasoning: [] }, []), 'running');
    // A refusal a person still has to decide on is a decision, not a refusal.
    const pending = [{ status: 'pending' } as AiApproval];
    assert.equal(runOutcome(refused, pending), 'needs_approval');
    // …and a failed run stays failed even when its notes carry a refusal line.
    assert.equal(runOutcome({ ...refused, status: 'failed' }, []), 'failed');
  });
});

/* ===================== crossing the board from the keyboard =============== */

describe('the board as a grid the keyboard can cross', () => {
  // Three columns as the board draws them, the middle one empty.
  const GRID = [['d1', 'd2', 'd3'], [], ['d4', 'd5']];

  it('moves down and up inside a column and stops at its ends', () => {
    assert.equal(boardMove(GRID, 'd1', 'ArrowDown'), 'd2');
    assert.equal(boardMove(GRID, 'd2', 'ArrowUp'), 'd1');
    assert.equal(boardMove(GRID, 'd3', 'ArrowDown'), null);
    assert.equal(boardMove(GRID, 'd1', 'ArrowUp'), null);
  });

  it('crosses to the next column that has cards in it', () => {
    // Stopping in the empty middle column would make crossing a sparse board
    // cost one press per empty stage, which is the defect one column over.
    assert.equal(boardMove(GRID, 'd1', 'ArrowRight'), 'd4');
    assert.equal(boardMove(GRID, 'd4', 'ArrowLeft'), 'd1');
    // A shorter column takes the keyboard to its last card rather than nowhere.
    assert.equal(boardMove(GRID, 'd3', 'ArrowRight'), 'd5');
    assert.equal(boardMove(GRID, 'd5', 'ArrowRight'), null);
    assert.equal(boardMove(GRID, 'd1', 'ArrowLeft'), null);
  });

  it('takes Home and End to the ends of the column it is in', () => {
    assert.equal(boardMove(GRID, 'd2', 'Home'), 'd1');
    assert.equal(boardMove(GRID, 'd2', 'End'), 'd3');
    assert.equal(boardMove(GRID, 'd1', 'Home'), null);
  });

  it('knows which keys are its own', () => {
    assert.deepEqual([...BOARD_KEYS], ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);
    assert.equal(isBoardKey('Tab'), false);
    assert.equal(isBoardKey('Enter'), false);
    assert.equal(isBoardKey('ArrowRight'), true);
  });

  it('always leaves exactly one card in the tab order', () => {
    assert.equal(boardTabStop(GRID, null), 'd1');
    assert.equal(boardTabStop(GRID, 'd5'), 'd5');
    // A card filtered away, moved to a hidden closed stage or dragged elsewhere
    // takes the tab stop with it, and a board with no `tabindex="0"` on it
    // cannot be reached from the keyboard at all.
    assert.equal(boardTabStop(GRID, 'gone'), 'd1');
    assert.equal(boardTabStop([[], []], 'gone'), null);
  });

  it('puts the keyboard somewhere sensible when it was nowhere', () => {
    assert.equal(boardMove(GRID, 'not-on-the-board', 'ArrowDown'), 'd1');
  });
});

/* ================= the phrasing this engine actually answers =============== */

/* ============= a pipeline the answer says does not exist, that does ======== */

/* ------------------------- the year on a calendar day --------------------- */

describe('the year on a close date', () => {
  it('is said when the day is in another year, and only then', () => {
    // A card reading "Oct 21" over a deal booked on 21 October 2025 reads as
    // next month from September 2026.
    assert.equal(needsYear(Date.UTC(2025, 9, 21), TODAY), true);
    assert.equal(needsYear(Date.UTC(2027, 0, 1), TODAY), true);
    assert.equal(needsYear(Date.UTC(2026, 0, 1), TODAY), false);
    assert.equal(needsYear(Date.UTC(2026, 11, 31), TODAY), false);
    assert.equal(needsYear(TODAY, TODAY), false);
  });
});

/* --------------------- the verb on a closed deal's date ------------------- */

describe('the verb on a closed deal’s close date', () => {
  it('books a won deal and loses a lost one', () => {
    assert.equal(closedVerb({ is_closed: true, is_won: true }), 'Booked');
    // A Closed-lost record used to caption its close date "Booked in 4 days".
    assert.equal(closedVerb({ is_closed: true, is_won: false }), 'Lost');
  });

  it('says nothing about an open deal, or a deal whose stage is unknown', () => {
    assert.equal(closedVerb({ is_closed: false, is_won: false }), null);
    assert.equal(closedVerb(undefined), null);
  });
});

/* ------------------------ the forecast's periods ------------------------- */

describe('the quarters either side of this one', () => {
  it('are whole calendar quarters, across a year boundary too', () => {
    assert.deepEqual(horizonWindow('next_quarter', TODAY), { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 11, 31) });
    assert.deepEqual(horizonWindow('last_quarter', TODAY), { from: Date.UTC(2026, 3, 1), to: Date.UTC(2026, 5, 30) });
    assert.deepEqual(horizonWindow('year', TODAY), { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 11, 31) });
    const december = Date.UTC(2026, 11, 15);
    assert.deepEqual(horizonWindow('next_quarter', december), { from: Date.UTC(2027, 0, 1), to: Date.UTC(2027, 2, 31) });
    const january = Date.UTC(2027, 0, 4);
    assert.deepEqual(horizonWindow('last_quarter', january), { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 11, 31) });
    assert.equal(quarterEnd(TODAY, 1), Date.UTC(2026, 11, 31));
  });

  it('are named the way a forecast call names them', () => {
    assert.equal(quarterName(TODAY), 'Q3 2026');
    assert.equal(quarterName(quarterStart(TODAY, 1)), 'Q4 2026');
    assert.equal(quarterName(quarterStart(Date.UTC(2026, 11, 15), 1)), 'Q1 2027');
  });

  it('are every one of them a horizon the board can be filtered to', () => {
    for (const period of FORECAST_PERIODS) {
      assert.ok(HORIZONS.includes(period), `${period} is not a board horizon`);
      assert.ok(PERIOD_LABEL[period]);
    }
    assert.ok(matchesHorizon(Date.UTC(2026, 10, 2), 'next_quarter', TODAY));
    assert.equal(matchesHorizon(Date.UTC(2026, 10, 2), 'quarter', TODAY), false);
    assert.ok(matchesHorizon(Date.UTC(2026, 4, 2), 'last_quarter', TODAY));
    assert.ok(matchesHorizon(Date.UTC(2026, 4, 2), 'year', TODAY));
    assert.equal(matchesHorizon(Date.UTC(2025, 4, 2), 'year', TODAY), false);
  });

  it('save as the filter engine’s own tokens where it has them', () => {
    const year = stateToView(board({ horizon: 'year' }));
    assert.deepEqual(year.filter, {
      op: 'and',
      filters: [{ property: 'close_date', operator: 'between', values: ['start_of_year', 'end_of_year'] }],
    });
    const back = viewToState({ filter: year.filter, sort: year.sort });
    assert.equal(back.readable, true);
    assert.equal(back.state.horizon, 'year');
  });

  it('save next quarter as the days it is today, and read those days back as whatever quarter they are now', () => {
    const saved = stateToView(board({ horizon: 'next_quarter' }), TODAY);
    const condition = (saved.filter as { filters: FilterCondition[] }).filters[0];
    assert.deepEqual(condition, { property: 'close_date', operator: 'between', values: [Date.UTC(2026, 9, 1), Date.UTC(2026, 11, 31)] });

    // Read in September, it is next quarter.
    assert.deepEqual(viewToState({ filter: saved.filter, sort: saved.sort }, TODAY), {
      state: board({ horizon: 'next_quarter' }), readable: true,
    });
    // Read in November, the same days are this quarter — the same deals.
    assert.equal(viewToState({ filter: saved.filter, sort: saved.sort }, Date.UTC(2026, 10, 9)).state.horizon, 'quarter');
    // Read the following February, they were last quarter.
    assert.equal(viewToState({ filter: saved.filter, sort: saved.sort }, Date.UTC(2027, 1, 9)).state.horizon, 'last_quarter');
    // Read a year on, the window is nothing the board's controls can say.
    assert.equal(viewToState({ filter: saved.filter, sort: saved.sort }, Date.UTC(2027, 8, 9)).readable, false);
    // And without a clock to read them against, dated windows are not guessed at.
    assert.equal(viewToState({ filter: saved.filter, sort: saved.sort }).readable, false);
  });
});

/* -------------------------- the table's sort toggle ----------------------- */

describe('a sorted column clicked again', () => {
  const sorted: TableState = { query: '', sort: { columnId: 'amount', direction: 'desc' }, filters: {} };

  it('reverses rather than going blank first', () => {
    // The grid's own cycle is asc → desc → none: the second click on Amount
    // used to put the deals in whatever order the server sent them.
    const cleared: TableState = { ...sorted, sort: null };
    assert.deepEqual(reverseClearedSort(sorted, cleared).sort, { columnId: 'amount', direction: 'asc' });
    const ascending: TableState = { ...sorted, sort: { columnId: 'amount', direction: 'asc' } };
    assert.deepEqual(reverseClearedSort(ascending, cleared).sort, { columnId: 'amount', direction: 'desc' });
  });

  it('leaves every other change alone', () => {
    const other: TableState = { ...sorted, sort: { columnId: 'close_date', direction: 'asc' } };
    assert.equal(reverseClearedSort(sorted, other), other);
    const searched: TableState = { ...sorted, sort: null, query: 'wexler' };
    assert.equal(reverseClearedSort(sorted, searched), searched);
    const unsorted: TableState = { ...sorted, sort: null };
    assert.equal(reverseClearedSort(unsorted, { ...unsorted, filters: {} }).sort, null);
  });
});

/* ------------------------------ the forecast ------------------------------ */

describe('the forecast rollup', () => {
  const deal = (over: Partial<ForecastDeal>): ForecastDeal => ({
    id: 'd', owner_id: 'u1', pipeline: 'new_business', amount: 0, weighted: 0, status: 'open', category: 'pipeline', ...over,
  });
  const deals: ForecastDeal[] = [
    deal({ id: 'a', amount: 100_00, weighted: 80_00, category: 'commit' }),
    deal({ id: 'b', amount: 200_00, weighted: 50_00, category: 'best_case' }),
    deal({ id: 'c', owner_id: 'u2', amount: 400_00, weighted: 400_00, status: 'won', category: 'closed' }),
    deal({ id: 'd', owner_id: 'u2', amount: 50_00, weighted: 0, status: 'lost', category: 'closed' }),
    deal({ id: 'e', owner_id: null, pipeline: 'renewal', amount: 70_00, weighted: 7_00, category: 'pipeline' }),
    deal({ id: 'f', amount: 10_00, weighted: 5_00, category: 'omitted' }),
  ];

  it('puts each deal in the column its status and category say', () => {
    assert.equal(bucketOf({ status: 'open', category: 'commit' }), 'commit');
    assert.equal(bucketOf({ status: 'open', category: 'best_case' }), 'best_case');
    assert.equal(bucketOf({ status: 'open', category: 'pipeline' }), 'pipeline');
    // Both closed stages carry the `closed` category; the status tells them apart.
    assert.equal(bucketOf({ status: 'won', category: 'closed' }), 'won');
    assert.equal(bucketOf({ status: 'lost', category: 'closed' }), 'lost');
    // An open deal with no forecast column is left out, and counted as such.
    assert.equal(bucketOf({ status: 'open', category: 'omitted' }), 'omitted');
    assert.equal(bucketOf({ status: 'open', category: '' }), 'omitted');
    assert.equal(bucketOf({ status: 'open', category: 'closed' }), 'omitted');
  });

  it('totals every column, largest forecast first, with the unowned as their own row', () => {
    const rollup = rollupForecast(deals, byOwner);
    assert.deepEqual(rollup.lines.map((line) => line.key), ['u2', 'u1', UNASSIGNED]);
    const [u2, u1, nobody] = rollup.lines;
    assert.deepEqual(u2.cells.won, { amount: 400_00, count: 1 });
    assert.deepEqual(u2.cells.lost, { amount: 50_00, count: 1 });
    assert.deepEqual(u2.forecast, { amount: 400_00, count: 1 });
    assert.equal(u2.weighted, 0);
    assert.deepEqual(u1.cells.commit, { amount: 100_00, count: 1 });
    assert.deepEqual(u1.cells.best_case, { amount: 200_00, count: 1 });
    assert.deepEqual(u1.cells.omitted, { amount: 10_00, count: 1 });
    assert.deepEqual(u1.forecast, { amount: 300_00, count: 2 });
    // Weighted covers the forecast columns only: the omitted deal's $5 is not in it.
    assert.equal(u1.weighted, 130_00);
    assert.deepEqual(nobody.cells.pipeline, { amount: 70_00, count: 1 });
    assert.equal(rollup.deals, 6);
  });

  it('computes the total over the deals, and it agrees with the lines', () => {
    const rollup = rollupForecast(deals, byOwner);
    assert.deepEqual(rollup.total.forecast, { amount: 770_00, count: 4 });
    assert.equal(rollup.total.weighted, 137_00);
    assert.deepEqual(rollup.total.cells.omitted, { amount: 10_00, count: 1 });
    assert.deepEqual(rollup.total.cells.lost, { amount: 50_00, count: 1 });
    for (const bucket of FORECAST_BUCKETS) {
      const summed = rollup.lines.reduce((sum, line) => sum + line.cells[bucket].amount, 0);
      assert.equal(rollup.total.cells[bucket].amount, summed, bucket);
    }
  });

  it('groups by pipeline when asked, with the same total', () => {
    const rollup = rollupForecast(deals, byPipeline);
    assert.deepEqual(rollup.lines.map((line) => line.key), ['new_business', 'renewal']);
    assert.deepEqual(rollup.total.forecast, rollupForecast(deals, byOwner).total.forecast);
  });

  it('draws a row’s mix as shares of its own forecast that add up to one', () => {
    const rollup = rollupForecast(deals, byOwner);
    const parts = composition(rollup.lines[1]);
    assert.deepEqual(parts.map((part) => part.bucket), ['commit', 'best_case']);
    assert.equal(parts.reduce((sum, part) => sum + part.share, 0), 1);
    assert.deepEqual(composition(rollupForecast([], byOwner).total), []);
  });
});

/* ------------------------- the deals table as a file ---------------------- */

describe('the deals table as a file', () => {
  const columns = dealExportColumns({
    allMode: false,
    major: (minor) => minor / 100,
    now: TODAY,
    accountName: () => 'Rheinwerk Antriebstechnik',
    pipelineLabel: () => 'New business',
    stageLabel: () => 'Proposal sent',
    ownerName: (id) => (id === 'usr_seed03' ? 'Priya Raman' : ''),
  });
  const row = {
    id: 'deal_1',
    display_name: 'Rheinwerk — OEE programme phase 2',
    owner_id: 'usr_seed03',
    properties: {
      amount: 80_000_00, probability: 60, weighted_amount: 48_000_00, close_date: Date.UTC(2026, 9, 21),
      forecast_category: 'commit', deal_status: 'open', stage_entered_at: TODAY - 12 * DAY_MS,
    },
  };

  it('writes stored values a spreadsheet can read back, in the table’s column order', () => {
    const { headers, lines } = dealCsv([row], columns);
    assert.deepEqual(headers, [
      'Id', 'Deal', 'Account', 'Stage', 'Amount', 'Probability', 'Weighted', 'Close date', 'Owner',
      'Forecast category', 'Status', 'Days in stage', 'Stage entered',
    ]);
    assert.deepEqual(lines, [[
      'deal_1', 'Rheinwerk — OEE programme phase 2', 'Rheinwerk Antriebstechnik', 'Proposal sent',
      '80000', '60', '48000', '2026-10-21', 'Priya Raman', 'commit', 'open', '12',
      new Date(TODAY - 12 * DAY_MS).toISOString(),
    ]]);
  });

  it('leaves a blank where the deal has nothing, rather than a zero or an epoch', () => {
    const bare = { id: 'deal_2', display_name: 'Bare', owner_id: null, properties: {} };
    const [line] = dealCsv([bare], columns).lines;
    assert.deepEqual(line.slice(4), ['', '', '', '', '', '', '', '', '']);
    assert.equal(isoDay(null), '');
  });

  it('adds the pipeline column only when the table spans every pipeline', () => {
    const across = dealExportColumns({
      allMode: true, major: (m) => m, now: TODAY,
      accountName: () => '', pipelineLabel: () => 'Renewal', stageLabel: () => '', ownerName: () => '',
    });
    assert.deepEqual(across.map((column) => column.header).slice(2, 5), ['Account', 'Pipeline', 'Stage']);
    assert.equal(dealCsv([row], across).lines[0][3], 'Renewal');
  });
});

/* ------------------------- the addresses under /deals --------------------- */

describe('the addresses under /deals', () => {
  // The route table is read off the module as written, so this fails the
  // moment a static address is dropped and falls back into `/deals/:id`.
  const source = readFileSync(new URL('../src/client/modules/pipeline/routes.tsx', import.meta.url), 'utf8');
  const paths = [...source.matchAll(/\{ path: '([^']+)', element/g)].map((m) => m[1]);
  const defs = paths.map((path) => ({ path, element: () => null }));

  it('give the table and the forecast their own screens instead of a deal called "table"', () => {
    assert.ok(paths.includes('/deals/table'), `routes are ${paths.join(', ')}`);
    assert.ok(paths.includes('/deals/forecast'), `routes are ${paths.join(', ')}`);
    assert.equal(matchRoute(defs, '/deals/table')?.route.path, '/deals/table');
    assert.equal(matchRoute(defs, '/deals/forecast')?.route.path, '/deals/forecast');
  });

  it('still open a deal by its id', () => {
    const match = matchRoute(defs, '/deals/deal_nw_54');
    assert.equal(match?.route.path, '/deals/:id');
    assert.deepEqual(match?.params, { id: 'deal_nw_54' });
  });
});

/* ------------------------------- typed dates ------------------------------ */

describe('a date as a person types it', () => {
  const oct21 = Date.UTC(2026, 9, 21);

  it('reads the locale’s own order off the locale', () => {
    assert.equal(dateOrderOf('en-US'), 'mdy');
    assert.equal(dateOrderOf('en-GB'), 'dmy');
    assert.equal(dateOrderOf('de-DE'), 'dmy');
    assert.equal(dateOrderOf('sv-SE'), 'ymd');
    assert.equal(dateOrderOf('not-a-locale-at-all'), 'mdy');
  });

  it('takes ISO whatever the locale', () => {
    assert.equal(parseTypedDate('2026-10-21', 'mdy', TODAY), oct21);
    assert.equal(parseTypedDate('2026-10-21', 'dmy', TODAY), oct21);
    assert.equal(parseTypedDate(' 2026-10-21 ', 'ymd', TODAY), oct21);
  });

  it('reads numeric dates in the order the workspace writes them', () => {
    assert.equal(parseTypedDate('10/21/2026', 'mdy', TODAY), oct21);
    assert.equal(parseTypedDate('21/10/2026', 'dmy', TODAY), oct21);
    assert.equal(parseTypedDate('21.10.2026', 'dmy', TODAY), oct21);
    assert.equal(parseTypedDate('2026/10/21', 'ymd', TODAY), oct21);
    // A four-digit year up front is a year in any order.
    assert.equal(parseTypedDate('2026/10/21', 'mdy', TODAY), oct21);
    // Two digits of year mean this century.
    assert.equal(parseTypedDate('10/21/26', 'mdy', TODAY), oct21);
    // No year means this year.
    assert.equal(parseTypedDate('10/21', 'mdy', TODAY), oct21);
    assert.equal(parseTypedDate('21/10', 'dmy', TODAY), oct21);
    // The same digits are a different day in a different locale — that is the point.
    assert.equal(parseTypedDate('3/10/2026', 'mdy', TODAY), Date.UTC(2026, 2, 10));
    assert.equal(parseTypedDate('3/10/2026', 'dmy', TODAY), Date.UTC(2026, 9, 3));
  });

  it('reads a month by name in either position', () => {
    assert.equal(parseTypedDate('Oct 21', 'mdy', TODAY), oct21);
    assert.equal(parseTypedDate('21 Oct', 'dmy', TODAY), oct21);
    assert.equal(parseTypedDate('October 21, 2026', 'mdy', TODAY), oct21);
    assert.equal(parseTypedDate('21 October 2026', 'dmy', TODAY), oct21);
    assert.equal(parseTypedDate('2026 Oct 21', 'ymd', TODAY), oct21);
    assert.equal(parseTypedDate('Oct 21 26', 'mdy', TODAY), oct21);
    assert.equal(parseTypedDate('Sept 1', 'mdy', TODAY), Date.UTC(2026, 8, 1));
  });

  it('knows today, tomorrow and yesterday relative to the workspace’s day', () => {
    assert.equal(parseTypedDate('today', 'mdy', TODAY), TODAY);
    assert.equal(parseTypedDate('Tomorrow', 'mdy', TODAY), TODAY + DAY_MS);
    assert.equal(parseTypedDate('yesterday', 'mdy', TODAY), TODAY - DAY_MS);
  });

  it('refuses what is not a date rather than guessing', () => {
    assert.equal(parseTypedDate('', 'mdy', TODAY), null);
    assert.equal(parseTypedDate('soon', 'mdy', TODAY), null);
    assert.equal(parseTypedDate('13/45/2026', 'mdy', TODAY), null);
    assert.equal(parseTypedDate('2026-02-30', 'mdy', TODAY), null);
    assert.equal(parseTypedDate('Feb 30', 'mdy', TODAY), null);
    assert.equal(parseTypedDate('Octember 4', 'mdy', TODAY), null);
    assert.equal(parseTypedDate('1/2/3/4', 'mdy', TODAY), null);
    assert.equal(parseTypedDate('Oct 21 2026 extra', 'mdy', TODAY), null);
  });

  it('shows an example in the order it will read', () => {
    assert.equal(dateExample('mdy', TODAY), '09/02/2026');
    assert.equal(dateExample('dmy', TODAY), '02/09/2026');
    assert.equal(dateExample('ymd', TODAY), '2026-09-02');
  });
});

/* ------------------------- closed deals are closed ------------------------ */

describe('a closed deal on the board', () => {
  const won = { is_closed: true, is_won: true };
  const lost = { is_closed: true, is_won: false };
  const open = { is_closed: false, is_won: false };

  it('leads with its outcome, and an open deal with nothing', () => {
    assert.equal(outcomeWord(won), 'Won');
    assert.equal(outcomeWord(lost), 'Lost');
    assert.equal(outcomeWord(open), null);
    assert.equal(outcomeWord(undefined), null);
  });

  it('keeps the outcome and the close-date verb apart: a win is Won, and it was Booked', () => {
    assert.equal(closedVerb(won), 'Booked');
    assert.equal(outcomeWord(won), 'Won');
    assert.equal(closedVerb(lost), outcomeWord(lost));
  });
});

describe('the columns a pipeline puts on the board', () => {
  const stages = [
    { name: 'qualification', is_closed: false, is_won: false },
    { name: 'negotiation', is_closed: false, is_won: false },
    { name: 'closed_won', is_closed: true, is_won: true },
    { name: 'closed_lost', is_closed: true, is_won: false },
  ];
  const names = (rows: typeof stages) => rows.map((stage) => stage.name);

  it('are the open ones, or all of them, as the switch says', () => {
    assert.deepEqual(names(columnsFor(stages, false, '')), ['qualification', 'negotiation']);
    assert.deepEqual(names(columnsFor(stages, true, '')), ['qualification', 'negotiation', 'closed_won', 'closed_lost']);
  });

  it('narrowed to an outcome, are that outcome’s closed stage and nothing else', () => {
    // The forecast's "5 deals were lost" link used to land on five empty open
    // columns with the lost cards off-screen to the right of them.
    assert.deepEqual(names(columnsFor(stages, true, 'lost')), ['closed_lost']);
    assert.deepEqual(names(columnsFor(stages, true, 'won')), ['closed_won']);
    // The switch cannot hide the only column the filter can land in.
    assert.deepEqual(names(columnsFor(stages, false, 'lost')), ['closed_lost']);
  });
});

describe('the board’s subtitle', () => {
  const money = (minor: number) => `$${(minor / 100).toFixed(2)}`;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const base = {
    where: 'across 4 pipelines', showClosed: true, open: { amount: 0, weighted: 0 }, closed: { amount: 13_624_000 }, plural, money,
  };

  it('quotes what was lost over a set narrowed to the lost deals, never "$0.00 open"', () => {
    const line = boardHeadline({ ...base, shown: 5, status: 'lost' });
    assert.equal(line, '5 lost deals across 4 pipelines · $136240.00 lost');
    assert.equal(boardHeadline({ ...base, shown: 1, status: 'won', closed: { amount: 500 } }), '1 won deal across 4 pipelines · $5.00 won');
  });

  it('quotes open and weighted otherwise, and says when the closed stages are off', () => {
    assert.equal(
      boardHeadline({ ...base, shown: 22, status: '', showClosed: false, where: 'on New business', open: { amount: 438_546_000, weighted: 180_932_700 } }),
      '22 deals on New business, open stages only · $4385460.00 open · $1809327.00 weighted',
    );
    assert.equal(
      boardHeadline({ ...base, shown: 61, status: '', where: 'on New business', open: { amount: 100, weighted: 10 } }),
      '61 deals on New business · $1.00 open · $0.10 weighted',
    );
    assert.equal(moneyLine({ status: '', open: { amount: 100, weighted: 10 }, closed: { amount: 500 }, money }), '$1.00 open · $0.10 weighted');
  });
});

/* ------------------------- one sort behind two controls ------------------- */

describe('one sort behind two controls', () => {
  it('names every toolbar sort as a table column and direction, and reads each back', () => {
    for (const option of SORTS) {
      assert.ok(TABLE_SORT[option.value], `${option.value} has no table sort`);
      assert.equal(sortKeyOf(TABLE_SORT[option.value]), option.value);
    }
  });

  it('reads a header sort back as the toolbar option that means it', () => {
    // The critic's case: the grid sorted ascending by close date while the
    // toolbar still read "Largest first".
    assert.equal(sortKeyOf({ columnId: 'close_date', direction: 'asc' }), 'close');
    assert.equal(sortKeyOf({ columnId: 'amount', direction: 'desc' }), 'amount');
    // "Longest in stage" is the most days first.
    assert.equal(sortKeyOf({ columnId: 'stage_age', direction: 'desc' }), 'stage');
    assert.equal(sortKeyOf({ columnId: 'updated', direction: 'desc' }), 'updated');
  });

  it('admits an order the toolbar has no word for, and names it rather than misreporting it', () => {
    assert.equal(sortKeyOf({ columnId: 'amount', direction: 'asc' }), null);
    assert.equal(sortKeyOf({ columnId: 'probability', direction: 'desc' }), null);
    assert.equal(sortKeyOf(null), null);
    assert.equal(describeTableSort({ columnId: 'probability', direction: 'desc' }, 'Probability'), 'By probability, descending');
    assert.equal(describeTableSort({ columnId: 'amount', direction: 'asc' }, 'Amount'), 'By amount, ascending');
    assert.ok(!SORTS.some((option) => option.value === CUSTOM_SORT), 'the custom marker must not collide with a real sort');
  });
});

/* ---------------------------- the closing dialog -------------------------- */

describe('the closing dialog’s confirm button', () => {
  it('says "Mark lost" under a title that says Closed lost, as "Mark won" does for a win', () => {
    const source = readFileSync(new URL('../src/client/modules/pipeline/dialogs.tsx', import.meta.url), 'utf8');
    assert.ok(source.includes("'Mark won'"), 'the win label is missing');
    assert.ok(source.includes("'Mark lost'"), 'the loss label is missing');
    assert.ok(!source.includes('Mark closed'), 'the button still reads "Mark closed"');
  });
});

/* ------------------------------ the 1024 layout --------------------------- */

describe('the stat tiles below the toolbar’s breakpoint', () => {
  it('are laid out two by two, by a rule that comes after the one it overrides', () => {
    const css = readFileSync(new URL('../src/client/modules/pipeline/pipeline.css', import.meta.url), 'utf8');
    const base = css.indexOf('.pl-summary {');
    const narrow = css.search(/@media \(max-width: 1180px\) \{\s*\.pl-summary \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    assert.ok(base >= 0, 'the tile grid has no base rule');
    assert.ok(narrow >= 0, 'no rule lays the tiles out two by two below 1180px');
    // Equal specificity: whichever is later wins, so the override must be later.
    assert.ok(narrow > base, 'the two-by-two rule is written before the rule it overrides, so it never applies');
  });
});

/* -------------------- who the board offers a write to --------------------- */

/**
 * The rung, in the words the reader gets.
 *
 * `POST/PATCH /v1/records/deal` is gated at `member`, so an `analyst` and a
 * `readonly` seat can read the whole board and write none of it. The screen
 * used to offer all of it anyway — New deal, a draggable card on every column,
 * an inline editor on every property — and the refusal arrived only after the
 * attempt, as a toast with a role name in it.
 */
describe('the deal board for a session that cannot write', () => {
  it('names the rung rather than saying "permission denied"', () => {
    assert.equal(
      readOnlyReason('readonly'),
      'You are signed in as a read-only user, and writing a deal needs the member role or higher.',
    );
    assert.equal(
      readOnlyReason('analyst'),
      'You are signed in as an analyst, and writing a deal needs the member role or higher.',
    );
    assert.match(readOnlyReason(null), /signed in as a guest/);
  });

  it('reads the kit’s ladder, so it and the server cannot disagree', () => {
    // The same helper the command palette uses to decide what to offer.
    assert.equal(canWrite('owner'), true);
    assert.equal(canWrite('admin'), true);
    assert.equal(canWrite('member'), true);
    assert.equal(canWrite('analyst'), false);
    assert.equal(canWrite('readonly'), false);
    assert.equal(canWrite(null), false);
    const source = readFileSync(new URL('../src/client/modules/pipeline/api.ts', import.meta.url), 'utf8');
    assert.match(source, /import \{ canWrite \} from '@\/client\/kernel\/shell-core'/, 'the module keeps a ladder of its own');
  });

  it('hangs every write affordance on the board off that one answer', () => {
    const source = readFileSync(new URL('../src/client/modules/pipeline/deals.tsx', import.meta.url), 'utf8');
    assert.match(source, /const writable = useCanWriteDeals\(\);/, 'the board never asks');
    // A card that lifts and snaps back on a 403 is the defect this replaces.
    assert.match(source, /draggable=\{writable\}/);
    assert.doesNotMatch(source, /^\s+draggable$/m, 'a card is still unconditionally draggable');
    assert.match(source, /\{writable && \(\n\s+<Button ref=\{newDealButton\}/, 'New deal is still offered to everyone');
    assert.match(source, /open=\{newOpen && writable\}/, '?new=1 still opens the create dialog');
    assert.match(source, /if \(!writable \|\| dealStage\(deal\) === stage\.name\) return;/, 'a move can still be requested');
  });

  it('shuts the record page’s inline editors, which are one PATCH each', () => {
    const inline = readFileSync(new URL('../src/client/modules/pipeline/inline.tsx', import.meta.url), 'utf8');
    assert.match(inline, /const writable = scope\?\.writable \?\? true;/, 'the scope carries no answer');
    assert.match(inline, /const editing = writable && /, 'a row can still open its editor');
    const record = readFileSync(new URL('../src/client/modules/pipeline/record.tsx', import.meta.url), 'utf8');
    assert.match(record, /<InlineEditingScope writable=\{writable\}>/, 'the scope is not told');
    assert.match(record, /const writable = useCanWriteDeals\(\);/, 'the record page never asks');
  });

  it('offers no saved-view write either — /v1/views is the same rung', () => {
    const views = readFileSync(new URL('../src/client/modules/pipeline/views.tsx', import.meta.url), 'utf8');
    assert.match(views, /const writable = useCanWriteDeals\(\);/);
    assert.match(views, /const manage: MenuItemDef\[\] = writable/);
  });
});
