/**
 * Deferred revenue and the recognition schedule behind it.
 *
 * An invoice line is cash the moment it is raised and revenue only as the
 * service is delivered, so every line that names a period is spread across the
 * days of that period. The split uses `allocate()`, which distributes the
 * remainder pennies deterministically and guarantees the days sum back to the
 * line to the cent — a schedule whose days do not add up to the invoice is
 * worse than no schedule at all.
 *
 * Two balances come out of it, and they are different numbers:
 *
 *  - **deferred** is billed-but-not-yet-earned: the invoice went out on the 1st
 *    for a month that has barely started.
 *  - **unbilled** is earned-but-not-yet-billed: metered usage settles in
 *    arrears, so the service was delivered in March and the bill is raised in
 *    April.
 *
 * `invoiced = recognised + deferred` holds at every instant, by construction
 * and by an explicit check on the way out.
 */
import { DAY, dayKey } from '../../../shared/time';
import { allocate, money } from '../../../shared/money';
import type { MonthCell } from './grid';

/** A day of service and the money earned on it. */
export interface RecognitionDay {
  day: string;
  start: number;
  /** Exclusive. Shorter than a day for the last slice of a period. */
  end: number;
  amount: number;
  recognised: boolean;
}

export interface RecognitionLine {
  invoice: string;
  invoice_number: string;
  invoice_status: string;
  line: string;
  customer: string;
  subscription: string | null;
  kind: string;
  description: string;
  currency: string;
  amount: number;
  /** When this line became billed — the invoice's finalisation instant. */
  invoiced_at: number;
  period: { start: number; end: number };
  days: number;
  recognised_to_date: number;
  deferred: number;
  unbilled: number;
  schedule?: RecognitionDay[];
}

/** More days than any real billing period; a guard, not a policy. */
const MAX_DAYS = 1_100;

interface Bucket { start: number; end: number }

function bucketsFor(start: number, end: number): Bucket[] {
  if (end <= start) return [{ start, end: start }];
  const span = end - start;
  const count = Math.min(MAX_DAYS, Math.ceil(span / DAY));
  const buckets: Bucket[] = [];
  for (let i = 0; i < count; i++) {
    const from = start + i * DAY;
    const to = i === count - 1 ? end : Math.min(start + (i + 1) * DAY, end);
    buckets.push({ start: from, end: to });
  }
  return buckets;
}

/**
 * One line's daily schedule. Weights are whole seconds of service so a period
 * that does not divide into whole days still splits exactly, and the amounts
 * are guaranteed by `allocate()` to sum back to the line.
 */
export function scheduleFor(amount: number, currency: string, start: number, end: number, asOf: number): RecognitionDay[] {
  const buckets = bucketsFor(start, end);
  const weights = buckets.map((bucket) => Math.max(1, Math.round((bucket.end - bucket.start) / 1000)));
  const shares = allocate(money(amount, currency), weights);
  return buckets.map((bucket, i) => ({
    day: dayKey(bucket.start),
    start: bucket.start,
    end: bucket.end,
    amount: shares[i].amount,
    recognised: bucket.end <= asOf,
  }));
}

export interface RecognitionRow {
  month: string;
  period: { start: number; end: number };
  complete: boolean;
  currency: string;
  invoiced: number;
  recognised: number;
  /** Cumulative invoiced at the close of this month. */
  invoiced_to_date: number;
  /** Cumulative recognised at the close of this month. */
  recognised_to_date: number;
  /**
   * `invoiced_to_date - recognised_to_date` at the close of this month. Net, so
   * it goes negative in a month where more was earned than billed; the gross
   * earned-but-unbilled part is `unbilled_balance`.
   */
  deferred_balance: number;
  /** Earned but not yet billed, at the close of this month, gross. */
  unbilled_balance: number;
}

