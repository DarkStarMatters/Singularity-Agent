/**
 * A QR encoder, written out rather than depended on.
 *
 * This project ships six runtime dependencies and hand-rolls the things it
 * could have pulled in — TransferChecked rather than all of spl-token, the
 * Metaplex metadata layout rather than the Metaplex SDK. A QR encoder belongs
 * in the same category: it is pure computation over a fully specified format,
 * it touches no network, and it has no security surface of its own.
 *
 * It lives in the agent rather than the SDK because both need it. The SDK hands
 * a merchant a `solana:` link; the Telegram bot has to put that link in front
 * of somebody holding a phone, and a URL in a chat message is not something you
 * can scan. The dependency only runs one way, so the shared piece goes here.
 *
 * **The failure mode worth naming.** A subtly wrong QR is worse than no QR: it
 * scans on a good phone in good light and fails on a bad one, so it looks like
 * the customer's fault. The parts where that can happen are the Galois-field
 * arithmetic and the Reed–Solomon remainder, and both are checked against the
 * published test vectors in `test/qr.test.ts` rather than by eye.
 *
 * Scope is deliberate: byte mode, versions 1–10, all four error-correction
 * levels. Version 10 holds 274 bytes at level L, which is comfortably above a
 * Solana Pay link carrying two base58 addresses and a reference — and content
 * that does not fit raises an error naming the limit rather than silently
 * truncating into a QR that decodes to half a URL.
 *
 * The level is chosen automatically by default, and that is not a convenience.
 * `/pay` shipped with `M` pinned and failed on the first token payment anybody
 * tried: 261 bytes against a 216-byte ceiling, for content that encodes fine
 * one level down. Picking the strongest level that *fits* is the only default
 * that cannot fail on content the encoder can represent.
 */

import { SingularityError } from './errors.js';

/**
 * How much of the code can be lost and still decode.
 *
 * `L` recovers about 7%, `M` 15%, `Q` 25%, `H` 30% — and every step costs
 * modules, which cost physical size, which costs scan reliability on a small
 * screen. Nothing here picks one by default; see {@link EcChoice}.
 */
export type EcLevel = 'L' | 'M' | 'Q' | 'H';

/**
 * `auto` picks the strongest level the content fits in at the smallest version.
 *
 * Worth having because the alternative is worse in both directions. Pinning a
 * level means a payload one byte over the limit fails outright, when dropping
 * from M to L would have carried it with room to spare; pinning a *weak* level
 * throws away recovery on the short payloads that are most of the traffic.
 *
 * The order is strongest-first at each version, so a short link gets `H` and a
 * long one degrades only as far as it must.
 */
export type EcChoice = EcLevel | 'auto';

/** A square of true (dark) and false (light) modules, including the quiet zone. */
export type QrMatrix = boolean[][];

// ─────────────────────────────────────────────────────── Galois field GF(256)

/**
 * Exponent and log tables over GF(256) with primitive polynomial 0x11D.
 *
 * Built once at module load. Multiplication becomes an addition of logs, which
 * is the only reason Reed–Solomon over a byte field is cheap enough to do in a
 * loop like this.
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    // 0x11D is the primitive polynomial the QR spec fixes for GF(256).
    if (value & 0x100) value ^= 0x11d;
  }
  // Doubled so an index sum up to 510 needs no modulo in the hot path.
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** The generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] ?? 0) ^ gfMul(poly[j]!, EXP[i]!);
      next[j + 1] = (next[j + 1] ?? 0) ^ poly[j]!;
    }
    poly = next;
  }
  return poly;
}

/**
 * Reed–Solomon remainder: the error-correction codewords for one block.
 *
 * Exported for tests, against the published vectors. This is the function most
 * capable of being subtly wrong — a bad remainder produces a code that decodes
 * on a reader with slack and fails on one without — and it is the only part
 * here with hard reference values to check against, so it is checked.
 */
