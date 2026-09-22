/**
 * A mesh run, as a picture that is a function of the run.
 *
 * The receipt art established the rule this follows: a picture derived from a
 * value already on record is a *fingerprint*, and one drawn from a random seed
 * is decoration. A receipt seeds from the payment reference, so two payments
 * can never render alike and anybody holding the reference can re-derive the
 * image and check it. The same argument applies here with more to say, because
 * a mesh run has structure and a reference is thirty-two flat bytes.
 *
 * So nothing about this image is chosen for looks alone. The rotational
 * symmetry is how many facts the objective asked for. The number of rings out
 * from the centre is how many waves the search took. Each branch is one tool
 * call, its length is what that call earned, and a call that was discarded is
 * drawn severed. The facts that were never proved are drawn — as hollow ghost
 * branches going nowhere, which is the one thing a picture can say better than
 * a field can. And the fractal field behind it all is a Julia set whose
 * parameter comes from σ: a run that earned its calls renders as a connected
 * body, and a run that thrashed renders as dust.
 *
 * That last mapping is the one worth defending. It is not a metaphor bolted
 * on: |c| crossing 0.75 or so is genuinely where a Julia set stops being one
 * connected thing and starts being Cantor dust, and low σ genuinely means the
 * search never cohered. The picture is doing arithmetic, not mood.
 *
 * ## The structure is the state; the colourway is the edition
 *
 * Two seeds, deliberately. `digest` is the canonical hash of the run and
 * drives every piece of geometry, so the same run always draws the same shape.
 * The edition seed — digest, series name and edition number — drives the
 * palette, the rotation and the node ornament. So `#1` and `#2` of one run are
 * recognisably the same structure in different colours, which is what a
 * generative series is, and neither one can be mistaken for a picture of a
 * different run.
 *
 * Nothing here mints anything. It produces the image, the traits and the
 * metadata a marketplace reads; `art/mint.ts` is what builds an unsigned mint
 * transaction, and it needs the metadata hosted somewhere first — which is the
 * application's decision, the same way it is for receipts.
 */

import { createHash } from 'node:crypto';
import { SeedStream } from './seed.js';
import { contrastRatio, hsl, nameForHue } from './palette.js';
import { MOVES_BY_TOOL, OBJECTIVES } from '../mesh/moves.js';
import type { MeshResult } from '../mesh/search.js';

/** Metaplex caps the on-chain name at 32 bytes and the symbol at 10. */
export const NAME_LIMIT = 32;
export const SYMBOL_LIMIT = 10;

/**
 * One tool call, reduced to what the picture draws from it.
 *
 * Deliberately not the step itself. A `MeshStep` carries the arguments it was
 * called with, and putting those in the digest would make the image depend on
 * an address string rather than on the shape of the search — two runs over
 * different wallets that took the same path would then draw differently for a
 * reason nothing in the picture expresses.
 */
export interface ArtStep {
  wave: number;
  tool: string;
  /** The process reward. Negative for a call that failed. */
  reward: number;
  kept: boolean;
  errored: boolean;
  /** Facts this call was first to prove. */
  proved: number;
  /** How many of those the objective had asked for. */
  goalProved: number;
  /** Round trips the move implies — the branch's thickness. */
  cost: number;
}

/**
 * What the art is allowed to assert.
 *
 * Every field here came out of a completed run. There is no field for anything
 * a caller could assert on its own, which is the same fail-closed shape
 * `receiptFacts` has: a picture of a mesh state that was never searched would
 * be a forgery with good intentions.
 */
export interface MeshArtFacts {
  /** sha256 of the canonical run. Every piece of geometry derives from this. */
  digest: string;
  series: string;
  edition: number;
  objective: string;
  subject: string;
  chain?: string;
  verdict: string;
  waves: number;
  calls: number;
  backtracks: number;
  sigma: { earned: number; ceiling: number; ratio: number; proved: number; sought: number };
  steps: ArtStep[];
  /** Goal facts the run never proved. Drawn, not omitted. */
  voids: string[];
}

