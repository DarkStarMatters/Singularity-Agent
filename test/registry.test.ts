import { describe, it, expect, afterEach } from 'vitest';
import { allChains, getChain, chainsByFamily, resetRegistry } from '../src/core/registry.js';
import { UnknownChainError } from '../src/core/errors.js';
import { decodeCalldata, decodeWithAbi } from '../src/core/abi.js';

afterEach(() => {
  delete process.env.SINGULARITY_RPC_BASE;
  resetRegistry();
});

describe('chain lookup', () => {
  it('resolves by canonical id', () => {
    expect(getChain('base').name).toBe('Base');
  });

  it('resolves by alias', () => {
    expect(getChain('eth').id).toBe('ethereum');
    expect(getChain('btc').id).toBe('bitcoin');
    expect(getChain('matic').id).toBe('polygon');
  });

  it('resolves by numeric EVM chain id', () => {
    expect(getChain(8453).id).toBe('base');
    expect(getChain('42161').id).toBe('arbitrum');
  });

  it('resolves by Cosmos chain-id string', () => {
    expect(getChain('osmosis-1').id).toBe('osmosis');
  });

  it('is case insensitive', () => {
    expect(getChain('ETH').id).toBe('ethereum');
  });

  it('suggests near misses on an unknown chain', () => {
    try {
      getChain('etherium');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownChainError);
      expect((err as UnknownChainError).hint).toContain('ethereum');
    }
  });
});

describe('families', () => {
  it('groups every chain under exactly one family', () => {
    const total = allChains().length;
    const grouped =
      chainsByFamily('evm').length +
      chainsByFamily('svm').length +
      chainsByFamily('utxo').length +
      chainsByFamily('cosmos').length;
    expect(grouped).toBe(total);
  });
});

describe('the chains added in Phase 3', () => {
  // Each of these was checked against live endpoints before it was written
  // down: the chain id it reports, a block within the last few seconds, and
  // two independent providers answering. A chain that cannot meet the bar does
  // not ship at reduced quality.
  const added = [
    { id: 'blast', chainId: 81457, symbol: 'ETH' },
    { id: 'mantle', chainId: 5000, symbol: 'MNT' },
    { id: 'mode', chainId: 34443, symbol: 'ETH' },
    { id: 'fraxtal', chainId: 252, symbol: 'FRAX' },
    { id: 'opbnb', chainId: 204, symbol: 'BNB' },
  ];

  it('resolves each one by id and by numeric chain id', () => {
    for (const { id, chainId } of added) {
      expect(getChain(id).id).toBe(id);
      expect(getChain(chainId).id).toBe(id);
    }
  });

  it('names the right gas asset, including the one that is easy to get wrong', () => {
    for (const { id, symbol } of added) {
      expect(getChain(id).nativeCurrency.symbol).toBe(symbol);
    }

    // Fraxtal's gas token is FRAX, not frxETH. Every fee on the chain is quoted
    // in it, so the obvious guess would have misreported all of them.
    expect(getChain('fraxtal').nativeCurrency.name).toBe('Frax');
  });

  it('resolves the aliases people actually type', () => {
    expect(getChain('frax').id).toBe('fraxtal');
    expect(getChain('mnt').id).toBe('mantle');
    expect(getChain('op-bnb').id).toBe('opbnb');
  });
});

describe('the Cosmos chains added in Phase 3', () => {
  // Read off each chain before being written down: the chain id it reports,
  // a head block seconds old, the bond denom from its own staking params, and
  // the bech32 prefix taken from a real validator operator address. Decimals
  // were confirmed against the Cosmos chain registry rather than inferred from
  // the `u` in the denom, because Injective spends `inj` at 18 and dYdX spends
  // `adydx` at 18, and the convention is a convention.
  const added = [
    { id: 'sei', chainId: 'pacific-1', symbol: 'SEI', denom: 'usei', prefix: 'sei' },
    { id: 'neutron', chainId: 'neutron-1', symbol: 'NTRN', denom: 'untrn', prefix: 'neutron' },
    { id: 'stride', chainId: 'stride-1', symbol: 'STRD', denom: 'ustrd', prefix: 'stride' },
    { id: 'kava', chainId: 'kava_2222-10', symbol: 'KAVA', denom: 'ukava', prefix: 'kava' },
  ];

  it('resolves each one by id and by the chain id it reports', () => {
    for (const { id, chainId } of added) {
      expect(getChain(id).id).toBe(id);
      expect(getChain(chainId).id).toBe(id);
    }
  });

  it('carries the denom, prefix and decimals that were read from the chain', () => {
    for (const { id, symbol, denom, prefix } of added) {
      const chain = getChain(id);
      expect(chain.family).toBe('cosmos');
      expect(chain.nativeCurrency.symbol).toBe(symbol);
      expect(chain.nativeCurrency.decimals).toBe(6);
      expect(chain.denom).toBe(denom);
      expect(chain.bech32Prefix).toBe(prefix);
    }
  });

  it('does not answer to the EVM chain id buried in kava_2222-10', () => {
    // Kava runs a Cosmos chain and an EVM chain under one name, and 2222 is the
    // EVM one. Chain ids match exactly, so the number resolves to nothing
    // rather than quietly to the Cosmos entry — which is what would let an EVM
    // Kava be added later without either one shadowing the other.
    expect(() => getChain(2222)).toThrow();
    expect(getChain('kava_2222-10').id).toBe('kava');
  });

  it('resolves the aliases people actually type', () => {
    expect(getChain('ntrn').id).toBe('neutron');
    expect(getChain('strd').id).toBe('stride');
    expect(getChain('pacific').id).toBe('sei');
  });
});

