import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/server/kernel/db';
import { JobQueue } from '../src/server/kernel/jobs';
import { createLogger } from '../src/server/kernel/logger';
import { CORE_MIGRATIONS } from '../src/server/kernel/core-schema';

function queue() {
  const db = new Db(':memory:');
  db.migrate(CORE_MIGRATIONS, 0);
  return { db, jobs: new JobQueue(db, createLogger({ level: 'error' })) };
}

describe('a job is claimed, not merely observed', () => {
  test('two drains racing the same due batch run the handler exactly once', async () => {
    const { db, jobs } = queue();
    let ran = 0;
    jobs.handle('renew', () => { ran += 1; });
    jobs.enqueue('org_1', 'renew', { subscription: 'sub_1' }, 0);

    // Both callers snapshot the queue before either runs anything — exactly what
    // two concurrent ticks, or two /v1/time/advance calls, do to each other.
    const batchA = jobs.due(0);
    const batchB = jobs.due(0);
    assert.equal(batchA.length, 1);
    assert.equal(batchB.length, 1, 'both callers see the same pending job');

    const outcomeA = await jobs.runOne(batchA[0], 0);
    const outcomeB = await jobs.runOne(batchB[0], 0);

    assert.equal(ran, 1, 'the handler must run once, or the subscription bills twice for one period');
    assert.deepEqual([outcomeA, outcomeB].sort(), ['ok', 'skipped']);
    assert.equal(db.count(`SELECT COUNT(*) FROM jobs WHERE status = 'done'`), 1);
    db.close();
  });

  test('a job already running is never picked up a second time', async () => {
    const { db, jobs } = queue();
    let ran = 0;
    jobs.handle('slow', async () => { ran += 1; });
    jobs.enqueue('org_1', 'slow', {}, 0);
    const [job] = jobs.due(0);

    db.run(`UPDATE jobs SET status = 'running' WHERE id = ?`, job.id);
    assert.equal(await jobs.runOne(job, 0), 'skipped');
    assert.equal(ran, 0, 'a job another worker holds must not be run');
    db.close();
  });

  test('a claimed job still counts its attempt, so retries terminate', async () => {
    const { db, jobs } = queue();
    jobs.handle('flaky', () => { throw new Error('nope'); });
    jobs.enqueue('org_1', 'flaky', {}, 0, { maxAttempts: 2 });

    const [first] = jobs.due(0);
    assert.equal(await jobs.runOne(first, 0), 'retry');
    assert.equal(db.pluck<number>(`SELECT attempts FROM jobs WHERE id = ?`, first.id), 1);

    const [second] = jobs.due(10_000_000);
    assert.equal(await jobs.runOne(second, 10_000_000), 'failed');
    assert.equal(db.pluck<number>(`SELECT attempts FROM jobs WHERE id = ?`, first.id), 2);
    db.close();
  });

  test('an unhandled job type fails the claim it took, and only that claim', async () => {
    const { db, jobs } = queue();
    jobs.enqueue('org_1', 'nobody.handles.this', {}, 0);
    const [job] = jobs.due(0);
    assert.equal(await jobs.runOne(job, 0), 'failed');
    assert.equal(await jobs.runOne(job, 0), 'skipped', 'a failed job is not pending, so it cannot be re-claimed');
    db.close();
  });
});
