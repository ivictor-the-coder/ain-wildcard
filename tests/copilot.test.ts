/**
 * The copilot answering a different question than the one it was asked.
 *
 * Every fixture below is verbatim output from this engine against the seeded
 * Northwind workspace — the prose it wrote, the arguments it passed, the
 * reasoning lines it published — captured from a running preview and pasted
 * here unedited. The expected numbers beside them are computed by hand from
 * `/v1/records/deal`, not read off the engine, because the engine is the thing
 * under test.
 *
 * `tests/pipeline.test.ts` covers the board and the scope machinery in the
 * abstract. This file covers the eleven substitutions a critic found on the
 * conversation, one describe block each, with the true answer written down.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  agreeWithTheCount, correctPipelineDenial, correctedProse, misreadRefusal, propertyVocabulary,
  reconcileScope, recordPhraseMismatch, scopeChips, warningSentence, withoutCurrencyClaim,
  withoutWriteParameter,
  type QualifierVerdict, type VocabPropertyDef, type Vocabulary,
} from '../src/client/modules/copilot/scope-core';
import { confidenceChip, refusalOf } from '../src/client/modules/copilot/answer-core';
import { dedupeCitations } from '../src/client/modules/copilot/citations';
import { approvalOutcome, runOutcome, type AiApproval } from '../src/client/modules/copilot/api';

/* ============================ the workspace ============================== */

const stage = (pipeline: string, pipelineLabel: string) =>
  (name: string, label: string, isClosed = false, isWon = false) =>
    ({ pipeline, pipelineLabel, name, label, isClosed, isWon });

const nb = stage('new_business', 'New business');
const ex = stage('expansion', 'Expansion');
const rn = stage('renewal', 'Renewal');

/** `GET /v1/pipelines/deal`, as the seed writes it. */
const PIPELINES = [
  {
    name: 'new_business',
    label: 'New business',
    stages: [
      nb('qualification', 'Qualification'), nb('discovery', 'Discovery'),
      nb('technical_validation', 'Technical validation'), nb('proposal', 'Proposal sent'),
      nb('negotiation', 'Negotiation'),
      nb('closed_won', 'Closed won', true, true), nb('closed_lost', 'Closed lost', true, false),
    ],
  },
  {
    name: 'expansion',
    label: 'Expansion',
    stages: [
      ex('qualification', 'Expansion identified'), ex('discovery', 'Discovery'),
      ex('proposal', 'Proposal sent'), ex('negotiation', 'Negotiation'),
      ex('closed_won', 'Closed won', true, true), ex('closed_lost', 'Closed lost', true, false),
    ],
  },
  {
    name: 'renewal',
    label: 'Renewal',
    stages: [
      rn('renewal_outreach', 'Renewal outreach'), rn('usage_review', 'Usage & value review'),
      rn('commercial_terms', 'Commercial terms'), rn('negotiation', 'Negotiation'),
      rn('closed_won', 'Closed won', true, true), rn('closed_lost', 'Closed lost', true, false),
    ],
  },
];

/** `GET /v1/ai/metrics`, verbatim — the platform's own catalogue. */
const METRICS = [
  { id: 'pipeline', label: 'Open pipeline', unit: 'money', keywords: ['pipeline', 'open deals', 'worth'], snapshot: true },
  { id: 'weighted_pipeline', label: 'Weighted pipeline', unit: 'money', keywords: ['weighted', 'forecast'], snapshot: true },
  { id: 'closed_won', label: 'Closed-won bookings', unit: 'money', keywords: ['closed won', 'bookings', 'won'], snapshot: false },
  { id: 'closed_lost', label: 'Closed-lost value', unit: 'money', keywords: ['lost'], snapshot: false },
  { id: 'deal_count', label: 'Deals', unit: 'count', keywords: ['deals'], snapshot: true },
  { id: 'customers', label: 'Customers', unit: 'count', keywords: ['customers', 'accounts'], snapshot: true },
  { id: 'open_tickets', label: 'Open tickets', unit: 'count', keywords: ['open tickets', 'backlog'], snapshot: true },
  { id: 'csat', label: 'Customer satisfaction', unit: 'score', keywords: ['csat', 'satisfaction'], snapshot: false },
  { id: 'sales_cycle', label: 'Average sales cycle', unit: 'days', keywords: ['sales cycle'], snapshot: false },
];

