/**
 * The copilot surface over a template whitelist.
 *
 * The built-in engine answers a fixed list of question shapes and refuses the
 * rest. Everything the conversation draws about that — the panel of shapes,
 * the five that open an empty thread, the three nearest under a refusal, the
 * engine indicator, the slot chips read off the plan — is a pure function or
 * a hook-free component, and each is held to a fixture here.
 *
 * The write path (approval cards, stage consequences, sibling-record guards)
 * and the draft ledger check are unchanged in purpose and kept, with the ledger
 * check tightened to the promise the dialog prints about it.
 */
import { strict as assert } from 'node:assert';
import { register } from 'node:module';
import { describe, it } from 'node:test';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The design system's index pulls its stylesheets in; node has no idea what a
// `.css` import is. Short-circuit them so the hook-free components can be
// rendered to markup below, then import those components dynamically.
register(
  'data:text/javascript,export async function load(url, context, next) { if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true }; return next(url, context); }',
  import.meta.url,
);

import {
  inventedFilters, isWiderName, reconcileScope, recordPhraseMismatch, type Vocabulary,
} from '../src/client/modules/copilot/scope-core';
import { noWritePrepared, propertyAsked, refusalOf } from '../src/client/modules/copilot/answer-core';
import { dedupeCitations, writeTargetLabel } from '../src/client/modules/copilot/citations';
import {
  consequenceLines, dealNamedIn, editHref, linkedTargetOf, needsAcknowledgement, stageConsequences,
  stageWriteOf, type DealNow,
} from '../src/client/modules/copilot/write-core';
import {
  EMPTY_LEDGER, LEDGER_PROMISE, canLog, chaseVerdict, checkDunning, draftsFromAccount, figuresIn,
  invoiceNumbersIn, ledgerFrom, ledgerPromise, ledgerTotal,
} from '../src/client/modules/copilot/draft-core';
import {
  approvalOutcome, decidedBadge, runOutcome, type AiApproval,
} from '../src/client/modules/copilot/api';
import {
  API_KEYS_HREF, TEMPLATE_GROUPS, engineLine, engineOf, filterTemplates, groupOf, groupTemplates,
  nearestFromWire, nearestTemplates, starterTemplates, type AiTemplate,
} from '../src/client/modules/copilot/templates-core';
import {
  bindingOf, slotChips, slotChipsFromPlan, windowText, type SlotFormat,
} from '../src/client/modules/copilot/slots-core';
import { answerCard, type TurnInput } from '../src/client/modules/copilot/card-core';

const ui = {
  card: await import('../src/client/modules/copilot/card.tsx'),
  templates: await import('../src/client/modules/copilot/templates.tsx'),
};

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

/** `GET /v1/ai/metrics` — the platform's own catalogue. */
const METRICS = [
  { id: 'pipeline', label: 'Open pipeline', unit: 'money', keywords: ['pipeline', 'open deals', 'worth'], snapshot: true },
  { id: 'weighted_pipeline', label: 'Weighted pipeline', unit: 'money', keywords: ['weighted', 'forecast'], snapshot: true },
  { id: 'closed_won', label: 'Closed-won bookings', unit: 'money', keywords: ['closed won', 'bookings', 'won'], snapshot: false },
  { id: 'arr', label: 'ARR', unit: 'money', keywords: ['arr', 'annual recurring revenue'], snapshot: true },
  { id: 'deal_count', label: 'Deals', unit: 'count', keywords: ['deals'], snapshot: true },
  { id: 'customers', label: 'Customers', unit: 'count', keywords: ['customers', 'accounts'], snapshot: true },
  { id: 'open_tickets', label: 'Open tickets', unit: 'count', keywords: ['open tickets', 'backlog'], snapshot: true },
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
};

const OPEN_STAGES = [
  'qualification', 'discovery', 'proposal', 'negotiation', 'technical_validation',
  'renewal_outreach', 'usage_review', 'commercial_terms',
];

const NAMES: Record<string, string> = {
  usr_seed02: 'Marcus Ilori',
  cmp_nw_04: 'Brightline Foods',
  cus_G68fGPXpftVKfbf8: 'Brightline Foods',
};

const iso = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const FORMAT: SlotFormat = {
  window: (w) => windowText(w, { dateRange: (start, end) => `${iso(start)} – ${iso(end)}`, date: (ts) => iso(ts) }),
  name: (id) => NAMES[id] ?? id,
};

/* ============================ the whitelist ============================== */

/**
 * `GET /v1/ai/templates`, as a workspace of Northwind's shape would publish it:
 * every id carries its group as a prefix, the example is the shape with the
 * workspace's own values in it, and the order is the endpoint's own order of
 * usefulness. Three rows at the end deliberately carry no group prefix, so the
 * fallbacks are exercised.
 */
const t = (id: string, shape: string, example: string, description: string, slots: string[] = [], group?: string): AiTemplate =>
  ({ id, shape, example, description, slots: slots.map((name) => ({ name, type: name })), ...(group ? { group } : {}) });

const TEMPLATES: AiTemplate[] = [
  t('revenue.arr', 'What is our ARR?', 'What is our ARR?', 'Annualised recurring revenue from active subscriptions, as of now.'),
  t('pipeline.open_total', 'What is our open pipeline?', 'What is our open pipeline?', 'Every open deal at its full amount, as of now.'),
  t('customers.biggest', 'Who is my biggest customer?', 'Who is my biggest customer?', 'The account with the most closed-won bookings, all time.'),
  t('usage.top_meters', 'Which accounts used the most {meter} in {period}?', 'Which accounts used the most telemetry events in August 2026?', 'The top accounts on one meter over a period.', ['meter', 'period']),
  t('people.owner_pipeline', 'How much open pipeline does {owner} own?', 'How much open pipeline does Marcus Ilori own?', 'One teammate’s open deals, as of now.', ['owner']),
  t('pipeline.won_count', 'How many won deals are there {period}?', 'How many won deals are there in total?', 'Deals at a closed-won stage — all time unless a period is named.', ['period']),
  t('pipeline.closing_within', 'Which deals are closing in the next {days} days?', 'Which deals are closing in the next 90 days?', 'Open deals by close date, soonest first.', ['days']),
  t('pipeline.stage_total', 'What is the pipeline in {stage}?', 'What is the pipeline in Negotiation?', 'Open deals in one stage, as of now.', ['stage']),
  t('pipeline.closed_in', 'How many deals did we close in {period}?', 'How many deals did we close in Q2 2026?', 'Won and lost deals whose close date fell in the period.', ['period']),
  t('revenue.bookings_period', 'How much did we book in {period}?', 'How much did we book in Q3 2026?', 'Closed-won bookings in a period.', ['period']),
  t('revenue.invoiced_to_customers', 'What have our customers been invoiced in {period}?', 'What have our customers been invoiced in 2026?', 'Invoice totals across billing customers — not every company in the CRM.', ['period']),
  t('customers.on_plan', 'Which subscriptions are on the {plan} plan?', 'Which subscriptions are on the Growth plan?', 'Active subscriptions whose price belongs to one plan.', ['plan']),
  t('usage.credit_balance', 'What is the prepaid credit balance for {account}?', 'What is the prepaid credit balance for Brightline Foods?', 'Credits granted, consumed and remaining on one account.', ['account']),
  t('q_014', 'Which support tickets need attention?', 'Which support tickets need attention?', 'Open and pending tickets, oldest first.'),
  t('q_015', 'How many invoices are open?', 'How many invoices are open?', 'Invoices issued and not yet paid.'),
  t('q_016', 'How many telemetry events were recorded in {period}?', 'How many telemetry events were recorded in August 2026?', 'One meter’s total over a period.', ['period'], 'usage'),
];

