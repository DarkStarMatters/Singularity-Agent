import { describe, it, expect, vi } from 'vitest';
import { ReadCache, cacheKey, isTransient, withRetry, DEFAULT_TTL } from '../src/cache.js';
import type { CacheTtl } from '../src/cache.js';

/**
 * The cache rule, tested in both directions.
 *
 * "Only cache what is safe to cache" is easy to assert about a hit and easy to
 * leave untested about a miss. Both halves are here: what the cache serves, and
 * what it refuses to hold onto.
 */

const NEVER: CacheTtl = { historical: 0, current: 0, metadata: 0 };

describe('a TTL of zero is not a short TTL', () => {
  it('does not store, does not serve, and does not count', async () => {
    const cache = new ReadCache(NEVER);
    const work = vi.fn(async () => 'value');

    await cache.through('current', 'k', work);
    await cache.through('current', 'k', work);

    expect(work).toHaveBeenCalledTimes(2);
    // Nothing was stored, so nothing is reported as a hit or a miss — the
    // cache is genuinely absent rather than present and always missing.
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, entries: 0 });
  });

  it('is the default for current state', () => {
    expect(DEFAULT_TTL.current).toBe(0);
    expect(DEFAULT_TTL.historical).toBeGreaterThan(0);
  });
});

describe('what the cache serves', () => {
  it('serves a live entry without repeating the work', async () => {
    const cache = new ReadCache({ ...NEVER, historical: 1_000 });
    const work = vi.fn(async () => 'block-100');

    expect(await cache.through('historical', 'b100', work)).toBe('block-100');
    expect(await cache.through('historical', 'b100', work)).toBe('block-100');

    expect(work).toHaveBeenCalledOnce();
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });

  it('re-reads once the entry has expired', async () => {
    let now = 0;
    const cache = new ReadCache({ ...NEVER, historical: 1_000 }, 500, () => now);
    const work = vi.fn(async () => now);

    await cache.through('historical', 'k', work);
    now = 999;
    await cache.through('historical', 'k', work);
    expect(work).toHaveBeenCalledOnce();

    now = 1_001;
    await cache.through('historical', 'k', work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('keeps the classes apart, so the same key in two classes is two entries', async () => {
    const cache = new ReadCache({ historical: 1_000, current: 1_000, metadata: 1_000 });
    const historical = vi.fn(async () => 'then');
    const current = vi.fn(async () => 'now');

    await cache.through('historical', 'same', historical);
    await cache.through('current', 'same', current);

    expect(historical).toHaveBeenCalledOnce();
    expect(current).toHaveBeenCalledOnce();
    expect(cache.stats().entries).toBe(2);
  });
});

describe('what the cache refuses to hold', () => {
  it('never stores a failure', async () => {
    const cache = new ReadCache({ ...NEVER, metadata: 10_000 });
    const failing = vi.fn(async () => {
      throw new Error('endpoint down');
    });

    await expect(cache.through('metadata', 'k', failing)).rejects.toThrow('endpoint down');
    await expect(cache.through('metadata', 'k', failing)).rejects.toThrow('endpoint down');

    // Two real attempts. One bad minute on an endpoint must not outlive itself.
    expect(failing).toHaveBeenCalledTimes(2);
    expect(cache.stats().entries).toBe(0);
  });

  it('evicts oldest first rather than growing without bound', async () => {
    const cache = new ReadCache({ ...NEVER, metadata: 10_000 }, 3);

    for (const key of ['a', 'b', 'c', 'd']) {
      await cache.through('metadata', key, async () => key);
    }

    expect(cache.stats().entries).toBe(3);

    // 'a' was evicted, so it costs work again; 'd' is still live.
    const a = vi.fn(async () => 'a');
    const d = vi.fn(async () => 'd');
    await cache.through('metadata', 'a', a);
    await cache.through('metadata', 'd', d);

    expect(a).toHaveBeenCalledOnce();
    expect(d).not.toHaveBeenCalled();
  });
});

describe('cache keys', () => {
  it('treat argument order as irrelevant', () => {
    expect(cacheKey('balance', { address: 'a', chain: 'ethereum' })).toBe(
      cacheKey('balance', { chain: 'ethereum', address: 'a' }),
    );
  });

  it('treat an omitted option and an explicit undefined as the same call', () => {
    // They are the same call to every operation in the core, so caching them
    // as two entries would halve the hit rate for no reason.
    expect(cacheKey('balance', { address: 'a', atBlock: undefined })).toBe(
      cacheKey('balance', { address: 'a' }),
    );
  });

  it('distinguish calls that differ', () => {
    expect(cacheKey('balance', { address: 'a' })).not.toBe(cacheKey('balance', { address: 'b' }));
    expect(cacheKey('balance', { a: 1 })).not.toBe(cacheKey('block', { a: 1 }));
    expect(cacheKey('balance', { atBlock: 1 })).not.toBe(cacheKey('balance', { atBlock: '1' }));
  });

  it('are stable across nesting and arrays', () => {
    expect(cacheKey('x', { tokens: ['b', 'a'], o: { z: 1, y: 2 } })).toBe(
      cacheKey('x', { o: { y: 2, z: 1 }, tokens: ['b', 'a'] }),
    );
    // Array order is meaningful — a token list is not a set.
    expect(cacheKey('x', { tokens: ['a', 'b'] })).not.toBe(cacheKey('x', { tokens: ['b', 'a'] }));
  });
});

describe('retry, on the failures worth retrying', () => {
  const nap = async () => {};

  it('retries a rate limit and succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('429 Too Many Requests');
        return 'ok';
      },
      nap,
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry a bad request, however many attempts are allowed', async () => {
    // An invalid address fails identically forever. Retrying it only delays
    // the hint that was correct the first time.
    let calls = 0;
    const err = Object.assign(new Error('Not a valid address'), { code: 'INVALID_ADDRESS' });

    await expect(
      withRetry({ attempts: 5, baseDelayMs: 1, maxDelayMs: 2 }, async () => {
        calls += 1;
        throw err;
      }, nap),
    ).rejects.toThrow('Not a valid address');

    expect(calls).toBe(1);
  });

  it('gives up after the last attempt and rethrows the real error', async () => {
    await expect(
      withRetry({ attempts: 2, baseDelayMs: 1, maxDelayMs: 2 }, async () => {
        throw new Error('fetch failed');
      }, nap),
    ).rejects.toThrow('fetch failed');
  });

  it('backs off, rather than hammering an endpoint that is struggling', async () => {
    const delays: number[] = [];
    await expect(
      withRetry(
        { attempts: 4, baseDelayMs: 100, maxDelayMs: 250 },
        async () => {
          throw new Error('timeout');
        },
        async (ms) => {
          delays.push(ms);
        },
      ),
    ).rejects.toThrow();

    expect(delays).toEqual([100, 200, 250]); // doubling, then capped
  });

  it('classifies transient and permanent failures apart', () => {
    for (const transient of [
      new Error('socket hang up'),
      new Error('ETIMEDOUT'),
      new Error('503 Service Unavailable'),
      new Error('rate limit exceeded'),
      Object.assign(new Error('x'), { code: 'RPC_ERROR' }),
    ]) {
      expect(isTransient(transient), transient.message).toBe(true);
    }

    for (const permanent of [
      Object.assign(new Error('x'), { code: 'INVALID_ADDRESS' }),
      Object.assign(new Error('x'), { code: 'UNSUPPORTED' }),
      Object.assign(new Error('x'), { code: 'DECODE_FAILED' }),
      new Error('Calldata did not match the supplied ABI'),
    ]) {
      expect(isTransient(permanent), String(permanent.message)).toBe(false);
    }
  });
});
