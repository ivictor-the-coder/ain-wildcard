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
  agreeWithTheCount, comparisonRephrase, correctPipelineDenial, correctedProse, isWiderName,
  isWriteRequest, lookupObject, metricsMeasured,
  misreadRefusal, namedQualifiers, propertyVocabulary, questionHeadNoun,
  reconcileScope, recordPhraseMismatch, refusalDisprovedByThread, scopeChips, warningSentence,
  withoutCurrencyClaim, withoutRefusedQualifier, withoutWriteParameter,
  type QualifierVerdict, type VocabPropertyDef, type Vocabulary,
} from '../src/client/modules/copilot/scope-core';
import {
  carriedScope, confidenceChip, contradictsCarried, noWritePrepared, propertyAsked, refusalOf,
} from '../src/client/modules/copilot/answer-core';
import { dedupeCitations, writeTargetLabel } from '../src/client/modules/copilot/citations';
import {
  consequenceLines, dealNamedIn, editHref, linkedTargetOf, needsAcknowledgement, stageConsequences,
  stageWriteOf, type DealNow,
} from '../src/client/modules/copilot/write-core';
import {
  EMPTY_LEDGER, checkDunning, draftsFromAccount, ledgerFrom, ledgerTotal,
} from '../src/client/modules/copilot/draft-core';
import {
  approvalOutcome, decidedBadge, runOutcome, type AiApproval,
} from '../src/client/modules/copilot/api';

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

/* ==================================================================== *
 *  The second sweep: what a critic found beside the deal board.
 *  Every fixture below is verbatim output from this engine against the
 *  seeded Northwind workspace, captured from a booted app.
 * ==================================================================== */

/** The board with the numbers a stage change restamps, as `/v1/pipelines/deal` returns them. */
const column = (pipeline: string, pipelineLabel: string) =>
  (name: string, label: string, probability: number, forecastCategory: string, isClosed = false, isWon = false) =>
    ({ pipeline, pipelineLabel, name, label, isClosed, isWon, probability, forecastCategory });

const nbc = column('new_business', 'New business');
const rnc = column('renewal', 'Renewal');

const BOARD: Vocabulary = {
  ...VOCAB,
  pipelines: [
    {
      name: 'new_business',
      label: 'New business',
      stages: [
        nbc('qualification', 'Qualification', 10, 'pipeline'),
        nbc('discovery', 'Discovery', 25, 'pipeline'),
        nbc('technical_validation', 'Technical validation', 45, 'pipeline'),
        nbc('proposal', 'Proposal sent', 60, 'best_case'),
        nbc('negotiation', 'Negotiation', 80, 'commit'),
        nbc('closed_won', 'Closed won', 100, 'closed', true, true),
        nbc('closed_lost', 'Closed lost', 0, 'closed', true, false),
      ],
    },
    {
      name: 'renewal',
      label: 'Renewal',
      stages: [
        rnc('renewal_outreach', 'Renewal outreach', 40, 'pipeline'),
        rnc('usage_review', 'Usage & value review', 60, 'best_case'),
        rnc('commercial_terms', 'Commercial terms', 75, 'commit'),
        rnc('negotiation', 'Negotiation', 90, 'commit'),
        rnc('closed_won', 'Renewed', 100, 'closed', true, true),
        rnc('closed_lost', 'Churned', 0, 'closed', true, false),
      ],
    },
  ],
};

/* ========= P0 · approving a one-line stage change reopens a deal ========== */

/**
 * `deal_nw_15` — Pemberton Auto Systems — first pilot attempt.
 *
 * Closed lost at $223,440 in the New business pipeline, probability 0,
 * forecast category `closed`. "Move the Pemberton Auto Systems — first pilot
 * attempt deal to Negotiation" prepares `update_record` with `{properties:
 * {deal_stage: "negotiation"}}` and a two-line preview:
 *
 *   Deal Pemberton Auto Systems — first pilot attempt
 *   Deal stage → negotiation
 *
 * Approving it changed five things, read back off `/v1/records/deal/deal_nw_15`
 * after the decision: stage closed_lost → negotiation, **deal_status lost →
 * open**, forecast_category closed → commit, probability 0 → 80, and $223,440
 * of business written off in March back in open pipeline and in the forecast.
 * The card named one of the five.
 */
const LOST_DEAL: DealNow = {
  id: 'deal_nw_15',
  name: 'Pemberton Auto Systems — first pilot attempt',
  stage: 'closed_lost',
  status: 'lost',
  amount: 22_344_000,
  probability: 0,
  forecastCategory: 'closed',
};

