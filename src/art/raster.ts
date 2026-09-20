/**
 * The same artwork, as pixels.
 *
 * Telegram sends photos, not vectors, so the art has to reach a raster
 * somehow. The obvious route is to render the SVG with a headless browser or a
 * native rasteriser, and both are a large dependency for one picture — this
 * project counts its dependencies and a QR generator that pulls in a rendering
 * engine has lost the argument.
 *
 * So the shapes are drawn directly. The PNG encoder already exists in
 * `core/qr-render.ts`; what is added here is colour (type 2 rather than
 * greyscale) and the same geometry the SVG uses, evaluated per pixel instead of
 * emitted as paths.
 *
 * **Two renderers of one thing is a correctness problem, not a convenience.**
 * The danger is that they drift: the SVG rounds a corner one way, the raster
 * another, and the picture a payer scans in Telegram is not the picture the
 * receipt verifies against. Two things keep them together — the geometry
 * constants live in `qr-art.ts` and are imported rather than restated, and the
 * tests decode the rasterised output back to the original matrix rather than
 * trusting that it looks right.
 *
 * Supersampling is not cosmetic here either. A hard-edged circle at eight
 * pixels per module produces stair-stepping that a phone camera reads as noise
 * at the module boundary, which is exactly where a scanner is measuring.
 */

import type { QrMatrix } from '../core/qr.js';
import { encodePng } from '../core/qr-render.js';
import { styleFor, type ArtStyle, type FinderStyle, type ModuleShape } from './qr-art.js';

export interface RasterOptions {
  /** Pixels per module before supersampling. */
  scale?: number;
  /** Override the style derived from the seed. */
  style?: ArtStyle;
  /**
   * Samples per pixel edge. Three is the point where the stair-stepping stops
   * costing reads; higher is slower and looks the same.
   */
  supersample?: number;
}

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Whether a point is inside a rounded rectangle.
 *
 * Handles every finder style, because a circle is only a rounded rectangle
 * whose radius is half its side — which is how the SVG draws it too, via `rx`.
 * Keeping one function for both is what stops the two renderers disagreeing
 * about what `circle` means.
 */
function inRoundedRect(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): boolean {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  if (r <= 0) return true;

  const radius = Math.min(r, Math.min(w, h) / 2);
  // Distance from the nearest corner's centre of curvature; inside the straight
  // sections both terms are zero and the test trivially passes.
  const dx = Math.max(x + radius - px, 0, px - (x + w - radius));
  const dy = Math.max(y + radius - py, 0, py - (y + h - radius));

  return dx * dx + dy * dy <= radius * radius;
}

/** Whether a point inside one module's cell is covered by the module's shape. */
function inModule(shape: ModuleShape, u: number, v: number, fill: number): boolean {
  const margin = (1 - fill) / 2;
  const cx = 0.5;

  switch (shape) {
    case 'dot': {
      const r = fill / 2;
      return (u - cx) ** 2 + (v - cx) ** 2 <= r * r;
    }
    case 'diamond':
      return Math.abs(u - cx) + Math.abs(v - cx) <= fill / 2;
    case 'rounded':
      return inRoundedRect(u, v, margin, margin, fill, fill, fill * 0.3);
    default:
      return u >= margin && u <= 1 - margin && v >= margin && v <= 1 - margin;
  }
}

/**
 * What a point inside a 7x7 finder pattern is: its ring, its core, or neither.
 *
 * The proportions are the spec's — a one-module band, a one-module gap, a
 * three-module core — and only the corner radius varies. Changing anything else
 * is the fastest way to make a code unfindable, since these are what a scanner
 * locks onto before it reads a single bit.
 */
function inFinderShape(style: FinderStyle, u: number, v: number): 'ring' | 'core' | null {
  const radius = style === 'circle' ? 3.5 : style === 'rounded' ? 2 : 0;
  const coreRadius = style === 'circle' ? 1.5 : style === 'rounded' ? 0.8 : 0;

  if (inRoundedRect(u, v, 2, 2, 3, 3, coreRadius)) return 'core';

  const outside = !inRoundedRect(u, v, 0, 0, 7, 7, radius);
  const inHole = inRoundedRect(u, v, 1, 1, 5, 5, Math.max(0, radius - 1));

  return outside || inHole ? null : 'ring';
}

/** The quiet-zone width, inferred from the matrix rather than assumed. */
function marginOf(matrix: QrMatrix): number {
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

/**
 * Render a matrix as a colour PNG.
 *
 * Mirrors `renderQrArt` exactly: same style derivation, same shapes, same
 * finder geometry, same untouched matrix. The quiet zone is painted in paper
 * and nothing else, because it is the border a scanner uses to find the code.
 */
export function qrArtPng(matrix: QrMatrix, seed: string, options: RasterOptions = {}): Uint8Array {
  const scale = options.scale ?? 8;
  const ss = options.supersample ?? 3;
  const style = options.style ?? styleFor(seed);

  const size = matrix.length;
  const side = size * scale;
  const margin = marginOf(matrix);
  const origins = finderOrigins(size, margin);

  const ink = rgb(style.palette.ink);
  const paper = rgb(style.palette.paper);
  const accent = rgb(style.palette.accent);
  const accentDeep = rgb(style.palette.accentDeep);

  // Row stride carries a leading filter byte, as PNG requires; 0 means "none",
  // which is right for flat colour with no gradients for a predictor to use.
  const stride = 1 + side * 3;
  const raw = new Uint8Array(side * stride);

  // Which finder, if any, covers each module — computed once per cell rather
  // than per sample, since it is the same for all ss² samples in the cell.
  const finderAt = (row: number, col: number): [number, number] | null =>
    origins.find(([r, c]) => row >= r && row < r + 7 && col >= c && col < c + 7) ?? null;

  for (let py = 0; py < side; py += 1) {
    raw[py * stride] = 0;

    for (let px = 0; px < side; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;

      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          // Sample at the centre of each sub-pixel, in module units.
          const mx = (px + (sx + 0.5) / ss) / scale;
          const my = (py + (sy + 0.5) / ss) / scale;
          const col = Math.floor(mx);
          const row = Math.floor(my);

          let colour = paper;
          const finder = finderAt(row, col);

          if (finder) {
            const part = inFinderShape(style.finder, mx - finder[1], my - finder[0]);
            if (part === 'ring') colour = accent;
            else if (part === 'core') colour = accentDeep;
          } else if (matrix[row]?.[col] && inModule(style.shape, mx - col, my - row, style.fill)) {
            colour = ink;
          }

          r += colour[0];
          g += colour[1];
          b += colour[2];
        }
      }

      const samples = ss * ss;
      const at = py * stride + 1 + px * 3;
      raw[at] = Math.round(r / samples);
      raw[at + 1] = Math.round(g / samples);
      raw[at + 2] = Math.round(b / samples);
    }
  }

  return encodePng(raw, side, side, 2);
}

/** A `data:` URL of the artwork, for an `<img src>` or a web preview. */
export function qrArtDataUrl(matrix: QrMatrix, seed: string, options: RasterOptions = {}): string {
  return `data:image/png;base64,${Buffer.from(qrArtPng(matrix, seed, options)).toString('base64')}`;
}
