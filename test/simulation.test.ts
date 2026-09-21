import { describe, it, expect } from 'vitest';
import { judgeDelivery } from '../src/core/simulation.js';
import type { Amount } from '../src/core/types.js';

/**
 * What a measured delivery means.
 *
 * The readings come from the adapters and are verified against mainnet in
 * `scripts/verify-builders.mjs`, which is where hand-rolled bytes belong. This
 * covers the arithmetic on top of them, and the case that matters most is the
 * one nobody can arrange on demand: a token that quietly delivers less than was
 * sent.
 */

const usdc = (whole: string): Amount => ({
  raw: String(Math.round(Number(whole) * 1e6)),
  formatted: whole,
  decimals: 6,
  symbol: 'USDC',
});

describe('a transaction that will not execute', () => {
  it('is not a delivery of zero, it is a refusal', () => {
    const out = judgeDelivery({
      chain: 'solana',
      succeeded: false,
      error: 'insufficient funds',
      expected: usdc('10'),
    });

    expect(out.succeeded).toBe(false);
    expect(out.delivered).toBeUndefined();
    expect(out.shortfall).toBeUndefined();
    expect(out.completeness.kind).toBe('failed');
    expect(out.note).toMatch(/spend a fee to fail/);
  });

  it('quotes the chain rather than paraphrasing it', () => {
    const out = judgeDelivery({ chain: 'base', succeeded: false, error: 'ERC20: transfer amount exceeds balance' });
    expect(out.note).toContain('ERC20: transfer amount exceeds balance');
  });
});

describe('a delivery that could not be measured', () => {
  const out = judgeDelivery({
    chain: 'base',
    succeeded: true,
    expected: usdc('10'),
    unmeasuredReason: 'this endpoint does not support eth_simulateV1',
  });

  it('is never reported as zero, and never as fine', () => {
    // The distinction the whole type exists for. An endpoint that would not
    // measure is not evidence that the full amount arrives.
    expect(out.delivered).toBeUndefined();
    expect(out.shortfall).toBeUndefined();
    expect(out.completeness.kind).toBe('failed');
  });

  it('says executing is not evidence the amount arrives', () => {
    expect(out.note).toMatch(/not evidence that the full amount arrives/);
    expect(out.note).toContain('eth_simulateV1');
  });
});

describe('a delivery that is short', () => {
  const out = judgeDelivery({
    chain: 'solana',
    succeeded: true,
    delivered: usdc('9.95'),
    expected: usdc('10'),
  });

  it('reports the gap in the asset that was short', () => {
    expect(out.shortfall?.raw).toBe('50000');
    expect(out.shortfall?.formatted).toBe('0.05');
    expect(out.shortfall?.symbol).toBe('USDC');
  });

  it('names both numbers, because a gap without them is not a reason', () => {
    expect(out.note).toContain('9.95');
    expect(out.note).toContain('10');
  });

  it('does NOT assert why it is short', () => {
    // A transfer fee, a skimming hook, and a transaction built for a different
    // amount than the one quoted are indistinguishable from a subtraction.
    // Naming the likeliest as though it were the finding is the unsupported
    // confidence this tool refuses everywhere else.
    expect(out.note).toMatch(/whatever causes it/);
    expect(out.note).toMatch(/equally a transaction built for a different amount/);
  });

  it('still counts as a successful execution, because it is one', () => {
    expect(out.succeeded).toBe(true);
    expect(out.completeness.kind).toBe('exhaustive');
  });
});

describe('a delivery that is exact, or more', () => {
  it('says so plainly when it matches', () => {
    const out = judgeDelivery({
      chain: 'solana',
      succeeded: true,
      delivered: usdc('10'),
      expected: usdc('10'),
    });
    expect(out.shortfall).toBeUndefined();
    expect(out.note).toMatch(/delivers exactly/);
  });

  it('does not complain when more arrives than was asked', () => {
    // A rebasing token crediting more than was sent is not a payment failure.
    const out = judgeDelivery({
      chain: 'solana',
      succeeded: true,
      delivered: usdc('11'),
      expected: usdc('10'),
    });
    expect(out.shortfall).toBeUndefined();
    expect(out.note).toMatch(/more than the 10/);
    expect(out.note).toMatch(/nothing about this payment is short/);
  });

  it('reports a measured delivery with no claim to check it against', () => {
    const out = judgeDelivery({ chain: 'solana', succeeded: true, delivered: usdc('4') });
    expect(out.expected).toBeUndefined();
    expect(out.shortfall).toBeUndefined();
    expect(out.completeness.kind).toBe('exhaustive');
    expect(out.note).toContain('4');
  });
});

describe('the units consumed', () => {
  it('is carried through when the chain reports it', () => {
    const out = judgeDelivery({
      chain: 'solana',
      succeeded: true,
      unitsConsumed: 45681,
      delivered: usdc('1'),
      expected: usdc('1'),
    });
    expect(out.unitsConsumed).toBe(45681);
  });

  it('is absent rather than zero when it does not', () => {
    const out = judgeDelivery({ chain: 'solana', succeeded: true, delivered: usdc('1') });
    expect(out.unitsConsumed).toBeUndefined();
  });
});
