import { describe, it, expect } from 'vitest';
import { evmAdapter } from '../src/adapters/evm.js';
import { getChain } from '../src/core/registry.js';

/**
 * build_transfer's warnings are the only thing standing between a user and a
 * signature, so the dangerous-recipient cases are asserted directly. Using a
 * curated token (USDC) keeps these offline — decimals/symbol never hit an RPC.
 */
const base = getChain('base')!;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ALICE = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

const warningsFor = async (to: string, from?: string) =>
  (await evmAdapter.buildTransfer(base, { to, from, amount: '25', token: 'USDC' })).warnings;

describe('buildTransfer recipient warnings', () => {
  it('flags a transfer sent to the token contract itself', async () => {
    const warnings = await warningsFor(USDC_BASE);
    expect(warnings.some((w) => /contract itself/i.test(w))).toBe(true);
    expect(warnings.some((w) => /unrecoverable/i.test(w))).toBe(true);
  });

  it('flags a burn to the zero address', async () => {
    const warnings = await warningsFor('0x0000000000000000000000000000000000000000');
    expect(warnings.some((w) => /zero address/i.test(w))).toBe(true);
  });

  it('flags a self-transfer', async () => {
    const warnings = await warningsFor(ALICE, ALICE);
    expect(warnings.some((w) => /same address/i.test(w))).toBe(true);
  });

  it('stays quiet for an ordinary recipient', async () => {
    const warnings = await warningsFor(ALICE, USDC_BASE);
    expect(warnings.some((w) => /contract itself|zero address|same address/i.test(w))).toBe(false);
    // the baseline unsigned/fake-token warnings still come through
    expect(warnings.length).toBe(2);
  });
});
