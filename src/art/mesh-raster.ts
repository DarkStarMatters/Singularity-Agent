/**
 * Drawing a mesh run.
 *
 * One renderer, not two. The QR art has an SVG and a raster because a payment
 * code has two consumers — a browser that wants paths and a phone camera that
 * wants pixels — and keeping those two in step is a standing cost that file
 * pays deliberately. This picture has one consumer, so it gets one renderer,
 * and the verification story stays simple: re-render the bytes and compare
 * them.
 *
 * Everything is drawn by hand for the same reason `raster.ts` gives. A
 * rendering engine is an enormous dependency for one image, and this project
 * counts its dependencies. What that costs is written out below: analytic
 * anti-aliasing on every primitive, because a fractal drawn with hard pixel
 * edges looks like a screenshot of one.
 *
 * ## The three layers
 *
 * **The field** is a Julia set, evaluated per pixel, with the parameter and the
 * iteration cap coming from the run (see `mesh-art.ts` for why). It is blended
 * well back toward the paper, because it is the ground the structure is drawn
 * on and a background that competes with the figure is a background that ruins
 * it.
 *
 * **The canopy** is the run itself: a stem that advances one segment per wave,
 * branches off each wave node for the calls that wave made, and a bifurcating
 * sub-canopy on every branch that paid — deeper the more it proved. Drawn once
 * and then repeated around the circle, once per fact the objective asked for.
 *
 * **The ledger** is the outer ring: one arc per call, sized by what the call
 * cost, filled when it was kept and hollow when it was thrown away, plus a
 * notch per goal fact with the proved ones filled. It is the part of the
 * picture you can read numbers off.
 */

import { encodePng } from '../core/qr-render.js';
import { type MeshArtFacts, type MeshArtStyle, type NodeShape, meshArtStyle } from './mesh-art.js';

export interface MeshRenderOptions {
  /** Pixels on a side. Square, always. */
  size?: number;
  /** Overrides the style derived from the facts. For previews only. */
  style?: MeshArtStyle;
}

export const DEFAULT_SIZE = 1024;

/**
 * The widest the Julia plane gets, in units of the disc's radius.
 *
 * Most interesting Julia sets live inside |z| < 1.5, so this frames the whole
 * set with a little air. Zooming further in would look more dramatic and would
 * stop the picture being a picture of the *set*, which is the thing carrying
 * the meaning.
 */
const PLANE_SPAN = 1.42;

/**
 * How much of the field survives the mix toward the ground.
 *
 * High, unlike the first version's fifty percent toward near-white. On a dark
 * ground the figure wins on luminance rather than by the background being
 * faded out, so the field gets to keep its structure.
 */
const FIELD_WEIGHT = 0.88;

/**
 * Where the field stops, as a fraction of the disc's radius.
 *
 * Inside the ledger, not behind it. The first version ran the field to the
 * full radius and the set spilled through the ring and off the top of the
 * frame — which read as a rendering bug rather than as a composition, and
 * made the one band you are supposed to be able to count arcs on the hardest
 * thing in the picture to see.
 */
const FIELD_EXTENT = 0.855;

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Hermite smoothstep, for edges that do not look like stairs. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * A float canvas with alpha compositing and analytic coverage.
 *
 * Floats rather than bytes because everything here is drawn as a stack of
 * partially transparent shapes, and rounding to eight bits between each one
 * accumulates into visible banding along every soft edge.
 */
class Canvas {
  readonly size: number;
  private readonly data: Float32Array;

  constructor(size: number, background: Rgb) {
    this.size = size;
    this.data = new Float32Array(size * size * 3);
    for (let i = 0; i < this.data.length; i += 3) {
      this.data[i] = background[0];
      this.data[i + 1] = background[1];
      this.data[i + 2] = background[2];
    }
  }

  /** Blend one pixel. Out-of-bounds and zero coverage are no-ops. */
  plot(x: number, y: number, colour: Rgb, alpha: number): void {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const a = alpha > 1 ? 1 : alpha;
    const i = (y * this.size + x) * 3;
    const r = this.data[i]!;
    const g = this.data[i + 1]!;
    const b = this.data[i + 2]!;
    this.data[i] = r + (colour[0] - r) * a;
    this.data[i + 1] = g + (colour[1] - g) * a;
    this.data[i + 2] = b + (colour[2] - b) * a;
  }

