import { describe, it, expect } from 'vitest';
import { detect } from '../src/core/detect.js';
import { convertBech32Prefix } from '../src/core/address-codec.js';

describe('detect', () => {
  it('identifies an EVM address', () => {
    const result = detect('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    expect(result.kind).toBe('address');
    expect(result.families).toEqual(['evm']);
    expect(result.chains).toContain('ethereum');
    expect(result.chains).toContain('base');
  });

  it('identifies a Solana address', () => {
    const result = detect('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    expect(result.kind).toBe('address');
    expect(result.families).toEqual(['svm']);
  });

  it('distinguishes a legacy Bitcoin address from a Solana one', () => {
    // Both are base58; only the Bitcoin address carries a base58check checksum.
    const bitcoin = detect('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2');
    expect(bitcoin.families).toEqual(['utxo']);
  });

  it('identifies a native SegWit address and its network', () => {
    const result = detect('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
    expect(result.kind).toBe('address');
    expect(result.families).toEqual(['utxo']);
    expect(result.chains).toContain('bitcoin');
  });

  it('pins a Cosmos address to its chain via the prefix', () => {
    const osmo = convertBech32Prefix('cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu', 'osmo')!;
    const result = detect(osmo);
    expect(result.kind).toBe('address');
    expect(result.families).toEqual(['cosmos']);
    expect(result.chains).toEqual(['osmosis']);
  });

  it('treats a 0x-prefixed 64-hex string as an EVM tx hash', () => {
    const result = detect(`0x${'a'.repeat(64)}`);
    expect(result.kind).toBe('tx');
    expect(result.families).toEqual(['evm']);
  });

  it('reports ambiguity for an unprefixed 64-hex hash rather than guessing', () => {
    const result = detect('a'.repeat(64));
    expect(result.kind).toBe('tx');
    expect(result.families).toEqual(['evm', 'utxo', 'cosmos']);
  });

  it('identifies ENS and SNS names', () => {
    expect(detect('vitalik.eth')).toMatchObject({ kind: 'name', families: ['evm'] });
    expect(detect('toly.sol')).toMatchObject({ kind: 'name', families: ['svm'] });
  });

  it('treats a bare number as a block height needing a chain', () => {
    const result = detect('18000000');
    expect(result.kind).toBe('block');
    expect(result.chains).toEqual([]);
  });

  it('reports unknown input as unknown instead of forcing a guess', () => {
    expect(detect('hello world').kind).toBe('unknown');
    expect(detect('').kind).toBe('unknown');
  });
});
