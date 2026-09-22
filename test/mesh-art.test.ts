import { describe, it, expect } from 'vitest';
import { runMesh } from '../src/mesh/search.js';
import { OBJECTIVES } from '../src/mesh/moves.js';
import {
  NAME_LIMIT,
  SYMBOL_LIMIT,
  editionSeed,
  meshArtFacts,
  meshArtMetadata,
  meshArtName,
  meshArtStyle,
  meshPalette,
} from '../src/art/mesh-art.js';
import { meshArtPng, verifyMeshArt } from '../src/art/mesh-raster.js';
import { SeedStream } from '../src/art/seed.js';
import { contrastRatio } from '../src/art/palette.js';
import { SingularityError } from '../src/core/errors.js';
import type { MeshResult } from '../src/mesh/search.js';

/**
 * The art's whole claim is that it is a function of the run.
 *
 * That is a testable claim and almost none of it is about how the picture
 * looks. Same run, same bytes. Different run, different bytes. Rename the
 * series and the structure must not move, because the structure is the state.
 * Draw a plan and get a refusal, because a plan called nothing. Those are the
 * properties that make the traits worth anything, and they are what is pinned
 * here.
 *
 * Rendering is kept small — 128 pixels rather than 1024 — because none of
 * these assertions are about resolution and the field is evaluated per pixel.
 */

const SOL = 'So11111111111111111111111111111111111111112';
const SMALL = { size: 128 };

function resolved(overrides: Record<string, unknown> = {}): unknown {
  return {
    input: SOL,
    kind: 'address',
    address: SOL,
    chains: ['solana'],
    family: 'svm',
    note: 'Base58, 32 bytes.',
    ...overrides,
  };
}

const CLEAN: Record<string, unknown> = {
  resolve: resolved(),
  mint_audit: { chain: 'solana', mint: SOL, program: 'spl-token', decimals: 9, extensions: [] },
  token_identity: {
    chain: 'solana',
    mint: SOL,
    symbol: 'SOL',
    immutable: { metadata: 'mutable', document: false, note: '' },
  },
  inspect_exit: {
    mint: SOL,
    chain: 'solana',
    canExit: true,
    underThirdPartyControl: false,
    risks: [],
    completeness: { kind: 'curated', note: 'the on-chain half only' },
  },
};

const BROKEN: Record<string, unknown> = {
  ...CLEAN,
  mint_audit: new SingularityError('RPC_FAILED', 'Every Solana endpoint refused.'),
  token_identity: {},
};

function runner(table: Record<string, unknown>) {
  return async (tool: string) => {
    const value = table[tool];
    if (value === undefined) throw new SingularityError('NO_FIXTURE', `no fixture for ${tool}`);
    if (value instanceof Error) throw value;
    return value;
  };
}

function safety(table: Record<string, unknown>): Promise<MeshResult> {
  return runMesh({ subject: SOL, objective: 'safety', chain: 'solana' }, runner(table));
}

