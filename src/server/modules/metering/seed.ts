/**
 * Northwind Robotics' live telemetry stream.
 *
 * Six meters, one per thing the platform actually measures on a factory floor,
 * a month of history for every account that streams into Northwind Cloud, and
 * — because a usage-priced company whose usage stops the moment the clock moves
 * is a demo, not a business — a fleet that keeps streaming. Events arrive as
 * shift roll-ups the way a real gateway batches them: three a day, at 06:00,
 * 14:00 and 22:00 UTC. The history is written up to the last roll-up that has
 * already happened, and a durable job per account ingests the next one at the
 * instant it is due, forever, so `POST /v1/time/advance` replays the fleet
 * exactly as the renewals and dunning it feeds.
 */
import type { Ctx } from '../../kernel/context';
import { DAY, HOUR, startOfDay } from '../../../shared/time';
import { Metering } from './store';
import type { MeterEventInput, MeterInput } from './types';

/** The accounts whose fleets stream into Northwind Cloud, in the CRM's words. */
export interface SeedCustomer {
  id: string;
  company: string;
  domain: string;
  plan: 'starter' | 'growth' | 'scale';
  /** Robots streaming today; drives every meter's magnitude. */
  robots: number;
  operators: number;
  currency: 'usd' | 'eur' | 'gbp';
  /**
   * True when this account resolved to a real invoicing customer. A seed that
   * sells a credit pack to an account nothing can invoice is exactly the bug
   * that leaves a customer holding credit nobody was charged for, so the
   * modules that sell things check this first — and so does the fleet itself:
   * usage is only ever streamed for an account that can be billed for it.
   */
  billable?: boolean;
}

export const METERED_CUSTOMERS: SeedCustomer[] = [
  { id: 'cus_nw_meridianforge', company: 'Meridian Forge Systems', domain: 'meridianforge.com', plan: 'scale', robots: 312, operators: 34, currency: 'usd' },
  { id: 'cus_nw_pemberton', company: 'Pemberton Auto Systems', domain: 'pembertonauto.com', plan: 'scale', robots: 268, operators: 41, currency: 'usd' },
  { id: 'cus_nw_aldergate', company: 'Aldergate Semiconductor', domain: 'aldergatesemi.com', plan: 'scale', robots: 190, operators: 22, currency: 'usd' },
  { id: 'cus_nw_kestrel', company: 'Kestrel Aerospace Components', domain: 'kestrelaero.com', plan: 'growth', robots: 68, operators: 14, currency: 'usd' },
  { id: 'cus_nw_ironwood', company: 'Ironwood Packaging Group', domain: 'ironwoodpackaging.com', plan: 'growth', robots: 54, operators: 11, currency: 'usd' },
  { id: 'cus_nw_rheinwerk', company: 'Rheinwerk Antriebstechnik', domain: 'rheinwerk.de', plan: 'growth', robots: 61, operators: 12, currency: 'eur' },
  { id: 'cus_nw_whitcombe', company: 'Whitcombe Aerospace', domain: 'whitcombe.co.uk', plan: 'growth', robots: 47, operators: 9, currency: 'gbp' },
  { id: 'cus_nw_sableworks', company: 'Sableworks Robotics', domain: 'sableworks.com', plan: 'starter', robots: 9, operators: 3, currency: 'usd' },
];