export function ecCodewords(data: number[], count: number): number[] {
  const generator = generatorPoly(count);
  const remainder = new Array<number>(count).fill(0);

  for (const byte of data) {
    const factor = byte ^ (remainder.shift() ?? 0);
    remainder.push(0);
    if (factor !== 0) {
      for (let i = 0; i < count; i += 1) {
        remainder[i] = (remainder[i] ?? 0) ^ gfMul(generator[i + 1]!, factor);
      }
    }
  }

  return remainder;
}

// ──────────────────────────────────────────────────────────────────── tables

/** Total codewords (data + EC) per version, 1-indexed. */
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/**
 * Block structure per version and level: EC codewords per block, then the
 * groups as [blockCount, dataCodewordsPerBlock].
 *
 * Transcribed from the spec's table rather than derived, because the values are
 * not a formula — they are a set of choices the standard makes.
 */
interface BlockSpec {
  ecPerBlock: number;
  groups: Array<[blocks: number, dataCodewords: number]>;
}

const BLOCKS: Record<EcLevel, Array<BlockSpec | null>> = {
  L: [
    null,
    { ecPerBlock: 7, groups: [[1, 19]] },
    { ecPerBlock: 10, groups: [[1, 34]] },
    { ecPerBlock: 15, groups: [[1, 55]] },
    { ecPerBlock: 20, groups: [[1, 80]] },
    { ecPerBlock: 26, groups: [[1, 108]] },
    { ecPerBlock: 18, groups: [[2, 68]] },
    { ecPerBlock: 20, groups: [[2, 78]] },
    { ecPerBlock: 24, groups: [[2, 97]] },
    { ecPerBlock: 30, groups: [[2, 116]] },
    { ecPerBlock: 18, groups: [[2, 68], [2, 69]] },
  ],
  M: [
    null,
    { ecPerBlock: 10, groups: [[1, 16]] },
    { ecPerBlock: 16, groups: [[1, 28]] },
    { ecPerBlock: 26, groups: [[1, 44]] },
    { ecPerBlock: 18, groups: [[2, 32]] },
    { ecPerBlock: 24, groups: [[2, 43]] },
    { ecPerBlock: 16, groups: [[4, 27]] },
    { ecPerBlock: 18, groups: [[4, 31]] },
    { ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
    { ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
    { ecPerBlock: 26, groups: [[4, 43], [1, 44]] },
  ],
  Q: [
    null,
    { ecPerBlock: 13, groups: [[1, 13]] },
    { ecPerBlock: 22, groups: [[1, 22]] },
    { ecPerBlock: 18, groups: [[2, 17]] },
    { ecPerBlock: 26, groups: [[2, 24]] },
    { ecPerBlock: 18, groups: [[2, 15], [2, 16]] },
    { ecPerBlock: 24, groups: [[4, 19]] },
    { ecPerBlock: 18, groups: [[2, 14], [4, 15]] },
    { ecPerBlock: 22, groups: [[4, 18], [2, 19]] },
    { ecPerBlock: 20, groups: [[4, 16], [4, 17]] },
    { ecPerBlock: 24, groups: [[6, 19], [2, 20]] },
  ],
  H: [
    null,
    { ecPerBlock: 17, groups: [[1, 9]] },
    { ecPerBlock: 28, groups: [[1, 16]] },
    { ecPerBlock: 22, groups: [[2, 13]] },
    { ecPerBlock: 16, groups: [[4, 9]] },
    { ecPerBlock: 22, groups: [[2, 11], [2, 12]] },
    { ecPerBlock: 28, groups: [[4, 15]] },
    { ecPerBlock: 26, groups: [[4, 13], [1, 14]] },
    { ecPerBlock: 26, groups: [[4, 14], [2, 15]] },
    { ecPerBlock: 24, groups: [[4, 12], [4, 13]] },
    { ecPerBlock: 28, groups: [[6, 15], [2, 16]] },
  ],
};

/** Centre coordinates of alignment patterns, per version. */
const ALIGNMENT: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Two bits per level, as they appear in the format information. */
const EC_BITS: Record<EcLevel, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

const MAX_VERSION = 10;

// ────────────────────────────────────────────────────────────────── encoding

function dataCapacity(version: number, level: EcLevel): number {
  const spec = BLOCKS[level][version];
  if (!spec) return 0;
  return spec.groups.reduce((sum, [blocks, data]) => sum + blocks * data, 0);
}

/** The smallest version that holds `byteLength` in byte mode. */
function chooseVersion(byteLength: number, level: EcLevel): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    // Mode indicator (4 bits) + character count (8 or 16) + the data itself.
    const countBits = version < 10 ? 8 : 16;
    const needed = Math.ceil((4 + countBits) / 8) + byteLength;
    if (needed <= dataCapacity(version, level)) return version;
  }

  throw new SingularityError(
    'QR_TOO_LONG',
    `${byteLength} bytes does not fit in a version-${MAX_VERSION} QR code at level ${level}.`,
    `The ceiling here is ${dataCapacity(MAX_VERSION, level)} bytes. Shorten the content, or drop to a lower error-correction level — a Solana Pay link is normally well under a hundred bytes, so content this long usually means something other than a link got passed in.`,
  );
}

