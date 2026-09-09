/**
 * The billing screens' own logic: what they say after a write, and when they
 * are allowed to say it.
 *
 * Every function here is pure and runs without a browser. The rule under test
 * is the one Stripe keeps — nothing on screen claims money moved until the
 * record says it did — so each case hands the copy the record as the API
 * returns it and checks the sentence against that record alone.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  balanceDrawn, collectionSettled, couponBody, couponCeilingWords, couponDraftBlocker, couponDurationWords,
  couponRedemptionWords, couponScopeWords, couponStanding, coversNoPeriod, creditNoteRouting, describeAppliedChange,
  describeCreatedSubscription, describeDelete, firstInvoiceSettled, humaniseNote, nextInvoicePricedOn, nextInvoiceRows,
  phaseGoverning, phaseLines, phasePreviewItems, phaseSummary, pluraliseBrackets, promotionCodeRestrictionWords,
  scheduledUpcoming, type CouponDraft, type PhaseWindow,
} from '../src/client/modules/billing/copy';
import { buildSources, hitsFrom } from '../src/client/kernel/search-core';
import { statusLabel } from '../src/client/design/status-core';
import type {
  ChangePreview, Invoice, NextInvoiceEstimate, RecurringLine, Subscription,
} from '../src/client/modules/billing/types';

const f = {
  money: (amount: number, currency: string) => `${currency.toUpperCase()} ${(amount / 100).toFixed(2)}`,
  day: (ts: number) => new Date(ts).toISOString().slice(0, 10),
};

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 5);

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  object: 'invoice', id: 'in_1', number: 'NR-000345', sequence: 345, customer: 'cus_1', subscription: 'sub_1',
  status: 'open', billing_reason: 'subscription_create', currency: 'usd', collection_method: 'charge_automatically',
  period: { start: NOW, end: NOW + 30 * DAY }, arrears_period: null, lines: [], subtotal: 9900, tax: 0, total_taxes: [],
  balance_applied: 0, total: 9900, total_excluding_tax: 9900, amount_paid: 0, amount_due: 9900, amount_refunded: 0,
  pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, starting_balance: 0, ending_balance: 0,
  due_date: null, finalized_at: NOW, paid_at: null, voided_at: null, marked_uncollectible_at: null, payment_note: null,
  footer: null, description: null, created: NOW, customer_name: 'Critic Test Co', subtotal_display: '$99.00',
  tax_display: '$0.00', total_display: '$99.00', amount_due_display: '$99.00', balance_applied_display: '$0.00',
  period_display: 'Sep 5, 2026 to Oct 5, 2026', status_detail: 'Owed, payable on receipt.', document_url: '/v1/invoices/in_1/render',
  reconciles: true, ...over,
});

const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  object: 'subscription', id: 'sub_1', customer: 'cus_1', status: 'active', items: [], currency: 'usd', interval: 'month',
  interval_count: 1, billing_cycle_anchor: NOW, billing_cycle_anchor_day: 5, current_period_start: NOW,
  current_period_end: NOW + 30 * DAY, start_date: NOW, ended_at: null, canceled_at: null, cancel_at: null,
  cancel_at_period_end: false, cancellation_reason: null, cancellation_comment: null, trial_start: null, trial_end: null,
  collection_method: 'charge_automatically', days_until_due: null, default_payment_method: null, pause_collection: null,
  proration_behavior: 'create_prorations', schedule: null, description: null, metadata: {}, created: NOW,
  recurring_subtotal: 9900, mrr: 9900, status_detail: 'Billing normally on its cycle.', next_status_options: [],
  interval_display: 'month', latest_invoice: invoice(), ...over,
});

const preview = (over: Partial<ChangePreview> = {}): ChangePreview => ({
  object: 'subscription_change_preview', subscription: 'sub_1', customer: 'cus_1', currency: 'usd', proration_date: NOW,
  proration_behavior: 'always_invoice', current_period: { start: NOW - 2 * DAY, end: NOW + 28 * DAY },
  next_period: { start: NOW - 2 * DAY, end: NOW + 28 * DAY }, interval_before: { interval: 'month', interval_count: 1 },
  interval_after: { interval: 'month', interval_count: 1 },
  lines: [{
    object: 'proration_line', kind: 'remaining_time', description: '4 more seats', explanation: 'x', subscription: 'sub_1',
    subscription_item: 'si_1', price: 'price_1', quantity: 4, amount: 10790, currency: 'usd',
    period: { start: NOW, end: NOW + 28 * DAY }, proration: { numerator: 1, denominator: 1 }, proration_date: NOW, breakdown: [],
  }],
  credit_total: 0, charge_total: 10790, net: 10790, amount_due_now: 0, customer_balance: -25000,
  next_invoice: { date: NOW + 28 * DAY, currency: 'usd', subtotal: 0, lines: [] }, items_after: [],
  mrr_before: 100000, mrr_after: 110790, mrr_delta: 10790, notices: [], ...over,
});

/* ------------------------------ a new subscription ------------------------ */

describe('the first invoice of a new subscription', () => {
  it('is not settled while the collector has yet to present it', () => {
    // `POST /v1/subscriptions` answers exactly this: active, first bill open on a card.
    assert.equal(firstInvoiceSettled(subscription()), false);
  });

  it('is settled once the issuer has answered either way', () => {
    assert.equal(firstInvoiceSettled(subscription({ status: 'past_due' })), true);
    assert.equal(firstInvoiceSettled(subscription({ latest_invoice: invoice({ status: 'paid', amount_due: 0, amount_paid: 9900 }) })), true);
  });

  it('has nothing to wait for on a trial, a transfer, or a bill the balance covered', () => {
    assert.equal(firstInvoiceSettled(subscription({ status: 'trialing', latest_invoice: null })), true);
    // The brief record on the subscription carries no collection method; the subscription's own decides.
    assert.equal(firstInvoiceSettled(subscription({ collection_method: 'send_invoice' })), true);
    assert.equal(firstInvoiceSettled(subscription({ latest_invoice: invoice({ amount_due: 0 }) })), true);
  });
});