  /** Replace one pixel outright. Used only by the field, which paints first. */
  set(x: number, y: number, colour: Rgb): void {
    const i = (y * this.size + x) * 3;
    this.data[i] = colour[0];
    this.data[i + 1] = colour[1];
    this.data[i + 2] = colour[2];
  }

  /**
   * A stroked line segment with round caps.
   *
   * Coverage is `halfWidth + 0.5 - distance`, clamped — the exact area
   * argument a scanline rasteriser makes, evaluated per pixel because the
   * shapes here are few and the arithmetic is cheaper than a polygon pipeline.
   * Only the segment's bounding box is visited, which is what keeps a few
   * thousand of these under a second.
   */
  segment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    halfWidth: number,
    colour: Rgb,
    alpha: number,
  ): void {
    const pad = halfWidth + 1.5;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
    const maxX = Math.min(this.size - 1, Math.ceil(Math.max(x0, x1) + pad));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
    const maxY = Math.min(this.size - 1, Math.ceil(Math.max(y0, y1) + pad));

    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSquared = dx * dx + dy * dy;

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;

        let t = lengthSquared === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lengthSquared;
        t = t < 0 ? 0 : t > 1 ? 1 : t;

        const qx = px - (x0 + t * dx);
        const qy = py - (y0 + t * dy);
        const distance = Math.sqrt(qx * qx + qy * qy);

        const coverage = Math.max(0, Math.min(1, halfWidth + 0.5 - distance));
        if (coverage > 0) this.plot(x, y, colour, coverage * alpha);
      }
    }
  }

  /** A dashed segment, for something that is drawn and is not there. */
  dashed(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    halfWidth: number,
    colour: Rgb,
    alpha: number,
    dashes: number,
  ): void {
    for (let i = 0; i < dashes; i += 1) {
      const a = i / dashes;
      const b = (i + 0.55) / dashes;
      this.segment(
        x0 + (x1 - x0) * a,
        y0 + (y1 - y0) * a,
        x0 + (x1 - x0) * b,
        y0 + (y1 - y0) * b,
        halfWidth,
        colour,
        alpha,
      );
    }
  }

  disc(cx: number, cy: number, radius: number, colour: Rgb, alpha: number): void {
    const pad = radius + 1.5;
    const minX = Math.max(0, Math.floor(cx - pad));
    const maxX = Math.min(this.size - 1, Math.ceil(cx + pad));
    const minY = Math.max(0, Math.floor(cy - pad));
    const maxY = Math.min(this.size - 1, Math.ceil(cy + pad));

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const coverage = Math.max(0, Math.min(1, radius + 0.5 - Math.sqrt(dx * dx + dy * dy)));
        if (coverage > 0) this.plot(x, y, colour, coverage * alpha);
      }
    }
  }

  /**
   * A soft halo.
   *
   * Not a blur — a squared radial falloff, which is cheap and reads the same
   * at this size. Every node gets one, and they are most of the reason the
   * picture has any depth to it.
   */
  glow(cx: number, cy: number, radius: number, colour: Rgb, alpha: number): void {
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(this.size - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(this.size - 1, Math.ceil(cy + radius));

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy) / radius;
        if (d >= 1) continue;
        const falloff = (1 - d) * (1 - d);
        this.plot(x, y, colour, falloff * alpha);
      }
    }
  }

  /**
   * An annular arc, angles in radians, clockwise from `from` to `to`.
   *
   * Both edges are feathered: the radial ones over a pixel, the angular ones
   * over whatever a pixel subtends at that radius — a fixed angular feather
   * would be invisible at the rim and a smear near the centre.
   */
  arc(
    cx: number,
    cy: number,
    inner: number,
    outer: number,
    from: number,
    to: number,
    colour: Rgb,
    alpha: number,
  ): void {
    const pad = outer + 2;
    const minX = Math.max(0, Math.floor(cx - pad));
    const maxX = Math.min(this.size - 1, Math.ceil(cx + pad));
    const minY = Math.max(0, Math.floor(cy - pad));
    const maxY = Math.min(this.size - 1, Math.ceil(cy + pad));

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r < inner - 1 || r > outer + 1) continue;

        let theta = Math.atan2(dy, dx);
        while (theta < from) theta += Math.PI * 2;
        if (theta > to) continue;

        const radial = Math.min(smoothstep(inner - 0.7, inner + 0.7, r), 1 - smoothstep(outer - 0.7, outer + 0.7, r));
        const feather = Math.max(1e-6, 1 / Math.max(r, 1));
        const angular = Math.min(
          smoothstep(from, from + feather, theta),
          1 - smoothstep(to - feather, to, theta),
        );

        const coverage = radial * angular;
        if (coverage > 0) this.plot(x, y, colour, coverage * alpha);
      }
    }
  }

  circle(cx: number, cy: number, radius: number, width: number, colour: Rgb, alpha: number): void {
    this.arc(cx, cy, radius - width / 2, radius + width / 2, -Math.PI, Math.PI * 3, colour, alpha);
  }

  /**
   * PNG bytes, filtered with Up.
   *
   * The QR raster uses filter 0 and says why: flat colour gives a predictor
   * nothing to work with. This image is the opposite case — a smooth field
   * across every row — and Up turns each row into small differences from the
   * one above it, which is most of the difference between a file Telegram
   * accepts without complaint and one it does not.
   */
  png(): Uint8Array {
    const stride = 1 + this.size * 3;
    const raw = new Uint8Array(this.size * stride);
    const row = new Uint8Array(this.size * 3);
    const prior = new Uint8Array(this.size * 3);

    for (let y = 0; y < this.size; y += 1) {
      for (let i = 0; i < row.length; i += 1) {
        const value = this.data[y * this.size * 3 + i]!;
        row[i] = value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
      }

      const at = y * stride;
      raw[at] = 2; // Up
      for (let i = 0; i < row.length; i += 1) {
        raw[at + 1 + i] = (row[i]! - prior[i]!) & 0xff;
      }
      prior.set(row);
    }

    return encodePng(raw, this.size, this.size, 2);
  }
}

