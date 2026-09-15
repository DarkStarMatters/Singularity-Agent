import { describe, it, expect } from 'vitest';
import {
  addressToScriptPubKey,
  bech32ToBytes,
  bytesToBech32,
  convertBech32Prefix,
  decodeBase58Check,
  decodeBech32,
  NETWORKS,
  varInt,
} from '../src/core/address-codec.js';

const bitcoin = NETWORKS.bitcoin!;

describe('bech32 / segwit decoding', () => {
  // Vectors from BIP-173 and BIP-350.
  it('decodes a P2WPKH address to the documented scriptPubKey', () => {
    const decoded = addressToScriptPubKey('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', bitcoin);
    expect(decoded?.kind).toBe('p2wpkh');
    expect(decoded?.scriptPubKey.toString('hex')).toBe(
      '0014751e76e8199196d454941c45d1b3a323f1433bd6',
    );
  });

  it('decodes a P2WSH address to the documented scriptPubKey', () => {
    // BIP-173 states this vector on testnet, so it must be decoded as such.
    const decoded = addressToScriptPubKey(
      'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
      NETWORKS['bitcoin-testnet']!,
    );
    expect(decoded?.kind).toBe('p2wsh');
    expect(decoded?.scriptPubKey.toString('hex')).toBe(
      '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262',
    );
  });

  it('decodes a P2TR (bech32m) address', () => {
    const decoded = addressToScriptPubKey(
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
      bitcoin,
    );
    expect(decoded?.kind).toBe('p2tr');
    expect(decoded?.scriptPubKey.toString('hex').slice(0, 4)).toBe('5120');
  });

  it('rejects a v0 address carrying a bech32m checksum', () => {
    // BIP-350 invalid vector: v0 must use bech32, not bech32m.
    expect(decodeBech32('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh')).toBeNull();
  });

  it('rejects mixed case', () => {
    expect(decodeBech32('bc1QW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBeNull();
  });

  it('rejects an address from the wrong network', () => {
    // A testnet address must not decode against mainnet parameters.
    expect(
      addressToScriptPubKey('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', bitcoin),
    ).toBeNull();
  });
});

describe('base58check decoding', () => {
  it('decodes a legacy P2PKH address', () => {
    const decoded = addressToScriptPubKey('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', bitcoin);
    expect(decoded?.kind).toBe('p2pkh');
    // OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
    expect(decoded?.scriptPubKey.toString('hex').slice(0, 6)).toBe('76a914');
    expect(decoded?.scriptPubKey.length).toBe(25);
  });

  it('decodes a P2SH address', () => {
    const decoded = addressToScriptPubKey('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', bitcoin);
    expect(decoded?.kind).toBe('p2sh');
    expect(decoded?.scriptPubKey.toString('hex').slice(0, 4)).toBe('a914');
    expect(decoded?.scriptPubKey.length).toBe(23);
  });

  it('rejects a corrupted checksum', () => {
    expect(decodeBase58Check('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3')).toBeNull();
  });
});

describe('cosmos bech32', () => {
  it('extracts the prefix and 20-byte account id', () => {
    const decoded = bech32ToBytes('cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu');
    expect(decoded?.hrp).toBe('cosmos');
    expect(decoded?.bytes.length).toBe(20);
  });

  it('re-encodes the same account under another chain prefix', () => {
    const cosmos = 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu';
    const osmo = convertBech32Prefix(cosmos, 'osmo');

    expect(osmo).toMatch(/^osmo1/);
    // The account bytes must survive the round trip; only the prefix changes.
    expect(bech32ToBytes(osmo!)?.bytes).toEqual(bech32ToBytes(cosmos)?.bytes);
    expect(convertBech32Prefix(osmo!, 'cosmos')).toBe(cosmos);
  });

  it('produces addresses that pass its own checksum validation', () => {
    const encoded = bytesToBech32('celestia', Buffer.alloc(20, 7));
    expect(bech32ToBytes(encoded)?.hrp).toBe('celestia');
  });

  it('rejects a mutated address', () => {
    expect(bech32ToBytes('cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xv')).toBeNull();
  });
});

describe('varInt', () => {
  it('uses the shortest encoding for each range', () => {
    expect(varInt(0).toString('hex')).toBe('00');
    expect(varInt(252).toString('hex')).toBe('fc');
    expect(varInt(253).toString('hex')).toBe('fdfd00');
    expect(varInt(65535).toString('hex')).toBe('fdffff');
    expect(varInt(65536).toString('hex')).toBe('fe00000100');
  });
});