describe('what the screen says about a subscription it just created', () => {
  it('never claims the first period is billed over a declined card', () => {
    const declined = subscription({
      status: 'past_due',
      status_detail: 'The latest invoice failed. Dunning is retrying it.',
    });
    const copy = describeCreatedSubscription(declined, f, invoice(), {
      summary: 'Nothing has been collected against NR-000345 yet. $99.00 is owed and can be presented now.',
      collectable_note: null,
    });
    assert.equal(copy.tone, 'warning');
    assert.match(copy.title, /declined/);
    assert.match(copy.description, /NR-000345 for USD 99\.00 is still owed/);
    assert.match(copy.description, /Nothing has been collected against NR-000345 yet/);
    assert.doesNotMatch(copy.description, /open and billed/);
    assert.doesNotMatch(copy.title, /^Subscription created$/);
  });

  it('says a paid first bill was collected, and from what', () => {
    const bill = invoice({ status: 'paid', amount_due: 0, amount_paid: 9900, paid_at: NOW });
    const paid = subscription({ latest_invoice: bill });
    const copy = describeCreatedSubscription(paid, f, bill);
    assert.equal(copy.tone, 'success');
    assert.equal(copy.title, 'Subscription created');
    assert.match(copy.description, /NR-000345 for USD 99\.00 was raised and collected from the method on file/);
    assert.match(copy.description, /USD 99\.00 a month of recurring revenue/);
  });

  it('says a bill settled from the balance was settled from the balance', () => {
    const bill = invoice({ status: 'paid', amount_due: 0, amount_paid: 0, balance_applied: -9900, total: 0 });
    const covered = subscription({ latest_invoice: bill });
    assert.match(describeCreatedSubscription(covered, f, bill).description, /settled from the account balance/);
    // Without the full record nothing is claimed about what paid it.
    assert.match(describeCreatedSubscription(covered, f).description, /NR-000345 for USD 0\.00 was raised and settled\./);
  });

  it('describes a bill sent for transfer by its due date, not as collected', () => {
    const bill = invoice({ collection_method: 'send_invoice', due_date: NOW + 30 * DAY });
    const sent = subscription({ collection_method: 'send_invoice', latest_invoice: bill });
    const copy = describeCreatedSubscription(sent, f, bill);
    assert.match(copy.description, /paid by transfer — due 2026-10-05/);
    assert.doesNotMatch(copy.description, /collected/);
  });

  it('says nothing has been collected on a bill the collector has not answered', () => {
    const copy = describeCreatedSubscription(subscription(), f, invoice(), { summary: 'Nothing has been collected yet.', collectable_note: 'No method is on file to present it to.' });
    assert.equal(copy.tone, 'info');
    assert.match(copy.title, /nothing collected yet/);
    assert.match(copy.description, /No method is on file/);
  });

  it('describes a trial as unbilled until the trial ends', () => {
    const copy = describeCreatedSubscription(subscription({ status: 'trialing', trial_end: NOW + 14 * DAY, latest_invoice: null }), f);
    assert.equal(copy.description, 'The trial runs until 2026-09-19; nothing has been billed yet.');
  });
});

/* ----------------------------- a changed subscription --------------------- */

describe('what the screen says after a change is applied', () => {
  it('names the invoice an immediate bill raised, and the balance that paid it', () => {
    const raised = invoice({
      number: 'NR-000342', billing_reason: 'subscription_update', status: 'paid', subtotal: 10790, tax: 0,
      balance_applied: -10790, total: 0, amount_paid: 0, amount_due: 0, starting_balance: -25000, ending_balance: -14210,
    });
    const copy = describeAppliedChange(preview(), 'always_invoice', raised, f);
    assert.equal(copy.tone, 'success');
    assert.equal(
      copy.description,
      'NR-000342 for USD 107.90 was raised now and paid from the USD 250.00 account balance, leaving USD 142.10 of credit.',
    );
    assert.doesNotMatch(copy.description, /waiting on the next invoice/);
  });

  it('says what was collected when a card paid the immediate bill', () => {
    const raised = invoice({ number: 'NR-000342', billing_reason: 'subscription_update', status: 'paid', subtotal: 10790, total: 10790, amount_paid: 10790, amount_due: 0 });
    const copy = describeAppliedChange(preview({ amount_due_now: 10790, customer_balance: 0 }), 'always_invoice', raised, f);
    assert.match(copy.description, /NR-000342 for USD 107\.90 was raised now and USD 107\.90 was collected/);
  });

  it('warns when the immediate bill was declined instead of pretending it was waiting', () => {
    const raised = invoice({ number: 'NR-000342', billing_reason: 'subscription_update', status: 'open', subtotal: 10790, total: 10790, amount_due: 10790 });
    const copy = describeAppliedChange(preview({ amount_due_now: 10790, customer_balance: 0 }), 'always_invoice', raised, f);
    assert.equal(copy.tone, 'warning');
    assert.match(copy.title, /declined/);
    assert.match(copy.description, /NR-000342 for USD 107\.90 was raised now and is still owed/);
  });

  it('says a proration waits only when the behaviour actually makes it wait', () => {
    const copy = describeAppliedChange(preview({ proration_behavior: 'create_prorations' }), 'create_prorations', null, f);
    assert.match(copy.description, /USD 107\.90 of proration is priced and waits for the next invoice on 2026-10-03/);
    const credit = describeAppliedChange(preview({ proration_behavior: 'create_prorations', net: -5000 }), 'create_prorations', null, f);
    assert.match(credit.description, /USD 50\.00 of credit/);
  });

  it('says nothing was prorated when proration was switched off', () => {
    const copy = describeAppliedChange(preview({ proration_behavior: 'none' }), 'none', null, f);
    assert.match(copy.description, /Nothing was prorated — the new price starts at the next renewal on 2026-10-03/);
  });

  it('does not claim an invoice was raised when none came back', () => {
    const copy = describeAppliedChange(preview(), 'always_invoice', invoice({ billing_reason: 'subscription_cycle' }), f);
    assert.equal(copy.tone, 'info');
    assert.match(copy.description, /No invoice for it has been raised yet/);
  });

  it('knows when an immediate bill still has a collector to wait for', () => {
    assert.equal(collectionSettled(invoice()), false);
    assert.equal(collectionSettled(invoice({ status: 'paid' })), true);
    assert.equal(collectionSettled(invoice({ collection_method: 'send_invoice' })), true);
  });
});

/* -------------------------- the balance in the preview -------------------- */

describe('the credit an immediate bill would draw', () => {
  it('is the gap between what the change costs and what the card is asked for', () => {
    assert.deepEqual(balanceDrawn(preview()), { drawn: 10790, after: -14210 });
  });

  it('is nothing when the proration waits, when the account owes, or when nothing is charged', () => {
    assert.equal(balanceDrawn(preview({ proration_behavior: 'create_prorations' })), null);
    assert.equal(balanceDrawn(preview({ customer_balance: 5000, amount_due_now: 15790 })), null);
    assert.equal(balanceDrawn(preview({ net: -3000, amount_due_now: 0 })), null);
  });
});

