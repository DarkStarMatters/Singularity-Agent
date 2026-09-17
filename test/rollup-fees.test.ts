import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A rollup charges twice.
 *
 * Once for executing the transaction on the L2, which is what `gasPrice` covers,
 * and once for posting its bytes to Ethereum, which is not. The fee estimate here
 * claims to answer "what a simple transfer costs right now", and for months it
 * answered the first half of that on every rollup it supports.
 *
 * How wrong that is depends entirely on Ethereum rather than on the L2, so it
 * cannot be measured once and remembered. On one afternoon across the OP-stack
 * chains in this registry, the L1 share ran from a rounding error on Base to 249
 * times the L2 fee on Fraxtal — where the estimate read 0.00000002 FRAX against a
 * real cost of 0.00000506.
 */

const readContract = vi.fn();
const estimateFeesPerGas = vi.fn();
const getGasPrice = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({ readContract, estimateFeesPerGas, getGasPrice }),
  };
});

const { evmAdapter } = await import('../src/adapters/evm.js');
const { getChain } = await import('../src/core/registry.js');

beforeEach(() => {
  vi.clearAllMocks();
  // 1 gwei, so a 21000-gas transfer executes for 0.000021 ETH.
  estimateFeesPerGas.mockResolvedValue({
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
  });
  getGasPrice.mockResolvedValue(1_000_000_000n);
});

describe('what a transfer costs on a rollup', () => {
  it('adds what posting the transaction to Ethereum costs', async () => {
    // Five times the execution fee, which is an ordinary afternoon on a chain
    // whose L1 share is high.
    readContract.mockResolvedValue(105_000_000_000_000n);

    const fees = await evmAdapter.estimateFees(getChain('fraxtal'));

    expect(fees.simpleTransfer?.raw).toBe('126000000000000');
    expect(fees.details.l2ExecutionFee).toBe('0.000021');
    expect(fees.details.l1DataFee).toBe('0.000105');
    expect(fees.note).toMatch(/posting the transaction to Ethereum/i);
  });

  it('says it is an estimate, because it is priced against a sample', async () => {
    readContract.mockResolvedValue(105_000_000_000_000n);

    const fees = await evmAdapter.estimateFees(getChain('base'));

    // The L1 fee depends on the byte count of the transaction being posted, so
    // a fixed sample gives an approximation rather than a quote.
    expect(fees.note).toMatch(/estimate and not a quote/i);
  });

  it('leaves an L1 alone, and does not invent the split', async () => {
    // Ethereum has no gas price oracle at that address, so the call throws.
    readContract.mockRejectedValue(new Error('execution reverted'));

    const fees = await evmAdapter.estimateFees(getChain('ethereum'));

    expect(fees.simpleTransfer?.raw).toBe('21000000000000');
    // Absent rather than zero: a chain that does not work this way has no
    // second component, and showing one as 0 implies it was measured.
    expect(fees.details.l1DataFee).toBeUndefined();
    expect(fees.details.l2ExecutionFee).toBeUndefined();
    expect(fees.note).not.toMatch(/posting the transaction/i);
  });

  it('does not fail a fee estimate over the component it could not read', async () => {
    // An oracle that times out is not evidence that the fee is zero — but a
    // fee estimate that refuses to answer at all is worse than one missing a
    // part it names. The L2 half is still true.
    readContract.mockRejectedValue(new Error('request timed out'));

    const fees = await evmAdapter.estimateFees(getChain('mode'));

    expect(fees.simpleTransfer?.raw).toBe('21000000000000');
  });

  it('keeps the whole fee when the oracle reports nothing to post', async () => {
    readContract.mockResolvedValue(0n);

    const fees = await evmAdapter.estimateFees(getChain('optimism'));

    // A real zero and an unreadable oracle land in the same place, which is
    // the honest outcome: both mean the L2 fee is all this tool can show.
    expect(fees.simpleTransfer?.raw).toBe('21000000000000');
    expect(fees.details.l1DataFee).toBeUndefined();
  });
});