describe('a stage change that reopens a closed-lost deal', () => {
  it('is read off the write and the record as a change of closed state', () => {
    const write = stageWriteOf('update_record', {
      object_type: 'deal', id: 'deal_nw_15', properties: { deal_stage: 'negotiation' },
    });
    assert.deepEqual(write, { recordId: 'deal_nw_15', objectType: 'deal', stage: 'negotiation' });

    const c = stageConsequences(LOST_DEAL, 'negotiation', BOARD);
    assert.equal(c.closedState, 'reopens');
    assert.deepEqual(c.status, { from: 'lost', to: 'open' });
    // Open pipeline counts an open deal at its whole amount and a closed one at
    // nothing, so reopening this one puts all $223,440 back into it.
    assert.equal(c.pipelineDelta, 22_344_000);
    // The forecast counts it at the stage's own probability: 80% of $223,440.
    assert.equal(c.forecastDelta, 17_875_200);
    assert.deepEqual(c.probability, { from: 0, to: 80 });
    assert.deepEqual(c.forecastCategory, { from: 'closed', to: 'commit' });
  });

  it('says so on the card in those words, before the money', () => {
    const c = stageConsequences(LOST_DEAL, 'negotiation', BOARD);
    const lines = consequenceLines(c, (minor) => `$${(minor / 100).toLocaleString('en-US')}`);
    assert.equal(lines[0].kind, 'closed');
    assert.match(lines[0].text, /closed state/);
    assert.match(lines[0].text, /reopens it/);
    const said = lines.map((line) => line.text).join(' ');
    assert.match(said, /Status lost → open\./);
    assert.match(said, /Open pipeline gains \$223,440/);
    assert.match(said, /weighted forecast gains \$178,752/);
    assert.match(said, /Forecast category closed → commit\./);
  });

  it('holds the Approve button until a person has acknowledged it', () => {
    const c = stageConsequences(LOST_DEAL, 'negotiation', BOARD);
    assert.equal(needsAcknowledgement(c, false), true);
    // And when the deal could not be read at all, which is the other way a
    // person can end up approving a reopening they were never shown.
    assert.equal(needsAcknowledgement(null, true), true);
  });

  it('leaves an ordinary move between two open stages alone', () => {
    const open: DealNow = {
      id: 'deal_nw_46', name: 'Kilbride Dairy Systems — line 3 instrumentation',
      stage: 'discovery', status: 'open', amount: 1_824_000, probability: 25, forecastCategory: 'pipeline',
    };
    const c = stageConsequences(open, 'negotiation', BOARD);
    assert.equal(c.closedState, 'unchanged');
    assert.equal(c.pipelineDelta, 0);
    assert.equal(needsAcknowledgement(c, false), false);
    assert.equal(consequenceLines(c, (m) => String(m)).some((line) => line.kind === 'closed'), false);
  });

  it('says a stage from another pipeline will fail before it is approved', () => {
    // The engine prepared exactly this, and the tool answered `Failed:
    // "commercial_terms" belongs to the Renewal pipeline, not New business.`
    const open: DealNow = {
      id: 'deal_nw_46', name: 'Kilbride Dairy Systems — line 3 instrumentation',
      stage: 'negotiation', status: 'open', amount: 1_824_000, probability: 80, forecastCategory: 'commit',
    };
    const c = stageConsequences(open, 'commercial_terms', BOARD);
    assert.equal(c.wrongPipeline, true);
    assert.equal(needsAcknowledgement(c, false), true);
  });

  it('marks a close as a change of closed state too', () => {
    const open: DealNow = {
      id: 'deal_nw_50', name: 'Norbjerg Vindkraft — multi-site rollout',
      stage: 'negotiation', status: 'open', amount: 10_442_000, probability: 80, forecastCategory: 'commit',
    };
    const c = stageConsequences(open, 'closed_lost', BOARD);
    assert.equal(c.closedState, 'closes');
    assert.equal(c.pipelineDelta, -10_442_000);
    assert.match(consequenceLines(c, (m) => String(m))[0].text, /closed state/);
  });
});

/* ============= P0 · a failed write badged "decided — written" ============= */

describe('the badge on a decided write', () => {
  const failed: Pick<AiApproval, 'status' | 'outcome'> = {
    status: 'approved',
    outcome: 'Failed: "commercial_terms" belongs to the Renewal pipeline, not New business. '
      + 'New business stages: qualification, discovery, technical_validation, proposal, negotiation, closed_won, closed_lost.',
  };
  const landed: Pick<AiApproval, 'status' | 'outcome'> = {
    status: 'approved',
    outcome: 'object=record id=deal_nw_15 object_type=deal display_name=Pemberton Auto Systems — first pilot attempt',
  };

  it('does not call a refused write written', () => {
    assert.deepEqual(decidedBadge([failed]), { label: 'decided — the write failed', tone: 'danger' });
  });

  it('still says written when the tool wrote', () => {
    assert.deepEqual(decidedBadge([landed]), { label: 'decided — written', tone: 'success' });
  });

  it('says declined when nothing was approved', () => {
    assert.deepEqual(decidedBadge([{ status: 'declined', outcome: null }]), { label: 'decided — declined', tone: 'neutral' });
  });
});

/* ========== P0 · a dunning draft that states no money is owed ============= */

/**
 * Brightline Foods, `cmp_nw_04`, billing customer `cus_G68fGPXpftVKfbf8`.
 *
 * `GET /v1/invoices?status=open_like` holds NR-000032 for $127,840, due
 * 2026-07-08 — 56 days before the workspace clock. `POST /v1/ai/draft` with
 * that company's id writes the chase around those figures; with the id of one
 * of its deals — the only kind of id this dialog has ever sent — it writes the
 * body below, and the dialog offered it for logging.
 */
const BRIGHTLINE_LEDGER = ledgerFrom(
  [{ number: 'NR-000032', amount_due: 12_784_000, currency: 'usd', due_date: Date.UTC(2026, 6, 8), status: 'open' }],
  Date.UTC(2026, 8, 2),
);

const DEAL_ID_DRAFT = {
  subject: 'No unpaid invoice on Brightline Foods — renewal + asset uplift — nothing to chase',
  body: 'I have not drafted a chase for Brightline Foods — renewal + asset uplift: the billing ledger shows '
    + 'no invoice with an amount still due on that account — every issued invoice is paid, void or draft. '
    + 'Naming a bill that does not exist is worse than sending nothing, so there is no letter here.',
};