/* ====================== the panel: what can I ask? ======================= */

describe('the whitelist, as the panel arranges it', () => {
  it('files a shape by the group the endpoint stated, then by its id, then by its wording', () => {
    assert.equal(groupOf(TEMPLATES.find((row) => row.id === 'q_016')!), 'usage', 'the endpoint said usage');
    assert.equal(groupOf(TEMPLATES.find((row) => row.id === 'revenue.arr')!), 'revenue', 'the id prefix');
    assert.equal(groupOf(TEMPLATES.find((row) => row.id === 'q_014')!), 'customers', 'tickets, by wording');
    assert.equal(groupOf(TEMPLATES.find((row) => row.id === 'q_015')!), 'revenue', 'invoices, by wording');
    assert.equal(groupOf(t('x', 'Describe the weather', 'Describe the weather', 'Nothing here.')), 'other');
  });

  it('puts who-owns questions under People rather than Pipeline', () => {
    assert.equal(groupOf(t('x', 'Open pipeline by owner', 'Open pipeline by owner', 'Each owner’s open deals.')), 'people');
  });

  it('arranges the list in the canonical order and leaves empty groups out', () => {
    const groups = groupTemplates(TEMPLATES);
    assert.deepEqual(groups.map((group) => group.id), ['revenue', 'pipeline', 'customers', 'usage', 'people']);
    assert.equal(groups.reduce((n, group) => n + group.templates.length, 0), TEMPLATES.length, 'every shape is in exactly one group');
    assert.deepEqual(TEMPLATE_GROUPS.map((group) => group.id), ['revenue', 'pipeline', 'customers', 'usage', 'people', 'other']);
  });

  it('opens an empty thread with five shapes, one per group where the list allows it', () => {
    const five = starterTemplates(TEMPLATES, 5);
    assert.equal(five.length, 5);
    assert.deepEqual(five.map(groupOf), ['revenue', 'pipeline', 'customers', 'usage', 'people']);
    // And in the endpoint's own order within that: the first row is the first starter.
    assert.equal(five[0].id, 'revenue.arr');
    // A short list is simply the list.
    assert.deepEqual(starterTemplates(TEMPLATES.slice(0, 2), 5).map((row) => row.id), ['revenue.arr', 'pipeline.open_total']);
  });

  it('filters by every word typed, against the example, the shape and the description', () => {
    assert.deepEqual(filterTemplates(TEMPLATES, 'growth').map((row) => row.id), ['customers.on_plan']);
    // "Won and lost deals" in a description is a match too — the filter reads all three fields.
    assert.deepEqual(filterTemplates(TEMPLATES, 'won deals').map((row) => row.id), ['pipeline.won_count', 'pipeline.closed_in']);
    assert.equal(filterTemplates(TEMPLATES, '').length, TEMPLATES.length);
    assert.deepEqual(filterTemplates(TEMPLATES, 'xyzzy'), []);
  });
});

/* ======================= the refusal, and the way out ==================== */

describe('a refusal, and the way out of it', () => {
  it('resolves the server’s nearest shapes against the whitelist', () => {
    const chips = nearestFromWire([
      { template_id: 'pipeline.won_count', example: 'How many won deals are there in total?' },
      { template_id: 'pipeline.closed_in' },
      { template_id: 'not.a.template' },
      { template_id: 'pipeline.won_count', example: 'How many won deals are there in total?' },
    ], TEMPLATES);
    assert.deepEqual(chips.map((chip) => chip.question), [
      'How many won deals are there in total?',
      'How many deals did we close in Q2 2026?',
    ], 'an unknown template with no example offers nothing; a repeat is one chip');
  });

  it('ranks the whitelist by wording for a turn read back without its completion', () => {
    const first = (question: string) => nearestTemplates(question, TEMPLATES).chips[0].templateId;
    assert.equal(first('How many won deals are there in total?'), 'pipeline.won_count');
    assert.equal(first('Who is my biggest customer?'), 'customers.biggest');
    assert.equal(first('deals closing in the next 90 days'), 'pipeline.closing_within');
    assert.equal(first('Which subscriptions are on the Growth plan?'), 'customers.on_plan');
    assert.equal(first('What is our ARR?'), 'revenue.arr');
    assert.equal(first('How much have our customers been invoiced this year?'), 'revenue.invoiced_to_customers');
  });

  it('says when nothing overlapped, so the label does not call unrelated shapes the closest', () => {
    const none = nearestTemplates('xyzzy plugh', TEMPLATES);
    assert.equal(none.matched, false);
    assert.equal(none.chips.length, 3, 'the whitelist is still the help');
    assert.equal(nearestTemplates('open pipeline', TEMPLATES).matched, true);
  });
});

/* =========================== which engine answered ======================= */

