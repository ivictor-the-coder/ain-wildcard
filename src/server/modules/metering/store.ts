/**
 * Reading and writing meters and their events.
 *
 * Two properties are load-bearing here and everything else follows from them:
 *
 *  - **Exactly once.** `identifier` is unique per workspace. A replayed event
 *    returns the original row untouched, so a client that retries a batch after
 *    a timeout can never double-bill a customer.
 *  - **Bounded reads.** An hourly pre-aggregate is maintained as events land.
 *    A period total reads whole hours from that pre-aggregate and only scans
 *    raw events for the (at most two) partial hours at the period's edges, so
 *    the number is exact without ever touching the bulk of the table.
 *
 * One rule follows from both and is easy to get wrong: **no `*_micro` column is
 * ever read as a JavaScript number.** A busy hour passes 2^53 micro-units long
 * before it passes anything else, and `node:sqlite` throws rather than round —
 * which would turn a written total into a permanently unreadable one. Every
 * read below projects those columns as text and folds them in BigInt, and every
 * write is checked against the 64-bit ceiling first, so a value this store
 * cannot read back is refused at the door instead of accepted and lost.
 */
import type { Ctx } from '../../kernel/context';
import { parseJson, type Bindable } from '../../kernel/db';
import { badRequest, conflict, notFound } from '../../../shared/errors';
import { cursorOf, newId, parseCursor } from '../../../shared/ids';
import { DAY, HOUR, MINUTE, startOfDay, startOfMonth } from '../../../shared/time';
import {
  assertStorableMicro, bigOf, microToDecimal, microToNumber, microToWholeUnits, parseMicro, toMicro,
} from './units';
import type {
  BatchItemResult, BatchResult, ClosureDetail, IngestResult, LateArrival, LateResolution, Meter,
  MeterAggregation, MeterEvent, MeterEventAdjustment, MeterEventInput, MeterInput, MeterStatus,
  PeriodClosure, PeriodUsage, SummaryBucket, SummaryGranularity, TrueUpRequest, TrueUpResult,
  TrueUpSink, UsageProvenance,
} from './types';

export const DEFAULT_ACCEPTANCE_WINDOW = 35 * DAY;
export const DEFAULT_FUTURE_TOLERANCE = 5 * MINUTE;
export const MAX_BATCH = 1000;
/** Guard rail on range queries so one bad request cannot read the whole table. */
const MAX_BUCKETS = 5000;
/**
 * How many hourly pre-aggregate rows one read may fold. Rows exist only for
 * hours that saw traffic, so a normal month is ~744 and this only ever catches
 * a query asking for a decade of a very busy meter.
 */
const MAX_SUMMARY_ROWS = 100_000;
const ONE = 1_000_000n;

const floorHour = (ts: number): number => Math.floor(ts / HOUR) * HOUR;
const ceilHour = (ts: number): number => Math.ceil(ts / HOUR) * HOUR;

interface MeterRow {
  id: string; org_id: string; name: string; event_name: string; aggregation: MeterAggregation;
  value_key: string | null; customer_key: string; unique_key: string | null; unit_label: string | null;
  status: MeterStatus; acceptance_window_ms: number; future_tolerance_ms: number;
  description: string | null; metadata: string; created: number; updated: number;
}

/** `value_micro` is text because it is read through `bigOf`, never as a double. */
interface EventRow {
  id: string; org_id: string; meter_id: string; identifier: string; event_name: string;
  customer_id: string; value_micro: string; unique_key: string | null; timestamp: number;
  hour_start: number; payload: string; late: number; closure_id: string | null; received_at: number;
  cancelled_at: number | null; adjustment_id: string | null;
}

const EVENT_COLUMNS = `id, org_id, meter_id, identifier, event_name, customer_id,
  CAST(value_micro AS TEXT) AS value_micro, unique_key, timestamp, hour_start, payload,
  late, closure_id, received_at, cancelled_at, adjustment_id`;

interface ClosureRow {
  id: string; org_id: string; meter_id: string; customer_id: string; period_start: number;
  period_end: number; aggregation: MeterAggregation; total_micro: string; event_count: number;
  adjustment_micro: string; settled_adjustment_micro: string; late_event_count: number;
  price_id: string | null; currency: string | null; prior_quantity_micro: string;
  ref_type: string | null; ref_id: string | null; closed_at: number;
}

const CLOSURE_COLUMNS = `id, org_id, meter_id, customer_id, period_start, period_end, aggregation,
  CAST(total_micro AS TEXT) AS total_micro, event_count,
  CAST(adjustment_micro AS TEXT) AS adjustment_micro,
  CAST(settled_adjustment_micro AS TEXT) AS settled_adjustment_micro,
  late_event_count, price_id, currency,
  CAST(prior_quantity_micro AS TEXT) AS prior_quantity_micro,
  ref_type, ref_id, closed_at`;

interface LateRow {
  id: string; org_id: string; meter_id: string; customer_id: string; event_id: string;
  closure_id: string; value_micro: string; timestamp: number; period_start: number;
  period_end: number; resolution: LateResolution; resolved_at: number | null;
  resolution_ref: string | null; amount: number | null; currency: string | null;
  billable_item_id: string | null; credit_amount: number | null; note: string | null;
  created: number;
}

const LATE_COLUMNS = `id, org_id, meter_id, customer_id, event_id, closure_id,
  CAST(value_micro AS TEXT) AS value_micro, timestamp, period_start, period_end,
  resolution, resolved_at, resolution_ref, amount, currency, billable_item_id,
  credit_amount, note, created`;

interface AdjustmentRow {
  id: string; org_id: string; meter_id: string; customer_id: string; event_id: string;
  identifier: string; type: 'cancel'; value_micro: string; timestamp: number;
  closure_id: string | null; late_arrival_id: string | null; reason: string | null; created: number;
}

const ADJUSTMENT_COLUMNS = `id, org_id, meter_id, customer_id, event_id, identifier, type,
  CAST(value_micro AS TEXT) AS value_micro, timestamp, closure_id, late_arrival_id, reason, created`;

/** One hour of the pre-aggregate, with every micro column already text. */
interface SummaryRow {
  hour_start: number; event_count: number; sum_micro: string; max_micro: string | null;
  last_micro: string | null; last_at: number | null; last_rowid: number | null;
}

const SUMMARY_COLUMNS = `hour_start, event_count, CAST(sum_micro AS TEXT) AS sum_micro,
  CAST(max_micro AS TEXT) AS max_micro, CAST(last_micro AS TEXT) AS last_micro,
  last_at, last_rowid`;

export interface MeterListFilter {
  status?: MeterStatus;
  aggregation?: MeterAggregation;
  search?: string;
}

export interface EventListFilter {
  meter?: string;
  customer?: string;
  start?: number;
  end?: number;
  late?: boolean;
  /** Withdrawn events are hidden unless asked for explicitly. */
  cancelled?: boolean;
  limit?: number;
  cursor?: string;
}

export interface CancelEventInput {
  /** Meter event id or the caller's own `identifier`. */
  identifier: string;
  /** Checked against the event when given, exactly as Stripe does. */
  event_name?: string | null;
  reason?: string | null;
}

export interface SummaryQuery {
  customer?: string;
  start: number;
  end: number;
  granularity?: SummaryGranularity;
}

export interface ClosePeriodInput {
  meter: string;
  customer: string;
  period_start: number;
  period_end: number;
  /** The price the period was billed on — what a later true-up re-prices. */
  price?: string | null;
  currency?: string | null;
  /**
   * Units of the same billing period already priced under an earlier window.
   * A true-up on this closure climbs the price's tiers from here, so a period
   * billed in two pieces never hands out its free tier twice.
   */
  prior_quantity?: number | string | null;
  ref_type?: string | null;
  ref_id?: string | null;
}

export interface ResolveLateArrivalInput {
  resolution: LateResolution;
  /** Overrides the closure's price, for a period closed without one. */
  price?: string | null;
  /** A human note. The only thing an `ignored` resolution records. */
  note?: string | null;
}

export class Metering {
  /**
   * Whoever turns a priced true-up into money. Metering can say exactly what a
   * billed period's drift is worth; it cannot put that on an invoice or hand
   * credit back, so it hands the number to the module that can. Left unset,
   * a true-up is still priced and recorded — it just has no line to point at.
   */
  private trueUpSink: TrueUpSink | null = null;

  constructor(private readonly ctx: Ctx) {}

  onTrueUp(sink: TrueUpSink): void { this.trueUpSink = sink; }

  /* -------------------------------- meters -------------------------------- */

