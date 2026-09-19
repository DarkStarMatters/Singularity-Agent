import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  finalityFromCheckpoint,
  finalityFromCommit,
  finalityFromConfirmations,
  findFinality,
  supportsIrreversibilityClaim,
  weakestFinality,
  finality,
} from '../src/core/finality.js';
import { evmAdapter } from '../src/adapters/evm.js';
import type { ChainSpec } from '../src/core/types.js';

/**
 * Four families, four different things the word "settled" means.
 *
 * Every read in this tool used to answer about a height and present it with the
 * certainty of a receipt. The cases below are the ones where the wrong answer
 * is not merely imprecise but actively dangerous — where a gap in what we were
 * told would otherwise round up into a guarantee.
 */

const chain = (over: Partial<ChainSpec> = {}): ChainSpec => ({
  id: 'testchain',
  name: 'Test Chain',
  family: 'evm',
  chainId: 1,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpc: ['https://one.example'],
  ...over,
});

describe('chains that publish a finalized checkpoint', () => {
  it('calls a block at or below the checkpoint final', () => {
    const result = finalityFromCheckpoint({ family: 'evm', height: 100, finalizedHeight: 120 });

    expect(result.kind).toBe('final');
    expect(supportsIrreversibilityClaim(result)).toBe(true);
  });

  it('treats the checkpoint itself as final rather than as the first reversible block', () => {
    expect(finalityFromCheckpoint({ family: 'evm', height: 120, finalizedHeight: 120 }).kind).toBe(
      'final',
    );
  });

  it('calls a block above the checkpoint reversible, and says by how far', () => {
    const result = finalityFromCheckpoint({ family: 'evm', height: 130, finalizedHeight: 120 });

    expect(result.kind).toBe('reversible');
    expect(result.note).toContain('10 blocks above');
    expect(supportsIrreversibilityClaim(result)).toBe(false);
  });

  /**
   * The load-bearing case. An endpoint that does not implement the tag has told
   * us nothing, and nothing must not become "settled" — at the call site the
   * absence is indistinguishable from instant finality, which is precisely how
   * it would have turned into one.
   */
  it('answers unknown, never final, when the chain will not name a checkpoint', () => {
    const result = finalityFromCheckpoint({ family: 'evm', height: 130, finalizedHeight: null });

    expect(result.kind).toBe('unknown');
    expect(supportsIrreversibilityClaim(result)).toBe(false);
    expect(result.note).toContain('not evidence');
  });

  it('speaks in slots on Solana and blocks everywhere else', () => {
    expect(finalityFromCheckpoint({ family: 'svm', height: 5, finalizedHeight: 9 }).note).toContain(
      'Slot 5',
    );
    expect(finalityFromCheckpoint({ family: 'evm', height: 5, finalizedHeight: 9 }).note).toContain(
      'Block 5',
    );
  });
});

describe('chains that settle by accumulated work', () => {
  it('never reaches final, however deep the block is buried', () => {
    const deep = finalityFromConfirmations(1, 1_000_000);

    expect(deep.confirmations).toBe(1_000_000);
    expect(deep.kind).toBe('probabilistic');
    expect(supportsIrreversibilityClaim(deep)).toBe(false);
  });

  it('separates the mempool from a block, because they fail differently', () => {
    const pending = finalityFromConfirmations(101, 100);

    expect(pending.kind).toBe('reversible');
    expect(pending.confirmations).toBe(0);
    expect(pending.note).toContain('mempool');
  });

  it('counts the containing block as the first confirmation', () => {
    expect(finalityFromConfirmations(100, 100).confirmations).toBe(1);
  });

  it('names the conventional depth without treating it as a threshold', () => {
    const shallow = finalityFromConfirmations(100, 102);
    const settled = finalityFromConfirmations(100, 105);

    expect(shallow.note).toContain('below the conventional');
    expect(settled.note).toContain('never final');
    // Both are the same kind. The convention changes the advice, not the claim.
    expect(shallow.kind).toBe(settled.kind);
  });
});

describe('chains that finalize on commit', () => {
  it('calls a committed block final with no checkpoint to compare against', () => {
    const result = finalityFromCommit(500);

    expect(result.kind).toBe('final');
    expect(result.note).toContain('no reorganization window');
  });
});

describe('what a caller may conclude', () => {
  it('licenses an irreversibility claim on exactly one kind', () => {
    expect(supportsIrreversibilityClaim(finality.final('f'))).toBe(true);
    expect(supportsIrreversibilityClaim(finality.probabilistic(99, 'p'))).toBe(false);
    expect(supportsIrreversibilityClaim(finality.reversible('r'))).toBe(false);
    expect(supportsIrreversibilityClaim(finality.unknown('u'))).toBe(false);
    expect(supportsIrreversibilityClaim(undefined)).toBe(false);
  });

  it('takes the weakest of several, so a combined answer cannot overclaim', () => {
    const worst = weakestFinality([
      finality.final('a'),
      finality.unknown('b'),
      finality.probabilistic(9, 'c'),
    ]);

    expect(worst?.kind).toBe('unknown');
  });

  it('finds a finality by shape wherever it sits in a result', () => {
    const found = findFinality({ found: [{ hash: '0x1', finality: finality.final('deep') }] });

    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('final');
  });
});

describe('an endpoint that aliases finalized to the head', () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * The most dangerous answer this adapter could give.
   *
   * Some endpoints serve `finalized` as whatever `latest` is, so the call
   * succeeds and reports the tip. Taken at face value that says the block
   * produced one second ago is irreversible — turning "I do not implement this"
   * into "settled" for every read on the chain. A real finality gadget always
   * lags, so equality with the tip is treated as the non-answer it is.
   */
  it('reports no checkpoint rather than a checkpoint at the head', async () => {
    const block = (number: string) => ({
      number,
      hash: `0x${'11'.repeat(32)}`,
      parentHash: `0x${'22'.repeat(32)}`,
      timestamp: '0x66000000',
      transactions: [],
      uncles: [],
      nonce: '0x0000000000000000',
      sha3Uncles: `0x${'33'.repeat(32)}`,
      logsBloom: `0x${'00'.repeat(256)}`,
      transactionsRoot: `0x${'44'.repeat(32)}`,
      stateRoot: `0x${'55'.repeat(32)}`,
      receiptsRoot: `0x${'66'.repeat(32)}`,
      miner: `0x${'77'.repeat(20)}`,
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: '0x',
      size: '0x220',
      gasLimit: '0x1c9c380',
      gasUsed: '0x0',
      baseFeePerGas: '0x7',
    });

    const serve = (finalizedHex: string, latestHex: string) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string | URL, init?: { body?: string }) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as { params?: unknown[] };
          const tag = body.params?.[0];
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: block(tag === 'finalized' ? finalizedHex : latestHex),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }),
      );

    serve('0x64', '0x64');
    expect(await evmAdapter.finalizedHeight!(chain({ id: `alias-${Date.now()}` }))).toBeNull();

    // And the honest case still comes back, so the guard is not just "always null".
    serve('0x5a', '0x64');
    expect(await evmAdapter.finalizedHeight!(chain({ id: `lag-${Date.now()}` }))).toBe(90);
  });

  it('reports no checkpoint when the endpoint rejects the tag outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32602, message: 'invalid block tag' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    expect(await evmAdapter.finalizedHeight!(chain({ id: `nofinal-${Date.now()}` }))).toBeNull();
  });
});
