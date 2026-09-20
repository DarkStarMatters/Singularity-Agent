import { describe, it, expect } from 'vitest';
import { qrMatrix } from '../src/core/qr.js';
import { renderQrArt, styleFor } from '../src/art/qr-art.js';
import { contrastRatio, hsl, paletteFor } from '../src/art/palette.js';
import { SeedStream } from '../src/art/seed.js';

/**
 * Art that cannot stop a code scanning.
 *
 * Styling a QR is damage done on purpose, paid for out of the same error
 * correction that covers a scuff on a printed label. The danger is that
 * overspending looks fine: the picture still reads as a QR to a person and
 * stops reading as one to a cheap camera in bad light, which presents as the
 * customer's phone being at fault.
 *
 * So the properties that keep it readable are asserted rather than intended —
 * contrast across the whole hue wheel, an untouched matrix, an empty quiet
 * zone. The decode round-trip in `qr.test.ts` still governs the matrix itself;
 * nothing here is allowed to change it.
 */

const REFERENCE = '695xPtsSYaSALQdwgE6WxC4zX49zZrpVPwF2uiUGjCBB';
const LINK = 'solana:BTaPkeDYRuXbL6hEDsWPAWXUfZvjEoKoV3mCTQ91QFeH?amount=0.01';

describe('the same payment always looks the same', () => {
  it('derives an identical style from an identical seed', () => {
    expect(styleFor(REFERENCE)).toEqual(styleFor(REFERENCE));
  });

  it('renders identical SVG from an identical seed', () => {
    const matrix = qrMatrix(LINK);
    expect(renderQrArt(matrix, REFERENCE)).toBe(renderQrArt(matrix, REFERENCE));
  });

  it('gives different payments different styles', () => {
    // A reference is unique per payment, so the art is a fingerprint of one
    // rather than a decoration applied to all of them.
    const styles = ['ref-a', 'ref-b', 'ref-c', 'ref-d', 'ref-e', 'ref-f'].map(styleFor);
    const distinct = new Set(styles.map((s) => JSON.stringify(s)));

    expect(distinct.size).toBe(styles.length);
  });

  it('can be re-derived by anyone holding the reference', () => {
    // The property that makes the art evidence rather than ornament: given the
    // reference from a settled payment, the picture is reproducible.
    const fresh = styleFor(REFERENCE);
    expect(fresh.palette.ink).toBe(styleFor(REFERENCE).palette.ink);
  });
});

describe('contrast, which is what a scanner actually reads', () => {
  it('keeps ink and paper far apart at every hue the seed can pick', () => {
    // The check that matters most. A scanner needs roughly 3:1; anything the
    // seed can produce must clear that with room for a dimmed screen and an
    // oblique angle.
    let worst = Infinity;

    for (let i = 0; i < 400; i += 1) {
      const palette = paletteFor(new SeedStream(`seed-${i}`));
      const ratio = contrastRatio(palette.ink, palette.paper);
      worst = Math.min(worst, ratio);
    }

    expect(worst).toBeGreaterThan(7);
  });

  it('keeps the finder accents readable as dark too', () => {
    // The finders are the first thing a scanner locks onto. A pale accent makes
    // a code that looks striking and will not be found.
    let worst = Infinity;

    for (let i = 0; i < 400; i += 1) {
      const palette = paletteFor(new SeedStream(`accent-${i}`));
      worst = Math.min(
        worst,
        contrastRatio(palette.accent, palette.paper),
        contrastRatio(palette.accentDeep, palette.paper),
      );
    }

    expect(worst).toBeGreaterThan(4.5);
  });

  it('computes contrast the way the standard does', () => {
    // Reference values rather than a property I could derive wrongly: black on
    // white is 21:1 exactly, and a colour against itself is 1:1.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeGreaterThan(4);
  });

  it('converts HSL to the hex a browser would', () => {
    expect(hsl(0, 100, 50)).toBe('#ff0000');
    expect(hsl(120, 100, 50)).toBe('#00ff00');
    expect(hsl(240, 100, 50)).toBe('#0000ff');
    expect(hsl(0, 0, 100)).toBe('#ffffff');
    expect(hsl(0, 0, 0)).toBe('#000000');
  });
});