describe('which engine answered', () => {
  it('believes the completion first, then the run, then the provider, then the model name', () => {
    assert.equal(engineOf({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, 'template'), 'template');
    assert.equal(engineOf({ engine: 'anthropic', provider: 'builtin' }), 'anthropic');
    assert.equal(engineOf({ provider: 'anthropic', model: 'claude-sonnet-4-5' }), 'anthropic');
    assert.equal(engineOf({ provider: 'builtin', model: 'claude-haiku-4-5' }), 'anthropic');
    assert.equal(engineOf({ provider: 'builtin', model: 'ain-engine-1' }), 'template');
    assert.equal(engineOf(null), 'template');
  });

  it('explains, with no key, that free text needs one — and where', () => {
    const line = engineLine('template', false);
    assert.equal(line.label, 'answered from a template');
    assert.equal(line.needsKey, true);
    assert.match(line.detail, /Settings › API keys/);
    assert.equal(API_KEYS_HREF, '/settings/api-keys');
  });

  it('does not ask for a key that is already there, and names the model when it answered', () => {
    assert.equal(engineLine('template', true).needsKey, false);
    const model = engineLine('anthropic', true, 'claude-sonnet-4-5');
    assert.equal(model.label, 'answered by the model');
    assert.match(model.detail, /claude-sonnet-4-5/);
    assert.equal(model.needsKey, false);
  });
});

/* ===================== a corpus of correct template answers ============== */

interface Probe {
  question: string;
  toolCalls: TurnInput['toolCalls'];
  run?: Partial<NonNullable<TurnInput['run']>>;
  remembered?: TurnInput['remembered'];
  /** The slot chips the plan must yield, by kind → value. */
  slots: Record<string, string>;
  /** Slot kinds that must NOT appear — the P0 was each of these being injected. */
  never?: string[];
  truth: string;
}

const Q2 = { start: Date.UTC(2026, 3, 1), end: Date.UTC(2026, 6, 1) };
const NOW = Date.UTC(2026, 8, 2);

/**
 * The six P0 substitutions from the last critic, each now answered by a
 * template with the plan it actually runs, plus six more correct answers. The
 * expected slot chips are the plan's own arguments and nothing else.
 */
const RIGHT: Probe[] = [
  {
    question: 'How many won deals are there in total?',
    toolCalls: [{ name: 'record_aggregate', arguments: { object_type: 'deal', measure: 'count', conditions: [{ property: 'deal_stage', op: 'in', values: ['closed_won'] }] } }],
    slots: { status: 'won', stage: 'Closed won', object: 'Deal' },
    never: ['period'],
    truth: '25 — all time; the old engine injected a default period and answered 1',
  },
  {
    question: 'Who is my biggest customer?',
    toolCalls: [{ name: 'business_metric', arguments: { metric: 'closed_won', group_by: 'account', top: 1 } }],
    slots: { metric: 'Closed-won bookings', group: 'Account', limit: '1' },
    truth: 'the account with the most closed-won bookings, ranked over all 25 that have any',
  },
  {
    question: 'What have our customers been invoiced in 2026?',
    toolCalls: [{ name: 'record_aggregate', arguments: { object_type: 'invoice', measure: 'sum', start: Date.UTC(2026, 0, 1), end: Date.UTC(2027, 0, 1), window_label: '2026' } }],
    slots: { object: 'Invoice', period: '2026' },
    truth: 'billing customers, not every company in the CRM — the old engine read "our customers" as all companies, 2.4× off',
  },
  {
    question: 'Which deals are closing in the next 90 days?',
    toolCalls: [{ name: 'record_search', arguments: { object_type: 'deal', conditions: [{ property: 'deal_stage', op: 'in', values: OPEN_STAGES }], date_property: 'close_date', start: NOW, end: NOW + 90 * 86_400_000, window_label: 'the next 90 days', order_by: 'close_date', limit: 50 } }],
    slots: { status: 'open', period: 'the next 90 days', object: 'Deal', limit: '50' },
    truth: '~30 open deals; the old engine turned the bare number 90 into a filter and answered 0',
  },
  {
    question: 'Which subscriptions are on the Growth plan?',
    toolCalls: [{ name: 'record_search', arguments: { object_type: 'subscription', conditions: [{ property: 'plan', op: 'eq', value: 'growth' }], limit: 50 } }],
    remembered: {
      engine: 'template', nearest: null, template: null,
      analysis: { qualifiers: [{ kind: 'plan', text: 'Growth', state: 'bound', resolved: { value: 'growth', label: 'Growth' } }] },
    },
    slots: { plan: 'Growth' },
    truth: 'the subscriptions on Growth; the old engine listed all 35',
  },
  {
    question: 'What is our ARR?',
    toolCalls: [{ name: 'business_metric', arguments: { metric: 'arr', group_by: 'none' } }],
    slots: { metric: 'ARR', period: 'now' },
    never: ['pipeline'],
    truth: 'annualised recurring revenue; the old engine credited open pipeline',
  },
  {
    question: 'What is the open pipeline in the Renewal pipeline?',
    toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', pipeline: 'renewal', group_by: 'none' } }],
    slots: { metric: 'Open pipeline', pipeline: 'Renewal', period: 'now' },
    truth: 'the Renewal columns, as of now',
  },
  {
    question: 'How much open pipeline does Marcus Ilori own?',
    toolCalls: [{ name: 'business_metric', arguments: { metric: 'pipeline', owner_id: 'usr_seed02', group_by: 'none' } }],
    slots: { metric: 'Open pipeline', owner: 'Marcus Ilori' },
    truth: 'one teammate’s open deals',
  },
  {
    question: 'How many deals did we close in Q2 2026?',
    toolCalls: [{ name: 'record_aggregate', arguments: { object_type: 'deal', measure: 'count', conditions: [{ property: 'deal_stage', op: 'in', values: ['closed_won', 'closed_lost'] }], date_property: 'close_date', start: Q2.start, end: Q2.end, window_label: 'Q2 2026' } }],
    slots: { status: 'closed', period: 'Q2 2026', object: 'Deal' },
    truth: '8 deals closed in Q2; the old engine ANDed the open stages in and answered 0',
  },
  {
    question: 'Which support tickets need attention?',
    toolCalls: [{ name: 'record_search', arguments: { object_type: 'ticket', conditions: [{ property: 'status', op: 'in', values: ['open', 'pending'] }], order_by: 'created', limit: 20 } }],
    slots: { object: 'Ticket', limit: '20' },
    truth: 'the open and pending tickets',
  },
  {
    question: 'What is the prepaid credit balance for Brightline Foods?',
    toolCalls: [{ name: 'credits.balance', arguments: { customer: 'cus_G68fGPXpftVKfbf8' } }],
    slots: { account: 'Brightline Foods' },
    truth: 'one account’s credit ledger',
  },
  {
    question: 'How many invoices are open?',
    toolCalls: [{ name: 'record_search', arguments: { object_type: 'invoice', conditions: [{ property: 'status', op: 'eq', value: 'open' }], limit: 50 } }],
    slots: { object: 'Invoice' },
    truth: '7 open invoices',
  },
];

const TEMPLATE_RUN = { status: 'succeeded', error: null, reasoning: [], provider: 'builtin', model: 'ain-engine-1' };

const turn = (probe: Probe, over: Partial<TurnInput> = {}): TurnInput => ({
  question: probe.question,
  toolCalls: probe.toolCalls,
  run: { ...TEMPLATE_RUN, ...(probe.run ?? {}) },
  remembered: probe.remembered ?? null,
  templates: TEMPLATES,
  hosted: false,
  vocab: VOCAB,
  format: FORMAT,
  ...over,
});

describe('the card, over a corpus of correct template answers', () => {
  for (const probe of RIGHT) {
    it(`draws no banner on “${probe.question}” — ${probe.truth}`, () => {
      const card = answerCard(turn(probe));
      assert.deepEqual(card.banners, [], 'a correct answer drew a banner');
      assert.equal(card.refusal, null);
      assert.equal(card.failed, null);
      assert.equal(card.noWrite, null);
      assert.equal(card.engine, 'template');
      assert.equal(card.indicator.label, 'answered from a template');
    });

    it(`captions “${probe.question}” with the plan’s own slot values`, () => {
      const card = answerCard(turn(probe));
      const byKind = Object.fromEntries(card.slots.map((slot) => [slot.kind, slot.value]));
      for (const [kind, value] of Object.entries(probe.slots)) {
        assert.equal(byKind[kind], value, `slot ${kind}`);
      }
      for (const kind of probe.never ?? []) {
        assert.equal(kind in byKind, false, `a ${kind} slot nothing in the plan carried`);
      }
    });
  }

  it('draws no banner on any of them, in one count', () => {
    const drew = RIGHT.filter((probe) => answerCard(turn(probe)).banners.length > 0).map((probe) => probe.question);
    assert.deepEqual(drew, []);
  });

  it('is quiet where the reconciliation it replaced still cries wolf', () => {
    // The unplugged machinery, run over the same corpus with the prose a
    // template would write. It still reads the noun "customers" as the
    // Customers measure and flags an invoice total as having never measured
    // it — the false alarm the critic named. Kept as a library for the board's
    // tests; nothing on the answer path calls it.
    const PROSE: Record<string, string> = {
      'What have our customers been invoiced in 2026?': 'Northwind Robotics invoiced its customers $3,812,400 in 2026.',
    };
    const wolf = RIGHT.filter((probe) => {
      const input = { question: probe.question, prose: PROSE[probe.question] ?? '', toolCalls: [...probe.toolCalls], reasoning: ['Ran the plan.'], vocab: VOCAB, resolveId: () => null };
      const report = reconcileScope(input);
      const invented = inventedFilters({ question: probe.question, answering: report.answering, verdicts: report.verdicts, vocab: VOCAB });
      return report.unscoped.length + invented.length > 0;
    }).map((probe) => probe.question);
    assert.deepEqual(wolf, ['What have our customers been invoiced in 2026?']);
    assert.deepEqual(answerCard(turn(RIGHT[2])).banners, []);
  });

  it('says which engine answered when it was the model', () => {
    const card = answerCard(turn(RIGHT[0], {
      run: { ...TEMPLATE_RUN, provider: 'anthropic', model: 'claude-sonnet-4-5' },
      hosted: true,
    }));
    assert.equal(card.engine, 'anthropic');
    assert.equal(card.indicator.label, 'answered by the model');
    assert.equal(card.indicator.needsKey, false);
    assert.deepEqual(card.banners, []);
  });

  it('asks for a key only when there is none', () => {
    assert.equal(answerCard(turn(RIGHT[0], { hosted: false })).indicator.needsKey, true);
    assert.equal(answerCard(turn(RIGHT[0], { hosted: true })).indicator.needsKey, false);
  });

  it('still says when the run failed, and when no write was prepared — the two banners that remain', () => {
    const failed = answerCard(turn(RIGHT[0], { run: { ...TEMPLATE_RUN, status: 'failed', error: 'The database was locked.' } }));
    assert.deepEqual(failed.banners, ['failed']);
    assert.equal(failed.failed, 'The database was locked.');

    const noWrite = answerCard(turn(RIGHT[0], {
      question: 'Set the amount on the Kilbride Dairy Systems — line 3 instrumentation deal to $2,000,000',
      run: { ...TEMPLATE_RUN, reasoning: ['No write prepared: the request looks like update_record, but I could not tell which property to set — name the property and the value, e.g. "move <deal> to Negotiation".'] },
    }));
    assert.deepEqual(noWrite.banners, ['no_write']);
    assert.equal(noWrite.noWrite?.tool, 'update_record');
  });
});

/* ========================= the card on a refusal ========================= */

describe('the card on a refusal', () => {
  const REFUSED = ['Refused (question_not_covered): no template covers "vibe".'];

  it('carries the three nearest shapes the completion sent, in its order', () => {
    const card = answerCard(turn(RIGHT[0], {
      question: 'What’s the vibe with Brightline this quarter?',
      toolCalls: [],
      run: { ...TEMPLATE_RUN, reasoning: REFUSED },
      remembered: {
        engine: 'template',
        nearest: [
          { template_id: 'usage.credit_balance', example: 'What is the prepaid credit balance for Brightline Foods?' },
          { template_id: 'revenue.bookings_period', example: 'How much did we book in Q3 2026?' },
          { template_id: 'pipeline.open_total', example: 'What is our open pipeline?' },
        ],
        template: null,
      },
    }));
    assert.ok(card.refusal);
    assert.equal(card.refusal.code, 'question_not_covered');
    assert.equal(card.refusal.message, 'no template covers "vibe".');
    assert.deepEqual(card.refusal.nearest.map((chip) => chip.templateId), ['usage.credit_balance', 'revenue.bookings_period', 'pipeline.open_total']);
    assert.equal(card.refusal.matched, true);
    assert.deepEqual(card.banners, ['refused']);
    assert.deepEqual(card.slots, [], 'a refusal was captioned with slots it never bound');
  });

  it('is a refusal on the strength of `nearest` alone, when the run wrote no refusal line', () => {
    const card = answerCard(turn(RIGHT[0], {
      question: 'Anything odd this week?',
      toolCalls: [],
      run: { ...TEMPLATE_RUN, nearest: [{ template_id: 'pipeline.open_total' }] },
    }));
    assert.ok(card.refusal);
    assert.equal(card.refusal.code, 'refused');
    assert.equal(card.refusal.message, null);
    assert.deepEqual(card.refusal.nearest, [{ templateId: 'pipeline.open_total', question: 'What is our open pipeline?' }]);
  });

  it('ranks the whitelist itself for a turn read back with no `nearest` in hand', () => {
    const card = answerCard(turn(RIGHT[0], {
      question: 'How many won deals in total please',
      toolCalls: [],
      run: { ...TEMPLATE_RUN, reasoning: REFUSED },
    }));
    assert.ok(card.refusal);
    assert.equal(card.refusal.nearest.length, 3);
    assert.equal(card.refusal.nearest[0].templateId, 'pipeline.won_count');
    assert.equal(card.refusal.matched, true);
  });
});

/* ====================== slot chips, read off the plan ==================== */

describe('the slot chips are read off the plan, never off the wording', () => {
  it('reads a window, an owner, a pipeline and a status out of the arguments', () => {
    const chips = slotChipsFromPlan([{
      name: 'record_aggregate',
      arguments: {
        object_type: 'deal', measure: 'sum', pipeline: 'renewal', owner_id: 'usr_seed02',
        conditions: [{ property: 'deal_stage', op: 'in', values: OPEN_STAGES }],
        start: Q2.start, end: Q2.end,
      },
    }], VOCAB, FORMAT);
    assert.deepEqual(chips.map((chip) => `${chip.kind}=${chip.value}`), [
      'period=2026-04-01 – 2026-06-30', 'pipeline=Renewal', 'status=open', 'owner=Marcus Ilori', 'object=Deal',
    ]);
  });

  it('states a snapshot measure as of now, whatever window it was handed', () => {
    const chips = slotChipsFromPlan([{ name: 'business_metric', arguments: { metric: 'pipeline', start: Q2.start, end: Q2.end, group_by: 'none' } }], VOCAB, FORMAT);
    assert.deepEqual(chips.map((chip) => `${chip.kind}=${chip.value}`), ['metric=Open pipeline', 'period=now']);
  });

  it('draws nothing for a write, whose arguments name a target rather than a scope', () => {
    assert.deepEqual(slotChipsFromPlan([{ name: 'update_record', arguments: { object_type: 'deal', id: 'deal_nw_15', properties: { deal_stage: 'negotiation' } } }], VOCAB, FORMAT), []);
  });

  it('prefers a binding the run states outright', () => {
    const binding = bindingOf({ template: { id: 'pipeline.won_count', slots: { period: 'Q3 2026', owner: null } } });
    assert.deepEqual(binding, { id: 'pipeline.won_count', slots: { period: 'Q3 2026', owner: null } });
    const chips = slotChips({ binding, toolCalls: RIGHT[0].toolCalls, vocab: VOCAB, format: FORMAT });
    assert.deepEqual(chips, [{ kind: 'period', label: 'Period', value: 'Q3 2026' }]);
  });

  it('reads the engine’s own qualifier ledger as a binding, bound entries only', () => {
    const binding = bindingOf({
      analysis: {
        qualifiers: [
          { kind: 'period', text: 'Q3 2026', state: 'bound', resolved: { label: 'Q3 2026' } },
          { kind: 'owner', text: 'Marcus', state: 'bound', resolved: { value: 'usr_seed02', label: 'Marcus Ilori' } },
          { kind: 'stage', text: 'red lines', state: 'refused', resolved: null },
        ],
      },
    });
    assert.deepEqual(binding?.slots, { period: 'Q3 2026', owner: 'Marcus Ilori' });
    assert.equal(bindingOf({ analysis: { qualifiers: [] } }), null);
    assert.equal(bindingOf({ template: 'pipeline.won_count' }), null);
    assert.equal(bindingOf(null), null);
  });

  it('falls back to the plan’s calls when nothing states a binding', () => {
    const chips = slotChips({ binding: null, toolCalls: RIGHT[7].toolCalls, vocab: VOCAB, format: FORMAT });
    assert.equal(chips.find((chip) => chip.kind === 'owner')?.value, 'Marcus Ilori');
  });
});

/* ======================== the surface, rendered ========================== */

/** Every element in a tree that satisfies `pred` — host elements only, as written. */
function findAll(node: ReactNode, pred: (el: ReactElement) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) { for (const child of node) findAll(child, pred, out); return out; }
  if (!isValidElement(node)) return out;
  if (pred(node)) out.push(node);
  findAll((node.props as { children?: ReactNode }).children, pred, out);
  return out;
}