describe('failover is a guarantee or it is not', () => {
  /**
   * The roadmap says "failover is a core guarantee, and one endpoint is not
   * failover" — and three mainnets shipped with exactly one anyway. A sentence
   * in prose does not hold a list to anything, so this does.
   */
  const SINGLE_ENDPOINT_BY_NECESSITY = new Set([
    // Esplora-compatible Litecoin APIs are litecoinspace and nothing else this
    // adapter can speak to. Listed here rather than quietly excused, so that
    // the day a second one exists, this line is what gets deleted.
    'litecoin',
  ]);

  it('gives every mainnet chain somewhere to fail over to', () => {
    const thin = allChains()
      .filter((chain) => !chain.testnet && !SINGLE_ENDPOINT_BY_NECESSITY.has(chain.id))
      .filter((chain) => chain.rpc.length < 2)
      .map((chain) => chain.id);

    expect(thin).toEqual([]);
  });

  it('keeps the exemption list honest about what is on it', () => {
    // An exemption for a chain that has since grown a second endpoint is a
    // comment nobody reads. If this fails, delete the entry rather than the test.
    for (const id of SINGLE_ENDPOINT_BY_NECESSITY) {
      expect(getChain(id).rpc.length).toBe(1);
    }
  });
});

describe('env RPC overrides', () => {
  it('replaces the built-in endpoint list', () => {
    process.env.SINGULARITY_RPC_BASE = 'https://example.test/rpc';
    resetRegistry();
    expect(getChain('base').rpc).toEqual(['https://example.test/rpc']);
  });

  it('accepts a comma-separated failover list', () => {
    process.env.SINGULARITY_RPC_BASE = 'https://a.test,https://b.test';
    resetRegistry();
    expect(getChain('base').rpc).toEqual(['https://a.test', 'https://b.test']);
  });
});

describe('calldata decoding', () => {
  const transferCalldata =
    '0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045' +
    '00000000000000000000000000000000000000000000000000000000000f4240';

  it('decodes a well-known ERC-20 transfer', () => {
    const decoded = decodeCalldata(transferCalldata);
    expect(decoded.name).toBe('transfer');
    expect(decoded.selector).toBe('0xa9059cbb');
    expect(decoded.args?.[0]?.value.toLowerCase()).toBe(
      '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    );
    expect(decoded.args?.[1]?.value).toBe('1000000');
  });

  it('names the argument types from the signature', () => {
    const decoded = decodeCalldata(transferCalldata);
    expect(decoded.args?.[0]).toMatchObject({ name: 'to', type: 'address' });
    expect(decoded.args?.[1]).toMatchObject({ name: 'amount', type: 'uint256' });
  });

  it('reports an unknown selector instead of returning nothing', () => {
    const decoded = decodeCalldata(`0xdeadbeef${'00'.repeat(32)}`);
    expect(decoded.selector).toBe('0xdeadbeef');
    expect(decoded.note).toMatch(/Unrecognized selector/);
  });

  it('recognizes empty calldata as a plain value transfer', () => {
    expect(decodeCalldata('0x').note).toMatch(/plain value transfer/);
  });

  it('decodes against a caller-supplied ABI', () => {
    const decoded = decodeWithAbi(transferCalldata, [
      'function transfer(address recipient, uint256 value)',
    ]);
    expect(decoded.name).toBe('transfer');
    expect(decoded.args?.[0]?.name).toBe('recipient');
  });
});