/* ------------------------------ one-off invoices -------------------------- */

describe('a bill raised by hand', () => {
  it('covers no service period when both ends fall on the day it was raised', () => {
    assert.equal(coversNoPeriod(invoice({ billing_reason: 'manual', period: { start: NOW, end: NOW } })), true);
    assert.equal(coversNoPeriod(invoice({ billing_reason: 'manual', period: { start: NOW, end: NOW + DAY } })), true);
    // A renewal that happens to bill a single day is a period, and says so.
    assert.equal(coversNoPeriod(invoice({ billing_reason: 'subscription_cycle', period: { start: NOW, end: NOW + DAY } })), false);
    assert.equal(coversNoPeriod(invoice()), false);
  });
});

/* ----------------------------- deleting an account ------------------------ */

describe('the delete dialog', () => {
  it('closes the door, with the reason, while a live subscription exists', () => {
    const words = describeDelete('Critic Test Co', { live: 2, balance: 0, currency: 'usd', openInvoices: 1 }, f);
    assert.match(words.blocked ?? '', /Cancel its subscriptions/);
    assert.match(words.body, /Critic Test Co still has 2 live subscriptions, so the platform refuses to delete it/);
    assert.match(words.body, /One open invoice still names it/);
  });

  it('names the credit that is lost with the record', () => {
    const words = describeDelete('Critic Delete Me', { live: 0, balance: -25000, currency: 'usd', openInvoices: 0 }, f);
    assert.equal(words.blocked, null);
    assert.match(words.body, /holds USD 250\.00 of credit, which is lost with the record/);
    assert.match(words.body, /no route that restores a deleted customer/);
  });
});

/* -------------------------------- server notes ---------------------------- */

describe('sentences the server wrote for any client', () => {
  it('replace a charge id and an ISO date with the method and a formatted day', () => {
    assert.equal(
      humaniseNote('Collected by ch_eE240tnjW6N0N0XC on 2026-09-05.', f, { method: 'Visa ending 4242' }),
      'Collected by Visa ending 4242 on 2026-09-05.'.replace('2026-09-05', f.day(Date.UTC(2026, 8, 5))),
    );
    assert.doesNotMatch(humaniseNote('Collected by ch_abc on 2026-09-05.', f), /ch_/);
  });

  it('resolve the bracketed plural the attention line ships with', () => {
    assert.equal(pluraliseBrackets('1 subscription(s) are not being collected.'), '1 subscription is not being collected.');
    assert.equal(pluraliseBrackets('3 subscription(s) are not being collected.'), '3 subscriptions are not being collected.');
    assert.equal(pluraliseBrackets('2 invoice(s) overdue'), '2 invoices overdue');
  });
});

/* ------------------------- what the figures mean -------------------------- */

import {
  annualRecurring, billedTotal, bulkSkipReason, invoiceActions, periodsPerYear,
} from '../src/client/modules/billing/copy';

describe('an invoice’s Total', () => {
  it('is what was billed, before the account balance was drawn', () => {
    // in_4uxSe26dqmqqaPAV as the critic found it: a $106.53 bill settled
    // entirely from credit, which the API reports as total 0.
    const settledFromCredit = invoice({ subtotal: 10653, tax: 0, balance_applied: -10653, total: 0, amount_due: 0 });
    assert.equal(billedTotal(settledFromCredit), 10653);
    assert.notEqual(billedTotal(settledFromCredit), settledFromCredit.total);
  });
  it('includes the tax and nothing else', () => {
    assert.equal(billedTotal(invoice({ subtotal: 10000, tax: 2000, balance_applied: -500, total: 11500 })), 12000);
    assert.equal(billedTotal(invoice({ subtotal: 9900, tax: 0, balance_applied: 0, total: 9900 })), 9900);
  });
});

describe('the actions an invoice offers', () => {
  it('lets a draft be finalised or voided, and nothing else', () => {
    assert.deepEqual(invoiceActions(invoice({ status: 'draft' })), ['finalize', 'void']);
  });
  it('never offers to finalise a bill that is not a draft', () => {
    for (const status of ['open', 'paid', 'void', 'uncollectible'] as const) {
      assert.ok(!invoiceActions(invoice({ status })).includes('finalize'), status);
    }
  });
  it('offers a paid bill a credit note and a refund, never a void or a write-off', () => {
    assert.deepEqual(invoiceActions(invoice({ status: 'paid', amount_due: 0, amount_paid: 9900 })), ['refund', 'credit']);
  });
  it('offers a voided bill nothing', () => {
    assert.deepEqual(invoiceActions(invoice({ status: 'void', amount_due: 0 })), []);
  });
  it('offers an open bill payment, credit, void and write-off — and a refund only once something was collected', () => {
    assert.deepEqual(invoiceActions(invoice({ status: 'open', amount_due: 9900, amount_paid: 0 })), ['pay', 'credit', 'void', 'uncollectible']);
    assert.deepEqual(invoiceActions(invoice({ status: 'open', amount_due: 100, amount_paid: 9800 })), ['pay', 'refund', 'credit', 'void', 'uncollectible']);
  });
});

describe('what a bulk action would skip', () => {
  it('will not void a paid bill, and says to credit it instead', () => {
    assert.match(bulkSkipReason('void', invoice({ status: 'paid' })) ?? '', /credit it instead/);
    assert.equal(bulkSkipReason('void', invoice({ status: 'open' })), null);
    assert.equal(bulkSkipReason('void', invoice({ status: 'draft' })), null);
  });
  it('will not record payment on a draft or on a bill with nothing owed', () => {
    assert.match(bulkSkipReason('pay', invoice({ status: 'draft' })) ?? '', /finalise it first/);
    assert.match(bulkSkipReason('pay', invoice({ status: 'open', amount_due: 0 })) ?? '', /Nothing is owed/);
    assert.equal(bulkSkipReason('pay', invoice({ status: 'open', amount_due: 100 })), null);
  });
  it('only finalises drafts', () => {
    assert.equal(bulkSkipReason('finalize', invoice({ status: 'draft' })), null);
    assert.match(bulkSkipReason('finalize', invoice({ status: 'open' })) ?? '', /already finalised/);
  });
});

