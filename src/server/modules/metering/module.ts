import { defineModule } from '../../kernel/module';
import type { Ctx } from '../../kernel/context';
import type { AinEvent } from '../../kernel/events';
import { created, list, status as httpStatus, type Req } from '../../kernel/http';
import { badRequest, notFound } from '../../../shared/errors';
import { DAY, HOUR } from '../../../shared/time';
import v, { type Validator } from '../../../shared/validate';
import { instant } from './query';
import { METERING_MIGRATIONS } from './schema';
import { seedMetering } from './seed';
import {
  DEFAULT_ACCEPTANCE_WINDOW, DEFAULT_FUTURE_TOLERANCE, MAX_BATCH, Metering,
  type CancelEventInput, type ClosePeriodInput, type MeterListFilter,
  type ResolveLateArrivalInput, type SummaryQuery,
} from './store';
import {
  LATE_RESOLUTIONS, METER_AGGREGATIONS, METER_STATUSES, SUMMARY_GRANULARITIES,
  type BatchResult, type ClosureDetail, type IngestResult, type LateArrival, type LateResolution,
  type Meter, type MeterEvent, type MeterEventAdjustment, type MeterEventInput, type MeterInput,
  type PeriodClosure, type PeriodUsage, type SummaryBucket, type TrueUpSink,
} from './types';
import type { Price } from '../catalog/types';

/* -------------------------------- service --------------------------------- */

/**
 * What the rest of the platform needs from metering. Subscriptions ask for a
 * period total, credits ask what a customer has consumed, and the copilot asks
 * both — all through one implementation of each aggregation.
 */
export interface MeteringService {
  meters(orgId: string, filter?: MeterListFilter): Meter[];
  /** Resolves by meter id or by the event name the meter listens for. */
  meter(orgId: string, key: string): Meter | null;
  requireMeter(orgId: string, key: string): Meter;
  createMeter(orgId: string, input: MeterInput): Meter;
  updateMeter(orgId: string, id: string, patch: Partial<MeterInput>): Meter;

  ingest(orgId: string, input: MeterEventInput): IngestResult;
  ingestBatch(orgId: string, inputs: MeterEventInput[]): BatchResult;
  event(orgId: string, id: string): MeterEvent | null;

  /** The aggregated total for a billing period, honouring the aggregation. */
  usageForPeriod(orgId: string, meterKey: string, customerId: string, start: number, end: number): PeriodUsage;
  summaries(orgId: string, meterKey: string, query: SummaryQuery): SummaryBucket[];

  closePeriod(orgId: string, input: ClosePeriodInput): PeriodClosure;
  closures(orgId: string, filter?: { meter?: string; customer?: string; limit?: number }): PeriodClosure[];
  /** One closure with its live total and the money still owed either way. */
  closureDetail(orgId: string, id: string): ClosureDetail | null;
  lateArrivals(orgId: string, filter?: { meter?: string; customer?: string; resolution?: LateResolution; limit?: number }): LateArrival[];
  lateArrival(orgId: string, id: string): LateArrival | null;
  resolveLateArrival(orgId: string, id: string, input: ResolveLateArrivalInput): LateArrival;
  /**
   * Register the module that turns a priced true-up into an invoice line and
   * credit. Metering prices the drift; it does not know how to bill anyone.
   */
  onTrueUp(sink: TrueUpSink): void;

  /** Withdraw an event that should never have been recorded. */
  cancelEvent(orgId: string, input: CancelEventInput): MeterEventAdjustment;
  adjustments(orgId: string, filter?: { meter?: string; customer?: string; limit?: number }): MeterEventAdjustment[];

  /** The meter a metered price bills against, from its `recurring.meter`. */
  meterForPrice(orgId: string, price: Price): Meter | null;
}

/* --------------------------- the billing lifecycle ------------------------ */

/**
 * The half of a metered period that is not arithmetic: noticing that it ended.
 *
 * Billing raises `subscription.invoice_due` when a cycle turns over, carrying
 * `arrears_period` — the window whose usage has not been priced yet — and the
 * lines it is about to invoice. Every metered line on that event is one period
 * of one price for one customer that now needs settling, so each becomes a job
 * with a `run_at`. Nothing here decides *how* a period settles; that is the
 * credits module, reached through the one job type it publishes for the
 * purpose. This is the seam, and it is deliberately the only one.
 */
interface InvoiceDueEvent {
  subscription?: string;
  customer?: string;
  currency?: string;
  arrears_period?: { start: number; end: number } | null;
  lines?: { subscription_item: string | null; price: string; metered: boolean }[];
}