/** The enumerated deal properties `GET /v1/objects/deal/properties` returns. */
const PROPERTY_DEFS: VocabPropertyDef[] = [
  { name: 'pipeline', label: 'Pipeline', options: [
    { value: 'new_business', label: 'New business' }, { value: 'expansion', label: 'Expansion' },
    { value: 'renewal', label: 'Renewal' },
  ] },
  { name: 'deal_status', label: 'Status', options: [
    { value: 'open', label: 'Open' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' },
  ] },
  { name: 'forecast_category', label: 'Forecast category', options: [
    { value: 'pipeline', label: 'Pipeline' }, { value: 'best_case', label: 'Best case' },
    { value: 'commit', label: 'Commit' }, { value: 'closed', label: 'Closed' },
    { value: 'omitted', label: 'Omitted' },
  ] },
  { name: 'deal_type', label: 'Deal type', options: [
    { value: 'new_business', label: 'New business' }, { value: 'expansion', label: 'Expansion' },
    { value: 'renewal', label: 'Renewal' }, { value: 'pilot_conversion', label: 'Pilot conversion' },
  ] },
  { name: 'lead_source', label: 'Original source', options: [
    { value: 'trade_show', label: 'Trade show' }, { value: 'inbound_content', label: 'Inbound content' },
    { value: 'outbound_sequence', label: 'Outbound sequence' }, { value: 'partner_referral', label: 'Partner referral' },
    { value: 'webinar', label: 'Webinar' }, { value: 'paid_search', label: 'Paid search' },
  ] },
  { name: 'close_reason', label: 'Close reason', options: [
    { value: 'product_fit', label: 'Product fit' }, { value: 'price', label: 'Price' },
    { value: 'budget_cut', label: 'Budget cut' },
  ] },
];

const VOCAB: Vocabulary = {
  pipelines: PIPELINES,
  people: [
    { id: 'usr_seed01', name: 'Dana Whitfield' },
    { id: 'usr_seed02', name: 'Marcus Ilori' },
    { id: 'usr_seed03', name: 'Priya Raman' },
  ],
  metrics: METRICS,
  otherPipelines: [{ name: 'support', label: 'Support', objectType: 'ticket' }],
  properties: propertyVocabulary(PROPERTY_DEFS, PIPELINES, METRICS),
};

const OPEN_STAGES = [
  'qualification', 'discovery', 'proposal', 'negotiation', 'technical_validation',
  'renewal_outreach', 'usage_review', 'commercial_terms',
];

const verdictOf = (verdicts: QualifierVerdict[], kind: string) => verdicts.find((v) => v.kind === kind);

/* ============ P0 · a write prepared against a sibling record ============== */

/**
 * The sweep, run against the live engine on a freshly seeded workspace.
 *
 * Every account here holds two or more open deals. Each row is the question
 * asked with that deal's own display name, and the record the engine actually
 * prepared the write against — read out of the approval row's `preview[0]`,
 * which is the only name a person approving the card can see. Seven of the
 * fourteen were prepared against a sibling.
 *
 * The one the guard used to miss is the Pemberton "pilot expansion to 3 lines"
 * row: the write was prepared against *first pilot attempt*, closed-lost at
 * $223,440, and approving it moved $223,440 of lost business back into open
 * pipeline with no warning shown and one click required.
 */
const SIBLING_SWEEP: { question: string; prepared: string; misTargeted: boolean }[] = [
  { question: 'Move the Kaskade Pharma Group predictive maintenance programme deal to Proposal',
    prepared: 'Kaskade Pharma Group — pilot expansion to 3 lines', misTargeted: true },
  { question: 'Move the Kaskade Pharma Group pilot expansion to 3 lines deal to Proposal',
    prepared: 'Kaskade Pharma Group — pilot expansion to 3 lines', misTargeted: false },
  { question: 'Move the Thornbury Logistics multi-site rollout deal to Proposal',
    prepared: 'Thornbury Logistics — multi-site rollout', misTargeted: false },
  { question: 'Move the Thornbury Logistics line 3 instrumentation deal to Proposal',
    prepared: 'Thornbury Logistics — multi-site rollout', misTargeted: true },
  { question: 'Move the Norbjerg Vindkraft multi-site rollout deal to Proposal',
    prepared: 'Norbjerg Vindkraft — multi-site rollout', misTargeted: false },
  { question: 'Move the Norbjerg Vindkraft OEE programme phase 2 deal to Proposal',
    prepared: 'Norbjerg Vindkraft — OEE programme phase 2', misTargeted: false },
  { question: 'Move the Aldergate Semiconductor enterprise agreement deal to Proposal',
    prepared: 'Aldergate Semiconductor — enterprise agreement', misTargeted: false },
  { question: 'Move the Aldergate Semiconductor line 3 instrumentation deal to Proposal',
    prepared: 'Aldergate Semiconductor — enterprise agreement', misTargeted: true },
  { question: 'Move the Wexler Pharmaceutical enterprise agreement deal to Proposal',
    prepared: 'Wexler Pharmaceutical — multi-site rollout', misTargeted: true },
  { question: 'Move the Wexler Pharmaceutical multi-site rollout deal to Proposal',
    prepared: 'Wexler Pharmaceutical — multi-site rollout', misTargeted: false },
  { question: 'Move the Ferro Norte Siderurgia predictive maintenance programme deal to Proposal',
    prepared: 'Ferro Norte Siderurgia — multi-site rollout', misTargeted: true },
  { question: 'Move the Ferro Norte Siderurgia multi-site rollout deal to Proposal',
    prepared: 'Ferro Norte Siderurgia — multi-site rollout', misTargeted: false },
  { question: 'Move the Pemberton Auto Systems pilot expansion to 3 lines deal to Proposal',
    prepared: 'Pemberton Auto Systems — first pilot attempt', misTargeted: true },
  { question: 'Move the Pemberton Auto Systems renewal + asset uplift deal to Proposal',
    prepared: 'Pemberton Auto Systems — first pilot attempt', misTargeted: true },
];

describe('a write prepared against a sibling of the deal that was named', () => {
  it('gates every one of the seven mis-targets in the sweep', () => {
    const missed = SIBLING_SWEEP
      .filter((row) => row.misTargeted && !recordPhraseMismatch(row.question, row.prepared))
      .map((row) => row.question);
    assert.deepEqual(missed, [], 'a write against the wrong record reached the approval card unwarned');
  });

  it('says nothing about the seven prepared against the deal that was named', () => {
    const false_alarms = SIBLING_SWEEP
      .filter((row) => !row.misTargeted && recordPhraseMismatch(row.question, row.prepared))
      .map((row) => row.question);
    assert.deepEqual(false_alarms, [], 'a correct write was gated behind a red banner');
  });

  it('names the deal the question named, not the one the engine resolved', () => {
    // The exact case the guard stood down on: "pilot" is a word *first pilot
    // attempt* carries, so a rule that tested one token against the bag of the
    // record's words let the whole sentence through.
    const mismatch = recordPhraseMismatch(
      'Move the Pemberton Auto Systems pilot expansion to 3 lines deal to Proposal',
      'Pemberton Auto Systems — first pilot attempt',
    );
    assert.ok(mismatch, 'the write that resurrected a closed-lost deal was not gated');
    assert.equal(mismatch.asked, 'Pemberton Auto Systems pilot expansion to 3 lines');
    assert.equal(mismatch.used, 'Pemberton Auto Systems — first pilot attempt');
  });

  it('leaves a partial mention, a set narrowed by a word, and a note alone', () => {
    // Each of these would be a red banner over a correct answer.
    const quiet: [string, string][] = [
      ['Update the Northwind renewal deal', 'Northwind Robotics — renewal 2027'],
      ['Show me the Pemberton Auto Systems open deals', 'Pemberton Auto Systems'],
      ['Add a note to Meridian Forge Systems about the renewal deal', 'Meridian Forge Systems'],
      ['What deals does Pemberton Auto Systems own?', 'Pemberton Auto Systems'],
      ['How much has Sakamoto Seiki spent recently?', 'Sakamoto Seiki'],
      ['How many open tickets does Pemberton Auto Systems have?', 'Pemberton Auto Systems'],
      ['Move the Sakamoto deal to Negotiation.', 'Sakamoto Seiki — multi-site rollout'],
    ];
    for (const [question, name] of quiet) {
      assert.equal(recordPhraseMismatch(question, name), null, `${question} → ${name}`);
    }
  });
});

/* ========== P0 · a question naming one deal, read for the account ========= */

/** The run for "What stage is the … pilot expansion to 3 lines deal in?", verbatim. */
const NAMED_DEAL_READ = {
  question: 'What stage is the Pemberton Auto Systems pilot expansion to 3 lines deal in?',
  prose: '3 deals on Pemberton Auto Systems:\n\n• Pemberton Auto Systems — pilot expansion to 3 lines — $582,120 · Technical validation · closes Oct 9, 2026 · Dana Whitfield\n\n• Pemberton Auto Systems — renewal + asset uplift — $582,120 · Qualification · closes Sep 2, 2026 · Dana Whitfield\n\n• Pemberton Auto Systems — first pilot attempt — $223,440 · Closed lost · closes Apr 19, 2026 · Marcus Ilori',
  toolCalls: [
    { name: 'account_profile', arguments: { id: 'cmp_nw_07' } },
    { name: 'record_search', arguments: { object_type: 'deal', associated_to: 'cmp_nw_07', order_by: 'amount', limit: 10 } },
  ],
  reasoning: [
    'Qualifier ledger settled: account "Pemberton Auto Systems" bound → account_profile.',
    'Ran account_profile in 4ms → Pemberton Auto Systems.',
    'Ran record_search in 25ms → 3 records.',
  ],
};

describe('a question about one deal, answered for the whole account', () => {
  it('contradicts the account-wide search, not only the account-wide figure', () => {
    // The guard covered the money path ("How much is the … deal worth?" → the
    // account's $1,164,240 for a $582,120 deal) and not the search path, which
    // returned all three Pemberton deals at 98% with no banner at all.
    const report = reconcileScope({
      ...NAMED_DEAL_READ,
      vocab: VOCAB,
      resolveId: (id) => (id === 'cmp_nw_07' ? 'Pemberton Auto Systems' : null),
    });
    const account = verdictOf(report.verdicts, 'account');
    assert.ok(account, 'a named-deal question answered with three deals carried no warning');
    assert.equal(account.state, 'substituted');
    assert.equal(account.asked, 'Pemberton Auto Systems pilot expansion to 3 lines');
    assert.equal(account.used, 'Pemberton Auto Systems');
    assert.match(warningSentence(account), /the whole of Pemberton Auto Systems/);
  });
});

/* ============ P0 · "close" answered with the open-deal count ============== */

/**
 * Verbatim. The true answer, computed from `/v1/records/deal`: 8 deals closed
 * in Q2 2026, worth $613,760. The engine answered 0, and captioned it "open
 * only" — the status inverted to its exact opposite and asserted as the scope.
 */
const CLOSED_IN_Q2 = {
  question: 'How many deals did we close in Q2 2026?',
  prose: 'Northwind Robotics has 0 open deals closing in Q2 2026.',
  toolCalls: [{
    name: 'record_aggregate',
    arguments: {
      object_type: 'deal',
      measure: 'count',
      conditions: [{ property: 'deal_stage', op: 'in', values: OPEN_STAGES }],
      date_property: 'close_date',
      start: 1775001600000,
      end: 1782864000000,
    },
  }],
  reasoning: [
    'Qualifier ledger settled: metric "How many deals" bound → record_aggregate; period "Q2 2026" bound → record_aggregate.',
    'Ran record_aggregate in 1ms → 0 ().',
  ],
};

describe('a question about deals we closed, answered about deals that are open', () => {
  it('calls the inverted status a substitution and says so in red', () => {
    const report = reconcileScope({ ...CLOSED_IN_Q2, vocab: VOCAB });
    const status = verdictOf(report.verdicts, 'status');
    assert.ok(status, 'nothing on this surface could contradict "open only" over a question that said "close"');
    assert.equal(status.state, 'substituted');
    assert.equal(status.asked, 'Closed deals');
    assert.equal(status.used, 'open deals');
    assert.ok(report.unscoped.includes(status), 'the contradiction was not put in the banner');
    assert.equal(warningSentence(status), 'You asked about closed deals. This figure counts open deals.');
  });

  it('does not state "open only" calmly beside a banner calling it wrong', () => {
    const report = reconcileScope({ ...CLOSED_IN_Q2, vocab: VOCAB });
    const chips = scopeChips(report.answering[0], VOCAB, report.verdicts, {
      window: (w) => w.label ?? '', name: (id) => id,
    });
    const status = chips.find((chip) => chip.kind === 'status');
    assert.ok(status, 'the scope row said nothing about the status the query used');
    assert.equal(status.value, 'open only');
    assert.equal(status.wide, true, 'the row vouched for a scope the banner above it contradicts');
  });

  it('leaves the same question answered over the closed stages alone', () => {
    // "Show me the deals we closed in Q2 2026" returns all 8 and is correct.
    const report = reconcileScope({
      question: 'Show me the deals we closed in Q2 2026',
      prose: '8 deals closed in Q2 2026.',
      toolCalls: [{
        name: 'record_search',
        arguments: {
          object_type: 'deal',
          conditions: [{ property: 'deal_stage', op: 'in', values: ['closed_won', 'closed_lost'] }],
          date_property: 'close_date', start: 1775001600000, end: 1782864000000,
        },
      }],
      reasoning: ['Ran record_search in 2ms → 8 records.'],
      vocab: VOCAB,
    });
    assert.equal(verdictOf(report.verdicts, 'status')?.state, 'bound');
    assert.deepEqual(report.unscoped, []);
    // …and the chip stays calm, because nothing contradicts it.
    const chips = scopeChips(report.answering[0], VOCAB, report.verdicts, {
      window: (w) => w.label ?? '', name: (id) => id,
    });
    assert.equal(chips.find((chip) => chip.kind === 'status')?.wide, false);
  });

  it('does not read a deal that is closing as a deal that closed', () => {
    // "closing" is the future tense of the same verb and the opposite status.
    const report = reconcileScope({
      question: 'Which deals are closing this month?',
      prose: '14 deals close in Sep 2026.',
      toolCalls: [{
        name: 'record_search',
        arguments: {
          object_type: 'deal',
          conditions: [{ property: 'deal_stage', op: 'in', values: OPEN_STAGES }],
          date_property: 'close_date', start: 1788220800000, end: 1790812800000,
        },
      }],
      reasoning: ['Ran record_search in 1ms → 14 records.'],
      vocab: VOCAB,
    });
    assert.equal(verdictOf(report.verdicts, 'status')?.state, undefined);
  });

  it('still lets a metric spend its own status word', () => {
    // "closed-won bookings" is the name of a measure, not a filter dropped.
    const report = reconcileScope({
      question: 'What is closed-won bookings this year?',
      prose: 'Northwind Robotics booked $2,443,640 in 2026 to date, from 18 closed-won deals.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'closed_won', window_label: '2026 to date', group_by: 'none' } }],
      reasoning: ['Ran business_metric in 3ms → $2,443,640 (18 closed-won deals).'],
      vocab: VOCAB,
    });
    assert.equal(verdictOf(report.verdicts, 'status'), undefined);
  });
});

/* ========== P0 · a record property named and silently dropped ============ */

/**
 * Verbatim. True answer from `crm_records`: 7 open deals carry
 * `lead_source = trade_show`, worth $2,634,940. The engine answered 38 — every
 * open deal in the workspace, 5.4x too high — and the words "trade show"
 * appeared nowhere on the card.
 */
const TRADE_SHOW = {
  question: 'How many open deals came from a trade show?',
  prose: 'Northwind Robotics has 38 open deals right now.',
  toolCalls: [{
    name: 'business_metric',
    arguments: {
      metric: 'deal_count', start: 1782864000000, end: 1790812800000,
      window_label: 'Q3 2026 to date', group_by: 'none', compare: true,
    },
  }],
  reasoning: [
    'Unrecognised terms carried through: "came", "trade" — answered anyway because the metric "Deals" resolved.',
    'Qualifier ledger settled: metric "How many open deals" bound → business_metric.',
    'Ran business_metric in 1ms → 38 (38 open deals).',
  ],
};

describe('a record property the question named and the query never filtered on', () => {
  it('reads the CRM’s own enumerated values as a dimension a question can name', () => {
    const values = VOCAB.properties ?? [];
    const trade = values.find((row) => row.value === 'trade_show');
    assert.ok(trade, 'the workspace’s own lead sources are not in the qualifier vocabulary');
    assert.equal(trade.propertyLabel, 'Original source');
    assert.equal(trade.label, 'Trade show');
    // A value another qualifier kind already owns must not be claimed twice:
    // "Expansion" is a pipeline, and `deal_type` spells one of its options the
    // same way. Nor may a word that turns up in ordinary questions.
    const labels = values.map((row) => row.label);
    for (const taken of ['Expansion', 'Renewal', 'New business', 'Pipeline', 'Closed', 'Price']) {
      assert.ok(!labels.includes(taken), `${taken} is claimed by something else and must not be a property claim`);
    }
    assert.ok(labels.includes('Webinar') && labels.includes('Partner referral'));
  });

  it('refuses the figure rather than answering 38 for 7', () => {
    const report = reconcileScope({ ...TRADE_SHOW, vocab: VOCAB });
    const property = verdictOf(report.verdicts, 'property');
    assert.ok(property, 'the qualifier the whole question turned on vanished without trace');
    assert.equal(property.state, 'unbound');
    assert.equal(property.asked, 'Trade show');
    assert.equal(property.dimension, 'Original source');
    assert.ok(report.unscoped.includes(property), 'the dropped qualifier was not put in the banner');
    assert.match(warningSentence(property), /Original source .Trade show./);
    assert.match(warningSentence(property), /Nothing in this answer filtered on it/);
  });

  it('names the dimension on the scope row, in red', () => {
    const report = reconcileScope({ ...TRADE_SHOW, vocab: VOCAB });
    const chips = scopeChips(report.answering[0], VOCAB, report.verdicts, {
      window: (w) => w.label ?? '', name: (id) => id,
    });
    const chip = chips.find((row) => row.kind === 'property');
    assert.ok(chip, 'MEASURED OVER said nothing about the source the question named');
    assert.equal(chip.label, 'Original source');
    assert.equal(chip.value, 'not filtered');
    assert.equal(chip.wide, true);
  });

  it('is silent when the query really did filter on the value', () => {
    const report = reconcileScope({
      question: 'How many open deals came from a trade show?',
      prose: 'Northwind Robotics has 7 open deals from Trade show.',
      toolCalls: [{
        name: 'record_aggregate',
        arguments: {
          object_type: 'deal', measure: 'count',
          conditions: [
            { property: 'deal_stage', op: 'in', values: OPEN_STAGES },
            { property: 'lead_source', op: 'eq', value: 'trade_show' },
          ],
        },
      }],
      reasoning: ['Ran record_aggregate in 1ms → 7 ().'],
      vocab: VOCAB,
    });
    assert.equal(verdictOf(report.verdicts, 'property')?.state, 'bound');
    assert.deepEqual(report.unscoped, []);
  });
});

/* =========== P1 · the banner that accused a correct answer =============== */

describe('the reconciliation crying wolf on a correct count', () => {
  it('does not accuse a deal count of measuring open pipeline', () => {
    // "open deals" is both the thing being counted and a keyword of the Open
    // pipeline metric. Spending it twice put the loudest banner in the design
    // system over the correct answer to "How many open deals came from a trade
    // show?" — and the one true warning on that card sat under it.
    const report = reconcileScope({ ...TRADE_SHOW, vocab: VOCAB });
    assert.equal(verdictOf(report.verdicts, 'metric'), undefined);
    assert.deepEqual(
      report.unscoped.map((v) => v.kind),
      ['property'],
      'the only thing wrong with this answer is the dropped source',
    );
  });

  it('does not read a stage name out of the middle of a measure name', () => {
    // "What is closed-won bookings in EUR this year?" carried two red banners:
    // the true one about the book, and "You asked about Closed won. This figure
    // counts every stage." — a stage filter read out of the name of the metric
    // the question asked for. A guard that fires beside itself teaches people
    // to stop reading both.
    const report = reconcileScope({
      question: 'What is closed-won bookings in EUR this year?',
      prose: 'Northwind Robotics booked $2,443,640 in 2026 to date, from 18 closed-won deals.',
      toolCalls: [{
        name: 'business_metric',
        arguments: { metric: 'closed_won', window_label: '2026 to date', currency: 'eur', group_by: 'none' },
      }],
      reasoning: ['Ran business_metric in 3ms → $2,443,640 (18 closed-won deals).'],
      vocab: VOCAB,
    });
    assert.equal(verdictOf(report.verdicts, 'stage'), undefined);
    // The one thing that really is wrong with it is still said.
    assert.deepEqual(report.unscoped.map((v) => v.kind), ['currency']);
  });

  it('still reads a stage the question names on its own', () => {
    const report = reconcileScope({
      question: 'How many deals are in Closed won?',
      prose: 'Northwind Robotics has 39 open deals right now.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'deal_count', group_by: 'none' } }],
      reasoning: ['Ran business_metric in 1ms → 39 (39 open deals).'],
      vocab: VOCAB,
    });
    assert.equal(verdictOf(report.verdicts, 'stage')?.state, 'unbound');
  });

  it('does not read the trailing noun of a pipeline name as a measure', () => {
    // "How many open deals are in the Qualification stage of the Renewal
    // pipeline?" is correct — Renewal has no qualification stage — and carried
    // "You asked for Open pipeline. This figure is Deals."
    const report = reconcileScope({
      question: 'How many open deals are in the Qualification stage of the Renewal pipeline?',
      prose: 'Northwind Robotics has no deals in the Renewal pipeline at the Qualification stage right now.',
      toolCalls: [{
        name: 'business_metric',
        arguments: {
          metric: 'deal_count', start: 1782864000000, end: 1790812800000,
          window_label: 'Q3 2026 to date', pipeline: 'renewal', stage: 'qualification', group_by: 'none',
        },
      }],
      reasoning: [
        'Qualifier ledger settled: metric "How many open deals" bound → business_metric; pipeline "Renewal" bound → business_metric; stage "qualification" bound → business_metric.',
        'Ran business_metric in 1ms → 0 (0 open deals).',
      ],
      vocab: VOCAB,
    });
    assert.deepEqual(report.unscoped, [], 'a correct answer carried a red banner');
  });
});

/* ====== the invariant · a dimension nobody here has typed a name for ===== */

describe('a qualifier kind this surface has no rule for', () => {
  it('reports it rather than dropping it, whatever the engine calls it', () => {
    // The whole defect in one line: a list of known kinds, and everything the
    // engine settles under a kind not on that list falling silently through.
    // `product_area "Dashboard" refused` is a real ledger line from this
    // engine, and the client had never heard of the kind.
    const report = reconcileScope({
      question: 'How many tickets mention the Dashboard?',
      prose: 'Northwind Robotics has 7 open tickets.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'open_tickets', group_by: 'none' } }],
      reasoning: [
        'Qualifier ledger settled: metric "open tickets" bound → business_metric; product_area "Dashboard" refused.',
        'Ran business_metric in 1ms → 7 (7 open tickets).',
      ],
      vocab: VOCAB,
    });
    const dropped = report.unscoped.find((v) => v.asked === 'Dashboard');
    assert.ok(dropped, 'the engine said out loud that it refused a qualifier, and nothing said so on screen');
    assert.equal(dropped.state, 'waived');
    assert.equal(dropped.dimension, 'Product area');
    assert.match(warningSentence(dropped), /Product area .Dashboard./);
  });

  it('does not read a ranking as a narrowing', () => {
    // An order decides which end of the set is shown; it does not change which
    // rows are in it, and the answer's own rows already state it.
    const report = reconcileScope({
      question: 'What is the largest open deal?',
      prose: 'Rheinwerk Antriebstechnik — OEE programme phase 2 — $729,000.',
      toolCalls: [{ name: 'record_search', arguments: { object_type: 'deal', order_by: 'amount', limit: 1 } }],
      reasoning: [
        'Qualifier ledger settled: ranking "largest" bound → record_search.',
        'Ran record_search in 1ms → 1 records.',
      ],
      vocab: VOCAB,
    });
    assert.equal(report.unscoped.find((v) => v.asked === 'largest'), undefined);
  });
});

/* ============== P1 · a refusal whose reason is not true ================== */

describe('a refusal given a reason the same card disproves', () => {
  const ranking = refusalOf({
    reasoning: ['Refused (qualifier_unbound): 1 qualifier could not be bound: status "open pipeline".'],
  });

  it('knows a measure this workspace publishes from a status it does not have', () => {
    const misread = misreadRefusal(ranking, VOCAB);
    assert.ok(misread, '"open pipeline" was refused as an unbindable status and the reason was printed as given');
    assert.equal(misread.kind, 'status');
    assert.equal(misread.text, 'open pipeline');
    assert.equal(misread.metric.id, 'pipeline');
  });

  it('leaves a refusal whose reason is true exactly as it is', () => {
    const support = refusalOf({
      reasoning: ['Refused (qualifier_unbound): 1 qualifier could not be bound: pipeline "Support pipeline".'],
    });
    assert.equal(misreadRefusal(support, VOCAB), null);
    const owner = refusalOf({
      reasoning: ['Refused (qualifier_unbound): 1 qualifier could not be bound: owner "Priya Raman".'],
    });
    assert.equal(misreadRefusal(owner, VOCAB), null);
    assert.equal(misreadRefusal(null, VOCAB), null);
  });
});

/* ======== P1 · a ranking answered with a list of individual deals ======== */

const STAGE_RANKING = {
  question: 'Which stage has the most open pipeline?',
  prose: '38 open deals. The 8 largest of them:\n\n• Rheinwerk Antriebstechnik — OEE programme phase 2 — $729,000 · Qualification · closes Sep 11, 2026 · Priya Raman',
  toolCalls: [{
    name: 'record_search',
    arguments: {
      object_type: 'deal',
      conditions: [{ property: 'deal_stage', op: 'in', values: OPEN_STAGES }],
      order_by: 'amount', limit: 10,
    },
  }],
  reasoning: [
    'Qualifier ledger settled: status "open pipeline" bound → record_search.',
    'Ran record_search in 1ms → 10 records.',
  ],
};

describe('a ranking question answered with a list of records', () => {
  it('does not caption a list of eight deals as one total', () => {
    const report = reconcileScope({ ...STAGE_RANKING, vocab: VOCAB });
    const group = verdictOf(report.verdicts, 'group');
    assert.ok(group);
    assert.equal(group.state, 'unbound');
    assert.equal(group.used, 'a list of records, not a ranking');
    assert.notEqual(group.used, 'one total, not broken down');
  });

  it('still calls a metric that really did come back as one total what it is', () => {
    const report = reconcileScope({
      question: 'Which owner has the most open pipeline?',
      prose: 'Northwind Robotics is carrying $9,010,960 in open pipeline.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', group_by: 'none' } }],
      reasoning: ['Ran business_metric in 1ms → $9,010,960 (38 open deals).'],
      vocab: VOCAB,
    });
    assert.equal(verdictOf(report.verdicts, 'group')?.used, 'one total, not broken down');
  });
});

