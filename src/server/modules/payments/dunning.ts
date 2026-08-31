/**
 * Smart dunning: the part of a billing system that actually earns its fee.
 *
 * A fixed timer recovers the money that was going to come back anyway. What
 * recovers the rest is knowing *when* to try again and *when to stop*, and all
 * four of the rules here exist because of a specific way money gets lost:
 *
 *  - **Widening gaps.** `retry_days` are the gaps between attempts, not offsets
 *    from the first failure. An issuer that refused a card this morning refuses
 *    it this afternoon; three days, then five, then seven is what gives a
 *    payroll cycle time to turn over.
 *  - **Deterministic jitter inside a daily window.** Every retry lands in the
 *    workspace's collection window, spread across it by a hash of the invoice.
 *    Ten thousand subscriptions do not all present at 09:00:00, and the day an
 *    attempt lands on is still exactly predictable — which is what makes this
 *    testable and what makes the time machine honest.
 *  - **Severity-aware backoff.** A hard decline waits `hard_decline_multiplier`
 *    times longer, because retrying it sooner buys a second refusal and, at
 *    some acquirers, a second fee.
 *  - **Knowing when to stop.** `expired_card` is not a timing problem. Retrying
 *    it eleven times over three weeks annoys a customer who would have given
 *    you a new card on day one. Final declines end the campaign immediately and
 *    the recovery queue says what to ask for instead.
 *
 * Every step — including the ones that decided *not* to try — is a row in
 * `payments_dunning_attempts` with the reasoning in `decision`, so the whole
 * recovery story is readable, chartable and defensible after the fact.
 */
import type { Ctx } from '../../kernel/context';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { randomId } from '../../../shared/ids';
import { formatMoney, money, rat, ratMul, ratRound } from '../../../shared/money';
import { DAY, HOUR, MINUTE, formatDate, startOfDay } from '../../../shared/time';
import { billingStore } from '../billing/module';
import type { Invoice } from '../billing/types';
import { hydrateAttempt, hydrateDunning, type Page, type WriteMeta } from './records';
import { BANK_DEBIT_SETTLEMENT_DAYS, DECLINES, hash32, severityOf } from './simulator';
import type { Payments } from './store';
import type {
  Charge, DeclineCode, DeclineSeverity, Dunning, DunningAttempt, DunningAttemptOutcome, DunningEndBehavior,
  DunningPolicy, DunningStatus, DunningView, PaymentIntent,
} from './types';
import { DUNNING_END_BEHAVIORS } from './types';

/** The setting key the workspace's retry policy lives under. */
export const POLICY_KEY = 'payments.dunning_policy';

export const DEFAULT_POLICY: DunningPolicy = {
  retry_days: [3, 5, 7],
  max_attempts: 4,
  end_behavior: 'mark_unpaid',
  skip_weekends: true,
  hard_decline_multiplier: 2,
  collection_hour: 9,
  jitter_hours: 4,
  // Every code here refuses for a reason no amount of waiting changes. The two
  // that are easy to get wrong are the last two: `authentication_required` is
  // refused by construction on every off-session attempt, and `incorrect_cvc`
  // re-sends the same wrong digits each time. Retrying either spends the whole
  // schedule on an outcome that was never going to move.
  give_up_codes: ['expired_card', 'account_closed', 'no_account', 'authentication_required', 'incorrect_cvc'],
};

export interface DunningListFilter {
  status?: DunningStatus | 'open' | 'all';
  customer?: string;
  subscription?: string;
  limit?: number;
}

/**
 * What recovery is worth, per currency.
 *
 * Money is never totalled across currencies here. A workspace billing in both
 * euros and dollars has two answers to "how much is at risk", and adding them
 * together would produce a third that is true in neither.
 */
export interface RecoveryTotals {
  currency: string;
  amount_at_risk: number;
  recovered_amount: number;
  lost_amount: number;
  /** Recovered / (recovered + lost), in basis points. Exact, not a float. */
  recovery_rate_bps: number;
}

export interface RecoverySummary {
  object: 'dunning_summary';
  open_campaigns: number;
  needs_human: number;
  recovered_campaigns: number;
  exhausted_campaigns: number;
  totals: RecoveryTotals[];
  attempts: { total: number; succeeded: number; failed: number; skipped: number };
  by_decline: { code: DeclineCode; severity: DeclineSeverity; attempts: number }[];
  next_attempt_at: number | null;
}

/** Why a campaign stopped. It is on the event, so a report can chart the split. */
type ExhaustionReason = 'attempts_exhausted' | 'decline_is_final' | 'nothing_to_present';

const isWeekend = (ts: number): boolean => {
  const day = new Date(ts).getUTCDay();
  return day === 0 || day === 6;
};

export class DunningEngine {
  constructor(private readonly ctx: Ctx, private readonly payments: Payments) {}

  private get billing() { return billingStore(this.ctx).billing; }