const hostWith = (attr: string) => (el: ReactElement) =>
  typeof el.type === 'string' && (el.props as Record<string, unknown>)[attr] !== undefined;

describe('the surface, rendered', () => {
  const { TemplatePanel, TemplateStarters } = ui.templates;
  const { EngineIndicator, RefusalHelp, SlotChips } = ui.card;

  it('renders the panel from the endpoint’s rows, grouped, every shape pressable', () => {
    const html = renderToStaticMarkup(createElement(TemplatePanel, { groups: groupTemplates(TEMPLATES), onAsk: () => undefined }));
    for (const label of ['Revenue', 'Pipeline', 'Customers', 'Usage', 'People']) assert.ok(html.includes(label), label);
    for (const row of TEMPLATES) assert.ok(html.includes(row.example), row.example);
    assert.equal((html.match(/data-template-id=/g) ?? []).length, TEMPLATES.length);
    assert.doesNotMatch(html, /Everything else/);
  });

  it('asks the example when a shape is pressed', () => {
    const asked: string[] = [];
    const tree = TemplatePanel({ groups: groupTemplates(TEMPLATES), onAsk: (q) => asked.push(q) });
    const buttons = findAll(tree, hostWith('data-template-id'));
    assert.equal(buttons.length, TEMPLATES.length);
    const growth = buttons.find((el) => (el.props as { 'data-template-id': string })['data-template-id'] === 'customers.on_plan');
    (growth!.props as { onClick: () => void }).onClick();
    assert.deepEqual(asked, ['Which subscriptions are on the Growth plan?']);
  });

  it('quotes the filter in the empty state rather than showing nothing', () => {
    const html = renderToStaticMarkup(createElement(TemplatePanel, { groups: [], onAsk: () => undefined, query: 'xyzzy', total: TEMPLATES.length }));
    assert.match(html, /None of the 16 shapes mention “xyzzy”/);
  });

  it('opens an empty thread with five starters and the way to the rest', () => {
    const html = renderToStaticMarkup(createElement(TemplateStarters, {
      templates: starterTemplates(TEMPLATES, 5), total: TEMPLATES.length, onAsk: () => undefined, onSeeAll: () => undefined,
    }));
    assert.equal((html.match(/cp-suggest__item/g) ?? []).length, 5);
    assert.match(html, /See all 16 questions it can answer/);
  });

  it('renders a refusal’s nearest shapes as chips, and pressing one asks it', () => {
    const refusal = answerCard(turn(RIGHT[0], {
      question: 'How many won deals in total please',
      toolCalls: [],
      run: { ...TEMPLATE_RUN, reasoning: ['Refused (question_not_covered): no template covers that wording.'] },
    })).refusal!;
    const html = renderToStaticMarkup(createElement(RefusalHelp, { refusal, onAsk: () => undefined, onSeeAll: () => undefined }));
    assert.equal((html.match(/cp-help__chip/g) ?? []).length, 3);
    assert.match(html, /Closest questions it can answer/);
    assert.match(html, /See everything it can answer/);

    const asked: string[] = [];
    const tree = RefusalHelp({ refusal, onAsk: (q) => asked.push(q) });
    const chips = findAll(tree, (el) => typeof el.type === 'string' && (el.props as { className?: string }).className === 'cp-help__chip');
    (chips[0].props as { onClick: () => void }).onClick();
    assert.deepEqual(asked, ['How many won deals are there in total?']);
  });

  it('labels chips that overlapped nothing as some questions, not the closest', () => {
    const refusal = { code: 'refused', message: null, matched: false, nearest: nearestTemplates('xyzzy', TEMPLATES).chips };
    const html = renderToStaticMarkup(createElement(RefusalHelp, { refusal, onAsk: () => undefined }));
    assert.match(html, /Some questions it can answer/);
  });

  it('says which engine answered, and with no key, where to get one', () => {
    const open: string[] = [];
    const noKey = renderToStaticMarkup(createElement(EngineIndicator, { line: engineLine('template', false), onOpen: (href) => open.push(href) }));
    assert.match(noKey, /answered from a template/);
    assert.match(noKey, /Settings › API keys/);
    assert.match(noKey, /href="\/settings\/api-keys"/);
    assert.match(noKey, /data-engine="template"/);

    const keyed = renderToStaticMarkup(createElement(EngineIndicator, { line: engineLine('template', true), onOpen: () => undefined }));
    assert.doesNotMatch(keyed, /Settings › API keys/);

    const model = renderToStaticMarkup(createElement(EngineIndicator, { line: engineLine('anthropic', true, 'claude-sonnet-4-5'), onOpen: () => undefined }));
    assert.match(model, /answered by the model/);
    assert.match(model, /data-engine="anthropic"/);
    assert.doesNotMatch(model, /Settings › API keys/);
  });

  it('draws one calm chip per bound slot, and nothing when nothing was bound', () => {
    const html = renderToStaticMarkup(createElement(SlotChips, { slots: answerCard(turn(RIGHT[6])).slots }));
    assert.equal((html.match(/data-slot=/g) ?? []).length, 3);
    assert.match(html, /Renewal/);
    assert.doesNotMatch(html, /is-wide|unchecked|ain-banner/);
    assert.equal(renderToStaticMarkup(createElement(SlotChips, { slots: [] })), '');
  });
});

