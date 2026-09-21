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

/**
 * A payment somebody else is asking *you* to make.
 *
 * Everything above this line is written from the merchant's side: you issued a
 * claim, and you are deciding whether it was met. This is the other side of the
 * same table, and it is the side nobody instruments. An invoice arrives — from
 * an exchange, an API, a marketplace, another agent — naming a recipient, a
 * token, an amount and a memo, and the only question that matters is whether
 * signing it does what it says.
 *
 * A wallet cannot answer that. It shows you a decoded transaction *after*
 * something has already decided where the money goes, and every field in it was
 * chosen by whoever sent the demand. The checks that would catch a bad one are
 * all chain reads, and none of them happen anywhere in the usual flow.
 *
 * This interface is deliberately shaped like the payment intents real services
 * emit, rather than like a clean internal model, because the whole point is to
 * take one as it arrives and check it unmodified. Every field is optional: a
 * demand that omits something cannot be checked on it, which is itself a
 * finding rather than an error.
 */
export interface PaymentDemand {
  /** The wallet the demand says will be paid. */
  to?: string;
  /**
   * The exact token account the demand names as the destination.
   *
   * Worth its own field rather than being folded into {@link to}, because a
   * demand that names one is making a much stronger and much more checkable
   * claim: not "pay this person" but "pay this specific account". That account
   * either exists, holds the right mint and belongs to the right owner, or it
   * does not — and all three are readable.
   */
  tokenAccount?: string;
  /** Mint address. Absent means native SOL. Never a ticker. */
  mint?: string;
  /**
   * The ticker the demand claims to be denominated in, e.g. `"USDC"`.
   *
   * Checked *against* {@link mint}, never used in place of it. A demand that
   * says USDC while naming a mint that is not USDC is the entire attack, and it
   * is also what a typo in somebody's configuration looks like from outside.
   */
  asset?: string;
  /** Whole tokens as a decimal string, never base units. */
  amount?: string;
  /**
   * The same amount in base units, where the demand states both.
   *
   * Stating both is a gift: they must agree, and a demand where they disagree
   * is asking you to sign one number while showing you another.
   */
  amountBaseUnits?: string;
  /** The decimals the demand assumes. Checked against the mint's own. */
  decimals?: number;
  /** Text the payment must carry, usually what credits it to your order. */
  memo?: string;
  /** The Solana Pay reference that makes the payment findable. */
  reference?: string;
  /** When the demand stops being valid, ISO 8601. */
  expiresAt?: string;
}

/**
 * How bad a finding is, and therefore what it does to the verdict.
 *
 * - `fatal` — signing this cannot do what the demand says. The money either
 *   does not move at all or does not arrive where it claims to.
 * - `warning` — it can land, and something about it is not what a signer would
 *   assume. Costs rent, arrives short, can be frozen afterwards.
 * - `note` — worth recording, decides nothing.
 */
export type DemandSeverity = 'fatal' | 'warning' | 'note';

/**
 * One thing found wrong, or worth saying, about a demand.
 *
 * `detail` is a whole sentence naming both values, because whoever reads this
 * is deciding whether to pay a stranger and "mismatch" is not a reason.
 */
export interface DemandFinding {
  code: string;
  severity: DemandSeverity;
  detail: string;
}

/**
 * Whether this demand can be paid as stated.
 *
 * Three values rather than a boolean, for the same reason settlement has four.
 * `unproven` is the one that earns its place: an RPC that would not answer and
 * a destination that does not exist are completely different situations, and a
 * validator that reports both as "do not pay" teaches people to ignore it.
 */
export type DemandVerdict = 'payable' | 'unpayable' | 'unproven';

/** What the destination turned out to be, once read rather than assumed. */
export interface DemandDestination {
  /** The account the tokens would actually land in. */
  address: string;
  /** Whether that account exists on chain right now. */
  exists: boolean;
  /** The mint it holds, read from the account rather than from the demand. */
  mint?: string;
  /** Who owns it, read from the account. */
  owner?: string;
  /** True when it is the associated token account for `owner` and `mint`. */
  isAssociated?: boolean;
  /** True when the account is frozen and cannot receive. */
  frozen?: boolean;
}

/**
 * Everything readable about a demand, and whether it survives being read.
 *
 * Read `findings` before `verdict`. The verdict is a summary of them and
 * nothing else, so a caller that branches on it is branching on the findings
 * whether or not they look — but the findings are what a human needs when they
 * have to tell a counterparty why their invoice was refused.
 */
export interface PaymentDemandReport {
  chain: string;
  verdict: DemandVerdict;
  /** Ordered fatal first, then warnings, then notes. */
  findings: DemandFinding[];
  /** Where the money would actually go, as opposed to where it was said to. */
  destination?: DemandDestination;
  /** What the mint actually is, where one was named and could be read. */
  token?: { mint: string; decimals: number; symbol?: string };
  /** What holding this token afterwards exposes you to. */
  risk?: MintRisk;
  /** One sentence for whoever has to act on this. Never empty. */
  note: string;
}
