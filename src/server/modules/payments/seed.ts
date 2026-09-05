/**
 * Northwind Robotics' payment book.
 *
 * The seed exists to make one screen true on the first load: the recovery
 * queue. A dunning surface with nothing in it proves nothing, so this writes
 * the history that would exist in a workspace that has been collecting for
 * eighteen months — a card on every account that pays by card, a charge behind
 * every invoice that was paid by one, one recovery that worked, two that are
 * still running, and a chargeback being argued over.
 *
 * The two accounts already in arrears carry the two declines worth telling
 * apart, and their cards are set so the demo plays out honestly when the clock
 * moves: Ferrous Dynamics' card is short of funds once more and then clears,
 * so its recovery succeeds on the last scheduled attempt; Talbot Metalworks'
 * card has expired, so the very next attempt ends the schedule and the queue
 * asks for a new card instead of retrying six more times.
 */
import type { Ctx } from '../../kernel/context';
import { newId, randomId } from '../../../shared/ids';
import { formatMoney, money } from '../../../shared/money';
import { DAY, HOUR, startOfDay } from '../../../shared/time';
import type { Invoice, Subscription } from '../billing/types';
import { DECLINES, hash32 } from './simulator';
import { paymentsStore } from './store';
import type { CardBrand, CardFunding, DeclineCode, PaymentMethod } from './types';

const BRANDS: CardBrand[] = ['visa', 'mastercard', 'visa', 'amex', 'mastercard', 'visa'];
const FUNDING: CardFunding[] = ['credit', 'credit', 'debit', 'credit', 'credit', 'credit'];

/** Invoices older than this are history; charges are only written back this far. */
const CHARGE_HISTORY_DAYS = 180;

