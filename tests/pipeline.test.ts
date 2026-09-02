import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ALL_PIPELINES, DAY_MS, HORIZON_LABEL, HORIZONS, SIX_WEEK_DAYS, describeBoardState, matchesHorizon,
  horizonWindow, quarterEnd, quarterStart, sameBoardState, stageKey, stateToView, viewToState,
  type BoardState, type FilterCondition,
} from '../src/client/modules/pipeline/board-core';
import { splitToolEcho, parseBlocks, confidenceBand, refusalOf } from '../src/client/modules/copilot/answer-core';
import {
  boardHref, boundScopeOf, currencyOfFigure, groupAsked, metricAsked, namedQualifiers, parseBreakdown,
  reconcileBreakdown, reconcileScope, scopeChips, unknownMeasure, withoutBreakdown,
  type Measurement, type QualifierVerdict, type VocabStage, type Vocabulary,
} from '../src/client/modules/copilot/scope-core';
import { citationHref } from '../src/client/modules/copilot/citations';

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
  it('reads the pipeline out of a question and finds nothing bound to it', () => {
    const report = reconcileScope({
      question: 'What is the Renewal pipeline worth?',
      prose: 'Northwind Robotics is carrying $9,010,960 in open pipeline, from 38 open deals.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', ...Q3, group_by: 'none', compare: true } }],
      reasoning: ['Ran business_metric in 2ms → $9,010,960 (38 open deals).'],
      vocab: VOCAB,
    });
    assert.equal(report.answering.length, 1);
    assert.equal(report.answering[0].figure, '$9,010,960');
    const pipeline = report.unscoped.find((v) => v.kind === 'pipeline');
    assert.ok(pipeline, 'the Renewal qualifier was not reported as unbound');
    assert.equal(pipeline.state, 'unbound');
    assert.equal(pipeline.asked, 'Renewal');
    assert.equal(pipeline.used, 'every pipeline');
  });

  it('says nothing when the same question was answered for that pipeline', () => {
    const report = reconcileScope({
      question: 'What is the Renewal pipeline worth?',
      prose: 'The Renewal pipeline is carrying $1,463,440, from 9 open deals.',
      toolCalls: [{
        name: 'record_aggregate',
        arguments: {
          object_type: 'deal', measure: 'sum', property: 'amount',
          conditions: [{ property: 'pipeline', op: 'eq', value: 'renewal' }],
        },
      }],
      reasoning: ['Ran record_aggregate in 2ms → $1,463,440 (9 open deals).'],
      vocab: VOCAB,
    });
    assert.deepEqual(report.unscoped, []);
    assert.equal(report.verdicts.find((v) => v.kind === 'pipeline')?.state, 'bound');
  });

  it('calls a stage question answered over every stage what it is', () => {
    const report = reconcileScope({
      question: 'How many deals are in Negotiation?',
      prose: 'Northwind Robotics has 38 open deals right now.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'deal_count', ...Q3, group_by: 'none' } }],
      reasoning: ['Ran business_metric in 1ms → 38 (38 open deals).'],
      vocab: VOCAB,
    });
    const stage = report.unscoped.find((v) => v.kind === 'stage');
    assert.equal(stage?.state, 'unbound');
    assert.equal(stage?.asked, 'Negotiation');
  });

  it('reports an owner question answered for a company as a substitution', () => {
    const report = reconcileScope({
      question: 'How much pipeline does Marcus Ilori own?',
      prose: 'Whitcombe Aerospace is carrying $315,900 in open pipeline, from 1 open deal.',
      toolCalls: [
        { name: 'record_aggregate', arguments: { object_type: 'deal', measure: 'sum', property: 'amount', owner_id: 'usr_seed02' } },
        { name: 'account_profile', arguments: { id: 'con_nw_096' } },
        { name: 'business_metric', arguments: { metric: 'pipeline', ...Q3, subject_id: 'cmp_nw_29' } },
      ],
      reasoning: [
        'Ran record_aggregate in 2ms → $1,878,120 ().',
        'Ran account_profile in 4ms → Whitcombe Aerospace.',
        'Ran business_metric in 13ms → $315,900 (1 open deal).',
      ],
      vocab: VOCAB,
      resolveId: (id) => (id === 'cmp_nw_29' ? 'Whitcombe Aerospace' : null),
    });
    // Three steps ran; only the third one's figure is in the answer, so only
    // that one's scope is the scope a reader is looking at.
    assert.deepEqual(report.answering.map((m) => m.tool), ['business_metric']);
    const owner = report.unscoped.find((v) => v.kind === 'owner');
    assert.equal(owner?.state, 'substituted');
    assert.equal(owner?.used, 'Whitcombe Aerospace');
  });

  it('catches the metric itself being swapped for a different one', () => {
    const report = reconcileScope({
      question: 'What is our weighted pipeline?',
      prose: 'Northwind Robotics is carrying $9,010,960 in open pipeline, from 38 open deals.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', ...Q3 } }],
      reasoning: ['Ran business_metric in 2ms → $9,010,960 (38 open deals).'],
      vocab: VOCAB,
    });
    const metric = report.unscoped.find((v) => v.kind === 'metric');
    assert.equal(metric?.state, 'substituted');
    assert.equal(metric?.asked, 'Weighted pipeline');
    assert.equal(metric?.used, 'Open pipeline');
  });

  it('does not invent a status warning for a metric that already carries one', () => {
    const report = reconcileScope({
      question: 'Break the open pipeline down by stage',
      prose: 'Northwind Robotics is carrying $9,010,960 in open pipeline, from 38 open deals.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', ...Q3, group_by: 'stage' } }],
      reasoning: ['Ran business_metric in 2ms → $9,010,960 (38 open deals).'],
      vocab: VOCAB,
    });
    // "Open pipeline" *is* the open-deal measure; warning that the answer was
    // not narrowed to open deals would be a warning about nothing.
    assert.deepEqual(report.unscoped, []);
  });

  it('reads the stage argument the metric tool now takes, not only a condition', () => {
    // The engine grew a plain `stage` argument on `business_metric`. Reading
    // only `conditions` would have gone on warning that a correctly narrowed
    // answer was unscoped, which is the same crime in the other direction.
    const report = reconcileScope({
      question: 'How many deals are in Negotiation?',
      prose: 'Northwind Robotics has 7 deals right now at the Negotiation stage.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'deal_count', ...Q3, stage: 'negotiation' } }],
      reasoning: ['Ran business_metric in 1ms → 7 (7 open deals).'],
      vocab: VOCAB,
    });
    assert.deepEqual(report.unscoped, []);
    assert.equal(report.answering[0].scope.stages[0], 'negotiation');
  });

  it('treats a filter naming only lost stages as the lost status it is', () => {
    const report = reconcileScope({
      question: 'Which deals did we lose in Q2 2026?',
      prose: '2 closed-lost deals closed in Q2 2026. The largest:',
      toolCalls: [{
        name: 'record_search',
        arguments: {
          object_type: 'deal',
          conditions: [{ property: 'deal_stage', op: 'in', values: ['closed_lost'] }],
          date_property: 'close_date', start: 1775001600000, end: 1782864000000,
        },
      }],
      reasoning: ['Ran record_search in 3ms → 2 records (2 closed-lost deals).'],
      vocab: VOCAB,
    });
    assert.deepEqual(report.unscoped, []);
    assert.equal(report.answering[0].scope.status, 'lost');
    // …and it is still a stage filter, so a question naming Closed lost is
    // honoured too rather than being reported as unbound.
    assert.deepEqual(report.answering[0].scope.stages, ['closed_lost']);
  });

  it('does not caption a snapshot metric with a period it ignored', () => {
    // `business_metric` is handed a window for every call. Open pipeline is a
    // snapshot and ignores it — the engine's own answer says so in its second
    // sentence — so a question that names a period was not answered over it.
    const report = reconcileScope({
      question: 'What was our open pipeline in August 2026?',
      prose: 'Northwind Robotics is carrying $9,010,960 in open pipeline, from 38 open deals.\n\n'
        + 'Open pipeline is a snapshot of every deal not yet closed, so it ignores the reporting period.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', ...Q3 } }],
      reasoning: ['Ran business_metric in 2ms → $9,010,960 (38 open deals).'],
      vocab: VOCAB,
    });
    const period = report.unscoped.find((v) => v.kind === 'period');
    assert.equal(period?.state, 'unbound');
    assert.equal(period?.used, 'as of now');
    // And the period reads back the way a person wrote it, not the way the
    // matcher lower-cased it to find it.
    assert.equal(period?.asked, 'August 2026');
  });

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

  it('takes the engine at its word when the query backs the word up', () => {
    // The engine now writes its own qualifier ledger. Where it says a qualifier
    // was bound and the query it names really carries it, that is the end of it
    // — no warning, and the scope row shows the narrowing.
    const report = reconcileScope({
      question: 'How much pipeline does Marcus Ilori own in the Renewal pipeline?',
      prose: '$453,220 is the sum of amount across 2 open deals pipeline Renewal, owned by Marcus Ilori.',
      toolCalls: [{
        name: 'record_aggregate',
        arguments: {
          object_type: 'deal', measure: 'sum', property: 'amount', owner_id: 'usr_seed02',
          conditions: [{ property: 'pipeline', op: 'eq', value: 'renewal' }],
        },
      }],
      reasoning: [
        'Qualifier ledger settled: metric "pipeline" bound → record_aggregate; pipeline "Renewal" bound → record_aggregate; owner "Marcus Ilori" bound → record_aggregate.',
        'Ran record_aggregate in 2ms → $453,220 (2 open deals).',
      ],
      vocab: VOCAB,
    });
    assert.deepEqual(report.unscoped, []);
  });

  it('does not take the engine at its word when the query does not back it up', () => {
    // "bound" written over a query with no such filter is the defect itself,
    // stated by the engine rather than hidden by it. The arguments win.
    const report = reconcileScope({
      question: 'What is the Renewal pipeline worth?',
      prose: 'Northwind Robotics is carrying $9,010,960 in open pipeline, from 38 open deals.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', ...Q3 } }],
      reasoning: [
        'Qualifier ledger settled: metric "pipeline" bound → business_metric; pipeline "Renewal" bound → business_metric.',
        'Ran business_metric in 2ms → $9,010,960 (38 open deals).',
      ],
      vocab: VOCAB,
    });
    const pipeline = report.unscoped.find((v) => v.kind === 'pipeline');
    assert.equal(pipeline?.state, 'unbound');
    assert.equal(pipeline?.used, 'every pipeline');
  });

  it('reports a qualifier the engine says it waived, in the engine’s own word', () => {
    const report = reconcileScope({
      question: 'What was our open pipeline in August 2026?',
      prose: 'Northwind Robotics is carrying $9,010,960 in open pipeline, from 38 open deals.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', ...Q3 } }],
      reasoning: [
        'Qualifier ledger settled: metric "open pipeline" bound → business_metric; period "in August 2026" waived.',
        'Ran business_metric in 2ms → $9,010,960 (38 open deals).',
      ],
      vocab: VOCAB,
    });
    const period = report.unscoped.find((v) => v.kind === 'period');
    assert.equal(period?.state, 'waived');
  });

  it('says nothing at all about a run that measured nothing', () => {
    // A refusal has its own banner. Putting a scope warning over an answer with
    // no figure in it would be a warning about a number nobody was given.
    const report = reconcileScope({
      question: 'How much has Priya Raman closed this year?',
      prose: 'I could not tell which measure you want, so I have not guessed one.',
      toolCalls: [],
      reasoning: ['Qualifier ledger settled: owner "Priya Raman" waived; period "this year" waived.'],
      vocab: VOCAB,
    });
    assert.deepEqual(report.verdicts, []);
    assert.deepEqual(report.unscoped, []);
  });

  it('leaves a question naming nothing this workspace knows entirely alone', () => {
    const report = reconcileScope({
      question: 'How is business?',
      prose: 'Northwind Robotics is carrying $9,010,960 in open pipeline.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', ...Q3 } }],
      reasoning: ['Ran business_metric in 2ms → $9,010,960 (38 open deals).'],
      vocab: VOCAB,
    });
    assert.deepEqual(report.unscoped, []);
  });

  it('does not read a pipeline out of a question that is not about one', () => {
    // "Support" is a pipeline here. A question about support tickets is not a
    // claim about it, and a false warning is a warning nobody reads.
    const withSupport: Vocabulary = {
      ...VOCAB,
      pipelines: [...VOCAB.pipelines, { name: 'support', label: 'Support', stages: [] }],
    };
    assert.deepEqual(
      namedQualifiers('How many support tickets came in?', withSupport).filter((q) => q.kind === 'pipeline'),
      [],
    );
    assert.equal(
      namedQualifiers('What is the Support pipeline worth?', withSupport).some((q) => q.kind === 'pipeline'),
      true,
    );
  });
});