describe('the annual figure', () => {
  it('reads the cadence the summary writes', () => {
    assert.equal(periodsPerYear('year'), 1);
    assert.equal(periodsPerYear('month'), 12);
    assert.equal(periodsPerYear('3 months'), 4);
    assert.equal(periodsPerYear('week'), 52);
    assert.equal(periodsPerYear('fortnight'), null);
  });
  it('is the yearly fee itself on a yearly plan, not twelve rounded twelfths', () => {
    // Brightline Foods: $127,840.00 a year, which the API reports as
    // mrr 1065333 and arr 12783996.
    const subs = [{ mrr: 1065333, interval: 'year', items: [{ amount: 12784000 }] }];
    assert.equal(annualRecurring(subs), 12784000);
    assert.notEqual(annualRecurring(subs), 1065333 * 12);
  });
  it('adds monthly plans twelve times, skips paused agreements and metered items', () => {
    const subs = [
      { mrr: 57000, interval: 'month', items: [{ amount: 57000 }, { amount: null }] },
      { mrr: 0, interval: 'month', items: [{ amount: 190000 }] },
    ];
    assert.equal(annualRecurring(subs), 684000);
  });
  it('gives up rather than print a partial figure when a cadence cannot be read', () => {
    assert.equal(annualRecurring([{ mrr: 100, interval: 'fortnight', items: [{ amount: 100 }] }]), null);
  });
});

/* ------------------- what a refund promises before it runs ---------------- */

/**
 * The refund dialog tells an operator what will happen before they act, so what
 * it promises has to be what the gateway does. For a whole wave it promised the
 * opposite: the gateway had been changed so a settled bill stays settled, while
 * three screens and the route's own description still said the bill would be
 * owed again and go into the recovery queue. Nothing failed, because no test
 * compared the sentence to the behaviour.
 *
 * The gateway's rule lives in one docblock (`createRefund` in
 * src/server/modules/payments/gateway.ts) and is unambiguous: a refund records
 * `amount_refunded` and leaves `total`, `amount_paid`, `amount_due` and
 * `status` standing. Only a chargeback reopens a bill. So no screen may tell a
 * person that refunding will make a bill owed again, and the route that does it
 * may not say so either.
 */
describe('no screen promises a refund reopens the bill', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

  it('the gateway still says a refund leaves a settled bill settled', () => {
    const gateway = read('src/server/modules/payments/gateway.ts');
    assert.match(gateway, /a bill the customer settled is settled/i,
      'the rule this test guards has moved — reread createRefund and update these assertions from it');
  });

  it('no billing screen tells the operator the bill becomes owed again', () => {
    for (const file of ['src/client/modules/billing/invoices.tsx', 'src/client/modules/billing/payments-book.tsx']) {
      const source = read(file);
      // "owed again" is allowed only where it describes a chargeback, which is
      // the one reversal that really does reopen the bill.
      for (const line of source.split('\n')) {
        if (!/owed again/i.test(line)) continue;
        assert.match(line, /chargeback|network takes/i,
          `${file} promises a refund reopens the bill: ${line.trim()}`);
      }
      assert.doesNotMatch(source, /recovery queue held for a person/i,
        `${file} says a refunded bill is queued for recovery; nothing queues it`);
    }
  });

  it('the refund route describes what it actually does', () => {
    const module = read('src/server/modules/payments/module.ts');
    const [, description] = module.match(/description: '(Moves cash back[^']*)'/) ?? [];
    assert.ok(description, 'the refund route description could not be found');
    assert.match(description, /amount_refunded/, 'it does not say where the money is recorded');
    assert.match(description, /status all stand|is untouched/, 'it does not say the bill is untouched');
    assert.doesNotMatch(description, /leaves the bill owed again/,
      'the refund route still claims it reopens the bill');
  });
});

/* ===================== a change already in the book ======================= */

/**
 * A subscription schedule is the one place on these screens where the *future*
 * plan is quoted, and all three of the defects below are the same mistake in
 * different clothes: a figure taken from a source that does not know about the
 * schedule, or does not know what currency the account bills in.
 */

const PHASE_PRICES: Record<string, { product_name: string; nickname: string | null; is_default: boolean; metered: boolean }> = {
  price_scale: { product_name: 'Telemetry Cloud Scale', nickname: 'Scale platform fee — monthly', is_default: true, metered: false },
  price_scale_seat: { product_name: 'Telemetry Cloud Scale', nickname: 'Scale operator seat — monthly', is_default: false, metered: false },
  price_events: { product_name: 'Telemetry events', nickname: 'Telemetry events — graduated', is_default: true, metered: true },
};
const priceOf = (id: string) => PHASE_PRICES[id] ?? null;

const PHASE_ITEMS = [
  { price: 'price_scale', quantity: 1, custom_unit_amount: null },
  { price: 'price_scale_seat', quantity: 18, custom_unit_amount: null },
  { price: 'price_events', quantity: 1, custom_unit_amount: null },
];

/** What `POST /v1/catalog/estimate` answers for those items in euros. */
const EUR_ESTIMATE = [
  { price: 'price_scale', quantity: 1, amount_display: '€1,750.00', product: { name: 'Telemetry Cloud Scale' }, nickname: 'Scale platform fee — monthly' },
  { price: 'price_scale_seat', quantity: 18, amount_display: '€396.00', product: { name: 'Telemetry Cloud Scale' }, nickname: 'Scale operator seat — monthly' },
  { price: 'price_events', quantity: 1, amount_display: '€0.00', product: { name: 'Telemetry events' }, nickname: 'Telemetry events — graduated' },
];

describe('a schedule phase is quoted in the currency that will bill it', () => {
  it('prices every line from the engine’s answer in the subscription’s own currency', () => {
    const summary = phaseSummary(phaseLines(PHASE_ITEMS, EUR_ESTIMATE, priceOf));
    // Every amount on the line came out of the estimate, so the currency on
    // screen is the currency the renewal charges.
    for (const line of EUR_ESTIMATE) {
      if (line.price === 'price_events') continue;
      assert.ok(summary.includes(line.amount_display), `${line.amount_display} is missing from: ${summary}`);
    }
    assert.doesNotMatch(summary, /\$/, `a EUR phase quoted a dollar figure: ${summary}`);
    assert.match(summary, /18 × /, 'the quantity is dropped from the line');
  });

  it('names a metered line rather than pricing it at nothing', () => {
    const summary = phaseSummary(phaseLines(PHASE_ITEMS, EUR_ESTIMATE, priceOf));
    assert.match(summary, /Telemetry events \(metered\)/);
    // €0.00 is what the engine answers for one unit of a graduated meter, and
    // printing it would say the account is billed nothing for its usage.
    assert.doesNotMatch(summary, /Telemetry events — €0\.00/);
  });

  it('names a line the way the invoice will name it', () => {
    const [base, seat] = phaseLines(PHASE_ITEMS, EUR_ESTIMATE, priceOf);
    // The product speaks for its own default price; a seat that hangs off the
    // same product speaks for itself, or two lines read identically.
    assert.equal(base.label, 'Telemetry Cloud Scale');
    assert.equal(seat.label, 'Scale operator seat — monthly');
  });

  it('says what it can while the estimate has not answered, and quotes nothing', () => {
    const summary = phaseSummary(phaseLines(PHASE_ITEMS, null, priceOf));
    assert.match(summary, /Telemetry Cloud Scale/);
    assert.doesNotMatch(summary, /[$€£]/, 'a figure was printed before anything priced it');
  });

  it('is never read off the server’s own phase summary, which is priced in the price’s home currency', () => {
    // `schedulePayload` in src/server/modules/billing/module.ts computes each
    // phase item with `book.compute(price, quantity, price.currency)` — the
    // price's home currency, not the subscription's. Printing that field is
    // the defect; a screen that reads it is the defect on screen.
    const source = readFileSync(new URL('../src/client/modules/billing/schedules.tsx', import.meta.url), 'utf8');
    for (const line of source.split('\n')) {
      if (!/\bphase\.summary\b|\bnext\.summary\b/.test(line)) continue;
      assert.fail(`schedules.tsx still prints the server's phase summary: ${line.trim()}`);
    }
  });
});

