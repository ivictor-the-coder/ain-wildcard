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

/**
 * The axis step the chart will choose for a domain, mirroring the design
 * system's own rule: a human step of 1, 2, 2.5 or 5 × 10ⁿ.
 */
const niceStep = (max: number, count: number): number => {
  const rough = Math.max(max, 1) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  return (normalised >= 5 ? 10 : normalised >= 2.5 ? 5 : normalised >= 1.5 ? 2.5 : normalised >= 1.2 ? 2 : 1) * magnitude;
};

/**
 * How many ticks to ask the chart for, so every one is a whole number.
 *
 * Credits are integers, and a 12-credit day drawn on five ticks stepped at 2.5
 * read "0, 3, 5, 8, 10, 13" once each tick was rounded for the axis. The step
 * is a property of the domain and the count together, so the count is chosen
 * to make it whole; five ticks when five happen to be whole, otherwise the
 * nearest count that is.
 */
export function integerTickCount(max: number, preferred = 5): number {
  if (!Number.isFinite(max) || max <= 0) return preferred;
  for (const count of [preferred, preferred - 1, preferred + 1, preferred - 2, preferred + 2]) {
    if (count < 2) continue;
    if (Number.isInteger(niceStep(max, count))) return count;
  }
  return preferred;
}
