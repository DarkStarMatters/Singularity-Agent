import { describe, it, expect } from 'vitest';
import { formatUnits, parseUnits, amount, shortAddress } from '../src/core/format.js';

describe('formatUnits', () => {
  it('formats whole and fractional wei', () => {
    expect(formatUnits(1_000_000_000_000_000_000n, 18)).toBe('1');
    expect(formatUnits(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(formatUnits(0n, 18)).toBe('0');
  });

  it('handles 6-decimal tokens', () => {
    expect(formatUnits('1000000', 6)).toBe('1');
    expect(formatUnits('1234567', 6)).toBe('1.234567');
  });

  it('never renders a non-zero balance as plain zero', () => {
    // 1 wei has 18 leading fractional zeros; truncating to 8 digits would show "0".
    const dust = formatUnits(1n, 18);
    expect(dust).not.toBe('0');
    expect(Number(dust)).toBeGreaterThan(0);
  });

  it('truncates long fractions once there is a whole part to anchor them', () => {
    expect(formatUnits(1_123_456_789_123_456_789n, 18)).toBe('1.12345678');
  });

  it('handles zero-decimal assets', () => {
    expect(formatUnits(42n, 0)).toBe('42');
  });

  it('preserves the sign', () => {
    expect(formatUnits(-1_500_000_000_000_000_000n, 18)).toBe('-1.5');
  });
});

describe('parseUnits', () => {
  it('round-trips through formatUnits', () => {
    for (const value of ['1', '1.5', '0.000001', '12345.6789']) {
      expect(formatUnits(parseUnits(value, 18), 18)).toBe(value);
    }
  });

  it('pads fractional digits to the asset precision', () => {
    expect(parseUnits('1.5', 6)).toBe(1_500_000n);
    expect(parseUnits('0.000001', 6)).toBe(1n);
  });

  it('refuses silent precision loss rather than truncating', () => {
    expect(() => parseUnits('1.0000001', 6)).toThrow(/only has 6/);
  });

  it('rejects non-numeric input', () => {
    expect(() => parseUnits('abc', 18)).toThrow();
    expect(() => parseUnits('', 18)).toThrow();
    expect(() => parseUnits('1.2.3', 18)).toThrow();
  });
});

describe('amount', () => {
  it('keeps raw base units alongside the formatted value', () => {
    const result = amount('1500000', 6, 'USDC');
    expect(result).toEqual({
      raw: '1500000',
      formatted: '1.5',
      decimals: 6,
      symbol: 'USDC',
    });
  });
});

describe('shortAddress', () => {
  it('shortens long addresses and leaves short ones alone', () => {
    expect(shortAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe('0xd8dA…6045');
    expect(shortAddress('0xabc')).toBe('0xabc');
  });
});
