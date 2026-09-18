import { describe, it, expect, vi, afterEach } from 'vitest';
import { cosmosAdapter } from '../src/adapters/cosmos.js';
import { getChain } from '../src/core/registry.js';

/**
 * The Cosmos bank scan had no cap at all until response shaping went in.
 *
 * That is the Solana dust bug sitting unfixed on another family: the bank
 * module enumerates every denom an account holds, IBC vouchers included, and
 * an active Osmosis address holds hundreds. Nothing bounded the list, so its
 * real ceiling was whatever the account happened to hold — and it came back
 * claiming `exhaustive`, which is the shape a caller reads as "safe to act on".
 *
 * These tests pin the cap, and pin the much more important thing: that the cap
 * is visible in `completeness` rather than only in the length of the array.
 */

const OSMOSIS = getChain('osmosis');
const OWNER = 'osmo1vvln3gz58r3nexrm76msfp9rhr3dzclcr8txn9';

/** A distinct IBC voucher denom. Only the hash needs to differ. */
function voucher(i: number): string {
  return `ibc/${String(i).padStart(4, '0')}${'A'.repeat(60)}`;
}

/**
 * Route by path: the bank balance query answers, every denom-metadata lookup
 * 404s. A chain that publishes no metadata is the common case for IBC
 * vouchers, and it keeps these tests about the cap rather than about decimals.
 */
function serveBalances(balances: Array<{ denom: string; amount: string }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/cosmos/bank/v1beta1/balances/')) {
        return new Response(JSON.stringify({ balances }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cosmos token scan', () => {
  it('returns everything and says so when the account fits', async () => {
    serveBalances([
      { denom: voucher(1), amount: '5000000' },
      { denom: voucher(2), amount: '1000000' },
    ]);

    const scan = await cosmosAdapter.getTokenBalances(OSMOSIS, OWNER);

    expect(scan.entries).toHaveLength(2);
    // Still exhaustive, and it has to be: the bank module really does
    // enumerate, so an absent denom here is genuinely not held. Capping the
    // list must not cost the one family that can make that claim honestly.
    expect(scan.completeness.kind).toBe('exhaustive');
  });

  it('caps an unfiltered scan and reports the counts', async () => {
    serveBalances(Array.from({ length: 140 }, (_, i) => ({ denom: voucher(i), amount: '1000' })));

    const scan = await cosmosAdapter.getTokenBalances(OSMOSIS, OWNER);

    expect(scan.entries).toHaveLength(50);
    expect(scan.completeness.kind).toBe('truncated');
    expect(scan.completeness.shown).toBe(50);
    expect(scan.completeness.omitted).toBe(90);
  });

  it('orders a capped scan by balance, largest first', async () => {
    // Which 50 of 140 come back has to be explicable, or the cut is arbitrary
    // and the answer is unstable between calls.
    serveBalances([
      { denom: voucher(1), amount: '1' },
      { denom: voucher(2), amount: '999999999' },
      ...Array.from({ length: 80 }, (_, i) => ({ denom: voucher(i + 10), amount: '1000' })),
    ]);

    const scan = await cosmosAdapter.getTokenBalances(OSMOSIS, OWNER);

    expect(scan.entries[0].amount.raw).toBe('999999999');
    expect(scan.completeness.note).toContain('magnitude and not value');
  });

  it('sorts amounts past 2^53 without collapsing them', async () => {
    // An eighteen-decimal denom overflows a float, and two distinct balances
    // that compare equal make the cut arbitrary. BigInt, not Number.
    const big = '100000000000000000000001';
    const bigger = '100000000000000000000002';

    serveBalances([
      { denom: voucher(1), amount: big },
      { denom: voucher(2), amount: bigger },
      ...Array.from({ length: 60 }, (_, i) => ({ denom: voucher(i + 10), amount: '1' })),
    ]);

    const scan = await cosmosAdapter.getTokenBalances(OSMOSIS, OWNER);

    expect(scan.entries[0].amount.raw).toBe(bigger);
    expect(scan.entries[1].amount.raw).toBe(big);
  });

  it('honours a small budget', async () => {
    serveBalances(Array.from({ length: 140 }, (_, i) => ({ denom: voucher(i), amount: '1000' })));

    const scan = await cosmosAdapter.getTokenBalances(OSMOSIS, OWNER, undefined, {
      budget: 'small',
    });

    expect(scan.entries).toHaveLength(10);
    expect(scan.completeness.omitted).toBe(130);
    // Says the budget cut it, so a caller knows asking again gets more.
    expect(scan.completeness.note).toContain('Raise `budget`');
  });

  it('gives a full budget more than the default, and still bounds it', async () => {
    serveBalances(Array.from({ length: 400 }, (_, i) => ({ denom: voucher(i), amount: '1000' })));

    const scan = await cosmosAdapter.getTokenBalances(OSMOSIS, OWNER, undefined, {
      budget: 'full',
    });

    expect(scan.entries).toHaveLength(200);
    // `full` is this source's maximum, never "everything" — that is the
    // 1.27 MB response, and it stays unreachable through this parameter.
    expect(scan.completeness.kind).toBe('truncated');
  });

  it('never caps an explicitly requested denom list', async () => {
    // A filtered scan is bounded by what the caller named, and it is the one
    // that has to stay exhaustive — "you asked about these three, here they
    // are" is a claim a budget must not weaken.
    serveBalances([
      { denom: voucher(1), amount: '5000000' },
      ...Array.from({ length: 140 }, (_, i) => ({ denom: voucher(i + 10), amount: '1000' })),
    ]);

    const scan = await cosmosAdapter.getTokenBalances(OSMOSIS, OWNER, [voucher(1)], {
      budget: 'small',
    });

    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0].amount.raw).toBe('5000000');
    expect(scan.completeness.kind).toBe('exhaustive');
  });

  it('still skips the native denom and zero balances', async () => {
    serveBalances([
      { denom: OSMOSIS.denom, amount: '5000000' },
      { denom: voucher(1), amount: '0' },
      { denom: voucher(2), amount: '7000000' },
    ]);

    const scan = await cosmosAdapter.getTokenBalances(OSMOSIS, OWNER);

    // The native denom is getNativeBalance's job, and a zero balance is a
    // closed position rather than a holding. Neither should have survived the
    // restructure that added the budget.
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0].amount.raw).toBe('7000000');
  });
});
