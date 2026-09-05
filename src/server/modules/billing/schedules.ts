/**
 * Subscription schedules — a subscription's future, written down.
 *
 * A schedule is an ordered list of phases. Each phase names the items that run
 * during it, how long it lasts (an iteration count or an end date), how a move
 * into it should be prorated, and optionally a trial. When the last phase ends
 * the schedule either releases the subscription to carry on as it is, or
 * cancels it.
 *
 * Phases advance on a job at the phase boundary, never on a timer, so a year of
 * a three-phase ramp replays exactly under `POST /v1/time/advance`.
 */
import type { Ctx } from '../../kernel/context';
import { parseJson } from '../../kernel/db';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { cursorOf, newId, parseCursor } from '../../../shared/ids';
import { addInterval, type Interval } from '../../../shared/time';
import type { ProrationBehavior } from '../catalog/types';
import { assertFlatQuantity, isMetered, resolveInterval } from './cycle';
import type { Billing } from './store';
import type { Page, WriteMeta } from './records';
import type {
  CollectionMethod, SchedulePhase, SchedulePhaseItem, ScheduleEndBehavior, ScheduleStatus,
  Subscription, SubscriptionSchedule,
} from './types';

export interface PhaseInput {
  items: { price: string; quantity?: number; custom_unit_amount?: number | null; metadata?: Record<string, string> }[];
  iterations?: number;
  end_date?: number;
  start_date?: number;
  proration_behavior?: ProrationBehavior;
  trial?: boolean;
  trial_end?: number;
  collection_method?: CollectionMethod;
  days_until_due?: number | null;
  description?: string | null;
  metadata?: Record<string, string>;
}

export interface ScheduleCreateInput {
  id?: string;
  customer?: string;
  /** Take an existing subscription under management from its current period. */
  from_subscription?: string;
  start_date?: number;
  end_behavior?: ScheduleEndBehavior;
  phases: PhaseInput[];
  metadata?: Record<string, string>;
}

export interface ScheduleUpdateInput {
  phases?: PhaseInput[];
  end_behavior?: ScheduleEndBehavior;
  metadata?: Record<string, string>;
}

export interface ScheduleListFilter {
  customer?: string;
  status?: ScheduleStatus | 'all';
  subscription?: string;
  limit?: number;
  cursor?: string | null;
}

export function hydrateSchedule(row: any): SubscriptionSchedule {
  return {
    object: 'subscription_schedule',
    id: row.id,
    customer: row.customer_id,
    subscription: row.subscription_id ?? null,
    status: row.status as ScheduleStatus,
    phases: parseJson<SchedulePhase[]>(row.phases, []),
    current_phase: row.current_phase === null || row.current_phase === undefined ? null : Number(row.current_phase),
    end_behavior: row.end_behavior as ScheduleEndBehavior,
    released_at: row.released_at === null ? null : Number(row.released_at),
    canceled_at: row.canceled_at === null ? null : Number(row.canceled_at),
    completed_at: row.completed_at === null ? null : Number(row.completed_at),
    start_date: Number(row.start_date),
    metadata: parseJson<Record<string, string>>(row.metadata, {}),
    created: Number(row.created),
    updated: Number(row.updated),
    livemode: !!row.livemode,
  };
}

export class Schedules {
  constructor(private readonly ctx: Ctx, private readonly billing: Billing) {}