/**
 * A colour ramp through a palette's own four tones.
 *
 * Interpolating between two colours gives a wash; four stops give a ramp with
 * a shoulder in it, which is what makes an escape-time gradient read as depth
 * rather than as a fade. The stops are the palette's, so the field can never
 * introduce a colour the rest of the picture does not use.
 */
function ramp(stops: Rgb[], t: number): Rgb {
  const clamped = t <= 0 ? 0 : t >= 1 ? 0.999999 : t;
  const scaled = clamped * (stops.length - 1);
  const index = Math.floor(scaled);
  return mix(stops[index]!, stops[index + 1]!, scaled - index);
}

/**
 * The Julia field.
 *
 * Three techniques, each earning its place:
 *
 * **Smooth escape** rather than raw iteration counts. The integer version
 * produces hard concentric bands that read as contour lines on a map, and at
 * this size they are the first thing the eye finds. The fractional correction
 * is the standard one — subtracting the log of the log of the escape radius.
 *
 * **Log scaling** of that value onto the ramp. The first version divided by a
 * fixed fraction of the iteration cap and clamped, which spent the whole ramp
 * on the outer wash and crushed every point near the set's boundary to one
 * flat tone — the exact filigree that makes a Julia set worth drawing came out
 * as a grey blob.
 *
 * **An orbit trap** — the closest the orbit ever came to the origin — which is
 * the only thing here that gives the *interior* any structure at all. Points
 * that never escape have no escape time to colour by, so without a trap every
 * one of them is the same colour and the set is a silhouette. With one, the
 * interior carries the nested filaments that are the actual subject.
 */
