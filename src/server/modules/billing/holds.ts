/**
 * The bill that waits for the window it settles.
 *
 * A renewal names two periods: the one it bills in advance and the one that
 * just closed, whose metered usage is priced by the credits module *after* the
 * renewal commits — settlement is a job that reacts to the renewal's own
 * event. Drawing the invoice inside the renewal therefore drew it a few
 * milliseconds too early: `arrears_period` said "usage settled for September",
 * and September's usage arrived on October's bill. Every metered charge landed
 * one cycle late, and a customer who left in between was never charged for
 * their last month at all.
 *
 * So a cycle with metered items no longer draws its bill on the spot. It opens
 * a hold: the recurring lines, priced and frozen; the closed window; the
 * metered items whose settlement it is waiting for; and the date the bill is
 * dated. The hold draws the moment the last of those windows is settled — or
 * skipped, which is a settlement that decided not to — and the bill it draws
 * claims the usage lines the settlement produced. A window nothing ever
 * settles, because a job is stuck retrying, cannot hold a bill forever: an
 * hour after the boundary the hold draws with whatever has arrived, and the
 * rest reaches the next bill exactly as it always did.
 *
 * The same hold ends a subscription. A cancellation's final invoice waits for
 * the part-period the customer actually used, then sweeps that usage and every
 * proration still waiting onto one last document.
 */
import type { Ctx } from '../../kernel/context';
import { parseJson } from '../../kernel/db';
import { randomId } from '../../../shared/ids';
import { HOUR, type Period } from '../../../shared/time';
import type { WriteMeta } from './records';
import type { Invoice, InvoiceBillingReason, RecurringLine, Subscription } from './types';

/** How long a hold waits for a settlement that has not arrived before it draws anyway. */
export const HOLD_DEADLINE_MS = HOUR;

export const HOLD_RELEASE_JOB = 'billing.release_invoice_hold';

export type InvoiceHoldStatus = 'awaiting' | 'drawn' | 'released';

/** Why a hold stopped waiting. `released` holds carry it too: they drew nothing. */
export type InvoiceHoldReleaseReason = 'settled' | 'announced' | 'deadline';

export interface AwaitedSettlement {
  price: string;
  subscription_item: string | null;
  settled: boolean;
}

export interface InvoiceHold {
  object: 'invoice_hold';
  id: string;
  subscription: string;
  customer: string;
  billing_reason: InvoiceBillingReason;
  period: Period;
  /** The closed window whose usage the bill is waiting for. */
  arrears_period: Period;
  /** The advance lines, priced when the cycle turned so a later change cannot move them. */
  recurring: RecurringLine[];
  awaiting: AwaitedSettlement[];
  /**
   * Whether credits will announce what it holds for this bill. A cycle raises
   * `subscription.invoice_due`, which credits answers with `credit.items_ready`
   * once the window is priced; a cancellation raises nothing, so its hold
   * draws on the settlement itself.
   */
  awaits_announcement: boolean;
  /** The date the bill carries — the cycle boundary, not whenever it was drawn. */
  bill_date: number;
  deadline: number;
  status: InvoiceHoldStatus;
  release_reason: InvoiceHoldReleaseReason | null;
  invoice: string | null;
  created: number;
  updated: number;
}

export interface OpenHoldInput {
  reason: InvoiceBillingReason;
  period: Period;
  arrearsPeriod: Period;
  recurring: RecurringLine[];
  billDate: number;
  awaitsAnnouncement: boolean;
  meta?: WriteMeta;
}

/** The little of the credits module a hold reads: whether anything is waiting to be billed. */
interface CreditsReader {
  billableItems(orgId: string, filter: { customer?: string; status?: 'pending'; limit?: number }): unknown[];
}

/** What a hold needs from the store that owns it. */
export interface HoldDrawer {
  requireSubscription(orgId: string, id: string): Subscription;
  drawHeldInvoice(orgId: string, hold: InvoiceHold): Invoice | null;
}