  meters(orgId: string, filter: MeterListFilter = {}): Meter[] {
    const clauses = ['org_id = ?'];
    const params: Bindable[] = [orgId];
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
    else clauses.push(`status <> 'archived'`);
    if (filter.aggregation) { clauses.push('aggregation = ?'); params.push(filter.aggregation); }
    if (filter.search) { clauses.push('(name LIKE ? OR event_name LIKE ?)'); params.push(`%${filter.search}%`, `%${filter.search}%`); }
    return this.ctx.db
      .all<MeterRow>(`SELECT * FROM meters WHERE ${clauses.join(' AND ')} ORDER BY name`, ...params)
      .map(hydrateMeter);
  }

  /** Meters resolve by id or by the event name they listen for. */
  meter(orgId: string, key: string): Meter | null {
    const row = this.ctx.db.get<MeterRow>(
      `SELECT * FROM meters WHERE org_id = ? AND (id = ? OR (event_name = ? AND status <> 'archived'))
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`,
      orgId, key, key, key,
    );
    return row ? hydrateMeter(row) : null;
  }

  requireMeter(orgId: string, key: string): Meter {
    const found = this.meter(orgId, key);
    if (!found) throw notFound('meter', key);
    return found;
  }

  createMeter(orgId: string, input: MeterInput): Meter {
    const now = this.ctx.now();
    const aggregation = input.aggregation ?? 'sum';
    const eventName = input.event_name.trim();
    if (!/^[a-z0-9][a-z0-9_.-]{1,79}$/.test(eventName)) {
      throw badRequest(
        'parameter_invalid',
        'An event name is lowercase letters, digits, dots, dashes and underscores — for example "telemetry_events".',
        'event_name',
      );
    }
    const clash = this.ctx.db.get<{ id: string }>(
      `SELECT id FROM meters WHERE org_id = ? AND event_name = ? AND status <> 'archived'`, orgId, eventName);
    if (clash) {
      throw conflict(
        'meter_event_name_in_use',
        `Events named "${eventName}" already route to meter ${clash.id}. Archive that meter first, or pick another event name.`,
      );
    }
    // `count` and `unique` never read a value: one event is one observation,
    // and for `unique` it is the subject key that decides whether it counts.
    const countsEvents = aggregation === 'count' || aggregation === 'unique';
    const valueKey = countsEvents ? null : (input.value_key ?? 'value');
    const uniqueKey = aggregation === 'unique'
      ? (input.unique_key ?? input.value_key ?? 'value')
      : (input.unique_key ?? null);
    const row = {
      id: input.id ?? newId('meter'),
      org_id: orgId,
      name: input.name.trim(),
      event_name: eventName,
      aggregation,
      value_key: valueKey,
      customer_key: (input.customer_key ?? 'customer_id').trim(),
      unique_key: uniqueKey,
      unit_label: input.unit_label ?? null,
      status: input.status ?? 'active',
      acceptance_window_ms: input.acceptance_window_ms ?? DEFAULT_ACCEPTANCE_WINDOW,
      future_tolerance_ms: input.future_tolerance_ms ?? DEFAULT_FUTURE_TOLERANCE,
      description: input.description ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
      created: now,
      updated: now,
    };
    this.ctx.db.insert('meters', row);
    return hydrateMeter(row as unknown as MeterRow);
  }

  updateMeter(orgId: string, id: string, patch: Partial<MeterInput>): Meter {
    const meter = this.requireMeter(orgId, id);
    // Aggregation, keys and event name are frozen: changing them would silently
    // reinterpret every summary row already written against this meter.
    const frozen: (keyof MeterInput & keyof Meter)[] = ['aggregation', 'value_key', 'customer_key', 'unique_key', 'event_name'];
    for (const field of frozen) {
      if (patch[field] !== undefined && patch[field] !== meter[field]) {
        throw badRequest(
          'meter_field_immutable',
          `A meter's ${field.replace(/_/g, ' ')} is fixed once it exists, because the hourly summaries already written were aggregated under the old rule. Create a new meter and point the price at it.`,
          field,
        );
      }
    }
    const changes: Record<string, Bindable> = { updated: this.ctx.now() };
    if (patch.name !== undefined) changes.name = patch.name.trim();
    if (patch.description !== undefined) changes.description = patch.description;
    if (patch.unit_label !== undefined) changes.unit_label = patch.unit_label;
    if (patch.status !== undefined) changes.status = patch.status;
    if (patch.acceptance_window_ms !== undefined) changes.acceptance_window_ms = patch.acceptance_window_ms;
    if (patch.future_tolerance_ms !== undefined) changes.future_tolerance_ms = patch.future_tolerance_ms;
    if (patch.metadata !== undefined) changes.metadata = JSON.stringify(patch.metadata);
    this.ctx.db.patch('meters', 'id', meter.id, changes);
    return this.requireMeter(orgId, meter.id);
  }

  /* ------------------------------- ingestion ------------------------------ */

  /** Record one event, transactionally. A replay returns the original row. */
  ingest(orgId: string, input: MeterEventInput): IngestResult {
    return this.ctx.atomic(() => {
      const result = this.ingestOne(orgId, input);
      this.ctx.emit(orgId, 'meter.events_ingested', {
        recorded: result.outcome === 'recorded' ? 1 : 0,
        duplicates: result.outcome === 'duplicate' ? 1 : 0,
        errors: 0,
        late: result.late_arrival ? 1 : 0,
        submitted: 1,
        meter: result.event.meter,
        customer: result.event.customer,
      }, { objectId: result.event.id, objectType: 'meter_event' });
      return result;
    });
  }

  ingestBatch(orgId: string, inputs: MeterEventInput[]): BatchResult {
    if (inputs.length > MAX_BATCH) {
      throw badRequest('batch_too_large', `A batch carries at most ${MAX_BATCH} events; this one had ${inputs.length}. Split it and retry.`, 'events');
    }
    const results: BatchItemResult[] = [];
    let recorded = 0, duplicates = 0, errors = 0, late = 0;
    // One outer transaction, one savepoint per item: the batch commits once and
    // a single malformed event fails on its own without taking the rest with it.
    this.ctx.atomic(() => {
      inputs.forEach((input, index) => {
        try {
          const out = this.ctx.atomic(() => this.ingestOne(orgId, input));
          if (out.outcome === 'recorded') recorded++; else duplicates++;
          if (out.late_arrival) late++;
          results.push({
            index, identifier: out.event.identifier, outcome: out.outcome,
            event: out.event, late_arrival: out.late_arrival, error: null,
          });
        } catch (e) {
          errors++;
          results.push({
            index, identifier: input.identifier ?? null, outcome: 'error',
            event: null, late_arrival: null, error: describeError(e),
          });
        }
      });
      this.ctx.emit(orgId, 'meter.events_ingested', {
        recorded, duplicates, errors, late, submitted: inputs.length,
      }, { objectType: 'meter_event_batch' });
    });
    return { object: 'meter_event_batch', recorded, duplicates, errors, late, results };
  }