function renderField(canvas: Canvas, style: MeshArtStyle, radius: number): void {
  const size = canvas.size;
  const centre = size / 2;
  const ground = rgb(style.palette.ground);
  const deep = rgb(style.palette.deep);
  const glow = rgb(style.palette.glow);
  const bright = rgb(style.palette.bright);
  const hot = rgb(style.palette.hot);

  // Two ramps, because the two regions are asking different questions. Outside
  // is "how long did it take to leave" and runs dark to luminous, so the
  // filaments crowding the boundary are the brightest thing in the field.
  // Inside is "how close did the orbit come", and runs through the companion
  // hue so the set reads as its own body rather than as more of the outside.
  const outside = [ground, mix(ground, deep, 0.7), deep, glow, mix(glow, bright, 0.55)];
  const inside = [mix(ground, deep, 0.5), deep, mix(deep, hot, 0.6), hot];

  const cos = Math.cos(style.rotation);
  const sin = Math.sin(style.rotation);
  const { re: cr, im: ci } = style.c;
  const logCap = Math.log(1 + style.iterations);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const ux = (x + 0.5 - centre) / radius;
      const uy = (y + 0.5 - centre) / radius;
      const rr = Math.sqrt(ux * ux + uy * uy);
      if (rr > 1.005) continue;

      let zx = (ux * cos - uy * sin) * PLANE_SPAN;
      let zy = (ux * sin + uy * cos) * PLANE_SPAN;

      let n = 0;
      let magnitude = zx * zx + zy * zy;
      let trap = magnitude;

      while (n < style.iterations && magnitude <= 64) {
        const next = zx * zx - zy * zy + cr;
        zy = 2 * zx * zy + ci;
        zx = next;
        magnitude = zx * zx + zy * zy;
        if (magnitude < trap) trap = magnitude;
        n += 1;
      }

      let colour: Rgb;
      if (n >= style.iterations) {
        // Inside. The trap is squared, so the square root brings it back to a
        // distance; the power curve pushes the interesting range — orbits that
        // came very close — into most of the ramp.
        const t = Math.min(1, Math.sqrt(trap) / 0.9) ** 0.55;
        colour = ramp(inside, 1 - t);
      } else {
        const smooth = n + 1 - Math.log2(Math.log(Math.sqrt(magnitude)) / Math.log(2));

        // Log against the cap, then a square root on top of that. The log
        // alone was correct and unusable: a shattered field — which is what a
        // low σ is *supposed* to render as — escapes in a handful of
        // iterations everywhere, so every pixel landed in the bottom fifth of
        // the ramp and a thrashing run came out as a flat disc with nothing on
        // it. The root lifts that range into the middle without flattening the
        // boundary filigree of a connected one, so both ends of the σ scale
        // have something to look at.
        const u = Math.min(1, Math.log(1 + Math.max(smooth, 0)) / logCap) ** 0.5;

        // A gentle contour on top of the gradient. Not banding — the amplitude
        // is small enough to read as grain in the surface, and it is what stops
        // the outer field looking airbrushed.
        const contour = 0.5 + 0.5 * Math.cos(smooth * 0.9);
        colour = ramp(outside, Math.min(1, u * 0.94 + contour * 0.06));
      }

      // Dimmed toward the ground at the rim, so the disc has depth and an
      // edge rather than a staircase. The centre keeps the field at full
      // strength; that is where the structure is densest and where a picture
      // wants its light.
      const depth = FIELD_WEIGHT * (1 - 0.45 * smoothstep(0.25, 1, rr));
      const edge = 1 - smoothstep(0.985, 1.005, rr);
      canvas.set(x, y, mix(ground, mix(ground, colour, depth), edge));
    }
  }
}

/** One drawing instruction in the canopy's own frame, origin at the centre. */
type Op =
  | { kind: 'seg'; x0: number; y0: number; x1: number; y1: number; w: number; tone: Tone; alpha: number }
  | { kind: 'dash'; x0: number; y0: number; x1: number; y1: number; w: number; tone: Tone; alpha: number }
  | { kind: 'node'; x: number; y: number; r: number; tone: Tone; hollow: boolean };

type Tone = 'ink' | 'muted' | 'accent' | 'deep' | 'ghost';

/**
 * Build the canopy for one spoke.
 *
 * The frame is the spoke's own: the origin is the centre of the picture and
 * the axis runs along +x, so the whole structure is built once and then drawn
 * rotated. Building it in polar coordinates directly would have been shorter
 * and would have made every branch angle relative to a radius, which is not
 * how a tree grows.
 */
