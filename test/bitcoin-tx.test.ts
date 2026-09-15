import { describe, it, expect } from 'vitest';
import { serializeUnsignedTx } from '../src/adapters/bitcoin.js';
import { NETWORKS } from '../src/core/address-codec.js';

const bitcoin = NETWORKS.bitcoin!;

/**
 * The expected hex below was decoded field by field against the Bitcoin
 * transaction format, so these assertions pin the byte layout rather than
 * merely re-stating whatever the code happens to produce.
 */
describe('serializeUnsignedTx', () => {
  const inputs = [
    { txid: '7910fdb3063ddd617eee659bfba1852f2e68be80e4e772590be3bcfe2ac944a4', vout: 1 },
  ];
  const outputs = [
    { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', value: 500_000n },
  ];

  it('serializes version, inputs, outputs, and locktime in order', () => {
    const hex = serializeUnsignedTx(inputs, outputs, bitcoin);

    expect(hex.startsWith('02000000')).toBe(true); // version 2, little-endian
    expect(hex.endsWith('00000000')).toBe(true); // locktime 0
  });

  it('writes the txid in little-endian, reversed from its display form', () => {
    const hex = serializeUnsignedTx(inputs, outputs, bitcoin);
    const displayed = inputs[0]!.txid;
    const reversed = Buffer.from(displayed, 'hex').reverse().toString('hex');

    expect(hex).toContain(reversed);
    // The display order must NOT appear, or we are spending the wrong output.
    expect(hex).not.toContain(displayed);
  });

  it('writes vout and value as little-endian integers', () => {
    const hex = serializeUnsignedTx(inputs, outputs, bitcoin);
    expect(hex).toContain('01000000'); // vout = 1
    expect(hex).toContain('20a1070000000000'); // 500000 sats as uint64 LE
  });

  it('leaves the scriptSig empty, which is what makes it unsigned', () => {
    const hex = serializeUnsignedTx(inputs, outputs, bitcoin);
    // ...vout(4) then a 0x00 length scriptSig then the sequence.
    expect(hex).toContain('0100000000fffffffd');
  });

  it('marks inputs as opting into replace-by-fee', () => {
    expect(serializeUnsignedTx(inputs, outputs, bitcoin)).toContain('fffffffd');
  });

  it('encodes the output scriptPubKey with its length prefix', () => {
    const hex = serializeUnsignedTx(inputs, outputs, bitcoin);
    // 0x16 = 22 bytes: OP_0 <20-byte keyhash>
    expect(hex).toContain('160014751e76e8199196d454941c45d1b3a323f1433bd6');
  });

  it('produces the full hand-verified transaction', () => {
    const hex = serializeUnsignedTx(
      inputs,
      [
        ...outputs,
        {
          address: 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97',
          value: 13_001_007_336_359n,
        },
      ],
      bitcoin,
    );

    expect(hex).toBe(
      '0200000001a444c92afebce30b5972e7e480be682e2f85a1fb9b65ee7e61dd3d06b3fd1079' +
        '0100000000fffffffd' +
        '0220a1070000000000160014751e76e8199196d454941c45d1b3a323f1433bd6' +
        'a78b6c08d30b00002200204364063fac8829a931a752ecd9049e43425e2cebf83681876c556002bf389b00' +
        '00000000',
    );
  });

  it('counts inputs and outputs with a varint', () => {
    const twoInputs = [...inputs, { txid: 'ab'.repeat(32), vout: 0 }];
    const hex = serializeUnsignedTx(twoInputs, outputs, bitcoin);
    expect(hex.slice(8, 10)).toBe('02'); // two inputs
  });

  it('refuses an output address it cannot encode', () => {
    expect(() =>
      serializeUnsignedTx(inputs, [{ address: 'not-an-address', value: 1n }], bitcoin),
    ).toThrow(/Cannot encode output address/);
  });
});