export const NORTHWIND_METERS: MeterInput[] = [
  {
    id: 'mtr_nw_telemetry',
    name: 'Telemetry events',
    event_name: 'telemetry_events',
    aggregation: 'sum',
    value_key: 'events',
    unit_label: 'event',
    // Gateways buffer locally through a plant shutdown, so this meter accepts a
    // longer backfill than the platform default.
    acceptance_window_ms: 45 * DAY,
    description: 'Every measurement, state change and alarm streamed into Northwind Cloud. Billed monthly on the graduated telemetry price.',
    metadata: { price_lookup_key: 'telemetry_events_monthly', source: 'edge_gateway' },
  },
  {
    id: 'mtr_nw_export',
    name: 'Bulk export volume',
    event_name: 'data_export_gb',
    aggregation: 'sum',
    value_key: 'gigabytes',
    unit_label: 'GB',
    description: 'Parquet written to the customer’s own warehouse by a scheduled export. Billed in 10 GB packages.',
    metadata: { price_lookup_key: 'data_export_monthly', source: 'export_worker' },
  },
  {
    id: 'mtr_nw_robots',
    name: 'Peak connected robots',
    event_name: 'connected_robots',
    aggregation: 'max',
    value_key: 'robots',
    unit_label: 'robot',
    description: 'The high-water mark of robots streaming at once. A fleet that peaks above its plan ceiling is a Scale conversation.',
    metadata: { source: 'fleet_supervisor' },
  },
  {
    id: 'mtr_nw_storage',
    name: 'Stored telemetry',
    event_name: 'stored_telemetry_gb',
    aggregation: 'last',
    value_key: 'gigabytes',
    unit_label: 'GB',
    description: 'Retained history measured nightly. The closing reading of the period is what retention is charged on, not the sum of the readings.',
    metadata: { source: 'retention_sweeper' },
  },
  {
    id: 'mtr_nw_operators',
    name: 'Active operator seats',
    event_name: 'operator_session',
    aggregation: 'unique',
    unique_key: 'operator_id',
    unit_label: 'seat',
    description: 'Distinct operators who opened the console during the period. Seats are billed on who actually worked, not on who was provisioned.',
    metadata: { source: 'console' },
  },
  {
    id: 'mtr_nw_alerts',
    name: 'Anomaly alerts raised',
    event_name: 'anomaly_alert',
    aggregation: 'count',
    unit_label: 'alert',
    description: 'One per alert the anomaly engine raised. Counted rather than summed, so a noisy sensor cannot inflate the number.',
    metadata: { source: 'anomaly_engine' },
  },
];

/**
 * The hours (UTC) the gateways ship their roll-ups. Every event a fleet-day
 * produces is timestamped inside one of the three windows these open — a
 * reading after the last one would belong to a roll-up nobody sends.
 */
export const SHIFTS = [6, 14, 22] as const;
const HISTORY_DAYS = 32;
/** Telemetry volume doubles over the fleet's first four months, then holds. */
const RAMP_DAYS = HISTORY_DAYS * 4;

/** Which of Kestrel's export Sundays the worker was restarted mid-run on. */
const DOUBLE_RUN_SUNDAY = 2;
export const DOUBLE_RUN_IDENTIFIER = 'nw_exp_kestrel_double_run';

/** The job type that ingests one account's next shift roll-up. */
export const FLEET_JOB = 'metering.fleet_shift';
export const fleetJobKey = (customerId: string): string => `metering.fleet:${customerId}`;

/**
 * What one fleet job carries: the account (as the roster describes it, so the
 * magnitudes do not depend on the billing record being readable at run time),
 * where the shift it is about to ingest sits, and the one reading that has to
 * be carried from day to day because it is cumulative.
 */
export interface FleetShiftJob {
  customer: Pick<SeedCustomer, 'id' | 'company' | 'domain' | 'plan' | 'robots' | 'operators'>;
  /** Midnight (UTC) of the day the fleet came online; the ramp and identifiers count from here. */
  first_day: number;
  /** Days since `first_day` of the shift about to be ingested. */
  day: number;
  /** Index into `SHIFTS`. */
  shift: number;
  /** Retained telemetry, in GB, at the close of the day before `day`. */
  stored_gb: number;
}

/** Deterministic noise, so the demo workspace looks the same on every boot. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * One RNG per account per calendar day, seeded from both. The history loop
 * and the live job never share a stream, so they have to agree on a day's
 * numbers from its date alone — and a job that retries draws the same day.
 */
function fleetDayRandom(customerId: string, midnight: number): () => number {
  let hash = (0x4e57_c0de ^ Math.floor(midnight / DAY)) >>> 0;
  for (const ch of customerId) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x0100_0193) >>> 0;
  return rng(hash);
}

/**
 * The same accounts the rest of the workspace knows.
 *
 * Billing seeds its customers before metering runs, so when a customer record
 * already exists for one of these companies we meter against that id and that
 * currency. The demo then tells one story: the company on the CRM record, the
 * customer on the invoice and the fleet streaming telemetry are the same thing.
 * An entry that resolves to nothing keeps its roster id so the other seeds can
 * still name it, but it is marked unbillable, and nothing streams for it.
 */