function buildCanopy(facts: MeshArtFacts, style: MeshArtStyle, radius: number): Op[] {
  const ops: Op[] = [];

  const inner = radius * 0.11;
  const waves = Math.max(facts.waves, 1);
  const waveSpan = (radius * 0.66 - inner) / waves;

  // The stem: one segment per wave, tapering outward, so depth in the picture
  // is depth in the search.
  for (let w = 1; w <= facts.waves; w += 1) {
    ops.push({
      kind: 'seg',
      x0: inner + (w - 1) * waveSpan,
      y0: 0,
      x1: inner + w * waveSpan,
      y1: 0,
      w: Math.max(1.1, 3.4 - w * 0.35),
      tone: 'ink',
      alpha: 0.92,
    });
  }

  const spread = 0.62;

  for (let w = 1; w <= facts.waves; w += 1) {
    const steps = facts.steps.filter((step) => step.wave === w);
    if (steps.length === 0) continue;

    const baseX = inner + (w - 1) * waveSpan;

    steps.forEach((step, index) => {
      const angle = ((index + 0.5) / steps.length - 0.5) * 2 * spread;
      const length = waveSpan * Math.max(0.35, Math.min(1.45, 0.45 + 0.1 * (step.reward + 2)));
      const width = 0.9 + step.cost * 0.8;

      if (step.errored) {
        // A call that failed stops where it failed. The branch is drawn to the
        // break and no further, with a cross-tick at the end — visibly severed
        // rather than merely short, which is what a low reward looks like.
        const cut = length * 0.6;
        const tipX = baseX + Math.cos(angle) * cut;
        const tipY = Math.sin(angle) * cut;
        ops.push({ kind: 'seg', x0: baseX, y0: 0, x1: tipX, y1: tipY, w: width, tone: 'muted', alpha: 0.9 });
        ops.push({
          kind: 'seg',
          x0: tipX + Math.cos(angle + Math.PI / 2) * 4,
          y0: tipY + Math.sin(angle + Math.PI / 2) * 4,
          x1: tipX + Math.cos(angle - Math.PI / 2) * 4,
          y1: tipY + Math.sin(angle - Math.PI / 2) * 4,
          w: 1.2,
          tone: 'accent',
          alpha: 0.9,
        });
        return;
      }

      const tipX = baseX + Math.cos(angle) * length;
      const tipY = Math.sin(angle) * length;

      ops.push({
        kind: 'seg',
        x0: baseX,
        y0: 0,
        x1: tipX,
        y1: tipY,
        w: width,
        tone: step.kept ? 'ink' : 'muted',
        alpha: step.kept ? 0.95 : 0.75,
      });

      if (!step.kept) {
        // Answered, and proved nothing. An open ring, not a filled node: the
        // call happened and left nothing behind.
        ops.push({ kind: 'node', x: tipX, y: tipY, r: 5.5, tone: 'muted', hollow: true });
        return;
      }

      // The fractal proper. Depth is what the call proved, so a branch that
      // established three facts is visibly a richer thing than one that
      // established one, without any of it being decided by a seed.
      const depth = 1 + Math.min(step.goalProved + (step.proved > step.goalProved ? 1 : 0), 4);
      bifurcate(ops, tipX, tipY, angle, length * 0.55, width * 0.7, depth, style.bifurcation);
    });
  }

  // What the objective wanted and the run never got. Drawn from the outermost
  // wave node, dashed, ending in nothing. A picture that simply omitted them
  // would be the picture of a different, better run.
  if (facts.voids.length > 0) {
    const baseX = inner + facts.waves * waveSpan;
    facts.voids.forEach((_fact, index) => {
      const angle = ((index + 0.5) / facts.voids.length - 0.5) * 2 * 0.85;
      const length = waveSpan * 1.15;
      const tipX = baseX + Math.cos(angle) * length;
      const tipY = Math.sin(angle) * length;

      ops.push({ kind: 'dash', x0: baseX, y0: 0, x1: tipX, y1: tipY, w: 1.3, tone: 'ghost', alpha: 0.85 });
      ops.push({ kind: 'node', x: tipX, y: tipY, r: 7, tone: 'ghost', hollow: true });
    });
  }

  return ops;
}

function bifurcate(
  ops: Op[],
  x: number,
  y: number,
  angle: number,
  length: number,
  width: number,
  depth: number,
  spread: number,
): void {
  if (depth <= 0) {
    ops.push({ kind: 'node', x, y, r: 3.6, tone: 'deep', hollow: false });
    return;
  }

  for (const turn of [-spread, spread]) {
    const next = angle + turn;
    const x2 = x + Math.cos(next) * length;
    const y2 = y + Math.sin(next) * length;

    ops.push({
      kind: 'seg',
      x0: x,
      y0: y,
      x1: x2,
      y1: y2,
      w: Math.max(0.6, width),
      tone: depth === 1 ? 'accent' : 'ink',
      alpha: 0.9,
    });
    bifurcate(ops, x2, y2, next, length * 0.66, width * 0.72, depth - 1, spread);
  }
}

