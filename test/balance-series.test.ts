import { describe, it, expect } from 'vitest';
import {
  assembleSeries,
  MAX_SERIES_POINTS,
  refusesWholeSeries,
  resolveFrom,
  seriesHeights,
  type PointOutcome,
} from '../src/core/balance-series.js';
import {
  HistoricalStateUnavailableError,
  HistoricalStateUnsupportedError,
  SingularityError,
  UnsupportedOperationError,
} from '../src/core/errors.js';
import { amount } from '../src/core/format.js';

/**
 * A series of balances is a handful of readings with unknown gaps between them.
 *
 * The ways to get it wrong all make it look more continuous than it is: a
 * pruned height filled in with a neighbour's value, or with zero; a change of
 * zero read as "nothing happened"; a set of readings called complete. Each case
 * below is one of those.
 */

const base = { address: '0xabc', chain: 'ethereum', symbol: 'ETH' };
const eth = (wei: string) => amount(wei, 18, 'ETH');
const read = (block: number, wei: string, timestamp?: string): PointOutcome => ({ block, amount: eth(wei), ...(timestamp ? { timestamp } : {}) });
const pruned = (block: number): PointOutcome => ({
  block,
  error: new HistoricalStateUnavailableError('ethereum', block, 'Pruned.'),
});

describe('choosing heights', () => {
  it('spaces them evenly and includes both ends', () => {
    expect(seriesHeights(100, 200, 5)).toEqual([100, 125, 150, 175, 200]);
  });

  it('returns fewer points than asked rather than repeating a height', () => {
    expect(seriesHeights(10, 12, 8)).toEqual([10, 11, 12]);
  });

  it('refuses a range that runs backwards or stands still', () => {
    expect(() => seriesHeights(200, 100)).toThrow(/earlier and a later block/);
    expect(() => seriesHeights(100, 100)).toThrow(/earlier and a later block/);
  });

  it('bounds the number of archive reads one call can make', () => {
    expect(() => seriesHeights(0, 1000, 1)).toThrow(SingularityError);
    expect(() => seriesHeights(0, 1000, MAX_SERIES_POINTS + 1)).toThrow(/between 2 and 32/);
    expect(seriesHeights(0, 1000, MAX_SERIES_POINTS)).toHaveLength(MAX_SERIES_POINTS);
  });

  it('reads a negative start as blocks before the end, and stops at genesis', () => {
    expect(resolveFrom(-100, 1000)).toBe(900);
    expect(resolveFrom(-5000, 1000)).toBe(0);
    expect(resolveFrom(250, 1000)).toBe(250);
  });
});

describe('assembling a series', () => {
  it('records the change between readings, and a zero change as zero rather than as nothing', () => {
    const series = assembleSeries(base, [
      read(300, '2000000000000000000'),
      read(100, '1000000000000000000', '2026-01-01T00:00:00Z'),
      read(200, '2000000000000000000'),
    ]);

    expect(series.points.map((p) => p.block)).toEqual([100, 200, 300]);
    expect(series.points[0]).toEqual({ block: 100, timestamp: '2026-01-01T00:00:00Z', status: 'read', amount: eth('1000000000000000000') });
    expect(series.points[1]!.change).toBe('+1');
    expect(series.points[1]!.changeRaw).toBe('1000000000000000000');
    expect(series.points[2]!.changeRaw).toBe('0');
    expect(series.changes).toBe(1);
  });

  it('calls a full set of readings curated, never exhaustive, and says what lies between them', () => {
    const series = assembleSeries(base, [read(100, '1'), read(200, '1')]);
    expect(series.completeness.kind).toBe('curated');
    expect(series.completeness.note).toContain('Nothing between two readings is known');
  });

  it('leaves a pruned height as a hole, not as a zero and not as its neighbour', () => {
    const series = assembleSeries(base, [read(100, '5'), pruned(200), read(300, '5')]);
    const hole = series.points[1]!;

    expect(hole.status).toBe('unavailable');
    expect(hole.amount).toBeUndefined();
    expect(hole.reason).toContain('HISTORICAL_STATE_UNAVAILABLE');
    // The change is measured against the last reading, across the hole.
    expect(series.points[2]!.changeRaw).toBe('0');
    expect(series.completeness).toMatchObject({ kind: 'truncated', shown: 2, omitted: 1 });
    expect(series.completeness.note).toContain('a hole, not a zero');
  });

  it('keeps an unexplained failure apart from a pruned height', () => {
    const series = assembleSeries(base, [read(100, '5'), { block: 200, error: new Error('socket hang up') }]);
    expect(series.points[1]).toMatchObject({ status: 'failed', reason: 'socket hang up' });
    expect(series.completeness.note).not.toContain('no longer keeps');
  });

  it('says there is no series when no height could be read', () => {
    const series = assembleSeries(base, [pruned(100), pruned(200)]);
    expect(series.completeness.kind).toBe('failed');
    expect(series.completeness.note).toContain('archive node');
  });
});

describe('which errors stop the whole series', () => {
  it('stops on a chain that cannot read the past at all, once rather than per point', () => {
    expect(refusesWholeSeries(new HistoricalStateUnsupportedError('solana', 'No slots.'))).toBe(true);
    expect(refusesWholeSeries(new UnsupportedOperationError('getBalance', 'utxo'))).toBe(true);
  });

  it('carries on past one missing height, because the next may be held', () => {
    expect(refusesWholeSeries(new HistoricalStateUnavailableError('ethereum', 1, 'Pruned.'))).toBe(false);
    expect(refusesWholeSeries(new Error('timeout'))).toBe(false);
  });
});
