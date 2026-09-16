import { describe, it, expect } from 'vitest';
import {
  checkImpersonation,
  findImpersonations,
  symbolKey,
  IMPERSONATION_NOTE,
} from '../src/core/impersonation.js';
import { getChain } from '../src/core/registry.js';
import { WELL_KNOWN_TOKENS } from '../src/core/tokens.js';

/**
 * A symbol is a name, not an identity.
 *
 * Two halves, and the second matters more than the first. A gate is easy to
 * write and easy to feel good about when it is only ever measured against the
 * thing it is supposed to catch — that asymmetry is how this repo shipped an X
 * filter that dropped 18 of 24 genuine questions while passing 41 tests. So the
 * fakes are here, and so is a corpus of real tokens whose names sit right next
 * to a curated one and which must come through clean.
 */

const ethereum = getChain('ethereum');
const osmosis = getChain('osmosis');

const REAL_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ATTACKER = '0x1111111111111111111111111111111111111111';

describe('symbolKey', () => {
  it('folds away every difference a reader would not notice', () => {
    const usdc = symbolKey('USDC');

    expect(symbolKey('usdc')).toBe(usdc); // case
    expect(symbolKey(' USDC ')).toBe(usdc); // padding
    expect(symbolKey('U S D C')).toBe(usdc); // spacing
    expect(symbolKey('ＵＳＤＣ')).toBe(usdc); // fullwidth
    expect(symbolKey('ÙSDC')).toBe(usdc); // accents
    expect(symbolKey('USDС')).toBe(usdc); // Cyrillic С
    expect(symbolKey('U5DC')).toBe(usdc); // digit drawn as a letter
  });

  it('keeps a genuinely different name different', () => {
    expect(symbolKey('USDC.e')).not.toBe(symbolKey('USDC'));
    expect(symbolKey('wUSDC')).not.toBe(symbolKey('USDC'));
    expect(symbolKey('USDT')).not.toBe(symbolKey('USDC'));
  });

  it('treats punctuation as a real difference, because honest tokens use it', () => {
    // The stated limit: "USDC." goes unreported, and that is the price of not
    // reporting every USDC.e, DAI+ and WBTC.b anyone actually holds.
    expect(symbolKey('USDC.')).not.toBe(symbolKey('USDC'));
    expect(symbolKey('DAI+')).not.toBe(symbolKey('DAI'));
  });

  it('has nothing to say about a symbol that is only spacing', () => {
    expect(symbolKey('   ')).toBe('');
    expect(symbolKey('')).toBe('');
  });
});

describe('a contract wearing a curated name', () => {
  it('names the address the symbol actually belongs to', () => {
    const found = checkImpersonation(ethereum, { symbol: 'USDC', address: ATTACKER });

    expect(found?.kind).toBe('curated-token');
    expect(found?.symbol).toBe('USDC');
    // The whole value of the finding: the user cannot produce this address
    // from memory, and that is the comparison they are being asked to make.
    expect(found?.authentic).toBe(REAL_USDC);
    expect(found?.note).toContain(REAL_USDC);
    expect(found?.note).toContain(ATTACKER);
  });

  const DISGUISES = [
    ['lowercase', 'usdc'],
    ['mixed case', 'UsDc'],
    ['padded', '  USDC  '],
    ['spaced out', 'U S D C'],
    ['Cyrillic С', 'USDС'],
    ['fullwidth', 'ＵＳＤＣ'],
    ['a zero-width space in the middle', 'USD​C'],
  ] as const;

  it.each(DISGUISES)('sees through %s', (_label, symbol) => {
    expect(checkImpersonation(ethereum, { symbol, address: ATTACKER })?.symbol).toBe('USDC');
  });

  it('catches a digit standing in for a letter', () => {
    // LINK is curated on Ethereum; L1NK is the same picture.
    expect(checkImpersonation(ethereum, { symbol: 'L1NK', address: ATTACKER })?.symbol).toBe('LINK');
  });
});