const ACCOUNT_DRAFT = {
  subject: 'Invoice NR-000032 for Brightline Foods — $127,840.00 outstanding',
  body: 'Hi Marlene,\n\nInvoice NR-000032 for $127,840.00 is still outstanding, due Jul 8, 2026 — 56 days ago.',
};

describe('a chase checked against the ledger it is about', () => {
  it('reads the real figures off the real invoices', () => {
    assert.equal(BRIGHTLINE_LEDGER.state, 'read');
    assert.equal(BRIGHTLINE_LEDGER.bills.length, 1);
    assert.equal(BRIGHTLINE_LEDGER.bills[0].number, 'NR-000032');
    assert.equal(BRIGHTLINE_LEDGER.bills[0].amountDue, 12_784_000);
    assert.equal(BRIGHTLINE_LEDGER.bills[0].daysOverdue, 56);
    assert.equal(ledgerTotal(BRIGHTLINE_LEDGER), 12_784_000);
  });

  it('refuses the draft that declares $127,840 of 56-day-old debt paid', () => {
    const verdict = checkDunning(DEAL_ID_DRAFT, BRIGHTLINE_LEDGER);
    assert.equal(verdict.state, 'contradicted');
    assert.match(verdict.state === 'contradicted' ? verdict.why : '', /nothing is owed/);
  });

  it('accepts the draft that names the invoice the ledger holds', () => {
    assert.deepEqual(checkDunning(ACCOUNT_DRAFT, BRIGHTLINE_LEDGER), { state: 'ok' });
  });

  it('refuses to draft at all when the figures cannot be resolved', () => {
    const verdict = checkDunning(ACCOUNT_DRAFT, { ...EMPTY_LEDGER, why: 'no billing customer' });
    assert.equal(verdict.state, 'unresolved');
  });

  it('refuses a chase against an account that owes nothing', () => {
    const clean = ledgerFrom([], Date.UTC(2026, 8, 2));
    assert.equal(checkDunning(ACCOUNT_DRAFT, clean).state, 'contradicted');
    // The engine's own "nothing to chase" is the truth for that account.
    assert.deepEqual(checkDunning(DEAL_ID_DRAFT, clean), { state: 'ok' });
  });

  it('composes a chase from the account and everything else from the deal', () => {
    assert.equal(draftsFromAccount('dunning'), true);
    assert.equal(draftsFromAccount('follow_up'), false);
  });
});

/* ====== P0 · a thread that narrows every later question to one record ===== */

/**
 * Three turns in one conversation, captured from a booted app.
 *
 *   1. "How much open pipeline does Marcus Ilori own?" → $1,878,120, correct.
 *   2. "How many tickets are escalated?"               → carried Marcus Barnes.
 *   3. "What is our open pipeline?"                    → $315,900.
 *
 * The workspace total is $9,010,960. Turn 3 is 28× out, scoped to a *contact*
 * the reader never named, and the only thing on the card that said so was a
 * calm grey chip reading `ACCOUNT · Marcus Barnes`.
 */
const CARRIED_RUN = {
  reasoning: [
    'No period in the question, and Open pipeline is measured as of now, so no reporting period applies.',
    'Resolved 1 record: Marcus Barnes (contact, 0.66, trigram).',
    '"this turn" names nothing on its own; carried Marcus Barnes from the previous turn, and the answer is scoped to it.',
    'Metric: Open pipeline (matched "open pipeline", score 1).',
  ],
};

describe('a scope inherited from an earlier question', () => {
  it('is read out of the run and named', () => {
    const held = carriedScope(CARRIED_RUN);
    assert.equal(held?.subject, 'Marcus Barnes');
    assert.equal(held?.pinned, false);
  });

  it('is a pinned record when that is where it came from', () => {
    const held = carriedScope({
      reasoning: ['"it" names nothing on its own; carried Brightline Foods from the record this conversation is pinned to, and the answer is scoped to it.'],
    });
    assert.equal(held?.subject, 'Brightline Foods');
    assert.equal(held?.pinned, true);
  });

  it('is a contradiction when the question asks about the whole workspace', () => {
    const held = carriedScope(CARRIED_RUN);
    assert.equal(contradictsCarried('What is our open pipeline?', held), true);
  });

  it('is not a contradiction when the question names the carried record itself', () => {
    const held = carriedScope(CARRIED_RUN);
    assert.equal(contradictsCarried('What is our open pipeline on Marcus Barnes?', held), false);
  });

  it('is shown but not called a contradiction when the question names nothing either way', () => {
    const held = carriedScope(CARRIED_RUN);
    assert.equal(contradictsCarried('How many tickets are escalated?', held), false);
    assert.equal(held?.subject, 'Marcus Barnes');
  });

  it('says nothing about a run that carried nothing', () => {
    assert.equal(carriedScope({ reasoning: ['Metric: Open pipeline (matched "open pipeline", score 1).'] }), null);
  });
});

/* ====== P0 · a filter nobody asked for, ANDed in, reported as 0 =========== */

/**
 * "How many deals did we close in Q2 2026?" — verbatim.
 *
 * The plan ANDed the eight open stages against the Q2 close-date window the
 * question really did name, and answered "Northwind Robotics has 0 open deals
 * closing in Q2 2026." The workspace closed 8 deals worth $613,760 in Q2. No
 * word of the question produced the word "open".
 */
