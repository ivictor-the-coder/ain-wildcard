import type { Ctx } from '../../kernel/context';
import { DAY, addInterval, interval, periodFor, startOfDay, startOfMonth } from '../../../shared/time';
import type { AllowanceInterval, Feature } from './types';

export interface Window { start: number; end: number }

export interface LiveUsage {
  meter: string;
  meter_name: string;
  unit_label: string | null;
  /** Whole units consumed in the window, as the meter aggregates them. */
  used: number;
  /** Prepaid credit in the same units, currently extending the allowance. */
  credit_units: number;
}

/**
 * Live consumption, read from the meter and the credit ledger — never stored.
 *
 * A metered entitlement that keeps its own counter is a counter that will
 * eventually disagree with the events it counts, and the moment it does, the
 * customer is either being blocked while under their limit or let through over
 * it. So every answer here comes from `metering` and `credits`.
 *
 * That leaves speed, which a hot path does care about. The memo below is not a
 * cache of *totals* with a timeout — it is invalidated by the events that can
 * possibly change a total (`meter.*` for usage, `credit*.*` for credit), which
 * the kernel dispatches inside the very transaction that writes them. An event
 * ingested a millisecond ago has already invalidated the entry that would have
 * hidden it.
 */
/**
 * Shared across every reader in the process, for the same reason the config
 * generations are: an ingest through one app's store must not leave another's
 * memo holding a total that no longer exists. Over-invalidating costs a query;
 * under-invalidating costs a customer.
 */
let USAGE_EPOCH = 0;
let CREDIT_EPOCH = 0;

export class UsageReader {
  private readonly usageMemo = new Map<string, { epoch: number; used: number }>();
  private readonly creditMemo = new Map<string, { epoch: number; units: number }>();
  private readonly meterMemo = new Map<string, { id: string; name: string; unit_label: string | null } | null>();

  /** Memos are per-process working sets, not a store; they are bounded. */
  private static readonly MAX_ENTRIES = 4096;

  constructor(private readonly ctx: Ctx) {}

  invalidateUsage(): void { USAGE_EPOCH++; }
  invalidateCredit(): void { CREDIT_EPOCH++; }
  invalidateMeters(): void { this.meterMemo.clear(); }

  /**
   * The window a feature's consumption is measured over.
   *
   * `billing_period` uses the cycle copied onto the entitlement row when the
   * granting subscription last moved, so a metered check never has to ask
   * billing where it is in the cycle. When there is no subscription behind the
   * grant — a support override, a feature default — a calendar month is the
   * only cycle that means anything.
   *
   * The cycle is then cut into `allowance_interval` windows from its own start.
   * A plan that includes five million events a month includes five million a
   * month on its annual term too: twelve consecutive windows, each anchored on
   * the day the subscription bills, rather than one yearly window handing an
   * annual customer a twelfth of what the plan advertises.
   */
  windowFor(feature: Pick<Feature, 'usage_window' | 'allowance_interval'>, period: Window | null, now: number): Window {
    switch (feature.usage_window) {
      case 'billing_period': {
        const cycle = period && period.end > period.start && now >= period.start ? period : calendarMonth(now);
        return feature.allowance_interval ? sliceOf(cycle, feature.allowance_interval, now) : cycle;
      }
      case 'calendar_month':
        return calendarMonth(now);
      case 'day': {
        const start = startOfDay(now);
        return { start, end: start + DAY };
      }
      case 'lifetime':
        return { start: 0, end: now + 1 };
    }
  }

  /** The meter behind a feature, resolved by id or by the event name it listens for. */
  meterFor(orgId: string, feature: Feature): { id: string; name: string; unit_label: string | null } | null {
    if (!feature.meter) return null;
    const key = `${orgId}:${feature.meter}`;
    if (this.meterMemo.has(key)) return this.meterMemo.get(key) ?? null;
    const found = this.ctx.svc.metering.meter(orgId, feature.meter);
    const entry = found ? { id: found.id, name: found.name, unit_label: found.unit_label } : null;
    if (this.meterMemo.size > UsageReader.MAX_ENTRIES) this.meterMemo.clear();
    this.meterMemo.set(key, entry);
    return entry;
  }

  /** Whole units consumed in `win`, exactly as the meter aggregates them. */
  used(orgId: string, meterId: string, customerId: string, win: Window): number {
    const key = `${orgId}:${meterId}:${customerId}:${win.start}:${win.end}`;
    const hit = this.usageMemo.get(key);
    if (hit && hit.epoch === USAGE_EPOCH) return hit.used;
    const usage = this.ctx.svc.metering.usageForPeriod(orgId, meterId, customerId, win.start, win.end);
    if (this.usageMemo.size > UsageReader.MAX_ENTRIES) this.usageMemo.clear();
    this.usageMemo.set(key, { epoch: USAGE_EPOCH, used: usage.billable_quantity });
    return usage.billable_quantity;
  }

  /**
   * Prepaid credit denominated in this meter's units. A pack bought to cover a
   * burst month raises the allowance it was bought for, which is the only
   * reading under which "you have 2,000,000 events left" is true for a customer
   * who has spent their included allowance and holds two credit packs.
   */
  creditUnits(orgId: string, meterId: string, customerId: string): number {
    const key = `${orgId}:${meterId}:${customerId}`;
    const hit = this.creditMemo.get(key);
    if (hit && hit.epoch === CREDIT_EPOCH) return hit.units;
    let units = 0;
    for (const bucket of this.ctx.svc.credits.balance(orgId, customerId).balances) {
      if (bucket.kind !== 'unit' || bucket.meter !== meterId) continue;
      if (bucket.available > 0) units += bucket.available;
    }
    const whole = Math.floor(units);
    if (this.creditMemo.size > UsageReader.MAX_ENTRIES) this.creditMemo.clear();
    this.creditMemo.set(key, { epoch: CREDIT_EPOCH, units: whole });
    return whole;
  }

  /** Everything a metered or meter-backed limit needs, in one call. */
  read(orgId: string, feature: Feature, customerId: string, win: Window): LiveUsage | null {
    const meter = this.meterFor(orgId, feature);
    if (!meter) return null;
    return {
      meter: meter.id,
      meter_name: meter.name,
      unit_label: feature.unit_label ?? meter.unit_label,
      used: this.used(orgId, meter.id, customerId, win),
      credit_units: feature.credit_backed ? this.creditUnits(orgId, meter.id, customerId) : 0,
    };
  }
}

function calendarMonth(now: number): Window {
  const start = startOfMonth(now);
  return { start, end: addInterval(start, interval('month', 1), 1) };
}

/**
 * The allowance window inside a billing cycle that contains `now`.
 *
 * Anchored on the cycle's own start and stepped with the same anchor-day rules
 * the cycle itself follows, so a term that begins on 31 January refills on the
 * 28th, the 31st, the 30th, the 31st — and the last window of the term is cut
 * short at the renewal rather than reaching past it. An interval longer than
 * the cycle leaves the cycle whole: a plan can never include less per period
 * than it says it does.
 */
function sliceOf(cycle: Window, unit: AllowanceInterval, now: number): Window {
  const anchorDay = new Date(cycle.start).getUTCDate();
  const at = Math.min(Math.max(now, cycle.start), cycle.end - 1);
  const slice = periodFor(cycle.start, interval(unit, 1), at, anchorDay);
  return { start: Math.max(slice.start, cycle.start), end: Math.min(slice.end, cycle.end) };
}
