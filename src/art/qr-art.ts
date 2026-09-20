/**
 * A QR that is also a picture of one specific payment.
 *
 * Every choice here is spent out of the same budget: a QR tolerates damage, and
 * styling is damage you did on purpose. Rounded modules erase corners, gaps
 * between modules thin the dark runs, a logo covers them outright. Spend too
 * much and the code still looks like a QR and stops being one — on a cheap
 * camera first, in bad light first, which is the failure that gets blamed on
 * the person holding the phone.
 *
 * Three rules keep that from happening, and each is checked rather than trusted:
 *
 * 1. **The matrix is never touched.** Nothing here adds, removes or moves a
 *    module. Rendering decides what a module *looks* like and nothing else, so
 *    the decode round-trip in `test/qr.test.ts` still governs correctness.
 * 2. **Contrast never varies.** See `palette.ts` — the seed picks hue, never
 *    lightness.
 * 3. **The quiet zone stays empty.** It is the border a scanner uses to find
 *    the code at all, and decorating it is the most tempting way to ruin one.
 *
 * What is left to vary is still plenty: hue, module geometry, how the finder
 * patterns are drawn, and how tightly the modules pack.
 */

import type { QrMatrix } from '../core/qr.js';
import { SeedStream } from './seed.js';
import { paletteFor, type Palette } from './palette.js';

/**
 * How a single dark module is drawn.
 *
 * `dot` is the most aggressive — a circle inscribed in the cell loses the
 * corners, which is roughly a fifth of the ink. It is still comfortably inside
 * what error correction absorbs at the levels these codes use, and it is the
 * shape people recognise as a "designed" QR.
 */
export type ModuleShape = 'square' | 'rounded' | 'dot' | 'diamond';

/** How the three corner patterns are drawn. */
export type FinderStyle = 'square' | 'rounded' | 'circle';

export interface ArtStyle {
  palette: Palette;
  shape: ModuleShape;
  finder: FinderStyle;
  /**
   * Fraction of the cell a module fills, 0.82–1.
   *
   * Below about 0.8 the dark runs get thin enough that a scanner starts
   * needing good light, so the floor is set above it rather than left to the
   * seed.
   */
  fill: number;
}

/** The style one payment gets, derived from its reference. */
export function styleFor(seed: string): ArtStyle {
  const stream = new SeedStream(seed);

  return {
    palette: paletteFor(stream),
    shape: stream.pick(['square', 'rounded', 'dot', 'diamond'] as const),
    finder: stream.pick(['square', 'rounded', 'circle'] as const),
    fill: 0.82 + stream.fraction() * 0.18,
  };
}

export interface ArtOptions {
  /** Pixels per module. */
  scale?: number;
  /** Override the derived style, for previews and tests. */
  style?: ArtStyle;
  /** A short line under the code. Omitted when absent. */
  caption?: string;
}

/** Where the three finder patterns sit, given the matrix and its quiet zone. */
function finderOrigins(size: number, margin: number): Array<[number, number]> {
  return [
    [margin, margin],
    [margin, size - margin - 7],
    [size - margin - 7, margin],
  ];
}

/** True when (row, col) falls inside any 7x7 finder pattern. */
function inFinder(row: number, col: number, origins: Array<[number, number]>): boolean {
  return origins.some(([r, c]) => row >= r && row < r + 7 && col >= c && col < c + 7);
}

/** The quiet-zone width, inferred from the matrix rather than assumed. */
function marginOf(matrix: QrMatrix): number {
  let margin = 0;
  while (margin < matrix.length && matrix[margin]!.every((cell) => !cell)) margin += 1;
  return margin;
}

/**
 * A coordinate, rounded to something worth writing down.
 *
 * Not cosmetic. `fill` is a fraction, so every offset arrives as float noise —
 * `56.339999999999996` rather than `56.34` — and an SVG carries a few thousand
 * of them. Left alone that is 400KB for one QR, which is too large to put in a
 * Telegram message, let alone anywhere near a chain. Two decimals is finer than
 * a pixel at any scale this renders at, and cuts the file by roughly four.
 */
