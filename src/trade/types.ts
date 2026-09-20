/**
 * Before you buy: the specific mechanisms by which you may not be able to sell.
 *
 * Every token-safety tool this project has looked at answers with a *score* —
 * a number, a colour, a "risk: LOW". A score is the wrong shape for this
 * question in the same way `paid: true` is the wrong shape for a payment. It
 * collapses distinct mechanisms with distinct consequences into one figure
 * whose derivation nobody can inspect, and it invites the reader to trade on a
 * summary rather than on a fact.
 *
 * So this names mechanisms. Not "risk 7/10" but: *this mint has a transfer
 * hook pointing at program X, which runs on every transfer including yours
 * out*. That is checkable, it is actionable, and it is wrong in ways a reader
 * can detect — which a score never is.
 *
 * The honest limit, stated here because it is the thing that would otherwise
 * get someone hurt: **this reads the mint, not the market.** Whether liquidity
 * is locked, how deep the pool is, and whether the hook program is benign are
 * all outside what an SPL mint account can tell you. Every report says so, and
 * `canExit: true` means "no mint-level mechanism blocks a sale", never "this is
 * safe to buy".
 */

import type { Completeness } from '../core/envelope.js';

/**
 * A named way a position can go wrong on the way out.
 *
 * Deliberately an enum of mechanisms rather than a free-text list, so a caller
 * can branch on one without parsing prose — and deliberately not a severity
 * number, so nobody can average them.
 */
export type ExitMechanism =
  /** Issuer code runs on every transfer, including the one that sells. */
  | 'transfer-hook'
  /** An address can move this token out of any wallet without the holder signing. */
  | 'permanent-delegate'
  /** An address can freeze token accounts, making the balance unmovable. */
  | 'freeze-authority'
  /** New token accounts arrive frozen, so a fresh buyer may be stuck immediately. */
  | 'default-frozen'
  /** The mint forbids transfers outright. */
  | 'non-transferable'
  /** A cut is taken on every transfer, so you receive less than you send. */
  | 'transfer-fee'
  /** Supply can grow, diluting what you hold. */
  | 'mint-authority'
  /** A few accounts hold most of the supply and can exhaust the pool ahead of you. */
  | 'holder-concentration';

export interface ExitRisk {
  mechanism: ExitMechanism;
  /**
   * What kind of obstacle this is. Three values, not a scale, and the middle
   * one is the one that took a live run against USDC to get right.
   *
   * - `blocks` — the mint itself prevents a sale. Nobody has to do anything;
   *   the sale fails or cannot be constructed.
   * - `discretionary` — a *named party* can prevent it, at will, whenever they
   *   like. The token sells fine until they act.
   * - `degrades` — the sale works, on worse terms than expected.
   *
   * Collapsing the first two was the first implementation, and it reported
   * USDC identically to a soulbound token: Circle can freeze an account, so
   * every stablecoin came back unsellable. Both facts are true and they are not
   * the same fact. A holder needs to know that someone holds the power *and*
   * that nothing is currently stopping them — and which named party it is, so
   * they can decide whether they mind. `holder` is there for exactly that.
   */
  severity: 'blocks' | 'discretionary' | 'degrades';
  /** Who holds the power, where the mechanism has a holder. */
  holder?: string;
  /** One sentence, written for somebody about to spend money. */
  note: string;
}

/** How supply is spread, where the endpoint would say. */
export interface Concentration {
  /** Share held by the single largest account, 0–100. */
  largestPercent: number;
  /** Share held by the largest accounts the endpoint returned, 0–100. */
  topPercent: number;
  /** How many accounts that covers — an RPC returns at most twenty. */
  accountsCounted: number;
  /**
   * True when the largest holder is a known pool or program account rather
   * than a person. Absent means it was not determined, which is not the same
   * as false.
   */
  largestIsPool?: boolean;
}

export interface TokenExitReport {
  mint: string;
  chain: string;
  /**
   * False when the mint itself prevents a sale, with nobody having to act.
   *
   * **True does not mean safe**, and it does not even mean unencumbered — read
   * {@link TokenExitReport.underThirdPartyControl} next. True means nothing in
   * the mint account stops you selling *today*. Liquidity can still be pulled,
   * the pool can be empty, and the price is whatever the market says. Read
   * `completeness` before treating this as a green light; it names what was
   * never looked at.
   */
  canExit: boolean;
  /**
   * True when a named party can stop you selling whenever they choose.
   *
   * Separate from `canExit` because the two are genuinely different and the
   * difference is the whole point: USDC is freely sellable *and* Circle can
   * freeze the account it sits in. Reporting that as "cannot exit" makes every
   * regulated stablecoin look like a soulbound token; reporting it as "fine"
   * hides a real power. Both are stated, and the `holder` on each risk names
   * who has it, because whether you mind depends entirely on who it is.
   */
  underThirdPartyControl: boolean;
  /** Every mechanism found, blockers first. Empty is a real answer here. */
  risks: ExitRisk[];
  /** Absent when the endpoint would not say, which is distinct from even. */
  concentration?: Concentration;
  /**
   * What this analysis covered and what it did not.
   *
   * Never `exhaustive`. A mint account cannot tell you whether liquidity is
   * locked, and a report that claimed otherwise would be the most dangerous
   * thing in this package.
   */
  completeness: Completeness;
  /** One sentence for a trader. Never empty. */
  note: string;
  explorerUrl?: string;
}