describe('a by-stage breakdown against the board’s own columns', () => {
  const BUCKETS = [
    { label: 'Proposal', figure: '$2,094,180' },
    { label: 'Qualification', figure: '$2,073,500' },
    { label: 'Negotiation', figure: '$1,596,340' },
    { label: 'Discovery', figure: '$1,264,560' },
    { label: 'Technical validation', figure: '$684,540' },
    { label: 'Commercial terms', figure: '$679,940' },
    { label: 'Renewal outreach', figure: '$396,980' },
    { label: 'Usage review', figure: '$220,920' },
  ];

  it('lifts the breakdown sentence out of the prose', () => {
    const prose = 'Northwind Robotics is carrying $9,010,960 in open pipeline.\n\n'
      + 'Breakdown: Proposal $2,094,180 · Qualification $2,073,500 · Usage review $220,920.';
    const parsed = parseBreakdown(prose);
    assert.ok(parsed);
    assert.deepEqual(parsed.buckets, [
      { label: 'Proposal', figure: '$2,094,180' },
      { label: 'Qualification', figure: '$2,073,500' },
      { label: 'Usage review', figure: '$220,920' },
    ]);
    assert.equal(withoutBreakdown(prose), 'Northwind Robotics is carrying $9,010,960 in open pipeline.');
  });

  it('refuses eight buckets over thirteen columns, and says which are which', () => {
    const report = reconcileBreakdown(BUCKETS, VOCAB, null);
    assert.equal(report.reconciles, false);
    assert.equal(report.columnsOnBoard, 13);
    assert.equal(report.buckets.length, 8);

    const by = (label: string) => report.buckets.find((b) => b.bucket.label === label)!;
    // One figure over two pipelines' columns, captioned with neither's label.
    assert.equal(by('Proposal').merged, true);
    assert.equal(by('Proposal').mislabelled, true);
    // Captioned with New business's label over a sum that includes Expansion's
    // "Expansion identified".
    assert.equal(by('Qualification').merged, true);
    assert.deepEqual(by('Qualification').stages.map((s) => s.label), ['Qualification', 'Expansion identified']);
    // Three pipelines, one caption, and this one at least uses a real label.
    assert.equal(by('Negotiation').stages.length, 3);
    assert.equal(by('Negotiation').mislabelled, false);
    // One column, but the board calls it "Usage & value review".
    assert.equal(by('Usage review').merged, false);
    assert.equal(by('Usage review').mislabelled, true);
    // And the ones that are genuinely one column of one pipeline are left alone.
    assert.equal(by('Commercial terms').merged, false);
    assert.equal(by('Commercial terms').mislabelled, false);
  });

  it('accepts a breakdown that does match one pipeline’s columns', () => {
    const report = reconcileBreakdown([
      { label: 'Renewal outreach', figure: '$396,980' },
      { label: 'Usage & value review', figure: '$220,920' },
      { label: 'Commercial terms', figure: '$679,940' },
      { label: 'Negotiation', figure: '$165,600' },
    ], VOCAB, 'renewal');
    assert.equal(report.reconciles, true);
    assert.equal(report.columnsOnBoard, 4);
  });

  it('names a bucket that is not a column at all', () => {
    const report = reconcileBreakdown([{ label: 'Handshake', figure: '$1' }], VOCAB, 'renewal');
    assert.equal(report.buckets[0].unknown, true);
    assert.equal(report.reconciles, false);
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
    assert.equal(citationHref({ id: 'in_1', label: 'An invoice', type: 'invoice' }), '/invoices/in_1');
    assert.equal(citationHref({ id: 'prc_1', label: 'A price', type: 'price' }), null);
  });
});

