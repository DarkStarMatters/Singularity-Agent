import { describe, it, expect } from 'vitest';
import { ecCodewords, formatBits, qrMatrix, strongestLevel } from '../src/core/qr.js';
import { qrPng, qrSvg, qrUnicode, qrDataUrl } from '../src/core/qr-render.js';

/**
 * A hand-rolled QR encoder, checked against the spec rather than against
 * whether it looks about right.
 *
 * The failure mode this is defending against is specific and nasty: a code that
 * is *slightly* wrong still scans on a good phone in good light and fails on a
 * bad one, so it presents as the customer's fault rather than as a bug. Nothing
 * here eyeballs an image. The Reed-Solomon remainder is checked against the
 * published vector, the structural invariants are checked positionally, and the
 * format bits are checked against the values the standard tabulates.
 */

/** Strip the quiet zone, so coordinates match the spec's numbering. */
function core(text: string, options?: Parameters<typeof qrMatrix>[1]): boolean[][] {
  const margin = options?.margin ?? 4;
  const full = qrMatrix(text, options);
  return full.slice(margin, full.length - margin).map((row) => row.slice(margin, row.length - margin));
}

describe('sizing', () => {
  it('picks the smallest version that fits, and grows by four modules', () => {
    // Version N is 4N+17 modules. A short string fits version 1 at 21.
    expect(core('HELLO').length).toBe(21);

    // Version 1 at level M holds 16 data codewords; 20 bytes needs version 2.
    expect(core('A'.repeat(20)).length).toBe(25);
  });

  it('needs a bigger version at a stronger error-correction level', () => {
    const text = 'A'.repeat(30);
    expect(core(text, { level: 'L' }).length).toBeLessThan(core(text, { level: 'H' }).length);
  });

  it('is always square', () => {
    for (const text of ['x', 'solana:https://pay.example.com/i/abc', 'A'.repeat(200)]) {
      const matrix = qrMatrix(text);
      expect(matrix.every((row) => row.length === matrix.length), text.slice(0, 20)).toBe(true);
    }
  });

  it('refuses content past the ceiling, naming the limit', () => {
    expect(() => qrMatrix('A'.repeat(5_000))).toThrow(/does not fit in a version-10/);

    try {
      qrMatrix('A'.repeat(5_000));
    } catch (err) {
      expect((err as { hint?: string }).hint).toMatch(/ceiling here is \d+ bytes/);
    }
  });

  it('refuses an empty string rather than encoding nothing', () => {
    expect(() => qrMatrix('')).toThrow(/nothing to encode/);
  });
});

describe('the patterns a scanner locks onto', () => {
  const matrix = core('SINGULARITY');
  const size = matrix.length;

  /** The 7x7 finder: dark ring, light ring, 3x3 dark core. */
  function isFinder(top: number, left: number): boolean {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const outer = r === 0 || r === 6 || c === 0 || c === 6;
        const core3 = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (matrix[top + r]![left + c] !== (outer || core3)) return false;
      }
    }
    return true;
  }

  it('puts a finder in each of the three corners', () => {
    expect(isFinder(0, 0)).toBe(true);
    expect(isFinder(0, size - 7)).toBe(true);
    expect(isFinder(size - 7, 0)).toBe(true);
  });

  it('leaves the fourth corner to data', () => {
    // A finder there would make orientation ambiguous — three is how a scanner
    // knows which way up the code is.
    expect(isFinder(size - 7, size - 7)).toBe(false);
  });

  it('separates each finder from the data with a light band', () => {
    for (let i = 0; i < 8; i += 1) {
      expect(matrix[7]![i], `row 7 col ${i}`).toBe(false);
      expect(matrix[i]![7], `row ${i} col 7`).toBe(false);
    }
  });

  it('alternates the timing patterns', () => {
    for (let i = 8; i < size - 8; i += 1) {
      expect(matrix[6]![i], `horizontal timing at ${i}`).toBe(i % 2 === 0);
      expect(matrix[i]![6], `vertical timing at ${i}`).toBe(i % 2 === 0);
    }
  });

  it('always sets the dark module', () => {
    // Fixed by the spec at (4 * version + 9, 8), which is size - 8.
    expect(matrix[size - 8]![8]).toBe(true);
  });

  it('places alignment patterns from version 2 up', () => {
    // Version 2 has one, centred at (18, 18): dark centre, light ring, dark ring.
    const v2 = core('A'.repeat(20));
    expect(v2.length).toBe(25);

    expect(v2[18]![18]).toBe(true);
    for (const [r, c] of [[17, 17], [17, 18], [18, 17], [19, 19]] as const) {
      expect(v2[r]![c], `ring at ${r},${c}`).toBe(false);
    }
    for (const [r, c] of [[16, 16], [16, 20], [20, 16], [20, 20]] as const) {
      expect(v2[r]![c], `outer at ${r},${c}`).toBe(true);
    }
  });
});

