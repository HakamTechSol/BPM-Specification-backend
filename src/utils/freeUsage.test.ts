import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyFreeUsageWrite,
  computeFreeUsage,
  freeUsageKwhToPulses,
  nextFreeCheckAt,
  planFreeUsageWrite,
  readFreeUsageKwh,
  type SqlConnection,
} from './freeUsage.ts';

/** Records the statements a write plan produces, without a database. */
function fakeConnection(failOn?: string) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const events: string[] = [];
  const connection: SqlConnection = {
    async beginTransaction() {
      events.push('begin');
    },
    async commit() {
      events.push('commit');
    },
    async rollback() {
      events.push('rollback');
    },
    release() {
      events.push('release');
    },
    async execute(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (failOn && sql.includes(failOn)) throw new Error('write failed');
      return [];
    },
  };
  return { connection, calls, events };
}

/**
 * The legacy chain, spelled out for the worked example:
 *   freeDays      = 3
 *   kwhVrij       = 8000 / 2000 = 4 kWh per day
 *   freeUsageTotal= 4 * 3       = 12.00 kWh
 *   used          = 2798.51 - 2759.97 = 38.54 kWh
 *   difference    = 38.54 - 12   = 26.54 kWh
 */
describe('computeFreeUsage (legacy dispVerbruik.php)', () => {
  it('matches the worked example: 2759.97 start, 2798.51 meter, 4 kWh/day, 3 days', () => {
    const result = computeFreeUsage({
      kwhvrij: 8000,
      kwhpulsen: 2000,
      freeDays: 3,
      eStart: 2759.97,
      currentMeter: 2798.51,
    });

    assert.equal(result.freeDays, 3);
    assert.equal(result.freeUsagePerDay, 4);
    assert.equal(result.freeUsageTotal, 12);
    assert.equal(result.freeUsageTotal.toFixed(2), '12.00');
    assert.equal(Number((2798.51 - 2759.97).toFixed(2)), 38.54);
    assert.equal(result.difference.toFixed(2), '26.54');
  });

  it('clamps a negative difference to 0.00', () => {
    const result = computeFreeUsage({
      kwhvrij: 8000,
      kwhpulsen: 2000,
      freeDays: 5,
      eStart: 100,
      currentMeter: 100,
    });

    // 0 kWh used, 20 kWh free -> the invoice is never negative.
    assert.equal(result.freeUsageTotal, 20);
    assert.equal(result.difference, 0);
    assert.equal(result.difference.toFixed(2), '0.00');
  });

  it('turns 0 days into 1 day, so the label is singular', () => {
    const zero = computeFreeUsage({
      kwhvrij: 4000,
      kwhpulsen: 2000,
      freeDays: 0,
      eStart: 1000,
      currentMeter: 1006,
    });
    const missing = computeFreeUsage({
      kwhvrij: 4000,
      kwhpulsen: 2000,
      freeDays: Number.NaN,
      eStart: 1000,
      currentMeter: 1006,
    });

    assert.equal(zero.freeDays, 1);
    assert.equal(zero.freeUsageTotal, 2);
    assert.equal(zero.difference.toFixed(2), '4.00');
    assert.equal(missing.freeDays, 1);
  });

  it('treats a missing start reading as zero', () => {
    const result = computeFreeUsage({
      kwhvrij: 2000,
      kwhpulsen: 2000,
      freeDays: 1,
      eStart: null,
      currentMeter: 5,
    });

    assert.equal(result.freeUsageTotal, 1);
    assert.equal(result.difference.toFixed(2), '4.00');
  });

  it('falls back to the raw column value when the pulse rate is 0 or unknown', () => {
    // Legacy: without a pulse rate the raw column is taken at face value.
    const result = computeFreeUsage({
      kwhvrij: 4,
      kwhpulsen: 0,
      freeDays: 3,
      eStart: 1000,
      currentMeter: 1010,
    });

    assert.equal(result.freeUsagePerDay, 4);
    assert.equal(result.freeUsageTotal, 12);
    assert.equal(result.difference, 0);
  });
});

describe('readFreeUsageKwh (#FREEUSAGEDB kwhvrij is pulses)', () => {
  it('reads 8000 pulses at 2000 pulses per kWh as 4.00 kWh', () => {
    assert.equal(readFreeUsageKwh(8000, 2000), 4);
    assert.equal(readFreeUsageKwh(8000, 2000).toFixed(2), '4.00');
  });

  it('reads 2.5 kWh at 1000 pulses per kWh as 2500 pulses', () => {
    assert.equal(freeUsageKwhToPulses(2.5, 1000), 2500);
    assert.equal(readFreeUsageKwh(2500, 1000), 2.5);
  });

  it('falls back to the raw column when the pulse rate is 0 or unknown', () => {
    assert.equal(readFreeUsageKwh(4, 0), 4);
    assert.equal(readFreeUsageKwh(4, null), 4);
  });

  it('reads a raw kWh value stored in a pulsed column as 0.00 (no extra rows)', () => {
    // Pitch 77 today: kwhvrij = 4 but the meter runs at 2000 pulses per kWh.
    assert.equal(readFreeUsageKwh(4, 2000), 0);

    const result = computeFreeUsage({
      kwhvrij: 4,
      kwhpulsen: 2000,
      freeDays: 11,
      eStart: 2759.97,
      currentMeter: 2899.184,
    });

    // Rounded to 2 decimals the daily allowance is 0, so the "Vrij verbruik"
    // and "Verschil" rows are not shown and the full usage is invoiced.
    assert.equal(result.freeUsagePerDay, 0);
    assert.equal(result.freeUsageTotal, 0);
    assert.equal(result.difference.toFixed(2), '139.21');
  });
});