describe('a contract wearing the chain that runs it', () => {
  it('flags a token calling itself the gas asset', () => {
    const found = checkImpersonation(ethereum, { symbol: 'ETH', address: ATTACKER });

    expect(found?.kind).toBe('native-asset');
    expect(found?.symbol).toBe('ETH');
    // There is no contract to point at, which is precisely the finding.
    expect(found?.authentic).toBeUndefined();
    expect(found?.note).toContain('no contract at all');
  });

  it('works on a chain with no curated tokens at all', () => {
    // Osmosis has no entry in the token map, and a tokenfactory denom reading
    // as OSMO is exactly the case that leaves.
    expect(WELL_KNOWN_TOKENS.osmosis).toBeUndefined();
    expect(checkImpersonation(osmosis, { symbol: 'OSMO', address: 'factory/osmo1abc/OSMO' })?.kind)
      .toBe('native-asset');
  });
});

describe('the honest tokens — what must come through clean', () => {
  it('says nothing about the real token at its real address', () => {
    expect(checkImpersonation(ethereum, { symbol: 'USDC', address: REAL_USDC })).toBeUndefined();
  });

  it('accepts either spelling of an EVM address, because both are the address', () => {
    // Checksum casing is a display convention, not an identity. Treating the
    // lowercase form as "a different contract" would fire on every honest
    // caller that pasted an address from a block explorer's URL bar.
    expect(
      checkImpersonation(ethereum, { symbol: 'USDC', address: REAL_USDC.toLowerCase() }),
    ).toBeUndefined();
  });

  /**
   * Real tokens, each a near-miss on a curated name. Every one of these is a
   * legitimate deployment somebody holds; flagging them would be the "defense
   * that gets switched off" failure, and it would be indistinguishable from
   * the real finding.
   */
  const REAL_NEIGHBOURS = [
    'USDC.e',
    'USDbC',
    'aUSDC',
    'wUSDC',
    'crvUSD',
    'USDe',
    'sDAI',
    'DAI+',
    'wstETH',
    'cbETH',
    'ETHx',
    'WETH9',
    'WBTC.b',
    'tBTC',
    'LINK.e',
    'USDT0',
  ];

  it.each(REAL_NEIGHBOURS)('leaves %s alone', (symbol) => {
    expect(checkImpersonation(ethereum, { symbol, address: ATTACKER })).toBeUndefined();
  });

  it('has nothing to say about a token with no readable symbol', () => {
    expect(checkImpersonation(ethereum, { symbol: '', address: ATTACKER })).toBeUndefined();
    expect(checkImpersonation(ethereum, { symbol: '   ', address: ATTACKER })).toBeUndefined();
    expect(checkImpersonation(ethereum, { symbol: '???', address: ATTACKER })).toBeUndefined();
  });
});

describe('addresses that are not hex', () => {
  const solana = getChain('solana');
  const REAL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  it('does not fold base58 case, because case is part of the identity there', () => {
    // Two mints differing only in case are two different mints. Folding here
    // would call an impersonator the real thing — a false negative, which is
    // the one direction this check cannot afford to be wrong in.
    expect(
      checkImpersonation(solana, { symbol: 'USDC', address: REAL_USDC_MINT.toLowerCase() })?.kind,
    ).toBe('curated-token');

    expect(
      checkImpersonation(solana, { symbol: 'USDC', address: REAL_USDC_MINT }),
    ).toBeUndefined();
  });
});

describe('finding collisions in a result', () => {
  const found = checkImpersonation(ethereum, { symbol: 'USDC', address: ATTACKER })!;

  it('finds them wherever they sit, by shape rather than by key name', () => {
    expect(findImpersonations({ tokens: [{ token: { impersonation: found } }] })).toHaveLength(1);
    expect(findImpersonations([{ a: { b: { anythingAtAll: found } } }])).toHaveLength(1);
    expect(findImpersonations({ tokens: [{ token: { symbol: 'USDC' } }] })).toHaveLength(0);
    expect(findImpersonations(null)).toHaveLength(0);
  });

  it('survives a result that refers to itself', () => {
    const cyclic: Record<string, unknown> = { impersonation: found };
    cyclic.self = cyclic;
    expect(findImpersonations(cyclic)).toHaveLength(1);
  });

  it('carries a standing instruction, not just a label', () => {
    expect(IMPERSONATION_NOTE).toMatch(/different contract/i);
  });
});