/* ============ qualifiers the surface used to vouch for without checking ===== */

/**
 * The catalogue with the two measures that make the "unknown compound" rule
 * worth having: `win_rate` puts the word "rate" into the catalogue's own
 * vocabulary, so "churn rate" is still the churn metric, while nothing anywhere
 * says "velocity", so "pipeline velocity" is a measure this workspace does not
 * define and must not be answered with open pipeline.
 */
const CATALOGUE: Vocabulary = {
  ...VOCAB,
  metrics: [
    ...VOCAB.metrics,
    { id: 'win_rate', label: 'Win rate', unit: 'percent', keywords: ['win rate'], snapshot: false },
    { id: 'churn', label: 'Logo churn', unit: 'percent', keywords: ['churn', 'attrition'], snapshot: false },
  ],
};

const OPEN_STAGE_NAMES = [...new Set(
  VOCAB.pipelines.flatMap((p) => p.stages.filter((s) => !s.isClosed).map((s) => s.name)),
)];

describe('the book an answer was measured in', () => {
  it('reads a workspace total printed in dollars as not being the EUR book', () => {
    // Hand-checked against the seed: no deal row carries a currency at all, so
    // "in EUR" cannot narrow a deal figure — and the engine returns the same
    // $ figure it returns with no currency named. The chip said EUR anyway.
    const report = reconcileScope({
      question: 'What is our open pipeline in EUR?',
      prose: 'Northwind Robotics is carrying $9,148,979 in open pipeline, from 40 open deals.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', ...Q3, currency: 'eur' } }],
      reasoning: [
        'Qualifier ledger settled: metric "pipeline" bound → business_metric; currency "eur" bound → business_metric.',
        'Ran business_metric in 2ms → $9,148,979 (40 open deals).',
      ],
      vocab: VOCAB,
    });
    const book = report.unscoped.find((v) => v.kind === 'currency');
    assert.ok(book, 'the EUR the question named was not reported at all');
    assert.equal(book.state, 'substituted');
    assert.equal(book.asked, 'EUR');
    assert.equal(book.used, 'USD');
  });

  it('does not accept the engine’s own “bound” over a figure that disagrees with it', () => {
    // `currency: "eur"` really is in the arguments and the ledger really does
    // say bound. An argument that changed nothing is not a binding.
    const report = reconcileScope({
      question: 'What are our closed-won bookings in GBP?',
      prose: 'Northwind Robotics booked $317,400 in closed-won bookings.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'closed_won', ...Q3, currency: 'gbp' } }],
      reasoning: [
        'Qualifier ledger settled: currency "gbp" bound → business_metric.',
        'Ran business_metric in 2ms → $317,400 (12 closed-won deals).',
      ],
      vocab: {
        ...VOCAB,
        metrics: [...VOCAB.metrics, { id: 'closed_won', label: 'Closed-won bookings', unit: 'money', keywords: ['closed won', 'bookings', 'won'], snapshot: false }],
      },
    });
    assert.equal(report.unscoped.find((v) => v.kind === 'currency')?.state, 'substituted');
  });

  it('calls a figure that adds three books together what it is', () => {
    const report = reconcileScope({
      question: 'What did we invoice in EUR in August 2026?',
      prose: 'Northwind Robotics invoiced $27,839.34, €3,005 and £2,285 in August 2026, from 30 issued invoices.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'invoiced', start: 1785542400000, end: 1788220800000, window_label: 'August 2026' } }],
      reasoning: ['Ran business_metric in 2ms → $27,839.34, €3,005 and £2,285 (30 issued invoices).'],
      vocab: VOCAB,
    });
    const book = report.unscoped.find((v) => v.kind === 'currency');
    assert.equal(book?.state, 'substituted');
    assert.equal(book?.used, 'USD, EUR, GBP together');
  });

  it('says nothing when the figure is printed in the book that was asked for', () => {
    const report = reconcileScope({
      question: 'What did we invoice in EUR in 2026?',
      prose: 'Northwind Robotics invoiced €1,007.00 in 2026.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'invoiced', start: 1767225600000, end: 1790812800000, window_label: '2026', currency: 'eur' } }],
      reasoning: ['Ran business_metric in 2ms → €1,007.00 (3 invoices).'],
      vocab: VOCAB,
    });
    assert.deepEqual(report.unscoped, []);
  });

  it('reads the book out of a code, a word and a lone symbol, and not out of a threshold', () => {
    const book = (question: string) => namedQualifiers(question, VOCAB).find((q) => q.kind === 'currency')?.value ?? null;
    assert.equal(book('What is our open pipeline in EUR?'), 'eur');
    assert.equal(book('How much have we invoiced in euros?'), 'eur');
    assert.equal(book('What is outstanding in £?'), 'gbp');
    // A number in the question is a threshold, not a ledger.
    assert.equal(book('How many deals are over $100,000?'), null);
    assert.equal(currencyOfFigure('$9,148,979'), 'usd');
    assert.equal(currencyOfFigure('€1,007.00'), 'eur');
    assert.equal(currencyOfFigure('40'), null);
  });

  it('never states a book on the scope bar that the reconciliation did not confirm', () => {
    const measurement: Measurement = {
      tool: 'business_metric',
      args: { metric: 'pipeline', currency: 'eur' },
      figure: '$9,148,979',
      scope: boundScopeOf({ name: 'business_metric', arguments: { metric: 'pipeline', currency: 'eur' } }, VOCAB),
    };
    const options = { window: () => 'Q3 2026', name: (id: string) => id };

    // Nobody asked for a book: the chip is drawn, and marked as unchecked
    // rather than stated the way a confirmed narrowing is.
    const unasked = scopeChips(measurement, VOCAB, [], options).find((c) => c.kind === 'currency');
    assert.equal(unasked?.value, 'EUR');
    assert.equal(unasked?.unchecked, true);

    // Contradicted: the chip says what the figure was really printed in, in the
    // same red as every other substituted dimension.
    const contradicted: QualifierVerdict[] = [{ kind: 'currency', asked: 'EUR', state: 'substituted', used: 'USD', tool: 'business_metric' }];
    const chip = scopeChips(measurement, VOCAB, contradicted, options).find((c) => c.kind === 'currency');
    assert.equal(chip?.value, 'USD');
    assert.equal(chip?.wide, true);
    assert.equal(chip?.unchecked, undefined);

    // Confirmed: stated plainly, no hedge.
    const confirmed: QualifierVerdict[] = [{ kind: 'currency', asked: 'EUR', state: 'bound', used: 'EUR', tool: 'business_metric' }];
    const settled = scopeChips(measurement, VOCAB, confirmed, options).find((c) => c.kind === 'currency');
    assert.equal(settled?.value, 'EUR');
    assert.equal(settled?.unchecked, undefined);
    assert.equal(settled?.wide, false);
  });

  it('surfaces an account, a unit and a meter the engine says it waived', () => {
    // All four of these kinds were filtered out of the ledger before the loop
    // that reports waived qualifiers could see them — while the scope bar went
    // on drawing an ACCOUNT chip.
    const report = reconcileScope({
      question: 'How many events did Pemberton send last month?',
      prose: 'Northwind Robotics recorded 9,131 events.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'events', ...Q3 } }],
      reasoning: [
        'Qualifier ledger settled: account "Pemberton" waived; unit "event" refused; meter "telemetry" waived.',
        'Ran business_metric in 2ms → 9,131 (9,131 events).',
      ],
      vocab: VOCAB,
    });
    assert.deepEqual(
      report.unscoped.filter((v) => ['account', 'unit', 'meter'].includes(v.kind)).map((v) => [v.kind, v.state, v.asked]),
      [['account', 'waived', 'Pemberton'], ['unit', 'waived', 'event'], ['meter', 'waived', 'telemetry']],
    );
  });
});