describe('quiet zone', () => {
  it('surrounds the code with four light modules by default', () => {
    const matrix = qrMatrix('HELLO');
    const size = matrix.length;

    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        expect(matrix[j]![i], `top row ${j}`).toBe(false);
        expect(matrix[size - 1 - j]![i], `bottom row ${j}`).toBe(false);
        expect(matrix[i]![j], `left col ${j}`).toBe(false);
        expect(matrix[i]![size - 1 - j], `right col ${j}`).toBe(false);
      }
    }
  });

  it('adds exactly twice the margin to each side', () => {
    expect(qrMatrix('HELLO', { margin: 0 }).length).toBe(21);
    expect(qrMatrix('HELLO', { margin: 1 }).length).toBe(23);
    expect(qrMatrix('HELLO', { margin: 4 }).length).toBe(29);
  });
});

describe('determinism', () => {
  it('produces the same matrix for the same input', () => {
    // Mask selection is a search; a tie broken inconsistently would make a QR
    // that changes between calls, which is impossible to debug from a report.
    expect(qrMatrix('solana:https://pay.example.com/i/abc')).toEqual(
      qrMatrix('solana:https://pay.example.com/i/abc'),
    );
  });

  it('produces different matrices for different input', () => {
    expect(qrMatrix('one')).not.toEqual(qrMatrix('two'));
  });
});

describe('the payload it exists for', () => {
  const link = `solana:${encodeURIComponent('https://pay.singularity-agent.cicada71.net/i/' + 'a1b2c3d4'.repeat(4))}`;

  it('encodes a full Solana Pay intent link', () => {
    const matrix = core(link);
    // Comfortably inside the ceiling: this is the shape the whole thing is for.
    expect(matrix.length).toBeLessThanOrEqual(57); // version 10
    expect(matrix.length).toBeGreaterThanOrEqual(21);
  });

  it('handles a link at every error-correction level', () => {
    for (const level of ['L', 'M', 'Q', 'H'] as const) {
      expect(() => qrMatrix(link, { level })).not.toThrow();
    }
  });

  it('encodes non-ASCII as UTF-8 bytes rather than failing', () => {
    expect(() => qrMatrix('Pay 25 € to café')).not.toThrow();
  });
});