export function hydrateHold(row: any): InvoiceHold {
  return {
    object: 'invoice_hold',
    id: row.id,
    subscription: row.subscription_id,
    customer: row.customer_id,
    billing_reason: row.billing_reason,
    period: { start: Number(row.period_start), end: Number(row.period_end) },
    arrears_period: { start: Number(row.arrears_start), end: Number(row.arrears_end) },
    recurring: parseJson<RecurringLine[]>(row.recurring, []),
    awaiting: parseJson<AwaitedSettlement[]>(row.awaiting, []),
    awaits_announcement: Number(row.awaits_announcement) === 1,
    bill_date: Number(row.bill_date),
    deadline: Number(row.deadline),
    status: row.status as InvoiceHoldStatus,
    release_reason: (row.release_reason ?? null) as InvoiceHoldReleaseReason | null,
    invoice: row.invoice_id ?? null,
    created: Number(row.created),
    updated: Number(row.updated),
  };
}

export class InvoiceHolds {
  constructor(private readonly ctx: Ctx, private readonly billing: HoldDrawer) {}

  private credits(): CreditsReader | null {
    const registry = this.ctx.svc as { credits?: CreditsReader };
    return registry.credits ?? null;
  }

  /**
   * Open a hold for a bill whose closed window has metered usage to settle.
   *
   * Returns null — draw the bill now — when there is nothing to wait for: no
   * metered item, no window, or no credits module to price one. That is the
   * behaviour every bill had before holds existed, and it is still right for
   * every bill that has no usage on it.
   */
  open(orgId: string, sub: Subscription, input: OpenHoldInput): InvoiceHold | null {
    if (!(input.arrearsPeriod.end > input.arrearsPeriod.start)) return null;
    if (!this.credits()) return null;
    const awaiting: AwaitedSettlement[] = sub.items
      .filter((item) => item.metered)
      .map((item) => ({ price: item.price, subscription_item: item.id, settled: false }));
    if (!awaiting.length) return null;

    const now = this.ctx.now();
    const id = randomId('hold');
    this.ctx.db.insert('billing_invoice_holds', {
      id,
      org_id: orgId,
      subscription_id: sub.id,
      customer_id: sub.customer,
      billing_reason: input.reason,
      period_start: input.period.start,
      period_end: input.period.end,
      arrears_start: input.arrearsPeriod.start,
      arrears_end: input.arrearsPeriod.end,
      recurring: input.recurring as any,
      awaiting: awaiting as any,
      awaits_announcement: input.awaitsAnnouncement ? 1 : 0,
      bill_date: input.billDate,
      deadline: now + HOLD_DEADLINE_MS,
      status: 'awaiting',
      release_reason: null,
      invoice_id: null,
      meta: (input.meta ?? {}) as any,
      created: now,
      updated: now,
    });
    this.ctx.enqueue(orgId, HOLD_RELEASE_JOB, { hold: id }, {
      runAt: now + HOLD_DEADLINE_MS, idemKey: `${HOLD_RELEASE_JOB}:${id}`,
    });
    const hold = this.require(orgId, id);
    this.ctx.emit(orgId, 'invoice_hold.opened', hold, { objectId: sub.id, objectType: 'subscription' });
    return hold;
  }