function canonical(facts: Omit<MeshArtFacts, 'digest' | 'series' | 'edition'>): string {
  // One line per component, in a fixed order, with no JSON — a serialization
  // whose key order could change is a digest that could change with it.
  const lines = [
    `objective:${facts.objective}`,
    `subject:${facts.subject}`,
    `chain:${facts.chain ?? ''}`,
    `verdict:${facts.verdict}`,
    `waves:${facts.waves}`,
    `calls:${facts.calls}`,
    `backtracks:${facts.backtracks}`,
    `sigma:${facts.sigma.earned}/${facts.sigma.ceiling}:${facts.sigma.proved}/${facts.sigma.sought}`,
  ];

  for (const step of facts.steps) {
    lines.push(
      `step:${step.wave}:${step.tool}:${step.reward}:${step.kept ? 1 : 0}:${step.errored ? 1 : 0}:${step.proved}:${step.goalProved}:${step.cost}`,
    );
  }
  for (const fact of facts.voids) lines.push(`void:${fact}`);

  return lines.join('\n');
}

export interface MeshArtRequest {
  series: string;
  edition: number;
}

/**
 * Turn a finished run into the facts the art may draw.
 *
 * Refuses a plan, and the refusal is the point: `plan: true` calls nothing, so
 * there is no state to be a picture *of*. An image of a plan would show waves
 * that never ran and rewards nobody earned, and it would look exactly like an
 * image of a real run.
 */
export function meshArtFacts(result: MeshResult, request: MeshArtRequest): MeshArtFacts {
  if (result.verdict === 'planned') {
    throw new Error(
      'Refusing to draw a plan. A plan calls nothing, so there is no state to picture — ' +
        'run the mesh without `plan` first.',
    );
  }

  const series = request.series.trim();
  if (!series) throw new Error('A series needs a name; the edition number alone does not identify it.');

  if (!Number.isInteger(request.edition) || request.edition < 1) {
    throw new Error(`Edition must be a whole number from 1 upward, not "${request.edition}".`);
  }

  // `path` and `discarded` are two stable slices of one list, so concatenating
  // and sorting by wave restores the order the run actually made them in —
  // JavaScript's sort is stable, which is the property being relied on here.
  const goal = new Set<string>(OBJECTIVES[result.objective] ?? []);

  const steps: ArtStep[] = [...result.path, ...result.discarded]
    .map((step) => ({
      wave: step.wave,
      tool: step.tool,
      reward: step.reward.value,
      kept: step.kept,
      errored: Boolean(step.error),
      proved: step.proved.length,
      goalProved: step.proved.filter((fact) => goal.has(fact)).length,
      cost: MOVES_BY_TOOL.get(step.tool)?.cost ?? 1,
    }))
    .sort((a, b) => a.wave - b.wave);

  const base = {
    objective: result.objective,
    subject: result.subject,
    ...(result.chain ? { chain: result.chain } : {}),
    verdict: result.verdict,
    waves: result.waves,
    calls: result.calls,
    backtracks: result.backtracks,
    sigma: {
      earned: result.sigma.earned,
      ceiling: result.sigma.ceiling,
      ratio: result.sigma.ratio,
      proved: result.sigma.proved,
      sought: result.sigma.sought,
    },
    steps,
    voids: result.unproven.map((entry) => entry.fact),
  };

  return {
    digest: createHash('sha256').update(canonical(base)).digest('hex'),
    series,
    edition: request.edition,
    ...base,
  };
}

/** The seed the edition's colourway and ornament come from. */
export function editionSeed(facts: MeshArtFacts): string {
  return createHash('sha256')
    .update(`${facts.digest}|${facts.series}|#${facts.edition}`)
    .digest('hex');
}

export type NodeShape = 'disc' | 'ring' | 'star' | 'diamond';

/**
 * Five tones on a dark ground.
 *
 * Not `paletteFor`. That palette exists to keep a QR code scannable, so its
 * paper is near-white by construction and everything else is darkened until it
 * measurably clears a contrast target against it. Those are exactly the right
 * rules for a thing a phone camera has to read, and exactly the wrong ones
 * here: mixing a saturated field fifty percent toward near-white produces
 * pastel, and the first version of this renderer was a pink wash for precisely
 * that reason.
 *
 * Nothing scans this image, so the ground goes dark and the structure becomes
 * the luminous thing on it. What carries over is the method rather than the
 * numbers — `bright` is lifted until it *measurably* clears its target against
 * the ground rather than being placed in a lightness band and hoped for, for
 * the reason `palette.ts` gives at length: lightness is not brightness, and a
 * band wide enough to be interesting at one hue is too dim at another.
 */