describe('which phase governs the period a preview covers', () => {
  const phase = (over: Partial<PhaseWindow> = {}): PhaseWindow => ({
    id: 'phase_1', state: 'upcoming', start_date: NOW, end_date: NOW + 30 * DAY, items: PHASE_ITEMS, description: null, ...over,
  });
  const schedule = (phases: PhaseWindow[], status = 'active') => ({ status, phases });

  it('is the phase that takes over at the boundary, not the one running now', () => {
    const current = phase({ id: 'phase_0', state: 'current', start_date: NOW - 30 * DAY, end_date: NOW });
    const next = phase();
    assert.equal(phaseGoverning(schedule([current, next]), NOW)?.id, 'phase_1');
    // The period now running is the current phase's own; nothing changes in it.
    assert.equal(phaseGoverning(schedule([current, next]), NOW - DAY), null);
  });

  it('is nothing when the next phase starts after the period being previewed', () => {
    const current = phase({ id: 'phase_0', state: 'current', start_date: NOW - 30 * DAY, end_date: NOW + 60 * DAY });
    const later = phase({ start_date: NOW + 60 * DAY, end_date: NOW + 90 * DAY });
    assert.equal(phaseGoverning(schedule([current, later]), NOW + 30 * DAY), null);
  });

  it('is nothing once the schedule has been released, canceled or completed', () => {
    const current = phase({ id: 'phase_0', state: 'current', start_date: NOW - 30 * DAY, end_date: NOW });
    for (const status of ['released', 'canceled', 'completed']) {
      assert.equal(phaseGoverning(schedule([current, phase()], status), NOW), null, `a ${status} schedule still governed a bill`);
    }
    assert.equal(phaseGoverning(null, NOW), null);
  });
});

describe('previewing the bill a booked change will actually raise', () => {
  const items = [
    { id: 'si_base', price: 'price_growth' },
    { id: 'si_seat', price: 'price_growth_seat' },
    { id: 'si_events', price: 'price_events' },
  ];
  const sub = { current_period_end: NOW, interval: 'month', interval_count: 1, items };
  const upcoming: PhaseWindow = {
    id: 'phase_1', state: 'upcoming', start_date: NOW, end_date: NOW + 30 * DAY, items: PHASE_ITEMS, description: 'Rollout on Scale.',
  };
  const current: PhaseWindow = {
    id: 'phase_0', state: 'current', start_date: NOW - 30 * DAY, end_date: NOW, items: [], description: null,
  };
  const monthly = () => ({ interval: 'month', interval_count: 1 });

  it('removes what the phase drops instead of adding the new plan beside the old', () => {
    const patch = phasePreviewItems(items, upcoming);
    // The preview's `items` is a patch, not a replacement: sending only the new
    // prices leaves Growth standing and quotes both plans on one bill.
    const deleted = patch.filter((row) => row.deleted).map((row) => row.id);
    assert.deepEqual(deleted, ['si_base', 'si_seat']);
    // The metered line survives the change, so it is neither deleted nor
    // credited — it is the same item, still running.
    assert.ok(!deleted.includes('si_events'));
    assert.deepEqual(
      patch.filter((row) => !row.deleted).map((row) => row.price),
      ['price_scale', 'price_scale_seat', 'price_events'],
    );
  });

  it('carries a negotiated amount through, and leaves it off every other line', () => {
    const negotiated: PhaseWindow = {
      ...upcoming,
      items: [{ price: 'price_enterprise', quantity: 1, custom_unit_amount: 12_000_000 }, PHASE_ITEMS[2]],
    };
    const patch = phasePreviewItems(items, negotiated).filter((row) => !row.deleted);
    assert.equal(patch[0].custom_unit_amount, 12_000_000);
    assert.ok(!('custom_unit_amount' in patch[1]), 'a null negotiated amount was sent as a field');
  });

  it('prices the next bill on the phase when the cadence is unchanged', () => {
    const plan = scheduledUpcoming(sub, { status: 'active', phases: [current, upcoming] }, f, monthly);
    assert.equal(plan.phase?.id, 'phase_1');
    assert.equal(plan.caveat, null);
    assert.deepEqual(plan.items, phasePreviewItems(items, upcoming));
  });

  it('quotes nothing at all when there is no schedule', () => {
    assert.deepEqual(scheduledUpcoming(sub, null, f, monthly), { phase: null, items: null, caveat: null });
  });

  it('refuses to re-price a phase that moves the cadence, and says why', () => {
    // A cadence change re-anchors the cycle, so the preview would come back
    // describing a period starting today rather than the one on screen.
    const yearly = () => ({ interval: 'year', interval_count: 1 });
    const plan = scheduledUpcoming(sub, { status: 'active', phases: [current, upcoming] }, f, yearly);
    assert.equal(plan.items, null);
    assert.match(plan.caveat ?? '', /cadence/);
  });

  it('refuses to re-price a phase whose prices it could not read', () => {
    const plan = scheduledUpcoming(sub, { status: 'active', phases: [current, upcoming] }, f, () => null);
    assert.equal(plan.items, null);
    assert.match(plan.caveat ?? '', /could not be read/);
  });
});

/* ======================= what a credit note collected ===================== */

