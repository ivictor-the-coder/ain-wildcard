/**
 * The retry policy form's own rules, and the words the recovery screen uses
 * for a rate it cannot state.
 *
 * `PATCH /v1/payments/settings` refuses `max_attempts` outside 1–12, but a
 * number field that clamps on the way in never lets the request reach that
 * refusal: 0 became 1 under the operator's hands, saved as a success, and
 * three campaigns later exhausted after a single attempt. The form now keeps
 * what was typed, says why it cannot be saved, and withholds Save — the same
 * limits the server enforces, stated before the request rather than after.
 */

export const MIN_ATTEMPTS = 1;
export const MAX_ATTEMPTS = 12;
export const MIN_HOUR = 0;
export const MAX_HOUR = 23;

export function attemptsError(value: number | null): string | null {
  if (value === null) return 'Say how many attempts the schedule gets.';
  if (!Number.isInteger(value)) return 'Whole attempts only.';
  if (value < MIN_ATTEMPTS) return 'At least 1 attempt — the first presentation is attempt one, so 0 would never present the card at all.';
  if (value > MAX_ATTEMPTS) return `No more than ${MAX_ATTEMPTS} attempts. Beyond that the acquirer reads the schedule as harassment.`;
  return null;
}

export function collectionHourError(value: number | null): string | null {
  if (value === null) return 'Pick the hour attempts are presented at.';
  if (!Number.isInteger(value)) return 'A whole hour, 0 to 23.';
  if (value < MIN_HOUR || value > MAX_HOUR) return 'An hour from 0 to 23 — 23:00 is the latest an attempt can be presented.';
  return null;
}

/**
 * One line for the toast: the schedule in numbers. The narrative the API
 * writes already lives on the policy card; repeating eight lines of it in a
 * toast that dismisses itself is noise.
 */
export function policySavedLine(
  policy: { max_attempts: number; retry_days: number[] },
  list: (items: string[]) => string,
): string {
  if (policy.max_attempts === 1) return 'One attempt and no retries';
  const gaps = policy.retry_days.map(String);
  const days = gaps.length === 1 ? `${gaps[0]} days` : `${list(gaps)} days`;
  return `${policy.max_attempts} attempts over ${days}`;
}

/**
 * `recovery_rate_bps` is recovered over (recovered + lost), a rate over the
 * campaigns that have finished. With none finished it comes back as 0, which
 * is not a rate of nothing — it is no rate at all, and the tile says so, the
 * way `GET /v1/revenue/collections` already does for the same book.
 */
export function recoveryRateText(total: { recovered_amount: number; lost_amount: number; recovery_rate_bps: number }): string {
  if (total.recovered_amount + total.lost_amount === 0) return 'no finished campaign yet';
  return `${(total.recovery_rate_bps / 100).toFixed(2)}% rate`;
}