describe('choosing the error-correction level', () => {
  /**
   * The regression this exists for.
   *
   * `/pay` shipped with `M` pinned and failed on the first token payment
   * anybody tried — 261 bytes against a 216-byte ceiling, for content that
   * encodes fine one level down. The `auto` chooser had already been written;
   * nothing was using it. So the default is now `auto`, and this is the shape
   * that broke.
   */
  const tokenPayment = (() => {
    const url = new URL('https://singularity-agent.cicada71.net/api/pay');
    url.searchParams.set('t', 'BTaPkeDYRuXbL6hEDsWPAWXUfZvjEoKoV3mCTQ91QFeH');
    url.searchParams.set('a', '25');
    url.searchParams.set('m', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    url.searchParams.set('r', '695xPtsSYaSALQdwgE6WxC4zX49zZrpVPwF2uiUGjCBB');
    url.searchParams.set('o', 'sngl-pay:-1001234567890');
    return `solana:${encodeURIComponent(url.toString())}`;
  })();

  it('encodes a full token payment link, which M alone cannot', () => {
    expect(new TextEncoder().encode(tokenPayment).length).toBeGreaterThan(216);

    // Pinned to M this is the live failure, verbatim.
    expect(() => qrMatrix(tokenPayment, { level: 'M' })).toThrow(/does not fit/);

    // By default it simply works.
    expect(() => qrMatrix(tokenPayment)).not.toThrow();
  });

  it('defaults to auto rather than any fixed level', () => {
    // A fixed default is a footgun: it fails on content the encoder can
    // represent perfectly well one level down.
    const short = 'solana:https://pay.example.com/i/abc';
    expect(qrMatrix(short)).toEqual(qrMatrix(short, { level: 'auto' }));
  });

  it('takes the strongest level that fits, not merely a working one', () => {
    // Short content should get real protection, not the weakest level that
    // happens to encode.
    expect(strongestLevel(5)).toBe('H');
    expect(strongestLevel(260)).toBe('L');
  });

  it('still honours a level somebody pinned on purpose', () => {
    const short = 'hello';
    expect(qrMatrix(short, { level: 'L' })).not.toEqual(qrMatrix(short, { level: 'H' }));
  });

  it('degrades only as far as it must', () => {
    // Monotonic: as content grows the chosen level never gets stronger.
    const order = { H: 3, Q: 2, M: 1, L: 0 } as const;
    let previous = 4;

    for (const size of [5, 20, 50, 100, 150, 200, 260]) {
      const rank = order[strongestLevel(size)];
      expect(rank, `${size} bytes`).toBeLessThanOrEqual(previous);
      previous = rank;
    }
  });
});

describe('rendering for a terminal', () => {
  it('halves the row count, so the code is square in a character cell', () => {
    const matrix = qrMatrix('HELLO');
    const lines = qrUnicode(matrix).split('\n');

    expect(lines.length).toBe(Math.ceil(matrix.length / 2));
    expect(lines[0]!.length).toBe(matrix.length);
  });

  it('uses only the four half-block glyphs', () => {
    const glyphs = new Set(qrUnicode(qrMatrix('HELLO')).replace(/\n/g, '').split(''));
    for (const glyph of glyphs) expect('█▀▄ ').toContain(glyph);
  });

  it('starts and ends with blank lines, which is the quiet zone', () => {
    const lines = qrUnicode(qrMatrix('HELLO')).split('\n');
    expect(lines[0]!.trim()).toBe('');
    expect(lines[lines.length - 1]!.trim()).toBe('');
  });
});

describe('rendering as SVG', () => {
  const svg = qrSvg(qrMatrix('HELLO'), { scale: 4 });

  it('sizes the viewport to the module count', () => {
    const size = qrMatrix('HELLO').length * 4;
    expect(svg).toContain(`width="${size}" height="${size}"`);
    expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`);
  });

  it('draws one path rather than a rect per module', () => {
    // A version-5 code is 1,300+ modules; an element each makes a document that
    // renders slowly and diffs horribly.
    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(svg.match(/<rect/g)).toHaveLength(1); // the background only
  });

  it('keeps edges crisp rather than antialiased', () => {
    expect(svg).toContain('shape-rendering="crispEdges"');
  });

  it('defaults to dark on light, which is the only way round that scans', () => {
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('fill="#000000"');
  });
});

describe('rendering as PNG, which is what Telegram takes', () => {
  const png = qrPng(qrMatrix('HELLO'), { scale: 4 });

  it('starts with the PNG signature', () => {
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('declares the right dimensions in IHDR', () => {
    const size = qrMatrix('HELLO').length * 4;
    const view = new DataView(png.buffer, png.byteOffset);

    // 8-byte signature, 4-byte length, 4-byte type, then width and height.
    expect(view.getUint32(16)).toBe(size);
    expect(view.getUint32(20)).toBe(size);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(0); // greyscale
  });

  it('carries IHDR, IDAT and IEND, in that order', () => {
    const text = Buffer.from(png).toString('latin1');
    expect(text.indexOf('IHDR')).toBeGreaterThan(0);
    expect(text.indexOf('IDAT')).toBeGreaterThan(text.indexOf('IHDR'));
    expect(text.indexOf('IEND')).toBeGreaterThan(text.indexOf('IDAT'));
  });

  it('ends with a well-formed IEND', () => {
    // Length 0, type IEND, and the fixed CRC the spec gives for an empty chunk.
    expect([...png.subarray(png.length - 12)]).toEqual([
      0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
  });

  it('compresses, rather than shipping a raw bitmap', () => {
    const size = qrMatrix('HELLO').length * 4;
    // A QR is large flat runs, so deflate should beat the raw size comfortably.
    expect(png.length).toBeLessThan(size * (size + 1));
  });

  it('produces a data URL an img tag can use directly', () => {
    const url = qrDataUrl(qrMatrix('HELLO'), { scale: 2 });
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    expect(() => Buffer.from(url.split(',')[1]!, 'base64')).not.toThrow();
  });
});

describe('checked against the standard, not against itself', () => {
  /**
   * Reed-Solomon, checked by its defining property rather than by a constant.
   *
   * The first version of this test asserted a remembered "published vector"
   * and it was simply wrong — the encoder was right and the reference was not.
   * Writing a second implementation and comparing would have been worse still:
   * both were written here, which is the decoder-and-fixture-agreeing failure
   * this project already has a section about.
   *
   * So this checks the thing that makes the code a code. A Reed-Solomon
   * codeword is *by definition* a multiple of the generator polynomial, so
   * dividing data-followed-by-remainder by that generator must leave nothing.
   * That is independent of any table, any transcription and any memory.
   */
  function remainderOf(codewords: number[], degree: number): number[] {
    // Deliberately a different shape of computation from ecCodewords: build
    // the generator by its roots and divide longhand, so a mistake in one is
    // unlikely to be the same mistake in the other.
    const EXP: number[] = [];
    const LOG: number[] = new Array(256).fill(0);
    let v = 1;
    for (let i = 0; i < 255; i += 1) {
      EXP.push(v);
      LOG[v] = i;
      v <<= 1;
      if (v & 0x100) v ^= 0x11d;
    }
    const mul = (a: number, b: number): number => (a && b ? EXP[(LOG[a]! + LOG[b]!) % 255]! : 0);

    let generator = [1];
    for (let i = 0; i < degree; i += 1) {
      const next = new Array<number>(generator.length + 1).fill(0);
      for (let j = 0; j < generator.length; j += 1) {
        next[j] = next[j]! ^ mul(generator[j]!, EXP[i]!);
        next[j + 1] = next[j + 1]! ^ generator[j]!;
      }
      generator = next;
    }

    const working = [...codewords];
    for (let i = 0; i + generator.length <= working.length; i += 1) {
      const lead = working[i]!;
      if (lead === 0) continue;
      for (let j = 0; j < generator.length; j += 1) {
        working[i + j] = working[i + j]! ^ mul(generator[j]!, lead);
      }
    }

    return working.slice(working.length - degree);
  }

  it('produces codewords that divide cleanly by the generator, which is what makes them correct', () => {
    for (const degree of [7, 10, 13, 17, 26, 30]) {
      const data = Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
      const ec = ecCodewords(data, degree);

      // Data followed by its remainder is a multiple of the generator, so the
      // remainder of *that* is zero. This is the definition of the code.
      expect(remainderOf([...data, ...ec], degree), `degree ${degree}`).toEqual(
        new Array(degree).fill(0),
      );
    }
  });

  it('builds GF(256) correctly, checked from first principles', () => {
    // 2^8 = 256 reduces by the primitive polynomial 0x11D to 0x1D = 29. Every
    // table in this file rests on that, and it is checkable without a source.
    const data = [1];
    const ec = ecCodewords(data, 255 - 1);
    expect(ec).toHaveLength(254);

    // A single 1 followed by its remainder must still divide cleanly.
    expect(remainderOf([...data, ...ec], 254)).toEqual(new Array(254).fill(0));
  });

  it('produces the right number of codewords for every block size in the tables', () => {
    for (const count of [7, 10, 13, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30]) {
      expect(ecCodewords([1, 2, 3, 4, 5], count), `${count} codewords`).toHaveLength(count);
    }
  });

  it('is sensitive to every input byte', () => {
    // A remainder that ignores an input is a remainder that cannot detect a
    // corruption of it.
    const base = [32, 91, 11, 120, 209];
    for (let i = 0; i < base.length; i += 1) {
      const changed = [...base];
      changed[i] = (changed[i]! + 1) & 0xff;
      expect(ecCodewords(changed, 10), `byte ${i}`).not.toEqual(ecCodewords(base, 10));
    }
  });

  /**
   * The standard tabulates all thirty-two format strings. Checking four of them
   * — one per error-correction level — exercises the BCH remainder and the
   * final XOR, which are the two places this can be wrong.
   */
  it('reproduces the tabulated format information', () => {
    expect(formatBits('L', 0)).toBe(0b111011111000100);
    expect(formatBits('M', 0)).toBe(0b101010000010010);
    expect(formatBits('Q', 0)).toBe(0b011010101011111);
    expect(formatBits('H', 0)).toBe(0b001011010001001);
  });

  it('reproduces tabulated format information for other masks', () => {
    // Transcribed from the standard's table of all thirty-two strings. The
    // first draft of this test had L/5 and M/5 here by mistake, and the code
    // was right — which is the argument for reference values over round-trips.
    expect(formatBits('M', 4)).toBe(0b100010111111001);
    expect(formatBits('L', 7)).toBe(0b110100101110110);
    expect(formatBits('H', 7)).toBe(0b000100000111011);
  });

  it('matches the tabulated table in full, all thirty-two strings', () => {
    const TABLE: Record<string, string[]> = {
      L: ['111011111000100', '111001011110011', '111110110101010', '111100010011101',
          '110011000101111', '110001100011000', '110110001000001', '110100101110110'],
      M: ['101010000010010', '101000100100101', '101111001111100', '101101101001011',
          '100010111111001', '100000011001110', '100111110010111', '100101010100000'],
      Q: ['011010101011111', '011000001101000', '011111100110001', '011101000000110',
          '010010010110100', '010000110000011', '010111011011010', '010101111101101'],
      H: ['001011010001001', '001001110111110', '001110011100111', '001100111010000',
          '000011101100010', '000001001010101', '000110100001100', '000100000111011'],
    };

    for (const level of ['L', 'M', 'Q', 'H'] as const) {
      for (let mask = 0; mask < 8; mask += 1) {
        expect(formatBits(level, mask).toString(2).padStart(15, '0'), `${level}/${mask}`).toBe(
          TABLE[level]![mask],
        );
      }
    }
  });

  it('gives every level and mask a distinct format string', () => {
    const seen = new Set<number>();
    for (const level of ['L', 'M', 'Q', 'H'] as const) {
      for (let mask = 0; mask < 8; mask += 1) seen.add(formatBits(level, mask));
    }
    expect(seen.size).toBe(32);
  });
});
