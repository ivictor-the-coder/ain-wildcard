/**
 * Deferred revenue and the recognition schedule behind it.
 *
 * An invoice line is cash the moment it is raised and revenue only as the
 * service is delivered, so every line that names a period is spread across the
 * days of that period. The split rounds the *cumulative* share at each day
 * from an exact rational, and books the difference: the remainder minor units
 * land where the straight line crosses a whole unit, never bunched into the
 * first days, so recognised-to-date is within one unit of the exact line at
 * every instant and the days still sum back to the line to the cent — a
 * schedule whose days do not add up to the invoice is worse than no schedule
 * at all.
 *
 * A credit note is the same thing with the sign reversed and one more rule. It
 * reduces the line it names across the same days, so the part of the service
 * still ahead comes off the deferred balance — but the part already delivered
 * was recognised in months that have closed, and a closed month never moves.
 * That share is booked as contra revenue on the day the note was issued, which
 * is what `booked_at` on every day of a schedule is for: the instant a day's
 * revenue is recognised, which is the end of the day for an invoice line and
 * never earlier than the issue date for a credit.
 *
 * Two balances come out of it, and they are different numbers:
 *
 *  - **deferred** is billed-but-not-yet-earned: the invoice went out on the 1st
 *    for a month that has barely started.
 *  - **unbilled** is earned-but-not-yet-billed: metered usage settles in
 *    arrears, so the service was delivered in March and the bill is raised in
 *    April. It is read from the settlement ledger — a window that has been
 *    priced and is not yet on a finalised invoice — and from any invoice line
 *    whose period ran ahead of its own finalisation.
 *
 * `invoiced = recognised + deferred` holds at every instant, by construction
 * and by an explicit check on the way out.
 */
import { DAY, dayKey } from '../../../shared/time';
import { rat, ratRound } from '../../../shared/money';
import type { MonthCell } from './grid';

/** A day of service and the money earned on it. */
export interface RecognitionDay {
  day: string;
  start: number;
  /** Exclusive. Shorter than a day for the last slice of a period. */
  end: number;
  /** The instant this day's amount is booked: `end`, or the issue date of a credit for a day already gone. */
  booked_at: number;
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
  /** The invoice line's kind, or `credit_note` for a credit against one. */
  kind: string;
  description: string;
  currency: string;
  /** Negative for a credit note line. */
  amount: number;
  /** When this line became billed — the invoice's finalisation instant, or the credit note's issue. */
  invoiced_at: number;
  period: { start: number; end: number };
  /** Set on a credit line: the note it belongs to and the invoice line it reduces. */
  credit_note: string | null;
  credit_note_number: string | null;
  reduces_line: string | null;
  /** The amount of the line a credit reduces, so the credit can be checked against it. */
  reduces_amount: number | null;
  days: number;
  recognised_to_date: number;
  deferred: number;
  unbilled: number;
  schedule?: RecognitionDay[];
}

/**
 * A settled usage window and whether it has reached a finalised invoice — the
 * arrears side of the balance. `finalized_at` is the instant the window's bill
 * was finalised, or null while it is still waiting for one.
 */
export interface ArrearsItem {
  currency: string;
  period_end: number;
  /** What the customer owes for the window, net of credit it absorbed. */
  billed_amount: number;
  finalized_at: number | null;
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
 * Spread an amount over weighted buckets along the straight line.
 *
 * Bucket i receives `round(amount * cum_i / total) - round(amount * cum_{i-1}
 * / total)`, rounded half-up from an exact BigInt rational, so the running
 * total after any bucket is the exact straight-line figure rounded once. The
 * final cumulative share is `amount` itself, which is what makes the schedule
 * sum back to the line without a remainder step. Rounding is on the magnitude
 * and the sign restored, so a credit's schedule is the mirror of its charge.
 */
function spread(amount: number, weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total === 0) return weights.map(() => 0);
  const whole = BigInt(amount);
  const denominator = BigInt(total);
  let cumulative = 0n, previous = 0n;
  return weights.map((weight) => {
    cumulative += BigInt(weight);
    const share = ratRound(rat(whole * cumulative, denominator), 'half_up');
    const day = share - previous;
    previous = share;
    return Number(day);
  });
}

