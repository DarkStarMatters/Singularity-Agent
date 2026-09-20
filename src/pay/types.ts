/**
 * What a payment is, and what it is not.
 *
 * Every payment rail this project has looked at answers one question — *did a
 * transaction land* — and reports a boolean. That boolean hides three separate
 * facts a merchant needs before shipping anything, and the whole reason this
 * file exists is to keep them apart:
 *
 * 1. **How settled is it?** "Confirmed" and "finalized" are different claims on
 *    Solana, and only one of them is irreversible. A rail that calls both
 *    `paid: true` is asking you to ship goods against a transaction that can
 *    still be dropped. See {@link SettlementLevel}.
 *
 * 2. **Were you paid what you asked for?** A transaction that lands is not a
 *    transaction that paid *you*, in *that token*, for *that amount*. Every one
 *    of those is a separate check, and the failures are silent: a payment in a
 *    lookalike mint with the same ticker lands perfectly well. See
 *    {@link PaymentClaim} and `mismatches`.
 *
 * 3. **Can it be taken back?** This is the one nobody checks. An SPL mint can
 *    carry a live freeze authority, and Token-2022 adds a permanent delegate
 *    that can move tokens out of any wallet without the holder signing. Being
 *    paid in such a token means holding a balance at someone else's discretion,
 *    and you find out after you have shipped. See {@link MintRisk}.
 *
 * A boolean cannot carry any of that, so nothing here returns one.
 */

import type { Amount } from '../core/types.js';
import type { Finality } from '../core/finality.js';
import type { UntrustedText } from '../core/envelope.js';

/**
 * How settled a payment is.
 *
 * Deliberately four values rather than a boolean, and deliberately ordered:
 * each level is a stronger claim than the one before it.
 *
 * - `unpaid` — nothing matching the reference was found. Note this is *not*
 *   proof of non-payment: an RPC that has pruned history and a payment that
 *   never happened look identical from here, and the note says which case the
 *   endpoint could actually rule out.
 * - `pending` — a transaction exists but has not reached a commitment worth
 *   acting on.
 * - `probabilistic` — confirmed, and reversible in principle. Fine for showing
 *   a spinner or reserving stock; not fine for handing over something you
 *   cannot claw back.
 * - `final` — finalized. The only level at which Solana considers it
 *   irreversible, and the only one this project will call settled.
 */
export type SettlementLevel = 'unpaid' | 'pending' | 'probabilistic' | 'final';

/** Rank, so a caller can express "at least this settled" without a switch. */
export const SETTLEMENT_ORDER: Record<SettlementLevel, number> = {
  unpaid: 0,
  pending: 1,
  probabilistic: 2,
  final: 3,
};

/** True when `level` meets or exceeds `required`. */
export function meetsSettlement(level: SettlementLevel, required: SettlementLevel): boolean {
  return SETTLEMENT_ORDER[level] >= SETTLEMENT_ORDER[required];
}

/**
 * What the merchant asked to be paid, stated before any money moved.
 *
 * This is the thing verification checks *against*. Without it, "was I paid" has
 * no answer — only "did something happen", which is what every rail that
 * returns a boolean is actually telling you.
 *
 * `mint` names a token by address and never by symbol. A ticker is not an
 * identity: anyone can create a mint called USDC, and a payment in one lands
 * exactly as cleanly as a payment in the real thing.
 */
export interface PaymentClaim {
  /** Who must be paid. */
  to: string;
  /** Whole tokens as a decimal string, never base units. */
  amount: string;
  /** Mint address. Absent means native SOL. Never a symbol. */
  mint?: string;
  /** Text the payment's memo must contain, where the merchant set one. */
  memo?: string;
  /**
   * The unique pubkey that makes this payment findable on chain.
   *
   * Solana Pay's mechanism: a reference is attached to the transaction as a
   * read-only, non-signer account, which does nothing except make the
   * transaction discoverable by that key. It is how a merchant correlates a
   * payment to an order without asking the payer to quote anything.
   */
  reference: string;
}

/**
 * What actually happened, measured against what was asked.
 *
 * `mismatches` is the field to read before `level`. A payment can be `final`
 * and still not be *your* payment — finalized to the wrong address, in the
 * wrong mint, for the wrong amount. Both facts are reported because they are
 * genuinely different, and collapsing them is how a merchant ships against a
 * stranger's transaction.
 */
export interface PaymentSettlement {
  level: SettlementLevel;
  /** The transaction that satisfied the claim, where one did. */
  signature?: string;
  /** What was actually transferred to the claimed recipient. */
  paid?: Amount;
  /** Who paid. Useful for refunds, and for nothing else — it is not identity. */
  from?: string;
  /** ISO 8601, from the block time. Absent when the endpoint will not say. */
  at?: string;
  /** The memo found in the transaction, if any. Untrusted: the payer wrote it. */
  memo?: UntrustedText;
  /**
   * Everything about this payment that does not match the claim.
   *
   * Empty means every field checked out. Non-empty means **do not fulfil**,
   * whatever `level` says. Each entry names the field and both values, because
   * a merchant reading this is deciding whether to refund a stranger.
   */
  mismatches: string[];
  /**
   * One sentence for whoever has to act on this. Never empty — a settlement
   * that cannot explain itself is one somebody will misread.
   */
  note: string;
  /** Confirmation depth and irreversibility, where the chain reports it. */
  finality?: Finality;
  /**
   * Set when this reference has already been fulfilled, and by what.
   *
   * A reference is public once the transaction lands. Nothing about quoting one
   * proves you are the merchant who issued it, so a payment can be presented
   * twice and the second presentation must not pay out again.
   */
  alreadyFulfilled?: { at: string; purpose?: string };
}

/**
 * What accepting a token exposes you to *after* you have been paid.
 *
 * The check nobody runs, and the one with the worst failure mode. Receiving a
 * token is not the end of the story on Solana:
 *
 * - A live **freeze authority** can freeze your token account. The balance
 *   stays yours and becomes unusable, indefinitely, at someone else's choice.
 * - A **permanent delegate** (Token-2022) can transfer tokens out of any wallet
 *   holding that mint, without the holder signing anything. It is a clawback,
 *   and it is invisible unless you read the mint's extensions.
 * - A **transfer hook** runs issuer-supplied code on every transfer, which can
 *   make your outgoing payment fail on conditions you cannot see.
 *
 * None of these are exotic; all of them ship on real mints. A merchant who
 * accepts payment in a token with a permanent delegate has been paid in
 * something the issuer can take back after the goods are gone.
 */
export interface MintRisk {
  mint: string;
  /** Can freeze token accounts, including the one you are paid into. */
  freezeAuthority?: string;
  /** Can create more supply. Dilution risk, not custody risk. */
  mintAuthority?: string;
  /** Can move this mint out of any wallet, without the holder signing. */
  permanentDelegate?: string;
  /** Issuer code that runs on every transfer, including yours out. */
  transferHook?: string;
  /**
   * False when someone other than the holder can freeze or seize the balance
   * after it arrives — that is, when being paid does not mean keeping it.
   *
   * Dilution does not make this false: a live mint authority is a reason to
   * price differently, not a reason to distrust the balance you hold.
   */
  custodyIsYours: boolean;
  /** Plain sentences, written for a merchant deciding whether to accept. */
  warnings: string[];
}