  schedule(orgId: string, id: string): SubscriptionSchedule | null {
    const row = this.ctx.db.get<any>(`SELECT * FROM billing_subscription_schedules WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydrateSchedule(row) : null;
  }

  require(orgId: string, id: string): SubscriptionSchedule {
    const found = this.schedule(orgId, id);
    if (!found) throw notFound('subscription schedule', id);
    return found;
  }

  list(orgId: string, filter: ScheduleListFilter = {}): Page<SubscriptionSchedule> {
    const clauses = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.subscription) { clauses.push('subscription_id = ?'); params.push(filter.subscription); }
    if (filter.status && filter.status !== 'all') { clauses.push('status = ?'); params.push(filter.status); }
    const where = clauses.join(' AND ');
    const totalCount = this.ctx.db.count(`SELECT COUNT(*) FROM billing_subscription_schedules WHERE ${where}`, ...(params as any[]));

    const paged = [...params];
    let cursorClause = '';
    if (filter.cursor) {
      const parsed = parseCursor(filter.cursor);
      if (!parsed) throw badRequest('cursor_invalid', 'That pagination cursor is not readable. Start the list again.', 'cursor');
      cursorClause = ' AND (created < ? OR (created = ? AND id < ?))';
      paged.push(parsed.createdAt, parsed.createdAt, parsed.id);
    }
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
    const rows = this.ctx.db.all<any>(
      `SELECT * FROM billing_subscription_schedules WHERE ${where}${cursorClause} ORDER BY created DESC, id DESC LIMIT ?`,
      ...(paged as any[]), limit + 1,
    );
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(hydrateSchedule);
    const last = data[data.length - 1];
    return { data, hasMore, nextCursor: hasMore && last ? cursorOf(last.created, last.id) : null, totalCount };
  }

  /* --------------------------------- create ------------------------------- */

  create(orgId: string, input: ScheduleCreateInput, meta: WriteMeta = {}): SubscriptionSchedule {
    return this.ctx.atomic(() => {
      const now = this.ctx.now();
      const book = this.billing.book(orgId);
      const existing = input.from_subscription ? this.billing.requireSubscription(orgId, input.from_subscription) : null;
      if (existing?.schedule) {
        throw conflict('subscription_already_scheduled', `Subscription ${existing.id} is already managed by schedule ${existing.schedule}.`);
      }
      const customerId = input.customer ?? existing?.customer;
      if (!customerId) throw badRequest('customer_required', 'A schedule needs a customer, or a subscription to take over.', 'customer');
      const customer = this.billing.requireCustomer(orgId, customerId);
      if (!input.phases.length) throw badRequest('phases_required', 'A schedule needs at least one phase.', 'phases');

      const startDate = input.start_date ?? existing?.current_period_start ?? now;
      const phases = this.buildPhases(input.phases, startDate, book);

      const id = input.id ?? newId('schedule');
      this.ctx.db.insert('billing_subscription_schedules', {
        id, org_id: orgId, customer_id: customer.id,
        subscription_id: existing?.id ?? null,
        status: startDate > now ? 'not_started' : 'active',
        phases: phases as any,
        current_phase: startDate > now ? null : 0,
        end_behavior: input.end_behavior ?? 'release',
        released_at: null, canceled_at: null, completed_at: null,
        start_date: startDate,
        metadata: input.metadata ?? {},
        created: now, updated: now,
        livemode: meta.livemode === false ? 0 : 1,
      } as any);

      let schedule = this.require(orgId, id);
      if (existing) {
        this.ctx.db.patch('billing_subscriptions', 'id', existing.id, { schedule_id: id, updated: now });
      } else if (startDate <= now) {
        const first = phases[0];
        const sub = this.billing.createSubscription(orgId, {
          customer: customer.id,
          items: first.items.map((item) => ({
            price: item.price, quantity: item.quantity,
            custom_unit_amount: item.custom_unit_amount, metadata: item.metadata,
          })),
          backdate_start_date: startDate,
          billing_cycle_anchor: startDate,
          trial_end: first.trial_end ?? undefined,
          collection_method: first.collection_method ?? undefined,
          days_until_due: first.days_until_due ?? undefined,
          proration_behavior: first.proration_behavior,
          schedule: id,
          metadata: { subscription_schedule: id },
        }, meta);
        this.ctx.db.patch('billing_subscription_schedules', 'id', id, { subscription_id: sub.id, updated: now });
        schedule = this.require(orgId, id);
      }

      this.scheduleAdvance(orgId, schedule);
      this.ctx.emit(orgId, 'subscription_schedule.created', schedule, {
        objectId: id, objectType: 'subscription_schedule',
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      if (schedule.current_phase === 0) {
        const first = phases[0];
        this.ctx.emit(orgId, 'subscription_schedule.phase_started', {
          schedule: schedule.id, subscription: schedule.subscription, phase: 0, phase_id: first.id,
          start_date: first.start_date, end_date: first.end_date, items: first.items,
        }, { objectId: schedule.id, objectType: 'subscription_schedule' });
      }
      return schedule;
    });
  }

  update(orgId: string, id: string, input: ScheduleUpdateInput, meta: WriteMeta = {}): SubscriptionSchedule {
    return this.ctx.atomic(() => {
      const before = this.require(orgId, id);
      if (before.status === 'canceled' || before.status === 'released' || before.status === 'completed') {
        throw conflict('schedule_not_editable', `Schedule ${id} is ${before.status} and can no longer be changed.`, { status: before.status });
      }
      const changes: Record<string, unknown> = { updated: this.ctx.now() };
      const previous: Record<string, unknown> = {};
      if (input.phases) {
        const book = this.billing.book(orgId);
        const currentIndex = before.current_phase ?? 0;
        const done = before.phases.slice(0, currentIndex);
        const rebuiltStart = done.length ? done[done.length - 1].end_date : before.start_date;
        const rebuilt = this.buildPhases(input.phases, rebuiltStart, book);
        previous.phases = before.phases;
        changes.phases = [...done, ...rebuilt] as any;
      }
      if (input.end_behavior && input.end_behavior !== before.end_behavior) {
        previous.end_behavior = before.end_behavior;
        changes.end_behavior = input.end_behavior;
      }
      if (input.metadata) { previous.metadata = before.metadata; changes.metadata = { ...before.metadata, ...input.metadata } as any; }
      this.ctx.db.patch('billing_subscription_schedules', 'id', id, changes as any);
      const after = this.require(orgId, id);
      this.scheduleAdvance(orgId, after);
      if (Object.keys(previous).length) {
        this.ctx.emit(orgId, 'subscription_schedule.updated', after, {
          objectId: id, objectType: 'subscription_schedule', previous,
          actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
        });
      }
      return after;
    });
  }

  /**
   * Turn phase inputs into dated phases. A phase sized in `iterations` is as
   * long as that many billing intervals of its own items, measured with the
   * calendar, so "3 months from 31 December" ends on 31 March.
   */
  private buildPhases(inputs: PhaseInput[], startDate: number, book: ReturnType<Billing['book']>): SchedulePhase[] {
    const phases: SchedulePhase[] = [];
    let cursor = startDate;
    inputs.forEach((input, index) => {
      if (!input.items.length) throw badRequest('phase_items_required', `Phase ${index + 1} has no items.`, `phases[${index}].items`);
      const items: SchedulePhaseItem[] = input.items.map((item) => {
        const price = book.price(item.price);
        const quantity = item.quantity ?? 1;
        if (isMetered(price) && quantity !== 1) {
          throw badRequest('metered_item_quantity', `Metered price ${price.id} bills on recorded usage, so its quantity is always 1.`, `phases[${index}].items`);
        }
        assertFlatQuantity(price, quantity, `phases[${index}].items`);
        if (price.model === 'custom' && (item.custom_unit_amount ?? null) === null) {
          throw badRequest('custom_amount_required', `Phase ${index + 1} uses negotiated price ${price.id}; supply custom_unit_amount.`, `phases[${index}].items`);
        }
        return { price: price.id, quantity, custom_unit_amount: item.custom_unit_amount ?? null, metadata: item.metadata ?? {} };
      });
      const { interval, interval_count } = resolveInterval(items.map((i) => book.price(i.price)));
      const iv: Interval = { unit: interval, count: interval_count };
      const start = input.start_date ?? cursor;
      const anchorDay = new Date(start).getUTCDate();
      let end: number;
      if (input.end_date !== undefined) end = input.end_date;
      else if (input.iterations !== undefined) {
        end = start;
        for (let i = 0; i < input.iterations; i++) end = addInterval(end, iv, anchorDay);
      } else if (index === inputs.length - 1) {
        end = addInterval(start, iv, anchorDay);
      } else {
        throw badRequest(
          'phase_length_required',
          `Phase ${index + 1} needs either iterations or an end_date so the phase after it knows when to begin.`,
          `phases[${index}]`,
        );
      }
      if (end <= start) {
        throw badRequest('phase_ends_before_it_starts', `Phase ${index + 1} ends on or before it starts.`, `phases[${index}].end_date`);
      }
      phases.push({
        object: 'subscription_schedule_phase',
        id: newId('phase'),
        items,
        start_date: start,
        end_date: end,
        iterations: input.iterations ?? null,
        proration_behavior: input.proration_behavior ?? 'create_prorations',
        trial_end: input.trial_end ?? (input.trial ? end : null),
        collection_method: input.collection_method ?? null,
        days_until_due: input.days_until_due ?? null,
        description: input.description ?? null,
        metadata: input.metadata ?? {},
      });
      cursor = end;
    });
    return phases;
  }

  /* --------------------------------- advance ------------------------------ */

  /** One job per schedule, always aimed at the next boundary it must act on. */
  scheduleAdvance(orgId: string, schedule: SubscriptionSchedule): void {
    if (schedule.status === 'canceled' || schedule.status === 'released' || schedule.status === 'completed') {
      this.ctx.jobs.cancel(orgId, { idemKey: `billing.schedule:${schedule.id}` }, this.ctx.now());
      return;
    }
    const index = schedule.current_phase;
    const runAt = index === null ? schedule.start_date : schedule.phases[index]?.end_date;
    if (runAt === undefined) return;
    this.ctx.enqueue(orgId, 'billing.schedule.advance', { schedule: schedule.id, at: runAt }, {
      runAt, idemKey: `billing.schedule:${schedule.id}`,
    });
  }

  /**
   * Move a schedule to whatever phase `at` falls in. Phases are applied one at
   * a time and in order, so a schedule that has been asleep for three phases
   * still emits three transitions rather than jumping to the end.
   */
  advance(orgId: string, scheduleId: string, at: number): void {
    this.ctx.atomic(() => {
      const schedule = this.schedule(orgId, scheduleId);
      if (!schedule) return;
      if (schedule.status === 'canceled' || schedule.status === 'released' || schedule.status === 'completed') return;

      const now = this.ctx.now();
      // Start a schedule whose first phase has arrived.
      if (schedule.current_phase === null) {
        if (at < schedule.start_date) return;
        const first = schedule.phases[0];
        let subscriptionId = schedule.subscription;
        if (!subscriptionId) {
          const sub = this.billing.createSubscription(orgId, {
            customer: schedule.customer,
            items: first.items.map((item) => ({
            price: item.price, quantity: item.quantity,
            custom_unit_amount: item.custom_unit_amount, metadata: item.metadata,
          })),
            backdate_start_date: first.start_date,
            billing_cycle_anchor: first.start_date,
            trial_end: first.trial_end ?? undefined,
            collection_method: first.collection_method ?? undefined,
            days_until_due: first.days_until_due ?? undefined,
            proration_behavior: first.proration_behavior,
            schedule: schedule.id,
            metadata: { subscription_schedule: schedule.id },
          }, { actorType: 'system' });
          subscriptionId = sub.id;
        }
        this.ctx.db.patch('billing_subscription_schedules', 'id', schedule.id, {
          status: 'active', current_phase: 0, subscription_id: subscriptionId, updated: now,
        });
        const started = this.require(orgId, schedule.id);
        this.ctx.emit(orgId, 'subscription_schedule.phase_started', {
          schedule: started.id, subscription: subscriptionId, phase: 0, phase_id: first.id,
          start_date: first.start_date, end_date: first.end_date, items: first.items,
        }, { objectId: started.id, objectType: 'subscription_schedule' });
        this.scheduleAdvance(orgId, started);
        return;
      }

      const index = schedule.current_phase;
      const phase = schedule.phases[index];
      if (!phase || at < phase.end_date) return;

      const next = schedule.phases[index + 1];
      const sub = schedule.subscription ? this.billing.subscription(orgId, schedule.subscription) : null;

      if (!next) {
        this.complete(orgId, schedule, sub, phase.end_date);
        return;
      }

      if (sub && sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
        // When the boundary is also a period boundary the new items simply are
        // this period's items — there is no part-period to credit or charge.
        const aligned = sub.current_period_start === phase.end_date;
        this.billing.applyPhase(orgId, sub, next, phase.end_date, aligned ? 'none' : undefined);
      }
      this.ctx.db.patch('billing_subscription_schedules', 'id', schedule.id, { current_phase: index + 1, updated: now });
      const moved = this.require(orgId, schedule.id);
      this.ctx.emit(orgId, 'subscription_schedule.phase_started', {
        schedule: moved.id, subscription: moved.subscription, phase: index + 1, phase_id: next.id,
        start_date: next.start_date, end_date: next.end_date, items: next.items,
        previous_phase: index, previous_phase_id: phase.id,
      }, { objectId: moved.id, objectType: 'subscription_schedule', previous: { current_phase: index } });
      this.scheduleAdvance(orgId, moved);
    });
  }

  private complete(orgId: string, schedule: SubscriptionSchedule, sub: ReturnType<Billing['subscription']>, at: number): void {
    const now = this.ctx.now();
    this.ctx.db.patch('billing_subscription_schedules', 'id', schedule.id, {
      status: schedule.end_behavior === 'cancel' ? 'canceled' : 'completed',
      completed_at: at,
      canceled_at: schedule.end_behavior === 'cancel' ? at : null,
      updated: now,
    });
    if (schedule.end_behavior === 'cancel' && sub && sub.status !== 'canceled') {
      this.billing.endNow(orgId, sub, { at, reason: 'schedule_ended', meta: { actorType: 'system' } });
    } else if (sub) {
      this.ctx.db.patch('billing_subscriptions', 'id', sub.id, { schedule_id: null, updated: now });
    }
    const done = this.require(orgId, schedule.id);
    this.ctx.emit(orgId, 'subscription_schedule.completed', done, {
      objectId: done.id, objectType: 'subscription_schedule', previous: { status: schedule.status },
    });
    this.ctx.jobs.cancel(orgId, { idemKey: `billing.schedule:${schedule.id}` }, now);
  }

  /** Stop managing the subscription but leave it running exactly as it is. */
  release(orgId: string, id: string, meta: WriteMeta = {}): SubscriptionSchedule {
    return this.ctx.atomic(() => {
      const schedule = this.require(orgId, id);
      if (schedule.status !== 'active' && schedule.status !== 'not_started') {
        throw conflict('schedule_not_active', `Schedule ${id} is ${schedule.status}.`, { status: schedule.status });
      }
      const now = this.ctx.now();
      if (schedule.subscription) this.ctx.db.patch('billing_subscriptions', 'id', schedule.subscription, { schedule_id: null, updated: now });
      this.ctx.db.patch('billing_subscription_schedules', 'id', id, { status: 'released', released_at: now, updated: now });
      this.ctx.jobs.cancel(orgId, { idemKey: `billing.schedule:${id}` }, now);
      const released = this.require(orgId, id);
      this.ctx.emit(orgId, 'subscription_schedule.released', released, {
        objectId: id, objectType: 'subscription_schedule', previous: { status: schedule.status },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return released;
    });
  }

  /** Cancel the schedule and the subscription it manages. */
  cancel(orgId: string, id: string, opts: { invoice_now?: boolean; prorate?: boolean } = {}, meta: WriteMeta = {}): SubscriptionSchedule {
    return this.ctx.atomic(() => {
      const schedule = this.require(orgId, id);
      if (schedule.status === 'canceled' || schedule.status === 'released' || schedule.status === 'completed') {
        throw conflict('schedule_not_active', `Schedule ${id} is ${schedule.status}.`, { status: schedule.status });
      }
      const now = this.ctx.now();
      // Mark the schedule first: cancelling its subscription emits
      // `subscription.canceled`, and the handler that tidies up orphaned
      // schedules must not race this one and cancel it twice.
      this.ctx.db.patch('billing_subscription_schedules', 'id', id, { status: 'canceled', canceled_at: now, updated: now });
      const sub = schedule.subscription ? this.billing.subscription(orgId, schedule.subscription) : null;
      if (sub && sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
        this.billing.endNow(orgId, sub, { at: now, reason: 'schedule_ended', prorate: opts.prorate ?? false, meta });
      }
      this.ctx.jobs.cancel(orgId, { idemKey: `billing.schedule:${id}` }, now);
      const canceled = this.require(orgId, id);
      this.ctx.emit(orgId, 'subscription_schedule.canceled', canceled, {
        objectId: id, objectType: 'subscription_schedule', previous: { status: schedule.status },
        actorId: meta.actorId, actorType: meta.actorType, requestId: meta.requestId,
      });
      return canceled;
    });
  }

  /**
   * Called by the renewal at a period boundary. If the subscription's schedule
   * has a phase ending exactly here, move it on now so the period about to be
   * invoiced carries the right items. Doing nothing is always safe: the
   * schedule's own job runs at the same instant as a backstop.
   */
  advanceIfDue(orgId: string, sub: Subscription, at: number): Subscription {
    if (!sub.schedule) return sub;
    const schedule = this.schedule(orgId, sub.schedule);
    if (!schedule || schedule.status !== 'active' || schedule.current_phase === null) return sub;
    const phase = schedule.phases[schedule.current_phase];
    if (!phase || phase.end_date !== at) return sub;
    this.advance(orgId, schedule.id, at);
    return this.billing.subscription(orgId, sub.id) ?? sub;
  }

  /** A subscription that ends on its own takes its schedule with it. */
  onSubscriptionCanceled(orgId: string, subscriptionId: string): void {
    const row = this.ctx.db.get<any>(
      `SELECT * FROM billing_subscription_schedules WHERE org_id = ? AND subscription_id = ? AND status IN ('active','not_started')`,
      orgId, subscriptionId,
    );
    if (!row) return;
    const schedule = hydrateSchedule(row);
    const now = this.ctx.now();
    this.ctx.db.patch('billing_subscription_schedules', 'id', schedule.id, { status: 'canceled', canceled_at: now, updated: now });
    this.ctx.jobs.cancel(orgId, { idemKey: `billing.schedule:${schedule.id}` }, now);
    this.ctx.emit(orgId, 'subscription_schedule.canceled', this.require(orgId, schedule.id), {
      objectId: schedule.id, objectType: 'subscription_schedule', previous: { status: schedule.status },
    });
  }
}