export function seedPayments(ctx: Ctx, orgId: string): void {
  const store = paymentsStore(ctx);
  const now = ctx.now();
  const locale = (() => { try { return ctx.svc.core.org(orgId).locale || 'en-US'; } catch { return 'en-US'; } })();

  const live = ctx.svc.billing.subscriptions(orgId, { status: 'active_like', limit: 200 });
  const cardPayers = live.filter((sub) => sub.collection_method === 'charge_automatically');
  if (!cardPayers.length) return;

  const arrears = new Set(cardPayers.filter((sub) => sub.status === 'past_due').map((sub) => sub.customer));

  // Two healthy accounts are carrying a card that is about to cause trouble,
  // which is the ordinary state of any real book of business. They are picked
  // by a stable sort rather than at random so the demo tells the same story on
  // every machine: one card has quietly expired, and one is short of funds for
  // the next two presentations before the account is topped up.
  const healthy = [...new Set(cardPayers.filter((sub) => !arrears.has(sub.customer)).map((sub) => sub.customer))].sort();
  const expiredCardCustomer = healthy[2] ?? null;
  const shortOfFundsCustomer = healthy[5] ?? null;

  /* ------------------------- a card on every account ---------------------- */

  const methodByCustomer = new Map<string, PaymentMethod>();
  const claimedIds = new Set<string>();
  let index = 0;

  for (const sub of cardPayers) {
    if (methodByCustomer.has(sub.customer)) continue;
    const customer = ctx.svc.billing.customer(orgId, sub.customer);
    if (!customer) continue;

    // Subscriptions created before this module existed already name the method
    // they pay with. Keeping that id is what makes the reference real rather
    // than dangling — the same thing a migration off another processor needs.
    const named = sub.default_payment_method;
    const keepId = named && /^pm_[A-Za-z0-9_]{1,60}$/.test(named) && !claimedIds.has(named) ? named : undefined;
    if (keepId) claimedIds.add(keepId);

    const expired = sub.customer === expiredCardCustomer;
    const behaviour = arrears.has(sub.customer)
      ? { simulated_behavior: 'insufficient_funds' as const, simulated_decline_count: 1 }
      : expired
        ? { simulated_behavior: 'expired_card' as const, simulated_decline_count: null }
        : sub.customer === shortOfFundsCustomer
          ? { simulated_behavior: 'insufficient_funds' as const, simulated_decline_count: 2 }
          : { simulated_behavior: 'succeeds' as const, simulated_decline_count: null };

    const method = store.methods.create(orgId, {
      id: keepId,
      type: 'card',
      customer: customer.id,
      brand: BRANDS[index % BRANDS.length],
      funding: FUNDING[index % FUNDING.length],
      // Talbot's card really has expired — the declared behaviour and the date
      // on the card agree, because a demo that contradicts itself is a bug.
      exp_month: expired ? new Date(now - 45 * DAY).getUTCMonth() + 1 : ((index * 5) % 12) + 1,
      exp_year: expired ? new Date(now - 45 * DAY).getUTCFullYear() : new Date(now).getUTCFullYear() + 3,
      country: customer.address?.country ?? 'US',
      billing_name: customer.name,
      billing_email: customer.email ?? undefined,
      metadata: { seeded: 'true' },
      ...behaviour,
    }, { actorType: 'system' });
    methodByCustomer.set(customer.id, method);
    index++;
  }

  // Two accounts pay by direct debit as well — a second method on file is what
  // makes "which one gets charged?" a real question rather than a hypothetical.
  for (const sub of cardPayers.filter((s) => !arrears.has(s.customer)).slice(0, 2)) {
    const customer = ctx.svc.billing.customer(orgId, sub.customer);
    if (!customer) continue;
    store.methods.create(orgId, {
      type: 'bank_debit',
      customer: customer.id,
      bank_name: 'Midland Union Bank',
      account_type: 'checking',
      country: customer.address?.country ?? 'US',
      billing_name: customer.name,
      set_default: false,
      metadata: { seeded: 'true', note: 'Signed mandate on file for annual terms.' },
    }, { actorType: 'system' });
  }

  /* --------------------- a charge behind every paid bill ------------------ */

  const paid = ctx.svc.billing
    .invoices(orgId, { status: 'paid', limit: 200 })
    .filter((invoice) => invoice.collection_method === 'charge_automatically'
      && invoice.amount_paid > 0
      && invoice.paid_at !== null
      && invoice.paid_at > now - CHARGE_HISTORY_DAYS * DAY
      && methodByCustomer.has(invoice.customer)
      && !arrears.has(invoice.customer));

  const chargeByInvoice = new Map<string, string>();
  for (const invoice of paid) {
    const method = methodByCustomer.get(invoice.customer) as PaymentMethod;
    const at = invoice.paid_at as number;
    const charge = writeHistoricCharge(ctx, orgId, invoice, method, at);
    chargeByInvoice.set(invoice.id, charge);
  }

  /* ------------------------ a recovery that worked ------------------------ */

  // The oldest bill with a charge behind it did not go through first time. It
  // is the row that makes the recovery rate on the summary a real number.
  const recoveredInvoice = paid.filter((invoice) => (invoice.paid_at as number) < now - 40 * DAY).pop();
  if (recoveredInvoice) {
    const method = methodByCustomer.get(recoveredInvoice.customer) as PaymentMethod;
    const settledAt = recoveredInvoice.paid_at as number;
    const firstFailure = settledAt - 4 * DAY;
    const campaign = randomId('dun');
    ctx.db.insert('payments_dunning', {
      id: campaign, org_id: orgId, invoice_id: recoveredInvoice.id, customer_id: recoveredInvoice.customer,
      subscription_id: recoveredInvoice.subscription, currency: recoveredInvoice.currency,
      amount_at_risk: recoveredInvoice.amount_paid, recovered_amount: recoveredInvoice.amount_paid,
      status: 'recovered', attempt_count: 2, max_attempts: 4,
      retry_days: [3, 5, 7] as any, end_behavior: 'mark_unpaid',
      next_attempt_at: null, last_attempt_at: settledAt,
      last_failure_code: 'insufficient_funds', last_failure_message: DECLINES.insufficient_funds.message,
      started_at: firstFailure, resolved_at: settledAt,
      resolution: `${formatMoney(money(recoveredInvoice.amount_paid, recoveredInvoice.currency), { locale })} recovered on attempt 2 of 4, 4 day(s) after the first failure.`,
      created: firstFailure, updated: settledAt,
    } as any);
    insertAttempt(ctx, orgId, {
      campaign, invoice: recoveredInvoice, attemptNumber: 1, scheduledFor: firstFailure, attemptedAt: firstFailure,
      methodId: method.id, outcome: 'failed', amount: recoveredInvoice.amount_paid,
      failure: 'insufficient_funds',
      decision: 'Attempt 1 was refused with insufficient_funds. Attempt 2 of 4 is scheduled for three days out.',
      nextAttemptAt: settledAt,
    });
    insertAttempt(ctx, orgId, {
      campaign, invoice: recoveredInvoice, attemptNumber: 2, scheduledFor: settledAt, attemptedAt: settledAt,
      methodId: method.id, chargeId: chargeByInvoice.get(recoveredInvoice.id) ?? null,
      outcome: 'succeeded', amount: recoveredInvoice.amount_paid, failure: null,
      decision: 'The charge was authorised, so the invoice is settled and recovery stops here.',
      nextAttemptAt: null,
    });
  }

  /* --------------------- the two recoveries still running ----------------- */

  for (const sub of cardPayers.filter((s) => s.status === 'past_due')) {
    const open = ctx.svc.billing.invoices(orgId, { subscription: sub.id, status: 'open', limit: 5 })
      .filter((invoice) => invoice.amount_due > 0)
      .sort((a, b) => a.created - b.created)[0];
    if (!open) continue;
    const method = methodByCustomer.get(sub.customer);
    if (!method) continue;
    seedRunningCampaign(ctx, orgId, sub, open, method, now, locale);
  }

  /* ------------------------------ a chargeback ---------------------------- */

  // A real dispute, opened through the same path the API uses: the money is
  // withdrawn from the invoice the day the cardholder complains, which is what
  // actually happens and what a workspace's cash position has to reflect.
  const disputed = paid.find((invoice) => (invoice.paid_at as number) > now - 30 * DAY && invoice.amount_paid > 20_000)
    ?? paid.find((invoice) => (invoice.paid_at as number) > now - 30 * DAY);
  const disputedCharge = disputed ? chargeByInvoice.get(disputed.id) : null;
  if (disputed && disputedCharge) {
    const dispute = store.gateway.openDispute(orgId, {
      charge: disputedCharge,
      reason: 'product_not_received',
      evidence_due_days: 18,
    }, { actorType: 'system' });
    store.gateway.submitEvidence(orgId, dispute.id, {
      product_description: 'Telemetry ingestion and predictive-maintenance alerting for the customer’s plant, billed monthly in advance.',
      customer_communication: 'Onboarding thread with the plant engineering lead, plus the alert digests delivered every week of the billed period.',
      service_documentation: 'Ingestion volume for the period, taken from the meter: every day of the month shows events received and alerts raised.',
    }, { actorType: 'system' });
  }
}

