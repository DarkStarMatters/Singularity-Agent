import { describe, it, expect } from 'vitest';
import { consolidate, type ConsolidatableBalance } from '../src/core/holdings.js';
import type { Amount, BalanceEntry } from '../src/core/types.js';

/**
 * What may be added to what.
 *
 * Consolidation is the whole of the cross-family portfolio, and it is entirely
 * a question of which sums are honest. Testable with no network because the
 * arithmetic is split from the reading — the cases that matter most are two
 * contracts wearing one ticker and a denom whose scale nothing declares, and
 * neither is convenient to arrange against live chains.
 */

const REAL_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FAKE_USDC = '0xdeadbeef00000000000000000000000000000001';

const ALICE = '0xAAAA000000000000000000000000000000000001';
const BOB = '0xBBBB000000000000000000000000000000000002';

const amount = (raw: string, decimals: number, symbol: string, unknown = false): Amount => ({
  raw,
  formatted: unknown ? raw : String(Number(raw) / 10 ** decimals),
  decimals: unknown ? 0 : decimals,
  symbol,
  ...(unknown ? { decimalsUnknown: true as const } : {}),
});

const native = (chain: string, address: string, raw: string, symbol = 'ETH'): BalanceEntry => ({
  chain,
  address,
  token: { symbol, decimals: 18, native: true },
  amount: amount(raw, 18, symbol),
});

const token = (
  chain: string,
  address: string,
  raw: string,
  opts: { contract: string; symbol: string; decimals?: number; untrusted?: boolean },
): BalanceEntry => ({
  chain,
  address,
  token: {
    address: opts.contract,
    symbol: opts.symbol,
    decimals: opts.decimals ?? 6,
    native: false,
    ...(opts.untrusted ? { untrusted: true as const } : {}),
  },
  amount: amount(raw, opts.decimals ?? 6, opts.symbol),
});

const balance = (n: BalanceEntry, tokens: BalanceEntry[] = []): ConsolidatableBalance => ({
  native: n,
  tokens,
});

const find = (holdings: ReturnType<typeof consolidate>, symbol: string) =>
  holdings.filter((h) => h.symbol === symbol);

describe('the one sum that is honest', () => {
  it('adds the same token on the same chain across addresses', () => {
    const holdings = consolidate([
      balance(native('ethereum', ALICE, '0'), [
        token('ethereum', ALICE, '1000000', { contract: REAL_USDC, symbol: 'USDC' }),
      ]),
      balance(native('ethereum', BOB, '0'), [
        token('ethereum', BOB, '2500000', { contract: REAL_USDC, symbol: 'USDC' }),
      ]),
    ]);

    const usdc = find(holdings, 'USDC')[0];
    expect(usdc?.chains).toHaveLength(1);
    expect(usdc?.chains[0]?.total.raw).toBe('3500000');
    expect(usdc?.chains[0]?.addresses).toHaveLength(2);
    expect(usdc?.spansChains).toBe(false);
  });

  it('sums the native asset across wallets on one chain', () => {
    const holdings = consolidate([
      balance(native('ethereum', ALICE, '1000000000000000000')),
      balance(native('ethereum', BOB, '500000000000000000')),
    ]);
    expect(find(holdings, 'ETH')[0]?.chains[0]?.total.raw).toBe('1500000000000000000');
  });
});

