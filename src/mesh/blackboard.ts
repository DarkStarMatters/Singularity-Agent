/**
 * The surface every agent in the mesh writes onto.
 *
 * A search over tool calls is usually modelled as a tree: each node owns its
 * own state, and two branches that happen to need the same fact each pay for
 * it. That is correct and it is also the expensive mistake, because every
 * fact in this repository is *chain-derived evidence* — two branches cannot
 * disagree about what `resolve` returned, and re-reading it cannot produce a
 * second answer. So the state is shared and monotonic, facts only ever
 * accumulate, and the search space collapses from a tree into a DAG.
 *
 * That collapse is the whole reason this is a mesh rather than a beam. A fact
 * proved on one branch is immediately available to every other, so the
 * concurrent wave that discovers a chain id is also the wave that unblocks
 * four moves which were inapplicable a moment earlier. Nothing is paid for
 * twice, and the ordering of the waves is the only thing the search has to get
 * right.
 *
 * ## Facts are summaries, deliberately
 *
 * What lands here is never a tool's whole payload. A portfolio across eight
 * chains is tens of kilobytes and a mesh run touches several tools, so
 * carrying raw results would produce exactly the kind of response this project
 * spends its time capping. Each move states what its result *proves* in a
 * handful of fields, and the step that proved it records the tool and the
 * arguments verbatim — so a caller who wants the full payload re-runs one
 * call rather than being handed nine.
 */

/**
 * A slot on the blackboard.
 *
 * These are the things a mesh run can come to know. They are deliberately
 * coarse: `tokens` is one fact whether the address holds two or two hundred,
 * because the question the search is answering is "do we know the holdings
 * yet", not "how many are there".
 */
export type FactKind =
  | 'subjectKind'
  | 'chain'
  | 'address'
  | 'txHash'
  | 'mint'
  | 'nativeBalance'
  | 'tokens'
  | 'activity'
  | 'txSummary'
  | 'finality'
  | 'authorities'
  | 'identity'
  | 'exit'
  | 'liveness'
  | 'fees';

export interface Fact {
  kind: FactKind;
  /** A bounded summary of what was proved — never the tool's whole payload. */
  value: unknown;
  /**
   * Which tool proved it, or `input` when the caller supplied it.
   *
   * Kept because the two are not equivalent and the difference is the kind
   * this repository cares about: a chain id the caller asserted has been
   * checked against the registry and nothing else, while one that came out of
   * `resolve` is the chain the address can actually exist on.
   */
  source: string;
}

export class Blackboard {
  private readonly facts = new Map<FactKind, Fact>();

  /** True when this slot is already proved. */
  has(kind: FactKind): boolean {
    return this.facts.has(kind);
  }

  value<T = unknown>(kind: FactKind): T | undefined {
    return this.facts.get(kind)?.value as T | undefined;
  }

  /**
   * Write a fact, if it is new.
   *
   * Returns whether this call was the one that proved it. The return value is
   * what the process reward reads, so a re-derivation of something already
   * known scores nothing — which is the intended pressure: a move that spends
   * a round trip to restate a fact has not made progress, however clean its
   * result looks.
   *
   * Existing facts are never overwritten. Monotonicity is what makes the
   * shared board safe to run concurrent waves against.
   */
  bind(kind: FactKind, value: unknown, source: string): boolean {
    if (this.facts.has(kind)) return false;
    this.facts.set(kind, { kind, value, source });
    return true;
  }

  known(): FactKind[] {
    return [...this.facts.keys()];
  }

  missing(wanted: readonly FactKind[]): FactKind[] {
    return wanted.filter((kind) => !this.facts.has(kind));
  }

  /** Everything proved, keyed by slot, for the result. */
  snapshot(): Record<string, Fact> {
    return Object.fromEntries(this.facts);
  }
}
