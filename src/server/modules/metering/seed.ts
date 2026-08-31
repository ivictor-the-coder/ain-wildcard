/**
 * Northwind Robotics' live telemetry stream.
 *
 * Six meters, one per thing the platform actually measures on a factory floor,
 * and a month of history for the eight accounts that stream into
 * Northwind Cloud. Events arrive as nightly roll-ups the way a real gateway
 * batches them, so the seeded workspace has a believable ingestion history, not
 * a table of round numbers.
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
   * modules that sell things check this first.
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

const SHIFTS = [6, 14, 22];
const HISTORY_DAYS = 32;

/** Which of Kestrel's export Sundays the worker was restarted mid-run on. */
const DOUBLE_RUN_SUNDAY = 2;
export const DOUBLE_RUN_IDENTIFIER = 'nw_exp_kestrel_double_run';

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
 * The same accounts the rest of the workspace knows.
 *
 * Billing seeds its customers before metering runs, so when a customer record
 * already exists for one of these companies we meter against that id and that
 * currency. The demo then tells one story: the company on the CRM record, the
 * customer on the invoice and the fleet streaming telemetry are the same thing.
 */
export function resolveMeteredCustomers(ctx: Ctx, orgId: string): SeedCustomer[] {
  const hasCustomers = ctx.db.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'billing_customers'`);
  if (!hasCustomers) return METERED_CUSTOMERS;
  return METERED_CUSTOMERS.map((customer) => {
    const row = ctx.db.get<{ id: string; currency: string }>(
      `SELECT id, currency FROM billing_customers WHERE org_id = ? AND name = ? LIMIT 1`, orgId, customer.company);
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

export function seedMetering(ctx: Ctx, orgId: string): void {
  const metering = new Metering(ctx);
  for (const meter of NORTHWIND_METERS) metering.createMeter(orgId, meter);

  const now = ctx.now();
  const firstDay = startOfDay(now) - (HISTORY_DAYS - 1) * DAY;
  const random = rng(0x4e57_c0de);
  const events: MeterEventInput[] = [];
  const roster = resolveMeteredCustomers(ctx, orgId);
  const kestrel = roster.find((c) => c.company === 'Kestrel Aerospace Components');

  for (const customer of roster) {
    // Events per robot per day, with weekend downtime and a slow ramp.
    const perRobot = customer.plan === 'scale' ? 4_200 : customer.plan === 'growth' ? 3_100 : 1_900;
    let storedGb = customer.robots * 1.4;
    let exportRuns = 0;

    for (let day = 0; day < HISTORY_DAYS; day++) {
      const midnight = firstDay + day * DAY;
      const weekday = new Date(midnight).getUTCDay();
      const weekend = weekday === 0 || weekday === 6;
      const load = (weekend ? 0.28 : 1) * (0.88 + random() * 0.24) * (1 + day / (HISTORY_DAYS * 4));
      const robotsToday = Math.max(1, Math.round(customer.robots * (weekend ? 0.55 : 0.94 + random() * 0.08)));

      // Telemetry arrives as three shift roll-ups, the way the gateway batches.
      SHIFTS.forEach((hour, shift) => {
        const at = midnight + hour * HOUR;
        if (at > now) return;
        const count = Math.round((robotsToday * perRobot * load) / 3);
        events.push({
          event_name: 'telemetry_events',
          identifier: `nw_tel_${customer.id}_${day}_${shift}`,
          timestamp: at,
          payload: { customer_id: customer.id, events: count, shift: `${hour}:00`, site: customer.domain },
        });
      });

      const peakAt = midnight + 11 * HOUR;
      if (peakAt <= now) {
        events.push({
          event_name: 'connected_robots',
          identifier: `nw_bots_${customer.id}_${day}`,
          timestamp: peakAt,
          payload: { customer_id: customer.id, robots: robotsToday },
        });
      }

      const nightlyAt = midnight + 2 * HOUR;
      storedGb = Math.round((storedGb + robotsToday * 0.11 * (weekend ? 0.4 : 1)) * 100) / 100;
      if (nightlyAt <= now) {
        events.push({
          event_name: 'stored_telemetry_gb',
          identifier: `nw_store_${customer.id}_${day}`,
          timestamp: nightlyAt,
          payload: { customer_id: customer.id, gigabytes: storedGb },
        });
      }

      if (!weekend) {
        const signedIn = Math.min(8, Math.max(1, Math.round(customer.operators * (0.35 + random() * 0.25))));
        for (let i = 0; i < signedIn; i++) {
          const at = midnight + (7 + (i % 10)) * HOUR;
          if (at > now) continue;
          events.push({
            event_name: 'operator_session',
            identifier: `nw_op_${customer.id}_${day}_${i}`,
            timestamp: at,
            payload: { customer_id: customer.id, operator_id: `op_${customer.id.slice(7)}_${(i % customer.operators) + 1}` },
          });
        }
      }

      const alerts = Math.round(robotsToday * (weekend ? 0.004 : 0.012) * (0.5 + random()));
      for (let i = 0; i < alerts; i++) {
        const at = midnight + (4 + ((i * 5) % 19)) * HOUR;
        if (at > now) continue;
        events.push({
          event_name: 'anomaly_alert',
          identifier: `nw_alert_${customer.id}_${day}_${i}`,
          timestamp: at,
          payload: { customer_id: customer.id, severity: i % 4 === 0 ? 'critical' : 'warning', robot: `rbt_${(i % robotsToday) + 1}` },
        });
      }

      // Warehouse exports run on Sunday nights for the accounts that buy them.
      if (weekday === 0 && customer.plan !== 'starter') {
        const at = midnight + 23 * HOUR;
        if (at <= now) {
          const gigabytes = Math.round(robotsToday * 0.42 * 100) / 100;
          events.push({
            event_name: 'data_export_gb',
            identifier: `nw_exp_${customer.id}_${day}`,
            timestamp: at,
            payload: { customer_id: customer.id, gigabytes, destination: 's3' },
          });
          // One Sunday the export worker was restarted mid-run and shipped the
          // same parquet twice. The duplicate is withdrawn below rather than
          // deleted, which is the whole point of an adjustment.
          exportRuns++;
          if (customer.id === kestrel?.id && exportRuns === DOUBLE_RUN_SUNDAY) {
            events.push({
              event_name: 'data_export_gb',
              identifier: DOUBLE_RUN_IDENTIFIER,
              timestamp: at + 11 * 60_000,
              payload: { customer_id: customer.id, gigabytes, destination: 's3', worker: 'export-7 (restarted)' },
            });
          }
        }
      }
    }
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
