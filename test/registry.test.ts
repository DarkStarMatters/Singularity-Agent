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