export interface MeshPalette {
  /** The canvas, and what the field fades to at the rim. */
  ground: string;
  /** The field's low tones. */
  deep: string;
  /** The field's mid tones, and the secondary structure. */
  glow: string;
  /** Branches and stems — the figure. */
  bright: string;
  /** Fact nodes, on the companion hue, so the tips read as a different thing. */
  hot: string;
  /** Human name, for the trait list. */
  name: string;
}

/** Walk a colour's lightness up until it measurably clears the ground. */
function lightenUntilReadable(
  hue: number,
  saturation: number,
  lightness: number,
  ground: string,
  target: number,
): string {
  for (let l = lightness; l < 97; l += 1) {
    const candidate = hsl(hue, saturation, l);
    if (contrastRatio(candidate, ground) >= target) return candidate;
  }
  return hsl(hue, saturation, 97);
}

export function meshPalette(stream: SeedStream): MeshPalette {
  const hue = stream.below(360);
  const saturation = stream.between(50, 88);

  // The same three relationships `paletteFor` uses, for the same reason: a
  // freely chosen companion hue mostly looks like a mistake.
  const companion = (hue + stream.pick([30, 150, 180, 210] as const)) % 360;

  const ground = hsl(hue, stream.between(28, 46), stream.between(6, 11));

  return {
    ground,
    deep: hsl(hue, Math.min(saturation, 70), stream.between(18, 26)),
    glow: lightenUntilReadable(hue, saturation, stream.between(44, 56), ground, 3),
    // The figure. Seven to one is where a thin line stays a line rather than
    // becoming a suggestion of one.
    bright: lightenUntilReadable(hue, Math.min(saturation, 40), stream.between(74, 86), ground, 7),
    hot: lightenUntilReadable(companion, saturation, stream.between(58, 70), ground, 4.5),
    name: `${nameForHue(hue)}/${nameForHue(companion)}`,
  };
}

/**
 * Where a Julia set stops being one thing.
 *
 * |c| near 0.7 gives a fat connected basin; past about 0.78 on most arguments
 * the set has shattered into dust with no interior at all. Mapping σ across
 * that boundary is why the field is doing arithmetic rather than decoration:
 * the picture of a run that earned nothing genuinely has nothing holding it
 * together.
 */
const C_MODULUS = { connected: 0.7, shattered: 0.792 } as const;

export interface MeshArtStyle {
  palette: MeshPalette;
  /** Rotational symmetry — how many facts the objective asked for. */
  spokes: number;
  /** The Julia parameter, from σ and the run's own digest. */
  c: { re: number; im: number };
  /** Escape-iteration cap. Deeper searches get a more detailed field. */
  iterations: number;
  /** What the field looks like at this |c|, for the trait list. */
  field: 'basin' | 'dendrite' | 'spiral' | 'dust';
  nodeShape: NodeShape;
  /** Base rotation of the whole mandala, in radians. Edition-specific. */
  rotation: number;
  /** How far a branch bifurcates, in radians. */
  bifurcation: number;
}

function fieldName(modulus: number): MeshArtStyle['field'] {
  if (modulus < 0.735) return 'basin';
  if (modulus < 0.762) return 'dendrite';
  if (modulus < 0.782) return 'spiral';
  return 'dust';
}

/**
 * Everything the renderer needs, derived and nothing chosen.
 *
 * The split between the two streams is the contract: `structure` is seeded
 * from the digest alone, so the geometry cannot move when the series is
 * renamed, and `edition` is seeded from the digest with the series and number
 * folded in, so no two editions share a colourway.
 */
export function meshArtStyle(facts: MeshArtFacts): MeshArtStyle {
  const structure = new SeedStream(facts.digest);
  const edition = new SeedStream(editionSeed(facts));

  // Symmetry order is the objective's own ambition. Two-fold would read as a
  // mirror rather than a mandala, so the floor is three; the ceiling is where
  // the spokes start overlapping at this radius.
  const spokes = Math.max(3, Math.min(facts.sigma.sought, 8));

  // The argument of c is the run's fingerprint; its modulus is σ. Same yield,
  // different run: same degree of connectedness, different form entirely.
  const argument = structure.fraction() * Math.PI * 2;
  const ratio = Math.max(0, Math.min(1, facts.sigma.ratio));
  const modulus = C_MODULUS.shattered - (C_MODULUS.shattered - C_MODULUS.connected) * ratio;

  return {
    palette: meshPalette(edition),
    spokes,
    c: { re: modulus * Math.cos(argument), im: modulus * Math.sin(argument) },
    // A cap rather than a formula alone: the field is per-pixel, and an
    // unbounded iteration count is how a picture becomes a timeout.
    iterations: Math.min(96 + facts.waves * 48, 288),
    field: fieldName(modulus),
    nodeShape: edition.pick(['disc', 'ring', 'star', 'diamond'] as const),
    rotation: edition.fraction() * Math.PI * 2,
    bifurcation: 0.3 + structure.fraction() * 0.24,
  };
}

