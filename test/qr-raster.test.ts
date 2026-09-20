import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { qrMatrix } from '../src/core/qr.js';
import { qrArtPng, qrArtDataUrl } from '../src/art/raster.js';
import { styleFor, type ModuleShape, type FinderStyle } from '../src/art/qr-art.js';

/**
 * Reading the picture back the way a scanner would.
 *
 * The rasteriser is a second implementation of geometry the SVG renderer
 * already has, and two implementations of one thing drift. Checking that the
 * PNG "looks right" would not catch the drift that matters, because the failure
 * is not visible — a code that binarises to the wrong matrix still looks
 * exactly like a QR to a person.
 *
 * So these tests threshold the pixels and compare the recovered matrix to the
 * one that went in. That covers the whole chain in one assertion: if a module
 * shape shrank too far, a finder ring landed a pixel off, or the supersampling
 * washed out a boundary, the matrix comes back different.
 */

const LINK = 'solana:BTaPkeDYRuXbL6hEDsWPAWXUfZvjEoKoV3mCTQ91QFeH?amount=0.01';
const REFERENCE = '695xPtsSYaSALQdwgE6WxC4zX49zZrpVPwF2uiUGjCBB';

/** Pull the RGB scanlines back out of a PNG this project wrote. */
function decodePng(png: Uint8Array): { side: number; pixels: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const side = view.getUint32(16); // IHDR width, past signature and length/type

  expect(png[25], 'colour type should be truecolour RGB').toBe(2);

  const idat: Uint8Array[] = [];
  let at = 8;

  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }

  const raw = new Uint8Array(inflateSync(Buffer.concat(idat)));
  const stride = 1 + side * 3;
  const pixels = new Uint8Array(side * side * 3);

  for (let y = 0; y < side; y += 1) {
    expect(raw[y * stride], `row ${y} filter`).toBe(0);
    pixels.set(raw.subarray(y * stride + 1, y * stride + 1 + side * 3), y * side * 3);
  }

  return { side, pixels };
}

/** The quiet-zone width, the way the renderer infers it. */
function marginOf(matrix: boolean[][]): number {
  let margin = 0;
  while (margin < matrix.length && matrix[margin]!.every((cell) => !cell)) margin += 1;
  return margin;
}

function finderOrigins(size: number, margin: number): Array<[number, number]> {
  return [
    [margin, margin],
    [margin, size - margin - 7],
    [size - margin - 7, margin],
  ];
}

function inFinder(row: number, col: number, origins: Array<[number, number]>): boolean {
  return origins.some(([r, c]) => row >= r && row < r + 7 && col >= c && col < c + 7);
}

/**
 * Binarise the image the naive way, which is the hostile way.
 *
 * A real scanner adapts its threshold to local lighting. A flat cut at mid-grey
 * is stricter than that, so passing here means passing on a phone with room to
 * spare — and it removes the temptation to tune the threshold until the test
 * agrees with the renderer.
 *
 * Finder modules come back as `null` rather than a boolean, and the reason is
 * worth stating because the first version of this file got it wrong and
 * reported twelve failures that were not bugs.
 *
 * A rounded or circular finder does clip the four corner modules of its 7x7
 * block. That looked like damage, and it is not: the corners of a finder carry
 * no data and are never sampled. A decoder locates a code by the 1:1:3:1:1 run
 * ratio along the lines through each finder's centre, then builds its
 * perspective transform from the three centres — none of which touches a
 * corner. So comparing them to the matrix asserts something no scanner needs,
 * and `preservesFinderRatio` below asserts the thing one does.
 */