/** The subscription object as `subscription.canceled` carries it. */
interface CanceledSubscriptionEvent {
  id?: string;
  customer?: string;
  currency?: string;
  current_period_start?: number;
  current_period_end?: number;
  ended_at?: number | null;
  canceled_at?: number | null;
  items?: { id: string; price: string; metered: boolean }[];
}

export interface SettlePeriodJob {
  customer: string;
  price: string;
  currency: string | null;
  subscription: string | null;
  subscription_item: string | null;
  period_start: number;
  period_end: number;
  /**
   * The billing cycle this window belongs to, when it is only part of one — a
   * subscription cancelled mid-cycle bills the stub it ran for, and a metered
   * price's tiers still belong to the whole cycle. Carried so the settlement
   * prices the stub from where the cycle had already reached.
   */
  billing_period?: { start: number; end: number } | null;
}

/**
 * One settlement per (subscription item, period). The key is the period itself
 * rather than anything about this particular attempt, so a billing run that is
 * replayed enqueues the same job instead of a second one — and if it has
 * already run, the settlement's own period key catches the duplicate.
 */
function enqueueSettlement(ctx: Ctx, orgId: string, job: SettlePeriodJob): void {
  if (!(job.period_end > job.period_start)) return;
  const key = job.subscription_item ?? `${job.customer}:${job.price}`;
  ctx.enqueue(orgId, 'credits.settle_period', job, {
    runAt: Math.max(ctx.now(), job.period_end),
    idemKey: `settle:${key}:${job.period_start}:${job.period_end}`,
  });
}

function settleArrearsOnInvoice(event: AinEvent<InvoiceDueEvent>, ctx: Ctx): void {
  const data = event.data ?? {};
  const period = data.arrears_period;
  if (!period || !data.customer || !Number.isFinite(period.start) || !Number.isFinite(period.end)) return;
  for (const line of data.lines ?? []) {
    if (!line?.metered || !line.price) continue;
    enqueueSettlement(ctx, event.org_id, {
      customer: data.customer,
      price: line.price,
      currency: data.currency ?? null,
      subscription: data.subscription ?? null,
      subscription_item: line.subscription_item,
      period_start: period.start,
      period_end: period.end,
      billing_period: { start: period.start, end: period.end },
    });
  }
}

/**
 * A cancelled subscription never renews, so its last part-period would never
 * raise an invoice — and its usage would never be billed. Settle it up to the
 * instant the subscription actually ended.
 */
function settleFinalPeriodOnCancel(event: AinEvent<CanceledSubscriptionEvent>, ctx: Ctx): void {
  const sub = event.data ?? {};
  const start = sub.current_period_start;
  const end = sub.ended_at ?? sub.canceled_at ?? null;
  if (!sub.customer || typeof start !== 'number' || typeof end !== 'number' || !(end > start)) return;
  // The stub is part of the cycle it was cancelled out of, not a cycle of its
  // own, so the metered price's tiers are shared with whatever else of that
  // cycle has already been billed.
  const cycle = typeof sub.current_period_end === 'number' && sub.current_period_end >= end
    ? { start, end: sub.current_period_end }
    : { start, end };
  for (const item of sub.items ?? []) {
    if (!item?.metered || !item.price) continue;
    enqueueSettlement(ctx, event.org_id, {
      customer: sub.customer,
      price: item.price,
      currency: sub.currency ?? null,
      subscription: sub.id ?? null,
      subscription_item: item.id,
      period_start: start,
      period_end: end,
      billing_period: cycle,
    });
  }
}

declare module '../../kernel/services' {
  interface ServiceRegistry { metering: MeteringService }
}

const stores = new WeakMap<Ctx, Metering>();
export function meteringStore(ctx: Ctx): Metering {
  let store = stores.get(ctx);
  if (!store) { store = new Metering(ctx); stores.set(ctx, store); }
  return store;
}

/* ------------------------------- validators ------------------------------- */

const meterBody = v.object({
  id: v.optional(v.id('mtr')),
  name: v.string({ min: 1, max: 120 }),
  event_name: v.string({ min: 2, max: 80 }),
  aggregation: v.default(v.enum(METER_AGGREGATIONS), 'sum'),
  value_key: v.optional(v.string({ min: 1, max: 80 })),
  customer_key: v.default(v.string({ min: 1, max: 80 }), 'customer_id'),
  unique_key: v.optional(v.string({ min: 1, max: 80 })),
  unit_label: v.optional(v.string({ max: 40 })),
  description: v.optional(v.string({ max: 600 })),
  acceptance_window_ms: v.optional(v.int({ min: 60_000, max: 365 * DAY })),
  future_tolerance_ms: v.optional(v.int({ min: 0, max: DAY })),
  metadata: v.metadata(),
});

