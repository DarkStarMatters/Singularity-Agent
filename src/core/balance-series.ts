/**
 * A balance at several past heights, and what a reader may not conclude from it.
 *
 * `atBlock` reads one past block. A series is the obvious next thing and the
 * easiest one to get wrong, because a chart of a balance implies that the
 * gaps between its points are known. They are not. Each point here is the
 * exact balance at its own block and nothing else. A deposit and a withdrawal
 * between two points leave no trace in either, and a line drawn through them
 * is an interpolation, not data.
 *
 * So every point says how it was obtained. `read` is a balance served at
 * exactly that height. `unavailable` is a height this endpoint no longer keeps,
 * which happens on every pruned node and is a hole, not a zero. `failed` is
 * anything else. A point is never filled in from its neighbours. The series
 * carries one completeness for the whole, and it is never `exhaustive`,
 * because a set of readings never is.
 */

import { SingularityError } from './errors.js';
import { formatUnits } from './format.js';
import { completeness, type Completeness } from './envelope.js';
import type { Amount } from './types.js';

/** More readings than this is a scan, and should be paged by the caller. */
export const MAX_SERIES_POINTS = 32;
export const DEFAULT_SERIES_POINTS = 8;

export type SeriesPointStatus = 'read' | 'unavailable' | 'failed';

export interface SeriesPoint {
  block: number;
  /** The block's own timestamp, ISO 8601. Absent when the endpoint would not date it. */
  timestamp?: string;
  status: SeriesPointStatus;
  /** `read` only. */
  amount?: Amount;
  /**
   * `read` only: base units gained (positive) or lost (negative) since the
   * previous `read` point, which may not be the previous point. Zero means the
   * same balance at both ends, not that nothing happened in between.
   */
  changeRaw?: string;
  /** `changeRaw` in the asset's own units, signed: "+8.43833852", "-26.45448458". */
  change?: string;
  /** `unavailable` and `failed` only: why. */
  reason?: string;
}

export interface BalanceSeries {
  address: string;
  chain: string;
  symbol: string;
  points: SeriesPoint[];
  /** Readings whose balance differed from the reading before. */
  changes: number;
  completeness: Completeness;
}

/**
 * Heights from `from` to `to`, inclusive, evenly spaced.
 *
 * Both ends are always included, and spacing is rounded to whole blocks, so a
 * short range yields fewer points than asked for rather than repeating one.
 */
export function seriesHeights(from: number, to: number, points: number = DEFAULT_SERIES_POINTS): number[] {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0) {
    throw new SingularityError('BAD_SERIES_RANGE', `${from}..${to} is not a range of block heights.`);
  }
  if (from >= to) {
    throw new SingularityError(
      'BAD_SERIES_RANGE',
      `A series needs an earlier and a later block; got ${from}..${to}.`,
      'Pass `from` lower than `to`. For one past block, use `balance` with `atBlock`.',
    );
  }
  if (!Number.isInteger(points) || points < 2 || points > MAX_SERIES_POINTS) {
    throw new SingularityError(
      'BAD_SERIES_POINTS',
      `${points} is not a number of points between 2 and ${MAX_SERIES_POINTS}.`,
      `Each point is a separate archive read. For more than ${MAX_SERIES_POINTS}, split the range into several series.`,
    );
  }

  const heights = new Set<number>();
  for (let i = 0; i < points; i += 1) {
    heights.add(Math.round(from + ((to - from) * i) / (points - 1)));
  }
  return [...heights].sort((a, b) => a - b);
}

/**
 * Resolve a `from` that may be relative.
 *
 * A negative value means that many blocks before `to`, because "the last
 * hundred thousand blocks" is the question people actually have, and nobody
 * knows the height a hundred thousand blocks ago.
 */
export function resolveFrom(from: number, to: number): number {
  if (!Number.isSafeInteger(from)) {
    throw new SingularityError('BAD_SERIES_RANGE', `${from} is not a block height.`);
  }
  return from < 0 ? Math.max(0, to + from) : from;
}

/** How one height turned out, before the series is assembled. */
export type PointOutcome =
  | { block: number; timestamp?: string; amount: Amount }
  | { block: number; timestamp?: string; error: unknown };

/**
 * Errors that mean the whole series cannot be read, rather than one point.
 *
 * A chain that cannot address past state at all refuses every height, and
 * reporting thirty-two identical holes would bury the one sentence that says
 * why.
 */
export function refusesWholeSeries(err: unknown): boolean {
  return (
    err instanceof SingularityError &&
    (err.code === 'HISTORICAL_STATE_UNSUPPORTED' || err.code === 'UNSUPPORTED')
  );
}

function reasonOf(err: unknown): string {
  if (err instanceof SingularityError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export function assembleSeries(
  base: { address: string; chain: string; symbol: string },
  outcomes: PointOutcome[],
): BalanceSeries {
  const sorted = [...outcomes].sort((a, b) => a.block - b.block);
  const points: SeriesPoint[] = [];
  let previous: bigint | undefined;
  let changes = 0;

  for (const outcome of sorted) {
    const dated = outcome.timestamp ? { timestamp: outcome.timestamp } : {};

    if ('amount' in outcome) {
      const raw = BigInt(outcome.amount.raw);
      const change = previous === undefined ? undefined : raw - previous;
      if (change !== undefined && change !== 0n) changes += 1;
      previous = raw;

      points.push({
        block: outcome.block,
        ...dated,
        status: 'read',
        amount: outcome.amount,
        ...(change !== undefined
          ? {
              changeRaw: change.toString(),
              change: `${change > 0n ? '+' : ''}${formatUnits(change, outcome.amount.decimals)}`,
            }
          : {}),
      });
      continue;
    }

    const unavailable = outcome.error instanceof SingularityError && outcome.error.code === 'HISTORICAL_STATE_UNAVAILABLE';
    points.push({ block: outcome.block, ...dated, status: unavailable ? 'unavailable' : 'failed', reason: reasonOf(outcome.error) });
  }

  return { ...base, points, changes, completeness: seriesCompleteness(points) };
}

function seriesCompleteness(points: SeriesPoint[]): Completeness {
  const read = points.filter((p) => p.status === 'read');
  const unavailable = points.filter((p) => p.status === 'unavailable');
  const failed = points.filter((p) => p.status === 'failed');
  const between =
    'Each reading is the exact balance at its block. Nothing between two readings is known: a deposit and a withdrawal between them leave no trace, and a line through them is an interpolation, not data.';

  if (!read.length) {
    return completeness.failed(
      unavailable.length === points.length
        ? `None of the ${points.length} heights is held by the configured endpoints, so there is no series. Point the chain at an archive node.`
        : `None of the ${points.length} heights could be read: ${failed[0]?.reason ?? unavailable[0]?.reason}`,
    );
  }

  if (read.length === points.length) {
    return completeness.curated(`${read.length} readings, from block ${read[0]!.block} to ${read[read.length - 1]!.block}. ${between}`);
  }

  const missing = [...unavailable, ...failed].map((p) => p.block);
  return completeness.truncated(
    read.length,
    missing.length,
    `${read.length} of ${points.length} heights were read; ${missing.join(', ')} ${missing.length === 1 ? 'was' : 'were'} not` +
      (unavailable.length ? `, ${unavailable.length} because the endpoint no longer keeps that state` : '') +
      '. A missing point is a hole, not a zero, and is not filled in from its neighbours. ' +
      between,
  );
}
