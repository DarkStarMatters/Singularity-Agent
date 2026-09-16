import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Historical reads have one failure mode that matters more than the rest:
 * answering with *current* state and labelling it as the past. Nothing
 * downstream can detect that, so every path below is asserted to either serve
 * the requested height or raise — never to quietly fall back.
 */

/** Swapped per test; every mocked viem call routes through here. */
let evmHandler: (call: string, args: Record<string, unknown>) => unknown = () => 0n;

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      getBalance: (args: Record<string, unknown>) =>
        Promise.resolve().then(() => evmHandler('getBalance', args)),
      readContract: (args: Record<string, unknown>) =>
        Promise.resolve().then(() => evmHandler('readContract', args)),
      getBlockNumber: () => Promise.resolve().then(() => evmHandler('getBlockNumber', {})),
    }),
  };
});

const { evmAdapter } = await import('../src/adapters/evm.js');
const { solanaAdapter } = await import('../src/adapters/solana.js');
const { bitcoinAdapter } = await import('../src/adapters/bitcoin.js');
const { cosmosAdapter } = await import('../src/adapters/cosmos.js');
const { getChain } = await import('../src/core/registry.js');
const { parseAtBlock, getBalance } = await import('../src/tools/operations.js');
const { SingularityError } = await import('../src/core/errors.js');

const ETHEREUM = getChain('ethereum');
const SOLANA = getChain('solana');
const BITCOIN = getChain('bitcoin');
const COSMOS = getChain('cosmoshub');

const ALICE = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL_OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BTC_OWNER = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const ATOM_OWNER = 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu';

/** Capture the error a promise rejects with, typed. */
async function failure(run: () => Promise<unknown>): Promise<InstanceType<typeof SingularityError>> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(SingularityError);
    return err as InstanceType<typeof SingularityError>;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('parseAtBlock', () => {
  it('treats "latest" and an empty value as current state, not as a height', () => {
    // These must collapse to undefined so nothing below mistakes a
    // current-state read for a served historical one.
    expect(parseAtBlock('latest')).toBeUndefined();
    expect(parseAtBlock('LATEST')).toBeUndefined();
    expect(parseAtBlock('')).toBeUndefined();
    expect(parseAtBlock(undefined)).toBeUndefined();
    expect(parseAtBlock(null)).toBeUndefined();
  });

  it('accepts a height as a number or a decimal string', () => {
    expect(parseAtBlock(19_000_000)).toBe(19_000_000);
    expect(parseAtBlock('19000000')).toBe(19_000_000);
    expect(parseAtBlock(' 42 ')).toBe(42);
  });

  it('rejects a block hash rather than passing it down', () => {
    let err: InstanceType<typeof SingularityError> | undefined;
    try {
      parseAtBlock(`0x${'ab'.repeat(32)}`);
    } catch (e) {
      err = e as InstanceType<typeof SingularityError>;
    }

    expect(err?.code).toBe('BAD_BLOCK_REF');
    expect(err?.hint).toMatch(/decimal height/i);
  });

  it('rejects block tags, which only some families could honour', () => {
    expect(() => parseAtBlock('safe')).toThrow(/not a block height/i);
    expect(() => parseAtBlock('finalized')).toThrow(/not a block height/i);
  });

  it('rejects a height beyond safe integer range', () => {
    expect(() => parseAtBlock('99999999999999999999')).toThrow(/out of range/i);
  });
});