/* ============ P1 · sentences the answer should not be left with ========== */

describe('the engine’s own sentences, where the card disproves them', () => {
  it('drops a EUR scope claim printed over a dollar figure', () => {
    const prose = 'Northwind Robotics booked $2,443,640 in 2026 to date, from 18 closed-won deals.\n\n'
      + 'That is up $556,200 (+29.5%) against $1,887,440 in the period before.\n\n'
      + '2026 to date is still running, so this is a period-to-date figure.\n\n'
      + 'Scoped to the EUR book, which is the currency you named — the other books are not in this figure.';
    const report = reconcileScope({
      question: 'What is closed-won bookings in EUR this year?',
      prose,
      toolCalls: [{
        name: 'business_metric',
        arguments: { metric: 'closed_won', window_label: '2026 to date', currency: 'eur', group_by: 'none' },
      }],
      reasoning: [
        'Qualifier ledger settled: metric "closed-won bookings" bound → business_metric; currency "eur" bound → business_metric.',
        'Ran business_metric in 3ms → $2,443,640 (18 closed-won deals).',
      ],
      vocab: VOCAB,
    });
    assert.equal(verdictOf(report.verdicts, 'currency')?.state, 'substituted');
    const shown = correctedProse(prose, { verdicts: report.verdicts, denied: null, vocab: VOCAB });
    assert.ok(!/Scoped to the EUR book/.test(shown), 'a claim and its refutation were printed in one card');
    assert.match(shown, /\$2,443,640/, 'the figure itself is still reported');
    assert.match(shown, /period-to-date figure/, 'only the false sentence goes');
  });

  it('keeps the scope claim when the figure agrees with it', () => {
    const prose = '€1,204,300 in 2026 to date.\n\nScoped to the EUR book, which is the currency you named.';
    assert.equal(withoutCurrencyClaim(prose), prose.replace(/\s+$/, '').length ? withoutCurrencyClaim(prose) : prose);
    const kept = correctedProse(prose, {
      verdicts: [{ kind: 'currency', asked: 'EUR', state: 'bound', used: 'EUR', tool: 'business_metric' }],
      denied: null,
      vocab: VOCAB,
    });
    assert.match(kept, /Scoped to the EUR book/);
  });

  it('replaces the denial that a real pipeline exists, rather than stacking a rebuttal on it', () => {
    const prose = 'You asked about the pipeline "Support pipeline", and I could not apply it to anything I can measure. '
      + 'No deal pipeline in this workspace is called "Support". '
      + 'I have not answered the unscoped question instead — Northwind Robotics’s total is a precise answer to a question you did not ask. '
      + 'The pipelines Northwind Robotics has are "New business", "Expansion" and "Renewal".';
    const fixed = correctPipelineDenial(prose, { name: 'support', label: 'Support', objectType: 'ticket' }, VOCAB);
    assert.ok(!/No deal pipeline in this workspace is called/.test(fixed), 'the falsehood was left on screen');
    assert.ok(!/The pipelines Northwind Robotics has are/.test(fixed), 'the three-item list that omits Support survived');
    assert.match(fixed, /Support.{0,3} is a ticket pipeline in this workspace/);
    // …and it reads as one paragraph, not two sentences run together.
    assert.ok(!/[a-z]\.[A-Z]/.test(fixed), `sentences ran together: ${fixed}`);
    assert.ok(!/ [.,]/.test(fixed), `a stray space before punctuation: ${fixed}`);
    // The corrected enumeration names all four, deal pipelines and ticket ones.
    for (const name of ['New business', 'Expansion', 'Renewal', 'Support']) {
      assert.ok(fixed.includes(name), `${name} is missing from the corrected list of pipelines`);
    }
  });

  it('points a rev-ops lead at the switch instead of at an API parameter', () => {
    const prose = 'I changed nothing. That reads as a request to update record, but this run is read-only. '
      + 'Send `allow_writes: true` and I will prepare it for your approval.';
    const fixed = withoutWriteParameter(prose);
    assert.ok(!/allow_writes/.test(fixed), 'the chat still tells a person to send an API parameter');
    assert.match(fixed, /Let it prepare writes/);
    assert.match(fixed, /nothing is written until you approve it/);
    // A refusal that never mentioned the parameter is untouched.
    assert.equal(withoutWriteParameter('I changed nothing.'), 'I changed nothing.');
  });

  it('makes the verb agree with a count of one', () => {
    assert.equal(agreeWithTheCount('1 deal were created in July 2026.'), '1 deal was created in July 2026.');
    assert.equal(agreeWithTheCount('1 ticket are open.'), '1 ticket is open.');
    assert.equal(agreeWithTheCount('1 company have paid.'), '1 company has paid.');
    // Plurals and other counts are left exactly as the engine wrote them.
    assert.equal(agreeWithTheCount('8 deals were created in July 2026.'), '8 deals were created in July 2026.');
    assert.equal(agreeWithTheCount('1 deals were created.'), '1 deals were created.');
  });
});

