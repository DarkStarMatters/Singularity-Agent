/**
 * Turning what a mint declares into what it means for a seller.
 *
 * Split from the reading on purpose, the same way `liveness.classify` is split
 * from probing an endpoint. Reading a mint needs a network and is dull; judging
 * what the fields *mean* is the part with opinions in it, and it is the part
 * worth testing exhaustively against every combination without a connection in
 * sight.
 *
 * Every judgement here is mechanical and local. Nothing weighs one risk against
 * another, nothing produces a score, and nothing decides whether a token is
 * worth buying — a caller who wants that has to make it themselves, from facts
 * that each name the party holding the power.
 */

import type { ExitRisk } from './types.js';

/**
 * What the mint account and its extensions declare, flattened.
 *
 * Deliberately plain data rather than the adapter's `MintFacts`: this is the
 * seam, and a seam that requires a `PublicKey` and a TLV map is one you cannot
 * write a table-driven test against.
 */
export interface MintExitFacts {
  /** Base58 mint address, for the notes. */
  mint: string;
  /** Live mint authority, if any. Dilution, not custody. */
  mintAuthority?: string;
  /** Live freeze authority, if any. */
  freezeAuthority?: string;
  /** Token-2022 permanent delegate, if any. */
  permanentDelegate?: string;
  /** The hook program, when the extension is present *and* points somewhere. */
  transferHookProgram?: string;
  /** Whether the hook extension exists at all, program set or not. */
  hasTransferHookExtension?: boolean;
  hasTransferFee?: boolean;
  hasDefaultAccountState?: boolean;
  nonTransferable?: boolean;
}

/** Shortened for prose, matching the rest of the project's error text. */
function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * Every mechanism this mint carries, in no particular order.
 *
 * Sorting is the caller's, because the right order depends on what they are
 * rendering. What is guaranteed here is that a mechanism present in the facts
 * always produces exactly one entry, and one absent never produces any.
 */
export function classifyExitRisks(facts: MintExitFacts): ExitRisk[] {
  const risks: ExitRisk[] = [];
  const name = short(facts.mint);

  // ── the mint itself refuses ─────────────────────────────────────────────
  if (facts.nonTransferable) {
    risks.push({
      mechanism: 'non-transferable',
      severity: 'blocks',
      note: `Mint ${name} is non-transferable. It cannot be sold at any price, only burned. There is no exit.`,
    });
  }

  // A hook with a program set gates every transfer through code somebody else
  // controls, which is a block rather than a discretionary power: it is already
  // running, and it decides. A hook extension with no program set is the
  // opposite — nothing runs today, and PYUSD ships exactly that shape.
  if (facts.transferHookProgram) {
    risks.push({
      mechanism: 'transfer-hook',
      severity: 'blocks',
      holder: facts.transferHookProgram,
      note: `Every transfer of ${name} calls program ${facts.transferHookProgram}, which runs on the sale as well as the purchase. That program decides whether your exit succeeds, and it can be changed or made to refuse at any time.`,
    });
  } else if (facts.hasTransferHookExtension) {
    risks.push({
      mechanism: 'transfer-hook',
      severity: 'degrades',
      note: `Mint ${name} carries a transfer-hook extension with no program set, so transfers behave normally today. Whoever holds the hook authority can point it at a program at any time, and ordinary sales start failing when they do.`,
    });
  }

  // ── somebody else may refuse, whenever they like ────────────────────────
  if (facts.permanentDelegate) {
    risks.push({
      mechanism: 'permanent-delegate',
      severity: 'discretionary',
      holder: facts.permanentDelegate,
      note: `${facts.permanentDelegate} can transfer or burn ${name} out of any wallet, including yours, without you signing anything. Buying this is not the same as owning it.`,
    });
  }

  if (facts.freezeAuthority) {
    risks.push({
      mechanism: 'freeze-authority',
      severity: 'discretionary',
      holder: facts.freezeAuthority,
      note: `${facts.freezeAuthority} can freeze token accounts for ${name}. A frozen balance stays yours and cannot be sold, for as long as they choose.`,
    });
  }

  if (facts.hasDefaultAccountState) {
    risks.push({
      mechanism: 'default-frozen',
      severity: 'discretionary',
      note: `Mint ${name} sets a default account state, which can make newly created token accounts arrive frozen. A first-time buyer may be unable to sell from the moment they buy.`,
    });
  }

  // ── it sells, for less than you thought ─────────────────────────────────
  if (facts.hasTransferFee) {
    risks.push({
      mechanism: 'transfer-fee',
      severity: 'degrades',
      note: `Mint ${name} charges a fee on every transfer, so a sale delivers less than the amount sent. This build does not compute the rate.`,
    });
  }

  if (facts.mintAuthority) {
    risks.push({
      mechanism: 'mint-authority',
      severity: 'degrades',
      holder: facts.mintAuthority,
      note: `${facts.mintAuthority} can still issue more ${name}. That dilutes what you hold without preventing you from selling it.`,
    });
  }

  return risks;
}

/** Worst first, so a reader who stops after one line stops on the worst one. */
const RANK = { blocks: 0, discretionary: 1, degrades: 2 } as const;

export function sortBySeverity(risks: ExitRisk[]): ExitRisk[] {
  return [...risks].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/**
 * The two headline facts, which are deliberately two.
 *
 * "Can I sell this" and "can somebody stop me" are different questions with
 * different answers, and the first implementation of this collapsed them —
 * which reported USDC identically to a soulbound token, because Circle holds a
 * freeze authority. Both are true; they are not the same truth.
 */
export function exitVerdict(risks: ExitRisk[]): {
  canExit: boolean;
  underThirdPartyControl: boolean;
} {
  return {
    canExit: !risks.some((risk) => risk.severity === 'blocks'),
    underThirdPartyControl: risks.some((risk) => risk.severity === 'discretionary'),
  };
}