/* ====================== what the engine says it refused ================== */

describe('a refusal in the engine’s own words', () => {
  it('is read off either shape of the refusal line', () => {
    assert.deepEqual(
      refusalOf({ reasoning: ['Refused (question_not_covered): 1 token unaccounted for: "before".'] }),
      { code: 'question_not_covered', message: '1 token unaccounted for: "before".' },
    );
    assert.deepEqual(
      refusalOf({ reasoning: ['Refused after the run (qualifier_unbound): period "today".'] }),
      { code: 'qualifier_unbound', message: 'period "today".' },
    );
    assert.equal(refusalOf({ reasoning: ['Ran business_metric in 9ms → $9,010,960 (38 open deals).'] }), null);
    assert.equal(refusalOf(null), null);
  });
});

/* ============ P0 · a write prepared against a sibling record ============== */

/**
 * The sweep, run against the live engine on a freshly seeded workspace.
 *
 * Every account here holds two or more open deals. Each row is the question
 * asked with that deal's own display name, and the record the engine actually
 * prepared the write against — read out of the approval row's `preview[0]`,
 * which is the only name a person approving the card can see. Seven of the
 * fourteen were prepared against a sibling.
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
    const falseAlarms = SIBLING_SWEEP
      .filter((row) => !row.misTargeted && recordPhraseMismatch(row.question, row.prepared))
      .map((row) => row.question);
    assert.deepEqual(falseAlarms, [], 'a correct write was gated behind a red banner');
  });

  it('names the deal the question named, not the one the engine resolved', () => {
    const mismatch = recordPhraseMismatch(
      'Move the Pemberton Auto Systems pilot expansion to 3 lines deal to Proposal',
      'Pemberton Auto Systems — first pilot attempt',
    );
    assert.ok(mismatch, 'the write that resurrected a closed-lost deal was not gated');
    assert.equal(mismatch.asked, 'Pemberton Auto Systems pilot expansion to 3 lines');
    assert.equal(mismatch.used, 'Pemberton Auto Systems — first pilot attempt');
  });

  it('leaves a partial mention, a set narrowed by a word, and a note alone', () => {
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

describe('the record a note or a task would land on', () => {
  it('is read off the "Linked to" line of a task, wherever it sits', () => {
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

  it('counts a run that answered nothing as refused, not succeeded', () => {
    assert.equal(runOutcome({ status: 'succeeded', reasoning: ['Refused (question_not_covered): no template covers that.'] }, []), 'refused');
  });
});

describe('the badge on a decided write', () => {
  const failed: Pick<AiApproval, 'status' | 'outcome'> = {
    status: 'approved',
    outcome: 'Failed: "commercial_terms" belongs to the Renewal pipeline, not New business.',
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

/* ========= P0 · approving a one-line stage change reopens a deal ========== */

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