/**
 * The strongest error-correction level this content fits in, at the smallest
 * version that will take it.
 *
 * Version first, then level: a smaller code with weaker recovery scans better
 * off a phone screen than a larger one with stronger recovery, because the
 * modules are physically bigger. Within a version, take the most protection
 * going.
 */
export function strongestLevel(byteLength: number): EcLevel {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const countBits = version < 10 ? 8 : 16;
    const needed = Math.ceil((4 + countBits) / 8) + byteLength;

    for (const level of ['H', 'Q', 'M', 'L'] as const) {
      if (needed <= dataCapacity(version, level)) return level;
    }
  }

  // Nothing fits anywhere; let chooseVersion raise the error that names the
  // ceiling rather than duplicating it here.
  return 'L';
}

/** Mode indicator, length, payload, terminator, padding — as a bit string. */
function encodeData(bytes: Uint8Array, version: number, level: EcLevel): number[] {
  const capacity = dataCapacity(version, level);
  const countBits = version < 10 ? 8 : 16;
  const bits: number[] = [];

  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, countBits);
  for (const byte of bytes) push(byte, 8);

  // Terminator, up to four bits, only as far as capacity allows.
  const capacityBits = capacity * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]!;
    codewords.push(byte);
  }

  // Alternating pad bytes, which the spec fixes at these two values.
  const PADS = [0xec, 0x11];
  for (let i = 0; codewords.length < capacity; i += 1) codewords.push(PADS[i % 2]!);

  return codewords;
}

/**
 * Split into blocks, compute EC for each, then interleave.
 *
 * The interleaving is the point: a scratch across the printed code damages
 * consecutive modules, and spreading each block's codewords means that damage
 * lands a few bytes into many blocks rather than destroying one outright.
 */
function interleave(data: number[], version: number, level: EcLevel): number[] {
  const spec = BLOCKS[level][version]!;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];

  let offset = 0;
  for (const [blocks, perBlock] of spec.groups) {
    for (let i = 0; i < blocks; i += 1) {
      const block = data.slice(offset, offset + perBlock);
      offset += perBlock;
      dataBlocks.push(block);
      ecBlocks.push(ecCodewords(block, spec.ecPerBlock));
    }
  }

  const out: number[] = [];

  const longest = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) out.push(block[i]!);
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────── matrix

type Grid = Array<Array<boolean | null>>;

function placeFunctionPatterns(grid: Grid, version: number): void {
  const size = grid.length;

  const finder = (row: number, col: number): void => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const y = row + r;
        const x = col + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const outer = r >= 0 && r <= 6 && (c === 0 || c === 6);
        const side = c >= 0 && c <= 6 && (r === 0 || r === 6);
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[y]![x] = outer || side || core;
      }
    }
  };

  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns: the alternating runs that let a scanner find the grid.
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    grid[6]![i] = dark;
    grid[i]![6] = dark;
  }

  for (const row of ALIGNMENT[version] ?? []) {
    for (const col of ALIGNMENT[version] ?? []) {
      // The three corners are occupied by finders.
      if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) {
        continue;
      }
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          grid[row + r]![col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        }
      }
    }
  }

  // The one module that is always dark, for reasons the spec does not explain.
  grid[size - 8]![8] = true;

  // Reserve the format areas so data placement skips them.
  for (let i = 0; i < 9; i += 1) {
    if (grid[8]![i] === null) grid[8]![i] = false;
    if (grid[i]![8] === null) grid[i]![8] = false;
  }
  for (let i = 0; i < 8; i += 1) {
    if (grid[8]![size - 1 - i] === null) grid[8]![size - 1 - i] = false;
    if (grid[size - 1 - i]![8] === null) grid[size - 1 - i]![8] = false;
  }

  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const row = Math.floor(i / 3);
      const col = size - 11 + (i % 3);
      grid[row]![col] = false;
      grid[col]![row] = false;
    }
  }
}