  private ingestOne(orgId: string, input: MeterEventInput): IngestResult {
    const now = this.ctx.now();
    const key = input.event_name ?? input.meter;
    if (!key) throw badRequest('parameter_missing', 'Every meter event names the meter it belongs to via `event_name`.', 'event_name');
    const meter = this.requireMeter(orgId, key);
    if (meter.status !== 'active') {
      throw badRequest('meter_inactive', `Meter ${meter.id} ("${meter.name}") is ${meter.status}, so it is not accepting events.`, 'event_name');
    }

    const identifier = (input.identifier ?? newId('usage')).trim();
    const existing = this.ctx.db.get<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM meter_events WHERE org_id = ? AND identifier = ?`, orgId, identifier);
    if (existing) {
      // The whole point of the identifier: a retry is a read, not a write. A
      // withdrawn event keeps its identifier claimed for exactly this reason —
      // replaying the original must not resurrect what was cancelled.
      return {
        object: 'meter_event_result',
        outcome: 'duplicate',
        event: hydrateEvent(existing),
        late_arrival: existing.closure_id ? this.lateArrivalForEvent(orgId, existing.id) : null,
      };
    }

    const timestamp = input.timestamp ?? now;
    const earliest = now - meter.acceptance_window_ms;
    if (timestamp < earliest) {
      throw badRequest(
        'meter_event_timestamp_too_old',
        `That event is timestamped ${new Date(timestamp).toISOString()}, outside meter "${meter.name}"'s ${formatWindow(meter.acceptance_window_ms)} acceptance window — the earliest timestamp accepted right now is ${new Date(earliest).toISOString()}. Accepting it silently would move a total that has already been invoiced.`,
        'timestamp',
        { earliest_acceptable: earliest, acceptance_window_ms: meter.acceptance_window_ms, meter: meter.id },
      );
    }
    if (timestamp > now + meter.future_tolerance_ms) {
      throw badRequest(
        'meter_event_timestamp_in_future',
        `That event is timestamped ${new Date(timestamp).toISOString()}, more than ${formatWindow(meter.future_tolerance_ms)} ahead of the workspace clock (${new Date(now).toISOString()}). Check the sending system's clock.`,
        'timestamp',
        { latest_acceptable: now + meter.future_tolerance_ms, meter: meter.id },
      );
    }

    const payload = input.payload ?? {};
    const customer = String(input.customer ?? payload[meter.customer_key] ?? '').trim();
    if (!customer) {
      throw badRequest(
        'meter_event_customer_missing',
        `Meter "${meter.name}" reads the customer from the payload key "${meter.customer_key}", which this event does not carry.`,
        `payload.${meter.customer_key}`,
      );
    }

    const valueMicro = meter.aggregation === 'count' || meter.aggregation === 'unique'
      ? ONE
      : toMicro(valueFrom(meter, input, payload), meter.value_key ? `payload.${meter.value_key}` : 'value');

    let uniqueKey: string | null = null;
    if (meter.aggregation === 'unique') {
      const raw = payload[meter.unique_key ?? ''];
      uniqueKey = raw === undefined || raw === null ? '' : String(raw).trim();
      if (!uniqueKey) {
        throw badRequest(
          'meter_event_unique_key_missing',
          `Meter "${meter.name}" counts distinct values of the payload key "${meter.unique_key}", which this event does not carry.`,
          `payload.${meter.unique_key}`,
        );
      }
    }

    const hourStart = floorHour(timestamp);
    // Checked before the write, not after: an hour whose fold would pass the
    // 64-bit ceiling is refused here rather than silently overflowing a column
    // the rest of the platform then cannot read.
    const hourSoFar = bigOf(this.ctx.db.pluck<string>(
      `SELECT CAST(sum_micro AS TEXT) FROM meter_event_summaries
       WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND hour_start = ?`,
      orgId, meter.id, customer, hourStart,
    ));
    assertStorableMicro(hourSoFar + valueMicro, {
      subject: `Meter "${meter.name}" has already taken ${microToDecimal(hourSoFar)} ${meter.unit_label ?? 'unit'}s for this customer in the UTC hour beginning ${new Date(hourStart).toISOString()}; with this event that hour`,
      param: 'value',
      remedy: 'Record this reading against a coarser unit — gigabytes rather than bytes — so an hour of traffic fits in a number the invoice can carry.',
    });

    const id = newId('usage');
    const inserted = this.ctx.db.insert('meter_events', {
      id, org_id: orgId, meter_id: meter.id, identifier, event_name: meter.event_name,
      customer_id: customer, value_micro: valueMicro, unique_key: uniqueKey, timestamp,
      hour_start: hourStart, payload: JSON.stringify(payload), late: 0, closure_id: null, received_at: now,
      cancelled_at: null, adjustment_id: null,
    });
    const rowid = Number(inserted.lastInsertRowid);

    let newUnique = 0;
    if (uniqueKey !== null) {
      newUnique = this.ctx.db.run(
        `INSERT OR IGNORE INTO meter_event_uniques (org_id, meter_id, customer_id, hour_start, unique_key, first_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        orgId, meter.id, customer, hourStart, uniqueKey, timestamp,
      ).changes;
    }
    this.foldIntoSummary(orgId, meter.id, customer, hourStart, valueMicro, timestamp, rowid, newUnique, now);

    const closure = this.closureContaining(orgId, meter.id, customer, timestamp);

    let lateArrival: LateArrival | null = null;
    if (closure) {
      this.ctx.db.patch('meter_events', 'id', id, { late: 1, closure_id: closure.id });
      lateArrival = this.fileAgainstClosure(orgId, closure, {
        meterId: meter.id, customer, eventId: id, valueMicro, timestamp, now,
      });
      this.ctx.emit(orgId, 'meter.event_late', {
        meter: meter.id, meter_name: meter.name, customer, event: id,
        value: microToNumber(valueMicro), value_decimal: microToDecimal(valueMicro),
        timestamp, period_start: closure.period_start, period_end: closure.period_end,
        closure: closure.id, billed_total_decimal: microToDecimal(bigOf(closure.total_micro)),
      }, { objectId: lateArrival.id, objectType: 'meter_late_arrival' });
    }

    const event = hydrateEvent({
      id, org_id: orgId, meter_id: meter.id, identifier, event_name: meter.event_name,
      customer_id: customer, value_micro: String(valueMicro), unique_key: uniqueKey, timestamp,
      hour_start: hourStart, payload: JSON.stringify(payload), late: closure ? 1 : 0,
      closure_id: closure?.id ?? null, received_at: now, cancelled_at: null, adjustment_id: null,
    });
    return { object: 'meter_event_result', outcome: 'recorded', event, late_arrival: lateArrival };
  }

  /** The billed period a timestamp falls inside, if there is one. */
  private closureContaining(orgId: string, meterId: string, customer: string, ts: number): ClosureRow | undefined {
    return this.ctx.db.get<ClosureRow>(
      `SELECT ${CLOSURE_COLUMNS} FROM meter_period_closures
       WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND period_start <= ? AND period_end > ?
       ORDER BY closed_at DESC LIMIT 1`,
      orgId, meterId, customer, ts, ts,
    );
  }

  /**
   * Put one movement into a billed period's true-up queue.
   *
   * Positive for usage that arrived late, negative for usage withdrawn by an
   * adjustment. Either way the closure's billed total does not move — only the
   * difference between it and the live total, which is what a true-up settles.
   */
  private fileAgainstClosure(
    orgId: string, closure: ClosureRow,
    input: { meterId: string; customer: string; eventId: string; valueMicro: bigint; timestamp: number; now: number },
  ): LateArrival {
    const id = newId('usage');
    this.ctx.db.insert('meter_late_arrivals', {
      id, org_id: orgId, meter_id: input.meterId, customer_id: input.customer, event_id: input.eventId,
      closure_id: closure.id, value_micro: input.valueMicro, timestamp: input.timestamp,
      period_start: closure.period_start, period_end: closure.period_end,
      resolution: 'open', resolved_at: null, resolution_ref: null, created: input.now,
    });
    this.ctx.db.run(
      `UPDATE meter_period_closures
       SET adjustment_micro = adjustment_micro + ?, late_event_count = late_event_count + 1 WHERE id = ?`,
      input.valueMicro, closure.id,
    );
    const filed = this.lateArrival(orgId, id);
    if (!filed) throw notFound('late arrival', id);
    return filed;
  }

  private foldIntoSummary(
    orgId: string, meterId: string, customer: string, hourStart: number,
    valueMicro: bigint, timestamp: number, rowid: number, newUnique: number, now: number,
  ): void {
    // `last` must survive out-of-order arrival, so an event that arrives later
    // but is timestamped earlier never becomes the period's closing reading.
    const wins = `(meter_event_summaries.last_at IS NULL
        OR excluded.last_at > meter_event_summaries.last_at
        OR (excluded.last_at = meter_event_summaries.last_at AND excluded.last_rowid > meter_event_summaries.last_rowid))`;
    this.ctx.db.run(
      `INSERT INTO meter_event_summaries
         (org_id, meter_id, customer_id, hour_start, event_count, sum_micro, max_micro, last_micro, last_at, last_rowid, unique_count, first_at, updated)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, meter_id, customer_id, hour_start) DO UPDATE SET
         event_count  = meter_event_summaries.event_count + 1,
         sum_micro    = meter_event_summaries.sum_micro + excluded.sum_micro,
         max_micro    = CASE WHEN meter_event_summaries.max_micro IS NULL OR excluded.max_micro > meter_event_summaries.max_micro
                             THEN excluded.max_micro ELSE meter_event_summaries.max_micro END,
         last_micro   = CASE WHEN ${wins} THEN excluded.last_micro ELSE meter_event_summaries.last_micro END,
         last_at      = CASE WHEN ${wins} THEN excluded.last_at ELSE meter_event_summaries.last_at END,
         last_rowid   = CASE WHEN ${wins} THEN excluded.last_rowid ELSE meter_event_summaries.last_rowid END,
         unique_count = meter_event_summaries.unique_count + excluded.unique_count,
         first_at     = MIN(meter_event_summaries.first_at, excluded.first_at),
         updated      = excluded.updated`,
      orgId, meterId, customer, hourStart, valueMicro, valueMicro, valueMicro, timestamp, rowid, newUnique, timestamp, now,
    );
  }

  /* ------------------------------- retrieval ------------------------------ */

  event(orgId: string, id: string): MeterEvent | null {
    const row = this.eventRow(orgId, id);
    return row ? hydrateEvent(row) : null;
  }

  /** Events resolve by id or by the caller's own `identifier`, never both. */
  private eventRow(orgId: string, key: string): EventRow | undefined {
    return this.ctx.db.get<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM meter_events WHERE org_id = ? AND (id = ? OR identifier = ?)
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`,
      orgId, key, key, key,
    );
  }

  events(orgId: string, filter: EventListFilter = {}): { data: MeterEvent[]; hasMore: boolean; nextCursor: string | null } {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const clauses = ['org_id = ?'];
    const params: Bindable[] = [orgId];
    if (filter.meter) { clauses.push('meter_id = ?'); params.push(this.requireMeter(orgId, filter.meter).id); }
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.start !== undefined) { clauses.push('timestamp >= ?'); params.push(filter.start); }
    if (filter.end !== undefined) { clauses.push('timestamp < ?'); params.push(filter.end); }
    if (filter.late !== undefined) { clauses.push('late = ?'); params.push(filter.late ? 1 : 0); }
    // A withdrawn event no longer counts towards anything, so it is out of the
    // default list; `cancelled=true` is how you go and look at what was undone.
    clauses.push(filter.cancelled === undefined
      ? 'cancelled_at IS NULL'
      : filter.cancelled ? 'cancelled_at IS NOT NULL' : 'cancelled_at IS NULL');
    const cursor = filter.cursor ? parseCursor(filter.cursor) : null;
    if (filter.cursor && !cursor) {
      throw badRequest('parameter_invalid', 'That pagination cursor is not readable. Start the list again without one.', 'cursor');
    }
    if (cursor) {
      clauses.push('(received_at < ? OR (received_at = ? AND id < ?))');
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = this.ctx.db.all<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM meter_events WHERE ${clauses.join(' AND ')} ORDER BY received_at DESC, id DESC LIMIT ?`,
      ...params, limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map(hydrateEvent),
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit && last ? cursorOf(last.received_at, last.id) : null,
    };
  }

  /* ---------------------------- period totals ----------------------------- */

  /**
   * The number that becomes an invoice line.
   *
   * Whole hours come from the pre-aggregate; the partial hours at each edge are
   * read from the raw events, so a period that does not start on the hour is
   * still exact. `provenance` reports which part came from where.
   */
  usageForPeriod(orgId: string, meterKey: string, customerId: string, start: number, end: number): PeriodUsage {
    const meter = this.requireMeter(orgId, meterKey);
    if (!(end > start)) throw badRequest('parameter_invalid', 'A usage period ends after it starts.', 'period_end');
    const now = this.ctx.now();

    const firstFull = ceilHour(start);
    const lastFull = floorHour(end);
    const hasFullHours = lastFull > firstFull;
    const leadRange: [number, number] | null = hasFullHours
      ? (firstFull > start ? [start, firstFull] : null)
      : [start, end];
    const trailRange: [number, number] | null = hasFullHours && end > lastFull ? [lastFull, end] : null;

    const edgeRows = [
      ...(leadRange ? this.rawRange(orgId, meter.id, customerId, leadRange[0], leadRange[1]) : []),
      ...(trailRange ? this.rawRange(orgId, meter.id, customerId, trailRange[0], trailRange[1]) : []),
    ];

    // Whole hours are folded in BigInt rather than by SQL's SUM(): a busy month
    // can carry a total past what a 64-bit accumulator holds, and the number on
    // an invoice is not a place to find that out.
    const hours = hasFullHours ? this.summaryRange(orgId, meter.id, customerId, firstFull, lastFull) : [];
    const summarizedHours = hours.length;
    let value = 0n;
    let eventCount = edgeRows.length;
    for (const hour of hours) eventCount += hour.event_count;

    switch (meter.aggregation) {
      case 'sum':
        for (const hour of hours) value += bigOf(hour.sum_micro);
        for (const r of edgeRows) value += bigOf(r.value_micro);
        break;
      case 'count':
        value = BigInt(eventCount) * ONE;
        break;
      case 'max':
        for (const hour of hours) { const v = bigOf(hour.max_micro); if (v > value) value = v; }
        for (const r of edgeRows) { const v = bigOf(r.value_micro); if (v > value) value = v; }
        break;
      case 'last': {
        let bestAt = -1, bestSeq = -1;
        for (const hour of hours) {
          if (hour.last_at === null) continue;
          const seq = Number(hour.last_rowid ?? 0);
          if (hour.last_at > bestAt || (hour.last_at === bestAt && seq > bestSeq)) {
            value = bigOf(hour.last_micro); bestAt = hour.last_at; bestSeq = seq;
          }
        }
        for (const r of edgeRows) {
          if (r.timestamp > bestAt || (r.timestamp === bestAt && r.seq > bestSeq)) {
            value = bigOf(r.value_micro); bestAt = r.timestamp; bestSeq = r.seq;
          }
        }
        break;
      }
      case 'unique': {
        if (!edgeRows.length) {
          const n = hasFullHours
            ? this.ctx.db.pluck<number>(
                `SELECT COUNT(DISTINCT unique_key) FROM meter_event_uniques
                 WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND hour_start >= ? AND hour_start < ?`,
                orgId, meter.id, customerId, firstFull, lastFull,
              ) ?? 0
            : 0;
          value = BigInt(n) * ONE;
        } else {
          const keys = new Set<string>();
          if (hasFullHours) {
            for (const r of this.ctx.db.all<{ unique_key: string }>(
              `SELECT DISTINCT unique_key FROM meter_event_uniques
               WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND hour_start >= ? AND hour_start < ?`,
              orgId, meter.id, customerId, firstFull, lastFull,
            )) keys.add(r.unique_key);
          }
          for (const r of edgeRows) if (r.unique_key) keys.add(r.unique_key);
          value = BigInt(keys.size) * ONE;
        }
        break;
      }
    }

    const closure = this.closureRow(orgId, meter.id, customerId, start, end);
    // Derived from the live total rather than a counter, so it cannot drift.
    const lateValue = closure ? value - bigOf(closure.total_micro) : 0n;

    const provenance: UsageProvenance = {
      summarized_hours: summarizedHours,
      scanned_events: edgeRows.length,
      partial_leading_hour: start % HOUR !== 0,
      partial_trailing_hour: end % HOUR !== 0,
    };

    return {
      object: 'meter_usage',
      meter: meter.id,
      meter_name: meter.name,
      event_name: meter.event_name,
      aggregation: meter.aggregation,
      unit_label: meter.unit_label,
      customer: customerId,
      period_start: start,
      period_end: end,
      value: microToNumber(value),
      value_decimal: microToDecimal(value),
      billable_quantity: microToWholeUnits(value),
      event_count: eventCount,
      pending: end > now,
      provenance,
      closed: closure ? hydrateClosure(closure) : null,
      late_adjustment: closure && (lateValue !== 0n || closure.late_event_count > 0)
        ? { value: microToNumber(lateValue), value_decimal: microToDecimal(lateValue), event_count: closure.late_event_count }
        : null,
      as_of: now,
    };
  }

  private rawRange(orgId: string, meterId: string, customerId: string, from: number, to: number) {
    return this.ctx.db.all<{ seq: number; value_micro: string; timestamp: number; unique_key: string | null }>(
      `SELECT rowid AS seq, CAST(value_micro AS TEXT) AS value_micro, timestamp, unique_key FROM meter_events
       WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND timestamp >= ? AND timestamp < ?
         AND cancelled_at IS NULL
       ORDER BY timestamp ASC, rowid ASC`,
      orgId, meterId, customerId, from, to,
    );
  }

  /** The hourly pre-aggregate over a range, every micro column already text. */
  private summaryRange(orgId: string, meterId: string, customerId: string, from: number, to: number): SummaryRow[] {
    const rows = this.ctx.db.all<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM meter_event_summaries
       WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND hour_start >= ? AND hour_start < ?
       ORDER BY hour_start ASC LIMIT ?`,
      orgId, meterId, customerId, from, to, MAX_SUMMARY_ROWS + 1,
    );
    if (rows.length > MAX_SUMMARY_ROWS) {
      throw badRequest(
        'usage_range_too_large',
        `That period covers more than ${MAX_SUMMARY_ROWS.toLocaleString('en-US')} hours of recorded traffic on this meter. Bill it in shorter periods.`,
        'period_start',
        { maximum_hours: MAX_SUMMARY_ROWS },
      );
    }
    return rows;
  }

  /* ------------------------------ summaries ------------------------------- */

  summaries(orgId: string, meterKey: string, query: SummaryQuery): SummaryBucket[] {
    const meter = this.requireMeter(orgId, meterKey);
    const granularity = query.granularity ?? 'hour';
    if (!(query.end > query.start)) throw badRequest('parameter_invalid', 'The summary range ends after it starts.', 'end');
    const bucketMs = granularity === 'hour' ? HOUR : granularity === 'day' ? DAY : 28 * DAY;
    if ((query.end - query.start) / bucketMs > MAX_BUCKETS) {
      throw badRequest(
        'range_too_large',
        `That range covers more than ${MAX_BUCKETS.toLocaleString('en-US')} ${granularity} buckets. Narrow the range or ask for a coarser granularity.`,
        'granularity',
      );
    }
    const from = floorHour(query.start);
    const to = ceilHour(query.end);
    const bucketOf = bucketStart(granularity);

    const clauses = ['org_id = ?', 'meter_id = ?'];
    const params: Bindable[] = [orgId, meter.id];
    if (query.customer) { clauses.push('customer_id = ?'); params.push(query.customer); }
    clauses.push('hour_start >= ?', 'hour_start < ?');
    params.push(from, to);

    interface Bucket { value: bigint; events: number; lastAt: number; lastSeq: number }
    const buckets = new Map<number, Bucket>();
    const touch = (start: number): Bucket => {
      let b = buckets.get(start);
      if (!b) { b = { value: 0n, events: 0, lastAt: -1, lastSeq: -1 }; buckets.set(start, b); }
      return b;
    };

    const rows = this.ctx.db.all<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM meter_event_summaries WHERE ${clauses.join(' AND ')}
       ORDER BY hour_start ASC LIMIT ?`,
      ...params, MAX_SUMMARY_ROWS + 1,
    );
    if (rows.length > MAX_SUMMARY_ROWS) {
      throw badRequest(
        'range_too_large',
        `That range covers more than ${MAX_SUMMARY_ROWS.toLocaleString('en-US')} hours of recorded traffic on this meter. Narrow it.`,
        'start',
        { maximum_hours: MAX_SUMMARY_ROWS },
      );
    }
    for (const row of rows) {
      const b = touch(bucketOf(row.hour_start));
      b.events += row.event_count;
      switch (meter.aggregation) {
        case 'sum': b.value += bigOf(row.sum_micro); break;
        case 'count': b.value += BigInt(row.event_count) * ONE; break;
        case 'max': { const v = bigOf(row.max_micro); if (v > b.value) b.value = v; break; }
        case 'last': {
          const at = row.last_at ?? -1;
          const seq = Number(row.last_rowid ?? -1);
          if (at > b.lastAt || (at === b.lastAt && seq > b.lastSeq)) {
            b.value = bigOf(row.last_micro); b.lastAt = at; b.lastSeq = seq;
          }
          break;
        }
        case 'unique': break; // counted from the distinct-subject index below
      }
    }

    if (meter.aggregation === 'unique') {
      const seen = new Map<number, Set<string>>();
      for (const row of this.ctx.db.all<{ hour_start: number; unique_key: string }>(
        `SELECT DISTINCT hour_start, unique_key FROM meter_event_uniques WHERE ${clauses.join(' AND ')}`,
        ...params,
      )) {
        const start = bucketOf(row.hour_start);
        let set = seen.get(start);
        if (!set) { set = new Set<string>(); seen.set(start, set); }
        set.add(row.unique_key);
      }
      for (const [start, set] of seen) touch(start).value = BigInt(set.size) * ONE;
    }

    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([start, b]) => ({
        object: 'meter_event_summary' as const,
        meter: meter.id,
        customer: query.customer ?? 'all',
        start,
        end: nextBucket(granularity, start),
        granularity,
        aggregation: meter.aggregation,
        value: microToNumber(b.value),
        value_decimal: microToDecimal(b.value),
        event_count: b.events,
      }));
  }

  /* --------------------------- period lifecycle --------------------------- */

  /**
   * Mark a period as billed. Everything that lands inside it afterwards is
   * still recorded, but is reported as a late arrival rather than quietly
   * moving a number that is already on an invoice.
   */
  closePeriod(orgId: string, input: ClosePeriodInput): PeriodClosure {
    const meter = this.requireMeter(orgId, input.meter);
    return this.ctx.atomic(() => {
      const existing = this.closureRow(orgId, meter.id, input.customer, input.period_start, input.period_end);
      if (existing) return hydrateClosure(existing);
      if (!(input.period_end > input.period_start)) {
        throw badRequest('parameter_invalid', 'A billing period ends after it starts.', 'period_end');
      }
      // Two closures over overlapping windows mean the same usage believes it
      // is on two invoices. A boundary that has moved by a millisecond is a
      // retry that lost its place, not a new period, and it says so out loud.
      const clash = this.overlappingClosure(orgId, meter.id, input.customer, input.period_start, input.period_end);
      if (clash) {
        throw conflict(
          'meter_period_overlaps_closure',
          `Closure ${clash.id} already covers ${new Date(clash.period_start).toISOString()} to ${new Date(clash.period_end).toISOString()} for this customer on "${meter.name}", which overlaps the period you asked to close. Two closures over the same usage would put it on two invoices.`,
          {
            closure: clash.id, period_start: clash.period_start, period_end: clash.period_end,
            requested_start: input.period_start, requested_end: input.period_end,
          },
        );
      }
      const usage = this.usageForPeriod(orgId, meter.id, input.customer, input.period_start, input.period_end);
      const totalMicro = assertStorableMicro(parseMicro(usage.value_decimal, 'value'), {
        subject: `This period's total on "${meter.name}"`,
        param: 'period_end',
        remedy: 'Close it as two shorter periods.',
      });
      // Resolved to an id here, once, so a true-up months later re-prices the
      // period against the same price the invoice was drawn from even if the
      // lookup key has since been pointed somewhere else.
      const price = input.price ? this.ctx.svc.catalog.requirePrice(orgId, input.price) : null;
      const priorMicro = input.prior_quantity === undefined || input.prior_quantity === null
        ? 0n
        : parseMicro(input.prior_quantity, 'prior_quantity');
      const row = {
        id: newId('usage'),
        org_id: orgId,
        meter_id: meter.id,
        customer_id: input.customer,
        period_start: input.period_start,
        period_end: input.period_end,
        aggregation: meter.aggregation,
        total_micro: totalMicro,
        event_count: usage.event_count,
        adjustment_micro: 0,
        settled_adjustment_micro: 0,
        late_event_count: 0,
        price_id: price?.id ?? null,
        currency: (input.currency ?? price?.currency ?? null)?.toLowerCase() ?? null,
        prior_quantity_micro: priorMicro,
        ref_type: input.ref_type ?? null,
        ref_id: input.ref_id ?? null,
        closed_at: this.ctx.now(),
      };
      this.ctx.db.insert('meter_period_closures', row);
      this.ctx.emit(orgId, 'meter.period_closed', {
        meter: meter.id, meter_name: meter.name, customer: input.customer,
        period_start: input.period_start, period_end: input.period_end,
        total: usage.value, total_decimal: usage.value_decimal, event_count: usage.event_count,
        price: row.price_id, currency: row.currency,
        ref_type: row.ref_type, ref_id: row.ref_id,
      }, { objectId: row.id, objectType: 'meter_period_closure' });
      return hydrateClosure({
        ...row, total_micro: String(totalMicro), adjustment_micro: '0', settled_adjustment_micro: '0',
        prior_quantity_micro: String(priorMicro),
      } as ClosureRow);
    });
  }

  private closureRow(orgId: string, meterId: string, customer: string, start: number, end: number): ClosureRow | undefined {
    return this.ctx.db.get<ClosureRow>(
      `SELECT ${CLOSURE_COLUMNS} FROM meter_period_closures
       WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND period_start = ? AND period_end = ?`,
      orgId, meterId, customer, start, end,
    );
  }

  /** Half-open intervals overlap when each starts before the other ends. */
  private overlappingClosure(orgId: string, meterId: string, customer: string, start: number, end: number): ClosureRow | undefined {
    return this.ctx.db.get<ClosureRow>(
      `SELECT ${CLOSURE_COLUMNS} FROM meter_period_closures
       WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND period_start < ? AND period_end > ?
       ORDER BY period_start ASC LIMIT 1`,
      orgId, meterId, customer, end, start,
    );
  }

  closures(orgId: string, filter: { meter?: string; customer?: string; limit?: number } = {}): PeriodClosure[] {
    const clauses = ['org_id = ?'];
    const params: Bindable[] = [orgId];
    if (filter.meter) { clauses.push('meter_id = ?'); params.push(this.requireMeter(orgId, filter.meter).id); }
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    return this.ctx.db.all<ClosureRow>(
      `SELECT ${CLOSURE_COLUMNS} FROM meter_period_closures WHERE ${clauses.join(' AND ')}
       ORDER BY period_end DESC, closed_at DESC LIMIT ?`,
      ...params, Math.min(filter.limit ?? 50, 200),
    ).map(hydrateClosure);
  }

  lateArrivals(
    orgId: string,
    filter: { meter?: string; customer?: string; resolution?: LateResolution; limit?: number } = {},
  ): LateArrival[] {
    const clauses = ['org_id = ?'];
    const params: Bindable[] = [orgId];
    if (filter.meter) { clauses.push('meter_id = ?'); params.push(this.requireMeter(orgId, filter.meter).id); }
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    if (filter.resolution) { clauses.push('resolution = ?'); params.push(filter.resolution); }
    return this.ctx.db.all<LateRow>(
      `SELECT ${LATE_COLUMNS} FROM meter_late_arrivals WHERE ${clauses.join(' AND ')} ORDER BY created DESC LIMIT ?`,
      ...params, Math.min(filter.limit ?? 50, 200),
    ).map(hydrateLate);
  }

  lateArrival(orgId: string, id: string): LateArrival | null {
    const row = this.ctx.db.get<LateRow>(
      `SELECT ${LATE_COLUMNS} FROM meter_late_arrivals WHERE org_id = ? AND id = ?`, orgId, id);
    return row ? hydrateLate(row) : null;
  }

  private lateArrivalForEvent(orgId: string, eventId: string): LateArrival | null {
    const row = this.ctx.db.get<LateRow>(
      `SELECT ${LATE_COLUMNS} FROM meter_late_arrivals WHERE org_id = ? AND event_id = ? ORDER BY created ASC LIMIT 1`,
      orgId, eventId);
    return row ? hydrateLate(row) : null;
  }

  closureById(orgId: string, id: string): ClosureRow | undefined {
    return this.ctx.db.get<ClosureRow>(
      `SELECT ${CLOSURE_COLUMNS} FROM meter_period_closures WHERE org_id = ? AND id = ?`, orgId, id);
  }

  /** A closure plus the one figure a list cannot afford to compute: the drift. */
  closureDetail(orgId: string, id: string): ClosureDetail | null {
    const row = this.closureById(orgId, id);
    if (!row) return null;
    const closure = hydrateClosure(row);
    const drift = this.outstanding(orgId, row);
    let amount: number | null = null;
    if (row.price_id) {
      try { amount = this.priceDrift(orgId, row, row.price_id, drift).amount; }
      catch { amount = null; }
    }
    return {
      ...closure,
      live_total: microToNumber(drift.live),
      live_total_decimal: microToDecimal(drift.live),
      outstanding_amount: amount,
      outstanding_quantity: microToNumber(drift.delta),
      outstanding_quantity_decimal: microToDecimal(drift.delta),
      open_entries: this.ctx.db.all<LateRow>(
        `SELECT ${LATE_COLUMNS} FROM meter_late_arrivals
         WHERE org_id = ? AND closure_id = ? AND resolution = 'open' ORDER BY created ASC`,
        orgId, id,
      ).map(hydrateLate),
    };
  }

  /**
   * What this billed period is worth now against what it has been billed.
   *
   * Deliberately re-aggregated rather than summed from the late-arrival queue:
   * a late event's own value is the period's movement only when the meter adds
   * its events up. On a `max` meter a late reading below the peak moves nothing,
   * on `last` it moves the total to itself, and on `count` and `unique` it moves
   * it by one whatever the value says. Asking the aggregation is the only answer
   * that is right for all five.
   */
  private outstanding(orgId: string, closure: ClosureRow): { live: bigint; billed: bigint; delta: bigint } {
    const usage = this.usageForPeriod(
      orgId, closure.meter_id, closure.customer_id, closure.period_start, closure.period_end);
    const live = parseMicro(usage.value_decimal, 'value');
    const billed = bigOf(closure.total_micro) + bigOf(closure.settled_adjustment_micro);
    return { live, billed, delta: live - billed };
  }

  /**
   * Price that drift, once, on the price the period was billed against.
   *
   * The amount is marginal in both directions. Within the period it is what the
   * period costs at its new total minus what it has already been billed for, so
   * a graduated price never re-prices the whole period and two successive
   * true-ups sum to exactly one true-up of both. And within the *billing*
   * period it starts from `prior_quantity` — the units earlier windows of the
   * same cycle already climbed — so a period billed in pieces trues up against
   * the tiers it actually reached, not against a ladder that restarted.
   */
  private priceDrift(
    orgId: string, closure: ClosureRow, priceKey: string,
    drift: { live: bigint; billed: bigint; delta: bigint },
  ): {
    amount: number; price: string; currency: string;
    billedQuantity: number; newQuantity: number; priorQuantity: number; unitLabel: string | null;
  } {
    const price = this.ctx.svc.catalog.requirePrice(orgId, priceKey);
    const product = this.ctx.svc.catalog.product(orgId, price.product);
    const meter = this.requireMeter(orgId, closure.meter_id);
    const currency = (closure.currency ?? price.currency).toLowerCase();
    const unitLabel = product?.unit_label ?? meter.unit_label ?? null;
    const prior = bigOf(closure.prior_quantity_micro);
    const priorQuantity = microToWholeUnits(prior);
    // Rounded on the cumulative total and then differenced, exactly as the
    // settlement did, so the window's whole units are the same number here.
    const billedQuantity = microToWholeUnits(prior + drift.billed) - priorQuantity;
    const newQuantity = microToWholeUnits(prior + drift.live) - priorQuantity;
    const cost = (q: number) => this.ctx.svc.catalog.compute(price, priorQuantity + q, currency, { unitLabel }).amount;
    const amount = cost(newQuantity) - cost(billedQuantity);
    if (!Number.isSafeInteger(amount)) {
      throw badRequest(
        'amount_out_of_range',
        `Re-pricing this period at ${newQuantity.toLocaleString('en-US')} ${unitLabel ?? 'unit'}s moves it by more than one invoice line can carry exactly.`,
        'price',
      );
    }
    return { amount, price: price.id, currency, billedQuantity, newQuantity, priorQuantity, unitLabel };
  }

  /**
   * Settle a billed period's drift, in money.
   *
   * `ignored` is the only resolution that records a word. `credited` and
   * `rebilled` re-price the period, hand the difference to whoever registered
   * `onTrueUp`, and write the line it produced back onto the entry — so the
   * answer to "what happened to the $20 we over-billed" is an object, not a
   * string somebody typed.
   *
   * The unit of settlement is the period, not the entry: three late readings on
   * one closed month are one true-up, because that is how much money moved.
   * Resolving any open entry settles the rest alongside it and says which.
   */
  resolveLateArrival(orgId: string, id: string, input: ResolveLateArrivalInput): LateArrival {
    return this.ctx.atomic(() => {
      const row = this.lateRow(orgId, id);
      if (!row) throw notFound('late arrival', id);
      const resolution = input.resolution;
      if (resolution === 'open' || resolution === 'withdrawn') {
        throw badRequest(
          'parameter_invalid',
          '`withdrawn` is written by an adjustment when the event behind the entry is cancelled, and `open` is where an entry starts. Resolve as `credited`, `rebilled` or `ignored`.',
          'resolution',
        );
      }
      if (row.resolution !== 'open') {
        if (row.resolution === resolution) return hydrateLate(row);
        throw conflict(
          'late_arrival_already_resolved',
          `Entry ${id} was resolved as "${row.resolution}"${row.billable_item_id ? ` on line ${row.billable_item_id}` : ''}. A resolution that moved money is not replaced in place — record the correction as its own adjustment.`,
          { resolution: row.resolution, billable_item: row.billable_item_id, amount: row.amount },
        );
      }
      const closure = this.closureById(orgId, row.closure_id);
      if (!closure) throw notFound('period closure', row.closure_id);
      const now = this.ctx.now();

      if (resolution === 'ignored') {
        this.ctx.db.patch('meter_late_arrivals', 'id', id, {
          resolution, resolved_at: now, resolution_ref: null, amount: 0,
          currency: closure.currency, note: input.note ?? null,
        });
        return this.announceResolution(orgId, id, row, {
          amount: 0, currency: closure.currency, item: null, creditAmount: null, also: [],
        });
      }

      const priceKey = input.price ?? closure.price_id;
      if (!priceKey) {
        throw badRequest(
          'parameter_missing',
          `Period closure ${closure.id} was frozen without a price, so there is nothing to re-price this drift against. Pass \`price\`, or resolve the entry as \`ignored\`.`,
          'price',
        );
      }
      const drift = this.outstanding(orgId, closure);
      if (drift.delta === 0n) {
        throw conflict(
          'true_up_already_settled',
          `Period ${closure.period_start}–${closure.period_end} reads ${microToDecimal(drift.live)} today and has been billed for exactly that, so there is nothing to true up. Resolve the entry as \`ignored\`.`,
          { closure: closure.id, live_decimal: microToDecimal(drift.live), billed_decimal: microToDecimal(drift.billed) },
        );
      }
      const priced = this.priceDrift(orgId, closure, priceKey, drift);
      if (resolution === 'credited' && priced.amount > 0) {
        throw badRequest(
          'parameter_invalid',
          `This period is under-billed by ${priced.amount} minor units, not over-billed. Resolve it as \`rebilled\`.`,
          'resolution',
        );
      }
      if (resolution === 'rebilled' && priced.amount < 0) {
        throw badRequest(
          'parameter_invalid',
          `This period is over-billed by ${-priced.amount} minor units, not under-billed. Resolve it as \`credited\`.`,
          'resolution',
        );
      }

      const meter = this.requireMeter(orgId, closure.meter_id);
      const also = this.ctx.db.all<{ id: string }>(
        `SELECT id FROM meter_late_arrivals
         WHERE org_id = ? AND closure_id = ? AND resolution = 'open' AND id <> ? ORDER BY created ASC`,
        orgId, closure.id, id,
      ).map((r) => r.id);

      // A drift the price gives away for free — inside a graduated tier that
      // costs nothing — is still settled, and still says so. There is simply no
      // line to draw, so nothing is handed to the sink.
      let result: TrueUpResult | null = null;
      if (priced.amount !== 0 && this.trueUpSink) {
        const request: TrueUpRequest = {
          late_arrival: id,
          closure: closure.id,
          meter: meter.id,
          meter_name: meter.name,
          customer: closure.customer_id,
          price: priced.price,
          currency: priced.currency,
          period_start: closure.period_start,
          period_end: closure.period_end,
          resolution,
          amount: priced.amount,
          billed_quantity: priced.billedQuantity,
          new_quantity: priced.newQuantity,
          prior_quantity: priced.priorQuantity,
          quantity_decimal: microToDecimal(drift.delta),
          unit_label: priced.unitLabel,
          settlement_ref: closure.ref_type && closure.ref_id
            ? { type: closure.ref_type, id: closure.ref_id }
            : null,
          description: `${meter.name} — true-up for ${new Date(closure.period_start).toISOString().slice(0, 10)} to ${new Date(closure.period_end).toISOString().slice(0, 10)}`,
        };
        result = this.trueUpSink(orgId, request);
      }

      const patch = {
        resolution, resolved_at: now, resolution_ref: result?.item ?? null,
        amount: priced.amount, currency: priced.currency,
        billable_item_id: result?.item ?? null, credit_amount: result?.credit_amount ?? null,
        note: input.note ?? null,
      };
      this.ctx.db.patch('meter_late_arrivals', 'id', id, patch);
      for (const other of also) {
        this.ctx.db.patch('meter_late_arrivals', 'id', other, {
          ...patch, amount: 0, credit_amount: null,
          note: `Settled together with ${id} — a period is trued up once, not once per event.`,
        });
      }
      // The period has now been billed for what it currently reads, so the next
      // true-up prices only what moves after this one.
      this.ctx.db.run(
        `UPDATE meter_period_closures SET settled_adjustment_micro = settled_adjustment_micro + ? WHERE id = ?`,
        drift.delta, closure.id,
      );
      return this.announceResolution(orgId, id, row, {
        amount: priced.amount, currency: priced.currency, item: result?.item ?? null,
        creditAmount: result?.credit_amount ?? null, also,
      });
    });
  }

  private announceResolution(
    orgId: string, id: string, before: LateRow,
    outcome: { amount: number; currency: string | null; item: string | null; creditAmount: number | null; also: string[] },
  ): LateArrival {
    const updated = this.lateArrival(orgId, id);
    if (!updated) throw notFound('late arrival', id);
    this.ctx.emit(orgId, 'meter.late_arrival_resolved', {
      meter: updated.meter, customer: updated.customer, resolution: updated.resolution,
      value: updated.value, value_decimal: updated.value_decimal,
      period_start: updated.period_start, period_end: updated.period_end,
      closure: updated.closure,
      amount: outcome.amount, currency: outcome.currency,
      billable_item: outcome.item, credit_amount: outcome.creditAmount,
      also_resolved: outcome.also,
      note: updated.note,
    }, { objectId: id, objectType: 'meter_late_arrival', previous: { resolution: before.resolution } });
    return updated;
  }

  private lateRow(orgId: string, id: string): LateRow | undefined {
    return this.ctx.db.get<LateRow>(
      `SELECT ${LATE_COLUMNS} FROM meter_late_arrivals WHERE org_id = ? AND id = ?`, orgId, id);
  }

  /* ------------------------------ adjustments ----------------------------- */

  /**
   * Withdraw an event that should never have been recorded.
   *
   * The event row survives, marked `cancelled_at`, so its `identifier` stays
   * claimed and a replay of the original cannot bring it back. What changes is
   * the hourly pre-aggregate: the row is rebuilt from the events that survive,
   * which is the only way `max`, `last` and `unique` can be right afterwards —
   * subtracting the value would leave a peak or a closing reading that no
   * remaining event ever carried.
   *
   * If the event sat inside a period that has already been billed, the billed
   * total is left exactly where it is and the withdrawal is filed as a negative
   * true-up. The invoice keeps saying what it said; the queue says what is owed
   * back. That is the same shape the late-arrival path already has, pointing
   * the other way.
   */
  cancelEvent(orgId: string, input: CancelEventInput): MeterEventAdjustment {
    return this.ctx.atomic(() => {
      const row = this.eventRow(orgId, input.identifier);
      if (!row) throw notFound('meter event', input.identifier);
      const meter = this.requireMeter(orgId, row.meter_id);
      if (input.event_name && input.event_name !== row.event_name) {
        throw badRequest(
          'parameter_invalid',
          `Event "${row.identifier}" was recorded against "${row.event_name}", not "${input.event_name}".`,
          'event_name',
        );
      }

      const already = this.ctx.db.get<AdjustmentRow>(
        `SELECT ${ADJUSTMENT_COLUMNS} FROM meter_event_adjustments WHERE org_id = ? AND event_id = ?`, orgId, row.id);
      // Cancelling twice is the same as cancelling once, so a retried call is a
      // read. Anything else and a network timeout unfolds an hour twice.
      if (already) return hydrateAdjustment(already);

      const now = this.ctx.now();
      const micro = bigOf(row.value_micro);
      const id = newId('usage');
      this.ctx.db.patch('meter_events', 'id', row.id, { cancelled_at: now, adjustment_id: id });
      this.rebuildSummaryHour(orgId, meter, row.customer_id, row.hour_start, now);

      let closureId: string | null = null;
      let lateArrivalId: string | null = null;
      if (row.closure_id) {
        closureId = row.closure_id;
        const filed = this.lateArrivalForEvent(orgId, row.id);
        if (filed && filed.resolution === 'open') {
          // The event was itself a late arrival nobody has billed yet, so
          // withdrawing it takes the whole entry back out of the queue rather
          // than adding a second one.
          this.ctx.db.run(
            `UPDATE meter_period_closures
             SET adjustment_micro = adjustment_micro - ?, late_event_count = MAX(late_event_count - 1, 0) WHERE id = ?`,
            micro, row.closure_id,
          );
          lateArrivalId = filed.id;
          this.ctx.db.patch('meter_late_arrivals', 'id', filed.id, {
            resolution: 'withdrawn', resolved_at: now, resolution_ref: id,
          });
        } else {
          // It has already been trued up and the customer has been billed for
          // it. Unsaying it is a second movement, not the erasure of the first.
          const settled = this.closureById(orgId, row.closure_id);
          if (settled) {
            lateArrivalId = this.fileAgainstClosure(orgId, settled, {
              meterId: meter.id, customer: row.customer_id, eventId: row.id,
              valueMicro: -micro, timestamp: row.timestamp, now,
            }).id;
          }
        }
      } else {
        const closure = this.closureContaining(orgId, meter.id, row.customer_id, row.timestamp);
        if (closure) {
          closureId = closure.id;
          lateArrivalId = this.fileAgainstClosure(orgId, closure, {
            meterId: meter.id, customer: row.customer_id, eventId: row.id,
            valueMicro: -micro, timestamp: row.timestamp, now,
          }).id;
        }
      }

      const adjustment: AdjustmentRow = {
        id, org_id: orgId, meter_id: meter.id, customer_id: row.customer_id, event_id: row.id,
        identifier: row.identifier, type: 'cancel', value_micro: String(-micro), timestamp: row.timestamp,
        closure_id: closureId, late_arrival_id: lateArrivalId, reason: input.reason ?? null, created: now,
      };
      this.ctx.db.insert('meter_event_adjustments', { ...adjustment, value_micro: -micro });

      this.ctx.emit(orgId, 'meter.event_cancelled', {
        meter: meter.id, meter_name: meter.name, customer: row.customer_id, event: row.id,
        identifier: row.identifier, value: microToNumber(-micro), value_decimal: microToDecimal(-micro),
        timestamp: row.timestamp, closure: closureId, late_arrival: lateArrivalId,
        reason: input.reason ?? null,
      }, { objectId: id, objectType: 'meter_event_adjustment' });

      return hydrateAdjustment(adjustment);
    });
  }

  adjustments(orgId: string, filter: { meter?: string; customer?: string; limit?: number } = {}): MeterEventAdjustment[] {
    const clauses = ['org_id = ?'];
    const params: Bindable[] = [orgId];
    if (filter.meter) { clauses.push('meter_id = ?'); params.push(this.requireMeter(orgId, filter.meter).id); }
    if (filter.customer) { clauses.push('customer_id = ?'); params.push(filter.customer); }
    return this.ctx.db.all<AdjustmentRow>(
      `SELECT ${ADJUSTMENT_COLUMNS} FROM meter_event_adjustments WHERE ${clauses.join(' AND ')}
       ORDER BY created DESC LIMIT ?`,
      ...params, Math.min(filter.limit ?? 50, 200),
    ).map(hydrateAdjustment);
  }

  /**
   * Rewrite one hour of the pre-aggregate from the events that survive in it.
   *
   * Only ever called after a withdrawal, so it is off the ingest path and can
   * afford to read the hour: at most a few thousand rows, and it is the only
   * way `max`, `last` and `unique` come out of a cancellation correct.
   */
  private rebuildSummaryHour(orgId: string, meter: Meter, customer: string, hourStart: number, now: number): void {
    const survivors = this.ctx.db.all<{ seq: number; value_micro: string; timestamp: number; unique_key: string | null }>(
      `SELECT rowid AS seq, CAST(value_micro AS TEXT) AS value_micro, timestamp, unique_key FROM meter_events
       WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND hour_start = ? AND cancelled_at IS NULL
       ORDER BY timestamp ASC, rowid ASC`,
      orgId, meter.id, customer, hourStart,
    );

    if (!survivors.length) {
      this.ctx.db.run(
        `DELETE FROM meter_event_summaries WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND hour_start = ?`,
        orgId, meter.id, customer, hourStart);
      this.ctx.db.run(
        `DELETE FROM meter_event_uniques WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND hour_start = ?`,
        orgId, meter.id, customer, hourStart);
      return;
    }

    const live = new Set(survivors.map((s) => s.unique_key).filter((k): k is string => !!k));
    for (const row of this.ctx.db.all<{ unique_key: string }>(
      `SELECT unique_key FROM meter_event_uniques WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND hour_start = ?`,
      orgId, meter.id, customer, hourStart,
    )) {
      if (live.has(row.unique_key)) continue;
      this.ctx.db.run(
        `DELETE FROM meter_event_uniques
         WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND hour_start = ? AND unique_key = ?`,
        orgId, meter.id, customer, hourStart, row.unique_key);
    }

    let sum = 0n;
    let max = 0n;
    for (const s of survivors) { const value = bigOf(s.value_micro); sum += value; if (value > max) max = value; }
    const last = survivors[survivors.length - 1];
    this.ctx.db.run(
      `UPDATE meter_event_summaries
       SET event_count = ?, sum_micro = ?, max_micro = ?, last_micro = ?, last_at = ?, last_rowid = ?,
           unique_count = ?, first_at = ?, updated = ?
       WHERE org_id = ? AND meter_id = ? AND customer_id = ? AND hour_start = ?`,
      survivors.length, sum, max, bigOf(last.value_micro), last.timestamp, last.seq, live.size,
      survivors[0].timestamp, now,
      orgId, meter.id, customer, hourStart,
    );
  }
}