export function resolveMeteredCustomers(ctx: Ctx, orgId: string): SeedCustomer[] {
  const hasCustomers = ctx.db.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'billing_customers'`);
  return METERED_CUSTOMERS.map((customer) => {
    const row = hasCustomers
      ? ctx.db.get<{ id: string; currency: string }>(
        `SELECT id, currency FROM billing_customers WHERE org_id = ? AND name = ? LIMIT 1`, orgId, customer.company)
      : undefined;
    return row
      ? { ...customer, id: row.id, currency: row.currency as SeedCustomer['currency'], billable: true }
      : { ...customer, billable: false };
  });
}

/**
 * The identifier one shift roll-up was written under, so another module can
 * name a specific reading in the seeded history rather than guessing at one.
 */
export const telemetryShift = (customerId: string, day: number, shift: number): string =>
  `nw_tel_${customerId}_${day}_${shift}`;

export interface FleetDay {
  midnight: number;
  weekend: boolean;
  robots: number;
  /** Retained telemetry at the close of this day, carried into the next. */
  stored_gb: number;
  /** Every event the fleet sends this day, each inside one shift window. */
  events: MeterEventInput[];
}

/**
 * Everything one account's fleet sends in one calendar day.
 *
 * Pure: the same account, day and opening reading always produce the same
 * events with the same identifiers, which is what lets the history and the
 * live stream be written by different code at different times and still tile
 * into one continuous month. Weekends run at a fraction of weekday load, the
 * fleet ramps for its first four months, and every timestamp lands at or
 * before the day's last roll-up.
 */
export function fleetDay(customer: FleetShiftJob['customer'], day: number, midnight: number, storedBefore: number): FleetDay {
  const random = fleetDayRandom(customer.id, midnight);
  const weekday = new Date(midnight).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  // Events per robot per day, with weekend downtime and a slow ramp.
  const perRobot = customer.plan === 'scale' ? 4_200 : customer.plan === 'growth' ? 3_100 : 1_900;
  const load = (weekend ? 0.28 : 1) * (0.88 + random() * 0.24) * (1 + Math.min(day, RAMP_DAYS) / RAMP_DAYS);
  const robotsToday = Math.max(1, Math.round(customer.robots * (weekend ? 0.55 : 0.94 + random() * 0.08)));
  const events: MeterEventInput[] = [];

  // Telemetry arrives as three shift roll-ups, the way the gateway batches.
  SHIFTS.forEach((hour, shift) => {
    events.push({
      event_name: 'telemetry_events',
      identifier: telemetryShift(customer.id, day, shift),
      timestamp: midnight + hour * HOUR,
      payload: { customer_id: customer.id, events: Math.round((robotsToday * perRobot * load) / 3), shift: `${hour}:00`, site: customer.domain },
    });
  });

  events.push({
    event_name: 'connected_robots',
    identifier: `nw_bots_${customer.id}_${day}`,
    timestamp: midnight + 11 * HOUR,
    payload: { customer_id: customer.id, robots: robotsToday },
  });

  const storedGb = Math.round((storedBefore + robotsToday * 0.11 * (weekend ? 0.4 : 1)) * 100) / 100;
  events.push({
    event_name: 'stored_telemetry_gb',
    identifier: `nw_store_${customer.id}_${day}`,
    timestamp: midnight + 2 * HOUR,
    payload: { customer_id: customer.id, gigabytes: storedGb },
  });

  if (!weekend) {
    const signedIn = Math.min(8, Math.max(1, Math.round(customer.operators * (0.35 + random() * 0.25))));
    for (let i = 0; i < signedIn; i++) {
      events.push({
        event_name: 'operator_session',
        identifier: `nw_op_${customer.id}_${day}_${i}`,
        timestamp: midnight + (7 + (i % 10)) * HOUR,
        payload: { customer_id: customer.id, operator_id: `op_${customer.id.slice(7)}_${(i % customer.operators) + 1}` },
      });
    }
  }

  const alerts = Math.round(robotsToday * (weekend ? 0.004 : 0.012) * (0.5 + random()));
  for (let i = 0; i < alerts; i++) {
    events.push({
      event_name: 'anomaly_alert',
      identifier: `nw_alert_${customer.id}_${day}_${i}`,
      timestamp: midnight + (4 + ((i * 5) % 19)) * HOUR,
      payload: { customer_id: customer.id, severity: i % 4 === 0 ? 'critical' : 'warning', robot: `rbt_${(i % robotsToday) + 1}` },
    });
  }

  // Warehouse exports run on Sunday evenings for the accounts that buy them.
  if (weekday === 0 && customer.plan !== 'starter') {
    events.push({
      event_name: 'data_export_gb',
      identifier: `nw_exp_${customer.id}_${day}`,
      timestamp: midnight + 20 * HOUR,
      payload: { customer_id: customer.id, gigabytes: Math.round(robotsToday * 0.42 * 100) / 100, destination: 's3' },
    });
  }

  return { midnight, weekend, robots: robotsToday, stored_gb: storedGb, events };
}

/** The instant a shift's roll-up is shipped. */
export const shiftAt = (firstDay: number, day: number, shift: number): number =>
  firstDay + day * DAY + SHIFTS[shift] * HOUR;

/**
 * The window one shift's roll-up covers: everything since the previous
 * roll-up, up to and including this one. The three windows tile the day, and
 * the one that opens at 22:00 the night before is empty until 02:00 because
 * nothing on the floor reports between the last roll-up and the nightly sweep.
 */
export function shiftWindow(firstDay: number, day: number, shift: number): { from: number; to: number } {
  const to = shiftAt(firstDay, day, shift);
  const from = shift === 0 ? shiftAt(firstDay, day - 1, SHIFTS.length - 1) : shiftAt(firstDay, day, shift - 1);
  return { from, to };
}

/** The shift after this one, on the next day when the day is over. */
export const nextShift = (day: number, shift: number): { day: number; shift: number } =>
  shift + 1 < SHIFTS.length ? { day, shift: shift + 1 } : { day: day + 1, shift: 0 };

/** Every event of a fleet-day that falls inside a shift's window. */
export const eventsInWindow = (day: FleetDay, window: { from: number; to: number }): MeterEventInput[] =>
  day.events.filter((e) => e.timestamp !== undefined && e.timestamp > window.from && e.timestamp <= window.to);

export function seedMetering(ctx: Ctx, orgId: string): void {
  const metering = new Metering(ctx);
  for (const meter of NORTHWIND_METERS) metering.createMeter(orgId, meter);

  const now = ctx.now();
  const firstDay = startOfDay(now) - (HISTORY_DAYS - 1) * DAY;
  const roster = resolveMeteredCustomers(ctx, orgId);

  // The one-story rule, enforced where it would otherwise be broken: an
  // account nothing can invoice does not stream. Streaming for it anyway would
  // put an id on every usage screen that no customer page can open.
  const unresolved = roster.filter((c) => !c.billable);
  if (unresolved.length) {
    ctx.log.warn('metering.seed.unresolved_accounts', {
      org: orgId,
      companies: unresolved.map((c) => c.company),
      reason: 'no billing customer with that name; the fleet is not seeded for an account that cannot be invoiced',
    });
  }
  const fleet = roster.filter((c) => c.billable);
  const kestrel = fleet.find((c) => c.company === 'Kestrel Aerospace Components');

  // History runs up to the last roll-up that has already shipped; the next one
  // is the live job's. Between the two there is nothing to ingest — a gateway
  // that batches at 14:00 has sent nothing at 09:17 either.
  const next = firstShiftAfter(firstDay, now);
  const cutoff = shiftWindow(firstDay, next.day, next.shift).from;

  const events: MeterEventInput[] = [];
  for (const customer of fleet) {
    let stored = customer.robots * 1.4;
    let exportRuns = 0;
    let openingReading = stored;

    for (let day = 0; day < HISTORY_DAYS; day++) {
      if (day === next.day) openingReading = stored;
      const fleetToday = fleetDay(customer, day, firstDay + day * DAY, stored);
      stored = fleetToday.stored_gb;
      for (const event of fleetToday.events) {
        if (event.timestamp === undefined || event.timestamp > cutoff) continue;
        events.push(event);
        // One Sunday the export worker was restarted mid-run and shipped the
        // same parquet twice. The duplicate is withdrawn below rather than
        // deleted, which is the whole point of an adjustment.
        if (event.event_name === 'data_export_gb' && customer.id === kestrel?.id && ++exportRuns === DOUBLE_RUN_SUNDAY) {
          events.push({
            ...event,
            identifier: DOUBLE_RUN_IDENTIFIER,
            timestamp: event.timestamp + 11 * 60_000,
            payload: { ...event.payload, worker: 'export-7 (restarted)' },
          });
        }
      }
    }
    if (next.day >= HISTORY_DAYS) openingReading = stored;

    // The fleet keeps streaming from here: one durable job per account, aimed
    // at the next roll-up, that re-enqueues itself after each one. No timer
    // anywhere, so the time machine replays it through the jobs table.
    const job: FleetShiftJob = {
      customer: { id: customer.id, company: customer.company, domain: customer.domain, plan: customer.plan, robots: customer.robots, operators: customer.operators },
      first_day: firstDay,
      day: next.day,
      shift: next.shift,
      stored_gb: openingReading,
    };
    ctx.enqueue(orgId, FLEET_JOB, job, { runAt: shiftAt(firstDay, next.day, next.shift), idemKey: fleetJobKey(customer.id) });
  }

  for (let i = 0; i < events.length; i += 500) {
    const batch = metering.ingestBatch(orgId, events.slice(i, i + 500));
    // A seed that silently drops half its history is worse than no seed at all.
    const failed = batch.results.find((r) => r.error);
    if (failed) throw new Error(`Seeding meter events failed on ${failed.identifier}: ${failed.error?.message}`);
  }

  if (metering.event(orgId, DOUBLE_RUN_IDENTIFIER)) {
    metering.cancelEvent(orgId, {
      identifier: DOUBLE_RUN_IDENTIFIER,
      event_name: 'data_export_gb',
      reason: 'export-7 was restarted mid-run and shipped the same parquet twice',
    });
  }
}

/**
 * Pick a stopped fleet back up where its record ends.
 *
 * The day index continues from the first roll-up the account ever shipped, so
 * the identifiers of the resumed readings can never collide with readings
 * already on record, and retention carries on from the last nightly sweep —
 * nothing accrued while the gateway was off. Null for an account that never
 * streamed: the seed is the only thing that starts a fleet.
 */
export function resumeFleetJob(ctx: Ctx, orgId: string, account: SeedCustomer, now: number): FleetShiftJob | null {
  const first = ctx.db.pluck<number>(
    `SELECT MIN(timestamp) FROM meter_events WHERE org_id = ? AND customer_id = ? AND event_name = 'telemetry_events'`,
    orgId, account.id);
  if (!first) return null;
  const firstDay = startOfDay(first);
  const lastSweep = ctx.db.pluck<string>(
    `SELECT payload FROM meter_events WHERE org_id = ? AND customer_id = ? AND event_name = 'stored_telemetry_gb' AND cancelled_at IS NULL
     ORDER BY timestamp DESC LIMIT 1`,
    orgId, account.id);
  const reading = lastSweep ? Number((JSON.parse(lastSweep) as { gigabytes?: unknown }).gigabytes) : NaN;
  const next = firstShiftAfter(firstDay, now);
  return {
    customer: { id: account.id, company: account.company, domain: account.domain, plan: account.plan, robots: account.robots, operators: account.operators },
    first_day: firstDay,
    day: next.day,
    shift: next.shift,
    stored_gb: Number.isFinite(reading) ? reading : account.robots * 1.4,
  };
}

/** The first roll-up strictly after `now`, as a (day, shift) pair from `firstDay`. */
function firstShiftAfter(firstDay: number, now: number): { day: number; shift: number } {
  const day = Math.floor((now - firstDay) / DAY);
  const shift = SHIFTS.findIndex((hour) => firstDay + day * DAY + hour * HOUR > now);
  return shift === -1 ? { day: day + 1, shift: 0 } : { day, shift };
}