/**
 * One line's daily schedule. Weights are whole seconds of service so a period
 * that does not divide into whole days still splits exactly, and the amounts
 * are spread along the straight line so they sum back to the line.
 *
 * `bookedFrom` is the earliest instant any day may be recognised at. An
 * invoice line has none; a credit note's is its issue date, so the days it
 * reduces that had already been earned are reversed on the day the note was
 * written rather than in the months that earned them.
 */
export function scheduleFor(
  amount: number, currency: string, start: number, end: number, asOf: number, bookedFrom = 0,
): RecognitionDay[] {
  const buckets = bucketsFor(start, end);
  const weights = buckets.map((bucket) => Math.max(1, Math.round((bucket.end - bucket.start) / 1000)));
  const shares = spread(amount, weights);
  void currency;
  return buckets.map((bucket, i) => {
    const bookedAt = Math.max(bucket.end, bookedFrom);
    return {
      day: dayKey(bucket.start),
      start: bucket.start,
      end: bucket.end,
      booked_at: bookedAt,
      amount: shares[i],
      recognised: bookedAt <= asOf,
    };
  });
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
  /** Billed this month, net of credit notes issued this month. */
  invoiced: number;
  /** Credit notes issued this month, as a positive magnitude. */
  credited: number;
  /** Recognised this month, net of any contra revenue booked in it. */
  recognised: number;
  /** Cumulative invoiced at the close of this month, net of credits. */
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
    /** Invoice lines only. */
    invoice_lines: number;
    credit_note_lines: number;
    /** Billed less credited: what the book is owed revenue against. */
    invoiced: number;
    /** Billed before any credit note. */
    invoiced_gross: number;
    /** Credit notes issued by as_of, as a positive magnitude. */
    credited: number;
    recognised: number;
    deferred_balance: number;
    unbilled_balance: number;
    /** The part of `unbilled_balance` that is settled usage waiting for its invoice. */
    unbilled_usage: number;
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
     * came from, the cumulative figure is re-derived by a second algorithm (a
     * monotone cursor over the days) and compared with the first (a filter over
     * the same days), and every credit is held against the line it reduces.
     */
    checks: RecognitionCheck[];
  };
}

/** The settled usage not yet on a finalised invoice at `at`. */
function arrearsAt(items: ArrearsItem[], at: number): number {
  let total = 0;
  for (const item of items) {
    if (item.period_end > at) continue;
    if (item.finalized_at !== null && item.finalized_at <= at) continue;
    total += item.billed_amount;
  }
  return total;
}

/**
 * Sweep every line across the month grid once, carrying a pointer into its own
 * daily schedule. Nothing is recomputed per month, so a year of invoices costs
 * one pass over the days plus one pass over the months.
 */