describe('a measure this workspace does not define', () => {
  it('does not let pipeline velocity be answered with open pipeline in silence', () => {
    const report = reconcileScope({
      question: 'What is our pipeline velocity?',
      prose: 'Northwind Robotics is carrying $9,010,960 in open pipeline, from 38 open deals.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', ...Q3 } }],
      reasoning: ['Ran business_metric in 2ms → $9,010,960 (38 open deals).'],
      vocab: CATALOGUE,
    });
    const measure = report.unscoped.find((v) => v.kind === 'metric');
    assert.ok(measure, 'velocity was answered with open pipeline and nothing said so');
    assert.equal(measure.state, 'substituted');
    assert.equal(measure.asked, 'Pipeline velocity');
    assert.equal(measure.used, 'Open pipeline');
  });

  it('measures an unknown compound against the catalogue’s own words, not a guess', () => {
    assert.equal(unknownMeasure('What is our pipeline velocity?', CATALOGUE), 'pipeline velocity');
    assert.equal(unknownMeasure('What is our pipeline coverage?', CATALOGUE), 'pipeline coverage');
    // "rate" is a word this catalogue uses, so "churn rate" is still churn.
    assert.equal(unknownMeasure('What is our churn rate?', CATALOGUE), null);
    // Filler either side of a metric word leaves the metric alone.
    assert.equal(unknownMeasure('How much pipeline does Marcus Ilori own?', CATALOGUE), null);
    assert.equal(unknownMeasure('What is our open pipeline?', CATALOGUE), null);
    assert.equal(unknownMeasure('Show me open pipeline by stage', CATALOGUE), null);
    assert.equal(metricAsked('What is our weighted pipeline?', CATALOGUE)?.metric.id, 'weighted_pipeline');
  });
});