const INVENTED_CALL = {
  name: 'record_aggregate',
  arguments: {
    object_type: 'deal',
    measure: 'count',
    conditions: [{ property: 'deal_stage', op: 'in', values: OPEN_STAGES }],
    date_property: 'close_date',
    start: Date.UTC(2026, 3, 1),
    end: Date.UTC(2026, 6, 1),
  },
};

describe('a filter no word of the question produced', () => {
  const report = reconcileScope({
    question: 'How many deals did we close in Q2 2026?',
    prose: 'Northwind Robotics has 0 open deals closing in Q2 2026.',
    toolCalls: [INVENTED_CALL],
    reasoning: [
      'Qualifier ledger settled: metric "How many deals" bound → record_aggregate; period "Q2 2026" bound → record_aggregate.',
      'Ran record_aggregate in 2ms → 0.',
    ],
    vocab: VOCAB,
  });

  it('is named as a filter rather than only as a wider scope', () => {
    assert.equal(report.invented.length, 1);
    assert.equal(report.invented[0].kind, 'status');
    assert.equal(report.invented[0].used, 'open deals only');
    assert.equal(report.invented[0].asked, 'Closed deals');
  });

  it('keeps the warning that was already right', () => {
    assert.equal(verdictOf(report.verdicts, 'status')?.state, 'substituted');
  });

  it('finds none where the measure the question named implies the filter', () => {
    // "How much open pipeline does Marcus Ilori own?" runs over the same eight
    // stages and says "open" because Open pipeline *is* the open stages.
    const fine = reconcileScope({
      question: 'How much open pipeline does Marcus Ilori own?',
      prose: '$1,878,120 in open pipeline across 9 open deals owned by Marcus Ilori.',
      toolCalls: [{
        name: 'record_aggregate',
        arguments: {
          object_type: 'deal', measure: 'sum', property: 'amount',
          conditions: [{ property: 'deal_stage', op: 'in', values: OPEN_STAGES }],
          owner_id: 'usr_seed02',
        },
      }],
      reasoning: [
        'Qualifier ledger settled: metric "open pipeline" bound → record_aggregate; owner "Marcus Ilori" bound → record_aggregate.',
        'Ran record_aggregate in 3ms → $1,878,120.',
      ],
      vocab: VOCAB,
      resolveId: (id) => (id === 'usr_seed02' ? 'Marcus Ilori' : null),
    });
    assert.deepEqual(fine.invented, []);
    assert.deepEqual(fine.unscoped, []);
  });

  it('finds none where the question named the stage the query used', () => {
    const fine = reconcileScope({
      question: 'How many deals are in Negotiation?',
      prose: 'Northwind Robotics has 6 deals in Negotiation.',
      toolCalls: [{
        name: 'record_aggregate',
        arguments: {
          object_type: 'deal', measure: 'count',
          conditions: [{ property: 'deal_stage', op: 'in', values: ['negotiation'] }],
        },
      }],
      reasoning: ['Ran record_aggregate in 1ms → 6.'],
      vocab: VOCAB,
    });
    assert.deepEqual(fine.invented, []);
  });
});

/* ============ P1 · the reconciliation crying wolf on "close" ============== */

/**
 * "How much open pipeline do we expect to close this quarter?" — verbatim.
 *
 * The engine reads it exactly right: open deals now, close date inside Q3, and
 * answers $4,014,120 across 16 deals. The surface then topped that correct
 * answer with a red "You asked about closed deals. This figure counts open
 * deals." and turned its STATUS chip red — because the verb "close" was read as
 * the status, in a sentence whose own second word is "open".
 */
describe('a question that says "open pipeline" and the verb "close"', () => {
  const answer = {
    question: 'How much open pipeline do we expect to close this quarter?',
    prose: '$4,014,120 in open pipeline across 16 open deals closing in Q3 2026.',
    toolCalls: [{
      name: 'record_aggregate',
      arguments: {
        object_type: 'deal', measure: 'sum', property: 'amount',
        conditions: [{ property: 'deal_stage', op: 'in', values: OPEN_STAGES }],
        date_property: 'close_date', start: Date.UTC(2026, 6, 1), end: Date.UTC(2026, 8, 31),
      },
    }],
    reasoning: [
      'Qualifier ledger settled: metric "open pipeline" bound → record_aggregate; period "this quarter" bound → record_aggregate.',
      'Ran record_aggregate in 3ms → $4,014,120 (16 open deals).',
    ],
    vocab: VOCAB,
  };

  it('is not accused of asking about closed deals', () => {
    const named = namedQualifiers(answer.question, VOCAB);
    assert.equal(named.some((q) => q.kind === 'status' && q.value === 'closed'), false);
    const report = reconcileScope(answer);
    assert.equal(verdictOf(report.verdicts, 'status'), undefined);
    assert.deepEqual(report.unscoped, []);
    assert.deepEqual(report.invented, []);
  });

  it('leaves the status chip calm rather than red', () => {
    const report = reconcileScope(answer);
    const chips = scopeChips(report.answering[0], VOCAB, report.verdicts, {
      window: () => 'Q3 2026', name: (id) => id,
    });
    assert.equal(chips.find((chip) => chip.kind === 'status')?.wide, false);
  });

  it('still hears "closed" when the question really is about closed deals', () => {
    // The 0-for-8 substitution above depends on this staying true.
    const named = namedQualifiers('How many deals did we close in Q2 2026?', VOCAB);
    assert.equal(named.find((q) => q.kind === 'status')?.value, 'closed');
  });
});

/* ======== P1 · a note or task prepared for a deal, landing on the account = */

