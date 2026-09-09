/**
 * Reading an account's pressure against a ceiling honestly.
 *
 * `GET /v1/entitlements/overview` hands each at-risk account three numbers:
 * `value`, the allowance its plan includes; `used`, what the meter has counted;
 * and `percent_used`, which the server takes against a *different* denominator
 * — the allowance plus whatever prepaid credit is topping it up — and then caps
 * at 100. So an account that had burned 115 of the 100 events its plan includes,
 * with a 25-event credit grant behind it, was printed as "115 of 100 — 92%
 * used": the sentence divides by one number and displays another, and the
 * percentage tells an operator the account is comfortably inside a ceiling it
 * is 15% past.
 *
 * A percentage is only meaningful beside the denominator it was taken against.
 * These read against the allowance the row itself names, uncapped, and then say
 * separately what prepaid credit does to the ceiling — which is derivable
 * exactly whenever the account is not already past it, because `remaining` is
 * measured from the topped-up limit.
 */

export interface Pressure {
  /** The allowance the plan includes for the period. `null` on an unbounded grant. */
  value: number | null;
  used: number;
  /** What is left against the allowance *plus* prepaid credit, floored at zero. */
  remaining: number | null;
}

export interface PressureReading {
  /**
   * Of the included allowance, rounded down and uncapped — 115 for an account
   * 15% past it. `null` when the row names no allowance to divide by.
   */
  percentOfAllowance: number | null;
  /**
   * The ceiling actually in force: the allowance plus the prepaid credit drawn
   * against it. Only stated where the numbers prove it — `remaining` is floored
   * at zero once the account is past that ceiling, and a floor proves nothing.
   */
  ceiling: number | null;
  /** The prepaid credit standing between the allowance and that ceiling. */
  credit: number | null;
  /** Of that ceiling, rounded down. `null` when the ceiling is not derivable. */
  percentOfCeiling: number | null;
  /** Past the allowance the plan includes. */
  over: boolean;
}

/** Integer percent, rounded down — the direction the server rounds, and never flattering. */
const percentOf = (used: number, of: number): number | null =>
  (of > 0 && Number.isFinite(used) ? Math.floor((used * 100) / of) : null);

export function readPressure(row: Pressure): PressureReading {
  const allowance = row.value;
  // `remaining` counts down from the topped-up ceiling, so it only reveals that
  // ceiling while there is something left of it. At zero the account is at or
  // past the ceiling and the credit behind it cannot be recovered from these.
  const ceiling = row.remaining !== null && row.remaining > 0 ? row.used + row.remaining : null;
  const credit = ceiling !== null && allowance !== null ? ceiling - allowance : null;
  const topped = credit !== null && credit > 0 && ceiling !== null;
  return {
    percentOfAllowance: allowance === null ? null : percentOf(row.used, allowance),
    ceiling: topped ? ceiling : null,
    credit: topped ? credit : null,
    percentOfCeiling: topped ? percentOf(row.used, ceiling) : null,
    over: allowance !== null && row.used > allowance,
  };
}

/** The two bits of the workspace's own formatter this sentence needs. */
export interface PressureFormat {
  number: (value: number) => string;
  plural: (count: number, word: string) => string;
}

/**
 * The clause after "115 of 100 robots": the percentage taken against the very
 * number printed beside it, and what prepaid credit does to the ceiling when it
 * is doing anything. Quantities go through the workspace's formatter, so a
 * ceiling reads "25,008,763" here exactly as it does two words earlier.
 */
export function describePressure(row: Pressure, unit: string, f: PressureFormat): string {
  const reading = readPressure(row);
  if (reading.percentOfAllowance === null) return '';
  const head = `${reading.percentOfAllowance}% of the included allowance`;
  if (reading.ceiling === null || reading.credit === null) return head;
  return `${head} · ${f.plural(reading.credit, unit)} of prepaid credit `
    + `${reading.credit === 1 ? 'raises' : 'raise'} the ceiling to ${f.number(reading.ceiling)}, so ${reading.percentOfCeiling}% of that`;
}

/** Worst first, by how far past its own allowance each account is. */
export function byPressure(a: Pressure, b: Pressure): number {
  return (readPressure(b).percentOfAllowance ?? 0) - (readPressure(a).percentOfAllowance ?? 0);
}