describe('EVM historical reads', () => {
  afterEach(() => {
    evmHandler = () => 0n;
  });

  it('sends the requested height to the node and reports it back', async () => {
    const seen: Record<string, unknown>[] = [];
    evmHandler = (call, args) => {
      seen.push({ call, ...args });
      return 1_500_000_000_000_000_000n;
    };

    const entry = await evmAdapter.getNativeBalance(ETHEREUM, ALICE, { atBlock: 19_000_000 });

    expect(seen[0]?.blockNumber).toBe(19_000_000n);
    expect(entry.amount.formatted).toBe('1.5');
    // The echo is what lets a caller tell history from "now".
    expect(entry.atBlock).toBe(19_000_000);
  });

  it('omits the block field entirely for a current-state read', async () => {
    const seen: Record<string, unknown>[] = [];
    evmHandler = (call, args) => {
      seen.push({ call, ...args });
      return 0n;
    };

    const entry = await evmAdapter.getNativeBalance(ETHEREUM, ALICE);

    expect('blockNumber' in (seen[0] ?? {})).toBe(false);
    expect(entry.atBlock).toBeUndefined();
  });

  it('names a pruned endpoint rather than returning current state', async () => {
    evmHandler = (call) => {
      if (call === 'getBlockNumber') return 21_000_000n;
      throw new Error('missing trie node 0xabc (path ) state is not available');
    };

    const err = await failure(() =>
      evmAdapter.getNativeBalance(ETHEREUM, ALICE, { atBlock: 19_000_000 }),
    );

    expect(err.code).toBe('HISTORICAL_STATE_UNAVAILABLE');
    expect(err.hint).toMatch(/archive node/i);
  });

  it('distinguishes a block the chain has not reached from a pruned one', async () => {
    evmHandler = (call) => {
      if (call === 'getBlockNumber') return 19_000_000n;
      throw new Error('header not found');
    };

    const err = await failure(() =>
      evmAdapter.getNativeBalance(ETHEREUM, ALICE, { atBlock: 99_000_000 }),
    );

    // Same node error, opposite fix: wait, rather than swap endpoints.
    expect(err.code).toBe('BLOCK_NOT_YET_MINED');
    expect(err.message).toMatch(/19000000/);
    expect(err.hint).toMatch(/not an empty balance/i);
  });

  it('leaves an unrelated RPC failure as an RPC failure', async () => {
    evmHandler = () => {
      throw new Error('429 Too Many Requests');
    };

    const err = await failure(() =>
      evmAdapter.getNativeBalance(ETHEREUM, ALICE, { atBlock: 19_000_000 }),
    );

    expect(err.code).toBe('RPC_ERROR');
  });

  it('raises when a historical token scan is pruned, instead of returning an empty list', async () => {
    evmHandler = (call) => {
      if (call === 'getBlockNumber') return 21_000_000n;
      throw new Error('missing trie node');
    };

    // The trap: every balanceOf fails, the per-token filter drops them all, and
    // "[]" reads as "this wallet held no tokens then".
    const err = await failure(() =>
      evmAdapter.getTokenBalances(ETHEREUM, ALICE, undefined, { atBlock: 19_000_000 }),
    );

    expect(err.code).toBe('HISTORICAL_STATE_UNAVAILABLE');
  });

  it('still drops a single dead token contract in a historical scan', async () => {
    const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    evmHandler = (call, args) => {
      if (call !== 'readContract') return 0n;
      if (String(args.address).toLowerCase() !== usdc.toLowerCase()) {
        throw new Error('execution reverted');
      }
      return args.functionName === 'balanceOf' ? 250_000n : 0n;
    };

    const scan = await evmAdapter.getTokenBalances(ETHEREUM, ALICE, undefined, {
      atBlock: 19_000_000,
    });
    const entries = Array.isArray(scan) ? scan : scan.entries;

    expect(entries).toHaveLength(1);
    expect(entries[0]?.token.symbol).toBe('USDC');
    expect(entries[0]?.atBlock).toBe(19_000_000);
  });

  it('passes the height through a contract read', async () => {
    const seen: Record<string, unknown>[] = [];
    evmHandler = (call, args) => {
      seen.push({ call, ...args });
      return 123n;
    };

    const result = await evmAdapter.readContract?.(ETHEREUM, {
      address: ALICE,
      method: 'totalSupply',
      abi: 'function totalSupply() view returns (uint256)',
      atBlock: 19_000_000,
    });

    expect(result).toBe(123n);
    expect(seen[0]?.blockNumber).toBe(19_000_000n);
  });
});

describe('families that cannot address past state', () => {
  it('refuses a Solana balance at a slot rather than answering with the current one', async () => {
    const err = await failure(() =>
      solanaAdapter.getNativeBalance(SOLANA, SOL_OWNER, { atBlock: 250_000_000 }),
    );

    expect(err.code).toBe('HISTORICAL_STATE_UNSUPPORTED');
    expect(err.hint).toMatch(/minContextSlot/);
  });

  it('refuses a Solana token scan at a slot', async () => {
    const err = await failure(() =>
      solanaAdapter.getTokenBalances(SOLANA, SOL_OWNER, undefined, { atBlock: 250_000_000 }),
    );

    expect(err.code).toBe('HISTORICAL_STATE_UNSUPPORTED');
  });

  it('refuses a Solana account read at a slot', async () => {
    const err = await failure(() =>
      solanaAdapter.readContract!(SOLANA, { address: SOL_OWNER, atBlock: 250_000_000 }),
    );

    expect(err.code).toBe('HISTORICAL_STATE_UNSUPPORTED');
  });

  it('refuses a Bitcoin balance at a height', async () => {
    const err = await failure(() =>
      bitcoinAdapter.getNativeBalance(BITCOIN, BTC_OWNER, { atBlock: 800_000 }),
    );

    expect(err.code).toBe('HISTORICAL_STATE_UNSUPPORTED');
    expect(err.hint).toMatch(/balance-at-height/i);
  });

  it('points the caller at the working call instead of leaving them stuck', async () => {
    const err = await failure(() =>
      solanaAdapter.getNativeBalance(SOLANA, SOL_OWNER, { atBlock: 1 }),
    );

    expect(err.hint).toMatch(/Drop .atBlock./);
  });
});