describe('the banner that used to cry wolf', () => {
  it('does not accuse a deal count in a named pipeline of measuring open pipeline', () => {
    // Hand-checked on the seed: 5 deals sit at Proposal sent in Expansion. The
    // answer was right, and carried the loudest banner in the design system,
    // because "pipeline" was spent twice — once on the pipeline, once on the
    // metric catalogue.
    const report = reconcileScope({
      question: 'How many deals are in the Proposal sent stage of the Expansion pipeline?',
      prose: 'The Expansion pipeline has 5 deals at Proposal sent.',
      toolCalls: [{
        name: 'business_metric',
        arguments: { metric: 'deal_count', ...Q3, pipeline: 'expansion', stage: 'proposal' },
      }],
      reasoning: ['Ran business_metric in 1ms → 5 (5 open deals).'],
      vocab: VOCAB,
    });
    assert.deepEqual(report.unscoped, []);
    assert.equal(report.verdicts.find((v) => v.kind === 'metric')?.asked, 'Deals');
  });

  it('still catches the same question answered over every pipeline', () => {
    const report = reconcileScope({
      question: 'How many deals are in the Proposal sent stage of the Expansion pipeline?',
      prose: 'Northwind Robotics has 39 open deals right now.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'deal_count', ...Q3, group_by: 'none' } }],
      reasoning: ['Ran business_metric in 1ms → 39 (39 open deals).'],
      vocab: VOCAB,
    });
    assert.equal(report.unscoped.find((v) => v.kind === 'pipeline')?.state, 'unbound');
    assert.equal(report.unscoped.find((v) => v.kind === 'stage')?.state, 'unbound');
    // …and still not with a fourth sentence about a measure nobody asked for.
    assert.equal(report.unscoped.find((v) => v.kind === 'metric'), undefined);
  });

  it('does not name a teammate the question never mentioned', () => {
    // Marcus Brennan is a contact at Wexler; Marcus Ilori is a teammate. The
    // answer was correct and was topped with "You asked about Marcus Ilori".
    const report = reconcileScope({
      question: 'What is the open pipeline for Marcus Brennan?',
      prose: 'Marcus Brennan is carrying $308,880 in open pipeline, from 2 open deals.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', ...Q3, subject_id: 'con_nw_058' } }],
      reasoning: ['Ran business_metric in 13ms → $308,880 (2 open deals).'],
      vocab: VOCAB,
      resolveId: (id) => (id === 'con_nw_058' ? 'Marcus Brennan' : null),
    });
    assert.deepEqual(report.unscoped, []);
    assert.equal(namedQualifiers('What is the open pipeline for Marcus Brennan?', VOCAB).some((q) => q.kind === 'owner'), false);
  });

  it('still reads the teammate out of a bare first name when nothing follows it', () => {
    const owner = (q: string) => namedQualifiers(q, VOCAB).find((v) => v.kind === 'owner')?.label ?? null;
    assert.equal(owner('How much pipeline does Marcus own?'), 'Marcus Ilori');
    assert.equal(owner('What has Marcus closed this year?'), 'Marcus Ilori');
    assert.equal(owner('How much pipeline does Marcus Ilori own?'), 'Marcus Ilori');
    assert.equal(owner('What is the open pipeline for Marcus Vandermeer?'), null);
  });
});

