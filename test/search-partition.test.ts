import { describe, it, expect } from 'vitest';
import { partitionSearch } from '../src/tools/operations.js';
import { RpcError, SingularityError } from '../src/core/errors.js';

/**
 * The difference between "it is not there" and "nobody looked".
 *
 * A cross-chain search fans out to several endpoints, and before this the
 * rejected ones were simply filtered away — after which the caller was told the
 * hash "was not found on any of" every chain in the candidate list, including
 * the ones whose RPC had just failed. Same shape as the dropped-failure bugs
 * the roadmap opens with: correct about what it did, wrong about what it
 * claimed.
 *
 * Tested here rather than against live RPCs because the case that matters most
 * is every endpoint failing at once.
 */

const notFound = () =>
  new SingularityError('TX_NOT_FOUND', 'Transaction 0xabc was not found on Base.');

const rejected = (reason: unknown): PromiseSettledResult<string> => ({
  status: 'rejected',
  reason,
});

const ok = (value: string): PromiseSettledResult<string> => ({ status: 'fulfilled', value });

describe('a chain that answered', () => {
  it('counts a hit as searched', () => {
    const { hits, searched, unreachable } = partitionSearch(['base'], [ok('tx')]);
    expect(hits).toEqual(['tx']);
    expect(searched).toEqual(['base']);
    expect(unreachable).toEqual([]);
  });

  it('counts an explicit "not here" as searched, because that is evidence', () => {
    const { hits, searched, unreachable } = partitionSearch(['base'], [rejected(notFound())]);
    expect(hits).toEqual([]);
    expect(searched).toEqual(['base']);
    expect(unreachable).toEqual([]);
  });
});

describe('a chain that did not answer', () => {
  it('is not counted as searched', () => {
    const { searched, unreachable } = partitionSearch(
      ['base'],
      [rejected(new RpcError('base', 'rate limited'))],
    );
    expect(searched).toEqual([]);
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0]?.chain).toBe('base');
  });

  it('carries the hint through, so the caller can act on it', () => {
    const { unreachable } = partitionSearch(
      ['base'],
      [rejected(new SingularityError('RPC_ERROR', 'boom', 'set your own endpoint'))],
    );
    expect(unreachable[0]?.hint).toBe('set your own endpoint');
  });

  it('handles a rejection that is not an Error at all', () => {
    const { unreachable } = partitionSearch(['base'], [rejected('just a string')]);
    expect(unreachable[0]?.error).toBe('just a string');
  });
});

describe('a mixed fan-out', () => {
  const settled = [
    ok('found-on-base'),
    rejected(notFound()),
    rejected(new RpcError('polygon', 'timeout')),
    rejected(new RpcError('bsc', 'rate limited')),
  ];

  it('separates the three outcomes rather than collapsing them', () => {
    const { hits, searched, unreachable } = partitionSearch(
      ['base', 'arbitrum', 'polygon', 'bsc'],
      settled,
    );

    expect(hits).toEqual(['found-on-base']);
    // Only the two that actually answered.
    expect(searched).toEqual(['base', 'arbitrum']);
    expect(unreachable.map((u) => u.chain)).toEqual(['polygon', 'bsc']);
  });

  it('never lists a chain as both searched and unreachable', () => {
    const { searched, unreachable } = partitionSearch(
      ['base', 'arbitrum', 'polygon', 'bsc'],
      settled,
    );
    for (const u of unreachable) expect(searched).not.toContain(u.chain);
  });

  it('accounts for every candidate exactly once', () => {
    // The invariant that makes the report trustworthy: nothing is dropped.
    const chains = ['base', 'arbitrum', 'polygon', 'bsc'];
    const { hits, searched, unreachable } = partitionSearch(chains, settled);
    expect(searched.length + unreachable.length).toBe(chains.length);
    expect(hits.length).toBeLessThanOrEqual(searched.length);
  });
});

describe('the case that was silently wrong before', () => {
  it('reports nothing as searched when every endpoint failed', () => {
    // This is the one that matters. Previously all four rejections were
    // filtered out and the caller was told the hash was "not found on any of"
    // all four — an absence asserted about chains nothing had asked.
    const chains = ['ethereum', 'base', 'arbitrum', 'polygon'];
    const { hits, searched, unreachable } = partitionSearch(
      chains,
      chains.map((c) => rejected(new RpcError(c, 'rate limited'))),
    );

    expect(hits).toEqual([]);
    expect(searched).toEqual([]);
    expect(unreachable).toHaveLength(4);
  });

  it('still reports a genuine absence when every chain answered', () => {
    const chains = ['ethereum', 'base'];
    const { searched, unreachable } = partitionSearch(
      chains,
      chains.map(() => rejected(notFound())),
    );

    expect(searched).toEqual(chains);
    expect(unreachable).toEqual([]);
  });
});
