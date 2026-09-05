import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, frozenClock, type App } from '../src/server/app';
import type { Auth } from '../src/server/kernel/http';
import { DAY, HOUR, MINUTE, startOfDay } from '../src/shared/time';
import { microToDecimal, microToWholeUnits, parseMicro, toMicro } from '../src/server/modules/metering/units';
import { unitsWorthBurning } from '../src/server/modules/credits/burn';
import type { BatchResult, MeterEventInput } from '../src/server/modules/metering/types';

const ORG = 'org_demo';
const DANA: Auth = { kind: 'session', orgId: ORG, userId: 'usr_seed01', role: 'owner', scopes: ['*'], livemode: true };
/** A Tuesday, so weekday-shaped fixtures read naturally. */
const T0 = Date.UTC(2026, 5, 2, 9, 17, 34, 512);

let app: App;
const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, body, auth: DANA });

async function expectOk(method: string, path: string, body?: unknown): Promise<any> {
  const res = await call(method, path, body);
  assert.ok(res.status < 400, `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function expectError(method: string, path: string, body: unknown, status: number, code?: string): Promise<any> {
  const res = await call(method, path, body);
  assert.equal(res.status, status, `${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  if (code) assert.equal(res.body.error.code, code, JSON.stringify(res.body));
  return res.body.error;
}

before(async () => {
  app = await createApp({ db: 'memory', clock: frozenClock(T0), config: { env: 'test' } });
});
after(() => app.close());

const svc = () => app.ctx.svc.metering;

let meterSeq = 0;
const uniqueName = (prefix: string) => `${prefix}_${(meterSeq++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/* ------------------------------ exact values ------------------------------ */

describe('meter values are exact', () => {
  test('decimal strings round-trip through micro-units without float drift', () => {
    for (const raw of ['0', '1', '0.1', '0.000001', '12.345678', '999999999', '0.3']) {
      assert.equal(microToDecimal(toMicro(raw)), raw === '999999999' ? '999999999' : raw);
    }
    // The classic float trap: 0.1 + 0.2 must be exactly 0.3.
    assert.equal(microToDecimal(toMicro('0.1') + toMicro('0.2')), '0.3');
  });

  test('a seventh decimal place is refused rather than silently truncated', () => {
    assert.throws(() => toMicro('1.0000001'), /at most 6 decimal places/);
  });

  test('billable quantity rounds half-up exactly once', () => {
    assert.equal(microToWholeUnits(parseMicro('12.5')), 13);
    assert.equal(microToWholeUnits(parseMicro('12.499999')), 12);
    assert.equal(microToWholeUnits(parseMicro('0.5')), 1);
  });

  test('a sum wider than a double stays exact', () => {
    // 2^53 micro-units is only ~9e9 units; a busy year can pass it.
    const big = parseMicro('9007199254.740993');
    assert.equal(microToDecimal(big + parseMicro('0.000001')), '9007199254.740994');
  });
});

/* ------------------------------- exactly once ----------------------------- */

describe('ingestion is exactly once', () => {
  test('10,000 events with 30% duplicate identifiers produce exactly the unique count', async () => {
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Exactly-once probe', event_name: uniqueName('once'), aggregation: 'sum', value_key: 'events',
    });
    const customer = 'cus_probe_once';
    const at = T0 - 2 * HOUR;

    // 7,000 distinct identifiers, each carrying a distinct value.
    const originals: MeterEventInput[] = [];
    for (let i = 0; i < 7000; i++) {
      originals.push({
        event_name: meter.event_name, identifier: `once_${i}`, timestamp: at + (i % 60) * MINUTE,
        payload: { customer_id: customer, events: i + 1 },
      });
    }
    // 3,000 replays of the first 3,000 identifiers, deliberately carrying the
    // wrong value: if a replay were applied, the total would move.
    const replays: MeterEventInput[] = [];
    for (let i = 0; i < 3000; i++) {
      replays.push({
        event_name: meter.event_name, identifier: `once_${i}`, timestamp: at + (i % 60) * MINUTE,
        payload: { customer_id: customer, events: 999_999 },
      });
    }

    let recorded = 0, duplicates = 0, errors = 0;
    for (const chunk of chunks([...originals, ...replays], 1000)) {
      const batch: BatchResult = await expectOk('POST', '/v1/meter-events/batch', { events: chunk });
      recorded += batch.recorded;
      duplicates += batch.duplicates;
      errors += batch.errors;
      assert.equal(batch.results.length, chunk.length, 'every submitted event gets a result at its own index');
    }
    assert.equal(recorded, 7000);
    assert.equal(duplicates, 3000);
    assert.equal(errors, 0);

    const rows = app.ctx.db.count(`SELECT COUNT(*) FROM meter_events WHERE org_id = ? AND meter_id = ?`, ORG, meter.id);
    assert.equal(rows, 7000, 'a replay writes no row');

    const usage = svc().usageForPeriod(ORG, meter.id, customer, at - HOUR, T0);
    const expected = (7000 * 7001) / 2; // the sum of the 7,000 distinct values
    assert.equal(usage.value, expected);
    assert.equal(usage.event_count, 7000);
  });

  test('a replayed identifier returns the original event, not a new one', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Replay probe', event_name: uniqueName('replay') });
    const body = {
      event_name: meter.event_name, identifier: 'replay-me',
      payload: { customer_id: 'cus_replay', value: 42 },
    };
    const first = await call('POST', '/v1/meter-events', body);
    assert.equal(first.status, 201);
    assert.equal(first.body.outcome, 'recorded');

    const second = await call('POST', '/v1/meter-events', { ...body, payload: { customer_id: 'cus_replay', value: 9999 } });
    assert.equal(second.status, 200, 'a replay is a read, not a create');
    assert.equal(second.body.outcome, 'duplicate');
    assert.equal(second.body.event.id, first.body.event.id);
    assert.equal(second.body.event.value, 42, 'the original value is what comes back');

    const usage = svc().usageForPeriod(ORG, meter.id, 'cus_replay', T0 - HOUR, T0 + HOUR);
    assert.equal(usage.value, 42);
  });

  test('an identifier is unique across the workspace, not per meter', async () => {
    const a = await expectOk('POST', '/v1/meters', { name: 'Scope A', event_name: uniqueName('scope_a') });
    const b = await expectOk('POST', '/v1/meters', { name: 'Scope B', event_name: uniqueName('scope_b') });
    await expectOk('POST', '/v1/meter-events', {
      event_name: a.event_name, identifier: 'shared-identifier', payload: { customer_id: 'cus_scope', value: 5 },
    });
    const res = await call('POST', '/v1/meter-events', {
      event_name: b.event_name, identifier: 'shared-identifier', payload: { customer_id: 'cus_scope', value: 5 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'duplicate');
    assert.equal(res.body.event.meter, a.id, 'the original event is returned, whichever meter it belonged to');
  });
});

/* --------------------------------- batches -------------------------------- */

describe('batch ingestion', () => {
  test('one bad event does not reject the batch around it', async () => {
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Partial batch', event_name: uniqueName('partial'), value_key: 'events',
    });
    const good = (i: number): MeterEventInput => ({
      event_name: meter.event_name, identifier: `partial_${i}`, payload: { customer_id: 'cus_partial', events: 10 },
    });
    const batch: BatchResult = await expectOk('POST', '/v1/meter-events/batch', {
      events: [
        good(1),
        { event_name: meter.event_name, identifier: 'partial_missing_customer', payload: { events: 10 } },
        good(2),
        { event_name: meter.event_name, identifier: 'partial_no_value', payload: { customer_id: 'cus_partial' } },
        good(3),
        { event_name: meter.event_name, identifier: 'partial_too_old', timestamp: T0 - 90 * DAY, payload: { customer_id: 'cus_partial', events: 10 } },
        good(1), // a replay inside the same batch
      ],
    });
    assert.equal(batch.recorded, 3);
    assert.equal(batch.duplicates, 1);
    assert.equal(batch.errors, 3);
    assert.deepEqual(batch.results.map((r) => r.outcome), ['recorded', 'error', 'recorded', 'error', 'recorded', 'error', 'duplicate']);
    assert.equal(batch.results[1].error?.code, 'meter_event_customer_missing');
    assert.equal(batch.results[3].error?.code, 'meter_event_value_missing');
    assert.equal(batch.results[5].error?.code, 'meter_event_timestamp_too_old');
    assert.match(batch.results[1].error?.message ?? '', /customer_id/, 'the error names the payload key it looked in');

    const usage = svc().usageForPeriod(ORG, meter.id, 'cus_partial', T0 - HOUR, T0 + HOUR);
    assert.equal(usage.value, 30, 'only the three good events landed');
  });

  test('a batch over the limit is refused as a whole, with the limit in the message', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Oversized', event_name: uniqueName('oversized') });
    const events = Array.from({ length: 1001 }, (_, i) => ({
      event_name: meter.event_name, identifier: `oversized_${i}`, payload: { customer_id: 'cus_x', value: 1 },
    }));
    const error = await expectError('POST', '/v1/meter-events/batch', { events }, 400);
    assert.match(error.message, /at most 1000 items/);
  });
});

/* ------------------------------- aggregations ----------------------------- */

describe('aggregations across period boundaries', () => {
  const periodA = { start: Date.UTC(2026, 4, 1), end: Date.UTC(2026, 5, 1) };
  const periodB = { start: Date.UTC(2026, 5, 1), end: Date.UTC(2026, 6, 1) };

  test('max is the peak inside the period, not the peak overall', async () => {
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Peak robots', event_name: uniqueName('peak'), aggregation: 'max', value_key: 'robots', unit_label: 'robot',
    });
    const customer = 'cus_peak';
    await ingest([
        // May: peaks at 180 mid-month.
        { event_name: meter.event_name, identifier: 'peak_a1', timestamp: periodA.start + 2 * DAY, payload: { customer_id: customer, robots: 120 } },
        { event_name: meter.event_name, identifier: 'peak_a2', timestamp: periodA.start + 15 * DAY, payload: { customer_id: customer, robots: 180 } },
        { event_name: meter.event_name, identifier: 'peak_a3', timestamp: periodA.end - MINUTE, payload: { customer_id: customer, robots: 90 } },
        // June: a bigger fleet, which must not leak backwards into May.
        { event_name: meter.event_name, identifier: 'peak_b1', timestamp: periodB.start + HOUR, payload: { customer_id: customer, robots: 240 } },
        { event_name: meter.event_name, identifier: 'peak_b2', timestamp: periodB.start + 12 * HOUR, payload: { customer_id: customer, robots: 205 } },
    ]);
    assert.equal(svc().usageForPeriod(ORG, meter.id, customer, periodA.start, periodA.end).value, 180);
    assert.equal(svc().usageForPeriod(ORG, meter.id, customer, periodB.start, periodB.end).value, 240);
    assert.equal(svc().usageForPeriod(ORG, meter.id, customer, periodA.start, periodB.end).value, 240);
    // A window that starts and ends mid-hour still has to be right.
    const partial = svc().usageForPeriod(ORG, meter.id, customer, periodA.start + 15 * DAY - 30 * MINUTE, periodA.start + 15 * DAY + 30 * MINUTE);
    assert.equal(partial.value, 180);
    assert.ok(partial.provenance.partial_leading_hour && partial.provenance.partial_trailing_hour);
  });

  test('last is the closing reading of the period, whatever order events arrive in', async () => {
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Stored volume', event_name: uniqueName('stored'), aggregation: 'last', value_key: 'gigabytes', unit_label: 'GB',
    });
    const customer = 'cus_last';
    await ingest([
        { event_name: meter.event_name, identifier: 'last_a1', timestamp: periodA.start + DAY, payload: { customer_id: customer, gigabytes: 400 } },
        { event_name: meter.event_name, identifier: 'last_a3', timestamp: periodA.end - HOUR, payload: { customer_id: customer, gigabytes: 512.75 } },
        { event_name: meter.event_name, identifier: 'last_b1', timestamp: periodB.start + 20 * HOUR, payload: { customer_id: customer, gigabytes: 640 } },
    ]);
    assert.equal(svc().usageForPeriod(ORG, meter.id, customer, periodA.start, periodA.end).value, 512.75);
    assert.equal(svc().usageForPeriod(ORG, meter.id, customer, periodB.start, periodB.end).value, 640);

    // A reading that arrives late but is timestamped earlier must not become
    // the closing reading — it is only the latest one that counts.
    await expectOk('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'last_a2', timestamp: periodA.end - 10 * DAY,
      payload: { customer_id: customer, gigabytes: 470 },
    });
    assert.equal(svc().usageForPeriod(ORG, meter.id, customer, periodA.start, periodA.end).value, 512.75);

    // A reading timestamped after the current closing one does replace it.
    await expectOk('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'last_a4', timestamp: periodA.end - MINUTE,
      payload: { customer_id: customer, gigabytes: 519 },
    });
    assert.equal(svc().usageForPeriod(ORG, meter.id, customer, periodA.start, periodA.end).value, 519);
    assert.equal(svc().usageForPeriod(ORG, meter.id, customer, periodB.start, periodB.end).value, 640, 'June is untouched');
  });

  test('unique counts distinct subjects per period, not events', async () => {
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Active operators', event_name: uniqueName('ops'), aggregation: 'unique', unique_key: 'operator_id', unit_label: 'seat',
    });
    const customer = 'cus_unique';
    const events: MeterEventInput[] = [];
    // Three operators signing in repeatedly through May, one new one in June.
    for (let day = 0; day < 20; day++) {
      for (const operator of ['op_1', 'op_2', 'op_3']) {
        events.push({
          event_name: meter.event_name, identifier: `ops_${day}_${operator}`,
          timestamp: periodA.start + day * DAY + 9 * HOUR,
          payload: { customer_id: customer, operator_id: operator },
        });
      }
    }
    events.push({
      event_name: meter.event_name, identifier: 'ops_june_new', timestamp: periodB.start + 12 * HOUR,
      payload: { customer_id: customer, operator_id: 'op_4' },
    });
    // An early shift on the first day: one operator already counted, one not.
    events.push({
      event_name: meter.event_name, identifier: 'ops_early_1', timestamp: periodA.start + 8 * HOUR + 45 * MINUTE,
      payload: { customer_id: customer, operator_id: 'op_1' },
    });
    events.push({
      event_name: meter.event_name, identifier: 'ops_early_5', timestamp: periodA.start + 8 * HOUR + 45 * MINUTE,
      payload: { customer_id: customer, operator_id: 'op_5' },
    });
    await ingest(events);

    assert.equal(svc().usageForPeriod(ORG, meter.id, customer, periodA.start, periodA.end).value, 4);
    assert.equal(svc().usageForPeriod(ORG, meter.id, customer, periodB.start, periodB.end).value, 1);
    assert.equal(svc().usageForPeriod(ORG, meter.id, customer, periodA.start, periodB.end).value, 5,
      'a subject seen in both months is still one subject');

    // A window whose leading hour is partial has to union the distinct subjects
    // read raw from that hour with the ones in the whole hours after it.
    const partial = svc().usageForPeriod(ORG, meter.id, customer, periodA.start + 8 * HOUR + 30 * MINUTE, periodA.start + 10 * HOUR);
    assert.equal(partial.provenance.partial_leading_hour, true);
    assert.equal(partial.provenance.partial_trailing_hour, false);
    assert.equal(partial.provenance.scanned_events, 2, 'only the partial hour is read raw');
    assert.equal(partial.provenance.summarized_hours, 1);
    assert.equal(partial.value, 4, 'op_1 is seen in both halves and counts once');

    // And a window entirely inside one hour never touches the pre-aggregate.
    const inside = svc().usageForPeriod(ORG, meter.id, customer, periodA.start + 8 * HOUR + 30 * MINUTE, periodA.start + 9 * HOUR);
    assert.equal(inside.value, 2);
    assert.equal(inside.provenance.summarized_hours, 0);
    assert.equal(inside.provenance.scanned_events, 2);
  });

  test('count ignores the value entirely', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Alerts', event_name: uniqueName('alerts'), aggregation: 'count' });
    assert.equal(meter.value_key, null, 'a count meter reads no value key');
    await ingest([1, 2, 3, 4].map((i) => ({
      event_name: meter.event_name, identifier: `alerts_${i}`, timestamp: periodA.start + i * DAY,
      payload: { customer_id: 'cus_count', severity: 'critical', anything: i * 1000 },
    })));
    assert.equal(svc().usageForPeriod(ORG, meter.id, 'cus_count', periodA.start, periodA.end).value, 4);
  });
});

/* ------------------------- backdating and the window ---------------------- */

describe('backdating', () => {
  test('an event inside the acceptance window updates the pending total', async () => {
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Backfill', event_name: uniqueName('backfill'), value_key: 'events',
      acceptance_window_ms: 10 * DAY,
    });
    const customer = 'cus_backfill';
    const periodStart = startOfDay(T0) - 20 * DAY;
    const periodEnd = startOfDay(T0) + 10 * DAY;

    await expectOk('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'backfill_live', timestamp: T0 - HOUR,
      payload: { customer_id: customer, events: 1000 },
    });
    const before = svc().usageForPeriod(ORG, meter.id, customer, periodStart, periodEnd);
    assert.equal(before.value, 1000);
    assert.equal(before.pending, true, 'the period is still open');

    // A gateway that was offline for a week catches up.
    await expectOk('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'backfill_late', timestamp: T0 - 7 * DAY,
      payload: { customer_id: customer, events: 4500 },
    });
    const after = svc().usageForPeriod(ORG, meter.id, customer, periodStart, periodEnd);
    assert.equal(after.value, 5500, 'the pending total moved');
    assert.equal(after.late_adjustment, null, 'nothing is late while the period is open');
  });

  test('an event outside the window is rejected with the window spelled out', async () => {
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Narrow window', event_name: uniqueName('narrow'), value_key: 'events', acceptance_window_ms: 10 * DAY,
    });
    const error = await expectError('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'narrow_too_old', timestamp: T0 - 11 * DAY,
      payload: { customer_id: 'cus_narrow', events: 1 },
    }, 400, 'meter_event_timestamp_too_old');
    assert.match(error.message, /10-day acceptance window/);
    assert.match(error.message, /already been invoiced/);
    assert.equal(error.param, 'timestamp');
    assert.equal(error.detail.earliest_acceptable, T0 - 10 * DAY);

    assert.equal(
      app.ctx.db.count(`SELECT COUNT(*) FROM meter_events WHERE org_id = ? AND meter_id = ?`, ORG, meter.id),
      0, 'a rejected event leaves nothing behind',
    );
  });

  test('an event from the future is rejected too', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Clock skew', event_name: uniqueName('skew') });
    const error = await expectError('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'skew_1', timestamp: T0 + 2 * HOUR,
      payload: { customer_id: 'cus_skew', value: 1 },
    }, 400, 'meter_event_timestamp_in_future');
    assert.match(error.message, /clock/);
  });
});

/* ----------------------- closed periods and late usage -------------------- */

describe('closed periods', () => {
  test('usage that lands after a period is billed is reported, not dropped', async () => {
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Closed period', event_name: uniqueName('closed'), value_key: 'events', acceptance_window_ms: 60 * DAY,
    });
    const customer = 'cus_closed';
    const periodStart = Date.UTC(2026, 4, 1);
    const periodEnd = Date.UTC(2026, 5, 1);
    await ingest([
        { event_name: meter.event_name, identifier: 'closed_1', timestamp: periodStart + 3 * DAY, payload: { customer_id: customer, events: 2000 } },
        { event_name: meter.event_name, identifier: 'closed_2', timestamp: periodStart + 20 * DAY, payload: { customer_id: customer, events: 3000 } },
    ]);

    const closure = await expectOk('POST', `/v1/meters/${meter.id}/close-period`, {
      customer, period_start: periodStart, period_end: periodEnd, ref_type: 'invoice', ref_id: 'in_test_closed',
    });
    assert.equal(closure.total, 5000);
    assert.equal(closure.event_count, 2);

    // The gateway finally uploads the shift it missed.
    const late = await expectOk('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'closed_late', timestamp: periodStart + 25 * DAY,
      payload: { customer_id: customer, events: 750 },
    });
    assert.equal(late.event.late, true, 'the event is accepted and flagged');
    assert.ok(late.late_arrival, 'and it is reported');
    assert.equal(late.late_arrival.value, 750);
    assert.equal(late.late_arrival.resolution, 'open');

    const usage = svc().usageForPeriod(ORG, meter.id, customer, periodStart, periodEnd);
    assert.equal(usage.value, 5750, 'the live total includes it');
    assert.equal(usage.closed?.total, 5000, 'the billed total does not move');
    assert.equal(usage.late_adjustment?.value, 750, 'and the difference is stated');
    assert.equal(usage.late_adjustment?.event_count, 1);

    const open = await expectOk('GET', `/v1/meter-late-arrivals?customer=${customer}&resolution=open`);
    assert.equal(open.data.length, 1);
    // Nothing priced this period, so there is nothing to re-price the drift
    // against — and the refusal says exactly that instead of writing a word.
    const unpriceable = await expectError('POST', `/v1/meter-late-arrivals/${open.data[0].id}/resolve`, {
      resolution: 'rebilled',
    }, 400, 'parameter_missing');
    assert.match(unpriceable.message, /frozen without a price/);

    // The old shape — a free-text `ref` — says what replaced it rather than
    // failing with a generic "unknown parameter".
    const stale = await expectError('POST', `/v1/meter-late-arrivals/${open.data[0].id}/resolve`,
      { resolution: 'ignored', ref: 'in_test_trueup' }, 400, 'parameter_unsupported');
    assert.match(stale.message, /written by the platform/);

    const resolved = await expectOk('POST', `/v1/meter-late-arrivals/${open.data[0].id}/resolve`, {
      resolution: 'ignored', note: 'Absorbed — the gateway backfill was our own outage.',
    });
    assert.equal(resolved.resolution, 'ignored');
    assert.equal(resolved.amount, 0, 'an ignored entry moves no money, and says so as a number');
    assert.equal(resolved.note, 'Absorbed — the gateway backfill was our own outage.');
    const stillOpen = await expectOk('GET', `/v1/meter-late-arrivals?customer=${customer}&resolution=open`);
    assert.equal(stillOpen.data.length, 0);
  });

  test('closing a period twice returns the first closure', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Idempotent close', event_name: uniqueName('reclose'), value_key: 'events' });
    const customer = 'cus_reclose';
    const periodStart = Date.UTC(2026, 4, 1);
    const periodEnd = Date.UTC(2026, 5, 1);
    await expectOk('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'reclose_1', timestamp: periodStart + DAY,
      payload: { customer_id: customer, events: 100 },
    });
    const first = await expectOk('POST', `/v1/meters/${meter.id}/close-period`, { customer, period_start: periodStart, period_end: periodEnd });
    await expectOk('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'reclose_2', timestamp: periodStart + 2 * DAY,
      payload: { customer_id: customer, events: 900 },
    });
    const second = await expectOk('POST', `/v1/meters/${meter.id}/close-period`, { customer, period_start: periodStart, period_end: periodEnd });
    assert.equal(second.id, first.id);
    assert.equal(second.total, 100, 'the billed total is what it was when the invoice was cut');
  });

  test('a close whose boundary has moved is a conflict, not a second closure', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Overlapping close', event_name: uniqueName('overlap'), value_key: 'events' });
    const customer = 'cus_overlap_close';
    const periodStart = Date.UTC(2026, 4, 1);
    const periodEnd = Date.UTC(2026, 5, 1);
    await expectOk('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'overlap_1', timestamp: periodStart + DAY,
      payload: { customer_id: customer, events: 100 },
    });
    const first = await expectOk('POST', `/v1/meters/${meter.id}/close-period`, { customer, period_start: periodStart, period_end: periodEnd });

    // One millisecond of drift used to mint a second closure over the same
    // usage, each believing it was the one that billed it.
    const error = await expectError('POST', `/v1/meters/${meter.id}/close-period`, {
      customer, period_start: periodStart, period_end: periodEnd + 1,
    }, 409, 'meter_period_overlaps_closure');
    assert.match(error.message, new RegExp(first.id));
    assert.equal(error.detail.closure, first.id);

    // A window merely touching the first one at the boundary is fine: half-open
    // periods that share an instant do not overlap.
    const next = await expectOk('POST', `/v1/meters/${meter.id}/close-period`, {
      customer, period_start: periodEnd, period_end: Date.UTC(2026, 6, 1),
    });
    assert.notEqual(next.id, first.id);

    const closures = await expectOk('GET', `/v1/meter-period-closures?meter=${meter.id}&customer=${customer}`);
    assert.equal(closures.data.length, 2, 'two adjacent periods, never two overlapping ones');
  });
});

/* --------------------------- withdrawing an event ------------------------- */

describe('an event that should never have been recorded can be unsaid', () => {
  const hourOf = (ts: number) => Math.floor(ts / HOUR) * HOUR;
  const HOUR_START = hourOf(T0 - 3 * HOUR);
  const at = (minutes: number) => HOUR_START + minutes * MINUTE;

  const usageOf = (meterId: string, customer: string) =>
    expectOk('GET', `/v1/meters/${meterId}/usage?customer=${customer}&start=${HOUR_START}&end=${HOUR_START + HOUR}`);

  test('a fat-fingered value leaves the total, and its identifier stays claimed', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Cancel sum', event_name: uniqueName('cx_sum'), value_key: 'v' });
    const customer = 'cus_cancel_sum';
    await ingest([
      { event_name: meter.event_name, identifier: 'cx_a', timestamp: at(1), payload: { customer_id: customer, v: 100 } },
      { event_name: meter.event_name, identifier: 'cx_b', timestamp: at(2), payload: { customer_id: customer, v: 1_000_000_000 } },
      { event_name: meter.event_name, identifier: 'cx_c', timestamp: at(3), payload: { customer_id: customer, v: 40 } },
    ]);
    assert.equal((await usageOf(meter.id, customer)).value_decimal, '1000000140');

    const adjustment = await expectOk('POST', '/v1/meter-event-adjustments', {
      cancel: { identifier: 'cx_b' }, event_name: meter.event_name, reason: 'the gateway sent bytes, not events',
    });
    assert.equal(adjustment.object, 'meter_event_adjustment');
    assert.equal(adjustment.value_decimal, '-1000000000', 'the adjustment states what it took back out');

    const after = await usageOf(meter.id, customer);
    assert.equal(after.value_decimal, '140');
    assert.equal(after.event_count, 2);

    // The compensating shape: the event survives, so exactly-once still holds.
    const replay = await call('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'cx_b', timestamp: at(2), payload: { customer_id: customer, v: 1_000_000_000 },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.outcome, 'duplicate');
    assert.equal(replay.body.event.cancelled, true);
    assert.equal((await usageOf(meter.id, customer)).value_decimal, '140', 'a replay cannot resurrect it');

    const listed = await expectOk(`GET`, `/v1/meter-events?meter=${meter.id}&customer=${customer}`);
    assert.deepEqual(listed.data.map((e: { identifier: string }) => e.identifier).sort(), ['cx_a', 'cx_c']);
    const withdrawn = await expectOk('GET', `/v1/meter-events?meter=${meter.id}&customer=${customer}&cancelled=true`);
    assert.deepEqual(withdrawn.data.map((e: { identifier: string }) => e.identifier), ['cx_b']);
  });

  test('cancelling twice is the same as cancelling once', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Cancel twice', event_name: uniqueName('cx_twice'), value_key: 'v' });
    await expectOk('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'cx_once', timestamp: at(4), payload: { customer_id: 'cus_twice', v: 9 },
    });
    const first = await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: 'cx_once' } });
    const second = await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: 'cx_once' } });
    assert.equal(second.id, first.id, 'a retried cancel is a read');
    assert.equal((await usageOf(meter.id, 'cus_twice')).value_decimal, '0');
    const all = await expectOk('GET', `/v1/meter-event-adjustments?meter=${meter.id}`);
    assert.equal(all.data.length, 1, 'and it unfolds the hour exactly once');
  });

  test('max and last fall back to the readings that survive, not to arithmetic', async () => {
    const peak = await expectOk('POST', '/v1/meters', { name: 'Cancel max', event_name: uniqueName('cx_max'), aggregation: 'max', value_key: 'v' });
    await ingest([
      { event_name: peak.event_name, identifier: 'cxm_1', timestamp: at(1), payload: { customer_id: 'cus_peak', v: 5 } },
      { event_name: peak.event_name, identifier: 'cxm_2', timestamp: at(2), payload: { customer_id: 'cus_peak', v: 90 } },
      { event_name: peak.event_name, identifier: 'cxm_3', timestamp: at(3), payload: { customer_id: 'cus_peak', v: 7 } },
    ]);
    assert.equal((await usageOf(peak.id, 'cus_peak')).value, 90);
    await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: 'cxm_2' } });
    assert.equal((await usageOf(peak.id, 'cus_peak')).value, 7, 'the next-highest surviving reading, not 90 minus 90');

    const closing = await expectOk('POST', '/v1/meters', { name: 'Cancel last', event_name: uniqueName('cx_last'), aggregation: 'last', value_key: 'v' });
    await ingest([
      { event_name: closing.event_name, identifier: 'cxl_1', timestamp: at(1), payload: { customer_id: 'cus_last', v: 5 } },
      { event_name: closing.event_name, identifier: 'cxl_2', timestamp: at(2), payload: { customer_id: 'cus_last', v: 9 } },
      { event_name: closing.event_name, identifier: 'cxl_3', timestamp: at(3), payload: { customer_id: 'cus_last', v: 42 } },
    ]);
    assert.equal((await usageOf(closing.id, 'cus_last')).value, 42);
    await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: 'cxl_3' } });
    assert.equal((await usageOf(closing.id, 'cus_last')).value, 9, 'the reading before it becomes the closing one');
  });

  test('a distinct subject is only lost when no surviving event carries it', async () => {
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Cancel unique', event_name: uniqueName('cx_uniq'), aggregation: 'unique', unique_key: 'operator_id',
    });
    await ingest([
      { event_name: meter.event_name, identifier: 'cxu_1', timestamp: at(1), payload: { customer_id: 'cus_uniq', operator_id: 'A' } },
      { event_name: meter.event_name, identifier: 'cxu_2', timestamp: at(2), payload: { customer_id: 'cus_uniq', operator_id: 'B' } },
      { event_name: meter.event_name, identifier: 'cxu_3', timestamp: at(3), payload: { customer_id: 'cus_uniq', operator_id: 'B' } },
    ]);
    assert.equal((await usageOf(meter.id, 'cus_uniq')).value, 2);
    await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: 'cxu_2' } });
    assert.equal((await usageOf(meter.id, 'cus_uniq')).value, 2, 'B signed in twice; one withdrawal does not unsee them');
    await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: 'cxu_3' } });
    assert.equal((await usageOf(meter.id, 'cus_uniq')).value, 1);
  });

  test('a withdrawal inside a billed period files a negative true-up, it does not move the invoice', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Cancel billed', event_name: uniqueName('cx_billed'), value_key: 'v' });
    const customer = 'cus_cancel_billed';
    await ingest([
      { event_name: meter.event_name, identifier: 'cxb_1', timestamp: at(1), payload: { customer_id: customer, v: 60 } },
      { event_name: meter.event_name, identifier: 'cxb_2', timestamp: at(2), payload: { customer_id: customer, v: 40 } },
    ]);
    const closure = await expectOk('POST', `/v1/meters/${meter.id}/close-period`, {
      customer, period_start: HOUR_START, period_end: HOUR_START + HOUR, ref_type: 'invoice', ref_id: 'in_cancel_billed',
    });
    assert.equal(closure.total, 100);

    const adjustment = await expectOk('POST', '/v1/meter-event-adjustments', {
      cancel: { identifier: 'cxb_2' }, reason: 'the export job ran twice',
    });
    assert.equal(adjustment.closure, closure.id);

    const usage = await usageOf(meter.id, customer);
    assert.equal(usage.value, 60, 'the live total drops');
    assert.equal(usage.closed.total, 100, 'the number already invoiced does not');
    assert.equal(usage.late_adjustment.value, -40, 'and the difference is owed back');

    const queue = await expectOk('GET', `/v1/meter-late-arrivals?customer=${customer}&resolution=open`);
    assert.equal(queue.data.length, 1);
    assert.equal(queue.data[0].value, -40);
    assert.equal(queue.data[0].event, adjustment.event);
  });

  test('withdrawing a late arrival takes its own entry back out of the queue', async () => {
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Cancel late', event_name: uniqueName('cx_late'), value_key: 'v', acceptance_window_ms: 60 * DAY,
    });
    const customer = 'cus_cancel_late';
    await expectOk('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'cxlate_1', timestamp: at(1), payload: { customer_id: customer, v: 100 },
    });
    await expectOk('POST', `/v1/meters/${meter.id}/close-period`, {
      customer, period_start: HOUR_START, period_end: HOUR_START + HOUR,
    });
    const late = await expectOk('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'cxlate_2', timestamp: at(2), payload: { customer_id: customer, v: 25 },
    });
    assert.equal(late.late_arrival.value, 25);

    await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: 'cxlate_2' } });
    const usage = await usageOf(meter.id, customer);
    assert.equal(usage.value, 100, 'back to what was billed');
    assert.equal(usage.closed.adjustment, 0, 'the closure carries no outstanding movement');
    assert.equal(usage.closed.late_event_count, 0);
    assert.equal(usage.late_adjustment, null, 'so there is nothing left to true up');

    const withdrawn = await expectOk('GET', `/v1/meter-late-arrivals?customer=${customer}&resolution=withdrawn`);
    assert.equal(withdrawn.data.length, 1, 'the entry stays on record, marked withdrawn');
  });

  test('an unknown identifier is a 404 and a mismatched event name a 400', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Cancel errors', event_name: uniqueName('cx_err'), value_key: 'v' });
    await expectOk('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'cxe_1', timestamp: at(5), payload: { customer_id: 'cus_err', v: 1 },
    });
    await expectError('POST', '/v1/meter-event-adjustments', { cancel: { identifier: 'never_sent' } }, 404, 'resource_missing');
    const wrong = await expectError('POST', '/v1/meter-event-adjustments', {
      cancel: { identifier: 'cxe_1' }, event_name: 'some_other_meter',
    }, 400, 'parameter_invalid');
    assert.match(wrong.message, new RegExp(meter.event_name));
  });
});

/* -------------------- totals wider than a JavaScript number --------------- */

describe('a total that passes 2^53 stays readable', () => {
  /**
   * 10 GB metered as bytes in one hour. `sum_micro` lands at 1e16, past what a
   * double represents exactly — which used to make every read of that meter a
   * permanent 500 while ingestion went on cheerfully accepting more.
   */
  test('ten billion units in one hour ingest, read, close and read again', async () => {
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Egress bytes', event_name: uniqueName('egress'), value_key: 'bytes', unit_label: 'byte',
    });
    const customer = 'cus_ten_gb';
    const hour = Math.floor((T0 - 2 * HOUR) / HOUR) * HOUR;
    await ingest(Array.from({ length: 10_000 }, (_, i) => ({
      event_name: meter.event_name, identifier: `gb_${i}`, timestamp: hour + MINUTE,
      payload: { customer_id: customer, bytes: 1_000_000 },
    })));

    const usage = await expectOk('GET', `/v1/meters/${meter.id}/usage?customer=${customer}&start=${hour}&end=${hour + HOUR}`);
    assert.equal(usage.value_decimal, '10000000000');
    assert.equal(usage.billable_quantity, 10_000_000_000);

    const summaries = await expectOk('GET',
      `/v1/meters/${meter.id}/event-summaries?customer=${customer}&start=${hour}&end=${hour + HOUR}&granularity=hour`);
    assert.equal(summaries.data[0].value_decimal, '10000000000');

    const closure = await expectOk('POST', `/v1/meters/${meter.id}/close-period`, {
      customer, period_start: hour, period_end: hour + HOUR,
    });
    assert.equal(closure.total_decimal, '10000000000');

    // The reads that used to die the moment the closure row existed.
    const afterClose = await expectOk('GET', `/v1/meters/${meter.id}/usage?customer=${customer}&start=${hour}&end=${hour + HOUR}`);
    assert.equal(afterClose.closed.total_decimal, '10000000000');
    const listed = await expectOk('GET', `/v1/meter-period-closures?meter=${meter.id}&customer=${customer}`);
    assert.equal(listed.data[0].total_decimal, '10000000000');
  });

  test('a value that could not be read back is refused rather than accepted', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Ceiling', event_name: uniqueName('ceiling'), value_key: 'v' });
    const customer = 'cus_ceiling';
    const hour = Math.floor((T0 - 4 * HOUR) / HOUR) * HOUR;
    // 9.223372036854775807e12 units is the 64-bit ceiling in micro-units, so
    // 9,224 events of a billion units each is one event too many.
    await ingest(Array.from({ length: 9_223 }, (_, i) => ({
      event_name: meter.event_name, identifier: `ceil_${i}`, timestamp: hour + MINUTE,
      payload: { customer_id: customer, v: 1_000_000_000 },
    })));
    const usage = await expectOk('GET', `/v1/meters/${meter.id}/usage?customer=${customer}&start=${hour}&end=${hour + HOUR}`);
    assert.equal(usage.value_decimal, '9223000000000');

    const error = await expectError('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'ceil_over', timestamp: hour + MINUTE,
      payload: { customer_id: customer, v: 1_000_000_000 },
    }, 400, 'amount_out_of_range');
    assert.match(error.message, /largest value this platform stores exactly/);
    assert.equal(
      (await expectOk('GET', `/v1/meters/${meter.id}/usage?customer=${customer}&start=${hour}&end=${hour + HOUR}`)).value_decimal,
      '9223000000000',
      'and the refusal changed nothing',
    );
  });
});

/* ---------------------- the metered billing lifecycle --------------------- */

describe('a period that ends settles itself', () => {
  /**
   * The one thing a usage-billing engine cannot leave to a human. Billing says
   * a cycle turned over; every metered line on that event becomes a job.
   */
  test('an invoice due with an arrears period enqueues one settlement per metered line', async () => {
    const before = app.db.count(
      `SELECT COUNT(*) FROM jobs WHERE org_id = ? AND type = 'credits.settle_period'`, ORG);
    const periodStart = Date.UTC(2026, 3, 1);
    const periodEnd = Date.UTC(2026, 4, 1);
    app.ctx.emit(ORG, 'subscription.invoice_due', {
      subscription: 'sub_lifecycle_probe',
      customer: 'cus_lifecycle_probe',
      currency: 'usd',
      reason: 'subscription_cycle',
      period: { start: periodEnd, end: Date.UTC(2026, 5, 1) },
      arrears_period: { start: periodStart, end: periodEnd },
      lines: [
        { subscription_item: 'si_metered_probe', price: 'price_nw_telemetry_events', metered: true, amount: null },
        { subscription_item: 'si_flat_probe', price: 'price_flat_probe', metered: false, amount: 9900 },
      ],
    }, { objectId: 'sub_lifecycle_probe', objectType: 'subscription' });

    const jobs = app.db.all<{ idem_key: string; payload: string }>(
      `SELECT idem_key, payload FROM jobs WHERE org_id = ? AND type = 'credits.settle_period' AND status = 'pending'
       ORDER BY created DESC LIMIT 5`, ORG);
    assert.equal(
      app.db.count(`SELECT COUNT(*) FROM jobs WHERE org_id = ? AND type = 'credits.settle_period'`, ORG),
      before + 1,
      'the flat line is not a metered period',
    );
    const mine = jobs.find((j) => j.idem_key === `settle:si_metered_probe:${periodStart}:${periodEnd}`);
    assert.ok(mine, 'the job is keyed on the period, so a replayed billing run does not enqueue a second');
    const payload = JSON.parse(mine.payload) as { customer: string; price: string; period_end: number };
    assert.equal(payload.customer, 'cus_lifecycle_probe');
    assert.equal(payload.price, 'price_nw_telemetry_events');
    assert.equal(payload.period_end, periodEnd);

    // Replaying the same billing event must not queue the work twice.
    app.ctx.emit(ORG, 'subscription.invoice_due', {
      subscription: 'sub_lifecycle_probe', customer: 'cus_lifecycle_probe', currency: 'usd',
      arrears_period: { start: periodStart, end: periodEnd },
      lines: [{ subscription_item: 'si_metered_probe', price: 'price_nw_telemetry_events', metered: true, amount: null }],
    }, { objectId: 'sub_lifecycle_probe', objectType: 'subscription' });
    assert.equal(
      app.db.count(`SELECT COUNT(*) FROM jobs WHERE org_id = ? AND type = 'credits.settle_period'`, ORG),
      before + 1,
    );
  });

  test('a cancelled subscription still settles the part-period it used', async () => {
    const periodStart = Date.UTC(2026, 2, 1);
    const endedAt = Date.UTC(2026, 2, 18);
    app.ctx.emit(ORG, 'subscription.canceled', {
      id: 'sub_cancel_probe', customer: 'cus_cancel_probe', currency: 'usd', status: 'canceled',
      current_period_start: periodStart, current_period_end: Date.UTC(2026, 3, 1), ended_at: endedAt,
      items: [{ id: 'si_cancel_probe', price: 'price_nw_telemetry_events', metered: true }],
    }, { objectId: 'sub_cancel_probe', objectType: 'subscription' });

    const job = app.db.get<{ payload: string }>(
      `SELECT payload FROM jobs WHERE org_id = ? AND idem_key = ?`,
      ORG, `settle:si_cancel_probe:${periodStart}:${endedAt}`);
    assert.ok(job, 'the last part-period a subscription used is still usage somebody owes for');
    assert.equal((JSON.parse(job.payload) as { period_end: number }).period_end, endedAt);
  });

  test('an event with nothing metered on it enqueues nothing', async () => {
    const before = app.db.count(`SELECT COUNT(*) FROM jobs WHERE org_id = ? AND type = 'credits.settle_period'`, ORG);
    app.ctx.emit(ORG, 'subscription.invoice_due', {
      subscription: 'sub_flat_only', customer: 'cus_flat_only', currency: 'usd',
      arrears_period: null,
      lines: [{ subscription_item: 'si_flat_only', price: 'price_flat_only', metered: true, amount: null }],
    }, { objectId: 'sub_flat_only', objectType: 'subscription' });
    assert.equal(
      app.db.count(`SELECT COUNT(*) FROM jobs WHERE org_id = ? AND type = 'credits.settle_period'`, ORG),
      before,
      'no arrears period means nothing has closed yet',
    );
  });
});

/* ------------------------ summaries and provenance ------------------------ */

describe('pre-aggregated summaries', () => {
  test('period totals read whole hours from the pre-aggregate and scan only the edges', async () => {
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'Provenance', event_name: uniqueName('prov'), value_key: 'events',
    });
    const customer = 'cus_prov';
    const base = Date.UTC(2026, 4, 10);
    const events: MeterEventInput[] = [];
    for (let hour = 0; hour < 48; hour++) {
      for (let n = 0; n < 3; n++) {
        events.push({
          event_name: meter.event_name, identifier: `prov_${hour}_${n}`, timestamp: base + hour * HOUR + n * 12 * MINUTE,
          payload: { customer_id: customer, events: 10 },
        });
      }
    }
    await ingest(events);

    const aligned = svc().usageForPeriod(ORG, meter.id, customer, base, base + 48 * HOUR);
    assert.equal(aligned.value, 48 * 3 * 10);
    assert.equal(aligned.provenance.summarized_hours, 48);
    assert.equal(aligned.provenance.scanned_events, 0, 'an hour-aligned period touches no raw rows');

    // Half an hour in on both ends: two partial hours, exact all the same.
    const ragged = svc().usageForPeriod(ORG, meter.id, customer, base + 30 * MINUTE, base + 47 * HOUR + 30 * MINUTE);
    assert.equal(ragged.provenance.partial_leading_hour, true);
    assert.equal(ragged.provenance.partial_trailing_hour, true);
    assert.equal(ragged.provenance.summarized_hours, 46);
    // The leading hour's three events all sit before :30 and fall outside the
    // window; the trailing hour's three all sit before :30 and fall inside it.
    assert.equal(ragged.provenance.scanned_events, 3, 'only the two edge hours are read raw');
    assert.equal(ragged.value, 46 * 3 * 10 + 3 * 10);

    const buckets = await expectOk('GET',
      `/v1/meters/${meter.id}/event-summaries?customer=${customer}&start=${base}&end=${base + 48 * HOUR}&granularity=day`);
    assert.equal(buckets.data.length, 2);
    assert.equal(buckets.data[0].value, 24 * 3 * 10);
    assert.equal(buckets.data[0].event_count, 72);

    const hourly = await expectOk('GET',
      `/v1/meters/${meter.id}/event-summaries?customer=${customer}&start=${base}&end=${base + 6 * HOUR}&granularity=hour`);
    assert.equal(hourly.data.length, 6);
    assert.ok(hourly.data.every((b: { value: number }) => b.value === 30));
  });

  test('a summary range that would read the whole table is refused', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Huge range', event_name: uniqueName('huge') });
    await expectError('GET',
      `/v1/meters/${meter.id}/event-summaries?start=${T0 - 4000 * DAY}&end=${T0}&granularity=hour`, undefined, 400, 'range_too_large');
  });
});

/* --------------------------------- meters --------------------------------- */

describe('meter definitions', () => {
  test('a meter is reachable by id or by the event name it listens for', async () => {
    const eventName = uniqueName('lookup');
    const meter = await expectOk('POST', '/v1/meters', { name: 'Lookup', event_name: eventName });
    const byName = await expectOk('GET', `/v1/meters/${eventName}`);
    assert.equal(byName.id, meter.id);
    assert.ok(byName.ingestion, 'retrieval carries its ingestion health');
  });

  test('two live meters cannot claim the same event name', async () => {
    const eventName = uniqueName('clash');
    await expectOk('POST', '/v1/meters', { name: 'First', event_name: eventName });
    const error = await expectError('POST', '/v1/meters', { name: 'Second', event_name: eventName }, 409, 'meter_event_name_in_use');
    assert.match(error.message, /Archive that meter first/);
  });

  test('the aggregation cannot be changed once summaries exist under it', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Frozen', event_name: uniqueName('frozen'), aggregation: 'sum' });
    const error = await expectError('PATCH', `/v1/meters/${meter.id}`, { aggregation: 'max' }, 400, 'meter_field_immutable');
    assert.match(error.message, /Create a new meter/);
    const renamed = await expectOk('PATCH', `/v1/meters/${meter.id}`, { name: 'Renamed', acceptance_window_ms: 2 * DAY });
    assert.equal(renamed.name, 'Renamed');
    assert.equal(renamed.acceptance_window_ms, 2 * DAY);
  });

  test('an inactive meter stops accepting events and says so', async () => {
    const meter = await expectOk('POST', '/v1/meters', { name: 'Paused', event_name: uniqueName('paused') });
    await expectOk('PATCH', `/v1/meters/${meter.id}`, { status: 'inactive' });
    const error = await expectError('POST', '/v1/meter-events', {
      event_name: meter.event_name, identifier: 'paused_1', payload: { customer_id: 'cus_x', value: 1 },
    }, 400, 'meter_inactive');
    assert.match(error.message, /is inactive/);
  });
});

/* ---------------------------- the seeded workspace ------------------------ */

describe('the Northwind workspace', () => {
  test('every seeded meter has real usage behind it', async () => {
    const overview = await expectOk('GET', '/v1/metering/overview');
    const seeded = overview.meters.filter((m: { id: string }) => m.id.startsWith('mtr_nw_'));
    assert.equal(seeded.length, 6);
    for (const meter of seeded) {
      assert.ok(meter.events_30d > 0, `${meter.name} has no events`);
      assert.ok(meter.customers_30d > 0, `${meter.name} has no customers`);
    }
    assert.deepEqual(
      [...new Set(seeded.map((m: { aggregation: string }) => m.aggregation))].sort(),
      ['count', 'last', 'max', 'sum', 'unique'],
      'the demo exercises every aggregation',
    );
  });

  test('the Sunday the export worker double-ran is on record as a withdrawal', async () => {
    const adjustments = await expectOk('GET', '/v1/meter-event-adjustments?meter=mtr_nw_export');
    assert.equal(adjustments.data.length, 1);
    const [withdrawal] = adjustments.data;
    assert.equal(withdrawal.identifier, 'nw_exp_kestrel_double_run');
    assert.ok(withdrawal.value < 0, 'an adjustment states what it took back out');
    assert.match(withdrawal.reason, /restarted mid-run/);

    // It is not in the meter's totals, and it is not gone either.
    const listed = await expectOk('GET', '/v1/meter-events?meter=mtr_nw_export&cancelled=true');
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0].cancelled, true);
    assert.equal(listed.data[0].adjustment, withdrawal.id);
    const live = await expectOk('GET', '/v1/meter-events?meter=mtr_nw_export&limit=200');
    assert.ok(live.data.every((e: { cancelled: boolean }) => !e.cancelled));
  });

  test('the telemetry meter carries a fleet-sized month for its biggest account', async () => {
    const customers = await expectOk('GET', '/v1/meters/mtr_nw_telemetry/customers');
    assert.ok(customers.data.length >= 6);
    const values = customers.data.map((row: { value: number }) => row.value);
    assert.deepEqual(values, [...values].sort((a: number, b: number) => b - a), 'biggest fleet first');
    assert.ok(values[0] > 1_000_000, 'the largest fleet streams millions of events a month');
    assert.equal(customers.data[0].aggregation, 'sum');
    assert.ok(
      customers.data.every((row: { provenance: { summarized_hours: number } }) => row.provenance.summarized_hours > 0),
      'a month of usage is read from the pre-aggregate, not scanned',
    );
  });
});

/* ----------------------- the credit-coverage search ----------------------- */

describe('unitsWorthBurning never spends a credit that buys nothing', () => {
  // A graduated price: the first 500,000 units are free, then 4 cents each.
  const cost = (q: number) => (q <= 500_000 ? 0 : (q - 500_000) * 4);

  test('credits are not spent against a free tier', () => {
    assert.equal(unitsWorthBurning(cost, 600_000, 200_000), 100_000);
    assert.equal(cost(600_000 - 100_000), 0);
  });

  test('when everything is chargeable, the whole balance is spent', () => {
    assert.equal(unitsWorthBurning(cost, 3_000_000, 1_000_000), 1_000_000);
  });

  test('a balance bigger than the usage is capped by the usage', () => {
    assert.equal(unitsWorthBurning(cost, 400_000, 900_000), 0, 'nothing is chargeable at all');
    assert.equal(unitsWorthBurning(cost, 700_000, 900_000), 200_000);
  });

  test('no balance, no burn', () => {
    assert.equal(unitsWorthBurning(cost, 1_000_000, 0), 0);
  });
});

/* ------------------------- a true-up that is money ------------------------ */

describe('a billed period that drifts is settled in money, not in a word', () => {
  /** A meter, a metered price and a closed period — the smallest true-up. */
  async function billed(opts: { aggregation?: string; unitAmount?: number; tiers?: unknown[] } = {}) {
    const eventName = uniqueName('tu');
    const meter = await expectOk('POST', '/v1/meters', {
      name: 'True-up meter', event_name: eventName, aggregation: opts.aggregation ?? 'sum',
      value_key: 'units', unit_label: 'unit', acceptance_window_ms: 60 * DAY,
    });
    const product = await expectOk('POST', '/v1/products', { name: 'True-up telemetry', unit_label: 'unit', category: 'component' });
    const price = await expectOk('POST', '/v1/prices', {
      product: product.id, currency: 'usd', model: 'usage', type: 'recurring', nickname: 'True-up usage',
      ...(opts.tiers
        ? { tiers_mode: 'graduated', tiers: opts.tiers }
        : { unit_amount: opts.unitAmount ?? 100 }),
      recurring: { interval: 'month', usage_type: 'metered', aggregate_usage: 'sum', meter: eventName },
    });
    return { meter, price, eventName, customer: uniqueName('cus') };
  }

  const MAY = Date.UTC(2026, 4, 1);
  const JUNE = Date.UTC(2026, 5, 1);

  test('withdrawing usage from an invoiced period produces a negative line for exactly what it was worth', async () => {
    const fx = await billed();
    await ingest([10, 20, 30, 5000].map((units, i) => ({
      event_name: fx.eventName, identifier: `${fx.customer}_${'abcd'[i]}`,
      timestamp: MAY + DAY, payload: { customer_id: fx.customer, units },
    })));
    // The fat-fingered reading is caught before the invoice, as it always was.
    await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: `${fx.customer}_d` } });
    const settlement = await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE, close_period: true,
    });
    assert.equal(settlement.billed_quantity, 60);
    assert.equal(settlement.charged_amount, 6000);

    // ...and this one is caught after it, which used to be where money stopped.
    const adjustment = await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: `${fx.customer}_b` } });
    const closure = await expectOk('GET', `/v1/meter-period-closures/${adjustment.closure}`);
    assert.equal(closure.total, 60, 'the invoiced total does not move');
    assert.equal(closure.live_total, 40, 'the meter does');
    assert.equal(closure.outstanding_amount, -2000, 'and the difference has a price');

    const resolved = await expectOk('POST', `/v1/meter-late-arrivals/${adjustment.late_arrival}/resolve`, { resolution: 'credited' });
    assert.equal(resolved.resolution, 'credited');
    assert.equal(resolved.amount, -2000);
    assert.ok(resolved.billable_item, 'the resolution points at a line, not a string somebody typed');

    const items = await expectOk('GET', `/v1/credit-billable-items?customer=${fx.customer}`);
    const trueUp = items.data.find((i: { kind: string }) => i.kind === 'true_up');
    assert.ok(trueUp);
    assert.equal(trueUp.id, resolved.billable_item);
    assert.equal(trueUp.amount, -2000);
    assert.equal(
      items.data.reduce((acc: number, i: { billed_amount: number }) => acc + i.billed_amount, 0), 4000,
      'the customer owes 40 units at $1.00, which is what the meter now reads',
    );
    // And the period agrees with itself again.
    assert.equal((await expectOk('GET', `/v1/meter-period-closures/${adjustment.closure}`)).outstanding_amount, 0);
  });

  test('two true-ups on a graduated price sum to exactly one true-up of both', async () => {
    // 1,000 free, then 10 minor units each — so a badly-priced second true-up
    // would give the free tier away twice.
    const tiers = [{ up_to: 1000, unit_amount_decimal: '0' }, { up_to: 'inf', unit_amount_decimal: '10' }];
    const twice = await billed({ tiers });
    await ingest([1500, 200, 300].map((units, i) => ({
      event_name: twice.eventName, identifier: `${twice.customer}_${i}`,
      timestamp: MAY + DAY, payload: { customer_id: twice.customer, units },
    })));
    const settled = await expectOk('POST', '/v1/credit-settlements', {
      customer: twice.customer, price: twice.price.id, period_start: MAY, period_end: JUNE, close_period: true,
    });
    assert.equal(settled.billed_quantity, 2000);
    assert.equal(settled.full_amount, 10_000, '1,000 chargeable units at 10');

    const first = await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: `${twice.customer}_1` } });
    const a = await expectOk('POST', `/v1/meter-late-arrivals/${first.late_arrival}/resolve`, { resolution: 'credited' });
    const second = await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: `${twice.customer}_2` } });
    const b = await expectOk('POST', `/v1/meter-late-arrivals/${second.late_arrival}/resolve`, { resolution: 'credited' });
    assert.equal(a.amount, -2000);
    assert.equal(b.amount, -3000);

    // The same 500 units withdrawn in one go, on an identical fixture.
    const once = await billed({ tiers });
    await ingest([1500, 500].map((units, i) => ({
      event_name: once.eventName, identifier: `${once.customer}_${i}`,
      timestamp: MAY + DAY, payload: { customer_id: once.customer, units },
    })));
    await expectOk('POST', '/v1/credit-settlements', {
      customer: once.customer, price: once.price.id, period_start: MAY, period_end: JUNE, close_period: true,
    });
    const bulk = await expectOk('POST', '/v1/meter-event-adjustments', { cancel: { identifier: `${once.customer}_1` } });
    const together = await expectOk('POST', `/v1/meter-late-arrivals/${bulk.late_arrival}/resolve`, { resolution: 'credited' });
    assert.equal(together.amount, a.amount + b.amount, 'marginal pricing, so the parts equal the whole');
  });

  test('a late reading below a peak moves nothing on a max meter, and says so', async () => {
    const fx = await billed({ aggregation: 'max' });
    await ingest([{
      event_name: fx.eventName, identifier: `${fx.customer}_peak`,
      timestamp: MAY + DAY, payload: { customer_id: fx.customer, units: 90 },
    }]);
    await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE, close_period: true,
    });
    // A late reading of 40 raises no peak, so the period is worth what it was.
    const late = await expectOk('POST', '/v1/meter-events', {
      event_name: fx.eventName, identifier: `${fx.customer}_low`,
      timestamp: MAY + 2 * DAY, payload: { customer_id: fx.customer, units: 40 },
    });
    const error = await expectError('POST', `/v1/meter-late-arrivals/${late.late_arrival.id}/resolve`,
      { resolution: 'rebilled' }, 409, 'true_up_already_settled');
    assert.match(error.message, /nothing to true up/);

    // A reading above it does move the peak, by the difference and no more.
    const high = await expectOk('POST', '/v1/meter-events', {
      event_name: fx.eventName, identifier: `${fx.customer}_high`,
      timestamp: MAY + 3 * DAY, payload: { customer_id: fx.customer, units: 130 },
    });
    const resolved = await expectOk('POST', `/v1/meter-late-arrivals/${high.late_arrival.id}/resolve`, { resolution: 'rebilled' });
    assert.equal(resolved.amount, 4000, '130 minus the 90 already billed, at $1.00');
  });

  test('a period is trued up once, not once per event', async () => {
    const fx = await billed();
    await ingest([{
      event_name: fx.eventName, identifier: `${fx.customer}_base`,
      timestamp: MAY + DAY, payload: { customer_id: fx.customer, units: 100 },
    }]);
    await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE, close_period: true,
    });
    const late = [];
    for (const units of [5, 7, 9]) {
      late.push(await expectOk('POST', '/v1/meter-events', {
        event_name: fx.eventName, identifier: `${fx.customer}_late_${units}`,
        timestamp: MAY + 2 * DAY, payload: { customer_id: fx.customer, units },
      }));
    }
    const resolved = await expectOk('POST', `/v1/meter-late-arrivals/${late[0].late_arrival.id}/resolve`, { resolution: 'rebilled' });
    assert.equal(resolved.amount, 2100, '21 units of late usage, once');

    const open = await expectOk('GET', `/v1/meter-late-arrivals?customer=${fx.customer}&resolution=open`);
    assert.equal(open.data.length, 0, 'the other two were settled alongside it');
    const others = await expectOk('GET', `/v1/meter-late-arrivals?customer=${fx.customer}`);
    for (const entry of others.data) {
      assert.equal(entry.resolution, 'rebilled');
      assert.equal(entry.billable_item, resolved.billable_item, 'and they all point at the one line');
    }
    assert.equal(
      others.data.reduce((acc: number, e: { amount: number }) => acc + e.amount, 0), 2100,
      'the money is counted once across the entries, not three times',
    );
  });

  test('resolving twice is a no-op, and changing a resolution that moved money is refused', async () => {
    const fx = await billed();
    await ingest([{
      event_name: fx.eventName, identifier: `${fx.customer}_base`,
      timestamp: MAY + DAY, payload: { customer_id: fx.customer, units: 50 },
    }]);
    await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE, close_period: true,
    });
    const late = await expectOk('POST', '/v1/meter-events', {
      event_name: fx.eventName, identifier: `${fx.customer}_late`,
      timestamp: MAY + 2 * DAY, payload: { customer_id: fx.customer, units: 4 },
    });
    const id = late.late_arrival.id;
    const first = await expectOk('POST', `/v1/meter-late-arrivals/${id}/resolve`, { resolution: 'rebilled' });
    const replay = await expectOk('POST', `/v1/meter-late-arrivals/${id}/resolve`, { resolution: 'rebilled' });
    assert.equal(replay.billable_item, first.billable_item, 'a retried resolution bills nothing twice');
    assert.equal(
      (await expectOk('GET', `/v1/credit-billable-items?customer=${fx.customer}&kind=true_up`)).data.length, 1,
    );
    const error = await expectError('POST', `/v1/meter-late-arrivals/${id}/resolve`, { resolution: 'credited' }, 409, 'late_arrival_already_resolved');
    assert.match(error.message, new RegExp(first.billable_item));
  });

  test('the wrong direction is refused before it becomes a line', async () => {
    const fx = await billed();
    await ingest([{
      event_name: fx.eventName, identifier: `${fx.customer}_base`,
      timestamp: MAY + DAY, payload: { customer_id: fx.customer, units: 50 },
    }]);
    await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: JUNE, close_period: true,
    });
    const late = await expectOk('POST', '/v1/meter-events', {
      event_name: fx.eventName, identifier: `${fx.customer}_late`,
      timestamp: MAY + 2 * DAY, payload: { customer_id: fx.customer, units: 6 },
    });
    const error = await expectError('POST', `/v1/meter-late-arrivals/${late.late_arrival.id}/resolve`,
      { resolution: 'credited' }, 400, 'parameter_invalid');
    assert.match(error.message, /under-billed/);
    assert.equal(
      (await expectOk('GET', `/v1/credit-billable-items?customer=${fx.customer}&kind=true_up`)).data.length, 0,
    );
  });

  test('a period billed through the settlement API is closed without being asked', async () => {
    // 1,000 free units then 10 each, and a month billed in two windows: the
    // freeze has to carry both the price and the rung the window sat on, or a
    // true-up on the first half hands the free tier out twice.
    const fx = await billed({ tiers: [{ up_to: 1000, unit_amount_decimal: '0' }, { up_to: 'inf', unit_amount_decimal: '10' }] });
    const mid = MAY + 15 * DAY;
    await ingest([
      { event_name: fx.eventName, identifier: `${fx.customer}_h1`, timestamp: MAY + DAY, payload: { customer_id: fx.customer, units: 900 } },
      { event_name: fx.eventName, identifier: `${fx.customer}_h2`, timestamp: mid + DAY, payload: { customer_id: fx.customer, units: 600 } },
    ]);
    // Neither call says `close_period`, because billing a metered period is
    // what says it.
    const first = await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: MAY, period_end: mid,
      billing_period_start: MAY, billing_period_end: JUNE,
    });
    const second = await expectOk('POST', '/v1/credit-settlements', {
      customer: fx.customer, price: fx.price.id, period_start: mid, period_end: JUNE,
      billing_period_start: MAY, billing_period_end: JUNE,
    });
    assert.equal(first.full_amount, 0, 'the first 900 units are inside the free tier');
    assert.equal(second.full_amount, 5_000, 'and 500 of the next 600 are chargeable');

    const closures = await expectOk('GET', `/v1/meter-period-closures?meter=${fx.meter.id}&customer=${fx.customer}`);
    assert.equal(closures.data.length, 2, 'two windows billed, two windows frozen');
    const early = closures.data.find((c: { period_start: number }) => c.period_start === MAY);
    assert.equal(early.total, 900);
    assert.equal(early.price, fx.price.id);
    assert.equal(early.prior_quantity, 0);
    assert.equal(early.ref_type, 'credit_settlement');
    assert.equal(early.ref_id, first.id);
    const later = closures.data.find((c: { period_start: number }) => c.period_start === mid);
    assert.equal(later.prior_quantity, 900, 'the second window remembers the rung it started on');
    assert.equal(later.ref_id, second.id);

    // A reading for the *first* window turns up after both were invoiced. It
    // is priced from where that window sat on the ladder — 900 units in, so
    // 100 of the 200 are free — not from the bottom of it.
    const late = await expectOk('POST', '/v1/meter-events', {
      event_name: fx.eventName, identifier: `${fx.customer}_h1_late`,
      timestamp: MAY + 2 * DAY, payload: { customer_id: fx.customer, units: 200 },
    });
    assert.equal(late.event.late, true);
    assert.equal(late.late_arrival.closure, early.id);
    const resolved = await expectOk('POST', `/v1/meter-late-arrivals/${late.late_arrival.id}/resolve`, {
      resolution: 'rebilled',
    });
    assert.equal(resolved.amount, 1_000, '100 units past the free tier at 10 each');
    assert.equal((await expectOk('GET', `/v1/meter-period-closures/${early.id}`)).outstanding_amount, 0,
      'and the period agrees with itself again');
  });
});

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** Ingest a fixture and refuse to continue if any event was rejected. */
async function ingest(events: MeterEventInput[]): Promise<void> {
  for (const chunk of chunks(events, 1000)) {
    const batch: BatchResult = await expectOk('POST', '/v1/meter-events/batch', { events: chunk });
    const failed = batch.results.find((r) => r.error);
    assert.equal(failed, undefined, `fixture event rejected: ${failed?.error?.message}`);
  }
}
