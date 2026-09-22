/**
 * Process supervision, scored on evidence rather than on confidence.
 *
 * The idea this borrows is the useful half of the Q* literature: score every
 * *step*, not just the final answer, so a search can tell a wrong turn from a
 * right one before it has spent the rest of its budget down that branch. The
 * usual implementation is a second model trained to judge a reasoning step,
 * which is a fine thing to have and is not a thing this repository contains.
 *
 * What it contains instead is a codebase where every tool already reports how
 * good its own answer is. `completeness` says whether a list is exhaustive,
 * curated, truncated or failed. `verdict` says payable, unpayable or unproven.
 * An error is a structured `SingularityError` with a code. Those are not
 * judgements about a step — they are facts the step returned about itself, and
 * a reward computed from them is reproducible, auditable, and cannot
 * hallucinate a high score for a call that told us nothing.
 *
 * So the reward model here is arithmetic over evidence. It never asks how
 * plausible a step looked. It asks what the step proved, and how honestly the
 * source described what it proved. Two runs of the same mesh over the same
 * chain state produce the same rewards, which is the property that makes the
 * trace worth putting in front of somebody.
 */
import type { Completeness } from '../core/envelope.js';
import type { FactKind } from './blackboard.js';

/**
 * The most one step can be worth.
 *
 * Two goal facts at two points each, one point for anything extra it proved
 * along the way, one point for a source that could say `exhaustive`. Stated as
 * a constant because σ's ceiling is derived from it, and a ceiling nobody can
 * trace back to a rule is a number rather than a measurement.
 */
export const MAX_STEP_REWARD = 6;

/**
 * The reward at or below which a branch is not extended.
 *
 * Zero, and zero is the interesting value rather than a negative one. A step
 * that errored is obviously spent; a step that *succeeded* and proved nothing
 * new is the failure worth catching, because it looks like progress in every
 * transcript and is not. Both land here.
 */
export const PRUNE_FLOOR = 0;

export interface StepReward {
  value: number;
  /** Each component, named, in the order it was applied. */
  reasons: string[];
  /** Whether the search may extend this branch. */
  extend: boolean;
}

export interface StepEvidence {
  /** The call threw. Nothing was proved and the branch is finished. */
  errored: boolean;
  /** Goal facts this step was the first to prove. */
  boundGoal: FactKind[];
  /** Everything this step was the first to prove, goal facts included. */
  bound: FactKind[];
  /** The weakest completeness anywhere in the result, where it carried one. */
  completeness: Completeness | null;
}

/**
 * Score one executed step.
 *
 * The shape of the arithmetic matters more than the constants. Goal facts are
 * worth double anything else, because a move that proves something true but
 * irrelevant is how a search wanders; the bonus for extra facts exists because
 * those facts unblock later moves and refusing to pay for them would make the
 * search short-sighted; and completeness moves the score in both directions,
 * so a source that admits it failed costs the branch something rather than
 * being scored identically to one that answered.
 *
 * Capping the goal-fact term at two is not tuning. It stops one broad tool —
 * `resolve`, which can prove three slots at once — from dominating the trace
 * to the point where nothing after it can change the verdict.
 */
export function scoreStep(evidence: StepEvidence): StepReward {
  const reasons: string[] = [];

  if (evidence.errored) {
    return {
      value: -2,
      reasons: ['the call failed, so nothing was proved and this branch ends here (-2)'],
      extend: false,
    };
  }

  const goalCount = Math.min(evidence.boundGoal.length, 2);
  let value = goalCount * 2;
  if (goalCount > 0) {
    reasons.push(
      `proved ${evidence.boundGoal.length} fact${evidence.boundGoal.length === 1 ? '' : 's'} the objective asked for: ${evidence.boundGoal.join(', ')} (+${goalCount * 2})`,
    );
  }

  const extra = evidence.bound.filter((kind) => !evidence.boundGoal.includes(kind));
  if (extra.length > 0) {
    value += 1;
    reasons.push(`proved ${extra.join(', ')} on the way, which unblocks later moves (+1)`);
  }

  if (evidence.bound.length === 0) {
    reasons.push('the call returned, and proved nothing that was not already known (0)');
  }

  if (evidence.completeness) {
    if (evidence.completeness.kind === 'exhaustive') {
      value += 1;
      reasons.push('the source could say its answer was exhaustive (+1)');
    } else if (evidence.completeness.kind === 'failed') {
      value -= 1;
      reasons.push('the source reported it could not determine the answer (-1)');
    } else {
      reasons.push(`the source reported its answer as ${evidence.completeness.kind} (0)`);
    }
  }

  return { value, reasons, extend: value > PRUNE_FLOOR };
}

export interface Sigma {
  /** Summed reward over every step that was kept. */
  earned: number;
  /** What those same calls could have paid at best. */
  ceiling: number;
  /** `earned / ceiling`, to two places. 1 means every call paid in full. */
  ratio: number;
  /** The reward at or below which a step was not extended. */
  floor: number;
  /** Goal facts proved, out of goal facts sought. */
  proved: number;
  sought: number;
}

/**
 * σ — the accumulated process reward, and what it is a fraction of.
 *
 * A bare total is unreadable: 14 is excellent over three calls and poor over
 * nine. The ceiling is what the same number of calls could have earned, so the
 * ratio answers the question a caller actually has, which is whether this run
 * got its money's worth or thrashed.
 */
export function sigma(rewards: number[], proved: number, sought: number): Sigma {
  const earned = rewards.reduce((total, value) => total + value, 0);
  const ceiling = rewards.length * MAX_STEP_REWARD;

  return {
    earned,
    ceiling,
    ratio: ceiling === 0 ? 0 : Math.round((earned / ceiling) * 100) / 100,
    floor: PRUNE_FLOOR,
    proved,
    sought,
  };
}
