/**
 * What the meters table says about when a meter last saw an event.
 *
 * `GET /v1/metering/overview` reports a 30-day window — events, customers and
 * the last hour with events, all inside the last 30 days — so once a month has
 * passed since the last flush every one of them is zero or null. That is a
 * fact about the window, not about the meter: `GET /v1/meters/:id` still
 * carries `ingestion.last_event_at`. A cell that turns the window's null into
 * "Never" tells a person the meter has never streamed when it streamed 745
 * events five weeks ago. The state is classified here, once, so the cell, the
 * sort and the export cannot disagree about it.
 */

const DAY_MS = 86_400_000;

/** The overview's own window, so the copy names the same span the tiles do. */
export const OVERVIEW_WINDOW_DAYS = 30;

export type LastSeen =
  /** An event inside the overview window. `stalled` after two silent days. */
  | { state: 'recent'; at: number; stalled: boolean }
  /** Nothing inside the window, but the meter has streamed before. */
  | { state: 'quiet'; at: number }
  /** The meter has never received an event. */
  | { state: 'never' }
  /** Nothing in the window and the meter's own record has not been read yet. */
  | { state: 'pending' };

/**
 * @param recentAt   `last_hour_with_events` from the overview — null outside the window.
 * @param lastEventAt `ingestion.last_event_at` from the meter — undefined until read.
 */
export function lastSeen(
  recentAt: number | null | undefined,
  lastEventAt: number | null | undefined,
  now: number,
): LastSeen {
  if (recentAt) return { state: 'recent', at: recentAt, stalled: now - recentAt > 2 * DAY_MS };
  if (lastEventAt === undefined) return { state: 'pending' };
  if (lastEventAt === null) return { state: 'never' };
  return { state: 'quiet', at: lastEventAt };
}

/** The instant a row sorts and exports on — the true last event, whatever window found it. */
export const lastSeenAt = (seen: LastSeen): number | null =>
  (seen.state === 'recent' || seen.state === 'quiet' ? seen.at : null);

export const QUIET_COPY = `Nothing in the last ${OVERVIEW_WINDOW_DAYS} days`;
export const NEVER_COPY = 'Never — nothing has arrived';

/**
 * "46 days ago", where the design system's relative time says "2 months ago".
 * Under a week the coarse form is right ("3 days ago"); past a quarter, months
 * are the honest unit. In between, a meter that went quiet 46 days ago is a
 * different fact from one that went quiet 75 days ago, and both read
 * "2 months ago". Null means: use the ordinary relative form.
 */
export function daysAgoCopy(at: number, now: number): string | null {
  const days = Math.floor((now - at) / DAY_MS);
  if (days < 7 || days >= 90) return null;
  return `${days} days ago`;
}

/**
 * "43.68 GBs" is what a plural rule does to a unit symbol. A short label
 * carrying a capital — GB, MB, kWh, API — is an abbreviation, and abbreviations
 * do not inflect; "events", "seats" and "robots" still do.
 */
export const isUnitAbbreviation = (label: string): boolean =>
  label.length <= 4 && /[A-Z]/.test(label);