function drawNode(canvas: Canvas, x: number, y: number, r: number, shape: NodeShape, colour: Rgb, hollow: boolean): void {
  if (hollow) {
    canvas.circle(x, y, r, 1.4, colour, 0.85);
    return;
  }

  switch (shape) {
    case 'ring':
      canvas.circle(x, y, r, 1.8, colour, 0.95);
      canvas.disc(x, y, r * 0.35, colour, 0.9);
      break;
    case 'star':
      for (let i = 0; i < 4; i += 1) {
        const a = (i * Math.PI) / 4;
        canvas.segment(x - Math.cos(a) * r * 1.5, y - Math.sin(a) * r * 1.5, x + Math.cos(a) * r * 1.5, y + Math.sin(a) * r * 1.5, 0.7, colour, 0.9);
      }
      canvas.disc(x, y, r * 0.5, colour, 0.95);
      break;
    case 'diamond':
      for (let i = 0; i < 4; i += 1) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const b = a + Math.PI / 2;
        canvas.segment(x + Math.cos(a) * r, y + Math.sin(a) * r, x + Math.cos(b) * r, y + Math.sin(b) * r, 0.9, colour, 0.92);
      }
      break;
    default:
      canvas.disc(x, y, r, colour, 0.95);
  }
}

/**
 * The outer ring: the run as something you can count.
 *
 * Not repeated per spoke. The interior is a mandala and the ring is a dial,
 * and giving the dial the mandala's symmetry would have made the same call
 * appear five times — which is exactly the misreading the shared blackboard
 * exists to prevent.
 */
function drawLedger(canvas: Canvas, facts: MeshArtFacts, style: MeshArtStyle, radius: number): void {
  const centre = canvas.size / 2;
  const bright = rgb(style.palette.bright);
  const glow = rgb(style.palette.glow);
  const hot = rgb(style.palette.hot);
  const ground = rgb(style.palette.ground);
  const muted = mix(bright, ground, 0.6);

  const inner = radius * 0.9;
  const outer = radius * 0.945;

  const total = facts.steps.reduce((sum, step) => sum + step.cost, 0) || 1;
  // Wide enough that four arcs read as four. A hairline gap made a run's whole
  // ledger look like one unbroken ring.
  const gap = 0.055;
  const budget = Math.PI * 2 - facts.steps.length * gap;

  let theta = style.rotation - Math.PI / 2;
  for (const step of facts.steps) {
    const width = (step.cost / total) * budget;

    if (step.errored) {
      canvas.arc(centre, centre, inner, outer, theta, theta + width, hot, 0.9);
    } else if (step.kept) {
      canvas.arc(centre, centre, inner, outer, theta, theta + width, bright, 0.92);
    } else {
      // Hollow: two thin rails and no fill. The call was made and paid for.
      canvas.arc(centre, centre, inner, inner + 1.3, theta, theta + width, muted, 0.9);
      canvas.arc(centre, centre, outer - 1.3, outer, theta, theta + width, muted, 0.9);
    }

    theta += width + gap;
  }

  // One notch per fact the objective asked for; the proved ones filled. This
  // is `unproven` drawn as a fraction rather than as prose.
  const notchRadius = radius * 0.884;
  for (let i = 0; i < facts.sigma.sought; i += 1) {
    const angle = style.rotation - Math.PI / 2 + (i / facts.sigma.sought) * Math.PI * 2;
    const x0 = centre + Math.cos(angle) * (notchRadius - radius * 0.016);
    const y0 = centre + Math.sin(angle) * (notchRadius - radius * 0.016);
    const x1 = centre + Math.cos(angle) * (notchRadius + radius * 0.016);
    const y1 = centre + Math.sin(angle) * (notchRadius + radius * 0.016);

    const proved = i < facts.sigma.proved;
    if (proved) canvas.glow(centre + Math.cos(angle) * notchRadius, centre + Math.sin(angle) * notchRadius, 9, hot, 0.35);
    canvas.segment(x0, y0, x1, y1, proved ? 2.4 : 1.1, proved ? hot : muted, proved ? 0.95 : 0.55);
  }

  canvas.circle(centre, centre, radius * 0.962, 1.6, glow, 0.8);
}