describe('a credit note never denies money the bill has taken', () => {
  const note = (over: Partial<Parameters<typeof creditNoteRouting>[0]> = {}) => ({
    total: 8333, currency: 'usd', pre_payment_amount: 8333, post_payment_amount: 0, displaced_to_balance: 0,
    refund_amount: 0, credit_amount: 0, out_of_band_amount: 0, ...over,
  });

  it('says nothing was collected only when nothing was', () => {
    const said = creditNoteRouting(note(), { number: 'NR-000350', amount_paid: 0 }, f);
    assert.match(said, /nothing had been collected yet/);
    assert.match(said, /USD 83\.33/);
  });

  it('does not claim nothing was collected on a bill that was part collected', () => {
    // $500.00 raised, $166.66 taken, $83.33 credited: the note fits inside what
    // is still owed, so `displaced_to_balance` is zero and the server's own
    // sentence falls through to "nothing had been collected yet" — beside an
    // `amount_paid` of $166.66 printed on the same screen.
    const said = creditNoteRouting(note(), { number: 'NR-000350', amount_paid: 16_666 }, f);
    assert.doesNotMatch(said, /nothing had been collected/);
    assert.match(said, /USD 166\.66/);
    assert.match(said, /stays collected/);
  });

  it('says where the money went when the bill was already paid in full', () => {
    const said = creditNoteRouting(
      note({ pre_payment_amount: 0, post_payment_amount: 8333, refund_amount: 5000, credit_amount: 3333 }),
      { number: 'NR-000350', amount_paid: 50_000 },
      f,
    );
    assert.match(said, /already been paid/);
    assert.match(said, /USD 50\.00 went back to the customer’s card/);
    assert.match(said, /USD 33\.33 was put onto the customer’s balance/);
  });

  it('splits a note that outruns what the bill still owed', () => {
    const said = creditNoteRouting(
      note({ total: 40_000, pre_payment_amount: 40_000, displaced_to_balance: 6_666 }),
      { number: 'NR-000350', amount_paid: 16_666 },
      f,
    );
    assert.match(said, /USD 333\.34 came off what NR-000350 asks for/);
    assert.match(said, /remaining USD 66\.66 had already been collected/);
  });

  it('is what the screens print, rather than the server’s own sentence', () => {
    const source = readFileSync(new URL('../src/client/modules/billing/invoices.tsx', import.meta.url), 'utf8');
    for (const line of source.split('\n')) {
      if (!/routing_detail/.test(line) || /^\s*(\/\/|\*|\{\/\*)/.test(line.trim())) continue;
      assert.fail(`invoices.tsx still prints the server's routing sentence: ${line.trim()}`);
    }
  });
});

/* ============================= the price book ============================= */

describe('the price book has a screen', () => {
  // Read as text, the way the shell's own registration tests do: importing
  // `routes.tsx` pulls the whole client in, stylesheet and all.
  const routesSource = readFileSync(new URL('../src/client/modules/billing/routes.tsx', import.meta.url), 'utf8');
  const block = (name: string): string =>
    new RegExp(`export const ${name}[\\s\\S]*?\\n\\];`).exec(routesSource)?.[0] ?? '';
  const registered = [...block('routes').matchAll(/path: '([^']+)'/g)].map((match) => match[1]);

  it('registers the list and the record', () => {
    assert.ok(registered.includes('/billing/invoices'), 'the route table was not read');
    assert.ok(registered.includes('/catalog/products'), 'no price-book list is registered');
    assert.ok(registered.includes('/catalog/products/:id'), 'no product record is registered');
  });

  it('gives the nav a way in', () => {
    const destinations = [...block('nav').matchAll(/ to: '([^']+)'/g)].map((match) => match[1]);
    assert.ok(destinations.includes('/catalog/products'), 'nothing in the nav reaches the price book');
  });

  it('turns the shell’s price-book search hits into links', () => {
    // The shell has always offered a Price book source; with no screen for a
    // product, `detailPattern` resolved to null and every hit was a dead row.
    const [source] = buildSources({
      objectTypes: [],
      routes: new Set(['GET /v1/products']),
      registered,
    }).filter((candidate) => candidate.id === 'product');
    assert.ok(source, 'the shell does not offer a price-book source');
    assert.equal(source.detailPattern, '/catalog/products/:id');
    const [hit] = hitsFrom(source, [{ id: 'prod_nw_scale', name: 'Telemetry Cloud Scale' }], 'scale');
    assert.equal(hit.href, '/catalog/products/prod_nw_scale');
  });
});

/* ========================== the next invoice panel ======================== */

/**
 * The account page's next-invoice panel used to print three of the six figures
 * the estimate is made of, and then the estimate. A usage-priced account read
 * "Recurring subtotal $99.00" directly above "Estimated total $416.08" with
 * nothing between them, because settled usage, the coupon and the tax had all
 * joined the total since the rows were written.
 *
 * The invariant below is the server's own — `buildCustomerSummary` arrives at
 * `estimated_total` by exactly this sum — so a row that stops being rendered
 * fails here rather than on the screen of whoever is reading the number out.
 */
describe('what the next-invoice panel is made of', () => {
  const line = (over: Partial<RecurringLine> = {}): RecurringLine => ({
    subscription_item: 'si_1', price: 'price_1', description: 'Telemetry Cloud Starter', quantity: 1,
    amount: 9900, currency: 'usd', metered: false, period: { start: NOW, end: NOW + 30 * DAY }, breakdown: [], ...over,
  });

  const estimate = (over: Partial<NextInvoiceEstimate> = {}): NextInvoiceEstimate => {
    const base: NextInvoiceEstimate = {
      subscription: 'sub_1', date: NOW + 30 * DAY, currency: 'usd', lines: [line()],
      subtotal: 9900, uninvoiced_total: 0, settled_usage_total: 0, discount: null, discount_total: 0,
      tax: 0, automatic_tax: { enabled: true, status: 'complete', detail: 'Worked out from the country on the record.' },
      balance_applied: 0, estimated_total: 9900, note: 'Covers the next period.', ...over,
    };
    // The estimate is never pasted in: it is the identity the server uses, so a
    // case here cannot quietly assert a total its own figures do not support.
    return {
      ...base,
      estimated_total: over.estimated_total ?? Math.max(
        0,
        base.subtotal + base.uninvoiced_total + base.settled_usage_total - base.discount_total + base.tax
          + base.balance_applied,
      ),
    };
  };

  const sum = (rows: { amount: number }[]) => rows.reduce((total, row) => total + row.amount, 0);

  it('renders the settled usage a metered account is mostly billed for', () => {
    const next = estimate({ settled_usage_total: 31708, lines: [line(), line({ metered: true, amount: null })] });
    const rows = nextInvoiceRows(next);
    const usage = rows.find((row) => row.id === 'settled_usage');
    assert.ok(usage, 'the panel does not render the settled usage the estimate carries');
    assert.equal(usage.amount, 31708);
    assert.equal(sum(rows), next.estimated_total);
  });

  it('adds up to the estimate with usage, a coupon, tax and the balance all in play', () => {
    const next = estimate({
      subtotal: 107900, uninvoiced_total: 4210, settled_usage_total: 745300,
      discount: 'di_1', discount_total: 4990, tax: 16074, balance_applied: -25000,
    });
    const rows = nextInvoiceRows(next);
    assert.equal(sum(rows), next.estimated_total);
    // The discount is stored positive and is a subtraction, so it must be
    // signed on the way onto the screen or the rows overstate the bill twice.
    assert.equal(rows.find((row) => row.id === 'discount')?.amount, -4990);
    assert.equal(rows.find((row) => row.id === 'tax')?.amount, 16074);
    assert.equal(rows.find((row) => row.id === 'balance')?.amount, -25000);
  });

  it('leaves out the terms worth nothing rather than printing a column of zeroes', () => {
    const rows = nextInvoiceRows(estimate());
    assert.deepEqual(rows.map((row) => row.id), ['subtotal']);
    assert.equal(sum(rows), 9900);
  });

  it('says what the figure is priced on, naming each part of it', () => {
    const next = estimate({
      subtotal: 9900, settled_usage_total: 31708, lines: [line(), line({ metered: true, amount: null })],
    });
    const note = nextInvoicePricedOn(next, f);
    assert.match(note, /USD 99\.00 of recurring charges/);
    assert.match(note, /USD 317\.08 of metered usage/);
    // The open period is a floor, not a prediction, and the note says so.
    assert.match(note, /not priced until the period closes/);
  });

  it('says a bill it cannot place will be held rather than sent', () => {
    const next = estimate({
      subtotal: 10000,
      automatic_tax: { enabled: true, status: 'requires_location_inputs', detail: 'No country on the account.' },
    });
    const note = nextInvoicePricedOn(next, f);
    assert.match(note, /No tax could be worked out/);
    assert.match(note, /held as a draft/);
  });

  it('is what the account page renders, rather than a second list beside it', () => {
    const source = readFileSync(new URL('../src/client/modules/billing/customers.tsx', import.meta.url), 'utf8');
    assert.match(source, /nextInvoiceRows\(next\)/,
      'the next-invoice panel no longer builds its totals from nextInvoiceRows');
    assert.match(source, /nextInvoicePricedOn\(next/,
      'the next-invoice panel no longer says what the estimate is priced on');
    // The hand-rolled block this replaced named three of the six terms.
    assert.doesNotMatch(source, /bl-total__label">Recurring subtotal</,
      'the panel prints a hand-rolled totals list again, which is how the rows stopped adding up');
  });
});

/* ============================ coupons on screen =========================== */

describe('coupons have a screen', () => {
  const routesSource = readFileSync(new URL('../src/client/modules/billing/routes.tsx', import.meta.url), 'utf8');
  const block = (name: string): string =>
    new RegExp(`export const ${name}[\\s\\S]*?\\n\\];`).exec(routesSource)?.[0] ?? '';
  const registered = [...block('routes').matchAll(/path: '([^']+)'/g)].map((match) => match[1]);

  it('registers the list and the record', () => {
    assert.ok(registered.includes('/catalog/products'), 'the route table was not read');
    assert.ok(registered.includes('/catalog/coupons'), 'no coupon list is registered');
    assert.ok(registered.includes('/catalog/coupons/:id'), 'no coupon record is registered');
  });

  it('gives the nav and the palette a way in', () => {
    const destinations = [...block('nav').matchAll(/ to: '([^']+)'/g)].map((match) => match[1]);
    assert.ok(destinations.includes('/catalog/coupons'), 'nothing in the nav reaches the coupons');
    assert.match(block('commands'), /\/catalog\/coupons\?new=1/, 'the palette cannot create a coupon');
  });
});

describe('what a coupon says about itself', () => {
  const coupon = (over: Record<string, unknown> = {}) => ({
    active: true, invalid_reason: null, duration: 'once', duration_in_periods: null,
    applies_to: { products: [], prices: [] }, times_redeemed: 0, max_redemptions: null,
    redemptions_remaining: null, ...over,
  });

  it('reads its standing off the record, archived first', () => {
    assert.equal(couponStanding(coupon()), 'live');
    assert.equal(couponStanding(coupon({ active: false, invalid_reason: 'inactive' })), 'archived');
    assert.equal(couponStanding(coupon({ invalid_reason: 'expired' })), 'expired');
    assert.equal(couponStanding(coupon({ invalid_reason: 'exhausted' })), 'fully_redeemed');
  });

  it('never borrows the word the kit already spends on a dunning campaign', () => {
    // `statusLabel('exhausted')` is "Given up", which is a campaign nobody is
    // chasing any more — not a coupon every seat has taken up.
    assert.equal(statusLabel('exhausted'), 'Given up');
    for (const reason of [null, 'inactive', 'expired', 'exhausted']) {
      assert.notEqual(couponStanding(coupon({ invalid_reason: reason })), 'exhausted');
    }
  });

  it('says how long it keeps coming off in periods, not months', () => {
    assert.equal(couponDurationWords(coupon()), 'The first bill only');
    assert.equal(couponDurationWords(coupon({ duration: 'forever' })), 'Every bill, without end');
    assert.equal(couponDurationWords(coupon({ duration: 'repeating', duration_in_periods: 12 })), '12 billing periods');
    assert.equal(couponDurationWords(coupon({ duration: 'repeating', duration_in_periods: 1 })), '1 billing period');
  });

  it('spells out the restriction that reads as no restriction', () => {
    assert.equal(couponScopeWords(coupon()), 'The whole bill');
    assert.equal(couponScopeWords(coupon({ applies_to: { products: ['prod_1'], prices: [] } })), '1 product');
    assert.equal(
      couponScopeWords(coupon({ applies_to: { products: ['prod_1'], prices: ['price_1', 'price_2'] } })),
      '1 product and 2 prices',
    );
  });

  it('counts what is left of a campaign from the ceiling, not from the take-up', () => {
    assert.equal(couponCeilingWords(coupon({ times_redeemed: 4 })), 'No ceiling');
    assert.equal(
      couponCeilingWords(coupon({ times_redeemed: 3, max_redemptions: 150, redemptions_remaining: 147 })),
      '147 of 150 left',
    );
    assert.equal(
      couponCeilingWords(coupon({ times_redeemed: 150, max_redemptions: 150, redemptions_remaining: 0 })),
      'None left',
    );
    assert.match(couponRedemptionWords(coupon({ times_redeemed: 4 })), /^4 redeemed · no ceiling$/);
  });

  it('lists the conditions a code carries that its coupon does not', () => {
    const words = promotionCodeRestrictionWords({
      expires_at: NOW + 30 * DAY,
      max_redemptions: 150,
      max_redemptions_per_customer: 1,
      restrictions: { minimum_amount: 50000, first_time_transaction: true },
      minimum_amount_display: '$500.00',
    }, f);
    assert.deepEqual(words, [
      `Expires ${f.day(NOW + 30 * DAY)}`,
      '150 in total',
      'One per account',
      'Orders of $500.00 or more',
      'Only an account that has never been billed',
    ]);
    assert.deepEqual(promotionCodeRestrictionWords({
      expires_at: null, max_redemptions: null, max_redemptions_per_customer: null,
      restrictions: { minimum_amount: null, first_time_transaction: false }, minimum_amount_display: null,
    }, f), []);
  });
});

/**
 * The create form refuses what the catalogue refuses, before the request
 * rather than after it — and, more importantly, sends a body the catalogue
 * accepts. Each rule below is one `Coupons.createCoupon` enforces.
 */
describe('creating a coupon from the screen', () => {
  const draft = (over: Partial<CouponDraft> = {}): CouponDraft => ({
    name: 'Q1 land-and-expand', kind: 'percent', percent: 20, amount: null, currency: 'usd',
    duration: 'once', periods: null, maxRedemptions: null, redeemBy: null, ...over,
  });

  it('lets a straightforward percentage through', () => {
    assert.equal(couponDraftBlocker(draft(), NOW), null);
  });

  it('holds back everything the catalogue would refuse', () => {
    assert.match(couponDraftBlocker(draft({ name: '  ' }), NOW) ?? '', /name/i);
    assert.match(couponDraftBlocker(draft({ percent: null }), NOW) ?? '', /percentage/i);
    assert.match(couponDraftBlocker(draft({ percent: 0 }), NOW) ?? '', /greater than 0/);
    assert.match(couponDraftBlocker(draft({ percent: 101 }), NOW) ?? '', /more than 100%/);
    assert.match(couponDraftBlocker(draft({ percent: 33.333 }), NOW) ?? '', /two decimal places/);
    assert.match(couponDraftBlocker(draft({ kind: 'amount', amount: null }), NOW) ?? '', /how much/i);
    assert.match(couponDraftBlocker(draft({ kind: 'amount', amount: 5000, currency: '' }), NOW) ?? '', /currency/i);
    assert.match(couponDraftBlocker(draft({ duration: 'repeating' }), NOW) ?? '', /how many billing periods/);
    assert.match(couponDraftBlocker(draft({ redeemBy: NOW - DAY }), NOW) ?? '', /born expired/);
    assert.equal(couponDraftBlocker(draft({ redeemBy: NOW + DAY }), NOW), null);
  });

  it('sends the percentage as basis points, so 33.33% is not rounded on the way', () => {
    const body = couponBody(draft({ percent: 33.33 }));
    assert.equal(body.percent_off_basis_points, 3333);
    assert.equal('percent_off' in body, false, 'sending both spellings of the percentage is refused');
    assert.equal('currency' in body, false, 'a percentage travels, so it carries no currency');
  });

  it('sends duration_in_periods only where it means something', () => {
    assert.equal('duration_in_periods' in couponBody(draft()), false);
    assert.equal('duration_in_periods' in couponBody(draft({ duration: 'forever' })), false);
    assert.equal(couponBody(draft({ duration: 'repeating', periods: 12 })).duration_in_periods, 12);
  });

  it('denominates a fixed amount and leaves the ceiling out when there is none', () => {
    const body = couponBody(draft({ kind: 'amount', amount: 50000, currency: 'eur' }));
    assert.equal(body.amount_off, 50000);
    assert.equal(body.currency, 'eur');
    assert.equal('percent_off_basis_points' in body, false);
    assert.equal('max_redemptions' in body, false);
    assert.equal(couponBody(draft({ maxRedemptions: 150 })).max_redemptions, 150);
  });
});

/* ========================= accepting an invitation ======================== */

/**
 * Accepting an invitation *verifies* an existing Ain credential and only
 * *enrols* a new one — identity is one row shared across workspaces, so
 * joining one must never set the credential for the others. The screen spent a
 * wave after that change still asking the person to "choose a password", to
 * type it twice, and telling them it was "the only thing that will let you
 * back in": three sentences that are false for every address already on Ain,
 * and a confirm box that cannot be filled in by someone typing a password they
 * already have.
 */
describe('the accept screen asks for the password acceptance actually takes', () => {
  const source = readFileSync(new URL('../src/client/kernel/accept.tsx', import.meta.url), 'utf8');

  it('asks for the Ain password rather than a new one', () => {
    assert.match(source, /label="Your Ain password"/, 'the field no longer names the password it takes');
    assert.match(source, /already sign in with, or one you choose now/,
      'the hint does not cover an address that already has an Ain account');
    assert.doesNotMatch(source, /Choose a password/, 'the screen still says the password is chosen here');
    assert.doesNotMatch(source, /only thing that will let you back in/,
      'the screen still claims this password is the only way back in');
  });

  it('lets the browser offer the credential it has stored', () => {
    const [, autoComplete] = source.match(/name="password"[\s\S]{0,120}?autoComplete="([a-z-]+)"/) ?? [];
    assert.equal(autoComplete, 'current-password',
      'new-password suppresses the stored credential the person is being asked for');
  });

  it('does not force a confirmation on a password the person already has', () => {
    const [, confirm] = source.match(/name="confirm-password"([\s\S]*?)\/>/) ?? [];
    assert.ok(confirm, 'the confirmation field could not be found');
    assert.doesNotMatch(confirm, /\brequired\b/, 'the confirmation is still required');
    // An empty confirmation is not a mismatch, so the submit gate may not
    // compare the two directly.
    assert.doesNotMatch(source, /const ready = password\.length >= MIN_PASSWORD && confirm === password/,
      'the submit button is still gated on typing the password twice');
    assert.match(source, /const ready = password\.length >= MIN_PASSWORD && !mismatch/,
      'the submit gate no longer reads the mismatch rule');
  });
});
