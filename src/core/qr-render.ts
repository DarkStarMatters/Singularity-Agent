/**
 * Four ways to put a QR matrix in front of somebody.
 *
 * The matrix is the hard part and it is done in `qr.ts`; everything here is
 * presentation, and which presentation you need is entirely about where the
 * person is looking:
 *
 * - **Unicode** for a terminal. Two rows per character cell, so the code stays
 *   square in a font where cells are twice as tall as they are wide.
 * - **SVG** for a web page or an email. Scales to any size, one path, no
 *   dependency at either end.
 * - **PNG** for Telegram, which will not render SVG and will not let somebody
 *   scan a URL out of a text message. Built on `node:zlib`, which is why this
 *   whole file adds no dependency.
 * - **Data URL** for dropping straight into an `<img src>`.
 */

import { deflateSync } from 'node:zlib';
import type { QrMatrix } from './qr.js';

/**
 * Half-block rendering for a terminal.
 *
 * Each character carries two matrix rows — upper and lower half — because a
 * terminal cell is about twice as tall as it is wide, and one module per cell
 * produces a code stretched to twice its height that phones struggle to read.
 *
 * Foreground and background are deliberately not coloured. A QR needs dark
 * modules on light, and a terminal theme that inverts them produces a code that
 * scans on nobody's phone; leaving it to the default means it inherits whatever
 * contrast the terminal already has.
 */
export function qrUnicode(matrix: QrMatrix): string {
  const lines: string[] = [];

  for (let row = 0; row < matrix.length; row += 2) {
    let line = '';
    for (let col = 0; col < matrix[row]!.length; col += 1) {
      const top = matrix[row]![col] ?? false;
      const bottom = matrix[row + 1]?.[col] ?? false;

      // Dark is the *filled* half. A QR wants dark modules on a light ground,
      // and these glyphs render as ink on the terminal background.
      if (top && bottom) line += '█';
      else if (top) line += '▀';
      else if (bottom) line += '▄';
      else line += ' ';
    }
    lines.push(line);
  }

  return lines.join('\n');
}

export interface SvgOptions {
  /** Pixels per module. Default 8. */
  scale?: number;
  /** Dark modules. Default black — do not make this light. */
  dark?: string;
  /** Light modules. Default white. */
  light?: string;
}

/**
 * One `<path>` of dark modules over a light rectangle.
 *
 * A path rather than a rect per module: a version-5 code is 37×37 plus quiet
 * zone, and emitting 1,300 elements makes a document that renders slowly and
 * diffs horribly. Contiguous dark runs in a row become one horizontal move,
 * which shortens it further.
 */
export function qrSvg(matrix: QrMatrix, options: SvgOptions = {}): string {
  const scale = options.scale ?? 8;
  const dark = options.dark ?? '#000000';
  const light = options.light ?? '#ffffff';
  const size = matrix.length * scale;

  const parts: string[] = [];

  for (let row = 0; row < matrix.length; row += 1) {
    let col = 0;
    while (col < matrix[row]!.length) {
      if (!matrix[row]![col]) {
        col += 1;
        continue;
      }
      let run = 1;
      while (matrix[row]![col + run]) run += 1;
      parts.push(`M${col * scale} ${row * scale}h${run * scale}v${scale}h-${run * scale}z`);
      col += run;
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`,
    `<rect width="${size}" height="${size}" fill="${light}"/>`,
    `<path fill="${dark}" d="${parts.join('')}"/>`,
    '</svg>',
  ].join('');
}

/** CRC-32, which PNG requires on every chunk. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);

  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));

  return out;
}

export interface PngOptions {
  /** Pixels per module. Default 8. */
  scale?: number;
}

/**
 * A greyscale PNG, for anywhere that wants an image file.
 *
 * Telegram is the reason this exists: it renders no SVG, and a `solana:` URL
 * pasted as text is not something anybody can point a phone at. `sendPhoto`
 * takes a PNG, so a QR reaches a chat the same way a photograph does.
 *
 * One bit per pixel would be the obvious encoding for a two-colour image, and
 * it is not used: eight bits costs a few kilobytes at these sizes and removes
 * the bit-packing as a place to be subtly wrong. Compression does most of that
 * work back, because a QR is large flat runs of one value.
 */
export function qrPng(matrix: QrMatrix, options: PngOptions = {}): Uint8Array {
  const scale = options.scale ?? 8;
  const size = matrix.length * scale;

  // Each row is prefixed with a filter byte; 0 means "no filter", which is
  // right here — a QR has no gradients for a predictor to exploit.
  const raw = new Uint8Array(size * (size + 1));
  let offset = 0;

  for (let row = 0; row < matrix.length; row += 1) {
    for (let repeat = 0; repeat < scale; repeat += 1) {
      raw[offset] = 0;
      offset += 1;

      for (let col = 0; col < matrix[row]!.length; col += 1) {
        const value = matrix[row]![col] ? 0x00 : 0xff;
        raw.fill(value, offset, offset + scale);
        offset += scale;
      }
    }
  }

  return encodePng(raw, size, size, 0);
}

/**
 * Wrap filtered scanlines in the PNG container.
 *
 * Exported because the artwork rasteriser in `art/raster.ts` needs the same
 * container in colour, and a second copy of the CRC table is a second place to
 * be wrong — the first draft of that file duplicated this and mistyped the
 * polynomial as 0xeddb8832. One implementation, two callers.
 *
 * `colourType` is PNG's: 0 is greyscale, 2 is truecolour RGB. `raw` must
 * already carry its per-row filter byte, which both callers set to 0 because
 * flat colour gives a predictor nothing to work with.
 */
export function encodePng(
  raw: Uint8Array,
  width: number,
  height: number,
  colourType: 0 | 2,
): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = colourType;
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }

  return png;
}

/** A `data:` URL of the PNG, for dropping straight into an `<img src>`. */
export function qrDataUrl(matrix: QrMatrix, options: PngOptions = {}): string {
  return `data:image/png;base64,${Buffer.from(qrPng(matrix, options)).toString('base64')}`;
}