describe('the record a note or a task would land on', () => {
  it('is read off the "Linked to" line of a task, wherever it sits', () => {
    // `create_record` prepared for "the Sakamoto Seiki — packaging line uplift
    // deal", associated to `cmp_nw_35` — the company.
    const preview = [
      'New task', 'Subject: Follow up with Sakamoto Seiki', 'Occurred at: Sep 2, 2026',
      'Status: not_started', 'Task type: follow_up', 'Priority: medium', 'Due at: Sep 4, 2026',
      'Owner id: usr_seed03', 'Linked to Sakamoto Seiki',
    ];
    assert.equal(writeTargetLabel('create_record', {}, preview), null);
    assert.equal(linkedTargetOf(preview), 'Sakamoto Seiki');
    const mismatch = recordPhraseMismatch(
      'Create a task on the Sakamoto Seiki — packaging line uplift deal to call the CFO on Friday',
      'Sakamoto Seiki',
    );
    assert.equal(mismatch?.used, 'Sakamoto Seiki');
    assert.match(mismatch?.asked ?? '', /packaging line uplift/);
    assert.equal(isWiderName(mismatch?.asked ?? '', 'Sakamoto Seiki'), true);
  });

  it('is read off a note the same way', () => {
    assert.equal(linkedTargetOf(['Note on Ferro Norte Siderurgia', 'Subject: CFO signed off']), 'Ferro Norte Siderurgia');
  });

  it('names nothing when the preview names nothing', () => {
    assert.equal(linkedTargetOf(['New task', 'Subject: Call someone']), null);
  });
});

/* ========= P1 · a refusal this same conversation already disproved ======== */

describe('a ranking refusal', () => {
  const refusal = { code: 'qualifier_unbound', message: '1 qualifier could not be bound: metric "break".' };

  it('is contradicted by an earlier turn that measured the same thing', () => {
    const disproved = refusalDisprovedByThread(
      refusal,
      'Break open pipeline down by owner.',
      VOCAB,
      [{ question: 'Which account has the most open pipeline?', metrics: ['pipeline'] }],
    );
    assert.equal(disproved?.measure.id, 'pipeline');
    assert.equal(disproved?.question, 'Which account has the most open pipeline?');
  });

  it('reads the measures a turn ran off its own arguments', () => {
    assert.deepEqual(
      metricsMeasured([{ name: 'business_metric', arguments: { metric: 'pipeline', group_by: 'account' } }]),
      ['pipeline'],
    );
  });

  it('stands where nothing in the thread has measured it', () => {
    assert.equal(refusalDisprovedByThread(refusal, 'Break open pipeline down by owner.', VOCAB, []), null);
    assert.equal(
      refusalDisprovedByThread(refusal, 'Break open pipeline down by owner.', VOCAB,
        [{ question: 'How many tickets are escalated?', metrics: ['tickets_created'] }]),
      null,
    );
  });
});

/* ========== P1 · the copilot cannot set a deal's amount or owner ========== */

describe('a write the engine could not prepare', () => {
  const run = {
    reasoning: [
      'Intent act (confidence 99%, margin 4.08); signals: act.update "Set the" +4.08',
      'No write prepared: the request looks like update_record, but I could not tell which property to set '
        + '— name the property and the value, e.g. "move <deal> to Negotiation".',
      'Ran account_profile in 6ms → Kilbride Dairy Systems.',
    ],
  };

  it('is read as the fact it is rather than left as a dead end', () => {
    assert.equal(noWritePrepared(run)?.tool, 'update_record');
  });

  it('knows which property the sentence named', () => {
    assert.equal(propertyAsked('Set the amount on the Kilbride Dairy Systems — line 3 instrumentation deal to $2,000,000')?.property, 'amount');
    assert.equal(propertyAsked('Change the owner of the Kilbride Dairy Systems — line 3 instrumentation deal to Marcus Ilori')?.property, 'owner_id');
    assert.equal(propertyAsked('Move the deal to Negotiation'), null);
  });

  it('finds the one deal on the account the question named', () => {
    const deals = [
      { id: 'deal_nw_46', display_name: 'Kilbride Dairy Systems — line 3 instrumentation' },
      { id: 'deal_nw_47', display_name: 'Kilbride Dairy Systems — line 2 monitoring' },
    ];
    assert.equal(
      dealNamedIn('Set the amount on the Kilbride Dairy Systems — line 3 instrumentation deal to $2,000,000', deals)?.id,
      'deal_nw_46',
    );
    // Two names both inside one sentence is the sibling problem, so it names neither.
    assert.equal(dealNamedIn('Compare Kilbride Dairy Systems — line 3 instrumentation with Kilbride Dairy Systems — line 2 monitoring', deals), null);
  });

  it('links to the deal record with the group that holds the property', () => {
    assert.equal(editHref('deal_nw_46', 'Deal information'), '/deals/deal_nw_46?edit=Deal%20information');
    assert.equal(editHref('deal_nw_46', ''), '/deals/deal_nw_46?edit=1');
  });
});

/* ======== P1 · a suggested starter question that produces no answer ======= */

/**
 * "Which support tickets need attention today?" is one of the five prompts
 * this workspace prints on its own empty state, and this engine answers it:
 * "You asked about the period 'today', and I could not apply it to anything I
 * can measure." The same sentence without the word "today" returns all seven
 * tickets that need attention. A suggested prompt is a promise.
 */