  hold(orgId: string, id: string): InvoiceHold | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM billing_invoice_holds WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydrateHold(row) : null;
  }

  private require(orgId: string, id: string): InvoiceHold {
    const found = this.hold(orgId, id);
    if (!found) throw new Error(`Invoice hold ${id} vanished inside its own transaction.`);
    return found;
  }

  awaiting(orgId: string, filter: { customer?: string; subscription?: string } = {}): InvoiceHold[] {
    const clauses = ['org_id = ?', `status = 'awaiting'`];
    const params: unknown[] = [orgId];
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.subscription) { clauses.push('subscription_id = ?'); params.push(filter.subscription); }
    return this.ctx.db.all<any>(
      `SELECT * FROM billing_invoice_holds WHERE ${clauses.join(' AND ')} ORDER BY created ASC, rowid ASC`,
      ...(params as any[]),
    ).map(hydrateHold);
  }

  /**
   * A window was priced — or refused, which for a bill is the same news: no
   * line is coming for it. Tick it off every hold waiting on it, and draw the
   * ones with nothing left to wait for.
   *
   * A cycle's hold has one more thing to wait for when the settlement left
   * lines in the outbox: credits announces those on `credit.items_ready`, and
   * that announcement is the seam other modules read the priced usage from
   * before any bill claims it. So the hold draws on the announcement instead —
   * unless the outbox is empty, in which case no announcement is coming and
   * the settlement was the last word.
   */
  onSettled(
    orgId: string,
    settlement: { customer: string; price: string; subscription: string | null; period_start: number; period_end: number },
  ): Invoice[] {
    return this.ctx.atomic(() => {
      const drawn: Invoice[] = [];
      for (const hold of this.awaiting(orgId, { customer: settlement.customer })) {
        if (hold.arrears_period.start !== settlement.period_start || hold.arrears_period.end !== settlement.period_end) continue;
        if (settlement.subscription && settlement.subscription !== hold.subscription) continue;
        if (!hold.awaiting.some((entry) => entry.price === settlement.price && !entry.settled)) continue;

        const awaiting = hold.awaiting.map((entry) => (entry.price === settlement.price ? { ...entry, settled: true } : entry));
        this.ctx.db.patch('billing_invoice_holds', 'id', hold.id, { awaiting: awaiting as any, updated: this.ctx.now() });
        if (awaiting.some((entry) => !entry.settled)) continue;
        if (hold.awaits_announcement && this.outboxHolds(orgId, hold.customer)) continue;

        const invoice = this.draw(orgId, hold.id, 'settled');
        if (invoice) drawn.push(invoice);
      }
      return drawn;
    });
  }

  /** Credits has announced the lines it holds for this subscription's next bill. */
  onAnnounced(orgId: string, announcement: { customer: string; subscription: string | null }): Invoice[] {
    return this.ctx.atomic(() => {
      const drawn: Invoice[] = [];
      const holds = announcement.subscription
        ? this.awaiting(orgId, { subscription: announcement.subscription })
        : this.awaiting(orgId, { customer: announcement.customer });
      for (const hold of holds) {
        if (!hold.awaits_announcement) continue;
        if (hold.awaiting.some((entry) => !entry.settled)) continue;
        const invoice = this.draw(orgId, hold.id, 'announced');
        if (invoice) drawn.push(invoice);
      }
      return drawn;
    });
  }

  /** The deadline job: whatever has not arrived by now goes on the next bill. */
  expire(orgId: string, holdId: string): Invoice | null {
    return this.ctx.atomic(() => this.draw(orgId, holdId, 'deadline'));
  }

  private outboxHolds(orgId: string, customerId: string): boolean {
    const credits = this.credits();
    if (!credits) return false;
    return credits.billableItems(orgId, { customer: customerId, status: 'pending', limit: 1 }).length > 0;
  }

  /**
   * Draw the bill a hold was opened for. The claim on the row is the guard: a
   * settlement, an announcement and the deadline can all arrive for one hold,
   * and exactly one of them gets to draw.
   */
  private draw(orgId: string, holdId: string, reason: InvoiceHoldReleaseReason): Invoice | null {
    return this.ctx.atomic(() => {
      const now = this.ctx.now();
      const claimed = this.ctx.db.run(
        `UPDATE billing_invoice_holds SET status = 'drawn', release_reason = ?, updated = ?
          WHERE org_id = ? AND id = ? AND status = 'awaiting'`,
        reason, now, orgId, holdId,
      ).changes;
      if (claimed !== 1) return null;
      const hold = this.require(orgId, holdId);
      const invoice = this.billing.drawHeldInvoice(orgId, hold);
      this.ctx.db.patch('billing_invoice_holds', 'id', holdId, {
        status: invoice ? 'drawn' : 'released', invoice_id: invoice?.id ?? null, updated: now,
      });
      this.ctx.jobs.cancel(orgId, { idemKey: `${HOLD_RELEASE_JOB}:${holdId}` }, now);
      this.ctx.emit(orgId, 'invoice_hold.released', {
        ...this.require(orgId, holdId),
        invoice: invoice?.id ?? null,
        invoice_number: invoice?.number ?? null,
        invoice_total: invoice?.total ?? 0,
      }, { objectId: hold.subscription, objectType: 'subscription' });
      return invoice;
    });
  }
}