describe('Cosmos historical reads', () => {
  const coins = JSON.stringify({ balances: [{ denom: 'uatom', amount: '1500000' }] });

  function stubFetch(init: ResponseInit) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(coins, init)),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it('asks for the height and trusts the answer when the endpoint confirms it', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(coins, {
          status: 200,
          headers: { 'grpc-metadata-x-cosmos-block-height': '12000000' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const entry = await cosmosAdapter.getNativeBalance(COSMOS, ATOM_OWNER, {
      atBlock: 12_000_000,
    });

    const sent = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(sent.headers['x-cosmos-block-height']).toBe('12000000');
    expect(entry.amount.formatted).toBe('1.5');
    expect(entry.atBlock).toBe(12_000_000);
  });

  it('rejects an endpoint that answers without saying which height it served', async () => {
    // A proxy that strips the header would otherwise hand back current state
    // under a historical label — indistinguishable from a real answer.
    stubFetch({ status: 200 });

    const err = await failure(() =>
      cosmosAdapter.getNativeBalance(COSMOS, ATOM_OWNER, { atBlock: 12_000_000 }),
    );

    expect(err.code).toBe('HISTORICAL_STATE_UNAVAILABLE');
    expect(err.hint).toMatch(/which height it served/i);
  });

  it('rejects an endpoint that silently served a different height', async () => {
    stubFetch({
      status: 200,
      headers: { 'grpc-metadata-x-cosmos-block-height': '21000000' },
    });

    const err = await failure(() =>
      cosmosAdapter.getNativeBalance(COSMOS, ATOM_OWNER, { atBlock: 12_000_000 }),
    );

    expect(err.code).toBe('HISTORICAL_STATE_UNAVAILABLE');
    expect(err.hint).toMatch(/served height 21000000/i);
  });

  it('reports every endpoint refusing the height as a missing archive, not a transport fault', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('height is not available', { status: 400 })),
    );

    const err = await failure(() =>
      cosmosAdapter.getNativeBalance(COSMOS, ATOM_OWNER, { atBlock: 12_000_000 }),
    );

    expect(err.code).toBe('HISTORICAL_STATE_UNAVAILABLE');
    expect(err.hint).toMatch(/archive node/i);
  });

  it('sends no height header at all for a current-state read', async () => {
    const fetchMock = vi.fn(async () => new Response(coins, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const entry = await cosmosAdapter.getNativeBalance(COSMOS, ATOM_OWNER);

    const sent = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(sent.headers['x-cosmos-block-height']).toBeUndefined();
    expect(entry.atBlock).toBeUndefined();
  });
});

describe('getBalance at a past block', () => {
  afterEach(() => {
    evmHandler = () => 0n;
  });

  it('echoes the height and says what the token list omits at it', async () => {
    evmHandler = (call, args) => {
      if (call === 'getBalance') return 2_000_000_000_000_000_000n;
      return args.functionName === 'balanceOf' ? 0n : 0n;
    };

    const result = await getBalance({
      address: ALICE,
      chain: 'ethereum',
      atBlock: '19000000',
    });

    expect(result.atBlock).toBe(19_000_000);
    expect(result.native.amount.formatted).toBe('2');
    expect(result.tokenScanNote).toMatch(/read at block 19000000/i);
    expect(result.tokenScanNote).toMatch(/did not exist yet/i);
  });

  it('never carries a block when the read was current state', async () => {
    const result = await getBalance({ address: ALICE, chain: 'ethereum' });

    expect(result.atBlock).toBeUndefined();
    expect(result.tokenScanNote ?? '').not.toMatch(/block/i);
  });

  it('fails the whole call rather than pairing a past balance with current tokens', async () => {
    evmHandler = (call) => {
      if (call === 'getBalance') return 2_000_000_000_000_000_000n;
      if (call === 'getBlockNumber') return 21_000_000n;
      throw new Error('missing trie node');
    };

    // Current state normally degrades a failed token scan into a note. At a
    // past block that would silently splice two points in time together.
    const err = await failure(() =>
      getBalance({ address: ALICE, chain: 'ethereum', atBlock: 19_000_000 }),
    );

    expect(err.code).toBe('HISTORICAL_STATE_UNAVAILABLE');
  });

  it('still degrades a failed token scan to a note for a current-state read', async () => {
    evmHandler = (call) => {
      if (call === 'getBalance') return 0n;
      throw new Error('execution reverted');
    };

    const result = await getBalance({ address: ALICE, chain: 'ethereum' });

    expect(result.tokens).toEqual([]);
    expect(result.tokenScanNote).toMatch(/curated list/i);
  });
});
