import { createHash } from 'node:crypto';
import bs58 from 'bs58';

/**
 * Minimal Bitcoin address decoding — just enough to turn an address into the
 * scriptPubKey an unsigned transaction needs, without a full wallet library.
 *
 * Supports P2PKH, P2SH, and native SegWit v0/v1 (bech32 / bech32m).
 */

const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function polymod(values: number[]): number {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) checksum ^= generator[i]!;
    }
  }
  return checksum;
}

function hrpExpand(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (const char of hrp) {
    high.push(char.charCodeAt(0) >> 5);
    low.push(char.charCodeAt(0) & 31);
  }
  return [...high, 0, ...low];
}

/** Regroup bits, e.g. 5-bit bech32 groups into 8-bit bytes. */
function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxValue = (1 << to) - 1;

  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      result.push((acc >> bits) & maxValue);
    }
  }

  if (pad) {
    if (bits > 0) result.push((acc << (to - bits)) & maxValue);
  } else if (bits >= from || ((acc << (to - bits)) & maxValue) !== 0) {
    return null;
  }

  return result;
}

export interface Bech32Parts {
  hrp: string;
  /** 5-bit data groups, checksum already stripped and verified. */
  words: number[];
  spec: 'bech32' | 'bech32m';
}

/**
 * Generic bech32/bech32m decode. Cosmos uses plain bech32 with no witness
 * version byte, so segwit decoding is layered on top of this rather than baked in.
 */
export function decodeBech32Raw(address: string): Bech32Parts | null {
  const lower = address.toLowerCase();
  // Mixed case is invalid in bech32; catching it prevents a silent wrong decode.
  if (address !== lower && address !== address.toUpperCase()) return null;

  const split = lower.lastIndexOf('1');
  if (split < 1 || split + 7 > lower.length || lower.length > 90) return null;

  const hrp = lower.slice(0, split);
  const dataPart = lower.slice(split + 1);

  const data: number[] = [];
  for (const char of dataPart) {
    const index = BECH32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    data.push(index);
  }

  const checksum = polymod([...hrpExpand(hrp), ...data]);
  const spec = checksum === BECH32_CONST ? 'bech32' : checksum === BECH32M_CONST ? 'bech32m' : null;
  if (!spec) return null;

  return { hrp, words: data.slice(0, -6), spec };
}

function createChecksum(hrp: string, words: number[], spec: 'bech32' | 'bech32m'): number[] {
  const constant = spec === 'bech32' ? BECH32_CONST : BECH32M_CONST;
  const values = [...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ constant;
  return Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
}

/**
 * Encode bytes as a bech32 address under a given prefix.
 *
 * This is what makes Cosmos addresses portable: the same account is one key
 * re-encoded per chain, so `cosmos1…` and `osmo1…` can be converted rather than
 * the user being told their address is simply wrong.
 */
export function bytesToBech32(hrp: string, bytes: Buffer, spec: 'bech32' | 'bech32m' = 'bech32'): string {
  const words = convertBits([...bytes], 8, 5, true);
  if (!words) throw new Error('Could not regroup bytes into bech32 words.');

  const checksum = createChecksum(hrp, words, spec);
  const encoded = [...words, ...checksum].map((w) => BECH32_ALPHABET[w]).join('');
  return `${hrp}1${encoded}`;
}

/** Re-encode a bech32 address under a different prefix, keeping the same account. */
export function convertBech32Prefix(address: string, newPrefix: string): string | null {
  const decoded = bech32ToBytes(address);
  return decoded ? bytesToBech32(newPrefix, decoded.bytes) : null;
}

/** Decode bech32 data straight to bytes — the Cosmos account-address case. */
export function bech32ToBytes(address: string): { hrp: string; bytes: Buffer } | null {
  const parts = decodeBech32Raw(address);
  if (!parts || parts.spec !== 'bech32') return null;
  const bytes = convertBits(parts.words, 5, 8, false);
  return bytes ? { hrp: parts.hrp, bytes: Buffer.from(bytes) } : null;
}

export interface SegwitAddress {
  hrp: string;
  version: number;
  program: Buffer;
}

export function decodeBech32(address: string): SegwitAddress | null {
  const parts = decodeBech32Raw(address);
  if (!parts) return null;

  const version = parts.words[0];
  if (version === undefined || version > 16) return null;

  // v0 uses bech32, v1+ uses bech32m. The wrong spec must fail, not coerce.
  const expectedSpec = version === 0 ? 'bech32' : 'bech32m';
  if (parts.spec !== expectedSpec) return null;

  const program = convertBits(parts.words.slice(1), 5, 8, false);
  if (!program) return null;
  if (program.length < 2 || program.length > 40) return null;
  if (version === 0 && program.length !== 20 && program.length !== 32) return null;

  return { hrp: parts.hrp, version, program: Buffer.from(program) };
}

export interface Base58Address {
  version: number;
  hash: Buffer;
}

export function decodeBase58Check(address: string): Base58Address | null {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(address);
  } catch {
    return null;
  }
  if (decoded.length !== 25) return null;

  const body = Buffer.from(decoded.subarray(0, 21));
  const checksum = Buffer.from(decoded.subarray(21));
  const expected = sha256(sha256(body)).subarray(0, 4);
  if (!checksum.equals(expected)) return null;

  return { version: body[0]!, hash: body.subarray(1) };
}

