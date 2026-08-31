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
  currency: string | null;
  /**
   * The instant this row was read at: the close of the month, or `as_of` when
   * `as_of` falls inside it or before it. A month after `as_of` is read at
   * `as_of` and therefore recognises nothing — which is what makes the last
   * cumulative figure in the series equal `totals.recognised` instead of
   * running past it.
   */
  read_at: number;
  /** False for a month the report never reached because `as_of` is before it. */
  in_scope: boolean;
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

export interface RecognitionCheck {
  name: string;
  description: string;
  expected: number;
  actual: number;
  difference: number;
  ok: boolean;
}

export interface RecognitionReport {
  rows: RecognitionRow[];
  totals: {
    lines: number;
    invoiced: number;
    recognised: number;
    deferred_balance: number;
    unbilled_balance: number;
    currency: string | null;
  };
  reconciliation: {
    invoiced: number;
    recognised: number;
    deferred: number;
    difference: number;
    balanced: boolean;
    note: string | null;
    /**
     * What was actually checked. `invoiced = recognised + deferred` alone is an
     * identity — `deferred` is defined as the difference, so it can never fail
     * and a report that offers it as proof is offering nothing. These are the
     * checks that can fail: the daily schedule is re-summed against the line it
     * came from, and the cumulative figure is re-derived by a second algorithm
     * (a monotone cursor over the days) and compared with the first (a filter
     * over the same days). A schedule that does not sum, or days that are not
     * in order, break them.
     */
    checks: RecognitionCheck[];
  };
}

/**
 * Sweep every line across the month grid once, carrying a pointer into its own
 * daily schedule. Nothing is recomputed per month, so a year of invoices costs
 * one pass over the days plus one pass over the months.
 */
export function recognise(
  lines: RecognitionLine[], cells: MonthCell[], asOf: number, currency: string | null,
): RecognitionReport {
  const size = cells.length;
  const invoicedInMonth = new Array<number>(size).fill(0);
  const recognisedInMonth = new Array<number>(size).fill(0);
  const recognisedToDate = new Array<number>(size).fill(0);
  const invoicedToDate = new Array<number>(size).fill(0);
  const deferredEnd = new Array<number>(size).fill(0);
  const unbilledEnd = new Array<number>(size).fill(0);
  // Every month is read at its own close, or at `as_of` when `as_of` is
  // earlier. Without the clamp the series kept recognising past the date the
  // totals were computed at, and a request with ?as_of= in the past published a
  // cumulative figure larger than its own total in the same document.
  const readAt = cells.map((cell) => Math.min(cell.at, asOf));

  let totalInvoiced = 0, totalRecognised = 0, totalDeferred = 0, totalUnbilled = 0;
  let sweptRecognised = 0, scheduledAmount = 0, lineAmount = 0;

  for (const line of lines) {
    const days = scheduleFor(line.amount, line.currency, line.period.start, line.period.end, asOf);
    let cursor = 0, cumulative = 0;

    if (size) {
      const opening = Math.min(cells[0].opens_at, asOf);
      while (cursor < days.length && days[cursor].end <= opening) { cumulative += days[cursor].amount; cursor += 1; }
      let previous = cumulative;
      for (let i = 0; i < size; i++) {
        const at = readAt[i];
        while (cursor < days.length && days[cursor].end <= at) { cumulative += days[cursor].amount; cursor += 1; }
        recognisedInMonth[i] += cumulative - previous;
        recognisedToDate[i] += cumulative;
        previous = cumulative;
        const billed = line.invoiced_at <= at ? line.amount : 0;
        invoicedToDate[i] += billed;
        const gap = billed - cumulative;
        deferredEnd[i] += gap;
        if (gap < 0) unbilledEnd[i] += -gap;
        if (line.invoiced_at >= cells[i].start && line.invoiced_at < cells[i].end && line.invoiced_at <= asOf) {
          invoicedInMonth[i] += line.amount;
        }
      }
    }
    // The same cursor, carried on to as_of, is the second opinion the
    // reconciliation compares against the filter below.
    while (cursor < days.length && days[cursor].end <= asOf) { cumulative += days[cursor].amount; cursor += 1; }
    sweptRecognised += cumulative;
    scheduledAmount += days.reduce((sum, day) => sum + day.amount, 0);
    lineAmount += line.amount;

    // Line-level figures are read straight off the schedule by filtering it,
    // which is a different traversal from the cursor above.
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

  const checks: RecognitionCheck[] = [
    {
      name: 'schedule_sums_to_line',
      description:
        'Every daily schedule re-summed against the invoice line it was split from. allocate() guarantees it; this ' +
        'checks it, because a schedule whose days do not add up to the invoice is worse than no schedule at all.',
      expected: lineAmount,
      actual: scheduledAmount,
      difference: scheduledAmount - lineAmount,
      ok: scheduledAmount === lineAmount,
    },
    {
      name: 'cursor_matches_filter',
      description:
        'Recognised-to-date computed twice over the same days by two different traversals: a monotone cursor that ' +
        'walks them in order (the one the monthly series uses) and a filter over the whole schedule (the one the line ' +
        'totals use). They differ if the days are not in order or the sweep drops one.',
      expected: totalRecognised,
      actual: sweptRecognised,
      difference: sweptRecognised - totalRecognised,
      ok: sweptRecognised === totalRecognised,
    },
  ];
  if (size && readAt[size - 1] === asOf) {
    checks.push({
      name: 'series_ends_at_totals',
      description:
        'The last cumulative figure in the monthly series against the total computed from the lines. The series is ' +
        'read at as_of once as_of is inside the range, so the two are the same figure reached two ways.',
      expected: totalRecognised,
      actual: recognisedToDate[size - 1],
      difference: recognisedToDate[size - 1] - totalRecognised,
      ok: recognisedToDate[size - 1] === totalRecognised,
    });
  }

  const failed = checks.filter((check) => !check.ok);
  const difference = totalInvoiced - totalRecognised - totalDeferred;

  return {
    rows: cells.map((cell, i) => ({
      month: cell.key,
      period: { start: cell.start, end: cell.end },
      complete: cell.complete,
      currency,
      read_at: readAt[i],
      in_scope: cell.start <= asOf,
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
      balanced: difference === 0 && failed.length === 0,
      note: difference === 0 && failed.length === 0
        ? null
        : failed.length
          ? failed.map((check) => `${check.name}: expected ${check.expected}, got ${check.actual}.`).join(' ')
          : `Invoiced ${totalInvoiced} does not equal recognised ${totalRecognised} plus deferred ${totalDeferred}.`,
      checks,
    },
  };
}
