/**
 * How much of an answer the caller can afford to read.
 *
 * Every list in this repo is capped, and until now every cap was a constant
 * somebody chose once: 50 Solana mints, 25 history entries, a Cosmos bank
 * balance with no cap at all. Those numbers stand in for a question the tool
 * never asked — how much room does the thing calling me have? A model with an
 * 8k window and one with a 1M window want different amounts of the same
 * answer, and neither of them wants the number a developer picked in 2026.
 *
 * So the cap becomes a parameter. `budget` is the caller stating its own
 * context, not this tool guessing at it.
 *
 * The part that matters is what a budget may *not* do. Shrinking a response is
 * exactly the operation that produced the two worst bugs this project has
 * shipped — the Solana dust truncation and an EVM scan whose dropped failures
 * came back as `[]` — because in both cases the list got shorter and nothing
 * said so. A budget makes that operation routine and caller-controlled, which
 * is precisely why it cannot be allowed to happen quietly. {@link applyBudget}
 * returns the list and its {@link Completeness} together, so there is no way to
 * cut one without restating the other; the compiler asks, the same way
 * {@link TokenScan} asks.
 */

import { type Completeness, completeness } from './envelope.js';

/**
 * - `small` — a tight context. Ten items, enough to characterize a result
 *   without spending the window on it.
 * - `standard` — what the source returns when nobody says otherwise. The
 *   current behaviour, unchanged, and what absence of a budget still means.
 * - `full` — as much as the source will honestly give. Still bounded: `full`
 *   is a request for the source's ceiling, never for an unbounded response,
 *   because "return everything" is how a Solana balance once came back at
 *   1.27 MB and failed.
 * - `{ maxItems }` — an exact count, when the caller has actually done the
 *   arithmetic.
 */
export type ResponseBudget = 'small' | 'standard' | 'full' | { maxItems: number };

/** Items a named budget asks for, before the source's own ceiling applies. */
const NAMED: Record<'small' | 'standard' | 'full', number | null> = {
  small: 10,
  // `null` means "whatever this source's default is" — standard is defined by
  // the source rather than here, so adding a budget parameter changes no
  // existing answer.
  standard: null,
  full: Number.POSITIVE_INFINITY,
};

/**
 * What a source will return, with and without a stated budget.
 *
 * Both numbers belong to the source, not to the budget: a Cosmos bank query
 * enumerates cheaply and a Solana mint scan costs a metadata read per entry,
 * so `full` cannot mean the same number for both.
 */
export interface BudgetBounds {
  /** Returned when nobody states a budget. Today's behaviour. */
  fallback: number;
  /** The most this source will return, whatever is asked of it. */
  ceiling: number;
}

/**
 * Resolve a budget, and an explicit count, to a number of items.
 *
 * When both a budget and a `limit` are given, the **smaller wins**. There is no
 * precedence rule to remember and no combination that surprises: a caller that
 * says "small context" and "give me 200" gets ten, and one that says "full" and
 * "give me five" gets five. Both readings of the pair are requests for less,
 * and honouring the stricter one is never the wrong answer.
 */
export function itemBudget(
  budget: ResponseBudget | undefined,
  bounds: BudgetBounds,
  limit?: number,
): number {
  const asked =
    budget === undefined
      ? bounds.fallback
      : typeof budget === 'object'
        ? budget.maxItems
        : (NAMED[budget] ?? bounds.fallback);

  const bounded = Math.min(asked, bounds.ceiling, limit ?? Number.POSITIVE_INFINITY);

  // Floor of one rather than zero. A budget of zero would return an empty list
  // with a truncation note, which is a shape every downstream reader already
  // mishandles — and nobody asking a chain a question wants none of the answer.
  return Math.max(Math.floor(bounded), 1);
}

/**
 * Cut a list to a budget and say so, in one operation.
 *
 * The two halves are returned together because separating them is the bug.
 * `entries.slice(0, n)` compiles anywhere; the completeness sitting beside it
 * goes on claiming `exhaustive`, and the caller reads an empty tail as
 * "nothing else is held". Here the slice is not reachable without the restated
 * completeness.
 *
 * Three properties hold, and each is tested:
 *
 * - A budget never *upgrades* a claim. A `curated` list cut to ten is still a
 *   list of a curated set, and its caveat survives into the new note —
 *   truncation is an additional limit, not a replacement for the one already
 *   there.
 * - A budget that cuts nothing changes nothing. Asking for more than exists
 *   returns the original completeness untouched, so `exhaustive` still means
 *   exhaustive and an empty result may still be read as "there is none".
 * - A budget that does cut always produces `truncated` carrying both counts,
 *   so the caller can tell that asking for more would get more — which is the
 *   difference between a limit it chose and a limit the chain imposed.
 */
export function applyBudget<T>(
  items: T[],
  limit: number,
  claim: Completeness,
  /** One sentence naming what was cut. Receives what was kept and what was not. */
  describe: (shown: number, omitted: number) => string,
): { entries: T[]; completeness: Completeness } {
  if (items.length <= limit) return { entries: items, completeness: claim };

  const entries = items.slice(0, limit);
  const omitted = items.length - limit;

  // A scan that already failed does not become a truncated success by being
  // shortened. `failed` outranks `truncated`, so it survives the cut intact —
  // the counts would be counts of nothing anyway.
  if (claim.kind === 'failed') return { entries, completeness: claim };

  const cut = completeness.truncated(entries.length, omitted, describe(entries.length, omitted));

  // Anything else keeps its note and takes the new counts. `curated` and an
  // earlier `truncated` both describe a real limit on the entries that remain,
  // so the caveat is carried rather than replaced; the numbers are not, because
  // they now describe a shorter list than the ones they came with.
  return {
    entries,
    completeness:
      claim.kind === 'exhaustive' ? cut : { ...cut, note: `${cut.note} ${claim.note}` },
  };
}

/**
 * Read a budget off the wire.
 *
 * Model front ends send a name or a bare number: `"small"`, or `40`. The
 * internal type keeps `{ maxItems }` because `budget: 40` reads as forty of
 * something unstated once it is three call frames from here, while a tool
 * schema wants the simplest thing a model can emit correctly — and a union of
 * a string enum with an object is not that. So the two shapes stay different
 * and meet here, in one place, rather than the object shape leaking into
 * every schema.
 *
 * Anything unrecognized returns `undefined`, which means "no budget stated"
 * and leaves the response exactly as it would have been. A malformed budget
 * must not shrink an answer — that is the one failure mode worth designing
 * out, because a caller would have no way to tell a bad argument from a wallet
 * that genuinely holds less.
 */
export function parseBudget(value: unknown): ResponseBudget | undefined {
  if (value === 'small' || value === 'standard' || value === 'full') return value;

  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
    return { maxItems: Math.floor(value) };
  }

  if (value && typeof value === 'object' && 'maxItems' in value) {
    const { maxItems } = value as { maxItems: unknown };
    if (typeof maxItems === 'number' && Number.isFinite(maxItems) && maxItems >= 1) {
      return { maxItems: Math.floor(maxItems) };
    }
  }

  return undefined;
}

/**
 * The sentence a budget-driven cut writes.
 *
 * Separate from a chain-driven one on purpose. "The chain would not give us
 * more" and "you asked for less" are different facts, and only one of them is
 * fixed by asking again — so the note says which, and names the knob.
 */
export function budgetNote(shown: number, omitted: number, what: string): string {
  return (
    `Showing ${shown} of ${shown + omitted} ${what} — ${omitted} omitted to fit the requested ` +
    'response budget, not because the chain declined to report them. Raise `budget` for more.'
  );
}
