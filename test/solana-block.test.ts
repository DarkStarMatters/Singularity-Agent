import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * web3.js has no response validator for a `transactionDetails: 'signatures'`
 * request, so asking `getBlock` for one parses the reply against the full-block
 * struct and throws on the absent `transactions` array. These tests pin the
 * working call shape, and the boundary between "this slot has no block" (a fact
 * about the chain) and "this endpoint is unwell" (worth another endpoint).
 */

type Reply = { kind: 'ok' } | { kind: 'throw'; err: unknown };

let reply: Reply = { kind: 'ok' };
let calls: string[] = [];

const SIGNATURES = ['sigA', 'sigB', 'sigC'];

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      constructor(private endpoint: string) {}
      async getSlot() {
        return 370_000_000;
      }
      async getBlock() {
        throw new Error('getBlock must not be used — it cannot parse a signatures-only reply');
      }
      async getBlockSignatures(slot: number) {
        calls.push(`${new URL(this.endpoint).host}:${slot}`);
        if (reply.kind === 'throw') throw reply.err;
        return {
          blockhash: 'Hash11111111111111111111111111111111111111',
          previousBlockhash: 'Prev1111111111111111111111111111111111111',
          parentSlot: slot - 1,
          blockTime: 1_757_000_000,
          signatures: SIGNATURES,
        };
      }
    },
  };
});

const { solanaAdapter } = await import('../src/adapters/solana.js');
const { getChain } = await import('../src/core/registry.js');

const SOLANA = getChain('solana');

function rpcError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  reply = { kind: 'ok' };
  calls = [];
});

describe('solana getBlock', () => {
  it('reads the latest slot through the signatures-only call', async () => {
    const block = await solanaAdapter.getBlock(SOLANA, 'latest');

    expect(block.number).toBe(370_000_000);
    expect(block.txCount).toBe(SIGNATURES.length);
    expect(block.parentHash).toBe('Prev1111111111111111111111111111111111111');
    expect(calls).toHaveLength(1);
  });

  it('addresses an explicit slot', async () => {
    const block = await solanaAdapter.getBlock(SOLANA, 12345);

    expect(block.number).toBe(12345);
    expect(calls).toEqual(['api.mainnet-beta.solana.com:12345']);
  });

  it.each([
    ['a skipped slot', rpcError(-32009, 'Slot 12345 was skipped, or missing due to ledger jump')],
    ['a pruned slot', rpcError(-32007, 'Slot 12345 was skipped')],
    ['a null result', new Error('Block 12345 not found')],
  ])('reports %s as not found without burning the other endpoints', async (_label, err) => {
    reply = { kind: 'throw', err };

    await expect(solanaAdapter.getBlock(SOLANA, 12345)).rejects.toMatchObject({
      code: 'BLOCK_NOT_FOUND',
    });
    expect(calls).toHaveLength(1);
  });

  it('fails over when an endpoint is unwell', async () => {
    reply = { kind: 'throw', err: rpcError(429, '429 Too Many Requests') };

    await expect(solanaAdapter.getBlock(SOLANA, 12345)).rejects.toMatchObject({
      code: 'RPC_ERROR',
    });
    expect(calls).toHaveLength(SOLANA.rpc.length);
  });

  it('rejects a block hash, which Solana does not address blocks by', async () => {
    await expect(solanaAdapter.getBlock(SOLANA, 'Hash111')).rejects.toMatchObject({
      code: 'BAD_BLOCK_REF',
    });
    expect(calls).toHaveLength(0);
  });
});