/* -------------------------------- helpers --------------------------------- */

function describeError(e: unknown): NonNullable<BatchItemResult['error']> {
  const err = e as { type?: string; code?: string; message?: string; param?: string };
  return {
    type: err.type ?? 'invalid_request_error',
    code: err.code ?? 'meter_event_rejected',
    message: err.message ?? String(e),
    ...(err.param ? { param: err.param } : {}),
  };
}

function valueFrom(meter: Meter, input: MeterEventInput, payload: Record<string, unknown>): number | string {
  const raw = input.value ?? (meter.value_key ? payload[meter.value_key] : undefined);
  if (raw === undefined || raw === null || raw === '') {
    throw badRequest(
      'meter_event_value_missing',
      `Meter "${meter.name}" reads its value from the payload key "${meter.value_key}", which this event does not carry.`,
      `payload.${meter.value_key}`,
    );
  }
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw badRequest('parameter_invalid', `Meter values are numbers; "${meter.value_key}" carried ${typeof raw}.`, `payload.${meter.value_key}`);
  }
  return raw;
}

function bucketStart(granularity: SummaryGranularity): (hour: number) => number {
  if (granularity === 'hour') return (h) => h;
  if (granularity === 'day') return startOfDay;
  return startOfMonth;
}

function nextBucket(granularity: SummaryGranularity, start: number): number {
  if (granularity === 'hour') return start + HOUR;
  if (granularity === 'day') return start + DAY;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function formatWindow(ms: number): string {
  if (ms >= DAY) return `${Math.round(ms / DAY)}-day`;
  if (ms >= HOUR) return `${Math.round(ms / HOUR)}-hour`;
  return `${Math.round(ms / MINUTE)}-minute`;
}

/* ------------------------------- hydration -------------------------------- */

export const hydrateMeter = (row: MeterRow): Meter => ({
  object: 'meter',
  id: row.id,
  name: row.name,
  event_name: row.event_name,
  aggregation: row.aggregation,
  value_key: row.value_key,
  customer_key: row.customer_key,
  unique_key: row.unique_key,
  unit_label: row.unit_label,
  status: row.status,
  acceptance_window_ms: row.acceptance_window_ms,
  future_tolerance_ms: row.future_tolerance_ms,
  description: row.description,
  metadata: parseJson<Record<string, string>>(row.metadata, {}),
  created: row.created,
  updated: row.updated,
});

export const hydrateEvent = (row: EventRow): MeterEvent => {
  const micro = bigOf(row.value_micro);
  return {
    object: 'meter_event',
    id: row.id,
    meter: row.meter_id,
    event_name: row.event_name,
    identifier: row.identifier,
    customer: row.customer_id,
    value_decimal: microToDecimal(micro),
    value: microToNumber(micro),
    unique_key: row.unique_key,
    timestamp: row.timestamp,
    hour_start: row.hour_start,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    late: !!row.late,
    closure: row.closure_id,
    received_at: row.received_at,
    cancelled_at: row.cancelled_at ?? null,
    cancelled: row.cancelled_at !== null && row.cancelled_at !== undefined,
    adjustment: row.adjustment_id ?? null,
  };
};

export const hydrateAdjustment = (row: AdjustmentRow): MeterEventAdjustment => {
  const micro = bigOf(row.value_micro);
  return {
    object: 'meter_event_adjustment',
    id: row.id,
    type: 'cancel',
    meter: row.meter_id,
    customer: row.customer_id,
    event: row.event_id,
    identifier: row.identifier,
    value: microToNumber(micro),
    value_decimal: microToDecimal(micro),
    timestamp: row.timestamp,
    closure: row.closure_id,
    late_arrival: row.late_arrival_id,
    reason: row.reason,
    created: row.created,
  };
};

export const hydrateClosure = (row: ClosureRow): PeriodClosure => {
  const total = bigOf(row.total_micro);
  const adjustment = bigOf(row.adjustment_micro);
  const settled = bigOf(row.settled_adjustment_micro);
  const prior = bigOf(row.prior_quantity_micro);
  return {
    object: 'meter_period_closure',
    id: row.id,
    meter: row.meter_id,
    customer: row.customer_id,
    period_start: row.period_start,
    period_end: row.period_end,
    aggregation: row.aggregation,
    total: microToNumber(total),
    total_decimal: microToDecimal(total),
    event_count: row.event_count,
    adjustment: microToNumber(adjustment),
    adjustment_decimal: microToDecimal(adjustment),
    settled_adjustment: microToNumber(settled),
    settled_adjustment_decimal: microToDecimal(settled),
    late_event_count: row.late_event_count,
    price: row.price_id ?? null,
    currency: row.currency ?? null,
    prior_quantity: microToNumber(prior),
    prior_quantity_decimal: microToDecimal(prior),
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    closed_at: row.closed_at,
  };
};

export const hydrateLate = (row: LateRow): LateArrival => {
  const micro = bigOf(row.value_micro);
  return {
    object: 'meter_late_arrival',
    id: row.id,
    meter: row.meter_id,
    customer: row.customer_id,
    event: row.event_id,
    closure: row.closure_id,
    value: microToNumber(micro),
    value_decimal: microToDecimal(micro),
    timestamp: row.timestamp,
    period_start: row.period_start,
    period_end: row.period_end,
    resolution: row.resolution,
    resolved_at: row.resolved_at,
    resolution_ref: row.resolution_ref,
    amount: row.amount ?? null,
    currency: row.currency ?? null,
    billable_item: row.billable_item_id ?? null,
    credit_restored: row.credit_amount ?? null,
    note: row.note ?? null,
    created: row.created,
  };
};
