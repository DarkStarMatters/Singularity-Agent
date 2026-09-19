import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSingularity } from '../src/index.js';
import { operations } from 'singularity-agent';

/**
 * The client's own decisions — which are mostly decisions about what *not* to
 * cache, and those are the ones that fail silently when they are wrong.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what the client refuses to cache, at any TTL', () => {
  it('never caches liveness', async () => {
    // The rule this is defending: a cached "responding" is indistinguishable
    // from the outage the probe exists to catch. There is deliberately no
    // option to turn this on, because the option would be a bug with a config
    // flag in front of it.
    const checkLiveness = vi.spyOn(operations, 'checkLiveness').mockResolvedValue([]);

    const sdk = createSingularity({
      chain: 'ethereum',
      cache: { current: 600_000, historical: 600_000, metadata: 600_000 },
    });

    await sdk.liveness(['ethereum']);
    await sdk.liveness(['ethereum']);
    await sdk.liveness(['ethereum']);

    expect(checkLiveness).toHaveBeenCalledTimes(3);
  });

  it('never caches an endpoint health probe', async () => {
    const checkEndpoints = vi.spyOn(operations, 'checkEndpoints').mockResolvedValue([]);
    const sdk = createSingularity({ chain: 'ethereum', cache: { current: 600_000 } });

    await sdk.endpoints(['ethereum']);
    await sdk.endpoints(['ethereum']);

    expect(checkEndpoints).toHaveBeenCalledTimes(2);
  });

  it('never caches a burn verification', async () => {
    // A verify is the check standing between a burn and whatever it entitles
    // someone to. A cached answer is a replay window.
    const verifyBurn = vi.spyOn(operations, 'verifyBurn').mockResolvedValue({} as never);
    const sdk = createSingularity({ chain: 'solana', cache: { current: 600_000 } });

    await sdk.verifyBurn({ signature: 'sig' });
    await sdk.verifyBurn({ signature: 'sig' });

    expect(verifyBurn).toHaveBeenCalledTimes(2);
  });
});

describe('historical and current reads are cached differently', () => {
  it('caches a read pinned to a height', async () => {
    const getBalance = vi.spyOn(operations, 'getBalance').mockResolvedValue({} as never);
    const sdk = createSingularity({ chain: 'ethereum' }); // historical: 5 min by default

    await sdk.balance({ address: '0x1', atBlock: 18_000_000 });
    await sdk.balance({ address: '0x1', atBlock: 18_000_000 });

    expect(getBalance).toHaveBeenCalledOnce();
  });

  it('does not cache current state by default', async () => {
    const getBalance = vi.spyOn(operations, 'getBalance').mockResolvedValue({} as never);
    const sdk = createSingularity({ chain: 'ethereum' });

    await sdk.balance({ address: '0x1' });
    await sdk.balance({ address: '0x1' });

    expect(getBalance).toHaveBeenCalledTimes(2);
  });

  it('keeps `latest` out of the historical bucket', async () => {
    // A numbered block is immutable and may be held for minutes. `latest` is a
    // moving target, and serving it from the long-lived bucket would freeze the
    // head of the chain for everything downstream.
    const getBlock = vi.spyOn(operations, 'getBlock').mockResolvedValue({} as never);
    const sdk = createSingularity({ chain: 'ethereum' });

    await sdk.block();
    await sdk.block();
    await sdk.block({ ref: 'latest' });
    expect(getBlock).toHaveBeenCalledTimes(3);

    await sdk.block({ ref: 18_000_000 });
    await sdk.block({ ref: 18_000_000 });
    expect(getBlock).toHaveBeenCalledTimes(4);
  });

  it('`cache: false` turns all of it off', async () => {
    const getBalance = vi.spyOn(operations, 'getBalance').mockResolvedValue({} as never);
    const sdk = createSingularity({ chain: 'ethereum', cache: false });

    await sdk.balance({ address: '0x1', atBlock: 18_000_000 });
    await sdk.balance({ address: '0x1', atBlock: 18_000_000 });

    expect(getBalance).toHaveBeenCalledTimes(2);
  });
});

describe('configured defaults', () => {
  it('applies the default chain when a call omits one', async () => {
    const getBalance = vi.spyOn(operations, 'getBalance').mockResolvedValue({} as never);
    const sdk = createSingularity({ chain: 'base' });

    await sdk.balance({ address: '0x1' });

    expect(getBalance).toHaveBeenCalledWith(expect.objectContaining({ chain: 'base' }));
  });

  it('lets the call override the default', async () => {
    const getBalance = vi.spyOn(operations, 'getBalance').mockResolvedValue({} as never);
    const sdk = createSingularity({ chain: 'base' });

    await sdk.balance({ address: '0x1', chain: 'ethereum' });

    expect(getBalance).toHaveBeenCalledWith(expect.objectContaining({ chain: 'ethereum' }));
  });

  it('names the fix when no chain is available at all', async () => {
    const sdk = createSingularity();

    // A rejection, not a synchronous throw. Mixing the two means a caller's
    // `.catch()` silently does not run for this one failure — the API has to
    // fail the same way every time or the handling around it is guesswork.
    await expect(sdk.balance({ address: '0x1' })).rejects.toMatchObject({
      code: 'NO_CHAIN',
      hint: expect.stringMatching(/Pass `chain`/),
    });
  });

  it('applies a default budget, and lets a call override it', async () => {
    const getBalance = vi.spyOn(operations, 'getBalance').mockResolvedValue({} as never);
    const sdk = createSingularity({ chain: 'ethereum', budget: { maxItems: 8 } });

    await sdk.balance({ address: '0x1' });
    expect(getBalance).toHaveBeenLastCalledWith(expect.objectContaining({ budget: { maxItems: 8 } }));

    await sdk.balance({ address: '0x2', budget: 'full' });
    expect(getBalance).toHaveBeenLastCalledWith(expect.objectContaining({ budget: 'full' }));
  });

  it('applies default portfolio chains', async () => {
    const getPortfolio = vi.spyOn(operations, 'getPortfolio').mockResolvedValue({} as never);
    const sdk = createSingularity({ portfolioChains: ['ethereum', 'base'] });

    await sdk.portfolio({ address: '0x1' });

    expect(getPortfolio).toHaveBeenCalledWith(
      expect.objectContaining({ chains: ['ethereum', 'base'] }),
    );
  });
});

describe('retry', () => {
  it('retries a transient failure', async () => {
    let calls = 0;
    vi.spyOn(operations, 'getBalance').mockImplementation(async () => {
      calls += 1;
      if (calls < 2) throw new Error('fetch failed');
      return {} as never;
    });

    const sdk = createSingularity({ chain: 'ethereum', retry: { baseDelayMs: 1 } });
    await sdk.balance({ address: '0x1' });

    expect(calls).toBe(2);
  });

  it('`retry: false` means one attempt', async () => {
    let calls = 0;
    vi.spyOn(operations, 'getBalance').mockImplementation(async () => {
      calls += 1;
      throw new Error('fetch failed');
    });

    const sdk = createSingularity({ chain: 'ethereum', retry: false });
    await expect(sdk.balance({ address: '0x1' })).rejects.toThrow();

    expect(calls).toBe(1);
  });
});

describe('the client reports on itself', () => {
  it('counts hits and misses, and clears', async () => {
    vi.spyOn(operations, 'getBalance').mockResolvedValue({} as never);
    const sdk = createSingularity({ chain: 'ethereum' });

    await sdk.balance({ address: '0x1', atBlock: 1 });
    await sdk.balance({ address: '0x1', atBlock: 1 });

    expect(sdk.cacheStats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });

    sdk.clearCache();
    expect(sdk.cacheStats().entries).toBe(0);
  });

  it('exposes the configuration that is actually in effect', () => {
    const sdk = createSingularity({ chain: 'base', cache: { current: 5_000 } });

    expect(sdk.config.chain).toBe('base');
    expect(sdk.config.ttl.current).toBe(5_000);
    expect(sdk.config.ttl.historical).toBe(300_000); // still the default
    expect(sdk.config.signer).toBeUndefined();
  });
});