describe('what the renderer is not allowed to do', () => {
  const matrix = qrMatrix(LINK);

  it('never changes the matrix it was given', () => {
    // Rendering decides what a module looks like and nothing else. If it could
    // add or move one, the decode test would no longer govern correctness.
    const before = JSON.stringify(matrix);
    renderQrArt(matrix, REFERENCE);
    expect(JSON.stringify(matrix)).toBe(before);
  });

  it('leaves the quiet zone empty', () => {
    // The border a scanner uses to find the code at all. Decorating it is the
    // most tempting way to ruin one, so nothing is drawn there.
    const svg = renderQrArt(matrix, REFERENCE, { scale: 10 });
    const paths = /<path fill="[^"]+" d="([^"]*)"/.exec(svg)?.[1] ?? '';

    // Every drawn module starts with a move-to whose coordinates must sit
    // inside the four-module border.
    const quiet = 4 * 10;
    const side = matrix.length * 10;

    for (const [, x, y] of paths.matchAll(/M([\d.]+) ([\d.]+)/g)) {
      const px = Number(x);
      const py = Number(y);
      expect(px, `x=${px}`).toBeGreaterThanOrEqual(quiet - 1);
      expect(py, `y=${py}`).toBeGreaterThanOrEqual(quiet - 1);
      expect(px).toBeLessThan(side - quiet + 1);
      expect(py).toBeLessThan(side - quiet + 1);
    }
  });

  it('never fills a module below the readable floor', () => {
    // Thin dark runs are what a scanner loses first in poor light.
    for (let i = 0; i < 200; i += 1) {
      expect(styleFor(`fill-${i}`).fill).toBeGreaterThanOrEqual(0.82);
      expect(styleFor(`fill-${i}`).fill).toBeLessThanOrEqual(1);
    }
  });
});

describe('the SVG it produces', () => {
  const matrix = qrMatrix(LINK);

  it('sizes the canvas to the module count', () => {
    const svg = renderQrArt(matrix, REFERENCE, { scale: 8 });
    const side = matrix.length * 8;
    expect(svg).toContain(`width="${side}" height="${side}"`);
  });

  it('draws three finder patterns as shapes rather than as loose modules', () => {
    const svg = renderQrArt(matrix, REFERENCE);
    // Two rects each — a ring and a core — plus one background rect.
    expect((svg.match(/<rect/g) ?? []).length).toBe(7);
  });

  it('paints a background, so a dark viewer theme cannot invert it', () => {
    // A transparent QR on a dark background is an inverted QR, and most
    // scanners will not read one.
    const svg = renderQrArt(matrix, REFERENCE);
    expect(svg).toMatch(/<rect width="\d+" height="\d+" fill="#[0-9a-f]{6}"\/>/);
  });

  it('escapes a caption rather than letting it close a tag', () => {
    const svg = renderQrArt(matrix, REFERENCE, { caption: 'Order <7> & "more"' });
    expect(svg).toContain('&lt;7&gt;');
    expect(svg).toContain('&amp;');
    expect(svg).not.toContain('<7>');
  });

  it('omits the caption band entirely when there is no caption', () => {
    const matrix2 = qrMatrix(LINK);
    const plain = renderQrArt(matrix2, REFERENCE, { scale: 8 });
    const side = matrix2.length * 8;
    expect(plain).toContain(`height="${side}"`);
  });

  it('renders every module shape and finder style without breaking', () => {
    for (const shape of ['square', 'rounded', 'dot', 'diamond'] as const) {
      for (const finder of ['square', 'rounded', 'circle'] as const) {
        const svg = renderQrArt(matrix, REFERENCE, {
          style: { ...styleFor(REFERENCE), shape, finder },
        });
        expect(svg.startsWith('<svg'), `${shape}/${finder}`).toBe(true);
        expect(svg.endsWith('</svg>')).toBe(true);
      }
    }
  });
});