describe('mesh art, as a function of the run', () => {
  it('draws the same bytes for the same run, series and edition', async () => {
    const result = await safety(CLEAN);
    const a = meshArtPng(meshArtFacts(result, { series: 'Genesis', edition: 1 }), SMALL);
    const b = meshArtPng(meshArtFacts(result, { series: 'Genesis', edition: 1 }), SMALL);

    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('gives two runs that went differently two different digests', async () => {
    const clean = meshArtFacts(await safety(CLEAN), { series: 'Genesis', edition: 1 });
    const broken = meshArtFacts(await safety(BROKEN), { series: 'Genesis', edition: 1 });

    expect(clean.digest).not.toBe(broken.digest);
  });

  it('does not move the structure when the series is renamed', async () => {
    const result = await safety(CLEAN);
    const first = meshArtFacts(result, { series: 'Genesis', edition: 1 });
    const second = meshArtFacts(result, { series: 'Something Else Entirely', edition: 9 });

    // The digest is the state. Everything geometric comes off it.
    expect(second.digest).toBe(first.digest);
    expect(meshArtStyle(second).spokes).toBe(meshArtStyle(first).spokes);
    expect(meshArtStyle(second).c).toEqual(meshArtStyle(first).c);

    // The colourway is the edition, and must not be shared.
    expect(editionSeed(second)).not.toBe(editionSeed(first));
    expect(meshArtStyle(second).palette.ground).not.toBe(meshArtStyle(first).palette.ground);
  });

  it('draws two editions of one run as different images', async () => {
    const result = await safety(CLEAN);
    const one = meshArtPng(meshArtFacts(result, { series: 'Genesis', edition: 1 }), SMALL);
    const two = meshArtPng(meshArtFacts(result, { series: 'Genesis', edition: 2 }), SMALL);

    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false);
  });

  it('takes its symmetry from how many facts the objective asked for', async () => {
    const result = await safety(CLEAN);
    const style = meshArtStyle(meshArtFacts(result, { series: 'Genesis', edition: 1 }));

    expect(style.spokes).toBe(OBJECTIVES.safety.length);
    expect(style.spokes).toBe(result.sigma.sought);
  });

  it('shatters the field as sigma falls, and connects it as sigma rises', async () => {
    // Not a taste call. |c| crossing roughly 0.75 is where a Julia set stops
    // having an interior, so this asserts the mapping actually straddles that
    // boundary rather than sitting on one side of it with a nice name.
    const poor = meshArtStyle(meshArtFacts(await safety(BROKEN), { series: 'G', edition: 1 }));
    const good = meshArtStyle(meshArtFacts(await safety(CLEAN), { series: 'G', edition: 1 }));

    const modulus = (style: typeof poor): number => Math.hypot(style.c.re, style.c.im);
    expect(modulus(poor)).toBeGreaterThan(modulus(good));
    expect(modulus(good)).toBeGreaterThan(0.69);
    expect(modulus(poor)).toBeLessThan(0.8);
  });

  it('counts only the objective’s own facts as goal facts on a branch', async () => {
    const facts = meshArtFacts(await safety(CLEAN), { series: 'Genesis', edition: 1 });
    const resolveStep = facts.steps.find((step) => step.tool === 'resolve');

    // `resolve` proves subjectKind, address and mint here; only subjectKind is
    // in the safety objective's goal.
    expect(resolveStep?.proved).toBeGreaterThan(resolveStep!.goalProved);
    for (const step of facts.steps) expect(step.goalProved).toBeLessThanOrEqual(step.proved);
  });

  it('carries the facts the run never proved rather than omitting them', async () => {
    const facts = meshArtFacts(await safety(BROKEN), { series: 'Genesis', edition: 1 });

    expect(facts.voids.length).toBeGreaterThan(0);
    expect(facts.voids).toContain('authorities');
  });

  it('refuses to draw a plan, which called nothing', async () => {
    const plan = await runMesh(
      { subject: SOL, objective: 'safety', chain: 'solana', plan: true },
      async () => ({}),
    );

    expect(() => meshArtFacts(plan, { series: 'Genesis', edition: 1 })).toThrow(/plan/i);
  });

  it('refuses an edition that is not a whole number from one up', async () => {
    const result = await safety(CLEAN);
    for (const edition of [0, -1, 1.5]) {
      expect(() => meshArtFacts(result, { series: 'Genesis', edition })).toThrow(/edition/i);
    }
  });

  it('refuses a series with no name in it', async () => {
    const result = await safety(CLEAN);
    expect(() => meshArtFacts(result, { series: '   ', edition: 1 })).toThrow(/name/i);
  });
});

describe('mesh art, as an image', () => {
  it('is a PNG of the size asked for', async () => {
    const facts = meshArtFacts(await safety(CLEAN), { series: 'Genesis', edition: 1 });
    const png = meshArtPng(facts, { size: 96 });

    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // IHDR: length, type, then width and height as big-endian 32-bit.
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(96);
    expect(view.getUint32(20)).toBe(96);
  });

  it('says whether an image is the one this run generates', async () => {
    const facts = meshArtFacts(await safety(CLEAN), { series: 'Genesis', edition: 1 });
    const png = meshArtPng(facts, SMALL);

    expect(verifyMeshArt(facts, png, SMALL)).toBe(true);

    // One byte changed, deep in the image data rather than in the header.
    const tampered = Uint8Array.from(png);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    expect(verifyMeshArt(facts, tampered, SMALL)).toBe(false);

    // And the image of a different edition is not evidence of this one.
    const other = meshArtPng({ ...facts, edition: 2 }, SMALL);
    expect(verifyMeshArt(facts, other, SMALL)).toBe(false);
  });
});

describe('the mesh palette', () => {
  /**
   * The QR palette sweeps the hue wheel to prove every receipt scans. This
   * sweeps it to prove every colourway has a figure you can see against its
   * own ground — the same argument, on a dark background instead of a light
   * one, and for the same reason: a lightness band cannot promise a ratio.
   */
  it('keeps the figure readable against the ground at every hue', () => {
    for (let seed = 0; seed < 240; seed += 1) {
      const palette = meshPalette(new SeedStream(`hue-sweep-${seed}`));

      expect(
        contrastRatio(palette.bright, palette.ground),
        `${palette.name}: bright on ground`,
      ).toBeGreaterThanOrEqual(7);
      expect(
        contrastRatio(palette.glow, palette.ground),
        `${palette.name}: glow on ground`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(palette.hot, palette.ground),
        `${palette.name}: hot on ground`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('names both of its hues', () => {
    const palette = meshPalette(new SeedStream('named'));
    expect(palette.name).toMatch(/^[a-z]+\/[a-z]+$/);
  });
});

describe('mesh art metadata', () => {
  it('states the run in its traits, and stays inside the on-chain limits', async () => {
    const facts = meshArtFacts(await safety(BROKEN), { series: 'Genesis Mesh', edition: 7 });
    const metadata = meshArtMetadata(facts, { image: 'https://example.invalid/1.png' }) as {
      name: string;
      symbol: string;
      attributes: Array<{ trait_type: string; value: string | number }>;
    };

    expect(Buffer.byteLength(metadata.name)).toBeLessThanOrEqual(NAME_LIMIT);
    expect(metadata.symbol.length).toBeLessThanOrEqual(SYMBOL_LIMIT);

    const traits = new Map(metadata.attributes.map((a) => [a.trait_type, a.value]));
    expect(traits.get('Digest')).toBe(facts.digest);
    expect(traits.get('Edition')).toBe(7);
    expect(traits.get('Voids')).toBe(facts.voids.length);
    expect(traits.get('Proved')).toBe(`${facts.sigma.proved} of ${facts.sigma.sought}`);
  });

  it('truncates a long series name in the on-chain name only', async () => {
    const long = 'A Series Name Far Longer Than Metaplex Will Ever Hold';
    const facts = meshArtFacts(await safety(CLEAN), { series: long, edition: 1 });

    expect(meshArtName(facts).length).toBeLessThanOrEqual(NAME_LIMIT);
    // The full name is still on the token, in a field that has room for it.
    const metadata = meshArtMetadata(facts, { image: 'x' }) as {
      attributes: Array<{ trait_type: string; value: string | number }>;
    };
    expect(metadata.attributes.find((a) => a.trait_type === 'Series')?.value).toBe(long);
  });
});