const meterPatchBody = v.object({
  name: v.optional(v.string({ min: 1, max: 120 })),
  // Accepted only so the frozen-field guard can explain itself; silently
  // dropping these would let a caller think the meter had changed.
  aggregation: v.optional(v.enum(METER_AGGREGATIONS)),
  event_name: v.optional(v.string({ min: 2, max: 80 })),
  value_key: v.optional(v.string({ min: 1, max: 80 })),
  customer_key: v.optional(v.string({ min: 1, max: 80 })),
  unique_key: v.optional(v.string({ min: 1, max: 80 })),
  description: v.optional(v.string({ max: 600 })),
  unit_label: v.optional(v.string({ max: 40 })),
  status: v.optional(v.enum(METER_STATUSES)),
  acceptance_window_ms: v.optional(v.int({ min: 60_000, max: 365 * DAY })),
  future_tolerance_ms: v.optional(v.int({ min: 0, max: DAY })),
  metadata: v.optional(v.metadata()),
});

const eventBody = v.object({
  event_name: v.optional(v.string({ min: 1, max: 80 })),
  meter: v.optional(v.string({ min: 1, max: 80 })),
  identifier: v.optional(v.string({ min: 1, max: 200 })),
  customer: v.optional(v.string({ min: 1, max: 120 })),
  timestamp: v.optional(v.timestamp()),
  value: v.optional(v.union(v.number({ min: 0 }), v.string({ max: 40 }))),
  payload: v.default(v.record(v.any()), {}),
});

/** Re-reads the already-validated query string with its schema's types. */
const queryOf = <T>(req: Req, schema: Validator<T>): T => schema.parse(req.query);

const rangeQuery = v.object({
  customer: v.optional(v.string({ max: 120 })),
  start: instant(),
  end: instant(),
  granularity: v.default(v.enum(SUMMARY_GRANULARITIES), 'day'),
});

const usageQuery = v.object({
  customer: v.string({ min: 1, max: 120 }),
  start: instant(),
  end: instant(),
});

const customerUsageQuery = v.object({
  start: v.optional(instant()),
  end: v.optional(instant()),
  limit: v.optional(v.int({ min: 1, max: 200 })),
});

const eventListQuery = v.object({
  meter: v.optional(v.string({ max: 80 })),
  customer: v.optional(v.string({ max: 120 })),
  start: v.optional(instant()),
  end: v.optional(instant()),
  late: v.optional(v.boolean()),
  cancelled: v.optional(v.boolean()),
  limit: v.optional(v.int({ min: 1, max: 200 })),
  cursor: v.optional(v.string({ max: 200 })),
});

const meterListQuery = v.object({
  status: v.optional(v.enum(METER_STATUSES)),
  aggregation: v.optional(v.enum(METER_AGGREGATIONS)),
  search: v.optional(v.string({ max: 80 })),
});

const closureListQuery = v.object({
  meter: v.optional(v.string({ max: 80 })),
  customer: v.optional(v.string({ max: 120 })),
  limit: v.optional(v.int({ min: 1, max: 200 })),
});

const lateListQuery = v.object({
  meter: v.optional(v.string({ max: 80 })),
  customer: v.optional(v.string({ max: 120 })),
  resolution: v.optional(v.enum(LATE_RESOLUTIONS)),
  limit: v.optional(v.int({ min: 1, max: 200 })),
});

const adjustmentListQuery = v.object({
  meter: v.optional(v.string({ max: 80 })),
  customer: v.optional(v.string({ max: 120 })),
  limit: v.optional(v.int({ min: 1, max: 200 })),
});

/** Stripe's `meter_event_adjustment` shape, so a migration is a rename. */
const adjustmentBody = v.object({
  type: v.default(v.enum(['cancel'] as const), 'cancel'),
  cancel: v.object({ identifier: v.string({ min: 1, max: 200 }) }),
  event_name: v.optional(v.string({ min: 1, max: 80 })),
  reason: v.optional(v.string({ max: 300 })),
});

/* --------------------------------- module --------------------------------- */

