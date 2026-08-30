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
  private handlers = new Map<string, JobHandler>();
  private backoffs = new Map<string, number[]>();

  constructor(private readonly db: Db, private readonly log: Logger) {}

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
    return this.db
      .all<any>(`SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC, rowid ASC LIMIT ?`, now, limit)
      .map((r) => ({ ...r, payload: parseJson(r.payload, {}) }));
  }

  pendingCount(): number { return this.db.count(`SELECT COUNT(*) FROM jobs WHERE status = 'pending'`); }

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
    const handler = this.handlers.get(job.type);
    const attempts = job.attempts + 1;
    if (!handler) {
      this.db.patch('jobs', 'id', job.id, { status: 'failed', last_error: `No handler registered for job type "${job.type}"`, attempts, updated: now });
      this.log.error('job.no_handler', { type: job.type, id: job.id });
      return 'failed';
    }
    this.db.patch('jobs', 'id', job.id, { status: 'running', attempts, updated: now });
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
    const rows = this.db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) as n FROM jobs GROUP BY status`);
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    const next = this.db.pluck<number>(`SELECT MIN(run_at) FROM jobs WHERE status = 'pending'`);
    return {
      pending: by.pending ?? 0, running: by.running ?? 0, failed: by.failed ?? 0, done: by.done ?? 0,
      nextRunAt: next ?? null,
    };
  }
}
