import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ALL_PIPELINES, DAY_MS, HORIZON_LABEL, HORIZONS, SIX_WEEK_DAYS, describeBoardState, matchesHorizon,
  horizonWindow, quarterEnd, quarterStart, sameBoardState, stageKey, stateToView, viewToState,
  type BoardState, type FilterCondition,
} from '../src/client/modules/pipeline/board-core';
import { splitToolEcho, parseBlocks, confidenceBand } from '../src/client/modules/copilot/answer-core';

const TODAY = Date.UTC(2026, 8, 2);

const board = (over: Partial<BoardState> = {}): BoardState =>
  ({ pipeline: ALL_PIPELINES, owner: '', forecast: '', horizon: 'all', sort: 'amount', closed: true, ...over });

/* ---------------------------- close-date windows -------------------------- */

describe('the six-week commit window', () => {
  it('is a real horizon the board can be filtered to', () => {
    assert.equal(HORIZON_LABEL['42'], 'Closing within six weeks');
    assert.deepEqual(HORIZONS, ['all', 'overdue', '30', '42', 'quarter']);
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
    for (const horizon of HORIZONS) {
      const stored = stateToView(board({ horizon }));
      const { state, readable } = viewToState({ filter: stored.filter, sort: stored.sort });
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