export interface NetworkParams {
  bech32Hrp: string;
  p2pkhVersion: number;
  p2shVersion: number;
}

export const NETWORKS: Record<string, NetworkParams> = {
  bitcoin: { bech32Hrp: 'bc', p2pkhVersion: 0x00, p2shVersion: 0x05 },
  'bitcoin-testnet': { bech32Hrp: 'tb', p2pkhVersion: 0x6f, p2shVersion: 0xc4 },
  litecoin: { bech32Hrp: 'ltc', p2pkhVersion: 0x30, p2shVersion: 0x32 },
};

export type AddressKind = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr';

export interface DecodedAddress {
  kind: AddressKind;
  scriptPubKey: Buffer;
}

/**
 * Turn an address into its scriptPubKey.
 *
 * Returns null rather than throwing so callers can distinguish "not a valid
 * address for this network" from an RPC failure.
 */
export function addressToScriptPubKey(address: string, network: NetworkParams): DecodedAddress | null {
  const segwit = decodeBech32(address);
  if (segwit) {
    if (segwit.hrp !== network.bech32Hrp) return null;
    const opcode = segwit.version === 0 ? 0x00 : 0x50 + segwit.version;
    const scriptPubKey = Buffer.concat([
      Buffer.from([opcode, segwit.program.length]),
      segwit.program,
    ]);
    const kind: AddressKind =
      segwit.version === 1 ? 'p2tr' : segwit.program.length === 32 ? 'p2wsh' : 'p2wpkh';
    return { kind, scriptPubKey };
  }

  const legacy = decodeBase58Check(address);
  if (!legacy) return null;

  if (legacy.version === network.p2pkhVersion) {
    // OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
    return {
      kind: 'p2pkh',
      scriptPubKey: Buffer.concat([
        Buffer.from([0x76, 0xa9, 0x14]),
        legacy.hash,
        Buffer.from([0x88, 0xac]),
      ]),
    };
  }

  if (legacy.version === network.p2shVersion) {
    // OP_HASH160 <20> OP_EQUAL
    return {
      kind: 'p2sh',
      scriptPubKey: Buffer.concat([Buffer.from([0xa9, 0x14]), legacy.hash, Buffer.from([0x87])]),
    };
  }

  return null;
}

export function isValidBitcoinAddress(address: string, network: NetworkParams): boolean {
  return addressToScriptPubKey(address, network) !== null;
}

/** Bitcoin's variable-length integer encoding. */
export function varInt(value: number): Buffer {
  if (value < 0xfd) return Buffer.from([value]);
  if (value <= 0xffff) {
    const buffer = Buffer.alloc(3);
    buffer.writeUInt8(0xfd, 0);
    buffer.writeUInt16LE(value, 1);
    return buffer;
  }
  if (value <= 0xffffffff) {
    const buffer = Buffer.alloc(5);
    buffer.writeUInt8(0xfe, 0);
    buffer.writeUInt32LE(value, 1);
    return buffer;
  }
  const buffer = Buffer.alloc(9);
  buffer.writeUInt8(0xff, 0);
  buffer.writeBigUInt64LE(BigInt(value), 1);
  return buffer;
}