describe('a starter question the engine refuses', () => {
  const refusal = { code: 'qualifier_unbound', message: '1 qualifier could not be bound: period "today".' };

  it('is offered back without the qualifier that could not be bound', () => {
    assert.equal(
      withoutRefusedQualifier('Which support tickets need attention today?', refusal),
      'Which support tickets need attention?',
    );
  });

  it('drops a row cut-off the same way', () => {
    assert.equal(
      withoutRefusedQualifier('What is our top 2 pipeline by value?',
        { code: 'qualifier_unbound', message: '1 qualifier could not be bound: limit "2".' }),
      'What is our top pipeline by value?',
    );
  });

  it('leaves a question whose head noun is what was refused alone', () => {
    // "Which support tickets need?" is not a rephrasing of anything.
    assert.equal(
      withoutRefusedQualifier('Which support tickets need attention today?',
        { code: 'qualifier_unbound', message: '1 qualifier could not be bound: status "attention".' }),
      null,
    );
  });

  it('offers nothing where there was no refusal', () => {
    assert.equal(withoutRefusedQualifier('What is our open pipeline?', null), null);
  });

  /**
   * The fifth starter prompt, refused by the same engine on one word.
   *
   * "How did bookings last quarter compare with the quarter before?" comes back
   * `1 token unaccounted for: "before"`. Without that word it answers $334,840
   * against $1,791,400 — the comparison the prompt promised.
   */
  it('drops a word the engine could not place at all', () => {
    assert.equal(
      withoutRefusedQualifier('How did bookings last quarter compare with the quarter before?',
        { code: 'question_not_covered', message: '1 token unaccounted for: "before".' }),
      'How did bookings last quarter compare with the quarter?',
    );
  });

  it('never takes the grammar out of a sentence to do it', () => {
    // "What open pipeline?" is not a question anybody would press.
    assert.equal(
      withoutRefusedQualifier('What is our open pipeline?',
        { code: 'question_not_covered', message: '2 tokens unaccounted for: "our", "is".' }),
      null,
    );
  });

  /**
   * And never takes the subject out of one either.
   *
   * "How many contacts are in the Expansion pipeline?" is refused on the word
   * "contacts" — verbatim, `1 token unaccounted for: "contacts"` — and the way
   * out this surface offered was "How many are in the Expansion pipeline?": the
   * reader's own question with the thing it asks about removed.
   */
  it('leaves the subject of the question in the question', () => {
    assert.equal(
      withoutRefusedQualifier('How many contacts are in the Expansion pipeline?',
        { code: 'question_not_covered', message: '1 token unaccounted for: "contacts".' }, VOCAB),
      null,
    );
    assert.equal(
      withoutRefusedQualifier('Which customers are overdue on payment?',
        { code: 'question_not_covered', message: '1 token unaccounted for: "customers".' }, VOCAB),
      null,
    );
    assert.equal(questionHeadNoun('How many contacts are in the Expansion pipeline?'), 'contacts');
  });

  /**
   * "What is our pipeline velocity?" is refused on "velocity", and dropping it
   * leaves "What is our pipeline?" — a different, larger, standard number. This
   * file's whole subject is a measure quietly swapped for another one, so the
   * repair it offers cannot be that swap.
   */
  /**
   * "Which customers are overdue on payment?" is refused on "payment", and the
   * sentence without it ends "…are overdue on?".
   */
  it('will not offer a sentence that ends on a preposition', () => {
    assert.equal(
      withoutRefusedQualifier('Which customers are overdue on payment?',
        { code: 'question_not_covered', message: '1 token unaccounted for: "payment".' }, VOCAB),
      null,
    );
    // A word that means little on its own is still an ending: "…by value?" is
    // a question, and this guard must not take it away.
    assert.equal(
      withoutRefusedQualifier('What is our top 2 pipeline by value?',
        { code: 'qualifier_unbound', message: '1 qualifier could not be bound: limit "2".' }, VOCAB),
      'What is our top pipeline by value?',
    );
  });

  it('will not offer a different measure as the rephrasing', () => {
    assert.equal(
      withoutRefusedQualifier('What is our pipeline velocity?',
        { code: 'question_not_covered', message: '1 token unaccounted for: "velocity".' }, VOCAB),
      null,
    );
    // Without the catalogue there is nothing to check it against, and the
    // period repair — which needs no catalogue — still works.
    assert.equal(
      withoutRefusedQualifier('Which support tickets need attention today?',
        { code: 'qualifier_unbound', message: '1 qualifier could not be bound: period "today".' }, VOCAB),
      'Which support tickets need attention?',
    );
  });
});

/* ========= P1 · the reconciliation crying wolf over a write request ======= */

/**
 * A sentence that asks for a change names no filters.
 *
 * "Change the owner of the Redstone Energy Services — line 2 monitoring deal to
 * Priya Raman" is a write this engine cannot prepare — its extractor reads a
 * stage and nothing else — so it reads the account instead and says "I changed
 * nothing." Every fixture below is that run verbatim.
 *
 * The card printed the true fact about it (the copilot cannot set an owner) and,
 * above the answer, a red banner headed "This answer measured something other
 * than what was asked" with two sentences under it: "You asked about Priya
 * Raman. This figure was measured for Redstone Energy Services" and "You named
 * Redstone Energy Services — line 2 monitoring. This figure was measured over
 * the whole of Redstone Energy Services". There is no figure. Nothing was
 * measured, nothing was written, and "to Priya Raman" is the value the write
 * would set — not a scope anybody asked an answer to be narrowed to.
 */
