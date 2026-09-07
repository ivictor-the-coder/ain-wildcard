/**
 * The usage report, as pure functions.
 *
 * `GET /v1/ai/usage` buckets what the engine cost by day, feature, teammate
 * and model; the runs page draws it and this is the one shaping rule it
 * applies, kept apart from React so it can be held to a fixture.
 */

/** A `YYYY-MM-DD` bucket key as the instant it starts, in UTC — the engine's own day boundary. */
export const dayStart = (key: string): number => Date.parse(`${key}T00:00:00Z`);

const DAY_MS = 86_400_000;

/**
 * One bucket per day of the window, quiet days included.
 *
 * The report lists only the days something ran, and a chart of those alone
 * drew one bar the width of the card for a month with one busy day. Every day
 * of the window is a category; the ones the engine sat idle are zero.
 */
export function everyDay(
  period: { since: string; until: string },
  buckets: readonly { key: string; credits: number; runs: number }[],
): { key: string; credits: number; runs: number }[] {
  const byKey = new Map(buckets.map((row) => [row.key, row]));
  const out: { key: string; credits: number; runs: number }[] = [];
  const start = dayStart(period.since);
  const end = dayStart(period.until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return buckets.map((row) => ({ key: row.key, credits: row.credits, runs: row.runs }));
  }
  for (let ts = start; ts <= end && out.length < 400; ts += DAY_MS) {
    const key = new Date(ts).toISOString().slice(0, 10);
    const row = byKey.get(key);
    out.push({ key, credits: row?.credits ?? 0, runs: row?.runs ?? 0 });
  }
  return out;
}