export default defineModule({
  name: 'metering',
  title: 'Usage metering',
  description: 'Exactly-once usage ingestion, incremental hourly pre-aggregates and the period totals that become invoice lines.',
  dependsOn: ['core', 'catalog'],
  migrations: METERING_MIGRATIONS,

  boot(ctx) {
    const store = meteringStore(ctx);
    const service: MeteringService = {
      meters: (orgId, filter) => store.meters(orgId, filter),
      meter: (orgId, key) => store.meter(orgId, key),
      requireMeter: (orgId, key) => store.requireMeter(orgId, key),
      createMeter: (orgId, input) => ctx.atomic(() => {
        const meter = store.createMeter(orgId, input);
        ctx.emit(orgId, 'meter.created', meter, { objectId: meter.id, objectType: 'meter' });
        return meter;
      }),
      updateMeter: (orgId, id, patch) => ctx.atomic(() => {
        const before = store.requireMeter(orgId, id);
        const meter = store.updateMeter(orgId, id, patch);
        ctx.emit(orgId, 'meter.updated', meter, {
          objectId: meter.id, objectType: 'meter',
          previous: { name: before.name, status: before.status, acceptance_window_ms: before.acceptance_window_ms },
        });
        return meter;
      }),
      ingest: (orgId, input) => store.ingest(orgId, input),
      ingestBatch: (orgId, inputs) => store.ingestBatch(orgId, inputs),
      event: (orgId, id) => store.event(orgId, id),
      usageForPeriod: (orgId, meterKey, customerId, start, end) => store.usageForPeriod(orgId, meterKey, customerId, start, end),
      summaries: (orgId, meterKey, query) => store.summaries(orgId, meterKey, query),
      closePeriod: (orgId, input) => store.closePeriod(orgId, input),
      closures: (orgId, filter) => store.closures(orgId, filter),
      closureDetail: (orgId, id) => store.closureDetail(orgId, id),
      lateArrivals: (orgId, filter) => store.lateArrivals(orgId, filter),
      lateArrival: (orgId, id) => store.lateArrival(orgId, id),
      resolveLateArrival: (orgId, id, input) => store.resolveLateArrival(orgId, id, input),
      onTrueUp: (sink) => store.onTrueUp(sink),
      cancelEvent: (orgId, input) => store.cancelEvent(orgId, input),
      adjustments: (orgId, filter) => store.adjustments(orgId, filter),
      meterForPrice: (orgId, price) => {
        const key = price.recurring?.meter ?? price.metadata?.meter ?? null;
        return key ? store.meter(orgId, key) : null;
      },
    };
    ctx.provide('metering', service);

    // A daily sweep that turns silence into a signal: a meter that has stopped
    // receiving events is usually a broken integration, not a quiet factory.
    //
    // Reported once per episode, not once per day. An alert that repeats every
    // morning for a year is an alert nobody reads, and it buries the event log
    // that webhooks, workflows and timelines all share.
    ctx.jobs.handle('metering.watch_silence', (_payload: Record<string, never>, job) => {
      const orgId = job.org_id;
      const now = ctx.now();
      for (const meter of store.meters(orgId, { status: 'active' })) {
        const lastAt = ctx.db.pluck<number>(
          `SELECT MAX(received_at) FROM meter_events WHERE org_id = ? AND meter_id = ?`, orgId, meter.id);
        if (!lastAt) continue;
        const silentFor = now - lastAt;
        const lastStall = ctx.events.list(orgId, { types: ['meter.ingestion_stalled'], objectId: meter.id, limit: 1 })[0];
        if (silentFor >= 2 * DAY) {
          // A stall already reported stays reported until events come back.
          if (lastStall && lastStall.created > lastAt) continue;
          ctx.emit(orgId, 'meter.ingestion_stalled', {
            meter: meter.id, meter_name: meter.name, event_name: meter.event_name,
            last_event_at: lastAt, silent_for_ms: silentFor,
          }, { objectId: meter.id, objectType: 'meter' });
        } else if (lastStall && lastStall.created < lastAt) {
          const lastResume = ctx.events.list(orgId, { types: ['meter.ingestion_resumed'], objectId: meter.id, limit: 1 })[0];
          if (lastResume && lastResume.created > lastStall.created) continue;
          ctx.emit(orgId, 'meter.ingestion_resumed', {
            meter: meter.id, meter_name: meter.name, event_name: meter.event_name,
            last_event_at: lastAt, stalled_at: lastStall.created,
            silent_for_ms: lastAt - ((lastStall.data as { last_event_at?: number }).last_event_at ?? lastStall.created),
          }, { objectId: meter.id, objectType: 'meter' });
        }
      }
      ctx.enqueue(orgId, 'metering.watch_silence', {}, { runAt: now + DAY, idemKey: 'metering.watch_silence' });
    });
  },

  seed(ctx, orgId) {
    seedMetering(ctx, orgId);
    ctx.jobs.enqueue(orgId, 'metering.watch_silence', {}, ctx.now(), { runAt: ctx.now() + DAY, idemKey: 'metering.watch_silence' });
  },

  routes(router, ctx) {
    const store = meteringStore(ctx);

    /* -------------------------------- meters ------------------------------ */

    router.get('/v1/meters', (req: Req, c: Ctx) => {
      const meters = c.svc.metering.meters(req.auth.orgId, queryOf(req, meterListQuery));
      return list(meters, { totalCount: meters.length });
    }, {
      summary: 'List meters', tags: ['metering'],
      query: meterListQuery,
    });

    router.post('/v1/meters', (req: Req, c: Ctx) =>
      created(c.svc.metering.createMeter(req.auth.orgId, req.body as MeterInput)), {
      summary: 'Create a meter', tags: ['metering'], roles: ['member'], body: meterBody,
      description:
        'A meter is a standing instruction: which event name to listen for, where the value and the customer live in the payload, and how a period of events collapses into one number.',
    });

    router.get('/v1/meters/:id', (req: Req, c: Ctx) => {
      const meter = c.svc.metering.meter(req.auth.orgId, req.params.id);
      if (!meter) throw notFound('meter', req.params.id);
      const stats = c.db.get<{ events: number; first_at: number | null; last_at: number | null; customers: number }>(
        `SELECT COUNT(*) AS events, MIN(timestamp) AS first_at, MAX(timestamp) AS last_at, COUNT(DISTINCT customer_id) AS customers
         FROM meter_events WHERE org_id = ? AND meter_id = ?`,
        req.auth.orgId, meter.id,
      );
      return {
        ...meter,
        ingestion: {
          event_count: Number(stats?.events ?? 0),
          customer_count: Number(stats?.customers ?? 0),
          first_event_at: stats?.first_at ?? null,
          last_event_at: stats?.last_at ?? null,
          accepts_events_from: c.now() - meter.acceptance_window_ms,
          accepts_events_until: c.now() + meter.future_tolerance_ms,
        },
      };
    }, { summary: 'Retrieve a meter by id or event name', tags: ['metering'] });

    router.patch('/v1/meters/:id', (req: Req, c: Ctx) =>
      c.svc.metering.updateMeter(req.auth.orgId, req.params.id, req.body as Partial<MeterInput>), {
      summary: 'Update a meter’s name, status or acceptance window', tags: ['metering'], roles: ['member'],
      body: meterPatchBody,
      description: 'A meter’s aggregation and payload keys are frozen once it exists — the summaries already written were aggregated under the old rule.',
    });

    /* ------------------------------ ingestion ----------------------------- */

    router.post('/v1/meter-events', (req: Req, c: Ctx) => {
      const result = c.svc.metering.ingest(req.auth.orgId, req.body as MeterEventInput);
      // A replay is a read: same body, 200 instead of 201, no second row.
      return result.outcome === 'duplicate' ? httpStatus(200, result) : created(result);
    }, {
      summary: 'Record one usage event', tags: ['metering'], roles: ['member'], body: eventBody,
      description:
        'Send an `identifier` you can reproduce and ingestion is exactly-once: a replay returns the original event and writes nothing. Events may be backdated within the meter’s acceptance window; older ones are rejected rather than silently changing an invoiced total.',
    });

    router.post('/v1/meter-events/batch', (req: Req, c: Ctx) => {
      const body = req.body as { events: MeterEventInput[] };
      return c.svc.metering.ingestBatch(req.auth.orgId, body.events);
    }, {
      summary: 'Record up to 1,000 usage events, with per-event results', tags: ['metering'], roles: ['member'],
      body: v.object({ events: v.array(eventBody, { min: 1, max: MAX_BATCH }) }),
      description:
        'Partial success by design. Every submitted event gets a result at the same index — `recorded`, `duplicate`, or `error` with the reason — so one malformed reading never rejects the batch around it.',
    });

    router.get('/v1/meter-events', (req: Req, c: Ctx) => {
      const page = store.events(req.auth.orgId, queryOf(req, eventListQuery));
      return list(page.data, { hasMore: page.hasMore, nextCursor: page.nextCursor });
    }, {
      summary: 'List recorded usage events', tags: ['metering'],
      query: eventListQuery,
    });

    router.get('/v1/meter-events/:id', (req: Req, c: Ctx) => {
      const event = c.svc.metering.event(req.auth.orgId, req.params.id);
      if (!event) throw notFound('meter event', req.params.id);
      return event;
    }, { summary: 'Retrieve one usage event by id or identifier', tags: ['metering'] });

    /* ----------------------------- adjustments ---------------------------- */

    router.post('/v1/meter-event-adjustments', (req: Req, c: Ctx) => {
      const body = req.body as { cancel: { identifier: string }; event_name?: string; reason?: string };
      return created(c.svc.metering.cancelEvent(req.auth.orgId, {
        identifier: body.cancel.identifier, event_name: body.event_name ?? null, reason: body.reason ?? null,
      }));
    }, {
      summary: 'Withdraw an event that should never have been recorded', tags: ['metering'], roles: ['member'],
      body: adjustmentBody,
      description:
        'The one correction a usage business cannot do without. The event row survives — its `identifier` stays claimed, so exactly-once ingestion still holds and a replay cannot resurrect it — and the hour it belonged to is rebuilt from the events that remain, which is the only way `max`, `last` and `unique` stay right afterwards. If the event sat inside a period that was already billed, the billed total does not move: the withdrawal is filed as a negative true-up against that closure, the mirror image of a late arrival.',
    });

    router.get('/v1/meter-event-adjustments', (req: Req, c: Ctx) => {
      const rows = c.svc.metering.adjustments(req.auth.orgId, queryOf(req, adjustmentListQuery));
      return list(rows, { totalCount: rows.length });
    }, {
      summary: 'Events that have been withdrawn, newest first', tags: ['metering'], query: adjustmentListQuery,
    });

    /* ------------------------- summaries and totals ----------------------- */

    router.get('/v1/meters/:id/event-summaries', (req: Req, c: Ctx) => {
      const q = queryOf(req, rangeQuery);
      const buckets = c.svc.metering.summaries(req.auth.orgId, req.params.id, q);
      return list(buckets, { totalCount: buckets.length });
    }, {
      summary: 'Pre-aggregated usage over a time range', tags: ['metering'], query: rangeQuery,
      description:
        'Reads the hourly pre-aggregate maintained on ingest, rolled up to the granularity you ask for. This is a bounded read whatever the volume behind it.',
    });

    router.get('/v1/meters/:id/usage', (req: Req, c: Ctx) => {
      const q = queryOf(req, usageQuery);
      return c.svc.metering.usageForPeriod(req.auth.orgId, req.params.id, q.customer, q.start, q.end);
    }, {
      summary: 'The period total for one customer — the number that becomes an invoice line', tags: ['metering'],
      query: usageQuery,
      description:
        'Whole hours are read from the pre-aggregate and the partial hours at each edge from the raw events, so a period that does not begin on the hour is still exact. `provenance` says which part came from where.',
    });

    router.get('/v1/meters/:id/customers', (req: Req, c: Ctx) => {
      const meter = c.svc.metering.requireMeter(req.auth.orgId, req.params.id);
      const q = queryOf(req, customerUsageQuery);
      const end = q.end ?? c.now();
      const start = q.start ?? end - 30 * DAY;
      // The pre-aggregate picks the page (a bounded read); the page is then
      // ordered by the aggregation's own answer, which is what a reader means
      // by "biggest" for a `max`, `last` or `unique` meter. TOTAL() rather than
      // SUM() because this ordering only chooses the page — and an integer SUM
      // wide enough to overflow would fail the query instead of ranking it.
      const rows = c.db.all<{ customer_id: string }>(
        `SELECT customer_id FROM meter_event_summaries
         WHERE org_id = ? AND meter_id = ? AND hour_start >= ? AND hour_start < ?
         GROUP BY customer_id
         ORDER BY TOTAL(sum_micro) DESC, COALESCE(SUM(event_count), 0) DESC, customer_id ASC
         LIMIT ?`,
        req.auth.orgId, meter.id, Math.floor(start / HOUR) * HOUR, Math.ceil(end / HOUR) * HOUR,
        Math.min(q.limit ?? 50, 200),
      );
      const totals = rows.map((r) => c.svc.metering.usageForPeriod(req.auth.orgId, meter.id, r.customer_id, start, end));
      return list(totals.sort((a, b) => b.value - a.value || a.customer.localeCompare(b.customer)));
    }, {
      summary: 'Every customer streaming into this meter, with their period total', tags: ['metering'],
      query: customerUsageQuery,
    });

    /* -------------------------- closing and late -------------------------- */

    router.post('/v1/meters/:id/close-period', (req: Req, c: Ctx) => {
      const body = req.body as Omit<ClosePeriodInput, 'meter'>;
      return created(c.svc.metering.closePeriod(req.auth.orgId, { ...body, meter: req.params.id }));
    }, {
      summary: 'Freeze a period’s total because it has been billed', tags: ['metering'], roles: ['member'],
      body: v.object({
        customer: v.string({ min: 1, max: 120 }),
        period_start: v.timestamp(),
        period_end: v.timestamp(),
        price: v.optional(v.string({ min: 1, max: 80 })),
        currency: v.optional(v.currency()),
        prior_quantity: v.optional(v.union(v.number({ min: 0 }), v.string({ max: 40 }))),
        ref_type: v.optional(v.string({ max: 40 })),
        ref_id: v.optional(v.string({ max: 80 })),
      }),
      description:
        'After a period is closed, events that land inside it are still recorded and still change the live total — but they are reported as late arrivals for a true-up instead of quietly disagreeing with the invoice. Name the `price` it was billed on and that true-up can be priced later to the cent; leave it out and the drift can only be recorded, not settled. `prior_quantity` is where on that price’s tiers the window began — pass it when the billing period was billed in more than one piece, and the true-up climbs from the same rung the invoice did.',
    });

    router.get('/v1/meter-period-closures/:id', (req: Req, c: Ctx) => {
      const closure = c.svc.metering.closureDetail(req.auth.orgId, req.params.id);
      if (!closure) throw notFound('period closure', req.params.id);
      return closure;
    }, {
      summary: 'One billed period, with what it reads today and what that is worth', tags: ['metering'],
      description:
        '`outstanding_amount` is the signed money the invoice still has to move by: the period re-priced at its live total, minus what it has already been billed. Zero means the invoice and the meter agree.',
    });

    router.get('/v1/meter-period-closures', (req: Req, c: Ctx) => {
      return list(c.svc.metering.closures(req.auth.orgId, queryOf(req, closureListQuery)));
    }, {
      summary: 'List billed periods', tags: ['metering'],
      query: closureListQuery,
    });

    router.get('/v1/meter-late-arrivals', (req: Req, c: Ctx) => {
      const rows = c.svc.metering.lateArrivals(req.auth.orgId, queryOf(req, lateListQuery));
      return list(rows, { totalCount: rows.length });
    }, {
      summary: 'Usage that arrived after its period was billed', tags: ['metering'],
      query: lateListQuery,
    });

    router.get('/v1/meter-late-arrivals/:id', (req: Req, c: Ctx) => {
      const entry = c.svc.metering.lateArrival(req.auth.orgId, req.params.id);
      if (!entry) throw notFound('late arrival', req.params.id);
      return entry;
    }, { summary: 'Retrieve one true-up entry', tags: ['metering'] });

    router.post('/v1/meter-late-arrivals/:id/resolve', (req: Req, c: Ctx) => {
      const body = req.body as ResolveLateArrivalInput & { ref?: string };
      // `ref` used to be the whole answer: a string the caller typed, pointing
      // at nothing. It is now written by the platform, so say that rather than
      // rejecting the field with a generic "unknown parameter".
      if (body.ref !== undefined) {
        throw badRequest(
          'parameter_unsupported',
          '`ref` is written by the platform now: a settled true-up points at the invoice line it produced. Pass `note` for a human explanation.',
          'ref',
        );
      }
      return c.svc.metering.resolveLateArrival(req.auth.orgId, req.params.id, body);
    }, {
      summary: 'Settle a billed period’s drift — in money, not in a word', tags: ['metering'], roles: ['member'],
      body: v.object({
        resolution: v.enum(['credited', 'ignored', 'rebilled'] as const),
        price: v.optional(v.string({ min: 1, max: 80 })),
        note: v.optional(v.string({ max: 300 })),
        ref: v.optional(v.string({ max: 80 })),
      }),
      description:
        '`credited` and `rebilled` re-price the period at its live total on the price it was billed against, hand the difference to the billing module, and record the invoice line that came back in `billable_item` — over-billed credit goes back to the grants that paid for it. `ignored` is the only resolution that writes a word. The unit of settlement is the period, not the entry: three late readings on one closed month are one true-up, and resolving any of them settles the others alongside it. `withdrawn` is not settable here — an adjustment writes it when the event behind the entry is cancelled.',
    });

    /* -------------------------------- health ------------------------------ */

    router.get('/v1/metering/overview', (req: Req, c: Ctx) => {
      const orgId = req.auth.orgId;
      const now = c.now();
      const meters = c.svc.metering.meters(orgId);
      const since = now - 30 * DAY;
      return {
        object: 'metering_overview',
        as_of: now,
        defaults: { acceptance_window_ms: DEFAULT_ACCEPTANCE_WINDOW, future_tolerance_ms: DEFAULT_FUTURE_TOLERANCE, max_batch: MAX_BATCH },
        meters: meters.map((meter) => {
          const row = c.db.get<{ events: number; customers: number; last_at: number | null }>(
            `SELECT COALESCE(SUM(event_count), 0) AS events, COUNT(DISTINCT customer_id) AS customers, MAX(hour_start) AS last_at
             FROM meter_event_summaries WHERE org_id = ? AND meter_id = ? AND hour_start >= ?`,
            orgId, meter.id, since,
          );
          return {
            id: meter.id, name: meter.name, event_name: meter.event_name,
            aggregation: meter.aggregation, unit_label: meter.unit_label, status: meter.status,
            events_30d: Number(row?.events ?? 0),
            customers_30d: Number(row?.customers ?? 0),
            last_hour_with_events: row?.last_at ?? null,
          };
        }),
        open_late_arrivals: c.db.count(`SELECT COUNT(*) FROM meter_late_arrivals WHERE org_id = ? AND resolution = 'open'`, orgId),
        closed_periods: c.db.count(`SELECT COUNT(*) FROM meter_period_closures WHERE org_id = ?`, orgId),
        withdrawn_events: c.db.count(`SELECT COUNT(*) FROM meter_event_adjustments WHERE org_id = ?`, orgId),
        // Money already trued up, and the money still sitting in the queue.
        true_ups_settled: c.db.get<{ n: number; credited: number | null; rebilled: number | null }>(
          `SELECT COUNT(*) AS n,
                  SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS credited,
                  SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS rebilled
           FROM meter_late_arrivals WHERE org_id = ? AND resolution IN ('credited', 'rebilled')`, orgId,
        ) ?? { n: 0, credited: 0, rebilled: 0 },
        periods_awaiting_settlement: c.db.count(
          `SELECT COUNT(*) FROM jobs WHERE org_id = ? AND type = 'credits.settle_period' AND status = 'pending'`, orgId),
        // A period the automatic run declined to settle is the one number here
        // a human has to act on, so metering reports it too rather than leaving
        // it to whoever thinks to open the credits page.
        skipped_settlements: c.db.count(
          `SELECT COUNT(*) FROM events WHERE org_id = ? AND type = 'credit.settlement_skipped'`, orgId),
        settlement_jobs_failed: c.db.count(
          `SELECT COUNT(*) FROM jobs WHERE org_id = ? AND type = 'credits.settle_period' AND status = 'failed'`, orgId),
      };
    }, {
      summary: 'Ingestion health across every meter', tags: ['metering'],
      description:
        '`skipped_settlements` and `settlement_jobs_failed` are the two ways a metered period can end up unbilled. Both are counts a human can act on rather than lines in the event log.',
    });
  },

  /**
   * A metered period that nobody closes is usage nobody bills. These two
   * subscriptions are what make the whole engine run without a person holding
   * a curl command: billing says a cycle turned over or a subscription ended,
   * and every metered period it names becomes a settlement job.
   */
  on: {
    'subscription.invoice_due': settleArrearsOnInvoice,
    'subscription.canceled': settleFinalPeriodOnCancel,
  },

  tools(ctx) {
    return [
      {
        name: 'metering.usage_for_period',
        description: 'Aggregate one customer’s usage on a meter between two timestamps, honouring the meter’s aggregation (sum, count, max, last or unique).',
        readOnly: true,
        tags: ['billing', 'usage'],
        input: v.object({
          meter: v.string({ min: 1, max: 80, description: 'Meter id or event name.' }),
          customer: v.string({ min: 1, max: 120 }),
          start: v.timestamp(),
          end: v.timestamp(),
        }),
        run: (args: { meter: string; customer: string; start: number; end: number }, c: Ctx, meta) =>
          c.svc.metering.usageForPeriod(meta.orgId, args.meter, args.customer, args.start, args.end),
      },
      {
        name: 'metering.list_meters',
        description: 'List the workspace’s meters, what each one measures and how it aggregates.',
        readOnly: true,
        tags: ['billing', 'usage'],
        input: v.object({ status: v.optional(v.enum(METER_STATUSES)) }),
        run: (args: { status?: Meter['status'] }, c: Ctx, meta) => c.svc.metering.meters(meta.orgId, args),
      },
      {
        name: 'metering.late_arrivals',
        description: 'Usage that landed after its period was billed and still needs a true-up, newest first.',
        readOnly: true,
        tags: ['billing', 'usage'],
        input: v.object({ customer: v.optional(v.string({ max: 120 })), limit: v.optional(v.int({ min: 1, max: 50 })) }),
        run: (args: { customer?: string; limit?: number }, c: Ctx, meta) =>
          c.svc.metering.lateArrivals(meta.orgId, { ...args, resolution: 'open' }),
      },
    ];
  },
});