describe('a question that asks for a write, not a measurement', () => {
  const OWNER_CHANGE = {
    question: 'Change the owner of the Redstone Energy Services — line 2 monitoring deal to Priya Raman',
    prose: 'I changed nothing. That reads as a request to update record, but I could not tell which '
      + 'property to set — name the property and the value, e.g. "move <deal> to Negotiation".',
    toolCalls: [{ name: 'account_profile', arguments: { id: 'cmp_nw_15' } }],
    reasoning: [
      'Workspace Northwind Robotics: currency USD, timezone America/New_York, clock 2026-09-02T22:29:44.894Z.',
      'Intent act (confidence 99%, margin 4.08); signals: act.update "Change" +4.08',
      'No period in the question; defaulting to Q3 2026 to date.',
      'Resolved 6 records: Redstone Energy Services (company, 0.96, name_exact); Priya Raman (user, 0.91, name_exact); Redstone Energy Services — line 2 monitoring (deal, 0.86, prefix).',
      'No write prepared: the request looks like update_record, but I could not tell which property to set — name the property and the value, e.g. "move <deal> to Negotiation".',
      'Plan (1 step, budget 8): account_profile.',
      '  account_profile: No write could be prepared, so this reads Redstone Energy Services rather than pretending to change it.',
      'Ran account_profile in 6ms → Redstone Energy Services.',
      'Usage: 4289 input + 43 output tokens, 5 credits, no marginal cost (local engine).',
    ],
    vocab: VOCAB,
    resolveId: (id: string) => (id === 'cmp_nw_15' ? 'Redstone Energy Services' : null),
  };

  it('is not accused of measuring the wrong thing', () => {
    const report = reconcileScope(OWNER_CHANGE);
    assert.deepEqual(report.unscoped.map((v) => `${v.kind}:${v.state}`), []);
    assert.deepEqual(report.verdicts, []);
  });

  it('says nothing at all about a figure it never printed', () => {
    const report = reconcileScope(OWNER_CHANGE);
    assert.equal(report.answering.every((m) => m.figure === null), true);
    assert.equal(report.invented.length, 0);
  });

  it('reads the same way for a write that was prepared and is waiting', () => {
    const report = reconcileScope({
      question: 'Move the Redstone Energy Services — line 2 monitoring deal to Negotiation',
      prose: 'I prepared update_record and stopped there — it changes the workspace, so it needs your '
        + 'approval first. Nothing has been written.',
      toolCalls: [],
      reasoning: [
        'Intent act (confidence 99%, margin 4.08); signals: act.update "Move" +4.08',
        'Plan (1 step, budget 8): update_record.',
        '  update_record: Set Redstone Energy Services — line 2 monitoring to the Negotiation stage; probability and forecast category restamp from the pipeline.',
        'update_record failed (approval_required): "update_record" is waiting for approval before it can run.',
      ],
      vocab: VOCAB,
    });
    assert.deepEqual(report.unscoped, []);
  });

  it('still reconciles a question that really did measure something', () => {
    // The guard is about write requests, not about quiet: an owner question
    // answered for a company is still the substitution this file exists for.
    const report = reconcileScope({
      question: 'What is Priya Raman’s open pipeline?',
      prose: 'Redstone Energy Services is carrying $1,463,440 in open pipeline, from 6 open deals.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', subject_id: 'cmp_nw_15', group_by: 'none' } }],
      reasoning: ['Ran business_metric in 9ms → $1,463,440 (6 open deals).'],
      vocab: VOCAB,
      resolveId: (id: string) => (id === 'cmp_nw_15' ? 'Redstone Energy Services' : null),
    });
    assert.equal(verdictOf(report.unscoped, 'owner')?.state, 'substituted');
  });

  it('knows a write request from the engine’s own notes', () => {
    assert.equal(isWriteRequest(['No write prepared: the request looks like update_record, but this run is read-only.']), true);
    assert.equal(isWriteRequest(['update_record failed (approval_required): "update_record" is waiting for approval before it can run.']), true);
    assert.equal(isWriteRequest(['Ran business_metric in 9ms → $9,010,960 (38 open deals).']), false);
  });
});

/* ====== P1 · the reconciliation crying wolf over the question’s noun ====== */

/**
 * The word a question is *about* is not the name of a measure.
 *
 * Both fixtures are verbatim runs against the seeded workspace, and both are
 * correct answers that carried a red banner.
 *
 * "What is the total value of deals in negotiation?" is answered $1,596,340
 * over the Negotiation column — the engine's own notes read `Metric: Open
 * pipeline (matched "value of deals")` — and the card said "You asked for
 * Deals. This figure is Open pipeline, which is a different measure." The word
 * "deals" is the thing being valued.
 *
 * "Which customers are overdue on payment?" is answered with the two accounts
 * that owe, read off the customer ledger, and the card said "You asked for
 * Customers. Nothing in this answer measured it." The word "customers" is what
 * was asked to be listed.
 */