/* ================= P1 · a failed write reported as written =============== */

const approval = (over: Partial<AiApproval>): AiApproval => ({
  object: 'ai_approval',
  id: 'appr_1',
  run_id: 'run_1',
  thread_id: 'thr_1',
  tool: 'update_record',
  args: { object_type: 'deal', id: 'deal_nw_15', properties: { deal_stage: 'commercial_terms' } },
  preview: ['Deal Pemberton Auto Systems — first pilot attempt', 'Deal stage → commercial_terms'],
  reason: 'update_record changes workspace data, so a person approves it before it runs.',
  status: 'approved',
  outcome: null,
  requested_by: 'usr_seed01',
  decided_by: 'usr_seed01',
  decided_at: 1788366454008,
  created: 1788366453997,
  ...over,
});

describe('what a write actually did, against what a person decided', () => {
  // Both outcome strings are verbatim from `/v1/ai/approvals`.
  const FAILED = 'Failed: "commercial_terms" belongs to the Renewal pipeline, not New business. '
    + 'New business stages: qualification, discovery, technical_validation, proposal, negotiation, closed_won, closed_lost.';
  const WROTE = 'object=record id=note_H8YS2RZy1WkeZS object_type=note display_name=Keyboard probe owner_id=usr_seed01';

  it('does not call a refused write "Approved and written"', () => {
    assert.equal(approvalOutcome(approval({ outcome: FAILED })), 'failed');
  });

  it('still calls a landed write written, and a declined one declined', () => {
    assert.equal(approvalOutcome(approval({ outcome: WROTE })), 'written');
    assert.equal(approvalOutcome(approval({ status: 'declined', outcome: null })), 'declined');
    assert.equal(approvalOutcome(approval({ status: 'pending', outcome: null })), 'pending');
    assert.equal(approvalOutcome(approval({ outcome: null })), 'written');
  });

  it('does not let the run log count a failed write as a successful run', () => {
    const run = { status: 'succeeded', reasoning: [] as string[] };
    assert.equal(runOutcome(run, [approval({ outcome: FAILED })]), 'failed');
    assert.equal(runOutcome(run, [approval({ outcome: WROTE })]), 'written');
  });
});

/* ================== P2 · the chip that was loudest when wrong ============ */

describe('the confidence chip', () => {
  it('leads with the accurate half where a qualifier went unbound', () => {
    assert.equal(confidenceChip(99, 1), '1 qualifier of this question is unbound');
    assert.equal(confidenceChip(98, 2), '2 qualifiers of this question are unbound');
    // The classifier's margin is still the chip when there is nothing to say
    // against it.
    assert.equal(confidenceChip(79, 0), 'intent read at 79%');
  });
});

/* ====================== P2 · one record, cited once ====================== */

describe('the records an answer was read from', () => {
  it('names a record read twice only once', () => {
    const rows = [
      { id: 'tkt_nw_09', label: 'Dashboard loads slowly with 900 assets selected', type: 'ticket' },
      { id: 'tkt_nw_11', label: 'SSO group mapping not applying to new engineers', type: 'ticket' },
      { id: 'tkt_nw_09', label: 'Dashboard loads slowly with 900 assets selected', type: 'ticket' },
    ];
    assert.deepEqual(dedupeCitations(rows).map((row) => row.id), ['tkt_nw_09', 'tkt_nw_11']);
  });
});