describe('what kind of record the figure counted', () => {
  it('says the answer counts tickets when a deal question was answered with tickets', () => {
    const report = reconcileScope({
      question: 'Break down open pipeline by pipeline',
      prose: '7 open tickets:\n\n• Dashboard loads slowly with 900 assets selected — New · Medium priority · Sofia Alvarez',
      toolCalls: [{
        name: 'record_search',
        arguments: {
          object_type: 'ticket',
          conditions: [{ property: 'status', op: 'in', values: ['new', 'waiting_on_us', 'waiting_on_customer', 'escalated'] }],
          limit: 10,
        },
      }],
      reasoning: ['Ran record_search in 1ms → 7 records.'],
      vocab: VOCAB,
    });
    const object = report.unscoped.find((v) => v.kind === 'object');
    assert.ok(object, 'nothing on the answer said it was about tickets rather than deals');
    assert.equal(object.state, 'substituted');
    assert.equal(object.used, 'tickets');
    // And the three sentences about deal filters on records that are not deals
    // are gone: they were the banner blaming the wrong dimension entirely.
    assert.deepEqual(report.unscoped.filter((v) => ['pipeline', 'stage', 'status'].includes(v.kind)), []);
    // The scope row says it too, in the same red as every other dimension the
    // answer disagreed with.
    const chips = scopeChips(report.answering[0], VOCAB, report.verdicts, { window: () => 'now', name: (id) => id });
    const records = chips.find((c) => c.kind === 'object');
    assert.equal(records?.value, 'Ticket');
    assert.equal(records?.wide, true);
  });

  it('names the record type the way a person writes it', () => {
    const report = reconcileScope({
      question: 'Which companies have open deals?',
      prose: '12 companies match.',
      toolCalls: [{ name: 'record_search', arguments: { object_type: 'company', limit: 10 } }],
      reasoning: ['Ran record_search in 1ms → 12 records.'],
      vocab: VOCAB,
    });
    assert.equal(report.unscoped.find((v) => v.kind === 'object')?.used, 'companies');
  });

  it('does not call an ordinary search for records a measure the catalogue lacks', () => {
    // "Show me deals closing this month" is a search. Reading "deals closing"
    // as a measure nobody defines put a red banner over a correct list.
    const report = reconcileScope({
      question: 'Show me deals closing this month',
      prose: '14 deals close in Sep 2026. The 8 largest of them:',
      toolCalls: [{
        name: 'record_search',
        arguments: { object_type: 'deal', date_property: 'close_date', start: 1788220800000, end: 1790812800000, limit: 10 },
      }],
      reasoning: ['Ran record_search in 1ms → 10 records.'],
      vocab: VOCAB,
    });
    assert.deepEqual(report.unscoped, []);
  });

  it('leaves a deal answer alone', () => {
    const report = reconcileScope({
      question: 'Which deals did we lose in Q2 2026?',
      prose: '2 closed-lost deals closed in Q2 2026.',
      toolCalls: [{
        name: 'record_search',
        arguments: {
          object_type: 'deal',
          conditions: [{ property: 'deal_stage', op: 'in', values: ['closed_lost'] }],
          date_property: 'close_date', start: 1775001600000, end: 1782864000000,
        },
      }],
      reasoning: ['Ran record_search in 3ms → 2 records (2 closed-lost deals).'],
      vocab: VOCAB,
    });
    assert.equal(report.unscoped.find((v) => v.kind === 'object'), undefined);
  });
});