describe('planFreeUsageWrite (legacy veld.php)', () => {
  const noon = new Date('2026-10-15T12:00:00.000Z');

  it('writes 4 kWh at 2000 pulses per kWh as 8000 pulses and remembers it', () => {
    const plan = planFreeUsageWrite({ kWh: 4, kwhpulsen: 2000, kwhvrijprev: 0, now: noon });

    assert.equal(plan.newKwhvrij, 8000);
    assert.equal(plan.updatePrev, true);
    assert.equal(typeof plan.nextFreeCheckAt, 'number');
  });

  it('writes 2.5 kWh at 1000 pulses per kWh as 2500 pulses', () => {
    const plan = planFreeUsageWrite({ kWh: 2.5, kwhpulsen: 1000, kwhvrijprev: 0, now: noon });

    assert.equal(plan.newKwhvrij, 2500);
    assert.equal(plan.updatePrev, true);
  });

  it('leaves kwhvrijprev and nextvrijaftrekcheck alone when the value is unchanged', () => {
    const plan = planFreeUsageWrite({ kWh: 4, kwhpulsen: 2000, kwhvrijprev: 8000, now: noon });

    // kwhvrij is still written, but the "previous" bookkeeping is not touched:
    // the comparison is against kwhvrijprev, not against kwhvrij.
    assert.equal(plan.newKwhvrij, 8000);
    assert.equal(plan.updatePrev, false);
    assert.equal(plan.nextFreeCheckAt, null);
  });

  it('keeps kwhvrijprev when no value is submitted', () => {
    const plan = planFreeUsageWrite({
      kWh: null,
      kwhpulsen: 2000,
      kwhvrijprev: 8000,
      now: noon,
    });

    assert.equal(plan.newKwhvrij, 8000);
    assert.equal(plan.updatePrev, false);
  });

  it('schedules nextvrijaftrekcheck at tomorrow midnight in the legacy timezone', () => {
    // 16 October 2026 00:00 in Europe/Amsterdam is 2026-10-15T22:00Z (CEST).
    assert.equal(nextFreeCheckAt(noon), 1792101600);

    const plan = planFreeUsageWrite({ kWh: 4, kwhpulsen: 2000, kwhvrijprev: 0, now: noon });
    assert.equal(plan.nextFreeCheckAt, 1792101600);
  });

  it('uses the configured legacy timezone', () => {
    // Same instant on a UTC server: 16 October 2026 00:00 UTC.
    assert.equal(nextFreeCheckAt(noon, 'UTC'), 1792108800);
  });

  it('follows the legacy timezone across a DST change', () => {
    // 24 October 2026 is the last night before Amsterdam switches to CET, so
    // the offset differs between the two sides of it.
    const beforeDst = nextFreeCheckAt(new Date('2026-10-23T12:00:00.000Z'));
    const afterDst = nextFreeCheckAt(new Date('2026-10-26T12:00:00.000Z'));

    // 24 Oct 00:00 CEST = 23 Oct 22:00Z
    assert.equal(beforeDst, 1792792800);
    // 27 Oct 00:00 CET = 26 Oct 23:00Z
    assert.equal(afterDst, 1793055600);
  });
});
describe('applyFreeUsageWrite (one transaction, legacy statement order)', () => {
  const noon = new Date('2026-10-15T12:00:00.000Z');

  it('writes kwhvrijprev and nextvrijaftrekcheck, then kwhvrij, and commits', async () => {
    const plan = planFreeUsageWrite({ kWh: 4, kwhpulsen: 2000, kwhvrijprev: 0, now: noon });
    const { connection, calls, events } = fakeConnection();

    await applyFreeUsageWrite(connection, 85, plan);

    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /kwhvrijprev = \?, nextvrijaftrekcheck = \?/);
    assert.deepEqual(calls[0].params, [8000, plan.nextFreeCheckAt, 85]);
    assert.match(calls[1].sql, /kwhvrij = \?/);
    assert.deepEqual(calls[1].params, [8000, 85]);
    assert.deepEqual(events, ['begin', 'commit', 'release']);
  });

  it('only touches kwhvrij when the value did not change', async () => {
    const plan = planFreeUsageWrite({ kWh: 4, kwhpulsen: 2000, kwhvrijprev: 8000, now: noon });
    const { connection, calls, events } = fakeConnection();

    await applyFreeUsageWrite(connection, 85, plan);

    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /kwhvrij = \?/);
    assert.deepEqual(calls[0].params, [8000, 85]);
    assert.deepEqual(events, ['begin', 'commit', 'release']);
  });

  it('rolls back and releases when a statement fails', async () => {
    const plan = planFreeUsageWrite({ kWh: 4, kwhpulsen: 2000, kwhvrijprev: 0, now: noon });
    const { connection, events } = fakeConnection('kwhvrijprev');

    await assert.rejects(() => applyFreeUsageWrite(connection, 85, plan));

    assert.deepEqual(events, ['begin', 'rollback', 'release']);
  });
});
