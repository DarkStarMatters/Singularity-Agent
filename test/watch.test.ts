import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollLoop } from '../src/core/watch.js';
import { balanceIdentity } from '../src/tools/operations.js';
import type { BalanceResult } from '../src/tools/operations.js';

/**
 * The polling loop, tested where it lives.
 *
 * This moved out of `singularity-sdk` when `singularity watch` needed it, and
 * the tests moved with it: the SDK's own suite exercises the typed watches
 * built on top, and this one covers the mechanics both callers depend on.
 *
 * Fake timers throughout. A watch is a thing that happens over minutes, and a
 * test suite that waits for one is a test suite people stop running.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A tick returning whatever `values` says, one per call, then repeating. */
function ticker(values: unknown[]): () => Promise<unknown> {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
}

const id = (v: unknown) => String(v);

describe('change detection', () => {
  it('delivers the first reading with no `previous`', async () => {
    const handler = vi.fn();
    const watch = pollLoop(ticker([1]), id, handler, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ value: 1, tick: 1 });
    // The flag that stops an alert firing for every address it watches on
    // startup. Absent, not null.
    expect(handler.mock.calls[0]?.[0]).not.toHaveProperty('previous');

    watch.stop();
  });

  it('does not re-deliver an unchanged value', async () => {
    const handler = vi.fn();
    const watch = pollLoop(ticker([7]), id, handler, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(handler).toHaveBeenCalledOnce();
    watch.stop();
  });

  it('delivers a change with the value it replaced', async () => {
    const handler = vi.fn();
    const watch = pollLoop(ticker([1, 2]), id, handler, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({ value: 2, previous: 1, tick: 2 });

    watch.stop();
  });

  it('treats `undefined` as nothing to report, not as a change or an error', async () => {
    const handler = vi.fn();
    const onError = vi.fn();
    const watch = pollLoop(async () => undefined, id, handler, { intervalMs: 1_000, onError });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(handler).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(watch.active).toBe(true);

    watch.stop();
  });

  it('waits for an async handler before scheduling the next tick', async () => {
    // No overlap is the guarantee; a handler that takes longer than the
    // interval must not have a second one running behind it.
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let handled = 0;
    const watch = pollLoop(ticker([1, 2]), id, async () => {
      handled += 1;
      order.push(`start ${handled}`);
      if (handled === 1) await gate;
      order.push(`end ${handled}`);
    }, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(order).toEqual(['start 1']); // still blocked; nothing else started

    release();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(order.slice(0, 3)).toEqual(['start 1', 'end 1', 'start 2']);
    watch.stop();
  });
});

describe('failure handling', () => {
  it('delivers errors to onError and keeps going', async () => {
    let fail = true;
    const onError = vi.fn();
    const handler = vi.fn();

    const watch = pollLoop(
      async () => {
        if (fail) throw new Error('endpoint down');
        return 5;
      },
      id,
      handler,
      { intervalMs: 1_000, onError },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();

    fail = false;
    // The first failure doubles the interval, so recovery waits for that.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(handler).toHaveBeenCalledOnce();

    watch.stop();
  });

  it('backs off exponentially and caps', async () => {
    const delays: number[] = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return original(fn, ms);
    }) as typeof setTimeout);

    const watch = pollLoop(
      async () => {
        throw new Error('down');
      },
      id,
      vi.fn(),
      { intervalMs: 1_000, onError: vi.fn() },
    );

    await vi.advanceTimersByTimeAsync(300_000);
    watch.stop();

    // 0 (immediate first tick), then 2s, 4s, 8s … capped at 60s.
    expect(delays[0]).toBe(0);
    expect(delays.slice(1, 5)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(Math.max(...delays)).toBe(60_000);
  });

  it('resets the backoff after a success', async () => {
    let failing = true;
    const delays: number[] = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return original(fn, ms);
    }) as typeof setTimeout);

    const watch = pollLoop(
      async () => {
        if (failing) throw new Error('down');
        return Math.random();
      },
      id,
      vi.fn(),
      { intervalMs: 1_000, onError: vi.fn() },
    );

    await vi.advanceTimersByTimeAsync(30_000);
    failing = false;
    delays.length = 0;
    await vi.advanceTimersByTimeAsync(120_000);
    watch.stop();

    // Back to the plain interval; a recovered endpoint is not punished for
    // having been down.
    expect(delays.every((d) => d === 1_000)).toBe(true);
  });

  it('stops after the configured number of consecutive failures', async () => {
    const onError = vi.fn();
    const watch = pollLoop(
      async () => {
        throw new Error('down');
      },
      id,
      vi.fn(),
      { intervalMs: 1_000, stopAfterErrors: 3, onError },
    );

    await vi.advanceTimersByTimeAsync(120_000);

    expect(onError).toHaveBeenCalledTimes(3);
    expect(watch.active).toBe(false);
    await expect(watch.done).resolves.toBeUndefined();
  });

  it('stops and rejects `done` when the error handler itself throws', async () => {
    // There is nowhere left to put the failure at that point, and looping on a
    // handler that cannot succeed would spin forever printing nothing.
    const tick = vi.fn(async () => {
      throw new Error('down');
    });

    const watch = pollLoop(tick, id, vi.fn(), {
      intervalMs: 1_000,
      onError: () => {
        throw new Error('logger exploded');
      },
    });

    // Attached before the rejection happens, or it surfaces as an unhandled
    // rejection and fails the run even though the behaviour is correct.
    const rejects = expect(watch.done).rejects.toThrow('logger exploded');

    await vi.advanceTimersByTimeAsync(0);
    await rejects;

    expect(watch.active).toBe(false);

    // And it really stopped — no further ticks, despite `stop()` never having
    // been the path taken.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledOnce();
  });

  it('falls back to console.error, naming the watch, when no onError is given', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const watch = pollLoop(
      async () => {
        throw new Error('down');
      },
      id,
      vi.fn(),
      { intervalMs: 1_000, label: 'singularity watch tip' },
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(spy).toHaveBeenCalledWith('[singularity watch tip] tick failed:', expect.any(Error));
    watch.stop();
  });
});

