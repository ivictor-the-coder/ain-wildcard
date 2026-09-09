/**
 * What a clock move ran — worked out honestly, from what the platform keeps.
 *
 * `POST /v1/time/advance` answers with `jobs_run` and `jobs_failed`, but the
 * audit entry it writes records only the clock's `before.now` and `after.now`.
 * So the one screen whose job is to say what each move did has to reconstruct
 * it, and the obvious reconstruction — every completed job whose instant falls
 * inside the move's window — is wrong in two ways an operator will hit on the
 * first afternoon:
 *
 *   1. A jump made after a return to real time re-covers the span the previous
 *      jump already ran through. Both windows hold the same jobs, so a move
 *      that ran nothing reads "18 jobs" and the next one reads the sum.
 *   2. The completed-jobs read is a page of the two hundred latest `run_at`,
 *      and `core.cleanup` deletes done jobs a week old. A move's jobs fall out
 *      of the read and the badge quietly shrinks from 18 to 5.
 *
 * Two rules fix it. A job is credited to exactly one move — the only window
 * that holds it — and where two windows hold it, it is credited to neither and
 * both moves are marked as sharing their span. And the count the server gave
 * the operator who pressed the button is kept, keyed by the move's `previous`
 * instant (which the audit entry stores verbatim as `before.now`), so a move
 * made from this browser reads exactly what the server said, and one made
 * elsewhere reads a count only when the window matching can stand behind it.
 */
import { DAY } from '../../../shared/time';

export interface MoveWindow {
  id: string;
  from: number;
  to: number;
}

export interface Attribution<J> {
  /** Jobs whose instant falls in this window and no other. */
  own: J[];
  /** Jobs whose instant falls in this window and at least one other. */
  shared: J[];
}

const inWindow = (move: MoveWindow, instant: number): boolean =>
  instant > move.from && instant <= Math.max(move.to, move.from);

/** Every job credited to the one move that holds it, or to none when two do. */
export function attributeJobs<J extends { id: string; updated: number }>(
  moves: readonly MoveWindow[],
  jobs: readonly J[],
): Map<string, Attribution<J>> {
  const out = new Map<string, Attribution<J>>();
  for (const move of moves) out.set(move.id, { own: [], shared: [] });
  for (const job of jobs) {
    const holders = moves.filter((move) => inWindow(move, job.updated));
    if (holders.length === 0) continue;
    const bucket = holders.length === 1 ? 'own' : 'shared';
    for (const move of holders) out.get(move.id)![bucket].push(job);
  }
  for (const attribution of out.values()) {
    attribution.own.sort((a, b) => a.updated - b.updated);
    attribution.shared.sort((a, b) => a.updated - b.updated);
  }
  return out;
}

/* ------------------------------ the record -------------------------------- */

export interface RecordedMove {
  /** `previous` on the response — the very instant the audit entry keeps as `before.now`. */
  from: number;
  to: number;
  jobsRun: number;
  jobsFailed: number;
  /** Wall-clock time the record was written, so the store can be trimmed oldest-first. */
  recordedAt: number;
}

/** The most moves one browser remembers per workspace. */
export const RECORD_LIMIT = 200;

export const recordKey = (orgId: string): string => `ain.settings.clock-moves.${orgId}`;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const isRecorded = (value: unknown): value is RecordedMove => {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return ['from', 'to', 'jobsRun', 'jobsFailed', 'recordedAt'].every((key) => typeof row[key] === 'number' && Number.isFinite(row[key]));
};

/** Everything this browser remembers about moves on one workspace. Never throws. */
export function readRecordedMoves(storage: StorageLike | null | undefined, orgId: string): RecordedMove[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(recordKey(orgId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecorded) : [];
  } catch {
    return [];
  }
}

/** Remember one move's server answer; returns the store as it now stands. */
export function recordMove(storage: StorageLike | null | undefined, orgId: string, move: RecordedMove): RecordedMove[] {
  const kept = readRecordedMoves(storage, orgId).filter((row) => row.from !== move.from);
  kept.push(move);
  kept.sort((a, b) => a.recordedAt - b.recordedAt);
  const trimmed = kept.slice(Math.max(0, kept.length - RECORD_LIMIT));
  if (storage) {
    try { storage.setItem(recordKey(orgId), JSON.stringify(trimmed)); } catch { /* a full or refused store loses the memory, not the move */ }
  }
  return trimmed;
}