describe('a measure claimed from the noun the question is about', () => {
  const VALUE_OF_DEALS = {
    question: 'What is the total value of deals in negotiation?',
    prose: 'Northwind Robotics is carrying $1,596,340 in pipeline at the Negotiation stage, from 8 open deals.',
    toolCalls: [{
      name: 'business_metric',
      arguments: { metric: 'pipeline', stage: 'negotiation', group_by: 'none', compare: true },
    }],
    reasoning: [
      'Metric: Open pipeline (matched "value of deals", score 0.5).',
      'Qualifier ledger: metric "value of deals" → pending (Open pipeline); stage "negotiation" → pending (Negotiation).',
      'Qualifier ledger settled: metric "value of deals" bound → business_metric; stage "negotiation" bound → business_metric.',
      'Ran business_metric in 3ms → $1,596,340 (8 open deals).',
    ],
    vocab: VOCAB,
  };

  const OVERDUE_CUSTOMERS = {
    question: 'Which customers are overdue on payment?',
    prose: '2 customers are past due on the customer ledger:\n• Brightline Foods — $127,840.00 across 1 '
      + 'open invoice, the oldest 56 days past due\n• Van Dijk Verpakking — $18,900.00 across 1 open invoice',
    toolCalls: [{ name: 'delinquent_customers', arguments: { limit: 10 } }],
    reasoning: [
      'Metric: Outstanding balance (matched "overdue", score 1.07).',
      'Plan (1 step, budget 8): delinquent_customers.',
      '  delinquent_customers: The question asks which customers owe, which is a fact about the customer ledger.',
      'Ran delinquent_customers in 2ms → {"object":"delinquent_customers","total":2,"customers":[{"id":"cus_3rs1sna94eEFZ9KR","name":"Brightline Foods"….',
    ],
    vocab: VOCAB,
  };

  it('does not read the thing being valued as the count of it', () => {
    const named = namedQualifiers(VALUE_OF_DEALS.question, VOCAB);
    assert.equal(named.some((q) => q.kind === 'metric'), false);
    assert.equal(verdictOf(reconcileScope(VALUE_OF_DEALS).unscoped, 'metric'), undefined);
  });

  it('leaves the stage it really did name standing', () => {
    // The guard takes one word off the question, not the whole reconciliation.
    const named = namedQualifiers(VALUE_OF_DEALS.question, VOCAB);
    assert.equal(named.find((q) => q.kind === 'stage')?.value, 'negotiation');
    assert.equal(verdictOf(reconcileScope(VALUE_OF_DEALS).verdicts, 'stage')?.state, 'bound');
  });

  it('does not read the records being listed as a measure of them', () => {
    const named = namedQualifiers(OVERDUE_CUSTOMERS.question, VOCAB);
    assert.equal(named.some((q) => q.kind === 'metric'), false);
    assert.deepEqual(reconcileScope(OVERDUE_CUSTOMERS).unscoped, []);
  });

  it('reads the head noun of a listing question and nothing else', () => {
    assert.equal(lookupObject('Which customers are overdue on payment?'), 'customers');
    assert.equal(lookupObject('Which rep has the most open pipeline?'), 'rep');
    assert.equal(lookupObject('What is our open pipeline?'), null);
  });

  it('still hears a measure the question really does name', () => {
    // "Which rep has the most open pipeline?" names Open pipeline, and a run
    // that measured Weighted pipeline instead is still the substitution.
    const report = reconcileScope({
      question: 'Which rep has the most open pipeline?',
      prose: 'Priya Raman is the biggest by weighted pipeline right now, at $2,101,000.',
      toolCalls: [{ name: 'business_metric', arguments: { metric: 'weighted_pipeline', group_by: 'owner' } }],
      reasoning: ['Ran business_metric in 6ms → $2,101,000 (17 open deals).'],
      vocab: VOCAB,
    });
    assert.equal(verdictOf(report.unscoped, 'metric')?.state, 'substituted');
  });
});

/* ===== P1 · the other starter prompt, offered back as a real sentence ===== */

/**
 * "How did bookings last quarter compare with the quarter before?" is the fifth
 * prompt this workspace prints, and it is refused on the single word "before" —
 * after the engine has already resolved and written down the two windows it
 * meant. Cutting the word out leaves "…compare with the quarter?", which is not
 * a sentence anybody would press. The reasoning below is that run verbatim.
 */
describe('the comparison a refused starter had already worked out', () => {
  const REASONING = [
    'Intent compare (confidence 85%, margin 3.72); signals: cmp.versus "compare with" +3.4',
    'Period "last quarter" → Q2 2026 (Q2 2026).',
    'Comparison windows: Q2 2026 against Q1 2026 (preceding period).',
    'Metric: Closed-won bookings (matched "bookings", score 1).',
    'Token accounting: 6 of 10 content tokens claimed by the plan, 3 closed-class, 1 unaccounted ("before").',
    'Refused (question_not_covered): 1 token unaccounted for: "before".',
  ];

  it('is offered back in the two periods the engine named itself', () => {
    assert.equal(
      comparisonRephrase(REASONING, VOCAB),
      'How did bookings in Q2 2026 compare with Q1 2026?',
    );
  });

  it('offers nothing where the engine resolved no second window', () => {
    assert.equal(comparisonRephrase(REASONING.filter((line) => !line.startsWith('Comparison windows')), VOCAB), null);
    assert.equal(comparisonRephrase(REASONING.filter((line) => !line.startsWith('Metric:')), VOCAB), null);
  });

  it('refuses to offer a period comparison of a snapshot measure', () => {
    // Open pipeline is the book as it stands today; "Q2 2026 against Q1 2026"
    // on it is one dead end traded for another.
    assert.equal(
      comparisonRephrase([
        'Comparison windows: Q2 2026 against Q1 2026 (preceding period).',
        'Metric: Open pipeline (matched "pipeline", score 1).',
      ], VOCAB),
      null,
    );
  });

  it('offers nothing for a measure this workspace does not publish', () => {
    assert.equal(
      comparisonRephrase([
        'Comparison windows: Q2 2026 against Q1 2026 (preceding period).',
        'Metric: Pipeline velocity (matched "velocity", score 1).',
      ], VOCAB),
      null,
    );
  });
});