describe('lifecycle', () => {
  it('stops cleanly and idempotently', async () => {
    const handler = vi.fn();
    const watch = pollLoop(ticker([1]), id, handler, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(0);
    watch.stop();
    watch.stop();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(handler).toHaveBeenCalledOnce();
    expect(watch.active).toBe(false);
    await expect(watch.done).resolves.toBeUndefined();
  });

  it('stops on an abort signal', async () => {
    const controller = new AbortController();
    const watch = pollLoop(ticker([1]), id, vi.fn(), {
      intervalMs: 1_000,
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    expect(watch.active).toBe(false);
    await expect(watch.done).resolves.toBeUndefined();
  });

  it('never ticks when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const tick = vi.fn(async () => 1);

    const watch = pollLoop(tick, id, vi.fn(), { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(tick).not.toHaveBeenCalled();
    expect(watch.active).toBe(false);
  });

  it('stops when `until` is satisfied, after delivering the change', async () => {
    let seen = 0;
    const handler = vi.fn(() => {
      seen += 1;
    });

    const watch = pollLoop(ticker([1, 2, 3]), id, handler, {
      intervalMs: 1_000,
      until: () => seen >= 2,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(watch.active).toBe(false);
    await expect(watch.done).resolves.toBeUndefined();
  });

  it('floors the interval so a tight loop cannot throttle the caller', async () => {
    const tick = vi.fn(async () => Math.random());
    const watch = pollLoop(tick, id, vi.fn(), { intervalMs: 1 });

    await vi.advanceTimersByTimeAsync(2_500);

    // At the 1ms asked for this would be ~2500 calls. The floor makes it
    // three: t=0, t=1000, t=2000.
    expect(tick.mock.calls.length).toBeLessThanOrEqual(3);
    watch.stop();
  });

  it('does not hold the process open by itself', async () => {
    // The timer is unref'd deliberately: a script that starts a watch and
    // finishes its work should exit. `singularity watch` therefore holds its
    // own handle — see runWatch in src/cli/index.ts, where getting this wrong
    // made the command exit silently after one tick.
    const unref = vi.fn();
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const handle = original(fn, ms);
      return Object.assign(handle as object, { unref }) as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const watch = pollLoop(ticker([1]), id, vi.fn(), { intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(unref).toHaveBeenCalled();
    watch.stop();
  });
});

describe('what counts as a balance change', () => {
  const balance = (native: string, tokens: Array<[string, string]>, note = 'n'): BalanceResult =>
    ({
      chain: 'ethereum',
      address: '0x1',
      native: { amount: { formatted: native }, token: { symbol: 'ETH' } },
      tokens: tokens.map(([symbol, amount]) => ({
        amount: { formatted: amount },
        token: { symbol },
      })),
      tokenCompleteness: { kind: 'curated', note },
    }) as unknown as BalanceResult;

  it('ignores a re-worded completeness note', () => {
    // The note's wording moves with the token count. Comparing it would fire a
    // handler on cosmetic churn and teach whoever left the terminal open to
    // ignore it.
    expect(balanceIdentity(balance('1.5', [], 'checked 40 tokens'))).toBe(
      balanceIdentity(balance('1.5', [], 'checked 41 tokens')),
    );
  });

  it('ignores token ordering', () => {
    expect(balanceIdentity(balance('1.5', [['USDC', '10'], ['DAI', '5']]))).toBe(
      balanceIdentity(balance('1.5', [['DAI', '5'], ['USDC', '10']])),
    );
  });

  it('notices the native amount moving', () => {
    expect(balanceIdentity(balance('1.5', []))).not.toBe(balanceIdentity(balance('2.0', [])));
  });

  it('notices a token moving while the native balance holds still', () => {
    // A watch that misses this is worse than no watch, because it is trusted.
    expect(balanceIdentity(balance('1.5', [['USDC', '10']]))).not.toBe(
      balanceIdentity(balance('1.5', [['USDC', '11']])),
    );
  });

  it('notices a token appearing', () => {
    expect(balanceIdentity(balance('1.5', []))).not.toBe(
      balanceIdentity(balance('1.5', [['USDC', '10']])),
    );
  });
});