export const recordedFor = (records: readonly RecordedMove[], from: number): RecordedMove | undefined =>
  records.find((row) => row.from === from);

/* ------------------------------- the tally -------------------------------- */

export type MoveTally =
  /** The server's own answer, kept by the browser that asked. */
  | { kind: 'recorded'; ran: number; failed: number }
  /** Counted from completed jobs, where the window is this move's alone and still fully readable. */
  | { kind: 'matched'; ran: number; failed: number }
  /** Another move's window overlaps this one and nothing was recorded — the jobs cannot be told apart. */
  | { kind: 'shared' }
  /**
   * The read no longer holds everything this move ran. `readable` is how many
   * of its own jobs it still does hold — a floor, never the count.
   */
  | { kind: 'beyond'; readable: number };

export interface Coverage {
  /** The workspace clock now — `core.cleanup` deletes done jobs a week older than it. */
  now: number;
  /** The read holds its page limit, so anything with an earlier `run_at` fell off it. */
  capped: boolean;
  /** The smallest `run_at` on the page, when it is capped. */
  floor: number | null;
}

/** Retention is seven workspace days; a move older than that has lost its jobs to cleanup. */
export const RETENTION = 7 * DAY;

/**
 * Whether the completed-jobs read can still hold everything a move ran.
 *
 * Cleanup runs on the *workspace* clock, and a jump steps that clock through
 * every day on the way — so a thirty-day jump prunes the jobs from its own
 * first three weeks before it ends, whatever the clock reads afterwards. A move
 * whose far end is more than the retention past its start has already lost
 * part of itself, even once the clock has been returned to real time and `now`
 * is back beside `from`. That is how a jump the server counted at 302 jobs read
 * "83 jobs" to the next person who opened the screen.
 */
export function covers(move: MoveWindow, coverage: Coverage): boolean {
  const horizon = Math.max(coverage.now, move.to);
  if (move.from < horizon - RETENTION) return false;
  if (coverage.capped && coverage.floor !== null && move.from < coverage.floor) return false;
  return true;
}

export function tallyMove(input: {
  recorded: RecordedMove | undefined;
  own: { ran: number; failed: number };
  sharesWindow: boolean;
  covered: boolean;
}): MoveTally {
  if (input.recorded) return { kind: 'recorded', ran: input.recorded.jobsRun, failed: input.recorded.jobsFailed };
  if (input.sharesWindow) return { kind: 'shared' };
  if (!input.covered) return { kind: 'beyond', readable: input.own.ran + input.own.failed };
  return { kind: 'matched', ran: input.own.ran, failed: input.own.failed };
}

/* ------------------------------ what is due ------------------------------- */

export interface DuePreview {
  /** Pending rows this read can see coming due at or before the target. */
  count: number;
  /** The count is a floor, not the number of jobs the jump will run. */
  atLeast: boolean;
  /** Why it is a floor, so the sentence under the button can say. */
  floor: 'exact' | 'requeues' | 'capped';
}

/**
 * How many pending jobs a jump to `target` would run — a floor, whenever it is
 * not zero.
 *
 * The queue is not a fixed list that a jump works through. `drainUntil` steps
 * the clock to each due batch and drains it, then asks the queue again, so a
 * job that books its own next run — the fleet-shift meter, a dunning retry, a
 * re-enqueuing digest — comes due again inside the same jump and runs again.
 * The pending page holds one row for each of those, and the jump runs it as
 * many times as the span allows: "A day" forecast 18 jobs on the demo
 * workspace and the move it made recorded 42, on the same screen, minutes
 * apart. So a positive count is stated as a floor and never as the answer.
 *
 * Zero is exact, though, and worth keeping exact: if nothing is due before the
 * target then nothing runs, and nothing that did not run can queue anything.
 * Unless the read itself was cut — `GET /v1/jobs` orders by `run_at DESC`, so
 * a capped page is missing exactly the soonest work, which is the work a jump
 * reaches first.
 */
export function dueBy(pending: readonly { run_at: number }[], target: number, capped: boolean): DuePreview {
  const count = pending.filter((job) => job.run_at <= target).length;
  const floor = capped ? 'capped' : count === 0 ? 'exact' : 'requeues';
  return { count, atLeast: floor !== 'exact', floor };
}
