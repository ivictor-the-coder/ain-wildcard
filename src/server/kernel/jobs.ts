import type { Db } from './db';
import { parseJson } from './db';
import type { Logger } from './logger';
import { newId } from '../../shared/ids';

/**
 * A durable, deterministic job queue. Nothing in the platform sleeps on a
 * timer: renewals, dunning retries, credit expiry, workflow delays, agent runs
 * and webhook deliveries are all rows with a `run_at`. Advancing the clock and
 * draining the queue replays the business forward exactly.
 */
export interface JobRow {
  id: string;
  org_id: string;
  type: string;
  payload: unknown;
  run_at: number;
  attempts: number;
  max_attempts: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  last_error: string | null;
  idem_key: string | null;
  created: number;
  updated: number;
}

export interface EnqueueOptions {
  runAt?: number;
  maxAttempts?: number;
  /** Enqueueing twice with the same key replaces the pending job. */
  idemKey?: string;
  /** Backoff schedule in ms per attempt; falls back to exponential. */
  backoff?: number[];
}

export type JobHandler = (payload: any, job: JobRow) => void | Promise<void>;

export class JobQueue {
  private readonly handlers: Map<string, JobHandler>;
  private readonly backoffs: Map<string, number[]>;
  /** The only workspace this view can see; null is the whole process. */
  readonly orgId: string | null;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    view?: { orgId: string; handlers: Map<string, JobHandler>; backoffs: Map<string, number[]> },
  ) {
    this.handlers = view?.handlers ?? new Map();
    this.backoffs = view?.backoffs ?? new Map();
    this.orgId = view?.orgId ?? null;
  }

  /**
   * A view of this queue that can only see — and only run — one workspace's
   * jobs, sharing the one handler registry. The clock is per workspace, so
   * draining has to be too: one org advancing a year must not run another
   * org's renewals, dunning and credit expiry a year early.
   */
  forOrg(orgId: string): JobQueue {
    if (this.orgId === orgId) return this;
    return new JobQueue(this.db, this.log, { orgId, handlers: this.handlers, backoffs: this.backoffs });
  }

  handle(type: string, handler: JobHandler, backoff?: number[]): void {
    this.handlers.set(type, handler);
    if (backoff) this.backoffs.set(type, backoff);
  }

  registeredTypes(): string[] { return [...this.handlers.keys()].sort(); }

  enqueue(orgId: string, type: string, payload: unknown, now: number, opts: EnqueueOptions = {}): JobRow {
    const runAt = opts.runAt ?? now;
    if (opts.idemKey) {
      const existing = this.db.get<JobRow>(
        `SELECT * FROM jobs WHERE org_id = ? AND idem_key = ? AND status = 'pending'`, orgId, opts.idemKey);
      if (existing) {
        this.db.patch('jobs', 'id', existing.id, { run_at: runAt, payload: payload as any, updated: now });
        return { ...existing, run_at: runAt, payload };
      }
    }
    const job: JobRow = {
      id: newId('job'), org_id: orgId, type, payload, run_at: runAt, attempts: 0,
      max_attempts: opts.maxAttempts ?? 8, status: 'pending', last_error: null,
      idem_key: opts.idemKey ?? null, created: now, updated: now,
    };
    this.db.insert('jobs', { ...job, payload: payload as any });
    return job;
  }

  cancel(orgId: string, filter: { idemKey?: string; type?: string; id?: string }, now: number): number {
    const clauses = ["org_id = ?", "status = 'pending'"];
    const params: unknown[] = [orgId];
    if (filter.idemKey) { clauses.push('idem_key = ?'); params.push(filter.idemKey); }
    if (filter.type) { clauses.push('type = ?'); params.push(filter.type); }
    if (filter.id) { clauses.push('id = ?'); params.push(filter.id); }
    return this.db.run(
      `UPDATE jobs SET status = 'cancelled', updated = ? WHERE ${clauses.join(' AND ')}`,
      now, ...(params as any[]),
    ).changes;
  }

  due(now: number, limit = 100): JobRow[] {
    const scope = this.orgId ? 'AND org_id = ?' : '';
    const params = this.orgId ? [now, this.orgId, limit] : [now, limit];
    return this.db
      .all<any>(`SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ${scope} ORDER BY run_at ASC, rowid ASC LIMIT ?`, ...params)
      .map((r) => ({ ...r, payload: parseJson(r.payload, {}) }));
  }

  pendingCount(): number {
    return this.orgId
      ? this.db.count(`SELECT COUNT(*) FROM jobs WHERE status = 'pending' AND org_id = ?`, this.orgId)
      : this.db.count(`SELECT COUNT(*) FROM jobs WHERE status = 'pending'`);
  }

  /**
   * Every workspace with work waiting, oldest first.
   *
   * Whether a pending job is *due* depends on its own workspace's clock, so a
   * process-wide ticker cannot ask one question of the whole table: it has to
   * ask each workspace separately, under that workspace's scope. This is the
   * list it walks. An unscoped view sees every workspace; a scoped one sees at
   * most its own, so a caller cannot widen its reach by going through here.
   */
  pendingOrgIds(): string[] {
    const rows = this.orgId
      ? this.db.all<{ org_id: string }>(
        `SELECT DISTINCT org_id FROM jobs WHERE status = 'pending' AND org_id = ?`, this.orgId)
      : this.db.all<{ org_id: string }>(
        `SELECT org_id FROM jobs WHERE status = 'pending' GROUP BY org_id ORDER BY MIN(run_at) ASC`);
    return rows.map((r) => r.org_id);
  }

  /** When the next job this view can see becomes due, or null if there is none. */
  nextRunAt(): number | null {
    const next = this.orgId
      ? this.db.pluck<number>(`SELECT MIN(run_at) FROM jobs WHERE status = 'pending' AND org_id = ?`, this.orgId)
      : this.db.pluck<number>(`SELECT MIN(run_at) FROM jobs WHERE status = 'pending'`);
    return next ?? null;
  }

  /** Run every job due at `now`, including jobs enqueued by those jobs. */
  async drain(now: () => number, opts: { maxPasses?: number; batch?: number } = {}): Promise<{ ran: number; failed: number }> {
    let ran = 0, failed = 0;
    const maxPasses = opts.maxPasses ?? 50;
    for (let pass = 0; pass < maxPasses; pass++) {
      const batch = this.due(now(), opts.batch ?? 100);
      if (!batch.length) break;
      for (const job of batch) {
        const outcome = await this.runOne(job, now());
        if (outcome === 'ok') ran++; else if (outcome === 'failed') failed++;
      }
    }
    return { ran, failed };
  }

  async runOne(job: JobRow, now: number): Promise<'ok' | 'retry' | 'failed' | 'skipped'> {
    // A view scoped to one workspace refuses another's work even when handed
    // the row directly, so no caller can drain across the tenant boundary by
    // passing a job it fetched itself.
    if (this.orgId && job.org_id !== this.orgId) return 'skipped';
    const attempts = job.attempts + 1;

    // Claim the row before doing anything with it. `due()` and this call are not
    // one transaction, so two drains racing the same batch would otherwise both
    // run the same job — which for a renewal means two invoices for one period.
    // The UPDATE ... WHERE status = 'pending' is the claim: exactly one caller
    // can see `changes === 1`, and everyone else must leave the job alone.
    const claimed = this.db.run(
      `UPDATE jobs SET status = 'running', attempts = ?, updated = ? WHERE id = ? AND status = 'pending'`,
      attempts, now, job.id,
    ).changes;
    if (claimed !== 1) return 'skipped';

    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.db.patch('jobs', 'id', job.id, { status: 'failed', last_error: `No handler registered for job type "${job.type}"`, updated: now });
      this.log.error('job.no_handler', { type: job.type, id: job.id });
      return 'failed';
    }
    try {
      await handler(job.payload, job);
      this.db.patch('jobs', 'id', job.id, { status: 'done', updated: now, last_error: null });
      return 'ok';
    } catch (e) {
      const message = e instanceof Error ? `${e.message}` : String(e);
      if (attempts >= job.max_attempts) {
        this.db.patch('jobs', 'id', job.id, { status: 'failed', last_error: message, updated: now });
        this.log.error('job.failed', { type: job.type, id: job.id, attempts, error: message });
        return 'failed';
      }
      const schedule = this.backoffs.get(job.type);
      const delay = schedule ? schedule[Math.min(attempts - 1, schedule.length - 1)] : Math.min(2 ** attempts, 3600) * 1000;
      this.db.patch('jobs', 'id', job.id, { status: 'pending', run_at: now + delay, last_error: message, updated: now });
      this.log.warn('job.retry', { type: job.type, id: job.id, attempts, in_ms: delay, error: message });
      return 'retry';
    }
  }

  stats(): { pending: number; running: number; failed: number; done: number; nextRunAt: number | null } {
    const rows = this.orgId
      ? this.db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) as n FROM jobs WHERE org_id = ? GROUP BY status`, this.orgId)
      : this.db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) as n FROM jobs GROUP BY status`);
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    return {
      pending: by.pending ?? 0, running: by.running ?? 0, failed: by.failed ?? 0, done: by.done ?? 0,
      nextRunAt: this.nextRunAt(),
    };
  }
}