function recoverMatrix(
  png: Uint8Array,
  matrix: boolean[][],
  scale: number,
): Array<Array<boolean | null>> {
  const modules = matrix.length;
  const { side, pixels } = decodePng(png);
  expect(side).toBe(modules * scale);

  const origins = finderOrigins(modules, marginOf(matrix));
  const out: Array<Array<boolean | null>> = [];

  for (let row = 0; row < modules; row += 1) {
    const line: Array<boolean | null> = [];

    for (let col = 0; col < modules; col += 1) {
      if (inFinder(row, col, origins)) {
        line.push(null);
        continue;
      }

      // The centre of the module, which is where a scanner samples too.
      const px = Math.floor(col * scale + scale / 2);
      const py = Math.floor(row * scale + scale / 2);
      const at = (py * side + px) * 3;
      const grey = 0.299 * pixels[at]! + 0.587 * pixels[at + 1]! + 0.114 * pixels[at + 2]!;

      line.push(grey < 128);
    }

    out.push(line);
  }

  return out;
}

/** The matrix with finder modules blanked, so the two are comparable. */
function expectedMatrix(matrix: boolean[][]): Array<Array<boolean | null>> {
  const origins = finderOrigins(matrix.length, marginOf(matrix));
  return matrix.map((line, row) =>
    line.map((cell, col) => (inFinder(row, col, origins) ? null : cell)),
  );
}

/**
 * The check a scanner actually performs on a finder.
 *
 * Walks the pixel line through a finder's centre and measures the run lengths
 * of dark and light. The spec's proportions are 1:1:3:1:1 — dark band, light
 * gap, dark core, light gap, dark band — and finding that ratio is how every
 * decoder locates a code before it reads a bit. Styling that survives this is
 * styling a scanner cannot object to.
 */
function preservesFinderRatio(
  png: Uint8Array,
  matrix: boolean[][],
  scale: number,
  axis: 'row' | 'col',
): boolean {
  const { side, pixels } = decodePng(png);

  const dark = (x: number, y: number): boolean => {
    const at = (y * side + x) * 3;
    return 0.299 * pixels[at]! + 0.587 * pixels[at + 1]! + 0.114 * pixels[at + 2]! < 128;
  };

  for (const [r, c] of finderOrigins(matrix.length, marginOf(matrix))) {
    // Straight through the middle of the seven-module block.
    const fixed = Math.floor((axis === 'row' ? r + 3.5 : c + 3.5) * scale);
    const from = Math.floor((axis === 'row' ? c - 1 : r - 1) * scale);
    const to = Math.floor((axis === 'row' ? c + 8 : r + 8) * scale);

    const runs: Array<{ dark: boolean; length: number }> = [];
    for (let i = from; i < to; i += 1) {
      const isDark = axis === 'row' ? dark(i, fixed) : dark(fixed, i);
      const last = runs[runs.length - 1];
      if (last && last.dark === isDark) last.length += 1;
      else runs.push({ dark: isDark, length: 1 });
    }

    const core = runs.findIndex(
      (run, i) => run.dark && i >= 2 && run.length > scale * 2,
    );
    if (core < 2 || core + 2 >= runs.length) return false;

    const unit = runs[core]!.length / 3;
    const measured = [
      runs[core - 2]!.length / unit,
      runs[core - 1]!.length / unit,
      3,
      runs[core + 1]!.length / unit,
      runs[core + 2]!.length / unit,
    ];
    const wanted = [1, 1, 3, 1, 1];

    // Half a module of tolerance, which is roughly what decoders allow.
    if (!measured.every((ratio, i) => Math.abs(ratio - wanted[i]!) <= 0.5)) return false;
  }

  return true;
}