function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function modulePath(shape: ModuleShape, x: number, y: number, size: number): string {
  const inset = size / 2;

  switch (shape) {
    case 'dot':
      return `M${n(x + inset)} ${n(y)}a${n(inset)} ${n(inset)} 0 1 0 0.01 0z`;
    case 'diamond':
      return `M${n(x + inset)} ${n(y)}L${n(x + size)} ${n(y + inset)}L${n(x + inset)} ${n(y + size)}L${n(x)} ${n(y + inset)}z`;
    case 'rounded': {
      const r = size * 0.3;
      const straight = n(size - 2 * r);
      const rr = n(r);
      return `M${n(x + r)} ${n(y)}h${straight}a${rr} ${rr} 0 0 1 ${rr} ${rr}v${straight}a${rr} ${rr} 0 0 1 -${rr} ${rr}h-${straight}a${rr} ${rr} 0 0 1 -${rr} -${rr}v-${straight}a${rr} ${rr} 0 0 1 ${rr} -${rr}z`;
    }
    default:
      return `M${n(x)} ${n(y)}h${n(size)}v${n(size)}h-${n(size)}z`;
  }
}

/**
 * A styled finder pattern.
 *
 * Drawn as two shapes — a ring and a centre — rather than as forty-nine
 * modules, which is what makes it look designed. The geometry is the spec's:
 * a seven-module square, a one-module light gap, a three-module core. Changing
 * those proportions is the fastest way to make a code unreadable, so only the
 * corner radius moves.
 */
function finderShapes(
  style: FinderStyle,
  x: number,
  y: number,
  unit: number,
  palette: Palette,
): string {
  const outer = unit * 7;
  const core = unit * 3;
  const radius = style === 'circle' ? outer / 2 : style === 'rounded' ? unit * 2 : 0;
  const coreRadius = style === 'circle' ? core / 2 : style === 'rounded' ? unit * 0.8 : 0;

  return [
    // The ring: a stroked square of exactly one module's width, which is the
    // spec's outer band.
    `<rect x="${n(x + unit / 2)}" y="${n(y + unit / 2)}" width="${n(outer - unit)}" height="${n(outer - unit)}" rx="${n(Math.max(0, radius - unit / 2))}" fill="none" stroke="${palette.accent}" stroke-width="${n(unit)}"/>`,
    `<rect x="${n(x + unit * 2)}" y="${n(y + unit * 2)}" width="${n(core)}" height="${n(core)}" rx="${n(coreRadius)}" fill="${palette.accentDeep}"/>`,
  ].join('');
}

/**
 * Render a matrix as artwork.
 *
 * Returns SVG, because it scales to any size a wallet or a marketplace wants
 * and because it is small enough to live on chain as a data URI — which is the
 * only way to mint a receipt whose image cannot later be rewritten. This
 * project ships a tool that warns about mutable metadata pointers; minting one
 * would be poor form.
 */
export function renderQrArt(matrix: QrMatrix, seed: string, options: ArtOptions = {}): string {
  const scale = options.scale ?? 12;
  const style = options.style ?? styleFor(seed);
  const size = matrix.length;
  const margin = marginOf(matrix);
  const origins = finderOrigins(size, margin);

  const side = size * scale;
  const captionHeight = options.caption ? scale * 3 : 0;

  const paths: string[] = [];

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!matrix[row]![col]) continue;
      // Finders are drawn as whole shapes below; skipping them here is what
      // stops forty-nine little dots appearing under the ring.
      if (inFinder(row, col, origins)) continue;

      const inset = (scale * (1 - style.fill)) / 2;
      paths.push(modulePath(style.shape, col * scale + inset, row * scale + inset, scale * style.fill));
    }
  }

  const finders = origins
    .map(([r, c]) => finderShapes(style.finder, c * scale, r * scale, scale, style.palette))
    .join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side + captionHeight}" viewBox="0 0 ${side} ${side + captionHeight}" shape-rendering="geometricPrecision">`,
    `<rect width="${side}" height="${side + captionHeight}" fill="${style.palette.paper}"/>`,
    `<path fill="${style.palette.ink}" d="${paths.join('')}"/>`,
    finders,
    options.caption
      ? `<text x="${side / 2}" y="${side + scale * 2}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="${scale * 1.1}" fill="${style.palette.ink}" opacity="0.65">${escapeXml(options.caption)}</text>`
      : '',
    '</svg>',
  ].join('');
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  );
}