/** `deal_nw_15` — Pemberton Auto Systems — first pilot attempt: closed lost at $223,440. */
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
    assert.equal(c.pipelineDelta, 22_344_000);
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
    assert.equal(noWritePrepared({ reasoning: ['No write prepared: the request looks like update_record, but this run is read-only.'] }), null);
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
    assert.equal(dealNamedIn('Compare Kilbride Dairy Systems — line 3 instrumentation with Kilbride Dairy Systems — line 2 monitoring', deals), null);
  });

  it('links to the deal record with the group that holds the property', () => {
    assert.equal(editHref('deal_nw_46', 'Deal information'), '/deals/deal_nw_46?edit=Deal%20information');
    assert.equal(editHref('deal_nw_46', ''), '/deals/deal_nw_46?edit=1');
  });
});

/* ========== P0 · a dunning draft that states no money is owed ============= */

/**
 * Brightline Foods, `cmp_nw_04`, billing customer `cus_G68fGPXpftVKfbf8`.
 *
 * `GET /v1/invoices?status=open_like` holds NR-000032 for $127,840, due
 * 2026-07-08 — 56 days before the workspace clock.
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

  it('refuses the draft that declares $127,840 of 56-day-old debt paid — because it names no invoice', () => {
    // Mechanically, not by recognising the sentence: a chase on an account
    // with money due has to name one of its invoices, and this one names none.
    const verdict = checkDunning(DEAL_ID_DRAFT, BRIGHTLINE_LEDGER);
    assert.equal(verdict.state, 'contradicted');
    assert.match(verdict.state === 'contradicted' ? verdict.why : '', /names none of the invoice still due/);
    assert.match(verdict.state === 'contradicted' ? verdict.why : '', /NR-000032/);
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
    const verdict = checkDunning(ACCOUNT_DRAFT, clean);
    assert.equal(verdict.state, 'contradicted');
    assert.match(verdict.state === 'contradicted' ? verdict.why : '', /\$127,840\.00/);
    // The engine's own "nothing to chase" is the truth for that account.
    assert.deepEqual(checkDunning(DEAL_ID_DRAFT, clean), { state: 'ok' });
  });

  it('composes a chase from the account and everything else from the deal', () => {
    assert.equal(draftsFromAccount('dunning'), true);
    assert.equal(draftsFromAccount('follow_up'), false);
  });
});

/* ===== P0 · the guarantee the draft surface prints about money ============ */

