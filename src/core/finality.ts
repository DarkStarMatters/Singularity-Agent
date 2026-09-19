/**
 * How much a result at a given height is actually worth.
 *
 * {@link Completeness} asks whether a result covers everything it appears to.
 * This asks the other question nothing here was asking: whether what it covers
 * can still be taken away. They are the same defect seen twice — a value that
 * reads as settled fact while carrying a qualifier nobody wrote down.
 *
 * Every read in this tool has been answering about the head of a chain and
 * presenting it with the certainty of a receipt. That is wrong in four
 * different ways at once, because the four families do not even agree on what
 * settlement *is*:
 *
 * - **EVM** finalizes in checkpoints. A block at the head can be reorganized
 *   out of existence; one at or below the `finalized` tag cannot, short of the
 *   validator set burning a third of its stake. Between those two points is
 *   roughly thirteen minutes on Ethereum where a balance is real, readable, and
 *   revocable.
 * - **Solana** has commitment levels, and this repo reads at `confirmed` —
 *   which is a supermajority vote, not a root. It is the right default for
 *   latency and it is *not* final, and nothing in a returned balance said so.
 * - **Cosmos** finalizes on commit. A block that exists is final, which makes
 *   it the only family here that can say so plainly.
 * - **Bitcoin** never finalizes at all. It buys confidence with work, and six
 *   confirmations is a convention rather than a threshold the chain enforces.
 *   `final` is a claim this module will not make about a UTXO chain at any
 *   depth, because the chain does not make it either.
 *
 * The rule, and the reason this is a type rather than a field on four adapters:
 * **a chain that will not say gets `unknown`, never `final`.** An endpoint that
 * does not implement the `finalized` tag, or that aliases it to the head, has
 * told us nothing, and "nothing" must not round up to "settled".
 */

import type { ChainFamily } from './types.js';

/**
 * - `final` — irreversible under the chain's own consensus rules. The only kind
 *   an irrevocable decision may be made on.
 * - `probabilistic` — reversible, at a cost that grows with depth. Proof-of-work
 *   settlement, which is confidence rather than a guarantee.
 * - `reversible` — at or near the head. A reorganization would erase it, and on
 *   a live chain that is an ordinary event rather than a disaster.
 * - `unknown` — the chain or the endpoint would not say. Distinct from
 *   `reversible`, and the distinction is the reason this type exists: one is a
 *   fact about the chain, the other is a gap in what we were told.
 */
export type FinalityKind = 'final' | 'probabilistic' | 'reversible' | 'unknown';

export interface Finality {
  kind: FinalityKind;
  /**
   * One sentence, written for someone about to act on the value this is
   * attached to. Never empty, for the same reason a completeness note is not.
   */
  note: string;
  /** Blocks built on top of this one, where the chain counts that way. */
  confirmations?: number;
  /** The height the chain currently considers irreversible, where it says. */
  finalizedHeight?: number;
  /** The height this result was read at, when it is about a specific block. */
  height?: number;
}

/**
 * Constructors rather than literals, so a kind cannot be claimed without the
 * number that makes it checkable — the same reason `truncated` demands a count.
 */
export const finality = {
  final(note: string, detail: Omit<Finality, 'kind' | 'note'> = {}): Finality {
    return { kind: 'final', note, ...detail };
  },
  probabilistic(confirmations: number, note: string, detail: Omit<Finality, 'kind' | 'note' | 'confirmations'> = {}): Finality {
    return { kind: 'probabilistic', note, confirmations, ...detail };
  },
  reversible(note: string, detail: Omit<Finality, 'kind' | 'note'> = {}): Finality {
    return { kind: 'reversible', note, ...detail };
  },
  unknown(note: string, detail: Omit<Finality, 'kind' | 'note'> = {}): Finality {
    return { kind: 'unknown', note, ...detail };
  },
};

/**
 * May this be treated as settled?
 *
 * The one question worth asking of this type. `probabilistic` deliberately
 * answers *no* however deep it is: a caller that wants "six confirmations is
 * enough for me" is stating its own risk tolerance, which is exactly the
 * decision this tool must not quietly make on its behalf. The confirmation
 * count is right there for a caller that wants to set a bar.
 */
export function supportsIrreversibilityClaim(value: Finality | undefined | null): boolean {
  return value?.kind === 'final';
}

/** The weakest guarantee among several — what a combined answer may claim. */
export function weakestFinality(values: Finality[]): Finality | null {
  const rank: Record<FinalityKind, number> = {
    final: 0,
    probabilistic: 1,
    reversible: 2,
    unknown: 3,
  };

  let worst: Finality | null = null;
  for (const value of values) {
    if (!worst || rank[value.kind] > rank[worst.kind]) worst = value;
  }
  return worst;
}