export interface RecognitionReport {
  rows: RecognitionRow[];
  totals: {
    lines: number;
    invoiced: number;
    recognised: number;
    deferred_balance: number;
    unbilled_balance: number;
    currency: string;
  };
  reconciliation: {
    invoiced: number;
    recognised: number;
    deferred: number;
    difference: number;
    balanced: boolean;
    note: string | null;
  };
}

/**
 * Sweep every line across the month grid once, carrying a pointer into its own
 * daily schedule. Nothing is recomputed per month, so a year of invoices costs
 * one pass over the days plus one pass over the months.
 */
export function recognise(lines: RecognitionLine[], cells: MonthCell[], asOf: number, currency: string): RecognitionReport {
  const size = cells.length;
  const invoicedInMonth = new Array<number>(size).fill(0);
  const recognisedInMonth = new Array<number>(size).fill(0);
  const recognisedToDate = new Array<number>(size).fill(0);
  const invoicedToDate = new Array<number>(size).fill(0);
  const deferredEnd = new Array<number>(size).fill(0);
  const unbilledEnd = new Array<number>(size).fill(0);

  let totalInvoiced = 0, totalRecognised = 0, totalDeferred = 0, totalUnbilled = 0;

  for (const line of lines) {
    const days = scheduleFor(line.amount, line.currency, line.period.start, line.period.end, asOf);
    let cursor = 0, cumulative = 0;

    if (size) {
      const opening = cells[0].opens_at;
      while (cursor < days.length && days[cursor].end <= opening) { cumulative += days[cursor].amount; cursor += 1; }
      let previous = cumulative;
      for (let i = 0; i < size; i++) {
        const at = cells[i].at;
        while (cursor < days.length && days[cursor].end <= at) { cumulative += days[cursor].amount; cursor += 1; }
        recognisedInMonth[i] += cumulative - previous;
        recognisedToDate[i] += cumulative;
        previous = cumulative;
        const billed = line.invoiced_at <= at ? line.amount : 0;
        invoicedToDate[i] += billed;
        const gap = billed - cumulative;
        deferredEnd[i] += gap;
        if (gap < 0) unbilledEnd[i] += -gap;
        if (line.invoiced_at >= cells[i].start && line.invoiced_at < cells[i].end) invoicedInMonth[i] += line.amount;
      }
    }

    // Line-level figures are read straight off the schedule, independent of the
    // month sweep above — which is what makes the reconciliation a real check.
    const earned = days.reduce((sum, day) => sum + (day.recognised ? day.amount : 0), 0);
    const billedNow = line.invoiced_at <= asOf ? line.amount : 0;
    line.days = days.length;
    line.recognised_to_date = earned;
    line.deferred = billedNow - earned;
    line.unbilled = earned > billedNow ? earned - billedNow : 0;
    totalInvoiced += billedNow;
    totalRecognised += earned;
    totalDeferred += line.deferred;
    totalUnbilled += line.unbilled;
  }

  const difference = totalInvoiced - totalRecognised - totalDeferred;

  return {
    rows: cells.map((cell, i) => ({
      month: cell.key,
      period: { start: cell.start, end: cell.end },
      complete: cell.complete,
      currency,
      invoiced: invoicedInMonth[i],
      recognised: recognisedInMonth[i],
      invoiced_to_date: invoicedToDate[i],
      recognised_to_date: recognisedToDate[i],
      deferred_balance: deferredEnd[i],
      unbilled_balance: unbilledEnd[i],
    })),
    totals: {
      lines: lines.length,
      invoiced: totalInvoiced,
      recognised: totalRecognised,
      deferred_balance: totalDeferred,
      unbilled_balance: totalUnbilled,
      currency,
    },
    reconciliation: {
      invoiced: totalInvoiced,
      recognised: totalRecognised,
      deferred: totalDeferred,
      difference,
      balanced: difference === 0,
      note: difference === 0
        ? null
        : `Invoiced ${totalInvoiced} does not equal recognised ${totalRecognised} plus deferred ${totalDeferred}.`,
    },
  };
}