describe('a question that asks for a ranking', () => {
  it('says so when nothing was grouped by the dimension the question named', () => {
    // "Which pipeline has the most open deals?" comes back as the eight largest
    // deals in the workspace, sorted by amount, ranking nothing.
    const report = reconcileScope({
      question: 'Which pipeline has the most open deals?',
      prose: '39 deals match. The 8 largest of them:',
      toolCalls: [{
        name: 'record_search',
        arguments: {
          object_type: 'deal',
          conditions: [{ property: 'deal_stage', op: 'in', values: OPEN_STAGE_NAMES }],
          order_by: 'amount', limit: 10,
        },
      }],
      reasoning: ['Ran record_search in 1ms → 10 records.'],
      vocab: VOCAB,
    });
    const group = report.unscoped.find((v) => v.kind === 'group');
    assert.ok(group, 'a ranking question came back unranked with no warning');
    assert.equal(group.state, 'unbound');
    assert.equal(group.asked, 'pipeline');
    assert.equal(group.used, 'one total, not broken down');
  });

  it('stays quiet on the breakdown the engine does support', () => {
    const report = reconcileScope({
      question: 'Show me open pipeline by stage',
      prose: 'Northwind Robotics is carrying $9,010,960 in open pipeline, from 38 open deals.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', ...Q3, group_by: 'stage' } }],
      reasoning: ['Ran business_metric in 2ms → $9,010,960 (38 open deals).'],
      vocab: VOCAB,
    });
    assert.deepEqual(report.unscoped, []);
    assert.equal(report.verdicts.find((v) => v.kind === 'group')?.state, 'bound');
  });

  it('reads the dimension out of both shapes a person writes it in', () => {
    assert.equal(groupAsked('break down open pipeline by pipeline')?.value, 'pipeline');
    assert.equal(groupAsked('which pipeline has the most open deals')?.value, 'pipeline');
    assert.equal(groupAsked('which rep has the most open pipeline')?.value, 'owner');
    assert.equal(groupAsked('open pipeline by owner')?.value, 'owner');
    // Not every "which" is a ranking, and not every question is a breakdown.
    assert.equal(groupAsked('which deals did we lose in q2 2026'), null);
    assert.equal(groupAsked('what is the renewal pipeline worth'), null);
    // "per customer" is a ratio, not a breakdown, and reading it as one put a
    // warning over a correct revenue total.
    assert.equal(groupAsked('what is our revenue per customer'), null);
  });
});

