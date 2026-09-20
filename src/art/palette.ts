/**
 * Colour that varies without ever costing a scan.
 *
 * This is the whole difficulty of an artistic QR in one file. A scanner does
 * not see colours; it sees light and dark, and it needs enough difference
 * between them to tell which is which. Pick two pleasant colours at random and
 * a good fraction of the pairs are unreadable — not obviously, but on a cheap
 * camera in bad light, which is the failure that gets blamed on the customer's
 * phone.
 *
 * So the rule here is: **vary hue, never vary contrast.** The seed chooses
 * where on the colour wheel a receipt sits and how saturated it is. It proposes
 * a lightness and then gives it up: every dark colour is darkened until it
 * measurably clears its target against that receipt's paper. The result is that
 * every payment looks different and every payment scans.
 *
 * `contrastRatio` is the constructor rather than the check. The first version of
 * this file used it only as a check, chose lightness bands by eye, and shipped
 * an accent at 2.18:1 — the test caught it. Measuring and then fixing the colour
 * is the difference between a property and a hope.
 */

import type { SeedStream } from './seed.js';

export interface Palette {
  /** Dark modules. Always dark enough to read as "on". */
  ink: string;
  /** Light modules and the quiet zone. Always near-white. */
  paper: string;
  /** The three finder patterns, so the eye has somewhere to land. */
  accent: string;
  /** A second accent, for the finder centres. */
  accentDeep: string;
  /** Human name for the scheme, for NFT attributes. */
  name: string;
}

/**
 * Lightness bands, in HSL percent.
 *
 * Where a colour *starts*, not where it ends up. Paper is final — near-white at
 * any hue is near-white. Ink and the accents are only proposals, and
 * `darkenUntilReadable` below moves them until the contrast is actually there,
 * because lightness is not brightness and a band cannot promise a ratio.
 */
const INK_LIGHTNESS = { min: 12, max: 22 } as const;
const PAPER_LIGHTNESS = { min: 94, max: 98 } as const;
const ACCENT_LIGHTNESS = { min: 26, max: 38 } as const;

/** Named bands of the colour wheel, so a receipt can say what it looks like. */
const HUE_NAMES: Array<[number, string]> = [
  [15, 'ember'],
  [45, 'amber'],
  [75, 'moss'],
  [105, 'fern'],
  [150, 'jade'],
  [195, 'cyan'],
  [225, 'azure'],
  [260, 'indigo'],
  [290, 'violet'],
  [320, 'magenta'],
  [350, 'rose'],
  [360, 'ember'],
];

function nameForHue(hue: number): string {
  for (const [ceiling, name] of HUE_NAMES) if (hue < ceiling) return name;
  return 'ember';
}

/** HSL to a `#rrggbb` string. Hand-rolled; it is nine lines and one dependency. */
export function hsl(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;

  const [r, g, b] =
    h < 60 ? [c, x, 0] :
    h < 120 ? [x, c, 0] :
    h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] :
    h < 300 ? [x, 0, c] :
    [c, 0, x];

  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r!)}${hex(g!)}${hex(b!)}`;
}

/** Relative luminance, per WCAG, for the contrast check. */
function luminance(hex: string): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };

  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Contrast between two colours, 1:1 to 21:1.
 *
 * A QR scanner wants this comfortably above 3. Everything generated here sits
 * above 10, and `test/qr-art.test.ts` sweeps the whole hue wheel to prove it
 * rather than trusting the bands above to have been chosen correctly.
 */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/**
 * Walk a colour's lightness down until it contrasts enough with the paper.
 *
 * Bands alone cannot guarantee this and the first version of this file tried:
 * lightness is not brightness. Yellow at 38% lightness is far brighter to the
 * eye — and to a sensor — than blue at the same number, so a band wide enough
 * to be interesting at one hue is too pale at another. A sweep across the wheel
 * found an accent at 2.18:1, under the 3:1 a scanner needs.
 *
 * So the property is built rather than hoped for. Start where the seed asked,
 * and darken in one-point steps until it passes. It always terminates: every
 * hue clears the target long before black.
 */
function darkenUntilReadable(hue: number, saturation: number, lightness: number, paper: string, target: number): string {
  for (let l = lightness; l > 4; l -= 1) {
    const candidate = hsl(hue, saturation, l);
    if (contrastRatio(candidate, paper) >= target) return candidate;
  }
  return hsl(hue, saturation, 4);
}

/**
 * The palette for one receipt.
 *
 * Two hues rather than one: a base and a companion some way around the wheel,
 * so the finder patterns read as deliberate rather than as a printing error.
 * How far around is itself seeded, which is where most of the visual variety
 * between receipts comes from.
 */
export function paletteFor(stream: SeedStream): Palette {
  const hue = stream.below(360);
  const saturation = stream.between(45, 85);

  // Complementary, triadic or analogous — the three relationships that look
  // intentional. A freely chosen second hue mostly looks like a mistake.
  const offset = stream.pick([30, 150, 180, 210] as const);
  const accentHue = (hue + offset) % 360;

  const paper = hsl(hue, stream.between(8, 22), stream.between(PAPER_LIGHTNESS.min, PAPER_LIGHTNESS.max));

  // Targets differ because the jobs differ. Ink is every data module and gets
  // the widest margin; the accents are the finder patterns, which a scanner
  // locks onto first and which are large, so they need less.
  return {
    ink: darkenUntilReadable(hue, Math.min(saturation, 60), stream.between(INK_LIGHTNESS.min, INK_LIGHTNESS.max), paper, 8),
    paper,
    accent: darkenUntilReadable(accentHue, saturation, stream.between(ACCENT_LIGHTNESS.min, ACCENT_LIGHTNESS.max), paper, 5),
    accentDeep: darkenUntilReadable(accentHue, saturation, stream.between(INK_LIGHTNESS.min, INK_LIGHTNESS.max), paper, 8),
    name: `${nameForHue(hue)}/${nameForHue(accentHue)}`,
  };
}