export function recognise(
  lines: RecognitionLine[], cells: MonthCell[], asOf: number, currency: string | null, arrears: ArrearsItem[] = [],
): RecognitionReport {
  const size = cells.length;
  const invoicedInMonth = new Array<number>(size).fill(0);
  const creditedInMonth = new Array<number>(size).fill(0);
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

  let totalInvoiced = 0, totalGross = 0, totalCredited = 0, totalRecognised = 0, totalDeferred = 0, totalUnbilled = 0;
  let sweptRecognised = 0, scheduledAmount = 0, lineAmount = 0, overCredited = 0;
  let invoiceLines = 0, creditLines = 0;

  for (const line of lines) {
    const credit = line.credit_note !== null;
    // A credit's days are booked no earlier than its issue: what it reverses
    // in months already closed is contra revenue on the day it was written.
    const days = scheduleFor(line.amount, line.currency, line.period.start, line.period.end, asOf, credit ? line.invoiced_at : 0);
    let cursor = 0, cumulative = 0;

    if (size) {
      const opening = Math.min(cells[0].opens_at, asOf);
      while (cursor < days.length && days[cursor].booked_at <= opening) { cumulative += days[cursor].amount; cursor += 1; }
      let previous = cumulative;
      for (let i = 0; i < size; i++) {
        const at = readAt[i];
        while (cursor < days.length && days[cursor].booked_at <= at) { cumulative += days[cursor].amount; cursor += 1; }
        recognisedInMonth[i] += cumulative - previous;
        recognisedToDate[i] += cumulative;
        previous = cumulative;
        const billed = line.invoiced_at <= at ? line.amount : 0;
        invoicedToDate[i] += billed;
        const gap = billed - cumulative;
        deferredEnd[i] += gap;
        // Only an invoice line can be earned before it is billed. A credit's
        // negative gap is the deferred balance coming down, not usage waiting
        // for a bill.
        if (gap < 0 && !credit) unbilledEnd[i] += -gap;
        if (line.invoiced_at >= cells[i].start && line.invoiced_at < cells[i].end && line.invoiced_at <= asOf) {
          invoicedInMonth[i] += line.amount;
          if (credit) creditedInMonth[i] += -line.amount;
        }
      }
    }
    // The same cursor, carried on to as_of, is the second opinion the
    // reconciliation compares against the filter below.
    while (cursor < days.length && days[cursor].booked_at <= asOf) { cumulative += days[cursor].amount; cursor += 1; }
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
    line.unbilled = !credit && earned > billedNow ? earned - billedNow : 0;
    totalInvoiced += billedNow;
    if (credit) { creditLines += 1; totalCredited += -billedNow; } else { invoiceLines += 1; totalGross += billedNow; }
    totalRecognised += earned;
    totalDeferred += line.deferred;
    totalUnbilled += line.unbilled;
    if (credit && line.reduces_amount !== null && -line.amount > line.reduces_amount) {
      overCredited += -line.amount - line.reduces_amount;
    }
  }

  // Settled usage waiting for its bill is unbilled at every instant it is
  // waiting, and stops being so the moment the invoice that carries it is
  // finalised — read at each month's close, like everything else here.
  const usageUnbilled = arrearsAt(arrears, asOf);
  for (let i = 0; i < size; i++) unbilledEnd[i] += arrearsAt(arrears, readAt[i]);
  totalUnbilled += usageUnbilled;

  const checks: RecognitionCheck[] = [
    {
      name: 'schedule_sums_to_line',
      description:
        'Every daily schedule re-summed against the invoice or credit line it was split from. The cumulative spread ' +
        'guarantees it; this checks it, because a schedule whose days do not add up to the document is worse than no schedule at all.',
      expected: lineAmount,
      actual: scheduledAmount,
      difference: scheduledAmount - lineAmount,
      ok: scheduledAmount === lineAmount,
    },
    {
      name: 'cursor_matches_filter',
      description:
        'Recognised-to-date computed twice over the same days by two different traversals: a monotone cursor that ' +
        'walks them in booking order (the one the monthly series uses) and a filter over the whole schedule (the one ' +
        'the line totals use). They differ if the days are not in order or the sweep drops one.',
      expected: totalRecognised,
      actual: sweptRecognised,
      difference: sweptRecognised - totalRecognised,
      ok: sweptRecognised === totalRecognised,
    },
    {
      name: 'credits_within_the_lines_they_reduce',
      description:
        'Every credit note line held against the invoice line it names: a credit can never take more off a line than ' +
        'the line billed. Billing refuses such a note; this is the sum by which any note got past it.',
      expected: 0,
      actual: overCredited,
      difference: overCredited,
      ok: overCredited === 0,
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
      credited: creditedInMonth[i],
      recognised: recognisedInMonth[i],
      invoiced_to_date: invoicedToDate[i],
      recognised_to_date: recognisedToDate[i],
      deferred_balance: deferredEnd[i],
      unbilled_balance: unbilledEnd[i],
    })),
    totals: {
      lines: lines.length,
      invoice_lines: invoiceLines,
      credit_note_lines: creditLines,
      invoiced: totalInvoiced,
      invoiced_gross: totalGross,
      credited: totalCredited,
      recognised: totalRecognised,
      deferred_balance: totalDeferred,
      unbilled_balance: totalUnbilled,
      unbilled_usage: usageUnbilled,
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