describe('what it refuses to add', () => {
  it('does not sum the same ticker across chains', () => {
    // Different contracts, different issuers of record. Holding one is not
    // holding the other, and a single number would say it was.
    const holdings = consolidate([
      balance(native('ethereum', ALICE, '0'), [
        token('ethereum', ALICE, '1000000', { contract: REAL_USDC, symbol: 'USDC' }),
      ]),
      balance(native('base', ALICE, '0'), [
        token('base', ALICE, '4000000', { contract: BASE_USDC, symbol: 'USDC' }),
      ]),
    ]);

    const usdc = find(holdings, 'USDC')[0];
    expect(usdc?.spansChains).toBe(true);
    expect(usdc?.chains).toHaveLength(2);
    expect(usdc?.chains.map((c) => c.total.raw).sort()).toEqual(['1000000', '4000000']);
    // No field anywhere carries a combined figure.
    expect(JSON.stringify(usdc)).not.toContain('5000000');
    expect(usdc?.note).toMatch(/different tokens/);
  });

  it('does not sum a native asset across chains either', () => {
    const holdings = consolidate([
      balance(native('ethereum', ALICE, '1000000000000000000')),
      balance(native('base', ALICE, '2000000000000000000')),
    ]);

    const eth = find(holdings, 'ETH')[0];
    expect(eth?.spansChains).toBe(true);
    expect(eth?.chains).toHaveLength(2);
    expect(eth?.note).toMatch(/not added together/);
  });

  it('does NOT merge an impersonating token into the real one', () => {
    // The operation a fake token is deployed hoping somebody performs. A
    // contract whose symbol was read off the chain is keyed by address and
    // stands alone, however familiar the ticker looks.
    const holdings = consolidate([
      balance(native('ethereum', ALICE, '0'), [
        token('ethereum', ALICE, '1000000', { contract: REAL_USDC, symbol: 'USDC' }),
        token('ethereum', ALICE, '999999000000', {
          contract: FAKE_USDC,
          symbol: 'USDC',
          untrusted: true,
        }),
      ]),
    ]);

    const rows = find(holdings, 'USDC');
    expect(rows).toHaveLength(2);

    const real = rows.find((r) => !r.untrusted);
    const fake = rows.find((r) => r.untrusted);

    expect(real?.chains[0]?.total.raw).toBe('1000000');
    expect(fake?.chains[0]?.total.raw).toBe('999999000000');
    expect(fake?.note).toMatch(/read off the contract/);
  });

  it('keeps two untrusted tokens with the same ticker apart from each other', () => {
    const holdings = consolidate([
      balance(native('ethereum', ALICE, '0'), [
        token('ethereum', ALICE, '1', { contract: FAKE_USDC, symbol: 'MOON', untrusted: true }),
        token('ethereum', ALICE, '2', {
          contract: '0xdeadbeef00000000000000000000000000000002',
          symbol: 'MOON',
          untrusted: true,
        }),
      ]),
    ]);
    expect(find(holdings, 'MOON')).toHaveLength(2);
  });
});

describe('amounts it cannot scale', () => {
  it('sums an unknown-decimals denom in base units and says so', () => {
    // A Cosmos denom nothing declares decimals for. Formatting the sum against
    // a guessed exponent would make a guess indistinguishable from a reading.
    const weird: BalanceEntry = {
      chain: 'cosmos',
      address: ALICE,
      token: { address: 'ibc/ABC', symbol: 'ibc/ABC', native: false },
      amount: amount('100', 0, 'ibc/ABC', true),
    };
    const more: BalanceEntry = { ...weird, address: BOB, amount: amount('250', 0, 'ibc/ABC', true) };

    const holdings = consolidate([balance(native('cosmos', ALICE, '0', 'ATOM'), [weird]), balance(native('cosmos', BOB, '0', 'ATOM'), [more])]);
    const row = find(holdings, 'ibc/ABC')[0];

    expect(row?.chains[0]?.total.raw).toBe('350');
    expect(row?.chains[0]?.total.formatted).toBe('350');
    expect(row?.chains[0]?.total.decimalsUnknown).toBe(true);
  });
});

describe('what gets left out and how it is ordered', () => {
  it('drops zero balances rather than listing empty chains', () => {
    const holdings = consolidate([balance(native('ethereum', ALICE, '0'))]);
    expect(holdings).toEqual([]);
  });

  it('puts native assets first, then named tokens, then self-named ones', () => {
    const holdings = consolidate([
      balance(native('ethereum', ALICE, '1'), [
        token('ethereum', ALICE, '1', { contract: FAKE_USDC, symbol: 'ZZZ', untrusted: true }),
        token('ethereum', ALICE, '1', { contract: REAL_USDC, symbol: 'AAA' }),
      ]),
    ]);

    expect(holdings.map((h) => h.symbol)).toEqual(['ETH', 'AAA', 'ZZZ']);
  });

  it('records how many token accounts a Solana balance summed', () => {
    const entry: BalanceEntry = {
      chain: 'solana',
      address: ALICE,
      token: { address: 'Mint111', symbol: 'FOO', decimals: 6, native: false },
      amount: amount('500', 6, 'FOO'),
      tokenAccounts: 3,
    };
    const holdings = consolidate([balance(native('solana', ALICE, '0', 'SOL'), [entry])]);
    expect(holdings[0]?.chains[0]?.addresses[0]?.tokenAccounts).toBe(3);
  });
});