/**
 * The banner over the ledger read-out promises the letter is checked before
 * it can be logged. Every letter below is the account draft with one edit in
 * it, and the old check let three shapes of edit through: a figure with no
 * currency glyph, a code where the glyph would be, and an invoice number in
 * the wrong case. The check is now mechanical and the banner says exactly
 * what it does — and what it does not.
 */
const EDITED = {
  wrongInvoice: {
    subject: 'Invoice NR-000099 for Brightline Foods — $127,840.00 outstanding',
    body: 'Hi Marlene,\n\nInvoice NR-000099 for $127,840.00 is still outstanding, due Jul 8, 2026 — 56 days ago.',
  },
  wrongAmount: {
    subject: 'Invoice NR-000032 for Brightline Foods — $127,480.00 outstanding',
    body: 'Hi Marlene,\n\nInvoice NR-000032 for $127,480.00 is still outstanding, due Jul 8, 2026 — 56 days ago.',
  },
  inventedLine: {
    subject: 'Invoice NR-000032 for Brightline Foods — $127,840.00 outstanding',
    body: 'Hi Marlene,\n\nInvoice NR-000032 for $127,840.00 is still outstanding, due Jul 8, 2026 — 56 days ago.'
      + '\n\nLate interest of $4,200.00 has been added to the account.',
  },
  /** The glyph deleted: the figure is still a claim about money. */
  bareDecimal: {
    subject: 'Invoice NR-000032 for Brightline Foods',
    body: 'Hi Marlene,\n\nInvoice NR-000032 for 127,480.00 is still outstanding, due Jul 8, 2026 — 56 days ago.',
  },
  /** A code where the glyph would be, in whichever case the reader typed it. */
  codeBefore: {
    subject: 'Invoice NR-000032 for Brightline Foods',
    body: 'Invoice NR-000032 for USD 127,480.00 is still outstanding.',
  },
  codeAfter: {
    subject: 'Invoice NR-000032 for Brightline Foods',
    body: 'Invoice NR-000032 for 127,480.00 usd is still outstanding.',
  },
  /** The invoice number lower-cased, and wrong. */
  lowerCaseWrong: {
    subject: 'Invoice NR-000032 for Brightline Foods — $127,840.00 outstanding',
    body: 'Invoice nr-000099 for $127,840.00 is still outstanding.',
  },
  /** The invoice number lower-cased, and right. */
  lowerCaseRight: {
    subject: 'Your account with Northwind',
    body: 'Invoice nr-000032 for $127,840.00 is still outstanding.',
  },
};