/* --------------------------------- helpers -------------------------------- */

function writeHistoricCharge(
  ctx: Ctx, orgId: string, invoice: Invoice, method: PaymentMethod, at: number,
): string {
  const intentId = newId('payment');
  const chargeId = newId('charge');
  ctx.db.insert('payments_intents', {
    id: intentId, org_id: orgId, customer_id: invoice.customer, payment_method_id: method.id,
    invoice_id: invoice.id, subscription_id: invoice.subscription,
    amount: invoice.amount_paid, currency: invoice.currency, status: 'succeeded',
    description: `Invoice ${invoice.number}`, statement_descriptor: null,
    off_session: 1, attempt_count: 1, next_action: null,
    last_error_code: null, last_error_message: null, last_error_advice: null,
    latest_charge_id: chargeId, succeeded_at: at, canceled_at: null, cancellation_reason: null,
    idempotency_key: `collect:${invoice.id}:0`, source: 'invoice_collection',
    metadata: { seeded: 'true' }, created: at, updated: at, livemode: 1,
  } as any);
  ctx.db.insert('payments_charges', {
    id: chargeId, org_id: orgId, payment_intent_id: intentId, customer_id: invoice.customer,
    payment_method_id: method.id, invoice_id: invoice.id, subscription_id: invoice.subscription,
    amount: invoice.amount_paid, amount_refunded: 0, amount_disputed: 0, currency: invoice.currency,
    status: 'succeeded', paid: 1, captured: 1, refunded: 0, disputed: 0,
    failure_code: null, failure_message: null,
    authorization_code: String(hash32(`auth:${intentId}`) % 1_000_000).padStart(6, '0'),
    outcome_type: 'authorized', outcome_network_status: 'approved_by_network', outcome_reason: null,
    outcome_risk_level: 'normal', outcome_risk_score: hash32(`risk:${intentId}`) % 70,
    outcome_seller_message: 'Payment complete.',
    outcome_explanation: 'Authorised by the issuer on the first presentation.',
    created: at, livemode: 1,
  } as any);
  return chargeId;
}

