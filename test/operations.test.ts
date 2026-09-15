import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Name resolution is shared by every entry point that takes an "address".
 * These tests stub the network so they assert routing, not chain state.
 */
const resolveName = vi.fn();
const getNativeBalance = vi.fn();
const getTokenBalances = vi.fn();

vi.mock('../src/adapters/index.js', () => ({
  adapterFor: () => ({
    family: 'evm',
    isValidAddress: (_c: unknown, a: string) => /^0x[0-9a-fA-F]{40}$/.test(a),
    addressExpectation: () => 'Expected 0x followed by 40 hex characters.',
    resolveName,
    lookupName: vi.fn().mockResolvedValue(null),
    getNativeBalance,
    getTokenBalances,
    getTransaction: vi.fn(),
    getBlock: vi.fn(),
    estimateFees: vi.fn(),
    buildTransfer: vi.fn(),
  }),
  adapterForFamily: vi.fn(),
}));

const ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

beforeEach(() => {
  resolveName.mockResolvedValue(ADDRESS);
  getNativeBalance.mockImplementation((chain: { id: string }) => ({
    chain: chain.id,
    address: ADDRESS,
    token: { name: 'Ether', symbol: 'ETH', decimals: 18, native: true },
    amount: { raw: '0', formatted: '0', decimals: 18, symbol: 'ETH' },
  }));
  getTokenBalances.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe('getPortfolio', () => {
  it('resolves an ENS name before deciding which chains apply', async () => {
    const { getPortfolio } = await import('../src/tools/operations.js');

    const result = await getPortfolio({
      address: 'vitalik.eth',
      chains: ['ethereum', 'base'],
      includeTokens: false,
    });

    // The regression: a name reached isValidAddress unresolved, matched nothing,
    // and the whole call died with NO_MATCHING_CHAINS.
    expect(resolveName).toHaveBeenCalled();
    expect(result.address).toBe(ADDRESS);
    expect(result.chainsQueried).toEqual(['ethereum', 'base']);
    expect(result.balances).toHaveLength(2);
  });

  it('passes a plain address straight through without a name lookup', async () => {
    const { getPortfolio } = await import('../src/tools/operations.js');

    const result = await getPortfolio({
      address: ADDRESS,
      chains: ['ethereum'],
      includeTokens: false,
    });

    expect(resolveName).not.toHaveBeenCalled();
    expect(result.address).toBe(ADDRESS);
  });

  it('reports an unresolvable name as a name problem, not a chain problem', async () => {
    resolveName.mockResolvedValue(null);
    const { getPortfolio } = await import('../src/tools/operations.js');

    await expect(
      getPortfolio({ address: 'definitely-not-registered.eth', chains: ['ethereum'] }),
    ).rejects.toMatchObject({ code: 'NAME_NOT_RESOLVED' });
  });

  it('names the chains an address does work on when none of the requested ones match', async () => {
    const { getPortfolio } = await import('../src/tools/operations.js');

    // A Solana address against EVM-only chains.
    await expect(
      getPortfolio({ address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', chains: ['ethereum'] }),
    ).rejects.toMatchObject({ code: 'NO_MATCHING_CHAINS' });
  });
});