describe('the artwork still binarises to the code it was made from', () => {
  const matrix = qrMatrix(LINK);

  it('recovers the exact matrix at the default style', () => {
    const png = qrArtPng(matrix, REFERENCE, { scale: 10 });
    expect(recoverMatrix(png, matrix, 10)).toEqual(expectedMatrix(matrix));
  });

  it('recovers it for every module shape and finder style', () => {
    // The combination sweep is the point: a finder ring that reads correctly
    // as a square can lose its gap once it is drawn as a circle.
    const base = styleFor(REFERENCE);

    for (const shape of ['square', 'rounded', 'dot', 'diamond'] as const satisfies readonly ModuleShape[]) {
      for (const finder of ['square', 'rounded', 'circle'] as const satisfies readonly FinderStyle[]) {
        const png = qrArtPng(matrix, REFERENCE, { scale: 10, style: { ...base, shape, finder } });
        expect(recoverMatrix(png, matrix, 10), `${shape}/${finder}`).toEqual(expectedMatrix(matrix));
      }
    }
  });

  it('survives the tightest fill the seed is allowed to pick', () => {
    // 0.82 is the floor in `styleFor`. If the floor is too low, this is where
    // it shows up — thin dark runs are what a scanner loses first.
    const png = qrArtPng(matrix, REFERENCE, {
      scale: 10,
      style: { ...styleFor(REFERENCE), shape: 'dot', fill: 0.82 },
    });

    expect(recoverMatrix(png, matrix, 10)).toEqual(expectedMatrix(matrix));
  });

  it('recovers the matrix across many different seeds', () => {
    // Every seed picks different colours, and a palette that binarises wrongly
    // would be a code that scans for most payments and not for one.
    for (let i = 0; i < 25; i += 1) {
      const png = qrArtPng(matrix, `seed-${i}`, { scale: 10 });
      expect(recoverMatrix(png, matrix, 10), `seed-${i}`).toEqual(expectedMatrix(matrix));
    }
  });

  it('keeps the 1:1:3:1:1 finder ratio a decoder looks for', () => {
    // The property that replaces comparing finder corners to the matrix. Every
    // style must survive it on both axes, because detection scans both.
    const base = styleFor(REFERENCE);

    for (const finder of ['square', 'rounded', 'circle'] as const) {
      const png = qrArtPng(matrix, REFERENCE, { scale: 10, style: { ...base, finder } });
      expect(preservesFinderRatio(png, matrix, 10, 'row'), `${finder} across`).toBe(true);
      expect(preservesFinderRatio(png, matrix, 10, 'col'), `${finder} down`).toBe(true);
    }
  });

  it('still recovers it at a small scale', () => {
    // Telegram will resize; six pixels a module is about the floor worth
    // sending, and the finder geometry has least room to be right here.
    const png = qrArtPng(matrix, REFERENCE, { scale: 6 });
    expect(recoverMatrix(png, matrix, 6)).toEqual(expectedMatrix(matrix));
  });
});

describe('the file it produces', () => {
  const matrix = qrMatrix(LINK);

  it('is a PNG that starts with the signature', () => {
    const png = qrArtPng(matrix, REFERENCE, { scale: 4 });
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('is byte-identical for the same seed', () => {
    const a = qrArtPng(matrix, REFERENCE, { scale: 4 });
    const b = qrArtPng(matrix, REFERENCE, { scale: 4 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('differs between payments', () => {
    const a = qrArtPng(matrix, 'ref-a', { scale: 4 });
    const b = qrArtPng(matrix, 'ref-b', { scale: 4 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('never touches the matrix it was given', () => {
    const before = JSON.stringify(matrix);
    qrArtPng(matrix, REFERENCE, { scale: 4 });
    expect(JSON.stringify(matrix)).toBe(before);
  });

  it('leaves the quiet zone in paper', () => {
    // The border a scanner uses to find the code. Anything drawn here is the
    // most effective way to make a pretty code unreadable.
    const png = qrArtPng(matrix, REFERENCE, { scale: 8 });
    const { side, pixels } = decodePng(png);

    for (const [x, y] of [[0, 0], [side - 1, 0], [0, side - 1], [side - 1, side - 1], [side >> 1, 2]]) {
      const at = (y! * side + x!) * 3;
      const grey = 0.299 * pixels[at]! + 0.587 * pixels[at + 1]! + 0.114 * pixels[at + 2]!;
      expect(grey, `(${x},${y})`).toBeGreaterThan(200);
    }
  });

  it('offers a data URL for anywhere that wants an img src', () => {
    expect(qrArtDataUrl(matrix, REFERENCE, { scale: 2 })).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  });
});