/** True where a module is reserved for a function pattern. */
function reservedMask(version: number, size: number): boolean[][] {
  const probe: Grid = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  placeFunctionPatterns(probe, version);
  return probe.map((row) => row.map((cell) => cell !== null));
}

/** Zig-zag upward in two-column strips, skipping the timing column. */
function placeData(grid: Grid, reserved: boolean[][], codewords: number[]): void {
  const size = grid.length;
  let bit = 0;
  let upward = true;

  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1; // the vertical timing pattern

    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;

      for (const col of [right, right - 1]) {
        if (reserved[row]![col]) continue;

        const byte = codewords[bit >> 3] ?? 0;
        grid[row]![col] = ((byte >> (7 - (bit & 7))) & 1) === 1;
        bit += 1;
      }
    }

    upward = !upward;
  }
}

const MASKS: Array<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * How badly a masked grid scans, by the spec's four penalty rules.
 *
 * The mask that scores lowest is the one that ships. This exists because a
 * regular pattern in the data can produce large uniform areas, or shapes that
 * look like finder patterns, and both confuse a scanner.
 */
function penalty(grid: boolean[][]): number {
  const size = grid.length;
  let score = 0;

  // Rule 1: runs of five or more of the same colour.
  for (let i = 0; i < size; i += 1) {
    for (const line of [grid[i]!, grid.map((row) => row[i]!)]) {
      let run = 1;
      for (let j = 1; j < size; j += 1) {
        if (line[j] === line[j - 1]) {
          run += 1;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const first = grid[r]![c];
      if (first === grid[r]![c + 1] && first === grid[r + 1]![c] && first === grid[r + 1]![c + 1]) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern with a light run beside it.
  const PATTERN = [true, false, true, true, true, false, true];
  const hasPattern = (line: boolean[], at: number): boolean =>
    PATTERN.every((value, offset) => line[at + offset] === value);
  const lightRun = (line: boolean[], from: number): boolean => {
    for (let i = from; i < from + 4; i += 1) {
      if (line[i] === undefined || line[i]) return false;
    }
    return true;
  };

  for (let i = 0; i < size; i += 1) {
    for (const line of [grid[i]!, grid.map((row) => row[i]!)]) {
      for (let j = 0; j + 7 <= size; j += 1) {
        if (!hasPattern(line, j)) continue;
        if (lightRun(line, j + 7) || lightRun(line, j - 4)) score += 40;
      }
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  const dark = grid.flat().filter(Boolean).length;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/**
 * 15-bit format information: level, mask, BCH remainder, XOR mask.
 *
 * Exported for tests. The standard tabulates all 32 values, so this is
 * checkable against something other than itself.
 */
export function formatBits(level: EcLevel, mask: number): number {
  const data = (EC_BITS[level] << 3) | mask;
  let rest = data << 10;

  for (let i = 14; i >= 10; i -= 1) {
    if ((rest >> i) & 1) rest ^= 0b10100110111 << (i - 10);
  }

  return ((data << 10) | rest) ^ 0b101010000010010;
}

/** 18-bit version information, for versions 7 and above. */
function versionBits(version: number): number {
  let rest = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if ((rest >> i) & 1) rest ^= 0b1111100100101 << (i - 12);
  }
  return (version << 12) | rest;
}

function applyFormat(grid: boolean[][], level: EcLevel, mask: number): void {
  const size = grid.length;
  const bits = formatBits(level, mask);

  for (let i = 0; i < 15; i += 1) {
    const bit = ((bits >> i) & 1) === 1;

    // Copy one: around the top-left finder.
    if (i < 6) grid[8]![i] = bit;
    else if (i === 6) grid[8]![7] = bit;
    else if (i === 7) grid[8]![8] = bit;
    else if (i === 8) grid[7]![8] = bit;
    else grid[14 - i]![8] = bit;

    // Copy two: seven bits climb column 8 from the bottom, then eight run
    // along row 8 to the right edge. Seven, not eight — the eighth module up
    // that column is the fixed dark module, and writing a format bit over it
    // produces a code that still scans on a forgiving reader and fails on a
    // strict one. `test/qr.test.ts` asserts the dark module positionally for
    // exactly this reason.
    if (i < 7) grid[size - 1 - i]![8] = bit;
    else grid[8]![size - 15 + i] = bit;
  }
}

function applyVersion(grid: boolean[][], version: number): void {
  if (version < 7) return;
  const size = grid.length;
  const bits = versionBits(version);

  for (let i = 0; i < 18; i += 1) {
    const bit = ((bits >> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = size - 11 + (i % 3);
    grid[row]![col] = bit;
    grid[col]![row] = bit;
  }
}

export interface QrOptions {
  /**
   * Error correction. Defaults to `auto`: the strongest level that fits.
   *
   * `auto` is the default because a fixed one is a footgun, and this is not
   * hypothetical — `/pay` shipped pinned to `M` and failed on the first token
   * payment somebody tried, at 261 bytes against a 216-byte ceiling, when the
   * same content encodes fine at `L` with room to spare. A caller should not
   * have to know that the difference between fitting and not is a handful of
   * bytes of domain name.
   *
   * Pin a level only when the recovery strength matters more than whether it
   * encodes at all — a code going to print, say, where `H` is worth a bigger
   * symbol.
   */
  level?: EcChoice;
  /**
   * Light modules around the code. The spec requires four and scanners
   * genuinely need them: without a quiet zone a code against a busy background
   * often will not lock on at all.
   */
  margin?: number;
}

/**
 * Encode text as a QR matrix, quiet zone included.
 *
 * `true` is a dark module. The result is square and ready to render; every
 * output function in this file is a presentation of exactly this.
 */
export function qrMatrix(text: string, options: QrOptions = {}): QrMatrix {
  const margin = options.margin ?? 4;

  if (!text) {
    throw new SingularityError(
      'QR_EMPTY',
      'There is nothing to encode.',
      'A QR code of an empty string scans to an empty string, which helps nobody.',
    );
  }

  const bytes = new TextEncoder().encode(text);
  const level =
    options.level === undefined || options.level === 'auto'
      ? strongestLevel(bytes.length)
      : options.level;
  const version = chooseVersion(bytes.length, level);
  const size = version * 4 + 17;

  const codewords = interleave(encodeData(bytes, version, level), version, level);
  const reserved = reservedMask(version, size);

  const base: Grid = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  placeFunctionPatterns(base, version);
  placeData(base, reserved, codewords);

  // Try every mask, keep the one that scans best.
  let best: boolean[][] | null = null;
  let bestScore = Infinity;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = base.map((row, r) =>
      row.map((cell, c) => {
        const value = cell ?? false;
        return reserved[r]![c] ? value : value !== MASKS[mask]!(r, c);
      }),
    );

    applyVersion(candidate, version);
    applyFormat(candidate, level, mask);

    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  const grid = best!;

  if (margin <= 0) return grid;

  const padded: QrMatrix = [];
  const blank = (): boolean[] => new Array<boolean>(size + margin * 2).fill(false);

  for (let i = 0; i < margin; i += 1) padded.push(blank());
  for (const row of grid) {
    padded.push([...new Array<boolean>(margin).fill(false), ...row, ...new Array<boolean>(margin).fill(false)]);
  }
  for (let i = 0; i < margin; i += 1) padded.push(blank());

  return padded;
}
