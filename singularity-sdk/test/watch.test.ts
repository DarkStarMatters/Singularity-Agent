import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWatch } from '../src/watch.js';
import type { Change } from '../src/watch.js';
import { operations } from 'singularity-agent';

/**
 * The polling loop, and the things about it that are easy to get subtly wrong.
 *
 * Fake timers throughout: a watch is a thing that happens over minutes, and a
 * test suite that waits for it is a test suite people stop running.
 */

const DEPS = { cache: false as const, retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } };

function block(number: number) {
  return { number, hash: `0x${number}`, chain: 'ethereum', timestamp: number } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('change detection', () => {
  it('delivers the first reading, with no `previous`', async () => {
    vi.spyOn(operations, 'getBlock').mockResolvedValue(block(1));
    const seen: Change<unknown>[] = [];

    const watch = createWatch(DEPS).tip('ethereum', (c) => void seen.push(c), { intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toHaveLength(1);
    // The signal an alert needs to not fire on startup for every address.
    expect(seen[0]?.previous).toBeUndefined();
    expect(seen[0]?.tick).toBe(1);

    watch.stop();
  });

  it('does not fire again when nothing changed', async () => {
    vi.spyOn(operations, 'getBlock').mockResolvedValue(block(7));
    const handler = vi.fn();

    const watch = createWatch(DEPS).tip('ethereum', handler, { intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(handler).toHaveBeenCalledOnce();
    watch.stop();
  });

  it('fires on a change, and carries the previous value', async () => {
    let height = 10;
    vi.spyOn(operations, 'getBlock').mockImplementation(async () => block(height));
    const seen: Change<{ number: number }>[] = [];

    const watch = createWatch(DEPS).tip('ethereum', (c) => void seen.push(c as never), {
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    height = 11;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen).toHaveLength(2);
    expect(seen[1]?.previous?.number).toBe(10);
    expect(seen[1]?.value.number).toBe(11);
    expect(seen[1]?.tick).toBe(2);

    watch.stop();
  });

  it('reports a height going backwards rather than hiding the reorg', async () => {
    let height = 100;
    vi.spyOn(operations, 'getBlock').mockImplementation(async () => block(height));
    const seen: number[] = [];

    const watch = createWatch(DEPS).tip('ethereum', (c) => void seen.push((c.value as { number: number }).number), {
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    height = 101;
    await vi.advanceTimersByTimeAsync(1_000);
    height = 99; // reorged
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen).toEqual([100, 101, 99]);
    watch.stop();
  });
});

describe('failure handling', () => {
  it('delivers errors to onError rather than swallowing them', async () => {
    vi.spyOn(operations, 'getBlock').mockRejectedValue(new Error('endpoint down'));
    const onError = vi.fn();

    const watch = createWatch(DEPS).tip('ethereum', vi.fn(), { intervalMs: 1_000, onError });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('endpoint down');

    watch.stop();
  });

  it('keeps watching after a failure, and recovers', async () => {
    let fail = true;
    vi.spyOn(operations, 'getBlock').mockImplementation(async () => {
      if (fail) throw new Error('down');
      return block(5);
    });

    const handler = vi.fn();
    const watch = createWatch(DEPS).tip('ethereum', handler, {
      intervalMs: 1_000,
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();

    fail = false;
    // First failure backs off to 2× the interval, so this has to wait for it.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(handler).toHaveBeenCalledOnce();

    watch.stop();
  });

  it('backs off rather than hammering, and stops when told to give up', async () => {
    vi.spyOn(operations, 'getBlock').mockRejectedValue(new Error('down'));
    const onError = vi.fn();

    const watch = createWatch(DEPS).tip('ethereum', vi.fn(), {
      intervalMs: 1_000,
      stopAfterErrors: 3,
      onError,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(onError).toHaveBeenCalledTimes(3);
    expect(watch.active).toBe(false);
    await expect(watch.done).resolves.toBeUndefined();
  });
});

describe('lifecycle', () => {
  it('stops cleanly, and stop() is idempotent', async () => {
    vi.spyOn(operations, 'getBlock').mockResolvedValue(block(1));
    const handler = vi.fn();

    const watch = createWatch(DEPS).tip('ethereum', handler, { intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);

    watch.stop();
    watch.stop();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(handler).toHaveBeenCalledOnce();
    expect(watch.active).toBe(false);
    await expect(watch.done).resolves.toBeUndefined();
  });

  it('stops on an abort signal', async () => {
    vi.spyOn(operations, 'getBlock').mockResolvedValue(block(1));
    const controller = new AbortController();

    const watch = createWatch(DEPS).tip('ethereum', vi.fn(), {
      intervalMs: 1_000,
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    expect(watch.active).toBe(false);
    await expect(watch.done).resolves.toBeUndefined();
  });

  it('never starts when handed an already-aborted signal', async () => {
    const getBlock = vi.spyOn(operations, 'getBlock').mockResolvedValue(block(1));
    const controller = new AbortController();
    controller.abort();

    const watch = createWatch(DEPS).tip('ethereum', vi.fn(), { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getBlock).not.toHaveBeenCalled();
    expect(watch.active).toBe(false);
  });

  it('floors the interval, so a tight loop cannot get the caller throttled', async () => {
    vi.spyOn(operations, 'getBlock').mockImplementation(async () => block(Math.random()));
    const handler = vi.fn();

    const watch = createWatch(DEPS).tip('ethereum', handler, { intervalMs: 1 });
    await vi.advanceTimersByTimeAsync(2_500);

    // At the 1ms that was asked for this would be ~2500 calls. The floor makes
    // it three: t=0, t=1000, t=2000.
    expect(handler.mock.calls.length).toBeLessThanOrEqual(3);
    watch.stop();
  });
});

describe('watching one transaction', () => {
  const tx = (confirmations: number) =>
    ({
      hash: '0xabc',
      chain: 'ethereum',
      status: 'success',
      finality: { kind: 'probabilistic', note: '', confirmations },
    }) as never;

  it('stops on its own once the confirmation depth is met', async () => {
    let confirmations = 0;
    vi.spyOn(operations, 'getTransaction').mockImplementation(async () => ({
      found: [tx(confirmations)],
      searched: ['ethereum'],
    }));

    const seen: number[] = [];
    const watch = createWatch(DEPS).transaction(
      { hash: '0xabc', chain: 'ethereum', confirmations: 3 },
      (c) => void seen.push((c.value as { finality: { confirmations: number } }).finality.confirmations),
      { intervalMs: 1_000 },
    );

    await vi.advanceTimersByTimeAsync(0);
    confirmations = 1;
    await vi.advanceTimersByTimeAsync(1_000);
    confirmations = 3;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen).toEqual([0, 1, 3]);
    expect(watch.active).toBe(false);
    await expect(watch.done).resolves.toBeUndefined();
  });

  it('treats "not mined yet" as neither a change nor an error', async () => {
    vi.spyOn(operations, 'getTransaction').mockResolvedValue({ found: [], searched: ['ethereum'] });
    const handler = vi.fn();
    const onError = vi.fn();

    const watch = createWatch(DEPS).transaction({ hash: '0xabc', chain: 'ethereum' }, handler, {
      intervalMs: 1_000,
      onError,
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(handler).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(watch.active).toBe(true);

    watch.stop();
  });
});

describe('what a balance watch considers a change', () => {
  const balance = (native: string, note: string) =>
    ({
      chain: 'ethereum',
      address: '0x1',
      native: { amount: { formatted: native }, token: { symbol: 'ETH' } },
      tokens: [],
      tokenCompleteness: { kind: 'curated', note },
    }) as never;

  it('ignores cosmetic churn in the envelope note', async () => {
    let note = 'checked 40 tokens';
    vi.spyOn(operations, 'getBalance').mockImplementation(async () => balance('1.5', note));
    const handler = vi.fn();

    const watch = createWatch(DEPS).balance({ address: '0x1', chain: 'ethereum' }, handler, {
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    note = 'checked 41 tokens'; // same balance, different wording
    await vi.advanceTimersByTimeAsync(1_000);

    expect(handler).toHaveBeenCalledOnce();
    watch.stop();
  });

  it('fires when the amount actually moves', async () => {
    let native = '1.5';
    vi.spyOn(operations, 'getBalance').mockImplementation(async () => balance(native, 'n'));
    const handler = vi.fn();

    const watch = createWatch(DEPS).balance({ address: '0x1', chain: 'ethereum' }, handler, {
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    native = '2.0';
    await vi.advanceTimersByTimeAsync(1_000);

    expect(handler).toHaveBeenCalledTimes(2);
    watch.stop();
  });
});