  /* --------------------------------- policy ------------------------------- */

  policy(orgId: string): DunningPolicy {
    const stored = this.ctx.svc.core.setting<Partial<DunningPolicy>>(orgId, POLICY_KEY, {});
    return { ...DEFAULT_POLICY, ...stored, retry_days: stored.retry_days?.length ? stored.retry_days : DEFAULT_POLICY.retry_days };
  }

  setPolicy(orgId: string, patch: Partial<DunningPolicy>, meta: WriteMeta = {}): DunningPolicy {
    return this.ctx.atomic(() => {
      const before = this.policy(orgId);
      const next: DunningPolicy = { ...before, ...patch };
      if (patch.retry_days) {
        if (!patch.retry_days.length) throw badRequest('retry_days_empty', 'A retry schedule needs at least one gap. Set max_attempts to 1 to stop retrying altogether.', 'retry_days');
        if (patch.retry_days.some((d) => d < 1 || d > 60)) throw badRequest('retry_days_invalid', 'Each gap is between 1 and 60 days.', 'retry_days');
      }
      if (next.max_attempts < 1 || next.max_attempts > 12) {
        throw badRequest('max_attempts_invalid', 'Between 1 and 12 attempts. More than that is harassment, and the acquirer will notice.', 'max_attempts');
      }
      if (!DUNNING_END_BEHAVIORS.includes(next.end_behavior)) {
        throw badRequest('end_behavior_invalid', `end_behavior is one of: ${DUNNING_END_BEHAVIORS.join(', ')}.`, 'end_behavior');
      }
      if (next.collection_hour < 0 || next.collection_hour > 23) {
        throw badRequest('collection_hour_invalid', 'collection_hour is an hour of the day in UTC, 0 through 23.', 'collection_hour');
      }
      if (next.jitter_hours < 0 || next.jitter_hours > 12) {
        throw badRequest('jitter_hours_invalid', 'Spread retries across at most 12 hours, or set 0 to present them all at the top of the window.', 'jitter_hours');
      }
      if (next.hard_decline_multiplier < 1 || next.hard_decline_multiplier > 6) {
        throw badRequest('multiplier_invalid', 'A hard decline waits between 1 and 6 times as long as a soft one.', 'hard_decline_multiplier');
      }
      this.ctx.svc.core.setSetting(orgId, POLICY_KEY, next);
      this.ctx.emit(orgId, 'dunning.policy_updated', next, {
        objectId: orgId, objectType: 'organization', previous: before as unknown as Record<string, unknown>,
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return next;
    });
  }

  /**
   * When the next attempt should land.
   *
   * Snapping to the workspace's collection window is what makes "the third
   * retry lands on the 16th" a fact rather than an approximation, and the
   * jitter inside the window is derived from the invoice id so it is the same
   * on every machine and on every replay.
   */
  nextAttemptAt(
    policy: DunningPolicy,
    opts: { invoiceId: string; failedAttempt: number; from: number; severity: DeclineSeverity; now: number },
  ): number {
    const index = Math.min(Math.max(opts.failedAttempt - 1, 0), policy.retry_days.length - 1);
    const base = policy.retry_days[index] ?? DEFAULT_POLICY.retry_days[0];
    const days = Math.max(1, Math.round(base * (opts.severity === 'hard' ? policy.hard_decline_multiplier : 1)));
    const spread = policy.jitter_hours > 0
      ? (hash32(`${opts.invoiceId}:${opts.failedAttempt}`) % (policy.jitter_hours * 60)) * MINUTE
      : 0;
    let target = startOfDay(opts.from) + days * DAY + policy.collection_hour * HOUR + spread;
    if (policy.skip_weekends) {
      let guard = 0;
      while (isWeekend(target) && guard++ < 7) target += DAY;
    }
    // A retry can never be scheduled into the past, however far behind the
    // queue has fallen — that would present the same card twice in a second.
    return target <= opts.now ? opts.now + HOUR : target;
  }

  /* --------------------------------- reading ------------------------------ */

  campaign(orgId: string, id: string): Dunning | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM payments_dunning WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydrateDunning(row) : null;
  }

  require(orgId: string, id: string): Dunning {
    const found = this.campaign(orgId, id);
    if (!found) throw notFound('dunning campaign', id);
    return found;
  }

  forInvoice(orgId: string, invoiceId: string): Dunning | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM payments_dunning WHERE org_id = ? AND invoice_id = ?`, orgId, invoiceId);
    return row ? hydrateDunning(row) : null;
  }

  attempts(orgId: string, dunningId: string): DunningAttempt[] {
    return this.ctx.db
      .all<any>(`SELECT * FROM payments_dunning_attempts WHERE org_id = ? AND dunning_id = ? ORDER BY attempt_number ASC, created ASC`, orgId, dunningId)
      .map(hydrateAttempt);
  }

  list(orgId: string, filter: DunningListFilter = {}): Page<Dunning> {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    const status = filter.status ?? 'open';
    if (status === 'open') clauses.push(`status = 'recovering'`);
    else if (status !== 'all') { clauses.push('status = ?'); params.push(status); }
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.subscription) { clauses.push('subscription_id = ?'); params.push(filter.subscription); }
    const where = clauses.join(' AND ');
    const totalCount = this.ctx.db.count(`SELECT COUNT(*) FROM payments_dunning WHERE ${where}`, ...(params as any[]));
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = this.ctx.db.all<any>(
      `SELECT * FROM payments_dunning WHERE ${where}
        ORDER BY (next_attempt_at IS NULL), next_attempt_at ASC, amount_at_risk DESC LIMIT ?`,
      ...(params as any[]), limit,
    );
    return { data: rows.map(hydrateDunning), hasMore: rows.length >= limit && totalCount > limit, nextCursor: null, totalCount };
  }

  /** The recovery queue: every campaign with the decision a human has to make. */
  queue(orgId: string, filter: DunningListFilter = {}): { data: DunningView[]; totalCount: number } {
    const page = this.list(orgId, filter);
    return { data: page.data.map((campaign) => this.view(orgId, campaign)), totalCount: page.totalCount };
  }

  view(orgId: string, campaign: Dunning): DunningView {
    const customer = this.ctx.svc.billing.customer(orgId, campaign.customer);
    const invoice = this.billing.invoices.invoice(orgId, campaign.invoice);
    const subscription = campaign.subscription ? this.ctx.svc.billing.subscription(orgId, campaign.subscription) : null;
    const method = this.payments.methods.resolve(orgId, campaign.customer, [
      subscription?.default_payment_method, customer?.invoice_settings.default_payment_method,
    ]);
    const attempts = this.attempts(orgId, campaign.id);
    const advice = this.advise(orgId, campaign, customer?.name ?? campaign.customer, method !== null);
    return {
      ...campaign,
      customer_name: customer?.name ?? campaign.customer,
      invoice_number: invoice?.number ?? campaign.invoice,
      subscription_status: subscription?.status ?? null,
      attempts_remaining: Math.max(0, campaign.max_attempts - campaign.attempt_count),
      payment_method: method,
      attempts,
      recommended_action: advice.action,
      needs_human: advice.needsHuman,
    };
  }

  private advise(
    orgId: string, campaign: Dunning, customerName: string, hasMethod: boolean,
  ): { action: string; needsHuman: boolean } {
    const org = this.orgFormat(orgId);
    const amount = formatMoney(money(campaign.amount_at_risk, campaign.currency), { locale: org.locale });
    if (campaign.status === 'recovered') {
      return {
        action: `Recovered. ${formatMoney(money(campaign.recovered_amount, campaign.currency), { locale: org.locale })} was collected on ${formatDate(campaign.resolved_at ?? campaign.updated, org)} after ${campaign.attempt_count} attempt${campaign.attempt_count === 1 ? '' : 's'}. Nothing to do.`,
        needsHuman: false,
      };
    }
    if (campaign.status === 'canceled') {
      return { action: campaign.resolution ?? 'Recovery was stopped by hand.', needsHuman: false };
    }
    if (campaign.status === 'exhausted') {
      const code = campaign.last_failure_code;
      const why = code ? `${DECLINES[code].advice} ` : '';
      // The one ending where the card on file is not the problem: the bank
      // wanted the cardholder, and nothing about the account is wrong. Telling
      // an operator to chase new details here loses a customer who is one
      // confirmation away from paying.
      const close = code === 'authentication_required'
        ? `${amount} is still owed on a card that works — do not write this account off over one confirmation.`
        : `${amount} is still owed — collect it by hand once there is something that works to charge, or write it off with a credit note.`;
      return { action: `${campaign.resolution ?? 'Recovery ended.'} ${why}${close}`, needsHuman: true };
    }
    if (!hasMethod) {
      return {
        action: `No usable payment method on file. ${amount} cannot be charged until ${customerName} gives you one — take the card details and attach them with POST /v1/payment_methods, then present the bill with POST /v1/invoices/${campaign.invoice}/retry rather than waiting for a schedule that has nothing to present.`,
        needsHuman: true,
      };
    }
    const code = campaign.last_failure_code;
    const when = campaign.next_attempt_at ? formatDate(campaign.next_attempt_at, { ...org, withTime: true }) : 'the next window';
    if (!code) {
      return { action: `Collection is scheduled for ${when}. Nothing to do yet.`, needsHuman: false };
    }
    const profile = DECLINES[code];
    if (profile.severity === 'final') {
      return {
        action: `${profile.advice} ${amount} stays owed until then, so this one is on ${customerName} and a person here, not on the schedule.`,
        needsHuman: true,
      };
    }
    if (profile.severity === 'hard') {
      return {
        action: `${profile.advice} The next automatic attempt is ${when}; if that one is refused too, ${customerName} needs to be asked for a different method.`,
        needsHuman: campaign.attempt_count >= 2,
      };
    }
    return {
      action: `${profile.advice} Retrying ${amount} automatically on ${when} — no action needed unless it fails again.`,
      needsHuman: false,
    };
  }

  summary(orgId: string): RecoverySummary {
    const counts = this.ctx.db.all<{ status: DunningStatus; n: number }>(
      `SELECT status, COUNT(*) AS n FROM payments_dunning WHERE org_id = ? GROUP BY status`, orgId,
    );
    const byStatus = Object.fromEntries(counts.map((row) => [row.status, Number(row.n)]));
    const perCurrency = this.ctx.db.all<{ currency: string; at_risk: number; recovered: number; lost: number }>(
      `SELECT currency,
              COALESCE(SUM(CASE WHEN status = 'recovering' THEN amount_at_risk ELSE 0 END), 0) AS at_risk,
              COALESCE(SUM(CASE WHEN status = 'recovered'  THEN recovered_amount ELSE 0 END), 0) AS recovered,
              COALESCE(SUM(CASE WHEN status = 'exhausted'  THEN amount_at_risk ELSE 0 END), 0) AS lost
         FROM payments_dunning WHERE org_id = ? GROUP BY currency ORDER BY at_risk DESC, currency ASC`,
      orgId,
    );
    const outcomes = this.ctx.db.all<{ outcome: DunningAttemptOutcome; n: number }>(
      `SELECT outcome, COUNT(*) AS n FROM payments_dunning_attempts WHERE org_id = ? GROUP BY outcome`, orgId,
    );
    const byOutcome = Object.fromEntries(outcomes.map((row) => [row.outcome, Number(row.n)]));
    const declines = this.ctx.db.all<{ failure_code: DeclineCode; n: number }>(
      `SELECT failure_code, COUNT(*) AS n FROM payments_dunning_attempts
        WHERE org_id = ? AND failure_code IS NOT NULL GROUP BY failure_code ORDER BY n DESC`, orgId,
    );
    const nextAt = this.ctx.db.pluck<number>(
      `SELECT MIN(next_attempt_at) FROM payments_dunning WHERE org_id = ? AND status = 'recovering' AND next_attempt_at IS NOT NULL`,
      orgId,
    );
    const needsHuman = this.list(orgId, { status: 'open', limit: 200 }).data
      .filter((campaign) => this.view(orgId, campaign).needs_human).length;

    return {
      object: 'dunning_summary',
      open_campaigns: byStatus.recovering ?? 0,
      needs_human: needsHuman,
      recovered_campaigns: byStatus.recovered ?? 0,
      exhausted_campaigns: byStatus.exhausted ?? 0,
      totals: perCurrency.map((row) => {
        const recovered = Number(row.recovered);
        const lost = Number(row.lost);
        const decided = recovered + lost;
        return {
          currency: row.currency,
          amount_at_risk: Number(row.at_risk),
          recovered_amount: recovered,
          lost_amount: lost,
          // Exact: a ratio of two integers scaled and rounded once, rather
          // than a float that has been through a division and a product.
          recovery_rate_bps: decided > 0 ? Number(ratRound(ratMul(rat(recovered, decided), rat(10_000)))) : 0,
        };
      }),
      attempts: {
        total: outcomes.reduce((total, row) => total + Number(row.n), 0),
        succeeded: byOutcome.succeeded ?? 0,
        failed: byOutcome.failed ?? 0,
        skipped: byOutcome.skipped ?? 0,
      },
      by_decline: declines.map((row) => ({
        code: row.failure_code, severity: severityOf(row.failure_code), attempts: Number(row.n),
      })),
      next_attempt_at: nextAt ?? null,
    };
  }

  /* ------------------------------- the campaign --------------------------- */

  /** Open the campaign for this bill, or reopen the one that is already there. */
  private open(orgId: string, invoice: Invoice): Dunning {
    const existing = this.forInvoice(orgId, invoice.id);
    const now = this.ctx.now();
    if (existing) {
      if (existing.status !== 'recovering') {
        this.ctx.db.patch('payments_dunning', 'id', existing.id, {
          status: 'recovering', resolved_at: null, resolution: null,
          amount_at_risk: invoice.amount_due, updated: now,
        });
        return this.require(orgId, existing.id);
      }
      if (existing.amount_at_risk !== invoice.amount_due) {
        this.ctx.db.patch('payments_dunning', 'id', existing.id, { amount_at_risk: invoice.amount_due, updated: now });
        return this.require(orgId, existing.id);
      }
      return existing;
    }
    const policy = this.policy(orgId);
    const id = randomId('dun');
    // The policy is snapshotted onto the campaign. Changing the workspace's
    // schedule tomorrow must not rewrite the story of a recovery that is
    // already running — or make yesterday's attempt counts stop adding up.
    this.ctx.db.insert('payments_dunning', {
      id, org_id: orgId, invoice_id: invoice.id, customer_id: invoice.customer,
      subscription_id: invoice.subscription, currency: invoice.currency,
      amount_at_risk: invoice.amount_due, recovered_amount: 0, status: 'recovering',
      attempt_count: 0, max_attempts: policy.max_attempts,
      retry_days: policy.retry_days as any, end_behavior: policy.end_behavior,
      next_attempt_at: null, last_attempt_at: null, last_failure_code: null, last_failure_message: null,
      started_at: now, resolved_at: null, resolution: null, created: now, updated: now,
    } as any);
    const campaign = this.require(orgId, id);
    this.ctx.emit(orgId, 'dunning.started', campaign, { objectId: id, objectType: 'dunning' });
    return campaign;
  }

  private writeAttempt(
    orgId: string, campaign: Dunning,
    input: {
      attemptNumber: number; scheduledFor: number; outcome: DunningAttemptOutcome;
      methodId: string | null; intentId: string | null; chargeId: string | null;
      amount: number; failure: { code: DeclineCode; message: string } | null;
      decision: string; nextAttemptAt: number | null;
    },
  ): DunningAttempt {
    const now = this.ctx.now();
    const id = randomId('dnat');
    this.ctx.db.insert('payments_dunning_attempts', {
      id, org_id: orgId, dunning_id: campaign.id, invoice_id: campaign.invoice,
      customer_id: campaign.customer, subscription_id: campaign.subscription,
      attempt_number: input.attemptNumber, scheduled_for: input.scheduledFor, attempted_at: now,
      payment_method_id: input.methodId, payment_intent_id: input.intentId, charge_id: input.chargeId,
      amount: input.amount, currency: campaign.currency, outcome: input.outcome,
      failure_code: input.failure?.code ?? null, failure_message: input.failure?.message ?? null,
      decision: input.decision, next_attempt_at: input.nextAttemptAt, created: now,
    } as any);
    return hydrateAttempt(this.ctx.db.get<any>(`SELECT * FROM payments_dunning_attempts WHERE id = ?`, id));
  }

  /* ------------------------------ the callbacks --------------------------- */

  /**
   * A collection attempt that was not made by dunning itself has failed —
   * the automatic charge when the invoice was raised, or a human retry.
   */
  onCollectionFailed(
    orgId: string, invoice: Invoice, intent: PaymentIntent, charge: Charge | null,
    failure: { code: DeclineCode; message: string; advice: string },
  ): void {
    if (invoice.collection_method === 'send_invoice') return;
    const campaign = this.open(orgId, invoice);
    this.recordFailure(orgId, campaign, {
      attemptNumber: campaign.attempt_count + 1,
      scheduledFor: campaign.next_attempt_at ?? this.ctx.now(),
      intentId: intent.id, chargeId: charge?.id ?? null, methodId: intent.payment_method,
      amount: intent.amount, failure,
    });
  }

  /** A bill was collected outside a scheduled retry: close the campaign. */
  onCollectionSucceeded(orgId: string, invoice: Invoice, intent: PaymentIntent, charge: Charge): void {
    const campaign = this.forInvoice(orgId, invoice.id);
    if (!campaign || campaign.status !== 'recovering') return;
    this.recordRecovery(orgId, campaign, {
      attemptNumber: campaign.attempt_count + 1,
      scheduledFor: campaign.next_attempt_at ?? this.ctx.now(),
      intentId: intent.id, chargeId: charge.id, methodId: intent.payment_method, amount: charge.amount,
    });
  }

  /** Stop chasing a bill — it was voided, credited, disputed away, or forgiven. */
  stopFor(orgId: string, invoiceId: string, reason: string, meta: WriteMeta = {}): void {
    const campaign = this.forInvoice(orgId, invoiceId);
    if (!campaign || campaign.status !== 'recovering') return;
    const now = this.ctx.now();
    this.ctx.db.patch('payments_dunning', 'id', campaign.id, {
      status: 'canceled', resolved_at: now, resolution: reason, next_attempt_at: null, updated: now,
    });
    this.ctx.jobs.cancel(orgId, { idemKey: `payments.dunning_retry:${campaign.id}` }, now);
    this.ctx.emit(orgId, 'dunning.canceled', this.require(orgId, campaign.id), {
      objectId: campaign.id, objectType: 'dunning', previous: { status: campaign.status },
      actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
    });
  }

  cancel(orgId: string, id: string, reason: string | null, meta: WriteMeta = {}): Dunning {
    return this.ctx.atomic(() => {
      const campaign = this.require(orgId, id);
      if (campaign.status !== 'recovering') {
        throw conflict('dunning_not_running', `This campaign is already ${campaign.status}.`, { status: campaign.status });
      }
      this.stopFor(
        orgId, campaign.invoice,
        reason ?? 'Recovery stopped by hand — this account is being chased another way.', meta,
      );
      return this.require(orgId, id);
    });
  }

  /* ------------------------------- the outcomes --------------------------- */

  private recordFailure(
    orgId: string, campaign: Dunning,
    input: {
      attemptNumber: number; scheduledFor: number; intentId: string | null; chargeId: string | null;
      methodId: string | null; amount: number; failure: { code: DeclineCode; message: string; advice: string };
    },
  ): DunningAttempt {
    const now = this.ctx.now();
    const policy = this.policy(orgId);
    const severity = severityOf(input.failure.code);
    const org = this.orgFormat(orgId);
    const givingUp = policy.give_up_codes.includes(input.failure.code) || severity === 'final';
    const outOfAttempts = input.attemptNumber >= campaign.max_attempts;

    let nextAt: number | null = null;
    let decision: string;
    if (givingUp) {
      decision = `Attempt ${input.attemptNumber} was refused with ${input.failure.code}, which waiting cannot fix. ${campaign.max_attempts - input.attemptNumber} scheduled retr${campaign.max_attempts - input.attemptNumber === 1 ? 'y was' : 'ies were'} dropped: ${input.failure.advice}`;
    } else if (outOfAttempts) {
      decision = `Attempt ${input.attemptNumber} of ${campaign.max_attempts} was refused with ${input.failure.code}. The schedule is spent, so recovery ends here.`;
    } else {
      nextAt = this.nextAttemptAt(policy, {
        invoiceId: campaign.invoice, failedAttempt: input.attemptNumber, from: now, severity, now,
      });
      const gapDays = Math.max(1, Math.round((nextAt - now) / DAY));
      decision = severity === 'hard'
        ? `Attempt ${input.attemptNumber} was refused with ${input.failure.code}, a hard decline, so the usual gap is stretched ${policy.hard_decline_multiplier}x. Attempt ${input.attemptNumber + 1} of ${campaign.max_attempts} is scheduled for ${formatDate(nextAt, { ...org, withTime: true })}, ${gapDays} day${gapDays === 1 ? '' : 's'} out.`
        : `Attempt ${input.attemptNumber} was refused with ${input.failure.code}. Attempt ${input.attemptNumber + 1} of ${campaign.max_attempts} is scheduled for ${formatDate(nextAt, { ...org, withTime: true })}, ${gapDays} day${gapDays === 1 ? '' : 's'} out.`;
    }

    this.ctx.db.patch('payments_dunning', 'id', campaign.id, {
      attempt_count: input.attemptNumber, last_attempt_at: now, next_attempt_at: nextAt,
      last_failure_code: input.failure.code, last_failure_message: input.failure.message, updated: now,
    });
    const attempt = this.writeAttempt(orgId, campaign, {
      attemptNumber: input.attemptNumber, scheduledFor: input.scheduledFor, outcome: 'failed',
      methodId: input.methodId, intentId: input.intentId, chargeId: input.chargeId,
      amount: input.amount, failure: { code: input.failure.code, message: input.failure.message },
      decision, nextAttemptAt: nextAt,
    });

    const after = this.require(orgId, campaign.id);
    this.ctx.emit(orgId, 'dunning.attempt_failed', { campaign: after, attempt }, {
      objectId: campaign.id, objectType: 'dunning',
    });

    if (nextAt !== null) {
      this.ctx.enqueue(orgId, 'payments.dunning_retry', { dunning: campaign.id }, {
        runAt: nextAt, idemKey: `payments.dunning_retry:${campaign.id}`,
      });
      return attempt;
    }
    this.exhaust(orgId, after, givingUp ? 'decline_is_final' : 'attempts_exhausted', input.failure);
    return attempt;
  }

  private recordRecovery(
    orgId: string, campaign: Dunning,
    input: { attemptNumber: number; scheduledFor: number; intentId: string | null; chargeId: string | null; methodId: string | null; amount: number },
  ): void {
    const now = this.ctx.now();
    const org = this.orgFormat(orgId);
    const shown = formatMoney(money(input.amount, campaign.currency), { locale: org.locale });
    const resolution = `${shown} recovered on attempt ${input.attemptNumber} of ${campaign.max_attempts}, ${Math.max(1, Math.round((now - campaign.started_at) / DAY))} day(s) after the first failure.`;
    this.ctx.db.patch('payments_dunning', 'id', campaign.id, {
      status: 'recovered', attempt_count: input.attemptNumber, last_attempt_at: now,
      next_attempt_at: null, recovered_amount: input.amount, resolved_at: now, resolution, updated: now,
    });
    this.writeAttempt(orgId, campaign, {
      attemptNumber: input.attemptNumber, scheduledFor: input.scheduledFor, outcome: 'succeeded',
      methodId: input.methodId, intentId: input.intentId, chargeId: input.chargeId,
      amount: input.amount, failure: null,
      decision: `The charge was authorised, so the invoice is settled and recovery stops here. ${resolution}`,
      nextAttemptAt: null,
    });
    this.ctx.jobs.cancel(orgId, { idemKey: `payments.dunning_retry:${campaign.id}` }, now);
    const after = this.require(orgId, campaign.id);
    this.ctx.emit(orgId, 'dunning.recovered', after, {
      objectId: campaign.id, objectType: 'dunning', previous: { status: campaign.status },
    });
  }

  /**
   * Recovery is over and the money did not arrive.
   *
   * What happens to the subscription is deliberately *not* done here. The same
   * failed attempt has just emitted `invoice.payment_failed`, which billing
   * turns into `past_due` when its handler runs at the end of this
   * transaction — so a status written now would be overwritten a moment later
   * by an event that was already in flight. Instead the decision rides on
   * `dunning.exhausted`, which is emitted after it, and `applyEnd` carries it
   * out once every other subscriber has had its say.
   */
  private exhaust(
    orgId: string, campaign: Dunning, reason: ExhaustionReason,
    failure: { code: DeclineCode; message: string; advice: string },
  ): void {
    const now = this.ctx.now();
    const org = this.orgFormat(orgId);
    const shown = formatMoney(money(campaign.amount_at_risk, campaign.currency), { locale: org.locale });
    const resolution = reason === 'decline_is_final'
      ? `Gave up after attempt ${campaign.attempt_count}: ${failure.code} will not clear by waiting.`
      : reason === 'nothing_to_present'
        ? `The schedule ran out with nothing left to present: ${failure.advice}`
        : `All ${campaign.max_attempts} attempts were refused, the last with ${failure.code}.`;
    this.ctx.db.patch('payments_dunning', 'id', campaign.id, {
      status: 'exhausted', next_attempt_at: null, resolved_at: now, resolution, updated: now,
    });
    this.ctx.jobs.cancel(orgId, { idemKey: `payments.dunning_retry:${campaign.id}` }, now);
    const after = this.require(orgId, campaign.id);
    this.ctx.emit(orgId, 'dunning.exhausted', {
      campaign: after,
      invoice: campaign.invoice,
      customer: campaign.customer,
      subscription: campaign.subscription,
      amount_at_risk: campaign.amount_at_risk,
      currency: campaign.currency,
      attempts: campaign.attempt_count,
      max_attempts: campaign.max_attempts,
      reason,
      failure_code: failure.code,
      end_behavior: campaign.end_behavior,
      amount_lost: shown,
    }, { objectId: campaign.id, objectType: 'dunning', previous: { status: campaign.status } });
  }

  /**
   * Carry out the workspace's end behaviour, once and only once.
   *
   * Every path through here goes via billing's own `transition` or its cancel,
   * because payments does not own a subscription's status column and writing
   * it directly would step around the one machine that knows which moves are
   * legal.
   */
  applyEnd(orgId: string, campaignId: string): void {
    const campaign = this.campaign(orgId, campaignId);
    if (!campaign || campaign.status !== 'exhausted') return;
    const done = this.ctx.db.pluck<string>(
      `SELECT end_behavior_applied FROM payments_dunning WHERE org_id = ? AND id = ?`, orgId, campaignId,
    );
    if (done) return;
    const code = campaign.last_failure_code ?? 'card_declined';
    const applied = this.applyEndBehavior(orgId, campaign, {
      code, message: DECLINES[code].message, advice: DECLINES[code].advice,
    });
    this.ctx.db.patch('payments_dunning', 'id', campaignId, {
      end_behavior_applied: applied,
      resolution: `${campaign.resolution ?? 'Recovery ended.'} ${applied}`,
      updated: this.ctx.now(),
    });
  }

  private applyEndBehavior(
    orgId: string, campaign: Dunning, failure: { code: DeclineCode; message: string; advice: string },
  ): string {
    const behavior: DunningEndBehavior = campaign.end_behavior;
    if (!campaign.subscription) {
      return 'The bill stays open and is now a manual collection.';
    }
    const sub = this.ctx.svc.billing.subscription(orgId, campaign.subscription);
    if (!sub || sub.status === 'canceled' || sub.status === 'incomplete_expired') {
      return 'The subscription had already ended, so nothing further was changed.';
    }
    if (behavior === 'leave_past_due') {
      return `The subscription stays past due and keeps its service, per this workspace's end behaviour. ${failure.advice}`;
    }
    if (behavior === 'cancel') {
      this.billing.cancelSubscription(orgId, sub.id, {
        cancellation_reason: 'payment_failed',
        comment: `Dunning exhausted after ${campaign.attempt_count} attempts; the last was refused with ${failure.code}.`,
      }, { actorType: 'system' });
      return 'The subscription was cancelled, per this workspace’s end behaviour.';
    }
    // `unpaid` stops collection without destroying the subscription or its
    // history — the state a customer can be brought back from.
    if (sub.status === 'unpaid') return 'The subscription was already marked unpaid.';
    this.billing.transition(orgId, sub, 'unpaid', { meta: { actorType: 'system' } });
    return 'The subscription was marked unpaid, so it stops being collected but keeps its history and can be revived.';
  }

  /* -------------------------------- the retry ----------------------------- */

  /** One scheduled attempt. Called only by the `payments.dunning_retry` job. */
  runScheduledAttempt(orgId: string, dunningId: string): void {
    this.ctx.atomic(() => {
      const campaign = this.campaign(orgId, dunningId);
      if (!campaign || campaign.status !== 'recovering') return;
      const scheduledFor = campaign.next_attempt_at ?? this.ctx.now();
      const invoice = this.billing.invoices.invoice(orgId, campaign.invoice);
      if (!invoice) {
        this.stopFor(orgId, campaign.invoice, 'The invoice this campaign was chasing no longer exists.');
        return;
      }
      const blocked = this.payments.gateway.uncollectableReason(invoice);
      if (blocked) {
        this.stopFor(orgId, campaign.invoice, `${blocked} Recovery stopped.`);
        return;
      }

      const attemptNumber = campaign.attempt_count + 1;
      const result = this.payments.gateway.collectForDunning(orgId, invoice.id);

      // A direct debit is not answered on the spot. The instruction has been
      // presented; the bank replies in a few working days, and the settlement
      // records this attempt then. Writing a failure now would be reporting a
      // refusal nobody has made.
      if (result.intent?.status === 'processing') {
        const settlesAt = this.ctx.now() + BANK_DEBIT_SETTLEMENT_DAYS * DAY;
        this.ctx.db.patch('payments_dunning', 'id', campaign.id, {
          last_attempt_at: this.ctx.now(), next_attempt_at: settlesAt, updated: this.ctx.now(),
        });
        return;
      }

      if (result.collected && result.charge) {
        this.recordRecovery(orgId, campaign, {
          attemptNumber, scheduledFor,
          intentId: result.intent?.id ?? null, chargeId: result.charge.id,
          methodId: result.method?.id ?? null, amount: result.charge.amount,
        });
        return;
      }
      if (result.failure) {
        this.recordFailure(orgId, campaign, {
          attemptNumber, scheduledFor,
          intentId: result.intent?.id ?? null, chargeId: result.charge?.id ?? null,
          methodId: result.method?.id ?? null, amount: result.intent?.amount ?? invoice.amount_due,
          failure: result.failure,
        });
        return;
      }
      // Nothing was presented at all: there is no usable method on the account.
      // It still costs the campaign an attempt, because a recovery step that
      // cannot run is a recovery step that failed, and pretending otherwise
      // would retry an account with no card on it forever.
      this.recordSkipped(orgId, campaign, attemptNumber, scheduledFor, invoice, result.skipped ?? 'Nothing could be presented.');
    });
  }

  private recordSkipped(
    orgId: string, campaign: Dunning, attemptNumber: number, scheduledFor: number,
    invoice: Invoice, why: string,
  ): void {
    const now = this.ctx.now();
    const policy = this.policy(orgId);
    const org = this.orgFormat(orgId);
    const outOfAttempts = attemptNumber >= campaign.max_attempts;
    const nextAt = outOfAttempts ? null : this.nextAttemptAt(policy, {
      invoiceId: campaign.invoice, failedAttempt: attemptNumber, from: now, severity: 'soft', now,
    });
    const decision = nextAt
      ? `${why} Attempt ${attemptNumber} could not be presented; the next window is ${formatDate(nextAt, { ...org, withTime: true })}.`
      : `${why} That was the last scheduled window, so recovery ends here.`;
    this.ctx.db.patch('payments_dunning', 'id', campaign.id, {
      attempt_count: attemptNumber, last_attempt_at: now, next_attempt_at: nextAt, updated: now,
    });
    this.writeAttempt(orgId, campaign, {
      attemptNumber, scheduledFor, outcome: 'skipped', methodId: null, intentId: null, chargeId: null,
      amount: invoice.amount_due, failure: null, decision, nextAttemptAt: nextAt,
    });
    if (nextAt !== null) {
      this.ctx.enqueue(orgId, 'payments.dunning_retry', { dunning: campaign.id }, {
        runAt: nextAt, idemKey: `payments.dunning_retry:${campaign.id}`,
      });
      return;
    }
    const last = campaign.last_failure_code ?? 'card_declined';
    this.exhaust(orgId, this.require(orgId, campaign.id), 'nothing_to_present', {
      code: last, message: DECLINES[last].message, advice: why,
    });
  }

  private orgFormat(orgId: string): { locale: string; timeZone: string } {
    try {
      const org = this.ctx.svc.core.org(orgId);
      return { locale: org.locale || 'en-US', timeZone: org.timezone || 'UTC' };
    } catch { return { locale: 'en-US', timeZone: 'UTC' }; }
  }
}
