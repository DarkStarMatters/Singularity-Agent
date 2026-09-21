/**
 * What a transaction does, measured rather than reasoned about.
 *
 * Everything else in this project is a reading: what a mint declares, what an
 * account holds, who owns which token account. Readings catch the whole class
 * of transaction that is inconsistent with the chain, and roadmap 2.5 records
 * in writing the case they cannot reach — a fee-on-transfer ERC-20 is invisible
 * to the standard interface, because the behaviour lives inside `transfer`
 * itself. There is no field to read. The payer sends the amount demanded and
 * the payee receives less than the amount demanded, and every fact checked out.
 *
 * Simulation is the only thing that closes that, and the prize is not the
 * revert check. It is the arithmetic: **decode what the recipient's balance
 * actually became, and subtract.** A transfer fee, a skimming hook, a rounding
 * surprise — all of them appear as a shortfall without anyone having to
 * anticipate the mechanism that caused it. That is a different kind of check
 * from naming known mechanisms, because it measures the outcome.
 *
 * Two limits, stated here rather than discovered later:
 *
 * - A simulation runs against state as it is **now**. A transaction signed a
 *   minute later executes against different state, and this says nothing about
 *   that minute.
 * - A simulated transaction is not a signed one. Nothing here moves the
 *   no-signing line.
 *
 * The judging below is pure. What it judges is read by the adapters, for the
 * reason the rest of this codebase splits the two: the interesting case is a
 * shortfall, and a mint that skims is not something you can conveniently
 * arrange on demand.
 */

import type { Amount } from './types.js';
import type { Completeness } from './envelope.js';
import { completeness } from './envelope.js';
import { formatUnits } from './format.js';

/** What the chain reported when the transaction was executed against it. */
export interface SimulationOutcome {
  chain: string;
  /** It executed without reverting. False means this transaction cannot land. */
  succeeded: boolean;
  /** Why it failed, as the chain put it. */
  error?: string;
  /** Compute units or gas, where the chain reports it. */
  unitsConsumed?: number;
  /**
   * What the recipient's balance actually changed by.
   *
   * Absent when it could not be measured, which is a different answer from
   * zero and is never reported as zero. `completeness` says which.
   */
  delivered?: Amount;
  /** What the payment said it would deliver, where a claim was made. */
  expected?: Amount;
  /**
   * `expected` minus `delivered`, when the recipient gets less than was sent.
   *
   * The whole reason this file exists. Present only when measured and short.
   */
  shortfall?: Amount;
  /** What was and was not measured. Always present. */
  completeness: Completeness;
  /** One sentence for whoever has to act on this. Never empty. */
  note: string;
}

/**
 * Compare what arrived against what was promised.
 *
 * Deliberately refuses to guess in both directions. An unmeasurable delivery
 * is reported as unmeasured, never as zero and never as fine; and a delivery
 * that exceeds the expectation is reported without complaint, because a
 * rebasing token that credits more than was sent is not a failure of the
 * payment.
 */
export function judgeDelivery(params: {
  chain: string;
  succeeded: boolean;
  error?: string;
  unitsConsumed?: number;
  delivered?: Amount;
  expected?: Amount;
  /** Why the delivered amount could not be measured, where it could not. */
  unmeasuredReason?: string;
}): SimulationOutcome {
  const { chain, succeeded, delivered, expected } = params;

  if (!succeeded) {
    return {
      chain,
      succeeded: false,
      ...(params.error ? { error: params.error } : {}),
      ...(params.unitsConsumed !== undefined ? { unitsConsumed: params.unitsConsumed } : {}),
      ...(expected ? { expected } : {}),
      completeness: completeness.failed(
        'The transaction reverted in simulation, so nothing about what it would deliver was measured.',
      ),
      note: `This transaction does not execute against ${chain} as it is right now: ${params.error ?? 'it reverted'}. Signing it would spend a fee to fail.`,
    };
  }

  const base = {
    chain,
    succeeded: true as const,
    ...(params.unitsConsumed !== undefined ? { unitsConsumed: params.unitsConsumed } : {}),
    ...(delivered ? { delivered } : {}),
    ...(expected ? { expected } : {}),
  };

  if (!delivered) {
    return {
      ...base,
      completeness: completeness.failed(
        params.unmeasuredReason ??
          'The recipient balance change was not measured, so how much actually arrives is unknown.',
      ),
      note: `This transaction executes, and how much reaches the recipient was not measured — ${params.unmeasuredReason ?? 'this endpoint does not report balance changes'}. It executing is not evidence that the full amount arrives.`,
    };
  }

  if (!expected) {
    return {
      ...base,
      completeness: completeness.exhaustive(
        'Executed against current state; the recipient balance change was measured.',
      ),
      note: `This transaction executes and delivers ${delivered.formatted} ${delivered.symbol} to the recipient.`,
    };
  }

  const short = BigInt(expected.raw) - BigInt(delivered.raw);

  if (short > 0n) {
    return {
      ...base,
      shortfall: {
        raw: short.toString(),
        formatted: formatUnits(short, expected.decimals),
        decimals: expected.decimals,
        symbol: expected.symbol,
      },
      completeness: completeness.exhaustive(
        'Executed against current state; the recipient balance change was measured.',
      ),
      // Deliberately does not name a cause. This measured a difference; it did
      // not establish why there is one, and a transfer fee, a skimming hook and
      // a transaction built for a different amount than the one quoted are
      // indistinguishable from here. Naming the likeliest as though it were the
      // finding would be the same unsupported confidence this tool exists to
      // refuse elsewhere.
      note: `The recipient receives ${delivered.formatted} ${delivered.symbol} and this payment is for ${expected.formatted}, so it is short by ${formatUnits(short, expected.decimals)}. That was measured by executing the transaction, so whatever causes it is already reflected — commonly a transfer fee or a hook that takes a cut, but equally a transaction built for a different amount than the one quoted. Do not treat this as paid in full without establishing which.`,
    };
  }

  return {
    ...base,
    completeness: completeness.exhaustive(
      'Executed against current state; the recipient balance change was measured.',
    ),
    note:
      short === 0n
        ? `This transaction executes and delivers exactly ${delivered.formatted} ${delivered.symbol}, which is what was asked.`
        : `This transaction executes and delivers ${delivered.formatted} ${delivered.symbol}, which is more than the ${expected.formatted} asked for. Some tokens credit more than is sent; nothing about this payment is short.`,
  };
}