/** The on-chain name, inside the Metaplex limit. */
export function meshArtName(facts: MeshArtFacts): string {
  return `${facts.series} #${facts.edition}`.slice(0, NAME_LIMIT);
}

interface Attribute {
  trait_type: string;
  value: string | number;
}

export interface MeshArtMetadataOptions {
  /**
   * Where the image will be served from.
   *
   * Required and not defaulted, for the reason `receiptMetadata` gives: which
   * host holds your images, and for how long, is the application's call and
   * not a library's.
   */
  image: string;
  symbol?: string;
  style?: MeshArtStyle;
}

/**
 * The off-chain JSON a marketplace reads.
 *
 * The traits are the run, which makes rarity a property of the search rather
 * than of a rarity table somebody wrote: an `answered` at σ 1.00 with no voids
 * is rare because it is hard, and a collector sorting on `Voids` is sorting on
 * how much the search could not establish. `Digest` comes first because it is
 * the field everything else can be recomputed from.
 */
export function meshArtMetadata(
  facts: MeshArtFacts,
  options: MeshArtMetadataOptions,
): Record<string, unknown> {
  const style = options.style ?? meshArtStyle(facts);

  const attributes: Attribute[] = [
    { trait_type: 'Digest', value: facts.digest },
    { trait_type: 'Series', value: facts.series },
    { trait_type: 'Edition', value: facts.edition },
    { trait_type: 'Objective', value: facts.objective },
    { trait_type: 'Verdict', value: facts.verdict },
    { trait_type: 'Proved', value: `${facts.sigma.proved} of ${facts.sigma.sought}` },
    { trait_type: 'Sigma', value: `${facts.sigma.earned}/${facts.sigma.ceiling}` },
    { trait_type: 'Yield', value: facts.sigma.ratio },
    { trait_type: 'Waves', value: facts.waves },
    { trait_type: 'Calls', value: facts.calls },
    { trait_type: 'Backtracks', value: facts.backtracks },
    { trait_type: 'Voids', value: facts.voids.length },
    { trait_type: 'Field', value: style.field },
    { trait_type: 'Symmetry', value: style.spokes },
    { trait_type: 'Palette', value: style.palette.name },
    { trait_type: 'Nodes', value: style.nodeShape },
  ];

  if (facts.chain) attributes.push({ trait_type: 'Chain', value: facts.chain });

  return {
    name: meshArtName(facts),
    symbol: (options.symbol ?? 'QMESH').slice(0, SYMBOL_LIMIT),
    description:
      `A Q*3e(σ) mesh run over ${facts.subject}${facts.chain ? ` on ${facts.chain}` : ''}, ` +
      `objective ${facts.objective}: ${facts.calls} tool call${facts.calls === 1 ? '' : 's'} across ` +
      `${facts.waves} wave${facts.waves === 1 ? '' : 's'}, ${facts.sigma.proved} of ${facts.sigma.sought} ` +
      `facts proved, σ ${facts.sigma.earned}/${facts.sigma.ceiling}. ` +
      'Every element is derived from that run: the symmetry is how many facts the objective asked for, ' +
      'each branch is one call and its length is what the call earned, severed branches are calls that ' +
      'were discarded, hollow branches are facts the search could not prove, and the field is a Julia ' +
      'set whose parameter is σ — a run that earned its calls renders connected, one that thrashed ' +
      `renders as dust. Re-derivable from digest ${facts.digest.slice(0, 16)}… and checkable against it.`,
    image: options.image,
    attributes,
    properties: {
      category: 'image',
      files: [{ uri: options.image, type: 'image/png' }],
    },
  };
}