function insertAttempt(
  ctx: Ctx, orgId: string,
  input: {
    campaign: string; invoice: Invoice; attemptNumber: number; scheduledFor: number; attemptedAt: number;
    methodId: string | null; chargeId?: string | null; outcome: 'succeeded' | 'failed' | 'skipped';
    amount: number; failure: DeclineCode | null; decision: string; nextAttemptAt: number | null;
  },
): void {
  ctx.db.insert('payments_dunning_attempts', {
    id: randomId('dnat'), org_id: orgId, dunning_id: input.campaign, invoice_id: input.invoice.id,
    customer_id: input.invoice.customer, subscription_id: input.invoice.subscription,
    attempt_number: input.attemptNumber, scheduled_for: input.scheduledFor, attempted_at: input.attemptedAt,
    payment_method_id: input.methodId, payment_intent_id: null, charge_id: input.chargeId ?? null,
    amount: input.amount, currency: input.invoice.currency, outcome: input.outcome,
    failure_code: input.failure, failure_message: input.failure ? DECLINES[input.failure].message : null,
    decision: input.decision, next_attempt_at: input.nextAttemptAt, created: input.attemptedAt,
  } as any);
}

/**
 * A campaign that is part-way through its schedule, with its next attempt a
 * few days out and the job that will run it already on the queue — so moving
 * the clock forward plays the rest of the story rather than starting it.
 */
function seedRunningCampaign(
  ctx: Ctx, orgId: string, sub: Subscription, invoice: Invoice, method: PaymentMethod,
  now: number, locale: string,
): void {
  const code: DeclineCode = method.simulated.behavior === 'expired_card' ? 'expired_card' : 'insufficient_funds';
  const profile = DECLINES[code];
  const expired = code === 'expired_card';
  const firstFailure = Math.max(invoice.finalized_at ?? invoice.created, now - 12 * DAY);
  const secondFailure = firstFailure + 3 * DAY;
  const attempts = expired ? 1 : 2;
  const lastAttempt = expired ? firstFailure : secondFailure;
  const jitter = (hash32(`${invoice.id}:${attempts}`) % 240) * 60_000;
  const nextAttempt = startOfDay(lastAttempt) + (expired ? 6 : 5) * DAY + 9 * HOUR + jitter;
  const nextAt = nextAttempt <= now ? startOfDay(now) + 2 * DAY + 9 * HOUR + jitter : nextAttempt;
  const campaign = randomId('dun');

  ctx.db.insert('payments_dunning', {
    id: campaign, org_id: orgId, invoice_id: invoice.id, customer_id: invoice.customer,
    subscription_id: sub.id, currency: invoice.currency, amount_at_risk: invoice.amount_due,
    recovered_amount: 0, status: 'recovering', attempt_count: attempts, max_attempts: 4,
    retry_days: [3, 5, 7] as any, end_behavior: 'mark_unpaid',
    next_attempt_at: nextAt, last_attempt_at: lastAttempt,
    last_failure_code: code, last_failure_message: profile.message,
    started_at: firstFailure, resolved_at: null, resolution: null,
    created: firstFailure, updated: lastAttempt,
  } as any);

  insertAttempt(ctx, orgId, {
    campaign, invoice, attemptNumber: 1, scheduledFor: firstFailure, attemptedAt: firstFailure,
    methodId: method.id, outcome: 'failed', amount: invoice.amount_due, failure: code,
    decision: expired
      ? `Attempt 1 was refused with expired_card. ${profile.advice} The remaining attempts are on hold until a new card is on file.`
      : `Attempt 1 was refused with insufficient_funds. Attempt 2 of 4 is scheduled three days out.`,
    nextAttemptAt: expired ? nextAt : secondFailure,
  });
  if (!expired) {
    insertAttempt(ctx, orgId, {
      campaign, invoice, attemptNumber: 2, scheduledFor: secondFailure, attemptedAt: secondFailure,
      methodId: method.id, outcome: 'failed', amount: invoice.amount_due, failure: code,
      decision: `Attempt 2 was refused with insufficient_funds again. Attempt 3 of 4 is scheduled five days out — ${formatMoney(money(invoice.amount_due, invoice.currency), { locale })} is still at risk.`,
      nextAttemptAt: nextAt,
    });
  }

  ctx.enqueue(orgId, 'payments.dunning_retry', { dunning: campaign }, {
    runAt: nextAt, idemKey: `payments.dunning_retry:${campaign}`,
  });
}
