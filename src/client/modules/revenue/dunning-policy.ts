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

/* ---------------------------- the attempt timeline ------------------------ */

const DAY_MS = 86_400_000;

/**
 * When the schedule will next present the card, read from the attempt row
 * rather than from the sentence written beside it.
 *
 * Every attempt carries both the reasoning (`decision`, prose written when
 * the attempt was recorded) and the instant (`next_attempt_at`). The prose
 * states the gap in words — "Attempt 3 of 4 is scheduled five days out" — and
 * goes stale the moment the slot moves, which it does whenever the campaign
 * is held, retried by hand, or found by the daily watch with its slot already
 * in the past. Van Doorn Verpakking's campaign showed the result: a timeline
 * promising a retry five days after Aug 31 above a tile reading Sep 11, both
 * on the same screen, and no way to tell which was true. The instant is the
 * one the queue actually runs on, so the timeline reads it.
 */
export interface NextAttemptFact {
  /** The instant this attempt recorded for the next presentation. */
  at: number;
  /** Whole days from this attempt to that instant — at least one. */
  gapDays: number;
  attempt: number;
  of: number;
  /**
   * Where the campaign's slot sits now, when it has moved since this attempt
   * recorded one. Null while the two agree, which is the ordinary case.
   */
  movedTo: number | null;
}

export function nextAttemptFact(
  attempt: { attempt_number: number; attempted_at: number | null; scheduled_for: number; next_attempt_at: number | null; outcome: string },
  campaign: { max_attempts: number; next_attempt_at: number | null },
  latest: boolean,
): NextAttemptFact | null {
  if (attempt.outcome !== 'failed' || attempt.next_attempt_at === null) return null;
  const from = attempt.attempted_at ?? attempt.scheduled_for;
  const moved = latest && campaign.next_attempt_at !== null && campaign.next_attempt_at !== attempt.next_attempt_at;
  return {
    at: attempt.next_attempt_at,
    gapDays: Math.max(1, Math.round((attempt.next_attempt_at - from) / DAY_MS)),
    attempt: attempt.attempt_number + 1,
    of: campaign.max_attempts,
    movedTo: moved ? campaign.next_attempt_at : null,
  };
}

/**
 * What the schedule decided next, as one sentence over the instant the queue
 * holds. `when` is `f.dateTime`, so the date reads in the workspace's own
 * timezone — the same call the "Next attempt" tile makes.
 */
export function nextAttemptLine(
  fact: NextAttemptFact,
  when: (at: number) => string,
  plural: (count: number, noun: string) => string,
): string {
  const scheduled = `Attempt ${fact.attempt} of ${fact.of} was scheduled for ${when(fact.at)}, ${plural(fact.gapDays, 'day')} after this one.`;
  return fact.movedTo === null
    ? scheduled
    : `${scheduled} The schedule has moved it since, to ${when(fact.movedTo)}.`;
}

/**
 * Whether presenting a card to the issuer is something this campaign can do.
 *
 * A campaign with no usable method on file has nothing to present. The row
 * offered "Retry the charge now…" anyway, the dialog named the attempt it was
 * about to spend, and presenting recorded no attempt at all — a success toast
 * over an unchanged campaign. The server already knows: `payment_method` is
 * null exactly when there is nothing to charge, and `recommended_action`
 * already says to attach a card first.
 *
 * A settled campaign is likewise nothing to retry, which the row already knew.
 */
export const canPresent = (campaign: { status: string; payment_method: unknown }): boolean =>
  campaign.status !== 'recovered' && campaign.status !== 'canceled' && !!campaign.payment_method;

/** Why the retry is not on offer, for the menu row that cannot take it. */
export const cannotPresentReason = (campaign: { status: string; payment_method: unknown }): string | undefined => {
  if (campaign.status === 'recovered' || campaign.status === 'canceled') return undefined;
  return campaign.payment_method ? undefined : 'No usable card on file — attach one first';
};