/**
 * Render one mesh run.
 *
 * Deterministic from `facts` alone: the same run, series and edition produce
 * byte-identical output, which is what makes {@link verifyMeshArt} a check
 * rather than an approximation.
 */
export function meshArtPng(facts: MeshArtFacts, options: MeshRenderOptions = {}): Uint8Array {
  const size = options.size ?? DEFAULT_SIZE;
  const style = options.style ?? meshArtStyle(facts);

  const ground = rgb(style.palette.ground);
  const ink = rgb(style.palette.bright);
  const accent = rgb(style.palette.glow);
  const deep = rgb(style.palette.hot);
  // Both of these are things the picture has to show without letting them
  // compete: a call that was discarded, and a fact that was never proved.
  // Muted at 0.62 and ghosted at 0.74 made them smudges nobody could find,
  // which is the same failure as leaving them out.
  const muted = mix(ink, ground, 0.45);
  const ghost = mix(ink, ground, 0.55);

  const canvas = new Canvas(size, ground);
  const centre = size / 2;
  const radius = size * 0.46;

  const fieldRadius = radius * FIELD_EXTENT;
  renderField(canvas, style, fieldRadius);
  // A rim on the field itself, so it ends at something rather than fading out.
  canvas.circle(centre, centre, fieldRadius, 1.1, accent, 0.45);

  const tones: Record<Tone, Rgb> = { ink, muted, accent, deep, ghost };
  const ops = buildCanopy(facts, style, radius);

  for (let spoke = 0; spoke < style.spokes; spoke += 1) {
    const angle = style.rotation + (spoke / style.spokes) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const at = (x: number, y: number): [number, number] => [
      centre + x * cos - y * sin,
      centre + x * sin + y * cos,
    ];

    for (const op of ops) {
      if (op.kind === 'node') {
        const [x, y] = at(op.x, op.y);
        if (!op.hollow) canvas.glow(x, y, op.r * 3.2, tones[op.tone], 0.4);
        drawNode(canvas, x, y, op.r, style.nodeShape, tones[op.tone], op.hollow);
        continue;
      }

      const [x0, y0] = at(op.x0, op.y0);
      const [x1, y1] = at(op.x1, op.y1);

      if (op.kind === 'dash') canvas.dashed(x0, y0, x1, y1, op.w, tones[op.tone], op.alpha, 7);
      else canvas.segment(x0, y0, x1, y1, op.w, tones[op.tone], op.alpha);
    }
  }

  // The core: the subject the run was about, with one scar per backtrack.
  canvas.glow(centre, centre, radius * 0.16, accent, 0.45);
  canvas.disc(centre, centre, radius * 0.042, deep, 0.95);
  canvas.circle(centre, centre, radius * 0.062, 1.4, accent, 0.8);

  for (let i = 0; i < facts.backtracks; i += 1) {
    const angle = style.rotation + (i / Math.max(facts.backtracks, 1)) * Math.PI * 2;
    canvas.disc(
      centre + Math.cos(angle) * radius * 0.085,
      centre + Math.sin(angle) * radius * 0.085,
      2.4,
      muted,
      0.9,
    );
  }

  drawLedger(canvas, facts, style, radius);

  return canvas.png();
}

/**
 * Is this image the one this run generates?
 *
 * The question `receipt_art` asks about a receipt, asked about a mesh state,
 * and for the same reason: an NFT's image is served by a host, and a host can
 * change what it serves. A false answer is not proof of fraud — it means the
 * picture is not evidence of the run the metadata names, which is a different
 * and more useful thing to say.
 */
export function verifyMeshArt(
  facts: MeshArtFacts,
  served: Uint8Array,
  options: MeshRenderOptions = {},
): boolean {
  const ours = meshArtPng(facts, options);
  if (ours.length !== served.length) return false;
  for (let i = 0; i < ours.length; i += 1) if (ours[i] !== served[i]) return false;
  return true;
}