describe('the one guarantee the draft surface prints about money', () => {
  it('checks the letter that will be logged, not the letter that arrived', () => {
    const honest = chaseVerdict('dunning', ACCOUNT_DRAFT, ACCOUNT_DRAFT, BRIGHTLINE_LEDGER);
    assert.deepEqual(honest, { state: 'ok' });
    const tampered = chaseVerdict('dunning', ACCOUNT_DRAFT, EDITED.wrongInvoice, BRIGHTLINE_LEDGER);
    assert.equal(tampered?.state, 'contradicted');
  });

  it('names the figure the edit invented, and what the ledger holds against it', () => {
    const verdict = chaseVerdict('dunning', ACCOUNT_DRAFT, EDITED.wrongAmount, BRIGHTLINE_LEDGER);
    assert.equal(verdict?.state, 'contradicted');
    const why = verdict.state === 'contradicted' ? verdict.why : '';
    assert.match(why, /\$127,480\.00/, 'the figure the reader typed, in their own words');
    assert.match(why, /NR-000032/, 'the invoice it was meant to be');
    assert.match(why, /\$127,840\.00/, 'what the ledger actually holds');
  });

  it('reads a figure with no currency sign as money — the edit that used to pass', () => {
    const verdict = chaseVerdict('dunning', ACCOUNT_DRAFT, EDITED.bareDecimal, BRIGHTLINE_LEDGER);
    assert.equal(verdict?.state, 'contradicted');
    assert.match(verdict.state === 'contradicted' ? verdict.why : '', /127,480\.00/);
    assert.deepEqual(
      figuresIn('127,480.00 is outstanding', ['usd']),
      [{ text: '127,480.00', digits: '127,480.00', currency: null }],
    );
  });

  it('reads a currency code on either side of the number, whatever its case', () => {
    assert.equal(chaseVerdict('dunning', ACCOUNT_DRAFT, EDITED.codeBefore, BRIGHTLINE_LEDGER)?.state, 'contradicted');
    assert.equal(chaseVerdict('dunning', ACCOUNT_DRAFT, EDITED.codeAfter, BRIGHTLINE_LEDGER)?.state, 'contradicted');
    const right = { subject: 'Invoice NR-000032', body: 'Invoice NR-000032 for usd 127,840.00 is still outstanding.' };
    assert.deepEqual(chaseVerdict('dunning', ACCOUNT_DRAFT, right, BRIGHTLINE_LEDGER), { state: 'ok' });
    // A month is three letters too, and is not a book.
    assert.deepEqual(figuresIn('due 8 Jul 2026, 56 days ago', ['usd']), []);
  });

  it('reads an invoice number whatever its case', () => {
    const wrong = chaseVerdict('dunning', ACCOUNT_DRAFT, EDITED.lowerCaseWrong, BRIGHTLINE_LEDGER);
    assert.equal(wrong?.state, 'contradicted');
    assert.match(wrong.state === 'contradicted' ? wrong.why : '', /NR-000099/);
    assert.deepEqual(chaseVerdict('dunning', ACCOUNT_DRAFT, EDITED.lowerCaseRight, BRIGHTLINE_LEDGER), { state: 'ok' });
    assert.deepEqual(invoiceNumbersIn('nr-000099 and NR-000099 and Nr-000032', BRIGHTLINE_LEDGER.bills), ['NR-000099', 'NR-000032']);
  });

  it('refuses a body that chases an invoice the subject line does not', () => {
    const split = { subject: ACCOUNT_DRAFT.subject, body: ACCOUNT_DRAFT.body.replace('NR-000032', 'NR-000099') };
    const verdict = chaseVerdict('dunning', ACCOUNT_DRAFT, split, BRIGHTLINE_LEDGER);
    assert.equal(verdict?.state, 'contradicted');
    const why = verdict.state === 'contradicted' ? verdict.why : '';
    assert.match(why, /NR-000099/);
    assert.match(why, /NR-000032/);
  });

  it('refuses a figure added to an otherwise true letter', () => {
    const verdict = chaseVerdict('dunning', ACCOUNT_DRAFT, EDITED.inventedLine, BRIGHTLINE_LEDGER);
    assert.equal(verdict?.state, 'contradicted');
    assert.match(verdict.state === 'contradicted' ? verdict.why : '', /\$4,200\.00/);
  });

  it('lets the total stand beside the invoices it is the total of', () => {
    const meridian = ledgerFrom([
      { number: 'NR-000339', amount_due: 276_000, currency: 'usd', due_date: Date.UTC(2026, 9, 3), status: 'open' },
      { number: 'NR-000338', amount_due: 230_000, currency: 'usd', due_date: Date.UTC(2026, 9, 3), status: 'open' },
    ], Date.UTC(2026, 8, 2));
    const summed = {
      subject: 'Two invoices for Meridian Forge Systems — $5,060.00 outstanding',
      body: 'NR-000339 for $2,760.00 and NR-000338 for $2,300.00 are still outstanding — 5,060.00 in all.',
    };
    assert.deepEqual(chaseVerdict('dunning', summed, summed, meridian), { state: 'ok' });
  });

  it('reads a figure in the book it is written in, and a whole number as no figure at all', () => {
    const ledger = ledgerFrom(
      [{ number: 'NR-000138', amount_due: 91_800, currency: 'eur', due_date: null, status: 'open' }],
      Date.UTC(2026, 8, 2),
    );
    // 6,400 employees and 848 assets are facts the engine puts in a draft. A
    // whole number is not read as money — and the banner says so.
    assert.deepEqual(figuresIn('€918.00 across 6,400 employees and 848 assets', ['eur']), [
      { text: '€918.00', digits: '918.00', currency: 'eur' },
    ]);
    const chase = {
      subject: 'Invoice NR-000138 — €918.00 outstanding',
      body: 'Västerö Industriteknik runs 848 connected assets across 6,400 employees. Invoice NR-000138 for €918.00 is still due.',
    };
    assert.deepEqual(chaseVerdict('dunning', chase, chase, ledger), { state: 'ok' });
    // The same amount in the wrong book is not the amount on the ledger.
    const wrongBook = { ...chase, body: chase.body.replace('€918.00', '$918.00') };
    assert.equal(chaseVerdict('dunning', chase, wrongBook, ledger)?.state, 'contradicted');
    // A percentage and a dotted date are not money either.
    assert.deepEqual(figuresIn('a 2.5% fee on 8.7.2026 at 10.30am', ['eur']), []);
  });

  it('refuses a money figure put to an account that owes nothing', () => {
    const clean = ledgerFrom([], Date.UTC(2026, 8, 2));
    const chase = { subject: 'Your account', body: 'You still owe 12,000.00 on the account.' };
    const verdict = chaseVerdict('dunning', chase, chase, clean);
    assert.equal(verdict?.state, 'contradicted');
    assert.match(verdict.state === 'contradicted' ? verdict.why : '', /12,000\.00/);
  });

  it('says nothing at all about the kinds that are not claims about a ledger', () => {
    const followUp = { subject: 'Next step', body: 'The predictive maintenance add-on is $315,900.' };
    assert.equal(chaseVerdict('follow_up', followUp, followUp, BRIGHTLINE_LEDGER), null);
    assert.equal(chaseVerdict('dunning', null, { subject: '', body: '' }, BRIGHTLINE_LEDGER), null);
  });

  it('gates the Log button and the mutation on the same answer', () => {
    assert.deepEqual(canLog('dunning', ACCOUNT_DRAFT, ACCOUNT_DRAFT, BRIGHTLINE_LEDGER), { ok: true });
    const blocked = canLog('dunning', ACCOUNT_DRAFT, EDITED.wrongAmount, BRIGHTLINE_LEDGER);
    assert.equal(blocked.ok, false);
    assert.match(blocked.ok ? '' : blocked.why, /\$127,480\.00/);
    assert.equal(canLog('dunning', ACCOUNT_DRAFT, { subject: 'x', body: '   ' }, BRIGHTLINE_LEDGER).ok, false);
    assert.equal(canLog('dunning', ACCOUNT_DRAFT, ACCOUNT_DRAFT, { ...EMPTY_LEDGER, why: 'unread' }).ok, false);
    assert.deepEqual(canLog('follow_up', null, { subject: '', body: 'See you Tuesday.' }, EMPTY_LEDGER), { ok: true });
  });

  it('promises exactly what it checks, and states what it does not', () => {
    const promise = ledgerPromise();
    assert.equal(LEDGER_PROMISE.checks.length, 2);
    assert.match(promise, /edits included/);
    assert.match(promise, /whatever its case/);
    assert.match(promise, /currency sign or code/);
    assert.match(promise, /written with decimals/);
    assert.match(promise, /whole number .* is not read as money/);
    assert.match(promise, /words around a figure are not read at all/);
  });

  it('does not pretend to read the sentence around a figure', () => {
    // The right invoice at the right amount, declared settled. No rule here
    // reads that sentence, so the letter passes — and the banner says that
    // reading it is the person's job, rather than claiming a word list would
    // have caught it.
    const settled = {
      subject: 'Invoice NR-000032 — settled',
      body: 'Invoice NR-000032 for $127,840.00 is settled in full; nothing further is owed.',
    };
    assert.deepEqual(chaseVerdict('dunning', ACCOUNT_DRAFT, settled, BRIGHTLINE_LEDGER), { state: 'ok' });
    assert.match(LEDGER_PROMISE.limit, /owed or settled is yours to check/);
  });
});