describe('a breakdown that is not about stages at all', () => {
  it('is not held against the board’s columns', () => {
    // `Breakdown: Onboarding 2 · Data gap 2 · Integration 1` is the open-ticket
    // metric grouped by category. Measuring it against the deal board produced
    // "Onboarding is not a column on this board at all" over a correct answer.
    const report = reconcileBreakdown(
      [{ label: 'Onboarding', figure: '2' }, { label: 'Data gap', figure: '2' }, { label: 'Integration', figure: '1' }],
      VOCAB,
      null,
    );
    assert.equal(report.aboutStages, false);
  });

  it('leaves a real by-stage breakdown to be checked', () => {
    const report = reconcileBreakdown(
      [{ label: 'Negotiation', figure: '$1,596,340' }, { label: 'Usage review', figure: '$220,920' }],
      VOCAB,
      null,
    );
    assert.equal(report.aboutStages, true);
    assert.equal(report.reconciles, false);
  });
});

describe('the way out of a refusal', () => {
  it('points at the board narrowed to what the question named', () => {
    assert.deepEqual(
      boardHref('How long does a deal spend in Negotiation in the Renewal pipeline?', VOCAB),
      { href: '/deals?pipeline=renewal', label: 'Renewal' },
    );
    assert.deepEqual(
      boardHref('What is our win rate for Marcus Ilori in 2026?', VOCAB),
      { href: '/deals?owner=usr_seed02', label: 'Marcus Ilori' },
    );
    assert.deepEqual(
      boardHref('What is Marcus Ilori carrying in the Expansion pipeline?', VOCAB),
      { href: '/deals?pipeline=expansion&owner=usr_seed02', label: 'Expansion · Marcus Ilori' },
    );
    // Nothing to narrow to is no link, rather than a link to the whole board
    // dressed up as an answer.
    assert.equal(boardHref('What is our pipeline velocity?', VOCAB), null);
  });
});

describe('a refusal the engine only reached after running something', () => {
  it('is still read as a refusal', () => {
    // The engine writes both shapes. Only the first was read, so every refusal
    // that needed a tool's own error to decide — time in stage, win rate per
    // owner — rendered with no refusal banner and no way out of the dead end.
    assert.deepEqual(
      refusalOf({ reasoning: ['Refused (period_unresolved): I could not read a period out of “lately”.'] }),
      { code: 'period_unresolved', message: 'I could not read a period out of “lately”.' },
    );
    assert.deepEqual(
      refusalOf({
        reasoning: [
          'Ran business_metric in 0ms → {"error":"“Customer spend” is not measured from deals"}.',
          'Refused after the run (qualifier_unbound): 3 qualifiers could not be bound: metric "spend", pipeline "Renewal", stage "Negotiation".',
        ],
      }),
      {
        code: 'qualifier_unbound',
        message: '3 qualifiers could not be bound: metric "spend", pipeline "Renewal", stage "Negotiation".',
      },
    );
    assert.equal(refusalOf({ reasoning: ['Ran business_metric in 2ms → $9,010,960 (38 open deals).'] }), null);
  });
});
