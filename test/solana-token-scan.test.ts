import { describe, it, expect, vi } from 'vitest';

/**
 * An active Solana wallet accumulates dust: anyone can airdrop a token account
 * onto any address. These tests pin the two behaviours that keeps survivable —
 * summing the accounts that share a mint, and capping an unfiltered scan.
 */

const accounts: unknown[] = [];

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      async getParsedTokenAccountsByOwner(_owner: unknown, filter: { programId: { toBase58(): string } }) {
        // Everything is registered against the legacy token program here.
        const legacy = filter.programId.toBase58().startsWith('Tokenkeg');
        return { value: legacy ? accounts : [] };
      }
    },
  };
});

const { solanaAdapter } = await import('../src/adapters/solana.js');
const { getChain } = await import('../src/core/registry.js');

const SOLANA = getChain('solana');
const OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function account(mint: string, amount: string, decimals = 6) {
  return {
    account: {
      data: { parsed: { info: { mint, owner: OWNER, tokenAmount: { amount, decimals, uiAmountString: amount } } } },
    },
  };
}

function setAccounts(...next: unknown[]) {
  accounts.length = 0;
  accounts.push(...next);
}

/** A mint address is base58 and 32-44 chars; these only need to be distinct. */
function dustMint(i: number) {
  return `Dust${String(i).padStart(2, '0')}${'1'.repeat(32)}`;
}

describe('solana token scan', () => {
  it('sums the token accounts that share a mint', async () => {
    setAccounts(account(USDC, '1095074585'), account(USDC, '1000000'));

    const { entries } = await solanaAdapter.getTokenBalances(SOLANA, OWNER);

    expect(entries).toHaveLength(1);
    expect(entries[0].token.symbol).toBe('USDC');
    expect(entries[0].amount.raw).toBe('1096074585');
    expect(entries[0].amount.formatted).toBe('1096.074585');
    expect(entries[0].tokenAccounts).toBe(2);
  });

  it('leaves tokenAccounts unset for a single account', async () => {
    setAccounts(account(USDC, '1000000'));

    const { entries } = await solanaAdapter.getTokenBalances(SOLANA, OWNER);

    expect(entries[0].tokenAccounts).toBeUndefined();
  });

  it('skips zero balances', async () => {
    setAccounts(account(USDC, '0'), account(dustMint(1), '0'));

    const scan = await solanaAdapter.getTokenBalances(SOLANA, OWNER);

    expect(scan.entries).toHaveLength(0);
    // Empty *and* exhaustive: on Solana this really does mean "holds nothing",
    // and saying so is what makes the same empty list on a curated EVM scan
    // distinguishable from it.
    expect(scan.completeness.kind).toBe('exhaustive');
  });

  it('caps an unfiltered scan and says what it left out', async () => {
    setAccounts(account(USDC, '1000000'), ...Array.from({ length: 80 }, (_, i) => account(dustMint(i), '1')));

    const scan = await solanaAdapter.getTokenBalances(SOLANA, OWNER);

    expect(scan.entries).toHaveLength(50);
    expect(scan.completeness.kind).toBe('truncated');
    // The counts are structured, not only prose: a caller deciding whether it
    // may say "that is everything" reads these, not the sentence.
    expect(scan.completeness.shown).toBe(50);
    expect(scan.completeness.omitted).toBe(31);
    expect(scan.completeness.note).toContain('50 of 81');
    expect(scan.completeness.note).toContain('31 omitted');
    // A curated token sorts ahead of dust, however much dust there is.
    expect(scan.entries[0].token.symbol).toBe('USDC');
  });

  it('declares a complete scan exhaustive rather than returning a bare list', async () => {
    setAccounts(account(USDC, '1000000'));

    // There is deliberately no way to return a list without saying what it
    // covers. A bare array was the old shape, and a bare array is precisely
    // what reads as "this is everything" whether or not it is.
    const scan = await solanaAdapter.getTokenBalances(SOLANA, OWNER);

    expect(scan.entries).toHaveLength(1);
    expect(scan.completeness.kind).toBe('exhaustive');
  });

  it('never caps an explicitly requested token list', async () => {
    setAccounts(
      account(USDC, '1000000'),
      account(USDC, '500000'),
      ...Array.from({ length: 80 }, (_, i) => account(dustMint(i), '1')),
    );

    const scan = await solanaAdapter.getTokenBalances(SOLANA, OWNER, [USDC]);
    const entries = scan.entries;

    expect(scan.completeness.kind).toBe('exhaustive');
    expect(entries).toHaveLength(1);
    expect(entries[0].amount.raw).toBe('1500000');
    expect(entries[0].tokenAccounts).toBe(2);
  });
});