/**
 * How deep a UTXO chain's convention puts settlement.
 *
 * Six is Bitcoin's folklore figure and it is folklore — the chain enforces
 * nothing at six. It is used only to phrase the note, never to upgrade a kind.
 */
const UTXO_CONVENTIONAL_DEPTH = 6;

/**
 * Work out what a height is worth on a chain that reports a finalized point.
 *
 * Shared by EVM and Solana, which differ in vocabulary — checkpoint versus
 * root, block versus slot — and not in structure. Cosmos does not come through
 * here because it has no gap to measure, and UTXO does not because it has no
 * finalized point to measure against.
 *
 * `finalizedHeight` of `null` is the endpoint declining to answer, and produces
 * `unknown`. That is the whole point: a missing `finalized` tag is not evidence
 * of instant finality, though it is indistinguishable from it at the call site,
 * which is how it would have become one.
 */
export function finalityFromCheckpoint(options: {
  family: ChainFamily;
  height: number;
  finalizedHeight: number | null;
  tipHeight?: number;
  /** What this family calls the unit, for the note. */
  unit?: string;
}): Finality {
  const { family, height, finalizedHeight, tipHeight } = options;
  const unit = options.unit ?? (family === 'svm' ? 'slot' : 'block');

  if (finalizedHeight === null) {
    return finality.unknown(
      `This endpoint does not report a finalized ${unit}, so whether ${unit} ${height} can still be reorganized is unknown. It is not evidence that it cannot be.`,
      { height },
    );
  }

  if (height <= finalizedHeight) {
    return finality.final(
      `${capitalize(unit)} ${height} is at or below the finalized ${unit} (${finalizedHeight}), so it cannot be reorganized without the chain violating its own consensus rules.`,
      { height, finalizedHeight, ...(tipHeight !== undefined ? { confirmations: tipHeight - height } : {}) },
    );
  }

  const behind = height - finalizedHeight;
  return finality.reversible(
    `${capitalize(unit)} ${height} is ${behind} ${unit}${behind === 1 ? '' : 's'} above the finalized ${unit} (${finalizedHeight}) and can still be reorganized. Do not treat it as settled.`,
    { height, finalizedHeight, ...(tipHeight !== undefined ? { confirmations: tipHeight - height } : {}) },
  );
}

/**
 * What a depth is worth on a chain that settles by accumulated work.
 *
 * Never returns `final`, at any depth. The chain offers no point past which a
 * reorganization is disallowed — only one past which it is expensive — and
 * converting that into `final` would be this tool inventing a guarantee the
 * chain declines to give.
 */
export function finalityFromConfirmations(height: number, tipHeight: number): Finality {
  const confirmations = tipHeight - height + 1;

  if (confirmations <= 0) {
    return finality.reversible(
      'This is not in a block yet. It is in the mempool, where it can be replaced or dropped entirely.',
      { height, confirmations: 0 },
    );
  }

  const settled = confirmations >= UTXO_CONVENTIONAL_DEPTH;
  return finality.probabilistic(
    confirmations,
    settled
      ? `${confirmations} confirmations, at or past the conventional ${UTXO_CONVENTIONAL_DEPTH}. Proof-of-work settlement is never final — the cost of reversing it is high, not infinite — so how many confirmations are enough is your decision, not this tool's.`
      : `Only ${confirmations} confirmation${confirmations === 1 ? '' : 's'}, below the conventional ${UTXO_CONVENTIONAL_DEPTH}. A reorganization at this depth is an ordinary event.`,
    { height },
  );
}

/**
 * Instant finality, for chains that commit rather than accumulate.
 *
 * Tendermint blocks are final on commit: a two-thirds majority has already
 * signed, and reverting one requires that majority to produce evidence of its
 * own double-signing. This is the only family here that gets `final` without a
 * checkpoint to compare against.
 */
export function finalityFromCommit(height: number): Finality {
  return finality.final(
    `Block ${height} is committed. Tendermint finalizes on commit, so there is no reorganization window to wait out on this chain.`,
    { height },
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Pull every finality out of an arbitrary result, wherever it sits.
 *
 * Shape-matched rather than key-matched, for the reason `findCompleteness`
 * learned: keying off a field name missed `tokenCompleteness` on a balance, and
 * a caveat the enforcement cannot find is the same as no caveat.
 */
export function findFinality(value: unknown): Finality[] {
  const found: Finality[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (isFinality(node)) {
      found.push(node);
      return;
    }
    for (const child of Object.values(node as Record<string, unknown>)) walk(child);
  };

  walk(value);
  return found;
}

function isFinality(value: unknown): value is Finality {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.note === 'string' &&
    typeof record.kind === 'string' &&
    ['final', 'probabilistic', 'reversible', 'unknown'].includes(record.kind)
  );
}
